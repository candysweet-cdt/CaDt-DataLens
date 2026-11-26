package dbclient

// redis_session.go：Redis 会话建立与键空间高层操作（方案 §5.4）。
//
// 口径：
//   - 只用 SCAN（可调 COUNT、cursor==0 判结束），代码路径绝无 KEYS；精确查找由前端走 EXISTS/控制台。
//   - RedisFetchValue 把各类型值统一转成行集（columns/rows），前端网格零分支渲染；
//     string 单独走 Text/HexText（formatter Text/JSON/HEX 由前端切换）。
//   - 编辑提交走结构化 RedisOp（RESP 直发，不经文本 guard）——前端展示等价命令预览；
//     控制台的文本命令才走 guard 词表（guard_redis.go）。
//   - 会话绑定连接时选择的库（SELECT 已完成）；ScanKeys/Fetch 的 database 参数只做校验，
//     不再切库（单连接串行，切库会污染后续命令的库上下文）。

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"datalens/internal/sqlview"
)

// RedisScanKeys 的扫描批次上限（SCAN COUNT 与 pipeline TYPE/TTL 的批量规模）。
const (
	redisScanBatch      = 1000
	redisDefaultScanN   = 250
	redisFetchMaxCells  = 5000       // 单值行集的元素上限（hash/list/set/zset/stream）
	redisStringMaxBytes = 256 * 1024 // string 值预览上限（超出截断，完整值走控制台 GETRANGE）
	redisPrefixMaxKeys  = 10000      // 前缀批量删除的单次上限（防失控）
)

// RedisKeyEntry 键空间扫描的单个键摘要。
type RedisKeyEntry struct {
	Name   string `json:"name"`
	Type   string `json:"type"`             // string|hash|list|set|zset|stream|none|…
	TTL    int64  `json:"ttl"`              // 秒；-1 永久 / -2 已不存在
	Length int64  `json:"length,omitempty"` // 字节数（string）或元素数（集合类）
}

// RedisScanResult 一批扫描结果；Cursor!=0 表示还有未扫完的（前端「加载更多」续扫）。
type RedisScanResult struct {
	Cursor uint64          `json:"cursor"`
	Keys   []RedisKeyEntry `json:"keys"`
}

// RedisValue 键值读取结果：集合类转行集，string 走 Text/HexText。
type RedisValue struct {
	Type      string     `json:"type"`
	TTL       int64      `json:"ttl"`
	Length    int64      `json:"length"`   // string=字节数；集合类=元素/条目数
	IsBinary  bool       `json:"isBinary"` // string：非 UTF-8 或含控制字符
	Text      string     `json:"text"`     // string：UTF-8 文本（截断后）
	HexText   string     `json:"hexText"`  // string：十六进制 dump（空格分隔字节）
	Columns   []string   `json:"columns"`  // 集合类行集
	Rows      [][]string `json:"rows"`
	Nulls     [][]bool   `json:"nulls"`
	Truncated bool       `json:"truncated"`
	Message   string     `json:"message,omitempty"`
}

// RedisOp 结构化编辑操作（前端编辑面板生成、命令预览展示等价文本）。
type RedisOp struct {
	Kind       string  `json:"kind"` // setString|setHashField|delHashField|setListItem|addSetMember|delSetMember|addZSetMember|delZSetMember|setTTL|persist|delKey
	Key        string  `json:"key"`
	Field      string  `json:"field,omitempty"`
	Value      string  `json:"value,omitempty"`
	Index      int64   `json:"index,omitempty"`      // setListItem 的位置
	Score      float64 `json:"score,omitempty"`      // addZSetMember
	TTLSeconds int64   `json:"ttlSeconds,omitempty"` // setString 保存时携带原 TTL（-1 永久；SET 会清 TTL，保存后按原值 EXPIRE/PERSIST）
}

// RedisPrefixDelete 前缀批量删除结果。
type RedisPrefixDelete struct {
	Deleted int `json:"deleted"`
}

type redisConnection struct {
	client   *redisClient
	addr     string
	database int
}

// openRedisConnection 复用 SQL 连接的目标校验与候选地址解析，避免 Redis 绕过
// 云元数据/链路本地地址防线；正常连接与「测试连接」共用同一条建连路径。
func openRedisConnection(cfg ConnectionConfig, password string) (*redisConnection, error) {
	port := cfg.Port
	if port <= 0 {
		port = 6379
	}
	addrs, err := resolveSafeAddrs(cfg.Host, port)
	if err != nil {
		return nil, err
	}
	if len(addrs) > 3 {
		addrs = addrs[:3]
	}
	dbNum := 0
	if d := strings.TrimSpace(cfg.Database); d != "" {
		n, err := strconv.Atoi(d)
		if err != nil || n < 0 || n > 15 {
			return nil, fmt.Errorf("Redis 数据库编号无效：%q（0–15 的数字）", cfg.Database)
		}
		dbNum = n
	}
	var lastErr error
	for _, addr := range addrs {
		c, err := dialRedis(addr, strings.TrimSpace(cfg.User), password, dbNum)
		if err == nil {
			return &redisConnection{client: c, addr: addr, database: dbNum}, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("无可用地址")
	}
	return nil, fmt.Errorf("Redis 连接失败（已尝试 %d 个地址；检查主机/端口/用户名密码，以及网络可达性）：%w", len(addrs), lastErr)
}

// openRedisSession 建连并产出 Redis 会话（绕开 Driver 接口——driver.go 的既定声明；
// 生命周期登记复用 openSession 的通用流程：上限/空闲回收/取消）。
func openRedisSession(spec openSpec) (SessionInfo, error) {
	conn, err := openRedisConnection(spec.Config, spec.Password)
	if err != nil {
		return SessionInfo{}, err
	}
	name := strings.TrimSpace(spec.Config.Name)
	if name == "" {
		name = conn.addr
	}
	return registerSession(&dbSession{
		kind:     kindRedis,
		name:     name,
		server:   conn.addr,
		database: "db" + strconv.Itoa(conn.database),
		editable: spec.AllowEdit,
		caps:     Capabilities{Editable: true},
		redis:    conn.client,
	})
}

// closeSessionConn 按 kind 关闭底层连接（SQL 会话 *sql.DB / Redis 会话 redisClient）。
func closeSessionConn(s *dbSession) {
	if s.redis != nil {
		_ = s.redis.Close()
		return
	}
	if s.db != nil {
		_ = s.db.Close()
	}
}

// redisSessionOf 取 Redis 会话（非 Redis kind 报错）。
func redisSessionOf(id string) (*dbSession, *redisClient, error) {
	s, err := getSession(id)
	if err != nil {
		return nil, nil, err
	}
	if s.redis == nil {
		return nil, nil, fmt.Errorf("会话不是 Redis 类型：%s", s.kind)
	}
	return s, s.redis, nil
}

// redisDBCheck Redis 会话绑定连接时已 SELECT 的库；database 参数只校验不切库。
func redisDBCheck(s *dbSession, database string) error {
	d := strings.TrimSpace(database)
	if d != "" && d != s.database {
		return fmt.Errorf("Redis 会话绑定的是 %s（连接时选定）；如需其他库请修改连接配置后重连", s.database)
	}
	return nil
}

// RedisScanKeys SCAN 一批键并批量带出 TYPE/TTL/长度（pipeline，不走逐键 RTT）。
func RedisScanKeys(id, database, pattern string, cursor uint64, count int, typeFilter string) (RedisScanResult, error) {
	s, c, err := redisSessionOf(id)
	if err != nil {
		return RedisScanResult{}, err
	}
	if err := redisDBCheck(s, database); err != nil {
		return RedisScanResult{}, err
	}
	if count <= 0 {
		count = redisDefaultScanN
	}
	if count > redisScanBatch {
		count = redisScanBatch
	}
	scanArgs := [][]byte{[]byte("SCAN"), []byte(strconv.FormatUint(cursor, 10))}
	if p := strings.TrimSpace(pattern); p != "" {
		scanArgs = append(scanArgs, []byte("MATCH"), []byte(p))
	}
	scanArgs = append(scanArgs, []byte("COUNT"), []byte(strconv.Itoa(count)))
	if t := strings.TrimSpace(typeFilter); t != "" {
		scanArgs = append(scanArgs, []byte("TYPE"), []byte(t))
	}
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	s.touch()
	replies, err := c.pipeline(ctx, [][][]byte{scanArgs})
	if err != nil {
		return RedisScanResult{}, err
	}
	cursorNext, names, err := parseScanReply(replies[0])
	if err != nil {
		return RedisScanResult{}, err
	}
	out := RedisScanResult{Cursor: cursorNext, Keys: make([]RedisKeyEntry, 0, len(names))}
	if len(names) == 0 {
		return out, nil
	}
	// 第一轮：TYPE 与 TTL 交错 pipeline（cmd[i] 对应回复[i]）
	cmds := make([][][]byte, 0, 2*len(names))
	for _, name := range names {
		cmds = append(cmds, [][]byte{[]byte("TYPE"), name}, [][]byte{[]byte("TTL"), name})
	}
	replies, err = c.pipeline(ctx, cmds)
	if err != nil {
		return RedisScanResult{}, err
	}
	types := make([]string, len(names))
	ttls := make([]int64, len(names))
	for i := range names {
		if v, ok := replies[2*i].([]byte); ok {
			types[i] = strings.ToLower(string(v))
		}
		if v, ok := replies[2*i+1].(int64); ok {
			ttls[i] = v
		}
	}
	// 第二轮：按类型分派长度命令（unknown/none 不查）
	cmds = cmds[:0]
	kindIdx := make([]int, 0, len(names)) // 记录每条命令对应哪个 key
	for i, name := range names {
		var verb string
		switch types[i] {
		case "string":
			verb = "STRLEN"
		case "hash":
			verb = "HLEN"
		case "list":
			verb = "LLEN"
		case "set":
			verb = "SCARD"
		case "zset":
			verb = "ZCARD"
		case "stream":
			verb = "XLEN"
		default:
			continue
		}
		cmds = append(cmds, [][]byte{[]byte(verb), name})
		kindIdx = append(kindIdx, i)
	}
	lengths := make([]int64, len(names))
	if len(cmds) > 0 {
		replies, err = c.pipeline(ctx, cmds)
		if err != nil {
			return RedisScanResult{}, err
		}
		for j, reply := range replies {
			if v, ok := reply.(int64); ok {
				lengths[kindIdx[j]] = v
			}
		}
	}
	for i, name := range names {
		out.Keys = append(out.Keys, RedisKeyEntry{
			Name:   string(name),
			Type:   types[i],
			TTL:    ttls[i],
			Length: lengths[i],
		})
	}
	return out, nil
}

// parseScanReply SCAN 回复 [cursor bulk, keys array] → (cursor, 键名列表)。
func parseScanReply(reply any) (uint64, [][]byte, error) {
	arr, ok := reply.([]any)
	if !ok || len(arr) != 2 {
		return 0, nil, fmt.Errorf("SCAN 回复形状异常")
	}
	var cursor uint64
	switch v := arr[0].(type) {
	case []byte:
		n, err := strconv.ParseUint(string(v), 10, 64)
		if err != nil {
			return 0, nil, fmt.Errorf("SCAN cursor 无法解析：%s", v)
		}
		cursor = n
	case int64:
		cursor = uint64(v)
	default:
		return 0, nil, fmt.Errorf("SCAN cursor 类型异常")
	}
	items, ok := arr[1].([]any)
	if !ok {
		return cursor, nil, nil
	}
	names := make([][]byte, 0, len(items))
	for _, it := range items {
		if b, ok := it.([]byte); ok {
			names = append(names, b)
		}
	}
	return cursor, names, nil
}

// RedisFetchValue 读取一个键的值：TYPE → TTL → 按类型取值统一转行集。
func RedisFetchValue(id, database, key string) (RedisValue, error) {
	s, c, err := redisSessionOf(id)
	if err != nil {
		return RedisValue{}, err
	}
	if err := redisDBCheck(s, database); err != nil {
		return RedisValue{}, err
	}
	if key == "" {
		return RedisValue{}, errors.New("键名不能为空")
	}
	s.touch()
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	replies, err := c.pipeline(ctx, [][][]byte{
		{[]byte("TYPE"), []byte(key)},
		{[]byte("TTL"), []byte(key)},
	})
	if err != nil {
		return RedisValue{}, err
	}
	typ := "none"
	if v, ok := replies[0].([]byte); ok {
		typ = strings.ToLower(string(v))
	}
	var ttl int64
	if v, ok := replies[1].(int64); ok {
		ttl = v
	}
	out := RedisValue{Type: typ, TTL: ttl}
	switch typ {
	case "string":
		return redisFetchString(c, ctx, key, out)
	case "hash":
		return redisFetchHash(c, ctx, key, out)
	case "list":
		return redisFetchList(c, ctx, key, out)
	case "set":
		return redisFetchSet(c, ctx, key, out)
	case "zset":
		return redisFetchZSet(c, ctx, key, out)
	case "stream":
		return redisFetchStream(c, ctx, key, out)
	case "none":
		out.Message = "键不存在（可能已被删除）"
		return out, nil
	default:
		out.Message = fmt.Sprintf("「%s」类型请用查询控制台查看", typ)
		return out, nil
	}
}

func redisFetchString(c *redisClient, ctx context.Context, key string, out RedisValue) (RedisValue, error) {
	reply, err := c.cmd(ctx, []byte("GET"), []byte(key))
	if err != nil {
		return RedisValue{}, err
	}
	raw, _ := reply.([]byte)
	out.Length = int64(len(raw))
	if len(raw) > redisStringMaxBytes {
		raw = raw[:redisStringMaxBytes]
		out.Truncated = true
		out.Message = fmt.Sprintf("值超过 %d KB，已截断预览；完整值用控制台 GETRANGE 取", redisStringMaxBytes/1024)
	}
	out.IsBinary = !isPrintableUTF8(raw)
	out.HexText = hexDump(raw) // 无条件生成：HEX formatter 对可打印文本同样有查看价值
	if !out.IsBinary {
		out.Text = string(raw)
	}
	return out, nil
}

func redisFetchHash(c *redisClient, ctx context.Context, key string, out RedisValue) (RedisValue, error) {
	// HSCAN 游标扫描（HGETALL 对大 hash 是 O(N) 全量阻塞）
	reply, err := c.cmd(ctx, []byte("HSCAN"), []byte(key), []byte("0"), []byte("COUNT"), []byte(strconv.Itoa(redisFetchMaxCells)))
	if err != nil {
		return RedisValue{}, err
	}
	cursor, pairs, err := parseScanReply(reply)
	if err != nil {
		return RedisValue{}, fmt.Errorf("HSCAN 回复形状异常：%w", err)
	}
	out.Columns = []string{"field", "value"}
	out.CursorlessFill(pairs)
	if cursor != 0 {
		out.Truncated = true
		out.Message = "hash 元素较多，只显示了前一部分"
	}
	// HSCAN 的 cursor 对非零值意义有限（前端整页刷新）——Length 用 HLEN 补准
	if n, err := c.cmd(ctx, []byte("HLEN"), []byte(key)); err == nil {
		if v, ok := n.(int64); ok {
			out.Length = v
		}
	}
	return out, nil
}

func redisFetchList(c *redisClient, ctx context.Context, key string, out RedisValue) (RedisValue, error) {
	replies, err := c.pipeline(ctx, [][][]byte{
		{[]byte("LLEN"), []byte(key)},
		{[]byte("LRANGE"), []byte(key), []byte("0"), []byte(strconv.Itoa(redisFetchMaxCells - 1))},
	})
	if err != nil {
		return RedisValue{}, err
	}
	if v, ok := replies[0].(int64); ok {
		out.Length = v
	}
	items, _ := replies[1].([]any)
	out.Columns = []string{"index", "value"}
	fillIndexedRows(&out, items)
	if out.Length > redisFetchMaxCells {
		out.Truncated = true
		out.Message = fmt.Sprintf("list 共 %d 个元素，只显示了前 %d 个", out.Length, len(out.Rows))
	}
	return out, nil
}

func redisFetchSet(c *redisClient, ctx context.Context, key string, out RedisValue) (RedisValue, error) {
	reply, err := c.cmd(ctx, []byte("SSCAN"), []byte(key), []byte("0"), []byte("COUNT"), []byte(strconv.Itoa(redisFetchMaxCells)))
	if err != nil {
		return RedisValue{}, err
	}
	cursor, pairs, err := parseScanReply(reply)
	if err != nil {
		return RedisValue{}, fmt.Errorf("SSCAN 回复形状异常：%w", err)
	}
	out.Columns = []string{"member"}
	out.CursorlessFill(pairs)
	if cursor != 0 {
		out.Truncated = true
		out.Message = "set 元素较多，只显示了前一部分"
	}
	if n, err := c.cmd(ctx, []byte("SCARD"), []byte(key)); err == nil {
		if v, ok := n.(int64); ok {
			out.Length = v
		}
	}
	return out, nil
}

func redisFetchZSet(c *redisClient, ctx context.Context, key string, out RedisValue) (RedisValue, error) {
	replies, err := c.pipeline(ctx, [][][]byte{
		{[]byte("ZCARD"), []byte(key)},
		{[]byte("ZRANGE"), []byte(key), []byte("0"), []byte(strconv.Itoa(redisFetchMaxCells - 1)), []byte("WITHSCORES")},
	})
	if err != nil {
		return RedisValue{}, err
	}
	if v, ok := replies[0].(int64); ok {
		out.Length = v
	}
	items, _ := replies[1].([]any)
	out.Columns = []string{"member", "score"}
	// WITHSCORES 交错 [member, score, member, score…]
	for i := 0; i+1 < len(items); i += 2 {
		out.Rows = append(out.Rows, []string{redisCellString(items[i]), redisCellString(items[i+1])})
		out.Nulls = append(out.Nulls, []bool{false, false})
	}
	if out.Length > redisFetchMaxCells {
		out.Truncated = true
		out.Message = fmt.Sprintf("zset 共 %d 个成员，只显示了前 %d 个", out.Length, len(out.Rows))
	}
	return out, nil
}

func redisFetchStream(c *redisClient, ctx context.Context, key string, out RedisValue) (RedisValue, error) {
	replies, err := c.pipeline(ctx, [][][]byte{
		{[]byte("XLEN"), []byte(key)},
		{[]byte("XRANGE"), []byte(key), []byte("-"), []byte("+"), []byte("COUNT"), []byte(strconv.Itoa(redisFetchMaxCells))},
	})
	if err != nil {
		return RedisValue{}, err
	}
	if v, ok := replies[0].(int64); ok {
		out.Length = v
	}
	out.Columns = []string{"id", "field", "value"}
	entries, _ := replies[1].([]any)
	for _, e := range entries {
		pair, ok := e.([]any)
		if !ok || len(pair) != 2 {
			continue
		}
		id := redisCellString(pair[0])
		fields, _ := pair[1].([]any)
		for i := 0; i+1 < len(fields); i += 2 {
			out.Rows = append(out.Rows, []string{id, redisCellString(fields[i]), redisCellString(fields[i+1])})
			out.Nulls = append(out.Nulls, []bool{false, false, false})
		}
	}
	if out.Length > redisFetchMaxCells {
		out.Truncated = true
		out.Message = fmt.Sprintf("stream 共 %d 条目，只显示了前一部分", out.Length)
	}
	return out, nil
}

// CursorlessFill 把 SCAN 类回复的扁平 [k1,v1,k2,v2…] 填进行集（两列 = field/value；一列 = member）。
func (v *RedisValue) CursorlessFill(items [][]byte) {
	if len(v.Columns) == 2 {
		for i := 0; i+1 < len(items); i += 2 {
			v.Rows = append(v.Rows, []string{redisCellString(items[i]), redisCellString(items[i+1])})
			v.Nulls = append(v.Nulls, []bool{false, false})
		}
		return
	}
	for _, it := range items {
		v.Rows = append(v.Rows, []string{redisCellString(it)})
		v.Nulls = append(v.Nulls, []bool{false})
	}
}

func fillIndexedRows(v *RedisValue, items []any) {
	for i, it := range items {
		v.Rows = append(v.Rows, []string{strconv.Itoa(i), redisCellString(it)})
		v.Nulls = append(v.Nulls, []bool{false, false})
	}
}

// redisCellString 回复值 → 网格单元格字符串（非 UTF-8 显示占位，完整二进制只对 string 提供查看）。
func redisCellString(v any) string {
	switch t := v.(type) {
	case nil:
		return "(nil)"
	case []byte:
		if isPrintableUTF8(t) {
			return string(t)
		}
		return fmt.Sprintf("<binary %d 字节>", len(t))
	case int64:
		return strconv.FormatInt(t, 10)
	case string:
		return t
	case *respError:
		return "(" + t.msg + ")"
	default:
		return fmt.Sprintf("%v", t)
	}
}

// isPrintableUTF8 UTF-8 有效且不含（除 \t \n \r 外的）控制字符——网格/文本区可安全显示。
func isPrintableUTF8(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, c := range b {
		if c < 0x20 && c != '\t' && c != '\n' && c != '\r' {
			return false
		}
	}
	return true
}

// hexDump 十六进制 dump（空格分隔的大写两位字节）。
func hexDump(b []byte) string {
	const hexDigits = "0123456789ABCDEF"
	out := make([]byte, 0, len(b)*3)
	for i, c := range b {
		if i > 0 {
			out = append(out, ' ')
		}
		out = append(out, hexDigits[c>>4], hexDigits[c&0x0F])
	}
	return string(out)
}

// RedisApply 结构化编辑提交：逐条 RESP 直发（不经文本 guard），单条失败不中断其余。
func RedisApply(id string, ops []RedisOp) (sqlview.SQLResult, error) {
	s, c, err := redisSessionOf(id)
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	if !s.editable {
		return sqlview.SQLResult{}, ErrReadOnlySession
	}
	if len(ops) > maxChangesPerApply {
		return sqlview.SQLResult{}, fmt.Errorf("单次提交最多 %d 条操作（当前 %d 条）", maxChangesPerApply, len(ops))
	}
	ctx, cancel := context.WithTimeout(context.Background(), applyTimeout)
	defer cancel()
	s.touch()

	// 逐 op 拆命令发 pipeline（单条失败以 respError 记在该 op 的结果里，不中断其余）
	cmds := make([][][]byte, 0, len(ops))
	labelIdx := make([]int, 0, len(ops)) // 每条命令对应的 op 下标
	for i, op := range ops {
		cs, err := redisOpCommands(op)
		if err != nil {
			return sqlview.SQLResult{}, err
		}
		cmds = append(cmds, cs...)
		for range cs {
			labelIdx = append(labelIdx, i)
		}
	}
	replies, err := c.pipeline(ctx, cmds)
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	failed := make([]string, len(ops)) // op 下标 → 失败原因（"" = 成功）
	for j, reply := range replies {
		if re, ok := reply.(*respError); ok && failed[labelIdx[j]] == "" {
			failed[labelIdx[j]] = re.msg
		}
	}
	out := sqlview.SQLResult{Columns: []string{"操作", "结果"}}
	okCount := 0
	for i, op := range ops {
		result := "OK"
		if failed[i] != "" {
			result = "失败：" + failed[i]
		} else {
			okCount++
		}
		out.Rows = append(out.Rows, []string{redisOpLabel(op), result})
		out.Nulls = append(out.Nulls, []bool{false, false})
	}
	out.Message = fmt.Sprintf("已执行 %d 条操作（成功 %d）", len(ops), okCount)
	return out, nil
}

// redisOpArgs 结构化操作 → RESP 命令参数。
func redisOpArgs(op RedisOp) ([][]byte, error) {
	key := []byte(op.Key)
	if len(key) == 0 {
		return nil, errors.New("操作缺少键名")
	}
	switch op.Kind {
	case "setString":
		// 只发 SET 本身；EXPIRE/PERSIST 由 redisOpCommands 拆成第二条命令
		// （不用 SET KEEPTTL：Redis <6.0 不支持；SET 会清 TTL，保存后按原 TTL 补）
		return [][]byte{[]byte("SET"), key, []byte(op.Value)}, nil
	case "setHashField":
		return [][]byte{[]byte("HSET"), key, []byte(op.Field), []byte(op.Value)}, nil
	case "delHashField":
		return [][]byte{[]byte("HDEL"), key, []byte(op.Field)}, nil
	case "setListItem":
		return [][]byte{[]byte("LSET"), key, []byte(strconv.FormatInt(op.Index, 10)), []byte(op.Value)}, nil
	case "addSetMember":
		return [][]byte{[]byte("SADD"), key, []byte(op.Value)}, nil
	case "delSetMember":
		return [][]byte{[]byte("SREM"), key, []byte(op.Value)}, nil
	case "addZSetMember":
		return [][]byte{[]byte("ZADD"), key, []byte(strconv.FormatFloat(op.Score, 'f', -1, 64)), []byte(op.Value)}, nil
	case "delZSetMember":
		return [][]byte{[]byte("ZREM"), key, []byte(op.Value)}, nil
	case "setTTL":
		if op.TTLSeconds < 0 {
			return [][]byte{[]byte("PERSIST"), key}, nil
		}
		return [][]byte{[]byte("EXPIRE"), key, []byte(strconv.FormatInt(op.TTLSeconds, 10))}, nil
	case "persist":
		return [][]byte{[]byte("PERSIST"), key}, nil
	case "delKey":
		return [][]byte{[]byte("DEL"), key}, nil
	default:
		return nil, fmt.Errorf("未知的 Redis 操作类型：%q", op.Kind)
	}
}

// redisOpCommands 一个 op → 一或多条命令：setString 携带原 TTL 时补第二条 EXPIRE
// （SET 会清 TTL；原 TTL==-1 永久则无需补——SET 本身就是无过期）。
func redisOpCommands(op RedisOp) ([][][]byte, error) {
	args, err := redisOpArgs(op)
	if err != nil {
		return nil, err
	}
	cmds := [][][]byte{args}
	if op.Kind == "setString" && op.TTLSeconds > 0 {
		cmds = append(cmds, [][]byte{[]byte("EXPIRE"), []byte(op.Key), []byte(strconv.FormatInt(op.TTLSeconds, 10))})
	}
	return cmds, nil
}

func redisOpLabel(op RedisOp) string {
	switch op.Kind {
	case "setString":
		return "SET " + op.Key
	case "setHashField":
		return "HSET " + op.Key + " " + op.Field
	case "delHashField":
		return "HDEL " + op.Key + " " + op.Field
	case "setListItem":
		return fmt.Sprintf("LSET %s [%d]", op.Key, op.Index)
	case "addSetMember":
		return "SADD " + op.Key
	case "delSetMember":
		return "SREM " + op.Key
	case "addZSetMember":
		return "ZADD " + op.Key + " " + op.Value
	case "delZSetMember":
		return "ZREM " + op.Key + " " + op.Value
	case "setTTL":
		if op.TTLSeconds < 0 {
			return "PERSIST " + op.Key
		}
		return fmt.Sprintf("EXPIRE %s %d", op.Key, op.TTLSeconds)
	case "persist":
		return "PERSIST " + op.Key
	case "delKey":
		return "DEL " + op.Key
	default:
		return op.Kind
	}
}

// RedisDeleteByPrefix SCAN + UNLINK 循环删除一个前缀下的全部键（前端确认后调用；空前缀拒绝）。
func RedisDeleteByPrefix(id, database, prefix string) (RedisPrefixDelete, error) {
	s, c, err := redisSessionOf(id)
	if err != nil {
		return RedisPrefixDelete{}, err
	}
	if err := redisDBCheck(s, database); err != nil {
		return RedisPrefixDelete{}, err
	}
	if !s.editable {
		return RedisPrefixDelete{}, ErrReadOnlySession
	}
	p := strings.TrimSpace(prefix)
	if p == "" {
		return RedisPrefixDelete{}, errors.New("前缀不能为空（整库清空请显式用控制台 FLUSHDB 并确认）")
	}
	s.touch()
	ctx, cancel := context.WithTimeout(context.Background(), applyTimeout)
	defer cancel()
	var cursor uint64
	deleted := 0
	batch := make([][]byte, 0, 500)
	for {
		replies, err := c.pipeline(ctx, [][][]byte{
			{[]byte("SCAN"), []byte(strconv.FormatUint(cursor, 10)), []byte("MATCH"), []byte(p + "*"), []byte("COUNT"), []byte("500")},
		})
		if err != nil {
			return RedisPrefixDelete{}, err
		}
		next, names, err := parseScanReply(replies[0])
		if err != nil {
			return RedisPrefixDelete{}, err
		}
		cursor = next
		batch = append(batch, names...)
		if len(batch) >= 500 {
			n, err := redisUnlinkBatch(c, ctx, batch[:500])
			if err != nil {
				return RedisPrefixDelete{}, err
			}
			deleted += n
			batch = batch[500:]
		}
		if len(batch) > redisPrefixMaxKeys || (len(batch)+deleted) > redisPrefixMaxKeys {
			return RedisPrefixDelete{}, fmt.Errorf("匹配的键超过 %d 个，请缩小前缀范围", redisPrefixMaxKeys)
		}
		if cursor == 0 {
			break
		}
	}
	if len(batch) > 0 {
		n, err := redisUnlinkBatch(c, ctx, batch)
		if err != nil {
			return RedisPrefixDelete{}, err
		}
		deleted += n
	}
	return RedisPrefixDelete{Deleted: deleted}, nil
}

func redisUnlinkBatch(c *redisClient, ctx context.Context, names [][]byte) (int, error) {
	args := append([][]byte{[]byte("UNLINK")}, names...)
	replies, err := c.pipeline(ctx, [][][]byte{args})
	if err != nil {
		return 0, err
	}
	if v, ok := replies[0].(int64); ok {
		return int(v), nil
	}
	return 0, nil
}

// redisServerVersion INFO server 解析 redis_version；INFO 被禁/解析失败时返回占位（仅显示用）。
func redisServerVersion(ctx context.Context, s *dbSession) (string, error) {
	if s.redis == nil {
		return "", errors.New("不是 Redis 会话")
	}
	reply, err := s.redis.cmd(ctx, []byte("INFO"), []byte("server"))
	if err != nil {
		return "unknown", nil
	}
	if _, ok := reply.(*respError); ok {
		return "unknown", nil
	}
	if raw, ok := reply.([]byte); ok {
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if v, found := strings.CutPrefix(line, "redis_version:"); found {
				return strings.TrimSpace(v), nil
			}
		}
	}
	return "unknown", nil
}

// touch 更新会话活跃时间（ScanKeys/Fetch/Apply 各入口手动调；Query 路径由 getSession 统一做）。
func (s *dbSession) touch() {
	s.mu.Lock()
	s.lastUsed = time.Now()
	s.mu.Unlock()
}

// ---------- 控制台执行（query.go 的 redis 分派目标） ----------

// executeRedisStatement 单条文本命令执行：tokenize → RESP 直发 → 回复转行集。
func executeRedisStatement(s *dbSession, queryID, stmt string, v stmtVerdict, limit int) (sqlview.SQLResult, bool, error) {
	_, c, err := redisSessionOf(s.id)
	if err != nil {
		return sqlview.SQLResult{}, false, err
	}
	args, err := tokenizeRedis(stmt)
	if err != nil {
		return sqlview.SQLResult{}, false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	s.registerQuery(queryID, cancel)
	defer s.unregisterQuery(queryID)

	reply, err := c.cmd(ctx, args...)
	if err != nil {
		return sqlview.SQLResult{}, v.class == classWrite, err
	}
	if re, ok := reply.(*respError); ok {
		return sqlview.SQLResult{}, v.class == classWrite, errors.New(re.msg)
	}
	out := replyToSQLResult(reply, limit)
	if v.class == classWrite {
		out.Message = "已执行"
	}
	return out, v.class == classWrite, nil
}

// replyToSQLResult RESP 回复 → 网格行集：标量单行单列；数组 ['#','值'] 逐项（嵌套数组 JSON 化）。
func replyToSQLResult(reply any, limit int) sqlview.SQLResult {
	switch t := reply.(type) {
	case nil:
		return sqlview.SQLResult{Columns: []string{"结果"}, Rows: [][]string{{"(nil)"}}, Nulls: [][]bool{{true}}}
	case []byte:
		return sqlview.SQLResult{Columns: []string{"结果"}, Rows: [][]string{{redisCellString(t)}}, Nulls: [][]bool{{false}}}
	case string:
		return sqlview.SQLResult{Columns: []string{"结果"}, Rows: [][]string{{t}}, Nulls: [][]bool{{false}}}
	case int64:
		return sqlview.SQLResult{Columns: []string{"结果"}, Rows: [][]string{{strconv.FormatInt(t, 10)}}, Nulls: [][]bool{{false}}}
	case []any:
		out := sqlview.SQLResult{Columns: []string{"#", "值"}}
		for i, item := range t {
			if len(out.Rows) >= limit {
				out.Truncated = true
				break
			}
			out.Rows = append(out.Rows, []string{strconv.Itoa(i), redisCellString(item)})
			out.Nulls = append(out.Nulls, []bool{false, false})
		}
		return out
	default:
		return sqlview.SQLResult{Columns: []string{"结果"}, Rows: [][]string{{fmt.Sprintf("%v", t)}}, Nulls: [][]bool{{false}}}
	}
}
