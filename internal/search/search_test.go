package search

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func writeSearchFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func previewMatch(h SearchHit) string {
	units := utf16.Encode([]rune(h.Preview))
	if h.MatchStart < 0 || h.MatchEnd > len(units) || h.MatchStart > h.MatchEnd {
		return ""
	}
	return string(utf16.Decode(units[h.MatchStart:h.MatchEnd]))
}

func TestSearchWorkspace(t *testing.T) {
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "hello world\nHello TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, "sub", "b.go"), "x = TrimSpace(y) // TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "ignored.js"), "TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, ".git", "config"), "TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, "image.dat"), "TrimSpace\x00binary\n")

	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "trimsPACE", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 3 {
		t.Fatalf("expected 3 hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Files != 2 {
		t.Fatalf("expected 2 scanned files, got %d", res.Files)
	}
	first := res.Hits[0]
	if first.Name != "a.txt" || first.Line != 2 || first.Column != 7 || first.Length != 9 {
		t.Fatalf("unexpected first hit: %+v", first)
	}
	if first.Dir != filepath.Base(dir) {
		t.Fatalf("unexpected root dir label: %q", first.Dir)
	}
	if got := previewMatch(first); got != "TrimSpace" {
		t.Fatalf("preview match slice = %q (preview %q)", got, first.Preview)
	}
	for _, hit := range res.Hits[1:] {
		if hit.Name != "b.go" || hit.Dir != "sub" || previewMatch(hit) != "TrimSpace" {
			t.Fatalf("unexpected nested hit: %+v", hit)
		}
	}

	sensitive, err := app.SearchWorkspace(dir, "trimsPACE", true, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sensitive.Hits) != 0 {
		t.Fatalf("expected no case-sensitive hits, got %d", len(sensitive.Hits))
	}
}

func TestSearchWorkspaceLimitAndUnicode(t *testing.T) {
	dir := t.TempDir()
	content := "中文TrimSpace结束\n"
	writeSearchFile(t, filepath.Join(dir, "zh.txt"), content)
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "TrimSpace", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(res.Hits))
	}
	hit := res.Hits[0]
	if hit.Column != 3 || hit.Length != 9 {
		t.Fatalf("unexpected column/length: %+v", hit)
	}
	if got := previewMatch(hit); got != "TrimSpace" {
		t.Fatalf("preview match slice = %q", got)
	}

	many := ""
	for i := 0; i < 50; i++ {
		many += "TrimSpace\n"
	}
	writeSearchFile(t, filepath.Join(dir, "many.txt"), many)
	limited, err := app.SearchWorkspace(dir, "TrimSpace", false, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.Hits) != 5 || !limited.Truncated {
		t.Fatalf("expected 5 truncated hits, got %d truncated=%v", len(limited.Hits), limited.Truncated)
	}
}

func TestSearchWorkspaceLongPreview(t *testing.T) {
	dir := t.TempDir()
	long := ""
	for i := 0; i < 400; i++ {
		long += "x"
	}
	long += "Needle" + long
	writeSearchFile(t, filepath.Join(dir, "long.txt"), long+"\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "Needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(res.Hits))
	}
	hit := res.Hits[0]
	if got := previewMatch(hit); got != "Needle" {
		t.Fatalf("preview match slice = %q", got)
	}
	if hit.MatchStart == 0 || hit.MatchEnd >= len([]rune(hit.Preview)) {
		t.Fatalf("expected clipped preview with ellipsis, got %q", hit.Preview)
	}
}

func TestSearchWorkspaceParallelDeterministic(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 40; i++ {
		name := filepath.Join(dir, "f"+string(rune('a'+i%26))+string(rune('0'+i/26))+".txt")
		writeSearchFile(t, name, "tick\nTick\ntick\n")
	}
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "tick", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 120 {
		t.Fatalf("expected 120 hits, got %d", len(res.Hits))
	}
	if res.Files != 40 {
		t.Fatalf("expected 40 scanned files, got %d", res.Files)
	}
	for i := 1; i < len(res.Hits); i++ {
		prev, cur := res.Hits[i-1], res.Hits[i]
		if cur.Path < prev.Path || (cur.Path == prev.Path && cur.Line < prev.Line) {
			t.Fatalf("hits not ordered at %d: %+v then %+v", i, prev, cur)
		}
	}
}

func TestIndexFoldASCII(t *testing.T) {
	cases := []struct {
		haystack string
		needle   string
		want     int
	}{
		{"Hello World", "hello", 0},
		{"xxHELLOyy", "hello", 2},
		{"abc", "abd", -1},
		{"中文TrimSpace", "trimspace", 6},
	}
	for _, tc := range cases {
		if got := indexFoldASCII(tc.haystack, tc.needle); got != tc.want {
			t.Fatalf("indexFoldASCII(%q, %q) = %d, want %d", tc.haystack, tc.needle, got, tc.want)
		}
	}
}

func TestSearchWorkspaceBuiltinFallback(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "fallback.txt"), "alphaNeedle\nbetaNeedle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 builtin hits, got %d", len(res.Hits))
	}
	for _, hit := range res.Hits {
		if hit.Name != "fallback.txt" || previewMatch(hit) != "Needle" {
			t.Fatalf("unexpected hit: %+v", hit)
		}
	}
}

func TestSearchFileOnly(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.go")
	writeSearchFile(t, target, "needle one\nneedle two\n")
	writeSearchFile(t, filepath.Join(dir, "sibling.go"), "needle sibling\n")
	writeSearchFile(t, filepath.Join(dir, "sub", "deep.go"), "needle deep\n")

	app := &Searcher{}
	// 文件根 + FileOnly：只扫该文件（rg 路径与内置路径同语义）
	checkFileOnly := func(label string) {
		t.Helper()
		res, err := app.SearchWorkspaceAdvanced(target, "needle", SearchOptions{FileOnly: true})
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if len(res.Hits) != 2 {
			t.Fatalf("%s: expected 2 hits, got %d: %+v", label, len(res.Hits), res.Hits)
		}
		for _, hit := range res.Hits {
			if !strings.EqualFold(hit.Path, target) {
				t.Fatalf("%s: hit from another file: %+v", label, hit)
			}
			if hit.Dir != filepath.Base(dir) {
				t.Fatalf("%s: unexpected Dir %q", label, hit.Dir)
			}
		}
	}
	checkFileOnly("rg-or-builtin")
	t.Setenv("DATALENS_NO_RG", "1")
	checkFileOnly("builtin")

	// FileOnly=false 保留历史语义：文件根扩散到父目录
	res, err := app.SearchWorkspaceAdvanced(target, "needle", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 4 {
		t.Fatalf("legacy file root should scan parent, got %d hits: %+v", len(res.Hits), res.Hits)
	}

	// FileOnly 对目录根无意义：按普通目录扫描
	res, err = app.SearchWorkspaceAdvanced(dir, "needle", SearchOptions{FileOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 4 {
		t.Fatalf("FileOnly with dir root should behave as normal, got %d hits", len(res.Hits))
	}
}

func TestSearchArtifactPathClassifier(t *testing.T) {
	cases := []struct {
		rel  string
		want bool
	}{
		{"src/main.go", false},
		{"README.md", false},
		{"distributions/app.js", false},
		{"notes.mapping", false},
		{"frontend/dist/assets/index-DuKKsrlq.js", true},
		{"build/out.txt", true},
		{"src/vendor/lib.go", true},
		{"a/b/index.min.css", true},
		{".next/server/chunk.js", true},
		{"maps/app.js.map", true},
		{`frontend\dist\assets\index.js`, true},
	}
	for _, tc := range cases {
		if got := searchIsArtifactPath(tc.rel); got != tc.want {
			t.Fatalf("searchIsArtifactPath(%q) = %v, want %v", tc.rel, got, tc.want)
		}
	}
}

func TestSearchArtifactTierAfterSource(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	// dist 字典序在 src 之前；分档后产物命中必须仍排在源码命中之后，
	// 且产物文件名命中也不能越过源码档。
	writeSearchFile(t, filepath.Join(dir, "dist", "needle-bundle.js"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "main.go"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Hits[0].Name != "main.go" {
		t.Fatalf("expected source hit first, got %+v", res.Hits)
	}
	if res.Hits[1].Name != "needle-bundle.js" {
		t.Fatalf("expected artifact hit last, got %+v", res.Hits)
	}
	if res.ArtifactSkipped {
		t.Fatalf("artifact pass ran, ArtifactSkipped must stay false")
	}
}

func TestSearchNameHitSortsFirstInTier(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a-notes.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "z-needle.txt"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 hits, got %d", len(res.Hits))
	}
	if res.Hits[0].Name != "z-needle.txt" {
		t.Fatalf("expected name-hit file first, got %+v", res.Hits)
	}
}

func TestSearchSourceTierFillsCapFirst(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "b.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "dist", "bundle.js"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || !res.Truncated {
		t.Fatalf("expected 2 truncated hits, got %d truncated=%v", len(res.Hits), res.Truncated)
	}
	if !res.ArtifactSkipped {
		t.Fatalf("source tier filled the cap, ArtifactSkipped must be true")
	}
	for _, hit := range res.Hits {
		if searchIsArtifactPath(hit.Dir) {
			t.Fatalf("artifact hit must not crowd out source tier: %+v", res.Hits)
		}
	}
}

func TestSearchRgArtifactSkippedFlag(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "b.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "dist", "bundle.js"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || !res.Truncated || !res.ArtifactSkipped {
		t.Fatalf("expected 2 truncated source hits with ArtifactSkipped, got %+v", res)
	}
}

func TestSearchRgArtifactTierAndNameHit(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "dist", "bundle.js"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "main.go"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "a-notes.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "z-needle.txt"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 4 {
		t.Fatalf("expected 4 rg hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Hits[0].Name != "z-needle.txt" {
		t.Fatalf("expected name-hit file first, got %+v", res.Hits)
	}
	if last := res.Hits[3]; !searchIsArtifactPath(last.Dir) {
		t.Fatalf("expected artifact hit last, got %+v", res.Hits)
	}
}

// ---------- 文件名兜底命中（nameOnly） ----------

// 内容零命中时文件名含查询词 → nameOnly 行（搜 "icons.js" 找得到 icons.js 本身，
// 二进制文件同样能按名找到）；内容也命中的文件不追加，避免重复行。
func TestSearchNameOnlyHit(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "icons.js"), "export const x = 1\n")
	writeSearchFile(t, filepath.Join(dir, "note-icons.js"), "see icons.js here\n")
	// 带 NUL 的文件：内容扫描按二进制拒收，文件名命中仍然上报
	writeSearchFile(t, filepath.Join(dir, "icons.js.map"), "{\"sources\":[\"icons.ts\"]}\x00\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "icons.js", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	// note-icons.js：内容命中 1 行（文件名也命中 → 提权但不加 nameOnly 行）
	if len(res.Hits) != 3 {
		t.Fatalf("expected 3 hits (1 content + 2 name-only), got %d: %+v", len(res.Hits), res.Hits)
	}
	// icons.js：文件名与查询词精确相等 → 提到整个结果集最前（含内容命中之前）
	if !res.Hits[0].NameOnly || !res.Hits[0].nameExact || res.Hits[0].Name != "icons.js" {
		t.Fatalf("exact name match expected first: %+v", res.Hits[0])
	}
	// note-icons.js：内容命中，文件名不精确相等 → 紧随精确命中之后
	if res.Hits[1].NameOnly || res.Hits[1].Name != "note-icons.js" {
		t.Fatalf("content hit expected second: %+v", res.Hits[1])
	}
	for _, hit := range res.Hits[2:] {
		if !hit.NameOnly {
			t.Fatalf("expected name-only hit at tail: %+v", hit)
		}
		if hit.Line != 0 || hit.Column != 0 {
			t.Fatalf("name-only hit must carry no line/column: %+v", hit)
		}
		if hit.Name != "icons.js.map" {
			t.Fatalf("unexpected name-only file: %+v", hit)
		}
		if hit.Dir != filepath.Base(dir) {
			t.Fatalf("root-level name hit dir should be root base name: %+v", hit)
		}
		if got := previewMatch(hit); got != "icons.js" {
			t.Fatalf("name-only preview match = %q (preview %q)", got, hit.Preview)
		}
	}
	// 大小写不敏感：大写查询同样命中文件名
	res, err = app.SearchWorkspace(dir, "ICONS.JS", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	nameOnly := 0
	for _, h := range res.Hits {
		if h.NameOnly {
			nameOnly++
		}
	}
	if nameOnly != 2 {
		t.Fatalf("expected 2 case-insensitive name-only hits, got %d: %+v", nameOnly, res.Hits)
	}
}

// 模糊模式：文件名按子序列命中（icnsjs ⊆ icons.js）
func TestSearchFuzzyNameOnlyHit(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "icons.js"), "export const x = 1\n")
	writeSearchFile(t, filepath.Join(dir, "unrelated.txt"), "nothing here\n")
	app := &Searcher{}
	res, err := app.SearchWorkspaceFuzzy(dir, "icnsjs", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || !res.Hits[0].NameOnly || res.Hits[0].Name != "icons.js" {
		t.Fatalf("expected 1 fuzzy name-only hit for icons.js, got %+v", res.Hits)
	}
}

// rg 路径同样获得文件名兜底（两条路径统一收口）
func TestSearchRgNameOnlyHit(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "icons.js"), "export const x = 1\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "icons.js", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || !res.Hits[0].NameOnly || res.Hits[0].Name != "icons.js" {
		t.Fatalf("expected 1 name-only hit via rg path, got %+v", res.Hits)
	}
}

// ---------- AI 隔离 worktree 跳过（SkipPath） ----------

func TestSkipPath(t *testing.T) {
	cases := []struct {
		rel  string
		want bool
	}{
		{".cadt/worktree", true},
		{".cadt/worktree/x", true},
		{".cadt/worktree/x/src/a.js", true},
		{".CADT/WORKTREE/X/a.js", true},    // Windows 语义大小写不敏感
		{".cadt\\worktree\\x\\a.js", true}, // 反斜杠归一
		{".cadt/worktree-x/a.js", false},   // 不误伤同名前缀目录
		{".cadtworktree/x", false},         // 不误伤无分隔前缀
		{".cadt/tmp/a.md", false},          // AI 中间产物保持可搜
		{".cadt/logs/2026/11/INDEX.md", false},
		{".cadt/memory", false},
		{"src/main.go", false},
		{"", false},  // 根自身（从 worktree 内发起检索）
		{".", false}, // 根自身
	}
	for _, c := range cases {
		if got := SkipPath(c.rel); got != c.want {
			t.Fatalf("SkipPath(%q) = %v, want %v", c.rel, got, c.want)
		}
	}
}

// worktree 检出副本不进检索结果；从 worktree 自身发起的检索照常工作。
// 内置扫描路径（DATALENS_NO_RG=1）。
func TestSearchWorkspaceSkipsWorktreeBuiltin(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "worktree", "x", "a.js"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "tmp", "note.md"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("worktree 副本应被跳过（tmp 保留），got %d: %+v", len(res.Hits), res.Hits)
	}
	for _, hit := range res.Hits {
		if strings.Contains(hit.Path, "worktree") {
			t.Fatalf("worktree 命中泄漏：%+v", hit)
		}
	}
	// 从 worktree 内发起：rel 不命中，照常搜索
	res, err = app.SearchWorkspace(filepath.Join(dir, ".cadt", "worktree", "x"), "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("worktree 内检索应正常工作，got %d", len(res.Hits))
	}
}

func TestSearchWorkspaceSkipsWorktreeRg(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "worktree", "x", "a.js"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || strings.Contains(res.Hits[0].Path, "worktree") {
		t.Fatalf("rg 路径应跳过 worktree 副本：%+v", res.Hits)
	}
}

func TestFindFilesSkipsWorktree(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.go"), "package main\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "worktree", "x", "b.go"), "package wt\n")
	app := &Searcher{}
	res, err := app.FindFiles(dir, "*.go", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Path != "a.go" {
		t.Fatalf("glob 应跳过 worktree：%+v", res.Files)
	}
	res, err = app.FindFiles(filepath.Join(dir, ".cadt", "worktree", "x"), "*.go", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Name != "b.go" {
		t.Fatalf("worktree 内 glob 应正常工作：%+v", res.Files)
	}
}

// driftLine 复现 2026-11-23 全局搜索闪退的毒行：.cadt/tmp/webview-inspect 下 WebView2
// 「Subresource Filter」二进制规则文件的一行（无扩展名绕过二进制扩展名表，前 8KB 无 NUL
// 绕过 NUL 预检），含两个非法 UTF-8 字节：37 字节、ToLower 后 41 字节。当时 5 字节查询词
// 在降写串的 [35,40) 命中，套回原行触发 slice bounds out of range [:40] with length 37。
const driftLine = "$\b\x01\x10\x02\x18\xff\xef\x010\x018\x01@\x01R\x14.com/script/asset.js"

// TestFindMatchesFoldOffsetValidOnLowerDrift 回归：ToLower 会变长/变短的行（非法 UTF-8
// 字节逐个替换成 3 字节 U+FFFD；Ⱥ/Ⱦ 2→3 字节；U+212A 3→1 字节），降写串上的命中偏移
// 套回原行会越界或错位。修复后长度漂移的行改走原行逐 rune 折叠匹配，区间全部落在原行内。
func TestFindMatchesFoldOffsetValidOnLowerDrift(t *testing.T) {
	cases := []struct {
		name   string
		line   string
		needle string
		want   [][2]int
	}{
		{
			name:   "闪退原行：非法 UTF-8 字节膨胀 + 行尾命中",
			line:   driftLine,
			needle: "set.j",
			want:   [][2]int{{31, 36}},
		},
		{
			name:   "同一行的更早命中偏移同样要对准原行",
			line:   driftLine,
			needle: "asset",
			want:   [][2]int{{29, 34}},
		},
		{
			name:   "降写后多命中逐个落位（旧实现第二个命中越界）",
			line:   "\xffabab",
			needle: "ab",
			want:   [][2]int{{1, 3}, {3, 5}},
		},
		{
			name:   "Ⱥ 小写 2→3 字节：命中在变长字符之后",
			line:   strings.Repeat("Ⱥ", 20) + "关键词" + "尾部",
			needle: "尾部",
			want:   [][2]int{{49, 55}},
		},
		{
			name:   "KELVIN SIGN 小写 3→1 字节：偏移同样要对准原行",
			line:   "\u212AABC",
			needle: "abc",
			want:   [][2]int{{3, 6}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := legacySearchSpec(tc.needle, false, 0, "", false)
			spans := spec.findMatches(tc.line)
			if len(spans) != len(tc.want) {
				t.Fatalf("expected %d spans, got %d: %v", len(tc.want), len(spans), spans)
			}
			for i, span := range spans {
				if span[0] < 0 || span[1] > len(tc.line) || span[0] >= span[1] {
					t.Fatalf("span %v 越界（行长 %d）", span, len(tc.line))
				}
				if span != tc.want[i] {
					t.Fatalf("span %d = %v, want %v", i, span, tc.want[i])
				}
			}
		})
	}
}

// TestFindMatchesFoldDriftWordBoundary 长度漂移行的全词边界判定也必须基于原行偏移。
func TestFindMatchesFoldDriftWordBoundary(t *testing.T) {
	spec := legacySearchSpec("set.j", false, 0, "", false)
	spec.wholeWord = true
	// [31,36) 左邻 line[30]='s'、右邻 line[36]='s' 都是词字符，应整条拒绝
	if spans := spec.findMatches(driftLine); len(spans) != 0 {
		t.Fatalf("expected whole-word rejection, got %v", spans)
	}
	spec.wholeWord = false
	if spans := spec.findMatches(driftLine); len(spans) != 1 {
		t.Fatalf("expected 1 span without whole-word, got %v", spans)
	}
}

// TestFindMatchesCaseSensitiveUnaffected 大小写敏感路径不走折叠，行为应保持不变。
func TestFindMatchesCaseSensitiveUnaffected(t *testing.T) {
	spec := legacySearchSpec("set.j", true, 0, "", false)
	spans := spec.findMatches(driftLine)
	if len(spans) != 1 || spans[0] != [2]int{31, 36} {
		t.Fatalf("unexpected spans: %v", spans)
	}
}

// TestSearchWorkspaceBinaryDriftLineNoPanic 端到端回归：含非法 UTF-8 字节的无扩展名文件
// 走内置扫描（旧实现在 appendHit 切原行时 panic 掉整个进程，用户感知为「闪退」）。
func TestSearchWorkspaceBinaryDriftLineNoPanic(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "Filtering Rules"), driftLine+"\nsecond line set.j\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "set.j", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	for _, hit := range res.Hits {
		if hit.Line != 1 {
			continue
		}
		if hit.Column != 32 || hit.Length != 5 {
			t.Fatalf("unexpected hit metrics: %+v", hit)
		}
		if got := previewMatch(hit); got != "set.j" {
			t.Fatalf("preview match = %q, want %q", got, "set.j")
		}
	}
}
