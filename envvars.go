package main

// 环境变量配置：用户在设置里维护私密变量（API key 等），值只保存在应用数据目录
// env-vars.json（Windows 默认 DPAPI 加密），注入到内置终端与命令桥子进程；
// AI 只能通过 env_list 工具看到名称与描述，永远拿不到值。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	envVarsMaxCount     = 64
	envVarValueMaxBytes = 16 << 10
	envVarDescMaxRunes  = 500
)

var envVarNameRule = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type envVarEntry struct {
	Name        string `json:"name"`
	Value       string `json:"value"`
	Description string `json:"description,omitempty"`
	Enabled     bool   `json:"enabled"`
}

type envVarsFile struct {
	Encrypted bool          `json:"encrypted"`
	Vars      []envVarEntry `json:"vars"`
}

// EnvVarSnapshot 返回给设置界面的快照（值已解密，仅供本机 UI 编辑）。
type EnvVarSnapshot struct {
	Encrypted bool          `json:"encrypted"`
	Supported bool          `json:"supported"`
	Vars      []envVarEntry `json:"vars"`
}

// EnvVarInput 是设置界面提交的单个变量（值为明文，按当前存储模式落盘）。
type EnvVarInput struct {
	Name        string `json:"name"`
	Value       string `json:"value"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

func envVarsFilePath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "env-vars.json")
}

// readEnvVarsFile 读取配置文件并把密文解回明文；缺失/损坏回退空集（加密开关取平台默认）。
func readEnvVarsFile() envVarsFile {
	file := envVarsFile{Encrypted: envEncryptionSupported()}
	path := envVarsFilePath()
	if path == "" {
		return file
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return file
	}
	var stored envVarsFile
	if json.Unmarshal(raw, &stored) != nil {
		return file
	}
	file.Encrypted = stored.Encrypted
	for _, entry := range stored.Vars {
		if stored.Encrypted {
			entry.Value = envUnprotectValue(entry.Value)
		}
		file.Vars = append(file.Vars, entry)
	}
	return file
}

// saveEnvVarsFile 落盘：入参值必须已是明文，加密模式在此统一加密。
func saveEnvVarsFile(file envVarsFile) error {
	path := envVarsFilePath()
	if path == "" {
		return fmt.Errorf("无法定位配置目录")
	}
	out := envVarsFile{Encrypted: file.Encrypted && envEncryptionSupported(), Vars: make([]envVarEntry, 0, len(file.Vars))}
	for _, entry := range file.Vars {
		value := entry.Value
		if out.Encrypted {
			stored, err := envProtectValue(value)
			if err != nil {
				return fmt.Errorf("加密变量 %s 失败：%w", entry.Name, err)
			}
			value = stored
		}
		entry.Value = value
		out.Vars = append(out.Vars, entry)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func normalizeEnvVarInput(in EnvVarInput) (envVarEntry, error) {
	name := strings.TrimSpace(in.Name)
	if !envVarNameRule.MatchString(name) {
		return envVarEntry{}, fmt.Errorf("变量名 %q 无效（字母/数字/下划线，字母或下划线开头，最长 128）", name)
	}
	if len(in.Value) > envVarValueMaxBytes {
		return envVarEntry{}, fmt.Errorf("变量 %s 的值超过 %d KB", name, envVarValueMaxBytes>>10)
	}
	if strings.ContainsRune(in.Value, '\x00') {
		return envVarEntry{}, fmt.Errorf("变量 %s 的值不能包含空字符", name)
	}
	desc := strings.TrimSpace(in.Description)
	if len([]rune(desc)) > envVarDescMaxRunes {
		return envVarEntry{}, fmt.Errorf("变量 %s 的描述过长（≤%d 字符）", name, envVarDescMaxRunes)
	}
	return envVarEntry{Name: name, Value: in.Value, Description: desc, Enabled: in.Enabled}, nil
}

// GetEnvVars 返回环境变量配置（值已解密，仅供设置界面）。
func (a *App) GetEnvVars() (*EnvVarSnapshot, error) {
	file := readEnvVarsFile()
	vars := make([]envVarEntry, len(file.Vars))
	copy(vars, file.Vars)
	return &EnvVarSnapshot{Encrypted: file.Encrypted, Supported: envEncryptionSupported(), Vars: vars}, nil
}

// SetEnvVars 整体替换环境变量配置。
func (a *App) SetEnvVars(inputs []EnvVarInput) error {
	if len(inputs) > envVarsMaxCount {
		return fmt.Errorf("环境变量最多 %d 个", envVarsMaxCount)
	}
	seen := make(map[string]bool, len(inputs))
	vars := make([]envVarEntry, 0, len(inputs))
	for _, in := range inputs {
		entry, err := normalizeEnvVarInput(in)
		if err != nil {
			return err
		}
		if seen[entry.Name] {
			return fmt.Errorf("环境变量 %s 重复", entry.Name)
		}
		seen[entry.Name] = true
		vars = append(vars, entry)
	}
	file := readEnvVarsFile()
	file.Vars = vars
	return saveEnvVarsFile(file)
}

// SetEnvVarEncrypted 切换加密存储：读回全部明文后按新模式重写。
func (a *App) SetEnvVarEncrypted(on bool) error {
	if on && !envEncryptionSupported() {
		return fmt.Errorf("当前平台不支持加密存储")
	}
	file := readEnvVarsFile()
	file.Encrypted = on
	return saveEnvVarsFile(file)
}

// injectedEnvEntries 返回已启用变量的 KEY=VALUE 列表（供子进程注入）。
func injectedEnvEntries() []string {
	file := readEnvVarsFile()
	if len(file.Vars) == 0 {
		return nil
	}
	entries := make([]string, 0, len(file.Vars))
	for _, entry := range file.Vars {
		if !entry.Enabled {
			continue
		}
		entries = append(entries, entry.Name+"="+entry.Value)
	}
	return entries
}

// mergeEnv 在继承环境之后追加注入变量；exec.Cmd 与 go-pty 在 Windows 构建环境块时
// 同名键保留最后一次出现（不区分大小写），因此注入值覆盖系统同名值。
func mergeEnv(base []string) []string {
	entries := injectedEnvEntries()
	if len(entries) == 0 {
		return base
	}
	merged := make([]string, 0, len(base)+len(entries))
	merged = append(merged, base...)
	merged = append(merged, entries...)
	return merged
}
