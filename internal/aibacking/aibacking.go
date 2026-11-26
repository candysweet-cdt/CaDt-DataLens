// Package aibacking：未绑定工作区的 AI 会话的「沙盒工作区」（backing workspace）。
//
// 背景：会话可以没有真实工作区（harness 下随手开的话题、或用户选了「会话沙盒」）。
// 这类会话此前只有「只读 + 绝对路径」这一条路——工具想写点东西就没地方落，模型只能
// 反复试探被拒。ZCode 的 backing workspace / cline 的 chat workspace 都是同一个思路：
// 给会话一个真实可写、明确不是用户仓库的目录。
//
// 布局：<应用数据>/ai-workspaces/<sessionId>（首次访问时创建，只写一次礼仪 AGENTS.md）。
// 该目录连同其它会话内务一样属于应用数据，不是用户项目：不参与工作区扫描、不被当成根。
//
// 为什么单独一个包：路径拼接 + 目录创建 + 首次礼仪文件是三个独立关注点，
// 放进 sessionstore（会话磁盘存储）会把它和「会话正文真源」搅在一起。
package aibacking

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/appdata"
	"datalens/internal/sessionstore"
)

const (
	// DirName 沙盒根目录名（相对应用数据根）。
	DirName = "ai-workspaces"
	// WelcomeName 首次创建时落的礼仪文件名；已存在则不覆盖（用户可能改过）。
	WelcomeName = "AGENTS.md"
	dirMode     = 0o755
	fileMode    = 0o644
)

// welcomeText 沙盒目录的礼仪说明。刻意不做成项目级的规则（它没有 CDDL/项目约定），
// 只说清「这是哪里、能干什么、别在这存东西」——模型读到就会照着办。
const welcomeText = `# 会话沙盒

这是本会话专用的沙盒目录，可以自由读写；它不是用户的真实仓库。

- 可以在这里放手写临时脚本、探针、生成物与中间数据；
- 不要在这里长期存放项目文件或需要保留的成果（它会随会话数据一起被清掉）；
- 需要修改真实仓库时，请先让用户把工作区绑定到这个会话。
`

// Workspace 返回会话沙盒的绝对路径，并确保目录与礼仪文件已就位。
//
// sessionID 会被拼进路径，先过 sessionstore.ValidSessionID（不含分隔符、不以点开头、
// 非 Windows 保留名）——这里不做校验就是目录穿越漏洞。
func Workspace(sessionID string) (string, error) {
	return WorkspaceAt(appdata.Root(), sessionID)
}

// WorkspaceAt 在给定的应用数据根下解析并创建会话沙盒（root 为空或会话 id 非法时报错）。
// 单独暴露是为了测试能指定根目录，不必去动用户真实的应用数据目录。
func WorkspaceAt(root, sessionID string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", appdata.ErrNoRoot
	}
	id := strings.TrimSpace(sessionID)
	if id == "" {
		return "", errors.New("缺少会话 id，无法定位会话沙盒")
	}
	if !sessionstore.ValidSessionID(id) {
		return "", fmt.Errorf("会话 id 非法：%q（不允许分隔符、点开头或保留名）", sessionID)
	}
	dir := filepath.Join(root, DirName, id)
	// 双保险：路径必须真的落在沙盒根下（ValidSessionID 之外再挡一次拼接意外）。
	if filepath.Dir(dir) != filepath.Join(root, DirName) {
		return "", fmt.Errorf("会话 id 非法：%q", sessionID)
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return "", fmt.Errorf("创建会话沙盒失败：%w", err)
	}
	if err := writeWelcomeOnce(filepath.Join(dir, WelcomeName)); err != nil {
		return "", err
	}
	return dir, nil
}

// writeWelcomeOnce 只在文件不存在时写入礼仪说明：用 O_EXCL 让「只写一次」在并发下
// 也成立（两个窗口同时首次进同一会话时，只有一个能创建成功，另一个看到 IsExist）。
func writeWelcomeOnce(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, fileMode)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return fmt.Errorf("写会话沙盒说明失败：%w", err)
	}
	if _, err := f.WriteString(welcomeText); err != nil {
		f.Close()
		return fmt.Errorf("写会话沙盒说明失败：%w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("写会话沙盒说明失败：%w", err)
	}
	return nil
}
