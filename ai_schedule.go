package main

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// AI 定时任务（v2 功能 C）：调度器在 Go 侧（不受 Chromium 对后台页面的 timer 节流影响），
// 任务定义与运行状态存派生 SQLite（ai-schedule.db，modernc pure Go，可随时删除重建）；
// 触发时发 sched-fire 事件，由前端注入目标会话走完整审批/流式管线。
// 边界：任务仅在应用运行期间有效——窗口关闭后挂起，重启后重算 nextRunAt，错过的不补跑。
// 多窗口（独立进程）都会各自扫描并广播，是否执行由前端去重裁决（见 ai-panel.js）。

const (
	aiScheduleFileName    = "ai-schedule.db"
	aiSchedulePromptMax   = 8192
	aiScheduleNameMax     = 80
	aiScheduleIntervalMax = 525600 // 循环间隔上限：1 年（分钟）
	aiScheduleOnceGraceMs = 60_000 // once 允许的秒级时钟偏差
)

type AISchedule struct {
	Id              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"` // once | interval | cron
	At              string `json:"at,omitempty"`
	IntervalMinutes int    `json:"intervalMinutes,omitempty"`
	Cron            string `json:"cron,omitempty"`
	Prompt          string `json:"prompt"`
	SessionId       string `json:"sessionId"`
	Scope           string `json:"scope"` // chat | read | edit（新建会话时生效）
	Enabled         bool   `json:"enabled"`
	CreatedAt       int64  `json:"createdAt"`
	LastRunAt       int64  `json:"lastRunAt"`
	NextRunAt       int64  `json:"nextRunAt"` // unix ms
	RunCount        int    `json:"runCount"`
	MaxRuns         int    `json:"maxRuns"` // 0 = 不限；once 固定 1
	LastResult      string `json:"lastResult"`
}

// AIScheduleInput 创建/更新入参；once 可用 At（本地时间）或 DelayMinutes（相对现在）。
type AIScheduleInput struct {
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	At              string `json:"at"`
	DelayMinutes    int    `json:"delayMinutes"`
	IntervalMinutes int    `json:"intervalMinutes"`
	Cron            string `json:"cron"`
	Prompt          string `json:"prompt"`
	SessionId       string `json:"sessionId"`
	Scope           string `json:"scope"`
	MaxRuns         int    `json:"maxRuns"`
}

type AIScheduleFirePayload struct {
	ScheduleId string `json:"scheduleId"`
	SessionId  string `json:"sessionId"`
	Name       string `json:"name"`
	Prompt     string `json:"prompt"`
	RunNo      int    `json:"runNo"`
	Scope      string `json:"scope"`
}

var (
	aiScheduleMu     sync.Mutex
	aiScheduleDB     *sql.DB
	aiSchedules      []*AISchedule
	aiScheduleSeq    int
	aiScheduleStopCh chan struct{}
)

func aiSchedulePath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, aiScheduleFileName)
}

func aiScheduleEnsureLoaded() error {
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	return aiScheduleEnsureLocked()
}

func aiScheduleEnsureLocked() error {
	if aiScheduleDB != nil {
		return nil
	}
	path := aiSchedulePath()
	if path == "" {
		return errors.New("应用数据目录不可用")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	// 单连接串行化本进程读写；多窗口跨进程由 busy_timeout + WAL 处理（同 sessionindex.go）。
	_, _ = db.Exec("PRAGMA busy_timeout=5000")
	_, _ = db.Exec("PRAGMA journal_mode=WAL")
	_, _ = db.Exec("PRAGMA synchronous=NORMAL")
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS ai_schedules (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		kind TEXT NOT NULL,
		at TEXT DEFAULT '',
		interval_minutes INTEGER DEFAULT 0,
		cron TEXT DEFAULT '',
		prompt TEXT NOT NULL,
		session_id TEXT DEFAULT '',
		scope TEXT DEFAULT 'chat',
		enabled INTEGER DEFAULT 1,
		created_at INTEGER DEFAULT 0,
		last_run_at INTEGER DEFAULT 0,
		next_run_at INTEGER DEFAULT 0,
		run_count INTEGER DEFAULT 0,
		max_runs INTEGER DEFAULT 0,
		last_result TEXT DEFAULT ''
	)`); err != nil {
		_ = db.Close()
		return err
	}
	aiScheduleDB = db
	if err := aiScheduleReloadLocked(time.Now()); err != nil {
		return err
	}
	return nil
}

// aiScheduleReloadLocked 读取全部任务并重算 nextRunAt：interval 顺延到下一个整周期，
// cron 取下一个匹配时刻；once 已错过的标记为「已错过」并停用（不补跑）。
func aiScheduleReloadLocked(now time.Time) error {
	rows, err := aiScheduleDB.Query(`SELECT id, name, kind, at, interval_minutes, cron, prompt,
		session_id, scope, enabled, created_at, last_run_at, next_run_at, run_count, max_runs, last_result
		FROM ai_schedules`)
	if err != nil {
		return err
	}
	list := make([]*AISchedule, 0, 8)
	for rows.Next() {
		s := &AISchedule{}
		var enabled int
		if err := rows.Scan(&s.Id, &s.Name, &s.Kind, &s.At, &s.IntervalMinutes, &s.Cron, &s.Prompt,
			&s.SessionId, &s.Scope, &enabled, &s.CreatedAt, &s.LastRunAt, &s.NextRunAt,
			&s.RunCount, &s.MaxRuns, &s.LastResult); err != nil {
			rows.Close()
			return err
		}
		s.Enabled = enabled != 0
		list = append(list, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	aiSchedules = list
	nowMs := now.UnixMilli()
	for _, s := range aiSchedules {
		if !s.Enabled {
			continue
		}
		switch s.Kind {
		case "interval":
			s.NextRunAt = aiScheduleAlignNext(nowMs, s.NextRunAt, s.IntervalMinutes)
			_ = aiSchedulePersistRow(s)
		case "cron":
			if nt, ok := aiCronNextAfter(s.Cron, now); ok {
				s.NextRunAt = nt.UnixMilli()
				_ = aiSchedulePersistRow(s)
			}
		case "once":
			if s.NextRunAt > 0 && s.NextRunAt < nowMs-aiScheduleOnceGraceMs {
				s.Enabled = false
				s.LastResult = "已错过（应用未在触发时间运行，不补跑）"
				_ = aiSchedulePersistRow(s)
			}
		}
	}
	return nil
}

func aiSchedulePersistRow(s *AISchedule) error {
	_, err := aiScheduleDB.Exec(`INSERT INTO ai_schedules
		(id, name, kind, at, interval_minutes, cron, prompt, session_id, scope, enabled,
		 created_at, last_run_at, next_run_at, run_count, max_runs, last_result)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
		name=excluded.name, kind=excluded.kind, at=excluded.at,
		interval_minutes=excluded.interval_minutes, cron=excluded.cron, prompt=excluded.prompt,
		session_id=excluded.session_id, scope=excluded.scope, enabled=excluded.enabled,
		created_at=excluded.created_at, last_run_at=excluded.last_run_at, next_run_at=excluded.next_run_at,
		run_count=excluded.run_count, max_runs=excluded.max_runs, last_result=excluded.last_result`,
		s.Id, s.Name, s.Kind, s.At, s.IntervalMinutes, s.Cron, s.Prompt, s.SessionId, s.Scope,
		boolToInt(s.Enabled), s.CreatedAt, s.LastRunAt, s.NextRunAt, s.RunCount, s.MaxRuns, s.LastResult)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// aiScheduleAlignNext interval 错过触发后的顺延：返回第一个严格晚于 now 的整周期点。
func aiScheduleAlignNext(nowMs, prev int64, intervalMinutes int) int64 {
	step := int64(intervalMinutes) * 60_000
	if step <= 0 {
		return nowMs
	}
	if prev <= 0 {
		return nowMs + step
	}
	k := (nowMs-prev)/step + 1
	if prev+k*step <= nowMs {
		k++
	}
	return prev + k*step
}

// startAISchedule 在 startup 时调用：加载任务 + 启动单 ticker 每秒扫描。
func (a *App) startAISchedule() {
	if err := aiScheduleEnsureLoaded(); err != nil {
		writeAppLog("warn", "AI 定时任务初始化失败: %v", err)
		return
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	if aiScheduleStopCh != nil {
		return
	}
	aiScheduleStopCh = make(chan struct{})
	go func(stop chan struct{}) {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				a.aiScheduleTick()
			}
		}
	}(aiScheduleStopCh)
}

// aiScheduleTick 扫描到期任务：发 sched-fire、回写运行状态、按 kind 推进下一次触发；
// once / 达到 maxRuns 的任务触发后自动删除。
func (a *App) aiScheduleTick() {
	now := time.Now()
	nowMs := now.UnixMilli()
	fired := make([]AIScheduleFirePayload, 0, 2)
	finished := make(map[string]bool, 2)
	aiScheduleMu.Lock()
	for _, s := range aiSchedules {
		if !s.Enabled || s.NextRunAt <= 0 || s.NextRunAt > nowMs {
			continue
		}
		s.RunCount++
		s.LastRunAt = nowMs
		s.LastResult = "已触发"
		finish := false
		switch s.Kind {
		case "once":
			finish = true
		case "interval":
			s.NextRunAt = aiScheduleAlignNext(nowMs, s.NextRunAt, s.IntervalMinutes)
		case "cron":
			if nt, ok := aiCronNextAfter(s.Cron, now); ok {
				s.NextRunAt = nt.UnixMilli()
			} else {
				finish = true
			}
		default:
			finish = true
		}
		if s.MaxRuns > 0 && s.RunCount >= s.MaxRuns {
			finish = true
		}
		fired = append(fired, AIScheduleFirePayload{
			ScheduleId: s.Id, SessionId: s.SessionId, Name: s.Name,
			Prompt: s.Prompt, RunNo: s.RunCount, Scope: s.Scope,
		})
		if finish {
			finished[s.Id] = true
			if _, err := aiScheduleDB.Exec(`DELETE FROM ai_schedules WHERE id = ?`, s.Id); err != nil {
				writeAppLog("warn", "AI 定时任务删除失败（%s）: %v", s.Id, err)
			}
		} else if err := aiSchedulePersistRow(s); err != nil {
			writeAppLog("warn", "AI 定时任务状态回写失败（%s）: %v", s.Id, err)
		}
	}
	if len(finished) > 0 {
		kept := aiSchedules[:0]
		for _, s := range aiSchedules {
			if !finished[s.Id] {
				kept = append(kept, s)
			}
		}
		aiSchedules = kept
	}
	aiScheduleMu.Unlock()
	if a.ctx != nil {
		for _, p := range fired {
			runtime.EventsEmit(a.ctx, "sched-fire", p)
			writeAppLog("info", "AI 定时任务触发（%s · %s · 第 %d 次）", p.ScheduleId, p.Name, p.RunNo)
		}
	}
}

func aiScheduleEmitChanged(a *App) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "schedules-changed", map[string]bool{"changed": true})
	}
}

// ---- 绑定：列表 / 创建 / 更新 / 删除 / 启停 / 结果回写 ----

func (a *App) AIScheduleList() ([]*AISchedule, error) {
	if err := aiScheduleEnsureLoaded(); err != nil {
		return nil, err
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	list := make([]*AISchedule, len(aiSchedules))
	copy(list, aiSchedules)
	sort.Slice(list, func(i, k int) bool {
		if list[i].NextRunAt != list[k].NextRunAt {
			return list[i].NextRunAt < list[k].NextRunAt
		}
		return list[i].CreatedAt < list[k].CreatedAt
	})
	return list, nil
}

func (a *App) AIScheduleCreate(input AIScheduleInput) (*AISchedule, error) {
	if err := aiScheduleEnsureLoaded(); err != nil {
		return nil, err
	}
	s := &AISchedule{
		Kind:            strings.TrimSpace(input.Kind),
		At:              strings.TrimSpace(input.At),
		IntervalMinutes: input.IntervalMinutes,
		Cron:            strings.TrimSpace(input.Cron),
		SessionId:       strings.TrimSpace(input.SessionId),
		Scope:           strings.TrimSpace(input.Scope),
		MaxRuns:         input.MaxRuns,
	}
	if err := aiScheduleValidateAndFill(s, input.Prompt, input.Name, input.DelayMinutes, true, time.Now()); err != nil {
		return nil, err
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	aiScheduleSeq++
	s.Id = fmt.Sprintf("sch-%d-%d", time.Now().UnixMilli()%1_000_000_000, aiScheduleSeq)
	s.Enabled = true
	s.CreatedAt = time.Now().UnixMilli()
	s.NextRunAt = aiScheduleFirstRun(s, time.Now())
	if s.NextRunAt <= 0 {
		return nil, fmt.Errorf("无法计算下一次触发时间")
	}
	if err := aiSchedulePersistRow(s); err != nil {
		return nil, err
	}
	aiSchedules = append(aiSchedules, s)
	aiScheduleEmitChanged(a)
	return cloneAISchedule(s), nil
}

func (a *App) AIScheduleUpdate(id string, input AIScheduleInput) (*AISchedule, error) {
	if err := aiScheduleEnsureLoaded(); err != nil {
		return nil, err
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	s := aiScheduleFindLocked(id)
	if s == nil {
		return nil, fmt.Errorf("定时任务不存在：%s", id)
	}
	next := cloneAISchedule(s)
	next.Kind = strings.TrimSpace(input.Kind)
	next.At = strings.TrimSpace(input.At)
	next.IntervalMinutes = input.IntervalMinutes
	next.Cron = strings.TrimSpace(input.Cron)
	next.SessionId = strings.TrimSpace(input.SessionId)
	next.Scope = strings.TrimSpace(input.Scope)
	next.MaxRuns = input.MaxRuns
	if err := aiScheduleValidateAndFill(next, input.Prompt, input.Name, input.DelayMinutes, true, time.Now()); err != nil {
		return nil, err
	}
	next.NextRunAt = aiScheduleFirstRun(next, time.Now())
	if next.NextRunAt <= 0 {
		return nil, fmt.Errorf("无法计算下一次触发时间")
	}
	if err := aiSchedulePersistRow(next); err != nil {
		return nil, err
	}
	*s = *next
	aiScheduleEmitChanged(a)
	return cloneAISchedule(s), nil
}

func (a *App) AIScheduleDelete(id string) error {
	if err := aiScheduleEnsureLoaded(); err != nil {
		return err
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	found := false
	kept := aiSchedules[:0]
	for _, s := range aiSchedules {
		if s.Id == id {
			found = true
			continue
		}
		kept = append(kept, s)
	}
	if !found {
		return fmt.Errorf("定时任务不存在：%s", id)
	}
	aiSchedules = kept
	if _, err := aiScheduleDB.Exec(`DELETE FROM ai_schedules WHERE id = ?`, id); err != nil {
		return err
	}
	aiScheduleEmitChanged(a)
	return nil
}

func (a *App) AIScheduleToggle(id string, enabled bool) (*AISchedule, error) {
	if err := aiScheduleEnsureLoaded(); err != nil {
		return nil, err
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	s := aiScheduleFindLocked(id)
	if s == nil {
		return nil, fmt.Errorf("定时任务不存在：%s", id)
	}
	s.Enabled = enabled
	if enabled {
		s.NextRunAt = aiScheduleFirstRun(s, time.Now())
		if s.NextRunAt <= 0 {
			return nil, fmt.Errorf("无法计算下一次触发时间")
		}
	}
	if err := aiSchedulePersistRow(s); err != nil {
		return nil, err
	}
	aiScheduleEmitChanged(a)
	return cloneAISchedule(s), nil
}

// AIScheduleSetResult 前端触发执行后回写结果（成功/失败 + 说明）。
func (a *App) AIScheduleSetResult(id string, ok bool, note string) error {
	if err := aiScheduleEnsureLoaded(); err != nil {
		return err
	}
	note = strings.TrimSpace(note)
	if len(note) > 300 {
		note = note[:300]
	}
	aiScheduleMu.Lock()
	defer aiScheduleMu.Unlock()
	s := aiScheduleFindLocked(id)
	if s == nil {
		return fmt.Errorf("定时任务不存在：%s", id)
	}
	if ok {
		s.LastResult = "执行成功" + resultNote(note)
	} else {
		s.LastResult = "执行失败" + resultNote(note)
	}
	return aiSchedulePersistRow(s)
}

func resultNote(note string) string {
	if note == "" {
		return ""
	}
	return "：" + note
}

func aiScheduleFindLocked(id string) *AISchedule {
	for _, s := range aiSchedules {
		if s.Id == id {
			return s
		}
	}
	return nil
}

func cloneAISchedule(s *AISchedule) *AISchedule {
	c := *s
	return &c
}

// aiScheduleValidateAndFill 校验入参并补默认值；forCreate 控制时间必须指向将来。
func aiScheduleValidateAndFill(s *AISchedule, prompt, name string, delayMinutes int, forCreate bool, now time.Time) error {
	s.Prompt = strings.TrimSpace(prompt)
	if s.Prompt == "" {
		return errors.New("触发指令不能为空")
	}
	if len(s.Prompt) > aiSchedulePromptMax {
		return fmt.Errorf("触发指令过长（上限 %d 字符）", aiSchedulePromptMax)
	}
	s.Name = strings.TrimSpace(name)
	if s.Name == "" {
		runes := []rune(s.Prompt)
		if len(runes) > 30 {
			runes = runes[:30]
		}
		s.Name = strings.ReplaceAll(string(runes), "\n", " ")
	}
	if len([]rune(s.Name)) > aiScheduleNameMax {
		s.Name = string([]rune(s.Name)[:aiScheduleNameMax])
	}
	s.Kind = strings.TrimSpace(s.Kind)
	switch s.Kind {
	case "once":
		if s.At == "" && delayMinutes > 0 {
			s.At = now.Add(time.Duration(delayMinutes) * time.Minute).Format(time.RFC3339)
		}
		if s.At == "" {
			return errors.New("once 任务需要 at（本地时间）或 delayMinutes")
		}
		t, err := aiParseLocalTime(s.At)
		if err != nil {
			return fmt.Errorf("at 时间无效：%v", err)
		}
		if forCreate && t.Before(now.Add(-aiScheduleOnceGraceMs)) {
			return fmt.Errorf("once 任务的时间已过去（%s）", t.Format("2006-01-02 15:04"))
		}
		s.MaxRuns = 1
		s.IntervalMinutes = 0
		s.Cron = ""
	case "interval":
		if s.IntervalMinutes <= 0 {
			return errors.New("interval 任务需要 intervalMinutes（分钟）")
		}
		if s.IntervalMinutes > aiScheduleIntervalMax {
			return fmt.Errorf("循环间隔过大（上限 %d 分钟）", aiScheduleIntervalMax)
		}
		s.At = ""
		s.Cron = ""
	case "cron":
		if _, err := aiParseCronSpec(s.Cron); err != nil {
			return fmt.Errorf("cron 表达式无效：%v", err)
		}
		s.At = ""
		s.IntervalMinutes = 0
	default:
		return errors.New("kind 必须是 once / interval / cron")
	}
	if s.Scope == "" {
		s.Scope = "chat"
	}
	switch s.Scope {
	case "chat", "read", "edit":
	default:
		return fmt.Errorf("scope 无效：%s（chat / read / edit）", s.Scope)
	}
	if s.MaxRuns < 0 {
		s.MaxRuns = 0
	}
	return nil
}

// aiScheduleFirstRun 计算（创建/更新/重新启用后的）第一次触发时间。
func aiScheduleFirstRun(s *AISchedule, now time.Time) int64 {
	switch s.Kind {
	case "once":
		if t, err := aiParseLocalTime(s.At); err == nil {
			return t.UnixMilli()
		}
		return 0
	case "interval":
		return now.UnixMilli() + int64(s.IntervalMinutes)*60_000
	case "cron":
		if nt, ok := aiCronNextAfter(s.Cron, now); ok {
			return nt.UnixMilli()
		}
	}
	return 0
}

// aiParseLocalTime 解析常见的本地时间写法：RFC3339、日期 + 可选时间。
func aiParseLocalTime(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04",
		"2006-01-02 15:04",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"2006/01/02 15:04",
	}
	for _, f := range formats {
		if t, err := time.ParseInLocation(f, v, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("无法识别的时间格式 %q", v)
}

// ---- cron 解析（5 字段：分 时 日 月 周，支持 * , - /；周字段 0/7 = 周日）----
// 自写实现避免引入依赖（与 ConPTY 选用 go-pty 前先自写的先例一致）。

type aiCronField struct {
	star bool
	vals map[int]bool
}

func (f aiCronField) match(v int) bool {
	if f.star {
		return true
	}
	return f.vals[v]
}

func aiParseCronField(field string, lo, hi int, fieldNo int) (aiCronField, error) {
	field = strings.TrimSpace(field)
	if field == "" {
		return aiCronField{}, fmt.Errorf("第 %d 个字段为空", fieldNo)
	}
	out := aiCronField{vals: map[int]bool{}}
	for _, part := range strings.Split(field, ",") {
		part = strings.TrimSpace(part)
		step := 1
		rangePart := part
		if i := strings.Index(part, "/"); i >= 0 {
			rangePart = part[:i]
			stepStr := part[i+1:]
			n, err := strconv.Atoi(stepStr)
			if err != nil || n <= 0 {
				return aiCronField{}, fmt.Errorf("第 %d 个字段的步进无效：%q", fieldNo, stepStr)
			}
			step = n
		}
		loV, hiV := lo, hi
		switch {
		case rangePart == "*" || rangePart == "":
			if rangePart == "" {
				return aiCronField{}, fmt.Errorf("第 %d 个字段无效：%q", fieldNo, part)
			}
		case strings.Contains(rangePart, "-"):
			bits := strings.SplitN(rangePart, "-", 2)
			a, err1 := strconv.Atoi(bits[0])
			b, err2 := strconv.Atoi(bits[1])
			if err1 != nil || err2 != nil {
				return aiCronField{}, fmt.Errorf("第 %d 个字段的范围无效：%q", fieldNo, rangePart)
			}
			loV, hiV = a, b
		default:
			n, err := strconv.Atoi(rangePart)
			if err != nil {
				return aiCronField{}, fmt.Errorf("第 %d 个字段的数值无效：%q", fieldNo, rangePart)
			}
			loV, hiV = n, n
		}
		if loV < lo || hiV > hi || loV > hiV {
			return aiCronField{}, fmt.Errorf("第 %d 个字段超出范围 %d-%d：%q", fieldNo, lo, hi, part)
		}
		for v := loV; v <= hiV; v += step {
			out.vals[v] = true
		}
	}
	out.star = field == "*" || strings.HasPrefix(field, "*/") && len(out.vals) == hi-lo+1
	return out, nil
}

type aiCronSpec struct {
	minute, hour, dom, mon, dow aiCronField
}

// aiParseCronSpec 解析「分 时 日 月 周」；周字段 0 和 7 都按周日处理。
func aiParseCronSpec(spec string) (*aiCronSpec, error) {
	fields := strings.Fields(strings.TrimSpace(spec))
	if len(fields) != 5 {
		return nil, fmt.Errorf("需要 5 个字段（分 时 日 月 周），实际 %d 个", len(fields))
	}
	s := &aiCronSpec{}
	var err error
	if s.minute, err = aiParseCronField(fields[0], 0, 59, 1); err != nil {
		return nil, err
	}
	if s.hour, err = aiParseCronField(fields[1], 0, 23, 2); err != nil {
		return nil, err
	}
	if s.dom, err = aiParseCronField(fields[2], 1, 31, 3); err != nil {
		return nil, err
	}
	if s.mon, err = aiParseCronField(fields[3], 1, 12, 4); err != nil {
		return nil, err
	}
	if s.dow, err = aiParseCronField(fields[4], 0, 7, 5); err != nil {
		return nil, err
	}
	if s.dow.vals[7] {
		s.dow.vals[0] = true // 7 与 0 都表示周日
	}
	return s, nil
}

// aiCronMatchDate 标准 cron 语义：日与周都受限时命中其一即可，否则取受限的那个。
func (s *aiCronSpec) match(t time.Time) bool {
	if !s.minute.match(t.Minute()) || !s.hour.match(t.Hour()) || !s.mon.match(int(t.Month())) {
		return false
	}
	domOK := s.dom.match(t.Day())
	dowOK := s.dow.match(int(t.Weekday()))
	domRestricted := !s.dom.star
	dowRestricted := !s.dow.star
	if domRestricted && dowRestricted {
		return domOK || dowOK
	}
	if domRestricted {
		return domOK
	}
	if dowRestricted {
		return dowOK
	}
	return true
}

// aiCronNextAfter 返回严格晚于 after 的下一个匹配时刻；最多向后扫描 366 天。
func aiCronNextAfter(spec string, after time.Time) (time.Time, bool) {
	parsed, err := aiParseCronSpec(spec)
	if err != nil {
		return time.Time{}, false
	}
	t := after.Truncate(time.Minute).Add(time.Minute)
	limit := after.AddDate(1, 0, 0)
	for t.Before(limit) {
		if parsed.match(t) {
			return t, true
		}
		t = t.Add(time.Minute)
	}
	return time.Time{}, false
}
