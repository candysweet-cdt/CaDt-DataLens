package main

// 全书搜索测试（docs/reading-mode.md §17.1）：命中、上下文、大小写、上限。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchReadingBookBasics(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	writeReadingFixture(t, dir, "第0001章-初遇.md", "# 第0001章 初遇\n\n这里有关键词存在。\n第二行没有。\n关键词又出现了。\n")
	writeReadingFixture(t, dir, "第0002章-再遇.md", "# 第0002章 再遇\n\n再遇里也有关键词。\n")
	writeReadingFixture(t, dir, "第0003章-无关.md", "# 第0003章 无关\n\n完全无关的内容。\n")

	app := &App{}
	res, err := app.SearchReadingBook("req-1", dir, "关键词", ReadingSearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 3 {
		t.Fatalf("hits = %d, 期望 3：%+v", len(res.Hits), res.Hits)
	}
	h := res.Hits[0]
	if h.Rel != "第0001章-初遇.md" || h.Offset != 3 {
		t.Errorf("hit0 = %+v", h)
	}
	if h.Match != "关键词" || !strings.Contains(h.Before+h.Match+h.After, "关键词存在") {
		t.Errorf("hit0 上下文异常：%+v", h)
	}
	if h.UnitOffset != 1 || h.UnitTitle != "第0001章 初遇" {
		t.Errorf("hit0 单元 = %+v", h)
	}
	if res.FilesScanned != 3 || res.FilesTotal != 3 {
		t.Errorf("scanned/total = %d/%d", res.FilesScanned, res.FilesTotal)
	}
	if res.Truncated {
		t.Error("不应截断")
	}
	// 第二个文件的命中
	if res.Hits[2].Rel != "第0002章-再遇.md" || res.Hits[2].UnitTitle != "第0002章 再遇" {
		t.Errorf("hit2 = %+v", res.Hits[2])
	}
}

func TestSearchReadingBookCaseInsensitive(t *testing.T) {
	dir := t.TempDir()
	writeReadingFixture(t, dir, "a.md", "Hello World 你好\n")
	app := &App{}
	res, err := app.SearchReadingBook("req-2", dir, "hello", ReadingSearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || res.Hits[0].Match != "Hello" {
		t.Fatalf("hits = %+v", res.Hits)
	}
}

func TestSearchReadingBookMaxResults(t *testing.T) {
	dir := t.TempDir()
	var b strings.Builder
	for i := 0; i < 10; i++ {
		b.WriteString("命中目标在这一行。\n")
	}
	writeReadingFixture(t, dir, "many.md", b.String())
	app := &App{}
	res, err := app.SearchReadingBook("req-3", dir, "命中目标", ReadingSearchOptions{MaxResults: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 3 || !res.Truncated {
		t.Errorf("hits = %d truncated = %v, 期望 3/true", len(res.Hits), res.Truncated)
	}
}

func TestSearchReadingBookEmptyQuery(t *testing.T) {
	dir := t.TempDir()
	app := &App{}
	if _, err := app.SearchReadingBook("req-4", dir, "  ", ReadingSearchOptions{}); err == nil {
		t.Error("空搜索词应报错")
	}
}

func TestSearchReadingBookDocx(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	path := buildTestDocx(t, map[string]string{"word/document.xml": docxTestDocument})
	if err := os.Rename(path, filepath.Join(dir, "资料.docx")); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	res, err := app.SearchReadingBook("req-5", dir, "沈世安", ReadingSearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("hits = %+v", res.Hits)
	}
	h := res.Hits[0]
	if h.Offset < 1 || !strings.Contains(h.Match, "沈世安") {
		t.Errorf("hit = %+v", h)
	}
}

func TestSearchReadingBookEpubFile(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	path := buildTestEpub(t, epubTestFiles())
	app := &App{}
	res, err := app.SearchReadingBook("req-6", path, "戊己", ReadingSearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || res.Hits[0].UnitTitle != "第一章 起点" {
		t.Fatalf("hits = %+v", res.Hits)
	}
}

func TestCancelReadingSearchUnknownID(t *testing.T) {
	app := &App{}
	app.CancelReadingSearch("no-such-request") // 不应 panic
}
