package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeProjectFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatalf("写 %s 失败：%v", name, err)
	}
}

func TestDetectRunProjectNodeScripts(t *testing.T) {
	dir := t.TempDir()
	writeProjectFile(t, dir, "package.json", `{"name":"demo","scripts":{"start":"node server.js","dev":"vite"}}`)
	sub := filepath.Join(dir, "src")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(sub, "index.js")
	writeProjectFile(t, sub, "index.js", "// x")
	app := &App{}
	info, err := app.DetectRunProject(entry)
	if err != nil {
		t.Fatalf("探测失败：%v", err)
	}
	if info.Root != dir || info.Kind != "Node.js" || info.Marker != "package.json" {
		t.Fatalf("项目信息错误：%+v", info)
	}
	if len(info.Commands) != 2 {
		t.Fatalf("应给出 start / dev 两条命令：%+v", info.Commands)
	}
	if info.Commands[0].Label != "npm start" || strings.Join(info.Commands[0].Args, " ") != "start" {
		t.Errorf("start 命令错误：%+v", info.Commands[0])
	}
	if info.Commands[1].Label != "npm run dev" || strings.Join(info.Commands[1].Args, " ") != "run dev" {
		t.Errorf("dev 命令错误：%+v", info.Commands[1])
	}
	for _, c := range info.Commands {
		if c.Cwd != dir {
			t.Errorf("命令工作目录应为项目根：%+v", c)
		}
	}
	if !strings.Contains(info.Note, "不会自动安装依赖") {
		t.Errorf("缺少风险说明：%s", info.Note)
	}
}

func TestDetectRunProjectMarkers(t *testing.T) {
	cases := []struct {
		file string
		kind string
		want string
	}{
		{"go.mod", "Go", "go run ."},
		{"Cargo.toml", "Rust", "cargo run"},
		{"Makefile", "Make", "make"},
	}
	app := &App{}
	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			dir := t.TempDir()
			writeProjectFile(t, dir, tc.file, "# generated\n")
			info, err := app.DetectRunProject(dir)
			if err != nil {
				t.Fatalf("探测失败：%v", err)
			}
			if info.Kind != tc.kind || len(info.Commands) != 1 || info.Commands[0].Label != tc.want {
				t.Fatalf("命令不符合预期：%+v", info)
			}
			if info.Commands[0].Exe == "" || info.Commands[0].Cwd != dir {
				t.Errorf("exe / cwd 缺失：%+v", info.Commands[0])
			}
		})
	}
}

func TestDetectRunProjectPythonEntry(t *testing.T) {
	dir := t.TempDir()
	writeProjectFile(t, dir, "pyproject.toml", "[project]\nname = 'demo'\n")
	writeProjectFile(t, dir, "main.py", "print(1)\n")
	app := &App{}
	info, err := app.DetectRunProject(filepath.Join(dir, "main.py"))
	if err != nil {
		t.Fatalf("探测失败：%v", err)
	}
	if info.Kind != "Python" || len(info.Commands) != 1 || info.Commands[0].Label != "python main.py" {
		t.Fatalf("Python 入口识别错误：%+v", info)
	}
}

func TestDetectRunProjectWalksUpAndErrors(t *testing.T) {
	root := t.TempDir()
	writeProjectFile(t, root, "go.mod", "module example.com/demo\n")
	nested := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	info, err := app.DetectRunProject(nested)
	if err != nil || info.Root != root {
		t.Fatalf("应向上找到项目根：info=%+v err=%v", info, err)
	}
	if _, err := app.DetectRunProject(""); err == nil {
		t.Error("空路径应报错")
	}
	if _, err := app.DetectRunProject(filepath.Join(root, "missing.go")); err == nil {
		t.Error("不存在的路径应报错")
	}
	empty := t.TempDir()
	if got, err := app.DetectRunProject(empty); err == nil {
		t.Errorf("没有项目标记时应返回明确错误，实际命中 %s（%s）", got.Marker, got.Root)
	}
}
