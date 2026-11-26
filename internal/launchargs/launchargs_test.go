package launchargs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOpenTargets(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.json")
	b := filepath.Join(dir, "b.json")
	for _, f := range []string{a, b} {
		if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	exe, _ := os.Executable()
	missing := filepath.Join(dir, "missing.json")
	cases := []struct {
		name  string
		args  []string
		path  string
		line  int
		col   int
		count int
	}{
		{"plain", []string{a}, a, 0, 0, 1},
		{"line-suffix", []string{a + ":12"}, a, 12, 0, 1},
		{"line-column", []string{a + ":12:7"}, a, 12, 7, 1},
		// 真实存在的目录 + 行号：拆分 tier 1（stat 前缀命中），目录目标带行号。
		{"dir-with-line", []string{dir + ":12"}, dir, 12, 0, 1},
		{"line-flag-before", []string{"--line", "9", a}, a, 9, 0, 1},
		{"line-flag-after", []string{a, "--line=8"}, a, 8, 0, 1},
		{"goto", []string{"-g", a + ":3"}, a, 3, 0, 1},
		{"column-and-line", []string{"--column", "4", "--line", "6", a}, a, 6, 4, 1},
		{"skip-exe-and-flags", []string{exe, "-flag", a}, a, 0, 0, 1},
		// 不存在的路径不再静默丢弃（缺陷 A）：进 targets 由前端报「文件不存在」。
		{"missing-plain", []string{missing}, missing, 0, 0, 1},
		{"missing-line-suffix", []string{missing + ":2"}, missing, 2, 0, 1},
		{"missing-line-column", []string{missing + ":2:7"}, missing, 2, 7, 1},
		{"missing-with-pending-flag", []string{"--line", "5", missing}, missing, 5, 0, 1},
		// 后缀行号比 pending 更具体，覆盖 pending（审查 P3-5：新语义钉进测试）。
		{"missing-suffix-overrides-pending", []string{"--line", "5", missing + ":7"}, missing, 7, 0, 1},
		{"non-path-with-int-suffix", []string{a + ":abc"}, a + ":abc", 0, 0, 1},
		{"multiple", []string{a + ":2", b + ":3"}, a, 2, 0, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseOpenTargets(tc.args)
			if len(got) != tc.count {
				t.Fatalf("parseOpenTargets(%v) count = %d, want %d: %+v", tc.args, len(got), tc.count, got)
			}
			if tc.count == 0 {
				return
			}
			if got[0].Path != tc.path || got[0].Line != tc.line || got[0].Column != tc.col {
				t.Fatalf("parseOpenTargets(%v) first = %+v, want %s:%d:%d", tc.args, got[0], tc.path, tc.line, tc.col)
			}
		})
	}
}

func TestStartupCwdTarget(t *testing.T) {
	tmp := t.TempDir()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(orig)

	exeDir := filepath.Dir(mustSelfPath(t))

	if err := os.Chdir(exeDir); err != nil {
		t.Skip("无法 chdir 到 exe 目录")
	}
	if targets := StartupCwdTarget(); len(targets) != 0 {
		t.Fatalf("exe 目录内应返回空: %+v", targets)
	}

	if err := os.Chdir(tmp); err != nil {
		t.Fatal(err)
	}
	targets := StartupCwdTarget()
	if len(targets) != 1 || targets[0].Path != tmp {
		t.Fatalf("应返回 cwd 工作区: %+v (want %s)", targets, tmp)
	}
}

func mustSelfPath(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

func TestParseOpenSettingsArg(t *testing.T) {
	cases := map[string]string{
		"":                                "",
		"--new-window":                    "",
		"--open-settings=models":          "models",
		"--new-window --open-settings=ai": "ai",
		"--open-settings":                 "",
	}
	for args, want := range cases {
		if got := ParseOpenSettingsArg(strings.Fields(args)); got != want {
			t.Fatalf("parseOpenSettingsArg(%q) = %q, want %q", args, got, want)
		}
	}
}

func TestParseAISessionArg(t *testing.T) {
	cases := map[string]string{
		"":                         "",
		"--new-window":             "",
		"--ai-session=session-abc": "session-abc",
		"--new-window C:\\tmp --ai-session=session-abc": "session-abc",
		"--ai-session=": "",
		"--ai-session":  "",
	}
	for args, want := range cases {
		if got := ParseAISessionArg(strings.Fields(args)); got != want {
			t.Fatalf("parseAISessionArg(%q) = %q, want %q", args, got, want)
		}
	}
}

func TestParseMemoLocatorArg(t *testing.T) {
	got := ParseMemoLocatorArg([]string{"--memo=cadt-memo://workspace/item/it-abc"})
	if got != "cadt-memo://workspace/item/it-abc" {
		t.Fatalf("got %q", got)
	}
	if got := ParseMemoLocatorArg([]string{"--memo="}); got != "" {
		t.Fatalf("空值应返回空串，got %q", got)
	}
	if got := ParseMemoLocatorArg([]string{"file.json"}); got != "" {
		t.Fatalf("无 --memo 应返回空串，got %q", got)
	}
}

// --harness 是无值布尔开关，与 --ai-float / --debug-console 同款：只认独立参数，
// 不做前缀匹配（--harness=x 不算），也不吃后面的路径。
func TestParseHarness(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{"--harness"}, true},
		{[]string{"--new-window", "--harness", "D:\\data\\a.json"}, true},
		{[]string{"--harness=false"}, false},
		{[]string{"--harnessx"}, false},
		{[]string{"D:\\data\\a.json"}, false},
		{nil, false},
	}
	for _, c := range cases {
		if got := ParseHarness(c.args); got != c.want {
			t.Fatalf("ParseHarness(%q) = %v, want %v", c.args, got, c.want)
		}
	}
	// 开关本身不能被当成打开目标
	for _, target := range ParseOpenTargets([]string{"--harness", "--new-window"}) {
		if strings.Contains(target.Path, "harness") {
			t.Fatalf("--harness 被当成了打开目标：%+v", target)
		}
	}
}
