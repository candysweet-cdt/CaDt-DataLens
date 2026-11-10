package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetPathInfo(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sample.json")
	if err := os.WriteFile(file, []byte("{\"a\":1}"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	info, err := app.GetPathInfo(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "sample.json" || info.IsDir || info.Size != 7 {
		t.Fatalf("unexpected info: %+v", info)
	}
	if info.Modified <= 0 {
		t.Fatalf("expected modified time, got %d", info.Modified)
	}
	if info.ReadOnly {
		t.Fatalf("expected writable file")
	}
	if _, err := app.GetPathInfo(""); err == nil {
		t.Fatal("expected error for empty path")
	}
	if _, err := app.GetPathInfo(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("expected error for missing file")
	}
}
