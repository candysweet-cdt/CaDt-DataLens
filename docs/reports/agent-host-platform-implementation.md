# agent-host-platform 实施复盘

> 对应方案：`docs/unfinished-plans/agent-host-platform.md`（v7）
> 代码依据：`docs/reports/workspace-isolation-audit.md`
> 实施时间：2026-11-25 夜 – 11-26
> 状态：**A–F 全部落地并通过自动化验证；G 真机演练未做（需人工）**

## 1. 为什么写这份文档

执行期的任务书与逐批记录原本放在 `.cadt/tmp/agent-host-platform/`，该目录属于「一键清缓存」范围
（`storage` 的 `ws-tmp` 条目），11-26 11:23 清理 1.2 GB 时被一并清掉。
结论性内容因此回收到这里（`docs/` 不在任何清理范围内）。

**教训**：`.cadt/tmp` 按设计是可回收缓存，**AI 长任务的执行记录不该放那里**——要么放 `docs/`，
要么放应用数据目录。方案 §4.9 已把「`.cadt/tmp` 可能被别的窗口崩溃自愈清掉」列为已知风险，
只是没有约束到自己的文档。

## 2. 批次与结果

| 批次 | 内容 | 结果 |
|---|---|---|
| A（S0） | `scopeRootOf(session, env)` 四步解析 + `decideSessionOpen` 的 `switchInPlace` | ✅ 17 测试 |
| B（S1a） | 工具路径改会话根：`aiResolveScopePath` / 两处 `aiRelPath` / `resolveScanRoot` / `isAutoWriteRisky` / 生成产物 / TTS / `propose_patch` / `write_worklog` / `cognitionWorkspace` / 两处 `subSandboxPolicy`；`ai-worktree` 加 `pathInsideWorkspace` 归属断言；`gitRollbackPaths` 三参 | ✅ |
| C（S1b） | `fileio.SaveFileAtomic`（`SaveFile` 一个字节未改，用户文档仍走非原子写） | ✅ 基线 420→421 |
| D（S1c） | wipe-guard `preCommand` 返回 `{root, fp}`、`postCommand` 以快照根为准；空根时记日志 | ✅ 11 测试 |
| E（S2） | `<workspace_context>` 分层渲染；`resolveMemoryDir` 禁回落；`MEMORY.md` / `permissions.json` 走锁通道；认知 / 技能缓存 Map 化；cognition 窗口分桶 | ✅ |
| F（S3） | `--harness` 全链路；`bridge-ui` 不恢复工作区；独立快照槽 `cadt.session.harness.v1`；backing workspace；per-root wipe-guard + 多根 watcher；新建会话三选一 | ✅ 8 接线守卫 |
| G | 端到端演练 D1–D4 | ⬜ **未做（需人工）** |
| H | 独立终审 | 🟡 部分（见 §5） |

**验证**：`npm test` 全量 exit 0（**1672 pass / 0 fail**）；`go build ./...` 通过；绑定基线 **420 → 428**；
`--harness` 链路逐跳确认。

## 3. 设计要点（实施中形成的判断）

1. **窗口不持有根**：`scopeRootOf` 是唯一来源；`windowWorkspace()` 降级为投影缓存。普通窗口下会话根
   恰好等于窗口根，行为零变化。
2. **撤销窗口级写权占位**：六个参考 harness（opencode / pi / ZCode / codex / cline / deepseek）无一先例。
   并发安全改由「会话租约 + 路径级写边界 + 越界升权审批」。副产品：解除「同仓库不能双窗口」的限制。
3. **路径与相对路径必须同源**：`aiResolveScopePath`（绝对）与 `aiRelPath`（相对）用同一个根，
   否则污染变更卡、备份归属、worktree 写闸、cognition 直写闸。
4. **上下文注入用分层渲染而非过滤**：`getWorkspaceContext().openFiles` 还有第二个消费者
   （`pickOpenFileMatch` 把回复里的裸文件名解析成可点击芯片），过滤会把它弄坏。
5. **wipe-guard 必须 per-root**：它坏了不丢数据，而是「该报警时不报警」——2026-11-18 事故的唯一自动防线。

## 4. 三轮审查抓到的实质问题

### 第一轮（预审，A–F 完成后）
11 条，其中 3 条 🔴，**全部是「模块写对了、接线没接」**：
- `currentSessionScopeRoot` 未导出到面板 API → main.js 的 typeof 守卫恒假 → wipe-guard 监听与周期校准全不注册。
- `wipeguardIsAIActive` 被改坏：从「窗口根有没有活跃 AI」变成「当前会话是不是这个根」→ A 会话删文件、
  用户切到 B 时告警投不出去。
- 指纹兜底三处仍传窗口根 → harness 下 `preCommand` 直接 `return null`，整条兜底静默关闭。

### 第二轮（H1 复核）
发现上面第 1 条**实际没修**，而当时的接线测试**是绿的**——它断言的是 ctx getter，不是面板返回对象。
**假绿的测试比没有测试更危险**。已补属性、改断言，并用「删掉属性后正则必须不匹配」做反向验证。

### 第三轮（终审 · 代码正确性）
11 条（🔴1 / 🟡6 / 🟢4），Go 侧锁类「已查无问题」。已全部处理：

| 级 | 问题 | 修法 |
|---|---|---|
| 🔴 | `aiProjectRoot`：noWorkspace 会话沙盒未就绪时回落窗口工作区 → `memory_write` 写进真实仓库 | noWorkspace 会话无根时直接返回 `''`，绝不回落 |
| 🟡 | `openWorkspaceFolder` 的 `currentKey` 只看 `workspaceFolder`，harness 恒空 → `switchInPlace` 永不命中 | 改用会话根优先 |
| 🟡 | `sessionRoot` 在 `scopeRootOf` 返回空后回落 `getScopeRoot()` → 未绑定会话拿活动文件父目录当范围根 | 有注入即完全信任（空即空） |
| 🟡 | `getSkillsCache().at = 0` 只失效当前桶 | 改调 `invalidateSkillsCache()` 全桶 |
| 🟡 | `wipeguardNotifyAt` 只增不减 | `releaseWipeguardWatch` 同时回收 |
| 🟡 | 记忆管理无根时仍 `AIEnsureDir('')` 并拼 `/MEMORY.md` | `mem.dir` 空即按「不可用」收口 |
| 🟡 | `backingWorkspaceCache` 失败缓存 `''` 无失效路径 | 只缓存成功值；失败 5s 后可重试 |
| 🟢 | 个性化页 / 设置页空 dir 显示误导 | 显式显示「不可用」 |
| 🟢 | `normalizeWsKey` 不归一点段，与 `workspaceKey` 口径不同 | 归一点段 + 新增测试（5 种写法同键） |
| 🟢 | 第③层用全局 `wipeguardLastToolAt` | **不改**：条件已限定当前会话根，影响仅为「切走后最多漏投一次提醒」；代码注释写明边界 |

## 5. 未完成项（都需要人工）

### G 真机演练
前置：**先重编 exe**（`tools\rebuild-exe.cmd`）。不重编跑的是不含 `[wipeguard] 窗口 N/seq` 日志的旧构建，
D1 会一直显示 `NEEDS REVIEW`——那是预期不是失败。

四条必检：
1. `--harness` 开窗：面板自动打开、不恢复上次工作区、**能恢复 harness 自己的标签**（读 `cadt.session.harness.v1`）。
2. D3：A 会话删 ≥40 个文件（10s 内）+ 立刻切到 B → 红条 + 消息中心 + 告警**插队投递给 A**。
3. 关窗回收合成 watcher 槽（`wipeguardSlots` 的 `releaseWindowOwnedState` 路径，单测造不出）。
4. 演练前后 `git status --porcelain` 必须一致。

判据（D1 用 seq，不靠告警 N 猜）：
- 切根往返后 `seq` 单调递增、不回落；
- 演练目录用 `%TEMP%\cadt-wipeguard-drill\`，**绝不能在 `.cadt/` 下**（`.cadt` 在 `WIPEGUARD_SKIP_ANY_DIRS` 里，事件全被跳过，演练会静默通过）；
- 造数文件名避开 `dist/build/out/bin/coverage/node_modules` 等 skip 词；
- 脚本若用 PowerShell 5.1，`.ps1` 必须 **UTF-8 with BOM**（无 BOM 会让中文关键字匹配失效 → 判定静默通过）。

### H 完整终审
`hy4-flash-free` 走云端，两次 `wsarecv` 连接超时失败。H1（复核预审项）成功；
第三轮（代码正确性）成功。**缺一轮「设计意图 + 回归风险」的全面终审**，建议网络稳定时补。

## 6. 改动规模

- 43 个已有文件改动 + 14 个新增（净 +2035 / −270 行）
- 新增 Go 包：`internal/aibacking`、`internal/aimemory`、`internal/aipermissions`、`internal/workspacemark`、
  `internal/cognition/lease.go`
- 新增前端模块：`frontend/src/ai/session/ai-new-session-picker.js`
- 绑定基线：420 → 428（8 条新增，逐条有 mock 与 `backend.d.ts`）
