package main

// window_host.go：窗口宿主的注册表接线与跨窗口会话投递（Wails 绑定）。
//
// 本文件合并了原 windowmeta.go（注册表宿主适配）与 window_app.go（窗口复用绑定）：
// 两者都围绕「窗口叫什么、属于哪个工作区、怎么把会话投给别的窗口」这一件事。
// 纯状态机与注册表已下沉 internal/windowreg（零 Wails 依赖）；这里只剩与 Wails
// 有关的三件事：类型别名、全局注册表实例、从绑定 context 解析调用方窗口。
//
// v2 时代「一窗口 = 一进程」，启动参数、脏标记、AI 运行状态等天然按进程隔离；
// v3 一进程多窗口后，这些状态必须按窗口归属。归属键是窗口名（窗口名同时是
// v3 事件的 sender）。绑定方法通过 context 里的 application.WindowKey 拿到调用方窗口。
//
// 跨窗口会话投递（P2 进程内实现，P3 已删除文件注册表）：
//   - WindowRegister：调用方窗口把当前工作区写进 windowState；
//   - WindowReuseForSession：按工作区找存活窗口，投递打开会话请求并等待目标窗口回执
//     （超时 2.5s / 目标返回 mismatch 时退化为开新窗口，等价 v2 信箱的 ack 语义）；
//   - WindowReuseResult：目标窗口完成切换后回执 ok / mismatch；
//   - 原 windowreg 文件注册表 / 信箱协议已随 P3 清理删除。

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/windowreg"
)

// 类型别名：窗口族的其它文件统一用下面几个名字，实现在 internal/windowreg。
type windowMode = windowreg.Mode
type windowSpec = windowreg.Spec
type windowState = windowreg.State[*application.WebviewWindow]

const (
	windowModeMain     = windowreg.ModeMain
	windowModeFloat    = windowreg.ModeFloat
	windowModeDebug    = windowreg.ModeDebug
	windowModeTerminal = windowreg.ModeTerminal
	windowModeMemo     = windowreg.ModeMemo
	windowModeMonitor  = windowreg.ModeMonitor
	windowModeDiff     = windowreg.ModeDiff
	windowModeLight    = windowreg.ModeLight
	windowModePreview  = windowreg.ModePreview
)

// winReg 是进程内窗口集合。主窗口/浮窗/调试控制台/辅助窗都在这里按名字登记。
var winReg = windowreg.New[*application.WebviewWindow]()

// pathKeyForCompare 保留根内别名：窗口路由/工作区匹配的调用点覆盖面广，
// 为它改名只是噪音。实现与前端 sessionPathKey 同口径（internal/windowreg.PathKey）。
func pathKeyForCompare(p string) string { return windowreg.PathKey(p) }

// ---- 绑定调用的窗口归属 ----

// callerWindow 从绑定 context 里取调用方窗口（v3 在 messageprocessor_call 注入 WindowKey）。
func callerWindow(ctx context.Context) *application.WebviewWindow {
	if ctx == nil {
		return nil
	}
	w, ok := ctx.Value(application.WindowKey).(application.Window)
	if !ok || w == nil {
		return nil
	}
	if wv, ok := w.(*application.WebviewWindow); ok {
		return wv
	}
	return nil
}

func callerWindowName(ctx context.Context) string {
	if w := callerWindow(ctx); w != nil {
		return w.Name()
	}
	return ""
}

// stateForCaller 返回调用方窗口状态；无窗口上下文（测试/非绑定路径）回退到主窗口。
func stateForCaller(ctx context.Context) *windowState {
	if name := callerWindowName(ctx); name != "" {
		if st := winReg.Get(name); st != nil {
			return st
		}
	}
	return winReg.Primary()
}

// ---- 跨窗口会话复用 ----

// reuseResultBudget 是等待目标窗口回执的总预算（与 v2 信箱投递预算一致）。
const reuseResultBudget = 2500 * time.Millisecond

var (
	reuseSeq     atomic.Uint64
	reuseWaiters sync.Map // reqId -> chan string
)

// WindowRegister 登记调用方窗口当前工作区（关闭工作区传空串，退出可匹配集合）。
// 浮窗/调试控制台不参与工作区复用，静默忽略。
func (a *App) WindowRegister(ctx context.Context, workspace string) error {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModeMain {
		return nil
	}
	st.SetWorkspace(workspace)
	// 崩溃自愈的工作区段：上次异常退出后，本会话登记的每个工作区清一遍
	// .cadt/tmp 与 .cadt/logs（幂等去重，见 crashrecovery_app.go）。
	runCrashWorkspaceRecovery(workspace)
	return nil
}

// WindowReuseForSession 找目标工作区的存活窗口，投递「打开会话」请求并等待回执。
// 返回复用的窗口名；空串 = 无可用窗口或目标切换失败（调用方退化为开新窗口）。
func (a *App) WindowReuseForSession(ctx context.Context, workspace, sessionID string) (string, error) {
	writeAppLog("info", "会话复用探测：workspace=%q session=%q caller=%s", workspace, sessionID, callerWindowName(ctx))
	from := callerWindowName(ctx)
	target := winReg.FindByWorkspace(workspace, from)
	if target == nil {
		return "", nil
	}
	reqID := fmt.Sprintf("reuse-%d-%d", os.Getpid(), reuseSeq.Add(1))
	result := make(chan string, 1)
	reuseWaiters.Store(reqID, result)
	defer reuseWaiters.Delete(reqID)

	deliverOpenSession(target, reqID, workspace, sessionID)
	select {
	case status := <-result:
		if status == "ok" {
			return target.Name(), nil
		}
		return "", nil
	case <-time.After(reuseResultBudget):
		return "", nil
	}
}

// WindowReuseResult 目标窗口回执复用结果（status: ok / mismatch）。
func (a *App) WindowReuseResult(reqID, status string) error {
	if reqID == "" {
		return nil
	}
	if v, ok := reuseWaiters.Load(reqID); ok {
		select {
		case v.(chan string) <- status:
		default: // 已超时/已回执：丢弃，避免阻塞
		}
	}
	return nil
}

// WindowActivate 把调用方窗口还原并前置（与「又点了一次桌面图标」同语义）。
func (a *App) WindowActivate(ctx context.Context) error {
	activateWindow(callerWindow(ctx))
	return nil
}
