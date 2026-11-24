package fileio

// 文件读写与编码：打开/保存（含外部修改校验）、图片与二进制判定、编码探测与转换。
// 系统对话框与 App 生命周期留在根壳（app_dialogs.go / app_window.go）。

import (
	"bytes"
	"datalens/internal/chardec"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Files 文件读写引擎（无状态）。
type Files struct{}

const (
	largeFileBytes    = 10 << 20
	maxFileBytes      = 100 << 20
	imagePreviewLimit = 32 << 20
)

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
	Video    bool   `json:"video,omitempty"`
	Audio    bool   `json:"audio,omitempty"`
	IsDir    bool   `json:"isDir"`
	HexShown int64  `json:"hexShown,omitempty"`
	Mtime    string `json:"mtime,omitempty"`
}

func (f *Files) OpenFile(path string, enc string) (*FileData, error) {
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
	ext := strings.ToLower(filepath.Ext(path))
	imageFile := isImageFile(path, raw)
	videoFile := isVideoFile(path, raw)
	audioFile := isAudioFile(path, raw)
	// 三个标记互斥，优先级 视频 > 图片 > 音频：扩展名明确是视频容器时优先视频（HEVC
	// 品牌位也可能出现在 MP4 里，isImageFile 会把它当 HEIF 静态图）；扩展名明确是音频
	// 容器时优先音频（.ogg / .weba 等与视频共享魔数家族时按扩展名裁决）。
	if videoFile && videoExtensions[ext] {
		imageFile = false
		audioFile = false
	} else if imageFile {
		videoFile = false
		audioFile = false
	} else if audioFile && audioExtensions[ext] {
		videoFile = false
		imageFile = false
	} else {
		audioFile = false
	}
	if strings.EqualFold(ext, ".bin") || imageFile || videoFile || chardec.LooksBinary(raw) {
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
			Video:    videoFile,
			Audio:    audioFile,
			HexShown: int64(shown),
			Mtime:    formatFileMtime(info.ModTime()),
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
	text, usedEnc, err := chardec.DecodeBytes(raw, enc)
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
		Mtime:   formatFileMtime(info.ModTime()),
	}, nil
}

var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".jfif": true, ".gif": true, ".bmp": true,
	".webp": true, ".ico": true, ".tif": true, ".tiff": true, ".avif": true, ".heic": true,
	".heif": true, ".psd": true, ".raw": true, ".cr2": true, ".nef": true, ".arw": true, ".dng": true,
	// 注意：.svg 刻意不在本表——本表同时驱动 OpenFile 的二进制/图片分类，
	// SVG 要按文本/XML 进编辑器；读图链路对 svg 的放行见 ReadImageAsDataURL。
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

// videoExtensions：走「视频视图」的容器扩展名。
var videoExtensions = map[string]bool{
	".mp4": true, ".m4v": true, ".webm": true, ".mov": true, ".mkv": true,
}

// isVideoFile 判定能否进视频视图：扩展名命中，或 ISO BMFF（ftyp 品牌）/ EBML 容器头。
// 这里只回答「像不像视频」，能不能解码由 WebView2 决定（失败时前端回退二进制视图）。
func isVideoFile(path string, raw []byte) bool {
	if videoExtensions[strings.ToLower(filepath.Ext(path))] {
		return true
	}
	// ISO BMFF（MP4 / MOV / M4V）：box 头 "ftyp" + 品牌位
	if len(raw) >= 12 && string(raw[4:8]) == "ftyp" {
		switch string(raw[8:12]) {
		case "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash",
			"M4V ", "M4VH", "M4VP", "qt  ", "mmp4", "f4v ", "3gp4", "3gp5", "MSNV":
			return true
		}
	}
	// EBML 头（WebM / Matroska）
	if len(raw) >= 4 && raw[0] == 0x1A && raw[1] == 0x45 && raw[2] == 0xDF && raw[3] == 0xA3 {
		return true
	}
	return false
}

// audioExtensions：走「音频视图」的容器扩展名。与前端 core/formats.js 的 audioExtensions 同表；
// 只收 WebView2 能解码的格式（wav / mp3 / ogg / opus / flac / m4a / aac / weba），
// .wma、.mid 这类 WebView2 解不了的故意不收——进来也只会得到一条错误再回退二进制视图。
var audioExtensions = map[string]bool{
	".wav": true, ".mp3": true, ".ogg": true, ".oga": true, ".opus": true,
	".flac": true, ".m4a": true, ".aac": true, ".weba": true,
}

// isAudioFile 判定能否进音频视图：扩展名命中，或 RIFF-WAVE / fLaC / OggS / ID3 /
// MP3 帧同步等音频魔数。能不能解码由 WebView2 决定（失败时前端回退二进制视图）。
func isAudioFile(path string, raw []byte) bool {
	if audioExtensions[strings.ToLower(filepath.Ext(path))] {
		return true
	}
	// RIFF 容器：WAVE 是音频（WEBP 已在 isImageFile 处理）
	if len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WAVE" {
		return true
	}
	// FLAC：ASCII "fLaC"
	if len(raw) >= 4 && string(raw[:4]) == "fLaC" {
		return true
	}
	// Ogg 容器（ogg / oga / opus / weba 共用）
	if len(raw) >= 4 && string(raw[:4]) == "OggS" {
		return true
	}
	// MP3：ID3v2 标签（裸帧流没有可靠的文件头，只靠 .mp3 扩展名兜底，避免误判随机二进制）
	if len(raw) >= 3 && string(raw[:3]) == "ID3" {
		return true
	}
	return false
}

const imageHexLimit = 1 << 20

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

// ReadImageAsDataURL 读取本地图片为 data URL（Markdown 预览与 AI 附件走同一条链）。
func (f *Files) ReadImageAsDataURL(path string) (string, error) {
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
	// SVG 是文本：imageExtensions 不收它（避免影响 OpenFile 分类），读图链路按扩展名单独放行。
	if !isImageFile(path, raw) && !strings.EqualFold(filepath.Ext(path), ".svg") {
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
	case ".svg":
		return "image/svg+xml"
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

// videoPreviewLimit 是视频读为 data URL 的文件上限（16 MB）：视频不做降质/截帧，
// base64 后约 22 MB 字符串，与前端 AI_VIDEO_MAX_INPUT_BYTES、传输层 aiMaxVideoBase64 对齐。
const videoPreviewLimit = 16 << 20

// ReadVideoAsDataURL 读取本地 mp4 视频为 data URL（AI 的视频附件与 read_video 工具走同一条链）。
// 只收 mp4：其他容器（webm / mov / avi）各家网关支持参差，先不放行。
func (f *Files) ReadVideoAsDataURL(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("没有视频路径")
	}
	if !strings.EqualFold(filepath.Ext(path), ".mp4") {
		return "", fmt.Errorf("不支持的视频格式（当前仅支持 mp4）")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("不是视频文件")
	}
	if info.Size() > videoPreviewLimit {
		return "", fmt.Errorf("视频超过 16 MB，无法随对话发送（请先压缩）")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(raw) < 12 || string(raw[4:8]) != "ftyp" {
		return "", fmt.Errorf("不是有效的 mp4 文件")
	}
	return "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func (f *Files) SaveFile(path, content, eol string, hasBom bool, enc string) error {
	if path == "" {
		return fmt.Errorf("没有目标文件")
	}
	raw, err := chardec.BuildSaveBytes(content, eol, hasBom, enc)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

// formatFileMtime 把修改时间格式化为纳秒字符串：JS 的 Number 存不下 1e18 级整数，
// 用字符串透传保证前后端比较精确。
func formatFileMtime(t time.Time) string {
	return strconv.FormatInt(t.UnixNano(), 10)
}

// FileStatInfo 文件磁盘状态（外部修改检测用）。
type FileStatInfo struct {
	Exists bool   `json:"exists"`
	Mtime  string `json:"mtime"`
	Size   int64  `json:"size"`
}

// GetFileStat 返回文件当前修改时间（UnixNano 字符串）；文件不存在时 Exists=false。
func (f *Files) GetFileStat(path string) (*FileStatInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("缺少文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &FileStatInfo{}, nil
		}
		return nil, err
	}
	return &FileStatInfo{Exists: true, Mtime: formatFileMtime(info.ModTime()), Size: info.Size()}, nil
}

// SaveFileResult 保存结果：Conflict=true 表示磁盘已被外部修改，本次未写入。
type SaveFileResult struct {
	OK       bool   `json:"ok"`
	Conflict bool   `json:"conflict"`
	Deleted  bool   `json:"deleted,omitempty"`
	Mtime    string `json:"mtime,omitempty"`
}

// SaveFileChecked 与 SaveFile 相同，但写入前校验磁盘 mtime：
// expectMtime 非空且与当前磁盘不一致时不写入并返回 Conflict，避免覆盖外部修改；
// expectMtime 为空表示不校验（新建 / 另存为 / 用户选择强制覆盖）。
func (f *Files) SaveFileChecked(path, content, eol string, hasBom bool, enc string, expectMtime string) (*SaveFileResult, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目标文件")
	}
	raw, err := chardec.BuildSaveBytes(content, eol, hasBom, enc)
	if err != nil {
		return nil, err
	}
	if expect := strings.TrimSpace(expectMtime); expect != "" {
		info, statErr := os.Stat(path)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return &SaveFileResult{Conflict: true, Deleted: true}, nil
			}
			return nil, statErr
		}
		if formatFileMtime(info.ModTime()) != expect {
			return &SaveFileResult{Conflict: true, Mtime: formatFileMtime(info.ModTime())}, nil
		}
	}
	if err := os.WriteFile(path, raw, 0644); err != nil {
		return nil, err
	}
	result := &SaveFileResult{OK: true}
	if info, statErr := os.Stat(path); statErr == nil {
		result.Mtime = formatFileMtime(info.ModTime())
	}
	return result, nil
}

func (f *Files) CheckEncoding(content string, enc string) bool {
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
	return chardec.CanEncode(content, enc)
}
