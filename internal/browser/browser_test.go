package browser

import (
	"strings"
	"testing"
)

func TestSanitizeBrowserProfileKey(t *testing.T) {
	cases := []struct{ in, want string }{
		{"tab-doc123", "tab-doc123"},
		{"sess-abc_DEF-9", "sess-abc_DEF-9"},
		{"会话:1/测试*", "___1____"},
		{"", ""},
		{"...!!!", "______"},
	}
	for _, c := range cases {
		if got := sanitizeBrowserProfileKey(c.in); got != c.want {
			t.Fatalf("sanitize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := sanitizeBrowserProfileKey(string(make([]byte, 100)))
	if len(long) != 64 {
		t.Fatalf("long key len = %d, want 64", len(long))
	}
}

// TestBrowserNewWindowGuardScript 守住「新窗口改为页内跳转」注入脚本的关键拦截逻辑，
// 防止后续重构误删导致 target=_blank 又弹出原生浮动窗口（回归防护，纯静态断言）。
func TestBrowserNewWindowGuardScript(t *testing.T) {
	for _, frag := range []string{
		"window.open = function",
		"window.location.href",
		"addEventListener('click'",
		"closest('a[target],area[target]')",
		"setAttribute('target','_self')",
		"addEventListener('submit'",
	} {
		if !strings.Contains(browserNewWindowGuardScript, frag) {
			t.Fatalf("注入脚本缺少关键片段 %q", frag)
		}
	}
}
