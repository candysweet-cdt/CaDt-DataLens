//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"time"
)

// 编程语言环境检测：定位解释器/编译器/构建工具并取版本号，一个语言可扫出多个环境。
// 结果由前端缓存到设置里，不在这里落盘——检测按需触发（首次打开面板自动扫一次 + 手动按钮）。
// 这些信息为后续的“辅助运行代码”功能预留。

type ToolchainInfo struct {
	OK      bool   `json:"ok"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

type ToolchainScan struct {
	Envs []ToolchainInfo `json:"envs"`
}

func runTool(exe string, args ...string) (string, string, error) {
	resolved, err := exec.LookPath(exe)
	if err != nil {
		return "", "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, resolved, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.CombinedOutput()
	return resolved, string(out), err
}

func firstLine(output string) string {
	lines := nonEmptyLines(output)
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}

// versionLine 从工具输出里挑出版本行；gradle 的 --version 首行是欢迎语，取含 Gradle 的那行
func versionLine(kind, output string) string {
	lines := nonEmptyLines(output)
	if len(lines) == 0 {
		return ""
	}
	if kind == "gradle" {
		for _, ln := range lines {
			if strings.Contains(ln, "Gradle ") {
				return ln
			}
		}
	}
	return lines[0]
}

func nonEmptyLines(output string) []string {
	var lines []string
	for _, ln := range strings.Split(output, "\n") {
		ln = strings.TrimSpace(ln)
		if ln != "" {
			if len(ln) > 160 {
				ln = ln[:160]
			}
			lines = append(lines, ln)
		}
	}
	return lines
}

// defaultVersionArgs 各工具取版本的固定参数
func defaultVersionArgs(kind string) []string {
	switch kind {
	case "go":
		return []string{"version"}
	case "java":
		return []string{"-version"} // 版本输出走 stderr，CombinedOutput 能接到
	case "lua":
		return []string{"-v"}
	default:
		return []string{"--version"}
	}
}

// candidateExes PATH 上的候选可执行名（按优先级，扫出多个环境时排在前面的默认选中）
func candidateExes(kind string) []string {
	switch kind {
	case "python":
		return []string{"python", "py", "python3"}
	case "pip":
		return []string{"pip", "pip3"}
	case "node":
		return []string{"node"}
	case "npm":
		return []string{"npm"}
	case "pnpm":
		return []string{"pnpm"}
	case "yarn":
		return []string{"yarn"}
	case "go":
		return []string{"go"}
	case "java":
		return []string{"java"}
	case "maven":
		return []string{"mvn"}
	case "gradle":
		return []string{"gradle"}
	case "c":
		return []string{"gcc", "clang"}
	case "cpp":
		return []string{"g++", "clang++"}
	case "cmake":
		return []string{"cmake"}
	case "rust":
		return []string{"rustc"}
	case "cargo":
		return []string{"cargo"}
	case "php":
		return []string{"php"}
	case "composer":
		return []string{"composer"}
	case "ruby":
		return []string{"ruby"}
	case "gem":
		return []string{"gem"}
	case "lua":
		return []string{"lua", "lua5.4", "lua5.3", "luajit"}
	}
	return nil
}

// toolchainGlobs 常见安装目录的通配扫描（PATH 上找不到或存在多套安装时兜底）
func toolchainGlobs(kind string) []string {
	home := os.Getenv("USERPROFILE")
	local := os.Getenv("LOCALAPPDATA")
	switch kind {
	case "python":
		return []string{
			filepath.Join(local, "Programs", "Python", "Python*", "python.exe"),
			filepath.Join(`C:\Python*`, "python.exe"),
		}
	case "node":
		return []string{
			filepath.Join(`C:\Program Files\nodejs`, "node.exe"),
			filepath.Join(os.Getenv("APPDATA"), "nvm", "v*", "node.exe"),
		}
	case "go":
		return []string{
			filepath.Join(`C:\Program Files\Go`, "bin", "go.exe"),
			filepath.Join(`C:\Go`, "bin", "go.exe"),
			filepath.Join(local, "Programs", "Go", "bin", "go.exe"),
		}
	case "java":
		return []string{
			filepath.Join(`C:\Program Files\Java`, "*", "bin", "java.exe"),
			filepath.Join(`C:\Program Files\Eclipse Adoptium`, "*", "bin", "java.exe"),
			filepath.Join(`C:\Program Files (x86)\Java`, "*", "bin", "java.exe"),
		}
	case "gradle":
		return []string{
			filepath.Join(`C:\Gradle`, "*", "bin", "gradle.bat"),
			filepath.Join(`C:\Program Files\gradle*`, "bin", "gradle.bat"),
			// gradle-wrapper 下载的发行版（不在 PATH 上）
			filepath.Join(home, ".gradle", "wrapper", "dists", "*", "*", "gradle-*", "bin", "gradle.bat"),
			filepath.Join(`C:\ProgramData\chocolatey\lib\gradle`, "tools", "gradle*", "bin", "gradle.bat"),
		}
	case "maven":
		return []string{
			filepath.Join(`C:\Program Files\apache-maven*`, "bin", "mvn.cmd"),
			filepath.Join(`C:\apache-maven*`, "bin", "mvn.cmd"),
			filepath.Join(`C:\Program Files (x86)\apache-maven*`, "bin", "mvn.cmd"),
			filepath.Join(`C:\ProgramData\chocolatey\lib\maven`, "apache-maven*", "bin", "mvn.cmd"),
		}
	case "c":
		return []string{
			filepath.Join(`C:\msys64`, "mingw64", "bin", "gcc.exe"),
			filepath.Join(`C:\mingw64`, "bin", "gcc.exe"),
			filepath.Join(`C:\TDM-GCC-64`, "bin", "gcc.exe"),
			filepath.Join(`C:\Program Files\LLVM`, "bin", "clang.exe"),
		}
	case "cpp":
		return []string{
			filepath.Join(`C:\msys64`, "mingw64", "bin", "g++.exe"),
			filepath.Join(`C:\mingw64`, "bin", "g++.exe"),
			filepath.Join(`C:\TDM-GCC-64`, "bin", "g++.exe"),
		}
	case "cmake":
		return []string{
			filepath.Join(`C:\Program Files\CMake`, "bin", "cmake.exe"),
		}
	case "rust":
		return []string{
			filepath.Join(home, ".rustup", "toolchains", "*", "bin", "rustc.exe"),
			filepath.Join(home, ".cargo", "bin", "rustc.exe"),
		}
	case "cargo":
		return []string{
			filepath.Join(home, ".cargo", "bin", "cargo.exe"),
		}
	}
	return nil
}

var pyExePathRe = regexp.MustCompile(`(?i)[A-Za-z]:\\.+?\.exe`)

// pythonLauncherEnvs 用 py 启动器枚举本机注册的全部 Python（py -0p）
func pythonLauncherEnvs() []ToolchainInfo {
	_, out, err := runTool("py", "-0p")
	if err != nil && strings.TrimSpace(out) == "" {
		return nil
	}
	var list []ToolchainInfo
	for _, line := range strings.Split(out, "\n") {
		m := pyExePathRe.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		p := strings.TrimSpace(m[0])
		if st, serr := os.Stat(p); serr != nil || st.IsDir() {
			continue
		}
		_, vout, _ := runTool(p, "--version")
		v := firstLine(vout)
		if v == "" {
			v = p
		}
		list = append(list, ToolchainInfo{OK: true, Path: p, Version: v})
	}
	return list
}

// corepackToolEnvs 扫描 corepack 托管的 pnpm / yarn（不在 PATH 上时兜底）。
// pnpm 12 在 corepack 存储里带原生 exe；旧版与 yarn 是 .cjs/.js 入口，用 node 运行。
func corepackToolEnvs(tool string) []ToolchainInfo {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return nil
	}
	var patterns []string
	switch tool {
	case "pnpm":
		patterns = []string{
			filepath.Join(local, "node", "corepack", "v1", "pnpm", "*", "pnpm-native.exe"),
			filepath.Join(local, "node", "corepack", "v1", "pnpm", "*", "bin", "pnpm.cjs"),
		}
	case "yarn":
		patterns = []string{
			filepath.Join(local, "node", "corepack", "v1", "yarn", "*", "bin", "yarn.js"),
		}
	default:
		return nil
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil
	}
	args := defaultVersionArgs(tool)
	var list []ToolchainInfo
	for _, pattern := range patterns {
		matches, _ := filepath.Glob(pattern)
		for _, m := range matches {
			exe := m
			runArgs := args
			lower := strings.ToLower(m)
			if strings.HasSuffix(lower, ".cjs") || strings.HasSuffix(lower, ".js") {
				exe = node
				runArgs = append([]string{m}, args...)
			}
			_, out, err := runTool(exe, runArgs...)
			line := versionLine(tool, out)
			if line == "" {
				if err != nil {
					continue
				}
				continue
			}
			list = append(list, ToolchainInfo{OK: true, Path: m, Version: line})
		}
	}
	return list
}

// scanToolchain 汇总一个工具的全部可用环境：PATH 候选 + 安装目录扫描 + 启动器枚举，按路径去重。
// override 非空时只测用户指定的路径。
func scanToolchain(kind, override string) []ToolchainInfo {
	args := defaultVersionArgs(kind)
	seen := map[string]bool{}
	envs := []ToolchainInfo{}
	add := func(path, version string) {
		key := strings.ToLower(strings.TrimSpace(path))
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		envs = append(envs, ToolchainInfo{OK: true, Path: path, Version: version})
	}
	check := func(exe string) {
		path, out, err := runTool(exe, args...)
		line := versionLine(kind, out)
		// 版本行拿到了就算成功（个别工具版本输出走 stderr 且退出码非 0）
		if err != nil && line == "" {
			return
		}
		if line == "" {
			return
		}
		add(path, line)
	}

	if override != "" {
		path, out, err := runTool(override, args...)
		line := versionLine(kind, out)
		if line == "" {
			msg := "指定的路径没有输出版本信息"
			if err != nil {
				msg = "指定的路径不可用：" + err.Error()
			}
			return []ToolchainInfo{{OK: false, Error: msg}}
		}
		add(path, line)
		return envs
	}

	for _, exe := range candidateExes(kind) {
		check(exe)
	}
	if kind == "python" {
		for _, info := range pythonLauncherEnvs() {
			add(info.Path, info.Version)
		}
	}
	if os.Getenv("JAVA_HOME") != "" && kind == "java" {
		check(filepath.Join(os.Getenv("JAVA_HOME"), "bin", "java.exe"))
	}
	if kind == "pnpm" || kind == "yarn" {
		for _, info := range corepackToolEnvs(kind) {
			add(info.Path, info.Version)
		}
	}
	for _, pattern := range toolchainGlobs(kind) {
		matches, _ := filepath.Glob(pattern)
		for _, m := range matches {
			check(m)
			if len(envs) >= 8 {
				break
			}
		}
		if len(envs) >= 8 {
			break
		}
	}
	if len(envs) > 8 {
		envs = envs[:8]
	}
	return envs
}

// DetectToolchain 检测指定工具的全部环境（路径 + 版本）。
func (a *App) DetectToolchain(kind string, override string) (*ToolchainScan, error) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	override = strings.TrimSpace(override)
	envs := []ToolchainInfo{}
	if kind != "" {
		envs = scanToolchain(kind, override)
	}
	if envs == nil {
		envs = []ToolchainInfo{}
	}
	return &ToolchainScan{Envs: envs}, nil
}

// ---- 已安装包扫描：pip（全局 / .venv）与 npm（全局 / 项目 node_modules） ----

type LangPackage struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type LangPackageList struct {
	Packages []LangPackage `json:"packages"`
	Exists   bool          `json:"exists"`
	Error    string        `json:"error,omitempty"`
}

func runToolIn(dir, exe string, args ...string) (string, string, error) {
	resolved, err := exec.LookPath(exe)
	if err != nil {
		return "", "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, resolved, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.CombinedOutput()
	return resolved, string(out), err
}

func parsePipJSON(out string) []LangPackage {
	// CombinedOutput 会混入 stderr 的警告，截出最外层 JSON 数组再解析
	start := strings.Index(out, "[")
	end := strings.LastIndex(out, "]")
	if start < 0 || end <= start {
		return []LangPackage{}
	}
	var raw []struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &raw); err != nil {
		return []LangPackage{}
	}
	list := make([]LangPackage, 0, len(raw))
	for _, r := range raw {
		if r.Name == "" {
			continue
		}
		list = append(list, LangPackage{Name: r.Name, Version: r.Version})
	}
	return list
}

func parseNpmJSON(out string) []LangPackage {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start < 0 || end <= start {
		return []LangPackage{}
	}
	var data struct {
		Dependencies map[string]struct {
			Version string `json:"version"`
		} `json:"dependencies"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &data); err != nil || len(data.Dependencies) == 0 {
		return []LangPackage{}
	}
	list := make([]LangPackage, 0, len(data.Dependencies))
	for name, dep := range data.Dependencies {
		list = append(list, LangPackage{Name: name, Version: dep.Version})
	}
	sort.Slice(list, func(i, j int) bool { return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name) })
	return list
}

// parseGoModules 解析 go list -m -json all 的流式 JSON，取 go.mod 里的直接依赖（跳过主模块与间接依赖）
func parseGoModules(out string) []LangPackage {
	dec := json.NewDecoder(strings.NewReader(out))
	list := []LangPackage{}
	for {
		var m struct {
			Path     string `json:"Path"`
			Version  string `json:"Version"`
			Indirect bool   `json:"Indirect"`
			Main     bool   `json:"Main"`
		}
		if err := dec.Decode(&m); err != nil {
			break
		}
		if m.Main || m.Indirect || m.Path == "" || m.Version == "" {
			continue
		}
		list = append(list, LangPackage{Name: m.Path, Version: m.Version})
	}
	return list
}

// ListLangPackages 列出包管理器已安装的包。
// kind+scope: pip/env（target=选中的 Python 解释器路径，取该环境已装的包）；
//
//	npm/global、npm/project（target=项目目录，读项目 node_modules）。
func (a *App) ListLangPackages(kind string, scope string, target string) (*LangPackageList, error) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	scope = strings.ToLower(strings.TrimSpace(scope))
	target = strings.TrimSpace(target)
	list := &LangPackageList{Packages: []LangPackage{}, Exists: true}
	switch kind + "/" + scope {
	case "pip/env":
		exe := target
		if exe == "" {
			resolved, err := exec.LookPath("python")
			if err == nil {
				exe = resolved
			} else if resolved2, err2 := exec.LookPath("py"); err2 == nil {
				_, out, _ := runTool(resolved2, "-m", "pip", "list", "--format", "json")
				list.Packages = parsePipJSON(out)
				return list, nil
			} else if resolved3, err3 := exec.LookPath("python3"); err3 == nil {
				exe = resolved3
			} else {
				list.Exists = false
				list.Error = "未找到 Python 解释器"
				return list, nil
			}
		}
		if _, err := os.Stat(exe); err != nil {
			list.Exists = false
			list.Error = "解释器不存在：" + exe
			return list, nil
		}
		_, out, err := runTool(exe, "-m", "pip", "list", "--format", "json")
		if err != nil && strings.TrimSpace(out) == "" {
			list.Error = "pip 不可用：" + err.Error()
			return list, nil
		}
		list.Packages = parsePipJSON(out)
	case "npm/global":
		_, out, err := runTool("npm", "ls", "-g", "--depth", "0", "--json")
		if err != nil && strings.TrimSpace(out) == "" {
			list.Error = "npm 不可用：" + err.Error()
			return list, nil
		}
		list.Packages = parseNpmJSON(out)
	case "npm/project":
		if target == "" {
			list.Exists = false
			return list, nil
		}
		if _, err := os.Stat(filepath.Join(target, "package.json")); err != nil {
			list.Exists = false
			return list, nil
		}
		_, out, err := runToolIn(target, "npm", "ls", "--depth", "0", "--json")
		if err != nil && strings.TrimSpace(out) == "" {
			list.Error = "npm ls 失败：" + err.Error()
			return list, nil
		}
		list.Packages = parseNpmJSON(out)
	case "go/project":
		if target == "" {
			list.Exists = false
			return list, nil
		}
		if _, err := os.Stat(filepath.Join(target, "go.mod")); err != nil {
			list.Exists = false
			return list, nil
		}
		_, out, err := runToolIn(target, "go", "list", "-m", "-json", "all")
		if err != nil && strings.TrimSpace(out) == "" {
			list.Error = "go list 失败：" + err.Error()
			return list, nil
		}
		list.Packages = parseGoModules(out)
	}
	return list, nil
}
