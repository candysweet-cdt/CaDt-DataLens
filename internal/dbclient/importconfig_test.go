package dbclient

// importconfig_test.go：连接配置文件导入（结构校验 / 合并 / 策略）的表驱动测试。
//
// 重点锁四件事：① 离线可导入（不做 DNS 解析）；② 合并键命中时保 id 与本地 allowEdit；
// ③ 新增条目一律只读（文件里的 allowEdit 不采信）；④ 不写凭据文件、不污染已有连接。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// writeImportFile 把内容写进临时文件并返回路径（导入只读文件，不碰应用数据目录）。
func writeImportFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "db-connections.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写临时配置失败：%v", err)
	}
	return path
}

func TestImportConnectionsFile(t *testing.T) {
	withTempAppData(t)
	// 先放一条本地已有连接（带 allowEdit + 密码），验证「命中即更新、不动授权与凭据」
	existing, err := SaveConnection(ConnectionConfig{
		Name: "生产只读", Kind: kindMySQL, Host: "10.0.0.5", Port: 3306,
		Database: "app", User: "reader", AllowEdit: false,
	}, "local-pw")
	if err != nil {
		t.Fatalf("预置连接失败：%v", err)
	}
	editable, err := SaveConnection(ConnectionConfig{
		Name: "本地可写", Kind: kindMySQL, Host: "10.0.0.6", Port: 3306,
		Database: "app", User: "writer", AllowEdit: true,
	}, "wpw")
	if err != nil {
		t.Fatalf("预置可写连接失败：%v", err)
	}

	body := `{
	  "v": 1,
	  "connections": [
	    {"name": "生产只读", "kind": "mysql", "host": "10.0.0.5", "port": 3306, "database": "other", "user": "reader", "allowEdit": true},
	    {"name": "本地可写", "kind": "mariadb", "host": "10.0.0.6", "port": 3306, "database": "app", "user": "writer"},
	    {"name": "缓存", "kind": "redis", "host": "127.0.0.1", "port": 6379, "database": "3", "user": ""},
	    {"name": "", "kind": "mysql", "host": "unreachable.invalid", "port": 0, "user": "svc"},
	    {"name": "坏驱动", "kind": "postgres", "host": "10.0.0.7", "port": 5432},
	    {"name": "无主机", "kind": "mysql", "host": "  ", "port": 3306},
	    {"name": "坏编号", "kind": "redis", "host": "10.0.0.8", "port": 6379, "database": "99"}
	  ]
	}`
	result, err := ImportConnectionsFile(writeImportFile(t, body))
	if err != nil {
		t.Fatalf("导入失败：%v", err)
	}

	// 更新：两条命中（mariadb 归一到 mysql），id 与本地 allowEdit 不变
	if len(result.Updated) != 2 {
		t.Fatalf("应更新 2 条，实际 %d：%+v", len(result.Updated), result.Updated)
	}
	updatedByName := map[string]ConnectionConfig{}
	for _, cfg := range result.Updated {
		updatedByName[cfg.Name] = cfg
	}
	if cfg, ok := updatedByName["生产只读"]; !ok || cfg.ID != existing.ID || cfg.AllowEdit {
		t.Fatalf("命中连接应保 id 且不采信文件里的 allowEdit：%+v（原 id=%s）", cfg, existing.ID)
	} else if cfg.Database != "other" {
		t.Fatalf("命中连接应更新其余字段：database=%q", cfg.Database)
	}
	if cfg, ok := updatedByName["本地可写"]; !ok || cfg.ID != editable.ID || !cfg.AllowEdit {
		t.Fatalf("本地已开启的可写连接不该被导入关掉：%+v", cfg)
	}
	if cfg := updatedByName["本地可写"]; cfg.Kind != kindMySQL {
		t.Fatalf("mariadb 应归一到 mysql：kind=%q", cfg.Kind)
	}

	// 新增：Redis + 缺名（自动建议 user@host:port，且端口 0 落默认 3306）
	if len(result.Imported) != 2 {
		t.Fatalf("应新增 2 条，实际 %d：%+v", len(result.Imported), result.Imported)
	}
	var redis, suggested *ConnectionConfig
	for i := range result.Imported {
		cfg := result.Imported[i]
		switch cfg.Kind {
		case kindRedis:
			redis = &cfg
		case kindMySQL:
			suggested = &cfg
		}
	}
	if redis == nil || redis.Port != 6379 || redis.Database != "3" || redis.AllowEdit {
		t.Fatalf("Redis 导入异常：%+v", redis)
	}
	if suggested == nil || suggested.Name != "svc@unreachable.invalid:3306" || suggested.Port != 3306 || suggested.AllowEdit {
		t.Fatalf("缺名/缺端口的条目应按建议名与默认端口落盘：%+v", suggested)
	}

	// 跳过：坏驱动 / 无主机 / 坏编号
	if len(result.Skipped) != 3 {
		t.Fatalf("应跳过 3 条，实际 %d：%+v", len(result.Skipped), result.Skipped)
	}

	// 落盘结果：共 4 条（2 原有 + 2 新增），凭据文件逐字节不变（导入不碰凭据）
	list, err := ListConnections()
	if err != nil || len(list) != 4 {
		t.Fatalf("连接表应有 4 条：%+v, %v", list, err)
	}
	credPath := filepath.Join(AppDataDir(), credentialsFileName)
	before, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatalf("预置连接应已生成凭据文件：%v", err)
	}
	// 上面已读过列表，这里再导一次同一份配置：不应改动凭据文件
	if _, err := ImportConnectionsFile(writeImportFile(t, body)); err != nil {
		t.Fatalf("二次导入失败：%v", err)
	}
	after, err := os.ReadFile(credPath)
	if err != nil || string(before) != string(after) {
		t.Fatalf("导入不得改动凭据文件：%v", err)
	}
	// 原有连接的密码仍可解出（导入没有覆盖凭据）
	if got, found, err := credentialFor(existing); err != nil || !found || got != "local-pw" {
		t.Fatalf("导入不该动已有凭据：%q, found=%v, %v", got, found, err)
	}
}

func TestImportConnectionsFileEdgeCases(t *testing.T) {
	withTempAppData(t)

	cases := []struct {
		name string
		body string
		// wantErrSubstr 非空时断言错误文案包含它（用户能看懂的原因比错误类型更重要）
		wantErrSubstr string
		wantImport    int
	}{
		{name: "裸数组也接受", body: `[{"name":"a","kind":"mysql","host":"10.1.1.1","port":3306,"user":"u"}]`, wantImport: 1},
		{name: "合法 JSON 但没有 connections", body: `{"v":1}`, wantErrSubstr: "缺少 connections"},
		{name: "不是 JSON", body: `hello`, wantErrSubstr: "JSON 解析失败"},
		{name: "空条目", body: `{"connections":[]}`, wantErrSubstr: "没有连接条目"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ImportConnectionsFile(writeImportFile(t, tc.body))
			if tc.wantErrSubstr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErrSubstr) {
					t.Fatalf("错误不符：err=%v，期望包含 %q", err, tc.wantErrSubstr)
				}
				return
			}
			if err != nil {
				t.Fatalf("不应报错：%v", err)
			}
			if len(result.Imported) != tc.wantImport {
				t.Fatalf("新增条数 = %d，期望 %d：%+v", len(result.Imported), tc.wantImport, result)
			}
		})
	}

	// 路径错误：目录 / 不存在 / 超限
	dir := t.TempDir()
	if _, err := ImportConnectionsFile(dir); err == nil || !strings.Contains(err.Error(), "目录") {
		t.Fatalf("目录应被拒：%v", err)
	}
	if _, err := ImportConnectionsFile(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("不存在的文件应报错")
	}
	big := filepath.Join(dir, "big.json")
	if err := os.WriteFile(big, make([]byte, importMaxBytes+1), 0o600); err != nil {
		t.Fatalf("写大文件失败：%v", err)
	}
	if _, err := ImportConnectionsFile(big); err == nil || !strings.Contains(err.Error(), "上限") {
		t.Fatalf("超限文件应被拒：%v", err)
	}

	// 条目数超限
	entries := make([]ConnectionConfig, 0, importMaxEntries+1)
	for i := 0; i <= importMaxEntries; i++ {
		entries = append(entries, ConnectionConfig{Name: "c" + strconv.Itoa(i), Kind: kindMySQL, Host: "10.2.2.2", Port: 3306})
	}
	raw, err := json.Marshal(map[string]any{"v": 1, "connections": entries})
	if err != nil {
		t.Fatalf("构造超限配置失败：%v", err)
	}
	if _, err := ImportConnectionsFile(writeImportFile(t, string(raw))); err == nil || !strings.Contains(err.Error(), "上限") {
		t.Fatalf("条目超限应被拒：%v", err)
	}
}

func TestImportConnectionsFileSameFileDuplicates(t *testing.T) {
	withTempAppData(t)
	body := `{"connections":[
	  {"name":"dup","kind":"mysql","host":"10.3.3.3","port":3306,"user":"u"},
	  {"name":"dup","kind":"mysql","host":"10.3.3.3","port":3306,"user":"u"}
	]}`
	result, err := ImportConnectionsFile(writeImportFile(t, body))
	if err != nil {
		t.Fatalf("导入失败：%v", err)
	}
	if len(result.Imported) != 1 || len(result.Updated) != 1 {
		t.Fatalf("同文件重复条目第二条应走 updated：%+v", result)
	}
	list, err := ListConnections()
	if err != nil || len(list) != 1 {
		t.Fatalf("重复条目不该落成两条：%+v, %v", list, err)
	}
}
