package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAppDataPathsUnderCandySweet(t *testing.T) {
	base := t.TempDir()
	t.Setenv("AppData", base)

	root := appDataRoot()
	wantRoot := filepath.Join(base, "CandySweet", "CaDt-DataLens")
	if root != wantRoot {
		t.Fatalf("应用数据根目录不符: %q != %q", root, wantRoot)
	}
	if appDataRootAt("") != "" {
		t.Fatal("空配置目录应返回空路径")
	}
	if got, want := configFilePath(), filepath.Join(wantRoot, "config.json"); got != want {
		t.Fatalf("config.json 路径不符: %q != %q", got, want)
	}
	if got, want := webviewDataPath(), filepath.Join(wantRoot, "WebView2"); got != want {
		t.Fatalf("WebView2 路径不符: %q != %q", got, want)
	}

	app := NewApp()
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatalf("SetPluginsPathMode: %v", err)
	}
	pluginsDir, err := app.GetPluginsDir()
	if err != nil {
		t.Fatalf("GetPluginsDir: %v", err)
	}
	if want := filepath.Join(wantRoot, "plugins"); pluginsDir != want {
		t.Fatalf("appdata 插件目录不符: %q != %q", pluginsDir, want)
	}

	// 后端配置确实写进统一目录
	if err := app.SetOpenMode("window"); err != nil {
		t.Fatalf("SetOpenMode: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(wantRoot, "config.json"))
	if err != nil {
		t.Fatalf("config.json 未写入统一目录: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("config.json 为空")
	}
}
