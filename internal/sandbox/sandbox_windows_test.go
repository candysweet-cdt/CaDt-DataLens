//go:build windows

package sandbox

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// 真机测试：会真的建受限令牌、真的改目录 DACL 与完整性标签。
// 一律用 t.TempDir()，不碰仓库与用户目录。

func newSandbox(t *testing.T, p Policy) *Sandbox {
	t.Helper()
	sb, err := New(p)
	if err != nil {
		t.Fatalf("New(%+v) 失败：%v", p, err)
	}
	t.Cleanup(func() {
		if err := sb.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return sb
}

// runCmd 在沙箱里跑一条 cmd 脚本，返回 stdout/stderr 与退出码。
func runCmd(t *testing.T, sb *Sandbox, script string) (string, string, int) {
	t.Helper()
	cmd := exec.Command("cmd.exe", "/d", "/s", "/c", script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := sb.Run(cmd)
	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if err != nil && code < 0 {
		t.Fatalf("受限命令启动失败：%v (stderr=%s)", err, stderr.String())
	}
	return stdout.String(), stderr.String(), code
}

func TestPolicyValidate(t *testing.T) {
	cases := []struct {
		name string
		p    Policy
		ok   bool
	}{
		{"read-only", Policy{Mode: ReadOnly}, true},
		{"read-only 带 temp", Policy{Mode: ReadOnly, TempDir: `C:\temp`}, false},
		{"workspace-write 缺根", Policy{Mode: WorkspaceWrite}, false},
		{"workspace-write", Policy{Mode: WorkspaceWrite, WorkspaceRoot: `C:\work`}, true},
		{"danger-full-access 不该建沙箱", Policy{Mode: DangerFullAccess}, false},
		{"未知档位", Policy{Mode: "yolo"}, false},
	}
	for _, c := range cases {
		err := c.p.Validate()
		if c.ok && c.p.Mode == DangerFullAccess {
			// danger-full-access 期望 ErrDangerFullAccess（不是 nil）
			if !errors.Is(err, ErrDangerFullAccess) {
				t.Errorf("%s: 期望 ErrDangerFullAccess，得到 %v", c.name, err)
			}
			continue
		}
		if (err == nil) != c.ok {
			t.Errorf("%s: Validate() = %v，期望 ok=%v", c.name, err, c.ok)
		}
	}
}

// 08-11 的教训：沙箱档绝对不能用 CREATE_NO_WINDOW / HideWindow，否则 0xC0000142。
func TestConfigureUsesDetachedProcess(t *testing.T) {
	sb := newSandbox(t, Policy{Mode: ReadOnly})
	cmd := exec.Command("cmd.exe", "/c", "exit")
	sb.Configure(cmd)
	if cmd.SysProcAttr == nil {
		t.Fatal("Configure 未设置 SysProcAttr")
	}
	if cmd.SysProcAttr.CreationFlags != detachedProcess {
		t.Errorf("CreationFlags = 0x%08x，期望 DETACHED_PROCESS(0x%08x)", cmd.SysProcAttr.CreationFlags, detachedProcess)
	}
	if cmd.SysProcAttr.HideWindow {
		t.Error("沙箱档禁止 HideWindow：受限令牌 + CreateNoWindow 子进程必死 0xC0000142")
	}
}

// ShareConsole 走「继承宿主（隐藏）控制台」：CreationFlags 必须是 0。
// PowerShell 在 DETACHED_PROCESS 下静默退出，这是它唯一能跑起来的形态。
func TestConfigureShareConsoleHasNoCreationFlags(t *testing.T) {
	sb := newSandbox(t, Policy{Mode: ReadOnly, ShareConsole: true})
	cmd := exec.Command("cmd.exe", "/c", "exit")
	if err := sb.Configure(cmd); err != nil {
		t.Fatalf("Configure: %v", err)
	}
	if cmd.SysProcAttr == nil {
		t.Fatal("Configure 未设置 SysProcAttr")
	}
	if cmd.SysProcAttr.CreationFlags != 0 {
		t.Errorf("CreationFlags = 0x%08x，期望 0（继承宿主控制台）", cmd.SysProcAttr.CreationFlags)
	}
	if cmd.SysProcAttr.HideWindow {
		t.Error("共享控制台档同样禁止 HideWindow / CREATE_NO_WINDOW")
	}
}

func TestReadOnlyRunsCommand(t *testing.T) {
	sb := newSandbox(t, Policy{Mode: ReadOnly})
	stdout, stderr, code := runCmd(t, sb, "echo SANDBOX-OK")
	if code != 0 {
		t.Fatalf("退出码 %d，stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "SANDBOX-OK") {
		t.Fatalf("stdout 没有预期输出：%q", stdout)
	}
}

// read-only 不给任何写根：写系统 temp 必须失败。
func TestReadOnlyDeniesWrites(t *testing.T) {
	sb := newSandbox(t, Policy{Mode: ReadOnly})
	target := filepath.Join(os.TempDir(), fmt.Sprintf("cadt-ro-denied-%d.txt", time.Now().UnixNano()))
	defer os.Remove(target)

	runCmd(t, sb, fmt.Sprintf("echo leak>%s", target))
	if _, err := os.Stat(target); err == nil {
		os.Remove(target)
		t.Fatal("read-only 档写系统 temp 居然成功了：授权边界没生效")
	}
}

// workspace-write：写根内可写。
func TestWorkspaceWriteAllowsInsideRoot(t *testing.T) {
	root := t.TempDir()
	sb := newSandbox(t, Policy{Mode: WorkspaceWrite, WorkspaceRoot: root})
	target := filepath.Join(root, "probe.txt")

	stdout, stderr, code := runCmd(t, sb, fmt.Sprintf("echo probe>%s", target))
	if code != 0 {
		t.Fatalf("退出码 %d，stderr=%s stdout=%s", code, stderr, stdout)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("写根内写入失败：%v (stderr=%s)", err, stderr)
	}
	if !strings.Contains(string(data), "probe") {
		t.Fatalf("文件内容不对：%q", string(data))
	}
}

// workspace-write：写根外（系统 temp 同级）仍然被拒。
func TestWorkspaceWriteDeniesOutsideRoot(t *testing.T) {
	root := t.TempDir()
	sb := newSandbox(t, Policy{Mode: WorkspaceWrite, WorkspaceRoot: root})
	target := filepath.Join(os.TempDir(), fmt.Sprintf("cadt-outside-denied-%d.txt", time.Now().UnixNano()))
	defer os.Remove(target)

	runCmd(t, sb, fmt.Sprintf("echo leak>%s", target))
	if _, err := os.Stat(target); err == nil {
		os.Remove(target)
		t.Fatal("写根之外写入居然成功了：授权边界没生效")
	}
}

// 私有 temp 被授权后可写，且 TMP/TEMP 被重写指向它。
func TestTempDirGrantedAndEnvRewritten(t *testing.T) {
	root := t.TempDir()
	temp := t.TempDir()
	sb := newSandbox(t, Policy{Mode: WorkspaceWrite, WorkspaceRoot: root, TempDir: temp})

	stdout, stderr, code := runCmd(t, sb, "echo %TEMP%")
	if code != 0 {
		t.Fatalf("退出码 %d，stderr=%s", code, stderr)
	}
	if !strings.Contains(strings.ToLower(stdout), strings.ToLower(temp)) {
		t.Fatalf("TEMP 没被重写到私有目录：stdout=%q 期望含 %q", stdout, temp)
	}

	target := filepath.Join(temp, "temp-probe.txt")
	runCmd(t, sb, fmt.Sprintf("echo probe>%s", target))
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("私有 temp 内写入失败：%v (stderr=%s)", err, stderr)
	}
}

// temp 与写根重叠必须 fail-closed（对齐 dsh 的 assertPrivateTempDisjoint）。
func TestTempInsideWorkspaceRejected(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "tmp")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Policy{Mode: WorkspaceWrite, WorkspaceRoot: root, TempDir: nested}); err == nil {
		t.Fatal("temp 落在写根内却被接受：应 fail-closed")
	}
	if _, err := New(Policy{Mode: WorkspaceWrite, WorkspaceRoot: nested, TempDir: root}); err == nil {
		t.Fatal("写根落在 temp 内却被接受：应 fail-closed")
	}
}

// Close 必须连带杀掉整棵进程树（Job KILL_ON_JOB_CLOSE）。
func TestCloseKillsProcessTree(t *testing.T) {
	sb, err := New(Policy{Mode: ReadOnly})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cmd := exec.Command("cmd.exe", "/d", "/s", "/c", "ping -n 20 127.0.0.1")
	if err := sb.Start(cmd); err != nil {
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sb.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Close 之后子进程仍在运行：Job 没杀掉进程树")
	}
}

// 写根授权是幂等的：第二次 New 命中 exact-ACE 跳过，不应报错也不应重复传播。
func TestGrantIsIdempotent(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 2; i++ {
		sb, err := New(Policy{Mode: WorkspaceWrite, WorkspaceRoot: root})
		if err != nil {
			t.Fatalf("第 %d 次 New: %v", i+1, err)
		}
		if err := sb.Close(); err != nil {
			t.Fatalf("第 %d 次 Close: %v", i+1, err)
		}
	}
}

// Scan 报告三样痕迹；Revoke 全清，且不误删用户自己的权限。
func TestScanAndRevoke(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "nested")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatal(err)
	}

	sb, err := New(Policy{Mode: WorkspaceWrite, WorkspaceRoot: root})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := sb.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	before, err := Scan(root)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if !before.Granted || !before.DenyPresent || !before.Labeled {
		t.Fatalf("授权后三样痕迹应都在: %+v", before)
	}
	if before.WorkspaceSID == "" || !strings.HasPrefix(before.WorkspaceSID, "S-1-4-") {
		t.Fatalf("能力 SID 形状不对: %q", before.WorkspaceSID)
	}

	after, err := Revoke(root)
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if after.Residue() {
		t.Fatalf("撤销后仍有残留: %+v", after)
	}

	// 用户自己的权限不能被误删：目录还要能写。
	if err := os.WriteFile(filepath.Join(root, "after-revoke.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatalf("撤销后目录不可写（误删了用户权限）：%v", err)
	}

	// 继承型 ACE 的撤销要传播到子项，否则子目录还留着能力授权。
	sid, err := parseSID(before.WorkspaceSID)
	if err != nil {
		t.Fatal(err)
	}
	world, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		t.Fatal(err)
	}
	sec, err := readSecurity(child)
	if err != nil {
		t.Fatal(err)
	}
	defer sec.release()
	if hasACE(sec.dacl, accessAllowedACEType, subContainersAndObjectsInherit, grantMask, sid) {
		t.Error("子目录还带着能力 ACE：撤销没传播给子项")
	}
	if hasACE(sec.dacl, accessDeniedACEType, containerInheritACE, fileDeleteChild, world) {
		t.Error("子目录还带着 Everyone 的 ambient-delete deny")
	}
}

// 干净的目录上撤销是 no-op，不报错也不写 DACL。
func TestRevokeNoopOnCleanDir(t *testing.T) {
	root := t.TempDir()
	state, err := Revoke(root)
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if state.Residue() {
		t.Fatalf("干净目录上不该有残留: %+v", state)
	}
}

// 授权失败要把「缺 WRITE_DAC」翻成可操作说明：裸的 Access is denied 只会让人反复重试。
func TestDiagnoseGrantFailure(t *testing.T) {
	me := currentUserSIDString()
	if me == "" {
		t.Fatal("取不到当前用户 SID，诊断会退化成通用文案")
	}
	owner, err := ownerSIDStringOf(t.TempDir())
	if err != nil {
		t.Fatalf("ownerSIDStringOf: %v", err)
	}
	if owner != me {
		t.Fatalf("t.TempDir() 的所有者 %s 与当前账户 %s 不一致，本用例前提不成立", owner, me)
	}

	self := diagnoseGrantFailure(t.TempDir())
	if !strings.Contains(self, "所有者") {
		t.Errorf("自有目录的诊断应指出「当前账户就是所有者」：%q", self)
	}

	missing := diagnoseGrantFailure(filepath.Join(t.TempDir(), "not-there"))
	if !strings.Contains(missing, "无法读取目录所有者") {
		t.Errorf("读不到所有者时应用通用文案：%q", missing)
	}
}

// Close 之后私有 temp 必须能被宿主删掉：只撤能力 SID 的 allow ACE 会留下
// Everyone 的 FILE_DELETE_CHILD deny，os.RemoveAll 被拒且错误常被吞掉 → temp 泄漏。
func TestCloseLeavesTempRemovable(t *testing.T) {
	root := t.TempDir()
	temp := filepath.Join(t.TempDir(), "private-temp")
	if err := os.MkdirAll(temp, 0o755); err != nil {
		t.Fatal(err)
	}
	sb, err := New(Policy{Mode: WorkspaceWrite, WorkspaceRoot: root, TempDir: temp})
	if err != nil {
		t.Fatalf("New 失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(temp, "leftover.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := sb.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := os.RemoveAll(temp); err != nil {
		t.Fatalf("Close 后宿主 RemoveAll 被拒：%v", err)
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Fatalf("temp 未被删除：%v", err)
	}
}
