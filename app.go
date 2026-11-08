package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const (
	largeFileBytes = 10 << 20
	maxFileBytes   = 100 << 20
)

type App struct {
	ctx          context.Context
	startupFiles []string
	dirty        bool
	forceClose   bool
}

type FileData struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	Eol     string `json:"eol"`
	HasBom  bool   `json:"hasBom"`
	Large   bool   `json:"large"`
	Enc     string `json:"enc"`
	Binary  bool   `json:"binary"`
	IsDir   bool   `json:"isDir"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startupFiles = pathArgs(os.Args[1:])
	runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
		if files := pathArgs(paths); len(files) > 0 {
			runtime.EventsEmit(ctx, "open-files", files)
		}
	})
}

func (a *App) secondInstance(data options.SecondInstanceData) {
	if files := pathArgs(data.Args); len(files) > 0 {
		runtime.EventsEmit(a.ctx, "open-files", files)
	}
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
}

func pathArgs(args []string) []string {
	exe, _ := os.Executable()
	var paths []string
	for _, arg := range args {
		if arg == "" || strings.HasPrefix(arg, "-") || strings.EqualFold(arg, exe) {
			continue
		}
		if _, err := os.Stat(arg); err == nil {
			paths = append(paths, arg)
		}
	}
	return paths
}

func firstPathArg(args []string) string {
	if paths := pathArgs(args); len(paths) > 0 {
		return paths[0]
	}
	return ""
}

func (a *App) GetStartupFiles() []string {
	if a.startupFiles == nil {
		return []string{}
	}
	return a.startupFiles
}

func (a *App) OpenFile(path string, enc string) (*FileData, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		name := filepath.Base(path)
		if name == "." || name == string(filepath.Separator) || name == "" {
			name = path
		}
		return &FileData{Path: path, Name: name, IsDir: true}, nil
	}
	if info.Size() > maxFileBytes {
		return nil, fmt.Errorf("文件超过 100 MB，拒绝打开：%s", filepath.Base(path))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	name := filepath.Base(path)
	if isImageFile(path, raw) {
		return &FileData{
			Path:    path,
			Name:    name,
			Content: imageHexDump(raw, name),
			Size:    info.Size(),
			Eol:     "lf",
			Enc:     "binary",
			Binary:  true,
		}, nil
	}
	hasBom := len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF
	if hasBom {
		raw = raw[3:]
	}
	eol := "lf"
	if strings.Contains(string(raw), "\r\n") {
		eol = "crlf"
	}
	text, usedEnc, err := decodeBytes(raw, enc)
	if err != nil {
		return nil, err
	}
	return &FileData{
		Path:    path,
		Name:    name,
		Content: text,
		Enc:     usedEnc,
		Size:    info.Size(),
		Eol:     eol,
		HasBom:  hasBom,
		Large:   info.Size() > largeFileBytes,
	}, nil
}

var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".jfif": true, ".gif": true, ".bmp": true,
	".webp": true, ".ico": true, ".tif": true, ".tiff": true, ".avif": true, ".heic": true,
	".heif": true, ".psd": true, ".raw": true, ".cr2": true, ".nef": true, ".arw": true, ".dng": true,
}

func isImageFile(path string, raw []byte) bool {
	if imageExtensions[strings.ToLower(filepath.Ext(path))] {
		return true
	}
	if len(raw) >= 8 && bytes.Equal(raw[:8], []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		return true
	}
	if len(raw) >= 3 && raw[0] == 0xFF && raw[1] == 0xD8 && raw[2] == 0xFF {
		return true
	}
	if len(raw) >= 6 && (string(raw[:6]) == "GIF87a" || string(raw[:6]) == "GIF89a") {
		return true
	}
	if len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WEBP" {
		return true
	}
	if len(raw) >= 4 && bytes.Equal(raw[:4], []byte{0x00, 0x00, 0x01, 0x00}) {
		return true
	}
	if len(raw) >= 4 && (bytes.Equal(raw[:4], []byte{'I', 'I', 0x2A, 0x00}) || bytes.Equal(raw[:4], []byte{'M', 'M', 0x00, 0x2A})) {
		return true
	}
	if len(raw) >= 4 && string(raw[:4]) == "8BPS" {
		return true
	}
	if len(raw) >= 12 && string(raw[4:8]) == "ftyp" {
		brand := string(raw[8:12])
		if brand == "avif" || brand == "avis" || brand == "heic" || brand == "heix" || brand == "hevc" || brand == "mif1" {
			return true
		}
	}
	return false
}

const imageHexLimit = 1 << 20

func imageHexDump(raw []byte, name string) string {
	shown := len(raw)
	truncated := false
	if shown > imageHexLimit {
		shown = imageHexLimit
		truncated = true
	}
	var b strings.Builder
	b.WriteString("// 图片文件：" + name + "\n")
	b.WriteString(fmt.Sprintf("// 文件大小：%d 字节，以十六进制字节数据只读展示\n", len(raw)))
	if truncated {
		b.WriteString(fmt.Sprintf("// 仅展示前 %d 字节\n", shown))
	}
	b.WriteString("\n")
	for off := 0; off < shown; off += 16 {
		end := off + 16
		if end > shown {
			end = shown
		}
		b.WriteString(fmt.Sprintf("%08x  ", off))
		for i := 0; i < 16; i++ {
			if off+i < end {
				b.WriteString(fmt.Sprintf("%02x ", raw[off+i]))
			} else {
				b.WriteString("   ")
			}
			if i == 7 {
				b.WriteString(" ")
			}
		}
		b.WriteString(" |")
		for i := off; i < end; i++ {
			c := raw[i]
			if c >= 32 && c < 127 {
				b.WriteByte(c)
			} else {
				b.WriteByte('.')
			}
		}
		b.WriteString("|\n")
	}
	if truncated {
		b.WriteString("\n// ... 其余字节已截断\n")
	}
	return b.String()
}

func (a *App) SaveFile(path, content, eol string, hasBom bool, enc string) error {
	if path == "" {
		return fmt.Errorf("没有目标文件")
	}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if eol == "crlf" {
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}
	raw, err := encodeString(content, enc)
	if err != nil {
		return err
	}
	if hasBom && (enc == "" || enc == "utf-8" || enc == "auto") {
		raw = append([]byte{0xEF, 0xBB, 0xBF}, raw...)
	}
	return os.WriteFile(path, raw, 0644)
}

func decodeBytes(raw []byte, enc string) (string, string, error) {
	switch enc {
	case "gbk":
		text, err := decodeWith(simplifiedchinese.GBK.NewDecoder(), raw)
		return text, "gbk", err
	case "gb18030":
		text, err := decodeWith(simplifiedchinese.GB18030.NewDecoder(), raw)
		return text, "gb18030", err
	case "iso-8859-1", "us-ascii":
		text, err := decodeWith(charmap.ISO8859_1.NewDecoder(), raw)
		used := enc
		if enc == "us-ascii" {
			used = "us-ascii"
		}
		return text, used, err
	case "utf-8":
		return string(raw), "utf-8", nil
	}
	if utf8.Valid(raw) {
		return string(raw), "utf-8", nil
	}
	if text, err := decodeWith(simplifiedchinese.GBK.NewDecoder(), raw); err == nil {
		return text, "gbk", nil
	}
	return string(raw), "utf-8", nil
}

func decodeWith(dec *encoding.Decoder, raw []byte) (string, error) {
	out, _, err := transform.Bytes(dec, raw)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func encoderFor(enc string) *encoding.Encoder {
	switch enc {
	case "gbk":
		enc := simplifiedchinese.GBK.NewEncoder()
		return enc
	case "gb18030":
		enc := simplifiedchinese.GB18030.NewEncoder()
		return enc
	case "iso-8859-1", "us-ascii":
		enc := charmap.ISO8859_1.NewEncoder()
		return enc
	}
	return nil
}

func encodeString(text, enc string) ([]byte, error) {
	if enc == "us-ascii" {
		for _, r := range text {
			if r > 0x7F {
				return nil, fmt.Errorf("包含非 ASCII 字符，无法用 US-ASCII 编码保存")
			}
		}
		return []byte(text), nil
	}
	encImpl := encoderFor(enc)
	if encImpl == nil {
		return []byte(text), nil
	}
	var buf bytes.Buffer
	writer := transform.NewWriter(&buf, encoding.ReplaceUnsupported(encImpl))
	if _, err := writer.Write([]byte(text)); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (a *App) CheckEncoding(content string, enc string) bool {
	if enc == "utf-8" || enc == "auto" {
		return true
	}
	if enc == "us-ascii" {
		for _, r := range content {
			if r > 0x7F {
				return false
			}
		}
		return true
	}
	encImpl := encoderFor(enc)
	if encImpl == nil {
		return true
	}
	var buf bytes.Buffer
	if _, err := transform.NewWriter(&buf, encImpl).Write([]byte(content)); err != nil {
		return false
	}
	return true
}

func (a *App) OpenFilesDialog() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "打开文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)", Pattern: "*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

func (a *App) OpenFolderDialog(defaultDir string) (string, error) {
	opts := runtime.OpenDialogOptions{Title: "打开文件夹"}
	if strings.TrimSpace(defaultDir) != "" {
		opts.DefaultDirectory = defaultDir
	}
	return runtime.OpenDirectoryDialog(a.ctx, opts)
}

type DirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

type DirListing struct {
	Entries   []DirEntry `json:"entries"`
	Truncated bool       `json:"truncated"`
}

func (a *App) ReadDir(path string, limit int) (*DirListing, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("不是目录：%s", path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	truncated := false
	if len(entries) > limit {
		entries = entries[:limit]
		truncated = true
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, DirEntry{
			Name:  entry.Name(),
			Path:  filepath.Join(path, entry.Name()),
			IsDir: entry.IsDir(),
		})
	}
	return &DirListing{Entries: out, Truncated: truncated}, nil
}

func (a *App) SaveFileDialog(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "保存文件",
		DefaultFilename: defaultName,
		Filters: []runtime.FileFilter{
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

func (a *App) SetDirty(dirty bool) {
	a.dirty = dirty
}

type appConfig struct {
	OpenMode string `json:"openMode"`
}

func webviewDataPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "CaDt-DataLens.exe")
}

func configFilePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "CaDt-DataLens", "config.json")
}

func readOpenMode() string {
	path := configFilePath()
	if path == "" {
		return "tab"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "tab"
	}
	var cfg appConfig
	if json.Unmarshal(raw, &cfg) != nil || cfg.OpenMode != "window" {
		return "tab"
	}
	return "window"
}

func randomLaunchID() string {
	return fmt.Sprintf("cadt-datalens-window-%d-%d", os.Getpid(), time.Now().UnixNano())
}

func uniqueIDForArgs(args []string) string {
	for _, arg := range args {
		if arg == "--new-window" {
			return randomLaunchID()
		}
	}
	if readOpenMode() == "window" {
		return randomLaunchID()
	}
	return "cadt-datalens-7f3a9c21"
}

func uniqueIDForLaunch() string {
	return uniqueIDForArgs(os.Args[1:])
}

func (a *App) GetOpenMode() string {
	return readOpenMode()
}

func (a *App) SetOpenMode(mode string) error {
	if mode != "window" {
		mode = "tab"
	}
	path := configFilePath()
	if path == "" {
		return fmt.Errorf("无法定位配置目录")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(appConfig{OpenMode: mode}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

func (a *App) OpenNewWindow() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--new-window")
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func (a *App) ShowInFolder(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("没有文件路径")
	}
	cmd := exec.Command("explorer.exe", "/select,", path)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func (a *App) CopyText(text string) error {
	return runtime.ClipboardSetText(a.ctx, text)
}

func (a *App) GetClipboardText() (string, error) {
	return runtime.ClipboardGetText(a.ctx)
}

func (a *App) OpenInNewWindows(paths []string) error {
	_ = a.SetOpenMode("window")
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	started := 0
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		cmd := exec.Command(exe, path)
		cmd.Dir = filepath.Dir(path)
		if err := cmd.Start(); err != nil {
			return err
		}
		_ = cmd.Process.Release()
		started++
	}
	if started == 0 {
		return fmt.Errorf("没有可打开的文件")
	}
	return nil
}

func (a *App) SetWindowBg(r, g, b int) {
	clamp := func(v int) uint8 {
		if v < 0 {
			return 0
		}
		if v > 255 {
			return 255
		}
		return uint8(v)
	}
	runtime.WindowSetBackgroundColour(a.ctx, clamp(r), clamp(g), clamp(b), 255)
}

func (a *App) beforeClose(ctx context.Context) bool {
	if !a.dirty || a.forceClose {
		return false
	}
	runtime.EventsEmit(ctx, "confirm-close")
	return true
}

func (a *App) ForceClose() {
	a.forceClose = true
	a.dirty = false
	runtime.Quit(a.ctx)
}
