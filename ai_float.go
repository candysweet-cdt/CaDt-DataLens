package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// IsAIFloatWindow 当前进程是否作为独立 AI 悬浮窗运行。
func (a *App) IsAIFloatWindow() bool {
	return hasArg("--ai-float")
}

// OpenAIFloatWindow 以独立进程窗口打开 AI 助手；root 为工作区根（可为空）。
func (a *App) OpenAIFloatWindow(root string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("无法定位程序：%w", err)
	}
	args := []string{"--new-window", "--ai-float"}
	if root = strings.TrimSpace(root); root != "" {
		args = append(args, root)
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开 AI 独立窗口失败：%w", err)
	}
	return nil
}

// OpenSettingsInMainWindow 请求主窗口打开设置页（悬浮窗使用）。
func (a *App) OpenSettingsInMainWindow(pane string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("无法定位程序：%w", err)
	}
	if strings.TrimSpace(pane) == "" {
		pane = "models"
	}
	cmd := exec.Command(exe, "--open-settings="+pane)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开主窗口设置失败：%w", err)
	}
	return nil
}
