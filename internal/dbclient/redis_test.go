package dbclient

// redis_test.go：Redis 侧测试——RESP 编解码、命令词表分类、控制台拆行，以及
// 进程内假 server 的全链路（建连握手 → ScanKeys pipeline → FetchValue → 控制台 guard → Apply/删前缀）。
//
// 假 server 是每个用例独立起 listener（不写 TestMain，规避 AGENTS.md 记录的子进程递归陷阱）；
// handler 按「命令首词 → RESP 回复字节」分发，收到意外命令直接回 -ERR（断言链路发对了命令）。

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- RESP 解析（无 server，直接喂字节） ----------

func TestRESPReadReply(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want any
	}{
		{"simple string", "+OK\r\n", "OK"},
		{"integer", ":42\r\n", int64(42)},
		{"negative integer", ":-42\r\n", int64(-42)},
		{"nil bulk", "$-1\r\n", nil},
		{"nil array", "*-1\r\n", nil},
		{"bulk", "$5\r\nhello\r\n", []byte("hello")},
		{"bulk with CRLF inside", "$5\r\na\r\nbc\r\n", []byte("a\r\nbc")},
		{
			"nested array",
			"*2\r\n$1\r\n0\r\n*2\r\n$2\r\nk1\r\n$2\r\nk2\r\n",
			[]any{[]byte("0"), []any{[]byte("k1"), []byte("k2")}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &redisClient{br: bufio.NewReader(strings.NewReader(tc.in))}
			got, err := c.readReply()
			if err != nil {
				t.Fatalf("readReply: %v", err)
			}
			assertReplyEqual(t, got, tc.want)
		})
	}
}

func TestRESPReadReplyError(t *testing.T) {
	// -ERR 是回复值（respError），不中断 pipeline；Cluster 错误带指引文案
	c := &redisClient{br: bufio.NewReader(strings.NewReader("-WRONGPASS 密码错\r\n"))}
	reply, err := c.readReply()
	if err != nil {
		t.Fatalf("error reply 应作为值返回，得到 err=%v", err)
	}
	re, ok := reply.(*respError)
	if !ok || !strings.Contains(re.msg, "认证/权限被拒") {
		t.Fatalf("期望 respError 带指引，得到 %#v", reply)
	}

	c = &redisClient{br: bufio.NewReader(strings.NewReader("-MOVED 3999 127.0.0.1:6381\r\n"))}
	reply, _ = c.readReply()
	re = reply.(*respError)
	if !strings.Contains(re.msg, "不支持 Redis Cluster") {
		t.Fatalf("Cluster 错误应带指引，得到 %s", re.msg)
	}
}

func assertReplyEqual(t *testing.T, got, want any) {
	t.Helper()
	switch w := want.(type) {
	case []byte:
		b, ok := got.([]byte)
		if !ok || string(b) != string(w) {
			t.Fatalf("bulk 不符：got %#v want %q", got, w)
		}
	case []any:
		arr, ok := got.([]any)
		if !ok || len(arr) != len(w) {
			t.Fatalf("数组不符：got %#v want %#v", got, w)
		}
		for i := range w {
			assertReplyEqual(t, arr[i], w[i])
		}
	default:
		if got != want {
			t.Fatalf("标量不符：got %#v want %#v", got, want)
		}
	}
}

// ---------- 命令行 tokenize 与拆行 ----------

func TestTokenizeRedis(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"GET foo", []string{"GET", "foo"}},
		{"  SET   key1  v1  ", []string{"SET", "key1", "v1"}},
		{`SET k "hello world"`, []string{"SET", "k", "hello world"}},
		{`SET k "a\"b\\c"`, []string{"SET", "k", "a\"b\\c"}},
		{`SET k 'raw "text"'`, []string{"SET", "k", `raw "text"`}},
		{"SET k \"line\\nbreak\"", []string{"SET", "k", "line\nbreak"}},
	}
	for _, tc := range cases {
		toks, err := tokenizeRedis(tc.in)
		if err != nil {
			t.Fatalf("tokenize(%q): %v", tc.in, err)
		}
		if len(toks) != len(tc.want) {
			t.Fatalf("tokenize(%q) 数量不符：got %#v want %#v", tc.in, toks, tc.want)
		}
		for i := range toks {
			if string(toks[i]) != tc.want[i] {
				t.Fatalf("tokenize(%q)[%d]：got %q want %q", tc.in, i, toks[i], tc.want[i])
			}
		}
	}
	if _, err := tokenizeRedis(`SET k "unclosed`); err == nil {
		t.Fatal("未闭合引号应报错")
	}
}

func TestSplitRedisStatements(t *testing.T) {
	got := splitRedisStatements("# 注释\nGET foo\n\nSET k v\n  \r\nPING")
	want := []string{"GET foo", "SET k v", "PING"}
	if len(got) != len(want) {
		t.Fatalf("拆行数量不符：got %#v", got)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("拆行[%d]：got %q want %q", i, got[i], want[i])
		}
	}
	if len(splitRedisStatements("# 只有注释")) != 0 {
		t.Fatal("纯注释应拆出空")
	}
}

// ---------- 词表分类与 checkBatch 集成 ----------

func TestClassifyRedisStatement(t *testing.T) {
	cases := []struct {
		in      string
		class   stmtClass
		danger  bool
		unknown bool
	}{
		{"GET foo", classRead, false, false},
		{"scan 0 count 100", classRead, false, false},
		{"HGETALL user:1", classRead, false, false},
		{"config get maxmemory", classRead, false, false},
		{"xrange s - +", classRead, false, false},
		{"SET k v", classWrite, false, false},
		{"incr counter", classWrite, false, false},
		{"expire k 60", classWrite, false, false},
		{"config set maxmemory 100mb", classWrite, true, false},
		{"FLUSHALL", classWrite, true, false},
		{"shutdown nosave", classWrite, true, false},
		{"script load return 1", classWrite, true, false},
		{"MULTI", classCtrl, false, false},
		{"EXEC", classCtrl, false, false},
		{"xread block 0 streams x", classWrite, false, true}, // 不进读白名单（BLOCK 会阻塞）
		{" mysteriou Command", classWrite, false, true},      // unknown fail closed
	}
	for _, tc := range cases {
		v := classifyRedisStatement(tc.in)
		if v.class != tc.class || v.danger != tc.danger || v.unknown != tc.unknown {
			t.Fatalf("classify(%q)：got {class=%d danger=%v unknown=%v} want {class=%d danger=%v unknown=%v}",
				tc.in, v.class, v.danger, v.unknown, tc.class, tc.danger, tc.unknown)
		}
	}
}

func TestRedisCheckBatch(t *testing.T) {
	// 只读会话：SET 整批拒（ErrReadOnlySession）；GET 放行
	_, err := checkBatch([]string{"SET k v"}, kindRedis, false, false, false)
	if !errors.Is(err, ErrReadOnlySession) {
		t.Fatalf("只读会话 SET 应拒：got %v", err)
	}
	if confirm, err := checkBatch([]string{"GET k"}, kindRedis, false, false, false); err != nil || confirm != "" {
		t.Fatalf("只读会话 GET 应放行：confirm=%q err=%v", confirm, err)
	}
	// 危险命令两阶段：FLUSHALL 先回 confirm，confirmed=true 放行
	confirm, err := checkBatch([]string{"FLUSHALL"}, kindRedis, true, false, false)
	if err != nil || confirm != confirmDanger {
		t.Fatalf("FLUSHALL 应要确认：confirm=%q err=%v", confirm, err)
	}
	if confirm, err := checkBatch([]string{"FLUSHALL"}, kindRedis, true, true, false); confirm != "" || err != nil {
		t.Fatalf("确认后 FLUSHALL 应放行：confirm=%q err=%v", confirm, err)
	}
	// MULTI 控制台拒（与 SQL 的 BEGIN/COMMIT 同口径）
	if _, err := checkBatch([]string{"MULTI"}, kindRedis, true, false, false); err == nil {
		t.Fatal("MULTI 应被控制台拒绝")
	}
	// unknown fail closed
	if _, err := checkBatch([]string{"whatever cmd"}, kindRedis, true, false, false); err == nil {
		t.Fatal("unknown 命令应拒")
	}
}

func TestRedisValidateConfig(t *testing.T) {
	base := ConnectionConfig{Kind: kindRedis, Name: "t", Host: "127.0.0.1", Port: 6379}
	if err := validateConfig(base); err != nil {
		t.Fatalf("基础配置应通过：%v", err)
	}
	if err := validateConfig(ConnectionConfig{Kind: kindRedis, Name: "t", Host: "127.0.0.1", Port: 6379, Database: "3"}); err != nil {
		t.Fatalf("db 编号 3 应通过：%v", err)
	}
	for _, bad := range []string{"16", "abc", "-1"} {
		if err := validateConfig(ConnectionConfig{Kind: kindRedis, Name: "t", Host: "127.0.0.1", Port: 6379, Database: bad}); err == nil {
			t.Fatalf("db 编号 %q 应拒绝", bad)
		}
	}
	if err := validateConfig(ConnectionConfig{Kind: "mongodb", Name: "t", Host: "127.0.0.1", Port: 27017}); err == nil {
		t.Fatal("未知 kind 应拒绝")
	}
}

// ---------- 假 server 全链路 ----------

// fakeRedisServer 进程内 RESP 服务器：单连接循环读命令 → handler 回复；记录收到的命令。
type fakeRedisServer struct {
	addr string
	ln   net.Listener
	mu   sync.Mutex
	got  []string
}

func startFakeRedis(t *testing.T, handler func(cmd []string) []byte) *fakeRedisServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeRedisServer{addr: ln.Addr().String(), ln: ln}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serveConn(conn, handler)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeRedisServer) commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.got...)
}

// serveConn 单连接循环：读命令 → 记录 → handler 回复。
func (s *fakeRedisServer) serveConn(conn net.Conn, handler func(cmd []string) []byte) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	for {
		cmd, err := readFakeCommand(br)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.got = append(s.got, strings.Join(cmd, " "))
		s.mu.Unlock()
		if _, err := conn.Write(handler(cmd)); err != nil {
			return
		}
	}
}

func readFakeCommand(br *bufio.Reader) ([]string, error) {
	head, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	head = strings.TrimRight(head, "\r\n")
	if !strings.HasPrefix(head, "*") {
		return []string{head}, nil // inline 命令（测试客户端不会发，容错兜底）
	}
	n, _ := strconv.Atoi(head[1:])
	cmd := make([]string, 0, n)
	for i := 0; i < n; i++ {
		hdr, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		hdr = strings.TrimRight(hdr, "\r\n")
		ln, _ := strconv.Atoi(hdr[1:])
		buf := make([]byte, ln+2)
		if _, err := ioReadFull(br, buf); err != nil {
			return nil, err
		}
		cmd = append(cmd, string(buf[:ln]))
	}
	return cmd, nil
}

// openFakeRedis 建连一个假 server（可带密码/db 编号），返回会话信息。
func openFakeRedis(t *testing.T, srv *fakeRedisServer, password, database string, allowEdit bool) SessionInfo {
	t.Helper()
	host, portStr, err := net.SplitHostPort(srv.addr)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portStr)
	info, err := openSession(openSpec{
		Kind: kindRedis,
		Config: ConnectionConfig{
			Kind: kindRedis, Name: "fake", Host: host, Port: port, Database: database, User: "default",
		},
		Password:  password,
		AllowEdit: allowEdit,
	})
	if err != nil {
		t.Fatalf("openSession(redis): %v", err)
	}
	t.Cleanup(func() { _ = CloseSession(info.ID) })
	return info
}

// respBulk / respArray RESP 字面量构造（测试可读性）。
func respBulk(s string) []byte   { return []byte("$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n") }
func respSimple(s string) []byte { return []byte("+" + s + "\r\n") }
func respInt(n int64) []byte     { return []byte(":" + strconv.FormatInt(n, 10) + "\r\n") }

func respArray(items ...[]byte) []byte {
	out := []byte("*" + strconv.Itoa(len(items)) + "\r\n")
	for _, it := range items {
		out = append(out, it...)
	}
	return out
}

func TestRedisDialHandshake(t *testing.T) {
	var mu sync.Mutex
	sawAuth := false
	sawSelect := false
	srv := startFakeRedis(t, func(cmd []string) []byte {
		mu.Lock()
		defer mu.Unlock()
		switch strings.ToUpper(cmd[0]) {
		case "AUTH":
			if len(cmd) != 3 || cmd[1] != "default" || cmd[2] != "secret" {
				return []byte("-WRONGPASS\r\n")
			}
			sawAuth = true
			return respSimple("OK")
		case "SELECT":
			if len(cmd) != 2 || cmd[1] != "5" {
				return []byte("-ERR db\r\n")
			}
			sawSelect = true
			return respSimple("OK")
		case "PING":
			return respSimple("PONG")
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	info := openFakeRedis(t, srv, "secret", "5", false)
	if info.Kind != kindRedis || info.Database != "db5" || info.Server == "" {
		t.Fatalf("SessionInfo 不符：%#v", info)
	}
	mu.Lock()
	defer mu.Unlock()
	if !sawAuth || !sawSelect {
		t.Fatalf("握手缺步骤：auth=%v select=%v", sawAuth, sawSelect)
	}
	// INFO server（serverVersion）走 unknown 容错
	v, err := redisServerVersion(context.Background(), mustSession(t, info.ID))
	if err != nil || v != "unknown" {
		t.Fatalf("INFO 未实现时版本应容错为 unknown：v=%q err=%v", v, err)
	}
}

func TestRedisTestConnection(t *testing.T) {
	srv := startFakeRedis(t, func(cmd []string) []byte {
		switch strings.ToUpper(cmd[0]) {
		case "AUTH":
			return respSimple("OK")
		case "PING":
			return respSimple("PONG")
		case "INFO":
			return respBulk("# Server\r\nredis_version:7.2.4\r\n")
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	host, portStr, err := net.SplitHostPort(srv.addr)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portStr)
	cfg := ConnectionConfig{ID: "test-redis", Name: "test", Kind: kindRedis, Host: host, Port: port, User: "default"}
	version, err := TestConnection(cfg, "secret")
	if err != nil {
		t.Fatalf("Redis TestConnection：%v", err)
	}
	if version != "Redis 7.2.4" {
		t.Fatalf("版本文案 = %q，want Redis 7.2.4", version)
	}
	if !containsExact(srv.commands(), "INFO server") {
		t.Fatalf("测试连接未做第二级 INFO 校验：%q", srv.commands())
	}
}

func TestRedisRejectsLinkLocalTarget(t *testing.T) {
	_, err := openSession(openSpec{
		Kind: kindRedis,
		Config: ConnectionConfig{
			Name: "blocked", Kind: kindRedis, Host: "169.254.169.254", Port: 6379,
		},
		Password: "secret",
	})
	if err == nil || !strings.Contains(err.Error(), "链路本地") {
		t.Fatalf("Redis 应复用目标校验拒绝链路本地地址：%v", err)
	}
}

func TestRedisScanKeysPipeline(t *testing.T) {
	srv := startFakeRedis(t, func(cmd []string) []byte {
		switch strings.ToUpper(cmd[0]) {
		case "PING":
			return respSimple("PONG")
		case "SCAN":
			return respArray(respBulk("17"), respArray(respBulk("user:1001"), respBulk("user:1002")))
		case "TYPE":
			if cmd[1] == "user:1002" {
				return respBulk("hash")
			}
			return respBulk("string")
		case "TTL":
			return respInt(3600)
		case "STRLEN":
			return respInt(5)
		case "HLEN":
			return respInt(2)
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	info := openFakeRedis(t, srv, "", "0", false)
	res, err := RedisScanKeys(info.ID, "db0", "user:*", 0, 250, "")
	if err != nil {
		t.Fatalf("ScanKeys: %v", err)
	}
	if res.Cursor != 17 || len(res.Keys) != 2 {
		t.Fatalf("扫描结果不符：cursor=%d keys=%d", res.Cursor, len(res.Keys))
	}
	if res.Keys[0].Type != "string" || res.Keys[0].Length != 5 || res.Keys[0].TTL != 3600 {
		t.Fatalf("key[0] 摘要不符：%#v", res.Keys[0])
	}
	if res.Keys[1].Type != "hash" || res.Keys[1].Length != 2 {
		t.Fatalf("key[1] 摘要不符：%#v", res.Keys[1])
	}
	// SCAN 必须带 MATCH + COUNT（发送面确认；代码路径无 KEYS 由词表扫描另证）
	for _, c := range srv.commands() {
		if strings.HasPrefix(c, "SCAN") && (!strings.Contains(c, "MATCH") || !strings.Contains(c, "COUNT")) {
			t.Fatalf("SCAN 缺参数：%q", c)
		}
	}
	// 库参数不符应拒（会话绑定连接时选定的库）
	if _, err := RedisScanKeys(info.ID, "db2", "", 0, 0, ""); err == nil {
		t.Fatal("跨库访问应拒绝")
	}
}

func TestRedisFetchValueTypes(t *testing.T) {
	srv := startFakeRedis(t, func(cmd []string) []byte {
		switch strings.ToUpper(cmd[0]) {
		case "PING":
			return respSimple("PONG")
		case "TYPE":
			return respBulk("hash")
		case "TTL":
			return respInt(-1)
		case "HSCAN":
			return respArray(respBulk("0"), respArray(respBulk("name"), respBulk("ada"), respBulk("age"), respBulk("36")))
		case "HLEN":
			return respInt(2)
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	info := openFakeRedis(t, srv, "", "0", false)
	v, err := RedisFetchValue(info.ID, "db0", "user:1002")
	if err != nil {
		t.Fatalf("FetchValue: %v", err)
	}
	if v.Type != "hash" || v.TTL != -1 || v.Length != 2 {
		t.Fatalf("值头不符：%#v", v)
	}
	if len(v.Columns) != 2 || len(v.Rows) != 2 || v.Rows[0][0] != "name" || v.Rows[0][1] != "ada" {
		t.Fatalf("行集不符：%#v", v)
	}
}

func TestRedisFetchStringBinary(t *testing.T) {
	srv := startFakeRedis(t, func(cmd []string) []byte {
		switch strings.ToUpper(cmd[0]) {
		case "PING":
			return respSimple("PONG")
		case "TYPE":
			return respBulk("string")
		case "TTL":
			return respInt(60)
		case "GET":
			return respBulk(string([]byte{0x00, 0xFF, 0xFE, 'a'})) // 非 UTF-8 二进制
		case "STRLEN":
			return respInt(4)
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	info := openFakeRedis(t, srv, "", "0", false)
	v, err := RedisFetchValue(info.ID, "db0", "bin:1")
	if err != nil {
		t.Fatalf("FetchValue: %v", err)
	}
	if !v.IsBinary || v.HexText != "00 FF FE 61" {
		t.Fatalf("二进制判定/dump 不符：isBinary=%v hex=%q", v.IsBinary, v.HexText)
	}
	if v.Text != "" {
		t.Fatalf("二进制不应产 Text：%q", v.Text)
	}
}

func TestRedisConsoleQueryGuard(t *testing.T) {
	srv := startFakeRedis(t, func(cmd []string) []byte {
		switch strings.ToUpper(cmd[0]) {
		case "PING":
			return respSimple("PONG")
		case "GET":
			return respBulk("hello")
		case "SET":
			return respSimple("OK")
		case "FLUSHALL":
			return respSimple("OK")
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	info := openFakeRedis(t, srv, "", "0", true)

	// 读命令放行：bulk 回复转单行单列
	out, err := Query(info.ID, "q1", "GET greet", false, 100)
	if err != nil {
		t.Fatalf("Query(GET): %v", err)
	}
	if len(out.Results) != 1 || len(out.Results[0].Result.Rows) != 1 || out.Results[0].Result.Rows[0][0] != "hello" {
		t.Fatalf("GET 结果不符：%#v", out.Results)
	}
	// 多行输入逐条留档
	out, err = Query(info.ID, "q2", "GET greet\nPING\n", false, 100)
	if err != nil || len(out.Results) != 2 {
		t.Fatalf("多行命令应拆两条：err=%v results=%d", err, len(out.Results))
	}
	// 只读会话 SET 拒
	ro := openFakeRedis(t, srv, "", "0", false)
	if _, err := Query(ro.ID, "q3", "SET k v", false, 100); !errors.Is(err, ErrReadOnlySession) {
		t.Fatalf("只读 SET 应拒：%v", err)
	}
	// editable 会话 SET 放行；FLUSHALL 两阶段确认
	if _, err := Query(info.ID, "q4", "SET k v", false, 100); err != nil {
		t.Fatalf("editable SET 应放行：%v", err)
	}
	confirm, err := Query(info.ID, "q5", "FLUSHALL", false, 100)
	if err != nil {
		t.Fatalf("FLUSHALL 首发不应报错：%v", err)
	}
	if confirm.Status != "confirm" || confirm.Confirm != confirmDanger {
		t.Fatalf("FLUSHALL 应进确认：%#v", confirm)
	}
	if _, err := Query(info.ID, "q6", "FLUSHALL", true, 100); err != nil {
		t.Fatalf("确认后 FLUSHALL 应放行：%v", err)
	}
	// MULTI 控制台拒
	if _, err := Query(info.ID, "q7", "MULTI", false, 100); err == nil || !strings.Contains(err.Error(), "手动事务") {
		t.Fatalf("MULTI 应拒：err=%v", err)
	}
	// unknown 拒
	if _, err := Query(info.ID, "q8", "definitely-not-a-command", false, 100); err == nil {
		t.Fatal("unknown 命令应拒")
	}
}

func TestRedisApplyAndDeleteByPrefix(t *testing.T) {
	srv := startFakeRedis(t, func(cmd []string) []byte {
		switch strings.ToUpper(cmd[0]) {
		case "PING":
			return respSimple("PONG")
		case "SET":
			return respSimple("OK")
		case "EXPIRE":
			return respInt(1)
		case "HDEL":
			return respInt(1)
		case "SCAN":
			return respArray(respBulk("0"), respArray(respBulk("tmp:a"), respBulk("tmp:b")))
		case "UNLINK":
			return respInt(int64(len(cmd) - 1))
		default:
			return []byte("-ERR unexpected " + cmd[0] + "\r\n")
		}
	})
	info := openFakeRedis(t, srv, "", "0", true)

	out, err := RedisApply(info.ID, []RedisOp{
		{Kind: "setString", Key: "greet", Value: "hi\n多行", TTLSeconds: 60},
		{Kind: "delHashField", Key: "user:1", Field: "age"},
	})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(out.Rows) != 2 || out.Rows[0][1] != "OK" || out.Rows[1][1] != "OK" {
		t.Fatalf("Apply 结果不符：%#v", out.Rows)
	}
	cmds := srv.commands()
	// setString 带原 TTL → SET + EXPIRE 两条命令；值经 RESP bulk 直发（多行安全）
	if !containsExact(cmds, "SET greet hi\n多行") {
		t.Fatalf("SET 命令未按预期发送：%q", cmds)
	}
	if !containsExact(cmds, "EXPIRE greet 60") {
		t.Fatalf("EXPIRE 补偿未发送：%q", cmds)
	}
	// 只读会话 Apply 拒
	ro := openFakeRedis(t, srv, "", "0", false)
	if _, err := RedisApply(ro.ID, []RedisOp{{Kind: "delKey", Key: "x"}}); !errors.Is(err, ErrReadOnlySession) {
		t.Fatalf("只读 Apply 应拒：%v", err)
	}
	// 前缀批量删
	del, err := RedisDeleteByPrefix(info.ID, "db0", "tmp:")
	if err != nil || del.Deleted != 2 {
		t.Fatalf("DeleteByPrefix：del=%d err=%v", del.Deleted, err)
	}
	// 空前缀拒绝（防误清全库）
	if _, err := RedisDeleteByPrefix(info.ID, "db0", " "); err == nil {
		t.Fatal("空前缀应拒绝")
	}
	// 只读会话前缀删拒
	if _, err := RedisDeleteByPrefix(ro.ID, "db0", "tmp:"); !errors.Is(err, ErrReadOnlySession) {
		t.Fatalf("只读前缀删应拒：%v", err)
	}
}

func containsExact(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// TestRedisDialTimeout 不可达地址的建连超时路径（1 端口快速失败）。
func TestRedisDialTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("short 模式跳过网络负路径")
	}
	_, err := dialRedis("127.0.0.1:1", "", "", 0)
	if err == nil {
		t.Fatal("不可达地址应报错")
	}
	// 超时预算：dialRedis 应在 10 秒内返回（假死地址不让测试挂死）
	done := make(chan struct{})
	go func() { _, _ = dialRedis("127.0.0.1:1", "", "", 0); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("dialRedis 超时预算失效")
	}
}
