//go:build windows

package main

import "fmt"

// resolveRunShell 解析脚本类语言需要的解释器（shell / PowerShell / cmd）。
// 这些不在编程语言环境扫描列表里，复用终端面板已有的探测函数，避免两套判定。
func resolveRunShell(kind string) (string, string, error) {
	switch kind {
	case "gitbash":
		if path := findGitBash(); path != "" {
			return path, "Git Bash", nil
		}
		return "", "", fmt.Errorf("未找到 Git Bash（需要安装 Git for Windows）")
	case "pwsh":
		if path := findPwsh(); path != "" {
			return path, "PowerShell 7", nil
		}
		return "", "", fmt.Errorf("未找到 PowerShell 7（pwsh）")
	case "powershell":
		return "powershell.exe", "Windows PowerShell", nil
	case "cmd":
		return "cmd.exe", "Command Prompt", nil
	}
	return "", "", fmt.Errorf("不支持的 shell：%s", kind)
}
