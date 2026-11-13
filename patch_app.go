package main

// 补丁能力的 Wails 导出层：只做参数整理、根目录解析与副作用分发，
// 真正的解析/匹配/写入在 patch.go 的自由函数里，CLI 与界面共用同一套实现。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// patchSidecar 记录"这份补丁是基于哪一版文件生成的"，用于检测生成后的漂移。
// 不写进 .patch 本身（保持标准格式），按补丁内容 sha256 存本地。
type patchSidecar struct {
	ID        string            `json:"id"`
	Summary   string            `json:"summary"`
	CreatedAt int64             `json:"createdAt"`
	PatchSHA  string            `json:"patchSha"`
	Root      string            `json:"root"`
	Files     map[string]string `json:"files"` // relPath(小写) -> 生成时内容 sha256
}

func patchMetaDir(store string) string { return filepath.Join(store, "meta") }

func loadPatchSidecar(store, patchSHA string) *patchSidecar {
	if store == "" || patchSHA == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(patchMetaDir(store), patchSHA+".json"))
	if err != nil {
		return nil
	}
	var sc patchSidecar
	if json.Unmarshal(b, &sc) != nil {
		return nil
	}
	return &sc
}

func savePatchSidecar(store string, sc *patchSidecar) {
	if store == "" {
		return
	}
	_ = os.MkdirAll(patchMetaDir(store), 0o755)
	b, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(patchMetaDir(store), sc.PatchSHA+".json"), b, 0o644)
}

// readPatchFileText 读取 .patch 文本：剥 BOM、统一换行，并做大小限制。
func readPatchFileText(path string, limit int) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("这是一个目录：%s", filepath.Base(path))
	}
	if info.Size() > int64(limit) {
		return "", newPatchError(patchErrLimit, fmt.Sprintf("补丁文件超过 %d KB，请拆分后再用", limit/1024))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text, nil
}

// PatchSave 落盘补丁并返回首次预览。
func (a *App) PatchSave(root, summary, text string) (*PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, newPatchError(patchErrEmpty, "补丁内容为空")
	}
	if len(text) > patchMaxTextBytes {
		return nil, newPatchError(patchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patchStoreRoot(root)
	if store == "" {
		return nil, newPatchError(patchErrNoBackup, "无法确定补丁存储目录")
	}
	if err := os.MkdirAll(store, 0o755); err != nil {
		return nil, &patchError{Code: patchErrNoBackup, Msg: "无法创建补丁目录", Detail: err.Error()}
	}
	id := newPatchRunID("")
	slug := slugifyPatchSummary(summary)
	patchPath := uniquePatchPath(store, slug)
	body := text
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	if err := os.WriteFile(patchPath, []byte(body), 0o644); err != nil {
		return nil, &patchError{Code: patchErrApplyIO, Msg: "写入补丁文件失败", Detail: err.Error()}
	}

	plan, err := buildPatchPlan(doc, root, id, summary, patchPath, patchPlanOptions{})
	if err != nil {
		return nil, err
	}
	// 记录基线（此刻的磁盘内容就是"生成时"的版本）
	files := map[string]string{}
	for _, f := range plan.Files {
		if f.Target != nil && f.Target.Exists && f.RelPath != "" {
			files[strings.ToLower(f.RelPath)] = f.Target.Hash
		}
	}
	savePatchSidecar(store, &patchSidecar{
		ID: id, Summary: summary, CreatedAt: time.Now().Unix(),
		PatchSHA: sha256Hex([]byte(body)), Root: root, Files: files,
	})
	_ = appendPatchIndex(store, patchIndexEntry{
		V: 1, ID: id, Summary: summary, FileName: filepath.Base(patchPath),
		CreatedAt: time.Now().Unix(), Root: root, Files: fileNames(plan),
		Added: plan.Added, Removed: plan.Removed, Status: "proposed", PatchPath: patchPath,
	})
	putPatchPlan(plan)
	return plan.toPreview(), nil
}

func fileNames(plan *patchPlan) []string {
	out := make([]string, 0, len(plan.Files))
	for _, f := range plan.Files {
		out = append(out, f.RelPath)
	}
	return out
}

// PatchPreviewFile 打开任意 .patch（外部补丁）：自动解析路径层级、带基线校验。
func (a *App) PatchPreviewFile(path, root string) (*PatchPreview, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, newPatchError(patchErrBackend, "缺少补丁文件路径")
	}
	text, err := readPatchFileText(path, patchMaxTextBytes)
	if err != nil {
		return nil, err
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patchStoreRoot(root)
	sha := sha256Hex([]byte(text))
	var opts patchPlanOptions
	opts.External = true
	summary := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if sc := loadPatchSidecar(store, sha); sc != nil {
		opts.BaseHashes = sc.Files
		if sc.Summary != "" {
			summary = sc.Summary
		}
	}
	opts.StripLevel = -1
	plan, perr := buildPatchPlan(doc, root, "", summary, path, opts)
	if perr != nil {
		return nil, perr
	}
	// 若是本应用生成、后来被重新打开的补丁：按索引把 id 找回来，撤销才能用
	absPath, _ := filepath.Abs(path)
	for _, meta := range collectPatchMetas(store) {
		if meta.PatchPath == "" {
			continue
		}
		if cmp, _ := filepath.Abs(meta.PatchPath); strings.EqualFold(cmp, absPath) {
			plan.PatchID = meta.ID
			if meta.Summary != "" {
				plan.Summary = meta.Summary
			}
			break
		}
	}
	plan.External = plan.PatchID == ""
	putPatchPlan(plan)
	return plan.toPreview(), nil
}

// PatchRepreview 用同一份补丁按新选项重新预检（勾选变化 / 允许位移 / 忽略空白）。
func (a *App) PatchRepreview(planID string, allowOffset, ignoreWhitespace bool) (*PatchPreview, error) {
	old := getPatchPlan(planID)
	if old == nil {
		return nil, newPatchError(patchErrBackend, "预览已过期，请重新打开补丁")
	}
	text, err := readPatchFileText(old.PatchPath, patchMaxTextBytes)
	if err != nil {
		return nil, err
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patchStoreRoot(old.Root)
	opts := patchPlanOptions{AllowOffset: allowOffset, IgnoreWhitespace: ignoreWhitespace, External: old.External}
	if sc := loadPatchSidecar(store, sha256Hex([]byte(text))); sc != nil {
		opts.BaseHashes = sc.Files
	}
	plan, perr := buildPatchPlan(doc, old.Root, old.PatchID, old.Summary, old.PatchPath, opts)
	if perr != nil {
		return nil, perr
	}
	plan.External = old.External
	putPatchPlan(plan)
	if old.PlanID != "" {
		patchPlanMu.Lock()
		delete(patchPlans, old.PlanID)
		patchPlanMu.Unlock()
	}
	return plan.toPreview(), nil
}

// PatchApply 提交预览（必须带 planId）。
func (a *App) PatchApply(planID string, files []string, hunks map[string][]int, mode string) (*PatchApplyResult, error) {
	plan := getPatchPlan(planID)
	if plan == nil {
		return &PatchApplyResult{Code: patchErrBackend, Message: "预览已过期，请重新预览后再应用"}, nil
	}
	res, err := applyPatchPlan(plan, files, hunks, mode)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// PatchRevert 从备份还原整份补丁。
func (a *App) PatchRevert(patchID, root, onConflict string) (*PatchRevertResult, error) {
	patchID = strings.TrimSpace(patchID)
	if patchID == "" {
		return &PatchRevertResult{Code: patchErrBackend, Message: "缺少补丁 id"}, nil
	}
	return revertPatchByID(root, patchID, onConflict)
}

// PatchList 最近补丁列表（按时间倒序）。
func (a *App) PatchList(root string, limit int) ([]PatchMeta, error) {
	store := patchStoreRoot(root)
	list := collectPatchMetas(store)
	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	return list, nil
}

// PatchDelete 删除补丁记录及其备份（文件进回收站）。
func (a *App) PatchDelete(id, root string) error {
	store := patchStoreRoot(root)
	if store == "" {
		return newPatchError(patchErrNoBackup, "找不到补丁存储目录")
	}
	backup := filepath.Join(store, "backup", id)
	if _, err := os.Stat(backup); err == nil {
		_ = movePathToRecycleBin(backup)
	}
	_ = os.Remove(filepath.Join(store, "manifest", id+".json"))
	return nil
}

// PatchReadText 给补丁视图取正文（大文件时避免一次性塞进 Wails 调用参数）。
func (a *App) PatchReadText(path string) (string, error) {
	return readPatchFileText(path, patchMaxTextBytes)
}

// PatchWorkspaceRoot 给前端一个兜底：没开工作区时用应用数据目录存放补丁。
func (a *App) PatchStoreDir(root string) string {
	return patchStoreRoot(root)
}
