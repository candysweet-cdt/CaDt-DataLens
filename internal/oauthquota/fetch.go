package oauthquota

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// FetchResult 是一次带 OAuth token 的 HTTP 查询返回（原样 body，交给前端 extractor
// 解析）。字段名与 aigen.HTTPResult 对齐，前端可复用同一套错误读取逻辑。
type FetchResult struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Body        string `json:"body"`
	Bytes       int64  `json:"bytes"`
	Truncated   bool   `json:"truncated"`
	Error       string `json:"error,omitempty"`
}

const fetchBodyLimit = 1 << 20 // 1 MB：额度响应远小于此

// Fetch 按 provider 配置 + 指定 URL 发一次带 Bearer token 的 GET。
// token 自动续期；401/403 强制续期后再试一次。URL 必须落在 provider 的
// ConsoleOrigin 下（防止被用来带 token 打其他站点）。
func Fetch(providerID, rawURL string) (FetchResult, error) {
	p, ok := ProviderByID(providerID)
	if !ok {
		return FetchResult{Error: "未知的 OAuth provider：" + providerID}, nil
	}
	target := strings.TrimSpace(rawURL)
	if target == "" {
		target = p.ConsoleOrigin + p.UsagePath
	}
	if !sameOrigin(target, p.ConsoleOrigin) {
		return FetchResult{Error: "请求地址必须属于 " + p.ConsoleOrigin}, nil
	}
	return fetch(p, target, false)
}

// sameOrigin 判断 target 是否严格落在 origin 的 scheme + host 下。
// 不能做字符串前缀比较：https://<origin>.evil.com 与 https://<origin>@evil.com
// 都能通过 HasPrefix，却会把 Bearer token 发给第三方（URL 来自可编辑的额度脚本）。
func sameOrigin(target, origin string) bool {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || u.User != nil {
		return false
	}
	o, err := url.Parse(origin)
	if err != nil || o.Host == "" {
		return false
	}
	return strings.EqualFold(u.Scheme, o.Scheme) && strings.EqualFold(u.Host, o.Host)
}

func fetch(p Provider, target string, retried bool) (FetchResult, error) {
	token, err := freshAccessToken(p)
	if err != nil {
		return FetchResult{Error: err.Error()}, nil
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return FetchResult{Error: err.Error()}, nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", p.UserAgent)
	resp, err := (&http.Client{Timeout: requestTimeout}).Do(req)
	if err != nil {
		return FetchResult{Error: err.Error()}, nil
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, fetchBodyLimit+1))
	truncated := int64(len(raw)) > fetchBodyLimit
	if truncated {
		raw = raw[:fetchBodyLimit]
	}
	result := FetchResult{
		Status:      resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
		Body:        string(raw),
		Bytes:       int64(len(raw)),
		Truncated:   truncated,
	}
	if readErr != nil && len(raw) == 0 {
		result.Error = "读取响应失败：" + readErr.Error()
		return result, nil
	}
	if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && !retried {
		if _, err := invalidateAndRefresh(p); err != nil {
			result.Error = err.Error()
			return result, nil
		}
		return fetch(p, target, true)
	}
	return result, nil
}

// LoginResult / StatusResult 与前端配置弹窗对接（不回 token）。
type LoginResult struct {
	OK        bool   `json:"ok"`
	Username  string `json:"username,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type StatusResult struct {
	LoggedIn  bool   `json:"loggedIn"`
	CanRenew  bool   `json:"canRenew"` // 有 refresh token：到期会自动续期，不需要重登
	Username  string `json:"username,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"` // 当前 access token 到期时间（会自动续，不是重登期限）
	Error     string `json:"error,omitempty"`
}

// LoginAndSave 登录并保存凭据（按 providerID 隔离）。
func LoginAndSave(providerID, username, password string) (LoginResult, error) {
	p, ok := ProviderByID(providerID)
	if !ok {
		return LoginResult{Error: "未知的 OAuth provider：" + providerID}, nil
	}
	granted, err := Login(p, username, password)
	if err != nil {
		return LoginResult{Error: err.Error()}, nil
	}
	stored := storedGrant{
		Username:     strings.TrimSpace(username),
		AccessToken:  granted.AccessToken,
		RefreshToken: granted.RefreshToken,
		ExpiresAt:    granted.ExpiresAt.Unix(),
	}
	if err := SaveCredential(p.ID, stored); err != nil {
		return LoginResult{Error: "凭据保存失败：" + err.Error()}, nil
	}
	return LoginResult{OK: true, Username: stored.Username, ExpiresAt: stored.ExpiresAt}, nil
}

// Status 读登录状态（不回 token）。
func Status(providerID string) (StatusResult, error) {
	if _, ok := ProviderByID(providerID); !ok {
		return StatusResult{Error: "未知的 OAuth provider：" + providerID}, nil
	}
	stored, err := LoadCredential(providerID)
	if err != nil {
		if errors.Is(err, ErrNoCredential) {
			return StatusResult{LoggedIn: false}, nil
		}
		return StatusResult{LoggedIn: false, Error: err.Error()}, nil
	}
	return StatusResult{
		LoggedIn:  stored.RefreshToken != "" || stored.AccessToken != "",
		CanRenew:  stored.RefreshToken != "",
		Username:  stored.Username,
		ExpiresAt: stored.ExpiresAt,
	}, nil
}

func Logout(providerID string) error {
	return ClearCredential(providerID)
}

// Providers 返回内置 provider 的公开元信息（不含密钥/JWKS 内部字段之外的内容，
// 用于前端渲染 OAuth 模板下的 provider 选择列表）。
func Providers() []struct {
	ID   string `json:"id"`
	Name string `json:"name"`
} {
	out := make([]struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}, 0, len(providers))
	for _, p := range providers {
		out = append(out, struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{ID: p.ID, Name: p.Name})
	}
	return out
}
