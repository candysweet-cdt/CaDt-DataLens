package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentSkillRegisterUnregister(t *testing.T) {
	home := t.TempDir()
	roots := agentSkillTargetDirs(home)
	if len(roots) != 2 {
		t.Fatalf("期望 2 个目标目录，得到 %d", len(roots))
	}
	exe := filepath.Join(home, "tools", "datalens.exe")
	for _, root := range roots {
		if err := writeAgentSkillAt(root, exe); err != nil {
			t.Fatalf("写入技能失败: %v", err)
		}
		skillFile := filepath.Join(root, skillDirName, "SKILL.md")
		data, err := os.ReadFile(skillFile)
		if err != nil {
			t.Fatalf("SKILL.md 未写入: %v", err)
		}
		content := string(data)
		if !strings.Contains(content, skillMarker) {
			t.Fatalf("SKILL.md 缺少标记 %q", skillMarker)
		}
		if strings.Contains(content, skillExeToken) {
			t.Fatalf("SKILL.md 的 {{EXE_PATH}} 未被替换")
		}
		if !strings.Contains(content, exe) {
			t.Fatalf("SKILL.md 未包含 exe 路径 %q", exe)
		}
		cliFile := filepath.Join(root, skillDirName, "reference", "cli.md")
		if _, err := os.Stat(cliFile); err != nil {
			t.Fatalf("reference/cli.md 未写入: %v", err)
		}
		registered, err := skillInstalledAt(root)
		if err != nil || !registered {
			t.Fatalf("注册状态检查失败: registered=%v err=%v", registered, err)
		}
	}
	if err := removeAgentSkillAt(roots[0]); err != nil {
		t.Fatalf("移除技能失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(roots[0], skillDirName)); !os.IsNotExist(err) {
		t.Fatalf("技能目录未删除: %v", err)
	}
	registered, err := skillInstalledAt(roots[0])
	if err != nil || registered {
		t.Fatalf("删除后状态应未注册: registered=%v err=%v", registered, err)
	}
}

func TestAgentSkillRemoveForeignDir(t *testing.T) {
	home := t.TempDir()
	roots := agentSkillTargetDirs(home)
	foreign := filepath.Join(roots[0], skillDirName)
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "SKILL.md"), []byte("---\nname: someone-else\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removeAgentSkillAt(roots[0]); err == nil {
		t.Fatal("应拒绝删除非本应用写入的技能目录")
	}
	if _, err := os.Stat(filepath.Join(foreign, "SKILL.md")); err != nil {
		t.Fatal("外来目录不应被删除")
	}
}
