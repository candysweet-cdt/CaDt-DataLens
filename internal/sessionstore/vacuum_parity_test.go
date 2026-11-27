package sessionstore

// vacuum_parity_test.go：vacuum 状态机与前端 replaySessionLog 的双侧一致性测试。
// 夹具（frontend/test/ai/fixtures/vacuum-parity.json）的 expect 数值由
// replaySessionLog 实测生成后钉死，前端测试（ai-session-vacuum-parity.test.mjs）
// 断言同一份数值——任何一侧语义漂移都会在这两个测试之一变红（方案 §5.3 要点 3）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// parityFixturePath 相对包目录指向前端夹具；文件缺失直接红，防止两侧静默脱钩。
const parityFixturePath = "../../frontend/test/ai/fixtures/vacuum-parity.json"

// ===== 夹具与日志工具 =====
type parityExpect struct {
	Live             int      `json:"live"`
	Archived         int      `json:"archived"`
	Issues           int      `json:"issues"`
	DroppedTransient int      `json:"droppedTransient"`
	Torn             bool     `json:"torn"`
	Summary          string   `json:"summary"`
	ArchivedOrder    []string `json:"archivedOrder"`
}

type parityCase struct {
	Name   string       `json:"name"`
	Lines  []string     `json:"lines"`
	Expect parityExpect `json:"expect"`
}

type parityFixture struct {
	Comment string       `json:"comment"`
	Cases   []parityCase `json:"cases"`
}

func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	raw, err := os.ReadFile(parityFixturePath)
	if err != nil {
		t.Fatalf("读取双侧一致性夹具失败（两侧测试共用同一份）：%v", err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析夹具失败：%v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("夹具没有任何用例")
	}
	return fixture
}

// writeParityLog 把夹具行写成正文文件；torn 用例按「无换行结尾」拼接（未提交尾行）。
func writeParityLog(t *testing.T, dir string, testCase parityCase) string {
	t.Helper()
	body := strings.Join(testCase.Lines, "\n")
	if !testCase.Expect.Torn {
		body += "\n"
	}
	path := filepath.Join(dir, aiSessionLogName)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// ===== 计划回放测试 =====
// TestVacuumPlanParityToReplay 断言 Go 重放（buildVacuumPlan）与夹具 expect 一致。
func TestVacuumPlanParityToReplay(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			dir := t.TempDir()
			path := writeParityLog(t, dir, testCase)
			plan, err := buildVacuumPlan(path)
			if err != nil {
				t.Fatal(err)
			}
			expect := testCase.Expect
			if len(plan.live) != expect.Live {
				t.Fatalf("live = %d，want %d", len(plan.live), expect.Live)
			}
			if len(plan.archived) != expect.Archived {
				t.Fatalf("archived = %d，want %d", len(plan.archived), expect.Archived)
			}
			if plan.issues != expect.Issues {
				t.Fatalf("issues = %d，want %d", plan.issues, expect.Issues)
			}
			if plan.dropped != expect.DroppedTransient {
				t.Fatalf("droppedTransient = %d，want %d", plan.dropped, expect.DroppedTransient)
			}
			if plan.torn != expect.Torn {
				t.Fatalf("torn = %v，want %v", plan.torn, expect.Torn)
			}
			gotSummary := ""
			if plan.summaryJSON != nil {
				var summary struct {
					Text string `json:"text"`
				}
				_ = json.Unmarshal(plan.summaryJSON, &summary)
				gotSummary = summary.Text
			}
			if gotSummary != expect.Summary {
				t.Fatalf("summary = %q，want %q", gotSummary, expect.Summary)
			}
			if len(expect.ArchivedOrder) > 0 {
				got := make([]string, 0, len(plan.archived))
				for _, entry := range plan.archived {
					got = append(got, entry.mid)
				}
				if strings.Join(got, ",") != strings.Join(expect.ArchivedOrder, ",") {
					t.Fatalf("归档序 = %v，want %v（重放序 = 时间序，槽位对位正确性）", got, expect.ArchivedOrder)
				}
			}
		})
	}
}

// ===== 重写形态与 torn tail 测试 =====
// TestVacuumRewriteShape 跑完整 Vacuum 并验证产物形状：主文件 = header + meta +
// summary patch + live（重放归档为 0），sidecar = 归档事件（顺序与重放一致）。
func TestVacuumRewriteShape(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			store := &Store{Root: t.TempDir()}
			if err := store.EnsureRoot(); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(store.Root, testCase.Name), 0o755); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(store.Root, testCase.Name)
			writeParityLog(t, dir, testCase)

			result, err := store.Vacuum(testCase.Name, true)
			if testCase.Name == "bad-lines-and-unknown-events" {
				// 该夹具带 v:2 事件（故意钉住 issue 口径）：引信应拒绝整理。
				if err == nil || !strings.Contains(err.Error(), "拒绝整理") {
					t.Fatalf("含未来 schema 事件的夹具应被引信拒绝：%v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !result.Changed {
				t.Fatalf("force vacuum 应重写主文件（changed=false）：%+v", result)
			}
			if result.MovedArchived != testCase.Expect.Archived {
				t.Fatalf("movedArchived = %d，want %d", result.MovedArchived, testCase.Expect.Archived)
			}
			if result.LiveKept != testCase.Expect.Live {
				t.Fatalf("liveKept = %d，want %d", result.LiveKept, testCase.Expect.Live)
			}
			if result.AfterBytes >= result.BeforeBytes && testCase.Expect.Archived+testCase.Expect.Live > 0 {
				t.Fatalf("整理后主文件应变小：before=%d after=%d", result.BeforeBytes, result.AfterBytes)
			}

			// 主文件重放：live 保持、归档清零（都在 sidecar）。
			plan, err := buildVacuumPlan(filepath.Join(dir, aiSessionLogName))
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.live) != testCase.Expect.Live || len(plan.archived) != 0 {
				t.Fatalf("重写后主文件 live=%d archived=%d，want live=%d archived=0",
					len(plan.live), len(plan.archived), testCase.Expect.Live)
			}
			if plan.issues != 0 {
				t.Fatalf("重写后主文件不应有坏行：%d", plan.issues)
			}

			// summary 以 meta patch 回发：有摘要的用例重放后应还原同一份。
			gotSummary := ""
			if plan.summaryJSON != nil {
				var summary struct {
					Text string `json:"text"`
				}
				_ = json.Unmarshal(plan.summaryJSON, &summary)
				gotSummary = summary.Text
			}
			if gotSummary != testCase.Expect.Summary {
				t.Fatalf("重写后 summary = %q，want %q", gotSummary, testCase.Expect.Summary)
			}

			// sidecar：条数与归档序（mid 抽取自事件行的 mid 字段）。
			page, err := store.ReadArchive(testCase.Name, 0, 1000)
			if err != nil {
				t.Fatal(err)
			}
			if page.Total != testCase.Expect.Archived {
				t.Fatalf("sidecar 条数 = %d，want %d", page.Total, testCase.Expect.Archived)
			}
			if len(testCase.Expect.ArchivedOrder) > 0 {
				got := make([]string, 0, len(page.Events))
				for _, line := range page.Events {
					var event struct {
						Mid string `json:"mid"`
					}
					if json.Unmarshal([]byte(line), &event) != nil {
						t.Fatalf("sidecar 事件行非法：%s", line)
					}
					got = append(got, event.Mid)
				}
				if strings.Join(got, ",") != strings.Join(testCase.Expect.ArchivedOrder, ",") {
					t.Fatalf("sidecar 归档序 = %v，want %v", got, testCase.Expect.ArchivedOrder)
				}
				// sidecar 事件必须带 a:1（前端重放据此落 archived 桶）。
				for _, line := range page.Events {
					var event struct {
						A int `json:"a"`
					}
					_ = json.Unmarshal([]byte(line), &event)
					if event.A != 1 {
						t.Fatalf("sidecar 事件缺 a:1：%s", line)
					}
				}
			}
			if result.SidecarLines != testCase.Expect.Archived {
				t.Fatalf("sidecarLines = %d，want %d", result.SidecarLines, testCase.Expect.Archived)
			}

			// 幂等：第二次 vacuum（force=false，远小于上限）应 no-op。
			again, err := store.Vacuum(testCase.Name, false)
			if err != nil {
				t.Fatal(err)
			}
			if !again.Skipped || again.Changed {
				t.Fatalf("第二次 vacuum 应跳过：%+v", again)
			}
		})
	}
}

// TestVacuumTornTailRecovered 修复路径：torn 夹具先 vacuum（丢尾行），随后前端
// 追加的新事件（带换行）不丢——重写后的主文件是完整可追加的。
func TestVacuumTornTailRecovered(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-torn"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	// 3 条消息 + 1 条撕裂尾行（同 mid 但内容不同：模拟写盘断点）。
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-torn","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"assistant","content":"a","ts":2}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"assistant","content":"半行`,
	}, "\n")
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Torn || result.LiveKept != 2 {
		t.Fatalf("torn 应被识别且丢尾行：%+v", result)
	}
	// 重写后的文件可以继续追加（O_APPEND 不再需要先修尾）。
	if err := store.Append(id, `{"v":1,"t":"msg","mid":"m3","m":{"role":"user","content":"q2","ts":3}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	plan, err := buildVacuumPlan(filepath.Join(store.Root, id, aiSessionLogName))
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.live) != 3 || plan.torn {
		t.Fatalf("追加后应完整重放 live=3 torn=false，got live=%d torn=%v", len(plan.live), plan.torn)
	}
}

// ===== 幂等与状态恢复测试 =====
// TestVacuumIdempotentUnderThreshold 自动整理语义：正文 ≤ 上限且 force=false 直接跳过；
// force=true 才动手。双窗口同时打开同一会话时的第二方为 no-op（方案 §5.3 要点 4）。
func TestVacuumIdempotentUnderThreshold(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-skip"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-skip","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	logPath := filepath.Join(store.Root, id, aiSessionLogName)
	if err := os.WriteFile(logPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := store.Vacuum(id, false)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Skipped || result.Changed {
		t.Fatalf("阈值内 force=false 应跳过：%+v", result)
	}
	if _, err := os.Stat(filepath.Join(store.Root, id, aiSessionArchiveName)); !os.IsNotExist(err) {
		t.Fatalf("跳过时不应创建 sidecar")
	}
}

// TestVacuumStateRecovery 模拟崩溃残留：清单存在 + sidecar 已追加 + 主文件未替换
// → 下次 Vacuum 进锁先截回 sidecar 再整理，不产生重复归档。
func TestVacuumStateRecovery(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-recover"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-recover","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	logPath := filepath.Join(store.Root, id, aiSessionLogName)
	if err := os.WriteFile(logPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	// 伪造崩溃残留：sidecar 已含一轮归档事件 + 清单记录「主文件未替换」（PreMainHash 命中）。
	sidecarPath := filepath.Join(store.Root, id, aiSessionArchiveName)
	if err := os.WriteFile(sidecarPath, []byte(`{"v":1,"t":"msg","mid":"m1","a":1,"m":{"role":"user","content":"q","ts":1}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	preHash, err := sha256HexFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	state, err := json.Marshal(vacuumState{
		V:           1,
		MainSize:    info.Size(),
		PreMainHash: preHash,
		SidecarSize: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionVacuumState), state, 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.SidecarLines != 1 || result.SidecarAppendedLines != 1 {
		t.Fatalf("恢复后应截回残留追加并重新整理一次：%+v", result)
	}
	page, err := store.ReadArchive(id, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 {
		t.Fatalf("sidecar 不应出现重复归档：%d 条", page.Total)
	}
	if _, err := os.Stat(filepath.Join(store.Root, id, aiSessionVacuumState)); !os.IsNotExist(err) {
		t.Fatalf("整理完成后清单应删除")
	}
}

// ===== 归档分页与 live 标志测试 =====
// TestVacuumReadArchivePaging 分页读回：offset/limit 按非空事件行计。
func TestVacuumReadArchivePaging(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-page"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for i := 0; i < 5; i++ {
		lines = append(lines,
			`{"v":1,"t":"msg","mid":"m`+string(rune('0'+i))+`","a":1,"m":{"role":"user","content":"c","ts":`+string(rune('0'+i))+`}}`)
	}
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionArchiveName), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	page, err := store.ReadArchive(id, 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 5 || page.Offset != 2 || len(page.Events) != 2 {
		t.Fatalf("分页 = %+v", page)
	}
	var first struct {
		Mid string `json:"mid"`
	}
	if json.Unmarshal([]byte(page.Events[0]), &first) != nil || first.Mid != "m2" {
		t.Fatalf("offset 应跳过前两行：%s", page.Events[0])
	}
	// 未整理过的会话：sidecar 不存在返回空页，不报错。
	empty, err := store.ReadArchive("session-none", 0, 10)
	if err != nil || empty.Total != 0 || len(empty.Events) != 0 {
		t.Fatalf("缺 sidecar 应返回空页：%+v err=%v", empty, err)
	}
}

// TestVacuumLiveDominantFlag live 主导的真空角落：整理后主文件仍超上限时置位。
// readLimitOverride 把阈值压到 1 KB，不必写 256MB 级夹具。
func TestVacuumLiveDominantFlag(t *testing.T) {
	store := &Store{Root: t.TempDir(), readLimitOverride: 1024}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-dominant"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	// 大体积 live 行 + 一条 archive 标记（keep=0 不移动任何消息）。
	big := strings.Repeat("x", 4096)
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-dominant","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"` + big + `","ts":1}}`,
		`{"v":1,"t":"archive","keep":0}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed {
		t.Fatalf("archive 标记存在应重写：%+v", result)
	}
	if !result.LiveDominant {
		t.Fatalf("整理后仍超上限应置 liveDominant：%+v", result)
	}
}

// ===== 错误与歧义窗口测试 =====
// TestSessionTooLargeErrorPrefix 稳定错误前缀契约：超限错误必须以 session-too-large: 开头，
// 前端据此分流「打开即自动整理」，不做字符串模糊匹配。
func TestSessionTooLargeErrorPrefix(t *testing.T) {
	store := &Store{Root: t.TempDir(), readLimitOverride: 1024}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-big"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-big","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"` + strings.Repeat("x", 4096) + `","ts":1}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := store.Read(id)
	if err == nil {
		t.Fatal("超限应拒绝读取")
	}
	if !strings.HasPrefix(err.Error(), "session-too-large:") {
		t.Fatalf("错误必须带稳定前缀：%v", err)
	}
	// 强制读取（临时加载）不受限。
	forced, err := store.ReadForce(id)
	if err != nil || len(forced) < 4096 {
		t.Fatalf("ReadForce 应返回全文：%d 字节 err=%v", len(forced), err)
	}
}

// TestVacuumRecoveryAmbiguousWindow 崩溃后主文件被追加过的模糊窗口（两个 hash 都不命中）：
// sidecar 尾巴完整（有换行）→ 保留不截（截错会丢「仅存于 sidecar」的归档）；
// 随后的追加靠 appendSidecarBatch 的幂等比对跳过，不产生重复行。
func TestVacuumRecoveryAmbiguousWindow(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-ambiguous"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-ambiguous","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	logPath := filepath.Join(store.Root, id, aiSessionLogName)
	if err := os.WriteFile(logPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	sidecarPath := filepath.Join(store.Root, id, aiSessionArchiveName)
	if err := os.WriteFile(sidecarPath, []byte(`{"v":1,"t":"msg","mid":"m1","a":1,"m":{"role":"user","content":"q","ts":1}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 伪造「崩溃后主文件又被追加了一条新消息」：两个 hash 都对不上。
	appended := body + `{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"q2","ts":2}}` + "\n"
	if err := os.WriteFile(logPath, []byte(appended), 0o644); err != nil {
		t.Fatal(err)
	}
	state, err := json.Marshal(vacuumState{
		V:           1,
		MainSize:    int64(len(body)),
		PreMainHash: "deadbeef-pre",
		SidecarSize: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionVacuumState), state, 0o644); err != nil {
		t.Fatal(err)
	}

	// 恢复保留 sidecar；本轮 vacuum 的批次与残留尾部逐字节一致 → 幂等跳过。
	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.SidecarAppendedLines != 0 {
		t.Fatalf("幂等比对应跳过同批追加：%+v", result)
	}
	page, err := store.ReadArchive(id, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || result.SidecarLines != 1 {
		t.Fatalf("sidecar 不应出现重复归档：result=%+v page=%+v", result, page)
	}
}

// TestVacuumRecoveryPartialTail 崩溃时 sidecar 写了半行（缺换行）且主文件已被追加过：
// appendSidecar 没写完 → Replace 必未发生 → 截回安全（归档原文仍在主文件）。
func TestVacuumRecoveryPartialTail(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-partial"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-partial","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	logPath := filepath.Join(store.Root, id, aiSessionLogName)
	if err := os.WriteFile(logPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	// 半行残留 + 主文件被追加过（模糊窗口）。
	sidecarPath := filepath.Join(store.Root, id, aiSessionArchiveName)
	if err := os.WriteFile(sidecarPath, []byte(`{"v":1,"t":"msg","mid":"m1"`), 0o644); err != nil {
		t.Fatal(err)
	}
	appended := body + `{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"q2","ts":2}}` + "\n"
	if err := os.WriteFile(logPath, []byte(appended), 0o644); err != nil {
		t.Fatal(err)
	}
	state, err := json.Marshal(vacuumState{
		V:           1,
		MainSize:    int64(len(body)),
		PreMainHash: "deadbeef-pre",
		SidecarSize: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionVacuumState), state, 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	page, err := store.ReadArchive(id, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	// 半行被截掉后重新整理：恰好 1 条完整归档事件，无半行混入。
	if page.Total != 1 || result.SidecarLines != 1 {
		t.Fatalf("半行应被截回并重新整理：result=%+v page=%+v", result, page)
	}
	var probe struct {
		Mid string `json:"mid"`
	}
	if json.Unmarshal([]byte(page.Events[0]), &probe) != nil || probe.Mid != "m1" {
		t.Fatalf("sidecar 事件非法：%s", page.Events[0])
	}
}

// ===== 阈值与 schema 测试 =====
// TestVacuumKeepHugeClamp keep 超界浮点的数值边界：JS 端 1e20 / 1e999（JSON 解析为
// Infinity）clamp 后都是「全部保留」，Go 必须一致（int(1e20) 是 implementation-dependent，
// 修前会得到负的「整数不定值」→ live 全部判死 → 物理丢消息）。
func TestVacuumKeepHugeClamp(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-huge-keep"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	// truncate keep=1e20 应保留全部 live；archive keep=1e20 应全部移入归档。
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-huge-keep","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"q2","ts":2}}`,
		`{"v":1,"t":"truncate","keep":1e20}`,
		`{"v":1,"t":"archive","keep":1e999,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := buildVacuumPlan(filepath.Join(store.Root, id, aiSessionLogName))
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.live) != 0 || len(plan.archived) != 2 {
		t.Fatalf("超界 keep 应按「全部」处理：live=%d archived=%d", len(plan.live), len(plan.archived))
	}
	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.MovedArchived != 2 || result.LiveKept != 0 {
		t.Fatalf("整理应移走全部 2 条：%+v", result)
	}
}

// TestVacuumRefusesFutureSchema 引信：正文含高于已知 schema 的事件时拒绝整理，
// 防止未来 schema 升级后 Go 侧未同步造成静默物理删除。
func TestVacuumRefusesFutureSchema(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-future"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-future","title":"t","createdAt":1,"workspace":""}`,
		`{"v":2,"t":"msg","mid":"f1","m":{"role":"user","content":"future","ts":1}}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":2}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := store.Vacuum(id, true)
	if err == nil || !strings.Contains(err.Error(), "拒绝整理") {
		t.Fatalf("含未来 schema 事件应拒绝整理：%v", err)
	}
}

// ===== 重置测试 =====
// TestVacuumResetClearsSidecar reset × sidecar：物化会把 reset 从主文件抹掉，
// 拼接重放（sidecar 在前）从此看不到这次清档——替换主文件时必须连带清空 sidecar。
func TestVacuumResetClearsSidecar(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	id := "session-reset-sidecar"
	if err := os.MkdirAll(filepath.Join(store.Root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	// 先 vacuum 一轮（sidecar 有一条），再给主文件追加 reset + 新消息（模拟外来日志）。
	round1 := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-reset-sidecar","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(round1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Vacuum(id, true); err != nil {
		t.Fatal(err)
	}
	page, err := store.ReadArchive(id, 0, 10)
	if err != nil || page.Total != 1 {
		t.Fatalf("第一轮应移入 1 条：page=%+v err=%v", page, err)
	}
	round2 := strings.Join([]string{
		`{"v":1,"t":"header","id":"session-reset-sidecar","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"q","ts":1}}`,
		`{"v":1,"t":"archive","keep":1,"summary":{"text":"S"}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"q2","ts":2}}`,
		`{"v":1,"t":"reset"}`,
		`{"v":1,"t":"msg","mid":"m3","m":{"role":"user","content":"q3","ts":3}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(store.Root, id, aiSessionLogName), []byte(round2), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := store.Vacuum(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed {
		t.Fatalf("reset 应触发物化：%+v", result)
	}
	if page, err := store.ReadArchive(id, 0, 10); err != nil || page.Total != 0 {
		t.Fatalf("reset 后 sidecar 必须清空（否则拼接重放让清档失效）：page=%+v err=%v", page, err)
	}
	// reset 后主文件只剩 header + meta + summary patch + live(m3)；summary 按重放语义被清空。
	plan, err := buildVacuumPlan(filepath.Join(store.Root, id, aiSessionLogName))
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.live) != 1 || len(plan.archived) != 0 || plan.summaryJSON != nil {
		t.Fatalf("reset 后主文件应 live=1 archived=0 summary=空，got live=%d archived=%d",
			len(plan.live), len(plan.archived))
	}
}
