package fsops

// 文件系统与资源管理器：目录列举、条目新建/改名/复制/移动、拖放落盘。
// 对话框（打开文件/文件夹/保存）留在 main 壳里。

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"datalens/internal/search"
)

// FS 目录与条目操作引擎（无状态）。
type FS struct{}

type DirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Mtime int64  `json:"mtime,omitempty"`
	Size  int64  `json:"size,omitempty"`
}

type DirListing struct {
	Entries   []DirEntry `json:"entries"`
	Truncated bool       `json:"truncated"`
	Total     int        `json:"total"`
	Mtime     int64      `json:"mtime"`
}

// DirMtime 只读取目录自身的修改时间，供文件树在整目录重读前做廉价变更判断。
func (f *FS) DirMtime(path string) (int64, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return 0, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, fmt.Errorf("不是目录：%s", path)
	}
	return info.ModTime().UnixMilli(), nil
}

func (f *FS) ReadDir(path string, limit int) (*DirListing, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("不是目录：%s", path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	total := len(entries)
	truncated := false
	if len(entries) > limit {
		entries = entries[:limit]
		truncated = true
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		item := DirEntry{
			Name:  entry.Name(),
			Path:  filepath.Join(path, entry.Name()),
			IsDir: entry.IsDir(),
		}
		if info, err := entry.Info(); err == nil {
			item.Mtime = info.ModTime().UnixMilli()
			if !item.IsDir {
				item.Size = info.Size()
			}
		}
		out = append(out, item)
	}
	return &DirListing{Entries: out, Truncated: truncated, Total: total, Mtime: info.ModTime().UnixMilli()}, nil
}

// ---- list_dir 递归树（AI 工具 depth>1 走这里） ----

type DirTreeNode struct {
	Name     string         `json:"name"`
	IsDir    bool           `json:"isDir"`
	Size     int64          `json:"size,omitempty"`
	Children []*DirTreeNode `json:"children,omitempty"`
	Omitted  bool           `json:"omitted,omitempty"` // 该目录还有条目没列出（预算用尽）
}

type DirTreeListing struct {
	Root      *DirTreeNode `json:"root"`
	Depth     int          `json:"depth"`
	Total     int          `json:"total"` // 实际收录的条目数（不含根）
	Truncated bool         `json:"truncated"`
}

const (
	DirTreeMaxDepth   = 8   // 模型可请求的递归深度上限（再深就是树导出的活）
	DirTreeMaxEntries = 400 // 全树条目预算：超过即截断，防止 node_modules 类目录刷爆上下文
)

// ReadDirTree 递归列目录树。默认软忽略与用户 search-ignore 命中的目录整棵跳过
// （与 search_text 同一张表，! 可覆盖默认），目录符号链接不跟（防环）；
// 条目预算用尽时在对应目录打 Omitted 并停止深入。
func (f *FS) ReadDirTree(path string, depth int) (*DirTreeListing, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("不是目录：%s", path)
	}
	if depth < 1 {
		depth = 1
	}
	if depth > DirTreeMaxDepth {
		depth = DirTreeMaxDepth
	}
	budget := DirTreeMaxEntries
	ignore := search.LoadIgnoreRules(path)
	root, truncated := walkDirTree(path, "", depth, &budget, ignore)
	return &DirTreeListing{Root: root, Depth: depth, Total: DirTreeMaxEntries - budget, Truncated: truncated}, nil
}

// walkDirTree 递归收录；根级读失败由调用方先 os.Stat 挡过，子级读失败按空目录跳过。
// rel 为当前目录相对遍历根的路径（正斜杠；根为空串）——用于按路径跳过 AI 隔离 worktree
// （.cadt/worktree 整棵不列；从 worktree 自身发起的遍历 rel 不命中，照常列出）。
func walkDirTree(dir string, rel string, remainingDepth int, budget *int, ignore *search.IgnoreRules) (*DirTreeNode, bool) {
	node := &DirTreeNode{Name: filepath.Base(dir), IsDir: true}
	if remainingDepth <= 0 {
		return node, false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		node.Omitted = true
		return node, false
	}
	sortDirTreeEntries(entries)
	truncated := false
	for _, entry := range entries {
		name := entry.Name()
		isDir := entry.IsDir() && entry.Type()&os.ModeSymlink == 0
		if isDir {
			childRel := joinRelPath(rel, name)
			if search.SkipPath(childRel) {
				continue
			}
			// 默认软忽略 + 用户 search-ignore（! 可覆盖默认），已含 .git/node_modules 等
			if ignore.ShouldSkipDir(name, childRel) {
				continue
			}
		} else if ignore.ShouldSkipFile(name, joinRelPath(rel, name)) {
			continue
		}
		if *budget <= 0 {
			node.Omitted = true
			return node, true
		}
		*budget--
		child := &DirTreeNode{Name: name, IsDir: isDir}
		if !isDir {
			if info, err := entry.Info(); err == nil {
				child.Size = info.Size()
			}
		}
		node.Children = append(node.Children, child)
		if isDir {
			sub, subTruncated := walkDirTree(filepath.Join(dir, name), joinRelPath(rel, name), remainingDepth-1, budget, ignore)
			child.Children = sub.Children
			child.Omitted = sub.Omitted
			truncated = truncated || subTruncated
		}
	}
	return node, truncated
}

// joinRelPath 拼接遍历根相对路径（正斜杠）；根为空串时返回 name 自身。
func joinRelPath(rel, name string) string {
	if rel == "" {
		return name
	}
	return rel + "/" + name
}

// sortDirTreeEntries 目录在前，名字不区分大小写（Windows 资源管理器语义的简化版）
func sortDirTreeEntries(entries []os.DirEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		aDir := entries[i].IsDir() && entries[i].Type()&os.ModeSymlink == 0
		bDir := entries[j].IsDir() && entries[j].Type()&os.ModeSymlink == 0
		if aDir != bDir {
			return aDir
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
}

var reservedEntryNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

func validateEntryName(name string) (string, error) {
	if strings.TrimSpace(name) != name {
		return "", fmt.Errorf("名称不能以空格或制表符开头或结尾")
	}
	trimmed := name
	if trimmed == "" {
		return "", fmt.Errorf("名称不能为空")
	}
	if trimmed == "." || trimmed == ".." {
		return "", fmt.Errorf("名称不能是 . 或 ..")
	}
	if strings.ContainsAny(trimmed, `<>:"/\|?*`) {
		return "", fmt.Errorf("名称不能包含 < > : \" / \\ | ? *")
	}
	for _, r := range trimmed {
		if r < 32 {
			return "", fmt.Errorf("名称不能包含控制字符")
		}
	}
	if strings.HasSuffix(trimmed, ".") {
		return "", fmt.Errorf("名称不能以点结尾")
	}
	stem := strings.TrimSuffix(trimmed, filepath.Ext(trimmed))
	if reservedEntryNames[strings.ToLower(stem)] {
		return "", fmt.Errorf("“%s”是 Windows 保留名称", stem)
	}
	return trimmed, nil
}

func (f *FS) CreateEntry(dir, name string, isDir bool) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", dir)
	}
	clean, err := validateEntryName(name)
	if err != nil {
		return "", err
	}
	target := filepath.Join(dir, clean)
	if _, err := os.Stat(target); err == nil {
		return "", fmt.Errorf("“%s”已存在", clean)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if isDir {
		err = os.Mkdir(target, 0o755)
	} else {
		var f *os.File
		f, err = os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			err = f.Close()
		}
	}
	if err != nil {
		return "", err
	}
	return target, nil
}

func (f *FS) RenameEntry(path, newName string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	_ = info
	clean, err := validateEntryName(newName)
	if err != nil {
		return "", err
	}
	oldName := filepath.Base(path)
	if clean == oldName {
		return path, nil
	}
	dir := filepath.Dir(path)
	target := filepath.Join(dir, clean)
	if _, err := os.Stat(target); err == nil {
		if !strings.EqualFold(filepath.Clean(target), filepath.Clean(path)) {
			return "", fmt.Errorf("“%s”已存在", clean)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(path, target); err != nil {
		return "", err
	}
	return target, nil
}

func EntryExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func pathIsWithin(root, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func (f *FS) SuggestCopyName(dir, name string, isDir bool) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目标目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("目标不是目录：%s", dir)
	}
	clean, err := validateEntryName(name)
	if err != nil {
		return "", err
	}
	if !EntryExists(filepath.Join(dir, clean)) {
		return clean, nil
	}
	stem, ext := clean, ""
	if !isDir {
		ext = filepath.Ext(clean)
		stem = strings.TrimSuffix(clean, ext)
		if stem == "" {
			stem, ext = clean, ""
		}
	}
	for i := 1; i <= 500; i++ {
		suffix := " - 副本"
		if i > 1 {
			suffix = fmt.Sprintf(" - 副本 %d", i)
		}
		candidate := stem + suffix + ext
		if !EntryExists(filepath.Join(dir, candidate)) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("无法生成可用的名称")
}

func resolvePasteTarget(src, destDir, newName string) (string, os.FileInfo, error) {
	src = strings.TrimSpace(src)
	srcInfo, err := os.Stat(src)
	if err != nil {
		return "", nil, err
	}
	destDir = strings.TrimSpace(destDir)
	destInfo, err := os.Stat(destDir)
	if err != nil {
		return "", nil, err
	}
	if !destInfo.IsDir() {
		return "", nil, fmt.Errorf("目标不是目录：%s", destDir)
	}
	clean, err := validateEntryName(newName)
	if err != nil {
		return "", nil, err
	}
	dest := filepath.Join(destDir, clean)
	if strings.EqualFold(filepath.Clean(dest), filepath.Clean(src)) {
		return "", nil, fmt.Errorf("目标与源相同")
	}
	if srcInfo.IsDir() && pathIsWithin(src, dest) {
		return "", nil, fmt.Errorf("不能把文件夹复制或移动到它自己的子目录")
	}
	if EntryExists(dest) {
		return "", nil, fmt.Errorf("“%s”已存在", clean)
	}
	return dest, srcInfo, nil
}

// CopyTree 复制文件或目录树（保留权限位，文件用 O_EXCL 防覆盖）。
// 包级导出供同层域包（插件安装/替换）复用，避免各包自留一份逐字相同的副本；
// 包级函数不会成为 Wails 绑定（与 CopyEntry 方法的粘贴语义不同，互不替代）。
func CopyTree(src, dst string, info os.FileInfo) error {
	if info.IsDir() {
		if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childSrc := filepath.Join(src, entry.Name())
			childDst := filepath.Join(dst, entry.Name())
			// 用 Lstat 而不是 Stat：Stat 会跟随符号链接，指向工作区外的链接会被
			// 整棵复制出来（越界），指向祖先目录的链接（Windows junction 常见）
			// 会无限递归直到路径超长。链接本身原样重建，不展开目标。
			childInfo, err := os.Lstat(childSrc)
			if err != nil {
				return err
			}
			if childInfo.Mode()&os.ModeSymlink != 0 {
				target, lerr := os.Readlink(childSrc)
				if lerr != nil {
					return lerr
				}
				if serr := os.Symlink(target, childDst); serr != nil {
					// 平台不支持建链接（或权限不足）：跳过而不是复制目标内容
					continue
				}
				continue
			}
			if err := CopyTree(childSrc, childDst, childInfo); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func (f *FS) CopyEntry(src, destDir, newName string) (string, error) {
	dest, info, err := resolvePasteTarget(src, destDir, newName)
	if err != nil {
		return "", err
	}
	if err := CopyTree(src, dest, info); err != nil {
		os.RemoveAll(dest)
		return "", err
	}
	return dest, nil
}

func (f *FS) MoveEntry(src, destDir, newName string) (string, error) {
	dest, info, err := resolvePasteTarget(src, destDir, newName)
	if err != nil {
		return "", err
	}
	if err := os.Rename(src, dest); err == nil {
		return dest, nil
	}
	if err := CopyTree(src, dest, info); err != nil {
		os.RemoveAll(dest)
		return "", err
	}
	if err := os.RemoveAll(src); err != nil {
		os.RemoveAll(dest)
		return "", fmt.Errorf("移动失败：无法删除源：%w", err)
	}
	return dest, nil
}

// SaveDataURL 把 data URL（base64）解码后写入目标文件（PNG 导出等二进制落盘用）。
func (f *FS) SaveDataURL(path string, dataURL string) error {
	const marker = "base64,"
	idx := strings.Index(dataURL, marker)
	if path == "" {
		return fmt.Errorf("没有目标文件")
	}
	if idx < 0 {
		return fmt.Errorf("无效的数据 URL")
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[idx+len(marker):])
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

// CopyFileTo 把已有文件复制到指定目标路径（图片另存为用）。
func (f *FS) CopyFileTo(srcPath, destPath string) error {
	if srcPath == "" || destPath == "" {
		return fmt.Errorf("路径为空")
	}
	if strings.EqualFold(srcPath, destPath) {
		return nil
	}
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return err
	}
	return os.WriteFile(destPath, data, 0644)
}
