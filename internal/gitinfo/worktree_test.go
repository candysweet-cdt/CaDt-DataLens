package gitinfo

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"datalens/internal/patch"
)

// ===== 测试仓库夹具 =====
// 临时仓库：main 分支提交 a.txt + .gitignore(.cadt/)，与真实工作区形态对齐。
func worktreeTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(".cadt/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", ".gitignore", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")
	return dir
}

// ===== slug 派生测试 =====
func TestDeriveSlug(t *testing.T) {
	cases := []struct {
		label  string
		key    string
		expect string
	}{
		{"refactor parser", "session-abcdef1234", "refactor-parser-cdef1234"}, // id 取末 8 位字母数字
		{"重构 解析器!", "abcdef1234", "wt-cdef1234"},                              // 中文全折成 -，Trim 后只剩 wt
		{"  ", "", "wt"},                             // 空 label 且无会话 id
		{"A__B--c", "", "a-b-c"},                     // 连续非法字符折成单个 -
		{"x", "session-ABCDEF1234xyz", "x-f1234xyz"}, // 大小写归一
	}
	for _, c := range cases {
		if got := deriveSlug(c.label, c.key); got != c.expect {
			t.Fatalf("deriveSlug(%q,%q) = %q, want %q", c.label, c.key, got, c.expect)
		}
	}
	long := deriveSlug(strings.Repeat("ab", 40), "session-abcdef1234")
	if len(long) > 32+len("-")+8 || !worktreeSlugRe.MatchString(long) {
		t.Fatalf("长 label 派生的 slug 不合白名单：%q", long)
	}
}

// ===== 生命周期与差异测试 =====
func TestWorktreeLifecycleAndDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)

	// add：slug 派生 + 目录 + 分支
	added, err := WorktreeAdd(dir, "Refactor Parser", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if added.Name != "refactor-parser-cdef1234" {
		t.Fatalf("slug = %q", added.Name)
	}
	if !worktreeSlugRe.MatchString(added.Name) || added.Branch != "cadt/wt/"+added.Name {
		t.Fatalf("add result = %#v", added)
	}
	if info, err := os.Stat(added.Path); err != nil || !info.IsDir() {
		t.Fatalf("worktree 目录不存在：%s", added.Path)
	}
	if len(added.BaseSha) != 40 {
		t.Fatalf("baseSha = %q", added.BaseSha)
	}
	// worktree 内不含 .cadt（被忽略）——不递归嵌套的前提
	if _, err := os.Stat(filepath.Join(added.Path, ".cadt")); !os.IsNotExist(err) {
		t.Fatal("worktree 检出不应包含 .cadt/")
	}

	// list：UnderCadt 标记与分支解析
	list, err := WorktreeList(dir)
	if err != nil || !list.Available {
		t.Fatalf("list = %#v err=%v", list, err)
	}
	var wt *GitWorktreeInfo
	for i := range list.Items {
		if list.Items[i].UnderCadt {
			wt = &list.Items[i]
		}
	}
	if wt == nil || wt.Branch != "cadt/wt/"+added.Name || wt.RelPath != ".cadt/worktree/"+added.Name {
		t.Fatalf("list items = %#v", list.Items)
	}

	// 隔离性：主根与 worktree 各改一个文件互不影响
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("main edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "new.txt"), []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(added.Path, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "sub", "deep.txt"), []byte("deep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// worktree 内删除 a.txt（基准里有）→ diff 应含删除段
	if err := os.Remove(filepath.Join(added.Path, "a.txt")); err != nil {
		t.Fatal(err)
	}

	// 空 diff：新创建、没改动的 worktree 导出报哨兵错误
	fresh, err := WorktreeAdd(dir, "fresh", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WorktreeDiff(dir, fresh.Name, fresh.BaseSha); !errors.Is(err, ErrWorktreeNoChanges) {
		t.Fatalf("空 worktree 应报 ErrWorktreeNoChanges，got %v", err)
	}
	if err := WorktreeRemove(dir, fresh.Name, true); err != nil {
		t.Fatal(err)
	}

	// diff：修改 + 删除 + 新文件（含未跟踪）都在，主根改动不在
	diff, err := WorktreeDiff(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"+++ b/new.txt", "+hello", "+++ b/sub/deep.txt", "+++ /dev/null", "--- a/a.txt"} {
		if !strings.Contains(diff, want) {
			t.Fatalf("diff 缺少 %q：\n%s", want, diff)
		}
	}
	if strings.Contains(diff, "main edit") {
		t.Fatal("主根的改动不应出现在 worktree diff 里")
	}
	// rename 检测已禁用：不应出现 rename 头
	if strings.Contains(diff, "rename from") {
		t.Fatal("diff 不应含 rename 段（--no-renames）")
	}

	// 导出的 diff 必须能被 internal/patch 解析（回灌管线的前提）
	if _, err := patch.ParsePatchText(diff); err != nil {
		t.Fatalf("patch 引擎无法解析 worktree diff：%v\n%s", err, diff)
	}

	// baseSha 校验
	if _, err := WorktreeDiff(dir, added.Name, "not-a-sha"); err == nil {
		t.Fatal("非法 baseSha 应报错")
	}
	if _, err := WorktreeDiff(dir, "../escape", added.BaseSha); err == nil {
		t.Fatal("路径穿越名应报错")
	}

	// remove（含删分支）→ list 与 show-ref 双确认
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".cadt", "worktree", added.Name)); !os.IsNotExist(err) {
		t.Fatal("worktree 目录应已删除")
	}
	list, err = WorktreeList(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.UnderCadt {
			t.Fatalf("list 仍含隔离 worktree：%#v", item)
		}
	}
	if gitBranchRefExists(dir, "refs/heads/cadt/wt/"+added.Name) {
		t.Fatal("隔离分支应已删除")
	}
}

func TestWorktreeAddConflictSuffix(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	first, err := WorktreeAdd(dir, "demo", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	// 同 label + 同会话 id 再建：slug 冲突自动换 -2 后缀
	second, err := WorktreeAdd(dir, "demo", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if second.Name != first.Name+"-2" {
		t.Fatalf("conflict slug = %q, want %q", second.Name, first.Name+"-2")
	}
	if err := WorktreeRemove(dir, first.Name, true); err != nil {
		t.Fatal(err)
	}
	if err := WorktreeRemove(dir, second.Name, true); err != nil {
		t.Fatal(err)
	}
}

// ===== 依赖目录与 include 测试 =====
// 依赖目录 junction：主根的 node_modules / .venv / venv 自动共享进 worktree；共享是
// 双向的（worktree 里装依赖写的就是主根目录）；删除 worktree 绝不伤主根依赖。
func TestWorktreeJunctionDeps(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	if !junctionSupported {
		t.Skip("当前平台不支持 junction")
	}
	dir := worktreeTestRepo(t)
	if err := os.MkdirAll(filepath.Join(dir, "node_modules", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "pkg", "index.js"), []byte("shared\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".venv"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 不在白名单里的目录不共享（vendor 通常被 git 跟踪）
	if err := os.MkdirAll(filepath.Join(dir, "vendor"), 0o755); err != nil {
		t.Fatal(err)
	}

	added, err := WorktreeAdd(dir, "deps", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(added.Deps) != 2 {
		t.Fatalf("deps = %#v, want [node_modules .venv]", added.Deps)
	}
	wtNM := filepath.Join(added.Path, "node_modules")
	if !isReparsePoint(wtNM) {
		t.Fatal("worktree node_modules 应是 junction")
	}
	// 经 junction 可读主根内容
	raw, err := os.ReadFile(filepath.Join(wtNM, "pkg", "index.js"))
	if err != nil || string(raw) != "shared\n" {
		t.Fatalf("junction 读取失败：%v %q", err, raw)
	}
	// 双向：在 worktree 侧写文件，主根可见（依赖状态共享）
	if err := os.WriteFile(filepath.Join(wtNM, "pkg", "new.js"), []byte("via-wt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "pkg", "new.js")); err != nil {
		t.Fatal("经 junction 的写入应落到主根依赖目录")
	}
	// 白名单外不共享
	if _, err := os.Lstat(filepath.Join(added.Path, "vendor")); !os.IsNotExist(err) {
		t.Fatal("vendor 不应被共享")
	}

	// stat：对 junction 内容的修改计入 worktree diff（经共享写主根，同时出现在 worktree 视角）
	if err := os.WriteFile(filepath.Join(added.Path, "a.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stat, err := WorktreeStat(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stat, "a.txt") {
		t.Fatalf("stat 应含 a.txt：\n%s", stat)
	}
	// 导出：junction 目标（node_modules 未被 .gitignore 覆盖）不得被 git add -N 索引进补丁
	diff, err := WorktreeDiff(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(diff, "node_modules/") {
		t.Fatalf("导出不应包含 junction 目标内容：\n%s", diff)
	}
	if !strings.Contains(diff, "a.txt") {
		t.Fatalf("导出应包含草稿改动 a.txt：\n%s", diff)
	}

	// 删除：主根依赖完好无损（junction 只摘 reparse 点）
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "pkg", "index.js")); err != nil {
		t.Fatal("删除 worktree 不得影响主根依赖目录")
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "pkg", "new.js")); err != nil {
		t.Fatal("主根依赖内容不得被连带删除")
	}
	if isReparsePoint(filepath.Join(dir, "node_modules")) {
		t.Fatal("主根 node_modules 不应是 reparse 点")
	}
}

// 嵌套 junction 保护：AI 可能在隔离区子目录里手动 mklink /J 借主根依赖（如
// frontend/node_modules）。删除 worktree 前必须递归摘掉这些 reparse 点——否则 git 的
// 递归删除会跟进 junction，把主根依赖目录清空（2026-11-17 真机事故）。
// .worktreeinclude：仓库声明的「被忽略文件」清单在创建时从主根拷进隔离区
// （.env 这类 dotfiles——junction 只能共享目录、覆盖不了它们，对齐 ZCode §3.4）；
// 被忽略但未列入清单的文件不拷。
func TestWorktreeIncludeCopy(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	if !junctionSupported {
		t.Skip("当前平台不支持 junction")
	}
	dir := worktreeTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(".cadt/\n.env\nother.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.env"), []byte("OTHER=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".worktreeinclude"), []byte("# 只有 .env\n.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	added, err := WorktreeAdd(dir, "include", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if added.IncludeCopied != 1 {
		t.Fatalf("includeCopied = %d, want 1", added.IncludeCopied)
	}
	if raw, err := os.ReadFile(filepath.Join(added.Path, ".env")); err != nil || string(raw) != "SECRET=1\n" {
		t.Fatalf(".env 应被拷进隔离区：%v %q", err, raw)
	}
	if _, err := os.Stat(filepath.Join(added.Path, "other.env")); !os.IsNotExist(err) {
		t.Fatal("未列入清单的被忽略文件不应拷贝")
	}
}

// ===== 携带改动测试 =====
// carry=true：主根当前未提交改动（暂存 + 未暂存 + 未跟踪）带入隔离区，并打快照 commit
// 推进 baseSha——相对新基准的 diff 为空，export 只含 AI 的后续改动（对齐 ZCode fork §3.6）。
func TestWorktreeCarryChanges(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	// 主根：a.txt 先暂存再追加（同文件暂存+未暂存）、b.txt 未暂存新建、c.txt 未跟踪
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("staged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "a.txt")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("staged+work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("unstaged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "c.txt"), []byte("untracked\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	added, err := WorktreeAdd(dir, "carry", "session-abcdef1234", true)
	if err != nil {
		t.Fatal(err)
	}
	if added.Carried != 3 {
		t.Fatalf("carried = %d, want 3（a/b/c 三个文件）", added.Carried)
	}
	if added.BaseSha == "" {
		t.Fatal("carry 后应有快照基准")
	}
	assertFile := func(name, want string) {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(added.Path, name))
		// core.autocrlf=true 的机器上 git apply 会按 checkout 规则写出 CRLF：只比内容不比换行
		normalized := strings.ReplaceAll(string(raw), "\r\n", "\n")
		if err != nil || normalized != want {
			t.Fatalf("隔离区 %s = %q, want %q（err=%v）", name, raw, want, err)
		}
	}
	assertFile("a.txt", "staged+work\n")
	assertFile("b.txt", "unstaged\n")
	assertFile("c.txt", "untracked\n")
	// 快照已提交：工作区干净，相对快照基准无改动 → export 报「没有改动」
	if out := gitTestCmd(t, added.Path, "status", "--porcelain"); strings.TrimSpace(out) != "" {
		t.Fatalf("快照 commit 后工作区应干净：%q", out)
	}
	if _, err := WorktreeDiff(dir, added.Name, added.BaseSha); !errors.Is(err, ErrWorktreeNoChanges) {
		t.Fatalf("carry 后 export 应无改动：%v", err)
	}
	// 主根的未提交状态不被 carry 破坏（只读读取）
	if raw, err := os.ReadFile(filepath.Join(dir, "a.txt")); err != nil || string(raw) != "staged+work\n" {
		t.Fatalf("主根文件不应被 carry 修改：%v %q", err, raw)
	}
}

// ===== 环境隔离测试 =====
// gitRun 环境隔离：GUI 进程继承的 GIT_DIR / GIT_WORK_TREE 不能把命令重定向到别的仓库。
func TestGitRunEnvIsolation(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	t.Setenv("GIT_DIR", "D:/definitely-not-a-repo/.git")
	t.Setenv("GIT_WORK_TREE", "D:/definitely-not-a-repo")
	list, err := WorktreeList(dir)
	if err != nil || !list.Available {
		t.Fatalf("GIT_DIR/GIT_WORK_TREE 环境变量应被 gitRun 剔除：%#v err=%v", list, err)
	}
}

// ===== 移除与清理测试 =====
func TestWorktreeRemoveNestedJunction(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	if !junctionSupported {
		t.Skip("当前平台不支持 junction")
	}
	dir := worktreeTestRepo(t)
	// 主根子目录依赖（本项目真实形态：frontend/node_modules），根层不放依赖，
	// 这样只有 AI 手动建的嵌套 junction，能验证递归摘除而不是白名单路径。
	mainNM := filepath.Join(dir, "frontend", "node_modules", "pkg")
	if err := os.MkdirAll(mainNM, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mainNM, "index.js"), []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	added, err := WorktreeAdd(dir, "nested", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	wtFrontend := filepath.Join(added.Path, "frontend")
	if err := os.MkdirAll(wtFrontend, 0o755); err != nil {
		t.Fatal(err)
	}
	// 模拟 AI 手动借主根依赖
	if err := createJunction(filepath.Join(wtFrontend, "node_modules"), filepath.Join(dir, "frontend", "node_modules")); err != nil {
		t.Fatalf("建嵌套 junction 失败：%v", err)
	}
	if !isReparsePoint(filepath.Join(wtFrontend, "node_modules")) {
		t.Fatal("嵌套 junction 应被识别为 reparse 点")
	}
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatal(err)
	}
	// 主根依赖内容必须完好（junction 只摘链接，不跟进删除）
	if raw, err := os.ReadFile(filepath.Join(mainNM, "index.js")); err != nil || string(raw) != "keep\n" {
		t.Fatalf("主根嵌套依赖被删除或损坏：%v %q", err, raw)
	}
	if isReparsePoint(filepath.Join(dir, "frontend", "node_modules")) {
		t.Fatal("主根依赖目录不应变成/残留 reparse 点")
	}
}

// 重复 discard 幂等：目录已不存在时也要清 git 记录与隔离分支（旧实现第二次报错、
// 分支永久残留，之后同名 create 只能拿 -2/-3）。
func TestWorktreeRemoveIdempotent(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	added, err := WorktreeAdd(dir, "idem", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatal(err)
	}
	if gitBranchRefExists(dir, "refs/heads/"+added.Branch) {
		t.Fatal("首次 discard 后隔离分支不应残留")
	}
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatalf("重复 discard 应幂等成功：%v", err)
	}
}

// 根节点本身被替换成 junction：必须 fail-closed 拒绝删除，链接目标分毫不动。
// （复查实测：git 会跟进根链接删空目标。）
func TestWorktreeRemoveRejectsRootJunction(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	if !junctionSupported {
		t.Skip("当前平台不支持 junction")
	}
	dir := worktreeTestRepo(t)
	added, err := WorktreeAdd(dir, "rootlink", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	decoy := filepath.Join(t.TempDir(), "decoy")
	if err := os.MkdirAll(decoy, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(decoy, "keep.txt"), []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(added.Path); err != nil {
		t.Fatal(err)
	}
	if err := createJunction(added.Path, decoy); err != nil {
		t.Fatalf("把 worktree 根替换成 junction 失败：%v", err)
	}
	removeErr := WorktreeRemove(dir, added.Name, false)
	if removeErr == nil {
		t.Fatal("根目录是链接时必须拒绝删除")
	}
	if !strings.Contains(removeErr.Error(), "无法摘除的链接") {
		t.Fatalf("错误文案应说明残留链接：%v", removeErr)
	}
	if raw, rerr := os.ReadFile(filepath.Join(decoy, "keep.txt")); rerr != nil || string(raw) != "keep\n" {
		t.Fatalf("链接目标不应被删除或损坏：%v %q", rerr, raw)
	}
}

// ===== 边界字符与列表测试 =====
// createJunction 不许经 cmd.exe：路径里的 & % ( ) 等元字符会被命令行解释
// （复查实测 `x&echo` 会假成功并把后半段当第二条命令执行）。
func TestCreateJunctionMetachars(t *testing.T) {
	if !junctionSupported {
		t.Skip("当前平台不支持 junction")
	}
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "x&echo (link) %TEMP%")
	if err := createJunction(link, target); err != nil {
		t.Fatalf("含元字符路径建 junction 失败：%v", err)
	}
	raw, err := os.ReadFile(filepath.Join(link, "keep.txt"))
	if err != nil || string(raw) != "keep\n" {
		t.Fatalf("经 junction 读取失败：%v %q", err, raw)
	}
	if !isReparsePoint(link) {
		t.Fatal("新建的 junction 未被识别为链接")
	}
}

func TestWorktreePrune(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	added, err := WorktreeAdd(dir, "orphan", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	// 手动删目录（模拟用户直接删盘）：git 侧记录残留
	if err := os.RemoveAll(added.Path); err != nil {
		t.Fatal(err)
	}
	list, err := WorktreeList(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range list.Items {
		if item.UnderCadt {
			found = true
		}
	}
	if !found {
		t.Fatal("prune 前 git 侧应仍登记该 worktree")
	}
	if err := WorktreePrune(dir); err != nil {
		t.Fatal(err)
	}
	list, err = WorktreeList(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.UnderCadt {
			t.Fatalf("prune 后仍登记失效 worktree：%#v", item)
		}
	}
	// 目录已不存在时 discard 幂等：不再报 not a working tree，并清掉隔离分支
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatalf("目录已被手动删除时 remove 应幂等成功：%v", err)
	}
	if gitBranchRefExists(dir, "refs/heads/"+added.Branch) {
		t.Fatal("幂等 discard 后隔离分支不应残留")
	}
	if err := WorktreePrune(dir); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeListNotInRepo(t *testing.T) {
	dir := t.TempDir()
	list, err := WorktreeList(dir)
	if err != nil || list.Available || list.Reason == "" {
		t.Fatalf("非仓库目录应优雅降级：%#v err=%v", list, err)
	}
	if _, err := WorktreeAdd(dir, "x", "session-abcdef1234", false); err == nil {
		t.Fatal("非仓库目录 add 应报错")
	}
}
