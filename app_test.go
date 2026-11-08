package main

import (
	"bytes"
	"encoding/base64"
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

func TestLooksBinary(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		want bool
	}{
		{"text", []byte("hello\nworld\r\n\t中文"), false},
		{"nul", []byte("abc\x00def"), true},
		{"few-controls", []byte{0x1B, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'}, false},
		{"mostly-controls", []byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 'a', 'b'}, true},
		{"empty", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksBinary(tc.raw); got != tc.want {
				t.Fatalf("looksBinary(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestOpenFileBinaryBytes(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "sample.bin")
	raw := append([]byte("CaDt binary sample\n"), 0x00, 0x01, 0x02)
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatal(err)
	}
	data, err := app.OpenFile(path, "utf-8")
	if err != nil {
		t.Fatal(err)
	}
	if !data.Binary || data.Enc != "binary" || data.HexShown != int64(len(raw)) {
		t.Fatalf("expected binary file data, got %+v", data)
	}
	if !strings.HasPrefix(data.Content, "00000000  ") || strings.HasPrefix(data.Content, "//") {
		t.Fatalf("unexpected hex content: %q", data.Content)
	}
}

func TestReadImageDataURL(t *testing.T) {
	const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	raw, err := base64.StdEncoding.DecodeString(pngBase64)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "pixel.png")
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	data, err := app.OpenFile(path, "utf-8")
	if err != nil {
		t.Fatal(err)
	}
	if !data.Image || !data.Binary {
		t.Fatalf("expected image binary data, got %+v", data)
	}
	url, err := app.ReadImageDataURL(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("unexpected data url: %.32s", url)
	}
	textPath := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(textPath, []byte("not an image"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := app.ReadImageDataURL(textPath); err == nil {
		t.Fatal("expected error for non-image file")
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

func TestParseOpenTargets(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.json")
	b := filepath.Join(dir, "b.json")
	for _, f := range []string{a, b} {
		if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	exe, _ := os.Executable()
	cases := []struct {
		name  string
		args  []string
		path  string
		line  int
		col   int
		count int
	}{
		{"plain", []string{a}, a, 0, 0, 1},
		{"line-suffix", []string{a + ":12"}, a, 12, 0, 1},
		{"line-column", []string{a + ":12:7"}, a, 12, 7, 1},
		{"line-flag-before", []string{"--line", "9", a}, a, 9, 0, 1},
		{"line-flag-after", []string{a, "--line=8"}, a, 8, 0, 1},
		{"goto", []string{"-g", a + ":3"}, a, 3, 0, 1},
		{"column-and-line", []string{"--column", "4", "--line", "6", a}, a, 6, 4, 1},
		{"skip-exe-and-flags", []string{exe, "-flag", a}, a, 0, 0, 1},
		{"invalid-number", []string{a + ":abc"}, "", 0, 0, 0},
		{"missing-file", []string{filepath.Join(dir, "missing.json") + ":2"}, "", 0, 0, 0},
		{"multiple", []string{a + ":2", b + ":3"}, a, 2, 0, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseOpenTargets(tc.args)
			if len(got) != tc.count {
				t.Fatalf("parseOpenTargets(%v) count = %d, want %d: %+v", tc.args, len(got), tc.count, got)
			}
			if tc.count == 0 {
				return
			}
			if got[0].Path != tc.path || got[0].Line != tc.line || got[0].Column != tc.col {
				t.Fatalf("parseOpenTargets(%v) first = %+v, want %s:%d:%d", tc.args, got[0], tc.path, tc.line, tc.col)
			}
		})
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

func TestCreateEntryCreatesFileAndDirectory(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	filePath, err := app.CreateEntry(dir, "新建.json", false)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.IsDir() || info.Size() != 0 {
		t.Fatalf("new file = %+v", info)
	}
	subPath, err := app.CreateEntry(dir, "子目录", true)
	if err != nil {
		t.Fatal(err)
	}
	subInfo, err := os.Stat(subPath)
	if err != nil {
		t.Fatal(err)
	}
	if !subInfo.IsDir() {
		t.Fatalf("new directory = %+v", subInfo)
	}
	if _, err := app.CreateEntry(dir, "新建.json", false); err == nil {
		t.Fatal("duplicate file should fail")
	}
}

func TestCreateEntryRejectsInvalidNames(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	for _, name := range []string{"", " ", ".", "..", "a/b", `a\b`, "a:b", "a?b", "con", "CON.txt", "name.", "name "} {
		if _, err := app.CreateEntry(dir, name, false); err == nil {
			t.Fatalf("name %q should be rejected", name)
		}
	}
}

func TestRenameEntryRenamesFileAndDirectory(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	oldFile := filepath.Join(dir, "old.json")
	if err := os.WriteFile(oldFile, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	newFile, err := app.RenameEntry(oldFile, "new.json")
	if err != nil {
		t.Fatal(err)
	}
	if newFile != filepath.Join(dir, "new.json") {
		t.Fatalf("rename file = %s", newFile)
	}
	if _, err := os.Stat(oldFile); !os.IsNotExist(err) {
		t.Fatalf("old file still exists: %v", err)
	}
	if raw, err := os.ReadFile(newFile); err != nil || string(raw) != "{}" {
		t.Fatalf("renamed content = %q, %v", raw, err)
	}

	sub := filepath.Join(dir, "folder")
	if err := os.Mkdir(sub, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "a.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	newSub, err := app.RenameEntry(sub, "folder2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(newSub, "a.json")); err != nil {
		t.Fatalf("directory contents not moved: %v", err)
	}
}

func TestRenameEntryRejectsExistingAndInvalid(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	src := filepath.Join(dir, "a.json")
	dst := filepath.Join(dir, "b.json")
	for _, path := range []string{src, dst} {
		if err := os.WriteFile(path, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.RenameEntry(src, "b.json"); err == nil {
		t.Fatal("rename onto existing file should fail")
	}
	if _, err := app.RenameEntry(src, "a/b.json"); err == nil {
		t.Fatal("rename with separator should fail")
	}
	same, err := app.RenameEntry(src, "a.json")
	if err != nil || same != src {
		t.Fatalf("rename to same name = %s, %v", same, err)
	}
}

func TestSuggestCopyName(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	if name, err := app.SuggestCopyName(dir, "a.json", false); err != nil || name != "a.json" {
		t.Fatalf("free name = %q, %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if name, err := app.SuggestCopyName(dir, "a.json", false); err != nil || name != "a - 副本.json" {
		t.Fatalf("first copy name = %q, %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a - 副本.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if name, err := app.SuggestCopyName(dir, "a.json", false); err != nil || name != "a - 副本 2.json" {
		t.Fatalf("second copy name = %q, %v", name, err)
	}
	if err := os.Mkdir(filepath.Join(dir, "folder"), 0755); err != nil {
		t.Fatal(err)
	}
	if name, err := app.SuggestCopyName(dir, "folder", true); err != nil || name != "folder - 副本" {
		t.Fatalf("directory copy name = %q, %v", name, err)
	}
	if name, err := app.SuggestCopyName(dir, ".gitignore", false); err != nil || name != ".gitignore" {
		t.Fatalf("dotfile copy name = %q, %v", name, err)
	}
}

func TestCopyEntryFileAndDirectory(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	srcFile := filepath.Join(dir, "a.json")
	if err := os.WriteFile(srcFile, []byte(`{"a":1}`), 0644); err != nil {
		t.Fatal(err)
	}
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(filepath.Join(srcDir, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "nested", "b.yaml"), []byte("b: 1"), 0644); err != nil {
		t.Fatal(err)
	}
	dstDir := filepath.Join(dir, "dst")
	if err := os.Mkdir(dstDir, 0755); err != nil {
		t.Fatal(err)
	}

	newFile, err := app.CopyEntry(srcFile, dstDir, "a.json")
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(newFile); err != nil || string(raw) != `{"a":1}` {
		t.Fatalf("copied file = %q, %v", raw, err)
	}

	newDir, err := app.CopyEntry(srcDir, dstDir, "src - 副本")
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(newDir, "nested", "b.yaml")); err != nil || string(raw) != "b: 1" {
		t.Fatalf("copied directory content = %q, %v", raw, err)
	}
	if _, err := app.CopyEntry(srcFile, dstDir, "a.json"); err == nil {
		t.Fatal("copy onto existing should fail")
	}
	if _, err := app.CopyEntry(srcDir, filepath.Join(srcDir, "nested"), "self"); err == nil {
		t.Fatal("copy into own subdirectory should fail")
	}
}

func TestMoveEntryFileAndDirectory(t *testing.T) {
	dir := t.TempDir()
	app := NewApp()
	srcFile := filepath.Join(dir, "move.json")
	if err := os.WriteFile(srcFile, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	dstDir := filepath.Join(dir, "dst")
	if err := os.Mkdir(dstDir, 0755); err != nil {
		t.Fatal(err)
	}
	newFile, err := app.MoveEntry(srcFile, dstDir, "moved.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(srcFile); !os.IsNotExist(err) {
		t.Fatalf("source still exists: %v", err)
	}
	if raw, err := os.ReadFile(newFile); err != nil || string(raw) != "{}" {
		t.Fatalf("moved file = %q, %v", raw, err)
	}

	srcDir := filepath.Join(dir, "folder")
	if err := os.Mkdir(srcDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "inside.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	newDir, err := app.MoveEntry(srcDir, dstDir, "folder2")
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(newDir, "inside.txt")); err != nil || string(raw) != "x" {
		t.Fatalf("moved directory = %q, %v", raw, err)
	}
	if _, err := os.Stat(srcDir); !os.IsNotExist(err) {
		t.Fatalf("source directory still exists: %v", err)
	}
}
