//go:build windows

package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// resolveSystemCursor 解析一类调整光标为 data URL。
// 优先级：注册表当前主题（跟随用户自定义光标）→ 系统内置候选文件（aero: Vista+，hsplit/vsplit: 老系统兜底）。
func resolveSystemCursor(kind string) string {
	regNames := map[string]string{
		"ew":   "SizeWE",
		"ns":   "SizeNS",
		"nwse": "SizeNWSE",
		"nesw": "SizeNESW",
		"move": "Move",
	}
	candidates := map[string][]string{
		"ew":   {"aero_ew.cur", "hsplit.cur"},
		"ns":   {"aero_ns.cur", "vsplit.cur"},
		"nwse": {"aero_nwse.cur"},
		"nesw": {"aero_nesw.cur"},
		"move": {"aero_move.cur"},
	}
	windir := os.Getenv("WINDIR")
	if windir == "" {
		windir = `C:\Windows`
	}
	cursDir := filepath.Join(windir, "Cursors")
	tryRead := func(path string) (string, bool) {
		if path == "" {
			return "", false
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(cursDir, path)
		}
		if !strings.EqualFold(filepath.Ext(path), ".cur") {
			return "", false
		}
		data, err := os.ReadFile(path)
		if err != nil || len(data) < 4 {
			return "", false
		}
		return "data:image/x-icon;base64," + base64.StdEncoding.EncodeToString(data), true
	}
	if name := regNames[kind]; name != "" {
		if key, err := registry.OpenKey(registry.CURRENT_USER, `Control Panel\Cursors`, registry.QUERY_VALUE); err == nil {
			defer key.Close()
			val, _, _ := key.GetStringValue(name)
			if url, ok := tryRead(val); ok {
				return url
			}
		}
	}
	for _, f := range candidates[kind] {
		if url, ok := tryRead(f); ok {
			return url
		}
	}
	return ""
}

// GetSystemCursors 返回系统调整光标（Win11/Win10/Win7/XP 通用：读当前主题，回退内置候选）。
// 前端注入 cursor: url(dataURL)，任一环节失败时由 CSS 关键字（col-resize/row-resize 等）兜底。
func (a *App) GetSystemCursors() map[string]string {
	out := map[string]string{}
	for _, k := range []string{"ew", "ns", "nwse", "nesw", "move"} {
		if url := resolveSystemCursor(k); url != "" {
			out[k] = url
		}
	}
	return out
}
