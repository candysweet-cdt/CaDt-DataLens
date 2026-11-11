//go:build windows

package main

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// lockAISessionFile 用 LockFileEx 对锁文件首字节加独占锁；进程退出时内核自动释放。
// 锁文件以 FILE_SHARE_DELETE 打开，删除会话目录不会被阻塞。
func lockAISessionFile(path string, timeout time.Duration) (*aiSessionFileLock, error) {
	name, err := windows.UTF16PtrFromString(path)
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
		err = windows.LockFileEx(
			handle,
			windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
			0, 1, 0, overlapped,
		)
		if err == nil {
			return &aiSessionFileLock{release: func() {
				_ = windows.UnlockFileEx(handle, 0, 1, 0, overlapped)
				_ = windows.CloseHandle(handle)
			}}, nil
		}
		if err != windows.ERROR_LOCK_VIOLATION {
			_ = windows.CloseHandle(handle)
			return nil, err
		}
		if time.Now().After(deadline) {
			_ = windows.CloseHandle(handle)
			return nil, fmt.Errorf("等待会话写锁超时")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
