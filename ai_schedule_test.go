package main

import (
	"strings"
	"testing"
	"time"
)

// resetAIScheduleTest 清空调度器全局状态并让 appDataRoot 指向临时目录。
func resetAIScheduleTest(t *testing.T) {
	t.Helper()
	t.Setenv("AppData", t.TempDir())
	t.Cleanup(func() {
		aiScheduleMu.Lock()
		if aiScheduleDB != nil {
			_ = aiScheduleDB.Close()
			aiScheduleDB = nil
		}
		aiSchedules = nil
		aiScheduleSeq = 0
		if aiScheduleStopCh != nil {
			close(aiScheduleStopCh)
			aiScheduleStopCh = nil
		}
		aiScheduleMu.Unlock()
	})
}

func TestAIParseCronField(t *testing.T) {
	cases := []struct {
		field  string
		lo, hi int
		check  map[int]bool
		star   bool
	}{
		{"*", 0, 59, nil, true},
		{"*/15", 0, 59, map[int]bool{0: true, 15: true, 30: true, 45: true}, false},
		{"1-5", 1, 31, map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}, false},
		{"1-10/3", 0, 59, map[int]bool{1: true, 4: true, 7: true, 10: true}, false},
		{"5,20,59", 0, 59, map[int]bool{5: true, 20: true, 59: true}, false},
		{"0", 0, 7, map[int]bool{0: true}, false},
	}
	for _, c := range cases {
		f, err := aiParseCronField(c.field, c.lo, c.hi, 1)
		if err != nil {
			t.Fatalf("解析 %q 失败: %v", c.field, err)
		}
		if f.star != c.star {
			t.Fatalf("%q star 应为 %v，实际 %v", c.field, c.star, f.star)
		}
		if c.check != nil {
			for v := range c.check {
				if !f.match(v) {
					t.Fatalf("%q 应匹配 %d", c.field, v)
				}
			}
			for v := c.lo; v <= c.hi; v++ {
				if !c.check[v] && f.match(v) {
					t.Fatalf("%q 不应匹配 %d", c.field, v)
				}
			}
		}
	}
	for _, bad := range []string{"", "60", "abc", "1-", "*/0", "5-2"} {
		if _, err := aiParseCronField(bad, 0, 59, 1); err == nil {
			t.Fatalf("%q 应解析失败", bad)
		}
	}
}

func TestAICronNextAfter(t *testing.T) {
	base := time.Date(2026, 11, 12, 10, 3, 30, 0, time.Local) // 周四
	cases := []struct {
		spec string
		want time.Time
	}{
		{"*/5 * * * *", time.Date(2026, 11, 12, 10, 5, 0, 0, time.Local)},
		{"30 9 * * *", time.Date(2026, 11, 13, 9, 30, 0, 0, time.Local)},  // 明天 9:30
		{"10 10 * * *", time.Date(2026, 11, 12, 10, 10, 0, 0, time.Local)}, // 今天 10:10 尚未到
		{"0 12 1 * *", time.Date(2026, 12, 1, 12, 0, 0, 0, time.Local)},   // 下月 1 日
		{"0 8 * * 1", time.Date(2026, 11, 16, 8, 0, 0, 0, time.Local)},    // 下周一
	}
	for _, c := range cases {
		got, ok := aiCronNextAfter(c.spec, base)
		if !ok {
			t.Fatalf("%s 应有下一个触发时刻", c.spec)
		}
		if !got.Equal(c.want) {
			t.Fatalf("%s: 期望 %s，实际 %s", c.spec, c.want, got)
		}
	}
	if _, ok := aiCronNextAfter("bad spec", base); ok {
		t.Fatal("非法表达式应返回 false")
	}
}

func TestAIScheduleAlignNext(t *testing.T) {
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.Local).UnixMilli()
	step := int64(10 * 60_000)
	// 上一次触发 09:55，错过 10:00 → 顺延到 10:05
	prev := now - 5*60_000
	if got := aiScheduleAlignNext(now, prev, 10); got != prev+step {
		t.Fatalf("顺延结果异常: %d", got)
	}
	// prev 严重落后（停机 1 小时）→ 追到 now 之后的第一个整周期
	prevOld := now - 60*60_000
	got := aiScheduleAlignNext(now, prevOld, 10)
	if got <= now || got > now+step {
		t.Fatalf("应落在 (now, now+step]: %d", got)
	}
	// prev 为 0 → 从现在起一个周期
	if got := aiScheduleAlignNext(now, 0, 10); got != now+step {
		t.Fatalf("prev=0 应为 now+step: %d", got)
	}
}

func TestAIScheduleCreateValidate(t *testing.T) {
	resetAIScheduleTest(t)
	app := &App{}
	if _, err := app.AIScheduleCreate(AIScheduleInput{Kind: "interval", IntervalMinutes: 5}); err == nil {
		t.Fatal("缺少 prompt 应被拒绝")
	}
	if _, err := app.AIScheduleCreate(AIScheduleInput{Kind: "interval", Prompt: "x"}); err == nil {
		t.Fatal("interval 缺 intervalMinutes 应被拒绝")
	}
	if _, err := app.AIScheduleCreate(AIScheduleInput{Kind: "once", Prompt: "x", At: "2020-01-01 08:00"}); err == nil {
		t.Fatal("once 过去时间应被拒绝")
	}
	if _, err := app.AIScheduleCreate(AIScheduleInput{Kind: "cron", Prompt: "x", Cron: "99 * * * *"}); err == nil {
		t.Fatal("非法 cron 应被拒绝")
	}
	long := strings.Repeat("字", aiSchedulePromptMax+1)
	if _, err := app.AIScheduleCreate(AIScheduleInput{Kind: "interval", IntervalMinutes: 5, Prompt: long}); err == nil {
		t.Fatal("prompt 超限应被拒绝")
	}
}

func TestAIScheduleCreateListDeleteRoundtrip(t *testing.T) {
	resetAIScheduleTest(t)
	app := &App{}
	s, err := app.AIScheduleCreate(AIScheduleInput{
		Name: "每 10 分钟问好", Kind: "interval", IntervalMinutes: 10,
		Prompt: "向用户问好", Scope: "chat",
	})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	if s.Id == "" || s.NextRunAt <= time.Now().UnixMilli() {
		t.Fatalf("nextRunAt 应指向将来: %+v", s)
	}
	if s.Scope != "chat" || !s.Enabled || s.MaxRuns != 0 {
		t.Fatalf("默认值异常: %+v", s)
	}
	list, err := app.AIScheduleList()
	if err != nil || len(list) != 1 {
		t.Fatalf("列表应含 1 项: %v err=%v", list, err)
	}
	if _, err := app.AIScheduleUpdate(s.Id, AIScheduleInput{
		Name: "改名", Kind: "interval", IntervalMinutes: 20, Prompt: "问好 v2",
	}); err != nil {
		t.Fatalf("更新失败: %v", err)
	}
	list, _ = app.AIScheduleList()
	if list[0].IntervalMinutes != 20 || list[0].Name != "改名" {
		t.Fatalf("更新未生效: %+v", list[0])
	}
	toggled, err := app.AIScheduleToggle(s.Id, false)
	if err != nil || toggled.Enabled {
		t.Fatalf("停用失败: %+v err=%v", toggled, err)
	}
	if err := app.AIScheduleSetResult(s.Id, false, "目标会话不存在"); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	list, _ = app.AIScheduleList()
	if !strings.Contains(list[0].LastResult, "执行失败") {
		t.Fatalf("结果未回写: %q", list[0].LastResult)
	}
	if err := app.AIScheduleDelete(s.Id); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if err := app.AIScheduleDelete(s.Id); err == nil {
		t.Fatal("重复删除应报错")
	}
	list, _ = app.AIScheduleList()
	if len(list) != 0 {
		t.Fatalf("删除后列表应为空: %d", len(list))
	}
}

func TestAIScheduleTickOnceFiresAndRemoves(t *testing.T) {
	resetAIScheduleTest(t)
	app := &App{} // ctx 为 nil：不真正发事件，仅验证扫描与状态推进
	future := time.Now().Add(2 * time.Minute).Format(time.RFC3339)
	_, err := app.AIScheduleCreate(AIScheduleInput{Kind: "once", Prompt: "提醒我", At: future})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	// 人为把触发时间拨到过去，模拟到期（AIScheduleList 返回内部指针）
	list, _ := app.AIScheduleList()
	aiScheduleMu.Lock()
	list[0].NextRunAt = time.Now().Add(-time.Second).UnixMilli()
	aiScheduleMu.Unlock()
	app.aiScheduleTick()
	list, _ = app.AIScheduleList()
	if len(list) != 0 {
		t.Fatalf("once 触发后应自动删除，剩余 %d", len(list))
	}
}

func TestAIScheduleTickIntervalAdvances(t *testing.T) {
	resetAIScheduleTest(t)
	app := &App{}
	_, err := app.AIScheduleCreate(AIScheduleInput{Kind: "interval", IntervalMinutes: 2, Prompt: "检查", MaxRuns: 2})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	list, _ := app.AIScheduleList()
	aiScheduleMu.Lock()
	list[0].NextRunAt = time.Now().Add(-time.Second).UnixMilli()
	aiScheduleMu.Unlock()
	app.aiScheduleTick()
	list, _ = app.AIScheduleList()
	if len(list) != 1 {
		t.Fatalf("未达 maxRuns 不应删除: %d", len(list))
	}
	if list[0].RunCount != 1 {
		t.Fatalf("runCount 应为 1: %+v", list[0])
	}
	if list[0].NextRunAt <= time.Now().UnixMilli() {
		t.Fatalf("nextRunAt 应已顺延到将来: %+v", list[0])
	}
	// 第二次触发达到 maxRuns=2 → 自动删除
	aiScheduleMu.Lock()
	list[0].NextRunAt = time.Now().Add(-time.Second).UnixMilli()
	aiScheduleMu.Unlock()
	app.aiScheduleTick()
	list, _ = app.AIScheduleList()
	if len(list) != 0 {
		t.Fatalf("达到 maxRuns 应自动删除，剩余 %d", len(list))
	}
}

func TestAIScheduleReloadMissedOnceDisabled(t *testing.T) {
	resetAIScheduleTest(t)
	app := &App{}
	at := time.Now().Add(2 * time.Minute).Format(time.RFC3339)
	if _, err := app.AIScheduleCreate(AIScheduleInput{Kind: "once", Prompt: "错过我", At: at}); err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	// 关库 + 把 DB 行的 next_run_at 拨到过去，模拟「应用未运行期间错过」后重启加载
	aiScheduleMu.Lock()
	past := time.Now().Add(-time.Hour).UnixMilli()
	if _, err := aiScheduleDB.Exec(`UPDATE ai_schedules SET next_run_at = ?`, past); err != nil {
		t.Fatalf("拨时间失败: %v", err)
	}
	_ = aiScheduleDB.Close()
	aiScheduleDB = nil
	aiSchedules = nil
	aiScheduleMu.Unlock()
	if err := aiScheduleEnsureLoaded(); err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	list, _ := app.AIScheduleList()
	if len(list) != 1 {
		t.Fatalf("错过记录应保留: %d", len(list))
	}
	if list[0].Enabled || !strings.Contains(list[0].LastResult, "已错过") {
		t.Fatalf("错过的 once 应停用并标记: %+v", list[0])
	}
	// 不会补跑
	app.aiScheduleTick()
	if got := list[0].RunCount; got != 0 {
		t.Fatalf("不应补跑，runCount=%d", got)
	}
}

func TestAIScheduleCronRoundtrip(t *testing.T) {
	resetAIScheduleTest(t)
	app := &App{}
	s, err := app.AIScheduleCreate(AIScheduleInput{Kind: "cron", Prompt: "每分钟", Cron: "* * * * *"})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	nextMinute := time.Now().Truncate(time.Minute).Add(time.Minute)
	if got := time.UnixMilli(s.NextRunAt); got.Before(nextMinute.Add(-time.Second)) || got.After(nextMinute.Add(time.Second)) {
		t.Fatalf("每分钟 cron 应在下个整分: %s", got)
	}
	// 触发推进：仍保留并计数（maxRuns=0 不限）
	list, _ := app.AIScheduleList()
	aiScheduleMu.Lock()
	list[0].NextRunAt = time.Now().Add(-time.Second).UnixMilli()
	aiScheduleMu.Unlock()
	app.aiScheduleTick()
	list, _ = app.AIScheduleList()
	if len(list) != 1 || list[0].RunCount != 1 {
		t.Fatalf("cron 触发后应保留并计数: %+v", list)
	}
}