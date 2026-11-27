// Package aigen：生图/视频的哑执行通道——按前端渲染好的规格发同步 HTTP、
// 把产物解码/下载并落盘到工作区。Version 由宿主（main）注入用于 User-Agent。
package aigen

// 模板渲染与响应提取在前端纯函数层（ai-gen-model.js，可单测）；Go 侧保持「哑通道」：
// HTTPRequest 按前端渲染好的请求规格发一次同步 HTTP（复用 aitransport 的代理栈，
// 允许 localhost——本地 ComfyUI 是合法端点，与聊天账号 baseURL 同信任模型）；
// SaveProducts 把前端提取出的产物（b64 / URL）下载解码后写入工作区
// .cadt/gen/{kind}/YYYY-MM/（output_path 可覆盖为工作区内其他目录），路径越界一律拒绝。
// API Key 只在前端存储并已渲染进请求头，Go 不落日志；错误摘要做密钥形态脱敏。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/aitransport"
	"datalens/internal/atomfile"
	"datalens/internal/netguard"
	"datalens/internal/redact"
)

// Version 宿主注入：应用版本，用于 User-Agent（main/app_core.go 的 appVersion）。
var Version = ""

const (
	aiGenDefaultTimeout = 120
	aiGenMinTimeout     = 5
	aiGenMaxTimeout     = 300
	aiGenBodyLimit      = int64(64 << 20) // 响应体上限（含内嵌 b64 的 JSON）
	aiGenImageLimit     = int64(25 << 20)
	aiGenVideoLimit     = int64(220 << 20)
	aiGenMaxItems       = 16
)

// HTTPSpec 是前端渲染好的单次请求规格（URL/头/体已含占位符替换结果）。
// BodyBase64 给二进制请求体（multipart/form-data 的编辑端点）：JSON 字符串传不了原始字节，
// 前端把整个 multipart body base64 后放这里，Go 侧解码成 []byte 发送；非空时忽略 Body。
type HTTPSpec struct {
	URL        string            `json:"url"`
	Method     string            `json:"method"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BodyBase64 string            `json:"bodyBase64,omitempty"`
	Proxy      string            `json:"proxy"`
	TimeoutSec int               `json:"timeoutSec"`
	MaxBytes   int64             `json:"maxBytes"`
}

// HTTPResult 返回状态与响应体（非 2xx 也回体，前端按 errorPath 提取服务端错误文案）。
type HTTPResult struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Body        string `json:"body"`
	Bytes       int64  `json:"bytes"`
	Truncated   bool   `json:"truncated"`
	Error       string `json:"error,omitempty"`
}

// ProductItem 是前端从响应里提取出的单个产物：b64 数据或下载 URL。
type ProductItem struct {
	Type string `json:"type"` // "b64" | "url"
	MIME string `json:"mime"`
	Data string `json:"data,omitempty"`
	URL  string `json:"url,omitempty"`
}

// SaveSpec 落盘规格：workspace 根 + 可选工作区相对目录 + 产物清单。
// Headers 只作用于 url 类型的下载请求（有的服务端产物端点在独立路径上、需要鉴权；
// b64 类型不联网，用不到）。
type SaveSpec struct {
	Workspace  string            `json:"workspace"`
	OutputPath string            `json:"outputPath"`
	Kind       string            `json:"kind"` // image | video
	Proxy      string            `json:"proxy"`
	TimeoutSec int               `json:"timeoutSec"`
	Headers    map[string]string `json:"headers,omitempty"`
	// Endpoint 是本次生成请求的完整 URL（前端渲染后的同一地址）。用于判断产物
	// 与生成端点是否同 host——只有同 host 才转发鉴权头，见 aiGenDownloadURL。
	Endpoint string        `json:"endpoint,omitempty"`
	Items    []ProductItem `json:"items"`
}

// SavedFile 是落盘后的单个产物（路径回给模型继续引用）。
type SavedFile struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	MIME  string `json:"mime"`
}

type SaveResult struct {
	Files []SavedFile `json:"files,omitempty"`
	Error string      `json:"error,omitempty"`
}

// (a *App) AIGenHTTPRequest 是 Wails 绑定入口：按规格发一次同步 HTTP。
func HTTPRequest(specJSON string) HTTPResult {
	var spec HTTPSpec
	if err := json.Unmarshal([]byte(specJSON), &spec); err != nil {
		return HTTPResult{Error: "请求规格解析失败：" + err.Error()}
	}
	if !strings.HasPrefix(spec.URL, "http://") && !strings.HasPrefix(spec.URL, "https://") {
		return HTTPResult{Error: "URL 无效（需以 http:// 或 https:// 开头）"}
	}
	timeout := aiGenClampTimeout(spec.TimeoutSec)
	maxBytes := spec.MaxBytes
	if maxBytes <= 0 || maxBytes > aiGenBodyLimit {
		maxBytes = aiGenBodyLimit
	}
	cfg := aitransport.Config{Proxy: spec.Proxy}
	client, err := aitransport.NewHTTPClient(cfg)
	if err != nil {
		return HTTPResult{Error: err.Error()}
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()
	method := strings.ToUpper(strings.TrimSpace(spec.Method))
	if method == "" {
		method = http.MethodPost
	}
	var bodyReader io.Reader
	if method != http.MethodGet && method != http.MethodHead {
		if spec.BodyBase64 != "" {
			decoded, decodeErr := base64.StdEncoding.DecodeString(spec.BodyBase64)
			if decodeErr != nil {
				return HTTPResult{Error: "请求体 base64 解码失败：" + aiGenRedactError(decodeErr.Error())}
			}
			bodyReader = bytes.NewReader(decoded)
		} else {
			bodyReader = strings.NewReader(spec.Body)
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, spec.URL, bodyReader)
	if err != nil {
		return HTTPResult{Error: "请求构造失败：" + err.Error()}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(Version, "v")+" AI-Gen")
	for name, value := range spec.Headers {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if aitransport.ForbiddenHeader(name) {
			return HTTPResult{Error: "不允许自定义请求头：" + name}
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return HTTPResult{Error: "自定义请求头包含换行"}
		}
		req.Header.Set(name, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return HTTPResult{Error: "请求失败：" + aiGenRedactError(err.Error())}
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	truncated := false
	if int64(len(body)) > maxBytes {
		body = body[:maxBytes]
		truncated = true
	}
	result := HTTPResult{
		Status:      resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
		Body:        string(body),
		Bytes:       int64(len(body)),
		Truncated:   truncated,
	}
	if readErr != nil && len(body) == 0 {
		result.Error = "读取响应失败：" + aiGenRedactError(readErr.Error())
	}
	return result
}

// (a *App) AIGenSaveProducts 是 Wails 绑定入口：产物解码/下载并落盘到工作区。
func SaveProducts(specJSON string) SaveResult {
	var spec SaveSpec
	if err := json.Unmarshal([]byte(specJSON), &spec); err != nil {
		return SaveResult{Error: "落盘规格解析失败：" + err.Error()}
	}
	if len(spec.Items) == 0 {
		return SaveResult{Error: "没有可落盘的产物"}
	}
	if len(spec.Items) > aiGenMaxItems {
		return SaveResult{Error: fmt.Sprintf("产物数量超过上限 %d", aiGenMaxItems)}
	}
	kind := spec.Kind
	if kind != "image" && kind != "video" {
		kind = "image"
	}
	dir, err := aiGenResolveDir(spec.Workspace, spec.OutputPath, kind)
	if err != nil {
		return SaveResult{Error: err.Error()}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return SaveResult{Error: "创建产物目录失败：" + err.Error()}
	}
	limit := aiGenItemLimit(kind)
	client, err := aitransport.NewHTTPClient(aitransport.Config{Proxy: spec.Proxy})
	if err != nil {
		return SaveResult{Error: err.Error()}
	}
	defer client.CloseIdleConnections()
	timeout := aiGenClampTimeout(spec.TimeoutSec)
	stamp := strconv.FormatInt(time.Now().UnixNano(), 36)
	files := []SavedFile{}
	for idx, item := range spec.Items {
		var raw []byte
		var productMIME string
		switch strings.ToLower(item.Type) {
		case "b64":
			raw, productMIME, err = aiGenDecodeB64(item)
		case "url":
			raw, productMIME, err = aiGenDownloadURL(client, item, spec.Endpoint, timeout, limit, spec.Headers)
		default:
			err = fmt.Errorf("未知产物类型 %q（支持 b64 / url）", item.Type)
		}
		if err != nil {
			return SaveResult{Error: fmt.Sprintf("产物 %d 处理失败：%s", idx+1, aiGenRedactError(err.Error()))}
		}
		if int64(len(raw)) > limit {
			return SaveResult{Error: fmt.Sprintf("产物 %d 超过大小上限（%d MB）", idx+1, limit>>20)}
		}
		name := fmt.Sprintf("gen-%s-%d.%s", stamp, idx+1, aiGenExtFor(productMIME, kind))
		path := filepath.Join(dir, name)
		if err := atomfile.WriteFileAtomic(path, raw); err != nil {
			return SaveResult{Error: "写入产物失败：" + err.Error()}
		}
		files = append(files, SavedFile{Path: path, Bytes: int64(len(raw)), MIME: productMIME})
	}
	return SaveResult{Files: files}
}

// aiGenResolveDir 解析产物目录：缺省 <workspace>/.cadt/gen/{kind}/YYYY-MM/，
// outputPath（工作区相对）覆盖；绝对路径 / .. 逃逸 / 越出工作区一律拒绝。
func aiGenResolveDir(workspace, outputPath, kind string) (string, error) {
	if strings.TrimSpace(workspace) == "" {
		return "", fmt.Errorf("没有工作区，无法落盘生成产物")
	}
	wsAbs, err := filepath.Abs(workspace)
	if err != nil {
		return "", fmt.Errorf("工作区路径无效：%s", err.Error())
	}
	rel := filepath.Join(".cadt", "gen", kind, time.Now().Format("2006-01"))
	if strings.TrimSpace(outputPath) != "" {
		if filepath.IsAbs(outputPath) || filepath.VolumeName(outputPath) != "" {
			return "", fmt.Errorf("output_path 必须是工作区相对路径：%s", outputPath)
		}
		rel = filepath.Clean(outputPath)
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("output_path 不能逃出工作区：%s", outputPath)
		}
	}
	dir := filepath.Join(wsAbs, rel)
	checkRel, relErr := filepath.Rel(wsAbs, dir)
	if relErr != nil || checkRel == ".." || strings.HasPrefix(checkRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("output_path 越出工作区：%s", outputPath)
	}
	return dir, nil
}

// aiGenDecodeB64 解码前端提取的 b64 产物（容忍 data URL 前缀），类型嗅探补 mime。
func aiGenDecodeB64(item ProductItem) ([]byte, string, error) {
	data := item.Data
	if idx := strings.Index(data, "base64,"); idx >= 0 {
		data = data[idx+len("base64,"):]
	}
	data = strings.Join(strings.Fields(data), "")
	if data == "" {
		return nil, "", fmt.Errorf("b64 数据为空")
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return nil, "", fmt.Errorf("base64 解码失败：%s", err.Error())
	}
	productMIME := aiGenNormalizeMIME(item.MIME)
	if productMIME == "" || productMIME == "application/octet-stream" {
		productMIME = aiGenNormalizeMIME(http.DetectContentType(raw))
	}
	return raw, productMIME, nil
}

// aiGenCheckProductURL 校验产物 URL 并判定是否与生成端点同 host。
// 不同 host 时要求域名解析结果全为公网地址（连接时还有拨号守卫兜底）。
func aiGenCheckProductURL(raw, endpoint string) (string, bool, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil {
		return "", false, fmt.Errorf("产物 URL 无效（需为 http/https 绝对地址，且不能带账号信息）")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false, fmt.Errorf("产物 URL 无效（需以 http:// 或 https:// 开头）")
	}
	sameHost := false
	if e, eerr := url.Parse(strings.TrimSpace(endpoint)); eerr == nil && e.Host != "" {
		sameHost = strings.EqualFold(e.Hostname(), u.Hostname())
	}
	if !sameHost {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, lerr := netguard.LookupPublicIPs(ctx, u.Hostname()); lerr != nil {
			return "", false, fmt.Errorf("产物地址不可下载：%s", lerr.Error())
		}
	}
	return u.String(), sameHost, nil
}

// aiGenHardenedClient 给「跨 host 下载」加拨号守卫：直连时连接阶段再校验一次
// 实际 IP（封 DNS 重绑定）。走代理时不挂——那时拨号目标是代理本身（常在本机），
// 挂了会把正常请求一起拒掉，只能依赖 aiGenCheckProductURL 的预检。
func aiGenHardenedClient(client *http.Client, req *http.Request, sameHost bool) *http.Client {
	if sameHost {
		return client // 同 host = 用户自己配置的生成端点，允许内网（本地 ComfyUI 等）
	}
	tr, ok := client.Transport.(*http.Transport)
	if !ok {
		return client
	}
	if tr.Proxy != nil {
		if p, err := tr.Proxy(req); err == nil && p != nil {
			return client
		}
	}
	clone := tr.Clone()
	dialer := netguard.Dialer()
	dialer.Timeout = 30 * time.Second
	dialer.KeepAlive = 30 * time.Second
	clone.DialContext = dialer.DialContext
	return &http.Client{Transport: clone, Timeout: client.Timeout, CheckRedirect: client.CheckRedirect}
}

// aiGenDownloadURL 下载 URL 产物（走用户配置的代理栈，限长 + 超时）。
//
// 安全边界：产物 URL 来自生成服务端的响应，属不可信输入。因此
//   - 只接受 http/https 绝对地址，拒绝 userinfo（https://host@evil 之类）；
//   - 与生成端点（endpoint）不同 host 时：不转发任何自定义请求头（鉴权头只会
//     发给生成端点本身，避免 API Key 随恶意/抢注 URL 外泄），且目标必须是公网地址
//     （预检 + 直连时拨号守卫，封 SSRF 与 DNS 重绑定）；
//   - 同 host 时保持原有行为（含鉴权头），支持 /v1/videos/{id}/content 这类端点。
func aiGenDownloadURL(client *http.Client, item ProductItem, endpoint string, timeoutSec int, limit int64, headers map[string]string) ([]byte, string, error) {
	target, sameHost, err := aiGenCheckProductURL(item.URL, endpoint)
	if err != nil {
		return nil, "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, "", fmt.Errorf("下载请求构造失败：%s", err.Error())
	}
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(Version, "v")+" AI-Gen")
	if sameHost {
		for name, value := range headers {
			name = strings.TrimSpace(name)
			if name == "" || aitransport.ForbiddenHeader(name) {
				continue
			}
			if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
				continue
			}
			req.Header.Set(name, value)
		}
	}
	resp, err := aiGenHardenedClient(client, req, sameHost).Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("下载失败：%s", err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 附上服务端响应片段：产物地址错误 / 端点返回错误 JSON 时，光报 HTTP 码无法定位
		// （实测「下载失败 HTTP 400」其实是上游请求体问题，响应体里有线索）。限长 + 脱敏。
		preview, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		hint := strings.TrimSpace(string(preview))
		if hint != "" {
			return nil, "", fmt.Errorf("下载失败：HTTP %d，服务端响应：%s", resp.StatusCode, aiGenRedactError(aiGenSnippet(hint)))
		}
		return nil, "", fmt.Errorf("下载失败：HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", fmt.Errorf("下载读取失败：%s", err.Error())
	}
	productMIME := aiGenNormalizeMIME(item.MIME)
	if productMIME == "" || productMIME == "application/octet-stream" {
		productMIME = aiGenNormalizeMIME(resp.Header.Get("Content-Type"))
	}
	if productMIME == "" || productMIME == "application/octet-stream" {
		productMIME = aiGenNormalizeMIME(http.DetectContentType(raw))
	}
	return raw, productMIME, nil
}

// aiGenNormalizeMIME 去掉参数段（image/png; charset=... → image/png），小写归一。
func aiGenNormalizeMIME(raw string) string {
	parsed, _, err := mime.ParseMediaType(strings.TrimSpace(raw))
	if err != nil {
		return strings.ToLower(strings.TrimSpace(strings.SplitN(raw, ";", 2)[0]))
	}
	return strings.ToLower(parsed)
}

// aiGenExtFor mime → 扩展名（与前端 genExtFor 同表）；未知 mime 按产物类型兜底。
func aiGenExtFor(productMIME, kind string) string {
	switch productMIME {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "video/mp4":
		return "mp4"
	case "video/webm":
		return "webm"
	case "video/x-msvideo":
		return "avi"
	case "video/quicktime":
		return "mov"
	}
	if strings.HasPrefix(productMIME, "image/") {
		return "png"
	}
	if strings.HasPrefix(productMIME, "video/") {
		return "mp4"
	}
	if kind == "video" {
		return "mp4"
	}
	return "png"
}

func aiGenItemLimit(kind string) int64 {
	if kind == "video" {
		return aiGenVideoLimit
	}
	return aiGenImageLimit
}

func aiGenClampTimeout(seconds int) int {
	if seconds < aiGenMinTimeout {
		return aiGenMinTimeout
	}
	if seconds > aiGenMaxTimeout {
		return aiGenMaxTimeout
	}
	return seconds
}

// aiGenSnippet 把服务端响应片段压成安全的一行摘要：去控制字符、限长，避免错误文案里塞进
// 大段 HTML / 换行把工具卡撑爆。与 aiGenRedactError 串用（先压片段再打码密钥）。
func aiGenSnippet(text string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(text) {
		if r <= 0x20 || r == 0x7f { // 含普通空格：连续空白（\n\t 与空格混排）只压成一个
			space = true
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
		if b.Len() >= 200 {
			break
		}
	}
	return b.String()
}

// aiGenRedactError 错误摘要脱敏：URL 查询串里的 key/token 类参数值打码（密钥可能出现在
// 失败请求的 URL 回显里；请求头由 Go net/http 不回显）。
func aiGenRedactError(text string) string {
	return redact.Secrets(text)
}
