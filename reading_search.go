package main

// 阅读模式全书搜索（docs/finished-plans/reading-mode.md §11.2）：
// 不建全文索引、不进 SQLite，按预算即时扫描；支持取消与超时；进度经
// runtime.EventsEmit("reading-search-progress") 推送。只读实现。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	readingSearchDefaultMaxFiles     = 2000
	readingSearchDefaultMaxFileBytes = int64(20 << 20)
	readingSearchDefaultMaxResults   = 200
	readingSearchDefaultTimeoutMS    = 15000
	readingSearchDefaultContext      = 30
)

// ReadingSearchOptions 搜索预算。
type ReadingSearchOptions struct {
	MaxFiles     int   `json:"maxFiles"`
	MaxFileBytes int64 `json:"maxFileBytes"`
	MaxResults   int   `json:"maxResults"`
	TimeoutMS    int   `json:"timeoutMs"`
	ContextRunes int   `json:"contextRunes"`
}

// ReadingSearchHit 单个命中。
type ReadingSearchHit struct {
	Rel        string `json:"rel"`
	Offset     int    `json:"offset"` // 行/块
	Before     string `json:"before"`
	Match      string `json:"match"`
	After      string `json:"after"`
	UnitOffset int    `json:"unitOffset"` // 最近的标题起始
	UnitTitle  string `json:"unitTitle"`  // 最近标题文本
}

// ReadingSearchResult 搜索结果。
type ReadingSearchResult struct {
	Hits         []ReadingSearchHit `json:"hits"`
	FilesScanned int                `json:"filesScanned"`
	FilesTotal   int                `json:"filesTotal"`
	Truncated    bool               `json:"truncated"`
	ElapsedMS    int64              `json:"elapsedMs"`
}

var readingSearchCancels = struct {
	sync.Mutex
	m map[string]*atomic.Int32
}{m: map[string]*atomic.Int32{}}

func normalizeReadingSearchOptions(opts ReadingSearchOptions) ReadingSearchOptions {
	if opts.MaxFiles <= 0 {
		opts.MaxFiles = readingSearchDefaultMaxFiles
	}
	if opts.MaxFileBytes <= 0 {
		opts.MaxFileBytes = readingSearchDefaultMaxFileBytes
	}
	if opts.MaxResults <= 0 {
		opts.MaxResults = readingSearchDefaultMaxResults
	}
	if opts.TimeoutMS <= 0 {
		opts.TimeoutMS = readingSearchDefaultTimeoutMS
	}
	if opts.ContextRunes <= 0 {
		opts.ContextRunes = readingSearchDefaultContext
	}
	return opts
}

// CancelReadingSearch 取消一次进行中的全书搜索。
func (a *App) CancelReadingSearch(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	readingSearchCancels.Lock()
	flag := readingSearchCancels.m[requestID]
	readingSearchCancels.Unlock()
	if flag != nil {
		flag.Store(1)
	}
}

// SearchReadingBook 全书搜索：目录（md/txt/docx）或单个 epub 文件。
func (a *App) SearchReadingBook(requestID, root, query string, opts ReadingSearchOptions) (*ReadingSearchResult, error) {
	opts = normalizeReadingSearchOptions(opts)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("搜索词为空")
	}
	abs, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	cancelFlag := &atomic.Int32{}
	requestID = strings.TrimSpace(requestID)
	if requestID != "" {
		readingSearchCancels.Lock()
		readingSearchCancels.m[requestID] = cancelFlag
		readingSearchCancels.Unlock()
		defer func() {
			readingSearchCancels.Lock()
			delete(readingSearchCancels.m, requestID)
			readingSearchCancels.Unlock()
		}()
	}
	start := time.Now()
	result := &ReadingSearchResult{}
	folded := foldReadingText(query)
	folded.ctx = opts.ContextRunes
	if folded.len() == 0 {
		return nil, fmt.Errorf("搜索词为空")
	}
	var items []readingWalkItem
	if info.Mode().IsRegular() {
		items = []readingWalkItem{{path: abs, rel: info.Name(), info: info}}
	} else {
		items = collectReadingFiles(abs, ReadingScanOptions{
			MaxFiles:     opts.MaxFiles,
			MaxFileBytes: opts.MaxFileBytes,
			MaxDepth:     readingDefaultMaxDepth,
		}, nil)
	}
	result.FilesTotal = len(items)
	lastEmit := time.Time{}
	for _, item := range items {
		if cancelFlag.Load() != 0 {
			result.Truncated = true
			break
		}
		if time.Since(start).Milliseconds() > int64(opts.TimeoutMS) {
			result.Truncated = true
			break
		}
		if item.info.Size() > opts.MaxFileBytes {
			continue
		}
		result.FilesScanned++
		if strings.EqualFold(filepath.Ext(item.rel), ".epub") {
			// 单 epub 书按解压文本搜索；目录内的 epub v1 不参与搜索
			if filepath.Clean(item.path) == filepath.Clean(abs) {
				searchEpubChapterText(abs, folded, opts, result)
			}
		} else {
			searchReadingTextOrDocx(item.path, item.rel, folded, opts, result)
		}
		if requestID != "" && a.ctx != nil && time.Since(lastEmit) > 100*time.Millisecond {
			lastEmit = time.Now()
			runtime.EventsEmit(a.ctx, "reading-search-progress", map[string]interface{}{
				"requestID": requestID,
				"scanned":   result.FilesScanned,
				"total":     result.FilesTotal,
			})
		}
		if len(result.Hits) >= opts.MaxResults {
			result.Truncated = true
			break
		}
	}
	result.Hits = result.Hits[:min(len(result.Hits), opts.MaxResults)]
	result.ElapsedMS = time.Since(start).Milliseconds()
	return result, nil
}

// searchReadingTextOrDocx 文本文件按行搜，docx 按块搜。
func searchReadingTextOrDocx(path, rel string, query foldedQuery, opts ReadingSearchOptions, result *ReadingSearchResult) {
	if strings.EqualFold(filepath.Ext(path), ".docx") {
		blocks, err := parseReadingDocxFile(path)
		if err != nil {
			return
		}
		var headings []ReadingHeading
		texts := make([]string, len(blocks))
		for i, b := range blocks {
			texts[i] = b.PlainText()
			if b.Kind >= "h1" && b.Kind <= "h6" {
				headings = append(headings, ReadingHeading{Offset: i + 1, Title: strings.TrimSpace(b.Text)})
			}
		}
		unitIdx := 0
		for i, text := range texts {
			unitIdx = advanceReadingUnit(headings, unitIdx, i+1)
			for _, m := range query.findAll(text) {
				result.Hits = append(result.Hits, ReadingSearchHit{
					Rel:        rel,
					Offset:     i + 1,
					Before:     m.before,
					Match:      m.match,
					After:      m.after,
					UnitOffset: unitOffset(headings, unitIdx),
					UnitTitle:  unitTitle(headings, unitIdx),
				})
				if len(result.Hits) >= opts.MaxResults {
					return
				}
			}
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	text, _, err := decodeReadingText(raw)
	if err != nil {
		return
	}
	lines := splitReadingLines(text)
	var headings []ReadingHeading
	if strings.EqualFold(filepath.Ext(path), ".txt") {
		headings = scanTxtHeadings(lines, 5000)
	} else {
		headings = scanMdHeadings(lines, 5000)
	}
	unitIdx := 0
	for i, line := range lines {
		unitIdx = advanceReadingUnit(headings, unitIdx, i+1)
		for _, m := range query.findAll(line) {
			result.Hits = append(result.Hits, ReadingSearchHit{
				Rel:        rel,
				Offset:     i + 1,
				Before:     m.before,
				Match:      m.match,
				After:      m.after,
				UnitOffset: unitOffset(headings, unitIdx),
				UnitTitle:  unitTitle(headings, unitIdx),
			})
			if len(result.Hits) >= opts.MaxResults {
				return
			}
		}
	}
}

// searchEpubChapterText 单 epub 书：搜解压后的章节文本。
func searchEpubChapterText(abs string, query foldedQuery, opts ReadingSearchOptions, result *ReadingSearchResult) {
	meta, err := prepareReadingEpub(abs)
	if err != nil {
		return
	}
	for _, ch := range meta.Chapters {
		if len(result.Hits) >= opts.MaxResults {
			return
		}
		raw, err := os.ReadFile(filepath.Join(meta.CacheDir, filepath.FromSlash(ch.Href)))
		if err != nil {
			continue
		}
		text := epubTextContent(string(raw))
		for _, m := range query.findAll(text) {
			result.Hits = append(result.Hits, ReadingSearchHit{
				Rel:        filepath.Base(abs),
				Offset:     ch.Index + 1,
				Before:     m.before,
				Match:      m.match,
				After:      m.after,
				UnitOffset: ch.Index + 1,
				UnitTitle:  ch.Title,
			})
			if len(result.Hits) >= opts.MaxResults {
				return
			}
		}
	}
}

// --- 大小写不敏感匹配（rune 级折叠，保留原文位置） ---

type foldedQuery struct {
	runes    []rune
	queryRun []rune
	ctx      int
}

func foldReadingText(s string) foldedQuery {
	runes := []rune(s)
	return foldedQuery{runes: runes, queryRun: runes, ctx: readingSearchDefaultContext}
}

func (f foldedQuery) len() int { return len(f.runes) }

type readingMatch struct {
	before string
	match  string
	after  string
}

// findAll 在 text 中找全部命中（大小写不敏感），返回原文上下文。
func (f foldedQuery) findAll(text string) []readingMatch {
	if f.len() == 0 || text == "" {
		return nil
	}
	src := []rune(text)
	folded := make([]rune, len(src))
	for i, r := range src {
		folded[i] = unicodeToLower(r)
	}
	n := len(f.queryRun)
	if n == 0 {
		return nil
	}
	var matches []readingMatch
	for i := 0; i+n <= len(folded); i++ {
		ok := true
		for j := 0; j < n; j++ {
			if folded[i+j] != f.queryRun[j] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		lo, hi := i-f.ctx, i+n+f.ctx
		if lo < 0 {
			lo = 0
		}
		if hi > len(src) {
			hi = len(src)
		}
		matches = append(matches, readingMatch{
			before: string(src[lo:i]),
			match:  string(src[i : i+n]),
			after:  string(src[i+n : hi]),
		})
		if len(matches) >= 64 { // 单行命中上限，避免 pathological 行
			break
		}
	}
	return matches
}

func unicodeToLower(r rune) rune {
	if r >= 'A' && r <= 'Z' {
		return r + 32
	}
	return r
}

// advanceReadingUnit 在标题列表中推进指针：返回 offset 行之前最后一个标题的下标。
// 返回值约定：0 = 无标题；k>0 = headings[k-1] 为当前单元标题。
func advanceReadingUnit(headings []ReadingHeading, idx, offset int) int {
	for idx < len(headings) && headings[idx].Offset <= offset {
		idx++
	}
	return idx
}

func unitOffset(headings []ReadingHeading, idx int) int {
	if idx <= 0 || idx > len(headings) {
		return 1
	}
	return headings[idx-1].Offset
}

func unitTitle(headings []ReadingHeading, idx int) string {
	if idx <= 0 || idx > len(headings) {
		return ""
	}
	return headings[idx-1].Title
}
