package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type rgMessage struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

func rgGlobalArgs(query string, caseSensitive bool) []string {
	args := []string{
		"--json", "--no-config", "--no-messages", "--color", "never",
		"--max-filesize", "4M",
		"--max-count", strconv.Itoa(searchMaxPerFile),
		"--hidden",
		// Windows 上 rg 的路径是反斜杠，目录排除用组件名匹配才可靠
		"--glob", "!.git", "--glob", "!.svn", "--glob", "!.hg",
		"--glob", "!.idea", "--glob", "!.vscode",
		"--glob", "!node_modules", "--glob", "!__pycache__",
		"--glob", "!.pytest_cache", "--glob", "!.mypy_cache",
		"--glob", "!.gradle", "--glob", "!.cache",
		"-F",
	}
	if !caseSensitive {
		args = append(args, "-i")
	}
	return append(args, "--", query)
}

// searchWithRipgrep 用用户自带的 rg 做搜索；第二个返回值表示是否可用，
// 不可用（未安装/无法启动/歧义失败）时应退回内置扫描。
func searchWithRipgrep(root, query string, caseSensitive bool, maxResults int) (*SearchResult, bool) {
	rgPath, err := exec.LookPath("rg")
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), searchBudget)
	defer cancel()
	args := append(rgGlobalArgs(query, caseSensitive), root)
	cmd := exec.CommandContext(ctx, rgPath, args...)
	hideCommandWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false
	}
	if err := cmd.Start(); err != nil {
		return nil, false
	}
	result := &SearchResult{}
	files := map[string]bool{}
	hitsPerFile := map[string]int{}
	truncated := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
loop:
	for scanner.Scan() {
		var msg rgMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.Type != "match" {
			continue
		}
		path := msg.Data.Path.Text
		name := filepath.Base(path)
		line := strings.TrimRight(msg.Data.Lines.Text, "\r\n")
		relDir := filepath.Dir(path)
		if rel, err := filepath.Rel(root, relDir); err == nil {
			relDir = rel
		}
		if relDir == "." || relDir == "" {
			relDir = filepath.Base(root)
		}
		for _, sub := range msg.Data.Submatches {
			if sub.Start < 0 || sub.End > len(line) || sub.Start >= sub.End {
				continue
			}
			if hitsPerFile[path] >= searchMaxPerFile {
				continue
			}
			if len(result.Hits) >= maxResults {
				truncated = true
				break loop
			}
			preview, matchStart, matchEnd := buildSearchPreview(line, sub.Start, sub.End-sub.Start)
			result.Hits = append(result.Hits, SearchHit{
				Path:       path,
				Name:       name,
				Dir:        relDir,
				Line:       msg.Data.LineNumber,
				Column:     utf16Len(line[:sub.Start]) + 1,
				Length:     utf16Len(line[sub.Start:sub.End]),
				Preview:    preview,
				MatchStart: matchStart,
				MatchEnd:   matchEnd,
			})
			hitsPerFile[path]++
			files[path] = true
		}
	}
	waitErr := cmd.Wait()
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if timedOut {
		truncated = true
	}
	if waitErr != nil && !timedOut {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1 {
			result.Files = len(files)
			result.Truncated = false
			return result, true
		}
		if len(result.Hits) == 0 {
			return nil, false
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && len(result.Hits) == 0 && !timedOut {
		return nil, false
	}
	sort.SliceStable(result.Hits, func(i, j int) bool {
		a, b := result.Hits[i], result.Hits[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Column < b.Column
	})
	result.Files = len(files)
	result.Truncated = truncated || len(result.Hits) >= maxResults
	return result, true
}
