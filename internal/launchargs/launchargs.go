// launchargs：启动参数解析 —— 打开目标（文件:行:列）、设置页、AI 会话与开关判定。
package launchargs

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// OpenTarget 启动时要打开的文件或目录；行列从 1 开始，0 表示未指定。
type OpenTarget struct {
	Path   string `json:"path"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

// TopLevelUsage 顶层帮助文本的 GUI 启动部分（main.go 拼接 convertcli.Usage /
// patchcli.Usage 后随 --help 打印）。新增开关时同步这里——cli_help_guard_test.go
// 会对源码开关字面量与本文本做双向对账。
const TopLevelUsage = `CaDt-DataLens —— 轻量级多格式数据查看与编辑器
用法：
  CaDt-DataLens.exe [文件[:行[:列]]...] [开关]
  CaDt-DataLens.exe <headless 子命令>（见文末）

打开定位：
  文件[:行[:列]]           打开文件并定位（行列从 1 开始，列可省略；目录按工作区打开）
  --line N / -l N          行号（作用于紧随其后的那个路径；其后无路径时作用于最后一个路径）
  --column N / -c N        列号（同上）
  --goto / -g              VS Code 风格标记，仅作兼容可省略
  --new-window             强制新窗口（默认复用已有窗口加标签页）
  --open-settings=<pane>   打开设置页指定 pane（如 --open-settings=ai）
  --ai-session=<id>        打开指定 AI 会话；运行中转发到会话所属工作区的窗口
  --memo=<locator>         打开便签定位点（cadt-memo://<workspace|global>/<block|item>/<id>）

窗口形态：
  --ai-float               只开 AI 浮窗
  --debug-console          只开调试控制台
  --harness                主窗口按 harness 形态启动（不恢复上次工作区，工作区由会话各自绑定）
  --quit                   优雅退出已运行的实例（无实例时静默退出，不闪窗）

其他：
  --version / -v           打印版本号
  --help / -h              打印本帮助

裸启动（无参数）以当前目录为工作区打开；双击 exe 启动走欢迎页。
程序已在运行时，GUI 参数经单实例转发到现有窗口。
headless 子命令：--convert（格式互转）、--check-patch / --apply-patch / --revert-patch（补丁）、
--integrate / --unintegrate（安装包系统集成，由安装包调用）。`

// ParseOpenSettingsArg 解析 --open-settings=<pane>，没有则返回空串。
func ParseOpenSettingsArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--open-settings=") {
			return strings.TrimPrefix(arg, "--open-settings=")
		}
	}
	return ""
}

// ParseMemoLocatorArg 解析 --memo=<locator>（cadt-memo://scope/kind/id），没有则返回空串。
func ParseMemoLocatorArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--memo=") {
			return strings.TrimSpace(strings.TrimPrefix(arg, "--memo="))
		}
	}
	return ""
}

// ParseAISessionArg 解析 --ai-session=<id>，没有则返回空串。
func ParseAISessionArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--ai-session=") {
			return strings.TrimSpace(strings.TrimPrefix(arg, "--ai-session="))
		}
	}
	return ""
}

func positiveInt(value string) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// splitPathLine 解析 path[:line[:column]] 形态。判定优先级：
//  1. 前缀真实存在 → path:line（现存文件/目录 + 行号，行为与历史一致）；
//  2. 前缀里还有一段正整数 → path:line:column（不要求存在）；
//  3. 都不满足但行号段是正整数 → 仍按 path:line 拆（path 不存在）——不存在
//     的目标照样进 targets 由前端报「文件不存在」，错误里是干净文件名而不是
//     带着 ":42" 后缀的原始串。仅当字面路径真实存在时走不到这里（调用方先
//     stat 整串），Windows 文件名不允许冒号，不会误拆。
func splitPathLine(arg string) (string, int, int, bool) {
	lastColon := strings.LastIndex(arg, ":")
	if lastColon <= 0 {
		return "", 0, 0, false
	}
	line, err := strconv.Atoi(arg[lastColon+1:])
	if err != nil || line <= 0 {
		return "", 0, 0, false
	}
	prefix := arg[:lastColon]
	if _, err := os.Stat(prefix); err == nil {
		return prefix, line, 0, true
	}
	prevColon := strings.LastIndex(prefix, ":")
	if prevColon > 0 {
		if middle, err := strconv.Atoi(prefix[prevColon+1:]); err == nil && middle > 0 {
			return prefix[:prevColon], middle, line, true
		}
	}
	return prefix, line, 0, true
}

// ParseOpenTargets 把命令行参数解析成打开目标列表（支持 path:line[:column] 与
// --line/--column/--goto 三种写法）。不存在的路径不再静默丢弃：照常进 targets，
// 由前端 openPaths 的「打开失败」flash 反馈——agent 调用打错路径时必须有失败信号。
func ParseOpenTargets(args []string) []OpenTarget {
	exe, _ := os.Executable()
	targets := []OpenTarget{}
	pendingLine, pendingColumn := 0, 0
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "" || strings.EqualFold(arg, exe) || arg == "--new-window" {
			continue
		}
		if arg == "--goto" || arg == "-g" {
			continue
		}
		if strings.HasPrefix(arg, "--line=") {
			pendingLine = positiveInt(strings.TrimPrefix(arg, "--line="))
			continue
		}
		if arg == "--line" || arg == "-l" {
			if i+1 < len(args) {
				i++
				pendingLine = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "--column=") {
			pendingColumn = positiveInt(strings.TrimPrefix(arg, "--column="))
			continue
		}
		if arg == "--column" || arg == "-c" {
			if i+1 < len(args) {
				i++
				pendingColumn = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		path := arg
		line, column := pendingLine, pendingColumn
		if _, err := os.Stat(path); err != nil {
			if p, l, c, ok := splitPathLine(arg); ok {
				path = p
				line = l
				if c > 0 {
					column = c
				}
			}
		}
		targets = append(targets, OpenTarget{Path: path, Line: line, Column: column})
		pendingLine, pendingColumn = 0, 0
	}
	if len(targets) > 0 {
		last := &targets[len(targets)-1]
		if pendingLine > 0 && last.Line == 0 {
			last.Line = pendingLine
		}
		if pendingColumn > 0 && last.Column == 0 {
			last.Column = pendingColumn
		}
	}
	return targets
}

// StartupCwdTarget 裸启动（无参数）时把当前目录作为工作区打开；
// 双击 exe 启动时 CWD 等于 exe 目录，此时返回空（走欢迎页）。
func StartupCwdTarget() []OpenTarget {
	wd, err := os.Getwd()
	if err != nil || strings.TrimSpace(wd) == "" {
		return nil
	}
	if exe, exeErr := os.Executable(); exeErr == nil && exe != "" {
		if strings.EqualFold(filepath.Dir(exe), wd) {
			return nil
		}
	}
	info, err := os.Stat(wd)
	if err != nil || !info.IsDir() {
		return nil
	}
	return []OpenTarget{{Path: wd}}
}

// HasFlag 判断参数里是否带有某个开关（独立窗口/调试控制台等）。
func HasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

// ParseHarness 判定 --harness（无值布尔开关，与 --ai-float / --debug-console 同款）。
// harness 形态：主窗口不恢复上次工作区，工作区由各会话自己绑定（见
// docs/unfinished-plans/agent-host-platform.md §S3）。前端消费它的入口在批次 F。
func ParseHarness(args []string) bool {
	return HasFlag(args, "--harness")
}
