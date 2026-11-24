package main

// 关闭行为（最小化到托盘 / 直接退出）的判定守卫。
//
// 这里只钉「什么情况下允许藏窗口」这一条：藏错了的后果比退出更严重——窗口和任务栏
// 按钮一起消失，用户找不到程序，只能去任务管理器结束进程。多窗口下藏错还会在通知区
// 堆出一串图标，每个只能唤回自己那个窗口。

import (
	"testing"

	"datalens/internal/appconfig"
)

func TestShouldHideOnClose(t *testing.T) {
	cases := []struct {
		name         string
		action       string
		portable     bool
		force        bool
		quitRequest  bool
		shuttingDown bool
		want         bool
	}{
		{"默认直接退出", appconfig.CloseActionExit, true, false, false, false, false},
		{"空配置按退出处理", "", true, false, false, false, false},
		{"托盘模式主窗口一律藏", appconfig.CloseActionTray, true, false, false, false, true},
		{"托盘但本进程是附属窗口（浮窗/调试台）", appconfig.CloseActionTray, false, false, false, false, false},
		{"托盘但正在强制退出", appconfig.CloseActionTray, true, true, false, false, false},
		{"托盘但用户点了退出", appconfig.CloseActionTray, true, false, true, false, false},
		{"托盘但系统正在关机", appconfig.CloseActionTray, true, false, false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldHideOnClose(tc.action, tc.portable, tc.force, tc.quitRequest, tc.shuttingDown)
			if got != tc.want {
				t.Fatalf("shouldHideOnClose(%q, portable=%v, force=%v, quit=%v, shutdown=%v) = %v，期望 %v",
					tc.action, tc.portable, tc.force, tc.quitRequest, tc.shuttingDown, got, tc.want)
			}
		})
	}
}
