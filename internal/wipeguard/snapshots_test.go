package wipeguard

import (
	"archive/tar"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestDetectMode 三态派生：有 .git → git；无 git 且小 → cas；空目录 → cas（够小）。
func TestDetectMode(t *testing.T) {
	withGit := t.TempDir()
	mkFile(t, withGit, "a.txt")
	mkDir(t, withGit, ".git")
	if info := DetectMode(withGit); info.Mode != ModeGitSnapshots {
		t.Fatalf("有 .git 应判 git，得到 %+v", info)
	}
	noGit := t.TempDir()
	mkFile(t, noGit, "a.txt")
	if info := DetectMode(noGit); info.Mode != ModeCasSnapshots {
		t.Fatalf("无 git 小目录应判 cas，得到 %+v", info)
	}
	if info := DetectMode(""); info.Mode != ModePreImageOnly {
		t.Fatalf("空根应判 preimage，得到 %+v", info)
	}
}

// TestPruneStaggered staggered 保留纯函数：hour 桶 / 天桶 / 周桶 / 超龄全删 / 总量上限。
func TestPruneStaggered(t *testing.T) {
	now := time.UnixMilli(10_000_000_000)
	at := func(age time.Duration) int64 { return now.Add(-age).UnixMilli() }
	mk := func(name string, age time.Duration, bytes int64) SnapshotEntry {
		return SnapshotEntry{Name: name, At: at(age), Bytes: bytes}
	}

	t.Run("最近1小时全保（≥5分钟间隔）", func(t *testing.T) {
		entries := []SnapshotEntry{mk("a", 5*time.Minute, 1), mk("b", 15*time.Minute, 1), mk("c", 55*time.Minute, 1)}
		keep := pruneStaggered(entries, now, 1<<30)
		if len(keep) != 3 {
			t.Fatalf("应全保：%v", keep)
		}
	})
	t.Run("同5分钟桶只保最新", func(t *testing.T) {
		// 4 分钟 / 2 分钟同落一个 5 分钟桶（At/300000）
		entries := []SnapshotEntry{mk("early", 4*time.Minute, 1), mk("late", 2*time.Minute, 1)}
		keep := pruneStaggered(entries, now, 1<<30)
		if len(keep) != 1 || !keep["late"] {
			t.Fatalf("应只保 late：%v", keep)
		}
	})
	t.Run("同一天只保最新一份", func(t *testing.T) {
		// 天桶 = At/86400000：用绝对 At 构造同一纪元日内两份 + 前一天一份
		// now = 第 2 个纪元日零点；morning/evening 都在第 1 个纪元日，d2 在第 0 日
		const day = 24 * 60 * 60 * 1000
		entries := []SnapshotEntry{
			{Name: "d-morning", At: day + 1*60*60*1000, Bytes: 1},
			{Name: "d-evening", At: day + 20*60*60*1000, Bytes: 1},
			{Name: "d2", At: 0, Bytes: 1},
		}
		keep := pruneStaggered(entries, time.UnixMilli(2*day), 1<<30)
		if len(keep) != 2 || !keep["d-evening"] || !keep["d2"] {
			t.Fatalf("天桶去重失效：%v", keep)
		}
	})
	t.Run("超过 28 天不保", func(t *testing.T) {
		entries := []SnapshotEntry{mk("ancient", 40*24*time.Hour, 1), mk("recent", 20*24*time.Hour, 1)}
		keep := pruneStaggered(entries, now, 1<<30)
		if len(keep) != 1 || !keep["recent"] {
			t.Fatalf("古老快照应被清：%v", keep)
		}
	})
	t.Run("总量超上限从最旧开始丢", func(t *testing.T) {
		entries := []SnapshotEntry{mk("big-old", 30*time.Minute, 100), mk("mid", 20*time.Minute, 100), mk("new", 10*time.Minute, 100)}
		keep := pruneStaggered(entries, now, 250)
		if len(keep) != 2 || keep["big-old"] {
			t.Fatalf("应从最旧丢：%v", keep)
		}
	})
}

// TestSnapshotCasRoundtrip 增量 CAS：首轮全量、二轮只动一个文件 → blob 总数只多一；
// 还原最新 manifest 后文件内容逐字节复原（方案 §9）。
func TestSnapshotCasRoundtrip(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(ws, filepath.FromSlash(rel)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "A")
	write("b.txt", "B")
	mkFile(t, ws, "sub/c.txt") // "x"

	r1, err := s.Snapshot(ws)
	if err != nil {
		t.Fatal(err)
	}
	if r1.Mode != ModeCasSnapshots || r1.Files != 3 {
		t.Fatalf("首轮快照异常：%+v", r1)
	}
	blobsAfterFirst := countBlobs(t, s)

	// 只改 b.txt；a.txt / sub/c.txt 原样
	time.Sleep(5 * time.Millisecond) // mtime 粒度
	write("b.txt", "B2")
	r2, err := s.Snapshot(ws)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Files != 3 {
		t.Fatalf("二轮文件数不符：%+v", r2)
	}
	if got := countBlobs(t, s); got != blobsAfterFirst+1 {
		t.Fatalf("增量应只新增 1 个 blob：%d → %d", blobsAfterFirst, got)
	}

	// 模拟破坏：清空工作区文件再还原
	write("a.txt", "WIPED")
	write("b.txt", "WIPED")
	write("sub/c.txt", "WIPED")
	if _, err := s.SnapshotRestore(ws, r2.Name); err != nil {
		t.Fatal(err)
	}
	read := func(rel string) string {
		data, err := os.ReadFile(filepath.Join(ws, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if read("a.txt") != "A" || read("b.txt") != "B2" || read("sub/c.txt") != "x" {
		t.Fatalf("还原内容不符：%q %q %q", read("a.txt"), read("b.txt"), read("sub/c.txt"))
	}
}

// TestSnapshotRestoreRejectsBadName 快照名穿越校验。
func TestSnapshotRestoreRejectsBadName(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	for _, bad := range []string{"../evil.tar", "a/b.tar", "x\\y.tar", ".."} {
		if _, err := s.SnapshotRestore(ws, bad); err == nil {
			t.Fatalf("非法快照名 %q 应被拒绝", bad)
		}
	}
}

// TestExtractTarSafe 解包校验：合法 tar 逐文件还原；含 .. 的 tar 直接终止。
func TestExtractTarSafe(t *testing.T) {
	ws := t.TempDir()
	tarPath := filepath.Join(t.TempDir(), "snap.tar")
	build := func(names map[string]string) {
		f, err := os.Create(tarPath)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		tw := tar.NewWriter(f)
		for name, content := range names {
			if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
		if err := tw.Close(); err != nil {
			t.Fatal(err)
		}
	}
	build(map[string]string{"a.txt": "hello", "sub/b.txt": "world"})
	if err := extractTarSafe(tarPath, ws); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(ws, "a.txt"))
	if string(data) != "hello" {
		t.Fatalf("解包内容不符：%q", data)
	}
	data, _ = os.ReadFile(filepath.Join(ws, "sub", "b.txt"))
	if string(data) != "world" {
		t.Fatalf("子目录解包不符：%q", data)
	}
	build(map[string]string{"../evil.txt": "boom"})
	if err := extractTarSafe(tarPath, ws); err == nil {
		t.Fatalf("含 .. 的 tar 应被拒绝")
	}
}

// TestSnapshotGit 端到端：真 git 仓 → 快照 tar → 清空工作区 → 还原（含 untracked，方案 §9）。
// git 不可用时跳过（不拖垮无 git 环境）。
func TestSnapshotGit(t *testing.T) {
	if _, err := lookGit(); err != nil {
		t.Skip("git 不可用，跳过 git 快照端到端")
	}
	s := newTestService(t)
	ws := t.TempDir()
	write := func(rel, content string) {
		path := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("tracked.txt", "tracked content")
	// git init（不设身份：add / write-tree / archive 都不需要提交身份）
	if err := runGit(t, ws, "init"); err != nil {
		t.Skipf("git init 失败：%v", err)
	}
	write("untracked-new.txt", "untracked content")

	res, err := s.Snapshot(ws)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != ModeGitSnapshots || !strings.HasSuffix(res.Name, ".tar") || res.Bytes <= 0 {
		t.Fatalf("git 快照产物异常：%+v", res)
	}

	// 模拟事故：删掉全部内容（含 .git）
	for _, rel := range []string{"tracked.txt", "untracked-new.txt", ".git"} {
		if err := os.RemoveAll(filepath.Join(ws, filepath.FromSlash(rel))); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(ws, "tracked.txt")); !os.IsNotExist(err) {
		t.Fatalf("破坏未生效")
	}
	// 还原不需要 .git 存在（自足 tar 的意义）
	if _, err := s.SnapshotRestore(ws, res.Name); err != nil {
		t.Fatal(err)
	}
	read := func(rel string) string {
		data, err := os.ReadFile(filepath.Join(ws, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if read("tracked.txt") != "tracked content" || read("untracked-new.txt") != "untracked content" {
		t.Fatalf("还原内容不符")
	}
}

func runGit(t *testing.T, dir string, args ...string) error {
	t.Helper()
	cmd := execCommand("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %v: %v: %s", args, err, string(out))
	}
	return nil
}

// TestSnapshotList 清单按时间正序且只认两类产物。
func TestSnapshotList(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	dir, err := s.snapshotDir(mustRoot(t, s), ws)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "20260101-000000.tar"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "20260102-000000.manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "junk.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := s.SnapshotList(ws)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Kind != "tar" || entries[1].Kind != "manifest" {
		t.Fatalf("清单异常：%+v", entries)
	}
}

func mustRoot(t *testing.T, s *Service) string {
	t.Helper()
	root, err := s.ensureRoot()
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// ---- L3 韧性：add -A 单个坏文件跳过重试（2026-11-21 frontend\nul 连败 13 轮的教训）----

func TestParseUnindexable(t *testing.T) {
	out := []byte("warning: in the working copy of 'LICENSE', CRLF will be replaced by LF\n" +
		"error: open(\"frontend/nul\"): No such file or directory\n" +
		"error: unable to index file 'frontend/nul'\n" +
		"error: unable to index file \"docs/\\346\\265\\213\\350\\257\\225.txt\"\n" +
		"fatal: adding files failed\n")
	got := parseUnindexable(out)
	if len(got) != 2 || got[0] != "frontend/nul" || got[1] != "docs/测试.txt" {
		t.Fatalf("解析异常（open/unable 同路径应去重，C 八进制应还原）：%q", got)
	}
	if got := parseUnindexable([]byte("fatal: Unable to create 'index.lock': File exists\n")); len(got) != 0 {
		t.Fatalf("锁冲突不该解析出 Culprit：%q", got)
	}
}

func TestCompactGitOutput(t *testing.T) {
	out := []byte("warning: a\nwarning: b\nerror: open(\"x\"): boom\n\nfatal: adding files failed\n")
	if s := compactGitOutput(out); s != "error: open(\"x\"): boom\nfatal: adding files failed" {
		t.Fatalf("应丢 warning/空行：%q", s)
	}
	if s := compactGitOutput([]byte(strings.Repeat("warning: x\n", 500))); len(s) > 2100 {
		t.Fatalf("超长未截断：%d", len(s))
	}
}

func TestAddAllWith(t *testing.T) {
	t.Run("坏文件排除后重试成功", func(t *testing.T) {
		var calls [][]string
		add := func(args []string) ([]byte, error) {
			calls = append(calls, append([]string{}, args...))
			if len(calls) == 1 {
				return []byte("warning: x\nerror: open(\"frontend/nul\"): boom\nfatal: adding files failed\n"),
					fmt.Errorf("exit status 128")
			}
			return []byte(""), nil
		}
		excluded, err := gitAddAllWith(add)
		if err != nil {
			t.Fatal(err)
		}
		if len(excluded) != 1 || excluded[0] != "frontend/nul" {
			t.Fatalf("excluded=%q", excluded)
		}
		if len(calls) != 2 {
			t.Fatalf("应恰好重试一轮，实际 %d 次", len(calls))
		}
		if calls[1][3] != ":(exclude)frontend/nul" {
			t.Fatalf("第二轮应带 exclude pathspec：%q", calls[1])
		}
	})
	t.Run("锁冲突没有Culprit按原样失败", func(t *testing.T) {
		add := func(args []string) ([]byte, error) {
			return []byte("fatal: Unable to create 'index.lock': File exists\n"), fmt.Errorf("exit status 128")
		}
		if _, err := gitAddAllWith(add); err == nil {
			t.Fatal("应失败")
		}
	})
	t.Run("排除无效时原样失败不静默丢文件", func(t *testing.T) {
		add := func(args []string) ([]byte, error) {
			return []byte("error: open(\"frontend/nul\"): boom\nfatal: adding files failed\n"), fmt.Errorf("exit status 128")
		}
		if _, err := gitAddAllWith(add); err == nil {
			t.Fatal("同一 Culprit 反复出现应失败（说明 exclude 没生效），不能静默丢")
		}
	})
	t.Run("每轮新坏文件超上限按失败处理", func(t *testing.T) {
		n := 0
		add := func(args []string) ([]byte, error) {
			n++
			return []byte(fmt.Sprintf("error: open(\"bad/%d.txt\"): boom\nfatal: adding files failed\n", n)),
				fmt.Errorf("exit status 128")
		}
		if _, err := gitAddAllWith(add); err == nil {
			t.Fatal("超重试上限应失败（不允许悄悄缺很多文件）")
		}
	})
}

// CAS 快照与 L1 备份共用 objects/：GC 的引用集必须同时覆盖 manifest。
// 只按 L1 行构造（L1 保 7 天、快照保 28 天），7 天前的快照 blob 会被当孤儿清掉，
// 点"还原快照"得到 blob 读取失败——这条兜底恢复正是整个包存在的意义。
func TestEnforceKeepsSnapshotBlobs(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	if err := os.WriteFile(filepath.Join(ws, "a.txt"), []byte("A"), 0o644); err != nil {
		t.Fatal(err)
	}
	snap, err := s.Snapshot(ws)
	if err != nil {
		t.Fatal(err)
	}
	// 造一条 8 天前的 L1 行，让 enforce 真正进入清理分支
	old, err := s.Backup(BackupCall{Tool: "edit_file", WS: ws, RelPath: "other.txt", Content: "stale", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	root, _ := s.ensureRoot()
	rows := readIndex(root)
	for i := range rows {
		if rows[i].ID == old.EntryID {
			rows[i].At = time.Now().Add(-8 * 24 * time.Hour).UnixMilli()
		}
	}
	if err := rewriteIndexForTest(root, rows); err != nil {
		t.Fatal(err)
	}
	if err := s.enforce(root); err != nil {
		t.Fatal(err)
	}

	// 快照仍能还原：blob 没被当成孤儿回收
	if err := os.WriteFile(filepath.Join(ws, "a.txt"), []byte("WIPED"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SnapshotRestore(ws, snap.Name); err != nil {
		t.Fatalf("L1 清理后快照应仍可还原：%v", err)
	}
	data, err := os.ReadFile(filepath.Join(ws, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "A" {
		t.Fatalf("还原内容不符：%q", data)
	}
}
