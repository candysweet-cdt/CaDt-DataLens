//go:build windows

package main

import (
	"strings"
	"testing"
	"time"
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

func TestAICommandStartStatusStop(t *testing.T) {
	app := &App{}
	started, err := app.AICommandStart("echo CADT_BG_OK_6211", "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if started.JobId == "" || started.Shell == "" {
		t.Fatalf("缺少 jobId/shell: %+v", started)
	}
	deadline := time.Now().Add(15 * time.Second)
	var final *AICommandJobStatus
	for {
		st, err := app.AICommandStatus(started.JobId, 0)
		if err != nil {
			t.Fatalf("查询失败: %v", err)
		}
		if st.State == "exited" {
			final = st
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("作业未在期限内退出: %+v", st)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if final.Code != 0 {
		t.Fatalf("退出码应为 0: %+v", final)
	}
	if !strings.Contains(final.Output, "CADT_BG_OK_6211") {
		t.Fatalf("输出未包含预期内容: %q", final.Output)
	}
	if final.Cursor == 0 {
		t.Fatal("游标应已前进")
	}
	// 已退出作业继续查询：无新增输出、状态保持 exited
	again, err := app.AICommandStatus(started.JobId, final.Cursor)
	if err != nil || again.State != "exited" || again.Output != "" {
		t.Fatalf("结束后重复查询异常: %+v err=%v", again, err)
	}
}

func TestAICommandStopRunning(t *testing.T) {
	shell, _, _ := aiShellInvocation("")
	if shell != "Git Bash" {
		t.Skipf("停止用例依赖 Git Bash（read -t 无子进程、可被干净终止），当前 shell: %s", shell)
	}
	app := &App{}
	// 纯 bash 内建循环阻塞（无长命子进程，stdin EOF 也不影响），确保停止时仍在运行
	started, err := app.AICommandStart("echo bg-started; for ((i=0;i<300;i++)); do sleep 0.1; done", "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	st, err := app.AICommandStop(started.JobId)
	if err != nil {
		t.Fatalf("停止失败: %v", err)
	}
	if st.State != "exited" {
		t.Fatalf("停止后作业应已退出: %+v", st)
	}
	if st.Code != -1 {
		t.Fatalf("被终止的作业退出码应为 -1，实际 %d", st.Code)
	}
}

func TestAICommandStartValidation(t *testing.T) {
	app := &App{}
	if _, err := app.AICommandStart("   ", ""); err == nil {
		t.Fatal("空命令应被拒绝")
	}
	if _, err := app.AICommandStart("echo hi", `C:\__cadt_missing_dir__`); err == nil {
		t.Fatal("不存在的 cwd 应被拒绝")
	}
	if _, err := app.AICommandStatus("", 0); err == nil {
		t.Fatal("空 jobId 查询应被拒绝")
	}
	if _, err := app.AICommandStop(""); err == nil {
		t.Fatal("空 jobId 停止应被拒绝")
	}
}
