package main

// DOCX 解析测试（docs/reading-mode.md §17.1）：zip.Writer 现场构造，不提交二进制夹具。

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildTestDocx(t *testing.T, files map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.docx")
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

const docxTestDocument = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 起点</w:t></w:r></w:p>
<w:p><w:r><w:t>正文第一段。</w:t></w:r><w:r><w:t>继续写。</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>角色</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>年龄</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>沈世安</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>17</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>大纲级别标题</w:t></w:r></w:p>
<w:p><w:r><w:t>第3章 关键词兜底</w:t></w:r></w:p>
<w:p><w:r><w:drawing/></w:r></w:p>
</w:body></w:document>`

func TestParseReadingDocxBlocks(t *testing.T) {
	path := buildTestDocx(t, map[string]string{
		"word/document.xml": docxTestDocument,
		"docProps/core.xml": `<?xml version="1.0"?><coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试文档</dc:title><dc:creator>某人</dc:creator></coreProperties>`,
	})
	app := &App{}
	doc, err := app.ParseReadingDocx(path)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "测试文档" || doc.Author != "某人" {
		t.Errorf("meta = %q/%q", doc.Title, doc.Author)
	}
	if len(doc.Blocks) != 6 {
		t.Fatalf("blocks = %d, 期望 6：%+v", len(doc.Blocks), doc.Blocks)
	}
	if doc.Blocks[0].Kind != "h1" || doc.Blocks[0].Text != "第一章 起点" {
		t.Errorf("block0 = %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].Kind != "p" || doc.Blocks[1].Text != "正文第一段。继续写。" {
		t.Errorf("block1 = %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Kind != "table" || len(doc.Blocks[2].Rows) != 2 ||
		len(doc.Blocks[2].Rows[0].Cells) != 2 || doc.Blocks[2].Rows[1].Cells[0] != "沈世安" {
		t.Errorf("block2 = %+v", doc.Blocks[2])
	}
	if doc.Blocks[3].Kind != "h3" || doc.Blocks[3].Text != "大纲级别标题" {
		t.Errorf("block3 = %+v", doc.Blocks[3])
	}
	if doc.Blocks[4].Kind != "h2" || doc.Blocks[4].Text != "第3章 关键词兜底" {
		t.Errorf("block4 = %+v（关键词兜底应为 h2）", doc.Blocks[4])
	}
	if doc.Blocks[5].Kind != "image" {
		t.Errorf("block5 = %+v（应为图片占位）", doc.Blocks[5])
	}
}

func TestParseReadingDocxChineseStyle(t *testing.T) {
	path := buildTestDocx(t, map[string]string{
		"word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
			`<w:p><w:pPr><w:pStyle w:val="标题 2"/></w:pPr><w:r><w:t>中文样式标题</w:t></w:r></w:p>` +
			`<w:p><w:r><w:t>正文</w:t></w:r></w:p>` +
			`</w:body></w:document>`,
	})
	app := &App{}
	doc, err := app.ParseReadingDocx(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Blocks) != 2 || doc.Blocks[0].Kind != "h2" {
		t.Fatalf("blocks = %+v", doc.Blocks)
	}
}

func TestParseReadingDocxOldDocRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.doc")
	if err := os.WriteFile(path, append([]byte{}, docxOLEHeader...), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	_, err := app.ParseReadingDocx(path)
	if err == nil || !strings.Contains(err.Error(), ".doc") {
		t.Errorf("期望 .doc 明确报错，got %v", err)
	}
}

func TestParseReadingDocxBadZip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.docx")
	if err := os.WriteFile(path, []byte("not a zip at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	if _, err := app.ParseReadingDocx(path); err == nil {
		t.Error("坏 zip 应报错")
	}
}

func TestParseReadingDocxMissingDocument(t *testing.T) {
	path := buildTestDocx(t, map[string]string{
		"other.xml": `<x/>`,
	})
	app := &App{}
	if _, err := app.ParseReadingDocx(path); err == nil {
		t.Error("缺少 document.xml 应报错")
	}
}

func TestScanReadingRootWithDocx(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	path := buildTestDocx(t, map[string]string{"word/document.xml": docxTestDocument})
	if err := os.Rename(path, filepath.Join(dir, "资料.docx")); err != nil {
		t.Fatal(err)
	}
	snapshot := hashReadingTree(t, dir)
	app := &App{}
	scan, err := app.ScanReadingRoot(dir, ReadingScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertReadingTreeUnchanged(t, dir, snapshot)
	if len(scan.Files) != 1 || scan.Files[0].Ext != ".docx" {
		t.Fatalf("files = %+v", scan.Files)
	}
	if len(scan.Files[0].Headings) != 3 {
		t.Errorf("docx 标题数 = %d, 期望 3（h1/h3/h2）", len(scan.Files[0].Headings))
	}
	if scan.Files[0].Words <= 0 {
		t.Errorf("docx 字数 = %d", scan.Files[0].Words)
	}
}

func TestParseReadingDocxRejectsOversizeEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.docx")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: "word/document.xml", Method: zip.Deflate})
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte{' '}, 1<<20)
	for i := 0; i < 60; i++ {
		if _, err := w.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&App{}).ParseReadingDocx(path); err == nil {
		t.Fatal("超过 50 MB 的 docx 正文应被拒绝（防解压炸弹）")
	}
}
