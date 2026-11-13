//go:build windows

package main

import (
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestLockAISessionFileConcurrentAcquire 并发抢同一把锁：全部请求都应最终成功，
// 且同一时刻只有一个持有者。
//
// 回归点：CreateFile 在抢建阶段会瞬时返回 ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION，
// 旧实现只重试 LockFileEx，首个 CreateFile 失败就直接返回，表现为
// 「操作记录正被其他窗口写入：Access is denied」。
func TestLockAISessionFileConcurrentAcquire(t *testing.T) {
	path := filepath.Join(t.TempDir(), aiSessionLockName)
	const workers = 6
	const rounds = 10

	var holders int32
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	overlap := make(chan string, workers)

	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < rounds; j++ {
				l, err := lockAISessionFile(path, 2*time.Second)
				if err != nil {
					errs <- err
					return
				}
				if n := atomic.AddInt32(&holders, 1); n != 1 {
					select {
					case overlap <- "同一时刻有多个持有者":
					default:
					}
				}
				atomic.AddInt32(&holders, -1)
				l.release()
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	close(overlap)

	for err := range errs {
		t.Fatalf("并发加锁失败：%v", err)
	}
	for msg := range overlap {
		t.Fatal(msg)
	}
}
