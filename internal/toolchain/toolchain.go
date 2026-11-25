// Package toolchain 编程语言环境检测（Windows 下定位解释器/编译器并取版本）。
package toolchain

import (
	"os"
	"path/filepath"
	"strings"
)

// Toolchain 语言环境检测引擎（无状态）。
type Toolchain struct{}

// homeEnvGlob 把「环境变量指向的安装根」变成可执行文件通配路径。
// 各语言约定俗成的 *_HOME 环境变量（NVM_HOME / MAVEN_HOME / GOROOT / JAVA_HOME /
// RUSTUP_HOME / CARGO_HOME ...）往往才是真正的安装位置，PATH 里未必有、也不在固定目录。
// 只接受绝对路径、去掉尾部斜杠与引号，避免拼出畸形路径。
func homeEnvGlob(envName string, parts ...string) string {
	root := strings.TrimSpace(os.Getenv(envName))
	root = strings.Trim(root, `"'`)
	if root == "" || !filepath.IsAbs(root) {
		return ""
	}
	return filepath.Join(append([]string{filepath.Clean(root)}, parts...)...)
}

// appendEnvGlobs 追加若干环境变量根派生的 glob，自动跳过空值（环境变量未设置）。
func appendEnvGlobs(base []string, globs ...string) []string {
	for _, g := range globs {
		if g != "" {
			base = append(base, g)
		}
	}
	return base
}

// condaPythonGlobs 返回 Anaconda / Miniconda 常见安装位置下 python.exe 的通配路径。
// Anaconda 图形安装器默认装进用户目录 / ProgramData，且不注册到 py 启动器，
// 单靠 PATH 候选 + py -0p 扫不到——补这一组 glob 兜底。
// home=USERPROFILE、local=LOCALAPPDATA、programData=ProgramData。
// 抽成纯函数（环境变量作为参数传入）以便跨平台表驱动测试；用 [Aa]/[Mm] 字符类
// 一并覆盖 Anaconda3 / anaconda3 两种常见大小写。
func condaPythonGlobs(home, local, programData string) []string {
	var out []string
	add := func(base string, parts ...string) {
		if base == "" {
			return
		}
		out = append(out, filepath.Join(append([]string{base}, parts...)...))
	}
	// 用户目录：Anaconda / Miniconda 图形安装器默认位置
	add(home, "[Aa]naconda3", "python.exe")
	add(home, "[Mm]iniconda3", "python.exe")
	// LOCALAPPDATA：部分 Miniconda / Continuum 安装器
	add(local, "Continuum", "[Aa]naconda3", "python.exe")
	add(local, "[Mm]iniconda3", "python.exe")
	// ProgramData：系统级安装（所有用户）
	add(programData, "[Aa]naconda3", "python.exe")
	add(programData, "[Mm]iniconda3", "python.exe")
	// C:\ 根：老版本默认路径（不依赖环境变量）
	out = append(out,
		filepath.Join(`C:\`, "[Aa]naconda3", "python.exe"),
		filepath.Join(`C:\`, "[Mm]iniconda3", "python.exe"),
	)
	return out
}
