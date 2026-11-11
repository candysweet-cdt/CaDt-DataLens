//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// lockAISessionFile 用 flock(2) 对锁文件加独占锁；进程退出时内核自动释放。
func lockAISessionFile(path string, timeout time.Duration) (*aiSessionFileLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	fd := int(f.Fd())
	deadline := time.Now().Add(timeout)
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return &aiSessionFileLock{release: func() {
				_ = syscall.Flock(fd, syscall.LOCK_UN)
				_ = f.Close()
			}}, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			_ = f.Close()
			return nil, err
		}
		if time.Now().After(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("等待会话写锁超时")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
