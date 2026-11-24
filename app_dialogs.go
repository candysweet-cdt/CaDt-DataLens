package main

// app_dialogs.go：文件系统对话框的 Wails 绑定（打开/保存/目录选择）。
//
// 由 app_dialogs.go + app_fs.go 合并而来（2026-11-24 三期结构化）：两者都是
// 文件对话框绑定，共用 dialogOwner / isDialogCancelled / dialogFilterOrAny 这组
// 助手，本就该在一个文件里。目录/条目操作本身已下沉 internal/fsops。
//
// 通用对话框：打开/保存统一走这里，过滤器用预置短 id，避免把过滤模式散在各调用处。
// 用户取消时路径返回空串，由调用方自行判断不写文件。

import (
	"context"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/fsops"
)

// isDialogCancelled 识别文件对话框的取消。v2 显式吞掉取消（空值+nil），v3 的 cfd 层
// 把取消透传成错误——该错误类型在 internal/go-common-file-dialog/cfd 里导不出来，
// 只能按消息识别（对照 v2 dialog.go 的 ErrCancelled 文案）。
func isDialogCancelled(err error) bool {
	return err != nil && strings.Contains(err.Error(), "cancelled by user")
}

// dialogFilter 是 v3 对话框过滤器的最小本地表示（DisplayName + 分号分隔扩展名）。
type dialogFilter struct {
	DisplayName string
	Pattern     string
}

var dialogFilters = map[string][]dialogFilter{
	"exe": {{DisplayName: "可执行文件 (*.exe)", Pattern: "*.exe"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"txt": {{DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"log": {{DisplayName: "日志文件 (*.log)", Pattern: "*.log"}, {DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"mmd": {{DisplayName: "Mermaid (*.mmd)", Pattern: "*.mmd"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"any": {{DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
}

func dialogFilterOrAny(filter string) []dialogFilter {
	if filters, ok := dialogFilters[strings.ToLower(strings.TrimSpace(filter))]; ok {
		return filters
	}
	return dialogFilters["any"]
}

// dialogOwner 解析对话框属主窗口：优先绑定调用方窗口（ctx），否则回落当前主窗。
// 属主让对话框模态到对应窗口并跟随其位置（浮窗置顶时不再被压住——2026-11-21
// 审查第 4 项）。拿不到窗口返回 nil = 维持无属主的旧行为。
func dialogOwner(ctx context.Context) *application.WebviewWindow {
	if w := callerWindow(ctx); w != nil {
		return w
	}
	return currentWindow()
}

// ShowOpenFileDialog 通用文件选择对话框。
func (a *App) ShowOpenFileDialog(ctx context.Context, title string, filter string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	name := strings.TrimSpace(title)
	if name == "" {
		name = "选择文件"
	}
	dialog := wailsApp.Dialog.OpenFile().SetTitle(name)
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	for _, f := range dialogFilterOrAny(filter) {
		dialog.AddFilter(f.DisplayName, f.Pattern)
	}
	path, err := dialog.PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}

// ShowSaveFileDialog 通用保存对话框。
func (a *App) ShowSaveFileDialog(ctx context.Context, title string, defaultName string, filter string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	name := strings.TrimSpace(title)
	if name == "" {
		name = "保存文件"
	}
	dialog := wailsApp.Dialog.SaveFile()
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	dialog.SetOptions(&application.SaveFileDialogOptions{Title: name})
	dialog.SetFilename(strings.TrimSpace(defaultName))
	for _, f := range dialogFilterOrAny(filter) {
		dialog.AddFilter(f.DisplayName, f.Pattern)
	}
	path, err := dialog.PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}

// OpenFilesDialog 多选打开（结构化数据过滤器，供「打开文件」入口用）。
func (a *App) OpenFilesDialog(ctx context.Context) ([]string, error) {
	if wailsApp == nil {
		return nil, nil
	}
	dialog := wailsApp.Dialog.OpenFile().
		SetTitle("打开文件").
		AddFilter("结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)", "*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv").
		AddFilter("所有文件 (*.*)", "*.*")
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	paths, err := dialog.PromptForMultipleSelection()
	if isDialogCancelled(err) {
		return nil, nil
	}
	return paths, err
}

// OpenFolderDialog 选择文件夹。
func (a *App) OpenFolderDialog(ctx context.Context, defaultDir string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	dialog := wailsApp.Dialog.OpenFile().
		CanChooseFiles(false).
		CanChooseDirectories(true).
		SetTitle("打开文件夹")
	if strings.TrimSpace(defaultDir) != "" {
		dialog.SetDirectory(defaultDir)
	}
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	path, err := dialog.PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	return path, err
}

// SaveFileDialog 简单保存对话框（默认「所有文件」过滤器）。
func (a *App) SaveFileDialog(ctx context.Context, defaultName string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	dialog := wailsApp.Dialog.SaveFile()
	dialog.SetOptions(&application.SaveFileDialogOptions{Title: "保存文件"})
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	path, err := dialog.
		SetFilename(defaultName).
		AddFilter("所有文件 (*.*)", "*.*").
		PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	return path, err
}

// 兼容别名（实现已下沉 internal/fsops）。
type DirEntry = fsops.DirEntry

type DirListing = fsops.DirListing
