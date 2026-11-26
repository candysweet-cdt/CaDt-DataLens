// worktree.go：AI 隔离工作区引擎——git worktree 的创建/列表/删除/清理与草稿 diff 导出。
// worktree 一律建在 <主根>/.cadt/worktree/<slug> 下（工作区内，AI 写路径闸天然放行、
// 不用切工作区），分支 cadt/wt/<slug>。slug 由 label + 会话 id 在 Go 侧派生，不信任前端路径。
// 回灌不做在这里：WorktreeDiff 只出补丁文本，PatchSave/审批/应用仍走既有 patch 壳与前端。
package gitinfo

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// ErrWorktreeNoChanges 导出 diff 时 worktree 相对基准没有任何改动（含未跟踪文件）。
var ErrWorktreeNoChanges = errors.New("worktree 没有改动")

const (
	worktreeDirName = ".cadt/worktree" // 主根下的固定父目录（正斜杠语义）
	worktreeBranchP = "cadt/wt/"       // 隔离分支前缀；分支不保留，随 worktree 一起删
)

// slug 字符集白名单：也是路径名与分支段的安全边界（无点无斜杠，git ref 合法）。
var worktreeSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// shaRe 允许完整 40 位或 git 缩写（≥7 位）十六进制。
var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)

type GitWorktreeInfo struct {
	Path      string `json:"path"`             // 绝对路径
	RelPath   string `json:"relPath"`          // 相对仓库根，正斜杠
	Branch    string `json:"branch,omitempty"` // 去掉 refs/heads/ 前缀
	Head      string `json:"head,omitempty"`
	Detached  bool   `json:"detached,omitempty"`
	Bare      bool   `json:"bare,omitempty"`
	UnderCadt bool   `json:"underCadt,omitempty"` // 在 .cadt/worktree/ 下（AI 隔离区）
}

type GitWorktreeListResult struct {
	Available bool              `json:"available"`
	Reason    string            `json:"reason,omitempty"`
	Root      string            `json:"root,omitempty"`
	Items     []GitWorktreeInfo `json:"items"`
}

type GitWorktreeAddResult struct {
	Name          string   `json:"name"`                    // slug（.cadt/worktree/<name>）
	Branch        string   `json:"branch"`                  // cadt/wt/<name>
	Path          string   `json:"path"`                    // 绝对路径
	BaseSha       string   `json:"baseSha"`                 // 回灌 diff 的基准：carry 时是「带入快照」commit，否则是主根 HEAD
	Deps          []string `json:"deps"`                    // 已 junction 共享进 worktree 的依赖目录名（顶层白名单内存在的）
	DepErrors     []string `json:"depErrors,omitempty"`     // junction 创建失败项（依赖共享是增益不是前提）
	IncludeCopied int      `json:"includeCopied"`           // 按 .worktreeinclude 拷贝的被忽略文件数（0 = 无清单或无命中）
	IncludeErrors []string `json:"includeErrors,omitempty"` // .worktreeinclude 拷贝失败项（不致命，AI 会告知用户）
	Carried       int      `json:"carried"`                 // carry=true 时从主根带入的未提交改动文件数
}

// junctionWhitelist 依赖目录共享白名单：只共享「通常被 gitignore、由包管理器生成」的
// 顶层目录——跟踪在 git 里的目录（如 Go 的 vendor/）worktree 检出自带，不能共享（会写脏）。
// junction（mklink /J）不需要管理员权限，删除 worktree 只删 reparse 点、不动目标目录。
var junctionWhitelist = []string{"node_modules", ".venv", "venv"}

// isReparsePoint / createJunction / junctionSupported 是 Windows 专属能力（目录联接
// 与 FILE_ATTRIBUTE_REPARSE_POINT），实现分别在 worktree_platform_windows.go 与
// worktree_platform_other.go。这里不放平台代码：gitinfo 的引擎部分要保持可交叉编译。

// linkDepDirs 把主根的依赖目录 junction 进 worktree：worktree/<dep> → 主根/<dep>。
// 目标已存在（同名实体或旧 junction）跳过；创建失败记错误但不致命（依赖共享是增益不是前提）。
// 删除侧（WorktreeRemove）先递归摘掉所有 reparse 点再交 git，保证绝不误删主根依赖。
func linkDepDirs(root, wtPath string) (deps []string, depErrors []string) {
	deps = []string{}
	depErrors = []string{}
	if !junctionSupported {
		return deps, depErrors // 非 Windows 没有 junction：依赖共享整体跳过
	}
	for _, dep := range junctionWhitelist {
		src := filepath.Join(root, dep)
		info, err := os.Stat(src)
		if err != nil || !info.IsDir() {
			continue // 主根没有这个依赖目录
		}
		dst := filepath.Join(wtPath, dep)
		if _, err := os.Lstat(dst); err == nil {
			continue // worktree 里已有同名实体（异常情况），不覆盖
		}
		if err := createJunction(dst, src); err != nil {
			depErrors = append(depErrors, dep+": "+err.Error())
			continue
		}
		deps = append(deps, dep)
	}
	return deps, depErrors
}

// createJunction 见 worktree_platform_windows.go（mklink /J）与 _other.go（不支持）。

// unlinkReparsePoints 递归摘掉 worktree 里的**所有** reparse point（junction / 目录或
// 文件符号链接），只删链接本身、不动目标；返回没能摘除（或无法遍历）的路径。
// WorktreeRemove 必须在 git 之前调用：
// git 的递归删除在 Windows 上会跟进 junction，把主根依赖目录的内容删空——2026-11-17 真机：
// AI 在隔离区 frontend/ 里手动 mklink /J node_modules → 主根 frontend/node_modules，
// discard 后主根依赖被清空（老实现只摘 worktree 根一层的白名单名，扫不到嵌套 junction）。
// WalkDir 对 junction 不下钻（Go 1.27 Windows 实测），正好逐个发现并摘除；跳过 .git 目录。
// 调用方拿到非空结果必须**中止删除**（fail-closed）：残留链接就是「git 会跟进删目标」的缺口。
func unlinkReparsePoints(wtPath string) []string {
	// 根节点本身是链接：绝不能交给 git（会跟进删目标）。不擅自摘除——fail-closed，
	// 让用户确认后再处理（2026-11-17 复查：根被替换成 junction 时 git 会删空目标）。
	if isReparsePoint(wtPath) {
		return []string{wtPath}
	}
	var left []string
	_ = filepath.WalkDir(wtPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == wtPath && errors.Is(err, fs.ErrNotExist) {
				return nil // 目录已不存在：没有可误删的目标，交给 git 处理残留记录
			}
			left = append(left, path) // 子树读不到：可能有未知链接，交调用方拒绝删除
			return nil
		}
		if path == wtPath {
			return nil
		}
		if isReparsePoint(path) {
			if rmErr := os.Remove(path); rmErr != nil {
				left = append(left, path)
			}
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// 不跳过 .git：worktree 的 .git 通常是文件，但嵌套 .git 目录里若被塞了链接，
		// 跳过等于把缺口留给 git（复查实测该路径能删空目标）。
		return nil
	})
	return left
}

// reparseRelPaths 返回 worktree 内所有链接的相对路径（正斜杠），供 WorktreeDiff 的
// git add -N 排除。junction 目标若没被 .gitignore 覆盖，git 会把主根依赖内容当新文件
// 索引进补丁（2026-11-17 复查实测），导出结果会被污染。
func reparseRelPaths(wtPath string) []string {
	var rels []string
	_ = filepath.WalkDir(wtPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == wtPath {
			return nil
		}
		if !isReparsePoint(path) {
			return nil
		}
		if rel, rerr := filepath.Rel(wtPath, path); rerr == nil {
			rels = append(rels, filepath.ToSlash(rel))
		}
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	return rels
}

// pathUnderReparse 判断 wtPath 内相对路径 rel 的任一父目录（含 rel 自身的父级，不含
// wtPath 本身）是否是 reparse 点（junction）——junction 已共享主根目录，往里拷文件
// 既写穿主根又可能破坏链接，一律跳过（.worktreeinclude 与 carry 的未跟踪拷贝共用）。
func pathUnderReparse(wtPath, rel string) bool {
	dir := filepath.Dir(filepath.Join(wtPath, filepath.FromSlash(rel)))
	for {
		if strings.EqualFold(filepath.Clean(dir), filepath.Clean(wtPath)) {
			return false
		}
		if isReparsePoint(dir) {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

// copyWorktreeInclude 按 <主根>/.worktreeinclude（gitignore 语法）把「被 git 忽略 且
// 匹配清单」的文件从主根拷进刚检出的 worktree（.env 这类 dotfiles——junction 只能共享
// 目录、覆盖不了它们；对齐 ZCode §3.4）。规则：只拷普通文件（符号链接跳过）、不覆盖
// 已存在文件、junction 父目录下跳过（已共享）、并发 8；返回拷贝数与失败项（不致命）。
func copyWorktreeInclude(root, wtPath string) (int, []string) {
	data, err := os.ReadFile(filepath.Join(root, ".worktreeinclude"))
	if err != nil {
		return 0, nil // 没有清单：不拷贝任何东西（没有默认清单的约定）
	}
	patterns := false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			patterns = true
			break
		}
	}
	if !patterns {
		return 0, nil
	}
	stdOut, _, e1 := gitRun(root, []string{"ls-files", "--others", "--ignored", "--exclude-standard", "-z"}, 30000)
	incOut, _, e2 := gitRun(root, []string{"ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"}, 30000)
	if e1 != nil || e2 != nil {
		return 0, []string{"读取忽略文件清单失败"}
	}
	standard := splitZList(stdOut)
	included := splitZList(incOut)
	var want []string
	for rel := range included {
		if rel != "" && standard[rel] {
			want = append(want, rel)
		}
	}
	if len(want) == 0 {
		return 0, nil
	}
	var mu sync.Mutex
	copied, errs := 0, []string{}
	sem := make(chan struct{}, 8) // 并发上限（对齐 ZCode §3.4）
	var wg sync.WaitGroup
	for _, rel := range want {
		wg.Add(1)
		go func(rel string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if pathUnderReparse(wtPath, rel) {
				return // junction 已共享，跳过（不算失败）
			}
			src := filepath.Join(root, filepath.FromSlash(rel))
			info, lerr := os.Lstat(src)
			if lerr != nil || !info.Mode().IsRegular() {
				return // 符号链接 / 非普通文件跳过
			}
			dst := filepath.Join(wtPath, filepath.FromSlash(rel))
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				mu.Lock()
				errs = append(errs, rel+": "+err.Error())
				mu.Unlock()
				return
			}
			if err := copyFileExclusive(src, dst); err != nil {
				if errors.Is(err, fs.ErrExist) {
					return // 不覆盖已存在文件
				}
				mu.Lock()
				errs = append(errs, rel+": "+err.Error())
				mu.Unlock()
				return
			}
			mu.Lock()
			copied++
			mu.Unlock()
		}(rel)
	}
	wg.Wait()
	return copied, errs
}

// copyFileExclusive 普通文件拷贝，目标已存在（含 junction/目录）时报 fs.ErrExist。
func copyFileExclusive(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}

// splitZList 解析 git -z 输出（NUL 分隔）为集合。
func splitZList(out string) map[string]bool {
	set := map[string]bool{}
	for _, name := range strings.Split(out, "\x00") {
		if name = strings.TrimSpace(name); name != "" {
			set[name] = true
		}
	}
	return set
}

// carryWorkingChanges 把主根当前未提交改动带入刚检出的 worktree（对齐 ZCode fork §3.6 的
// binary patch 做法）：暂存补丁（--index，保留暂存划分）→ 未暂存补丁 → 未跟踪文件拷贝
// → 打一个机器快照 commit 并返回新 HEAD。补丁基于同一个 HEAD，应用不会冲突。
// 快照 commit 让 export 的 diff 语义保持「只含 AI 的草稿改动」——用户原有改动不会再被
// 回灌一遍；隔离分支被 discard 删除，快照不留历史。
func carryWorkingChanges(root, wtPath, baseSha string) (int, string, error) {
	staged, _, err1 := gitRun(root, []string{"diff", "--cached", "--binary", baseSha}, 30000)
	if err1 != nil {
		return 0, "", err1
	}
	unstaged, _, err2 := gitRun(root, []string{"diff", "--binary"}, 30000)
	if err2 != nil {
		return 0, "", err2
	}
	untracked, _, err3 := gitRun(root, []string{"ls-files", "--others", "--exclude-standard", "-z"}, 30000)
	if err3 != nil {
		return 0, "", err3
	}
	if err := applyCarryPatch(wtPath, staged, true); err != nil {
		return 0, "", fmt.Errorf("暂存改动带入失败: %w", err)
	}
	if err := applyCarryPatch(wtPath, unstaged, false); err != nil {
		return 0, "", fmt.Errorf("未暂存改动带入失败: %w", err)
	}
	for _, rel := range strings.Split(untracked, "\x00") {
		rel = strings.TrimSpace(rel)
		if rel == "" || pathUnderReparse(wtPath, rel) {
			continue
		}
		src := filepath.Join(root, filepath.FromSlash(rel))
		info, lerr := os.Lstat(src)
		if lerr != nil || !info.Mode().IsRegular() {
			continue // 符号链接 / 非普通文件跳过
		}
		dst := filepath.Join(wtPath, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return 0, "", err
		}
		if err := copyFileExclusive(src, dst); err != nil && !errors.Is(err, fs.ErrExist) {
			return 0, "", err
		}
	}
	// 统计带入量：apply + 拷贝后的全部工作区改动
	status, _, stErr := gitRun(wtPath, []string{"status", "--porcelain"}, 15000)
	if stErr != nil {
		return 0, "", stErr
	}
	carried := 0
	for _, line := range strings.Split(status, "\n") {
		if strings.TrimSpace(line) != "" {
			carried++
		}
	}
	if carried == 0 {
		return 0, baseSha, nil // 主根本来就是干净的：不用快照
	}
	addArgs := []string{"add", "-A", "--"}
	for _, rel := range reparseRelPaths(wtPath) {
		addArgs = append(addArgs, ":(exclude,literal)"+rel)
	}
	if _, code, err := gitRun(wtPath, addArgs, 60000); err != nil || code != 0 {
		return 0, "", fmt.Errorf("暂存带入改动失败")
	}
	out, code, err := gitRun(wtPath, []string{
		"-c", "user.name=cadt-carry", "-c", "user.email=cadt-carry@local",
		"commit", "--no-verify", "-m", "cadt: carry main working changes",
	}, 60000)
	if err != nil {
		return 0, "", err
	}
	if code != 0 {
		return 0, "", fmt.Errorf("快照 commit 失败：%s", strings.TrimSpace(out))
	}
	newSha, shaCode, shaErr := gitRun(wtPath, []string{"rev-parse", "HEAD"}, 5000)
	if shaErr != nil || shaCode != 0 {
		return 0, "", fmt.Errorf("快照 commit 后取 HEAD 失败")
	}
	return carried, strings.TrimSpace(newSha), nil
}

// applyCarryPatch 把一段 binary patch 写临时文件后在工作区内应用（gitRun 不支持 stdin）。
func applyCarryPatch(wtPath, patch string, index bool) error {
	if strings.TrimSpace(patch) == "" {
		return nil
	}
	tmp, err := os.CreateTemp("", "cadt-carry-*.patch")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.WriteString(patch); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	args := []string{"apply", "--whitespace=nowarn"}
	if index {
		args = append(args, "--index")
	}
	args = append(args, name)
	_, code, err := gitRun(wtPath, args, 60000)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("git apply 退出码 %d", code)
	}
	return nil
}

// WorktreeStat 返回 worktree 的改动统计（git diff --stat 文本，供列表与胶囊快速对比
// 多个隔离区的改动量；完整补丁仍走 WorktreeDiff）。baseSha 有效时对比创建基准（全量
// 草稿语义）；为空或非法时对比 HEAD（该 worktree 自己的未提交改动——外部 worktree /
// 会话登记丢失时仍可用）。
func WorktreeStat(root, name, baseSha string) (string, error) {
	root = strings.TrimSpace(root)
	path, err := worktreePathOf(root, strings.TrimSpace(name))
	if err != nil {
		return "", err
	}
	base := "HEAD"
	baseSha = strings.TrimSpace(baseSha)
	if shaRe.MatchString(baseSha) {
		base = baseSha
	}
	stageIntentToAdd(path)
	out, code, err := gitRun(path, []string{"diff", "--no-renames", "--stat", base}, 30000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("git diff --stat 失败（worktree：%s）", name)
	}
	return strings.TrimRight(out, "\n"), nil
}

// stageIntentToAddArgs 给 worktree 的未跟踪文件登记 intent-to-add 的 git 参数
// （未跟踪文件不进 diff/stat 的通用前置步骤，WorktreeDiff 与 WorktreeStat 共用）；
// junction 路径照常排除——未 gitignore 的 junction 目标会被当成新文件索引（复查实测）。
func stageIntentToAddArgs(path string) []string {
	addArgs := []string{"add", "-N", "--", "."}
	for _, rel := range reparseRelPaths(path) {
		addArgs = append(addArgs, ":(exclude,literal)"+rel)
	}
	return addArgs
}

func stageIntentToAdd(path string) {
	_, _, _ = gitRun(path, stageIntentToAddArgs(path), 30000)
}

// deriveSlug 由 label + 会话 id 派生 slug：小写、[^a-z0-9-] 折成 -、截断 32，拼会话 id
// 末 8 位字母数字（会话 id 形如 session-<base36 时间戳><5 位随机>，取尾部才是高熵段）；
// label 清洗后为空用 "wt"。纯函数，可单测。
func deriveSlug(label, sessionKey string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(label)) {
		// 按 rune 判断（不能截成 byte：CJK 码点低字节可能恰好落在 a-z，如「器」U+5668）
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
		} else if b.Len() > 0 && !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
		if b.Len() >= 32 {
			break
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "wt"
	}
	if id := alnumTail(sessionKey, 8); id != "" {
		return base + "-" + id
	}
	return base
}

// alnumTail 取 s 小写后末 n 个字母数字字符（会话 id 的随机尾段）。
func alnumTail(s string, n int) string {
	var kept []rune
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			kept = append(kept, r)
		}
	}
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	return string(kept)
}

// worktreePathOf 校验 name 并返回 worktree 绝对路径；name 白名单 + 相对路径双保险防穿越。
func worktreePathOf(root, name string) (string, error) {
	if !filepath.IsAbs(strings.TrimSpace(root)) {
		// 相对 root 会让 os.*（按进程 cwd）与 git（按 Dir）解析到不同位置
		return "", fmt.Errorf("worktree 根目录必须是绝对路径：%s", root)
	}
	name = strings.ToLower(strings.TrimSpace(name))
	if !worktreeSlugRe.MatchString(name) {
		return "", fmt.Errorf("非法 worktree 名称：%s", name)
	}
	path := filepath.Join(root, filepath.FromSlash(worktreeDirName), name)
	rel, err := filepath.Rel(root, path)
	if err != nil || filepath.ToSlash(rel) != worktreeDirName+"/"+name {
		return "", fmt.Errorf("worktree 路径越界：%s", name)
	}
	return path, nil
}

// worktreeRepoReady 确认 root 在 git 仓库内（worktree 能力前提）。
func worktreeRepoReady(root string) bool {
	out, code, err := gitRun(root, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	return err == nil && code == 0 && strings.TrimSpace(out) == "true"
}

// WorktreeList 解析 git worktree list --porcelain：主根、bare、detached 一并列出，
// 由 UnderCadt 区分 AI 隔离区。孤儿判定（不在任何会话登记里）由前端算，引擎保持纯净。
func WorktreeList(dir string) (*GitWorktreeListResult, error) {
	result := &GitWorktreeListResult{Items: []GitWorktreeInfo{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		result.Reason = "没有打开的目录"
		return result, nil
	}
	if !worktreeRepoReady(dir) {
		result.Reason = "不在 git 仓库内"
		return result, nil
	}
	result.Available = true
	result.Root = dir
	raw, code, err := gitRun(dir, []string{"worktree", "list", "--porcelain"}, 10000)
	if err != nil || code != 0 {
		if err == nil {
			result.Reason = "git worktree list 失败"
		} else {
			result.Reason = gitProbeReason(dir, err)
		}
		result.Available = false
		return result, nil
	}
	result.Items = parseWorktreePorcelain(raw, dir)
	return result, nil
}

// parseWorktreePorcelain 按 NUL 分段：worktree <path> / HEAD <sha> / branch <ref> / bare / detached。
func parseWorktreePorcelain(raw, root string) []GitWorktreeInfo {
	items := []GitWorktreeInfo{}
	for _, block := range strings.Split(raw, "\n\n") {
		var info GitWorktreeInfo
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimRight(line, "\r")
			switch {
			case strings.HasPrefix(line, "worktree "):
				info.Path = strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
			case strings.HasPrefix(line, "HEAD "):
				info.Head = strings.TrimSpace(strings.TrimPrefix(line, "HEAD "))
			case strings.HasPrefix(line, "branch "):
				info.Branch = strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(line, "branch ")), "refs/heads/")
			case strings.TrimSpace(line) == "bare":
				info.Bare = true
			case strings.TrimSpace(line) == "detached":
				info.Detached = true
			}
		}
		if info.Path == "" {
			continue
		}
		info.Path = filepath.Clean(info.Path)
		if rel, err := filepath.Rel(root, info.Path); err == nil {
			info.RelPath = filepath.ToSlash(rel)
		} else {
			info.RelPath = filepath.ToSlash(info.Path)
		}
		info.UnderCadt = info.RelPath == worktreeDirName || strings.HasPrefix(info.RelPath, worktreeDirName+"/")
		items = append(items, info)
	}
	return items
}

// WorktreeAdd 创建隔离 worktree：git worktree add -b cadt/wt/<slug> <主根>/.cadt/worktree/<slug>。
// 候选 slug 依次试 base / base-2 / base-3（路径或分支任一已存在即换下一个），全部冲突报错。
// carry=true 时把主根当前未提交改动带入（binary patch + 未跟踪拷贝，对齐 ZCode fork），
// 并打机器快照 commit 推进 baseSha——export 的 diff 只含 AI 的草稿改动，不回灌用户原有改动。
func WorktreeAdd(root, label, sessionKey string, carry bool) (*GitWorktreeAddResult, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("缺少目录")
	}
	if !filepath.IsAbs(root) {
		// 相对 root 会让 os.* 按进程 cwd 解析、git 按 Dir 解析，可能不是同一路径
		return nil, fmt.Errorf("worktree 根目录必须是绝对路径：%s", root)
	}
	if !worktreeRepoReady(root) {
		return nil, fmt.Errorf("不在 git 仓库内，无法创建隔离工作区")
	}
	base := deriveSlug(label, sessionKey)
	candidates := []string{base, base + "-2", base + "-3"}
	for _, slug := range candidates {
		if !worktreeSlugRe.MatchString(slug) {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(worktreeDirName), slug)
		if _, err := os.Stat(path); err == nil {
			continue // 目录已存在
		}
		branch := worktreeBranchP + slug
		if gitBranchRefExists(root, "refs/heads/"+branch) {
			continue // 分支残留（worktree 已删但分支没删干净）
		}
		if _, code, err := gitRun(root, []string{"worktree", "add", "-b", branch, "--", path}, 120000); err != nil {
			return nil, err
		} else if code != 0 {
			return nil, fmt.Errorf("创建 worktree 失败（%s）", slug)
		}
		shaOut, shaCode, shaErr := gitRun(path, []string{"rev-parse", "HEAD"}, 5000)
		if shaErr != nil || shaCode != 0 {
			// 半成品要回滚，否则该 slug 的目录与分支永久占位，后续只能拿 -2/-3
			_, _, _ = gitRun(root, []string{"worktree", "remove", "--force", "--", path}, 30000)
			_, _, _ = gitRun(root, []string{"branch", "-D", branch}, 15000)
			return nil, fmt.Errorf("worktree 已创建但取基准 HEAD 失败（已回滚）：%s", path)
		}
		// 依赖目录 junction 共享（白名单内存在才建；失败不致命，记进结果告知 AI）
		deps, depErrors := linkDepDirs(root, path)
		// .worktreeinclude：仓库声明的「被忽略文件」拷贝清单（.env 这类 dotfiles——
		// junction 只能共享目录，覆盖不了它们；对齐 ZCode §3.4）。失败不致命，errors 告知 AI。
		includeCopied, includeErrors := copyWorktreeInclude(root, path)
		carried := 0
		baseSha := strings.TrimSpace(shaOut)
		if carry {
			n, newSha, carryErr := carryWorkingChanges(root, path, baseSha)
			if carryErr != nil {
				// 带入失败整个创建失败（对齐 ZCode carry-failed）：回滚目录与分支，可重试。
				_, _, _ = gitRun(root, []string{"worktree", "remove", "--force", "--", path}, 30000)
				_, _, _ = gitRun(root, []string{"branch", "-D", branch}, 15000)
				return nil, fmt.Errorf("带入主根未提交改动失败（已回滚）：%w", carryErr)
			}
			carried = n
			baseSha = newSha
		}
		return &GitWorktreeAddResult{
			Name:          slug,
			Branch:        branch,
			Path:          path,
			BaseSha:       baseSha,
			Deps:          deps,
			DepErrors:     depErrors,
			IncludeCopied: includeCopied,
			IncludeErrors: includeErrors,
			Carried:       carried,
		}, nil
	}
	return nil, fmt.Errorf("worktree 名称冲突过多（%s…），请换一个用途名", base)
}

// WorktreeRemove 删除隔离 worktree（--force：草稿区本来就该允许未提交改动）；
// deleteBranch=true 时一并删隔离分支（默认语义：分支永不合并、不保留）。
// 先递归摘掉所有 reparse 点（含 AI 手动建在子目录里的 junction；只删链接，目标绝不受影响），
// 再交 git 删目录——Windows 上 git 的递归删除会跟进 junction 清空主根依赖（2026-11-17 实测）。
func WorktreeRemove(root, name string, deleteBranch bool) error {
	root = strings.TrimSpace(root)
	path, err := worktreePathOf(root, name)
	if err != nil {
		return err
	}
	// 目录已不在（外部删过 / 重复 discard）：清 git 管理记录 + 删分支，按幂等成功处理。
	// 旧实现直接交 git，第二次 discard 报「not a working tree」且分支永远残留。
	if _, statErr := os.Lstat(path); statErr != nil {
		if !errors.Is(statErr, fs.ErrNotExist) {
			return statErr
		}
		_ = WorktreePrune(root)
		return removeWorktreeBranch(root, name, deleteBranch)
	}
	if left := unlinkReparsePoints(path); len(left) > 0 {
		// fail-closed：还有链接没摘掉就交 git，会跟进删除目标目录内容（= 主根依赖）
		return fmt.Errorf("worktree 内仍有无法摘除的链接（%d 个，如 %s），已中止删除以免误删链接目标", len(left), left[0])
	}
	_, code, removeErr := gitRun(root, []string{"worktree", "remove", "--force", "--", path}, 30000)
	if removeErr != nil {
		return removeErr
	}
	if code != 0 {
		// 重复 discard / 记录已被移走时 git 会报 not a working tree：列表里确实没有它，
		// 就按「已删除」继续清分支；仍在列表里才是真失败。
		if list, lerr := WorktreeList(root); lerr == nil && list.Available {
			present := false
			for _, item := range list.Items {
				if strings.EqualFold(filepath.Clean(item.Path), filepath.Clean(path)) {
					present = true
					break
				}
			}
			if !present {
				_ = WorktreePrune(root)
				return removeWorktreeBranch(root, name, deleteBranch)
			}
		}
		return fmt.Errorf("删除 worktree 失败：%s", name)
	}
	return removeWorktreeBranch(root, name, deleteBranch)
}

// removeWorktreeBranch 删除隔离分支（deleteBranch=false 时跳过）；分支不存在视为成功。
func removeWorktreeBranch(root, name string, deleteBranch bool) error {
	if !deleteBranch {
		return nil
	}
	branch := worktreeBranchP + strings.ToLower(strings.TrimSpace(name))
	if !gitBranchRefExists(root, "refs/heads/"+branch) {
		return nil
	}
	if _, code, err := gitRun(root, []string{"branch", "-D", branch}, 15000); err != nil {
		return err
	} else if code != 0 {
		return fmt.Errorf("worktree 已删除但分支删除失败：%s", branch)
	}
	return nil
}

// WorktreePrune 清理 git 侧失效的 worktree 管理记录（目录被手动删除等）；不动现存目录。
func WorktreePrune(root string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		return fmt.Errorf("缺少目录")
	}
	if _, code, err := gitRun(root, []string{"worktree", "prune"}, 15000); err != nil {
		return err
	} else if code != 0 {
		return fmt.Errorf("worktree prune 失败")
	}
	return nil
}

// WorktreeDiff 导出 worktree 相对创建基准的全部草稿改动（unified patch 文本）：
// 先 git add -N .（intent-to-add，让未跟踪新文件进 diff，不暂存内容），再
// git diff --no-renames <baseSha>（rename 拆成 delete+add，回避补丁解析器的 rename 盲区）。
// 删除文件也在 diff 里；忽略文件（构建产物等）不会出现。baseSha 由调用方传会话里记录的
// 创建基准（40 位或缩写十六进制）。
func WorktreeDiff(root, name, baseSha string) (string, error) {
	root = strings.TrimSpace(root)
	baseSha = strings.TrimSpace(baseSha)
	if !shaRe.MatchString(baseSha) {
		return "", fmt.Errorf("缺少有效的基准 commit（baseSha）")
	}
	path, err := worktreePathOf(root, name)
	if err != nil {
		return "", err
	}
	if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
		return "", fmt.Errorf("worktree 目录不存在：%s", path)
	}
	// junction 目标若没被 .gitignore 覆盖，git add -N 会把主根依赖内容当新文件索引进
	// 补丁（复查实测）；按 reparse 点加 exclude pathspec，导出只含草稿区真实改动。
	if _, code, err := gitRun(path, stageIntentToAddArgs(path), 30000); err != nil {
		return "", err
	} else if code != 0 {
		return "", fmt.Errorf("git add -N 失败（worktree：%s）", name)
	}
	out, code, err := gitRun(path, []string{"diff", "--no-renames", baseSha}, 60000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("git diff 失败（worktree：%s）", name)
	}
	diff := trimDiffTail(out)
	if strings.TrimSpace(diff) == "" {
		return "", ErrWorktreeNoChanges
	}
	return diff, nil
}
