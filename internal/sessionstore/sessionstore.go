// Package sessionstore：AI 会话磁盘存储引擎——每个会话一个目录，正文为追加式 JSONL，
// 元数据为原子替换的 meta.json。AppDataDir 由宿主（main）注入。
package sessionstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/recycle"
	"datalens/internal/resourcelease"
	"datalens/internal/sessionlock"
)

// AI 会话磁盘存储：每个会话一个目录，正文为追加式 JSONL，元数据为原子替换的 meta.json。
// 平铺布局（New）： <root>/<id>/{meta.json,session.v1.jsonl,images/,videos/}
// 分桶布局（NewBucketed）：工作区短哈希作父目录——<root>/<ws8>/<id>/...，
// 桶名规则见 WorkspaceBucketKey；aigroups 复用同一引擎按 groupId 平铺，桶化必须 opt-in。
const (
	SessionsDirName   = "ai-sessions"
	aiSessionMetaName = "meta.json"
	aiSessionLogName  = "session.v1.jsonl"
	ImagesDir         = "images"
	VideosDir         = "videos"
	aiSessionLockName = ".session.lock"
	aiSessionLockWait = 5 * time.Second
	// 单会话正文上限（256 MB，2026-11-22 由 64 MB 扩限并语义反转，方案 §5.2 S2）：
	// 实测 180 MB 整份读入+重放仅 ~450 ms / 峰值 544 MB，64 MB 是未经测量的保守防线。
	// 超过它不再「拒绝服务」——前端 loadOne 捕获 session-too-large: 前缀后自动触发
	// AISessionVacuum 整理并重试，对话永不因体积被阻断。256 MB 也是加载内存峰值的
	// 硬拒线（外推 ~800 MB RSS，逼近渲染进程舒适区边缘），不再上调。
	aiSessionReadLimit = 256 << 20
	aiSessionMetaLimit = 1 << 20
	aiSessionIDMax     = 128
	aiSessionImageMax  = 120
	aiSessionVideoMax  = 40

	// 无工作区会话的桶名（_ 开头与 8 hex 哈希桶名天然区分）。
	UnboundBucketName = "_unbound"
	// 桶内说明文件：记录该桶对应的工作区路径（哈希目录名在资源管理器里不可读）。
	bucketInfoName = "ws.json"

	// 锁文件放在被保护目录之外：会话目录被删除/移走时锁仍然有效。
	sessionLockDirName = ".locks"
	sessionLeaseSuffix = ".turn.lease"
	rootGateSuffix     = ".gate"
)

// ErrSessionBusy 表示会话正被另一个窗口（或根门闩的销毁操作）占用。
// 前端按字符串前缀 session-busy: 识别；Wails 绑定只返回 error 文本。
var ErrSessionBusy = errors.New("session-busy: 会话正在另一窗口运行")

// ErrSessionGone 表示会话已被另一个窗口删除。写路径见到它只跳过/放弃，
// 绝不通过 MkdirAll 把目录重建出来。
var ErrSessionGone = errors.New("session-gone: 会话已被删除")

// ===== 存储结构与工作区分桶 =====
type Store struct {
	Root     string
	DeleteFn func(string) error
	// bucketed=true 时会话目录按工作区短哈希分桶（仅 ai-sessions 用；aigroups 保持平铺）。
	bucketed bool
	// readLimitOverride 单会话正文读取上限的测试覆盖（0 = 用 aiSessionReadLimit 常量），
	// 让 vacuum/liveDominant/超限前缀测试不必写 256MB 级夹具。
	readLimitOverride int64
}

// bodyReadLimit 单会话正文读取上限（Read 拒载、Vacuum 阈值与 liveDominant 共用同一把尺）。
func (s *Store) bodyReadLimit() int64 {
	if s.readLimitOverride > 0 {
		return s.readLimitOverride
	}
	return aiSessionReadLimit
}

// 同进程内所有 App 方法各建一个 store，追加互斥必须是包级的。
var appendMu sync.Mutex

func New(root string) *Store {
	return &Store{Root: root, DeleteFn: recycle.Move}
}

// NewBucketed 启用工作区分桶布局：<root>/<ws8>/<id>/。桶归属以 meta.workspace 为
// 真源，桶名只是磁盘布局；查找按 id 扫桶（桶数 = 工作区数，个位/十位）。
func NewBucketed(root string) *Store {
	return &Store{Root: root, DeleteFn: recycle.Move, bucketed: true}
}

// 工作区路径归一的两条正则，语义与前端 aiNormalizePath（ai-panel.js）对齐。
var (
	wsSchemeRe = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*)://`)
	wsDriveRe  = regexp.MustCompile(`^[A-Za-z]:`)
)

// normalizeWorkspacePath 与前端 aiNormalizePath 语义一致：反斜杠归一为正斜杠、
// 叠斜杠与 . / .. 段清理、协议或盘符前缀保留、去首段绝对斜杠标记。
func normalizeWorkspacePath(value string) string {
	raw := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if raw == "" {
		return ""
	}
	prefix := ""
	rest := raw
	if m := wsSchemeRe.FindStringSubmatch(raw); m != nil {
		prefix = m[1] + "://"
		rest = raw[len(m[0]):]
	} else if m := wsDriveRe.FindString(raw); m != "" {
		prefix = m
		rest = raw[len(m):]
	}
	absolute := strings.HasPrefix(rest, "/")
	parts := make([]string, 0, 8)
	for _, seg := range strings.Split(rest, "/") {
		switch {
		case seg == "" || seg == ".":
		case seg == "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, seg)
		}
	}
	joined := strings.Join(parts, "/")
	if absolute {
		joined = "/" + joined
	}
	return prefix + joined
}

// WorkspaceBucketKey 把工作区路径映射成桶名：归一化 key（与前端 aiWorkspaceKey 一致：
// 去首尾空白 → 归一路径 → 去尾斜杠 → 小写）的 sha256 前 8 hex；无工作区落 _unbound。
// 8 hex 的碰撞后果仅是磁盘混桶（meta.workspace 仍为归属真源），桌面工作区量级下接受。
func WorkspaceBucketKey(workspace string) string {
	key := strings.ToLower(strings.TrimRight(normalizeWorkspacePath(strings.TrimSpace(workspace)), "/"))
	if key == "" {
		return UnboundBucketName
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:4])
}

// isBucketDirName 桶目录名：8 hex 短哈希或 _unbound。List/查找据此区分桶与杂物。
func isBucketDirName(name string) bool {
	if name == UnboundBucketName {
		return true
	}
	if len(name) != 8 {
		return false
	}
	for _, ch := range name {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}

// AppDataDir 宿主注入：应用数据根目录（main/appdata.go 的 appDataRoot）。
var AppDataDir func() string

func Default() (*Store, error) {
	if AppDataDir == nil {
		return nil, errors.New("会话存储未注入应用数据目录")
	}
	base := AppDataDir()
	if base == "" {
		return nil, appdata.ErrNoRoot
	}
	return NewBucketed(filepath.Join(base, SessionsDirName)), nil
}

// ===== 路径与 ID 校验 =====
// ValidSessionID 限制会话 id 可安全拼进路径：不含分隔符、不以点开头、不是 . / ..。
func ValidSessionID(id string) bool {
	if id == "" || len(id) > aiSessionIDMax || id[0] == '.' {
		return false
	}
	if isWindowsReservedName(id) {
		return false
	}
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

// isWindowsReservedName 拒绝 CON/NUL/COM1 等设备名（带扩展名同样被系统占用）。
func isWindowsReservedName(name string) bool {
	base := strings.ToUpper(strings.TrimSuffix(name, filepath.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) {
		return base[3] >= '1' && base[3] <= '9'
	}
	return false
}

func (s *Store) EnsureRoot() error {
	if s.Root == "" {
		return errors.New("会话存储目录为空")
	}
	return os.MkdirAll(s.Root, 0o755)
}

func (s *Store) sessionDir(id string) (string, error) {
	if !ValidSessionID(id) {
		return "", fmt.Errorf("非法会话 id：%q", id)
	}
	if s.Root == "" {
		return "", errors.New("会话存储目录为空")
	}
	if !s.bucketed {
		return filepath.Join(s.Root, id), nil
	}
	return s.resolveBucketedDir(id)
}

// BodyPath 返回会话正文 JSONL 的磁盘绝对路径（诊断 / 前端「复制会话路径」用）。
// 只读解析：桶化模式按 id 扫桶定位现存目录，平铺模式补一次存在性检查；
// 找不到一律 ErrSessionGone，绝不创建目录复活已删除会话。
func (s *Store) BodyPath(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
		}
		return "", err
	}
	if !s.bucketed {
		if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
			return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
		}
	}
	return filepath.Join(dir, aiSessionLogName), nil
}

// resolveBucketedDir 桶化模式下按 id 扫桶定位会话目录。桶数 = 工作区数（个位/十位），
// 每桶一次 Stat，代价可忽略；找不到返回 os.ErrNotExist，由调用方决定语义。
func (s *Store) resolveBucketedDir(id string) (string, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isBucketDirName(entry.Name()) {
			continue
		}
		candidate := filepath.Join(s.Root, entry.Name(), id)
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			return candidate, nil
		}
	}
	return "", os.ErrNotExist
}

// ResolveSessionWorkspace 按会话 id 定位目录并读 meta 的 workspace（桶归属真源，
// 见 NewBucketed 注释）。CLI --ai-session 转发（根包 secondInstancePlan）用它把
// 会话路由到归属工作区的窗口。meta 缺失/损坏时 sessionMetaRaw 会从正文 header
// 兜底。非创建路径：找不到一律 ErrSessionGone，绝不 MkdirAll 复活已删除会话。
func (s *Store) ResolveSessionWorkspace(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || !ValidSessionID(id) {
		return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
	}
	var dir string
	if s.bucketed {
		resolved, err := s.resolveBucketedDir(id)
		if err != nil {
			return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
		}
		dir = resolved
	} else {
		candidate := filepath.Join(s.Root, id)
		if info, statErr := os.Stat(candidate); statErr != nil || !info.IsDir() {
			return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
		}
		dir = candidate
	}
	raw := s.sessionMetaRaw(dir, id)
	if len(raw) == 0 {
		return "", fmt.Errorf("%w（meta 缺失）：%s", ErrSessionGone, id)
	}
	var meta struct {
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return "", fmt.Errorf("会话 meta 解析失败：%s: %v", id, err)
	}
	if ws := strings.TrimSpace(meta.Workspace); ws != "" {
		return ws, nil
	}
	return "", fmt.Errorf("会话无归属工作区：%s", id)
}

// ===== 目录与租约锁 =====
// ensureBucketDir 取工作区对应的桶目录，必要时创建并写 ws.json 说明文件。
func (s *Store) ensureBucketDir(workspace string) (string, error) {
	name := WorkspaceBucketKey(workspace)
	dir := filepath.Join(s.Root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建会话桶目录失败：%w", err)
	}
	// ws.json 是桶的说明文件（资源管理器可读、迁移核对用），尽力而为：
	// 写失败不影响会话落位，忽略该错误。
	if trimmed := strings.TrimSpace(workspace); trimmed != "" {
		if raw, err := json.Marshal(map[string]string{"workspace": trimmed}); err == nil {
			_ = atomfile.WriteFileAtomic(filepath.Join(dir, bucketInfoName), raw)
		}
	}
	return dir, nil
}

// lockSessionDir 在根共享 + 会话独占租约之下解析会话目录：
//   - 桶化模式先扫桶找现存目录（已在的目录永远赢，附件先落盘/重建兜底都靠它）；
//   - allowCreate 且找不到时按 workspace 派生桶落位（新会话）；
//   - 非创建路径找不到一律 ErrSessionGone，绝不 MkdirAll 复活已删除会话。
func (s *Store) lockSessionDir(id, workspace string, allowCreate bool) (string, error) {
	if !s.bucketed {
		dir := filepath.Join(s.Root, id)
		if allowCreate {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return "", fmt.Errorf("创建会话目录失败：%w", err)
			}
			return dir, nil
		}
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
		}
		return dir, nil
	}
	if dir, err := s.resolveBucketedDir(id); err == nil {
		return dir, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if !allowCreate {
		return "", fmt.Errorf("%w：%s", ErrSessionGone, id)
	}
	bucket, err := s.ensureBucketDir(workspace)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(bucket, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建会话目录失败：%w", err)
	}
	return dir, nil
}

func (s *Store) ensureSessionDir(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	if err := s.EnsureRoot(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建会话目录失败：%w", err)
	}
	return dir, nil
}

// RootGatePath 返回 Store 根的门闩路径（与根目录同级，根被改名/移动时不失效）。
// 回合/写路径持共享，DeleteAll/存储清理持独占。
func (s *Store) RootGatePath() string {
	if s.Root == "" {
		return ""
	}
	return s.Root + rootGateSuffix
}

// LeasePath 返回会话回合租约路径；id 走 ValidSessionID 校验。
// 锁放在 <root>/.locks/ 而不是会话目录里：删掉会话目录不会把锁一起删掉，
// 同 id 重建仍会撞同一把锁。
func (s *Store) LeasePath(id string) (string, error) {
	if !ValidSessionID(id) {
		return "", fmt.Errorf("非法会话 id：%q", id)
	}
	if s.Root == "" {
		return "", errors.New("会话存储目录为空")
	}
	return filepath.Join(s.Root, sessionLockDirName, id+sessionLeaseSuffix), nil
}

// wrapLeaseErr 把 resourcelease 的 busy 统一成 ErrSessionBusy（带 owner PID）。
func wrapLeaseErr(err error) error {
	if err == nil {
		return nil
	}
	if resourcelease.IsBusy(err) {
		owner := resourcelease.BusyOwner(err)
		if owner.PID > 0 {
			return fmt.Errorf("%w（PID %d）", ErrSessionBusy, owner.PID)
		}
		return ErrSessionBusy
	}
	return fmt.Errorf("获取会话写权失败：%w", err)
}

// withSessionLock 按固定层级取锁：根共享 -> 会话独占 -> .session.lock。
//
// 读取不加锁；只有追加/整份重写/写 meta/图片视频落盘这类写操作需要。
// workspace 只在桶化 + allowCreate 且目录尚不存在时用于派生桶（新会话落位）；
// 现存目录永远按 id 扫桶定位，workspace 不参与。allowCreate=true 只给“新建会话
// 首次落 header”与附件先落盘用；其它写路径在目录/墓碑缺失时一律返回 ErrSessionGone，
// 避免另一窗口的扇出写把已删除会话复活。
func (s *Store) withSessionLock(id, workspace string, allowCreate bool, fn func(dir string) error) error {
	if !ValidSessionID(id) {
		return fmt.Errorf("非法会话 id：%q", id)
	}
	if err := s.EnsureRoot(); err != nil {
		return err
	}
	rootLease, err := resourcelease.AcquireShared(s.RootGatePath())
	if err != nil {
		return wrapLeaseErr(err)
	}
	defer rootLease.Release()
	leasePath, err := s.LeasePath(id)
	if err != nil {
		return err
	}
	sessionLease, err := resourcelease.Acquire(leasePath, resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "session-write",
	})
	if err != nil {
		return wrapLeaseErr(err)
	}
	defer sessionLease.Release()
	if s.gone(id) {
		return fmt.Errorf("%w：%s", ErrSessionGone, id)
	}
	dir, err := s.lockSessionDir(id, workspace, allowCreate)
	if err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(dir, aiSessionLockName), aiSessionLockWait)
	if err != nil {
		return fmt.Errorf("会话正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()
	return fn(dir)
}

// ===== 墓碑与日志路径 =====
// tombstonePath 删除墓碑放在 .locks/ 而不是会话目录里：删目录不会把墓碑一起删掉，
// 同 id 的扇出写会一直看到“已删除”。
func (s *Store) tombstonePath(id string) (string, error) {
	leasePath, err := s.LeasePath(id)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(leasePath, sessionLeaseSuffix) + ".deleted", nil
}

func (s *Store) gone(id string) bool {
	path, err := s.tombstonePath(id)
	if err != nil {
		return false
	}
	_, statErr := os.Stat(path)
	return statErr == nil
}

func (s *Store) markGone(id string) error {
	path, err := s.tombstonePath(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return atomfile.WriteFileAtomic(path, []byte("1"))
}

func (s *Store) logPath(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, aiSessionLogName), nil
}

// ===== 图片与视频路径 =====
func validSessionImageName(name string) bool {
	if name == "" || len(name) > aiSessionImageMax || name[0] == '.' {
		return false
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
		// .mp4 是会话视频（VideoPath）的扩展名，与图片共用同一个文件名校验。
	case ".mp4":
	default:
		return false
	}
	if isWindowsReservedName(name) {
		return false
	}
	for _, ch := range name {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

func (s *Store) ImagePath(id, name string) (string, error) {
	if !validSessionImageName(name) {
		return "", fmt.Errorf("非法图片名：%q", name)
	}
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, ImagesDir, name), nil
}

// VideoPath 与 ImagePath 同构：会话视频落 videos/ 子目录（存储清理按整个 ai-sessions/ 统计，无需单列）。
func (s *Store) VideoPath(id, name string) (string, error) {
	if !validSessionImageName(name) {
		return "", fmt.Errorf("非法视频名：%q", name)
	}
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, VideosDir, name), nil
}

// ===== 会话列表与读写 =====
// list 只读各会话的 meta.json，不触碰正文；meta 缺失/损坏时用正文 header 兜底。
func (s *Store) List() ([]string, error) {
	if err := s.EnsureRoot(); err != nil {
		return nil, err
	}
	if !s.bucketed {
		entries, err := os.ReadDir(s.Root)
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(entries))
		for _, entry := range entries {
			if !entry.IsDir() || !ValidSessionID(entry.Name()) {
				continue
			}
			raw := s.sessionMetaRaw(filepath.Join(s.Root, entry.Name()), entry.Name())
			if len(raw) == 0 {
				continue
			}
			out = append(out, string(raw))
		}
		return out, nil
	}
	// 桶化布局：根层是工作区桶（8 hex / _unbound），会话目录在桶内一层。
	buckets, err := os.ReadDir(s.Root)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, 64)
	for _, bucket := range buckets {
		if !bucket.IsDir() || !isBucketDirName(bucket.Name()) {
			continue
		}
		sessions, err := os.ReadDir(filepath.Join(s.Root, bucket.Name()))
		if err != nil {
			// 桶层读取失败只跳过该桶（另一窗口正在建/删桶的竞态），不拖垮整个列表。
			continue
		}
		for _, entry := range sessions {
			if !entry.IsDir() || !ValidSessionID(entry.Name()) {
				continue
			}
			raw := s.sessionMetaRaw(filepath.Join(s.Root, bucket.Name(), entry.Name()), entry.Name())
			if len(raw) == 0 {
				continue
			}
			out = append(out, string(raw))
		}
	}
	return out, nil
}

// sessionMetaRaw 读单个会话目录的 meta.json；meta 丢失/损坏时用正文首行 header 兜底，
// 避免整段会话从列表里消失。两者都拿不到时返回 nil。
func (s *Store) sessionMetaRaw(dir, id string) []byte {
	raw, err := os.ReadFile(filepath.Join(dir, aiSessionMetaName))
	if err != nil || len(raw) == 0 || len(raw) > aiSessionMetaLimit || !json.Valid(raw) {
		raw = synthesizeMetaFromHeader(filepath.Join(dir, aiSessionLogName), id)
	}
	return raw
}

// synthesizeMetaFromHeader 从正文首行 header 重建最小 meta（用于 meta 丢失/损坏的会话）。
func synthesizeMetaFromHeader(logPath, id string) []byte {
	f, err := os.Open(logPath)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n, _ := f.Read(buf)
	if n == 0 {
		return nil
	}
	line := string(buf[:n])
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var header struct {
		T         string `json:"t"`
		Title     string `json:"title"`
		CreatedAt int64  `json:"createdAt"`
		Workspace string `json:"workspace"`
	}
	if json.Unmarshal([]byte(line), &header) != nil || header.T != "header" {
		return nil
	}
	meta := map[string]any{
		"v":             1,
		"id":            id,
		"title":         header.Title,
		"createdAt":     header.CreatedAt,
		"updatedAt":     header.CreatedAt,
		"workspace":     header.Workspace,
		"scope":         "read",
		"messageCount":  0,
		"archivedCount": 0,
		"summary":       nil,
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return nil
	}
	return raw
}

func (s *Store) Read(id string) (string, error) {
	path, err := s.logPath(id)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if info.Size() > s.bodyReadLimit() {
		// 稳定错误前缀契约：前端据此分流「打开即自动整理」（不做字符串模糊匹配）。
		return "", fmt.Errorf("session-too-large: 会话正文 %d MB，超过 %d MB 上限（打开时将自动整理归档）",
			info.Size()/(1<<20), s.bodyReadLimit()/(1<<20))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// append 在文件末尾追加若干行；写入前修掉上次崩溃留下的半行，
// 写入后 fsync；失败回滚到追加前的长度，避免半批事件留在日志里。
func (s *Store) Append(id string, payload string) error {
	return s.AppendWithCreate(id, payload, true)
}

// AppendWithCreate 追加正文；allowCreate=false 时会话目录/墓碑缺失返回 ErrSessionGone。
// 前端按 session._logCreated 传入：新建会话首次落 header 才允许建目录。
func (s *Store) AppendWithCreate(id string, payload string, allowCreate bool) error {
	if payload == "" {
		return nil
	}
	if !strings.HasSuffix(payload, "\n") {
		payload += "\n"
	}
	// 新会话首次落盘的载荷以 header 开头（ai-session-disk.js 的 ensureHeaderEvent
	// / runPersistSession 保证），桶归属从 header.workspace 解析；解析不出按无工作区落 _unbound。
	workspace := ""
	if s.bucketed && allowCreate {
		workspace = workspaceFromHeader(payload)
	}
	return s.withSessionLock(id, workspace, allowCreate, func(dir string) error {
		path := filepath.Join(dir, aiSessionLogName)
		appendMu.Lock()
		defer appendMu.Unlock()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			return err
		}
		before, err := atomfile.RepairTornTail(f)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		// O_APPEND 写：多窗口并发追加也由文件系统保证写到当前末尾。
		af, err := os.OpenFile(path, os.O_RDWR|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		defer af.Close()
		if _, err := af.WriteString(payload); err != nil {
			_ = af.Truncate(before)
			return err
		}
		// 与 dsh 一致：每批落盘后再算提交；掉电最多丢这一批。
		if err := af.Sync(); err != nil {
			_ = af.Truncate(before)
			return err
		}
		return nil
	})
}

// workspaceFromHeader 取追加载荷首行 header 里的 workspace；首行不是 header 时给空
// （落 _unbound，只在载荷异常时发生，不丢数据）。
func workspaceFromHeader(payload string) string {
	line := payload
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var header struct {
		T         string `json:"t"`
		Workspace string `json:"workspace"`
	}
	if json.Unmarshal([]byte(line), &header) != nil || header.T != "header" {
		return ""
	}
	return header.Workspace
}

// ===== 改写与删除 =====
// rewrite 原子替换整个正文（迁移、清空、状态与日志不一致时的兜底）。
func (s *Store) Rewrite(id string, payload string) error {
	return s.withSessionLock(id, "", false, func(dir string) error {
		return atomfile.WriteFileAtomic(filepath.Join(dir, aiSessionLogName), []byte(payload))
	})
}

func (s *Store) WriteMeta(id string, payload string) error {
	return s.withSessionLock(id, "", false, func(dir string) error {
		return atomfile.WriteFileAtomic(filepath.Join(dir, aiSessionMetaName), []byte(payload))
	})
}

// SessionDir 返回会话目录（只校验不创建）；资源监听/存储清理用。
func (s *Store) SessionDir(id string) (string, error) {
	return s.sessionDir(id)
}

// LockRootForClear 供存储清理取会话根门闩独占；有回合/写路径持共享时直接报忙。
// 返回的 release 必须 defer 执行。
func LockRootForClear() (func(), error) {
	store, err := Default()
	if err != nil {
		return nil, err
	}
	gate, err := resourcelease.AcquireNoShare(store.RootGatePath(), resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "storage-clear",
	})
	if err != nil {
		if resourcelease.IsBusy(err) {
			if owner := resourcelease.BusyOwner(err); owner.PID > 0 {
				return nil, fmt.Errorf("%w（另一窗口 PID %d 正在运行会话）", ErrSessionBusy, owner.PID)
			}
			return nil, fmt.Errorf("%w（另一窗口正在运行会话）", ErrSessionBusy)
		}
		return nil, err
	}
	return func() { gate.Release() }, nil
}

// Remove 单个会话目录（Windows 走回收站，可撤销）。
// 删除前取根共享 + 会话独占：正在跑回合/写盘的会话删不掉。
func (s *Store) Remove(id string) error {
	dir, err := s.sessionDir(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// 桶化扫桶未命中：目录已经不在，仍然写墓碑，防止扇出写把它重建出来。
			return s.markGone(id)
		}
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			// 目录已经不在：仍然写墓碑，防止另一窗口的扇出写把它重建出来。
			return s.markGone(id)
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是会话目录：%s", dir)
	}
	if err := s.EnsureRoot(); err != nil {
		return err
	}
	rootLease, err := resourcelease.AcquireShared(s.RootGatePath())
	if err != nil {
		return wrapLeaseErr(err)
	}
	defer rootLease.Release()
	leasePath, err := s.LeasePath(id)
	if err != nil {
		return err
	}
	sessionLease, err := resourcelease.AcquireNoShare(leasePath, resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "session-delete",
	})
	if err != nil {
		return wrapLeaseErr(err)
	}
	defer sessionLease.Release()
	if err := s.deletePath(dir); err != nil {
		return err
	}
	// 删除成功后写墓碑：其它窗口基于旧内存的 Append/WriteMeta 会得到 ErrSessionGone，
	// 不会再走 MkdirAll 复活这个会话。
	return s.markGone(id)
}

// RemoveAll 清空全部会话目录（整根目录进回收站）。
//
// 取根独占 -> 把根改名成 .deleting-<ts>（原子移走）-> 释放门闩 -> 回收。
// 门闩在根目录之外，改名不会让新写者拿到“新目录的新门闩”；改名后新写者
// 只会创建新的根，不会碰旧目录。
func (s *Store) RemoveAll() error {
	if s.Root == "" {
		return errors.New("会话存储目录为空")
	}
	info, err := os.Stat(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是会话目录：%s", s.Root)
	}
	if err := s.EnsureRoot(); err != nil {
		return err
	}
	gate, err := resourcelease.AcquireNoShare(s.RootGatePath(), resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "session-delete-all",
	})
	if err != nil {
		return wrapLeaseErr(err)
	}
	defer gate.Release()
	renamed := fmt.Sprintf("%s.deleting-%d", s.Root, time.Now().UnixNano())
	if err := os.Rename(s.Root, renamed); err != nil {
		return fmt.Errorf("移走会话根目录失败：%w", err)
	}
	// 先释放门闩再做可能较慢的回收；defer 的再次 Release 是 no-op。
	gate.Release()
	return s.deletePath(renamed)
}

func (s *Store) deletePath(path string) error {
	if s.DeleteFn != nil {
		return s.DeleteFn(path)
	}
	return os.RemoveAll(path)
}
