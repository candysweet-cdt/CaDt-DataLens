package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	// GUI 进程没有可用终端：禁止 git 等待终端输入，网络操作失败时直接返回输出
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
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

// gitBadgeState 返回细分状态：untracked/added/modified/deleted/renamed/conflict/ignored。
func gitBadgeState(x, y byte) string {
	if x == '!' || y == '!' {
		return "ignored"
	}
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
	raw, code, err := gitRun(dir, []string{"status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored"}, 10000)
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
		// 忽略目录在 porcelain 输出中带尾斜杠（!! dir/），去掉以匹配文件树行路径
		path = strings.TrimSuffix(path, "/")
		status.Entries = append(status.Entries, GitFileState{
			Path:  filepath.ToSlash(filepath.Join(status.Root, filepath.FromSlash(path))),
			State: gitBadgeState(x, y),
		})
	}
	return status, nil
}

// ===== 分支弹窗（IDEA 式分支管理） =====

type GitBranchInfo struct {
	Name     string `json:"name"`
	Current  bool   `json:"current"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Gone     bool   `json:"gone,omitempty"`
}

type GitBranchesResult struct {
	Available bool            `json:"available"`
	Reason    string          `json:"reason,omitempty"`
	Root      string          `json:"root,omitempty"`
	Current   string          `json:"current,omitempty"`
	Recent    []string        `json:"recent"`
	Local     []GitBranchInfo `json:"local"`
	Remote    []GitBranchInfo `json:"remote"`
	Tags      []string        `json:"tags"`
}

type GitOperationResult struct {
	Success bool   `json:"success"`
	Output  string `json:"output"`
	Branch  string `json:"branch,omitempty"`
	Path    string `json:"path,omitempty"`
}

// parseUpstreamTrack 解析 for-each-ref 的 %(upstream:track)：[ahead 1, behind 2] / [gone]
func parseUpstreamTrack(track string) (ahead int, behind int, gone bool) {
	track = strings.TrimSpace(track)
	if track == "" {
		return
	}
	if strings.Contains(track, "gone") {
		gone = true
		return
	}
	track = strings.TrimPrefix(track, "[")
	track = strings.TrimSuffix(track, "]")
	for _, part := range strings.Split(track, ",") {
		part = strings.TrimSpace(part)
		switch {
		case strings.HasPrefix(part, "ahead "):
			ahead, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(part, "ahead ")))
		case strings.HasPrefix(part, "behind "):
			behind, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(part, "behind ")))
		}
	}
	return
}

// parseBranchRefLines 解析本地分支 for-each-ref 输出：名称<TAB>上游<TAB>跟踪状态<TAB>HEAD 标记
func parseBranchRefLines(raw string) []GitBranchInfo {
	branches := []GitBranchInfo{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		info := GitBranchInfo{Name: name, Current: strings.TrimSpace(parts[3]) == "*"}
		info.Upstream = strings.TrimSpace(parts[1])
		info.Ahead, info.Behind, info.Gone = parseUpstreamTrack(parts[2])
		branches = append(branches, info)
	}
	return branches
}

// parseRemoteRefLines 解析远程分支；%(refname:short) 会把 refs/remotes/origin/HEAD 缩成 "origin"，
// 所以这里用完整 refname + symref 判断并排除远程 HEAD 等符号引用。
func parseRemoteRefLines(raw string) []GitBranchInfo {
	branches := []GitBranchInfo{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		full := strings.TrimSpace(parts[0])
		symref := strings.TrimSpace(parts[1])
		if symref != "" || strings.HasSuffix(full, "/HEAD") {
			continue
		}
		name := strings.TrimPrefix(full, "refs/remotes/")
		if name == "" || name == full || !strings.Contains(name, "/") {
			continue
		}
		branches = append(branches, GitBranchInfo{Name: name})
	}
	return branches
}

// recentBranchesFromReflog 从 reflog 的 checkout 记录里取最近检出的本地分支。
func recentBranchesFromReflog(raw string, local map[string]bool, current string, limit int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		const prefix = "checkout: moving from "
		idx := strings.Index(line, prefix)
		if idx < 0 {
			continue
		}
		rest := line[idx+len(prefix):]
		at := strings.LastIndex(rest, " to ")
		if at < 0 {
			continue
		}
		name := strings.TrimSpace(rest[at+4:])
		if !local[name] || name == current || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
		if len(out) >= limit {
			return out
		}
	}
	return out
}

// GitBranchesFor 返回分支弹窗所需数据：本地/远程/标签/最近分支、上游与领先落后。
// includeRemote=false 时跳过 refs/remotes（远程列表由前端缓存，只在手动刷新时重读）。
func (a *App) GitBranchesFor(dir string, includeRemote bool) (*GitBranchesResult, error) {
	result := &GitBranchesResult{Recent: []string{}, Local: []GitBranchInfo{}, Remote: []GitBranchInfo{}, Tags: []string{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		result.Reason = "没有打开的目录"
		return result, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		result.Reason = "未安装 git"
		return result, nil
	}
	if code != 0 || strings.TrimSpace(out) != "true" {
		result.Reason = "不在 git 仓库内"
		return result, nil
	}
	result.Available = true
	if root, _, _ := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000); root != "" {
		result.Root = strings.TrimSpace(root)
	}
	if branch, bcode, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); bcode == 0 {
		result.Current = strings.TrimSpace(branch)
	}
	format := "%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(HEAD)"
	if raw, c, _ := gitRun(dir, []string{"for-each-ref", "--format=" + format, "refs/heads"}, 10000); c == 0 {
		result.Local = parseBranchRefLines(raw)
	}
	if includeRemote {
		if raw, c, _ := gitRun(dir, []string{"for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes"}, 10000); c == 0 {
			result.Remote = parseRemoteRefLines(raw)
		}
	}
	if raw, c, _ := gitRun(dir, []string{"for-each-ref", "--sort=-creatordate", "--count=200", "--format=%(refname:short)", "refs/tags"}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			if tag := strings.TrimSpace(line); tag != "" {
				result.Tags = append(result.Tags, tag)
			}
		}
	}
	if raw, c, _ := gitRun(dir, []string{"reflog", "--format=%gs", "-n", "100"}, 5000); c == 0 {
		localNames := make(map[string]bool, len(result.Local))
		for _, b := range result.Local {
			localNames[b.Name] = true
		}
		result.Recent = recentBranchesFromReflog(raw, localNames, result.Current, 5)
	}
	return result, nil
}

func gitBranchRefExists(dir, ref string) bool {
	_, code, err := gitRun(dir, []string{"show-ref", "--verify", "--quiet", ref}, 5000)
	return err == nil && code == 0
}

// GitCheckoutBranch 签出本地分支；远程分支会创建同名本地跟踪分支。
func (a *App) GitCheckoutBranch(dir string, name string, remote bool) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	name = strings.TrimSpace(name)
	if dir == "" || name == "" {
		return nil, fmt.Errorf("缺少目录或分支名")
	}
	if strings.HasPrefix(name, "-") {
		return nil, fmt.Errorf("非法分支名")
	}
	if remote {
		if !gitBranchRefExists(dir, "refs/remotes/"+name) {
			return &GitOperationResult{Success: false, Output: "远程分支不存在：" + name}, nil
		}
		short := name
		if i := strings.Index(name, "/"); i >= 0 {
			short = name[i+1:]
		}
		if short == "" || strings.HasPrefix(short, "-") {
			return nil, fmt.Errorf("非法分支名")
		}
		args := []string{"checkout", "-b", short, "--track", name}
		if gitBranchRefExists(dir, "refs/heads/"+short) {
			args = []string{"checkout", short}
		}
		out, code, err := gitRun(dir, args, 30000)
		if err != nil {
			return nil, err
		}
		return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Branch: short}, nil
	}
	if !gitBranchRefExists(dir, "refs/heads/"+name) {
		return &GitOperationResult{Success: false, Output: "本地分支不存在：" + name}, nil
	}
	out, code, err := gitRun(dir, []string{"checkout", name}, 30000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Branch: name}, nil
}

// GitCreateBranch 从当前 HEAD 新建分支并立即检出。
func (a *App) GitCreateBranch(dir string, name string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	name = strings.TrimSpace(name)
	if dir == "" || name == "" {
		return nil, fmt.Errorf("缺少目录或分支名")
	}
	if strings.HasPrefix(name, "-") {
		return nil, fmt.Errorf("非法分支名")
	}
	valid, code, err := gitRun(dir, []string{"check-ref-format", "--branch", name}, 5000)
	if err != nil {
		return nil, err
	}
	if code != 0 || strings.TrimSpace(valid) != name {
		return &GitOperationResult{Success: false, Output: "分支名不合法：" + name}, nil
	}
	if gitBranchRefExists(dir, "refs/heads/"+name) {
		return &GitOperationResult{Success: false, Output: "分支已存在：" + name}, nil
	}
	out, code, err := gitRun(dir, []string{"checkout", "-b", name}, 30000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Branch: name}, nil
}

// GitCheckoutRefFor 签出分支、标签或提交 SHA（标签/提交会进入 detached HEAD）。
func (a *App) GitCheckoutRefFor(dir string, ref string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	ref = strings.TrimSpace(ref)
	if dir == "" || ref == "" {
		return nil, fmt.Errorf("缺少目录或修订")
	}
	if strings.HasPrefix(ref, "-") {
		return nil, fmt.Errorf("非法修订")
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", ref + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到标记或修订：" + ref}, nil
	}
	out, code, err := gitRun(dir, []string{"checkout", ref}, 30000)
	if err != nil {
		return nil, err
	}
	branch := ""
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		branch = strings.TrimSpace(b)
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Branch: branch}, nil
}

// GitPullFor 更新项目：拉取并合并当前分支的上游（git pull）。
func (a *App) GitPullFor(dir string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, fmt.Errorf("缺少目录")
	}
	out, code, err := gitRun(dir, []string{"pull", "--no-edit"}, 180000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}

// GitPushFor 推送当前分支；没有上游时自动设置 origin 为上游。
func (a *App) GitPushFor(dir string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, fmt.Errorf("缺少目录")
	}
	args := []string{"push"}
	branch := ""
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		branch = strings.TrimSpace(b)
	}
	if branch != "" {
		if _, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"}, 5000); c != 0 {
			args = []string{"push", "-u", "origin", branch}
		}
	}
	out, code, err := gitRun(dir, args, 180000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}

// GitFetchFor 获取所有远程分支并清理已删除的远程跟踪分支。
func (a *App) GitFetchFor(dir string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, fmt.Errorf("缺少目录")
	}
	out, code, err := gitRun(dir, []string{"fetch", "--all", "--prune"}, 180000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}

// GitCloneRepository 克隆仓库到目标目录（目标必须不存在或为空）。
func (a *App) GitCloneRepository(url string, target string) (*GitOperationResult, error) {
	url = strings.TrimSpace(url)
	target = strings.TrimSpace(target)
	if url == "" || target == "" {
		return nil, fmt.Errorf("缺少仓库地址或目标目录")
	}
	if strings.HasPrefix(url, "-") || strings.HasPrefix(target, "-") {
		return nil, fmt.Errorf("非法参数")
	}
	if info, err := os.Stat(target); err == nil {
		if !info.IsDir() {
			return &GitOperationResult{Success: false, Output: "目标已存在且不是目录：" + target}, nil
		}
		if entries, err := os.ReadDir(target); err == nil && len(entries) > 0 {
			return &GitOperationResult{Success: false, Output: "目标目录非空：" + target}, nil
		}
	}
	parent := filepath.Dir(target)
	if info, err := os.Stat(parent); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("上级目录不存在：%s", parent)
	}
	out, code, err := gitRun(parent, []string{"clone", "--", url, target}, 600000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Path: target}, nil
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

// GitLineMarks 行级标记：0 基行号集合（代码视图行号左侧色条用）。
type GitLineMarks struct {
	Added     []int `json:"added"`
	Modified  []int `json:"modified"`
	DelBefore []int `json:"delBefore"`
}

// GitLineMarksFor 对比 HEAD 中的版本与传入的编辑器内容，产出行级标记。
// path 为仓库内文件的绝对路径；文件不在 HEAD 中时视为空基线（全部算新增）。
func (a *App) GitLineMarksFor(dir string, path string, content string) (*GitLineMarks, error) {
	dir = strings.TrimSpace(dir)
	path = strings.TrimSpace(path)
	if dir == "" || path == "" {
		return nil, fmt.Errorf("缺少目录或文件路径")
	}
	rootOut, _, err := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000)
	if err != nil {
		return nil, err
	}
	root := strings.TrimSpace(rootOut)
	headText := ""
	if rel := repoRelPath(root, path); rel != "" {
		if out, code, _ := gitRun(dir, []string{"show", "HEAD:" + rel}, 10000); code == 0 {
			headText = out
		}
	}
	return computeLineMarks(headText, content), nil
}

// repoRelPath 把仓库内绝对路径转成仓库相对路径（正斜杠；Windows 下按大小写不敏感匹配仓库根）。
func repoRelPath(root, path string) string {
	rootN := strings.TrimSuffix(strings.ReplaceAll(root, "\\", "/"), "/")
	pathN := strings.ReplaceAll(path, "\\", "/")
	if len(pathN) > len(rootN)+1 && strings.EqualFold(pathN[:len(rootN)], rootN) && pathN[len(rootN)] == '/' {
		return pathN[len(rootN)+1:]
	}
	return ""
}

// splitDiffLines 按行拆分并统一换行符；末尾换行产生的空尾段丢弃。
func splitDiffLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// computeLineMarks 计算新旧文本的行级标记：公共前缀/后缀裁剪后做 LCS（规模受限），
// 变更块内删除行与新增行按顺序配对——配上的为修改（蓝），多出的新增为绿；
// 净删除的块在块后第一行上方放删除点。
func computeLineMarks(headText, content string) *GitLineMarks {
	marks := &GitLineMarks{Added: []int{}, Modified: []int{}, DelBefore: []int{}}
	oldLines := splitDiffLines(headText)
	newLines := splitDiffLines(content)

	pre := 0
	for pre < len(oldLines) && pre < len(newLines) && oldLines[pre] == newLines[pre] {
		pre++
	}
	suf := 0
	for suf < len(oldLines)-pre && suf < len(newLines)-pre &&
		oldLines[len(oldLines)-1-suf] == newLines[len(newLines)-1-suf] {
		suf++
	}

	flush := func(delRun int, addRows []int, nextNew int) {
		if delRun == 0 && len(addRows) == 0 {
			return
		}
		paired := delRun
		if len(addRows) < paired {
			paired = len(addRows)
		}
		for i := 0; i < len(addRows); i++ {
			if i < paired {
				marks.Modified = append(marks.Modified, addRows[i])
			} else {
				marks.Added = append(marks.Added, addRows[i])
			}
		}
		if delRun > len(addRows) {
			at := nextNew
			if len(addRows) > 0 {
				at = addRows[len(addRows)-1] + 1
			}
			marks.DelBefore = append(marks.DelBefore, at)
		}
	}

	ni := pre
	delRun := 0
	var addRows []int
	for _, op := range diffOps(oldLines[pre:len(oldLines)-suf], newLines[pre:len(newLines)-suf]) {
		switch op {
		case ' ':
			flush(delRun, addRows, ni)
			delRun = 0
			addRows = nil
			ni++
		case '-':
			delRun++
		case '+':
			addRows = append(addRows, ni)
			ni++
		}
	}
	flush(delRun, addRows, ni)
	return marks
}

// diffOpsMaxCells 限制 LCS DP 规模（约 8MB int32），超出按整块替换处理。
const diffOpsMaxCells = 2_000_000

// diffOps 返回编辑脚本：' ' 匹配 / '-' 删除旧行 / '+' 插入新行，按顺序排列。
func diffOps(oldLines, newLines []string) []byte {
	n, m := len(oldLines), len(newLines)
	ops := make([]byte, 0, n+m)
	if n == 0 {
		for i := 0; i < m; i++ {
			ops = append(ops, '+')
		}
		return ops
	}
	if m == 0 {
		for i := 0; i < n; i++ {
			ops = append(ops, '-')
		}
		return ops
	}
	if n*m > diffOpsMaxCells {
		for i := 0; i < n; i++ {
			ops = append(ops, '-')
		}
		for j := 0; j < m; j++ {
			ops = append(ops, '+')
		}
		return ops
	}
	dp := make([]int32, (n+1)*(m+1))
	at := func(i, j int) int { return i*(m+1) + j }
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				dp[at(i, j)] = dp[at(i+1, j+1)] + 1
			} else if dp[at(i+1, j)] >= dp[at(i, j+1)] {
				dp[at(i, j)] = dp[at(i+1, j)]
			} else {
				dp[at(i, j)] = dp[at(i, j+1)]
			}
		}
	}
	i, j := 0, 0
	for i < n && j < m {
		if oldLines[i] == newLines[j] {
			ops = append(ops, ' ')
			i++
			j++
		} else if dp[at(i+1, j)] >= dp[at(i, j+1)] {
			ops = append(ops, '-')
			i++
		} else {
			ops = append(ops, '+')
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, '-')
	}
	for ; j < m; j++ {
		ops = append(ops, '+')
	}
	return ops
}
