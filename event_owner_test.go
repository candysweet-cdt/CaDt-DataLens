package main

// event_owner_test.go：归属登记的宿主侧语义（登记表本身的测试随
// internal/eventowner 迁走）。这里只守「拿不到调用方窗口时不登记」——
// 没有它，无窗口上下文的登记会污染归属表，把事件定向到错误窗口。

import "testing"

func TestRegisterEventOwnerNeedsWindow(t *testing.T) {
	// 无窗口上下文：stateForCaller 回退主窗口；没有主窗口时记空，不 panic。
	if err := (&App{}).RegisterEventOwner(nil, "term", "t1"); err != nil {
		t.Fatal(err)
	}
	if err := (&App{}).UnregisterEventOwner(nil, "term", "t1"); err != nil {
		t.Fatal(err)
	}
}
