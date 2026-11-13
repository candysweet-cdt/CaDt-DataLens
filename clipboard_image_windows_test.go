//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// makeDIB 按 BITMAPINFOHEADER 拼一份最小 DIB：rows 自下而上，每像素 BGR(A)。
func makeDIB(width, height, bitCount int, topDown bool, compression uint32, pixels []byte) []byte {
	header := make([]byte, 40)
	stride := ((width*bitCount + 31) / 32) * 4
	binary.LittleEndian.PutUint32(header[0:], 40)
	binary.LittleEndian.PutUint32(header[4:], uint32(int32(width)))
	h := int32(height)
	if topDown {
		h = -h
	}
	binary.LittleEndian.PutUint32(header[8:], uint32(h))
	binary.LittleEndian.PutUint16(header[12:], 1)
	binary.LittleEndian.PutUint16(header[14:], uint16(bitCount))
	binary.LittleEndian.PutUint32(header[16:], compression)
	binary.LittleEndian.PutUint32(header[20:], uint32(stride*height))
	return append(header, pixels...)
}

func TestDecodeDIB24BottomUp(t *testing.T) {
	// 2x2：内存里第一行是图片最下面一行，像素按 BGR 排列。
	// 底行：左红(0,0,255) 右绿(0,255,0)；顶行：左蓝(255,0,0) 右白(255,255,255)
	pixels := []byte{
		0, 0, 255, 0, 255, 0, 0, 0,
		255, 0, 0, 255, 255, 255, 0, 0,
	}
	img, err := decodeDIB(makeDIB(2, 2, 24, false, 0, pixels))
	if err != nil {
		t.Fatalf("decodeDIB 失败：%v", err)
	}
	if got := img.Bounds().Dx(); got != 2 {
		t.Fatalf("宽度 = %d，想要 2", got)
	}
	cases := []struct {
		name    string
		x, y    int
		r, g, b uint8
	}{
		{"左上应是蓝色", 0, 0, 0, 0, 255},
		{"右上应是白色", 1, 0, 255, 255, 255},
		{"左下应是红色", 0, 1, 255, 0, 0},
		{"右下应是绿色", 1, 1, 0, 255, 0},
	}
	for _, c := range cases {
		r, g, b, a := img.At(c.x, c.y).RGBA()
		if uint8(r>>8) != c.r || uint8(g>>8) != c.g || uint8(b>>8) != c.b || uint8(a>>8) != 255 {
			t.Errorf("%s：得到 rgba(%d,%d,%d,%d)", c.name, r>>8, g>>8, b>>8, a>>8)
		}
	}
}

func TestDecodeDIB32TopDown(t *testing.T) {
	// 32 位 BI_RGB：alpha 字节不可信（常见为 0），解码后必须是不透明。
	pixels := []byte{
		10, 20, 30, 0, 40, 50, 60, 0,
		70, 80, 90, 0, 100, 110, 120, 0,
	}
	img, err := decodeDIB(makeDIB(2, 2, 32, true, 0, pixels))
	if err != nil {
		t.Fatalf("decodeDIB 失败：%v", err)
	}
	r, g, b, a := img.At(0, 0).RGBA()
	if uint8(r>>8) != 30 || uint8(g>>8) != 20 || uint8(b>>8) != 10 || uint8(a>>8) != 255 {
		t.Errorf("左上像素 = rgba(%d,%d,%d,%d)，想要 rgba(30,20,10,255)", r>>8, g>>8, b>>8, a>>8)
	}
	r, g, b, a = img.At(1, 1).RGBA()
	if uint8(r>>8) != 120 || uint8(g>>8) != 110 || uint8(b>>8) != 100 || uint8(a>>8) != 255 {
		t.Errorf("右下像素 = rgba(%d,%d,%d,%d)，想要 rgba(120,110,100,255)", r>>8, g>>8, b>>8, a>>8)
	}
}

func TestDecodeDIBRejects(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"数据太短", []byte{1, 2, 3}},
		{"位深不支持", makeDIB(1, 1, 8, false, 0, make([]byte, 4))},
		{"压缩方式不支持", makeDIB(1, 1, 24, false, 1, make([]byte, 4))},
		{"像素数据不足", makeDIB(2, 2, 24, false, 0, []byte{1, 2, 3})},
	}
	for _, c := range cases {
		if _, err := decodeDIB(c.data); err == nil {
			t.Errorf("%s：应当报错", c.name)
		}
	}
}

func TestIsPNG(t *testing.T) {
	if !isPNG([]byte("\x89PNG\r\n\x1a\n12345")) {
		t.Error("PNG 头应当被识别")
	}
	if isPNG([]byte("not a png")) {
		t.Error("非 PNG 数据不应被识别")
	}
	if isPNG(bytes.Repeat([]byte{0}, 4)) {
		t.Error("过短数据不应被识别")
	}
}
