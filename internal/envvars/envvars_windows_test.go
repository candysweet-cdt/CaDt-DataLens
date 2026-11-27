//go:build windows

package envvars

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
	if got, err := envUnprotectValue(enc); err != nil || got != "s3cret-值!" {
		t.Fatalf("roundtrip = %q, err %v", got, err)
	}
	if _, err := envUnprotectValue("bm90LWRwYXBpLWRhdGE="); err == nil {
		t.Fatal("non-DPAPI blob should fail closed")
	}
	if enc, err := envProtectValue(""); enc != "" || err != nil {
		t.Fatalf("empty value = %q, err %v", enc, err)
	}
}

func TestEnvVarsEncryptedFileHasNoPlaintext(t *testing.T) {
	envTestApp(t)
	if !envEncryptionSupported() {
		t.Skip("DPAPI unavailable")
	}
	if err := Set([]EnvVarInput{
		{Name: "SECRET_KEY", Value: "s3cret-value-42", Description: "私密", Enabled: true},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(Path())
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
	snap, err := Get()
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Encrypted || len(snap.Vars) != 1 || snap.Vars[0].Value != "s3cret-value-42" {
		t.Fatalf("snapshot = %+v", snap)
	}
	// 切回明文 → 文件出现明文，切回加密 → 再隐藏
	if err := SetEncrypted(false); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(Path())
	if !bytes.Contains(raw, []byte("s3cret-value-42")) {
		t.Fatal("plaintext mode should contain the value")
	}
	if err := SetEncrypted(true); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(Path())
	if bytes.Contains(raw, []byte("s3cret-value-42")) {
		t.Fatal("re-encrypted file must not contain plaintext value")
	}
	if snap, _ := Get(); len(snap.Vars) != 1 || snap.Vars[0].Value != "s3cret-value-42" {
		t.Fatalf("snapshot after toggles = %+v", snap)
	}
}
