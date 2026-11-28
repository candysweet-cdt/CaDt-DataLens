package skills

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"datalens/internal/appdata"
)

// Skills 内置技能物化与 agent 技能注册。嵌入资源与版本由根壳注入。
type Skills struct{}

// 宿主注入（main/skills.go 在 init 中接线）。
var (
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
	// Version 应用版本，用于内置技能物化标记。
	Version = ""
	// Embedded 随 exe 分发的 docs/skills 资源。
	Embedded fs.FS
)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

func readEmbedded(path string) ([]byte, error) {
	if Embedded == nil {
		return nil, fmt.Errorf("内置技能资源未接线")
	}
	return fs.ReadFile(Embedded, path)
}

const (
	skillDirName  = "cadt-datalens"
	skillSource   = "docs/skills/" + skillDirName
	skillMarker   = "name: cadt-datalens"
	skillExeToken = "{{EXE_PATH}}"

	builtinSkillsRoot  = "builtin-skills"
	builtinSkillsStamp = ".cadt-builtin-version"
)

// appBuiltinSkillDirs 随 exe 分发、在 AI 面板「技能管理」中显示为「内置」的技能目录。
// 首次列出技能时按应用版本释放到 <应用数据>/builtin-skills/，供 read_file 读取 references 等附属文件。
var appBuiltinSkillDirs = []string{
	"cadt-file-layout",
	"reverse-engineer-anything",
	"chinese-formal-document-format",
	"landing-page-design",
	"cadt-datalens",
	"code-review",
	"json-toolkit",
	"release-notes",
	"patch-workflow",
	"cadt-gen-models",
	"cadt-mcp-samples",
	"cadt-mcp-config",
	"web-research",
	"docx",
	"pdf",
	"skill-creator",
	"plugin-creator",
	"answer-me-with-html",
}

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

// skillEntryPaths 列出嵌入的技能目录里需要落盘的文件（相对 source 的路径）。
func skillEntryPaths(source string) ([]string, error) {
	paths := []string{}
	err := fs.WalkDir(Embedded, source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, e := filepath.Rel(source, path)
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

func writeSkillDirAt(root, source, dirName, exe string) error {
	paths, err := skillEntryPaths(source)
	if err != nil {
		return err
	}
	base := filepath.Join(root, dirName)
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	for _, rel := range paths {
		content, err := readEmbedded(filepath.ToSlash(filepath.Join(source, rel)))
		if err != nil {
			return err
		}
		if exe != "" && dirName == skillDirName && strings.EqualFold(rel, "SKILL.md") {
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

func writeAgentSkillAt(root, exe string) error {
	return writeSkillDirAt(root, skillSource, skillDirName, exe)
}

var (
	builtinSkillsOnce sync.Once
	builtinSkillsDir  string
)

// AIBuiltinSkillsDir 返回随应用分发的内置技能目录（首次调用时物化；失败返回空串）。
func (m *Skills) AIBuiltinSkillsDir() string {
	builtinSkillsOnce.Do(func() {
		builtinSkillsDir = materializeBuiltinSkills()
	})
	return builtinSkillsDir
}

// materializeBuiltinSkills 把内置技能按应用版本释放到应用数据目录，版本变化时覆盖刷新。
// 失败只记日志并返回空串：内置技能不出现，但不影响应用其余功能。
func materializeBuiltinSkills() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	target := filepath.Join(root, builtinSkillsRoot)
	stamp := filepath.Join(target, builtinSkillsStamp)
	exe, err := os.Executable()
	if err != nil {
		logf("warn", "取当前 exe 路径失败，内置技能按原样释放：%v", err)
		exe = ""
	}
	want := Version + "|" + strings.Join(appBuiltinSkillDirs, ",") + "|" + exe
	if data, err := os.ReadFile(stamp); err == nil && strings.TrimSpace(string(data)) == want {
		return target
	}
	for _, dir := range appBuiltinSkillDirs {
		if err := os.RemoveAll(filepath.Join(target, dir)); err != nil {
			logf("warn", "内置技能 %s 清理失败：%v", dir, err)
			return ""
		}
		if err := writeSkillDirAt(target, "docs/skills/"+dir, dir, exe); err != nil {
			logf("warn", "内置技能 %s 写入失败：%v", dir, err)
			return ""
		}
	}
	if err := os.WriteFile(stamp, []byte(want), 0o644); err != nil {
		logf("warn", "内置技能版本标记写入失败：%v", err)
		return ""
	}
	return target
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

func (m *Skills) SetAgentSkill(enabled bool) error {
	if enabled {
		return RegisterAgentSkill()
	}
	return UnregisterAgentSkill()
}

func (m *Skills) GetAgentSkillStatus() (*AgentSkillStatus, error) {
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
