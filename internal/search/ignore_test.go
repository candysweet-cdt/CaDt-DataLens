package search

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeIgnore(t *testing.T, root, content string) {
	t.Helper()
	writeSearchFile(t, filepath.Join(root, ".cadt", "config", "search-ignore"), content)
}

func TestIgnoreRulesParseAndMatch(t *testing.T) {
	rules := &IgnoreRules{rules: []ignoreRule{
		{pattern: ".aoci", byName: true},                  // 任意层级同名目录/文件
		{pattern: "*.bak", byName: true},                  // 按名字通配
		{pattern: ".cadt/tmp", byName: false},             // 相对根路径
		{negate: true, pattern: "keep.bak", byName: true}, // 取反：重新包含
	}}
	cases := []struct {
		name, rel string
		want      bool
	}{
		{".aoci", ".aoci", true},
		{"x", ".aoci/baseline.json", true}, // 名字规则命中任意层级路径段
		{"x", "docs/.aoci/x.json", true},
		{"a.bak", "src/a.bak", true},
		{"keep.bak", "src/keep.bak", false}, // 取反覆盖 *.bak
		{"x", ".cadt/tmp/note.md", true},    // 路径规则
		{"x", ".cadt/tmp", true},
		{"x", "other/.cadt/tmp/x", false}, // 路径规则不匹配别处
		{"x", "src/main.go", false},
		{"x", "", false}, // 根自身永不跳过
		{"x", ".", false},
	}
	for _, c := range cases {
		if got := rules.shouldSkip(c.name, c.rel); got != c.want {
			t.Errorf("shouldSkip(%q, %q) = %v, want %v", c.name, c.rel, got, c.want)
		}
	}
}

func TestLoadIgnoreRulesCommentsAndCache(t *testing.T) {
	dir := t.TempDir()
	writeIgnore(t, dir, "# 注释\n\n  # 缩进注释\n.aoci\n*.tmp\n!keep.tmp\n")
	// 纯解析入口：只验用户规则的注释/取反与缓存；默认注入由
	// TestLoadIgnoreRulesInjectsDefaultsAndUserOverride 覆盖。
	path := filepath.Join(dir, ".cadt", "config", "search-ignore")
	rules := LoadIgnoreRulesAt(path)
	if rules == nil || len(rules.rules) != 3 {
		t.Fatalf("应解析出 3 条规则，got %+v", rules)
	}
	if !rules.shouldSkip("x", "a/.aoci/b.json") || !rules.shouldSkip("a.tmp", "a.tmp") {
		t.Error("注释不应影响规则命中")
	}
	if rules.shouldSkip("keep.tmp", "keep.tmp") {
		t.Error("!keep.tmp 应重新包含")
	}
	// 缓存命中：同一 path+mtime 返回同一实例
	if LoadIgnoreRulesAt(path) != rules {
		t.Error("mtime 未变时应命中缓存")
	}
}

func TestSearchWorkspaceRespectsIgnore(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1") // 强制内置扫描路径
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".aoci", "baseline.json"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "keep.bak"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "drop.bak"), "needle\n")
	writeIgnore(t, dir, ".aoci\n*.bak\n!keep.bak\n")

	res, err := (&Searcher{}).SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("应只剩 a.txt 与 keep.bak 两处命中，got %d: %+v", len(res.Hits), res.Hits)
	}
	for _, h := range res.Hits {
		if strings.Contains(h.Path, ".aoci") || strings.HasSuffix(h.Path, "drop.bak") {
			t.Errorf("被排除的文件不该命中：%s", h.Path)
		}
	}
}

func TestFindFilesRespectsIgnore(t *testing.T) {
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.go"), "package main\n")
	writeSearchFile(t, filepath.Join(dir, ".aoci", "x.go"), "package x\n")
	writeSearchFile(t, filepath.Join(dir, "docs", "old.go.bak"), "package old\n")
	writeIgnore(t, dir, ".aoci\n*.bak\n")

	res, err := (&Searcher{}).FindFiles(dir, "*.go*", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Path != "a.go" {
		t.Fatalf("FindFiles 应只返回 a.go，got %+v", res.Files)
	}
}

func TestSkipRgHitRespectsIgnore(t *testing.T) {
	dir := t.TempDir()
	rules := &IgnoreRules{rules: []ignoreRule{{pattern: ".aoci", byName: true}}}
	cache := map[string]bool{}
	if !skipRgHit(dir, filepath.Join(dir, ".aoci", "x.json"), rules, cache) {
		t.Error("rg 命中落在 .aoci 下应被二次过滤")
	}
	if skipRgHit(dir, filepath.Join(dir, "src", "a.go"), rules, cache) {
		t.Error("正常文件不该被过滤")
	}
}

func TestIgnoreNotAffectFingerprintSkipDir(t *testing.T) {
	// 硬编码表与用户配置互相独立：SkipDir 不含 .aoci（wipeguard 等不接入用户配置）
	if SkipDir(".aoci") {
		t.Error("SkipDir 不应包含用户配置里的目录名")
	}
}

func TestLoadIgnoreRulesAtArbitraryPath(t *testing.T) {
	// LoadIgnoreRulesAt：认知索引的 .cogignore 等任意路径排除文件复用同一解析/匹配机器。
	// 缓存键 = 文件路径 + mtime，与 search-ignore 互不串扰。
	dir := t.TempDir()
	if LoadIgnoreRulesAt(filepath.Join(dir, "missing.cogignore")) != nil {
		t.Fatal("不存在的文件应返回 nil")
	}
	// 是目录也应返回 nil（防呆）
	if err := os.MkdirAll(filepath.Join(dir, "cfg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if LoadIgnoreRulesAt(filepath.Join(dir, "cfg")) != nil {
		t.Fatal("目录应返回 nil")
	}
	path := filepath.Join(dir, ".cogignore")
	writeSearchFile(t, path, "*.log\n!keep.log\ndist/\n")
	rules := LoadIgnoreRulesAt(path)
	if rules == nil || len(rules.rules) != 3 {
		t.Fatalf("应解析出 3 条规则，got %+v", rules)
	}
	if !rules.shouldSkip("run.log", "a/b/run.log") || rules.shouldSkip("keep.log", "keep.log") {
		t.Error("通配与取反语义应与 search-ignore 一致")
	}
	if !rules.shouldSkip("x", "dist/bundle.js") {
		t.Error("目录规则应整树命中")
	}
	if LoadIgnoreRulesAt(path) != rules {
		t.Error("mtime 未变时应命中缓存")
	}
}

func TestLoadIgnoreRulesInjectsDefaultsAndUserOverride(t *testing.T) {
	dir := t.TempDir()
	// 无用户配置：默认软规则仍生效
	rules := LoadIgnoreRules(dir)
	if rules == nil || !rules.shouldSkip("x", "node_modules/pkg/a.js") ||
		!rules.shouldSkip(".git", ".git/config") || !rules.shouldSkip("x", "a/.venv/lib/x.py") {
		t.Fatalf("默认软规则应含 node_modules/.git/.venv，got %+v", rules)
	}
	if rules.shouldSkip("main.go", "src/main.go") {
		t.Error("正常源码不该被默认规则排除")
	}
	// 用户 ! 覆盖默认：node_modules 重新包含，.git 仍排除
	writeIgnore(t, dir, "!node_modules\n")
	rules2 := LoadIgnoreRules(dir)
	if rules2.shouldSkip("x", "node_modules/pkg/a.js") {
		t.Error("!node_modules 应覆盖默认软规则、重新包含")
	}
	if !rules2.shouldSkip(".git", ".git/config") {
		t.Error("只覆盖 node_modules，.git 仍应被默认排除")
	}
	// LoadIgnoreRulesAt 保持纯解析、不注入默认（cognition 解耦）
	raw := LoadIgnoreRulesAt(filepath.Join(dir, ".cadt", "config", "search-ignore"))
	if raw == nil || len(raw.rules) != 1 {
		t.Fatalf("LoadIgnoreRulesAt 应只含用户规则 1 条，got %+v", raw)
	}
	if raw.shouldSkip("x", "node_modules/pkg/a.js") {
		t.Error("LoadIgnoreRulesAt 不该注入默认规则")
	}
}

func TestIgnoreGlobArgsSeparateNegatedRules(t *testing.T) {
	rules := &IgnoreRules{rules: []ignoreRule{
		{pattern: "node_modules", byName: true},
		{negate: true, pattern: "node_modules", byName: true},
		{pattern: "docs/generated"},
		{negate: true, pattern: "docs/generated"},
	}}
	wantExclude := []string{
		"--glob", "!node_modules", "--glob", "!**/node_modules",
		"--glob", "!docs/generated",
	}
	wantReinclude := []string{
		"--glob", "node_modules", "--glob", "node_modules/**",
		"--glob", "**/node_modules", "--glob", "**/node_modules/**",
		"--glob", "docs/generated", "--glob", "docs/generated/**",
	}
	if got := rules.globArgs(); !slices.Equal(got, wantExclude) {
		t.Fatalf("排除 glob 不符：got %q want %q", got, wantExclude)
	}
	if got := rules.negatedGlobArgs(); !slices.Equal(got, wantReinclude) {
		t.Fatalf("重新包含 glob 不符：got %q want %q", got, wantReinclude)
	}
	if !rules.hasNegated() {
		t.Fatal("取反规则应触发 rg 独立补扫")
	}
}

// 默认软规则 + ! 覆盖在两条扫描路径同语义；IncludeIgnored 本次全放行。
func TestDefaultIgnoreAndIncludeIgnoredDualPath(t *testing.T) {
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "src", "keep.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "dep", "dep.txt"), "needle\n")
	writeIgnore(t, dir, "!node_modules\n")

	for _, tc := range []struct {
		name           string
		includeIgnored bool
		wantFiles      int
	}{
		{"默认放行 node_modules（用户 ! 覆盖）", false, 2},
		{"IncludeIgnored 本次全放行", true, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// 内置路径
			t.Run("builtin", func(t *testing.T) {
				t.Setenv("DATALENS_NO_RG", "1")
				res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{IncludeIgnored: tc.includeIgnored})
				if err != nil {
					t.Fatal(err)
				}
				if len(res.Hits) != tc.wantFiles {
					t.Fatalf("命中数 = %d，want %d: %+v", len(res.Hits), tc.wantFiles, res.Hits)
				}
			})
			// rg 路径（若安装）
			t.Run("rg", func(t *testing.T) {
				if _, err := exec.LookPath("rg"); err != nil {
					t.Skip("未安装 rg")
				}
				t.Setenv("DATALENS_NO_RG", "")
				res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{IncludeIgnored: tc.includeIgnored})
				if err != nil {
					t.Fatal(err)
				}
				if len(res.Hits) != tc.wantFiles {
					t.Fatalf("rg 命中数 = %d，want %d: %+v", len(res.Hits), tc.wantFiles, res.Hits)
				}
			})
		})
	}
}

func TestRgNegatedPathRuleIncludesSubtree(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 rg")
	}
	t.Setenv("DATALENS_NO_RG", "")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "src", "keep.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "docs", "generated", "deep", "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "docs", "generated-other", "b.txt"), "other\n")
	writeIgnore(t, dir, "docs/generated\n!docs/generated\n")

	res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("路径取反应补扫整个子树：got %d %+v", len(res.Hits), res.Hits)
	}
	for _, hit := range res.Hits {
		if strings.Contains(hit.Path, "generated-other") {
			t.Fatalf("路径取反误包含了前缀相近目录：%+v", hit)
		}
	}
}

func TestRgNegatedFileRuleDoesNotWhitelistEverything(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 rg")
	}
	t.Setenv("DATALENS_NO_RG", "")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "src", "main.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "keep.bak"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "drop.bak"), "needle\n")
	writeIgnore(t, dir, "*.bak\n!keep.bak\n")

	res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("文件取反不得把普通文件挤掉：got %d %+v", len(res.Hits), res.Hits)
	}
	for _, hit := range res.Hits {
		if strings.HasSuffix(hit.Path, "drop.bak") {
			t.Fatalf("未被取反的排除文件仍应过滤：%+v", hit)
		}
	}
}

func TestRgNegatedPassHonorsFilePatternAndExclude(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 rg")
	}
	t.Setenv("DATALENS_NO_RG", "")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "src", "keep.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "drop.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "dep", "keep.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "dep", "drop.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "dep", "other.js"), "needle\n")
	writeIgnore(t, dir, "!node_modules\n")

	res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{
		Pattern: "*.txt", ExcludePattern: "drop.txt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("取反补扫应同时遵守包含/排除通配：got %d %+v", len(res.Hits), res.Hits)
	}
	for _, hit := range res.Hits {
		if !strings.HasSuffix(hit.Path, "keep.txt") {
			t.Fatalf("取反补扫漏过滤了 pattern/exclude：%+v", hit)
		}
	}
}

// 无用户配置时默认软规则生效；IncludeIgnored=true 应放行 node_modules。
func TestIncludeIgnoredOverridesDefaultRules(t *testing.T) {
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "src", "keep.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "dep.txt"), "needle\n")
	t.Setenv("DATALENS_NO_RG", "1")

	res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || !strings.Contains(res.Hits[0].Path, "src") {
		t.Fatalf("默认应只命中 src/keep.txt，got %+v", res.Hits)
	}
	res2, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "needle", SearchOptions{IncludeIgnored: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res2.Hits) != 2 {
		t.Fatalf("IncludeIgnored 应放行 node_modules，命中 2 处，got %+v", res2.Hits)
	}
}
