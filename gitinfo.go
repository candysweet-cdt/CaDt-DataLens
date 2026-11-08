package main

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// git 浅集成：调系统 git（VS Code 同款做法），只读查询。
// git 未安装或目录不在仓库内时优雅降级（Available=false）。

type GitFileState struct {
	Path  string `json:"path"`
	State string `json:"state"` // new / modified / deleted / renamed / conflict
}

type GitTreeStatus struct {
	Available bool           `json:"available"`
	Reason    string         `json:"reason,omitempty"`
	Root      string         `json:"root,omitempty"`
	Branch    string         `json:"branch,omitempty"`
	Entries   []GitFileState `json:"entries"`
}

type GitDiffResult struct {
	HasChanges bool   `json:"hasChanges"`
	Diff       string `json:"diff,omitempty"`
}

func gitRun(dir string, args []string, timeoutMs int) (string, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	code := 0
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			return "", -1, runErr
		}
	}
	if ctx.Err() == context.DeadlineExceeded {
		return "", -1, fmt.Errorf("git 命令超时")
	}
	return stdout.String(), code, nil
}

func gitBadgeState(x, y byte) string {
	if x == '?' || y == '?' {
		return "new"
	}
	if x == 'U' || y == 'U' {
		return "conflict"
	}
	if x == 'D' || y == 'D' {
		return "deleted"
	}
	if x == 'R' || y == 'R' {
		return "renamed"
	}
	if y == 'M' || y == 'T' || x == 'M' || x == 'T' {
		return "modified"
	}
	if x == 'A' || x == 'C' {
		return "new"
	}
	return "modified"
}

// GitStatusFor 返回 dir 所在仓库的文件状态（供文件树角标）。
func (a *App) GitStatusFor(dir string) (*GitTreeStatus, error) {
	status := &GitTreeStatus{Entries: []GitFileState{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		status.Reason = "没有打开的目录"
		return status, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		status.Reason = "未安装 git"
		return status, nil
	}
	if code != 0 || strings.TrimSpace(out) != "true" {
		status.Reason = "不在 git 仓库内"
		return status, nil
	}
	status.Available = true
	if root, _, _ := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000); err == nil {
		status.Root = strings.TrimSpace(root)
	}
	if branch, bcode, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); bcode == 0 {
		status.Branch = strings.TrimSpace(branch)
	}
	raw, code, err := gitRun(dir, []string{"status", "--porcelain=v1", "-z", "--untracked-files=normal"}, 10000)
	if err != nil || code != 0 {
		return status, nil
	}
	parts := strings.Split(raw, "\x00")
	for i := 0; i < len(parts); i++ {
		part := parts[i]
		if len(part) < 4 {
			continue
		}
		x, y := part[0], part[1]
		path := part[3:]
		if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
			i++ // 重命名的旧路径占一个 NUL 字段
		}
		status.Entries = append(status.Entries, GitFileState{
			Path:  filepath.ToSlash(filepath.Join(status.Root, filepath.FromSlash(path))),
			State: gitBadgeState(x, y),
		})
	}
	return status, nil
}

// GitDiffFor 返回指定文件相对 HEAD 的差异（unified patch）。
func (a *App) GitDiffFor(dir string, path string) (*GitDiffResult, error) {
	result := &GitDiffResult{}
	dir = strings.TrimSpace(dir)
	path = strings.TrimSpace(path)
	if dir == "" || path == "" {
		return nil, fmt.Errorf("缺少目录或文件路径")
	}
	out, _, err := gitRun(dir, []string{"diff", "HEAD", "--", path}, 10000)
	if err != nil {
		return nil, err
	}
	out = strings.TrimRight(out, "\n")
	if out == "" {
		// 未跟踪/暂存新增文件没有 HEAD 差异
		out2, code2, _ := gitRun(dir, []string{"diff", "--cached", "--", path}, 10000)
		if code2 == 0 && strings.TrimSpace(out2) != "" {
			result.HasChanges = true
			result.Diff = strings.TrimRight(out2, "\n")
		}
		return result, nil
	}
	result.HasChanges = true
	result.Diff = out
	return result, nil
}
