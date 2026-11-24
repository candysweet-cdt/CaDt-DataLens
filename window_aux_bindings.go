package main

// window_aux_bindings.go：便签 / 会话监控 / 文件对比 / 轻量查看 / 实时预览五类辅助窗口的
// Wails 绑定壳。（文件原名 aux_windows.go——**别改回去**：Go 把 `_windows` 后缀当作
// GOOS=windows 构建约束，一旦叫 aux_windows.go，这些绑定在 linux/darwin 构建里会整块
// 消失，交叉编译的 vet 才报 undefined。2026-11-24 二期结构化时据此修复。）
// Wails 绑定壳。与终端独立窗口同构（terminal_window.go）：数据源在进程内或磁盘，
// 弹窗只是换一个窗口渲染。五类窗口都不注册为工作区打开者（FindByWorkspace 只认
// ModeMain），不会撞「同工作区防双开」守卫：
//   - 便签窗：数据磁盘共享，写权走 memo 租约（后开的窗口只读，租约模型不变）；
//   - 监控窗：只读镜像——会话归属与其回合租约留在原窗口，这里只订阅广播事件
//     渲染时间线（aichat.Emit 是应用级广播，所有窗口都收得到）；
//   - 对比窗：读完即渲染，无常驻状态，关窗即消失；
//   - 轻量查看 / 实时预览：只读，磁盘真源。
//
// 「同条件窗口已存在就前置」的查找逻辑与作用域归一都在 internal/windowreg
// （纯 Spec 读取，零 Wails 依赖）；这里只剩窗口创建与绑定方法。

import (
	"context"
	"fmt"
	"strings"

	"datalens/internal/windowreg"
)

// PopOutMemo 把便签面板弹出为独立窗口。scope=workspace 时 workspace 必须给出
// （前端从面板状态取，与主窗口便签数据同源）；已有同作用域窗口直接前置。
func (a *App) PopOutMemo(ctx context.Context, scope, workspace string) error {
	scope = windowreg.NormalizeMemoScope(scope)
	workspace = strings.TrimSpace(workspace)
	if scope == "workspace" && workspace == "" {
		if st := stateForCaller(ctx); st != nil {
			workspace = strings.TrimSpace(st.Workspace())
		}
		if workspace == "" {
			return fmt.Errorf("工作区便签需要先打开一个工作区")
		}
	}
	if st := winReg.FindMemo(scope, workspace); st != nil {
		activateWindow(st.Window())
		return nil
	}
	a.createWindow(windowSpec{Mode: windowModeMemo, MemoScope: scope, Workspace: workspace})
	return nil
}

// PopOutSession 把一个 AI 会话/群聊弹为监控窗（只读镜像，不改归属）。
// Origin 记发起窗口：监控窗头部的「回到主窗口」按钮按它前置；同会话已有监控窗直接前置。
func (a *App) PopOutSession(ctx context.Context, sessionID, kind, workspace string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return fmt.Errorf("缺少会话 id")
	}
	kind = windowreg.NormalizeSessionKind(kind)
	if st := winReg.FindMonitor(sessionID); st != nil {
		activateWindow(st.Window())
		return nil
	}
	origin := ""
	if cw := callerWindow(ctx); cw != nil {
		origin = cw.Name()
	}
	a.createWindow(windowSpec{
		Mode:        windowModeMonitor,
		SessionID:   sessionID,
		SessionKind: kind,
		Workspace:   strings.TrimSpace(workspace),
		Origin:      origin,
	})
	return nil
}

// OpenDiffWindow 打开两个文件的对比窗；已存在同对窗口直接前置。
func (a *App) OpenDiffWindow(ctx context.Context, pathA, pathB string) error {
	pathA, pathB = strings.TrimSpace(pathA), strings.TrimSpace(pathB)
	if pathA == "" || pathB == "" {
		return fmt.Errorf("需要两个文件路径")
	}
	if strings.EqualFold(pathA, pathB) {
		return fmt.Errorf("两个路径相同，无需比较")
	}
	if st := winReg.FindDiff(pathA, pathB); st != nil {
		activateWindow(st.Window())
		return nil
	}
	a.createWindow(windowSpec{Mode: windowModeDiff, DiffLeft: pathA, DiffRight: pathB})
	return nil
}

// OpenLightView 把文件弹成轻量查看窗（只读，磁盘真源，不占工作区归属）。
// 同文件已有查看窗直接前置；文件存在性由前端 OpenFile 读取时校验。
func (a *App) OpenLightView(ctx context.Context, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("缺少文件路径")
	}
	if st := winReg.FindLight(path); st != nil {
		activateWindow(st.Window())
		return nil
	}
	a.createWindow(windowSpec{Mode: windowModeLight, LightPath: path})
	return nil
}

// OpenLivePreview 打开源文件的实时预览窗（只读镜像：轮询磁盘 mtime 跟随保存）。
// Origin 记发起窗口供头部「回到主窗口」；一个源文件一个预览位，重复打开前置。
func (a *App) OpenLivePreview(ctx context.Context, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("缺少文件路径")
	}
	if st := winReg.FindPreview(path); st != nil {
		activateWindow(st.Window())
		return nil
	}
	origin := ""
	if cw := callerWindow(ctx); cw != nil {
		origin = cw.Name()
	}
	a.createWindow(windowSpec{Mode: windowModePreview, PreviewPath: path, Origin: origin})
	return nil
}

// GetAuxWindowKind 当前调用窗口的辅助窗类型（memo|monitor|diff|light|preview）；其他窗口空串。
// 终端窗不在这里（沿用 IsTerminalWindow，避免碰已验证的启动分支）。
func (a *App) GetAuxWindowKind(ctx context.Context) string {
	st := stateForCaller(ctx)
	if st == nil {
		return ""
	}
	switch st.Startup().Mode {
	case windowModeMemo:
		return "memo"
	case windowModeMonitor:
		return "monitor"
	case windowModeDiff:
		return "diff"
	case windowModeLight:
		return "light"
	case windowModePreview:
		return "preview"
	}
	return ""
}

// GetStartupLight 轻量查看窗的启动上下文：文件路径。
func (a *App) GetStartupLight(ctx context.Context) map[string]string {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModeLight {
		return nil
	}
	return map[string]string{"path": st.Startup().LightPath}
}

// GetStartupPreview 实时预览窗的启动上下文：源文件路径与发起窗口名。
func (a *App) GetStartupPreview(ctx context.Context) map[string]string {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModePreview {
		return nil
	}
	spec := st.Startup()
	return map[string]string{
		"path":   spec.PreviewPath,
		"origin": spec.Origin,
	}
}

// GetStartupMemo 便签独立窗口的启动上下文：scope + workspace（global 时 workspace 空）。
func (a *App) GetStartupMemo(ctx context.Context) map[string]string {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModeMemo {
		return nil
	}
	spec := st.Startup()
	return map[string]string{
		"scope":     spec.MemoScope,
		"workspace": spec.Workspace,
	}
}

// GetStartupMonitorSession 监控窗的启动上下文：会话 id、类型、工作区与发起窗口名。
func (a *App) GetStartupMonitorSession(ctx context.Context) map[string]string {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModeMonitor {
		return nil
	}
	spec := st.Startup()
	return map[string]string{
		"sessionId": spec.SessionID,
		"kind":      spec.SessionKind,
		"workspace": spec.Workspace,
		"origin":    spec.Origin,
	}
}

// GetStartupDiff 对比窗的启动上下文：两个文件路径。
func (a *App) GetStartupDiff(ctx context.Context) map[string]string {
	st := stateForCaller(ctx)
	if st == nil || st.Startup().Mode != windowModeDiff {
		return nil
	}
	spec := st.Startup()
	return map[string]string{
		"left":  spec.DiffLeft,
		"right": spec.DiffRight,
	}
}
