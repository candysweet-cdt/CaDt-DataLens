package watch

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Supported 报告当前平台是否有可用的目录监听实现。注册前先查它，
// 不要靠 Watch 的返回值判断——不支持平台上 Watch 绑定仍返回 nil（goroutine 内仅记 warn）。
func Supported() bool { return true }

func parseNotifyBuffer(buf []byte, size uint32) ([]watchEvent, bool) {
	if size == 0 {
		// 缓冲区溢出：内核丢弃了后续事件，调用方应退化为全量刷新
		return nil, true
	}
	type rawNotify struct {
		name   string
		action uint32
	}
	var raw []rawNotify
	offset := 0
	for offset+12 <= int(size) {
		next := binary.LittleEndian.Uint32(buf[offset:])
		action := binary.LittleEndian.Uint32(buf[offset+4:])
		nameLen := binary.LittleEndian.Uint32(buf[offset+8:])
		if offset+12+int(nameLen) > int(size) {
			break
		}
		nameUnits := unsafe.Slice((*uint16)(unsafe.Pointer(&buf[offset+12])), nameLen/2)
		name := windows.UTF16ToString(nameUnits)
		if name != "" {
			raw = append(raw, rawNotify{name: name, action: action})
		}
		if next == 0 {
			break
		}
		offset += int(next)
	}
	events := make([]watchEvent, 0, len(raw))
	for i, item := range raw {
		removed := item.action == syscall.FILE_ACTION_REMOVED
		if item.action == syscall.FILE_ACTION_RENAMED_OLD_NAME {
			// 改名/移动的**成对**通知（OLD_NAME 紧跟 NEW_NAME）说明目标仍在监听根内——
			// 这是工作区内部的重命名或挪目录（批量重命名、`git mv`、拖拽归位），文件
			// 没有离开工作区，不该计入「消失」。移出工作区的移动只会收到 OLD_NAME
			// （目标在监听根之外，内核不报 NEW_NAME），仍按消失计。
			paired := i+1 < len(raw) && raw[i+1].action == syscall.FILE_ACTION_RENAMED_NEW_NAME
			removed = !paired
		}
		events = append(events, watchEvent{Path: item.name, Removed: removed})
	}
	return events, false
}

const (
	// watchStopSignalIndex stop 事件在等待句柄数组里的下标（0 是目录通知事件）。
	watchStopSignalIndex = 1
	// watchWaitPollMillis 兜底轮询周期。stop 关闭后由独立的内核事件立刻唤醒等待，
	// 这个超时只剩「SetEvent 万一失败也不至于永久卡死」的保险丝作用。
	watchWaitPollMillis = 300
)

func watchDirectory(root string, stop <-chan struct{}, emit func(events []watchEvent, overflow bool)) error {
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
	// stop 通道翻译成手动复位的内核事件：原来只能靠 300ms 轮询才发现「该退了」，
	// 而关窗路径上每个监听槽都要同步等 goroutine 退出（见 ResourceWatcher.stopLocked /
	// Watcher.stopSlotLocked），实测每次 200~300ms，几个槽叠起来就是「点了 X 窗口
	// 要停一下才消失」。改成事件唤醒后取消是即时的。
	stopEvent, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(stopEvent)
	exited := make(chan struct{})
	stopWatchDone := make(chan struct{})
	go func() {
		defer close(stopWatchDone)
		select {
		case <-stop:
			_ = windows.SetEvent(stopEvent)
		case <-exited:
		}
	}()
	defer func() {
		// 先让桥接 goroutine 退出再关 stopEvent 句柄，避免 SetEvent 撞上 CloseHandle。
		close(exited)
		<-stopWatchDone
	}()
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
		// 目录通知与 stop 谁先到听谁的：stop 侧走取消挂起读的收尾路径。
		for {
			wake, waitErr := windows.WaitForMultipleObjects(
				[]windows.Handle{event, stopEvent}, false, watchWaitPollMillis)
			if waitErr != nil {
				return fmt.Errorf("等待目录通知失败：%w", waitErr)
			}
			if wake == watchStopSignalIndex {
				_ = windows.CancelIoEx(handle, &overlapped)
				_ = windows.GetOverlappedResult(handle, &overlapped, &returned, true)
				return nil
			}
			if wake == uint32(windows.WAIT_TIMEOUT) {
				continue // 保险丝：回到内层重新等（此时挂起读仍然有效）
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
		events, overflow := parseNotifyBuffer(buf, returned)
		if overflow {
			emit(nil, true)
			continue
		}
		if len(events) > 0 {
			emit(events, false)
		}
	}
}
