package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const appLogKeep = 20

var (
	appLogMu   sync.Mutex
	appLogFile *os.File
	appLogPath string
	devMode    atomic.Bool
)

func appLogsDir() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "logs")
}

// startAppLog 为本次运行创建日志文件，并接管标准日志与 Wails 日志。
func startAppLog() {
	// wails build 生成绑定时会临时运行同名程序，不产生运行日志。
	if exe, err := os.Executable(); err == nil && strings.Contains(strings.ToLower(filepath.Base(exe)), "wailsbindings") {
		return
	}
	path, err := openAppLogAt(appLogsDir())
	if err != nil {
		return
	}
	devMode.Store(readAppConfig().DeveloperMode)
	if f := currentAppLogFile(); f != nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
		log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	}
	writeAppLog("info", "日志文件：%s", path)
	writeAppLog("info", "开发者模式：%s", onOff(devMode.Load()))
}

func stopAppLog() {
	writeAppLog("info", "应用退出")
	closeAppLog()
}

func currentAppLogFile() *os.File {
	appLogMu.Lock()
	defer appLogMu.Unlock()
	return appLogFile
}

func closeAppLog() {
	appLogMu.Lock()
	f := appLogFile
	appLogFile = nil
	appLogPath = ""
	appLogMu.Unlock()
	if f != nil {
		_ = f.Close()
	}
}

func openAppLogAt(dir string) (string, error) {
	if dir == "" {
		return "", errors.New("无法定位日志目录")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	base := time.Now().Format("2006-01-02_15-04-05")
	path := filepath.Join(dir, base+".txt")
	for i := 2; ; i++ {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			break
		}
		path = filepath.Join(dir, fmt.Sprintf("%s-%d.txt", base, i))
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return "", err
	}
	appLogMu.Lock()
	old := appLogFile
	appLogFile = f
	appLogPath = path
	appLogMu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	pruneAppLogs(dir, appLogKeep)
	return path, nil
}

func pruneAppLogs(dir string, keep int) {
	if keep <= 0 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".txt") {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	if len(names) <= keep {
		return
	}
	for _, name := range names[keep:] {
		_ = os.Remove(filepath.Join(dir, name))
	}
}

func writeAppLog(level, format string, args ...any) {
	message := strings.TrimRight(fmt.Sprintf(format, args...), "\r\n")
	if message == "" {
		return
	}
	if len(message) > 64<<10 {
		message = message[:64<<10] + "\n…（内容过长已截断）"
	}
	tag := strings.ToUpper(strings.TrimSpace(level))
	if tag == "" {
		tag = "INFO"
	}
	stamp := time.Now().Format("2006-01-02 15:04:05.000")
	appLogMu.Lock()
	defer appLogMu.Unlock()
	if appLogFile == nil {
		return
	}
	for _, line := range strings.Split(message, "\n") {
		_, _ = fmt.Fprintf(appLogFile, "%s [%s] %s\n", stamp, tag, line)
	}
}

func onOff(enabled bool) string {
	if enabled {
		return "开启"
	}
	return "关闭"
}

// appLogger 把 Wails 内部日志写入本次运行日志。
type appLogger struct{}

func (appLogger) Print(message string)   { writeAppLog("info", "%s", message) }
func (appLogger) Trace(message string)   { writeAppLog("debug", "%s", message) }
func (appLogger) Debug(message string)   { writeAppLog("debug", "%s", message) }
func (appLogger) Info(message string)    { writeAppLog("info", "%s", message) }
func (appLogger) Warning(message string) { writeAppLog("warn", "%s", message) }
func (appLogger) Error(message string)   { writeAppLog("error", "%s", message) }
func (appLogger) Fatal(message string) {
	writeAppLog("error", "%s", message)
	os.Exit(1)
}

// LogFrontend 接收前端日志；错误与警告始终记录，info/debug 仅在开发者模式下记录。
func (a *App) LogFrontend(level, message string) {
	tag := strings.ToLower(strings.TrimSpace(level))
	switch tag {
	case "error", "warn", "info", "debug":
	case "warning":
		tag = "warn"
	default:
		tag = "info"
	}
	if (tag == "info" || tag == "debug") && !devMode.Load() {
		return
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return
	}
	writeAppLog(tag, "%s", message)
}

func (a *App) GetDeveloperMode() bool {
	return devMode.Load()
}

func (a *App) SetDeveloperMode(enabled bool) error {
	cfg := readAppConfig()
	cfg.DeveloperMode = enabled
	if err := saveAppConfig(cfg); err != nil {
		return err
	}
	devMode.Store(enabled)
	writeAppLog("info", "开发者模式：%s", onOff(enabled))
	return nil
}

func (a *App) GetLogPath() string {
	appLogMu.Lock()
	defer appLogMu.Unlock()
	return appLogPath
}

func (a *App) OpenLogDir() error {
	dir := appLogsDir()
	if dir == "" {
		return errors.New("无法定位应用数据目录")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("无法创建日志目录：%w", err)
	}
	return a.ShowInFolder(dir)
}
