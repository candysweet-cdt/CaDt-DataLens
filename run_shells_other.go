//go:build !windows

package main

import "fmt"

// resolveRunShell 非 Windows 平台占位：运行代码依赖 Windows 下的控制台隐藏与进程树终止。
func resolveRunShell(kind string) (string, string, error) {
	return "", "", fmt.Errorf("运行代码暂只支持 Windows")
}
