//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	pty "github.com/aymanbagabas/go-pty"
)

// 内置终端：基于 Windows ConPTY，经 go-pty v0.2.3（MIT, © Ayman Bagabas，见 THIRD_PARTY_LICENSES.md）。
// 自写封装在本机（Win11 26300）出现子进程 0xC0000142，go-pty 实测稳定，故采用之。

const (
	termMaxSessions = 8
	termDefaultCols = 80
	termDefaultRows = 24
)

type termSession struct {
	id        string
	p         pty.Pty
	cmd       *pty.Cmd
	cancel    context.CancelFunc
	closeOnce sync.Once
}

type terminalManager struct {
	mu       sync.Mutex
	sessions map[string]*termSession
	seq      int
}

var terminals = &terminalManager{sessions: map[string]*termSession{}}

func termShellArgs(shell string) ([]string, error) {
	switch strings.ToLower(strings.TrimSpace(shell)) {
	case "", "powershell":
		return []string{"powershell.exe", "-NoLogo"}, nil
	case "cmd":
		return []string{"cmd.exe"}, nil
	default:
		return nil, fmt.Errorf("不支持的 shell：%s（可选 powershell / cmd）", shell)
	}
}

// startTermSession 创建一个 ConPTY 会话；emit 回调发送 term-out / term-exit 事件。
func startTermSession(id, shell string, cols, rows int, cwd string, emit func(event string, data interface{})) (*termSession, error) {
	args, err := termShellArgs(shell)
	if err != nil {
		return nil, err
	}
	p, err := pty.New()
	if err != nil {
		return nil, fmt.Errorf("创建伪终端失败：%w", err)
	}
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}
	argv0, err := exec.LookPath(args[0])
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("找不到 %s：%w", args[0], err)
	}
	cmd := p.Command(argv0, args[1:]...)
	cmd.Dir = cwd
	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, fmt.Errorf("启动 %s 失败：%w", args[0], err)
	}
	if cols > 0 && rows > 0 {
		// 尺寸调整失败不致命
		_ = p.Resize(cols, rows)
	}

	session := &termSession{id: id, p: p, cmd: cmd}
	ctx, cancel := context.WithCancel(context.Background())
	session.cancel = cancel

	conPty := p.(pty.ConPty)
	outPipe := conPty.OutputPipe()

	// 输出读取：分块推给前端
	go func() {
		buf := make([]byte, 4096)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, readErr := outPipe.Read(buf)
			if n > 0 {
				emit("term-out", map[string]string{
					"id":   id,
					"data": strings.ToValidUTF8(string(buf[:n]), "\ufffd"),
				})
			}
			if readErr != nil {
				return
			}
		}
	}()

	// 退出监听
	go func() {
		_ = cmd.Wait()
		emit("term-exit", map[string]interface{}{"id": id, "code": exitCodeOf(cmd)})
		session.closeAll()
	}()

	return session, nil
}

func exitCodeOf(cmd *pty.Cmd) int32 {
	if cmd.Process == nil {
		return -1
	}
	state, err := cmd.Process.Wait()
	if err != nil {
		return -1
	}
	return int32(state.ExitCode())
}

func (s *termSession) write(data string) error {
	if data == "" {
		return nil
	}
	_, err := s.p.Write([]byte(data))
	return err
}

func (s *termSession) resize(cols, rows int) error {
	if cols <= 0 || cols > 500 || rows <= 0 || rows > 200 {
		return fmt.Errorf("非法的终端尺寸：%dx%d", cols, rows)
	}
	return s.p.Resize(cols, rows)
}

func (s *termSession) terminate() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

func (s *termSession) closeAll() {
	s.closeOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
		s.p.Close()
		terminals.mu.Lock()
		delete(terminals.sessions, s.id)
		terminals.mu.Unlock()
	})
}

func (m *terminalManager) closeAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.mu.Lock()
		s := m.sessions[id]
		m.mu.Unlock()
		if s != nil {
			s.terminate()
			s.closeAll()
		}
	}
}

func (a *App) TermCreate(cols, rows int, shell string, cwd string) (map[string]string, error) {
	terminals.mu.Lock()
	if len(terminals.sessions) >= termMaxSessions {
		terminals.mu.Unlock()
		return nil, fmt.Errorf("终端会话数已达上限 %d", termMaxSessions)
	}
	terminals.seq++
	id := fmt.Sprintf("term-%d", terminals.seq)
	terminals.mu.Unlock()

	emit := func(event string, data interface{}) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, event, data)
		}
	}
	session, err := startTermSession(id, shell, cols, rows, cwd, emit)
	if err != nil {
		return nil, err
	}
	terminals.mu.Lock()
	terminals.sessions[id] = session
	terminals.mu.Unlock()
	return map[string]string{"id": id}, nil
}

func (a *App) TermWrite(id string, data string) error {
	terminals.mu.Lock()
	s := terminals.sessions[id]
	terminals.mu.Unlock()
	if s == nil {
		return fmt.Errorf("终端会话不存在：%s", id)
	}
	return s.write(data)
}

func (a *App) TermResize(id string, cols, rows int) error {
	terminals.mu.Lock()
	s := terminals.sessions[id]
	terminals.mu.Unlock()
	if s == nil {
		return fmt.Errorf("终端会话不存在：%s", id)
	}
	return s.resize(cols, rows)
}

func (a *App) TermClose(id string) error {
	terminals.mu.Lock()
	s := terminals.sessions[id]
	terminals.mu.Unlock()
	if s == nil {
		return fmt.Errorf("终端会话不存在：%s", id)
	}
	s.terminate()
	s.closeAll()
	return nil
}
