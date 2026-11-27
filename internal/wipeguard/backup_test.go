package wipeguard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// newTestService 构造接好临时应用数据根的服务（全开设置）。
func newTestService(t *testing.T) *Service {
	t.Helper()
	base := t.TempDir()
	s := New(Deps{Root: func() string { return base }})
	s.Configure(DefaultSettings())
	// 备份根会被套 deny-delete ACL：测试结束先摘掉，否则 t.TempDir 清理会留下保护目录。
	root := filepath.Join(base, "wipe-guard")
	t.Cleanup(func() {
		if _, err := os.Stat(root); err == nil {
			_ = unprotectRoot(root)
		}
	})
	// 并发 / 追加类测试不与压缩赛跑：把触发阈值顶到极大（restore on defer）。
	oldEnforceEveryRows := enforceEveryRows
	enforceEveryRows = 1 << 30
	t.Cleanup(func() { enforceEveryRows = oldEnforceEveryRows })
	return s
}

// TestBackupAndRestore 覆盖：新建 tombstone → 覆盖（有备份）→ 还原逐字节相等（方案 §9）。
func TestBackupAndRestore(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	rel := "src/app/main.go"

	// 新建文件：tombstone，无内容可恢复
	res1, err := s.Backup(BackupCall{Tool: "write_file", WS: ws, RelPath: rel, Content: "new content", Existed: false})
	if err != nil {
		t.Fatal(err)
	}
	if res1.Skipped != "" || res1.Bytes != 0 {
		t.Fatalf("新建文件应为 tombstone：%+v", res1)
	}
	if _, err := s.Restore(res1.EntryID, ws); err == nil {
		t.Fatalf("tombstone 不应可恢复")
	}

	// 覆盖：先有原文件，备份原内容，再模拟写坏
	abs := filepath.Join(ws, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte("precious original"), 0o644); err != nil {
		t.Fatal(err)
	}
	res2, err := s.Backup(BackupCall{Tool: "write_file", WS: ws, RelPath: rel, Content: "precious original", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	if res2.Bytes != int64(len("precious original")) {
		t.Fatalf("Bytes = %d", res2.Bytes)
	}
	if err := os.WriteFile(abs, []byte("wiped by ai"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := s.Restore(res2.EntryID, ws)
	if err != nil {
		t.Fatal(err)
	}
	if got != abs {
		t.Fatalf("还原路径 = %q，期望 %q", got, abs)
	}
	data, _ := os.ReadFile(abs)
	if string(data) != "precious original" {
		t.Fatalf("还原内容不符：%q", data)
	}
}

// TestBackupDedup 同内容二次备份只存一份 blob（内容寻址去重，方案 §4.1）。
func TestBackupDedup(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	_, err := s.Backup(BackupCall{Tool: "edit_file", WS: ws, RelPath: "a.txt", Content: "same", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Backup(BackupCall{Tool: "edit_file", WS: ws, RelPath: "b.txt", Content: "same", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Backup(BackupCall{Tool: "edit_file", WS: ws, RelPath: "a.txt", Content: "different", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	blobs := countBlobs(t, s)
	if blobs != 2 {
		t.Fatalf("blob 文件数 = %d，期望 2（同内容跨文件去重）", blobs)
	}
	rows, err := s.List(ws)
	if err != nil || len(rows) != 3 {
		t.Fatalf("List = %d 行（err=%v），期望 3", len(rows), err)
	}
}

func countBlobs(t *testing.T, s *Service) int {
	t.Helper()
	root, err := s.ensureRoot()
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	shards, _ := os.ReadDir(filepath.Join(root, "objects"))
	for _, shard := range shards {
		files, _ := os.ReadDir(filepath.Join(root, "objects", shard.Name()))
		count += len(files)
	}
	return count
}

// TestBackupTooLarge 超 4MB 跳过并在索引可见（方案 §4.1），还原时明确报错。
func TestBackupTooLarge(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	big := strings.Repeat("a", backupMaxBytes+1)
	res, err := s.Backup(BackupCall{Tool: "patch", WS: ws, RelPath: "big.bin", Content: big, Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != "too-large" {
		t.Fatalf("Skipped = %q，期望 too-large", res.Skipped)
	}
	rows, _ := s.List(ws)
	if len(rows) != 1 || rows[0].Skipped != "too-large" {
		t.Fatalf("skipped 行未入索引：%+v", rows)
	}
	if _, err := s.Restore(res.EntryID, ws); err == nil || !strings.Contains(fmt.Sprint(err), "超过") {
		t.Fatalf("还原超大记录应明确报错，得到 %v", err)
	}
}

// TestBackupDisabled 总开关关闭：Skipped=disabled，不落任何盘。
func TestBackupDisabled(t *testing.T) {
	s := newTestService(t)
	s.Configure(Settings{Enabled: false, Snapshots: false})
	res, err := s.Backup(BackupCall{Tool: "write_file", WS: "d:/x", RelPath: "a", Content: "v", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != "disabled" {
		t.Fatalf("Skipped = %q，期望 disabled", res.Skipped)
	}
}

// TestBackupWorkspaceIsolation List 按工作区哈希过滤；恢复拒绝跨工作区。
func TestBackupWorkspaceIsolation(t *testing.T) {
	s := newTestService(t)
	wsA, wsB := t.TempDir(), t.TempDir()
	res, err := s.Backup(BackupCall{Tool: "edit_file", WS: wsA, RelPath: "a.txt", Content: "A", Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	listA, _ := s.List(wsA)
	listB, _ := s.List(wsB)
	if len(listA) != 1 || len(listB) != 0 {
		t.Fatalf("工作区过滤失效：A=%d B=%d", len(listA), len(listB))
	}
	if _, err := s.Restore(res.EntryID, wsB); err == nil {
		t.Fatalf("跨工作区恢复应被拒绝")
	}
}

// TestRestoreRejectsTraversal 索引行 rel 被篡改为 .. 时拒绝恢复（方案 §4.5 安全校验）。
func TestRestoreRejectsTraversal(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	root, err := s.ensureRoot()
	if err != nil {
		t.Fatal(err)
	}
	evil := IndexRow{ID: "evil", WS: WorkspaceKey(ws), Session: "x", Tool: "write_file",
		Rel: "../../outside.txt", Blob: "", At: time.Now().UnixMilli()}
	if err := appendIndexRow(root, evil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Restore("evil", ws); err == nil {
		t.Fatalf("路径越界恢复应被拒绝")
	}
}

// TestConcurrentAppend 多窗口并发追加 1000 行不丢不少（方案 §9）。
func TestConcurrentAppend(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	const goroutines, perG = 50, 20
	var wg sync.WaitGroup
	errs := make(chan error, goroutines)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				if _, err := s.Backup(BackupCall{
					Tool: "edit_file", WS: ws,
					RelPath: fmt.Sprintf("f-%d-%d.txt", g, i),
					Content: fmt.Sprintf("v-%d-%d", g, i), Existed: true,
				}); err != nil {
					errs <- err
					return
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	rows, err := s.List(ws)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != goroutines*perG {
		t.Fatalf("并发追加丢行：得到 %d，期望 %d", len(rows), goroutines*perG)
	}
}

// TestPruneRows 环形清理纯函数：保留期 + 总量 + 去重口径。
func TestPruneRows(t *testing.T) {
	now := time.UnixMilli(1_000_000_000_000)
	mk := func(id string, age time.Duration, blob string, bytes int64) IndexRow {
		return IndexRow{ID: id, At: now.Add(-age).UnixMilli(), Blob: blob, Bytes: bytes}
	}
	blobOf := func(tag string) string { return strings.Repeat(tag, 8) } // 假哈希只需唯一
	cases := []struct {
		name    string
		rows    []IndexRow
		maxAge  time.Duration
		cap     int64
		wantIDs []string
	}{
		{
			name:    "过期行全删（含 tombstone）",
			rows:    []IndexRow{mk("old", 8*24*time.Hour, "", 0), mk("old-tomb", 8*24*time.Hour, "", 0), mk("new", time.Hour, blobOf("aa"), 10)},
			maxAge:  7 * 24 * time.Hour,
			cap:     1 << 30,
			wantIDs: []string{"new"},
		},
		{
			name:    "总量超限：从最旧的唯一引用行开始丢，保最新",
			rows:    []IndexRow{mk("r1", time.Hour, blobOf("aa"), 90), mk("r2", 2*time.Hour, blobOf("bb"), 90), mk("r3", 3*time.Hour, blobOf("cc"), 90)},
			maxAge:  7 * 24 * time.Hour,
			cap:     150,
			wantIDs: []string{"r3"},
		},
		{
			name:    "共享 blob 行：丢行不丢字节，直到最后一行",
			rows:    []IndexRow{mk("s1", time.Hour, blobOf("aa"), 100), mk("s2", 2*time.Hour, blobOf("aa"), 100), mk("s3", 3*time.Hour, blobOf("bb"), 100)},
			maxAge:  7 * 24 * time.Hour,
			cap:     150,
			wantIDs: []string{"s1", "s2"},
		},
		{
			name:    "未超限只按年龄",
			rows:    []IndexRow{mk("a", 2*time.Hour, blobOf("aa"), 10), mk("b", time.Hour, blobOf("bb"), 10)},
			maxAge:  7 * 24 * time.Hour,
			cap:     1000,
			wantIDs: []string{"a", "b"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pruneRows(tc.rows, now, tc.maxAge, tc.cap)
			ids := make([]string, 0, len(got))
			for _, r := range got {
				ids = append(ids, r.ID)
			}
			if strings.Join(ids, ",") != strings.Join(tc.wantIDs, ",") {
				t.Fatalf("保留 = %v，期望 %v", ids, tc.wantIDs)
			}
		})
	}
}

// TestEnforceAndOrphanGC 清理触发后：过期行被删、孤儿 blob 被回收（方案 §4.3）。
func TestEnforceAndOrphanGC(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	// 一行 8 天前的备份（blob 留盘）+ 一行新鲜的
	oldContent, newContent := "stale", "fresh"
	oldRes, err := s.Backup(BackupCall{Tool: "edit_file", WS: ws, RelPath: "old.txt", Content: oldContent, Existed: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Backup(BackupCall{Tool: "edit_file", WS: ws, RelPath: "new.txt", Content: newContent, Existed: true}); err != nil {
		t.Fatal(err)
	}
	// 把旧行的 At 改到 8 天前（直接改写索引文件）
	root, _ := s.ensureRoot()
	rows := readIndex(root)
	for i := range rows {
		if rows[i].ID == oldRes.EntryID {
			rows[i].At = time.Now().Add(-8 * 24 * time.Hour).UnixMilli()
		}
	}
	if err := rewriteIndexForTest(root, rows); err != nil {
		t.Fatal(err)
	}
	if err := s.enforce(root); err != nil {
		t.Fatal(err)
	}
	kept := readIndex(root)
	if len(kept) != 1 || kept[0].Rel != "new.txt" {
		t.Fatalf("过期行未被清： %+v", kept)
	}
	// 旧 blob 已被回收：只剩新 blob
	if blobs := countBlobs(t, s); blobs != 1 {
		t.Fatalf("孤儿 blob 未回收：剩 %d 个", blobs)
	}
	// 新内容仍可恢复
	if _, err := s.Restore(kept[0].ID, ws); err != nil {
		t.Fatalf("清理后新备份应仍可恢复：%v", err)
	}
}

func rewriteIndexForTest(root string, rows []IndexRow) error {
	var buf strings.Builder
	for _, r := range rows {
		line, err := json.Marshal(r)
		if err != nil {
			return err
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return os.WriteFile(indexPath(root), []byte(buf.String()), 0o600)
}

// TestClearAll 清空整个备份根；再备份时自动重建。
func TestClearAll(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	if _, err := s.Backup(BackupCall{Tool: "write_file", WS: ws, RelPath: "a", Content: "v", Existed: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearAll(); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.List(ws)
	if len(rows) != 0 {
		t.Fatalf("清空后仍有记录：%d", len(rows))
	}
	if _, err := s.Backup(BackupCall{Tool: "write_file", WS: ws, RelPath: "a", Content: "v2", Existed: true}); err != nil {
		t.Fatal(err)
	}
	if rows, _ = s.List(ws); len(rows) != 1 {
		t.Fatalf("清空后新备份不可用")
	}
}

// 写前备份必须存磁盘原始字节：call.Content 是解码后的文本（BOM 已剥、GBK 已转
// Unicode），直接存会在还原时写成 UTF-8 无 BOM，字节不保真。
func TestBackupKeepsRawBytes(t *testing.T) {
	s := newTestService(t)
	ws := t.TempDir()
	abs := filepath.Join(ws, "bom.txt")
	original := append([]byte{0xEF, 0xBB, 0xBF}, []byte("中文内容\r\n")...)
	if err := os.WriteFile(abs, original, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := s.Backup(BackupCall{
		Tool:    "edit_file",
		WS:      ws,
		RelPath: "bom.txt",
		AbsPath: abs,
		Content: "中文内容\r\n", // 解码后的文本（无 BOM）
		Existed: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Restore(res.EntryID, ws); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("还原字节不保真：\n got=%v\nwant=%v", got, original)
	}
}
