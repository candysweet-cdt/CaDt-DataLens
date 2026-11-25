package main

// crashrecovery_app_test.go：崩溃自愈清理范围的护栏。
//
// 事故背景（2026-11-25）：对话中进程闪退后，下次启动的崩溃自愈用 CacheIDs() 全量清理，
// 把上次会话的运行日志（panic 堆栈就写在那里）一起删掉，导致无现场可查。这里锁住两件事：
// app-logs 必须被排除；其余条目一个不少且保序。

import (
	"testing"

	"datalens/internal/storage"
)

func TestCrashCleanIDsSkipsAppLogs(t *testing.T) {
	in := []string{"run-temp", storage.LocAppLogs, "session-index", "webview-cache"}
	want := []string{"run-temp", "session-index", "webview-cache"}

	got := crashCleanIDs(in)
	if len(got) != len(want) {
		t.Fatalf("crashCleanIDs = %v，期望 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("crashCleanIDs = %v，期望 %v（须保持原顺序）", got, want)
		}
	}
	if in[1] != storage.LocAppLogs {
		t.Fatal("crashCleanIDs 不应改写调用方切片")
	}
	// 不含 app-logs 的输入原样返回。
	if got := crashCleanIDs([]string{"ai-logs"}); len(got) != 1 || got[0] != "ai-logs" {
		t.Fatalf("crashCleanIDs([ai-logs]) = %v", got)
	}
	if got := crashCleanIDs(nil); len(got) != 0 {
		t.Fatalf("crashCleanIDs(nil) = %v", got)
	}
}

// 回归：app-logs 必须真在缓存全集里。条目哪天改名或移出 inCache，crashCleanSkip 就悄悄失效了。
func TestCrashCleanSetStillContainsAppLogs(t *testing.T) {
	ids := storageService.CacheIDs()
	cleaned := crashCleanIDs(ids)
	for _, id := range cleaned {
		if id == storage.LocAppLogs {
			t.Fatal("crashCleanIDs 仍包含 app-logs：崩溃现场会被删掉")
		}
	}
	if len(cleaned) != len(ids)-1 {
		t.Fatalf("应只剔除 app-logs 一条：%d → %d（条目表变了就同步这里）", len(ids), len(cleaned))
	}
}
