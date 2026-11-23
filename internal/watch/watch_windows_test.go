package watch

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func writeNotifyEntry(buf []byte, offset int, next uint32, name string, action uint32) int {
	units := utf16Encode(name)
	nameLen := len(units) * 2
	binary.LittleEndian.PutUint32(buf[offset:], next)
	binary.LittleEndian.PutUint32(buf[offset+4:], action)
	binary.LittleEndian.PutUint32(buf[offset+8:], uint32(nameLen))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[offset+12+i*2:], u)
	}
	return offset + 12 + nameLen
}

func utf16Encode(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

func TestParseNotifyBuffer(t *testing.T) {
	buf := make([]byte, 512)
	firstLen := 12 + len(utf16Encode("a.txt"))*2
	next := writeNotifyEntry(buf, 0, uint32(firstLen), "a.txt", syscall.FILE_ACTION_ADDED)
	next = writeNotifyEntry(buf, next, 0, "子目录\\b.json", syscall.FILE_ACTION_MODIFIED)
	events, overflow := parseNotifyBuffer(buf, uint32(next))
	if overflow {
		t.Fatal("unexpected overflow")
	}
	if len(events) != 2 || events[0].Path != "a.txt" || events[1].Path != "子目录\\b.json" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].Removed || events[1].Removed {
		t.Fatalf("added/modified 不应标记 Removed: %#v", events)
	}
	if _, overflow := parseNotifyBuffer(nil, 0); !overflow {
		t.Fatal("zero-size batch should mark overflow")
	}
}

// TestParseNotifyBufferRemoved 「消失」类动作标 Removed=true——wipe-guard 的删除计数只认这组
// （方案 §5.1）。rename 要分成两类：成对的 OLD_NAME + NEW_NAME 是工作区内部改名/移动
// （批量重命名不是文件消失），孤立的 OLD_NAME 才是「移出工作区」。
func TestParseNotifyBufferRemoved(t *testing.T) {
	buf := make([]byte, 512)
	a := 12 + len(utf16Encode("gone.txt"))*2
	b := 12 + len(utf16Encode("moved-away.txt"))*2
	c := 12 + len(utf16Encode("renamed-in.txt"))*2
	next := writeNotifyEntry(buf, 0, uint32(a), "gone.txt", syscall.FILE_ACTION_REMOVED)
	next = writeNotifyEntry(buf, next, uint32(b), "moved-away.txt", syscall.FILE_ACTION_RENAMED_OLD_NAME)
	next = writeNotifyEntry(buf, next, uint32(c), "renamed-in.txt", syscall.FILE_ACTION_RENAMED_NEW_NAME)
	events, _ := parseNotifyBuffer(buf, uint32(next))
	if len(events) != 3 {
		t.Fatalf("unexpected events: %#v", events)
	}
	if !events[0].Removed {
		t.Fatalf("删除了的文件应标记 Removed: %#v", events)
	}
	if events[1].Removed {
		t.Fatalf("成对 rename 是工作区内移动，不该算消失: %#v", events)
	}
	if events[2].Removed {
		t.Fatalf("renamed_new 是「出现」不是消失: %#v", events)
	}
}

// 孤立 RENAMED_OLD_NAME（目标在监听根之外，内核不报 NEW_NAME）= 文件被移出工作区，算消失。
func TestParseNotifyBufferOrphanRename(t *testing.T) {
	buf := make([]byte, 512)
	first := 12 + len(utf16Encode("moved-out.txt"))*2
	next := writeNotifyEntry(buf, 0, uint32(first), "moved-out.txt", syscall.FILE_ACTION_RENAMED_OLD_NAME)
	// 下一条不是 NEW_NAME：不构成配对
	next = writeNotifyEntry(buf, next, 0, "deleted.txt", syscall.FILE_ACTION_REMOVED)
	events, _ := parseNotifyBuffer(buf, uint32(next))
	if len(events) != 2 {
		t.Fatalf("unexpected events: %#v", events)
	}
	if !events[0].Removed {
		t.Fatalf("移出工作区的 rename 应算消失: %#v", events)
	}
	if !events[1].Removed {
		t.Fatalf("removed 应标记 Removed: %#v", events)
	}
	// 末尾孤立 OLD_NAME（批内没有 NEW_NAME 跟着）
	buf2 := make([]byte, 256)
	only := 12 + len(utf16Encode("last-moved-out.txt"))*2
	writeNotifyEntry(buf2, 0, 0, "last-moved-out.txt", syscall.FILE_ACTION_RENAMED_OLD_NAME)
	events2, _ := parseNotifyBuffer(buf2, uint32(only))
	if len(events2) != 1 || !events2[0].Removed {
		t.Fatalf("批尾孤立 rename 应算消失: %#v", events2)
	}
}

func TestWatchDirectoryReceivesCreate(t *testing.T) {
	dir := t.TempDir()
	stop := make(chan struct{})
	done := make(chan struct{})
	events := make(chan string, 8)
	go func() {
		defer close(done)
		_ = watchDirectory(dir, stop, func(list []watchEvent, overflow bool) {
			for _, e := range list {
				select {
				case events <- e.Path:
				default:
				}
			}
		})
	}()
	defer func() {
		close(stop)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("watcher did not stop")
		}
	}()
	time.Sleep(150 * time.Millisecond)
	target := filepath.Join(dir, "new-file.txt")
	if err := os.WriteFile(target, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(4 * time.Second)
	for {
		select {
		case name := <-events:
			if strings.Contains(name, "new-file.txt") {
				return
			}
		case <-deadline:
			t.Fatal("did not receive file creation notification")
		}
	}
}

// 关窗/换根时每个监听槽都要同步等 goroutine 退出（stopLocked / stopSlotLocked 串行
// `<-done`）。旧实现靠 WaitForSingleObject(event, 300) 轮询 stop 通道才发现该退出，
// 实测每次 200~300ms，几个槽叠起来就是用户能察觉的「点了 X 窗口要停一下才消失」
// （2026-11-23 日志实测钩子内 806/855ms）。stop 现在走独立内核事件，应当即时唤醒。
func TestWatchDirectoryStopIsPrompt(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		stop := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = watchDirectory(dir, stop, func([]watchEvent, bool) {})
		}()
		time.Sleep(80 * time.Millisecond) // 等它进入读循环、挂起 ReadDirectoryChanges
		start := time.Now()
		close(stop)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("第 %d 次停止超时：watcher 未退出", i+1)
		}
		// 150ms 上限：轮询实现下界就在 200ms 以上，事件唤醒下实际是亚毫秒级，
		// 留够调度抖动的余量又不至于让回归悄悄通过。
		if elapsed := time.Since(start); elapsed > 150*time.Millisecond {
			t.Fatalf("第 %d 次停止耗时 %v，超过 150ms（stop 应即时唤醒）", i+1, elapsed)
		}
	}
}

// 静默门接线验证（2026-11-19 插件更新误报实录）：插件安装 / 更新 / 卸载期间
// workspace-changed 照常推 paths（UI 要刷新），但 removed / present 两个判定分组为空，
// 破坏判定不会把这些应用自己发起的整目录增删当成大范围文件消失。
func TestWatchWorkspaceQuietGateDropsRemovedGroup(t *testing.T) {
	oldGrace := quietGraceDuration
	quietGraceDuration = 0
	t.Cleanup(func() {
		quietGraceDuration = oldGrace
		quietDepth.Store(0)
		quietUntil.Store(0)
	})

	root := t.TempDir()
	for i := 0; i < 60; i++ {
		name := filepath.Join(root, "f"+strconv.Itoa(i)+".txt")
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	var mu sync.Mutex
	var paths, removed int
	oldEmit := Emit
	Emit = func(event string, data any) {
		if event != "workspace-changed" {
			return
		}
		m, ok := data.(map[string]interface{})
		if !ok {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if list, ok := m["paths"].([]string); ok {
			paths += len(list)
		}
		if list, ok := m["removed"].([]string); ok {
			removed += len(list)
		}
	}
	t.Cleanup(func() { Emit = oldEmit })

	w := &Watcher{}
	if err := w.WatchWorkspaceFor("main", root); err != nil {
		t.Fatalf("WatchWorkspaceFor: %v", err)
	}
	defer func() { w.UnwatchWorkspaceFor("main") }()
	time.Sleep(300 * time.Millisecond) // 等 watcher 进入读循环

	BeginQuiet()
	for i := 0; i < 60; i++ {
		_ = os.Remove(filepath.Join(root, "f"+strconv.Itoa(i)+".txt"))
	}
	time.Sleep(900 * time.Millisecond) // 等内核通知读出
	EndQuiet()

	mu.Lock()
	gotPaths, gotRemoved := paths, removed
	mu.Unlock()
	if gotPaths == 0 {
		t.Fatal("静默期也应有 paths 推送（UI 需要刷新）")
	}
	if gotRemoved != 0 {
		t.Fatalf("静默期不应有 removed 计数，实际 %d", gotRemoved)
	}

	// 静默解除后恢复正常计数：证明不是永久静默
	for i := 0; i < 5; i++ {
		name := filepath.Join(root, "g"+strconv.Itoa(i)+".txt")
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(300 * time.Millisecond)
	for i := 0; i < 5; i++ {
		_ = os.Remove(filepath.Join(root, "g"+strconv.Itoa(i)+".txt"))
	}
	time.Sleep(600 * time.Millisecond)

	mu.Lock()
	gotRemoved = removed
	mu.Unlock()
	if gotRemoved == 0 {
		t.Fatal("静默解除后应恢复 removed 计数")
	}
}
