package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func envTestApp(t *testing.T) *App {
	t.Helper()
	t.Setenv("AppData", t.TempDir())
	return NewApp()
}

func TestEnvVarsCRUDRoundtrip(t *testing.T) {
	app := envTestApp(t)
	snap, err := app.GetEnvVars()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Vars) != 0 {
		t.Fatalf("default vars = %d, want 0", len(snap.Vars))
	}
	if snap.Supported != envEncryptionSupported() {
		t.Fatalf("supported = %v, want %v", snap.Supported, envEncryptionSupported())
	}
	err = app.SetEnvVars([]EnvVarInput{
		{Name: "OPENAI_API_KEY", Value: "sk-test-123", Description: "OpenAI 密钥", Enabled: true},
		{Name: "MY_TOKEN", Value: "t-2", Description: "", Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	snap, err = app.GetEnvVars()
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
	if envVarsFilePath() == "" {
		t.Fatal("env vars path empty")
	}
	if _, err := os.Stat(envVarsFilePath()); err != nil {
		t.Fatalf("config file not created: %v", err)
	}
}

func TestEnvVarsValidation(t *testing.T) {
	app := envTestApp(t)
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
		if err := app.SetEnvVars([]EnvVarInput{c.input}); err == nil {
			t.Fatalf("%s：应拒绝但通过了", c.name)
		}
	}
	// 重复名拒绝
	if err := app.SetEnvVars([]EnvVarInput{
		{Name: "DUP", Value: "1", Enabled: true},
		{Name: "DUP", Value: "2", Enabled: true},
	}); err == nil {
		t.Fatal("重复变量名应被拒绝")
	}
	// 数量上限
	if err := app.SetEnvVars(makeVars(envVarsMaxCount + 1)); err == nil {
		t.Fatal("超过数量上限应被拒绝")
	}
	// 边界可用
	if err := app.SetEnvVars(makeVars(envVarsMaxCount)); err != nil {
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
	app := envTestApp(t)
	if err := app.SetEnvVars([]EnvVarInput{
		{Name: "CADT_ON", Value: "yes", Enabled: true},
		{Name: "CADT_OFF", Value: "no", Enabled: false},
	}); err != nil {
		t.Fatal(err)
	}
	base := []string{"PATH=whatever"}
	merged := mergeEnv(base)
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
	if got := mergeEnv(base2); len(got) != 1 || got[0] != "A=1" {
		t.Fatalf("mergeEnv without config = %v", got)
	}
}

func TestEnvVarsCorruptFileFallback(t *testing.T) {
	app := envTestApp(t)
	if err := os.MkdirAll(appDataRoot(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envVarsFilePath(), []byte("{ not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	snap, err := app.GetEnvVars()
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
	app := envTestApp(t)
	if err := app.SetEnvVarEncrypted(false); err != nil {
		t.Fatal(err)
	}
	if err := app.SetEnvVars([]EnvVarInput{{Name: "PLAIN", Value: "plain-value", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(envVarsFilePath())
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
