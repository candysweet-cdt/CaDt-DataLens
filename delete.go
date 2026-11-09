package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DeleteEntry 把文件或目录移到回收站；不存在或非法路径返回错误。
func (a *App) DeleteEntry(path string) error {
	return deleteEntry(path)
}

func deleteEntry(path string) error {
	return deleteEntryWith(path, movePathToRecycleBin)
}

// deleteEntryWith 抽出删除前的路径校验，便于测试替换实际删除动作。
func deleteEntryWith(path string, remove func(string) error) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("没有文件路径")
	}
	if strings.ContainsRune(path, 0) {
		return fmt.Errorf("路径包含非法字符")
	}
	clean := filepath.Clean(path)
	// 盘符根目录（C:\）和当前目录（.）的父目录等于自身；前者拒绝，后者 os.Stat 会失败
	if filepath.Dir(clean) == clean {
		return fmt.Errorf("不能删除根目录：%s", clean)
	}
	info, err := os.Stat(clean)
	if err != nil {
		return err
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return fmt.Errorf("不支持删除该类型：%s", clean)
	}
	return remove(clean)
}
