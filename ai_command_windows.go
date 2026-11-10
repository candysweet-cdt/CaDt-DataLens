//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// AI 终端工具：按 Git Bash → PowerShell 7 → Windows PowerShell → cmd 的优先级执行命令。
// 复用进程桥的 RunCommandSync（无窗口、超时、输出上限），但 shell 由后端统一选择。

type AIShellCommandResult struct {
	Shell      string `json:"shell"`
	Exe        string `json:"exe"`
	Code       int    `json:"code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	TimedOut   bool   `json:"timedOut"`
	DurationMs int64  `json:"durationMs"`
}

func findExe(name string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	return path
}

func aiShellInvocation(command string) (shellName, exe string, args []string) {
	if bash := findGitBash(); bash != "" {
		return "Git Bash", bash, []string{"--login", "-c", command}
	}
	if pwsh := findPwsh(); pwsh != "" {
		// 避免中文输出按控制台代码页编码；-NonInteractive 防止命令等待输入。
		prefix := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Console]::OutputEncoding;"
		return "PowerShell 7", pwsh, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prefix + command}
	}
	if ps := findExe("powershell.exe"); ps != "" {
		prefix := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Console]::OutputEncoding;"
		return "Windows PowerShell", ps, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prefix + command}
	}
	return "Command Prompt", "cmd.exe", []string{"/d", "/s", "/c", command}
}

// AIRunShellCommand 执行一条 AI 发起的 shell 命令；超时不算错误（TimedOut=true + 已捕获输出）。
func (a *App) AIRunShellCommand(command, cwd string, timeoutMs int) (*AIShellCommandResult, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, fmt.Errorf("命令不能为空")
	}
	if strings.TrimSpace(cwd) != "" {
		info, err := os.Stat(cwd)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("工作目录不存在：%s", cwd)
		}
	}
	if timeoutMs <= 0 {
		timeoutMs = 30000
	}
	if timeoutMs > commandMaxTimeout {
		timeoutMs = commandMaxTimeout
	}
	shellName, exe, args := aiShellInvocation(command)
	started := time.Now()
	raw, err := a.RunCommandSync(exe, args, cwd, timeoutMs)
	out := &AIShellCommandResult{
		Shell:      shellName,
		Exe:        exe,
		DurationMs: time.Since(started).Milliseconds(),
	}
	if raw != nil {
		out.Code = raw.Code
		out.Stdout = raw.Stdout
		out.Stderr = raw.Stderr
	}
	if err != nil {
		if raw != nil {
			out.TimedOut = true
			return out, nil
		}
		return nil, err
	}
	return out, nil
}
