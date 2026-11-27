package envvars

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envTestApp(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	old := AppDataDir
	AppDataDir = func() string { return dir }
	t.Cleanup(func() { AppDataDir = old })
}

func TestEnvVarsCRUDRoundtrip(t *testing.T) {
	envTestApp(t)
	snap, err := Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Vars) != 0 {
		t.Fatalf("default vars = %d, want 0", len(snap.Vars))
	}
	if snap.Supported != envEncryptionSupported() {
		t.Fatalf("supported = %v, want %v", snap.Supported, envEncryptionSupported())
	}
	err = Set([]EnvVarInput{
		{Name: "OPENAI_API_KEY", Value: "sk-test-123", Description: "OpenAI 密钥", Enabled: true},
		{Name: "MY_TOKEN", Value: "t-2", Description: "", Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	snap, err = Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Vars) != 2 {
		t.Fatalf("vars = %d, want 2", len(snap.Vars))
	}
	if snap.Vars[0].Name != "OPENAI_API_KEY" || snap.Vars[0].Value != "sk-test-123" ||
		snap.Vars[0].Description != "OpenAI 密钥" || !snap.Vars[0].Enabled {
		t.Fatalf("entry 0 = %+v", snap.Vars[0])
	}
	if snap.Vars[1].Enabled {
		t.Fatalf("entry 1 should be disabled: %+v", snap.Vars[1])
	}
	if Path() == "" {
		t.Fatal("env vars path empty")
	}
	if _, err := os.Stat(Path()); err != nil {
		t.Fatalf("config file not created: %v", err)
	}
}

func TestEnvVarsValidation(t *testing.T) {
	envTestApp(t)
	cases := []struct {
		name  string
		input EnvVarInput
	}{
		{"变量名数字开头", EnvVarInput{Name: "1ABC", Value: "v", Enabled: true}},
		{"变量名含空格", EnvVarInput{Name: "A B", Value: "v", Enabled: true}},
		{"变量名含横线", EnvVarInput{Name: "A-B", Value: "v", Enabled: true}},
		{"变量名空", EnvVarInput{Name: "  ", Value: "v", Enabled: true}},
		{"值超限", EnvVarInput{Name: "OK_NAME", Value: strings.Repeat("x", envVarValueMaxBytes+1), Enabled: true}},
		{"值含空字符", EnvVarInput{Name: "OK_NAME", Value: "a\x00b", Enabled: true}},
		{"描述超限", EnvVarInput{Name: "OK_NAME", Value: "v", Description: strings.Repeat("描", envVarDescMaxRunes+1), Enabled: true}},
	}
	for _, c := range cases {
		if err := Set([]EnvVarInput{c.input}); err == nil {
			t.Fatalf("%s：应拒绝但通过了", c.name)
		}
	}
	// 重复名拒绝
	if err := Set([]EnvVarInput{
		{Name: "DUP", Value: "1", Enabled: true},
		{Name: "DUP", Value: "2", Enabled: true},
	}); err == nil {
		t.Fatal("重复变量名应被拒绝")
	}
	// 数量上限
	if err := Set(makeVars(envVarsMaxCount + 1)); err == nil {
		t.Fatal("超过数量上限应被拒绝")
	}
	// 边界可用
	if err := Set(makeVars(envVarsMaxCount)); err != nil {
		t.Fatalf("上限数量应可用：%v", err)
	}
}

func makeVars(n int) []EnvVarInput {
	vars := make([]EnvVarInput, 0, n)
	for i := 0; i < n; i++ {
		vars = append(vars, EnvVarInput{Name: "V_" + strings.Repeat("A", i+1), Value: "x", Enabled: true})
	}
	return vars
}

func TestMergeEnvAppendsEnabledOnly(t *testing.T) {
	envTestApp(t)
	if err := Set([]EnvVarInput{
		{Name: "CADT_ON", Value: "yes", Enabled: true},
		{Name: "CADT_OFF", Value: "no", Enabled: false},
	}); err != nil {
		t.Fatal(err)
	}
	base := []string{"PATH=whatever"}
	merged := MergeEnv(base)
	if len(merged) != 2 {
		t.Fatalf("merged = %v, want base + 1 entry", merged)
	}
	if merged[1] != "CADT_ON=yes" {
		t.Fatalf("injected entry = %q, want CADT_ON=yes", merged[1])
	}
	for _, entry := range merged {
		if strings.HasPrefix(entry, "CADT_OFF=") {
			t.Fatalf("disabled var leaked: %q", entry)
		}
	}
	// 无配置时原样返回
	envTestApp(t)
	base2 := []string{"A=1"}
	if got := MergeEnv(base2); len(got) != 1 || got[0] != "A=1" {
		t.Fatalf("mergeEnv without config = %v", got)
	}
}

func TestEnvVarsCorruptFileFallback(t *testing.T) {
	envTestApp(t)
	if err := os.MkdirAll(AppDataDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(), []byte("{ not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	snap, err := Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Vars) != 0 {
		t.Fatalf("corrupt file should fall back to empty, got %d", len(snap.Vars))
	}
	if injectedEnvEntries() != nil {
		t.Fatal("corrupt file should inject nothing")
	}
}

// TestEnvVarsPlaintextFileHeader 验证关闭加密后文件头与明文值（全平台）；
// 加密模式的"文件不含明文"断言在 envvars_windows_test.go。
func TestEnvVarsPlaintextFileHeader(t *testing.T) {
	envTestApp(t)
	if err := SetEncrypted(false); err != nil {
		t.Fatal(err)
	}
	if err := Set([]EnvVarInput{{Name: "PLAIN", Value: "plain-value", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(Path())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"encrypted": false`) {
		t.Fatalf("file header should mark encrypted=false:\n%s", raw)
	}
	if !strings.Contains(string(raw), "plain-value") {
		t.Fatal("plaintext mode should store the value as-is")
	}
	var file envVarsFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.Encrypted || len(file.Vars) != 1 || file.Vars[0].Value != "plain-value" {
		t.Fatalf("parsed file = %+v", file)
	}
}

// 换机器/换用户后密文解不开：保存任意其它变量不得把这些密文抹成空值。
// 旧实现把解密失败吞成 ""，Set 整表重写后原密文永久丢失，MergeEnv 还会注入空值。
func TestEnvVarsUnreadableSealedPreserved(t *testing.T) {
	envTestApp(t)
	if !envEncryptionSupported() {
		t.Skip("当前平台无 DPAPI，不涉及密文")
	}
	const unreadable = "bm90LWRwYXBpLWRhdGE=" // 合法 base64，但不是 DPAPI 密文
	stored := envVarsFile{
		Encrypted: true,
		Vars: []envVarEntry{
			{Name: "STALE_SECRET", Value: unreadable, Description: "来自另一台机器", Enabled: true},
			{Name: "BROKEN", Value: "%%%not-base64%%%", Enabled: false},
		},
	}
	raw, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(Path()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	snap, err := Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Vars) != 2 || snap.Vars[0].Value != "" {
		t.Fatalf("解不开的值应为空（不显示乱码）：%+v", snap.Vars)
	}

	// 模拟"界面上改了一个无关变量后保存"：解不开的项以空值回传
	if err := Set([]EnvVarInput{
		{Name: "STALE_SECRET", Value: "", Description: "来自另一台机器", Enabled: true},
		{Name: "NEW_VAR", Value: "v", Enabled: true},
	}); err != nil {
		t.Fatal(err)
	}

	after, err := os.ReadFile(Path())
	if err != nil {
		t.Fatal(err)
	}
	var kept envVarsFile
	if err := json.Unmarshal(after, &kept); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range kept.Vars {
		if entry.Name == "STALE_SECRET" {
			found = true
			if entry.Value != unreadable {
				t.Fatalf("解不开的密文被覆盖：%q", entry.Value)
			}
		}
		if entry.Name == "NEW_VAR" && entry.Value == "" {
			t.Fatal("新变量未落盘")
		}
	}
	if !found {
		t.Fatal("解不开的变量被静默删除")
	}

	// 解不开的值不得注入子进程（注入空串会覆盖系统同名变量）
	for _, item := range MergeEnv(nil) {
		if strings.HasPrefix(item, "STALE_SECRET=") {
			t.Fatalf("解不开的变量被注入：%q", item)
		}
	}
}
