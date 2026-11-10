package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func updateTestServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("User-Agent"); !strings.HasPrefix(got, "CaDt-DataLens/") {
			t.Errorf("unexpected User-Agent: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCheckForUpdatesAvailable(t *testing.T) {
	body := `{
		"tag_name": "v1.1.0",
		"name": "CaDt-DataLens 1.1.0",
		"body": "## 变更\n\n- 新增检查更新",
		"created_at": "2026-11-20T10:00:00+08:00",
		"assets": [
			{"name": "source.zip", "browser_download_url": "https://gitee.com/x/source.zip"},
			{"name": "CaDt-DataLens-amd64.exe", "browser_download_url": "https://gitee.com/x/CaDt-DataLens-amd64.exe"},
			{"name": "CaDt-DataLens-amd64-installer.exe", "browser_download_url": "https://gitee.com/x/CaDt-DataLens-amd64-installer.exe"}
		]
	}`
	srv := updateTestServer(t, http.StatusOK, body)
	info, err := checkForUpdates(srv.URL, "v1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !info.HasUpdate || info.LatestVersion != "v1.1.0" {
		t.Fatalf("unexpected update info: %+v", info)
	}
	if info.DownloadName != "CaDt-DataLens-amd64-installer.exe" {
		t.Fatalf("expected installer asset, got %q", info.DownloadName)
	}
	if !strings.Contains(info.Notes, "检查更新") {
		t.Fatalf("notes missing release body: %q", info.Notes)
	}
	if info.PageUrl != updateReleasesPage || info.Status != "ok" {
		t.Fatalf("unexpected page/status: %+v", info)
	}
}

func TestCheckForUpdatesCurrent(t *testing.T) {
	srv := updateTestServer(t, http.StatusOK, `{"tag_name":"v1.0.0","name":"v1.0.0"}`)
	info, err := checkForUpdates(srv.URL, "v1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if info.HasUpdate {
		t.Fatalf("expected no update: %+v", info)
	}
}

func TestCheckForUpdatesNoRelease(t *testing.T) {
	srv := updateTestServer(t, http.StatusNotFound, `{"message":"404 Not Found"}`)
	info, err := checkForUpdates(srv.URL, "v1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if info.Status != "no-release" || info.LatestVersion != "" {
		t.Fatalf("unexpected no-release info: %+v", info)
	}
}

func TestCheckForUpdatesHTTPError(t *testing.T) {
	srv := updateTestServer(t, http.StatusInternalServerError, `{"message":"boom"}`)
	if _, err := checkForUpdates(srv.URL, "v1.0.0"); err == nil {
		t.Fatal("expected error for HTTP 500")
	}
}

func TestPickInstallerAsset(t *testing.T) {
	url, name := pickInstallerAsset([]updateAsset{
		{Name: "readme.md", BrowserDownloadURL: "https://gitee.com/x/readme.md"},
		{Name: "CaDt-DataLens.exe", BrowserDownloadURL: "https://gitee.com/x/CaDt-DataLens.exe"},
	})
	if name != "CaDt-DataLens.exe" || url == "" {
		t.Fatalf("expected fallback exe asset, got %q %q", name, url)
	}
	url, name = pickInstallerAsset([]updateAsset{{Name: "source.zip", BrowserDownloadURL: "https://gitee.com/x/source.zip"}})
	if url != "" || name != "" {
		t.Fatalf("expected no exe asset, got %q %q", name, url)
	}
}
