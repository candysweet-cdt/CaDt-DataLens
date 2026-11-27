//go:build windows

package terminal

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"unicode/utf8"
	"unsafe"

	pty "github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/windows"

	"datalens/internal/envvars"
	"datalens/internal/shellpath"
)

// 内置终端：基于 Windows ConPTY，经 go-pty v0.2.3（MIT, © Ayman Bagabas，见 THIRD_PARTY_LICENSES.md）。
// 自写封装在本机（Win11 26300）出现子进程 0xC0000142，go-pty 实测稳定，故采用之。

const (
	termMaxSessions = 8
	termDefaultCols = 80
	termDefaultRows = 24

	// AI 读终端输出用的滚动缓冲：只留尾部（长跑命令不能把内存吃光），
	// 与前端 xterm 显示的是同一份 term-out 数据流（见 append）。
	termBufferBytes      = 64 << 10
	termReadDefaultChars = 4000
	termReadMaxChars     = 20000
)

// ===== 会话结构类型 =====
type termSession struct {
	id        string
	p         pty.Pty
	cmd       *pty.Cmd
	cancel    context.CancelFunc
	closeOnce sync.Once
	// releaseOnce 保证 ConPTY 句柄只释放一次：go-pty 的 Close 不幂等
	//（每次都调 ClosePseudoConsole + 关掉两条管道），退出与关闭两条路径重复调用
	// 等于二次释放同一句柄。
	releaseOnce sync.Once

	shell string
	cwd   string
	// shellPID：ConPTY shell 的进程号。关窗确认用它枚举后代进程——
	// 空闲提示符（无子进程）不算「正在运行」，shell 里跑着命令才算。
	shellPID uint32

	bufMu    sync.Mutex
	buf      []byte
	seq      int64
	exited   bool
	exitCode int32
}

type terminalManager struct {
	mu       sync.Mutex
	sessions map[string]*termSession
	order    []string // 创建顺序（TermList 的展示顺序；map 本身无序）
	seq      int
}

var terminals = &terminalManager{sessions: map[string]*termSession{}}

// ===== Shell 探测与启动 =====
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

// findPwsh / findGitBash 的实现在 internal/shellpath（运行通道与命令桥共用）。
func findPwsh() string { return shellpath.FindPwsh() }

func findGitBash() string { return shellpath.FindGitBash() }

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
	cmd.Env = envvars.MergeEnv(os.Environ())
	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, fmt.Errorf("启动 %s 失败：%w", args[0], err)
	}
	if cols > 0 && rows > 0 {
		// 尺寸调整失败不致命
		_ = p.Resize(cols, rows)
	}

	session := &termSession{id: id, p: p, cmd: cmd, shell: shell, cwd: cwd}
	if cmd.Process != nil {
		session.shellPID = uint32(cmd.Process.Pid)
	}
	ctx, cancel := context.WithCancel(context.Background())
	session.cancel = cancel

	conPty := p.(pty.ConPty)
	outPipe := conPty.OutputPipe()

	// 输出读取：分块推给前端。跨块被截断的多字节 UTF-8 尾巴先攒住与下一块拼回，
	// 否则 ToValidUTF8 会把跨块的中文字符替换成 U+FFFD（渲染乱码）。
	go func() {
		buf := make([]byte, 4096)
		var carry []byte
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, readErr := outPipe.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				if len(carry) > 0 {
					chunk = append(carry, chunk...)
					carry = nil
				}
				// 流还没结束（后面还有块）才攒尾巴；readErr 时已经没有下一块了
				if readErr == nil {
					if tail := utf8IncompleteTail(chunk); tail > 0 {
						carry = append([]byte(nil), chunk[len(chunk)-tail:]...)
						chunk = chunk[:len(chunk)-tail]
					}
				}
				if len(chunk) > 0 {
					data := strings.ToValidUTF8(string(chunk), "\ufffd")
					// 先入 AI 读的滚动缓冲，再推给前端：两边看到的是同一份数据流
					session.append(data)
					emit("term-out", map[string]string{
						"id":   id,
						"data": data,
					})
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	// 退出监听：标记退出并释放 pty，但保留会话与输出缓冲（AI 要读最后的输出），
	// 真正从注册表移除由 TermClose / closeAll 负责
	go func() {
		_ = cmd.Wait()
		code := termExitCode(cmd)
		session.finish(code)
		emit("term-exit", map[string]interface{}{"id": id, "code": code})
	}()

	return session, nil
}

// ===== 会话读写与生命周期 =====
// termExitCode 取退出码。cmd.Wait() 已经把进程收掉并把结果放进 ProcessState，
// 这里绝不能再调 cmd.Process.Wait()：那是对同一进程句柄的第二次回收，Windows 上
// 等于重复 CloseHandle——句柄号被别处复用之后，踩空的是整个进程
// （2026-11-16 实测：跑过终端会话再启目录监视，会把 go test 的二进制直接搞崩，
// 崩溃点却落在完全无关的 watch_windows.go 上）。
func termExitCode(cmd *pty.Cmd) int32 {
	if cmd == nil || cmd.ProcessState == nil {
		return -1
	}
	return int32(cmd.ProcessState.ExitCode())
}

func (s *termSession) write(data string) error {
	if data == "" {
		return nil
	}
	_, err := s.p.Write([]byte(data))
	return err
}

// utf8IncompleteTail 返回 b 尾部不完整 UTF-8 序列的长度（0~3）：多字节字符被
// 分块边界截断时，这几个字节要等下一块拼回后再解码，否则会被 ToValidUTF8
// 替换成 U+FFFD。ASCII 起点、非法首字节、纯续字节尾巴一律返回 0（交给清洗）。
func utf8IncompleteTail(b []byte) int {
	n := len(b)
	for i := n - 1; i >= 0 && i >= n-3; i-- {
		c := b[i]
		if c < 0x80 {
			return 0 // 序列不可能跨过 ASCII 字节
		}
		if c&0xC0 == 0x80 {
			continue // 续字节，继续向前找序列起点
		}
		var want int
		switch {
		case c&0xE0 == 0xC0:
			want = 2
		case c&0xF0 == 0xE0:
			want = 3
		case c&0xF8 == 0xF0:
			want = 4
		default:
			return 0 // 非法首字节
		}
		if n-i < want {
			return n - i
		}
		return 0
	}
	return 0
}

func (s *termSession) resize(cols, rows int) error {
	if cols <= 0 || cols > 500 || rows <= 0 || rows > 200 {
		return fmt.Errorf("非法的终端尺寸：%dx%d", cols, rows)
	}
	return s.p.Resize(cols, rows)
}

// append 把输出写进滚动缓冲，只保留尾部 termBufferBytes（UTF-8 已在读取处清洗）。
func (s *termSession) append(data string) {
	if data == "" {
		return
	}
	s.bufMu.Lock()
	s.buf = append(s.buf, data...)
	if over := len(s.buf) - termBufferBytes; over > 0 {
		s.buf = append(s.buf[:0], s.buf[over:]...)
	}
	s.seq += int64(len(data))
	s.bufMu.Unlock()
}

// tail 取缓冲尾部 maxChars 个字节的文本（不切碎 UTF-8 多字节字符）；第二个返回值表示是否截断。
func (s *termSession) tail(maxChars int) (string, bool) {
	s.bufMu.Lock()
	defer s.bufMu.Unlock()
	if maxChars <= 0 || len(s.buf) <= maxChars {
		return string(s.buf), false
	}
	text := string(s.buf[len(s.buf)-maxChars:])
	for len(text) > 0 && !utf8.RuneStart(text[0]) {
		text = text[1:]
	}
	return text, true
}

// releasePty 释放 ConPTY 句柄与两条管道，只生效一次。
func (s *termSession) releasePty() {
	s.releaseOnce.Do(func() {
		if s.p != nil {
			_ = s.p.Close()
		}
	})
}

// finish 标记进程已退出并释放 pty，但保留会话与输出缓冲（AI 仍要读最后的输出）；
// 真正从注册表移除由 TermClose / closeAll 负责。
func (s *termSession) finish(code int32) {
	s.bufMu.Lock()
	s.exited = true
	s.exitCode = code
	s.bufMu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	s.releasePty()
}

func (s *termSession) terminate() {
	s.bufMu.Lock()
	exited := s.exited
	s.bufMu.Unlock()
	if exited {
		// 进程已被 cmd.Wait() 收掉、句柄已关闭：再 Kill 就是往可能已被复用的句柄号上打枪，
		// 与 termExitCode 那处是同一类二次释放（应用退出时 closeAll 会批量踩到）
		return
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

func (s *termSession) closeAll() {
	s.closeOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
		s.releasePty()
		terminals.mu.Lock()
		delete(terminals.sessions, s.id)
		for i, existing := range terminals.order {
			if existing == s.id {
				terminals.order = append(terminals.order[:i], terminals.order[i+1:]...)
				break
			}
		}
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
	m.mu.Lock()
	m.order = nil
	m.mu.Unlock()
}

// ===== 绑定方法 =====
func (t *Terminal) TermCreate(cols, rows int, shell string, cwd string) (map[string]string, error) {
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
	// 先在表里占位再起 ConPTY：上限判断与插入之间原本有一次不带锁的
	// startTermSession（起进程耗时毫秒级），并发调用会一起通过检查突破上限。
	terminals.sessions[id] = nil
	terminals.order = append(terminals.order, id)
	terminals.mu.Unlock()

	session, err := startTermSession(id, resolvedShell, cols, rows, cwd, emit)
	if err != nil {
		terminals.mu.Lock()
		delete(terminals.sessions, id)
		for i, existing := range terminals.order {
			if existing == id {
				terminals.order = append(terminals.order[:i], terminals.order[i+1:]...)
				break
			}
		}
		terminals.mu.Unlock()
		return nil, err
	}
	terminals.mu.Lock()
	terminals.sessions[id] = session
	terminals.mu.Unlock()
	return map[string]string{"id": id, "shell": resolvedShell}, nil
}

func (t *Terminal) TermWrite(id string, data string) error {
	terminals.mu.Lock()
	s := terminals.sessions[id]
	terminals.mu.Unlock()
	if s == nil {
		return fmt.Errorf("终端会话不存在：%s", id)
	}
	return s.write(data)
}

func (t *Terminal) TermResize(id string, cols, rows int) error {
	terminals.mu.Lock()
	s := terminals.sessions[id]
	terminals.mu.Unlock()
	if s == nil {
		return fmt.Errorf("终端会话不存在：%s", id)
	}
	return s.resize(cols, rows)
}

func (t *Terminal) TermClose(id string) error {
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

// TermReadResult / TermInfo 类型在 terminal.go（共享契约，非 Windows 桩也要编译）。

// TermRead 返回某个终端会话的最近输出（AI terminal 工具的 read 动作）。
// 会话退出后仍可读（输出缓冲保留到 TermClose）。
func (t *Terminal) TermRead(id string, maxChars int) (*TermReadResult, error) {
	if maxChars <= 0 {
		maxChars = termReadDefaultChars
	}
	if maxChars > termReadMaxChars {
		maxChars = termReadMaxChars
	}
	terminals.mu.Lock()
	s := terminals.sessions[id]
	terminals.mu.Unlock()
	if s == nil {
		return nil, fmt.Errorf("终端会话不存在：%s", id)
	}
	s.bufMu.Lock()
	total := s.seq
	exited := s.exited
	code := s.exitCode
	s.bufMu.Unlock()
	text, truncated := s.tail(maxChars)
	return &TermReadResult{
		ID: id, Shell: s.shell, Cwd: s.cwd, Text: text,
		Truncated: truncated, Exited: exited, ExitCode: code, Bytes: total,
	}, nil
}

// TermList 按创建顺序列出全部终端会话（含已退出的，AI 靠它判断该读还是该新开）。
func (t *Terminal) TermList() []TermInfo {
	terminals.mu.Lock()
	ids := append([]string(nil), terminals.order...)
	sessions := make(map[string]*termSession, len(terminals.sessions))
	for id, session := range terminals.sessions {
		sessions[id] = session
	}
	terminals.mu.Unlock()
	out := []TermInfo{}
	for _, id := range ids {
		s := sessions[id]
		if s == nil {
			continue
		}
		s.bufMu.Lock()
		exited, code, total := s.exited, s.exitCode, s.seq
		s.bufMu.Unlock()
		tail, _ := s.tail(400)
		out = append(out, TermInfo{ID: id, Shell: s.shell, Cwd: s.cwd,
			Exited: exited, ExitCode: code, Bytes: total, Last: lastTermLine(tail)})
	}
	return out
}

// RunningSessionCount 返回「正在执行任务」的终端会话数（关窗二次确认用，见 app_window.go 的 beforeClose）。
// 判定 = 会话未退出（!exited）**且 shell 有活着的后代进程**：空闲提示符（刚开的 PowerShell、
// 跑完命令回到提示符）不算——关掉它没有任何损失，拦截只会打扰用户；
// shell 里跑着 npm run dev / 测试等才算数。ConPTY 的 pseudo console 由系统内部管理，
// 不挂在 shell 的进程树上，后代枚举看到的就是真实命令进程。
func (t *Terminal) RunningSessionCount() int {
	// 先在锁内收集候选，再在锁外逐个枚举进程快照（Toolhelp 遍历全表，锁内做会拖住 TermWrite）
	terminals.mu.Lock()
	candidates := make([]*termSession, 0, len(terminals.sessions))
	for _, s := range terminals.sessions {
		s.bufMu.Lock()
		alive := !s.exited
		s.bufMu.Unlock()
		if alive && s.shellPID != 0 {
			candidates = append(candidates, s)
		}
	}
	terminals.mu.Unlock()
	n := 0
	for _, s := range candidates {
		if hasAliveDescendant(s.shellPID) {
			n++
		}
	}
	return n
}

// ===== 进程存活检测 =====
// procInfo 是进程快照的一行（只取枚举需要的字段）。
type procInfo struct {
	pid  uint32
	ppid uint32
}

// descendantExists 判定 self 在给定进程表中是否有后代（BFS，环安全）。
// 纯函数：真实快照在 hasAliveDescendant，测试喂构造数据（父子环 / 多级 / 无子）。
func descendantExists(self uint32, procs []procInfo) bool {
	children := make(map[uint32][]uint32)
	for _, p := range procs {
		if p.pid == self {
			continue // 自身不进表：父 PID 偶然指向自己时不至于自环
		}
		children[p.ppid] = append(children[p.ppid], p.pid)
	}
	queue := children[self]
	seen := make(map[uint32]bool)
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if seen[id] {
			continue
		}
		seen[id] = true
		queue = append(queue, children[id]...)
	}
	return len(seen) > 0
}

// hasAliveDescendant 用 Toolhelp32 快照判定 rootPID 是否有活着的后代进程。
// 快照失败按「有后代」处理（fail-closed）：关窗确认宁多拦不误杀。
func hasAliveDescendant(rootPID uint32) bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return true
	}
	defer windows.CloseHandle(snap)
	procs := make([]procInfo, 0, 256)
	entry := windows.ProcessEntry32{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	for first := true; ; first = false {
		var err error
		if first {
			err = windows.Process32First(snap, &entry)
		} else {
			err = windows.Process32Next(snap, &entry)
		}
		if err != nil {
			break // ERROR_NO_MORE_FILES = 遍历完成
		}
		procs = append(procs, procInfo{pid: entry.ProcessID, ppid: entry.ParentProcessID})
	}
	return descendantExists(rootPID, procs)
}

// lastTermLine 抽最后一行非空输出，供 TermList 给 AI 一个「终端现在停在哪」的线索。
func lastTermLine(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if len(line) > 160 {
			line = line[len(line)-160:]
		}
		return line
	}
	return ""
}

// ===== Shell 列表 =====
// TermShells 返回本机可用的 shell 列表（供新建终端菜单），默认 shell 排在最前。
func (t *Terminal) TermShells() []map[string]string {
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
