//go:build !windows

package fsops

import "errors"

// DeleteEntryRecycle 非 Windows 平台没有系统回收站（recycle.Move 是 os.RemoveAll
// 硬删桩），AI 的 delete_path 工具依赖「删除可恢复」这一不变量——直接拒绝，
// 不允许悄悄退化成不可恢复删除。
func (f *FS) DeleteEntryRecycle(path string) error {
	return errors.New("回收站删除仅支持 Windows 平台：当前系统没有可恢复的删除通道")
}
