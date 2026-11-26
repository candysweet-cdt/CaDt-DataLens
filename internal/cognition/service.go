// service.go：Read / Edit（base CAS 全卷写 + 写后 baseline 簿记）/ Status / 清理门闩。
// 所有写路径（edit、status 的 baseline 全量生成）在同一把独占租约内执行，read 不取锁；
// 锁文件在 <ws>/.cadt/cognition.lock——卷目录之外（memo.go:139 的既有约定）。
package cognition

import (
	"context"
	"crypto/sha256"
	"datalens/internal/atomfile"
	"datalens/internal/resourcelease"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// Deps 引擎钩子：不 import main、不碰 App（go-layout 约定）。
type Deps struct {
	Logf func(format string, args ...any)
	Now  func() time.Time
}

type Service struct {
	deps Deps
}

func New(deps Deps) *Service {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Logf == nil {
		deps.Logf = func(string, ...any) {}
	}
	return &Service{deps: deps}
}

type paths struct {
	dir      string
	meta     string
	code     string
	ignore   string
	state    string
	baseline string
	lock     string
}

func resolvePaths(ws string) paths {
	dir := filepath.Join(ws, filepath.FromSlash(DirName))
	return paths{
		dir:      dir,
		meta:     filepath.Join(dir, MetaName),
		code:     filepath.Join(dir, CodeName),
		ignore:   filepath.Join(dir, IgnoreName),
		state:    filepath.Join(dir, StateName),
		baseline: filepath.Join(dir, StateName, BaselineNm),
		lock:     filepath.Join(ws, filepath.FromSlash(LockName)),
	}
}

// fingerprintOf 卷指纹 = sha256(meta ‖ code ‖ ignore)。ignore 进指纹：排除表改变作用域
// 属于卷状态变化，其他窗口的 base 随之失效、逼一次重读（CAS 口径与 meta 一致）。
func fingerprintOf(metaBytes, codeBytes, ignoreBytes []byte) string {
	h := sha256.New()
	h.Write(metaBytes)
	h.Write(codeBytes)
	h.Write(ignoreBytes)
	return hex.EncodeToString(h.Sum(nil))
}

// loadIgnoreBytes 读当前排除文件（不存在 / 读失败返回 nil——指纹按「无 ignore」计）。
func loadIgnoreBytes(p paths) []byte {
	data, err := os.ReadFile(p.ignore)
	if err != nil {
		return nil
	}
	return data
}

func (s *Service) logf(format string, args ...any) { s.deps.Logf(format, args...) }

// ---------- 契约类型（JSON 收发，绑定壳只做透传） ----------

type ReadReq struct {
	Paths  []string `json:"paths,omitempty"`  // 路径前缀过滤（命中前缀下全部条目）
	Labels []string `json:"labels,omitempty"` // 标签过滤（任一命中）
	Query  string   `json:"query,omitempty"`  // 关键词（命中 F/R/A/S 值，不分大小写）
}

type ReadResult struct {
	Exists      bool       `json:"exists"`
	Hint        string     `json:"hint,omitempty"` // 未建立时的建卷指引
	Mode        string     `json:"mode"`           // overview / entries
	Text        string     `json:"text"`           // 给模型看的文本
	Fingerprint string     `json:"fingerprint,omitempty"`
	Scene       string     `json:"scene,omitempty"`
	Entries     int        `json:"entries,omitempty"`
	Bytes       int        `json:"bytes,omitempty"`
	BadLines    int        `json:"badLines,omitempty"`
	Lines       []PathLine `json:"lines,omitempty"` // overview 数据（前端注入渲染用）
	Truncated   bool       `json:"truncated,omitempty"`
	HitCount    int        `json:"hitCount,omitempty"`   // entries 模式：过滤命中总数（应用页面「命中 N 条」显示用）
	HitEntries  []EntryIn  `json:"hitEntries,omitempty"` // entries 模式：结构化命中条目（应用页面渲染 FRAS 用，与 Text 同一 rune 预算口径）
}

type EntryIn struct {
	Path   string   `json:"path"`
	Labels []string `json:"labels,omitempty"`
	Dir    bool     `json:"dir,omitempty"` // 目录条目（应用页面 chips 过滤用；与 overview PathLine.Dir 同源）
	F      string   `json:"f,omitempty"`
	R      string   `json:"r,omitempty"`
	A      string   `json:"a,omitempty"`
	S      string   `json:"s,omitempty"`
}

type EditReq struct {
	Op      string    `json:"op"` // add / update / remove
	Entries []EntryIn `json:"entries,omitempty"`
	Meta    string    `json:"meta,omitempty"`   // 整卷替换 meta.txt（逐键校验，与条目同一 CAS 写内生效）
	Ignore  string    `json:"ignore,omitempty"` // 整卷替换作用域排除文件 ignore.txt（gitignore 简化语法，校验失败整体拒绝）
	Reason  string    `json:"reason,omitempty"`
	Base    string    `json:"base,omitempty"` // 调用方会话登记的卷指纹（前端自动附加，模型不可见）
}

type EditResult struct {
	Applied     bool     `json:"applied"`
	Fingerprint string   `json:"fingerprint"` // 新指纹：登记表即 CAS 的下一轮 base
	Entries     int      `json:"entries"`
	Bytes       int      `json:"bytes"`
	Bookkept    int      `json:"bookkept"` // 簿记刷新的 baseline 记录数
	Warnings    []string `json:"warnings,omitempty"`
}

type DriftListJSON struct {
	Total   int      `json:"total"`
	Samples []string `json:"samples,omitempty"`
}

type StatusResult struct {
	Exists            bool          `json:"exists"`
	Hint              string        `json:"hint,omitempty"`
	Scene             string        `json:"scene,omitempty"`
	Entries           int           `json:"entries"`
	Bytes             int           `json:"bytes"`
	BudgetEntries     int           `json:"budgetEntries"`
	BudgetBytes       int           `json:"budgetBytes"`
	Fingerprint       string        `json:"fingerprint,omitempty"`
	HasBaseline       bool          `json:"hasBaseline"`
	BaselineGenerated bool          `json:"baselineGenerated,omitempty"` // 本次调用顺手生成的（首建末批 / 恢复）
	BadLines          int           `json:"badLines,omitempty"`
	ScanTruncated     bool          `json:"scanTruncated,omitempty"`
	Missing           DriftListJSON `json:"missing"`
	Orphan            DriftListJSON `json:"orphan"`
	Stale             DriftListJSON `json:"stale"`
	Unbaselined       DriftListJSON `json:"unbaselined"`
}

// ---------- 读 ----------

func (s *Service) Read(ws string, req ReadReq) (ReadResult, error) {
	p := resolvePaths(ws)
	codeBytes, err := os.ReadFile(p.code)
	if err != nil {
		if os.IsNotExist(err) {
			return ReadResult{Exists: false, Mode: "overview", Hint: buildHint()}, nil
		}
		return ReadResult{}, err
	}
	metaBytes, _ := os.ReadFile(p.meta)
	entries, bad := ParseCodeVolume(string(codeBytes))
	meta, _ := ParseMeta(string(metaBytes)) // meta 坏行不阻断读卷
	res := ReadResult{
		Exists:      true,
		Fingerprint: fingerprintOf(metaBytes, codeBytes, loadIgnoreBytes(p)),
		Scene:       meta.Scene,
		Entries:     len(entries),
		Bytes:       len(codeBytes),
		BadLines:    bad,
	}
	filtered, filterOn := filterEntries(entries, req)
	if !filterOn {
		res.Mode = "overview"
		res.Lines = overviewLines(entries)
		res.Text, res.Truncated = renderOverviewText(res.Scene, len(entries), res.Bytes, res.Lines, res.BadLines)
		return res, nil
	}
	res.Mode = "entries"
	res.HitCount = len(filtered)
	res.HitEntries = limitEntriesForUI(filtered)
	text, truncated := renderEntriesText(filtered, req.Query)
	res.Text, res.Truncated = text, truncated
	return res, nil
}

// limitEntriesForUI 应用页面用的结构化命中条目：与 renderEntriesText 同一 rune 预算口径
// （ReadRuneLimit，按 FormatEntry 渲染长度计），超出部分截断——HitCount 仍报过滤命中总数，
// 前端以 len(HitEntries) < HitCount 判「展示被收窄」。
func limitEntriesForUI(entries []Entry) []EntryIn {
	out := make([]EntryIn, 0, len(entries))
	used := 0
	for _, e := range entries {
		used += utf8.RuneCountInString(FormatEntry(e))
		if used > ReadRuneLimit {
			break
		}
		out = append(out, EntryIn{Path: e.Path, Labels: e.Labels, Dir: e.Dir(), F: e.F, R: e.R, A: e.A, S: e.S})
	}
	return out
}

func overviewLines(entries []Entry) []PathLine {
	lines := make([]PathLine, 0, len(entries))
	for _, e := range entries {
		lines = append(lines, PathLine{Path: e.Path, Labels: e.Labels, Dir: e.Dir()})
	}
	return lines
}

func filterEntries(entries []Entry, req ReadReq) ([]Entry, bool) {
	var prefixes []string
	for _, p := range req.Paths {
		if key := PathKey(p); key != "" {
			prefixes = append(prefixes, key)
		}
	}
	var labels []string
	for _, l := range req.Labels {
		if l = strings.TrimSpace(l); l != "" {
			labels = append(labels, strings.ToLower(l))
		}
	}
	query := strings.ToLower(strings.TrimSpace(req.Query))
	if len(prefixes) == 0 && len(labels) == 0 && query == "" {
		return nil, false
	}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if len(prefixes) > 0 {
			key := PathKey(e.Path)
			hit := false
			for _, pre := range prefixes {
				if strings.HasPrefix(key, pre) {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
		}
		if len(labels) > 0 {
			hit := false
			for _, tag := range e.Labels {
				tag = strings.ToLower(tag)
				for _, want := range labels {
					if tag == want {
						hit = true
						break
					}
				}
			}
			if !hit {
				continue
			}
		}
		if query != "" {
			if !strings.Contains(strings.ToLower(e.F), query) &&
				!strings.Contains(strings.ToLower(e.R), query) &&
				!strings.Contains(strings.ToLower(e.A), query) &&
				!strings.Contains(strings.ToLower(e.S), query) {
				continue
			}
		}
		out = append(out, e)
	}
	return out, true
}

// renderEntriesText 过滤命中的条目全文，rune 口径封顶 ReadRuneLimit（§3.2：压在 slim 落盘阈值之下）。
func renderEntriesText(entries []Entry, query string) (string, bool) {
	var b strings.Builder
	used := 0
	truncated := false
	for _, e := range entries {
		line := FormatEntry(e)
		l := utf8.RuneCountInString(line)
		if used+l > ReadRuneLimit {
			truncated = true
			break
		}
		b.WriteString(line)
		b.WriteByte('\n')
		used += l
	}
	head := fmt.Sprintf("命中 %d 条", len(entries))
	if query != "" {
		head += fmt.Sprintf("（关键词 %q）", query)
	}
	if truncated {
		head += fmt.Sprintf("，响应超 %d 字符已截断：请收窄 paths / labels / query 再取", ReadRuneLimit)
	} else {
		head += "："
	}
	return head + "\n" + strings.TrimRight(b.String(), "\n"), truncated
}

func renderOverviewText(scene string, count, bytes int, lines []PathLine, bad int) (string, bool) {
	header := fmt.Sprintf("认知索引 overview：%d 条 / %d 字节（预算 %d / %d）", count, bytes, EntryBudget, ByteBudget)
	if scene != "" {
		header += "，scene=" + scene
	}
	if bad > 0 {
		header += fmt.Sprintf("，%d 条坏行被跳过", bad)
	}
	header += "。这是路径地图（无正文）；要看某条的 FRAS 全文用 paths / labels / query 过滤。"
	var b strings.Builder
	b.WriteString(header)
	b.WriteByte('\n')
	// overview 与过滤读同一封顶（rune 口径）：大卷无参 read 不封顶会被 artifact 指针化（§3.2）
	used := utf8.RuneCountInString(header) + 1
	truncated := false
	for _, l := range lines {
		// 目录条目 Path 本就带尾 /：只缺尾 / 才补 marker，避免 "src/utils//" 双斜杠
		// （模型复制该行去过滤时双斜杠会让前缀匹配落空）
		marker := ""
		if l.Dir && !strings.HasSuffix(l.Path, "/") {
			marker = "/"
		}
		var line string
		if len(l.Labels) > 0 {
			line = l.Path + marker + " [" + strings.Join(l.Labels, " ") + "]"
		} else {
			line = l.Path + marker
		}
		n := utf8.RuneCountInString(line) + 1
		if used+n > ReadRuneLimit {
			truncated = true
			break
		}
		b.WriteString(line)
		b.WriteByte('\n')
		used += n
	}
	if truncated {
		b.WriteString(fmt.Sprintf("…（地图超 %d 字符已截断：请用 paths / labels / query 收窄过滤）", ReadRuneLimit))
	}
	return strings.TrimRight(b.String(), "\n"), truncated
}

func buildHint() string {
	return "认知索引未建立。它给 AI 提供跨会话的「这个文件是什么 / 改它要动谁 / 有什么暗约束」语义层，" +
		"适合反复进行编码会话的代码工作区；纯数据目录不建议建。建立方式：按目录分批——一批只读该目录直接成员、" +
		"读完立即 cognition_edit（op=add + 首批带 meta）写该批条目，末批完成后跑 cognition_status 收 baseline。" +
		"启用开关在 设置 → AI → 上下文与记忆 的「认知索引」。"
}

// ---------- 写 ----------

const (
	maxFieldLen = 2000
	maxLabelCnt = 8
	maxLabelLen = 40
)

// Edit 是 EditWithContext 的兼容入口（无 ctx → 归属窗口名空串，单桶语义，行为与旧 refcount 一致）。
func (s *Service) Edit(ws string, req EditReq) (EditResult, error) {
	return s.EditWithContext(context.Background(), ws, req)
}

// EditWithContext 增删改条目 / 整卷替换元卷 / 维护作用域排除文件。
// ctx 只用于取归属窗口名（v3 同进程多窗口：同窗口重入、跨窗口 Busy，见 lease.go）。
func (s *Service) EditWithContext(ctx context.Context, ws string, req EditReq) (EditResult, error) {
	p := resolvePaths(ws)
	if req.Op != "add" && req.Op != "update" && req.Op != "remove" {
		return EditResult{}, fmt.Errorf("op 只认 add / update / remove，收到 %q", req.Op)
	}
	if len(req.Entries) == 0 && req.Meta == "" && req.Ignore == "" {
		return EditResult{}, fmt.Errorf("entries / meta / ignore 至少给一样")
	}
	if len(req.Entries) > MaxEntriesPerCall {
		return EditResult{}, fmt.Errorf("单次 edit 最多 %d 条（按目录分批：一批一写，§7 P1-4）", MaxEntriesPerCall)
	}
	lease, err := s.acquireLease(ctx, p, "cognition-edit")
	if err != nil {
		return EditResult{}, leaseBusy(err)
	}
	defer lease.Release()

	codeBytes, codeErr := os.ReadFile(p.code)
	hasCode := codeErr == nil
	if codeErr != nil && !os.IsNotExist(codeErr) {
		return EditResult{}, codeErr
	}
	metaBytes, _ := os.ReadFile(p.meta)
	ignoreBytes := loadIgnoreBytes(p)
	entries, badCurrent := ParseCodeVolume(string(codeBytes))

	// CAS：卷存在时必须带调用方读到的指纹（前端自动附加 base）；首建（卷不存在）免检。
	current := fingerprintOf(metaBytes, codeBytes, ignoreBytes)
	if hasCode {
		if req.Base == "" {
			return EditResult{}, ErrBaseMissing
		}
		if req.Base != current {
			return EditResult{}, fmt.Errorf("%w（当前 %s…）", ErrCASConflict, current[:12])
		}
	}

	// meta / ignore 先校验（与条目同一 CAS 写内原子生效）：非法则整体拒绝，不动盘。
	if req.Meta != "" {
		if _, err := ParseMeta(req.Meta); err != nil {
			return EditResult{}, fmt.Errorf("meta 校验失败：%w", err)
		}
	}
	var ignoreOut string
	if req.Ignore != "" {
		out, err := ParseIgnoreText(req.Ignore)
		if err != nil {
			return EditResult{}, fmt.Errorf("ignore 校验失败：%w", err)
		}
		ignoreOut = out
	}

	byKey := make(map[string]int, len(entries))
	for i, e := range entries {
		byKey[PathKey(e.Path)] = i
	}
	normalized, err := normalizeBatch(req.Entries)
	if err != nil {
		return EditResult{}, err
	}
	// op 是每调用一个：add 逐条追加（byKey 同步长）；update 不改长度、索引稳定；
	// remove 必须两阶段——先整批校验再一次性过滤重建，边删边移会让 byKey 索引失效，
	// 同批升序多条 remove 会删错条目（2026-11-22 审查 P0，探针实证）。
	switch req.Op {
	case "add":
		for _, e := range normalized {
			key := PathKey(e.Path)
			if _, exists := byKey[key]; exists {
				return EditResult{}, fmt.Errorf("op=add 但 %s 已有条目（改条目用 op=update，先 read 核对）", e.Path)
			}
			byKey[key] = len(entries)
			entries = append(entries, e)
		}
	case "update":
		for _, e := range normalized {
			idx, exists := byKey[PathKey(e.Path)]
			if !exists {
				return EditResult{}, fmt.Errorf("op=update 但 %s 不在卷里（先 cognition_read 核对）", e.Path)
			}
			kept := entries[idx]
			kept.Labels, kept.F, kept.R, kept.A, kept.S = e.Labels, e.F, e.R, e.A, e.S
			entries[idx] = kept
		}
	case "remove":
		drop := make(map[string]bool, len(normalized))
		for _, e := range normalized {
			key := PathKey(e.Path)
			if _, exists := byKey[key]; !exists {
				return EditResult{}, fmt.Errorf("op=remove 但 %s 不在卷里", e.Path)
			}
			drop[key] = true
		}
		kept := make([]Entry, 0, len(entries))
		for _, e := range entries {
			if !drop[PathKey(e.Path)] {
				kept = append(kept, e)
			}
		}
		entries = kept
	}

	nextCode := FormatCodeVolume(entries)
	if len(entries) > EntryBudget {
		return EditResult{}, fmt.Errorf("条目数 %d 超预算 %d：先合并目录条目 / 降级次要文件（meta rule5）", len(entries), EntryBudget)
	}
	if len(nextCode) > ByteBudget {
		return EditResult{}, fmt.Errorf("卷字节 %d 超预算 %d：先合并目录条目 / 降级次要文件（meta rule5）", len(nextCode), ByteBudget)
	}

	if err := os.MkdirAll(p.dir, 0o755); err != nil {
		return EditResult{}, err
	}
	// 先写主卷 code 再写 meta：meta 写失败留下「新 code + 旧 meta」——指纹按两文件拼接计算，
	// 下次 edit 的 base 比对必然冲突、逼一次重读（自愈）；反过来（新 meta + 旧 code）还会让
	// 「meta 存在而 code 缺失」的怪态被 hasCode 判定误判成首建、跳过 CAS。
	if err := atomfile.WriteFileAtomic(p.code, nextCode); err != nil {
		return EditResult{}, err
	}
	if req.Meta != "" {
		metaOut := req.Meta
		if !strings.HasSuffix(metaOut, "\n") {
			metaOut += "\n"
		}
		if err := atomfile.WriteFileAtomic(p.meta, []byte(metaOut)); err != nil {
			return EditResult{}, fmt.Errorf("条目卷已更新但 meta 写入失败：%w", err)
		}
		metaBytes = []byte(metaOut)
	}
	// ignore 最后写：半写态最坏情形是「排除表丢失」——下次扫描恢复全量清单、Missing 重现，
	// 无破坏性（code/meta 的半写态防线见上）；指纹按三段（meta‖code‖ignore）计算。
	if req.Ignore != "" {
		if err := atomfile.WriteFileAtomic(p.ignore, []byte(ignoreOut)); err != nil {
			return EditResult{}, fmt.Errorf("条目卷已更新但 ignore 写入失败：%w", err)
		}
		ignoreBytes = []byte(ignoreOut)
	}
	nextFP := fingerprintOf(metaBytes, nextCode, ignoreBytes)

	// 写后簿记（§4.1）：本批条目涉及的现存文件刷新 baseline 记录——没有这一步，
	// AI 改完文件再更新条目后会永报 Stale、新条目永报 Unbaselined（治理闭环合不上）。
	bookkept, warnings := s.bookkeep(p, ws, entries, normalized, nextFP)
	// 手写卷的坏行在全卷重排时会被解析丢弃：必须上报（§3.1 人工编辑是明文支持的媒介）
	if badCurrent > 0 {
		warnings = append(warnings, fmt.Sprintf("原卷有 %d 条坏行无法解析，重排时已被丢弃（用户手写内容，请知悉）", badCurrent))
	}

	res := EditResult{
		Applied:     true,
		Fingerprint: nextFP,
		Entries:     len(entries),
		Bytes:       len(nextCode),
		Bookkept:    bookkept,
		Warnings:    warnings,
	}
	s.logf("cognition edit op=%s entries=%d bytes=%d bookkept=%d", req.Op, len(entries), len(nextCode), bookkept)
	return res, nil
}

// normalizeBatch 入参条目整形与校验：路径归一（反斜杠转正斜杠）、合法性、字段/标签长度上限。
func normalizeBatch(in []EntryIn) ([]Entry, error) {
	out := make([]Entry, 0, len(in))
	for _, e := range in {
		path := NormalizeRelPath(e.Path)
		if err := ValidateEntryPath(path); err != nil {
			return nil, fmt.Errorf("条目 %q：%w", e.Path, err)
		}
		entry := Entry{Path: path, F: clampField(e.F), R: clampField(e.R), A: clampField(e.A), S: clampField(e.S)}
		if len(e.Labels) > maxLabelCnt {
			return nil, fmt.Errorf("条目 %q：标签最多 %d 个", path, maxLabelCnt)
		}
		for _, tag := range e.Labels {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			if len(tag) > maxLabelLen {
				return nil, fmt.Errorf("条目 %q：标签 %q 超长（≤%d 字符）", path, tag, maxLabelLen)
			}
			entry.Labels = append(entry.Labels, tag)
		}
		out = append(out, entry)
	}
	return out, nil
}

func clampField(v string) string {
	v = strings.TrimSpace(v)
	// 按 rune 截断（按字节会劈开多字节 UTF-8）
	if utf8.RuneCountInString(v) > maxFieldLen {
		v = string([]rune(v)[:maxFieldLen])
	}
	return v
}

// bookkeep 编辑后刷新 baseline：现存文件条目更新 mtime/size 记录并前移卷指纹；
// 失败只记警告不回滚（卷已落盘，drift 会在下轮 status 里如实报出）。
func (s *Service) bookkeep(p paths, ws string, entries, touched []Entry, fp string) (int, []string) {
	var warnings []string
	now := s.deps.Now().UnixMilli()
	base, ok, err := LoadBaseline(p.baseline)
	if err != nil {
		base, ok = nil, false
	}
	if !ok {
		// baseline 缺失 / 损坏：全量构建后再叠加本批刷新——只写半量基线会让
		// 其余条目永卡 Unbaselined（status 的重建窗口只看「文件缺失」，审查 P2）
		files, _, scanErr := ScanWorkspace(ws)
		if scanErr != nil {
			base = &Baseline{Files: map[string]BaselineFile{}}
		} else {
			base = BuildBaseline(entries, files, fp, now)
			ok = true
		}
	}
	if base == nil {
		base = &Baseline{Files: map[string]BaselineFile{}}
	}
	base.Fingerprint = fp
	count := 0
	if ok {
		// 有全量基线时只 stat 本批路径（重复路径 stat 两次无害，同值覆盖）；
		// 没有全量基线（扫描失败）则保持空表——下轮 status 的恢复路径或后续 edit
		// 会补齐，Unbaselined 如实暴露
		for _, e := range touched {
			if e.Dir() {
				continue // 目录条目豁免 Stale，不进 baseline
			}
			info, err := os.Stat(filepath.Join(ws, filepath.FromSlash(e.Path)))
			if err != nil {
				continue // 文件不存在：留给 drift 报 Orphan，不写记录
			}
			base.Files[PathKey(e.Path)] = BaselineFile{Mtime: info.ModTime().UnixMilli(), Size: info.Size(), At: now}
			count++
		}
	}
	if err := os.MkdirAll(p.state, 0o755); err != nil {
		return count, append(warnings, "baseline 目录创建失败："+err.Error())
	}
	if err := SaveBaseline(p.baseline, base); err != nil {
		return count, append(warnings, "baseline 簿记写入失败："+err.Error())
	}
	return count, warnings
}

func leaseBusy(err error) error {
	if resourcelease.IsBusy(err) {
		owner := resourcelease.BusyOwner(err)
		msg := "认知索引正被另一个窗口持有（Busy）"
		if owner.PID > 0 {
			msg = fmt.Sprintf("%s：PID %d", msg, owner.PID)
		}
		// 同进程多窗口时 PID 相同，只有 label 里的窗口名能说明是谁在写。
		if label := strings.TrimSpace(owner.Label); label != "" {
			msg = fmt.Sprintf("%s（%s）", msg, label)
		}
		return fmt.Errorf("%s；稍后重试或等另一窗口完成维护", msg)
	}
	return err
}

// ---------- Status ----------

// Status 是 StatusWithContext 的兼容入口（无 ctx → 单桶语义）。
func (s *Service) Status(ws string, verbose bool) (StatusResult, error) {
	return s.StatusWithContext(context.Background(), ws, verbose)
}

// StatusWithContext 治理报告；baseline 缺失时的兜底全量生成在同一把独占租约内
// （ctx 只用于取归属窗口名，见 lease.go）。
func (s *Service) StatusWithContext(ctx context.Context, ws string, verbose bool) (StatusResult, error) {
	p := resolvePaths(ws)
	codeBytes, err := os.ReadFile(p.code)
	if err != nil {
		if os.IsNotExist(err) {
			return StatusResult{Exists: false, Hint: buildHint()}, nil
		}
		return StatusResult{}, err
	}
	metaBytes, _ := os.ReadFile(p.meta)
	entries, bad := ParseCodeVolume(string(codeBytes))
	meta, _ := ParseMeta(string(metaBytes))
	res := StatusResult{
		Exists:        true,
		Scene:         meta.Scene,
		Entries:       len(entries),
		Bytes:         len(codeBytes),
		BudgetEntries: EntryBudget,
		BudgetBytes:   ByteBudget,
		Fingerprint:   fingerprintOf(metaBytes, codeBytes, loadIgnoreBytes(p)),
		BadLines:      bad,
	}
	base, hasBase, err := LoadBaseline(p.baseline)
	if err != nil {
		base, hasBase = nil, false
	}
	// 唯一副作用：baseline 缺失（首建末批 / .state 被清后的恢复）时全量生成——
	// 正常维护的簿记在 edit 侧（§4.1），这里只是兜底；写路径在同一把独占租约内。
	if !hasBase {
		lease, lerr := s.acquireLease(ctx, p, "cognition-baseline")
		if lerr != nil {
			return res, leaseBusy(lerr)
		}
		files, _, serr := ScanWorkspace(ws)
		if serr == nil {
			base = BuildBaseline(entries, files, res.Fingerprint, s.deps.Now().UnixMilli())
			if err := os.MkdirAll(p.state, 0o755); err == nil {
				if err := SaveBaseline(p.baseline, base); err == nil {
					res.BaselineGenerated = true
					hasBase = true
				}
			}
		}
		lease.Release()
	}
	res.HasBaseline = hasBase
	files, truncated, err := ScanWorkspace(ws)
	if err != nil {
		return res, err
	}
	res.ScanTruncated = truncated
	drift := ComputeDrift(entries, files, base)
	res.Missing = driftListJSON(drift.Missing, verbose)
	res.Orphan = driftListJSON(drift.Orphan, verbose)
	res.Stale = driftListJSON(drift.Stale, verbose)
	res.Unbaselined = driftListJSON(drift.Unbaselined, verbose)
	// 数据驱动的现场提示：Missing 达到阈值且还没有作用域排除文件时，在模型正盯着 Missing 看的
	// 时刻给出出口（2026-11-22 用户反馈「如何提示 AI 可以创建」）——写通道就是 cognition_edit
	// 的 ignore 参数（落点由 Go 定，模型不用猜路径）。小工作区 Missing 少，逐个建档就完了，
	// 不催；排除文件已存在说明作用域已收窄，不再重复提示。
	if drift.Missing.Total >= cogIgnoreHintMissing {
		if _, serr := os.Stat(p.ignore); os.IsNotExist(serr) {
			res.Hint = fmt.Sprintf("Missing 共 %d 条且还没有作用域排除文件。若其中大量是生成物 / 构建产物 / 数据文件（按样例判断），可在下一次 cognition_edit 里带 ignore 参数创建排除文件"+
				"（整卷替换，与 meta 同款语义，落 .cadt/cognition/ignore.txt，用户也可手工编辑）：gitignore 简化语法，一行一条（# 注释、! 取反重新包含、"+
				"不含 / 按文件名匹配任意层级、含 / 按相对根路径匹配，如 dist/ 或 *.min.js）；被排除文件不再报 Missing，其已有条目应删除。", drift.Missing.Total)
		}
	}
	return res, nil
}

func driftListJSON(l DriftList, verbose bool) DriftListJSON {
	out := DriftListJSON{Total: l.Total}
	if verbose {
		out.Samples = l.Samples
	}
	return out
}

// LockForClear 供存储清理门闩取独占写权（对齐 memo.LockForClear：持有时清理被拒而非删一半）。
// 用 AcquireNoShare：本进程另一窗口正 edit（refcount 共享）也算忙——清理不能借 refcount 溜进去。
func (s *Service) LockForClear(ws string) (func(), error) {
	return LockForClear(ws)
}

// LockForClear 是上一个方法的函数形式：锁是文件级的、不依赖引擎状态，
// 所以根目录的 storage 门闩（包级变量构造期）不必为此持有引擎实例。
func LockForClear(ws string) (func(), error) {
	p := resolvePaths(ws)
	lease, err := resourcelease.AcquireNoShare(p.lock, resourcelease.Owner{PID: os.Getpid(), Label: "cognition-clear"})
	if err != nil {
		return nil, leaseBusy(err)
	}
	return lease.Release, nil
}
