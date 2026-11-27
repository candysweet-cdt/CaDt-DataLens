//go:build windows

package cmdbridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"datalens/internal/sandbox"
	"datalens/internal/shellpath"
)

// 沙箱档的 shell 必须是 PowerShell/cmd：Git Bash 在 restricting SID 下起不来
// （docs/finished-plans/subagent-sandbox.md §8.2），这条断言防回退。
func TestAIShellSandboxNeverUsesGitBash(t *testing.T) {
	if shellpath.FindGitBash() == "" {
		t.Skip("本机没有 Git Bash，无法验证「沙箱档不选它」")
	}
	shell, exe, _, _ := aiShellInvocation("echo hi", "", false)
	if shell != "Git Bash" {
		t.Fatalf("非沙箱档应优先 Git Bash，实际 %s (%s)", shell, exe)
	}
	shell, exe, _, _ = aiShellInvocation("echo hi", "", true)
	if strings.Contains(strings.ToLower(exe), "bash") || shell == "Git Bash" {
		t.Fatalf("沙箱档仍在用 Git Bash：%s (%s)", shell, exe)
	}
	if !strings.Contains(shell, "PowerShell") && !strings.Contains(shell, "Command Prompt") {
		t.Fatalf("沙箱档应回落到 PowerShell/cmd，实际 %s", shell)
	}
}

func TestAIRunShellCommandConfinedReadOnly(t *testing.T) {
	app := &Bridge{}
	res, err := app.AIRunShellCommandConfined("Write-Output SANDBOX_CMD_OK_5521", "", 30000, "", "read-only", "", "")
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if res.Code != 0 {
		t.Fatalf("退出码 %d, stderr=%s", res.Code, res.Stderr)
	}
	if !strings.Contains(res.Stdout, "SANDBOX_CMD_OK_5521") {
		t.Fatalf("stdout 没有预期标记: %q (stderr=%s)", res.Stdout, res.Stderr)
	}
	if res.SandboxMode != "read-only" {
		t.Fatalf("SandboxMode = %q，期望 read-only", res.SandboxMode)
	}
	if res.Enforcement != "partial" {
		t.Fatalf("Enforcement = %q，期望如实上报 partial", res.Enforcement)
	}
	if strings.Contains(strings.ToLower(res.Exe), "bash") {
		t.Fatalf("沙箱档不该走 Git Bash: %s", res.Exe)
	}
}

func TestAIRunShellCommandConfinedWorkspaceWrite(t *testing.T) {
	// 2026-11-27 事故回归：workspace-write 的唯一写根是私有临时目录，
	// 传入的 workspaceRoot 只是调用上下文，绝不能被打上 Low 标签。
	root := t.TempDir()
	app := &Bridge{}

	// 写私有目录（沙箱结果里的 TempDir）——执行期间可写。
	// 受限令牌下 PowerShell 可能是 ConstrainedLanguage，避免 Join-Path 等方法调用。
	cmd := "Set-Content -LiteralPath ($env:TEMP + '\\sandbox-probe.txt') -Value probe"
	res, err := app.AIRunShellCommandConfined(cmd, root, 30000, "", "workspace-write", root, "")
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if res.Code != 0 {
		t.Fatalf("退出码 %d, stderr=%s", res.Code, res.Stderr)
	}
	if res.SandboxMode != "workspace-write" {
		t.Fatalf("SandboxMode = %q", res.SandboxMode)
	}
	// 执行返回后私有目录已删除（Close 先 Revoke 再 RemoveAll）。
	if res.TempDir == "" {
		t.Fatal("workspace-write 应返回私有写根路径")
	}
	if _, statErr := os.Stat(res.TempDir); !os.IsNotExist(statErr) {
		t.Fatalf("私有写根未在执行后删除: %s (err=%v)", res.TempDir, statErr)
	}
	// 真实工作区上不能有任何沙箱痕迹（Granted/DenyPresent/Labeled 全 false）。
	state, scanErr := sandbox.Scan(root)
	if scanErr != nil {
		t.Fatalf("扫描真实工作区失败: %v", scanErr)
	}
	if state.Residue() {
		t.Fatalf("真实工作区被沙箱污染: %+v", state)
	}
}

// 写根之外必须被拒——授权边界在真实链路里生效。
func TestAIRunShellCommandConfinedDeniesOutside(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside.txt")
	defer os.Remove(outside)
	app := &Bridge{}

	cmd := "Set-Content -LiteralPath '" + outside + "' -Value leak"
	res, err := app.AIRunShellCommandConfined(cmd, root, 30000, "", "workspace-write", root, "")
	if err != nil {
		// 允许把「拒绝访问」当退出失败返回，但绝不能真的写成功
		t.Logf("命令返回错误（可接受）: %v", err)
	}
	if _, statErr := os.Stat(outside); statErr == nil {
		os.Remove(outside)
		t.Fatalf("写根之外写入居然成功了：授权边界失效（stdout=%q stderr=%q）", res.Stdout, res.Stderr)
	}
	// 留痕分类：失败原因应被认成「沙箱拒绝」，而不是普通 error。
	if res != nil && !res.SandboxDenied {
		t.Fatalf("写根外写入被拒却没标 sandboxDenied：code=%d stdout=%q stderr=%q", res.Code, res.Stdout, res.Stderr)
	}
}

// 普通失败不能被误记成沙箱拒绝（宁可漏判也不要误导排查）。
func TestDetectSandboxDenial(t *testing.T) {
	if detectSandboxDenial(0, "拒绝访问") {
		t.Error("退出码 0 不是拒绝")
	}
	if detectSandboxDenial(1, "") {
		t.Error("空 stderr 不是拒绝")
	}
	if detectSandboxDenial(1, "go: cannot find main module") {
		t.Error("普通失败被误判成沙箱拒绝")
	}
	if !detectSandboxDenial(1, "Access is denied.") {
		t.Error("英文拒绝串没识别出来")
	}
	if !detectSandboxDenial(1, "拒绝访问。") {
		t.Error("中文拒绝串没识别出来")
	}
}

func TestAIRunShellCommandConfinedBadMode(t *testing.T) {
	app := &Bridge{}
	if _, err := app.AIRunShellCommandConfined("echo hi", "", 5000, "", "yolo", "", ""); err == nil {
		t.Fatal("非法档位应报错")
	}
}

// danger-full-access 不圈定：直接走普通链路（可能仍是 Git Bash），且不带沙箱字段。
func TestAIRunShellCommandConfinedDangerFullAccess(t *testing.T) {
	app := &Bridge{}
	res, err := app.AIRunShellCommandConfined("echo FULL_ACCESS_OK", "", 30000, "", "danger-full-access", "", "")
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if !strings.Contains(res.Stdout, "FULL_ACCESS_OK") {
		t.Fatalf("stdout 没有预期标记: %q (stderr=%s)", res.Stdout, res.Stderr)
	}
	if res.SandboxMode != "" || res.Enforcement != "" || res.TempDir != "" {
		t.Fatalf("danger-full-access 不该带沙箱字段: %+v", res)
	}
}

// 后台作业的沙箱版：能起来、能拿到输出、退出码与档位如实上报。
func TestAICommandStartConfinedRunsAndReports(t *testing.T) {
	root := t.TempDir()
	app := &Bridge{}
	job, err := app.AICommandStartConfined("Write-Output BG_SANDBOX_OK_7731", root, "workspace-write", root, "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if job.JobId == "" {
		t.Fatal("没有返回 jobId")
	}
	if job.SandboxMode != "workspace-write" || job.Enforcement != "partial" {
		t.Fatalf("沙箱字段不符: %+v", job)
	}
	if strings.Contains(strings.ToLower(job.Shell), "bash") {
		t.Fatalf("沙箱档的后台作业不该走 Git Bash: %s", job.Shell)
	}

	deadline := time.Now().Add(30 * time.Second)
	cursor := int64(0)
	var output strings.Builder
	for {
		st, statusErr := app.AICommandStatus(job.JobId, cursor)
		if statusErr != nil {
			t.Fatalf("查询状态失败: %v", statusErr)
		}
		cursor = st.Cursor
		output.WriteString(st.Output)
		if st.State == "exited" {
			if st.Code != 0 {
				t.Fatalf("退出码 %d，输出：%s", st.Code, output.String())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("后台作业未在超时前退出，输出：%s", output.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(output.String(), "BG_SANDBOX_OK_7731") {
		t.Fatalf("输出里没有预期标记: %q", output.String())
	}
}

func TestAICommandStartConfinedBadMode(t *testing.T) {
	app := &Bridge{}
	if _, err := app.AICommandStartConfined("Write-Output hi", "", "yolo", "", ""); err == nil {
		t.Fatal("非法档位应报错")
	}
}

// 后台作业被沙箱拒绝时，状态要带 sandboxDenied（check_command 据此记 sandbox-denied）。
func TestAICommandStartConfinedMarksSandboxDenied(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside.txt")
	defer os.Remove(outside)
	app := &Bridge{}
	job, err := app.AICommandStartConfined("Set-Content -LiteralPath '"+outside+"' -Value leak", root, "workspace-write", root, "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		st, statusErr := app.AICommandStatus(job.JobId, 0)
		if statusErr != nil {
			t.Fatalf("查询状态失败: %v", statusErr)
		}
		if st.State == "exited" {
			if st.Code == 0 {
				t.Fatalf("写根外写入居然成功（退出码 0）")
			}
			if !st.SandboxDenied {
				t.Fatalf("被沙箱拒绝却没标 sandboxDenied：code=%d output=%q", st.Code, st.Output)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("后台作业未在超时前退出")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, statErr := os.Stat(outside); statErr == nil {
		os.Remove(outside)
		t.Fatal("写根外文件被创建了：授权边界失效")
	}
}
