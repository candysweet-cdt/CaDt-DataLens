package windowreg

// windowreg_test.go：辅助窗查找与入参归一化（原根目录 aux_windows_test.go 迁入）。
// 窗口句柄用 struct{} 占位——这些逻辑只读 Spec，不碰宿主窗口对象。

import "testing"

func TestNormalizeAuxWindowInputs(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"workspace", "workspace", "workspace"},
		{"workspace 带空格", " workspace ", "workspace"},
		{"global", "global", "global"},
		{"未知回落 global", "float", "global"},
		{"空回落 global", "", "global"},
	}
	for _, c := range cases {
		if got := NormalizeMemoScope(c.in); got != c.want {
			t.Errorf("%s: NormalizeMemoScope(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
	kinds := []struct {
		in, want string
	}{
		{"session", "session"},
		{"group", "group"},
		{" Group ", "group"},
		{"其他", "session"},
		{"", "session"},
	}
	for _, c := range kinds {
		if got := NormalizeSessionKind(c.in); got != c.want {
			t.Errorf("NormalizeSessionKind(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFindAuxWindows(t *testing.T) {
	reg := New[struct{}]()
	cleanup := func() {
		for _, st := range reg.List() {
			reg.Remove(st.Name())
		}
	}
	defer cleanup()

	// 注册表为空：三类查找都落空
	if reg.FindMemo("workspace", "D:/ws") != nil {
		t.Fatal("空注册表不该找到便签窗")
	}
	if reg.FindMonitor("s1") != nil {
		t.Fatal("空注册表不该找到监控窗")
	}
	if reg.FindDiff("a", "b") != nil {
		t.Fatal("空注册表不该找到对比窗")
	}

	reg.Add(Spec{Name: "memo", Mode: ModeMemo, MemoScope: "workspace", Workspace: "D:/ws"})
	reg.Add(Spec{Name: "monitor", Mode: ModeMonitor, SessionID: "s1", SessionKind: "session"})
	reg.Add(Spec{Name: "diff", Mode: ModeDiff, DiffLeft: "a", DiffRight: "b"})
	// 干扰项：主窗口 + 其他形态，不该被误命中
	reg.Add(Spec{Name: "main", Mode: ModeMain, Workspace: "D:/ws"})

	if st := reg.FindMemo("workspace", "D:/ws"); st == nil || st.Name() != "memo" {
		t.Fatalf("FindMemo 命中错误：%v", st)
	}
	if st := reg.FindMemo("workspace", "D:/other"); st != nil {
		t.Fatalf("不同工作区不该命中便签窗：%v", st)
	}
	if st := reg.FindMemo("global", ""); st != nil {
		t.Fatalf("不同作用域不该命中便签窗：%v", st)
	}
	if st := reg.FindMonitor(" s1 "); st == nil || st.Name() != "monitor" {
		t.Fatalf("FindMonitor 应容忍空白（实际裁剪）：%v", st)
	}
	if st := reg.FindMonitor("s2"); st != nil {
		t.Fatalf("不同会话不该命中监控窗：%v", st)
	}
	if st := reg.FindDiff("a", "b"); st == nil || st.Name() != "diff" {
		t.Fatalf("FindDiff 命中错误：%v", st)
	}
	if st := reg.FindDiff("b", "a"); st != nil {
		t.Fatalf("路径对调不该命中同一对比窗：%v", st)
	}
}

func TestFindLightAndPreviewWindows(t *testing.T) {
	reg := New[struct{}]()
	cleanup := func() {
		for _, st := range reg.List() {
			reg.Remove(st.Name())
		}
	}
	defer cleanup()

	if reg.FindLight("D:/a.md") != nil {
		t.Fatal("空注册表不该找到轻量查看窗")
	}
	if reg.FindPreview("D:/a.md") != nil {
		t.Fatal("空注册表不该找到预览窗")
	}

	reg.Add(Spec{Name: "light", Mode: ModeLight, LightPath: "D:/a.md"})
	reg.Add(Spec{Name: "preview", Mode: ModePreview, PreviewPath: "D:/a.md", Origin: "main"})
	reg.Add(Spec{Name: "main", Mode: ModeMain, Workspace: "D:/ws"})

	if st := reg.FindLight(" D:/a.md "); st == nil || st.Name() != "light" {
		t.Fatalf("FindLight 应容忍空白（实际裁剪）：%v", st)
	}
	if st := reg.FindLight("D:/b.md"); st != nil {
		t.Fatalf("不同文件不该命中轻量查看窗：%v", st)
	}
	if st := reg.FindPreview("D:/a.md"); st == nil || st.Name() != "preview" {
		t.Fatalf("FindPreview 命中错误：%v", st)
	}
	if st := reg.FindPreview("D:/b.html"); st != nil {
		t.Fatalf("不同源文件不该命中预览窗：%v", st)
	}
}

// TestRegistryBasics 覆盖注册表本身：命名策略、主窗选择、计数与聚合标记。
func TestRegistryBasics(t *testing.T) {
	reg := New[struct{}]()
	if got := reg.NextName(ModeMain); got != "main" {
		t.Fatalf("首个主窗口名 = %q，want main", got)
	}
	first := reg.Add(Spec{Name: "main", Mode: ModeMain})
	if got := reg.NextName(ModeMain); got != "main-2" {
		t.Fatalf("第二个主窗口名 = %q，want main-2", got)
	}
	reg.Add(Spec{Name: "main-2", Mode: ModeMain})
	if got := reg.CountMain(); got != 2 {
		t.Fatalf("CountMain = %d，want 2", got)
	}
	if got := reg.CountMode(ModeFloat); got != 0 {
		t.Fatalf("CountMode(float) = %d，want 0", got)
	}
	if got := reg.Count(); got != 2 {
		t.Fatalf("Count = %d，want 2", got)
	}
	// main 优先于名字序更早的窗口
	if p := reg.Primary(); p != first {
		t.Fatalf("Primary 应返回 main，实际 %v", p)
	}
	if reg.AnyDirty() || reg.AnyAIRunning() {
		t.Fatal("新窗口不该带脏标记或 AI 回合标记")
	}
	first.SetDirty(true)
	if !reg.AnyDirty() {
		t.Fatal("AnyDirty 应汇总到窗口级标记")
	}
	reg.Remove("main")
	if got := reg.CountMain(); got != 1 {
		t.Fatalf("移除后 CountMain = %d，want 1", got)
	}
	if p := reg.Primary(); p == nil || p.Name() != "main-2" {
		t.Fatalf("main 移除后 Primary 应回落到 main-2，实际 %v", p)
	}
}

func TestFindByWorkspace(t *testing.T) {
	reg := New[struct{}]()
	ws := `D:\Work\Repo`
	main := reg.Add(Spec{Name: "main", Mode: ModeMain})
	main.SetWorkspace(ws)
	// 辅助窗开着同一工作区，也不能被当成复用目标
	reg.Add(Spec{Name: "memo", Mode: ModeMemo, Workspace: ws})

	if st := reg.FindByWorkspace(`d:/work/repo/`, ""); st != main {
		t.Fatalf("路径归一后应命中主窗口，实际 %v", st)
	}
	if st := reg.FindByWorkspace(ws, "main"); st != nil {
		t.Fatalf("exclude 生效时不该命中调用方窗口自己，实际 %v", st)
	}
	if st := reg.FindByWorkspace("", ""); st != nil {
		t.Fatalf("空工作区不该命中任何窗口，实际 %v", st)
	}
}

func TestPathKey(t *testing.T) {
	cases := []struct{ in, want string }{
		{`D:\Work\Repo`, "d:/work/repo"},
		{"D:/Work/Repo/", "d:/work/repo"},
		{"d:/work/repo", "d:/work/repo"},
		{"", ""},
		{`C:\`, "c:"},
	}
	for _, c := range cases {
		if got := PathKey(c.in); got != c.want {
			t.Errorf("PathKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
