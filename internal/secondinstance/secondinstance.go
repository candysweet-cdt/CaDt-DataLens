package secondinstance

// secondinstance.go：第二实例转发的决策层（原在根 app_core.go）。
//
// 决策与执行分离：本包只把启动参数解析成动作计划（纯函数，表驱动测试随包）；
// 根 secondInstance 负责真正碰窗口 API。依赖全部经 Deps 注入，因此本包不碰
// App、不碰 Wails。
//
// 相对旧内联逻辑的行为修正（保持原注释，改代码前先读）：
//   - B（--ai-session 单独传参）：解析会话归属工作区后走 sessionOpen（openMainWindow 的
//     「同工作区复用 + 前置 + 投会话」语义）；解析失败只前置窗口——绝不再把调用方 CWD
//     兜底成打开目标误投给主窗口（旧 StartupCwdTarget 分支会误切工作区）。
//   - C（--ai-session + 文件转发投递）：会话归属与目标窗口工作区一致时补投
//     app-open-ai-session（前端 handleReuseSessionRequest 要求 workspace 匹配、无 reqId
//     不回执）；不一致丢弃 + warn（旧版无条件静默丢 id）。
//   - D（--open-settings/--memo + 文件组合）：文件目标随定点事件一起投给主窗口，不再被
//     定点分支吞掉；回退浮窗时仍不投文件（浮窗不是文件容器，方案 §6 已知边界）。
//
// appconfig.OpenMode()=="window" 死分支移除：Read() 自 2026-11-21 起把 window 归一回
// tab（同工作区双开会破坏单打开语义），比较恒假。

import (
	"errors"

	"datalens/internal/launchargs"
)

// Plan 是转发决策结果；窗口操作语义由根的 secondInstance 执行。
	type Plan struct {
	Kind      string                  // quit | float | debug | settings | memo | sessionOpen | newWindow | harnessWindow | deliver | show
	Targets   []launchargs.OpenTarget // float：浮窗打开目标；settings/memo：随事件投递的打开目标
	Groups    []Group                 // deliver：按路由窗口分组的打开目标（缺陷 E）
	SessionID string                  // sessionOpen/deliver/newWindow：目标 AI 会话
	Workspace string                  // sessionOpen：会话归属工作区；deliver：与目标窗口一致时补投
	Pane      string                  // settings：目标设置 pane
	Locator   string                  // memo：便签定位点
	Harness   bool                    // harnessWindow：新窗口是 harness 形态（不恢复工作区、根跟会话）
}

// Group 是 deliver 的一组同窗口打开目标（缺陷 E：按文件所属工作区路由）。
type Group struct {
	WindowName string                  // 路由命中的主窗口名；"" = 主窗口（primary）
	Targets    []launchargs.OpenTarget // 归属同一窗口的目标
}

// Deps 是判定所需的环境依赖（测试注入桩）。
type Deps struct {
	ResolveSessionWorkspace func(string) (string, error) // 会话 id → 归属工作区
	RouteWindowForPath      func(string) string          // 文件路径 → 归属工作区窗口名（"" = 主窗口）
	Warnf                   func(format string, args ...any)
}

// Decide 把第二实例的转发参数解析成动作计划。
func Decide(args []string, deps Deps) Plan {
	resolve := deps.ResolveSessionWorkspace
	if resolve == nil {
		resolve = func(string) (string, error) { return "", errors.New("resolveSessionWorkspace 未注入") }
	}
	warnf := deps.Warnf
	if warnf == nil {
		warnf = func(string, ...any) {}
	}
	switch {
	case launchargs.HasFlag(args, "--quit"):
		return Plan{Kind: "quit"}
	case launchargs.HasFlag(args, "--ai-float"):
		return Plan{Kind: "float", Targets: launchargs.ParseOpenTargets(args)}
	case launchargs.HasFlag(args, "--debug-console"):
		return Plan{Kind: "debug"}
	case launchargs.HasFlag(args, "--harness"):
		// harness 是一个**新窗口形态**，不是「投递给现有窗口」：已有实例时若不特判，
		// 会落到下面的 deliver 分支——把启动目录投给主窗口，harness 窗口根本不开。
		// 与 --new-window 一样必须自己开一个，区别只是窗口形态（不恢复工作区、根跟会话）。
		return Plan{Kind: "harnessWindow", Harness: true, Targets: launchargs.ParseOpenTargets(args)}
	}
	targets := launchargs.ParseOpenTargets(args)
	sessionID := launchargs.ParseAISessionArg(args)
	sessionNoRoute := false
	if sessionID != "" && len(targets) == 0 {
		if ws, err := resolve(sessionID); err == nil && ws != "" {
			return Plan{Kind: "sessionOpen", SessionID: sessionID, Workspace: ws}
		}
		// 会话不存在或无归属：绝不把 CWD 兜底成打开目标（缺陷 B）；但后续定点
		// 分支（settings/memo）继续生效——组合参数不该因会话解析失败被整体吞掉。
		warnf("--ai-session 转发：会话不存在或无归属工作区（%q），仅前置窗口", sessionID)
		sessionNoRoute = true
	}
	if pane := launchargs.ParseOpenSettingsArg(args); pane != "" {
		return Plan{Kind: "settings", Targets: targets, Pane: pane}
	}
	if loc := launchargs.ParseMemoLocatorArg(args); loc != "" {
		return Plan{Kind: "memo", Targets: targets, Locator: loc}
	}
	if len(targets) == 0 {
		if sessionNoRoute {
			return Plan{Kind: "show"}
		}
		targets = launchargs.StartupCwdTarget()
		if len(targets) == 0 {
			return Plan{Kind: "show"}
		}
	}
	if launchargs.HasFlag(args, "--new-window") {
		return Plan{Kind: "newWindow", Targets: targets, SessionID: sessionID}
	}
	plan := Plan{Kind: "deliver"}
	if sessionID != "" {
		if ws, err := resolve(sessionID); err == nil && ws != "" {
			plan.SessionID = sessionID
			plan.Workspace = ws
		} else {
			warnf("--ai-session 转发：会话归属解析失败（%q），仅投递文件", sessionID)
		}
	}
	// 缺陷 E：文件目标按所属工作区路由到对应窗口（祖先链最深命中），按窗口分组
	// 投递；无归属（含目录目标、不存在路径）进主窗口组。
	seen := map[string]int{}
	for _, t := range targets {
		name := ""
		if deps.RouteWindowForPath != nil {
			name = deps.RouteWindowForPath(t.Path)
		}
		if i, ok := seen[name]; ok {
			plan.Groups[i].Targets = append(plan.Groups[i].Targets, t)
			continue
		}
		seen[name] = len(plan.Groups)
		plan.Groups = append(plan.Groups, Group{WindowName: name, Targets: []launchargs.OpenTarget{t}})
	}
	return plan
}
