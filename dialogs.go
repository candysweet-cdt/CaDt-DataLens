package main

import (
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 通用文件对话框：打开/保存统一走这里，过滤器用预置短 id，避免把过滤模式散在各调用处。
// 用户取消时路径返回空串，由调用方自行判断不写文件。

var dialogFilters = map[string][]runtime.FileFilter{
	"exe": {{DisplayName: "可执行文件 (*.exe)", Pattern: "*.exe"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"txt": {{DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"log": {{DisplayName: "日志文件 (*.log)", Pattern: "*.log"}, {DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"mmd": {{DisplayName: "Mermaid (*.mmd)", Pattern: "*.mmd"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"any": {{DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
}

func dialogFilterOrAny(filter string) []runtime.FileFilter {
	if filters, ok := dialogFilters[strings.ToLower(strings.TrimSpace(filter))]; ok {
		return filters
	}
	return dialogFilters["any"]
}

// ShowOpenFileDialog 通用文件选择对话框。
func (a *App) ShowOpenFileDialog(title string, filter string) (string, error) {
	name := strings.TrimSpace(title)
	if name == "" {
		name = "选择文件"
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   name,
		Filters: dialogFilterOrAny(filter),
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}

// ShowSaveFileDialog 通用保存对话框。
func (a *App) ShowSaveFileDialog(title string, defaultName string, filter string) (string, error) {
	name := strings.TrimSpace(title)
	if name == "" {
		name = "保存文件"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           name,
		DefaultFilename: strings.TrimSpace(defaultName),
		Filters:         dialogFilterOrAny(filter),
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}
