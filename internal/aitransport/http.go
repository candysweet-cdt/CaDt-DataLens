package aitransport

// AI 请求构建：双协议（OpenAI 兼容 / Anthropic）的 URL、请求头、请求体与重试策略。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ===== 流式响应处理 =====
func StreamResponse(ctx context.Context, cancel context.CancelCauseFunc, id string, cfg Config, messages []Message, tools []ToolDef, emit Emitter, retryMax int) error {
	idleTimeout := resolveIdleTimeout(cfg.IdleTimeoutSec)
	timeoutErr := &idleTimeoutError{seconds: int(idleTimeout / time.Second)}
	watchdog := time.AfterFunc(idleTimeout, func() { cancel(timeoutErr) })
	defer watchdog.Stop()
	touch := func() { watchdog.Reset(idleTimeout) }
	// 登记到流条目：工具执行/用户输入等长时间无网络数据时，前端经 AITouchStream 重置看门狗。
	if AttachWatchdog != nil {
		AttachWatchdog(id, watchdog, idleTimeout)
	}

	// 参数型 400（如 max_tokens 超过模型上限）是确定性故障：按服务端给的上界
	// 收敛后重试一次，不受 retryMax（只管 429/5xx/网络错误）影响，也绝不循环降档。
	maxTokensAdjusted := false
	// stream_options 兼容性降级：只允许降一次，之后即便再失败也如实报错。
	streamUsageDropped := false
	// 关思考参数的兼容性降级：方言因网关而异，被 400 拒收时也只摘一次。
	thinkingParamDropped := false
	// 提示词缓存断点的兼容性降级：个别 Anthropic 兼容网关不认 cache_control，同样只摘一次。
	cacheControlDropped := false
	for attempt := 0; ; attempt++ {
		req, err := aiBuildChatRequest(ctx, cfg, messages, tools)
		if err != nil {
			return err
		}
		client, err := NewHTTPClient(cfg)
		if err != nil {
			return err
		}

		// 本地限流：RPM 超阈值、或正处在 429 回灌的冻结期，就在客户端排队。
		// 每次重试都重新取名额（重试本身也是一次请求）。排队中持续喂看门狗并上报
		// ai-queue 事件，详见 ratelimit.go。
		if err := acquireSlot(ctx, cfg, id, emit, touch); err != nil {
			client.CloseIdleConnections()
			return fmt.Errorf("请求 AI 接口失败：%w", err)
		}

		resp, err := client.Do(req)
		if err != nil {
			client.CloseIdleConnections()
			if ctx.Err() != nil {
				// 用户停止 / 空闲超时 / 新请求顶替：交给调用方按 ctx cause 处理
				return fmt.Errorf("请求 AI 接口失败：%w", err)
			}
			max := aiRetryAttempts(retryMax, 0)
			if attempt >= max {
				return fmt.Errorf("请求 AI 接口失败：%w", err)
			}
			delay := aiRetryDelay(attempt, "", 0)
			emit(EventRetry, RetryPayload{Id: id, Attempt: attempt + 1, Max: max, DelayMs: int(delay.Milliseconds()), Reason: "网络错误"})
			logf("warn", "AI 请求失败，%s 后第 %d/%d 次重试：%v", delay.Round(time.Millisecond), attempt+1, max, err)
			if !aiRetryWait(ctx, delay, touch) {
				return fmt.Errorf("请求 AI 接口失败：%w", err)
			}
			continue
		}
		touch()

		if aiRetryableStatus(resp.StatusCode) {
			reason := fmt.Sprintf("HTTP %d", resp.StatusCode)
			body, _ := io.ReadAll(io.LimitReader(resp.Body, aiErrorBodyLimit))
			_ = resp.Body.Close()
			client.CloseIdleConnections()
			max := aiRetryAttempts(retryMax, resp.StatusCode)
			if attempt >= max {
				return errors.New(aiStatusErrorBodyText(resp.StatusCode, body))
			}
			delay := aiRetryDelay(attempt, resp.Header.Get("Retry-After"), resp.StatusCode)
			// 429 是配额类限流：把服务端要求的等待时间回灌给限流器，冻结期内同 key 的
			// 其他请求（子代理、分类器、别的会话）一起排队，避免「一个请求在退避、
			// 另外二十个还在往前撞」。5xx 不是配额问题，不冻结（退避时长是本端猜的
			// 指数退避，回灌出去会让同 key 的无关请求跟着空等）。
			if resp.StatusCode == http.StatusTooManyRequests {
				aiRateLimiter.freezeUntil(rateKey(cfg), time.Now().Add(delay))
			}
			emit(EventRetry, RetryPayload{Id: id, Attempt: attempt + 1, Max: max, DelayMs: int(delay.Milliseconds()), Reason: reason})
			logf("warn", "AI 接口返回 %d，%s 后第 %d/%d 次重试", resp.StatusCode, delay.Round(time.Millisecond), attempt+1, max)
			if !aiRetryWait(ctx, delay, touch) {
				return errors.New(aiStatusErrorBodyText(resp.StatusCode, body))
			}
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			// 非 2xx：读错误体（含网关校验详情），并落一份**最小定位结构**到日志目录。
			// 以前这里转储的是完整请求体（会话正文 + 图片 base64），401/403 也照落：
			// 密钥填错时每点一次就写一份完整会话进日志，且从来没有清理。
			// 现在只记定位所需的事实（provider/model/host/状态/规模/错误片段）。
			errBody, _ := io.ReadAll(io.LimitReader(resp.Body, aiErrorBodyLimit))
			_ = resp.Body.Close()
			client.CloseIdleConnections()
			aiDumpRequestDiagnostics(cfg, messages, tools, resp.StatusCode, errBody)
			// 参数型 400/422：服务端把允许范围写回错误体时，按上界收敛 max_tokens 再试一次。
			// 只在「实际发送值确实超过上界」时降档，鉴权/内容类 4xx 与其它字段不会误命中；
			// 一次请求最多降一次，降完仍失败就把原始错误如实抛给前端。
			if !maxTokensAdjusted && (resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity) {
				if limit := aiMaxTokensLimitFromError(errBody); limit > 0 {
					previous := cfg.MaxTokens
					if previous <= 0 && ProviderOf(cfg) == ProviderAnthropic {
						previous = aiDefaultMaxTokens // Anthropic 请求体总会补上默认输出窗口
					}
					if previous > limit {
						cfg.MaxTokens = limit
						maxTokensAdjusted = true
						message := fmt.Sprintf("模型 %s 的最大输出 %d 超过服务端上限 %d，已自动降为 %d 并重试",
							cfg.Model, previous, limit, limit)
						emit(EventParamAdjust, ParamAdjustPayload{
							Id: id, Model: cfg.Model, Field: "maxTokens",
							Previous: previous, Value: limit, Message: message,
						})
						logf("warn", "AI 参数自动降档：%s", message)
						touch()
						continue
					}
				}
			}
			// 网关把 stream_options 当未知参数拒收：摘掉这个字段重发，宁可不带流式 usage
			// 也要让对话能跑通（老 shim / 自研网关常见）。
			if !streamUsageDropped && aiRejectsStreamOptions(resp.StatusCode, errBody) {
				cfg.noStreamUsage = true
				streamUsageDropped = true
				logf("warn", "网关不接受 stream_options（流式 usage），已去掉该字段重试：%s",
					aiStatusErrorBodyText(resp.StatusCode, errBody))
				touch()
				continue
			}
			// 网关不接受按模型名猜出来的关思考参数（同一模型在不同网关方言不同）：
			// 摘掉该字段重发一次。只对确实发过参数的 OpenAI 兼容请求尝试；Anthropic 不猜测。
			if !thinkingParamDropped && !cfg.Thinking && ProviderOf(cfg) == ProviderOpenAI {
				if key, _ := aiThinkingDisableParam(cfg.Model); key != "" && aiRejectsThinkingParam(resp.StatusCode, errBody) {
					cfg.noThinkingParam = true
					thinkingParamDropped = true
					logf("warn", "网关不接受关思考参数 %s，已去掉该字段重试：%s", key,
						aiStatusErrorBodyText(resp.StatusCode, errBody))
					touch()
					continue
				}
			}
			// 网关不认识 Anthropic 的 cache_control（标准字段，实现未必跟上）：摘掉缓存断点
			// 重发一次。少省一点钱，总好过整轮跑不通。attempt-- 抵消 for 的自增：
			// 兼容性降级不该消耗 429/5xx 的重试预算（否则几个降级连发就把重试吃光）。
			if !cacheControlDropped && ProviderOf(cfg) == ProviderAnthropic && aiRejectsCacheControl(resp.StatusCode, errBody) {
				cfg.noPromptCache = true
				cacheControlDropped = true
				attempt--
				logf("warn", "网关不接受 cache_control（提示词缓存断点），已去掉该字段重试：%s",
					aiStatusErrorBodyText(resp.StatusCode, errBody))
				touch()
				continue
			}
			return errors.New(aiStatusErrorBodyText(resp.StatusCode, errBody))
		}
		contentType := strings.ToLower(resp.Header.Get("Content-Type"))
		if contentType != "" && !strings.Contains(contentType, "text/event-stream") && !strings.Contains(contentType, "text/plain") {
			defer resp.Body.Close()
			defer client.CloseIdleConnections()
			return fmt.Errorf("网关未返回 SSE 流（Content-Type: %s）", resp.Header.Get("Content-Type"))
		}
		defer resp.Body.Close()
		defer client.CloseIdleConnections()

		// 高频 think/content 经 30ms 微批合并；done/error 先 flush 再发出，toolcall 立即透传。
		batcher := newAIChunkBatcher(id, emit)
		defer batcher.flushNow()
		wrapped := func(event string, payload any) {
			switch event {
			case EventThink, EventChunk:
				if p, ok := payload.(ChunkPayload); ok {
					batcher.add(event, p.Delta)
					return
				}
				emit(event, payload)
			case EventDone, EventError:
				batcher.flushNow()
				if event == EventDone {
					// 请求日志要显示状态码：成功流的响应码只有这一层拿得到，补进 done 载荷。
					if p, ok := payload.(DonePayload); ok {
						p.StatusCode = resp.StatusCode
						payload = p
					}
				}
				emit(event, payload)
			default:
				emit(event, payload)
			}
		}
		var streamErr error
		switch ProviderOf(cfg) {
		case ProviderAnthropic:
			streamErr = streamAnthropicSSE(resp.Body, id, wrapped, touch)
		case ProviderResponses:
			streamErr = streamResponsesSSE(resp.Body, id, wrapped, touch)
		default:
			streamErr = streamOpenAISSE(resp.Body, id, wrapped, touch)
		}
		return aiStreamErrorText(streamErr)
	}
}

// ===== 重试与错误判定 =====
// aiRetryableStatus：429（限流）与 5xx（服务端故障）值得重试；4xx 参数/鉴权错误重试无意义。
func aiRetryableStatus(code int) bool {
	return code == http.StatusTooManyRequests || code >= 500
}

// aiRateLimitBonusAttempts：429 是配额类限流（tpm/rpm 这类分钟窗），窗口重置需要时间，
// 在用户设置的 retryMax 之外额外多试几次，避免「退避 30s 仍在耗尽的窗口里」撞墙。
const aiRateLimitBonusAttempts = 3

// aiRetryAttempts：第 code 类错误的有效重试次数。429 且用户未关闭重试（retryMax>0）时
// 加上配额类额外预算；其余按用户设置原样。
func aiRetryAttempts(retryMax, code int) int {
	if code == http.StatusTooManyRequests && retryMax > 0 {
		return retryMax + aiRateLimitBonusAttempts
	}
	return retryMax
}

// aiRetryAfterMax 是 Retry-After 的等待上限。此前原样尊重服务端值，故障/恶意网关
// 回一个 Retry-After: 7200 就能让单请求与同 key 全部并发请求挂起两小时
// （429 还会把它灌进限流器冻结期）。超限一律按指数退避处理。
const aiRetryAfterMax = 120 * time.Second

// aiRetryDelay 计算第 attempt 次重试（从 0 计）前的等待：优先 Retry-After（秒数或
// HTTP-date，超过 aiRetryAfterMax 时回落指数退避）；否则指数退避——
// 429（分钟窗配额）2s→4s→8s…上限 60s，5xx/网络错误 1s→2s→4s…上限 30s，
// 均附 ±15% 抖动避免同时重试踩踏。
func aiRetryDelay(attempt int, retryAfter string, code int) time.Duration {
	if v := strings.TrimSpace(retryAfter); v != "" {
		if seconds, err := strconv.ParseFloat(v, 64); err == nil && seconds >= 0 {
			if d := time.Duration(seconds * float64(time.Second)); d <= aiRetryAfterMax {
				return d
			}
		} else if t, err := http.ParseTime(v); err == nil {
			if d := max(time.Until(t), 0); d <= aiRetryAfterMax {
				return d
			}
		}
	}
	var base time.Duration
	if code == http.StatusTooManyRequests {
		base = 2 * time.Second << min(attempt, 5) // 2s 4s 8s 16s 32s 64s → 上限 60s
		if base > 60*time.Second {
			base = 60 * time.Second
		}
	} else {
		base = time.Second << min(attempt, 5) // 1s 2s 4s 8s 16s 32s → 上限 30s
		if base > 30*time.Second {
			base = 30 * time.Second
		}
	}
	jitter := time.Duration(float64(base) * (0.85 + 0.3*rand.Float64()))
	return jitter
}

// aiRetryTouchEvery：重试长等待期间给看门狗喂食的间隔（等待超过空闲超时的
// Retry-After 也不会被误杀）。
var aiRetryTouchEvery = 30 * time.Second

// aiRetryWait 等待重试间隔，每 30s touch 一次看门狗；被取消（用户停止/新请求）返回 false。
func aiRetryWait(ctx context.Context, delay time.Duration, touch func()) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	remaining := delay
	for remaining > 0 {
		step := remaining
		if step > aiRetryTouchEvery {
			step = aiRetryTouchEvery
		}
		timer := time.NewTimer(step)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
			timer.Stop()
		}
		remaining -= step
		if touch != nil {
			touch()
		}
	}
	return true
}

// aiStatusErrorBodyText 用已读取的状态码与响应体拼错误文案（响应体已关闭时使用）。
func aiStatusErrorBodyText(statusCode int, body []byte) string {
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
		text = http.StatusText(statusCode)
	}
	runes := []rune(text)
	if len(runes) > aiErrorTextLimit {
		text = string(runes[:aiErrorTextLimit]) + "…"
	}
	return fmt.Sprintf("AI 接口返回 HTTP %d：%s", statusCode, text)
}

// aiMaxTokensRangeRule 从网关的参数校验错误里取 max_tokens 允许的上界，覆盖：
//
//	field MaxTokens invalid, should be in [1, 131072]      （SenseNova）
//	max_tokens should be in [1, 65536]
//	max_completion_tokens must be in [1, 8192]
//
// 必须同时出现 max token 字段名与 [下限, 上限]，避免把 temperature 之类的
// 范围报错误判成输出窗口问题。JSON 错误体里的引号不影响匹配。
var aiMaxTokensRangeRule = regexp.MustCompile(`(?i)max(?:[ _-]|_completion_)?tokens?[^\[\n]{0,120}\[\s*(\d+)\s*,\s*(\d+)\s*\]`)

// aiMaxTokensLimitFromError 返回服务端允许的最大输出 token 数；无法解析返回 0。
func aiMaxTokensLimitFromError(body []byte) int {
	match := aiMaxTokensRangeRule.FindSubmatch(body)
	if len(match) != 3 {
		return 0
	}
	low, errLow := strconv.Atoi(string(match[1]))
	high, errHigh := strconv.Atoi(string(match[2]))
	if errLow != nil || errHigh != nil || low < 0 || high <= 0 || low > high {
		return 0
	}
	return high
}

// ===== URL 与请求构造 =====
func aiBuildChatRequest(ctx context.Context, cfg Config, messages []Message, tools []ToolDef) (*http.Request, error) {
	provider := ProviderOf(cfg)
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")

	var (
		endpoint string
		payload  map[string]any
		err      error
	)
	switch provider {
	case ProviderAnthropic:
		endpoint = AnthropicMessagesURL(base)
		payload, err = aiBuildAnthropicBody(cfg, messages, tools)
	case ProviderResponses:
		endpoint = aiResponsesURL(base)
		payload, err = aiBuildResponsesBody(cfg, messages, tools)
	default:
		endpoint = aiOpenAIChatURL(base)
		payload, err = aiBuildOpenAIBody(cfg, messages, tools)
	}
	if err != nil {
		return nil, err
	}
	// 插件 provider 的每轮请求体补丁统一在这里合并；stream 恒为 true，SSE 解码依赖流式响应。
	aiApplyBodyPatch(payload, cfg.ExtraBody)
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("请求地址无效：%w", err)
	}
	if err := ApplyHeaders(req, cfg, provider, true); err != nil {
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

func AnthropicMessagesURL(base string) string {
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

// aiResponsesURL：Responses API 用 /responses，不是 /chat/completions。
// 兼容把 base 直接写成 chat 端点的配置。
func aiResponsesURL(base string) string {
	if strings.HasSuffix(base, "/responses") {
		return base
	}
	if strings.HasSuffix(base, "/chat/completions") {
		return strings.TrimSuffix(base, "/chat/completions") + "/responses"
	}
	return base + "/responses"
}

// ===== 请求头处理 =====
func ApplyHeaders(req *http.Request, cfg Config, provider ProviderKind, stream bool) error {
	req.Header.Set("Content-Type", "application/json")
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(Version, "v")+" AI")
	if provider == ProviderAnthropic {
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
		if ForbiddenHeader(name) {
			return fmt.Errorf("不允许自定义请求头：%s", name)
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("自定义请求头包含换行：%s", name)
		}
		req.Header.Set(name, value)
	}
	return nil
}

func ForbiddenHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "host", "content-length", "transfer-encoding", "connection",
		"proxy-connection", "upgrade", "te", "trailer":
		return true
	}
	return false
}

// ===== Body 补丁与能力协商 =====
// aiApplyBodyPatch 合并插件 provider 的请求体补丁。前端 applyPluginAIPatch 已按白名单与
// 体积上限收过一遍，这里只做最后兜底：拒绝超量补丁，并强制 stream=true——
// 关掉流式会让 SSE 解码拿不到事件，整轮对话挂住。
func aiApplyBodyPatch(body, patch map[string]any) {
	if len(body) == 0 || len(patch) == 0 || len(patch) > aiMaxExtraBodyKeys {
		return
	}
	for key, value := range patch {
		if strings.EqualFold(key, "stream") {
			continue
		}
		body[key] = value
	}
	body["stream"] = true
}

// aiRejectsStreamOptions：4xx 错误体点名 stream_options / include_usage，说明网关把
// 「索取流式 usage」当成非法参数。只认 400/422 且文本命中，别的原因不降级。
func aiRejectsStreamOptions(code int, body []byte) bool {
	if code != http.StatusBadRequest && code != http.StatusUnprocessableEntity {
		return false
	}
	text := strings.ToLower(aiStatusErrorBodyText(code, body))
	return strings.Contains(text, "stream_options") || strings.Contains(text, "include_usage")
}

// aiThinkingDisableParam 按模型名返回「关闭思考」的请求参数。关闭思考的字段名不是
// OpenAI 规范的一部分，各家网关各认一套：智谱 GLM 用 thinking.type、阿里 Qwen 用
// enable_thinking。同一模型在不同网关方言也可能不同（实测 sensenova 网关的 glm-5.3
// 只认 enable_thinking，收到 thinking.type 直接 400），猜错时由 aiRejectsThinkingParam
// 识别并摘掉参数重试；关不掉的思考模型靠调用方留足 max_tokens，不会饿死正文。
func aiThinkingDisableParam(model string) (string, any) {
	lower := strings.ToLower(model)
	switch {
	case strings.Contains(lower, "glm"):
		return "thinking", map[string]any{"type": "disabled"}
	case strings.Contains(lower, "qwen"), strings.Contains(lower, "qwq"):
		return "enable_thinking", false
	}
	return "", nil
}

// aiRejectsThinkingParam：4xx 错误体点名 thinking，说明网关不接受按模型名猜出来的
// 关思考参数。命中后由调用方置位 cfg.noThinkingParam 重发一次：思考回到服务端默认值
// （走 reasoning 通道，不占正文），比整个请求 400 可用。
func aiRejectsThinkingParam(code int, body []byte) bool {
	if code != http.StatusBadRequest && code != http.StatusUnprocessableEntity {
		return false
	}
	return strings.Contains(strings.ToLower(aiStatusErrorBodyText(code, body)), "thinking")
}

// anthropicCacheControl 返回一个缓存断点标记。只支持 ephemeral（默认 5 分钟）：
// 命中时按 0.1x 计费、写入按 1.25x，所以断点打在**大而稳定**的前缀上才划算。
func anthropicCacheControl() map[string]any {
	return map[string]any{"type": "ephemeral"}
}

// markAnthropicTailCacheControl 给最后一条消息的最后一个可用 block 打断点：
// 「本轮之前的所有内容」成为可缓存前缀，下一轮直接命中，不必每轮重算全部历史。
// thinking / redacted_thinking 块不接受 cache_control，遇到就往前找。
func markAnthropicTailCacheControl(messages []map[string]any) {
	for i := len(messages) - 1; i >= 0; i-- {
		blocks, ok := messages[i]["content"].([]any)
		if !ok || len(blocks) == 0 {
			continue
		}
		for j := len(blocks) - 1; j >= 0; j-- {
			block, ok := blocks[j].(map[string]any)
			if !ok {
				continue
			}
			if t, _ := block["type"].(string); t == "thinking" || t == "redacted_thinking" {
				continue
			}
			block["cache_control"] = anthropicCacheControl()
			return
		}
	}
}

// aiRejectsCacheControl 判定网关是否因 cache_control 400：标准字段，但个别兼容实现
// 还没跟上，会把未知字段当参数错误拒收。命中后摘掉断点重发（不缓存只是贵一点）。
func aiRejectsCacheControl(code int, body []byte) bool {
	if code != http.StatusBadRequest && code != http.StatusUnprocessableEntity {
		return false
	}
	text := strings.ToLower(aiStatusErrorBodyText(code, body))
	return strings.Contains(text, "cache_control") || strings.Contains(text, "cache control")
}

// ===== 请求诊断 =====
// aiDumpRequestDiagnostics 落一份最小定位结构：只记「哪个模型、发多大、服务端
// 怎么回的」，绝不包含会话正文与图片 base64。同时做环形清理（只保留最近几份），
// 避免每次失败都新建文件、无限增长。
func aiDumpRequestDiagnostics(cfg Config, messages []Message, tools []ToolDef, status int, errBody []byte) {
	// 只在载荷校验类失败时落盘：鉴权失败（401/403）与限流错误没有载荷线索，
	// 却最容易带出完整会话，直接跳过。
	if status != http.StatusBadRequest && status != http.StatusUnprocessableEntity {
		return
	}
	contentBytes := 0
	imageParts := 0
	for _, m := range messages {
		contentBytes += len(m.Content)
		imageParts += len(m.Images) + len(m.Videos)
	}
	dump := map[string]any{
		"at":           time.Now().Format(time.RFC3339),
		"provider":     ProviderName(cfg),
		"model":        cfg.Model,
		"host":         BaseHost(cfg.BaseURL),
		"status":       status,
		"messages":     len(messages),
		"tools":        len(tools),
		"contentBytes": contentBytes,
		"imageParts":   imageParts,
		"errorSnippet": aiStatusErrorBodyText(status, errBody),
	}
	raw, err := json.MarshalIndent(dump, "", "  ")
	if err != nil {
		return
	}
	dir := logsDir()
	dumpPath := filepath.Join(dir, fmt.Sprintf("ai-last-4xx-request-%d.json", time.Now().UnixMilli()))
	if err := os.WriteFile(dumpPath, raw, 0o600); err != nil {
		return
	}
	logf("info", "AI 4xx 诊断已记录：%s（messages=%d tools=%d）", dumpPath, len(messages), len(tools))
	aiPruneDiagnostics(dir, 5)
}

// aiPruneDiagnostics 只保留最近 keep 份 4xx 诊断：这些文件以前没人清理。
func aiPruneDiagnostics(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var paths []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "ai-last-4xx-request-") {
			paths = append(paths, filepath.Join(dir, e.Name()))
		}
	}
	if len(paths) <= keep {
		return
	}
	sort.Strings(paths) // 文件名带毫秒时间戳，字典序即时间序
	for _, p := range paths[:len(paths)-keep] {
		_ = os.Remove(p)
	}
}

// ===== 各供应商 Body 构造 =====
func aiBuildOpenAIBody(cfg Config, messages []Message, tools []ToolDef) (map[string]any, error) {
	passReasoning := strings.Contains(strings.ToLower(cfg.Model), "deepseek")
	converted, err := aiOpenAIMessages(messages, passReasoning)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"model":       cfg.Model,
		"messages":    converted,
		"stream":      true,
		"temperature": cfg.Temperature,
	}
	// 流式 usage 必须显式索取：llama.cpp / LM Studio / vLLM 这类本地与开放服务
	// 默认不在流里放 usage（OpenAI 官方也要求 include_usage），不带上这一项就一个
	// token 数都拿不到——前端会话统计的 TPS、缓存命中、总 token 全是「—」。
	// DeepSeek / DashScope / GLM 等网关无论有没有这个字段都会在末块回 usage，
	// 带上只是统一口径；真被拒（400 提到 stream_options）时由重试逻辑摘掉重发。
	if !cfg.noStreamUsage {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if cfg.MaxTokens > 0 {
		body["max_tokens"] = cfg.MaxTokens
	}
	if effort := strings.TrimSpace(cfg.ReasoningEffort); effort != "" {
		body["reasoning_effort"] = effort
	}
	// 思考关闭提示：Thinking=false 时按模型名给会「默认开思考」的国产兼容网下发关闭参数——
	// 不发的话思考模型（GLM-4.5+/5.x 等）会把 reasoning_content 烧掉 max_tokens、正文为空
	// （小预算请求如命令分类器 120 tok 首当其冲，表现为「分类器输出为空」）。
	// 方言由 aiThinkingDisableParam 统一给出；猜错被网关 400 拒收时摘掉参数重试。
	// 只对模型名明确的系列发：DeepSeek chat 本不思考、reasoner 关不掉，其他聚合网不发未知参数防 400。
	if !cfg.Thinking && !cfg.noThinkingParam {
		if key, value := aiThinkingDisableParam(cfg.Model); key != "" {
			body[key] = value
		}
	}
	if len(tools) > 0 {
		body["tools"] = aiOpenAITools(tools)
	}
	return body, nil
}

// claudeVersionRe 匹配 claude-<tier>-<major>[-<minor>]，如 claude-opus-5-5、claude-sonnet-4-5、
// claude-fable-5-2、claude-sonnet-4-5-20250929。claude-3-5-sonnet 这种「数字在前」的老命名不匹配，
// 按老规则处理（固定预算）。
var claudeVersionRe = regexp.MustCompile(`claude-[a-z]+-(\d+)(?:-(\d+))?`)

// claudeRejectsFixedThinkingBudget：Opus 4.6 起（含 4.7/4.8 与 5.x）Anthropic 只接受自适应思考，
// 手动预算 thinking:{"type":"enabled","budget_tokens":N} 会被拒（400），要改发 thinking:{"type":"adaptive"}。
// 4.5 及更早仍用固定预算；非 claude 型号（如走 Anthropic 格式的 DeepSeek）不在此列，保持原样。
func claudeRejectsFixedThinkingBudget(model string) bool {
	lower := strings.ToLower(strings.TrimSpace(model))
	if !strings.Contains(lower, "claude") {
		return false
	}
	m := claudeVersionRe.FindStringSubmatch(lower)
	if m == nil {
		return false
	}
	major, err := strconv.Atoi(m[1])
	if err != nil {
		return false
	}
	minor := 0
	if m[2] != "" {
		if parsed, err := strconv.Atoi(m[2]); err == nil {
			minor = parsed
		}
	}
	return major > 4 || (major == 4 && minor >= 6)
}

// aiBuildResponsesInput 把内部消息映射成 Responses 的 input 数组：
// system → instructions（合并）、tool → function_call_output、assistant 工具调用 →
// function_call；普通文本用 input_text / output_text 部件，图片用 input_image。
// Responses 协议没有视频内容段：带视频的消息直接报错（前端已按 provider 拦，这里是双保险）。
func aiBuildResponsesInput(messages []Message) ([]any, string, error) {
	input := make([]any, 0, len(messages))
	var instructions []string
	for _, m := range messages {
		if len(m.Videos) > 0 {
			return nil, "", errors.New("Responses 协议不支持视频输入：请改用 OpenAI 兼容协议的模型条目，或移除视频附件")
		}
		role := strings.ToLower(strings.TrimSpace(m.Role))
		if role == "system" || role == "developer" {
			if text := strings.TrimSpace(m.Content); text != "" {
				instructions = append(instructions, text)
			}
			continue
		}
		if role == "tool" {
			input = append(input, map[string]any{
				"type": "function_call_output", "call_id": m.ToolCallId, "output": m.Content,
			})
			continue
		}
		for _, call := range m.ToolCalls {
			args := strings.TrimSpace(call.Arguments)
			if args == "" {
				args = "{}"
			}
			input = append(input, map[string]any{
				"type": "function_call", "call_id": call.Id, "name": call.Name, "arguments": args,
			})
		}
		textType := "input_text"
		if role == "assistant" {
			textType = "output_text"
		}
		parts := make([]any, 0, 1+len(m.Images))
		if m.Content != "" {
			parts = append(parts, map[string]any{"type": textType, "text": m.Content})
		}
		for _, img := range m.Images {
			parts = append(parts, map[string]any{
				"type": "input_image", "image_url": "data:" + img.Mime + ";base64," + img.Data,
			})
		}
		if len(parts) > 0 {
			input = append(input, map[string]any{"role": role, "content": parts})
		}
	}
	return input, strings.Join(instructions, "\n\n"), nil
}

// Responses 的 function tool 是扁平的（name/description/parameters 在顶层），
// 与 chat/completions 的 {type, function:{…}} 不同。
func aiResponsesTools(tools []ToolDef) []any {
	out := make([]any, 0, len(tools))
	for _, tool := range tools {
		params := json.RawMessage(tool.Parameters)
		if len(params) == 0 || !json.Valid(params) {
			params = json.RawMessage(`{}`)
		}
		out = append(out, map[string]any{
			"type": "function", "name": tool.Name, "description": tool.Description, "parameters": params,
		})
	}
	return out
}

func aiBuildResponsesBody(cfg Config, messages []Message, tools []ToolDef) (map[string]any, error) {
	input, instructions, err := aiBuildResponsesInput(messages)
	if err != nil {
		return nil, err
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = aiDefaultMaxTokens
	}
	body := map[string]any{
		"model":             cfg.Model,
		"input":             input,
		"stream":            true,
		"max_output_tokens": maxTokens,
		"temperature":       cfg.Temperature,
	}
	if instructions != "" {
		body["instructions"] = instructions
	}
	if len(tools) > 0 {
		body["tools"] = aiResponsesTools(tools)
	}
	if effort := strings.TrimSpace(cfg.ReasoningEffort); effort != "" {
		body["reasoning"] = map[string]any{"effort": effort}
	}
	return body, nil
}

func aiBuildAnthropicBody(cfg Config, messages []Message, tools []ToolDef) (map[string]any, error) {
	system, converted, err := aiAnthropicMessages(messages, cfg.Thinking)
	if err != nil {
		return nil, err
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = aiDefaultMaxTokens
	}
	// 提示词缓存：Anthropic 是**显式**缓存——不打 cache_control 就每轮全量计费
	// （OpenAI / DeepSeek 是自动缓存，不受影响）。断点最多 4 个，这里用 3 个：
	// 系统提示词末尾、最后一个工具定义、最后一条消息的最后一个 block。
	// 系统提示词与工具定义是稳定前缀（动态块已移出系统提示词，见 ai-system-context.js），
	// 最后一条消息的断点让「上一轮末尾 → 这一轮开头」这段增量也能命中。
	cache := !cfg.noPromptCache
	body := map[string]any{
		"model":      cfg.Model,
		"max_tokens": maxTokens,
		"messages":   converted,
		"stream":     true,
	}
	if system != "" {
		if cache {
			body["system"] = []map[string]any{{
				"type":          "text",
				"text":          system,
				"cache_control": anthropicCacheControl(),
			}}
		} else {
			body["system"] = system
		}
	}
	if len(tools) > 0 {
		defs := aiAnthropicTools(tools)
		if cache && len(defs) > 0 {
			defs[len(defs)-1]["cache_control"] = anthropicCacheControl()
		}
		body["tools"] = defs
	}
	if cache {
		markAnthropicTailCacheControl(converted)
	}
	if cfg.Thinking {
		// 扩展思考开启时 Anthropic 拒绝 temperature != 1，直接省略（默认 1）。
		if claudeRejectsFixedThinkingBudget(cfg.Model) {
			// 新家族的自适应思考：深度由 effort 控制，固定预算会 400
			body["thinking"] = map[string]any{"type": "adaptive"}
		} else {
			budget := cfg.ThinkingBudget
			if budget < 1024 {
				budget = 1024
			}
			body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		}
	} else {
		body["temperature"] = cfg.Temperature
	}
	return body, nil
}

// ===== 消息与工具格式转换 =====
func aiOpenAIMessages(messages []Message, passReasoning bool) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(messages))
	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system", "user":
			if role == "user" && (len(m.Images) > 0 || len(m.Videos) > 0) {
				parts := make([]any, 0, len(m.Images)+len(m.Videos)+1)
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
				// 视频内容段按 Qwen-VL（DashScope / vLLM）的 OpenAI 兼容约定发 video_url；
				// 官方 OpenAI / Gemini 兼容层不认这个类型，前端门禁只对勾了「视频」的条目放行。
				for _, vid := range m.Videos {
					mime := strings.ToLower(strings.TrimSpace(vid.Mime))
					parts = append(parts, map[string]any{
						"type": "video_url",
						"video_url": map[string]any{
							"url": "data:" + mime + ";base64," + vid.Data,
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
			// deepseek 系思考模型要求多轮回传 reasoning_content（缺失时网关 400：
			// "The reasoning_content in the thinking mode must be passed back"）。
			// 网关逐条校验（2026-11-14 重放 4xx 转储实测）：tools 在场且 assistant
			// 为末条（续写形态）或带 tool_calls 时字段必须存在，空串也必须写。
			// 其他 OpenAI 兼容端点可能拒收未知字段，故按模型名门控。
			if passReasoning {
				obj["reasoning_content"] = m.Thinking
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

func aiAnthropicMessages(messages []Message, includeThinking bool) (string, []map[string]any, error) {
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
			// Anthropic 协议没有视频内容段：带视频直接报错（前端已按 provider 拦，这里是双保险）。
			if len(m.Videos) > 0 {
				return "", nil, errors.New("Anthropic 协议不支持视频输入：请改用 OpenAI 兼容协议的模型条目，或移除视频附件")
			}
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

func aiOpenAITools(tools []ToolDef) []map[string]any {
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

func aiAnthropicTools(tools []ToolDef) []map[string]any {
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
