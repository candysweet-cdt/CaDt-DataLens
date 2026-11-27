// Package webtools：联网工具引擎——Bing RSS 搜索 + 公开网页抓取（转纯文本与链接），
// 只允许 http/https 公网地址，不执行页面脚本。
package webtools

import (
	"context"
	"encoding/base64"
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
	"unicode"
	"unicode/utf8"

	"datalens/internal/aitransport"
	"datalens/internal/chardec"
	"datalens/internal/netguard"
)

const (
	webSearchDefaultResults = 8
	webSearchMaxResults     = 10
	webSearchMaxQueryRunes  = 500
	webSearchMaxBytes       = 1 << 20
	webFetchDefaultChars    = 12000
	webFetchMaxChars        = 60000
	webFetchMaxBytes        = 4 << 20
	// 图片单独一档上限：网页 4 MB 是按文本估的，常见照片 3–8 MB 会被误判成「截断」。
	webImageMaxBytes  = 16 << 20
	webRequestTimeout = 25 * time.Second
	webMaxRedirects   = 6
	webMaxLinks       = 40
	webUserAgent      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
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
		regexp.MustCompile(`(?is)<footer\b[^>]*>.*?</footer\s*>`),
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
	webReClassAttr  = regexp.MustCompile(`(?is)\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))|\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))`)
	webReRoleMain   = regexp.MustCompile(`(?i)\brole\s*=\s*("main"|'main'|main\b)`)
	webReHOpen      = regexp.MustCompile(`(?is)<h([1-6])\b[^>]*>`)
	webReInlineBold   = regexp.MustCompile(`(?is)<(?:strong|b)\b[^>]*>([^<]*)</(?:strong|b)\s*>`)
	webReInlineItalic = regexp.MustCompile(`(?is)<(?:em|i)\b[^>]*>([^<]*)</(?:em|i)\s*>`)
	webReInlineCode   = regexp.MustCompile(`(?is)<code\b[^>]*>([^<]*)</code\s*>`)
	webRePreBlock     = regexp.MustCompile(`(?is)<pre\b[^>]*>(.*?)</pre\s*>`)
	webReImgTag       = regexp.MustCompile(`(?is)<img\b[^>]*>`)
	webReImgAlt       = regexp.MustCompile(`(?is)\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))`)
	webReHrTag        = regexp.MustCompile(`(?is)<hr\b[^>]*>`)
	webReTrClose      = regexp.MustCompile(`(?is)</tr\s*>`)
	webReBlockCloseMD = regexp.MustCompile(`(?is)</(p|div|section|article|blockquote|li|h[1-6]|table|ul|ol|dl|dd|dt|thead|tbody|tfoot|figure|figcaption|address|pre|main|footer|header|nav|aside|form)\s*>`)
)

type webResponse struct {
	Body        []byte
	FinalURL    string
	Status      int
	ContentType string
	Truncated   bool
}

// WebSearch 用 Bing RSS 搜索公开网页，返回标题、链接、摘要与日期。
func Search(query string, maxResults int) (map[string]interface{}, error) {
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
func Fetch(rawURL string, maxChars int) (map[string]interface{}, error) {
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
		if strings.HasPrefix(mediaType, "image/") {
			return nil, fmt.Errorf("该地址是图片（%s）。要看画面请用 read_image 并把这个 URL 作为 path 传入；"+
				"只需确认链接可访问可忽略本结果", mediaType)
		}
		return nil, fmt.Errorf("该地址返回 %s，web_fetch 只支持 HTML / 文本 / JSON / XML", mediaType)
	}
	charset := webNormalizeCharset(params["charset"])
	if charset == "" {
		charset = webSniffCharset(resp.Body)
	}
	body, usedEnc, decodeErr := chardec.DecodeBytes(resp.Body, charset)
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

// FetchImage 抓取一张公网图片并转成 data URL——AI 的 read_image 用它看网图。
// 与 Fetch 共用同一套 URL 校验（仅公网 http/https、逐跳校验重定向、超时与体积上限），
// 区别只在于按图片处理：更大的体积上限、只信魔数、不做正文抽取。
func FetchImage(rawURL string) (map[string]interface{}, error) {
	started := time.Now()
	resp, err := webRequest(rawURL, webImageMaxBytes,
		"image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/svg+xml;q=0.9,image/*;q=0.8,*/*;q=0.5")
	if err != nil {
		return nil, err
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return nil, fmt.Errorf("抓取失败：HTTP %d", resp.Status)
	}
	if resp.Truncated {
		return nil, fmt.Errorf("图片超过 %d MB，无法读取", webImageMaxBytes>>20)
	}
	declared, _, _ := mime.ParseMediaType(resp.ContentType)
	declared = strings.ToLower(strings.TrimSpace(declared))
	mediaType, err := webImageMime(declared, resp.Body)
	if err != nil {
		return nil, err
	}
	name := ""
	if pu, parseErr := url.Parse(resp.FinalURL); parseErr == nil {
		name = path.Base(pu.Path)
		// 只有带扩展名的末段才像文件名（picsum.photos/640/360 这种末段是尺寸，别当名字）
		if name == "." || name == "/" || !strings.Contains(name, ".") {
			name = ""
		}
	}
	return map[string]interface{}{
		"url":         rawURL,
		"finalUrl":    resp.FinalURL,
		"status":      resp.Status,
		"contentType": mediaType,
		"name":        name,
		"bytes":       len(resp.Body),
		"dataUrl":     "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(resp.Body),
		"elapsedMs":   time.Since(started).Milliseconds(),
	}, nil
}

// webImageMime 判定抓回来的字节到底是不是图片：只信魔数（Content-Type 由站点随便写），
// SVG 例外——它按文本传，靠开头标记识别；AVIF 的容器魔数 DetectContentType 不认，单独看一眼。
// 声明的类型只用于把错误话说清楚。
func webImageMime(declared string, body []byte) (string, error) {
	if len(body) == 0 {
		return "", errors.New("图片内容为空")
	}
	sniffed, _, _ := mime.ParseMediaType(http.DetectContentType(body))
	sniffed = strings.ToLower(strings.TrimSpace(sniffed))
	if strings.HasPrefix(sniffed, "image/") {
		return sniffed, nil
	}
	if webLooksLikeSVG(body) {
		return "image/svg+xml", nil
	}
	if declared == "image/avif" && webHasAVIFBrand(body) {
		return "image/avif", nil
	}
	if strings.HasPrefix(declared, "image/") {
		return "", fmt.Errorf("该地址声明是 %s，但返回的内容不是有效图片", declared)
	}
	if declared == "" {
		declared = sniffed
	}
	return "", fmt.Errorf("该地址返回 %s，不是图片（文本页面请用 web_fetch）", declared)
}

// webLooksLikeSVG 看开头是不是 <svg（容忍 BOM、XML 声明与前导注释）。
func webLooksLikeSVG(body []byte) bool {
	head := body
	if len(head) > 4096 {
		head = head[:4096]
	}
	s := strings.ToLower(strings.TrimPrefix(string(head), "\ufeff"))
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "<?xml") {
		idx := strings.Index(s, "?>")
		if idx < 0 {
			return false
		}
		s = strings.TrimSpace(s[idx+2:])
	}
	for strings.HasPrefix(s, "<!--") {
		idx := strings.Index(s, "-->")
		if idx < 0 {
			return false
		}
		s = strings.TrimSpace(s[idx+3:])
	}
	return strings.HasPrefix(s, "<svg")
}

// webHasAVIFBrand 判 ISO-BMFF 的 ftyp 里是不是 avif / avis 品牌。
func webHasAVIFBrand(body []byte) bool {
	if len(body) < 12 || string(body[4:8]) != "ftyp" {
		return false
	}
	brand := string(body[8:12])
	return brand == "avif" || brand == "avis"
}

// webClient 构造抓取用客户端。
//
// SSRF 防护分两层：webValidateURL 做连接前预检（解析并校验每个 IP），
// 以及拨号阶段的 netguard.Control——后者拿的是**实际要连的 IP**，能封住
// DNS 重绑定（预检返回公网、连接时返回 127.0.0.1）。走代理时不挂 Control：
// 那时拨号目标是代理本身（常在本机/内网），挂了会把正常代理请求一起拒掉。
func webClient() *http.Client {
	proxy := aitransport.SystemProxy()
	transport := &http.Transport{
		Proxy:                 proxy,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		IdleConnTimeout:       30 * time.Second,
	}
	if proxy == nil {
		transport.DialContext = netguard.Dialer().DialContext
	}
	return &http.Client{
		Timeout:   webRequestTimeout,
		Transport: transport,
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
		if !netguard.IsPublicIP(ip) {
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

// webIsPublicIP 委托 netguard.IsPublicIP：判定逻辑集中一处，webtools / aigen 共用。
func webIsPublicIP(ip net.IP) bool { return netguard.IsPublicIP(ip) }

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
	return title, webMainToMarkdown(page, pageURL), links
}

// ---------- 正文抽取管线：预清洗 → 语义容器收窄 → 噪声黑名单 → Markdown 转换 ----------

// webMainToMarkdown 网页主文本管线的入口。
func webMainToMarkdown(page, pageURL string) string {
	clean := webPreClean(page)
	content := webPickMainContent(clean)
	content = webDropNoise(content)
	return webContentToMarkdown(content, pageURL)
}

// webPreClean 删注释与确定无正文价值的整块（script/style 等），
// 为容器收窄提供干净的文本量基准。
func webPreClean(page string) string {
	s := webReComment.ReplaceAllString(page, " ")
	for _, re := range webReDropBlocks {
		s = re.ReplaceAllString(s, " ")
	}
	return s
}

type webTagInfo struct {
	name  string
	close bool
	start int
	end   int
	attrs string
}

var webVoidTags = map[string]bool{
	"br": true, "img": true, "hr": true, "input": true, "meta": true,
	"link": true, "source": true, "wbr": true, "col": true, "area": true,
	"embed": true, "track": true,
}

// webIterTags 遍历 s 里所有标签边界。假设第一个 > 结束标签（属性值含 > 极罕见，可牺牲）；
// 注释按 --> 配对跳过。visit 返回 false 提前终止。
func webIterTags(s string, visit func(t webTagInfo) bool) {
	for i := 0; i < len(s); {
		lt := strings.IndexByte(s[i:], '<')
		if lt < 0 {
			return
		}
		start := i + lt
		rest := s[start:]
		if strings.HasPrefix(rest, "<!--") {
			idx := strings.Index(rest, "-->")
			if idx < 0 {
				return
			}
			i = start + idx + 3
			continue
		}
		gt := strings.IndexByte(rest, '>')
		if gt < 0 {
			return
		}
		end := start + gt + 1
		inner := strings.TrimSpace(s[start+1 : end-1])
		t := webTagInfo{start: start, end: end}
		if strings.HasPrefix(inner, "/") {
			t.close = true
			inner = strings.TrimSpace(inner[1:])
		}
		nameEnd := 0
		for nameEnd < len(inner) {
			c := inner[nameEnd]
			if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
				c == '-' || c == '_' || c == ':' {
				nameEnd++
				continue
			}
			break
		}
		if nameEnd == 0 {
			i = end
			continue
		}
		t.name = strings.ToLower(inner[:nameEnd])
		if !t.close {
			t.attrs = inner[nameEnd:]
		}
		if !visit(t) {
			return
		}
		i = end
	}
}

// webBlockRange 从开标签 t 起按同名标签平衡扫描，返回内容区间 [t.end, 闭标签 end)。
// 未找到配对闭标签返回 false（宁可跳过也不吞半页）。
func webBlockRange(s string, t webTagInfo) (int, int, bool) {
	if t.close || webVoidTags[t.name] {
		return 0, 0, false
	}
	depth := 1
	found := false
	end := 0
	webIterTags(s[t.end:], func(u webTagInfo) bool {
		if u.name != t.name {
			return true
		}
		if u.close {
			depth--
			if depth == 0 {
				end = t.end + u.end
				found = true
				return false
			}
			return true
		}
		if !webVoidTags[u.name] {
			depth++
		}
		return true
	})
	if !found {
		return 0, 0, false
	}
	return t.end, end, true
}

func webFindAllTags(s string, pred func(webTagInfo) bool) []webTagInfo {
	var out []webTagInfo
	webIterTags(s, func(t webTagInfo) bool {
		if pred(t) {
			out = append(out, t)
		}
		return true
	})
	return out
}

// webClassTokens 从标签属性里取 class/id 的值，按非字母数字分词（小写）。
var webReTagChar = regexp.MustCompile(`[^a-z0-9]+`)

func webClassTokens(attrs string) map[string]bool {
	out := map[string]bool{}
	for _, m := range webReClassAttr.FindAllStringSubmatch(attrs, 4) {
		val := ""
		for _, g := range []int{2, 3, 4, 6, 7, 8} {
			if len(m) > g && m[g] != "" {
				val = strings.ToLower(m[g])
				break
			}
		}
		for _, w := range webReTagChar.Split(val, -1) {
			if w != "" {
				out[w] = true
			}
		}
	}
	return out
}

// webNoiseTokens class/id 命中这些词的块整体丢弃。刻意不含 header/footer：
// 「article-header」这类正文标题容器会被误删；站点头尾噪声靠语义收窄排除。
var webNoiseTokens = map[string]bool{
	"nav": true, "navbar": true, "menu": true, "sidebar": true,
	"comment": true, "comments": true,
	"advert": true, "adverts": true, "advertisement": true, "advertising": true,
	"ads": true, "ad": true,
	"banner": true, "promo": true, "promotion": true, "promotions": true,
	"related": true, "recommend": true, "recommended": true,
	"recommendation": true, "recommendations": true,
	"cookie": true, "cookies": true, "consent": true,
	"breadcrumb": true, "breadcrumbs": true,
	"pagination": true, "pager": true,
	"newsletter": true, "subscribe": true, "subscription": true,
	"social": true, "share": true, "sharing": true,
	"sponsor": true, "sponsors": true,
	"popup": true, "modal": true, "overlay": true,
	"tracking": true, "analytics": true, "seo": true,
	"search": true, "searchbox": true,
	"hidden": true, "offscreen": true, "skip": true,
	"widget": true, "widgets": true, "masthead": true,
}

// webMainTokens id/class 命中这些词的容器视为语义正文候选。
var webMainTokens = map[string]bool{
	"content": true, "main": true, "post": true, "article": true, "entry": true,
}

// webRuneTextLen 剥标签、解码实体后统计非空白字符数，用于收窄与删除决策。
func webRuneTextLen(s string) int {
	t := webReTag.ReplaceAllString(s, " ")
	t = html.UnescapeString(t)
	n := 0
	for _, r := range t {
		if !unicode.IsSpace(r) {
			n++
		}
	}
	return n
}

// webPickMainContent 语义容器收窄：article → main → role=main → id/class 容器词。
// 收窄条件：容器文本 ≥200 字且占全文 ≥25%，防止把摘要块当正文、或误删正文。
func webPickMainContent(s string) string {
	total := webRuneTextLen(s)
	if total < 400 {
		return s
	}
	try := func(t webTagInfo) (string, bool) {
		start, end, ok := webBlockRange(s, t)
		if !ok {
			return "", false
		}
		inner := s[start:end]
		n := webRuneTextLen(inner)
		if n < 200 || n*4 < total {
			return "", false
		}
		return inner, true
	}
	preds := []func(webTagInfo) bool{
		func(t webTagInfo) bool { return t.name == "article" },
		func(t webTagInfo) bool { return t.name == "main" },
		func(t webTagInfo) bool { return !t.close && webReRoleMain.MatchString(t.attrs) },
		func(t webTagInfo) bool {
			if t.name != "div" && t.name != "section" {
				return false
			}
			for w := range webClassTokens(t.attrs) {
				if webMainTokens[w] {
					return true
				}
			}
			return false
		},
	}
	for _, pred := range preds {
		for _, t := range webFindAllTags(s, pred) {
			if inner, ok := try(t); ok {
				return inner
			}
		}
	}
	return s
}

// webDropNoise class/id 命中黑名单的容器整块删除。
// form 有例外：部分 CMS 用 <form> 包全文，内部文本超过 300 字就不删。
func webDropNoise(s string) string {
	type span struct{ start, end int }
	var spans []span
	lastEnd := 0
	webIterTags(s, func(t webTagInfo) bool {
		if t.close || t.start < lastEnd {
			return true
		}
		switch t.name {
		case "div", "section", "ul", "ol", "form", "article", "main", "aside", "nav", "footer", "header":
			noisy := false
			for w := range webClassTokens(t.attrs) {
				if webNoiseTokens[w] {
					noisy = true
					break
				}
			}
			if !noisy {
				return true
			}
			_, end, ok := webBlockRange(s, t)
			if !ok {
				return true
			}
			if t.name == "form" && webRuneTextLen(s[t.end:end]) > 300 {
				return true
			}
			spans = append(spans, span{t.start, end})
			lastEnd = end
		}
		return true
	})
	if len(spans) == 0 {
		return s
	}
	var b strings.Builder
	prev := 0
	for _, sp := range spans {
		b.WriteString(s[prev:sp.start])
		prev = sp.end
	}
	b.WriteString(s[prev:])
	return b.String()
}

// webPreInnerText pre 内部转纯文本：块边界转行、剥标签、解码实体；
// 保留全部空白与缩进（这正是 pre 存在的意义）。
func webPreInnerText(s string) string {
	s = webReBr.ReplaceAllString(s, "\n")
	s = webReBlockClose.ReplaceAllString(s, "\n")
	s = webReTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.Trim(s, "\n")
}

// webExtractPres 把 pre 块替换为占位符（占一行），转换完成后原样放回 fenced code。
func webExtractPres(s string) (string, []string) {
	var preserved []string
	idx := 0
	out := webRePreBlock.ReplaceAllStringFunc(s, func(m string) string {
		sub := webRePreBlock.FindStringSubmatch(m)
		preserved = append(preserved, webPreInnerText(sub[1]))
		tag := "\x00cadt-pre-" + strconv.Itoa(idx) + "\x00"
		idx++
		return "\n" + tag + "\n"
	})
	return out, preserved
}

// webCodeFence pre 内容包成 Markdown 代码围栏；围栏长度避开内容里的反引号串。
func webCodeFence(code string) string {
	longest := 0
	run := 0
	for _, r := range code {
		if r == '`' {
			run++
			if run > longest {
				longest = run
			}
		} else {
			run = 0
		}
	}
	fence := "```"
	if longest >= 3 {
		fence = strings.Repeat("`", longest+1)
	}
	return fence + "\n" + code + "\n" + fence
}

// webInlineAnchors 锚链接就地转 [text](绝对地址)。无 href、空文本、
// javascript:/mailto:/tel: 只保留文本；文本超 200 字视为匹配异常，放弃转换。
func webInlineAnchors(s, pageURL string) string {
	base, err := url.Parse(pageURL)
	if err != nil {
		base = nil
	}
	count := 0
	return webReAnchor.ReplaceAllStringFunc(s, func(m string) string {
		count++
		if count > 200 {
			return webCleanInline(webReTag.ReplaceAllString(m, " "))
		}
		sub := webReAnchor.FindStringSubmatch(m)
		href := ""
		for _, g := range []int{2, 3, 4} {
			if len(sub) > g && sub[g] != "" {
				href = sub[g]
				break
			}
		}
		text := webCleanInline(sub[5])
		if text == "" {
			return ""
		}
		if href == "" {
			return text
		}
		if len([]rune(text)) > 200 {
			return text
		}
		href = html.UnescapeString(strings.TrimSpace(href))
		lower := strings.ToLower(href)
		if strings.HasPrefix(lower, "javascript:") ||
			strings.HasPrefix(lower, "mailto:") ||
			strings.HasPrefix(lower, "tel:") {
			return text
		}
		if base != nil {
			if ref, perr := base.Parse(href); perr == nil && (ref.Scheme == "http" || ref.Scheme == "https") {
				ref.Fragment = ""
				href = ref.String()
			}
		}
		href = strings.ReplaceAll(href, " ", "%20")
		href = strings.ReplaceAll(href, "(", "%28")
		href = strings.ReplaceAll(href, ")", "%29")
		return "[" + text + "](" + href + ")"
	})
}

// webContentToMarkdown 把清洗后的 HTML 转 Markdown 正文：
// pre→围栏代码、锚点就地化、标题→#、列表→-、表格→| 行、行内样式→**/*。
func webContentToMarkdown(content, pageURL string) string {
	text, pres := webExtractPres(content)
	text = webInlineAnchors(text, pageURL)
	text = webReInlineBold.ReplaceAllString(text, "**$1**")
	text = webReInlineItalic.ReplaceAllString(text, "*$1*")
	text = webReInlineCode.ReplaceAllStringFunc(text, func(m string) string {
		sub := webReInlineCode.FindStringSubmatch(m)
		body := sub[1]
		if strings.Contains(body, "`") {
			return "`` " + body + " ``"
		}
		return "`" + body + "`"
	})
	text = webReImgTag.ReplaceAllStringFunc(text, func(m string) string {
		alt := ""
		if sub := webReImgAlt.FindStringSubmatch(m); len(sub) > 1 {
			for _, g := range []int{2, 3, 4} {
				if len(sub) > g && sub[g] != "" {
					alt = sub[g]
					break
				}
			}
			alt = strings.TrimSpace(webCleanInline(alt))
		}
		if alt == "" {
			return " "
		}
		return " [图片: " + alt + "] "
	})
	text = webReHrTag.ReplaceAllString(text, "\n---\n")
	text = webReHOpen.ReplaceAllStringFunc(text, func(m string) string {
		sub := webReHOpen.FindStringSubmatch(m)
		return "\n" + strings.Repeat("#", int(sub[1][0]-'0')) + " "
	})
	text = webReLiOpen.ReplaceAllString(text, "\n- ")
	text = webReTrOpen.ReplaceAllString(text, "\n| ")
	text = webReCellClose.ReplaceAllString(text, " | ")
	text = webReTrClose.ReplaceAllString(text, " |\n")
	text = webReBr.ReplaceAllString(text, "\n")
	text = webReBlockCloseMD.ReplaceAllString(text, "\n")
	text = webReTag.ReplaceAllString(text, " ")
	text = html.UnescapeString(text)
	text = webNormalizeText(text)
	for i, code := range pres {
		tag := "\x00cadt-pre-" + strconv.Itoa(i) + "\x00"
		if strings.Contains(text, tag) {
			text = strings.ReplaceAll(text, tag, webCodeFence(code))
		}
	}
	return text
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
		// 表格行（首尾都是 |）保留定界符，Markdown 表格靠它们对齐单元格
		if !(strings.HasPrefix(line, "|") && strings.HasSuffix(line, "|")) {
			line = strings.Trim(line, "| ")
		}
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
