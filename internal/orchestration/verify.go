// verify.go：验收命令执行器。命令是 exe + argv，绝不经过 shell；
// 超时/取消杀整棵进程树；stdout/stderr 各截断到 8 MB；绑定调用不等待（由调用方异步）。
package orchestration

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/executil"
)

const maxVerifyOutput = 8 << 20

// VerifyResult 一条验收命令的客观结果。
type VerifyResult struct {
	File     string   `json:"file"`
	Args     []string `json:"args,omitempty"`
	Cwd      string   `json:"cwd,omitempty"`
	ExitCode int      `json:"exitCode"`
	Output   string   `json:"output,omitempty"`
	TimedOut bool     `json:"timedOut,omitempty"`
	Err      string   `json:"err,omitempty"`
	Ms       int64    `json:"ms,omitempty"`
}

type limitedBuffer struct {
	buf       bytes.Buffer
	remaining int
	truncated bool
}

func (w *limitedBuffer) Write(p []byte) (int, error) {
	original := len(p)
	if w.remaining <= 0 {
		w.truncated = true
		return original, nil
	}
	if len(p) > w.remaining {
		w.truncated = true
		p = p[:w.remaining]
	}
	n, _ := w.buf.Write(p)
	w.remaining -= n
	return original, nil
}

func (w *limitedBuffer) String() string {
	if w.truncated {
		return w.buf.String() + "\n…（输出超过 8 MB，已截断）"
	}
	return w.buf.String()
}

// RunVerifySpec 执行一条验收命令。
func RunVerifySpec(workspace string, spec VerifySpec) VerifyResult {
	result := VerifyResult{File: spec.File, Args: append([]string(nil), spec.Args...)}
	start := time.Now()
	defer func() { result.Ms = time.Since(start).Milliseconds() }()
	if err := validateVerifySpecs(workspace, []VerifySpec{spec}); err != nil {
		result.ExitCode = -1
		result.Err = err.Error()
		return result
	}
	exe := strings.TrimSpace(spec.File)
	// 相对可执行路径按 batch.workspace 解析，而不是按应用进程 cwd；否则 worker 目录里
	// 的 ./tools/build 会被解析到错误位置，甚至落到工作区外的同名文件。
	if strings.ContainsAny(exe, `/\`) && !filepath.IsAbs(exe) {
		exe = filepath.Join(workspace, exe)
		if !pathInside(evalNearest(workspace), evalNearest(exe)) {
			result.ExitCode = -1
			result.Err = "verify 的可执行文件在工作区外：" + spec.File
			return result
		}
	}
	resolved, err := exec.LookPath(exe)
	if err != nil {
		result.ExitCode = -1
		result.Err = "找不到可执行文件：" + exe
		return result
	}
	cwd := strings.TrimSpace(spec.Cwd)
	if cwd == "" {
		cwd = workspace
	} else if !filepath.IsAbs(cwd) {
		cwd = filepath.Join(workspace, cwd)
	}
	result.Cwd = cwd
	timeout := spec.TimeoutMs
	if timeout <= 0 {
		timeout = DefaultVerifyTimeoutMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, resolved, spec.Args...)
	cmd.Dir = cwd
	executil.HideCommandWindow(cmd)
	cmd.Cancel = func() error { return executil.KillProcessTree(cmd) }
	cmd.WaitDelay = 3 * time.Second
	stdout := &limitedBuffer{remaining: maxVerifyOutput}
	stderr := &limitedBuffer{remaining: maxVerifyOutput}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err = cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.ExitCode = -1
	} else if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
			result.Err = err.Error()
		}
	}
	result.Output = strings.TrimSpace(stdout.String() + stderr.String())
	if len(result.Output) > maxVerifyOutput {
		result.Output = result.Output[:maxVerifyOutput] + "\n…（已截断）"
	}
	return result
}

// runVerifyAll 串行跑完一个批次的全部验收命令；任一失败即停止。
func runVerifyAll(workspace string, specs []VerifySpec, runner func(string, VerifySpec) VerifyResult) []VerifyResult {
	out := make([]VerifyResult, 0, len(specs))
	for _, spec := range specs {
		res := runner(workspace, spec)
		out = append(out, res)
		if res.ExitCode != 0 {
			break
		}
	}
	return out
}

func verifyFailureSummary(results []VerifyResult) string {
	for _, res := range results {
		if res.ExitCode == 0 {
			continue
		}
		cmd := res.File
		if len(res.Args) > 0 {
			cmd += " " + strings.Join(res.Args, " ")
		}
		why := fmt.Sprintf("exit %d", res.ExitCode)
		if res.TimedOut {
			why = "超时"
		}
		if res.Err != "" {
			why = res.Err
		}
		out := strings.TrimSpace(res.Output)
		if len([]rune(out)) > 1200 {
			out = truncateRunes(out, 1200)
		}
		return fmt.Sprintf("%s %s\n%s", cmd, why, out)
	}
	return ""
}
