//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"syscall"
	"testing"
	"unsafe"
)

// TestShotCaptureWindowPNG 截图一个真实窗口，校验输出是 PNG 且尺寸合理。
func TestShotCaptureWindowPNG(t *testing.T) {
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	clsPtr, _ := syscall.UTF16PtrFromString("CaDtShotTestWnd")
	var wc struct {
		cbSize, style               uint32
		lpfnWndProc                 uintptr
		cbClsExtra, cbWndExtra      int32
		hInstance, hIcon, hCursor   uintptr
		hbrBackground, lpszMenuName uintptr
		lpszClassName, hIconSm      uintptr
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	wc.lpfnWndProc = procBrowserDefWindowProcW.Addr()
	wc.hInstance = hinst
	wc.lpszClassName = uintptr(unsafe.Pointer(clsPtr))
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		t.Fatal("注册测试窗口类失败")
	}
	hwnd, _, _ := procBrowserCreateWindowEx.Call(
		0, uintptr(unsafe.Pointer(clsPtr)), 0, 0x80000000,
		0, 0, 320, 200, 0, 0, hinst, 0)
	if hwnd == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(hwnd, 4)
	defer procBrowserDestroyWindow.Call(hwnd)

	encoded, err := shotCaptureWindowPNG(hwnd)
	if err != nil {
		t.Fatalf("截图失败：%v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("base64 解码失败：%v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("PNG 解析失败：%v", err)
	}
	if cfg.Width < 100 || cfg.Height < 100 {
		t.Fatalf("PNG 尺寸异常：%dx%d", cfg.Width, cfg.Height)
	}
}

// TestShotCaptureAppWindowWithoutWindow 找不到主窗口时应给出明确错误。
func TestShotCaptureAppWindowWithoutWindow(t *testing.T) {
	if _, err := shotCaptureWindowPNG(0); err == nil {
		t.Fatal("hwnd=0 应该报错")
	}
}
