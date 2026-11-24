package main

// app_field_bindings.go：包装 App 已嵌入字段的绑定壳与生命周期接线。
//
// 由两个同族文件合并而来（2026-11-24 三期结构化）：
//   - appservices_app.go：插件后台服务（a.AppServices = *appservices.Registry）
//   - resource_watch_app.go：工作区/资源监听（a.Watcher = *watch.Watcher）
//
// 共同点：绑定方法都只是转发到 App 的嵌入字段，不新增独立引擎；因此不服务化
// （再套一层 Service 会把 Registry/Watcher 的 Start/Stop/Sync 提升成前端可调绑定，
// 正是 Scheduler.Start、Manager.EnsureDir 那类事故）。合并在一个文件里只是让
// 「包装 App 字段」这一类壳有明确归属，职责仍是两节分开的。

import (
	"context"
	"strings"

	"datalens/internal/appservices"
	"datalens/internal/memo"
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
	"datalens/internal/watch"
)

func init() {
	appservices.Logf = writeAppLog

	// 资源目录监听的 ai-session 变更异步标脏派生索引（MarkDirty 走 SQLite，回调必须快）。
	watch.Resources.OnEvent = func(kind, key string, paths []string, overflow bool) {
		if kind != "ai-session" {
			return
		}
		if overflow || len(paths) == 0 {
			go sessionindex.MarkDirty(key)
			return
		}
		for _, path := range paths {
			norm := strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
			if strings.HasSuffix(norm, "session.v1.jsonl") || strings.HasSuffix(norm, "meta.json") {
				go sessionindex.MarkDirty(key)
				return
			}
		}
	}
}

// ==================== 插件后台服务（原 appservices_app.go）====================
// 引擎只负责声明服务的启停/健康/日志，声明本身由前端插件在加载完成后 Sync 推送。

// AppServiceSync 用当前插件声明覆盖服务注册表：不再声明的服务停止并移除，
// spec 变化的服务重启，autoStart 的服务拉起。前端每次 loadPlugins 后调用。
func (a *App) AppServiceSync(specs []appservices.Spec) error {
	return a.AppServices.Sync(specs)
}

// AppServiceStart 手动启动一个服务。
func (a *App) AppServiceStart(id string) error {
	return a.AppServices.Start(id)
}

// AppServiceStop 手动停止一个服务。
func (a *App) AppServiceStop(id string) error {
	return a.AppServices.Stop(id)
}

// AppServiceStatus 查询单个服务状态。
func (a *App) AppServiceStatus(id string) (appservices.Status, error) {
	st, ok := a.AppServices.Status(id)
	if !ok {
		return appservices.Status{}, nil
	}
	return st, nil
}

// AppServiceList 列出所有服务的状态。
func (a *App) AppServiceList() []appservices.Status {
	return a.AppServices.List()
}

// AppServiceLogs 返回服务日志行。
func (a *App) AppServiceLogs(id string) []string {
	return a.AppServices.Logs(id)
}

// ==================== 资源/工作区监听（原 resource_watch_app.go）====================
// 监听本身在 internal/watch；这里只做四件事：按业务 id 解析目录、把 ai-session
// 的变更异步标脏派生索引、暴露 Wails 绑定（一律带 ctx——监听槽位按调用方窗口
// 键控，v3 多窗口下后开窗口不顶掉先开窗口）、窗口关闭时按归属摘除。

// watchOwnerName 绑定调用方窗口名（watch / memo 的归属键）。空串 = 兼容测试与
// 非绑定路径（引擎回落旧格式单例语义）。
func watchOwnerName(ctx context.Context) string {
	return callerWindowName(ctx)
}

// WatchWorkspace 监听调用方窗口的工作区根（v3 多窗口：槽位按窗口键控，后开窗口
// 不再顶掉先开窗口的 workspace-changed——2026-11-21 审查第 1 项）。
func (a *App) WatchWorkspace(ctx context.Context, root string) error {
	return a.Watcher.WatchWorkspaceFor(watchOwnerName(ctx), root)
}

// UnwatchWorkspace 停掉调用方窗口的工作区监听。
func (a *App) UnwatchWorkspace(ctx context.Context) error {
	a.Watcher.UnwatchWorkspaceFor(watchOwnerName(ctx))
	return nil
}

// MemoWatch 监听一个便签作用域目录（按调用方窗口键控；工作区作用域已有
// workspace-changed，前端只需对全局作用域调用）。
func (a *App) MemoWatch(ctx context.Context, scope, workspace string) error {
	root, err := memo.RootPath(scope, workspace)
	if err != nil {
		return err
	}
	return watch.Resources.Watch(watchOwnerName(ctx), "memo", scope, root)
}

// MemoUnwatch 停止调用方窗口的便签目录监听。
func (a *App) MemoUnwatch(ctx context.Context, scope, workspace string) error {
	watch.Resources.Unwatch(watchOwnerName(ctx), "memo", scope)
	return nil
}

// AISessionWatch 监听当前打开的会话目录（按调用方窗口键控）；目录不存在（新会话）时返回错误，前端忽略。
func (a *App) AISessionWatch(ctx context.Context, id string) error {
	store, err := sessionstore.Default()
	if err != nil {
		return err
	}
	dir, err := store.SessionDir(id)
	if err != nil {
		return err
	}
	return watch.Resources.Watch(watchOwnerName(ctx), "ai-session", id, dir)
}

// AISessionUnwatch 停止调用方窗口的会话目录监听。
func (a *App) AISessionUnwatch(ctx context.Context, id string) error {
	watch.Resources.Unwatch(watchOwnerName(ctx), "ai-session", id)
	return nil
}

// releaseWindowOwnedState 窗口关闭时摘掉该窗口名下的一切监听与租约（工作区监听
// 槽 / 资源监听 / memo 写权租约）。浏览器实例的回收单独走 BrowserCloseByOwner
// （见 window_factory.go 的 WindowClosing 钩子）。
func (a *App) releaseWindowOwnedState(owner string) {
	if owner == "" {
		return
	}
	a.Watcher.UnwatchWorkspaceFor(owner)
	if n := watch.Resources.UnwatchByOwner(owner); n > 0 {
		writeAppLog("info", "窗口关闭摘除资源监听：%s ×%d", owner, n)
	}
	memo.ReleaseLeaseByOwner(owner)
	// 回合租约：窗口带着运行中的回合关掉时释放，别的窗口可按交接协议接管
	if n := a.Service.AISessionLeaseReleaseByOwner(owner); n > 0 {
		writeAppLog("info", "窗口关闭释放回合租约：%s ×%d", owner, n)
	}
	// 群讨论租约：同批（multi-instance-sync P6 收尾）
	if n := a.GroupStore.GroupLeaseReleaseByOwner(owner); n > 0 {
		writeAppLog("info", "窗口关闭释放群讨论租约：%s ×%d", owner, n)
	}
}
