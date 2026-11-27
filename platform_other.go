//go:build !windows

package main

// platform_other.go：非 Windows 平台的宿主 glue 桩，对应 platform_windows.go。
// 由 4 个同 build tag 的文件合并而来（2026-11-24 三期结构化）：
// windowicon_other.go · trayhost_other.go · devtools_other.go · screenshot_app_other.go。
//
// ⚠️ 必须带 //go:build !windows：Windows 版在 platform_windows.go。

import (
	"context"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/tray"
)

// ---- 任务栏图标 / 窗口显示（原 windowicon_other.go）----

func showWindowWhenReady(win *application.WebviewWindow, maximised bool) {
	if win == nil {
		return
	}
	if maximised {
		win.Maximise()
		return
	}
	win.Show()
}

// ---- 托盘接缝（原 trayhost_other.go）----
// 没有通知区域，能力一律为假。

func appTrayIconID() uintptr { return 0 }

func traySupported() bool { return tray.Supported() }

func systemShuttingDown() bool { return false }

// ---- 开发者工具（原 devtools_other.go）----

// OpenDevTools 非 Windows 不支持（保留绑定方法，避免其它平台构建丢绑定）。
func (a *App) OpenDevTools(ctx context.Context) error {
	return fmt.Errorf("当前平台不支持打开开发者工具")
}
