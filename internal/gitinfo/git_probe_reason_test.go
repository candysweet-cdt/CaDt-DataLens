// gitProbeReason 的原因分类测试。
//
// 背景（2026-11-26 实测反馈）：非 git 目录的 Git 图谱显示「未安装 git」。
// 根因是 gitRun 的约定——退出码非 0 走 code（err=nil），只有**进程没跑起来**才返回 err；
// 而「进程没跑起来」至少有三种原因，调用点却一律写成「未安装 git」：
//   · 找不到可执行文件（真没装）
//   · 工作目录已被删除 / 改名（chdir 失败）
//   · 超时或其它启动失败
//
// 用户按「未安装 git」去装 git，装完照样看不到图谱——所以必须分开说。
package gitinfo

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitProbeReason(t *testing.T) {
	// 目录状现状：oneDir 存在，goneDir 不存在——gitProbeReason 会 stat 它做兜底。
	oneDir := t.TempDir()
	goneDir := filepath.Join(t.TempDir(), "removed")
	cases := []struct {
		name string
		dir  string
		err  error
		want string
	}{
		{
			name: "nil 不产生原因",
			dir:  oneDir,
			err:  nil,
			want: "",
		},
		{
			name: "找不到 git 可执行文件 → 未安装",
			dir:  oneDir,
			err:  &exec.Error{Name: "git", Err: exec.ErrNotFound},
			want: "未安装 git",
		},
		{
			name: "裸 exec.ErrNotFound 也认",
			dir:  oneDir,
			err:  exec.ErrNotFound,
			want: "未安装 git",
		},
		{
			name: "工作目录不存在（errno 可判）→ 目录不存在，不是没装 git",
			dir:  goneDir,
			err:  &os.PathError{Op: "chdir", Path: goneDir, Err: fs.ErrNotExist},
			want: "当前目录不存在",
		},
		{
			// Windows 实测形态：fork/exec 失败只给这一句，errno 与文本都不可依赖
			name: "工作目录不存在（Windows fork/exec 文案）→ stat 兜底",
			dir:  goneDir,
			err:  errors.New(`fork/exec C:\Program Files\Git\mingw64\bin\git.exe: The directory name is invalid.`),
			want: "当前目录不存在",
		},
		{
			name: "目录存在但启动失败 → 报原文，不误导去装 git",
			dir:  oneDir,
			err:  errors.New("git 命令超时"),
			want: "git 无法启动：git 命令超时",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gitProbeReason(tc.dir, tc.err); got != tc.want {
				t.Fatalf("gitProbeReason(%q, %v) = %q，期望 %q", tc.dir, tc.err, got, tc.want)
			}
		})
	}
}

// 集成：非仓库目录必须报「不在 git 仓库内」，不能报「未安装 git」。
// 这是用户实际撞到的那一幕（图谱左上 / 左下同时显示「未安装 git」）。
func TestGraphCommitsNotARepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过集成测试")
	}
	dir := t.TempDir() // 空目录，没有 .git
	page, err := GraphCommits(dir, "", 10, 0)
	if err != nil {
		t.Fatalf("GraphCommits 不应返回 error：%v", err)
	}
	if page.Available {
		t.Fatal("非仓库目录不该标 Available")
	}
	if page.Reason != "不在 git 仓库内" {
		t.Fatalf("Reason = %q，期望「不在 git 仓库内」（而不是「未安装 git」）", page.Reason)
	}
}

// 集成：目录被删除后必须报「当前目录不存在」，不能报「未安装 git」。
// 多工作区下很常见：会话记着的仓库目录被用户在资源管理器里删掉 / 改名了。
func TestGraphCommitsDirGone(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过集成测试")
	}
	parent := t.TempDir()
	gone := filepath.Join(parent, "dir-that-will-be-removed")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	if err := os.Remove(gone); err != nil {
		t.Fatalf("删目录失败：%v", err)
	}
	page, err := GraphCommits(gone, "", 10, 0)
	if err != nil {
		t.Fatalf("GraphCommits 不应返回 error：%v", err)
	}
	if strings.Contains(page.Reason, "未安装") {
		t.Fatalf("目录不存在时不能说「未安装 git」，实际：%q", page.Reason)
	}
	if page.Reason != "当前目录不存在" {
		t.Fatalf("Reason = %q，期望「当前目录不存在」", page.Reason)
	}
}

// 集成：StatusFor / GraphRefs / BranchesFor 与 GraphCommits 同口径
// （五个调用点共用 gitProbeReason，这里抽查另外三个别再各写一套）。
func TestProbeReasonSharedAcrossEntrypoints(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过集成测试")
	}
	dir := t.TempDir() // 非仓库
	status, err := StatusFor(dir)
	if err != nil {
		t.Fatalf("StatusFor error：%v", err)
	}
	if status.Reason != "不在 git 仓库内" {
		t.Fatalf("StatusFor Reason = %q", status.Reason)
	}
	refs, err := GraphRefs(dir)
	if err != nil {
		t.Fatalf("GraphRefs error：%v", err)
	}
	if refs.Reason != "不在 git 仓库内" {
		t.Fatalf("GraphRefs Reason = %q", refs.Reason)
	}
	branches, err := BranchesFor(dir, false)
	if err != nil {
		t.Fatalf("BranchesFor error：%v", err)
	}
	if branches.Reason != "不在 git 仓库内" {
		t.Fatalf("BranchesFor Reason = %q", branches.Reason)
	}
}
