package main

// 阅读模式 EPUB 解析（docs/reading-mode.md §10.5）：
// container.xml → OPF → metadata/manifest/spine；解压 manifest 资源到
// appdata/reading-cache/epub-<sha1>/，XHTML 交给前端 DOMParser + DOMPurify 渲染。
// 安全：拒绝路径逃逸、限制条目数/体积、DRM 拒绝、缓存 LRU 清理。零新依赖。

import (
	"archive/zip"
	"crypto/sha1"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	epubMaxEntries      = 5000
	epubMaxFileBytes    int64 = 50 << 20
	epubMaxExtractBytes int64 = 200 << 20
	epubCacheMaxBooks         = 20
	epubCacheMaxBytes   int64 = 500 << 20
)

// ReadingEpubChapterMeta spine 顺序中的一章。
type ReadingEpubChapterMeta struct {
	Index int    `json:"index"`
	Href  string `json:"href"`
	Title string `json:"title"`
	Words int    `json:"words"`
}

// ReadingEpubBook PrepareReadingEpub 的返回结构。
type ReadingEpubBook struct {
	ID       string                   `json:"id"`
	Path     string                   `json:"path"`
	Title    string                   `json:"title"`
	Author   string                   `json:"author"`
	CacheDir string                   `json:"cacheDir"`
	Token    string                   `json:"token"`
	ModTime  int64                    `json:"modTime"`
	Chapters []ReadingEpubChapterMeta `json:"chapters"`
}

// ReadingEpubChapter ReadReadingEpubChapter 的返回结构。HTML 为 body 内容原始片段，
// 由前端 DOMParser 解析后经 DOMPurify 消毒渲染，EPUB 自带 CSS/字体丢弃。
type ReadingEpubChapter struct {
	Index int    `json:"index"`
	Title string `json:"title"`
	HTML  string `json:"html"`
	Words int    `json:"words"`
}

var epubBooks = struct {
	sync.Mutex
	byID map[string]*ReadingEpubBook
}{byID: map[string]*ReadingEpubBook{}}

var (
	reEpubBody    = regexp.MustCompile(`(?is)<body[^>]*>(.*)</body>`)
	reEpubScript  = regexp.MustCompile(`(?is)<(script|style)\b[^>]*>.*?</(script|style)>`)
	reEpubTag     = regexp.MustCompile(`(?s)<[^>]*>`)
	reEpubH1ToH6  = regexp.MustCompile(`(?is)<h([1-6])\b[^>]*>(.*?)</h[1-6]>`)
	reEpubTitle   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reEpubNavHref = regexp.MustCompile(`(?is)<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
)

// PrepareReadingEpub 解析并解压一本 EPUB；重复调用命中缓存目录直接复用。
func (a *App) PrepareReadingEpub(path string) (*ReadingEpubBook, error) {
	return prepareReadingEpub(path)
}

func prepareReadingEpub(path string) (*ReadingEpubBook, error) {
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("EPUB 路径不是文件：%s", abs)
	}
	modTime := info.ModTime().UnixMilli()
	sum := sha1.Sum([]byte(abs + "|" + strconvI64(info.Size()) + "|" + strconvI64(modTime)))
	id := hex.EncodeToString(sum[:])[:16]
	epubBooks.Lock()
	if book, ok := epubBooks.byID[id]; ok {
		epubBooks.Unlock()
		return book, nil
	}
	epubBooks.Unlock()

	cacheDir := filepath.Join(appDataRoot(), "reading-cache", "epub-"+id)
	meta, err := parseEpubArchive(abs, cacheDir)
	if err != nil {
		return nil, err
	}
	meta.ID = id
	meta.Path = abs
	meta.ModTime = modTime
	if meta.Title == "" {
		meta.Title = strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	}
	token, err := registerPreviewRoot(cacheDir)
	if err != nil {
		return nil, err
	}
	meta.Token = token
	epubBooks.Lock()
	epubBooks.byID[id] = meta
	epubBooks.Unlock()
	cleanupReadingEpubCache()
	return meta, nil
}

func strconvI64(v int64) string {
	return fmt.Sprintf("%d", v)
}

// ReadReadingEpubChapter 读取已准备的 EPUB 某章 body HTML。
func (a *App) ReadReadingEpubChapter(epubID string, index int) (*ReadingEpubChapter, error) {
	epubBooks.Lock()
	book := epubBooks.byID[strings.TrimSpace(epubID)]
	epubBooks.Unlock()
	if book == nil {
		return nil, fmt.Errorf("EPUB 未准备，请先调用 PrepareReadingEpub")
	}
	if index < 0 || index >= len(book.Chapters) {
		return nil, fmt.Errorf("章节序号超出范围：%d", index)
	}
	ch := book.Chapters[index]
	filePath := filepath.Join(book.CacheDir, filepath.FromSlash(ch.Href))
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("章节文件读取失败：%w", err)
	}
	html := extractEpubBody(string(raw))
	return &ReadingEpubChapter{Index: index, Title: ch.Title, HTML: html, Words: ch.Words}, nil
}

// parseEpubArchive 打开 zip：校验 DRM/条目数，解析 container/OPF，解压 manifest 资源。
func parseEpubArchive(abs, cacheDir string) (*ReadingEpubBook, error) {
	zr, err := zip.OpenReader(abs)
	if err != nil {
		return nil, fmt.Errorf("无法读取 EPUB：%w", err)
	}
	defer zr.Close()
	if len(zr.File) > epubMaxEntries {
		return nil, fmt.Errorf("EPUB 条目数超过 %d", epubMaxEntries)
	}
	entries := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		if f.Name == "META-INF/encryption.xml" {
			return nil, fmt.Errorf("受 DRM 保护的 EPUB 不支持")
		}
		entries[f.Name] = f
	}
	container, ok := entries["META-INF/container.xml"]
	if !ok {
		return nil, fmt.Errorf("EPUB 缺少 META-INF/container.xml")
	}
	opfPath, err := epubContainerOPF(container)
	if err != nil {
		return nil, err
	}
	opfFile, ok := entries[opfPath]
	if !ok {
		return nil, fmt.Errorf("EPUB 缺少 OPF：%s", opfPath)
	}
	opf, err := parseEpubOPF(opfFile)
	if err != nil {
		return nil, err
	}
	opfDir := ""
	if i := strings.LastIndex(opfPath, "/"); i >= 0 {
		opfDir = opfPath[:i]
	}
	// 目录结构：href 相对 OPF 目录
	manifest := make(map[string]epubManifestItem, len(opf.Manifest))
	for _, item := range opf.Manifest {
		manifest[item.ID] = epubManifestItem{Href: item.Href, MediaType: item.MediaType}
	}
	var spineHrefs []string
	seen := map[string]bool{}
	for _, ref := range opf.Spine {
		item, ok := manifest[ref.IDRef]
		if !ok {
			continue
		}
		href := resolveEpubHref(opfDir, item.Href)
		if href == "" || seen[href] {
			continue
		}
		seen[href] = true
		spineHrefs = append(spineHrefs, href)
	}
	if len(spineHrefs) == 0 {
		return nil, fmt.Errorf("EPUB spine 为空")
	}
	// TOC 标题：ncx 优先，其次 nav.xhtml，兜底文档内第一个标题
	ncxHref := ""
	navHref := ""
	for _, item := range opf.Manifest {
		switch {
		case item.MediaType == "application/x-dtbncx+xml" && ncxHref == "":
			ncxHref = resolveEpubHref(opfDir, item.Href)
		case strings.HasSuffix(strings.ToLower(item.Href), "nav.xhtml") && navHref == "":
			navHref = resolveEpubHref(opfDir, item.Href)
		}
	}
	tocTitles := map[string]string{}
	if ncxHref != "" {
		if f, ok := entries[ncxHref]; ok {
			parseEpubNCX(f, opfDir, tocTitles)
		}
	}
	if len(tocTitles) == 0 && navHref != "" {
		if f, ok := entries[navHref]; ok {
			parseEpubNav(f, opfDir, tocTitles)
		}
	}
	// 解压 manifest 资源（只取文本与图片，CSS/字体丢弃）
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	var extracted uint64
	for _, item := range opf.Manifest {
		if extracted > uint64(epubMaxExtractBytes) {
			return nil, fmt.Errorf("EPUB 解压总量超过 200 MB")
		}
		ext := strings.ToLower(filepath.Ext(item.Href))
		switch ext {
		case ".xhtml", ".html", ".htm", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp":
		default:
			continue
		}
		href := resolveEpubHref(opfDir, item.Href)
		if href == "" {
			continue
		}
		f, ok := entries[href]
		if !ok {
			continue
		}
		if f.UncompressedSize64 > uint64(epubMaxFileBytes) {
			return nil, fmt.Errorf("EPUB 单文件超过 50 MB：%s", href)
		}
		if extracted+f.UncompressedSize64 > uint64(epubMaxExtractBytes) {
			return nil, fmt.Errorf("EPUB 解压总量超过 200 MB")
		}
		target := filepath.Join(cacheDir, filepath.FromSlash(href))
		if !readingCachePathInside(cacheDir, target) {
			return nil, fmt.Errorf("EPUB 条目路径越界：%s", href)
		}
		if err := extractEpubEntry(f, target); err != nil {
			return nil, err
		}
		extracted += f.UncompressedSize64
	}
	book := &ReadingEpubBook{
		CacheDir: cacheDir,
		Title:    opf.Title,
		Author:   opf.Author,
	}
	for i, href := range spineHrefs {
		title := tocTitles[href]
		words := 0
		if f, ok := entries[href]; ok && f.UncompressedSize64 < 8<<20 {
			if raw, err := readZipEntry(f); err == nil {
				html := string(raw)
				if title == "" {
					title = firstEpubHeading(html)
				}
				words = countReadingWords(epubTextContent(html))
			}
		}
		if title == "" {
			title = "第 " + strconvI64(int64(i+1)) + " 节"
		}
		book.Chapters = append(book.Chapters, ReadingEpubChapterMeta{
			Index: i, Href: href, Title: strings.TrimSpace(title), Words: words,
		})
	}
	return book, nil
}

func readingCachePathInside(cacheDir, target string) bool {
	rel, err := filepath.Rel(cacheDir, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func extractEpubEntry(f *zip.File, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

func readZipEntry(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, epubMaxFileBytes+1))
}

// resolveEpubHref 把 OPF 相对 href 规范为 zip 内路径；拒绝绝对路径与 ..。
type epubManifestItem struct {
	Href      string
	MediaType string
}

func resolveEpubHref(opfDir, href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	if i := strings.IndexAny(href, "#?"); i >= 0 {
		href = href[:i]
	}
	if href == "" {
		return ""
	}
	href = strings.ReplaceAll(href, "\\", "/")
	if strings.HasPrefix(href, "/") || filepath.IsAbs(href) {
		return ""
	}
	parts := strings.Split(opfDir+"/"+href, "/")
	var out []string
	for _, p := range parts {
		switch p {
		case "", ".":
			continue
		case "..":
			if len(out) == 0 {
				return ""
			}
			out = out[:len(out)-1]
		default:
			out = append(out, p)
		}
	}
	return strings.Join(out, "/")
}

type epubContainer struct {
	Rootfiles []struct {
		FullPath  string `xml:"full-path,attr"`
		MediaType string `xml:"media-type,attr"`
	} `xml:"rootfiles>rootfile"`
}

func epubContainerOPF(f *zip.File) (string, error) {
	raw, err := readZipEntry(f)
	if err != nil {
		return "", err
	}
	var c epubContainer
	if err := xml.Unmarshal(raw, &c); err != nil {
		return "", fmt.Errorf("container.xml 解析失败：%w", err)
	}
	for _, rf := range c.Rootfiles {
		if rf.MediaType == "application/oebps-package+xml" && rf.FullPath != "" {
			return strings.ReplaceAll(rf.FullPath, "\\", "/"), nil
		}
	}
	return "", fmt.Errorf("container.xml 未声明 OPF")
}

type epubOPF struct {
	Title    string `xml:"metadata>title"`
	Author   string `xml:"metadata>creator"`
	Manifest []struct {
		ID        string `xml:"id,attr"`
		Href      string `xml:"href,attr"`
		MediaType string `xml:"media-type,attr"`
	} `xml:"manifest>item"`
	Spine []struct {
		IDRef string `xml:"idref,attr"`
	} `xml:"spine>itemref"`
}

func parseEpubOPF(f *zip.File) (*epubOPF, error) {
	raw, err := readZipEntry(f)
	if err != nil {
		return nil, err
	}
	var opf epubOPF
	if err := xml.Unmarshal(raw, &opf); err != nil {
		return nil, fmt.Errorf("OPF 解析失败：%w", err)
	}
	return &opf, nil
}

type epubNCX struct {
	NavMap struct {
		Points []epubNCXPoint `xml:"navPoint"`
	} `xml:"navMap"`
}

type epubNCXPoint struct {
	Labels []struct {
		Text string `xml:"text"`
	} `xml:"navLabel"`
	Contents []struct {
		Src string `xml:"src,attr"`
	} `xml:"content"`
	Points []epubNCXPoint `xml:"navPoint"`
}

// parseEpubNCX 解析 toc.ncx 的 navPoint（含嵌套）。
func parseEpubNCX(f *zip.File, opfDir string, out map[string]string) {
	raw, err := readZipEntry(f)
	if err != nil {
		return
	}
	var ncx epubNCX
	if err := xml.Unmarshal(raw, &ncx); err != nil {
		return
	}
	var walk func(points []epubNCXPoint)
	walk = func(points []epubNCXPoint) {
		for _, np := range points {
			label, src := "", ""
			if len(np.Labels) > 0 {
				label = np.Labels[0].Text
			}
			if len(np.Contents) > 0 {
				src = np.Contents[0].Src
			}
			if href := resolveEpubHref(opfDir, src); href != "" && label != "" {
				if _, ok := out[href]; !ok {
					out[href] = label
				}
			}
			walk(np.Points)
		}
	}
	walk(ncx.NavMap.Points)
}

// parseEpubNav 解析 nav.xhtml：取文档内所有链接锚文本。
func parseEpubNav(f *zip.File, opfDir string, out map[string]string) {
	raw, err := readZipEntry(f)
	if err != nil {
		return
	}
	for _, m := range reEpubNavHref.FindAllStringSubmatch(string(raw), -1) {
		href := resolveEpubHref(opfDir, m[1])
		label := strings.TrimSpace(reEpubTag.ReplaceAllString(m[2], ""))
		if href != "" && label != "" {
			if _, ok := out[href]; !ok {
				out[href] = label
			}
		}
	}
}

func firstEpubHeading(html string) string {
	if m := reEpubH1ToH6.FindStringSubmatch(html); m != nil {
		return strings.TrimSpace(reEpubTag.ReplaceAllString(m[2], ""))
	}
	if m := reEpubTitle.FindStringSubmatch(html); m != nil {
		return strings.TrimSpace(reEpubTag.ReplaceAllString(m[1], ""))
	}
	return ""
}

func epubTextContent(html string) string {
	html = reEpubScript.ReplaceAllString(html, " ")
	html = reEpubTag.ReplaceAllString(html, " ")
	return html
}

func extractEpubBody(content string) string {
	if m := reEpubBody.FindStringSubmatch(content); m != nil {
		return m[1]
	}
	// 容错：去掉 XML 声明与 DOCTYPE 后整体返回
	start := 0
	for _, prefix := range []string{"<?xml", "<!DOCTYPE"} {
		if strings.HasPrefix(strings.TrimSpace(content[start:]), prefix) {
			if i := strings.Index(content[start:], ">"); i >= 0 {
				start += i + 1
			}
		}
	}
	return content[start:]
}

// cleanupReadingEpubCache 缓存 LRU：超过 20 本或 500 MB 时按修改时间从旧到新删除。
func cleanupReadingEpubCache() {
	root := filepath.Join(appDataRoot(), "reading-cache")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type cacheDir struct {
		path  string
		mtime time.Time
		size  int64
	}
	var dirs []cacheDir
	var total int64
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "epub-") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		size := int64(0)
		_ = filepath.Walk(path, func(_ string, fi os.FileInfo, err error) error {
			if err == nil && fi.Mode().IsRegular() {
				size += fi.Size()
			}
			return nil
		})
		dirs = append(dirs, cacheDir{path: path, mtime: info.ModTime(), size: size})
		total += size
	}
	if len(dirs) <= epubCacheMaxBooks && total <= epubCacheMaxBytes {
		return
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].mtime.Before(dirs[j].mtime) })
	for _, d := range dirs {
		if len(dirs) <= epubCacheMaxBooks && total <= epubCacheMaxBytes {
			break
		}
		if os.Remove(d.path) == nil || os.RemoveAll(d.path) == nil {
			total -= d.size
			dirs = dirs[1:]
		}
	}
}

// cleanupReadingCacheOnStartup 启动时清理超限的阅读缓存目录。
func cleanupReadingCacheOnStartup() {
	cleanupReadingEpubCache()
}
