package desktopmcp

// service.go：Wails 绑定承载类型（原根 mcp_desktop_app.go）。App 匿名嵌入 *Service 后，
// 下面五个导出方法自动进 *App 方法集，前端 FQN 仍是 main.App.MCPDesktop<x>。
//
// 这里承担三件事：
//   - MCPDesktopPlan 只读快照：配置行 + 全部工具（前端据此渲染工具开关，默认全选）；
//   - MCPDesktopInstallStart 异步安装：立即返回，进度经 mcp-desktop-install 事件推送
//     （用户要的是「打开开关就装，下面显示进度条」，不是阻塞式等 15 分钟）；
//   - MCPDesktopDoctor uv 探测：纯读、无子进程。
// 同步版 MCPDesktopInstall 保留（无进度事件，内部走同一引擎），供测试与兼容调用。
//
// 事件出口由根 host_wiring.go 注入（Emit），本包不碰 Wails。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Emit 是宿主注入的事件出口（应用级广播）。未注入时静默——安装仍会完成，
// 只是前端收不到进度（测试/无窗口场景）。
var Emit func(event string, data any)

// 安装预算与事件名。
const (
	// InstallTimeout 首次下载 Python 3.14 解释器 + 21 个依赖的预算（实测量级数分钟）。
	InstallTimeout   = 20 * time.Minute
	installEventName = "mcp-desktop-install"
)

// InstallResult 同步安装结果。
type InstallResult struct {
	Ok    bool     `json:"ok"`
	Error string   `json:"error,omitempty"`
	Steps []string `json:"steps,omitempty"`
}

// InstallStartResult 异步安装的启动回执：Busy=true 表示已有作业在跑。
type InstallStartResult struct {
	Started bool `json:"started"`
	Busy    bool `json:"busy,omitempty"`
}

// installEventPayload 推给前端的事件体。
type installEventPayload struct {
	Phase   string   `json:"phase"` // running / done / error
	Stage   string   `json:"stage,omitempty"`
	Detail  string   `json:"detail,omitempty"`
	Percent int      `json:"percent"`
	Line    string   `json:"line,omitempty"`
	Error   string   `json:"error,omitempty"`
	Steps   []string `json:"steps,omitempty"`
}

// installState 安装作业的跨调用状态：进程内单例，前端重开页面时可用
// MCPDesktopInstallStatus 把进度条恢复回来（事件只在推送时刻有效）。
type installState struct {
	mu       sync.Mutex
	running  bool
	done     bool
	failed   bool
	errText  string
	progress Progress
}

var desktopInstall installState

// DoctorResult 桌面 doctor 的探测结果（前端拼进诊断面板）。
type DoctorResult struct {
	UVFound     bool     `json:"uvFound"`     // uv 在 PATH 上（uvx 可直接用）
	UVPath      string   `json:"uvPath"`      // PATH 命中的 uv 可执行文件路径
	UVHomeFound bool     `json:"uvHomeFound"` // uv 在 %USERPROFILE%\.local\bin（官方安装器默认位，可能不在 PATH）
	UVHome      string   `json:"uvHome"`      // 该候选路径（无论是否存在，供前端给安装提示）
	Hints       []string `json:"hints,omitempty"`
}

// Service 是桌面控制（windows-mcp）的绑定承载类型。
type Service struct{}

// MCPDesktopPlan 只读快照：不释放 wheel、不起进程。
func (s *Service) MCPDesktopPlan() Plan {
	return BuildPlan()
}

// MCPDesktopInstallStatus 查安装作业状态（含最后一次进度），供页面重建时恢复 UI。
func (s *Service) MCPDesktopInstallStatus() map[string]any {
	desktopInstall.mu.Lock()
	defer desktopInstall.mu.Unlock()
	return map[string]any{
		"running":  desktopInstall.running,
		"done":     desktopInstall.done,
		"failed":   desktopInstall.failed,
		"error":    desktopInstall.errText,
		"progress": desktopInstall.progress,
	}
}

// MCPDesktopInstall 同步安装（阻塞到完成，无进度事件）。
func (s *Service) MCPDesktopInstall() InstallResult {
	ctx, cancel := context.WithTimeout(context.Background(), InstallTimeout)
	defer cancel()
	steps, err := Install(ctx, nil)
	result := InstallResult{Steps: steps}
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Ok = true
	return result
}

// MCPDesktopInstallStart 异步安装：立即返回，进度与结果经 mcp-desktop-install 事件推送。
// 同一时刻只允许一个作业（重复点击返回 Busy，不排队、不打断正在跑的下载）。
func (s *Service) MCPDesktopInstallStart() InstallStartResult {
	desktopInstall.mu.Lock()
	if desktopInstall.running {
		desktopInstall.mu.Unlock()
		return InstallStartResult{Busy: true}
	}
	desktopInstall.running = true
	desktopInstall.done = false
	desktopInstall.failed = false
	desktopInstall.errText = ""
	desktopInstall.progress = Progress{Stage: StageWheel, Detail: "准备安装", Percent: 1}
	desktopInstall.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), InstallTimeout)
		defer cancel()
		defer func() {
			desktopInstall.mu.Lock()
			desktopInstall.running = false
			desktopInstall.mu.Unlock()
		}()
		emitEvent(installEventPayload{
			Phase: "running", Stage: StageWheel, Detail: "准备安装", Percent: 1,
		})
		steps, err := Install(ctx, func(p Progress) {
			desktopInstall.mu.Lock()
			desktopInstall.progress = p
			desktopInstall.mu.Unlock()
			emitEvent(installEventPayload{
				Phase: "running", Stage: p.Stage, Detail: p.Detail, Percent: p.Percent, Line: p.Line,
			})
		})
		if err != nil {
			desktopInstall.mu.Lock()
			desktopInstall.failed = true
			desktopInstall.errText = err.Error()
			desktopInstall.mu.Unlock()
			emitEvent(installEventPayload{
				Phase: "error", Stage: StageDone, Percent: 100,
				Error: err.Error(), Steps: steps,
			})
			return
		}
		desktopInstall.mu.Lock()
		desktopInstall.done = true
		desktopInstall.progress = Progress{Stage: StageDone, Detail: "安装完成", Percent: 100}
		desktopInstall.mu.Unlock()
		emitEvent(installEventPayload{
			Phase: "done", Stage: StageDone, Detail: "安装完成", Percent: 100, Steps: steps,
		})
	}()
	return InstallStartResult{Started: true}
}

// MCPDesktopDoctor 解析 uv 的位置。纯读、无子进程（LookPath 只查目录，不执行）、
// 无副作用；首次安装说明由前端按结果拼。
func (s *Service) MCPDesktopDoctor() DoctorResult {
	result := DoctorResult{}
	if path, err := exec.LookPath("uv"); err == nil {
		result.UVFound = true
		result.UVPath = path
	}
	home, err := os.UserHomeDir()
	for _, candidate := range resolveUvCandidates(home) {
		result.UVHome = candidate
		if _, statErr := os.Stat(candidate); statErr == nil {
			result.UVHomeFound = true
		}
	}
	if err != nil {
		result.Hints = append(result.Hints, "无法定位用户主目录："+err.Error())
	}
	if !result.UVFound && !result.UVHomeFound {
		result.Hints = append(result.Hints,
			"未找到 uv：桌面 server 依赖它启动 windows-mcp（首次运行会下载 Python 3.14 解释器与依赖，约 100–190 MB）。",
			"安装命令：powershell -ExecutionPolicy Bypass -Command \"irm https://astral.sh/uv/install.ps1 | iex\"（装到用户目录，免管理员；装完重开应用生效）。")
	} else if !result.UVFound && result.UVHomeFound {
		result.Hints = append(result.Hints,
			"uv 在用户目录但不在 PATH："+result.UVHome+"。桌面控制安装流程会直接用它，无需改 PATH。")
	}
	return result
}

// resolveUvCandidates 纯函数：PATH 之外的 uv 探测位置——官方安装脚本默认装到
// 用户主目录 .local\bin。home 为空返回 nil。Windows 上安装的是 uv.exe 而 os.Stat
// 不做 PATHEXT 解析——候选必须显式带扩展名，同时保留无扩展名形态覆盖非 Windows。
func resolveUvCandidates(home string) []string {
	if home == "" {
		return nil
	}
	bin := filepath.Join(home, ".local", "bin")
	return []string{
		filepath.Join(bin, "uv.exe"),
		filepath.Join(bin, "uv"),
	}
}

// emitEvent 经宿主注入的出口广播；未注入时静默。
func emitEvent(payload installEventPayload) {
	if Emit == nil {
		return
	}
	Emit(installEventName, payload)
}
