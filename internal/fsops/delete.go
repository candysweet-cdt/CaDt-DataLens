package fsops

// 删除条目：校验后送系统回收站，不做不可恢复的直删。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/recycle"
)

// DeleteEntry 把文件或目录移到回收站；不存在或非法路径返回错误。
func (f *FS) DeleteEntry(path string) error {
	return deleteEntry(path)
}

// DeleteEntryPermanent 彻底删除（shift+delete 语义）：不进回收站、不可恢复。
// AI delete_path 的 permanent 通道（模型传 permanent 且人工批准 / 用户在审批卡勾选
// 「彻底删除」）专用——调用前必须已过人工确认；校验与回收站删除同一套（拒根目录/
// 非普通文件/空字节）。大文件（超 wipeguard backupMaxBytes）没有快照兜底，这里就是
// 最后一道闸。平台无关：硬删语义全平台一致，不需要成对文件。
func (f *FS) DeleteEntryPermanent(path string) error {
	return deleteEntryWith(path, func(p string) error {
		return os.RemoveAll(p)
	})
}

// RemoveToRecycleBin 供非绑定调用方（存储清理）复用同一套校验与回收站动作。
func RemoveToRecycleBin(path string) error {
	return deleteEntry(path)
}

func deleteEntry(path string) error {
	return deleteEntryWith(path, recycle.Move)
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
