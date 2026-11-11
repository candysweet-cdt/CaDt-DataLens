package main

import "testing"

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
