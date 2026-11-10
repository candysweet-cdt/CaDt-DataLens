package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// AI 面板的 Go 侧只做两件事：双协议 HTTP + SSE 流式转发（事件归一化），
// 以及记忆/技能目录解析。Agent 编排、审批、diff 全在前端。
const (
	aiIdleTimeout         = 120 * time.Second
	aiDialTimeout         = 10 * time.Second
	aiErrorBodyLimit      = 64 << 10
	aiErrorTextLimit      = 500
	aiDefaultMaxTokens    = 4096
	aiMaxExtraHeaders     = 8
	aiMaxToolDefs         = 64
	aiMaxModels           = 500
	aiMaxImagesPerMessage = 6
	aiMaxImageBase64      = 8 << 20
)

const (
	aiEventChunk    = "ai-chunk"
	aiEventThink    = "ai-think"
	aiEventToolCall = "ai-toolcall"
	aiEventDone     = "ai-done"
	aiEventError    = "ai-error"
)

var (
	errAIIdleTimeout = errors.New("AI 响应超时（120 秒无数据）")
	errAnthropicDone = errors.New("anthropic stream done")
	aiToolNameRule   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// AIConfig 由前端 Profile 组装；API Key 只存在于前端 localStorage 与请求头，
// 不写入日志、不落盘。
type AIConfig struct {
	Provider       string            `json:"provider"`
	BaseURL        string            `json:"baseURL"`
	APIKey         string            `json:"apiKey"`
	Model          string            `json:"model"`
	Temperature    float64           `json:"temperature"`
	MaxTokens      int               `json:"maxTokens"`
	Proxy          string            `json:"proxy,omitempty"`
	ExtraHeaders   map[string]string `json:"extraHeaders,omitempty"`
	Thinking       bool              `json:"thinking,omitempty"`
	ThinkingBudget int               `json:"thinkingBudget,omitempty"`
	// ReasoningEffort 仅用于 OpenAI 兼容协议，按 reasoning_effort 原样发送。
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// AIMessage 是前端与 Go 之间的会话消息（规范化中间格式）。
// assistant 的 ToolCalls 为工具调用请求，role=tool 的消息用 ToolCallId 回填结果。
type AIMessage struct {
	Role              string        `json:"role"`
	Content           string        `json:"content,omitempty"`
	Images            []AIImagePart `json:"images,omitempty"`
	ToolCalls         []AIToolCall  `json:"toolCalls,omitempty"`
	ToolCallId        string        `json:"toolCallId,omitempty"`
	Name              string        `json:"name,omitempty"`
	Thinking          string        `json:"thinking,omitempty"`
	ThinkingSignature string        `json:"thinkingSignature,omitempty"`
}

type AIImagePart struct {
	Mime string `json:"mime"`
	Data string `json:"data"`
}

type AIToolCall struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type AIToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type aiChunkPayload struct {
	Id    string `json:"id"`
	Delta string `json:"delta"`
}

type aiToolCallPayload struct {
	Id        string `json:"id"`
	Index     int    `json:"index"`
	CallId    string `json:"callId,omitempty"`
	Name      string `json:"name,omitempty"`
	ArgsDelta string `json:"argsDelta,omitempty"`
}

type aiUsage struct {
	PromptTokens     int `json:"promptTokens,omitempty"`
	CompletionTokens int `json:"completionTokens,omitempty"`
	TotalTokens      int `json:"totalTokens,omitempty"`
	CachedTokens     int `json:"cachedTokens,omitempty"`
}

type aiDonePayload struct {
	Id                string   `json:"id"`
	FinishReason      string   `json:"finishReason"`
	ThinkingSignature string   `json:"thinkingSignature,omitempty"`
	Usage             *aiUsage `json:"usage,omitempty"`
}

type aiErrorPayload struct {
	Id      string `json:"id"`
	Message string `json:"message"`
}

type aiEmitter func(event string, payload any)

type aiStreamEntry struct {
	cancel context.CancelCauseFunc
}

var aiStreams = struct {
	sync.Mutex
	entries map[string]*aiStreamEntry
}{entries: make(map[string]*aiStreamEntry)}

type aiProviderKind int

const (
	aiProviderOpenAI aiProviderKind = iota
	aiProviderAnthropic
)

// AISendChat 启动一轮流式对话。立即返回后由 goroutine 通过 ai-* 事件推送：
// ai-chunk / ai-think / ai-toolcall / ai-done / ai-error。同一 sessionId 的新请求
// 会先取消旧请求；AIStop 按 sessionId 前缀取消（前端传 session.id#round）。
func (a *App) AISendChat(sessionId string, cfg AIConfig, messages []AIMessage, tools []AIToolDef) error {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return errors.New("会话标识为空")
	}
	if err := validateAIConfig(cfg); err != nil {
		return err
	}
	if err := validateAIMessages(messages); err != nil {
		return err
	}
	if err := validateAITools(tools); err != nil {
		return err
	}

	ctx, cancel := context.WithCancelCause(context.Background())
	entry := &aiStreamEntry{cancel: cancel}

	aiStreams.Lock()
	if old := aiStreams.entries[sessionId]; old != nil {
		old.cancel(context.Canceled)
	}
	aiStreams.entries[sessionId] = entry
	aiStreams.Unlock()

	go func() {
		defer func() {
			aiStreams.Lock()
			if aiStreams.entries[sessionId] == entry {
				delete(aiStreams.entries, sessionId)
			}
			aiStreams.Unlock()
			cancel(context.Canceled)
		}()

		started := time.Now()
		writeAppLog("info", "AI 请求：provider=%s host=%s model=%s messages=%d tools=%d",
			aiProviderName(cfg), aiBaseHost(cfg.BaseURL), cfg.Model, len(messages), len(tools))
		err := aiStreamResponse(ctx, cancel, sessionId, cfg, messages, tools, a.aiEmit)
		cause := context.Cause(ctx)

		switch {
		case errors.Is(cause, errAIIdleTimeout):
			a.aiEmit(aiEventError, aiErrorPayload{Id: sessionId, Message: errAIIdleTimeout.Error()})
			writeAppLog("error", "AI 流中断：%v", errAIIdleTimeout)
		case errors.Is(cause, context.Canceled):
			a.aiEmit(aiEventDone, aiDonePayload{Id: sessionId, FinishReason: "stopped"})
			writeAppLog("info", "AI 请求已停止（%s）", time.Since(started).Round(time.Millisecond))
		case err != nil:
			a.aiEmit(aiEventError, aiErrorPayload{Id: sessionId, Message: err.Error()})
			writeAppLog("error", "AI 请求失败（%s）：%v", time.Since(started).Round(time.Millisecond), err)
		default:
			writeAppLog("info", "AI 请求结束（%s）", time.Since(started).Round(time.Millisecond))
		}
	}()
	return nil
}

// AIStop 取消匹配 sessionId 的正在进行的请求（前缀匹配支持 session.id#round）。
func (a *App) AIStop(sessionId string) {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return
	}
	var cancels []context.CancelCauseFunc
	aiStreams.Lock()
	for id, entry := range aiStreams.entries {
		if id == sessionId || strings.HasPrefix(id, sessionId+"#") {
			cancels = append(cancels, entry.cancel)
		}
	}
	aiStreams.Unlock()
	for _, cancel := range cancels {
		cancel(context.Canceled)
	}
}

// AITestConnection 验证当前 Profile 的地址/密钥/模型是否可用。
func (a *App) AITestConnection(cfg AIConfig) (string, error) {
	if err := validateAIEndpoint(cfg); err != nil {
		return "", err
	}
	if aiProviderOf(cfg) == aiProviderAnthropic && strings.TrimSpace(cfg.Model) == "" {
		return "", errors.New("请先配置模型名")
	}
	client, err := newAIHTTPClient(cfg)
	if err != nil {
		return "", err
	}
	defer client.CloseIdleConnections()

	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if aiProviderOf(cfg) == aiProviderAnthropic {
		body, err := json.Marshal(map[string]any{
			"model":      cfg.Model,
			"max_tokens": 1,
			"messages":   []map[string]any{{"role": "user", "content": "ping"}},
		})
		if err != nil {
			return "", err
		}
		req, err := http.NewRequest(http.MethodPost, aiAnthropicMessagesURL(base), bytes.NewReader(body))
		if err != nil {
			return "", err
		}
		if err := aiApplyHeaders(req, cfg, aiProviderAnthropic, false); err != nil {
			return "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("连接失败：%w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", errors.New(aiStatusErrorText(resp))
		}
		return fmt.Sprintf("连接成功（Anthropic，HTTP %d）", resp.StatusCode), nil
	}

	models, err := listAIModels(client, cfg)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("连接成功，可用模型 %d 个", len(models)), nil
}

// AIListModels 拉取 OpenAI 兼容端点的模型列表（Anthropic 需手动填写模型名）。
func (a *App) AIListModels(cfg AIConfig) ([]string, error) {
	if err := validateAIEndpoint(cfg); err != nil {
		return nil, err
	}
	if aiProviderOf(cfg) == aiProviderAnthropic {
		return nil, errors.New("Anthropic 不提供模型列表接口，请手动填写模型名")
	}
	client, err := newAIHTTPClient(cfg)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	return listAIModels(client, cfg)
}

// AIAppDir 返回应用数据根目录（记忆 app 模式、技能 app 级目录都挂在其下）。
func (a *App) AIAppDir() string {
	return appDataRoot()
}

// AIExePath 返回当前可执行文件绝对路径（内置技能 {{EXE_PATH}} 占位用；失败返回空串）。
func (a *App) AIExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Clean(exe)
}

// AIEnsureDir 创建记忆/技能目录（MkdirAll，已存在不报错）。
func (a *App) AIEnsureDir(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return errors.New("目录路径为空")
	}
	info, err := os.Stat(dir)
	if err == nil && info.IsDir() {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建目录失败：%w", err)
	}
	return nil
}

func (a *App) aiEmit(event string, payload any) {
	if a == nil || a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, event, payload)
}

func aiProviderOf(cfg AIConfig) aiProviderKind {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "anthropic", "claude":
		return aiProviderAnthropic
	default:
		return aiProviderOpenAI
	}
}

func aiProviderName(cfg AIConfig) string {
	if aiProviderOf(cfg) == aiProviderAnthropic {
		return "anthropic"
	}
	return "openai"
}

func validateAIEndpoint(cfg AIConfig) error {
	base := strings.TrimSpace(cfg.BaseURL)
	if base == "" {
		return errors.New("请先配置 Base URL")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("Base URL 无效：%s", base)
	}
	if scheme := strings.ToLower(u.Scheme); scheme != "http" && scheme != "https" {
		return fmt.Errorf("Base URL 仅支持 http/https：%s", base)
	}
	if cfg.MaxTokens < 0 {
		return errors.New("maxTokens 不能为负数")
	}
	if len(cfg.ExtraHeaders) > aiMaxExtraHeaders {
		return fmt.Errorf("自定义请求头最多 %d 条", aiMaxExtraHeaders)
	}
	for name, value := range cfg.ExtraHeaders {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("自定义请求头包含换行：%s", name)
		}
		if aiForbiddenHeader(name) {
			return fmt.Errorf("不允许自定义请求头：%s", name)
		}
	}
	return nil
}

func validateAIConfig(cfg AIConfig) error {
	if err := validateAIEndpoint(cfg); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return errors.New("请先配置模型名")
	}
	if aiProviderOf(cfg) == aiProviderAnthropic && cfg.Thinking {
		budget := cfg.ThinkingBudget
		if budget < 1024 {
			budget = 1024
		}
		maxTokens := cfg.MaxTokens
		if maxTokens <= 0 {
			maxTokens = aiDefaultMaxTokens
		}
		if maxTokens <= budget {
			return fmt.Errorf("maxTokens（%d）必须大于 Thinking 预算（%d）", maxTokens, budget)
		}
	}
	return nil
}

func validateAIMessages(messages []AIMessage) error {
	if len(messages) == 0 {
		return errors.New("消息为空")
	}
	if len(messages) > 1000 {
		return errors.New("消息数量超过上限")
	}
	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system", "user", "assistant":
		case "tool":
			if strings.TrimSpace(m.ToolCallId) == "" {
				return fmt.Errorf("第 %d 条工具消息缺少 toolCallId", i+1)
			}
		default:
			return fmt.Errorf("第 %d 条消息角色无效：%s", i+1, m.Role)
		}
		if len(m.Images) > 0 {
			if role != "user" {
				return fmt.Errorf("第 %d 条消息只有用户消息可以携带图片", i+1)
			}
			if len(m.Images) > aiMaxImagesPerMessage {
				return fmt.Errorf("第 %d 条消息图片超过上限（%d 张）", i+1, aiMaxImagesPerMessage)
			}
			for j, img := range m.Images {
				mime := strings.ToLower(strings.TrimSpace(img.Mime))
				switch mime {
				case "image/png", "image/jpeg", "image/webp", "image/gif":
				default:
					return fmt.Errorf("第 %d 条消息第 %d 张图片格式不支持：%s", i+1, j+1, img.Mime)
				}
				data := strings.TrimSpace(img.Data)
				if data == "" {
					return fmt.Errorf("第 %d 条消息第 %d 张图片数据为空", i+1, j+1)
				}
				if len(data) > aiMaxImageBase64 {
					return fmt.Errorf("第 %d 条消息第 %d 张图片超过大小上限", i+1, j+1)
				}
				if _, err := base64.StdEncoding.DecodeString(data); err != nil {
					return fmt.Errorf("第 %d 条消息第 %d 张图片不是合法 base64", i+1, j+1)
				}
			}
		}
		if len(m.ToolCalls) > aiMaxToolDefs {
			return fmt.Errorf("第 %d 条消息的工具调用过多", i+1)
		}
		for j, call := range m.ToolCalls {
			if strings.TrimSpace(call.Id) == "" || strings.TrimSpace(call.Name) == "" {
				return fmt.Errorf("第 %d 条消息第 %d 个工具调用缺少 id/name", i+1, j+1)
			}
			if strings.TrimSpace(call.Arguments) != "" && !json.Valid([]byte(call.Arguments)) {
				return fmt.Errorf("第 %d 条消息第 %d 个工具调用参数不是合法 JSON", i+1, j+1)
			}
		}
	}
	return nil
}

func validateAITools(tools []AIToolDef) error {
	if len(tools) > aiMaxToolDefs {
		return fmt.Errorf("工具数量超过上限（%d）", aiMaxToolDefs)
	}
	seen := map[string]bool{}
	for i, tool := range tools {
		name := strings.TrimSpace(tool.Name)
		if !aiToolNameRule.MatchString(name) {
			return fmt.Errorf("第 %d 个工具名称无效：%s", i+1, tool.Name)
		}
		if seen[name] {
			return fmt.Errorf("工具名称重复：%s", name)
		}
		seen[name] = true
		if _, err := aiToolSchema(tool); err != nil {
			return err
		}
	}
	return nil
}

func aiToolSchema(tool AIToolDef) (json.RawMessage, error) {
	raw := bytes.TrimSpace(tool.Parameters)
	if len(raw) == 0 {
		return json.RawMessage(`{"type":"object","properties":{}}`), nil
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("工具 %s 的 parameters 不是合法 JSON", tool.Name)
	}
	if raw[0] != '{' {
		return nil, fmt.Errorf("工具 %s 的 parameters 必须是 JSON 对象", tool.Name)
	}
	return json.RawMessage(raw), nil
}

// aiStreamResponse 执行一次流式请求，事件经 emit 归一化输出。
// 空闲 120 秒会取消 ctx，调用方通过 context.Cause 区分超时与用户停止。
func aiStreamResponse(ctx context.Context, cancel context.CancelCauseFunc, id string, cfg AIConfig, messages []AIMessage, tools []AIToolDef, emit aiEmitter) error {
	watchdog := time.AfterFunc(aiIdleTimeout, func() { cancel(errAIIdleTimeout) })
	defer watchdog.Stop()
	touch := func() { watchdog.Reset(aiIdleTimeout) }

	req, err := aiBuildChatRequest(ctx, cfg, messages, tools)
	if err != nil {
		return err
	}
	client, err := newAIHTTPClient(cfg)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("请求 AI 接口失败：%w", err)
	}
	defer resp.Body.Close()
	touch()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New(aiStatusErrorText(resp))
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if contentType != "" && !strings.Contains(contentType, "text/event-stream") && !strings.Contains(contentType, "text/plain") {
		return fmt.Errorf("网关未返回 SSE 流（Content-Type: %s）", resp.Header.Get("Content-Type"))
	}

	if aiProviderOf(cfg) == aiProviderAnthropic {
		return streamAnthropicSSE(resp.Body, id, emit, touch)
	}
	return streamOpenAISSE(resp.Body, id, emit, touch)
}

func aiBuildChatRequest(ctx context.Context, cfg AIConfig, messages []AIMessage, tools []AIToolDef) (*http.Request, error) {
	provider := aiProviderOf(cfg)
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")

	var (
		endpoint string
		body     []byte
		err      error
	)
	if provider == aiProviderAnthropic {
		endpoint = aiAnthropicMessagesURL(base)
		var payload map[string]any
		payload, err = aiBuildAnthropicBody(cfg, messages, tools)
		if err == nil {
			body, err = json.Marshal(payload)
		}
	} else {
		endpoint = aiOpenAIChatURL(base)
		var payload map[string]any
		payload, err = aiBuildOpenAIBody(cfg, messages, tools)
		if err == nil {
			body, err = json.Marshal(payload)
		}
	}
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("请求地址无效：%w", err)
	}
	if err := aiApplyHeaders(req, cfg, provider, true); err != nil {
		return nil, err
	}
	return req, nil
}

func aiOpenAIChatURL(base string) string {
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	return base + "/chat/completions"
}

func aiAnthropicMessagesURL(base string) string {
	if strings.HasSuffix(base, "/messages") {
		return base
	}
	if strings.HasSuffix(base, "/v1") {
		return base + "/messages"
	}
	return base + "/v1/messages"
}

func aiOpenAIModelsURL(base string) string {
	if strings.HasSuffix(base, "/models") {
		return base
	}
	return base + "/models"
}

func aiApplyHeaders(req *http.Request, cfg AIConfig, provider aiProviderKind, stream bool) error {
	req.Header.Set("Content-Type", "application/json")
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(appVersion, "v")+" AI")
	if provider == aiProviderAnthropic {
		if key := strings.TrimSpace(cfg.APIKey); key != "" {
			req.Header.Set("x-api-key", key)
		}
		req.Header.Set("anthropic-version", "2023-06-01")
	} else if key := strings.TrimSpace(cfg.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	for name, value := range cfg.ExtraHeaders {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if aiForbiddenHeader(name) {
			return fmt.Errorf("不允许自定义请求头：%s", name)
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("自定义请求头包含换行：%s", name)
		}
		req.Header.Set(name, value)
	}
	return nil
}

func aiForbiddenHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "host", "content-length", "transfer-encoding", "connection",
		"proxy-connection", "upgrade", "te", "trailer":
		return true
	}
	return false
}

func aiBuildOpenAIBody(cfg AIConfig, messages []AIMessage, tools []AIToolDef) (map[string]any, error) {
	converted, err := aiOpenAIMessages(messages)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"model":       cfg.Model,
		"messages":    converted,
		"stream":      true,
		"temperature": cfg.Temperature,
	}
	if cfg.MaxTokens > 0 {
		body["max_tokens"] = cfg.MaxTokens
	}
	if effort := strings.TrimSpace(cfg.ReasoningEffort); effort != "" {
		body["reasoning_effort"] = effort
	}
	if len(tools) > 0 {
		body["tools"] = aiOpenAITools(tools)
	}
	return body, nil
}

func aiBuildAnthropicBody(cfg AIConfig, messages []AIMessage, tools []AIToolDef) (map[string]any, error) {
	system, converted, err := aiAnthropicMessages(messages, cfg.Thinking)
	if err != nil {
		return nil, err
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = aiDefaultMaxTokens
	}
	body := map[string]any{
		"model":      cfg.Model,
		"max_tokens": maxTokens,
		"messages":   converted,
		"stream":     true,
	}
	if system != "" {
		body["system"] = system
	}
	if len(tools) > 0 {
		body["tools"] = aiAnthropicTools(tools)
	}
	if cfg.Thinking {
		// 扩展思考开启时 Anthropic 拒绝 temperature != 1，直接省略（默认 1）。
		budget := cfg.ThinkingBudget
		if budget < 1024 {
			budget = 1024
		}
		body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
	} else {
		body["temperature"] = cfg.Temperature
	}
	return body, nil
}

func aiOpenAIMessages(messages []AIMessage) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(messages))
	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system", "user":
			if role == "user" && len(m.Images) > 0 {
				parts := make([]any, 0, len(m.Images)+1)
				if strings.TrimSpace(m.Content) != "" {
					parts = append(parts, map[string]any{"type": "text", "text": m.Content})
				}
				for _, img := range m.Images {
					mime := strings.ToLower(strings.TrimSpace(img.Mime))
					parts = append(parts, map[string]any{
						"type": "image_url",
						"image_url": map[string]any{
							"url": "data:" + mime + ";base64," + img.Data,
						},
					})
				}
				out = append(out, map[string]any{"role": "user", "content": parts})
				break
			}
			out = append(out, map[string]any{"role": role, "content": m.Content})
		case "assistant":
			content := any(m.Content)
			if len(m.ToolCalls) > 0 && strings.TrimSpace(m.Content) == "" {
				content = nil
			}
			obj := map[string]any{"role": "assistant", "content": content}
			if len(m.ToolCalls) > 0 {
				calls := make([]map[string]any, 0, len(m.ToolCalls))
				for _, call := range m.ToolCalls {
					args := strings.TrimSpace(call.Arguments)
					if args == "" {
						args = "{}"
					}
					calls = append(calls, map[string]any{
						"id":   call.Id,
						"type": "function",
						"function": map[string]any{
							"name":      call.Name,
							"arguments": args,
						},
					})
				}
				obj["tool_calls"] = calls
			}
			out = append(out, obj)
		case "tool":
			out = append(out, map[string]any{
				"role":         "tool",
				"tool_call_id": m.ToolCallId,
				"content":      m.Content,
			})
		default:
			return nil, fmt.Errorf("第 %d 条消息角色无效：%s", i+1, m.Role)
		}
	}
	return out, nil
}

func aiAnthropicMessages(messages []AIMessage, includeThinking bool) (string, []map[string]any, error) {
	var systemParts []string
	out := make([]map[string]any, 0, len(messages))

	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system":
			if strings.TrimSpace(m.Content) != "" {
				systemParts = append(systemParts, m.Content)
			}
		case "user":
			if strings.TrimSpace(m.Content) == "" && len(m.Images) == 0 {
				continue
			}
			blocks := make([]any, 0, len(m.Images)+1)
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
			}
			for _, img := range m.Images {
				mime := strings.ToLower(strings.TrimSpace(img.Mime))
				blocks = append(blocks, map[string]any{
					"type": "image",
					"source": map[string]any{
						"type":       "base64",
						"media_type": mime,
						"data":       img.Data,
					},
				})
			}
			aiAppendAnthropicTurn(&out, "user", blocks)
		case "assistant":
			blocks := make([]any, 0, 3+len(m.ToolCalls))
			if includeThinking && strings.TrimSpace(m.Thinking) != "" && strings.TrimSpace(m.ThinkingSignature) != "" {
				blocks = append(blocks, map[string]any{
					"type":      "thinking",
					"thinking":  m.Thinking,
					"signature": m.ThinkingSignature,
				})
			}
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
			}
			for _, call := range m.ToolCalls {
				args := strings.TrimSpace(call.Arguments)
				if args == "" {
					args = "{}"
				}
				var input any
				if err := json.Unmarshal([]byte(args), &input); err != nil {
					return "", nil, fmt.Errorf("第 %d 条消息的工具调用参数不是合法 JSON：%w", i+1, err)
				}
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    call.Id,
					"name":  call.Name,
					"input": input,
				})
			}
			aiAppendAnthropicTurn(&out, "assistant", blocks)
		case "tool":
			if strings.TrimSpace(m.ToolCallId) == "" {
				return "", nil, fmt.Errorf("第 %d 条工具消息缺少 toolCallId", i+1)
			}
			aiAppendAnthropicTurn(&out, "user", []any{map[string]any{
				"type":        "tool_result",
				"tool_use_id": m.ToolCallId,
				"content":     m.Content,
			}})
		default:
			return "", nil, fmt.Errorf("第 %d 条消息角色无效：%s", i+1, m.Role)
		}
	}

	if len(out) == 0 {
		return "", nil, errors.New("消息为空")
	}
	return strings.Join(systemParts, "\n\n"), out, nil
}

// aiAppendAnthropicTurn 合并相邻同角色轮次，保证 user/assistant 交替。
func aiAppendAnthropicTurn(out *[]map[string]any, role string, blocks []any) {
	if len(blocks) == 0 {
		return
	}
	if len(*out) > 0 {
		last := (*out)[len(*out)-1]
		if lastRole, _ := last["role"].(string); lastRole == role {
			existing, _ := last["content"].([]any)
			last["content"] = append(existing, blocks...)
			return
		}
	}
	*out = append(*out, map[string]any{"role": role, "content": blocks})
}

func aiOpenAITools(tools []AIToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema, err := aiToolSchema(tool)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}

func aiAnthropicTools(tools []AIToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema, err := aiToolSchema(tool)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"name":         tool.Name,
			"description":  tool.Description,
			"input_schema": schema,
		})
	}
	return out
}

func streamOpenAISSE(body io.Reader, id string, emit aiEmitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	finishReason := "stop"
	doneSent := false
	var usage aiUsage
	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		payload := aiDonePayload{Id: id, FinishReason: finishReason}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 {
			payload.Usage = &usage
		}
		emit(aiEventDone, payload)
	}

	for scanner.Scan() {
		touch()
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			emitDone()
			return nil
		}
		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("解析流式响应失败：%w", err)
		}
		if chunk.Error != nil && strings.TrimSpace(chunk.Error.Message) != "" {
			return errors.New(strings.TrimSpace(chunk.Error.Message))
		}
		if chunk.Usage != nil {
			usage.PromptTokens = chunk.Usage.PromptTokens
			usage.CompletionTokens = chunk.Usage.CompletionTokens
			usage.TotalTokens = chunk.Usage.TotalTokens
			if usage.TotalTokens <= 0 {
				usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
			}
			usage.CachedTokens = chunk.Usage.PromptCacheHitTokens
			if details := chunk.Usage.PromptTokensDetails; details != nil && details.CachedTokens > usage.CachedTokens {
				usage.CachedTokens = details.CachedTokens
			}
		}
		for _, choice := range chunk.Choices {
			delta := choice.Delta
			// DeepSeek/Qwen/GLM 系用 reasoning_content，OpenRouter 归一为 reasoning。
			// 注意：推理流的分块边界常带空格/换行，不能 TrimSpace，否则英文思考链会粘连。
			if text := delta.ReasoningContent; text != "" {
				emit(aiEventThink, aiChunkPayload{Id: id, Delta: text})
			}
			if text := delta.Reasoning; text != "" {
				emit(aiEventThink, aiChunkPayload{Id: id, Delta: text})
			}
			for _, call := range delta.ToolCalls {
				emit(aiEventToolCall, aiToolCallPayload{
					Id:        id,
					Index:     call.Index,
					CallId:    call.Id,
					Name:      call.Function.Name,
					ArgsDelta: call.argumentsText(),
				})
			}
			if delta.Content != "" {
				emit(aiEventChunk, aiChunkPayload{Id: id, Delta: delta.Content})
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finishReason = aiFinishReason(*choice.FinishReason)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	emitDone()
	return nil
}

func streamAnthropicSSE(body io.Reader, id string, emit aiEmitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	eventName := ""
	var dataLines []string
	finishReason := "stop"
	doneSent := false
	var usage aiUsage
	signature := strings.Builder{}

	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		payload := aiDonePayload{
			Id:                id,
			FinishReason:      finishReason,
			ThinkingSignature: signature.String(),
		}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 {
			payload.Usage = &usage
		}
		emit(aiEventDone, payload)
	}

	dispatch := func(event, data string) error {
		if strings.TrimSpace(data) == "" {
			return nil
		}
		var envelope anthropicStreamChunk
		if err := json.Unmarshal([]byte(data), &envelope); err != nil {
			return fmt.Errorf("解析 Anthropic 流失败：%w", err)
		}
		if event == "" {
			event = envelope.Type
		}
		switch event {
		case "message_start":
			if envelope.Message != nil {
				u := envelope.Message.Usage
				usage.PromptTokens = u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
				usage.CachedTokens = u.CacheReadInputTokens
			}
		case "content_block_start":
			if block := envelope.ContentBlock; block != nil {
				switch block.Type {
				case "text":
					if block.Text != "" {
						emit(aiEventChunk, aiChunkPayload{Id: id, Delta: block.Text})
					}
				case "thinking":
					if block.Thinking != "" {
						emit(aiEventThink, aiChunkPayload{Id: id, Delta: block.Thinking})
					}
					if block.Signature != "" {
						signature.WriteString(block.Signature)
					}
				case "tool_use":
					emit(aiEventToolCall, aiToolCallPayload{
						Id:     id,
						Index:  envelope.Index,
						CallId: block.Id,
						Name:   block.Name,
					})
				}
			}
		case "content_block_delta":
			if delta := envelope.Delta; delta != nil {
				if delta.Text != "" {
					emit(aiEventChunk, aiChunkPayload{Id: id, Delta: delta.Text})
				}
				if delta.Thinking != "" {
					emit(aiEventThink, aiChunkPayload{Id: id, Delta: delta.Thinking})
				}
				if delta.Signature != "" {
					signature.WriteString(delta.Signature)
				}
				if delta.PartialJson != "" {
					emit(aiEventToolCall, aiToolCallPayload{
						Id:        id,
						Index:     envelope.Index,
						ArgsDelta: delta.PartialJson,
					})
				}
			}
		case "message_delta":
			if delta := envelope.Delta; delta != nil && delta.StopReason != "" {
				finishReason = aiFinishReason(delta.StopReason)
			}
			if envelope.Usage != nil {
				if envelope.Usage.OutputTokens > 0 {
					usage.CompletionTokens = envelope.Usage.OutputTokens
				}
				if usage.PromptTokens == 0 {
					u := envelope.Usage
					usage.PromptTokens = u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
					usage.CachedTokens = u.CacheReadInputTokens
				}
				usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
			}
		case "message_stop":
			emitDone()
			return errAnthropicDone
		case "error":
			if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
				return errors.New(strings.TrimSpace(envelope.Error.Message))
			}
			return errors.New("Anthropic 返回未知错误")
		}
		return nil
	}

	flush := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			return nil
		}
		if err := dispatch(eventName, strings.Join(dataLines, "\n")); err != nil {
			return err
		}
		eventName = ""
		dataLines = dataLines[:0]
		return nil
	}

	for scanner.Scan() {
		touch()
		line := scanner.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				if errors.Is(err, errAnthropicDone) {
					return nil
				}
				return err
			}
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if err := flush(); err != nil {
		if errors.Is(err, errAnthropicDone) {
			return nil
		}
		return err
	}
	emitDone()
	return nil
}

func aiFinishReason(reason string) string {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "tool_calls", "tool_use", "function_call":
		return "tool"
	default:
		return "stop"
	}
}

func aiStatusErrorText(resp *http.Response) string {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, aiErrorBodyLimit))
	text := strings.TrimSpace(string(body))
	var envelope struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if text != "" && json.Unmarshal([]byte(text), &envelope) == nil && strings.TrimSpace(envelope.Error.Message) != "" {
		text = strings.TrimSpace(envelope.Error.Message)
	}
	if text == "" {
		text = http.StatusText(resp.StatusCode)
	}
	runes := []rune(text)
	if len(runes) > aiErrorTextLimit {
		text = string(runes[:aiErrorTextLimit]) + "…"
	}
	return fmt.Sprintf("AI 接口返回 HTTP %d：%s", resp.StatusCode, text)
}

func aiBaseHost(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	return u.Host
}

func newAIHTTPClient(cfg AIConfig) (*http.Client, error) {
	proxy, err := aiProxyFunc(cfg.Proxy)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: aiDialTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 proxy,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   aiDialTimeout,
		ExpectContinueTimeout: time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	return &http.Client{Transport: transport}, nil
}

func aiProxyFunc(mode string) (func(*http.Request) (*url.URL, error), error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "system":
		return systemAIProxy(), nil
	case "direct", "none", "off":
		return nil, nil
	default:
		u, err := url.Parse(mode)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("代理地址无效：%s", mode)
		}
		switch strings.ToLower(u.Scheme) {
		case "http", "https", "socks5":
		default:
			return nil, fmt.Errorf("代理仅支持 http/https/socks5：%s", mode)
		}
		return http.ProxyURL(u), nil
	}
}

// aiSystemProxyResolver 把 Windows Internet Settings 的 ProxyServer/ProxyOverride
// 转成 Transport 的 Proxy 回调。ProxyServer 支持 "host:port" 与
// "http=host:port;https=host:port;socks=host:port" 两种形式。
func aiSystemProxyResolver(server, override string) func(*http.Request) (*url.URL, error) {
	server = strings.TrimSpace(server)
	if server == "" {
		return nil
	}
	return func(req *http.Request) (*url.URL, error) {
		host := req.URL.Hostname()
		if aiProxyBypassed(host, override) {
			return nil, nil
		}
		raw := aiProxyServerForScheme(server, req.URL.Scheme)
		if raw == "" {
			return nil, nil
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return nil, nil
		}
		return u, nil
	}
}

func aiProxyServerForScheme(server, scheme string) string {
	server = strings.TrimSpace(server)
	if server == "" {
		return ""
	}
	scheme = strings.ToLower(scheme)
	if !strings.Contains(server, "=") {
		return aiProxyURLWithScheme(server, "http")
	}

	entries := map[string]string{}
	for _, part := range strings.Split(server, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			if len(entries) == 0 {
				entries["http"] = part
			}
			continue
		}
		entries[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
	}
	// ProxyServer 的 key 是「用于哪种请求」，代理本身默认走 HTTP 协议；
	// 只有 socks 项才用 socks5://。
	if value := entries[scheme]; value != "" {
		return aiProxyURLWithScheme(value, "http")
	}
	if value := entries["http"]; value != "" {
		return aiProxyURLWithScheme(value, "http")
	}
	if value := entries["socks"]; value != "" {
		return aiProxyURLWithScheme(value, "socks5")
	}
	if value := entries["socks5"]; value != "" {
		return aiProxyURLWithScheme(value, "socks5")
	}
	for _, value := range entries {
		return aiProxyURLWithScheme(value, "http")
	}
	return ""
}

func aiProxyURLWithScheme(server, scheme string) string {
	server = strings.TrimSpace(server)
	if server == "" {
		return ""
	}
	if strings.Contains(server, "://") {
		return server
	}
	return scheme + "://" + server
}

func aiProxyBypassed(host, override string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" || strings.TrimSpace(override) == "" {
		return false
	}
	for _, raw := range strings.FieldsFunc(override, func(r rune) bool { return r == ';' || r == ',' }) {
		pattern := strings.ToLower(strings.TrimSpace(raw))
		if pattern == "" {
			continue
		}
		if pattern == "*" {
			return true
		}
		if pattern == "<local>" {
			if host == "localhost" || host == "127.0.0.1" || host == "::1" || !strings.Contains(host, ".") {
				return true
			}
			continue
		}
		if matched, err := path.Match(pattern, host); err == nil && matched {
			return true
		}
		if host == pattern || strings.HasSuffix(host, "."+pattern) {
			return true
		}
	}
	return false
}

func listAIModels(client *http.Client, cfg AIConfig) ([]string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	req, err := http.NewRequest(http.MethodGet, aiOpenAIModelsURL(base), nil)
	if err != nil {
		return nil, err
	}
	if err := aiApplyHeaders(req, cfg, aiProviderOpenAI, false); err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("获取模型列表失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New(aiStatusErrorText(resp))
	}
	var payload struct {
		Data []struct {
			Id string `json:"id"`
		} `json:"data"`
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("解析模型列表失败：%w", err)
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if id := strings.TrimSpace(item.Id); id != "" {
			models = append(models, id)
		}
		if len(models) >= aiMaxModels {
			break
		}
	}
	if len(models) == 0 {
		return nil, errors.New("接口未返回模型列表")
	}
	sort.Strings(models)
	return models, nil
}

// openAIStreamChunk 的 arguments/reasoning 用 RawMessage 兼容个别网关
// 把对象/字符串混发的情况。
type openAIStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content          string                `json:"content"`
			ReasoningContent string                `json:"reasoning_content"`
			Reasoning        string                `json:"reasoning"`
			ToolCalls        []openAIToolCallDelta `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens         int `json:"prompt_tokens"`
		CompletionTokens     int `json:"completion_tokens"`
		TotalTokens          int `json:"total_tokens"`
		PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
		PromptTokensDetails  *struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type openAIToolCallDelta struct {
	Index    int    `json:"index"`
	Id       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

// argumentsText 取字符串形式的参数增量；个别网关直接发对象，原样返回 JSON 文本。
func (call openAIToolCallDelta) argumentsText() string {
	if len(call.Function.Arguments) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(call.Function.Arguments, &text); err == nil {
		return text
	}
	return string(call.Function.Arguments)
}

type anthropicStreamChunk struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
	ContentBlock *struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		Thinking  string `json:"thinking"`
		Signature string `json:"signature"`
		Id        string `json:"id"`
		Name      string `json:"name"`
	} `json:"content_block"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		Signature   string `json:"signature"`
		PartialJson string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage *struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}
