package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppLogWritesAndPrunes(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 25; i++ {
		name := fmt.Sprintf("2020-01-01_00-00-%02d.txt", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("old"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	path, err := openAppLogAt(dir)
	if err != nil {
		t.Fatalf("openAppLogAt: %v", err)
	}
	defer closeAppLog()

	writeAppLog("error", "测试错误 %d", 42)
	writeAppLog("warn", "第一行\n第二行")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取日志：%v", err)
	}
	text := string(raw)
	for _, want := range []string{"[ERROR] 测试错误 42", "[WARN] 第一行", "[WARN] 第二行"} {
		if !strings.Contains(text, want) {
			t.Fatalf("日志缺少 %q：\n%s", want, text)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".txt") {
			count++
		}
	}
	if count != appLogKeep {
		t.Fatalf("日志保留 %d 个，期望 %d", count, appLogKeep)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("本次日志被误删：%v", err)
	}
}

func TestLogFrontendLevelGate(t *testing.T) {
	dir := t.TempDir()
	path, err := openAppLogAt(dir)
	if err != nil {
		t.Fatalf("openAppLogAt: %v", err)
	}
	defer closeAppLog()
	defer devMode.Store(false)

	devMode.Store(false)
	app := &App{}
	app.LogFrontend("info", "隐藏的 info")
	app.LogFrontend("debug", "隐藏的 debug")
	app.LogFrontend("warning", "保留的警告")
	app.LogFrontend("error", "保留的错误")
	raw, _ := os.ReadFile(path)
	text := string(raw)
	if strings.Contains(text, "隐藏的") {
		t.Fatalf("开发者模式关闭时不应记录 info/debug：\n%s", text)
	}
	if !strings.Contains(text, "[WARN] 保留的警告") || !strings.Contains(text, "[ERROR] 保留的错误") {
		t.Fatalf("警告/错误应始终记录：\n%s", text)
	}

	devMode.Store(true)
	app.LogFrontend("info", "可见的 info")
	app.LogFrontend("debug", "可见的 debug")
	raw, _ = os.ReadFile(path)
	text = string(raw)
	if !strings.Contains(text, "[INFO] 可见的 info") || !strings.Contains(text, "[DEBUG] 可见的 debug") {
		t.Fatalf("开发者模式开启后应记录 info/debug：\n%s", text)
	}
	if got := app.GetDeveloperMode(); !got {
		t.Fatal("GetDeveloperMode 应返回 true")
	}
}
