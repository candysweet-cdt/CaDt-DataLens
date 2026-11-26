package dbclient

// config.go：连接配置与凭据——配置（非敏感）与凭据（dpapi 加密密码）分文件存放。
//
// 与 aiconfig 同一安全口径：密文绑定当前用户与本机（换用户/换机器解不开，ErrDecrypt 时
// 提示重新保存而不是覆盖）；凭据键用复合键 connectionID|host|port|user（防 SQLTools 式
// 同名冲突）；文件写入走 sessionlock + atomfile（跨进程单写者 + 原子替换）。
//
// 目标校验：拒绝连接链路本地地址（169.254.0.0/16，含云厂商 IMDS 169.254.169.254）与
// metadata 主机名。方案原文是「内网保留段默认拒绝」，实施时收窄为只拦元数据端点——
// 开发库大多在 192.168.x.x，默认拒内网等于让多数用户第一次用就去改配置（已确认的偏离）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/dpapi"
	"datalens/internal/sessionlock"
)

const (
	configLockWait = 2 * time.Second
	idPrefix       = "dbc-"
)

// credentialRecord 单条凭据：Sealed=true 表示 Value 是 dpapi 密文（base64）。
type credentialRecord struct {
	Value  string `json:"value"`
	Sealed bool   `json:"sealed"`
}

type credentialsData struct {
	Version int                         `json:"v"`
	Records map[string]credentialRecord `json:"records"`
}

// validateConnectionTarget 拒绝云元数据端点与链路本地地址；主机名先解析再判。
// 返回解析出的候选 IP（已是 IP 字面量则原样返回）——调用方可用它直连，封住
// 「校验时解析一次、拨号再解析一次」之间的 DNS rebinding 窗口。
func validateConnectionTarget(host string) ([]net.IP, error) {
	h := strings.TrimSpace(host)
	if h == "" {
		return nil, errors.New("主机不能为空")
	}
	lower := strings.ToLower(strings.TrimSuffix(h, "."))
	if lower == "metadata.google.internal" || lower == "metadata" {
		return nil, fmt.Errorf("拒绝连接云元数据服务端点：%s", h)
	}
	var ips []net.IP
	if ip := net.ParseIP(h); ip != nil {
		ips = append(ips, ip)
	} else {
		// 解析限时 5s：慢 DNS 不该把保存/测试/连接全部挂住
		resolver := &net.Resolver{}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		addrs, err := resolver.LookupHost(ctx, h)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("主机解析失败：%w", err)
		}
		for _, a := range addrs {
			if ip := net.ParseIP(a); ip != nil {
				ips = append(ips, ip)
			}
		}
	}
	for _, ip := range ips {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return nil, fmt.Errorf("拒绝连接链路本地地址（云元数据服务端点）：%s", ip)
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("主机解析不出可用地址：%s", h)
	}
	return ips, nil
}

// resolveSafeAddr 解析 + 校验后返回「IP:port」——DSN 直接拨这个地址。
// resolveSafeAddrs 解析 + 校验后返回候选「IP:port」列表（IPv4 优先——本机 MySQL/MariaDB
// 常只监听 IPv4，而 localhost 的解析顺序不确定，只拨第一个可能撞上 ::1 直接失败）。
func resolveSafeAddrs(host string, port int) ([]string, error) {
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("端口无效：%d", port)
	}
	ips, err := validateConnectionTarget(host)
	if err != nil {
		return nil, err
	}
	v4 := make([]net.IP, 0, len(ips))
	rest := make([]net.IP, 0, len(ips))
	for _, ip := range ips {
		if ip.To4() != nil {
			v4 = append(v4, ip)
		} else {
			rest = append(rest, ip)
		}
	}
	out := make([]string, 0, len(ips))
	seen := map[string]bool{}
	for _, ip := range append(v4, rest...) {
		addr := net.JoinHostPort(ip.String(), strconv.Itoa(port))
		if !seen[addr] {
			seen[addr] = true
			out = append(out, addr)
		}
	}
	return out, nil
}

// validateConfig 保存/测试前的合法性校验。
func validateConfig(cfg ConnectionConfig) error {
	if strings.TrimSpace(cfg.Name) == "" {
		return errors.New("连接名不能为空")
	}
	if cfg.Kind != kindMySQL && cfg.Kind != kindRedis {
		return fmt.Errorf("暂只支持 MySQL / Redis 连接（SQLite 是打开本地文件，不落连接表）")
	}
	if cfg.Kind == kindRedis {
		// Redis 的 database 字段是数据库编号（0–15；空 = 0）
		if d := strings.TrimSpace(cfg.Database); d != "" {
			n, err := strconv.Atoi(d)
			if err != nil || n < 0 || n > 15 {
				return fmt.Errorf("Redis 数据库编号无效：%q（0–15 的数字）", cfg.Database)
			}
		}
	}
	if _, err := validateConnectionTarget(cfg.Host); err != nil {
		return err
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return fmt.Errorf("端口无效：%d", cfg.Port)
	}
	return nil
}

// compositeKey 凭据复合键：同一 host:port 不同用户/连接互不串凭据。
func compositeKey(cfg ConnectionConfig) string {
	return strings.Join([]string{cfg.ID, cfg.Host, strconv.Itoa(cfg.Port), cfg.User}, "|")
}

func configPaths() (string, string, error) {
	if AppDataDir == nil {
		return "", "", errors.New("应用数据目录不可用")
	}
	root := AppDataDir()
	if root == "" {
		return "", "", errors.New("应用数据目录不可用")
	}
	return filepath.Join(root, connectionsFileName), filepath.Join(root, credentialsFileName), nil
}

// ---------- 配置文件读写（调用方需已持锁） ----------

func readConnections(path string) ([]ConnectionConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out struct {
		Version     int                `json:"v"`
		Connections []ConnectionConfig `json:"connections"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("连接配置文件损坏：%w", err)
	}
	return out.Connections, nil
}

func writeConnections(path string, list []ConnectionConfig) error {
	raw, err := json.MarshalIndent(struct {
		Version     int                `json:"v"`
		Connections []ConnectionConfig `json:"connections"`
	}{Version: 1, Connections: list}, "", "  ")
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomic(path, append(raw, '\n'))
}

func readCredentials(path string) (map[string]credentialRecord, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]credentialRecord{}, nil
		}
		return nil, err
	}
	var out credentialsData
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("凭据文件损坏：%w", err)
	}
	if out.Records == nil {
		out.Records = map[string]credentialRecord{}
	}
	return out.Records, nil
}

func writeCredentials(path string, records map[string]credentialRecord) error {
	raw, err := json.MarshalIndent(credentialsData{Version: 1, Records: records}, "", "  ")
	if err != nil {
		return err
	}
	// 0600：非 Windows 的明文退路下，同机其他用户不应可读
	return atomfile.WriteFileAtomicMode(path, append(raw, '\n'), 0o600)
}

// ---------- 对外入口 ----------

// ListConnections 连接清单（不含密码）。
func ListConnections() ([]ConnectionConfig, error) {
	cfgPath, _, err := configPaths()
	if err != nil {
		return nil, err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return nil, err
	}
	defer lock.Release()
	list, err := readConnections(cfgPath)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []ConnectionConfig{}
	}
	return list, nil
}

// SaveConnection 新建/更新连接；password 为空串表示保留旧凭据。
// 密码只在内存参与加密，不进日志、不进返回值。
func SaveConnection(cfg ConnectionConfig, password string) (ConnectionConfig, error) {
	if err := validateConfig(cfg); err != nil {
		return ConnectionConfig{}, err
	}
	cfgPath, credPath, err := configPaths()
	if err != nil {
		return ConnectionConfig{}, err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return ConnectionConfig{}, err
	}
	defer lock.Release()

	list, err := readConnections(cfgPath)
	if err != nil {
		return ConnectionConfig{}, err
	}
	if cfg.ID == "" {
		cfg.ID = fmt.Sprintf("%s%d", idPrefix, time.Now().UnixNano())
	}
	cfg.Name = strings.TrimSpace(cfg.Name)
	cfg.Host = strings.TrimSpace(cfg.Host)
	cfg.User = strings.TrimSpace(cfg.User)
	cfg.UpdatedAt = time.Now().UnixMilli()
	// 复合键（ID|host|port|user）随 host/port/user 变化：更新时记下旧键，凭据做迁移/清理，
	// 否则旧密文成孤儿、新键下找不到旧密码
	var prev *ConnectionConfig
	replaced := false
	for i := range list {
		if list[i].ID == cfg.ID {
			old := list[i]
			prev = &old
			list[i] = cfg
			replaced = true
			break
		}
	}
	if !replaced {
		list = append(list, cfg)
	}
	if err := writeConnections(cfgPath, list); err != nil {
		return ConnectionConfig{}, err
	}
	oldKey := ""
	if prev != nil {
		oldKey = compositeKey(*prev)
	}
	newKey := compositeKey(cfg) // 新建也要算：密文按新复合键落位
	if password != "" || (prev != nil && oldKey != newKey) {
		records, err := readCredentials(credPath)
		if err != nil {
			return ConnectionConfig{}, err
		}
		switch {
		case password != "":
			stored := password
			sealed := dpapi.Supported()
			if sealed {
				sealedStr, perr := dpapi.Protect(password, "datalens-db-credential:"+cfg.ID)
				if perr != nil {
					return ConnectionConfig{}, fmt.Errorf("凭据加密失败：%w", perr)
				}
				stored = sealedStr
			}
			records[newKey] = credentialRecord{Value: stored, Sealed: sealed}
		case oldKey != newKey && prev != nil:
			// 改了 host/port/user 但没重输密码：把旧密文迁到新复合键（dpapi 绑定用户+机器，密文不变）
			if rec, ok := records[oldKey]; ok {
				records[newKey] = rec
			}
		}
		// 旧复合键清掉（密文不残留磁盘）
		if prev != nil && oldKey != newKey {
			delete(records, oldKey)
		}
		if err := writeCredentials(credPath, records); err != nil {
			return ConnectionConfig{}, err
		}
	}
	return cfg, nil
}

// DeleteConnection 删除连接及其凭据。
func DeleteConnection(id string) error {
	cfgPath, credPath, err := configPaths()
	if err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return err
	}
	defer lock.Release()

	list, err := readConnections(cfgPath)
	if err != nil {
		return err
	}
	found := false
	kept := make([]ConnectionConfig, 0, len(list))
	for _, c := range list {
		if c.ID == id {
			found = true
			continue
		}
		kept = append(kept, c)
	}
	if !found {
		return fmt.Errorf("连接不存在：%s", id)
	}
	if err := writeConnections(cfgPath, kept); err != nil {
		return err
	}
	records, err := readCredentials(credPath)
	if err != nil {
		return err
	}
	for key := range records {
		// 只删属于这个连接的复合键（键首段是 connectionID）
		if strings.HasPrefix(key, id+"|") {
			delete(records, key)
		}
	}
	return writeCredentials(credPath, records)
}

// credentialFor 解密连接的密码。found=false 表示这条连接**从未保存过凭据**（区别于
// 「保存了空密码」）——调用方（Connect）据此给出可操作的报错，而不是让驱动报一轮
// Access denied (using password: NO) 让人摸不着头脑。
func credentialFor(cfg ConnectionConfig) (string, bool, error) {
	_, credPath, err := configPaths()
	if err != nil {
		return "", false, err
	}
	records, err := readCredentials(credPath)
	if err != nil {
		return "", false, err
	}
	rec, ok := records[compositeKey(cfg)]
	if !ok {
		return "", false, nil
	}
	if !rec.Sealed {
		return rec.Value, true, nil // 非 Windows（dpapi.Supported()==false）的明文退路
	}
	plain, err := dpapi.Unprotect(rec.Value)
	if err != nil {
		return "", true, fmt.Errorf("凭据解密失败（换用户/换机器后密文不可解），请重新保存密码：%w", err)
	}
	return plain, true, nil
}

// findConnection 按取清单。
func findConnection(id string) (ConnectionConfig, error) {
	list, err := ListConnections()
	if err != nil {
		return ConnectionConfig{}, err
	}
	for _, c := range list {
		if c.ID == id {
			return c, nil
		}
	}
	return ConnectionConfig{}, fmt.Errorf("连接不存在：%s", id)
}

// Connect 用已保存连接建立会话。
func Connect(id string) (SessionInfo, error) {
	cfg, err := findConnection(id)
	if err != nil {
		return SessionInfo{}, err
	}
	password, found, err := credentialFor(cfg)
	if err != nil {
		return SessionInfo{}, err
	}
	if !found {
		return SessionInfo{}, errors.New("该连接尚未保存密码（可能是旧版本保存的连接）：打开侧栏菜单「编辑连接」，重新输入密码并保存后再连接")
	}
	return openSession(openSpec{Kind: cfg.Kind, Config: cfg, Password: password, AllowEdit: cfg.AllowEdit})
}

// TestConnection 测试连接：先连再查版本（两级验证）；password 为空时用已存凭据。
// 临时会话不进注册表。Redis 是独立子系统，不能走 SQL Driver 注册表，改为共用
// openRedisConnection 的正常建连路径（目标校验 / AUTH / SELECT / PING 均一致）。
func TestConnection(cfg ConnectionConfig, password string) (string, error) {
	if err := validateConfig(cfg); err != nil {
		return "", err
	}
	if password == "" {
		p, found, err := credentialFor(cfg)
		if err != nil {
			return "", err
		}
		if found {
			password = p
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if cfg.Kind == kindRedis {
		conn, err := openRedisConnection(cfg, password)
		if err != nil {
			return "", err
		}
		defer func() { _ = conn.client.Close() }()
		version, err := redisServerVersion(ctx, &dbSession{kind: kindRedis, redis: conn.client})
		if err != nil {
			return "", err
		}
		return "Redis " + version, nil
	}
	drv, err := driverFor(cfg.Kind)
	if err != nil {
		return "", err
	}
	s, err := drv.Open(ctx, openSpec{Kind: cfg.Kind, Config: cfg, Password: password, AllowEdit: false})
	if err != nil {
		return "", err
	}
	defer func() { _ = s.db.Close() }()
	return serverVersion(ctx, s)
}

// ---------- 插件驱动的通用凭据存取 ----------

// credentialLockFile 复用连接配置的锁与凭据文件；插件键约定形如 dbplug:<条目id>:<字段键>，
// 与 ConnectionConfig 的复合键共存于同一张表（前缀隔离，互不干扰）。

// CredentialPut 保存一条通用凭据（dpapi 加密，同连接凭据一张表）。
// plain 为空串时删除该键（宿主语义：密码框留空 = 保持不变，不会调这里）。
func CredentialPut(key, plain string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("凭据键不能为空")
	}
	_, credPath, err := configPaths()
	if err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(credPath), configLockFile), configLockWait)
	if err != nil {
		return err
	}
	defer lock.Release()

	records, err := readCredentials(credPath)
	if err != nil {
		return err
	}
	if plain == "" {
		delete(records, key)
	} else {
		stored := plain
		sealed := dpapi.Supported()
		if sealed {
			sealedStr, perr := dpapi.Protect(plain, "datalens-db-plugin-credential")
			if perr != nil {
				return fmt.Errorf("凭据加密失败：%w", perr)
			}
			stored = sealedStr
		}
		records[key] = credentialRecord{Value: stored, Sealed: sealed}
	}
	return writeCredentials(credPath, records)
}

// CredentialGet 读取一条通用凭据；无记录返回空串。
func CredentialGet(key string) (string, error) {
	if strings.TrimSpace(key) == "" {
		return "", errors.New("凭据键不能为空")
	}
	_, credPath, err := configPaths()
	if err != nil {
		return "", err
	}
	records, err := readCredentials(credPath)
	if err != nil {
		return "", err
	}
	rec, ok := records[key]
	if !ok {
		return "", nil
	}
	if !rec.Sealed {
		return rec.Value, nil
	}
	plain, err := dpapi.Unprotect(rec.Value)
	if err != nil {
		return "", fmt.Errorf("凭据解密失败（换用户/换机器后密文不可解），请重新保存：%w", err)
	}
	return plain, nil
}

func serverVersion(ctx context.Context, s *dbSession) (string, error) {
	switch s.kind {
	case kindSQLite:
		return sqliteServerVersion(ctx, s)
	case kindMySQL:
		return mysqlServerVersion(ctx, s)
	case kindRedis:
		return redisServerVersion(ctx, s)
	default:
		return "", fmt.Errorf("未知方言：%s", s.kind)
	}
}
