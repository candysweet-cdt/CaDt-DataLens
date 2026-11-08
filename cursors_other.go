//go:build !windows

package main

// GetSystemCursors 非 Windows 平台返回空：前端回落 CSS 关键字光标。
func (a *App) GetSystemCursors() map[string]string {
	return map[string]string{}
}
