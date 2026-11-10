//go:build windows

package main

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTerminalSessionEchoAndClose(t *testing.T) {
	var mu sync.Mutex
	var out strings.Builder
	emit := func(event string, data interface{}) {
		mu.Lock()
		defer mu.Unlock()
		if event == "term-out" {
			if m, ok := data.(map[string]string); ok {
				out.WriteString(m["data"])
			}
		}
	}
	session, err := startTermSession("t-test", "cmd", 80, 24, "", emit)
	if err != nil {
		t.Fatalf("创建会话失败: %v", err)
	}
	defer session.closeAll()

	// 等待 cmd 横幅/提示符
	deadline := time.Now().Add(8 * time.Second)
	got := ""
	for time.Now().Before(deadline) {
		mu.Lock()
		got = out.String()
		mu.Unlock()
		if strings.Contains(got, "Microsoft Windows") || strings.Contains(got, ">") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !strings.Contains(got, "Microsoft Windows") && !strings.Contains(got, ">") {
		t.Fatalf("8 秒内未收到 cmd 启动输出: %q", got)
	}

	// resize 不应报错
	if err := session.resize(100, 30); err != nil {
		t.Fatalf("resize 失败: %v", err)
	}

	// 写入 echo 命令并等待回显
	mu.Lock()
	out.Reset()
	mu.Unlock()
	if err := session.write("echo CADT_TEST_OK_9137\r\n"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	deadline = time.Now().Add(8 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		mu.Lock()
		s := out.String()
		mu.Unlock()
		if strings.Contains(s, "CADT_TEST_OK_9137") {
			found = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !found {
		mu.Lock()
		tail := out.String()
		mu.Unlock()
		t.Fatalf("未回显 echo 结果，最近输出: %q", tail)
	}
}

func TestTermShellCommandRejectsUnknown(t *testing.T) {
	if _, err := termShellArgs("bash"); err == nil {
		t.Fatal("未知 shell 应被拒绝")
	}
}

func TestTermShellAutoDefault(t *testing.T) {
	args, err := termShellArgs("")
	if err != nil {
		t.Fatalf("默认 shell 应可用: %v", err)
	}
	if pwsh := findPwsh(); pwsh != "" {
		if strings.ToLower(args[0]) != strings.ToLower(pwsh) {
			t.Fatalf("默认应使用 pwsh，实际: %v", args)
		}
		return
	}
	if strings.ToLower(args[0]) != "powershell.exe" {
		t.Fatalf("无 pwsh 时默认应回退 powershell，实际: %v", args)
	}
}

func TestTermShellsList(t *testing.T) {
	app := &App{}
	shells := app.TermShells()
	ids := map[string]bool{}
	for _, s := range shells {
		ids[s["id"]] = true
	}
	if !ids["powershell"] || !ids["cmd"] {
		t.Fatalf("shell 列表应始终包含 powershell 与 cmd: %v", shells)
	}
	if pwsh := findPwsh(); pwsh != "" {
		if !ids["pwsh"] {
			t.Fatalf("本机有 PowerShell 7（%s）但列表未包含 pwsh", pwsh)
		}
		args, err := termShellArgs("pwsh")
		if err != nil {
			t.Fatalf("pwsh 参数生成失败: %v", err)
		}
		if strings.ToLower(args[0]) != strings.ToLower(pwsh) {
			t.Fatalf("pwsh 参数异常: %v", args)
		}
	} else if ids["pwsh"] {
		t.Fatalf("本机没有 pwsh，但列表包含 pwsh: %v", shells)
	}
	if bash := findGitBash(); bash != "" {
		if !ids["gitbash"] {
			t.Fatalf("本机有 Git Bash（%s）但列表未包含 gitbash", bash)
		}
		args, err := termShellArgs("gitbash")
		if err != nil {
			t.Fatalf("gitbash 参数生成失败: %v", err)
		}
		if !strings.Contains(strings.ToLower(args[0]), "bash.exe") || len(args) < 3 {
			t.Fatalf("gitbash 参数异常: %v", args)
		}
	}
}
