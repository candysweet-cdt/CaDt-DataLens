// deepseek.go：服务提供商（DeepSeek 工具 API）适配层——搜索 / 抓取 / OCR / TTS / ASR。
// 契约按官方文档 2026-11-16 核对（/v1/tools/*）。TTS 边读边写临时文件，失败清理半成品。
package webtools

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"datalens/internal/aitransport"
)

const (
	providerTimeout       = 10 * time.Minute
	providerMaxResponse   = 32 << 20
	providerAudioMax      = 64 << 20
	providerOCRMaxFile    = 100 << 20
	providerASRMaxFile    = 20 << 20
	providerTTSMaxChars   = 5000
	providerSearchMaxRune = 128
	providerErrorSnippet  = 300
	audioDataURLMax       = 20 << 20
)

var providerCapabilityLabels = map[string]string{
	"search": "网页搜索",
	"fetch":  "网页抓取",
	"ocr":    "OCR / 文件解析",
	"tts":    "语音合成",
	"asr":    "语音识别",
}

// ===== 供应商响应类型 =====
type providerSearchItem struct {
	RerankScore float64 `json:"rerank_score"`
	Title       string  `json:"title"`
	URL         string  `json:"url"`
	Snippet     string  `json:"snippet"`
	Summary     string  `json:"summary"`
	Content     string  `json:"content"`
	SiteName    *string `json:"site_name"`
	SiteIcon    *string `json:"site_icon"`
	Date        *string `json:"date"`
	Authority   int     `json:"authority"`
}

type providerOCRPage struct {
	Index        int    `json:"index"`
	Text         string `json:"text"`
	FinishReason string `json:"finish_reason"`
}

type providerOCRResponse struct {
	ID        string            `json:"id"`
	Object    string            `json:"object"`
	Created   int64             `json:"created"`
	Purpose   string            `json:"purpose"`
	PageCount int               `json:"page_count"`
	Pages     []providerOCRPage `json:"pages"`
	Usage     struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
		TotalTokens  int64 `json:"total_tokens"`
	} `json:"usage"`
}

type providerASRResponse struct {
	RequestID  string `json:"request_id"`
	Text       string `json:"text"`
	DurationMs int64  `json:"duration_ms"`
}

// ===== 搜索与抓取 =====
// ProviderSearch 调 DeepSeek 网页搜索，返回与内置搜索一致的 results 结构。
func ProviderSearch(cfg Config, query string, maxResults int) (map[string]interface{}, error) {
	started := time.Now()
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, errors.New("搜索词为空")
	}
	if utf8.RuneCountInString(q) > providerSearchMaxRune {
		return nil, fmt.Errorf("搜索词过长（服务提供商最多 %d 字）", providerSearchMaxRune)
	}
	n := maxResults
	if n <= 0 {
		n = 10
	}
	if n < 1 {
		n = 1
	}
	if n > 50 {
		n = 50
	}
	var resp struct {
		Results []providerSearchItem `json:"results"`
	}
	if err := providerPostJSON(cfg, "search", map[string]interface{}{"query": q, "count": n}, &resp); err != nil {
		return nil, err
	}
	results := make([]map[string]string, 0, len(resp.Results))
	for _, item := range resp.Results {
		link := strings.TrimSpace(item.URL)
		if !strings.HasPrefix(link, "http://") && !strings.HasPrefix(link, "https://") {
			continue
		}
		snippet := strings.TrimSpace(item.Snippet)
		if snippet == "" {
			snippet = strings.TrimSpace(item.Summary)
		}
		published := ""
		if item.Date != nil {
			published = strings.TrimSpace(*item.Date)
		}
		results = append(results, map[string]string{
			"title":     webTruncateRunesOnly(webCleanInline(item.Title), 200),
			"url":       link,
			"snippet":   webTruncateRunesOnly(webCleanInline(snippet), 320),
			"published": published,
		})
		if len(results) >= n {
			break
		}
	}
	return map[string]interface{}{
		"query":     q,
		"engine":    "deepseek",
		"results":   results,
		"elapsedMs": time.Since(started).Milliseconds(),
	}, nil
}

// ProviderFetch 调 DeepSeek 网页抓取，Markdown 正文映射到 web_fetch 既有结构。
func ProviderFetch(cfg Config, rawURL string, maxChars int) (map[string]interface{}, error) {
	started := time.Now()
	limit := maxChars
	if limit <= 0 {
		limit = webFetchDefaultChars
	}
	if limit > webFetchMaxChars {
		limit = webFetchMaxChars
	}
	target, err := providerValidateFetchURL(rawURL)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := providerPostJSON(cfg, "fetch", map[string]interface{}{"url": target}, &resp); err != nil {
		return nil, err
	}
	text := strings.ReplaceAll(resp.Content, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimSpace(text)
	text, textTruncated := webTruncateRunes(text, limit)
	title := webTruncateRunesOnly(webCleanInline(resp.Title), 200)
	return map[string]interface{}{
		"url":         rawURL,
		"finalUrl":    target,
		"status":      200,
		"contentType": "text/markdown",
		"charset":     "utf-8",
		"title":       title,
		"text":        text,
		"links":       []map[string]string{},
		"truncated":   textTruncated,
		"bytes":       len(resp.Content),
		"engine":      "deepseek",
		"elapsedMs":   time.Since(started).Milliseconds(),
	}, nil
}

// ===== OCR / TTS / ASR 能力 =====
// ProviderOCR 上传文件做 OCR / 文件解析，按页返回文本。
func ProviderOCR(cfg Config, path, purpose string) (map[string]interface{}, error) {
	started := time.Now()
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("不是文件")
	}
	if info.Size() > providerOCRMaxFile {
		return nil, fmt.Errorf("文件超过 %d MB，无法上传识别", providerOCRMaxFile>>20)
	}
	purpose = strings.ToLower(strings.TrimSpace(purpose))
	if purpose == "" {
		purpose = "text_recognition"
	}
	if purpose != "text_recognition" && purpose != "rich_layout_recognition" {
		return nil, errors.New("purpose 只能是 text_recognition 或 rich_layout_recognition")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var resp providerOCRResponse
	if err := providerMultipartPost(cfg, "ocr", "file", filepath.Base(path), raw, map[string]string{"purpose": purpose}, &resp); err != nil {
		return nil, err
	}
	pages := make([]map[string]interface{}, 0, len(resp.Pages))
	for _, page := range resp.Pages {
		pages = append(pages, map[string]interface{}{
			"index":        page.Index,
			"text":         page.Text,
			"finishReason": page.FinishReason,
		})
	}
	return map[string]interface{}{
		"engine":    "deepseek",
		"id":        resp.ID,
		"purpose":   purpose,
		"pageCount": resp.PageCount,
		"pages":     pages,
		"usage": map[string]interface{}{
			"inputTokens":  resp.Usage.InputTokens,
			"outputTokens": resp.Usage.OutputTokens,
			"totalTokens":  resp.Usage.TotalTokens,
		},
		"elapsedMs": time.Since(started).Milliseconds(),
	}, nil
}

// ProviderTTS 调 DeepSeek 语音合成，音频流边读边写临时文件，完成后原子改名到
// <workspace>/.cadt/gen/tts/。
func ProviderTTS(cfg Config, workspace, text, voice string) (map[string]interface{}, error) {
	started := time.Now()
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, errors.New("朗读文本为空")
	}
	if utf8.RuneCountInString(text) > providerTTSMaxChars {
		return nil, fmt.Errorf("文本过长（最多 %d 字，请分段后再试）", providerTTSMaxChars)
	}
	voice = strings.ToLower(strings.TrimSpace(voice))
	if voice == "" {
		voice = "stella"
	}
	if voice != "stella" && voice != "tide" {
		return nil, errors.New("voice 只能是 stella（女声）或 tide（男声）")
	}
	ws := strings.TrimSpace(workspace)
	if ws == "" {
		return nil, errors.New("当前没有工作区，无法保存语音产物")
	}
	wsAbs, err := filepath.Abs(ws)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(wsAbs, ".cadt", "gen", "tts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	endpoint, err := providerEndpoint(cfg, "tts")
	if err != nil {
		return nil, err
	}
	payload := map[string]interface{}{
		"text":            text,
		"voice_id":        voice,
		"format":          "wav",
		"filter_markdown": true,
	}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(rawPayload))
	if err != nil {
		return nil, fmt.Errorf("请求创建失败：%w", err)
	}
	providerSetHeaders(req, cfg)
	req.Header.Set("Content-Type", "application/json")
	resp, err := providerClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("语音合成请求失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, providerHTTPError(resp.StatusCode, body)
	}
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, providerHTTPError(resp.StatusCode, body)
	}
	tmp, err := os.CreateTemp(dir, ".tts-*.tmp")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(tmpPath)
		}
	}()
	n, err := io.Copy(tmp, io.LimitReader(resp.Body, providerAudioMax+1))
	if err != nil {
		return nil, fmt.Errorf("读取音频流失败：%w", err)
	}
	if n > providerAudioMax {
		return nil, fmt.Errorf("音频超过 %d MB，已中止", providerAudioMax>>20)
	}
	if n == 0 {
		return nil, errors.New("服务提供商返回了空音频")
	}
	if err := tmp.Sync(); err != nil {
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	name := "tts-" + time.Now().Format("20060102-150405") + "-" + providerRandHex(3) + ".wav"
	finalPath := filepath.Join(dir, name)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return nil, err
	}
	committed = true
	return map[string]interface{}{
		"engine":    "deepseek",
		"path":      finalPath,
		"relPath":   filepath.ToSlash(filepath.Join(".cadt", "gen", "tts", name)),
		"bytes":     n,
		"chars":     utf8.RuneCountInString(text),
		"voice":     voice,
		"elapsedMs": time.Since(started).Milliseconds(),
	}, nil
}

// ProviderASR 上传音频做语音识别。音频应为 16 位 PCM WAV 或 Ogg Opus。
func ProviderASR(cfg Config, name string, audio []byte) (map[string]interface{}, error) {
	started := time.Now()
	if len(audio) == 0 {
		return nil, errors.New("音频为空")
	}
	if len(audio) > providerASRMaxFile {
		return nil, fmt.Errorf("音频超过 %d MB，无法上传识别", providerASRMaxFile>>20)
	}
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "audio.wav"
	}
	var resp providerASRResponse
	if err := providerMultipartPost(cfg, "asr", "file", name, audio, nil, &resp); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"engine":     "deepseek",
		"text":       resp.Text,
		"durationMs": resp.DurationMs,
		"requestId":  resp.RequestID,
		"bytes":      len(audio),
		"elapsedMs":  time.Since(started).Milliseconds(),
	}, nil
}

// ===== 音频输入处理 =====
// AudioBytesForASR 解析 ASR 上传字节：给了转码后的 base64 就用它，否则读本地文件。
func AudioBytesForASR(path, wavBase64 string) ([]byte, error) {
	if strings.TrimSpace(wavBase64) != "" {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(wavBase64))
		if err != nil {
			return nil, errors.New("转码音频数据无效")
		}
		return raw, nil
	}
	return ReadAudioFile(path)
}

// ReadAudioFile 读取本地音频原始字节（仅音频扩展名、≤20 MB）。
func ReadAudioFile(path string) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("没有音频路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("不是音频文件")
	}
	if info.Size() > audioDataURLMax {
		return nil, fmt.Errorf("音频超过 %d MB，请先裁剪后再试", audioDataURLMax>>20)
	}
	if audioMimeByExt(strings.ToLower(filepath.Ext(path))) == "" {
		return nil, errors.New("不支持的音频格式（支持 wav / mp3 / m4a / aac / ogg / opus / flac / webm）")
	}
	return os.ReadFile(path)
}

// ReadAudioDataURL 把本地音频读成 data URL（前端转码链的输入）。
func ReadAudioDataURL(path string) (string, error) {
	raw, err := ReadAudioFile(path)
	if err != nil {
		return "", err
	}
	mimeType := audioMimeByExt(strings.ToLower(filepath.Ext(strings.TrimSpace(path))))
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func audioMimeByExt(ext string) string {
	switch ext {
	case ".wav":
		return "audio/wav"
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".ogg":
		return "audio/ogg"
	case ".opus":
		return "audio/opus"
	case ".flac":
		return "audio/flac"
	case ".webm":
		return "audio/webm"
	case ".wma":
		return "audio/x-ms-wma"
	case ".ape":
		return "audio/x-ape"
	}
	return ""
}

// ===== HTTP 请求辅助 =====
func providerEndpoint(cfg Config, op string) (string, error) {
	base := strings.TrimSpace(cfg.BaseURL)
	if base == "" {
		base = DefaultProviderBaseURL
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("服务提供商基础地址无效：%w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("服务提供商基础地址只支持 http/https")
	}
	if strings.TrimSpace(u.Hostname()) == "" {
		return "", errors.New("服务提供商基础地址缺少主机名")
	}
	if u.User != nil {
		return "", errors.New("服务提供商基础地址不能包含账号密码")
	}
	return strings.TrimRight(u.String(), "/") + "/" + op, nil
}

func providerClient() *http.Client {
	return &http.Client{
		Timeout: providerTimeout,
		Transport: &http.Transport{
			Proxy:                 aitransport.SystemProxy(),
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 5 * time.Minute,
			IdleConnTimeout:       60 * time.Second,
		},
	}
}

func providerSetHeaders(req *http.Request, cfg Config) {
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.APIKey))
	req.Header.Set("User-Agent", webUserAgent)
	req.Header.Set("Accept", "application/json")
}

func providerPostJSON(cfg Config, op string, payload interface{}, out interface{}) error {
	endpoint, err := providerEndpoint(cfg, op)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("请求创建失败：%w", err)
	}
	providerSetHeaders(req, cfg)
	req.Header.Set("Content-Type", "application/json")
	resp, err := providerClient().Do(req)
	if err != nil {
		return fmt.Errorf("%s请求失败：%w", providerCapabilityLabels[op], err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, providerMaxResponse))
	if err != nil {
		return fmt.Errorf("读取响应失败：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return providerHTTPError(resp.StatusCode, body)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("响应解析失败：%w", err)
	}
	return nil
}

func providerMultipartPost(cfg Config, op, fileField, filename string, fileData []byte, fields map[string]string, out interface{}) error {
	endpoint, err := providerEndpoint(cfg, op)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return err
		}
	}
	part, err := writer.CreateFormFile(fileField, filename)
	if err != nil {
		return err
	}
	if _, err := part.Write(fileData); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, &buf)
	if err != nil {
		return fmt.Errorf("请求创建失败：%w", err)
	}
	providerSetHeaders(req, cfg)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := providerClient().Do(req)
	if err != nil {
		return fmt.Errorf("%s请求失败：%w", providerCapabilityLabels[op], err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, providerMaxResponse))
	if err != nil {
		return fmt.Errorf("读取响应失败：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return providerHTTPError(resp.StatusCode, body)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("响应解析失败：%w", err)
	}
	return nil
}

func providerHTTPError(status int, body []byte) error {
	message := ""
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &payload) == nil {
		if payload.Error.Message != "" {
			message = payload.Error.Message
		} else if payload.Message != "" {
			message = payload.Message
		}
	}
	if message == "" {
		message = strings.TrimSpace(string(body))
	}
	message = strings.Join(strings.Fields(message), " ")
	message = webTruncateRunesOnly(message, providerErrorSnippet)
	if message == "" {
		message = http.StatusText(status)
	}
	return fmt.Errorf("服务提供商返回 HTTP %d：%s", status, message)
}

// ===== 校验与工具 =====
func providerValidateFetchURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("URL 为空")
	}
	if len(raw) > 8192 {
		return "", errors.New("URL 过长")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("URL 无效：%w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("只支持 http/https 地址")
	}
	if u.User != nil {
		return "", errors.New("URL 不能包含账号密码")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return "", errors.New("URL 缺少主机名")
	}
	if ip := net.ParseIP(host); ip != nil {
		if !webIsPublicIP(ip) {
			return "", errors.New("只允许访问公网地址")
		}
	} else if webBlockedHost(host) {
		return "", errors.New("只允许访问公网地址")
	}
	return u.String(), nil
}

func providerRandHex(n int) string {
	if n <= 0 {
		n = 3
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	}
	return hex.EncodeToString(buf)
}
