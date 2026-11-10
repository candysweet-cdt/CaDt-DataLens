//go:build windows

package main

import (
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// systemAIProxy 读取 Windows「Internet 选项」的代理设置（与浏览器/系统代理一致），
// 读不到注册表时才退回环境变量。
func systemAIProxy() func(*http.Request) (*url.URL, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return http.ProxyFromEnvironment
	}
	defer key.Close()

	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err != nil || enabled == 0 {
		return nil
	}
	server, _, err := key.GetStringValue("ProxyServer")
	if err != nil || strings.TrimSpace(server) == "" {
		return nil
	}
	override, _, _ := key.GetStringValue("ProxyOverride")
	return aiSystemProxyResolver(server, override)
}
