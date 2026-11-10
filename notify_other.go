//go:build !windows

package main

// NotifyAttention 在非 Windows 平台无操作。
func (a *App) NotifyAttention(beep bool) {}

// NotifySystemToast 在非 Windows 平台无操作。
func (a *App) NotifySystemToast(title string, body string, silent bool) error { return nil }
