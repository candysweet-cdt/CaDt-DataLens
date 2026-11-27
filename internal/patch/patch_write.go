package patch

// 写入与撤销：两阶段提交（atomic/partial）、temp+rename 落盘、字节快照回滚。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/chardec"
	"datalens/internal/recycle"
)

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
	// 保留原文件权限：硬编码 0644 会把可执行位一起抹掉（脚本/二进制补丁）。
	mode := os.FileMode(0o644)
	if info, err := os.Stat(abs); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		// 非致命：Windows 上权限位基本不生效
	}
	return atomfile.Replace(tmpName, abs)
}

// applyPatchPlan 按模式提交计划：atomic 要么全成要么零变更；partial 跳过失败项。
func ApplyPatchPlan(plan *patchPlan, files []string, hunksByFile map[string][]int, mode string) (*PatchApplyResult, error) {
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
			res.Code = PatchErrHunkConflict
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
				// 子集重算沿用预检的 ignoreWS：硬编码 false 会让"按忽略空白定位出的
				// offset"在严格匹配下判成上下文不匹配，与预检结论自相矛盾。
				out, segs, failIdx, reason := applyHunks(target.Lines, pf.PatchFile.Hunks, sel, pf.Offset, plan.IgnoreWhitespace)
				if failIdx >= 0 {
					if mode == "partial" {
						skipped = append(skipped, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: reason})
						continue
					}
					res.Code = PatchErrHunkConflict
					res.Message = fmt.Sprintf("未应用任何更改：%s（%s）", pf.RelPath, reason)
					return res, nil
				}
				if !verifyReverse(out, segs, target.Lines) {
					if mode == "partial" {
						skipped = append(skipped, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: "反向校验失败"})
						continue
					}
					res.Code = PatchErrApplyIO
					res.Message = "未应用任何更改：反向校验失败"
					return res, nil
				}
				final := resolveFinalNewline(target.FinalNewline, pf.PatchFile.Hunks, target.Lines, pf.Offset, segs)
				pf.ResultText = joinPatchLines(out, final)
				pf.ResultHash = SHA256Hex(buildBytesOrNil(pf.ResultText, target))
			}
		}
		todo = append(todo, item{pf: pf})
	}
	if len(todo) == 0 {
		res.Applied = 0
		res.Skipped = len(skipped)
		res.Files = skipped
		if len(skipped) > 0 {
			res.Code = PatchErrHunkConflict
			res.Message = "没有可应用的文件"
			return res, nil
		}
		res.OK = true
		return res, nil
	}

	store := PatchStoreRoot(plan.Root)
	id := plan.PatchID
	if id == "" {
		id = NewPatchRunID("ext")
	}
	backupDir, manifestPath, err := ensurePatchDirs(store, id)
	if err != nil {
		res.Code = PatchErrNoBackup
		res.Message = PatchErrorOf(err).Msg
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
		res.Code = PatchErrDiskFull
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
			res.Code = PatchErrNoBackup
			res.Message = "备份失败：" + rerr.Error()
			return res, nil
		}
		// wipe-guard 写前快照：撤销快照已读进内存，顺手持久化成可跨会话恢复的备份
		//（尽力而为，失败不影响补丁应用；见 docs/unfinished-plans/workspace-wipe-guard.md §4.2）
		if OnWriteBackup != nil {
			OnWriteBackup(plan.Root, pf.RelPath, pf.Abs, raw)
		}
		// 原子写：写到一半掉电会留下截断的备份，撤销时被当成"备份损坏"。
		if werr := atomfile.WriteFileAtomicMode(dest, raw, 0o644); werr != nil {
			res.Code = PatchErrNoBackup
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
		// manifest 是撤销的唯一索引：非原子写会让"应用记录损坏"，撤销直接失效。
		if werr := atomfile.WriteFileAtomicMode(manifestPath, b, 0o644); werr != nil {
			res.Code = PatchErrApplyIO
			res.Message = "补丁清单写入失败：" + werr.Error()
			return res, nil
		}
	}

	// WAL：applying 先落盘
	fileList := make([]string, 0, len(todo))
	for _, it := range todo {
		fileList = append(fileList, it.pf.RelPath)
	}
	_ = AppendPatchIndex(store, PatchIndexEntry{
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
		res.Code = PatchErrBusy
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
	// fail 是失败路径的唯一出口：先回滚，再按「是否有文件没恢复」决定错误码。
	// 回滚未恢复时改写成 PatchErrRollback——patchcli 只在看到这个码时才打印
	// 「⚠ 有文件未能恢复」并列出备份目录；此前该码从未被赋值，那段提示是死代码，
	// 用户只看到"写入失败"，不知道工作区处于半应用状态。
	fail := func(code, message string) (*PatchApplyResult, error) {
		bad := rollback()
		res.Unrestored = bad
		res.Code, res.Message = resolveRollbackFailure(code, message, bad)
		return res, nil
	}

	for _, it := range todo {
		pf := it.pf
		// 写入前最后一次校验（TOCTOU 窗口压缩到最小）
		if pf.Target != nil && pf.Target.Exists {
			cur, rerr := os.ReadFile(pf.Abs)
			if rerr != nil {
				return fail(PatchErrFileLocked, fmt.Sprintf("%s：无法读取（可能被占用）", pf.RelPath))
			}
			if SHA256Hex(cur) != pf.Target.Hash {
				return fail(PatchErrConcurrent, fmt.Sprintf("%s：文件在应用过程中被其他程序修改", pf.RelPath))
			}
		}
		if pf.Kind == "delete" {
			if err := recycle.Move(pf.Abs); err != nil {
				if rerr := os.Remove(pf.Abs); rerr != nil {
					return fail(PatchErrApplyIO, fmt.Sprintf("%s：删除失败（%s）", pf.RelPath, rerr))
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
				return fail(PatchErrApplyIO, fmt.Sprintf("%s：无法创建父目录（%s）", pf.RelPath, err))
			}
		}
		// 编码可表示性预检：目标文件是 GBK/GB18030 时，补丁里夹带的字符可能编不出来。
		// chardec 走 ReplaceUnsupported（静默替换成 0x1A），随后哈希重算又把损坏"洗白"。
		if pf.Target != nil && pf.Target.Exists && !chardec.CanEncode(pf.ResultText, pf.Target.Enc) {
			return fail(PatchErrApplyIO, fmt.Sprintf("%s：结果包含 %s 编码无法表示的字符，已中止（避免静默替换后损坏文件）", pf.RelPath, pf.Target.Enc))
		}
		data := buildBytesOrNil(pf.ResultText, pf.Target)
		if SHA256Hex(data) != pf.ResultHash {
			// 结果哈希不稳定（编码/换行差异），以实际写入内容为准重算
			pf.ResultHash = SHA256Hex(data)
		}
		if err := writePatchFileAtomic(pf.Abs, data); err != nil {
			if mode == "partial" {
				res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: "写入失败：" + err.Error()})
				res.Skipped++
				continue
			}
			return fail(PatchErrApplyIO, fmt.Sprintf("%s：写入失败（%s）", pf.RelPath, err))
		}
		// 写入后读回校验
		if back, err := os.ReadFile(pf.Abs); err == nil && SHA256Hex(back) != pf.ResultHash {
			if mode == "partial" {
				_ = writePatchFileAtomic(pf.Abs, mustReadOrNil(backupMap[pf.RelPath]))
				res.Skipped++
				res.Files = append(res.Files, PatchFileResult{RelPath: pf.RelPath, Status: "skipped", Reason: "写入后校验不一致，已回滚"})
				continue
			}
			return fail(PatchErrConcurrent, fmt.Sprintf("%s：写入后校验不一致（文件可能被其他程序覆盖）", pf.RelPath))
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
	_ = AppendPatchIndex(store, PatchIndexEntry{
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
		res.Code = PatchErrHunkConflict
		res.Message = "没有文件被应用"
	}
	res.RevertID = id
	res.BackupDir = backupDir
	return res, nil
}

// resolveRollbackFailure 决定失败提示的最终错误码与文案。
// 回滚有残留时必须改用 PatchErrRollback：CLI 只在这个码下打印「有文件未能恢复」
// 与备份目录，用户才知道工作区不是"完全没动过"。
func resolveRollbackFailure(code, message string, unrestored []string) (string, string) {
	if len(unrestored) == 0 {
		return code, message
	}
	return PatchErrRollback, fmt.Sprintf("%s；以下文件回滚失败，工作区可能处于半应用状态：%s",
		message, strings.Join(unrestored, "、"))
}

func mustReadOrNil(path string) []byte {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return b
}

// ===== 撤销 =====

func RevertPatchByID(root, patchID, onConflict string) (*PatchRevertResult, error) {
	res := &PatchRevertResult{}
	store := PatchStoreRoot(root)
	if store == "" {
		res.Code = PatchErrNoBackup
		res.Message = "找不到补丁存储目录"
		return res, nil
	}
	manifestPath := filepath.Join(store, "manifest", patchID+".json")
	b, err := os.ReadFile(manifestPath)
	if err != nil {
		res.Code = PatchErrNoBackup
		res.Message = "找不到该补丁的应用记录（可能已被清理）"
		return res, nil
	}
	var m patchManifest
	if err := json.Unmarshal(b, &m); err != nil {
		res.Code = PatchErrNoBackup
		res.Message = "应用记录损坏"
		return res, nil
	}
	if m.Root != "" {
		root = m.Root
	}
	releaseWS, lockErr := lockPatchWorkspace(root, 3*time.Second)
	if lockErr != nil {
		res.Code = PatchErrBusy
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
			res.Code = PatchErrPathDenied
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
				if rerr == nil && p.entry.ResultHash != "" && SHA256Hex(raw) != p.entry.ResultHash && onConflict != "force" {
					if onConflict == "stash" {
						// 备份必须先成功才允许覆盖：此前这里 `_ = os.WriteFile` 吞掉错误，
						// 随后照样强制覆盖——用户选了"另存后撤销"，改动却被静默抹掉且无备份。
						if werr := atomfile.WriteFileAtomicMode(p.abs+".revert-backup", raw, 0o644); werr != nil {
							res.Code = PatchErrApplyIO
							res.Message = p.entry.RelPath + "：改动备份写入失败（" + werr.Error() + "），已放弃撤销"
							return res, nil
						}
					} else {
						res.Code = PatchErrConcurrent
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
			res.Code = PatchErrNoBackup
			res.Message = "备份文件缺失：" + p.entry.BackupFile
			return res, nil
		}
		cur, rerr := os.ReadFile(p.abs)
		if rerr == nil && p.entry.ResultHash != "" && SHA256Hex(cur) != p.entry.ResultHash && onConflict != "force" {
			if onConflict == "stash" {
				// 同上：备份不成功就不覆盖，避免"另存后撤销"变成静默丢失。
				if werr := atomfile.WriteFileAtomicMode(p.abs+".revert-backup", cur, 0o644); werr != nil {
					res.Code = PatchErrApplyIO
					res.Message = p.entry.RelPath + "：改动备份写入失败（" + werr.Error() + "），已放弃撤销"
					return res, nil
				}
			} else {
				res.Code = PatchErrConcurrent
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
				res.Code = PatchErrApplyIO
				res.Message = "删除失败：" + p.entry.RelPath
				return res, nil
			}
			res.Files = append(res.Files, p.entry.RelPath)
			continue
		}
		raw, err := os.ReadFile(filepath.Join(store, "backup", m.ID, p.entry.BackupFile))
		if err != nil {
			res.Code = PatchErrNoBackup
			res.Message = "备份读取失败：" + p.entry.RelPath
			return res, nil
		}
		// 加锁后复核：检查阶段与加锁阶段之间，外部程序可能又改了文件。
		// 没有这一步，那段"先全部检查"只是缩小了窗口，并没有关掉它。
		if p.entry.ResultHash != "" && onConflict != "force" {
			if cur, cerr := os.ReadFile(p.abs); cerr == nil && SHA256Hex(cur) != p.entry.ResultHash {
				if onConflict == "stash" {
					if werr := atomfile.WriteFileAtomicMode(p.abs+".revert-backup", cur, 0o644); werr != nil {
						res.Code = PatchErrApplyIO
						res.Message = p.entry.RelPath + "：改动备份写入失败（" + werr.Error() + "），已放弃撤销"
						return res, nil
					}
				} else {
					res.Code = PatchErrConcurrent
					res.Message = p.entry.RelPath + " 在应用后被修改，已放弃撤销（可选择另存或强制覆盖）"
					return res, nil
				}
			}
		}
		if err := writePatchFileAtomic(p.abs, raw); err != nil {
			res.Code = PatchErrApplyIO
			res.Message = "还原失败：" + p.entry.RelPath
			return res, nil
		}
		res.Files = append(res.Files, p.entry.RelPath)
	}
	_ = AppendPatchIndex(store, PatchIndexEntry{
		V: 1, ID: m.ID, Summary: "", FileName: "", CreatedAt: m.Created, Root: root,
		Files: res.Files, Status: "reverted", RevertedAt: time.Now().Unix(),
	})
	res.OK = true
	return res, nil
}

// ===== 命名与 id =====

// patchIDSeq 给同一时间桶内的连续调用提供区分位：原实现只用 100µs 粒度的
// 纳秒余数，同一桶内两次调用会拿到同一 ID，backup/<id> 与 manifest/<id>.json
// 互相覆盖（MkdirAll 不校验存在性）。
var patchIDSeq atomic.Uint32

func NewPatchRunID(prefix string) string {
	now := time.Now()
	seq := patchIDSeq.Add(1) % 1000
	return fmt.Sprintf("%s%s-%04d-%03d", prefix, now.Format("20060102-150405"), now.Nanosecond()/1e5%10000, seq)
}

func SlugifyPatchSummary(summary string) string {
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

func UniquePatchPath(store, slug string) string {
	ts := time.Now().Format("20060102-150405")
	base := ts + "-" + slug
	candidate := filepath.Join(store, base+".patch")
	for i := 2; i < 100; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = filepath.Join(store, fmt.Sprintf("%s-%d.patch", base, i))
	}
	return filepath.Join(store, base+"-"+NewPatchRunID("")+".patch")
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
