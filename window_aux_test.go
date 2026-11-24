package main

// window_aux_test.go：辅助窗口绑定里不需要建窗的路径（原 terminal_window_test.go，
// 随 terminal_window.go 合并进 window_aux.go 后归到这里）。

import "testing"

// PopOutTerminal 的参数校验（不建窗的路径）：空 id / 不存在的会话都要报错，
// 不能悄悄创建一个空窗口。会话存在与否经进程级终端表（TermList）判定。
func TestPopOutTerminalValidation(t *testing.T) {
	app := &App{}
	if err := app.PopOutTerminal(nil, "   "); err == nil {
		t.Fatal("空 id 应报错")
	}
	if err := app.PopOutTerminal(nil, "no-such-term"); err == nil {
		t.Fatal("不存在的会话应报错")
	}
}

// GetStartupTermID：非终端窗口（含无窗口上下文回退主窗口）一律空串。
func TestGetStartupTermIDDefaultsEmpty(t *testing.T) {
	app := &App{}
	if got := app.GetStartupTermID(nil); got != "" {
		t.Fatalf("GetStartupTermID(nil) = %q, want empty", got)
	}
}

// GetAuxWindowKind：无窗口上下文时回退主窗口，非辅助窗返回空串。
func TestGetAuxWindowKindDefaultsEmpty(t *testing.T) {
	app := &App{}
	if got := app.GetAuxWindowKind(nil); got != "" {
		t.Fatalf("GetAuxWindowKind(nil) = %q, want empty", got)
	}
}
