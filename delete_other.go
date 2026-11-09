//go:build !windows

package main

import "os"

// 非 Windows 平台没有回收站，直接删除。
func movePathToRecycleBin(path string) error {
	return os.RemoveAll(path)
}
