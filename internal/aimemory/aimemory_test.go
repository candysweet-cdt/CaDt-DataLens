package aimemory

// aimemory_test.go：记忆写通道的校验面与并发面。
//
// 守两件事：① 坏目录 / 坏文件名 / 超长内容一律拒绝且不落盘（不许在工作区根上凭空写出文件）；
// ② 并发写不出现半截文件（锁 + 原子替换的意义就在这里）。

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func memoryDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), ".cadt", "memory")
}

func TestWriteRejectsBadDir(t *testing.T) {
	base := t.TempDir()
	cases := []struct {
		name string
		dir  string
	}{
		{"空", ""},
		{"相对路径", ".cadt/memory"},
		{"工作区根本身", base},
		{"随便一层目录", filepath.Join(base, "notes")},
		{"缺 .cadt 层的 memory", filepath.Join(base, "memory")},
	}
	for _, c := range cases {
		if _, err := Write(c.dir, "MEMORY.md", "x"); err == nil {
			t.Fatalf("%s（%q）应被拒绝", c.name, c.dir)
		}
	}
	// 一句都不该落盘：根目录下不多出任何文件
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("被拒绝的写入不该产生文件，got %d 个", len(entries))
	}
}

func TestWriteRejectsBadName(t *testing.T) {
	dir := memoryDir(t)
	names := []string{
		"", "../x.md", "a/b.md", `a\b.md`, "C:x.md", "x.txt", "x..y.md",
		".md", strings.Repeat("导", 65) + ".md", "有 空格.md",
	}
	for _, name := range names {
		if _, err := Write(dir, name, "x"); err == nil {
			t.Fatalf("文件名 %q 应被拒绝", name)
		}
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("被拒绝的写入不该建出目录：%v", err)
	}
}

func TestWriteRejectsOverlongContent(t *testing.T) {
	dir := memoryDir(t)
	tooLong := strings.Repeat("记", MaxContentRunes+1)
	if _, err := Write(dir, "MEMORY.md", tooLong); err == nil {
		t.Fatal("超长内容应被拒绝")
	}
	// 上限本身放行：中文按 rune 计，不被字节数误杀
	atLimit := strings.Repeat("记", MaxContentRunes)
	path, err := Write(dir, "MEMORY.md", atLimit)
	if err != nil {
		t.Fatalf("恰好达到上限应放行：%v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != len(atLimit) {
		t.Fatalf("落盘内容长度不符：%d vs %d", len(raw), len(atLimit))
	}
}

func TestWriteRoundTrip(t *testing.T) {
	dir := memoryDir(t)
	content := "# 记忆\n\n- 一条事实\n"
	path, err := Write(dir, "MEMORY.md", content)
	if err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	if want := filepath.Join(dir, "MEMORY.md"); path != want {
		t.Fatalf("返回路径 = %q，want %q", path, want)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != content {
		t.Fatalf("读回内容不符：%q", string(raw))
	}
	// 覆盖：整份替换，不残留旧尾部
	if _, err := Write(dir, "MEMORY.md", "短"); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if string(raw) != "短" {
		t.Fatalf("覆盖后内容 = %q", string(raw))
	}
	// 原子写不留临时文件
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("残留临时文件：%s", entry.Name())
		}
	}
}

func TestWriteAppModeMemoryDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ai-memory")
	if _, err := Write(dir, "MEMORY.md", "全局记忆"); err != nil {
		t.Fatalf("应用数据记忆目录（ai-memory）应放行：%v", err)
	}
}

// 同一记忆文件并发整份写：锁 + 原子替换下，最终必须是**完整**的其中一份，不能是两半。
func TestWriteConcurrentNoTornFile(t *testing.T) {
	dir := memoryDir(t)
	first := "A" + strings.Repeat("a", 4000)
	second := "B" + strings.Repeat("b", 4000)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, content := range []string{first, second} {
		wg.Add(1)
		go func(idx int, text string) {
			defer wg.Done()
			_, errs[idx] = Write(dir, "MEMORY.md", text)
		}(i, content)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 次并发写入失败：%v", i, err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); got != first && got != second {
		t.Fatalf("并发写后文件既不是 A 也不是 B（长度 %d，可能是半截）", len(got))
	}
}
