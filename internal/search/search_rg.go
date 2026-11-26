package search

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/executil"
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

func rgGlobalArgs(spec *searchSpec, artifactOnly, negatedPass bool) []string {
	args := []string{
		"--json", "--no-config", "--no-messages", "--color", "never",
		"--max-filesize", "4M",
		"--max-count", strconv.Itoa(searchMaxPerFile),
		"--hidden",
		// 默认软忽略目录（.git / node_modules / .venv 等）与用户 search-ignore 统一由
		// spec.ignore.globArgs() 生成（见下方），真正口径由 skipRgHit 二次过滤保底。
		// 取反规则走独立补扫，不能把正向 glob 混进本趟——否则 rg 会进入白名单模式，
		// 把未被取反的普通文件也排除掉。
		// AI 隔离 worktree：目录与子树双保险（尽力剪枝；Windows 上路径型 glob 不可靠，
		// runRgPass 里另有 skipRgHit 按 SkipPath 二次过滤保底）。口径与 search.go 的
		// SkipPath 一致（含 .cadt/tmp 不受影响）。
		"--glob", "!.cadt/worktree", "--glob", "!.cadt/worktree/**",
	}
	// 字面量模式用 -F（固定串）；正则模式去掉 -F，pattern 由 rg 自己按正则解释。
	if !spec.regex {
		args = append(args, "-F")
	}
	if !spec.caseSensitive {
		args = append(args, "-i")
	}
	if spec.wholeWord {
		args = append(args, "-w")
	}
	if spec.context > 0 {
		args = append(args, "-C", strconv.Itoa(spec.context))
	}
	// 文件名/路径通配下推给 rg（-g 的语义与 globMatchPath 基本一致：含 / 按路径、否则按文件名）。
	// 取反补扫只把取反目标作为正向 glob，其余条件在 Go 侧过滤，避免两个白名单取并集。
	if !negatedPass && spec.pattern != "" {
		args = append(args, "--glob", spec.pattern)
	}
	// 产物档拆两趟：源码趟按组件名排除产物目录/后缀，产物趟用 `**/` 前缀包含任意层级。
	// 表与 search.go 的 searchArtifactDirs / searchArtifactSuffixes 单一来源，改表即两边同步。
	// FileOnly（用户点名单个文件）不分档：不管它在不在 dist/build 下都当源码扫。
	if !spec.fileOnly && !negatedPass {
		for _, dir := range searchArtifactDirs {
			if artifactOnly {
				args = append(args, "--glob", "**/"+dir+"/**")
			} else {
				args = append(args, "--glob", "!"+dir)
			}
		}
		for _, suffix := range searchArtifactSuffixes {
			if artifactOnly {
				args = append(args, "--glob", "**/*"+suffix)
			} else {
				args = append(args, "--glob", "!*"+suffix)
			}
		}
	}
	// 排除通配放在最后：rg 的 glob 后者覆盖前者，确保产物档的「包含」不会盖掉用户排除。
	// 取反补扫里改由 Go 侧同时校验 pattern/exclude，避免正向取反 glob 反客为主。
	if !negatedPass && spec.exclude != "" {
		args = append(args, "--glob", "!"+spec.exclude)
	}
	if negatedPass {
		args = append(args, spec.ignore.negatedGlobArgs()...)
	} else {
		args = append(args, spec.ignore.globArgs()...)
	}
	return append(args, "--", spec.query)
}

type rgPass struct {
	hits      []SearchHit
	files     map[string]bool
	truncated bool
	usable    bool
}

type rgPassOptions struct {
	artifactOnly bool
	negatedPass  bool
	hitCap       int
	deadline     time.Time
}

// skipRgHit 过滤 rg 命中路径里的 AI 隔离 worktree 副本与用户排除表命中的文件。
// rg 的路径型 glob 在 Windows 上不可靠（路径分隔符语义随版本差异，见 rgGlobalArgs 注释），
// glob 只是尽力剪枝，这里按 SkipPath + 用户规则二次过滤保底。
// 结果按 path 缓存（同一文件多命中只算一次）。
func skipRgHit(root, path string, ignore *IgnoreRules, cache map[string]bool) bool {
	if cached, ok := cache[path]; ok {
		return cached
	}
	rel := path
	if r, relErr := filepath.Rel(root, path); relErr == nil {
		rel = r
	}
	skip := SkipPath(rel) || ignore.shouldSkip(filepath.Base(path), filepath.ToSlash(rel))
	cache[path] = skip
	return skip
}

// runRgPass 跑一趟 rg 并把命中收齐。artifactOnly 时只收产物档命中——glob 已做包含，
// Go 侧再按分类器过滤一次，避免用户 filePattern 与包含 glob 取并集时混进源码命中。
func runRgPass(rgPath, root string, spec *searchSpec, opts rgPassOptions) rgPass {
	artifactOnly, negatedPass := opts.artifactOnly, opts.negatedPass
	pass := rgPass{files: map[string]bool{}}
	worktreeCache := map[string]bool{}
	contextLines := map[string]map[int]string{}
	remaining := time.Until(opts.deadline)
	if remaining <= 0 || opts.hitCap <= 0 {
		pass.truncated = true
		return pass
	}
	ctx, cancel := context.WithTimeout(context.Background(), remaining)
	defer cancel()
	args := append(rgGlobalArgs(spec, artifactOnly, negatedPass), root)
	cmd := exec.CommandContext(ctx, rgPath, args...)
	executil.HideCommandWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return pass
	}
	if err := cmd.Start(); err != nil {
		return pass
	}
	hitsPerFile := map[string]int{}
	tierCache := map[string]bool{}
	capped := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
loop:
	for scanner.Scan() {
		var msg rgMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		path := msg.Data.Path.Text
		if skipRgHit(root, path, spec.ignore, worktreeCache) {
			continue
		}
		if negatedPass {
			// 补扫只把取反目标交给 rg 白名单；文件名/排除通配与产物分档在 Go 侧
			// 同时生效，避免多个正向 glob 取并集把无关文件带进来。
			rel := path
			if r, err := filepath.Rel(root, path); err == nil {
				rel = r
			}
			rel = filepath.ToSlash(rel)
			name := filepath.Base(path)
			if spec.pattern != "" && !globMatchPath(spec.pattern, rel, name) {
				continue
			}
			if spec.exclude != "" && globMatchPath(spec.exclude, rel, name) {
				continue
			}
			if artifactOnly != searchIsArtifactPath(rel) {
				continue
			}
		}
		if msg.Type == "context" {
			if spec.context > 0 && msg.Data.LineNumber > 0 {
				if contextLines[path] == nil {
					contextLines[path] = map[int]string{}
				}
				contextLines[path][msg.Data.LineNumber] = strings.TrimRight(msg.Data.Lines.Text, "\r\n")
			}
			continue
		}
		if msg.Type != "match" {
			continue
		}
		if artifactOnly && !negatedPass {
			isArtifact, cached := tierCache[path]
			if !cached {
				rel := path
				if r, relErr := filepath.Rel(root, path); relErr == nil {
					rel = r
				}
				isArtifact = searchIsArtifactPath(rel)
				tierCache[path] = isArtifact
			}
			if !isArtifact {
				continue
			}
		}
		name := filepath.Base(path)
		line := strings.TrimRight(msg.Data.Lines.Text, "\r\n")
		relDir := ""
		if spec.fileOnly {
			// 文件根：父目录的相对路径无意义（Rel 会得到 ".."），直接给父目录名
			relDir = filepath.Base(filepath.Dir(root))
		} else {
			relDir = filepath.Dir(path)
			if rel, err := filepath.Rel(root, relDir); err == nil {
				relDir = rel
			}
			if relDir == "." || relDir == "" {
				relDir = filepath.Base(root)
			}
		}
		for _, sub := range msg.Data.Submatches {
			if sub.Start < 0 || sub.End > len(line) || sub.Start >= sub.End {
				continue
			}
			if hitsPerFile[path] >= searchMaxPerFile {
				continue
			}
			if len(pass.hits) >= opts.hitCap {
				pass.truncated = true
				capped = true
				break loop
			}
			preview, matchStart, matchEnd := buildSearchPreview(line, sub.Start, sub.End-sub.Start)
			pass.hits = append(pass.hits, SearchHit{
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
			pass.files[path] = true
		}
	}
	// rg 的 context 消息可能排在 match 之后，扫描结束后按行号统一回填前后文。
	if spec.context > 0 {
		attachContextFromMap(pass.hits, contextLines, spec.context)
	}
	if capped {
		// 命中已截断，不再需要 rg 输出；立即结束进程，避免管道写满后 Wait 拖到 deadline
		cancel()
	}
	waitErr := cmd.Wait()
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if timedOut {
		pass.truncated = true
	}
	if waitErr != nil && !timedOut {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1 {
			pass.usable = true
			return pass
		}
		if len(pass.hits) == 0 {
			return pass
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && len(pass.hits) == 0 && !timedOut {
		return pass
	}
	pass.usable = true
	return pass
}

// mergeRgPasses 合并正常趟与取反补扫，按命中位置去重；截断标记取并集。
func mergeRgPasses(base, extra rgPass) rgPass {
	if !extra.usable {
		return base
	}
	out := base
	out.truncated = out.truncated || extra.truncated
	if out.files == nil {
		out.files = map[string]bool{}
	}
	for path := range extra.files {
		out.files[path] = true
	}
	seen := make(map[string]bool, len(out.hits)+len(extra.hits))
	for _, hit := range out.hits {
		seen[rgHitKey(hit)] = true
	}
	for _, hit := range extra.hits {
		key := rgHitKey(hit)
		if seen[key] {
			continue
		}
		seen[key] = true
		out.hits = append(out.hits, hit)
	}
	return out
}

func rgHitKey(hit SearchHit) string {
	return hit.Path + "\x00" + strconv.Itoa(hit.Line) + "\x00" + strconv.Itoa(hit.Column) + "\x00" + strconv.Itoa(hit.Length)
}

// searchWithRipgrep 用用户自带的 rg 做搜索；第二个返回值表示是否可用，
// 不可用（未安装/无法启动/歧义失败）时应退回内置扫描。
// 两趟扫描：先源码档，结果没占满预算再补产物档，两档各自排序后拼接。
// 有 ! 取反规则时额外跑一趟正向白名单补扫，避免把取反 glob 混进正常趟导致 rg
// 进入白名单模式、误排除普通文件。
func searchWithRipgrep(root string, spec *searchSpec) (*SearchResult, bool) {
	rgPath, err := exec.LookPath("rg")
	if err != nil {
		return nil, false
	}
	deadline := time.Now().Add(searchBudget)
	src := runRgPass(rgPath, root, spec, rgPassOptions{hitCap: spec.maxResults, deadline: deadline})
	if !src.usable {
		return nil, false
	}
	if spec.ignore.hasNegated() {
		extra := runRgPass(rgPath, root, spec, rgPassOptions{negatedPass: true, hitCap: spec.maxResults, deadline: deadline})
		src = mergeRgPasses(src, extra)
	}
	needle := spec.needle
	sortSearchTier(src.hits, needle, spec.caseSensitive, false)
	if len(src.hits) > spec.maxResults {
		src.hits = src.hits[:spec.maxResults]
		src.truncated = true
	}
	result := &SearchResult{
		Hits:      src.hits,
		Files:     len(src.files),
		Truncated: src.truncated,
	}
	// FileOnly：只有一个文件，没有「产物档补扫」这回事
	if spec.fileOnly {
		return result, true
	}
	if len(result.Hits) < spec.maxResults {
		remaining := spec.maxResults - len(result.Hits)
		art := runRgPass(rgPath, root, spec, rgPassOptions{artifactOnly: true, hitCap: remaining, deadline: deadline})
		if spec.ignore.hasNegated() {
			extra := runRgPass(rgPath, root, spec, rgPassOptions{artifactOnly: true, negatedPass: true, hitCap: remaining, deadline: deadline})
			if art.usable {
				art = mergeRgPasses(art, extra)
			} else {
				art = extra
			}
		}
		if art.usable {
			sortSearchTier(art.hits, needle, spec.caseSensitive, false)
			if len(art.hits) > remaining {
				art.hits = art.hits[:remaining]
				art.truncated = true
			}
			result.Hits = append(result.Hits, art.hits...)
			result.Files += len(art.files)
			result.Truncated = result.Truncated || art.truncated
		} else if len(result.Hits) == 0 && !src.truncated {
			// 两趟都没拿到 rg 结果且不是超时——退回内置扫描重来一次
			return nil, false
		}
	} else {
		// 源码档已吃满上限，产物档不再扫描（rg 侧不枚举被排除的目录，是否有产物命中无从得知）
		result.ArtifactSkipped = true
	}
	if len(result.Hits) >= spec.maxResults {
		result.Truncated = true
	}
	return result, true
}
