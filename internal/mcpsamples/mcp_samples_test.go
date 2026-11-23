package mcpsamples

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"datalens/internal/mcp"
)

func init() {
	Embedded = os.DirFS("../..")
	Version = "test"
}

func TestBuiltinMCPSamples(t *testing.T) {
	appDir := t.TempDir()
	oldAppDataDir := mcp.AppDataDir
	mcp.AppDataDir = func() string { return appDir }
	defer func() { mcp.AppDataDir = oldAppDataDir }()

	app := &Samples{}
	list, err := app.MCPSamplesList()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != len(mcpSampleDefs) {
		t.Fatalf("示例数 = %d，期望 %d", len(list), len(mcpSampleDefs))
	}
	for _, info := range list {
		if info.Installed || info.ScriptExists {
			t.Fatalf("初始状态不应已安装/已释放：%+v", info)
		}
		if !strings.Contains(info.CommandPreview, info.ScriptPath) {
			t.Fatalf("命令预览缺脚本路径：%q", info.CommandPreview)
		}
	}

	result, err := app.MCPInstallSample("tts_sapi")
	if err != nil {
		t.Fatal(err)
	}
	if result["installed"] != true || result["publicToolName"] != "mcp__tts_sapi__tts_sapi" {
		t.Fatalf("安装结果 = %+v", result)
	}
	scriptPath, _ := result["scriptPath"].(string)
	if _, err := os.Stat(scriptPath); err != nil {
		t.Fatalf("脚本未释放：%v", err)
	}
	cfg, err := mcp.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	server, ok := cfg.MCPServers["tts_sapi"]
	if !ok {
		t.Fatal("mcp.json 未写入 tts_sapi")
	}
	if len(server.EnabledTools) != 1 || server.EnabledTools[0] != "tts_sapi" {
		t.Fatalf("示例工具未授权：%+v", server.EnabledTools)
	}
	if len(server.Args) == 0 || server.Args[len(server.Args)-1] != scriptPath {
		t.Fatalf("服务器参数未指向释放的脚本：%+v", server.Args)
	}
	if _, err := app.MCPInstallSample("tts_sapi"); err == nil {
		t.Fatal("同名服务器已存在时应拒绝安装")
	}

	asr, err := app.MCPInstallSample("asr_whisper")
	if err != nil {
		t.Fatal(err)
	}
	if keys, _ := asr["envKeys"].([]string); len(keys) != 2 {
		t.Fatalf("ASR 示例应登记两个环境变量键：%+v", asr["envKeys"])
	}
	cfg, err = mcp.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	asrServer := cfg.MCPServers["asr_whisper"]
	for _, key := range []string{"WHISPER_CLI", "WHISPER_MODEL"} {
		if value, ok := asrServer.Env[key]; !ok || value != "" {
			t.Fatalf("环境变量 %s 应存在且为空：%+v", key, asrServer.Env)
		}
	}

	list, err = app.MCPSamplesList()
	if err != nil {
		t.Fatal(err)
	}
	installed := map[string]bool{}
	for _, info := range list {
		installed[info.ID] = info.Installed
	}
	if !installed["tts_sapi"] || !installed["asr_whisper"] || installed["ocr_windows"] {
		t.Fatalf("安装状态不对：%+v", installed)
	}
}

// 内置示例的启动命令必须在「干净系统」上就能跑：tts_sapi 曾经写成 pwsh（PowerShell 7，
// 需另装），而前置条件写的是「Windows 自带 PowerShell（pwsh 7 或 5.1）」——Win10/11 自带的
// 是 powershell.exe(5.1)。实测干净机器上装完即 state=failed、toolCount=0，把 command 改成
// powershell 后立刻 connected。这里按注册表整体断言，防止以后再把手写命令写成「需另装的解释器」。
func TestBuiltinSampleCommandsResolveOnCleanSystem(t *testing.T) {
	// 期望值 = 「干净 Win10/11 上直接可执行」的启动命令（asr 的 python 由前置条件声明为自备）
	want := map[string]string{
		"tts_sapi":    "powershell",
		"ocr_windows": "powershell",
		"asr_whisper": "python",
	}
	for id, command := range want {
		def, ok := mcpSampleByID(id)
		if !ok {
			t.Fatalf("缺少内置示例 %s", id)
		}
		if def.Command != command {
			t.Fatalf("示例 %s 的启动命令 = %q，期望 %q", id, def.Command, command)
		}
	}
	tts, _ := mcpSampleByID("tts_sapi")
	// 前置条件不能再承诺 pwsh（会让人以为要装 PowerShell 7；与 command 自相矛盾）
	for _, item := range tts.Prerequisites {
		if strings.Contains(strings.ToLower(item), "pwsh") {
			t.Fatalf("tts_sapi 的前置条件仍提到 pwsh：%q", item)
		}
	}
	if preview := mcpSampleCommandPreview(tts, `C:\x\tts-sapi.ps1`); !strings.HasPrefix(preview, "powershell ") {
		t.Fatalf("命令预览应以 powershell 开头：%q", preview)
	}
}

// overrideAppData 把应用数据目录临时指到 temp（与 TestBuiltinMCPSamples 同款手法）。
func overrideAppData(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := mcp.AppDataDir
	mcp.AppDataDir = func() string { return dir }
	t.Cleanup(func() { mcp.AppDataDir = old })
	return dir
}

// 设置 → 存储清理会把 builtin-mcp-samples 当缓存删掉，而 mcp.json 里留着绝对路径。
// 没有自愈时服务器初始化失败十次后放弃，日志被 shell 启动横幅刷屏（2026-11-17 实际事故）。
func TestEnsureServerScriptRepairsMissingScript(t *testing.T) {
	appDir := overrideAppData(t)
	script := filepath.Join(appDir, "builtin-mcp-samples", "v0.9.0", "tts-sapi.ps1")
	cfg := mcp.MCPServerConfig{
		Command: "pwsh",
		Args:    []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script},
	}

	EnsureServerScript(cfg)

	got, err := os.ReadFile(script)
	if err != nil {
		t.Fatalf("脚本未补回：%v", err)
	}
	want, err := os.ReadFile(filepath.Join("..", "..", "docs", "mcp-samples", "tts-sapi.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("补回内容与内嵌脚本不一致")
	}
	// 幂等：已存在时不再写盘（每次 spawn 都动盘没有必要）
	if info, err := os.Stat(script); err != nil || info.Size() != int64(len(want)) {
		t.Fatalf("补回后文件状态异常：%v %+v", err, info)
	}
}

// 用户按 README 自备一份同名脚本放在别处时，保留它们，不许覆盖。
func TestEnsureServerScriptLeavesForeignCopyAlone(t *testing.T) {
	overrideAppData(t)
	foreign := filepath.Join(t.TempDir(), "tts-sapi.ps1")

	EnsureServerScript(mcp.MCPServerConfig{
		Command: "pwsh",
		Args:    []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", foreign},
	})

	if _, err := os.Stat(foreign); err == nil {
		t.Fatal("不应往用户自备目录写脚本")
	}
}

// 脚本缺失时「安装示例」要能修复，而不是一律报「已存在同名服务器」把用户堵死。
func TestMCPInstallSampleRepairsWhenScriptMissing(t *testing.T) {
	overrideAppData(t)
	app := &Samples{}
	if _, err := app.MCPInstallSample("tts_sapi"); err != nil {
		t.Fatal(err)
	}
	cfg, err := mcp.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	args := cfg.MCPServers["tts_sapi"].Args
	script := args[len(args)-1]
	if err := os.Remove(script); err != nil {
		t.Fatal(err)
	}

	out, err := app.MCPInstallSample("tts_sapi")
	if err != nil {
		t.Fatalf("脚本缺失时应修复而不是拒绝：%v", err)
	}
	if out["repaired"] != true {
		t.Fatalf("应标记为 repaired：%+v", out)
	}
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("脚本未补回：%v", err)
	}
	// 用户改过的授权不能被覆盖
	after, err := mcp.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(after.MCPServers["tts_sapi"].EnabledTools) != 1 {
		t.Fatalf("修复不该改配置：%+v", after.MCPServers["tts_sapi"])
	}
}
