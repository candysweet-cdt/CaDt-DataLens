package main

// 阅读模式扫描/排序/字数测试（docs/reading-mode.md §17.1）。

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestParseReadingNumeral(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"1", 1, true}, {"0001", 1, true},
		{"一", 1, true}, {"十", 10, true}, {"十一", 11, true},
		{"二十一", 21, true}, {"一百零三", 103, true}, {"两", 2, true},
		{"〇", 0, true}, {"一万二千", 12000, true}, {"二十万", 200000, true},
		{"三亿", 3e8, true},
		{"abc", 0, false}, {"", 0, false},
	}
	for _, c := range cases {
		got, ok := parseReadingNumeral(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseReadingNumeral(%q) = %v,%v 期望 %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestCountReadingWords(t *testing.T) {
	if got := countReadingWords("你好世界"); got != 4 {
		t.Errorf("你好世界 = %d, 期望 4", got)
	}
	if got := countReadingWords("hello world"); got != 2 {
		t.Errorf("hello world = %d, 期望 2", got)
	}
	if got := countReadingWords("中文 abc 123"); got != 4 {
		t.Errorf("中文 abc 123 = %d, 期望 4（2 CJK + abc + 123）", got)
	}
	if got := countReadingWords("第12章"); got != 3 {
		t.Errorf("第12章 = %d, 期望 3", got)
	}
	if got := countReadingWords(""); got != 0 {
		t.Errorf("空串 = %d, 期望 0", got)
	}
}

func TestClassifyReadingTitle(t *testing.T) {
	cases := []struct {
		in    string
		group int
		num   float64
		has   bool
		ok    bool
	}{
		{"第0卷 基本信息", readingGroupDetail, 0, true, true},
		{"第0000章-引言", readingGroupFront, 0, true, true},
		{"序章", readingGroupFront, 0, false, true},
		{"楔子", readingGroupFront, 0, false, true},
		{"第0012章-初遇微光", readingGroupMain, 12, true, true},
		{"第9章", readingGroupMain, 9, true, true},
		{"12. 番外-来路归途", readingGroupMain, 12, true, true},
		{"1. 基石时代", readingGroupMain, 1, true, true},
		{"尾声", readingGroupMain, 0, false, true},
		{"终章", readingGroupMain, 0, false, true},
		{"番外0001-来路归途", readingGroupExtra, 1, true, true},
		{"番外1 自我独白", readingGroupExtra, 1, true, true},
		{"番外卷 星落人间", readingGroupAppendix, 0, false, true},
		{"扩展卷 星火长明", readingGroupAppendix, 0, false, true},
		{"人物卷", readingGroupAppendix, 0, false, true},
		{"后记", readingGroupAppendix, 0, false, true},
		{"附录", readingGroupAppendix, 0, false, true},
		{"普通标题", readingGroupMain, 0, false, false},
	}
	for _, c := range cases {
		k, ok := classifyReadingTitle(c.in)
		if ok != c.ok {
			t.Errorf("classifyReadingTitle(%q) ok = %v, 期望 %v", c.in, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if k.group != c.group || k.num != c.num || k.hasNum != c.has {
			t.Errorf("classifyReadingTitle(%q) = group %d num %v has %v，期望 group %d num %v has %v",
				c.in, k.group, k.num, k.hasNum, c.group, c.num, c.has)
		}
	}
}

func TestSortReadingFiles(t *testing.T) {
	names := []string{
		"番外0002-乙.md", "尾声.md", "第10章-x.md", "第0卷 基本信息.md",
		"番外0001-甲.md", "第0001章-a.md", "扩展卷.md", "第0002章-b.md",
		"后记.md", "第0000章-引言.md", "第9章-c.md",
	}
	files := make([]ReadingFile, len(names))
	for i, n := range names {
		files[i] = ReadingFile{Name: n, Rel: n}
	}
	sortReadingFiles(files)
	got := make([]string, len(files))
	for i, f := range files {
		got[i] = f.Name
	}
	want := []string{
		"第0卷 基本信息.md", // 详情页
		"第0000章-引言.md", // 前言
		"第0001章-a.md", "第0002章-b.md", "第9章-c.md", "第10章-x.md", "尾声.md", // 正文
		"番外0001-甲.md", "番外0002-乙.md", // 番外
		"后记.md", "扩展卷.md", // 扩展/附录
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("排序结果:\n got  %v\n want %v", got, want)
	}
}

func TestScanMdHeadingsSkipsFence(t *testing.T) {
	lines := splitReadingLines("```md\n# 不是标题\n```\n\n# 真标题\n\n~~~\n# 也不是\n~~~\n## 二级")
	hs := scanMdHeadings(lines, 100)
	if len(hs) != 2 {
		t.Fatalf("标题数 = %d, 期望 2：%+v", len(hs), hs)
	}
	if hs[0].Title != "真标题" || hs[0].Level != 1 || hs[0].Offset != 5 {
		t.Errorf("hs[0] = %+v", hs[0])
	}
	if hs[1].Title != "二级" || hs[1].Level != 2 {
		t.Errorf("hs[1] = %+v", hs[1])
	}
}

func TestScanTxtHeadings(t *testing.T) {
	lines := splitReadingLines("第一卷 星火\n\n第一章 起点\n正文\n\n第二章 转折")
	hs := scanTxtHeadings(lines, 100)
	if len(hs) != 3 {
		t.Fatalf("标题数 = %d, 期望 3：%+v", len(hs), hs)
	}
	if hs[0].Level != 1 || hs[0].Title != "第一卷 星火" {
		t.Errorf("hs[0] = %+v", hs[0])
	}
	if hs[1].Level != 2 || hs[1].Title != "第一章 起点" {
		t.Errorf("hs[1] = %+v", hs[1])
	}
}

func TestReadingHeadingWords(t *testing.T) {
	text := "# 第一章\n\n甲乙丙丁\n\n# 第二章\n\n戊己\n"
	lines := splitReadingLines(text)
	hs := scanMdHeadings(lines, 100)
	cum := readingWordPrefix(lines)
	for i := range hs {
		end := readingHeadingEnd(hs, i, len(lines)+1)
		hs[i].Words = int(cum[end-1] - cum[hs[i].Offset-1])
	}
	if len(hs) != 2 {
		t.Fatalf("标题数 = %d", len(hs))
	}
	if hs[0].Words != 7 { // "第一章"3 + "甲乙丙丁"4
		t.Errorf("第一章 words = %d, 期望 7", hs[0].Words)
	}
	if hs[1].Words != 5 { // 含自身标题行"第二章"3 字 + "戊己"2 字
		t.Errorf("第二章 words = %d, 期望 5", hs[1].Words)
	}
}

// writeReadingFixture 写入文件并返回路径。
func writeReadingFixture(t *testing.T, dir, rel, content string) string {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// hashReadingTree 对目录内全部文件做 hash+mtime 快照，用于只读断言。
func hashReadingTree(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(raw)
		snapshot[path] = hex.EncodeToString(sum[:]) + "|" + info.ModTime().String()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func assertReadingTreeUnchanged(t *testing.T, root string, before map[string]string) {
	t.Helper()
	after := hashReadingTree(t, root)
	if len(before) != len(after) {
		t.Fatalf("文件数变化：%d → %d", len(before), len(after))
	}
	for path, h := range before {
		if after[path] != h {
			t.Errorf("源文件被改动：%s", path)
		}
	}
}

func TestScanReadingRootFileProfile(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	writeReadingFixture(t, dir, "第0000章-引言.md", "# 第0000章 引言\n\n引言正文内容。\n")
	writeReadingFixture(t, dir, "第0001章-初遇.md", "# 第0001章 初遇\n\n初遇的正文，足够内容。\n")
	writeReadingFixture(t, dir, "第0002章-再遇.md", "# 第0002章 再遇\n\n再遇的正文。\n")
	writeReadingFixture(t, dir, "番外0001-独白.md", "# 番外1 自我独白\n\n番外内容。\n")
	writeReadingFixture(t, dir, "assets/pic.png", "\x89PNG\r\n\x1a\n占位")
	snapshot := hashReadingTree(t, dir)

	app := &App{}
	scan, err := app.ScanReadingRoot(dir, ReadingScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertReadingTreeUnchanged(t, dir, snapshot)

	if scan.Profile != "file" {
		t.Errorf("profile = %s, 期望 file（confidence %.2f）", scan.Profile, scan.Confidence)
	}
	var rels []string
	for _, f := range scan.Files {
		rels = append(rels, f.Rel)
	}
	want := []string{"第0000章-引言.md", "第0001章-初遇.md", "第0002章-再遇.md", "番外0001-独白.md"}
	if strings.Join(rels, "|") != strings.Join(want, "|") {
		t.Errorf("文件顺序 = %v, 期望 %v", rels, want)
	}
	if scan.Files[0].Headings[0].Words <= 0 {
		t.Errorf("标题字数未计算：%+v", scan.Files[0].Headings[0])
	}
	if scan.Title != filepath.Base(dir) {
		t.Errorf("Title = %q", scan.Title)
	}
}

func TestScanReadingRootSplitProfile(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	var b strings.Builder
	for i := 1; i <= 5; i++ {
		b.WriteString("## 第" + intToString(i) + "章 章节标题\n\n这一章的正文内容。\n\n")
	}
	writeReadingFixture(t, dir, "第1卷.md", b.String())
	var b2 strings.Builder
	for i := 1; i <= 3; i++ {
		b2.WriteString("## 第" + intToString(i) + "章 第二卷章节\n\n正文。\n\n")
	}
	writeReadingFixture(t, dir, "第2卷.md", b2.String())
	snapshot := hashReadingTree(t, dir)

	app := &App{}
	scan, err := app.ScanReadingRoot(dir, ReadingScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertReadingTreeUnchanged(t, dir, snapshot)
	if scan.Profile != "split" {
		t.Errorf("profile = %s, 期望 split（confidence %.2f）", scan.Profile, scan.Confidence)
	}
	if len(scan.Files) != 2 || len(scan.Files[0].Headings) != 5 {
		t.Errorf("Files=%d, 第1卷标题=%d", len(scan.Files), len(scan.Files[0].Headings))
	}
}

func intToString(n int) string {
	return strconv.Itoa(n)
}

func TestScanReadingRootTreeProfile(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	var b strings.Builder
	b.WriteString("# 第一篇 总览\n\n")
	for i := 1; i <= 4; i++ {
		b.WriteString("## " + intToString(i) + ". 小节\n\n### 细分\n\n#### 更深\n\n正文内容。\n\n")
	}
	writeReadingFixture(t, dir, "总览.md", b.String())
	writeReadingFixture(t, dir, "附录.md", "# 附录篇\n\n## 条目一\n\n## 条目二\n\n内容。\n")
	snapshot := hashReadingTree(t, dir)

	app := &App{}
	scan, err := app.ScanReadingRoot(dir, ReadingScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertReadingTreeUnchanged(t, dir, snapshot)
	if scan.Profile != "tree" {
		t.Errorf("profile = %s, 期望 tree（confidence %.2f）", scan.Profile, scan.Confidence)
	}
}

func TestScanReadingRootEncoding(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	dir := t.TempDir()
	gbk, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("第一章 起点\n\n中文内容。"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "gbk.txt"), gbk, 0o644); err != nil {
		t.Fatal(err)
	}
	// UTF-16LE BOM
	u16 := []byte{0xFF, 0xFE}
	for _, r := range []rune("第一章\n内容") {
		u16 = append(u16, byte(r&0xFF), byte(r>>8))
	}
	if err := os.WriteFile(filepath.Join(dir, "u16.txt"), u16, 0o644); err != nil {
		t.Fatal(err)
	}

	app := &App{}
	scan, err := app.ScanReadingRoot(dir, ReadingScanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]ReadingFile{}
	for _, f := range scan.Files {
		byName[f.Name] = f
	}
	g := byName["gbk.txt"]
	if g.Encoding != "gbk" {
		t.Errorf("gbk.txt Encoding = %s", g.Encoding)
	}
	if len(g.Headings) != 1 || g.Headings[0].Title != "第一章 起点" {
		t.Errorf("gbk.txt 标题 = %+v", g.Headings)
	}
	u := byName["u16.txt"]
	if u.Encoding != "utf-16le" {
		t.Errorf("u16.txt Encoding = %s", u.Encoding)
	}
	if len(u.Headings) != 1 || u.Headings[0].Title != "第一章" {
		t.Errorf("u16.txt 标题 = %+v", u.Headings)
	}
}

func TestExtractReadingMeta(t *testing.T) {
	dir := t.TempDir()
	writeReadingFixture(t, dir, "第0卷 基本信息.md",
		"# 基本信息\n\n**书名**：测试之书\n\n**作者**：某作者\n\n**简介**：这是一段简介。\n")
	title, author, intro := extractReadingMeta(dir)
	if title != "测试之书" || author != "某作者" || intro != "这是一段简介。" {
		t.Errorf("meta = %q/%q/%q", title, author, intro)
	}
	// front matter 优先级
	dir2 := t.TempDir()
	writeReadingFixture(t, dir2, "基本信息.md", "---\ntitle: FM书名\nauthor: FM作者\ndescription: FM简介\n---\n\n正文\n")
	title, author, intro = extractReadingMeta(dir2)
	if title != "FM书名" || author != "FM作者" || intro != "FM简介" {
		t.Errorf("front matter meta = %q/%q/%q", title, author, intro)
	}
}

func TestSuggestReadingBooks(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	ws := t.TempDir()
	// 一级目录：正文目录（多章文件）
	novel := filepath.Join(ws, "日记星辰")
	for i := 1; i <= 5; i++ {
		writeReadingFixture(t, novel, "正文/第000"+intToString(i)+"章-章.md", "# 内容")
	}
	// 备份仓：降权不出现
	backup := filepath.Join(ws, "backup")
	for i := 0; i < 4; i++ {
		writeReadingFixture(t, backup, "x"+intToString(i)+".md", "# x")
	}
	app := &App{}
	sugs := app.SuggestReadingBooks(ws, 12)
	if len(sugs) == 0 {
		t.Fatal("没有候选书")
	}
	found := false
	for _, s := range sugs {
		if strings.HasSuffix(s.Root, "正文") {
			found = true
		}
		if strings.Contains(s.Root, "backup") {
			t.Errorf("backup 出现在候选里：%s", s.Root)
		}
	}
	if !found {
		t.Errorf("正文目录未入候选：%+v", sugs)
	}
}
