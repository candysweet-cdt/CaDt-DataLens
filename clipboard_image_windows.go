//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const cfDIB = 8 // CF_DIB：设备无关位图，截图工具/浏览器都往这里写

var (
	modUser32Clip   = windows.NewLazySystemDLL("user32.dll")
	modKernel32Clip = windows.NewLazySystemDLL("kernel32.dll")

	procOpenClipboard     = modUser32Clip.NewProc("OpenClipboard")
	procCloseClipboard    = modUser32Clip.NewProc("CloseClipboard")
	procGetClipboardData  = modUser32Clip.NewProc("GetClipboardData")
	procIsClipFormatAvail = modUser32Clip.NewProc("IsClipboardFormatAvailable")
	procRegisterClipFmt   = modUser32Clip.NewProc("RegisterClipboardFormatW")

	procGlobalLock   = modKernel32Clip.NewProc("GlobalLock")
	procGlobalUnlock = modKernel32Clip.NewProc("GlobalUnlock")
	procGlobalSize   = modKernel32Clip.NewProc("GlobalSize")
)

// clipboardImageDataURL 读取剪贴板里的图片并编码成 PNG data URL；没有图片时返回空串。
// 优先取注册格式 "PNG"（原样字节，不丢 alpha、免去 DIB 解析），回退到 CF_DIB。
// 右键菜单的「粘贴」拿不到 paste 事件，只能用这种方式回读剪贴板。
func clipboardImageDataURL() (string, error) {
	pngFormat := registerClipboardFormat("PNG")
	hasPNG := false
	if pngFormat != 0 {
		ok, _, _ := procIsClipFormatAvail.Call(pngFormat)
		hasPNG = ok != 0
	}
	hasDIB, _, _ := procIsClipFormatAvail.Call(uintptr(cfDIB))
	if !hasPNG && hasDIB == 0 {
		return "", nil // 剪贴板里没有图片，交给文本粘贴
	}
	if hasPNG {
		if data := readClipboardFormat(pngFormat); isPNG(data) {
			return pngDataURL(data), nil
		}
	}
	if hasDIB == 0 {
		return "", nil
	}
	data := readClipboardFormat(uintptr(cfDIB))
	if len(data) == 0 {
		return "", nil
	}
	img, err := decodeDIB(data)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", fmt.Errorf("剪贴板图片编码失败：%w", err)
	}
	return pngDataURL(buf.Bytes()), nil
}

func pngDataURL(data []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
}

func isPNG(data []byte) bool {
	return len(data) > 8 && bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n"))
}

func registerClipboardFormat(name string) uintptr {
	ptr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0
	}
	id, _, _ := procRegisterClipFmt.Call(uintptr(unsafe.Pointer(ptr)))
	return id
}

// readClipboardFormat 读出某个剪贴板格式的原始字节。剪贴板随时可能被别的进程占用，
// OpenClipboard 失败时短暂重试几次。
func readClipboardFormat(format uintptr) []byte {
	opened := false
	for attempt := 0; attempt < 6; attempt++ {
		if ok, _, _ := procOpenClipboard.Call(0); ok != 0 {
			opened = true
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !opened {
		return nil
	}
	defer procCloseClipboard.Call()

	handle, _, _ := procGetClipboardData.Call(format)
	if handle == 0 {
		return nil
	}
	size, _, _ := procGlobalSize.Call(handle)
	if size == 0 {
		return nil
	}
	ptr, _, _ := procGlobalLock.Call(handle)
	if ptr == 0 {
		return nil
	}
	defer procGlobalUnlock.Call(handle)
	out := make([]byte, int(size))
	copy(out, unsafe.Slice((*byte)(unsafe.Pointer(ptr)), int(size)))
	return out
}

// decodeDIB 把 CF_DIB 的字节流（BITMAPINFOHEADER + 像素）还原成 image.Image。
// 只处理截图/复制图片常见的无压缩 24/32 位；其它位深明确报错，避免解出花屏。
func decodeDIB(data []byte) (image.Image, error) {
	if len(data) < 40 {
		return nil, fmt.Errorf("剪贴板位图数据不完整")
	}
	headerSize := int(binary.LittleEndian.Uint32(data[0:4]))
	if headerSize < 40 || headerSize > len(data) {
		return nil, fmt.Errorf("剪贴板位图头无效")
	}
	width := int(int32(binary.LittleEndian.Uint32(data[4:8])))
	rawHeight := int(int32(binary.LittleEndian.Uint32(data[8:12])))
	bitCount := int(binary.LittleEndian.Uint16(data[14:16]))
	compression := binary.LittleEndian.Uint32(data[16:20])
	if width <= 0 || rawHeight == 0 {
		return nil, fmt.Errorf("剪贴板位图尺寸无效")
	}
	// BI_RGB(0) 与 BI_BITFIELDS(3) 都是直接存像素；其它（RLE/JPEG/PNG 内嵌）不支持。
	if compression != 0 && compression != 3 {
		return nil, fmt.Errorf("不支持的剪贴板位图压缩格式：%d", compression)
	}
	if bitCount != 24 && bitCount != 32 {
		return nil, fmt.Errorf("不支持的剪贴板位图位深：%d", bitCount)
	}
	topDown := rawHeight < 0
	height := rawHeight
	if topDown {
		height = -height
	}
	offset := headerSize
	// 40 字节头 + BI_BITFIELDS 时三个掩码跟在头后面，像素数据再往后 12 字节。
	if compression == 3 && headerSize == 40 {
		offset += 12
	}
	stride := ((width*bitCount + 31) / 32) * 4
	if offset+stride*height > len(data) {
		return nil, fmt.Errorf("剪贴板位图像素数据不完整")
	}
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	step := bitCount / 8
	for y := 0; y < height; y++ {
		srcY := y
		if !topDown {
			srcY = height - 1 - y // DIB 默认自下而上
		}
		row := data[offset+srcY*stride:]
		for x := 0; x < width; x++ {
			i := x * step
			b := row[i]
			g := row[i+1]
			r := row[i+2]
			// BI_RGB 的 32 位第四字节是未定义值（常见为 0），一律按不透明处理，
			// 否则截图会变成全透明。
			a := byte(255)
			if bitCount == 32 && compression == 3 {
				a = row[i+3]
			}
			img.SetNRGBA(x, y, color.NRGBA{R: r, G: g, B: b, A: a})
		}
	}
	return img, nil
}
