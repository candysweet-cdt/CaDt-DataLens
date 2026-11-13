//go:build windows

package main

import (
	"syscall"
	"testing"
	"unsafe"
)

// TestBrowserCloseThenReopen 同一父窗口上关掉一个标签页后再开一个（真实使用路径）。
func TestBrowserCloseThenReopen(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；go test -v -run TestBrowserCloseThenReopen 显式运行（本机 WebView2 冒烟）")
	}
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	clsPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserReopenWnd")
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
		0, 0, 480, 320, 0, 0, hinst, 0)
	if hwnd == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(hwnd, 4)
	defer procBrowserDestroyWindow.Call(hwnd)

	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return hwnd }
	defer func() { browserParentHWND = origParent }()

	app := &App{}
	if _, err := app.BrowserOpen("t-a", "about:blank", "test"); err != nil {
		t.Fatalf("第一次 BrowserOpen: %v", err)
	}
	if err := app.BrowserClose("t-a"); err != nil {
		t.Fatalf("BrowserClose: %v", err)
	}
	if _, err := app.BrowserOpen("t-b", "about:blank", "test"); err != nil {
		t.Fatalf("关闭后再 BrowserOpen: %v", err)
	}
	if err := app.BrowserClose("t-b"); err != nil {
		t.Fatalf("BrowserClose(t-b): %v", err)
	}
}

// zOrderIndex 返回 hwnd 在 parent 直接子窗口 z 序中的位置（0 = 最上；-1 = 不在其中）。
func zOrderIndex(parent, hwnd uintptr) int {
	child, _, _ := procBrowserGetWindow.Call(parent, 5) // GW_CHILD
	for idx := 0; child != 0; idx++ {
		if child == hwnd {
			return idx
		}
		child, _, _ = procBrowserGetWindow.Call(child, 2) // GW_HWNDNEXT
	}
	return -1
}

// TestBrowserControlRaisedAboveMainWebView：主 WebView 占满客户区，内嵌控件必须被提到它上面，
// 否则原生页面被盖住，用户看到的是空白区域。
func TestBrowserControlRaisedAboveMainWebView(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；go test -v -run TestBrowserControlRaisedAboveMainWebView 显式运行")
	}
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	classPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserZOrderWnd")
	className := uintptr(unsafe.Pointer(classPtr))
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
	wc.lpszClassName = className
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		t.Fatal("注册测试窗口类失败")
	}
	parent, _, _ := procBrowserCreateWindowEx.Call(0, className, 0, 0x80000000, 0, 0, 480, 320, 0, 0, hinst, 0)
	if parent == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(parent, 4)
	defer procBrowserDestroyWindow.Call(parent)

	// 模拟主 WebView：铺满客户区的兄弟窗口
	cover, _, _ := procBrowserCreateWindowEx.Call(0, className, 0, 0x40000000, // WS_CHILD
		0, 0, 480, 320, parent, 0, hinst, 0)
	if cover == 0 {
		t.Fatal("创建遮罩窗口失败")
	}
	procBrowserShowWindow.Call(cover, 4)

	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return parent }
	defer func() { browserParentHWND = origParent }()

	app := &App{}
	if _, err := app.BrowserOpen("t-z", "about:blank", "test"); err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	defer app.BrowserClose("t-z")
	inst := browserGet("t-z")
	if inst == nil || inst.hwndCtl == 0 {
		t.Fatal("未记录 WebView2 控件 HWND")
	}
	// 把遮罩压到最上，再走一次尺寸同步（真实路径：切标签/调窗口都会触发）
	procBrowserSetWindowPos.Call(cover, browserHwndTop, 0, 0, 0, 0,
		browserSwpNoMove|browserSwpNoSize|browserSwpNoActivate)
	if err := app.BrowserSetBounds("t-z", 0, 0, 480, 320); err != nil {
		t.Fatalf("BrowserSetBounds: %v", err)
	}
	ctlIdx := zOrderIndex(parent, inst.hwndCtl)
	coverIdx := zOrderIndex(parent, cover)
	if ctlIdx < 0 || coverIdx < 0 {
		t.Fatalf("z 序查询失败 ctl=%d cover=%d", ctlIdx, coverIdx)
	}
	if ctlIdx > coverIdx {
		t.Fatalf("内嵌控件仍在主界面之下：ctl=%d cover=%d", ctlIdx, coverIdx)
	}
}
