package main

import (
	"strings"
	"testing"
)

func TestGetSystemCursors(t *testing.T) {
	app := &App{}
	c := app.GetSystemCursors()
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
