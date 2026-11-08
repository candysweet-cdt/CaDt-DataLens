package main

import (
	"archive/zip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	pluginManifestName = "plugin.json"
	pluginDefaultEntry = "main.js"
	pluginEntryMaxSize = int64(2 << 20)  // 入口 JS 上限 2 MB
	pluginZipMaxSize   = int64(64 << 20) // 解压总量上限 64 MB
	pluginZipMaxFiles  = 1000
	pluginIconMaxSize  = int64(128 << 10) // 图标上限 128 KB
)

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
	Enabled       bool     `json:"enabled"`
	EntryOK       bool     `json:"entryOk"`
}

type PluginSource struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Dir     string `json:"dir"`
	Code    string `json:"code"`
}

// pluginsRootFor 返回插件安装根目录：portable = exe 旁 plugins，appdata = %APPDATA%。
func pluginsRootFor(mode string) (string, error) {
	if mode == "appdata" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("无法定位应用数据目录：%w", err)
		}
		return filepath.Join(dir, "CaDt-DataLens", "plugins"), nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("无法定位程序目录：%w", err)
	}
	return filepath.Join(filepath.Dir(exe), "plugins"), nil
}

func (a *App) GetPluginsDir() (string, error) {
	return pluginsRootFor(readAppConfig().PluginsPathMode)
}

func (a *App) SetPluginsPathMode(mode string) error {
	if mode != "appdata" {
		mode = "portable"
	}
	cfg := readAppConfig()
	cfg.PluginsPathMode = mode
	return saveAppConfig(cfg)
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
	if err := copyEntry(srcDir, dest, info); err != nil {
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
		Id:      m.Id,
		Name:    m.Name,
		Version: m.Version,
		Dir:     dir,
		Code:    string(raw),
	}, nil
}

func (a *App) GetPlugins() ([]*PluginInfo, error) {
	root, err := pluginsRootFor(readAppConfig().PluginsPathMode)
	if err != nil {
		return nil, err
	}
	cfg := readAppConfig()
	disabled := map[string]bool{}
	for _, id := range cfg.DisabledPlugins {
		disabled[id] = true
	}
	return listPluginsAt(root, disabled)
}

func (a *App) AddPluginFromFolder() (*PluginInfo, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择插件文件夹（内含 plugin.json）",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return nil, nil // 用户取消
	}
	root, err := pluginsRootFor(readAppConfig().PluginsPathMode)
	if err != nil {
		return nil, err
	}
	return installPluginAt(root, dir)
}

func (a *App) ImportPluginFromZip() (*PluginInfo, error) {
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "导入插件包",
		Filters: []runtime.FileFilter{
			{DisplayName: "插件包 (*.zip)", Pattern: "*.zip"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, nil // 用户取消
	}
	root, err := pluginsRootFor(readAppConfig().PluginsPathMode)
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

func (a *App) DeletePlugin(id string) error {
	if !pluginIdPattern.MatchString(strings.TrimSpace(id)) {
		return fmt.Errorf("插件 id 无效：%q", id)
	}
	root, err := pluginsRootFor(readAppConfig().PluginsPathMode)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(root, id)); err != nil {
		return err
	}
	cfg := readAppConfig()
	kept := cfg.DisabledPlugins[:0]
	for _, item := range cfg.DisabledPlugins {
		if item != id {
			kept = append(kept, item)
		}
	}
	cfg.DisabledPlugins = kept
	return saveAppConfig(cfg)
}

func (a *App) SetPluginEnabled(id string, enabled bool) error {
	if !pluginIdPattern.MatchString(strings.TrimSpace(id)) {
		return fmt.Errorf("插件 id 无效：%q", id)
	}
	cfg := readAppConfig()
	set := map[string]bool{}
	for _, item := range cfg.DisabledPlugins {
		set[item] = true
	}
	if enabled {
		delete(set, id)
	} else {
		set[id] = true
	}
	kept := make([]string, 0, len(set))
	for _, item := range cfg.DisabledPlugins {
		if set[item] {
			kept = append(kept, item)
			delete(set, item)
		}
	}
	for item := range set {
		kept = append(kept, item)
	}
	sort.Strings(kept)
	cfg.DisabledPlugins = kept
	return saveAppConfig(cfg)
}

func (a *App) GetPluginSources() ([]PluginSource, error) {
	root, err := pluginsRootFor(readAppConfig().PluginsPathMode)
	if err != nil {
		return nil, err
	}
	cfg := readAppConfig()
	disabled := map[string]bool{}
	for _, id := range cfg.DisabledPlugins {
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
		m := &pluginManifest{Id: p.Id, Name: p.Name, Version: p.Version, Entry: p.Entry}
		source, err := pluginSourceAt(p.Dir, m)
		if err != nil {
			continue
		}
		sources = append(sources, *source)
	}
	return sources, nil
}
