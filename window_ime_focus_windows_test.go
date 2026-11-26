//go:build windows

package main

// window_ime_focus_windows_test.go：「激活后要不要重新送焦点」这条判定的表驱动测试。
//
// decideIMERepair 是修复逻辑里唯一有分支的部分，也是唯一的正确性风险点
// （历史上 V5 就因为把「允许动作」的条件写成了「跳过」，导致整条修复恒不生效）。
// 这里把六种状态与两个边界都钉死。

import (
	"testing"
	"time"
)

const (
	testHwnd = 0x1000 // 本窗口
	testSub  = 0x2000 // 本窗口里的 webview 子窗口（坏态时焦点在这里）
	testOther = 0x3000 // 别的窗口

	selfPid = uint32(1111) // 本进程
	webPid  = uint32(2222) // msedgewebview2 进程
)

func TestDecideIMERepair(t *testing.T) {
	cases := []struct {
		name string
		in   imeRepairInput
		want imeRepairKind
	}{
		{
			name: "坏态：焦点在 webview 子窗口，根祖先就是本窗口 → 动作",
			in:   imeRepairInput{Foreground: testHwnd, Focus: testSub, Hwnd: testHwnd, RootOfFocus: testHwnd, FocusPid: webPid, SelfPid: selfPid},
			want: imeRepairOK,
		},
		{
			name: "前台已切走：不抢回焦点",
			in:   imeRepairInput{Foreground: testOther, Focus: testSub, Hwnd: testHwnd, RootOfFocus: testHwnd},
			want: imeNoForeground,
		},
		{
			name: "焦点不在本线程队列（GetFocus()=0）：不动作",
			in:   imeRepairInput{Foreground: testHwnd, Focus: 0, Hwnd: testHwnd},
			want: imeNoFocus,
		},
		{
			name: "焦点在宿主窗口本身（Tab 出页面的交接态）：不动作",
			in:   imeRepairInput{Foreground: testHwnd, Focus: testHwnd, Hwnd: testHwnd, RootOfFocus: testHwnd},
			want: imeFocusOnHost,
		},
		{
			name: "焦点在本进程的其它控件（内嵌浏览器）：不抢",
			in:   imeRepairInput{Foreground: testHwnd, Focus: testSub, Hwnd: testHwnd, RootOfFocus: testHwnd, FocusPid: selfPid, SelfPid: selfPid},
			want: imeFocusInOwnProcess,
		},
		{
			name: "焦点在本窗口之外的窗口：不动作",
			in:   imeRepairInput{Foreground: testHwnd, Focus: testOther, Hwnd: testHwnd, RootOfFocus: testOther},
			want: imeFocusElsewhere,
		},
		{
			name: "无窗口句柄：不动作",
			in:   imeRepairInput{Foreground: testHwnd, Focus: testSub, Hwnd: 0, RootOfFocus: testHwnd},
			want: imeFocusElsewhere,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decideIMERepair(c.in); got != c.want {
				t.Fatalf("decideIMERepair() = %v(%d)，期望 %v(%d)", got, got, c.want, c.want)
			}
		})
	}
}

// 守卫必须放行「焦点在子窗口」这种坏态——这条断言专门防 V5 那类回归
// （把允许条件写成跳过，导致修复恒不生效）。
func TestDecideIMERepairNeverSkipsBrokenState(t *testing.T) {
	in := imeRepairInput{Foreground: testHwnd, Focus: testSub, Hwnd: testHwnd, RootOfFocus: testHwnd}
	if got := decideIMERepair(in); got != imeRepairOK {
		t.Fatalf("坏态必须动作，实际得到 %v(%d)", got, got)
	}
}

func TestImeRepairKindString(t *testing.T) {
	for _, k := range []imeRepairKind{imeRepairOK, imeNoForeground, imeNoFocus, imeFocusOnHost, imeFocusInOwnProcess, imeFocusElsewhere} {
		if s := k.String(); s == "" || s == "未知" {
			t.Fatalf("枚举 %d 缺少可读文案", k)
		}
	}
}

func TestImeRepairStateClaimAndSettle(t *testing.T) {
	var st imeRepairState
	now := time.Now()
	if !st.claim(now) {
		t.Fatal("首次触发应当占位成功")
	}
	if st.claim(now) {
		t.Fatal("已有一个待执行动作时不该重复占位")
	}
	st.settle(false) // 失败：只释放占位，不记账
	if !st.claim(now) {
		t.Fatal("失败后应当可以立即重试")
	}
	st.settle(true) // 成功：记账
	if st.claim(now.Add(imeRepairMinGap - 1)) {
		t.Fatal("成功记账后间隔不足应被拦住")
	}
	if !st.claim(now.Add(imeRepairMinGap)) {
		t.Fatal("间隔够了应允许")
	}
}
