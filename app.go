package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	largeFileBytes    = 10 << 20
	maxFileBytes      = 100 << 20
	imagePreviewLimit = 32 << 20
)

type App struct {
	ctx            context.Context
	startupTargets []OpenTarget
	dirty          bool
	forceClose     bool
}

type OpenTarget struct {
	Path   string `json:"path"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

type FileData struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Content  string `json:"content"`
	Size     int64  `json:"size"`
	Eol      string `json:"eol"`
	HasBom   bool   `json:"hasBom"`
	Large    bool   `json:"large"`
	Enc      string `json:"enc"`
	Binary   bool   `json:"binary"`
	Image    bool   `json:"image,omitempty"`
	IsDir    bool   `json:"isDir"`
	HexShown int64  `json:"hexShown,omitempty"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startupTargets = parseOpenTargets(os.Args[1:])
	runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
		if targets := parseOpenTargets(paths); len(targets) > 0 {
			runtime.EventsEmit(ctx, "open-targets", targets)
		}
	})
}

func (a *App) secondInstance(data options.SecondInstanceData) {
	if targets := parseOpenTargets(data.Args); len(targets) > 0 {
		runtime.EventsEmit(a.ctx, "open-targets", targets)
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

func positiveInt(value string) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func splitPathLine(arg string) (string, int, int, bool) {
	lastColon := strings.LastIndex(arg, ":")
	if lastColon <= 0 {
		return "", 0, 0, false
	}
	line, err := strconv.Atoi(arg[lastColon+1:])
	if err != nil || line <= 0 {
		return "", 0, 0, false
	}
	prefix := arg[:lastColon]
	if _, err := os.Stat(prefix); err == nil {
		return prefix, line, 0, true
	}
	prevColon := strings.LastIndex(prefix, ":")
	if prevColon <= 0 {
		return "", 0, 0, false
	}
	middle, err := strconv.Atoi(prefix[prevColon+1:])
	if err != nil || middle <= 0 {
		return "", 0, 0, false
	}
	path := prefix[:prevColon]
	if _, err := os.Stat(path); err == nil {
		return path, middle, line, true
	}
	return "", 0, 0, false
}

func parseOpenTargets(args []string) []OpenTarget {
	exe, _ := os.Executable()
	targets := []OpenTarget{}
	pendingLine, pendingColumn := 0, 0
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "" || strings.EqualFold(arg, exe) || arg == "--new-window" {
			continue
		}
		if arg == "--goto" || arg == "-g" {
			continue
		}
		if strings.HasPrefix(arg, "--line=") {
			pendingLine = positiveInt(strings.TrimPrefix(arg, "--line="))
			continue
		}
		if arg == "--line" || arg == "-l" {
			if i+1 < len(args) {
				i++
				pendingLine = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "--column=") {
			pendingColumn = positiveInt(strings.TrimPrefix(arg, "--column="))
			continue
		}
		if arg == "--column" || arg == "-c" {
			if i+1 < len(args) {
				i++
				pendingColumn = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		path := arg
		line, column := pendingLine, pendingColumn
		if _, err := os.Stat(path); err != nil {
			if p, l, c, ok := splitPathLine(arg); ok {
				path = p
				line = l
				if c > 0 {
					column = c
				}
			}
		}
		if _, err := os.Stat(path); err != nil {
			continue
		}
		targets = append(targets, OpenTarget{Path: path, Line: line, Column: column})
		pendingLine, pendingColumn = 0, 0
	}
	if len(targets) > 0 {
		last := &targets[len(targets)-1]
		if pendingLine > 0 && last.Line == 0 {
			last.Line = pendingLine
		}
		if pendingColumn > 0 && last.Column == 0 {
			last.Column = pendingColumn
		}
	}
	return targets
}

func (a *App) GetStartupTargets() []OpenTarget {
	if a.startupTargets == nil {
		return []OpenTarget{}
	}
	return a.startupTargets
}

func (a *App) GetStartupFiles() []string {
	files := make([]string, 0, len(a.startupTargets))
	for _, target := range a.startupTargets {
		files = append(files, target.Path)
	}
	return files
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
	imageFile := isImageFile(path, raw)
	if strings.EqualFold(filepath.Ext(path), ".bin") || imageFile || looksBinary(raw) {
		shown := len(raw)
		if shown > imageHexLimit {
			shown = imageHexLimit
		}
		return &FileData{
			Path:     path,
			Name:     name,
			Content:  imageHexDump(raw),
			Size:     info.Size(),
			Eol:      "lf",
			Enc:      "binary",
			Binary:   true,
			Image:    imageFile,
			HexShown: int64(shown),
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

func looksBinary(raw []byte) bool {
	sample := raw
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	if len(sample) == 0 {
		return false
	}
	control := 0
	for _, b := range sample {
		if b == 0 {
			return true
		}
		if b == '\t' || b == '\n' || b == '\r' {
			continue
		}
		if b < 0x20 || b == 0x7F {
			control++
		}
	}
	return control*10 > len(sample)
}

func imageHexDump(raw []byte) string {
	shown := len(raw)
	if shown > imageHexLimit {
		shown = imageHexLimit
	}
	var b strings.Builder
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
	return strings.TrimSuffix(b.String(), "\n")
}

func (a *App) ReadImageDataURL(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("没有图片路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("不是图片文件")
	}
	if info.Size() > imagePreviewLimit {
		return "", fmt.Errorf("图片超过 32 MB，无法直接预览")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !isImageFile(path, raw) {
		return "", fmt.Errorf("不是可预览的图片")
	}
	mime := http.DetectContentType(raw)
	if !strings.HasPrefix(mime, "image/") {
		mime = imageMimeByExtension(path)
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func imageMimeByExtension(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg", ".jfif":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".bmp":
		return "image/bmp"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".tif", ".tiff":
		return "image/tiff"
	case ".avif":
		return "image/avif"
	case ".heic", ".heif":
		return "image/heic"
	case ".psd":
		return "image/vnd.adobe.photoshop"
	}
	return ""
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

var reservedEntryNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

func validateEntryName(name string) (string, error) {
	if strings.TrimSpace(name) != name {
		return "", fmt.Errorf("名称不能以空格或制表符开头或结尾")
	}
	trimmed := name
	if trimmed == "" {
		return "", fmt.Errorf("名称不能为空")
	}
	if trimmed == "." || trimmed == ".." {
		return "", fmt.Errorf("名称不能是 . 或 ..")
	}
	if strings.ContainsAny(trimmed, `<>:"/\|?*`) {
		return "", fmt.Errorf("名称不能包含 < > : \" / \\ | ? *")
	}
	for _, r := range trimmed {
		if r < 32 {
			return "", fmt.Errorf("名称不能包含控制字符")
		}
	}
	if strings.HasSuffix(trimmed, ".") {
		return "", fmt.Errorf("名称不能以点结尾")
	}
	stem := strings.TrimSuffix(trimmed, filepath.Ext(trimmed))
	if reservedEntryNames[strings.ToLower(stem)] {
		return "", fmt.Errorf("“%s”是 Windows 保留名称", stem)
	}
	return trimmed, nil
}

func (a *App) CreateEntry(dir, name string, isDir bool) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", dir)
	}
	clean, err := validateEntryName(name)
	if err != nil {
		return "", err
	}
	target := filepath.Join(dir, clean)
	if _, err := os.Stat(target); err == nil {
		return "", fmt.Errorf("“%s”已存在", clean)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if isDir {
		err = os.Mkdir(target, 0o755)
	} else {
		var f *os.File
		f, err = os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			err = f.Close()
		}
	}
	if err != nil {
		return "", err
	}
	return target, nil
}

func (a *App) RenameEntry(path, newName string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	_ = info
	clean, err := validateEntryName(newName)
	if err != nil {
		return "", err
	}
	oldName := filepath.Base(path)
	if clean == oldName {
		return path, nil
	}
	dir := filepath.Dir(path)
	target := filepath.Join(dir, clean)
	if _, err := os.Stat(target); err == nil {
		if !strings.EqualFold(filepath.Clean(target), filepath.Clean(path)) {
			return "", fmt.Errorf("“%s”已存在", clean)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(path, target); err != nil {
		return "", err
	}
	return target, nil
}

func entryExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func pathIsWithin(root, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func (a *App) SuggestCopyName(dir, name string, isDir bool) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目标目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("目标不是目录：%s", dir)
	}
	clean, err := validateEntryName(name)
	if err != nil {
		return "", err
	}
	if !entryExists(filepath.Join(dir, clean)) {
		return clean, nil
	}
	stem, ext := clean, ""
	if !isDir {
		ext = filepath.Ext(clean)
		stem = strings.TrimSuffix(clean, ext)
		if stem == "" {
			stem, ext = clean, ""
		}
	}
	for i := 1; i <= 500; i++ {
		suffix := " - 副本"
		if i > 1 {
			suffix = fmt.Sprintf(" - 副本 %d", i)
		}
		candidate := stem + suffix + ext
		if !entryExists(filepath.Join(dir, candidate)) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("无法生成可用的名称")
}

func resolvePasteTarget(src, destDir, newName string) (string, os.FileInfo, error) {
	src = strings.TrimSpace(src)
	srcInfo, err := os.Stat(src)
	if err != nil {
		return "", nil, err
	}
	destDir = strings.TrimSpace(destDir)
	destInfo, err := os.Stat(destDir)
	if err != nil {
		return "", nil, err
	}
	if !destInfo.IsDir() {
		return "", nil, fmt.Errorf("目标不是目录：%s", destDir)
	}
	clean, err := validateEntryName(newName)
	if err != nil {
		return "", nil, err
	}
	dest := filepath.Join(destDir, clean)
	if strings.EqualFold(filepath.Clean(dest), filepath.Clean(src)) {
		return "", nil, fmt.Errorf("目标与源相同")
	}
	if srcInfo.IsDir() && pathIsWithin(src, dest) {
		return "", nil, fmt.Errorf("不能把文件夹复制或移动到它自己的子目录")
	}
	if entryExists(dest) {
		return "", nil, fmt.Errorf("“%s”已存在", clean)
	}
	return dest, srcInfo, nil
}

func copyEntry(src, dst string, info os.FileInfo) error {
	if info.IsDir() {
		if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childSrc := filepath.Join(src, entry.Name())
			childDst := filepath.Join(dst, entry.Name())
			childInfo, err := os.Stat(childSrc)
			if err != nil {
				return err
			}
			if err := copyEntry(childSrc, childDst, childInfo); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func (a *App) CopyEntry(src, destDir, newName string) (string, error) {
	dest, info, err := resolvePasteTarget(src, destDir, newName)
	if err != nil {
		return "", err
	}
	if err := copyEntry(src, dest, info); err != nil {
		os.RemoveAll(dest)
		return "", err
	}
	return dest, nil
}

func (a *App) MoveEntry(src, destDir, newName string) (string, error) {
	dest, info, err := resolvePasteTarget(src, destDir, newName)
	if err != nil {
		return "", err
	}
	if err := os.Rename(src, dest); err == nil {
		return dest, nil
	}
	if err := copyEntry(src, dest, info); err != nil {
		os.RemoveAll(dest)
		return "", err
	}
	if err := os.RemoveAll(src); err != nil {
		os.RemoveAll(dest)
		return "", fmt.Errorf("移动失败：无法删除源：%w", err)
	}
	return dest, nil
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
