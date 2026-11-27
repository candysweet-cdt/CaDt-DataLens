// Package envvars：环境变量配置的读写（Windows 默认 DPAPI 加密）与子进程注入合并。
// AI 只能看到名称与描述，拿不到值；AppDataDir 由宿主（main）注入。
package envvars

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

	// 仅内存态（不落盘）：密文解不开（换机器/换用户/文件损坏）时 Value 为空，
	// sealed 保留原始密文，保存时原样写回。没有这两个字段时，一次任意保存就会把
	// 所有解不开的密钥整体覆盖成空串，且 MergeEnv 会把空值注入子进程。
	unreadable bool   `json:"-"`
	sealed     string `json:"-"`
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

// AppDataDir 宿主注入：应用数据根目录（main/appdata.go 的 appDataRoot）。
var AppDataDir func() string

// Path 返回环境变量配置文件路径。
func Path() string {
	if AppDataDir == nil {
		return ""
	}
	root := AppDataDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "env-vars.json")
}

// readEnvVarsFile 读取配置文件并把密文解回明文；缺失/损坏回退空集（加密开关取平台默认）。
func readEnvVarsFile() envVarsFile {
	file := envVarsFile{Encrypted: envEncryptionSupported()}
	path := Path()
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
			plain, err := envUnprotectValue(entry.Value)
			if err != nil {
				// fail-closed：值置空但保留密文，保存时原样写回；不注入子进程。
				entry.unreadable = true
				entry.sealed = entry.Value
				entry.Value = ""
			} else {
				entry.Value = plain
			}
		}
		file.Vars = append(file.Vars, entry)
	}
	return file
}

// saveEnvVarsFile 落盘：入参值必须已是明文，加密模式在此统一加密。
func saveEnvVarsFile(file envVarsFile) error {
	path := Path()
	if path == "" {
		return fmt.Errorf("无法定位配置目录")
	}
	out := envVarsFile{Encrypted: file.Encrypted && envEncryptionSupported(), Vars: make([]envVarEntry, 0, len(file.Vars))}
	for _, entry := range file.Vars {
		if entry.unreadable {
			// 解不开的密文原样写回：既不重新加密空串，也不因一次保存就毁掉原凭据。
			entry.Value = entry.sealed
			entry.unreadable = false
			entry.sealed = ""
			out.Vars = append(out.Vars, entry)
			continue
		}
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

// Get 返回环境变量配置（值已解密，仅供设置界面）。
func Get() (*EnvVarSnapshot, error) {
	file := readEnvVarsFile()
	vars := make([]envVarEntry, len(file.Vars))
	copy(vars, file.Vars)
	return &EnvVarSnapshot{Encrypted: file.Encrypted, Supported: envEncryptionSupported(), Vars: vars}, nil
}

// Set 整体替换环境变量配置。
func Set(inputs []EnvVarInput) error {
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
	// 解不开的项在 UI 里显示为空值，回传时也是空串：同名且为空时沿用原密文，
	// 避免"改一个无关变量"把其余密钥一起抹掉。用户真要清空就直接删掉该变量。
	oldByName := make(map[string]envVarEntry, len(file.Vars))
	for _, old := range file.Vars {
		oldByName[old.Name] = old
	}
	for i := range vars {
		if old, ok := oldByName[vars[i].Name]; ok && old.unreadable && vars[i].Value == "" {
			vars[i].unreadable = true
			vars[i].sealed = old.sealed
		}
	}
	file.Vars = vars
	return saveEnvVarsFile(file)
}

// SetEncrypted 切换加密存储：读回全部明文后按新模式重写。
func SetEncrypted(on bool) error {
	if on && !envEncryptionSupported() {
		return fmt.Errorf("当前平台不支持加密存储")
	}
	file := readEnvVarsFile()
	// 关闭加密时若还有解不开的密文，写出去等于把密文当明文落盘（且原值已不可得），
	// 直接拒绝并提示先删除这些变量。
	if !on {
		if names := unreadableNames(file); len(names) > 0 {
			return fmt.Errorf("以下变量无法解密（可能来自其他设备或用户），请先删除后再关闭加密：%s", strings.Join(names, "、"))
		}
	}
	file.Encrypted = on
	return saveEnvVarsFile(file)
}

// unreadableNames 列出解不开的变量名（诊断与 fail-closed 提示用）。
func unreadableNames(file envVarsFile) []string {
	var names []string
	for _, entry := range file.Vars {
		if entry.unreadable {
			names = append(names, entry.Name)
		}
	}
	return names
}

// injectedEnvEntries 返回已启用变量的 KEY=VALUE 列表（供子进程注入）。
func injectedEnvEntries() []string {
	file := readEnvVarsFile()
	if len(file.Vars) == 0 {
		return nil
	}
	entries := make([]string, 0, len(file.Vars))
	for _, entry := range file.Vars {
		// 解不开的值不注入：注入 NAME= 空串会覆盖系统同名变量，比不给更糟。
		if !entry.Enabled || entry.unreadable {
			continue
		}
		entries = append(entries, entry.Name+"="+entry.Value)
	}
	return entries
}

// MergeEnv 在继承环境之后追加注入变量；exec.Cmd 与 go-pty 在 Windows 构建环境块时
// 同名键保留最后一次出现（不区分大小写），因此注入值覆盖系统同名值。
// 继承前先剥离应用私有变量（SanitizeChildEnv）。
func MergeEnv(base []string) []string {
	entries := injectedEnvEntries()
	base = SanitizeChildEnv(base)
	if len(entries) == 0 {
		return base
	}
	merged := make([]string, 0, len(base)+len(entries))
	merged = append(merged, base...)
	merged = append(merged, entries...)
	return merged
}

// childEnvBlockedPrefixes 不向子进程继承的应用私有环境变量前缀。
// WAILS_MCP_* 是 MCP server 变体的连接凭据（js_eval/call_bound_method 等于全权
// 驱动宿主），泄给终端/命令桥/沙箱子进程等于给受控进程开了反向操控宿主的通道
// （2026-11-21 审查 P1-4）。注意只屏蔽 WAILS_MCP_：CADT_ 前缀里有测试辅助进程
// 的握手变量（CADT_RUN_STDIN_HELPER 等）与用户可用环境（CADT_UNIQUE_ID），不能动。
var childEnvBlockedPrefixes = []string{"WAILS_MCP_"}

// SanitizeChildEnv 过滤不向子进程继承的应用私有环境变量。
func SanitizeChildEnv(base []string) []string {
	out := make([]string, 0, len(base))
	for _, kv := range base {
		name, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		upper := strings.ToUpper(name)
		blocked := false
		for _, prefix := range childEnvBlockedPrefixes {
			if strings.HasPrefix(upper, prefix) {
				blocked = true
				break
			}
		}
		if !blocked {
			out = append(out, kv)
		}
	}
	return out
}
