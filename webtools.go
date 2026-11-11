package main

// 联网工具：Bing RSS 搜索 + 公开网页抓取（转纯文本与链接）。
// 只允许 http/https 公网地址；不执行页面脚本，结果仅供模型阅读。

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	webSearchDefaultResults = 8
	webSearchMaxResults     = 10
	webSearchMaxQueryRunes  = 500
	webSearchMaxBytes       = 1 << 20
	webFetchDefaultChars    = 12000
	webFetchMaxChars        = 60000
	webFetchMaxBytes        = 4 << 20
	webRequestTimeout       = 25 * time.Second
	webMaxRedirects         = 6
	webMaxLinks             = 40
	webUserAgent            = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

var (
	webReComment    = regexp.MustCompile(`(?s)<!--.*?-->`)
	webReDropBlocks = []*regexp.Regexp{
		regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script\s*>`),
		regexp.MustCompile(`(?is)<style\b[^>]*>.*?</style\s*>`),
		regexp.MustCompile(`(?is)<noscript\b[^>]*>.*?</noscript\s*>`),
		regexp.MustCompile(`(?is)<template\b[^>]*>.*?</template\s*>`),
		regexp.MustCompile(`(?is)<svg\b[^>]*>.*?</svg\s*>`),
		regexp.MustCompile(`(?is)<head\b[^>]*>.*?</head\s*>`),
		regexp.MustCompile(`(?is)<nav\b[^>]*>.*?</nav\s*>`),
		regexp.MustCompile(`(?is)<aside\b[^>]*>.*?</aside\s*>`),
		regexp.MustCompile(`(?is)<iframe\b[^>]*>.*?</iframe\s*>`),
		regexp.MustCompile(`(?is)<object\b[^>]*>.*?</object\s*>`),
		regexp.MustCompile(`(?is)<canvas\b[^>]*>.*?</canvas\s*>`),
	}
	webReBr         = regexp.MustCompile(`(?is)<br\s*/?>`)
	webReBlockClose = regexp.MustCompile(`(?is)</(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>`)
	webReCellClose  = regexp.MustCompile(`(?is)</t[dh]\s*>`)
	webReLiOpen     = regexp.MustCompile(`(?is)<li\b[^>]*>`)
	webReTrOpen     = regexp.MustCompile(`(?is)<tr\b[^>]*>`)
	webReHeadOpen   = regexp.MustCompile(`(?is)<h[1-6]\b[^>]*>`)
	webReTag        = regexp.MustCompile(`(?s)<[^>]+>`)
	webReTitle      = regexp.MustCompile(`(?is)<title\b[^>]*>(.*?)</title\s*>`)
	webReAnchor     = regexp.MustCompile(`(?is)<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>(.*?)</a\s*>`)
	webReSpaces     = regexp.MustCompile(`[ \t\f\v\x{00a0}]+`)
	webReMetaChars  = regexp.MustCompile(`(?is)<meta\b[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)`)
)

type webResponse struct {
	Body        []byte
	FinalURL    string
	Status      int
	ContentType string
	Truncated   bool
}

// WebSearch 用 Bing RSS 搜索公开网页，返回标题、链接、摘要与日期。
func (a *App) WebSearch(query string, maxResults int) (map[string]interface{}, error) {
	started := time.Now()
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, errors.New("搜索词为空")
	}
	if utf8.RuneCountInString(q) > webSearchMaxQueryRunes {
		return nil, fmt.Errorf("搜索词过长（最多 %d 字）", webSearchMaxQueryRunes)
	}
	n := maxResults
	if n <= 0 {
		n = webSearchDefaultResults
	}
	if n > webSearchMaxResults {
		n = webSearchMaxResults
	}
	endpoint := "https://www.bing.com/search?format=rss&count=" + strconv.Itoa(n) + "&q=" + url.QueryEscape(q)
	resp, err := webRequest(endpoint, webSearchMaxBytes, "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5")
	if err != nil {
		return nil, err
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return nil, fmt.Errorf("搜索服务返回 HTTP %d", resp.Status)
	}
	results, err := webParseBingRSS(resp.Body, n)
	if err != nil {
		return nil, fmt.Errorf("搜索结果解析失败：%w", err)
	}
	return map[string]interface{}{
		"query":     q,
		"engine":    "bing",
		"endpoint":  resp.FinalURL,
		"results":   results,
		"elapsedMs": time.Since(started).Milliseconds(),
	}, nil
}

// WebFetch 抓取一个公开网页并返回标题、正文纯文本与页面链接。
func (a *App) WebFetch(rawURL string, maxChars int) (map[string]interface{}, error) {
	started := time.Now()
	limit := maxChars
	if limit <= 0 {
		limit = webFetchDefaultChars
	}
	if limit > webFetchMaxChars {
		limit = webFetchMaxChars
	}
	resp, err := webRequest(rawURL, webFetchMaxBytes, "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5")
	if err != nil {
		return nil, err
	}
	if resp.Status < 200 || resp.Status >= 400 {
		return nil, fmt.Errorf("抓取失败：HTTP %d", resp.Status)
	}
	contentType := resp.ContentType
	mediaType, params, parseErr := mime.ParseMediaType(contentType)
	if parseErr != nil || mediaType == "" || mediaType == "application/octet-stream" {
		mediaType, params, _ = mime.ParseMediaType(http.DetectContentType(resp.Body))
	}
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	isText := strings.HasPrefix(mediaType, "text/") ||
		strings.Contains(mediaType, "json") ||
		strings.Contains(mediaType, "xml") ||
		mediaType == "application/javascript" ||
		mediaType == "application/x-javascript"
	if !isText {
		return nil, fmt.Errorf("该地址返回 %s，web_fetch 只支持 HTML / 文本 / JSON / XML", mediaType)
	}
	charset := webNormalizeCharset(params["charset"])
	if charset == "" {
		charset = webSniffCharset(resp.Body)
	}
	body, usedEnc, decodeErr := decodeBytes(resp.Body, charset)
	if decodeErr != nil || body == "" {
		body = string(resp.Body)
		usedEnc = "utf-8"
	}
	title := ""
	text := body
	links := []map[string]string{}
	if strings.Contains(mediaType, "html") {
		title, text, links = webExtractHTML(body, resp.FinalURL)
	} else {
		text = strings.ReplaceAll(text, "\r\n", "\n")
		text = strings.ReplaceAll(text, "\r", "\n")
		text = strings.TrimSpace(text)
		if pu, parseErr := url.Parse(resp.FinalURL); parseErr == nil {
			title = path.Base(pu.Path)
			if title == "." || title == "/" {
				title = ""
			}
		}
	}
	text, textTruncated := webTruncateRunes(text, limit)
	title = webTruncateRunesOnly(webCleanInline(title), 200)
	return map[string]interface{}{
		"url":         rawURL,
		"finalUrl":    resp.FinalURL,
		"status":      resp.Status,
		"contentType": mediaType,
		"charset":     usedEnc,
		"title":       title,
		"text":        text,
		"links":       links,
		"truncated":   resp.Truncated || textTruncated,
		"bytes":       len(resp.Body),
		"elapsedMs":   time.Since(started).Milliseconds(),
	}, nil
}

func webClient() *http.Client {
	return &http.Client{
		Timeout: webRequestTimeout,
		Transport: &http.Transport{
			Proxy:                 systemAIProxy(),
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 15 * time.Second,
			IdleConnTimeout:       30 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= webMaxRedirects {
				return errors.New("重定向次数过多")
			}
			if _, err := webValidateURL(req.Context(), req.URL.String()); err != nil {
				return err
			}
			return nil
		},
	}
}

func webRequest(rawURL string, maxBytes int64, accept string) (*webResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), webRequestTimeout)
	defer cancel()
	u, err := webValidateURL(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("请求创建失败：%w", err)
	}
	req.Header.Set("User-Agent", webUserAgent)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	resp, err := webClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求失败：%w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败：%w", err)
	}
	truncated := int64(len(body)) > maxBytes
	if truncated {
		body = body[:maxBytes]
	}
	finalURL := u.String()
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	return &webResponse{
		Body:        body,
		FinalURL:    finalURL,
		Status:      resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
		Truncated:   truncated,
	}, nil
}

func webValidateURL(ctx context.Context, raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("URL 为空")
	}
	if len(raw) > 4096 {
		return nil, errors.New("URL 过长")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("URL 无效：%w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("只支持 http/https 地址")
	}
	if u.User != nil {
		return nil, errors.New("URL 不能包含账号密码")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return nil, errors.New("URL 缺少主机名")
	}
	if ip := net.ParseIP(host); ip != nil {
		if !webIsPublicIP(ip) {
			return nil, errors.New("只允许访问公网地址")
		}
		return u, nil
	}
	if webBlockedHost(host) {
		return nil, errors.New("只允许访问公网地址")
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(lookupCtx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("域名解析失败：%w", err)
	}
	if len(ips) == 0 {
		return nil, errors.New("域名没有可用地址")
	}
	for _, ip := range ips {
		if !webIsPublicIP(ip) {
			return nil, fmt.Errorf("只允许访问公网地址（%s 解析到内网或保留地址）", host)
		}
	}
	return u, nil
}

func webBlockedHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	return host == "localhost" ||
		host == "metadata.google.internal" ||
		strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal")
}

func webIsPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 0:
			return false
		case v4[0] == 100 && v4[1]&0xC0 == 64: // 100.64.0.0/10
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0: // 192.0.0.0/24
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 2: // 192.0.2.0/24
			return false
		case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19): // 198.18.0.0/15
			return false
		case v4[0] == 198 && v4[1] == 51 && v4[2] == 100: // 198.51.100.0/24
			return false
		case v4[0] == 203 && v4[1] == 0 && v4[2] == 113: // 203.0.113.0/24
			return false
		case v4[0] >= 240:
			return false
		}
		return true
	}
	if len(ip) == net.IPv6len && ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x0d && ip[3] == 0xb8 {
		return false // 2001:db8::/32
	}
	return true
}

func webParseBingRSS(raw []byte, limit int) ([]map[string]string, error) {
	var feed struct {
		Channel struct {
			Items []struct {
				Title       string `xml:"title"`
				Link        string `xml:"link"`
				Description string `xml:"description"`
				PubDate     string `xml:"pubDate"`
			} `xml:"item"`
		} `xml:"channel"`
	}
	if err := xml.Unmarshal(raw, &feed); err != nil {
		return nil, err
	}
	results := make([]map[string]string, 0, len(feed.Channel.Items))
	for _, item := range feed.Channel.Items {
		link := strings.TrimSpace(item.Link)
		if !strings.HasPrefix(link, "http://") && !strings.HasPrefix(link, "https://") {
			continue
		}
		snippet := webCleanInline(webStripHTMLBlocks(item.Description))
		snippet = strings.Join(strings.Fields(snippet), " ")
		snippet = webTruncateRunesOnly(snippet, 320)
		results = append(results, map[string]string{
			"title":     webTruncateRunesOnly(webCleanInline(item.Title), 200),
			"url":       link,
			"snippet":   snippet,
			"published": webCleanInline(item.PubDate),
		})
		if len(results) >= limit {
			break
		}
	}
	return results, nil
}

func webExtractHTML(page, pageURL string) (string, string, []map[string]string) {
	title := ""
	if m := webReTitle.FindStringSubmatch(page); len(m) > 1 {
		title = webCleanInline(m[1])
	}
	links := webExtractLinks(page, pageURL)
	return title, webStripHTMLBlocks(page), links
}

func webExtractLinks(page, pageURL string) []map[string]string {
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	links := make([]map[string]string, 0, 16)
	for _, m := range webReAnchor.FindAllStringSubmatch(page, 160) {
		href := ""
		for _, idx := range []int{2, 3, 4} {
			if len(m) > idx && m[idx] != "" {
				href = m[idx]
				break
			}
		}
		href = html.UnescapeString(strings.TrimSpace(href))
		lower := strings.ToLower(href)
		if href == "" || strings.HasPrefix(href, "#") ||
			strings.HasPrefix(lower, "javascript:") ||
			strings.HasPrefix(lower, "mailto:") ||
			strings.HasPrefix(lower, "tel:") {
			continue
		}
		ref, err := base.Parse(href)
		if err != nil || (ref.Scheme != "http" && ref.Scheme != "https") {
			continue
		}
		ref.Fragment = ""
		abs := ref.String()
		if seen[abs] {
			continue
		}
		text := ""
		if len(m) > 5 {
			text = webTruncateRunesOnly(webCleanInline(m[5]), 120)
		}
		if text == "" {
			continue
		}
		seen[abs] = true
		links = append(links, map[string]string{"text": text, "url": abs})
		if len(links) >= webMaxLinks {
			break
		}
	}
	return links
}

func webStripHTMLBlocks(page string) string {
	s := webReComment.ReplaceAllString(page, " ")
	for _, re := range webReDropBlocks {
		s = re.ReplaceAllString(s, " ")
	}
	s = webReBr.ReplaceAllString(s, "\n")
	s = webReBlockClose.ReplaceAllString(s, "\n")
	s = webReCellClose.ReplaceAllString(s, " | ")
	s = webReLiOpen.ReplaceAllString(s, "\n- ")
	s = webReTrOpen.ReplaceAllString(s, "\n")
	s = webReHeadOpen.ReplaceAllString(s, "\n")
	s = webReTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return webNormalizeText(s)
}

func webNormalizeText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := false
	for _, line := range lines {
		line = strings.TrimSpace(webReSpaces.ReplaceAllString(line, " "))
		line = strings.Trim(line, "| ")
		if line == "" || line == "-" || line == "•" || line == "|" {
			if len(out) > 0 && !blank {
				out = append(out, "")
				blank = true
			}
			continue
		}
		out = append(out, line)
		blank = false
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}

func webCleanInline(s string) string {
	s = webReTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = webReSpaces.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func webSniffCharset(raw []byte) string {
	head := raw
	if len(head) > 4096 {
		head = head[:4096]
	}
	if m := webReMetaChars.FindSubmatch(head); len(m) > 1 {
		return webNormalizeCharset(string(m[1]))
	}
	return ""
}

func webNormalizeCharset(cs string) string {
	switch strings.ToLower(strings.TrimSpace(cs)) {
	case "gb2312", "gbk", "x-gbk":
		return "gbk"
	case "gb18030":
		return "gb18030"
	case "utf-8", "utf8":
		return "utf-8"
	case "iso-8859-1", "latin1", "latin-1":
		return "iso-8859-1"
	case "us-ascii", "ascii":
		return "us-ascii"
	}
	return ""
}

func webTruncateRunes(s string, max int) (string, bool) {
	if max <= 0 {
		return "", len(s) > 0
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s, false
	}
	return string(runes[:max]), true
}

func webTruncateRunesOnly(s string, max int) string {
	out, _ := webTruncateRunes(s, max)
	return out
}
