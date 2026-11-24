package main

// internal/fsops 的 FS.ReadDirTree（AI list_dir 递归树）测试。

import (
	"datalens/internal/fsops"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestReadDirTreeBasicStructure(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("b.txt", "hello")
	write("a.txt", "x")
	for _, sub := range []string{"sub1", "sub2"} {
		if err := os.Mkdir(filepath.Join(dir, sub), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "sub1", "inner.go"), []byte("package x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub1", "deep"), 0755); err != nil {
		t.Fatal(err)
	}

	listing, err := NewApp().ReadDirTree(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	if listing.Truncated || listing.Total != 6 || listing.Depth != 2 {
		t.Fatalf("listing = %+v", listing)
	}
	root := listing.Root
	if root.Name == "" || len(root.Children) != 4 {
		t.Fatalf("root = %+v", root)
	}
	// 目录在前、名字不区分大小写：sub1 / sub2 / a.txt / b.txt
	if root.Children[0].Name != "sub1" || root.Children[1].Name != "sub2" ||
		root.Children[2].Name != "a.txt" || root.Children[3].Name != "b.txt" {
		t.Fatalf("unexpected order: %+v", root.Children)
	}
	if root.Children[0].Children[0].Name != "deep" || root.Children[0].Children[1].Name != "inner.go" {
		t.Fatalf("sub1 children = %+v", root.Children[0].Children)
	}
	if root.Children[0].Children[0].Children != nil {
		t.Fatalf("depth 2 不应再深入第三层: %+v", root.Children[0].Children[0])
	}
	if root.Children[2].Size != 1 || root.Children[3].Size != 5 {
		t.Fatalf("file sizes: a=%d b=%d", root.Children[2].Size, root.Children[3].Size)
	}
}

func TestReadDirTreeSkipsJunkDirs(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"node_modules", ".git", "__pycache__", "keep"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "junk.js"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep", "real.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	listing, err := NewApp().ReadDirTree(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	if listing.Truncated || listing.Total != 2 {
		t.Fatalf("listing = %+v", listing)
	}
	for _, child := range listing.Root.Children {
		if child.Name == "node_modules" || child.Name == ".git" || child.Name == "__pycache__" {
			t.Fatalf("垃圾目录未被跳过: %+v", listing.Root.Children)
		}
	}
}

func TestReadDirTreeRespectsSearchIgnore(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"keep", ".aoci"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "drop.tmp"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.tmp"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	// 用户排除表：按名字排 .aoci、按通配排 *.tmp，再取反保留 keep.tmp
	ignoreDir := filepath.Join(dir, ".cadt", "config")
	if err := os.MkdirAll(ignoreDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ignoreDir, "search-ignore"),
		[]byte(".aoci\n*.tmp\n!keep.tmp\n"), 0644); err != nil {
		t.Fatal(err)
	}

	listing, err := NewApp().ReadDirTree(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, child := range listing.Root.Children {
		names[child.Name] = true
	}
	if names[".aoci"] || names["drop.tmp"] {
		t.Fatalf("被排除项不该出现在目录树: %+v", listing.Root.Children)
	}
	if !names["keep"] || !names["keep.tmp"] {
		t.Fatalf("未排除项与取反项应保留: %+v", listing.Root.Children)
	}
}

// 用户 ! 前缀可覆盖默认软规则：node_modules 默认跳过，写 !node_modules 后目录树应列出它。
func TestReadDirTreeSearchIgnoreOverridesDefault(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"node_modules", "keep"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	ignoreDir := filepath.Join(dir, ".cadt", "config")
	if err := os.MkdirAll(ignoreDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ignoreDir, "search-ignore"), []byte("!node_modules\n"), 0644); err != nil {
		t.Fatal(err)
	}
	listing, err := NewApp().ReadDirTree(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, child := range listing.Root.Children {
		names[child.Name] = true
	}
	if !names["node_modules"] {
		t.Fatalf("!node_modules 应覆盖默认软规则、在目录树列出: %+v", listing.Root.Children)
	}
	if !names["keep"] {
		t.Fatalf("正常目录应保留: %+v", listing.Root.Children)
	}
}

func TestReadDirTreeTruncatesOnBudget(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < fsops.DirTreeMaxEntries+50; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	listing, err := NewApp().ReadDirTree(dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !listing.Truncated || listing.Total != fsops.DirTreeMaxEntries {
		t.Fatalf("listing truncated=%v total=%d", listing.Truncated, listing.Total)
	}
	if !listing.Root.Omitted {
		t.Fatalf("根目录应标记 Omitted: %+v", listing.Root)
	}
}

func TestReadDirTreeClampsDepth(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "l1", "l2", "l3"), 0755); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	for _, depth := range []int{0, -3, 99} {
		listing, err := app.ReadDirTree(dir, depth)
		if err != nil {
			t.Fatal(err)
		}
		if listing.Depth < 1 || listing.Depth > fsops.DirTreeMaxDepth {
			t.Fatalf("depth %d 未被钳制: %+v", depth, listing)
		}
	}
	// depth 1 只列一层
	listing, err := app.ReadDirTree(dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Root.Children) != 1 || listing.Root.Children[0].Children != nil {
		t.Fatalf("depth 1 = %+v", listing.Root)
	}
}

func TestReadDirTreeRejectsFileAndMissing(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "x.txt")
	if err := os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if _, err := app.ReadDirTree(file, 2); err == nil {
		t.Fatal("文件路径应报错")
	}
	if _, err := app.ReadDirTree(filepath.Join(dir, "missing"), 2); err == nil {
		t.Fatal("不存在路径应报错")
	}
	if _, err := app.ReadDirTree("  ", 2); err == nil {
		t.Fatal("空路径应报错")
	}
}
