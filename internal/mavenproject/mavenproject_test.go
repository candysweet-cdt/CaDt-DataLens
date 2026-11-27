package mavenproject

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writePom(t *testing.T, dir string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "pom.xml"), []byte(content), 0o600); err != nil {
		t.Fatalf("写 pom.xml 失败：%v", err)
	}
}

func TestReadProjectModules(t *testing.T) {
	root := t.TempDir()
	writePom(t, root, `<project xmlns="http://maven.apache.org/POM/4.0.0">
		<name>sky</name><artifactId>sky-parent</artifactId><packaging>pom</packaging>
		<modules><module>sky-admin</module><module>sky-common</module><module>${skip.me}</module><module>../outside</module></modules>
	</project>`)
	web := filepath.Join(root, "sky-admin")
	if err := os.MkdirAll(web, 0o700); err != nil {
		t.Fatal(err)
	}
	writePom(t, web, `<project><artifactId>sky-admin</artifactId><modules><module>web-core</module></modules></project>`)
	core := filepath.Join(web, "web-core")
	if err := os.MkdirAll(core, 0o700); err != nil {
		t.Fatal(err)
	}
	writePom(t, core, `<project><artifactId>web-core</artifactId></project>`)
	bare := filepath.Join(root, "sky-common")
	if err := os.MkdirAll(bare, 0o700); err != nil {
		t.Fatal(err)
	}

	info, err := ReadProject(root)
	if err != nil {
		t.Fatalf("ReadProject 失败：%v", err)
	}
	if info.ArtifactId != "sky-parent" || info.Name != "sky" || info.Packaging != "pom" {
		t.Fatalf("pom 元数据错误：%+v", info)
	}
	if len(info.Modules) != 2 {
		t.Fatalf("占位与越界模块应被跳过，实际 %d 个：%+v", len(info.Modules), info.Modules)
	}
	if info.Skipped != 2 {
		t.Fatalf("占位(${skip.me})与越界(../outside)应计入 Skipped=2，实际 %d", info.Skipped)
	}
	admin := info.Modules[0]
	if admin.Name != "sky-admin" || admin.RelPath != "sky-admin" || !admin.HasPom || admin.ArtifactId != "sky-admin" {
		t.Fatalf("sky-admin 解析错误：%+v", admin)
	}
	if len(admin.Modules) != 1 || admin.Modules[0].RelPath != "sky-admin/web-core" || admin.Modules[0].ArtifactId != "web-core" {
		t.Fatalf("嵌套模块解析错误：%+v", admin.Modules)
	}
	if info.Modules[1].HasPom {
		t.Errorf("没有 pom.xml 的模块不应标记 HasPom：%+v", info.Modules[1])
	}
	if !strings.HasSuffix(info.SettingsPath, filepath.Join(".m2", "settings.xml")) {
		t.Errorf("settings.xml 路径错误：%s", info.SettingsPath)
	}
}

func TestReadProjectFallbacksAndErrors(t *testing.T) {
	root := t.TempDir()
	writePom(t, root, "<project></project>")
	info, err := ReadProject(root)
	if err != nil {
		t.Fatalf("ReadProject 失败：%v", err)
	}
	if info.ArtifactId != filepath.Base(root) || info.Name != info.ArtifactId {
		t.Fatalf("缺 artifactId 应回退目录名：%+v", info)
	}
	if _, err := ReadProject(""); err == nil {
		t.Error("空路径应报错")
	}
	if _, err := ReadProject(filepath.Join(root, "missing")); err == nil {
		t.Error("不存在的目录应报错")
	}
	empty := t.TempDir()
	if _, err := ReadProject(empty); err == nil {
		t.Error("没有 pom.xml 应报错")
	}
}

func TestValidateModuleRelPath(t *testing.T) {
	for _, ok := range []string{"", "sky-admin", "a/b/c"} {
		if err := validateModuleRelPath(ok); err != nil {
			t.Errorf("%q 不应报错：%v", ok, err)
		}
	}
	// cmd /c 包装下元字符会被再解释：<module> 原文来自不可信 pom，白名单外一律拒绝
	for _, bad := range []string{"..", "a/../b", "/abs", "C:\\x", "C:/x",
		"foo&bar", "a|b", "x>y", "a<b", "%VAR%", "a^b", "a!b", `a"b`, "a b", "a;b"} {
		if err := validateModuleRelPath(bad); err == nil {
			t.Errorf("%q 应报错", bad)
		}
	}
}

func TestRunDataUnknownKind(t *testing.T) {
	if _, err := RunData("", "", 0, "install", ""); err == nil {
		t.Error("未知 kind 应报错（任意 goal 走运行通道，不走数据命令）")
	}
}

// fake-mvn.cmd 只认「最后一个参数是 -Doutput=<路径>」这一条约定，把固定内容写进该文件——
// 用来在不起真 Maven 的情况下打通「cmd 包装 + 临时文件 + 读回」全链路。
// 注意：cmd 的普通 for 会把 '=' 当分隔符，所以最后一个 token 恰好就是输出路径本身。
const fakeMvnScript = "@echo off\r\n" +
	"set \"arg=\"\r\n" +
	"for %%a in (%*) do set \"arg=%%a\"\r\n" +
	"> \"%arg%\" echo fake-effective-pom\r\n" +
	"exit /b 0\r\n"

func TestEffectivePomWithFakeMvn(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("fake mvn.cmd 仅在 Windows 上跑")
	}
	fake := filepath.Join(t.TempDir(), "fake-mvn.cmd")
	if err := os.WriteFile(fake, []byte(fakeMvnScript), 0o600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	out, err := EffectivePom(root, fake, 15000, "")
	if err != nil {
		t.Fatalf("EffectivePom 失败：%v", err)
	}
	if !strings.Contains(out, "fake-effective-pom") {
		t.Errorf("应读回临时文件内容：%q", out)
	}
}

// 回归：mvn 路径含空格（如 C:\Program Files\apache-maven-*\bin\mvn.cmd）时，
// cmd /c 必须能正确启动它——这是本机 Maven 探测 toolchainGlobs 扫到的真实路径形态。
func TestEffectivePomWithSpacedMvnPath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("fake mvn.cmd 仅在 Windows 上跑")
	}
	spacedDir := filepath.Join(t.TempDir(), "Program Files", "apache-maven-3.9.13", "bin")
	if err := os.MkdirAll(spacedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(spacedDir, "mvn.cmd")
	if err := os.WriteFile(fake, []byte(fakeMvnScript), 0o600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	out, err := EffectivePom(root, fake, 15000, "")
	if err != nil {
		t.Fatalf("含空格 mvn 路径应能执行：%v", err)
	}
	if !strings.Contains(out, "fake-effective-pom") {
		t.Errorf("应读回临时文件内容：%q", out)
	}
}

func TestRunDataExitCodeSurfaces(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("fake mvn.cmd 仅在 Windows 上跑")
	}
	fake := filepath.Join(t.TempDir(), "fake-mvn-fail.cmd")
	if err := os.WriteFile(fake, []byte("@echo off\r\necho boom\r\nexit /b 2\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := EffectivePom(t.TempDir(), fake, 15000, "")
	if err == nil {
		t.Fatal("非 0 退出应报错")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("报错应带 stderr 上下文：%v", err)
	}
}

// 自引用模块（<module>.</module>）不能无限递归：visited 去重后跳过，计入 Skipped。
func TestReadProjectSelfReferenceModule(t *testing.T) {
	root := t.TempDir()
	writePom(t, root, `<project><artifactId>root</artifactId><modules><module>.</module><module>sub</module></modules></project>`)
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	// sub 指回根（经 .. 已被路径校验拦）；用另一个自引用目录验证 visited
	writePom(t, sub, `<project><artifactId>sub</artifactId><modules><module>.</module></modules></project>`)
	info, err := ReadProject(root)
	if err != nil {
		t.Fatalf("ReadProject 失败：%v", err)
	}
	if len(info.Modules) != 1 || info.Modules[0].ArtifactId != "sub" {
		t.Fatalf("自引用根模块应被跳过，仅剩 sub：%+v", info.Modules)
	}
	if len(info.Modules[0].Modules) != 0 {
		t.Fatalf("sub 的自引用模块应被跳过：%+v", info.Modules[0].Modules)
	}
	if info.Skipped < 2 {
		t.Fatalf("根与 sub 各一次自引用应计入 Skipped>=2，实际 %d", info.Skipped)
	}
}

// 超大 pom（>4MB）应明确报错，不撑爆内存。
func TestReadProjectOversizedPom(t *testing.T) {
	root := t.TempDir()
	// 用合法 XML 外壳 + 超长注释撑过 4MB（注释不影响解析，但体积超限应早退）
	content := "<project><artifactId>x</artifactId><!--" + strings.Repeat("p", maxPomBytes+100) + "--></project>"
	if err := os.WriteFile(filepath.Join(root, "pom.xml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadProject(root); err == nil || !strings.Contains(err.Error(), "上限") {
		t.Fatalf("超大 pom 应报上限错误，实际：%v", err)
	}
}

// 畸形模块 pom 计入 Skipped，且仍保留目录节点（HasPom=false）。
func TestReadProjectMalformedModulePom(t *testing.T) {
	root := t.TempDir()
	writePom(t, root, `<project><artifactId>root</artifactId><modules><module>broken</module></modules></project>`)
	broken := filepath.Join(root, "broken")
	if err := os.MkdirAll(broken, 0o700); err != nil {
		t.Fatal(err)
	}
	writePom(t, broken, `<project><artifactId>broken`+"\n") // 未闭合
	info, err := ReadProject(root)
	if err != nil {
		t.Fatalf("ReadProject 失败：%v", err)
	}
	if len(info.Modules) != 1 || info.Modules[0].HasPom {
		t.Fatalf("畸形 pom 模块应保留目录但不标 HasPom：%+v", info.Modules)
	}
	if info.Skipped != 1 {
		t.Fatalf("畸形 pom 应计入 Skipped=1，实际 %d", info.Skipped)
	}
}
