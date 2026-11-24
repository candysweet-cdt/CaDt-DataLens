// Package notify 系统通知（Windows Toast + 任务栏提醒）。
package notify

// Notifier 通知引擎（无状态）。
type Notifier struct{}

// 宿主注入（main/notify_app_windows.go 接线）。
var (
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
	// IconID 是 exe 内嵌图标组编号（根 platform_windows.go 的 appIconID）。
	IconID uintptr
	// OnToastActivation 在用户点击本应用的系统通知时被调用（Windows COM 激活回调，
	// payload 是发通知时随 NotifySystemToast 传入的激活参数原文，如 "ai-session=<id>"）。
	// 宿主负责把窗口拉回前台并分发给前端。只在 Windows 且进程内注册过激活器时有意义。
	OnToastActivation func(payload string)
)

// logf 转发到宿主注入的 Logf；未注入（测试或非 Windows 平台）时静默丢弃。
func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
