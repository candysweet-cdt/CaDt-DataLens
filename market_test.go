package main

import (
	"encoding/json"
	"testing"
)

func TestMarketRepoIdentity(t *testing.T) {
	if got := marketRepoURL("cadt-datalens-plugins/bak-json"); got != "https://gitee.com/cadt-datalens-plugins/bak-json" {
		t.Fatalf("marketRepoURL = %q", got)
	}
	if got := marketRepoURL("cadt-datalens-plugins/bak-json.git"); got != "https://gitee.com/cadt-datalens-plugins/bak-json" {
		t.Fatalf("marketRepoURL(.git) = %q", got)
	}
	if got := marketRepoName("cadt-datalens-plugins/git-flow"); got != "git-flow" {
		t.Fatalf("marketRepoName = %q", got)
	}
	if got := marketRepoName("git-flow"); got != "git-flow" {
		t.Fatalf("marketRepoName(no slash) = %q", got)
	}
}

func TestApplyMarketManifest(t *testing.T) {
	item := &MarketPlugin{Repo: "cadt-datalens-plugins/bak-json", Name: "bak-json", Description: "仓库描述"}
	ok := applyMarketManifest(item, marketManifest{
		Id:            "bak-json",
		Name:          "JSON 备份查看",
		Version:       "1.2.0",
		Author:        "CandySweet",
		Description:   "插件清单描述",
		MinAppVersion: "1.0.0",
	})
	if !ok {
		t.Fatal("applyMarketManifest should accept a valid manifest")
	}
	if !item.ManifestOk || item.Id != "bak-json" || item.Name != "JSON 备份查看" ||
		item.Version != "1.2.0" || item.Author != "CandySweet" ||
		item.Description != "插件清单描述" || item.MinAppVersion != "1.0.0" {
		t.Fatalf("unexpected merged item: %+v", item)
	}
}

func TestApplyMarketManifestRejectsInvalid(t *testing.T) {
	item := &MarketPlugin{Name: "repo-name", Description: "repo-desc"}
	for _, m := range []marketManifest{
		{Id: "Bad/Id", Name: "x"},
		{Id: "", Name: "x"},
		{Id: "ok-id", Name: "  "},
	} {
		if applyMarketManifest(item, m) {
			t.Fatalf("manifest should be rejected: %+v", m)
		}
	}
	if item.ManifestOk || item.Name != "repo-name" || item.Description != "repo-desc" {
		t.Fatalf("rejected manifest modified item: %+v", item)
	}
}

func TestMarketInstalledDetection(t *testing.T) {
	byRepo := &MarketPlugin{Repo: "cadt-datalens-plugins/git-flow"}
	markMarketInstalled(byRepo, map[string]string{"git-flow": "1.2.0"})
	if !byRepo.Installed || byRepo.InstalledVersion != "1.2.0" {
		t.Fatalf("repo name match should mark installed with version: %+v", byRepo)
	}
	byId := &MarketPlugin{Repo: "cadt-datalens-plugins/other", Id: "real-id"}
	markMarketInstalled(byId, map[string]string{"real-id": "2.0.0"})
	if !byId.Installed || byId.InstalledVersion != "2.0.0" {
		t.Fatalf("manifest id match should mark installed with version: %+v", byId)
	}
	none := &MarketPlugin{Repo: "cadt-datalens-plugins/new", Id: "new-id"}
	markMarketInstalled(none, map[string]string{"git-flow": "1.2.0"})
	if none.Installed || none.InstalledVersion != "" {
		t.Fatalf("unrelated plugin should not be marked installed: %+v", none)
	}
}

func TestComparePluginVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.1", -1},
		{"1.0.1", "1.0.0", 1},
		{"1.0", "1.0.0", 0},
		{"v2", "1.9.9", 1},
		{"1.10.0", "1.9.0", 1},
		{"", "0.0.1", -1},
	}
	for _, c := range cases {
		if got := comparePluginVersion(c.a, c.b); got != c.want {
			t.Fatalf("comparePluginVersion(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestDecodeMarketRepoList(t *testing.T) {
	raw := `[{"full_name":"cadt-datalens-plugins/bak-json","name":"bak-json","description":"把 .bak 文件按 JSON 解析","default_branch":"main","stargazers_count":3,"updated_at":"2026-11-08T20:34:34+08:00"}]`
	var repos []marketRepo
	if err := json.Unmarshal([]byte(raw), &repos); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(repos) != 1 || repos[0].FullName != "cadt-datalens-plugins/bak-json" ||
		repos[0].DefaultBranch != "main" || repos[0].StargazersCount != 3 {
		t.Fatalf("unexpected repos: %+v", repos)
	}
}

func TestMarketPathValidation(t *testing.T) {
	valid := []string{"cadt-datalens-plugins/bak-json", "owner/repo.js", "a/b"}
	for _, name := range valid {
		if !validMarketRepo(name) {
			t.Fatalf("should accept repo %q", name)
		}
	}
	invalid := []string{"cadt-datalens-plugins", "a/b/c", "../x", "a/..", "a b/c", "a/", "/a"}
	for _, name := range invalid {
		if validMarketRepo(name) {
			t.Fatalf("should reject repo %q", name)
		}
	}
	for _, branch := range []string{"main", "feature/x-1"} {
		if !validMarketBranch(branch) {
			t.Fatalf("should accept branch %q", branch)
		}
	}
	for _, branch := range []string{"", "../main", "a//b", "/main"} {
		if validMarketBranch(branch) {
			t.Fatalf("should reject branch %q", branch)
		}
	}
}
