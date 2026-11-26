package cognition

// lease_test.go：写租约的窗口分桶（v3 同进程多窗口）。
//
// resourcelease 的进程内 refcount 会放行「同进程另一个窗口」——这组用例守的就是
// 那层补丁：同窗口重入 +1、跨窗口 Busy、释放后重新可获取、Busy 错误带持有窗口信息。

import (
	"context"
	"strings"
	"testing"

	"datalens/internal/resourcelease"
)

type leaseOwnerCtxKey struct{}

// withLeaseOwner 造一个带归属窗口名的 ctx，并把 OwnerForCall 临时接成「从 ctx 取」。
// 生产里 main 注入的是 callerWindowName（从 Wails 的 WindowKey 取），测试没有窗口对象，
// 所以用同形状的钩子代替。
func withLeaseOwner(t *testing.T, owner string) context.Context {
	t.Helper()
	prev := OwnerForCall
	OwnerForCall = func(ctx context.Context) string {
		if ctx == nil {
			return ""
		}
		name, _ := ctx.Value(leaseOwnerCtxKey{}).(string)
		return name
	}
	t.Cleanup(func() { OwnerForCall = prev })
	return context.WithValue(context.Background(), leaseOwnerCtxKey{}, owner)
}

func TestAcquireLeasePerWindowBucket(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	p := resolvePaths(ws)

	ctxMain := withLeaseOwner(t, "main")
	first, err := s.acquireLease(ctxMain, p, "test-edit")
	if err != nil {
		t.Fatalf("首个窗口取租约失败：%v", err)
	}

	// 同窗口重入：走计数，不碰 resourcelease
	reentry, err := s.acquireLease(ctxMain, p, "test-edit")
	if err != nil {
		t.Fatalf("同窗口重入应成功：%v", err)
	}

	// 跨窗口：Busy，且错误带得出持有窗口（PID 相同，只有 label 能区分）
	ctxOther := withLeaseOwner(t, "float-1")
	if _, err := s.acquireLease(ctxOther, p, "test-edit"); err == nil {
		t.Fatal("另一个窗口不该拿到同一把写租约")
	} else {
		if !resourcelease.IsBusy(err) {
			t.Fatalf("跨窗口应是 BusyError，got %T %v", err, err)
		}
		if label := resourcelease.BusyOwner(err).Label; !strings.Contains(label, "main") {
			t.Fatalf("Busy 错误要能看出持有窗口，label = %q", label)
		}
		if msg := leaseBusy(err).Error(); !strings.Contains(msg, "main") {
			t.Fatalf("呈现给用户的 Busy 文案也该带窗口名：%q", msg)
		}
	}

	// 释放一次仍被本窗口持有（重入计数为 2）→ 跨窗口继续 Busy
	first.Release()
	if _, err := s.acquireLease(ctxOther, p, "test-edit"); !resourcelease.IsBusy(err) {
		t.Fatalf("同窗口还有一个引用时仍应 Busy，got %v", err)
	}

	// 最后一个引用退出 → 别的窗口可获取
	reentry.Release()
	other, err := s.acquireLease(ctxOther, p, "test-edit")
	if err != nil {
		t.Fatalf("释放后应可重新获取：%v", err)
	}
	other.Release()

	// Release 幂等：重复调用不再退桶、不 panic
	again, err := s.acquireLease(ctxMain, p, "test-edit")
	if err != nil {
		t.Fatal(err)
	}
	again.Release()
	again.Release()
	if _, err := s.acquireLease(ctxOther, p, "test-edit"); err != nil {
		t.Fatalf("幂等 Release 过早释放了租约：%v", err)
	}
}

// 无归属窗口（测试 / 非绑定路径）维持单桶语义：refcount 重入照旧，行为与改造前一致。
func TestAcquireLeaseEmptyOwnerKeepsSingleBucket(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	p := resolvePaths(ws)

	prev := OwnerForCall
	OwnerForCall = nil
	t.Cleanup(func() { OwnerForCall = prev })

	ctx := context.Background()
	a, err := s.acquireLease(ctx, p, "test-edit")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.acquireLease(ctx, p, "test-edit")
	if err != nil {
		t.Fatalf("空 ownerKey 的重入应成功：%v", err)
	}
	a.Release()
	b.Release()
	if _, err := s.acquireLease(ctx, p, "test-edit"); err != nil {
		t.Fatalf("引用退净后应可获取：%v", err)
	}
}

// 清理门闩（AcquireNoShare）与分桶表要互相看得见：窗口持写权时清理被拒，
// 清理持有时编辑被拒（前者由 holders 挡住，后者由 resourcelease 的 noShare 挡住）。
func TestLeaseBucketAndClearGateInterlock(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	p := resolvePaths(ws)
	ctx := withLeaseOwner(t, "main")

	lease, err := s.acquireLease(ctx, p, "test-edit")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.LockForClear(ws); err == nil {
		t.Fatal("窗口持写权时清理门闩应报忙")
	}
	lease.Release()

	release, err := s.LockForClear(ws)
	if err != nil {
		t.Fatalf("租约退净后清理门闩应可获取：%v", err)
	}
	if _, err := s.acquireLease(ctx, p, "test-edit"); err == nil {
		t.Fatal("清理持有时编辑应报忙")
	}
	release()
}
