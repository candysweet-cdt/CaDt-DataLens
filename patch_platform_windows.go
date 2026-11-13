//go:build windows

package main

import (
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
)

// diskFreeBytes 返回目录所在卷的可用空间。
func diskFreeBytes(dir string) (uint64, error) {
	if dir == "" {
		return 0, os.ErrInvalid
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, err
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree); err != nil {
		return 0, err
	}
	return free, nil
}

// lockPatchWorkspace 用锁文件把「同一工作区的补丁写入」串行化（跨进程）。
// 锁文件固定放在 .cadt/patches/.lock，进程退出由内核释放。
func lockPatchWorkspace(root string, timeout time.Duration) (func(), error) {
	dir := filepath.Join(root, ".cadt", "patches")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	lockPath := filepath.Join(dir, ".lock")
	name, err := windows.UTF16PtrFromString(lockPath)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		name,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		overlapped := new(windows.Overlapped)
		err = windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped)
		if err == nil {
			return func() {
				_ = windows.UnlockFileEx(handle, 0, 1, 0, new(windows.Overlapped))
				_ = windows.CloseHandle(handle)
			}, nil
		}
		if time.Now().After(deadline) {
			_ = windows.CloseHandle(handle)
			return nil, err
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// openExclusiveProbe 探测目标是否被其他程序独占：拿不到读共享就说明被锁住。
func openExclusiveProbe(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(
		name,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return err
	}
	return windows.CloseHandle(h)
}

// patchStdoutUsable 判断标准输出句柄是否可用：GUI 子系统进程从某些 shell 启动时，
// STD_OUTPUT_HANDLE 可能指向一个 wFile 类型未知的句柄，写入会静默失败。
func patchStdoutUsable() bool {
	h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil || h == 0 || h == windows.InvalidHandle {
		return false
	}
	t, err := windows.GetFileType(h)
	if err != nil {
		return false
	}
	return t != windows.FILE_TYPE_UNKNOWN
}
