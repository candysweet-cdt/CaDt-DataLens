//go:build windows

package browser

import (
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

func handlerLive(ptr uintptr) bool {
	browserHandlerMu.Lock()
	_, ok := browserHandlerLive[ptr]
	browserHandlerMu.Unlock()
	return ok
}

// TestCDPHandlerRetainedUntilInvoke：ExecuteScript/CapturePreview 超时返回后，原生侧
// 仍可能晚到回调；handler 必须一直登记到回调到达，否则会写进已释放内存（use-after-free）。
func TestCDPHandlerRetainedUntilInvoke(t *testing.T) {
	h := newBrowserCDPHandler()
	ptr := uintptr(unsafe.Pointer(h))
	if !handlerLive(ptr) {
		t.Fatal("handler 创建后未登记：超时路径上会被 GC 回收")
	}
	browserCDPInvoke(ptr, 0, 0)
	if handlerLive(ptr) {
		t.Fatal("回调到达后仍留在登记表：会累积泄漏")
	}
	if atomic.LoadUint32(&h.done) != 1 {
		t.Fatal("done 标志未置位")
	}
	select {
	case r := <-h.resultCh:
		if r.errCode != 0 {
			t.Fatalf("errCode = %d，期望 0", r.errCode)
		}
	default:
		t.Fatal("回调结果未入队")
	}
}

// TestCaptureHandlerRetainedUntilInvoke：截图 handler 同上，且 errCode 透传。
func TestCaptureHandlerRetainedUntilInvoke(t *testing.T) {
	h := newBrowserCaptureHandler()
	ptr := uintptr(unsafe.Pointer(h))
	if !handlerLive(ptr) {
		t.Fatal("截图 handler 创建后未登记")
	}
	browserCaptureInvoke(ptr, 0x80004004)
	if handlerLive(ptr) {
		t.Fatal("截图回调到达后仍留在登记表")
	}
	if atomic.LoadUint32(&h.done) != 1 {
		t.Fatal("done 标志未置位")
	}
	if h.errCode != 0x80004004 {
		t.Fatalf("errCode = %#x，期望透传 0x80004004", h.errCode)
	}
}

// TestCDPHandlerInvokeTwiceNoBlock：重复派发只留第一份结果，且不阻塞原生回调。
func TestCDPHandlerInvokeTwiceNoBlock(t *testing.T) {
	h := newBrowserCDPHandler()
	ptr := uintptr(unsafe.Pointer(h))
	browserCDPInvoke(ptr, 0, 0)
	browserCDPInvoke(ptr, 0, 0)
	if n := len(h.resultCh); n != 1 {
		t.Fatalf("resultCh 长度 = %d，期望 1（重复结果丢弃）", n)
	}
}

// TestCaptureScreenshotNilWebview：句柄为空必须返回错误而不是空指针解引用。
// wvProc 里是 (*wvRaw)(unsafe.Pointer(wv)).vtbl[slot]，wv=nil 就是直接 panic，
// 而这条路径跑在宿主线程任务里、外面没有 guardCallback，panic 会带走整个进程。
func TestCaptureScreenshotNilWebview(t *testing.T) {
	if _, err := wvCaptureScreenshot(nil, time.Second); err == nil {
		t.Fatal("webview 为 nil 时应返回错误")
	}
}
