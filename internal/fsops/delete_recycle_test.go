package fsops

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
	if EntryExists(file) {
		t.Fatal("文件仍在原位置")
	}
}

// AI delete_path 工具的专用入口（delete_platform_*.go）：文件与目录都进回收站。
func TestDeleteEntryRecycleMovesToRecycleBin(t *testing.T) {
	if os.Getenv("CADT_TEST_RECYCLE") == "" {
		t.Skip("设置 CADT_TEST_RECYCLE=1 才执行系统回收站测试")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	nested := filepath.Join(dir, "sub", "b.txt")
	for _, p := range []string{file, nested} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	f := &FS{}
	if err := f.DeleteEntryRecycle(file); err != nil {
		t.Fatalf("删除文件失败: %v", err)
	}
	if EntryExists(file) {
		t.Fatal("文件仍在原位置")
	}
	if err := f.DeleteEntryRecycle(filepath.Join(dir, "sub")); err != nil {
		t.Fatalf("删除目录失败: %v", err)
	}
	if EntryExists(filepath.Join(dir, "sub")) {
		t.Fatal("目录仍在原位置")
	}
	// 校验闸复用：盘符根 / 不存在路径拒绝
	if err := f.DeleteEntryRecycle(filepath.VolumeName(dir) + "\\"); err == nil {
		t.Fatal("盘符根目录应被拒绝")
	}
	if err := f.DeleteEntryRecycle(filepath.Join(dir, "no-such.txt")); err == nil {
		t.Fatal("不存在的路径应报错")
	}
}
