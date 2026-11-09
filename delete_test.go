package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDeleteEntryValidation(t *testing.T) {
	called := false
	remove := func(string) error {
		called = true
		return nil
	}
	if err := deleteEntryWith("", remove); err == nil {
		t.Fatal("空路径应报错")
	}
	if called {
		t.Fatal("空路径不应调用删除动作")
	}
	if err := deleteEntryWith("   ", remove); err == nil {
		t.Fatal("空白路径应报错")
	}
	if runtime.GOOS == "windows" {
		if err := deleteEntryWith(`C:\`, remove); err == nil {
			t.Fatal("盘符根目录应被拒绝")
		}
	}
	if called {
		t.Fatal("非法路径不应调用删除动作")
	}

	missing := filepath.Join(t.TempDir(), "missing.txt")
	if err := deleteEntryWith(missing, remove); err == nil {
		t.Fatal("不存在的路径应报错")
	}
	if called {
		t.Fatal("不存在的路径不应调用删除动作")
	}
}

func TestDeleteEntryWith(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(sub, "b.txt")
	if err := os.WriteFile(child, []byte("nested"), 0o644); err != nil {
		t.Fatal(err)
	}

	var moved []string
	remove := func(path string) error {
		moved = append(moved, path)
		return os.RemoveAll(path)
	}
	if err := deleteEntryWith(" "+file+" ", remove); err != nil {
		t.Fatalf("删除文件失败: %v", err)
	}
	if entryExists(file) {
		t.Fatal("文件仍然存在")
	}
	if err := deleteEntryWith(sub, remove); err != nil {
		t.Fatalf("删除目录失败: %v", err)
	}
	if entryExists(child) {
		t.Fatal("目录内文件仍然存在")
	}
	if len(moved) != 2 || moved[0] != file || moved[1] != sub {
		t.Fatalf("删除动作参数不符: %#v", moved)
	}
}
