package windowgeom

// keys_test.go：窗口几何 key 的表驱动测试（原根目录 window_geometry_test.go 与
// aux_windows_test.go 的 TestAuxWindowGeometryKeys 合并迁入）。

import "testing"

func TestRestoreKey(t *testing.T) {
	cases := []struct {
		name      string
		mode      string
		winName   string
		modeCount int
		wantKey   string
		wantCasc  int
	}{
		{"AI 浮窗", "float", "float", 0, "float", 0},
		{"调试控制台", "debug", "debug", 0, "debug", 0},
		{"非规范浮窗名不持久化", "float", "float-2", 0, "", 0},
		{"首个主窗口", "main", "main", 1, "main", 0},
		{"第二个主窗口", "main", "main-2", 2, "main", 1},
		{"第三个主窗口", "main", "main-3", 3, "main", 2},
		{"计数异常按首个处理", "main", "main", 0, "main", 0},
		{"首个终端窗口", "terminal", "term", 1, "terminal", 0},
		{"第二个终端窗口", "terminal", "term-2", 2, "terminal", 1},
		{"便签窗", "memo", "memo", 1, "memo", 0},
		{"第二个便签窗", "memo", "memo-3", 2, "memo", 1},
		{"监控窗", "monitor", "monitor", 1, "monitor", 0},
		{"对比窗", "diff", "diff-5", 2, "diff", 1},
		{"轻量查看窗", "light", "light", 1, "light", 0},
		{"实时预览窗", "preview", "preview-9", 3, "preview", 2},
		{"未知形态按主窗口处理", "weird", "weird", 1, "main", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, cascade := RestoreKey(tc.mode, tc.winName, tc.modeCount)
			if key != tc.wantKey || cascade != tc.wantCasc {
				t.Fatalf("RestoreKey() = (%q, %d), want (%q, %d)",
					key, cascade, tc.wantKey, tc.wantCasc)
			}
		})
	}
}

func TestPersistKey(t *testing.T) {
	cases := []struct {
		name      string
		mode      string
		winName   string
		isPrimary bool
		want      string
	}{
		{"AI 浮窗", "float", "float", false, "float"},
		{"调试控制台", "debug", "debug", false, "debug"},
		{"终端独立窗口", "terminal", "term", false, "terminal"},
		{"主窗口是 primary", "main", "main", true, "main"},
		{"额外主窗口不覆盖", "main", "main-2", false, ""},
		{"非规范浮窗名", "float", "float-2", false, ""},
		{"便签窗", "memo", "memo", false, "memo"},
		{"监控窗", "monitor", "monitor", false, "monitor"},
		{"对比窗", "diff", "diff", false, "diff"},
		{"轻量查看窗", "light", "light", false, "light"},
		{"实时预览窗", "preview", "preview", false, "preview"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PersistKey(tc.mode, tc.winName, tc.isPrimary); got != tc.want {
				t.Fatalf("PersistKey() = %q, want %q", got, tc.want)
			}
		})
	}
}
