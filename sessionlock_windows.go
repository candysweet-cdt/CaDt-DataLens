//go:build windows

package main

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// lockOpenRace 判断打开锁文件时遇到的是不是瞬时竞态。
//
// 多个进程 / 协程在同一瞬间抢建同一个锁文件时，CreateFile 可能返回
// ERROR_ACCESS_DENIED（文件正在被创建 / 正被其他句柄打开时的临时拒绝）
// 或 ERROR_SHARING_VIOLATION；二者都不是真错误，等一会重试即可。
func lockOpenRace(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}

// lockAISessionFile 用 LockFileEx 对锁文件首字节加独占锁；进程退出时内核自动释放。
// 锁文件以 FILE_SHARE_DELETE 打开，删除会话目录不会被阻塞。
//
// CreateFile 与 LockFileEx 都在重试循环内：并发抢同一把锁时，前者会瞬时返回
// ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION，后者返回 ERROR_LOCK_VIOLATION，
// 三种都等到 deadline 再放弃，而不是首次失败就报错（否则多窗口同时写操作记录 /
// 会话会偶发「正被其他窗口写入：Access is denied」）。
func lockAISessionFile(path string, timeout time.Duration) (*aiSessionFileLock, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		handle, openErr := windows.CreateFile(
			name,
			windows.GENERIC_READ|windows.GENERIC_WRITE,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil,
			windows.OPEN_ALWAYS,
			windows.FILE_ATTRIBUTE_NORMAL,
			0,
		)
		if openErr == nil {
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
			_ = windows.CloseHandle(handle)
			if err != windows.ERROR_LOCK_VIOLATION && !lockOpenRace(err) {
				return nil, err
			}
		} else if !lockOpenRace(openErr) {
			return nil, openErr
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("等待会话写锁超时")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
