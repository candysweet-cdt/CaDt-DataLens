//go:build windows

package main

// 应用窗口截图：PrintWindow(PW_RENDERFULLCONTENT) 抓主窗口（含 WebView2 的
// DirectComposition 内容），失败时退回窗口 DC + BitBlt。输出 PNG base64，
// 超过前端图片上限时按 0.7 逐级缩小重编码。

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"syscall"
	"unsafe"
)

const (
	shotRenderFullContent = 2
	shotSrcCopy           = 0x00CC0020
	shotHalftone          = 4
	shotMaxBase64         = 2800 * 1024 // 前端 AI_IMAGE_MAX_BASE64 = 3MB，留余量
)

var (
	shotUser32 = syscall.NewLazyDLL("user32.dll")
	shotGDI32  = syscall.NewLazyDLL("gdi32.dll")

	procShotGetWindowRect  = shotUser32.NewProc("GetWindowRect")
	procShotGetDC          = shotUser32.NewProc("GetDC")
	procShotGetWindowDC    = shotUser32.NewProc("GetWindowDC")
	procShotReleaseDC      = shotUser32.NewProc("ReleaseDC")
	procShotPrintWindow    = shotUser32.NewProc("PrintWindow")
	procShotBitBlt         = shotGDI32.NewProc("BitBlt")
	procShotStretchBlt     = shotGDI32.NewProc("StretchBlt")
	procShotSetStretchMode = shotGDI32.NewProc("SetStretchBltMode")
	procShotIsIconic       = shotUser32.NewProc("IsIconic")

	procShotCreateCompatibleDC     = shotGDI32.NewProc("CreateCompatibleDC")
	procShotCreateCompatibleBitmap = shotGDI32.NewProc("CreateCompatibleBitmap")
	procShotSelectObject           = shotGDI32.NewProc("SelectObject")
	procShotDeleteObject           = shotGDI32.NewProc("DeleteObject")
	procShotDeleteDC               = shotGDI32.NewProc("DeleteDC")
	procShotGetDIBits              = shotGDI32.NewProc("GetDIBits")
)

type shotRect struct {
	Left, Top, Right, Bottom int32
}

type shotBitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

type shotBitmapInfo struct {
	header shotBitmapInfoHeader
	colors [1]uint32
}

type shotSurface struct {
	dc  uintptr
	bmp uintptr
	w   int
	h   int
}

func shotNewSurface(screen uintptr, w int, h int) (*shotSurface, error) {
	dc, _, _ := procShotCreateCompatibleDC.Call(screen)
	if dc == 0 {
		return nil, fmt.Errorf("创建内存 DC 失败")
	}
	bmp, _, _ := procShotCreateCompatibleBitmap.Call(screen, uintptr(w), uintptr(h))
	if bmp == 0 {
		procShotDeleteDC.Call(dc)
		return nil, fmt.Errorf("创建位图失败")
	}
	procShotSelectObject.Call(dc, bmp)
	return &shotSurface{dc: dc, bmp: bmp, w: w, h: h}, nil
}

func (s *shotSurface) close() {
	procShotDeleteDC.Call(s.dc)
	procShotDeleteObject.Call(s.bmp)
}

// readBGRA 读成 top-down 的 BGRA 原始像素。
func (s *shotSurface) readBGRA() ([]byte, error) {
	buf := make([]byte, s.w*s.h*4)
	var bi shotBitmapInfo
	bi.header.biSize = uint32(unsafe.Sizeof(bi.header))
	bi.header.biWidth = int32(s.w)
	bi.header.biHeight = -int32(s.h) // 负数 = top-down
	bi.header.biPlanes = 1
	bi.header.biBitCount = 32
	bi.header.biCompression = 0 // BI_RGB
	rows, _, _ := procShotGetDIBits.Call(s.dc, s.bmp, 0, uintptr(s.h),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), 0) // DIB_RGB_COLORS
	if rows == 0 {
		return nil, fmt.Errorf("读取位图数据失败")
	}
	return buf, nil
}

func shotEncodePNG(bgra []byte, w int, h int) (string, error) {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		src := bgra[y*w*4:]
		dst := img.Pix[y*img.Stride:]
		for x := 0; x < w; x++ {
			i := x * 4
			dst[i] = src[i+2]
			dst[i+1] = src[i+1]
			dst[i+2] = src[i]
			dst[i+3] = 255
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(out.Bytes()), nil
}

func shotClampRect(x, y, w, h, maxW, maxH int) (int, int, int, int, error) {
	if x < 0 {
		w += x
		x = 0
	}
	if y < 0 {
		h += y
		y = 0
	}
	if x >= maxW || y >= maxH {
		return 0, 0, 0, 0, fmt.Errorf("截图区域超出窗口")
	}
	if x+w > maxW {
		w = maxW - x
	}
	if y+h > maxH {
		h = maxH - y
	}
	if w <= 0 || h <= 0 {
		return 0, 0, 0, 0, fmt.Errorf("截图区域无效（%dx%d）", w, h)
	}
	return x, y, w, h, nil
}

func shotCaptureWindowPNG(hwnd uintptr) (string, error) {
	return shotCaptureWindowRegionPNG(hwnd, -1, -1, 0, 0)
}

// shotCaptureWindowRegionPNG 截取窗口；rw/rh 大于 0 时只保留窗口内该矩形区域（物理像素）。
func shotCaptureWindowRegionPNG(hwnd uintptr, rx, ry, rw, rh int) (string, error) {
	if hwnd == 0 {
		return "", fmt.Errorf("找不到主窗口")
	}
	if r, _, _ := procShotIsIconic.Call(hwnd); r != 0 {
		return "", fmt.Errorf("窗口已最小化，请先恢复窗口再截图")
	}
	var rect shotRect
	if r, _, _ := procShotGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); r == 0 {
		return "", fmt.Errorf("读取窗口尺寸失败")
	}
	w, h := int(rect.Right-rect.Left), int(rect.Bottom-rect.Top)
	if w <= 0 || h <= 0 {
		return "", fmt.Errorf("窗口尺寸无效（%dx%d）", w, h)
	}
	screen, _, _ := procShotGetDC.Call(0)
	if screen == 0 {
		return "", fmt.Errorf("获取屏幕 DC 失败")
	}
	defer procShotReleaseDC.Call(0, screen)

	raw, err := shotNewSurface(screen, w, h)
	if err != nil {
		return "", err
	}
	defer raw.close()

	// 首选 PrintWindow：能拿到 WebView2 的合成层内容
	if r, _, _ := procShotPrintWindow.Call(hwnd, raw.dc, shotRenderFullContent); r == 0 {
		// 兜底：窗口 DC 直接拷贝（窗口被遮挡时会截到其他窗口内容）
		if winDC, _, _ := procShotGetWindowDC.Call(hwnd); winDC != 0 {
			procShotBitBlt.Call(raw.dc, 0, 0, uintptr(w), uintptr(h), winDC, 0, 0, shotSrcCopy)
			procShotReleaseDC.Call(hwnd, winDC)
		}
	}

	src := raw
	if rw > 0 && rh > 0 {
		cx, cy, cw, ch, cerr := shotClampRect(rx, ry, rw, rh, raw.w, raw.h)
		if cerr != nil {
			return "", cerr
		}
		cropped, err := shotNewSurface(screen, cw, ch)
		if err != nil {
			return "", err
		}
		procShotBitBlt.Call(cropped.dc, 0, 0, uintptr(cw), uintptr(ch),
			raw.dc, uintptr(cx), uintptr(cy), shotSrcCopy)
		src = cropped
	}
	defer func() {
		if src != raw {
			src.close()
		}
	}()
	for attempt := 0; ; attempt++ {
		bgra, err := src.readBGRA()
		if err != nil {
			return "", err
		}
		encoded, err := shotEncodePNG(bgra, src.w, src.h)
		if err != nil {
			return "", err
		}
		if len(encoded) <= shotMaxBase64 || attempt >= 3 || src.w < 480 {
			return encoded, nil
		}
		nw, nh := int(float64(src.w)*0.7), int(float64(src.h)*0.7)
		next, err := shotNewSurface(screen, nw, nh)
		if err != nil {
			return encoded, nil
		}
		procShotSetStretchMode.Call(next.dc, shotHalftone)
		procShotStretchBlt.Call(next.dc, 0, 0, uintptr(nw), uintptr(nh),
			src.dc, 0, 0, uintptr(src.w), uintptr(src.h), shotSrcCopy)
		if src != raw {
			src.close()
		}
		src = next
	}
}

// CaptureAppScreenshot 截取当前应用主窗口（含内嵌浏览器与 AI 面板）为 PNG base64，
// 供 app_control 的 screenshot 动作把界面视觉信息交给模型。
func (a *App) CaptureAppScreenshot() (string, error) {
	hwnd := findWailsWindow()
	if hwnd == 0 {
		return "", fmt.Errorf("找不到主窗口")
	}
	return shotCaptureWindowPNG(hwnd)
}

// CaptureAppScreenshotRegion 截取主窗口内的指定区域（物理像素，相对窗口左上角）。
// 供 app_control screenshot {area} 做板块截图；越界会自动裁剪。
func (a *App) CaptureAppScreenshotRegion(x, y, width, height int) (string, error) {
	hwnd := findWailsWindow()
	if hwnd == 0 {
		return "", fmt.Errorf("找不到主窗口")
	}
	return shotCaptureWindowRegionPNG(hwnd, x, y, width, height)
}
