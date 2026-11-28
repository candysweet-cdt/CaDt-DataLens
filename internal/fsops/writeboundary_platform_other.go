//go:build !windows

package fsops

import "os"

// fsCaseInsensitiveFS 非 Windows 平台按大小写敏感比较：Linux 文件系统区分大小写
// （/a/b 与 /A/B 是两个目录）；macOS 默认 APFS 不区分，但这里选大小写敏感——
// 偏差方向是 fail-closed（大小写变体宁可误拒不误放），产品当前仅面向 Windows。
func fsCaseInsensitiveFS() bool { return false }

// isReparsePoint 非 Windows 的等价物是符号链接（没有 junction；目录联接是 Windows 专属）。
func isReparsePoint(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}
