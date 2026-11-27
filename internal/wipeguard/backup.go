// backup.go：L1 写前快照（方案 §4）——内容寻址 blob + 追加式索引 + 环形清理 + 手动恢复。
//
// 索引行就是元数据（方案改掉了初稿的「每备份一目录 + meta.json」）：
//
//	{"id":"b-...","ws":"d3b0738f","session":"...","tool":"edit_file","rel":"...","blob":"9f86...","bytes":900191,"at":...}
//
// blob 按 sha256 全哈希落盘（objects/<前 2 位>/<哈希>），重复内容去重；恢复前复核哈希。
// 索引追加用 sessionlock 跨进程锁（多窗口即多进程）；锁文件在备份根之外。
package wipeguard

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/sessionlock"
)

const (
	// IndexName 追加式索引文件名（备份根下）。
	IndexName = "index.jsonl"
	// backupMaxBytes 超过即跳过备份（skipped:"too-large"）。AI 写工具本身限 256KB，
	// 4MB 上限主要服务补丁路径；>10MB 只读上限之上的文件本就打不开。
	backupMaxBytes = 4 << 20
	// totalCapBytes 备份总量环形上限（唯一 blob 口径）。
	totalCapBytes = 200 << 20
	// retentionDays 备份保留期（trashcan 语义）。
	retentionDays = 7
	retention     = retentionDays * 24 * time.Hour
)

// enforceEveryRows 每 N 行追加做一次清理检查（读全索引的代价摊薄）。
// var 不是 const：并发追加测试要把阈值顶到极大，避免压缩与追加赛跑。
var enforceEveryRows = 200

// BackupCall 前端写路径入口参数。Content 是原文本（前端已在内存），Existed=false 表示新建。
type BackupCall struct {
	SessionID string `json:"sessionId"`
	Tool      string `json:"tool"` // write_file / edit_file / patch / manual
	WS        string `json:"ws"`   // 工作区解析根（服务端归一化后哈希落行）
	RelPath   string `json:"relPath"`
	AbsPath   string `json:"absPath"`
	Content   string `json:"content"`
	Existed   bool   `json:"existed"`
}

// BackupResult 备份结果。Skipped 非空表示没存内容（disabled / too-large）——调用方继续写入。
type BackupResult struct {
	EntryID string `json:"entryId"`
	Skipped string `json:"skipped,omitempty"`
	Bytes   int64  `json:"bytes"`
}

// IndexRow 索引行 = 一次备份的完整元数据。Blob 为空是 tombstone（新建文件，无内容可恢复）
// 或 skipped 行；Blob 非空时 Bytes 是 blob 大小（同 blob 多行共享一份存储）。
type IndexRow struct {
	ID      string `json:"id"`
	WS      string `json:"ws"` // 工作区解析根的短哈希（WorkspaceKey）
	Session string `json:"session"`
	Tool    string `json:"tool"`
	Rel     string `json:"rel"` // 正斜杠相对路径
	Blob    string `json:"blob,omitempty"`
	Bytes   int64  `json:"bytes,omitempty"`
	At      int64  `json:"at"`
	Skipped string `json:"skipped,omitempty"`
}

func newEntryID() string {
	var b [2]byte
	if _, err := rand.Read(b[:]); err != nil {
		b[0], b[1] = 0, 0
	}
	return fmt.Sprintf("b-%d-%s", time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}

// Backup 写前快照入口：存原文本进 CAS、追加索引行。返回 error 时调用方应当继续写入。
func (s *Service) Backup(call BackupCall) (BackupResult, error) {
	if !s.current().Enabled {
		return BackupResult{Skipped: "disabled"}, nil
	}
	// 优先取磁盘原始字节：call.Content 是解码后的文本（fileio 已剥 BOM、
	// 把 GBK 解成 Unicode），直接存会在还原时写成 UTF-8 无 BOM——带 BOM/GBK 的
	// 文件不保真。读不到（文件已被删/被锁）才退回 Content。
	data := []byte(call.Content)
	if call.Existed && call.AbsPath != "" {
		if raw, err := os.ReadFile(call.AbsPath); err == nil {
			data = raw
		}
	}
	row := IndexRow{
		ID:      newEntryID(),
		WS:      WorkspaceKey(call.WS),
		Session: call.SessionID,
		Tool:    call.Tool,
		Rel:     filepath.ToSlash(call.RelPath),
		At:      time.Now().UnixMilli(),
	}
	if call.Existed && len(data) > backupMaxBytes {
		row.Skipped = "too-large"
	} else if call.Existed {
		sum := sha256.Sum256(data)
		row.Blob = hex.EncodeToString(sum[:])
		row.Bytes = int64(len(data))
		root, err := s.ensureRoot()
		if err != nil {
			return BackupResult{}, err
		}
		if err := s.writeBlob(root, row.Blob, data); err != nil {
			return BackupResult{}, err
		}
	} else {
		// 新建文件：tombstone 行（无内容可恢复，只留「被谁改的」时间线）
		row.Blob = ""
	}
	root, err := s.ensureRoot()
	if err != nil {
		return BackupResult{}, err
	}
	if err := appendIndexRow(root, row); err != nil {
		return BackupResult{}, err
	}
	s.noteRowsForEnforce(root, 1)
	return BackupResult{EntryID: row.ID, Skipped: row.Skipped, Bytes: row.Bytes}, nil
}

// Store Go 内部钩子（internal/patch 写入点，方案 §4.2）：字节已在补丁快照里，直接进 CAS。
func (s *Service) Store(ws, rel, absPath string, content []byte) error {
	if !s.current().Enabled {
		return nil
	}
	_, err := s.Backup(BackupCall{
		SessionID: "patch",
		Tool:      "patch",
		WS:        ws,
		RelPath:   rel,
		AbsPath:   absPath,
		Content:   string(content),
		Existed:   true,
	})
	return err
}

// writeBlob 内容寻址落盘：已存在且大小一致即复用（去重）；不存在或大小不符（崩溃残行）
// 直接 O_TRUNC 重写。
//
// **不能用 temp+rename**：备份根的 deny-delete ACL 里有逐层 (CI)(DC)（拦 Go openat 删除
// 的「父目录 DELETE_CHILD 回退」），而它同时会拒掉 MoveFileEx(REPLACE_EXISTING)——连
// 目标不存在的 rename 都被拒（实测）。内容寻址 blob 是不可变文件：直写 + 大小核对 +
// 恢复前 sha256 复核，安全性与原子性等价（残行会被大小核对发现并重写）。
func (s *Service) writeBlob(root, blobID string, data []byte) error {
	path := filepath.Join(root, "objects", blobID[:2], blobID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if info, err := os.Stat(path); err == nil {
		if info.Size() == int64(len(data)) {
			return nil
		}
		// 大小不符：残行，截断重写（写权限不受 deny DELETE / deny DC 影响）
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func indexPath(root string) string { return filepath.Join(root, IndexName) }

// indexLockPath 跨进程写锁文件：放备份根之外（对齐 resourcelease「锁在被保护目录之外」惯例）。
// 根的父目录不可写时回落到根内 tmp/（兜底，牺牲一点隔离性换可用性）。
func indexLockPath(root string) string {
	sibling := filepath.Join(filepath.Dir(root), filepath.Base(root)+".lock")
	if f, err := os.Create(sibling); err == nil {
		f.Close()
		return sibling
	}
	return filepath.Join(root, "tmp", "index.lock")
}

// appendIndexRow 追加一行索引。锁拿不到（另一窗口在追加 / 压缩中）时短暂重试——
// 压缩用 temp+rename 换文件，无锁回退的追加写进旧 inode 会整行丢失，所以重试必须
// 覆盖压缩持锁的窗口；重试穷尽后才无锁追加（O_APPEND 单次小写基本原子，最坏丢一行）。
func appendIndexRow(root string, row IndexRow) error {
	data, err := json.Marshal(row)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	var lock *sessionlock.FileLock
	for attempt := 0; attempt < 10 && lock == nil; attempt++ {
		lock, err = sessionlock.TryLockFile(indexLockPath(root))
		if err == nil {
			break
		}
		if !errors.Is(err, sessionlock.ErrLocked) {
			break // 不是「忙」是「坏」（句柄/权限问题）：走无锁回退
		}
		time.Sleep(30 * time.Millisecond)
	}
	if lock != nil {
		defer lock.Release()
	}
	f, err := os.OpenFile(indexPath(root), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}

// readIndex 宽容读索引：坏行跳过（另一进程追加到一半也只损失那一行）。
func readIndex(root string) []IndexRow {
	raw, err := os.ReadFile(indexPath(root))
	if err != nil {
		return nil
	}
	rows := make([]IndexRow, 0, 64)
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row IndexRow
		if json.Unmarshal([]byte(line), &row) == nil && row.ID != "" {
			rows = append(rows, row)
		}
	}
	return rows
}

// List 列出备份记录（正序）。ws 非空时只返回该工作区的记录。
func (s *Service) List(ws string) ([]IndexRow, error) {
	root, err := s.ensureRoot()
	if err != nil {
		return nil, err
	}
	rows := readIndex(root)
	if ws == "" {
		return rows, nil
	}
	key := WorkspaceKey(ws)
	out := make([]IndexRow, 0, len(rows))
	for _, r := range rows {
		if r.WS == key {
			out = append(out, r)
		}
	}
	return out, nil
}

// Restore 把某条备份写回工作区（用户手动，方案 §4.5）。
// 安全校验：ws 哈希必须与记录一致、rel 解析后不得逃出工作区；blob 复核 sha256；
// 写回走 atomfile（尊重只读锁由前端在调用前判定）。
func (s *Service) Restore(entryID, ws string) (string, error) {
	if ws == "" {
		return "", fmt.Errorf("缺少工作区根，拒绝恢复")
	}
	root, err := s.ensureRoot()
	if err != nil {
		return "", err
	}
	var hit *IndexRow
	for _, r := range readIndex(root) {
		if r.ID == entryID {
			hit = &r
			break
		}
	}
	if hit == nil {
		return "", fmt.Errorf("备份记录不存在：%s", entryID)
	}
	if hit.WS != WorkspaceKey(ws) {
		return "", fmt.Errorf("备份记录属于另一个工作区，拒绝恢复")
	}
	rel := filepath.FromSlash(hit.Rel)
	abs := filepath.Join(ws, rel)
	if !withinDir(ws, abs) {
		return "", fmt.Errorf("备份记录的目标路径越界（%s），拒绝恢复", hit.Rel)
	}
	if hit.Blob == "" {
		if hit.Skipped == "too-large" {
			return "", fmt.Errorf("该记录没有备份内容（文件超过 %d MB 被跳过）", backupMaxBytes>>20)
		}
		return "", fmt.Errorf("该记录是新建文件的占位记录，没有原内容可恢复")
	}
	blobPath := filepath.Join(root, "objects", hit.Blob[:2], hit.Blob)
	data, err := os.ReadFile(blobPath)
	if err != nil {
		return "", fmt.Errorf("备份内容读取失败（可能已被清理）：%w", err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != hit.Blob {
		return "", fmt.Errorf("备份内容完整性校验失败（哈希不符），拒绝恢复")
	}
	if err := atomfile.WriteFileAtomic(abs, data); err != nil {
		return "", err
	}
	s.logf("info", "已还原 %s（%s，来自 %s）", hit.Rel, hit.Tool, hit.ID)
	return abs, nil
}

// ClearAll 清空整个备份根（设置 → 存储与清理的 wipe-guard 条目）。L3 快照一并清空。
func (s *Service) ClearAll() error {
	root, err := s.ensureRoot()
	if err != nil {
		return err
	}
	release, err := s.PrepareClear()
	if err != nil {
		return err
	}
	defer release()
	s.mu.Lock()
	s.enforceRows = 0
	s.modeCache = map[string]cachedMode{}
	s.mu.Unlock()
	return os.RemoveAll(root)
}

// noteRowsForEnforce 累计追加行数，到阈值做一次清理检查（超阈值才扫，方案 §4.3）。
func (s *Service) noteRowsForEnforce(root string, n int) {
	s.mu.Lock()
	s.enforceRows += n
	due := s.enforceRows >= enforceEveryRows
	if due {
		s.enforceRows = 0
	}
	s.mu.Unlock()
	if due {
		if err := s.enforce(root); err != nil {
			s.logf("warn", "备份清理失败（下次再试）：%v", err)
		}
	}
}

// enforce 环形清理：按保留期与总量删最旧的行，孤儿 blob 回收，索引压缩重写。
// 锁先拿再干活：拿不到说明另一窗口正在清理，本轮直接跳过（它反正会清同样的东西）。
func (s *Service) enforce(root string) error {
	rows := readIndex(root)
	if len(rows) == 0 {
		return nil
	}
	keep := pruneRows(rows, time.Now(), retention, totalCapBytes)
	if len(keep) == len(rows) {
		return nil
	}
	dropped := len(rows) - len(keep)
	var lock *sessionlock.FileLock
	var lockErr error
	for attempt := 0; attempt < 10; attempt++ {
		lock, lockErr = sessionlock.TryLockFile(indexLockPath(root))
		if lockErr == nil {
			break
		}
		if !errors.Is(lockErr, sessionlock.ErrLocked) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if lockErr != nil && errors.Is(lockErr, sessionlock.ErrLocked) {
		return nil // 另一窗口正在清理
	}
	if lock != nil {
		defer lock.Release()
	}
	// 接下来要改写索引 / 删 blob：备份根的 deny-delete ACL 必须先摘掉（源头是备份根本身）。
	if err := unprotectRoot(root); err != nil {
		return err
	}
	defer func() {
		if err := protectRoot(root); err != nil {
			s.logf("warn", "清理后重套 ACL 失败（下次 ensureRoot 重试）：%v", err)
		}
	}()
	lines := make([][]byte, 0, len(keep))
	referenced := referencedBlobs(root, keep)
	for _, r := range keep {
		line, err := json.Marshal(r)
		if err == nil {
			lines = append(lines, line)
		}
	}
	var buf strings.Builder
	for _, line := range lines {
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if err := atomfile.WriteFileAtomicMode(indexPath(root), []byte(buf.String()), 0o600); err != nil {
		return err
	}
	gcOrphanBlobs(filepath.Join(root, "objects"), referenced)
	s.logf("info", "备份清理完成：删 %d 行，保留 %d 行", dropped, len(keep))
	return nil
}

// referencedBlobs 汇总 objects/ 的全部存活引用：L1 索引行 + 所有 CAS manifest。
// 两者共用同一个 blob 库，但保留期不同（L1 7 天、快照 28 天）。只按 L1 行构造
// 引用集，会把仍被快照引用的 blob 当孤儿删掉——"还原快照"变成 blob 读取失败，
// 而这条兜底恢复正是整个包存在的理由。
func referencedBlobs(root string, rows []IndexRow) map[string]bool {
	ref := make(map[string]bool, len(rows))
	for _, r := range rows {
		if r.Blob != "" {
			ref[r.Blob] = true
		}
	}
	addSnapshotBlobs(ref, filepath.Join(root, "snapshots"))
	return ref
}

// addSnapshotBlobs 把 snapshots/<ws>/*.manifest.json 引用的 blob 并入引用集。
// 读不出来的 manifest 视为不存在（它已损坏，不该阻止其它 blob 回收）。
func addSnapshotBlobs(ref map[string]bool, snapshotsDir string) {
	dirs, err := os.ReadDir(snapshotsDir)
	if err != nil {
		return // 没有快照（或平台不支持该目录）：没有额外引用
	}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		wsDir := filepath.Join(snapshotsDir, d.Name())
		files, err := os.ReadDir(wsDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".manifest.json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(wsDir, f.Name()))
			if err != nil {
				continue
			}
			var m casManifest
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			for _, e := range m.Entries {
				if e.Blob != "" {
					ref[e.Blob] = true
				}
			}
		}
	}
}

// gcOrphanBlobs 删除未被任何存活行引用的 blob 与空分片目录。
func gcOrphanBlobs(objectsDir string, referenced map[string]bool) {
	shards, err := os.ReadDir(objectsDir)
	if err != nil {
		return
	}
	for _, shard := range shards {
		if !shard.IsDir() || len(shard.Name()) != 2 {
			continue
		}
		dir := filepath.Join(objectsDir, shard.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !referenced[f.Name()] {
				_ = os.Remove(filepath.Join(dir, f.Name()))
			}
		}
		_ = os.Remove(dir) // 空目录顺手收走（非空会失败，无害）
	}
}

// pruneRows 环形清理的纯函数：按保留期丢过期行；总量超限时从最旧开始丢（唯一引用的
// blob 行优先——丢共享行不立刻释放空间）。返回保留下来的行（保序）。
func pruneRows(rows []IndexRow, now time.Time, maxAge time.Duration, capBytes int64) []IndexRow {
	type blobInfo struct {
		refs  int
		bytes int64
	}
	blobs := map[string]*blobInfo{}
	var total int64
	for _, r := range rows {
		if r.Blob == "" {
			continue
		}
		b, ok := blobs[r.Blob]
		if !ok {
			b = &blobInfo{bytes: r.Bytes}
			blobs[r.Blob] = b
			total += b.bytes
		}
		b.refs++
	}
	keep := make([]bool, len(rows))
	for i, r := range rows {
		// 保留期对全部行生效（tombstone 行也会堆积索引，不豁免）；总量只约束 blob。
		keep[i] = now.Sub(time.UnixMilli(r.At)) <= maxAge
	}
	freeBlob := func(blob string) {
		if b, ok := blobs[blob]; ok && b.refs > 0 {
			b.refs--
			if b.refs == 0 {
				total -= b.bytes
			}
		}
	}
	// 超总量：先丢「唯一引用」的旧行（整份 blob 立即释放），再丢共享行。
	if total > capBytes {
		for i := range rows {
			if total <= capBytes {
				break
			}
			r := rows[i]
			if !keep[i] || r.Blob == "" || blobs[r.Blob].refs > 1 {
				continue
			}
			keep[i] = false
			total -= blobs[r.Blob].bytes
			blobs[r.Blob].refs = 0
		}
		for i := range rows {
			if total <= capBytes {
				break
			}
			r := rows[i]
			if !keep[i] || r.Blob == "" {
				continue
			}
			keep[i] = false
			freeBlob(r.Blob)
		}
	}
	out := make([]IndexRow, 0, len(rows))
	for i, r := range rows {
		if keep[i] {
			out = append(out, r)
		}
	}
	return out
}
