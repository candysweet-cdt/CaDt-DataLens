package main

import (
	"context"
	"net"
	"os"
	"strings"
	"testing"
)

func TestWebIsPublicIP(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"1.1.1.1", true},
		{"172.32.0.1", true},
		{"100.128.1.1", true},
		{"2606:4700:4700::1111", true},
		{"127.0.0.1", false},
		{"10.1.2.3", false},
		{"172.16.0.1", false},
		{"192.168.1.1", false},
		{"169.254.1.1", false},
		{"100.64.1.1", false},
		{"198.18.0.1", false},
		{"203.0.113.1", false},
		{"240.0.0.1", false},
		{"0.0.0.0", false},
		{"::1", false},
		{"fc00::1", false},
		{"2001:db8::1", false},
	}
	for _, tt := range tests {
		ip := net.ParseIP(tt.ip)
		if got := webIsPublicIP(ip); got != tt.want {
			t.Fatalf("webIsPublicIP(%s) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

func TestWebValidateURL(t *testing.T) {
	tests := []struct {
		raw     string
		wantErr bool
	}{
		{"https://8.8.8.8/x", false},
		{"http://1.1.1.1/", false},
		{"http://127.0.0.1/", true},
		{"http://localhost:8080/", true},
		{"http://foo.local/", true},
		{"https://[::1]/", true},
		{"ftp://8.8.8.8/", true},
		{"file:///C:/Windows/win.ini", true},
		{"https://user:pass@8.8.8.8/", true},
		{"", true},
	}
	for _, tt := range tests {
		_, err := webValidateURL(context.Background(), tt.raw)
		if (err != nil) != tt.wantErr {
			t.Fatalf("webValidateURL(%q) err = %v, wantErr %v", tt.raw, err, tt.wantErr)
		}
	}
}

func TestWebParseBingRSS(t *testing.T) {
	raw := `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>必应：wails</title>
<item>
  <title>Wails &amp; Go</title>
  <link>https://wails.io/zh-Hans/</link>
  <description><![CDATA[<p>Hello <b>Wails</b></p><script>bad()</script>]]></description>
  <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
</item>
<item>
  <title>非法链接</title>
  <link>javascript:alert(1)</link>
  <description>x</description>
</item>
</channel></rss>`
	results, err := webParseBingRSS([]byte(raw), 10)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1: %+v", len(results), results)
	}
	got := results[0]
	if got["title"] != "Wails & Go" {
		t.Fatalf("title = %q", got["title"])
	}
	if got["url"] != "https://wails.io/zh-Hans/" {
		t.Fatalf("url = %q", got["url"])
	}
	if strings.Contains(got["snippet"], "bad()") || !strings.Contains(got["snippet"], "Hello Wails") {
		t.Fatalf("snippet = %q", got["snippet"])
	}
}

func TestWebExtractHTML(t *testing.T) {
	page := `<html><head><title>测试 &amp; 页面</title><meta charset="gbk"></head>
<body><nav>导航菜单</nav><h1>标题</h1>
<p>正文&nbsp;内容 <a href="/docs/a.html">文档A</a></p>
<script>alert(1)</script><footer>页脚</footer></body></html>`
	title, text, links := webExtractHTML(page, "https://example.com/page.html")
	if title != "测试 & 页面" {
		t.Fatalf("title = %q", title)
	}
	if !strings.Contains(text, "标题") || !strings.Contains(text, "正文 内容") {
		t.Fatalf("text = %q", text)
	}
	if strings.Contains(text, "导航菜单") || strings.Contains(text, "alert(1)") {
		t.Fatalf("text contains dropped block: %q", text)
	}
	if len(links) != 1 {
		t.Fatalf("links = %+v", links)
	}
	if links[0]["url"] != "https://example.com/docs/a.html" || links[0]["text"] != "文档A" {
		t.Fatalf("link = %+v", links[0])
	}
}

func TestWebSniffCharset(t *testing.T) {
	raw := []byte(`<html><head><meta charset="gb2312"><title>x</title></head></html>`)
	if got := webSniffCharset(raw); got != "gbk" {
		t.Fatalf("webSniffCharset = %q, want gbk", got)
	}
	if got := webSniffCharset([]byte(`<html><head></head></html>`)); got != "" {
		t.Fatalf("webSniffCharset = %q, want empty", got)
	}
}

func TestWebNormalizeCharset(t *testing.T) {
	tests := map[string]string{
		"gb2312":     "gbk",
		"GBK":        "gbk",
		"utf8":       "utf-8",
		"GB18030":    "gb18030",
		"latin1":     "iso-8859-1",
		"ascii":      "us-ascii",
		"shift_jis":  "",
		"   UTF-8  ": "utf-8",
	}
	for in, want := range tests {
		if got := webNormalizeCharset(in); got != want {
			t.Fatalf("webNormalizeCharset(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWebTruncateRunes(t *testing.T) {
	text := "时空纪元"
	got, truncated := webTruncateRunes(text, 2)
	if got != "时空" || !truncated {
		t.Fatalf("got %q truncated=%v", got, truncated)
	}
	got, truncated = webTruncateRunes(text, 10)
	if got != text || truncated {
		t.Fatalf("got %q truncated=%v", got, truncated)
	}
}

func TestWebSearchNetwork(t *testing.T) {
	if os.Getenv("CADT_WEB_TEST") != "1" {
		t.Skip("设置 CADT_WEB_TEST=1 运行联网测试")
	}
	app := &App{}
	got, err := app.WebSearch("Wails v2", 3)
	if err != nil {
		t.Fatalf("web search failed: %v", err)
	}
	results, ok := got["results"].([]map[string]string)
	if !ok || len(results) == 0 {
		t.Fatalf("no results: %+v", got)
	}
	for _, item := range results {
		if !strings.HasPrefix(item["url"], "http") || item["title"] == "" {
			t.Fatalf("bad result: %+v", item)
		}
	}
}

func TestWebFetchNetwork(t *testing.T) {
	if os.Getenv("CADT_WEB_TEST") != "1" {
		t.Skip("设置 CADT_WEB_TEST=1 运行联网测试")
	}
	app := &App{}
	got, err := app.WebFetch("https://example.com/", 4000)
	if err != nil {
		t.Fatalf("web fetch failed: %v", err)
	}
	text, _ := got["text"].(string)
	title, _ := got["title"].(string)
	combined := strings.ToLower(text + " " + title)
	if !strings.Contains(combined, "example domain") && !strings.Contains(combined, "documentation examples") {
		t.Fatalf("unexpected text: %q title: %q", text, title)
	}
	if got["status"].(int) != 200 {
		t.Fatalf("status = %v", got["status"])
	}
}
