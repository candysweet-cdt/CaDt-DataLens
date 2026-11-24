// Package tray：Windows 通知区域（系统托盘）图标。
//
// 只做「关闭窗口时最小化到后台」需要的那点事：一个隐藏的消息窗口、一个图标、
// 一个右键菜单（显示主窗口 / 退出）。全部走 user32 / shell32 的 syscall，
// 不引第三方库——项目取向是「单 exe、零依赖、系统提供引擎」。
//
// 平台差异由构建标签切：Windows 有真实实现，其它平台是空桩（Supported() == false），
// 宿主据此决定要不要把「最小化到托盘」这条路走通。
package tray

// Logf 是宿主注入的日志钩子（可为空）。
var Logf func(level string, format string, args ...any)

// Options 是托盘的构造参数。
type Options struct {
	// IconID 是 exe 内嵌图标组编号（见根目录 platform_windows.go 的 appIconID）。
	IconID uintptr
	// Tooltip 是悬停提示（超长自动截断）。
	Tooltip string
	// OnShow 是「左键单击 / 双击图标」与「右键菜单 → 显示主窗口」的回调。
	OnShow func()
	// OnQuit 是「右键菜单 → 退出」的回调。
	OnQuit func()
}

func logf(level string, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
