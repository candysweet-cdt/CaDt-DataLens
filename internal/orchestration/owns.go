// owns.go：文件所有权闸的纯判定（glob 校验、绝对路径归一、符号链接求值、
// 保守的 owns 交集判断）。实现在 Go 侧是硬要求：符号链接求值只有 Go 能做，
// 且补丁/命令路径本来就在后端。
package orchestration

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// normRel 把 owns 里的相对模式归一为正斜杠；拒绝绝对路径、盘符与 .. 逃逸。
func normRel(pattern string) (string, error) {
	raw := strings.TrimSpace(pattern)
	if raw == "" {
		return "", fmt.Errorf("own 模式不能为空")
	}
	p := strings.ReplaceAll(raw, "\\", "/")
	p = strings.TrimPrefix(p, "./")
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	if strings.HasPrefix(p, "/") || regexp.MustCompile(`^[A-Za-z]:`).MatchString(p) {
		return "", fmt.Errorf("own 模式必须是相对 batch.workspace 的路径：%q", raw)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", fmt.Errorf("own 模式不允许 .. 逃逸：%q", raw)
		}
	}
	if strings.ContainsAny(p, "?[]{}") || strings.Contains(p, "\\") || strings.ContainsAny(p, "\n\r\x00") {
		return "", fmt.Errorf("own 模式只支持 * 与 **（不支持 ? / [] / {} / 正则）：%q", raw)
	}
	return strings.TrimPrefix(p, "/"), nil
}

// normalizeOwns 校验并归一全部 owns。
func normalizeOwns(owns []string) ([]string, error) {
	out := make([]string, 0, len(owns))
	for _, pattern := range owns {
		p, err := normRel(pattern)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// cleanAbs 绝对路径归一：Windows 大小写不敏感、分隔符统一正斜杠、折叠 . 与 ..
// 但不求符号链接（求值在 evalNearest）。
func cleanAbs(path string) string {
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		abs = strings.TrimSpace(path)
	}
	abs = filepath.Clean(abs)
	if runtime.GOOS == "windows" {
		abs = strings.ToLower(abs)
	}
	return filepath.ToSlash(abs)
}

// evalNearest 对最近存在的祖先做 EvalSymlinks，再拼回不存在的剩余段。
// 目标文件可能尚未创建，直接对整条路径求值会失败。
func evalNearest(path string) string {
	p := filepath.Clean(path)
	remain := make([]string, 0, 8)
	for {
		if _, err := os.Lstat(p); err == nil {
			break
		}
		parent := filepath.Dir(p)
		if parent == p {
			return cleanAbs(path)
		}
		remain = append(remain, filepath.Base(p))
		p = parent
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		resolved = p
	}
	for i := len(remain) - 1; i >= 0; i-- {
		resolved = filepath.Join(resolved, remain[i])
	}
	return cleanAbs(resolved)
}

// pathInside 判断 child 是否在 root 之内（含相等）。两者都应是 cleanAbs 结果。
func pathInside(root, child string) bool {
	root = strings.TrimSuffix(root, "/")
	if root == "" {
		return false
	}
	if child == root {
		return true
	}
	return strings.HasPrefix(child, root+"/")
}

// relInside 返回 child 相对 root 的正斜杠路径；不在根内时 ok=false。
func relInside(root, child string) (string, bool) {
	if !pathInside(root, child) {
		return "", false
	}
	rel := strings.TrimPrefix(child, strings.TrimSuffix(root, "/"))
	rel = strings.TrimPrefix(rel, "/")
	return rel, true
}

// globToRegex 把 owns 模式转为正则：** 跨目录、* 不跨 /；其余字符按字面量。
// 这个实现与前端 globMatchPath 的语义一致，但 owns 更窄（不含 ?）。
func globToRegex(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		switch ch {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '/', '-', '_', '.', ' ':
			b.WriteString(regexp.QuoteMeta(string(ch)))
		default:
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return nil, fmt.Errorf("own 模式无法解析：%q（%v）", pattern, err)
	}
	return re, nil
}

// ownsMatch 用已归一模式匹配 rel（小写、正斜杠）。
func ownsMatch(owns []string, rel string) bool {
	for _, pattern := range owns {
		re, err := globToRegex(pattern)
		if err != nil {
			// 校验阶段已拒绝非法模式；运行期遇到未知错误按拒绝处理，绝不退化为放行。
			continue
		}
		if re.MatchString(rel) {
			return true
		}
	}
	return false
}

// globsDefinitelyDisjoint 只有能证明不相交时才返回 true；其余一律视为可能相交。
// 保守判定是有意的：判不准就串行，宁可牺牲并行度，也不能让两个会话写同一文件。
func globsDefinitelyDisjoint(a, b string) bool {
	as := strings.Split(a, "/")
	bs := strings.Split(b, "/")
	n := len(as)
	if len(bs) < n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		x, y := as[i], bs[i]
		wildX := strings.Contains(x, "*")
		wildY := strings.Contains(y, "*")
		if wildX || wildY {
			// 通配段之后无法证明不相交；** 更是如此。
			return false
		}
		if x != y {
			return true
		}
	}
	// 共同前缀完全相同：一个可能是另一个的父目录/同前缀，存在交集。
	return false
}

// ownsIntersect 判断两组 owns 是否可能相交（空 owns 不与任何东西相交）。
func ownsIntersect(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if !globsDefinitelyDisjoint(x, y) {
				return true
			}
		}
	}
	return false
}

// authorizePath 返回写闸判定：路径必须在 workspace 内且匹配 owns。
// 返回 rel（相对 workspace 的小写正斜杠路径）给 writeLog 使用。
func authorizePath(workspace string, owns []string, absPath string) (rel string, err error) {
	root := evalNearest(workspace)
	target := evalNearest(absPath)
	if !pathInside(root, target) {
		return "", fmt.Errorf("路径在工作区之外：%s", absPath)
	}
	rel, _ = relInside(root, target)
	if !ownsMatch(owns, rel) {
		return rel, fmt.Errorf("路径 %s 不在本批 owns 内（本批仅可写 %s）；如确需修改请回报 blocked 说明",
			rel, strings.Join(owns, "、"))
	}
	return rel, nil
}

// validateVerifySpecs 校验验收命令形态：只允许 exe + argv，不允许 shell 包装或元字符式的一整串命令。
func validateVerifySpecs(workspace string, specs []VerifySpec) error {
	for i, spec := range specs {
		exe := strings.TrimSpace(spec.File)
		if exe == "" {
			return fmt.Errorf("第 %d 条 verify 缺少 file（可执行文件）", i+1)
		}
		lower := strings.ToLower(filepath.Base(exe))
		if lower == "cmd" || lower == "cmd.exe" || lower == "powershell" || lower == "powershell.exe" ||
			lower == "pwsh" || lower == "pwsh.exe" || lower == "sh" || lower == "bash" || lower == "bash.exe" ||
			lower == "zsh" || lower == "fish" {
			return fmt.Errorf("verify 不允许 shell 包装器（%s）；请直接填可执行文件与参数", exe)
		}
		if strings.ContainsAny(exe, "&|;<>`\n\r\x00") {
			return fmt.Errorf("verify 的 file 含 shell 元字符：%q", exe)
		}
		if len(spec.Args) > 128 {
			return fmt.Errorf("verify 参数超过 128 个")
		}
		for _, arg := range spec.Args {
			if strings.ContainsAny(arg, "\x00\n\r") {
				return fmt.Errorf("verify 参数含控制字符")
			}
		}
		if strings.TrimSpace(spec.Cwd) != "" {
			cwd := spec.Cwd
			if !filepath.IsAbs(cwd) {
				cwd = filepath.Join(workspace, cwd)
			}
			root := evalNearest(workspace)
			if !pathInside(root, evalNearest(cwd)) {
				return fmt.Errorf("verify 的 cwd 在工作区外：%s", spec.Cwd)
			}
		}
		if spec.TimeoutMs < 0 || spec.TimeoutMs > MaxVerifyTimeoutMs {
			return fmt.Errorf("verify 超时必须在 0–%d ms 之间", MaxVerifyTimeoutMs)
		}
	}
	return nil
}

// summarizeWriteDirs 把 writeLog 收敛为目录级摘要（每批 ≤ maxChars），避免派单 prompt 膨胀。
func summarizeWriteDirs(entries []WriteLogEntry, maxChars int) string {
	seen := make(map[string]bool)
	dirs := make([]string, 0, 8)
	for _, entry := range entries {
		if entry.Denied || entry.Path == "" {
			continue
		}
		dir := filepath.ToSlash(filepath.Dir(entry.Path))
		if dir == "." {
			dir = entry.Path
		}
		if seen[dir] {
			continue
		}
		seen[dir] = true
		dirs = append(dirs, dir)
	}
	if len(dirs) == 0 {
		return "（无放行写入）"
	}
	out := strings.Join(dirs, "、")
	if len([]rune(out)) > maxChars {
		out = truncateRunes(out, maxChars)
	}
	return out
}
