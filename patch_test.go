package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ===== 测试辅助 =====

func writePatchTestFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return abs
}

func readPatchTestFile(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustParse(t *testing.T, text string) *patchDoc {
	t.Helper()
	doc, err := parsePatchText(text)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	return doc
}

func mustPlan(t *testing.T, doc *patchDoc, root string, opts patchPlanOptions) *patchPlan {
	t.Helper()
	plan, err := buildPatchPlan(doc, root, "test-id", "测试补丁", filepath.Join(root, "t.patch"), opts)
	if err != nil {
		t.Fatalf("构建计划失败：%v", err)
	}
	return plan
}

func fileStatusOf(plan *patchPlan, rel string) *patchPlanFile {
	for _, f := range plan.Files {
		if strings.EqualFold(f.RelPath, rel) {
			return f
		}
	}
	return nil
}

// 一个最小单 hunk 补丁：把 b 替换成 B
func simplePatch(rel string) string {
	return "--- a/" + rel + "\n+++ b/" + rel + "\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"
}

// ===== 解析 =====

func TestParsePatchBasic(t *testing.T) {
	doc := mustParse(t, simplePatch("x.txt"))
	if len(doc.Files) != 1 {
		t.Fatalf("文件数 = %d，期望 1", len(doc.Files))
	}
	f := doc.Files[0]
	if len(f.Hunks) != 1 || f.Hunks[0].OldStart != 1 || f.Hunks[0].OldCount != 3 {
		t.Fatalf("hunk 解析异常：%+v", f.Hunks)
	}
	if f.Added != 1 || f.Removed != 1 {
		t.Fatalf("统计异常：+%d -%d", f.Added, f.Removed)
	}
}

func TestParsePatchErrors(t *testing.T) {
	cases := []struct {
		name string
		text string
		code string
	}{
		{"空补丁", "", patchErrEmpty},
		{"没有 hunk", "--- a/x\n+++ b/x\n", patchErrEmpty},
		{"hunk 行数不符", "--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n", patchErrParse},
		{"缺文件头", "@@ -1 +1 @@\n-a\n+b\n", patchErrParse},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := parsePatchText(c.text)
			if err == nil {
				t.Fatal("期望报错，实际通过")
			}
			if pe := patchErrorOf(err); pe.Code != c.code {
				t.Fatalf("错误码 = %s，期望 %s（%s）", pe.Code, c.code, pe.Msg)
			}
		})
	}
}

func TestParseNoNewlineMarker(t *testing.T) {
	text := "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
	doc := mustParse(t, text)
	h := doc.Files[0].Hunks[0]
	if len(h.Lines) != 3 {
		t.Fatalf("行数 = %d，期望 3", len(h.Lines))
	}
	if !h.Lines[1].NoEOL || !h.Lines[2].NoEOL {
		t.Fatal("\\ No newline 标记未记录")
	}
}

func TestParseGitHeaderAndCRLF(t *testing.T) {
	text := "diff --git a/x.txt b/x.txt\r\nindex 111..222 100644\r\n--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n"
	doc := mustParse(t, text)
	if len(doc.Files) != 1 || doc.Files[0].Hunks[0].Lines[0].Text != "a" {
		t.Fatalf("CRLF 补丁解析异常：%+v", doc.Files)
	}
}

// ===== 路径闸门 =====

func TestStripPatchPath(t *testing.T) {
	cases := []struct {
		raw   string
		strip int
		want  string
		code  string
	}{
		{"a/x/y.txt", 1, "x/y.txt", ""},
		{"b/x/y.txt", 1, "x/y.txt", ""},
		{"x/y.txt", 0, "x/y.txt", ""},
		{"/etc/passwd", 0, "", patchErrPathDenied},
		{"..\\evil.txt", 0, "", patchErrPathDenied},
		{"C:/windows/x.txt", 0, "", patchErrPathDenied},
		{".GIT/config", 0, "", patchErrPathDenied},
		{".cadt/permissions.json", 0, "", patchErrPathDenied},
		{"x/trailing./y.txt", 0, "", patchErrPathDenied},
	}
	for _, c := range cases {
		got, err := stripPatchPath(c.raw, c.strip)
		if c.code != "" {
			if err == nil || err.Code != c.code {
				t.Fatalf("%s：期望错误 %s，实际 %v（%q）", c.raw, c.code, err, got)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s：意外报错 %v", c.raw, err)
		}
		if got != c.want {
			t.Fatalf("%s：得到 %q，期望 %q", c.raw, got, c.want)
		}
	}
}

func TestUnquoteGitPath(t *testing.T) {
	got := unquoteGitPath(`"a/\344\270\255\346\226\207.txt"`)
	if got != "a/中文.txt" {
		t.Fatalf("解码结果 = %q", got)
	}
}

// ===== 计划与匹配 =====

func TestPlanOK(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	f := fileStatusOf(plan, "x.txt")
	if f == nil || f.Status != "ok" {
		t.Fatalf("状态 = %+v", f)
	}
	if f.ResultText != "a\nB\nc\n" {
		t.Fatalf("结果 = %q", f.ResultText)
	}
	if f.Offset != 0 {
		t.Fatalf("位移 = %d", f.Offset)
	}
}

func TestPlanContextMismatch(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nXX\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	f := fileStatusOf(plan, "x.txt")
	if f.Status != "conflict" {
		t.Fatalf("状态 = %s，期望 conflict（%s）", f.Status, f.Reason)
	}
	if !strings.Contains(f.Reason, "上下文") {
		t.Fatalf("原因不够具体：%s", f.Reason)
	}
}

func TestPlanExactHeaderWins(t *testing.T) {
	root := t.TempDir()
	// 相同三行出现两次：@@ 行号是确定的，按头部精确应用（不算猜测）
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n---\na\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	f := fileStatusOf(plan, "x.txt")
	if f.Status != "ok" {
		t.Fatalf("按行号精确匹配应可应用，实际 %s（%s）", f.Status, f.Reason)
	}
	if f.ResultText != "a\nB\nc\n---\na\nb\nc\n" {
		t.Fatalf("结果 = %q", f.ResultText)
	}
}

func TestPlanAmbiguousOffsetRejected(t *testing.T) {
	root := t.TempDir()
	// 文件前面多了两行，靠上下文搜索会命中两处 → 必须拒绝而不是取第一个
	writePatchTestFile(t, root, "x.txt", "n1\nn2\na\nb\nc\n---\na\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{AllowOffset: true})
	f := fileStatusOf(plan, "x.txt")
	if f.Status != "conflict" || !strings.Contains(f.Reason, "不唯一") {
		t.Fatalf("位移不唯一应拒绝，实际 %s（%s）", f.Status, f.Reason)
	}
}

func TestPlanOffsetRequiresOptIn(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "NEW1\nNEW2\na\nb\nc\n")
	doc := mustParse(t, simplePatch("x.txt"))

	plan := mustPlan(t, doc, root, patchPlanOptions{})
	if f := fileStatusOf(plan, "x.txt"); f.Status != "conflict" {
		t.Fatalf("默认不应自动位移，实际 %s", f.Status)
	}
	plan = mustPlan(t, doc, root, patchPlanOptions{AllowOffset: true})
	f := fileStatusOf(plan, "x.txt")
	if f.Status != "ok" || f.Offset != 2 {
		t.Fatalf("开启位移后应命中 +2，实际 %s offset=%d", f.Status, f.Offset)
	}
}

func TestPlanDriftByBaseHash(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{
		BaseHashes: map[string]string{"x.txt": "deadbeef"},
	})
	f := fileStatusOf(plan, "x.txt")
	if f.Status != "blocked" || !strings.Contains(f.Reason, "生成后被修改") {
		t.Fatalf("应因基线不符被拒，实际 %s / %s", f.Status, f.Reason)
	}
}

func TestPlanAddAndDelete(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "gone.txt", "bye\n")
	add := "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n"
	del := "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
	plan := mustPlan(t, mustParse(t, add+"diff --git a/gone.txt b/gone.txt\n"+del), root, patchPlanOptions{})
	if f := fileStatusOf(plan, "new.txt"); f == nil || f.Status != "ok" || f.Kind != "add" {
		t.Fatalf("新增文件计划异常：%+v", f)
	}
	if f := fileStatusOf(plan, "gone.txt"); f == nil || f.Status != "ok" || f.Kind != "delete" {
		t.Fatalf("删除文件计划异常：%+v", f)
	}
}

func TestPlanDuplicatePathRejected(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n")
	text := simplePatch("x.txt") + simplePatch("x.txt")
	_, err := buildPatchPlan(mustParse(t, text), root, "id", "s", "", patchPlanOptions{})
	if err == nil || patchErrorOf(err).Code != patchErrPathDenied {
		t.Fatalf("重复路径应被拒，实际 %v", err)
	}
}

func TestPlanSuggestsBetterRoot(t *testing.T) {
	base := t.TempDir()
	current := filepath.Join(base, "workspace")
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatal(err)
	}
	patchDir := filepath.Join(base, "samples")
	demo := filepath.Join(patchDir, "demo")
	writePatchTestFile(t, demo, "src/config.js", "theme=light\n")
	writePatchTestFile(t, demo, "src/style.css", "a{}\n")
	text := "--- a/src/config.js\n+++ b/src/config.js\n@@ -1 +1 @@\n-theme=light\n+theme=dark\n" +
		"--- a/src/style.css\n+++ b/src/style.css\n@@ -1 +1 @@\n-a{}\n+b{}\n" +
		"--- /dev/null\n+++ b/src/banner.js\n@@ -0,0 +1 @@\n+export const banner = 1;\n"
	doc := mustParse(t, text)
	patchPath := filepath.Join(patchDir, "demo.patch")

	plan, err := buildPatchPlan(doc, current, "id", "示例", patchPath, patchPlanOptions{External: true})
	if err != nil {
		t.Fatal(err)
	}
	if plan.SuggestedRoot == "" {
		t.Fatal("当前根缺少目标文件，应给出目录建议")
	}
	if !strings.EqualFold(filepath.Clean(plan.SuggestedRoot), filepath.Clean(demo)) {
		t.Fatalf("建议目录 = %q，期望 %q", plan.SuggestedRoot, demo)
	}
	if plan.SuggestedHits != 2 || plan.SuggestedNeeded != 2 {
		t.Fatalf("命中统计 = %d/%d，期望 2/2（新建文件不计入分母）", plan.SuggestedHits, plan.SuggestedNeeded)
	}

	// 目标匹配时不再建议；本应用生成的补丁（External=false）也不建议
	plan, err = buildPatchPlan(doc, demo, "id", "示例", patchPath, patchPlanOptions{External: true})
	if err != nil {
		t.Fatal(err)
	}
	if plan.SuggestedRoot != "" {
		t.Fatalf("目标已匹配仍给出建议：%q", plan.SuggestedRoot)
	}
	plan, err = buildPatchPlan(doc, current, "id", "示例", patchPath, patchPlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.SuggestedRoot != "" {
		t.Fatalf("非外部补丁不应给出建议：%q", plan.SuggestedRoot)
	}
}

func TestPlanCRLFAndGBKPreserved(t *testing.T) {
	root := t.TempDir()
	abs := filepath.Join(root, "crlf.txt")
	if err := os.WriteFile(abs, []byte("a\r\nb\r\nc\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := mustPlan(t, mustParse(t, simplePatch("crlf.txt")), root, patchPlanOptions{})
	f := fileStatusOf(plan, "crlf.txt")
	if f.Status != "ok" {
		t.Fatalf("CRLF 文件应可应用，实际 %s（%s）", f.Status, f.Reason)
	}
	if !strings.Contains(f.ResultText, "\n") || strings.Contains(f.ResultText, "\r") {
		t.Fatalf("内存文本应统一为 LF：%q", f.ResultText)
	}

	// GBK：内容含中文，补丁只改 ASCII 行
	gbkRoot := t.TempDir()
	raw := []byte{'a', '\n', 'b', '\n', 0xD6, 0xD0, 0xCE, 0xC4, '\n'} // "a\nb\n中文\n" 的 GBK
	if err := os.WriteFile(filepath.Join(gbkRoot, "gbk.txt"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	patch := "--- a/gbk.txt\n+++ b/gbk.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n 中文\n"
	plan2 := mustPlan(t, mustParse(t, patch), gbkRoot, patchPlanOptions{})
	f2 := fileStatusOf(plan2, "gbk.txt")
	if f2.Status != "ok" {
		t.Fatalf("GBK 文件应可应用，实际 %s（%s）", f2.Status, f2.Reason)
	}
	if f2.Target.Enc != "gbk" {
		t.Fatalf("编码 = %s，期望 gbk", f2.Target.Enc)
	}
}

// ===== 应用 =====

func TestApplyAtomicSuccess(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	res, err := applyPatchPlan(plan, nil, nil, "atomic")
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Applied != 1 {
		t.Fatalf("结果异常：%+v", res)
	}
	if got := readPatchTestFile(t, root, "x.txt"); got != "a\nB\nc\n" {
		t.Fatalf("文件内容 = %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, ".cadt", "patches", "backup", plan.PatchID)); err != nil {
		t.Fatalf("备份目录缺失：%v", err)
	}
}

func TestApplyAtomicNoPartialWrite(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "ok.txt", "a\nb\nc\n")
	writePatchTestFile(t, root, "bad.txt", "a\nCHANGED\nc\n")
	text := simplePatch("ok.txt") + "diff --git a/bad.txt b/bad.txt\n" + simplePatch("bad.txt")
	plan := mustPlan(t, mustParse(t, text), root, patchPlanOptions{})
	res, err := applyPatchPlan(plan, nil, nil, "atomic")
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 0 || res.OK {
		t.Fatalf("atomic 应整体失败，实际 %+v", res)
	}
	if got := readPatchTestFile(t, root, "ok.txt"); got != "a\nb\nc\n" {
		t.Fatalf("atomic 失败后不应有文件被改，实际 %q", got)
	}
}

func TestApplyPartialSkipsConflict(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "ok.txt", "a\nb\nc\n")
	writePatchTestFile(t, root, "bad.txt", "a\nCHANGED\nc\n")
	text := simplePatch("ok.txt") + "diff --git a/bad.txt b/bad.txt\n" + simplePatch("bad.txt")
	plan := mustPlan(t, mustParse(t, text), root, patchPlanOptions{})
	res, err := applyPatchPlan(plan, nil, nil, "partial")
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || res.Skipped != 1 {
		t.Fatalf("partial 期望 1 应用 1 跳过，实际 %+v", res)
	}
	if got := readPatchTestFile(t, root, "ok.txt"); got != "a\nB\nc\n" {
		t.Fatalf("可应用文件未写入：%q", got)
	}
	if got := readPatchTestFile(t, root, "bad.txt"); got != "a\nCHANGED\nc\n" {
		t.Fatalf("冲突文件不应被改：%q", got)
	}
}

func TestApplyNoTrailingNewline(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb")
	patch := "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
	plan := mustPlan(t, mustParse(t, patch), root, patchPlanOptions{})
	if f := fileStatusOf(plan, "x.txt"); f.Status != "ok" {
		t.Fatalf("状态 = %s（%s）", f.Status, f.Reason)
	}
	if _, err := applyPatchPlan(plan, nil, nil, "atomic"); err != nil {
		t.Fatal(err)
	}
	if got := readPatchTestFile(t, root, "x.txt"); got != "a\nB" {
		t.Fatalf("末尾无换行未保持：%q", got)
	}
}

func TestApplyAddCreatesFile(t *testing.T) {
	root := t.TempDir()
	add := "--- /dev/null\n+++ b/sub/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n"
	plan := mustPlan(t, mustParse(t, add), root, patchPlanOptions{})
	res, _ := applyPatchPlan(plan, nil, nil, "atomic")
	if !res.OK {
		t.Fatalf("新增失败：%+v", res)
	}
	if got := readPatchTestFile(t, root, "sub/new.txt"); got != "hello\nworld\n" {
		t.Fatalf("新文件内容 = %q", got)
	}
}

func TestApplyDeleteMovesToRecycle(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "gone.txt", "bye\n")
	del := "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
	plan := mustPlan(t, mustParse(t, del), root, patchPlanOptions{})
	res, _ := applyPatchPlan(plan, nil, nil, "atomic")
	if !res.OK {
		t.Fatalf("删除失败：%+v", res)
	}
	if _, err := os.Stat(filepath.Join(root, "gone.txt")); !os.IsNotExist(err) {
		t.Fatal("文件应已被删除")
	}
}

// ===== 撤销 =====

func TestRevertRestoresBytes(t *testing.T) {
	root := t.TempDir()
	original := "a\r\nb\r\nc\r\n"
	writePatchTestFile(t, root, "x.txt", original)
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	if res, _ := applyPatchPlan(plan, nil, nil, "atomic"); !res.OK {
		t.Fatalf("应用失败：%+v", res)
	}
	if got := readPatchTestFile(t, root, "x.txt"); got != "a\r\nB\r\nc\r\n" {
		t.Fatalf("CRLF 未保持：%q", got)
	}
	rev, err := revertPatchByID(root, plan.PatchID, "abort")
	if err != nil {
		t.Fatal(err)
	}
	if !rev.OK {
		t.Fatalf("撤销失败：%+v", rev)
	}
	if got := readPatchTestFile(t, root, "x.txt"); got != original {
		t.Fatalf("撤销后内容 = %q，期望 %q", got, original)
	}
}

func TestRevertConflictWhenModifiedAfterApply(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	if res, _ := applyPatchPlan(plan, nil, nil, "atomic"); !res.OK {
		t.Fatalf("应用失败：%+v", res)
	}
	writePatchTestFile(t, root, "x.txt", "a\nB\nc\n手工又改了\n")
	rev, _ := revertPatchByID(root, plan.PatchID, "abort")
	if rev.OK || rev.Code != patchErrConcurrent {
		t.Fatalf("应因文件被再次修改而拒绝撤销，实际 %+v", rev)
	}
	rev2, _ := revertPatchByID(root, plan.PatchID, "stash")
	if !rev2.OK {
		t.Fatalf("stash 模式应可撤销：%+v", rev2)
	}
	if _, err := os.Stat(filepath.Join(root, "x.txt.revert-backup")); err != nil {
		t.Fatal("stash 应留下 .revert-backup")
	}
}

// ===== 索引 =====

func TestPatchIndexRecordsApplied(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "x.txt", "a\nb\nc\n")
	plan := mustPlan(t, mustParse(t, simplePatch("x.txt")), root, patchPlanOptions{})
	if res, _ := applyPatchPlan(plan, nil, nil, "atomic"); !res.OK {
		t.Fatalf("应用失败：%+v", res)
	}
	list := collectPatchMetas(patchStoreRoot(root))
	if len(list) == 0 || list[0].Status != "applied" {
		t.Fatalf("索引未记录 applied：%+v", list)
	}
}

// ===== 命名 =====

func TestSlugifyPatchSummary(t *testing.T) {
	cases := map[string]string{
		"AI 写入状态徽标":         "AI-写入状态徽标",
		"":                  "patch",
		`a/b:c*d?e"f<g>h|i`: "abcdefghi",
		"CON":               "CON-patch",
	}
	for in, want := range cases {
		if got := slugifyPatchSummary(in); got != want {
			t.Fatalf("%q → %q，期望 %q", in, got, want)
		}
	}
}
