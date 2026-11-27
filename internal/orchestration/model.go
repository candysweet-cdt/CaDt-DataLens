// Package orchestration：按依赖图调度多个独立 AI 会话的确定性编排引擎。
//
// 分层固定为「仲裁者会话 → Router（本包，确定性代码）→ Worker 会话」：
//   - 本包不调用模型，不做语义判断；所有拿不准的情况一律上报 awaiting_arbitration；
//   - 状态真源是 <应用数据>/orchestrations/<id>.json（atomfile 原子写），日志是旁路 JSONL；
//   - 会话创建与起轮在前端，本包只通过 claim/start 两阶段握手签发一次性票据，
//     所有回调（事件、会话存在性、窗口可用性、验收执行器）由宿主注入。
//
// 与群聊/子代理的边界见 docs/finished-plans/orchestration.md §3。
package orchestration

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// 编排级状态（§4.2 / §5.3 的聚合口径）。
const (
	StatusPlanning            = "planning"
	StatusRunning             = "running"
	StatusPaused              = "paused"
	StatusPausedNoWindow      = "paused_no_window"
	StatusStopped             = "stopped"
	StatusAwaitingUser        = "awaiting_user"
	StatusAwaitingArbitration = "awaiting_arbitration"
	StatusBlocked             = "blocked"
	StatusDone                = "done"
	StatusFailed              = "failed"
	StatusFault               = "fault"
)

// 批次状态（§4.2 / §5.3）。
const (
	BatchPending      = "pending"
	BatchDispatched   = "dispatched"
	BatchRunning      = "running"
	BatchVerifying    = "verifying"
	BatchReviewing    = "reviewing"
	BatchDone         = "done"
	BatchFailed       = "failed"
	BatchBlocked      = "blocked"
	BatchAwaitingUser = "awaiting_user"
	BatchCancelled    = "cancelled"
	BatchSkipped      = "skipped"
)

// 失败分类（不是状态）。
const (
	ReasonNoReport          = "no_report"
	ReasonStalled           = "stalled"
	ReasonSessionGone       = "session_gone"
	ReasonVerifyFailed      = "verify_failed"
	ReasonReviewFailed      = "review_failed"
	ReasonReviewUnavailable = "review_unavailable"
	ReasonOverBudget        = "over_budget"
	ReasonBlockedByDep      = "blocked_by_dep"
	ReasonUserStopped       = "user_stopped"
)

// 批次类型与角色。
const (
	KindWork    = "work"
	KindReview  = "review"
	RoleWork    = "work"
	RoleReview  = "review"
	RoleArbiter = "arbiter"
)

// 默认策略参数。审批卡可覆盖，但硬上限在 Guardrails 里另有一道。
const (
	DefaultMaxParallel      = 2
	DefaultMaxAttempts      = 2
	DefaultBatchTimeoutMs   = 20 * 60 * 1000
	DefaultAuditIdleMs      = 2 * 60 * 60 * 1000
	DefaultArbiterTimeoutMs = 10 * 60 * 1000
	DefaultArbiterMissLimit = 2
	DefaultReviewAttempts   = 2
	ClaimTTL                = 90 * 1000
	TicketTTL               = 12 * 60 * 60 * 1000
	MaxWorkBatches          = 20
	MaxAttemptsHard         = 2
	MaxRoundsHard           = 200
	MaxDispatchPer10Min     = 12
	MaxWallMsHard           = 24 * 60 * 60 * 1000
	MaxAllowedWorkerModels  = 5
	MaxBatchTimeoutMs       = 2 * 60 * 60 * 1000
	DefaultVerifyTimeoutMs  = 5 * 60 * 1000
	MaxVerifyTimeoutMs      = 60 * 60 * 1000
	MaxUpstreamSummaryChars = 1200
	MaxRoleBriefChars       = 2000
)

// ===== 验证与策略类型 =====
// VerifySpec 验收命令：exe + argv，绝不走 shell 字符串。
type VerifySpec struct {
	File      string   `json:"file"`
	Args      []string `json:"args,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	TimeoutMs int64    `json:"timeoutMs,omitempty"`
}

// ModelSpec 批次模型分配；空串表示用审批时固定的 ArbiterModelRef。
type ModelSpec struct {
	First string `json:"first,omitempty"`
	Retry string `json:"retry,omitempty"`
}

// Policy 编排策略（审批卡提交并落盘）。
type Policy struct {
	Scope               string  `json:"scope"`
	MaxParallel         int     `json:"maxParallel"`
	MaxAttemptsPerBatch int     `json:"maxAttemptsPerBatch"`
	BudgetTokens        int64   `json:"budgetTokens,omitempty"`
	MaxTotalRounds      int     `json:"maxTotalRounds,omitempty"`
	MaxWallMs           int64   `json:"maxWallMs,omitempty"`
	BatchTimeoutMs      int64   `json:"batchTimeoutMs"`
	AuditIdleMs         int64   `json:"auditIdleMs"`
	ArbiterTimeoutMs    int64   `json:"arbiterTimeoutMs"`
	ArbiterMissLimit    int     `json:"arbiterMissLimit"`
	ArbiterRotateAt     float64 `json:"arbiterRotateAt"`
	Review              bool    `json:"review"`
	// ReviewExplicit 表示审批卡上确实动过审查开关；缺省 false 时审查门默认开（§5.5）。
	// 持久化后保留 true，避免重新读取状态时被「缺省开」再次覆盖用户选择。
	ReviewExplicit      bool     `json:"reviewExplicit,omitempty"`
	ReviewModel         string   `json:"reviewModel,omitempty"`
	EscalateOnRetry     bool     `json:"escalateOnRetry"`
	AllowWorkerModels   bool     `json:"allowWorkerModels"`
	AllowedWorkerModels []string `json:"allowedWorkerModels,omitempty"`
	AutoRun             bool     `json:"autoRun"`
	SnapshotBeforeStart bool     `json:"snapshotBeforeStart"`
}

// Question 等待用户回答时的问题（语义照 ask_user）。
type Question struct {
	Text          string   `json:"text"`
	Options       []Option `json:"options,omitempty"`
	TimeoutSec    int      `json:"timeoutSec,omitempty"`
	TimeoutAction string   `json:"timeoutAction,omitempty"` // recommended / wait / abort / ai_decide
}

// Option 用户可选答案。
type Option struct {
	Label       string `json:"label"`
	Recommended bool   `json:"recommended,omitempty"`
}

// ===== 审查与报告类型 =====
// ReviewIssue 审查问题项。
type ReviewIssue struct {
	Path    string `json:"path,omitempty"`
	Line    int    `json:"line,omitempty"`
	Problem string `json:"problem,omitempty"`
	Fix     string `json:"fix,omitempty"`
}

// ReviewPayload 审查批次回报的结论。
type ReviewPayload struct {
	Blocking    []ReviewIssue `json:"blocking,omitempty"`
	ShouldFix   []ReviewIssue `json:"shouldFix,omitempty"`
	Suggestions []ReviewIssue `json:"suggestions,omitempty"`
}

// Report 执行/审查会话的结构化回报。
type Report struct {
	BatchID          string         `json:"batchId"`
	ReportID         string         `json:"reportId"`
	Status           string         `json:"status"` // done / blocked / awaiting_user
	ChangedFiles     []string       `json:"changedFiles,omitempty"`
	VerifySelf       []VerifySelf   `json:"verifySelf,omitempty"`
	Notes            string         `json:"notes,omitempty"`
	BlockingIssue    string         `json:"blockingIssue,omitempty"`
	Question         *Question      `json:"question,omitempty"`
	AutonomousChoice string         `json:"autonomousChoice,omitempty"`
	Review           *ReviewPayload `json:"review,omitempty"`
	At               int64          `json:"at,omitempty"`
	Digest           string         `json:"digest,omitempty"`
}

// VerifySelf 执行者自述跑过的命令（证据，不是判决）。
type VerifySelf struct {
	Cmd      string `json:"cmd,omitempty"`
	ExitCode int    `json:"exitCode,omitempty"`
	Summary  string `json:"summary,omitempty"`
}

// ReportReceipt 同一 attempt 的幂等回执。
type ReportReceipt struct {
	Attempt  int    `json:"attempt"`
	ReportID string `json:"reportId"`
	Digest   string `json:"digest"`
	Result   string `json:"result"`
	At       int64  `json:"at"`
}

// WriteLogEntry 写闸实际放行的记录（审查与重派依据）。
type WriteLogEntry struct {
	Attempt int    `json:"attempt"`
	At      int64  `json:"at"`
	Path    string `json:"path"`
	Denied  bool   `json:"denied,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// HistoryEntry 一次尝试的摘要。
type HistoryEntry struct {
	Attempt          int           `json:"attempt"`
	SessionID        string        `json:"sessionId,omitempty"`
	Model            string        `json:"model,omitempty"`
	Status           string        `json:"status"`
	At               int64         `json:"at"`
	Problems         []ReviewIssue `json:"problems,omitempty"`
	ReportID         string        `json:"reportId,omitempty"`
	AutonomousChoice string        `json:"autonomousChoice,omitempty"`
	Reason           string        `json:"reason,omitempty"`
}

// ===== 批次与编排状态类型 =====
// Batch 一个工作或审查批次。
type Batch struct {
	ID            string       `json:"id"`
	Title         string       `json:"title"`
	Kind          string       `json:"kind"`
	ReviewOf      string       `json:"reviewOf,omitempty"`
	Workspace     string       `json:"workspace"`
	Spec          string       `json:"spec"`
	Owns          []string     `json:"owns"`
	DependsOn     []string     `json:"dependsOn,omitempty"`
	Verify        []VerifySpec `json:"verify,omitempty"`
	TimeoutMs     int64        `json:"timeoutMs,omitempty"`
	Model         ModelSpec    `json:"model,omitempty"`
	Status        string       `json:"status"`
	FailureReason string       `json:"failureReason,omitempty"`

	SessionID    string `json:"sessionId,omitempty"`
	Attempts     int    `json:"attempts"`
	DispatchAt   int64  `json:"dispatchAt,omitempty"`
	ClaimedBy    string `json:"claimedBy,omitempty"`
	ClaimedAt    int64  `json:"claimedAt,omitempty"`
	DispatchedAt int64  `json:"dispatchedAt,omitempty"`
	Deadline     int64  `json:"deadline,omitempty"`
	RemainingMs  int64  `json:"remainingMs,omitempty"`
	Frozen       bool   `json:"frozen,omitempty"`

	WriteLog []WriteLogEntry `json:"writeLog,omitempty"`
	Report   *Report         `json:"report,omitempty"`
	History  []HistoryEntry  `json:"history,omitempty"`

	Question       *Question       `json:"question,omitempty"`
	AwaitingUntil  int64           `json:"awaitingUntil,omitempty"`
	UserAnswer     string          `json:"userAnswer,omitempty"`
	Review         *ReviewPayload  `json:"review,omitempty"`
	ReviewAttempts int             `json:"reviewAttempts,omitempty"`
	Receipts       []ReportReceipt `json:"receipts,omitempty"`
	Activated      bool            `json:"activated,omitempty"`
}

// Arbiter 可交接的仲裁角色，不是发起会话本身。
type Arbiter struct {
	SessionID     string    `json:"sessionId"`
	Generation    int       `json:"generation"`
	AssignedAt    int64     `json:"assignedAt"`
	Handoffs      []Handoff `json:"handoffs,omitempty"`
	ContextUsed   int64     `json:"contextUsed,omitempty"`
	ContextWindow int64     `json:"contextWindow,omitempty"`
	Misses        int       `json:"misses,omitempty"`
}

// Handoff 一次仲裁者交接记录。
type Handoff struct {
	From   string `json:"from"`
	To     string `json:"to"`
	At     int64  `json:"at"`
	Reason string `json:"reason"`
}

// SnapshotInfo 开始前快照结果（仅作人工后路，不自动回滚）。
type SnapshotInfo struct {
	At       int64  `json:"at"`
	Mode     string `json:"mode,omitempty"`
	Name     string `json:"name,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
	Excluded string `json:"excluded,omitempty"`
}

// Stats 编排累计计数；DispatchTimes 只保留滚动窗口，避免无界增长。
type Stats struct {
	Dispatched    int     `json:"dispatched"`
	Done          int     `json:"done"`
	Failed        int     `json:"failed"`
	Rework        int     `json:"rework"`
	TokensUsed    int64   `json:"tokensUsed"`
	WallMs        int64   `json:"wallMs"`
	Rounds        int     `json:"rounds"`
	DispatchTimes []int64 `json:"dispatchTimes,omitempty"`
}

// ArbitrationEvent 待仲裁事件：先持久化，唤醒只是通知手段。
type ArbitrationEvent struct {
	EventID    string `json:"eventId"`
	BatchID    string `json:"batchId"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	LastPokeAt int64  `json:"lastPokeAt,omitempty"`
	Resolved   bool   `json:"resolved,omitempty"`
	Resolution string `json:"resolution,omitempty"`
}

// AuditInfo 审计者可见的两个时间戳与报警记录。
type AuditInfo struct {
	LastProgressAt int64          `json:"lastProgressAt,omitempty"`
	LastAuditAt    int64          `json:"lastAuditAt,omitempty"`
	Anomalies      []AuditAnomaly `json:"anomalies,omitempty"`
}

// AuditAnomaly 一次审计异常（只记录，不修改业务状态）。
type AuditAnomaly struct {
	At     int64  `json:"at"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// Orchestration 编排真源。
type Orchestration struct {
	ID               string             `json:"id"`
	Title            string             `json:"title"`
	Goal             string             `json:"goal"`
	Workspaces       []string           `json:"workspaces"`
	ParentSessionID  string             `json:"parentSessionId"`
	GroupSnapshot    string             `json:"groupSnapshot,omitempty"`
	ArbiterModelRef  string             `json:"arbiterModelRef,omitempty"`
	Arbiter          Arbiter            `json:"arbiter"`
	Snapshot         *SnapshotInfo      `json:"snapshot,omitempty"`
	CreatedAt        int64              `json:"createdAt"`
	UpdatedAt        int64              `json:"updatedAt"`
	Status           string             `json:"status"`
	Policy           Policy             `json:"policy"`
	Batches          []Batch            `json:"batches"`
	Stats            Stats              `json:"stats"`
	ArbitrationQueue []ArbitrationEvent `json:"arbitrationQueue,omitempty"`
	Audit            AuditInfo          `json:"audit,omitempty"`
}

// ===== 请求与结果类型 =====
// PlanRequest 审批卡提交的不可信草稿（Go 侧必须整份重验）。
type PlanRequest struct {
	Title            string      `json:"title"`
	Goal             string      `json:"goal"`
	Workspace        string      `json:"workspace,omitempty"`
	ParentSessionID  string      `json:"parentSessionId"`
	GroupSnapshot    string      `json:"groupSnapshot,omitempty"`
	ArbiterSessionID string      `json:"arbiterSessionId,omitempty"`
	ArbiterModelRef  string      `json:"arbiterModelRef,omitempty"`
	Policy           Policy      `json:"policy"`
	Batches          []BatchPlan `json:"batches"`
}

// BatchPlan 计划里的工作批次。
type BatchPlan struct {
	ID        string       `json:"id"`
	Title     string       `json:"title"`
	Spec      string       `json:"spec"`
	Owns      []string     `json:"owns"`
	DependsOn []string     `json:"dependsOn"`
	Verify    []VerifySpec `json:"verify"`
	TimeoutMs int64        `json:"timeoutMs,omitempty"`
	Model     ModelSpec    `json:"model,omitempty"`
}

// Summary 列表项（不携带批次正文）。
type Summary struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Goal            string `json:"goal"`
	Workspace       string `json:"workspace"`
	ParentSessionID string `json:"parentSessionId"`
	Status          string `json:"status"`
	TotalWork       int    `json:"totalWork"`
	DoneWork        int    `json:"doneWork"`
	FailedWork      int    `json:"failedWork"`
	CreatedAt       int64  `json:"createdAt"`
	UpdatedAt       int64  `json:"updatedAt"`
	HasAttention    bool   `json:"hasAttention"`
}

// StatusView 看板/工具查询的详情视图。
type StatusView struct {
	Orchestration *Orchestration `json:"orchestration"`
	Batches       []Batch        `json:"batches"`
	RecentEvents  []LogEntry     `json:"recentEvents,omitempty"`
}

// LogEntry 决策与审计流水的一行。
type LogEntry struct {
	At       int64  `json:"at"`
	Kind     string `json:"kind"`
	Batch    string `json:"batch,omitempty"`
	Why      string `json:"why,omitempty"`
	Input    any    `json:"input,omitempty"`
	Decision string `json:"decision,omitempty"`
}

// ClaimResponse 认领结果。
type ClaimResponse struct {
	OK              bool   `json:"ok"`
	ClaimToken      string `json:"claimToken,omitempty"`
	OrchestrationID string `json:"orchestrationId,omitempty"`
	BatchID         string `json:"batchId,omitempty"`
	Attempt         int    `json:"attempt,omitempty"`
	Kind            string `json:"kind,omitempty"`
	ExpiresAt       int64  `json:"expiresAt,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

// StartRequest 起轮前确认。
type StartRequest struct {
	OrchestrationID string `json:"orchestrationId"`
	BatchID         string `json:"batchId"`
	ClaimToken      string `json:"claimToken"`
	SessionID       string `json:"sessionId"`
}

// StartResponse 起轮凭据与注入 prompt。
type StartResponse struct {
	ExecutionToken string `json:"executionToken"`
	Prompt         string `json:"prompt"`
	Model          string `json:"model,omitempty"`
	Scope          string `json:"scope"`
	BatchID        string `json:"batchId"`
	Attempt        int    `json:"attempt"`
	Kind           string `json:"kind,omitempty"`
	ReviewOf       string `json:"reviewOf,omitempty"`
}

// AbortRequest 起轮前基础设施失败的回滚。
type AbortRequest struct {
	OrchestrationID string `json:"orchestrationId"`
	BatchID         string `json:"batchId"`
	Token           string `json:"token"`
	Reason          string `json:"reason,omitempty"`
}

// ReportResult 回报受理结果。
type ReportResult struct {
	Accepted  bool   `json:"accepted"`
	Duplicate bool   `json:"duplicate,omitempty"`
	Message   string `json:"message,omitempty"`
}

// WriteResult 写闸结果。
type WriteResult struct {
	Allowed bool   `json:"allowed"`
	Rel     string `json:"rel,omitempty"`
	Message string `json:"message,omitempty"`
}

// ===== 控制与事件类型 =====
// ControlRequest 仲裁者控制动作（AI 工具，有副作用，必须审批）。
type ControlRequest struct {
	OrchestrationID string `json:"orchestrationId"`
	Action          string `json:"action"` // pause / resume / stop / skip / retry / update_batch / delete / answer / handoff / resolve_arbitration
	BatchID         string `json:"batchId,omitempty"`
	// ArbiterSessionID 由受信任的前端运行时自动附加，不写进 AI_TOOL_DEFS；
	// 模型看不到也填不了，避免会话伪造仲裁身份。
	ArbiterSessionID string     `json:"arbiterSessionId,omitempty"`
	Generation       int        `json:"generation,omitempty"`
	Batch            *BatchPlan `json:"batch,omitempty"`
	Answer           string     `json:"answer,omitempty"`
	ResetAttempts    bool       `json:"resetAttempts,omitempty"`
	ExpectedEventID  string     `json:"expectedEventId,omitempty"`
}

// UserControlRequest 看板按钮动作（可信窗口，不冒充仲裁者）。
type UserControlRequest struct {
	ControlRequest
}

// ControlResult 控制动作回执。
type ControlResult struct {
	OK      bool   `json:"ok"`
	Status  string `json:"status,omitempty"`
	Message string `json:"message,omitempty"`
}

// PlanPreview 审批卡预览结果。
type PlanPreview struct {
	Valid         bool         `json:"valid"`
	Errors        []string     `json:"errors,omitempty"`
	Warnings      []string     `json:"warnings,omitempty"`
	Plan          *PlanRequest `json:"plan,omitempty"`
	Waves         [][]string   `json:"waves,omitempty"`
	ForcedSerial  []string     `json:"forcedSerial,omitempty"`
	ReviewEnabled bool         `json:"reviewEnabled"`
	AuditMinMs    int64        `json:"auditMinMs"`
}

// CreateResult 创建回执。
type CreateResult struct {
	ID       string        `json:"id"`
	Status   string        `json:"status"`
	Snapshot *SnapshotInfo `json:"snapshot,omitempty"`
	Warning  string        `json:"warning,omitempty"`
}

// TurnEventRequest 前端宿主上报的回合生命周期事实。
type TurnEventRequest struct {
	Token  string `json:"token"`
	Kind   string `json:"kind"` // turn_started / turn_finished / turn_failed / waiting_user / waiting_approval
	Reason string `json:"reason,omitempty"`
}

// PlanInput 由 AI 工具提交的原始计划；全部字段视为不可信。
type PlanInput struct {
	Title   string      `json:"title"`
	Goal    string      `json:"goal"`
	Policy  Policy      `json:"policy"`
	Batches []BatchPlan `json:"batches"`
}

// ===== ID 与默认值工具 =====
func nowMs() int64 { return time.Now().UnixMilli() }

var idSafe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func validID(id string) bool { return idSafe.MatchString(strings.TrimSpace(id)) }

func newToken(prefix string) string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 在 Windows 上失败意味着系统 RNG 不可用；宁可拒绝也不发可预测票据。
		panic(fmt.Sprintf("orchestration: 安全随机数不可用：%v", err))
	}
	return prefix + hex.EncodeToString(buf)
}

func newEventID() string { return newToken("evt-") }

// defaultPolicy 填默认值；零值布尔保持 false（Review 由调用方显式给默认 true）。
func defaultPolicy(p Policy) Policy {
	if !p.ReviewExplicit {
		p.Review = true
	}
	if strings.TrimSpace(p.Scope) == "" {
		p.Scope = "edit"
	}
	if p.MaxParallel <= 0 {
		p.MaxParallel = DefaultMaxParallel
	}
	if p.MaxAttemptsPerBatch <= 0 {
		p.MaxAttemptsPerBatch = DefaultMaxAttempts
	}
	if p.BatchTimeoutMs <= 0 {
		p.BatchTimeoutMs = DefaultBatchTimeoutMs
	}
	if p.AuditIdleMs <= 0 {
		p.AuditIdleMs = DefaultAuditIdleMs
	}
	if p.ArbiterTimeoutMs <= 0 {
		p.ArbiterTimeoutMs = DefaultArbiterTimeoutMs
	}
	if p.ArbiterMissLimit <= 0 {
		p.ArbiterMissLimit = DefaultArbiterMissLimit
	}
	if p.ArbiterRotateAt <= 0 || p.ArbiterRotateAt >= 1 {
		p.ArbiterRotateAt = 0.7
	}
	if p.MaxTotalRounds <= 0 {
		p.MaxTotalRounds = MaxRoundsHard
	}
	if p.MaxWallMs <= 0 {
		p.MaxWallMs = MaxWallMsHard
	}
	return p
}

// ===== 批次查询与拷贝工具 =====
func batchActive(status string) bool {
	switch status {
	case BatchDispatched, BatchRunning, BatchVerifying, BatchReviewing:
		return true
	}
	return false
}

func batchTerminal(status string) bool {
	switch status {
	case BatchDone, BatchFailed, BatchSkipped, BatchCancelled:
		return true
	}
	return false
}

func effectiveTimeout(o *Orchestration, b *Batch) int64 {
	if b.TimeoutMs > 0 {
		return b.TimeoutMs
	}
	return o.Policy.BatchTimeoutMs
}

func effectiveMaxAttempts(o *Orchestration) int {
	max := o.Policy.MaxAttemptsPerBatch
	if max <= 0 {
		max = DefaultMaxAttempts
	}
	if max > MaxAttemptsHard {
		max = MaxAttemptsHard
	}
	return max
}

func workBatches(o *Orchestration) []*Batch {
	out := make([]*Batch, 0, len(o.Batches))
	for i := range o.Batches {
		if o.Batches[i].Kind != KindReview {
			out = append(out, &o.Batches[i])
		}
	}
	return out
}

func findBatch(o *Orchestration, id string) *Batch {
	for i := range o.Batches {
		if o.Batches[i].ID == id {
			return &o.Batches[i]
		}
	}
	return nil
}

func copyOrchestration(o *Orchestration) *Orchestration {
	if o == nil {
		return nil
	}
	clone := *o
	clone.Workspaces = append([]string(nil), o.Workspaces...)
	clone.Batches = append([]Batch(nil), o.Batches...)
	clone.ArbitrationQueue = append([]ArbitrationEvent(nil), o.ArbitrationQueue...)
	clone.Stats.DispatchTimes = append([]int64(nil), o.Stats.DispatchTimes...)
	clone.Audit.Anomalies = append([]AuditAnomaly(nil), o.Audit.Anomalies...)
	return &clone
}

func truncateRunes(text string, max int) string {
	runes := []rune(text)
	if max <= 0 || len(runes) <= max {
		return text
	}
	return string(runes[:max]) + "…"
}
