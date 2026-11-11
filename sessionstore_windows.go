//go:build windows

package main

import "golang.org/x/sys/windows"

// replaceFileAtomic 用 MoveFileExW 原子替换目标文件；不支持跨卷回退。
func replaceFileAtomic(tmp, dst string) error {
	from, err := windows.UTF16PtrFromString(tmp)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
