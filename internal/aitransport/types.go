// Package aitransport：AI 传输引擎——OpenAI / Anthropic / Responses 三套请求构造、
// SSE 解码、重试与空闲看门狗、配置校验与代理；事件名与载荷类型是绑定层与前端的事件契约。
package aitransport

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// AI 面板的 Go 侧只做两件事：双协议 HTTP + SSE 流式转发（事件归一化），
// 以及记忆/技能目录解析。Agent 编排、审批、diff 全在前端。
const (
	// IdleTimeout 是默认空闲超时（300 秒）；用户可在设置里覆盖（Config.IdleTimeoutSec）。
	IdleTimeout = 300 * time.Second
	// 空闲超时的可配置范围（秒）：最短 30 秒，最长 60 分钟。
	IdleTimeoutMinSec     = 30
	IdleTimeoutMaxSec     = 3600
	DefaultIdleTimeoutSec = 300
	aiDialTimeout         = 10 * time.Second
	aiErrorBodyLimit      = 64 << 10
	aiErrorTextLimit      = 500
	aiDefaultMaxTokens    = 4096
	aiMaxExtraHeaders     = 8
	// 插件 provider 每轮注入的请求体补丁上限（与前端 plugin-ai-providers.js 对齐）
	aiMaxExtraBodyKeys  = 32
	aiMaxExtraBodyBytes = 64 << 10
	// 单条 assistant 消息携带的工具调用数上限：防的是畸形历史（一条消息挂几百个 call），
	// 不是工具清单规模——工具定义数量本身不设上限（与 opencode / pi / ZCode / cline /
	// codex / deepseek-harness 一致，容量控制走 token 预算 + 压缩）。
	aiMaxToolCallsPerMessage = 128
	// 单次请求体积兜底（仅防爆）：同样六个参照 harness 都不设消息条数上限，条数与体积无关
	// （1000 条短消息可能很小，200 条带图消息可能上百 MB）。这里只拦「序列化后大到任何服务商
	// 都不可能接受」的请求，避免把几百 MB 的 base64 塞进 HTTP 客户端。
	aiMaxRequestBytes = 128 << 20
	aiMaxModels       = 500
	// 图片三层阈值不在本包另写一份：唯一真源在 internal/aiimagepolicy（经 AIImageLimits 投影给前端）。
	// 这里只做 Go 侧强制校验的引用，数值改在 aiimagepolicy 一处即可，前后端不会漂。
	// 视频输入（OpenAI 兼容协议的 video_url 内容段）：不做降质/截帧，体积门禁放前端，
	// 这里只兜底。Qwen-VL 系（DashScope / vLLM）实测可吃十几 MB 的 base64 视频。
	aiMaxVideosPerMessage = 1
	aiMaxVideoBase64      = 24 << 20
	// aiChunkBatchWindow 合并 ai-think/ai-chunk 的时间窗：DeepSeek reasoning 每秒可达
	// 上百个小块，逐块 EventsEmit 会造成 WebView2 IPC 洪泛、渲染进程主线程被压到流
	// 结束才消化完（思考内容表现为「全部输出完才出现」）。窗口内的同类文本合并一次发出。
	aiChunkBatchWindow = 30 * time.Millisecond
)

const (
	EventChunk    = "ai-chunk"
	EventThink    = "ai-think"
	EventToolCall = "ai-toolcall"
	EventDone     = "ai-done"
	EventError    = "ai-error"
	EventRetry    = "ai-retry"
	// 服务端参数校验给出的上限（如 max_tokens 超模型上限）被自动收敛时通知前端，
	// 由前端提示用户并把该模型条目的输出窗口回写到配置。
	EventParamAdjust = "ai-param-adjust"
	// 请求因本地 RPM 限流（或 429 冻结）排队时通知前端。WaitMs=0 表示排队结束、
	// 请求已发出——前端据此收起「排队中」提示，否则用户看到的是纯空转。
	EventQueue = "ai-queue"
)

var (
	ErrIdleTimeout = errors.New("AI 响应超时（无数据）")
	// ErrStreamTruncated：流式响应在生成中途被服务端断开。具体断法有三种形态
	// （chunked 缺终止块 / 连接被重置 / 流干净关闭但没有终止事件），前端据此
	// 整轮自动重试，而不是把半截内容当完整结果落盘或把裸错误摆给用户。
	ErrStreamTruncated = errors.New("AI 流式响应被服务端提前断开")
	// ErrStreamUpstreamError：流已正常开启（HTTP 200 + SSE），但网关在流中途发了
	// error 事件且文案是网关/上游故障特征（error code: 5xx、[502]、HTTP 5xx 等）。
	// 与 unexpected EOF 同属「整轮重发即可恢复」的传输故障：HTTP 状态码层面的
	// 5xx 重试循环够不着它，必须靠这个标记让前端自动重发，而不是把 502 摆给用户。
	ErrStreamUpstreamError = errors.New("AI 流式响应在流内收到网关错误")
	errAnthropicDone       = errors.New("anthropic stream done")
	aiToolNameRule         = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// idleTimeoutError 携带本次实际生效的空闲超时秒数，文案对用户显示具体阈值；
// Is 保留 ErrIdleTimeout 哨兵语义，调用方仍可用 errors.Is 判定超时。
type idleTimeoutError struct {
	seconds int
}

func (e *idleTimeoutError) Error() string {
	return fmt.Sprintf("AI 响应超时（%d 秒无数据）", e.seconds)
}

func (e *idleTimeoutError) Is(target error) bool { return target == ErrIdleTimeout }

// resolveIdleTimeout 把配置里的秒数钳到 [30, 3600]；缺省（<=0）取默认 300 秒。
func resolveIdleTimeout(sec int) time.Duration {
	if sec <= 0 {
		sec = DefaultIdleTimeoutSec
	}
	if sec < IdleTimeoutMinSec {
		sec = IdleTimeoutMinSec
	}
	if sec > IdleTimeoutMaxSec {
		sec = IdleTimeoutMaxSec
	}
	return time.Duration(sec) * time.Second
}

// Config 由前端 Profile 组装；API Key 只存在于前端 localStorage 与请求头，
// 不写入日志、不落盘。
type Config struct {
	Provider     string            `json:"provider"`
	BaseURL      string            `json:"baseURL"`
	APIKey       string            `json:"apiKey"`
	Model        string            `json:"model"`
	Temperature  float64           `json:"temperature"`
	MaxTokens    int               `json:"maxTokens"`
	Proxy        string            `json:"proxy,omitempty"`
	ExtraHeaders map[string]string `json:"extraHeaders,omitempty"`
	// ExtraBody 是插件 provider 每轮注入的请求体补丁；stream 由 aiApplyBodyPatch 强制保持 true，
	// 否则 SSE 解码会拿不到流。字段上限与合法性在 ValidateEndpoint 里校验。
	ExtraBody      map[string]any `json:"extraBody,omitempty"`
	Thinking       bool           `json:"thinking,omitempty"`
	ThinkingBudget int            `json:"thinkingBudget,omitempty"`
	// ReasoningEffort 仅用于 OpenAI 兼容协议，按 reasoning_effort 原样发送。
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	// RPMLimit 是手动设置的每分钟请求数上限（0 = 不限）。按 baseURL+model 统计，
	// 超出就在客户端排队，避免并发把接口打到 429。见 ratelimit.go。
	RPMLimit int `json:"rpmLimit,omitempty"`
	// IdleTimeoutSec 是空闲超时秒数（连续这么久无数据即中断），0 = 用默认 300 秒。
	// 实际生效值在 resolveIdleTimeout 里钳到 [30, 3600]。
	IdleTimeoutSec int `json:"idleTimeoutSec,omitempty"`
	// noStreamUsage 只在本次请求内由重试逻辑置位：网关 400 拒收 stream_options
	// （个别老 shim 会把未知字段当参数错误）时，去掉该字段再试一次。不进 JSON。
	noStreamUsage bool
	// noThinkingParam 只在本次请求内由重试逻辑置位：网关 400 拒收按模型名猜出的
	// 「关思考」参数（thinking / enable_thinking 各家方言不一）时，去掉该字段再试一次——
	// 思考回到服务端默认值，比整个请求 400 可用。不进 JSON。
	noThinkingParam bool
	// noPromptCache 只在本次请求内由重试逻辑置位：个别 Anthropic 兼容网关不认识
	// cache_control（标准字段，但实现未必跟上），400 时去掉全部缓存断点再试一次。
	// 不缓存只是贵一点，不该让对话跑不通。不进 JSON。
	noPromptCache bool
}

// Message 是前端与 Go 之间的会话消息（规范化中间格式）。
// assistant 的 ToolCalls 为工具调用请求，role=tool 的消息用 ToolCallId 回填结果。
type Message struct {
	Role              string      `json:"role"`
	Content           string      `json:"content,omitempty"`
	Images            []ImagePart `json:"images,omitempty"`
	Videos            []ImagePart `json:"videos,omitempty"`
	ToolCalls         []ToolCall  `json:"toolCalls,omitempty"`
	ToolCallId        string      `json:"toolCallId,omitempty"`
	Name              string      `json:"name,omitempty"`
	Thinking          string      `json:"thinking,omitempty"`
	ThinkingSignature string      `json:"thinkingSignature,omitempty"`
}

type ImagePart struct {
	Mime string `json:"mime"`
	Data string `json:"data"`
}

type ToolCall struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type ChunkPayload struct {
	Id    string `json:"id"`
	Delta string `json:"delta"`
}

type ToolCallPayload struct {
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
	// CacheWriteTokens 只对 Anthropic 有值（cache_creation_input_tokens）：写进提示缓存的量，
	// 与「缓存读取」分开统计，前端每轮用量浮层会单独列一行。
	CacheWriteTokens int `json:"cacheWriteTokens,omitempty"`
}

type DonePayload struct {
	Id                string   `json:"id"`
	FinishReason      string   `json:"finishReason"`
	ThinkingSignature string   `json:"thinkingSignature,omitempty"`
	Usage             *aiUsage `json:"usage,omitempty"`
	// StatusCode 是这条成功流对应的 HTTP 状态码（请求日志展示用；重试后记最终成功的响应）。
	StatusCode int `json:"statusCode,omitempty"`
}

type ErrorPayload struct {
	Id      string `json:"id"`
	Message string `json:"message"`
	// Retryable 表示整轮重发即可恢复（目前只有流中途被掐断）：前端据此自动重试。
	Retryable bool `json:"retryable,omitempty"`
}

type RetryPayload struct {
	Id      string `json:"id"`
	Attempt int    `json:"attempt"`
	Max     int    `json:"max"`
	DelayMs int    `json:"delayMs"`
	Reason  string `json:"reason"`
}

// QueuePayload 描述本地限流导致的排队。WaitMs 为 0 是「排队结束」的清除信号。
//
// Kind 必须区分两种性质完全不同的等待，否则前端只能把「配额已用尽 9.9 小时」
// 也写成「RPM 限流」，用户会误以为是自己请求太密：
//   - QueueKindRPM：本地滑动窗口满，等一个窗口即可（≤ 60s）
//   - QueueKindFrozen：服务端 429 的 Retry-After 回灌出的冻结期，可能长达数小时
type QueuePayload struct {
	Id     string `json:"id"`
	WaitMs int    `json:"waitMs"`
	Reason string `json:"reason,omitempty"`
	Kind   string `json:"kind,omitempty"`
}

// ParamAdjustPayload：一次请求内因服务端参数上限而自动降档的通知。
// Previous/Value 都是 max_tokens 的 token 数；前端按 Value 回写模型条目的 outputWindow。
type ParamAdjustPayload struct {
	Id       string `json:"id"`
	Model    string `json:"model"`
	Field    string `json:"field"`
	Previous int    `json:"previous"`
	Value    int    `json:"value"`
	Message  string `json:"message"`
}

type Emitter func(event string, payload any)

// aiChunkBatcher 按时间窗合并思考/正文增量。toolcall/done/error 不经批处理，
// 终端事件发出前先同步 flush，保证前端收到 done 时内容已完整。
type aiChunkBatcher struct {
	mu      sync.Mutex
	id      string
	think   strings.Builder
	content strings.Builder
	timer   *time.Timer
	emit    Emitter
}
