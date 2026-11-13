package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func activityTestEntry(ts int64, actor, action, target string) activityEntry {
	return activityEntry{V: 1, TS: ts, Actor: actor, Source: actor, Action: action, Target: target, Seq: ts}
}

func TestNormalizeActivityEntry(t *testing.T) {
	cases := []struct {
		name string
		in   activityEntry
		ok   bool
	}{
		{"合法记录", activityEntry{TS: 1, Actor: "user", Action: "file.save"}, true},
		{"时间戳缺失自动补", activityEntry{Actor: "ai", Action: "ai.tool"}, true},
		{"非法 actor", activityEntry{TS: 1, Actor: "robot", Action: "file.save"}, false},
		{"空 action", activityEntry{TS: 1, Actor: "user"}, false},
		{"action 带空格", activityEntry{TS: 1, Actor: "user", Action: "file save"}, false},
		{"action 大写拒绝", activityEntry{TS: 1, Actor: "user", Action: "File.save"}, false},
		{"action 过长", activityEntry{TS: 1, Actor: "user", Action: strings.Repeat("a", 65)}, false},
	}
	for _, tc := range cases {
		got, ok := normalizeActivityEntry(tc.in)
		if ok != tc.ok {
			t.Errorf("%s: ok = %v, want %v", tc.name, ok, tc.ok)
			continue
		}
		if !ok {
			continue
		}
		if got.V != 1 {
			t.Errorf("%s: v = %d, want 1", tc.name, got.V)
		}
		if got.TS <= 0 {
			t.Errorf("%s: ts 未补全", tc.name)
		}
	}
}

func TestNormalizeActivityEntryDetailMustBeObject(t *testing.T) {
	entry, ok := normalizeActivityEntry(activityEntry{TS: 1, Actor: "user", Action: "file.save", Detail: json.RawMessage(`[1,2]`)})
	if !ok {
		t.Fatal("记录本身应合法")
	}
	if entry.Detail != nil {
		t.Errorf("非对象 detail 应被丢弃，得到 %s", entry.Detail)
	}
	entry, ok = normalizeActivityEntry(activityEntry{TS: 1, Actor: "user", Action: "file.save", Detail: json.RawMessage("not-json")})
	if !ok || entry.Detail != nil {
		t.Errorf("非法 JSON detail 应被丢弃，ok=%v detail=%s", ok, entry.Detail)
	}
}

func TestNormalizeActivityEntrySizeCap(t *testing.T) {
	big := strings.Repeat("字", 20 << 10) // 20KB 中文，UTF-8 下远超 8KB
	entry, ok := normalizeActivityEntry(activityEntry{
		TS: 1, Actor: "user", Action: "file.save",
		Target: "a.json", Detail: json.RawMessage(fmt.Sprintf(`{"text":%q}`, big)),
	})
	if !ok {
		t.Fatal("记录应合法")
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > activityMaxEntrySize {
		t.Errorf("截断后仍超限：%d > %d", len(raw), activityMaxEntrySize)
	}
	var detail struct {
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(entry.Detail, &detail); err != nil {
		t.Fatalf("detail 不是合法 JSON：%v", err)
	}
	if !detail.Truncated {
		t.Error("detail 应带 truncated 标记")
	}
}

func TestActivityAppendReadRoundtrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	payload := activityAppendPayload{
		Entries: []activityEntry{
			activityTestEntry(1000, "user", "file.open", "a.json"),
			activityTestEntry(2000, "user", "file.save", "a.json"),
			{TS: 3000, Actor: "ai", Source: "ai", Action: "ai.tool", Target: "write_file", Detail: json.RawMessage(`{"status":"done"}`)},
		},
		RetentionMonths: 12,
	}
	raw, _ := json.Marshal(payload)
	if err := app.ActivityAppend(string(raw)); err != nil {
		t.Fatal(err)
	}
	out, err := app.ActivityRead(`{"limit":10}`)
	if err != nil {
		t.Fatal(err)
	}
	var result activityReadResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 3 {
		t.Fatalf("读到 %d 条，want 3", len(result.Entries))
	}
	// 从新到旧：最新在前
	if result.Entries[0].Action != "ai.tool" || result.Entries[2].Action != "file.open" {
		t.Errorf("顺序错误：%s / %s", result.Entries[0].Action, result.Entries[2].Action)
	}
	if result.Truncated {
		t.Error("未达 limit 不应标记 truncated")
	}
	if len(result.Files) != 1 || !strings.HasSuffix(result.Files[0], ".jsonl") {
		t.Errorf("files 不对：%v", result.Files)
	}
	// 落盘内容每行可解析、字段齐全
	dir := activityDir()
	segs, err := listActivitySegments(dir)
	if err != nil || len(segs) != 1 {
		t.Fatalf("分段数 = %d err = %v", len(segs), err)
	}
	data, err := os.ReadFile(filepath.Join(dir, segs[0].name))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("行不可解析：%v\n%s", err, line)
		}
		for _, key := range []string{"v", "ts", "actor", "action"} {
			if _, ok := entry[key]; !ok {
				t.Errorf("缺字段 %s：%s", key, line)
			}
		}
	}
}

func TestActivityAppendRejectsAllInvalid(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	raw, _ := json.Marshal(activityAppendPayload{Entries: []activityEntry{{TS: 1, Actor: "x", Action: "bad action"}}})
	if err := app.ActivityAppend(string(raw)); err == nil {
		t.Error("全部无效应报错")
	}
	raw, _ = json.Marshal(activityAppendPayload{Entries: []activityEntry{}})
	if err := app.ActivityAppend(string(raw)); err != nil {
		t.Errorf("空批不应报错：%v", err)
	}
	if err := app.ActivityAppend("{not-json"); err == nil {
		t.Error("非法 JSON 应报错")
	}
}

func TestActivityReadFilters(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	raw, _ := json.Marshal(activityAppendPayload{Entries: []activityEntry{
		activityTestEntry(1000, "user", "file.open", "a.json"),
		activityTestEntry(2000, "ai", "ai.tool", "write_file"),
		activityTestEntry(3000, "user", "file.save", "a.json"),
		activityTestEntry(4000, "system", "app.start", ""),
	}})
	if err := app.ActivityAppend(string(raw)); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		query string
		want  int
		first string
	}{
		{"actor 过滤", `{"limit":10,"actor":"ai"}`, 1, "ai.tool"},
		{"actions 过滤", `{"limit":10,"actions":["file.open","file.save"]}`, 2, "file.save"},
		{"domain 前缀过滤", `{"limit":10,"actions":["file"]}`, 2, "file.save"},
		{"beforeTs 过滤", `{"limit":10,"beforeTs":2000}`, 1, "file.open"},
		{"关键字命中 target", `{"limit":10,"keyword":"write_file"}`, 1, "ai.tool"},
		{"limit 生效", `{"limit":2}`, 2, "app.start"},
	}
	for _, tc := range cases {
		out, err := app.ActivityRead(tc.query)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		var result activityReadResult
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Entries) != tc.want {
			t.Errorf("%s: 得到 %d 条，want %d", tc.name, len(result.Entries), tc.want)
			continue
		}
		if tc.want > 0 && result.Entries[0].Action != tc.first {
			t.Errorf("%s: 首条 = %s，want %s", tc.name, result.Entries[0].Action, tc.first)
		}
	}
}

func TestActivitySegmentRolling(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	oldMax := activitySegmentMax
	activitySegmentMax = 512
	t.Cleanup(func() { activitySegmentMax = oldMax })

	app := &App{}
	for i := 0; i < 20; i++ {
		raw, _ := json.Marshal(activityAppendPayload{Entries: []activityEntry{
			activityTestEntry(int64(1000+i), "user", "file.save", strings.Repeat("x", 80)),
		}})
		if err := app.ActivityAppend(string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	segs, err := listActivitySegments(activityDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) < 2 {
		t.Fatalf("应滚动出多个分段，得到 %d 个", len(segs))
	}
	suffixes := map[int]bool{}
	for _, seg := range segs {
		suffixes[seg.suffix] = true
		if seg.suffix > 0 && !strings.HasSuffix(seg.name, fmt.Sprintf("-%d.jsonl", seg.suffix)) {
			t.Errorf("分段名不合法：%s", seg.name)
		}
	}
	if !suffixes[0] || !suffixes[1] {
		t.Errorf("应包含本体与 -1 之后…（suffix 0 与 1 缺失）：%v", suffixes)
	}
	out, err := app.ActivityRead(`{"limit":100}`)
	if err != nil {
		t.Fatal(err)
	}
	var result activityReadResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 20 {
		t.Errorf("跨分段应能读全 20 条，得到 %d", len(result.Entries))
	}
}

func TestActivityRetentionPrune(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := activityDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	// 写两个月前的文件与当月文件
	old := now.AddDate(0, -2, 0).Format("2006-01")
	newer := now.Format("2006-01")
	for _, name := range []string{old + ".jsonl", newer + ".jsonl", "not-a-log.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 强制解除节流
	activityPruneAt = time.Time{}
	pruneActivityFiles(dir, 1)
	if _, err := os.Stat(filepath.Join(dir, old+".jsonl")); !os.IsNotExist(err) {
		t.Error("两个月前的文件应被清理")
	}
	if _, err := os.Stat(filepath.Join(dir, newer+".jsonl")); err != nil {
		t.Error("当月文件应保留")
	}
	if _, err := os.Stat(filepath.Join(dir, "not-a-log.txt")); err != nil {
		t.Error("非日志文件不动")
	}
	// 节流：立刻再跑不重复（不会误删刚写的文件即可）
	pruneActivityFiles(dir, 1)
	if _, err := os.Stat(filepath.Join(dir, newer+".jsonl")); err != nil {
		t.Error("节流后误删文件")
	}
	// 非法参数跳过
	activityPruneAt = time.Time{}
	pruneActivityFiles(dir, 0)
	if _, err := os.Stat(filepath.Join(dir, newer+".jsonl")); err != nil {
		t.Error("months=0 不应触发清理")
	}
}

func TestActivityClear(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	raw, _ := json.Marshal(activityAppendPayload{Entries: []activityEntry{
		activityTestEntry(1, "user", "file.open", "a.json"),
		activityTestEntry(2, "user", "file.save", "a.json"),
	}})
	if err := app.ActivityAppend(string(raw)); err != nil {
		t.Fatal(err)
	}
	if err := app.ActivityClear(); err != nil {
		t.Fatal(err)
	}
	out, err := app.ActivityRead(`{"limit":10}`)
	if err != nil {
		t.Fatal(err)
	}
	var result activityReadResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 1 || result.Entries[0].Action != "activity.clear" {
		t.Fatalf("清空后应只剩 activity.clear，得到 %v", result.Entries)
	}
	if result.Entries[0].Actor != "user" {
		t.Errorf("clear 记录 actor = %s", result.Entries[0].Actor)
	}
	if result.Entries[0].TS <= 0 {
		t.Error("clear 记录应有时间戳")
	}
}

func TestActivityClearEmptyDir(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	if err := app.ActivityClear(); err != nil {
		t.Fatalf("空目录清空不应报错：%v", err)
	}
}

func TestActivityConcurrentAppendNoTear(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	const workers = 6
	const perWorker = 10
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			entries := make([]activityEntry, 0, perWorker)
			for i := 0; i < perWorker; i++ {
				entries = append(entries, activityTestEntry(int64(w*1000+i), "user", "file.save", fmt.Sprintf("w%d-i%d", w, i)))
			}
			raw, _ := json.Marshal(activityAppendPayload{Entries: entries})
			if err := app.ActivityAppend(string(raw)); err != nil {
				errs <- err
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("并发追加失败：%v", err)
	}
	out, err := app.ActivityRead(`{"limit":100}`)
	if err != nil {
		t.Fatal(err)
	}
	var result activityReadResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != workers*perWorker {
		t.Fatalf("并发丢失：得到 %d 条，want %d", len(result.Entries), workers*perWorker)
	}
}

func TestActivityPath(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &App{}
	path, err := app.ActivityPath()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != activityDirName {
		t.Errorf("路径尾段 = %s，want %s", filepath.Base(path), activityDirName)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Error("目录应已创建")
	}
}
