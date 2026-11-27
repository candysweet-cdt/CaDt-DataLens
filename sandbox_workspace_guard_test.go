package main

// sandbox_workspace_guard_test.go：沙箱测试/联调不得把真实工作区作为 workspace-write 写根。
//
// 2026-11-27 事故：对真实仓库执行 workspace-write，Low 完整性标签永久落到仓库根，
// 导致仓库内所有 exe（含 node_modules 构建工具）以 Low 启动，vite build 报 Access denied。
// 本守卫是 P1「联调纪律」的机械代理：测试写根必须是 t.TempDir() 或明确的隔离目录。
import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestSandboxTestsNeverUseRealWorkspaceAsWriteRoot(t *testing.T) {
	roots := []string{"internal/sandbox", "internal/cmdbridge"}
	// WorkspaceRoot 后直接跟 os.Getwd()/os.TempDir() 或仓库根字面量，都是高风险形态。
	bad := regexp.MustCompile(`(?m)WorkspaceRoot\s*:\s*(?:os\.Getwd\(\)|os\.TempDir\(\)|"[A-Za-z]:[\\/][^"]*CaDt-DataLens[^"]*")`)
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatalf("读取 %s: %v", root, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), "_test.go") {
				continue
			}
			path := filepath.Join(root, entry.Name())
			src, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("读取 %s: %v", path, err)
			}
			if loc := bad.FindIndex(src); loc != nil {
				t.Errorf("%s 把真实工作区作为 WorkspaceRoot（沙箱会落 Low 标签）：%s", path, string(src[loc[0]:loc[1]]))
			}
		}
	}
}
