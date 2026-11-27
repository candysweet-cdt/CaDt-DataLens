// clear.go：按条目执行清除。
//
// 缓存直删（体积要立刻还回磁盘），数据送回收站（误删可取回）；
// WebView2 相关的两项运行中被浏览器进程锁住，点了只记待清理标记，
// 下次启动时、WebView2 还没起来的空档执行（ApplyPending，由仓库根的壳在 main 里调用）。
package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"datalens/internal/appdata"
)

// ClearResult 单个条目的清除结果。
type ClearResult struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Freed   int64  `json:"freed"`
	Entries int    `json:"entries"`
	// Blocked 是正在使用而未纳入本轮的子项数。
	Blocked int `json:"blocked"`
	// Remaining 是执行后仍在磁盘上的数量；Skipped 是给界面看的合计（Blocked + Remaining）。
	Skipped   int    `json:"skipped"`
	Remaining int    `json:"remaining"`
	Scheduled bool   `json:"scheduled"`
	Reason    string `json:"reason,omitempty"`
}

// ClearReport 一次清除的汇总，前端按它写回执。
type ClearReport struct {
	Results   []ClearResult `json:"results"`
	Freed     int64         `json:"freed"`
	Succeeded int           `json:"succeeded"`
	Scheduled []string      `json:"scheduled"`
	Skipped   []string      `json:"skipped"`
	Failed    []string      `json:"failed"`
}

// Clear 按 id 清除。id 必须已在条目表登记，路径全部由表算出，不接受调用方传路径。
func (s *Service) Clear(ids []string, workspaceRoot string) ClearReport {
	workspaceRoot = normalizeWorkspace(workspaceRoot)
	s.mu.Lock()
	defer s.mu.Unlock()

	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[strings.TrimSpace(id)] = true
	}
	report := ClearReport{Results: []ClearResult{}}
	matched := map[string]bool{}
	for _, sp := range s.specs() { // 按表序遍历：天然去重，回执顺序稳定
		if !wanted[sp.id] {
			continue
		}
		matched[sp.id] = true
		result := s.clearSpec(sp, workspaceRoot)
		report.Results = append(report.Results, result)
		report.add(result)
	}
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !matched[id] {
			report.Failed = append(report.Failed, id)
		}
	}
	return report
}

// add 把单条清除结果归入桶。口径：**只要还有残留就算失败**——此前要求
// 「Freed==0」，于是同一条目里删掉任意一个路径就能把密钥文件残留一起报成成功，
// 破坏性操作误报"已清除"，用户以为清空了其实没有。
func (r *ClearReport) add(result ClearResult) {
	r.Freed += result.Freed
	switch {
	case result.Remaining > 0:
		r.Failed = append(r.Failed, result.Label)
		if result.Freed > 0 {
			r.Skipped = append(r.Skipped, result.Label) // 部分删除：体积记了，但有残留
		}
	case result.Scheduled:
		r.Scheduled = append(r.Scheduled, result.Label)
	default:
		r.Succeeded++
		if result.Skipped > 0 {
			r.Skipped = append(r.Skipped, result.Label)
		}
	}
}

func (s *Service) clearSpec(sp spec, workspaceRoot string) ClearResult {
	if sp.scope == ScopeWebview {
		if _, err := s.markPending(sp.id); err != nil {
			return ClearResult{ID: sp.id, Label: sp.label, Reason: err.Error()}
		}
		return ClearResult{ID: sp.id, Label: sp.label, Scheduled: true}
	}
	return s.removeSpec(sp, workspaceRoot)
}

// removeSpec 真正删除：先量体积（删完就没得量），再释放本进程句柄，最后逐项删。
func (s *Service) removeSpec(sp spec, workspaceRoot string) ClearResult {
	result := ClearResult{ID: sp.id, Label: sp.label}
	var paths []string
	measured := map[string]usage{}
	budget := ScanMaxEntries
	for _, t := range sp.targets {
		for _, path := range s.targetFiles(t, workspaceRoot) {
			if _, ok := measured[path]; !ok {
				measured[path] = measurePath(path, &budget)
				paths = append(paths, path)
			}
		}
		result.Blocked += s.targetBlockedCount(t, t.resolve(s, workspaceRoot))
	}
	result.Skipped = result.Blocked
	var release func()
	var err error
	if prepare := s.deps.BeforeClear[sp.id]; prepare != nil {
		release, err = prepare(workspaceRoot)
		if err != nil {
			result.Reason = err.Error()
			result.Remaining = 1
			result.Skipped = result.Blocked + 1
			return result
		}
	}
	if release != nil {
		defer release()
	}
	for _, path := range paths {
		if err := s.removePath(sp.kind, path); err != nil && result.Reason == "" {
			result.Reason = err.Error()
		}
		if _, err := os.Lstat(path); err == nil {
			result.Remaining++
			result.Skipped++
			continue
		}
		// 路径已经不在：可能是 prepare 顺手删掉的（派生库的关闭与删除是一体的），照量得的体积记账
		result.Freed += measured[path].bytes
		result.Entries++
	}
	return result
}

// removePath 缓存直删，数据走回收站。没注入回收站动作时拒绝清除数据条目：
// 宁可不动，也不能把「送回收站」悄悄降级成真删。
func (s *Service) removePath(kind, path string) error {
	if kind != KindCache {
		if s.deps.RemoveToRecycleBin == nil {
			return fmt.Errorf("当前环境不支持回收站，已跳过")
		}
		return s.deps.RemoveToRecycleBin(path)
	}
	return os.RemoveAll(path)
}

// ApplyPending 执行上次记下的待清理项，返回逐项结果供宿主写日志。
// 只有一项都没剩下才删掉标记：多开窗口时另一个进程可能还占着配置目录，
// 留着标记下次启动再试，不能把用户点过的清除请求悄悄吞掉。
func (s *Service) ApplyPending() []ClearResult {
	stored := s.readPendingRaw()
	if len(stored) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var results []ClearResult
	var remain []string
	for _, id := range stored {
		sp, ok := s.specByID(id)
		if !ok {
			continue // 表里已删掉或改名的旧 id：不算剩余，本轮结束后一并从标记里清掉
		}
		result := s.removeSpec(sp, "")
		results = append(results, result)
		if result.Remaining > 0 {
			remain = append(remain, id)
		}
	}
	if len(remain) != len(stored) {
		if err := s.writePending(remain); err != nil {
			results = append(results, ClearResult{ID: "pending-marker", Label: "待清理标记", Reason: err.Error()})
		}
	}
	return results
}

// PendingIDs 返回已排到下次启动前的条目 id。
func (s *Service) PendingIDs() []string { return s.readPending() }

// readPending 返回界面上有意义的待清理条目（未登记的 id 不显示）。
func (s *Service) readPending() []string {
	raw := s.readPendingRaw()
	out := make([]string, 0, len(raw))
	for _, id := range raw {
		if _, ok := s.specByID(id); ok {
			out = append(out, id)
		}
	}
	return out
}

// readPendingRaw 原样读标记文件（去空行、去重、排序），不过滤未知 id：
// ApplyPending 要靠它判断「标记有没有变短」，才能把陈旧 id 顺手清掉。
func (s *Service) readPendingRaw() []string {
	path := s.pendingPath()
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	for _, line := range strings.Split(string(raw), "\n") {
		id := strings.TrimSpace(line)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// writePending 落盘待清理列表；空列表等价于删掉标记。
func (s *Service) writePending(ids []string) error {
	path := s.pendingPath()
	if path == "" {
		return appdata.ErrNoRoot
	}
	unique := map[string]bool{}
	list := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || unique[id] {
			continue
		}
		if _, ok := s.specByID(id); !ok {
			return fmt.Errorf("未登记的清理条目：%s", id)
		}
		unique[id] = true
		list = append(list, id)
	}
	sort.Strings(list)
	body := ""
	if len(list) > 0 {
		body = strings.Join(list, "\n") + "\n"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		return err
	}
	if len(list) == 0 {
		// 空列表：原子改名会把标记重新写成空文件，这里直接删掉它
		_ = os.Remove(tmp)
		return os.Remove(path)
	}
	return os.Rename(tmp, path)
}

func (s *Service) markPending(ids ...string) ([]string, error) {
	merged := append(s.readPending(), ids...)
	if err := s.writePending(merged); err != nil {
		return nil, err
	}
	return s.readPending(), nil
}
