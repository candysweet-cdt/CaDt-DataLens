// appconfig：应用配置文件（config.json，打开方式 / 插件目录 / 开发者模式 / 数据源）读写。
//
// Read 是「宽容读」：文件缺失、JSON 损坏、字段取值非法一律回落默认值，不向调用方抛错，
// 保证坏配置不会让应用起不来。Save 是整体覆盖写（非原子），只由设置页在用户确认后调用。
package appconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/plugins"
)

// Config 是 config.json 的磁盘结构。
type Config struct {
	OpenMode        string   `json:"openMode"`
	CloseAction     string   `json:"closeAction,omitempty"`
	PluginsPathMode string   `json:"pluginsPathMode,omitempty"`
	DisabledPlugins []string `json:"disabledPlugins,omitempty"`
	DeveloperMode   bool     `json:"developerMode,omitempty"`
	DataSource      string   `json:"dataSource,omitempty"`
}

// 点窗口关闭按钮（X）时的行为。
const (
	// CloseActionAsk 每次点 X 都弹三选一确认框（取消 / 退出应用 / 最小化到托盘），是默认值。
	CloseActionAsk = "ask"
	// CloseActionExit 直接退出程序。
	CloseActionExit = "exit"
	// CloseActionTray 隐藏窗口留在托盘，进程与后台任务（AI 回合、终端、后台命令）继续跑。
	CloseActionTray = "tray"
)

// NormalizeCloseAction 归一化关闭行为取值，非法值回落「直接退出」
// （宁可退出也别把窗口藏起来让人找不着；ask 只在显式配置或首次默认时出现）。
func NormalizeCloseAction(action string) string {
	if action == CloseActionTray || action == CloseActionExit || action == CloseActionAsk {
		return action
	}
	return CloseActionExit
}

// Default 返回无配置时的默认值。
func Default() Config {
	return Config{OpenMode: "tab", CloseAction: CloseActionAsk, PluginsPathMode: "portable", DataSource: plugins.MarketSourceGitee}
}

// Path 返回 config.json 的绝对路径（应用数据根目录不可用时返回空串）。
func Path() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "config.json")
}

// Read 读取配置并归一化；文件缺失或损坏时返回默认值。
func Read() Config {
	cfg := Default()
	path := Path()
	if path == "" {
		return cfg
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	var stored Config
	if json.Unmarshal(raw, &stored) != nil {
		return cfg
	}
	// openMode 只支持 tab：「一个文件一个窗口」在 v3 一进程多窗口下会造成同工作区
	// 双开（会话/监听/租约按单打开语义设计），轻量查看窗评估前禁用（2026-11-21 用户裁定）。
	// 旧配置里的 window 值一律回落 tab。
	cfg.CloseAction = NormalizeCloseAction(stored.CloseAction)
	if stored.PluginsPathMode == "appdata" {
		cfg.PluginsPathMode = "appdata"
	}
	if stored.DisabledPlugins != nil {
		cfg.DisabledPlugins = stored.DisabledPlugins
	}
	cfg.DeveloperMode = stored.DeveloperMode
	cfg.DataSource = plugins.NormalizeMarketSource(stored.DataSource)
	return cfg
}

// Save 整体覆盖写回配置（先建目录；os.WriteFile 直接覆盖，非临时文件+改名）。
func Save(cfg Config) error {
	path := Path()
	if path == "" {
		return fmt.Errorf("无法定位配置目录")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// 原子写：os.WriteFile 先截断再写，写一半崩溃/断电会留下半截 JSON，
	// Read 解析失败后直接回落 Default()，用户设置被静默重置。
	return atomfile.WriteFileAtomicMode(path, raw, 0o644)
}

// OpenMode 返回文件打开方式（仅 tab；window 已禁用，见 Read）。
func OpenMode() string {
	return Read().OpenMode
}

// CloseAction 返回点窗口关闭按钮时的行为（exit / tray）。
func CloseAction() string {
	return Read().CloseAction
}

// SaveCloseAction 只改关闭行为，其余字段按当前磁盘值原样带过去再整份写回。
func SaveCloseAction(action string) error {
	cfg := Read()
	cfg.CloseAction = NormalizeCloseAction(action)
	return Save(cfg)
}
