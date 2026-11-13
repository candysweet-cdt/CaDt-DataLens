package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGetFileStat(t *testing.T) {
	app := &App{}
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := app.GetFileStat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exists || st.Mtime == "" || st.Size != 5 {
		t.Fatalf("unexpected stat: %#v", st)
	}
	missing, err := app.GetFileStat(filepath.Join(dir, "nope.txt"))
	if err != nil || missing.Exists {
		t.Fatalf("missing stat = %#v err=%v", missing, err)
	}
}

func TestSaveFileCheckedConflict(t *testing.T) {
	app := &App{}
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("base"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := app.GetFileStat(path)
	if err != nil {
		t.Fatal(err)
	}

	res, err := app.SaveFileChecked(path, "first", "lf", false, "utf-8", st.Mtime)
	if err != nil || res == nil || res.Conflict || !res.OK || res.Mtime == "" {
		t.Fatalf("save with matching mtime = %#v err=%v", res, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "first" {
		t.Fatalf("content = %q", got)
	}

	// 模拟外部修改：内容与 mtime 都变化
	if err := os.WriteFile(path, []byte("external"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	res, err = app.SaveFileChecked(path, "second", "lf", false, "utf-8", st.Mtime)
	if err != nil {
		t.Fatal(err)
	}
	if res == nil || !res.Conflict || res.Deleted {
		t.Fatalf("expected conflict, got %#v", res)
	}
	if got, _ := os.ReadFile(path); string(got) != "external" {
		t.Fatalf("external content should be preserved, got %q", got)
	}

	// 强制覆盖（expectMtime 为空）应写入
	res, err = app.SaveFileChecked(path, "forced", "lf", false, "utf-8", "")
	if err != nil || res == nil || res.Conflict || !res.OK {
		t.Fatalf("force save = %#v err=%v", res, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "forced" {
		t.Fatalf("force content = %q", got)
	}
}

func TestSaveFileCheckedDeleted(t *testing.T) {
	app := &App{}
	dir := t.TempDir()
	path := filepath.Join(dir, "gone.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := app.GetFileStat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	res, err := app.SaveFileChecked(path, "y", "lf", false, "utf-8", st.Mtime)
	if err != nil {
		t.Fatal(err)
	}
	if res == nil || !res.Conflict || !res.Deleted {
		t.Fatalf("expected deleted conflict, got %#v", res)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatal("conflict must not recreate the file")
	}
}
