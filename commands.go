package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 进程桥：为内置终端面板以外的场景（插件命令、git 浅集成等）提供受控的命令执行能力。
// 信任模型与插件一致：页面 JS（含插件）可以启动本机进程，只安装可信来源的插件。

type CommandResult struct {
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

const (
	commandOutputCap   = int64(8 << 20) // 单命令输出上限 8 MB
	commandMaxRunning  = 16             // 同时运行的流式命令上限
	commandMaxTimeout  = 120000         // 同步命令超时上限 120 s
	commandLineMaxSize = 64 << 10       // 单行上限 64 KB
)

type limitedWriter struct {
	w     *bytes.Buffer
	limit int64
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	room := lw.limit - int64(lw.w.Len())
	if room <= 0 {
		return len(p), nil // 丢弃超出部分
	}
	if int64(len(p)) > room {
		lw.w.Write(p[:room])
		return len(p), nil
	}
	lw.w.Write(p)
	return len(p), nil
}

func normalizeCommandArgs(exe string, args []string) error {
	if strings.TrimSpace(exe) == "" {
		return fmt.Errorf("exe 不能为空")
	}
	if len(args) > 128 {
		return fmt.Errorf("参数个数超过上限 128")
	}
	return nil
}

func commandWorkDir(cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		return "", nil
	}
	return cwd, nil
}

// RunCommandSync 同步执行一个命令并收集输出；非零退出码不是错误（通过 Code 返回）。
func (a *App) RunCommandSync(exe string, args []string, cwd string, timeoutMs int) (*CommandResult, error) {
	if err := normalizeCommandArgs(exe, args); err != nil {
		return nil, err
	}
	if timeoutMs <= 0 || timeoutMs > commandMaxTimeout {
		timeoutMs = 20000
	}
	dir, err := commandWorkDir(cwd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &stdout, limit: commandOutputCap}
	cmd.Stderr = &limitedWriter{w: &stderr, limit: commandOutputCap}
	runErr := cmd.Run()
	res := &CommandResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctx.Err() == context.DeadlineExceeded {
		return res, fmt.Errorf("命令超时（%d ms）", timeoutMs)
	}
	if exitErr, ok := runErr.(*exec.ExitError); ok {
		res.Code = exitErr.ExitCode()
		return res, nil
	}
	if runErr != nil {
		return nil, runErr
	}
	return res, nil
}

var (
	runningMu      sync.Mutex
	runningCancels = map[string]context.CancelFunc{}
)

func stopRunningCommand(id string) {
	runningMu.Lock()
	cancel, ok := runningCancels[id]
	delete(runningCancels, id)
	runningMu.Unlock()
	if ok {
		cancel()
	}
}

// StartCommand 流式执行：按行发出 cmd-out {id, stream, data} 事件，结束时发出 cmd-exit {id, code}。
// id 由调用方（前端/插件）生成并保证唯一。
func (a *App) StartCommand(id, exe string, args []string, cwd string) error {
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
	runningMu.Lock()
	if _, exists := runningCancels[id]; exists {
		runningMu.Unlock()
		return fmt.Errorf("命令 id %q 已在运行", id)
	}
	if len(runningCancels) >= commandMaxRunning {
		runningMu.Unlock()
		return fmt.Errorf("同时运行的命令超过上限 %d", commandMaxRunning)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runningCancels[id] = cancel
	runningMu.Unlock()

	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Dir = dir
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
	if err := cmd.Start(); err != nil {
		stopRunningCommand(id)
		return err
	}
	go func() {
		var wg sync.WaitGroup
		emitLines := func(pipe interface{ Read([]byte) (int, error) }, stream string) {
			defer wg.Done()
			buf := make([]byte, 0, commandLineMaxSize)
			chunk := make([]byte, 4096)
			total := int64(0)
			for {
				n, readErr := pipe.Read(chunk)
				if n > 0 {
					total += int64(n)
					buf = append(buf, chunk[:n]...)
					for {
						idx := bytes.IndexByte(buf, '\n')
						if idx < 0 {
							if len(buf) > commandLineMaxSize {
								a.emitCommandEvent(id, stream, string(buf[:commandLineMaxSize]))
								buf = buf[:0]
							}
							break
						}
						a.emitCommandEvent(id, stream, string(buf[:idx]))
						buf = buf[:copy(buf, buf[idx+1:])]
					}
					if total > commandOutputCap {
						a.emitCommandEvent(id, stream, "…输出超过 8 MB 上限，已截断…")
						break
					}
				}
				if readErr != nil {
					if len(buf) > 0 {
						a.emitCommandEvent(id, stream, string(buf))
					}
					return
				}
			}
		}
		wg.Add(2)
		go emitLines(stdout, "out")
		go emitLines(stderr, "err")
		wg.Wait()
		code := 0
		if waitErr := cmd.Wait(); waitErr != nil {
			if exitErr, ok := waitErr.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else if ctx.Err() != nil {
				code = -1 // 被取消
			} else {
				code = -1
			}
		}
		stopRunningCommand(id)
		runtime.EventsEmit(a.ctx, "cmd-exit", map[string]string{"id": id, "code": fmt.Sprintf("%d", code)})
	}()
	return nil
}

func (a *App) emitCommandEvent(id, stream, data string) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "cmd-out", map[string]string{id: id, stream: stream, data: strings.ToValidUTF8(data, "\ufffd")})
}

// StopCommand 终止一个流式命令。
func (a *App) StopCommand(id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("id 不能为空")
	}
	runningMu.Lock()
	_, ok := runningCancels[id]
	runningMu.Unlock()
	if !ok {
		return fmt.Errorf("没有正在运行的命令 %q", id)
	}
	stopRunningCommand(id)
	return nil
}
