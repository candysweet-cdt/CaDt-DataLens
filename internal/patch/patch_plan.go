package patch

// 计划构建与存储：把 hunk 落成可复核的计划，落盘到 .cadt/patches 索引。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/chardec"
)

// ===== 计划构建 =====

func detectStripLevel(files []patchFile) int {
	for _, f := range files {
		lo := strings.ReplaceAll(strings.TrimSpace(f.RawOld), "\\", "/")
		ln := strings.ReplaceAll(strings.TrimSpace(f.RawNew), "\\", "/")
		// 两侧都以 a/ b/ 开头才按 p1 处理
		if (strings.HasPrefix(lo, "a/") || isDevNull(lo)) && (strings.HasPrefix(ln, "b/") || isDevNull(ln)) {
			continue
		}
		return 0
	}
	return 1
}

// detectBestStripLevel 在 0..3 之间挑「能定位到最多文件」的层级，并列取小值（偏保守）。
func detectBestStripLevel(files []patchFile, root string) int {
	best, bestHits := detectStripLevel(files), -1
	for level := 0; level <= 3; level++ {
		hits := 0
		total := 0
		for i := range files {
			raw := files[i].RawNew
			if files[i].Kind == "delete" || raw == "" || isDevNull(raw) {
				raw = files[i].RawOld
			}
			rel, pe := stripPatchPath(raw, level)
			if pe != nil {
				continue
			}
			total++
			if rel == "" {
				continue
			}
			if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil {
				hits++
			}
		}
		if total == 0 {
			continue
		}
		// 命中率过半才算有效候选
		if hits*2 < total {
			continue
		}
		if hits > bestHits {
			best, bestHits = level, hits
		}
	}
	return best
}

// patchRootMatchStats 统计某个根目录下能定位到多少「必须已存在」的目标文件。
// 新建文件不要求已存在，不计入分母。
func patchRootMatchStats(files []patchFile, root string) (hits, needed int) {
	strip := detectBestStripLevel(files, root)
	for i := range files {
		f := &files[i]
		if f.Kind == "unsupported" || f.Kind == "add" {
			continue
		}
		raw := f.RawNew
		if f.Kind == "delete" || raw == "" || isDevNull(raw) {
			raw = f.RawOld
		}
		rel, pe := stripPatchPath(raw, strip)
		if pe != nil || rel == "" {
			continue
		}
		needed++
		abs, pe := resolvePatchRootPath(root, rel)
		if pe != nil {
			continue
		}
		if info, err := os.Stat(abs); err == nil && !info.IsDir() {
			hits++
		}
	}
	return hits, needed
}

const patchRootScanLimit = 64

func appendPatchRootDirs(dst []string, dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return dst
	}
	for _, e := range entries {
		if len(dst) >= patchRootScanLimit {
			break
		}
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") || strings.EqualFold(name, "node_modules") {
			continue
		}
		dst = append(dst, filepath.Join(dir, name))
	}
	return dst
}

func samePatchDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if abs, err := filepath.Abs(a); err == nil {
		a = abs
	}
	if abs, err := filepath.Abs(b); err == nil {
		b = abs
	}
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// suggestPatchRoot 在当前根定位不到足够目标文件时，就近找一个命中率更高的目录。
// 候选范围：补丁所在目录及其一级子目录、当前工作区父目录、当前工作区一级子目录。
func suggestPatchRoot(files []patchFile, root, patchPath string) (string, int, int) {
	curHits, curNeeded := patchRootMatchStats(files, root)
	if curNeeded == 0 || curHits >= curNeeded {
		return "", 0, 0
	}
	var candidates []string
	if patchPath != "" {
		patchDir := filepath.Dir(patchPath)
		candidates = append(candidates, patchDir)
		candidates = appendPatchRootDirs(candidates, patchDir)
	}
	if parent := filepath.Dir(root); parent != "" && !samePatchDir(parent, root) {
		candidates = append(candidates, parent)
	}
	candidates = appendPatchRootDirs(candidates, root)

	bestRoot := ""
	bestHits, bestNeeded := 0, 0
	bestScore := 0.0
	seen := map[string]bool{}
	for _, dir := range candidates {
		if samePatchDir(dir, root) {
			continue
		}
		key := strings.ToLower(filepath.Clean(dir))
		if seen[key] {
			continue
		}
		seen[key] = true
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		hits, needed := patchRootMatchStats(files, dir)
		if needed == 0 || hits == 0 || hits <= curHits {
			continue
		}
		score := float64(hits) / float64(needed)
		if bestRoot != "" && (score < bestScore || (score == bestScore && hits <= bestHits)) {
			continue
		}
		bestRoot, bestHits, bestNeeded, bestScore = dir, hits, needed, score
	}
	return bestRoot, bestHits, bestNeeded
}

func resolvePatchRootPath(root, rel string) (string, *PatchError) {
	abs := filepath.Join(root, filepath.FromSlash(rel))
	abs = filepath.Clean(abs)
	rootClean := filepath.Clean(root)
	// 父目录真实路径必须在根内（防 junction / 符号链接逃逸）
	dir := filepath.Dir(abs)
	if realDir, err := filepath.EvalSymlinks(dir); err == nil {
		if realRoot, err2 := filepath.EvalSymlinks(rootClean); err2 == nil {
			relReal, err3 := filepath.Rel(realRoot, realDir)
			if err3 != nil || relReal == ".." || strings.HasPrefix(relReal, ".."+string(filepath.Separator)) {
				return "", &PatchError{Code: PatchErrPathDenied, Msg: "路径解析后超出工作区", Detail: rel}
			}
		}
	}
	return abs, nil
}

func BuildPatchPlan(doc *PatchDoc, root, patchID, summary, patchPath string, opts PatchPlanOptions) (*patchPlan, error) {
	root = filepath.Clean(root)
	if root == "" {
		return nil, NewPatchError(PatchErrPathDenied, "缺少工作区根目录")
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, NewPatchError(PatchErrPathDenied, "工作区根目录不存在")
	}
	plan := &patchPlan{
		PlanID:           NewPatchRunID("plan"),
		PatchID:          patchID,
		Summary:          summary,
		Root:             root,
		PatchPath:        patchPath,
		CreatedAt:        time.Now(),
		External:         opts.External,
		IgnoreWhitespace: opts.IgnoreWhitespace,
	}
	strip := opts.StripLevel
	if strip < 0 {
		strip = detectBestStripLevel(doc.Files, root)
	} else if strip == 0 {
		strip = detectStripLevel(doc.Files)
	}
	// 逐文件解析路径
	type resolved struct {
		rel  string
		kind string
	}
	resolvedList := make([]resolved, len(doc.Files))
	for i := range doc.Files {
		f := &doc.Files[i]
		raw := f.RawNew
		if f.Kind == "delete" || raw == "" || isDevNull(raw) {
			raw = f.RawOld
		}
		rel, pe := stripPatchPath(raw, strip)
		if pe != nil {
			resolvedList[i] = resolved{rel: "", kind: "denied"}
			continue
		}
		resolvedList[i] = resolved{rel: rel, kind: f.Kind}
	}
	// 同路径重复（含先删后建）直接拒绝
	seenPath := map[string]int{}
	for i, r := range resolvedList {
		if r.rel == "" {
			continue
		}
		if prev, ok := seenPath[strings.ToLower(r.rel)]; ok {
			return nil, &PatchError{Code: PatchErrPathDenied, Msg: "同一路径在补丁中出现多次", Detail: fmt.Sprintf("%s（第 %d 与第 %d 个文件）", r.rel, prev+1, i+1)}
		}
		seenPath[strings.ToLower(r.rel)] = i
	}

	for i := range doc.Files {
		src := &doc.Files[i]
		r := resolvedList[i]
		pf := &patchPlanFile{
			RelPath:   r.rel,
			Kind:      src.Kind,
			Status:    "ok",
			PatchFile: src,
			Added:     src.Added,
			Removed:   src.Removed,
		}
		if src.Kind == "unsupported" {
			pf.Status = "unsupported"
			pf.Reason = src.UnsupportedMsg + "：暂不支持，请改用文本方式分两步处理"
			plan.Files = append(plan.Files, pf)
			continue
		}
		if r.kind == "denied" || r.rel == "" {
			pf.Status = "blocked"
			pf.Reason = "路径不合法或越界"
			plan.Files = append(plan.Files, pf)
			continue
		}
		abs, pe := resolvePatchRootPath(root, r.rel)
		if pe != nil {
			pf.Status = "blocked"
			pf.Reason = pe.Msg
			plan.Files = append(plan.Files, pf)
			continue
		}
		pf.Abs = abs
		target, err := readPatchTarget(abs)
		if err != nil {
			pf.Status = "blocked"
			pf.Reason = PatchErrorOf(err).Msg
			plan.Files = append(plan.Files, pf)
			continue
		}
		pf.Target = target
		if target.IsDir {
			pf.Status = "blocked"
			pf.Reason = "目标是一个目录"
			plan.Files = append(plan.Files, pf)
			continue
		}
		if target.IsSymlink {
			pf.Status = "blocked"
			pf.Reason = "目标是符号链接，拒绝写入（可能指向工作区外）"
			plan.Files = append(plan.Files, pf)
			continue
		}
		switch src.Kind {
		case "add":
			if target.Exists {
				pf.Status = "blocked"
				pf.Reason = "新建目标已存在，不覆盖"
				plan.Files = append(plan.Files, pf)
				continue
			}
		case "delete":
			if !target.Exists {
				pf.Status = "blocked"
				pf.Reason = "要删除的文件不存在"
				plan.Files = append(plan.Files, pf)
				continue
			}
		default:
			if !target.Exists {
				pf.Status = "blocked"
				pf.Reason = "目标文件不存在"
				plan.Files = append(plan.Files, pf)
				continue
			}
			baseHash := ""
			if opts.BaseHashes != nil {
				baseHash = opts.BaseHashes[strings.ToLower(r.rel)]
			}
			if baseHash != "" && target.Hash != baseHash {
				pf.Status = "blocked"
				pf.Reason = fmt.Sprintf("文件在补丁生成后被修改（基线 %s / 当前 %s）", shortHash(baseHash), shortHash(target.Hash))
				plan.Files = append(plan.Files, pf)
				continue
			}
		}

		// 匹配
		if src.Kind == "add" {
			pf.Offset = 0
			pf.Hunks = make([]patchHunkPlan, len(src.Hunks))
			for hi := range src.Hunks {
				pf.Hunks[hi] = patchHunkPlan{Index: hi, Status: "ok", ApplyAtLine: 1}
			}
			// 新建文件的尾换行要跟补丁意图一致：补丁最后一行带
			// "\ No newline at end of file" 时不能再自作主张补一个 \n
			//（否则哈希与意图不符，还会触发写入时静默重算哈希）。
			final := true
			if n := len(src.Hunks); n > 0 {
				last := src.Hunks[n-1]
				if len(last.Lines) > 0 && last.Lines[len(last.Lines)-1].NoEOL {
					final = false
				}
			}
			text := joinPatchLines(hunkNewLinesAll(src.Hunks), final)
			pf.ResultText = text
			pf.ResultHash = SHA256Hex(buildBytesOrNil(text, target))
			plan.Files = append(plan.Files, pf)
			continue
		}
		if src.Kind == "delete" {
			pf.Hunks = make([]patchHunkPlan, len(src.Hunks))
			for hi := range src.Hunks {
				pf.Hunks[hi] = patchHunkPlan{Index: hi, Status: "ok", ApplyAtLine: 1}
			}
			pf.ResultText = ""
			plan.Files = append(plan.Files, pf)
			continue
		}

		offset, bad, reason := chooseOffset(target.Lines, src.Hunks, opts.AllowOffset, opts.IgnoreWhitespace)
		if bad != nil || reason != "" {
			idx := -1
			if bad != nil {
				for hi := range src.Hunks {
					if &src.Hunks[hi] == bad {
						idx = hi
						break
					}
				}
			}
			pf.Status = "conflict"
			if bad != nil {
				if d := hunkMismatchDetail(target.Lines, bad, 0); d != "" {
					reason = reason + "；" + d
				}
			}
			pf.Reason = reason
			pf.Hunks = make([]patchHunkPlan, len(src.Hunks))
			for hi := range src.Hunks {
				status := "ok"
				r := ""
				if hi == idx || idx < 0 {
					status = "conflict"
					r = reason
				}
				pf.Hunks[hi] = patchHunkPlan{Index: hi, Status: status, Reason: r}
			}
			plan.Files = append(plan.Files, pf)
			continue
		}
		pf.Offset = offset
		selected := map[int]bool{}
		for hi := range src.Hunks {
			selected[hi] = true
		}
		result, segs, failIdx, failReason := applyHunks(target.Lines, src.Hunks, selected, offset, opts.IgnoreWhitespace)
		if failIdx >= 0 {
			pf.Status = "conflict"
			if d := hunkMismatchDetail(target.Lines, &src.Hunks[failIdx], offset); d != "" {
				failReason = failReason + "；" + d
			}
			pf.Reason = failReason
			pf.Hunks = make([]patchHunkPlan, len(src.Hunks))
			for hi := range src.Hunks {
				st, rs := "ok", ""
				if hi == failIdx {
					st, rs = "conflict", failReason
				}
				pf.Hunks[hi] = patchHunkPlan{Index: hi, Status: st, Reason: rs}
			}
			plan.Files = append(plan.Files, pf)
			continue
		}
		if !verifyReverse(result, segs, target.Lines) {
			pf.Status = "conflict"
			pf.Reason = "反向校验失败：补丁结构与文件内容不自洽"
			pf.Hunks = make([]patchHunkPlan, len(src.Hunks))
			for hi := range src.Hunks {
				pf.Hunks[hi] = patchHunkPlan{Index: hi, Status: "conflict", Reason: pf.Reason}
			}
			plan.Files = append(plan.Files, pf)
			continue
		}
		finalNewline := resolveFinalNewline(target.FinalNewline, src.Hunks, target.Lines, offset, segs)
		pf.ResultText = joinPatchLines(result, finalNewline)
		pf.ResultHash = SHA256Hex(buildBytesOrNil(pf.ResultText, target))
		pf.Hunks = make([]patchHunkPlan, len(src.Hunks))
		for hi := range src.Hunks {
			at := src.Hunks[hi].OldStart - 1 + offset
			pf.Hunks[hi] = patchHunkPlan{Index: hi, Status: "ok", ApplyAtLine: at + 1, Pos: at}
		}
		plan.Files = append(plan.Files, pf)
	}
	for _, f := range plan.Files {
		if f.Status == "ok" {
			plan.Added += f.Added
			plan.Removed += f.Removed
		}
	}
	if opts.External {
		if sug, hits, needed := suggestPatchRoot(doc.Files, root, patchPath); sug != "" {
			plan.SuggestedRoot = sug
			plan.SuggestedHits = hits
			plan.SuggestedNeeded = needed
		}
	}
	return plan, nil
}

func hunkNewLinesAll(hunks []patchHunk) []string {
	var out []string
	for i := range hunks {
		out = append(out, hunkNewLines(&hunks[i])...)
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func buildBytesOrNil(text string, t *patchTargetFile) []byte {
	enc, eol, bom := "utf-8", "lf", false
	if t != nil && t.Exists {
		enc, eol, bom = t.Enc, t.EOL, t.HasBOM
	}
	raw, err := chardec.BuildSaveBytes(text, eol, bom, enc)
	if err != nil {
		return []byte(text)
	}
	return raw
}

// resolveFinalNewline 判断结果文件末尾是否带换行：
// 补丁在文件末尾加了行且最后一行有换行 → 带；显式 \ No newline → 不带；否则沿用原文件。
func resolveFinalNewline(orig bool, hunks []patchHunk, lines []string, offset int, segs []appliedSeg) bool {
	final := orig
	endLine := len(lines)
	_ = segs
	for i := range hunks {
		h := &hunks[i]
		if len(h.Lines) == 0 {
			continue
		}
		last := h.Lines[len(h.Lines)-1]
		at := h.OldStart - 1 + offset
		if at+h.OldCount >= endLine {
			if last.NoEOL {
				final = false
			} else if last.T == '+' {
				final = true
			}
		}
	}
	return final
}

type PatchPlanOptions struct {
	AllowOffset      bool
	IgnoreWhitespace bool
	BaseHashes       map[string]string // relPath -> 生成时内容哈希（外部补丁为空）
	External         bool
	StripLevel       int // -1 表示自动探测
}

// ===== 存储与索引 =====

// 宿主注入：应用数据目录与诊断日志由 main 包 init 注入（patch_app.go），
// 包内默认 nil 安全——CLI/测试环境不注入时走各自的安全分支。
var (
	AppDataDir func() string
	Logf       func(level, format string, args ...any)
	// OnWriteBackup 两阶段写入备份点的持久化钩子（wipe-guard 写前快照，方案 §4.2）：
	// 撤销用的字节快照已经读进内存，宿主顺手把它存进可跨会话恢复的备份库。
	// 参数（工作区根 / 相对路径 / 绝对路径 / 原字节）；nil 安全（CLI/测试环境）。
	OnWriteBackup func(root, rel, abs string, content []byte)
)

// logf 宿主日志钩子的 nil 安全包装；未注入时静默（CLI/测试环境）。
func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

func PatchStoreRoot(root string) string {
	if root != "" {
		return filepath.Join(root, ".cadt", "patches")
	}
	if AppDataDir != nil {
		if base := AppDataDir(); base != "" {
			return filepath.Join(base, "patches")
		}
	}
	return ""
}

func ensurePatchDirs(store string, id string) (string, string, error) {
	if store == "" {
		return "", "", NewPatchError(PatchErrNoBackup, "无法确定补丁存储目录")
	}
	backup := filepath.Join(store, "backup", id)
	for _, dir := range []string{store, filepath.Join(store, "manifest"), backup} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", "", &PatchError{Code: PatchErrNoBackup, Msg: "无法创建补丁目录", Detail: err.Error()}
		}
	}
	return backup, filepath.Join(store, "manifest", id+".json"), nil
}

func AppendPatchIndex(store string, entry PatchIndexEntry) error {
	if store == "" {
		return nil
	}
	if err := os.MkdirAll(store, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(store, "index.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

func ReadPatchIndex(store string) []PatchIndexEntry {
	if store == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(store, "index.jsonl"))
	if err != nil {
		return nil
	}
	var out []PatchIndexEntry
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e PatchIndexEntry
		if json.Unmarshal([]byte(line), &e) == nil && e.ID != "" {
			out = append(out, e)
		}
	}
	return out
}

type PatchIndexEntry struct {
	V          int      `json:"v"`
	ID         string   `json:"id"`
	Summary    string   `json:"summary"`
	FileName   string   `json:"fileName"`
	CreatedAt  int64    `json:"createdAt"`
	Root       string   `json:"root"`
	Files      []string `json:"files"`
	Added      int      `json:"added"`
	Removed    int      `json:"removed"`
	Status     string   `json:"status"`
	Mode       string   `json:"mode,omitempty"`
	AppliedAt  int64    `json:"appliedAt,omitempty"`
	RevertedAt int64    `json:"revertedAt,omitempty"`
	PatchPath  string   `json:"patchPath,omitempty"`
}

type patchManifest struct {
	ID      string               `json:"id"`
	Root    string               `json:"root"`
	Mode    string               `json:"mode"`
	Files   []patchManifestEntry `json:"files"`
	Created int64                `json:"createdAt"`
}
type patchManifestEntry struct {
	RelPath    string `json:"relPath"`
	Kind       string `json:"kind"`
	BaseHash   string `json:"baseHash"`
	ResultHash string `json:"resultHash"`
	BackupFile string `json:"backupFile"`
	Enc        string `json:"enc"`
	EOL        string `json:"eol"`
	HasBOM     bool   `json:"hasBom"`
	Size       int64  `json:"size"`
}

func CollectPatchMetas(store string) []PatchMeta {
	entries := ReadPatchIndex(store)
	byID := map[string]*PatchMeta{}
	order := []string{}
	for _, e := range entries {
		m, ok := byID[e.ID]
		if !ok {
			m = &PatchMeta{ID: e.ID, Summary: e.Summary, FileName: e.FileName, CreatedAt: e.CreatedAt, Root: e.Root, PatchPath: e.PatchPath}
			byID[e.ID] = m
			order = append(order, e.ID)
		}
		m.Files = e.Files
		m.Added = e.Added
		m.Removed = e.Removed
		if e.Status != "" {
			m.Status = e.Status
		}
		if e.Mode != "" {
			m.Mode = e.Mode
		}
		if e.AppliedAt > 0 {
			m.AppliedAt = e.AppliedAt
		}
		if e.RevertedAt > 0 {
			m.RevertedAt = e.RevertedAt
		}
	}
	out := make([]PatchMeta, 0, len(order))
	for i := len(order) - 1; i >= 0; i-- {
		out = append(out, *byID[order[i]])
	}
	return out
}

// FileNames 取计划内全部相对路径（入索引用）。
func FileNames(plan *patchPlan) []string {
	out := make([]string, 0, len(plan.Files))
	for _, f := range plan.Files {
		out = append(out, f.RelPath)
	}
	return out
}

// PlanHasAddedFile 补丁里是否有新建文件（+0/−0 但新建空文件时 Added/Removed 也可能是 0）。
func PlanHasAddedFile(plan *patchPlan) bool {
	for _, f := range plan.Files {
		if f != nil && f.Kind == "add" {
			return true
		}
	}
	return false
}

// PlanHasApplicableFile 是否存在可直接应用的 hunk（status=ok）。
// 全为 blocked/conflict/unsupported 时这份补丁必然要重写，不该落盘。
func PlanHasApplicableFile(plan *patchPlan) bool {
	for _, f := range plan.Files {
		if f != nil && f.Status == "ok" {
			return true
		}
	}
	return false
}

// FirstPlanReason 取第一个失败文件的可读原因（附相对路径），给模型定位用。
func FirstPlanReason(plan *patchPlan) string {
	for _, f := range plan.Files {
		if f == nil || f.Status == "ok" {
			continue
		}
		rel := f.RelPath
		if rel == "" {
			rel = "(路径未知)"
		}
		if f.Reason != "" {
			return rel + "：" + f.Reason
		}
		return rel + "：无法应用"
	}
	return ""
}
