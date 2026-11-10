//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestAIShellPriority(t *testing.T) {
	shell, exe, args := aiShellInvocation("echo hi")
	switch {
	case findGitBash() != "":
		if shell != "Git Bash" || !strings.Contains(strings.ToLower(exe), "bash") {
			t.Fatalf("应优先 Git Bash，实际 %s (%s)", shell, exe)
		}
		if len(args) < 3 || args[len(args)-1] != "echo hi" {
			t.Fatalf("Git Bash 参数异常: %v", args)
		}
	case findPwsh() != "":
		if shell != "PowerShell 7" || !strings.Contains(strings.ToLower(exe), "pwsh") {
			t.Fatalf("无 Git Bash 时应优先 pwsh，实际 %s (%s)", shell, exe)
		}
	default:
		if !strings.Contains(shell, "PowerShell") && !strings.Contains(shell, "Command Prompt") {
			t.Fatalf("未找到预期 shell: %s", shell)
		}
	}
}

func TestAIRunShellCommandEcho(t *testing.T) {
	app := &App{}
	res, err := app.AIRunShellCommand("echo CADT_AI_CMD_OK_9137", "", 20000)
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if res.Code != 0 {
		t.Fatalf("退出码 %d, stderr=%q", res.Code, res.Stderr)
	}
	if !strings.Contains(res.Stdout, "CADT_AI_CMD_OK_9137") {
		t.Fatalf("stdout 未包含预期内容: %q", res.Stdout)
	}
	if res.Shell == "" || res.Exe == "" {
		t.Fatalf("缺少 shell 信息: %+v", res)
	}
}

func TestAIRunShellCommandValidation(t *testing.T) {
	app := &App{}
	if _, err := app.AIRunShellCommand("   ", "", 0); err == nil {
		t.Fatal("空命令应被拒绝")
	}
	if _, err := app.AIRunShellCommand("echo hi", `C:\__cadt_missing_dir__`, 0); err == nil {
		t.Fatal("不存在的 cwd 应被拒绝")
	}
}
