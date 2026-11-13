package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIUsageEndpointFor(t *testing.T) {
	cases := []struct {
		baseURL string
		name    string
	}{
		{"https://api.deepseek.com/v1", "DeepSeek"},
		{"https://api.deepseek.com", "DeepSeek"},
		{"http://api.deepseek.com:443", "DeepSeek"},
		{"https://openrouter.ai/api/v1", "OpenRouter"},
		{"https://api.siliconflow.cn/v1", "SiliconFlow"},
		{"", ""},
		{"https://api.example.com/v1", ""},
		{"https://localhost:11434/v1", ""},
	}
	for _, c := range cases {
		endpoint := aiUsageEndpointFor(c.baseURL)
		got := ""
		if endpoint != nil {
			got = endpoint.name
		}
		if got != c.name {
			t.Fatalf("aiUsageEndpointFor(%q) = %q, want %q", c.baseURL, got, c.name)
		}
	}
}

func aiUsageMockServer(t *testing.T, status int, path string, response string, gotAuth *string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gotAuth != nil {
			*gotAuth = r.Header.Get("Authorization")
		}
		if r.URL.Path != path {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(response))
	}))
	t.Cleanup(server.Close)
	return server
}

// withTestUsageEndpoint 注册一个指向 mock 服务器的临时端点（host=deepseek.test），
// 复用生产解析函数验证完整请求链路；测试结束恢复端点表。
func withTestUsageEndpoint(t *testing.T, server *httptest.Server, path string) {
	t.Helper()
	saved := aiUsageEndpoints
	aiUsageEndpoints = append([]aiUsageEndpoint{{
		name:  "DeepSeek",
		hosts: []string{"deepseek.test"},
		build: func(string) string { return server.URL + path },
		parse: aiUsageParseDeepSeek,
	}}, aiUsageEndpoints...)
	t.Cleanup(func() { aiUsageEndpoints = saved })
}

func TestAIUsageQueryDeepSeek(t *testing.T) {
	var gotAuth string
	server := aiUsageMockServer(t, http.StatusOK, "/user/balance",
		`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"2.00","topped_up_balance":"108.00"}]}`,
		&gotAuth)
	withTestUsageEndpoint(t, server, "/user/balance")
	cfg := AIConfig{BaseURL: "https://deepseek.test/v1", APIKey: "sk-test"}
	result := aiUsageQuery(cfg)
	if !result.Supported || result.Error != "" {
		t.Fatalf("query error = %q", result.Error)
	}
	if result.Provider != "DeepSeek" {
		t.Fatalf("provider = %q", result.Provider)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	joined := ""
	for _, item := range result.Items {
		joined += item.Label + "=" + item.Value + "\n"
	}
	for _, want := range []string{"总额余额（CNY）=110.00", "赠送余额（CNY）=2.00", "账户可用=是"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("items 缺少 %q：\n%s", want, joined)
		}
	}
}

func TestAIUsageQueryOpenRouterParse(t *testing.T) {
	items, err := aiUsageParseOpenRouter([]byte(`{"data":{"total_credits":10,"total_usage":2.5}}`))
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, item := range items {
		joined += item.Label + "=" + item.Value + "\n"
	}
	for _, want := range []string{"已购额度=$10", "已使用=$2.5", "剩余=$7.5"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("items 缺少 %q：\n%s", want, joined)
		}
	}
}

func TestAIUsageQuerySiliconFlowParse(t *testing.T) {
	items, err := aiUsageParseSiliconFlow([]byte(`{"code":200,"data":{"name":"tester","balance":"1.5","chargeBalance":"3.2","totalBalance":"4.7"}}`))
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, item := range items {
		joined += item.Label + "=" + item.Value + "\n"
	}
	for _, want := range []string{"账户=tester", "总余额=¥4.7", "可用余额=¥1.5"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("items 缺少 %q：\n%s", want, joined)
		}
	}
}

func TestAIUsageQueryErrors(t *testing.T) {
	// 不支持的服务商
	result := aiUsageQuery(AIConfig{BaseURL: "https://api.example.com/v1", APIKey: "k"})
	if result.Supported {
		t.Fatalf("不支持的服务商应返回 Supported=false")
	}
	// 缺少 Key
	result = aiUsageQuery(AIConfig{BaseURL: "https://api.deepseek.com", APIKey: ""})
	if !result.Supported || result.Error == "" {
		t.Fatalf("缺少 Key 应返回提示，得到 %+v", result)
	}
	// HTTP 错误码
	server := aiUsageMockServer(t, http.StatusUnauthorized, "/user/balance", `{"error":{"message":"invalid key"}}`, nil)
	withTestUsageEndpoint(t, server, "/user/balance")
	result = aiUsageQuery(AIConfig{BaseURL: "https://deepseek.test", APIKey: "bad"})
	if !result.Supported || !strings.Contains(result.Error, "HTTP 401") {
		t.Fatalf("401 应进入 Error，得到 %+v", result)
	}
	// 响应缺字段
	server2 := aiUsageMockServer(t, http.StatusOK, "/user/balance", `{"is_available":true}`, nil)
	withTestUsageEndpoint(t, server2, "/user/balance")
	result = aiUsageQuery(AIConfig{BaseURL: "https://deepseek.test", APIKey: "k"})
	if !strings.Contains(result.Error, "balance_infos") {
		t.Fatalf("缺字段应报解析错误，得到 %+v", result)
	}
}

func TestAIUsageParseItemsJSON(t *testing.T) {
	// AIUsageResult 序列化字段与前端弹层约定一致
	payload, err := json.Marshal(AIUsageResult{
		Supported: true,
		Provider:  "DeepSeek",
		Items:     []AIUsageItem{{Label: "总额余额（CNY）", Value: "110.00"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var round AIUsageResult
	if err := json.Unmarshal(payload, &round); err != nil {
		t.Fatal(err)
	}
	if !round.Supported || round.Provider != "DeepSeek" || len(round.Items) != 1 || round.Items[0].Label != "总额余额（CNY）" {
		t.Fatalf("round-trip 结果异常：%+v", round)
	}
}
