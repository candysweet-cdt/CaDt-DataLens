package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

// 运行代码：把当前文件交给本机已检测到的解释器/编译器执行，输出流式回传。
//
// 与 commands.go 命令桥的分工：
//   - 命令桥（cmd-out）面向插件与 AI，输出按 UTF-8 强转；
//   - 运行通道（run-out）面向用户，输出要兼容中文 Windows 的 GBK —— gcc / pip / cl 在
//     中文系统上默认吐 GBK 字节，直接 ToValidUTF8 会整片变成 �。
// 两条通道共用进程控制（杀整棵进程树、隐藏控制台窗口）与取消表，互不影响事件名。

const (
	runLineMax       = 64 << 10              // 单行上限，超出强制断开
	runOutputCap     = int64(8 << 20)        // 单次运行输出上限 8 MB
	runFlushEvery    = 16 * time.Millisecond // 输出合并窗口：按行发事件在高产命令下会淹没前端
	runFlushBytes    = 8 << 10               // 攒够 8 KB 立即发
	runTempKeep      = 7 * 24 * time.Hour    // 临时目录保留时长
	runTempDirPrefix = "run-"
)

// RunSpec 前端给出的运行请求。
type RunSpec struct {
	SrcPath  string `json:"srcPath"`  // 磁盘上的源文件；虚拟文档为空
	Content  string `json:"content"`  // 非空表示用缓冲区内容写临时副本（有未保存修改）
	TempName string `json:"tempName"` // 临时副本文件名，如 main.py
	NeedTemp bool   `json:"needTemp"` // 需要临时目录放编译产物（C/C++/Rust）
}

// RunWorkspace 一次运行的工作区：跑哪个文件、在哪个目录、临时目录在哪。
type RunWorkspace struct {
	SourcePath string `json:"sourcePath"`
	WorkDir    string `json:"workDir"`
	TempDir    string `json:"tempDir"`
	TempCopy   bool   `json:"tempCopy"`
}

// RunExit 运行结束事件载荷。
type RunExit struct {
	Id         string `json:"id"`
	Code       int    `json:"code"`
	DurationMs int64  `json:"durationMs"`
}

// RunShellInfo 脚本类语言用的解释器路径。
type RunShellInfo struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// ResolveRunShell 解析 shell 类解释器（gitbash / pwsh / powershell / cmd）。
func (a *App) ResolveRunShell(kind string) (*RunShellInfo, error) {
	path, name, err := resolveRunShell(strings.ToLower(strings.TrimSpace(kind)))
	if err != nil {
		return nil, err
	}
	return &RunShellInfo{Path: path, Name: name}, nil
}

func runTempRoot() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "run")
}

// newRunTempDir 在应用数据目录下开一个本次运行独占的临时目录。
// 不用 %TEMP%：Defender 对 %TEMP% 下新生成的 exe 更敏感，编译产物容易被拦。
func newRunTempDir() (string, error) {
	root := runTempRoot()
	if root == "" {
		return "", fmt.Errorf("无法定位应用数据目录")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("创建运行临时目录失败：%w", err)
	}
	return os.MkdirTemp(root, runTempDirPrefix)
}

// safeRunFileName 只保留文件名部分并剔除 Windows 非法字符，防路径穿越。
func safeRunFileName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" || name == "." || name == ".." {
		return ""
	}
	if len(name) > 120 {
		name = name[:120]
	}
	return name
}

// PrepareRun 准备可执行的源文件与工作目录。
// 有未保存修改或虚拟文档时把内容写成临时副本；需要编译产物时额外开临时目录。
func (a *App) PrepareRun(spec RunSpec) (*RunWorkspace, error) {
	src := strings.TrimSpace(spec.SrcPath)
	content := spec.Content
	name := safeRunFileName(spec.TempName)
	useTempCopy := content != ""
	if useTempCopy && name == "" {
		return nil, fmt.Errorf("临时副本缺少有效文件名")
	}
	if src == "" && !useTempCopy {
		return nil, fmt.Errorf("没有可运行的源文件")
	}

	ws := &RunWorkspace{}
	if useTempCopy {
		dir, err := newRunTempDir()
		if err != nil {
			return nil, err
		}
		path := filepath.Join(dir, name)
		// 编辑器内容是解码后的文本，统一按 UTF-8 落盘（GBK 源文件也转成 UTF-8 更好跑）
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("写入临时副本失败：%w", err)
		}
		ws.SourcePath = path
		ws.TempCopy = true
		ws.TempDir = dir
	} else {
		if st, err := os.Stat(src); err != nil || st.IsDir() {
			return nil, fmt.Errorf("源文件不存在：%s", src)
		}
		ws.SourcePath = src
		if spec.NeedTemp {
			dir, err := newRunTempDir()
			if err != nil {
				return nil, err
			}
			ws.TempDir = dir
		}
	}

	// 工作目录优先源文件所在目录：数据查看器最主要的用法是「脚本读旁边的 csv/json」
	if src != "" {
		ws.WorkDir = filepath.Dir(src)
	} else {
		ws.WorkDir = ws.TempDir
	}
	return ws, nil
}

// decodeRunOutput 输出解码：UTF-8 优先，其次 GB18030（GBK 超集），都不行才替换。
func decodeRunOutput(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	if out, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), raw); err == nil {
		return string(out)
	}
	return strings.ToValidUTF8(string(raw), "\ufffd")
}

// envWithPathPrepend 在继承环境（含设置里的私密变量）之上前置 PATH。
// 编译产物运行需要它：MinGW 出来的 exe 依赖编译器同目录的 libstdc++-6.dll 等。
func envWithPathPrepend(prepend string) []string {
	env := mergeEnv(os.Environ())
	prepend = strings.TrimSpace(prepend)
	if prepend == "" {
		return env
	}
	for i, kv := range env {
		if len(kv) > 5 && strings.EqualFold(kv[:5], "PATH=") {
			if kv[5:] == "" {
				env[i] = kv[:5] + prepend
			} else {
				env[i] = kv[:5] + prepend + string(os.PathListSeparator) + kv[5:]
			}
			return env
		}
	}
	return append(env, "PATH="+prepend)
}

// runStream 输出合并器：按行切分后攒批发送，避免高产命令每行一次跨进程事件。
type runStream struct {
	a         *App
	id        string
	startedAt time.Time

	mu        sync.Mutex
	outBuf    bytes.Buffer
	errBuf    bytes.Buffer
	total     int64
	truncated bool
	closed    bool
}

func (s *runStream) add(stream, line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if s.truncated {
		return
	}
	s.total += int64(len(line)) + 1
	if s.total > runOutputCap {
		s.truncated = true
		s.flushLocked()
		s.emitLocked(stream, "…输出超过 8 MB 上限，已截断…")
		return
	}
	buf := &s.outBuf
	if stream == "err" {
		buf = &s.errBuf
	}
	buf.WriteString(line)
	buf.WriteByte('\n')
	if buf.Len() >= runFlushBytes {
		s.flushLocked()
	}
}

// startFlusher 起一个 16 ms 的定时刷出：慢速输出（每秒一行）不用等到 8 KB 才显示。
func (s *runStream) startFlusher() func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(runFlushEvery)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				s.mu.Lock()
				if !s.closed {
					s.flushLocked()
				}
				s.mu.Unlock()
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

func (s *runStream) flushLocked() {
	if s.outBuf.Len() > 0 {
		data := s.outBuf.String()
		s.outBuf.Reset()
		s.emitLocked("out", data)
	}
	if s.errBuf.Len() > 0 {
		data := s.errBuf.String()
		s.errBuf.Reset()
		s.emitLocked("err", data)
	}
}

// runEmitHook 仅供测试观察事件流（正式运行时为 nil）。
var runEmitHook func(event string, payload interface{})

func (s *runStream) emitLocked(stream, data string) {
	payload := map[string]string{
		"id":     s.id,
		"stream": stream,
		"data":   data,
	}
	if runEmitHook != nil {
		runEmitHook("run-out", payload)
	}
	if s.a == nil || s.a.ctx == nil {
		return
	}
	runtime.EventsEmit(s.a.ctx, "run-out", payload)
}

func (s *runStream) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.truncated {
		return
	}
	s.flushLocked()
}

// readPipe 从管道读原始字节、按行切、逐行解码后交给合并器。
func (s *runStream) readPipe(pipe io.Reader, stream string) {
	buf := make([]byte, 0, 4096)
	chunk := make([]byte, 4096)
	for {
		n, readErr := pipe.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			for {
				idx := bytes.IndexByte(buf, '\n')
				if idx < 0 {
					// 超长行（无换行）强制断开，防止内存被单行吃满
					if len(buf) >= runLineMax {
						s.add(stream, decodeRunOutput(bytes.TrimRight(buf, "\r")))
						buf = buf[:0]
					}
					break
				}
				line := bytes.TrimRight(buf[:idx], "\r")
				s.add(stream, decodeRunOutput(line))
				buf = append(buf[:0], buf[idx+1:]...)
			}
		}
		if readErr != nil {
			if len(buf) > 0 {
				s.add(stream, decodeRunOutput(bytes.TrimRight(buf, "\r")))
			}
			return
		}
	}
}

// RunExec 启动一个运行进程：输出走 run-out（{id, stream, data}），结束走 run-exit。
// pathPrepend 非空时前置到子进程 PATH（编译型语言运行阶段用）。
func (a *App) RunExec(id, exe string, args []string, cwd, pathPrepend string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("id 不能为空")
	}
	if err := normalizeCommandArgs(exe, args); err != nil {
		return err
	}
	dir, err := commandWorkDir(cwd)
	if err != nil {
		return err
	}
	if dir != "" {
		if st, serr := os.Stat(dir); serr != nil || !st.IsDir() {
			return fmt.Errorf("工作目录不存在：%s", dir)
		}
	}

	runningMu.Lock()
	if _, exists := runningCancels[id]; exists {
		runningMu.Unlock()
		return fmt.Errorf("运行 id %q 已在运行", id)
	}
	if len(runningCancels) >= commandMaxRunning {
		runningMu.Unlock()
		return fmt.Errorf("同时运行的任务超过上限 %d", commandMaxRunning)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runningCancels[id] = cancel
	runningMu.Unlock()

	cmd := exec.CommandContext(ctx, exe, args...)
	applyCommandCancel(cmd)
	cmd.Dir = dir
	cmd.Env = envWithPathPrepend(pathPrepend)
	hideConsoleWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stopRunningCommand(id)
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		stopRunningCommand(id)
		return err
	}
	started := time.Now()
	if err := cmd.Start(); err != nil {
		stopRunningCommand(id)
		return fmt.Errorf("启动失败：%w", err)
	}

	stream := &runStream{a: a, id: id, startedAt: started}
	stopFlusher := stream.startFlusher()
	go func() {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			stream.readPipe(stdout, "out")
		}()
		go func() {
			defer wg.Done()
			stream.readPipe(stderr, "err")
		}()
		wg.Wait()
		stopFlusher()
		code := 0
		if waitErr := cmd.Wait(); waitErr != nil {
			if ctx.Err() != nil {
				code = -1 // 被停止：wrapper 退出码无意义
			} else if exitErr, ok := waitErr.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		stream.finish()
		exit := RunExit{Id: id, Code: code, DurationMs: time.Since(started).Milliseconds()}
		if runEmitHook != nil {
			runEmitHook("run-exit", exit)
		}
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "run-exit", exit)
		}
		stopRunningCommand(id)
	}()
	return nil
}

// RunStop 停止一次运行；id 不存在时静默成功（前端可能连点）。
func (a *App) RunStop(id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("id 不能为空")
	}
	runningMu.Lock()
	_, ok := runningCancels[id]
	runningMu.Unlock()
	if ok {
		stopRunningCommand(id)
	}
	return nil
}

// GetRunTempDir 返回（并按需创建）运行临时目录根，供设置页「打开临时目录」用。
func (a *App) GetRunTempDir() (string, error) {
	root := runTempRoot()
	if root == "" {
		return "", fmt.Errorf("无法定位应用数据目录")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("创建运行临时目录失败：%w", err)
	}
	return root, nil
}

// CleanupRunTemp 删除一次运行独占的临时目录；只允许删应用数据目录下的 run/ 子目录。
func (a *App) CleanupRunTemp(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil
	}
	root := runTempRoot()
	if root == "" {
		return fmt.Errorf("无法定位应用数据目录")
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return fmt.Errorf("拒绝删除非运行临时目录：%s", dir)
	}
	return os.RemoveAll(dir)
}

// CleanupRunTempStale 清理超过保留期的运行临时目录，返回删除数量。
func (a *App) CleanupRunTempStale() (int, error) {
	root := runTempRoot()
	if root == "" {
		return 0, nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	deadline := time.Now().Add(-runTempKeep)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(deadline) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, entry.Name())); err == nil {
			removed++
		}
	}
	return removed, nil
}
