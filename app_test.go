package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
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
			if err := app.SaveFile(path, tc.content, tc.eol, tc.bom, "utf-8"); err != nil {
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
	data, err := app.OpenFile(path, "utf-8")
	if err != nil {
		t.Fatal(err)
	}
	if data.Enc != "utf-8" {
		t.Fatalf("expected enc utf-8, got %q", data.Enc)
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

func TestImageHexDumpHasNoPreamble(t *testing.T) {
	got := imageHexDump([]byte{0x89, 'P', 'N', 'G', 0x00, 0xFF})
	if strings.HasPrefix(got, "//") || strings.Contains(got, "\n\n") || strings.HasSuffix(got, "\n") {
		t.Fatalf("hex dump should contain only data rows, got %q", got)
	}
	lines := strings.Split(got, "\n")
	if len(lines) != 1 {
		t.Fatalf("expected one data line, got %d: %q", len(lines), got)
	}
	if !strings.HasPrefix(lines[0], "00000000  ") {
		t.Fatalf("unexpected first line: %q", lines[0])
	}
	if !strings.Contains(lines[0], "89 50 4e 47 00 ff") {
		t.Fatalf("bytes missing from dump: %q", lines[0])
	}
}

func TestSaveFileEmptyPath(t *testing.T) {
	app := NewApp()
	if err := app.SaveFile("", "{}", "lf", false, "utf-8"); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestGbkEncodeDecode(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "gbk.json")
	raw, err := encodeString("{\n  \"名字\": \"时空纪元\"\n}\n", "gbk")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("时空纪元")) {
		t.Fatal("expected gbk bytes, got utf-8")
	}
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatal(err)
	}
	data, err := app.OpenFile(path, "gbk")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(data.Content, "时空纪元") {
		t.Fatalf("gbk decode failed: %q", data.Content)
	}
	if data.Enc != "gbk" {
		t.Fatalf("expected enc gbk, got %q", data.Enc)
	}
	auto, err := app.OpenFile(path, "auto")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(auto.Content, "时空纪元") {
		t.Fatalf("auto decode failed: %q", auto.Content)
	}
	if auto.Enc != "gbk" {
		t.Fatalf("expected auto enc gbk, got %q", auto.Enc)
	}
	out := filepath.Join(t.TempDir(), "out.json")
	if err := app.SaveFile(out, data.Content, "lf", false, "gbk"); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	back, _, err := transform.Bytes(simplifiedchinese.GBK.NewDecoder(), saved)
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != data.Content {
		t.Fatalf("gbk roundtrip mismatch: %q vs %q", back, data.Content)
	}
}

func TestCheckEncoding(t *testing.T) {
	app := NewApp()
	cases := []struct {
		content string
		enc     string
		want    bool
	}{
		{"时空纪元", "utf-8", true},
		{"时空纪元", "gbk", true},
		{"时空纪元", "gb18030", true},
		{"时空纪元", "iso-8859-1", false},
		{"时空纪元", "us-ascii", false},
		{"plain ascii", "us-ascii", true},
		{"café", "iso-8859-1", true},
	}
	for _, c := range cases {
		if got := app.CheckEncoding(c.content, c.enc); got != c.want {
			t.Fatalf("CheckEncoding(%q, %s) = %v, want %v", c.content, c.enc, got, c.want)
		}
	}
}

func TestFirstPathArgSkipsExeAndFlags(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.json")
	if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	if got := firstPathArg([]string{exe, "-flag", dir, f}); got != dir {
		t.Fatalf("got %q, want %q", got, dir)
	}
	if got := firstPathArg([]string{"-x"}); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestOpenModeConfig(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := NewApp()
	if got := readOpenMode(); got != "tab" {
		t.Fatalf("default open mode = %q, want tab", got)
	}
	if err := app.SetOpenMode("window"); err != nil {
		t.Fatal(err)
	}
	if got := readOpenMode(); got != "window" {
		t.Fatalf("open mode = %q, want window", got)
	}
	if got := uniqueIDForLaunch(); !strings.HasPrefix(got, "cadt-datalens-window-") {
		t.Fatalf("window mode unique ID = %q", got)
	}
	if err := app.SetOpenMode("tab"); err != nil {
		t.Fatal(err)
	}
	if got := readOpenMode(); got != "tab" {
		t.Fatalf("open mode = %q, want tab", got)
	}
}

func TestOpenImageAsHex(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "pic.png")
	raw := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R'}
	if err := os.WriteFile(img, raw, 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	data, err := app.OpenFile(img, "auto")
	if err != nil {
		t.Fatal(err)
	}
	if !data.Binary || data.Enc != "binary" {
		t.Fatalf("image opened as binary=%v enc=%q", data.Binary, data.Enc)
	}
	if !strings.Contains(data.Content, "89 50 4e 47") || !strings.Contains(data.Content, "PNG") {
		t.Fatalf("unexpected hex dump: %q", data.Content)
	}

	txt := filepath.Join(dir, "note.any")
	if err := os.WriteFile(txt, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	data, err = app.OpenFile(txt, "auto")
	if err != nil {
		t.Fatal(err)
	}
	if data.Binary || data.Content != "hello" {
		t.Fatalf("text fallback binary=%v content=%q", data.Binary, data.Content)
	}
}

func TestUniqueIDForArgs(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	if got := uniqueIDForArgs(nil); got != "cadt-datalens-7f3a9c21" {
		t.Fatalf("tab id = %q", got)
	}
	if got := uniqueIDForArgs([]string{"--new-window"}); !strings.HasPrefix(got, "cadt-datalens-window-") {
		t.Fatalf("new-window id = %q", got)
	}
	app := NewApp()
	if err := app.SetOpenMode("window"); err != nil {
		t.Fatal(err)
	}
	if got := uniqueIDForArgs(nil); !strings.HasPrefix(got, "cadt-datalens-window-") {
		t.Fatalf("window mode id = %q", got)
	}
}

func TestPathArgsKeepsFilesAndDirs(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.json")
	b := filepath.Join(dir, "b.yaml")
	for _, f := range []string{a, b} {
		if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	got := pathArgs([]string{"-flag", a, dir, b})
	if len(got) != 3 || got[0] != a || got[1] != dir || got[2] != b {
		t.Fatalf("pathArgs = %v, want [%s %s %s]", got, a, dir, b)
	}
}

func TestOpenFileDetectsDirectory(t *testing.T) {
	dir := t.TempDir()
	data, err := NewApp().OpenFile(dir, "auto")
	if err != nil {
		t.Fatal(err)
	}
	if !data.IsDir || data.Name == "" || data.Path != dir {
		t.Fatalf("OpenFile(dir) = %+v", data)
	}
}

func TestReadDirListsAndTruncates(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"b.json", "a.yaml"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	all, err := app.ReadDir(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if all.Truncated || len(all.Entries) != 3 {
		t.Fatalf("ReadDir all = %+v", all)
	}
	if all.Entries[0].Name != "a.yaml" || all.Entries[1].Name != "b.json" || !all.Entries[2].IsDir {
		t.Fatalf("unexpected order: %+v", all.Entries)
	}
	part, err := app.ReadDir(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !part.Truncated || len(part.Entries) != 2 {
		t.Fatalf("ReadDir limit = %+v", part)
	}
}
