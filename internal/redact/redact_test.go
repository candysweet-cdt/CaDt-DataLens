package redact

import (
	"strings"
	"testing"
)

func TestSecretsRedactsCommonLeaks(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string // 必须消失的片段
		keep string   // 必须保留的片段
	}{
		{
			name: "查询串密钥",
			in:   "请求失败：GET https://x/api?api_key=sk-live-123456",
			want: []string{"sk-live-123456"},
			keep: "api_key=***",
		},
		{
			name: "Authorization Bearer 回显",
			in:   `{"error":"bad request","authorization":"Bearer abcdef123456"}`,
			want: []string{"abcdef123456"},
			keep: "Bearer ***",
		},
		{
			name: "x-api-key 回显",
			in:   `x-api-key: sk-ant-api03-zzzzzzzz`,
			want: []string{"sk-ant-api03-zzzzzzzz"},
			keep: "x-api-key",
		},
		{
			name: "裸 sk- 前缀",
			in:   "invalid key sk-proj-abcdef123456 for model",
			want: []string{"sk-proj-abcdef123456"},
			keep: "invalid key",
		},
	}
	for _, tc := range cases {
		got := Secrets(tc.in)
		for _, secret := range tc.want {
			if strings.Contains(got, secret) {
				t.Fatalf("%s：凭据未脱敏：%q", tc.name, got)
			}
		}
		if tc.keep != "" && !strings.Contains(got, tc.keep) {
			t.Fatalf("%s：应保留 %q，实际 %q", tc.name, tc.keep, got)
		}
	}
}

func TestSecretsLeavesPlainTextAlone(t *testing.T) {
	const plain = "HTTP 400：参数 model 不支持"
	if got := Secrets(plain); got != plain {
		t.Fatalf("无凭据文本不应改动：%q", got)
	}
	if got := Secrets(""); got != "" {
		t.Fatalf("空串应原样返回：%q", got)
	}
}
