// Package aipermissions：工作区 AI 权限规则文件（<工作区>/.cadt/permissions.json）的写通道。
//
// 为什么需要它：permissions.json 是「读-改-写」——前端 saveProjectRules / addProjectRule /
// removeProjectRule 读全量、改一条、整份写回。前端的 enqueueProjectRulesMutation 只做**窗口内**
// 串行；v3 一进程多窗口之后，两个窗口各读一份旧表再各自写回，后写的那个会把对方刚加的规则
// 抹掉（docs/finished-plans/agent-host-platform.md 批次 E4）。
//
// 这里只负责「锁 + 原子替换 + 落盘前先验证是合法对象」这一段：读-改-写的事务语义仍在调用方，
// 跨窗口串行由 sessionlock 保证（同一把锁，不同进程/不同窗口都排在它后面）。
//
// 读取侧不加锁也不变：前端有 3s TTL 缓存，原子替换保证它读到的永远是完整的一份。
package aipermissions

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"datalens/internal/atomfile"
	"datalens/internal/sessionlock"
)

const (
	// DirName 规则目录（相对工作区根）。
	DirName = ".cadt"
	// FileName 规则文件名（相对工作区根）。
	FileName = "permissions.json"
	lockName = ".permissions.lock"
	lockWait = 5 * time.Second
)

// Path 返回工作区根下规则文件的绝对路径（root 必须绝对路径）。
func Path(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("没有工作区，无法写权限规则")
	}
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("工作区路径不是绝对路径：%s", root)
	}
	return filepath.Join(filepath.Clean(root), DirName, FileName), nil
}

// Write 把整份权限规则写盘（跨窗口锁 + 原子替换），返回落盘绝对路径。
//
// jsonText 必须能解析成 JSON 对象：先在内存解析一次，坏 JSON / 非对象（数组、字符串、null）
// 一律报错且不落盘——半截或类型错误的规则文件会让下次读取整段走默认值，规则仿佛凭空消失。
func Write(root, jsonText string) (string, error) {
	file, err := Path(root)
	if err != nil {
		return "", err
	}
	if !utf8.ValidString(jsonText) {
		return "", errors.New("权限规则包含非法编码")
	}
	trimmed := strings.TrimSpace(jsonText)
	if trimmed == "" {
		return "", errors.New("权限规则为空")
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(trimmed), &probe); err != nil {
		return "", fmt.Errorf("权限规则不是合法 JSON 对象：%w", err)
	}
	if probe == nil {
		return "", errors.New("权限规则不是合法 JSON 对象：顶层必须是对象")
	}

	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建权限规则目录失败：%w", err)
	}
	lock, err := sessionlock.LockFile(filepath.Join(dir, lockName), lockWait)
	if err != nil {
		return "", fmt.Errorf("权限规则正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()
	if err := atomfile.WriteFileAtomicMode(file, []byte(jsonText), 0o644); err != nil {
		return "", fmt.Errorf("写入权限规则失败：%w", err)
	}
	return file, nil
}
