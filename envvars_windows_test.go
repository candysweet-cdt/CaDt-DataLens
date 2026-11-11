//go:build windows

package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestEnvDPAPIRoundtrip(t *testing.T) {
	enc, err := envProtectValue("s3cret-值!")
	if err != nil {
		t.Fatal(err)
	}
	if enc == "" || strings.Contains(enc, "s3cret") {
		t.Fatalf("ciphertext should be opaque base64, got %q", enc)
	}
	if got := envUnprotectValue(enc); got != "s3cret-值!" {
		t.Fatalf("roundtrip = %q", got)
	}
	if got := envUnprotectValue("bm90LWRwYXBpLWRhdGE="); got != "" {
		t.Fatalf("non-DPAPI blob should fail closed, got %q", got)
	}
	if enc, err := envProtectValue(""); enc != "" || err != nil {
		t.Fatalf("empty value = %q, err %v", enc, err)
	}
}

func TestEnvVarsEncryptedFileHasNoPlaintext(t *testing.T) {
	app := envTestApp(t)
	if !envEncryptionSupported() {
		t.Skip("DPAPI unavailable")
	}
	if err := app.SetEnvVars([]EnvVarInput{
		{Name: "SECRET_KEY", Value: "s3cret-value-42", Description: "私密", Enabled: true},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(envVarsFilePath())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("s3cret-value-42")) {
		t.Fatalf("encrypted file must not contain plaintext value:\n%s", raw)
	}
	if !bytes.Contains(raw, []byte(`"encrypted": true`)) {
		t.Fatalf("file header should mark encrypted=true:\n%s", raw)
	}
	// 读取时仍能解回明文
	snap, err := app.GetEnvVars()
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Encrypted || len(snap.Vars) != 1 || snap.Vars[0].Value != "s3cret-value-42" {
		t.Fatalf("snapshot = %+v", snap)
	}
	// 切回明文 → 文件出现明文，切回加密 → 再隐藏
	if err := app.SetEnvVarEncrypted(false); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(envVarsFilePath())
	if !bytes.Contains(raw, []byte("s3cret-value-42")) {
		t.Fatal("plaintext mode should contain the value")
	}
	if err := app.SetEnvVarEncrypted(true); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(envVarsFilePath())
	if bytes.Contains(raw, []byte("s3cret-value-42")) {
		t.Fatal("re-encrypted file must not contain plaintext value")
	}
	if snap, _ := app.GetEnvVars(); len(snap.Vars) != 1 || snap.Vars[0].Value != "s3cret-value-42" {
		t.Fatalf("snapshot after toggles = %+v", snap)
	}
}

// TestRunCommandSyncInjectsEnv 验证命令桥子进程拿到注入变量（enabled 才注入）。
func TestRunCommandSyncInjectsEnv(t *testing.T) {
	app := envTestApp(t)
	if err := app.SetEnvVars([]EnvVarInput{
		{Name: "CADT_ENV_TEST_ON", Value: "hello-cadt", Enabled: true},
		{Name: "CADT_ENV_TEST_OFF", Value: "should-not-appear", Enabled: false},
	}); err != nil {
		t.Fatal(err)
	}
	res, err := app.RunCommandSync("cmd", []string{"/c", "echo", "%CADT_ENV_TEST_ON%"}, "", 10000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Stdout, "hello-cadt") {
		t.Fatalf("stdout = %q, want injected value", res.Stdout)
	}
	res, err = app.RunCommandSync("cmd", []string{"/c", "echo", "%CADT_ENV_TEST_OFF%"}, "", 10000)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Stdout, "should-not-appear") {
		t.Fatalf("disabled var leaked: %q", res.Stdout)
	}
}
