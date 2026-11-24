package main

// sessionindex_bindings_test.go：走 Wails 绑定层的端到端用例——验证
// 「写会话 → 标脏 → 搜索/统计/删除」闭环（索引引擎的纯逻辑测试在包内）。

import (
	"testing"

	"datalens/internal/sessionindex"
)

func TestAppSessionSearchEndToEnd(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	t.Cleanup(sessionindex.ResetFiles)
	app := &App{}
	header := `{"v":1,"t":"header","id":"s1","title":"端到端会话"}` + "\n"
	msg := `{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"端到端搜索目标","ts":1}}` + "\n"
	if err := app.AISessionAppend("s1", header+msg, true); err != nil {
		t.Fatal(err)
	}
	meta := `{"id":"s1","title":"端到端会话","workspace":"D:/w","updatedAt":1,"messageCount":1,"archivedCount":0}`
	if err := app.AISessionWriteMeta("s1", meta); err != nil {
		t.Fatal(err)
	}
	hits, err := app.AISessionSearch("端到端", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("首次搜索应自动建索引并命中")
	}
	// 追加后搜索应能看到新内容（App 钩子标脏 -> 搜索时重建）
	if err := app.AISessionAppend("s1", `{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"后来补充的词","ts":2}}`+"\n", true); err != nil {
		t.Fatal(err)
	}
	hits, err = app.AISessionSearch("后来补充", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("追加后搜索应命中新消息")
	}
	stats, err := app.AISessionIndexStats()
	if err != nil {
		t.Fatal(err)
	}
	if !stats.Exists || stats.Sessions != 1 || stats.Messages < 2 {
		t.Fatalf("stats = %+v", stats)
	}
	if err := app.AISessionDelete("s1"); err != nil {
		t.Fatal(err)
	}
	hits, err = app.AISessionSearch("端到端", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, hit := range hits {
		if hit.SessionID == "s1" {
			t.Fatalf("删除后不应再命中：%+v", hit)
		}
	}
}
