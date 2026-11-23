package main

// helloworld

import (
	"embed"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/applog"
	"datalens/internal/convertcli"
	"datalens/internal/crashrecovery"
	"datalens/internal/installercli"
	"datalens/internal/launchargs"
	"datalens/internal/patchcli"
	"datalens/internal/previewassets"
)

//go:embed all:frontend/dist
var assets embed.FS

// disableMiniMenu 禁用 Edge/WebView2 的「文本选中迷你菜单」（mini menu：Select All /
// Paste / Find … 的白色横条，可编辑区域触发，不受应用主题控制也绕过 JS 的
// contextmenu 接管）。
//
// 主窗口走 v3 原生 Windows.DisabledFeatures（见 main 里的 application.Options）；
// 这里仍保留 go-webview2 fork 的注入点，因为内嵌浏览器标签页（internal/browser）
// 直接依赖 fork 的 pkg/edge，需要同一个 feature 列表。
//
// 注意：不能靠 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量——go-webview2 会在
// init() 与每次创建环境时调 preventEnvAndRegistryOverrides() 把它清空，参数根本到不了
// 浏览器进程。改走本地补丁的 COM/环境双通道注入点，见
// third_party/go-webview2/webviewloader/app_browser_args.go。
// 须在 WebView2 环境创建之前调用。
//
// msWebOOUI / msPdfOOUI 是微软在 WebView2Feedback#2140 给出的官方 workaround；
// 后两项是旧实现里的名字，保留以兼容不同 Edge 版本（未知 feature 会被忽略）。
const miniMenuDisabledFeatures = "msWebOOUI,msPdfOOUI,msEdgeMiniMenu,msEdgeTextSelectionMenu"

func disableMiniMenu() {
	setWebViewExtraBrowserArguments("--disable-features=" + miniMenuDisabledFeatures)
}

// cdpDebugArgs 临时调试辅助：CADT_CDP_PORT 非空时给主窗口 WebView2 开远程调试口
// （仅供自动化排查用，正式构建不受影响）
func cdpDebugArgs() []string {
	if p := strings.TrimSpace(os.Getenv("CADT_CDP_PORT")); p != "" {
		return []string{"--remote-debugging-port=" + p}
	}
	return nil
}

// cliUsageText 顶层 --help 输出（不含末尾换行）：GUI 段 + headless 子命令段拼接。
// main() 打印与 cli_help_guard_test.go 对账共用这一份，防两处漂移。
func cliUsageText() string {
	return launchargs.TopLevelUsage + "\n\n" + convertcli.Usage + "\n\n" + patchcli.Usage
}

func main() {
	disableMiniMenu()
	// 顶层 --help / --version：纯信息查询，不进单实例转发、不建窗口（在 installercli
	// 之前判定；--convert / patchcli 各自的子命令 usage 由这里统一拼接，原分支已删）。
	if launchargs.HasFlag(os.Args[1:], "--help") || launchargs.HasFlag(os.Args[1:], "-h") {
		attachParentConsole()
		fmt.Fprintln(os.Stdout, cliUsageText())
		os.Exit(0)
	}
	if launchargs.HasFlag(os.Args[1:], "--version") || launchargs.HasFlag(os.Args[1:], "-v") {
		attachParentConsole()
		fmt.Fprintf(os.Stdout, "CaDt-DataLens %s\n", appVersion)
		os.Exit(0)
	}
	if installercli.Run(os.Args[1:]) {
		return
	}
	convertOpts, isConvert, convertErr := convertcli.ParseArgs(os.Args[1:])
	if isConvert {
		attachParentConsole()
		if convertErr != nil {
			fmt.Fprintln(os.Stderr, convertErr)
			os.Exit(2)
		}
	}

	// 补丁命令行：不启动窗口、不依赖 AI，处理完直接退出。
	if patchOpts, isPatch, patchErr := patchcli.ParseArgs(os.Args[1:]); isPatch {
		attachParentConsole()
		if patchErr != nil {
			fmt.Fprintln(os.Stderr, patchErr)
			os.Exit(2)
		}
		os.Exit(patchcli.Run(patchOpts))
	}

	ensureAppDataDir()
	applog.Start()
	defer applog.Stop()
	writeAppLog("info", "启动 CaDt-DataLens %s", appVersion)
	if exe, err := os.Executable(); err == nil {
		writeAppLog("info", "程序路径：%s", exe)
	}
	writeAppLog("info", "启动参数：%q", os.Args[1:])
	// 上次在设置页里排的 WebView2 清理挪到 application.New 之后执行（见下方注释），
	// 转发进程不再抢跑。MCP 变体（-tags mcp，tools/rebuild-exe.ps1 -IncludeMCP）：
	// Run 内会自动启动 v3 内置 MCP server，这里先把令牌/端口准备好并写连接信息文件。
	// 标准构建是空操作。
	bootstrapMCPVariant()

	app := NewApp()
	app.convert = convertOpts

	var singleInstance *application.SingleInstanceOptions
	if !isConvert {
		singleInstance = &application.SingleInstanceOptions{
			UniqueID: uniqueIDForLaunch(),
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				// v3 的 Args 是完整 os.Args（含 exe 路径），v2 语义是 os.Args[1:]。
				args := data.Args
				// v3 的 Args 恒为完整 os.Args（含 exe 自身路径）：无条件剥 args[0]。
				// 旧逻辑按「与运行中实例路径比对」剥——跨副本混跑（root vs build/bin，
				// 或 v2/v3）时路径不同会漏剥，把 exe 自己当打开目标塞进二进制查看器
				//（2026-11-21 用户实测复现）。
				if len(args) > 0 {
					args = args[1:]
				}
				app.secondInstance(args)
			},
		}
	}

	wailsApp = application.New(application.Options{
		Name:        "CaDt-DataLens",
		Description: "轻量级多格式数据查看与编辑器",
		Services: []application.Service{
			application.NewService(app),
		},
		Assets: application.AssetOptions{
			Handler:    application.BundledAssetFileServer(assets),
			Middleware: previewassets.Middleware,
		},
		SingleInstance: singleInstance,
		Windows: application.WindowsOptions{
			WebviewUserDataPath: webviewDataPath(),
			// 迷你菜单禁用（v3 原生选项，自动与上游 feature 合并）；见 disableMiniMenu 注释。
			DisabledFeatures: []string{"msWebOOUI", "msPdfOOUI", "msEdgeMiniMenu", "msEdgeTextSelectionMenu"},
			// 临时调试辅助：CADT_CDP_PORT 非空时给 WebView2 开远程调试口（仅供自动化排查用）
			AdditionalBrowserArgs: cdpDebugArgs(),
		},
		ErrorHandler: func(err error) {
			writeAppLog("error", "wails v3：%v", err)
		},
	})

	// 首个窗口：按启动参数决定形态（主窗口 / AI 浮窗 / 调试控制台）。
	primary := windowSpec{
		Name:         "main",
		Mode:         windowModeMain,
		Targets:      launchargs.ParseOpenTargets(os.Args[1:]),
		SessionID:    launchargs.ParseAISessionArg(os.Args[1:]),
		SettingsPane: launchargs.ParseOpenSettingsArg(os.Args[1:]),
		MemoLocator:  launchargs.ParseMemoLocatorArg(os.Args[1:]),
	}
	if hasArg("--ai-float") {
		primary.Name = "float"
		primary.Mode = windowModeFloat
	}
	if hasArg("--debug-console") {
		primary.Name = "debug"
		primary.Mode = windowModeDebug
	}
	// 崩溃自愈 + 会话存活标记：必须放在 application.New 之后——转发场景在 New 里就
	// os.Exit，绝不能让转发进程抢走遗留标记去清理（运行中的主实例还占着这些缓存）。
	// 自愈可能把 webview-cache 转成 pending，随即在 WebView2 起来前执行掉。
	if !isConvert {
		runCrashRecoveryAtStartup()
		applyPendingStorageCleanup()
		if err := crashrecovery.MarkAlive(string(primary.Mode), applog.FilePath()); err == nil {
			defer crashrecovery.MarkExited()
		} else {
			writeAppLog("warn", "会话存活标记写入失败（本次异常退出将无法触发自愈）：%v", err)
		}
	}

	if launchargs.HasFlag(os.Args[1:], "--quit") {
		// --quit 只对「已有运行实例」有意义：转发场景在 application.New() 里就
		// os.Exit 了；走到这里说明本进程成了主实例而目标应用没在跑——不建窗口，
		// 短定时器直接退出，避免冷启动闪一个完整窗口再被脚本强杀。
		time.AfterFunc(300*time.Millisecond, wailsApp.Quit)
	} else {
		app.createWindow(primary)
	}

	err := wailsApp.Run()
	if err != nil {
		writeAppLog("error", "wails.Run 退出：%v", err)
		// 启动期失败（如 MCP 变体端口被抢）不能静默 exit 0：调用方/启动器需要失败信号。
		os.Exit(1)
	}
	// 兜底落盘：正常路径在最后一个窗口的 WindowClosing 钩子里已经 flush，
	// 这里覆盖非关窗退出（托盘退出/外部结束）时防抖计时器还没到点的情况。
	winGeom.flush()
	if isConvert {
		os.Exit(app.convertExitCode)
	}
}

// appExePath 返回当前 exe 路径（第二实例参数比对用；取不到时退回 os.Args[0]）。
func appExePath() string {
	if exe, err := os.Executable(); err == nil {
		return exe
	}
	return os.Args[0]
}
