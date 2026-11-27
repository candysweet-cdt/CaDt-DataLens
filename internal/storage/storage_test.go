// storage_test.go：条目表与清除逻辑的表驱动测试。
//
// 全程在 t.TempDir() 里造目录，并把回收站动作换成「记一笔再删盘」，
// 所以既不会碰真机的应用数据目录，也不会把测试机的回收站写满。
package storage

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ===== 测试环境与工具 =====
type testEnv struct {
	service  *Service
	appRoot  string
	scratch  string
	webview  string
	browser  string
	recycled []string
	blocked  map[string]bool
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	env := &testEnv{
		appRoot: filepath.Join(t.TempDir(), "CandySweet", "CaDt-DataLens"),
		scratch: filepath.Join(t.TempDir(), "temp"),
		blocked: map[string]bool{},
	}
	env.webview = filepath.Join(env.appRoot, "WebView2")
	env.browser = filepath.Join(env.appRoot, "BrowserSessions")
	if err := os.MkdirAll(env.appRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(env.scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	env.service = env.newService(true)
	return env
}

// newService 用同一套位置再建一个服务；withRecycleBin 关掉时模拟「平台没有回收站」。
func (e *testEnv) newService(withRecycleBin bool) *Service {
	deps := Deps{
		Location: func(name string) string {
			switch name {
			case LocAppRoot:
				return e.appRoot
			case LocScratchDir:
				return e.scratch
			case LocWebview:
				return e.webview
			case LocBrowserProfiles:
				return e.browser
			case LocRunTemp:
				return filepath.Join(e.appRoot, "run")
			case LocAppLogs:
				return filepath.Join(e.appRoot, "logs")
			case LocDebugConsole:
				return filepath.Join(e.appRoot, "debug-console.jsonl")
			case LocSessionIndex:
				return filepath.Join(e.appRoot, "ai-index.db")
			case LocScheduleDB:
				return filepath.Join(e.appRoot, "ai-schedule.db")
			case LocUsageStats:
				return filepath.Join(e.appRoot, "ai-usage.db")
			case LocModelCatalog:
				return filepath.Join(e.appRoot, "model-catalog.json")
			case LocActivity:
				return filepath.Join(e.appRoot, "activity")
			case LocAISessions:
				return filepath.Join(e.appRoot, "ai-sessions")
			case LocAIGroups:
				return filepath.Join(e.appRoot, "ai-groups")
			case LocConfig:
				return filepath.Join(e.appRoot, "config.json")
			case LocAIConfig:
				return filepath.Join(e.appRoot, "ai-config.json")
			case LocMCPConfig:
				return filepath.Join(e.appRoot, "mcp.json")
			case LocEnvVars:
				return filepath.Join(e.appRoot, "env-vars.json")
			}
			return ""
		},
		ActiveBrowserProfiles: func() map[string]bool { return e.blocked },
		BeforeClear:           map[string]func(string) (func(), error){},
	}
	if withRecycleBin {
		deps.RemoveToRecycleBin = func(path string) error {
			e.recycled = append(e.recycled, path)
			return os.RemoveAll(path)
		}
	}
	return New(deps)
}

func (e *testEnv) mustFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func itemByID(t *testing.T, report Report, id string) Item {
	t.Helper()
	for _, item := range report.Items {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("扫描结果里没有条目 %s", id)
	return Item{}
}

func tileByScope(t *testing.T, report Report, scope string) Tile {
	t.Helper()
	for _, tile := range report.Tiles {
		if tile.Scope == scope {
			return tile
		}
	}
	t.Fatalf("扫描结果里没有汇总格 %s", scope)
	return Tile{}
}

func resultByID(t *testing.T, report ClearReport, id string) ClearResult {
	t.Helper()
	for _, result := range report.Results {
		if result.ID == id {
			return result
		}
	}
	t.Fatalf("清除结果里没有条目 %s", id)
	return ClearResult{}
}

// ===== 缓存 ID 测试 =====
// TestSpecTable 卡住条目表本身的合法性：新增条目时这里先报错，好过界面上出怪行。
func TestSpecTable(t *testing.T) {
	svc := New(Deps{})
	specs := svc.specs()
	seen := map[string]bool{}
	for _, sp := range specs {
		t.Run(sp.id, func(t *testing.T) {
			if sp.id == "" || seen[sp.id] {
				t.Fatalf("条目 id 为空或重复：%q", sp.id)
			}
			seen[sp.id] = true
			if strings.TrimSpace(sp.label) == "" {
				t.Error("缺 label")
			}
			if strings.TrimSpace(sp.note) == "" {
				t.Error("缺 note（界面上必须写清删了会怎样）")
			}
			switch sp.kind {
			case KindCache, KindData, KindDanger:
			default:
				t.Errorf("kind 非法：%q", sp.kind)
			}
			switch sp.scope {
			case ScopeApp, ScopeWorkspace, ScopeTemp, ScopeWebview:
			default:
				t.Errorf("scope 非法：%q", sp.scope)
			}
			if len(sp.targets) == 0 {
				t.Error("没有目标路径")
			}
			for _, target := range sp.targets {
				if target.path == nil {
					t.Error("目标的 path 函数为空")
				}
			}
			// 一键清除的范围只能是缓存：数据与危险项必须留在勾选表里
			if sp.inCache && sp.kind != KindCache {
				t.Errorf("inCache 只能标在缓存条目上，当前 kind=%q", sp.kind)
			}
		})
	}
}

// TestCacheIDs 是「清除缓存」按钮的范围快照：新增缓存项要有意识地登记进来，
// 而不是让按钮悄悄漏掉它。
func TestCacheIDs(t *testing.T) {
	want := []string{
		"run-temp", "browser-profiles", "webview-cache", "session-index", "app-logs",
		"debug-console", "ai-logs", "model-catalog", "builtin-skills", "builtin-mcp-samples", "temp-scratch", "ws-worklog", "ws-tmp",
		// 工具结果落盘区：删了不丢正式内容（会话正文仍在 ai-sessions），只是上下文里的
		// 「全文在 xxx」指针失效、需要时由 AI 重新调工具取。
		"ai-artifacts",
	}
	got := New(Deps{}).CacheIDs()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("一键清缓存的范围变了\n 期望：%v\n 实际：%v", want, got)
	}
}

// TestWorkspaceCacheIDs 崩溃自愈的工作区段快照：等 WindowRegister 登记根目录后清理的
// 就是这批 id（必须全部属于一键清缓存范围，缓存直删即可）。
func TestWorkspaceCacheIDs(t *testing.T) {
	want := []string{"ws-worklog", "ws-tmp"}
	got := New(Deps{}).WorkspaceCacheIDs()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("工作区段缓存条目变了\n 期望：%v\n 实际：%v", want, got)
	}
	for _, id := range got {
		if !containsID(New(Deps{}).CacheIDs(), id) {
			t.Errorf("%s 应同时属于一键清缓存范围", id)
		}
	}
}

// TestMustNotBeCached 把最不能误删的东西钉死在勾选表里。
func TestMustNotBeCached(t *testing.T) {
	for _, id := range []string{
		"ai-sessions", "ai-usage", "ai-memory", "ai-schedule", "activity", "classifier",
		"ws-memory", "ws-patches", "ws-plan", "ws-gen", "ws-answers", "ui-state", "app-config",
		// 临时文件是用户亲手写的内容：一键清缓存不许碰，只能按勾选单条清（送回收站）
		"ws-scratch",
		// 认知索引可重建但重建成本高（重读整仓）：不进一键清缓存，只按勾选清（方案 §6 负向断言）
		"ws-cognition",
		// wipe-guard 是破坏防护的备份库：例行清缓存拆掉保险 = 没有防护（方案 §4.3 的负向断言）
		"wipe-guard",
	} {
		if containsID(New(Deps{}).CacheIDs(), id) {
			t.Errorf("%s 绝不能进「清除缓存」一键范围", id)
		}
	}
}

// ===== 路径测量与白名单测试 =====
func TestMeasurePath(t *testing.T) {
	env := newTestEnv(t)
	dir := filepath.Join(env.appRoot, "tree")
	env.mustFile(t, filepath.Join(dir, "a.txt"), 300)
	env.mustFile(t, filepath.Join(dir, "nested", "b.txt"), 700)
	root := filepath.Join(env.appRoot, "file.bin")
	env.mustFile(t, root, 42)

	tests := []struct {
		name       string
		path       string
		budget     int
		wantBytes  int64
		wantFiles  int
		wantApprox bool
	}{
		{name: "单文件", path: root, budget: 10, wantBytes: 42, wantFiles: 1},
		{name: "整棵树", path: dir, budget: 10, wantBytes: 1000, wantFiles: 2},
		{name: "预算只够一个文件", path: dir, budget: 1, wantBytes: 300, wantFiles: 1, wantApprox: true},
		{name: "不存在", path: filepath.Join(env.appRoot, "missing"), budget: 10},
		{name: "空路径", path: "", budget: 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			budget := tt.budget
			got := measurePath(tt.path, &budget)
			if got.bytes != tt.wantBytes || got.files != tt.wantFiles || got.approx != tt.wantApprox {
				t.Fatalf("got %+v want bytes=%d files=%d approx=%v", got, tt.wantBytes, tt.wantFiles, tt.wantApprox)
			}
		})
	}
}

// TestTargetFilesWhitelist：只动本应用自己的东西，别人的同名目录一个都不碰。
func TestTargetFilesWhitelist(t *testing.T) {
	env := newTestEnv(t)
	for _, name := range []string{"browser-a", "browser-b", "not-mine", "readme.txt"} {
		if err := os.MkdirAll(filepath.Join(env.browser, name), 0o755); err != nil {
			t.Fatal(err)
		}
		env.mustFile(t, filepath.Join(env.browser, name, "x.bin"), 10)
	}
	env.mustFile(t, filepath.Join(env.scratch, "cadt-sql-1.db"), 5)
	env.mustFile(t, filepath.Join(env.scratch, "cadt-plugin-x", "y.txt"), 5)
	env.mustFile(t, filepath.Join(env.scratch, "cadt-screenshot.png"), 5)
	env.mustFile(t, filepath.Join(env.scratch, "someone-else.db"), 5)
	env.mustFile(t, filepath.Join(env.appRoot, "ai-index.db"), 5)
	env.mustFile(t, filepath.Join(env.appRoot, "ai-index.db-wal"), 5)
	env.mustFile(t, filepath.Join(env.appRoot, "ai-index.db-shm"), 5)

	browserTarget, _ := targetOf(t, env.service, "browser-profiles")
	env.blocked["browser-b"] = true
	got := namesOf(env.service.targetFiles(browserTarget, env.browser))
	if strings.Join(got, ",") != "browser-a" {
		t.Fatalf("浏览器条目应只留 browser-a（browser-b 在用、其余不归我们），实际 %v", got)
	}

	tempTarget, _ := targetOf(t, env.service, "temp-scratch")
	got = namesOf(env.service.targetFiles(tempTarget, env.scratch))
	if strings.Join(got, ",") != "cadt-plugin-x,cadt-sql-1.db" {
		t.Fatalf("临时目录条目应按前缀命中两项，实际 %v", got)
	}

	indexTarget, _ := targetOf(t, env.service, "session-index")
	got = namesOf(env.service.targetFiles(indexTarget, env.appRoot))
	if strings.Join(got, ",") != "ai-index.db,ai-index.db-wal,ai-index.db-shm" {
		t.Fatalf("SQLite 条目要带上 -wal / -shm，实际 %v", got)
	}
}

// TestTargetFilesWithoutWorkspace：未打开工作区时，工作区条目既不统计也不删。
func TestTargetFilesWithoutWorkspace(t *testing.T) {
	env := newTestEnv(t)
	target, sp := targetOf(t, env.service, "ws-gen")
	if got := target.resolve(env.service, ""); got != "" {
		t.Fatalf("工作区条目在未打开工作区时应解析为空，实际 %q", got)
	}
	if files := env.service.targetFiles(target, ""); len(files) != 0 {
		t.Fatalf("未打开工作区不该有任何路径，实际 %v", files)
	}
	_ = sp
}

// ===== 扫描与大小测试 =====
func TestScanReportsSizesAndLeftover(t *testing.T) {
	env := newTestEnv(t)
	env.mustFile(t, filepath.Join(env.browser, "browser-a", "big.bin"), 4000)
	env.mustFile(t, filepath.Join(env.browser, "browser-b", "small.bin"), 100)
	env.mustFile(t, filepath.Join(env.appRoot, "plugins", "other", "thing.js"), 900)
	env.blocked["browser-b"] = true

	report := env.service.Scan("")
	browser := itemByID(t, report, "browser-profiles")
	if browser.Bytes != 4000 || browser.Entries != 1 || browser.Blocked != 1 || !browser.Exists {
		t.Fatalf("浏览器条目统计不对：%+v", browser)
	}
	app := tileByScope(t, report, ScopeApp)
	if app.Bytes != 4000 {
		t.Errorf("应用数据格：条目之和应为 4000，实际 %d", app.Bytes)
	}
	if app.OtherBytes != 900 || app.OtherFiles != 1 {
		t.Errorf("plugins/ 没被任何条目覆盖，应记进「其他」：got %d 字节 / %d 个文件", app.OtherBytes, app.OtherFiles)
	}
	if report.CacheBytes != 4000 || report.DataBytes != 0 {
		t.Errorf("缓存/数据合计不对：cache=%d data=%d", report.CacheBytes, report.DataBytes)
	}
	if report.WorkspaceSet {
		t.Error("未传工作区时 WorkspaceSet 应为 false")
	}
	workspaceItem := itemByID(t, report, "ws-gen")
	if workspaceItem.Exists || workspaceItem.Path != "" {
		t.Errorf("未打开工作区时工作区条目应整行空着：%+v", workspaceItem)
	}
}

func TestScanWorkspaceSizes(t *testing.T) {
	env := newTestEnv(t)
	ws := filepath.Join(env.appRoot, "workspace")
	env.mustFile(t, filepath.Join(ws, ".cadt", "gen", "a.png"), 1234)
	env.mustFile(t, filepath.Join(ws, ".cadt", "config", "git-commit-style.json"), 66)

	report := env.service.Scan(ws)
	gen := itemByID(t, report, "ws-gen")
	if gen.Bytes != 1234 || !gen.Exists || !strings.HasSuffix(gen.Path, filepath.Join(".cadt", "gen")) {
		t.Fatalf("工作区产物条目不对：%+v", gen)
	}
	tile := tileByScope(t, report, ScopeWorkspace)
	if tile.Bytes != 1234 {
		t.Errorf("工作区格条目之和应为 1234，实际 %d", tile.Bytes)
	}
	if tile.OtherBytes != 66 {
		t.Errorf(".cadt 根下的散文件应记进「其他」，实际 %d", tile.OtherBytes)
	}
	if report.DataBytes != 1234 {
		t.Errorf("生图产物属数据段，dataBytes 应为 1234，实际 %d", report.DataBytes)
	}
}

// ===== 清理缓存与数据测试 =====
func TestClearCacheKeepsForeignFiles(t *testing.T) {
	env := newTestEnv(t)
	env.mustFile(t, filepath.Join(env.browser, "browser-a", "big.bin"), 4000)
	env.mustFile(t, filepath.Join(env.browser, "keep-me", "important.bin"), 7)
	env.blocked["browser-a"] = true

	report := env.service.Clear([]string{"browser-profiles"}, "")
	result := resultByID(t, report, "browser-profiles")
	if result.Freed != 0 || result.Entries != 0 || result.Blocked != 1 {
		t.Fatalf("唯一在册实例正在使用，本轮应一个都不删：%+v", result)
	}
	if _, err := os.Stat(filepath.Join(env.browser, "browser-a")); err != nil {
		t.Fatalf("在用实例的配置目录被删了：%v", err)
	}

	env.blocked = map[string]bool{}
	report = env.service.Clear([]string{"browser-profiles"}, "")
	result = resultByID(t, report, "browser-profiles")
	if result.Freed != 4000 || result.Entries != 1 {
		t.Fatalf("解除占用后应清掉 browser-a：%+v", result)
	}
	if _, err := os.Stat(filepath.Join(env.browser, "keep-me", "important.bin")); err != nil {
		t.Fatalf("非本应用前缀的目录被动了：%v", err)
	}
	if len(env.recycled) != 0 {
		t.Fatalf("缓存条目要直删，不该走回收站：%v", env.recycled)
	}
}

func TestClearDataGoesToRecycleBin(t *testing.T) {
	env := newTestEnv(t)
	ws := filepath.Join(env.appRoot, "workspace")
	genDir := filepath.Join(ws, ".cadt", "gen")
	env.mustFile(t, filepath.Join(genDir, "a.png"), 100)

	report := env.service.Clear([]string{"ws-gen"}, ws)
	result := resultByID(t, report, "ws-gen")
	if result.Freed != 100 || result.Scheduled || result.Reason != "" {
		t.Fatalf("清除结果不对：%+v", result)
	}
	if len(env.recycled) != 1 || env.recycled[0] != genDir {
		t.Fatalf("数据条目必须走回收站，实际记了 %v", env.recycled)
	}
	if _, err := os.Stat(genDir); !os.IsNotExist(err) {
		t.Fatal("回收后目录应已从磁盘消失")
	}
}

// TestClearDataWithoutRecycleBinRefuses：宁可不动，也不能把「送回收站」悄悄降级成真删。
func TestClearDataWithoutRecycleBinRefuses(t *testing.T) {
	env := newTestEnv(t)
	ws := filepath.Join(env.appRoot, "workspace")
	env.mustFile(t, filepath.Join(ws, ".cadt", "answers", "a.html"), 10)
	strict := env.newService(false)

	report := strict.Clear([]string{"ws-answers"}, ws)
	result := resultByID(t, report, "ws-answers")
	if result.Freed != 0 || result.Remaining != 1 || result.Reason == "" {
		t.Fatalf("没有回收站时应拒绝并给出原因：%+v", result)
	}
	if _, err := os.Stat(filepath.Join(ws, ".cadt", "answers", "a.html")); err != nil {
		t.Fatalf("内容被误删：%v", err)
	}
}

func TestClearWebviewSchedulesUntilNextStart(t *testing.T) {
	env := newTestEnv(t)
	env.mustFile(t, filepath.Join(env.webview, "EBWebView", "Default", "Code Cache", "blob"), 5000)
	env.mustFile(t, filepath.Join(env.webview, "EBWebView", "Default", "Local Storage", "data"), 11)

	report := env.service.Clear([]string{"webview-cache"}, "")
	result := resultByID(t, report, "webview-cache")
	if !result.Scheduled || result.Freed != 0 {
		t.Fatalf("WebView2 缓存只应排到下次启动：%+v", result)
	}
	if _, err := os.Stat(filepath.Join(env.webview, "EBWebView", "Default", "Code Cache", "blob")); err != nil {
		t.Fatalf("运行中不该动手：%v", err)
	}
	if got := env.service.PendingIDs(); strings.Join(got, ",") != "webview-cache" {
		t.Fatalf("待清理标记没写上：%v", got)
	}
	scan := env.service.Scan("")
	if item := itemByID(t, scan, "webview-cache"); !item.Pending {
		t.Error("扫描结果要把待清理状态报给界面")
	}
	// 待清理标记不能被「其他」容量算进去（那点字节用户既看不懂也清不掉）
	cache := itemByID(t, scan, "webview-cache")
	if cache.Bytes != 5000 {
		t.Fatalf("界面缓存条目只应统计白名单目录（Code Cache），实际 %d", cache.Bytes)
	}

	results := env.service.ApplyPending()
	if len(results) != 1 || results[0].Freed != 5000 || results[0].Remaining != 0 {
		t.Fatalf("启动前清理结果不对：%+v", results)
	}
	if _, err := os.Stat(filepath.Join(env.webview, "EBWebView", "Default", "Local Storage", "data")); err != nil {
		t.Fatalf("清理缓存不能碰 Local Storage：%v", err)
	}
	if got := env.service.PendingIDs(); len(got) != 0 {
		t.Fatalf("清理干净后标记应消失：%v", got)
	}
}

// ===== pending 标记测试 =====
// TestApplyPendingKeepsMarkerWhenStuck：还剩东西没删掉时标记要留着，
// 否则用户点过的清除会被下一次启动吞掉。
func TestApplyPendingKeepsMarkerWhenStuck(t *testing.T) {
	env := newTestEnv(t)
	strict := env.newService(false)
	if _, err := strict.markPending("ai-sessions"); err != nil {
		t.Fatal(err)
	}
	env.mustFile(t, filepath.Join(env.appRoot, "ai-sessions", "s1", "session.v1.jsonl"), 30)

	results := strict.ApplyPending()
	if len(results) != 1 || results[0].Remaining != 1 {
		t.Fatalf("没有回收站时数据条目删不掉，应记为剩余：%+v", results)
	}
	if got := strict.PendingIDs(); strings.Join(got, ",") != "ai-sessions" {
		t.Fatalf("标记要留着下次再试，实际 %v", got)
	}
}

// TestApplyPendingDropsUnknownID：条目改名或版本降级后的陈旧 id 直接丢弃，
// 不能让标记永远清不掉。
func TestApplyPendingDropsUnknownID(t *testing.T) {
	env := newTestEnv(t)
	if err := os.WriteFile(env.service.pendingPath(), []byte("no-such-item\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := env.service.readPending(); len(got) != 0 {
		t.Fatalf("未登记的 id 不该被读出来：%v", got)
	}
	env.service.ApplyPending()
	if _, err := os.Stat(env.service.pendingPath()); !os.IsNotExist(err) {
		t.Fatal("全是陈旧 id 时标记应被删掉")
	}
}

func TestClearRejectsUnknownID(t *testing.T) {
	env := newTestEnv(t)
	report := env.service.Clear([]string{"../etc", "no-such-item"}, "")
	if len(report.Failed) != 2 || report.Succeeded != 0 || report.Freed != 0 {
		t.Fatalf("表外 id 只能拒绝：%+v", report)
	}
	if len(report.Results) != 0 {
		t.Fatalf("表外 id 不该产生执行结果：%+v", report.Results)
	}
}

func TestWritePendingRejectsUnknownIDAndRoundTrips(t *testing.T) {
	env := newTestEnv(t)
	if err := env.service.writePending([]string{"ui-state", "bogus"}); err == nil {
		t.Fatal("未登记的 id 应被拒绝")
	}
	if _, err := env.service.markPending("ui-state", "webview-cache", "ui-state"); err != nil {
		t.Fatal(err)
	}
	got := env.service.PendingIDs()
	if strings.Join(got, ",") != "ui-state,webview-cache" {
		t.Fatalf("去重排序结果不对：%v", got)
	}
	if err := env.service.writePending(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(env.service.pendingPath()); !os.IsNotExist(err) {
		t.Fatal("清空列表应删掉标记文件，而不是留一个空文件")
	}
}

// ===== 位置与孤儿目标测试 =====
func TestLocationFromHostMissingMeansNoPath(t *testing.T) {
	// 宿主什么都给不出（应用数据目录定位失败）时，扫描要全空而不是去删相对路径
	report := New(Deps{}).Scan("")
	for _, item := range report.Items {
		if item.Path != "" || item.Exists || item.Bytes != 0 {
			t.Fatalf("没有位置来源时条目 %s 不该有路径：%+v", item.ID, item)
		}
	}
	for _, tile := range report.Tiles {
		if tile.Bytes != 0 || tile.Available {
			t.Fatalf("格子应全空：%+v", tile)
		}
	}
	if cleared := New(Deps{}).Clear(nil, ""); cleared.Succeeded != 0 || cleared.Freed != 0 {
		t.Fatalf("没有位置时清除应无事发生：%+v", cleared)
	}
}

// targetOf 从表里取出某个条目的第一个目标，供白名单测试直接验证解析结果。
func targetOf(t *testing.T, svc *Service, id string) (target, spec) {
	t.Helper()
	sp, ok := svc.specByID(id)
	if !ok {
		t.Fatalf("条目表里没有 %s", id)
	}
	return sp.targets[0], sp
}

func namesOf(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, filepath.Base(path))
	}
	return out
}

// 孤儿 worktree 清理：登记之外的可清，登记内的保留（大小写不敏感）；
// 宿主未注入登记钩子时一律不清（fail-safe——不能把活跃会话的草稿当孤儿删掉）。
func TestOrphanWorktreeTargets(t *testing.T) {
	root := t.TempDir()
	wt := filepath.Join(root, ".cadt", "worktree")
	// NTFS 大小写不敏感：active / ACTIVE 是同一个目录，用不同名造登记内外的对照
	for _, name := range []string{"orphan", "active", "ACTIVE-X"} {
		if err := os.MkdirAll(filepath.Join(wt, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	targetOfID := func(svc *Service) target {
		tgt, _ := targetOf(t, svc, "ws-worktrees")
		return tgt
	}

	// 未注入钩子：一个都不列
	if got := namesOf(New(Deps{}).targetFiles(targetOfID(New(Deps{})), root)); len(got) != 0 {
		t.Fatalf("未注入登记钩子应一个都不列，实际 %v", got)
	}
	// 注入钩子：登记内（active，大小写不敏感匹配）保留，其余全列
	keepDir := filepath.Join(wt, "active")
	svc := New(Deps{KeepWorktreeNames: func() []string {
		return []string{keepDir, filepath.Join(wt, "ACTIVE-X")}
	}})
	got := namesOf(svc.targetFiles(targetOfID(svc), root))
	if strings.Join(got, ",") != "orphan" {
		t.Fatalf("孤儿过滤不对，实际 %v", got)
	}
}

// ===== 忙碌与部分移除测试 =====
// 清理前门闩返回 busy 时，条目必须原样保留（正在被另一窗口使用）。
func TestClearBeforeClearBusySkips(t *testing.T) {
	env := newTestEnv(t)
	env.service.deps.BeforeClear["ai-sessions"] = func(string) (func(), error) {
		return nil, errors.New("session-busy: 会话正在另一窗口运行")
	}
	dir := filepath.Join(env.appRoot, "ai-sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.v1.jsonl"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	report := env.service.Clear([]string{"ai-sessions"}, "")
	res := resultByID(t, report, "ai-sessions")
	if !strings.Contains(res.Reason, "session-busy") {
		t.Fatalf("应返回 busy 原因：%+v", res)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("busy 时不应删除目录：%v", err)
	}
}

// 同一条目里删掉了一部分（Freed>0）但仍有残留时，必须算失败：
// 旧判定要求「Freed==0」，导致密钥文件残留也被报成"已清除"。
func TestClearPartiallyRemovedCountsAsFailed(t *testing.T) {
	cases := []struct {
		name string
		in   ClearResult
		// 期望
		failed, succeeded int
		freed             int64
	}{
		{
			name:      "删了一部分仍有残留",
			in:        ClearResult{ID: "app-config", Label: "应用配置", Freed: 40, Remaining: 1},
			failed:    1,
			succeeded: 0,
			freed:     40,
		},
		{
			name:      "全部删除",
			in:        ClearResult{ID: "app-logs", Label: "运行日志", Freed: 40},
			failed:    0,
			succeeded: 1,
			freed:     40,
		},
		{
			name:      "一个都没删掉",
			in:        ClearResult{ID: "app-config", Label: "应用配置", Remaining: 2},
			failed:    1,
			succeeded: 0,
		},
		{
			name:      "安排在下次启动",
			in:        ClearResult{ID: "webview-cache", Label: "界面浏览器缓存", Scheduled: true},
			failed:    0,
			succeeded: 0,
		},
	}
	for _, tc := range cases {
		report := ClearReport{}
		report.add(tc.in)
		if len(report.Failed) != tc.failed || report.Succeeded != tc.succeeded {
			t.Fatalf("%s：failed=%v succeeded=%d，期望 failed=%d succeeded=%d",
				tc.name, report.Failed, report.Succeeded, tc.failed, tc.succeeded)
		}
		if report.Freed != tc.freed {
			t.Fatalf("%s：freed=%d，期望 %d", tc.name, report.Freed, tc.freed)
		}
	}
}
