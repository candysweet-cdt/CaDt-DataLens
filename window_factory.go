package main

// window_factory.go：一进程多窗口的窗口工厂与投递助手（P2）。
//
// 三种窗口：主窗口（可多个，按工作区复用）、AI 浮窗（单例）、调试控制台（单例）。
// 所有窗口共用同一个 App 服务实例；窗口级状态经 windowState 归属（见 window_host.go）。

import (
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"datalens/internal/launchargs"
	"datalens/internal/terminal"
	"datalens/internal/windowgeom"
)

// createWindow 创建并登记窗口，随后 app.Run 会跑它。
func (a *App) createWindow(spec windowSpec) *application.WebviewWindow {
	if spec.Name == "" {
		spec.Name = winReg.NextName(spec.Mode)
	}
	st := winReg.Add(spec)
	width, height, minWidth, minHeight := windowSizesFor(spec.Mode)
	initialRect, hasInitialRect := winGeom.initialGeometry(spec, width, height, minWidth, minHeight)
	st.SetInitialGeometry(initialRect, hasInitialRect)
	win := wailsApp.Window.NewWithOptions(windowOptionsFor(spec, initialRect, hasInitialRect))
	st.SetWindow(win)
	installGeometryHooks(win, st)
	// v3 的文件拖放只回调 Go 侧监听（不会发回 JS 事件），这里收下后转成本窗口事件；
	// 前端经事件桥按 sender 过滤消费（修复迁移期 OnFileDrop 收不到事件的回归）。
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(ev *application.WindowEvent) {
		files := ev.Context().DroppedFiles()
		if len(files) == 0 {
			return
		}
		win.EmitEvent("app-file-drop", map[string]any{"filenames": files})
	})
	if spec.Mode == windowModeMain {
		if currentWindow() == nil {
			setMainWindow(win)
		}
		a.ensureAIServices()
	}

	// 关窗钩子必须挂在 Common.WindowClosing：两条关窗路径在这里汇合——
	//   原生 WM_CLOSE/Alt+F4 → Windows.WindowClosing →（默认事件映射）→ Common
	//   JS WindowClose()（标题栏 X / 终端窗口收回）→ 直接发 Common
	// 挂在 Windows.* 上会让 JS 关窗路径完全绕过 beforeCloseWindow（X 不弹确认、
	// 终端窗口收回不发交还事件，2026-11-21 用户实测）。钩子先于 v3 内部关闭
	// 监听器执行，e.Cancel() 可以同时拦住两条路径。
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		writeAppLog("info", "WindowClosing 钩子触发：%s", st.Name())
		// 关窗前采集一次并同步落盘：拖拽刚结束就关窗时防抖计时器可能还没到点。
		winGeom.capture(st)
		winGeom.flush()
		if a.beforeCloseWindow(st) {
			e.Cancel()
			return
		}
		// 终端独立窗口关闭：把还活着的会话交还原窗口（退出流程除外）。
		if !a.quitRequested.Load() && !systemShuttingDown() {
			a.emitTerminalPopoutClosed(st)
		}
		winReg.Remove(st.Name())
		// 窗口名下的一切按归属收口：工作区/资源监听槽、memo 写权租约、浏览器标签页
		// （该窗口的前端已死，不回收会顶掉别的窗口的监听、泄漏 WebView2 进程）。
		a.releaseWindowOwnedState(st.Name())
		if p := win.NativeWindow(); p != nil {
			a.BrowserCloseByOwner(uintptr(p))
		}
		if currentWindow() == win {
			if primary := winReg.Primary(); primary != nil {
				setMainWindow(primary.Window())
			} else {
				setMainWindow(nil)
			}
		}
	})
	win.RegisterHook(events.Windows.WebViewNavigationCompleted, func(_ *application.WindowEvent) {
		a.windowReady(st)
	})
	// v2 有 8 秒兜底显示（ensureWindowShown）：WebView2 初始化/导航卡死时进程活着
	// 但没有任何窗口。这里补回同语义：导航迟迟不完成就强制露出窗口（审查 P2-4）。
	// 托盘隐藏需要先有关窗确认流程，8 秒内不可能发生，不会误弹托盘窗口。
	time.AfterFunc(8*time.Second, func() {
		// 正在退出（hideWindowsBeforeTeardown 把窗口藏了）：别再把窗口塞回屏幕。
		if a.teardownDone.Load() || st.ForceClosed() {
			return
		}
		if !win.IsVisible() {
			writeAppLog("warn", "窗口 %s 导航 8s 未完成，兜底显示", win.Name())
			win.Show()
		}
	})
	writeAppLog("info", "窗口已创建：%s（mode=%s workspace=%q）", spec.Name, spec.Mode, spec.Workspace)
	return win
}

// windowSizesFor 返回窗口类型的默认尺寸与最小尺寸。
func windowSizesFor(mode windowMode) (width, height, minWidth, minHeight int) {
	switch mode {
	case windowModeFloat:
		return 560, 760, 360, 480
	case windowModeDebug:
		return 780, 460, 400, 300
	case windowModeTerminal:
		return 900, 600, 480, 320
	case windowModeMemo:
		// 便签窗：经典桌面便签的窄长形态，贴屏角落用。
		return 400, 560, 300, 360
	case windowModeMonitor:
		// 会话监控窗：第二屏盯长任务的纵向时间线。
		return 560, 780, 420, 480
	case windowModeDiff:
		return 980, 680, 680, 440
	case windowModeLight:
		// 轻量查看窗：一个文件一个窗，默认比主窗口小一号。
		return 760, 600, 460, 380
	case windowModePreview:
		// 实时预览窗：纵向文档形态，适合摆在第二屏跟着写。
		return 680, 800, 440, 440
	default:
		return 1280, 800, 720, 480
	}
}

// windowOptionsFor 按窗口类型给出 v3 窗口参数。
func windowOptionsFor(spec windowSpec, initialRect windowgeom.Rect, hasInitialRect bool) application.WebviewWindowOptions {
	width, height, minWidth, minHeight := windowSizesFor(spec.Mode)
	title := "CaDt-DataLens"
	alwaysOnTop := false
	hiddenOnTaskbar := false
	switch spec.Mode {
	case windowModeFloat:
		title = "AI 助手 · CaDt-DataLens"
		alwaysOnTop = true
	case windowModeDebug:
		title = "调试控制台 · CaDt-DataLens"
		// 工具窗口不占任务栏/Alt+Tab：恢复走 quick-switch「窗口」层与 F12。
		hiddenOnTaskbar = true
	case windowModeTerminal:
		title = "终端 · CaDt-DataLens"
	case windowModeMemo:
		title = "便签 · CaDt-DataLens"
		// 桌面便签语义：贴在别的窗口之上（几何记忆与收起逻辑照常）。
		alwaysOnTop = true
	case windowModeMonitor:
		title = "会话监控 · CaDt-DataLens"
	case windowModeDiff:
		title = "文件对比 · CaDt-DataLens"
	case windowModeLight:
		title = "查看 · CaDt-DataLens"
	case windowModePreview:
		title = "实时预览 · CaDt-DataLens"
	}
	opts := application.WebviewWindowOptions{
		Name:               spec.Name,
		Title:              title,
		Width:              width,
		Height:             height,
		MinWidth:           minWidth,
		MinHeight:          minHeight,
		Frameless:          true,
		Hidden:             true,
		AlwaysOnTop:        alwaysOnTop,
		BackgroundColour:   application.NewRGB(30, 31, 36),
		URL:                "/",
		EnableFileDrop:     true,
		ZoomControlEnabled: false,
		Zoom:               1.0,
	}
	if hiddenOnTaskbar {
		// Windows 的任务栏隐藏在嵌套选项里（options.Windows.HiddenOnTaskbar）。
		opts.Windows = application.WindowsWindow{HiddenOnTaskbar: true}
	}
	// 记住的位置/尺寸（window-state.json）：按当前显示器布局收敛后再交给 v3。
	// 首个窗口在 Run 之前创建，此时 v3 尚未缓存显示器列表，windowReady 会再收敛一次。
	if hasInitialRect {
		opts.InitialPosition = application.WindowXY
		opts.X, opts.Y = initialRect.X, initialRect.Y
		opts.Width, opts.Height = initialRect.Width, initialRect.Height
	}
	return opts
}

// windowReady 在首屏导航完成后显示窗口（v2 OnDomReady 的等价时机）。
func (a *App) windowReady(st *windowState) {
	if a.convert != nil {
		return
	}
	win := st.Window()
	if win == nil {
		return
	}
	spec := st.Startup()
	maximised := false
	if rect, ok := st.TakeInitialGeometry(); ok {
		// 首个窗口创建于 Run 之前，v3 那时还没枚举显示器；这里按当前屏幕布局
		// 再收敛一次（窗口仍隐藏，用户看不到跳动）。后续导航重载不重复应用。
		_, _, minW, minH := windowSizesFor(spec.Mode)
		areas, primary := screenWorkAreas()
		rect = windowgeom.Normalize(rect, minW, minH, areas, primary)
		win.SetPosition(rect.X, rect.Y)
		win.SetSize(rect.Width, rect.Height)
		maximised = rect.Maximised
	}
	// 显示只做一次：托盘隐藏的窗口遇到 reload（HMR / location.reload）时
	// 不能被重新弹出（审查 P2-4）。
	if st.MarkShownOnce() {
		if spec.Mode == windowModeMain {
			showWindowWhenReady(win, maximised)
		} else if maximised {
			// 同上：最大化后必须补 Show() 联动 WebView2 可见性。
			win.Maximise()
			win.Show()
		} else {
			win.Show()
		}
	}
}

// ensureFloatWindow 打开（或聚焦）AI 浮窗；targets 非空时作为该窗口的启动目标
// （新建窗口走启动上下文，已存在的窗口直接投 open-targets 事件）。
func (a *App) ensureFloatWindow(targets ...launchargs.OpenTarget) *application.WebviewWindow {
	if st := winReg.Get("float"); st != nil {
		if w := st.Window(); w != nil {
			if len(targets) > 0 {
				w.EmitEvent("open-targets", targets)
			}
			activateWindow(w)
			return w
		}
	}
	return a.createWindow(windowSpec{Name: "float", Mode: windowModeFloat, Targets: targets})
}

// ensureDebugWindow 打开（或聚焦）独立调试控制台窗口。
func (a *App) ensureDebugWindow() *application.WebviewWindow {
	if st := winReg.Get("debug"); st != nil {
		if w := st.Window(); w != nil {
			activateWindow(w)
			return w
		}
	}
	return a.createWindow(windowSpec{Name: "debug", Mode: windowModeDebug})
}

// ensureTerminalWindow 打开（或聚焦）承载指定终端会话的独立窗口。
// ConPTY 会话留在进程里不动，事件归属由新窗口装载后自行接管。
func (a *App) ensureTerminalWindow(termID, origin string) *application.WebviewWindow {
	if st := findTerminalWindow(termID); st != nil {
		if w := st.Window(); w != nil {
			activateWindow(w)
			return w
		}
	}
	return a.createWindow(windowSpec{Mode: windowModeTerminal, TermID: termID, Origin: origin})
}

func findTerminalWindow(termID string) *windowState {
	for _, st := range winReg.List() {
		spec := st.Startup()
		if spec.Mode == windowModeTerminal && spec.TermID == termID {
			return st
		}
	}
	return nil
}

// emitTerminalPopoutClosed 终端独立窗口关闭：会话还活着就广播交还事件，
// 原窗口（不在了就当前主窗口）收到后把页签接回去。退出流程不投递。
func (a *App) emitTerminalPopoutClosed(st *windowState) {
	spec := st.Startup()
	if spec.Mode != windowModeTerminal || spec.TermID == "" {
		return
	}
	// 应用收尾（最后一个主窗口退出 / ForceQuitAll）已经 teardown：一律不投递，
	// 避免往正在关闭的窗口里塞页签（quitRequested 只覆盖显式退出路径）。
	if a.teardownDone.Load() {
		return
	}
	var info terminal.TermInfo
	found := false
	for _, it := range a.TermList() {
		if it.ID == spec.TermID {
			info = it
			found = true
			break
		}
	}
	if !found || info.Exited {
		return
	}
	target := spec.Origin
	if target == "" || winReg.Get(target) == nil {
		if p := winReg.Primary(); p != nil {
			target = p.Name()
		} else {
			target = ""
		}
	}
	if target == "" {
		writeAppLog("warn", "终端交还中止：无存活主窗口可接回（id=%s）", info.ID)
		return
	}
	writeAppLog("info", "终端交还：id=%s shell=%s origin=%s target=%s", info.ID, info.Shell, spec.Origin, target)
	emitAppEvent("term-popout-closed", map[string]string{
		"id": info.ID, "shell": info.Shell, "target": target,
	})
}

// activateWindow 把窗口显示并前置（最小化时先恢复，不用 Restore 以免还原最大化）。
func activateWindow(w *application.WebviewWindow) {
	if w == nil {
		return
	}
	w.Show()
	if w.IsMinimised() {
		w.UnMinimise()
	}
	w.Focus()
}

// deliverOpenTargets 把打开目标事件投给指定窗口（sender 由 v3 填窗口名）。
func deliverOpenTargets(st *windowState, targets []any) {
	w := st.Window()
	if w == nil {
		return
	}
	w.EmitEvent("open-targets", targets)
	activateWindow(w)
}

// deliverOpenSession 把「打开某个 AI 会话」投给指定窗口（替代 v2 的文件信箱）；
// reqID 由投递方生成，目标窗口处理完经 WindowReuseResult 回执。
func deliverOpenSession(st *windowState, reqID, workspace, sessionID string) {
	w := st.Window()
	if w == nil {
		return
	}
	w.EmitEvent("app-open-ai-session", map[string]string{
		"reqId":     reqID,
		"workspace": workspace,
		"sessionId": sessionID,
	})
	activateWindow(w)
}

// openMainWindow 新建一个主窗口（--new-window / 新目录 / 软切换）。
// 同一工作区禁止双开（v3 会话/监听/租约按「一个工作区一个打开者」设计，2026-11-21
// 用户裁定）：目标工作区已有存活窗口时，前置该窗口并投递启动上下文（含会话 id），
// 不再新建。
func (a *App) openMainWindow(spec windowSpec) *application.WebviewWindow {
	spec.Mode = windowModeMain
	if spec.Workspace != "" {
		if st := winReg.FindByWorkspace(spec.Workspace, ""); st != nil {
			activateWindow(st.Window())
			if spec.SessionID != "" {
				emitWindowEventTo(st.Window(), "app-open-ai-session", map[string]string{
					"workspace": spec.Workspace,
					"sessionId": spec.SessionID,
				})
			}
			return st.Window()
		}
	}
	return a.createWindow(spec)
}

// closeWindow 关闭指定窗口（触发该窗口的 WindowClosing 钩子）。
func closeWindow(w *application.WebviewWindow) {
	if w != nil {
		w.Close()
	}
}

// closeOtherWindows 关闭除 except 外的全部窗口（最后一个主窗口退出时带走浮窗/调试台）。
// 先置 forceClose：这些窗口的 AI 回合/未保存状态已经算进主窗口的退出确认，不再逐个弹框。
func closeOtherWindows(except *windowState) {
	for _, st := range winReg.List() {
		if st == except {
			continue
		}
		st.MarkForceClose()
		st.SetDirty(false)
		st.SetAIRunning(false)
		closeWindow(st.Window())
	}
}

// windowShowDelay 是 UI 线程从导航初始化松手的等待（v2 的图标占位问题）。
const windowShowDelay = 120 * time.Millisecond
