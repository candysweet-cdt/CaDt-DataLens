package main

// Wails v3 兼容层：根壳其它文件只依赖这里的应用/主窗口/事件/剪贴板/退出动作。
// P2 起多窗口共享一个 App 服务实例，窗口级状态经 windowmeta.go 的 windowState 归属。

import (
	"context"
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var (
	wailsApp *application.App
	mainWin  *application.WebviewWindow
	winMu    sync.RWMutex
)

// ServiceStartup 实现 v3 的 ServiceStartup 接口，等价 v2 的 OnStartup。
func (a *App) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	a.startup(ctx)
	return nil
}

// setMainWindow 记录「主窗口」指针（托盘恢复、第二实例默认投递目标）。
func setMainWindow(w *application.WebviewWindow) {
	winMu.Lock()
	mainWin = w
	winMu.Unlock()
}

func currentWindow() *application.WebviewWindow {
	winMu.RLock()
	defer winMu.RUnlock()
	return mainWin
}

// emitAppEvent 是 v2 runtime.EventsEmit 在 v3 的替代：应用级广播，
// 前端桥接层按 sender/业务 key 过滤（见 wails-v3-event-filtering.md）。
func emitAppEvent(name string, data ...any) {
	if wailsApp == nil {
		return
	}
	wailsApp.Event.Emit(name, data...)
}

// emitWindowEventTo 用指定窗口对象发射：v3 会给 CustomEvent 填 sender（窗口名），
// 前端桥接层据此把控制命令只交给目标窗口（window.EmitEvent 本身仍是广播）。
func emitWindowEventTo(w *application.WebviewWindow, name string, data ...any) {
	if w == nil {
		emitAppEvent(name, data...)
		return
	}
	w.EmitEvent(name, data...)
}

// showMainWindow 显示主窗口并把最小化的窗口恢复回来（托盘恢复 / 第二实例前置）。
func showMainWindow() {
	w := currentWindow()
	if w == nil {
		return
	}
	w.Show()
	if w.IsMinimised() {
		w.UnMinimise()
	}
}

func quitApp() {
	if wailsApp != nil {
		wailsApp.Quit()
	}
}

func clipboardSetText(text string) error {
	if wailsApp == nil {
		return fmt.Errorf("应用尚未启动")
	}
	wailsApp.Clipboard.SetText(text)
	return nil
}

func clipboardGetText() (string, error) {
	if wailsApp == nil {
		return "", fmt.Errorf("应用尚未启动")
	}
	text, _ := wailsApp.Clipboard.Text()
	return text, nil
}
