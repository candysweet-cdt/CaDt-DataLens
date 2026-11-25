package dbclient

// importconfig.go：连接配置文件（db-connections.json 同构）导入。
//
// 用途：把外部拖进侧栏「数据库」面板的 *连接配置* 落进本机连接表（db-connections.json），
// 让用户换机器 / 从同事那里拿一份连接清单时不必逐条手填。与 SaveConnection 的差异都是刻意的：
//
//   - **不做 DNS 解析**：SaveConnection → validateConfig 会解析主机（离线即导入失败），
//     导入只做结构与范围校验；主机是否可达留到 Connect / TestConnection（那里的校验一条不少）。
//   - **一次锁内批量落盘**：逐条 SaveConnection 会 N 次加锁 + N 次解析，且会把「导入」的
//     UpdatedAt 语义搅乱。
//   - **凭据不导入**：密码在 db-credentials.json 里是 dpapi 密文（绑定当前用户与本机），
//     跨机解不开，导入后需要用户在「编辑连接」里重填一次。这里绝不写凭据文件。
//   - **allowEdit 不采信**：新增条目一律只读。写权限必须由用户在本机显式打开——
//     「拖一个 JSON 进来」不该成为开启数据库写权限的通道；命中已有连接时保留本地开关。
//
// 合并键是 (kind, host, port, user, name)：命中即更新（保留原 id 与本地 allowEdit），
// 否则按 importMaxEntries 内的顺序新建。同一文件里重复的条目第二次会走 updated 分支。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/sessionlock"
)

const (
	importMaxBytes   = 1 << 20 // 连接配置是纯文本小文件，1 MB 足够几百条连接
	importMaxEntries = 200     // 单次导入上限：防「拖错一个巨型 JSON」把侧栏灌满
)

// ImportFailure 一条未导入的连接及原因（前端汇总提示用）。
type ImportFailure struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// ImportResult 导入结果：新增 / 更新（命中已有连接）/ 跳过。
type ImportResult struct {
	Imported []ConnectionConfig `json:"imported"`
	Updated  []ConnectionConfig `json:"updated"`
	Skipped  []ImportFailure    `json:"skipped"`
}

// ImportConnectionsFile 从连接配置文件导入连接（非 SQLite：SQLite 是打开本地文件，不进连接表）。
func ImportConnectionsFile(path string) (ImportResult, error) {
	result := ImportResult{
		Imported: []ConnectionConfig{},
		Updated:  []ConnectionConfig{},
		Skipped:  []ImportFailure{},
	}
	target := strings.TrimSpace(path)
	if target == "" {
		return result, errors.New("连接配置文件路径为空")
	}
	info, err := os.Stat(target)
	if err != nil {
		return result, fmt.Errorf("读取连接配置失败：%w", err)
	}
	if info.IsDir() {
		return result, errors.New("这是一个目录，不是连接配置文件")
	}
	if info.Size() > importMaxBytes {
		return result, fmt.Errorf("连接配置文件超过 %d KB 上限，请先拆分", importMaxBytes/1024)
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return result, fmt.Errorf("读取连接配置失败：%w", err)
	}
	entries, err := parseConnectionConfigFile(raw)
	if err != nil {
		return result, err
	}
	if len(entries) == 0 {
		return result, errors.New("连接配置里没有连接条目")
	}
	if len(entries) > importMaxEntries {
		return result, fmt.Errorf("连接配置含 %d 条连接，超过 %d 条上限", len(entries), importMaxEntries)
	}

	// 先结构校验（不联网），不合法的逐条记录原因，合法的一次落盘
	candidates := make([]ConnectionConfig, 0, len(entries))
	for _, entry := range entries {
		cfg, reason := sanitizeImported(entry)
		if reason != "" {
			result.Skipped = append(result.Skipped, ImportFailure{Name: importedDisplayName(entry), Reason: reason})
			continue
		}
		candidates = append(candidates, cfg)
	}
	if len(candidates) == 0 {
		return result, nil
	}

	cfgPath, _, err := configPaths()
	if err != nil {
		return result, err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return result, err
	}
	defer lock.Release()

	list, err := readConnections(cfgPath)
	if err != nil {
		return result, err
	}
	now := time.Now()
	for i, cfg := range candidates {
		cfg.UpdatedAt = now.UnixMilli()
		idx := -1
		for j := range list {
			if sameConnection(list[j], cfg) {
				idx = j
				break
			}
		}
		if idx >= 0 {
			// 命中已有连接：id 与本地「允许编辑」开关都不动（导入不改变本机授权）
			cfg.ID = list[idx].ID
			cfg.AllowEdit = list[idx].AllowEdit
			list[idx] = cfg
			result.Updated = append(result.Updated, cfg)
			continue
		}
		cfg.ID = fmt.Sprintf("%s%d-%d", idPrefix, now.UnixNano(), i)
		cfg.AllowEdit = false
		list = append(list, cfg)
		result.Imported = append(result.Imported, cfg)
	}
	if err := writeConnections(cfgPath, list); err != nil {
		return result, err
	}
	return result, nil
}

// parseConnectionConfigFile 宽容解析两种形态：{"v":1,"connections":[...]} 与裸数组。
// 合法 JSON 但没有 connections 时给明确原因（用户拖错文件的概率不低）。
func parseConnectionConfigFile(raw []byte) ([]ConnectionConfig, error) {
	var wrapped struct {
		Version     int                `json:"v"`
		Connections []ConnectionConfig `json:"connections"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil && wrapped.Connections != nil {
		return wrapped.Connections, nil
	}
	var list []ConnectionConfig
	if err := json.Unmarshal(raw, &list); err == nil && list != nil {
		return list, nil
	}
	if json.Valid(raw) {
		return nil, errors.New("不是连接配置文件：缺少 connections 数组")
	}
	return nil, errors.New("不是连接配置文件：JSON 解析失败")
}

// sanitizeImported 归一 + 结构校验（不解析主机）。返回非空 reason 表示跳过。
func sanitizeImported(cfg ConnectionConfig) (ConnectionConfig, string) {
	kind := strings.ToLower(strings.TrimSpace(cfg.Kind))
	switch kind {
	case kindMySQL, "mariadb":
		// mariadb 与 mysql 同引擎（连接表只存 mysql，前端按工作区条目的 kind 区分显示标签）
		kind = kindMySQL
	case kindRedis:
	default:
		if kind == "" {
			return cfg, "缺少驱动类型（kind）"
		}
		return cfg, "不支持的驱动类型：" + strings.TrimSpace(cfg.Kind)
	}
	host := strings.TrimSpace(cfg.Host)
	if host == "" {
		return cfg, "主机为空"
	}
	port := cfg.Port
	if port == 0 {
		port = 3306
		if kind == kindRedis {
			port = 6379
		}
	}
	if port < 0 || port > 65535 {
		return cfg, fmt.Sprintf("端口无效：%d", port)
	}
	database := strings.TrimSpace(cfg.Database)
	if kind == kindRedis && database != "" {
		n, err := strconv.Atoi(database)
		if err != nil || n < 0 || n > 15 {
			return cfg, fmt.Sprintf("Redis 数据库编号无效：%q（0–15 的数字）", database)
		}
	}
	user := strings.TrimSpace(cfg.User)
	name := strings.TrimSpace(cfg.Name)
	if name == "" {
		if user != "" {
			name = fmt.Sprintf("%s@%s:%d", user, host, port)
		} else {
			name = fmt.Sprintf("%s:%d", host, port)
		}
	}
	return ConnectionConfig{
		Kind:     kind,
		Name:     name,
		Host:     host,
		Port:     port,
		Database: database,
		User:     user,
	}, ""
}

// sameConnection 合并键：驱动 + 主机（不分大小写）+ 端口 + 用户 + 名称。
func sameConnection(a, b ConnectionConfig) bool {
	if a.Kind != b.Kind || a.Port != b.Port {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(a.Host), strings.TrimSpace(b.Host)) {
		return false
	}
	if strings.TrimSpace(a.User) != strings.TrimSpace(b.User) {
		return false
	}
	return strings.TrimSpace(a.Name) == strings.TrimSpace(b.Name)
}

// importedDisplayName 跳过项的展示名：尽量给用户认得出的标识。
func importedDisplayName(cfg ConnectionConfig) string {
	if name := strings.TrimSpace(cfg.Name); name != "" {
		return name
	}
	host := strings.TrimSpace(cfg.Host)
	if host != "" {
		if user := strings.TrimSpace(cfg.User); user != "" {
			return fmt.Sprintf("%s@%s:%d", user, host, cfg.Port)
		}
		return fmt.Sprintf("%s:%d", host, cfg.Port)
	}
	kind := strings.TrimSpace(cfg.Kind)
	if kind == "" {
		return "（无名称条目）"
	}
	return "（" + kind + " 连接）"
}
