// Package memo：快捷便签 面板的磁盘存储。工作区 <ws>/.cadt/memo/ 与全局
// <appdata>/memo/ 两个作用域各一份 memo.json（真源）+ img/ 贴图目录。
// 写入是单文件整份原子替换（atomfile），另带 mtime CAS：多窗口是多进程，
// 靠文件系统时间戳协调，冲突时让前端重载，不做合并。
// 结构级上限（块/条目/文本长度）由前端归一化统一执行，这里只卡总量与图片字节。
package memo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/resourcelease"
)

const (
	scopeWorkspace = "workspace"
	scopeGlobal    = "global"

	docLimitBytes   = 512 << 10    // memo.json 总量上限
	imageLimitBytes = 16 << 20     // 单张贴图上限，与会话附图同口径
	mtimeSlackMs    = 2000         // FAT 类文件系统秒级时间戳粒度的放宽（只对「文件更旧」方向生效）
	conflictPrefix  = "conflict: " // SaveResult.Error 前缀：冲突错误（前端据此重载）
)

// ErrBusy 表示快捷便签正被另一个窗口编辑（跨进程写权被占）。
// 前端按字符串前缀 memo-busy: 识别；SaveResult.Busy 是结构化版本。
var ErrBusy = errors.New("memo-busy: 快捷便签正在另一窗口编辑")

// imageExtByMIME 放行的贴图类型（只信魔数嗅探结果，剪贴板图片基本都是 PNG）。
var imageExtByMIME = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/gif":  "gif",
	"image/webp": "webp",
	"image/bmp":  "bmp",
}

// Deps 外部动作注入：全局作用域落在应用数据目录；OwnerForCall 从绑定 ctx 取
// 调用方窗口名（多窗口写权租约的归属者）。
type Deps struct {
	AppDataDir   func() string
	Logf         func(format string, args ...any)
	OwnerForCall func(ctx context.Context) string
}

var deps Deps

// SetDeps 注入依赖（根壳启动时调用一次）。
func SetDeps(d Deps) { deps = d }

// SaveResult 保存结果：Conflict 为真表示别的窗口先写了，前端应重载后重试；
// Busy 为真表示写权被另一个窗口持有（前端应保留 dirty，不要当冲突重载）；
// MtimeMs 是写入后文件的新修改时间，前端直接更新缓存，省一次 Load。
type SaveResult struct {
	OK       bool   `json:"ok"`
	Conflict bool   `json:"conflict,omitempty"`
	Busy     bool   `json:"busy,omitempty"`
	Error    string `json:"error,omitempty"`
	MtimeMs  int64  `json:"mtimeMs,omitempty"`
}

// LeaseStatus 是便签写权租约的获取/探测结果。
type LeaseStatus struct {
	Acquired bool                `json:"acquired"` // 本进程是否持有
	Busy     bool                `json:"busy"`     // 是否被其它进程持有
	Owner    resourcelease.Owner `json:"owner,omitempty"`
}

type memoLeaseEntry struct {
	lease *resourcelease.Lease
	// holders 写权持有者计数，按归属者（v3 = 调用方窗口名）分桶：同窗口重入
	// 计数 +1，跨窗口直接 Busy（v2 的「第二个窗口只读 + 横幅」语义——此前
	// refs 是进程内重入计数，两个主窗口都会拿到 Acquired，双写只靠 mtime CAS
	// 兜底，2026-11-21 审查第 2 项）。
	holders map[string]int
	owner   resourcelease.Owner
}

var (
	memoLeaseMu sync.Mutex
	memoLeases  = map[string]*memoLeaseEntry{}
)

// envelope Load 的返回信封：data 是 memo.json 原文，mtimeMs 用于写回时 CAS。
type envelope struct {
	Data    string `json:"data"`
	MtimeMs int64  `json:"mtimeMs"`
}

func defaultDoc() string {
	return `{"version":1,"updatedAt":0,"blocks":[]}`
}

// Load 读 memo.json。文件缺失返回空文档；坏 JSON 兜底成默认结构（不动原文件，
// 等 CAS 保存自然覆盖），避免用户手改坏后面板永远打不开。
func Load(scope, workspace string) (string, error) {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return "", err
	}
	path := docPath(root)
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return envelopeJSON(defaultDoc(), 0), nil
		}
		return "", fmt.Errorf("读取快捷便签 失败：%s", err.Error())
	}
	if info.Size() > docLimitBytes {
		return "", fmt.Errorf("快捷便签 文件超过上限（%d KB），拒绝加载", docLimitBytes>>10)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取快捷便签 失败：%s", err.Error())
	}
	data := string(raw)
	if !json.Valid(raw) {
		if deps.Logf != nil {
			deps.Logf("memo: %s 不是合法 JSON，返回默认结构（原文件未动）", path)
		}
		data = defaultDoc()
	}
	return envelopeJSON(data, info.ModTime().UnixMilli()), nil
}

// RootPath 返回作用域根目录（Worktree/资源监听用）；scope/workspace 校验与 Load/Save 共用 resolveRoot。
func RootPath(scope, workspace string) (string, error) {
	return resolveRoot(scope, workspace)
}

// LeasePath 返回作用域对应的写权租约文件路径。
// 锁文件在被保护的 memo 目录之外（<root>.lock）：目录被移动/回收时不失效，
// 新写者仍会撞同一把锁。
func LeasePath(scope, workspace string) (string, error) {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return "", err
	}
	return root + ".lock", nil
}

// AcquireLease 取便签写权（面板打开期间持有；同窗口重入走计数，跨窗口 Busy）。
// owner 是归属者（v3 = 调用方窗口名；空串 = 兼容测试的单桶语义）。
func AcquireLease(scope, workspace, label, owner string) (LeaseStatus, error) {
	path, err := LeasePath(scope, workspace)
	if err != nil {
		return LeaseStatus{}, err
	}
	ownerKey := strings.TrimSpace(owner)
	fileLabel := leaseOwnerLabel(label, ownerKey)
	memoLeaseMu.Lock()
	if entry := memoLeases[path]; entry != nil {
		// 同窗口重入：计数 +1；别的窗口已持有 → Busy（第二个窗口只读 + 横幅）。
		if _, held := entry.holders[ownerKey]; held {
			entry.holders[ownerKey]++
			st := LeaseStatus{Acquired: true, Owner: entry.owner}
			memoLeaseMu.Unlock()
			return st, nil
		}
		st := LeaseStatus{Busy: true, Owner: entry.owner}
		memoLeaseMu.Unlock()
		return st, nil
	}
	memoLeaseMu.Unlock()

	fileOwner := resourcelease.Owner{PID: os.Getpid(), Label: fileLabel}
	lease, err := resourcelease.Acquire(path, fileOwner)
	if err != nil {
		if resourcelease.IsBusy(err) {
			return LeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err)}, nil
		}
		return LeaseStatus{}, fmt.Errorf("获取快捷便签写锁失败：%w", err)
	}
	// 双检：并发 Acquire 可能已经入表；把本次多拿的 ref 还回去。
	memoLeaseMu.Lock()
	if entry := memoLeases[path]; entry != nil {
		entry.holders[ownerKey]++
		st := LeaseStatus{Acquired: true, Owner: entry.owner}
		memoLeaseMu.Unlock()
		lease.Release()
		return st, nil
	}
	memoLeases[path] = &memoLeaseEntry{
		lease:   lease,
		holders: map[string]int{ownerKey: 1},
		owner:   fileOwner,
	}
	memoLeaseMu.Unlock()
	return LeaseStatus{Acquired: true, Owner: fileOwner}, nil
}

// leaseOwnerLabel 把窗口名并进横幅 label：同进程多窗口下 PID 相同，
// 只有窗口名能区分「谁在编辑」（2026-11-21 审查第 2 项口径）。
func leaseOwnerLabel(label, owner string) string {
	label = strings.TrimSpace(label)
	if owner == "" {
		if label == "" {
			return "memo"
		}
		return label
	}
	if label == "" {
		return "窗口 " + owner
	}
	return label + " · 窗口 " + owner
}

// ReleaseLease 释放指定归属者对便签写权的引用；最后一个持有者退出才真正解锁。
func ReleaseLease(scope, workspace, owner string) error {
	path, err := LeasePath(scope, workspace)
	if err != nil {
		return err
	}
	ownerKey := strings.TrimSpace(owner)
	memoLeaseMu.Lock()
	entry := memoLeases[path]
	if entry == nil {
		memoLeaseMu.Unlock()
		return nil
	}
	if n := entry.holders[ownerKey]; n > 1 {
		entry.holders[ownerKey] = n - 1
		memoLeaseMu.Unlock()
		return nil
	}
	delete(entry.holders, ownerKey)
	if len(entry.holders) > 0 {
		memoLeaseMu.Unlock()
		return nil
	}
	delete(memoLeases, path)
	memoLeaseMu.Unlock()
	entry.lease.Release()
	return nil
}

// ReleaseLeaseByOwner 归属者（窗口）关闭时释放它名下的全部写权引用；
// 最后一个持有者退出才解锁。返回触及的作用域条数。
func ReleaseLeaseByOwner(owner string) int {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return 0
	}
	memoLeaseMu.Lock()
	paths := make([]string, 0, 2)
	for path, entry := range memoLeases {
		if _, held := entry.holders[owner]; held {
			paths = append(paths, path)
		}
	}
	releases := make([]*resourcelease.Lease, 0, len(paths))
	for _, path := range paths {
		entry := memoLeases[path]
		delete(entry.holders, owner)
		if len(entry.holders) == 0 {
			delete(memoLeases, path)
			releases = append(releases, entry.lease)
		}
	}
	memoLeaseMu.Unlock()
	for _, lease := range releases {
		lease.Release()
	}
	return len(paths)
}

// LeaseStatusFor 探测便签写权：本进程持有 -> Acquired；别的进程持有 -> Busy + Owner；
// 空闲 -> 两者都 false。只用于 UI 提示，不用于写决策。
func LeaseStatusFor(scope, workspace string) (LeaseStatus, error) {
	path, err := LeasePath(scope, workspace)
	if err != nil {
		return LeaseStatus{}, err
	}
	memoLeaseMu.Lock()
	if entry := memoLeases[path]; entry != nil {
		st := LeaseStatus{Acquired: true, Owner: entry.owner}
		memoLeaseMu.Unlock()
		return st, nil
	}
	memoLeaseMu.Unlock()
	owner, busy, err := resourcelease.Probe(path)
	if err != nil {
		return LeaseStatus{}, err
	}
	return LeaseStatus{Busy: busy, Owner: owner}, nil
}

// LockForClear 供存储清理取便签独占写权；同进程面板持有时直接报忙（不能因为
// refcount 共享就把面板正在编辑的目录删掉）。返回的 release 必须 defer 执行。
func LockForClear(scope, workspace string) (func(), error) {
	path, err := LeasePath(scope, workspace)
	if err != nil {
		return nil, err
	}
	memoLeaseMu.Lock()
	busy := memoLeases[path] != nil && len(memoLeases[path].holders) > 0
	memoLeaseMu.Unlock()
	if busy {
		return nil, fmt.Errorf("%w（本窗口正在编辑）", ErrBusy)
	}
	lease, err := resourcelease.AcquireNoShare(path, resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "storage-clear",
	})
	if err != nil {
		if resourcelease.IsBusy(err) {
			if owner := resourcelease.BusyOwner(err); owner.PID > 0 {
				return nil, fmt.Errorf("%w（另一窗口 PID %d 正在编辑）", ErrBusy, owner.PID)
			}
			return nil, fmt.Errorf("%w（另一窗口正在编辑）", ErrBusy)
		}
		return nil, err
	}
	return func() { lease.Release() }, nil
}

// Save 整份写 memo.json。baseMtimeMs>0 时做 CAS：文件比读入时新（哪怕毫秒级）
// 即视为其他窗口先写，返回 Conflict 让前端重载；「文件更旧」只在超出时间戳粒度
// 放宽时才算冲突。baseMtimeMs==0 表示载入时还没有文件，此时若文件已存在也报冲突。
func Save(scope, workspace, doc string, baseMtimeMs int64) SaveResult {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return SaveResult{Error: err.Error()}
	}
	// 写盘前取同一把写权租约：面板已持有时走 refcount，零成本；另一个窗口
	// 持有时返回 Busy（不是 Conflict——前端不能删缓存重载，那会丢本窗口内容）。
	lease, err := resourcelease.Acquire(root+".lock", resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "memo-save",
	})
	if err != nil {
		if resourcelease.IsBusy(err) {
			msg := ErrBusy.Error()
			if owner := resourcelease.BusyOwner(err); owner.PID > 0 {
				msg = fmt.Sprintf("%s（PID %d）", msg, owner.PID)
			}
			return SaveResult{Busy: true, Error: msg}
		}
		return SaveResult{Error: "获取快捷便签写锁失败：" + err.Error()}
	}
	defer lease.Release()
	doc = strings.TrimSpace(doc)
	if doc == "" {
		return SaveResult{Error: "没有可保存的内容"}
	}
	if len(doc) > docLimitBytes {
		return SaveResult{Error: fmt.Sprintf("快捷便签 内容超过上限（%d KB）", docLimitBytes>>10)}
	}
	if !json.Valid([]byte(doc)) {
		return SaveResult{Error: "内容不是合法 JSON"}
	}
	path := docPath(root)
	info, statErr := os.Stat(path)
	if baseMtimeMs > 0 {
		switch {
		case os.IsNotExist(statErr):
			// 读到的 mtime>0 说明当时文件存在，现在没了：也是别处动过
			return SaveResult{Conflict: true, Error: conflictPrefix + "快捷便签 已在其他窗口删除"}
		case statErr != nil:
			return SaveResult{Error: "检查快捷便签 状态失败：" + statErr.Error()}
		}
		// 文件比读入时新（毫秒级即算）：别的窗口先写了；只有比读入时旧且超出
		// 精度放宽才放过——FAT 类文件系统时间戳有秒级粒度，自家上次写入可能
		// 被记成比缓存略早的时间。
		fileMs := info.ModTime().UnixMilli()
		if fileMs > baseMtimeMs || baseMtimeMs-fileMs > mtimeSlackMs {
			return SaveResult{Conflict: true, Error: conflictPrefix + "快捷便签 已在其他窗口修改"}
		}
	} else if statErr == nil && info.Size() > 0 {
		// 载入时还没有文件，期间已有人写入了内容：同样让前端重载，不静默覆盖
		return SaveResult{Conflict: true, Error: conflictPrefix + "快捷便签 已在其他窗口创建"}
	}
	if err := atomfile.WriteFileAtomic(path, []byte(doc)); err != nil {
		return SaveResult{Error: "写入快捷便签 失败：" + err.Error()}
	}
	mtimeMs := int64(0)
	if info, err := os.Stat(path); err == nil {
		mtimeMs = info.ModTime().UnixMilli()
	}
	return SaveResult{OK: true, MtimeMs: mtimeMs}
}

// SaveImage 把贴图 data URL 解码落盘到 <root>/img/，返回相对 doc 的引用路径
// （img/xxx.png）。类型只信魔数嗅探，命名用纳秒时间戳天然防覆盖。
func SaveImage(scope, workspace, dataURL string) (string, error) {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return "", err
	}
	lease, err := resourcelease.Acquire(root+".lock", resourcelease.Owner{
		PID:   os.Getpid(),
		Label: "memo-image",
	})
	if err != nil {
		if resourcelease.IsBusy(err) {
			if owner := resourcelease.BusyOwner(err); owner.PID > 0 {
				return "", fmt.Errorf("%w（PID %d）", ErrBusy, owner.PID)
			}
			return "", ErrBusy
		}
		return "", fmt.Errorf("获取快捷便签写锁失败：%w", err)
	}
	defer lease.Release()
	raw, ext, err := decodeImage(dataURL)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "img")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建贴图目录失败：%s", err.Error())
	}
	name := fmt.Sprintf("img-%s.%s", strconv.FormatInt(time.Now().UnixNano(), 36), ext)
	if err := os.WriteFile(filepath.Join(dir, name), raw, 0o644); err != nil {
		return "", fmt.Errorf("写入贴图失败：%s", err.Error())
	}
	return "img/" + name, nil
}

// resolveRoot 解析作用域根目录：workspace → <ws>/.cadt/memo，global → <appdata>/memo。
func resolveRoot(scope, workspace string) (string, error) {
	switch scope {
	case scopeGlobal:
		if deps.AppDataDir == nil {
			return "", fmt.Errorf("应用数据目录未就绪")
		}
		base := strings.TrimSpace(deps.AppDataDir())
		if base == "" {
			return "", fmt.Errorf("应用数据目录不可用")
		}
		return filepath.Join(base, "memo"), nil
	case scopeWorkspace:
		ws := strings.TrimSpace(workspace)
		if ws == "" {
			return "", fmt.Errorf("没有打开的工作区，工作区快捷便签 不可用")
		}
		wsAbs, err := filepath.Abs(ws)
		if err != nil {
			return "", fmt.Errorf("工作区路径无效：%s", err.Error())
		}
		dir := filepath.Join(wsAbs, ".cadt", "memo")
		if checkRel, relErr := filepath.Rel(wsAbs, dir); relErr != nil ||
			checkRel == ".." || strings.HasPrefix(checkRel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("memo 目录越出工作区")
		}
		return dir, nil
	default:
		return "", fmt.Errorf("未知作用域 %q（支持 workspace / global）", scope)
	}
}

func docPath(root string) string { return filepath.Join(root, "memo.json") }

func envelopeJSON(data string, mtimeMs int64) string {
	out, _ := json.Marshal(envelope{Data: data, MtimeMs: mtimeMs})
	return string(out)
}

// decodeImage 解 data URL：base64 解码 + 魔数嗅探定扩展名。嗅不出白名单类型一律拒绝。
func decodeImage(dataURL string) ([]byte, string, error) {
	const marker = "base64,"
	idx := strings.Index(dataURL, marker)
	if idx < 0 {
		return nil, "", fmt.Errorf("无效的图片数据")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(dataURL[idx+len(marker):]), ""))
	if err != nil {
		return nil, "", fmt.Errorf("图片 base64 解码失败：%s", err.Error())
	}
	if len(raw) == 0 {
		return nil, "", fmt.Errorf("图片数据为空")
	}
	if len(raw) > imageLimitBytes {
		return nil, "", fmt.Errorf("图片超过大小上限（%d MB）", imageLimitBytes>>20)
	}
	ext := sniffImageExt(raw)
	if ext == "" {
		return nil, "", fmt.Errorf("不支持的图片类型（只放行 png/jpg/gif/webp/bmp）")
	}
	return raw, ext, nil
}

// sniffImageExt 按魔数识别图片类型，识别不出返回空串。
func sniffImageExt(raw []byte) string {
	switch {
	case len(raw) >= 8 && raw[0] == 0x89 && raw[1] == 'P' && raw[2] == 'N' && raw[3] == 'G':
		return "png"
	case len(raw) >= 3 && raw[0] == 0xFF && raw[1] == 0xD8 && raw[2] == 0xFF:
		return "jpg"
	case len(raw) >= 6 && string(raw[:3]) == "GIF":
		return "gif"
	case len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WEBP":
		return "webp"
	case len(raw) >= 2 && raw[0] == 'B' && raw[1] == 'M':
		return "bmp"
	}
	return ""
}
