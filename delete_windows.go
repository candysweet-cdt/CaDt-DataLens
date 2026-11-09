//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	foDelete          = 0x0003
	fofAllowUndo      = 0x0040 // 移到回收站
	fofNoConfirmation = 0x0010
	fofNoErrorUI      = 0x0400
)

// SHFILEOPSTRUCTW 的字段顺序和宽度与 Windows Shell API 保持一致。
type shFileOpStructW struct {
	hwnd                 uintptr
	funcCode             uint32
	from                 *uint16
	to                   *uint16
	flags                uint16
	anyOperationsAborted int32
	nameMappings         uintptr
	progressTitle        *uint16
}

var shFileOperationW = windows.NewLazySystemDLL("shell32.dll").NewProc("SHFileOperationW")

// movePathToRecycleBin 调用 Windows Shell 的删除接口，默认送回收站。
func movePathToRecycleBin(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	from, err := windows.UTF16FromString(abs)
	if err != nil {
		return err
	}
	// pFrom 必须以双 NUL 结尾
	from = append(from, 0)
	op := shFileOpStructW{
		funcCode: foDelete,
		from:     &from[0],
		flags:    fofAllowUndo | fofNoConfirmation | fofNoErrorUI,
	}
	ret, _, _ := shFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if ret != 0 {
		return fmt.Errorf("移到回收站失败（错误码 0x%X）", ret)
	}
	if op.anyOperationsAborted != 0 {
		return fmt.Errorf("删除已取消")
	}
	return nil
}
