package main

import (
	"strconv"
	"strings"
	"testing"
)

func TestGetSystemCursors(t *testing.T) {
	app := &App{}
	c := app.GetSystemCursors()
	base, err := strconv.Atoi(c["base"])
	if err != nil || base < 16 || base > 128 {
		t.Fatalf("c[base] = %q，应为 16~128 的整数", c["base"])
	}
	for _, k := range []string{"ew", "ns"} {
		url := c[k]
		if url == "" {
			t.Fatalf("c[%q] 为空（Windows 上应能从注册表或系统目录解析出调整光标）", k)
		}
		if !strings.HasPrefix(url, "data:image/x-icon;base64,") {
			t.Fatalf("c[%q] 不是 x-icon data URL: %.40s...", k, url)
		}
	}
}
