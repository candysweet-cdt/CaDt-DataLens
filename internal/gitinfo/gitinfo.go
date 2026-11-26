// Package gitinfo：Git 浅集成引擎——调系统 git 做只读查询与低风险操作，
// 未安装或不在仓库内时优雅降级（Available=false）。
package gitinfo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/chardec"
	"datalens/internal/executil"
)

// gitProbeReason 把「探测仓库失败」翻译成用户能据此行动的原因。
//
// gitRun 的约定是：退出码非 0 走 code（err=nil），只有**进程没跑起来**才返回 err。
// 而「进程没跑起来」至少有三种原因，用户要做的事完全不同：
//
//	找不到可执行文件 → 去装 git          （exec.ErrNotFound）
//	工作目录已被删/改名 → 重新打开目录     （进程创建失败）
//	超时 / 其它启动失败 → 看具体错误
//
// 以前调用点一律写「未安装 git」：用户对着一个已被删除的目录（或别的启动失败）
// 被指去装 git，装完照样不行。实测反馈就是「非 git 目录显示未安装 git」。
//
// 为什么还要 stat 兜底：Windows 的进程创建失败只给一句
// `fork/exec C:\...\git.exe: The directory name is invalid.`
// —— 既不是 fs.ErrNotExist 也不含 chdir，纯文本匹配靠不住（实测这个用例就是红的）。
// 所以先按 errno 判，判不出来再看**目录本身还在不在**。
func gitProbeReason(dir string, err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, exec.ErrNotFound) {
		return "未安装 git"
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "当前目录不存在"
	}
	// 环境类失败（cwd 无效 / 权限）：stat 一眼看出目录还在不在
	if dir != "" {
		if _, statErr := os.Stat(dir); statErr != nil {
			return "当前目录不存在"
		}
	}
	return "git 无法启动：" + err.Error()
}

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

// OnMutateWorktree 会成批改写工作树的 git 子命令（切换/检出分支、丢弃改动、清理、
// 合并/变基/拉取更新）前后回调，返回的 done 在命令结束时调用。根壳注入 watcher 静默门：
// 「切分支」会把当前分支独有的文件从工作树里删掉，几秒内几十上百条删除事件，
// 不声明就会被工作区破坏防护当成大范围文件消失（2026-11-19 举一反三排查）。
var OnMutateWorktree func() (done func())

// worktreeMutatingSubcommands 会批量删除/移动工作树文件的子命令白名单。
// 只列白名单而不是黑名单（只读命令太多，漏一个反而更糟）。
var worktreeMutatingSubcommands = map[string]bool{
	"checkout": true, "switch": true, "restore": true, "reset": true,
	"stash": true, "merge": true, "rebase": true, "cherry-pick": true,
	"revert": true, "pull": true, "clean": true, "read-tree": true,
	"rm": true, "mv": true, "submodule": true, "apply": true,
}

// gitSubcommand 取 git 子命令名：跳过前导全局选项（-c / -C / --git-dir 等）。
func gitSubcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			if i+1 < len(args) {
				return strings.ToLower(args[i+1])
			}
			return ""
		}
		if strings.HasPrefix(arg, "-") {
			// 带值的全局选项（-c key=val / -C path / --git-dir=…）：无 "=" 时跳过它的值
			if !strings.Contains(arg, "=") && i+1 < len(args) && (arg == "-c" || arg == "-C" || arg == "--git-dir" || arg == "--work-tree" || arg == "--namespace" || arg == "--exec-path") {
				i++
			}
			continue
		}
		return strings.ToLower(arg)
	}
	return ""
}

func gitRun(dir string, args []string, timeoutMs int) (string, int, error) {
	if OnMutateWorktree != nil && worktreeMutatingSubcommands[gitSubcommand(args)] {
		if done := OnMutateWorktree(); done != nil {
			defer done()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	executil.HideCommandWindow(cmd) // CREATE_NO_WINDOW，防 GUI 进程拉起 git 时闪黑窗；非 Windows 空实现
	// 环境隔离（对齐 ZCode managed-worktree §6.5）：GUI 进程继承的环境里可能残留
	// GIT_DIR / GIT_WORK_TREE 等重定向变量（用户从带这些变量的终端拉起应用、或在
	// 别的仓库里设置了它们），它们会让 cmd.Dir 失效——git 跑到别的仓库去。
	// 逐个剔除而不是整体换空环境，保留 PATH / HOME / 代理等正常配置。
	cmd.Env = sanitizeGitEnv(os.Environ())
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

// gitEnvRedirectKeys 会重定向 git 仓库位置的变量：一律剔除，保证 cmd.Dir 就是 git 眼中的仓库。
var gitEnvRedirectKeys = []string{
	"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
}

func sanitizeGitEnv(environ []string) []string {
	out := make([]string, 0, len(environ)+1)
	for _, entry := range environ {
		eq := strings.IndexByte(entry, '=')
		key := entry
		if eq >= 0 {
			key = entry[:eq]
		}
		skip := false
		for _, blocked := range gitEnvRedirectKeys {
			if strings.EqualFold(key, blocked) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, entry)
		}
	}
	// GUI 进程没有可用终端：禁止 git 等待终端输入，网络操作失败时直接返回输出
	return append(out, "GIT_TERMINAL_PROMPT=0")
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

// StatusFor 返回 dir 所在仓库的文件状态（供文件树角标）。
func StatusFor(dir string) (*GitTreeStatus, error) {
	status := &GitTreeStatus{Entries: []GitFileState{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		status.Reason = "没有打开的目录"
		return status, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		status.Reason = gitProbeReason(dir, err)
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
	// ConflictFiles 非空表示签出被未提交改动挡住：这些文件的本地改动会被覆盖
	// （前端据此弹「强制签出 / 智能签出 / 不签出」对话框）。
	ConflictFiles []string `json:"conflictFiles,omitempty"`
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

// BranchesFor 返回分支弹窗所需数据：本地/远程/标签/最近分支、上游与领先落后。
// includeRemote=false 时跳过 refs/remotes（远程列表由前端缓存，只在手动刷新时重读）。
func BranchesFor(dir string, includeRemote bool) (*GitBranchesResult, error) {
	result := &GitBranchesResult{Recent: []string{}, Local: []GitBranchInfo{}, Remote: []GitBranchInfo{}, Tags: []string{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		result.Reason = "没有打开的目录"
		return result, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		result.Reason = gitProbeReason(dir, err)
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

// CheckoutBranch 签出本地分支；远程分支会创建同名本地跟踪分支。
func CheckoutBranch(dir string, name string, remote bool) (*GitOperationResult, error) {
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

// CreateBranch 从当前 HEAD 新建分支并立即检出。
func CreateBranch(dir string, name string) (*GitOperationResult, error) {
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

// CheckoutRef 签出分支、标签或提交 SHA（标签/提交会进入 detached HEAD）。
// 被未提交改动挡住时（would be overwritten by checkout），解析出受影响文件列表
// 供前端弹「强制签出 / 智能签出 / 不签出」。
func CheckoutRef(dir string, ref string) (*GitOperationResult, error) {
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
	res := &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}
	if code != 0 {
		res.ConflictFiles = parseCheckoutConflictFiles(out)
	}
	branch := ""
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		branch = strings.TrimSpace(b)
	}
	res.Branch = branch
	return res, nil
}

// parseCheckoutConflictFiles 从 checkout 的失败输出里解析会被覆盖的文件列表。
// 典型输出：
//
//	error: Your local changes to the following files would be overwritten by checkout:
//		src/foo.js
//		src/bar.js
//	Please commit your changes or stash them before you switch branches.
//	Aborting
func parseCheckoutConflictFiles(out string) []string {
	files := []string{}
	inList := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.Contains(line, "would be overwritten by") {
			inList = true
			continue
		}
		if inList {
			t := strings.TrimSpace(line)
			if t == "" || !strings.HasPrefix(line, "\t") {
				if t != "" {
					break // 非缩进行 = 列表结束（Please... / Aborting）
				}
				continue
			}
			files = append(files, t)
		}
	}
	return files
}

// Pull 更新项目：拉取并合并当前分支的上游（git pull）。
func Pull(dir string) (*GitOperationResult, error) {
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

// Push 推送当前分支；没有上游时自动设置 origin 为上游。
func Push(dir string) (*GitOperationResult, error) {
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

// Fetch 获取所有远程分支并清理已删除的远程跟踪分支。
func Fetch(dir string) (*GitOperationResult, error) {
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

// CloneRepository 克隆仓库到目标目录（目标必须不存在或为空）。
func CloneRepository(url string, target string) (*GitOperationResult, error) {
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

// CommitChanges 暂存勾选的文件并提交（可选修正/推送）。
func CommitChanges(dir string, message string, paths []string, amend bool, push bool) (*GitCommitResult, error) {
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
// path 支持两种形态：绝对路径，或相对 root 的路径——git status 输出的是
// 相对仓库根的路径，前端原样传回（2026-11-19 修复：此前 Rel(root, 相对path)
// 在 Windows 上直接报错，导致 git 面板的回滚恒被拒「路径越界」）。
func gitPathInRoot(root, path string) bool {
	p := path
	if !filepath.IsAbs(p) {
		p = filepath.Join(root, p)
	}
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// RollbackFor 回滚指定文件：已跟踪还原到 HEAD，未跟踪直接删除。
func RollbackFor(dir string, paths []string, untracked []string) error {
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
		// 相对路径以 dir 为基准解析：os.Remove 不会自己按 dir 走，
		// 直接用相对路径会删到应用进程 cwd 下的同名文件（2026-11-19 修复）。
		full := p
		if !filepath.IsAbs(full) {
			full = filepath.Join(dir, full)
		}
		if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// FileHistoryFor 返回指定文件的提交历史文本。
func FileHistoryFor(dir string, path string, limit int) (string, error) {
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

// RecentLogFor 返回仓库最近的提交历史文本。
func RecentLogFor(dir string, limit int) (string, error) {
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

// trimDiffTail 只去掉 git 输出末尾的那一个换行。
// 不能用 TrimRight(out, "\n")：hunk 的最后一行可能是空上下文行，git 默认输出
// " "（空格 + 换行），而 diff.suppressBlankEmpty / --suppress-blank-empty 会输出纯空行。
// TrimRight 会把「空行 + 行尾换行」一起吃光，hunk 比 @@ 头少一行，差异视图随即报
// PATCH_PARSE（「头部声明 -226,7 +226,7，实际数出 -6 +6」）。
func trimDiffTail(out string) string {
	return strings.TrimSuffix(out, "\n")
}

// DiffFor 返回指定文件相对 HEAD 的差异（unified patch）。
func DiffFor(dir string, path string) (*GitDiffResult, error) {
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
	out = trimDiffTail(out)
	if out == "" {
		// 暂存新增文件没有 HEAD 差异
		out2, code2, _ := gitRun(dir, []string{"diff", "--cached", "--", path}, 10000)
		if code2 == 0 && strings.TrimSpace(out2) != "" {
			result.HasChanges = true
			result.Diff = trimDiffTail(out2)
		} else if patch, ok := untrackedFileUnifiedDiff(dir, path); ok {
			// 未跟踪文件：HEAD 与索引都没有版本，按「全部新增」生成补丁
			result.HasChanges = true
			result.Diff = patch
		}
		return result, nil
	}
	result.HasChanges = true
	result.Diff = out
	return result, nil
}

// untrackedFileUnifiedDiff 为未被 git 跟踪的文本文件生成「新文件」补丁。
// 已跟踪、目录、过大或二进制文件返回 false。
func untrackedFileUnifiedDiff(dir, path string) (string, bool) {
	if _, code, _ := gitRun(dir, []string{"ls-files", "--error-unmatch", "--", path}, 5000); code != 1 {
		return "", false
	}
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(dir, path)
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() || info.Size() > 2<<20 {
		return "", false
	}
	raw, err := os.ReadFile(abs)
	if err != nil || chardec.LooksBinary(raw) {
		return "", false
	}
	return newFileUnifiedDiff(filepath.ToSlash(strings.TrimPrefix(path, "./")), string(raw)), true
}

// newFileUnifiedDiff 按 git 新文件补丁格式拼接内容，供差异视图直接展示。
func newFileUnifiedDiff(rel, content string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\n", rel, rel)
	b.WriteString("new file mode 100644\n")
	b.WriteString("--- /dev/null\n")
	fmt.Fprintf(&b, "+++ b/%s\n", rel)
	text := strings.ReplaceAll(content, "\r\n", "\n")
	if text == "" {
		return strings.TrimRight(b.String(), "\n")
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteString("+" + line + "\n")
	}
	if !strings.HasSuffix(text, "\n") {
		b.WriteString("\\ No newline at end of file\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// GitLineMarks 行级标记：0 基行号集合（代码视图行号左侧色条用）。
type GitLineMarks struct {
	Added     []int `json:"added"`
	Modified  []int `json:"modified"`
	DelBefore []int `json:"delBefore"`
}

// LineMarksFor 对比 HEAD 中的版本与传入的编辑器内容，产出行级标记。
// path 为仓库内文件的绝对路径；文件不在 HEAD 中时视为空基线（全部算新增）。
func LineMarksFor(dir string, path string, content string) (*GitLineMarks, error) {
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
