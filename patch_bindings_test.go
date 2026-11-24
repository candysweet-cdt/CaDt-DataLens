package main

// patch_bindings_test.go：补丁的 App 绑定层集成测试（只读审阅 PatchParseText 与
// 预检 PatchPreviewText 的行结构一致性）。纯解析引擎的白盒测试在 internal/patch/。

import (
	"reflect"
	"testing"

	"datalens/internal/patch"
)

// 只读审阅解析：不生成计划、不读目标文件、不带任何预检状态。
// 「不注册计划」的白盒断言在 internal/patch/patch_review_test.go。
func TestPatchParseTextReviewSnapshot(t *testing.T) {
	app := &App{}
	// 目标文件在磁盘上根本不存在：纯解析不应该关心它
	text := "diff --git a/src/a.txt b/src/a.txt\n" +
		"--- a/src/a.txt\n+++ b/src/a.txt\n" +
		"@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n"
	out, err := app.PatchParseText(text)
	if err != nil {
		t.Fatalf("PatchParseText: %v", err)
	}
	if out.PlanID != "" || out.PatchID != "" || out.Root != "" || out.Applicable || out.DefaultMode != "" {
		t.Fatalf("审阅解析不应带计划 / 应用语义：%+v", out)
	}
	if out.Added != 2 || out.Removed != 1 {
		t.Fatalf("统计 = +%d -%d，期望 +2 -1", out.Added, out.Removed)
	}
	if len(out.Files) != 1 {
		t.Fatalf("文件数 = %d，期望 1", len(out.Files))
	}
	f := out.Files[0]
	if f.RelPath != "src/a.txt" {
		t.Fatalf("路径 = %q，期望 src/a.txt", f.RelPath)
	}
	if f.Status != "" || f.Reason != "" || f.Added != 2 || f.Removed != 1 {
		t.Fatalf("文件不应带预检状态：%+v", f)
	}
	if len(f.Hunks) != 1 {
		t.Fatalf("hunk 数 = %d，期望 1", len(f.Hunks))
	}
	h := f.Hunks[0]
	if h.Status != "" || h.Reason != "" || h.ApplyAtLine != 0 {
		t.Fatalf("hunk 不应带预检状态 / 落点：%+v", h)
	}
	if h.Header != "@@ -1,2 +1,3 @@" || h.OldStart != 1 || h.NewStart != 1 {
		t.Fatalf("hunk 头 = %+v", h)
	}
	want := []patch.PatchLineOut{
		{T: " ", Text: "keep", OldLine: 1, NewLine: 1},
		{T: "-", Text: "old", OldLine: 2},
		{T: "+", Text: "new", NewLine: 2},
		{T: "+", Text: "extra", NewLine: 3},
	}
	if !reflect.DeepEqual(h.Lines, want) {
		t.Fatalf("行号 = %+v，期望 %+v", h.Lines, want)
	}
}

// 抽取 patchHunkToOut 后，预检路径产出的行结构必须与纯解析完全一致。
func TestPatchParseTextHunksMatchPlanPreview(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "a.txt", "a\nb\nc\n")
	app := &App{}
	text := simplePatch("a.txt")
	planned, err := app.PatchPreviewText(text, root)
	if err != nil {
		t.Fatalf("PatchPreviewText: %v", err)
	}
	parsed, err := app.PatchParseText(text)
	if err != nil {
		t.Fatalf("PatchParseText: %v", err)
	}
	if len(planned.Files) != 1 || len(parsed.Files) != 1 {
		t.Fatalf("文件数不一致：预检 %d / 解析 %d", len(planned.Files), len(parsed.Files))
	}
	ph, rh := planned.Files[0].Hunks[0], parsed.Files[0].Hunks[0]
	if ph.Header != rh.Header || ph.OldStart != rh.OldStart || ph.NewStart != rh.NewStart {
		t.Fatalf("hunk 头不一致：%+v / %+v", ph, rh)
	}
	if !reflect.DeepEqual(ph.Lines, rh.Lines) {
		t.Fatalf("行结构不一致：%+v / %+v", ph.Lines, rh.Lines)
	}
	if planned.PlanID == "" || parsed.PlanID != "" {
		t.Fatalf("计划 ID：预检 = %q，解析 = %q", planned.PlanID, parsed.PlanID)
	}
}

func TestPatchParseTextEmpty(t *testing.T) {
	app := &App{}
	if _, err := app.PatchParseText("   \n"); err == nil {
		t.Fatalf("空文本应报错")
	}
}
