// service_test.go：§8 表驱动——CAS 三态 / op 语义 / 路径非法拒绝 / 预算拒绝 /
// edit 簿记闭环（改文件 → update 条目 → status 不再报 Stale）/ status 零写入 /
// 租约互斥与清理门闩 / 锁文件位置 / read 截断。
package cognition

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestService() *Service {
	return New(Deps{Now: func() time.Time { return time.Unix(1700000000, 0) }})
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func readResult(t *testing.T, s *Service, ws, req string) ReadResult {
	t.Helper()
	raw, err := s.Read(ws, mustParseRead(t, req))
	if err != nil {
		t.Fatalf("Read 失败：%v", err)
	}
	return raw
}

func mustParseRead(t *testing.T, req string) ReadReq {
	t.Helper()
	var r ReadReq
	if err := json.Unmarshal([]byte(req), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func editReq(op string, entries []EntryIn, meta, base string) EditReq {
	return EditReq{Op: op, Entries: entries, Meta: meta, Base: base}
}

var testMeta = "scene: code\n" + BudgetLine() + "\nlabels: hot\nbuild: 按目录分批\n"

func TestEditBootstrapAndCAS(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	p := resolvePaths(ws)

	// 未建立：read/status 都返回未建立指引，零写入
	if _, err := os.Stat(p.code); !os.IsNotExist(err) {
		t.Fatal("初始不应有卷文件")
	}
	ov := readResult(t, s, ws, "{}")
	if ov.Exists || ov.Hint == "" {
		t.Fatalf("未建立应返回 exists=false 与指引：%+v", ov)
	}

	// 首建：卷不存在时 base 为空可过（无内容可互覆）；条目文件先落盘，簿记才有得 stat
	mainGo := filepath.Join(ws, "main.go")
	if err := os.WriteFile(mainGo, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "main.go", F: "组合根"}}, testMeta, ""))
	if err != nil {
		t.Fatalf("首建失败：%v", err)
	}
	if !first.Applied || first.Entries != 1 || first.Fingerprint == "" {
		t.Fatalf("首建结果不符：%+v", first)
	}
	if _, err := os.Stat(p.meta); err != nil {
		t.Fatalf("meta 应随首批落盘：%v", err)
	}
	// 写后簿记在首批 edit 就创建 baseline（指纹 + 本批记录）——status 的全量生成只是恢复路径
	baseData, err := os.ReadFile(p.baseline)
	if err != nil {
		t.Fatalf("首建 edit 的簿记应落 baseline：%v", err)
	}
	var base Baseline
	if err := json.Unmarshal(baseData, &base); err != nil {
		t.Fatal(err)
	}
	if base.Fingerprint != first.Fingerprint || len(base.Files) != 1 {
		t.Fatalf("baseline 应登记指纹与本批记录：%+v", base)
	}

	// CAS 三态：缺失拒绝 / 过期拒绝 / 匹配通过
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, "", "")); err != ErrBaseMissing {
		t.Fatalf("卷存在且 base 为空应拒绝（ErrBaseMissing），得到 %v", err)
	}
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, "", "deadbeef")); err == nil ||
		!strings.Contains(err.Error(), "指纹不匹配") {
		t.Fatalf("过期 base 应报指纹冲突：%v", err)
	}
	second, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, "", first.Fingerprint))
	if err != nil {
		t.Fatalf("匹配的 base 应通过：%v", err)
	}
	if second.Fingerprint == first.Fingerprint {
		t.Fatal("写入后指纹应前移")
	}

	// op=add 撞已有路径显式报错；update/remove 目标不存在报错
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "MAIN.GO", F: "y"}}, "", second.Fingerprint)); err == nil ||
		!strings.Contains(err.Error(), "已有条目") {
		t.Fatalf("op=add 撞已有（归一后同键）应报错：%v", err)
	}
	if _, err := s.Edit(ws, editReq("update", []EntryIn{{Path: "nope.go", F: "y"}}, "", second.Fingerprint)); err == nil {
		t.Fatal("op=update 目标不存在应报错")
	}
	if _, err := s.Edit(ws, editReq("remove", []EntryIn{{Path: "nope.go"}}, "", second.Fingerprint)); err == nil {
		t.Fatal("op=remove 目标不存在应报错")
	}
}

func TestEditRejectsBadInput(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	first, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, testMeta, ""))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		req  EditReq
	}{
		{"cadt 前缀", editReq("add", []EntryIn{{Path: ".cadt/cognition/code.txt", F: "x"}}, "", first.Fingerprint)},
		{"上跳路径", editReq("add", []EntryIn{{Path: "../x.go", F: "x"}}, "", first.Fingerprint)},
		{"非法 op", editReq("upsert", []EntryIn{{Path: "b.go"}}, "", first.Fingerprint)},
		{"meta 预算镜像不符", editReq("add", []EntryIn{{Path: "b.go", F: "x"}}, "scene: code\nbudget: 9999 entries / 1 bytes\n", first.Fingerprint)},
		{"超大批次", editReq("add", makeBatch(51), "", first.Fingerprint)},
	}
	for _, tt := range cases {
		if _, err := s.Edit(ws, tt.req); err == nil {
			t.Errorf("%s：应拒绝", tt.name)
		}
	}
}

func makeBatch(n int) []EntryIn {
	out := make([]EntryIn, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, EntryIn{Path: "pkg/f" + string(rune('a'+i%26)) + string(rune('0'+i/26)) + ".go", F: "x"})
	}
	return out
}

func TestEntryBudgetReject(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	var fp string
	// 12 批 × 50 = 600 条（预算内）
	for batch := 0; batch < 12; batch++ {
		res, err := s.Edit(ws, editReq("add", makeBatchN(batch*50, 50), "", fp))
		if err != nil {
			t.Fatalf("第 %d 批失败：%v", batch, err)
		}
		fp = res.Fingerprint
	}
	// 再加 1 条：601 > 600 → 拒绝
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "overflow.go", F: "x"}}, "", fp)); err == nil ||
		!strings.Contains(err.Error(), "超预算") {
		t.Fatalf("601 条应触发预算拒绝：%v", err)
	}
}

func makeBatchN(start, n int) []EntryIn {
	out := make([]EntryIn, 0, n)
	for i := start; i < start+n; i++ {
		out = append(out, EntryIn{Path: "pkg/f" + string(rune('a'+i%26)) + string(rune('0'+(i/26)%26)) + string(rune('0'+i/26/26)) + ".go", F: "x"})
	}
	return out
}

func TestBookkeepingClosesLoop(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	write := func(rel, body string, modTime time.Time) {
		p := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, modTime, modTime); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Unix(1700000100, 0)
	write("svc.go", "v1", base)
	write("new.go", "new", base)

	first, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "svc.go", F: "服务"}}, testMeta, ""))
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if !st.HasBaseline || st.BaselineGenerated {
		t.Fatalf("baseline 已由 edit 簿记建立，status 不应重生成：%+v", st)
	}
	if st.Stale.Total != 0 || st.Unbaselined.Total != 0 {
		t.Fatalf("初建后应零 drift（new.go 无条目属合法 Missing）：%+v", st)
	}

	// AI 改了 svc.go，并 update 条目 → 簿记刷新记录 → status 不再报 Stale
	changed := base.Add(2 * time.Second)
	write("svc.go", "v2", changed)
	upd, err := s.Edit(ws, editReq("update", []EntryIn{{Path: "svc.go", F: "服务（v2）"}}, "", first.Fingerprint))
	if err != nil {
		t.Fatal(err)
	}
	if upd.Bookkept != 1 {
		t.Fatalf("簿记应刷新 1 条：%+v", upd)
	}
	st2, err := s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if st2.Stale.Total != 0 {
		t.Fatalf("update 后 Stale 应清零（簿记闭环）：%+v", st2.Stale)
	}

	// 新增条目（文件已在）→ 簿记登记 → 不报 Unbaselined
	_, err = s.Edit(ws, editReq("add", []EntryIn{{Path: "new.go", F: "新文件"}}, "", upd.Fingerprint))
	if err != nil {
		t.Fatal(err)
	}
	st3, err := s.Status(ws, true)
	if err != nil {
		t.Fatal(err)
	}
	if st3.Unbaselined.Total != 0 {
		t.Fatalf("add 后 Unbaselined 应清零：%+v", st3.Unbaselined)
	}
	if st3.Missing.Total != 0 {
		t.Fatalf("new.go 已有条目，Missing 应清零：%+v", st3.Missing)
	}

	// 用户改了 svc.go 但 AI 未维护 → Stale 如实报出（合法 drift 信号）
	write("svc.go", "v3", changed.Add(2*time.Second))
	st4, err := s.Status(ws, true)
	if err != nil {
		t.Fatal(err)
	}
	if st4.Stale.Total != 1 || len(st4.Stale.Samples) != 1 || st4.Stale.Samples[0] != "svc.go" {
		t.Fatalf("未维护的改动应报 Stale：%+v", st4.Stale)
	}
}

func TestStatusBaselineOnlyOnce(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	first, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, testMeta, ""))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Status(ws, false); err != nil {
		t.Fatal(err)
	}
	p := resolvePaths(ws)
	before, err := os.Stat(p.baseline)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond) // mtime 毫秒粒度：间隔足够才能证「没被重写」
	again, err := s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if again.BaselineGenerated {
		t.Fatal("baseline 已存在时 status 不得重生成（status 零写入，§5.1）")
	}
	after, err := os.Stat(p.baseline)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("baseline.json 被重写：status 除缺失兜底外必须零写入")
	}
	_ = first
}

func TestReadFilteredAndTruncate(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	// 造 30 条长条目（合计 > 7000 rune）
	entries := make([]EntryIn, 0, 31)
	for i := 0; i < 30; i++ {
		entries = append(entries, EntryIn{
			Path: "pkg/f" + string(rune('a'+i)) + ".go",
			F:    strings.Repeat("职责说明长文本", 40),
		})
	}
	// 一条目录条目（路径尾 /）：验证结构化命中透传 Dir 字段（应用页面 chips 过滤用）
	entries = append(entries, EntryIn{Path: "pkg/", F: "职责说明长文本目录"})
	first, err := s.Edit(ws, editReq("add", entries, testMeta, ""))
	if err != nil {
		t.Fatal(err)
	}
	ov := readResult(t, s, ws, "{}")
	if ov.Mode != "overview" || len(ov.Lines) != 31 || strings.Contains(ov.Text, "职责说明长文本") {
		t.Fatalf("overview 应为路径地图（无 FRAS 正文）：%+v", ov)
	}
	// overview 的目录行带 Dir 标记
	dirSeen := false
	for _, ln := range ov.Lines {
		if ln.Path == "pkg/" && ln.Dir {
			dirSeen = true
		}
	}
	if !dirSeen {
		t.Fatal("overview 目录行应带 Dir=true")
	}
	// 无过滤命中全部 → 截断 + 提示
	all := readResult(t, s, ws, `{"query":"职责"}`)
	if !all.Truncated || !strings.Contains(all.Text, "收窄") {
		t.Fatalf("超 7000 字符应截断并提示收窄：%v", all.Text[:min(120, len(all.Text))])
	}
	if utf8Len(all.Text) > ReadRuneLimit+200 {
		t.Fatalf("截断后仍超限：%d", utf8Len(all.Text))
	}
	// 结构化命中条目：HitCount 报过滤命中总数，HitEntries 同预算口径收窄（应用页面展示用）
	if all.HitCount != 31 || len(all.HitEntries) == 0 || len(all.HitEntries) >= 31 {
		t.Fatalf("HitCount 应为 31、HitEntries 应收窄：%d / %d", all.HitCount, len(all.HitEntries))
	}
	for _, he := range all.HitEntries {
		if he.F == "" || he.Path == "" {
			t.Fatalf("结构化条目应带 FRAS 全文：%+v", he)
		}
	}
	// 目录条目的结构化命中要带 Dir=true（前端 chips 过滤依赖，不必靠路径尾 / 猜）
	// 用目录独有的 F 文本查询（paths 是前缀过滤，pkg/ 会命中所有子条目）
	dirHit := readResult(t, s, ws, `{"query":"目录"}`)
	dirFound := false
	for _, he := range dirHit.HitEntries {
		if he.Path == "pkg/" {
			if !he.Dir {
				t.Fatalf("目录条目结构化命中应带 Dir=true：%+v", he)
			}
			dirFound = true
		}
	}
	if !dirFound {
		t.Fatalf("query=目录 应命中 pkg/ 条目：%+v", dirHit.HitEntries)
	}
	// 前缀过滤：只命中部分
	part := readResult(t, s, ws, `{"paths":["pkg/fa"]}`)
	if part.Truncated || part.Entries != 31 {
		t.Fatalf("过滤模式 Entries 应为卷总数（31）：%+v", part)
	}
	if !strings.Contains(part.Text, "fa.go") || strings.Contains(part.Text, "fb.go") {
		t.Fatal("前缀过滤应只含 fa.go")
	}
	if part.HitCount != 1 || len(part.HitEntries) != 1 || part.HitEntries[0].Path != "pkg/fa.go" {
		t.Fatalf("前缀过滤应命中 1 条且结构化一致：%d / %+v", part.HitCount, part.HitEntries)
	}
	_ = first
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func utf8Len(s string) int { return len([]rune(s)) }

func TestLeaseAndClearGate(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, testMeta, "")); err != nil {
		t.Fatal(err)
	}
	p := resolvePaths(ws)
	// 锁文件在 <ws>/.cadt/cognition.lock，不在卷目录内（§4.3）
	if p.lock != filepath.Join(ws, ".cadt", "cognition.lock") {
		t.Fatalf("锁文件位置不符：%s", p.lock)
	}
	if strings.Contains(p.lock, DirName+string(os.PathSeparator)) || strings.HasSuffix(p.lock, "cognition"+string(os.PathSeparator)+"cognition.lock") {
		t.Fatalf("锁不得落在卷目录内：%s", p.lock)
	}

	// 写持有时清理门闩拒绝（NoShare：同进程 refcount 也算忙）
	lease, err := s.acquireLease(context.Background(), p, "test-edit")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.LockForClear(ws); err == nil {
		t.Fatal("edit 持锁时 LockForClear 应报忙")
	}
	lease.Release()
	release, err := s.LockForClear(ws)
	if err != nil {
		t.Fatalf("锁释放后清理门闩应可获取：%v", err)
	}
	// 清理持有时 edit 被拒（不删一半）
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "b.go", F: "x"}}, "", readFP(t, s, ws))); err == nil {
		t.Fatal("清理持锁时 edit 应报忙")
	}
	release()
}

func readFP(t *testing.T, s *Service, ws string) string {
	t.Helper()
	res := readResult(t, s, ws, "{}")
	return res.Fingerprint
}

// 回归（2026-11-22 审查 P0）：同批升序多条 remove——旧实现按陈旧索引删除，会删错条目且报成功
func TestEditRemoveMultipleAscending(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	var fp string
	for _, p := range []string{"a.go", "b.go", "c.go"} {
		res, err := s.Edit(ws, editReq("add", []EntryIn{{Path: p, F: "F-" + p}}, testMeta, fp))
		if err != nil {
			t.Fatal(err)
		}
		fp = res.Fingerprint
	}
	res, err := s.Edit(ws, editReq("remove", []EntryIn{{Path: "a.go"}, {Path: "b.go"}}, "", fp))
	if err != nil {
		t.Fatalf("同批多 remove 应成功：%v", err)
	}
	if res.Entries != 1 {
		t.Fatalf("应剩 1 条：%+v", res)
	}
	ov := readResult(t, s, ws, "{}")
	if !strings.Contains(ov.Text, "c.go") || strings.Contains(ov.Text, "a.go") || strings.Contains(ov.Text, "b.go") {
		t.Fatalf("应只剩 c.go：%s", ov.Text)
	}
	// 删到最后一条再删空：空卷仍可读可编辑
	last, err := s.Edit(ws, editReq("remove", []EntryIn{{Path: "c.go"}}, "", res.Fingerprint))
	if err != nil || last.Entries != 0 {
		t.Fatalf("remove 最后一条应成功：%v %+v", err, last)
	}
}

// 回归（审查 P2）：用户手写坏行在 edit 全卷重排时被丢弃——必须进 warnings 上报
func TestEditWarnsDroppedBadLines(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "a.go", F: "x"}}, testMeta, "")); err != nil {
		t.Fatal(err)
	}
	// 手写一行坏行进 code.txt（on-disk 指纹随之改变——下一次 edit 必须以盘上指纹为 base）
	codePath := filepath.Join(ws, ".cadt", "cognition", "code.txt")
	data, err := os.ReadFile(codePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codePath, append(data, []byte("bad line no tab\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "b.go", F: "y"}}, "", readFP(t, s, ws)))
	if err != nil {
		t.Fatalf("以手写后盘上指纹为 base 的 edit 应通过：%v", err)
	}
	if len(res.Warnings) == 0 || !strings.Contains(strings.Join(res.Warnings, ";"), "坏行") {
		t.Fatalf("edit 应上报被丢弃的坏行：%+v", res.Warnings)
	}
	ov := readResult(t, s, ws, "{}")
	if strings.Contains(ov.Text, "bad line") {
		t.Fatal("坏行重排后不应留在卷里")
	}
}

// 回归（审查 P1）：overview 与过滤读同一 rune 封顶——大卷无参 read 不封顶会被 artifact 指针化
func TestReadOverviewCap(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	entries := make([]EntryIn, 0, 600)
	for i := 0; i < 600; i++ {
		entries = append(entries, EntryIn{
			Path: "pkg/very/long/path/segment/file" + fmt.Sprintf("%04d", i) + ".go",
			F:    strings.Repeat("职责", 20),
		})
	}
	var fp string
	for batch := 0; batch < 12; batch++ {
		res, err := s.Edit(ws, editReq("add", entries[batch*50:(batch+1)*50], "", fp))
		if err != nil {
			t.Fatalf("第 %d 批失败：%v", batch, err)
		}
		fp = res.Fingerprint
	}
	ov := readResult(t, s, ws, "{}")
	if !ov.Truncated || !strings.Contains(ov.Text, "已截断") {
		t.Fatalf("大卷 overview 应截断并提示收窄：%d 字符", len([]rune(ov.Text)))
	}
}

// 作用域排除文件（.cadt/cognition/ignore.txt）的现场提示三态（2026-11-22 用户反馈
// 「如何提示 AI 可以创建」）：低于阈值不催 / 达阈值且无文件时 hint 随 status 响应出现 /
// 文件存在（无论经 edit 通道还是用户手写）后排除生效且不再提示。
func TestStatusHintsCogignore(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	writeWS := func(rel string) {
		p := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeWS("main.go")
	if _, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "main.go", F: "组合根"}}, testMeta, "")); err != nil {
		t.Fatalf("建卷失败：%v", err)
	}

	// 低于阈值：不催（小工作区逐个建档就完了）
	for i := 0; i < cogIgnoreHintMissing-1; i++ {
		writeWS(fmt.Sprintf("gen/f%02d.js", i))
	}
	st, err := s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.Hint != "" {
		t.Fatalf("Missing 低于阈值不应提示：%q", st.Hint)
	}

	// 达到阈值且无排除文件：hint 随响应出现，指明 cognition_edit 的 ignore 参数通道
	writeWS("note.tmp")
	st, err = s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.Missing.Total < cogIgnoreHintMissing {
		t.Fatalf("Missing 应达阈值：%+v", st.Missing)
	}
	if st.Hint == "" || !strings.Contains(st.Hint, "ignore 参数") ||
		!strings.Contains(st.Hint, "cognition_edit") {
		t.Fatalf("达阈值应带 ignore 参数创建提示：%q", st.Hint)
	}

	// 写了排除文件（模拟 edit 通道落盘 / 用户手工编辑）：排除生效（Missing 归零）且不再提示
	if err := os.WriteFile(filepath.Join(ws, filepath.FromSlash(DirName), IgnoreName), []byte("gen/\n*.tmp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err = s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.Missing.Total != 0 {
		t.Fatalf("排除后 Missing 应归零：%+v", st.Missing)
	}
	if st.Hint != "" {
		t.Fatalf("已有排除文件不应再提示：%q", st.Hint)
	}
}

// ignore 参数（cognition_edit 整卷替换作用域排除文件）：落卷目录、CAS 生效、指纹前移且
// status 读回一致、校验失败整体拒绝（预算）。
func TestEditIgnoreParam(t *testing.T) {
	s := newTestService()
	ws := t.TempDir()
	p := resolvePaths(ws)
	if err := os.WriteFile(filepath.Join(ws, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := s.Edit(ws, editReq("add", []EntryIn{{Path: "main.go", F: "组合根"}}, testMeta, ""))
	if err != nil {
		t.Fatalf("建卷失败：%v", err)
	}

	// 仅带 ignore 也能成批（entries 可空）；文件落卷目录；指纹前移
	res, err := s.Edit(ws, EditReq{Op: "add", Ignore: "dist/\n*.min.js\n", Base: first.Fingerprint})
	if err != nil {
		t.Fatalf("ignore-only edit 失败：%v", err)
	}
	if !res.Applied || res.Fingerprint == first.Fingerprint {
		t.Fatalf("ignore 写入应前移指纹：%+v", res)
	}
	data, err := os.ReadFile(p.ignore)
	if err != nil || string(data) != "dist/\n*.min.js\n" {
		t.Fatalf("ignore.txt 应落卷目录：%v %q", err, data)
	}
	st, err := s.Status(ws, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.Fingerprint != res.Fingerprint {
		t.Fatalf("status 指纹应与 edit 后一致（含 ignore 段）：%s vs %s", st.Fingerprint, res.Fingerprint)
	}

	// CAS：ignore 编辑同样要带当前 base
	if _, err := s.Edit(ws, EditReq{Op: "add", Ignore: "x/\n", Base: first.Fingerprint}); err == nil ||
		!strings.Contains(err.Error(), "指纹不匹配") {
		t.Fatalf("过期 base 应被拒：%v", err)
	}

	// 预算拒绝：超行数整体拒绝且不动盘
	long := strings.Repeat("a/\n", IgnoreLineBudget+1)
	if _, err := s.Edit(ws, EditReq{Op: "add", Ignore: long, Base: res.Fingerprint}); err == nil {
		t.Fatal("超预算 ignore 应被拒")
	}
	if _, err := os.Stat(p.ignore); err != nil {
		t.Fatalf("排除文件应仍在（拒绝不动盘）：%v", err)
	}

	// 「写错语法」在本方言里最坏是排除不到（字面匹配、Missing 照报），模型下轮可自行修正，
	// 无静默扩除风险；校验只做预算拒绝（上面已覆盖），拒绝不动盘。
}
