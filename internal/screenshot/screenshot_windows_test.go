//go:build windows

package screenshot

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"strings"
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

// TestShotGuardTurnsPanicIntoError 截图链路 panic 必须变成错误（绑定 goroutine 没有上层 recover）。
func TestShotGuardTurnsPanicIntoError(t *testing.T) {
	out, err := shotGuard(func() (string, error) { panic("模拟原生调用崩溃") })
	if err == nil {
		t.Fatal("panic 应转成错误")
	}
	if out != "" {
		t.Fatalf("panic 时不应返回值：%q", out)
	}
	msg := err.Error()
	for _, want := range []string{"截图异常", "模拟原生调用崩溃", "goroutine"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("错误信息缺少 %q：\n%s", want, msg)
		}
	}
	// 正常路径原样透传。
	got, err := shotGuard(func() (string, error) { return "ok", nil })
	if err != nil || got != "ok" {
		t.Fatalf("正常路径被改动：%q %v", got, err)
	}
}

// TestShotCaptureAppWindowWithoutWindow 找不到主窗口时应给出明确错误。
func TestShotCaptureAppWindowWithoutWindow(t *testing.T) {
	if _, err := shotCaptureWindowPNG(0); err == nil {
		t.Fatal("hwnd=0 应该报错")
	}
}

// TestShotNewSurfaceRejectsInvalidSize 尺寸/面积防线：0、负数、超上限都必须在建位图之前
// 报错——否则 readBGRA 会拿 w*h*4 去 make（OOM 是 runtime fatal error，救不回来）。
func TestShotNewSurfaceRejectsInvalidSize(t *testing.T) {
	screen, _, _ := procShotGetDC.Call(0)
	if screen == 0 {
		t.Skip("拿不到屏幕 DC")
	}
	defer procShotReleaseDC.Call(0, screen)

	cases := []struct {
		name string
		w, h int
	}{
		{"宽为 0", 0, 100},
		{"高为 0", 100, 0},
		{"负数", -1, 10},
		{"面积超限", 9000, 9000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if s, err := shotNewSurface(screen, c.w, c.h); err == nil {
				s.close()
				t.Fatalf("%dx%d 应报错", c.w, c.h)
			}
		})
	}

	// 边界内的正常尺寸仍应成功（别把防线写成了封死）。
	s, err := shotNewSurface(screen, 64, 32)
	if err != nil {
		t.Fatalf("64x32 应成功：%v", err)
	}
	s.close()
}

// TestShotReadBGRARejectsZeroSize 手搓的坏 surface 也不能让 &buf[0] 炸在 readBGRA 里。
func TestShotReadBGRARejectsZeroSize(t *testing.T) {
	for _, s := range []*shotSurface{{w: 0, h: 10}, {w: 10, h: 0}, {w: 0, h: 0}} {
		if _, err := s.readBGRA(); err == nil {
			t.Fatalf("%dx%d 应报错", s.w, s.h)
		}
	}
}

// TestShotEncodePNGRejectsSizeMismatch 缓冲区与尺寸不匹配会越界 panic，必须转成错误。
func TestShotEncodePNGRejectsSizeMismatch(t *testing.T) {
	cases := []struct {
		name string
		bgra []byte
		w, h int
	}{
		{"缓冲区过小", make([]byte, 15), 2, 2},
		{"缓冲区过大", make([]byte, 17), 2, 2},
		{"零尺寸", nil, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := shotEncodePNG(c.bgra, c.w, c.h); err == nil {
				t.Fatal("应报错")
			}
		})
	}
	if _, err := shotEncodePNG(make([]byte, 16), 2, 2); err != nil {
		t.Fatalf("2x2 正常输入应成功：%v", err)
	}
}
