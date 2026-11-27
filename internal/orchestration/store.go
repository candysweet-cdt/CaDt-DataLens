// store.go：编排状态的磁盘真源。JSON + atomfile，不引入 SQLite。
// 日志是 append-only 旁路文件，删了不可重建，但不影响编排能否继续。
package orchestration

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"datalens/internal/atomfile"
)

// AppDataDir 宿主注入（main 的 appDataRoot）。为空时拒绝落盘。
var AppDataDir func() string

// Logf 宿主注入诊断日志；nil 静默。
var Logf func(level, format string, args ...any)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

// Store 编排持久化。进程内单写者由 Engine 的锁保证；多窗口共享同一 Engine。
type Store struct {
	root string
	mu   sync.Mutex
}

func orchestrationRoot() (string, error) {
	base := ""
	if AppDataDir != nil {
		base = strings.TrimSpace(AppDataDir())
	}
	if base == "" {
		return "", fmt.Errorf("应用数据目录不可用")
	}
	return filepath.Join(base, "orchestrations"), nil
}

func NewStore(root string) *Store { return &Store{root: root} }

func (s *Store) Ensure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == "" {
		return fmt.Errorf("编排存储目录未配置")
	}
	return os.MkdirAll(s.root, 0o755)
}

func (s *Store) path(id string, suffix string) (string, error) {
	if !validID(id) {
		return "", fmt.Errorf("非法编排 id：%q", id)
	}
	if err := s.Ensure(); err != nil {
		return "", err
	}
	return filepath.Join(s.root, id+suffix), nil
}

// Save 原子落盘真源。
func (s *Store) Save(o *Orchestration) error {
	if o == nil || !validID(o.ID) {
		return fmt.Errorf("非法编排记录")
	}
	raw, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		return err
	}
	path, err := s.path(o.ID, ".json")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return atomfile.WriteFileAtomic(path, raw)
}

// Load 读取一份编排。
func (s *Store) Load(id string) (*Orchestration, error) {
	path, err := s.path(id, ".json")
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var o Orchestration
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, fmt.Errorf("编排 %s 状态损坏：%w", id, err)
	}
	return &o, nil
}

// LoadAll 扫描全部编排（坏文件记日志后跳过，不阻塞其它编排）。
func (s *Store) LoadAll() ([]*Orchestration, error) {
	if err := s.Ensure(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	out := make([]*Orchestration, 0, 16)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		o, err := s.Load(id)
		if err != nil {
			logf("warn", "orchestration: 跳过损坏状态 %s：%v", entry.Name(), err)
			continue
		}
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

// Delete 删除真源与日志；不触碰任何会话或工作区改动。
func (s *Store) Delete(id string) error {
	path, err := s.path(id, ".json")
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	logPath, _ := s.path(id, ".log.jsonl")
	if err := os.Remove(logPath); err != nil && !os.IsNotExist(err) {
		logf("warn", "orchestration: 删除日志 %s 失败：%v", logPath, err)
	}
	return nil
}

// AppendLog 旁路追加决策日志；失败不阻断业务。
func (s *Store) AppendLog(id string, entry LogEntry) {
	if entry.At == 0 {
		entry.At = nowMs()
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return
	}
	path, err := s.path(id, ".log.jsonl")
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		logf("warn", "orchestration: 写日志失败：%v", err)
		return
	}
	defer f.Close()
	_, _ = f.Write(append(raw, '\n'))
}

// TailLog 读取最近 limit 条日志（看板事件流与工具查询）。
func (s *Store) TailLog(id string, limit int) []LogEntry {
	if limit <= 0 {
		limit = 50
	}
	path, err := s.path(id, ".log.jsonl")
	if err != nil {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	lines := make([]string, 0, limit)
	scanner := bufio.NewScanner(f)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > limit {
			lines = lines[1:]
		}
	}
	out := make([]LogEntry, 0, len(lines))
	for _, line := range lines {
		var entry LogEntry
		if json.Unmarshal([]byte(line), &entry) == nil {
			out = append(out, entry)
		}
	}
	return out
}

// ModTime 状态文件最后修改时间（审计者唯一可信的“有没有进展”信号）。
func (s *Store) ModTime(id string) int64 {
	path, err := s.path(id, ".json")
	if err != nil {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}
