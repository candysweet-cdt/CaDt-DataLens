package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// 独立调试控制台窗口：
// 主窗口把调试日志批量追加到 appdata 下的 debug-console.jsonl，
// 独立窗口（另一进程，带 --debug-console 启动）轮询读取该文件实现实时同步。
// 两个窗口互不阻塞，独立窗口关闭不影响主窗口。

const (
	debugConsoleLogName = "debug-console.jsonl"
	debugConsoleMaxSize = 4 << 20 // 超过后裁剪，保留尾部 1MB
	debugConsoleKeep    = 1 << 20
	debugConsoleTail    = 256 << 10 // 独立窗口首次读取的历史长度
	debugConsoleMaxRead = 1 << 20   // 单次读取上限
)

var debugConsoleMu sync.Mutex

// DebugConsoleEntry 一条控制台日志（字段名短，减小文件体积）。
type DebugConsoleEntry struct {
	Time    string `json:"t"`
	Level   string `json:"lv"`
	Message string `json:"msg"`
}

// DebugConsoleChunk 增量读取结果：Offset 是下次读取位置，Data 只包含完整行。
type DebugConsoleChunk struct {
	Offset int64  `json:"offset"`
	Data   string `json:"data"`
}

func debugConsoleLogPath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, debugConsoleLogName)
}

func hasArg(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}

// ExportDebugConsoleLog 弹出保存对话框并写出调试控制台日志文本；
// 用户取消时返回空路径且不写文件。
func (a *App) ExportDebugConsoleLog(defaultName, content string) (string, error) {
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "debug-console.log"
	}
	path, err := a.ShowSaveFileDialog("导出调试控制台日志", name, "log")
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := a.SaveFile(path, content, "lf", false, "utf-8"); err != nil {
		return "", err
	}
	return path, nil
}

// IsDebugConsoleWindow 当前进程是否作为独立调试控制台窗口运行。
func (a *App) IsDebugConsoleWindow() bool {
	return hasArg("--debug-console")
}

// OpenDebugConsoleWindow 以独立进程方式打开调试控制台窗口。
// 带 --new-window 让新实例使用独立单实例锁，从而真正开出新窗口。
func (a *App) OpenDebugConsoleWindow() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--new-window", "--debug-console")
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// DebugConsoleAppend 追加一批日志（主窗口调用，失败不影响业务）。
func (a *App) DebugConsoleAppend(entries []DebugConsoleEntry) error {
	if len(entries) == 0 {
		return nil
	}
	path := debugConsoleLogPath()
	if path == "" {
		return errors.New("找不到应用数据目录")
	}
	debugConsoleMu.Lock()
	defer debugConsoleMu.Unlock()
	if fi, err := os.Stat(path); err == nil && fi.Size() > debugConsoleMaxSize {
		trimDebugConsoleLog(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for _, e := range entries {
		if e.Time == "" || e.Level == "" {
			continue
		}
		if len(e.Message) > 16000 {
			e.Message = e.Message[:16000] + "…"
		}
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

// DebugConsoleRead 从 offset 处增量读取；offset < 0 表示从尾部历史开始。
func (a *App) DebugConsoleRead(offset int64) (DebugConsoleChunk, error) {
	path := debugConsoleLogPath()
	if path == "" {
		return DebugConsoleChunk{Offset: 0}, nil
	}
	debugConsoleMu.Lock()
	defer debugConsoleMu.Unlock()
	f, err := os.Open(path)
	if err != nil {
		return DebugConsoleChunk{Offset: 0}, nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return DebugConsoleChunk{Offset: 0}, nil
	}
	size := fi.Size()
	alignHead := false
	if offset < 0 {
		offset = size - debugConsoleTail
		if offset < 0 {
			offset = 0
		}
		alignHead = offset > 0
	}
	if offset > size { // 文件被裁剪或重建
		offset = 0
		alignHead = false
	}
	if offset == size {
		return DebugConsoleChunk{Offset: offset}, nil
	}
	n := size - offset
	if n > debugConsoleMaxRead {
		n = debugConsoleMaxRead
	}
	buf := make([]byte, n)
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return DebugConsoleChunk{Offset: offset}, nil
	}
	read, _ := io.ReadFull(f, buf)
	data := string(buf[:read])
	consumed := 0
	if alignHead {
		idx := strings.IndexByte(data, '\n')
		if idx < 0 {
			// 罕见：整块没有换行，丢弃这半行继续等新数据
			return DebugConsoleChunk{Offset: offset + int64(len(data))}, nil
		}
		consumed = idx + 1
	}
	rest := data[consumed:]
	// 只返回完整行，半行留给下一次
	if idx := strings.LastIndexByte(rest, '\n'); idx >= 0 {
		rest = rest[:idx+1]
	} else {
		rest = ""
	}
	return DebugConsoleChunk{Offset: offset + int64(consumed) + int64(len(rest)), Data: rest}, nil
}

// trimDebugConsoleLog 裁剪日志：保留尾部约 1MB，并对齐到行首。
func trimDebugConsoleLog(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return
	}
	start := fi.Size() - debugConsoleKeep
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return
	}
	data := string(buf)
	if start > 0 {
		if idx := strings.IndexByte(data, '\n'); idx >= 0 {
			data = data[idx+1:]
		}
	}
	_ = os.WriteFile(path, []byte(data), 0o644)
}
