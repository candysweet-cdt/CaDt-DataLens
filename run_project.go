package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// 项目感知运行（V3）：只探测项目文件并给出「候选命令」，由前端弹窗让用户确认后
// 才交给 RunExec 执行。这里不执行任何命令、不安装依赖、不读取项目以外的用户数据。

type RunProjectCmd struct {
	Label string   `json:"label"`
	Exe   string   `json:"exe"`
	Args  []string `json:"args"`
	Cwd   string   `json:"cwd"`
}

type RunProjectInfo struct {
	Root     string          `json:"root"`
	Kind     string          `json:"kind"`
	Marker   string          `json:"marker"`
	Commands []RunProjectCmd `json:"commands"`
	Note     string          `json:"note"`
}

const runProjectMaxDepth = 8

// 顺序即优先级：一个目录里同时有多种标记时只认第一个。
var runProjectMarkers = []string{"package.json", "go.mod", "Cargo.toml", "pyproject.toml", "Makefile", "makefile"}

// DetectRunProject 从文件或目录向上探测项目标记，返回项目根与候选命令。
func (a *App) DetectRunProject(path string) (*RunProjectInfo, error) {
	start := strings.TrimSpace(path)
	if start == "" {
		return nil, fmt.Errorf("路径为空")
	}
	st, err := os.Stat(start)
	if err != nil {
		return nil, fmt.Errorf("路径不存在：%s", start)
	}
	dir := start
	if !st.IsDir() {
		dir = filepath.Dir(start)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		home = filepath.Clean(home)
	}
	for i := 0; i < runProjectMaxDepth; i++ {
		// 用户主目录常有无关的 package.json / 配置，不能拿它当项目根
		if home != "" && strings.EqualFold(filepath.Clean(dir), home) {
			break
		}
		for _, marker := range runProjectMarkers {
			fst, ferr := os.Stat(filepath.Join(dir, marker))
			if ferr == nil && !fst.IsDir() {
				return runProjectFromMarker(dir, marker)
			}
		}
		// 仓库根是自然边界：再往上找另一个项目没有意义
		if _, gerr := os.Stat(filepath.Join(dir, ".git")); gerr == nil {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return nil, fmt.Errorf("在 %s 及其上级 %d 层内没有检测到项目文件（package.json / go.mod / Cargo.toml / pyproject.toml / Makefile）",
		start, runProjectMaxDepth)
}

func runProjectFromMarker(dir, marker string) (*RunProjectInfo, error) {
	info := &RunProjectInfo{Root: dir, Marker: marker, Commands: []RunProjectCmd{}}
	add := func(label, exe string, args ...string) {
		info.Commands = append(info.Commands, RunProjectCmd{
			Label: label,
			Exe:   resolveRunProjectExe(exe),
			Args:  args,
			Cwd:   dir,
		})
	}
	switch strings.ToLower(marker) {
	case "package.json":
		info.Kind = "Node.js"
		scripts := readPackageScripts(filepath.Join(dir, marker))
		if _, ok := scripts["start"]; ok {
			add("npm start", "npm", "start")
		}
		if _, ok := scripts["dev"]; ok {
			add("npm run dev", "npm", "run", "dev")
		}
		if len(info.Commands) == 0 {
			info.Note = "package.json 里没有 start / dev 脚本；请用 F5 直接运行入口文件，或先在设置 → 运行里配命令模板。"
		}
	case "go.mod":
		info.Kind = "Go"
		add("go run .", "go", "run", ".")
	case "cargo.toml":
		info.Kind = "Rust"
		add("cargo run", "cargo", "run")
	case "pyproject.toml":
		info.Kind = "Python"
		for _, entry := range []string{"main.py", "app.py", "manage.py"} {
			if fst, err := os.Stat(filepath.Join(dir, entry)); err == nil && !fst.IsDir() {
				add("python "+entry, "python", entry)
			}
		}
		if len(info.Commands) == 0 {
			info.Note = "没有找到 main.py / app.py / manage.py；请用 F5 直接运行入口文件。"
		}
	default: // Makefile / makefile
		info.Kind = "Make"
		add("make", "make")
		info.Note = "Windows 上通常需要自行安装 make（例如 Git Bash 或 MinGW 提供）。"
	}
	tail := "项目运行只执行下面选中的命令，不会自动安装依赖或修改项目文件；命令以你的 Windows 账户权限执行。"
	if info.Note != "" {
		tail = info.Note + " " + tail
	}
	info.Note = tail
	return info, nil
}

func readPackageScripts(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var v struct {
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	return v.Scripts
}

// resolveRunProjectExe 尽量解析成绝对路径：Windows 的 npm 实际是 npm.cmd，
// 用 LookPath 的结果可以避免 exec.Command 找不到解释器。
func resolveRunProjectExe(name string) string {
	if p, err := exec.LookPath(name); err == nil && p != "" {
		return p
	}
	return name
}
