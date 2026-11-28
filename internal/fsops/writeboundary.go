package fsops

// 子代理写入边界的权威判定（能力快照方案 docs/finished-plans/subagent-capabilities-redesign.md §5.5）。
//
// 前端（agent-capabilities.js 的 subWriteVerdict）只做字符串规范化快筛——JS 不解析 reparse
// point，符号链接逃逸与 TOCTOU 只有这里能挡住。落盘前（SaveFileChecked 之前）由 AI 面板对
// workspace-write 档的子代理写入逐次调用 WriteBoundaryCheck，失败即拒绝（fail-closed）。
//
// 两道防线：
//  1. 逐节 Lstat：路径上任何一节是 symlink/junction（Windows reparse point 在 Go 里表现为
//     os.ModeSymlink）即拒绝——写穿链接等于在白名单外落盘；
//  2. EvalSymlinks 归一化后与可写根做前缀比对（分隔符边界对齐，Windows 大小写不敏感）。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AssertWritablePath 校验 path 是否可以安全写入 roots 之一，返回归一化后的绝对路径。
// roots 必须是绝对路径；path 不存在的最后一节允许（新文件），但其上已存在的任何一节
// 都不得是链接。roots 为空时一律拒绝（调用方语义：没有可写根就没有可写面）。
func AssertWritablePath(roots []string, path string) (string, error) {
	target := strings.TrimSpace(path)
	if target == "" {
		return "", fmt.Errorf("没有写入路径")
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return "", fmt.Errorf("写入路径无效 %q: %w", target, err)
	}
	if len(roots) == 0 {
		return "", fmt.Errorf("没有可写根（writableRoots 为空），拒绝写入 %q", target)
	}
	// 防线 1：逐节 Lstat 拒绝 reparse point。最后一节不存在（新建文件）时其上各节仍要查。
	if err := rejectSymlinkChain(abs); err != nil {
		return "", err
	}
	// 防线 2：归一化后前缀比对。可写根可能尚不存在（如插件声明的「草稿区」），
	// 用宽松 EvalSymlinks（沿最深存在祖先解析）。
	// 目标侧同样宽松解析：链拒绝已先挡掉 reparse point，这里的解析只会归一大小写 /
	// 8.3 短名形态，让根与目标来自不同形态来源时不再假拒（fail-closed 方向不变）。
	targetNorm := evalSymlinksLenient(abs)
	for _, root := range roots {
		rootAbs, err := filepath.Abs(strings.TrimSpace(root))
		if err != nil || rootAbs == "" {
			continue
		}
		rootNorm := evalSymlinksLenient(rootAbs)
		if withinPrefix(rootNorm, targetNorm) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("写入路径 %q 不在任何可写根内（writableRoots：%s）", target, strings.Join(roots, "、"))
}

// rejectSymlinkChain 对路径的每一节做重解析点检查，任何一节是 symlink/junction 即拒绝。
// 从叶向上走；叶节不存在（新建文件）时**继续向上**查已存在的祖先节——祖先里藏
// symlink/junction 同样能把写带出可写根（新建文件是最常见的写入形态，不能提前放行）。
// Windows 的判定按 ReparseTag 精确识别（os.Lstat 对 junction 不报 ModeSymlink），
// 实现见 writeboundary_platform_windows.go / _other.go。
func rejectSymlinkChain(abs string) error {
	current := abs
	for {
		if _, err := os.Lstat(current); err != nil {
			if os.IsNotExist(err) {
				parent := filepath.Dir(current)
				if parent == current {
					return nil
				}
				current = parent
				continue
			}
			return fmt.Errorf("写入路径校验失败 %q: %w", current, err)
		}
		if isReparsePoint(current) {
			return fmt.Errorf("写入路径 %q 含符号链接/junction，已拒绝（子代理写入不允许经过链接）", current)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}

// evalSymlinksLenient 解析路径中的符号链接；路径（或其祖先）不存在时沿最深存在祖先解析，
// 剩余部分原样拼接——预声明的可写根（尚未创建的目录）也能得到一致形态。
func evalSymlinksLenient(p string) string {
	cur := filepath.Clean(p)
	suffix := ""
	for {
		resolved, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return filepath.Join(resolved, suffix)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return filepath.Clean(p)
		}
		if suffix == "" {
			suffix = filepath.Base(cur)
		} else {
			suffix = filepath.Join(filepath.Base(cur), suffix)
		}
		cur = parent
	}
}

// withinPrefix 分隔符边界前缀比对。大小写语义按目标平台（fsCaseInsensitiveFS，
// 平台成对实现）：Windows 不区分大小写，其余平台大小写敏感（fail-closed 方向）。
func withinPrefix(rootNorm, target string) bool {
	rootNorm = filepath.Clean(rootNorm)
	sep := string(filepath.Separator)
	rootCmp, targetCmp := rootNorm, filepath.Clean(target)
	if fsCaseInsensitiveFS() {
		rootCmp = strings.ToLower(rootNorm)
		targetCmp = strings.ToLower(filepath.Clean(target))
	}
	if rootCmp == "" {
		return false
	}
	if targetCmp == rootCmp {
		return true
	}
	// 盘根（C:\）作可写根：Clean 保留尾部分隔符，rootCmp 已以 sep 结尾，
	// 再拼 sep 会得到 "c:\\" 导致整盘误拒——按已含分隔符的前缀直接比对。
	if strings.HasSuffix(rootCmp, sep) {
		return strings.HasPrefix(targetCmp, rootCmp)
	}
	return strings.HasPrefix(targetCmp, rootCmp+sep)
}

// WriteBoundaryCheck 子代理写入边界判定的前端绑定（Service 方法 → 自动进 *App 绑定面）。
// rootsJSON 是 JSON 字符串数组（可写根，绝对路径）；返回归一化后的绝对路径。
// 命名不带 AI 前缀：它是 fsops 的通用文件边界能力，当前唯一消费者是 AI 子代理写路径。
func (f *FS) WriteBoundaryCheck(rootsJSON, path string) (string, error) {
	var roots []string
	if err := json.Unmarshal([]byte(rootsJSON), &roots); err != nil {
		return "", fmt.Errorf("可写根参数无效（需要 JSON 字符串数组）: %w", err)
	}
	return AssertWritablePath(roots, path)
}
