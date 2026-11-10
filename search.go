package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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
	runes := []rune(line)
	runeStart := utf8.RuneCountInString(line[:byteIdx])
	matchRunes := utf8.RuneCountInString(line[byteIdx : byteIdx+byteLen])
	from := runeStart - searchPreviewBefore
	if from < 0 {
		from = 0
	}
	to := runeStart + matchRunes + searchPreviewAfter
	if to > len(runes) {
		to = len(runes)
	}
	window := runes[from:to]
	start := runeStart - from
	if from > 0 {
		window = append([]rune{'…'}, window...)
		start++
	}
	if to < len(runes) {
		window = append(window, '…')
	}
	end := start + matchRunes
	return string(window), utf16Len(string(window[:start])), utf16Len(string(window[:end]))
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
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(query)
	}
	started := time.Now()
	result := &SearchResult{}
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
		if len(result.Hits) >= maxResults || (result.Files%200 == 0 && time.Since(started) > searchBudget) {
			result.Truncated = true
			return filepath.SkipAll
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		head := make([]byte, 8192)
		n, _ := f.Read(head)
		if bytes.IndexByte(head[:n], 0) >= 0 {
			f.Close()
			return nil
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			f.Close()
			return nil
		}
		result.Files++
		relDir := filepath.Dir(path)
		if rel, err := filepath.Rel(root, relDir); err == nil {
			relDir = rel
		}
		if relDir == "." || relDir == "" {
			relDir = filepath.Base(root)
		}
		fileHits := 0
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 32*1024), searchMaxLineBytes)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			line := scanner.Text()
			if lineNo == 1 {
				line = strings.TrimPrefix(line, "\uFEFF")
			}
			line = strings.TrimSuffix(line, "\r")
			if line == "" {
				continue
			}
			haystack := line
			if !caseSensitive {
				haystack = strings.ToLower(line)
			}
			searchFrom := 0
			for {
				idx := strings.Index(haystack[searchFrom:], needle)
				if idx < 0 {
					break
				}
				idx += searchFrom
				preview, mStart, mEnd := buildSearchPreview(line, idx, len(needle))
				hit := SearchHit{
					Path:       path,
					Name:       name,
					Dir:        relDir,
					Line:       lineNo,
					Column:     utf16Len(line[:idx]) + 1,
					Length:     utf16Len(line[idx : idx+len(needle)]),
					Preview:    preview,
					MatchStart: mStart,
					MatchEnd:   mEnd,
				}
				result.Hits = append(result.Hits, hit)
				fileHits++
				if len(result.Hits) >= maxResults || fileHits >= searchMaxPerFile {
					if len(result.Hits) >= maxResults {
						result.Truncated = true
					}
					break
				}
				searchFrom = idx + len(needle)
				if searchFrom >= len(haystack) {
					break
				}
			}
			if len(result.Hits) >= maxResults || fileHits >= searchMaxPerFile {
				break
			}
		}
		f.Close()
		if len(result.Hits) >= maxResults {
			result.Truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipAll {
		return nil, walkErr
	}
	return result, nil
}