package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// WatchWorkspace 递归监听工作区，变化时通过 workspace-changed 事件推给前端；
// 监听失败时前端仍保留轮询兜底。
func (a *App) WatchWorkspace(root string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		a.stopWorkspaceWatch()
		return nil
	}
	info, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是目录：%s", root)
	}
	a.watchMu.Lock()
	a.stopWatcherLocked()
	stop := make(chan struct{})
	done := make(chan struct{})
	a.watchRoot = root
	a.watchStop = stop
	a.watchDone = done
	a.watchMu.Unlock()
	writeAppLog("info", "文件监听：%s", root)
	go func() {
		defer close(done)
		err := watchDirectory(root, stop, func(paths []string, overflow bool) {
			if a.ctx == nil {
				return
			}
			runtime.EventsEmit(a.ctx, "workspace-changed", map[string]interface{}{
				"root":     root,
				"paths":    paths,
				"overflow": overflow,
			})
		})
		if err != nil && a.ctx != nil {
			writeAppLog("warn", "文件监听已停止（%s）：%v", root, err)
		}
	}()
	return nil
}

func (a *App) UnwatchWorkspace() {
	a.stopWorkspaceWatch()
}

func (a *App) stopWorkspaceWatch() {
	a.watchMu.Lock()
	defer a.watchMu.Unlock()
	a.stopWatcherLocked()
}

func (a *App) stopWatcherLocked() {
	if a.watchStop == nil {
		return
	}
	close(a.watchStop)
	a.watchStop = nil
	done := a.watchDone
	a.watchDone = nil
	a.watchRoot = ""
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}
