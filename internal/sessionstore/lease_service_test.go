package sessionstore

import (
	"context"
	"strings"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"datalens/internal/resourcelease"
)

// 同进程 refcount：两次 Acquire 后 release 一次仍持有，第二次才真正释放。
func TestServiceSessionLeaseRefcount(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	first, err := svc.AISessionLeaseAcquire(nil, "s1", "turn", "test", 0)
	if err != nil || !first.Acquired {
		t.Fatalf("首次租约失败：%+v %v", first, err)
	}
	second, err := svc.AISessionLeaseAcquire(nil, "s1", "turn", "test", 0)
	if err != nil || !second.Acquired {
		t.Fatalf("第二次租约应走 refcount：%+v %v", second, err)
	}
	if err := svc.AISessionLeaseRelease(nil, "s1"); err != nil {
		t.Fatal(err)
	}
	status, err := svc.AISessionLeaseStatus("s1")
	if err != nil || !status.Acquired {
		t.Fatalf("释放一个 ref 后仍应持有：%+v %v", status, err)
	}
	if err := svc.AISessionLeaseRelease(nil, "s1"); err != nil {
		t.Fatal(err)
	}
	status, err = svc.AISessionLeaseStatus("s1")
	if err != nil || status.Acquired || status.Busy {
		t.Fatalf("全部释放后租约应为空：%+v %v", status, err)
	}
}

// statLog 必须带亚毫秒时刻：毫秒精度下「同一毫秒内、同尺寸」的两次写入会被交接协议
// 判成「没变」，于是跳过重读，后续 truncate 就按旧前缀裁掉另一个窗口刚写的内容。
func TestStatLogCarriesNanosecondMtime(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	if err := svc.AISessionAppend("s1", `{"t":"header"}`, true); err != nil {
		t.Fatal(err)
	}
	stat, err := svc.AISessionStat("s1")
	if err != nil {
		t.Fatal(err)
	}
	if !stat.Exists {
		t.Fatalf("会话正文应存在：%+v", stat)
	}
	if stat.MtimeNs <= 0 {
		t.Fatalf("mtimeNs 缺失：%+v", stat)
	}
	if stat.MtimeNs/1_000_000 != stat.MtimeMs {
		t.Fatalf("毫秒与纳秒不一致：%d vs %d", stat.MtimeNs, stat.MtimeMs)
	}
}

// 回合租约与写路径同进程共享：Append/WriteMeta 不应被自己的回合锁挡住。
func TestSessionWriteSharesTurnLease(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	if _, err := svc.AISessionLeaseAcquire(nil, "s1", "turn", "test", 0); err != nil {
		t.Fatal(err)
	}
	defer svc.AISessionLeaseRelease(nil, "s1")
	if err := svc.AISessionAppend("s1", `{"t":"header"}`, true); err != nil {
		t.Fatalf("同进程 Append 应共享租约：%v", err)
	}
	if err := svc.AISessionWriteMeta("s1", `{"title":"x"}`); err != nil {
		t.Fatalf("同进程 WriteMeta 应共享租约：%v", err)
	}
}

// 根门闩共享存在时，RemoveAll 的独占请求必须失败。
func TestRemoveAllBlockedBySharedRootGate(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	if err := store.Append("s1", "{}\n"); err != nil {
		t.Fatal(err)
	}
	gate, err := resourcelease.AcquireShared(store.RootGatePath())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveAll(); !errors.Is(err, ErrSessionBusy) {
		gate.Release()
		t.Fatalf("共享门闩存在时 RemoveAll 应 busy，得到 %v", err)
	}
	gate.Release()
	if err := store.RemoveAll(); err != nil {
		t.Fatalf("释放后 RemoveAll 失败：%v", err)
	}
	if _, err := os.Stat(store.Root); !os.IsNotExist(err) {
		t.Fatalf("会话根目录未删除：%v", err)
	}
}

// 本进程持有会话锁时，Remove 的 NoShare 独占必须失败（不能 refcount 共享后删掉）。
func TestRemoveBlockedBySameProcessLease(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	if err := store.Append("s1", "{}\n"); err != nil {
		t.Fatal(err)
	}
	path, err := store.LeasePath("s1")
	if err != nil {
		t.Fatal(err)
	}
	lease, err := resourcelease.Acquire(path, resourcelease.Owner{Label: "turn"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("s1"); !errors.Is(err, ErrSessionBusy) {
		lease.Release()
		t.Fatalf("本进程持锁时 Remove 应 busy，得到 %v", err)
	}
	lease.Release()
	if err := store.Remove("s1"); err != nil {
		t.Fatalf("释放后 Remove 失败：%v", err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, "s1")); !os.IsNotExist(err) {
		t.Fatalf("会话目录未删除：%v", err)
	}
}

// 根门闩被独占（清理）时，写路径的根共享必须失败。
func TestSessionWriteBlockedByRootGate(t *testing.T) {
	store := New(t.TempDir())
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	gate, err := resourcelease.AcquireNoShare(store.RootGatePath(), resourcelease.Owner{Label: "clear"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Append("s1", "x\n"); !errors.Is(err, ErrSessionBusy) {
		gate.Release()
		t.Fatalf("根门闩独占时 Append 应 busy，得到 %v", err)
	}
	gate.Release()
	if err := store.Append("s1", "x\n"); err != nil {
		t.Fatalf("释放后 Append 失败：%v", err)
	}
}

// TestTurnLeaseOwners：回合租约按归属窗口分桶——同窗口重入计数，跨窗口 Busy
// （v3 同进程双窗口不再被 refcount 放行成双回合），按归属释放只摘自己的。
func TestTurnLeaseOwners(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	id := "lease-owner-test"

	// 归属窗口名经 ctx 注入（生产由 main 注入 callerWindowName）。
	type ownerCtxKey struct{}
	OwnerForCall = func(ctx context.Context) string {
		if v, ok := ctx.Value(ownerCtxKey{}).(string); ok {
			return v
		}
		return ""
	}
	defer func() { OwnerForCall = nil }()
	winCtx := func(owner string) context.Context {
		return context.WithValue(context.Background(), ownerCtxKey{}, owner)
	}

	// 窗口 main 取得回合租约
	first, err := svc.AISessionLeaseAcquire(winCtx("main"), id, "turn", "", 0)
	if err != nil || !first.Acquired {
		t.Fatalf("窗口 main 取租约失败：%+v %v", first, err)
	}
	// 同窗口重入：计数 +1
	reentry, err := svc.AISessionLeaseAcquire(winCtx("main"), id, "turn", "", 0)
	if err != nil || !reentry.Acquired {
		t.Fatalf("同窗口重入应计数：%+v %v", reentry, err)
	}
	// 跨窗口（main-2）：Busy
	second, err := svc.AISessionLeaseAcquire(winCtx("main-2"), id, "turn", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if second.Acquired || !second.Busy {
		t.Fatalf("跨窗口取租约应 Busy：%+v", second)
	}
	if !strings.Contains(second.Owner.Label, "main") {
		t.Fatalf("Busy Owner 应能看出持有窗口：%+v", second.Owner)
	}
	// main-2 未持锁：按归属释放触达 0
	if n := svc.AISessionLeaseReleaseByOwner("main-2"); n != 0 {
		t.Fatalf("未持锁窗口按归属释放应触达 0：%d", n)
	}
	// main 释放一次（重入还在）：仍持有
	if err := svc.AISessionLeaseRelease(winCtx("main"), id); err != nil {
		t.Fatal(err)
	}
	if st, err := svc.AISessionLeaseStatus(id); err != nil || !st.Acquired {
		t.Fatalf("还剩一个持有者时应仍持有：%+v %v", st, err)
	}
	// main 关窗：按归属释放解锁
	if n := svc.AISessionLeaseReleaseByOwner("main"); n != 1 {
		t.Fatalf("按归属释放应触达 1：%d", n)
	}
	if st, err := svc.AISessionLeaseStatus(id); err != nil || st.Acquired || st.Busy {
		t.Fatalf("全部释放后租约应为空：%+v %v", st, err)
	}
}
