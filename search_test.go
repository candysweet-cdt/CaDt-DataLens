package main

import (
	"os"
	"path/filepath"
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

	app := NewApp()
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
	app := NewApp()
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
	app := NewApp()
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
	app := NewApp()
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
	app := NewApp()
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
