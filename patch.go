package main

// 补丁（.patch / .diff）解析、匹配规划、两阶段应用与撤销。
//
// 设计要点（详见 docs/finished-plans/ai-patch-approval.md）：
//   - 解析与应用全部在 Go 侧，AI 面板只是调用方之一，CLI 也能直接用；
//   - 匹配严格：上下文必须完整、位置必须唯一、同一文件位移必须全局一致；
//   - 预览即契约：预览时算定每个 hunk 的落点与基线哈希，应用时逐条复核；
//   - 两阶段：先全部预演（不写盘），再按 atomic / partial 模式提交；
//   - 备份是字节快照，撤销据此还原；写盘用 temp + rename，永不出现半截文件。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	patchMaxTextBytes = 2 << 20   // 外部 / CLI 补丁文本上限
	patchAIMaxBytes   = 256 << 10 // AI 单次提交上限（与 AI_WRITE_LIMIT 对齐）
	patchMaxFiles     = 200
	patchMaxHunks     = 500
	patchMaxFileBytes = 10 << 20 // 参与补丁的单文件上限（与只读阈值一致）
	patchOffsetLimit  = 200
	patchPlanTTL      = 30 * time.Minute
	patchRetainCount  = 50
	patchRetainDays   = 30
	patchKeepPatches  = 512 << 10 // index.jsonl 压缩阈值
)

// 错误码：给 UI 与模型共用，不要随意改名。
const (
	patchErrParse        = "PATCH_PARSE"
	patchErrEmpty        = "PATCH_EMPTY"
	patchErrLimit        = "PATCH_LIMIT"
	patchErrPathDenied   = "PATCH_PATH_DENIED"
	patchErrUnsupported  = "PATCH_UNSUPPORTED"
	patchErrHunkConflict = "PATCH_HUNK_CONFLICT"
	patchErrFileDrift    = "PATCH_FILE_DRIFT"
	patchErrUserDenied   = "PATCH_USER_DENIED"
	patchErrApplyIO      = "PATCH_APPLY_IO"
	patchErrRollback     = "PATCH_ROLLBACK_FAILED"
	patchErrBusy         = "PATCH_BUSY"
	patchErrFileLocked   = "PATCH_FILE_LOCKED"
	patchErrConcurrent   = "PATCH_CONCURRENT_MODIFIED"
	patchErrNoBackup     = "PATCH_NO_BACKUP"
	patchErrDiskFull     = "PATCH_DISK_FULL"
	patchErrNotRequested = "PATCH_NOT_REQUESTED"
	patchErrBackend      = "PATCH_BACKEND"
)

type patchError struct {
	Code   string `json:"code"`
	Msg    string `json:"message"`
	Detail string `json:"detail,omitempty"`
}

func (e *patchError) Error() string {
	if e.Detail != "" {
		return e.Code + ": " + e.Msg + "（" + e.Detail + "）"
	}
	return e.Code + ": " + e.Msg
}

func newPatchError(code, msg string) *patchError { return &patchError{Code: code, Msg: msg} }

func patchErrorOf(err error) *patchError {
	var pe *patchError
	if errors.As(err, &pe) {
		return pe
	}
	return &patchError{Code: patchErrBackend, Msg: err.Error()}
}

// ===== 对外结构（Wails 直接序列化给前端） =====

type PatchLineOut struct {
	T       string `json:"t"`
	Text    string `json:"text"`
	OldLine int    `json:"oldLine,omitempty"`
	NewLine int    `json:"newLine,omitempty"`
}

type PatchHunkOut struct {
	Index       int            `json:"index"`
	Header      string         `json:"header"`
	OldStart    int            `json:"oldStart"`
	OldCount    int            `json:"oldCount"`
	NewStart    int            `json:"newStart"`
	NewCount    int            `json:"newCount"`
	Status      string         `json:"status"`
	Reason      string         `json:"reason,omitempty"`
	ApplyAtLine int            `json:"applyAtLine"`
	Lines       []PatchLineOut `json:"lines"`
}

type PatchFileOut struct {
	RelPath  string         `json:"relPath"`
	Kind     string         `json:"kind"`
	Status   string         `json:"status"`
	Reason   string         `json:"reason,omitempty"`
	Added    int            `json:"added"`
	Removed  int            `json:"removed"`
	Offset   int            `json:"offset"`
	BaseHash string         `json:"baseHash,omitempty"`
	Enc      string         `json:"enc,omitempty"`
	EOL      string         `json:"eol,omitempty"`
	HasBOM   bool           `json:"hasBom,omitempty"`
	Hunks    []PatchHunkOut `json:"hunks"`
}

type PatchPreview struct {
	PlanID      string         `json:"planId"`
	PatchID     string         `json:"patchId"`
	Summary     string         `json:"summary"`
	Root        string         `json:"root"`
	PatchPath   string         `json:"patchPath"`
	Files       []PatchFileOut `json:"files"`
	Added       int            `json:"added"`
	Removed     int            `json:"removed"`
	Applicable  bool           `json:"applicable"`
	CreatedAt   int64          `json:"createdAt"`
	DefaultMode string         `json:"defaultMode"`
	External    bool           `json:"external,omitempty"`
	// 当前根下目标文件普遍缺失时，就近探测到的高命中率目录（仅建议，不自动切换）
	SuggestedRoot   string `json:"suggestedRoot,omitempty"`
	SuggestedHits   int    `json:"suggestedHits,omitempty"`
	SuggestedNeeded int    `json:"suggestedNeeded,omitempty"`
}

type PatchFileResult struct {
	RelPath string `json:"relPath"`
	Status  string `json:"status"` // applied | skipped | failed
	Reason  string `json:"reason,omitempty"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
}

type PatchApplyResult struct {
	OK         bool              `json:"ok"`
	Code       string            `json:"code,omitempty"`
	Message    string            `json:"message,omitempty"`
	Mode       string            `json:"mode"`
	Applied    int               `json:"applied"`
	Skipped    int               `json:"skipped"`
	Added      int               `json:"added"`
	Removed    int               `json:"removed"`
	Files      []PatchFileResult `json:"files"`
	RevertID   string            `json:"revertId,omitempty"`
	BackupDir  string            `json:"backupDir,omitempty"`
	Unrestored []string          `json:"unrestored,omitempty"`
}

type PatchRevertResult struct {
	OK      bool     `json:"ok"`
	Code    string   `json:"code,omitempty"`
	Message string   `json:"message,omitempty"`
	Files   []string `json:"files"`
}

type PatchMeta struct {
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

// ===== 内部模型 =====

type patchLine struct {
	T     byte // ' ' / '+' / '-'
	Text  string
	NoEOL bool
}

type patchHunk struct {
	OldStart, OldCount int
	NewStart, NewCount int
	Header             string
	LineNo             int
	Lines              []patchLine
}

type patchFile struct {
	RawOld, RawNew string
	RelPath        string
	Kind           string // modify | add | delete | unsupported
	UnsupportedMsg string
	Hunks          []patchHunk
	Added, Removed int
}

type patchDoc struct {
	Files          []patchFile
	Added, Removed int
}

var patchHunkRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func shortHash(h string) string {
	if len(h) > 8 {
		return h[:8]
	}
	return h
}

// ===== 解析 =====

func parsePatchText(text string) (*patchDoc, error) {
	text = strings.TrimPrefix(text, "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	if strings.TrimSpace(text) == "" {
		return nil, newPatchError(patchErrEmpty, "补丁内容为空")
	}
	lines := strings.Split(text, "\n")
	doc := &patchDoc{}
	cur := -1
	var hunk *patchHunk

	finishHunk := func() error {
		if hunk == nil || cur < 0 {
			return nil
		}
		oldCount, newCount := 0, 0
		for _, ln := range hunk.Lines {
			if ln.T != '+' {
				oldCount++
			}
			if ln.T != '-' {
				newCount++
			}
		}
		if oldCount != hunk.OldCount || newCount != hunk.NewCount {
			return &patchError{
				Code:   patchErrParse,
				Msg:    fmt.Sprintf("hunk 行数与 @@ 头不一致（第 %d 行）", hunk.LineNo),
				Detail: fmt.Sprintf("头部声明 -%d,%d +%d,%d，实际数出 -%d +%d", hunk.OldStart, hunk.OldCount, hunk.NewStart, hunk.NewCount, oldCount, newCount),
			}
		}
		doc.Files[cur].Hunks = append(doc.Files[cur].Hunks, *hunk)
		doc.Files[cur].Added += countCtx(hunk, '+')
		doc.Files[cur].Removed += countCtx(hunk, '-')
		hunk = nil
		return nil
	}

	for i := 0; i < len(lines); i++ {
		raw := lines[i]
		lineNo := i + 1
		switch {
		case strings.HasPrefix(raw, "diff --git "):
			if err := finishHunk(); err != nil {
				return nil, err
			}
			oldPath, newPath := parseGitDiffHeader(raw)
			doc.Files = append(doc.Files, patchFile{RawOld: oldPath, RawNew: newPath, Kind: "modify"})
			cur = len(doc.Files) - 1
		case strings.HasPrefix(raw, "new file mode"):
			if cur >= 0 {
				doc.Files[cur].Kind = "add"
			}
		case strings.HasPrefix(raw, "deleted file mode"):
			if cur >= 0 {
				doc.Files[cur].Kind = "delete"
			}
		case strings.HasPrefix(raw, "rename from "), strings.HasPrefix(raw, "rename to "),
			strings.HasPrefix(raw, "old mode "), strings.HasPrefix(raw, "new mode "):
			if cur >= 0 {
				doc.Files[cur].Kind = "unsupported"
				doc.Files[cur].UnsupportedMsg = "重命名 / 权限位变更"
			}
		case strings.HasPrefix(raw, "Binary files "), strings.HasPrefix(raw, "GIT binary patch"):
			if cur >= 0 {
				doc.Files[cur].Kind = "unsupported"
				doc.Files[cur].UnsupportedMsg = "二进制补丁"
			}
		case strings.HasPrefix(raw, "--- "):
			if err := finishHunk(); err != nil {
				return nil, err
			}
			oldPath := strings.TrimSpace(raw[4:])
			if cur < 0 || (doc.Files[cur].RawOld != "" && len(doc.Files[cur].Hunks) > 0) {
				doc.Files = append(doc.Files, patchFile{Kind: "modify"})
				cur = len(doc.Files) - 1
			}
			if doc.Files[cur].RawOld == "" {
				doc.Files[cur].RawOld = oldPath
			}
			if isDevNull(oldPath) && doc.Files[cur].Kind == "modify" {
				doc.Files[cur].Kind = "add"
			}
		case strings.HasPrefix(raw, "+++ "):
			if cur < 0 {
				return nil, &patchError{Code: patchErrParse, Msg: "+++ 之前没有对应的 ---", Detail: fmt.Sprintf("第 %d 行", lineNo)}
			}
			newPath := strings.TrimSpace(raw[4:])
			doc.Files[cur].RawNew = newPath
			if isDevNull(newPath) && doc.Files[cur].Kind == "modify" {
				doc.Files[cur].Kind = "delete"
			}
		case strings.HasPrefix(raw, "@@"):
			if cur < 0 {
				return nil, &patchError{Code: patchErrParse, Msg: "@@ 之前没有文件头", Detail: fmt.Sprintf("第 %d 行", lineNo)}
			}
			if err := finishHunk(); err != nil {
				return nil, err
			}
			m := patchHunkRe.FindStringSubmatch(raw)
			if m == nil {
				return nil, &patchError{Code: patchErrParse, Msg: "无法解析 hunk 头", Detail: fmt.Sprintf("第 %d 行：%s", lineNo, raw)}
			}
			oldStart := atoiSafe(m[1])
			oldCount := 1
			if m[2] != "" {
				oldCount = atoiSafe(m[2])
			}
			newStart := atoiSafe(m[3])
			newCount := 1
			if m[4] != "" {
				newCount = atoiSafe(m[4])
			}
			hunk = &patchHunk{OldStart: oldStart, OldCount: oldCount, NewStart: newStart, NewCount: newCount, Header: raw, LineNo: lineNo}
			if len(doc.Files[cur].Hunks) >= patchMaxHunks {
				return nil, newPatchError(patchErrLimit, fmt.Sprintf("单文件 hunk 超过 %d 个", patchMaxHunks))
			}
		case hunk != nil && (strings.HasPrefix(raw, " ") || strings.HasPrefix(raw, "+") || strings.HasPrefix(raw, "-")):
			noEOL := false
			body := raw[1:]
			if i+1 < len(lines) && strings.HasPrefix(lines[i+1], "\\ No newline at end of file") {
				noEOL = true
				i++
			}
			hunk.Lines = append(hunk.Lines, patchLine{T: raw[0], Text: body, NoEOL: noEOL})
		case hunk != nil && raw == "":
			// 传输过程常把「空上下文行」（单个空格）的尾空格吃掉，按空上下文处理；
			// 但补丁文本末尾的分隔空行不能算进去，否则行数永远对不上。
			oc, nc := 0, 0
			for _, ln := range hunk.Lines {
				if ln.T != '+' {
					oc++
				}
				if ln.T != '-' {
					nc++
				}
			}
			if oc < hunk.OldCount && nc < hunk.NewCount {
				hunk.Lines = append(hunk.Lines, patchLine{T: ' ', Text: ""})
			}
		case strings.HasPrefix(raw, "\\ No newline at end of file"):
			if hunk != nil && len(hunk.Lines) > 0 {
				hunk.Lines[len(hunk.Lines)-1].NoEOL = true
			}
		default:
			// 前言（From / Subject / index / similarity 等）与补丁尾部杂项，忽略
		}
	}
	if err := finishHunk(); err != nil {
		return nil, err
	}
	// 没有 hunk 的文件（例如只有 diff --git 头）剔除
	kept := doc.Files[:0]
	for _, f := range doc.Files {
		if f.Kind == "unsupported" || len(f.Hunks) > 0 || f.Kind == "add" || f.Kind == "delete" {
			kept = append(kept, f)
		}
	}
	doc.Files = kept
	if len(doc.Files) == 0 {
		return nil, newPatchError(patchErrEmpty, "补丁里没有任何文件改动（至少需要一个 @@ hunk）")
	}
	if len(doc.Files) > patchMaxFiles {
		return nil, newPatchError(patchErrLimit, fmt.Sprintf("文件数超过 %d 个", patchMaxFiles))
	}
	for i := range doc.Files {
		doc.Added += doc.Files[i].Added
		doc.Removed += doc.Files[i].Removed
	}
	return doc, nil
}

func countCtx(h *patchHunk, t byte) int {
	n := 0
	for _, ln := range h.Lines {
		if ln.T == t {
			n++
		}
	}
	return n
}

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func isDevNull(p string) bool { return strings.TrimSpace(p) == "/dev/null" }

func parseGitDiffHeader(line string) (string, string) {
	rest := strings.TrimSpace(strings.TrimPrefix(line, "diff --git "))
	// 形如 a/x b/x；带空格路径会被引号包起来
	if strings.HasPrefix(rest, "\"") {
		if idx := strings.Index(rest[1:], "\" \""); idx >= 0 {
			return rest[:idx+2], rest[idx+4:]
		}
		return rest, rest
	}
	idx := strings.Index(rest, " b/")
	if idx < 0 {
		return rest, rest
	}
	return rest[:idx], rest[idx+1:]
}

// unquoteGitPath 解码 git 的 C 风格引号路径："a/\344\270\255.txt"
func unquoteGitPath(s string) string {
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return s
	}
	body := s[1 : len(s)-1]
	var out []byte
	for i := 0; i < len(body); i++ {
		c := body[i]
		if c != '\\' || i+1 >= len(body) {
			out = append(out, c)
			continue
		}
		i++
		switch body[i] {
		case 'n':
			out = append(out, '\n')
		case 't':
			out = append(out, '\t')
		case 'r':
			out = append(out, '\r')
		case '"', '\\':
			out = append(out, body[i])
		case '0', '1', '2', '3', '4', '5', '6', '7':
			if i+2 < len(body) {
				v, err := strconv.ParseUint(body[i:i+3], 8, 8)
				if err == nil {
					out = append(out, byte(v))
					i += 2
					continue
				}
			}
			out = append(out, body[i])
		default:
			out = append(out, body[i])
		}
	}
	return string(out)
}

// stripPatchPath 去掉前 n 级目录，并做安全校验；返回相对路径（正斜杠）。
func stripPatchPath(raw string, strip int) (string, *patchError) {
	p := strings.TrimSpace(raw)
	if p == "" || isDevNull(p) {
		return "", nil
	}
	p = strings.ReplaceAll(p, "\\", "/")
	if strings.Contains(p, "\"") {
		p = unquoteGitPath(p)
	}
	p = strings.TrimPrefix(p, "./")
	parts := strings.Split(p, "/")
	if strip > 0 {
		if len(parts) <= strip {
			return "", &patchError{Code: patchErrPathDenied, Msg: "路径层级超出实际深度", Detail: raw}
		}
		parts = parts[strip:]
	}
	clean := strings.Join(parts, "/")
	if clean == "" {
		return "", &patchError{Code: patchErrPathDenied, Msg: "路径为空", Detail: raw}
	}
	if strings.HasPrefix(clean, "/") || strings.Contains(clean, ":") {
		return "", &patchError{Code: patchErrPathDenied, Msg: "不允许绝对路径或盘符", Detail: raw}
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", &patchError{Code: patchErrPathDenied, Msg: "不允许上跳目录", Detail: raw}
		}
		if seg == "." || seg == "" {
			return "", &patchError{Code: patchErrPathDenied, Msg: "路径含空段或 .", Detail: raw}
		}
		if strings.HasSuffix(seg, " ") || strings.HasSuffix(seg, ".") {
			return "", &patchError{Code: patchErrPathDenied, Msg: "路径段以空格或点结尾（Windows 非法）", Detail: raw}
		}
	}
	lower := strings.ToLower(clean)
	if lower == ".git" || strings.HasPrefix(lower, ".git/") {
		return "", &patchError{Code: patchErrPathDenied, Msg: "不允许修改 .git 目录", Detail: raw}
	}
	if strings.HasPrefix(lower, ".cadt/patches/") || lower == ".cadt/patches" ||
		lower == ".cadt/permissions.json" {
		return "", &patchError{Code: patchErrPathDenied, Msg: "不允许修改补丁目录或权限配置", Detail: raw}
	}
	return clean, nil
}

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
		return nil, &patchError{Code: patchErrFileLocked, Msg: "无法访问目标文件", Detail: err.Error()}
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
		return nil, newPatchError(patchErrLimit, "目标文件超过 10 MB，请手工处理")
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return nil, &patchError{Code: patchErrFileLocked, Msg: "无法读取目标文件（可能被占用）", Detail: err.Error()}
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
	text, enc, err := decodeBytes(body, "")
	if err != nil {
		return nil, &patchError{Code: patchErrApplyIO, Msg: "目标文件解码失败", Detail: err.Error()}
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
	t.Hash = sha256Hex(raw)
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

	SuggestedRoot   string
	SuggestedHits   int
	SuggestedNeeded int
}

var (
	patchPlanMu sync.Mutex
	patchPlans  = map[string]*patchPlan{}
)

func putPatchPlan(p *patchPlan) {
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

func getPatchPlan(id string) *patchPlan {
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

func (p *patchPlan) toPreview() *PatchPreview {
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
				src := f.PatchFile.Hunks[h.Index]
				ho.Header = src.Header
				ho.OldStart = src.OldStart
				ho.OldCount = src.OldCount
				ho.NewStart = src.NewStart
				ho.NewCount = src.NewCount
				oldLine, newLine := src.OldStart, src.NewStart
				for _, ln := range src.Lines {
					pl := PatchLineOut{T: string(ln.T), Text: ln.Text}
					if ln.T == '-' {
						pl.OldLine = oldLine
						oldLine++
					} else if ln.T == '+' {
						pl.NewLine = newLine
						newLine++
					} else {
						pl.OldLine = oldLine
						pl.NewLine = newLine
						oldLine++
						newLine++
					}
					ho.Lines = append(ho.Lines, pl)
				}
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

func resolvePatchRootPath(root, rel string) (string, *patchError) {
	abs := filepath.Join(root, filepath.FromSlash(rel))
	abs = filepath.Clean(abs)
	rootClean := filepath.Clean(root)
	// 父目录真实路径必须在根内（防 junction / 符号链接逃逸）
	dir := filepath.Dir(abs)
	if realDir, err := filepath.EvalSymlinks(dir); err == nil {
		if realRoot, err2 := filepath.EvalSymlinks(rootClean); err2 == nil {
			relReal, err3 := filepath.Rel(realRoot, realDir)
			if err3 != nil || relReal == ".." || strings.HasPrefix(relReal, ".."+string(filepath.Separator)) {
				return "", &patchError{Code: patchErrPathDenied, Msg: "路径解析后超出工作区", Detail: rel}
			}
		}
	}
	return abs, nil
}

func buildPatchPlan(doc *patchDoc, root, patchID, summary, patchPath string, opts patchPlanOptions) (*patchPlan, error) {
	root = filepath.Clean(root)
	if root == "" {
		return nil, newPatchError(patchErrPathDenied, "缺少工作区根目录")
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, newPatchError(patchErrPathDenied, "工作区根目录不存在")
	}
	plan := &patchPlan{
		PlanID:    newPatchRunID("plan"),
		PatchID:   patchID,
		Summary:   summary,
		Root:      root,
		PatchPath: patchPath,
		CreatedAt: time.Now(),
		External:  opts.External,
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
			return nil, &patchError{Code: patchErrPathDenied, Msg: "同一路径在补丁中出现多次", Detail: fmt.Sprintf("%s（第 %d 与第 %d 个文件）", r.rel, prev+1, i+1)}
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
			pf.Reason = patchErrorOf(err).Msg
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
			text := joinPatchLines(hunkNewLinesAll(src.Hunks), true)
			pf.ResultText = text
			pf.ResultHash = sha256Hex(buildBytesOrNil(text, target))
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
		pf.ResultHash = sha256Hex(buildBytesOrNil(pf.ResultText, target))
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
	raw, err := buildSaveBytes(text, eol, bom, enc)
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

type patchPlanOptions struct {
	AllowOffset      bool
	IgnoreWhitespace bool
	BaseHashes       map[string]string // relPath -> 生成时内容哈希（外部补丁为空）
	External         bool
	StripLevel       int // -1 表示自动探测
}

// ===== 存储与索引 =====

func patchStoreRoot(root string) string {
	if root != "" {
		return filepath.Join(root, ".cadt", "patches")
	}
	if base := appDataRoot(); base != "" {
		return filepath.Join(base, "patches")
	}
	return ""
}

func ensurePatchDirs(store string, id string) (string, string, error) {
	if store == "" {
		return "", "", newPatchError(patchErrNoBackup, "无法确定补丁存储目录")
	}
	backup := filepath.Join(store, "backup", id)
	for _, dir := range []string{store, filepath.Join(store, "manifest"), backup} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", "", &patchError{Code: patchErrNoBackup, Msg: "无法创建补丁目录", Detail: err.Error()}
		}
	}
	return backup, filepath.Join(store, "manifest", id+".json"), nil
}

func appendPatchIndex(store string, entry patchIndexEntry) error {
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

func readPatchIndex(store string) []patchIndexEntry {
	if store == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(store, "index.jsonl"))
	if err != nil {
		return nil
	}
	var out []patchIndexEntry
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e patchIndexEntry
		if json.Unmarshal([]byte(line), &e) == nil && e.ID != "" {
			out = append(out, e)
		}
	}
	return out
}

type patchIndexEntry struct {
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

func collectPatchMetas(store string) []PatchMeta {
	entries := readPatchIndex(store)
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

// ===== 写入 =====

var (
	patchPathLockMu sync.Mutex
	patchPathLocks  = map[string]*sync.Mutex{}
)

func lockPatchPath(abs string) func() {
	key := strings.ToLower(filepath.Clean(abs))
	patchPathLockMu.Lock()
	mu, ok := patchPathLocks[key]
	if !ok {
		mu = &sync.Mutex{}
		patchPathLocks[key] = mu
	}
	patchPathLockMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

func writePatchFileAtomic(abs string, data []byte) error {
	dir := filepath.Dir(abs)
	tmp, err := os.CreateTemp(dir, ".cadt-patch-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		// 非致命
	}
	return replaceFileAtomic(tmpName, abs)
}

// applyPatchPlan 按模式提交计划：atomic 要么全成要么零变更；partial 跳过失败项。
func applyPatchPlan(plan *patchPlan, files []string, hunksByFile map[string][]int, mode string) (*PatchApplyResult, error) {
	if mode != "partial" {
		mode = "atomic"
	}
	res := &PatchApplyResult{Mode: mode}
	selected := map[string]bool{}
	for _, f := range files {
		selected[strings.ToLower(filepath.ToSlash(f))] = true
	}
	type item struct {
		pf  *patchPlanFile
		why string
	}
	var todo []item
	var skipped []PatchFileResult
	for _, pf := range plan.Files {
		pick := len(selected) == 0 || selected[strings.ToLower(pf.RelPath)]
		if !pick {
			continue
		}
		if pf.Status != "ok" {
			if mode == "partial" {
				skipped = append(skipped, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: pf.Reason})
				continue
			}
			reason := pf.Reason
			if reason == "" {
				reason = "该文件无法应用"
			}
			res.Code = patchErrHunkConflict
			res.Message = fmt.Sprintf("未应用任何更改：%s（%s）", pf.RelPath, reason)
			res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "failed", Reason: reason})
			for _, other := range plan.Files {
				if other == pf {
					continue
				}
				if len(selected) == 0 || selected[strings.ToLower(other.RelPath)] {
					res.Files = append(res.Files, PatchFileResult{RelPath: other.RelPath, Status: "notapplied", Reason: "整体失败，未执行"})
				}
			}
			return res, nil
		}
		// 选中子集：重新计算该文件的结果
		if idxs, ok := hunksByFile[pf.RelPath]; ok && len(idxs) > 0 && pf.Kind == "modify" && pf.PatchFile != nil {
			if len(idxs) != len(pf.PatchFile.Hunks) {
				sel := map[int]bool{}
				for _, i := range idxs {
					sel[i] = true
				}
				target := pf.Target
				out, segs, failIdx, reason := applyHunks(target.Lines, pf.PatchFile.Hunks, sel, pf.Offset, false)
				if failIdx >= 0 {
					if mode == "partial" {
						skipped = append(skipped, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: reason})
						continue
					}
					res.Code = patchErrHunkConflict
					res.Message = fmt.Sprintf("未应用任何更改：%s（%s）", pf.RelPath, reason)
					return res, nil
				}
				if !verifyReverse(out, segs, target.Lines) {
					if mode == "partial" {
						skipped = append(skipped, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: "反向校验失败"})
						continue
					}
					res.Code = patchErrApplyIO
					res.Message = "未应用任何更改：反向校验失败"
					return res, nil
				}
				final := resolveFinalNewline(target.FinalNewline, pf.PatchFile.Hunks, target.Lines, pf.Offset, segs)
				pf.ResultText = joinPatchLines(out, final)
				pf.ResultHash = sha256Hex(buildBytesOrNil(pf.ResultText, target))
			}
		}
		todo = append(todo, item{pf: pf})
	}
	if len(todo) == 0 {
		res.Applied = 0
		res.Skipped = len(skipped)
		res.Files = skipped
		if len(skipped) > 0 {
			res.Code = patchErrHunkConflict
			res.Message = "没有可应用的文件"
			return res, nil
		}
		res.OK = true
		return res, nil
	}

	store := patchStoreRoot(plan.Root)
	id := plan.PatchID
	if id == "" {
		id = newPatchRunID("ext")
	}
	backupDir, manifestPath, err := ensurePatchDirs(store, id)
	if err != nil {
		res.Code = patchErrNoBackup
		res.Message = patchErrorOf(err).Msg
		return res, nil
	}
	// 磁盘空间预检（粗略：备份大小 ≈ 将被改写文件的总大小）
	var need int64
	for _, it := range todo {
		if it.pf.Target != nil && it.pf.Target.Exists {
			need += it.pf.Target.Size
		}
	}
	if need > 0 && !hasEnoughDisk(backupDir, uint64(need)) {
		res.Code = patchErrDiskFull
		res.Message = "磁盘空间不足，无法创建备份"
		return res, nil
	}

	// 备份（字节快照）
	manifest := patchManifest{ID: id, Root: plan.Root, Mode: mode, Created: time.Now().Unix()}
	backupMap := map[string]string{}
	for i, it := range todo {
		pf := it.pf
		if pf.Target == nil || !pf.Target.Exists {
			manifest.Files = append(manifest.Files, patchManifestEntry{RelPath: pf.RelPath, Kind: pf.Kind, BaseHash: "", ResultHash: pf.ResultHash})
			continue
		}
		name := fmt.Sprintf("%03d-%s", i, strings.ReplaceAll(pf.RelPath, "/", "_"))
		dest := filepath.Join(backupDir, name)
		raw, rerr := os.ReadFile(pf.Abs)
		if rerr != nil {
			res.Code = patchErrNoBackup
			res.Message = "备份失败：" + rerr.Error()
			return res, nil
		}
		if werr := os.WriteFile(dest, raw, 0o644); werr != nil {
			res.Code = patchErrNoBackup
			res.Message = "备份失败：" + werr.Error()
			return res, nil
		}
		backupMap[pf.RelPath] = dest
		manifest.Files = append(manifest.Files, patchManifestEntry{
			RelPath: pf.RelPath, Kind: pf.Kind, BaseHash: pf.Target.Hash, ResultHash: pf.ResultHash,
			BackupFile: name, Enc: pf.Target.Enc, EOL: pf.Target.EOL, HasBOM: pf.Target.HasBOM, Size: pf.Target.Size,
		})
	}
	if b, err := json.MarshalIndent(manifest, "", "  "); err == nil {
		_ = os.WriteFile(manifestPath, b, 0o644)
	}

	// WAL：applying 先落盘
	fileList := make([]string, 0, len(todo))
	for _, it := range todo {
		fileList = append(fileList, it.pf.RelPath)
	}
	_ = appendPatchIndex(store, patchIndexEntry{
		V: 1, ID: id, Summary: plan.Summary, FileName: filepath.Base(plan.PatchPath),
		CreatedAt: plan.CreatedAt.Unix(), Root: plan.Root, Files: fileList,
		Added: plan.Added, Removed: plan.Removed, Status: "applying", Mode: mode, PatchPath: plan.PatchPath,
	})

	// 按路径排序加锁，避免交叉死锁
	sort.Slice(todo, func(i, j int) bool { return todo[i].pf.Abs < todo[j].pf.Abs })
	releases := make([]func(), 0, len(todo))
	for _, it := range todo {
		releases = append(releases, lockPatchPath(it.pf.Abs))
	}
	releaseWS, lockErr := lockPatchWorkspace(plan.Root, 3*time.Second)
	if lockErr != nil {
		for _, rel := range releases {
			rel()
		}
		res.Code = patchErrBusy
		res.Message = "另一个窗口正在应用补丁，请稍后再试"
		return res, nil
	}
	defer releaseWS()
	defer func() {
		for _, rel := range releases {
			rel()
		}
	}()

	var written []*patchPlanFile
	rollback := func() []string {
		var bad []string
		for i := len(written) - 1; i >= 0; i-- {
			pf := written[i]
			if pf.Target == nil || !pf.Target.Exists {
				// 新建文件：删除
				if err := os.Remove(pf.Abs); err != nil && !os.IsNotExist(err) {
					bad = append(bad, pf.RelPath)
				}
				continue
			}
			raw, err := os.ReadFile(backupMap[pf.RelPath])
			if err != nil {
				bad = append(bad, pf.RelPath)
				continue
			}
			if err := writePatchFileAtomic(pf.Abs, raw); err != nil {
				bad = append(bad, pf.RelPath)
			}
		}
		return bad
	}

	for _, it := range todo {
		pf := it.pf
		// 写入前最后一次校验（TOCTOU 窗口压缩到最小）
		if pf.Target != nil && pf.Target.Exists {
			cur, rerr := os.ReadFile(pf.Abs)
			if rerr != nil {
				res.Code = patchErrFileLocked
				res.Message = fmt.Sprintf("%s：无法读取（可能被占用）", pf.RelPath)
				res.Unrestored = rollback()
				return res, nil
			}
			if sha256Hex(cur) != pf.Target.Hash {
				res.Code = patchErrConcurrent
				res.Message = fmt.Sprintf("%s：文件在应用过程中被其他程序修改", pf.RelPath)
				res.Unrestored = rollback()
				return res, nil
			}
		}
		if pf.Kind == "delete" {
			if err := movePathToRecycleBin(pf.Abs); err != nil {
				if rerr := os.Remove(pf.Abs); rerr != nil {
					res.Code = patchErrApplyIO
					res.Message = fmt.Sprintf("%s：删除失败（%s）", pf.RelPath, rerr)
					res.Unrestored = rollback()
					return res, nil
				}
			}
			written = append(written, pf)
			res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "applied", Removed: pf.Removed})
			res.Applied++
			res.Removed += pf.Removed
			continue
		}
		if pf.Kind == "add" {
			if err := os.MkdirAll(filepath.Dir(pf.Abs), 0o755); err != nil {
				res.Code = patchErrApplyIO
				res.Message = fmt.Sprintf("%s：无法创建父目录（%s）", pf.RelPath, err)
				res.Unrestored = rollback()
				return res, nil
			}
		}
		data := buildBytesOrNil(pf.ResultText, pf.Target)
		if sha256Hex(data) != pf.ResultHash {
			// 结果哈希不稳定（编码/换行差异），以实际写入内容为准重算
			pf.ResultHash = sha256Hex(data)
		}
		if err := writePatchFileAtomic(pf.Abs, data); err != nil {
			if mode == "partial" {
				res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: "写入失败：" + err.Error()})
				res.Skipped++
				continue
			}
			res.Code = patchErrApplyIO
			res.Message = fmt.Sprintf("%s：写入失败（%s）", pf.RelPath, err)
			res.Unrestored = rollback()
			return res, nil
		}
		// 写入后读回校验
		if back, err := os.ReadFile(pf.Abs); err == nil && sha256Hex(back) != pf.ResultHash {
			if mode == "partial" {
				_ = writePatchFileAtomic(pf.Abs, mustReadOrNil(backupMap[pf.RelPath]))
				res.Skipped++
				res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: "写入后校验不一致，已回滚"})
				continue
			}
			res.Code = patchErrConcurrent
			res.Message = fmt.Sprintf("%s：写入后校验不一致（文件可能被其他程序覆盖）", pf.RelPath)
			res.Unrestored = rollback()
			return res, nil
		}
		written = append(written, pf)
		res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "applied", Added: pf.Added, Removed: pf.Removed})
		res.Applied++
		res.Added += pf.Added
		res.Removed += pf.Removed
	}

	status := "applied"
	if res.Skipped > 0 && res.Applied > 0 {
		status = "partial"
	} else if res.Applied == 0 {
		status = "failed"
	}
	_ = appendPatchIndex(store, patchIndexEntry{
		V: 1, ID: id, Summary: plan.Summary, FileName: filepath.Base(plan.PatchPath),
		CreatedAt: plan.CreatedAt.Unix(), Root: plan.Root, Files: fileList,
		Added: res.Added, Removed: res.Removed, Status: status, Mode: mode,
		AppliedAt: time.Now().Unix(), PatchPath: plan.PatchPath,
	})
	for _, s := range skipped {
		res.Files = append(res.Files, s)
	}
	res.Skipped += len(skipped)
	res.OK = res.Applied > 0 && (mode == "partial" || res.Skipped == 0)
	if res.Applied == 0 {
		res.Code = patchErrHunkConflict
		res.Message = "没有文件被应用"
	}
	res.RevertID = id
	res.BackupDir = backupDir
	return res, nil
}

func mustReadOrNil(path string) []byte {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return b
}

// ===== 撤销 =====

func revertPatchByID(root, patchID, onConflict string) (*PatchRevertResult, error) {
	res := &PatchRevertResult{}
	store := patchStoreRoot(root)
	if store == "" {
		res.Code = patchErrNoBackup
		res.Message = "找不到补丁存储目录"
		return res, nil
	}
	manifestPath := filepath.Join(store, "manifest", patchID+".json")
	b, err := os.ReadFile(manifestPath)
	if err != nil {
		res.Code = patchErrNoBackup
		res.Message = "找不到该补丁的应用记录（可能已被清理）"
		return res, nil
	}
	var m patchManifest
	if err := json.Unmarshal(b, &m); err != nil {
		res.Code = patchErrNoBackup
		res.Message = "应用记录损坏"
		return res, nil
	}
	if m.Root != "" {
		root = m.Root
	}
	releaseWS, lockErr := lockPatchWorkspace(root, 3*time.Second)
	if lockErr != nil {
		res.Code = patchErrBusy
		res.Message = "另一个窗口正在写文件，请稍后再试"
		return res, nil
	}
	defer releaseWS()

	type plan struct {
		entry patchManifestEntry
		abs   string
	}
	var plans []plan
	for _, e := range m.Files {
		abs, pe := resolvePatchRootPath(root, e.RelPath)
		if pe != nil {
			res.Code = patchErrPathDenied
			res.Message = "路径不合法：" + e.RelPath
			return res, nil
		}
		plans = append(plans, plan{entry: e, abs: abs})
	}
	// 先全部检查
	for _, p := range plans {
		if p.entry.Kind == "add" {
			// 新建的文件：撤销=删除；若用户改过则冲突
			if _, err := os.Stat(p.abs); err == nil {
				raw, rerr := os.ReadFile(p.abs)
				if rerr == nil && p.entry.ResultHash != "" && sha256Hex(raw) != p.entry.ResultHash && onConflict != "force" {
					if onConflict == "stash" {
						_ = os.WriteFile(p.abs+".revert-backup", raw, 0o644)
					} else {
						res.Code = patchErrConcurrent
						res.Message = p.entry.RelPath + " 在应用后被修改，已放弃撤销（可选择另存或强制覆盖）"
						return res, nil
					}
				}
			}
			continue
		}
		if p.entry.BackupFile == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(store, "backup", m.ID, p.entry.BackupFile)); err != nil {
			res.Code = patchErrNoBackup
			res.Message = "备份文件缺失：" + p.entry.BackupFile
			return res, nil
		}
		cur, rerr := os.ReadFile(p.abs)
		if rerr == nil && p.entry.ResultHash != "" && sha256Hex(cur) != p.entry.ResultHash && onConflict != "force" {
			if onConflict == "stash" {
				_ = os.WriteFile(p.abs+".revert-backup", cur, 0o644)
			} else {
				res.Code = patchErrConcurrent
				res.Message = p.entry.RelPath + " 在应用后被修改，已放弃撤销（可选择另存或强制覆盖）"
				return res, nil
			}
		}
	}
	// 再落盘
	sort.Slice(plans, func(i, j int) bool { return plans[i].abs < plans[j].abs })
	for _, p := range plans {
		release := lockPatchPath(p.abs)
		defer release()
	}
	for _, p := range plans {
		if p.entry.Kind == "add" {
			if err := os.Remove(p.abs); err != nil && !os.IsNotExist(err) {
				res.Code = patchErrApplyIO
				res.Message = "删除失败：" + p.entry.RelPath
				return res, nil
			}
			res.Files = append(res.Files, p.entry.RelPath)
			continue
		}
		raw, err := os.ReadFile(filepath.Join(store, "backup", m.ID, p.entry.BackupFile))
		if err != nil {
			res.Code = patchErrNoBackup
			res.Message = "备份读取失败：" + p.entry.RelPath
			return res, nil
		}
		if err := writePatchFileAtomic(p.abs, raw); err != nil {
			res.Code = patchErrApplyIO
			res.Message = "还原失败：" + p.entry.RelPath
			return res, nil
		}
		res.Files = append(res.Files, p.entry.RelPath)
	}
	_ = appendPatchIndex(store, patchIndexEntry{
		V: 1, ID: m.ID, Summary: "", FileName: "", CreatedAt: m.Created, Root: root,
		Files: res.Files, Status: "reverted", RevertedAt: time.Now().Unix(),
	})
	res.OK = true
	return res, nil
}

// ===== 命名与 id =====

func newPatchRunID(prefix string) string {
	now := time.Now()
	return fmt.Sprintf("%s%s-%04d", prefix, now.Format("20060102-150405"), now.Nanosecond()/1e5%10000)
}

func slugifyPatchSummary(summary string) string {
	s := strings.TrimSpace(summary)
	if s == "" {
		return "patch"
	}
	rs := []rune(s)
	if len(rs) > 40 {
		rs = rs[:40]
	}
	var b strings.Builder
	lastDash := false
	for _, r := range rs {
		switch {
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			if !lastDash && b.Len() > 0 {
				b.WriteRune('-')
				lastDash = true
			}
		case strings.ContainsRune(`\/:*?"<>|`, r) || r < 32:
			// 丢弃
		default:
			b.WriteRune(r)
			lastDash = false
		}
	}
	out := strings.Trim(b.String(), "-. ")
	if out == "" {
		return "patch"
	}
	base := strings.ToLower(out)
	reserved := map[string]bool{"con": true, "prn": true, "aux": true, "nul": true,
		"com1": true, "com2": true, "com3": true, "com4": true, "com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
		"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true}
	if reserved[base] {
		out += "-patch"
	}
	return out
}

func uniquePatchPath(store, slug string) string {
	ts := time.Now().Format("20060102-150405")
	base := ts + "-" + slug
	candidate := filepath.Join(store, base+".patch")
	for i := 2; i < 100; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = filepath.Join(store, fmt.Sprintf("%s-%d.patch", base, i))
	}
	return filepath.Join(store, base+"-"+newPatchRunID("")+".patch")
}

// ===== 磁盘空间 =====

func hasEnoughDisk(dir string, need uint64) bool {
	free, err := diskFreeBytes(dir)
	if err != nil {
		return true // 探测失败不阻止，交给写入时的错误
	}
	return free > need+16<<20
}

// ===== 小工具 =====
