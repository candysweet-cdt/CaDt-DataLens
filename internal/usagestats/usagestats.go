// Package usagestats：AI 使用统计的派生事实库（<应用数据>/ai-usage.db，可随时删除重建）。
//
// 写入有两条路径：
//   - 主路径：前端在流结束（主会话 / 子代理 / 群聊）拿到 usage 时静默上报一条事实，失败只记日志；
//   - 兜底：按「字节偏移 + 文件大小/mtime」游标增量扫描会话 JSONL，只在用户打开统计面板
//     （或点刷新）时执行——不做启动回填、不做定时轮询，首次打开即历史回填。
//
// 事实永久保留：查询时间范围只是过滤条件，删会话/截断历史不回收已计入的消耗。
package usagestats

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/appdata"
)

const (
	// ai-usage.db：与 ai-index.db / ai-schedule.db 同级的派生库，删了按会话 JSONL 重建。
	usageDBFileName = "ai-usage.db"
	sessionsDirName = "ai-sessions"
	groupsDirName   = "ai-groups"
	sessionLogName  = "session.v1.jsonl"

	kindSession = "session"
	kindGroup   = "group"
	// 群聊的会话键前缀：与普通会话 id 空间隔离，统计里也能一眼看出是群聊。
	groupKeyPrefix = "group:"

	// 单条事实的约束：异常载荷不写库，避免一条脏数据撑爆聚合。
	maxSessionIDLen  = 128
	maxModelNameLen  = 200
	maxTokenPerField = int64(1) << 50
	unknownModelName = "未知模型"
)

// Logf 宿主注入诊断日志（main/logging.go 的 writeAppLog）；nil 时静默。
var Logf func(level, format string, args ...any)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

// Event 一条 assistant 回复的用量事实（库表 usage_events 的一行）。
type Event struct {
	ID               string `json:"id"`
	SessionID        string `json:"sessionId"`
	Ts               int64  `json:"ts"` // unix ms
	Model            string `json:"model"`
	ModelAccount     string `json:"modelAccount"`
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	TotalTokens      int64  `json:"totalTokens"`
	CachedTokens     int64  `json:"cachedTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	TurnMs           int64  `json:"turnMs"`  // 单轮耗时（assistant 消息的 turnMs，可为 0）
	ModelMs          int64  `json:"modelMs"` // 单次模型请求耗时（含首字等待）
	TtftMs           int64  `json:"ttftMs"`  // 首字延迟（请求发出 → 第一个 token）
	StatusCode       int    `json:"statusCode"`
}

// RecordInput 前端 AIUsageStatsRecord 的上报载荷。
type RecordInput struct {
	SessionID    string      `json:"sessionId"`
	MessageID    string      `json:"messageId"`
	Ts           int64       `json:"ts"`
	Model        string      `json:"model"`
	ModelAccount string      `json:"modelAccount"`
	TurnMs       int64       `json:"turnMs"`
	ModelMs      int64       `json:"modelMs"`
	TtftMs       int64       `json:"ttftMs"`
	StatusCode   int         `json:"statusCode"`
	Usage        *UsageField `json:"usage"`
}

// UsageField 与前端 assistant.usage 的字段一一对应。
type UsageField struct {
	PromptTokens     int64 `json:"promptTokens"`
	CompletionTokens int64 `json:"completionTokens"`
	TotalTokens      int64 `json:"totalTokens"`
	CachedTokens     int64 `json:"cachedTokens"`
	CacheWriteTokens int64 `json:"cacheWriteTokens"`
}

// Summary 顶部指标卡（全历史口径，与热力图同一份数据）。
type Summary struct {
	TotalTokens       int64  `json:"totalTokens"`
	PeakDayTokens     int64  `json:"peakDayTokens"`
	PeakDay           string `json:"peakDay"`
	LongestSessionMs  int64  `json:"longestSessionMs"` // 最长单轮耗时；无 turnMs 时回退会话首末跨度
	CurrentStreakDays int    `json:"currentStreakDays"`
	LongestStreakDays int    `json:"longestStreakDays"`
	ActiveDays        int    `json:"activeDays"`
	TotalSessions     int    `json:"totalSessions"`
	TotalRequests     int    `json:"totalRequests"`
	FirstDay          string `json:"firstDay"`
	LastDay           string `json:"lastDay"`
}

// HeatmapDay 热力图的一格（日级）。
type HeatmapDay struct {
	Date     string `json:"date"`
	Tokens   int64  `json:"tokens"`
	Requests int    `json:"requests"`
}

// Heatmap 连续日期序列；前端负责 53 周对齐与每日/每周/累计切换。
type Heatmap struct {
	StartDate string       `json:"startDate"`
	EndDate   string       `json:"endDate"`
	MaxTokens int64        `json:"maxTokens"`
	Days      []HeatmapDay `json:"days"`
}

// ModelTokens 某天某个模型的 token 数。
type ModelTokens struct {
	Model  string `json:"model"`
	Tokens int64  `json:"tokens"`
}

// DailyModel 每日按模型拆分（趋势图数据源）。
type DailyModel struct {
	Date   string        `json:"date"`
	Models []ModelTokens `json:"models"`
}

// ModelUsage 环形图与列表的一行（按查询范围聚合）。
type ModelUsage struct {
	Model        string  `json:"model"`
	Tokens       int64   `json:"tokens"`
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	Requests     int     `json:"requests"`
	Share        float64 `json:"share"`
}

// Snapshot 统计面板一次查询的完整结果。
// Summary/Heatmap 恒为全历史；DailyModelUsage/Models 按 Range 过滤。
// Error 只由绑定壳在查询失败时填入，引擎自身恒为空。
type Snapshot struct {
	GeneratedAt     int64        `json:"generatedAt"`
	Range           string       `json:"range"`
	Summary         Summary      `json:"summary"`
	Heatmap         Heatmap      `json:"heatmap"`
	DailyModelUsage []DailyModel `json:"dailyModelUsage"`
	Models          []ModelUsage `json:"models"`
	Error           string       `json:"error,omitempty"`
}

// RequestRow 请求日志的一行（一条 usage 事实的展示字段）。
type RequestRow struct {
	Ts               int64  `json:"ts"`
	Model            string `json:"model"`
	ModelAccount     string `json:"modelAccount"`
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	CachedTokens     int64  `json:"cachedTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	ModelMs          int64  `json:"modelMs"`
	TtftMs           int64  `json:"ttftMs"`
	StatusCode       int    `json:"statusCode"`
}

// RequestPage 请求日志分页结果；Total 是全部历史条数。
type RequestPage struct {
	Items  []RequestRow `json:"items"`
	Total  int64        `json:"total"`
	Offset int          `json:"offset"`
	Limit  int          `json:"limit"`
	Error  string       `json:"error,omitempty"`
}

var (
	mu       sync.RWMutex
	dbHandle *sql.DB
	// syncMu 串行化本进程的扫描（打开面板与刷新按钮可能撞车）。
	syncMu sync.Mutex
	// dataRoot 应用数据根；测试替换（默认 appdata.Root）。
	dataRoot = appdata.Root
)

// Path 返回派生库路径；应用数据目录不可用时为空。
func Path() string {
	root := dataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, usageDBFileName)
}

// Start 初始化派生库（建表）。不启动任何后台扫描：兜底同步只在用户打开统计面板
// 或点刷新时由前端调用 SyncAll 触发。
func Start() {
	if err := ensureDB(); err != nil {
		logf("warn", "AI 使用统计初始化失败: %v", err)
	}
}

// Close 释放库句柄（设置 → 存储与清理删 ai-usage.db 前调用）。
// 关闭必须在写锁内完成：withDB 的读者持读锁跑完整个操作，Close 等它们结束再关，
// 否则会出现「取到句柄 → 连接已关 → Exec 报 database is closed」，
// 而子代理用量只存在这个库里（不可重建），一丢就是永久丢失。
func Close() {
	mu.Lock()
	defer mu.Unlock()
	if dbHandle != nil {
		_ = dbHandle.Close()
		dbHandle = nil
	}
}

// Record 写入一条前端上报的用量事实（幂等，失败只记日志由绑定层吞掉）。
func Record(payloadJSON string) error {
	var in RecordInput
	if err := json.Unmarshal([]byte(payloadJSON), &in); err != nil {
		return fmt.Errorf("载荷不是合法 JSON: %w", err)
	}
	ev, err := eventFromInput(in)
	if err != nil {
		return err
	}
	return upsertEvent(ev)
}

// LoadSnapshot 按查询范围返回统计快照（只读库，不触发扫描）。
func LoadSnapshot(rangeKey string) (Snapshot, error) {
	events, err := loadEvents()
	if err != nil {
		return Snapshot{}, err
	}
	return buildSnapshot(events, rangeKey, time.Now()), nil
}

// LoadRequests 按时间倒序分页读取请求日志（只读库，不触发扫描）。
func LoadRequests(offset, limit int) (RequestPage, error) {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 200 {
		limit = 200
	}
	items, total, err := loadRequestRows(offset, limit)
	if err != nil {
		return RequestPage{}, err
	}
	return RequestPage{Items: items, Total: total, Offset: offset, Limit: limit}, nil
}

// SyncAll 增量扫描全部会话/群聊 JSONL（首次即历史回填），只在打开统计面板或点刷新时调用。
func SyncAll() error {
	if err := ensureDB(); err != nil {
		return err
	}
	syncMu.Lock()
	defer syncMu.Unlock()
	// 一轮只做「1 次游标查询 + N 次 stat」：没变化的文件直接跳过，不读内容。
	states, err := loadSyncStates()
	if err != nil {
		return err
	}
	logs := collectSessionLogs()
	found := make(map[string]bool, len(logs))
	imported := 0
	failed := 0
	var firstErr error
	for _, item := range logs {
		found[item.ID] = true
		n, err := syncSessionLog(item, states)
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", item.ID, err)
			}
			logf("warn", "AI 使用统计扫描失败（%s）: %v", item.ID, err)
			continue
		}
		imported += n
	}
	pruneSyncStates(found)
	if imported > 0 {
		logf("info", "AI 使用统计增量导入 %d 条用量事实", imported)
	}
	if firstErr != nil {
		return fmt.Errorf("%d 个会话扫描失败（首个：%w）", failed, firstErr)
	}
	return nil
}

// eventFromInput 把上报载荷归一成事实（纯函数，供测试）。
func eventFromInput(in RecordInput) (Event, error) {
	sessionID := strings.TrimSpace(in.SessionID)
	if sessionID == "" || len(sessionID) > maxSessionIDLen {
		return Event{}, errors.New("sessionId 为空或过长")
	}
	if in.Usage == nil {
		return Event{}, errors.New("usage 为空")
	}
	ts := in.Ts
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	} else if ts < 1e12 {
		ts *= 1000 // 兼容秒级时间戳
	}
	model := clampText(strings.TrimSpace(in.Model), maxModelNameLen)
	if model == "" {
		model = unknownModelName
	}
	ev := Event{
		SessionID:        sessionID,
		Ts:               ts,
		Model:            model,
		ModelAccount:     clampText(strings.TrimSpace(in.ModelAccount), maxModelNameLen),
		PromptTokens:     clampTokens(in.Usage.PromptTokens),
		CompletionTokens: clampTokens(in.Usage.CompletionTokens),
		TotalTokens:      clampTokens(in.Usage.TotalTokens),
		CachedTokens:     clampTokens(in.Usage.CachedTokens),
		CacheWriteTokens: clampTokens(in.Usage.CacheWriteTokens),
		TurnMs:           clampTokens(in.TurnMs),
		ModelMs:          clampTokens(in.ModelMs),
		TtftMs:           clampTokens(in.TtftMs),
		StatusCode:       clampStatusCode(in.StatusCode),
	}
	if ev.TotalTokens <= 0 {
		ev.TotalTokens = ev.PromptTokens + ev.CompletionTokens
	}
	// 幂等键：默认「会话 + 消息时间戳」，与 JSONL 兜底扫描一致。
	// 群聊传 messageId（消息 gid）时优先用它——gid 是持久化的稳定 id，
	// 不依赖 ts 精度，主路径与扫描侧仍能对齐到同一行。
	if messageID := clampText(strings.TrimSpace(in.MessageID), 256); messageID != "" {
		ev.ID = sessionID + ":" + messageID
	} else {
		ev.ID = fmt.Sprintf("%s:%d", sessionID, ts)
	}
	return ev, nil
}

func clampTokens(v int64) int64 {
	if v <= 0 {
		return 0
	}
	if v > maxTokenPerField {
		return maxTokenPerField
	}
	return v
}

// clampStatusCode 只接受 HTTP 状态码范围；0 表示「未记录」。
func clampStatusCode(v int) int {
	if v < 100 || v > 599 {
		return 0
	}
	return v
}

func clampText(v string, max int) string {
	if len(v) <= max {
		return v
	}
	// 按字节截断可能切开多字节字符；模型名以 ASCII 为主，回退到合法前缀即可。
	return strings.ToValidUTF8(v[:max], "")
}
