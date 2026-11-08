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
