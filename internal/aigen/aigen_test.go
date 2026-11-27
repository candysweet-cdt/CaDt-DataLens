// ai_gen_test.go：生图/视频执行通道测试——目录解析与越界拒绝、mime/扩展名、
// b64 解码嗅探、HTTP 规格请求（httptest 回环）、落盘流程与上限。
package aigen

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"datalens/internal/aitransport"
)

func TestAiGenResolveDir(t *testing.T) {
	ws := `D:\proj`
	// 缺省：.cadt/gen/{kind}/YYYY-MM
	dir, err := aiGenResolveDir(ws, "", "image")
	if err != nil {
		t.Fatalf("缺省目录解析失败：%v", err)
	}
	if !strings.Contains(dir, `.cadt`) || !strings.Contains(dir, `gen`) || !strings.Contains(dir, `image`) {
		t.Fatalf("缺省目录不含 .cadt/gen/image：%s", dir)
	}
	// output_path 覆盖（工作区相对）
	dir, err = aiGenResolveDir(ws, `assets\renders`, "video")
	if err != nil {
		t.Fatalf("output_path 解析失败：%v", err)
	}
	if !strings.HasSuffix(dir, `assets\renders`) {
		t.Fatalf("output_path 未生效：%s", dir)
	}
	// 绝对路径拒绝
	if _, err = aiGenResolveDir(ws, `D:\elsewhere`, "image"); err == nil {
		t.Fatal("绝对 output_path 应被拒绝")
	}
	// .. 逃逸拒绝
	if _, err = aiGenResolveDir(ws, `..\outside`, "image"); err == nil {
		t.Fatal(".. 逃逸 output_path 应被拒绝")
	}
	if _, err = aiGenResolveDir(ws, `a\..\..\..\outside`, "image"); err == nil {
		t.Fatal("Clean 后越出工作区应被拒绝")
	}
	// 空工作区拒绝
	if _, err = aiGenResolveDir("", "", "image"); err == nil {
		t.Fatal("空工作区应被拒绝")
	}
}

func TestAiGenExtForAndMIME(t *testing.T) {
	cases := []struct {
		mime, kind, want string
	}{
		{"image/png", "image", "png"},
		{"image/jpeg", "image", "jpg"},
		{"video/mp4", "video", "mp4"},
		{"video/x-msvideo", "video", "avi"},
		{"application/octet-stream", "image", "png"},
		{"application/octet-stream", "video", "mp4"},
		{"image/whatever", "video", "png"},
	}
	for _, c := range cases {
		if got := aiGenExtFor(c.mime, c.kind); got != c.want {
			t.Fatalf("aiGenExtFor(%q,%q)=%q，期望 %q", c.mime, c.kind, got, c.want)
		}
	}
	if got := aiGenNormalizeMIME("image/png; charset=binary"); got != "image/png" {
		t.Fatalf("mime 参数段未剥离：%q", got)
	}
	if got := aiGenNormalizeMIME(" IMAGE/PNG "); got != "image/png" {
		t.Fatalf("mime 未归一小写：%q", got)
	}
}

func TestAiGenClampTimeoutAndLimit(t *testing.T) {
	if aiGenClampTimeout(0) != aiGenMinTimeout || aiGenClampTimeout(99999) != aiGenMaxTimeout || aiGenClampTimeout(60) != 60 {
		t.Fatal("timeout clamp 不符")
	}
	if aiGenItemLimit("image") != aiGenImageLimit || aiGenItemLimit("video") != aiGenVideoLimit {
		t.Fatal("产物大小上限不符")
	}
	if aiGenItemLimit("weird") != aiGenImageLimit {
		t.Fatal("未知 kind 应回落 image 上限")
	}
}

func TestAiGenDecodeB64(t *testing.T) {
	// 1x1 PNG（8 字节签名字头可被 DetectContentType 识别）
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00}
	raw, productMIME, err := aiGenDecodeB64(ProductItem{Type: "b64", Data: base64.StdEncoding.EncodeToString(png)})
	if err != nil || len(raw) != len(png) {
		t.Fatalf("纯 b64 解码失败：%v", err)
	}
	if productMIME != "image/png" {
		t.Fatalf("嗅探 mime 不符：%q", productMIME)
	}
	// data URL 前缀容忍 + 显式 mime 优先
	raw2, productMIME2, err := aiGenDecodeB64(ProductItem{
		Type: "b64", MIME: "image/webp",
		Data: "data:image/webp;base64," + base64.StdEncoding.EncodeToString(png)})
	if err != nil || productMIME2 != "image/webp" {
		t.Fatalf("data URL 解码失败：mime=%q err=%v", productMIME2, err)
	}
	_ = raw2
	if _, _, err = aiGenDecodeB64(ProductItem{Type: "b64", Data: ""}); err == nil {
		t.Fatal("空 b64 应报错")
	}
	if _, _, err = aiGenDecodeB64(ProductItem{Type: "b64", Data: "!!not-b64!!"}); err == nil {
		t.Fatal("非法 b64 应报错")
	}
}

func TestAiGenRedactError(t *testing.T) {
	if got := aiGenRedactError("下载失败：GET https://x/api?api_key=sk-secret 失败"); !strings.Contains(got, "=***") || strings.Contains(got, "sk-secret") {
		t.Fatalf("密钥查询串未脱敏：%q", got)
	}
	if got := aiGenRedactError("普通错误"); got != "普通错误" {
		t.Fatalf("无 URL 错误被改动：%q", got)
	}
}

func TestAiGenDownloadErrorIncludesResponseHint(t *testing.T) {
	// 非 200 的产物下载要把服务端响应片段带进错误（实测「HTTP 400」其实是上游请求体问题，
	// 响应体里有线索）；片段压成单行、限长，且查询串密钥打码。
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"bad prompt at https://x/api?api_key=sk-secret"}}` + "\n\t noise"))
	}))
	defer server.Close()
	client, err := aitransport.NewHTTPClient(aitransport.Config{Proxy: "direct"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = aiGenDownloadURL(client, ProductItem{Type: "url", URL: server.URL + "/x"}, server.URL+"/gen", 30, 1<<20, nil)
	if err == nil {
		t.Fatal("非 200 应报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "HTTP 400") || !strings.Contains(msg, "服务端响应") || !strings.Contains(msg, "bad prompt") {
		t.Fatalf("错误应带状态码与响应片段：%q", msg)
	}
	if strings.Contains(msg, "sk-secret") || !strings.Contains(msg, "=***") {
		t.Fatalf("响应片段里的密钥查询串未打码：%q", msg)
	}
	if strings.Contains(msg, "\n") || strings.Contains(msg, "\t") {
		t.Fatalf("响应片段应压成单行：%q", msg)
	}
}

// 产物 URL 来自服务端响应，属不可信输入：跨 host 时必须是公网地址，
// 且不能带 userinfo；同 host 才允许（本地 ComfyUI / 局域网端点）。
func TestAiGenProductURLGuard(t *testing.T) {
	const endpoint = "https://api.example.com/v1/images/generations"
	cases := []struct {
		name     string
		url      string
		wantErr  bool
		sameHost bool
	}{
		{"同 host", "https://api.example.com/v1/files/a.png", false, true},
		{"同 host 不同端口", "https://api.example.com:8443/a.png", false, true},
		{"跨 host 公网 IP", "https://93.184.216.34/a.png", false, false},
		{"跨 host 环回", "http://127.0.0.1/a.png", true, false},
		{"跨 host 云元数据", "http://169.254.169.254/latest/meta-data/", true, false},
		{"跨 host 私网", "http://192.168.1.5/a.png", true, false},
		{"userinfo 伪装", "https://api.example.com@evil.example.org/a.png", true, false},
		{"非 http(s) 协议", "file:///etc/passwd", true, false},
		{"相对地址", "/a.png", true, false},
	}
	for _, tc := range cases {
		target, sameHost, err := aiGenCheckProductURL(tc.url, endpoint)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%s：应被拒，实际放行（target=%q）", tc.name, target)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s：不应报错：%v", tc.name, err)
		}
		if sameHost != tc.sameHost {
			t.Fatalf("%s：sameHost=%v，期望 %v", tc.name, sameHost, tc.sameHost)
		}
	}
}

func TestAiGenSnippet(t *testing.T) {
	if got := aiGenSnippet("  a\n\t b  "); got != "a b" {
		t.Fatalf("控制字符应压成单空格：%q", got)
	}
	long := strings.Repeat("x", 500)
	if got := aiGenSnippet(long); len(got) > 200 {
		t.Fatalf("片段应限长 200，实际 %d", len(got))
	}
}

func TestAiGenHTTPRequestRoundtrip(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"QQ=="}],"created":123}`))
	}))
	defer server.Close()

	spec := HTTPSpec{
		URL:    server.URL + "/v1/images/generations",
		Method: "POST",
		Headers: map[string]string{
			"Authorization": "Bearer sk-test",
			"Content-Type":  "application/json",
		},
		Body:       `{"prompt":"hi"}`,
		TimeoutSec: 10,
	}
	raw, _ := json.Marshal(spec)
	result := HTTPRequest(string(raw))
	if result.Error != "" {
		t.Fatalf("回环请求报错：%s", result.Error)
	}
	if result.Status != http.StatusOK || result.Truncated {
		t.Fatalf("状态不符：%+v", result)
	}
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal([]byte(result.Body), &parsed); err != nil || len(parsed.Data) != 1 {
		t.Fatalf("响应体解析失败：%v", err)
	}

	// 非 2xx 也回体（前端按 errorPath 提取）
	badSpec := spec
	badSpec.Headers = map[string]string{"Authorization": "Bearer wrong"}
	rawBad, _ := json.Marshal(badSpec)
	resultBad := HTTPRequest(string(rawBad))
	if resultBad.Status != http.StatusUnauthorized || !strings.Contains(resultBad.Body, "bad key") {
		t.Fatalf("非 2xx 应回状态与体：%+v", resultBad)
	}

	// 非法 scheme / 禁止头
	evil := HTTPRequest(`{"url":"file:///C:/Windows"}`)
	if evil.Error == "" {
		t.Fatal("file:// scheme 应被拒绝")
	}
	forbidden := HTTPSpec{URL: server.URL, Method: "GET", Headers: map[string]string{"Host": "evil"}}
	rawForbidden, _ := json.Marshal(forbidden)
	if got := HTTPRequest(string(rawForbidden)); !strings.Contains(got.Error, "不允许自定义请求头") {
		t.Fatalf("禁止头应被拒绝：%+v", got)
	}
}

func TestAiGenHTTPRequestBinaryBody(t *testing.T) {
	// multipart/form-data 的编辑端点：前端把整个 body base64 后交 Go 解码发送。
	// 服务端必须收到**原始字节**（含 0x89 这类非 UTF-8 值），Content-Type 的 boundary 原样保留。
	rawBody := []byte("--BND\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\n\r\n\x89PNG\r\n\x00\xff\r\n--BND--\r\n")
	var gotBody []byte
	var gotType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotType = r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"QQ=="}]}`))
	}))
	defer server.Close()

	spec := HTTPSpec{
		URL:        server.URL + "/v1/images/edits",
		Method:     "POST",
		Headers:    map[string]string{"Content-Type": "multipart/form-data; boundary=BND"},
		Body:       "should-be-ignored",
		BodyBase64: base64.StdEncoding.EncodeToString(rawBody),
		TimeoutSec: 10,
	}
	raw, _ := json.Marshal(spec)
	result := HTTPRequest(string(raw))
	if result.Error != "" {
		t.Fatalf("二进制 body 请求报错：%s", result.Error)
	}
	if !bytes.Equal(gotBody, rawBody) {
		t.Fatalf("服务端收到的字节与原文不一致：\n got=%q\nwant=%q", gotBody, rawBody)
	}
	if gotType != "multipart/form-data; boundary=BND" {
		t.Fatalf("Content-Type 被改动：%q", gotType)
	}
	if spec.Body != "should-be-ignored" {
		t.Fatal("Body 字段不应被改动")
	}

	// 非法 base64 应报错而不是发空体
	bad, _ := json.Marshal(HTTPSpec{URL: server.URL, Method: "POST", BodyBase64: "!!not-b64!!", TimeoutSec: 10})
	if got := HTTPRequest(string(bad)); !strings.Contains(got.Error, "base64") {
		t.Fatalf("非法 base64 应报错：%+v", got)
	}
}

func TestAiGenSaveProductsFlow(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x01, 0x02}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer server.Close()
	workspace := t.TempDir()
	spec := SaveSpec{
		Workspace: workspace,
		Kind:      "image",
		Endpoint:  server.URL + "/v1/images/generations",
		Items: []ProductItem{
			{Type: "b64", Data: base64.StdEncoding.EncodeToString(png)},
			{Type: "url", URL: server.URL + "/out.png"},
		},
	}
	raw, _ := json.Marshal(spec)
	result := SaveProducts(string(raw))
	if result.Error != "" {
		t.Fatalf("落盘失败：%s", result.Error)
	}
	if len(result.Files) != 2 {
		t.Fatalf("产物数量不符：%d", len(result.Files))
	}
	for _, file := range result.Files {
		if !strings.HasPrefix(strings.ToLower(file.Path), strings.ToLower(workspace)) {
			t.Fatalf("产物越出工作区：%s", file.Path)
		}
		if !strings.HasSuffix(file.Path, ".png") {
			t.Fatalf("扩展名不符：%s", file.Path)
		}
		if file.MIME != "image/png" || file.Bytes != int64(len(png)) {
			t.Fatalf("产物元数据不符：%+v", file)
		}
	}
	// output_path 覆盖目录
	spec2 := spec
	spec2.OutputPath = filepath.Join("assets", "renders")
	raw2, _ := json.Marshal(spec2)
	result2 := SaveProducts(string(raw2))
	if result2.Error != "" || !strings.Contains(result2.Files[0].Path, "assets") {
		t.Fatalf("output_path 覆盖失败：%+v", result2)
	}
	// 逃逸拒绝
	spec3 := spec
	spec3.OutputPath = "..\\escape"
	raw3, _ := json.Marshal(spec3)
	if got := SaveProducts(string(raw3)); got.Error == "" {
		t.Fatal(".. 逃逸 output_path 应被拒绝")
	}
	// 空产物 / 超量
	if got := SaveProducts(`{"workspace":"x","kind":"image","items":[]}`); got.Error == "" {
		t.Fatal("空产物清单应报错")
	}
	many := `{"workspace":"x","kind":"image","items":[`
	for i := 0; i < 20; i++ {
		if i > 0 {
			many += ","
		}
		many += `{"type":"b64","data":"QQ=="}`
	}
	many += `]}`
	if got := SaveProducts(many); got.Error == "" {
		t.Fatal("产物超量应报错")
	}
}

func TestAiGenSaveProductsHeaders(t *testing.T) {
	// 产物端点需要鉴权：下载必须带上条目配置的头，否则 401。同时禁止头（Host 等）要被挡掉。
	mp4 := []byte("fake-mp4-bytes")
	var sawAuth, sawUA, sawHost string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawUA = r.Header.Get("User-Agent")
		sawHost = r.Host // 前端传的 Host 若被透传会覆盖真实 Host
		if sawAuth != "Bearer sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(mp4)
	}))
	defer server.Close()

	workspace := t.TempDir()
	spec := SaveSpec{
		Workspace: workspace,
		Kind:      "video",
		Endpoint:  server.URL + "/v1/videos",
		Headers: map[string]string{
			"Authorization": "Bearer sk-test",
			"Host":          "evil.example.com",
			"X-Custom":      "1",
		},
		Items: []ProductItem{{Type: "url", URL: server.URL + "/v1/videos/abc/content"}},
	}
	raw, _ := json.Marshal(spec)
	result := SaveProducts(string(raw))
	if result.Error != "" {
		t.Fatalf("带鉴权头的下载失败：%s", result.Error)
	}
	if len(result.Files) != 1 || result.Files[0].Bytes != int64(len(mp4)) {
		t.Fatalf("产物不符：%+v", result.Files)
	}
	if !strings.HasSuffix(result.Files[0].Path, ".mp4") {
		t.Fatalf("扩展名应为 mp4：%s", result.Files[0].Path)
	}
	if sawAuth != "Bearer sk-test" {
		t.Fatalf("Authorization 未透传：%q", sawAuth)
	}
	if sawUA == "" || !strings.Contains(sawUA, "CaDt-DataLens") {
		t.Fatalf("User-Agent 应保留：%q", sawUA)
	}
	if strings.Contains(sawHost, "evil") {
		t.Fatalf("禁止头 Host 被透传了：%q", sawHost)
	}

	// 不带头的下载仍应照常工作（回归：b64 与无鉴权 url 不受影响）
	spec2 := spec
	spec2.Headers = nil
	raw2, _ := json.Marshal(spec2)
	if got := SaveProducts(string(raw2)); got.Error == "" {
		t.Fatal("服务端要求鉴权时无头下载应失败（401）")
	}
}
