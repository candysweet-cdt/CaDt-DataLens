package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	largeFileBytes = 10 << 20
	maxFileBytes   = 100 << 20
)

type App struct {
	ctx         context.Context
	startupFile string
	dirty       bool
}

type FileData struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	Eol     string `json:"eol"`
	HasBom  bool   `json:"hasBom"`
	Large   bool   `json:"large"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startupFile = firstFileArg(os.Args[1:])
	runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
		if p := firstFileArg(paths); p != "" {
			runtime.EventsEmit(ctx, "open-file", p)
		}
	})
}

func (a *App) secondInstance(data options.SecondInstanceData) {
	if p := firstFileArg(data.Args); p != "" {
		runtime.EventsEmit(a.ctx, "open-file", p)
	}
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
}

func firstFileArg(args []string) string {
	exe, _ := os.Executable()
	for _, arg := range args {
		if arg == "" || strings.HasPrefix(arg, "-") || strings.EqualFold(arg, exe) {
			continue
		}
		if info, err := os.Stat(arg); err == nil && !info.IsDir() {
			return arg
		}
	}
	return ""
}

func (a *App) GetStartupFile() string {
	return a.startupFile
}

func (a *App) OpenFile(path string) (*FileData, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxFileBytes {
		return nil, fmt.Errorf("文件超过 100 MB，拒绝打开：%s", filepath.Base(path))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	hasBom := len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF
	if hasBom {
		raw = raw[3:]
	}
	eol := "lf"
	if strings.Contains(string(raw), "\r\n") {
		eol = "crlf"
	}
	return &FileData{
		Path:    path,
		Name:    filepath.Base(path),
		Content: string(raw),
		Size:    info.Size(),
		Eol:     eol,
		HasBom:  hasBom,
		Large:   info.Size() > largeFileBytes,
	}, nil
}

func (a *App) SaveFile(path, content, eol string, hasBom bool) error {
	if path == "" {
		return fmt.Errorf("没有目标文件")
	}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if eol == "crlf" {
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}
	raw := []byte(content)
	if hasBom {
		raw = append([]byte{0xEF, 0xBB, 0xBF}, raw...)
	}
	return os.WriteFile(path, raw, 0644)
}

func (a *App) OpenFileDialog() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "打开 JSON",
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON 文件 (*.json;*.jsonl;*.ndjson)", Pattern: "*.json;*.jsonl;*.ndjson"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

func (a *App) SaveFileDialog(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "保存 JSON",
		DefaultFilename: defaultName,
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON 文件 (*.json)", Pattern: "*.json"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

func (a *App) SetDirty(dirty bool) {
	a.dirty = dirty
}

func (a *App) beforeClose(ctx context.Context) bool {
	if !a.dirty {
		return false
	}
	answer, _ := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:      runtime.QuestionDialog,
		Title:     "JsonLens",
		Message:   "当前文件有未保存的修改，关闭后将丢弃。继续关闭？",
		Buttons:       []string{"丢弃并关闭", "取消"},
		DefaultButton: "取消",
		CancelButton:  "取消",
	})
	return answer != "丢弃并关闭"
}