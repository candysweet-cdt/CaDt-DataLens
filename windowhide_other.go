//go:build !windows

package main

import "unsafe"

// hideNativeWindowAsync 非 Windows 平台无原生窗口句柄可用：留空实现，
// 退出可见时序由各平台自己的窗口实现决定（本项目发行目标为 Windows）。
func hideNativeWindowAsync(_ unsafe.Pointer) {}
