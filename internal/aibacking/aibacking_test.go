package aibacking

// aibacking_test.go：会话沙盒的校验面与幂等面。
//
// 守三件事：① 会话 id 是路径片段，非法 id 必须全拒（穿越漏洞）；② 重复调用幂等
// （目录已存在不报错）；③ 礼仪 AGENTS.md 只写一次，用户改过不被覆盖。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceAtRejectsBadSessionID(t *testing.T) {
	root := t.TempDir()
	bad := []string{
		"", " ", "../x", "a/b", `a\b`, "C:", "C:\\x", ".", "..", ".hidden",
		"CON", "a b", "a:b", "会话/一", strings.Repeat("x", 200),
	}
	for _, id := range bad {
		if _, err := WorkspaceAt(root, id); err == nil {
			t.Fatalf("会话 id %q 应被拒绝", id)
		}
	}
	// 一个都不该建出来
	if _, err := os.Stat(filepath.Join(root, DirName)); !os.IsNotExist(err) {
		t.Fatalf("被拒绝的 id 不该建出沙盒根：%v", err)
	}
}

func TestWorkspaceAtNeedsAppDataRoot(t *testing.T) {
	if _, err := WorkspaceAt("", "session-1"); err == nil {
		t.Fatal("应用数据根为空时应报错")
	}
}

func TestWorkspaceAtCreatesUnderRoot(t *testing.T) {
	root := t.TempDir()
	dir, err := WorkspaceAt(root, "session-abc123")
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if want := filepath.Join(root, DirName, "session-abc123"); dir != want {
		t.Fatalf("路径 = %q，want %q", dir, want)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("沙盒目录不存在：%v", err)
	}
	// 礼仪文件已就位，且内容不是空的
	welcome, err := os.ReadFile(filepath.Join(dir, WelcomeName))
	if err != nil {
		t.Fatalf("礼仪文件缺失：%v", err)
	}
	if !strings.Contains(string(welcome), "沙盒") || len(welcome) < 50 {
		t.Fatalf("礼仪文件内容异常：%q", string(welcome))
	}
	// 沙盒在应用数据根下，不在别处
	if !strings.HasPrefix(dir, root) {
		t.Fatalf("沙盒不在应用数据根下：%q", dir)
	}
}

func TestWorkspaceAtIdempotentAndRespectsUserEdits(t *testing.T) {
	root := t.TempDir()
	first, err := WorkspaceAt(root, "session-idem")
	if err != nil {
		t.Fatal(err)
	}
	// 用户改过礼仪文件：再次调用不得覆盖
	edited := "# 我自己改过的说明\n"
	welcomePath := filepath.Join(first, WelcomeName)
	if err := os.WriteFile(welcomePath, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	second, err := WorkspaceAt(root, "session-idem")
	if err != nil {
		t.Fatalf("重复调用应幂等：%v", err)
	}
	if second != first {
		t.Fatalf("重复调用路径变了：%q vs %q", second, first)
	}
	raw, err := os.ReadFile(welcomePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != edited {
		t.Fatalf("礼仪文件被覆盖了：%q", string(raw))
	}
}

// 沙盒目录是该会话独占的：两个 id 不共享目录，同一个 id 也不会被别处的调用污染。
func TestWorkspaceAtIsolatesSessions(t *testing.T) {
	root := t.TempDir()
	a, err := WorkspaceAt(root, "session-a")
	if err != nil {
		t.Fatal(err)
	}
	b, err := WorkspaceAt(root, "session-b")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("不同会话共用了同一个沙盒：%q", a)
	}
}
