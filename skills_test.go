package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestBuiltinSkillAssetsPresent(t *testing.T) {
	for _, dir := range appBuiltinSkillDirs {
		source := "docs/skills/" + dir
		paths, err := skillEntryPaths(source)
		if err != nil {
			t.Fatalf("%s 嵌入失败：%v", dir, err)
		}
		if len(paths) < 2 {
			t.Fatalf("%s 文件过少：%v", dir, paths)
		}
		data, err := skillAssets.ReadFile(source + "/SKILL.md")
		if err != nil {
			t.Fatalf("%s/SKILL.md 未嵌入：%v", dir, err)
		}
		if !strings.Contains(string(data), "name: "+dir) {
			t.Fatalf("%s/SKILL.md frontmatter 名称不匹配", dir)
		}
	}
}

func TestMaterializeBuiltinSkills(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("AppData", configDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)
	builtinSkillsOnce = sync.Once{}
	builtinSkillsDir = ""
	t.Cleanup(func() {
		builtinSkillsOnce = sync.Once{}
		builtinSkillsDir = ""
	})
	dir := materializeBuiltinSkills()
	if dir == "" {
		t.Fatal("内置技能物化失败")
	}
	for _, name := range appBuiltinSkillDirs {
		if _, err := os.Stat(filepath.Join(dir, name, "SKILL.md")); err != nil {
			t.Fatalf("%s/SKILL.md 未落盘：%v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, builtinSkillsStamp)); err != nil {
		t.Fatalf("版本标记未写入：%v", err)
	}
	// 版本标记命中时不重复覆盖：改动一个文件后再次物化应保持改动。
	probe := filepath.Join(dir, appBuiltinSkillDirs[0], "SKILL.md")
	if err := os.WriteFile(probe, []byte("probe"), 0o644); err != nil {
		t.Fatal(err)
	}
	builtinSkillsOnce = sync.Once{}
	if got := materializeBuiltinSkills(); got != dir {
		t.Fatalf("重复物化目录变化：%q != %q", got, dir)
	}
	if data, err := os.ReadFile(probe); err != nil || string(data) != "probe" {
		t.Fatalf("版本未变时不应覆盖已有文件：%q %v", data, err)
	}
}
