// Package aimemory：AI 记忆文件（MEMORY.md 等）的写通道——跨窗口锁 + 原子落盘。
//
// 为什么需要它：memory_write 工具原本由前端直接 SaveFile 裸写整份 MEMORY.md，
// 既不加锁也不原子。v3 一进程多窗口之后，同一个工作区的两个会话（harness 场景最典型）
// 并发写会互相盖掉——整份替换语义下这是「丢用户内容」的写点（docs/unfinished-plans/
// agent-host-platform.md 批次 E3）。
//
// 这里只做两件事：把「锁 → 原子替换」的固定组合收到一个通道里，避免每个调用点
// 自己拼一遍；行的语义（截断、迁移、模式选择）仍归前端。
//
// 落点约定（与前端 resolveMemoryDir 一致，两条路径都是**已解析好的记忆目录**）：
//
//	<工作区>/.cadt/memory/<name>      config.memoryMode = 'workspace'
//	<应用数据>/ai-memory/<name>       无工作区或用户选了应用数据模式
//
// 传错层（例如把工作区根本身传进来）会直接报错，而不是往工作区根上写一本 MEMORY.md。
package aimemory

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"datalens/internal/atomfile"
	"datalens/internal/sessionlock"
)

const (
	memoryLockName = ".write.lock"
	memoryLockWait = 5 * time.Second
	// MaxContentRunes 单份记忆内容上限，与前端 memory_write 的 `content.length > 60 << 10`
	// 同一口径（前端按字符计并先行截断，这里按 rune 复核，避免中文内容被字节数误杀）。
	MaxContentRunes = 60 << 10
)

// memoryNameRule 与前端 MEMORY_NAME_RULE 同一条规则：字母/数字/下划线/连字符/汉字 + .md。
// 名字只允许单层——不含任何分隔符，「..」另行显式拒绝。
var memoryNameRule = regexp.MustCompile(`^[A-Za-z0-9_\-\p{Han}]{1,64}\.md$`)

// Write 把一份记忆整体写入记忆目录（跨窗口锁 + 原子替换），返回落盘绝对路径。
//
// dir 必须是解析好的记忆目录绝对路径（见包注释的两条约定）；name 只允许单层 .md 文件名；
// content 超过 MaxContentRunes 直接拒绝（调用方应已按同一阈值截断，静默改写内容更糟）。
func Write(dir, name, content string) (string, error) {
	root, err := resolveMemoryDir(dir)
	if err != nil {
		return "", err
	}
	file, err := resolveMemoryFile(root, name)
	if err != nil {
		return "", err
	}
	if !utf8.ValidString(content) {
		return "", errors.New("记忆内容包含非法编码")
	}
	if runes := utf8.RuneCountInString(content); runes > MaxContentRunes {
		return "", fmt.Errorf("记忆内容过长（%d 字符，上限 %d）", runes, MaxContentRunes)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("创建记忆目录失败：%w", err)
	}
	lock, err := sessionlock.LockFile(filepath.Join(root, memoryLockName), memoryLockWait)
	if err != nil {
		return "", fmt.Errorf("记忆文件正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()
	if err := atomfile.WriteFileAtomicMode(file, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("写入记忆文件失败：%w", err)
	}
	return file, nil
}

// resolveMemoryDir 校验并归一记忆目录：必须绝对路径，且形如 <...>/.cadt/memory 或 <...>/ai-memory。
// 严格校验是为了让「传错层」当场报错——否则工作区根会被当成目录，凭空多出一份 <工作区>/MEMORY.md。
func resolveMemoryDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", errors.New("没有记忆目录")
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("记忆目录不是绝对路径：%s", dir)
	}
	clean := filepath.Clean(dir)
	base := strings.ToLower(filepath.Base(clean))
	isProjectDir := base == "memory" && strings.EqualFold(filepath.Base(filepath.Dir(clean)), ".cadt")
	if !isProjectDir && base != "ai-memory" {
		return "", fmt.Errorf("记忆目录不符合约定（应为 <工作区>/.cadt/memory 或 <应用数据>/ai-memory）：%s", clean)
	}
	return clean, nil
}

// resolveMemoryFile 校验文件名并拼出目标路径：只允许单层 .md 文件名。
func resolveMemoryFile(dir, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("记忆文件名为空")
	}
	if strings.Contains(name, "..") || strings.ContainsAny(name, `/\:`) {
		return "", fmt.Errorf("记忆文件名不允许包含路径分隔符或 ..：%q", name)
	}
	if !memoryNameRule.MatchString(name) {
		return "", fmt.Errorf("记忆文件名无效（仅字母/数字/下划线/连字符/汉字，以 .md 结尾）：%q", name)
	}
	return filepath.Join(dir, name), nil
}
