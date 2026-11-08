package main

import (
	"archive/zip"
	"fmt"
	"os/exec"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func writeTestPlugin(t *testing.T, dir, id string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := "{\"id\":\"" + id + "\",\"name\":\"测试插件\",\"version\":\"1.0.0\",\"author\":\"CandySweet\",\"entry\":\"main.js\",\"extensions\":[\"bak\"],\"license\":\"MIT\",\"keywords\":[\"示例\",\"json\"],\"icon\":\"icon.svg\"}"
	if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte("cadt.registerFormat({id:'"+id+"',name:'测试',extensions:['bak'],parse:JSON.parse,stringify:JSON.stringify});"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "icon.svg"), []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInstallAndListPlugins(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(t.TempDir(), "my-plugin")
	writeTestPlugin(t, src, "my-plugin")

	info, err := installPluginAt(root, src)
	if err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if info.Id != "my-plugin" || !info.Enabled || !info.EntryOK {
		t.Fatalf("安装结果不符: %+v", info)
	}
	if info.Author != "CandySweet" || info.License != "MIT" || len(info.Keywords) != 2 {
		t.Fatalf("清单扩展字段未解析: %+v", info)
	}
	if !strings.HasPrefix(info.IconData, "data:image/svg+xml;base64,") {
		t.Fatalf("图标未转 data URL: %q", info.IconData)
	}
	if _, err := os.Stat(filepath.Join(root, "my-plugin", "main.js")); err != nil {
		t.Fatalf("入口文件未复制: %v", err)
	}

	// 重复安装应报错
	if _, err := installPluginAt(root, src); err == nil {
		t.Fatal("重复安装应报错")
	}

	disabled := map[string]bool{"my-plugin": true}
	list, err := listPluginsAt(root, disabled)
	if err != nil || len(list) != 1 {
		t.Fatalf("列表失败: %v %v", err, list)
	}
	if list[0].Id != "my-plugin" || list[0].Enabled {
		t.Fatalf("禁用状态未生效: %+v", list[0])
	}
}

func TestReadPluginManifestRejects(t *testing.T) {
	base := t.TempDir()
	cases := []struct {
		name     string
		manifest string
		want     string
	}{
		{"bad id", `{"id":"Bad_ID","name":"x","author":"a","entry":"main.js"}`, "id 无效"},
		{"no name", `{"id":"ok-id","author":"a","entry":"main.js"}`, "缺少名称"},
		{"no author", `{"id":"ok-id","name":"x","entry":"main.js"}`, "缺少作者"},
		{"bad url", `{"id":"ok-id","name":"x","author":"a","entry":"main.js","homepage":"javascript:alert(1)"}`, "http(s)"},
		{"bad minver", `{"id":"ok-id","name":"x","author":"a","entry":"main.js","minAppVersion":"v1.x"}`, "minAppVersion"},
		{"missing entry", `{"id":"ok-id","name":"x","author":"a","entry":"gone.js"}`, "入口文件不存在"},
		{"escape entry", `{"id":"ok-id","name":"x","author":"a","entry":"../../x.js"}`, "越界"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(base, strings.ReplaceAll(tc.name, " ", "-"))
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(tc.manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "x.js"), []byte("//"), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := readPluginManifest(dir)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("期望错误含 %q，得到 %v", tc.want, err)
			}
		})
	}
}

func createTestZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := zip.NewWriter(f)
	for name, content := range files {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		entry, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestExtractPluginZip(t *testing.T) {
	tmp := t.TempDir()
	zipPath := filepath.Join(tmp, "plug.zip")
	createTestZip(t, zipPath, map[string]string{
		"my-zip/plugin.json":   `{"id":"my-zip","name":"Zip 插件","entry":"main.js"}`,
		"my-zip/main.js":       "// entry",
		"my-zip/lib/helper.js": "// helper",
	})
	dest := t.TempDir()
	srcDir, err := extractPluginZip(zipPath, dest)
	if err != nil {
		t.Fatalf("解压失败: %v", err)
	}
	if filepath.Base(srcDir) != "my-zip" {
		t.Fatalf("应定位到顶层子目录: %s", srcDir)
	}
	if _, err := os.Stat(filepath.Join(srcDir, "lib", "helper.js")); err != nil {
		t.Fatalf("子目录文件未解压: %v", err)
	}

	// zip-slip 应被拒绝
	slip := filepath.Join(tmp, "slip.zip")
	createTestZip(t, slip, map[string]string{
		"../evil.js": "payload",
	})
	if _, err := extractPluginZip(slip, t.TempDir()); err == nil {
		t.Fatal("zip-slip 路径应被拒绝")
	}

	// 缺 plugin.json 应报错
	empty := filepath.Join(tmp, "empty.zip")
	createTestZip(t, empty, map[string]string{"readme.txt": "hi"})
	if _, err := extractPluginZip(empty, t.TempDir()); err == nil || !strings.Contains(err.Error(), "plugin.json") {
		t.Fatalf("缺清单应报错: %v", err)
	}
}

func TestDeletePluginAndDisabledConfig(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	// SetOpenMode 后再写插件配置不应丢失 openMode
	if err := NewApp().SetOpenMode("window"); err != nil {
		t.Fatalf("SetOpenMode: %v", err)
	}
	if err := NewApp().SetPluginEnabled("demo-plugin", false); err != nil {
		t.Fatalf("SetPluginEnabled: %v", err)
	}
	cfg := readAppConfig()
	if cfg.OpenMode != "window" {
		t.Fatalf("openMode 丢失: %+v", cfg)
	}
	if len(cfg.DisabledPlugins) != 1 || cfg.DisabledPlugins[0] != "demo-plugin" {
		t.Fatalf("disabledPlugins 不符: %+v", cfg.DisabledPlugins)
	}
	if err := NewApp().SetPluginEnabled("demo-plugin", true); err != nil {
		t.Fatalf("重新启用: %v", err)
	}
	if cfg2 := readAppConfig(); len(cfg2.DisabledPlugins) != 0 {
		t.Fatalf("启用后禁用列表应为空: %+v", cfg2.DisabledPlugins)
	}
	if err := NewApp().DeletePlugin("demo-plugin"); err != nil {
		t.Fatalf("DeletePlugin: %v", err)
	}
	if cfg3 := readAppConfig(); len(cfg3.DisabledPlugins) != 0 {
		t.Fatalf("删除后禁用列表应为空: %+v", cfg3.DisabledPlugins)
	}
	if err := NewApp().DeletePlugin("../escape"); err == nil {
		t.Fatal("非法 id 应被拒绝")
	}
}

func TestPluginsPathModeRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := NewApp()
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatalf("SetPluginsPathMode: %v", err)
	}
	dir, err := app.GetPluginsDir()
	if err != nil {
		t.Fatalf("GetPluginsDir: %v", err)
	}
	if !strings.Contains(dir, "CaDt-DataLens") || !strings.HasSuffix(filepath.ToSlash(dir), "/plugins") {
		t.Fatalf("appdata 目录不符: %s", dir)
	}
	if err := app.SetPluginsPathMode("portable"); err != nil {
		t.Fatalf("切回 portable: %v", err)
	}
	exe, _ := os.Executable()
	portable := filepath.Join(filepath.Dir(exe), "plugins")
	if dir2, _ := app.GetPluginsDir(); dir2 != portable {
		t.Fatalf("portable 目录不符: %s != %s", dir2, portable)
	}
}

func installPluginFromUrl(root, rawUrl string) (*PluginInfo, error) {
	tmp, err := os.MkdirTemp("", "cadt-plugin-url-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	cloneCmd := exec.Command("git", "clone", "--depth", "1", "--single-branch", rawUrl, filepath.Join(tmp, "repo"))
	cloneCmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if out, cloneErr := cloneCmd.CombinedOutput(); cloneErr != nil {
		return nil, fmt.Errorf("克隆失败：%s", strings.TrimSpace(string(out)))
	}
	repoDir := filepath.Join(tmp, "repo")
	var srcDir string
	if _, e := os.Stat(filepath.Join(repoDir, pluginManifestName)); e == nil {
		srcDir = repoDir
	} else if top, _ := os.ReadDir(repoDir); len(top) == 1 && top[0].IsDir() {
		sub := filepath.Join(repoDir, top[0].Name())
		if _, e2 := os.Stat(filepath.Join(sub, pluginManifestName)); e2 == nil {
			srcDir = sub
		}
	}
	if srcDir == "" {
		return nil, fmt.Errorf("仓库里没有找到 %s", pluginManifestName)
	}
	return installPluginAt(root, srcDir)
}

func TestInstallPluginFromUrlReal(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("本机无 git，跳过")
	}
	root := t.TempDir()
	info, err := installPluginFromUrl(root, "https://gitee.com/cadt-datalens-plugins/bak-json")
	if err != nil {
		t.Fatalf("从仓库地址安装失败: %v", err)
	}
	if info.Id != "bak-json" || !info.EntryOK {
		t.Fatalf("安装结果不符: %+v", info)
	}
	if _, err := os.Stat(filepath.Join(root, "bak-json", "main.js")); err != nil {
		t.Fatalf("入口文件未复制: %v", err)
	}
}

func TestInstallPluginFromUrlInvalid(t *testing.T) {
	root := t.TempDir()
	if _, err := installPluginFromUrl(root, "https://gitee.com/cadt-datalens-plugins/not-exist-repo-xyz"); err == nil {
		t.Fatal("克隆不存在的仓库应报错")
	}
}


func TestGitRollbackForReal(t *testing.T) {
	// 在本仓库里做真实回滚测试
	target := filepath.Join("docs", "plugins", "examples", "bak-json", "main.js")
	orig, err := os.ReadFile(target)
	if err != nil {
		t.Skip("示例文件不存在")
	}
	defer func() {
		_ = os.WriteFile(target, orig, 0o644)
		_, _, _ = gitRun(".", []string{"checkout", "HEAD", "--", target}, 10000)
	}()

	// 修改后回滚
	if err := os.WriteFile(target, []byte("// modified"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := NewApp().GitRollbackFor(".", []string{target}, nil); err != nil {
		t.Fatalf("回滚失败: %v", err)
	}
	after, _ := os.ReadFile(target)
	if string(after) != string(orig) {
		t.Fatal("回滚后内容未还原")
	}

	// 路径穿越拒绝
	if err := NewApp().GitRollbackFor(".", []string{".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "go.mod"}, nil); err == nil {
		t.Fatal("路径穿越应被拒绝")
	}
}

func TestGitFileHistoryAndRecentLog(t *testing.T) {
	out, err := NewApp().GitFileHistoryFor(".", "frontend/src/main.js", 10)
	if err != nil {
		t.Fatalf("文件历史: %v", err)
	}
	if out == "" {
		t.Fatal("main.js 有提交历史，输出不应为空")
	}
	log, err := NewApp().GitRecentLogFor(".", 5)
	if err != nil {
		t.Fatalf("最近提交: %v", err)
	}
	if strings.Count(log, "\n") < 1 {
		t.Fatalf("最近提交应有多条: %q", log)
	}
}
