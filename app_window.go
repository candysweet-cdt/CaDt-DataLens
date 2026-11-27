package main

// 应用状态与窗口：脏标记、应用配置（open mode）、多窗口与资源管理器定位。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/appconfig"
	"datalens/internal/clipboard"
	"datalens/internal/cmdbridge"
	"datalens/internal/launchargs"
	"datalens/internal/shellexec"
)

func (a *App) SetDirty(ctx context.Context, dirty bool) {
	if st := stateForCaller(ctx); st != nil {
		st.SetDirty(dirty)
	}
}

// SetAIRunning：前端在 AI 回合开始/结束时同步（关窗二次确认依据，见 beforeCloseWindow）。
func (a *App) SetAIRunning(ctx context.Context, running bool) {
	if st := stateForCaller(ctx); st != nil {
		st.SetAIRunning(running)
	}
}

// SetWindowCollapsed：浮窗前端在「收起/展开」时同步。收起态的窗口高度只是
// 标题栏高度，不能当成用户偏好的窗口尺寸写进几何记忆。
func (a *App) SetWindowCollapsed(ctx context.Context, collapsed bool) {
	if st := stateForCaller(ctx); st != nil {
		st.SetCollapsed(collapsed)
	}
}

// WindowList 列出全部存活窗口（quick-switch「窗口」层用）。
// title/位置在 Go 侧拿不到读取口，标识用窗口名 + 形态 + 工作区。
// IsWorkspaceOpen 查询某工作区是否已被其他窗口打开（恢复路径防双开用）。
func (a *App) IsWorkspaceOpen(ctx context.Context, dir string) bool {
	return winReg.FindByWorkspace(strings.TrimSpace(dir), callerWindowName(ctx)) != nil
}

func (a *App) WindowList(ctx context.Context) []map[string]string {
	self := callerWindowName(ctx)
	out := make([]map[string]string, 0, 4)
	for _, st := range winReg.List() {
		item := map[string]string{
			"name": st.Name(),
			"mode": string(st.Startup().Mode),
			"self": "",
		}
		if st.Name() == self {
			item["self"] = "1"
		}
		if ws := st.Workspace(); ws != "" {
			item["workspace"] = ws
		}
		out = append(out, item)
	}
	return out
}

// WindowFocusByName 前置并聚焦指定窗口（切换器跳转用）；窗口不存在返回 false。
func (a *App) WindowFocusByName(ctx context.Context, name string) (bool, error) {
	st := winReg.Get(strings.TrimSpace(name))
	if st == nil || st.Window() == nil {
		return false, nil
	}
	activateWindow(st.Window())
	return true, nil
}

// uniqueIDForLaunch：P2 起所有模式共用同一单实例锁——第二个进程一律转发给
// 已运行实例，由 secondInstance 决定开主窗口 / 浮窗 / 调试控制台。
// CADT_UNIQUE_ID 可覆盖（并行测试/便携多配置隔离用），默认值与原单实例 ID 一致。
func uniqueIDForLaunch() string {
	if v := strings.TrimSpace(os.Getenv("CADT_UNIQUE_ID")); v != "" {
		return v
	}
	return "cadt-datalens-7f3a9c21"
}

func (a *App) GetOpenMode() string {
	return appconfig.OpenMode()
}

func (a *App) GetAppVersion() string {
	return appVersion
}

func (a *App) SetOpenMode(mode string) error {
	if mode != "window" {
		mode = "tab"
	}
	cfg := appconfig.Read()
	cfg.OpenMode = mode
	return appconfig.Save(cfg)
}

func (a *App) OpenNewWindow() error {
	a.openMainWindow(windowSpec{})
	return nil
}

// OpenHarnessWindow 新建一个 harness 窗口：不绑定工作区、不恢复上次环境，
// AI 面板里的每个会话各自带着自己的作用域根（未绑定的用会话沙盒）。
// 与命令行 `--harness` 等价——菜单 / 命令面板走这里（那条路只有启动期可用，
// 且需要绕开单实例转发，对普通用户不友好）。
func (a *App) OpenHarnessWindow() error {
	a.openMainWindow(windowSpec{Harness: true})
	return nil
}

// OpenDirInNewWindow 在独立新窗口打开目录（一目录一窗口）。
func (a *App) OpenDirInNewWindow(dir string) error {
	dir, err := validateWindowDir(dir)
	if err != nil {
		return err
	}
	a.openMainWindow(windowSpec{
		Workspace: dir,
		Targets:   []launchargs.OpenTarget{{Path: dir}},
	})
	return nil
}

// OpenWorkspaceForConversation 软切换：另开窗口打开目标工作区，并把目标 AI 会话 id
// 传给新窗口（新窗口启动后恢复工作区环境并选中该会话）。
func (a *App) OpenWorkspaceForConversation(dir string, sessionID string) error {
	dir, err := validateWindowDir(dir)
	if err != nil {
		return err
	}
	a.openMainWindow(windowSpec{
		Workspace: dir,
		Targets:   []launchargs.OpenTarget{{Path: dir}},
		SessionID: sessionID,
	})
	return nil
}

// validateWindowDir 校验「打开窗口」的目录参数（空/不存在/不是目录都报错）。
func validateWindowDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("目录为空")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("目录不存在：%s", dir)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", dir)
	}
	return dir, nil
}

func (a *App) ShowInFolder(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("路径不存在：%s", path)
	}
	// 平台 glue（explorer.exe / 防黑窗 / 路径归一）全在 internal/shellexec，根壳只做参数校验。
	return shellexec.RevealInFolder(path, info.IsDir())
}

// OpenWithDefaultApp 用系统默认关联程序打开文件或目录（右键「用默认应用打开」）。
// 路径先校验存在性：ShellExecute 对不存在的路径只会给出含糊的错误码。
func (a *App) OpenWithDefaultApp(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("没有文件路径")
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("路径不存在：%s", path)
	}
	return shellexec.Open(filepath.Clean(path))
}

func (a *App) CopyText(text string) error {
	return clipboardSetText(text)
}

func (a *App) GetClipboardText() (string, error) {
	return clipboardGetText()
}

// GetClipboardImage 把剪贴板里的图片读成 PNG data URL（空串表示没有图片）。
// 编辑器/AI 输入框的右键菜单「粘贴」拿不到 paste 事件，只能由后端回读系统剪贴板。
func (a *App) GetClipboardImage() (string, error) {
	return clipboard.ImageDataURL()
}

// OpenInNewWindows 兼容入口：原「一个文件一个窗口」在 v3 一进程多窗口下会造成
// 同工作区双开（会话/监听/租约按单打开语义设计），2026-11-21 用户裁定禁用——
// 退化为在主窗口以标签页打开（绑定名与前端调用面保留，行为变更）。
func (a *App) OpenInNewWindows(paths []string) error {
	_ = a.SetOpenMode("tab")
	targets := make([]launchargs.OpenTarget, 0, len(paths))
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			continue
		}
		targets = append(targets, launchargs.OpenTarget{Path: p})
	}
	if len(targets) == 0 {
		return nil
	}
	if st := winReg.Primary(); st != nil {
		deliverOpenTargets(st, openTargetsAny(targets))
		return nil
	}
	// 没有存活主窗口：开一个新窗口承载（此时不存在双开）
	a.openMainWindow(windowSpec{Targets: targets})
	return nil
}

func (a *App) SetWindowBg(ctx context.Context, r, g, b int) {
	clamp := func(v int) uint8 {
		if v < 0 {
			return 0
		}
		if v > 255 {
			return 255
		}
		return uint8(v)
	}
	w := callerWindow(ctx)
	if w == nil {
		w = currentWindow()
	}
	if w != nil {
		w.SetBackgroundColour(application.NewRGBA(clamp(r), clamp(g), clamp(b), 255))
	}
}

// beforeCloseWindow 是单个窗口的关窗确认（v2 OnBeforeClose 的等价物）。
func (a *App) beforeCloseWindow(st *windowState) bool {
	if st == nil {
		return false
	}
	isMain := st.Startup().Mode == windowModeMain
	// 设置里选了「最小化到托盘」：点 X 只是把窗口藏起来，进程与后台任务全部照旧跑。
	// 只有主窗口参与；且只在该窗口是最后一个主窗口时才藏（否则直接关掉本窗口）。
	if a.convert == nil && isMain && traySupported() &&
		shouldHideOnClose(a.closeAction, true, st.ForceClosed(), a.quitRequested.Load(), systemShuttingDown()) {
		setMainWindow(st.Window())
		a.hideToTray(st.Window())
		return true
	}
	// 设置里选了「每次询问」（默认值）：点 X 弹三选一确认框（取消 / 退出应用 / 最小化到托盘）。
	// 仅主窗口参与；非 Windows 无托盘能力时回落下面的 exit 逻辑（避免「最小化到托盘」藏了找不回）。
	// 系统关机 / 显式退出 / 强制关闭时不能弹框卡住，直接走下面的放行分支。
	if a.convert == nil && isMain && traySupported() && a.closeAction == appconfig.CloseActionAsk &&
		!st.ForceClosed() && !a.quitRequested.Load() && !systemShuttingDown() {
		if w := st.Window(); w != nil {
			// 风险快照按「退出应用」口径（弹窗的「退出应用」走 ForceQuitAll，带走全部窗口与进程级任务）。
			w.EmitEvent("close-choice", a.appQuitReasonSnapshot())
			return true
		}
	}
	// 关窗二次确认的依据不止「AI 回合进行中」：终端会话与 AI 后台命令作业都会随
	// 进程退出被静默终止，一并计入。这些是进程级资源：只有「退出应用」的路径
	// （最后一个主窗口 / 最后一个窗口）才真正带走它们——关掉中间某个主窗口时
	// 任务还在别的窗口/进程里活着，不该用「关闭将终止这些任务」吓唬用户
	//（审查 P2-3：v2 一窗一进程时文案准确，v3 同进程后口径要跟着收）。
	// lastMain：关闭的是最后一个主窗口，即「退出应用」——会连带关掉浮窗/调试台；
	// lastWindow：关闭后进程里没有窗口了（--ai-float / --debug-console 单独运行）。
	lastMain := isMain && winReg.CountMain() <= 1
	lastWindow := winReg.Count() <= 1
	terms, bgJobs := 0, 0
	if (isMain && lastMain) || lastWindow {
		terms = a.Terminal.RunningSessionCount()
		bgJobs = cmdbridge.RunningAIJobCount()
	}
	dirty, aiRunning := st.IsDirty(), st.IsAIRunning()
	if lastMain {
		// 退出应用会带走附属窗口：它们的未保存/AI 状态也要算进这次确认。
		dirty = dirty || winReg.AnyDirty()
		aiRunning = aiRunning || winReg.AnyAIRunning()
	}
	if st.ForceClosed() || (!dirty && !aiRunning && terms == 0 && bgJobs == 0) {
		if lastMain || lastWindow {
			// 先摘窗口再收口：teardown 可能要等 MCP 子进程 / 插件服务退出，
			// 让用户盯着一个已经点了 X 的窗口等这档时间没有意义。
			hideWindowsBeforeTeardown()
			a.teardownAppServices()
		}
		if lastMain {
			// 最后一个主窗口关闭 = 退出程序：应用级服务已收口，再带走附属窗口。
			closeOtherWindows(st)
		}
		return false
	}
	if w := st.Window(); w != nil {
		w.EmitEvent("confirm-close", map[string]interface{}{
			"dirty": dirty, "aiRunning": aiRunning, "terms": terms, "bgJobs": bgJobs,
		})
	}
	return true
}

func (a *App) ForceClose(ctx context.Context) {
	st := stateForCaller(ctx)
	if st == nil {
		return
	}
	st.MarkForceClose()
	st.SetDirty(false)
	st.SetAIRunning(false)
	isMain := st.Startup().Mode == windowModeMain
	lastMain := isMain && winReg.CountMain() <= 1
	lastWindow := winReg.Count() <= 1
	if lastMain || lastWindow {
		// 同 beforeCloseWindow：窗口先消失，收口（可能等子进程）在后面做。
		hideWindowsBeforeTeardown()
		a.teardownAppServices()
	}
	if lastMain {
		closeOtherWindows(st)
	}
	closeWindow(st.Window())
}
