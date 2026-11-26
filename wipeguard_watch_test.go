package main

// wipeguard_watch_test.go：wipe-guard 多根监听绑定与「工作区已打开过」账本的绑定面。
//
// 槽位簿记本身（不同归属者各持各的、按归属只摘自己）已由 internal/watch 的
// ownership_test.go 覆盖；这里只守绑定层的三件事：① 校验（空根 / 不存在的目录直接
// 报错，不留下空槽）；② 注销幂等（未知根静默返回 nil）；③ 合成槽的记账在无窗口
// 上下文时不登记（否则测试/非绑定路径会凭空长出关窗也摘不掉的槽）。
//
// 有窗口上下文的路径（callerWindowName 从 Wails ctx 取）在单测里造不出来，
// 关窗清理只能手验：STATUS.md 已标注。

import (
	"context"
	"path/filepath"
	"testing"

	"datalens/internal/watch"
	"datalens/internal/workspacemark"
)

func newWatchTestApp() *App {
	return &App{Watcher: &watch.Watcher{}}
}

func TestWatchWipeguardRootValidation(t *testing.T) {
	app := newWatchTestApp()
	ctx := context.Background()
	if err := app.WatchWipeguardRoot(ctx, "  "); err == nil {
		t.Fatal("空根应报错")
	}
	if err := app.WatchWipeguardRoot(ctx, filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("不存在的目录应报错")
	}
	// 同一目录不同拼写：第二次是换槽（不是新增），不该报错
	root := t.TempDir()
	if err := app.WatchWipeguardRoot(ctx, root); err != nil {
		t.Fatalf("订阅失败：%v", err)
	}
	if err := app.WatchWipeguardRoot(ctx, filepath.ToSlash(root)+"/"); err != nil {
		t.Fatalf("同目录不同拼写应幂等：%v", err)
	}
	// 注销幂等：未知根与空根都静默
	if err := app.UnwatchWipeguardRoot(ctx, root); err != nil {
		t.Fatal(err)
	}
	if err := app.UnwatchWipeguardRoot(ctx, ""); err != nil {
		t.Fatalf("空根注销应静默返回 nil：%v", err)
	}
	app.Watcher.UnwatchAll()
}

// 无窗口上下文（测试 / 非绑定路径）不写记账表：否则这些槽永远等不到关窗清理。
func TestReleaseWipeguardSlotsWithoutWindow(t *testing.T) {
	app := newWatchTestApp()
	if n := releaseWipeguardSlots(nil, "main"); n != 0 {
		t.Fatalf("nil watcher 应返回 0，got %d", n)
	}
	if n := releaseWipeguardSlots(app.Watcher, ""); n != 0 {
		t.Fatalf("空窗口名不该摘任何槽，got %d", n)
	}
	if n := releaseWipeguardSlots(app.Watcher, "从未登记的窗口"); n != 0 {
		t.Fatalf("未登记的窗口应返回 0，got %d", n)
	}
	app.Watcher.UnwatchAll()
}

func TestWorkspaceMarkOpenedBinding(t *testing.T) {
	workspacemark.Reset()
	app := &App{workspaceMarkService: &workspacemark.Service{}}
	dir := t.TempDir()
	if !app.WorkspaceMarkOpened(dir) {
		t.Fatal("首次应返回 true")
	}
	if app.WorkspaceMarkOpened(dir) {
		t.Fatal("重复应返回 false")
	}
	if app.WorkspaceMarkOpened("") {
		t.Fatal("空路径应返回 false")
	}
	// 归一化：分隔符/尾斜杠/大小写同一份
	if app.WorkspaceMarkOpened(filepath.ToSlash(dir) + "/") {
		t.Fatal("归一化后应视为已打开")
	}
}
