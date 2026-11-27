// Package oauthquota：通用 OAuth 控制台额度查询引擎——按 Provider 配置驱动，
// 走 Hydra OIDC 授权码流程（PKCE S256 + JWKS RSA-OAEP/SHA-1 封密码成 JWE +
// IAM 登录 + token 交换 + refresh 轮转），拿到 token 后带 Bearer 查官方控制台
// 端点，原始响应回前端脚本模板的 extractor 解析。SenseNova 只是内置 Provider
// 之一（照 dsh 插件 dsh-connect-sensenova-token-plan 实现）；新增服务商只加一条
// ProviderConfig，不改引擎。密码只在登录瞬间用不落盘，refresh token 存 DPAPI
// 加密文件（非 Windows 明文，与 envvars / aiconfig 同口径）。
package oauthquota

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1" // #nosec G505 -- 平台 JWKS 的 alg=RSA-OAEP 明确用 SHA-1，不可改
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Provider 描述一家 OAuth 控制台的配置。端点/参数全在这里，引擎不含厂商硬编码。
type Provider struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ConsoleOrigin string `json:"consoleOrigin"`
	IAMOrigin     string `json:"iamOrigin"`
	TokenURL      string `json:"tokenUrl"`
	JWKSURL       string `json:"jwksUrl"`
	ClientID      string `json:"clientId"`
	Scope         string `json:"scope"`
	EncKeyID      string `json:"encKeyId"`     // JWKS 里封密码用的 kid；空 = 不封密码
	IAMLoginPath  string `json:"iamLoginPath"` // IAM 登录路径（相对 iamOrigin）
	UsagePath     string `json:"usagePath"`    // 额度查询路径（相对 consoleOrigin，{{baseUrl}} 占位在前端指定）
	RedirectURI   string `json:"redirectUri"`  // 空 = consoleOrigin
	UserAgent     string `json:"userAgent"`
}

// providers 是内置表。SenseNova 照 dsh 插件实现；新增厂商在这里加一条即可。
var providers = map[string]Provider{
	"sensenova": {
		ID:            "sensenova",
		Name:          "SenseNova",
		ConsoleOrigin: "https://platform.sensenova.cn",
		IAMOrigin:     "https://iam.sensecoreapi.cn",
		TokenURL:      "https://signin.sensecore.cn/oauth2/token",
		JWKSURL:       "https://signin.sensecore.cn/.well-known/jwks.json",
		ClientID:      "nova",
		Scope:         "openid offline offline_access",
		EncKeyID:      "public:hydra.openid.id-token",
		IAMLoginPath:  "/iam/authn/v1/auth/nova/login",
		UsagePath:     "/lite/console/v1/tokenplan/pool-usage",
		UserAgent:     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
	},
}

// ProviderByID 取内置 Provider；未注册返回 ok=false。
func ProviderByID(id string) (Provider, bool) {
	p, ok := providers[id]
	if ok && p.RedirectURI == "" {
		p.RedirectURI = p.ConsoleOrigin
	}
	if ok && p.UserAgent == "" {
		p.UserAgent = defaultUserAgent
	}
	return p, ok
}

const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"

const (
	requestTimeout   = 20 * time.Second
	jwksTTL          = 10 * time.Minute
	maxRedirectHops  = 8
	tokenSkewSeconds = 120 // token 至少再活 2 分钟才算新鲜
)

var (
	loginChallengeRe = regexp.MustCompile(`[?&]login_challenge=`)
	authCodeRe       = regexp.MustCompile(`[?&]code=`)
	urlInBodyRe      = regexp.MustCompile(`https?://[^"'\s<>]+[?&][^"'\s<>]*`)
	metaRefreshRe    = regexp.MustCompile(`(?i)<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)`)
	jsLocationRes    = []*regexp.Regexp{
		regexp.MustCompile(`window\.location\.replace\(["']([^"']+)["']`),
		regexp.MustCompile(`window\.location\.href\s*=\s*["']([^"']+)["']`),
		regexp.MustCompile(`location\.href\s*=\s*["']([^"']+)["']`),
		regexp.MustCompile(`window\.location\s*=\s*["']([^"']+)["']`),
	}
)

type jwksCacheEntry struct {
	keys []jwksKey
	at   time.Time
}

type jwksKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}

var jwksCache = struct {
	mu      sync.Mutex
	entries map[string]*jwksCacheEntry
}{entries: make(map[string]*jwksCacheEntry)}

func jwksCacheFor(endpoint string) *jwksCacheEntry {
	jwksCache.mu.Lock()
	defer jwksCache.mu.Unlock()
	entry := jwksCache.entries[endpoint]
	if entry != nil && time.Since(entry.at) < jwksTTL {
		return entry
	}
	return nil
}

func setJWKSCache(endpoint string, keys []jwksKey) {
	jwksCache.mu.Lock()
	defer jwksCache.mu.Unlock()
	jwksCache.entries[endpoint] = &jwksCacheEntry{keys: keys, at: time.Now()}
}

// errNotFound 用于 JWKS 找不到 kid 的分支。
var errNoKey = errors.New("JWKS 里没有加密公钥")

func b64url(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func b64urlDecode(text string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(text, "="))
}

// pkcePair 生成 RFC 7636 S256 的 verifier / challenge（48 随机字节 → 64 字符）。
func pkcePair() (verifier, challenge string, err error) {
	raw := make([]byte, 48)
	if _, err = rand.Read(raw); err != nil {
		return "", "", err
	}
	verifier = b64url(raw)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, b64url(sum[:]), nil
}

func randomNonce() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return b64url(raw), nil
}

func fetchJWKS(endpoint string) ([]jwksKey, error) {
	if entry := jwksCacheFor(endpoint); entry != nil {
		return entry.keys, nil
	}
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("JWKS HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var doc struct {
		Keys []jwksKey `json:"keys"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	if len(doc.Keys) == 0 {
		return nil, errors.New("JWKS 返回空 key set")
	}
	setJWKSCache(endpoint, doc.Keys)
	return doc.Keys, nil
}

// sealPassword 把密码封成平台 IAM 接受的 5 段紧凑 JWE：
// RSA-OAEP(SHA-1) 包 AES-256 key + A256GCM 加密密码，AAD 是 protected header 的
// base64url 段（RFC 7516 §5.1 step 14，不是 JSON 原文）。
func sealPassword(password string, p Provider) (string, error) {
	keys, err := fetchJWKS(p.JWKSURL)
	if err != nil {
		return "", err
	}
	var target *jwksKey
	for i := range keys {
		if keys[i].Kid == p.EncKeyID {
			target = &keys[i]
			break
		}
	}
	if target == nil {
		return "", errNoKey
	}
	nBytes, err := b64urlDecode(target.N)
	if err != nil {
		return "", err
	}
	eBytes, err := b64urlDecode(target.E)
	if err != nil {
		return "", err
	}
	if len(nBytes) == 0 || len(eBytes) == 0 {
		return "", errors.New("JWKS key 缺 n/e")
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: int(new(big.Int).SetBytes(eBytes).Int64())}

	contentKey := make([]byte, 32)
	if _, err := rand.Read(contentKey); err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	header := b64url([]byte(`{"alg":"RSA-OAEP","enc":"A256GCM"}`))
	block, err := aes.NewCipher(contentKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(password), []byte(header))
	const tagLen = 16
	if len(sealed) < tagLen {
		return "", errors.New("AES-GCM 输出异常")
	}
	ciphertext, tag := sealed[:len(sealed)-tagLen], sealed[len(sealed)-tagLen:]
	wrappedKey, err := rsa.EncryptOAEP(sha1.New(), rand.Reader, pub, contentKey, nil) // #nosec G505 -- 平台规定
	if err != nil {
		return "", err
	}
	return strings.Join([]string{header, b64url(wrappedKey), b64url(iv), b64url(ciphertext), b64url(tag)}, "."), nil
}
