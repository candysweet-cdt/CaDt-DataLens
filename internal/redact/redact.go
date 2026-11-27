// Package redact：错误文本与日志里的凭据形态脱敏。
//
// 网关把请求头（Authorization / x-api-key）原样回显进错误体、或错误里带
// `?api_key=...` 查询串时，直接把响应片段回传前端 / 写日志等于泄露密钥。
// 这里集中一套规则，aigen 与 aiusage 共用，避免"同域两条路径一条脱敏一条不脱敏"。
package redact

import (
	"regexp"
	"strings"
)

var (
	// Bearer <token>：Authorization 回显最常见形态。
	bearerRe = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=\-]{6,}`)
	// 常见供应商密钥前缀（sk- / ak- / pk-）。
	keyPrefixRe = regexp.MustCompile(`\b(?:sk|ak|pk)-[A-Za-z0-9_\-]{6,}`)
	// 形如 "api_key": "..." / x-api-key: ... 的 JSON / 头部回显。
	// Authorization 交给 bearerRe 处理：这里若一起吞会连 "Bearer" 这个词也替换掉，
	// 得到 "*** ***" 这种难读的输出。
	headerKeyRe = regexp.MustCompile(`(?i)((?:api[_-]?key|x-api-key|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',}]+`)
)

// Secrets 对文本做凭据形态脱敏，返回仍是可读的单段文本。
func Secrets(text string) string {
	if text == "" {
		return text
	}
	text = redactQuery(text)
	text = bearerRe.ReplaceAllString(text, "${1}***")
	text = headerKeyRe.ReplaceAllString(text, "${1}***")
	text = keyPrefixRe.ReplaceAllString(text, "***")
	return text
}

// redactQuery 处理 URL 查询串里的密钥参数（只打码第一个，保持原有行为）。
func redactQuery(text string) string {
	idx := strings.Index(text, "?")
	if idx < 0 || idx >= len(text)-1 {
		return text
	}
	query := text[idx+1:]
	if amp := strings.Index(query, "&"); amp >= 0 {
		query = query[:amp]
	}
	eq := strings.Index(query, "=")
	if eq <= 0 {
		return text
	}
	key := strings.ToLower(query[:eq])
	if !strings.Contains(key, "key") && !strings.Contains(key, "token") && !strings.Contains(key, "secret") {
		return text
	}
	return text[:idx+1] + query[:eq] + "=***" + text[idx+1+len(query):]
}
