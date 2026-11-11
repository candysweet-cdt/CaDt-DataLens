//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	pty "github.com/aymanbagabas/go-pty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
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

// normalizeTermShell 把空值解析为默认 shell：本机有 PowerShell 7 时用 pwsh，否则回退 Windows PowerShell。
func normalizeTermShell(shell string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(shell)) {
	case "", "auto":
		if findPwsh() != "" {
			return "pwsh", nil
		}
		return "powershell", nil
	case "pwsh":
		if findPwsh() == "" {
			return "", fmt.Errorf("未找到 PowerShell 7（pwsh）")
		}
		return "pwsh", nil
	case "powershell":
		return "powershell", nil
	case "cmd":
		return "cmd", nil
	case "gitbash":
		if findGitBash() == "" {
			return "", fmt.Errorf("未找到 Git Bash，请确认已安装 Git for Windows")
		}
		return "gitbash", nil
	default:
		return "", fmt.Errorf("不支持的 shell：%s（可选 pwsh / powershell / cmd / gitbash）", shell)
	}
}

func termShellArgs(shell string) ([]string, error) {
	id, err := normalizeTermShell(shell)
	if err != nil {
		return nil, err
	}
	switch id {
	case "pwsh":
		return []string{findPwsh(), "-NoLogo"}, nil
	case "powershell":
		return []string{"powershell.exe", "-NoLogo"}, nil
	case "cmd":
		return []string{"cmd.exe"}, nil
	case "gitbash":
		return []string{findGitBash(), "--login", "-i"}, nil
	default:
		return nil, fmt.Errorf("不支持的 shell：%s", shell)
	}
}

// findPwsh 定位 PowerShell 7+；找不到返回空串。
func findPwsh() string {
	if path, err := exec.LookPath("pwsh"); err == nil {
		return path
	}
	for _, candidate := range []string{
		`C:\Program Files\PowerShell\7\pwsh.exe`,
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WindowsApps", "pwsh.exe"),
	} {
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
	}
	return ""
}

// findGitBash 定位 Git for Windows 自带的 bash.exe（排除 WSL 的 System32\bash.exe）；
// 找不到返回空串。
func findGitBash() string {
	var candidates []string
	if gitPath, err := exec.LookPath("git"); err == nil {
		// git.exe 通常在 <Git>\cmd\ 或 <Git>\bin\ 下，回退两级得到安装根目录
		root := filepath.Dir(filepath.Dir(gitPath))
		candidates = append(candidates,
			filepath.Join(root, "bin", "bash.exe"),
			filepath.Join(root, "usr", "bin", "bash.exe"),
		)
	}
	for _, root := range []string{
		`C:\Program Files\Git`,
		`C:\Program Files (x86)\Git`,
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Git"),
	} {
		candidates = append(candidates,
			filepath.Join(root, "bin", "bash.exe"),
			filepath.Join(root, "usr", "bin", "bash.exe"),
		)
	}
	for _, c := range candidates {
		if !strings.Contains(strings.ToLower(c), "git") {
			continue // 防止误认 WSL/System32 的 bash.exe
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
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
	cmd.Env = mergeEnv(os.Environ())
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
	resolvedShell, err := normalizeTermShell(shell)
	if err != nil {
		return nil, err
	}
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
	session, err := startTermSession(id, resolvedShell, cols, rows, cwd, emit)
	if err != nil {
		return nil, err
	}
	terminals.mu.Lock()
	terminals.sessions[id] = session
	terminals.mu.Unlock()
	return map[string]string{"id": id, "shell": resolvedShell}, nil
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

// TermShells 返回本机可用的 shell 列表（供新建终端菜单），默认 shell 排在最前。
func (a *App) TermShells() []map[string]string {
	shells := []map[string]string{}
	if findPwsh() != "" {
		shells = append(shells, map[string]string{"id": "pwsh", "name": "PowerShell 7"})
	}
	shells = append(shells,
		map[string]string{"id": "powershell", "name": "Windows PowerShell"},
		map[string]string{"id": "cmd", "name": "Command Prompt"},
	)
	if findGitBash() != "" {
		shells = append(shells, map[string]string{"id": "gitbash", "name": "Git Bash"})
	}
	return shells
}
