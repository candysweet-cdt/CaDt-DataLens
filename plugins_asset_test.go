package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadPluginAsset(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := NewApp()
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatalf("SetPluginsPathMode: %v", err)
	}
	root, err := pluginsRootFor("appdata")
	if err != nil {
		t.Fatalf("pluginsRootFor: %v", err)
	}
	dir := filepath.Join(root, "demo")
	if err := os.MkdirAll(filepath.Join(dir, "images"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pluginManifestName), []byte(`{"id":"demo","name":"Demo","author":"CandySweet","entry":"main.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte("// demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01}
	assetPath := filepath.Join(dir, "images", "a.png")
	if err := os.WriteFile(assetPath, png, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "nomanifest"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nomanifest", "a.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := app.ReadPluginAsset("demo", "images/a.png")
	if err != nil {
		t.Fatalf("ReadPluginAsset: %v", err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	if got != want {
		t.Fatalf("data URL 不匹配：got %q", got)
	}
	if _, err := app.ReadPluginAsset("demo", `images\a.png`); err != nil {
		t.Fatalf("反斜杠路径应可用：%v", err)
	}

	bad := []struct{ id, path string }{
		{"../demo", "images/a.png"},
		{"Bad/Id", "images/a.png"},
		{"demo", ""},
		{"demo", "../main.js"},
		{"demo", "images/../../main.js"},
		{"demo", "/images/a.png"},
		{"demo", "C:/images/a.png"},
		{"demo", "./images/a.png"},
		{"demo", "images//a.png"},
		{"demo", "main.js"},
		{"demo", "images/missing.png"},
		{"demo", "images"},
		{"missing", "images/a.png"},
		{"nomanifest", "a.png"},
	}
	for _, c := range bad {
		if _, err := app.ReadPluginAsset(c.id, c.path); err == nil {
			t.Fatalf("应拒绝 id=%q path=%q", c.id, c.path)
		}
	}
}

func TestReadPluginAssetRejectsOversize(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := NewApp()
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatal(err)
	}
	root, err := pluginsRootFor("appdata")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "big")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pluginManifestName), []byte(`{"id":"big","name":"Big","author":"CandySweet","entry":"main.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte("// big"), 0o644); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, pluginAssetMaxSize+1)
	if err := os.WriteFile(filepath.Join(dir, "big.png"), buf, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := app.ReadPluginAsset("big", "big.png"); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("超大资产应被拒绝：%v", err)
	}
}
