package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed docs/skills/cadt-datalens
var skillAssets embed.FS

const (
	skillDirName  = "cadt-datalens"
	skillSource   = "docs/skills/" + skillDirName
	skillMarker   = "name: cadt-datalens"
	skillExeToken = "{{EXE_PATH}}"
)

type AgentSkillTarget struct {
	Dir        string `json:"dir"`
	Registered bool   `json:"registered"`
}

type AgentSkillStatus struct {
	Home    string             `json:"home"`
	Targets []AgentSkillTarget `json:"targets"`
}

func agentSkillTargetDirs(home string) []string {
	return []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(home, ".claude", "skills"),
	}
}

// skillEntryPaths 列出嵌入的技能目录里需要落盘的文件（相对 target 根的路径）。
func skillEntryPaths() ([]string, error) {
	paths := []string{}
	err := fs.WalkDir(skillAssets, skillSource, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, e := filepath.Rel(skillSource, path)
			if e != nil {
				return e
			}
			paths = append(paths, filepath.FromSlash(rel))
		}
		return nil
	})
	return paths, err
}

func skillWritePath(root string) string {
	return filepath.Join(root, skillDirName)
}

func skillInstalledAt(root string) (bool, error) {
	data, err := os.ReadFile(filepath.Join(skillWritePath(root), "SKILL.md"))
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return strings.Contains(string(data), skillMarker), nil
}

func writeAgentSkillAt(root, exe string) error {
	paths, err := skillEntryPaths()
	if err != nil {
		return err
	}
	base := skillWritePath(root)
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	for _, rel := range paths {
		content, err := skillAssets.ReadFile(filepath.ToSlash(filepath.Join(skillSource, rel)))
		if err != nil {
			return err
		}
		if strings.EqualFold(rel, "SKILL.md") {
			content = []byte(strings.ReplaceAll(string(content), skillExeToken, exe))
		}
		dest := filepath.Join(base, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func removeAgentSkillAt(root string) error {
	base := skillWritePath(root)
	if _, err := os.Stat(base); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	installed, err := skillInstalledAt(root)
	if err != nil {
		return err
	}
	if !installed {
		return fmt.Errorf("%s 不是本应用写入的技能目录，请手动处理", base)
	}
	return os.RemoveAll(base)
}

func RegisterAgentSkill() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	for _, root := range agentSkillTargetDirs(home) {
		if err := writeAgentSkillAt(root, exe); err != nil {
			return fmt.Errorf("写入 %s 失败：%w", root, err)
		}
	}
	return nil
}

func UnregisterAgentSkill() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	for _, root := range agentSkillTargetDirs(home) {
		if err := removeAgentSkillAt(root); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) SetAgentSkill(enabled bool) error {
	if enabled {
		return RegisterAgentSkill()
	}
	return UnregisterAgentSkill()
}

func (a *App) GetAgentSkillStatus() (*AgentSkillStatus, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	status := &AgentSkillStatus{Home: home}
	for _, root := range agentSkillTargetDirs(home) {
		registered, err := skillInstalledAt(root)
		if err != nil {
			return nil, err
		}
		status.Targets = append(status.Targets, AgentSkillTarget{Dir: root, Registered: registered})
	}
	return status, nil
}
