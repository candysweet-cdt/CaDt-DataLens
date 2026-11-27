// Package previewassets 本地预览资源：HTML 预览的 iframe 通过 /__local/<token>/…
// 读取与源文件同根目录的图片/CSS/JS。token 在打开预览时按根目录注册，
// 只能访问注册过的目录，避免向页面暴露任意磁盘路径。
package previewassets

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

var roots = struct {
	sync.Mutex
	byToken map[string]string
	byDir   map[string]string
}{byToken: map[string]string{}, byDir: map[string]string{}}

// Register 把一个目录注册为预览资源根，返回访问 token；同一目录复用 token。
func Register(dir string) (string, error) {
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
	roots.Lock()
	defer roots.Unlock()
	if token, ok := roots.byDir[key]; ok {
		return token, nil
	}
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	roots.byToken[token] = abs
	roots.byDir[key] = token
	return token, nil
}

// Middleware 拦截 /__local/ 前缀，其余请求原样交给 next。
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/__local/") {
			serve(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/__local/")
	token, rel := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		token, rel = rest[:i], rest[i+1:]
	}
	roots.Lock()
	root, ok := roots.byToken[token]
	roots.Unlock()
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
	// 词法校验挡不住符号链接：根内有指向根外的链接时 Rel 仍判"在根内"，
	// Stat/ServeFile 会跟随链接把目标读出来。解析真实路径后再比一次。
	realFull, lerr := filepath.EvalSymlinks(full)
	if lerr != nil {
		http.NotFound(w, r)
		return
	}
	realRoot, rerr := filepath.EvalSymlinks(root)
	if rerr != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if realInside, rerr2 := filepath.Rel(realRoot, realFull); rerr2 != nil || realInside == ".." ||
		strings.HasPrefix(strings.ToLower(realInside), ".."+string(filepath.Separator)) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	full = realFull
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, full)
}
