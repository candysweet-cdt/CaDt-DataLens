package aichat

// AI 对话入口（Wails 绑定层）：发消息/停止/触摸看门狗/连通性测试/模型列举与目录工具。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/aitransport"

	"datalens/internal/appdata"
)

// Chat AI 对话引擎：流注册表、取消与看门狗在本包，协议在 internal/aitransport。
type Chat struct{}

// 宿主注入（main 的 init/startup 接线）。
var (
	// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
	Emit func(event string, payload any)
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
)

func emit(event string, payload any) {
	if Emit != nil {
		Emit(event, payload)
	}
}

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

// AISendChat 启动一轮流式对话。立即返回后由 goroutine 通过 ai-* 事件推送：
// ai-chunk / ai-think / ai-toolcall / ai-done / ai-error。同一 sessionId 的新请求
// 会先取消旧请求；AIStop 按 sessionId 前缀取消（前端传 session.id#round）。
func (c *Chat) AISendChat(sessionId string, cfg aitransport.Config, messages []aitransport.Message, tools []aitransport.ToolDef, retryMax int) error {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return errors.New("会话标识为空")
	}
	if retryMax < 0 {
		retryMax = 0
	}
	if retryMax > 10 {
		retryMax = 10
	}
	if err := aitransport.ValidateConfig(cfg); err != nil {
		return err
	}
	if fixed := aitransport.SanitizeMessages(messages); fixed > 0 {
		// 兜底：前端已在工具轮把错误作为工具结果回给模型；这里防止旧会话/其他路径的坏参数整轮拒收。
		logf("warn", "AI 请求包含 %d 个非法工具参数，已按 {} 兜底发送", fixed)
	}
	if err := aitransport.ValidateMessages(messages); err != nil {
		return err
	}
	if err := aitransport.ValidateTools(tools); err != nil {
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
		logf("info", "AI 请求：provider=%s host=%s model=%s messages=%d tools=%d",
			aitransport.ProviderName(cfg), aitransport.BaseHost(cfg.BaseURL), cfg.Model, len(messages), len(tools))
		err := aitransport.StreamResponse(ctx, cancel, sessionId, cfg, messages, tools, emit, retryMax)
		cause := context.Cause(ctx)

		switch {
		case errors.Is(cause, aitransport.ErrIdleTimeout):
			// cause 是带实际秒数的 idleTimeoutError；用户看到的文案要说清具体阈值。
			emit(aitransport.EventError, aitransport.ErrorPayload{Id: sessionId, Message: cause.Error()})
			logf("error", "AI 流中断：%v", cause)
		case errors.Is(cause, context.Canceled):
			emit(aitransport.EventDone, aitransport.DonePayload{Id: sessionId, FinishReason: "stopped"})
			logf("info", "AI 请求已停止（%s）", time.Since(started).Round(time.Millisecond))
		case err != nil:
			// 流中途被掐断（EOF）与流内收到网关 5xx 错误（如 502）都是「整轮重发
			// 即可恢复」的传输故障：标记 retryable 让前端自动重发；其余错误如实上抛。
			emit(aitransport.EventError, aitransport.ErrorPayload{
				Id:        sessionId,
				Message:   err.Error(),
				Retryable: errors.Is(err, aitransport.ErrStreamTruncated) || errors.Is(err, aitransport.ErrStreamUpstreamError),
			})
			logf("error", "AI 请求失败（%s）：%v", time.Since(started).Round(time.Millisecond), err)
		default:
			logf("info", "AI 请求结束（%s）", time.Since(started).Round(time.Millisecond))
		}
	}()
	return nil
}

// AIStop 取消匹配 sessionId 的正在进行的请求（前缀匹配支持 session.id#round）。
func (c *Chat) AIStop(sessionId string) {
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

// AITouchStream 重置匹配会话的空闲看门狗（sessionId 前缀匹配）。前端在工具
// 执行/等待用户输入等无网络数据阶段定期调用，避免空闲超时（可配置）误杀挂起的流。
func (c *Chat) AITouchStream(sessionId string) {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return
	}
	aiStreams.Lock()
	for id, entry := range aiStreams.entries {
		if id == sessionId || strings.HasPrefix(id, sessionId+"#") {
			if entry.watchdog != nil {
				idle := entry.idle
				if idle <= 0 {
					idle = aitransport.IdleTimeout // 未挂载时（旧路径/测试）退回默认
				}
				entry.watchdog.Reset(idle)
			}
		}
	}
	aiStreams.Unlock()
}

// aiTestTimeout 连通性测试的单次上限：端点无响应时绑定调用必须能返回错误，
// 而不是让前端界面永久停在「测试中…」。
const aiTestTimeout = 20 * time.Second

// AITestConnection 验证当前 Profile 的地址/密钥/模型是否可用。
func (c *Chat) AITestConnection(cfg aitransport.Config) (string, error) {
	if err := aitransport.ValidateEndpoint(cfg); err != nil {
		return "", err
	}
	if aitransport.ProviderOf(cfg) == aitransport.ProviderAnthropic && strings.TrimSpace(cfg.Model) == "" {
		return "", errors.New("请先配置模型名")
	}
	client, err := aitransport.NewHTTPClient(cfg)
	if err != nil {
		return "", err
	}
	defer client.CloseIdleConnections()

	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if aitransport.ProviderOf(cfg) == aitransport.ProviderAnthropic {
		body, err := json.Marshal(map[string]any{
			"model":      cfg.Model,
			"max_tokens": 1,
			"messages":   []map[string]any{{"role": "user", "content": "ping"}},
		})
		if err != nil {
			return "", err
		}
		// 带超时的 ctx：端点挂起时不能让绑定调用永久阻塞（chat.go 的 client 无 Timeout）。
		ctx, cancel := context.WithTimeout(context.Background(), aiTestTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, aitransport.AnthropicMessagesURL(base), bytes.NewReader(body))
		if err != nil {
			return "", err
		}
		if err := aitransport.ApplyHeaders(req, cfg, aitransport.ProviderAnthropic, false); err != nil {
			return "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("连接失败：%w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", errors.New(aitransport.StatusErrorText(resp))
		}
		return fmt.Sprintf("连接成功（Anthropic，HTTP %d）", resp.StatusCode), nil
	}

	models, err := aitransport.ListModels(client, cfg)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("连接成功，可用模型 %d 个", len(models)), nil
}

// AIListModels 拉取 OpenAI 兼容端点的模型列表（Anthropic 需手动填写模型名）。
func (c *Chat) AIListModels(cfg aitransport.Config) ([]string, error) {
	if err := aitransport.ValidateEndpoint(cfg); err != nil {
		return nil, err
	}
	if aitransport.ProviderOf(cfg) == aitransport.ProviderAnthropic {
		return nil, errors.New("Anthropic 不提供模型列表接口，请手动填写模型名")
	}
	client, err := aitransport.NewHTTPClient(cfg)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	return aitransport.ListModels(client, cfg)
}

// AIAppDir 返回应用数据根目录（记忆 app 模式、技能 app 级目录都挂在其下）。
func (c *Chat) AIAppDir() string {
	return appdata.Root()
}

// AIHomeDir 返回当前用户主目录（用户级技能 ~/.agents/skills 解析用；失败返回空串）。
func (c *Chat) AIHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Clean(home)
}

// AIExePath 返回当前可执行文件绝对路径（内置技能 {{EXE_PATH}} 占位用；失败返回空串）。
func (c *Chat) AIExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Clean(exe)
}

// AIEnsureDir 创建记忆/技能目录（MkdirAll，已存在不报错）。
func (c *Chat) AIEnsureDir(dir string) error {
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
