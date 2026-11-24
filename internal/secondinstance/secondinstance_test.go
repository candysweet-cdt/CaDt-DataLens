package secondinstance

// secondinstance_test.go：Decide（转发参数 → 动作计划）的表驱动测试。
// 原根目录 secondinstance_plan_test.go 迁入；执行层（secondInstance）只碰窗口 API，
// 不可单测，决策语义全部钉在这里。
// 修正语义对应方案 docs/unfinished-plans/cli-startup-args-refresh.md §3.4（B/C/D/E）。

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"datalens/internal/launchargs"
)

// resolveStub 测试注入的会话归属解析：sess-1 → D:/proj，其余报错（sess-empty 归属未知）。
func resolveStub(id string) (string, error) {
	if id == "sess-1" {
		return "D:/proj", nil
	}
	if id == "sess-empty" {
		return "", nil
	}
	return "", errors.New("session-gone")
}

// routeStub 模拟祖先链路由语义（真实实现的专项测试见根目录 TestRouteWindowForPath）：
// main-2 管最深子工作区 D:\proj\sub，main 管 D:\proj，其余无归属。
func routeStub(p string) string {
	key := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))
	switch {
	case strings.HasPrefix(key, "d:/proj/sub"):
		return "main-2"
	case strings.HasPrefix(key, "d:/proj"):
		return "main"
	default:
		return ""
	}
}

func TestDecide(t *testing.T) {
	projFile := "D:/proj/a.json"
	subFile := "D:/proj/sub/x.json"
	otherFile := "D:/else/b.json"
	cases := []struct {
		name  string
		args  []string
		route func(string) string
		want  Plan
	}{
		{"quit", []string{"--quit"}, nil, Plan{Kind: "quit"}},
		{"float-with-targets", []string{"--ai-float", projFile}, nil,
			Plan{Kind: "float", Targets: []launchargs.OpenTarget{{Path: projFile}}}},
		{"float-bare", []string{"--ai-float"}, nil,
			Plan{Kind: "float", Targets: []launchargs.OpenTarget{}}},
		{"debug", []string{"--debug-console"}, nil, Plan{Kind: "debug"}},
		// 缺陷 B：单独 --ai-session → 解析归属走 sessionOpen；失败只前置。
		{"session-open", []string{"--ai-session=sess-1"}, nil,
			Plan{Kind: "sessionOpen", SessionID: "sess-1", Workspace: "D:/proj"}},
		{"session-gone-show", []string{"--ai-session=gone"}, nil, Plan{Kind: "show"}},
		{"session-empty-ws-show", []string{"--ai-session=sess-empty"}, nil, Plan{Kind: "show"}},
		// 审查 P2-3：会话解析失败不吞同命令行的定点分支（settings/memo 仍生效）；
		// 会话解析成功则 sessionOpen 优先（转发路径二选一，与冷启动并存语义的差异记方案 §7）。
		{"session-gone-settings-fallthrough", []string{"--ai-session=gone", "--open-settings=ai"}, nil,
			Plan{Kind: "settings", Pane: "ai", Targets: []launchargs.OpenTarget{}}},
		{"session-open-overrides-settings", []string{"--ai-session=sess-1", "--open-settings=ai"}, nil,
			Plan{Kind: "sessionOpen", SessionID: "sess-1", Workspace: "D:/proj"}},
		// 审查 P3-4：--new-window + --ai-session（无文件）走 sessionOpen 同工作区复用
		//（「同一工作区禁止双开」裁定），--new-window 被忽略。
		{"session-open-ignores-new-window", []string{"--new-window", "--ai-session=sess-1"}, nil,
			Plan{Kind: "sessionOpen", SessionID: "sess-1", Workspace: "D:/proj"}},
		{"settings", []string{"--open-settings=ai"}, nil,
			Plan{Kind: "settings", Pane: "ai", Targets: []launchargs.OpenTarget{}}},
		// 缺陷 D：定点打开不再吞掉同命令行的文件目标。
		{"settings-with-files", []string{"--open-settings=ai", projFile}, nil,
			Plan{Kind: "settings", Pane: "ai",
				Targets: []launchargs.OpenTarget{{Path: projFile}}}},
		{"memo", []string{"--memo=cadt-memo://workspace/item/it-1"}, nil,
			Plan{Kind: "memo", Locator: "cadt-memo://workspace/item/it-1",
				Targets: []launchargs.OpenTarget{}}},
		{"memo-with-files", []string{"--memo=cadt-memo://workspace/item/it-1", projFile}, nil,
			Plan{Kind: "memo", Locator: "cadt-memo://workspace/item/it-1",
				Targets: []launchargs.OpenTarget{{Path: projFile}}}},
		// 缺陷 C：--ai-session + 文件转发 → deliver 且带会话归属（供执行层比对窗口）。
		{"deliver-session-match", []string{"--ai-session=sess-1", projFile}, nil,
			Plan{Kind: "deliver", SessionID: "sess-1", Workspace: "D:/proj",
				Groups: []Group{{Targets: []launchargs.OpenTarget{{Path: projFile}}}}}},
		{"deliver-session-gone", []string{"--ai-session=gone", projFile}, nil,
			Plan{Kind: "deliver",
				Groups: []Group{{Targets: []launchargs.OpenTarget{{Path: projFile}}}}}},
		{"new-window", []string{"--new-window", projFile}, nil,
			Plan{Kind: "newWindow", Targets: []launchargs.OpenTarget{{Path: projFile}}}},
		{"new-window-with-session", []string{"--new-window", "D:/proj", "--ai-session=sess-1"}, nil,
			Plan{Kind: "newWindow", SessionID: "sess-1",
				Targets: []launchargs.OpenTarget{{Path: "D:/proj"}}}},
		// 无路由依赖：全部目标进主窗口组（旧单窗口行为等价）。
		{"deliver-plain", []string{projFile}, nil,
			Plan{Kind: "deliver",
				Groups: []Group{{Targets: []launchargs.OpenTarget{{Path: projFile}}}}}},
		{"deliver-line-column", []string{"--line", "9", projFile}, nil,
			Plan{Kind: "deliver",
				Groups: []Group{{Targets: []launchargs.OpenTarget{{Path: projFile, Line: 9}}}}}},
		// 缺陷 E：文件按所属工作区路由分组，无归属目标进主窗口组。
		{"deliver-routed-groups", []string{subFile, projFile, otherFile}, routeStub,
			Plan{Kind: "deliver", Groups: []Group{
				{WindowName: "main-2", Targets: []launchargs.OpenTarget{{Path: subFile}}},
				{WindowName: "main", Targets: []launchargs.OpenTarget{{Path: projFile}}},
				{WindowName: "", Targets: []launchargs.OpenTarget{{Path: otherFile}}},
			}}},
		{"deliver-routed-with-session", []string{"--ai-session=sess-1", subFile}, routeStub,
			Plan{Kind: "deliver", SessionID: "sess-1", Workspace: "D:/proj",
				Groups: []Group{
					{WindowName: "main-2", Targets: []launchargs.OpenTarget{{Path: subFile}}},
				}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Decide(tc.args, Deps{
				ResolveSessionWorkspace: resolveStub,
				RouteWindowForPath:      tc.route,
			})
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Decide(%v) = %+v, want %+v", tc.args, got, tc.want)
			}
		})
	}
}

func TestDecideBareArgsDeliversCwd(t *testing.T) {
	// 裸转发（无任何参数）维持现状：CWD 兜底成打开目标投主窗口
	//（sessionOpen 分支已接管 --ai-session 场景，不会再落到这里）。
	want := launchargs.StartupCwdTarget()
	if len(want) == 0 {
		t.Skip("测试 CWD 等于 exe 目录（StartupCwdTarget 返回空），跳过")
	}
	got := Decide(nil, Deps{ResolveSessionWorkspace: resolveStub})
	if got.Kind != "deliver" || len(got.Groups) != 1 ||
		!reflect.DeepEqual(got.Groups[0].Targets, want) || got.Groups[0].WindowName != "" {
		t.Fatalf("bare args = %+v, want deliver with primary group targets %+v", got, want)
	}
}

// TestDecideInjectedWarn 守一个容易退化的细节：注入的 Warnf 必须被真的调用，
// 否则「会话解析失败仅投递文件」这类静默丢 id 的旧缺陷会悄悄回来。
func TestDecideInjectedWarn(t *testing.T) {
	var warned []string
	Decide([]string{"--ai-session=gone", "D:/proj/a.json"}, Deps{
		ResolveSessionWorkspace: resolveStub,
		Warnf: func(format string, args ...any) {
			warned = append(warned, format)
		},
	})
	if len(warned) != 1 {
		t.Fatalf("会话归属解析失败应 warn 一次，实际 %d 次：%v", len(warned), warned)
	}
}
