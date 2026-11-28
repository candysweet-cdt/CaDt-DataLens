package fsops

// AssertWritablePath / WriteBoundaryCheck 的表驱动测试（能力快照方案 §5.5 / §11.2）。
// 覆盖：正常放行、穿越逃逸、大小写与分隔符变体、symlink 逐节拒绝、不存在的可写根
// （宽松解析）、空根 fail-closed、新增文件（末节不存在）。

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, roots []string) string {
	t.Helper()
	data, err := json.Marshal(roots)
	if err != nil {
		t.Fatalf("marshal roots: %v", err)
	}
	return string(data)
}

func TestWriteBoundaryCheckAllowsInsideRoot(t *testing.T) {
	root := t.TempDir()
	norm, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(root, "草稿区", "a.txt"))
	if err != nil {
		t.Fatalf("前缀内应放行: %v", err)
	}
	if !filepath.IsAbs(norm) {
		t.Fatalf("返回值必须是绝对路径: %q", norm)
	}
	// 根本身也算在内
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), root); err != nil {
		t.Fatalf("可写根自身应放行: %v", err)
	}
}

func TestWriteBoundaryCheckRejectsEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	// 工作区外绝对路径
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(outside, "x.txt")); err == nil {
		t.Fatal("工作区外路径应拒绝")
	}
	// .. 穿越形态
	escaped := filepath.Join(root, "..", filepath.Base(outside), "x.txt")
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), escaped); err == nil {
		t.Fatal(".. 穿越应拒绝")
	}
}

func TestWriteBoundaryCheckCaseAndSeparatorVariants(t *testing.T) {
	root := strings.ToUpper(t.TempDir())
	// 大小写变体（Windows 不敏感）
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), strings.ToLower(filepath.Join(root, "a.txt"))); err != nil {
		t.Fatalf("大小写变体应放行: %v", err)
	}
	// 正反斜杠混用
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.ToSlash(filepath.Join(root, "a.txt"))); err != nil {
		t.Fatalf("正斜杠形态应放行: %v", err)
	}
	// 前缀兄弟目录不误放：root-X 不是 root 的子路径
	sibling := root + "-x"
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(sibling, "a.txt")); err == nil {
		t.Fatal("同名前缀兄弟目录应拒绝")
	}
}

func TestWriteBoundaryCheckRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows 建 symlink 需要开发者模式或特权：先探测，不行就跳过（CI / 普通账户环境）
		probe := filepath.Join(t.TempDir(), "probe")
		if err := os.Symlink(t.TempDir(), probe); err != nil {
			t.Skipf("当前环境不支持符号链接: %v", err)
		}
		_ = os.Remove(probe)
	}
	root := t.TempDir()
	link := filepath.Join(root, "link")
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Skipf("创建符号链接失败: %v", err)
	}
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(link, "a.txt")); err == nil {
		t.Fatal("写穿符号链接应拒绝（防线 1）")
	}
	// 链接是中间节同样拒绝
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "dir"), filepath.Join(root, "dir2")); err != nil {
		t.Skipf("创建符号链接失败: %v", err)
	}
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(root, "dir2", "a.txt")); err == nil {
		t.Fatal("中间节是链接应拒绝")
	}
	// 新建文件落在链接目录下（叶节不存在）：祖先节的链接同样要拒绝——
	// 这里曾因「叶不存在提前返回」漏查祖先（2026-11-28 自检发现），用例钉住
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(link, "new.txt")); err == nil {
		t.Fatal("新建文件经过链接祖先应拒绝")
	}
}

// TestWriteBoundaryCheckRejectsJunction 用 NTFS junction（mklink /J，不需要特权）覆盖
// symlink 用例在无特权 Windows 环境被跳过的空档：junction 也是 reparse point，但 Go 的
// os.Lstat **不**为它报 ModeSymlink（实测 mode 显示 ?---------，与 platform_windows.go
// 注释一致），必须走 isReparsePoint 的 ReparseTag 精确判定才能被防线 1 拦住。
func TestWriteBoundaryCheckRejectsJunction(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junction 仅 Windows 有意义；类 Unix 的 symlink 已由 TestWriteBoundaryCheckRejectsSymlink 覆盖")
	}
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "jump")
	if err := exec.Command("cmd", "/c", "mklink", "/J", link, outside).Run(); err != nil {
		t.Skipf("创建 junction 失败: %v", err)
	}
	// 已存在文件写穿 junction → 拒绝
	if err := os.WriteFile(filepath.Join(outside, "t.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(link, "t.txt")); err == nil {
		t.Fatal("写穿 junction 应拒绝")
	}
	// 新建文件落在 junction 目录下（祖先节是 reparse point）→ 拒绝
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(link, "new.txt")); err == nil {
		t.Fatal("新建文件经过 junction 祖先应拒绝")
	}
}

func TestWriteBoundaryCheckMissingRootAndEmptyRoots(t *testing.T) {
	// 尚不存在的可写根（预声明草稿区）：宽松解析后放行其子路径
	base := t.TempDir()
	missing := filepath.Join(base, "not-created-yet")
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{missing}), filepath.Join(missing, "a.txt")); err != nil {
		t.Fatalf("预声明未创建根应放行: %v", err)
	}
	// 空根 fail-closed
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{}), filepath.Join(base, "a.txt")); err == nil {
		t.Fatal("空可写根应一律拒绝")
	}
	// 坏 JSON
	if _, err := new(FS).WriteBoundaryCheck("not-json", base); err == nil {
		t.Fatal("坏 JSON 应报错")
	}
	// 空路径
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{base}), ""); err == nil {
		t.Fatal("空写入路径应报错")
	}
}

func TestWriteBoundaryCheckNewFileUnderExistingDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sub")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 末节不存在（新文件）：前缀仍要成立
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{root}), filepath.Join(dir, "new.txt")); err != nil {
		t.Fatalf("新文件应放行: %v", err)
	}
}

func TestWriteBoundaryCheckVolumeRoot(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("盘符根仅 Windows 有意义")
	}
	tmp := t.TempDir()
	vol := filepath.VolumeName(tmp) + `\`
	if len(vol) < 3 {
		t.Skipf("无盘符卷名：%q", vol)
	}
	// 盘根作可写根：Clean 保留尾部分隔符，withinPrefix 不得再拼一个 sep（否则整盘误拒）
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{vol}), filepath.Join(vol, "Windows", "notepad.exe")); err != nil {
		t.Fatalf("盘根下的路径应放行: %v", err)
	}
	// 卷外形态（UNC）不在盘根内
	if _, err := new(FS).WriteBoundaryCheck(mustJSON(t, []string{vol}), `\server\share\x.txt`); err == nil {
		t.Fatal("UNC 路径不应在盘根内")
	}
}
