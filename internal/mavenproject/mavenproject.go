// Package mavenproject：Maven 工具窗口的数据层——读 pom.xml 结构、起 mvn 数据命令
// （effective-pom / effective-settings / dependency:tree）返回原始文本。
// 不做 XML / 树文本解析（解析在前端），不 import main、不碰 App；
// 平台差异（mvn.cmd 需要 cmd.exe /c 包装）在 cmdwrap_windows.go / cmdwrap_other.go。
package mavenproject

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/executil"
	"datalens/internal/procctl"
)

// 数据命令的超时与输出上限：首次运行 effective-pom 可能要下载插件，默认给足余量；
// 输出超上限直接报错（依赖树 / 有效 POM 正常远小于此），防止撑爆前端。
const (
	defaultTimeoutMs = 180 * 1000
	maxTimeoutMs     = 15 * 60 * 1000
	maxOutputBytes   = 4 << 20
	maxPomBytes      = 4 << 20 // 单个 pom.xml 读取上限（畸形/超大文件早退，防撑爆内存）
	maxModuleDepth   = 4
)

// pomParseError：解析失败时若 XML 声明了非 UTF-8 编码，给出明确提示（L3），
// 不引入转码依赖（体积约束）；否则返回原始错误。
func pomParseError(data []byte, err error) error {
	head := string(data[:min(len(data), 256)])
	if i := strings.Index(strings.ToLower(head), "encoding="); i >= 0 {
		tail := head[i+len("encoding="):]
		if q := strings.IndexAny(tail, "\"'"); q >= 0 {
			enc := tail[q+1:]
			if e := strings.IndexAny(enc, "\"'"); e >= 0 {
				enc = enc[:e]
				if !strings.EqualFold(enc, "utf-8") && !strings.EqualFold(enc, "utf8") {
					return fmt.Errorf("解析 pom.xml 失败：声明了非 UTF-8 编码（%s），请先转成 UTF-8（%w）", enc, err)
				}
			}
		}
	}
	return fmt.Errorf("解析 pom.xml 失败：%w", err)
}

// readPomLimited 读单个 pom 文件，超 maxPomBytes 直接报错（含 BOM 的 XML 声明仍按原样交给 xml.Unmarshal）。
func readPomLimited(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxPomBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxPomBytes {
		return nil, fmt.Errorf("pom 文件超过 %d MB 上限", maxPomBytes>>20)
	}
	return data, nil
}

// ModuleInfo 是 pom.xml <modules> 里一个子模块的规整结果（递归，限深）。
type ModuleInfo struct {
	Name       string       `json:"name"`    // <module> 原文（相对父 pom 的路径片段）
	RelPath    string       `json:"relPath"` // 相对根 pom 的路径（-pl 参数用），'/' 分隔
	Dir        string       `json:"dir"`
	HasPom     bool         `json:"hasPom"` // 模块目录里有没有自己的 pom.xml
	ArtifactId string       `json:"artifactId"`
	Modules    []ModuleInfo `json:"modules"`
}

// ProjectInfo 是一次 Maven 项目结构读取的结果（纯文件读取，不起进程）。
type ProjectInfo struct {
	Root           string       `json:"root"`
	PomPath        string       `json:"pomPath"`
	ArtifactId     string       `json:"artifactId"`
	Name           string       `json:"name"`
	Packaging      string       `json:"packaging"`
	Modules        []ModuleInfo `json:"modules"`
	SettingsPath   string       `json:"settingsPath"`
	SettingsExists bool         `json:"settingsExists"`
	Skipped        int          `json:"skipped"` // 因循环/越界/畸形 pom 被跳过的模块数（前端可提示）
}

// pomXML 只取需要的直接子元素；encoding/xml 按局部名匹配，默认命名空间的 pom 可直接解析。
type pomXML struct {
	Name       string `xml:"name"`
	ArtifactId string `xml:"artifactId"`
	Packaging  string `xml:"packaging"`
	Modules    struct {
		Module []string `xml:"module"`
	} `xml:"modules"`
}

// ReadProject 读取 root 下的 pom.xml 与模块树。缺 artifactId 时回退目录名；
// 模块带 ${...} 占位（属性继承）或越界路径的跳过，pom 缺失的模块只记目录不展开。
func ReadProject(root string) (*ProjectInfo, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("工作区路径为空")
	}
	if st, err := os.Stat(root); err != nil {
		return nil, fmt.Errorf("工作区目录不存在：%s", root)
	} else if !st.IsDir() {
		return nil, fmt.Errorf("不是目录：%s", root)
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("解析工作区路径失败：%w", err)
	}
	pomPath := filepath.Join(root, "pom.xml")
	data, err := readPomLimited(pomPath)
	if err != nil {
		return nil, fmt.Errorf("读取 pom.xml 失败：%w", err)
	}
	var pom pomXML
	if err := xml.Unmarshal(data, &pom); err != nil {
		return nil, pomParseError(data, err)
	}
	artifactId := strings.TrimSpace(pom.ArtifactId)
	if artifactId == "" {
		artifactId = filepath.Base(root)
	}
	name := strings.TrimSpace(pom.Name)
	if name == "" {
		name = artifactId
	}
	info := &ProjectInfo{
		Root:       root,
		PomPath:    pomPath,
		ArtifactId: artifactId,
		Name:       name,
		Packaging:  strings.TrimSpace(pom.Packaging),
		Modules:    []ModuleInfo{},
	}
	// visited 用 realpath（EvalSymlinks）去重：自引用模块 / 符号链接环不会无限递归，
	// 也防止 <module> 经符号链接读出工作区外的 pom。根 pom 目录先占位。
	visited := map[string]bool{}
	if real, err := filepath.EvalSymlinks(rootAbs); err == nil {
		visited[real] = true
	}
	info.Modules, info.Skipped = readModules(rootAbs, pom.Modules.Module, "", 1, visited)
	if home, herr := os.UserHomeDir(); herr == nil && home != "" {
		info.SettingsPath = filepath.Join(home, ".m2", "settings.xml")
		if _, serr := os.Stat(info.SettingsPath); serr == nil {
			info.SettingsExists = true
		}
	}
	return info, nil
}

// readModules 递归展开 <modules>（限深）：模块名是相对父 pom 的路径片段。
// visited 是 realpath 去重集（循环/符号链接环防护）；skipped 累计被跳过的模块数。
func readModules(parentDir string, names []string, parentRel string, depth int, visited map[string]bool) ([]ModuleInfo, int) {
	list := []ModuleInfo{}
	skipped := 0
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" || strings.Contains(name, "${") {
			skipped++
			continue
		}
		name = filepath.ToSlash(filepath.Clean(name))
		// 元字符白名单与 validateModuleRelPath 同源：模块名进 cmd /c 命令行（-pl），
		// 不可信 pom 里的 <module>foo&calc</module> 在这里就拦下，不进前端。
		// `.` 自引用（Clean 后为 "."）会形成自嵌套怪树，一并跳过。
		if name == "." || !safeModuleRelPath(name) || strings.Contains(name, "..") ||
			strings.HasPrefix(name, "/") || strings.ContainsRune(name, ':') ||
			strings.HasPrefix(name, "\\") {
			skipped++
			continue
		}
		dir := filepath.Join(parentDir, filepath.FromSlash(name))
		// realpath 校验：符号链接指向工作区外 / 已访问目录都跳过（L1）
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			skipped++
			continue
		}
		if visited[real] {
			skipped++
			continue
		}
		visited[real] = true
		rel := name
		if parentRel != "" {
			rel = parentRel + "/" + name
		}
		item := ModuleInfo{Name: name, RelPath: rel, Dir: dir, Modules: []ModuleInfo{}}
		pomData, perr := readPomLimited(filepath.Join(dir, "pom.xml"))
		if perr != nil {
			// 模块没有 pom（HasPom=false，仍记目录）与读取失败（超限等）都计入 skipped；
			// 区别是前者是合法的多模块目录占位，后者是可诊断的异常。
			if !os.IsNotExist(perr) {
				skipped++
			}
			list = append(list, item)
			continue
		}
		var pom pomXML
		if xml.Unmarshal(pomData, &pom) != nil {
			// 畸形模块 pom：L2——不再与「没有 pom」混为一谈，计入 skipped
			skipped++
			list = append(list, item)
			continue
		}
		item.HasPom = true
		item.ArtifactId = strings.TrimSpace(pom.ArtifactId)
		if depth < maxModuleDepth {
			var childSkipped int
			item.Modules, childSkipped = readModules(dir, pom.Modules.Module, rel, depth+1, visited)
			skipped += childSkipped
		}
		list = append(list, item)
	}
	return list, skipped
}

// RunData 是数据命令统一入口：按 kind 起对应 mvn 命令。未知 kind 报错，不给任意 goal
// 开口子——任意 goal 的执行走运行通道（runCommand），有完整门禁。
func RunData(workspaceRoot, mvnPath string, timeoutMs int, kind, moduleRelPath string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "effective-pom":
		return EffectivePom(workspaceRoot, mvnPath, timeoutMs, moduleRelPath)
	case "effective-settings":
		return EffectiveSettings(workspaceRoot, mvnPath, timeoutMs)
	case "dependency-tree":
		return DependencyTree(workspaceRoot, mvnPath, timeoutMs, moduleRelPath)
	default:
		return "", fmt.Errorf("未知的 Maven 数据目标：%s", kind)
	}
}

// EffectivePom 起 mvn help:effective-pom，输出走临时文件（见 runMavenToFile）。
func EffectivePom(workspaceRoot, mvnPath string, timeoutMs int, moduleRelPath string) (string, error) {
	return runMavenToFile(workspaceRoot, mvnPath, timeoutMs, moduleRelPath, []string{"help:effective-pom"}, "-Doutput")
}

// EffectiveSettings 起 mvn help:effective-settings，取生效的仓库 / 镜像 / 本地仓库路径。
func EffectiveSettings(workspaceRoot, mvnPath string, timeoutMs int) (string, error) {
	return runMavenToFile(workspaceRoot, mvnPath, timeoutMs, "", []string{"help:effective-settings"}, "-Doutput")
}

// DependencyTree 起 mvn dependency:tree，输出纯树文本到临时文件。
func DependencyTree(workspaceRoot, mvnPath string, timeoutMs int, moduleRelPath string) (string, error) {
	return runMavenToFile(workspaceRoot, mvnPath, timeoutMs, moduleRelPath, []string{"dependency:tree"}, "-DoutputFile")
}

// runMavenToFile 统一的「输出走临时文件」通道：-Doutput/-DoutputFile 让 Maven 把纯结果
// 写进文件，绕开 stdout 里的 [INFO] 日志噪声；临时文件读完即删。
func runMavenToFile(workspaceRoot, mvnPath string, timeoutMs int, moduleRelPath string, goalArgs []string, outParam string) (string, error) {
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeoutMs
	}
	if timeoutMs > maxTimeoutMs {
		timeoutMs = maxTimeoutMs
	}
	args := []string{"-B"}
	if moduleRelPath != "" {
		if err := validateModuleRelPath(moduleRelPath); err != nil {
			return "", err
		}
		args = append(args, "-pl", moduleRelPath)
	}
	args = append(args, goalArgs...)
	tmp, err := os.CreateTemp("", "cadt-mvn-*.txt")
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败：%w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)
	args = append(args, outParam+"="+tmpPath)
	if _, err := runMaven(workspaceRoot, mvnPath, timeoutMs, args); err != nil {
		return "", err
	}
	// 上限先用 Stat 预判：超大文件直接报错，不整读进内存
	if st, serr := os.Stat(tmpPath); serr == nil && st.Size() > maxOutputBytes {
		return "", fmt.Errorf("Maven 输出超过 %d MB 上限", maxOutputBytes>>20)
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return "", fmt.Errorf("读取 Maven 输出失败：%w", err)
	}
	if int64(len(data)) > maxOutputBytes {
		return "", fmt.Errorf("Maven 输出超过 %d MB 上限", maxOutputBytes>>20)
	}
	if strings.TrimSpace(string(data)) == "" {
		return "", fmt.Errorf("Maven 没有产生输出（目标：%s）", strings.Join(goalArgs, " "))
	}
	return string(data), nil
}

// dataSem 限制并发 mvn 数据命令数（M2）：前端同时展开多个子模块的「依赖项」会并发调用，
// 无门控时可能一次起 N 个 mvn 进程（各自下载插件、吃满 CPU）。限 2 个，其余排队。
var dataSem = make(chan struct{}, 2)

// runMaven 起 mvn 数据命令并等待结束；stdout/stderr 不进结果（结果走临时文件），
// 失败时取两个流的尾部做报错上下文。
func runMaven(workspaceRoot, mvnPath string, timeoutMs int, args []string) (string, error) {
	dataSem <- struct{}{}
	defer func() { <-dataSem }()
	mvnPath = strings.TrimSpace(mvnPath)
	if mvnPath == "" {
		mvnPath = "mvn"
	}
	// L5：mvnPath 作为 argv 传给 cmd /c，拦 cmd 元字符（& | < > ^ % ! "），
	// 并拒绝路径穿越片段——正常流程来自工具链扫描，这里是绑定面的兜底校验。
	if strings.ContainsAny(mvnPath, "&|<>^\"%!\r\n") || strings.Contains(mvnPath, "..") {
		return "", fmt.Errorf("非法的 Maven 路径：%s", mvnPath)
	}
	dir := strings.TrimSpace(workspaceRoot)
	if dir != "" {
		if st, serr := os.Stat(dir); serr != nil || !st.IsDir() {
			return "", fmt.Errorf("工作目录不存在：%s", dir)
		}
	}
	exe, fullArgs := wrapMavenCmd(mvnPath, args)
	if err := procctl.NormalizeArgs(exe, fullArgs); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, fullArgs...)
	procctl.ApplyCancel(cmd)
	cmd.Dir = dir
	executil.HideCommandWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		tail := strings.TrimSpace(stderr.String())
		if tail == "" {
			tail = strings.TrimSpace(stdout.String())
		}
		if len(tail) > 2000 {
			tail = tail[len(tail)-2000:]
		}
		if tail == "" {
			return "", fmt.Errorf("mvn 执行失败：%w", err)
		}
		return "", fmt.Errorf("mvn 执行失败：%w\n%s", err, tail)
	}
	return stdout.String(), nil
}

// validateModuleRelPath 拦掉 -pl 参数里的路径穿越与绝对路径：它会被拼进命令行。
// Windows 上命令外层是 cmd /c 包装（见 cmdwrap_windows.go），cmd 元字符会被再解释——
// 模块路径本就只需要字母数字与 . _ / -，白名单之外的字符（& | < > ^ % ! 引号等）一律拒绝。
func validateModuleRelPath(rel string) error {
	if rel == "" {
		return nil
	}
	if !safeModuleRelPath(rel) || strings.Contains(rel, "..") || strings.HasPrefix(rel, "/") ||
		strings.HasPrefix(rel, "\\") || strings.ContainsRune(rel, ':') || filepath.IsAbs(rel) {
		return fmt.Errorf("非法模块路径：%s", rel)
	}
	return nil
}

// safeModuleRelPath 模块相对路径字符白名单（<module> 原文来自不可信 pom）。
func safeModuleRelPath(rel string) bool {
	for _, r := range rel {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '_' || r == '-' || r == '/'
		if !ok {
			return false
		}
	}
	return rel != ""
}
