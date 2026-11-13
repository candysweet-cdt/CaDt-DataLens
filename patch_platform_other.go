//go:build !windows

package main

import (
	"os"
	"time"
)

// diskFreeBytes 在非 Windows 平台不做预检，交给写入时的错误。
func diskFreeBytes(dir string) (uint64, error) {
	if dir == "" {
		return 0, os.ErrInvalid
	}
	return 0, os.ErrNotExist
}

// lockPatchWorkspace 非 Windows 平台暂不做跨进程锁（主发布目标是 Windows）。
func lockPatchWorkspace(root string, timeout time.Duration) (func(), error) {
	return func() {}, nil
}

func openExclusiveProbe(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return f.Close()
}

// patchStdoutUsable 非 Windows 平台默认标准输出可用。
func patchStdoutUsable() bool { return true }
