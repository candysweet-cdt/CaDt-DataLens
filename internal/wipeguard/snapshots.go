// snapshots.go：L3 定期状态快照（方案 §6，原 L3/L4 合并）。
//
// 三态派生（DetectMode，打开工作区时判定一次）：
//   - git：临时 index + write-tree + git archive 自足 tar（还原不需要 .git 存在——契合事故形态；
//     刻意不用 pack-objects：裸 sha 打不出自足包；不用 stash create：主树不含 untracked）；
//   - cas：无 git 且小工作区，全树增量喂与 L1 共用的 CAS，manifest 存 snapshots/<ws>/；
//   - preimage：无 git 且大（或判定超预算）——不快照，UI 明说（§6.3）。
//
// 保留 staggered（Syncthing 语义）+ 总量上限，纯函数 pruneStaggered 可表驱动测试。
package wipeguard

import (
	"archive/tar"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"datalens/internal/atomfile"
)

// Mode 快照层形态。
type Mode string

const (
	ModePreImageOnly Mode = "preimage" // 默认：L1 + L2
	ModeGitSnapshots Mode = "git"      // L1 + L2 + git archive
	ModeCasSnapshots Mode = "cas"      // L1 + L2 + 增量 CAS
)

// 快照层阈值（工程参数，不进设置 UI）。
const (
	casMaxBytes      = 200 << 20 // 无 git 工作区可开 CAS 的体积上限
	casMaxFiles      = 5000      // 同上，文件数上限
	gitMaxBytes      = 2 << 30   // 有 git 也得能打成 tar：超过 2GB 的工作区不定期快照
	modeCacheTTL     = 5 * time.Minute
	snapshotInterval = 10 * time.Minute
	snapshotTotalCap = 300 << 20
)

// ===== 快照类型与模式检测 =====
// ModeInfo 形态判定结果（Reason 用于设置页回答「为什么没快照」）。
type ModeInfo struct {
	Mode   Mode   `json:"mode"`
	Reason string `json:"reason"`
}

// SnapshotResult 一次快照的产出。
type SnapshotResult struct {
	Mode     Mode   `json:"mode"`
	Name     string `json:"name"`               // tar / manifest 文件名（snapshots/<ws>/ 下）
	Path     string `json:"path"`               // 绝对路径
	Files    int    `json:"files"`              // 本次覆盖的文件数
	Bytes    int64  `json:"bytes"`              // 产物大小
	Skipped  string `json:"skipped,omitempty"`  // 未产生快照的原因（disabled / preimage）
	Excluded string `json:"excluded,omitempty"` // 已产生快照但被跳过的无法索引文件（tar/manifest 不含它们）
}

// SnapshotEntry 快照清单项。
type SnapshotEntry struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"` // tar / manifest
	At    int64  `json:"at"`
	Bytes int64  `json:"bytes"`
}

// detectMode 派生快照层形态（带 TTL 缓存；恢复出口与设置页都要读）。
func (s *Service) detectMode(ws string) ModeInfo {
	if !s.current().Snapshots {
		return ModeInfo{Mode: ModePreImageOnly, Reason: "定期快照已在设置中关闭"}
	}
	s.mu.Lock()
	if c, ok := s.modeCache[ws]; ok && time.Now().Before(c.until) {
		s.mu.Unlock()
		return c.info
	}
	s.mu.Unlock()
	info := DetectMode(ws)
	s.mu.Lock()
	s.modeCache[ws] = cachedMode{info: info, until: time.Now().Add(modeCacheTTL)}
	s.mu.Unlock()
	return info
}

// DetectMode 纯判定：.git 存在 → git（超大工作区除外）；无 git 且小 → cas；否则 preimage。
func DetectMode(ws string) ModeInfo {
	if ws == "" {
		return ModeInfo{Mode: ModePreImageOnly, Reason: "无工作区"}
	}
	if _, err := os.Stat(filepath.Join(ws, ".git")); err == nil {
		stats := walkStats(ws)
		if stats.sampled || stats.bytes > gitMaxBytes {
			return ModeInfo{Mode: ModePreImageOnly, Reason: fmt.Sprintf("工作区体积超出快照上限（约 %d MB 或判定超预算）", gitMaxBytes>>20)}
		}
		return ModeInfo{Mode: ModeGitSnapshots, Reason: "有版本控制"}
	}
	stats := walkStats(ws)
	if stats.sampled {
		return ModeInfo{Mode: ModePreImageOnly, Reason: "体积判定超预算，视为超出保护阈值"}
	}
	if stats.bytes > casMaxBytes || stats.files > casMaxFiles {
		return ModeInfo{Mode: ModePreImageOnly,
			Reason: fmt.Sprintf("无版本控制且体积超过保护阈值（%d MB / %d 文件），建议 git init", casMaxBytes>>20, casMaxFiles)}
	}
	return ModeInfo{Mode: ModeCasSnapshots, Reason: "无版本控制且体积在保护阈值内"}
}

// ===== 目录与 Git 快照 =====
type walkResult struct {
	bytes   int64
	files   int
	sampled bool
}

// walkStats 全树体积统计（跳过忽略目录），预算内测完否则 sampled=true。
func walkStats(root string) walkResult {
	var out walkResult
	deadline := time.Now().Add(fingerprintWallBudget)
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && skipFingerprintDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		out.files++
		if info, err := d.Info(); err == nil {
			out.bytes += info.Size()
		}
		if out.files > fingerprintEntryBudget || time.Now().After(deadline) {
			out.sampled = true
			return errStopWalk
		}
		return nil
	})
	return out
}

// Mode 返回当前派生形态与理由（设置页回答「为什么没快照」）。
func (s *Service) Mode(ws string) ModeInfo { return s.detectMode(ws) }

// Snapshot 按形态派发一次快照（前端 10 分钟一拍）。
func (s *Service) Snapshot(ws string) (SnapshotResult, error) {
	if !s.current().Enabled || !s.current().Snapshots {
		return SnapshotResult{Skipped: "disabled"}, nil
	}
	info := s.detectMode(ws)
	switch info.Mode {
	case ModeGitSnapshots:
		return s.snapshotGit(ws)
	case ModeCasSnapshots:
		return s.snapshotCas(ws)
	default:
		return SnapshotResult{Mode: info.Mode, Skipped: info.Reason}, nil
	}
}

func (s *Service) snapshotDir(root string, ws string) (string, error) {
	dir := filepath.Join(root, "snapshots", WorkspaceKey(ws))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// snapshotGit git 管道：GIT_INDEX_FILE 临时 index + add -A + write-tree + archive。
// write-tree 会在 .git/objects 留无引用对象（git gc 自然回收，无害）；tar 自足、还原不需 .git。
// add -A 对「单个无法索引的文件」（保留设备名/权限/被锁）按 pathspec exclude 跳过并重试，
// 不再让一枚坏文件放弃整张快照（2026-11-21 frontend\nul 连败 13 轮的教训）；跳过清单
// 写日志并放进 SnapshotResult.Excluded 由前端升级为用户可见提示。
func (s *Service) snapshotGit(ws string) (SnapshotResult, error) {
	root, err := s.ensureRoot()
	if err != nil {
		return SnapshotResult{}, err
	}
	if _, err := lookGit(); err != nil {
		return SnapshotResult{}, err
	}
	dir, err := s.snapshotDir(root, ws)
	if err != nil {
		return SnapshotResult{}, err
	}
	ts := time.Now().Format("20060102-150405")
	tarPath := filepath.Join(dir, ts+".tar")
	// 临时 index 放系统 TEMP 且**不预创建**：① 保护圈内的文件会被 git 写完 unlink .lock
	// 时撞上 deny-delete；② git 认为预先存在的 0 字节 index 文件非法（实测 index file
	// smaller than expected），路径不存在时 git 自己建才对。
	tmpIndex := filepath.Join(os.TempDir(), fmt.Sprintf("cadt-wipeguard-index-%d-%s", os.Getpid(), ts))
	defer os.Remove(tmpIndex)
	env := append(os.Environ(), "GIT_INDEX_FILE="+tmpIndex)
	addRun := func(args []string) ([]byte, error) {
		cmd := execCommand("git", args...)
		cmd.Dir = ws
		cmd.Env = env
		return cmd.CombinedOutput()
	}
	excluded, err := gitAddAllWith(addRun)
	if err != nil {
		return SnapshotResult{}, err
	}
	treeOut, err := func() (string, error) {
		cmd := execCommand("git", "-C", ws, "write-tree")
		cmd.Env = env
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("git write-tree: %v: %s", err, string(out))
		}
		return strings.TrimSpace(string(out)), nil
	}()
	if err != nil {
		return SnapshotResult{}, err
	}
	cmd := execCommand("git", "-C", ws, "archive", "--format=tar", treeOut, "-o", tarPath)
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		return SnapshotResult{}, fmt.Errorf("git archive: %v: %s", err, string(out))
	}
	info, err := os.Stat(tarPath)
	if err != nil {
		return SnapshotResult{}, err
	}
	excludedNote := ""
	if len(excluded) > 0 {
		s.logf("warn", "快照跳过 %d 个无法索引的文件（不进本张 tar）：%s", len(excluded), strings.Join(excluded, ", "))
		shown := excluded
		if len(shown) > 8 {
			shown = append(append([]string{}, shown[:8]...), fmt.Sprintf("…等共 %d 个", len(excluded)))
		}
		excludedNote = strings.Join(shown, ", ")
	}
	s.pruneSnapshots(root, dir)
	return SnapshotResult{Mode: ModeGitSnapshots, Name: filepath.Base(tarPath), Path: tarPath,
		Bytes: info.Size(), Files: -1, Excluded: excludedNote}, nil
}

// addRetryRounds add -A 的排除重试上限：每轮至少消化一个新 Culprit，8 轮足够覆盖
// 「一批保留名/无权限文件」的正常场景；超限说明问题面太大，按失败处理（不让快照悄悄缺很多文件）。
const addRetryRounds = 8

// ===== Git 索引操作 =====
// gitAddAllWith 执行 `git add -A`（add 闭包收到附加了 excludes 的完整参数）。
// 单个无法索引的文件（保留设备名 / 无权限 / 被锁）解析自 git stderr，用
// `:(exclude)路径` pathspec 跳过后重试——一枚坏文件不再放弃整张快照。
// 没有新 Culprit 的失败（锁冲突 / 仓库损坏等）按原样失败；排除重试超限也按失败处理。
func gitAddAllWith(add func(args []string) ([]byte, error)) ([]string, error) {
	var excluded []string
	seen := map[string]bool{}
	for round := 0; round < addRetryRounds; round++ {
		args := []string{"add", "-A", "--"}
		for _, p := range excluded {
			args = append(args, ":(exclude)"+p)
		}
		out, err := add(args)
		if err == nil {
			return excluded, nil
		}
		fresh := false
		for _, p := range parseUnindexable(out) {
			if !seen[p] {
				seen[p] = true
				excluded = append(excluded, p)
				fresh = true
			}
		}
		if !fresh {
			return nil, fmt.Errorf("git add -A: %v: %s", err, compactGitOutput(out))
		}
	}
	return nil, fmt.Errorf("git add -A: 无法索引的文件超过 %d 轮重试上限（%d 个已排除）", addRetryRounds, len(excluded))
}

var (
	reOpenErr   = regexp.MustCompile(`error: open\("(.+)"\):`)
	reUnableErr = regexp.MustCompile(`error: unable to index file (.+)$`)
)

// parseUnindexable 从 git add 的合并输出里解析「无法索引的文件」相对路径（按首次出现序去重）。
// git 对含特殊字符的路径走 C 引号（如 "\346\265\213.txt"），unquoteGitPath 还原。
func parseUnindexable(out []byte) []string {
	var paths []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		var quoted string
		if m := reOpenErr.FindStringSubmatch(line); m != nil {
			quoted = m[1]
		} else if m := reUnableErr.FindStringSubmatch(line); m != nil {
			quoted = m[1]
		} else {
			continue
		}
		p := unquoteGitPath(quoted)
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		paths = append(paths, p)
	}
	return paths
}

// unquoteGitPath 还原 git 的路径引用：双引号形态解码 \nnn 八进制转义（UTF-8 字节），
// 单引号形态（git 错误行对无特殊字符路径的包裹）只去引号。
func unquoteGitPath(p string) string {
	p = strings.TrimSpace(p)
	if len(p) >= 2 && (strings.HasPrefix(p, `"`) || strings.HasPrefix(p, `'`)) && p[len(p)-1] == p[0] {
		inner := p[1 : len(p)-1]
		if p[0] == '"' {
			if out, err := strconv.Unquote(`"` + inner + `"`); err == nil {
				return out
			}
		}
		return inner
	}
	return p
}

// compactGitOutput 收敛 git 输出给日志/错误用：丢 warning 行（CRLF 提示一屏都是它）与空行，
// 超长截断——2026-11-21 的快照失败日志一条就是 4KB，全是 CRLF warning。
func compactGitOutput(out []byte) string {
	var keep []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "warning:") {
			continue
		}
		keep = append(keep, line)
	}
	s := strings.Join(keep, "\n")
	if len(s) > 2048 {
		s = s[:2048] + "…"
	}
	return s
}

// ===== CAS 内容寻址快照 =====
// manifestEntry 增量 CAS 快照的条目（mtime 快速路径 + blob 指针）。
type manifestEntry struct {
	Rel   string `json:"rel"`
	Blob  string `json:"blob"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

type casManifest struct {
	At      int64           `json:"at"`
	Mode    string          `json:"mode"` // "cas"
	Entries []manifestEntry `json:"entries"`
}

// snapshotCas 无 git 小工作区：与上一份 manifest 按 rel+size+mtime 快速路径 diff，
// 只对变更文件算哈希、存 blob（与 L1 同一个 objects/），manifest 原子落盘。
func (s *Service) snapshotCas(ws string) (SnapshotResult, error) {
	root, err := s.ensureRoot()
	if err != nil {
		return SnapshotResult{}, err
	}
	dir, err := s.snapshotDir(root, ws)
	if err != nil {
		return SnapshotResult{}, err
	}
	prev := readLatestManifest(dir)

	prevByKey := map[string]manifestEntry{}
	if prev != nil {
		for _, e := range prev.Entries {
			prevByKey[e.Rel] = e
		}
	}
	now := time.Now()
	manifest := casManifest{At: now.UnixMilli(), Mode: "cas", Entries: []manifestEntry{}}
	skippedFiles := 0
	_ = filepath.WalkDir(ws, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != ws && skipFingerprintDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel := filepath.ToSlash(strings.TrimPrefix(strings.TrimPrefix(path, ws), string(filepath.Separator)))
		old, known := prevByKey[rel]
		if known && old.Size == info.Size() && old.Mtime == info.ModTime().UnixMilli() {
			manifest.Entries = append(manifest.Entries, old) // 未变：指针直接沿用（去重）
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			skippedFiles++ // 竞态删除 / 不可读（保留名、权限、被锁）：跳过该文件
			return nil
		}
		if len(data) > backupMaxBytes {
			skippedFiles++ // 超大文件不进 CAS（口径与 L1 一致）
			return nil
		}
		if err := s.storeBlobBytes(root, data); err != nil {
			skippedFiles++
			return nil
		}
		sum := sha256Of(data)
		manifest.Entries = append(manifest.Entries, manifestEntry{
			Rel: rel, Blob: sum, Size: info.Size(), Mtime: info.ModTime().UnixMilli()})
		return nil
	})
	if skippedFiles > 0 {
		s.logf("warn", "CAS 快照跳过 %d 个无法读取/超限的文件（不进本份 manifest）", skippedFiles)
	}
	name := now.Format("20060102-150405") + ".manifest.json"
	path := filepath.Join(dir, name)
	buf, err := jsonMarshalIndent(manifest)
	if err != nil {
		return SnapshotResult{}, err
	}
	// manifest 直写（不用 temp+rename）：DC deny 会拒掉保护树内的 rename（见 backup.go
	// writeBlob 注释）。manifest 名带秒级时间戳，同秒重写是 O_TRUNC 截断，无原子性损失。
	mf, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return SnapshotResult{}, err
	}
	_, werr := mf.Write(buf)
	if werr == nil {
		werr = mf.Sync()
	}
	cerr := mf.Close()
	if werr != nil {
		return SnapshotResult{}, werr
	}
	if cerr != nil {
		return SnapshotResult{}, cerr
	}
	s.pruneSnapshots(root, dir)
	excludedNote := ""
	if skippedFiles > 0 {
		excludedNote = fmt.Sprintf("%d 个文件无法读取或超限，未进本份 manifest", skippedFiles)
	}
	return SnapshotResult{Mode: ModeCasSnapshots, Name: name, Path: path,
		Files: len(manifest.Entries), Bytes: int64(len(buf)), Excluded: excludedNote}, nil
}

// storeBlobBytes 按 sha256 内容寻址落盘（与 L1 writeBlob 同库；已存在即复用）。
func (s *Service) storeBlobBytes(root string, data []byte) error {
	sum := sha256Of(data)
	return s.writeBlob(root, sum, data)
}

// ===== 快照列表与恢复 =====
// readLatestManifest 读 snapshots/<ws>/ 下最新一份 CAS manifest（没有 / 损坏返回 nil）。
func readLatestManifest(dir string) *casManifest {
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	best, bestAt := "", int64(0)
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".manifest.json") {
			continue
		}
		if info, err := f.Info(); err == nil && info.ModTime().UnixMilli() > bestAt {
			best, bestAt = f.Name(), info.ModTime().UnixMilli()
		}
	}
	if best == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, best))
	if err != nil {
		return nil
	}
	var m casManifest
	if jsonUnmarshal(raw, &m) != nil {
		return nil
	}
	return &m
}

// SnapshotList 列出某工作区的快照（正序）。
func (s *Service) SnapshotList(ws string) ([]SnapshotEntry, error) {
	root, err := s.ensureRoot()
	if err != nil {
		return nil, err
	}
	dir, err := s.snapshotDir(root, ws)
	if err != nil {
		return nil, err
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return []SnapshotEntry{}, nil
	}
	out := make([]SnapshotEntry, 0, len(files))
	for _, f := range files {
		kind := ""
		if strings.HasSuffix(f.Name(), ".tar") {
			kind = "tar"
		} else if strings.HasSuffix(f.Name(), ".manifest.json") {
			kind = "manifest"
		} else {
			continue
		}
		info, err := f.Info()
		if err != nil {
			continue
		}
		out = append(out, SnapshotEntry{Name: f.Name(), Kind: kind, At: info.ModTime().UnixMilli(), Bytes: info.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out, nil
}

// SnapshotRestore 把快照内容写回工作区（用户手动 + danger 确认，方案 §6.1 / §6.2）。
func (s *Service) SnapshotRestore(ws, name string) (string, error) {
	if ws == "" {
		return "", fmt.Errorf("缺少工作区根，拒绝恢复")
	}
	if strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		return "", fmt.Errorf("快照名非法：%s", name)
	}
	root, err := s.ensureRoot()
	if err != nil {
		return "", err
	}
	path := filepath.Join(root, "snapshots", WorkspaceKey(ws), name)
	switch {
	case strings.HasSuffix(name, ".tar"):
		if err := extractTarSafe(path, ws); err != nil {
			return "", err
		}
	case strings.HasSuffix(name, ".manifest.json"):
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		var m casManifest
		if err := jsonUnmarshal(raw, &m); err != nil {
			return "", err
		}
		for _, e := range m.Entries {
			if e.Blob == "" {
				continue
			}
			abs := filepath.Join(ws, filepath.FromSlash(e.Rel))
			if !withinDir(ws, abs) {
				return "", fmt.Errorf("manifest 目标路径越界（%s），拒绝恢复", e.Rel)
			}
			data, err := os.ReadFile(filepath.Join(root, "objects", e.Blob[:2], e.Blob))
			if err != nil {
				return "", fmt.Errorf("blob 读取失败（%s）：%w", e.Rel, err)
			}
			if err := atomfile.WriteFileAtomic(abs, data); err != nil {
				return "", err
			}
		}
	default:
		return "", fmt.Errorf("未知快照类型：%s", name)
	}
	s.logf("info", "快照已还原：%s → %s", name, WorkspaceKey(ws))
	return path, nil
}

// ===== 安全解包与清理 =====
// extractTarSafe 解 tar 包覆盖工作区：拒绝绝对路径与 .. 穿越，文件走 atomfile。
func extractTarSafe(tarPath, ws string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()
	tr := tar.NewReader(f)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := hdr.Name // tar 内恒为正斜杠
		if strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
			return fmt.Errorf("tar 内出现越界路径（%s），终止恢复", name)
		}
		abs := filepath.Join(ws, filepath.FromSlash(name))
		if !withinDir(ws, abs) {
			return fmt.Errorf("tar 内路径越界（%s），终止恢复", name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			_ = os.MkdirAll(abs, 0o755)
		case tar.TypeReg:
			data, err := io.ReadAll(tr)
			if err != nil {
				return err
			}
			if err := atomfile.WriteFileAtomic(abs, data); err != nil {
				return err
			}
		default:
			// 链接 / 设备等：快照场景不存在（archive 自工作区树），忽略
		}
	}
}

// pruneSnapshots staggered 保留 + 总量上限。摘 ACL 必须在**备份根**（deny ACE 的源头，
// 继承 ACE 只能在源头摘掉），不是快照子目录。
func (s *Service) pruneSnapshots(root, dir string) {
	files, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	entries := make([]SnapshotEntry, 0, len(files))
	for _, f := range files {
		if info, err := f.Info(); err == nil {
			entries = append(entries, SnapshotEntry{Name: f.Name(), At: info.ModTime().UnixMilli(), Bytes: info.Size()})
		}
	}
	keep := pruneStaggered(entries, time.Now(), snapshotTotalCap)
	if len(keep) == len(entries) {
		return
	}
	if err := unprotectRoot(root); err != nil {
		s.logf("warn", "快照清理前摘 ACL 失败：%v", err)
		return
	}
	dropped := 0
	for _, e := range entries {
		if !keep[e.Name] {
			if err := os.Remove(filepath.Join(dir, e.Name)); err == nil {
				dropped++
			}
		}
	}
	// 删掉 manifest 后它独占的 blob 就没人引用了，顺手回收一次：否则这些 blob
	// 要等到下一次 L1 清理才可能被扫到，期间白占空间；反向也保证误删不可能——
	// 引用集同时覆盖 L1 索引与剩余 manifest（见 referencedBlobs）。
	gcOrphanBlobs(filepath.Join(root, "objects"), referencedBlobs(root, readIndex(root)))
	if err := protectRoot(root); err != nil {
		s.logf("warn", "快照清理后重套 ACL 失败：%v", err)
	}
	s.logf("info", "快照清理完成：删 %d 份，保留 %d 份", dropped, len(keep))
}

// pruneStaggered 的纯函数：最近 1 小时内 ≥5 分钟间隔全留 → 每天保最新 1 份（保 7 天）→
// 每周保最新 1 份（保 4 周）→ 更旧全删；总量超上限从最旧开始丢。返回应保留的文件名集合。
func pruneStaggered(entries []SnapshotEntry, now time.Time, totalCap int64) map[string]bool {
	sorted := make([]SnapshotEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].At < sorted[j].At })
	keepNames := make(map[string]bool, len(sorted))
	hourBucket := map[int64]string{} // 最近 1h：5 分钟一桶，保最新
	dayBucket := map[int64]string{}  // 1h–7d：天一桶
	weekBucket := map[int64]string{} // 7d–28d：周一桶
	var total int64
	for _, e := range sorted {
		age := now.Sub(time.UnixMilli(e.At))
		switch {
		case age <= time.Hour:
			// 5 分钟一桶，保桶内最新（手动连续触发也只留 5 分钟粒度）
			bucket := e.At / (5 * 60 * 1000)
			if old, ok := hourBucket[bucket]; ok {
				delete(keepNames, old)
			}
			hourBucket[bucket] = e.Name
			keepNames[e.Name] = true
		case age <= 7*24*time.Hour:
			day := e.At / (24 * 60 * 60 * 1000)
			if old, ok := dayBucket[day]; ok {
				delete(keepNames, old) // 只留当天最新
			}
			dayBucket[day] = e.Name
			keepNames[e.Name] = true
		case age <= 28*24*time.Hour:
			week := e.At / (7 * 24 * 60 * 60 * 1000)
			if old, ok := weekBucket[week]; ok {
				delete(keepNames, old)
			}
			weekBucket[week] = e.Name
			keepNames[e.Name] = true
		default:
			// 更旧：不保留
		}
		total += e.Bytes
	}
	// 重算总量（只算保留的），超上限从最旧开始丢
	byName := map[string]SnapshotEntry{}
	for _, e := range sorted {
		byName[e.Name] = e
	}
	total = 0
	for name := range keepNames {
		total += byName[name].Bytes
	}
	for _, e := range sorted {
		if total <= totalCap {
			break
		}
		if keepNames[e.Name] {
			delete(keepNames, e.Name)
			total -= e.Bytes
		}
	}
	return keepNames
}
