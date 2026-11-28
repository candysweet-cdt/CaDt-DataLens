//go:build windows

package fsops

// DeleteEntryRecycle 删除条目（AI delete_path 工具专用）：与 DeleteEntry 同一套校验，
// 一律进系统回收站、不做不可恢复直删。独立于 DeleteEntry 存在是为了把「AI 删除必须
// 可恢复」做成跨平台不变量——非 Windows 的 recycle.Move 是硬删桩（recycle_other.go），
// AI 工具在那些平台必须拒绝而不是悄悄退化成不可恢复删除（见 delete_platform_other.go）。
func (f *FS) DeleteEntryRecycle(path string) error {
	return deleteEntry(path)
}
