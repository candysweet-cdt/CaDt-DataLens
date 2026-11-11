package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// parseNotifyBuffer 解析 FILE_NOTIFY_INFORMATION 链，返回相对路径列表。
func parseNotifyBuffer(buf []byte, size uint32) ([]string, bool) {
	if size == 0 {
		// 缓冲区溢出：内核丢弃了后续事件，调用方应退化为全量刷新
		return nil, true
	}
	var paths []string
	offset := 0
	for offset+12 <= int(size) {
		next := binary.LittleEndian.Uint32(buf[offset:])
		nameLen := binary.LittleEndian.Uint32(buf[offset+8:])
		if offset+12+int(nameLen) > int(size) {
			break
		}
		nameUnits := unsafe.Slice((*uint16)(unsafe.Pointer(&buf[offset+12])), nameLen/2)
		name := windows.UTF16ToString(nameUnits)
		if name != "" {
			paths = append(paths, name)
		}
		if next == 0 {
			break
		}
		offset += int(next)
	}
	return paths, false
}

func watchDirectory(root string, stop <-chan struct{}, emit func(paths []string, overflow bool)) error {
	ptr, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(
		ptr,
		windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED,
		0,
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	event, err := windows.CreateEvent(nil, 0, 0, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(event)
	buf := make([]byte, 64*1024)
	var overlapped windows.Overlapped
	overlapped.HEvent = event
	for {
		select {
		case <-stop:
			return nil
		default:
		}
		var returned uint32
		err := windows.ReadDirectoryChanges(
			handle,
			&buf[0],
			uint32(len(buf)),
			true,
			windows.FILE_NOTIFY_CHANGE_FILE_NAME|
				windows.FILE_NOTIFY_CHANGE_DIR_NAME|
				windows.FILE_NOTIFY_CHANGE_LAST_WRITE|
				windows.FILE_NOTIFY_CHANGE_SIZE,
			&returned,
			&overlapped,
			0,
		)
		if err != nil && !errors.Is(err, windows.ERROR_IO_PENDING) {
			return fmt.Errorf("ReadDirectoryChanges %s: %w", filepath.Base(root), err)
		}
		for {
			status, waitErr := windows.WaitForSingleObject(event, 300)
			if waitErr != nil {
				return fmt.Errorf("等待目录通知失败：%w", waitErr)
			}
			if status == uint32(windows.WAIT_TIMEOUT) {
				select {
				case <-stop:
					_ = windows.CancelIoEx(handle, &overlapped)
					_ = windows.GetOverlappedResult(handle, &overlapped, &returned, true)
					return nil
				default:
					continue
				}
			}
			break
		}
		if err := windows.GetOverlappedResult(handle, &overlapped, &returned, false); err != nil {
			if errors.Is(err, windows.ERROR_NOTIFY_ENUM_DIR) {
				emit(nil, true)
				continue
			}
			if errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
				return nil
			}
			return fmt.Errorf("读取目录通知失败：%w", err)
		}
		paths, overflow := parseNotifyBuffer(buf, returned)
		if overflow {
			emit(nil, true)
			continue
		}
		if len(paths) > 0 {
			emit(paths, false)
		}
	}
}
