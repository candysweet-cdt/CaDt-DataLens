package main

// app_infra.go：应用级基础设施——应用数据目录约定 + 日志绑定。
//
// 由 appdata.go + logging.go 合并而来（2026-11-24 三期结构化）：两者都是应用级
// 基础设施，logging.go 本就 import appdata（OpenLogDir 的 ErrNoRoot），放一起减少
// 一个文件且依赖更直观。路径拼装实现已下沉 internal/appdata，日志引擎在
// internal/applog，这里只保留 main 包内的旧名与绑定壳。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/appconfig"
	"datalens/internal/appdata"
	"datalens/internal/applog"
)

// 应用数据统一存放在 %APPDATA%\CandySweet\CaDt-DataLens 下：
//
//	config.json  后端配置（打开方式、插件目录模式、禁用插件）
//	WebView2\    WebView2 用户数据，localStorage 里的界面设置保存在这里
//	plugins\     插件目录（设置里选择"应用数据目录"时）
//
// ==================== 应用数据目录（原 appdata.go）====================

func appDataRootAt(configDir string) string { return appdata.RootAt(configDir) }

func appDataRoot() string { return appdata.Root() }

func webviewDataPath() string {
	// 临时调试辅助：CADT_WEBVIEW_DATA_DIR 指定独立 WebView2 用户数据目录，
	// 让调试实例不与正在运行的正式实例共享浏览器进程（仅供自动化排查用）
	if v := strings.TrimSpace(os.Getenv("CADT_WEBVIEW_DATA_DIR")); v != "" {
		return v
	}
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "WebView2")
}

// ensureAppDataDir 在 WebView2 启动前创建统一根目录，避免子目录创建失败。
func ensureAppDataDir() {
	root := appDataRoot()
	if root == "" {
		return
	}
	_ = os.MkdirAll(root, 0o755)
}

// ==================== 日志（原 logging.go）====================

// writeAppLog 供各 internal 包的 Logf 钩子直接引用。
var writeAppLog = applog.Write

// LogFrontend 接收前端日志；错误与警告始终记录，info/debug 仅在开发者模式下记录。
func (a *App) LogFrontend(level, message string) {
	tag := strings.ToLower(strings.TrimSpace(level))
	switch tag {
	case "error", "warn", "info", "debug":
	case "warning":
		tag = "warn"
	default:
		tag = "info"
	}
	if (tag == "info" || tag == "debug") && !applog.DevMode() {
		return
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return
	}
	writeAppLog(tag, "%s", message)
}

func (a *App) GetDeveloperMode() bool {
	return applog.DevMode()
}

func (a *App) SetDeveloperMode(enabled bool) error {
	cfg := appconfig.Read()
	cfg.DeveloperMode = enabled
	if err := appconfig.Save(cfg); err != nil {
		return err
	}
	applog.SetDevMode(enabled)
	writeAppLog("info", "开发者模式：%s", applog.OnOff(enabled))
	return nil
}

func (a *App) GetLogPath() string {
	return applog.FilePath()
}

func (a *App) OpenLogDir() error {
	dir := applog.Dir()
	if dir == "" {
		return appdata.ErrNoRoot
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("无法创建日志目录：%w", err)
	}
	return a.ShowInFolder(dir)
}
