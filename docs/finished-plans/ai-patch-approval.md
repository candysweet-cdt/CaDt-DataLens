# .patch 补丁文件与「生成 → 审批 → 一键应用」闭环 实施方案

> 状态：**已实施（v1.1.0，2026-11-13）**；实现见 `patch*.go`、`frontend/src/patch-view.js`、`ai-panel.js` 的 `propose_patch` 与 `patch-workflow` 技能
> 范围：Go 内置 unified diff 解析/应用器；AI 工具 `propose_patch`；内置技能 `patch-workflow`；AI 面板补丁审批卡；`.patch` / `.diff` 升级为补丁视图
> 版本号：v1.0.0 → **v1.1.0**（实施后三处同步：`app.go:35`、`wails.json`、`build/windows` NSIS 脚本）
> 依赖：**0 新增依赖**。应用器用 Go 标准库手写，前端复用 `frontend/src/diff.js`（Myers）与 `renderDiffInto`
> 安全基调：**宁可拒绝，不可改错**。所有"尽力而为"的容错默认关闭，必须是用户显式打开的
> 失败基调：**失败是对话的一部分，不是对话的终点**。任何可预期失败都作为工具结果回给模型，附可执行的修复建议

## 1. 为什么要做

现在 AI 只有「直接写文件」一条路：`write_file` / `edit_file` 在用户点「应用」后立刻 `SaveFile`（`ai-panel.js:8250` `applyWorkspaceWrite`）。缺的是中间态——**一份可以先看、可以存档、可以给别人、可以撤销的补丁**。

真实举证：仓库里躺着一份 AI 生成的 `docs/unfinished-plans/ai-write-status.patch`（256 行，改了 4 个文件），现在执行：

```
$ git apply --check docs/unfinished-plans/ai-write-status.patch
error: patch failed: frontend/index.html:1889
error: patch failed: frontend/src/style.css:3469
error: patch failed: frontend/src/ai-panel.js:958
error: patch failed: frontend/src/main.js:2480
```

四个文件全部失配。它既没法在应用内应用，也没人知道它当初对应哪次改动、哪份基线——补丁会「腐烂」，而当前产品没有任何机制承接它。

另外 `.patch` / `.diff` 目前只是被归到纯文本（`formats.js:275`），Ace 高亮一下就算完，没有结构、没有操作。

还有一条现实需求：**补丁是要发给人的**。同事收到 `.patch`，不该被要求"先配个模型、开个会话、让 AI 帮你应用"——他双击打开就该能看、能预检、能应用；脚本里也该能 `--check-patch` / `--apply-patch --yes`。这也是为什么本方案把解析与应用全部放在 Go 侧，AI 只是众多调用方之一（§10）。

## 2. 目标与非目标

### 目标

1. AI 能生成标准 unified diff 并落盘为 `.patch` 文件（默认 `.cadt/patches/`）。
2. 用户在 AI 面板里审批：看摘要、看逐文件 diff、**勾选要应用的文件**、一键「应用」。
3. 应用前有预检（能否应用、哪几个 hunk 失配、目标文件是否已漂移），应用后**可一键撤销**；应用模式可选（整体成功 / 允许部分成功），失败与跳过都说清原因并给手动方案。
4. 打开任意 `.patch` / `.diff` 文件进入补丁视图：结构化文件卡 + hunk 高亮 + 应用/另存/撤销工具栏。
5. **失败可自愈**：补丁出问题时以工具结果的形式回到模型，附错误码、期望 vs 实际、最小修复动作，模型自己改；不中断对话。
6. **离开 AI 也能用**：别人发来的 `.patch` 双击打开即可预检与应用，命令行 `--check-patch` / `--apply-patch --yes` 同样可用；路径对不上（根不同、前缀层级不同、少中间目录）有确定的处理顺序，不靠猜（§10）。
7. 不破坏现有写审批语义（`Write(...)` 规则、写权限档、项目权限规则照旧生效）。

### 非目标（明确不做）

| 不做 | 理由 |
| --- | --- |
| 依赖 `git apply` 作为主链路 | 用户机器可能没装 git；且无法逐 hunk 勾选、无法给出统一的中文失败原因。git 只在诊断时提示 |
| 二进制补丁、`rename from/to`、mode/权限位变更 | Windows 上 mode 无意义；判为 `unsupported` 并在预览标红，不做静默忽略 |
| 三方合并（3-way merge） | 复杂度过高；改为「基线哈希不符 → 拒绝并提示重新生成」 |
| 补丁推送到远端 | 与产品定位无关；只提供「另存为」 |
| 改变 `write_file` 的默认行为 | 默认仍直接写入，仅提供可选开关（§8.2） |

## 3. 总体数据流

```
用户：「帮我把 AI 写入状态显示在状态栏，先给我 patch」
   │
   ├─ AI 先 skill_use patch-workflow（拿写法与自检清单），read_file 取真实原文
   │
   ├─ AI 调 propose_patch { patch, summary, apply }
   │      │
   │      ├─ 校验：大小/文件数/路径全在范围根内
   │      ├─ 失败 → 返回【patch:error】code=… + 期望/实际 + 修复动作（不中断，模型自己改）
   │      ├─ 落盘 .cadt/patches/<ts>-<slug>.patch + index.jsonl
   │      └─ Go ParsePatch + BuildMatchPlan → 预览（含每个 hunk 的实际落点）
   │
   ├─ AI 面板渲染审批卡（approval.kind = 'patch'）
   │      文件表（勾选）+ 折叠 diff + [应用选中] [应用全部] [打开补丁] [放弃]
   │
   └─ 用户点「应用」，带上 planId
          ├─ Go 用当前磁盘重建 MatchPlan，与预览那份逐条比对
          │      └─ 任一不一致 → 整体拒绝，并把原因回给模型（可自愈：重新生成）
          ├─ 两阶段：先全部预演 → 再按模式提交（整体成功 / 允许部分成功，§9.7）
          ├─ 反向校验：反向应用能否精确还原基线 → 失败即回滚（atomic 全回滚 / partial 单文件回滚）
          ├─ index 状态 applied / partial / failed / reverted
          └─ 通知前端：逐文件重载标签页、记 changes、写操作留痕
```

### 3.1 触发路径（入口一览）

**A. 对话内（P0）**

| # | 用户动作 | 内部链路 | 说明 |
| --- | --- | --- | --- |
| 1 | 说「先给我 patch / 别直接改 / 要能撤销 / 这改动要转给同事」 | 模型 → `skill_use patch-workflow` → `propose_patch` → 审批卡 | 主力路径；靠工具 description 与技能索引命中 |
| 2 | 输入 `/patch` 或 `/patch <需求>` | 斜杠命令注入提示词（同 `/init` 机制，`ai-panel.js:13215`）→ 模型走 `propose_patch` | 建议新增，成本极低；`/patch` 无参数 = 把本次回答的改动落成补丁 |
| 3 | 模型自行建议「要不要把这次改动存成补丁」 | 模型主动调 `propose_patch`，`apply:false` | 不落盘改文件，只产出 `.patch` |

**A2. diff 相关（用户要「出 diff」时，P0/P1）**

这里必须把「看 diff」和「存补丁」分开——用户要 diff 多数只是想看，**不能一开口就弹审批卡**。

| # | 用户动作 | 内部链路 | 批次 |
| --- | --- | --- | --- |
| 11 | 说「看看改了什么 / 出个 diff / 对比一下 / 差在哪」 | **只读展示**：`reviewChangesSummary`（`ai-panel.js:4431`）或 `GitDiffFor`（`main.js:20069`）→ 虚拟 diff 文档；不写文件、不弹审批 | 现有能力 |
| 12 | 展示后说「存成补丁 / 我要能应用 / 发给同事」 | 从 `session.lastDiff` 直接 `SavePatch` → 审批卡，**不需要模型复述 diff** | P0 |
| 13 | AI 回答里贴了 ```diff 代码块 | 代码块右上角加「存为补丁」（挂在 `enhanceAICodeBlocks`，`ai-panel.js:5461`，与现有「复制」按钮同一处） | P1 |
| 14 | 「本轮改动审阅」卡 → 「导出为补丁」 | 复用已收集的改动 → `GitDiffFor` / `unifiedDiff` → `.patch` | P1 |
| 15 | Git 差异视图 → 「另存为 .patch」 | `main.js:20069` 的虚拟文档加工具栏按钮 | P2 |
| 16 | 文件比较视图 → 「另存为 .patch」 | 复用 `main.js:16788` 已有的 `unifiedDiff(textA, textB)` 结果 | P2 |
| 17 | 输入 `/diff` | 展示当前改动 diff（只读）；`/patch` 才落盘 | P1 |

**`session.lastDiff`（P0，小机制但很关键）**：任何一次 diff 展示（审阅卡 / Git 差异 / 比较视图 / AI 消息里的 diff 块）都把结构化结果存进会话内存：

```js
{source: 'review' | 'git' | 'compare' | 'message', at, files: [{relPath, baseHash, diffText}]}
```

保留最近 3 条、单条 ≤512 KB，只存内存不落盘（重开会话不保留）。这样「把刚才那个 diff 存成补丁」是**前端直接把真实 diff 交给后端**，不是让模型重新手写行号——天然 100% 可应用，也省一轮 token。这是把模型从"算行号"这件事上彻底摘出去的唯一低成本做法。

### 3.2 diff 与 patch 的分流规则（写进技能与系统提示）

| 用户意图 | 正确动作 | 错误动作（要避免） |
| --- | --- | --- |
| 看改动、要 diff、要对比 | 展示只读 diff，末尾可问一句「要落成 .patch 吗」 | 直接调 `propose_patch` 弹审批卡 |
| 要补丁、要能应用、要转交 | 有 `lastDiff` 就从它生成；没有才让模型写 diff | 让用户自己 `git apply` |
| 只说「改掉」 | `edit_file` / `write_file` | 多绕一层补丁 |
| 说「先看，我再决定」 | 只读 diff，**不要**顺手写文件或建补丁 | 自作主张生成补丁 |
| **完全权限档 + 没提补丁**（§3.3） | 直接 `edit_file` / `write_file`，**不提补丁** | 弹审批卡、建议"要不要存成补丁" |

**B. 界面入口（P1/P2）**

| # | 入口 | 行为 | 批次 |
| --- | --- | --- | --- |
| 4 | 设置 → AI 助手 → 写操作方式 = `先生成补丁待审批` | 后续 `write_file` / `edit_file` 不再直接 `SaveFile`，改为现算 diff → 补丁 → 同一审批卡（§8.2） | P1 |
| 5 | 「本轮改动审阅」卡片 → 「导出为补丁」 | 复用 `reviewChangesSummary`（`ai-panel.js:4431`）已收集的改动，经 `GitDiffFor` 或 `unifiedDiff` 生成 `.patch` | P1 |
| 6 | 资源管理器右键 `.patch` → 「应用补丁」 | 打开补丁视图并预检 | P1 |
| 7 | 工具菜单 → 「应用补丁文件…」 | 文件选择器 → 补丁视图（外部补丁，需二次确认） | P1 |
| 8 | 双击 / 拖入 / 已打开的 `.patch`、`.diff` | 自动进补丁视图，工具栏「应用」 | P1 |
| 9 | 设置 → 最近补丁 | 查看历史、撤销、重新应用、删除 | P2 |
| 10 | 命令行 `CaDt-DataLens.exe x.patch` | 打开补丁视图（不自动应用） | P1 |
| 11 | 命令行 `--check-patch` / `--apply-patch --yes` / `--revert-patch --yes` | 无 UI 检查与应用（§10.7），**不依赖 AI** | P1 |

**C. 明确封死的路径**

| 不存在的入口 | 理由 |
| --- | --- |
| `auto` / `full` 档免确认直接应用 | 补丁是多文件批量写，误伤面大；§13 决策 2 |
| 子代理（`spawn_agent`）直接调 `ApplyPlan` | 子代理只读；补丁必须由主会话产出并交用户 |
| 定时任务 / 无人值守应用补丁 | 与"预览即契约"矛盾 |
| CLI 不带 `--yes` 就写入 | 默认只检查；`--yes` 是显式的应用授权（§10.7） |
| 补丁内容触发命令执行 | 补丁是纯文本，应用器只做文件读写 |

**D. 权限档与入口的关系**

| 档位 | AI 能否生成补丁 | 是否**主动**出补丁 | 用户能否应用已打开的 `.patch` |
| --- | --- | --- | --- |
| 只读 / plan | 否（工具不在列表，同 `write_file`） | — | **能**——应用是用户操作，等同手工改文件；仍受路径闸门与硬禁区约束 |
| edit（逐次询问） | 能（需点一次「应用」） | 可以 | 能 |
| auto（自动审批） | 能（需点一次「应用」） | 可以，但仅限「≥3 个文件 / 含删除」这类值得留档的改动 | 能 |
| **full（完全权限）** | 能（仍需点一次「应用」） | **不允许**，除非用户明确指定（§3.3） | 能 |

> 只读档也能应用别人给的 `.patch`，是有意保留的场景（同事发来补丁，用户自己决定要不要用）；但 AI 在只读档不能替他生成。

### 3.3 完全权限档：不主动出补丁

「完全权限」是用户明确表达「别问我，直接干」的档位。此时 AI 主动弹补丁审批卡，等于把已经关掉的确认又重新打开一遍——违背用户意图。规则：

- **默认走直写**：`write_file` / `edit_file`，不加中间层。
- **只有用户明确指定才出补丁**，判定信号（任一成立）：
  1. 用户本轮消息出现：`patch` / `补丁` / `.diff` / `diff 文件` / `别直接改` / `不要改文件` / `先给我看` / `我要能应用` / `要能撤销` / `转给同事`；
  2. 用户点了补丁类入口：审批卡「导出为补丁」、右键「应用补丁」、消息 diff 块的「存为补丁」、`/patch`；
  3. 设置里「写操作方式」被显式设为「先生成补丁待审批」（这是显式配置，**优先于档位**）。
- **软拦截而非硬失败**（可测、不误伤）：`scope === 'full'` 且 `session.explicitPatchRequest === false` 时，`propose_patch` **不执行**，返回 `PATCH_NOT_REQUESTED` 引导文本，让模型自己回头：

  > 当前是「完全权限」档，用户没有要求补丁。直接改文件请用 `edit_file` / `write_file`；确实需要补丁（例如要转交）时先问用户一句，再提交。

  这样既不弹卡、不写盘，也不中断对话，与 §5.5 的失败回传协议同一条路。
- 判定信号按**本轮**有效：新一条用户消息重置 `explicitPatchRequest`；档位切到 full 时清零。
- 用户明确要求之后仍然走完整审批（full 档也不例外，§13 决策 2）——「不主动」不等于「可跳过确认」。



## 4. Go 后端：`patch.go` / `patch_cli.go` + 测试（约 1,550 行）

### 4.1 数据模型

```go
type PatchHunk struct {
    OldStart, OldCount, NewStart, NewCount int
    Lines  []PatchLine   // ' ' 上下文 / '+' 新增 / '-' 删除 / '\' 无末尾换行标记
    NoEOL  bool
}

type PatchFile struct {
    OldPath, NewPath string   // 去掉 a/ b/ 前缀后的相对路径
    RelPath          string   // 归一化目标路径（删除时取 OldPath）
    Kind             string   // modify | add | delete | unsupported
    Hunks            []PatchHunk
    Added, Removed   int
    BaseHash         string   // 生成时原始内容 sha256（本应用生成才有）
    Status           string   // ok | conflict | missing | exists | unsupported | blocked
    Reason           string
}

// 预览时算定、应用时复核的「匹配方案」，是防误改的核心载体
type MatchPlan struct {
    PlanID    string
    PatchID   string
    Root      string
    CreatedAt int64
    Files     []PlannedFile
    Added, Removed int
    Applicable bool
}

type PlannedFile struct {
    RelPath    string
    Action     string   // write | create | delete | skip
    Status     string   // ok | conflict | blocked
    Reason     string
    BaseHash   string   // 预览时磁盘内容 sha256
    BaseMtime  int64
    BaseSize   int64
    Enc, EOL   string   // 写回时保持原编码/换行/BOM
    HasBOM     bool
    Offset     int      // 该文件统一的位移（行），非 0 时卡片明示
    Hunks      []PlannedHunk   // {Index, ApplyAtLine, Ok, Reason}
    ResultHash string   // 预期结果内容 sha256
    ResultText string   // 仅内存持有，不落盘、不进日志
}
```

### 4.2 解析器 `ParseUnifiedDiff`

| 语法 | 处理 |
| --- | --- |
| `--- a/x` / `+++ b/x` | 剥 `a/` `b/` 前缀（也接受 `-p0` 无反斜杠写法、`/dev/null`） |
| `diff --git a/x b/x` | 取路径，允许其后跟 `index` / `new file mode` / `deleted file mode` |
| `@@ -1,7 +1,9 @@` | 解析；兼容省略 count 的 `@@ -1 +1 @@` |
| `\ No newline at end of file` | 记录到前一行的 `NoEOL` 标记，写回时精确还原（`diff.js` 的 `unifiedDiff` 不产出此行，需补） |
| 前言（`From xxx Mon Sep`、`Subject:`） | 跳过直到第一个 `--- ` |
| `Binary files ... differ`、`GIT binary patch` | `unsupported`，不参与应用 |
| `rename from/to`、`old mode/new mode` | `unsupported`（P1），预览中明示 |

非法输入（hunk 行数与头不符、`@@` 缺失、行首未知字符）→ 返回带行号的结构化错误（§5.5）。

### 4.3 匹配与应用 `BuildMatchPlan` / `ApplyPlan`

严格匹配规则见 §9.3，这里只描述执行顺序：

1. **路径闸门**（§9.2）
2. **读取 + 解码**：复用 `app.go` 的 `OpenFile` 检测（编码 / EOL / BOM），内存里按 LF 归一后比对，写回时还原原编码原 EOL。GBK、CRLF、带 BOM 文件绝不能被补丁「洗」成 UTF-8 LF。
3. **hunk 定位**：精确行号 → 全文件统一 offset 搜索（0 或唯一解）→ 否则 conflict，附「期望上下文 / 实际读到的 3 行」。
4. **结果预演**：内存生成新文本，算 `ResultHash`，记录每个 hunk 的 `ApplyAtLine`（会展示给用户：「第 1889 行后插入 7 行」）。
5. **落盘：两阶段 + 模式可选**（§9.7）。先全部预演，再按 `mode` 提交：`atomic` 任一失败全回滚、磁盘零变更；`partial` 跳过失败文件、其余写入。两种模式下单个文件都不会半写。
6. **反向校验**（§9.4）。
7. **删除文件**：先备份，再移入回收站（复用 `delete_windows.go`），不直接 `os.Remove`。

逐 hunk 勾选不需要重新序列化补丁：应用器按 `hunks: {relPath: [0,2]}` 的索引跑选中的 hunk，未选中的 hunk 视作上下文。注意勾选子集会改变 `ResultHash`，所以 `ApplyPlan` 内部对「最终选中的 hunk 集合」重新预演一次，不复用全量结果。

> **勾选是"本次请求的范围"，不是"失败降级"**：你选了 3 个文件，就必须 3 个全成功；不许"成功的先留着、失败的跳过"。冲突文件默认不勾，就是为了让你在发起请求前划清范围，而不是让系统替你悄悄缩小范围。

### 4.4 导出方法（Wails 绑定，`frontend/wailsjs` 由 build 重新生成）

```go
func (a *App) SavePatch(summary, text string) (*PatchSaveResult, error)        // 落盘 + 索引 + 首次预览（返回 planId）
func (a *App) PreviewPatchFile(path string) (*MatchPlan, error)                // 打开外部 .patch
func (a *App) RepreviewPatch(planId string, files []string, hunks map[string][]int, ignoreWhitespace bool) (*MatchPlan, error)
func (a *App) ApplyPlan(planId string, files []string, hunks map[string][]int, mode string) (*PatchApplyResult, error)  // mode: atomic | partial
func (a *App) RevertPatch(patchID string, onConflict string) (*PatchRevertResult, error)  // abort | stash | force
func (a *App) RecoverInterrupted() (*PatchRecoveryInfo, error)                 // 启动检查未完成的 applying
func (a *App) ListPatches(limit int) ([]PatchMeta, error)
func (a *App) DeletePatch(id string) error
```

`ApplyPlan` **必须**带 `planId`：没预览过的补丁不允许应用（挡住"脚本化盲应用"）。`planId` 在内存 LRU 保留 30 分钟；过期返回「请重新预览」，绝不降级为「重算一遍然后照旧应用」。

`mode` 为空时按调用方默认值处理：`App` 方法（界面/备用）→ `atomic`；AI 审批卡在调用前显式传 `partial`（§9.7.1）。后端**不猜**：显式传，避免"哪个入口默认什么"散落在各处。

**分层要求**：上面每个 `App` 方法都只是薄包装，真正的实现在不依赖 `App` 的自由函数里（`patchParse` / `patchBuildPlan` / `patchApply` / `patchRevert`），签名只吃 `(root, patchText, options)`。理由有两条：CLI 模式（§10.7）没有 `App`/WebView；测试也不想为了跑一个用例去构造整个 App。

上述方法**全部返回 error，不 panic**；error 里带 `PatchCode`，由 `formatPatchError` 统一转成模型可读文本（§5.5）。

### 4.5 存储布局与默认路径

```
.cadt/patches/
  20261113-130500-ai-write-status.patch   # 标准 unified diff，UTF-8 LF，末尾保证换行
  index.jsonl                             # 追加式索引（同 activity.go 写法，含 WAL 记录）
  manifest/<id>.json                      # 每文件原 hash、mtime、编码、EOL
  backup/<id>/000-frontend-index.html     # 应用前原始字节（序号前缀避免重名/路径穿越）
  backup/<id>/applied/000-...             # 应用后快照，供「撤销的撤销」
```

#### 4.5.1 默认目录与回退

| 情况 | 落盘位置 |
| --- | --- |
| 有工作区范围（`getScopeRoot()` 非空） | `<工作区根>/.cadt/patches/` |
| 没有工作区（只开了单个文件、没开文件夹） | `%APPDATA%\CandySweet\CaDt-DataLens\patches\`（`appdata.go` 已有该目录） |
| 用户在审批卡点「另存为」 | 用户选的路径；该文件不再归本应用索引管理（按外部补丁对待），但**备份仍留在 `backup/<id>/`**，撤销照常可用 |
| 打开别人的 `.patch` | **原地读取，不复制**；应用时备份写入当前工作区的 `.cadt/patches/backup/<id>/`，无工作区则写应用数据目录 |

`.cadt/` 已在 `.gitignore`，补丁不会误提交；应用数据目录本就随应用走，不进任何仓库。

#### 4.5.2 文件命名规则

`<yyyyMMdd>-<HHmmss>-<slug>.patch`（本地时区），例如 `20261113-130500-ai写入状态徽标.patch`。

- **slug 来源**：`summary` 取前 40 字符；保留中英文与数字（NTFS 支持中文，不转拼音）；空白压成 `-`；剔除 Windows 非法字符 `\ / : * ? " < > |`、控制字符、结尾的 `.` 与空格；命中保留设备名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`）时追加 `-patch`；**为空则用 `patch`**。
- **冲突**：同名已存在则追加 `-2`、`-3`（不用随机串，便于人认）。
- **长度**：slug ≤ 40 字符，整个文件名 ≤ 80 字符，防 Windows 长路径。
- **不要用 `a/` `b/` 之类前缀**：文件名只表达"哪次改动"，路径信息在 diff 头里。

#### 4.5.3 id 与索引的关系

- `id = <yyyyMMdd-HHmmss>-<4 位短随机>`，**与文件名解耦**：用户把 `.patch` 改名或挪走，索引仍按 id 找得到备份，撤销不受影响。
- 索引字段：`{v:1, id, summary, fileName, createdAt, sessionId, files, added, removed, status, mode, appliedAt, revertedAt, planHash}`；`v` 用于将来迁移，`fileName` 仅展示，定位一律用 `id`。
- 索引里的文件路径找不到时标 `missing`（卡片显示「补丁文件已移动或删除」），备份与撤销依然可用。
- `index.jsonl` 追加超过 512 KB 时压缩重写一次（保留最近 50 条 + 所有未闭合的 `applying`）；**重写必须 temp + rename，且持有同一把工作区跨进程锁**（§9.8），否则两个窗口同时压缩会把索引写丢。
- 索引是"派生但有价值"的数据：损坏或丢失时，用 `manifest/<id>.json` 与 `backup/<id>/` 能重建已应用记录（至少能撤销）；这条要在 `RecoverInterrupted` 里实现。

#### 4.5.4 保留与清理

- 最多 50 份 / 30 天；备份总量上限 200 MB，超出按最旧先清。
- 清理一律进回收站（复用 `delete_windows.go`），不 `os.Remove`。
- **不提供"修改补丁目录"的设置**：路径固定才能保证索引与备份不走散；设置页只显示实际路径 + 「打开目录」按钮（P2）。

## 5. AI 工具 `propose_patch`

### 5.1 定义

```js
propose_patch: {
    name: 'propose_patch',
    description: '把一组改动写成标准 unified diff 补丁（.patch），交给用户审批后一键应用。适用于：用户要一份可存档/可转交的补丁、改动跨多个文件、需要先看后改。补丁会落盘到 <工作区>/.cadt/patches/（无工作区时落应用数据目录）并在对话里显示审批卡；即使「自动审批」档也需要用户点一次「应用」。路径相对工作区根，必须使用 --- a/<相对路径> / +++ b/<相对路径> 头，上下文 3 行。失败会返回【patch:error】错误码与修复建议，按建议修正后可重试，最多 3 次。写补丁前先 skill_use patch-workflow。',
    parameters: {
        type: 'object',
        properties: {
            patch:   {type: 'string', description: '完整 unified diff 文本，可含多个文件'},
            summary: {type: 'string', description: '一句话说明改什么（用于文件名与审批卡标题）'},
            apply:   {type: 'boolean', description: '是否在审批卡上提供应用按钮；false 表示只产出文件'},
        },
        required: ['patch', 'summary'],
    },
}
```

### 5.2 接入点

| 位置 | 改动 |
| --- | --- |
| `AI_BUILTIN_SKILLS`（`ai-panel.js:147` 起） | 新增技能 `patch-workflow`（§6） |
| `toolsForScope`（`ai-panel.js:7057`） | 与 `write_file` 同档：`AI_WRITE_SCOPES` 且非 plan 模式才加入 |
| `executeTool` switch（约 `ai-panel.js:8427`） | 新增 `case 'propose_patch'`，**所有可预期失败 return 结构化文本，不 throw** |
| `renderApprovalBody`（`ai-panel.js:4898`） | 新增 `kind === 'patch'` 分支 → `renderPatchApprovalBody` |
| `toolVerb` / `toolPrimary`（`ai-panel.js:5124` / `5172`） | 补 `propose_patch`：动词「补丁」，主文案显示补丁名或文件数 |
| `AI_COMMANDS`（`ai-panel.js:650`）+ `runSlashCommand`（`:13180`） | 新增 `/patch`：无参数 = 把本轮改动落成补丁；`/patch <需求>` = 以补丁形式完成该需求（注入提示词，同 `/init`）；新增 `/diff`：只展示当前改动 |
| `enhanceAICodeBlocks`（`ai-panel.js:5461`） | AI 消息里的 ```diff 代码块，在「复制」旁加「存为补丁」（P1） |
| `session` 结构（`normalizeSession` / 会话存储） | 新增内存字段 `lastDiff`（§3.1）与 `explicitPatchRequest`（§3.3）；均不落盘 |
| 发送消息 / 补丁入口点击（`sendMessage`、卡片「导出为补丁」、右键「应用补丁」、消息 diff 块「存为补丁」） | 按 §3.3 触发词与入口置位 `session.explicitPatchRequest`；新用户消息与档位切换时重置 |
| `ai-session-store.js`（`:178` 一带） | approval 序列化白名单补 `patchId / planId / summary / files / status`，重开会话仍能显示卡片 |
| 默认系统提示 | 只加一句：「要产出补丁时先 `skill_use patch-workflow`，用 `propose_patch` 提交；完全权限档下不要主动出补丁」 |

### 5.3 校验与限额（拒绝优于容错）

| 项 | 上限 | 超限行为 |
| --- | --- | --- |
| **AI 单次提交**的 patch 文本 | **256 KB**（与 `AI_WRITE_LIMIT` 对齐） | `PATCH_LIMIT`，明确要求"拆成 2–3 个补丁分批提交" |
| 外部 / CLI 补丁文本 | 2 MB | 同上 |
| 文件数 | 200 | 同上 |
| 单文件 hunk | 500 | 同上 |
| 单文件大小 | 10 MB（与 `app.go` 只读阈值一致） | 该文件 `blocked`，理由"文件过大，请手工处理" |
| 路径 | 必须在范围根内 | `PATCH_PATH_DENIED`，附越界路径原文 |
| 内容 | 至少一个 `@@` hunk | `PATCH_EMPTY` |

> 256 KB 不是随便定的：模型单次输出上限大概是几千 token，硬塞 2 MB 只会截断或者超时。**超过 256 KB 就让它拆**，比让它生成一个注定被拒的大补丁有用。

> **补丁正文不进会话历史**：`propose_patch` 的参数里带着整份 diff，如果原样写进会话 JSONL，一个 256 KB 补丁就能把会话撑爆。落盘后会话里只留 `{patchId, sha256, bytes, summary}`，正文按需从 `.cadt/patches/` 读（沿用 `ai-session-store.js` 已有的图片外置机制）。

### 5.4 审批卡（与 write_file 卡同构）

```
┌ 补丁审批 · AI 写入状态徽标                    4 文件  +186 −12 ┐
│ ☑ frontend/index.html          +7  −0   ✓ 可应用 · 第 1889 行后插入 │
│ ☑ frontend/src/style.css       +30 −0   ✓ 可应用                    │
│ ☑ frontend/src/ai-panel.js     +96 −8   ⚠ 2/5 hunk 失配 · 将跳过     │
│ ☑ frontend/src/main.js         +53 −4   ✓ 位移 +6 行（全局一致）     │
│                                                                    │
│ [展开全部 diff]  □ 忽略行尾空白  □ 允许上下文位移                     │
│ 应用模式：(•) 允许部分成功  ( ) 整体成功        ← AI 卡默认 partial    │
│                                  [打开补丁] [放弃] [应用（跳过 1 个）] │
└────────────────────────────────────────────────────────────────────┘
```

- **模式开关就在卡片上**，AI 卡默认「允许部分成功」（§9.7.1）；切成「整体成功」后，冲突文件会因为"必须全成功"而阻止应用。
- 按钮文案随之变化：partial 显示「应用（跳过 1 个）」，atomic 显示「应用选中（3）」；atomic 下有冲突则**禁用** + 悬停「先取消勾选冲突文件或改成允许部分成功」。
- 在 partial 下冲突文件**默认仍是勾选**（因为勾选 ≠ 必须成功），但行尾明确标「将跳过」，避免用户以为它会被改。
- 应用后卡片变结果态：partial → 「已应用 3 个，跳过 1 个 · 撤销 · 处理跳过的 1 个」；atomic → 「已应用 3 个 · 撤销」或「未应用任何更改 · 查看原因」（§9.7.6）。
- 卡片头部带**重试计数**（如「第 2/3 次」），让用户看见 AI 在自我修正而不是卡死。
- 与现有 `write_file` 卡共用 `.ai-diff-*` 样式，只加文件表与工具栏。

### 5.5 错误回传协议（重点）

**结构上已经不中断对话**：`ai-panel.js:10118` 的工具 `try/catch` 会把异常写进 `toolMessage.content = '工具执行失败：…'`，随后 `startRound()` 继续下一轮。问题是这句话**没有可行动信息**，模型只能干瞪眼或原样重发。

所以 `propose_patch`（以及 `ApplyPlan` 的失败路径）**不用 throw 传递可预期错误**，改为 `return` 一段固定格式文本：

```
【patch:error】code=PATCH_HUNK_CONFLICT retryable=yes
文件：frontend/src/main.js　hunk：#2（@@ -1901,7 +1901,9 @@）

期望上下文（补丁里写的）：
  1901 |     if (doc && doc.mode === 'tree') {
  1902 |         doc.mode = 'code';
  1903 |     }

实际内容（磁盘 1897–1903 行）：
  1897 |     if (doc && !doc.mode) {
  1898 |         enterCodeView(doc);
  …

原因：上下文第 1 行不匹配，且该片段在文件内找不到唯一位置（找到 0 处）

修复建议：
1) read_file frontend/src/main.js，offset=1860，limit=90 取回真实内容
2) 按真实内容重写 hunk #2 的 3 行上下文，行号以 @@ 头为准重新计算
3) 只提交这一个文件的修正版；不要原样重发整个补丁
```

- 首行是机器可读头（`code` / `retryable`），前端据此渲染红色错误条 + 定位跳转（`路径:行` 可点），正文折叠。
- 正文给**期望 vs 实际**的对照，这是模型自修的关键；只给一句"匹配失败"它只能瞎猜。
- 每条错误必须带「修复建议」，且建议是**具体动作**（读哪个文件的哪段），不是"请检查补丁"。
- 成功时也回一份「预检摘要」，让模型知道现状（哪些文件可应用、哪些要它改）：

```
已生成补丁 .cadt/patches/20261113-130500-ai-write-status.patch（4 文件 +186 −0）
预检：3 个文件可应用；frontend/src/ai-panel.js 2/5 hunk 失配（见上）
→ 可以现在让用户审；也可以先修 ai-panel.js 那两处再提交。
```

应用完成后（无论成败）回一条结果头，模型据此判断下一步：

```
【patch:result】mode=partial applied=3 skipped=1 added=186 removed=12
跳过：frontend/src/ai-panel.js（hunk #2/#5 上下文不匹配）
→ 已写入的 3 个文件可用卡片「撤销」整体回退；如需修剩下这个，先 read_file 再重新生成单独补丁。
```

| 结果头 | 含义 | 模型该做什么 |
| --- | --- | --- |
| `applied=N skipped=0` | 全部成功 | 汇报改动 + 撤销方式 |
| `applied=N skipped=M`（partial） | 部分成功 | **分开汇报**：成功哪些、跳过哪些、为什么；问用户要不要修剩下的 |
| `applied=0 skipped=N`（partial 全失败） | 磁盘零变更 | 按错误码自修或转人工，**不要说"部分成功"** |
| 无结果头（atomic 失败） | 磁盘零变更 | 按错误码自修 |

### 5.6 错误码表

| code | 触发 | retryable | 给模型的修复动作 |
| --- | --- | --- | --- |
| `PATCH_PARSE` | `@@` 头与行数不符 / 未知行首 | yes | 附出错行号与原文，按语法重写 |
| `PATCH_EMPTY` | 没有任何 hunk | yes | 至少给一个 hunk |
| `PATCH_HUNK_CONFLICT` | 上下文不完整 / 多处命中 / offset 不一致 | yes | `read_file` 目标区间后重写该 hunk |
| `PATCH_FILE_DRIFT` | `BaseHash` 不符（生成后文件被改） | yes | 重新读整文件，重生成该文件补丁 |
| `PATCH_PATH_DENIED` | 越界 / 绝对路径 / 盘符 / `.git` | yes（改路径后） | 换成相对工作区根的正斜杠路径 |
| `PATCH_LIMIT` | 超 2 MB / 200 文件 / 500 hunk | no | 拆成多个补丁，分批提交 |
| `PATCH_UNSUPPORTED` | binary / rename / mode | no | 改为「删除旧文件 + 新建文件」两个纯文本操作 |
| `PATCH_USER_DENIED` | 用户点「放弃」 | no | 不要重试；询问用户想怎么改 |
| `PATCH_APPLY_IO` | 写盘失败 / 被占用 / 权限（atomic 全回滚；partial 只回滚该文件） | no | 告知用户关闭占用程序后重试；重试会**重新预演** |
| `PATCH_ROLLBACK_FAILED` | 回滚本身失败（严重） | no | 列出未恢复文件 + 备份绝对路径 + 原始 hash，请用户手工覆盖 |
| `PATCH_SKIPPED` | partial 下该文件未应用（**不是错误**，是结果） | no | 读原因后决定：修这一个 / 让用户手工改 / 放弃 |
| `PATCH_BUSY` | 另一个窗口/进程正持有工作区锁 | yes（等一下） | 稍后重试，别重复提交 |
| `PATCH_FILE_LOCKED` | 目标文件被外部程序独占（连读都失败） | no | 让用户关闭占用该文件的程序 |
| `PATCH_CONCURRENT_MODIFIED` | 文件在写入窗口内被外部修改 | yes | 重新 `read_file` 后重生成，或让用户手工合并 |
| `PATCH_NO_BACKUP` | 备份目录建不出来（只读盘/权限/失败） | no | **宁可不让用也不裸写**：请用户换可写位置或修权限 |
| `PATCH_DISK_FULL` | 备份所需空间不足 | no | 清理磁盘或减少本次选中文件 |
| `PATCH_REVERT_CONFLICT` | 撤销时文件已被再次修改 | no | 报告用户三选一（放弃/另存/覆盖） |
| `PATCH_GIVEUP` | 同一补丁连续失败 3 次 | no | 停手，向用户说明并给替代方案 |
| `PATCH_NOT_REQUESTED` | 完全权限档 + 用户未要求补丁（§3.3） | no | 改用 `edit_file` / `write_file`；确需补丁先问用户 |
| `PATCH_BACKEND` | 后端方法缺失 / 内部错误 | no | 提示重启应用 |

### 5.7 重试预算与熔断

- 会话级 `patchAttempts: Map<patchHash, {count, lastCode, lastAt}>`，`patchHash = sha256(patch 文本)`。
- 同一 hash 连续失败 ≥ 3 → 第 4 次**不执行**，直接返回 `PATCH_GIVEUP`：

  > 同一补丁已连续失败 3 次（最近原因：`PATCH_HUNK_CONFLICT`）。已停止自动重试。
  > 请向用户说明失败原因，并给出替代方案：改用 `write_file` / `edit_file` 逐文件修改，或请用户手工调整。
  > 不要再提交同一份补丁。

- 仅 `retryable=yes` 的错误计入次数；`PATCH_USER_DENIED` / `PATCH_LIMIT` 等不计入，避免把"用户拒绝"算成 AI 的错。
- 成功一次或用户改变需求（新一轮用户消息）后清零。
- 熔断只影响 `propose_patch` 自身，不摘掉其它工具——模型仍可用 `write_file` 完成任务，这是"退路"而不是"死路"。
- 前端卡片显示「第 2/3 次」，超过后显示「已转人工」。

### 5.8 用户可见的失败呈现

| 场景 | 卡片表现 | 模型收到 |
| --- | --- | --- |
| 上下文失配 | 红色错误条 + 「定位到 1897 行」+ 「重新生成」 | 完整错误文本（§5.5） |
| 用户放弃 | 灰色「已放弃，文件未修改」 | `PATCH_USER_DENIED`，不重试 |
| 应用时文件已被改 | 红色「文件已被修改，请重新预览」+ 刷新按钮 | `PATCH_FILE_DRIFT`，可重生成 |
| 应用写盘失败（已回滚） | atomic：红「未应用任何更改」；partial：橙「该文件未应用，其余已应用」+ 重试 | `PATCH_APPLY_IO`，**措辞必须与模式一致** |
| 部分跳过（partial） | 分组「✓ 已应用 3 / ⚠ 已跳过 1」+「处理跳过的 1 个」 | `PATCH_SKIPPED` + 结果头 `applied=3 skipped=1` |
| 回滚失败 | 红色横幅「有 N 个文件未能恢复」+ 备份路径 + 打开目录 | `PATCH_ROLLBACK_FAILED`，要求如实报告 |
| 连续 3 次失败 | 「已转人工」+ 错误历史折叠 | `PATCH_GIVEUP` |

## 6. 内置技能 `patch-workflow`

位置：`AI_BUILTIN_SKILLS`（`ai-panel.js:147` 起，紧跟 `code-review` / `json-toolkit`）。加入后自动进 `<skills>` 索引，模型可见、`skill_use` 可载全文、设置 → AI → 技能里可开关（与 `inline-visual`、`answer-me-with-html` 同一机制）。

**不放进 `docs/skills/`**：那里是给外部 agent（Claude Code 等）用的，而它们没有 `propose_patch` 工具，写一份只会误导。将来若把补丁能力开成 CLI，再迁过去。

### 6.1 description（索引里要够"抓人"）

> 用 `propose_patch` 生成 `.patch` 补丁交给用户审批（多文件改动 / 要存档转交 / 要能撤销 / 用户说「先给 patch」「别直接改」）；含 unified diff 写法、行号与上下文自检清单、失败后的最小修复与重试纪律

### 6.2 正文要点（约 90 行）

1. **什么时候用 / 不用**
   | 场景 | 用什么 |
   | --- | --- |
   | 用户只想**看**改了啥 / 要 diff / 要对比 | 只读展示 diff（审阅卡、`GitDiffFor`、虚拟文档），**不要**建补丁 |
   | 看完了说「存成补丁 / 我要应用」 | 直接把那份 diff 交给 `propose_patch`（有 `lastDiff` 就别自己重写） |
   | 单文件小改、用户只想改 | `edit_file`（省一步审批） |
   | 新建文件、整体重写 | `write_file` |
   | 跨多文件、要审批、要存档/转交、要能撤销 | `propose_patch` |
   | **完全权限档 + 用户没提补丁** | 直接 `edit_file` / `write_file`，**别提议补丁、也别弹卡**（§3.3） |
   | 计划模式下讨论方案 | 都不写，只出计划 |
2. **生成前必做**：先 `read_file` 拿准确原文（**禁止凭记忆写上下文**）；确认路径相对工作区根、全正斜杠、无盘符；确认文件存在与否（决定 modify 还是 add）。
3. **写法硬要求**：`--- a/x` / `+++ b/x`；`@@ -旧起,旧数 +新起,新数 @@`；上下文 3 行且逐字；不得用 `...` 省略；多文件按路径排序；文件尾无换行必须写 `\ No newline at end of file`。
4. **自检清单**（交之前逐条过）：hunk 里 `+`/`-`/空格行数与 `@@` 头一致；每个 hunk 的行号从上一 hunk 递推正确；新建文件用 `@@ -0,0 +1,N @@`、删除用 `@@ -1,N +0,0 @@`；没有重复路径；没有 rename/二进制混入。
5. **失败怎么改**：读 `【patch:error】` 的 `code` 和「修复建议」→ 只做最小修复（通常只重写那一个 hunk）→ 重新提交；同一补丁最多 3 次；收到 `PATCH_GIVEUP` 就停手转人工。
   **汇报必须与 `mode` 一致**：`atomic` 失败 = 一个文件都没改，说「未做任何修改」；`partial` 有跳过 = 分开说「已应用 3 个（列出）、跳过 1 个（原因）」，再问要不要修剩下那个。**禁止**把 partial 说成"全部完成"，也**禁止**把 atomic 失败说成"改了一部分"。
6. **审批通过后**：报告改了哪些文件、怎么撤销（卡片「撤销」/ 补丁视图 / 设置页最近补丁）、建议下一步（跑测试或构建）。
7. **禁止**：把同一补丁原样重发；把一个补丁拆成多个小补丁刷审批；用补丁改 `.git/`、`.cadt/permissions.json`；在补丁里混入二进制或权限位变更；**用户只想看 diff 时自动生成补丁**；**用回答里的 ```diff 代码块冒充"已可应用"**（聊天里的 diff 只是展示，要能应用必须走 `propose_patch`）；**完全权限档下主动出补丁或追问"要不要存成补丁"**。
8. **完全权限档怎么判断用户"明确要补丁"**：看本轮用户消息是否含 §3.3 的触发词、或用户是否点了补丁入口。没有就直写；拿不准就问一句「这次要不要留成补丁？」，问过一次不再重复。

## 7. `.patch` / `.diff` 的三种视图（补丁 / 代码 / 文本）

**先说现状**：`.patch` 现在就能用**代码视图**打开——`formats.js` 把 `diff` / `patch` 归在 `text` 驱动里，且 `extensionAceModes` 已把两者映射到 `ace/mode/diff`（`formats.js:408`），Ace 会按 diff 规则切 token、给行号、支持折叠。所以代码视图不是要新增，而是**换格式驱动时不能弄丢**；真正缺的是语义配色（§7.5）。

### 7.1 三种视图

| 视图 | `doc.mode` | 何时进入 | 用途 | 能力 |
| --- | --- | --- | --- | --- |
| **补丁** | `patch` | `.patch` / `.diff` **默认** | 看结构、勾选、应用 | 文件卡 / hunk / 预检 / 应用 / 撤销；**只读** |
| **代码** | `code` | 手动切换 | 看原文、手改、按行号核对 | Ace + diff 高亮 + 行号 + 折叠；**可编辑** |
| **文本** | `text` | 手动切换 | 长篇阅读、自动换行 | 与现有纯文本一致 |

三个视图是平级的，工具栏「视图」里给三项（当前项高亮），键盘沿用现有视图切换入口，不新加快捷键。

### 7.2 模式切换规则（容易踩的地方）

- **patch → code / text**：把当前补丁文本交给 Ace。这里沿用 SVG 渲染视图那套做法（`main.js:15561` 用 `doc._svgSrcText` 暂存源文本），用 `doc.rawText` 保存，退出时原样还原，**不能因为切视图就把用户改了一半的内容丢掉**。
- **code / text → patch**：**用当前缓冲区文本重新解析**，不是用磁盘内容。解析失败 → 停在代码视图，顶部显示红色错误条（带 `PATCH_PARSE` 的出错行号），不弹窗、不阻止继续编辑。手改补丁是合理场景，必须支持。
- **结构化视图里不可编辑**：补丁视图只读，编辑一律在代码视图。避免出现「文本改了但结构化视图还是旧的」两套真相。

### 7.3 编辑、脏状态与应用的真相来源

- 允许在代码视图编辑 `.patch`（用户可能手工修一个 hunk）；保存走现有 `SaveFile`，行为与其它文本文件一致。
- 有未保存修改时点「应用」：**默认动作是「保存并应用」**（一次完成），而不是让你先手动按保存——因为 `MatchPlan` 基于磁盘 `BaseHash`（§9.4），缓冲区内容不落盘就必然对不上。
- 保存后自动重新预检，状态徽标（可应用 / 部分冲突 / 已应用）刷新；如果解析失败，徽标变「无法解析」并列出原因行。

### 7.4 代码改动清单

| 改动 | 位置 |
| --- | --- |
| 新增格式驱动 `patch`（`extensions: ['patch','diff']`，`rawOnly: true`，`aceMode: 'diff'`，标记 `patch: true`），并从 `text` 驱动的扩展名里移除这两个 | `formats.js:275` |
| **保留** `extensionAceModes` 里的 `diff: 'diff'` / `patch: 'diff'`（代码视图高亮靠它） | `formats.js:408` |
| `createDocEditor` 增加 `patch` 分派：`treeAvailable = false`，默认 `doc.mode = 'patch'` | `main.js:8923` |
| `switchMode` 增加 `patch` ↔ `code` ↔ `text` 三向分支（与 image / table / render 同构，注意 `_patchSrcText` 暂存） | `main.js:15520` |
| 工具栏「视图」加「补丁」项，仅 `patch` 格式可见 | `index.html` + `main.js` 状态条 |
| `style.css` 补 `.ace-mode-diff` 的 token 语义色（`+` 绿 / `-` 红 / `@@` 强调 / 文件头灰），全部走主题变量 | `style.css` Ace token 段（约 `:4130`） |
| 抽 `--diff-add-bg` / `--diff-del-bg` 两个变量，新增 `.dl-diff-add-line` / `.dl-diff-del-line` marker 样式，与 `.ai-diff-line.add/.del` 共用同一混色写法 | `style.css:7179` |
| marker 重建逻辑（加载 / 文本变化 debounce / 切回代码视图；>5000 行跳过） | `patch-view.js` |

### 7.5 语法高亮（代码视图，已核实现状）

**现在的问题不是"没高亮"，而是"高亮了但没有语义颜色"。** 查 `frontend/public/vendor/ace/mode-diff.js`，Ace 的 diff 规则是按行首正则切 token 的：

| 行 | Ace token |
| --- | --- |
| `--- a/x` / `+++ b/x` | `constant.numeric` + `meta.tag` |
| `@@ -1,7 +1,9 @@` | `constant` / `constant.numeric` / `comment.doc.tag` |
| `+新增行` | `support.constant`（**只有行首那个 `+`**）+ `text` 正文 |
| `-删除行` | `support.function`（只有 `-`）+ `string` |
| `diff --git …` / `index …` | `variable` / `keyword` |

而 `style.css` 只给了通用 token 颜色（`--val-number`、`--syn-function` 等），**没有 diff 的语义色**。结果就是：打开 `.patch` 看着像普通代码，红绿不分、`@@` 不显眼。

所以要补两层：

**1）文字层：`.jsoneditor .ace-mode-diff` 作用域 token 配色**（全部走主题变量，亮/暗自动适配）

- `+` → `--green`，`-` → `--red`
- `@@ … @@` → `--accent`，hunk 头尾注 → `--muted`
- `--- a/x` 前缀红、`+++ b/x` 前缀绿，路径用 `--text`
- `diff --git` / `index` → `--muted` + 600 字重（视觉上退到背景层）

**2）行层：整行背景（关键）**

Ace 只给行首一个字符上 token，光靠 token 读起来还是一锅粥。用 Ace marker 给整行铺底色：

```js
session.addMarker(new Range(row, 0, row, 1), isAdd ? 'dl-diff-add-line' : 'dl-diff-del-line', 'fullLine')
```

- 颜色沿用现有 `.ai-diff-line.add/.del` 的写法（`color-mix(in srgb, var(--green) 13%, transparent)`，`style.css:7179`），抽成 `--diff-add-bg` / `--diff-del-bg` 两个变量，两处共用；
- **性能闸门**：>5000 行的补丁默认不打 marker（只保留 token 着色），顶部提示「已关闭行背景以保流畅」，可手动开；
- marker 刷新时机：文档加载、文本变化（debounce 150ms）、从其它视图切回代码视图。

**3）补丁视图共用同一套变量**：结构化 hunk 的底色/前景与代码视图完全一致，避免"两个视图两种绿"。

**验收**：四个主题（`idea-light` / `idea-dark` / `darcula` / 另一套）各截一张 `.patch` 代码视图，确认 `+` 绿、`-` 红、`@@` 强调色、文件头灰、正文对比度可读；再对比补丁视图，两处颜色一致。

### 7.6 补丁视图内容

- 顶部条：文件名、来源（AI 生成 / 外部）、`+186 −12`、状态徽标（可应用 / 部分冲突 / 已应用 / 部分应用 / 已撤销 / 无法解析）、**应用模式下拉（整体成功 ← 默认 / 允许部分成功）**、`应用全部` `应用选中` `撤销` `另存为` `复制`。
- 文件卡：路径 + 统计 + 折叠；hunk 块带旧/新行号、`+`/`-`/上下文着色，失配 hunk 红色左边框 + 原因行（与审批卡同一套错误文案）。
- 点文件路径 → 打开目标文件并跳到对应行（复用 `openPath` + 行定位，P1）；点 hunk 头 → 在代码视图里定位到该 `@@` 行。
- 外部补丁（无 index 记录）：应用前弹「外部补丁」确认框，列出**目标绝对路径清单**与越界项；备份进 `external-<ts>/`，同样可撤销。
- **首次打开引导**：顶部一行灰字「此文件包含 4 个文件的改动，点『应用』才会写入磁盘（不会自动改）」，用户滚动后淡出。收到别人补丁的人需要这句话。
- **大补丁渲染**：diff 行数 > 5000 时，每个文件卡默认只渲染前 200 行 + 「展开全部」；> 20000 行直接提示「内容过大，建议用代码视图」。整页 `innerHTML` 一次性重建是当前 `main.js` 的通病，这里不要复制。
- **查找（Ctrl+F）**：补丁视图是自定义 DOM，Ace 查找栏对它无效。规则：在补丁视图按 Ctrl+F → 临时切到代码视图并打开查找栏（找完可切回）；顶部提示一句。不做第二套查找实现。
- **快捷键**：`Enter`/`Space` 折叠当前文件卡，`Esc` 关闭预览。



## 8. 两条生成路径

### 8.1 直接生成（`propose_patch`，P0）

模型写 diff。优点：能产出可转交的标准补丁。风险：模型算错行号/上下文。缓解：
- 匹配规则严格 + 位移必须全局一致（§9.3），失配就是失配，不硬凑；
- 失败按 §5.5 回给模型自修，最多 3 次；
- 审批卡默认不勾选冲突文件——**永远不会**悄悄应用一半错的改动。

### 8.2 语义写入 → 编译成补丁（P1，可选开关）

设置 → AI 助手 → 写操作方式：`直接写入`（默认）/ `先生成补丁待审批`。
后者在 `applyWorkspaceWrite` 里不再 `SaveFile`，而用 `diff.js` 的 `unifiedDiff(oldText, next)` 现算 diff → `SavePatch` → 同一张审批卡。产出的补丁 100% 可应用（diff 由真实内容算出）。

## 9. 误改防护与撤回（核心安全设计）

针对「补丁生成后文件又变了，会不会行号匹配错、改错文件」这个担心，答案不是"尽量匹配对"，而是**三层保险 + 一条铁律**。

铁律：**用户看到的那次预览，就是唯一允许执行的那次操作**。一致则做，不一致则什么都不做。

### 9.1 三层保险总览

| 层 | 挡什么 | 机制 | 失败表现 |
| --- | --- | --- | --- |
| 第一层 路径与身份 | 改错**文件** | 路径精确、越界闸门、不做同名/模糊查找、`BaseHash` 逐文件校验 | 该文件 `blocked`，卡片标红，默认不勾选 |
| 第二层 匹配规则 | 改错**位置** | 上下文必须完整、位置必须唯一、offset 必须全文件统一、零上下文 hunk 只认精确行号 | 该 hunk `conflict`，附期望 vs 实际上下文 |
| 第三层 契约与回滚 | 审批**期间**文件被改 / 应用逻辑出错 | 应用时重建 MatchPlan 与预览逐条比对；应用后反向校验；字节级备份 + 一键撤销 | 整体拒绝 / 自动回滚 / 可撤销 |

### 9.2 第一层：路径与身份

1. **路径即身份**：目标 = `root + relpath`，`filepath.Clean` 后精确匹配。**不做** basename 搜索、大小写模糊、递归找同名文件、`**` 通配。文件不存在且不是 `add` → `blocked`，不"自动找找看"。
2. **越界闸门**：拒绝盘符、UNC、`/` 开头、含 `..` 的路径；`EvalSymlinks` 取父目录真实路径后校验仍在根内（防 junction / 符号链接逃逸）。
3. **硬禁区**：`.git/`、`.cadt/patches/`、`.cadt/permissions.json` 一律拒绝，即使「完全权限」档也不放行。判定要**大小写不敏感**且对 `relpath` 做 Clean + 展开 `%VAR%` 之后再做（`.GIT/config`、`.git/./config` 都得拦住）。
4. **目标是符号链接** → 拒绝（`PATCH_PATH_DENIED`，理由"目标本身是链接"）。只校验父目录不够：链接可能指向工作区外，rename 会写到链接指向的位置。
5. **基线指纹**：本应用生成的补丁，每文件带生成时内容 `sha256`。应用前比对：
   - 相同 → 正常流程；
   - 不同 → `blocked`，理由「该文件在补丁生成后已被修改」，给出「生成时 N 行 / 现在 M 行」，由用户决定重生成还是手改。
   - 外部补丁（无指纹）→ 以**预览时** hash 作为本次任务基线，同样受第三层契约保护。
6. **重复路径**：同一 relpath 在 patch 里出现两次 → 直接拒绝（防双重应用）。包括"先删后建同路径"这种 git 重写——让它拆成两个补丁，别在这里猜意图。
7. **add 类型**：目标已存在且内容不同 → `blocked`，绝不覆盖。
8. **delete 类型**：文件不存在 → `blocked`；删除走回收站。
9. **网络盘 / UNC 根**：允许读写，但预览顶部提示「网络盘上原子替换不保证，建议把仓库放本地再应用」。不阻止，只是别让人以为原子性还有效。

### 9.3 第二层：匹配规则（9 条，全部强制）

| # | 规则 | 说明 |
| --- | --- | --- |
| 1 | 上下文必须**完整**匹配 | 缺任意一行即 `conflict`，不做"部分匹配" |
| 2 | 位置必须**唯一** | 多处命中 → `conflict`，**绝不取第一个**（最容易"改错位置"的坑） |
| 3 | offset 必须**全文件统一** | 同一文件所有 hunk 共享一个位移量，符合 unified diff 语义；某 hunk 需要不同 offset → `conflict` |
| 4 | 零上下文 hunk 只认精确行号 | `@@ -5,0 +6,3 @@` 这类纯插入，offset 必须为 0 |
| 5 | 位移搜索默认关闭 | 需在卡片勾「允许上下文位移」才启用；启用后仍受 3、4 约束，位移量在卡片明示 |
| 6 | 位移上限 ±200 行 | 超出即 `conflict` |
| 7 | 行尾空白容错默认关闭 | 需显式勾选；开启时卡片明示「已放宽行尾空白比对」 |
| 8 | 每个 hunk 记录实际落点 | 预览显示「第 1889 行后插入 7 行」，用户看得到它要改哪一行 |
| 9 | 只改 patch 声明的文件 | 不产生任何 patch 之外的文件写入 |

### 9.4 第三层：契约 + 反向校验

**预览即契约**：`BuildMatchPlan` 在预览时把每个文件的 `BaseHash`、每个 hunk 的 `ApplyAtLine`、全局 `Offset`、结果 `ResultHash` 全部算定并持有（`planId`）。

**应用时复核**：`ApplyPlan(planId, …)` 用**当前磁盘内容**重建 plan，与预览那份逐字段比对：

```
plan.files[i].baseHash  ≠ 复核 baseHash   → 拒绝：「文件在审批期间被修改」
plan.files[i].offset    ≠ 复核 offset     → 拒绝：「位移从 6 变成 27，请重新预览」
plan.files[i].hunks[j].applyAtLine ≠ 复核 → 拒绝：「第 3 个 hunk 落点从 1889 变为 1912」
```

任何一条不一致 → **整体不写盘**，返回 `PATCH_FILE_DRIFT`（同时回给模型，让它重生成）。不存在"尽力应用"这个分支。这就直接消灭了你担心的场景：**补丁生成后文件被改 → 预览时你看到位置 A，应用时它已经不在 A 了 → 直接拒绝，让你重新看一遍。**

**应用后反向校验**：写盘后，把选中的 hunks 反向应用到新内容，必须精确还原出基线文本（`sha256 == BaseHash`）。不成立 → 说明正向应用多删/少插/插错行，**立即用备份回滚**并返回 `PATCH_APPLY_IO`（附反向校验失败的文件与 hunk）。

**写盘后校验**：每文件落盘后重读，`sha256 == ResultHash` 才算成功。Windows 上杀软/同步盘偶发截断也能被发现。

### 9.5 撤回与崩溃恢复

**备份是字节快照，不是逆向补丁**。即使应用逻辑错得离谱，原始字节也一定回得来。

- 应用前：每个将被修改/删除的文件原样复制到 `backup/<id>/`，同目录 `manifest.json` 记录 relpath、sha256、mtime、编码、EOL、BOM。
- **没有备份就不许写**：备份目录建不出来（工作区只读、磁盘满、权限不足）→ 直接 `PATCH_NO_BACKUP` 拒绝应用。宁可不让用，也不裸写。
- **磁盘空间预检**：备份需要约等于"将改动文件的总大小"的空间，预演阶段算一次，不足 → `PATCH_DISK_FULL`。
- 撤销 `RevertPatch(id)`：
  1. 先快照"当前（应用后）状态"到 `backup/<id>/applied/`，保证撤销本身也能被撤销；
  2. 校验当前文件 `sha256` 是否等于应用后的 `ResultHash`：
     - 相等 → 直接还原；
     - 不等（应用后你又手工改过）→ 三选一：`abort` 放弃撤销（默认）/ `stash` 先把当前内容另存为 `.revert-backup` 再还原 / `force` 强制覆盖（需二次确认）；
     - 文件**已被删除** → 视为冲突，同样走 `onConflict`（`force` = 按备份重新创建）；
  3. 还原后逐个校验 `sha256 == 原 BaseHash`，任一失败 → 用 `applied/` 快照回滚整个撤销。
- **撤销固定 `atomic`**，不受应用时的 `partial` 影响：要么全部还原，要么一个都不动。理由：撤销是"回到过去"，半还原比不还原更危险。
- **撤销走与应用完全相同的写入通道**：同一把 per-path 锁、同一个 rename + 双重校验、同样的 watcher 抑制与编辑器刷新（§9.8）。不允许另写一套简化逻辑。
- **撤销入口三处**：审批卡结果态「撤销」、补丁视图顶部「撤销」、设置页「最近补丁」列表。
- **WAL 崩溃恢复**：应用前先追加 `{"status":"applying","files":[...],"backupDir":...}` 并 fsync，完成后追加 `{"status":"applied"}`。启动扫到未闭合的 `applying` → 提示「上次补丁应用未完成」，提供「从备份恢复 / 忽略」。与 `sessionstore` 现有 fsync 回滚思路一致。
- 留痕：`activity.log('patch.apply' / 'patch.revert', id, {files, added, removed, mode})`，只记摘要不记正文。

### 9.6 明确"不会发生"的事，以及残余风险

不会发生：

- 不会因为"行号对不上"就去找另一个同名/相似文件；
- 不会在上下文不全时猜着改；
- 不会在审批期间文件变了还照旧应用；
- 不会有任何一次写盘没有备份；
- 不会应用后不留撤销入口；
- 不会执行补丁内容里的任何东西（补丁是纯文本，应用器只做文件读写）；
- 不会因为补丁失败就把整段对话停掉（§5.5）；
- 不会在完全权限档下主动弹补丁卡（用户没要求时直接直写，§3.3）。

残余风险（诚实说明，靠备份兜底）：

- 若文件被改成"另一处上下文与补丁完全一致、原位置已消失"，理论上可能落到相近位置。防线是唯一命中 + offset 统一 + 预览明示实际行号供肉眼核对。概率极低但不为零 —— 所以备份和撤销不是可选项。
- 用户在 `force` 模式强推、或勾掉冲突提示继续应用，属于知情选择，仍可用备份撤销。

### 9.7 应用模式：整体成功 / 允许部分成功（可配置）

#### 9.7.1 两种模式与默认值

| 模式 | 语义 | 索引状态 |
| --- | --- | --- |
| `atomic` **整体成功** | 选中的文件必须全部成功；任一失败 → **磁盘零变更** | `applied` / `failed` |
| `partial` **允许部分成功** | 失败的文件跳过并报告，其余照常写入 | `applied` / `partial` / `failed`（全部失败仍是 `failed`） |

**默认值按入口区分**（这里最容易搞混，实现时照表来）：

| 入口 | 默认 | 切换方式 |
| --- | --- | --- |
| 补丁视图 / 手动应用 | **整体成功** | 顶部模式下拉 |
| 命令行 | **整体成功** | `--partial`（也可显式 `--atomic`） |
| **内置 AI 助手审批卡** | **允许部分成功** | 卡片上的模式开关 |

AI 侧默认 `partial` 的理由：多文件补丁里一处上下文漂移，不该让其余 5 个文件白等；模型可以"先落能落的，再单独修跳过的那几个"，比整批重来省一轮对话。代价是必须把"跳过了什么"讲清楚（§9.7.4）。

#### 9.7.2 共同底线：文件级原子

两种模式都**不允许单个文件被写坏**：每个文件都是 `备份 → temp+rename → 反向校验` 的独立小事务。差别只在"一个文件失败时，其它文件怎么办"：

| 阶段 | atomic | partial |
| --- | --- | --- |
| 预演（不写盘） | 全部文件都算，任一冲突 → 整批不写 | 全部文件都算，冲突的标 `skip`，其余继续 |
| 提交阶段某文件 IO 失败 | **回滚全部**，回到操作前 | **只回滚该文件**，已成功的保留 |
| 单文件是否可能半写 | 不可能 | 不可能 |

两阶段仍然是同一套：预演与提交共用同一个匹配函数（`mode: preview|commit`），杜绝"预检说能应用、实际失败"。预演已覆盖绝大多数失败（上下文、路径、`BaseHash`、占用、只读），只有 IO 错误会落到提交阶段。

#### 9.7.3 范围 vs 结果

- **范围**：勾选的文件 / hunk（CLI 用 `--only`）。这是"这一次我要改这些"的声明。
- **结果**：由模式决定——`atomic` 要求范围内 100% 成功；`partial` 允许范围内部分成功。
- 两种模式下，「取消勾选冲突项后重新应用」都**不是**部分成功，而是**发起一次范围更小的新请求**：重新预演、重新确认。索引里两条独立记录，撤销各管各的。

#### 9.7.4 partial 的四条硬约束（防止"悄悄改一半"）

1. **跳过必须逐条可解释**：每个被跳过的文件在结果里列出 `路径 + 原因 + 建议`，不许只给一个数字。
2. **全部失败 = failed**：如果选中集合里没有一个成功，状态是 `failed`、磁盘零变更，不写"partial 0 个"这种状态。
3. **硬拒绝不因 partial 而软化**：越界、`.git/`、`.cadt/permissions.json`、符号链接逃逸是"拒绝"，不是"跳过"——它们会让整份补丁直接被拒（atomic 与 partial 一致），因为这些不是可协商的冲突。
4. **结果分组呈现**：卡片分「✓ 已应用 N」「⚠ 已跳过 M」两组，跳过的组带「处理这 M 个」按钮 → 打开补丁视图、只勾选它们、重新预演。

#### 9.7.5 回滚失败（严重，但不许隐藏）

回滚本身也可能失败（刚写成功的文件又被别的程序锁住）：

- `atomic`：立即停止，回滚全部；回滚失败的文件单独列出。
- `partial`：停止该文件之后的处理，只回滚这一个文件；其余已成功的不动。
- 两种情况都返回 `PATCH_ROLLBACK_FAILED`，列出：已回滚的文件、**未能回滚的文件 + 备份绝对路径**、每个文件的原始 sha256。
- UI 用红色横幅「有 N 个文件未能恢复，请用备份手工覆盖」+「打开备份目录」；CLI 打印同样信息并以退出码 `5` 结束。
- 这条错误**不允许**被折叠、弱化成 toast 或吞掉。

#### 9.7.6 失败 / 跳过长什么样

`atomic`（整体未写）：

```
未应用任何更改（选中 3 个文件，其中 2 个存在冲突）

✗ frontend/src/ai-panel.js   hunk #2/#5 冲突
  期望上下文（补丁）  1901 |      if (doc && doc.mode === 'tree') {
  实际内容（磁盘）    1897 |      if (doc && !doc.mode) {
  原因：上下文第 1 行不匹配；该片段在文件内 0 处命中
  → 建议：打开文件第 1897 行核对 ｜ 重新生成该文件补丁 ｜ 取消勾选它后重新应用

✗ frontend/src/main.js       文件已被修改
  补丁基线 sha256 a1b2… ／ 当前 sha256 c3d4…
  → 建议：查看该文件与基线的差异 ｜ 重新生成补丁

✓ frontend/index.html        可应用（本次未执行，因为整体失败）
```

`partial`（已应用 2 个、跳过 2 个）：

```
已应用 2 个文件，跳过 2 个（+30 −4）

✓ frontend/index.html        已应用  +7 −0
✓ frontend/src/style.css     已应用  +23 −4
⚠ frontend/src/ai-panel.js   已跳过  hunk #2/#5 上下文不匹配 → 打开第 1897 行 ｜ 重新生成
⚠ frontend/src/main.js       已跳过  文件已被修改（基线 a1b2… / 当前 c3d4…）→ 查看差异
```

#### 9.7.7 手动解决方案（每种模式都用同一套）

| 冲突类型 | 推荐动作（UI 按钮 / CLI 提示） |
| --- | --- |
| 上下文不匹配、多处命中 | 「打开文件第 N 行」核对 → 手工改这一处；或让 AI `read_file` 后重新生成该文件补丁 |
| 文件已被修改（`BaseHash` 不符） | 「查看当前 vs 补丁基线差异」（用 `diff.js` 渲染）→ 决定重新生成还是手工合并 |
| 位移不一致（多个 hunk 各跳各的） | 同上：先看差异，再定 |
| 目标文件不存在（modify / delete） | 「选择其他文件映射」/「确认是新建，改用新建补丁」 |
| 新建目标已存在 | 「比较两者内容」→ 保留哪个；**不覆盖** |
| 越界 / `.git/` / 权限拒绝 | 不提供绕过，只说明原因与正确做法（把补丁放进工作区、或用有权限的目录） |
| 二进制 / rename / mode | 「拆成删除 + 新建两个文本操作」 |
| 目标文件被占用（IO） | 「关闭占用程序后重试」+「重试」（**重新预演**，不沿用旧 plan） |
| 回滚失败 | 「打开备份目录，手工覆盖这 N 个文件」+ 列出原始 hash |

- CLI 用同一套文案；`--json` 给结构化 `hint`：`{code, file, hunk, action, detail}`，并打印可直接复制的下一条命令，例如
  `--apply-patch x.patch --dir D:\repo --only frontend/index.html,frontend/src/style.css --yes`。



### 9.8 写入期间的并发保护（会不会上锁）

先分清三类"可能中途改文件"的角色，它们的处理手段完全不同：

| 角色 | 典型场景 | 手段 |
| --- | --- | --- |
| **本应用自己（同进程）** | 编辑器保存、另一个 AI 工具写同一文件、撤销与重应用并发 | **进程内 per-path 互斥**（`sync.Map` 存 `*sync.Mutex`），所有写路径必须先拿这把锁 |
| **另一个本应用实例（跨进程）** | 双开窗口、CLI 与 GUI 同时应用同一工作区 | **工作区级跨进程锁文件**，直接复用 `sessionlock_windows.go` 的 `CreateFile + LockFileEx`（`golang.org/x/sys/windows` 已是现有依赖，不新增） |
| **外部程序** | VS Code、构建工具、同步盘、杀毒软件、Git 客户端 | 不做独占锁（见下），用**原子替换 + 双重校验 + 冲突检测** |

#### 9.8.1 为什么不用独占锁"锁死"目标文件

Windows 上想要"既原子替换、又独占锁住目标文件"是做不到的：`MoveFileEx` / `ReplaceFileW` 要求目标没有被独占打开。只能二选一：

| 方案 | 能做到 | 代价 |
| --- | --- | --- |
| A. 独占打开（`dwShareMode=0`）+ 原地 `Truncate/Write` | 真正阻止别人中途写 | **失去原子性**：写到一半崩溃就是半截文件；杀软/索引器短暂持有句柄时会误报失败 |
| B. 写 temp + `MoveFileEx` 原子替换 | 文件**永远不会出现半截** | 锁不住目标；并发写有极短窗口 |

**选 B**。理由是用户最怕的是"文件被写坏"，而不是"极小概率被外部同时改"。而且 B 的并发问题**可以检测**（A 的崩溃问题检测不了）。

#### 9.8.2 实际执行顺序（把 TOCTOU 窗口压到最小）

1. **拿进程内 per-path 锁**（按 `relpath` 排序依次获取，避免两个批次交叉死锁）；
2. **拿工作区跨进程锁**（`LockFileEx`，超时 3 秒；超时 → `PATCH_BUSY`，提示"另一个窗口正在应用补丁"）；
3. **探测目标是否被外部独占**：以 `GENERIC_READ` + `FILE_SHARE_READ|WRITE|DELETE` 打开；打不开 → `PATCH_FILE_LOCKED`（提示关闭占用程序），**绝不降级为"不检查直接写"**；
4. **读内容 + 校验 `BaseHash`**（此刻的真相）；
5. 写 temp（同目录，保证同卷），`Sync`；
6. **rename 前 10 微秒级的最后校验**：再取一次 size+mtime+hash，与第 4 步不一致 → `PATCH_CONCURRENT_MODIFIED`，丢弃 temp，**一个字节都没写**；
7. `MoveFileEx(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`；
8. **rename 后立即读回校验** `ResultHash`；不一致 → 说明刚被别的进程覆盖 → 用备份回滚该文件，返回 `PATCH_CONCURRENT_MODIFIED`；
9. 释放锁，落索引。

第 4→6→8 三步是同一个思路：**不假设"我读过就是对的"，每次跨越一个可能被插队的边界都重新验一次**。

#### 9.8.3 剩下的窗口有多大，怎么兜底

- 第 6 步到第 7 步之间（rename 前的微秒级）：外部程序若在此刻写入，它的改动会被我们的 rename 覆盖。**无法用不锁的方式消除**，但：
  - 我们在第 8 步读回校验，若它在此后又写，我们能立刻发现并回滚；
  - 所有被覆盖的原始字节都在 `backup/<id>/`，撤销可用；
  - 索引里记录应用前后的 `mtime/size/hash`，事后能判断"谁改的"。
- 第 8 步之后外部再改：那是对方的正常编辑，不属于我们的窗口；编辑器侧会收到文件变更通知。

#### 9.8.4 与本应用编辑器的配合（真实冲突源，比外部程序更常见）

- **应用期间抑制 watcher**：对本批路径打"预期变更"标记，`watch_windows.go` 的事件到达时识别并跳过，避免编辑器弹「文件已被外部修改」或在应用中重载。
- **应用结束后统一发一次** `notifyFileChanged`，让已打开的标签页重载一次（不是每个文件一次，避免闪烁）。
- **未保存内容的处理**：应用前若该文件有未保存修改 → 按 §7.3 走「保存并应用」或阻止该文件；应用后若文档仍 dirty（用户在应用期间又改了），提示「该文件已被补丁修改，你的未保存内容基于旧版本」+ 提供对比，**不允许静默覆盖**。
- **`Ctrl+S` 竞态**：保存与补丁写入共用同一把 per-path 锁，保存会排队；但排队后写的是用户缓冲区（旧内容）→ 会覆盖补丁结果。所以应用成功后必须**立即把新内容推给编辑器并清 dirty 标记**，再释放锁。

#### 9.8.5 新增错误码

| code | 触发 | 处理 |
| --- | --- | --- |
| `PATCH_BUSY` | 跨进程锁 3 秒未拿到 | 提示另一个窗口正在应用，稍后重试 |
| `PATCH_FILE_LOCKED` | 目标文件被外部独占（连读都打不开） | 列出被占用文件，提示关闭占用程序；预演阶段就会失败，零副作用 |
| `PATCH_CONCURRENT_MODIFIED` | 校验发现文件在窗口内被改（rename 前或后） | 已自动回滚该文件；提示重新预览；附前后 hash |

## 10. 外部补丁：不依赖 AI 的手动应用与路径不一致处理

这是"我把补丁发给同事"的场景：对方没配模型、没开会话，也要能打开就用。**应用能力必须在应用本体里，不在 AI 面板里。**

### 10.1 三条链路（都不经过 AI）

| 链路 | 操作 |
| --- | --- |
| 图形界面 | 双击 / 拖入 `.patch` → 补丁视图 → 选目标文件夹 → 看预检 → 「应用全部」 |
| 命令行 | `CaDt-DataLens.exe --apply-patch x.patch --dir D:\repo --yes` |
| 无工作区打开 | 直接打开一个 patch（没开文件夹）→ 提示「选择应用目标文件夹」→ 记住 |

全部走后端 `PreviewPatchFile` / `RepreviewPatch` / `ApplyPlan` / `RevertPatch`，**0 token、0 模型调用**。

### 10.2 逻辑归属（结构保证，不是口头承诺）

解析、匹配、应用、撤销、备份全在 Go（`patch.go`）。补丁视图直接调这些 App 方法；`ai-panel.js` 只是**另一个调用方**。实现纪律：**不允许**把解析或应用逻辑写进 `ai-panel.js`，否则"不用 AI"迟早退化成"其实还是要开面板"。

### 10.3 根目录怎么定（路径不一致的第一道关）

| 优先级 | 条件 | 采用 |
| --- | --- | --- |
| 1 | 当前工作区根能匹配到补丁里的文件 | 工作区根 |
| 2 | 补丁文件在 git 仓库内（`git rev-parse --show-toplevel`；git 不可用则跳过） | 仓库根 |
| 3 | 以上都不成立，或匹配率 < 50% | 弹「选择应用目标文件夹」，选完记住 |

- 记住的根按**补丁内容 hash** 存进索引：同一补丁下次打开自动复用，位置挪了也认。
- 顶部条常显当前根 + 「更换」按钮；换根后立刻重新预检。

### 10.4 路径对不上的四种情况

| 情况 | 现象 | 处理 |
| --- | --- | --- |
| 前缀层级不同（`a/` `b/`、`old/` `new/`、多套一层目录） | 文件全部 missing | **`-p` 自动探测**：对 p ∈ {0,1,2,3} 统计「能定位的文件数」，取命中最多且 ≥50% 的级别，并列取小 p；顶部下拉可手动改（`a/b/ (p1)` / `原样 (p0)`） |
| 根选错（选到子目录或父目录） | 匹配率骤降 | 顶部提示「当前根下只匹配到 0/4 个文件，可能根目录选错」+ 一键换根 |
| 少了中间目录（补丁写 `src/main.js`，实际在 `frontend/src/main.js`） | 该文件 missing | **唯一后缀匹配**：在根内找 `…/src/main.js`，**唯一命中才采用**，卡片标注「路径推断」；多处命中直接失败，不猜 |
| 目录结构完全不同 | missing | **手动重映射**：点路径 → 从候选里选，或「选择其他文件…」；映射按补丁 hash 记住 |

- **新建文件不做后缀推断**：新建必须由用户确认落点，只允许手动映射。
- 后缀匹配最多比较 3 级、大小写不敏感（Windows 语义），写回保留原大小写。
- 推断与映射都只影响"落到哪"，**不降低** §9.3 的上下文匹配严格度——路径对了但内容不对，照样 conflict。

### 10.5 路径规范化与安全（外部补丁不放松）

- 统一 `/`；**解码 git 的 C 风格引号路径**（`"a/\344\270\255\346\226\207.txt"` → 中文；`core.quotepath` 默认会把非 ASCII 转义，中文路径必踩）；
- 去尾部空格与点（Windows 非法）；大小写不敏感比较，保留原样写回；
- 越界（`..`、盘符、UNC、`/` 开头）、`.git/`、`.cadt/permissions.json`、符号链接/junction 逃逸 → **直接拒绝**，不做"智能修正"。

### 10.6 传输健壮性（对方发来的补丁常被改坏）

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| hunk 行数与 `@@` 头不符 | 聊天工具折行、编辑器自动换行 | `PATCH_PARSE` + 提示「可能被聊天工具换行破坏，请用「另存为」原始文件发送」 |
| 整份 patch 变 CRLF | Windows 编辑器保存过 | 解析前归一化为 LF，提示一次 |
| 中文路径乱码 | 对方按 GBK 存的 patch | 检测 GB18030 → 解码后解析，预览里提示 |
| 上下文差在行尾空格 | 传输工具去尾空格 | 勾「忽略行尾空白」（默认关，勾选后卡片明示） |

### 10.7 命令行

```bat
:: 只检查（默认，不写任何文件）
CaDt-DataLens.exe --check-patch  D:\inbox\fix.patch --dir D:\repo
:: 真正应用（必须显式 --yes）；默认 --atomic
CaDt-DataLens.exe --apply-patch  D:\inbox\fix.patch --dir D:\repo --yes
:: 只应用其中两个文件（scope 缩小，仍是 atomic：这两个必须全成功）
CaDt-DataLens.exe --apply-patch  D:\inbox\fix.patch --dir D:\repo --only frontend/index.html,frontend/src/style.css --yes
:: 允许部分成功（冲突文件跳过，其余写入）
CaDt-DataLens.exe --apply-patch  D:\inbox\fix.patch --dir D:\repo --partial --yes
:: 撤销
CaDt-DataLens.exe --revert-patch 20261113-130500-a1b2 --yes
```

- **不给 `--yes` → 只检查**，打印可应用/冲突清单，末行提示「加 `--yes` 才会写入」。这是对 §3.1「封死 CLI 应用」的修订：**允许命令行应用，但默认只读**。
- **模式**（§9.7）：默认 `--atomic`（全部成功或磁盘零变更）；显式 `--partial` 才允许跳过冲突文件。`--only` 只缩小范围，不改变模式。
- `--dir` 缺省：从 patch 所在目录向上找 git 仓库根；找不到则用 patch 所在目录。
- `--json` 输出机器可读结果：`{mode, applicable, applied, skipped, files:[{path, status, added, removed, reason, hint:{action, detail}}], added, removed}`。
- 退出码：
  | 码 | 含义 |
  | --- | --- |
  | `0` | 全部成功（或 `--check-patch` 下全部可应用） |
  | `1` | 有文件未被应用：`atomic` 下**磁盘零变更**；`partial` 下**部分已写入**（看 `--json` 的 `mode/applied/skipped` 区分） |
  | `2` | 路径或参数错误 |
  | `3` | 内部错误 |
  | `4` | 缺少 `--yes`，未写入 |
  | `5` | 回滚失败（有文件未恢复，需人工介入） |
- 失败/跳过时打印 §9.7.6 那套「每文件原因 + 建议」，而不是一句 `error: patch failed`。
- CLI 应用同样写索引与备份，并打印撤销命令；备份进工作区 `.cadt/patches/`（无工作区则应用数据目录）。

**实现位置**：仿现有 `--convert` 的路子——`convert_cli.go` 的 `parseConvertArgs`（`main.go:21`）+ `attachParentConsole()`，新增 `patch_cli.go` + `parsePatchArgs`，在 `main()` 里先于 Wails 启动判断，**不起 WebView、不开窗口**。

因此核心逻辑必须做成**不依赖 App 实例的自由函数**（`patchParse` / `patchBuildPlan` / `patchApply` / `patchRevert`），`App` 上的导出方法只是薄包装。否则 CLI 会被 `startup` 生命周期绑住，跑不了。

### 10.8 补丁格式的兼容约束

给别人的补丁要能被任何工具吃：

- **只写标准 unified diff**，不夹带私有头（不写 `# cadt:` 之类注释行、不写 JSON 元数据块）；
- 路径用 `a/` `b/` 前缀（`git apply -p1` / `patch -p1` 通用）；
- 归档信息（id、summary、baseHash、映射关系）**只存本地 `index.jsonl`**，不写进 patch 文件。

这样对方即使没装本应用，`git apply -p1 fix.patch` 也能直接用。

## 11. 测试计划

**Go `patch_test.go`（表驱动，约 73 例）**

- 解析：单/多文件、新建、删除、空文件、`@@ -1 +1 @@` 省略 count、`\ No newline`、git 前言、二进制 → unsupported、非法 hunk → 带行号 `PATCH_PARSE`。
- 匹配：多 hunk、CRLF、GBK、带 BOM、LF↔CRLF 混合、位移 +6 全局一致 → ok、位移不一致 → conflict、多处命中 → conflict、零上下文 hunk 偏移 → 拒绝、位移超 200 行 → conflict。
- 契约：预览后改目标文件 → `ApplyPlan` 整体拒绝且**无任何写盘**；预览后删文件 → 拒绝；planId 过期 → 拒绝。
- 反向校验：构造"能正向应用但反向还原不回来"的补丁 → 自动回滚且文件字节不变。
- 安全：`../` 逃逸、绝对路径、盘符、UNC、写 `.git/config`、同 patch 重复路径 → 全部拒绝。
- **并发保护（§9.8，约 8 例）**：同进程两个写操作并发（保存 vs 应用）→ 串行化且结果正确；跨进程锁被占用 → `PATCH_BUSY` 且不写盘；目标文件被独占打开 → `PATCH_FILE_LOCKED` 且预演阶段就失败（零副作用）；rename 前外部改内容 → `PATCH_CONCURRENT_MODIFIED` 且 temp 被丢弃、磁盘未变；rename 后外部改内容 → 读回校验发现并回滚；watcher 在应用期间不触发弹窗、应用结束后只发一次变更通知；应用成功后编辑器内容被替换且 dirty 清除（模拟 `Ctrl+S` 竞态）；partial 模式下单个文件被锁只跳过它，其余照常。
- **模式语义（§9.7，约 14 例）**：`atomic` 下第 3 个文件预演冲突 → 前 2 个**一个字节都没写**；`atomic` 下第 3 个文件提交阶段写失败（只读文件 / 独占句柄模拟）→ 前 2 个被回滚、sha256 与操作前一致；`partial` 同样场景 → 前 2 个保留、第 3 个标记 `skipped`、索引状态 `partial`；`partial` 下**全部**文件失败 → 状态为 `failed` 且磁盘零变更（不得写 `partial 0 个`）；越界路径在两种模式下都是整份拒绝（不是跳过）；回滚中途再失败 → 返回 `PATCH_ROLLBACK_FAILED` 且列出未恢复文件与备份路径；`partial` 下单文件回滚失败不影响已成功的其它文件；默认值断言（`App` 未传 mode → atomic；审批卡的默认值由前端传入，用前端测试覆盖）；预演与提交对同一输入给出完全相同的匹配结果（同一函数断言）。
- 事务：第二个文件失败 → 第一个不被写；写入失败 → 备份回滚。
- 撤销：apply → revert 后逐字节一致（含 EOL/BOM/编码）；应用后再改 → 三种 `onConflict` 各一例。
- 崩溃恢复：伪造未闭合 `applying` → `RecoverInterrupted` 列出可恢复文件。
- 错误文案：每类 `PatchCode` 的 `formatPatchError` 输出包含 code / 期望 / 实际 / 建议四段（防止将来被人改简写成一句话）。
- **路径不一致（§10，约 12 例）**：`a/` `b/` 前缀（p1）、`old/` `new/` 前缀、无前缀（p0）、多套一层目录 → `-p` 探测选中正确级别；根选到子目录 → 匹配率骤降并提示；`src/main.js` 对应 `frontend/src/main.js` 唯一后缀命中 → 标注推断；两个同名候选 → 拒绝推断；新建文件不做后缀推断；中文路径 C 风格引号 `"a/\344\270\255"` 解码；CRLF 的 patch 文件归一化；GB18030 编码的 patch 解码；尾部空格/点的路径被规范化；映射后写回保留原始大小写。
- **命令行（§10.7，约 12 例）**：`--check-patch` 不写盘且退出码 0/1；`--apply-patch` 无 `--yes` → 退出码 4 且不写盘；`--apply-patch --yes`（默认 atomic）→ 写盘并生成可撤销备份；atomic 冲突时退出码 1 且**目标文件 sha256 全部不变**；`--partial` 冲突时退出码 1 但已写入部分（`--json` 里 `mode/applied/skipped` 正确）；`--only` 子集在 atomic 下仍是"子集全成功"；回滚失败 → 退出码 5 + 未恢复清单；`--json` 字段完整（含 `hint.action`）；`--dir` 缺省时向上找 git 根（无 git 则退化）；`--revert-patch` 未知 id → 退出码 2；同一补丁重复 `--apply-patch --yes` → 第二次因 `BaseHash` 变化被拒（退出码 1）。
- 交叉验证（可选，无 git 则 `t.Skip`）：同一补丁 `git apply --check` 与内置应用器结论一致。

**语料**：把仓库里那份已失配的 `docs/unfinished-plans/ai-write-status.patch` 留作回归样本（预期 4 个文件全部 conflict，且每个 hunk 的原因都可读）。再加一份自己生成的、可成功应用的样本，组成 `testdata/` 最小对。

**前端 `patch-model.test.mjs`（纯函数）**

- 解析 `【patch:error】code=… retryable=…` 头 → 卡片错误态数据；统计、勾选子集、按钮可用态。
- 重试计数与熔断状态机（`patchAttempts`）：3 次后不再调用、`USER_DENIED` 不计数、成功后清零。
- `unifiedDiff` 补 `\ No newline` 后输出可被 Go 解析器往返解析。

## 12. 分批交付

| 批次 | 内容 | 规模 | 可交付状态 |
| --- | --- | --- | --- |
| **P0** | `patch.go`（解析 / 契约匹配 / **两阶段应用 + atomic·partial 两种模式 + 回滚** / 反向校验 / 备份 / 撤销 / WAL / **冲突建议文案**）+ **外部补丁：根解析 + `-p` 探测 + 手动重映射**（§10）+ `propose_patch`（含完全权限档抑制）+ `/patch` + `session.lastDiff` + `patch-workflow` 技能 + 审批卡（含模式开关）+ 错误回传与熔断 | Go ~1,550 / JS ~880 | 闭环可用：AI 出补丁 → 审批 → 一键应用 → 撤销；别人发来的补丁也能手动应用；失败/跳过都说清原因 |
| **P1** | 三种视图（补丁 / 代码 / 文本）+ 补丁视图 `patch-view.js` + **diff 语义高亮与整行背景** + 逐文件勾选 + 预检徽标 + **路径后缀唯一推断** + **CLI `--check-patch` / `--apply-patch --yes` / `--revert-patch`** | JS ~750 / Go ~250 + CSS | 补丁文件是一等公民：双击能看、能改、能用命令行批量用 |
| **P2** | 逐 hunk 勾选 + 「写入即补丁」开关 + 设置页「最近补丁」+ 路径映射记忆 + 应用后可选验证命令 | JS ~400 | 精细审核与历史管理 |

P0 内部分三步，每步可独立验收：
1. 解析 + 匹配 + 只读预览（**不写任何文件**）——拿真实补丁、以及"换一台机器路径不一样"的补丁各验一遍；
2. 应用 + 备份 + 撤销 + WAL；
3. 工具接入 + 技能 + 审批卡 + 错误回传/熔断 + 外部补丁的选根与重映射。

## 13. 已确认的决策（2026-11-13）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 应用器实现 | **Go 内置应用器为唯一主链路**（0 依赖、可逐 hunk、失败原因统一）；`git apply` 仅诊断提示，不参与执行 |
| 2 | `auto` 档补丁是否免确认 | **必须人工点一次「应用」**；补丁视作多文件批量写，误伤面大 |
| 3 | `.patch` 默认视图 | **默认进补丁视图**，工具栏一键切回纯文本 |
| 4 | 能力暴露方式 | **工具 `propose_patch` + 内置技能 `patch-workflow` 都要写进设计与验收清单**；技能进 `AI_BUILTIN_SKILLS`，不进 `docs/skills/` |
| 5 | 失败处理 | **以工具结果形式回给模型**（`【patch:error】code=…`），附期望/实际/修复建议；**不中断对话**，模型自修，最多 3 次后转人工 |
| 6 | 完全权限档 | **不主动出补丁、不主动追问「要不要存补丁」**；只有用户明确指定（触发词 / 点补丁入口 / 设置里选了补丁模式）才走 `propose_patch`（§3.3） |
| 7 | 无 AI 手动使用 | 解析/应用/撤销全在 Go，补丁视图直接调用；**不依赖 AI 面板、不消耗 token**（§10.2） |
| 8 | 命令行 | **允许 `--apply-patch`，但不带 `--yes` 只检查**；退出码 0/1/2/3/4 语义固定（§10.7）。修订了早期"封死 CLI 应用"的结论 |
| 9 | 路径不一致 | 依次尝试：工作区根 / git 仓库根 / 用户选根 → `-p` 自动探测 → **唯一后缀匹配**（仅已存在文件）→ 手动重映射；**新建文件不推断**，越界不"智能修正"（§10.4） |
| 10 | 补丁格式 | **只写标准 unified diff**，不夹带私有头；元数据只存本地 `index.jsonl`，保证对方 `git apply -p1` 也能用（§10.8） |
| 11 | 应用模式 | **两种模式可配**：`整体成功`（atomic）/ `允许部分成功`（partial）。**手动应用与 CLI 默认 atomic**；**AI 审批卡默认 partial**（§9.7.1）。两种模式都保证单文件不半写 |
| 12 | 失败信息 | 每文件 + 每 hunk 给「期望 vs 实际 + 原因 + 可执行建议」；partial 的跳过逐条列出；回滚失败单独上报并列备份路径，不允许弱化（§9.7.5 / §9.7.6） |
| 13 | 写入并发 | **不上独占锁**（会牺牲原子性）；改为「temp 写 + rename 前/后双重校验 + 冲突检测 + 可回滚」；同进程 per-path 互斥、跨进程工作区锁（复用 `sessionlock` 的 `LockFileEx`），锁只解决自己人打架（§9.8） |

补充：`ApplyPlan` 必须携带 `planId`，未预览过的补丁不允许应用。

## 14. 实施后的文档与版本

- `CHANGELOG.md`：新增「补丁文件与审批」小节（格式支持、AI 工具与技能、按钮位置、撤销行为、失败自修一句话）。
- `README.md`：格式表加 `.patch` / `.diff`；AI 能力段加「生成补丁 → 审批 → 一键应用」。
- `AGENTS.md`：Go 侧补 `patch.go` / `patch_test.go`；前端补 `patch-view.js`、`patch-model.js`；技能清单补 `patch-workflow`；依赖仍 0 新增。
- 版本三处同步升至 `v1.1.0`；本方案移入 `docs/finished-plans/`。

## 15. 自查清单：容易漏掉的 12 条

不是新需求，是通读方案时发现、必须在实现时明确的细节。每条都给了结论，避免写代码时临时拍脑袋。

| # | 细节 | 结论 |
| --- | --- | --- |
| 1 | `.patch` 自身带 UTF-8 BOM | 解析前剥除（PowerShell `Set-Content` 会加 BOM），否则第一行 `--- a/x` 匹配不上 |
| 2 | 补丁文件行尾是单独 `\r`（老 Mac） | 归一化为 LF 再解析；和 CRLF 一样只在解析层归一，不改用户文件 |
| 3 | 补丁文件本身只读 | 读取无影响；「另存为」与「撤销」不依赖它，照常可用 |
| 4 | 跨窗口通知 | 应用/撤销后要广播给**所有窗口**，不只是当前窗口；沿用 `WatchWorkspace` 的事件通道，否则另一窗口的标签页内容会是旧的 |
| 5 | 连续补丁的 `BaseHash` 陷阱 | 先应用 A 再应用基于旧基线生成的 B → 必然 `FILE_DRIFT`。错误文案要写「该文件可能已被另一个补丁改过，请重新生成 B 或改用部分成功跳过」 |
| 6 | 撤销是否进「本轮改动」列表 | **不进**。`session.changes` 表示"AI 改了什么"，撤销属于用户操作，只记 `activity.log('patch.revert')` |
| 7 | 索引重写的并发 | temp + rename + 工作区锁（§4.5.3），否则两窗口同时压缩会丢记录 |
| 8 | `manifest/` 的用途 | 索引损坏时的重建来源；撤销只依赖它和 `backup/`，不依赖 `index.jsonl` |
| 9 | 预览后的 30 分钟过期 | 过期不自动续命：返回「请重新预览」。宁可多点一次，也不要在用户不知情时换一份 plan |
| 10 | `planId` 与 `patchId` 的区别 | `patchId` 是存档身份（长期）；`planId` 是一次预览会话（短期、内存）。不要混用，撤销只认 `patchId` |
| 11 | 会话/索引里的绝对路径 | 索引只存 `relpath` + 根目录，绝对路径由调用方传入；避免工作区搬家后索引全部失效 |
| 12 | 用户没开工作区时打开补丁 | 不静默用应用数据目录当根（那会把文件写到奇怪的地方）：必须先让用户选目标文件夹（§10.3） |

## 16. 一句话总结

**补丁是这个应用里唯一"可存档、可转交、可撤销、可离线使用"的改动形态。** 因此它必须：格式标准（`git apply` 也认）、应用原子（按模式可配）、失败可解释（每文件每 hunk 给方案）、误改可回（字节级备份）、并且**不依赖内置 AI 也能用**。
