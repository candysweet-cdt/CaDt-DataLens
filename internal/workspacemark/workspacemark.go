// Package workspacemark：进程级「这个工作区本轮已经打开过」账本。
//
// 为什么必须在 Go 侧：同一工作区在一次运行内有些重活只该跑一次（open 钩子、首次
// git status、首次 wipe-guard 指纹基线）。放在前端 Map 里等于每个窗口各记一份——
// harness / 多窗口下同一工作区被两个窗口打开，重活就会各跑一遍。
//
// 键按 windowreg.PathKey 归一（D:\ws 与 d:/ws/ 视为同一个），与前端 sessionPathKey 同口径。
package workspacemark

import (
	"strings"
	"sync"

	"datalens/internal/windowreg"
)

var (
	mu     sync.Mutex
	opened = map[string]bool{}
)

// MarkOpened 首次见到该工作区返回 true（调用方据此跑重活），之后再见到返回 false。
// dir 为空时返回 false（没有工作区，没有重活可跑）。
func MarkOpened(dir string) bool {
	key := windowreg.PathKey(strings.TrimSpace(dir))
	if key == "" {
		return false
	}
	mu.Lock()
	defer mu.Unlock()
	if opened[key] {
		return false
	}
	opened[key] = true
	return true
}

// Reset 清空账本。只给测试用；刻意不暴露成绑定——「手动刷新要不要重跑重活」是
// 交互决策，等真有人需要再加，别提前开一个能让前端把重活全量重放的入口。
func Reset() {
	mu.Lock()
	opened = map[string]bool{}
	mu.Unlock()
}
