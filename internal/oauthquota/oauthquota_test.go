package oauthquota

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
)

func TestProviderTable(t *testing.T) {
	p, ok := ProviderByID("sensenova")
	if !ok {
		t.Fatal("sensenova provider 缺失")
	}
	if p.ConsoleOrigin != "https://platform.sensenova.cn" || p.TokenURL == "" || p.JWKSURL == "" {
		t.Fatalf("sensenova 配置不完整：%+v", p)
	}
	if p.RedirectURI != p.ConsoleOrigin || p.UserAgent == "" {
		t.Fatal("RedirectURI / UserAgent 默认值没填")
	}
	if p.EncKeyID == "" || p.IAMLoginPath == "" || p.UsagePath == "" {
		t.Fatal("登录/额度端点缺配置")
	}
	if _, ok := ProviderByID("not-exist"); ok {
		t.Fatal("未注册 provider 不该命中")
	}
}

func TestPKCEPair(t *testing.T) {
	verifier, challenge, err := pkcePair()
	if err != nil {
		t.Fatal(err)
	}
	if len(verifier) < 43 || len(verifier) > 128 {
		t.Fatalf("PKCE verifier 长度越界：%d", len(verifier))
	}
	sum := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if challenge != want {
		t.Fatalf("challenge 不是 verifier 的 S256：%s != %s", challenge, want)
	}
	// 两次生成必须不同（随机源有效）
	verifier2, _, _ := pkcePair()
	if verifier2 == verifier {
		t.Fatal("两次 PKCE verifier 相同")
	}
}

func TestSealPasswordJWE(t *testing.T) {
	// 生成一把测试 RSA key，按 JWKS 的 n/e 形态喂给 sealPassword，验证 5 段 JWE 结构。
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())
	doc, _ := json.Marshal(map[string]any{"keys": []map[string]string{
		{"kid": "test-key", "kty": "RSA", "n": n, "e": e},
	}})
	// 直接设置缓存，避开网络（fetchJWKS 命中缓存即返回）
	setJWKSCache("https://test.jwks", mustParseKeys(t, doc))

	p := Provider{EncKeyID: "test-key", JWKSURL: "https://test.jwks"}
	sealed, err := sealPassword("my-password", p)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(sealed, ".")
	if len(parts) != 5 {
		t.Fatalf("JWE 应有 5 段，实际 %d：%s", len(parts), sealed)
	}
	for i, part := range parts {
		if part == "" {
			t.Fatalf("JWE 第 %d 段为空", i+1)
		}
		if _, err := base64.RawURLEncoding.DecodeString(part); err != nil {
			t.Fatalf("JWE 第 %d 段不是 base64url：%v", i+1, err)
		}
	}
	// header 段解码后是 {"alg":"RSA-OAEP","enc":"A256GCM"}
	header, _ := base64.RawURLEncoding.DecodeString(parts[0])
	if !strings.Contains(string(header), "RSA-OAEP") || !strings.Contains(string(header), "A256GCM") {
		t.Fatalf("JWE header 不符：%s", header)
	}
	// 换 kid 必须报找不到 key
	p.EncKeyID = "missing"
	if _, err := sealPassword("x", p); err == nil {
		t.Fatal("换错 kid 应该报错")
	}
}

func mustParseKeys(t *testing.T, raw []byte) []jwksKey {
	t.Helper()
	var doc struct {
		Keys []jwksKey `json:"keys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Keys
}

func TestCredentialPathIsolation(t *testing.T) {
	a := credentialsPath("sensenova")
	b := credentialsPath("other-provider")
	if a == b {
		t.Fatal("不同 provider 的凭据路径相同")
	}
	if !strings.Contains(a, "oauth-sensenova") || !strings.HasSuffix(a, ".json") {
		t.Fatalf("凭据路径形态不对：%s", a)
	}
	if credentialsPath("../evil") == credentialsPath("evil") {
		t.Fatal("路径穿越清洗失效")
	}
}

func TestFetchURLGuard(t *testing.T) {
	// 未注册 provider：直接返回带错误文案的 result，不发请求
	result, err := Fetch("not-exist", "https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	if result.Error == "" || result.Status != 0 {
		t.Fatalf("未注册 provider 应回错误 result：%+v", result)
	}
	// 注册 provider 但 URL 不在 ConsoleOrigin 下：拒绝
	result, err = Fetch("sensenova", "https://evil.example.com/usage")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Error, "platform.sensenova.cn") {
		t.Fatalf("跨域 URL 应被拒：%+v", result)
	}
}

// 前缀比较的两个经典绕过：子域拼接与 userinfo 伪装。两种都必须被 sameOrigin 拒掉。
func TestFetchURLGuardPrefixBypass(t *testing.T) {
	cases := []string{
		"https://platform.sensenova.cn.evil.com/x",
		"https://platform.sensenova.cn@evil.com/x",
		"http://platform.sensenova.cn/x",       // scheme 不同
		"https://platform.sensenova.cn:8443/x", // 端口不同
		"https://PLATFORM.SENSENOVA.CN.evil.com/x",
	}
	for _, target := range cases {
		result, err := Fetch("sensenova", target)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		if result.Error == "" {
			t.Fatalf("%s 应被拒，实际放行：%+v", target, result)
		}
	}
	// 正常同源（含大小写差异）仍应通过校验，只是随后会因无凭据而报错
	for _, target := range []string{
		"https://platform.sensenova.cn/x",
		"https://Platform.SenseNova.CN/x",
	} {
		if !sameOrigin(target, "https://platform.sensenova.cn") {
			t.Fatalf("%s 应通过同源校验", target)
		}
	}
}
