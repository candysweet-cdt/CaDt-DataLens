//go:build !windows

package main

import "os"

// replaceFileAtomic 同目录 os.Rename 在 POSIX 上即原子替换。
func replaceFileAtomic(tmp, dst string) error {
	return os.Rename(tmp, dst)
}
