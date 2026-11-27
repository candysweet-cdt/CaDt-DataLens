package appconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigPathUnderAppData(t *testing.T) {
	base := t.TempDir()
	t.Setenv("AppData", base)
	root := filepath.Join(base, "CandySweet", "CaDt-DataLens")
	if got, want := Path(), filepath.Join(root, "config.json"); got != want {
		t.Fatalf("config.json 路径不符: %q != %q", got, want)
	}
	if got := Read(); got.OpenMode != "tab" || got.PluginsPathMode != "portable" {
		t.Fatalf("默认配置不符: %+v", got)
	}
}

func TestSaveReadRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	cfg := Read()
	cfg.OpenMode = "window" // 旧配置残留的 window：读回应回落 tab（多窗口已禁用）
	cfg.DeveloperMode = true
	cfg.DisabledPlugins = []string{"demo"}
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}
	got := Read()
	if got.OpenMode != "tab" || !got.DeveloperMode || len(got.DisabledPlugins) != 1 || got.DisabledPlugins[0] != "demo" {
		t.Fatalf("读回配置不符（window 应回落 tab）: %+v", got)
	}
	if _, err := os.Stat(Path()); err != nil {
		t.Fatalf("config.json 未写入: %v", err)
	}
}

func TestCloseActionDefaultAndRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	// 缺省是「每次询问」：点 X 弹三选一，让用户自己决定退出还是留后台
	if got := CloseAction(); got != CloseActionAsk {
		t.Fatalf("默认关闭行为不符: %q", got)
	}
	if err := SaveCloseAction(CloseActionTray); err != nil {
		t.Fatal(err)
	}
	if got := CloseAction(); got != CloseActionTray {
		t.Fatalf("读回关闭行为不符: %q", got)
	}
	// 只改关闭行为不能把别的字段冲掉
	cfg := Read()
	cfg.OpenMode = "tab"
	cfg.DeveloperMode = true
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}
	if err := SaveCloseAction(CloseActionExit); err != nil {
		t.Fatal(err)
	}
	back := Read()
	if back.CloseAction != CloseActionExit || back.OpenMode != "tab" || !back.DeveloperMode {
		t.Fatalf("SaveCloseAction 丢了其它字段: %+v", back)
	}
}

func TestNormalizeCloseAction(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"ask", CloseActionAsk},
		{"tray", CloseActionTray},
		{"exit", CloseActionExit},
		{"", CloseActionExit},
		{"TRAY", CloseActionExit}, // 大小写不认：不猜用户意图，回落最安全的退出
		{"minimize", CloseActionExit},
	} {
		if got := NormalizeCloseAction(tc.in); got != tc.want {
			t.Errorf("NormalizeCloseAction(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

func TestCloseActionIgnoresBrokenStorage(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	if err := os.MkdirAll(filepath.Dir(Path()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(), []byte(`{"closeAction":"tray","openMode":`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := CloseAction(); got != CloseActionAsk {
		t.Fatalf("坏配置必须回落默认值（ask），得到 %q", got)
	}
}
