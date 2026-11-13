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

// createShotTestWindow 建一个 320x200 的隐藏测试窗口（类只注册一次，重复调用忽略）。
func createShotTestWindow(t *testing.T) uintptr {
	t.Helper()
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
	procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc)))
	hwnd, _, _ := procBrowserCreateWindowEx.Call(
		0, uintptr(unsafe.Pointer(clsPtr)), 0, 0x80000000,
		0, 0, 320, 200, 0, 0, hinst, 0)
	if hwnd == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(hwnd, 4)
	return hwnd
}

// TestShotCaptureWindowPNG 截图一个真实窗口，校验输出是 PNG 且尺寸合理。
func TestShotCaptureWindowPNG(t *testing.T) {
	hwnd := createShotTestWindow(t)
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

// TestShotCaptureWindowRegionPNG 区域截图只输出指定矩形大小。
func TestShotCaptureWindowRegionPNG(t *testing.T) {
	hwnd := createShotTestWindow(t)
	defer procBrowserDestroyWindow.Call(hwnd)

	encoded, err := shotCaptureWindowRegionPNG(hwnd, 40, 30, 120, 80)
	if err != nil {
		t.Fatalf("区域截图失败：%v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("base64 解码失败：%v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("PNG 解析失败：%v", err)
	}
	if cfg.Width != 120 || cfg.Height != 80 {
		t.Fatalf("区域尺寸 = %dx%d，期望 120x80", cfg.Width, cfg.Height)
	}
}

func TestShotClampRect(t *testing.T) {
	cases := []struct {
		name                   string
		x, y, w, h, maxW, maxH int
		wx, wy, ww, wh         int
		wantErr                bool
	}{
		{"正常", 10, 20, 100, 50, 800, 600, 10, 20, 100, 50, false},
		{"右下越界", 700, 550, 200, 100, 800, 600, 700, 550, 100, 50, false},
		{"左上负值", -10, -20, 100, 50, 800, 600, 0, 0, 90, 30, false},
		{"完全越界", 900, 700, 100, 50, 800, 600, 0, 0, 0, 0, true},
		{"零尺寸", 10, 10, 0, 50, 800, 600, 0, 0, 0, 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x, y, w, h, err := shotClampRect(c.x, c.y, c.w, c.h, c.maxW, c.maxH)
			if c.wantErr {
				if err == nil {
					t.Fatal("期望报错，实际通过")
				}
				return
			}
			if err != nil {
				t.Fatalf("意外报错：%v", err)
			}
			if x != c.wx || y != c.wy || w != c.ww || h != c.wh {
				t.Fatalf("得到 (%d,%d,%d,%d)，期望 (%d,%d,%d,%d)", x, y, w, h, c.wx, c.wy, c.ww, c.wh)
			}
		})
	}
}

// TestShotCaptureAppWindowWithoutWindow 找不到主窗口时应给出明确错误。
func TestShotCaptureAppWindowWithoutWindow(t *testing.T) {
	if _, err := shotCaptureWindowPNG(0); err == nil {
		t.Fatal("hwnd=0 应该报错")
	}
}
