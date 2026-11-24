// Package winutil：与窗口/控制台/WebView2 相关的**纯平台能力**，与 App、Wails 均无依赖。
//
// 这些函数原本是根目录的 `*_windows.go` / `*_other.go` 平台对。它们只碰操作系统 API
// （Win32 / 注册表 / go-webview2 的全局注入点），不碰 App 状态、不碰 Wails 窗口对象，
// 因此符合「纯平台能力可下沉 internal」的口径（与 clipboard / recycle / shellexec /
// executil 同批）。依赖 Wails 窗口对象的平台 glue（windowicon / devtools / browser）
// 仍留在根。
//
// 平台对文件名后缀 `_windows.go` / `_other.go` 保留，跨平台编译由 Go 的文件名约定处理。
package winutil
