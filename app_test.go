package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveFilePreservesEolAndBom(t *testing.T) {
	cases := []struct {
		name    string
		content string
		eol     string
		bom     bool
		want    string
	}{
		{"lf", "{\n  \"a\": 1\n}", "lf", false, "{\n  \"a\": 1\n}"},
		{"crlf", "{\n  \"a\": 1\n}", "crlf", false, "{\r\n  \"a\": 1\r\n}"},
		{"crlf-input-normalized", "{\r\n  \"a\": 1\r\n}", "crlf", false, "{\r\n  \"a\": 1\r\n}"},
		{"bom", "{\"a\":1}", "lf", true, "\xEF\xBB\xBF{\"a\":1}"},
		{"crlf-bom", "{\n\"a\":1\n}", "crlf", true, "\xEF\xBB\xBF{\r\n\"a\":1\r\n}"},
	}
	app := NewApp()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "test.json")
			if err := app.SaveFile(path, tc.content, tc.eol, tc.bom); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != tc.want {
				t.Fatalf("got %q, want %q", raw, tc.want)
			}
		})
	}
}

func TestOpenFileDetectsEolBomLarge(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "test.json")
	raw := append([]byte{0xEF, 0xBB, 0xBF}, []byte("{\r\n\"a\":1\r\n}")...)
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatal(err)
	}
	data, err := app.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !data.HasBom || data.Eol != "crlf" || data.Large {
		t.Fatalf("bad detection: %+v", data)
	}
	if data.Content != "{\r\n\"a\":1\r\n}" {
		t.Fatalf("bom not stripped: %q", data.Content)
	}
	if data.Name != "test.json" {
		t.Fatalf("bad name: %s", data.Name)
	}
}

func TestSaveFileEmptyPath(t *testing.T) {
	app := NewApp()
	if err := app.SaveFile("", "{}", "lf", false); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestFirstFileArgSkipsExeAndFlags(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.json")
	if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	if got := firstFileArg([]string{exe, "-flag", dir, f}); got != f {
		t.Fatalf("got %q, want %q", got, f)
	}
	if got := firstFileArg([]string{"-x", dir}); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}