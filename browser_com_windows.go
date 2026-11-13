//go:build windows

package main

// go-webview2 的 ICoreWebView2 wrapper 只覆盖了部分方法；这里按 COM vtable 槽位
// （官方 IDL 顺序，与库内 iCoreWebView2Vtbl 字段顺序一致）直接调用缺失的方法，
// 并用 combridge 提供 CallDevToolsProtocolMethod 的完成回调对象。

import (
	"encoding/base64"
	"fmt"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

// ICoreWebView2 vtable 槽位（IUnknown 0-2 之后按 IDL 顺序）。
const (
	wvSlotGetSettings      = 3
	wvSlotGetSource        = 4
	wvSlotNavigate         = 5
	wvSlotExecuteScript    = 29
	wvSlotReload           = 31
	wvSlotCallCDPMethod    = 36
	wvSlotGetCanGoBack     = 38
	wvSlotGetCanGoForward  = 39
	wvSlotGoBack           = 40
	wvSlotGoForward        = 41
	wvSlotStop             = 43
	wvSlotGetDocumentTitle = 48
	wvSlotInitScript       = 27
	wvSlotCapturePreview   = 30
	// ICoreWebView2Controller：IUnknown 3 + IDL 字段 21（Close 是第 22 个）
	wvControllerSlotClose = 24
)

var (
	browserOle32             = syscall.NewLazyDLL("ole32.dll")
	procBrowserCoTaskMemFree = browserOle32.NewProc("CoTaskMemFree")
	browserKernel32          = syscall.NewLazyDLL("kernel32.dll")
	procBrowserLstrlenW      = browserKernel32.NewProc("lstrlenW")
)

// wvRaw 把 COM 接口指针镜像为「vtable 指针」结构（COM 标准：首字段即 vtable）。
type wvRawVtbl [64]uintptr // ICoreWebView2 全部槽位（IUnknown 3 + 接口 58）
type wvRaw struct {
	vtbl *wvRawVtbl
}

// wvProc 取 ICoreWebView2 vtable 上指定槽位的函数指针。
func wvProc(wv *edge.ICoreWebView2, slot int) uintptr {
	return (*wvRaw)(unsafe.Pointer(wv)).vtbl[slot]
}

// wvStringOut 调用返回 LPWSTR 的槽位（GetSource/GetDocumentTitle 风格）。
func wvStringOut(wv *edge.ICoreWebView2, slot int) (string, error) {
	var p *uint16
	hr, _, _ := syscall.SyscallN(wvProc(wv, slot),
		uintptr(unsafe.Pointer(wv)), uintptr(unsafe.Pointer(&p)))
	if hr != 0 {
		return "", fmt.Errorf("0x%08x", hr)
	}
	if p == nil {
		return "", nil
	}
	n, _, _ := procBrowserLstrlenW.Call(uintptr(unsafe.Pointer(p)))
	s := syscall.UTF16ToString(unsafe.Slice(p, int(n)))
	procBrowserCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return s, nil
}

// wvInt32Out 调用返回 BOOL/int32 的槽位（GetCanGoBack/GetCanGoForward 风格）。
func wvInt32Out(wv *edge.ICoreWebView2, slot int) (int32, error) {
	var v int32
	hr, _, _ := syscall.SyscallN(wvProc(wv, slot),
		uintptr(unsafe.Pointer(wv)), uintptr(unsafe.Pointer(&v)))
	if hr != 0 {
		return 0, fmt.Errorf("0x%08x", hr)
	}
	return v, nil
}

func wvGoBack(wv *edge.ICoreWebView2) error {
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotGoBack), uintptr(unsafe.Pointer(wv)))
	if hr != 0 {
		return fmt.Errorf("GoBack 0x%08x", hr)
	}
	return nil
}

func wvGoForward(wv *edge.ICoreWebView2) error {
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotGoForward), uintptr(unsafe.Pointer(wv)))
	if hr != 0 {
		return fmt.Errorf("GoForward 0x%08x", hr)
	}
	return nil
}

func wvReload(wv *edge.ICoreWebView2) error {
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotReload), uintptr(unsafe.Pointer(wv)))
	if hr != 0 {
		return fmt.Errorf("Reload 0x%08x", hr)
	}
	return nil
}

func wvStop(wv *edge.ICoreWebView2) error {
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotStop), uintptr(unsafe.Pointer(wv)))
	if hr != 0 {
		return fmt.Errorf("Stop 0x%08x", hr)
	}
	return nil
}

// wvControllerClose 关闭 WebView2 控制器（库没导出 Close），销毁控件子窗口并释放
// 控制器/内核；否则关闭标签页后原生窗口和渲染进程只是被隐藏，仍长期驻留。
func wvControllerClose(ctrl *edge.ICoreWebView2Controller) error {
	hr, _, _ := syscall.SyscallN(
		(*wvRaw)(unsafe.Pointer(ctrl)).vtbl[wvControllerSlotClose],
		uintptr(unsafe.Pointer(ctrl)))
	if hr != 0 {
		return fmt.Errorf("控制器 Close 0x%08x", hr)
	}
	return nil
}

// ---- CallDevToolsProtocolMethod 完成回调 ----

// 旧式静态 vtbl handler（与 go-webview2 内部实现同模式，完全掌控布局）。

type browserCDPHandlerVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	invoke         uintptr
}

type browserCDPResult struct {
	errCode uintptr
	json    string
}

type browserCDPHandler struct {
	vtbl     *browserCDPHandlerVtbl
	resultCh chan browserCDPResult
	done     uint32 // 原子完成标志（任务内泵轮询用）
}

var browserCDPHandlerVtblStatic = browserCDPHandlerVtbl{
	queryInterface: windows.NewCallback(browserCDPQueryInterface),
	addRef:         windows.NewCallback(browserCDPAddRef),
	release:        windows.NewCallback(browserCDPRelease),
	invoke:         windows.NewCallback(browserCDPInvoke),
}

func newBrowserCDPHandler() *browserCDPHandler {
	return &browserCDPHandler{vtbl: &browserCDPHandlerVtblStatic, resultCh: make(chan browserCDPResult, 1)}
}

var browserIUnknownGUID = windows.GUID{
	Data1: 0x00000000,
	Data2: 0x0000,
	Data3: 0x0000,
	Data4: [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46},
}

func browserCDPQueryInterface(this, refiid, object uintptr) uintptr {
	// 只认 IUnknown；对其他 IID 必须 E_NOINTERFACE，否则原生会把 this 当成
	// 它请求的接口调用（这正是此前 ExecuteScript 永不回调 / CDP 崩溃的根因）。
	if refiid == 0 || object == 0 {
		return 0x80004003 // E_POINTER
	}
	if *(*windows.GUID)(unsafe.Pointer(refiid)) != browserIUnknownGUID {
		if object != 0 {
			*(*uintptr)(unsafe.Pointer(object)) = 0
		}
		return 0x80004002 // E_NOINTERFACE
	}
	*(*uintptr)(unsafe.Pointer(object)) = this
	return browserCDPAddRef(this)
}

func browserCDPAddRef(this uintptr) uintptr { return 1 }

func browserCDPRelease(this uintptr) uintptr { return 1 }

func browserCDPInvoke(this, errorCode, returnObjectAsJson uintptr) uintptr {
	handler := (*browserCDPHandler)(unsafe.Pointer(this))
	var payload string
	if returnObjectAsJson != 0 {
		n, _, _ := procBrowserLstrlenW.Call(returnObjectAsJson)
		payload = syscall.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(returnObjectAsJson)), int(n)))
	}
	handler.resultCh <- browserCDPResult{errCode: errorCode, json: payload}
	atomic.StoreUint32(&handler.done, 1)
	return 0
}

// wvNavigate 槽位直调 Navigate（绕开 Chromium 高层方法——它的 errorCallback 无条件 os.Exit）。
func wvNavigate(wv *edge.ICoreWebView2, url string) error {
	urlPtr, err := windows.UTF16PtrFromString(url)
	if err != nil {
		return err
	}
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotNavigate),
		uintptr(unsafe.Pointer(wv)), uintptr(unsafe.Pointer(urlPtr)))
	if hr != 0 {
		return fmt.Errorf("Navigate 0x%08x", hr)
	}
	return nil
}

// wvInitScript 槽位直调 AddScriptToExecuteOnDocumentCreated。
func wvInitScript(wv *edge.ICoreWebView2, script string) error {
	scriptPtr, err := windows.UTF16PtrFromString(script)
	if err != nil {
		return err
	}
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotInitScript),
		uintptr(unsafe.Pointer(wv)), uintptr(unsafe.Pointer(scriptPtr)), 0)
	if hr != 0 {
		return fmt.Errorf("AddScriptToExecuteOnDocumentCreated 0x%08x", hr)
	}
	return nil
}

// wvCallExecScriptStart 在宿主线程发起 ExecuteScript（handler 拿 JSON 结果，等待在调用方）。
func wvCallExecScriptStart(wv *edge.ICoreWebView2, script string) (*browserCDPHandler, error) {
	scriptPtr, err := windows.UTF16PtrFromString(script)
	if err != nil {
		return nil, err
	}
	handler := newBrowserCDPHandler()
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotExecuteScript),
		uintptr(unsafe.Pointer(wv)),
		uintptr(unsafe.Pointer(scriptPtr)),
		uintptr(unsafe.Pointer(handler)))
	if hr != 0 {
		return nil, fmt.Errorf("ExecuteScript 0x%08x", hr)
	}
	return handler, nil
}

// waitPump 在宿主任务内泵消息并等待完成（WebView2 回调依赖宿主线程泵，同步语义走这里）。
func (h *browserCDPHandler) waitPump(timeout time.Duration) (string, error) {
	// handler 的地址已交给原生 COM 对象；等待期间必须让 GC 认为它还活着
	defer runtime.KeepAlive(h)
	deadline := time.Now().Add(timeout)
	var msg browserMsg
	for time.Now().Before(deadline) {
		for {
			r, _, _ := syscall.SyscallN(procBrowserPeekMessageW.Addr(),
				uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1) // PM_REMOVE
			if r == 0 || int32(r) == -1 {
				break
			}
			syscall.SyscallN(procBrowserTranslateMsg.Addr(), uintptr(unsafe.Pointer(&msg)))
			syscall.SyscallN(procBrowserDispatchMsg.Addr(), uintptr(unsafe.Pointer(&msg)))
		}
		if atomic.LoadUint32(&h.done) != 0 {
			result := <-h.resultCh
			if result.errCode != 0 {
				return "", fmt.Errorf("CDP 失败 0x%08x：%s", result.errCode, result.json)
			}
			return result.json, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return "", fmt.Errorf("CDP 调用超时（%.0fs）", timeout.Seconds())
}

// wait 在任意 goroutine 等待 CDP 完成（回调经宿主线程泵派发后填充 resultCh）。
func (h *browserCDPHandler) wait(timeout time.Duration) (string, error) {
	defer runtime.KeepAlive(h)
	select {
	case result := <-h.resultCh:
		if result.errCode != 0 {
			return "", fmt.Errorf("CDP 失败 0x%08x：%s", result.errCode, result.json)
		}
		return result.json, nil
	case <-time.After(timeout):
		return "", fmt.Errorf("CDP 调用超时（%.0fs）", timeout.Seconds())
	}
}

// wvCallExecScript 用 ExecuteScript 槽位（29）跑脚本并拿 JSON 结果（诊断用，与 CDP 同样的 handler 形态）。

// wvExecScriptFireAndForget nil handler 的 ExecuteScript（诊断：验证槽位与 JS 执行，不经 handler）。
func wvExecScriptFireAndForget(wv *edge.ICoreWebView2, script string) error {
	scriptPtr, err := windows.UTF16PtrFromString(script)
	if err != nil {
		return err
	}
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotExecuteScript),
		uintptr(unsafe.Pointer(wv)),
		uintptr(unsafe.Pointer(scriptPtr)),
		0)
	if hr != 0 {
		return fmt.Errorf("ExecuteScript 0x%08x", hr)
	}
	return nil
}

// wvCallCDP 同步调用一个 DevTools Protocol 方法并返回结果 JSON。

// ---- CapturePreview 截图（槽位 30；CDP 槽位 36 在本环境触发崩溃，截图走官方 CapturePreview）----

var (
	browserShlwapi         = syscall.NewLazyDLL("shlwapi.dll")
	procBrowserSHCreateMem = browserShlwapi.NewProc("SHCreateMemStream")
)

// browserCaptureHandler: CapturePreview 完成回调（Invoke(this, errorCode) 两参数）。
type browserCaptureHandlerVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	invoke         uintptr
}

type browserCaptureHandler struct {
	vtbl    *browserCaptureHandlerVtbl
	done    uint32
	errCode uintptr
}

var browserCaptureHandlerVtblStatic = browserCaptureHandlerVtbl{
	queryInterface: windows.NewCallback(browserCaptureQueryInterface),
	addRef:         windows.NewCallback(browserCDPAddRef),
	release:        windows.NewCallback(browserCDPRelease),
	invoke:         windows.NewCallback(browserCaptureInvoke),
}

func newBrowserCaptureHandler() *browserCaptureHandler {
	return &browserCaptureHandler{vtbl: &browserCaptureHandlerVtblStatic}
}

func browserCaptureQueryInterface(this, refiid, object uintptr) uintptr {
	if refiid == 0 || object == 0 {
		return 0x80004003
	}
	if *(*windows.GUID)(unsafe.Pointer(refiid)) != browserIUnknownGUID {
		*(*uintptr)(unsafe.Pointer(object)) = 0
		return 0x80004002
	}
	*(*uintptr)(unsafe.Pointer(object)) = this
	return browserCDPAddRef(this)
}

func browserCaptureInvoke(this, errorCode uintptr) uintptr {
	handler := (*browserCaptureHandler)(unsafe.Pointer(this))
	handler.errCode = errorCode
	atomic.StoreUint32(&handler.done, 1)
	return 0
}

// streamReadAll 读取一个 IStream 的全部内容（槽位 3 = Read，COM 标准 ISequentialStream 布局）。
func streamReadAll(stream uintptr) ([]byte, error) {
	var out []byte
	buf := make([]byte, 64<<10)
	for {
		var got uint32
		readProc := (*wvRaw)(unsafe.Pointer(stream)).vtbl[3]
		hr, _, _ := syscall.SyscallN(readProc, stream,
			uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&got)))
		if hr < 0 {
			return nil, fmt.Errorf("IStream::Read 0x%08x", hr)
		}
		if got == 0 {
			break
		}
		out = append(out, buf[:got]...)
		if got < uint32(len(buf)) {
			break
		}
	}
	return out, nil
}

// streamRelease 释放 COM 流对象（IUnknown Release，槽位 2）。
func streamRelease(stream uintptr) {
	syscall.SyscallN((*wvRaw)(unsafe.Pointer(stream)).vtbl[2], stream)
}

// wvCaptureScreenshot 用 CapturePreview 抓取当前页面为 PNG，返回 base64。
// 必须在宿主线程调用（内部泵等完成回调）。
func wvCaptureScreenshot(wv *edge.ICoreWebView2, timeout time.Duration) (string, error) {
	stream, _, _ := procBrowserSHCreateMem.Call(0, 0)
	if stream == 0 {
		return "", fmt.Errorf("创建内存流失败")
	}
	handler := newBrowserCaptureHandler()
	hr, _, _ := syscall.SyscallN(wvProc(wv, wvSlotCapturePreview),
		uintptr(unsafe.Pointer(wv)), 0 /* COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG */, stream,
		uintptr(unsafe.Pointer(handler)))
	// handler 地址已交给原生回调，函数返回前保持存活
	defer runtime.KeepAlive(handler)
	if hr != 0 {
		streamRelease(stream)
		return "", fmt.Errorf("CapturePreview 0x%08x", hr)
	}
	var msg browserMsg
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for {
			r, _, _ := syscall.SyscallN(procBrowserPeekMessageW.Addr(),
				uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1)
			if r == 0 || int32(r) == -1 {
				break
			}
			syscall.SyscallN(procBrowserTranslateMsg.Addr(), uintptr(unsafe.Pointer(&msg)))
			syscall.SyscallN(procBrowserDispatchMsg.Addr(), uintptr(unsafe.Pointer(&msg)))
		}
		if atomic.LoadUint32(&handler.done) != 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer streamRelease(stream)
	if atomic.LoadUint32(&handler.done) == 0 {
		return "", fmt.Errorf("CapturePreview 超时（%.0fs）", timeout.Seconds())
	}
	if handler.errCode != 0 {
		return "", fmt.Errorf("CapturePreview 失败 0x%08x", handler.errCode)
	}
	// 流指针在写入后的末尾，Seek 回开头（IStream::Seek 槽位 5，STREAM_SEEK_SET=0）
	var newPos uint64
	seekProc := (*wvRaw)(unsafe.Pointer(stream)).vtbl[5]
	if hr, _, _ := syscall.SyscallN(seekProc, stream, 0, 0, uintptr(unsafe.Pointer(&newPos))); hr < 0 {
		return "", fmt.Errorf("IStream::Seek 0x%08x", hr)
	}
	png, err := streamReadAll(stream)
	if err != nil {
		return "", err
	}
	if len(png) < 8 {
		return "", fmt.Errorf("截图数据为空")
	}
	return base64.StdEncoding.EncodeToString(png), nil
}
