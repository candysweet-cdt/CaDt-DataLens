// machine.go：Router 的纯状态判定（不碰磁盘、不发事件），也是 dry-run 的唯一实现基础。
// 所有拿不准的情况都必须落回 awaiting_arbitration——这里没有模型，也不允许“猜”。
package orchestration

import (
	"fmt"
	"sort"
	"strings"
)

// ===== 计划校验与环检测 =====
// ValidatePlan 整份重验不可信草稿；返回归一化后的计划与错误列表。
func ValidatePlan(req PlanRequest) (*PlanRequest, []string) {
	var errs []string
	add := func(format string, args ...any) { errs = append(errs, fmt.Sprintf(format, args...)) }
	if strings.TrimSpace(req.Title) == "" {
		add("编排标题不能为空")
	}
	if len([]rune(req.Title)) > 200 {
		add("编排标题过长（上限 200 字）")
	}
	if strings.TrimSpace(req.Goal) == "" {
		add("总目标 goal 不能为空")
	}
	if len([]rune(req.Goal)) > 4000 {
		add("总目标 goal 过长（上限 4000 字）")
	}
	if strings.TrimSpace(req.Workspace) == "" {
		add("缺少归属工作区")
	}
	if strings.TrimSpace(req.ParentSessionID) == "" {
		add("缺少发起会话 parentSessionId")
	}
	if len(req.Batches) == 0 {
		add("至少需要一个批次")
	}
	if len(req.Batches) > MaxWorkBatches {
		add("批次过多：%d（上限 %d）", len(req.Batches), MaxWorkBatches)
	}
	policy := defaultPolicy(req.Policy)
	// 逐批审查已取消：质量门只由全部收尾后的终审统一做。字段保留仅为旧存档 / 旧前端兼容，
	// 一律在入口强制关掉，避免有人绕过前端把已删除的执行路径重新打开。
	policy.Review = false
	if policy.Scope != "read" && policy.Scope != "edit" && policy.Scope != "auto" && policy.Scope != "full" {
		add("执行会话权限档无效：%q", policy.Scope)
	}
	if policy.MaxParallel < 1 || policy.MaxParallel > 8 {
		add("并发批次数必须在 1–8 之间")
	}
	if policy.MaxAttemptsPerBatch < 1 || policy.MaxAttemptsPerBatch > MaxAttemptsHard {
		add("单批尝试上限必须在 1–%d 之间", MaxAttemptsHard)
	}
	if policy.BatchTimeoutMs > MaxBatchTimeoutMs {
		add("单批超时不能超过 %d 分钟", MaxBatchTimeoutMs/60000)
	}
	maxBatchTimeout := policy.BatchTimeoutMs
	for i := range req.Batches {
		b := &req.Batches[i]
		if strings.TrimSpace(b.ID) == "" || !validID(b.ID) {
			add("第 %d 批缺少合法 id（字母数字 ._-，≤64）", i+1)
		}
		if strings.TrimSpace(b.Title) == "" {
			add("批次 %s 缺少标题", b.ID)
		}
		if len([]rune(b.Title)) > 200 {
			add("批次 %s 标题过长（上限 200 字）", b.ID)
		}
		if strings.TrimSpace(b.Spec) == "" {
			add("批次 %s 缺少 spec", b.ID)
		}
		if len([]rune(b.Spec)) > 50000 {
			add("批次 %s 的 spec 过长（上限 50000 字）", b.ID)
		}
		if b.TimeoutMs < 0 || b.TimeoutMs > MaxBatchTimeoutMs {
			add("批次 %s 的超时必须在 0–%d ms 之间", b.ID, MaxBatchTimeoutMs)
		}
		if b.TimeoutMs > maxBatchTimeout {
			maxBatchTimeout = b.TimeoutMs
		}
		owns, err := normalizeOwns(b.Owns)
		if err != nil {
			add("批次 %s：%v", b.ID, err)
		}
		b.Owns = owns
		if err := validateVerifySpecs(req.Workspace, b.Verify); err != nil {
			add("批次 %s：%v", b.ID, err)
		}
		for j := range b.Verify {
			if b.Verify[j].TimeoutMs <= 0 {
				b.Verify[j].TimeoutMs = DefaultVerifyTimeoutMs
			}
		}
	}
	// 唯一 id + 依赖存在 + 无环 + 只依赖 work 批次。
	ids := make(map[string]int, len(req.Batches))
	for i, b := range req.Batches {
		if _, dup := ids[b.ID]; dup {
			add("批次 id 重复：%s", b.ID)
		}
		ids[b.ID] = i
	}
	for _, b := range req.Batches {
		for _, dep := range b.DependsOn {
			if dep == b.ID {
				add("批次 %s 不能依赖自己", b.ID)
				continue
			}
			if _, ok := ids[dep]; !ok {
				add("批次 %s 依赖了不存在的批次 %s", b.ID, dep)
			}
		}
	}
	if cycle := findCycle(req.Batches, ids); len(cycle) > 0 {
		add("依赖成环：%s", strings.Join(cycle, " → "))
	}
	if policy.AuditIdleMs < 2*maxBatchTimeout {
		add("审计静默阈值必须 ≥ 2 × 最长批次超时（%d ms）", 2*maxBatchTimeout)
	}
	if policy.MaxWallMs < 0 || policy.MaxWallMs > MaxWallMsHard {
		add("编排最长运行时长必须在 0–24h 之间")
	}
	if len(policy.AllowedWorkerModels) > MaxAllowedWorkerModels {
		add("模型白名单最多 %d 条", MaxAllowedWorkerModels)
	}
	allowedModels := make(map[string]bool, len(policy.AllowedWorkerModels))
	cleanedModels := make([]string, 0, len(policy.AllowedWorkerModels))
	for _, ref := range policy.AllowedWorkerModels {
		ref = strings.TrimSpace(ref)
		if ref == "" || allowedModels[ref] {
			continue
		}
		allowedModels[ref] = true
		cleanedModels = append(cleanedModels, ref)
	}
	policy.AllowedWorkerModels = cleanedModels
	if policy.ReviewModel != "" && policy.AllowWorkerModels && !allowedModels[policy.ReviewModel] {
		add("审查模型 %s 不在白名单内", policy.ReviewModel)
	}
	if policy.FinalReviewModel != "" && policy.AllowWorkerModels && !allowedModels[policy.FinalReviewModel] {
		add("终审模型 %s 不在白名单内", policy.FinalReviewModel)
	}
	if policy.AllowWorkerModels {
		for _, b := range req.Batches {
			if b.Model.First != "" && !allowedModels[b.Model.First] {
				add("批次 %s 的模型 %s 不在白名单内", b.ID, b.Model.First)
			}
			if b.Model.Retry != "" && !allowedModels[b.Model.Retry] {
				add("批次 %s 的重派模型 %s 不在白名单内", b.ID, b.Model.Retry)
			}
		}
	} else {
		// 未授权时模型字段一律忽略（不是错误）；清掉避免落盘后看起来像已生效。
		for i := range req.Batches {
			req.Batches[i].Model = ModelSpec{}
		}
		// 清在 policy 副本上：下面 req.Policy = policy 会覆盖 req.Policy 上的清空。
		policy.ReviewModel = ""
		policy.FinalReviewModel = ""
	}
	req.Policy = policy
	return &req, errs
}

func findCycle(batches []BatchPlan, ids map[string]int) []string {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(batches))
	stack := make([]string, 0, len(batches))
	var visit func(id string) []string
	visit = func(id string) []string {
		color[id] = gray
		stack = append(stack, id)
		b := batches[ids[id]]
		for _, dep := range b.DependsOn {
			if _, ok := ids[dep]; !ok {
				continue
			}
			if color[dep] == gray {
				at := 0
				for i, s := range stack {
					if s == dep {
						at = i
						break
					}
				}
				return append(append([]string(nil), stack[at:]...), dep)
			}
			if color[dep] == white {
				if cyc := visit(dep); len(cyc) > 0 {
					return cyc
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[id] = black
		return nil
	}
	for _, b := range batches {
		if color[b.ID] == white {
			if cyc := visit(b.ID); len(cyc) > 0 {
				return cyc
			}
		}
	}
	return nil
}

// ===== 状态聚合与就绪批次 =====
// aggregateStatus 按固定优先级把批次状态聚合为编排状态。
func aggregateStatus(o *Orchestration) string {
	switch o.Status {
	case StatusPaused, StatusPausedNoWindow, StatusStopped, StatusFault:
		return o.Status
	}
	works := workBatches(o)
	if len(works) == 0 {
		return StatusFailed
	}
	allDone := true
	anyActive := false
	anyReady := false
	anyUser := false
	anyArbitration := false
	anyFailedOrBlocked := false
	anyPending := false
	anyBlockedByDep := false
	for _, b := range works {
		switch b.Status {
		case BatchDone, BatchSkipped:
		case BatchAwaitingUser:
			allDone = false
			anyUser = true
		case BatchBlocked, BatchFailed:
			allDone = false
			anyFailedOrBlocked = true
		case BatchCancelled:
			allDone = false
		case BatchPending:
			allDone = false
			anyPending = true
			for _, dep := range b.DependsOn {
				d := findBatch(o, dep)
				if d != nil && (d.Status == BatchFailed || d.Status == BatchBlocked || d.Status == BatchSkipped || d.Status == BatchCancelled) {
					anyBlockedByDep = true
				}
			}
		default:
			allDone = false
			if batchActive(b.Status) {
				anyActive = true
			}
		}
	}
	if allDone {
		if !o.Policy.FinalReview {
			return StatusDone
		}
		finals := finalReviewBatches(o)
		if len(finals) == 0 {
			// 巡检会创建终审批次；在此之前不能先报 done。
			return StatusRunning
		}
		finalsDone := true
		finalsBlocked := false
		for _, b := range finals {
			switch b.Status {
			case BatchDone, BatchSkipped:
			case BatchFailed, BatchBlocked:
				finalsDone = false
				finalsBlocked = true
			default:
				finalsDone = false
			}
		}
		if !finalsDone {
			if finalsBlocked {
				if hasUnresolvedArbitration(o) {
					return StatusAwaitingArbitration
				}
				return StatusBlocked
			}
			return StatusRunning
		}
		return StatusDone
	}
	if anyUser {
		return StatusAwaitingUser
	}
	for i := range o.ArbitrationQueue {
		if !o.ArbitrationQueue[i].Resolved {
			anyArbitration = true
			break
		}
	}
	if anyArbitration {
		return StatusAwaitingArbitration
	}
	if anyActive {
		return StatusRunning
	}
	// 已有依赖满足的 pending，则还能推进。
	for _, id := range readyBatchIDs(o, false) {
		if id != "" {
			anyReady = true
			break
		}
	}
	if anyReady {
		return StatusRunning
	}
	if anyPending && !anyFailedOrBlocked && !anyBlockedByDep {
		return StatusRunning
	}
	if anyFailedOrBlocked || anyBlockedByDep {
		// 事件已在 L2 阶段投递；事件被裁决关闭后仍停在 blocked，等用户/仲裁者选择重派/跳过。
		return StatusBlocked
	}
	if anyPending {
		return StatusBlocked
	}
	return StatusBlocked
}

func hasUnresolvedArbitration(o *Orchestration) bool {
	for i := range o.ArbitrationQueue {
		if !o.ArbitrationQueue[i].Resolved {
			return true
		}
	}
	return false
}

// readyBatchIDs 返回当前可派发的批次（按计划顺序）。includeReviews=false 时只看 work。
// 规则：依赖已完成、无验证屏障、并发未满、owns 与在跑批次不相交。
func readyBatchIDs(o *Orchestration, includeReviews bool) []string {
	out := make([]string, 0, 4)
	maxParallel := o.Policy.MaxParallel
	if maxParallel <= 0 {
		maxParallel = DefaultMaxParallel
	}
	active := 0
	activeOwns := make([][]string, 0, maxParallel)
	barrier := false
	reviewingWork := make(map[string]bool)
	for i := range o.Batches {
		b := &o.Batches[i]
		if b.Status == BatchVerifying {
			barrier = true
		}
		if b.Status == BatchReviewing {
			reviewingWork[b.ID] = true
		}
		// reviewing 是被动等待审查，不占并发执行槽；它与 verifying 仍由 barrier 管住。
		if batchActive(b.Status) && b.Status != BatchReviewing {
			active++
			if b.Kind != KindReview {
				activeOwns = append(activeOwns, b.Owns)
			}
		}
	}
	if active >= maxParallel {
		return out
	}
	reviewBarrier := len(reviewingWork) > 0
	for i := range o.Batches {
		b := &o.Batches[i]
		if active >= maxParallel {
			break
		}
		if b.Status != BatchPending {
			continue
		}
		limit := effectiveMaxAttempts(o)
		if b.Kind == KindReview {
			limit = DefaultReviewAttempts
		}
		if b.Attempts >= limit {
			continue
		}
		if b.Kind == KindReview && b.FinalReview {
			if !includeReviews || !b.Activated {
				continue
			}
			// 终审是「全部 work 收尾后」的独立阶段，没有逐批审查需要等。
			if !allWorkDoneOrSkipped(o) {
				continue
			}
		} else if barrier || reviewBarrier {
			continue
		}
		ok := true
		for _, dep := range b.DependsOn {
			depB := findBatch(o, dep)
			// skipped 不满足依赖：跳过上游是显式决定，下游必须交仲裁者重新判断，
			// 不能悄悄继续跑（方案 §5.3 的「上游被 skip 的 pending」→ blocked）。
			if depB == nil || depB.Status != BatchDone {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		intersect := false
		for _, other := range activeOwns {
			if ownsIntersect(b.Owns, other) {
				intersect = true
				break
			}
		}
		if intersect {
			continue
		}
		out = append(out, b.ID)
		active++
		if b.Kind != KindReview {
			activeOwns = append(activeOwns, b.Owns)
		}
	}
	return out
}

// ===== 截止时间与延迟状态 =====
// freezeDeadlinesLocked 把在跑批次的剩余时限冻结（暂停/等待/无窗口时）。
func freezeDeadlinesLocked(o *Orchestration) {
	now := nowMs()
	for i := range o.Batches {
		b := &o.Batches[i]
		if b.Status != BatchRunning && b.Status != BatchReviewing {
			continue
		}
		if b.Frozen {
			continue
		}
		if b.Deadline > 0 {
			remaining := b.Deadline - now
			if remaining < 0 {
				remaining = 0
			}
			b.RemainingMs = remaining
		}
		b.Frozen = true
		b.Deadline = 0
	}
}

// resumeDeadlinesLocked 恢复被冻结的时限；新会话的 deadline 已在 StartBatch 重设。
func resumeDeadlinesLocked(o *Orchestration) {
	now := nowMs()
	for i := range o.Batches {
		b := &o.Batches[i]
		if !b.Frozen {
			continue
		}
		b.Frozen = false
		if b.Status != BatchRunning && b.Status != BatchReviewing {
			continue
		}
		if b.RemainingMs > 0 {
			b.Deadline = now + b.RemainingMs
		} else {
			b.Deadline = now + effectiveTimeout(o, b)
		}
		b.RemainingMs = 0
	}
}

// applyDeferredStatusLocked 在聚合状态切换时冻结/恢复时限。
func applyDeferredStatusLocked(o *Orchestration) {
	next := aggregateStatus(o)
	waiting := next == StatusPaused || next == StatusPausedNoWindow || next == StatusStopped ||
		next == StatusAwaitingUser || next == StatusAwaitingArbitration || next == StatusBlocked || next == StatusFault
	if waiting {
		freezeDeadlinesLocked(o)
	} else if next == StatusRunning {
		resumeDeadlinesLocked(o)
	}
	o.Status = next
	o.UpdatedAt = nowMs()
}

// ===== 护栏与上游摘要 =====
// guardrailProblem 纯数值护栏；返回非空表示必须停止派发并交人。
func guardrailProblem(o *Orchestration) string {
	if len(workBatches(o)) > MaxWorkBatches {
		return fmt.Sprintf("批次总数超过硬上限 %d", MaxWorkBatches)
	}
	if o.Stats.Rounds > MaxRoundsHard || (o.Policy.MaxTotalRounds > 0 && o.Stats.Rounds > o.Policy.MaxTotalRounds) {
		return "总轮次超过上限"
	}
	if o.Policy.MaxWallMs > 0 && nowMs()-o.CreatedAt > o.Policy.MaxWallMs {
		return "编排运行时长超过上限"
	}
	if o.Policy.BudgetTokens > 0 && o.Stats.TokensUsed > o.Policy.BudgetTokens {
		return "token 预算已用尽（事后熔断，不再派发新批次）"
	}
	now := nowMs()
	cutoff := now - 10*60*1000
	recent := 0
	for _, ts := range o.Stats.DispatchTimes {
		if ts >= cutoff {
			recent++
		}
	}
	if recent >= MaxDispatchPer10Min {
		return "10 分钟内派发次数超过硬上限（疑似状态机死循环）"
	}
	for _, b := range workBatches(o) {
		if b.Attempts > effectiveMaxAttempts(o) {
			return fmt.Sprintf("批次 %s 的尝试次数超过上限", b.ID)
		}
	}
	return ""
}

// pruneDispatchTimes 只保留 10 分钟滚动窗口。
func pruneDispatchTimes(o *Orchestration) {
	cutoff := nowMs() - 10*60*1000
	out := o.Stats.DispatchTimes[:0]
	for _, ts := range o.Stats.DispatchTimes {
		if ts >= cutoff {
			out = append(out, ts)
		}
	}
	o.Stats.DispatchTimes = out
}

// summarizeUpstream 只为直接依赖生成上游摘要（≤1200 字）。
func summarizeUpstream(o *Orchestration, b *Batch) string {
	if len(b.DependsOn) == 0 {
		return ""
	}
	var lines []string
	total := 0
	for _, depID := range b.DependsOn {
		dep := findBatch(o, depID)
		if dep == nil {
			continue
		}
		notes := ""
		if dep.Report != nil {
			notes = strings.TrimSpace(dep.Report.Notes)
		}
		files := summarizeWriteDirs(dep.WriteLog, 200)
		line := fmt.Sprintf("- %s「%s」%s\n  · 改了：%s\n  · 关键结论：%s",
			dep.ID, dep.Title, dep.Status, files, truncateRunes(notes, 300))
		if dep.Report != nil && strings.TrimSpace(dep.Report.BlockingIssue) != "" {
			line += "\n  · 遗留：" + truncateRunes(dep.Report.BlockingIssue, 200)
		}
		add := len([]rune(line))
		if total+add > MaxUpstreamSummaryChars {
			break
		}
		lines = append(lines, line)
		total += add
	}
	return strings.Join(lines, "\n")
}

// ===== 派单提示词构造 =====
// buildDispatchPrompt 拼派单首轮消息：本批 spec + 上游摘要 + 上一轮回顾 + 约束。
func buildDispatchPrompt(o *Orchestration, b *Batch) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "【本批任务】\n%s\n", b.Spec)
	if up := summarizeUpstream(o, b); up != "" {
		fmt.Fprintf(&sb, "\n【上游已完成】（自动注入，只含直接依赖）\n%s\n", up)
	}
	if b.Attempts > 0 && b.FailureReason != "" {
		var last *HistoryEntry
		if len(b.History) > 0 {
			last = &b.History[len(b.History)-1]
		}
		fmt.Fprintf(&sb, "\n【上一轮回顾】（attempt %d 失败：%s）\n", b.Attempts, b.FailureReason)
		if last != nil {
			fmt.Fprintf(&sb, "- 结束状态：%s\n", last.Status)
			if len(last.Problems) > 0 {
				limit := len(last.Problems)
				if limit > 8 {
					limit = 8
				}
				for _, p := range last.Problems[:limit] {
					fmt.Fprintf(&sb, "- 问题：%s:%d %s\n", p.Path, p.Line, p.Problem)
				}
			}
			if last.Reason != "" {
				fmt.Fprintf(&sb, "- 原因：%s\n", truncateRunes(last.Reason, 300))
			}
		}
		fmt.Fprintf(&sb, "- 实际改了：%s\n", summarizeWriteDirs(b.WriteLog, 300))
		fmt.Fprintf(&sb, "- 本次要求：先处理上面失败的点，再继续；不要重复已成功的部分。\n")
	}
	if o.Policy.AutoRun {
		fmt.Fprintf(&sb, "\n【自主执行】本次编排为自主模式：禁止 awaiting_user；遇到取舍请自行决定并在 autonomousChoice 说明理由，或报 blocked。\n")
	}
	if b.UserAnswer != "" {
		fmt.Fprintf(&sb, "\n【用户回答】%s\n", b.UserAnswer)
	}
	if b.FinalReview {
		fmt.Fprintf(&sb, "\n【终审约束】\n- 只读；不得修改任何文件。\n- 审查范围：全部工作批次的 writeLog 与工作区当前内容的组合结果；不要把既有未提交改动归到本次编排。\n- 必须做反向验证：对「已修的接线类断言」，说明如果把实现删掉，这条测试会不会红。\n- 收尾必须调用 orchestration_report，并用 review 字段给出 blocking / shouldFix / suggestions。\n")
	} else if b.Kind == KindReview {
		fmt.Fprintf(&sb, "\n【审查约束】\n- 只读；不得修改任何文件。\n- 审查范围：被审查批次的 writeLog 与本轮工作区 diff；不要把既有未提交改动归到本批。\n- 必须做反向验证：对「已修的接线类断言」，说明如果把实现删掉，这条测试会不会红。\n- 收尾必须调用 orchestration_report，并用 review 字段给出 blocking / shouldFix / suggestions。\n")
	} else {
		if len(b.Owns) == 0 {
			fmt.Fprintf(&sb, "\n【约束】\n- 本批只读：只能产出结论，不能写文件。\n- 收尾必须调用 orchestration_report，否则编排器视为未完成。\n")
		} else {
			fmt.Fprintf(&sb, "\n【约束】\n- 只能写：%s\n- 收尾必须调用 orchestration_report，否则编排器视为未完成。\n", strings.Join(b.Owns, "、"))
		}
	}
	return sb.String()
}

// ===== 预演与批次工具 =====
// PlanDryRun 纯内存模拟：不写状态、不发事件、不建会话。只断言不变量，不追求与人工顺序一致。
func PlanDryRun(plan *PlanRequest) PlanPreview {
	preview := PlanPreview{
		Valid: true, Plan: plan, ReviewEnabled: plan.Policy.Review,
		FinalReviewEnabled: plan.Policy.FinalReview, FinalReviewCount: plan.Policy.FinalReviewCount,
	}
	clone := &Orchestration{
		Status:    StatusRunning,
		Policy:    plan.Policy,
		CreatedAt: nowMs(),
	}
	for _, bp := range plan.Batches {
		clone.Batches = append(clone.Batches, Batch{
			ID: bp.ID, Title: bp.Title, Kind: KindWork, Spec: bp.Spec,
			Owns: bp.Owns, DependsOn: bp.DependsOn, Verify: bp.Verify,
			TimeoutMs: bp.TimeoutMs, Model: bp.Model, Status: BatchPending,
		})
	}
	// owns 有交集的批次在预览里标出；不报错，实际执行时串行。
	for i := 0; i < len(plan.Batches); i++ {
		for j := i + 1; j < len(plan.Batches); j++ {
			if ownsIntersect(plan.Batches[i].Owns, plan.Batches[j].Owns) {
				preview.ForcedSerial = append(preview.ForcedSerial,
					plan.Batches[i].ID+" ↔ "+plan.Batches[j].ID)
			}
		}
	}
	guard := func() bool {
		active := 0
		for i := range clone.Batches {
			if batchActive(clone.Batches[i].Status) {
				active++
			}
		}
		return active <= clone.Policy.MaxParallel
	}
	waves := 0
	for waves < MaxWorkBatches*3 {
		ids := readyBatchIDs(clone, false)
		if len(ids) == 0 {
			// 模拟完成当前活动批次。真实执行这里还有 verify/审查，但 dry-run 只验证顺序与并发。
			progress := false
			for i := range clone.Batches {
				if clone.Batches[i].Status == BatchPending {
					continue
				}
				if batchActive(clone.Batches[i].Status) {
					clone.Batches[i].Status = BatchDone
					progress = true
				}
			}
			if !progress {
				break
			}
			continue
		}
		preview.Waves = append(preview.Waves, nil)
		waveIdx := len(preview.Waves) - 1
		for _, id := range ids {
			b := findBatch(clone, id)
			if b == nil {
				continue
			}
			b.Status = BatchRunning
			preview.Waves[waveIdx] = append(preview.Waves[waveIdx], id)
		}
		if !guard() {
			preview.Valid = false
			preview.Errors = append(preview.Errors, "dry-run 发现并发数超过上限")
			break
		}
		waves++
	}
	// 去掉末尾空 wave
	for len(preview.Waves) > 0 && len(preview.Waves[len(preview.Waves)-1]) == 0 {
		preview.Waves = preview.Waves[:len(preview.Waves)-1]
	}
	for i := range clone.Batches {
		if clone.Batches[i].Status != BatchDone {
			preview.Valid = false
			preview.Errors = append(preview.Errors, "dry-run 未能推进所有批次（依赖不可满足或存在死锁）")
			break
		}
	}
	if len(preview.Errors) > 0 {
		preview.Valid = false
	}
	if len(plan.Batches) == 0 {
		preview.Warnings = append(preview.Warnings, "没有任何批次")
	}
	verifyCount := 0
	for _, b := range plan.Batches {
		if len(b.Verify) > 0 {
			verifyCount++
		}
	}
	if verifyCount == 0 {
		preview.Warnings = append(preview.Warnings, "这些批次改完无法自动验收（没有配置 verify）")
	} else {
		preview.Warnings = append(preview.Warnings, "验收/审查期间启用静默屏障：停止派发新批次，等在跑 Worker 收手后再串行验收")
	}
	preview.AuditMinMs = 2 * maxBatchTimeout(plan)
	preview.Valid = preview.Valid && len(preview.Errors) == 0
	return preview
}

func maxBatchTimeout(plan *PlanRequest) int64 {
	max := plan.Policy.BatchTimeoutMs
	for _, b := range plan.Batches {
		if b.TimeoutMs > max {
			max = b.TimeoutMs
		}
	}
	return max
}

// batchIDsInOrder 计划顺序（仅用于稳定输出与测试）。
func batchIDsInOrder(o *Orchestration) []string {
	ids := make([]string, 0, len(o.Batches))
	for _, b := range o.Batches {
		ids = append(ids, b.ID)
	}
	sort.Strings(ids)
	return ids
}
