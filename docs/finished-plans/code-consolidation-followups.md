# 代码收敛跟进项（已实施部分归档）：#3 显示在文件管理器 + 附录顺手项

> 来源：2026-11-23 一次全面代码审查（「通用能力埋在具体模块 / 重复造轮子」）。本文件只归档**已实施**的两部分：#3（`ShowInFolder` 下沉 `internal/shellexec`）与附录「顺手做」项。
> 尚未完成的 **#4（弹层外点关闭 / 锚点定位剩余站点迁移）** 与复查遗漏的 `clampInt` / `clampText` 收归仍留在 `docs/unfinished-plans/code-consolidation-followups.md`，未随本文件归档。
> 同一轮审查里风险低、可直接改的 #1（escapeHtml）、#2（formatBytes / relativeTime）当时已直接实施，不在此列。

---

## #3 `ShowInFolder` 手写 `explorer.exe`，绕开 `executil` 且非跨平台

> **状态：已实施（2026-11-23）。** `internal/shellexec` 新增 `RevealInFolder`（windows 走 `explorer.exe` + `executil.HideCommandWindow`，other 桩报错）；根壳 `ShowInFolder` 只留校验后转发，`explorerArgs` 删除；测试迁到 `internal/shellexec/shellexec_test.go`（`//go:build windows`）；`crossplatform_guard_test.go` 增加「`"explorer.exe"` 只许在 Windows 文件」规则。验证：`go build ./...`、`go test`、`tools/check-crossbuild.ps1`（linux/darwin 三目标）全通过。以下保留原始现状与方案记录。

### 现状（实施前）

- `app_window.go:164` 直接 `exec.Command("explorer.exe", explorerArgs(path, info.IsDir())...)`。
- 全仓其余 25 处 `exec.Command` 均走 `executil.HideCommandWindow`，只此一处裸写（与 AGENTS.md「防黑窗统一用 `executil.HideCommandWindow`」不一致）。
- `internal/` 内没有任何 `explorer.exe` 字面量——这是唯一一处。
- `app_window.go` 无 build tag；`crossplatform_guard_test.go` 的 `windowsOnlyAPI` 正则只扫 `SysProcAttr` / `syscall.UTF16*` / `x/sys/windows`，**扫不到 `"explorer.exe"` 字符串**，所以真编 linux/darwin 时会编译通过、运行期失败。
- 配套纯函数 `explorerArgs`（`app_window.go:189`）有踩坑注释：路径须先 `filepath.Clean` 成 Windows 原生分隔符，否则 `explorer.exe` 把 `/` 开头的段当开关，静默回退打开「文档」文件夹。测试 `app_test.go:597 TestExplorerArgsUseNativePath` 钉住这个行为。

### 目标

把「在系统文件管理器里显示/打开」下沉到已成对的平台 glue 包 `internal/shellexec`（`shellexec_windows.go` + `shellexec_other.go`），根壳只保留 Wails 绑定方法做转发。

### 方案（已实施）

1. `internal/shellexec` 新增 `RevealInFolder(path string, isDir bool) error`：
   - `shellexec_windows.go`：内部 `exec.Command("explorer.exe", revealArgs(path, isDir)...)`，自行 `executil.HideCommandWindow`；`revealArgs` 就是把现有 `explorerArgs` 连注释一起搬过来。
   - `shellexec_other.go`：`return errors.New("当前平台不支持在文件管理器中显示")`（与 `Open` 的桩一致）。
2. `app_window.go` 的 `ShowInFolder` 改为：路径存在性校验（`os.Stat`）留在根壳（错误文案属绑定层职责），之后 `return shellexec.RevealInFolder(filepath.Clean(path), info.IsDir())`；删掉 `explorerArgs`。
3. 测试搬迁：`app_test.go:597 TestExplorerArgsUseNativePath` → `internal/shellexec/shellexec_test.go`，改为测 `revealArgs`（导出或同包测试）。
4. 顺手补一道护栏：`crossplatform_guard_test.go` 的 `windowsOnlyAPI` 增加一条「`"explorer.exe"` / `"explorer"` 字面量只许出现在 `_windows.go`」的规则，防止以后在平台无关文件里再手写。

> 实施修正：文档原方案要求 windows 实现自行调 `executil.HideCommandWindow`，实际落地时刻意不调用（见 `CHANGELOG.md:364` 的后续修正记录）。

### 验证

- 风险：`--convert --out` 之类不受影响；仅 `ShowInFolder` 一处。`atomfile` 无关。
- 已执行：`go build ./...`；`tools\check-crossbuild.cmd`（真编 linux/darwin，确认桩可编译）；`go test ./internal/shellexec/ ./`。

---

## 附：本轮审查里「低优先级、顺手做」的项（已实施）

`el()` DOM 工厂 ~14 份、`newId()` 7 份、`JSON.parse` 安全封装 20+ 处、localStorage 读写封装 14 处、文本剪贴板 3 份、Go `os.WriteFile` 绕开原子写、Go「无法定位应用数据目录」文案 13 文件——这些量大但每处独立、语义各有细微差异，建议触碰相关模块时顺手迁移，不专门开任务。

> **状态（2026-11-23）**：以上各项已由一个独立会话全部实施（`core/dom.js`、`core/id.js`、`core/json-safe.js`、`core/kv-store.js`、`core/clipboard.js` + Go 原子写 / `appdata.ErrNoRoot`），验证通过并已记入 CHANGELOG。
