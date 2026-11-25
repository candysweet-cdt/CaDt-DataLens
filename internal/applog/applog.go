// applog：按次运行的应用日志 —— 文件创建与轮转保留、分级写入、开发者模式开关与 Wails 日志适配。
package applog

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"datalens/internal/appconfig"
	"datalens/internal/appdata"
)

// keep 是日志目录里保留的最近文件数。
const keep = 20

var (
	mu       sync.Mutex
	file     *os.File
	filePath string
	devMode  atomic.Bool
)

// Dir 返回日志目录（应用数据根目录不可用时返回空串）。
func Dir() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "logs")
}

// Start 为本次运行创建日志文件，并接管标准日志与 Wails 日志。
func Start() {
	// wails build 生成绑定时会临时运行同名程序，不产生运行日志。
	if exe, err := os.Executable(); err == nil && strings.Contains(strings.ToLower(filepath.Base(exe)), "wailsbindings") {
		return
	}
	path, err := OpenAt(Dir())
	if err != nil {
		return
	}
	devMode.Store(appconfig.Read().DeveloperMode)
	if f := currentFile(); f != nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
		log.SetFlags(log.LstdFlags | log.Lmicroseconds)
		// 未恢复的 panic / 致命错误默认只写 stderr；GUI 进程没有控制台，症状是
		// 「进程瞬间消失、日志一行不剩」（2026-11-17 打开网页闪退就查不到死因）。
		// 让 runtime 把崩溃报告复制进本次运行日志；all 档带上全部 goroutine 栈。
		_ = debug.SetCrashOutput(f, debug.CrashOptions{})
		debug.SetTraceback("all")
	}
	Write("info", "日志文件：%s", path)
	Write("info", "开发者模式：%s", OnOff(devMode.Load()))
}

// Stop 写入退出标记并关闭当前日志文件。
func Stop() {
	Write("info", "应用退出")
	Close()
}

// OpenAt 在指定目录创建本次运行日志文件并轮转旧文件，返回文件路径。
func OpenAt(dir string) (string, error) {
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
	mu.Lock()
	old := file
	file = f
	filePath = path
	mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	prune(dir, keep)
	return path, nil
}

// Close 关闭当前日志文件并清空路径（Close 后 GetLogPath 返回空串）。
func Close() {
	mu.Lock()
	f := file
	file = nil
	filePath = ""
	mu.Unlock()
	if f != nil {
		_ = f.Close()
	}
}

func currentFile() *os.File {
	mu.Lock()
	defer mu.Unlock()
	return file
}

func prune(dir string, keep int) {
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

// Write 写一条分级日志；多行消息按行加时间戳。文件未打开时静默丢弃。
func Write(level, format string, args ...any) {
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
	mu.Lock()
	defer mu.Unlock()
	if file == nil {
		return
	}
	for _, line := range strings.Split(message, "\n") {
		_, _ = fmt.Fprintf(file, "%s [%s] %s\n", stamp, tag, line)
	}
}

// FilePath 返回本次运行日志文件路径（未打开时为空串）。
func FilePath() string {
	mu.Lock()
	defer mu.Unlock()
	return filePath
}

// DevMode 返回开发者模式开关（调试级日志门控）。
func DevMode() bool {
	return devMode.Load()
}

// SetDevMode 更新开发者模式开关。
func SetDevMode(enabled bool) {
	devMode.Store(enabled)
}

// OnOff 把开关值渲染成中文标签（日志文案用）。
func OnOff(enabled bool) string {
	if enabled {
		return "开启"
	}
	return "关闭"
}

// ==================== 崩溃现场归档 ====================

// crashDirName 崩溃现场归档目录名（appdata 下）。
const crashDirName = "crash"

// CrashDir 返回崩溃现场日志的归档目录（appdata/crash；根目录不可用时返回空串）。
// 刻意不放进 logs/：logs 本身是可清理缓存（storage 的 app-logs 条目按 *.txt 清直接
// 子项，日志轮转 prune 也按同名规则删旧文件），归档必须活过任何一轮清理。
func CrashDir() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, crashDirName)
}

// PreserveCrashedLog 把上次崩溃会话的运行日志复制进归档目录，返回归档路径。
//
// 复制而不是移动：源文件此刻可能还被残留进程占着，移动失败会把现场一起丢掉；
// 归档成功与否都不影响调用方继续清理。源文件不存在时返回的错误可
// errors.Is(err, os.ErrNotExist) 判定（属正常情形：上次会话没留日志）。
func PreserveCrashedLog(src string) (string, error) {
	return PreserveCrashedLogAt(CrashDir(), src)
}

// PreserveCrashedLogAt 是 PreserveCrashedLog 的目录注入版（测试用，对齐 OpenAt）。
// 目标同名文件已存在时不覆盖，改用 -2/-3 后缀另存——更早的现场比新的更值钱。
func PreserveCrashedLogAt(dir, src string) (string, error) {
	if dir == "" {
		return "", errors.New("无法定位崩溃归档目录")
	}
	src = strings.TrimSpace(src)
	if src == "" {
		return "", errors.New("崩溃日志路径为空")
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := filepath.Base(src)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i <= 100; i++ {
		target := name
		if i > 1 {
			target = fmt.Sprintf("%s-%d%s", stem, i, ext)
		}
		out := filepath.Join(dir, target)
		f, err := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(f, in)
		closeErr := f.Close()
		if copyErr != nil || closeErr != nil {
			// 半截归档比没有更误导：写完之前失败就撤掉，别让下次排查读到一个截断的堆栈。
			_ = os.Remove(out)
			if copyErr != nil {
				return "", copyErr
			}
			return "", closeErr
		}
		return out, nil
	}
	return "", errors.New("崩溃日志归档重名过多（同名文件已超 100 份）")
}

// WailsLogger 把 Wails 内部日志写入本次运行日志。
type WailsLogger struct{}

func (WailsLogger) Print(message string)   { Write("info", "%s", message) }
func (WailsLogger) Trace(message string)   { Write("debug", "%s", message) }
func (WailsLogger) Debug(message string)   { Write("debug", "%s", message) }
func (WailsLogger) Info(message string)    { Write("info", "%s", message) }
func (WailsLogger) Warning(message string) { Write("warn", "%s", message) }
func (WailsLogger) Error(message string)   { Write("error", "%s", message) }
func (WailsLogger) Fatal(message string) {
	Write("error", "%s", message)
	os.Exit(1)
}
