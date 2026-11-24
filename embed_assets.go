package main

// embed_assets.go：内嵌资源的根壳（`//go:embed` 路径必须以包目录为基准，
// 所以这些 embed.FS 变量只能留在仓库根，资源本体由各 internal 包消费）。
//
// 三份资源合并前各占一个文件（skills.go / mcp_samples.go / desktop_mcp.go），
// 都只是「embed + 注入 + 少量装配」。分节标题保留原文件名便于追溯。

import (
	"embed"

	"datalens/internal/desktopmcp"
	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
	"datalens/internal/skills"
)

// ---- 内置技能（原 skills.go）----

//go:embed all:docs/skills
var skillAssets embed.FS

// ---- 内置 MCP 示例脚本（原 mcp_samples.go）----

//go:embed docs/mcp-samples/tts-sapi.ps1 docs/mcp-samples/ocr-windows.ps1 docs/mcp-samples/asr-whisper.py
var mcpSampleFS embed.FS

// ---- 内置桌面控制组件（原 desktop_mcp.go）----

//go:embed docs/mcp-desktop/windows_mcp-0.8.9+p3-py3-none-any.whl
var desktopMcpFS embed.FS

func init() {
	skills.Embedded = skillAssets
	skills.Version = appVersion
	skills.Logf = writeAppLog

	mcpsamples.Embedded = mcpSampleFS
	mcpsamples.Version = appVersion
	// 启动前自愈在 prepareMCPServers 里组合注入（与内置桌面 wheel 共用一个
	// mcp.PrepareServer 钩子）：脚本被存储清理删掉 / 版本升级换了目录时，按 mcp.json
	// 里的原路径补回，否则已注册的示例服务器会初始化失败十次后放弃
	// （见 storage specs 的 builtin-mcp-samples）。

	desktopmcp.Embedded = desktopMcpFS
	// 转发闭包而不是直接取函数值（2026-11-23 审查 M3）：同包 init 按文件名字典序执行，
	// 本文件早于 host_wiring.go（后者才把 mcp.Logf 赋成 writeAppLog），直接 `= mcp.Logf`
	// 会永久捕获 nil，自愈日志全部静默——恰是最需要诊断的场景。
	desktopmcp.Logf = func(level, format string, args ...any) {
		if mcp.Logf != nil {
			mcp.Logf(level, format, args...)
		}
	}
	// 安装进度事件出口：与其它引擎一样走应用级广播（emitAppEvent 是变参签名，
	// 这里收窄成单载荷）。
	desktopmcp.Emit = func(event string, data any) { emitAppEvent(event, data) }
	mcp.PrepareServer = prepareMCPServers
}

// MCPInstallSample 覆盖内嵌 *mcpsamples.Samples 的提升方法：释放脚本 + 写盘之后，把 mcp.json
// 现状应用到运行态管理器。其它写盘路径（MCPWriteConfig / MCPSetServerEnabled）自带 ApplyConfig；
// 只有示例安装绕过 Client 直接写盘，漏了这步新 server 不进 m.servers，MCPSnapshot 的惰性启动
// 看不到它、也不发 mcp-tools-changed——表现就是「装好了列表不刷新，退出重进才出现」。
func (a *App) MCPInstallSample(id string) (map[string]interface{}, error) {
	result, err := a.Samples.MCPInstallSample(id)
	if err != nil {
		return nil, err
	}
	// 应用失败不回滚已写盘的配置（脚本与条目已落盘，重启仍生效），只记日志；前端安装后
	// 的 refreshMcpConfig 兜底拉取也会再试一次。
	if err := mcp.ApplyConfigFromDisk(a.Client); err != nil {
		writeAppLog("warn", "MCP 示例安装后应用配置失败：%v", err)
	}
	return result, nil
}

// prepareMCPServers 是所有内嵌 MCP 资源家族共用的 spawn 前自愈入口。
func prepareMCPServers(cfg mcp.MCPServerConfig) {
	mcpsamples.EnsureServerScript(cfg)
	desktopmcp.EnsureServerWheel(cfg)
}
