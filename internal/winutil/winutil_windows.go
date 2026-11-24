//go:build windows

package winutil

// winutil_windows.go：所有 Windows 平台能力的实现，由 4 个同 build tag 的文件合并
// （console_windows / windowhide_windows / webview_args_windows / cursors_windows）。
// Go 的 //go:build 是文件级的，tag 相同的文件合并不改变编译语义。非 Windows 对应
// 实现在 winutil_other.go。

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// ==================== 控制台附着（原 console_windows.go） ====================

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	procAttachConsole = kernel32.NewProc("AttachConsole")
)

// attachParentProcess 是 AttachConsole 的伪参数（ATTACH_PARENT_PROCESS）。
const attachParentProcess = uintptr(0xFFFFFFFF)

func bindStdHandle(handle uint32, name string) *os.File {
	h, err := windows.GetStdHandle(handle)
	if err != nil || h == 0 || h == windows.InvalidHandle {
		return nil
	}
	return os.NewFile(uintptr(h), name)
}

// AttachParentConsole 让 GUI 子系统进程在命令行启动时能向父控制台/管道输出。
// 已存在的重定向句柄优先保留，不能因为 AttachConsole 覆盖掉管道/文件重定向。
func AttachParentConsole() {
	out := bindStdHandle(windows.STD_OUTPUT_HANDLE, "stdout")
	errOut := bindStdHandle(windows.STD_ERROR_HANDLE, "stderr")
	if out != nil {
		os.Stdout = out
	}
	if errOut != nil {
		os.Stderr = errOut
	}
	if out != nil && errOut != nil {
		return
	}
	_, _, _ = procAttachConsole.Call(attachParentProcess)
	if out == nil {
		if f := bindStdHandle(windows.STD_OUTPUT_HANDLE, "stdout"); f != nil {
			os.Stdout = f
		}
	}
	if errOut == nil {
		if f := bindStdHandle(windows.STD_ERROR_HANDLE, "stderr"); f != nil {
			os.Stderr = f
		}
	}
}

// ==================== 异步隐藏窗口（原 windowhide_windows.go） ====================

var procHideShowWindowAsync = syscall.NewLazyDLL("user32.dll").NewProc("ShowWindowAsync")

// swHide 对应 Win32 SW_HIDE。
const swHide = 0

// HideWindowAsync 异步隐藏原生窗口；hwnd 来自 WebviewWindow.NativeWindow()。
//
// 为什么不用 Wails 的 WebviewWindow.Hide()：它内部是 InvokeSync（派发到主线程并等待
// 返回），而 WindowClosing 钩子跑在 v3 的事件 goroutine 上——主线程那一刻若正卡在
// windowEvents（容量 5）的发送里，就成了「事件 goroutine 等主线程、主线程等事件
// goroutine」的互锁，表现是关不掉、只能结束进程。ShowWindowAsync 只投递不等待，
// 主线程下一轮消息循环处理即可；最坏情况是没来得及藏（退化成改动前的表现），不会锁死。
func HideWindowAsync(hwnd unsafe.Pointer) {
	if hwnd == nil {
		return
	}
	_, _, _ = procHideShowWindowAsync.Call(uintptr(hwnd), swHide)
}

// ==================== WebView2 参数注入（原 webview_args_windows.go） ====================

// SetWebViewExtraBrowserArguments 在 wails.Run（创建 WebView2 环境）之前注入
// Chromium 参数。走本地补丁 go-webview2 的显式注入点；直接设
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 会被上游清空，见
// third_party/go-webview2/webviewloader/app_browser_args.go。
func SetWebViewExtraBrowserArguments(args string) {
	webviewloader.ExtraBrowserArguments = args
}

// ==================== 系统光标（原 cursors_windows.go） ====================

// cursorBaseSize 读取 Windows 光标逻辑基准尺寸（设置→辅助功能→鼠标指针大小，默认 32）。
// CSS 光标不会跟随系统辅助功能放大，前端用它换算 image-set 的 1x 档位才能与系统光标一致。
func cursorBaseSize() int {
	if key, err := registry.OpenKey(registry.CURRENT_USER, `Control Panel\Cursors`, registry.QUERY_VALUE); err == nil {
		defer key.Close()
		if v, _, err := key.GetIntegerValue("CursorBaseSize"); err == nil && v >= 16 && v <= 128 {
			return int(v)
		}
	}
	return 32
}

// resolveSystemCursor 解析一类调整光标为 data URL。
// 优先级：注册表当前主题（跟随用户自定义光标）→ 系统内置候选文件（aero: Vista+，hsplit/vsplit: 老系统兜底）。
func resolveSystemCursor(kind string) string {
	regNames := map[string]string{
		"ew":   "SizeWE",
		"ns":   "SizeNS",
		"nwse": "SizeNWSE",
		"nesw": "SizeNESW",
		"move": "Move",
	}
	candidates := map[string][]string{
		"ew":   {"aero_ew.cur", "hsplit.cur"},
		"ns":   {"aero_ns.cur", "vsplit.cur"},
		"nwse": {"aero_nwse.cur"},
		"nesw": {"aero_nesw.cur"},
		"move": {"aero_move.cur"},
	}
	windir := os.Getenv("WINDIR")
	if windir == "" {
		windir = `C:\Windows`
	}
	cursDir := filepath.Join(windir, "Cursors")
	tryRead := func(path string) (string, bool) {
		if path == "" {
			return "", false
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(cursDir, path)
		}
		if !strings.EqualFold(filepath.Ext(path), ".cur") {
			return "", false
		}
		data, err := os.ReadFile(path)
		if err != nil || len(data) < 4 {
			return "", false
		}
		return "data:image/x-icon;base64," + base64.StdEncoding.EncodeToString(data), true
	}
	if name := regNames[kind]; name != "" {
		if key, err := registry.OpenKey(registry.CURRENT_USER, `Control Panel\Cursors`, registry.QUERY_VALUE); err == nil {
			defer key.Close()
			val, _, _ := key.GetStringValue(name)
			if url, ok := tryRead(val); ok {
				return url
			}
		}
	}
	for _, f := range candidates[kind] {
		if url, ok := tryRead(f); ok {
			return url
		}
	}
	return ""
}

// SystemCursors 返回系统调整光标（Win11/Win10/Win7/XP 通用：读当前主题，回退内置候选）。
// 前端注入 cursor: url(dataURL)，任一环节失败时由 CSS 关键字（col-resize/row-resize 等）兜底。
func SystemCursors() map[string]string {
	out := map[string]string{"base": strconv.Itoa(cursorBaseSize())}
	for _, k := range []string{"ew", "ns", "nwse", "nesw", "move"} {
		if url := resolveSystemCursor(k); url != "" {
			out[k] = url
		}
	}
	return out
}
