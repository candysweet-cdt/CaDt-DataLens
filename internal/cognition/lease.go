package cognition

// lease.go：认知卷写租约的窗口分桶（v3 一进程多窗口）。
//
// resourcelease 的进程内 refcount 是「同进程重入不自锁」——它刻意不区分窗口。
// v2（一窗口一进程）不需要区分；v3 之后同一进程的两个窗口取同一把独占锁会被
// refcount 直接放行成双写（与 memo / sessionstore 修过的是同一类缺口，2026-11-21
// 审查遗留）。这里照抄那两处的模式：per-lock 的 holders 按「归属窗口名」分桶——
// 同窗口重入计数 +1，跨窗口直接 Busy，最后一个持有者退出才真正释放内核锁。
//
// 归属窗口名从绑定调用的 ctx 取（main 经 OwnerForCall 注入 callerWindowName）；
// 空串 = 兼容测试与非绑定路径（单桶语义，行为与旧 refcount 一致）。

import (
	"context"
	"os"
	"strings"
	"sync"

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

// leaseEntry 是一把锁（一条认知卷）的进程内状态。
type leaseEntry struct {
	lease *resourcelease.Lease
	// holders 持有者计数，按归属窗口名分桶：同窗口重入 +1，跨窗口 Busy。
	holders map[string]int
	owner   resourcelease.Owner
}

var (
	leaseMu sync.Mutex
	leases  = map[string]*leaseEntry{}
)

// leaseHandle 是 acquireLease 交给调用方的句柄：Release 幂等，只按 ownerKey 退桶。
type leaseHandle struct {
	key      string
	ownerKey string
	once     sync.Once
}

// Release 退出本次引用；最后一个持有者退出才释放内核锁（重复调用无副作用）。
func (h *leaseHandle) Release() {
	if h == nil {
		return
	}
	h.once.Do(func() { releaseLease(h.key, h.ownerKey) })
}

// leaseKey 把锁路径规范成 map 键，口径与 resourcelease 内部一致
// （同一目录不同大小写/尾斜杠不会分成两格）。规范化失败时退回原始路径。
func leaseKey(lockPath string) string {
	if key, err := resourcelease.CanonicalKey(lockPath); err == nil {
		return key
	}
	return lockPath
}

// acquireLease 取认知卷写租约（edit 与 status 的 baseline 兜底共用）。
// 同窗口重入走计数；别的窗口已持有 → BusyError（带持有者信息），不等待。
func (s *Service) acquireLease(ctx context.Context, p paths, label string) (*leaseHandle, error) {
	key := leaseKey(p.lock)
	ownerKey := leaseOwnerKey(ctx)

	leaseMu.Lock()
	if entry := leases[key]; entry != nil {
		// 同窗口重入：计数 +1；别的窗口已持有 → Busy（不碰 resourcelease）。
		if _, held := entry.holders[ownerKey]; held {
			entry.holders[ownerKey]++
			leaseMu.Unlock()
			return &leaseHandle{key: key, ownerKey: ownerKey}, nil
		}
		busyOwner := entry.owner
		leaseMu.Unlock()
		return nil, &resourcelease.BusyError{Owner: busyOwner}
	}
	leaseMu.Unlock()

	owner := resourcelease.Owner{PID: os.Getpid(), Label: leaseOwnerLabel(label, ownerKey)}
	lease, err := resourcelease.Acquire(p.lock, owner)
	if err != nil {
		return nil, err
	}

	// 双检：并发 Acquire 可能已经入表；把本次多拿的 ref 还回去。
	leaseMu.Lock()
	if entry := leases[key]; entry != nil {
		if _, held := entry.holders[ownerKey]; held {
			entry.holders[ownerKey]++
			leaseMu.Unlock()
			lease.Release()
			return &leaseHandle{key: key, ownerKey: ownerKey}, nil
		}
		busyOwner := entry.owner
		leaseMu.Unlock()
		lease.Release()
		return nil, &resourcelease.BusyError{Owner: busyOwner}
	}
	leases[key] = &leaseEntry{lease: lease, holders: map[string]int{ownerKey: 1}, owner: owner}
	leaseMu.Unlock()
	return &leaseHandle{key: key, ownerKey: ownerKey}, nil
}

// releaseLease 退出一个持有者的引用；最后一个持有者退出时释放内核锁。
func releaseLease(key, ownerKey string) {
	leaseMu.Lock()
	entry := leases[key]
	if entry == nil {
		leaseMu.Unlock()
		return
	}
	if n := entry.holders[ownerKey]; n > 1 {
		entry.holders[ownerKey] = n - 1
		leaseMu.Unlock()
		return
	}
	delete(entry.holders, ownerKey)
	if len(entry.holders) > 0 {
		leaseMu.Unlock()
		return
	}
	delete(leases, key)
	leaseMu.Unlock()
	entry.lease.Release()
}

// leaseOwnerLabel 把窗口名并进 owner 的 label：同进程多窗口下 PID 相同，
// 只有窗口名能区分「谁在写」。
func leaseOwnerLabel(label, ownerKey string) string {
	label = strings.TrimSpace(label)
	if ownerKey == "" {
		if label == "" {
			return "cognition"
		}
		return label
	}
	if label == "" {
		return "窗口 " + ownerKey
	}
	return label + " · 窗口 " + ownerKey
}
