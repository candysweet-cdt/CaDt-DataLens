package search

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 用户自定义搜索排除表：<工作区根>/.cadt/config/search-ignore。
//
// 语法（gitignore 简化版）：
//   - 一行一条；空行与 # 开头的行为注释。
//   - ! 前缀取反：后匹配的规则覆盖先匹配的规则（! 即「重新包含」）。
//   - 不含 / 的模式按路径每一段的名字匹配（如 .aoci 排除任意层级的 .aoci 目录/文件）。
//   - 含 / 的模式按相对扫描根的路径 glob 匹配（如 .cadt/tmp、docs/**/*.bak）。
//
// LoadIgnoreRules 先注入 defaultIgnoreNames（node_modules / .git / .venv 等）作为默认
// 软忽略，再追加用户规则；用户写 !node_modules 即可覆盖默认、重新包含该目录。
// 该表作用于 UI 全局搜索 / AI search_text / glob / 目录树 list_dir / 目录结构导出；
// 硬编码表 SkipDir / SkipPath 保持独立（wipeguard 结构指纹、worktree 跳过不接用户配置）。
// 根自身永不命中——从子目录发起的检索不受影响。
// 纯解析入口 LoadIgnoreRulesAt 供认知索引的 <root>/.cogignore 复用（它不注入默认规则，
// internal/cognition：可搜索 ≠ 可索引，两份排除文件刻意解耦）。

const ignoreRelPath = ".cadt/config/search-ignore"

type ignoreRule struct {
	negate  bool
	byName  bool
	pattern string
}

// IgnoreRules 解析后的用户排除表。nil 表示无自定义规则。
type IgnoreRules struct {
	rules []ignoreRule
}

type cachedIgnore struct {
	modTime time.Time
	rules   *IgnoreRules
}

var ignoreCache = struct {
	mu    sync.Mutex
	items map[string]*cachedIgnore
}{items: map[string]*cachedIgnore{}}

// LoadIgnoreRules 读取并解析 <root>/.cadt/config/search-ignore，并注入默认软忽略规则。
// 返回的规则顺序：先 defaultIgnoreNames（有序），再用户配置——后者可写 ! 前缀覆盖前者
// （如 !node_modules 重新包含）。用户配置不存在时仍返回含默认规则的实例，故返回永不为 nil。
// 按配置路径 + mtime 缓存用户部分，避免每次搜索都读盘；配置改动后下次搜索自动重载。
// 供本包搜索三路径、fsops 目录树与 structuredir 目录导出共用（四处同一口径）。
// 注意：LoadIgnoreRulesAt 保持纯解析、不注入默认——cognition 的 .cogignore 复用它，
// 两份排除文件刻意解耦（可搜索 ≠ 可索引）。
func LoadIgnoreRules(root string) *IgnoreRules {
	merged := &IgnoreRules{}
	for _, name := range defaultIgnoreNames {
		merged.rules = append(merged.rules, ignoreRule{pattern: name, byName: true})
	}
	root = strings.TrimSpace(root)
	if root == "" {
		return merged
	}
	// 用户部分来自缓存实例：拼接到新 slice，绝不 append 到缓存实例本身（避免污染缓存、
	// 让默认规则在下次调用重复叠加）。
	if user := LoadIgnoreRulesAt(filepath.Join(root, filepath.FromSlash(ignoreRelPath))); user != nil {
		merged.rules = append(merged.rules, user.rules...)
	}
	return merged
}

// LoadIgnoreRulesAt 读取并解析任意路径的 gitignore 简化版排除文件；不存在、是目录或读失败返回
// nil。缓存键 = 文件绝对路径 + mtime，多份排除文件（search-ignore / cognition 的 .cogignore）
// 互不串扰；文件改动后下次加载自动重载。
func LoadIgnoreRulesAt(path string) *IgnoreRules {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return nil
	}
	mt := info.ModTime()
	ignoreCache.mu.Lock()
	defer ignoreCache.mu.Unlock()
	if c := ignoreCache.items[path]; c != nil && c.modTime.Equal(mt) {
		return c.rules
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	rules := &IgnoreRules{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		r := ignoreRule{}
		if strings.HasPrefix(line, "!") {
			r.negate = true
			line = strings.TrimSpace(line[1:])
		}
		line = strings.TrimPrefix(line, "/") // 开头的 / 视为相对根
		line = strings.TrimSuffix(line, "/") // 尾部 / 是目录标记，去掉
		if line == "" || line == "#" {
			continue
		}
		r.byName = !strings.Contains(line, "/")
		r.pattern = line
		rules.rules = append(rules.rules, r)
	}
	ignoreCache.items[path] = &cachedIgnore{modTime: mt, rules: rules}
	return rules
}

// match 判断单条规则是否命中当前条目（name 为条目名，rel 为相对扫描根的路径）。
func (r ignoreRule) match(name, rel string) bool {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if r.byName {
		// 按名字匹配路径的每一段——遍历到任意层级的同名目录都会命中；
		// rg 路径只有文件全路径，也靠这里逐段判断。
		for _, seg := range strings.Split(rel, "/") {
			if globMatchPath(r.pattern, seg, seg) {
				return true
			}
		}
		return globMatchPath(r.pattern, name, name)
	}
	// 路径规则：匹配完整路径，也匹配任意一级父目录前缀（排除整个子树）。
	// globMatchPath 是整串精确匹配，不逐前缀就会漏掉目录下的文件。
	parts := strings.Split(rel, "/")
	for i := 1; i <= len(parts); i++ {
		if globMatchPath(r.pattern, strings.Join(parts[:i], "/"), parts[i-1]) {
			return true
		}
	}
	return false
}

// shouldSkip 按规则顺序判断，后匹配覆盖先匹配（! 取反 = 重新包含）。
func (rs *IgnoreRules) shouldSkip(name, rel string) bool {
	if rs == nil || len(rs.rules) == 0 {
		return false
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	if rel == "" || rel == "." || rel == "/" {
		return false // 根自身永不跳过
	}
	excluded := false
	for _, r := range rs.rules {
		if r.match(name, rel) {
			excluded = !r.negate
		}
	}
	return excluded
}

// ShouldSkipDir / ShouldSkipFile 供搜索三路径与目录树调用，语义一致。
func (rs *IgnoreRules) ShouldSkipDir(name, rel string) bool  { return rs.shouldSkip(name, rel) }
func (rs *IgnoreRules) ShouldSkipFile(name, rel string) bool { return rs.shouldSkip(name, rel) }

// globArgs 把排除规则转成 rg 的 --glob 参数（尽力剪枝；真正口径由 skipRgHit 按规则二次过滤保底，
// 因为 Windows 上 rg 的路径型 glob 分隔符语义不可靠）。取反规则不在这里转成正向 glob：
// rg 的正向 glob 会切换成白名单模式，误把未被取反的普通文件也排除掉。
func (rs *IgnoreRules) globArgs() []string {
	if rs == nil || len(rs.rules) == 0 {
		return nil
	}
	var args []string
	for _, r := range rs.rules {
		if r.negate {
			continue
		}
		if r.byName {
			args = append(args, "--glob", "!"+r.pattern, "--glob", "!**/"+r.pattern)
		} else {
			args = append(args, "--glob", "!"+r.pattern)
		}
	}
	return args
}

// hasNegated 是否存在重新包含规则；有则 rg 需额外跑一趟只扫描被重新包含的路径。
func (rs *IgnoreRules) hasNegated() bool {
	if rs == nil {
		return false
	}
	for _, r := range rs.rules {
		if r.negate {
			return true
		}
	}
	return false
}

// negatedGlobArgs 把取反规则转成 rg 正向 glob，供独立补扫使用。目录必须同时给出
// 子树 glob：rg 的 foo 只匹配目录本身，foo/bar 不会命中，必须显式写 foo/**。
func (rs *IgnoreRules) negatedGlobArgs() []string {
	if rs == nil || len(rs.rules) == 0 {
		return nil
	}
	var args []string
	for _, r := range rs.rules {
		if !r.negate {
			continue
		}
		patterns := []string{r.pattern}
		if r.byName {
			patterns = append(patterns, "**/"+r.pattern)
		}
		for _, pattern := range patterns {
			args = append(args, "--glob", pattern)
			if !strings.HasSuffix(pattern, "/**") {
				args = append(args, "--glob", pattern+"/**")
			}
		}
	}
	return args
}
