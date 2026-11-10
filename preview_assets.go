package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// 本地预览资源：HTML 预览的 iframe 通过 /__local/<token>/… 读取与源文件同根目录的
// 图片/CSS/JS。token 在打开预览时按根目录注册，只能访问注册过的目录，避免向页面暴露任意磁盘路径。
var previewRoots = struct {
	sync.Mutex
	byToken map[string]string
	byDir   map[string]string
}{byToken: map[string]string{}, byDir: map[string]string{}}

func registerPreviewRoot(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", nil
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", abs)
	}
	key := strings.ToLower(filepath.Clean(abs))
	previewRoots.Lock()
	defer previewRoots.Unlock()
	if token, ok := previewRoots.byDir[key]; ok {
		return token, nil
	}
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	previewRoots.byToken[token] = abs
	previewRoots.byDir[key] = token
	return token, nil
}

// RegisterPreviewRoot 供前端注册 HTML 预览的资源根目录，返回访问 token。
func (a *App) RegisterPreviewRoot(dir string) (string, error) {
	return registerPreviewRoot(dir)
}

func previewAssetMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/__local/") {
			servePreviewAsset(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func servePreviewAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/__local/")
	token, rel := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		token, rel = rest[:i], rest[i+1:]
	}
	previewRoots.Lock()
	root, ok := previewRoots.byToken[token]
	previewRoots.Unlock()
	if !ok || token == "" {
		http.NotFound(w, r)
		return
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	rel = strings.TrimPrefix(rel, "/")
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." || clean == "" || clean == ".." ||
		strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	full := filepath.Join(root, clean)
	inside, err := filepath.Rel(root, full)
	if err != nil || inside == ".." || strings.HasPrefix(strings.ToLower(inside), ".."+string(filepath.Separator)) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, full)
}
