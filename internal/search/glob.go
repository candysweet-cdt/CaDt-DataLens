package search

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// 文件发现（AI 的 glob 工具）：按通配列文件名与大小，不读文件内容。
//
// 匹配语义与前端 frontend/src/ai/ai-file-tools.js 的 globMatchPath 保持一致：
// * 任意串（不跨目录）、** 跨目录、? 单字符；模式含 "/" 时匹配相对路径，否则只匹配文件名；
// 大小写不敏感（Windows 语义）。两边用例互相对齐，改动时同步（glob_test.go / ai-file-tools.test.mjs）。
// 目录跳过表与时间预算复用 search.go，避免一次 glob 把大仓库遍历拖成卡顿。

const (
	findFilesDefaultMax     = 300
	findFilesHardMax        = 1000
	findFilesDefaultPattern = "*"
)

type FileMatch struct {
	Path string `json:"path"` // 相对 root，斜杠分隔
	Name string `json:"name"`
	Dir  string `json:"dir"` // 相对 root 的父目录（根目录下为空串）
	Size int64  `json:"size"`
}

type FindFilesResult struct {
	Files     []FileMatch `json:"files"`
	Truncated bool        `json:"truncated"`
	Scanned   int         `json:"scanned"` // 实际遍历到的文件数（含未命中）
}

// globMatchPath 通配匹配；空模式视为全匹配，非法模式同样按「不过滤」处理。
// 注：字面字符一律 QuoteMeta，构建出的正则恒可编译——「非法模式」实际不可达，兜底保留。
func globMatchPath(pattern, relPath, name string) bool {
	pat := strings.TrimSpace(pattern)
	if pat == "" {
		return true
	}
	subject := strings.ReplaceAll(relPath, "\\", "/")
	target := subject
	if !strings.Contains(pat, "/") {
		if name != "" {
			target = name
		} else if idx := strings.LastIndex(subject, "/"); idx >= 0 {
			target = subject[idx+1:]
		}
	}
	var b strings.Builder
	b.WriteString("(?i)^")
	// **/ 要能匹配「零个目录段」（src/**/*.js 命中 src/a.js），单独的 ** 才跨任意字符
	wildcard := strings.ReplaceAll(pat, "**/", "\x01")
	wildcard = strings.ReplaceAll(wildcard, "**", "\x00")
	for _, ch := range wildcard {
		switch ch {
		case '\x01':
			b.WriteString("(?:.*/)?")
		case '\x00':
			b.WriteString(".*")
		case '*':
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	b.WriteString("$")
	re := globRegexp(b.String())
	if re == nil {
		// 非法模式按「不过滤」处理：一次坏参数不该让整次发现失败
		return true
	}
	return re.MatchString(target)
}

// globRegexpCache 缓存「模式 → 编译好的正则」：globMatchPath 按候选文件逐个调用，
// 每次重新 regexp.Compile 会让一次目录遍历付出成千上万次编译。上限之外简单清空
// （个人使用量级，模式数通常只有个位数）。
var (
	globRegexpMu    sync.Mutex
	globRegexpCache = map[string]*regexp.Regexp{}
)

const globRegexpCacheMax = 256

func globRegexp(expr string) *regexp.Regexp {
	globRegexpMu.Lock()
	defer globRegexpMu.Unlock()
	if re, ok := globRegexpCache[expr]; ok {
		return re
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil
	}
	if len(globRegexpCache) >= globRegexpCacheMax {
		globRegexpCache = map[string]*regexp.Regexp{}
	}
	globRegexpCache[expr] = re
	return re
}

// FindFiles 遍历工作区列出匹配通配的文件（相对 root，按路径排序）。
// 预算：searchBudget 墙钟、findFilesHardMax 条上限、跳过默认软忽略与用户 search-ignore。
func (s *Searcher) FindFiles(root, pattern string, maxResults int) (*FindFilesResult, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("未打开工作区目录")
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		root = filepath.Dir(root)
	}
	pat := strings.TrimSpace(pattern)
	if pat == "" {
		pat = findFilesDefaultPattern
	}
	if maxResults <= 0 || maxResults > findFilesHardMax {
		maxResults = findFilesDefaultMax
	}
	deadline := time.Now().Add(searchBudget)
	ignore := LoadIgnoreRules(root)
	result := &FindFilesResult{Files: []FileMatch{}}
	visited := 0
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if path != root {
				rel, relErr := filepath.Rel(root, path)
				// 与 searchWorkspace 同口径：AI 隔离 worktree 副本整棵跳过（硬编码）
				if relErr == nil && SkipPath(rel) {
					return filepath.SkipDir
				}
				if relErr == nil && ignore.ShouldSkipDir(name, filepath.ToSlash(rel)) {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr == nil && ignore.ShouldSkipFile(name, filepath.ToSlash(rel)) {
			return nil
		}
		if relErr != nil {
			rel = name
		}
		rel = filepath.ToSlash(rel)
		visited++
		if visited%256 == 0 && time.Now().After(deadline) {
			result.Truncated = true
			return filepath.SkipAll
		}
		if !globMatchPath(pat, rel, name) {
			return nil
		}
		size := int64(0)
		if fi, statErr := d.Info(); statErr == nil {
			size = fi.Size()
		}
		dir := filepath.ToSlash(filepath.Dir(rel))
		if dir == "." {
			dir = ""
		}
		result.Files = append(result.Files, FileMatch{Path: rel, Name: name, Dir: dir, Size: size})
		if len(result.Files) >= maxResults {
			result.Truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipAll {
		return nil, walkErr
	}
	result.Scanned = visited
	sort.SliceStable(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	return result, nil
}
