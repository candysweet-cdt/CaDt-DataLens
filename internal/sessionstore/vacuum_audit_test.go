package sessionstore

// vacuum_audit_test.go：审计事件（turn / tool / approval / agent）在整理后必须原样保留。
//
// 背景：vacuum 的 switch 对未知事件类型走 default → 计 issue，且主文件是「先算 live/archived
// 再按行号抄回」的重写，未登记的类型**不会**被抄回去——等于整理一次就把审计记录抹平，而且
// 只在「整理后重读」时才发现，用户很难把两件事联系起来。这条测试钉住四类事件的存活。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVacuumKeepsAuditEvents(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(store.Root, "audit-session")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"v":1,"t":"header","id":"s1","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"turn","id":"s1#1","phase":"start"}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"hi"}}`,
		`{"v":1,"t":"tool","id":"c1","phase":"start","name":"read_file"}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"assistant","content":"ok"}}`,
		`{"v":1,"t":"approval","id":"c1","verdict":"allow"}`,
		`{"v":1,"t":"agent","id":"a1","phase":"spawn"}`,
		`{"v":1,"t":"turn","id":"s1#1","phase":"close","reason":"done"}`,
		// 一条已归档消息：让 vacuum 真的有活要干（纯审计事件不会触发重写，
		// 那就测不到「重写时会不会把它们丢掉」这件事）。
		`{"v":1,"t":"msg","mid":"m0","a":1,"m":{"role":"user","content":"old"}}`,
	}
	logPath := filepath.Join(dir, aiSessionLogName)
	if err := os.WriteFile(logPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := store.Vacuum("audit-session", true)
	if err != nil {
		t.Fatalf("整理失败: %v", err)
	}
	if !result.Changed {
		t.Fatalf("force vacuum 应重写主文件：%+v", result)
	}

	rewritten, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(rewritten)
	for _, want := range []string{
		`"t":"turn"`, `"t":"tool"`, `"t":"approval"`, `"t":"agent"`,
		`"id":"s1#1","phase":"start"`, `"phase":"close","reason":"done"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("整理后主文件丢失审计事件片段 %s\n完整内容：\n%s", want, text)
		}
	}
	// 顺序在审计事件之间必须保持（start 在 close 前）——按 extLines 追加序写出。
	if strings.Index(text, `"phase":"start"`) > strings.Index(text, `"phase":"close"`) {
		t.Fatalf("审计事件顺序被打乱：\n%s", text)
	}

	// 重读主文件：审计行不应再被算成坏行 / 未知事件。
	plan, err := buildVacuumPlan(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if plan.issues != 0 {
		t.Fatalf("审计事件被计成 issue=%d（应被识别为已知类型）", plan.issues)
	}
	if len(plan.live) != 2 {
		t.Fatalf("live 消息数 = %d，want 2", len(plan.live))
	}
	if len(plan.extLines) != 5 {
		t.Fatalf("保留的审计事件数 = %d，want 5（turn×2 + tool + approval + agent）\n完整内容：\n%s", len(plan.extLines), text)
	}
}

// 形状不合规（缺 id）仍按坏行处理——与前端 replaySessionLog 的口径一致。
func TestVacuumRejectsAuditEventWithoutId(t *testing.T) {
	store := &Store{Root: t.TempDir()}
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(store.Root, "bad-audit")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"v":1,"t":"header","id":"s1","title":"t","createdAt":1,"workspace":""}`,
		`{"v":1,"t":"tool","phase":"start"}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"hi"}}`,
	}
	logPath := filepath.Join(dir, aiSessionLogName)
	if err := os.WriteFile(logPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := buildVacuumPlan(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if plan.issues != 1 {
		t.Fatalf("缺 id 的审计事件应计 1 条 issue，得到 %d", plan.issues)
	}
	if len(plan.extLines) != 0 {
		t.Fatalf("缺 id 的审计事件不应被保留：%d 条", len(plan.extLines))
	}
}
