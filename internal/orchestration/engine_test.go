package orchestration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testWorkspace(t *testing.T) string {
	t.Helper()
	ws := t.TempDir()
	if err := os.MkdirAll(filepath.Join(ws, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	return ws
}

func testEngine(t *testing.T, deps Deps) *Engine {
	t.Helper()
	if deps.Emit == nil {
		deps.Emit = func(string, any) {}
	}
	if deps.WorkspaceAvailable == nil {
		deps.WorkspaceAvailable = func(string) bool { return true }
	}
	engine := NewEngine(filepath.Join(t.TempDir(), "orchestrations"), deps)
	// 先于 t.TempDir 的清理注册（LIFO）：等异步巡检落盘完再删目录，避免 Windows 竞态。
	t.Cleanup(engine.waitTicks)
	return engine
}

func basePlan(ws string, id string) PlanRequest {
	return PlanRequest{
		Title: "测试编排", Goal: "把测试做完", Workspace: ws,
		ParentSessionID: "parent-1", ArbiterSessionID: "parent-1", ArbiterModelRef: "model/a",
		Policy: Policy{
			Scope: "edit", MaxParallel: 1, MaxAttemptsPerBatch: 2,
			BatchTimeoutMs: 5000, AuditIdleMs: 12000,
			ReviewExplicit: true, Review: false,
		},
		Batches: []BatchPlan{{
			ID: id, Title: "实现", Spec: "改 src", Owns: []string{"src/**"},
			DependsOn: []string{}, Verify: []VerifySpec{{File: "go", Args: []string{"version"}}},
		}},
	}
}

func waitFor(t *testing.T, engine *Engine, id string, pred func(*Orchestration) bool) *Orchestration {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		view, err := engine.Get(id, "")
		if err == nil && pred(view.Orchestration) {
			return view.Orchestration
		}
		time.Sleep(10 * time.Millisecond)
	}
	view, _ := engine.Get(id, "")
	if view != nil {
		t.Fatalf("等待条件超时；当前状态：%s / %s", view.Orchestration.Status, view.Batches[0].Status)
	}
	t.Fatal("等待条件超时：编排不存在")
	return nil
}

func claimAndStart(t *testing.T, engine *Engine, ws, id, batchID string, attempt int) StartResponse {
	t.Helper()
	claim := engine.ClaimBatch(id, batchID, attempt, "win-1", ws)
	if !claim.OK {
		t.Fatalf("ClaimBatch 失败：%s", claim.Reason)
	}
	res, err := engine.StartBatch(StartRequest{
		OrchestrationID: id, BatchID: batchID, ClaimToken: claim.ClaimToken,
		SessionID: "session-" + batchID + "-" + string(rune('0'+attempt)),
	}, "win-1", ws)
	if err != nil {
		t.Fatalf("StartBatch 失败：%v", err)
	}
	return res
}

func TestValidatePlanAndDryRun(t *testing.T) {
	ws := testWorkspace(t)
	req := basePlan(ws, "B2")
	req.Batches = []BatchPlan{
		{ID: "B1", Title: "基础", Spec: "s", Owns: []string{"src/a/**"}},
		{ID: "B2", Title: "依赖", Spec: "s", Owns: []string{"src/b/**"}, DependsOn: []string{"B1"}},
		{ID: "B3", Title: "并行", Spec: "s", Owns: []string{"docs/**"}},
	}
	req.Policy.MaxParallel = 2
	req.Policy.ReviewExplicit = false
	req.Policy.Review = false
	plan, errs := ValidatePlan(req)
	if len(errs) > 0 {
		t.Fatalf("计划应通过：%v", errs)
	}
	preview := PlanDryRun(plan)
	if !preview.Valid {
		t.Fatalf("dry-run 应有效：%v", preview.Errors)
	}
	if len(preview.Waves) != 2 {
		t.Fatalf("应有两个执行波次，实际 %v", preview.Waves)
	}
	first := strings.Join(preview.Waves[0], ",")
	if !strings.Contains(first, "B1") || !strings.Contains(first, "B3") {
		t.Fatalf("第一波应并发 B1/B3：%v", preview.Waves)
	}
	if strings.Contains(first, "B2") {
		t.Fatalf("B2 不应在依赖完成前派发：%v", preview.Waves)
	}
	if !preview.ReviewEnabled {
		t.Fatal("审查门应默认开")
	}

	req.Batches[0].DependsOn = []string{"B2"}
	if _, errs := ValidatePlan(req); len(errs) == 0 || !strings.Contains(strings.Join(errs, "；"), "成环") {
		t.Fatalf("应拒绝依赖成环：%v", errs)
	}

	req = basePlan(ws, "B1")
	req.Batches[0].Owns = []string{"../escape/**"}
	if _, errs := ValidatePlan(req); len(errs) == 0 {
		t.Fatal("应拒绝 owns 逃逸")
	}
	req = basePlan(ws, "B1")
	req.Batches[0].Verify = []VerifySpec{{File: "cmd", Args: []string{"/c", "echo hi"}}}
	if _, errs := ValidatePlan(req); len(errs) == 0 {
		t.Fatal("应拒绝 shell 包装器")
	}
}

func TestOwnsPathGate(t *testing.T) {
	ws := testWorkspace(t)
	rel, err := authorizePath(ws, []string{"src/**"}, filepath.Join(ws, "src", "a", "b.js"))
	if err != nil || rel != "src/a/b.js" {
		t.Fatalf("根内应放行：rel=%q err=%v", rel, err)
	}
	if _, err := authorizePath(ws, []string{"src/**"}, filepath.Join(ws, "other", "b.js")); err == nil {
		t.Fatal("owns 外应拒绝")
	}
	if _, err := authorizePath(ws, []string{"src/**"}, filepath.Join(ws, "..", "outside.js")); err == nil {
		t.Fatal("工作区外应拒绝")
	}
	if ownsIntersect([]string{"src/*.js"}, []string{"src/**"}) != true {
		t.Fatal("可能相交必须按相交处理")
	}
	if ownsIntersect([]string{"src/**"}, []string{"docs/**"}) != false {
		t.Fatal("不同前缀应判为不相交")
	}
}

func TestCreateDispatchReportVerifyDone(t *testing.T) {
	ws := testWorkspace(t)
	var verifyCalls atomic.Int32
	engine := testEngine(t, Deps{RunVerify: func(workspace string, spec VerifySpec) VerifyResult {
		verifyCalls.Add(1)
		return VerifyResult{File: spec.File, ExitCode: 0}
	}})
	plan := basePlan(ws, "B1")
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		return o.Batches[0].Status == BatchDispatched
	})
	start := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	write := engine.AuthorizeWrite(start.ExecutionToken, filepath.Join(ws, "src", "a.js"))
	if !write.Allowed {
		t.Fatalf("owns 内写入应放行：%s", write.Message)
	}
	report := `{"batchId":"B1","reportId":"r1","status":"done","notes":"完成","changedFiles":["src/a.js"]}`
	first, err := engine.Report(start.ExecutionToken, report)
	if err != nil || !first.Accepted {
		t.Fatalf("回报失败：%v / %+v", err, first)
	}
	second, err := engine.Report(start.ExecutionToken, report)
	if err != nil || !second.Duplicate {
		t.Fatalf("同一报告应幂等返回：err=%v res=%+v", err, second)
	}
	o = waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Status == StatusDone })
	if o.Batches[0].Status != BatchDone {
		t.Fatalf("批次应完成：%s", o.Batches[0].Status)
	}
	if verifyCalls.Load() == 0 {
		t.Fatal("编排器必须自己复跑 verify")
	}
	if len(o.Batches[0].WriteLog) == 0 {
		t.Fatal("放行写入应记 writeLog")
	}
}

func TestReviewBatchIsIndependentAndNoDeadlock(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.Review = true
	plan.Policy.ReviewExplicit = true
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	work := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if _, err := engine.Report(work.ExecutionToken, `{"batchId":"B1","reportId":"r1","status":"done","notes":"ok"}`); err != nil {
		t.Fatal(err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		for _, b := range o.Batches {
			if b.Kind == KindReview && b.Status == BatchDispatched {
				return true
			}
		}
		return false
	})
	var review *Batch
	for i := range o.Batches {
		if o.Batches[i].Kind == KindReview {
			review = &o.Batches[i]
		}
	}
	if review == nil || review.ReviewOf != "B1" {
		t.Fatalf("审查批次结构错误：%+v", review)
	}
	if len(review.DependsOn) != 0 {
		t.Fatal("review 批次 dependsOn 必须为空，避免死锁")
	}
	reviewStart := claimAndStart(t, engine, ws, res.ID, review.ID, 1)
	if _, err := engine.Report(reviewStart.ExecutionToken,
		`{"batchId":"`+review.ID+`","reportId":"r2","status":"done","notes":"通过","review":{"blocking":[],"shouldFix":[],"suggestions":[]}}`); err != nil {
		t.Fatal(err)
	}
	o = waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Status == StatusDone })
	if o.Batches[0].Status != BatchDone {
		t.Fatalf("审查通过后 work 应 done：%s", o.Batches[0].Status)
	}
}

func TestNoReportThenAttemptExhausted(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	start1 := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if err := engine.TurnEvent(TurnEventRequest{Token: start1.ExecutionToken, Kind: "turn_finished"}); err != nil {
		t.Fatal(err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		return o.Batches[0].Status == BatchDispatched && o.Batches[0].Attempts == 1
	})
	if o.Batches[0].FailureReason != "" && o.Batches[0].Status == BatchRunning {
		t.Fatalf("意外状态：%+v", o.Batches[0])
	}
	start2 := claimAndStart(t, engine, ws, res.ID, "B1", 2)
	if _, err := engine.Report(start1.ExecutionToken, `{"batchId":"B1","reportId":"old","status":"done"}`); err == nil {
		t.Fatal("旧尝试的报告必须被拒")
	}
	if err := engine.TurnEvent(TurnEventRequest{Token: start2.ExecutionToken, Kind: "turn_finished"}); err != nil {
		t.Fatal(err)
	}
	o = waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Status == StatusAwaitingArbitration })
	if o.Batches[0].Status != BatchFailed {
		t.Fatalf("attempts 用尽应 failed：%s", o.Batches[0].Status)
	}
	if engine.PendingArbitration(res.ID) == 0 {
		t.Fatal("应产生 L2 待仲裁事件")
	}
}

func TestStalledAndUserStopAreDifferent(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.BatchTimeoutMs = 80
	plan.Policy.AuditIdleMs = 500
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	claimAndStart(t, engine, ws, res.ID, "B1", 1)
	time.Sleep(120 * time.Millisecond)
	engine.tickAll()
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].FailureReason == ReasonStalled })

	// 用户停止不自动重试：直接进 L2。
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	start := claimAndStart(t, engine, ws, res.ID, "B1", 2)
	if err := engine.TurnEvent(TurnEventRequest{Token: start.ExecutionToken, Kind: "turn_failed", Reason: "user stopped"}); err != nil {
		t.Fatal(err)
	}
	o = waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchBlocked })
	if o.Batches[0].FailureReason != ReasonUserStopped {
		t.Fatalf("用户停止应保留分类：%+v", o.Batches[0])
	}
}

func TestPausedNoWindowFreezesDeadline(t *testing.T) {
	ws := testWorkspace(t)
	available := atomic.Bool{}
	available.Store(false)
	engine := testEngine(t, Deps{WorkspaceAvailable: func(string) bool { return available.Load() }})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Status == StatusPausedNoWindow })
	if o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchPending }); o.Status != StatusPausedNoWindow {
		t.Fatalf("无窗口时不应派发，当前 %s", o.Status)
	}
	available.Store(true)
	engine.tickAll()
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	if o.Status != StatusRunning {
		t.Fatalf("窗口回来后应恢复 running：%s", o.Status)
	}
}

func TestStopRejectsLaterReports(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	start := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if _, err := engine.UserControl(ControlRequest{OrchestrationID: res.ID, Action: "stop"}, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Report(start.ExecutionToken, `{"batchId":"B1","reportId":"late","status":"done"}`); err == nil {
		t.Fatal("停止后到达的报告必须被拒")
	}
}

func TestAutoRunRejectsAwaitingUser(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.AutoRun = true
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	start := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	payload := `{"batchId":"B1","reportId":"q","status":"awaiting_user","question":{"text":"选哪个？","options":[{"label":"A","recommended":true}]}}`
	if _, err := engine.Report(start.ExecutionToken, payload); err == nil || !strings.Contains(err.Error(), "自主") {
		t.Fatalf("自主模式应拒绝 awaiting_user：%v", err)
	}
}

func TestAuditorNeverChangesBusinessStatus(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.BatchTimeoutMs = 200
	plan.Policy.AuditIdleMs = 1000
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	path, _ := engine.store.path(res.ID, ".json")
	old := time.Now().Add(-3 * time.Hour)
	_ = os.Chtimes(path, old, old)
	engine.auditOnce()
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return len(o.Audit.Anomalies) > 0 })
	if o.Status == StatusFault || o.Batches[0].Status == BatchFailed {
		t.Fatal("审计者不得修改业务状态")
	}
}

func TestServiceWorkspaceIsolation(t *testing.T) {
	wsA := testWorkspace(t)
	wsB := testWorkspace(t)
	engine := testEngine(t, Deps{})
	old := Default
	oldDeps := callDeps
	Default = engine
	callDeps = CallDeps{WorkspaceForCall: func(ctx context.Context) string {
		if v, _ := ctx.Value(wsKey{}).(string); v != "" {
			return v
		}
		return wsA
	}, WindowForCall: func(context.Context) string { return "win" }}
	defer func() { Default = old; callDeps = oldDeps }()
	svc := &Service{}
	plan := basePlan(wsA, "B1")
	raw := mustJSON(t, plan)
	res, err := svc.OrchestrationCreate(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	view, err := svc.OrchestrationGet(context.WithValue(context.Background(), wsKey{}, wsB), res.ID)
	if err == nil || view != nil {
		t.Fatal("B 工作区不应看到 A 的编排")
	}
	// Create 会异步触发一次派发巡检；等它落盘完再让 TempDir 清理，避免 Windows 删目录竞态。
	engine.waitTicks()
}

type wsKey struct{}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := jsonMarshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// jsonMarshal 走标准库，测试里不重复实现序列化。
func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func TestReportRejectsForeignBatchID(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	start := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if _, err := engine.Report(start.ExecutionToken, `{"batchId":"B2","reportId":"r1","status":"done"}`); err == nil {
		t.Fatal("冒领他人 batchId 必须被拒")
	}
}

func TestUserTimeoutRecommendedContinues(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	start := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	payload := `{"batchId":"B1","reportId":"q1","status":"awaiting_user","question":{"text":"选哪个？","options":[{"label":"A","recommended":true}],"timeoutSec":60,"timeoutAction":"recommended"}}`
	if _, err := engine.Report(start.ExecutionToken, payload); err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchAwaitingUser })
	engine.mu.Lock()
	o := engine.items[res.ID]
	o.Batches[0].AwaitingUntil = nowMs() - 1
	engine.mu.Unlock()
	engine.tickAll()
	final := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].UserAnswer == "A" })
	if final.Batches[0].Status == BatchAwaitingUser {
		t.Fatal("超时 recommended 后不应继续停在 awaiting_user")
	}
}

func TestUnknownBatchStateFailsClosed(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	engine.mu.Lock()
	engine.items[res.ID].Batches[0].Status = "made-up-state"
	engine.mu.Unlock()
	engine.tickAll()
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Status == StatusFault })
	if o.Batches[0].Status != "made-up-state" {
		t.Fatal("fail-closed 只改编排级状态，审计不应偷偷改写业务状态")
	}
}

func TestReviewWaitsForOtherWorkers(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.MaxParallel = 2
	plan.Policy.ReviewExplicit = true
	plan.Policy.Review = true
	plan.Batches = append(plan.Batches, BatchPlan{
		ID: "B2", Title: "并行", Spec: "改另一处", Owns: []string{"docs/**"},
	})
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		return o.Batches[0].Status == BatchDispatched && o.Batches[1].Status == BatchDispatched
	})
	b1 := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	b2 := claimAndStart(t, engine, ws, res.ID, "B2", 1)
	if _, err := engine.Report(b1.ExecutionToken, `{"batchId":"B1","reportId":"r1","status":"done","notes":"ok"}`); err != nil {
		t.Fatal(err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchVerifying })
	for _, b := range o.Batches {
		if b.Kind == KindReview {
			t.Fatal("B2 还在写时不能启动 B1 的审查")
		}
	}
	if _, err := engine.Report(b2.ExecutionToken, `{"batchId":"B2","reportId":"r2","status":"done","notes":"ok"}`); err != nil {
		t.Fatal(err)
	}
	engine.tickAll()
	waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		for _, b := range o.Batches {
			if b.Kind == KindReview && b.Status == BatchDispatched {
				return true
			}
		}
		return false
	})
}

func TestReviewReworkReusesReviewBatchWithoutDeadlock(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.ReviewExplicit = true
	plan.Policy.Review = true
	plan.Policy.MaxAttemptsPerBatch = 2
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	w1 := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if _, err := engine.Report(w1.ExecutionToken, `{"batchId":"B1","reportId":"r1","status":"done","notes":"首轮"}`); err != nil {
		t.Fatal(err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchReviewing })
	var reviewID string
	for _, b := range o.Batches {
		if b.Kind == KindReview {
			reviewID = b.ID
		}
	}
	r1 := claimAndStart(t, engine, ws, res.ID, reviewID, 1)
	if _, err := engine.Report(r1.ExecutionToken, `{"batchId":"`+reviewID+`","reportId":"rv1","status":"done","notes":"要改","review":{"blocking":[{"path":"src/a.js","problem":"x"}],"shouldFix":[],"suggestions":[]}}`); err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		return o.Batches[0].Status == BatchDispatched && o.Batches[0].Attempts == 1 && o.Batches[0].FailureReason == ReasonReviewFailed
	})
	w2 := claimAndStart(t, engine, ws, res.ID, "B1", 2)
	if _, err := engine.Report(w2.ExecutionToken, `{"batchId":"B1","reportId":"r2","status":"done","notes":"二轮"}`); err != nil {
		t.Fatal(err)
	}
	engine.tickAll()
	o = waitFor(t, engine, res.ID, func(o *Orchestration) bool {
		for _, b := range o.Batches {
			if b.Kind == KindReview {
				return b.Status == BatchDispatched && b.Attempts == 0
			}
		}
		return false
	})
	if o.Batches[0].Status != BatchReviewing {
		t.Fatalf("返工后 work 应重新进入 reviewing：%s", o.Batches[0].Status)
	}
	r2 := claimAndStart(t, engine, ws, res.ID, reviewID, 1)
	if _, err := engine.Report(r2.ExecutionToken, `{"batchId":"`+reviewID+`","reportId":"rv2","status":"done","notes":"通过","review":{"blocking":[],"shouldFix":[],"suggestions":[]}}`); err != nil {
		t.Fatalf("第二轮审查回报失败：%v", err)
	}
	engine.tickAll()
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDone })
}

func TestSkipBlocksDownstreamAndClosesEvent(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	plan.Policy.MaxParallel = 2
	plan.Batches = append(plan.Batches, BatchPlan{
		ID: "B2", Title: "下游", Spec: "s", Owns: []string{"docs/**"}, DependsOn: []string{"B1"},
	})
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	if _, err := engine.UserControl(ControlRequest{OrchestrationID: res.ID, Action: "skip", BatchID: "B1"}, ws); err != nil {
		t.Fatal(err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Status == StatusAwaitingArbitration })
	if o.Batches[1].Status != BatchBlocked || o.Batches[1].FailureReason != ReasonBlockedByDep {
		t.Fatalf("下游应 blocked_by_dep：%+v", o.Batches[1])
	}
	if engine.PendingArbitration(res.ID) == 0 {
		t.Fatal("跳过上游应为下游产生 L2 事件")
	}
	// 重派被阻塞的下游：事件应当被同批动作关闭。
	if _, err := engine.UserControl(ControlRequest{OrchestrationID: res.ID, Action: "retry", BatchID: "B2"}, ws); err != nil {
		t.Fatal(err)
	}
	if engine.PendingArbitration(res.ID) != 0 {
		t.Fatal("重派后该批事件应关闭")
	}
}

func TestPromptIncludesPreviousFailureAndAnswer(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	first := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if strings.Contains(first.Prompt, "上一轮回顾") {
		t.Fatal("首发不应带上一轮回顾")
	}
	if err := engine.TurnEvent(TurnEventRequest{Token: first.ExecutionToken, Kind: "turn_finished"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	second := claimAndStart(t, engine, ws, res.ID, "B1", 2)
	if !strings.Contains(second.Prompt, "上一轮回顾") || !strings.Contains(second.Prompt, ReasonNoReport) {
		t.Fatalf("重派 prompt 缺上一轮失败信息：%s", second.Prompt)
	}
	// awaiting_user 的答案必须进入下一次派单。
	payload := `{"batchId":"B1","reportId":"q2","status":"awaiting_user","question":{"text":"选哪个？","options":[{"label":"A","recommended":true}],"timeoutSec":60,"timeoutAction":"recommended"}}`
	if _, err := engine.Report(second.ExecutionToken, payload); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.UserControl(ControlRequest{OrchestrationID: res.ID, Action: "answer", BatchID: "B1", Answer: "选 A"}, ws); err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	third := claimAndStart(t, engine, ws, res.ID, "B1", 2)
	if !strings.Contains(third.Prompt, "用户回答") || !strings.Contains(third.Prompt, "选 A") {
		t.Fatalf("用户回答没有进入重派 prompt：%s", third.Prompt)
	}
}

func TestAbortStartClaimAndExecution(t *testing.T) {
	ws := testWorkspace(t)
	engine := testEngine(t, Deps{})
	plan := basePlan(ws, "B1")
	plan.Batches[0].Verify = nil
	res, err := engine.Create(plan, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	claim := engine.ClaimBatch(res.ID, "B1", 1, "win-1", ws)
	if !claim.OK {
		t.Fatal(claim.Reason)
	}
	if err := engine.AbortStart(AbortRequest{OrchestrationID: res.ID, BatchID: "B1", Token: claim.ClaimToken}, "win-1", ws); err != nil {
		t.Fatal(err)
	}
	o := waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	if o.Batches[0].Attempts != 0 {
		t.Fatalf("认领阶段中止不得消耗 attempts：%d", o.Batches[0].Attempts)
	}
	start := claimAndStart(t, engine, ws, res.ID, "B1", 1)
	if err := engine.AbortStart(AbortRequest{OrchestrationID: res.ID, BatchID: "B1", Token: start.ExecutionToken}, "win-1", ws); err != nil {
		t.Fatal(err)
	}
	o = waitFor(t, engine, res.ID, func(o *Orchestration) bool { return o.Batches[0].Status == BatchDispatched })
	if o.Batches[0].Attempts != 0 {
		t.Fatalf("起轮基础设施失败应回滚 attempts：%d", o.Batches[0].Attempts)
	}
	// 错误窗口不能中止别人的批次。
	claim2 := engine.ClaimBatch(res.ID, "B1", 1, "win-1", ws)
	if err := engine.AbortStart(AbortRequest{OrchestrationID: res.ID, BatchID: "B1", Token: claim2.ClaimToken}, "win-2", ws); err == nil {
		t.Fatal("别的窗口不能回滚该 claim")
	}
}

func TestStartEmptyDoesNotNotifyOrFault(t *testing.T) {
	var notified atomic.Int32
	engine := NewEngine(filepath.Join(t.TempDir(), "orchestrations"), Deps{
		Notify: func(title, body, payload string) {
			if strings.Contains(title, "编排调度器故障") {
				notified.Add(1)
			}
		},
		WorkspaceAvailable: func(string) bool { return true },
	})
	if err := engine.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	engine.Stop()
	if notified.Load() != 0 {
		t.Fatal("没有编排时调度器巡检 panic 不应发“全部编排已停止”")
	}
}
