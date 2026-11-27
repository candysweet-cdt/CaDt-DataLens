package plugins

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/executil"
	"datalens/internal/fsops"
	"datalens/internal/vercmp"
)

const (
	pluginManifestName = "plugin.json"
	pluginDefaultEntry = "main.js"
	pluginEntryMaxSize = int64(2 << 20)  // 入口 JS 上限 2 MB
	pluginZipMaxSize   = int64(64 << 20) // 解压总量上限 64 MB
	pluginZipMaxFiles  = 1000
	pluginIconMaxSize  = int64(128 << 10) // 图标上限 128 KB
	pluginAssetMaxSize = int64(16 << 20)  // 图片资产上限 16 MB
	// 数据/模型类资产上限 512 MB（作者拍板）：命令分类器 ONNX 插件的 model_quantized.onnx
	// ≈ 22MB（2026-11-16：原 16MB 图片上限把模型挡在 readAsset 之外，语义层静默熔断退化
	// 为线性层）；给足余量避免下次换更大的模型又触顶。zip 总量上限 64MB 由安装侧兜底，
	// 大模型只能走「首启按需下载到插件目录」路线，不受此限约束。
	pluginDataAssetMaxSize = int64(512 << 20)
)

// OnBulkMutate 应用自身对插件目录的整目录增删（更新替换 / 卸载）前后回调，
// 返回的 done 在操作结束时调用。根壳注入 watch 的静默门（BeginQuiet/EndQuiet）：
// 「删旧目录 → 复制新目录」在 watcher 看来是几十上百条删除事件，不声明就会被
// 工作区破坏防护误判成大范围消失（2026-11-19 插件更新误报实录）。
// 用包级钩子而不是 import watch：本包保持纯引擎、可单独测试。
var OnBulkMutate func() (done func())

// beginBulkMutate 打开静默门，返回收尾函数（钩子未注入时是空操作）。
func beginBulkMutate() func() {
	if OnBulkMutate == nil {
		return func() {}
	}
	done := OnBulkMutate()
	if done == nil {
		return func() {}
	}
	return done
}

var pluginAssetMimeTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",
}

// 数据/模型类资产（与图片共用 ReadPluginAsset 通道）：tokenizer.json / ort.min.js /
// worker.js / model_quantized.onnx 等。扩展名进白名单才可读，防插件目录被当任意文件源。
var pluginDataAssetMimeTypes = map[string]string{
	".json": "application/json",
	".js":   "text/javascript",
	".mjs":  "text/javascript",
	".wasm": "application/wasm",
	".onnx": "application/octet-stream",
	".bin":  "application/octet-stream",
	".gguf": "application/octet-stream",
	".txt":  "text/plain",
	".md":   "text/markdown",
	".csv":  "text/csv",
	".yaml": "text/yaml",
	".yml":  "text/yaml",
}

var (
	pluginIdPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	pluginVersionPattern = regexp.MustCompile(`^\d+(\.\d+){0,2}$`)
)

type pluginManifest struct {
	Id            string   `json:"id"`
	Name          string   `json:"name"`
	Version       string   `json:"version,omitempty"`
	Author        string   `json:"author"`
	Description   string   `json:"description,omitempty"`
	Entry         string   `json:"entry,omitempty"`
	Extensions    []string `json:"extensions,omitempty"`
	Homepage      string   `json:"homepage,omitempty"`
	Repository    string   `json:"repository,omitempty"`
	License       string   `json:"license,omitempty"`
	Keywords      []string `json:"keywords,omitempty"`
	MinAppVersion string   `json:"minAppVersion,omitempty"`
	Icon          string   `json:"icon,omitempty"`
	// Dependencies 声明依赖的其他插件 id（S7）：前端按它排执行顺序，保证「提供服务的插件
	// 先 apply」。这里只做形状校验（id 合法、不依赖自己、去重），拓扑排序与缺失判定在前端
	// 完成——因为「装没装」是前端看到启用列表之后才知道的事。
	Dependencies []string `json:"dependencies,omitempty"`
}

type PluginInfo struct {
	Id            string   `json:"id"`
	Name          string   `json:"name"`
	Version       string   `json:"version,omitempty"`
	Author        string   `json:"author"`
	Description   string   `json:"description,omitempty"`
	Dir           string   `json:"dir"`
	Entry         string   `json:"entry,omitempty"`
	Extensions    []string `json:"extensions,omitempty"`
	Homepage      string   `json:"homepage,omitempty"`
	Repository    string   `json:"repository,omitempty"`
	License       string   `json:"license,omitempty"`
	Keywords      []string `json:"keywords,omitempty"`
	MinAppVersion string   `json:"minAppVersion,omitempty"`
	IconData      string   `json:"iconData,omitempty"`
	Dependencies  []string `json:"dependencies,omitempty"`
	Enabled       bool     `json:"enabled"`
	EntryOK       bool     `json:"entryOk"`
}

type PluginSource struct {
	Id           string   `json:"id"`
	Name         string   `json:"name"`
	Version      string   `json:"version,omitempty"`
	Dir          string   `json:"dir"`
	Code         string   `json:"code"`
	Dependencies []string `json:"dependencies,omitempty"`
}

// pluginsRootFor 返回插件安装根目录：portable = exe 旁 plugins，
// appdata = %APPDATA%\CandySweet\CaDt-DataLens\plugins。
func pluginsRootFor(mode string) (string, error) {
	if mode == "appdata" {
		root := appdata.Root()
		if root == "" {
			return "", appdata.ErrNoRoot
		}
		return filepath.Join(root, "plugins"), nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("无法定位程序目录：%w", err)
	}
	return filepath.Join(filepath.Dir(exe), "plugins"), nil
}

func (pm *Manager) GetPluginsDir() (string, error) {
	return pluginsRootFor(currentPathMode())
}

// EnsureDir 创建插件目录（不存在时），返回目录路径。
// 包级函数而非 Manager 方法：Manager 以服务嵌入 App，导出方法会被提升成
// Wails 绑定——内部助手一律不得写成导出方法（EnsureDir 曾因此误增绑定）。
func EnsureDir() (string, error) {
	dir, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("无法创建插件目录：%w", err)
	}
	return dir, nil
}

// GetPluginsPathMode 返回当前插件目录模式（portable / appdata），供设置面板回显。
func (pm *Manager) GetPluginsPathMode() string {
	mode := currentPathMode()
	if mode != "appdata" {
		return "portable"
	}
	return mode
}

func (pm *Manager) SetPluginsPathMode(mode string) error {
	if mode != "appdata" {
		mode = "portable"
	}
	return savePathMode(mode)
}

func readPluginManifest(dir string) (*pluginManifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, pluginManifestName))
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败：%w", pluginManifestName, err)
	}
	var m pluginManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("%s 不是有效的插件清单：%w", pluginManifestName, err)
	}
	if !pluginIdPattern.MatchString(strings.TrimSpace(m.Id)) {
		return nil, fmt.Errorf("插件 id 无效（只允许小写字母、数字和连字符）：%q", m.Id)
	}
	if strings.TrimSpace(m.Name) == "" {
		return nil, fmt.Errorf("插件 %s 缺少名称", m.Id)
	}
	if strings.TrimSpace(m.Author) == "" {
		return nil, fmt.Errorf("插件 %s 缺少作者（author）", m.Id)
	}
	for _, url := range []string{m.Homepage, m.Repository} {
		if url != "" && !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
			return nil, fmt.Errorf("插件 %s 的链接必须以 http(s):// 开头：%q", m.Id, url)
		}
	}
	if m.MinAppVersion != "" && !pluginVersionPattern.MatchString(strings.TrimSpace(m.MinAppVersion)) {
		return nil, fmt.Errorf("插件 %s 的 minAppVersion 格式无效（如 1.0.0）：%q", m.Id, m.MinAppVersion)
	}
	m.Id = strings.TrimSpace(m.Id)
	m.Author = strings.TrimSpace(m.Author)
	m.MinAppVersion = strings.TrimSpace(m.MinAppVersion)
	// 依赖声明归一（S7）：去空白、去重、保序。形状错误在装载期就拒——等到前端拓扑排序
	// 再报错，用户看到的是「插件被跳过」而不是「清单写错了」，定位成本差一个数量级。
	if len(m.Dependencies) > 0 {
		seen := make(map[string]bool, len(m.Dependencies))
		normalized := make([]string, 0, len(m.Dependencies))
		for _, dep := range m.Dependencies {
			depId := strings.TrimSpace(dep)
			if depId == "" {
				continue
			}
			if !pluginIdPattern.MatchString(depId) {
				return nil, fmt.Errorf("插件 %s 的依赖 id 无效（只允许小写字母、数字和连字符）：%q", m.Id, dep)
			}
			if depId == m.Id {
				return nil, fmt.Errorf("插件 %s 不能依赖自己", m.Id)
			}
			if seen[depId] {
				continue
			}
			seen[depId] = true
			normalized = append(normalized, depId)
		}
		m.Dependencies = normalized
	}
	m.Entry = strings.TrimSpace(m.Entry)
	if m.Entry == "" {
		m.Entry = pluginDefaultEntry
	}
	// entry 必须落在插件目录内且真实存在
	entryPath := filepath.Join(dir, filepath.FromSlash(m.Entry))
	rel, relErr := filepath.Rel(dir, entryPath)
	if relErr != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return nil, fmt.Errorf("插件 %s 的入口文件路径越界：%s", m.Id, m.Entry)
	}
	if info, err := os.Stat(entryPath); err != nil || info.IsDir() {
		return nil, fmt.Errorf("插件 %s 的入口文件不存在：%s", m.Id, m.Entry)
	}
	// 图标可选：相对路径、目录内、png/jpg/svg、≤128KB
	if m.Icon != "" {
		iconPath := filepath.Join(dir, filepath.FromSlash(m.Icon))
		relIcon, relErr := filepath.Rel(dir, iconPath)
		if relErr != nil || strings.HasPrefix(relIcon, "..") || filepath.IsAbs(relIcon) {
			return nil, fmt.Errorf("插件 %s 的图标路径越界：%s", m.Id, m.Icon)
		}
		ext := strings.ToLower(filepath.Ext(iconPath))
		if ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".svg" {
			return nil, fmt.Errorf("插件 %s 的图标仅支持 png/jpg/svg：%s", m.Id, m.Icon)
		}
		if info, err := os.Stat(iconPath); err != nil || info.IsDir() || info.Size() > pluginIconMaxSize {
			return nil, fmt.Errorf("插件 %s 的图标不存在或超过 %d KB：%s", m.Id, pluginIconMaxSize/(1<<10), m.Icon)
		}
	}
	return &m, nil
}

// ReadPluginAsset 读取插件目录内的资产并转为 data URL。
// relPath 相对插件目录，支持图片（16MB 上限）与数据/模型文件（48MB 上限），
// 且不允许越出插件目录。
func (pm *Manager) ReadPluginAsset(id, relPath string) (string, error) {
	id = strings.TrimSpace(id)
	if !pluginIdPattern.MatchString(id) {
		return "", fmt.Errorf("插件 id 无效：%q", id)
	}
	rel := strings.TrimSpace(strings.ReplaceAll(relPath, "\\", "/"))
	if rel == "" {
		return "", fmt.Errorf("资产路径为空")
	}
	if strings.Contains(rel, "\x00") || strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("资产路径无效：%q", relPath)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.Contains(seg, ":") {
			return "", fmt.Errorf("资产路径无效：%q", relPath)
		}
	}
	ext := strings.ToLower(filepath.Ext(rel))
	mime, ok := pluginAssetMimeTypes[ext]
	maxSize := pluginAssetMaxSize
	if !ok {
		mime, ok = pluginDataAssetMimeTypes[ext]
		maxSize = pluginDataAssetMaxSize
	}
	if !ok {
		return "", fmt.Errorf("资产仅支持图片或数据文件格式：%s", relPath)
	}
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return "", err
	}
	pluginDir := filepath.Join(root, id)
	if info, statErr := os.Stat(pluginDir); statErr != nil || !info.IsDir() {
		return "", fmt.Errorf("插件不存在：%s", id)
	}
	if info, statErr := os.Stat(filepath.Join(pluginDir, pluginManifestName)); statErr != nil || info.IsDir() {
		return "", fmt.Errorf("插件不存在：%s", id)
	}
	realDir, err := filepath.EvalSymlinks(pluginDir)
	if err != nil {
		return "", fmt.Errorf("读取插件目录失败：%w", err)
	}
	realTarget, err := filepath.EvalSymlinks(filepath.Join(pluginDir, filepath.FromSlash(rel)))
	if err != nil {
		return "", fmt.Errorf("资产不存在：%s", relPath)
	}
	inside, err := filepath.Rel(realDir, realTarget)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(os.PathSeparator)) || filepath.IsAbs(inside) {
		return "", fmt.Errorf("资产路径越界：%s", relPath)
	}
	info, err := os.Stat(realTarget)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("资产不存在：%s", relPath)
	}
	if info.Size() > maxSize {
		return "", fmt.Errorf("资产过大（超过 %d MB）", maxSize/(1<<20))
	}
	raw, err := os.ReadFile(realTarget)
	if err != nil {
		return "", fmt.Errorf("读取资产失败：%w", err)
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

// pluginIconData 读取插件图标并转为 data URL；无图标时返回空串。
func pluginIconData(dir string, m *pluginManifest) string {
	if m.Icon == "" {
		return ""
	}
	iconPath := filepath.Join(dir, filepath.FromSlash(m.Icon))
	raw, err := os.ReadFile(iconPath)
	if err != nil || int64(len(raw)) > pluginIconMaxSize {
		return ""
	}
	var mime string
	switch strings.ToLower(filepath.Ext(iconPath)) {
	case ".png":
		mime = "image/png"
	case ".jpg", ".jpeg":
		mime = "image/jpeg"
	case ".svg":
		mime = "image/svg+xml"
	default:
		return ""
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

func listPluginsAt(root string, disabled map[string]bool) ([]*PluginInfo, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []*PluginInfo{}, nil
		}
		return nil, err
	}
	plugins := []*PluginInfo{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		m, err := readPluginManifest(dir)
		if err != nil {
			continue // 非法目录跳过
		}
		entryPath := filepath.Join(dir, filepath.FromSlash(m.Entry))
		entryOK := false
		if info, statErr := os.Stat(entryPath); statErr == nil && !info.IsDir() && info.Size() <= pluginEntryMaxSize {
			entryOK = true
		}
		plugins = append(plugins, &PluginInfo{
			Id:            m.Id,
			Name:          m.Name,
			Version:       m.Version,
			Author:        m.Author,
			Description:   m.Description,
			Dir:           dir,
			Entry:         m.Entry,
			Extensions:    m.Extensions,
			Homepage:      m.Homepage,
			Repository:    m.Repository,
			License:       m.License,
			Keywords:      m.Keywords,
			MinAppVersion: m.MinAppVersion,
			IconData:      pluginIconData(dir, m),
			Dependencies:  m.Dependencies,
			Enabled:       !disabled[m.Id],
			EntryOK:       entryOK,
		})
	}
	sort.Slice(plugins, func(i, j int) bool { return plugins[i].Id < plugins[j].Id })
	return plugins, nil
}

func installPluginAt(root, srcDir string) (*PluginInfo, error) {
	m, err := readPluginManifest(srcDir)
	if err != nil {
		return nil, err
	}
	dest := filepath.Join(root, m.Id)
	if _, err := os.Stat(dest); err == nil {
		return nil, fmt.Errorf("插件 %s（%s）已存在，请先删除再安装", m.Id, m.Name)
	}
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, err
	}
	info, err := os.Stat(srcDir)
	if err != nil {
		return nil, err
	}
	if err := fsops.CopyTree(srcDir, dest, info); err != nil {
		os.RemoveAll(dest)
		return nil, fmt.Errorf("复制插件文件失败：%w", err)
	}
	entryOK := false
	if stat, statErr := os.Stat(filepath.Join(dest, filepath.FromSlash(m.Entry))); statErr == nil && !stat.IsDir() {
		entryOK = stat.Size() <= pluginEntryMaxSize
	}
	return &PluginInfo{
		Id:            m.Id,
		Name:          m.Name,
		Version:       m.Version,
		Author:        m.Author,
		Description:   m.Description,
		Dir:           dest,
		Entry:         m.Entry,
		Extensions:    m.Extensions,
		Homepage:      m.Homepage,
		Repository:    m.Repository,
		License:       m.License,
		Keywords:      m.Keywords,
		MinAppVersion: m.MinAppVersion,
		IconData:      pluginIconData(dest, m),
		Enabled:       true,
		EntryOK:       entryOK,
	}, nil
}

// extractPluginZip 把 zip 解压到 dest，返回包含 plugin.json 的目录。
func extractPluginZip(zipPath, dest string) (string, error) {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", fmt.Errorf("无法读取 zip 文件：%w", err)
	}
	defer reader.Close()
	if len(reader.File) > pluginZipMaxFiles {
		return "", fmt.Errorf("压缩包文件数超过 %d，拒绝解压", pluginZipMaxFiles)
	}
	var total int64
	for _, f := range reader.File {
		name := f.Name
		slashed := filepath.ToSlash(name)
		if strings.Contains(slashed, "\\") || strings.HasPrefix(slashed, "/") || strings.Contains(slashed, "//") {
			return "", fmt.Errorf("压缩包含非法路径：%q", name)
		}
		for _, seg := range strings.Split(slashed, "/") {
			if seg == "" || seg == ".." || seg == "." || strings.Contains(seg, ":") {
				return "", fmt.Errorf("压缩包含非法路径：%q", name)
			}
		}
		if f.Mode()&os.ModeDir != 0 || strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(filepath.Join(dest, filepath.FromSlash(slashed)), 0o755); err != nil {
				return "", err
			}
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > pluginZipMaxSize {
			return "", fmt.Errorf("压缩包解压总量超过 %d MB，拒绝解压", pluginZipMaxSize/(1<<20))
		}
		src, err := f.Open()
		if err != nil {
			return "", err
		}
		target := filepath.Join(dest, filepath.FromSlash(slashed))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			src.Close()
			return "", err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			src.Close()
			return "", err
		}
		_, err = io.Copy(out, src)
		closeErr := out.Close()
		src.Close()
		if err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	// plugin.json 在包根，或在唯一顶层目录里
	if _, err := os.Stat(filepath.Join(dest, pluginManifestName)); err == nil {
		return dest, nil
	}
	top, err := os.ReadDir(dest)
	if err != nil {
		return "", err
	}
	if len(top) == 1 && top[0].IsDir() {
		sub := filepath.Join(dest, top[0].Name())
		if _, err := os.Stat(filepath.Join(sub, pluginManifestName)); err == nil {
			return sub, nil
		}
	}
	return "", fmt.Errorf("压缩包里没有找到 %s，不是有效的插件包", pluginManifestName)
}

func importPluginZipAt(root, zipPath string) (*PluginInfo, error) {
	tmp, err := os.MkdirTemp("", "cadt-plugin-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	srcDir, err := extractPluginZip(zipPath, tmp)
	if err != nil {
		return nil, err
	}
	return installPluginAt(root, srcDir)
}

// InstallPluginFromUrl 用系统 git 浅克隆插件仓库并安装；支持 https(s) 与 git@ 地址。
func (pm *Manager) InstallPluginFromUrl(rawUrl string) (*PluginInfo, error) {
	if strings.TrimSpace(rawUrl) == "" {
		return nil, nil
	}
	srcDir, cleanup, err := clonePluginRepo(rawUrl)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return nil, err
	}
	return installPluginAt(root, srcDir)
}

// UpdatePluginFromUrl 拉取仓库最新版本并替换已安装的同 id 插件；失败时恢复旧版本。
func (pm *Manager) UpdatePluginFromUrl(id, rawUrl string) (*PluginInfo, error) {
	id = strings.TrimSpace(id)
	if !pluginIdPattern.MatchString(id) {
		return nil, fmt.Errorf("插件 id 无效：%q", id)
	}
	srcDir, cleanup, err := clonePluginRepo(rawUrl)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	m, err := readPluginManifest(srcDir)
	if err != nil {
		return nil, err
	}
	if m.Id != id {
		return nil, fmt.Errorf("仓库插件 id 为 %s，与要更新的插件 %s 不一致", m.Id, id)
	}
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return nil, err
	}
	disabled := map[string]bool{}
	for _, item := range disabledPluginList() {
		disabled[item] = true
	}
	plugins, err := listPluginsAt(root, disabled)
	if err != nil {
		return nil, err
	}
	var current *PluginInfo
	for _, p := range plugins {
		if p.Id == id {
			current = p
			break
		}
	}
	if current == nil {
		return nil, fmt.Errorf("插件 %s 尚未安装", id)
	}
	if m.Version != "" && current.Version != "" && comparePluginVersion(m.Version, current.Version) <= 0 {
		return nil, fmt.Errorf("已是最新版本（当前 v%s）", current.Version)
	}
	if err := replacePluginDir(current.Dir, srcDir); err != nil {
		return nil, err
	}
	logf("info", "插件已更新：%s %s → %s", m.Name, current.Version, m.Version)
	if refreshed, err := listPluginsAt(root, disabled); err == nil {
		for _, p := range refreshed {
			if p.Id == id {
				return p, nil
			}
		}
	}
	return &PluginInfo{
		Id: m.Id, Name: m.Name, Version: m.Version, Author: m.Author, Description: m.Description,
		Dir: current.Dir, Entry: m.Entry, Extensions: m.Extensions, Homepage: m.Homepage,
		Repository: m.Repository, License: m.License, Keywords: m.Keywords,
		MinAppVersion: m.MinAppVersion, Enabled: !disabled[id], EntryOK: true,
	}, nil
}

// clonePluginRepo 浅克隆插件仓库，返回包含 plugin.json 的目录与清理函数。
func clonePluginRepo(rawUrl string) (string, func(), error) {
	urlStr := strings.TrimSpace(rawUrl)
	if urlStr == "" {
		return "", func() {}, fmt.Errorf("仓库地址为空")
	}
	if strings.HasPrefix(urlStr, "git@") {
		urlStr = strings.TrimPrefix(urlStr, "git@")
		urlStr = strings.Replace(urlStr, ":", "/", 1)
		urlStr = "https://" + urlStr
	}
	if !strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://") {
		urlStr = "https://" + strings.TrimPrefix(urlStr, "//")
	}
	urlStr = strings.TrimRight(urlStr, "/")
	if !strings.Contains(strings.TrimPrefix(strings.TrimPrefix(urlStr, "https://"), "http://"), "/") {
		return "", func() {}, fmt.Errorf("不是有效的仓库地址：%s", urlStr)
	}
	if !strings.HasSuffix(urlStr, ".git") {
		urlStr += ".git"
	}
	if _, err := exec.LookPath("git"); err != nil {
		return "", func() {}, fmt.Errorf("未安装 git 或未加入 PATH，无法从仓库地址安装")
	}
	tmp, err := os.MkdirTemp("", "cadt-plugin-repo-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cloneCmd := exec.CommandContext(ctx, "git", "clone", "--depth", "1", "--single-branch", urlStr, filepath.Join(tmp, "repo"))
	executil.HideCommandWindow(cloneCmd) // 防黑窗；平台差异收在 executil 里，本包保持可交叉编译
	if out, cloneErr := cloneCmd.CombinedOutput(); cloneErr != nil {
		cleanup()
		if ctx.Err() != nil {
			return "", func() {}, fmt.Errorf("克隆超时（90 秒）")
		}
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = cloneErr.Error()
		}
		return "", func() {}, fmt.Errorf("克隆失败：%s", msg)
	}
	repoDir := filepath.Join(tmp, "repo")
	var srcDir string
	if _, err := os.Stat(filepath.Join(repoDir, pluginManifestName)); err == nil {
		srcDir = repoDir
	} else {
		top, readErr := os.ReadDir(repoDir)
		if readErr == nil && len(top) == 1 && top[0].IsDir() {
			sub := filepath.Join(repoDir, top[0].Name())
			if _, err2 := os.Stat(filepath.Join(sub, pluginManifestName)); err2 == nil {
				srcDir = sub
			}
		}
	}
	if srcDir == "" {
		cleanup()
		return "", func() {}, fmt.Errorf("仓库里没有找到 %s，不是有效的插件仓库", pluginManifestName)
	}
	return srcDir, cleanup, nil
}

// replacePluginDir 用新目录内容替换已安装插件目录；失败时恢复旧内容。
// 整目录删除再复制期间打开静默门：这不是工作区破坏，别让 wipe-guard 当成文件消失。
func replacePluginDir(destDir, srcDir string) error {
	defer beginBulkMutate()()
	backupRoot, err := os.MkdirTemp("", "cadt-plugin-backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(backupRoot)
	backupDir := filepath.Join(backupRoot, "plugin")
	info, err := os.Stat(destDir)
	if err != nil {
		return fmt.Errorf("读取已安装插件失败：%w", err)
	}
	if err := fsops.CopyTree(destDir, backupDir, info); err != nil {
		return fmt.Errorf("备份当前插件失败：%w", err)
	}
	srcInfo, err := os.Stat(srcDir)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(destDir); err != nil {
		return fmt.Errorf("移除旧插件失败：%w", err)
	}
	if err := fsops.CopyTree(srcDir, destDir, srcInfo); err != nil {
		_ = os.RemoveAll(destDir)
		if restoreErr := fsops.CopyTree(backupDir, destDir, info); restoreErr != nil {
			return fmt.Errorf("更新失败且恢复旧版本失败：%v（恢复错误：%v）", err, restoreErr)
		}
		return fmt.Errorf("更新失败，已恢复旧版本：%w", err)
	}
	return nil
}

// comparePluginVersion 比较数字版本号，返回 -1/0/1。
func comparePluginVersion(a, b string) int {
	return vercmp.Compare(a, b)
}

func pluginSourceAt(dir string, m *pluginManifest) (*PluginSource, error) {
	entryPath := filepath.Join(dir, filepath.FromSlash(m.Entry))
	info, err := os.Stat(entryPath)
	if err != nil {
		return nil, err
	}
	if info.Size() > pluginEntryMaxSize {
		return nil, fmt.Errorf("插件 %s 的入口文件超过 %d MB", m.Id, pluginEntryMaxSize/(1<<20))
	}
	raw, err := os.ReadFile(entryPath)
	if err != nil {
		return nil, err
	}
	return &PluginSource{
		Id:           m.Id,
		Name:         m.Name,
		Version:      m.Version,
		Dir:          dir,
		Code:         string(raw),
		Dependencies: m.Dependencies,
	}, nil
}

func (pm *Manager) GetPlugins() ([]*PluginInfo, error) {
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return nil, err
	}
	disabled := map[string]bool{}
	for _, id := range disabledPluginList() {
		disabled[id] = true
	}
	return listPluginsAt(root, disabled)
}

// InstallFromFolder 把本地插件文件夹安装到当前插件目录。
func InstallFromFolder(dir string) (*PluginInfo, error) {
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return nil, err
	}
	return installPluginAt(root, dir)
}

// ImportZipPaths 逐个导入插件 zip；最后一个成功安装的结果作为返回值。
func ImportZipPaths(paths []string) (*PluginInfo, error) {
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return nil, err
	}
	var last *PluginInfo
	for _, path := range paths {
		installed, err := importPluginZipAt(root, path)
		if err != nil {
			return last, fmt.Errorf("%s：%w", filepath.Base(path), err)
		}
		last = installed
	}
	return last, nil
}

func (pm *Manager) DeletePlugin(id string) error {
	if !pluginIdPattern.MatchString(strings.TrimSpace(id)) {
		return fmt.Errorf("插件 id 无效：%q", id)
	}
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return err
	}
	// 用户主动卸载：整目录删除同样打开静默门（卸载不是工作区破坏）。
	done := beginBulkMutate()
	if err := os.RemoveAll(filepath.Join(root, id)); err != nil {
		done()
		return err
	}
	done()
	disabled := disabledPluginList()
	kept := make([]string, 0, len(disabled))
	for _, item := range disabled {
		if item != id {
			kept = append(kept, item)
		}
	}
	return saveDisabledPlugins(kept)
}

func (pm *Manager) SetPluginEnabled(id string, enabled bool) error {
	if !pluginIdPattern.MatchString(strings.TrimSpace(id)) {
		return fmt.Errorf("插件 id 无效：%q", id)
	}
	disabled := disabledPluginList()
	set := map[string]bool{}
	for _, item := range disabled {
		set[item] = true
	}
	if enabled {
		delete(set, id)
	} else {
		set[id] = true
	}
	kept := make([]string, 0, len(set))
	for _, item := range disabled {
		if set[item] {
			kept = append(kept, item)
			delete(set, item)
		}
	}
	for item := range set {
		kept = append(kept, item)
	}
	sort.Strings(kept)
	return saveDisabledPlugins(kept)
}

func (pm *Manager) GetPluginSources() ([]PluginSource, error) {
	root, err := pluginsRootFor(currentPathMode())
	if err != nil {
		return nil, err
	}
	disabled := map[string]bool{}
	for _, id := range disabledPluginList() {
		disabled[id] = true
	}
	plugins, err := listPluginsAt(root, disabled)
	if err != nil {
		return nil, err
	}
	sources := []PluginSource{}
	for _, p := range plugins {
		if !p.Enabled || !p.EntryOK {
			continue
		}
		// Dependencies 必须带过来：前端按它做拓扑排序。漏掉的话前端拿到的永远是空数组，
		// 「被依赖者先 apply」静默退化成「按目录名排」，inject 只能等超时。
		m := &pluginManifest{
			Id: p.Id, Name: p.Name, Version: p.Version, Entry: p.Entry,
			Dependencies: p.Dependencies,
		}
		source, err := pluginSourceAt(p.Dir, m)
		if err != nil {
			continue
		}
		sources = append(sources, *source)
	}
	return sources, nil
}
