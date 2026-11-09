package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 与参考脚本保持一致：结构化目录时跳过这两类目录
var structureDirIgnored = map[string]bool{
	".git":        true,
	"__pycache__": true,
}

type structureNode struct {
	name     string
	isDir    bool
	children []*structureNode
}

func isASCIIDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

// naturalLess 模拟 Windows 资源管理器的自然排序：忽略大小写，数字按数值比较
func naturalLess(a, b string) bool {
	la := strings.ToLower(a)
	lb := strings.ToLower(b)
	i, j := 0, 0
	for i < len(la) && j < len(lb) {
		if isASCIIDigit(la[i]) && isASCIIDigit(lb[j]) {
			si, sj := i, j
			for i < len(la) && isASCIIDigit(la[i]) {
				i++
			}
			for j < len(lb) && isASCIIDigit(lb[j]) {
				j++
			}
			na := strings.TrimLeft(la[si:i], "0")
			nb := strings.TrimLeft(lb[sj:j], "0")
			if na == "" {
				na = "0"
			}
			if nb == "" {
				nb = "0"
			}
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if la[i] != lb[j] {
			return la[i] < lb[j]
		}
		i++
		j++
	}
	if i == len(la) && j == len(lb) {
		// 数字相等但前导零数量不同时，短名（a1）排在长名（a01）前；
		// 其余情况用原字符串兜底，保证比较关系反对称且稳定
		if len(la) != len(lb) {
			return len(la) < len(lb)
		}
		if la == lb {
			return a < b
		}
		return la < lb
	}
	return i == len(la)
}

func sortStructureChildren(children []*structureNode) {
	sort.SliceStable(children, func(i, j int) bool {
		a, b := children[i], children[j]
		if a.isDir != b.isDir {
			return a.isDir
		}
		return naturalLess(a.name, b.name)
	})
}

// structureChildren 读取目录并递归；root 级错误返回给调用方，子级读取失败时跳过
func structureChildren(dir string) ([]*structureNode, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	children := make([]*structureNode, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if structureDirIgnored[name] {
			continue
		}
		isDir := entry.IsDir() && entry.Type()&os.ModeSymlink == 0
		node := &structureNode{name: name, isDir: isDir}
		if isDir {
			node.children, _ = structureChildren(filepath.Join(dir, name))
		}
		children = append(children, node)
	}
	sortStructureChildren(children)
	return children, nil
}

func writeStructureTree(b *strings.Builder, children []*structureNode, prefix string) {
	for i, child := range children {
		last := i == len(children)-1
		if last {
			b.WriteString(prefix)
			b.WriteString("└── ")
		} else {
			b.WriteString(prefix)
			b.WriteString("├── ")
		}
		b.WriteString(child.name)
		b.WriteByte('\n')
		if child.isDir && len(child.children) > 0 {
			nextPrefix := prefix
			if last {
				nextPrefix += "    "
			} else {
				nextPrefix += "│   "
			}
			writeStructureTree(b, child.children, nextPrefix)
		}
	}
}

func structureDirRoot(dir string) (string, string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", "", fmt.Errorf("没有目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("不是目录：%s", dir)
	}
	clean := filepath.Clean(dir)
	rootName := filepath.Base(clean)
	if rootName == "" || rootName == "." || rootName == string(filepath.Separator) {
		rootName = clean
	}
	return clean, rootName, nil
}

// StructureDir 生成当前目录的结构化文本（目录名在首行，子项用 ├──/└── 连接）
func (a *App) StructureDir(dir string) (string, error) {
	clean, rootName, err := structureDirRoot(dir)
	if err != nil {
		return "", err
	}
	children, err := structureChildren(clean)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString(rootName)
	b.WriteByte('\n')
	writeStructureTree(&b, children, "")
	return b.String(), nil
}

// ExportStructureDir 先弹出系统保存对话框选择导出路径，再生成并写入；
// 用户取消时返回空路径且不写文件。
func (a *App) ExportStructureDir(dir string) (string, error) {
	clean, rootName, err := structureDirRoot(dir)
	if err != nil {
		return "", err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "导出结构化目录",
		DefaultFilename: rootName + "-目录结构.txt",
		Filters: []runtime.FileFilter{
			{DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	text, err := a.StructureDir(clean)
	if err != nil {
		return "", err
	}
	if err := a.SaveFile(path, text, "lf", false, "utf-8"); err != nil {
		return "", err
	}
	return path, nil
}
