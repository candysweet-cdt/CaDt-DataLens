package main

// host_wiring.go：各引擎包的宿主注入（init 阶段一次性接线）。
//
// 这些原本是每域一个 `*_app.go`（10–20 行，只做 deps 注入、零绑定方法），
// 合并成一个文件后仍然按域分节，节标题保留原文件名便于追溯。
//
// **init 顺序纪律**：Go 的 init 先按文件名字典序、同一文件内按声明顺序。
// 本文件内各节只注入「自身包的 deps」，彼此无先后依赖；但有一处跨文件依赖必须
// 知道：`desktop_mcp.go`（字典序 d）在本文件（h）之前执行，它注入的
// mcp.PrepareServer 闭包读取 mcp.Logf——那边刻意写成转发闭包而不是取函数值，
// 就是为了避免捕获本文件赋值之前的 nil（2026-11-23 审查 M3）。新增接线时同样
// 不要在同包 init 之间取函数值快照，一律转发。

import (
	"context"

	"datalens/internal/activity"
	"datalens/internal/aicatalog"
	"datalens/internal/aichat"
	"datalens/internal/aigen"
	"datalens/internal/aigroups"
	"datalens/internal/aischedule"
	"datalens/internal/aitransport"
	"datalens/internal/aiusage"
	"datalens/internal/aiworklog"
	"datalens/internal/applog"
	"datalens/internal/browser"
	"datalens/internal/cognition"
	"datalens/internal/dbclient"
	"datalens/internal/envvars"
	"datalens/internal/fileio"
	"datalens/internal/gitinfo"
	"datalens/internal/mcp"
	"datalens/internal/memo"
	"datalens/internal/notify"
	"datalens/internal/orchestration"
	"datalens/internal/reading"
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
	"datalens/internal/structuredir"
	"datalens/internal/update"
	"datalens/internal/usagestats"
	"datalens/internal/watch"
)

func init() {
	// ---- 多会话编排（internal/orchestration）----
	// 状态真源落 <appdata>/orchestrations；事件经应用广播、前端按 payload.root 过滤。
	// supervisor 的 session_gone 只查会话目录是否存在，不向 UI 询问“还在跑吗”。
	notifier := &notify.Notifier{}
	orchestration.Configure(appDataRoot(), orchestration.Deps{
		Emit: func(event string, payload any) { emitAppEvent(event, payload) },
		Notify: func(title, body, payload string) {
			_ = notifier.NotifySystemToast(title, body, payload, false)
		},
		SessionExists: sessionstore.SessionExists,
		WorkspaceAvailable: func(workspace string) bool {
			key := pathKeyForCompare(workspace)
			if key == "" {
				return false
			}
			for _, st := range winReg.List() {
				if st.Startup().Mode != windowModeMain || st.Window() == nil {
					continue
				}
				// 多工作区 harness 主窗口按设计不绑定单一目录（Workspace 恒空），
				// 但会话可以在任一已打开仓库里发起编排；派发事件按当前聚焦根投递。
				if st.Workspace() == "" || pathKeyForCompare(st.Workspace()) == key {
					return true
				}
			}
			return false
		},
		Snapshot: func(workspace string) (orchestration.SnapshotResult, error) {
			res, err := wipeGuardService.Snapshot(workspace)
			if err != nil {
				return orchestration.SnapshotResult{}, err
			}
			return orchestration.SnapshotResult{
				Mode: string(res.Mode), Name: res.Name, Path: res.Path, Files: res.Files,
				Bytes: res.Bytes, Skipped: res.Skipped, Excluded: res.Excluded,
			}, nil
		},
		SessionTokens: func(sessionID string) int64 {
			tokens, _ := usagestats.SessionTokens(sessionID)
			return tokens
		},
		Logf: writeAppLog,
	}, orchestration.CallDeps{
		WorkspaceForCall: func(ctx context.Context) string {
			st := stateForCaller(ctx)
			if st == nil {
				return ""
			}
			return st.Workspace()
		},
		WindowForCall: callerWindowName,
		MainWindowForCall: func(ctx context.Context) bool {
			st := stateForCaller(ctx)
			return st != nil && st.Startup().Mode == windowModeMain
		},
	})

	// ---- AI 传输与对话（internal/aitransport + internal/aichat）----
	// 注入诊断日志、应用版本、日志目录、流看门狗挂载点。
	aitransport.Logf = writeAppLog
	aitransport.Version = appVersion
	aitransport.LogsDir = applog.Dir
	aitransport.AttachWatchdog = aichat.AttachWatchdog
	aichat.Logf = writeAppLog

	// ---- AI 定时任务（internal/aischedule）----
	// 事件推送在 startup 拿到 ctx 后接线（见 app_core.go）。
	aischedule.Logf = writeAppLog

	// ---- 内嵌浏览器（internal/browser）----
	// 只注入日志；窗口解析钩子在平台 glue browser_app_windows.go 里接。
	browser.Logf = writeAppLog

	// ---- AI 群聊存储（internal/aigroups）----
	// 根目录 <appdata>/ai-groups/，方案 docs/finished-plans/ai-group-chat.md §6.5。
	// 群聊不进会话搜索索引（§16.8）、无派生索引钩子——共享对话 JSONL 是唯一真源；
	// 绑定方法由 App 匿名嵌入 *aigroups.GroupStore 提升（app_core.go）。
	aigroups.OwnerForCall = callerWindowName
	aigroups.AppDataDir = appDataRoot

	// ---- 阅读模式（internal/reading）----
	// 事件推送在 startup 拿到 ctx 后接线（见 app_core.go）。
	reading.Logf = writeAppLog
	reading.DebugEnabled = func() bool { return applog.DevMode() }

	// ---- 工作区认知索引（internal/cognition）----
	// 写租约的归属窗口名：同进程多窗口下 refcount 会互相放行，按窗口分桶才拦得住
	// 两个窗口同时写同一条卷（sessionstore / memo 同款，见 internal/cognition/lease.go）。
	cognition.OwnerForCall = callerWindowName

	// ---- AI 会话磁盘存储（internal/sessionstore）----
	// 绑定方法随 Service 移入包内，这里只登记应用数据目录与派生索引的标脏钩子。
	sessionstore.AppDataDir = appDataRoot
	sessionstore.OnBodyChange = sessionindex.MarkDirty
	sessionstore.OnMetaChange = sessionindex.UpdateMeta
	sessionstore.OnRemove = sessionindex.Delete
	sessionstore.OnClear = sessionindex.Clear
	// 回合租约的归属窗口名（同进程多窗口跨窗口互斥，2026-11-21 审查遗留）
	sessionstore.OwnerForCall = callerWindowName

	// ---- MCP 客户端（internal/mcp）----
	// 日志、appdata 目录与版本都来自 main 包；图片落地不需要注入——internal/mcp
	// 自带 DefaultImageSaver（%TEMP%/CaDt-DataLens/mcp-images）。
	mcp.Logf = writeAppLog
	mcp.AppDataDir = appDataRoot
	mcp.Version = appVersion

	// ---- 快捷便签 / 会话搜索索引 / 操作留痕 / 使用统计 ----
	// 这四个域的绑定方法已随 Service 嵌入 App（见 app_core.go 的别名），
	// 这里只注入它们需要的应用数据目录、日志与窗口归属。
	memo.SetDeps(memo.Deps{AppDataDir: appDataRoot, OwnerForCall: callerWindowName})
	sessionindex.AppDataDir = appDataRoot
	activity.AppDataDir = appDataRoot
	activity.Logf = writeAppLog
	usagestats.Logf = writeAppLog

	// ---- AI 侧的配置与日志注入（绑定方法已随 Service 嵌入 App）----
	aicatalog.AppDataDir = appDataRoot
	aicatalog.Version = appVersion
	aigen.Version = appVersion
	aiusage.Version = appVersion
	aiworklog.Logf = writeAppLog

	// ---- Git 浅集成 ----
	// 切换/检出分支、丢弃改动、清理这类 git 操作会成批删除工作树文件（切走的那个分支
	// 独有的文件），对 watcher 而言与「大范围文件消失」无异——由发起方声明静默，
	// 不做启发式猜测（2026-11-19 举一反三排查工作区防护误报）。
	gitinfo.OnMutateWorktree = func() func() {
		watch.BeginQuiet()
		return watch.EndQuiet
	}

	// ---- 开发者工具的宿主注入 ----
	update.Version = appVersion
	envvars.AppDataDir = appDataRoot
	dbclient.AppDataDir = appDataRoot
	dbclient.Logf = writeAppLog
	// 目录结构导出的保存对话框与写盘是宿主动作（引擎不碰 Wails 与 App）：
	// 对话框走 wailsApp（App 零值也能用，只要 wailsApp 已创建）；写盘走 fileio。
	structuredir.SetDeps(structuredir.Deps{
		SaveFileDialog: func(title, defaultName, filter string) (string, error) {
			return (&App{}).ShowSaveFileDialog(nil, title, defaultName, filter)
		},
		WriteText: func(path, text string) error {
			return (&fileio.Files{}).SaveFile(path, text, "lf", false, "utf-8")
		},
	})
}

// mcpCloseAll 应用退出前全量关闭（总预算 8s）。beforeClose 与 ForceClose 都走这里。
func (a *App) mcpCloseAll() {
	mcp.CloseClient(a.Client)
}
