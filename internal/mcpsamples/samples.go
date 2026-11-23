// mcp_samples.go：内置 MCP 示例——脚本随 exe 内嵌，按需释放到应用数据目录并合并进 mcp.json。
// 只内置脚本，不内置 Python / whisper 模型 / OCR 引擎（体积红线）；运行时由系统或用户提供。
package mcpsamples

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/mcp"
)

// Samples 内置 MCP 示例的列出与安装。
type Samples struct{}

var (
	// Embedded 随 exe 分发的 docs/mcp-samples 资源（main/mcp_samples.go 注入）。
	Embedded fs.FS
	// Version 应用版本，用于释放目录隔离。
	Version = ""
)

type mcpSampleDef struct {
	ID            string
	Name          string
	Description   string
	Capability    string
	File          string
	Command       string
	PrepArgs      []string
	ToolName      string
	EnvKeys       []string
	Prerequisites []string
}

var mcpSampleDefs = []mcpSampleDef{
	// tts_sapi 的 Command 必须是 Win10/11 自带的 Windows PowerShell 5.1（powershell.exe），
	// 不能写 pwsh：pwsh 是需另装的 PowerShell 7，干净系统上 exec 找不到它，server 直接
	// state=failed、toolCount=0（2026-11-23 实测：装完即失败，改成 powershell 立刻 connected）。
	// 脚本本身只用 System.Speech，5.1 下完全可用；与 ocr_windows 示例保持同一约定。
	{
		ID: "tts_sapi", Name: "Windows 语音合成（SAPI）",
		Description: "用系统 SAPI 把文本合成 WAV 文件，离线、零安装。",
		Capability:  "tts", File: "tts-sapi.ps1", Command: "powershell",
		PrepArgs: []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, ToolName: "tts_sapi",
		Prerequisites: []string{"Windows PowerShell 5.1（Win10/11 自带，无需另装 PowerShell 7）", "无需联网"},
	},
	{
		ID: "ocr_windows", Name: "Windows OCR（系统引擎）",
		Description: "用 Windows.Media.Ocr 识别图片中的文字；PDF 需先转成图片。",
		Capability:  "ocr", File: "ocr-windows.ps1", Command: "powershell",
		PrepArgs: []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, ToolName: "ocr_windows",
		Prerequisites: []string{"Windows PowerShell 5.1（WinRT 投影）", "对应语言的 OCR 语言包（中文需安装）"},
	},
	{
		ID: "asr_whisper", Name: "whisper.cpp 语音识别",
		Description: "用本机 whisper.cpp 把音频转成文字。",
		Capability:  "asr", File: "asr-whisper.py", Command: "python",
		PrepArgs: []string{"-u"}, ToolName: "asr_whisper",
		EnvKeys:       []string{"WHISPER_CLI", "WHISPER_MODEL"},
		Prerequisites: []string{"Python 3.9+", "whisper.cpp（whisper-cli.exe）", "ggml 模型（自备，不随应用分发）"},
	},
}

// MCPSampleInfo 给设置页与 AI 的示例元数据；Installed 只看 mcp.json 是否有同名服务器。
type MCPSampleInfo struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Capability     string   `json:"capability"`
	ServerName     string   `json:"serverName"`
	ToolName       string   `json:"toolName"`
	PublicToolName string   `json:"publicToolName"`
	Prerequisites  []string `json:"prerequisites"`
	EnvKeys        []string `json:"envKeys"`
	Installed      bool     `json:"installed"`
	ScriptPath     string   `json:"scriptPath"`
	ScriptExists   bool     `json:"scriptExists"`
	CommandPreview string   `json:"commandPreview"`
	ClientEnabled  bool     `json:"clientEnabled"`
}

func mcpSampleByID(id string) (mcpSampleDef, bool) {
	key := strings.TrimSpace(id)
	for _, def := range mcpSampleDefs {
		if def.ID == key {
			return def, true
		}
	}
	return mcpSampleDef{}, false
}

func mcpSamplesRoot() string {
	if path := mcp.ConfigFilePath(); path != "" {
		return filepath.Dir(path)
	}
	return appdata.Root()
}

func mcpSamplesDir() string {
	root := mcpSamplesRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "builtin-mcp-samples", Version)
}

func mcpSampleScriptPath(def mcpSampleDef) string {
	dir := mcpSamplesDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, def.File)
}

func mcpSamplePublicToolName(def mcpSampleDef) string {
	return "mcp__" + def.ServerName() + "__" + def.ToolName
}

// ServerName 示例的服务器名与 ID 一致（都是合法 MCP 名）。
func (d mcpSampleDef) ServerName() string { return d.ID }

func mcpSampleCommandPreview(def mcpSampleDef, scriptPath string) string {
	parts := []string{def.Command}
	parts = append(parts, def.PrepArgs...)
	parts = append(parts, scriptPath)
	for i, part := range parts {
		if strings.ContainsAny(part, " \t") {
			parts[i] = `"` + part + `"`
		}
	}
	return strings.Join(parts, " ")
}

func mcpSampleServerConfig(def mcpSampleDef, scriptPath string) mcp.MCPServerConfig {
	args := append([]string{}, def.PrepArgs...)
	args = append(args, scriptPath)
	server := mcp.MCPServerConfig{
		Command:      def.Command,
		Args:         args,
		EnabledTools: []string{def.ToolName},
	}
	if len(def.EnvKeys) > 0 {
		server.Env = make(map[string]string, len(def.EnvKeys))
		for _, key := range def.EnvKeys {
			server.Env[key] = ""
		}
	}
	return server
}

func materializeMCPSample(def mcpSampleDef) (string, error) {
	path := mcpSampleScriptPath(def)
	if path == "" {
		return "", appdata.ErrNoRoot
	}
	return writeSampleScript(def, path)
}

// writeSampleScript 把内嵌脚本写到指定路径（内容一致则跳过）。调用方负责路径合法性。
func writeSampleScript(def mcpSampleDef, path string) (string, error) {
	raw, err := fs.ReadFile(Embedded, "docs/mcp-samples/"+def.File)
	if err != nil {
		return "", fmt.Errorf("内置示例缺失：%w", err)
	}
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, raw) {
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := atomfile.WriteFileAtomicMode(path, raw, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// sampleScriptInConfig 找出 cfg 参数里指向「我们自己释放的示例脚本」的路径。
// 只认 <应用数据>/builtin-mcp-samples/ 下的同名文件：用户在别处自备一份同名脚本时
// （README 也支持单独分发），绝不去覆盖它。
func sampleScriptInConfig(def mcpSampleDef, cfg mcp.MCPServerConfig) string {
	root := mcpSamplesRoot()
	if root == "" {
		return ""
	}
	base := filepath.Join(root, "builtin-mcp-samples")
	for _, arg := range cfg.Args {
		raw := strings.TrimSpace(arg)
		if raw == "" || !strings.EqualFold(filepath.Base(raw), def.File) {
			continue
		}
		abs, err := filepath.Abs(raw)
		if err != nil {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(abs), strings.ToLower(base)+string(os.PathSeparator)) {
			continue
		}
		return abs
	}
	return ""
}

// EnsureServerScript 是 mcp.PrepareServer 的实现：服务器每次 spawn 前的自愈。
// 触发场景都是真实的：设置 → 存储清理把 builtin-mcp-samples 当缓存删掉（脚本没了、
// mcp.json 里的绝对路径还在），或版本升级后释放目录变成新版本号而配置仍指旧路径。
// 两种情况下没有这条路径，已注册的服务器会初始化失败十次后放弃，日志被启动横幅刷屏。
func EnsureServerScript(cfg mcp.MCPServerConfig) {
	for _, def := range mcpSampleDefs {
		path := sampleScriptInConfig(def, cfg)
		if path == "" {
			continue
		}
		if _, err := os.Stat(path); err == nil {
			continue
		}
		if _, err := writeSampleScript(def, path); err != nil {
			logSamplef("warn", "内置 MCP 示例脚本补回失败（%s）：%v", path, err)
			return
		}
		logSamplef("info", "内置 MCP 示例脚本已补回：%s", path)
	}
}

func logSamplef(level, format string, args ...any) {
	if mcp.Logf != nil {
		mcp.Logf(level, format, args...)
	}
}

// MCPSamplesList 列出内置示例；只读，不释放脚本。
func (s *Samples) MCPSamplesList() ([]MCPSampleInfo, error) {
	cfg, err := mcp.ReadConfig()
	if err != nil {
		return nil, err
	}
	out := make([]MCPSampleInfo, 0, len(mcpSampleDefs))
	for _, def := range mcpSampleDefs {
		path := mcpSampleScriptPath(def)
		_, statErr := os.Stat(path)
		_, installed := cfg.MCPServers[def.ServerName()]
		out = append(out, MCPSampleInfo{
			ID: def.ID, Name: def.Name, Description: def.Description, Capability: def.Capability,
			ServerName: def.ServerName(), ToolName: def.ToolName, PublicToolName: mcpSamplePublicToolName(def),
			Prerequisites: def.Prerequisites, EnvKeys: def.EnvKeys,
			Installed: installed, ScriptPath: path, ScriptExists: statErr == nil,
			CommandPreview: mcpSampleCommandPreview(def, path),
			ClientEnabled:  cfg.Enabled == nil || *cfg.Enabled,
		})
	}
	return out, nil
}

// MCPInstallSample 释放示例脚本并合并进 mcp.json（同名服务器已存在时拒绝，不覆盖用户配置）。
// 会释放脚本并在本机注册服务器；调用方（设置页 / AI 审批卡）必须先向用户确认命令。
func (s *Samples) MCPInstallSample(id string) (map[string]interface{}, error) {
	def, ok := mcpSampleByID(id)
	if !ok {
		return nil, errors.New("未知内置示例：" + id)
	}
	cfg, err := mcp.ReadConfig()
	if err != nil {
		return nil, err
	}
	if cfg.MCPServers == nil {
		cfg.MCPServers = map[string]mcp.MCPServerConfig{}
	}
	if _, exists := cfg.MCPServers[def.ServerName()]; exists {
		// 已注册但脚本被清掉了（存储清理 / 版本升级）：只补回脚本，不动用户改过的
		// EnabledTools / Env——否则这里一律报「已存在同名服务器」，用户没有出路，
		// 只能先删条目再重装，等于配置永久失效。
		if missing := sampleScriptInConfig(def, cfg.MCPServers[def.ServerName()]); missing != "" {
			if _, statErr := os.Stat(missing); statErr != nil {
				if _, err := writeSampleScript(def, missing); err != nil {
					return nil, err
				}
				note := "已存在同名服务器，但脚本缺失：已按原路径补回脚本，服务器配置未改动。"
				if cfg.Enabled != nil && !*cfg.Enabled {
					note += " MCP 客户端总开关当前是关闭的，需要用户开启。"
				}
				return map[string]interface{}{
					"installed":      true,
					"repaired":       true,
					"id":             def.ID,
					"name":           def.Name,
					"serverName":     def.ServerName(),
					"toolName":       def.ToolName,
					"publicToolName": mcpSamplePublicToolName(def),
					"scriptPath":     missing,
					"commandPreview": mcpSampleCommandPreview(def, missing),
					"envKeys":        def.EnvKeys,
					"note":           note,
				}, nil
			}
		}
		return nil, fmt.Errorf("已存在同名 MCP 服务器 %q；请先在设置里删除或改名后再安装示例", def.ServerName())
	}
	path, err := materializeMCPSample(def)
	if err != nil {
		return nil, err
	}
	cfg.MCPServers[def.ServerName()] = mcpSampleServerConfig(def, path)
	if cfg.Version == 0 {
		cfg.Version = 1
	}
	if err := mcp.WriteConfig(cfg); err != nil {
		return nil, err
	}
	note := "示例已释放并写入 MCP 配置。"
	if len(def.EnvKeys) > 0 {
		note += "请让用户在 设置 → AI → 外部工具 → MCP 服务器 → 编辑 里填写环境变量值（" + strings.Join(def.EnvKeys, "、") + "）。"
	}
	note += "需要把它作为外部能力来源时，在「能力来源」把对应能力绑定到 " + mcpSamplePublicToolName(def) + "。"
	if cfg.Enabled != nil && !*cfg.Enabled {
		note += " MCP 客户端总开关当前是关闭的，需要用户开启。"
	}
	return map[string]interface{}{
		"installed":      true,
		"id":             def.ID,
		"name":           def.Name,
		"serverName":     def.ServerName(),
		"toolName":       def.ToolName,
		"publicToolName": mcpSamplePublicToolName(def),
		"scriptPath":     path,
		"commandPreview": mcpSampleCommandPreview(def, path),
		"envKeys":        def.EnvKeys,
		"note":           note,
	}, nil
}
