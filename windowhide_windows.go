//go:build windows

package main

// windowhide_windows.go：退出收尾时把窗口从屏幕上摘掉的平台实现。
//
// 为什么不用 Wails 的 WebviewWindow.Hide()：它内部是 InvokeSync（派发到主线程并
// 等待返回），而 WindowClosing 钩子跑在 v3 的事件 goroutine 上——主线程那一刻若正卡
// 在 windowEvents（容量 5）的发送里，就成了「事件 goroutine 等主线程、主线程等事件
// goroutine」的互锁，表现是关不掉、只能结束进程。ShowWindowAsync 只投递不等待，主线程
// 下一轮消息循环处理即可；最坏情况是没来得及藏（退化成改动前的表现），不会锁死。

import (
	"syscall"
	"unsafe"
)

var procHideShowWindowAsync = syscall.NewLazyDLL("user32.dll").NewProc("ShowWindowAsync")

// swHide 对应 Win32 SW_HIDE。
const swHide = 0

// hideNativeWindowAsync 异步隐藏原生窗口；hwnd 来自 WebviewWindow.NativeWindow()。
func hideNativeWindowAsync(hwnd unsafe.Pointer) {
	if hwnd == nil {
		return
	}
	_, _, _ = procHideShowWindowAsync.Call(uintptr(hwnd), swHide)
}
