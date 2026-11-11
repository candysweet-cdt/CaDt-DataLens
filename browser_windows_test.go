//go:build windows

package main

import (
	"fmt"
	"strings"
	"sync"
	"syscall"
	"testing"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
)

// TestBrowserHostRunTasks 验证宿主线程任务派发与错误传递。
func TestBrowserHostRunTasks(t *testing.T) {
	var order []string
	var mu sync.Mutex
	for i := 0; i < 3; i++ {
		n := i
		if err := browserHostRun(func() {
			mu.Lock()
			order = append(order, string(rune('a'+n)))
			mu.Unlock()
		}); err != nil {
			t.Fatalf("task %d: %v", i, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(order, "") != "abc" {
		t.Fatalf("order = %v", order)
	}
}

// TestBrowserVTableSlots 抽查槽位常量与库 vtable 字段顺序一致（COM IDL 顺序）。
func TestBrowserVTableSlots(t *testing.T) {
	if wvSlotReload != 31 || wvSlotCallCDPMethod != 36 || wvSlotGoBack != 40 || wvSlotGoForward != 41 || wvSlotGetDocumentTitle != 48 {
		t.Fatalf("slot constants drifted: reload=%d cdp=%d back=%d fwd=%d title=%d",
			wvSlotReload, wvSlotCallCDPMethod, wvSlotGoBack, wvSlotGoForward, wvSlotGetDocumentTitle)
	}
}

// TestBrowserEmbedAndCDP 真实嵌入冒烟：显示窗口 + App 绑定全链路
// （BrowserOpen → BrowserNavigate → BrowserEval → BrowserCallCDP 截图）。
// 需要本机 WebView2 Runtime；默认跳过，go test -v -run TestBrowserEmbedAndCDP 显式运行。
func TestBrowserEmbedAndCDP(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；go test -v -run TestBrowserEmbedAndCDP 显式运行（本机 WebView2 冒烟）")
	}
	// 二分实验：emit 已禁用（inst.emit = nil）

	// 测试父窗口（WebView2 在不可见父窗口中暂停 JS，必须显示）
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	clsPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserTestWnd")
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
		0, uintptr(unsafe.Pointer(clsPtr)), 0, 0x80000000, // WS_OVERLAPPED
		0, 0, 480, 320, 0, 0, hinst, 0)
	if hwnd == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(hwnd, 4) // SW_SHOWNOACTIVATE
	defer procBrowserDestroyWindow.Call(hwnd)

	// 注入父窗口
	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return hwnd }
	defer func() { browserParentHWND = origParent }()

	app := &App{}
	info, err := app.BrowserOpen("t-browser", "about:blank", "test")
	if err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	if info["id"] != "t-browser" {
		t.Fatalf("BrowserOpen info = %v", info)
	}
	inst := browserGet("t-browser")
	if inst == nil || inst.webview == nil {
		t.Fatal("实例未就绪")
	}
	inst.emit = nil // 二分实验：emit 禁用
	if err := browserHostRun(func() {
		bounds := edge.Rect{Left: 0, Top: 0, Right: 480, Bottom: 320}
		inst.chromium.ResizeWithBounds(&bounds)
	}); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	// 导航（任务内同步等完成事件，事件收集断言）
	if err := app.BrowserNavigate("t-browser", "data:text/html,<html><head><title>diag</title></head><body>hi</body></html>"); err != nil {
		t.Fatalf("BrowserNavigate: %v", err)
	}
	// BrowserEval（Runtime.evaluate 返回 42）
	result, err := app.BrowserEval("t-browser", "6*7")
	if err != nil {
		t.Fatalf("BrowserEval: %v", err)
	}
	if !strings.Contains(result, "42") {
		t.Fatalf("eval result = %s", result)
	}

	// BrowserCaptureScreenshot（CapturePreview → base64 PNG）
	shot, err := app.BrowserCaptureScreenshot("t-browser")
	if err != nil {
		t.Fatalf("BrowserCaptureScreenshot: %v", err)
	}
	if len(shot) < 100 {
		t.Fatalf("screenshot payload too short: %d", len(shot))
	}

	// BrowserState
	state, err := app.BrowserState("t-browser")
	if err != nil {
		t.Fatalf("BrowserState: %v", err)
	}
	if state["url"] == nil {
		t.Fatalf("state = %v", state)
	}
	fmt.Printf("[browser-smoke] state=%v shot=%d bytes\n", state, len(shot))

	// 关闭
	if err := app.BrowserClose("t-browser"); err != nil {
		t.Fatalf("BrowserClose: %v", err)
	}
	if browserGet("t-browser") != nil {
		t.Fatal("实例未释放")
	}
}
