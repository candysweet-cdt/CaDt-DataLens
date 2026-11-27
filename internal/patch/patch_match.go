package patch

// 补丁匹配：读取目标文件、严格定位 hunk、校验位移一致性与上下文。

import (
	"bytes"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"datalens/internal/chardec"
)

// ===== 目标文件读取 =====

type patchTargetFile struct {
	RelPath      string
	Abs          string
	Exists       bool
	IsDir        bool
	IsSymlink    bool
	Text         string
	Lines        []string
	FinalNewline bool
	Enc          string
	EOL          string
	HasBOM       bool
	Hash         string
	Mtime        int64
	Size         int64
}

func readPatchTarget(abs string) (*patchTargetFile, error) {
	t := &patchTargetFile{Abs: abs}
	li, err := os.Lstat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return t, nil
		}
		return nil, &PatchError{Code: PatchErrFileLocked, Msg: "无法访问目标文件", Detail: err.Error()}
	}
	if li.Mode()&os.ModeSymlink != 0 {
		t.IsSymlink = true
		t.Exists = true
		return t, nil
	}
	if li.IsDir() {
		t.IsDir = true
		t.Exists = true
		return t, nil
	}
	if li.Size() > patchMaxFileBytes {
		return nil, NewPatchError(PatchErrLimit, "目标文件超过 10 MB，请手工处理")
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return nil, &PatchError{Code: PatchErrFileLocked, Msg: "无法读取目标文件（可能被占用）", Detail: err.Error()}
	}
	hasBOM := bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	body := raw
	if hasBOM {
		body = raw[3:]
	}
	eol := "lf"
	if bytes.Contains(body, []byte("\r\n")) {
		eol = "crlf"
	}
	text, enc, err := chardec.DecodeBytes(body, "")
	if err != nil {
		return nil, &PatchError{Code: PatchErrApplyIO, Msg: "目标文件解码失败", Detail: err.Error()}
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines, finalNewline := splitPatchLines(text)
	t.Exists = true
	t.Enc = enc
	t.EOL = eol
	t.HasBOM = hasBOM
	t.Text = text
	t.Lines = lines
	t.FinalNewline = finalNewline
	t.Hash = SHA256Hex(raw)
	t.Mtime = li.ModTime().UnixNano()
	t.Size = li.Size()
	return t, nil
}

func splitPatchLines(text string) ([]string, bool) {
	if text == "" {
		return nil, false
	}
	final := strings.HasSuffix(text, "\n")
	body := text
	if final {
		body = body[:len(body)-1]
	}
	if body == "" {
		return []string{""}, final
	}
	return strings.Split(body, "\n"), final
}

func joinPatchLines(lines []string, finalNewline bool) string {
	if len(lines) == 0 {
		return ""
	}
	out := strings.Join(lines, "\n")
	if finalNewline {
		out += "\n"
	}
	return out
}

// ===== 匹配 =====

type patchHunkPlan struct {
	Index       int
	Status      string
	Reason      string
	ApplyAtLine int
	Pos         int
}

type patchPlanFile struct {
	RelPath    string
	Abs        string
	Kind       string
	Status     string
	Reason     string
	Target     *patchTargetFile
	Hunks      []patchHunkPlan
	Offset     int
	Added      int
	Removed    int
	ResultText string
	ResultHash string
	PatchFile  *patchFile
}

type patchPlan struct {
	PlanID    string
	PatchID   string
	Summary   string
	Root      string
	PatchPath string
	CreatedAt time.Time
	Files     []*patchPlanFile
	Added     int
	Removed   int
	External  bool
	// IgnoreWhitespace 是预检时的匹配选项：应用/撤销阶段重算 hunk 子集必须沿用
	// 同一套口径，否则「忽略空白定位出来的 offset」会被严格匹配判成上下文不匹配。
	IgnoreWhitespace bool

	// RawText 非空表示这是「文本补丁」计划（虚拟 diff 文档：审阅 / Git 差异拼接），
	// 没有盘上的补丁文件；PatchRepreview 直接用这份文本，不走 readPatchFileText。
	RawText string

	SuggestedRoot   string
	SuggestedHits   int
	SuggestedNeeded int
}

var (
	patchPlanMu sync.Mutex
	patchPlans  = map[string]*patchPlan{}
)

func PutPatchPlan(p *patchPlan) {
	patchPlanMu.Lock()
	defer patchPlanMu.Unlock()
	cut := time.Now().Add(-patchPlanTTL)
	for id, old := range patchPlans {
		if old.CreatedAt.Before(cut) {
			delete(patchPlans, id)
		}
	}
	patchPlans[p.PlanID] = p
}

func GetPatchPlan(id string) *patchPlan {
	patchPlanMu.Lock()
	defer patchPlanMu.Unlock()
	p := patchPlans[id]
	if p == nil {
		return nil
	}
	if time.Since(p.CreatedAt) > patchPlanTTL {
		delete(patchPlans, id)
		return nil
	}
	return p
}

// DeletePatchPlan 从计划注册表摘掉指定 planId（重预检换新计划后清理旧条目用）。
func DeletePatchPlan(id string) {
	if id == "" {
		return
	}
	patchPlanMu.Lock()
	delete(patchPlans, id)
	patchPlanMu.Unlock()
}

func (p *patchPlan) ToPreview() *PatchPreview {
	out := &PatchPreview{
		PlanID:    p.PlanID,
		PatchID:   p.PatchID,
		Summary:   p.Summary,
		Root:      p.Root,
		PatchPath: p.PatchPath,
		CreatedAt: p.CreatedAt.Unix(),
		External:  p.External,
		Added:     p.Added,
		Removed:   p.Removed,

		SuggestedRoot:   p.SuggestedRoot,
		SuggestedHits:   p.SuggestedHits,
		SuggestedNeeded: p.SuggestedNeeded,
	}
	for _, f := range p.Files {
		fo := PatchFileOut{
			RelPath: f.RelPath,
			Kind:    f.Kind,
			Status:  f.Status,
			Reason:  f.Reason,
			Added:   f.Added,
			Removed: f.Removed,
			Offset:  f.Offset,
			Hunks:   make([]PatchHunkOut, 0, len(f.Hunks)),
		}
		if f.Target != nil {
			fo.BaseHash = f.Target.Hash
			fo.Enc = f.Target.Enc
			fo.EOL = f.Target.EOL
			fo.HasBOM = f.Target.HasBOM
		}
		for _, h := range f.Hunks {
			ho := PatchHunkOut{
				Index:       h.Index,
				Status:      h.Status,
				Reason:      h.Reason,
				ApplyAtLine: h.ApplyAtLine,
			}
			if f.PatchFile != nil && h.Index < len(f.PatchFile.Hunks) {
				// 行号与文本结构由 patchHunkToOut 统一生成，预检只补自己的状态字段。
				ho = patchHunkToOut(h.Index, f.PatchFile.Hunks[h.Index])
				ho.Status = h.Status
				ho.Reason = h.Reason
				ho.ApplyAtLine = h.ApplyAtLine
			}
			fo.Hunks = append(fo.Hunks, ho)
		}
		if f.Status == "ok" {
			out.Applicable = true
		}
		out.Files = append(out.Files, fo)
	}
	if out.Applicable {
		out.DefaultMode = "atomic"
	} else {
		out.DefaultMode = "atomic"
	}
	return out
}

func hunkOldLines(h *patchHunk) []string {
	out := make([]string, 0, h.OldCount)
	for _, ln := range h.Lines {
		if ln.T != '+' {
			out = append(out, ln.Text)
		}
	}
	return out
}

func hunkNewLines(h *patchHunk) []string {
	out := make([]string, 0, h.NewCount)
	for _, ln := range h.Lines {
		if ln.T != '-' {
			out = append(out, ln.Text)
		}
	}
	return out
}

func blockEqual(lines []string, at int, block []string, ignoreWS bool) bool {
	if at < 0 || at+len(block) > len(lines) {
		return false
	}
	for i, want := range block {
		got := lines[at+i]
		if ignoreWS {
			if strings.TrimRight(got, " \t") != strings.TrimRight(want, " \t") {
				return false
			}
		} else if got != want {
			return false
		}
	}
	return true
}

// findAllBlocks 返回所有匹配位置；调用方据此判定唯一性。
func findAllBlocks(lines []string, block []string, ignoreWS bool) []int {
	if len(block) == 0 {
		return nil
	}
	var hits []int
	for at := 0; at+len(block) <= len(lines); at++ {
		if blockEqual(lines, at, block, ignoreWS) {
			hits = append(hits, at)
			if len(hits) > 4 {
				return hits
			}
		}
	}
	return hits
}

// hunkMismatchDetail 给出「补丁期望什么 / 文件里实际是什么」，冲突信息必须能直接定位。
func hunkMismatchDetail(lines []string, h *patchHunk, offset int) string {
	at := h.OldStart - 1 + offset
	block := hunkOldLines(h)
	if at < 0 {
		return fmt.Sprintf("目标行号 %d 小于 1", at+1)
	}
	if at+len(block) > len(lines) {
		return fmt.Sprintf("文件只有 %d 行，补丁要读到第 %d 行", len(lines), at+len(block))
	}
	for i, want := range block {
		if lines[at+i] != want {
			return fmt.Sprintf("第 %d 行不符：补丁期望 %q，实际 %q", at+i+1, clipLine(want), clipLine(lines[at+i]))
		}
	}
	return ""
}

func clipLine(s string) string {
	r := []rune(s)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return s
}

func hunkAt(lines []string, h *patchHunk, offset int, ignoreWS bool) bool {
	block := hunkOldLines(h)
	at := h.OldStart - 1 + offset
	if len(block) == 0 {
		return at >= 0 && at <= len(lines)
	}
	return blockEqual(lines, at, block, ignoreWS)
}

// chooseOffset 要求同一文件所有 hunk 共享一个位移。
func chooseOffset(lines []string, hunks []patchHunk, allowOffset, ignoreWS bool) (int, *patchHunk, string) {
	if len(hunks) == 0 {
		return 0, nil, ""
	}
	allAt := func(off int) (*patchHunk, bool) {
		for i := range hunks {
			if !hunkAt(lines, &hunks[i], off, ignoreWS) {
				return &hunks[i], false
			}
		}
		return nil, true
	}
	if _, ok := allAt(0); ok {
		return 0, nil, ""
	}
	if !allowOffset {
		bad, _ := allAt(0)
		if bad != nil {
			return 0, bad, "上下文不匹配（未开启位移搜索）"
		}
		return 0, nil, "上下文不匹配"
	}
	first := hunks[0]
	block := hunkOldLines(&first)
	hits := findAllBlocks(lines, block, ignoreWS)
	var offsets []int
	seen := map[int]bool{}
	for _, at := range hits {
		off := at - (first.OldStart - 1)
		if off == 0 || off > patchOffsetLimit || off < -patchOffsetLimit {
			continue
		}
		if seen[off] {
			continue
		}
		if _, ok := allAt(off); ok {
			seen[off] = true
			offsets = append(offsets, off)
		}
	}
	if len(offsets) == 1 {
		return offsets[0], nil, ""
	}
	if len(offsets) > 1 {
		return 0, nil, fmt.Sprintf("位移不唯一（候选 %v），拒绝自动应用", offsets)
	}
	return 0, &first, "上下文不匹配"
}

type appliedSeg struct {
	Pos      int
	OldLines []string
	NewLines []string
}

// applyHunks 在原始行上应用选中的 hunk，返回结果行与已应用段落（供反向校验）。
func applyHunks(lines []string, hunks []patchHunk, selected map[int]bool, offset int, ignoreWS bool) ([]string, []appliedSeg, int, string) {
	type item struct {
		idx  int
		pos  int
		hunk *patchHunk
	}
	var items []item
	for i := range hunks {
		if selected != nil && !selected[i] {
			continue
		}
		h := &hunks[i]
		block := hunkOldLines(h)
		at := h.OldStart - 1 + offset
		if len(block) == 0 {
			if at < 0 || at > len(lines) {
				return nil, nil, i, "hunk 插入点越界"
			}
		} else if !blockEqual(lines, at, block, ignoreWS) {
			return nil, nil, i, "上下文不匹配"
		}
		items = append(items, item{idx: i, pos: at, hunk: h})
	}
	sort.Slice(items, func(a, b int) bool { return items[a].pos < items[b].pos })
	out := make([]string, 0, len(lines))
	segs := make([]appliedSeg, 0, len(items))
	cursor := 0
	for _, it := range items {
		if it.pos < cursor {
			return nil, nil, it.idx, "hunk 顺序或范围重叠"
		}
		out = append(out, lines[cursor:it.pos]...)
		segPos := len(out)
		oldLines := hunkOldLines(it.hunk)
		newLines := hunkNewLines(it.hunk)
		out = append(out, newLines...)
		segs = append(segs, appliedSeg{Pos: segPos, OldLines: oldLines, NewLines: newLines})
		cursor = it.pos + len(oldLines)
	}
	out = append(out, lines[cursor:]...)
	return out, segs, -1, ""
}

// verifyReverse 用已应用段落反向替换，必须精确还原原始行。
func verifyReverse(result []string, segs []appliedSeg, original []string) bool {
	rev := append([]string(nil), result...)
	for i := len(segs) - 1; i >= 0; i-- {
		s := segs[i]
		if s.Pos < 0 || s.Pos+len(s.NewLines) > len(rev) {
			return false
		}
		for k := 0; k < len(s.NewLines); k++ {
			if rev[s.Pos+k] != s.NewLines[k] {
				return false
			}
		}
		next := append([]string(nil), rev[:s.Pos]...)
		next = append(next, s.OldLines...)
		next = append(next, rev[s.Pos+len(s.NewLines):]...)
		rev = next
	}
	if len(rev) != len(original) {
		return false
	}
	for i := range rev {
		if rev[i] != original[i] {
			return false
		}
	}
	return true
}
