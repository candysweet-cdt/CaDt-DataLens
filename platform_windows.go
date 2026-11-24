//go:build windows

package main

// platform_windows.go：所有依赖 Wails 窗口对象 / Win32 的宿主平台 glue。
//
// 由 5 个同 build tag 的文件合并而来（2026-11-24 三期结构化）：
// windowicon_windows.go（任务栏图标 + findWailsWindow）· trayhost_windows.go（托盘图标号
// + 关机探测）· devtools_windows.go（反射打开 WebView2 DevTools）· browser_app_windows.go
// （浏览器窗口归属注入）· screenshot_app_windows.go（截图窗口归属注入）。
//
// 为什么能合并：Go 的 //go:build 是文件级的，这 5 个文件 tag 完全相同（windows），
// 合成一个不改变任何编译语义；而它们共享 appIconID / findWailsWindow 等符号，放一起
// 反而让依赖关系更清楚。非 Windows 对应实现在 platform_other.go。
//
// ⚠️ 文件名后缀必须是 _windows.go（或带 //go:build windows），否则这些 Win32 代码会
// 被编进其它平台。同理 platform_other.go 必须带 //go:build !windows。

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/applog"
	"datalens/internal/browser"
	"datalens/internal/notify"
	"datalens/internal/screenshot"
	"datalens/internal/tray"
)

// ==================== 任务栏图标 + 本进程 Wails 窗口解析（原 windowicon_windows.go） ====================

const (
	wmSetIcon = 0x0080
	iconSmall = 0
	iconBig   = 1
	imageIcon = 1 // IMAGE_ICON
	// appIconID 与 wails 的 pkg/options/windows.AppIconID 一致，即 rsrc 里的图标组编号。
	// 托盘图标（appTrayIconID）与系统通知（notify.IconID）都复用它。
	appIconID = 3
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procSetClassLongPtrW         = user32.NewProc("SetClassLongPtrW")
	procLoadImageW               = user32.NewProc("LoadImageW")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procSendMessageTimeoutW      = user32.NewProc("SendMessageTimeoutW")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
)

func init() {
	// 系统通知用的 exe 内嵌图标组编号与任务栏图标同一个。
	notify.IconID = appIconID
	// 托盘日志钩子（原 trayhost_windows.go）。
	tray.Logf = writeAppLog
	// 浏览器控件归属发起调用的窗口（原 browser_app_windows.go）。
	// FindParent 是兜底（测试 / 拿不到调用方窗口时）；绑定路径用 ParentForCall——
	// v3 一进程多窗口，不再按 Z 序找「第一个 WailsWebviewWindow」导致后台窗口的
	// 浏览器渲染到前台。
	browser.FindParent = findWailsWindow
	browser.ParentForCall = parentForCall
	// 截图目标归属发起调用的窗口（原 screenshot_app_windows.go，与浏览器同批，
	// 2026-11-21 审查第 3 项）。
	screenshot.FindParent = findWailsWindow
	screenshot.ParentForCall = parentForCall
}

// parentForCall 从绑定 ctx 取调用方窗口的原生句柄（browser / screenshot 共用）。
func parentForCall(ctx context.Context) uintptr {
	w := callerWindow(ctx)
	if w == nil {
		return 0
	}
	p := w.NativeWindow()
	if p == nil {
		return 0
	}
	return uintptr(p)
}

// applyTaskbarIconTo 给指定窗口补上 ICON_BIG（逐窗补打：v3 一进程多窗口后按
// Z 序找「第一个主窗口」会把图标补到别的窗口头上——第二主窗口的任务栏占位
// 图标不再被换掉，2026-11-21 审查第 3 项）。
// wails 只设置了 ICON_SMALL，而 Windows 11 任务栏按钮按 ICON_BIG 绘制，
// 不补会先显示系统默认的空白占位图标，几十秒后才被替换成真实图标。
func applyTaskbarIconTo(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	hinst, _, _ := procGetModuleHandleW.Call(0)
	cx, _, _ := procGetSystemMetrics.Call(11)      // SM_CXICON
	cy, _, _ := procGetSystemMetrics.Call(12)      // SM_CYICON
	cxSmall, _, _ := procGetSystemMetrics.Call(49) // SM_CXSMICON
	cySmall, _, _ := procGetSystemMetrics.Call(50) // SM_CYSMICON
	big, _, _ := procLoadImageW.Call(hinst, appIconID, imageIcon, cx, cy, 0)
	small, _, _ := procLoadImageW.Call(hinst, appIconID, imageIcon, cxSmall, cySmall, 0)
	if big != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, big)
		procSetClassLongPtrW.Call(hwnd, ^uintptr(13), big) // GCLP_HICON = -14
	}
	if small != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, small)
		procSetClassLongPtrW.Call(hwnd, ^uintptr(33), small) // GCLP_HICONSM = -34
	}
}

// showWindowWhenReady 等窗口线程从导航初始化里松手后再显示窗口。
// wails 在 webview 导航完成时就显示窗口，但此时 UI 线程还会被初始化工作占住约 1 秒，
// Explorer 查询窗口图标会超时，任务栏只能先画占位图标。等一小段再显示并补图标。
// maximised 为真时走最大化（ShowWindow(SW_MAXIMIZE) 本身就会显示窗口）。
func showWindowWhenReady(win *application.WebviewWindow, maximised bool) {
	if win == nil {
		return
	}
	// 归属句柄先解析：这个 goroutine 只补「本窗口」的图标，不按 Z 序猜。
	var hwnd uintptr
	if p := win.NativeWindow(); p != nil {
		hwnd = uintptr(p)
	}
	go func() {
		time.Sleep(windowShowDelay)
		applyTaskbarIconTo(hwnd)
		if maximised {
			// 先最大化再 Show：Show() 才会把 WebView2 控制器置可见（Maximise 是裸
			// ShowWindow，从隐藏窗口直接最大化会得到窗口可见但 WebView 隐藏的空白窗）。
			win.Maximise()
			win.Show()
		} else {
			win.Show()
		}
		// 任务栏按钮出现后再补两次，确保 Explorer 刷新到窗口图标。
		time.Sleep(60 * time.Millisecond)
		applyTaskbarIconTo(hwnd)
		time.Sleep(300 * time.Millisecond)
		applyTaskbarIconTo(hwnd)
	}()
}

// findWailsWindow 枚举本进程窗口，找 Wails 窗口类名的句柄（browser / screenshot 的兜底）。
func findWailsWindow() uintptr {
	pid := uint32(os.Getpid())
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&wpid)))
		if wpid != pid {
			return 1
		}
		var buf [64]uint16
		n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		if syscall.UTF16ToString(buf[:n]) == "WailsWebviewWindow" || syscall.UTF16ToString(buf[:n]) == "wailsWindow" {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return found
}

// ==================== 托盘接缝（原 trayhost_windows.go） ====================

// appTrayIconID 返回托盘图标用的 exe 图标组编号（与任务栏同一个）。
func appTrayIconID() uintptr { return appIconID }

// traySupported 报告当前平台能否真的挂托盘图标。
func traySupported() bool { return tray.Supported() }

var procShutdownProbe = syscall.NewLazyDLL("user32.dll").NewProc("GetSystemMetrics")

// smShuttingDown 是 GetSystemMetrics 的 SM_SHUTTINGDOWN：非 0 表示系统正在关机/重启。
const smShuttingDown = 0x2000

// systemShuttingDown 报告系统是否正在关机/重启。
// 这时点 X 不能藏进托盘——Windows 在等进程退出，藏起来就等于「关不掉」。
func systemShuttingDown() bool {
	v, _, _ := procShutdownProbe.Call(smShuttingDown)
	return v != 0
}

// ==================== 开发者工具（原 devtools_windows.go） ====================

// uiThreadInvoker 对应 winc.Form/ControlBase 的 Invoke：把函数切到窗口线程执行。
type uiThreadInvoker interface {
	Invoke(func()) bool
}

// OpenDevTools 在开发者模式下打开 WebView2 开发者工具。
// Wails v2 没有公开该能力：从启动上下文取出 windows.Frontend，
// 再通过其未导出的 chromium / mainWindow 字段调用 WebView2。
// WebView2 控制器只能在窗口线程调用，所以经 winc 的 Invoke 切线程。
// 该实现依赖当前锁定的 Wails v2.17.1 结构，字段缺失时直接报错。
func (a *App) OpenDevTools() error {
	if !applog.DevMode() {
		return fmt.Errorf("请先在设置中开启开发者模式")
	}
	if a.ctx == nil {
		return fmt.Errorf("应用尚未启动")
	}
	frontend := a.ctx.Value("frontend")
	if frontend == nil {
		return fmt.Errorf("无法访问界面实例")
	}
	value := reflect.ValueOf(frontend).Elem()
	if !value.IsValid() {
		return fmt.Errorf("界面实例不可用")
	}
	chromiumField := value.FieldByName("chromium")
	windowField := value.FieldByName("mainWindow")
	if !chromiumField.IsValid() || chromiumField.IsNil() ||
		!windowField.IsValid() || windowField.IsNil() {
		return fmt.Errorf("当前 Wails 版本不支持打开开发者工具")
	}
	chromium := (*edge.Chromium)(chromiumField.UnsafePointer())
	window := reflect.NewAt(windowField.Type(), unsafe.Pointer(windowField.UnsafeAddr())).Elem()
	invoker, ok := window.Interface().(uiThreadInvoker)
	if !ok {
		return fmt.Errorf("当前 Wails 版本不支持打开开发者工具")
	}
	if !invoker.Invoke(func() {
		chromium.OpenDevToolsWindow()
		writeAppLog("info", "已打开开发者工具")
	}) {
		return fmt.Errorf("无法切换回界面线程")
	}
	return nil
}
