// ai_usage.go：cc-switch 式用量查询（设置 → 模型账号卡片「查询用量」）。
// 按账号 baseURL 的 host 匹配内置端点表，向服务商的余额/用量接口发一次 GET；
// 未收录的服务商返回 Supported=false（前端给出明确提示）。API Key 只用于本次
// 请求头，不写入日志、不落盘。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	aiUsageTimeout   = 15 * time.Second
	aiUsageBodyLimit = 64 << 10
)

// AIUsageItem 是用量弹层里的单行「标签：值」。
type AIUsageItem struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// AIUsageResult 是前端弹层的渲染数据；Supported=false 时前端提示该服务商暂不支持。
type AIUsageResult struct {
	Supported bool          `json:"supported"`
	Provider  string        `json:"provider"`
	Items     []AIUsageItem `json:"items,omitempty"`
	Error     string        `json:"error,omitempty"`
}

// aiUsageEndpoint 描述一家服务商的余额接口：host 匹配 + URL 构造 + 响应解析。
type aiUsageEndpoint struct {
	name  string
	hosts []string
	build func(baseURL string) string
	parse func(body []byte) ([]AIUsageItem, error)
}

// aiUsageEndpoints 内置端点表（host 小写、不带端口；匹配用 ==）。
var aiUsageEndpoints = []aiUsageEndpoint{
	{
		name:  "DeepSeek",
		hosts: []string{"api.deepseek.com"},
		// 余额接口在根路径下（/user/balance），不在 baseURL 的 /v1 前缀里
		build: func(baseURL string) string { return aiUsageOrigin(baseURL) + "/user/balance" },
		parse: aiUsageParseDeepSeek,
	},
	{
		name:  "OpenRouter",
		hosts: []string{"openrouter.ai"},
		build: func(string) string { return "https://openrouter.ai/api/v1/credits" },
		parse: aiUsageParseOpenRouter,
	},
	{
		name:  "SiliconFlow",
		hosts: []string{"api.siliconflow.cn", "api.siliconflow.com"},
		build: func(baseURL string) string { return aiUsageOrigin(baseURL) + "/v1/user/info" },
		parse: aiUsageParseSiliconFlow,
	},
}

// (a *App) AIUsageQuery 是 Wails 绑定入口；耗时操作放后台线程由 Wails 调度。
func (a *App) AIUsageQuery(cfg AIConfig) AIUsageResult {
	return aiUsageQuery(cfg)
}

func aiUsageQuery(cfg AIConfig) AIUsageResult {
	endpoint := aiUsageEndpointFor(cfg.BaseURL)
	if endpoint == nil {
		return AIUsageResult{Supported: false}
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: "API Key 未配置，请先在账号设置中填写"}
	}
	client, err := newAIHTTPClient(cfg)
	if err != nil {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: err.Error()}
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), aiUsageTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.build(cfg.BaseURL), nil)
	if err != nil {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: "请求构造失败：" + err.Error()}
	}
	if err := aiApplyUsageHeaders(req, cfg); err != nil {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: err.Error()}
	}
	resp, err := client.Do(req)
	if err != nil {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: "请求失败：" + err.Error()}
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, aiUsageBodyLimit))
	if resp.StatusCode != http.StatusOK {
		return AIUsageResult{
			Supported: true,
			Provider:  endpoint.name,
			Error:     fmt.Sprintf("HTTP %d：%s", resp.StatusCode, aiUsageErrorSnippet(body, readErr)),
		}
	}
	if readErr != nil {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: "读取响应失败：" + readErr.Error()}
	}
	items, err := endpoint.parse(body)
	if err != nil {
		return AIUsageResult{Supported: true, Provider: endpoint.name, Error: "响应解析失败：" + err.Error()}
	}
	return AIUsageResult{Supported: true, Provider: endpoint.name, Items: items}
}

func aiUsageEndpointFor(baseURL string) *aiUsageEndpoint {
	host := strings.ToLower(aiBaseHost(baseURL))
	if host == "" {
		return nil
	}
	// 容忍显式默认端口（api.deepseek.com:443 这类写法）
	if h, _, err := net.SplitHostPort(host); err == nil && h != "" {
		host = strings.ToLower(h)
	}
	for i := range aiUsageEndpoints {
		for _, known := range aiUsageEndpoints[i].hosts {
			if host == known {
				return &aiUsageEndpoints[i]
			}
		}
	}
	return nil
}

// aiUsageOrigin 取 scheme://host（余额接口一般不带 baseURL 的版本前缀）。
func aiUsageOrigin(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimSuffix(strings.TrimSpace(baseURL), "/")
	}
	return u.Scheme + "://" + u.Host
}

// aiApplyUsageHeaders 与 aiApplyHeaders 的鉴权/自定义头逻辑一致，但无流式语义。
func aiApplyUsageHeaders(req *http.Request, cfg AIConfig) error {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(appVersion, "v")+" AI")
	if key := strings.TrimSpace(cfg.APIKey); key != "" {
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

func aiUsageErrorSnippet(body []byte, readErr error) string {
	if len(body) == 0 {
		if readErr != nil {
			return readErr.Error()
		}
		return "（空响应）"
	}
	text := strings.TrimSpace(string(body))
	if len(text) > 300 {
		text = text[:300] + "…"
	}
	return text
}

// ---------- 各家响应解析（字段缺失时返回明确错误） ----------

func aiUsageJSON(body []byte) (map[string]any, error) {
	var data map[string]any
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, errors.New("响应不是合法 JSON")
	}
	return data, nil
}

// aiUsageText 把 JSON 标量统一转成展示字符串（数字去掉多余小数位）。
func aiUsageText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		if typed {
			return "是"
		}
		return "否"
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func aiUsageLookup(data map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := data[key]; ok {
			return value
		}
	}
	return nil
}

func aiUsageParseDeepSeek(body []byte) ([]AIUsageItem, error) {
	data, err := aiUsageJSON(body)
	if err != nil {
		return nil, err
	}
	items := []AIUsageItem{}
	if available, ok := data["is_available"].(bool); ok {
		items = append(items, AIUsageItem{Label: "账户可用", Value: aiUsageText(available)})
	}
	infos, _ := data["balance_infos"].([]any)
	if len(infos) == 0 {
		return nil, errors.New("响应缺少 balance_infos 字段")
	}
	for _, raw := range infos {
		info, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		currency := aiUsageText(aiUsageLookup(info, "currency"))
		suffix := ""
		if currency != "" {
			suffix = "（" + currency + "）"
		}
		if total := aiUsageText(info["total_balance"]); total != "" {
			items = append(items, AIUsageItem{Label: "总额余额" + suffix, Value: total})
		}
		if granted := aiUsageText(info["granted_balance"]); granted != "" && granted != "0" {
			items = append(items, AIUsageItem{Label: "赠送余额" + suffix, Value: granted})
		}
		if topped := aiUsageText(info["topped_up_balance"]); topped != "" && topped != "0" {
			items = append(items, AIUsageItem{Label: "充值余额" + suffix, Value: topped})
		}
	}
	if len(items) == 0 {
		return nil, errors.New("响应中没有可展示的余额条目")
	}
	return items, nil
}

func aiUsageParseOpenRouter(body []byte) ([]AIUsageItem, error) {
	data, err := aiUsageJSON(body)
	if err != nil {
		return nil, err
	}
	nested, _ := data["data"].(map[string]any)
	if nested == nil {
		return nil, errors.New("响应缺少 data 字段")
	}
	items := []AIUsageItem{}
	if total := aiUsageText(nested["total_credits"]); total != "" {
		items = append(items, AIUsageItem{Label: "已购额度", Value: "$" + total})
	}
	if used := aiUsageText(nested["total_usage"]); used != "" {
		items = append(items, AIUsageItem{Label: "已使用", Value: "$" + used})
	}
	if len(items) == 2 {
		remaining, err := strconv.ParseFloat(strings.TrimPrefix(items[0].Value, "$"), 64)
		usedNum, usedErr := strconv.ParseFloat(strings.TrimPrefix(items[1].Value, "$"), 64)
		if err == nil && usedErr == nil {
			items = append(items, AIUsageItem{Label: "剩余", Value: "$" + strconv.FormatFloat(remaining-usedNum, 'f', -1, 64)})
		}
	}
	return items, nil
}

func aiUsageParseSiliconFlow(body []byte) ([]AIUsageItem, error) {
	data, err := aiUsageJSON(body)
	if err != nil {
		return nil, err
	}
	nested, _ := data["data"].(map[string]any)
	if nested == nil {
		return nil, errors.New("响应缺少 data 字段")
	}
	items := []AIUsageItem{}
	if name := aiUsageText(nested["name"]); name != "" {
		items = append(items, AIUsageItem{Label: "账户", Value: name})
	}
	if total := aiUsageText(aiUsageLookup(nested, "totalBalance", "total_balance")); total != "" {
		items = append(items, AIUsageItem{Label: "总余额", Value: "¥" + total})
	}
	if balance := aiUsageText(nested["balance"]); balance != "" {
		items = append(items, AIUsageItem{Label: "可用余额", Value: "¥" + balance})
	}
	if charge := aiUsageText(aiUsageLookup(nested, "chargeBalance", "charge_balance")); charge != "" {
		items = append(items, AIUsageItem{Label: "充值余额", Value: "¥" + charge})
	}
	if len(items) == 0 {
		return nil, errors.New("响应中没有可展示的余额条目")
	}
	return items, nil
}
