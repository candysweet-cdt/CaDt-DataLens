package appservices

// 进程的启动/停止/日志与健康检查。进程启停复用 procctl（取消杀整棵进程树），
// 防黑窗走 executil；本文件不出现平台相关符号。

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"datalens/internal/envvars"
	"datalens/internal/executil"
	"datalens/internal/procctl"
)

// start 启动一个服务。状态为 running/starting 时幂等返回。
func (r *Registry) start(svc *service) error {
	svc.mu.Lock()
	if svc.state == StateRunning || svc.state == StateStarting {
		svc.mu.Unlock()
		return nil
	}
	svc.state = StateStarting
	svc.lastError = ""
	svc.stopping = false
	svc.mu.Unlock()

	// 工作目录先校验再起进程：cwd 不存在时 Windows 的 CreateProcess 只会回
	// "The directory name is invalid"，看不出是哪个目录缺了，插件作者只能猜。
	dir := strings.TrimSpace(svc.spec.Cwd)
	if dir != "" {
		info, statErr := os.Stat(dir)
		if statErr != nil {
			return r.markStartFailed(svc, fmt.Errorf("工作目录不可用：%s（%v）", dir, statErr))
		}
		if !info.IsDir() {
			return r.markStartFailed(svc, fmt.Errorf("工作目录不是目录：%s", dir))
		}
	}

	// ctx 必须先于 exec 创建：procctl.ApplyCancel 会写 cmd.Cancel，而 os/exec 只接受
	// 「由 CommandContext 创建」的命令带 Cancel，裸 exec.Command 会在 cmd.Start()
	// 直接报 "command with a non-nil Cancel was not created with CommandContext"。
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, svc.spec.Exe, svc.spec.Args...)
	procctlApplyCancel(cmd)
	cmd.Dir = dir
	cmd.Env = envvars.SanitizeChildEnv(os.Environ())
	executilHideWindow(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return r.markStartFailed(svc, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return r.markStartFailed(svc, err)
	}

	if err := procctlRegister(procIDPrefix+svc.spec.ID, cancel); err != nil {
		cancel()
		return r.markStartFailed(svc, err)
	}
	if err := cmd.Start(); err != nil {
		procctlStop(procIDPrefix + svc.spec.ID)
		return r.markStartFailed(svc, err)
	}

	svc.mu.Lock()
	svc.pid = cmd.Process.Pid
	svc.startedAt = time.Now().UnixMilli()
	svc.state = StateRunning
	svc.healthOK = svc.spec.HealthURL == ""
	svc.healthFailed = false // 新一轮启动，上一轮的健康判死标记不能带过来
	svc.stopping = false
	healthCtx, healthCancel := context.WithCancel(ctx)
	svc.healthCancel = healthCancel
	svc.mu.Unlock()

	go r.pumpOutput(svc, stdout)
	go r.pumpOutput(svc, stderr)
	go r.watchProcess(svc, cmd, ctx, healthCancel)
	if svc.spec.HealthURL != "" {
		go r.watchHealth(svc, healthCtx)
	}
	logf("info", "后台服务 %s 已启动（pid %d）", svc.spec.ID, svc.pid)
	return nil
}

func (r *Registry) markStartFailed(svc *service, err error) error {
	svc.mu.Lock()
	svc.state = StateFailed
	svc.pid = 0
	svc.lastError = err.Error()
	svc.mu.Unlock()
	return fmt.Errorf("启动服务 %s 失败：%w", svc.spec.ID, err)
}

// stopLocked 停止服务。调用方必须持有 r.mu；本函数只操作 svc.mu，不回拿 r.mu。
func (r *Registry) stopLocked(svc *service) {
	svc.mu.Lock()
	wasActive := svc.state != StateStopped
	svc.stopping = true
	if svc.healthCancel != nil {
		svc.healthCancel()
		svc.healthCancel = nil
	}
	svc.mu.Unlock()
	if !wasActive {
		return
	}
	procctlStop(procIDPrefix + svc.spec.ID)
	svc.mu.Lock()
	svc.state = StateStopped
	svc.pid = 0
	svc.lastError = ""
	svc.healthOK = svc.spec.HealthURL == ""
	svc.mu.Unlock()
	logf("info", "后台服务 %s 已停止", svc.spec.ID)
}

// pumpOutput 按行读取子进程输出，写进环形日志缓冲。
func (r *Registry) pumpOutput(svc *service, reader io.Reader) {
	br := bufio.NewReader(reader)
	for {
		line, err := br.ReadString('\n')
		if text := strings.TrimRight(line, "\r\n"); text != "" {
			svc.appendLog(text)
		}
		if err != nil {
			return
		}
	}
}

func (s *service) appendLog(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	size := len(line) + 1
	s.logs = append(s.logs, line)
	s.logBytes += size
	for s.logBytes > s.spec.LogCapBytes && len(s.logs) > 1 {
		s.logBytes -= len(s.logs[0]) + 1
		s.logs = s.logs[1:]
	}
}

// watchProcess 等待进程退出：自然退出（非主动停止）标记 failed；主动停止的收尾由 stopLocked 完成。
func (r *Registry) watchProcess(svc *service, cmd *exec.Cmd, ctx context.Context, healthCancel context.CancelFunc) {
	err := cmd.Wait()
	defer healthCancel()
	defer procctlStop(procIDPrefix + svc.spec.ID)
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if svc.stopping {
		return
	}
	svc.state = StateFailed
	svc.pid = 0
	// 健康检查判死后是我们主动杀的：保留"健康检查连续失败"这个更准确的原因，
	// 不要被退出码文案覆盖。
	if !svc.healthFailed {
		if err != nil {
			svc.lastError = err.Error()
		} else {
			svc.lastError = "进程已退出"
		}
	}
	svc.healthOK = false
	logf("warn", "后台服务 %s 意外退出：%s", svc.spec.ID, svc.lastError)
}

// watchHealth 定期探活；连续失败 healthFailThreshold 次置 failed。进程已退出时本协程随 healthCancel 结束。
func (r *Registry) watchHealth(svc *service, ctx context.Context) {
	interval := time.Duration(svc.spec.PollIntervalMs) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	fails := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		ok := r.probe(svc.spec.HealthURL)
		svc.mu.Lock()
		if svc.stopping || svc.state != StateRunning {
			svc.mu.Unlock()
			return
		}
		if ok {
			fails = 0
			svc.healthOK = true
		} else {
			fails++
			svc.healthOK = false
			if fails >= healthFailThreshold {
				svc.state = StateFailed
				svc.lastError = "健康检查连续失败：" + svc.spec.HealthURL
				svc.healthFailed = true
				svc.mu.Unlock()
				logf("warn", "%s", svc.lastError)
				// 判死之后必须把进程收掉：否则 procctl 的任务 id 一直被占，
				// 用户点 Start 只会反复报"任务 id 已在运行"，服务再也起不来。
				// 这里只杀进程（不置 stopped），由 watchProcess 完成退出收尾。
				procctlStop(procIDPrefix + svc.spec.ID)
				return
			}
		}
		lastErr := svc.lastError
		svc.mu.Unlock()
		_ = lastErr
	}
}

func (r *Registry) probe(url string) bool {
	resp, err := r.client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	return resp.StatusCode < 500
}

// 以下 indirection 便于单测替换（避免在测试里真起进程）；默认指向真实实现。
var (
	procctlApplyCancel = procctl.ApplyCancel
	executilHideWindow = executil.HideCommandWindow
	procctlRegister    = procctl.Register
	procctlStop        = procctl.Stop
)
