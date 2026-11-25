package applog

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWritesAndPrunes(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 25; i++ {
		name := fmt.Sprintf("2020-01-01_00-00-%02d.txt", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("old"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	path, err := OpenAt(dir)
	if err != nil {
		t.Fatalf("OpenAt: %v", err)
	}
	defer Close()

	Write("error", "测试错误 %d", 42)
	Write("warn", "第一行\n第二行")
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
	if count != keep {
		t.Fatalf("日志保留 %d 个，期望 %d", count, keep)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("本次日志被误删：%v", err)
	}
	if got := FilePath(); got != path {
		t.Fatalf("FilePath = %q, want %q", got, path)
	}
}

func TestDevModeToggle(t *testing.T) {
	SetDevMode(true)
	defer SetDevMode(false)
	if !DevMode() {
		t.Fatal("DevMode 应为 true")
	}
	if got := OnOff(false); got != "关闭" {
		t.Fatalf("OnOff(false) = %q", got)
	}
}

// 崩溃现场归档：内容逐字节复制、源文件保留（是复制不是移动）、同名不覆盖而另存 -2。
func TestPreserveCrashedLogAtCopiesAndNeverOverwrites(t *testing.T) {
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "2026-11-25_00-12-02.txt")
	content := "panic: runtime error: slice bounds out of range\n\ngoroutine 1 [running]:\nmain.foo()\n"
	if err := os.WriteFile(src, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "crash")

	first, err := PreserveCrashedLogAt(dir, src)
	if err != nil {
		t.Fatalf("PreserveCrashedLogAt: %v", err)
	}
	if filepath.Base(first) != "2026-11-25_00-12-02.txt" {
		t.Fatalf("归档名 = %q", filepath.Base(first))
	}
	if raw, err := os.ReadFile(first); err != nil || string(raw) != content {
		t.Fatalf("归档内容不一致（err=%v）：\n%s", err, string(raw))
	}
	// 源文件必须还在：调用方随后还要用它、用户也可能手动去原路径取。
	if raw, err := os.ReadFile(src); err != nil || string(raw) != content {
		t.Fatalf("源日志被改动或删除（err=%v）", err)
	}

	second, err := PreserveCrashedLogAt(dir, src)
	if err != nil {
		t.Fatalf("第二次归档：%v", err)
	}
	if filepath.Base(second) != "2026-11-25_00-12-02-2.txt" {
		t.Fatalf("重名时应另存 -2，得到 %q", filepath.Base(second))
	}
	if raw, _ := os.ReadFile(first); string(raw) != content {
		t.Fatalf("第一次归档被覆盖：%s", string(raw))
	}
}

func TestPreserveCrashedLogAtErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := PreserveCrashedLogAt("", "x.txt"); err == nil {
		t.Fatal("归档目录为空应报错")
	}
	if _, err := PreserveCrashedLogAt(dir, "  "); err == nil {
		t.Fatal("源路径为空应报错")
	}
	// 源不存在是正常情形（上次会话没留日志），调用方靠 errors.Is 判定为「跳过」。
	if _, err := PreserveCrashedLogAt(dir, filepath.Join(dir, "nope.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("源不存在应返回 os.ErrNotExist，得到 %v", err)
	}
	// 失败时不留半截文件。
	if entries, err := os.ReadDir(dir); err == nil && len(entries) != 0 {
		t.Fatalf("失败路径不应留下归档文件：%v", entries)
	}
}
