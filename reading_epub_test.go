package main

// EPUB 解析与安全测试（docs/reading-mode.md §17.1）：现场构造最小 EPUB。

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildTestEpub(t *testing.T, files map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "book.epub")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

const (
	epubTestContainer = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`

	epubTestOPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">` +
		`<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试之书</dc:title><dc:creator>测试作者</dc:creator></metadata>` +
		`<manifest>` +
		`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
		`<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>` +
		`<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>` +
		`<item id="pic" href="img/pic.png" media-type="image/png"/>` +
		`</manifest>` +
		`<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>` +
		`</package>`

	epubTestNCX = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>` +
		`<navPoint id="n1"><navLabel><text>第一章 起点</text></navLabel><content src="ch1.xhtml"/></navPoint>` +
		`<navPoint id="n2"><navLabel><text>第二章 进展</text></navLabel><content src="ch2.xhtml"/></navPoint>` +
		`</navMap></ncx>`

	epubTestCh1 = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title></head>` +
		`<body><h1>第一章 起点</h1><p>甲乙丙丁，戊己庚辛。</p><script>alert(1)</script></body></html>`

	epubTestCh2 = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body>` +
		`<h2>第二章 进展</h2><p>正文内容。</p></body></html>`
)

func epubTestFiles() map[string]string {
	return map[string]string{
		"mimetype":            "application/epub+zip",
		"META-INF/container.xml": epubTestContainer,
		"OEBPS/content.opf":   epubTestOPF,
		"OEBPS/toc.ncx":       epubTestNCX,
		"OEBPS/ch1.xhtml":     epubTestCh1,
		"OEBPS/ch2.xhtml":     epubTestCh2,
		"OEBPS/img/pic.png":   "\x89PNG\r\n\x1a\n",
	}
}

func TestPrepareReadingEpub(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	path := buildTestEpub(t, epubTestFiles())
	before := hashReadingTree(t, filepath.Dir(path))

	app := &App{}
	book, err := app.PrepareReadingEpub(path)
	if err != nil {
		t.Fatal(err)
	}
	assertReadingTreeUnchanged(t, filepath.Dir(path), before)

	if book.Title != "测试之书" || book.Author != "测试作者" {
		t.Errorf("meta = %q/%q", book.Title, book.Author)
	}
	if book.Token == "" {
		t.Error("preview token 为空")
	}
	if len(book.Chapters) != 2 {
		t.Fatalf("chapters = %d", len(book.Chapters))
	}
	if book.Chapters[0].Title != "第一章 起点" || book.Chapters[1].Title != "第二章 进展" {
		t.Errorf("titles = %q/%q", book.Chapters[0].Title, book.Chapters[1].Title)
	}
	if book.Chapters[0].Words == 0 {
		t.Errorf("ch1 words = 0")
	}
	// 缓存已解压
	if _, err := os.Stat(filepath.Join(book.CacheDir, "OEBPS", "ch1.xhtml")); err != nil {
		t.Errorf("章节未解压：%v", err)
	}
	if _, err := os.Stat(filepath.Join(book.CacheDir, "OEBPS", "img", "pic.png")); err != nil {
		t.Errorf("图片未解压：%v", err)
	}
	// 重复准备命中同一缓存
	book2, err := app.PrepareReadingEpub(path)
	if err != nil || book2.ID != book.ID {
		t.Errorf("二次准备不一致：%v", err)
	}
	// 读章节
	ch, err := app.ReadReadingEpubChapter(book.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ch.HTML, "第一章 起点") {
		t.Errorf("章节 HTML 缺少标题：%q", ch.HTML)
	}
	// 第二次准备后再读（重新注册）
	book3, _ := app.PrepareReadingEpub(path)
	if _, err := app.ReadReadingEpubChapter(book3.ID, 1); err != nil {
		t.Errorf("读第 2 章：%v", err)
	}
}

func TestPrepareReadingEpubDRM(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	files := epubTestFiles()
	files["META-INF/encryption.xml"] = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>`
	path := buildTestEpub(t, files)
	app := &App{}
	_, err := app.PrepareReadingEpub(path)
	if err == nil || !strings.Contains(err.Error(), "DRM") {
		t.Errorf("期望 DRM 拒绝，got %v", err)
	}
}

func TestPrepareReadingEpubZipSlip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	files := epubTestFiles()
	// manifest href 试图逃逸缓存目录
	files["OEBPS/content.opf"] = strings.Replace(epubTestOPF,
		`href="img/pic.png"`, `href="../../evil.txt"`, 1)
	files["evil.txt"] = "pwned"
	path := buildTestEpub(t, files)
	app := &App{}
	book, err := app.PrepareReadingEpub(path)
	if err != nil {
		t.Fatal(err) // 恶意 href 被跳过而非中断
	}
	if _, err := os.Stat(filepath.Join(book.CacheDir, "evil.txt")); err == nil {
		t.Error("路径逃逸文件被写入了缓存目录")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(book.CacheDir), "evil.txt")); err == nil {
		t.Error("路径逃逸文件被写出了缓存目录")
	}
}

func TestPrepareReadingEpubMissingContainer(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	files := epubTestFiles()
	delete(files, "META-INF/container.xml")
	path := buildTestEpub(t, files)
	app := &App{}
	if _, err := app.PrepareReadingEpub(path); err == nil {
		t.Error("缺少 container.xml 应报错")
	}
}

func TestPrepareReadingEpubBadZip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	path := filepath.Join(t.TempDir(), "bad.epub")
	if err := os.WriteFile(path, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	if _, err := app.PrepareReadingEpub(path); err == nil {
		t.Error("坏 zip 应报错")
	}
}

func TestScanReadingRootSingleEpub(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	path := buildTestEpub(t, epubTestFiles())
	app := &App{}
	scan, err := app.ScanReadingRoot(path, ReadingScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if scan.Title != "测试之书" {
		t.Errorf("Title = %q", scan.Title)
	}
	if len(scan.Files) != 1 || len(scan.Files[0].Headings) != 2 {
		t.Fatalf("files = %+v", scan.Files)
	}
	if scan.Files[0].Headings[0].Title != "第一章 起点" {
		t.Errorf("heading0 = %+v", scan.Files[0].Headings[0])
	}
}

func TestResolveEpubHrefRejectsEscape(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ch1.xhtml", "OEBPS/ch1.xhtml"},
		{"sub/../ch1.xhtml", "OEBPS/ch1.xhtml"},
		// 逃逸最多落到缓存根（cacheDir 内），不会超出缓存目录
		{"../evil.txt", "evil.txt"},
		{"a/../../evil.txt", "evil.txt"},
		// 真正越出 epub 根的必须拒绝
		{"../../../evil.txt", ""},
		{"/abs/path.txt", ""},
		{"..\\evil.txt", "evil.txt"}, // 反斜杠归一为 /
		{"ch1.xhtml#frag", "OEBPS/ch1.xhtml"},
	}
	for _, c := range cases {
		if got := resolveEpubHref("OEBPS", c.in); got != c.want {
			t.Errorf("resolveEpubHref(OEBPS, %q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}
