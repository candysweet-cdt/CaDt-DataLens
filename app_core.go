package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"datalens/internal/activity"
	"datalens/internal/aiartifact"
	"datalens/internal/aibacking"
	"datalens/internal/aicatalog"
	"datalens/internal/aichat"
	"datalens/internal/aiconfig"
	"datalens/internal/aigen"
	"datalens/internal/aigroups"
	"datalens/internal/aiimagepolicy"
	"datalens/internal/aimemory"
	"datalens/internal/aipermissions"
	"datalens/internal/aischedule"
	"datalens/internal/aitimer"
	"datalens/internal/aiusage"
	"datalens/internal/aiworklog"
	"datalens/internal/appconfig"
	"datalens/internal/applog"
	"datalens/internal/appservices"
	"datalens/internal/browser"
	"datalens/internal/cmdbridge"
	"datalens/internal/cognition"
	"datalens/internal/convertcli"
	"datalens/internal/dbclient"
	"datalens/internal/debugconsole"
	"datalens/internal/desktopmcp"
	"datalens/internal/envvars"
	"datalens/internal/fileio"
	"datalens/internal/fsops"
	"datalens/internal/gitinfo"
	"datalens/internal/integration"
	"datalens/internal/launchargs"
	"datalens/internal/mavenproject"
	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
	"datalens/internal/memo"
	"datalens/internal/notify"
	"datalens/internal/orchestration"
	"datalens/internal/patch"
	"datalens/internal/plugins"
	"datalens/internal/previewassets"
	"datalens/internal/reading"
	"datalens/internal/run"
	"datalens/internal/runproject"
	"datalens/internal/sandbox"
	"datalens/internal/screenshot"
	"datalens/internal/search"
	"datalens/internal/secondinstance"
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
	"datalens/internal/skills"
	"datalens/internal/sqlview"
	"datalens/internal/structuredir"
	"datalens/internal/terminal"
	"datalens/internal/toolchain"
	"datalens/internal/tray"
	"datalens/internal/update"
	"datalens/internal/usagestats"
	"datalens/internal/watch"
	"datalens/internal/webtools"
	"datalens/internal/winutil"
	"datalens/internal/workspacemark"
)

const appVersion = "v1.3.0"

// 绑定承载类型的别名：App 匿名嵌入后，包内 Service 的导出方法自动进 *App
// 方法集（v3 的绑定面即方法集），前端 FQN 仍是 main.App.<Method>。
//
// 为什么用别名而不是直接嵌 *memo.Service：Go 的匿名嵌入要求同一类型只能出现
// 一次，而 App 已经有 *sessionstore.Service（字段名 Service）；每个域一个未导出
// 别名，字段名互不相同，方法提升与绑定名都不受影响。
type (
	memoService          = memo.Service
	sessionindexService  = sessionindex.Service
	activityService      = activity.Service
	usagestatsService    = usagestats.Service
	previewassetsService = previewassets.Service

	aiArtifactService    = aiartifact.Service
	aiBackingService     = aibacking.Service
	aiCatalogService     = aicatalog.Service
	aiGenService         = aigen.Service
	aiImagePolicyService = aiimagepolicy.Service
	aiUsageService       = aiusage.Service
	aiWorklogService     = aiworklog.Service
	aiMemoryService      = aimemory.Service
	aiPermissionsService = aipermissions.Service
	workspaceMarkService = workspacemark.Service
	cognitionBindings    = cognition.Bindings

	mavenService         = mavenproject.Service
	sandboxService       = sandbox.Service
	runProjectService    = runproject.Service
	sqlviewService       = sqlview.Service
	updateService        = update.Service
	envvarsService       = envvars.Service
	patchService         = patch.Service
	webtoolsService      = webtools.Service
	structuredirService  = structuredir.Service
	dbclientService      = dbclient.Service
	gitinfoService       = gitinfo.Service
	desktopmcpService    = desktopmcp.Service
	winutilService       = winutil.Service
	orchestrationService = orchestration.Service
)

type App struct {
	*reading.Reader                              // 阅读模式引擎（internal/reading），提升方法即 Wails 绑定
	*run.Runner                                  // 运行代码引擎（internal/run）
	*browser.Host                                // 内嵌浏览器引擎（internal/browser）
	*search.Searcher                             // 工作区检索 / glob（internal/search）
	*aischedule.Scheduler                        // AI 定时任务调度器（internal/aischedule）
	*cmdbridge.Bridge                            // 进程桥：插件 / AI 终端命令（internal/cmdbridge）
	*terminal.Terminal                           // 内置终端后端（internal/terminal）
	*toolchain.Toolchain                         // 语言环境检测（internal/toolchain）
	*aiconfig.Store                              // AI 配置文件读写（internal/aiconfig）
	*plugins.Manager                             // 插件与市场（internal/plugins）
	AppServices            *appservices.Registry // 插件后台服务托管（internal/appservices）
	*skills.Skills                               // 内置技能与 agent 技能注册（internal/skills）
	*screenshot.Capturer                         // 应用窗口截图（internal/screenshot）
	*notify.Notifier                             // 系统通知（internal/notify）
	*watch.Watcher                               // 工作区文件监听（internal/watch）
	*fileio.Files                                // 文件读写与编码（internal/fileio）
	*fsops.FS                                    // 目录与条目操作（internal/fsops）
	*debugconsole.Console                        // 调试控制台日志（internal/debugconsole）
	*aichat.Chat                                 // AI 对话与流注册表（internal/aichat）
	*integration.Registrar                       // Windows 文件关联 / 右键菜单 / PATH（internal/integration）
	*mcpsamples.Samples                          // 内置 MCP 示例（internal/mcpsamples）
	*sessionstore.Service                        // AI 会话磁盘存储（internal/sessionstore）
	*aigroups.GroupStore                         // AI 群聊磁盘存储（internal/aigroups），提升方法即 AIGroup* 绑定
	*mcp.Client                                  // MCP 客户端与子进程管理（internal/mcp）
	*memoService                                 // 快捷便签存储（internal/memo），提升方法即 Memo* 绑定
	*sessionindexService                         // AI 会话搜索索引（internal/sessionindex）
	*activityService                             // 操作留痕（internal/activity）
	*usagestatsService                           // AI 使用统计（internal/usagestats）
	*previewassetsService                        // 预览资源注册表（internal/previewassets）
	*aiArtifactService                           // AI 工具结果大对象落盘区（internal/aiartifact）
	*aiBackingService                            // 会话沙盒工作区（internal/aibacking）
	*aiCatalogService                            // 模型配置表（internal/aicatalog）
	*aiGenService                                // 生图/视频执行通道（internal/aigen）
	*aiImagePolicyService                        // AI 图片三层限制（internal/aiimagepolicy）
	*aiUsageService                              // 余额/用量查询（internal/aiusage）
	*aiWorklogService                            // AI 工作日志（internal/aiworklog）
	*aiMemoryService                             // AI 记忆文件写通道（internal/aimemory）
	*aiPermissionsService                        // 工作区权限规则写通道（internal/aipermissions）
	*workspaceMarkService                        // 工作区「已打开过」账本（internal/workspacemark）
	*cognitionBindings                           // 工作区认知索引（internal/cognition）
	*mavenService                                // Maven 项目结构（internal/mavenproject）
	*sandboxService                              // 子代理沙箱授权痕迹（internal/sandbox）
	*runProjectService                           // 项目感知运行探测（internal/runproject）
	*sqlviewService                              // 只读 SQL 查询（internal/sqlview）
	*updateService                               // 检查更新（internal/update）
	*envvarsService                              // 环境变量配置（internal/envvars）
	*patchService                                // 补丁只读审阅解析（internal/patch）
	*webtoolsService                             // 联网工具与外部工具配置（internal/webtools）
	*structuredirService                         // 目录结构导出（internal/structuredir）
	*dbclientService                             // 数据库连接与浏览（internal/dbclient）
	*gitinfoService                              // Git 浅集成与图谱（internal/gitinfo）
	*desktopmcpService                           // 桌面控制（windows-mcp）安装与诊断（internal/desktopmcp）
	*winutilService                              // 系统光标等纯平台能力（internal/winutil）
	*orchestrationService                        // 多会话编排控制面（internal/orchestration）
	ctx                    context.Context
	aiTimersMu             sync.Mutex
	aiTimers               *aitimer.Registry
	convert                *convertcli.Options
	convertExitCode        int
	convertDone            atomic.Bool

	// 关闭行为：点窗口 X 是直接退出（exit）还是隐藏到托盘（tray）。见 window_close.go。
	closeAction   string
	quitRequested atomic.Bool // 显式「退出」（菜单 / 托盘右键 / ForceClose）时置位，绕开「最小化到托盘」
	teardownDone  atomic.Bool // 应用级服务（托盘/MCP/插件/工作区监听）只收口一次
	// --quit 优雅退出（外部重建脚本 / 工具）：各窗口结算 AI 回合后 ack，收齐或超时才退出。
	// 状态见 window_close.go 的 beginGracefulQuit。
	gracefulQuitStarted atomic.Bool
	gracefulAcksMu      sync.Mutex
	gracefulAcks        map[string]bool
	tray                *tray.Tray
	trayHintShown       bool
}

// FileData 兼容别名（实现已下沉 internal/fileio）。
type FileData = fileio.FileData

func NewApp() *App {
	return &App{Reader: &reading.Reader{}, Runner: &run.Runner{}, Host: &browser.Host{}, Searcher: &search.Searcher{}, Scheduler: &aischedule.Scheduler{}, Bridge: &cmdbridge.Bridge{}, Terminal: &terminal.Terminal{}, Toolchain: &toolchain.Toolchain{}, Store: &aiconfig.Store{}, Manager: &plugins.Manager{}, AppServices: appservices.New(), Skills: &skills.Skills{}, Capturer: &screenshot.Capturer{}, Notifier: &notify.Notifier{}, Watcher: &watch.Watcher{}, Samples: &mcpsamples.Samples{}, Files: &fileio.Files{}, FS: &fsops.FS{}, Registrar: &integration.Registrar{}, Console: &debugconsole.Console{}, Chat: &aichat.Chat{}, Service: &sessionstore.Service{}, GroupStore: &aigroups.GroupStore{}, Client: &mcp.Client{}, memoService: &memo.Service{}, sessionindexService: &sessionindex.Service{}, activityService: &activity.Service{}, usagestatsService: &usagestats.Service{}, previewassetsService: &previewassets.Service{}, aiArtifactService: &aiartifact.Service{}, aiBackingService: &aibacking.Service{}, aiCatalogService: &aicatalog.Service{}, aiGenService: &aigen.Service{}, aiImagePolicyService: &aiimagepolicy.Service{}, aiUsageService: &aiusage.Service{}, aiWorklogService: &aiworklog.Service{}, aiMemoryService: &aimemory.Service{}, aiPermissionsService: &aipermissions.Service{}, workspaceMarkService: &workspacemark.Service{}, cognitionBindings: cognition.NewBindings(func(format string, args ...any) {
		applog.Write("info", "cognition: "+format, args...)
	}), mavenService: &mavenproject.Service{}, sandboxService: &sandbox.Service{}, runProjectService: &runproject.Service{}, sqlviewService: &sqlview.Service{}, updateService: &update.Service{}, envvarsService: &envvars.Service{}, patchService: &patch.Service{}, webtoolsService: &webtools.Service{}, structuredirService: &structuredir.Service{}, dbclientService: &dbclient.Service{}, gitinfoService: &gitinfo.Service{}, desktopmcpService: &desktopmcp.Service{}, winutilService: &winutil.Service{}, orchestrationService: &orchestration.Service{}}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 关闭行为（点 X 退出还是最小化到托盘）：配置在 config.json，前端设置页只负责推过来。
	a.closeAction = appconfig.CloseAction()
	reading.Emit = func(event string, data any) {
		routeOwnedEvent("reading", event, data)
	}
	run.Emit = func(event string, data any) {
		routeOwnedEvent("run", event, data)
	}
	browser.Emit = func(event string, data any) {
		routeOwnedEvent("browser", event, data)
	}
	aischedule.Emit = func(event string, data any) {
		emitAppEvent(event, data)
	}
	cmdbridge.Emit = func(event string, data any) {
		routeOwnedEvent("cmd", event, data)
	}
	terminal.Emit = func(event string, data any) {
		routeOwnedEvent("term", event, data)
	}
	watch.Emit = func(event string, data any) {
		emitAppEvent(event, data)
	}
	aichat.Emit = func(event string, payload any) {
		emitAppEvent(event, payload)
	}
	watch.Logf = writeAppLog
	if a.convert != nil {
		a.waitConvertTimeout()
		return
	}
	// 系统通知的应用标识必须在发出第一条 Toast 之前登记好，
	// 否则 Windows 只返回成功、不显示（见 internal/notify 的 ensureToastAppID）。
	// 点击通知的激活回调也在这里接上：把窗口拉回前台 + 把激活参数转给前端。
	notify.OnToastActivation = a.onToastActivation
	notify.Prepare()
	sqlview.CleanupTempFiles()
	reading.CleanupCacheOnStartup()
	// 运行代码的临时副本 / 编译产物：启动时清一次过期的（7 天），失败不影响启动；
	// 多窗口可能各跑一次，RemoveAll 幂等所以无害。
	go func() { _, _ = a.CleanupRunTempStale() }()
	// 全局热键与显示器布局看护：与窗口模式无关，进程活着就工作。
	a.registerGlobalHotkeys()
	a.startScreenWatch()
	// 无主窗口的形态（--ai-float / --debug-console / 终端独立窗口作首窗）：
	// AI 定时任务、插件后台服务、MCP 客户端、使用统计都是主窗口域的服务，
	// 不在这里拉起（ctx 之外拿不到窗口形态，直接按主窗口数判定）。
	// AI 侧服务只在有主窗口的进程里拉起；浮窗/调试台/终端窗首启时先跳过，
	// 之后开出的第一个主窗口经 ensureAIServices 惰性补齐（审查 P2-1：v3 单进程
	// 多窗口后窗口形态可动态变化，一次性门控会漏掉后续主窗口）。
	if winReg.CountMain() > 0 {
		a.ensureAIServices()
	}
	// 外部文件拖放由前端 runtime.OnFileDrop 注册窗口监听并直接打开；
	// 这里不再订阅 wails:file-drop，否则同一次拖放会被两侧各处理一遍。
}

// aiServicesOnce：AI 定时任务 / 插件后台服务 / MCP 客户端 / 使用统计只在
// 首个主窗口出现时初始化一次（startup 时有主窗口直接拉起；没有则由后续
// createWindow(main) 补齐）。
var aiServicesOnce sync.Once

func (a *App) ensureAIServices() {
	aiServicesOnce.Do(func() {
		// 多会话编排：加载磁盘真源并做冷启动恢复，随后 supervisor/auditor 各自起循环。
		if err := orchestration.StartDefault(); err != nil {
			writeAppLog("warn", "编排引擎启动失败：%v", err)
		}
		// AI 定时任务调度器：主窗口与 AI 悬浮窗各自扫描，执行去重由前端裁决
		aischedule.Start()
		// 插件后台服务：启动已声明且 autoStart 的服务（声明由前端加载插件后 Sync 推送；
		// 此处对空注册表无害，保留以覆盖未来持久化声明的场景）。
		a.AppServices.StartAll()
		// MCP 客户端 + 使用统计回填（浮窗/调试控制台/终端窗口不拉子进程/不扫会话）
		usagestats.Start()
		if err := mcp.InitClient(a.Client, func(event string, payload any) {
			emitAppEvent(event, payload)
		}); err != nil {
			// 损坏的 mcp.json 不阻塞启动：设置页会读到同样的错误并展示路径
			writeAppLog("warn", "MCP 配置加载失败：%v", err)
		}
	})
}

func (a *App) secondInstance(args []string) {
	plan := secondinstance.Decide(args, secondinstance.Deps{
		ResolveSessionWorkspace: a.ResolveSessionWorkspace,
		RouteWindowForPath:      routeWindowForPath,
		Warnf: func(format string, args ...any) {
			writeAppLog("warn", format, args...)
		},
	})
	switch plan.Kind {
	case "quit":
		// --quit：外部（重建脚本等）请求优雅退出。绕开一切确认框：先让各窗口结算 AI
		// 回合并落盘，收齐 ack（或超时）再 ForceQuitAll。见 window_close.go。
		a.beginGracefulQuit()
		return
	case "float":
		a.ensureFloatWindow(plan.Targets...)
		return
	case "debug":
		a.ensureDebugWindow()
		return
	}
	// 下面这些分支都会把某个窗口拉到前台：顺手清托盘态（v2 每分支都走
	// secondInstanceShow，审查 P2-2）。
	a.clearTrayState()
	switch plan.Kind {
	case "settings":
		// 无主窗口形态回退浮窗（与 OpenSettingsInMainWindow 同构，审查 P2-1）。
		st := winReg.Primary()
		if st == nil {
			st = winReg.Get("float")
		}
		if st != nil {
			emitWindowEventTo(st.Window(), "app-open-settings", plan.Pane)
			if st.Startup().Mode == windowModeMain && len(plan.Targets) > 0 {
				deliverOpenTargets(st, openTargetsAny(plan.Targets))
			}
			activateWindow(st.Window())
		}
	case "memo":
		st := winReg.Primary()
		if st == nil {
			st = winReg.Get("float")
		}
		if st != nil {
			emitWindowEventTo(st.Window(), "app-open-memo", plan.Locator)
			if st.Startup().Mode == windowModeMain && len(plan.Targets) > 0 {
				deliverOpenTargets(st, openTargetsAny(plan.Targets))
			}
			activateWindow(st.Window())
		}
	case "sessionOpen":
		a.openMainWindow(windowSpec{Workspace: plan.Workspace, SessionID: plan.SessionID})
	case "newWindow":
		a.openMainWindow(windowSpec{Targets: plan.Targets, SessionID: plan.SessionID})
	case "harnessWindow":
		// harness 形态的新窗口：Harness=true 会一路传到 windowreg.Spec，
		// 前端 GetWindowHarness() 据此置 window.__harnessWindow（不恢复工作区、根跟会话）。
		a.openMainWindow(windowSpec{Harness: true, Targets: plan.Targets, SessionID: plan.SessionID})
	case "deliver":
		if len(plan.Groups) == 0 {
			a.secondInstanceShow()
			return
		}
		var sessionTarget *windowState
		for _, g := range plan.Groups {
			st := a.deliverGroup(g)
			// 缺陷 C：第一个工作区与会话归属一致的接收窗口补投会话
			//（前端 handleReuseSessionRequest 要求 workspace 匹配）。
			if st != nil && plan.SessionID != "" && sessionTarget == nil &&
				pathKeyForCompare(st.Workspace()) == pathKeyForCompare(plan.Workspace) {
				sessionTarget = st
			}
		}
		if sessionTarget != nil {
			emitWindowEventTo(sessionTarget.Window(), "app-open-ai-session", map[string]string{
				"workspace": plan.Workspace,
				"sessionId": plan.SessionID,
			})
		} else if plan.SessionID != "" {
			// 会话归属解析成功但没有任何接收窗口的工作区匹配：丢弃会话（保持打开
			// 文件），warn 对齐 forwardPlan 注释与提交信息的行为描述。
			writeAppLog("warn", "--ai-session 转发：无工作区匹配的接收窗口（会话 %q 归属 %q），仅投递文件", plan.SessionID, plan.Workspace)
		}
	default:
		a.secondInstanceShow()
	}
}

// deliverGroup 把一组打开目标投给路由指定的窗口。无名组无主窗口存活时开新主窗口
// （旧语义）；路由窗口在转发间隙被关时回落主窗口。返回实际接收的窗口状态
// （可能 nil），供会话补投比对工作区。
func (a *App) deliverGroup(g secondinstance.Group) *windowState {
	var st *windowState
	if g.WindowName == "" {
		st = winReg.Primary()
		if st == nil {
			a.openMainWindow(windowSpec{Targets: g.Targets})
			return nil
		}
	} else {
		st = winReg.Get(g.WindowName)
		if st == nil {
			st = winReg.Primary()
		}
	}
	if st == nil {
		return nil
	}
	deliverOpenTargets(st, openTargetsAny(g.Targets))
	return st
}

// openTargetsAny 把 []launchargs.OpenTarget 转成事件投递的 []any（JSON 形状不变）。
func openTargetsAny(targets []launchargs.OpenTarget) []any {
	out := make([]any, 0, len(targets))
	for _, t := range targets {
		out = append(out, t)
	}
	return out
}

// onToastActivation 系统通知被点击（internal/notify 的 COM 激活回调，可能在任意 COM 线程触发）：
// 先把主窗口拉回前台，再把激活参数原文发给前端自行解析跳转（空参数只拉窗口）。
func (a *App) onToastActivation(payload string) {
	if a.ctx == nil {
		return
	}
	st := winReg.Primary()
	if st == nil {
		// 无主窗口形态（浮窗单独运行）：通知点击回退唤起浮窗（审查 P2-9）。
		st = winReg.Get("float")
	}
	if st != nil {
		activateWindow(st.Window())
		if strings.TrimSpace(payload) != "" {
			emitWindowEventTo(st.Window(), "ai-notify-activate", payload)
		}
	}
}

// ConsumeStartupSettings 返回该窗口启动时携带的设置页并清空（供前端启动后打开）。
func (a *App) ConsumeStartupSettings(ctx context.Context) string {
	st := stateForCaller(ctx)
	if st == nil {
		return ""
	}
	return st.TakeSettingsPane()
}

// GetStartupAISession 返回该窗口启动时要打开的 AI 会话 id（软切换新窗口使用）。
func (a *App) GetStartupAISession(ctx context.Context) string {
	if st := stateForCaller(ctx); st != nil {
		return st.Startup().SessionID
	}
	return ""
}

// GetStartupMemoLocator 返回该窗口启动时要跳转的便签定位点（cadt-memo://scope/kind/id）。
func (a *App) GetStartupMemoLocator(ctx context.Context) string {
	if st := stateForCaller(ctx); st != nil {
		return st.Startup().MemoLocator
	}
	return ""
}

// GetWindowHarness 报告调用方窗口是否由 --harness 启动（不恢复上次工作区、根由会话自己绑定）。
// 前端据此置 window.__harnessWindow（scopeRootOf 的第 3 步），无窗口上下文回 false。
func (a *App) GetWindowHarness(ctx context.Context) bool {
	if st := stateForCaller(ctx); st != nil {
		return st.Startup().Harness
	}
	return false
}

func (a *App) GetStartupTargets(ctx context.Context) []launchargs.OpenTarget {
	st := stateForCaller(ctx)
	if st == nil {
		return []launchargs.OpenTarget{}
	}
	targets := st.Startup().Targets
	if len(targets) == 0 {
		return launchargs.StartupCwdTarget()
	}
	return targets
}

func (a *App) GetStartupFiles(ctx context.Context) []string {
	st := stateForCaller(ctx)
	if st == nil {
		return []string{}
	}
	targets := st.Startup().Targets
	files := make([]string, 0, len(targets))
	for _, target := range targets {
		files = append(files, target.Path)
	}
	return files
}

// hasArg 判断启动参数里是否带有某个开关（独立窗口/调试控制台等）。
func hasArg(flag string) bool {
	return launchargs.HasFlag(os.Args[1:], flag)
}
