// Package resourcelease：跨进程资源写权租约。
//
// 职责只有三件：互斥（底层 sessionlock 文件锁）、进程内重入（per-key refcount）、
// owner 提示（旁边 .owner 文件，仅用于 UI 展示）。它不认识便签/会话等业务资源。
//
// 设计约束（见 docs/unfinished-plans/multi-instance-sync.md §4.6）：
//   - 嵌套获取一律非阻塞；AcquireWait 只允许在没有持有其它租约时使用；
//   - manager 的全局 map 锁内不做 IO，等待只在 per-key 锁内；
//   - 锁文件放在被保护目录之外，释放时不删 owner 文件；
//   - 不做 TTL、不做强制抢锁：进程存活即持锁，进程退出由内核释放。
package resourcelease

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/sessionlock"
)

const (
	ownerVersion   = 1
	ownerLabelMax  = 200
	probeRetryWait = 25 * time.Millisecond
)

// Owner 是锁持有者的展示信息，不参与互斥判定。
type Owner struct {
	PID       int    `json:"pid"`
	Label     string `json:"label,omitempty"`
	StartedAt int64  `json:"startedAt"`
	Version   int    `json:"v"`
}

// Mode 是租约模式：独占（写者）或共享（根门闩的多个回合/写路径）。
type Mode int

const (
	Exclusive Mode = iota
	Shared
)

// BusyError 表示锁被另一个进程（或同进程的另一种模式）持有。
// Owner 可能为零值（owner 文件尚未写入/读取失败）。
type BusyError struct {
	Owner Owner
}

func (e *BusyError) Error() string {
	if e == nil {
		return "资源正在另一窗口使用"
	}
	if e.Owner.PID > 0 {
		return fmt.Sprintf("资源正在另一窗口使用（PID %d）", e.Owner.PID)
	}
	return "资源正在另一窗口使用"
}

// IsBusy 判断错误是否为“锁被占”。
func IsBusy(err error) bool {
	var busy *BusyError
	return errors.As(err, &busy)
}

// CanonicalKey 返回锁路径的进程内规范 key（绝对路径 + Clean，Windows 再小写）。
//
// 供上层按锁分桶时复用锁本身的键口径：同一个目录用不同拼写（D:\ws / d:\ws\）时，
// 上层 map 若拿原始路径当键会分成两格，跨窗口互斥就被这层放过去了。
func CanonicalKey(lockPath string) (string, error) {
	return canonicalKey(lockPath)
}

// BusyOwner 从错误里提取 owner（非 busy 返回零值）。
func BusyOwner(err error) Owner {
	var busy *BusyError
	if errors.As(err, &busy) {
		return busy.Owner
	}
	return Owner{}
}

// Lease 是租约句柄。Release 幂等，重复调用不会多减 refcount。
type Lease struct {
	path string
	mode Mode
	st   *keyState
	once sync.Once
}

// Release 递减本进程对该 key 的引用；归零时释放内核锁。
func (l *Lease) Release() {
	if l == nil || l.st == nil {
		return
	}
	l.once.Do(func() {
		l.st.release(l.mode)
	})
}

// Acquire 非阻塞获取独占租约；同一进程重复获取走 refcount，直接成功。
func Acquire(lockPath string, owner Owner) (*Lease, error) {
	key, st, err := stateFor(lockPath, true)
	if err != nil {
		return nil, err
	}
	owner = normalizeOwner(owner)
	st.mu.Lock()
	if st.noShare {
		local := st.owner
		st.mu.Unlock()
		return nil, &BusyError{Owner: localOrFile(local, key)}
	}
	switch {
	case st.exclusive > 0:
		st.exclusive++
		st.mu.Unlock()
		return &Lease{path: key, mode: Exclusive, st: st}, nil
	case st.shared > 0:
		local := st.owner
		st.mu.Unlock()
		return nil, &BusyError{Owner: local}
	}
	lock, lockErr := sessionlock.TryLockFile(key)
	if lockErr != nil {
		st.mu.Unlock()
		if errors.Is(lockErr, sessionlock.ErrLocked) {
			return nil, &BusyError{Owner: readOwner(key)}
		}
		return nil, fmt.Errorf("获取资源写锁失败：%w", lockErr)
	}
	st.lock = lock
	st.exclusive = 1
	st.owner = owner
	st.mu.Unlock()
	writeOwner(key, owner)
	return &Lease{path: key, mode: Exclusive, st: st}, nil
}

// AcquireNoShare 非阻塞获取独占租约；本进程已有任何 ref 时也返回 busy。
//
// 供销毁/清理使用：不能因为 refcount 共享就把别人（甚至本进程另一个协程）
// 正在写的资源删掉。普通写路径用 Acquire（同进程重入是特性），只有“删除/清空”
// 这类破坏性动作才用 NoShare。
func AcquireNoShare(lockPath string, owner Owner) (*Lease, error) {
	key, st, err := stateFor(lockPath, true)
	if err != nil {
		return nil, err
	}
	owner = normalizeOwner(owner)
	st.mu.Lock()
	if st.shared > 0 || st.exclusive > 0 {
		local := st.owner
		st.mu.Unlock()
		return nil, &BusyError{Owner: localOrFile(local, key)}
	}
	lock, lockErr := sessionlock.TryLockFile(key)
	if lockErr != nil {
		st.mu.Unlock()
		if errors.Is(lockErr, sessionlock.ErrLocked) {
			return nil, &BusyError{Owner: readOwner(key)}
		}
		return nil, fmt.Errorf("获取资源写锁失败：%w", lockErr)
	}
	st.lock = lock
	st.exclusive = 1
	st.owner = owner
	st.noShare = true
	st.mu.Unlock()
	writeOwner(key, owner)
	return &Lease{path: key, mode: Exclusive, st: st}, nil
}

// AcquireShared 非阻塞获取共享租约；共享租约不写 owner 文件。
func AcquireShared(lockPath string) (*Lease, error) {
	key, st, err := stateFor(lockPath, true)
	if err != nil {
		return nil, err
	}
	st.mu.Lock()
	if st.shared > 0 {
		st.shared++
		st.mu.Unlock()
		return &Lease{path: key, mode: Shared, st: st}, nil
	}
	if st.exclusive > 0 {
		// 同进程已有独占（资源写者或根门闩的销毁操作）：共享请求不能借 refcount
		// 绕过去。根门闩的独占正在删目录时，同进程写路径必须看到 busy。
		local := st.owner
		st.mu.Unlock()
		return nil, &BusyError{Owner: localOrFile(local, key)}
	}
	lock, lockErr := sessionlock.TryLockFileShared(key)
	if lockErr != nil {
		local := st.owner
		st.mu.Unlock()
		if errors.Is(lockErr, sessionlock.ErrLocked) {
			return nil, &BusyError{Owner: localOrFile(local, key)}
		}
		return nil, fmt.Errorf("获取共享锁失败：%w", lockErr)
	}
	st.lock = lock
	st.shared = 1
	st.mu.Unlock()
	return &Lease{path: key, mode: Shared, st: st}, nil
}

// AcquireWait 带超时获取独占租约。
//
// 只允许后台任务在“不持有其它租约”时使用；调用方在等待期间不得再等待另一把
// 资源锁（根门闩的共享锁是唯一例外，见包注释）。超时返回 BusyError。
func AcquireWait(lockPath string, owner Owner, timeout time.Duration) (*Lease, error) {
	key, st, err := stateFor(lockPath, true)
	if err != nil {
		return nil, err
	}
	owner = normalizeOwner(owner)
	st.mu.Lock()
	if st.noShare {
		local := st.owner
		st.mu.Unlock()
		return nil, &BusyError{Owner: localOrFile(local, key)}
	}
	switch {
	case st.exclusive > 0:
		st.exclusive++
		st.mu.Unlock()
		return &Lease{path: key, mode: Exclusive, st: st}, nil
	case st.shared > 0:
		local := st.owner
		st.mu.Unlock()
		return nil, &BusyError{Owner: local}
	}
	var lock *sessionlock.FileLock
	if timeout <= 0 {
		lock, err = sessionlock.TryLockFile(key)
	} else {
		lock, err = sessionlock.LockFile(key, timeout)
	}
	if err != nil {
		st.mu.Unlock()
		if errors.Is(err, sessionlock.ErrLocked) {
			return nil, &BusyError{Owner: readOwner(key)}
		}
		return nil, fmt.Errorf("等待资源写锁失败：%w", err)
	}
	st.lock = lock
	st.exclusive = 1
	st.owner = owner
	st.mu.Unlock()
	writeOwner(key, owner)
	return &Lease{path: key, mode: Exclusive, st: st}, nil
}

// Probe 仅用于 UI：临时尝试抢独占锁，判断锁是否被占。
//
//   - 返回 (Owner{}, false, nil)：锁空；
//   - 返回 (owner, true, nil)：锁被占（owner 可能为零值）；
//   - 返回 error：IO 错误，调用方按“不可用”处理。
//
// 不要用 Probe 的结果做写入决策，真正的决策一律走 Acquire。
func Probe(lockPath string) (Owner, bool, error) {
	key, st, err := stateFor(lockPath, false)
	if err != nil {
		return Owner{}, false, err
	}
	if st == nil {
		return Owner{}, false, nil
	}
	st.mu.Lock()
	if st.exclusive > 0 || st.shared > 0 {
		owner := st.owner
		st.mu.Unlock()
		return owner, true, nil
	}
	lock, lockErr := sessionlock.TryLockFile(key)
	if lockErr == nil {
		lock.Release()
		st.mu.Unlock()
		return Owner{}, false, nil
	}
	st.mu.Unlock()
	if !errors.Is(lockErr, sessionlock.ErrLocked) {
		return Owner{}, false, fmt.Errorf("探测资源锁失败：%w", lockErr)
	}
	owner := readOwner(key)
	if owner.PID > 0 {
		return owner, true, nil
	}
	// 两个读者同时 Probe 时可能互相看到 busy：短等一次再确认。
	time.Sleep(probeRetryWait)
	lock, lockErr = sessionlock.TryLockFile(key)
	if lockErr == nil {
		lock.Release()
		return Owner{}, false, nil
	}
	if !errors.Is(lockErr, sessionlock.ErrLocked) {
		return Owner{}, false, fmt.Errorf("探测资源锁失败：%w", lockErr)
	}
	return readOwner(key), true, nil
}

func stateFor(lockPath string, createParent bool) (string, *keyState, error) {
	key, err := canonicalKey(lockPath)
	if err != nil {
		return "", nil, err
	}
	if createParent {
		if mkErr := os.MkdirAll(filepath.Dir(key), 0o755); mkErr != nil {
			return "", nil, fmt.Errorf("创建锁目录失败：%w", mkErr)
		}
	}
	return key, getState(key), nil
}

func normalizeOwner(owner Owner) Owner {
	if owner.PID <= 0 {
		owner.PID = os.Getpid()
	}
	if owner.StartedAt <= 0 {
		owner.StartedAt = time.Now().UnixMilli()
	}
	owner.Label = sanitizeLabel(owner.Label)
	owner.Version = ownerVersion
	return owner
}

func sanitizeLabel(label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return ""
	}
	// 去掉控制字符，避免写进 owner JSON 后在 UI 里换行/乱码。
	label = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, label)
	if len([]rune(label)) > ownerLabelMax {
		label = string([]rune(label)[:ownerLabelMax])
	}
	return label
}

func readOwner(lockPath string) Owner {
	raw, err := os.ReadFile(lockPath + ".owner")
	if err != nil {
		return Owner{}
	}
	var owner Owner
	if json.Unmarshal(raw, &owner) != nil {
		return Owner{}
	}
	return owner
}

func writeOwner(lockPath string, owner Owner) {
	raw, err := json.Marshal(owner)
	if err != nil {
		return
	}
	// owner 仅是提示，写失败不影响锁本身。
	_ = atomfile.WriteFileAtomic(lockPath+".owner", raw)
}

func localOrFile(local Owner, lockPath string) Owner {
	if local.PID > 0 {
		return local
	}
	return readOwner(lockPath)
}
