//go:build windows

package main

import (
	"fmt"
	"reflect"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
)

// uiThreadInvoker 对应 winc.Form/ControlBase 的 Invoke：把函数切到窗口线程执行。
type uiThreadInvoker interface {
	Invoke(func()) bool
}

// OpenDevTools 在开发者模式下打开 WebView2 开发者工具。
// Wails v2 没有公开该能力：从启动上下文取出 windows.Frontend，
// 再通过其未导出的 chromium / mainWindow 字段调用 WebView2。
// WebView2 控制器只能在窗口线程调用，所以经 winc 的 Invoke 切线程。
// 该实现依赖当前锁定的 Wails v2.17.1 结构，字段缺失时直接报错。
func (a *App) OpenDevTools() error {
	if !devMode.Load() {
		return fmt.Errorf("请先在设置中开启开发者模式")
	}
	if a.ctx == nil {
		return fmt.Errorf("应用尚未启动")
	}
	frontend := a.ctx.Value("frontend")
	if frontend == nil {
		return fmt.Errorf("无法访问界面实例")
	}
	value := reflect.ValueOf(frontend).Elem()
	if !value.IsValid() {
		return fmt.Errorf("界面实例不可用")
	}
	chromiumField := value.FieldByName("chromium")
	windowField := value.FieldByName("mainWindow")
	if !chromiumField.IsValid() || chromiumField.IsNil() ||
		!windowField.IsValid() || windowField.IsNil() {
		return fmt.Errorf("当前 Wails 版本不支持打开开发者工具")
	}
	chromium := (*edge.Chromium)(chromiumField.UnsafePointer())
	window := reflect.NewAt(windowField.Type(), unsafe.Pointer(windowField.UnsafeAddr())).Elem()
	invoker, ok := window.Interface().(uiThreadInvoker)
	if !ok {
		return fmt.Errorf("当前 Wails 版本不支持打开开发者工具")
	}
	if !invoker.Invoke(func() {
		chromium.OpenDevToolsWindow()
		writeAppLog("info", "已打开开发者工具")
	}) {
		return fmt.Errorf("无法切换回界面线程")
	}
	return nil
}
