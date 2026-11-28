//go:build windows

package fsops

// isReparsePoint 的 Windows 实现（junction / 符号链接，按 ReparseTag 精确判定）。
// 与 gitinfo/worktree_platform_windows.go 同源——那边面向「删除前清扫」、这边面向
// 「写入前拦截」，语义一致但调用方不同；第三处消费者出现时再下沉 winutil。

import (
	"errors"
	"io/fs"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileAttributeTagInfo 是 FILE_INFO_BY_HANDLE_CLASS.FileAttributeTagInfo 的输出布局。
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// fsCaseInsensitiveFS 当前平台的文件系统比较是否按大小写不敏感处理。
// Windows：不区分大小写（NTFS/FAT 语义），路径比对一律小写归一。
func fsCaseInsensitiveFS() bool { return true }

// isReparsePoint 判断路径是否为 junction / 符号链接（只认「名称代理」两类重解析点）。
// os.Lstat 在 Windows 对 junction 不报 ModeSymlink（实测 mode 显示 ?---------），必须查
// 文件属性里的 FILE_ATTRIBUTE_REPARSE_POINT；但该属性也覆盖 OneDrive 云占位符、去重
// （DEDUP）、ProjFS/GVFS 等——它们不是链接，当成链接会对正常路径误拒。因此按 ReparseTag
// 精确判定（MOUNT_POINT = junction，SYMLINK = 符号链接）。
// 读不到属性（ACL / 共享冲突）：保守当成链接，写入判定 fail-closed，
// 绝不能把「可能有链接」的路径放进可写范围。
func isReparsePoint(path string) bool {
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(
		p16,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false
		}
		return true
	}
	defer windows.CloseHandle(h)
	var info fileAttributeTagInfo
	if err := windows.GetFileInformationByHandleEx(
		h,
		windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		return true
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return false
	}
	return info.ReparseTag == windows.IO_REPARSE_TAG_MOUNT_POINT ||
		info.ReparseTag == windows.IO_REPARSE_TAG_SYMLINK
}
