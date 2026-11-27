package aitransport

// AI 流式解析与传输：OpenAI/Anthropic SSE 解码、状态错误文本、HTTP 客户端与代理。

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

func streamOpenAISSE(body io.Reader, id string, emit Emitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	finishReason := "stop"
	finishSeen := false
	doneSent := false
	var usage aiUsage
	var timings *aiChatTimings
	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		aiMergeTimings(&usage, timings)
		payload := DonePayload{Id: id, FinishReason: finishReason}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 || usage.CacheWriteTokens > 0 {
			payload.Usage = &usage
		}
		emit(EventDone, payload)
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
			// 只发 [DONE] 不给 finish_reason 的网关不少（免费/中转通道尤甚）：内容是否
			// 完整无从判断，标 unknown 留痕（前端据此对「话说到一半」的结尾提示可继续），
			// 但不当传输故障重试——[DONE] 就是上游明确的收尾信号。
			if !finishSeen {
				finishReason = "unknown"
			}
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
		if chunk.Timings != nil {
			timings = chunk.Timings
		}
		for _, choice := range chunk.Choices {
			delta := choice.Delta
			// DeepSeek/Qwen/GLM 系用 reasoning_content，OpenRouter 归一为 reasoning。
			// 注意：推理流的分块边界常带空格/换行，不能 TrimSpace，否则英文思考链会粘连。
			if text := delta.ReasoningContent; text != "" {
				emit(EventThink, ChunkPayload{Id: id, Delta: text})
			}
			if text := delta.Reasoning; text != "" {
				emit(EventThink, ChunkPayload{Id: id, Delta: text})
			}
			for _, call := range delta.ToolCalls {
				emit(EventToolCall, ToolCallPayload{
					Id:        id,
					Index:     call.Index,
					CallId:    call.Id,
					Name:      call.Function.Name,
					ArgsDelta: call.argumentsText(),
				})
			}
			if delta.Content != "" {
				emit(EventChunk, ChunkPayload{Id: id, Delta: delta.Content})
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finishReason = aiFinishReason(*choice.FinishReason)
				finishSeen = true
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	// 静默截断守卫：流被干净地关闭但既没收到 [DONE] 也没收到 finish_reason——
	// 生成中途被掐断却不报错，半截内容会被当成完整结果落盘，比报错更危险。
	if !finishSeen {
		return fmt.Errorf("%w：流结束但没有终止标记（无 finish_reason / [DONE]），生成可能不完整。可直接重试", ErrStreamTruncated)
	}
	emitDone()
	return nil
}

// responsesStreamEvent：只解析 Responses SSE 里会映射到 ai-* 事件的字段。
// 网关普遍会在 data JSON 里带 type；event: 行即使存在也不影响，这里逐行只读 data:。
type responsesStreamEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
	Item  *struct {
		Type      string `json:"type"`
		CallId    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	Response *struct {
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
		Usage *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
			TotalTokens  int `json:"total_tokens"`
			InputDetails *struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
		} `json:"usage"`
	} `json:"response"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func responsesEventError(ev responsesStreamEvent) string {
	if ev.Error != nil && strings.TrimSpace(ev.Error.Message) != "" {
		return strings.TrimSpace(ev.Error.Message)
	}
	if ev.Response != nil && ev.Response.Error != nil && strings.TrimSpace(ev.Response.Error.Message) != "" {
		return strings.TrimSpace(ev.Response.Error.Message)
	}
	return ""
}

// streamResponsesSSE 把 Responses 事件流归一成现有的 ai-chunk / ai-think /
// ai-toolcall / ai-done。工具调用取 output_item.done 里的完整 function_call
// （arguments 已完整，无需拼接 function_call_arguments.delta）。
func streamResponsesSSE(body io.Reader, id string, emit Emitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	finishReason := "stop"
	doneSent := false
	var usage aiUsage
	toolIndex := 0
	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		payload := DonePayload{Id: id, FinishReason: finishReason}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 {
			payload.Usage = &usage
		}
		emit(EventDone, payload)
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
		var ev responsesStreamEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return fmt.Errorf("解析 Responses 流式响应失败：%w", err)
		}
		if message := responsesEventError(ev); message != "" {
			return errors.New(message)
		}
		switch ev.Type {
		case "response.output_text.delta", "response.refusal.delta":
			if ev.Delta != "" {
				emit(EventChunk, ChunkPayload{Id: id, Delta: ev.Delta})
			}
		case "response.reasoning_text.delta":
			if ev.Delta != "" {
				emit(EventThink, ChunkPayload{Id: id, Delta: ev.Delta})
			}
		case "response.output_item.done":
			item := ev.Item
			if item == nil || item.Type != "function_call" {
				continue
			}
			callId := item.CallId
			if callId == "" {
				callId = fmt.Sprintf("responses-call-%d", toolIndex)
			}
			emit(EventToolCall, ToolCallPayload{
				Id: id, Index: toolIndex, CallId: callId, Name: item.Name, ArgsDelta: item.Arguments,
			})
			toolIndex++
		case "response.completed", "response.incomplete":
			if ev.Response != nil && ev.Response.Usage != nil {
				u := ev.Response.Usage
				usage.PromptTokens = u.InputTokens
				usage.CompletionTokens = u.OutputTokens
				usage.TotalTokens = u.TotalTokens
				if usage.TotalTokens <= 0 {
					usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
				}
				if u.InputDetails != nil {
					usage.CachedTokens = u.InputDetails.CachedTokens
				}
			}
			if ev.Type == "response.incomplete" {
				finishReason = "length"
			}
			emitDone()
			return nil
		case "error", "response.failed":
			return errors.New("Responses 流式响应失败（" + ev.Type + "）")
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	// 静默截断守卫：Responses 正常结束必有 response.completed / response.incomplete。
	if !doneSent {
		return fmt.Errorf("%w：流结束但没有终止事件（response.completed），生成可能不完整。可直接重试", ErrStreamTruncated)
	}
	emitDone()
	return nil
}

func streamAnthropicSSE(body io.Reader, id string, emit Emitter, touch func()) error {
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
		payload := DonePayload{
			Id:                id,
			FinishReason:      finishReason,
			ThinkingSignature: signature.String(),
		}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 || usage.CacheWriteTokens > 0 {
			payload.Usage = &usage
		}
		emit(EventDone, payload)
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
				usage.CacheWriteTokens = u.CacheCreationInputTokens
			}
		case "content_block_start":
			if block := envelope.ContentBlock; block != nil {
				switch block.Type {
				case "text":
					if block.Text != "" {
						emit(EventChunk, ChunkPayload{Id: id, Delta: block.Text})
					}
				case "thinking":
					if block.Thinking != "" {
						emit(EventThink, ChunkPayload{Id: id, Delta: block.Thinking})
					}
					if block.Signature != "" {
						signature.WriteString(block.Signature)
					}
				case "tool_use":
					emit(EventToolCall, ToolCallPayload{
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
					emit(EventChunk, ChunkPayload{Id: id, Delta: delta.Text})
				}
				if delta.Thinking != "" {
					emit(EventThink, ChunkPayload{Id: id, Delta: delta.Thinking})
				}
				if delta.Signature != "" {
					signature.WriteString(delta.Signature)
				}
				if delta.PartialJson != "" {
					emit(EventToolCall, ToolCallPayload{
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
					usage.CacheWriteTokens = u.CacheCreationInputTokens
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
	// 静默截断守卫：Anthropic 正常结束必有 message_stop；流提前关闭时半截内容
	// 不能当完整结果落盘（thinking signature 也必然不完整，重发才有意义）。
	if !doneSent {
		return fmt.Errorf("%w：流结束但没有终止事件（message_stop），生成可能不完整。可直接重试", ErrStreamTruncated)
	}
	emitDone()
	return nil
}

// aiFinishReason：把三家协议的结束原因归一成前端认识的三档：
// tool（有工具调用）/ length（输出预算打满，内容被砍断）/ stop（其余）。
// length 必须原样保留——归一成 stop 会让「被截断」与「模型写完了」在界面上无法区分，
// 用户只看到话说到一半（2026-11-21 定位：hy4-flash-free 停在 SVG 围栏前）。
func aiFinishReason(reason string) string {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "tool_calls", "tool_use", "function_call":
		return "tool"
	case "length", "max_tokens", "max_output_tokens", "model_context_window_exceeded":
		return "length"
	default:
		return "stop"
	}
}

// aiStreamUpstreamRe 识别「流内 error 事件文案是网关/上游故障」的特征：
// error code: 5xx、[502]、HTTP 502 / status: 5xx、502 Bad Gateway 这类。
// 只认带状态码数字或 5xx 习惯用语的形态，避免把「额度不足」「内容过滤」这类
// 模型业务错误误判成可重试的传输故障。
var aiStreamUpstreamRe = regexp.MustCompile(
	`(?i)(?:error[ _-]?code|http|status)\s*:?\s*5\d{2}` +
		`|\[\s*5\d{2}\s*\]` +
		`|\b5\d{2}\s+(?:bad gateway|internal server error|service unavailable|gateway time-?out)`)

// aiStreamErrorText 把「流中途被断开」翻成用户能看懂的文案。网关/代理在长生成中
// 掐断 SSE 时，Go 只返回 io.ErrUnexpectedEOF（chunked 流缺终止块），原文冒到界面
// 既看不出是网络问题，也给不出下一步。解析失败、业务错误体等已有明确文本的照原样返回。
//
// 另一条路径：流已正常开启但网关在流中途发了 error 事件（如 502），HTTP 状态码
// 层面的重试循环够不着——这里按文案特征包装成 ErrStreamUpstreamError，让前端
// 整轮自动重发，而不是把「Streaming response failed: [502]」摆给用户手动点继续。
func aiStreamErrorText(err error) error {
	if err == nil {
		return nil
	}
	lower := strings.ToLower(err.Error())
	if errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(lower, "unexpected eof") {
		return fmt.Errorf("%w：通常是网关或代理在长生成中超时、掐断了连接，本轮已生成的内容可能不完整。可直接重试；大段改动建议拆成多次小改动", ErrStreamTruncated)
	}
	// 断流的第三种形态：连接被掐在一条 JSON 数据块中间，bufio 把最后的不完整行当
	// 整块交上来，json.Unmarshal 报「unexpected end of JSON input」。这不是网关发
	// 了坏数据（真坏数据报的是 invalid character 之类），同样可整轮重发。
	if strings.Contains(lower, "unexpected end of json input") {
		return fmt.Errorf("%w：流在数据块中间被网关掐断（最后一条不完整），本轮已生成的内容可能不完整。可直接重试", ErrStreamTruncated)
	}
	// 同一条缝的另外几种断法：流中途连接被重置 / 管道断裂（网关崩溃、LB 掐长连接
	// 常见）。优先按 errno 判定——Windows 的 WSAECONNRESET 文案是「An existing
	// connection was forcibly closed by the remote host」，里面根本没有
	// "connection reset" 字样，纯文案匹配会漏；errno 链断了（如中途被转成字符串）
	// 再兜一层文案匹配。
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		strings.Contains(lower, "connection reset") || strings.Contains(lower, "broken pipe") ||
		strings.Contains(lower, "forcibly closed by the remote host") {
		return fmt.Errorf("%w：连接被网关或代理中途重置，本轮已生成的内容可能不完整。可直接重试", ErrStreamTruncated)
	}
	if aiStreamUpstreamRe.MatchString(err.Error()) {
		return fmt.Errorf("%w：%s", ErrStreamUpstreamError, err.Error())
	}
	return err
}

func StatusErrorText(resp *http.Response) string {
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

func BaseHost(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	return u.Host
}

func NewHTTPClient(cfg Config) (*http.Client, error) {
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
		return SystemProxy(), nil
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

// aiModelsTimeout 模型列表/连通性测试的单次上限：端点无响应时必须能回错误。
const aiModelsTimeout = 20 * time.Second

func ListModels(client *http.Client, cfg Config) ([]string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	// 必须带 ctx + 超时：client 本身没有 Timeout，端点挂起时绑定调用会永久卡死
	//（前端界面一直停在「测试中…」）。
	ctx, cancel := context.WithTimeout(context.Background(), aiModelsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, aiOpenAIModelsURL(base), nil)
	if err != nil {
		return nil, err
	}
	if err := ApplyHeaders(req, cfg, ProviderOpenAI, false); err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("获取模型列表失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New(StatusErrorText(resp))
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

// aiChatTimings 是 llama.cpp 系服务（llama-server / LM Studio / 兼容实现）在流末块附带的
// 引擎自报计时：cache_n = 从提示缓存复用的 token，prompt_n = 本次真正预填充的 token，
// predicted_n = 生成的 token。老版本即便收下 stream_options 也可能只在 timings 里给数字，
// 所以拿它当 usage 的兜底来源，别让本地模型的速度统计永远是「—」。
type aiChatTimings struct {
	CacheN     int `json:"cache_n"`
	PromptN    int `json:"prompt_n"`
	PredictedN int `json:"predicted_n"`
}

// aiMergeTimings 用 timings 补齐 usage 里缺的字段（已有值不覆盖），最后补 total。
func aiMergeTimings(usage *aiUsage, timings *aiChatTimings) {
	if usage == nil || timings == nil {
		return
	}
	if usage.CachedTokens <= 0 && timings.CacheN > 0 {
		usage.CachedTokens = timings.CacheN
	}
	if usage.PromptTokens <= 0 && (timings.PromptN > 0 || timings.CacheN > 0) {
		usage.PromptTokens = timings.PromptN + timings.CacheN
	}
	if usage.CompletionTokens <= 0 && timings.PredictedN > 0 {
		usage.CompletionTokens = timings.PredictedN
	}
	if usage.TotalTokens <= 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
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
	Timings *aiChatTimings `json:"timings"`
	Error   *struct {
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
