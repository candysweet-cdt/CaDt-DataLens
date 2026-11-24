package structuredir

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 structuredir_app.go）逐字一致，前端零改动。
//
// 遍历与渲染在包内；保存对话框与写盘是宿主动作，经 Deps 注入（根 host_wiring.go
// 接到 wailsApp 的对话框与 fileio 的写盘）。

import (
	"errors"
	"strings"
)

// Deps 是宿主动作注入：保存对话框与文本写盘。
type Deps struct {
	SaveFileDialog func(title, defaultName, filter string) (string, error)
	WriteText      func(path, text string) error
}

var deps Deps

// SetDeps 注入宿主动作（根 init 调用一次）。
func SetDeps(d Deps) { deps = d }

// Service 是目录结构导出的绑定承载类型。
type Service struct{}

// StructureDir 只生成结构树文本，不落盘。
func (s *Service) StructureDir(dir string) (string, error) {
	return Render(dir)
}

// ExportStructureDir 先弹出系统保存对话框选择导出路径，再生成并写入；
// 用户取消时返回空路径且不写文件。
func (s *Service) ExportStructureDir(dir string) (string, error) {
	if deps.SaveFileDialog == nil || deps.WriteText == nil {
		return "", errors.New("目录结构导出：宿主动作未注入")
	}
	clean, rootName, err := ResolveRoot(dir)
	if err != nil {
		return "", err
	}
	path, err := deps.SaveFileDialog("导出结构化目录", rootName+"-目录结构.txt", "txt")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	text, err := Render(clean)
	if err != nil {
		return "", err
	}
	if err := deps.WriteText(path, text); err != nil {
		return "", err
	}
	return path, nil
}

// ExportStructureText 先弹出系统保存对话框选择导出路径，再写入调用方给定的文本；
// 用户取消时返回空路径且不写文件。结构面板的结构树导出复用此通道。
func (s *Service) ExportStructureText(defaultName string, content string) (string, error) {
	if deps.SaveFileDialog == nil || deps.WriteText == nil {
		return "", errors.New("结构导出：宿主动作未注入")
	}
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "结构.txt"
	}
	filter := "txt"
	if strings.HasSuffix(strings.ToLower(name), ".mmd") {
		filter = "mmd"
	}
	path, err := deps.SaveFileDialog("导出结构", name, filter)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	if err := deps.WriteText(path, content); err != nil {
		return "", err
	}
	return path, nil
}
