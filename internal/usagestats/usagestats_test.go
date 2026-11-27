package usagestats

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"datalens/internal/appdata"
)

// ===== 事件与日志行解析 =====
func TestEventFromInput(t *testing.T) {
	now := time.Now().UnixMilli()
	ev, err := eventFromInput(RecordInput{
		SessionID: " s1 ", Ts: 1700000000,
		Model: " deepseek-chat ", ModelMs: 3200, TtftMs: 900, StatusCode: 200,
		Usage: &UsageField{PromptTokens: 100, CompletionTokens: 50},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ev.SessionID != "s1" || ev.Model != "deepseek-chat" {
		t.Fatalf("字段没归一：%+v", ev)
	}
	if ev.ModelMs != 3200 || ev.TtftMs != 900 || ev.StatusCode != 200 {
		t.Fatalf("请求日志字段没保留：%+v", ev)
	}
	if ev.Ts != 1700000000000 {
		t.Fatalf("秒级时间戳没转毫秒：%d", ev.Ts)
	}
	if ev.TotalTokens != 150 {
		t.Fatalf("total 缺失时没回退输入+输出：%d", ev.TotalTokens)
	}
	if ev.ID != "s1:1700000000000" {
		t.Fatalf("幂等键不对：%s", ev.ID)
	}
	// 负值裁剪 + 显式 total 优先
	ev, err = eventFromInput(RecordInput{
		SessionID: "s1", Ts: now, Model: "", Usage: &UsageField{PromptTokens: -5, CompletionTokens: -1, TotalTokens: 30},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ev.PromptTokens != 0 || ev.CompletionTokens != 0 || ev.TotalTokens != 30 {
		t.Fatalf("负值没裁剪或 total 没保留：%+v", ev)
	}
	if ev.Model != unknownModelName {
		t.Fatalf("空模型名没兜底：%q", ev.Model)
	}
	if ev.StatusCode != 0 || ev.ModelMs != 0 || ev.TtftMs != 0 {
		t.Fatalf("缺省请求字段应归零：%+v", ev)
	}
	// 异常状态码裁剪为「未记录」
	ev, err = eventFromInput(RecordInput{
		SessionID: "s1", Ts: now, StatusCode: 42,
		Usage: &UsageField{TotalTokens: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ev.StatusCode != 0 {
		t.Fatalf("非法状态码没裁剪：%d", ev.StatusCode)
	}
	// 群聊带 messageId 时幂等键优先用它（与扫描侧 gid 对齐）
	ev, err = eventFromInput(RecordInput{
		SessionID: "group:g1", MessageID: "gm-1", Ts: now,
		Usage: &UsageField{TotalTokens: 5},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ev.ID != "group:g1:gm-1" {
		t.Fatalf("messageId 幂等键：%s", ev.ID)
	}
	// 超长 messageId 裁剪，避免一条异常载荷把主键撑爆
	ev, err = eventFromInput(RecordInput{
		SessionID: "s1", MessageID: strings.Repeat("x", 300), Ts: now,
		Usage: &UsageField{TotalTokens: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ev.ID) > len("s1:")+256 {
		t.Fatalf("messageId 没截断：%d", len(ev.ID))
	}
	// 非法载荷
	if _, err := eventFromInput(RecordInput{SessionID: "", Usage: &UsageField{}}); err == nil {
		t.Fatal("空 sessionId 应报错")
	}
	if _, err := eventFromInput(RecordInput{SessionID: "s1", Usage: nil}); err == nil {
		t.Fatal("空 usage 应报错")
	}
}

func TestParseSessionLogLine(t *testing.T) {
	line := []byte(`{"v":1,"t":"msg","mid":"m1","m":{"role":"assistant","ts":1700000000000,"model":"claude-sonnet","modelAccount":"acct","modelMs":2500,"firstTokenMs":800,"statusCode":200,"usage":{"promptTokens":120,"completionTokens":80,"totalTokens":200,"cachedTokens":10,"cacheWriteTokens":5}}}` + "\n")
	ev, ok := parseSessionLogLine("sess", line)
	if !ok {
		t.Fatal("正常的 assistant 用量行应解析成功")
	}
	if ev.ID != "sess:1700000000000" || ev.Model != "claude-sonnet" || ev.ModelAccount != "acct" {
		t.Fatalf("字段不对：%+v", ev)
	}
	if ev.TotalTokens != 200 || ev.CachedTokens != 10 || ev.CacheWriteTokens != 5 {
		t.Fatalf("token 不对：%+v", ev)
	}
	if ev.ModelMs != 2500 || ev.TtftMs != 800 || ev.StatusCode != 200 {
		t.Fatalf("请求日志字段不对：%+v", ev)
	}
	// 用户消息 / 无 usage / 无 ts 都跳过
	for _, raw := range []string{
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"user","ts":1700000000000}}`,
		`{"v":1,"t":"msg","mid":"m3","m":{"role":"assistant","ts":1700000000000}}`,
		`{"v":1,"t":"msg","mid":"m4","m":{"role":"assistant","usage":{"totalTokens":1}}}`,
		`{"v":1,"t":"header","id":"sess"}`,
		`not json`,
	} {
		if _, ok := parseSessionLogLine("sess", []byte(raw)); ok {
			t.Fatalf("不该解析：%s", raw)
		}
	}
	// total 缺失回退
	ev, ok = parseSessionLogLine("sess", []byte(`{"v":1,"t":"msg","m":{"role":"assistant","ts":1700000001000,"usage":{"promptTokens":3,"completionTokens":4}}}`))
	if !ok || ev.TotalTokens != 7 {
		t.Fatalf("total 回退失败：%+v ok=%v", ev, ok)
	}
}

func TestParseGroupLogLine(t *testing.T) {
	line := []byte(`{"kind":"msg","gid":"gm-1","role":"assistant","ts":1700000000000,"model":"gpt-x","modelAccount":"账号A","agentName":"成员A","statusCode":200,"usage":{"promptTokens":30,"completionTokens":20,"totalTokens":50},"timing":{"totalMs":1234,"ttftMs":456}}` + "\n")
	ev, ok := parseGroupLogLine("group:g1", line)
	if !ok {
		t.Fatal("正常群聊发言应解析成功")
	}
	if ev.ID != "group:g1:gm-1" || ev.SessionID != "group:g1" {
		t.Fatalf("群聊幂等键/会话：%+v", ev)
	}
	if ev.Model != "gpt-x" || ev.ModelAccount != "账号A" || ev.TotalTokens != 50 || ev.TurnMs != 1234 {
		t.Fatalf("群聊字段：%+v", ev)
	}
	if ev.ModelMs != 1234 || ev.TtftMs != 456 || ev.StatusCode != 200 {
		t.Fatalf("群聊请求日志字段：%+v", ev)
	}
	for _, raw := range []string{
		`{"kind":"system","role":"assistant","ts":1700000000000,"usage":{"totalTokens":1}}`,
		`{"kind":"msg","role":"user","ts":1700000000000,"usage":{"totalTokens":1}}`,
		`{"kind":"msg","role":"assistant","ts":1700000000000,"usage":null}`,
		`{"kind":"msg","role":"assistant","usage":{"totalTokens":1}}`,
		`not json`,
	} {
		if _, ok := parseGroupLogLine("group:g1", []byte(raw)); ok {
			t.Fatalf("不该解析：%s", raw)
		}
	}
	// 没有 gid 时回退到 ts
	ev, ok = parseGroupLogLine("group:g1", []byte(`{"kind":"msg","role":"assistant","ts":1700000001000,"usage":{"totalTokens":2}}`))
	if !ok || ev.ID != "group:g1:1700000001000" {
		t.Fatalf("gid 缺失回退：%+v ok=%v", ev, ok)
	}
}

// ===== 请求加载与迁移 =====
func TestLoadRequests(t *testing.T) {
	root := t.TempDir()
	dataRoot = func() string { return root }
	t.Cleanup(func() {
		Close()
		dataRoot = appdata.Root
	})
	base := time.Now().UnixMilli()
	for i := 0; i < 3; i++ {
		payload := fmt.Sprintf(`{"sessionId":"s%d","ts":%d,"model":"m%d","modelAccount":"acct-%d","modelMs":%d,"ttftMs":%d,"statusCode":200,"usage":{"promptTokens":%d,"completionTokens":%d,"cachedTokens":5,"cacheWriteTokens":2}}`,
			i, base+int64(i), i, i, 1000+i, 100+i, 100+i, 50+i)
		if err := Record(payload); err != nil {
			t.Fatal(err)
		}
	}
	page, err := LoadRequests(0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Items) != 2 {
		t.Fatalf("第一页：%+v", page)
	}
	if page.Items[0].Ts != base+2 || page.Items[0].ModelAccount != "acct-2" || page.Items[0].ModelMs != 1002 || page.Items[0].TtftMs != 102 || page.Items[0].StatusCode != 200 {
		t.Fatalf("倒序/字段：%+v", page.Items[0])
	}
	if page.Items[1].Ts != base+1 {
		t.Fatalf("第二行应为中间一条：%+v", page.Items[1])
	}
	page, err = LoadRequests(2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Ts != base {
		t.Fatalf("最后一页：%+v", page)
	}
	// 非法分页参数收敛：负 offset → 0，0 limit → 默认 10
	page, err = LoadRequests(-5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Offset != 0 || page.Limit != 10 || len(page.Items) != 3 {
		t.Fatalf("分页参数收敛：%+v", page)
	}
}

// 老库升级：补 model_ms/ttft_ms/status_code，并清空一次扫描游标让历史会话重读回填。
func TestEnsureDBMigratesRequestLogColumns(t *testing.T) {
	Close()
	root := t.TempDir()
	dataRoot = func() string { return root }
	t.Cleanup(func() {
		Close()
		dataRoot = appdata.Root
	})

	raw, err := sql.Open("sqlite", filepath.Join(root, usageDBFileName))
	if err != nil {
		t.Fatal(err)
	}
	_, err = raw.Exec(`
CREATE TABLE usage_events (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	model TEXT NOT NULL DEFAULT '',
	model_account TEXT NOT NULL DEFAULT '',
	prompt_tokens INTEGER NOT NULL DEFAULT 0,
	completion_tokens INTEGER NOT NULL DEFAULT 0,
	total_tokens INTEGER NOT NULL DEFAULT 0,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	turn_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE usage_sync_state (
	session_id TEXT PRIMARY KEY,
	byte_offset INTEGER NOT NULL DEFAULT 0,
	file_size INTEGER NOT NULL DEFAULT 0,
	file_mtime INTEGER NOT NULL DEFAULT 0,
	prefix_hash TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO usage_sync_state (session_id, byte_offset, file_size, file_mtime, prefix_hash, updated_at)
VALUES ('s1', 10, 20, 30, 'abc', 1);
`)
	if err != nil {
		_ = raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	if err := ensureDB(); err != nil {
		t.Fatal(err)
	}
	conn := db()
	if conn == nil {
		t.Fatal("迁移后连接为空")
	}
	rows, err := conn.Query(`PRAGMA table_info(usage_events)`)
	if err != nil {
		t.Fatal(err)
	}
	columns := make(map[string]bool, 16)
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			_ = rows.Close()
			t.Fatal(err)
		}
		columns[name] = true
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"model_ms", "ttft_ms", "status_code"} {
		if !columns[name] {
			t.Fatalf("迁移后缺列 %s：%+v", name, columns)
		}
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM usage_sync_state`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("迁移后应清空扫描游标，实际剩 %d 条", count)
	}
}

// ===== 快照与热力图 =====
func TestBuildSnapshotStreaks(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, loc)
	at := func(day, hour int) int64 {
		return time.Date(2026, 11, day, hour, 0, 0, 0, loc).UnixMilli()
	}
	events := []Event{
		{ID: "a", SessionID: "s1", Ts: at(17, 10), Model: "m1", TotalTokens: 100, TurnMs: 2 * time.Hour.Milliseconds()},
		{ID: "b", SessionID: "s1", Ts: at(17, 12), Model: "m1", TotalTokens: 50},
		{ID: "c", SessionID: "s2", Ts: at(18, 9), Model: "m2", TotalTokens: 200},
		{ID: "d", SessionID: "s2", Ts: at(19, 9), Model: "m1", TotalTokens: 300},
		{ID: "e", SessionID: "s3", Ts: at(15, 9), Model: "m2", TotalTokens: 10},
	}
	snap := buildSnapshot(events, "7d", now)
	if snap.Summary.TotalTokens != 660 {
		t.Fatalf("总量：%d", snap.Summary.TotalTokens)
	}
	if snap.Summary.CurrentStreakDays != 3 || snap.Summary.LongestStreakDays != 3 {
		t.Fatalf("连续天数：current=%d longest=%d", snap.Summary.CurrentStreakDays, snap.Summary.LongestStreakDays)
	}
	if snap.Summary.ActiveDays != 4 {
		t.Fatalf("活跃天数：%d", snap.Summary.ActiveDays)
	}
	if snap.Summary.PeakDayTokens != 300 || snap.Summary.PeakDay != "2026-11-19" {
		t.Fatalf("峰值日：%+v", snap.Summary)
	}
	if snap.Summary.LongestSessionMs != 2*time.Hour.Milliseconds() {
		t.Fatalf("最长聊天时长应取 turnMs：%d", snap.Summary.LongestSessionMs)
	}
	if snap.Summary.TotalSessions != 3 || snap.Summary.TotalRequests != 5 {
		t.Fatalf("会话/请求数：%+v", snap.Summary)
	}

	// 未来时间戳（时钟回拨）归到当前时刻：汇总与热力图口径保持一致
	future := append(events, Event{ID: "f", SessionID: "s4", Ts: now.AddDate(0, 0, 3).UnixMilli(), Model: "m1", TotalTokens: 70})
	snap = buildSnapshot(future, "7d", now)
	if snap.Summary.ActiveDays != 4 || snap.Summary.TotalTokens != 730 || snap.Summary.LastDay != "2026-11-19" {
		t.Fatalf("未来时间戳口径：%+v", snap.Summary)
	}

	// 今天没有用量：当前连续归 0，最长连续不变
	tomorrow := now.AddDate(0, 0, 1)
	snap = buildSnapshot(events, "7d", tomorrow)
	if snap.Summary.CurrentStreakDays != 0 || snap.Summary.LongestStreakDays != 3 {
		t.Fatalf("次日口径：current=%d longest=%d", snap.Summary.CurrentStreakDays, snap.Summary.LongestStreakDays)
	}
}

func TestBuildSnapshotRange(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, loc)
	old := time.Date(2026, 10, 1, 10, 0, 0, 0, loc).UnixMilli() // 窗口外
	recent := time.Date(2026, 11, 18, 10, 0, 0, 0, loc).UnixMilli()
	events := []Event{
		{ID: "old", SessionID: "s1", Ts: old, Model: "old-model", TotalTokens: 900},
		{ID: "new", SessionID: "s2", Ts: recent, Model: "new-model", TotalTokens: 100},
	}
	snap := buildSnapshot(events, "7d", now)
	if snap.Range != "7d" {
		t.Fatalf("range 归一：%s", snap.Range)
	}
	if len(snap.DailyModelUsage) != 7 {
		t.Fatalf("7d 应有 7 个日桶：%d", len(snap.DailyModelUsage))
	}
	if len(snap.Models) != 1 || snap.Models[0].Model != "new-model" {
		t.Fatalf("环形图只应含窗口内模型：%+v", snap.Models)
	}
	if snap.Models[0].Share != 1 {
		t.Fatalf("窗口内占比：%f", snap.Models[0].Share)
	}
	if snap.Summary.TotalTokens != 1000 {
		t.Fatalf("汇总应含全历史：%d", snap.Summary.TotalTokens)
	}
	// 30d 同样只含窗口内模型（10-01 仍在 30 天外）
	snap = buildSnapshot(events, "30d", now)
	if len(snap.DailyModelUsage) != 30 {
		t.Fatalf("30d 应有 30 个日桶：%d", len(snap.DailyModelUsage))
	}
	if len(snap.Models) != 1 {
		t.Fatalf("30d 模型数：%+v", snap.Models)
	}
	// 未知 range 按 30d 兜底
	snap = buildSnapshot(events, "bogus", now)
	if snap.Range != "30d" || len(snap.DailyModelUsage) != 30 {
		t.Fatalf("未知 range 兜底：%s/%d", snap.Range, len(snap.DailyModelUsage))
	}
}

func TestBuildHeatmapCap(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, loc)
	old := time.Date(2024, 1, 1, 10, 0, 0, 0, loc)
	events := []Event{{ID: "x", SessionID: "s", Ts: old.UnixMilli(), Model: "m", TotalTokens: 5}}
	snap := buildSnapshot(events, "7d", now)
	if len(snap.Heatmap.Days) > heatmapMaxDays {
		t.Fatalf("热力图没有按 371 天截断：%d", len(snap.Heatmap.Days))
	}
	if snap.Heatmap.EndDate != "2026-11-19" {
		t.Fatalf("heatmap 结束日：%s", snap.Heatmap.EndDate)
	}
	if snap.Summary.FirstDay != "2024-01-01" {
		t.Fatalf("汇总仍应记录真实首日：%s", snap.Summary.FirstDay)
	}
	// 空数据
	empty := buildSnapshot(nil, "7d", now)
	if empty.Summary.TotalTokens != 0 || len(empty.Heatmap.Days) != 0 || len(empty.DailyModelUsage) != 7 {
		t.Fatalf("空数据快照：%+v", empty)
	}
}

// ===== 日志增量同步 =====
func TestSyncSessionLogIncremental(t *testing.T) {
	root := t.TempDir()
	dataRoot = func() string { return root }
	t.Cleanup(func() {
		Close()
		dataRoot = appdata.Root
	})

	dir := filepath.Join(root, "ai-sessions", "abcd1234", "sess-1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "session.v1.jsonl")
	line := func(ts int64, tokens int64) string {
		return `{"v":1,"t":"msg","mid":"m-` + time.UnixMilli(ts).Format("150405") + `","m":{"role":"assistant","ts":` + strconv.FormatInt(ts, 10) + `,"model":"m1","usage":{"promptTokens":` + strconv.FormatInt(tokens, 10) + `,"completionTokens":0,"totalTokens":` + strconv.FormatInt(tokens, 10) + `}}}` + "\n"
	}
	if err := os.WriteFile(logPath, []byte(`{"v":1,"t":"header","id":"sess-1"}`+"\n"+line(1700000000000, 10)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, err := loadEvents()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].TotalTokens != 10 {
		t.Fatalf("首次导入：%+v", events)
	}

	// 追加一条 + 一个未写完的尾行：只导入完整行
	appendText := line(1700000001000, 20) + `{"v":1,"t":"msg","m":{"role":"assistant","ts":1700000002000,"usage":{"totalTokens":3`
	if err := appendFile(logPath, appendText); err != nil {
		t.Fatal(err)
	}
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, _ = loadEvents()
	if len(events) != 2 {
		t.Fatalf("增量导入应只收完整行：%d %+v", len(events), events)
	}

	// 文件没变：再扫一次不新增
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, _ = loadEvents()
	if len(events) != 2 {
		t.Fatalf("无变化重复扫描不应新增：%d", len(events))
	}

	// 补完尾行：下一轮接上
	if err := appendFile(logPath, "}}}\n"); err != nil {
		t.Fatal(err)
	}
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, _ = loadEvents()
	if len(events) != 3 {
		t.Fatalf("补完尾行应导入第 3 条：%d", len(events))
	}

	// 文件被截断重写：从头重读，幂等键去重后总数不翻倍
	if err := os.WriteFile(logPath, []byte(line(1700000000000, 10)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, _ = loadEvents()
	if len(events) != 3 {
		t.Fatalf("截断重写后总数应稳定：%d", len(events))
	}

	// 截断后又增长到超过旧 offset：只靠 size/mtime 会从新文件中间续读、漏掉前段；
	// 前缀指纹不匹配时必须从头读。
	rewritten := line(1700000000000, 10) + line(1700000004000, 40) + line(1700000005000, 50) + line(1700000006000, 60)
	if len(rewritten) <= len(line(1700000000000, 10)+line(1700000001000, 20)+line(1700000002000, 3)) {
		t.Fatal("测试前提：重写后的文件必须长于旧游标")
	}
	if err := os.WriteFile(logPath, []byte(rewritten), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, _ = loadEvents()
	if len(events) != 6 {
		t.Fatalf("截断后增长应从头上报，不能漏前段：%d %+v", len(events), events)
	}
}

func TestSyncGroupLog(t *testing.T) {
	root := t.TempDir()
	dataRoot = func() string { return root }
	t.Cleanup(func() {
		Close()
		dataRoot = appdata.Root
	})
	dir := filepath.Join(root, "ai-groups", "g1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	line1 := `{"kind":"msg","gid":"gm-1","role":"assistant","ts":1700000000000,"model":"m1","usage":{"totalTokens":10}}` + "\n"
	line2 := `{"kind":"msg","gid":"gm-2","role":"assistant","ts":1700000001000,"model":"m1","usage":{"totalTokens":20}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "session.v1.jsonl"), []byte(line1+line2), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := SyncAll(); err != nil {
		t.Fatal(err)
	}
	events, err := loadEvents()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("群聊导入条数：%d", len(events))
	}
	if events[0].SessionID != "group:g1" || events[0].TotalTokens != 10 {
		t.Fatalf("群聊事件：%+v", events[0])
	}
}

func appendFile(path, text string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(text)
	return err
}
