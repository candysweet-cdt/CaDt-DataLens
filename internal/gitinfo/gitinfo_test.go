package gitinfo

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func gitTestCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v 失败：%v\n%s", args, err, out)
	}
	return string(out)
}

func TestGitBranchFlow(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过分支集成测试")
	}
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")
	gitTestCmd(t, dir, "branch", "feature/one")

	res, err := BranchesFor(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Available || res.Current != "main" {
		t.Fatalf("unexpected repo state: %#v", res)
	}
	names := make([]string, 0, len(res.Local))
	for _, branch := range res.Local {
		names = append(names, branch.Name)
	}
	if strings.Join(names, ",") != "feature/one,main" {
		t.Fatalf("local branches = %v", names)
	}

	op, err := CheckoutBranch(dir, "feature/one", false)
	if err != nil || !op.Success {
		t.Fatalf("checkout local failed: %#v %v", op, err)
	}
	res, _ = BranchesFor(dir, true)
	if res.Current != "feature/one" {
		t.Fatalf("current branch = %q, want feature/one", res.Current)
	}

	op, err = CreateBranch(dir, "feature/two")
	if err != nil || !op.Success {
		t.Fatalf("create branch failed: %#v %v", op, err)
	}
	if res, _ = BranchesFor(dir, true); res.Current != "feature/two" {
		t.Fatalf("current branch after create = %q", res.Current)
	}
	op, err = CreateBranch(dir, "bad name")
	if err != nil {
		t.Fatalf("invalid branch name returned error: %v", err)
	}
	if op.Success {
		t.Fatal("invalid branch name should fail")
	}

	gitTestCmd(t, dir, "tag", "v1")
	op, err = CheckoutRef(dir, "v1")
	if err != nil || !op.Success {
		t.Fatalf("checkout tag failed: %#v %v", op, err)
	}
	if res, _ = BranchesFor(dir, true); res.Current != "HEAD" {
		t.Fatalf("detached HEAD current = %q", res.Current)
	}
}

func TestGitRemoteBranchCheckout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过远程分支集成测试")
	}
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	gitTestCmd(t, root, "init", "--bare", remote)
	dir := filepath.Join(root, "work")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")
	gitTestCmd(t, dir, "remote", "add", "origin", filepath.ToSlash(remote))
	gitTestCmd(t, dir, "push", "-u", "origin", "main")
	gitTestCmd(t, dir, "branch", "remote-only")
	gitTestCmd(t, dir, "push", "origin", "remote-only")
	gitTestCmd(t, dir, "branch", "-D", "remote-only")

	res, err := BranchesFor(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, branch := range res.Remote {
		if branch.Name == "origin" || strings.HasSuffix(branch.Name, "/HEAD") {
			t.Fatalf("remote HEAD/symbolic ref leaked into branch list: %#v", res.Remote)
		}
		if branch.Name == "origin/remote-only" {
			found = true
		}
	}
	if !found {
		t.Fatalf("remote branches = %#v", res.Remote)
	}
	localOnly, err := BranchesFor(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(localOnly.Remote) != 0 {
		t.Fatalf("includeRemote=false should skip remote refs: %#v", localOnly.Remote)
	}
	if !localOnly.Available || len(localOnly.Local) == 0 {
		t.Fatalf("local-only result incomplete: %#v", localOnly)
	}
	op, err := CheckoutBranch(dir, "origin/remote-only", true)
	if err != nil || !op.Success {
		t.Fatalf("checkout remote branch failed: %#v %v", op, err)
	}
	res, _ = BranchesFor(dir, true)
	if res.Current != "remote-only" {
		t.Fatalf("current branch = %q, want remote-only", res.Current)
	}
	for _, branch := range res.Local {
		if branch.Name == "remote-only" && branch.Upstream != "origin/remote-only" {
			t.Fatalf("upstream = %q", branch.Upstream)
		}
	}
}

func TestParseUpstreamTrack(t *testing.T) {
	cases := []struct {
		track  string
		ahead  int
		behind int
		gone   bool
	}{
		{"", 0, 0, false},
		{"[ahead 2]", 2, 0, false},
		{"[behind 3]", 0, 3, false},
		{"[ahead 1, behind 2]", 1, 2, false},
		{"[gone]", 0, 0, true},
	}
	for _, c := range cases {
		ahead, behind, gone := parseUpstreamTrack(c.track)
		if ahead != c.ahead || behind != c.behind || gone != c.gone {
			t.Fatalf("parseUpstreamTrack(%q) = (%d,%d,%v), want (%d,%d,%v)", c.track, ahead, behind, gone, c.ahead, c.behind, c.gone)
		}
	}
}

func TestParseBranchRefLines(t *testing.T) {
	localRaw := "main\torigin/main\t[ahead 2, behind 1]\t*\n" +
		"feature/ui\t\t\t\n"
	remoteRaw := "refs/remotes/origin/main\t\n" +
		"refs/remotes/origin/HEAD\trefs/remotes/origin/main\n"
	local := parseBranchRefLines(localRaw)
	if len(local) != 2 {
		t.Fatalf("local count = %d, want 2: %#v", len(local), local)
	}
	if !local[0].Current || local[0].Name != "main" || local[0].Upstream != "origin/main" || local[0].Ahead != 2 || local[0].Behind != 1 {
		t.Fatalf("unexpected main branch: %#v", local[0])
	}
	if local[1].Current || local[1].Name != "feature/ui" {
		t.Fatalf("unexpected feature branch: %#v", local[1])
	}
	remote := parseRemoteRefLines(remoteRaw)
	if len(remote) != 1 || remote[0].Name != "origin/main" {
		t.Fatalf("remote branches = %#v, want only origin/main", remote)
	}
	if remote[0].Upstream != "" {
		t.Fatalf("remote branch should not carry upstream: %#v", remote[0])
	}
}

func TestRecentBranchesFromReflog(t *testing.T) {
	raw := "checkout: moving from main to feature/a\n" +
		"checkout: moving from feature/a to 1a2b3c4\n" +
		"checkout: moving from 1a2b3c4 to feature/b\n" +
		"checkout: moving from feature/b to feature/a\n" +
		"checkout: moving from feature/a to main\n"
	local := map[string]bool{"main": true, "feature/a": true, "feature/b": true}
	got := recentBranchesFromReflog(raw, local, "main", 5)
	want := []string{"feature/a", "feature/b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("recent = %#v, want %#v", got, want)
	}
	limited := recentBranchesFromReflog(raw, local, "main", 1)
	if !reflect.DeepEqual(limited, []string{"feature/a"}) {
		t.Fatalf("limited recent = %#v", limited)
	}
}

func TestGitDiffForUntrackedFile(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过差异集成测试")
	}
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")

	res, err := DiffFor(dir, "a.txt")
	if err != nil || res.HasChanges {
		t.Fatalf("已跟踪且无改动不应有差异：res=%#v err=%v", res, err)
	}

	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err = DiffFor(dir, "new.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !res.HasChanges {
		t.Fatal("未跟踪文件应按全部新增生成差异")
	}
	for _, want := range []string{"new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world"} {
		if !strings.Contains(res.Diff, want) {
			t.Fatalf("diff 缺少 %q：\n%s", want, res.Diff)
		}
	}
}

func TestNewFileUnifiedDiffNoTrailingNewline(t *testing.T) {
	diff := newFileUnifiedDiff("docs/new.md", "line1\nline2")
	wantTail := "+line1\n+line2\n\\ No newline at end of file"
	if !strings.HasSuffix(diff, wantTail) {
		t.Fatalf("diff 尾部 = %q，want %q", diff, wantTail)
	}
	if empty := newFileUnifiedDiff("empty.txt", ""); strings.Contains(empty, "@@") {
		t.Fatalf("空文件不应有 hunk：%q", empty)
	}
}

// gitSubcommand：静默门按子命令判定，解析要能跳过前导全局选项。
func TestGitSubcommand(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"checkout", "main"}, "checkout"},
		{[]string{"-c", "core.quotepath=false", "status"}, "status"},
		{[]string{"-C", "sub", "reset", "--hard"}, "reset"},
		{[]string{"--git-dir=.git", "clean", "-fd"}, "clean"},
		{[]string{"--", "switch"}, "switch"},
		{[]string{}, ""},
		{[]string{"-c"}, ""},
	}
	for _, c := range cases {
		if got := gitSubcommand(c.args); got != c.want {
			t.Fatalf("gitSubcommand(%v) = %q, want %q", c.args, got, c.want)
		}
	}
	// 白名单：会批量改写工作树的子命令才算，只读命令不算
	for _, sub := range []string{"checkout", "switch", "restore", "reset", "clean", "pull", "stash"} {
		if !worktreeMutatingSubcommands[sub] {
			t.Fatalf("%s 应在会改写工作树的白名单里", sub)
		}
	}
	for _, sub := range []string{"status", "log", "diff", "show", "rev-parse", "for-each-ref", "fetch", "push"} {
		if worktreeMutatingSubcommands[sub] {
			t.Fatalf("%s 是只读/远端命令，不该进白名单", sub)
		}
	}
}

// trimDiffTail 只能去掉 git 输出末尾的那一个换行。若用 TrimRight(out, "\n")，
// hunk 末尾的空上下文行（diff.suppressBlankEmpty 下输出为纯空行）会连同换行一起
// 被吃光，差异视图随即报「hunk 行数与 @@ 头不一致」。见 2026-11-19 报告。
func TestTrimDiffTailKeepsTrailingBlankContextLine(t *testing.T) {
	// git 默认：末尾空上下文行是「空格 + 换行」
	withSpace := "@@ -1,2 +1,2 @@\n a\n \n"
	if got := trimDiffTail(withSpace); got != "@@ -1,2 +1,2 @@\n a\n " {
		t.Fatalf("带空格前缀的末尾空行被改动：%q", got)
	}
	// suppressBlankEmpty：末尾空上下文行是纯空行，只能去掉一个换行
	bare := "@@ -1,2 +1,2 @@\n a\n\n"
	if got := trimDiffTail(bare); got != "@@ -1,2 +1,2 @@\n a\n" {
		t.Fatalf("应只去掉一个换行：%q", got)
	}
}

// 脏工作树切分支：git 把冲突清单写到 stderr。gitRun 若只返回 stdout，
// parseCheckoutConflictFiles 恒空，前端三选一冲突对话框永远无法触发。
func TestCheckoutBranchDirtyWorktreeReportsConflicts(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过签出冲突集成测试")
	}
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	writeA := func(content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeA("base\n")
	gitTestCmd(t, dir, "add", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")
	// 另一分支也改同一个文件，签出时才会被本地未提交改动挡住
	gitTestCmd(t, dir, "checkout", "-b", "other")
	writeA("other\n")
	gitTestCmd(t, dir, "commit", "-am", "other")
	gitTestCmd(t, dir, "checkout", "main")
	writeA("dirty\n") // 不提交：工作树脏

	op, err := CheckoutBranch(dir, "other", false)
	if err != nil {
		t.Fatal(err)
	}
	if op.Success {
		t.Fatalf("脏工作树签出不应成功：%#v", op)
	}
	if len(op.ConflictFiles) != 1 || op.ConflictFiles[0] != "a.txt" {
		t.Fatalf("冲突文件应解析出 a.txt，实际 %v（原始输出：%q）", op.ConflictFiles, op.Output)
	}
}

// 回滚前必须把当前内容备份到 .cadt/rollback-backup：`git checkout HEAD --`
// 会整份丢弃工作区改动，多会话叠加的改动再也拿不回来。
func TestRollbackForBacksUpBeforeCheckout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过回滚备份集成测试")
	}
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("local-change\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := RollbackFor(dir, []string{"a.txt"}, nil); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows 上 git 默认 core.autocrlf 会把 LF 转成 CRLF，比较前先归一化换行
	if strings.TrimRight(string(content), "\r\n") != "base" {
		t.Fatalf("回滚未生效：%q", content)
	}
	backups, err := filepath.Glob(filepath.Join(dir, ".cadt", "rollback-backup", "*", "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 1 {
		t.Fatalf("应生成 1 份回滚前备份，实际 %d：%v", len(backups), backups)
	}
	saved, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimRight(string(saved), "\r\n") != "local-change" {
		t.Fatalf("备份内容不是回滚前的改动：%q", saved)
	}
}

// StatusFor 的未跟踪项必须展开到文件级：normal 模式下 git 把整个新目录折叠成
// 「?? dir/」一条，去掉尾斜杠后前端会把「目录」当成不存在的文件渲染。
// 同时 ignored 必须保持目录级折叠——每 3 秒轮询一次，展开 .cadt/ 会拖垮 UI。
func TestStatusForExpandsUntrackedKeepsIgnoredFolded(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过状态集成测试")
	}
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")

	// 新目录里放两个文件：normal 模式下 git 只输出一条 ?? newdir/
	if err := os.MkdirAll(filepath.Join(dir, "newdir", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"newdir/one.go", "newdir/nested/two.js"} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 单个未跟踪文件也应照常出现
	if err := os.WriteFile(filepath.Join(dir, "loose.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// ignored 目录里放多个文件：不应在结果里逐个展开
	if err := os.MkdirAll(filepath.Join(dir, "ignored"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("ignored/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ignored/one.log", "ignored/two.log"} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	status, err := StatusFor(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Available {
		t.Fatalf("仓库应可用：%#v", status)
	}
	got := map[string]string{}
	for _, e := range status.Entries {
		got[filepath.ToSlash(e.Path)] = e.State
	}
	abs := func(rel string) string {
		return filepath.ToSlash(filepath.Join(dir, filepath.FromSlash(rel)))
	}
	want := map[string]string{
		abs("newdir/one.go"):        "untracked",
		abs("newdir/nested/two.js"): "untracked",
		abs("loose.txt"):            "untracked",
	}
	for path, state := range want {
		if got[path] != state {
			t.Fatalf("条目 %q 状态 = %q，期望 %q（全部：%v）", path, got[path], state, got)
		}
	}
	// 未跟踪目录本身绝不能作为条目出现（否则前端把目录当文件渲染）
	if _, ok := got[abs("newdir")]; ok {
		t.Fatalf("未跟踪目录不应作为条目出现（全部：%v）", got)
	}
	// ignored 保持目录级折叠：只有一条目录条目（既有行为，供文件树打灰色角标），
	// 里面的文件不逐个展开——否则每 3 秒轮询会把 .cadt/ 等展开成上千条。
	if got[abs("ignored")] != "ignored" {
		t.Fatalf("ignored 目录条目 = %q，期望 ignored（全部：%v）", got[abs("ignored")], got)
	}
	for path := range got {
		if strings.Contains(path, "/ignored/") {
			t.Fatalf("ignored 文件不应展开：%q", path)
		}
	}
}
