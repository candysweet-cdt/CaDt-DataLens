package main

// window_aux.go：辅助窗口的绑定与打开动作（终端弹出窗 / AI 浮窗 / 全局热键）。
//
// 三个来源合并而来（原 terminal_window.go / ai_float.go / global_hotkey.go），
// 共同点：都是「把某个已有资源换成独立窗口渲染」以及「窗口归属判定」，
// 且都只是打开动作与启动上下文，不含窗口创建逻辑（在 window_factory.go）。
// 便签 / 监控 / 对比 / 轻量查看 / 实时预览五类辅助窗的绑定在 window_aux_bindings.go。

import (
	"context"
	"fmt"
	"strings"

	"datalens/internal/launchargs"
)

// ---- 终端独立窗口 ----

// PopOutTerminal 把终端会话弹出为独立窗口。调用方窗口记为来源（Origin）：
// 弹出窗口关闭时会话交还给它。已退出的会话没有弹出价值，直接报错。
//
// ConPTY 会话留在进程内（internal/terminal），弹窗只是换一个窗口渲染；
// 事件归属在窗口装载时经 RegisterEventOwner 切到新窗口，关窗时经
// term-popout-closed 交还原窗口（见 window_factory.go）。
func (a *App) PopOutTerminal(ctx context.Context, termID string) error {
	termID = strings.TrimSpace(termID)
	if termID == "" {
		return fmt.Errorf("缺少终端 id")
	}
	for _, info := range a.TermList() {
		if info.ID == termID {
			if info.Exited {
				return fmt.Errorf("终端已退出")
			}
			a.ensureTerminalWindow(termID, callerWindowName(ctx))
			return nil
		}
	}
	return fmt.Errorf("终端会话不存在：%s", termID)
}

// IsTerminalWindow 当前调用窗口是否是终端独立窗口。
func (a *App) IsTerminalWindow(ctx context.Context) bool {
	st := stateForCaller(ctx)
	return st != nil && st.Startup().Mode == windowModeTerminal
}

// GetStartupTermID 终端独立窗口的启动会话 id；其他窗口返回空串。
func (a *App) GetStartupTermID(ctx context.Context) string {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModeTerminal {
		return ""
	}
	return st.Startup().TermID
}

// ---- AI 浮窗 ----

// IsAIFloatWindow 当前调用窗口是不是 AI 悬浮窗；无窗口上下文时看首个窗口形态。
func (a *App) IsAIFloatWindow(ctx context.Context) bool {
	st := stateForCaller(ctx)
	return st != nil && st.Startup().Mode == windowModeFloat
}

// OpenAIFloatWindow 打开（或聚焦）AI 浮窗；root 非空时把该工作区作为打开目标。
// P2 起浮窗是同一进程里的独立窗口（不再是独立进程），窗口名固定 float。
func (a *App) OpenAIFloatWindow(root string) error {
	root = strings.TrimSpace(root)
	var targets []launchargs.OpenTarget
	if root != "" {
		targets = []launchargs.OpenTarget{{Path: root}}
	}
	a.ensureFloatWindow(targets...)
	return nil
}

// OpenSettingsInMainWindow 请求主窗口打开设置页（悬浮窗使用）。
// 无主窗口（浮窗单独运行）时回退发到浮窗自身——设置对话框在浮窗形态可见
// （与 v2 的单实例转发等价，审查 P2-1）；前端 flash 文案由调用窗口自己出。
func (a *App) OpenSettingsInMainWindow(pane string) error {
	if strings.TrimSpace(pane) == "" {
		pane = "models"
	}
	st := winReg.Primary()
	if st == nil {
		st = winReg.Get("float")
	}
	if st == nil {
		return nil
	}
	emitWindowEventTo(st.Window(), "app-open-settings", pane)
	activateWindow(st.Window())
	return nil
}

// ---- 全局热键 ----

// registerGlobalHotkeys 注册全局热键（v3 GlobalShortcutManager，Windows 走 RegisterHotKey）。
// Run 之前注册的项由 v3 排队，消息循环起来后生效；组合键被其他程序占用时 Register
// 报错，只记日志不重试。退出时 v3 的 cleanup 会 UnregisterAll，无需手动摘除。
//
// 固定键位、无设置开关：组合键冲突时由 Register 报错兜底（用户改用托盘/任务栏入口）。
func (a *App) registerGlobalHotkeys() {
	if wailsApp == nil || wailsApp.GlobalShortcut == nil {
		return
	}
	hotkeys := []struct {
		accel string
		desc  string
		fn    func()
	}{
		{"Ctrl+Alt+A", "AI 浮窗", func() { a.ensureFloatWindow() }},
		{"Ctrl+Alt+T", "主窗口终端面板", a.focusPrimaryTerminal},
		{"Ctrl+Alt+D", "调试控制台", func() { a.ensureDebugWindow() }},
	}
	for _, hk := range hotkeys {
		if err := wailsApp.GlobalShortcut.Register(hk.accel, hk.fn); err != nil {
			writeAppLog("warn", "全局热键注册失败 %s（%s）：%v", hk.accel, hk.desc, err)
			continue
		}
		writeAppLog("info", "全局热键：%s → %s", hk.accel, hk.desc)
	}
}

// focusPrimaryTerminal 把主窗口带到前台并打开终端面板；没有主窗口（浮窗/终端独立
// 窗口单独运行）时退化为开一个主窗口——热键语义是「给我一个能干活的终端」。
func (a *App) focusPrimaryTerminal() {
	st := winReg.Primary()
	if st == nil {
		a.openMainWindow(windowSpec{})
		return
	}
	activateWindow(st.Window())
	emitWindowEventTo(st.Window(), "app-open-terminal", nil)
}
