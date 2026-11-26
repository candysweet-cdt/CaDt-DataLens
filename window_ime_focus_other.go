//go:build !windows

package main

// window_ime_focus_other.go：window_ime_focus_windows.go 的非 Windows 桩，保证跨平台可编译
// （仓库对同类宿主 glue 一律成对提供，见 platform_other.go 的说明）。

import "github.com/wailsapp/wails/v3/pkg/application"

// attachIMEFocusRepair 非 Windows 无 WebView2/TSF，无需修复。
func attachIMEFocusRepair(*application.WebviewWindow) func() { return func() {} }
