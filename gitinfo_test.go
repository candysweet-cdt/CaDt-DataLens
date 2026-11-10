package main

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

	app := &App{}
	res, err := app.GitBranchesFor(dir, true)
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

	op, err := app.GitCheckoutBranch(dir, "feature/one", false)
	if err != nil || !op.Success {
		t.Fatalf("checkout local failed: %#v %v", op, err)
	}
	res, _ = app.GitBranchesFor(dir, true)
	if res.Current != "feature/one" {
		t.Fatalf("current branch = %q, want feature/one", res.Current)
	}

	op, err = app.GitCreateBranch(dir, "feature/two")
	if err != nil || !op.Success {
		t.Fatalf("create branch failed: %#v %v", op, err)
	}
	if res, _ = app.GitBranchesFor(dir, true); res.Current != "feature/two" {
		t.Fatalf("current branch after create = %q", res.Current)
	}
	op, err = app.GitCreateBranch(dir, "bad name")
	if err != nil {
		t.Fatalf("invalid branch name returned error: %v", err)
	}
	if op.Success {
		t.Fatal("invalid branch name should fail")
	}

	gitTestCmd(t, dir, "tag", "v1")
	op, err = app.GitCheckoutRefFor(dir, "v1")
	if err != nil || !op.Success {
		t.Fatalf("checkout tag failed: %#v %v", op, err)
	}
	if res, _ = app.GitBranchesFor(dir, true); res.Current != "HEAD" {
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

	app := &App{}
	res, err := app.GitBranchesFor(dir, true)
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
	localOnly, err := app.GitBranchesFor(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(localOnly.Remote) != 0 {
		t.Fatalf("includeRemote=false should skip remote refs: %#v", localOnly.Remote)
	}
	if !localOnly.Available || len(localOnly.Local) == 0 {
		t.Fatalf("local-only result incomplete: %#v", localOnly)
	}
	op, err := app.GitCheckoutBranch(dir, "origin/remote-only", true)
	if err != nil || !op.Success {
		t.Fatalf("checkout remote branch failed: %#v %v", op, err)
	}
	res, _ = app.GitBranchesFor(dir, true)
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
