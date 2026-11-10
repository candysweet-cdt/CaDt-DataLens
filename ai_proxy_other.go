//go:build !windows

package main

import (
	"net/http"
	"net/url"
)

// 非 Windows 平台没有统一的系统代理注册表，跟随环境变量。
func systemAIProxy() func(*http.Request) (*url.URL, error) {
	return http.ProxyFromEnvironment
}
