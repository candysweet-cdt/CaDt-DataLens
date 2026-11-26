package aitransport

// AI 参数校验：端点协议、配置、消息与工具清单的规范化检查。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"datalens/internal/aiimagepolicy"
)

func ProviderOf(cfg Config) ProviderKind {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "anthropic", "claude":
		return ProviderAnthropic
	case "responses", "openai-responses":
		return ProviderResponses
	default:
		return ProviderOpenAI
	}
}

func ProviderName(cfg Config) string {
	switch ProviderOf(cfg) {
	case ProviderAnthropic:
		return "anthropic"
	case ProviderResponses:
		return "responses"
	default:
		return "openai"
	}
}

func ValidateEndpoint(cfg Config) error {
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
	if len(cfg.ExtraBody) > aiMaxExtraBodyKeys {
		return fmt.Errorf("请求体补丁最多 %d 个字段", aiMaxExtraBodyKeys)
	}
	if len(cfg.ExtraBody) > 0 {
		encoded, err := json.Marshal(cfg.ExtraBody)
		if err != nil {
			return fmt.Errorf("请求体补丁不是合法 JSON：%w", err)
		}
		if len(encoded) > aiMaxExtraBodyBytes {
			return fmt.Errorf("请求体补丁超过 %d 字节", aiMaxExtraBodyBytes)
		}
	}
	for name, value := range cfg.ExtraHeaders {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("自定义请求头包含换行：%s", name)
		}
		if ForbiddenHeader(name) {
			return fmt.Errorf("不允许自定义请求头：%s", name)
		}
	}
	return nil
}

func ValidateConfig(cfg Config) error {
	if err := ValidateEndpoint(cfg); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return errors.New("请先配置模型名")
	}
	if ProviderOf(cfg) == ProviderAnthropic && cfg.Thinking {
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

// SanitizeMessages 把非法的工具调用参数收敛为 {}：一条坏历史不应让整轮请求失败。
// 前端会在工具轮结束时把无法修复的参数作为工具错误结果回给模型，这里只是最后兜底。
// 返回被替换的调用数量。
func SanitizeMessages(messages []Message) int {
	fixed := 0
	for i := range messages {
		for j := range messages[i].ToolCalls {
			args := strings.TrimSpace(messages[i].ToolCalls[j].Arguments)
			if args == "" {
				continue
			}
			if json.Valid([]byte(args)) {
				messages[i].ToolCalls[j].Arguments = args
				continue
			}
			messages[i].ToolCalls[j].Arguments = "{}"
			fixed++
		}
	}
	return fixed
}

func ValidateMessages(messages []Message) error {
	if len(messages) == 0 {
		return errors.New("消息为空")
	}
	// 不设条数上限（六份参照 harness 都不设）：条数与真实体积无关，容量控制由前端的
	// token 预算 + 压缩负责。这里只做体积兜底，拦住不可能被任何服务商接受的请求。
	if size := messagesPayloadBytes(messages); size > aiMaxRequestBytes {
		return fmt.Errorf("请求体积超过上限（%d MB）：请先压缩上下文（/compact）或减少附件", aiMaxRequestBytes>>20)
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
			limits := aiimagepolicy.Get()
			if len(m.Images) > limits.MaxImagesPerMessage {
				return fmt.Errorf("第 %d 条消息图片超过上限（%d 张）", i+1, limits.MaxImagesPerMessage)
			}
			// 先把长度与格式这两项 O(1) 检查跑完，再决定要不要解码：
			// 上限抬到 32 MiB/消息后，历史里几条带图消息就是上百 MB base64，
			// 先整体解码再报「合计超限」会白白分配一大块内存。
			var imageTotal int64
			for j, img := range m.Images {
				mime := strings.ToLower(strings.TrimSpace(img.Mime))
				if !containsString(limits.MediaTypes, mime) {
					return fmt.Errorf("第 %d 条消息第 %d 张图片格式不支持：%s", i+1, j+1, img.Mime)
				}
				data := strings.TrimSpace(img.Data)
				if data == "" {
					return fmt.Errorf("第 %d 条消息第 %d 张图片数据为空", i+1, j+1)
				}
				if len(data) > limits.MaxNormalizedBase64 {
					return fmt.Errorf("第 %d 条消息第 %d 张图片超过大小上限（%d MB）",
						i+1, j+1, limits.MaxNormalizedBase64>>20)
				}
				imageTotal += int64(len(data))
			}
			// 单条消息所有图片编码后合计的硬预算（对应 dsh 的 maxMessageImageBytes 在请求层的形态）：
			// 单张各自合规不代表这一轮不会被几百 MB 的附件拖垮。放在解码之前判。
			if imageTotal > int64(limits.MaxRequestImageBytes) {
				return fmt.Errorf("第 %d 条消息图片合计超过上限（%d MB）：请减少图片或先发送当前消息",
					i+1, limits.MaxRequestImageBytes>>20)
			}
			// 长度/格式/合计都过关，才做 base64 合法性解码（最贵的一步）。
			for j, img := range m.Images {
				if _, err := base64.StdEncoding.DecodeString(strings.TrimSpace(img.Data)); err != nil {
					return fmt.Errorf("第 %d 条消息第 %d 张图片不是合法 base64", i+1, j+1)
				}
			}
		}
		if len(m.Videos) > 0 {
			if role != "user" {
				return fmt.Errorf("第 %d 条消息只有用户消息可以携带视频", i+1)
			}
			if len(m.Videos) > aiMaxVideosPerMessage {
				return fmt.Errorf("第 %d 条消息视频超过上限（%d 个）", i+1, aiMaxVideosPerMessage)
			}
			for j, vid := range m.Videos {
				mime := strings.ToLower(strings.TrimSpace(vid.Mime))
				if mime != "video/mp4" {
					return fmt.Errorf("第 %d 条消息第 %d 个视频格式不支持：%s（当前仅支持 mp4）", i+1, j+1, vid.Mime)
				}
				data := strings.TrimSpace(vid.Data)
				if data == "" {
					return fmt.Errorf("第 %d 条消息第 %d 个视频数据为空", i+1, j+1)
				}
				if len(data) > aiMaxVideoBase64 {
					return fmt.Errorf("第 %d 条消息第 %d 个视频超过大小上限", i+1, j+1)
				}
				if _, err := base64.StdEncoding.DecodeString(data); err != nil {
					return fmt.Errorf("第 %d 条消息第 %d 个视频不是合法 base64", i+1, j+1)
				}
			}
		}
		if len(m.ToolCalls) > aiMaxToolCallsPerMessage {
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

// containsString 判断 strings 里是否有目标值（图片 MIME 白名单来自 aiimagepolicy，规模很小，线性比对足够）。
func containsString(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}

// messagesPayloadBytes 估算请求体的序列化体积：正文 + 思考 + 工具参数 + 附件 base64。
// 用于代替「消息条数」上限——条数和体积没有相关性，超限判定必须看真实体积。
// 超过 aiMaxRequestBytes 立刻返回（不必算完整份历史）。
func messagesPayloadBytes(messages []Message) int {
	total := 0
	for i := range messages {
		m := &messages[i]
		total += len(m.Content) + len(m.ToolCallId) + len(m.Name) + len(m.Thinking)
		for j := range m.ToolCalls {
			total += len(m.ToolCalls[j].Id) + len(m.ToolCalls[j].Name) + len(m.ToolCalls[j].Arguments)
		}
		for j := range m.Images {
			total += len(m.Images[j].Data)
		}
		for j := range m.Videos {
			total += len(m.Videos[j].Data)
		}
		if total > aiMaxRequestBytes {
			return total
		}
	}
	return total
}

func ValidateTools(tools []ToolDef) error {
	// 工具定义数量不设上限（与六份参照 harness 一致）：控制工具开销靠延迟暴露/工具搜索，
	// 而不是砍数量。这里只校验单个定义的名称与 schema 合法性。
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

func aiToolSchema(tool ToolDef) (json.RawMessage, error) {
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

// StreamResponse 执行一次流式请求，事件经 emit 归一化输出。
// 空闲 300 秒会取消 ctx，调用方通过 context.Cause 区分超时与用户停止。
// retryMax > 0 时，对 429/5xx/网络错误做指数退避重试（优先遵循 Retry-After）；
// 仅在尚未输出任何流内容前重试，进入 SSE 解析后不再重试。
