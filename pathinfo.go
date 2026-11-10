package main

import (
	"fmt"
	"os"
	"strings"
)

type PathInfo struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	ReadOnly bool   `json:"readOnly"`
}

// GetPathInfo 返回文件属性对话框需要的信息；修改时间为 Unix 毫秒。
func (a *App) GetPathInfo(path string) (*PathInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &PathInfo{
		Path:     path,
		Name:     info.Name(),
		IsDir:    info.IsDir(),
		Size:     info.Size(),
		Modified: info.ModTime().UnixMilli(),
		ReadOnly: info.Mode().Perm()&0o200 == 0,
	}, nil
}
