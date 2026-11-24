package main

// 调试控制台窗口的绑定壳：导出日志、独立窗口判定与打开；
// 日志追加与增量读取在 internal/debugconsole。

import (
	"context"
	"strings"
)

// ExportDebugConsoleLog 弹出保存对话框并写出调试控制台日志文本；
// 用户取消时返回空路径且不写文件。
func (a *App) ExportDebugConsoleLog(defaultName, content string) (string, error) {
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "debug-console.log"
	}
	path, err := a.ShowSaveFileDialog(nil, "导出调试控制台日志", name, "log")
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := a.SaveFile(path, content, "lf", false, "utf-8"); err != nil {
		return "", err
	}
	return path, nil
}

// IsDebugConsoleWindow 当前调用窗口是否是独立调试控制台窗口。
func (a *App) IsDebugConsoleWindow(ctx context.Context) bool {
	st := stateForCaller(ctx)
	return st != nil && st.Startup().Mode == windowModeDebug
}

// OpenDebugConsoleWindow 打开（或聚焦）调试控制台窗口（P2：同进程窗口）。
func (a *App) OpenDebugConsoleWindow() error {
	a.ensureDebugWindow()
	return nil
}
