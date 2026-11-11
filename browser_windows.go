//go:build windows

package main

// 浏览器使用标签页内核：宿主线程（STA + 消息泵）上创建/操作嵌入式 WebView2，
// 绑定方法从 Wails goroutine 封送任务到宿主线程执行。
// CDP 槽位调用见 browser_com_windows.go。

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

const (
	browserDispatchMsg = 0xBACC // 消息窗口私有任务派发消息
	browserCDPTimeout  = 30 * time.Second
	browserJobTimeout  = 60 * time.Second // 单任务看门狗（Embed 创建最长约 20s）
)

var (
	browserUser32                        = syscall.NewLazyDLL("user32.dll")
	procBrowserRegisterClassW            = browserUser32.NewProc("RegisterClassExW")
	procBrowserCreateWindowEx            = browserUser32.NewProc("CreateWindowExW")
	procBrowserDefWindowProcW            = browserUser32.NewProc("DefWindowProcW")
	procBrowserGetMessageW               = browserUser32.NewProc("GetMessageW")
	procBrowserTranslateMsg              = browserUser32.NewProc("TranslateMessage")
	procBrowserDispatchMsg               = browserUser32.NewProc("DispatchMessageW")
	procBrowserPostMessageW              = browserUser32.NewProc("PostMessageW")
	procBrowserShowWindow                = browserUser32.NewProc("ShowWindow")
	procBrowserDestroyWindow             = browserUser32.NewProc("DestroyWindow")
	procBrowserPeekMessageW              = browserUser32.NewProc("PeekMessageW")
	procBrowserMsgWaitForMultipleObjects = browserUser32.NewProc("MsgWaitForMultipleObjects")

	browserOle32Host          = syscall.NewLazyDLL("ole32.dll")
	procBrowserCoInitializeEx = browserOle32Host.NewProc("CoInitializeEx")
	procBrowserCoUninitialize = browserOle32Host.NewProc("CoUninitialize")

	browserKernel32Host        = syscall.NewLazyDLL("kernel32.dll")
	procBrowserGetModuleHandle = browserKernel32Host.NewProc("GetModuleHandleW")
)

type browserMsg struct {
	hwnd     uintptr
	message  uint32
	wParam   uintptr
	lParam   uintptr
	time     uint32
	ptX, ptY int32
}

// ---- 宿主线程 ----

var (
	browserHostOnce  sync.Once
	browserHostTasks chan func()
	browserHostHWND  uintptr
	browserHostReady chan struct{}
)

func browserHostWndProc(hwnd, msg, wParam, lParam uintptr) uintptr {
	if msg == browserDispatchMsg {
		for {
			select {
			case task := <-browserHostTasks:
				runBrowserTask(task)
			default:
				return 0
			}
		}
	}
	r, _, _ := procBrowserDefWindowProcW.Call(hwnd, msg, wParam, lParam)
	return r
}

func runBrowserTask(task func()) {
	defer func() {
		if r := recover(); r != nil {
			writeAppLog("ERROR", "浏览器宿主任务崩溃：%v", r)
		}
	}()
	task()
}

func browserHostLoop() {
	runtime.LockOSThread()
	// COINIT_APARTMENTTHREADED（OLE 消息过滤会与 WebView2 的事件派发冲突，见调试记录）
	hr, _, _ := procBrowserCoInitializeEx.Call(0, 2)
	if hr != uintptr(windows.S_OK) && hr != uintptr(windows.S_FALSE) && hr != 0x00000001 { // RPC_E_CHANGED_MODE
		writeAppLog("ERROR", "browser-host CoInitializeEx 失败 0x%08x", hr)
		close(browserHostReady)
		return
	}
	defer procBrowserCoUninitialize.Call()

	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	classPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserHost")
	var wc struct {
		cbSize, style               uint32
		lpfnWndProc                 uintptr
		cbClsExtra, cbWndExtra      int32
		hInstance, hIcon, hCursor   uintptr
		hbrBackground, lpszMenuName uintptr
		lpszClassName, hIconSm      uintptr
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	wc.lpfnWndProc = syscall.NewCallback(browserHostWndProc)
	wc.hInstance = hinst
	wc.lpszClassName = uintptr(unsafe.Pointer(classPtr))
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		writeAppLog("ERROR", "browser-host 注册窗口类失败")
		close(browserHostReady)
		return
	}
	// HWND_MESSAGE = -3（message-only 窗口）
	browserHostHWND, _, _ = procBrowserCreateWindowEx.Call(
		0, uintptr(unsafe.Pointer(classPtr)), 0, 0,
		0, 0, 0, 0, ^uintptr(2), 0, hinst, 0)
	close(browserHostReady)

	// COM STA 标准泵：MsgWaitForMultipleObjects + PeekMessage（阻塞 GetMessage 下
	// WebView2 的回调派发会异常终止进程，见 2026-11-11 调试记录）
	var msg browserMsg
	for {
		for {
			select {
			case task := <-browserHostTasks:
				runBrowserTask(task)
			default:
				goto pump
			}
		}
	pump:
		for {
			r, _, _ := procBrowserPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1) // PM_REMOVE
			if r == 0 || int32(r) == -1 {
				break
			}
			procBrowserTranslateMsg.Call(uintptr(unsafe.Pointer(&msg)))
			procBrowserDispatchMsg.Call(uintptr(unsafe.Pointer(&msg)))
		}
		procBrowserMsgWaitForMultipleObjects.Call(0, 0, 0, 50, 0x4FF) // QS_ALLINPUT，最多等 50ms
	}
}

// browserHostRun 在宿主线程上执行任务并等待完成；任务内错误经闭包变量传递。
// 带看门狗：宿主线程卡死（如 WebView2 controller 创建失败时库的内联泵不会解除阻塞）时返回超时错误，不拖死调用方。
func browserHostRun(task func()) error {
	browserHostOnce.Do(func() {
		browserHostTasks = make(chan func(), 64)
		browserHostReady = make(chan struct{})
		go browserHostLoop()
	})
	<-browserHostReady
	done := make(chan error, 1)
	browserHostTasks <- func() {
		defer func() {
			if r := recover(); r != nil {
				select {
				case done <- fmt.Errorf("任务异常：%v", r):
				default:
				}
			}
		}()
		task()
		select {
		case done <- nil:
		default:
		}
	}
	r, _, _ := procBrowserPostMessageW.Call(browserHostHWND, browserDispatchMsg, 0, 0)
	if r == 0 {
		return fmt.Errorf("浏览器宿主调度失败")
	}
	select {
	case err := <-done:
		return err
	case <-time.After(browserJobTimeout):
		return fmt.Errorf("浏览器任务超时（%.0fs），宿主线程可能已卡住", browserJobTimeout.Seconds())
	}
}

// ---- 实例管理 ----

type browserInstance struct {
	id         string
	profileKey string
	chromium   *edge.Chromium
	webview    *edge.ICoreWebView2
	url        string
	title      string
	canGoBack  bool
	canGoFwd   bool
	loading    bool
	visible    bool
	emit       func(event string, data interface{})
}

var (
	browserMu        sync.Mutex
	browserInstances = map[string]*browserInstance{}
)

// browserParentHWND 返回 WebView2 控件的宿主父窗口（生产 = Wails 主窗口；测试可替换）。
var browserParentHWND = findWailsWindow

func browserGet(id string) *browserInstance {
	browserMu.Lock()
	defer browserMu.Unlock()
	return browserInstances[id]
}

// browserRefreshState 导航状态刷新（宿主线程调用），并向前端发 browser-nav 事件。
func browserRefreshState(inst *browserInstance) {
	if inst.webview == nil {
		return
	}
	if url, err := inst.webview.GetSource(); err == nil {
		inst.url = url
	}
	if title, err := wvStringOut(inst.webview, wvSlotGetDocumentTitle); err == nil {
		inst.title = title
	}
	if back, err := wvInt32Out(inst.webview, wvSlotGetCanGoBack); err == nil {
		inst.canGoBack = back != 0
	}
	if fwd, err := wvInt32Out(inst.webview, wvSlotGetCanGoForward); err == nil {
		inst.canGoFwd = fwd != 0
	}
	if inst.emit != nil {
		inst.emit("browser-nav", map[string]interface{}{
			"id": inst.id, "url": inst.url, "title": inst.title,
			"canGoBack": inst.canGoBack, "canGoForward": inst.canGoFwd, "loading": inst.loading,
		})
	}
}

// browserCreateOnHost 在宿主线程上创建实例（Embed 自带消息泵，同步等到 controller 就绪）。
func browserCreateOnHost(inst *browserInstance, hwnd uintptr) error {
	c := edge.NewChromium()
	// 默认错误处理会 os.Exit(1)，必须替换成回调
	c.SetErrorCallback(func(err error) {
		// 库的 errorCallback 在回调后无条件 os.Exit(1)；这里主动 panic 留下错误栈
		// （同步路径会被 runBrowserJob recover，COM 回调线程则 crash 留栈——均好过静默退出）
		panic(fmt.Errorf("browser-%s：%w", inst.id, err))
	})
	c.DataPath = filepath.Join(appDataRoot(), "BrowserSessions", sanitizeBrowserProfileKey(inst.id+"_"+inst.profileKey))
	c.NavigationCompletedCallback = func(sender *edge.ICoreWebView2, args *edge.ICoreWebView2NavigationCompletedEventArgs) {
		inst.loading = false
		browserRefreshState(inst)
	}
	c.ProcessFailedCallback = func(sender *edge.ICoreWebView2, args *edge.ICoreWebView2ProcessFailedEventArgs) {
		inst.loading = false
		if inst.emit != nil {
			inst.emit("browser-error", map[string]interface{}{"id": inst.id})
		}
	}
	inst.chromium = c
	if !c.Embed(hwnd) {
		return fmt.Errorf("创建浏览器控件失败")
	}
	wv, err := c.GetController().GetCoreWebView2()
	if err != nil {
		return fmt.Errorf("获取浏览器内核失败：%w", err)
	}
	inst.webview = wv
	if err := wvInitScript(wv, `window.__cadtHost = 'datalens';`); err != nil {
		return err
	}
	inst.visible = true
	if inst.url != "" && inst.url != "about:blank" {
		if err := wvNavigate(wv, inst.url); err != nil {
			return err
		}
		inst.loading = true
	}
	return nil
}

// ---- App 绑定方法 ----

func (a *App) BrowserOpen(id, url, profileKey string) (map[string]string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("id 不能为空")
	}
	profileKey = strings.TrimSpace(profileKey)
	if profileKey == "" {
		profileKey = "default"
	}
	if strings.TrimSpace(url) == "" {
		url = "about:blank"
	}
	browserMu.Lock()
	if len(browserInstances) >= browserMaxInstances {
		browserMu.Unlock()
		return nil, fmt.Errorf("浏览器标签页最多同时 %d 个，请先关闭一些", browserMaxInstances)
	}
	if browserInstances[id] != nil {
		browserMu.Unlock()
		return nil, fmt.Errorf("浏览器标签页 %s 已存在", id)
	}
	emit := func(event string, data interface{}) {
		if a.ctx != nil {
			wruntime.EventsEmit(a.ctx, event, data)
		}
	}
	inst := &browserInstance{id: id, profileKey: profileKey, url: url, emit: emit}
	browserInstances[id] = inst
	browserMu.Unlock()

	hwnd := browserParentHWND()
	if hwnd == 0 {
		browserMu.Lock()
		delete(browserInstances, id)
		browserMu.Unlock()
		return nil, fmt.Errorf("找不到主窗口")
	}
	var createErr error
	jobErr := browserHostRun(func() {
		createErr = browserCreateOnHost(inst, hwnd)
	})
	if jobErr != nil || createErr != nil {
		browserMu.Lock()
		delete(browserInstances, id)
		browserMu.Unlock()
		if jobErr != nil {
			return nil, jobErr
		}
		return nil, createErr
	}
	return map[string]string{"id": inst.id, "url": inst.url, "title": inst.title}, nil
}

func browserWrapErr(id string, err error) error {
	if err != nil {
		return err
	}
	return fmt.Errorf("浏览器标签页未就绪：%s", id)
}

func (a *App) BrowserNavigate(id string, url string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.chromium == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在或未就绪：%s", id)
			return
		}
		inst.loading = true
		if taskErr = wvNavigate(inst.webview, url); taskErr != nil {
			return
		}
		// 任务内泵等导航完成（回调依赖宿主线程泵）；超时不视为错误，状态事件照发
		deadline := time.Now().Add(3 * time.Second)
		var msg browserMsg
		for time.Now().Before(deadline) && inst.loading {
			r, _, _ := procBrowserPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1)
			if r != 0 && int32(r) != -1 {
				procBrowserTranslateMsg.Call(uintptr(unsafe.Pointer(&msg)))
				procBrowserDispatchMsg.Call(uintptr(unsafe.Pointer(&msg)))
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserGoBack(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		taskErr = wvGoBack(inst.webview)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserGoForward(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		taskErr = wvGoForward(inst.webview)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserReload(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		inst.loading = true
		taskErr = wvReload(inst.webview)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserStop(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		taskErr = wvStop(inst.webview)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserState(id string) (map[string]interface{}, error) {
	var state map[string]interface{}
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		browserRefreshState(inst)
		state = map[string]interface{}{
			"id": inst.id, "url": inst.url, "title": inst.title,
			"canGoBack": inst.canGoBack, "canGoForward": inst.canGoFwd, "loading": inst.loading,
		}
	})
	if jobErr != nil {
		return nil, jobErr
	}
	return state, taskErr
}

// jsonStringValue 把字符串编码为 JSON 字符串字面量（表达式内嵌用）。
func jsonStringValue(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

func (a *App) BrowserEval(id string, script string) (string, error) {
	var result string
	var handler *browserCDPHandler
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		handler, taskErr = wvCallExecScriptStart(inst.webview, script)
		if taskErr != nil {
			return
		}
		result, taskErr = handler.waitPump(browserCDPTimeout)
	})
	if jobErr != nil {
		return "", jobErr
	}
	return result, taskErr
}

// BrowserCallCDP 直连 DevTools Protocol 通道。CallDevToolsProtocolMethod（槽位 36）
// 在部分 WebView2 环境调用即崩溃（2026-11-11 调试记录，与 handler 实现无关），暂不开放；
// 截图走 BrowserCaptureScreenshot（CapturePreview），页面脚本走 BrowserEval（ExecuteScript）。
func (a *App) BrowserCallCDP(id string, method string, paramsJSON string) (string, error) {
	if browserGet(id) == nil {
		return "", fmt.Errorf("浏览器标签页不存在：%s", id)
	}
	return "", fmt.Errorf("CDP 通道暂不可用（%s）", method)
}

// BrowserCaptureScreenshot 抓取当前页面为 PNG，返回 base64。
func (a *App) BrowserCaptureScreenshot(id string) (string, error) {
	var result string
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		result, taskErr = wvCaptureScreenshot(inst.webview, browserCDPTimeout)
	})
	if jobErr != nil {
		return "", jobErr
	}
	return result, taskErr
}

func (a *App) BrowserSetBounds(id string, x int, y int, w int, h int) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		if inst.chromium == nil {
			return
		}
		if w <= 0 || h <= 0 {
			if inst.visible {
				_ = inst.chromium.Hide()
				inst.visible = false
			}
			return
		}
		bounds := edge.Rect{Left: int32(x), Top: int32(y), Right: int32(x + w), Bottom: int32(y + h)}
		inst.chromium.ResizeWithBounds(&bounds)
		if !inst.visible {
			_ = inst.chromium.Show()
			inst.visible = true
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserSetVisible(id string, visible bool) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		if inst.chromium == nil || inst.visible == visible {
			return
		}
		if visible {
			_ = inst.chromium.Show()
			inst.chromium.Focus()
		} else {
			_ = inst.chromium.Hide()
		}
		inst.visible = visible
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserFocus(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		if inst.chromium != nil {
			inst.chromium.Focus()
			_ = inst.chromium.Show()
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (a *App) BrowserClose(id string) error {
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			return // 已不存在视为成功
		}
		if inst.chromium != nil {
			inst.chromium.ShuttingDown()
			_ = inst.chromium.Hide()
		}
		browserMu.Lock()
		delete(browserInstances, inst.id)
		browserMu.Unlock()
	})
	return jobErr
}
