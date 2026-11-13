//go:build !windows

package main

import "fmt"

// CaptureAppScreenshot 仅 Windows 支持（主窗口截图）。
func (a *App) CaptureAppScreenshot() (string, error) {
	return "", fmt.Errorf("当前平台不支持应用窗口截图")
}
