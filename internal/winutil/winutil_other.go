//go:build !windows

package winutil

// winutil_other.go：所有非 Windows 平台能力的空桩，由 4 个同 build tag 的文件合并
// （console_other / windowhide_other / webview_args_other / cursors_other）。
// 对应 Windows 实现在 winutil_windows.go。

import "unsafe"

// AttachParentConsole 非 Windows 无 GUI 子系统区分，空操作。
func AttachParentConsole() {}

// HideWindowAsync 非 Windows 空操作。
func HideWindowAsync(_ unsafe.Pointer) {}

// SetWebViewExtraBrowserArguments 非 Windows 没有 WebView2，无需注入浏览器参数。
func SetWebViewExtraBrowserArguments(_ string) {}

// SystemCursors 非 Windows 平台返回空：前端回落 CSS 关键字光标。
func SystemCursors() map[string]string {
	return map[string]string{}
}
