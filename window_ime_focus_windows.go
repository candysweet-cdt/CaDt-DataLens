//go:build windows

package main

// window_ime_focus_windows.go：窗口重新激活后把焦点重新送回网页，修复输入法候选框飘到屏幕左上角。
//
// 现象：微软拼音等走系统 TSF 的输入法，在本应用窗口「失活 → 重新激活」之后，候选框/组词窗
// 画在屏幕左上角，而文字仍正确上屏。前提是焦点原本停在输入框上、且激活时焦点被「自动/隐式」
// 还给了该输入框（把别的窗口最小化即可复现，记事本规模即可；与全屏、窗口大小、是否正在组词
// 都无关，也不需要第二个本应用窗口）。此时点输入框无效——焦点本来就在它身上，点击不产生
// focus 变化；必须先点软件其他位置让输入框真正失焦、再点回来才能恢复。Esc 取消组词同样无效。
//
// 根因：Wails 在 WM_ACTIVATE(WA_ACTIVE/WA_CLICKACTIVE) 与 WM_SETFOCUS 里**同步**调用
// ICoreWebView2Controller::MoveFocus(PROGRAMMATIC)，此刻 Windows 仍在激活窗口的过程中，
// WebView2 的 TSF 输入状态因此被破坏（text store 返回过期布局 / TS_E_NOLAYOUT），输入法只能
// 把候选窗画到屏幕原点。上游同款分析见 https://github.com/wailsapp/wails/issues/6595 与
// PR #6596；同一缺陷在 tauri-apps/wry#1908 / #1924 有独立复现与修复。
//
// 本文件是应用层的缓解：激活完成之后**再送一次**焦点，让 TSF 重新登记输入上下文。
//
// 时序安全性：动作用 application.InvokeAsync 投到 UI 线程，必然排在触发它的窗口过程之后，
// 所以不存在「抢在激活结束之前」的可能；imeRepairDelay 只是留给原生焦点消息铺开的时间。
//
// 已知代价：每次激活多一次 MoveFocus（输入法内部状态被重置一次）。属症状级缓解而非根治，
// 上游合并 #6596 后本文件可整体删除。

import (
	"fmt"
	"os"
	"reflect"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	// imeRepairDelay 是激活事件到「重新送焦点」之间的余量。实测：60ms 有效；
	// 250ms 会打断正在进行的组词（候选框闪一下即消失），故取中间值。
	imeRepairDelay = 50 * time.Millisecond
	// imeRepairMinGap 是同一窗口两次动作的最小间隔，避免快速切换窗口时连续打断输入。
	imeRepairMinGap = 150 * time.Millisecond
	// gaRoot 是 GetAncestor 的 GA_ROOT。
	gaRoot = 2
)

var (
	imeUser32          = syscall.NewLazyDLL("user32.dll")
	procImeGetFgWnd    = imeUser32.NewProc("GetForegroundWindow")
	procImeGetFocus    = imeUser32.NewProc("GetFocus")
	procImeGetAncestor = imeUser32.NewProc("GetAncestor")
	procImeGetThreadPID = imeUser32.NewProc("GetWindowThreadProcessId")
)

// imeRepairKind 是守卫的判定结论；抽成纯函数便于表驱动测试。
type imeRepairKind int

const (
	imeRepairOK       imeRepairKind = iota // 该动作：焦点在主 webview 子窗口上，属于坏态
	imeNoForeground                        // 前台已不是本窗口（用户切走了），不抢
	imeNoFocus                             // 焦点在别的线程/进程队列里
	imeFocusOnHost                         // 焦点在宿主窗口自己身上：Tab 出页面的交接态
	imeFocusInOwnProcess                   // 焦点窗口属于本进程：内嵌浏览器控件等，不抢
	imeFocusElsewhere                      // 焦点在本窗口之外的窗口
)

func (k imeRepairKind) String() string {
	switch k {
	case imeRepairOK:
		return "ok"
	case imeNoForeground:
		return "前台已切换"
	case imeNoFocus:
		return "焦点不在本线程"
	case imeFocusOnHost:
		return "焦点在宿主窗口(Tab交接态)"
	case imeFocusInOwnProcess:
		return "焦点在本进程的其它控件(内嵌浏览器等)"
	case imeFocusElsewhere:
		return "焦点在其它窗口"
	}
	return "未知"
}

// imeRepairInput 汇总一次判定所需的全部事实；都是纯数据，便于表驱动单测。
type imeRepairInput struct {
	Foreground   uintptr // GetForegroundWindow()
	Focus        uintptr // GetFocus()
	Hwnd         uintptr // 本窗口
	RootOfFocus  uintptr // GetAncestor(Focus, GA_ROOT)
	FocusPid     uint32  // 焦点窗口所属进程
	SelfPid      uint32  // 本进程 pid
}

// decideIMERepair 判断是否该重新送焦点。
//
// 口径全部来自实测（Win10 22H2 + 微软拼音）：
//   - 坏态：焦点落在主 webview 的 Chrome_WidgetWin_1，它属于 msedgewebview2 进程（pid≠本进程），
//     根祖先正是宿主窗口 → 该动作；
//   - Tab 出页面：焦点停在宿主窗口自己身上（日志里出现过「焦点=WailsWebviewWindow」）→ 不动；
//   - 内嵌浏览器标签：它的控件窗口 Chrome_WidgetWin_0 由**本进程**创建（pid=本进程），
//     与主 webview 分属不同进程——用 pid 就能区分，不必去查浏览器实例表。
func decideIMERepair(in imeRepairInput) imeRepairKind {
	if in.Hwnd == 0 {
		return imeFocusElsewhere
	}
	if in.Foreground != in.Hwnd {
		return imeNoForeground
	}
	if in.Focus == 0 {
		return imeNoFocus
	}
	if in.Focus == in.Hwnd {
		return imeFocusOnHost
	}
	if in.SelfPid != 0 && in.FocusPid == in.SelfPid {
		return imeFocusInOwnProcess
	}
	if in.RootOfFocus != in.Hwnd {
		return imeFocusElsewhere
	}
	return imeRepairOK
}

// imeRepairState 记录单窗口的防抖状态。
type imeRepairState struct {
	mu      sync.Mutex
	last    time.Time // 上次动作成功时刻
	pending bool      // 已排了一次动作、尚未落定
}

// claim 在排队前占位：过密或已有待执行的动作时返回 false。
// 只占位不记账——动作失败要能被下一个激活事件重试。
func (s *imeRepairState) claim(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending {
		return false
	}
	if !s.last.IsZero() && now.Sub(s.last) < imeRepairMinGap {
		return false
	}
	s.pending = true
	return true
}

// settle 在一次尝试后落定：成功则记账，失败只释放占位。
func (s *imeRepairState) settle(ok bool) {
	s.mu.Lock()
	s.pending = false
	if ok {
		s.last = time.Now()
	}
	s.mu.Unlock()
}

// attachIMEFocusRepair 给一个窗口挂上修复，返回解绑函数。
func attachIMEFocusRepair(w *application.WebviewWindow) func() {
	if w == nil {
		return func() {}
	}
	state := &imeRepairState{}
	schedule := func(source string) {
		if !state.claim(time.Now()) {
			writeAppLog("debug", "ime-focus: 防抖跳过（来源=%s）", source)
			return
		}
		time.AfterFunc(imeRepairDelay, func() {
			// 用 InvokeAsync 而不是 InvokeSync：窗口/应用在 50ms 内被关掉时，
			// 同步等待会因为没有主循环派发而永久挂住一个 goroutine。
			application.InvokeAsync(func() {
				defer func() {
					if r := recover(); r != nil {
						state.settle(false)
						writeAppLog("warn", "ime-focus: 修复过程 panic：%v", r)
					}
				}()
				state.settle(repairIMEFocus(w, source))
			})
		})
	}

	// 三条激活路径分别订阅：WA_ACTIVE / WA_CLICKACTIVE / WM_SETFOCUS。
	offs := []func(){
		w.OnWindowEvent(events.Windows.WindowActive, func(*application.WindowEvent) { schedule("activate") }),
		w.OnWindowEvent(events.Windows.WindowClickActive, func(*application.WindowEvent) { schedule("click-activate") }),
		w.OnWindowEvent(events.Windows.WindowSetFocus, func(*application.WindowEvent) { schedule("set-focus") }),
	}
	return func() {
		for _, off := range offs {
			if off != nil {
				off()
			}
		}
	}
}

// repairIMEFocus 必须在 UI 线程执行；返回是否真的动作了（供防抖记账）。
func repairIMEFocus(w *application.WebviewWindow, source string) bool {
	hwnd := uintptr(w.NativeWindow())
	foreground, _, _ := procImeGetFgWnd.Call()
	focus, _, _ := procImeGetFocus.Call()
	var root uintptr
	var focusPid uint32
	if focus != 0 {
		root, _, _ = procImeGetAncestor.Call(focus, gaRoot)
		_, _, _ = procImeGetThreadPID.Call(focus, uintptr(unsafe.Pointer(&focusPid)))
	}
	in := imeRepairInput{
		Foreground:  foreground,
		Focus:       focus,
		Hwnd:        hwnd,
		RootOfFocus: root,
		FocusPid:    focusPid,
		SelfPid:     uint32(os.Getpid()),
	}
	if kind := decideIMERepair(in); kind != imeRepairOK {
		writeAppLog("debug", "ime-focus: 跳过(%s) 来源=%s foreground=%#x focus=%#x hwnd=%#x",
			kind, source, foreground, focus, hwnd)
		return false
	}
	ch, err := chromiumOf(w)
	if err != nil {
		writeAppLog("debug", "ime-focus: 取 chromium 失败：%v", err)
		return false
	}
	ctrl := ch.GetController()
	if ctrl == nil {
		writeAppLog("debug", "ime-focus: controller 未就绪（来源=%s）", source)
		return false
	}
	if err := ctrl.MoveFocus(edge.COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC); err != nil {
		writeAppLog("warn", "ime-focus: MoveFocus 失败：%v", err)
		return false
	}
	writeAppLog("debug", "ime-focus: 已重新送焦点（来源=%s focus=%#x pid=%d）", source, focus, focusPid)
	return true
}

// chromiumOf 反射取窗口内部持有的 WebView2 封装。
// 路径：*application.WebviewWindow → impl 接口 → *windowsWebviewWindow → chromium。
// 这是本文件唯一一处「越界」：Wails 未导出 controller，仓库内已有同款先例
// （platform_windows.go 的 OpenDevTools 同样反射取 chromium）。
func chromiumOf(w *application.WebviewWindow) (ch *edge.Chromium, err error) {
	defer func() {
		if r := recover(); r != nil {
			ch, err = nil, fmt.Errorf("反射 panic：%v", r)
		}
	}()
	v := reflect.ValueOf(w)
	if v.Kind() != reflect.Ptr || v.IsNil() {
		return nil, fmt.Errorf("窗口类型异常")
	}
	v = v.Elem()
	implField := v.FieldByName("impl")
	if !implField.IsValid() {
		return nil, fmt.Errorf("无 impl 字段")
	}
	implPtr := reflect.NewAt(implField.Type(), unsafe.Pointer(implField.UnsafeAddr())).Elem()
	concrete := implPtr.Elem()
	if concrete.Kind() != reflect.Ptr || concrete.IsNil() {
		return nil, fmt.Errorf("impl 为空")
	}
	chromiumField := concrete.Elem().FieldByName("chromium")
	if !chromiumField.IsValid() {
		return nil, fmt.Errorf("无 chromium 字段")
	}
	ptr := reflect.NewAt(chromiumField.Type(), unsafe.Pointer(chromiumField.UnsafeAddr())).Elem().UnsafePointer()
	if ptr == nil {
		return nil, fmt.Errorf("chromium 未初始化")
	}
	return (*edge.Chromium)(ptr), nil
}
