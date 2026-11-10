//go:build !windows

package main

import "fmt"

func (a *App) OpenDevTools() error {
	return fmt.Errorf("当前平台不支持打开开发者工具")
}
