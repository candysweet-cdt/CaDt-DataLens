// engine.go：Router / supervisor / auditor 的实现。所有状态变更都在同一把锁内完成；
// 事件、通知、快照与验收执行只在锁外调用。supervisor 判定只用自己的时间戳，
// 不向前端询问“还在跑吗”；前端只主动推送回合生命周期事实。
//
// 锁内 IO 是有意取舍（2026-11-27 审查确认）：设计文档 §5.3.4 要求“锁内只做内存读写”，
// 但 tickAllInner / auditOnce 在持锁期间会调 store.Save 与 AppendLog。原因是状态与落盘
// 必须同源（两阶段改成“锁内取快照、锁外写”会让读者在写完成前看到新状态，恢复路径会
// 重放同一批事件）。atomfile 是原子换名写、单写者，正常情况下亚毫秒；慢盘或杀毒扫描
// 会拉长全引擎互斥，属已知代价，不是可以随手挪走的小事。
package orchestration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	dispatchEventName = "orchestration-dispatch"
	changedEventName  = "orchestration-changed"
	stopEventName     = "orchestration-stop"
	arbiterEventName  = "orchestration-arbiter-event"
	handoffEventName  = "orchestration-arbiter-handoff"
	auditEventName    = "orchestration-audit"
)

// SnapshotResult 宿主快照能力的窄接口，避免 internal 包依赖 wipeguard 的类型。
type SnapshotResult struct {
	Mode     string `json:"mode,omitempty"`
	Name     string `json:"name,omitempty"`
	Path     string `json:"path,omitempty"`
	Files    int    `json:"files,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
	Skipped  string `json:"skipped,omitempty"`
	Excluded string `json:"excluded,omitempty"`
}

// Deps 宿主注入；引擎本身不 import Wails、不读窗口注册表、不跑 UI。
type Deps struct {
	Emit               func(event string, payload any)
	Notify             func(title, body, payload string)
	SessionExists      func(sessionID string) bool
	WorkspaceAvailable func(workspace string) bool
	Snapshot           func(workspace string) (SnapshotResult, error)
	RunVerify          func(workspace string, spec VerifySpec) VerifyResult
	SessionTokens      func(sessionID string) int64
	Logf               func(level, format string, args ...any)
}

type ticket struct {
	Token           string
	OrchestrationID string
	BatchID         string
	SessionID       string
	Role            string
	Window          string
	Attempt         int
	ExpiresAt       int64
}

type claim struct {
	Token           string
	OrchestrationID string
	BatchID         string
	Window          string
	Attempt         int
	ExpiresAt       int64
}

type eventOut struct {
	name    string
	payload any
}

// Engine 编排引擎。单进程一个实例，多窗口共享。
type Engine struct {
	store *Store
	deps  Deps

	mu           sync.Mutex
	items        map[string]*Orchestration
	tickets      map[string]*ticket
	claims       map[string]*claim
	verifyJobs   map[string]bool
	nextCheck    map[string]int64
	doneNotified map[string]bool
	noticeState  map[string]string

	supervisorCancel context.CancelFunc
	supervisorDone   chan struct{}
	watchdogCancel   context.CancelFunc
	watchdogDone     chan struct{}
	auditorCancel    context.CancelFunc
	auditorDone      chan struct{}
	restartMu        sync.Mutex
	tickWG           sync.WaitGroup
	started          atomic.Bool
	lastTickAt       atomic.Int64
}

// NewEngine 创建引擎；root 为空时使用宿主 AppDataDir。
func NewEngine(root string, deps Deps) *Engine {
	if root == "" {
		root, _ = orchestrationRoot()
	}
	if deps.RunVerify == nil {
		deps.RunVerify = RunVerifySpec
	}
	if deps.Logf == nil {
		deps.Logf = logf
	} else {
		// Store / recoverTickPanic 等包级路径走 Logf；只设置 deps 会让 panic 日志静默丢失。
		Logf = deps.Logf
	}
	return &Engine{
		store: NewStore(root), deps: deps,
		items: make(map[string]*Orchestration), tickets: make(map[string]*ticket),
		claims: make(map[string]*claim), verifyJobs: make(map[string]bool),
		nextCheck: make(map[string]int64), doneNotified: make(map[string]bool),
		noticeState: make(map[string]string),
	}
}

// Start 加载全部编排、做冷启动恢复并拉起 supervisor + auditor。
func (e *Engine) Start() error {
	if e.started.Swap(true) {
		return nil
	}
	items, err := e.store.LoadAll()
	if err != nil {
		e.started.Store(false)
		return err
	}
	e.mu.Lock()
	for _, o := range items {
		e.recoverOnLoadLocked(o)
		e.items[o.ID] = o
	}
	e.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	e.supervisorCancel = cancel
	e.supervisorDone = make(chan struct{})
	go e.supervisorLoop(ctx, e.supervisorDone)
	wCtx, wCancel := context.WithCancel(context.Background())
	e.watchdogCancel = wCancel
	e.watchdogDone = make(chan struct{})
	go e.watchdogLoop(wCtx, e.watchdogDone)
	aCtx, aCancel := context.WithCancel(context.Background())
	e.auditorCancel = aCancel
	e.auditorDone = make(chan struct{})
	go e.auditorLoop(aCtx, e.auditorDone)
	e.lastTickAt.Store(nowMs())
	logf("info", "orchestration: supervisor 已启动（%d 个编排）", len(items))
	return nil
}

// Stop 取消 supervisor/auditor 并吊销全部票据；磁盘状态保留。
func (e *Engine) Stop() {
	if !e.started.Swap(false) {
		return
	}
	if e.supervisorCancel != nil {
		e.supervisorCancel()
	}
	if e.watchdogCancel != nil {
		e.watchdogCancel()
	}
	if e.auditorCancel != nil {
		e.auditorCancel()
	}
	if e.supervisorDone != nil {
		select {
		case <-e.supervisorDone:
		case <-time.After(5 * time.Second):
			logf("warn", "orchestration: supervisor 未在 5s 内退出")
		}
	}
	if e.watchdogDone != nil {
		select {
		case <-e.watchdogDone:
		case <-time.After(5 * time.Second):
			logf("warn", "orchestration: watchdog 未在 5s 内退出")
		}
	}
	if e.auditorDone != nil {
		select {
		case <-e.auditorDone:
		case <-time.After(5 * time.Second):
			logf("warn", "orchestration: auditor 未在 5s 内退出")
		}
	}
	e.mu.Lock()
	e.tickets = make(map[string]*ticket)
	e.claims = make(map[string]*claim)
	e.mu.Unlock()
}

func (e *Engine) recoverOnLoadLocked(o *Orchestration) {
	changed := false
	for i := range o.Batches {
		b := &o.Batches[i]
		switch b.Status {
		case BatchDispatched:
			// 只认领未起轮：attempts 未增加，回到 pending 重新广播。
			b.Status = BatchPending
			b.ClaimedBy, b.ClaimedAt, b.DispatchAt = "", 0, 0
			changed = true
		case BatchRunning, BatchReviewing:
			reason := ReasonStalled
			b.FailureReason = reason
			b.SessionID = ""
			b.Deadline = 0
			b.Frozen = false
			if b.Attempts < effectiveMaxAttempts(o) && b.Kind != KindReview {
				b.Status = BatchPending
			} else if b.Kind == KindReview && b.Attempts < DefaultReviewAttempts {
				b.Status = BatchPending
			} else {
				b.Status = BatchFailed
			}
			changed = true
		case BatchVerifying:
			// 结果作废，由 supervisor 在静默屏障后复跑。
			changed = true
		}
	}
	// 冷启动时审查批次已耗尽 attempts：被审 work 必须显式 block，不能留在 reviewing
	// 让 supervisor 以为还有人在审（那会永远等不到审查结论）。
	for i := range o.Batches {
		rv := &o.Batches[i]
		if rv.Kind != KindReview || rv.Status != BatchFailed {
			continue
		}
		if work := findBatch(o, rv.ReviewOf); work != nil && work.Status == BatchReviewing {
			work.Status = BatchBlocked
			work.FailureReason = ReasonReviewUnavailable
			changed = true
		}
	}
	// 没有有效票据的旧会话不能再回报：状态回到可由 supervisor 推进的形态。
	if o.Status == StatusRunning || o.Status == StatusAwaitingUser || o.Status == StatusAwaitingArbitration || o.Status == StatusBlocked {
		applyDeferredStatusLocked(o)
		changed = true
	}
	if changed {
		o.UpdatedAt = nowMs()
		if err := e.store.Save(o); err != nil {
			logf("warn", "orchestration: 冷启动恢复保存 %s 失败：%v", o.ID, err)
		}
		e.store.AppendLog(o.ID, LogEntry{Kind: "recover", Why: "应用重启：旧回合按 stalled 处理，verifying 结果作废复跑"})
	}
}

func (e *Engine) supervisorLoop(ctx context.Context, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	// 启动即巡检一次。
	e.tickAll()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.lastTickAt.Store(nowMs())
			e.tickAll()
		}
	}
}

// watchdogLoop 必须独立于 supervisor：restartSupervisor 要 cancel 并等待旧 supervisor
// 退出；若在同一条 goroutine 里等自己，必然 30s 超时并把调度器永久停掉。
func (e *Engine) watchdogLoop(ctx context.Context, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !e.started.Load() {
				return
			}
			if nowMs()-e.lastTickAt.Load() > 90_000 {
				e.restartSupervisor("看门狗发现巡检超过 3 个周期未执行")
			}
		}
	}
}

func (e *Engine) restartSupervisor(reason string) {
	// 多个看门狗来源（watchdog / auditor）并发请求时只允许一个重启者。
	e.restartMu.Lock()
	defer e.restartMu.Unlock()
	// 复查触发条件：等这把锁期间别的来源可能已经重启过（lastTickAt 被刷新）。
	// 不复查就会把刚起来的循环再 cancel 一次、重起一个——功能无损但纯属空转，
	// 而且审计者按文件 mtime 判的“无进展”可能根本不是调度器卡死。
	if nowMs()-e.lastTickAt.Load() <= 90_000 {
		return
	}
	// Go 不能强杀 goroutine：先 cancel 并等旧循环确认退出，超时则只报警，绝不再起第二个。
	if !e.started.Load() || e.supervisorCancel == nil {
		return
	}
	oldDone := e.supervisorDone
	e.supervisorCancel()
	select {
	case <-oldDone:
	case <-time.After(30 * time.Second):
		logf("error", "orchestration: supervisor 卡死且未退出（%s）；不再启动第二个调度器，请重启应用", reason)
		e.notify("编排调度器需要重启", "调度器内部卡死且旧实例未退出。请重启 CaDt-DataLens；已完成的改动不受影响。", "")
		return
	}
	if !e.started.Load() {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.supervisorCancel = cancel
	e.supervisorDone = make(chan struct{})
	e.lastTickAt.Store(nowMs())
	go e.supervisorLoop(ctx, e.supervisorDone)
	logf("warn", "orchestration: supervisor 已重启：%s", reason)
	e.emit(auditEventName, map[string]any{"kind": "supervisor_restart", "reason": reason})
}

func (e *Engine) auditorLoop(ctx context.Context, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.auditOnceSafe()
		}
	}
}

func (e *Engine) auditOnceSafe() {
	defer func() {
		if r := recover(); r != nil {
			logf("error", "orchestration: auditor panic：%v", r)
		}
	}()
	e.auditOnce()
}

// auditOnce 只观察持久化事实，只报警/请求重启，绝不改业务状态。
func (e *Engine) auditOnce() {
	now := nowMs()
	var anomalies []eventOut
	e.mu.Lock()
	locked := true
	defer func() {
		if locked {
			e.mu.Unlock()
		}
	}()
	for _, o := range e.items {
		if o.Status != StatusRunning {
			continue
		}
		o.Audit.LastAuditAt = now
		mtime := e.store.ModTime(o.ID)
		idle := now - mtime
		if mtime > 0 && idle > o.Policy.AuditIdleMs {
			detail := fmt.Sprintf("状态文件 %d 分钟无变化（阈值 %d 分钟）", idle/60000, o.Policy.AuditIdleMs/60000)
			o.Audit.Anomalies = append(o.Audit.Anomalies, AuditAnomaly{At: now, Kind: "idle", Detail: detail})
			anomalies = append(anomalies, eventOut{auditEventName, map[string]any{
				"root": workspaceRoot(o), "orchestrationId": o.ID, "kind": "idle", "detail": detail,
			}})
			e.store.AppendLog(o.ID, LogEntry{Kind: "audit", Why: detail})
			continue
		}
		for i := range o.Batches {
			b := &o.Batches[i]
			if b.Status != BatchRunning || b.Deadline == 0 {
				continue
			}
			limit := b.Deadline + 3*effectiveTimeout(o, b)
			if now > limit {
				detail := fmt.Sprintf("批次 %s 超 deadline 三倍仍未处置", b.ID)
				o.Audit.Anomalies = append(o.Audit.Anomalies, AuditAnomaly{At: now, Kind: "batch_overdue", Detail: detail})
				anomalies = append(anomalies, eventOut{auditEventName, map[string]any{
					"root": workspaceRoot(o), "orchestrationId": o.ID, "kind": "batch_overdue", "batchId": b.ID, "detail": detail,
				}})
				e.store.AppendLog(o.ID, LogEntry{Kind: "audit", Batch: b.ID, Why: detail})
			}
		}
	}
	locked = false
	e.mu.Unlock()
	if len(anomalies) > 0 {
		for _, ev := range anomalies {
			e.emit(ev.name, ev.payload)
			e.notify("编排审计发现异常", "编排看起来在运行但长时间没有进展。请打开编排看板检查；系统未修改任何业务状态。", "")
		}
		// 审计者只“请求”重启：restartSupervisor 内部仍要等旧实例退出。
		go e.restartSupervisor("审计者发现长时间无进展")
	}
}

// tickAll 推进全部编排；每轮巡检只做内存判定，事件/验收在锁外。
func (e *Engine) tickAll() {
	defer e.recoverTickPanic()
	e.tickAllInner()
}

// scheduleTick 记录异步巡检，测试与退出可在临时目录清理前等它落盘。
func (e *Engine) scheduleTick() {
	e.tickWG.Add(1)
	go func() {
		defer e.tickWG.Done()
		e.tickAll()
	}()
}

func (e *Engine) waitTicks() { e.tickWG.Wait() }

func (e *Engine) recoverTickPanic() {
	if r := recover(); r != nil {
		reason := fmt.Sprintf("supervisor 巡检 panic：%v", r)
		logf("error", "orchestration: %s\n%s", reason, debug.Stack())
		e.failClosedAll(reason)
	}
}

func (e *Engine) tickAllInner() {
	var jobs []func()
	var emits []eventOut
	type toast struct{ title, body string }
	var toasts []toast
	e.mu.Lock()
	locked := true
	// panic 时 tickAll 的 recover 仍需要这把锁可重入；defer 兜住异常退出路径。
	defer func() {
		if locked {
			e.mu.Unlock()
		}
	}()
	now := nowMs()
	for _, o := range e.items {
		if o.Status == StatusDone || o.Status == StatusFailed || o.Status == StatusFault || o.Status == StatusStopped {
			continue
		}
		if o.Status == StatusPaused {
			continue
		}
		if bad := invalidState(o); bad != "" {
			o.Status = StatusFault
			freezeDeadlinesLocked(o)
			o.UpdatedAt = now
			_ = e.store.Save(o)
			e.store.AppendLog(o.ID, LogEntry{Kind: "fault", Why: "状态机进入未知状态：" + bad})
			emits = append(emits, e.changedEventOf(o))
			emits = append(emits, eventOut{auditEventName, map[string]any{
				"root": workspaceRoot(o), "orchestrationId": o.ID, "kind": "state_fault",
				"detail": "状态机遇到未知状态，已 fail-closed 停止推进：" + bad,
			}})
			continue
		}
		// 工作区可用性：无可用窗口就暂停并冻结时限，不烧看不见的钱。
		available := true
		if e.deps.WorkspaceAvailable != nil {
			available = e.deps.WorkspaceAvailable(workspaceRoot(o))
		}
		if !available {
			if o.Status == StatusRunning {
				o.Status = StatusPausedNoWindow
				freezeDeadlinesLocked(o)
				o.UpdatedAt = now
				if err := e.store.Save(o); err != nil {
					logf("warn", "orchestration: 保存暂停状态失败：%v", err)
				}
				emits = append(emits, e.changedEventOf(o))
			}
			continue
		}
		if o.Status == StatusPausedNoWindow {
			o.Status = StatusRunning
			resumeDeadlinesLocked(o)
			o.UpdatedAt = now
			if err := e.store.Save(o); err != nil {
				logf("warn", "orchestration: 保存恢复状态失败：%v", err)
			}
			emits = append(emits, e.changedEventOf(o))
		}
		before := o.Status
		mutated := false
		// 等待用户超时动作。
		for i := range o.Batches {
			b := &o.Batches[i]
			if b.Status == BatchAwaitingUser && b.AwaitingUntil > 0 && now >= b.AwaitingUntil {
				e.applyUserTimeoutLocked(o, b, now)
				mutated = true
			}
		}
		// 审查者/Worker 会话消失：不等 deadline。
		for i := range o.Batches {
			b := &o.Batches[i]
			if (b.Status != BatchRunning && b.Status != BatchReviewing) || b.SessionID == "" {
				continue
			}
			if e.deps.SessionExists != nil && now-b.DispatchedAt > 60_000 && !e.deps.SessionExists(b.SessionID) {
				e.endAttemptLocked(o, b, ReasonSessionGone, "执行会话已不存在", now)
				mutated = true
			}
		}
		// deadline 超时。
		for i := range o.Batches {
			b := &o.Batches[i]
			if b.Status != BatchRunning && b.Status != BatchReviewing {
				continue
			}
			if b.Deadline > 0 && now > b.Deadline {
				e.endAttemptLocked(o, b, ReasonStalled, "超过批次时限且没有结构化回报", now)
				mutated = true
			}
		}
		if e.maybeStartVerifyLocked(o) {
			mutated = true
		}
		// attempts 已用尽的 pending 不能反复认领：置 blocked，交给仲裁者显式重派。
		for i := range o.Batches {
			b := &o.Batches[i]
			if b.Status != BatchPending {
				continue
			}
			limit := effectiveMaxAttempts(o)
			if b.Kind == KindReview {
				limit = DefaultReviewAttempts
			}
			if b.Attempts >= limit {
				b.Status = BatchBlocked
				b.FailureReason = "attempts_exhausted"
				mutated = true
			}
		}
		// 失败/阻塞批次必须有对应的 L2 事件（覆盖冷启动恢复、旧版本状态迁移）。
		for i := range o.Batches {
			b := &o.Batches[i]
			// 终审没有 work 可挂，失败/阻塞必须自己进 L2。
			// （旧存档里可能残留逐批审查批次：它们的失败由被审 work 的事件覆盖，跳过。）
			if (b.Kind == KindReview && !b.FinalReview) || (b.Status != BatchFailed && b.Status != BatchBlocked) {
				continue
			}
			found := false
			for _, ev := range o.ArbitrationQueue {
				// 已裁决过的事件也算「已投递」：状态仍停在 blocked/failed 是用户/仲裁者的
				// 有意结果，不能每轮巡检都重新开一张卡。
				if ev.BatchID == b.ID {
					found = true
					break
				}
			}
			if !found {
				reason := b.FailureReason
				if reason == "" {
					reason = "needs_arbitration"
				}
				e.enqueueArbitrationLocked(o, b.ID, reason, "批次处于 "+b.Status+"，等待仲裁", now)
				mutated = true
			}
		}
		// 过期 claim / 无人认领的广播：按 CLAIM_TTL 节流重发，避免每 5 秒重复派发。
		for i := range o.Batches {
			b := &o.Batches[i]
			if b.Status != BatchDispatched {
				continue
			}
			if b.ClaimedBy != "" && now-b.ClaimedAt < ClaimTTL {
				continue
			}
			if now-b.DispatchAt < ClaimTTL {
				continue
			}
			e.releaseClaimLocked(o, b)
			if b.DispatchRetries >= MaxDispatchRetries {
				b.Status = BatchBlocked
				b.FailureReason = ReasonDispatchUnavailable
				b.SessionID = ""
				b.DispatchAt = now
				detail := fmt.Sprintf("连续 %d 次广播后都没能拉起执行会话（认领超时/宿主建会话失败）", b.DispatchRetries+1)
				e.enqueueArbitrationLocked(o, b.ID, ReasonDispatchUnavailable, detail, now)
				e.store.AppendLog(o.ID, LogEntry{Kind: "dispatch-failed", Batch: b.ID, Why: detail})
				mutated = true
				continue
			}
			b.DispatchRetries++
			b.DispatchAt = now
			// 重发广播不是一次新的“派发尝试”：把它计入 10 分钟窗口会在正常认领超时时
			// 误触单位时间护栏。真正的派发只在 pending→dispatched 时计数。
			e.store.AppendLog(o.ID, LogEntry{Kind: "dispatch-retry", Batch: b.ID, Why: "认领超时未 StartBatch，重发派发广播"})
			emits = append(emits, e.dispatchEventOf(o, b))
			mutated = true
		}
		// L2 事件重投与仲裁者失效判定：唤醒失败/信箱满/应用重启后由巡检重新投递。
		for i := range o.ArbitrationQueue {
			ev := &o.ArbitrationQueue[i]
			if ev.Resolved {
				continue
			}
			timeout := o.Policy.ArbiterTimeoutMs
			if timeout <= 0 {
				timeout = DefaultArbiterTimeoutMs
			}
			if now-ev.CreatedAt < timeout {
				continue
			}
			if ev.LastPokeAt > 0 && now-ev.LastPokeAt < timeout {
				continue
			}
			ev.LastPokeAt = now
			o.Arbiter.Misses++
			mutated = true
			if o.Arbiter.Misses >= o.Policy.ArbiterMissLimit {
				o.Arbiter.Misses = 0
				emits = append(emits, eventOut{handoffEventName, map[string]any{
					"root": workspaceRoot(o), "orchestrationId": o.ID,
					"sessionId": o.Arbiter.SessionID, "generation": o.Arbiter.Generation,
					"reason": "仲裁者连续无响应，需要交接",
				}})
				e.store.AppendLog(o.ID, LogEntry{Kind: "arbiter-miss", Why: "连续无响应达到上限，请求交接"})
			} else {
				emits = append(emits, eventOut{arbiterEventName, e.arbiterPayload(o, *ev)})
			}
		}
		// 预算/轮次/时长护栏：事后熔断。blocked 必须是 sticky 的——applyDeferred 看到
		// 还有 pending 会把它算回 running，熔断就形同虚设。
		guardrailHit := false
		if p := guardrailProblem(o); p != "" {
			o.Status = StatusBlocked
			freezeDeadlinesLocked(o)
			e.enqueueArbitrationLocked(o, "", "guardrail", p, now)
			guardrailHit = true
			mutated = true
		}
		// 全部 work 与逐批审查收尾后，按策略创建终审批次；终审未通过前不报 done。
		if e.ensureFinalReviewsLocked(o) {
			mutated = true
		}
		// 派发可运行批次。
		ids := readyBatchIDs(o, true)
		if len(ids) > 0 && o.Status == StatusRunning {
			for _, id := range ids {
				b := findBatch(o, id)
				if b == nil {
					continue
				}
				b.Status = BatchDispatched
				b.DispatchAt = now
				b.ClaimedBy, b.ClaimedAt = "", 0
				o.Stats.DispatchTimes = append(o.Stats.DispatchTimes, now)
				pruneDispatchTimes(o)
				e.store.AppendLog(o.ID, LogEntry{
					Kind: "dispatch", Batch: b.ID,
					Why:      fmt.Sprintf("依赖满足且并发未满（%d/%d）", activeCount(o), o.Policy.MaxParallel),
					Decision: "emit " + dispatchEventName,
				})
				emits = append(emits, e.dispatchEventOf(o, b))
				mutated = true
			}
		}
		applyDeferredStatusLocked(o)
		if guardrailHit {
			o.Status = StatusBlocked
			freezeDeadlinesLocked(o)
		}
		// L3：需要人处理的整体状态变化只提醒一次；恢复运行后清掉提醒记忆。
		switch o.Status {
		case StatusAwaitingUser, StatusBlocked, StatusFault:
			if e.noticeState[o.ID] != o.Status {
				e.noticeState[o.ID] = o.Status
				body := "编排「" + o.Title + "」" + statusLabelForNotice(o.Status) + "，请打开编排看板处理。"
				toasts = append(toasts, toast{title: "编排需要你处理", body: body})
			}
		case StatusRunning, StatusDone:
			delete(e.noticeState, o.ID)
		}
		if e.deps.SessionTokens != nil {
			var tokens int64
			for _, b := range o.Batches {
				if b.SessionID != "" {
					tokens += e.deps.SessionTokens(b.SessionID)
				}
			}
			if tokens > o.Stats.TokensUsed {
				o.Stats.TokensUsed = tokens
			}
		}
		if o.Status == StatusDone && !e.doneNotified[o.ID] {
			e.doneNotified[o.ID] = true
			emits = append(emits, e.doneEvent(o))
			toasts = append(toasts, toast{
				title: "编排完成",
				body:  fmt.Sprintf("编排「%s」已完成：%d 个批次全部收尾。", o.Title, len(workBatches(o))),
			})
		}
		if mutated || before != o.Status {
			o.UpdatedAt = now
			if err := e.store.Save(o); err != nil {
				logf("warn", "orchestration: 保存 %s 失败：%v", o.ID, err)
			}
			emits = append(emits, e.changedEventOf(o))
		}
		// 启动验收任务是锁外动作。
		if b := e.pendingVerifyLocked(o); b != nil {
			jobs = append(jobs, e.makeVerifyJob(o.ID, b.ID))
		}
	}
	locked = false
	e.mu.Unlock()
	for _, job := range jobs {
		go job()
	}
	for _, ev := range emits {
		e.emit(ev.name, ev.payload)
	}
	for _, t := range toasts {
		e.notify(t.title, t.body, "")
	}
}

func invalidState(o *Orchestration) string {
	allowedOrch := map[string]bool{
		StatusPlanning: true, StatusRunning: true, StatusPaused: true, StatusPausedNoWindow: true,
		StatusStopped: true, StatusAwaitingUser: true, StatusAwaitingArbitration: true,
		StatusBlocked: true, StatusDone: true, StatusFailed: true, StatusFault: true,
	}
	if len(o.Workspaces) == 0 || strings.TrimSpace(o.Workspaces[0]) == "" {
		return "归属工作区为空"
	}
	if !allowedOrch[o.Status] {
		return "编排状态 " + o.Status
	}
	allowedBatch := map[string]bool{
		BatchPending: true, BatchDispatched: true, BatchRunning: true, BatchVerifying: true,
		BatchReviewing: true, BatchDone: true, BatchFailed: true, BatchBlocked: true,
		BatchAwaitingUser: true, BatchCancelled: true, BatchSkipped: true,
	}
	for _, b := range o.Batches {
		if !allowedBatch[b.Status] {
			return "批次 " + b.ID + " 状态 " + b.Status
		}
	}
	return ""
}

// failClosedAll 是巡检 panic 的最后一道：所有仍在运行的编排转 fault，保留已完成结果。
func (e *Engine) failClosedAll(reason string) {
	e.mu.Lock()
	emits := make([]eventOut, 0, len(e.items))
	faulted := 0
	for _, o := range e.items {
		switch o.Status {
		case StatusDone, StatusFailed, StatusFault, StatusStopped, StatusPaused:
			continue
		}
		o.Status = StatusFault
		faulted++
		freezeDeadlinesLocked(o)
		o.UpdatedAt = nowMs()
		if err := e.store.Save(o); err != nil {
			logf("error", "orchestration: panic 后保存 fault 失败（%s）：%v", o.ID, err)
		}
		e.store.AppendLog(o.ID, LogEntry{Kind: "fault", Why: reason})
		emits = append(emits, e.changedEventOf(o))
	}
	e.mu.Unlock()
	for _, ev := range emits {
		e.emit(ev.name, ev.payload)
	}
	// 没有运行中的编排时 panic 只应留日志：给用户发“全部编排已停止”的 toast 是误报，
	// 也解释了“刚打开软件就弹调度器故障”——空集合本就不该有故障可报。
	if faulted > 0 {
		e.notify("编排调度器故障", fmt.Sprintf("编排巡检异常，%d 个运行中的编排已 fail-closed 停止推进。请查看决策日志并重启应用。", faulted), "")
	}
}

// workspaceRoot 对损坏/迁移中的状态返回空串而不是 panic：后续鉴权会 fail-closed。
func workspaceRoot(o *Orchestration) string {
	if o == nil || len(o.Workspaces) == 0 {
		return ""
	}
	return o.Workspaces[0]
}

func activeCount(o *Orchestration) int {
	n := 0
	for i := range o.Batches {
		if batchActive(o.Batches[i].Status) {
			n++
		}
	}
	return n
}

func (e *Engine) pendingVerifyLocked(o *Orchestration) *Batch {
	if e.verifyJobs[o.ID] {
		return nil
	}
	if !verifyBarrierClear(o) {
		return nil // 静默屏障：有人还在写/审查，验收不启动
	}
	for i := range o.Batches {
		if o.Batches[i].Status == BatchVerifying {
			e.verifyJobs[o.ID] = true
			cp := o.Batches[i]
			return &cp
		}
	}
	return nil
}

// verifyBarrierClear：同一个工作区没有正在写入/审查的 Worker，才允许验收或审查继续。
func verifyBarrierClear(o *Orchestration) bool {
	for i := range o.Batches {
		switch o.Batches[i].Status {
		case BatchRunning, BatchDispatched, BatchReviewing:
			return false
		}
	}
	return true
}

// maybeStartVerifyLocked 在无 verify 命令时直接推进到审查/完成（仍须静默屏障）。
func (e *Engine) maybeStartVerifyLocked(o *Orchestration) bool {
	if !verifyBarrierClear(o) {
		return false
	}
	changed := false
	for i := range o.Batches {
		b := &o.Batches[i]
		if b.Status != BatchVerifying || len(b.Verify) > 0 {
			continue
		}
		e.advanceAfterVerifyLocked(o, b, true, "")
		changed = true
	}
	return changed
}

func (e *Engine) makeVerifyJob(orchID, batchID string) func() {
	return func() {
		e.mu.Lock()
		o := e.items[orchID]
		if o == nil {
			delete(e.verifyJobs, orchID)
			e.mu.Unlock()
			return
		}
		b := findBatch(o, batchID)
		if b == nil || b.Status != BatchVerifying {
			delete(e.verifyJobs, orchID)
			e.mu.Unlock()
			return
		}
		workspace := workspaceRoot(o)
		specs := append([]VerifySpec(nil), b.Verify...)
		e.mu.Unlock()

		results := runVerifyAll(workspace, specs, e.deps.RunVerify)
		failed := false
		for _, res := range results {
			if res.ExitCode != 0 {
				failed = true
				break
			}
		}
		var emits []eventOut
		e.mu.Lock()
		delete(e.verifyJobs, orchID)
		o = e.items[orchID]
		if o != nil {
			b = findBatch(o, batchID)
			if b != nil && b.Status == BatchVerifying {
				if failed {
					summary := verifyFailureSummary(results)
					e.endAttemptLocked(o, b, ReasonVerifyFailed, summary, nowMs())
					e.store.AppendLog(o.ID, LogEntry{Kind: "verify", Batch: b.ID, Why: "验收失败", Decision: truncateRunes(summary, 800)})
				} else {
					e.advanceAfterVerifyLocked(o, b, true, "")
					e.store.AppendLog(o.ID, LogEntry{Kind: "verify", Batch: b.ID, Why: "验收通过"})
				}
				applyDeferredStatusLocked(o)
				o.UpdatedAt = nowMs()
				if err := e.store.Save(o); err != nil {
					logf("warn", "orchestration: 保存验收结果失败：%v", err)
				}
				emits = append(emits, e.changedEventOf(o))
			}
		}
		e.mu.Unlock()
		for _, ev := range emits {
			e.emit(ev.name, ev.payload)
		}
		e.scheduleTick()
	}
}

// advanceAfterVerifyLocked：验收绿后直接完成。逐批审查已取消（质量门由全部收尾后的终审统一做），
// 这里不再有中间态，过 = done、不过 = 返工/失败。
func (e *Engine) advanceAfterVerifyLocked(o *Orchestration, b *Batch, pass bool, summary string) {
	if !pass {
		e.endAttemptLocked(o, b, ReasonVerifyFailed, summary, nowMs())
		return
	}
	e.finishWorkLocked(o, b, nowMs())
}

// ensureFinalReviewsLocked 在全部工作收尾后创建终审批次。
// 终审是独立的只读批次（不是 spawn_agent 子代理）：沿用同一条 claim/start 路径，
// 模型留空时由前端创建会话时继承母会话，不在 Router 里猜模型。
func (e *Engine) ensureFinalReviewsLocked(o *Orchestration) bool {
	if !o.Policy.FinalReview || len(finalReviewBatches(o)) > 0 {
		return false
	}
	if !allWorkDoneOrSkipped(o) {
		return false
	}
	count := o.Policy.FinalReviewCount
	if count <= 0 {
		count = 1
	}
	if count > MaxFinalReviews {
		count = MaxFinalReviews
	}
	for i := 1; i <= count; i++ {
		id := fmt.Sprintf("final-review-%d", i)
		o.Batches = append(o.Batches, Batch{
			ID: id, Title: "终审：" + o.Title, Kind: KindReview, FinalReview: true,
			Workspace: workspaceRoot(o), Spec: finalReviewSpecFor(o, i, count),
			Owns: []string{}, DependsOn: []string{},
			Model:  ModelSpec{First: o.Policy.FinalReviewModel},
			Status: BatchPending, Activated: true,
		})
	}
	e.store.AppendLog(o.ID, LogEntry{
		Kind: "final-review-created", Why: fmt.Sprintf("全部批次完成，创建 %d 个终审批次", count),
	})
	return true
}

func finalReviewIndex(o *Orchestration, id string) int {
	for i, b := range finalReviewBatches(o) {
		if b.ID == id {
			return i + 1
		}
	}
	return 1
}

// resetFinalReviewsForReworkLocked：work 批次在终审之后被重派/跳过时，旧终审结论立即失效。
// 终审正在执行则拒绝改 work（避免 review 会话审到移动目标）；否则把终审批次重置为待派发，
// 并关闭它们遗留的 L2 事件，等新结果收尾后重新终审。
func (e *Engine) resetFinalReviewsForReworkLocked(o *Orchestration, reason string, now int64) error {
	finals := finalReviewBatches(o)
	if len(finals) == 0 {
		return nil
	}
	for _, b := range finals {
		if batchActive(b.Status) {
			return fmt.Errorf("终审正在执行，不能重派/跳过已完成批次；请先等终审收尾")
		}
	}
	ids := make(map[string]bool, len(finals))
	for _, b := range finals {
		ids[b.ID] = true
		b.Status = BatchPending
		b.Attempts = 0
		b.Report = nil
		b.Review = nil
		b.Receipts = nil
		b.Question, b.AwaitingUntil = nil, 0
		b.SessionID = ""
		b.FailureReason = ""
		b.Deadline, b.Frozen, b.RemainingMs = 0, false, 0
	}
	for i := range o.ArbitrationQueue {
		ev := &o.ArbitrationQueue[i]
		if !ev.Resolved && ids[ev.BatchID] {
			ev.Resolved = true
			ev.Resolution = "终审因 " + reason + " 失效"
		}
	}
	e.store.AppendLog(o.ID, LogEntry{Kind: "final-review-reset", Why: "批次 " + reason + "，旧终审结论作废"})
	return nil
}

func finalReviewSpecFor(o *Orchestration, index, count int) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "你是只读终审者（%d/%d）。这不是逐批审查：请从整份编排的目标出发，检查所有批次的改动合起来是否成立。\n\n", index, count)
	fmt.Fprintf(&sb, "总目标：%s\n\n工作批次与逐批审查结论：\n", o.Goal)
	for _, b := range workBatches(o) {
		notes := ""
		if b.Report != nil {
			notes = strings.TrimSpace(b.Report.Notes)
		}
		fmt.Fprintf(&sb, "- %s「%s」%s\n  · 写了：%s\n  · 结论：%s\n",
			b.ID, b.Title, b.Status, summarizeWriteDirs(b.WriteLog, 300), truncateRunes(notes, 300))
		if b.Review != nil {
			fmt.Fprintf(&sb, "  · 逐批审查：blocking=%d shouldFix=%d suggestions=%d\n",
				len(b.Review.Blocking), len(b.Review.ShouldFix), len(b.Review.Suggestions))
		}
	}
	sb.WriteString("\n终审要求：\n")
	sb.WriteString("- 只读；不得修改任何文件。\n")
	sb.WriteString("- 以各批 writeLog 与工作区当前内容为准，不要把工作区既有未提交改动归到本次编排。\n")
	sb.WriteString("- 检查跨批次接口/接线是否真的接上；对“已修的接线类断言”做反向验证：删掉实现，测试会不会红。\n")
	sb.WriteString("- 只报会影响目标或交付质量的问题；不要重复逐批审查已经确认的细节。\n")
	fmt.Fprintf(&sb, "- 收尾必须调用 orchestration_report（batchId=final-review-%d），用 review 字段给出 blocking / shouldFix / suggestions。\n", index)
	return sb.String()
}

func (e *Engine) finishWorkLocked(o *Orchestration, b *Batch, now int64) {
	if b.Status == BatchDone {
		return
	}
	b.Status = BatchDone
	b.Deadline, b.Frozen, b.RemainingMs = 0, false, 0
	b.Question, b.AwaitingUntil = nil, 0
	if b.Kind == KindWork {
		reportID := ""
		if b.Report != nil {
			reportID = b.Report.ReportID
		}
		b.History = append(b.History, HistoryEntry{
			Attempt: b.Attempts, SessionID: b.SessionID, Status: BatchDone, At: now, ReportID: reportID,
		})
		o.Stats.Done++
		for i := range o.Batches {
			if o.Batches[i].Kind == KindReview && o.Batches[i].ReviewOf == b.ID &&
				(o.Batches[i].Status == BatchPending || o.Batches[i].Status == BatchDispatched) {
				// 用 skipped 而不是 cancelled：cancelled 会在“恢复编排”时被重新置 pending，
				// 复活一个已经无意义的审查批次，把已完成的 work 打回 reviewing。
				o.Batches[i].Status = BatchSkipped
			}
		}
	}
	e.store.AppendLog(o.ID, LogEntry{Kind: "batch-done", Batch: b.ID, Why: "验收与审查通过"})
}

// endAttemptLocked 结束当前尝试；attempts 已达上限则 failed 并进 L2。
func (e *Engine) endAttemptLocked(o *Orchestration, b *Batch, reason, detail string, now int64) {
	attempt := b.Attempts
	entry := HistoryEntry{
		Attempt: attempt, SessionID: b.SessionID, Status: reason, At: now, Reason: truncateRunes(detail, 800),
	}
	if b.Report != nil {
		entry.ReportID = b.Report.ReportID
		entry.AutonomousChoice = b.Report.AutonomousChoice
	}
	b.History = append(b.History, entry)
	b.FailureReason = reason
	b.SessionID = ""
	b.Deadline, b.Frozen, b.RemainingMs = 0, false, 0
	b.Question, b.AwaitingUntil = nil, 0
	b.Report = nil
	limit := effectiveMaxAttempts(o)
	if b.Kind == KindReview {
		limit = DefaultReviewAttempts
	}
	if b.Attempts < limit {
		b.Status = BatchPending
		o.Stats.Rework++
		e.store.AppendLog(o.ID, LogEntry{Kind: "retry", Batch: b.ID, Why: reason + "：" + truncateRunes(detail, 300)})
		return
	}
	b.Status = BatchFailed
	o.Stats.Failed++
	e.store.AppendLog(o.ID, LogEntry{Kind: "failed", Batch: b.ID, Why: reason + "：" + truncateRunes(detail, 300)})
	if b.Kind == KindReview {
		if work := findBatch(o, b.ReviewOf); work != nil {
			work.Status = BatchBlocked
			work.FailureReason = ReasonReviewUnavailable
			e.enqueueArbitrationLocked(o, work.ID, ReasonReviewUnavailable, detail, now)
		}
	} else {
		e.enqueueArbitrationLocked(o, b.ID, reason, detail, now)
	}
}

// resumeSameAttemptLocked：awaiting_user 被回答 / 超时按推荐继续时，新的会话只是
// 接着同一次尝试干活，不应消耗 attempts。回执也按该 attempt 清掉，避免 reportId 幂等误拒。
func resumeSameAttemptLocked(b *Batch, now int64) {
	attempt := b.Attempts
	if b.Attempts > 0 {
		b.Attempts--
	}
	kept := b.Receipts[:0]
	for _, rec := range b.Receipts {
		if rec.Attempt != attempt {
			kept = append(kept, rec)
		}
	}
	b.Receipts = kept
	b.Report = nil
	b.SessionID = ""
	b.Deadline, b.Frozen, b.RemainingMs = 0, false, 0
	b.Question, b.AwaitingUntil = nil, 0
	b.Status = BatchPending
}

// enqueueArbitrationLocked 持久化 L2 事件，再由 tick 外层唤醒当前仲裁者。
func (e *Engine) enqueueArbitrationLocked(o *Orchestration, batchID, reason, detail string, now int64) {
	if o == nil {
		return
	}
	for _, ev := range o.ArbitrationQueue {
		if !ev.Resolved && ev.BatchID == batchID && ev.Reason == reason {
			return
		}
	}
	ev := ArbitrationEvent{
		EventID: newEventID(), BatchID: batchID, Reason: reason,
		Detail: truncateRunes(detail, 1200), CreatedAt: now,
	}
	o.ArbitrationQueue = append(o.ArbitrationQueue, ev)
	pruneResolvedArbitrationLocked(o)
	o.UpdatedAt = now
	payload := e.arbiterPayload(o, ev)
	// 当前在状态锁内：事件与通知只能异步送出，不能让 Wails/Toast 反压调度器。
	go e.emit(arbiterEventName, payload)
	e.store.AppendLog(o.ID, LogEntry{Kind: "arbitration-request", Batch: batchID, Why: reason + "：" + truncateRunes(detail, 400), Input: ev.EventID})
	if e.deps.SessionExists != nil && o.Arbiter.SessionID != "" && !e.deps.SessionExists(o.Arbiter.SessionID) {
		go e.notify("编排需要人工处理", "仲裁会话不可用，编排已停在等待仲裁："+truncateRunes(detail, 200), "")
	}
}

// pruneResolvedArbitrationLocked 只裁已裁决事件，保留最近 MaxResolvedArbitration 条；
// 未裁决事件永不丢。
func pruneResolvedArbitrationLocked(o *Orchestration) {
	if o == nil {
		return
	}
	resolved := 0
	for _, ev := range o.ArbitrationQueue {
		if ev.Resolved {
			resolved++
		}
	}
	excess := resolved - MaxResolvedArbitration
	if excess <= 0 {
		return
	}
	kept := make([]ArbitrationEvent, 0, len(o.ArbitrationQueue)-excess)
	for _, ev := range o.ArbitrationQueue {
		if ev.Resolved && excess > 0 {
			excess--
			continue
		}
		kept = append(kept, ev)
	}
	o.ArbitrationQueue = kept
}

func (e *Engine) arbiterPayload(o *Orchestration, ev ArbitrationEvent) map[string]any {
	b := findBatch(o, ev.BatchID)
	title := ""
	if b != nil {
		title = b.Title
	}
	text := fmt.Sprintf("[编排事件] 批次 %s「%s」需要仲裁\n- 原因：%s\n- 详情：%s\n- 可执行动作：重派（重置 attempts）/ 跳过该批 / 改 spec / 终止编排\n- eventId：%s\n- generation：%d",
		ev.BatchID, title, ev.Reason, ev.Detail, ev.EventID, o.Arbiter.Generation)
	return map[string]any{
		"root": workspaceRoot(o), "orchestrationId": o.ID, "sessionId": o.Arbiter.SessionID,
		"generation": o.Arbiter.Generation, "eventId": ev.EventID, "batchId": ev.BatchID,
		"reason": ev.Reason, "text": text,
	}
}

func (e *Engine) changedEventOf(o *Orchestration) eventOut {
	return eventOut{changedEventName, map[string]any{
		"root": workspaceRoot(o), "orchestrationId": o.ID, "status": o.Status,
		"summary": summarizeOrchestration(o),
	}}
}

func (e *Engine) dispatchEventOf(o *Orchestration, b *Batch) eventOut {
	return eventOut{dispatchEventName, map[string]any{
		"root": workspaceRoot(o), "orchestrationId": o.ID, "batchId": b.ID,
		"expectedAttempt": b.Attempts + 1, "kind": b.Kind, "title": b.Title,
		"reviewOf": b.ReviewOf,
	}}
}

func (e *Engine) doneEvent(o *Orchestration) eventOut {
	return eventOut{changedEventName, map[string]any{
		"root": workspaceRoot(o), "orchestrationId": o.ID, "status": o.Status,
		"summary": summarizeOrchestration(o), "done": true,
	}}
}

func (e *Engine) applyUserTimeoutLocked(o *Orchestration, b *Batch, now int64) {
	q := b.Question
	action := "recommended"
	if q != nil && q.TimeoutAction != "" {
		action = q.TimeoutAction
	}
	switch action {
	case "wait":
		b.AwaitingUntil = 0
		return
	case "abort":
		b.FailureReason = "timeout_abort"
		e.endAttemptLocked(o, b, "timeout_abort", "等待用户回答超时，按 timeoutAction=abort 结束该批", now)
		return
	case "ai_decide":
		b.Status = BatchBlocked
		b.Question, b.AwaitingUntil = nil, 0
		e.enqueueArbitrationLocked(o, b.ID, "timeout_ai_decide", "等待用户回答超时，交仲裁者决定", now)
		return
	default:
		answer := ""
		if q != nil {
			for _, opt := range q.Options {
				if opt.Recommended {
					answer = opt.Label
					break
				}
			}
		}
		if answer == "" {
			answer = "按推荐方案继续"
		}
		b.UserAnswer = answer
		resumeSameAttemptLocked(b, now)
		e.store.AppendLog(o.ID, LogEntry{Kind: "user-timeout", Batch: b.ID, Why: "awaiting_user 超时，按推荐答案继续：" + truncateRunes(answer, 200)})
	}
}

// ---- 公开操作（均会持久化并广播状态变化）----

// Create 创建并启动编排。快照在锁外做；勾了却没拍成时拒绝创建（不静默继续）。
func (e *Engine) Create(req PlanRequest, parentWindow string) (CreateResult, error) {
	plan, errs := ValidatePlan(req)
	if len(errs) > 0 {
		return CreateResult{}, fmt.Errorf("%s", strings.Join(errs, "；"))
	}
	ws, err := filepath.Abs(strings.TrimSpace(plan.Workspace))
	if err != nil {
		return CreateResult{}, fmt.Errorf("工作区路径无效：%w", err)
	}
	plan.Workspace = ws
	var snap *SnapshotInfo
	if plan.Policy.SnapshotBeforeStart {
		if e.deps.Snapshot == nil {
			return CreateResult{}, fmt.Errorf("当前版本不支持开始前快照；请取消勾选后重试")
		}
		res, err := e.deps.Snapshot(ws)
		if err != nil {
			return CreateResult{}, fmt.Errorf("创建开始前快照失败：%w（请取消勾选或修复后重试）", err)
		}
		if res.Skipped != "" {
			return CreateResult{}, fmt.Errorf("开始前快照未创建：%s（请取消勾选或修复后重试）", res.Skipped)
		}
		snap = &SnapshotInfo{At: nowMs(), Mode: res.Mode, Name: res.Name, Bytes: res.Bytes, Excluded: res.Excluded}
	}
	id := "orch-" + newToken("")[:20]
	now := nowMs()
	arbiterID := strings.TrimSpace(plan.ArbiterSessionID)
	if arbiterID == "" {
		arbiterID = strings.TrimSpace(plan.ParentSessionID)
	}
	o := &Orchestration{
		ID: id, Title: strings.TrimSpace(plan.Title), Goal: strings.TrimSpace(plan.Goal),
		Workspaces: []string{ws}, ParentSessionID: strings.TrimSpace(plan.ParentSessionID),
		GroupSnapshot: plan.GroupSnapshot, ArbiterModelRef: strings.TrimSpace(plan.ArbiterModelRef),
		Arbiter:  Arbiter{SessionID: arbiterID, Generation: 1, AssignedAt: now},
		Snapshot: snap, CreatedAt: now, UpdatedAt: now, Status: StatusRunning,
		Policy: plan.Policy,
	}
	for _, bp := range plan.Batches {
		o.Batches = append(o.Batches, Batch{
			ID: bp.ID, Title: bp.Title, Kind: KindWork, Workspace: ws, Spec: bp.Spec,
			Owns: bp.Owns, DependsOn: bp.DependsOn, Verify: bp.Verify, TimeoutMs: bp.TimeoutMs,
			Model: bp.Model, Status: BatchPending,
		})
	}
	e.mu.Lock()
	if _, exists := e.items[id]; exists {
		e.mu.Unlock()
		return CreateResult{}, fmt.Errorf("编排 id 冲突，请重试")
	}
	e.items[id] = o
	if err := e.store.Save(o); err != nil {
		delete(e.items, id)
		e.mu.Unlock()
		return CreateResult{}, fmt.Errorf("写入编排状态失败：%w", err)
	}
	e.store.AppendLog(id, LogEntry{Kind: "create", Why: "审批通过，创建编排", Input: map[string]any{"batches": len(o.Batches), "window": parentWindow}})
	createdStatus := o.Status
	createdSummary := summarizeOrchestration(o)
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": ws, "orchestrationId": id, "status": createdStatus, "summary": createdSummary})
	e.scheduleTick()
	warning := ""
	if snap != nil && snap.Excluded != "" {
		warning = "快照已创建，但部分文件被排除：" + snap.Excluded
	}
	return CreateResult{ID: id, Status: StatusRunning, Snapshot: snap, Warning: warning}, nil
}

// Preview 校验并跑纯内存 dry-run（不写状态）。
func (e *Engine) Preview(req PlanRequest) PlanPreview {
	plan, errs := ValidatePlan(req)
	if len(errs) > 0 {
		return PlanPreview{Valid: false, Errors: errs, Plan: plan, AuditMinMs: maxBatchTimeout(plan)}
	}
	return PlanDryRun(plan)
}

// List 按工作区过滤；workspace 由 Service 从可信调用方上下文取得。
func (e *Engine) List(workspace string) []Summary {
	// 空 workspace = 多工作区 harness 的全局视图（只由 Service 在可信主窗口下放行）。
	key := ""
	if strings.TrimSpace(workspace) != "" {
		key = cleanAbs(workspace)
	}
	e.mu.Lock()
	out := make([]Summary, 0, len(e.items))
	for _, o := range e.items {
		root := workspaceRoot(o)
		if root == "" || (key != "" && cleanAbs(root) != key) {
			continue
		}
		out = append(out, summarizeOrchestration(o))
	}
	e.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func summarizeOrchestration(o *Orchestration) Summary {
	total, done, failed := 0, 0, 0
	attention := false
	for _, b := range o.Batches {
		if b.Kind == KindReview {
			continue
		}
		total++
		switch b.Status {
		case BatchDone, BatchSkipped:
			done++
		case BatchFailed, BatchBlocked:
			failed++
			attention = true
		}
		if b.Status == BatchAwaitingUser {
			attention = true
		}
	}
	return Summary{
		ID: o.ID, Title: o.Title, Goal: o.Goal, Workspace: workspaceRoot(o),
		ParentSessionID: o.ParentSessionID, Status: o.Status, TotalWork: total,
		DoneWork: done, FailedWork: failed, CreatedAt: o.CreatedAt, UpdatedAt: o.UpdatedAt,
		HasAttention: attention || o.Status == StatusBlocked || o.Status == StatusFault ||
			o.Status == StatusAwaitingUser || o.Status == StatusAwaitingArbitration,
	}
}

// Get 按工作区鉴权后返回深拷贝详情。
func (e *Engine) Get(id, workspace string) (*StatusView, error) {
	e.mu.Lock()
	o := e.items[id]
	if o == nil {
		e.mu.Unlock()
		return nil, fmt.Errorf("编排不存在")
	}
	if workspace != "" && cleanAbs(workspace) != cleanAbs(workspaceRoot(o)) {
		e.mu.Unlock()
		return nil, fmt.Errorf("该编排属于其它工作区")
	}
	clone := deepCopy(o)
	e.mu.Unlock()
	return &StatusView{Orchestration: clone, Batches: clone.Batches, RecentEvents: e.store.TailLog(id, 50)}, nil
}

func deepCopy(o *Orchestration) *Orchestration {
	raw, err := json.Marshal(o)
	if err != nil {
		return copyOrchestration(o)
	}
	var out Orchestration
	if json.Unmarshal(raw, &out) != nil {
		return copyOrchestration(o)
	}
	return &out
}

// ClaimBatch 第一阶段：认领派发并签发短期 claimToken。
func (e *Engine) ClaimBatch(id, batchID string, expectedAttempt int, window, workspace string) ClaimResponse {
	e.mu.Lock()
	defer e.mu.Unlock()
	o := e.items[id]
	if o == nil {
		return ClaimResponse{Reason: "编排不存在"}
	}
	if workspace != "" && cleanAbs(workspace) != cleanAbs(workspaceRoot(o)) {
		return ClaimResponse{Reason: "编排属于其它工作区"}
	}
	b := findBatch(o, batchID)
	if b == nil {
		return ClaimResponse{Reason: "批次不存在"}
	}
	if b.Status != BatchDispatched {
		return ClaimResponse{Reason: "批次已不在待认领状态"}
	}
	if expectedAttempt != b.Attempts+1 {
		return ClaimResponse{Reason: "expectedAttempt 不匹配"}
	}
	now := nowMs()
	if b.ClaimedBy != "" && now-b.ClaimedAt < ClaimTTL {
		return ClaimResponse{Reason: "已被窗口 " + b.ClaimedBy + " 认领"}
	}
	tok := newToken("claim-")
	exp := now + ClaimTTL
	e.claims[tok] = &claim{
		Token: tok, OrchestrationID: id, BatchID: batchID, Window: window,
		Attempt: expectedAttempt, ExpiresAt: exp,
	}
	b.ClaimedBy = window
	b.ClaimedAt = now
	return ClaimResponse{
		OK: true, ClaimToken: tok, OrchestrationID: id, BatchID: batchID,
		Attempt: expectedAttempt, Kind: b.Kind, ExpiresAt: exp,
	}
}

// StartBatch 第二阶段：写 dispatchedAt/deadline、attempts++、签发执行票据并返回 prompt。
func (e *Engine) StartBatch(req StartRequest, window, workspace string) (StartResponse, error) {
	e.mu.Lock()
	o := e.items[req.OrchestrationID]
	if o == nil {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("编排不存在")
	}
	if workspace != "" && cleanAbs(workspace) != cleanAbs(workspaceRoot(o)) {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("编排属于其它工作区")
	}
	b := findBatch(o, req.BatchID)
	if b == nil {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("批次不存在")
	}
	cl := e.claims[req.ClaimToken]
	if cl == nil || cl.OrchestrationID != req.OrchestrationID || cl.BatchID != req.BatchID || cl.ExpiresAt < nowMs() {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("认领票据无效或已过期")
	}
	if cl.Window != "" && window != "" && cl.Window != window {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("认领票据属于窗口 %s，不是当前窗口", cl.Window)
	}
	if b.Status != BatchDispatched {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("批次已不在待起轮状态")
	}
	if cl.Attempt != b.Attempts+1 {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("尝试序号不匹配：票据 %d / 当前 %d", cl.Attempt, b.Attempts+1)
	}
	limit := effectiveMaxAttempts(o)
	if b.Kind == KindReview {
		limit = DefaultReviewAttempts
	}
	if b.Attempts >= limit {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("批次 %s 的 attempts 已用尽（%d/%d）；请先让仲裁者重派（重置 attempts）", b.ID, b.Attempts, limit)
	}
	now := nowMs()
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("缺少执行会话 id")
	}
	// 终审 spec 在每次派发时按当前工作批次状态重算：work 可能被重派/跳过，
	// 创建时的旧摘要不能带进新终审。
	if b.FinalReview {
		b.Spec = finalReviewSpecFor(o, finalReviewIndex(o, b.ID), len(finalReviewBatches(o)))
	}
	// prompt 必须用「上一轮」字段生成：attempts、FailureReason、UserAnswer 一旦清掉，
	// 重派回顾与用户回答就永远进不了新会话。先拼 prompt，再改字段。
	prompt := buildDispatchPrompt(o, b)
	b.Attempts++
	b.DispatchRetries = 0
	b.SessionID = sessionID
	b.ClaimedBy = window
	b.ClaimedAt = now
	b.DispatchedAt = now
	b.Deadline = now + effectiveTimeout(o, b)
	b.RemainingMs, b.Frozen = 0, false
	b.Status = BatchRunning
	b.Report = nil
	b.FailureReason = ""
	b.UserAnswer = ""
	delete(e.claims, req.ClaimToken)
	token := newToken("exec-")
	e.tickets[token] = &ticket{
		Token: token, OrchestrationID: o.ID, BatchID: b.ID, SessionID: b.SessionID,
		Role: b.Kind, Window: window, Attempt: b.Attempts, ExpiresAt: now + TicketTTL,
	}
	o.Stats.Rounds++
	model := focusedModel(o, b)
	scope := o.Policy.Scope
	if b.Kind == KindReview || len(b.Owns) == 0 {
		scope = "read"
	}
	applyDeferredStatusLocked(o)
	o.UpdatedAt = now
	if err := e.store.Save(o); err != nil {
		e.mu.Unlock()
		return StartResponse{}, fmt.Errorf("保存起轮状态失败：%w", err)
	}
	e.store.AppendLog(o.ID, LogEntry{Kind: "start", Batch: b.ID, Why: "StartBatch 成功，attempts=" + fmt.Sprint(b.Attempts), Decision: model})
	startRoot, startStatus := workspaceRoot(o), o.Status
	startSummary := summarizeOrchestration(o)
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": startRoot, "orchestrationId": o.ID, "status": startStatus, "summary": startSummary})
	return StartResponse{
		ExecutionToken: token, Prompt: prompt, Model: model, Scope: scope,
		BatchID: b.ID, Attempt: b.Attempts, Kind: b.Kind, ReviewOf: b.ReviewOf,
	}, nil
}

func focusedModel(o *Orchestration, b *Batch) string {
	if b.Kind == KindReview {
		if b.FinalReview {
			return o.Policy.FinalReviewModel
		}
		return o.Policy.ReviewModel
	}
	ref := b.Model.First
	if b.Attempts > 1 && b.Model.Retry != "" {
		ref = b.Model.Retry
	}
	if !o.Policy.AllowWorkerModels || ref == "" {
		return ""
	}
	for _, allowed := range o.Policy.AllowedWorkerModels {
		if allowed == ref {
			return ref
		}
	}
	return ""
}

// AbortStart 起轮前基础设施失败：吊销票据、清 claim、回到 pending 并回滚 attempts。
// 只接受与本次 orchestration/batch/window 绑定且仍在基础设施失败窗口内的票据，
// 旧票据/过期 claim 不能把正在跑的批次打回 pending。
func (e *Engine) AbortStart(req AbortRequest, window, workspace string) error {
	e.mu.Lock()
	o := e.items[req.OrchestrationID]
	if o == nil {
		e.mu.Unlock()
		return fmt.Errorf("编排不存在")
	}
	if o.Status == StatusStopped || o.Status == StatusFault {
		e.mu.Unlock()
		return fmt.Errorf("编排已停止或故障，不能回滚起轮")
	}
	if workspace != "" && cleanAbs(workspace) != cleanAbs(workspaceRoot(o)) {
		e.mu.Unlock()
		return fmt.Errorf("编排属于其它工作区")
	}
	b := findBatch(o, req.BatchID)
	if b == nil {
		e.mu.Unlock()
		return fmt.Errorf("批次不存在")
	}
	cl := e.claims[req.Token]
	tk := e.tickets[req.Token]
	if cl == nil && tk == nil {
		e.mu.Unlock()
		return fmt.Errorf("票据无效")
	}
	now := nowMs()
	if cl != nil {
		if cl.OrchestrationID != o.ID || cl.BatchID != b.ID || (cl.Window != "" && window != "" && cl.Window != window) {
			e.mu.Unlock()
			return fmt.Errorf("认领票据不属于该批次/窗口")
		}
		if b.Status != BatchDispatched {
			e.mu.Unlock()
			return fmt.Errorf("批次不在待起轮状态，不能回滚认领")
		}
		delete(e.claims, req.Token)
		e.releaseClaimLocked(o, b)
	} else {
		abortedAttempt := b.Attempts
		if tk.OrchestrationID != o.ID || tk.BatchID != b.ID || tk.Attempt != b.Attempts ||
			tk.SessionID != b.SessionID || (tk.Window != "" && window != "" && tk.Window != window) {
			e.mu.Unlock()
			return fmt.Errorf("执行票据与当前批次不匹配（可能已被重派）")
		}
		if b.Status != BatchRunning {
			e.mu.Unlock()
			return fmt.Errorf("批次不在执行中状态，不能回滚起轮")
		}
		// 只有「起轮基础设施失败」的短窗口允许回滚；模型请求已经发出去后必须走 turn_failed。
		if b.DispatchedAt > 0 && now-b.DispatchedAt > 60_000 {
			e.mu.Unlock()
			return fmt.Errorf("起轮已超过 60 秒，不能按基础设施失败回滚；请让本轮回合以 turn_failed 结束")
		}
		delete(e.tickets, req.Token)
		e.releaseClaimLocked(o, b)
		if b.Attempts > 0 {
			b.Attempts--
		}
		kept := b.Receipts[:0]
		for _, rec := range b.Receipts {
			if rec.Attempt != abortedAttempt {
				kept = append(kept, rec)
			}
		}
		b.Receipts = kept
		b.History = append(b.History, HistoryEntry{
			Attempt: abortedAttempt, SessionID: b.SessionID, Status: "abort_start", At: now,
			Reason: truncateRunes(req.Reason, 500),
		})
	}
	b.DispatchRetries++
	b.SessionID = ""
	b.Deadline, b.DispatchedAt, b.Frozen, b.RemainingMs = 0, 0, false, 0
	b.Report = nil
	if b.DispatchRetries >= MaxDispatchRetries {
		b.Status = BatchBlocked
		b.FailureReason = ReasonDispatchUnavailable
		detail := fmt.Sprintf("连续 %d 次起轮失败（宿主不可用/建会话失败），最后一次：%s",
			b.DispatchRetries, truncateRunes(req.Reason, 300))
		e.enqueueArbitrationLocked(o, b.ID, ReasonDispatchUnavailable, detail, now)
		e.store.AppendLog(o.ID, LogEntry{Kind: "dispatch-failed", Batch: b.ID, Why: detail})
	} else {
		b.Status = BatchPending
	}
	o.UpdatedAt = now
	applyDeferredStatusLocked(o)
	if err := e.store.Save(o); err != nil {
		e.mu.Unlock()
		return err
	}
	e.store.AppendLog(o.ID, LogEntry{Kind: "abort-start", Batch: b.ID, Why: truncateRunes(req.Reason, 300), Decision: "批次回到 pending"})
	abortRoot, abortStatus := workspaceRoot(o), o.Status
	abortSummary := summarizeOrchestration(o)
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": abortRoot, "orchestrationId": o.ID, "status": abortStatus, "summary": abortSummary})
	e.scheduleTick()
	return nil
}

func (e *Engine) releaseClaimLocked(o *Orchestration, b *Batch) {
	for tok, cl := range e.claims {
		if cl.OrchestrationID == o.ID && cl.BatchID == b.ID {
			delete(e.claims, tok)
		}
	}
	b.ClaimedBy, b.ClaimedAt = "", 0
}

// AuthorizeWrite 是受控写路径的 Go 侧闸；每次调用都记 writeLog（拒绝也记）。
func (e *Engine) AuthorizeWrite(token, absPath string) WriteResult {
	now := nowMs()
	e.mu.Lock()
	defer e.mu.Unlock()
	tk := e.tickets[token]
	if tk == nil || tk.ExpiresAt < now {
		return WriteResult{Allowed: false, Message: "执行票据无效或已过期"}
	}
	o := e.items[tk.OrchestrationID]
	if o == nil || o.Status == StatusStopped || o.Status == StatusFault {
		return WriteResult{Allowed: false, Message: "编排已停止或故障，写入被拒绝"}
	}
	b := findBatch(o, tk.BatchID)
	if b == nil || b.SessionID != tk.SessionID || b.Attempts != tk.Attempt || b.Status != BatchRunning {
		return WriteResult{Allowed: false, Message: "执行票据与当前批次不匹配（可能已被重派）"}
	}
	rel, err := authorizePath(b.Workspace, b.Owns, absPath)
	entry := WriteLogEntry{Attempt: b.Attempts, At: now, Path: rel}
	if rel == "" {
		entry.Path = filepath.ToSlash(filepath.Clean(absPath))
	}
	if err != nil {
		entry.Denied = true
		entry.Reason = err.Error()
		b.WriteLog = append(b.WriteLog, entry)
		if len(b.WriteLog) > 500 {
			b.WriteLog = b.WriteLog[len(b.WriteLog)-500:]
		}
		o.UpdatedAt = now
		_ = e.store.Save(o)
		e.store.AppendLog(o.ID, LogEntry{Kind: "write-denied", Batch: b.ID, Why: err.Error(), Input: map[string]any{"path": rel, "owns": b.Owns}})
		return WriteResult{Allowed: false, Rel: rel, Message: err.Error()}
	}
	b.WriteLog = append(b.WriteLog, entry)
	if len(b.WriteLog) > 500 {
		b.WriteLog = b.WriteLog[len(b.WriteLog)-500:]
	}
	o.UpdatedAt = now
	_ = e.store.Save(o)
	return WriteResult{Allowed: true, Rel: rel}
}

// TurnEvent 回合生命周期事实：只影响失败分类，不参与 deadline 计算。
func (e *Engine) TurnEvent(req TurnEventRequest) error {
	e.mu.Lock()
	tk := e.tickets[req.Token]
	if tk == nil || tk.ExpiresAt < nowMs() {
		e.mu.Unlock()
		return fmt.Errorf("执行票据无效或已过期")
	}
	o := e.items[tk.OrchestrationID]
	if o == nil {
		e.mu.Unlock()
		return fmt.Errorf("编排不存在")
	}
	b := findBatch(o, tk.BatchID)
	if b == nil || b.SessionID != tk.SessionID || b.Attempts != tk.Attempt {
		e.mu.Unlock()
		return fmt.Errorf("票据与当前批次不匹配")
	}
	now := nowMs()
	switch req.Kind {
	case "turn_started":
		// stopped / blocked 后的迟到恢复事件不能重设 deadline。
		if b.Status != BatchRunning && b.Status != BatchReviewing {
			break
		}
		if b.DispatchedAt == 0 {
			b.DispatchedAt = now
		}
		if b.Frozen {
			// 审批结束 / 回合恢复：按冻结前剩余时限继续，不能从零重算。
			remaining := b.RemainingMs
			if remaining <= 0 {
				remaining = effectiveTimeout(o, b)
			}
			b.Deadline = now + remaining
			b.RemainingMs = 0
			b.Frozen = false
		} else if b.Deadline == 0 {
			b.Deadline = now + effectiveTimeout(o, b)
		}
	case "waiting_user", "waiting_approval":
		if !b.Frozen && b.Deadline > 0 {
			remaining := b.Deadline - now
			if remaining < 0 {
				remaining = 0
			}
			b.RemainingMs = remaining
		}
		b.Frozen = true
		b.Deadline = 0
	case "turn_finished":
		if b.Status == BatchRunning && b.Report == nil {
			e.endAttemptLocked(o, b, ReasonNoReport, "回合自然结束但没有调用 orchestration_report", now)
		}
	case "turn_failed":
		// 报告已经受理并进入 verifying / 终态后，回合收尾错误不再回滚业务事实。
		if b.Status != BatchRunning && b.Status != BatchReviewing {
			break
		}
		reason := strings.ToLower(req.Reason)
		if strings.Contains(reason, "user") || strings.Contains(reason, "stop") {
			entry := HistoryEntry{Attempt: b.Attempts, SessionID: b.SessionID, Status: ReasonUserStopped, At: now, Reason: truncateRunes(req.Reason, 500)}
			b.History = append(b.History, entry)
			b.Status = BatchBlocked
			b.FailureReason = ReasonUserStopped
			b.SessionID = ""
			b.Deadline, b.Frozen = 0, false
			e.enqueueArbitrationLocked(o, b.ID, ReasonUserStopped, "执行会话被用户停止", now)
			e.store.AppendLog(o.ID, LogEntry{Kind: "turn-failed", Batch: b.ID, Why: "用户停止，不自动重试"})
		} else {
			e.endAttemptLocked(o, b, ReasonNoReport, "回合失败："+req.Reason, now)
		}
	default:
		e.mu.Unlock()
		return fmt.Errorf("未知回合事件：%s", req.Kind)
	}
	applyDeferredStatusLocked(o)
	o.UpdatedAt = now
	if err := e.store.Save(o); err != nil {
		e.mu.Unlock()
		return err
	}
	summary := summarizeOrchestration(o)
	root := workspaceRoot(o)
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": root, "orchestrationId": o.ID, "status": o.Status, "summary": summary})
	e.scheduleTick()
	return nil
}

// Report 受执行票据保护的完成/阻塞/审查回报。
func (e *Engine) Report(token string, rawReport string) (ReportResult, error) {
	if len(rawReport) > 1<<20 {
		return ReportResult{}, fmt.Errorf("报告过大（上限 1 MB）")
	}
	var report Report
	// 不启用 DisallowUnknownFields：review 问题是自由结构，模型多给一个解释字段
	// 不该让整份完成回报被拒。身份与状态仍由票据 + 枚举强校验。
	if err := json.Unmarshal([]byte(rawReport), &report); err != nil {
		return ReportResult{}, fmt.Errorf("报告格式无效：%w", err)
	}
	report.BatchID = strings.TrimSpace(report.BatchID)
	report.ReportID = strings.TrimSpace(report.ReportID)
	if report.ReportID == "" || len(report.ReportID) > 128 {
		return ReportResult{}, fmt.Errorf("缺少合法 reportId（<=128 字符）")
	}
	report.Notes = truncateRunes(report.Notes, 6000)
	report.BlockingIssue = truncateRunes(report.BlockingIssue, 2000)
	report.AutonomousChoice = truncateRunes(report.AutonomousChoice, 2000)
	if len(report.ChangedFiles) > 200 {
		report.ChangedFiles = report.ChangedFiles[:200]
	}
	if len(report.VerifySelf) > 20 {
		report.VerifySelf = report.VerifySelf[:20]
	}
	if report.Question != nil {
		report.Question.Text = truncateRunes(report.Question.Text, 2000)
		if report.Question.TimeoutSec > 3600 {
			report.Question.TimeoutSec = 3600
		}
		if len(report.Question.Options) > 8 {
			report.Question.Options = report.Question.Options[:8]
		}
		for i := range report.Question.Options {
			report.Question.Options[i].Label = truncateRunes(report.Question.Options[i].Label, 200)
		}
	}
	if report.Review != nil {
		if len(report.Review.Blocking) > 50 {
			report.Review.Blocking = report.Review.Blocking[:50]
		}
		if len(report.Review.ShouldFix) > 50 {
			report.Review.ShouldFix = report.Review.ShouldFix[:50]
		}
		if len(report.Review.Suggestions) > 50 {
			report.Review.Suggestions = report.Review.Suggestions[:50]
		}
	}
	report.At = 0
	report.Digest = ""
	canonical, _ := json.Marshal(report)
	sum := sha256.Sum256(canonical)
	digest := hex.EncodeToString(sum[:])
	e.mu.Lock()
	tk := e.tickets[token]
	if tk == nil || tk.ExpiresAt < nowMs() {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("执行票据无效或已过期")
	}
	o := e.items[tk.OrchestrationID]
	if o == nil || o.Status == StatusStopped || o.Status == StatusFault {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("编排已停止或故障，报告被拒绝")
	}
	b := findBatch(o, tk.BatchID)
	if b == nil {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("批次不存在")
	}
	if strings.TrimSpace(report.BatchID) != b.ID {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("batchId 与执行票据不符：本会话绑定的是 %s，不要提交他人的报告", b.ID)
	}
	if b.SessionID != tk.SessionID || b.Attempts != tk.Attempt {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("你已被取代（attempt %d → %d），报告不再受理；如需继续请等新会话", tk.Attempt, b.Attempts)
	}
	for _, rec := range b.Receipts {
		if rec.Attempt == b.Attempts && rec.ReportID == report.ReportID {
			if rec.Digest == digest {
				e.mu.Unlock()
				return ReportResult{Accepted: true, Duplicate: true, Message: rec.Result}, nil
			}
			e.mu.Unlock()
			return ReportResult{}, fmt.Errorf("同一 reportId 的正文与上次不同，拒绝覆盖")
		}
	}
	if b.Status != BatchRunning {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("批次 %s 已是 %s，报告被丢弃（是否重复调用？）", b.ID, b.Status)
	}
	if b.Kind == KindReview && report.Status != "done" {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("审查批次只能回报 done 并提交 review 结论")
	}
	if tk.Role != RoleReview && b.Kind != KindReview {
		if report.Status == "awaiting_user" && o.Policy.AutoRun {
			e.mu.Unlock()
			return ReportResult{}, fmt.Errorf("本次编排为自主执行模式，不能请求用户输入；请自行决定并在 notes 说明理由，或报 blocked")
		}
	}
	result, err := e.applyReportLocked(o, b, &report, tk, digest)
	if err != nil {
		e.mu.Unlock()
		return ReportResult{}, err
	}
	applyDeferredStatusLocked(o)
	o.UpdatedAt = nowMs()
	if err := e.store.Save(o); err != nil {
		e.mu.Unlock()
		return ReportResult{}, fmt.Errorf("保存回报失败：%w", err)
	}
	summary := summarizeOrchestration(o)
	root := workspaceRoot(o)
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": root, "orchestrationId": o.ID, "status": o.Status, "summary": summary})
	e.scheduleTick()
	return ReportResult{Accepted: true, Message: result}, nil
}

func (e *Engine) applyReportLocked(o *Orchestration, b *Batch, report *Report, tk *ticket, digest string) (string, error) {
	now := nowMs()
	report.At = now
	report.Digest = digest
	result := "报告已受理"
	switch report.Status {
	case "done":
		if b.Kind == KindReview && report.Review == nil {
			return "", fmt.Errorf("审查批次回报 done 必须带 review 字段（blocking / shouldFix / suggestions）")
		}
		b.Report = report
		b.Receipts = append(b.Receipts, ReportReceipt{Attempt: b.Attempts, ReportID: report.ReportID, Digest: digest, Result: result, At: now})
		if b.FinalReview {
			e.applyFinalReviewReportLocked(o, b, report, now)
		} else {
			// 无论有没有 verify 命令，都先进入 verifying：静默屏障要求「无写入者」才继续，
			// 没有 verify 的批次由 tick 在屏障解除后直接开审查/完成。
			b.Status = BatchVerifying
			b.Deadline, b.Frozen, b.RemainingMs = 0, false, 0
			e.store.AppendLog(o.ID, LogEntry{Kind: "report", Batch: b.ID, Why: "报告 done，等待静默屏障后复跑验收"})
		}
	case "blocked":
		if strings.TrimSpace(report.BlockingIssue) == "" {
			return "", fmt.Errorf("status=blocked 时必须填写 blockingIssue")
		}
		b.Report = report
		b.History = append(b.History, HistoryEntry{
			Attempt: b.Attempts, SessionID: b.SessionID, Status: BatchBlocked, At: now,
			ReportID: report.ReportID, Reason: truncateRunes(report.BlockingIssue, 800),
			AutonomousChoice: report.AutonomousChoice,
		})
		b.Status = BatchBlocked
		b.FailureReason = "blocked"
		b.SessionID = ""
		b.Deadline, b.Frozen = 0, false
		b.Receipts = append(b.Receipts, ReportReceipt{Attempt: b.Attempts, ReportID: report.ReportID, Digest: digest, Result: result, At: now})
		e.enqueueArbitrationLocked(o, b.ID, "blocked", report.BlockingIssue, now)
	case "awaiting_user":
		if o.Policy.AutoRun {
			return "", fmt.Errorf("本次编排为自主执行模式，不能请求用户输入")
		}
		if report.Question == nil || strings.TrimSpace(report.Question.Text) == "" {
			return "", fmt.Errorf("status=awaiting_user 时必须填写 question")
		}
		q := report.Question
		if q.TimeoutSec <= 0 {
			q.TimeoutSec = 600
		}
		if q.TimeoutAction == "" {
			q.TimeoutAction = "recommended"
		}
		switch q.TimeoutAction {
		case "recommended", "wait", "abort", "ai_decide":
		default:
			return "", fmt.Errorf("timeoutAction 无效：%s", q.TimeoutAction)
		}
		b.Report = report
		b.Question = q
		b.Status = BatchAwaitingUser
		b.Frozen = true
		b.Deadline = 0
		if q.TimeoutAction != "wait" {
			b.AwaitingUntil = now + int64(q.TimeoutSec)*1000
		}
		b.Receipts = append(b.Receipts, ReportReceipt{Attempt: b.Attempts, ReportID: report.ReportID, Digest: digest, Result: result, At: now})
		e.store.AppendLog(o.ID, LogEntry{Kind: "awaiting-user", Batch: b.ID, Why: truncateRunes(q.Text, 400)})
	default:
		return "", fmt.Errorf("status 必须是 done / blocked / awaiting_user")
	}
	return result, nil
}

// applyFinalReviewReportLocked 处理终审结论：通过则 done；有阻断/应修则停下交人，
// 不自动返工（终审的意见是整体判断，机械地拆回批次会猜错范围）。
func (e *Engine) applyFinalReviewReportLocked(o *Orchestration, review *Batch, report *Report, now int64) {
	review.Review = report.Review
	review.Status = BatchDone
	review.FailureReason = ""
	review.SessionID = ""
	review.Deadline, review.Frozen, review.RemainingMs = 0, false, 0
	blocking := 0
	shouldFix := 0
	if report.Review != nil {
		blocking = len(report.Review.Blocking)
		shouldFix = len(report.Review.ShouldFix)
	}
	if blocking == 0 && shouldFix == 0 {
		review.History = append(review.History, HistoryEntry{
			Attempt: review.Attempts, Status: BatchDone, At: now,
			ReportID: report.ReportID, Reason: truncateRunes(report.Notes, 800),
		})
		e.store.AppendLog(o.ID, LogEntry{Kind: "final-review-pass", Batch: review.ID, Why: "终审通过"})
		return
	}
	review.Status = BatchBlocked
	review.FailureReason = ReasonFinalReview
	review.History = append(review.History, HistoryEntry{
		Attempt: review.Attempts, Status: BatchBlocked, At: now, Problems: append(append([]ReviewIssue{}, report.Review.Blocking...), report.Review.ShouldFix...),
		ReportID: report.ReportID, Reason: truncateRunes(report.Notes, 800),
	})
	detail := fmt.Sprintf("终审阻断 %d 项、应修 %d 项；处理后可裁决通过或重派终审。", blocking, shouldFix)
	e.enqueueArbitrationLocked(o, review.ID, ReasonFinalReview, detail, now)
	e.store.AppendLog(o.ID, LogEntry{Kind: "final-review-blocked", Batch: review.ID, Why: detail})
}

// Control 仲裁者动作：必须带当前 generation。
func (e *Engine) Control(req ControlRequest, sessionID string) (ControlResult, error) {
	return e.control(req, sessionID, true, "")
}

// UserControl 看板按钮：可信窗口身份，不冒充仲裁者，不需要 generation。
func (e *Engine) UserControl(req ControlRequest, workspace string) (ControlResult, error) {
	return e.control(req, "", false, workspace)
}

func (e *Engine) control(req ControlRequest, sessionID string, arbiter bool, workspace string) (ControlResult, error) {
	e.mu.Lock()
	o := e.items[req.OrchestrationID]
	if o == nil {
		e.mu.Unlock()
		return ControlResult{}, fmt.Errorf("编排不存在")
	}
	if workspace != "" && cleanAbs(workspace) != cleanAbs(workspaceRoot(o)) {
		e.mu.Unlock()
		return ControlResult{}, fmt.Errorf("编排属于其它工作区")
	}
	if arbiter {
		if sessionID == "" || sessionID != o.Arbiter.SessionID {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("只有当前仲裁者可以执行该操作")
		}
		if req.Generation != 0 && req.Generation != o.Arbiter.Generation {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("仲裁者 generation 已落后（当前 %d），旧会话不能写入", o.Arbiter.Generation)
		}
	}
	now := nowMs()
	o.Arbiter.Misses = 0
	result := ControlResult{OK: true}
	switch req.Action {
	case "pause":
		o.Status = StatusPaused
		freezeDeadlinesLocked(o)
	case "resume":
		if o.Status == StatusStopped {
			for i := range o.Batches {
				if o.Batches[i].Status == BatchCancelled {
					o.Batches[i].Status = BatchPending
					o.Batches[i].DispatchRetries = 0
				}
			}
		}
		o.Status = StatusRunning
		resumeDeadlinesLocked(o)
	case "stop":
		e.stopLocked(o, now)
	case "skip":
		b := findBatch(o, req.BatchID)
		if b == nil {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次不存在")
		}
		if b.Status == BatchRunning || b.Status == BatchReviewing || b.Status == BatchVerifying {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次正在执行，不能跳过")
		}
		if b.Kind == KindWork {
			if err := e.resetFinalReviewsForReworkLocked(o, "skip", now); err != nil {
				e.mu.Unlock()
				return ControlResult{}, err
			}
		}
		b.Status = BatchSkipped
		b.SessionID = ""
		if b.Kind == KindReview {
			if work := findBatch(o, b.ReviewOf); work != nil && work.Status == BatchReviewing {
				work.Status = BatchBlocked
				work.FailureReason = ReasonReviewUnavailable
				e.enqueueArbitrationLocked(o, work.ID, ReasonReviewUnavailable, "审查批次被跳过，未放行", now)
			}
		}
		for i := range o.Batches {
			other := &o.Batches[i]
			if other.Kind == KindReview && other.ReviewOf == b.ID && other.Status == BatchPending {
				other.Status = BatchCancelled
			}
			if other.Kind == KindWork && other.Status == BatchPending && dependsOnID(other, b.ID) {
				other.Status = BatchBlocked
				other.FailureReason = ReasonBlockedByDep
				e.enqueueArbitrationLocked(o, other.ID, ReasonBlockedByDep, "上游批次 "+b.ID+" 已被跳过", now)
			}
		}
	case "retry":
		b := findBatch(o, req.BatchID)
		if b == nil {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次不存在")
		}
		if b.Status == BatchRunning || b.Status == BatchDispatched || b.Status == BatchReviewing {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次正在执行，不能重派")
		}
		if b.Kind == KindWork {
			if err := e.resetFinalReviewsForReworkLocked(o, "retry", now); err != nil {
				e.mu.Unlock()
				return ControlResult{}, err
			}
		}
		// 逐批审查只能在被审 work 处于 reviewing 时派发。存量编排里如果在其它状态
		// 重派旧 review，会永远 pending（并连带终审永不起来），直接按失效跳过。
		if b.Kind == KindReview && !b.FinalReview {
			work := findBatch(o, b.ReviewOf)
			if work == nil || work.Status != BatchReviewing {
				b.Status = BatchSkipped
				b.SessionID = ""
				b.FailureReason = ""
				b.History = append(b.History, HistoryEntry{
					Attempt: b.Attempts, Status: BatchSkipped, At: now,
					Reason: "重派时被审批次已不在审查态，审查批次自动跳过",
				})
				e.store.AppendLog(o.ID, LogEntry{Kind: "retry", Batch: b.ID, Why: "被审批次不在 reviewing，审查批次置 skipped"})
				break
			}
		}
		b.Status = BatchPending
		b.DispatchRetries = 0
		b.Attempts = 0
		b.FailureReason = ""
		b.Report = nil
		b.Review = nil
		// attempts 归零后若保留旧回执，同 reportId 会被幂等校验当成「已受理」而永久拒收。
		b.Receipts = nil
		b.SessionID = ""
		b.Deadline, b.Frozen = 0, false
		b.Question, b.AwaitingUntil = nil, 0
		o.Status = StatusRunning
	case "answer":
		b := findBatch(o, req.BatchID)
		if b == nil || b.Status != BatchAwaitingUser {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("该批次不在等待用户回答状态")
		}
		if strings.TrimSpace(req.Answer) == "" {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("回答不能为空")
		}
		b.UserAnswer = truncateRunes(req.Answer, 2000)
		resumeSameAttemptLocked(b, now)
		o.Status = StatusRunning
	case "update_batch":
		if req.Batch == nil {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("缺少批次草稿")
		}
		b := findBatch(o, req.BatchID)
		if b == nil {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次不存在")
		}
		if b.Status != BatchPending || b.Attempts > 0 {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("只能修改尚未派发过的批次")
		}
		// update_batch 同样整份重验（依赖成环 / owns 逃逸 / verify 包装器 / 模型白名单都拦）。
		candidate := *req.Batch
		candidate.ID = b.ID
		planReq := PlanRequest{
			Title: o.Title, Goal: o.Goal, Workspace: workspaceRoot(o),
			ParentSessionID: o.ParentSessionID, ArbiterModelRef: o.ArbiterModelRef, Policy: o.Policy,
		}
		for _, wb := range workBatches(o) {
			if wb.ID == b.ID {
				planReq.Batches = append(planReq.Batches, candidate)
				continue
			}
			planReq.Batches = append(planReq.Batches, BatchPlan{
				ID: wb.ID, Title: wb.Title, Spec: wb.Spec, Owns: wb.Owns,
				DependsOn: wb.DependsOn, Verify: wb.Verify, TimeoutMs: wb.TimeoutMs, Model: wb.Model,
			})
		}
		validated, errs := ValidatePlan(planReq)
		if len(errs) > 0 {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次修改未通过校验：%s", strings.Join(errs, "；"))
		}
		var next *BatchPlan
		for i := range validated.Batches {
			if validated.Batches[i].ID == b.ID {
				next = &validated.Batches[i]
				break
			}
		}
		if next == nil {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("批次修改校验丢失目标批次")
		}
		b.Title = next.Title
		b.Spec = next.Spec
		b.Owns = next.Owns
		b.DependsOn = next.DependsOn
		b.Verify = next.Verify
		b.TimeoutMs = next.TimeoutMs
		b.Model = next.Model
	case "resolve_arbitration":
		ev := findArbitrationEvent(o, req.ExpectedEventID)
		if ev == nil {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("待仲裁事件不存在")
		}
		ev.Resolved = true
		ev.Resolution = truncateRunes(req.Answer, 500)
		// 终审提出阻断/应修后停在 blocked 等裁决；裁决通过 = 接受终审意见并放行收尾。
		if ev.Reason == ReasonFinalReview {
			if b := findBatch(o, ev.BatchID); b != nil && b.FinalReview && (b.Status == BatchBlocked || b.Status == BatchFailed) {
				b.History = append(b.History, HistoryEntry{
					Attempt: b.Attempts, Status: "accepted", At: now,
					Reason: truncateRunes("用户裁决接受终审意见："+req.Answer, 800),
				})
				b.Status = BatchDone
				b.FailureReason = ""
				e.store.AppendLog(o.ID, LogEntry{Kind: "final-review-accepted", Batch: b.ID, Why: truncateRunes(req.Answer, 400)})
			}
		}
	case "handoff":
		if req.Answer == "" {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("交接需要新仲裁会话 id")
		}
		o.Arbiter.Handoffs = append(o.Arbiter.Handoffs, Handoff{
			From: o.Arbiter.SessionID, To: req.Answer, At: now, Reason: "手动交接",
		})
		o.Arbiter.SessionID = req.Answer
		o.Arbiter.Generation++
		o.Arbiter.AssignedAt = now
	case "delete":
		if !batchTerminalOrIdle(o) {
			e.mu.Unlock()
			return ControlResult{}, fmt.Errorf("只能删除已结束的编排")
		}
		delete(e.items, o.ID)
		_ = e.store.Delete(o.ID)
		e.mu.Unlock()
		return ControlResult{OK: true, Status: "deleted"}, nil
	default:
		e.mu.Unlock()
		return ControlResult{}, fmt.Errorf("未知控制动作：%s", req.Action)
	}
	// 重派 / 跳过是对该批待仲裁事件的显式处置：一并关闭，避免看板永远停在待仲裁。
	if req.Action == "retry" || req.Action == "skip" || req.Action == "update_batch" {
		for i := range o.ArbitrationQueue {
			ev := &o.ArbitrationQueue[i]
			if !ev.Resolved && ev.BatchID == req.BatchID {
				ev.Resolved = true
				ev.Resolution = req.Action
			}
		}
	}
	applyDeferredStatusLocked(o)
	pruneResolvedArbitrationLocked(o)
	o.UpdatedAt = now
	if err := e.store.Save(o); err != nil {
		e.mu.Unlock()
		return ControlResult{}, err
	}
	e.store.AppendLog(o.ID, LogEntry{Kind: "control", Batch: req.BatchID, Why: req.Action, Decision: result.Status})
	status := o.Status
	root := workspaceRoot(o)
	summary := summarizeOrchestration(o)
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": root, "orchestrationId": o.ID, "status": status, "summary": summary})
	if req.Action == "resume" || req.Action == "retry" || req.Action == "skip" || req.Action == "update_batch" {
		e.scheduleTick()
	}
	result.Status = status
	return result, nil
}

func batchTerminalOrIdle(o *Orchestration) bool {
	switch o.Status {
	case StatusDone, StatusFailed, StatusStopped, StatusFault:
		return true
	}
	return false
}

func (e *Engine) stopLocked(o *Orchestration, now int64) {
	o.Status = StatusStopped
	freezeDeadlinesLocked(o)
	sessions := make([]string, 0, len(o.Batches))
	for i := range o.Batches {
		b := &o.Batches[i]
		if b.SessionID != "" {
			sessions = append(sessions, b.SessionID)
		}
		switch b.Status {
		case BatchRunning, BatchDispatched, BatchReviewing, BatchVerifying, BatchPending:
			b.Status = BatchCancelled
			b.SessionID = ""
			b.Deadline, b.Frozen, b.Question, b.AwaitingUntil = 0, false, nil, 0
		}
	}
	for tok, tk := range e.tickets {
		if tk.OrchestrationID == o.ID {
			delete(e.tickets, tok)
		}
	}
	for tok, cl := range e.claims {
		if cl.OrchestrationID == o.ID {
			delete(e.claims, tok)
		}
	}
	payload := map[string]any{
		"root": workspaceRoot(o), "orchestrationId": o.ID, "sessionIds": sessions,
	}
	go e.emit(stopEventName, payload)
	e.store.AppendLog(o.ID, LogEntry{Kind: "stop", Why: "统一停止：票据已吊销，待确认停止的会话 " + strings.Join(sessions, ", ")})
}

func dependsOnID(b *Batch, id string) bool {
	for _, dep := range b.DependsOn {
		if dep == id {
			return true
		}
	}
	return false
}

func findArbitrationEvent(o *Orchestration, id string) *ArbitrationEvent {
	for i := range o.ArbitrationQueue {
		if o.ArbitrationQueue[i].EventID == id {
			return &o.ArbitrationQueue[i]
		}
	}
	return nil
}

// SetArbiter 前端创建好新仲裁会话后回填（交接）。
func (e *Engine) SetArbiter(id, sessionID, reason string) error {
	if strings.TrimSpace(sessionID) == "" {
		return fmt.Errorf("新仲裁会话 id 不能为空")
	}
	e.mu.Lock()
	o := e.items[id]
	if o == nil {
		e.mu.Unlock()
		return fmt.Errorf("编排不存在")
	}
	now := nowMs()
	o.Arbiter.Handoffs = append(o.Arbiter.Handoffs, Handoff{From: o.Arbiter.SessionID, To: sessionID, At: now, Reason: reason})
	o.Arbiter.SessionID = sessionID
	o.Arbiter.Generation++
	o.Arbiter.AssignedAt = now
	o.Arbiter.Misses = 0
	o.UpdatedAt = now
	if err := e.store.Save(o); err != nil {
		e.mu.Unlock()
		return err
	}
	e.store.AppendLog(id, LogEntry{Kind: "arbiter-handoff", Why: reason, Decision: sessionID})
	summary := summarizeOrchestration(o)
	root, status := workspaceRoot(o), o.Status
	e.mu.Unlock()
	e.emit(changedEventName, map[string]any{"root": root, "orchestrationId": id, "status": status, "summary": summary})
	return nil
}

// ReportArbiterUsage 前端上报仲裁者上下文使用量；超过阈值只发交接请求，不静默换档。
func (e *Engine) ReportArbiterUsage(id, sessionID string, generation int, used, window int64) {
	if used <= 0 || window <= 0 {
		return
	}
	e.mu.Lock()
	o := e.items[id]
	if o == nil || o.Arbiter.SessionID != sessionID || (generation != 0 && generation != o.Arbiter.Generation) {
		e.mu.Unlock()
		return
	}
	o.Arbiter.ContextUsed, o.Arbiter.ContextWindow = used, window
	ratio := float64(used) / float64(window)
	o.UpdatedAt = nowMs()
	_ = e.store.Save(o)
	reason := ""
	if ratio > o.Policy.ArbiterRotateAt {
		reason = fmt.Sprintf("仲裁者上下文使用率 %.0f%% 超过阈值 %.0f%%", ratio*100, o.Policy.ArbiterRotateAt*100)
	}
	payload := map[string]any{
		"root": workspaceRoot(o), "orchestrationId": id, "sessionId": sessionID,
		"generation": o.Arbiter.Generation, "used": used, "window": window, "reason": reason,
	}
	e.mu.Unlock()
	if reason != "" {
		e.emit(handoffEventName, payload)
	}
}

func statusLabelForNotice(status string) string {
	switch status {
	case StatusAwaitingUser:
		return "在等你回答"
	case StatusBlocked:
		return "已阻塞"
	case StatusFault:
		return "已进入故障态"
	}
	return status
}

func (e *Engine) notify(title, body, payload string) {
	if e.deps.Notify != nil {
		e.deps.Notify(title, body, payload)
	}
}

func (e *Engine) emit(name string, payload any) {
	if e.deps.Emit != nil {
		e.deps.Emit(name, payload)
	}
}

// Delete 删除终态编排记录；不删会话、不回滚改动。
func (e *Engine) Delete(id, workspace string) error {
	return e.deleteWithAuth(id, workspace, false)
}

func (e *Engine) deleteWithAuth(id, workspace string, _ bool) error {
	e.mu.Lock()
	o := e.items[id]
	if o == nil {
		e.mu.Unlock()
		return fmt.Errorf("编排不存在")
	}
	if workspace != "" && cleanAbs(workspace) != cleanAbs(workspaceRoot(o)) {
		e.mu.Unlock()
		return fmt.Errorf("编排属于其它工作区")
	}
	if !batchTerminalOrIdle(o) {
		e.mu.Unlock()
		return fmt.Errorf("只能删除已结束的编排")
	}
	delete(e.items, id)
	e.mu.Unlock()
	return e.store.Delete(id)
}

// PendingArbitration 返回未解决事件数（测试/看板）。
func (e *Engine) PendingArbitration(id string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	o := e.items[id]
	if o == nil {
		return 0
	}
	n := 0
	for _, ev := range o.ArbitrationQueue {
		if !ev.Resolved {
			n++
		}
	}
	return n
}
