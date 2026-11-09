package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 真正走一次系统回收站需要 Shell 环境，默认跳过；用 CADT_TEST_RECYCLE=1 手动跑。
func TestDeleteEntryMovesToRecycleBin(t *testing.T) {
	if os.Getenv("CADT_TEST_RECYCLE") == "" {
		t.Skip("设置 CADT_TEST_RECYCLE=1 才执行系统回收站测试")
	}
	file := filepath.Join(t.TempDir(), "cadt-delete-test.txt")
	if err := os.WriteFile(file, []byte("recycle me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := deleteEntry(file); err != nil {
		t.Fatalf("移到回收站失败: %v", err)
	}
	if entryExists(file) {
		t.Fatal("文件仍在原位置")
	}
}
