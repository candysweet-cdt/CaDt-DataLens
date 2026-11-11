package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	searchMaxFileSize   = 4 << 20
	searchMaxLineBytes  = 1 << 20
	searchMaxResults    = 400
	searchMaxPerFile    = 30
	searchBudget        = 3500 * time.Millisecond
	searchPreviewBefore = 60
	searchPreviewAfter  = 140
)

var searchSkipDirs = map[string]bool{
	".git": true, ".svn": true, ".hg": true,
	".idea": true, ".vscode": true,
	"node_modules": true, "__pycache__": true,
	".pytest_cache": true, ".mypy_cache": true,
	".gradle": true, ".cache": true,
}

var searchBinaryExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".jfif": true, ".gif": true,
	".bmp": true, ".ico": true, ".webp": true, ".tif": true, ".tiff": true,
	".psd": true, ".avif": true, ".heic": true, ".raw": true,
	".pdf": true, ".zip": true, ".7z": true, ".rar": true, ".gz": true,
	".tar": true, ".bz2": true, ".xz": true, ".exe": true, ".dll": true,
	".so": true, ".dylib": true, ".bin": true, ".pyc": true, ".pyo": true,
	".class": true, ".jar": true, ".war": true, ".mp3": true, ".mp4": true,
	".wav": true, ".ogg": true, ".flac": true, ".woff": true, ".woff2": true,
	".ttf": true, ".otf": true, ".eot": true, ".sqlite": true, ".db": true,
	".wgt": true, ".pak": true, ".zipx": true,
}

type SearchHit struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Dir        string `json:"dir"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	Length     int    `json:"length"`
	Preview    string `json:"preview"`
	MatchStart int    `json:"matchStart"`
	MatchEnd   int    `json:"matchEnd"`
}

type SearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
	Files     int         `json:"files"`
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func buildSearchPreview(line string, byteIdx, byteLen int) (string, int, int) {
	if byteIdx < 0 {
		byteIdx = 0
	}
	if byteIdx > len(line) {
		byteIdx = len(line)
	}
	if byteIdx+byteLen > len(line) {
		byteLen = len(line) - byteIdx
	}
	startByte := byteIdx
	for n := 0; n < searchPreviewBefore && startByte > 0; n++ {
		_, size := utf8.DecodeLastRuneInString(line[:startByte])
		startByte -= size
	}
	endByte := byteIdx + byteLen
	for n := 0; n < searchPreviewAfter && endByte < len(line); n++ {
		_, size := utf8.DecodeRuneInString(line[endByte:])
		endByte += size
	}
	prefix := startByte > 0
	suffix := endByte < len(line)
	var b strings.Builder
	b.Grow(endByte - startByte + 8)
	if prefix {
		b.WriteRune('…')
	}
	b.WriteString(line[startByte:endByte])
	if suffix {
		b.WriteRune('…')
	}
	start := utf16Len(line[startByte:byteIdx])
	if prefix {
		start++
	}
	end := start + utf16Len(line[byteIdx:byteIdx+byteLen])
	return b.String(), start, end
}

func isASCIIString(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func asciiLowerByte(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

// indexFoldASCII 在纯 ASCII 文本上做大小写不敏感查找，避免逐行 strings.ToLower 分配。
func indexFoldASCII(s, needle string) int {
	if needle == "" {
		return 0
	}
	first := asciiLowerByte(needle[0])
	for i := 0; i+len(needle) <= len(s); i++ {
		if asciiLowerByte(s[i]) != first {
			continue
		}
		match := true
		for j := 1; j < len(needle); j++ {
			if asciiLowerByte(s[i+j]) != asciiLowerByte(needle[j]) {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

type searchFileJob struct {
	path   string
	name   string
	relDir string
}

type searchFileResult struct {
	hits       []SearchHit
	scanned    bool
	overBudget bool
}

func scanSearchFile(job searchFileJob, needle string, needleASCII, caseSensitive bool, deadline time.Time) searchFileResult {
	var out searchFileResult
	if time.Now().After(deadline) {
		out.overBudget = true
		return out
	}
	f, err := os.Open(job.path)
	if err != nil {
		return out
	}
	defer f.Close()
	head := make([]byte, 8192)
	n, _ := f.Read(head)
	if bytes.IndexByte(head[:n], 0) >= 0 {
		return out
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return out
	}
	out.scanned = true
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 32*1024), searchMaxLineBytes)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		if lineNo%512 == 0 && time.Now().After(deadline) {
			out.overBudget = true
			break
		}
		line := scanner.Text()
		if lineNo == 1 {
			line = strings.TrimPrefix(line, "\uFEFF")
		}
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		foldASCII := !caseSensitive && needleASCII && isASCIIString(line)
		haystack := line
		if !caseSensitive && !foldASCII {
			haystack = strings.ToLower(line)
		}
		searchFrom := 0
		for {
			var idx int
			if foldASCII {
				idx = indexFoldASCII(haystack[searchFrom:], needle)
			} else {
				idx = strings.Index(haystack[searchFrom:], needle)
			}
			if idx < 0 {
				break
			}
			idx += searchFrom
			preview, mStart, mEnd := buildSearchPreview(line, idx, len(needle))
			out.hits = append(out.hits, SearchHit{
				Path:       job.path,
				Name:       job.name,
				Dir:        job.relDir,
				Line:       lineNo,
				Column:     utf16Len(line[:idx]) + 1,
				Length:     utf16Len(line[idx : idx+len(needle)]),
				Preview:    preview,
				MatchStart: mStart,
				MatchEnd:   mEnd,
			})
			if len(out.hits) >= searchMaxPerFile {
				return out
			}
			searchFrom = idx + len(needle)
			if searchFrom >= len(haystack) {
				break
			}
		}
	}
	return out
}

// SearchWorkspace 流式扫描工作区文本文件，不建索引；命中数/单文件命中/耗时均有限额。
func (a *App) SearchWorkspace(root, query string, caseSensitive bool, maxResults int) (*SearchResult, error) {
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
	if query == "" {
		return &SearchResult{}, nil
	}
	if maxResults <= 0 || maxResults > 1000 {
		maxResults = searchMaxResults
	}
	if os.Getenv("DATALENS_NO_RG") == "" {
		if res, ok := searchWithRipgrep(root, query, caseSensitive, maxResults); ok {
			return res, nil
		}
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(query)
	}
	needleASCII := isASCIIString(needle)
	started := time.Now()
	deadline := started.Add(searchBudget)
	jobs := make([]searchFileJob, 0, 256)
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if path != root && (searchSkipDirs[strings.ToLower(name)] || name == ".git") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if searchBinaryExt[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		if info, err := d.Info(); err != nil || info.Size() > searchMaxFileSize {
			return nil
		}
		relDir := filepath.Dir(path)
		if rel, err := filepath.Rel(root, relDir); err == nil {
			relDir = rel
		}
		if relDir == "." || relDir == "" {
			relDir = filepath.Base(root)
		}
		jobs = append(jobs, searchFileJob{path: path, name: name, relDir: relDir})
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipAll {
		return nil, walkErr
	}
	result := &SearchResult{}
	if len(jobs) == 0 {
		return result, nil
	}
	workers := runtime.NumCPU()
	if workers > len(jobs) {
		workers = len(jobs)
	}
	if workers > 16 {
		workers = 16
	}
	perFile := make([][]SearchHit, len(jobs))
	var filesScanned int64
	var totalHits int64
	var stop atomic.Bool
	var truncated atomic.Bool
	jobCh := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobCh {
				if stop.Load() {
					continue
				}
				res := scanSearchFile(jobs[idx], needle, needleASCII, caseSensitive, deadline)
				if res.scanned {
					atomic.AddInt64(&filesScanned, 1)
				}
				if res.overBudget {
					truncated.Store(true)
					stop.Store(true)
				}
				if len(res.hits) > 0 {
					perFile[idx] = res.hits
					if atomic.AddInt64(&totalHits, int64(len(res.hits))) >= int64(maxResults) {
						truncated.Store(true)
						stop.Store(true)
					}
				}
			}
		}()
	}
	feedStopped := false
	for idx := range jobs {
		if stop.Load() {
			feedStopped = true
			break
		}
		if time.Now().After(deadline) {
			truncated.Store(true)
			feedStopped = true
			break
		}
		jobCh <- idx
	}
	close(jobCh)
	wg.Wait()
	if feedStopped {
		truncated.Store(true)
	}
merge:
	for idx := range perFile {
		for _, hit := range perFile[idx] {
			if len(result.Hits) >= maxResults {
				truncated.Store(true)
				break merge
			}
			result.Hits = append(result.Hits, hit)
		}
	}
	result.Files = int(filesScanned)
	result.Truncated = truncated.Load()
	return result, nil
}
