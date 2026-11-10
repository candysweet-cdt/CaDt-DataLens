//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"

	toast "git.sr.ht/~jackmordaunt/go-toast/v2"
)

var (
	notifyUser32                 = syscall.NewLazyDLL("user32.dll")
	procNotifyEnumWindows        = notifyUser32.NewProc("EnumWindows")
	procNotifyGetWindowThreadPID = notifyUser32.NewProc("GetWindowThreadProcessId")
	procNotifyIsWindowVisible    = notifyUser32.NewProc("IsWindowVisible")
	procNotifyFlashWindowEx      = notifyUser32.NewProc("FlashWindowEx")
	procNotifyMessageBeep        = notifyUser32.NewProc("MessageBeep")
)

type flashWindowInfo struct {
	cbSize    uint32
	hwnd      uintptr
	dwFlags   uint32
	uCount    uint32
	dwTimeout uint32
}

// NotifyAttention 让当前进程的任务栏图标闪烁（窗口已聚焦时基本无感），可选播放系统提示音。
func (a *App) NotifyAttention(beep bool) {
	pid := uint32(os.Getpid())
	var target uintptr
	callback := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
		var windowPID uint32
		procNotifyGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&windowPID)))
		if windowPID != pid {
			return 1
		}
		visible, _, _ := procNotifyIsWindowVisible.Call(hwnd)
		if visible == 0 {
			return 1
		}
		target = hwnd
		return 0
	})
	procNotifyEnumWindows.Call(callback, 0)
	if target != 0 {
		info := flashWindowInfo{
			cbSize:  uint32(unsafe.Sizeof(flashWindowInfo{})),
			hwnd:    target,
			dwFlags: 0x00000003 | 0x0000000C, // FLASHW_ALL | FLASHW_TIMERNOFG
			uCount:  3,
		}
		procNotifyFlashWindowEx.Call(uintptr(unsafe.Pointer(&info)))
	}
	if beep {
		procNotifyMessageBeep.Call(0xFFFFFFFF)
	}
}

// NotifySystemToast 发送 Windows 系统级 Toast 通知；silent=true 时不播放系统提示音。
func (a *App) NotifySystemToast(title string, body string, silent bool) error {
	title = strings.TrimSpace(title)
	body = strings.TrimSpace(body)
	if title == "" {
		title = "CaDt-DataLens"
	}
	n := toast.Notification{
		AppID: "CaDt-DataLens",
		Title: title,
		Body:  body,
	}
	if silent {
		n.Audio = toast.Silent
	} else {
		n.Audio = toast.Default
	}
	if err := n.Push(); err != nil {
		return fmt.Errorf("系统通知失败：%w", err)
	}
	return nil
}
