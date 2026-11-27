// vacuum.go：会话正文的「数据整形」（docs/unfinished-plans/session-compaction-disk-growth.md §5.1 S1）。
//
// 把重放后处于归档态的消息搬进 sidecar（archive.v1.jsonl，append-only，永不整读重写），
// 主文件原子重写为 header + meta + summary + live 的物化视图——live 段被前端
// auto-compact 的 token 阈值结构性约束，重写后主文件回到「结构性小于任何上限」的形状。
//
// 重放语义的逐事件同构基准是前端 replaySessionLog（ai-session-store.js:249-357），
// 包括三条「特性级」行为：v 缺失视为 0（NaN>1 恒 false）、a 按 JS 真值判断、
// truncate/archive 的 keep clamp 到当前 live 长度；dedupeKey 折叠必须在全部事件
// 重放完成后、只对 live、留每 key 最后一条。fixture 双侧测试（vacuum_parity_test.go
// ↔ frontend/test/ai/ai-session-vacuum-parity.test.mjs）钉死语义防漂移。
//
// 原子性与幂等（§5.3 要点 4）：sidecar 追加成功后才替换主文件；两步之间由
// archive.v1.jsonl.state 清单做崩溃恢复（进锁后按 mainSize+mtime 判定走到哪一步）。
// 归档事件的 m 用 json.RawMessage 保字节原文，防 number 精度丢失。
package sessionstore

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/atomfile"
)

const (
	aiSessionArchiveName = "archive.v1.jsonl"
	// vacuum 两步写（sidecar 追加 → 主文件替换）的崩溃恢复清单；两步都完成后删除。
	aiSessionVacuumState = "archive.v1.jsonl.state"
	aiSessionVacuumTmp   = ".vacuum.tmp" // 主文件临时流的后缀标记
)

// VacuumResult 是一次整理的统计。sidecarLines 是整理后 sidecar 的总行数
// （含此前已追加的），前端用它维护「侧车归档总数」。
type VacuumResult struct {
	Skipped              bool  `json:"skipped"`          // 未执行任何写入（阈值内 / 无可整理项 / 第二窗口竞态 no-op）
	Changed              bool  `json:"changed"`          // 实际重写了主文件
	MovedArchived        int   `json:"movedArchived"`    // 本次移入 sidecar 的归档消息数
	LiveKept             int   `json:"liveKept"`         // 重写后主文件保留的 live 消息数
	DroppedTransient     int   `json:"droppedTransient"` // dedupeKey 折叠丢弃的重复注入数
	Issues               int   `json:"issues"`           // 坏行 / 未知事件数（与前端 issues 同口径）
	Torn                 bool  `json:"torn"`             // 未提交尾行被丢弃
	BeforeBytes          int64 `json:"beforeBytes"`
	AfterBytes           int64 `json:"afterBytes"`
	SidecarLines         int   `json:"sidecarLines"`
	SidecarAppendedLines int   `json:"sidecarAppendedLines"`
	LiveDominant         bool  `json:"liveDominant"` // 整理后主文件仍超上限 = live 段自身过大（真空角落）
}

// vacuumState 是崩溃恢复清单：记录两步写之前后的主文件基准态（内容哈希判定，
// size+mtime 在「崩溃后被后续写路径追加」时会误判，见 recoverVacuumState）。
type vacuumState struct {
	V            int    `json:"v"`
	MainSize     int64  `json:"mainSize"`
	PreMainHash  string `json:"preMainHash"`  // 登记时主文件的 sha256（Replace 未发生 → 截回）
	PostMainHash string `json:"postMainHash"` // 新主文件的 sha256（Replace 已发生 → 追加有效）
	SidecarSize  int64  `json:"sidecarSize"`
	StartedAt    int64  `json:"startedAt"`
}

// vacuumEntry 是重放后的消息条目（pass 1 只记行号与 mid，正文行在 pass 2 按行号流式抄写）。
type vacuumEntry struct {
	lineNo    int
	mid       string
	dedupeKey string
}

// vacuumPlan 是第一遍流式重放的产物：主文件新形状的全部材料。
// meta/header 行很小直接缓冲；归档条目只记行号（正文在第二遍重解析）。
type vacuumPlan struct {
	headerLine  []byte   // 最后一条 header 的原始行（最后一头为准，与前端重放一致）
	metaLines   [][]byte // 按序保留的 meta 事件原始行
	// extLines：审计事件（turn / tool / approval / agent，前端 S5）的原始行，按序保留。
	// 它们不参与消息物化（既不是 live 也不是 archived），但**必须原样留在主文件**——
	// 旧实现把未知类型计 issue 后整条丢掉，等于整理一次就把审计记录抹平。
	extLines [][]byte
	live        []vacuumEntry
	archived    []vacuumEntry // 重放序（= 时间序）：先 a:1 直归档、后 archive 标记移入
	summaryJSON []byte        // 最终 summary 的原始 JSON（nil = 无）
	issues      int
	dropped     int
	markers     int // truncate / archive / reset 标记数（物化后不再保留）
	headerCount int
	torn        bool
	// sawReset：重放见过 reset。物化会把它从主文件抹掉，而拼接重放（索引侧 sidecar
	// 在前）从此看不到这次清档——必须在替换主文件时连带清空 sidecar（其全部内容
	// 时间序都先于 reset，按重放语义 reset 已把它们清出 archived）。
	sawReset bool
	// sawFutureSchema：见到 v 高于已知 schema 的事件。前端重放按 issue 丢弃，物化会把它
	// 物理删掉——未来 schema 升级而 Go 未同步时这就是静默破坏，直接拒绝整理（引信）。
	sawFutureSchema bool
}

// Vacuum 对单个会话执行整理。force=false 时正文 ≤ 读取上限直接跳过（自动整理
// 语义：只有超限才动手，双窗口同时打开同一超限会话时第二方为 no-op）；
// force=true 无条件整理（右键「瘦身归档」/ 重写前的归档出栈）。
func (s *Store) Vacuum(id string, force bool) (VacuumResult, error) {
	result := VacuumResult{}
	err := s.withSessionLock(id, "", false, func(dir string) error {
		return s.applyVacuum(dir, id, force, s.bodyReadLimit(), &result)
	})
	return result, err
}

func (s *Store) applyVacuum(dir, id string, force bool, threshold int64, result *VacuumResult) error {
	mainPath := filepath.Join(dir, aiSessionLogName)
	sidecarPath := filepath.Join(dir, aiSessionArchiveName)
	statePath := filepath.Join(dir, aiSessionVacuumState)

	info, err := os.Stat(mainPath)
	if err != nil {
		if os.IsNotExist(err) {
			// 正文不存在：没有可整理的东西（与 Read 返回空串同语义）。
			result.Skipped = true
			return nil
		}
		return err
	}
	// 崩溃恢复 + 清理上轮遗留的临时流：上一轮可能死在两步写之间。
	if err := recoverVacuumState(statePath, sidecarPath, mainPath); err != nil {
		return err
	}
	result.BeforeBytes = info.Size()
	if !force && info.Size() <= threshold {
		result.Skipped = true
		result.AfterBytes = info.Size()
		result.SidecarLines = countSidecarLines(sidecarPath)
		return nil
	}

	plan, err := buildVacuumPlan(mainPath)
	if err != nil {
		return err
	}
	result.Issues = plan.issues
	result.Torn = plan.torn
	result.DroppedTransient = plan.dropped
	result.LiveKept = len(plan.live)
	result.MovedArchived = len(plan.archived)
	// 引信：正文含高于已知 schema 的事件（未来版本 / 外来日志）。物化会把它从主文件
	// 物理删掉（前端重放也按 issue 丢弃，但今天丢弃的是确定无损的，明天 schema 升级后
	// Go 未同步就会变成静默破坏）——直接拒绝整理，宁可让用户看到明确报错。
	if plan.sawFutureSchema {
		return fmt.Errorf("会话正文含更新版本（v>%d）的事件，拒绝整理以防误删；请升级应用后再试", AI_SESSION_SCHEMA_V)
	}

	// 没有可整理项（已物化、无坏行、无撕裂尾）：不写盘。
	changed := len(plan.archived) > 0 || plan.markers > 0 || plan.dropped > 0 ||
		plan.issues > 0 || plan.torn || plan.headerCount > 1
	if !changed {
		result.Skipped = true
		result.AfterBytes = info.Size()
		result.SidecarLines = countSidecarLines(sidecarPath)
		result.LiveDominant = info.Size() > threshold
		return nil
	}

	// 先写主文件临时流（纯临时文件，崩溃只留垃圾，恢复时清掉）。
	tmpMain, err := s.writeVacuumedMain(mainPath, plan)
	if err != nil {
		return err
	}

	archiveLines := make([][]byte, 0, len(plan.archived))
	if len(plan.archived) > 0 {
		archiveLines, err = collectArchiveLines(mainPath, plan)
		if err != nil {
			_ = os.Remove(tmpMain)
			return err
		}
	}

	if plan.sawReset {
		// 物化会把 reset 从主文件抹掉，拼接重放（sidecar 在前）从此看不到这次清档；
		// sidecar 现存内容时间序全部先于 reset，按重放语义 reset 已把它们清出 archived。
		// 先删 sidecar 再替换主文件：两步各自原子，任一崩溃点都不丢数据（sidecar 删了
		// 而主文件未替换时，被删归档的原文仍以 live/归档态躺在主文件里，重放可复原）。
		if err := os.Remove(sidecarPath); err != nil && !os.IsNotExist(err) {
			_ = os.Remove(tmpMain)
			return err
		}
		result.SidecarLines = 0
	}

	if len(archiveLines) > 0 {
		// 两步写：先登记清单（崩溃恢复的依据），再追加 sidecar，最后替换主文件。
		sidecarSize := int64(0)
		if sInfo, statErr := os.Stat(sidecarPath); statErr == nil {
			sidecarSize = sInfo.Size()
		}
		preHash, err := sha256HexFile(mainPath)
		if err != nil {
			_ = os.Remove(tmpMain)
			return err
		}
		postHash, err := sha256HexFile(tmpMain)
		if err != nil {
			_ = os.Remove(tmpMain)
			return err
		}
		state := vacuumState{
			V:            1,
			MainSize:     info.Size(),
			PreMainHash:  preHash,
			PostMainHash: postHash,
			SidecarSize:  sidecarSize,
			StartedAt:    time.Now().UnixMilli(),
		}
		raw, err := json.Marshal(state)
		if err != nil {
			_ = os.Remove(tmpMain)
			return err
		}
		if err := atomfile.WriteFileAtomic(statePath, raw); err != nil {
			_ = os.Remove(tmpMain)
			return err
		}
		appended, err := appendSidecarBatch(sidecarPath, archiveLines)
		if err != nil {
			_ = os.Remove(tmpMain)
			_ = os.Remove(statePath)
			return err
		}
		if appended {
			result.SidecarAppendedLines = len(archiveLines)
		}
	}

	if err := atomfile.Replace(tmpMain, mainPath); err != nil {
		_ = os.Remove(tmpMain)
		// sidecar 可能已追加：清单留在原地，下次 Vacuum 进锁先恢复。
		return err
	}
	// 主文件已替换：清单使命完成（无论此前是否写入）。
	_ = os.Remove(statePath)
	_ = os.Remove(tmpMain)

	result.Changed = true
	after, err := os.Stat(mainPath)
	if err != nil {
		return err
	}
	result.AfterBytes = after.Size()
	if !plan.sawReset || result.SidecarLines != 0 {
		result.SidecarLines = countSidecarLines(sidecarPath)
	}
	result.LiveDominant = result.AfterBytes > threshold
	return nil
}

// recoverVacuumState 按 archive.v1.jsonl.state 判定上一轮 vacuum 死在哪一步。
// 判定基于主文件内容哈希（size+mtime 在「崩溃后被后续写路径追加」时会误判）：
//   - 主文件 == PreMainHash（与登记时逐字节一致）→ Replace 未发生，sidecar 尾巴是
//     残留/半行 → 截回 SidecarSize（被删归档的原文仍在主文件里，重放可复原，无损）；
//   - 主文件 == PostMainHash → Replace 已发生且未被再动过 → 追加有效，保留；
//   - 两者都不匹配（崩溃后主文件被追加/重写过的模糊窗口）→ **绝不盲截**——截错会把
//     「仅存于 sidecar」的归档物理丢掉。只做一件安全的事：sidecar 尾部缺换行
//     （appendSidecar 没写完 → Replace 必未发生 → 被删归档原文仍在主文件）时截回，
//     其余保留（最坏留下重复行，由 appendSidecarBatch 的幂等比对兜住）。
//
// 清单损坏（atomfile 原子写使其几乎不可能）无法判定截回点，同样只删清单不动 sidecar。
// 只在 Vacuum 的会话锁内调用；ReadArchive 不做恢复（避免无锁截断与在途追加竞态）。
func recoverVacuumState(statePath, sidecarPath, mainPath string) error {
	raw, err := os.ReadFile(statePath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		raw = nil
	}
	if raw == nil {
		removeVacuumTmp(filepath.Dir(statePath))
		return nil
	}
	defer func() { _ = os.Remove(statePath) }()
	var state vacuumState
	if json.Unmarshal(raw, &state) != nil || state.V != 1 {
		return nil
	}
	_, statErr := os.Stat(mainPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return nil // 主文件没了（被删除/迁移）：清单随之清理即可
		}
		return statErr
	}
	hashNow, err := sha256HexFile(mainPath)
	if err != nil {
		return err
	}
	switch {
	case state.PreMainHash != "" && hashNow == state.PreMainHash:
		return truncateSidecar(sidecarPath, state.SidecarSize)
	case state.PostMainHash != "" && hashNow == state.PostMainHash:
		return nil
	default:
		if missingTrailingNewline(sidecarPath) {
			return truncateSidecar(sidecarPath, state.SidecarSize)
		}
		return nil
	}
}

// truncateSidecar 截回 sidecar 到基准长度；文件不存在时无事可做。
func truncateSidecar(sidecarPath string, size int64) error {
	if size < 0 {
		size = 0
	}
	err := os.Truncate(sidecarPath, size)
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

// missingTrailingNewline 判断 sidecar 尾部是否缺换行（半行 = appendSidecar 未写完）。
// 文件不存在视为完整（无事可做）。
func missingTrailingNewline(sidecarPath string) bool {
	f, err := os.Open(sidecarPath)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() == 0 {
		return false
	}
	buf := make([]byte, 1)
	if _, err := f.ReadAt(buf, info.Size()-1); err != nil {
		return false
	}
	return buf[0] != '\n'
}

// sha256HexFile 流式计算文件 sha256（hex）。
func sha256HexFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// removeVacuumTmp 清理上轮崩溃遗留的主文件临时流。
func removeVacuumTmp(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, aiSessionVacuumTmp) ||
			!strings.HasPrefix(name, aiSessionLogName+".") {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
}

// buildVacuumPlan 第一遍流式重放：内存只持 meta/header 行与行号表，
// 消息正文不进内存。语义与 replaySessionLog 逐事件同构。
func buildVacuumPlan(mainPath string) (*vacuumPlan, error) {
	f, err := os.Open(mainPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	plan := &vacuumPlan{}
	reader := bufio.NewReaderSize(f, 1<<20)
	lineNo := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			if line[len(line)-1] == '\n' {
				lineNo++
				plan.processLine(lineNo, line[:len(line)-1])
			} else {
				// 未提交尾行：与前端 torn 一致，丢弃。
				plan.torn = true
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return nil, readErr
		}
	}
	plan.foldDedupe()
	return plan, nil
}

// processLine 处理一条完整事件行（不含结尾换行）。空行静默跳过，坏行计数跳过。
func (p *vacuumPlan) processLine(lineNo int, content []byte) {
	trimmed := bytes.TrimSpace(content)
	if len(trimmed) == 0 {
		return
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		// JSON 坏行 / 顶层非对象（数字、字符串、null）。
		p.issues++
		return
	}
	if v, ok := fields["v"]; ok && jsNumberGT(v, float64(AI_SESSION_SCHEMA_V)) {
		p.issues++
		p.sawFutureSchema = true
		return
	}
	eventType, ok := jsString(fields["t"])
	if !ok {
		// t 缺失或非字符串：与前端 switch default 一致计 issue。
		p.issues++
		return
	}
	switch eventType {
	case "header":
		p.headerCount++
		p.headerLine = append([]byte(nil), content...)
	case "msg":
		mid, _ := jsString(fields["mid"])
		mRaw, hasM := fields["m"]
		if !hasM || !jsObjectLike(mRaw) {
			p.issues++
			return
		}
		entry := vacuumEntry{lineNo: lineNo, mid: mid, dedupeKey: dedupeKeyOf(mRaw)}
		if jsTruthy(fields["a"]) {
			p.archived = append(p.archived, entry)
		} else {
			p.live = append(p.live, entry)
		}
	case "truncate":
		keep := keepClamped(jsKeep(fields["keep"]), len(p.live))
		p.live = p.live[:keep]
		p.markers++
	case "archive":
		keep := keepClamped(jsKeep(fields["keep"]), len(p.live))
		moved := make([]vacuumEntry, keep)
		copy(moved, p.live[:keep])
		p.archived = append(p.archived, moved...)
		p.live = p.live[keep:]
		if summary, ok := fields["summary"]; ok && jsObjectLike(summary) {
			p.summaryJSON = append([]byte(nil), summary...)
		}
		p.markers++
	case "reset":
		p.live = nil
		p.archived = nil
		p.summaryJSON = nil
		p.markers++
		p.sawReset = true
	case "meta":
		// meta 事件按序原样保留进主文件（重放时折叠回 result.meta）。
		p.metaLines = append(p.metaLines, append([]byte(nil), content...))
		patch, ok := fields["patch"]
		if !ok || !jsObjectLike(patch) {
			return
		}
		var patchFields map[string]json.RawMessage
		if json.Unmarshal(patch, &patchFields) != nil {
			return
		}
		if summary, has := patchFields["summary"]; has {
			if jsObjectLike(summary) {
				p.summaryJSON = append([]byte(nil), summary...)
			} else {
				p.summaryJSON = nil
			}
		}
	case "turn", "tool", "approval", "agent":
		// 审计事件（前端 S5）：注解型，不参与消息流物化。校验只认「id 是非空字符串」，
		// 与前端 replaySessionLog 同口径；形状不合规仍计 issue（与坏行同等待遇）。
		id, idOk := jsString(fields["id"])
		if !idOk || strings.TrimSpace(id) == "" {
			p.issues++
			return
		}
		p.extLines = append(p.extLines, append([]byte(nil), content...))
	default:
		p.issues++
	}
}

// foldDedupe 在全部事件重放完成后折叠 live 的同类 dedupeKey（留每 key 最后一条），
// 口径与 replaySessionLog 一致；archived 不动。
func (p *vacuumPlan) foldDedupe() {
	lastByKey := make(map[string]int)
	for i, entry := range p.live {
		if entry.dedupeKey != "" {
			lastByKey[entry.dedupeKey] = i
		}
	}
	if len(lastByKey) == 0 {
		return
	}
	kept := make([]vacuumEntry, 0, len(p.live))
	for i, entry := range p.live {
		if entry.dedupeKey != "" && lastByKey[entry.dedupeKey] != i {
			p.dropped++
			continue
		}
		kept = append(kept, entry)
	}
	p.live = kept
}

// writeVacuumedMain 写主文件临时流：header + meta（按序）+ summary patch + live 原始行。
// live 行按行号流式抄写原文（逐字保留），第二遍扫描不解析不缓冲。
func (s *Store) writeVacuumedMain(mainPath string, plan *vacuumPlan) (string, error) {
	tmpPath := fmt.Sprintf("%s.%d.%d%s", mainPath, os.Getpid(), time.Now().UnixNano(), aiSessionVacuumTmp)
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	writer := bufio.NewWriterSize(f, 1<<20)
	writeErr := func() error {
		if len(plan.headerLine) > 0 {
			if _, err := writer.Write(plan.headerLine); err != nil {
				return err
			}
			if err := writer.WriteByte('\n'); err != nil {
				return err
			}
		}
		for _, meta := range plan.metaLines {
			if _, err := writer.Write(meta); err != nil {
				return err
			}
			if err := writer.WriteByte('\n'); err != nil {
				return err
			}
		}
		// 审计事件紧随 meta 之后：它们与消息的交错顺序在整理后不再保持（见 vacuumPlan.extLines
		// 注释），所以不按 lineNo 混排，避免与 copyLinesByNumber 的第二遍扫描抢顺序。
		for _, ext := range plan.extLines {
			if _, err := writer.Write(ext); err != nil {
				return err
			}
			if err := writer.WriteByte('\n'); err != nil {
				return err
			}
		}
		if plan.summaryJSON != nil {
			line, err := marshalLine(metaPatchEvent{V: AI_SESSION_SCHEMA_V, T: "meta", Patch: map[string]json.RawMessage{"summary": plan.summaryJSON}})
			if err != nil {
				return err
			}
			if _, err := writer.Write(line); err != nil {
				return err
			}
			if err := writer.WriteByte('\n'); err != nil {
				return err
			}
		}
		return copyLinesByNumber(mainPath, writer, liveSetOf(plan))
	}()
	if writeErr == nil {
		writeErr = writer.Flush()
	}
	if writeErr == nil {
		writeErr = f.Sync()
	}
	if closeErr := f.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		_ = os.Remove(tmpPath)
		return "", writeErr
	}
	return tmpPath, nil
}

// copyLinesByNumber 第二遍扫描：把 lineNo 命中 wanted 的原始行（含结尾换行）抄给 writer。
func copyLinesByNumber(mainPath string, writer *bufio.Writer, wanted map[int]bool) error {
	if len(wanted) == 0 {
		return nil
	}
	f, err := os.Open(mainPath)
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 1<<20)
	lineNo := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			lineNo++
			if wanted[lineNo] {
				if _, err := writer.Write(line); err != nil {
					return err
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

// collectArchiveLines 第二遍扫描：按重放序把归档条目重新编码为 a:1 事件。
// m 用 json.RawMessage 保字节原文；槽位按行号对位（归档序与文件行序不必单调）。
func collectArchiveLines(mainPath string, plan *vacuumPlan) ([][]byte, error) {
	slots := make([][]byte, len(plan.archived))
	indexOf := make(map[int]int, len(plan.archived))
	for i, entry := range plan.archived {
		indexOf[entry.lineNo] = i
	}
	f, err := os.Open(mainPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 1<<20)
	lineNo := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			lineNo++
			if idx, hit := indexOf[lineNo]; hit {
				content := bytes.TrimSpace(line[:len(line)-1])
				var fields map[string]json.RawMessage
				if json.Unmarshal(content, &fields) != nil {
					return nil, fmt.Errorf("归档行重读失败（行 %d）", lineNo)
				}
				mid, _ := jsString(fields["mid"])
				mRaw, hasM := fields["m"]
				if !hasM || !jsObjectLike(mRaw) {
					return nil, fmt.Errorf("归档行缺正文（行 %d）", lineNo)
				}
				encoded, err := marshalLine(archiveSidecarEvent{
					V: AI_SESSION_SCHEMA_V, T: "msg", Mid: mid, A: 1, M: mRaw,
				})
				if err != nil {
					return nil, err
				}
				slots[idx] = encoded
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return nil, readErr
		}
	}
	for i, slot := range slots {
		if slot == nil {
			return nil, fmt.Errorf("归档条目缺失原文（槽 %d）", i)
		}
	}
	return slots, nil
}

// appendSidecar 把归档事件追加进 sidecar（O_APPEND + fsync；append-only，永不整读重写）。
// appendSidecarBatch 把归档事件追加进 sidecar（O_APPEND + fsync；append-only，永不整读重写）。
// 幂等：sidecar 尾部与批次逐字节一致时跳过——崩溃恢复的模糊窗口里上一轮可能已完整追加过
// 同一批（同一 archived 集的编码字节是确定的），不清尾也不能产生重复行。
// 返回 appended=false 表示尾部已含同批内容、本次跳过。
func appendSidecarBatch(sidecarPath string, lines [][]byte) (bool, error) {
	batchSize := 0
	for _, line := range lines {
		batchSize += len(line) + 1
	}
	if info, err := os.Stat(sidecarPath); err == nil && info.Size() >= int64(batchSize) && batchSize > 0 {
		tail := make([]byte, batchSize)
		f, err := os.Open(sidecarPath)
		if err != nil {
			return false, err
		}
		_, readErr := f.ReadAt(tail, info.Size()-int64(batchSize))
		_ = f.Close()
		if readErr == nil {
			offset := 0
			same := true
			for _, line := range lines {
				if !bytes.Equal(tail[offset:offset+len(line)], line) || tail[offset+len(line)] != '\n' {
					same = false
					break
				}
				offset += len(line) + 1
			}
			if same {
				return false, nil
			}
		}
	}
	f, err := os.OpenFile(sidecarPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return false, err
	}
	writer := bufio.NewWriterSize(f, 1<<20)
	appendErr := func() error {
		for _, line := range lines {
			if _, err := writer.Write(line); err != nil {
				return err
			}
			if err := writer.WriteByte('\n'); err != nil {
				return err
			}
		}
		return nil
	}()
	if appendErr == nil {
		appendErr = writer.Flush()
	}
	if appendErr == nil {
		appendErr = f.Sync()
	}
	if closeErr := f.Close(); appendErr == nil {
		appendErr = closeErr
	}
	return appendErr == nil, appendErr
}

// countSidecarLines 统计 sidecar 的非空事件行数（流式扫描，不解析）。
func countSidecarLines(sidecarPath string) int {
	f, err := os.Open(sidecarPath)
	if err != nil {
		return 0
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 1<<20)
	count := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' && len(bytes.TrimSpace(line)) > 0 {
			count++
		}
		if readErr != nil {
			break
		}
	}
	return count
}

// ---------- JS 语义的小工具（与 replaySessionLog 逐条对齐） ----------

// AI_SESSION_SCHEMA_V 与前端 AI_SESSION_SCHEMA 对齐的事件 schema 版本。
const AI_SESSION_SCHEMA_V = 1

// archiveSidecarEvent 是 sidecar 里归档消息的编码形态。
type archiveSidecarEvent struct {
	V   int             `json:"v"`
	T   string          `json:"t"`
	Mid string          `json:"mid"`
	A   int             `json:"a"`
	M   json.RawMessage `json:"m"`
}

// metaPatchEvent 是主文件里 summary 的回发形态（ai-session-store.js:319-326 语义）。
type metaPatchEvent struct {
	V     int                        `json:"v"`
	T     string                     `json:"t"`
	Patch map[string]json.RawMessage `json:"patch"`
}

// marshalLine 编码一行事件（不带换行）。SetEscapeHTML(false)：sidecar 的 m 与 summary
// 回发虽是语义等价的重编码（空白会压缩），< > & U+2028 没必要被转义——保持与前端
// JSON.stringify 更接近的字节形态，减少与原行的视觉差异。
func marshalLine(v any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// jsNumber 把 JSON 原始值按 JS Number() 语义转成 float64；非数值返回 NaN 语义由调用方处理。
// 超界 JSON 数字（1e999）：JS JSON.parse 得 ±Infinity，Go json.Unmarshal 报 ErrRange ——
// 走 strconv.ParseFloat 兜底取回 ±Inf（ErrRange 时值仍有效），与 JS 语义对齐。
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	var num float64
	if err := json.Unmarshal(trimmed, &num); err == nil {
		return num, true
	}
	// JSON 数字但超 float64 解析范围（1e999 / -1e999）：strconv 会给 ±Inf + ErrRange。
	if len(trimmed) > 0 && (trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')) {
		if parsed, perr := strconv.ParseFloat(string(trimmed), 64); perr == nil || errors.Is(perr, strconv.ErrRange) {
			return parsed, true
		}
	}
	var str string
	if err := json.Unmarshal(trimmed, &str); err == nil {
		// JS Number(<string>) 只认十进制数字面量（含指数/十六进制）；
		// strconv 对 "Infinity" 给 +Inf 而 JS 得 NaN —— 方向是 Go 多留、前端收敛，留注释即可。
		if parsed, perr := strconv.ParseFloat(strings.TrimSpace(str), 64); perr == nil {
			return parsed, true
		}
		// Number("abc") = NaN
		return 0, false
	}
	var b bool
	if err := json.Unmarshal(trimmed, &b); err == nil {
		if b {
			return 1, true
		}
		return 0, true
	}
	// null / 对象 / 数组：Number(null)=0，其余 NaN。
	if bytes.Equal(trimmed, []byte("null")) {
		return 0, true
	}
	return 0, false
}

// jsNumberGT 判断 Number(raw) > target；NaN 一律 false（与前端 NaN>x 恒假一致）。
func jsNumberGT(raw json.RawMessage, target float64) bool {
	num, ok := jsNumber(raw)
	if !ok {
		return false
	}
	return num > target
}

// jsString 按 textOf 语义取字符串：字符串原样，其余（含缺失）为空。
func jsString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", false
	}
	var str string
	if err := json.Unmarshal(trimmed, &str); err != nil {
		return "", false
	}
	return str, true
}

// jsTruthy 按 JS 真值判断：false / null / 0 / "" 为假，对象与数组恒真。
func jsTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("false")) {
		return false
	}
	if bytes.Equal(trimmed, []byte("true")) {
		return true
	}
	var num float64
	if err := json.Unmarshal(trimmed, &num); err == nil {
		return num != 0
	}
	var str string
	if err := json.Unmarshal(trimmed, &str); err == nil {
		return str != ""
	}
	// 对象 / 数组恒真。
	return true
}

// jsObjectLike 判断是否对象/数组（typeof === 'object' 且非 null）。
func jsObjectLike(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return false
	}
	switch trimmed[0] {
	case '{', '[':
		return true
	}
	return false
}

// jsKeep 按 Number(event.keep) || 0 语义解析 keep；NaN / 缺失 → 0。
func jsKeep(raw json.RawMessage) float64 {
	num, ok := jsNumber(raw)
	if !ok {
		return 0
	}
	if num != num { // NaN 防御（json.Unmarshal 不会产出，留语义对齐注释）
		return 0
	}
	return num
}

// keepClamped 复刻 Math.max(0, Math.min(len, keep)) + slice 的取整语义。
// 必须在浮点域完成钳制再取整：直接 int(1e20) 是 implementation-dependent（amd64 得
// 负的「整数不定值」→ 会被当成 0 → live 全部判死），而 JS 端 1e20 clamp 后是「全部保留」。
// 审查发现的 P1：失败方向是最坏方向（物理丢消息）。
func keepClamped(keep float64, length int) int {
	if keep != keep { // NaN（jsKeep 已归 0，此处防御）
		return 0
	}
	if keep <= 0 {
		return 0
	}
	if float64(length) <= keep {
		return length
	}
	return int(keep) // 安全区间内向零取整，等价 JS ToIntegerOrInfinity
}

// dedupeKeyOf 从消息正文提取 dedupeKey（只认字符串；与前端 textOf 的差异仅限
// 非字符串 key 的病态输入，fixture 不覆盖该形状）。
func dedupeKeyOf(mRaw json.RawMessage) string {
	var payload struct {
		DedupeKey string `json:"dedupeKey"`
	}
	if json.Unmarshal(mRaw, &payload) != nil {
		return ""
	}
	return payload.DedupeKey
}

func liveSetOf(plan *vacuumPlan) map[int]bool {
	set := make(map[int]bool, len(plan.live))
	for _, entry := range plan.live {
		set[entry.lineNo] = true
	}
	return set
}

// ---------- 归档读回（分页，有界） ----------

// ArchivePage 是 sidecar 的分页读取结果：offset/limit 按非空事件行计。
// events 是原始事件行（{v,t,mid,a:1,m}），前端直接喂 replaySessionLog 复用同语义。
type ArchivePage struct {
	Total  int      `json:"total"`
	Offset int      `json:"offset"`
	Events []string `json:"events"`
}

// ReadArchive 分页读 sidecar。文件不存在返回空页（从未整理过的会话）。
// 只读不加锁：与在途 vacuum 的竞态最坏读到半行（按撕裂尾丢弃），下次读自愈。
func (s *Store) ReadArchive(id string, offset, limit int) (ArchivePage, error) {
	if offset < 0 {
		offset = 0
	}
	if limit < 0 {
		limit = 0
	}
	page := ArchivePage{Offset: offset, Events: []string{}}
	dir, err := s.sessionDir(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return page, nil
		}
		return page, err
	}
	f, err := os.Open(filepath.Join(dir, aiSessionArchiveName))
	if err != nil {
		if os.IsNotExist(err) {
			return page, nil
		}
		return page, err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 1<<20)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
				if page.Total >= offset && len(page.Events) < limit {
					page.Events = append(page.Events, string(trimmed))
				}
				page.Total++
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return page, readErr
		}
	}
	return page, nil
}

// ReadForce 读取正文且不做体积检查：真空角落的「临时加载」专用
// （用户自担慢，载入后开启 auto-compact 回归常态）。见方案 §5.4。
func (s *Store) ReadForce(id string) (string, error) {
	path, err := s.logPath(id)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(raw), nil
}

// ReadArchiveAll 返回 sidecar 全文（internal/sessionindex 的 ArchiveSource 接口实现，
// 索引扫描拼接用；非分页 UI 通道——UI 一律走 ReadArchive 分页）。文件不存在返回空串。
func (s *Store) ReadArchiveAll(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(dir, aiSessionArchiveName))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(raw), nil
}

// ClearArchive 删除归档 sidecar 与崩溃恢复清单。唯一调用方是「清空会话」：
// reset 语义下用户明确要求抹掉全部消息，sidecar 若保留，重启后归档卡会凭
// _archiveSidecarTotal 探测「复活」。与 Remove 同级，属于用户显式发起的销毁。
func (s *Store) ClearArchive(id string) error {
	return s.withSessionLock(id, "", false, func(dir string) error {
		_ = os.Remove(filepath.Join(dir, aiSessionArchiveName))
		_ = os.Remove(filepath.Join(dir, aiSessionVacuumState))
		removeVacuumTmp(dir)
		return nil
	})
}
