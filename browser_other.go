//go:build !windows

package main

// 非 Windows 平台浏览器标签页 stub：内嵌 WebView2 仅 Windows 可用。

import "fmt"

func (a *App) BrowserOpen(id, url, profileKey string) (map[string]string, error) {
	return nil, fmt.Errorf("当前平台不支持内嵌浏览器")
}

func (a *App) BrowserNavigate(id string, url string) error { return browserUnsupported() }
func (a *App) BrowserGoBack(id string) error               { return browserUnsupported() }
func (a *App) BrowserGoForward(id string) error            { return browserUnsupported() }
func (a *App) BrowserReload(id string) error               { return browserUnsupported() }
func (a *App) BrowserStop(id string) error                 { return browserUnsupported() }
func (a *App) BrowserFocus(id string) error                { return browserUnsupported() }
func (a *App) BrowserClose(id string) error                { return browserUnsupported() }

func (a *App) BrowserState(id string) (map[string]interface{}, error) {
	return nil, browserUnsupported()
}

func (a *App) BrowserEval(id string, script string) (string, error) {
	return "", browserUnsupported()
}

func (a *App) BrowserCallCDP(id string, method string, paramsJSON string) (string, error) {
	return "", browserUnsupported()
}

func (a *App) BrowserSetBounds(id string, x int, y int, w int, h int) error {
	return browserUnsupported()
}

func (a *App) BrowserSetVisible(id string, visible bool) error    { return browserUnsupported() }
func (a *App) BrowserCaptureScreenshot(id string) (string, error) { return "", browserUnsupported() }

func browserUnsupported() error {
	return fmt.Errorf("当前平台不支持内嵌浏览器")
}
