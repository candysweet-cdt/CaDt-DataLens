package main

// window_route_test.go：routeWindowForPath（文件 → 归属工作区窗口）的专项测试。
// 决策层的表驱动测试已随 internal/secondinstance 迁走，这里只剩依赖 winReg 的
// 真实注册表路由语义。

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRouteWindowForPath(t *testing.T) {
	// winReg 夹具用真实临时目录：main=root，main-2=root\sub（嵌套工作区）；
	// 同工作区的浮窗不参与路由（FindByWorkspace 只认 main 模式）。
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	winReg.Add(windowSpec{Name: "main", Mode: windowModeMain, Workspace: root})
	winReg.Add(windowSpec{Name: "main-2", Mode: windowModeMain, Workspace: sub})
	winReg.Add(windowSpec{Name: "float", Mode: windowModeFloat, Workspace: root})
	t.Cleanup(func() {
		winReg.Remove("main")
		winReg.Remove("main-2")
		winReg.Remove("float")
	})
	inside := filepath.Join(sub, "x.json")
	top := filepath.Join(root, "other.json")
	for _, f := range []string{inside, top} {
		if err := os.WriteFile(f, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		path string
		want string
	}{
		{inside, "main-2"}, // 祖先链最深命中（内层窗口拿子目录文件）
		{top, "main"},      // 外层工作区
		{sub, ""},          // 存在的目录目标不路由（主窗口组）
		{root, ""},         // 工作区根本身（目录）不路由
		{filepath.Join(sub, "missing.json"), "main-2"}, // 不存在按文件：从所在目录起爬
		{filepath.Join(root, "missing.json"), "main"},
		{filepath.Join(root, "subX", "a.json"), "main"}, // 兄弟目录不误命中（精确相等口径）
		{"a.json", ""},    // 相对路径无归属
		{`C:\a.json`, ""}, // 盘根终止：c: → c:. 链路收敛（审查 P3-6）
	}
	for _, tc := range cases {
		if got := routeWindowForPath(tc.path); got != tc.want {
			t.Errorf("routeWindowForPath(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}
