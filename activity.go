package main

// 操作留痕（Activity Audit Log）：记录用户与 AI 的状态改变类操作。
// 布局：<appdata>/activity/YYYY-MM.jsonl（按月分文件，单文件 >5MB 滚动为 YYYY-MM-2.jsonl、-3…）。
// 这些 JSONL 是唯一真源（纯追加，无 SQLite）；单条记录只存操作摘要，永不存正文与密钥。
// 写入失败只写运行日志语义的错误返回，绝不阻塞调用方；前端已做攒批与开关。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	activityDirName      = "activity"
	activityLockName     = ".activity.lock"
	activityMaxEntrySize = 8 << 10 // 单条记录上限，超长 detail 截断
	activityLockWait     = 2 * time.Second
	activityReadScanMax  = 64 << 20 // 单次读取扫描的总字节上限，封顶内存
	activityMonthsMin    = 1
	activityMonthsMax    = 60
	activityPruneEvery   = 10 * time.Minute
)

// activitySegmentMax 用 var 是为了测试能临时调小，验证滚动分段（方案第 8 节）。
var activitySegmentMax = int64(5 << 20) // 单文件上限，超过滚动出 -2/-3… 分段

var (
	activityMu        sync.Mutex // 同进程追加互斥（各窗口各建 App，锁必须是包级的）
	activityPruneAt   time.Time
	activityFileRegex = regexp.MustCompile(`^(\d{4})-(\d{2})(?:-(\d{1,3}))?\.jsonl$`)
)

// activityEntry 单条操作记录（JSONL 一行一个）。
type activityEntry struct {
	V      int             `json:"v"`
	TS     int64           `json:"ts"`
	Actor  string          `json:"actor"`
	Source string          `json:"source,omitempty"`
	Action string          `json:"action"`
	Target string          `json:"target,omitempty"`
	Detail json.RawMessage `json:"detail,omitempty"`
	Seq    int64           `json:"seq,omitempty"`
}

// activityAppendPayload 前端攒批后的请求体：entries 是待追加记录，retentionMonths 触发保留清理。
type activityAppendPayload struct {
	Entries         []activityEntry `json:"entries"`
	RetentionMonths int             `json:"retentionMonths"`
}

// activityQuery ActivityRead 的过滤条件：从新到旧命中 limit 即停。
type activityQuery struct {
	Limit    int      `json:"limit"`
	BeforeTs int64    `json:"beforeTs"`
	SinceTs  int64    `json:"sinceTs"`
	Actions  []string `json:"actions"`
	Actor    string   `json:"actor"`
	Keyword  string   `json:"keyword"`
}

type activityReadResult struct {
	Entries   []activityEntry `json:"entries"`
	Truncated bool            `json:"truncated"`
	Files     []string        `json:"files"`
}

func activityDir() string {
	return filepath.Join(appDataRoot(), activityDirName)
}

func validActivityActor(actor string) bool {
	switch actor {
	case "user", "ai", "system":
		return true
	}
	return false
}

func validActivityAction(action string) bool {
	if action == "" || len(action) > 64 {
		return false
	}
	if action[0] < 'a' || action[0] > 'z' {
		return false
	}
	for _, ch := range action {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
		case ch == '.', ch == '_':
		default:
			return false
		}
	}
	return true
}

// normalizeActivityEntry 校验并补全一条前端记录；非法字段直接判失败，由调用方丢弃。
// detail 必须是 JSON 对象；整条超过 8KB 时把 detail 替换为截断标记（其余字段都不大，能保证达标）。
func normalizeActivityEntry(e activityEntry) (activityEntry, bool) {
	if e.TS <= 0 {
		e.TS = time.Now().UnixMilli()
	}
	if !validActivityActor(e.Actor) || !validActivityAction(e.Action) {
		return activityEntry{}, false
	}
	if len(e.Target) > 500 {
		e.Target = e.Target[:500]
	}
	e.V = 1
	if len(e.Detail) > 0 {
		trimmed := strings.TrimSpace(string(e.Detail))
		if !strings.HasPrefix(trimmed, "{") || !json.Valid([]byte(trimmed)) {
			e.Detail = nil
		} else {
			e.Detail = json.RawMessage(trimmed)
		}
	}
	if raw, err := json.Marshal(e); err != nil || len(raw) > activityMaxEntrySize {
		e.Detail = json.RawMessage(`{"truncated":true}`)
	}
	return e, true
}

// activitySegment 是一个日志文件：月份 + 分段号（0 表示 YYYY-MM.jsonl 本体）。
type activitySegment struct {
	name   string
	year   int
	month  int
	suffix int
}

func listActivitySegments(dir string) ([]activitySegment, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]activitySegment, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		m := activityFileRegex.FindStringSubmatch(entry.Name())
		if m == nil {
			continue
		}
		year, _ := parseActivityInt(m[1])
		month, _ := parseActivityInt(m[2])
		suffix := 0
		if m[3] != "" {
			suffix, _ = parseActivityInt(m[3])
		}
		if year < 2000 || year > 3000 || month < 1 || month > 12 {
			continue
		}
		out = append(out, activitySegment{name: entry.Name(), year: year, month: month, suffix: suffix})
	}
	return out, nil
}

// sortSegmentsNewestFirst 排序：月份新→旧，同月内分段号大→小（-3 在 -2 前，本体最后）。
func sortSegmentsNewestFirst(segs []activitySegment) {
	sort.Slice(segs, func(i, j int) bool {
		a, b := segs[i], segs[j]
		if a.year != b.year {
			return a.year > b.year
		}
		if a.month != b.month {
			return a.month > b.month
		}
		return a.suffix > b.suffix
	})
}

// activityActiveSegment 选当前月的最新分段作为追加目标；返回空名字表示目录里还没有当前月文件。
func activityActiveSegment(dir string) (activitySegment, error) {
	now := time.Now()
	segs, err := listActivitySegments(dir)
	if err != nil {
		return activitySegment{}, err
	}
	active := activitySegment{}
	for _, seg := range segs {
		if seg.year != now.Year() || int(seg.month) != int(now.Month()) {
			continue
		}
		if active.name == "" || seg.suffix > active.suffix {
			active = seg
		}
	}
	return active, nil
}

// appendActivityEntries 追加一批已校验的记录：跨进程文件锁串行，修残行、O_APPEND 写、fsync。
// 失败回滚到追加前长度，避免半批记录留在日志里。
func appendActivityEntries(dir string, entries []activityEntry) error {
	if len(entries) == 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建操作记录目录失败：%w", err)
	}
	lock, err := lockAISessionFile(filepath.Join(dir, activityLockName), activityLockWait)
	if err != nil {
		return fmt.Errorf("操作记录正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.release()

	activityMu.Lock()
	defer activityMu.Unlock()

	now := time.Now()
	active, err := activityActiveSegment(dir)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, fmt.Sprintf("%04d-%02d.jsonl", now.Year(), int(now.Month())))
	if active.name != "" {
		current := filepath.Join(dir, active.name)
		info, err := os.Stat(current)
		if err == nil && info.Size() > activitySegmentMax {
			// 超过单文件上限：滚动到下一个分段号（-2、-3…）。
			path = filepath.Join(dir, fmt.Sprintf("%04d-%02d-%d.jsonl", active.year, active.month, active.suffix+1))
		} else {
			path = current
		}
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	before, err := repairTornTail(f)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	af, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer af.Close()
	var sb strings.Builder
	for _, entry := range entries {
		raw, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		sb.Write(raw)
		sb.WriteByte('\n')
	}
	if _, err := af.WriteString(sb.String()); err != nil {
		_ = af.Truncate(before)
		return err
	}
	if err := af.Sync(); err != nil {
		_ = af.Truncate(before)
		return err
	}
	return nil
}

// pruneActivityFiles 保留清理：月份/修改时间超出保留窗口的分段直接删除。
// months 非法（<1 或 >60）时跳过。节流：最多每 10 分钟跑一次，避免每次追加都扫目录。
func pruneActivityFiles(dir string, months int) {
	if months < activityMonthsMin || months > activityMonthsMax {
		return
	}
	now := time.Now()
	if !activityPruneAt.IsZero() && now.Sub(activityPruneAt) < activityPruneEvery {
		return
	}
	activityPruneAt = now
	// 按文件名里的月份判断过期（同月分段共享月份）；窗口外连同分段号一起删。
	cutoff := now.AddDate(0, -months, 0)
	cutoffMonth := cutoff.Year()*12 + int(cutoff.Month()) - 1
	segs, err := listActivitySegments(dir)
	if err != nil {
		return
	}
	for _, seg := range segs {
		if seg.year*12+seg.month-1 < cutoffMonth {
			_ = os.Remove(filepath.Join(dir, seg.name))
		}
	}
}

func (a *App) ActivityAppend(entriesJSON string) error {
	var payload activityAppendPayload
	if err := json.Unmarshal([]byte(entriesJSON), &payload); err != nil {
		return fmt.Errorf("操作记录格式无效：%w", err)
	}
	valid := make([]activityEntry, 0, len(payload.Entries))
	dropped := 0
	for _, entry := range payload.Entries {
		if normalized, ok := normalizeActivityEntry(entry); ok {
			valid = append(valid, normalized)
		} else {
			dropped++
		}
	}
	if len(valid) == 0 {
		if dropped > 0 {
			return fmt.Errorf("操作记录全部无效（丢弃 %d 条）", dropped)
		}
		return nil
	}
	dir := activityDir()
	err := appendActivityEntries(dir, valid)
	if err != nil {
		return err
	}
	pruneActivityFiles(dir, payload.RetentionMonths)
	if dropped > 0 {
		writeAppLog("WARN", "操作记录有 %d 条字段非法被丢弃", dropped)
	}
	return nil
}

func (a *App) ActivityRead(queryJSON string) (string, error) {
	query := activityQuery{Limit: 200}
	if strings.TrimSpace(queryJSON) != "" {
		if err := json.Unmarshal([]byte(queryJSON), &query); err != nil {
			return "", fmt.Errorf("查询格式无效：%w", err)
		}
	}
	if query.Limit <= 0 {
		query.Limit = 200
	}
	if query.Limit > 500 {
		query.Limit = 500
	}
	dir := activityDir()
	segs, err := listActivitySegments(dir)
	if err != nil {
		return "", err
	}
	sortSegmentsNewestFirst(segs)
	// 动作过滤支持「domain 前缀」：传 file 等价于 file.*（设置页按大类筛选）。
	actions := make([]string, 0, len(query.Actions))
	for _, action := range query.Actions {
		action = strings.TrimSpace(action)
		if action != "" {
			actions = append(actions, action)
		}
	}
	keyword := strings.ToLower(strings.TrimSpace(query.Keyword))
	result := activityReadResult{Entries: []activityEntry{}, Files: make([]string, 0, len(segs))}
	scanned := int64(0)
	for _, seg := range segs {
		if len(result.Entries) >= query.Limit {
			result.Truncated = true
			break
		}
		result.Files = append(result.Files, seg.name)
		raw, err := os.ReadFile(filepath.Join(dir, seg.name))
		if err != nil {
			continue
		}
		scanned += int64(len(raw))
		lines := strings.Split(string(raw), "\n")
		// 文件按时间正序追加：倒着走才能「从新到旧」。
		for i := len(lines) - 1; i >= 0; i-- {
			line := strings.TrimSpace(lines[i])
			if line == "" {
				continue
			}
			var entry activityEntry
			if json.Unmarshal([]byte(line), &entry) != nil {
				continue
			}
			if query.BeforeTs > 0 && entry.TS >= query.BeforeTs {
				continue
			}
			if query.SinceTs > 0 && entry.TS < query.SinceTs {
				continue
			}
			if len(actions) > 0 && !activityActionMatch(entry.Action, actions) {
				continue
			}
			if query.Actor != "" && entry.Actor != query.Actor {
				continue
			}
			if keyword != "" && !activityMatchKeyword(entry, keyword) {
				continue
			}
			result.Entries = append(result.Entries, entry)
			if len(result.Entries) >= query.Limit {
				break
			}
		}
		if scanned > activityReadScanMax {
			result.Truncated = true
			break
		}
	}
	out, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func activityActionMatch(action string, filters []string) bool {
	for _, filter := range filters {
		if action == filter || strings.HasPrefix(action, filter+".") {
			return true
		}
	}
	return false
}

func activityMatchKeyword(entry activityEntry, keyword string) bool {
	if strings.Contains(strings.ToLower(entry.Action), keyword) ||
		strings.Contains(strings.ToLower(entry.Target), keyword) {
		return true
	}
	if len(entry.Detail) > 0 {
		return strings.Contains(strings.ToLower(string(entry.Detail)), keyword)
	}
	return false
}

// ActivityClear 清空全部记录：先删旧文件，再写入一条 activity.clear（保留「清空过」这个事实）。
func (a *App) ActivityClear() error {
	dir := activityDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建操作记录目录失败：%w", err)
	}
	lock, err := lockAISessionFile(filepath.Join(dir, activityLockName), activityLockWait)
	if err != nil {
		return fmt.Errorf("操作记录正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.release()

	activityMu.Lock()
	defer activityMu.Unlock()

	segs, err := listActivitySegments(dir)
	if err != nil {
		return err
	}
	for _, seg := range segs {
		if err := os.Remove(filepath.Join(dir, seg.name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	clearEntry := activityEntry{
		V:      1,
		TS:     time.Now().UnixMilli(),
		Actor:  "user",
		Source: "user",
		Action: "activity.clear",
	}
	raw, err := json.Marshal(clearEntry)
	if err != nil {
		return err
	}
	now := time.Now()
	path := filepath.Join(dir, fmt.Sprintf("%04d-%02d.jsonl", now.Year(), int(now.Month())))
	af, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer af.Close()
	if _, err := af.Write(append(raw, '\n')); err != nil {
		return err
	}
	return af.Sync()
}

// ActivityPath 返回记录目录（设置页打开目录 / 展示用）；目录不存在时创建。
func (a *App) ActivityPath() (string, error) {
	dir := activityDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建操作记录目录失败：%w", err)
	}
	return dir, nil
}

// parseActivityInt 本文件专用的小整数转换：失败返回 0（调用处已用范围校验兜底）。
func parseActivityInt(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, errors.New("空字符串")
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("非数字：%q", s)
		}
		n = n*10 + int(ch-'0')
		if n > 1<<20 {
			return 0, fmt.Errorf("数字过大：%q", s)
		}
	}
	return n, nil
}
