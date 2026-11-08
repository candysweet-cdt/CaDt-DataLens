package main

import (
	"context"
	"fmt"
	"os/exec"
	"os"
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

// gitBadgeState 返回细分状态：untracked/added/modified/deleted/renamed/conflict。
func gitBadgeState(x, y byte) string {
	if x == '?' || y == '?' {
		return "untracked"
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
	if x == 'A' || x == 'C' {
		return "added"
	}
	if y == 'M' || y == 'T' || x == 'M' || x == 'T' {
		return "modified"
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

type GitCommitResult struct {
	Success bool   `json:"success"`
	Output  string `json:"output"`
}

// GitCommitChanges 暂存勾选的文件并提交（可选修正/推送）。
func (a *App) GitCommitChanges(dir string, message string, paths []string, amend bool, push bool) (*GitCommitResult, error) {
	dir = strings.TrimSpace(dir)
	message = strings.TrimSpace(message)
	if dir == "" {
		return nil, fmt.Errorf("缺少目录")
	}
	if !amend && message == "" {
		return nil, fmt.Errorf("提交消息不能为空")
	}
	output := ""
	// 暂存勾选的文件（修正模式不强制重新 add）
	if len(paths) > 0 {
		args := append([]string{"add", "--"}, paths...)
		addOut, code, addErr := gitRun(dir, args, 30000)
		if addErr != nil {
			return nil, addErr
		}
		output += addOut
		if code != 0 {
			return &GitCommitResult{Success: false, Output: strings.TrimSpace(output)}, nil
		}
	}
	commitArgs := []string{"commit", "-m", message}
	if amend {
		commitArgs = append(commitArgs, "--amend")
	}
	out, code, err := gitRun(dir, commitArgs, 60000)
	if err != nil {
		return nil, err
	}
	output += "\n" + out
	if code != 0 {
		return &GitCommitResult{Success: false, Output: strings.TrimSpace(output)}, nil
	}
	if push {
		pushOut, pushCode, pushErr := gitRun(dir, []string{"push"}, 120000)
		if pushErr != nil {
			return nil, pushErr
		}
		output += "\n" + pushOut
		if pushCode != 0 {
			return &GitCommitResult{Success: false, Output: strings.TrimSpace(output)}, nil
		}
	}
	return &GitCommitResult{Success: true, Output: strings.TrimSpace(output)}, nil
}

// gitPathInRoot 校验 path 必须位于 root 之内（防穿越）。
func gitPathInRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// GitRollbackFor 回滚指定文件：已跟踪还原到 HEAD，未跟踪直接删除。
func (a *App) GitRollbackFor(dir string, paths []string, untracked []string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return fmt.Errorf("缺少目录")
	}
	for _, p := range paths {
		if !gitPathInRoot(dir, p) {
			return fmt.Errorf("路径越界：%s", p)
		}
	}
	for _, p := range untracked {
		if !gitPathInRoot(dir, p) {
			return fmt.Errorf("路径越界：%s", p)
		}
	}
	if len(paths) > 0 {
		if _, code, err := gitRun(dir, append([]string{"checkout", "HEAD", "--"}, paths...), 30000); err != nil {
			return err
		} else if code != 0 {
			return fmt.Errorf("git checkout 返回 %d", code)
		}
	}
	for _, p := range untracked {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// GitFileHistoryFor 返回指定文件的提交历史文本。
func (a *App) GitFileHistoryFor(dir string, path string, limit int) (string, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	out, _, err := gitRun(dir, []string{
		"log", "--follow", "-n", fmt.Sprintf("%d", limit),
		"--date=format:%Y-%m-%d %H:%M",
		"--pretty=format:%h | %ad | %an | %s",
		"--", path,
	}, 20000)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// GitRecentLogFor 返回仓库最近的提交历史文本。
func (a *App) GitRecentLogFor(dir string, limit int) (string, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	out, _, err := gitRun(dir, []string{
		"log", "-n", fmt.Sprintf("%d", limit),
		"--date=format:%Y-%m-%d %H:%M",
		"--pretty=format:%h | %ad | %an | %s",
	}, 20000)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
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
