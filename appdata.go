package main

import (
	"os"
	"path/filepath"
)

// 应用数据统一存放在 %APPDATA%\CandySweet\CaDt-DataLens 下：
//
//	config.json  后端配置（打开方式、插件目录模式、禁用插件）
//	WebView2\    WebView2 用户数据，localStorage 里的界面设置保存在这里
//	plugins\     插件目录（设置里选择“应用数据目录”时）
const (
	appDataVendorDir = "CandySweet"
	appDataAppDir    = "CaDt-DataLens"
)

func appDataRootAt(configDir string) string {
	if configDir == "" {
		return ""
	}
	return filepath.Join(configDir, appDataVendorDir, appDataAppDir)
}

func appDataRoot() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return appDataRootAt(dir)
}

func configFilePath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "config.json")
}

func webviewDataPath() string {
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
