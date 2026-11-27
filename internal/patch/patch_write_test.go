package patch

import (
	"strings"
	"testing"
)

// 回滚有残留时必须把错误码改成 PatchErrRollback——否则 patchcli 的
// 「⚠ 有文件未能恢复」分支（只在看到该码时打印）永远是死代码，
// 用户只看到"写入失败"，不知道工作区处于半应用状态。
func TestResolveRollbackFailure(t *testing.T) {
	cases := []struct {
		name       string
		code       string
		unrestored []string
		wantCode   string
		wantInMsg  string
	}{
		{"无残留保持原码", PatchErrApplyIO, nil, PatchErrApplyIO, ""},
		{"空切片保持原码", PatchErrConcurrent, []string{}, PatchErrConcurrent, ""},
		{"有残留改码并列出文件", PatchErrApplyIO, []string{"a.txt", "b/c.txt"}, PatchErrRollback, "a.txt、b/c.txt"},
	}
	for _, tc := range cases {
		code, msg := resolveRollbackFailure(tc.code, "写入失败", tc.unrestored)
		if code != tc.wantCode {
			t.Fatalf("%s：code=%q，期望 %q", tc.name, code, tc.wantCode)
		}
		if tc.wantInMsg != "" && !strings.Contains(msg, tc.wantInMsg) {
			t.Fatalf("%s：消息应包含 %q，实际 %q", tc.name, tc.wantInMsg, msg)
		}
		if !strings.Contains(msg, "写入失败") {
			t.Fatalf("%s：原始原因应保留，实际 %q", tc.name, msg)
		}
	}
}
