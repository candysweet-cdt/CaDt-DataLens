//go:build windows

package browser

// go-webview2 的 ICoreWebView2 wrapper 只覆盖了部分方法；这里按 COM vtable 槽位
// （官方 IDL 顺序，与库内 iCoreWebView2Vtbl 字段顺序一致）直接调用缺失的方法，
// 并用 combridge 提供 CallDevToolsProtocolMethod 的完成回调对象。

import (
	"encoding/base64"
	"fmt"
	"runtime"
	"sync"
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

// ---- 完成回调 handler 存活登记 ----

// 超时返回后 handler 仍可能被原生侧**晚到**的回调触发（CapturePreview 在页面渲染
// 繁忙或控件隐藏时会拖过超时；快照轮询用的正是 300ms 短超时）。若此时 Go 对象已被
// GC 回收，回调会写进已释放内存（use-after-free），进程可能在随后的任意时刻被
// 堆校验/野指针直接终止——无日志、无 WER，只表现为「网页一开程序就没了」
// （2026-11-17 按此模式修复）。登记表把 handler 钉住，收到回调再释放；
// 超时且回调永不到达时只留一个几十字节的登记项，代价可接受。
var (
	browserHandlerMu   sync.Mutex
	browserHandlerLive = map[uintptr]any{}
)

func browserHandlerRetain(h any, ptr uintptr) {
	browserHandlerMu.Lock()
	browserHandlerLive[ptr] = h
	browserHandlerMu.Unlock()
}

func browserHandlerRelease(ptr uintptr) {
	browserHandlerMu.Lock()
	delete(browserHandlerLive, ptr)
	browserHandlerMu.Unlock()
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
	h := &browserCDPHandler{vtbl: &browserCDPHandlerVtblStatic, resultCh: make(chan browserCDPResult, 1)}
	browserHandlerRetain(h, uintptr(unsafe.Pointer(h)))
	return h
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
	select {
	case handler.resultCh <- browserCDPResult{errCode: errorCode, json: payload}:
	default: // 重复派发：只留第一份结果，不能阻塞原生回调线程
	}
	atomic.StoreUint32(&handler.done, 1)
	browserHandlerRelease(this)
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

// wvNavCompletedStatus 读 NavigationCompleted 的 IsSuccess 与 WebErrorStatus
// （ICoreWebView2NavigationCompletedEventArgs 槽位 3/4；库只导出 AddRef/Release）。
func wvNavCompletedStatus(args *edge.ICoreWebView2NavigationCompletedEventArgs) (bool, int32) {
	if args == nil {
		return true, 0
	}
	raw := (*wvRaw)(unsafe.Pointer(args))
	var success int32
	hr, _, _ := syscall.SyscallN(raw.vtbl[3], uintptr(unsafe.Pointer(args)), uintptr(unsafe.Pointer(&success)))
	if hr != 0 {
		return true, 0 // 读不到就按成功处理，别把诊断信息当成错误
	}
	var errStatus int32
	hr, _, _ = syscall.SyscallN(raw.vtbl[4], uintptr(unsafe.Pointer(args)), uintptr(unsafe.Pointer(&errStatus)))
	if hr != 0 {
		errStatus = 0
	}
	return success != 0, errStatus
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
		// 调用没发出去就不会有回调：释放存活登记，避免每失败一次泄漏一项
		browserHandlerRelease(uintptr(unsafe.Pointer(handler)))
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
	h := &browserCaptureHandler{vtbl: &browserCaptureHandlerVtblStatic}
	browserHandlerRetain(h, uintptr(unsafe.Pointer(h)))
	return h
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
	browserHandlerRelease(this)
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
	// wvProc 是 (*wvRaw)(unsafe.Pointer(wv)).vtbl[slot]——wv 为 nil 就是空指针解引用，
	// 而这层没有 guardCallback（跑在宿主线程任务里，不是 COM 回调帧），panic 直接带走
	// 整个进程。调用方目前都先查了 inst.webview，但那只是约定；这里做构造性防御。
	if wv == nil {
		return "", fmt.Errorf("截图失败：webview 句柄为空（标签页未就绪或已销毁）")
	}
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
		browserHandlerRelease(uintptr(unsafe.Pointer(handler)))
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

// ---- 抓图前的「等一帧」与空白帧兜底 ----

const (
	// browserCapturePaintScript 等两组 rAF：Show() 之后 webview 会先交出一个空白帧，
	// 立刻 CapturePreview 拿到的就是整幅白图（2026-11-15 实测：首张空白，隔几秒再抓正常）。
	// 双 rAF 落在「第一帧已提交」之后，比固定 sleep 稳，也不白等。
	browserCapturePaintScript = `new Promise(function (resolve) {
  if (typeof requestAnimationFrame !== 'function') { resolve(1); return; }
  requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(1); }); });
})`
	// browserCapturePaintTimeout 等帧上限：页面被暂停（后台标签）时 rAF 不回调，
	// 超时即继续抓图——这一小段等待不能变成新的 30s 卡死点。
	browserCapturePaintTimeout = 600 * time.Millisecond
	// browserCaptureBlankB64 空白帧判据：整幅单色 PNG 压缩后极小（实测 480x320 空白 < 1 KB），
	// 带内容的页面 base64 远超此值。只用长度判断，不引入 image/png 解码器的体积。
	browserCaptureBlankB64 = 2048
	// browserCaptureAttempts 抓图尝试次数（首抓 + 至多两次重试）
	browserCaptureAttempts = 3
)

// wvWaitForPaint 尽力等一次「页面已合成一帧」；失败或超时都直接返回，不影响后续抓图。
// 必须在宿主线程调用（ExecuteScript 的完成回调要靠宿主泵）。
func wvWaitForPaint(wv *edge.ICoreWebView2, timeout time.Duration) {
	handler, err := wvCallExecScriptStart(wv, browserCapturePaintScript)
	if err != nil {
		return
	}
	_, _ = handler.waitPump(timeout)
}

// browserCaptureLooksBlank 判断一次抓图是否可疑为空白帧（整幅单色时 base64 极短）。
func browserCaptureLooksBlank(b64 string) bool {
	return len(b64) < browserCaptureBlankB64
}

// browserCaptureWithRetry 抓图并在拿到可疑空白帧时重试：合成未就绪的空白帧是暂态，
// 等一帧再抓通常就好。真·空白页（about:blank）会走满 attempts 次，所以不报错、只多等
// 一两帧；抓图本身出错则立刻返回，不重试（错误信息比空图更可信）。
func browserCaptureWithRetry(capture func() (string, error), waitFrame func(), attempts int) (string, error) {
	if attempts < 1 {
		attempts = 1
	}
	var shot string
	var err error
	for i := 0; i < attempts; i++ {
		if i > 0 && waitFrame != nil {
			waitFrame()
		}
		if shot, err = capture(); err != nil {
			return shot, err
		}
		if !browserCaptureLooksBlank(shot) {
			return shot, nil
		}
	}
	return shot, nil
}
