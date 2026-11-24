// Package screenshot 应用窗口截图（Windows 下 BitBlt + PNG data URL）。
package screenshot

import "context"

// Capturer 截图引擎（无状态）。
type Capturer struct{}

// FindParent 返回要截图的窗口句柄的兜底（根 platform_windows.go 的
// findWailsWindow）。v3 一进程多窗口后只在拿不到调用方窗口时兜底。
var FindParent func() uintptr

// ParentForCall 返回绑定调用方窗口的原生句柄（main 用 callerWindow+NativeWindow）。
// 截图目标归属发起调用的窗口——不再按 Z 序猜「当前主窗口」。
var ParentForCall func(ctx context.Context) uintptr

// parentForCall 解析截图目标：优先调用方窗口，拿不到（测试/非绑定路径）回退
// FindParent；都没有时返回 0，由平台实现决定是否降级为整屏截图。
func parentForCall(ctx context.Context) uintptr {
	if ParentForCall != nil {
		if h := ParentForCall(ctx); h != 0 {
			return h
		}
	}
	if FindParent != nil {
		return FindParent()
	}
	return 0
}
