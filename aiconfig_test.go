package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIConfigFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	got, err := readAIConfigFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("缺失文件应返回空串，得到 %q", got)
	}
	payload := `{"profiles":[{"id":"p1"}],"preferences":[]}`
	if err := writeAIConfigFile(path, payload); err != nil {
		t.Fatal(err)
	}
	got, err = readAIConfigFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("read = %q, want %q", got, payload)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("临时文件未清理：%s", entry.Name())
		}
	}
}

func TestAIConfigFileRejectsOversize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	big := strings.Repeat("x", aiConfigFileMax+1)
	if err := writeAIConfigFile(path, big); err == nil {
		t.Fatal("超限写入应报错")
	}
	if err := os.WriteFile(path, []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAIConfigFile(path); err == nil {
		t.Fatal("超限读取应报错")
	}
}

func TestAIConfigFileEmptyPath(t *testing.T) {
	if _, err := readAIConfigFile(""); err == nil {
		t.Fatal("空路径应报错")
	}
	if err := writeAIConfigFile("", "{}"); err == nil {
		t.Fatal("空路径应报错")
	}
}

func TestAppAIConfigRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	if got, err := app.AIConfigRead(); err != nil || got != "" {
		t.Fatalf("初始读取 = %q, %v", got, err)
	}
	payload := `{"profiles":[],"autoTitle":false}`
	if err := app.AIConfigWrite(payload); err != nil {
		t.Fatal(err)
	}
	got, err := app.AIConfigRead()
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("读取 = %q, want %q", got, payload)
	}
}
