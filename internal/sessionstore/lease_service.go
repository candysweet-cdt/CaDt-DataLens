// lease_service.go：会话回合租约的 Wails 绑定层。
//
// 一次 Acquire 同时拿「根门闩共享 + 会话独占」，Release 按相反顺序释放。与
// sessionstore.withSessionLock 的短租约共用 resourcelease 的进程内 refcount：
// 同一回合里的 Append/WriteMeta 不会自锁，别的进程持有回合锁时写路径返回
// ErrSessionBusy（字符串前缀 session-busy:）。
//
// v3 一进程多窗口：租约的进程内重入按「归属窗口名」分桶——同窗口重入计数，
// 跨窗口 Busy（reason other_window：两个窗口各自 startSessionTurn 同一会话
// 不再被 refcount 放行成双回合，2026-11-21 审查遗留 / multi-instance-sync
// 收缩范围外的同进程缺口）。
package sessionstore

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/resourcelease"
)

// OwnerForCall 返回绑定调用方窗口名（main 注入 callerWindowName）。
// 空串 = 兼容测试与非绑定路径（单桶语义，行为与旧 refcount 一致）。
var OwnerForCall func(ctx context.Context) string

func leaseOwnerKey(ctx context.Context) string {
	if OwnerForCall != nil {
		return strings.TrimSpace(OwnerForCall(ctx))
	}
	return ""
}

// LogStat 是会话正文的磁盘状态，交接协议用它判断“另一个窗口是否写过”。
// Archive* 字段描述归档 sidecar（archive.v1.jsonl）：前端凭 archiveExists 决定
// 是否向侧车探测归档总数（vacuum 后内存 archived 清空，归档内容只存 sidecar）。
type LogStat struct {
	Exists  bool  `json:"exists"`
	MtimeMs int64 `json:"mtimeMs"`
	// MtimeNs 是亚毫秒精度的修改时刻。MtimeMs 只有毫秒，同一毫秒内「同尺寸」的两次写入
	// 会被判成没变（交接协议于是跳过重读，后续 truncate 就按旧前缀裁掉别人的新增）。
	// 零额外 IO：这里本来就已经 stat 过一次。
	MtimeNs       int64 `json:"mtimeNs,omitempty"`
	Size          int64 `json:"size"`
	ArchiveExists bool  `json:"archiveExists,omitempty"`
	ArchiveSize   int64 `json:"archiveSize,omitempty"`
}

// LeaseStatus 是租约获取/探测结果。
type LeaseStatus struct {
	Acquired bool                `json:"acquired"` // 本进程是否持有
	Busy     bool                `json:"busy"`     // 是否被其它进程/窗口持有
	Owner    resourcelease.Owner `json:"owner,omitempty"`
	Stat     LogStat             `json:"stat,omitempty"`
}

type sessionLeaseEntry struct {
	root    *resourcelease.Lease
	session *resourcelease.Lease
	// holders 持有者计数，按归属窗口名分桶：同窗口重入 +1，跨窗口 Busy。
	holders map[string]int
	owner   resourcelease.Owner
}

var (
	sessionLeaseMu sync.Mutex
	sessionLeases  = map[string]*sessionLeaseEntry{}
)

// AISessionLeaseAcquire 取会话回合租约（根共享 + 会话独占）。
//
// purpose 只用于调试/展示；timeoutMs=0 时非阻塞，>0 时在“根共享”下短等
// 目标会话（根独占的清理不会反向等待会话租约，不会形成 ABBA）。等待只对
// 「别的进程」的持有者有意义：同进程别的窗口持有 → 立即 Busy，不等待。
func (s *Service) AISessionLeaseAcquire(ctx context.Context, id, purpose, label string, timeoutMs int) (LeaseStatus, error) {
	store, err := s.store()
	if err != nil {
		return LeaseStatus{}, err
	}
	if !ValidSessionID(id) {
		return LeaseStatus{}, fmt.Errorf("非法会话 id：%q", id)
	}
	if err := store.EnsureRoot(); err != nil {
		return LeaseStatus{}, err
	}
	ownerKey := leaseOwnerKey(ctx)

	sessionLeaseMu.Lock()
	if entry := sessionLeases[id]; entry != nil {
		if _, held := entry.holders[ownerKey]; held {
			entry.holders[ownerKey]++
			st := LeaseStatus{Acquired: true, Owner: entry.owner, Stat: statLog(store, id)}
			sessionLeaseMu.Unlock()
			return st, nil
		}
		st := LeaseStatus{Busy: true, Owner: entry.owner, Stat: statLog(store, id)}
		sessionLeaseMu.Unlock()
		return st, nil
	}
	sessionLeaseMu.Unlock()

	rootLease, err := resourcelease.AcquireShared(store.RootGatePath())
	if err != nil {
		if resourcelease.IsBusy(err) {
			return LeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err), Stat: statLog(store, id)}, nil
		}
		return LeaseStatus{}, wrapLeaseErr(err)
	}
	leasePath, err := store.LeasePath(id)
	if err != nil {
		rootLease.Release()
		return LeaseStatus{}, err
	}
	owner := resourcelease.Owner{
		PID:       os.Getpid(),
		Label:     leaseOwnerLabel(label, ownerKey),
		StartedAt: time.Now().UnixMilli(),
		Version:   1,
	}
	var sessionLease *resourcelease.Lease
	if timeoutMs > 0 && ownerKey == "" {
		// 短等只用于跨进程场景（无归属窗口的后台入口）；同进程多窗口一律非阻塞
		// ——等待会吞掉「另一窗口运行中」的即时反馈。
		sessionLease, err = resourcelease.AcquireWait(leasePath, owner, time.Duration(timeoutMs)*time.Millisecond)
	} else {
		sessionLease, err = resourcelease.Acquire(leasePath, owner)
	}
	if err != nil {
		rootLease.Release()
		if resourcelease.IsBusy(err) {
			return LeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err), Stat: statLog(store, id)}, nil
		}
		return LeaseStatus{}, wrapLeaseErr(err)
	}

	// 双检：并发 Acquire 可能已经入表；把本次多拿的 ref 还回去。
	sessionLeaseMu.Lock()
	if entry := sessionLeases[id]; entry != nil {
		entry.holders[ownerKey]++
		st := LeaseStatus{Acquired: true, Owner: entry.owner, Stat: statLog(store, id)}
		sessionLeaseMu.Unlock()
		sessionLease.Release()
		rootLease.Release()
		return st, nil
	}
	entry := &sessionLeaseEntry{
		root:    rootLease,
		session: sessionLease,
		holders: map[string]int{ownerKey: 1},
		owner:   owner,
	}
	sessionLeases[id] = entry
	st := LeaseStatus{Acquired: true, Owner: owner, Stat: statLog(store, id)}
	sessionLeaseMu.Unlock()
	return st, nil
}

// leaseOwnerLabel 把窗口名并进横幅 label：同进程多窗口下 PID 相同，
// 只有窗口名能区分「谁在跑」。
func leaseOwnerLabel(label, ownerKey string) string {
	label = strings.TrimSpace(label)
	if ownerKey == "" {
		if label == "" {
			return "session"
		}
		return label
	}
	if label == "" {
		return "窗口 " + ownerKey
	}
	return label + " · 窗口 " + ownerKey
}

// AISessionLeaseRelease 释放调用方窗口对这个会话的回合租约；最后一个持有者
// 退出才真正解锁。
func (s *Service) AISessionLeaseRelease(ctx context.Context, id string) error {
	ownerKey := leaseOwnerKey(ctx)
	sessionLeaseMu.Lock()
	entry := sessionLeases[id]
	if entry == nil {
		sessionLeaseMu.Unlock()
		return nil
	}
	if n := entry.holders[ownerKey]; n > 1 {
		entry.holders[ownerKey] = n - 1
		sessionLeaseMu.Unlock()
		return nil
	}
	delete(entry.holders, ownerKey)
	if len(entry.holders) > 0 {
		sessionLeaseMu.Unlock()
		return nil
	}
	delete(sessionLeases, id)
	sessionLeaseMu.Unlock()
	entry.session.Release()
	entry.root.Release()
	return nil
}

// AISessionLeaseReleaseByOwner 归属窗口关闭时释放它名下的全部回合租约；
// 最后一个持有者退出才解锁。返回触及的会话数（未持锁的窗口返回 0）。
func (s *Service) AISessionLeaseReleaseByOwner(owner string) int {
	ownerKey := strings.TrimSpace(owner)
	if ownerKey == "" {
		return 0
	}
	sessionLeaseMu.Lock()
	ids := make([]string, 0, 2)
	for id, entry := range sessionLeases {
		if _, held := entry.holders[ownerKey]; held {
			ids = append(ids, id)
		}
	}
	type pendingRelease struct {
		session *resourcelease.Lease
		root    *resourcelease.Lease
	}
	releases := make([]pendingRelease, 0, len(ids))
	for _, id := range ids {
		entry := sessionLeases[id]
		delete(entry.holders, ownerKey)
		if len(entry.holders) == 0 {
			delete(sessionLeases, id)
			releases = append(releases, pendingRelease{entry.session, entry.root})
		}
	}
	sessionLeaseMu.Unlock()
	for _, r := range releases {
		r.session.Release()
		r.root.Release()
	}
	return len(ids)
}

// AISessionLeaseStatus 探测会话租约：本进程持有 -> Acquired；别的进程持有 ->
// Busy + Owner；空闲 -> 两者都 false。只用于 UI 提示，不用于写决策。
func (s *Service) AISessionLeaseStatus(id string) (LeaseStatus, error) {
	store, err := s.store()
	if err != nil {
		return LeaseStatus{}, err
	}
	if !ValidSessionID(id) {
		return LeaseStatus{}, fmt.Errorf("非法会话 id：%q", id)
	}
	sessionLeaseMu.Lock()
	entry := sessionLeases[id]
	if entry != nil {
		st := LeaseStatus{Acquired: true, Owner: entry.owner, Stat: statLog(store, id)}
		sessionLeaseMu.Unlock()
		return st, nil
	}
	sessionLeaseMu.Unlock()

	leasePath, err := store.LeasePath(id)
	if err != nil {
		return LeaseStatus{}, err
	}
	owner, busy, err := resourcelease.Probe(leasePath)
	if err != nil {
		return LeaseStatus{}, err
	}
	return LeaseStatus{Busy: busy, Owner: owner, Stat: statLog(store, id)}, nil
}

// AISessionStat 返回会话正文的磁盘状态（不存在时 Exists=false），交接协议用。
func (s *Service) AISessionStat(id string) (LogStat, error) {
	store, err := s.store()
	if err != nil {
		return LogStat{}, err
	}
	if !ValidSessionID(id) {
		return LogStat{}, fmt.Errorf("非法会话 id：%q", id)
	}
	return statLog(store, id), nil
}

func statLog(store *Store, id string) LogStat {
	path, err := store.logPath(id)
	if err != nil {
		return LogStat{}
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return LogStat{}
	}
	stat := LogStat{
		Exists:  true,
		MtimeMs: info.ModTime().UnixMilli(),
		MtimeNs: info.ModTime().UnixNano(),
		Size:    info.Size(),
	}
	// sidecar 存在性顺带上报：懒加载/交接协议的 stat 往返已经在这里，前端不必再探一次。
	dir := filepath.Dir(path)
	if archiveInfo, err := os.Stat(filepath.Join(dir, aiSessionArchiveName)); err == nil && !archiveInfo.IsDir() {
		stat.ArchiveExists = true
		stat.ArchiveSize = archiveInfo.Size()
	}
	return stat
}
