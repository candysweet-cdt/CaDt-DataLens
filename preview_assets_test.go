package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewAssetMiddleware(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "assets")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "page.html"), []byte("<h1>ok</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "app.css"), []byte("body{color:red}"), 0o644); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(filepath.Dir(root), "secret-preview.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(secret)

	token, err := registerPreviewRoot(root)
	if err != nil || token == "" {
		t.Fatalf("register: token=%q err=%v", token, err)
	}
	if again, err := registerPreviewRoot(root); err != nil || again != token {
		t.Fatalf("same dir should reuse token: %q vs %q err=%v", again, token, err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	handler := previewAssetMiddleware(next)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	if rec := get("/__local/" + token + "/page.html"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<h1>ok</h1>") {
		t.Fatalf("serve index: code=%d body=%q", rec.Code, rec.Body.String())
	}
	if rec := get("/__local/" + token + "/assets/app.css"); rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("serve css: code=%d headers=%v", rec.Code, rec.Header())
	}
	if rec := get("/__local/" + token + "/../secret-preview.txt"); rec.Code == http.StatusOK {
		t.Fatalf("traversal should be blocked, got %d", rec.Code)
	}
	if rec := get("/__local/badtoken/page.html"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown token: code=%d", rec.Code)
	}
	if rec := get("/app.css"); rec.Code != http.StatusTeapot {
		t.Fatalf("non-preview path should fall through: code=%d", rec.Code)
	}
}
