// graph.go：Git 图谱引擎——`git log --graph` 字形流的提交历史、分组 ref 列表与
// 历史上的写操作（签出 / 重置 / cherry-pick）。布局布局交给 git 自己（graph.c 是权威实现），
// Go 侧解析字形流并压缩成 flow 路径（graphglyph.go），前端只负责渲染。
// 全部走 gitRun（gitinfo.go 唯一执行入口，已带防黑窗 / GIT_TERMINAL_PROMPT=0 / 超时）。
package gitinfo

import (
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GitGraphCommit 是图谱里的一行提交。绘图数据来自 `git log --graph` 的字形矩阵
//（git graph.c 是权威布局实现，见 graphglyph.go）：组内字形逐个直译成 SVG 段
//（映射与 Gitea svgcontainer.tmpl 相同），相邻字形天然连接，前端零布局逻辑。
type GitGraphCommit struct {
	Sha     string `json:"sha"`
	Refs    string `json:"refs,omitempty"` // git %D 原文（装饰器，如 HEAD -> master, origin/master）
	Author  string `json:"author"`
	Email   string `json:"email,omitempty"`
	Date    string `json:"date"`  // 已格式化的本地时间
	Subject string `json:"subject"`
	DotPos  int    `json:"dotPos"`  // 圆点所在字形位置（偶数位 = 泳道）
	DotFlow int64  `json:"dotFlow"` // 圆点所在 flow 的色号（≥1）
	Rows    int         `json:"rows"`   // 本组行数（提交行 + 关系行）
	Glyphs  []GlyphSpan `json:"glyphs"` // 组内所有字形
}

// GlyphSpan 是一个字形：组内行号 R、字符位置 Pos、字形 Ch（单字符 string——
// byte 经 JSON 会变成数字，前端按字符分发）、所属 flow 色号 Flow。
type GlyphSpan struct {
	R    int    `json:"r"`
	Pos  int    `json:"p"`
	Ch   string `json:"c"`
	Flow int64  `json:"f"`
}

// GitGraphPage 是一页提交。HasMore + NextSkip 供前端滚动到底时续拉。
type GitGraphPage struct {
	Available bool             `json:"available"`
	Reason    string           `json:"reason,omitempty"`
	Root      string           `json:"root,omitempty"`
	HeadBranch string          `json:"headBranch,omitempty"`
	Ref       string           `json:"ref,omitempty"`          // 实际作用的 ref（空 = 当前 HEAD）
	Commits   []GitGraphCommit `json:"commits"`
	LaneCount int              `json:"laneCount"`
	HasMore   bool             `json:"hasMore"`
	NextSkip  int              `json:"nextSkip"`
}

const (
	graphDefaultLimit = 500
	graphMaxLimit     = 2000
	graphLogTimeoutMs = 20000
)

// GraphCommits 返回一页带图形拓扑的提交。ref 为空表示当前 HEAD；skip 用于分页续拉。
// 布局交给 git 自己（--graph，graph.c 权威实现），这里解析字形流并压缩成 flow 路径。
func GraphCommits(dir string, ref string, limit int, skip int) (*GitGraphPage, error) {
	page := &GitGraphPage{Commits: []GitGraphCommit{}}
	dir = strings.TrimSpace(dir)
	ref = strings.TrimSpace(ref)
	if dir == "" {
		page.Reason = "没有打开的目录"
		return page, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		page.Reason = gitProbeReason(dir, err)
		return page, nil
	}
	if code != 0 || strings.TrimSpace(out) != "true" {
		page.Reason = "不在 git 仓库内"
		return page, nil
	}
	page.Available = true
	if root, _, _ := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000); root != "" {
		page.Root = strings.TrimSpace(root)
	}
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		page.HeadBranch = strings.TrimSpace(b)
	}
	if limit <= 0 {
		limit = graphDefaultLimit
	}
	if limit > graphMaxLimit {
		limit = graphMaxLimit
	}
	if skip < 0 {
		skip = 0
	}
	// 多取一条判断 hasMore；字段用  分隔， 标记数据区起点（字形区在其前）。
	// 不带 %b：多行正文会让 --graph 多出关系行、破坏「一提交一视觉行」的映射，
	// 正文改为详情面板按需拉取（GraphCommitBody）。
	args := []string{
		// topo-order：分支尖紧跟其 merge 连续展示（与 IDEA/JGit 一致），泳道立即释放、
		// 列数少且干净；date-order 会按日期交错出 `| |_|_|/` 这类复合辫子（泳道暴涨）。
		"log", "--graph", "--topo-order",
		"-n", strconv.Itoa(limit + 1),
		"--skip=" + strconv.Itoa(skip),
		"--date=format:%Y-%m-%d %H:%M",
		"--pretty=format:%x1e%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s",
	}
	if ref != "" {
		if strings.HasPrefix(ref, "-") {
			page.Reason = "非法修订"
			return page, nil
		}
		// ref 作为修订（放在 log 后）：点分支 = 看该分支的历史（旧版用 `-- ref`
		// 会被当成路径过滤，是错的）
		args = append(args[:1], append([]string{ref}, args[1:]...)...)
	}
	raw, code, err := gitRun(dir, args, graphLogTimeoutMs)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		page.Reason = "读取提交历史失败"
		return page, nil
	}
	commits, laneCount, hasMore, nextSkip := buildGraphPage(raw, limit, skip)
	page.Commits = commits
	page.LaneCount = laneCount
	page.HasMore = hasMore
	page.NextSkip = nextSkip
	page.Ref = ref
	return page, nil
}

// graphGlyphRow 是解析器吐出的一行字形快照。
type graphGlyphRow struct {
	pos    []int   // 非空格字形的位置（字符偏移）
	glyph  []byte
	flow   []int64
	color  []int
}

// graphGlyphGroup 是一个视觉行的字形组：一条提交行 + 跟在后面的关系行（git 画斜线的
// 过渡行）。压缩成一个视觉行，圆点画在提交行（行内高度 0.5）。
type graphGlyphGroup struct {
	rows    []graphGlyphRow
	commit  *GitGraphCommit
	dotPos  int
	dotFlow int64
}

// buildGraphPage 把 --graph 原始输出解析成分组并压缩成 flow 路径。
func buildGraphPage(raw string, limit int, skip int) ([]GitGraphCommit, int, bool, int) {
	parser := newGlyphParser()
	var groups []*graphGlyphGroup
	maxPos := 0
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		var glyphPart string
		isCommit := false
		if idx := strings.Index(line, ""); idx >= 0 {
			glyphPart = line[:idx]
			isCommit = true
		} else {
			glyphPart = line
		}
		parser.parse([]byte(glyphPart))
		row := graphGlyphRow{pos: []int{}, glyph: []byte{}, flow: []int64{}, color: []int{}}
		for i, g := range parser.glyphs {
			if g == ' ' {
				continue
			}
			row.pos = append(row.pos, i)
			row.glyph = append(row.glyph, g)
			row.flow = append(row.flow, parser.flows[i])
			row.color = append(row.color, parser.colors[i])
			if int64(i)+1 > int64(maxPos) && g != '*' {
				// 记录最大列宽（圆点所在列也算，单独处理）
			}
			if i > maxPos {
				maxPos = i
			}
		}
		if isCommit {
			fields := strings.Split(line[strings.Index(line, "")+1:], "\x1f")
			if len(fields) < 7 {
				continue // 畸形行跳过（字形已喂给解析器，流状态不受影响）
			}
			dotPos := -1
			for i, g := range parser.glyphs {
				if g == '*' {
					dotPos = i
					break
				}
			}
			if dotPos < 0 {
				continue
			}
			c := &GitGraphCommit{
				Sha:      strings.TrimSpace(fields[0]),
				Refs:     strings.TrimSpace(fields[2]),
				Author:   strings.TrimSpace(fields[3]),
				Email:    strings.TrimSpace(fields[4]),
				Subject:  strings.TrimSpace(fields[6]),
				DotPos:   dotPos,
				DotFlow:  parser.flows[dotPos],
			}
			if ts, err := strconv.ParseInt(strings.TrimSpace(fields[5]), 10, 64); err == nil {
				c.Date = formatGitTime(ts)
			} else {
				c.Date = strings.TrimSpace(fields[5])
			}
			groups = append(groups, &graphGlyphGroup{commit: c, dotPos: dotPos, dotFlow: parser.flows[dotPos]})
			groups[len(groups)-1].rows = append(groups[len(groups)-1].rows, row)
		} else if len(groups) > 0 {
			// 关系行：归属前一个提交组（git 画斜线/纵线的过渡行）
			groups[len(groups)-1].rows = append(groups[len(groups)-1].rows, row)
		}
	}

	// 分页：按提交组截断
	hasMore := false
	nextSkip := skip
	if len(groups) > limit {
		groups = groups[:limit]
		hasMore = true
		nextSkip = skip + limit
	}

	// 逐字形直译输出（Gitea svgcontainer.tmpl 同款）：每个字形一段确定几何，
	// 相邻字形首尾天然相接（竖线在格右界、斜线跨 2 格、横线贴底边跨 2 格），
	// 无需任何跨行/跨组连接判定——`| |_|_|/`、`|/| | |` 这类复合字形全覆盖。
	commits := make([]GitGraphCommit, 0, len(groups))
	for _, g := range groups {
		c := g.commit
		c.Rows = len(g.rows)
		glyphs := make([]GlyphSpan, 0, 16)
		for ri, row := range g.rows {
			for k, pos := range row.pos {
				glyphs = append(glyphs, GlyphSpan{R: ri, Pos: pos, Ch: string(row.glyph[k]), Flow: row.flow[k]})
			}
		}
		c.Glyphs = glyphs
		commits = append(commits, *c)
	}

	laneCount := maxPos/2 + 1
	if laneCount < 1 {
		laneCount = 1
	}
	return commits, laneCount, hasMore, nextSkip
}

// GraphCommitBody 返回一次提交的完整正文（%b）。图谱列表不带正文（多行正文会让
// --graph 多出关系行、破坏一行一提交的映射），详情面板按需拉取。
func GraphCommitBody(dir string, sha string) (string, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	if dir == "" || sha == "" {
		return "", fmt.Errorf("缺少目录或提交")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return "", fmt.Errorf("非法提交：%s", sha)
	}
	out, code, err := gitRun(dir, []string{"log", "-n", "1", "--format=%b", sha}, 10000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("读取提交正文失败：%s", strings.TrimSpace(out))
	}
	return strings.TrimSpace(out), nil
}

// formatGitTime 把 unix 时间戳格式化为本地时间。
func formatGitTime(ts int64) string {
	return time.Unix(ts, 0).Format("2006-01-02 15:04")
}

// ===== ref 列表 =====

// GitGraphRef 是 ref 树里的一个条目（分支 / 远程 / 标签 / worktree HEAD）。
type GitGraphRef struct {
	Name     string `json:"name"`
	Sha      string `json:"sha,omitempty"`
	Current  bool   `json:"current,omitempty"`
	Worktree string `json:"worktree,omitempty"` // 属于哪个 worktree（主根为空）
	Detached bool   `json:"detached,omitempty"`
}

// GitGraphRefsResult 是图谱左栏的分组 ref。
type GitGraphRefsResult struct {
	Available bool          `json:"available"`
	Reason    string        `json:"reason,omitempty"`
	Root      string        `json:"root,omitempty"`
	Current   string        `json:"current,omitempty"` // 当前分支名（detached 为空）
	HeadSha   string        `json:"headSha,omitempty"`
	Local     []GitGraphRef `json:"local"`
	Remote    []GitGraphRef `json:"remote"`
	Tags      []GitGraphRef `json:"tags"`
	Worktrees []GitGraphRef `json:"worktrees"`
}

// GraphRefs 返回图谱左栏数据：当前 HEAD、本地/远程分支、标签、各 worktree 的 HEAD。
func GraphRefs(dir string) (*GitGraphRefsResult, error) {
	res := &GitGraphRefsResult{Local: []GitGraphRef{}, Remote: []GitGraphRef{}, Tags: []GitGraphRef{}, Worktrees: []GitGraphRef{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		res.Reason = "没有打开的目录"
		return res, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		res.Reason = gitProbeReason(dir, err)
		return res, nil
	}
	if code != 0 || strings.TrimSpace(out) != "true" {
		res.Reason = "不在 git 仓库内"
		return res, nil
	}
	res.Available = true
	if root, _, _ := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000); root != "" {
		res.Root = strings.TrimSpace(root)
	}
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		name := strings.TrimSpace(b)
		if name != "HEAD" {
			res.Current = name
		}
	}
	if s, c, _ := gitRun(dir, []string{"rev-parse", "HEAD"}, 5000); c == 0 {
		res.HeadSha = strings.TrimSpace(s)
	}
	// 本地分支（带 HEAD 标记与 sha）
	if raw, c, _ := gitRun(dir, []string{
		"for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(HEAD)", "refs/heads",
	}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			p := strings.Split(line, "\t")
			if len(p) < 3 {
				continue
			}
			res.Local = append(res.Local, GitGraphRef{
				Name:    strings.TrimSpace(p[0]),
				Sha:     strings.TrimSpace(p[1]),
				Current: strings.TrimSpace(p[2]) == "*",
			})
		}
	}
	// 远程分支（排除符号引用与远程 HEAD）
	if raw, c, _ := gitRun(dir, []string{
		"for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", "refs/remotes",
	}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			p := strings.Split(line, "\t")
			if len(p) < 3 {
				continue
			}
			full := strings.TrimSpace(p[0])
			if strings.TrimSpace(p[2]) != "" || strings.HasSuffix(full, "/HEAD") {
				continue
			}
			name := strings.TrimPrefix(full, "refs/remotes/")
			if name == "" || !strings.Contains(name, "/") {
				continue
			}
			res.Remote = append(res.Remote, GitGraphRef{Name: name, Sha: strings.TrimSpace(p[1])})
		}
	}
	// 标签
	if raw, c, _ := gitRun(dir, []string{
		"for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%09%(objectname)", "refs/tags",
	}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			p := strings.Split(line, "\t")
			if len(p) < 2 {
				continue
			}
			res.Tags = append(res.Tags, GitGraphRef{
				Name: strings.TrimSpace(p[0]),
				Sha:  strings.TrimSpace(p[1]),
			})
		}
	}
	// worktree HEAD（主根之外的检出）
	if wl, err := WorktreeList(dir); err == nil && wl != nil {
		for _, w := range wl.Items {
			if w.Bare || !w.UnderCadt {
				continue
			}
			res.Worktrees = append(res.Worktrees, GitGraphRef{
				Name:     w.Branch,
				Sha:      w.Head,
				Worktree: w.RelPath,
				Detached: w.Detached,
			})
		}
	}
	return res, nil
}

// ===== 历史上的写操作（用户在图谱上主动点，走确认弹窗 + 只读锁；不涉 AI 审批链） =====

// GraphCheckout 签出到指定分支 / 标签 / 提交（复用 CheckoutRef 语义）。
func GraphCheckout(dir string, ref string) (*GitOperationResult, error) {
	return CheckoutRef(dir, ref)
}

// GraphReset 把当前分支重置到 sha。mode 限 soft / mixed / hard；hard 会丢工作区改动，
// 前端必须先弹确认。sha 校验为十六进制，拒绝任意参数注入。
func GraphReset(dir string, sha string, mode string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	mode = strings.TrimSpace(mode)
	if dir == "" || sha == "" {
		return nil, fmt.Errorf("缺少目录或提交")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	switch mode {
	case "soft", "mixed", "hard":
	default:
		return nil, fmt.Errorf("非法重置模式：%s", mode)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到提交：" + sha}, nil
	}
	out, code, err := gitRun(dir, []string{"reset", "--" + mode, sha}, 30000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}

// GraphCherryPick 把单个提交摘到当前分支。冲突时如实返回失败输出，不静默。
func GraphCherryPick(dir string, sha string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	if dir == "" || sha == "" {
		return nil, fmt.Errorf("缺少目录或提交")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到提交：" + sha}, nil
	}
	out, code, err := gitRun(dir, []string{"cherry-pick", sha}, 60000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}

// GraphCreateBranch 从指定提交新建分支；checkout=true 时立即检出到新分支
//（对应 IDEA 右键菜单「新建分支」：分支名 + 签出分支 勾选）。
func GraphCreateBranch(dir string, name string, sha string, checkout bool) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	name = strings.TrimSpace(name)
	sha = strings.TrimSpace(sha)
	if dir == "" || name == "" || sha == "" {
		return nil, fmt.Errorf("缺少目录、分支名或提交")
	}
	if strings.HasPrefix(name, "-") {
		return nil, fmt.Errorf("非法分支名")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到提交：" + sha}, nil
	}
	if valid, code, _ := gitRun(dir, []string{"check-ref-format", "--branch", name}, 5000); code != 0 || strings.TrimSpace(valid) != name {
		return &GitOperationResult{Success: false, Output: "分支名不合法：" + name}, nil
	}
	if gitBranchRefExists(dir, "refs/heads/"+name) {
		return &GitOperationResult{Success: false, Output: "分支已存在：" + name}, nil
	}
	args := []string{"branch", name, sha}
	if checkout {
		args = []string{"checkout", "-b", name, sha}
	}
	out, code, err := gitRun(dir, args, 30000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Branch: name}, nil
}

// GraphCheckoutForce 强制签出（丢弃挡路的未提交改动，前端必须先弹确认列出受影响文件）。
func GraphCheckoutForce(dir string, ref string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	ref = strings.TrimSpace(ref)
	if dir == "" || ref == "" {
		return nil, fmt.Errorf("缺少目录或修订")
	}
	if strings.HasPrefix(ref, "-") {
		return nil, fmt.Errorf("非法修订")
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", ref + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到标记或修订：" + ref}, nil
	}
	out, code, err := gitRun(dir, []string{"checkout", "-f", ref}, 30000)
	if err != nil {
		return nil, err
	}
	branch := ""
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		branch = strings.TrimSpace(b)
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out), Branch: branch}, nil
}

// GraphCheckoutSmart 智能签出（IDEA 语义）：先把本地改动 stash，签出成功后再恢复。
// 签出失败会自动 pop 回滚；恢复冲突时改动保留在 stash 里并在输出中说明。
func GraphCheckoutSmart(dir string, ref string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	ref = strings.TrimSpace(ref)
	if dir == "" || ref == "" {
		return nil, fmt.Errorf("缺少目录或修订")
	}
	if strings.HasPrefix(ref, "-") {
		return nil, fmt.Errorf("非法修订")
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", ref + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到标记或修订：" + ref}, nil
	}
	stashOut, code, err := gitRun(dir, []string{"stash", "push"}, 30000)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return &GitOperationResult{Success: false, Output: "暂存本地改动失败：" + strings.TrimSpace(stashOut)}, nil
	}
	stashed := !strings.Contains(stashOut, "No local changes to save")
	out, code, err := gitRun(dir, []string{"checkout", ref}, 30000)
	if err != nil {
		return nil, err
	}
	var sb strings.Builder
	sb.WriteString(strings.TrimSpace(out))
	if code != 0 {
		// 签出仍失败（理论上 stash 后不该发生）：把改动恢复回来再报错
		if stashed {
			pOut, _, _ := gitRun(dir, []string{"stash", "pop"}, 30000)
			sb.WriteString("\n已恢复暂存的本地改动。" + strings.TrimSpace(pOut))
		}
		return &GitOperationResult{Success: false, Output: strings.TrimSpace(sb.String())}, nil
	}
	branch := ""
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		branch = strings.TrimSpace(b)
	}
	if stashed {
		pOut, pcode, _ := gitRun(dir, []string{"stash", "pop"}, 30000)
		sb.WriteString("\n" + strings.TrimSpace(pOut))
		if pcode != 0 {
			sb.WriteString("\n恢复暂存改动时冲突：改动仍保留在 stash 中，解决冲突后可 git stash drop。")
		}
	}
	return &GitOperationResult{Success: true, Output: strings.TrimSpace(sb.String()), Branch: branch}, nil
}

// GitGraphFileChange 是一次提交的文件变动。
type GitGraphFileChange struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"` // R/C（重命名/复制）时的原名
	Status  string `json:"status"`            // A / M / D / R / C / T / U / X
}

// GraphCommitFiles 返回一次提交的文件变动（IDEA 右侧「本次变动」树的数据源）。
// 普通提交相对其父；根提交相对空树；合并提交相对第一个父（diff-tree 默认对合并
// 输出为空，必须显式给两个端点）。
func GraphCommitFiles(dir string, sha string) ([]GitGraphFileChange, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	if dir == "" || sha == "" {
		return nil, fmt.Errorf("缺少目录或提交")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return nil, fmt.Errorf("找不到提交：%s", sha)
	}
	args := []string{"diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "-z", sha}
	if parOut, pcode, _ := gitRun(dir, []string{"rev-list", "--parents", "-n", "1", sha}, 5000); pcode == 0 {
		if fields := strings.Fields(strings.TrimSpace(parOut)); len(fields) > 1 {
			args = []string{"diff-tree", "--no-commit-id", "--name-status", "-r", "-z", fields[1], sha}
		}
	}
	out, code, err := gitRun(dir, args, 30000)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("读取文件变动失败：%s", strings.TrimSpace(out))
	}
	return parseNameStatusZ(out), nil
}

// parseNameStatusZ 解析 diff-tree -z 输出：普通条目 status\0path\0，重命名/复制为
// status\0old\0new\0（status 带置信度后缀如 R100，只取首字母）。按路径排序。
func parseNameStatusZ(out string) []GitGraphFileChange {
	tok := strings.Split(out, "\x00")
	files := []GitGraphFileChange{}
	for i := 0; i < len(tok); i++ {
		s := tok[i]
		if s == "" {
			continue
		}
		status := s[:1]
		if i+1 >= len(tok) {
			break
		}
		if status == "R" || status == "C" {
			if i+2 >= len(tok) {
				break
			}
			files = append(files, GitGraphFileChange{Path: tok[i+2], OldPath: tok[i+1], Status: status})
			i += 2
		} else {
			files = append(files, GitGraphFileChange{Path: tok[i+1], Status: status})
			i++
		}
	}
	sort.Slice(files, func(a, b int) bool { return files[a].Path < files[b].Path })
	return files
}

// GraphCommitFileDiff 返回一次提交中单个文件的 unified diff（图谱「本次变动」树点击文件用）。
// 端点选择与 GraphCommitFiles 完全一致：普通提交相对父提交、根提交相对空树、
// 合并提交相对第一父——否则文件树里显示的状态与这里给出的补丁会对不上。
// 安全：sha 走 shaRe + `-` 前缀拒绝 + rev-parse 校验；path 拒绝绝对/越界，
// 且作为 pathspec 前加 `--`；命令带 --no-ext-diff/--no-textconv 防止用户 git config
// 或 .gitattributes 触发外部程序（只读查询也不能给外部命令可乘之机）。
func GraphCommitFileDiff(dir, sha, path string, maxLines int) (*GitDiffResult, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	path = strings.TrimSpace(path)
	if dir == "" || sha == "" || path == "" {
		return nil, fmt.Errorf("缺少目录、提交或文件路径")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	// 路径必须是仓库内的相对 slash 路径；拒绝绝对路径与盘符/反斜杠开头（Windows）。
	if filepath.IsAbs(path) || strings.HasPrefix(path, "/") || strings.HasPrefix(path, "\\") {
		return nil, fmt.Errorf("path 必须是相对仓库根的路径")
	}
	if !gitPathInRoot(dir, path) {
		return nil, fmt.Errorf("路径越界：%s", path)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return nil, fmt.Errorf("找不到提交：%s", sha)
	}
	// 端点：默认根提交相对空树（--root 语义由下面显式空树哈希替代）；有父则用第一父。
	from := emptyTreeSha
	if parOut, pcode, _ := gitRun(dir, []string{"rev-list", "--parents", "-n", "1", sha}, 5000); pcode == 0 {
		if fields := strings.Fields(strings.TrimSpace(parOut)); len(fields) > 1 {
			from = fields[1]
		}
	}
	out, code, err := gitRun(dir, []string{
		"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
		from, sha, "--", path,
	}, 30000)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("读取提交文件差异失败：%s", strings.TrimSpace(out))
	}
	diff := trimDiffTail(out) // 只裁尾部一个换行，保住 hunk 末尾的空上下文行
	result := &GitDiffResult{}
	if strings.TrimSpace(diff) == "" {
		return result, nil
	}
	if maxLines > 0 {
		lines := strings.Split(diff, "\n")
		if len(lines) > maxLines {
			diff = strings.Join(lines[:maxLines], "\n") + "\n…（已截断，共 " + strconv.Itoa(len(lines)) + " 行）"
		}
	}
	result.HasChanges = true
	result.Diff = diff
	return result, nil
}

// emptyTreeSha 是 git 的空树对象哈希，用作根提交的 diff 起点（等价 diff-tree --root）。
const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
