package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AI 会话磁盘存储：每个会话一个目录，正文为追加式 JSONL，元数据为原子替换的 meta.json。
// 布局：<appdata>/ai-sessions/<id>/{meta.json,session.v1.jsonl,images/}
const (
	aiSessionsDirName  = "ai-sessions"
	aiSessionMetaName  = "meta.json"
	aiSessionLogName   = "session.v1.jsonl"
	aiSessionImagesDir = "images"
	aiSessionLockName  = ".session.lock"
	aiSessionLockWait  = 5 * time.Second
	aiSessionReadLimit = 64 << 20 // 单会话正文上限：超过后拒绝加载，提示先压缩
	aiSessionMetaLimit = 1 << 20
	aiSessionIDMax     = 128
	aiSessionImageMax  = 120
)

type aiSessionStore struct {
	root     string
	deleteFn func(string) error
}

// aiSessionFileLock 由平台文件实现：Windows 用 LockFileEx，其余平台用 flock(2)。
type aiSessionFileLock struct {
	release func()
}

// 同进程内所有 App 方法各建一个 store，追加互斥必须是包级的。
var aiSessionAppendMu sync.Mutex

func newAISessionStore(root string) *aiSessionStore {
	return &aiSessionStore{root: root, deleteFn: movePathToRecycleBin}
}

func defaultAISessionStore() (*aiSessionStore, error) {
	base := appDataRoot()
	if base == "" {
		return nil, errors.New("无法定位应用数据目录")
	}
	return newAISessionStore(filepath.Join(base, aiSessionsDirName)), nil
}

// validAISessionID 限制会话 id 可安全拼进路径：不含分隔符、不以点开头、不是 . / ..。
func validAISessionID(id string) bool {
	if id == "" || len(id) > aiSessionIDMax || id[0] == '.' {
		return false
	}
	if isWindowsReservedName(id) {
		return false
	}
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

// isWindowsReservedName 拒绝 CON/NUL/COM1 等设备名（带扩展名同样被系统占用）。
func isWindowsReservedName(name string) bool {
	base := strings.ToUpper(strings.TrimSuffix(name, filepath.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) {
		return base[3] >= '1' && base[3] <= '9'
	}
	return false
}

func (s *aiSessionStore) ensureRoot() error {
	if s.root == "" {
		return errors.New("会话存储目录为空")
	}
	return os.MkdirAll(s.root, 0o755)
}

func (s *aiSessionStore) sessionDir(id string) (string, error) {
	if !validAISessionID(id) {
		return "", fmt.Errorf("非法会话 id：%q", id)
	}
	if s.root == "" {
		return "", errors.New("会话存储目录为空")
	}
	return filepath.Join(s.root, id), nil
}

func (s *aiSessionStore) ensureSessionDir(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	if err := s.ensureRoot(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建会话目录失败：%w", err)
	}
	return dir, nil
}

// withSessionLock 在会话目录的锁文件上取跨进程独占锁；超时返回可读错误。
// 读取不加锁；只有追加/整份重写/写 meta 这类写操作需要。
func (s *aiSessionStore) withSessionLock(id string, fn func(dir string) error) error {
	dir, err := s.ensureSessionDir(id)
	if err != nil {
		return err
	}
	lock, err := lockAISessionFile(filepath.Join(dir, aiSessionLockName), aiSessionLockWait)
	if err != nil {
		return fmt.Errorf("会话正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.release()
	return fn(dir)
}

func (s *aiSessionStore) logPath(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, aiSessionLogName), nil
}

func validAISessionImageName(name string) bool {
	if name == "" || len(name) > aiSessionImageMax || name[0] == '.' {
		return false
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
	default:
		return false
	}
	if isWindowsReservedName(name) {
		return false
	}
	for _, ch := range name {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

func (s *aiSessionStore) imagePath(id, name string) (string, error) {
	if !validAISessionImageName(name) {
		return "", fmt.Errorf("非法图片名：%q", name)
	}
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, aiSessionImagesDir, name), nil
}

// list 只读各会话的 meta.json，不触碰正文；meta 缺失/损坏时用正文 header 兜底。
func (s *aiSessionStore) list() ([]string, error) {
	if err := s.ensureRoot(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !validAISessionID(entry.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.root, entry.Name(), aiSessionMetaName))
		if err != nil || len(raw) == 0 || len(raw) > aiSessionMetaLimit || !json.Valid(raw) {
			// meta 丢失/损坏时用正文首行 header 兜底，避免整段会话从列表里消失。
			raw = synthesizeMetaFromHeader(filepath.Join(s.root, entry.Name(), aiSessionLogName), entry.Name())
			if len(raw) == 0 {
				continue
			}
		}
		out = append(out, string(raw))
	}
	return out, nil
}

// synthesizeMetaFromHeader 从正文首行 header 重建最小 meta（用于 meta 丢失/损坏的会话）。
func synthesizeMetaFromHeader(logPath, id string) []byte {
	f, err := os.Open(logPath)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n, _ := f.Read(buf)
	if n == 0 {
		return nil
	}
	line := string(buf[:n])
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var header struct {
		T         string `json:"t"`
		Title     string `json:"title"`
		CreatedAt int64  `json:"createdAt"`
		Workspace string `json:"workspace"`
	}
	if json.Unmarshal([]byte(line), &header) != nil || header.T != "header" {
		return nil
	}
	meta := map[string]any{
		"v":             1,
		"id":            id,
		"title":         header.Title,
		"createdAt":     header.CreatedAt,
		"updatedAt":     header.CreatedAt,
		"workspace":     header.Workspace,
		"scope":         "read",
		"messageCount":  0,
		"archivedCount": 0,
		"summary":       nil,
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return nil
	}
	return raw
}

func (s *aiSessionStore) read(id string) (string, error) {
	path, err := s.logPath(id)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if info.Size() > aiSessionReadLimit {
		return "", fmt.Errorf("会话正文 %d MB，超过 %d MB 上限；请先压缩或清空该会话",
			info.Size()/(1<<20), aiSessionReadLimit/(1<<20))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// append 在文件末尾追加若干行；写入前修掉上次崩溃留下的半行，
// 写入后 fsync；失败回滚到追加前的长度，避免半批事件留在日志里。
func (s *aiSessionStore) append(id string, payload string) error {
	if payload == "" {
		return nil
	}
	if !strings.HasSuffix(payload, "\n") {
		payload += "\n"
	}
	return s.withSessionLock(id, func(dir string) error {
		path := filepath.Join(dir, aiSessionLogName)
		aiSessionAppendMu.Lock()
		defer aiSessionAppendMu.Unlock()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			return err
		}
		before, err := repairTornTail(f)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		// O_APPEND 写：多窗口并发追加也由文件系统保证写到当前末尾。
		af, err := os.OpenFile(path, os.O_RDWR|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		defer af.Close()
		if _, err := af.WriteString(payload); err != nil {
			_ = af.Truncate(before)
			return err
		}
		// 与 dsh 一致：每批落盘后再算提交；掉电最多丢这一批。
		if err := af.Sync(); err != nil {
			_ = af.Truncate(before)
			return err
		}
		return nil
	})
}

// repairTornTail 把不以换行结尾的尾部残行截掉，返回可安全追加的字节长度。
func repairTornTail(f *os.File) (int64, error) {
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	size := info.Size()
	if size == 0 {
		return 0, nil
	}
	buf := make([]byte, 32*1024)
	offset := size
	for offset > 0 {
		n := int64(len(buf))
		if offset < n {
			n = offset
		}
		offset -= n
		if _, err := f.ReadAt(buf[:n], offset); err != nil {
			return 0, err
		}
		for i := n - 1; i >= 0; i-- {
			if buf[i] == '\n' {
				keep := offset + i + 1
				if keep == size {
					return size, nil
				}
				return keep, f.Truncate(keep)
			}
		}
	}
	return 0, f.Truncate(0)
}

// rewrite 原子替换整个正文（迁移、清空、状态与日志不一致时的兜底）。
func (s *aiSessionStore) rewrite(id string, payload string) error {
	return s.withSessionLock(id, func(dir string) error {
		return writeFileAtomic(filepath.Join(dir, aiSessionLogName), []byte(payload))
	})
}

func (s *aiSessionStore) writeMeta(id string, payload string) error {
	return s.withSessionLock(id, func(dir string) error {
		return writeFileAtomic(filepath.Join(dir, aiSessionMetaName), []byte(payload))
	})
}

// remove 单个会话目录（Windows 走回收站，可撤销）。
func (s *aiSessionStore) remove(id string) error {
	dir, err := s.sessionDir(id)
	if err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是会话目录：%s", dir)
	}
	return s.deleteFn(dir)
}

// removeAll 清空全部会话目录（整根目录进回收站）。
func (s *aiSessionStore) removeAll() error {
	info, err := os.Stat(s.root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是会话目录：%s", s.root)
	}
	return s.deleteFn(s.root)
}

// writeFileAtomic 先写同目录临时文件并落盘，再原子替换目标文件。
func writeFileAtomic(path string, data []byte) error {
	return writeFileAtomicMode(path, data, 0o644)
}

func writeFileAtomicMode(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), time.Now().UnixNano())
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := replaceFileAtomic(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// ---------- Wails 绑定 ----------

func (a *App) AISessionStoreRoot() (string, error) {
	store, err := defaultAISessionStore()
	if err != nil {
		return "", err
	}
	if err := store.ensureRoot(); err != nil {
		return "", err
	}
	return store.root, nil
}

// AISessionList 返回各会话 meta.json 的原始 JSON 字符串（列表页只需这些摘要）。
func (a *App) AISessionList() ([]string, error) {
	store, err := defaultAISessionStore()
	if err != nil {
		return nil, err
	}
	return store.list()
}

func (a *App) AISessionRead(id string) (string, error) {
	store, err := defaultAISessionStore()
	if err != nil {
		return "", err
	}
	return store.read(id)
}

func (a *App) AISessionAppend(id string, lines string) error {
	store, err := defaultAISessionStore()
	if err != nil {
		return err
	}
	if err := store.append(id, lines); err != nil {
		return err
	}
	aiIndexMarkDirty(id)
	return nil
}

func (a *App) AISessionRewrite(id string, content string) error {
	store, err := defaultAISessionStore()
	if err != nil {
		return err
	}
	if err := store.rewrite(id, content); err != nil {
		return err
	}
	aiIndexMarkDirty(id)
	return nil
}

func (a *App) AISessionWriteMeta(id string, data string) error {
	store, err := defaultAISessionStore()
	if err != nil {
		return err
	}
	if err := store.writeMeta(id, data); err != nil {
		return err
	}
	aiIndexUpdateMeta(id, data)
	return nil
}

// AISessionSaveImage 把会话图片写进 <id>/images/，返回相对路径 images/<name>。
func (a *App) AISessionSaveImage(id, name, dataURL string) (string, error) {
	store, err := defaultAISessionStore()
	if err != nil {
		return "", err
	}
	path, err := store.imagePath(id, name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if len(dataURL) > 16<<20 {
		return "", fmt.Errorf("图片数据过大（>16 MB）")
	}
	if err := a.SaveDataURL(path, dataURL); err != nil {
		return "", err
	}
	return aiSessionImagesDir + "/" + name, nil
}

// AISessionReadImage 读取会话图片为 data URL；name 只允许单个文件名，拒绝路径穿越。
func (a *App) AISessionReadImage(id, name string) (string, error) {
	store, err := defaultAISessionStore()
	if err != nil {
		return "", err
	}
	path, err := store.imagePath(id, name)
	if err != nil {
		return "", err
	}
	return a.ReadImageDataURL(path)
}

func (a *App) AISessionDelete(id string) error {
	store, err := defaultAISessionStore()
	if err != nil {
		return err
	}
	if err := store.remove(id); err != nil {
		return err
	}
	aiIndexDelete(id)
	return nil
}

func (a *App) AISessionDeleteAll() error {
	store, err := defaultAISessionStore()
	if err != nil {
		return err
	}
	if err := store.removeAll(); err != nil {
		return err
	}
	aiIndexClear()
	return nil
}
