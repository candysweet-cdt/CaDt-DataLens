//go:build windows

package main

import (
	"context"
	"os"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	wmSetIcon = 0x0080
	iconSmall = 0
	iconBig   = 1
	imageIcon = 1 // IMAGE_ICON
	appIconID = 3 // 与 wails 的 pkg/options/windows.AppIconID 一致，即 rsrc 里的图标组编号
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

// windowResponsive 用 WM_NULL + 短超时探测窗口线程是否还能及时处理消息。
func windowResponsive(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	var result uintptr
	r, _, _ := procSendMessageTimeoutW.Call(hwnd, 0, 0, 0, 0x0002, 50, uintptr(unsafe.Pointer(&result)))
	return r != 0
}

// applyTaskbarIcon 给主窗口补上 ICON_BIG。
// wails 只设置了 ICON_SMALL，而 Windows 11 任务栏按钮按 ICON_BIG 绘制，
// 不补会先显示系统默认的空白占位图标，几十秒后才被替换成真实图标。
func applyTaskbarIcon() {
	hwnd := findWailsWindow()
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

// showWindowWhenReady 等窗口线程空闲后再显示窗口。
// wails 在 webview 导航完成时就显示窗口，但此时 UI 线程还会被初始化工作占住约 1 秒，
// Explorer 查询窗口图标会超时，任务栏只能先画占位图标。等线程可响应消息再显示，
// 任务栏按钮一出现就能拿到真实图标。
func showWindowWhenReady(ctx context.Context) {
	hwnd := findWailsWindow()
	go func() {
		for i := 0; i < 500; i++ { // 最多等 10 秒
			if windowResponsive(hwnd) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		applyTaskbarIcon()
		runtime.WindowShow(ctx)
		// 任务栏按钮出现后再补两次，确保 Explorer 刷新到窗口图标。
		time.Sleep(60 * time.Millisecond)
		applyTaskbarIcon()
		time.Sleep(300 * time.Millisecond)
		applyTaskbarIcon()
	}()
}

// ensureWindowShown 兜底：页面迟迟没有就绪时也要把窗口显示出来。
func ensureWindowShown(ctx context.Context) {
	go func() {
		time.Sleep(8 * time.Second)
		hwnd := findWailsWindow()
		if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
			runtime.WindowShow(ctx)
		}
	}()
}

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
		if syscall.UTF16ToString(buf[:n]) == "wailsWindow" {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return found
}
