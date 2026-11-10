package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	updateRepo         = "candysweet-cdt/CaDt-DataLens"
	updateReleaseAPI   = "https://gitee.com/api/v5/repos/" + updateRepo + "/releases/latest"
	updateReleasesPage = "https://gitee.com/" + updateRepo + "/releases"
)

var updateHTTPClient = &http.Client{Timeout: 12 * time.Second}

type UpdateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	HasUpdate      bool   `json:"hasUpdate"`
	Status         string `json:"status"`
	Title          string `json:"title,omitempty"`
	Notes          string `json:"notes,omitempty"`
	PageUrl        string `json:"pageUrl,omitempty"`
	DownloadUrl    string `json:"downloadUrl,omitempty"`
	DownloadName   string `json:"downloadName,omitempty"`
	PublishedAt    string `json:"publishedAt,omitempty"`
}

type updateRelease struct {
	TagName   string        `json:"tag_name"`
	Name      string        `json:"name"`
	Body      string        `json:"body"`
	CreatedAt string        `json:"created_at"`
	Assets    []updateAsset `json:"assets"`
}

type updateAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// CheckForUpdates 读取 Gitee 最新 Release，并与当前编译版本比较。
func (a *App) CheckForUpdates() (*UpdateInfo, error) {
	return checkForUpdates(updateReleaseAPI, appVersion)
}

func checkForUpdates(apiURL, current string) (*UpdateInfo, error) {
	info := &UpdateInfo{CurrentVersion: current, Status: "ok", PageUrl: updateReleasesPage}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	release, found, err := fetchLatestRelease(ctx, apiURL)
	if err != nil {
		return info, err
	}
	if !found {
		info.Status = "no-release"
		return info, nil
	}
	info.LatestVersion = strings.TrimSpace(release.TagName)
	if info.LatestVersion == "" {
		return info, fmt.Errorf("发布信息缺少版本号")
	}
	info.HasUpdate = comparePluginVersion(info.LatestVersion, current) > 0
	info.Title = strings.TrimSpace(release.Name)
	info.Notes = strings.TrimSpace(release.Body)
	info.PublishedAt = strings.TrimSpace(release.CreatedAt)
	info.DownloadUrl, info.DownloadName = pickInstallerAsset(release.Assets)
	return info, nil
}

func fetchLatestRelease(ctx context.Context, apiURL string) (*updateRelease, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(appVersion, "v"))
	resp, err := updateHTTPClient.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("无法连接 Gitee：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("Gitee 返回 HTTP %d", resp.StatusCode)
	}
	var release updateRelease
	body := io.LimitReader(resp.Body, 1<<20)
	if err := json.NewDecoder(body).Decode(&release); err != nil {
		return nil, false, fmt.Errorf("解析发布信息失败：%w", err)
	}
	return &release, true, nil
}

// pickInstallerAsset 优先选择文件名带 installer 的 exe，否则取第一个 exe 资产。
func pickInstallerAsset(assets []updateAsset) (string, string) {
	bestURL, bestName := "", ""
	for _, asset := range assets {
		name := strings.TrimSpace(asset.Name)
		url := strings.TrimSpace(asset.BrowserDownloadURL)
		if url == "" || !strings.HasSuffix(strings.ToLower(name), ".exe") {
			continue
		}
		if strings.Contains(strings.ToLower(name), "installer") {
			return url, name
		}
		if bestURL == "" {
			bestURL, bestName = url, name
		}
	}
	return bestURL, bestName
}
