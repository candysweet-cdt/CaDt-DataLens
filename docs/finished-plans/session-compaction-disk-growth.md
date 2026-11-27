# 会话压缩导致磁盘正文无限累加：根因诊断与改进方案

> 状态：**S1 / S2 / S3 已全部实施**（2026-11-22 成文并评审收敛，同日开工一次落地）
>
> 实施记录：Go `internal/sessionstore/vacuum.go`（Vacuum 状态机 + ReadArchive / ReadForce / ClearArchive，两步写清单恢复）+ `sessionindex` 拼接；前端 `ai-session-disk.js`（readBodyAutoTidy / 归档出栈对账 / 侧车消费点）+ `ai-panel.js`（拒载卡片 / 归档卡分页 / 导出 / 诊断）+ `ai-context-slim.js`（persistBudgetText）。护栏：`vacuum_parity_test.go` ↔ `ai-session-vacuum-parity.test.mjs` 双侧夹具（12 条）、`ai-session-disk-tidy.test.mjs`（三分流 / 出栈对账 / 手动整理 / 日志合并 / 预算化）、sessionindex 拼接测试。验证：`go test ./...` 全量、`npm test` 全量、`npm run build` 通过。群聊共享对话的自身增长暴露面维持「另立方案」不变。
>
> 双代理评审后的三处修正（同日落地）：① 重写前内存对账改为「只清 `_archivedMids` 登记过的前缀」——vacuum 只搬磁盘归档态，刚切进归档的未落盘尾部必须留在内存并随重写以 a:1 落盘（原实现全清 + 排除载荷 = 三处同时丢消息，P0）；② keep 的数值边界在浮点域钳制（int(1e20) 在 amd64 是 implementation-dependent，会变成「全删」而 JS 是「全留」），超界 JSON 数字（1e999）按 ±Inf 对齐；③ 崩溃恢复判定从 size+mtime 改为主文件内容哈希（Pre/PostMainHash），模糊窗口绝不盲截（截错丢「仅存于 sidecar」的归档），叠加 appendSidecarBatch 幂等比对兜重复；另补 reset×sidecar 清空、未知 schema 引信（拒绝整理）、AISessionVacuum 的另一窗口回合租约校验。
>
> 触发问题：两个历史会话正文分别涨到 **180.71 MB / 162.59 MB**，超过 `AISessionRead` 的 64 MB 上限被拒绝加载，启动时汇总弹出「部分会话读取失败：会话正文 180 MB，超过 64 MB 上限；请先压缩或清空该会话（共 2 个会话）」。
> 关键认知：**「压缩后磁盘累加」是全行业普遍设计，但本实现叠加了三个独有缺陷，才压出 180 MB 并撞上硬墙**。本文记录根因、六家横向调研结论与四期改进方案。
> 调研方式：6 个只读子代理对六个开源项目做源码静态分析（未运行构建/测试、未修改任何文件），结论均附 path:line 证据。
> 评审收敛（2026-11-22 第一轮）：①顺序反转——拆墙与救存量优先于降增速（裁决 1：治本/减量只降增速，runaway 会话迟早再撞墙）；②补两处调研遗漏的消费点（归档内容前端可查看、搜索索引扫主文件全文，裁决 2）；③原「分段/轮转」被 sidecar 归档出栈替代（裁决 3）。原三层内容吸收进 §5.1 的 S3。
> 第二轮深度调研（2026-11-22，五线并行：前端风险面清单、Go 重放语义规格、调用方与下游兼容盘点、180 MB 量级实测、六仓库实地复核）：**推翻第一轮的投影拆墙方案**——实测证明 180 MB 整份加载仅 ~450 ms / 峰值 544 MB（§3.5，硬墙前提不成立）；部分视图存在 `_needsRewrite` 恒真等 20+ 消费点雷区（§5.0 发现 2）。最终架构修订为「数据整形」：vacuum 归档出栈 + 256 MB 转为「打开即自动整理」阈值，对话永不因体积被阻断（§5）。

---

## 摘要

| 项 | 结论 |
|---|---|
| 现象 | 会话 `session-mwqm3upauppfi`（常见harness长文本粘贴调研）180.71 MB、`session-mwqnf883uh2lc`（执行计划隔离区开关改造）162.59 MB，共 2 个超限 |
| 直接原因 | 磁盘 JSONL 是 append-only，压缩只追加 `truncate`/`archive` 逻辑标记，**从不物理删除旧消息行**；180 MB 文件里有 76,863 条 `msg` + 597 条 `truncate` |
| 行业现状 | pi / codex / dsh / ZCode / opencode 压缩后磁盘**都会累加**；只有 Cline 用独立 sidecar 做到不累加 |
| 本实现独有缺陷 | ① 归档区整份重写放大（别家只追加标记）；② 工具结果只在请求时瘦身、落盘仍是全文；③ 全文读取 + 64 MB 硬上限（别家无上限或读时边界） |
| 改进方向 | 「数据整形」三体系（第二轮调研定稿）：S1 vacuum 归档出栈 sidecar + 归档读回通道 → S2 上限 256 MB 语义反转（超限打开即自动整理，对话永不因体积被阻断）→ S3 重写收窄 + 工具结果落盘预算化。Go 读时投影与部分视图经实测与风险面调研**否决留档**（§3.5、§5.2） |

---

## 1. 现象与影响

启动时 AI 面板补完会话正文后，收集加载失败的会话并走统一失败通知出口：

- 上限常量：`internal/sessionstore/sessionstore.go:36` → `aiSessionReadLimit = 64 << 20`（64 MB）。
- 超限报错：`internal/sessionstore/sessionstore.go:610-612` → `AISessionRead` 发现文件 >64 MB 直接返回「会话正文 X MB，超过 64 MB 上限；请先压缩或清空该会话」。
- 汇总弹通知：`frontend/src/ai/ai-panel.js:2420-2425` → `notifyFailure('部分会话读取失败', detail + '（共 N 个会话）', {key:'session-load', kind:'error'})`。

影响：

1. 超限会话**无法加载**——压缩、导出、改名全部被同一个 64 MB 上限卡住（导出前须先加载正文，`ai-panel.js:15764-15767`）。唯一出路是清空/删除。
2. 用户几乎没打多少字，文件却涨到 180 MB——膨胀来自工具消息条数（7.7 万条），不是对话文字量。
3. 已压了近 600 次仍触顶，说明**压缩在当前实现下对磁盘体积无效**。

---

## 2. 根因分析（本应用）

### 2.1 磁盘是 append-only，压缩只追加逻辑标记

会话正文存成单文件 JSONL（`<应用数据>/ai-sessions/<ws8>/<id>/session.v1.jsonl`），每行一个事件 `{v, t, mid, m}`。写入是追加式（`internal/sessionstore/sessionstore.go:623` 的 `Append` / `AppendWithCreate`）。

压缩落盘链路：

1. `startCompact`（`ai-panel.js:16058`）发摘要请求，只改内存；
2. `finishCompact`（`ai-panel.js:16307-16345`）算出 cutoff，调用 `sessionStore.archiveSession(session, cutoff, summary)`；
3. `archiveSession`（`ai-session-disk.js:390-468`）在磁盘上只 **append** 一条 `archive` 事件（`ai-session-disk.js:453`）+ 必要时一条 `truncate` 事件（`:436`），经 `AISessionAppend` 落盘（`:461`）。

**关键：被归档的旧消息行一行都没从磁盘删除。**

### 2.2 归档区有上限，但磁盘没有

- 归档区上限：`ai-constants.js:22` → `AI_ARCHIVE_LIMIT = 5000`；`ai-panel.js:2466-2472` 的 `pushArchivedMessages` 超出即 `slice(-5000)` 丢弃最旧并提示。
- 但磁盘文件里有 **76,863 条 msg**，远超 5000——因为归档上限只作用于**内存中的 `session.archived` 数组**，磁盘 JSONL 里的历史消息行不受它约束。

所以「归档区重写导致累加」这个直觉**不成立**：真正撑爆磁盘的是从未被物理删除的消息行，597 次压缩各追加一条标记，旧原文永久留存。

### 2.3 整份重写放大（本实现引入的额外缺陷）

加载端靠重放事件在内存里做遮蔽：

- `ai-session-store.js:301-305` 的 `truncate`：`result.messages = result.messages.slice(0, keep)`；
- `ai-session-store.js:306-313` 的 `archive`：把 `[0, keep)` 从 messages 挪进 archived。

这是纯读时投影，符合原型 dsh 的做法。但本实现还多了一条**整份重写路径**：

- `buildRewriteEvents`（`ai-session-disk.js:219-240`）把 `archived` + `messages` **全部重新 encode** 成事件数组；
- 触发点：`runPersistSession`（`:301-306`）、`archiveSession`（`:409-415`）在 `_needsRewrite` 或归档数组变动时，调用 `AISessionRewrite` 整份写回。

原型 dsh 压缩时**从不重写文件**（只 append `replace` 标记），本实现的 archived-rewrite 是移植时引入的动作。虽然单次压缩主要走 append 路径，但任何归一化/归档变动都会触发整份重写，把累积的历史再次完整落盘——这是累加的放大器。

### 2.4 全文读取 + 64 MB 硬上限

- 读取：`AISessionRead` 用 `os.ReadFile` 整份读入（`sessionstore.go:614`），无分段、无尾部读。
- 硬上限：>64 MB 直接拒绝（`:610-612`）。

六家里只有本实现「读全文且设硬上限」。别家要么全量读但无上限（只是变慢），要么有读时边界优化。结果是别人「慢」，我们「直接崩」。

### 2.5 证据链汇总

| 环节 | 位置 | 事实 |
|---|---|---|
| 上限 | `internal/sessionstore/sessionstore.go:36,610-612` | 64 MB 硬墙 |
| 全文读 | `internal/sessionstore/sessionstore.go:614` | `os.ReadFile` 整份读 |
| 压缩落盘 | `frontend/src/ai/ai-session-disk.js:453,461` | 只 append `archive`/`truncate` 事件 |
| 整份重写 | `frontend/src/ai/ai-session-disk.js:219-240,301-306,409-415` | archived 重新 encode + `AISessionRewrite` |
| 读时投影 | `frontend/src/ai/ai-session-store.js:301-313` | truncate/archive 在内存遮蔽 |
| 归档上限 | `frontend/src/ai/ai-constants.js:22` + `ai-panel.js:2466-2472` | 5000 条，仅内存 |
| 压缩入口 | `frontend/src/ai/ai-panel.js:16058,16307` | startCompact / finishCompact |

---

## 3. 六家横向调研

### 3.1 对比表

| 项目 | 存储 | 压缩后磁盘行为 | 累加? | 防护机制 |
|---|---|---|---|---|
| **pi** | append-only JSONL（session tree） | 追加一条 compaction 检查点，旧 entry 永不删 | 会 | 无上限；靠用户手动 branch 到新文件回收 |
| **codex** | append-only JSONL（rollout） | 追加 Compacted 检查点，**内嵌新历史全文** | 会（更狠） | 读时反向扫描到 checkpoint 即停 + 冷文件 zstd |
| **deepseek-harness** | append-only JSONL（原型） | 追加 `replace` 标记，读时遮蔽旧节点，从不重写文件 | 会（慢） | 无上限、无删除 API |
| **ZCode** | SQLite 行级 | 追加 summary + boundary 事件，旧行不删 | 会 | 工具结果入库前预算化+指针化 + JSONL 轨迹 64MB 轮转 |
| **opencode** | SQLite 行级 | 追加一条小 summary 行，按 compaction seq 截断读取 | 会（很慢） | 行级存储，压缩不放大 |
| **Cline** | 单文件 JSON + 独立 sidecar | 压缩结果写 `.compaction.json`（原子覆盖），canonical 文件不被压缩逻辑碰 | **不会因压缩累加** | 压缩与持久化彻底解耦 |

### 3.2 逐家要点（关键 path:line）

**pi**（`D:\OraSkyC\Project\OpenSource\pi`）
- `packages/coding-agent/src/core/session-manager.ts:1180-1197`（`_persist`）：首次 `openSync(...,"wx")` 写全量，之后一律 `appendFileSync`，从不 truncate。
- `session-manager.ts:1132-1142`（`_rewriteFile`）：唯一整份重写只用于迁移/初始化/手动 branch，压缩不触达。
- `agent-session.ts:3021` / `session-manager.ts:1278-1305`：压缩只追加一条 `type:"compaction"` entry。
- `test/rpc.test.ts:350-362`：回归测试明言「Append-only: pre-compaction entries are still there」。

**codex**（`D:\OraSkyC\Project\OpenSource\codex`）
- `codex-rs/rollout/src/recorder.rs:1750-1754,2108-2134`：append 模式打开，逐行写 JSONL。
- `codex-rs/core/src/session/mod.rs:4966-5110`：压缩只替换内存活历史；`:5098` 的 `replacement_history: Some(...)` 把压缩后历史全文塞进检查点。
- `codex-rs/core/src/session/mod.rs:5129-5136,5532`：检查点 append 到同一文件。
- `codex-rs/rollout/src/compression.rs:887-1010`：唯一的磁盘抑制是冷文件（≥7 天）zstd 压缩，对活跃会话无效。

**deepseek-harness**（`D:\OraSkyC\Project\OpenSource\deepseek-harness`，本应用原型）
- `session-persistence-jsonl/src/index.ts:994-1006,1529-1557`：`appendLines` 用 `open(path,'a')`，`packages/session/session-persistence-jsonl/README.md:79` 明言「Committed events are never rewritten」（第二轮复核修正 README 路径）。
- `compaction/compaction-basic/src/region.ts:211,238,492,507-508`：压缩追加 `compaction/start|summary|replace|end` 四类事件。
- `core/session/src/surface.ts:576`：`replace` 只在读时 `splice` 遮蔽内存节点，不删原始日志。
- `session-persistence-jsonl/README.md:169`：「Nothing deletes session files — logs accumulate until removed externally」。
- **关键**：dsh 没有「archived 消息区」，也没有整份重写路径——本实现的 archived-rewrite 不是同源设计，是移植时引入的。

**ZCode**（`D:\OraSkyC\Project\OpenSource\ZCode`）
- `apps/zcode-cli/docs/design/v2/compact/README.md` §1.7：设计裁决「Compact 必须进入 append-only session log」。
- `.../core/src/runtime/methods/compact-active.ts:699,718,744`：压缩只持久化 summary + append boundary + 替换内存 history，无磁盘删除。
- `.../core/src/tool/executor/result-serialization.ts:70-72,101-135,219`：工具结果**入库前**按 `maxModelBytes` 截断/落 artifact，落库的是预算后内容。
- `.../adapters/src/model/runner-debug.ts:35-41,497-530,537`：JSONL 轨迹有 64MB/256MB 硬上限 + 3 文件轮转（但 SQLite 正文本身无此保护）。

**opencode**（`D:\OraSkyC\Project\OpenSource\opencode`）
- `packages/core/src/session/sql.ts:84-121`：SQLite 行级存储 `session_message`/`session_part`。
- `packages/core/src/session/compaction.ts:898-931`：压缩结束只发事件；`message-updater.ts:427-470` 落成一条 compaction 消息行，无删除。
- `packages/core/src/session/history.ts:55-88,202-224`：按最新 compaction seq 截断读取，边界前旧行永不解码。

**Cline**（`D:\OraSkyC\Project\OpenSource\cline`）
- `sdk/packages/core/src/services/session-artifacts.ts:75-85`：messages 与 compaction 两个独立文件。
- `sdk/packages/core/src/session/stores/session-manifest-store.ts:305-312`：压缩态 `writeFileAtomic` 覆盖写 sidecar。
- `sdk/packages/core/src/session/stores/session-manifest-store.ts:220-261`：**修正（第二轮实地复核）**——canonical messages 并非 append-only，每次 persist 把全部 messages 整文件重写（`writeFileSync` :253）；压缩结果仍只塞进本次 request（`agent-runtime.ts:2319-2322`）。
- `sdk/ARCHITECTURE.md:643-664`：官方设计「canonical 全保真 + 压缩态独立 sidecar」。

### 3.3 行业共识

1. **压缩 = 上下文投影，不是磁盘回收**：6 家里 5 家压缩后磁盘累加，旧消息靠读时遮蔽/边界跳过。
2. **追加标记优于整份重写**：dsh/pi/codex/opencode 都只追加一条小检查点；本实现的 archived-rewrite 是少数派。
3. **两道普遍闸门**：① 单条消息体积预算（ZCode/Cline 在落库前截断 + 指针化）；② 读取边界或大小上限（codex 反向扫描、ZCode JSONL 轮转）。本实现两道都缺。

### 3.4 有界加载机制对照（六家怎么做 + 第二轮实地复核修正）

六家没有一家做「流式重放 → 结构化投影」这个形状；但有三家用别的机制达成了同一个目标（体积无关的有界加载），代价各不相同：

| 项目 | 有界加载 | 机制（path:line 见 3.2） | 代价 |
|---|---|---|---|
| **codex** | ✅ 最接近（半） | paginated 模式读时**反向扫描到最后一个合格 Compacted checkpoint 即停**（chunked 倒扫器从文件尾分块倒扫、超长记录直接丢弃不解析：`reverse_jsonl_scanner.rs:17-150`，停止条件 `rollout/src/model_context.rs:32-49`）；**修正：legacy rollout 仍全量正读**（`recorder.rs:1160-1226`），旧格式 checkpoint 缺字段时退化为全量重放 | checkpoint 内嵌压缩后历史全文（`replacement_history`，`mod.rs:5098`）——压缩一次文件涨一大截，即「累加更狠」的来源 |
| **opencode** | ✅ | SQLite 行级 + **按最新 compaction seq 截断读取，边界前旧行永不解码**（`history.ts:55-88,202-224`） | 真源必须在数据库里，靠主键 seq 随机访问 |
| **ZCode** | ✅（弱） | SQLite 行级存储；**细化（第二轮复核）：resume 时加载该会话全部行**，compaction 边界在内存阶段处理，比 opencode 的查询级截断弱（`repositories/messages.ts:226-243`、`resume.ts:116-118`）；调试 JSONL 轨迹另用「64 MB 硬上限 + 轮转」（超限重置动机注释：防 GB 级文件 native crash） | 同上，且轮转是丢弃式 |
| **pi** | ❌ | 纯 append-only 全量读 | 无上限只是变慢；靠用户手动 branch 回收 |
| **dsh** | ❌ | 读时遮蔽（`replace` 标记内存 splice，`surface.ts:576`），但**读还是全读** | 慢但不崩 |
| **Cline** | ❌ | sidecar 解耦压缩态（`.compaction.json` 原子覆盖）；**修正（第二轮复核）：canonical messages 并非 append-only，每次 persist 整文件重写**（`session-manifest-store.ts:220-261`）；读取整读（`runtime-host-support.ts:53-75`），坏文件静默返回 `[]` | 历史规模随当前消息集缩涨（不累加），但整读 + 危险方向的静默降级 |

两种「付费换边界」的现成机制在本项目都不可抄：

1. **codex 式**（checkpoint 内嵌全文）：本质是把「重复落盘」从压缩路径挪进了 checkpoint——正是本实现要消灭的「整份重写放大」的另一种形态（本实现的 archive 标记只有几十字节，codex 的 checkpoint 是整个上下文）。
2. **opencode/ZCode 式**（真源进 SQLite）：违反本项目「会话正文 JSONL 唯一真源、SQLite 只进派生索引」的体积红线约束（AGENTS）。

三问三答（第二轮实地复核）：

1. 「后端流式重放 → 有界投影」**没有一家做完整形状**——codex 的 chunked 倒扫器（`reverse_jsonl_scanner.rs:17-150`）实现了「流式扫描」半边（真·分块、内存只持一个 chunk + 一条记录缓冲），缺「结构化投影 + 字节预算」那半边；opencode/ZCode 用数据库随机访问绕过；pi/dsh/cline 全读。
2. **物理瘦身 / vacuum 无先例**——LSM major compaction、git pack、Kafka segment 合并式的「同日志物理整理」一家都没有。最近邻：codex revert 的替换 rollout 文件（`revert_thread.rs:120-152`，语义触发）、dsh 格式迁移的 ~1 MiB 切片流式物理重写（格式触发）、opencode revert 物理删行（语义触发）——触发条件都不是体积。
3. **超大文件降级恢复无先例**——家家只有坏行容错与 torn tail 修复（dsh 最完整：物理截尾 + zstd 帧级部分恢复），没有一家做「文件太大 → 部分加载继续会话」的路径；cline 的 sidecar「删除安全」注释契约（`session-manifest-store.ts:286-300`）是唯一把恢复出口写成明文的。

第一轮曾据本表推出「投影是约束组合下的唯一解」；第二轮实测（§3.5）推翻了其中「必须有界加载」这个约束本身的必要性——**整份加载实测便宜，约束可由「更高上限 + 数据整形」替代，读取路径不必改造**。本表保留作为机制对照；codex 倒扫器保留为 §5.3 Go 流式重放的参考实现。

### 3.5 本机实测：整份加载的成本基线（2026-11-22 第二轮调研）

夹具生成器模拟事故形态（~9 万条消息、平均 ~2.3 KB/条、每 128 条一条 archive/truncate 标记、平均条宽与事故文件一致），四种配置；用仓库真实 `replaySessionLog`（`frontend/src/ai/ai-session-store.js`）计时。Node 与 WebView2 同为 V8 系，量级可信：

| 夹具 | 大小 | 整份读入 + 重放 | 峰值内存（RSS） |
|---|---|---|---|
| 归档密集（89 600 条归档，事故形态） | 180 MB | **~450 ms**（读 121 + 重放 326） | 544 MB |
| 全量 live（90 043 条不压缩） | 180 MB | **~590 ms**（读 118 + 重放 464） | 544 MB |
| 归档密集 | 64 MB | ~140 ms | 247 MB |
| 全量 live | 64 MB | ~160 ms | 263 MB |

Go 侧 bufio 流式逐行扫描（不解析 JSON）180 MB ≈ **85 ms**——vacuum 的物理成本上限。外推口径：真实消息对象比夹具重（审批对象、meta 字段、附件引用），按 1.5–2x 估计仍有充裕余量；图片水合（`hydrateImages` 把全部附件 dataURL 读进内存，`ai-session-disk.js:747-780`）是独立于正文大小的内存变量，需单独观察。

**结论：64 MB 硬墙所防御的场景在实测中并不危险，防线保守约 4 倍**——这是 S2 把上限扩到 256 MB 的直接依据，也是「事故会话直接可开可聊」的依据。

---

## 4. 本实现独有的三个缺陷

| # | 缺陷 | 别家做法 | 后果 |
|---|---|---|---|
| 1 | archived 整份重写放大（`ai-session-disk.js:219-240`） | dsh/pi 只追加标记，从不重写 | 归一化/归档变动时把累积历史再次完整落盘 |
| 2 | 工具结果只在请求时瘦身，落盘仍是全文（`CHANGELOG.md:902` 明言「只瘦请求、不瘦历史」） | ZCode 入库前按 `maxModelBytes` 截断 + artifact 指针 | 单条消息体积无界，长文本调研类会话尤甚 |
| 3 | 全文读 + 64 MB 硬上限（`sessionstore.go:36,614`） | 无上限 / 读时边界 / 分段轮转 | 别人只是慢，我们直接拒绝加载 |

三者叠加：缺陷 2 让单条变大、缺陷 1 让重写放大、缺陷 3 让触顶即崩——这是 180 MB 事故的完整成因。

---

## 5. 方案定稿（2026-11-22 两轮评审收敛）

> 第一轮收敛出「投影拆墙」架构；第二轮深度调研（前端风险面全量清单、Go 重放语义规格、调用方与下游兼容盘点、180 MB 量级实测、六仓库实地复核）**推翻了投影方案**，修订为「数据整形」架构。本节为最终定稿；被否决的方向与理由一并留档（§5.2），防止将来未带证据重提。

### 5.0 三条硬发现（第二轮调研证据）

**发现 1（实测，§3.5）：64 MB 硬墙的前提不成立。** 180 MB 事故形态整份读入+重放 ~450 ms、峰值 RSS 544 MB；64 MB 仅 ~150 ms / 250 MB。64 MB 常量是未经测量的防线，保守约 4 倍——事故会话今天就能直接加载，墙防御的场景实测中并不危险。

**发现 2（风险面）：部分视图 / Go 读时投影在本代码库不可安全实现，否决。** 逐点核查 20+ 个消费点：

- 致命：`_needsRewrite` 判定是「内存条数 ≠ 重放条数」（`ai-session-disk.js:658,727,545`）——部分视图下恒真 → 每次持久化按内存窗口整份重写磁盘，**把窗口外历史全部抹掉**。
- 致命：压缩 cutoff（`ai-compact.js:40-98`）、truncate/archive 的 keep（绝对下标语义）、rewind/编辑重发/重新生成的 `truncateAt`（`ai-panel.js:14664-14864`）全部假设 `messages[0]` = 会话第一条。
- 隐蔽：`buildApiMessages`（`ai-panel.js:5941-6132`）按窗口组装 → 窗口外 live 消息不进模型请求；token 估算随之偏低 → **auto-compact 永不触发**——部分视图自己会制造「永不压缩」的会话类别。
- 另有 quote 下标漂移（`ai-quote.js:29-38` 随消息落盘持久化）、fork/支线静默截断（`ai-session-fork.js:21-32`）、导出与对话日志静默丢历史（`ai-panel.js:15792-15847`、`ai-session-disk.js:924-952`）、meta 计数失真（`ai-session-store.js:359-426`）、列表角标丢失（`ai-session-list.js:254-268`）等 10+ 处。

第一轮设想的「绝对 keep + partial view 禁重写」护栏需要整套 `_partial` 体系（meta 四分支、三处 `_needsRewrite` 判定点、`_mids` 对位、导出/日志/fork 补全谓词）才守得住——收益配不上风险。

**发现 3（盘点）：下游恢复机制大半现成。**

- 多窗口：`handleResourceChange`（`ai-panel.js:2730-2779`）已实现「日志 stat 变化 + 租约空闲 → 自动 `reloadSession`」——vacuum 重写主文件后，其他开着该会话的窗口自动重读，零新机制。
- usagestats：游标自带 `PrefixHash`「识别文件被截断/重写」（`internal/usagestats/store.go:219`）——vacuum 后自动全量重扫，幂等 upsert，免特判。
- sessionindex：`store.Read` 失败静默 `continue`（`sessionindex.go:403-405`）——两个事故会话今天在搜索索引里就是缺失的；重索引先 DELETE 后重插（`:285`），拼接 sidecar 即可补全。
- 群聊暴露面（新发现）：群聊共享对话复用同一 `sessionstore.Store`（`internal/aigroups/aigroups.go:41,47`）→ 同受读上限约束，但群聊**没有任何自动压缩**（手动 compressShared 是唯一出口）——存储层最脆弱的暴露面；扩限（S2）顺带解除它的墙，群聊自身的瘦身另立方案。

### 5.1 最终架构：数据整形替代读取改造

**设计公理（不变）**：磁盘可以无限涨，唯一红线是「不能继续对话」。
**实现路径（修订）**：不改造读取路径，改造数据形状。live 段被 auto-compact 的 token 阈值结构性约束（默认 262144 token 窗口 ≈ live 约 0.5–2 MB；极端 8 M 窗口 ≈ 32 MB，`ai-config-model.js:8-9`；auto-compact 触发点 `ai-panel.js:16271-16305`，阈值 0.8）——vacuum 把归档挪进 sidecar 后，主文件 = live ≈ **结构性小于任何合理上限**。墙不是被拆掉的，是变得够不着了。

```
主文件 session.v1.jsonl = header + meta + summary + live（被上下文窗口天然约束）
sidecar archive.v1.jsonl = 归档消息（append-only，永不整读、永不重写）
```

#### S1 止血：vacuum 归档出栈 + 归档读回通道

- 新绑定 `AISessionVacuum(id)`：Go 流式逐行重放主文件（bufio，内存有界；实现合同见 §5.3），把归档态消息统一重编码为 `a:1` 事件（`m` 用 `json.RawMessage` 保字节原文，防 number 精度丢失）**追加**进 sidecar `<id>/archive.v1.jsonl`；主文件原子重写为 header + meta 事件（按序保留）+ summary（经 meta patch 回发，`ai-session-store.js:319-326` 语义）+ live 消息（**原始行逐字保留**：重放时记录每个存活事件的原行号，结束时按行号抄写）。复用 `atomfile.WriteFileAtomic` + `withSessionLock` 五层锁（`sessionstore.go:367`）+ 回合租约空闲校验。truncate 孤儿前缀直接丢弃（重放语义本就丢弃，`ai-session-store.js:301-305`）；坏行跳过并计数（与前端 `issues` 一致）。**meta.json 不动**（live/archived 计数均不变）。
- 新绑定 `AISessionReadArchive(id, offset, limit)`：分页读 sidecar（有界）。
- **归档消费点接线（先于任何入口开放，顺序钉死）**：查看已归档消息（`ai-panel.js:5209` archivedView）、导出 Markdown（`:15792-15847`）、对话日志自动落盘（`ai-session-disk.js:924-952`）改为「内存 archived + 按需分页读 sidecar」；sessionindex 扫描拼接 sidecar（归档在前、主文件在后，与时间序一致）。
- 触发方式三类：①**打开超限会话时自动触发**（S2 的语义反转，唯一自动写盘路径，理由见 S2）；②会话列表右键「瘦身归档」（≥16 MB 显示，想提前回收空间时手动用）；③拒载卡片「重试整理」（自动整理失败时）。
- 多窗口/派生索引/用量统计按发现 3 免特判；vacuum 后自身窗口直接 `reloadSession`。
- 顺手改报错文案（`sessionstore.go:612`「请先压缩或清空该会话」在拒载语境下是死循环指引）。
- `dev/mock-backend.js` 补 `AISessionVacuum` / `AISessionReadArchive` 同名 mock（约定）。

#### S2 上限语义反转：256 MB 从「拒绝服务」改为「打开即自动整理」

- `aiSessionReadLimit` 64 MB → **256 MB**，语义反转：超过它不再拒绝对话，而是**下次打开时自动触发 vacuum 后照常加载**——前端 `loadOne` 捕获超限错误（稳定错误前缀 `session-too-large:`，不做字符串模糊匹配）→ 调 `AISessionVacuum` → 重试 Read → toast 一次「已自动整理：归档 N 条移入侧车，正文 X→Y MB」（消息中心去重）。实测背书：整理耗时与体积线性（85 ms 级流式扫描/180 MB），整理一次该会话永久回归常态。**任何体积的会话都能打开并继续聊——对话永不因体积被阻断。**
- 「不自动写盘」原则的**唯一例外**即此路径，理由链：①无损整理（append-only sidecar + 语义等价重写，无任何删除）；②触发时机是用户「打开会话」这个主动动作；③目标会话此刻必然无人加载（超限本就读不出来），无双持有者风险——与 wipe-guard 保护工作区用户文件的语境不同，不构成静默破坏性写入。
- **不做尺寸徽标 / 阈值横幅 / 跨阈值 toast**（2026-11-22 作者裁定）：体积意识收敛到「打开即整理」的行为本身 + 右键「瘦身归档」入口；列表不挂任何体积 UI。
- **修订（同日，实机验证反馈，两轮收敛）**：列表增挂**一个二值「超限」胶囊**（warn 色，`sessionOverLimitOf`：`_liveDominant` / `_tidyFailed` / 已载入 stat 体积 > 256 MB 三类可判定来源；懒加载占位无 stat 不判定）——用户无法把「共 N 个会话读取失败」对上号。判定线一度下调到旧版 64 MB 上限想覆盖「200 多 MB 能正常打开」的会话，作者复核后收回：胶囊严格卡 256 MB（与 session-too-large: 同口径），221 MB 能正常打开的不算超限；启动「部分会话读取失败」通知保留并**点名会话**（最多 3 个）——它正是用户得知「有个 270 MB 会话」的主动信号，与胶囊（被动）并存。
- **两个事故会话（180.71/162.59 MB）**：在 256 MB 阈值内直接可开可聊（实测 ~450-590 ms），无需整理。
- 拒载卡片只保留给两类真失败：自动整理执行失败（磁盘错误，卡片提供「重试整理」）与「整理后仍超限」的 live 主导会话（§5.4 真空角落）。

#### S3 降速：重写收窄 + 工具结果落盘预算化

**重写收窄（原 5.2，实施时修订——评审发现全量排除有丢消息窗口）**：

- `buildRewriteEvents`（`ai-session-disk.js:219-240`）不再把 archived 重新 encode 进主文件；整份重写只写 header + meta + summary + live——**与 S1 vacuum 的主文件重写共用同一条实现**（vacuum 输出的主文件形状 = 本条想要的目标形状，前端 Rewrite 收敛后不再有第二种写法）。
- **实施修订（双代理评审 P0）**：vacuum 只搬「磁盘上已是归档态」的消息，而压缩进行中刚切进归档的尾部尚未落盘为归档态——直接排除载荷会把它们三处同时弄丢。落地语义改为：重写前 vacuum 出栈 + 内存只清 `_archivedMids` 登记过的前缀（= 磁盘归档态全集），未登记尾部保留在内存并随重写以 a:1 落盘，下一次 vacuum 再搬走。稳态（无在途压缩）下载荷仍是 header + meta + summary + live 的目标形状。
- `AISessionRewrite` 收敛为迁移/归一化场景 + 体积断言（重写后不得比重大，除非确有新增消息）。
- 归档不再逐条在主文件重编码后，「查看已归档消息/导出」由 S1 的 `AISessionReadArchive` 分页承接——这也是 S1 先于本条落地的原因。

**工具结果预算化（原 5.3）**：

- `ai-context-slim.js` 的「超阈值落盘 + 指针」从只作用于**请求**扩展到**落盘前**：`content` 存预算后内容（头 4 K + 尾 1 K + 长度 + 路径指针），全文留在 `ai-artifacts/`；全文 >4 MB 直接只存指针。阈值沿用现有常量（内置 8 192 / 外部工具 `mcp__`·`plugin__` 50 000 字符）。
- `ai-artifacts` 已是应用数据目录下唯一对模型可读的子树（`ai-read-roots.js`），指针读回链路现成。
- 量化：每条消息只落一次 `a:0` 行 + 工具结果指针化 → 平均消息约 2.4 KB 降至 0.5–1 KB；配合 auto-compact 的 live 上限，主文件增速降一个数量级以上。

**涉及文件**：`internal/sessionstore/`（vacuum / ReadArchive）、`internal/sessionindex/`、`frontend/src/ai/ai-session-disk.js`、`frontend/src/ai/ai-context-slim.js`、`frontend/src/ai/ai-panel.js`（归档消费点接线）、`internal/aiartifact/`（已有，复用）。

### 5.2 明确不做（留档防重提）

| 否决项 | 理由 |
|---|---|
| Go 读时投影（第一轮 S2） | 发现 1：不需要——整份加载实测便宜（§3.5）；§3.4：无先例且两种现成机制不可抄（codex checkpoint 内嵌全文＝重写放大变体；SQLite 真源＝违反本项目红线） |
| 部分视图 / live 尾窗 + liveBase | 发现 2：20+ 消费点雷区，`_needsRewrite` 恒真会静默抹历史；`_partial` 护栏体系成本远超收益 |
| vacuum 裁剪 live | live 已被 auto-compact token 阈值结构性约束；裁剪 live = 无摘要的上下文丢失（语义破坏），且实测证明大 live 也加载得起 |
| 分段/轮转（第一轮原 5.1） | 丢弃式轮转丢历史；segment 拼接复杂度高于 sidecar 出栈且 §3.4 Q2 证实无先例 |

### 5.3 实现合同：Go 重放状态机要点（vacuum 专用）

vacuum 是全方案唯一的新状态机。语义规格已由第二轮调研逐行核定（事件总表、不变量清单、20 条坑清单，评审记录留档），要点：

1. 与 `replaySessionLog`（`ai-session-store.js:249-357`）逐事件同构：`v` 缺失视为 0（`NaN > 1` 为 false 的漏收是特性，`store.js:284-287`）；`a` 按真值判断；truncate/archive 的 keep clamp 到当前 live 长度、truncate **不动 archived**；reset 清 messages/archived/summary 但保 header/meta；meta patch 按行序折叠、仅 `summary` 键有旁路；dedupeKey 折叠必须在全部事件重放后、只对 live、留每 key 最后一条。
2. torn tail 丢尾行（与 `atomfile.RepairTornTail`、前端 `torn=true` 三方一致）；streaming 消息按写盘断点防御处理。
3. 固定 JSONL fixture 双侧跑（Go 状态机 vs `replaySessionLog`）防语义漂移；fixture 覆盖 N 次 truncate/archive/reset/meta 交错、坏行、torn tail、`a:1` 直接归档事件。
4. 原子性与幂等：sidecar 追加成功后才重写主文件；任一步失败保留原状；**进锁后重 stat，体积已 ≤阈值直接跳过**（双窗口同时打开同一超限会话时第二方为 no-op）；返回统计带 `liveDominant` 标记（整理后主文件仍 >阈值 = live 段自身过大，供 §5.4 真空角落分流）；超限读取错误带稳定前缀 `session-too-large:`（前端据此分流自动整理）。
5. 流式实现参考 codex chunked 倒扫器（`codex-rs/rollout/src/reverse_jsonl_scanner.rs:17-150`：分块读、内存只持一个 chunk + 一条记录缓冲、超长记录不解析直接丢弃——我们正读即可，重点借鉴其内存纪律）。

### 5.4 超限处理路径（行为定义，修订版）

- **≤256 MB**：正常加载、正常对话，无任何体积 UI。
- **>256 MB**：打开时自动整理（S2 语义反转）→ toast 一次 → 照常加载、照常对话，此后永久回归常态。**不存在「因体积不能聊」的状态**——这是设计公理「唯一红线是不能继续对话」的最终落实。
- **自动整理失败**（磁盘错误等）：拒载卡片「重试整理」；此时会话保持只读（`_loadError` 写保护保留，`ai-session-disk.js:270`），但与事故时「压缩/导出都要先加载、加载又被拒」的死循环有本质区别——出口（vacuum）不依赖加载（Go 流式处理，实测 85 ms/180 MB，任意体积成立）。
- **真空角落（live 段自身 >256 MB，vacuum 返回 `liveDominant`）**：需要关闭 auto-compact 且把 live 写到 8M token 窗口理论上限的 8 倍以上，实际概率趋零。处理：不再自动重试加载，卡片说明原因并给「临时加载」（用户自担慢；按实测比例 512 MB 峰值 ~1.5 GB，可承受但接近边缘）——载入后开启 auto-compact 并手动 `/compact`，即刻回归常态。
- 存量事故两个会话（180.71/162.59 MB）：**直接可开可聊**（256 MB 上限内）；需要回收空间时右键「瘦身归档」一键 vacuum，历史全程无损。
- 数据完整性不变式：任何路径不得物理删除未消费原文；sidecar 只增不改；删会话随目录整体回收站删除（`Store.Remove` → `recycle.Move` → 墓碑）可撤销；`_loadError` 写保护仅存在于「整理失败」与「真空角落」两种残余态。

---

## 6. 实施步骤与验证

按 **S1 → S2 → S3** 顺序，每期独立可验收、独立提交：

| 期 | 交付物 | 验收 |
|---|---|---|
| S1 | `AISessionVacuum` + `AISessionReadArchive` + 归档消费点接线 + 右键/卡片入口 + sessionindex 拼接 sidecar + 文案修正 + mock | 事故形态夹具（180 MB 归档密集）：vacuum 后主文件 ≈ live 大小；查看归档/导出/对话日志/搜索可达归档内容；多窗口开着该会话时 vacuum → 另一窗口自动重读 |
| S2 | 上限语义反转（>256 MB 打开即自动整理）+ `session-too-large:` 错误契约 + 整理 toast + 拒载卡片改造 | 夹具实测：64/180 MB 直开可聊（<1 s）；256 MB+ 夹具打开 → 自动整理 → toast → 可聊；双开同一超限会话第二方 no-op |
| S3 | 重写收窄（与 vacuum 共用主文件重写实现）+ 工具结果落盘预算化 | 「长文本调研」型会话反复 `/compact` 50 次磁盘增长有界（每次仅 +标记行/指针行） |

验证方式：

- **fixture 双侧重放测试**：固定 JSONL 样例（N 次 truncate/archive/reset/meta 交错、坏行、torn tail、`a:1` 直接归档）同时喂 Go 状态机与 `replaySessionLog`，断言语义一致（§5.3 要点 3 的专项护栏）。
- 基准夹具回归：§3.5 的四份夹具纳入验收清单，口径 = 加载 <1 s、无 OOM。
- 集成回归：事故会话脱脂副本（拷贝进临时目录）走 S1/S2 验收链路；导出 Markdown 能看到归档消息。
- `dev/mock-backend.js` 同步补齐全部新绑定（约定）。
- 跑 `npm test` 全量 + `go test ./...`（后台执行，带 `-timeout 300s`）。

---

## 7. 风险与权衡

- **体积红线**：全方案零新依赖（纯文件操作，无压缩库、无新存储引擎），符合「单 exe、零依赖」。
- **内存边界**：256 MB 上限对应的加载峰值 ~800 MB RSS（按实测比例外推）——已接近渲染进程舒适区边缘，这是硬拒线留在 256 MB 而非更高的原因。**图片水合是独立变量**：附件极多的会话内存峰值可能与正文大小无关（`hydrateImages` 全量 dataURL 化），扩限后观察，必要时另立「附件懒水合」方案。
- **兼容性**：sidecar（`archive.v1.jsonl`）对旧版本透明——旧版本读变小的主文件照常工作，sidecar 被当普通文件忽略；不做破坏性迁移、无 schema bump。
- **历史不丢**：任何路径不得物理删除未消费原文（不变式见 5.4）；truncate 孤儿前缀是唯一被丢弃的内容，且重放语义本就丢弃（`ai-session-store.js:301-305`）。归档消费点接线完成前不开 vacuum 入口（顺序钉死）。
- **Go 重放同构**：vacuum 状态机与 `replaySessionLog` 的语义漂移是最大实现风险，fixture 双侧测试钉死（§5.3 要点 3）；`v` 缺失视为 0 等「特性级」行为逐条复刻。
- **群聊暴露面**：群聊共用引擎与读上限（扩限受益），但无自动压缩——已知暴露，另立方案；本方案不解决群聊增长。
- **合同变更面**：`AISessionList` 仅加字段（向后兼容）；新读路径是新增绑定，旧绑定语义不变；`dev/mock-backend.js` 按约定同步。
- **工作区防护**：改动集中在应用数据目录逻辑，不碰工作区文件；vacuum 的自动触发是「不自动写盘」原则的唯一例外，理由链记录在 §5.2 的 S2 小节（无损整理 + 用户打开动作触发 + 此刻必然无其他加载者）；双窗口竞态由 §5.3 幂等（进锁重 stat）兜底。

---

## 8. 参考来源

**本应用**
- 会话存储设计：`docs/reports/session-storage-jsonl.md`
- 分段压缩评估（已归档）：`docs/reports/ai-segmented-compact.md`
- 上下文瘦身 CHANGELOG：`CHANGELOG.md:902-907`
- 死锁组成（第一轮补查）：`internal/sessionstore/sessionstore.go:36,610-614`（上限 + 整读）· `frontend/src/ai/ai-session-disk.js:270`（`_loadError` 写保护）
- append 无体积检查：`internal/sessionstore/sessionstore.go:623`
- 重放状态机（Go vacuum 的同构基准）：`frontend/src/ai/ai-session-store.js:249-357`
- 索引扫主文件全文 + 失败静默跳过：`internal/sessionindex/sessionindex.go:400-405,704`
- 归档消费点：`frontend/src/ai/ai-panel.js:5209,6197,15836` · 对话日志 `ai-session-disk.js:924-952`
- 多窗口自动重载（第二轮补查）：`frontend/src/ai/ai-panel.js:2730-2779`（`handleResourceChange`）· `sameLogStat` 协议 `ai-session-disk.js:739-745`
- usagestats 游标 PrefixHash（第二轮补查）：`internal/usagestats/store.go:219`
- 群聊共用引擎（第二轮补查）：`internal/aigroups/aigroups.go:41,47`
- 部分视图风险面代表点（第二轮补查，否决投影的依据）：`_needsRewrite` 判定 `ai-session-disk.js:658,727,545` · 上下文组装 `ai-panel.js:5941-6132` · auto-compact `ai-panel.js:16271-16305`
- 上下文窗口配置（live 上限依据）：`frontend/src/ai/ai-config-model.js:8-9`（默认 262144 token，clamp 上限 8M）

**六个开源项目**（本地源码，均为只读静态分析）
- `D:\OraSkyC\Project\OpenSource\cline`
- `D:\OraSkyC\Project\OpenSource\codex`
- `D:\OraSkyC\Project\OpenSource\deepseek-harness`
- `D:\OraSkyC\Project\OpenSource\opencode`
- `D:\OraSkyC\Project\OpenSource\pi`
- `D:\OraSkyC\Project\OpenSource\ZCode`

> 说明：六家结论来自源码静态分析，未运行构建/测试验证运行时行为；path:line 基于调研时的工作树，实施前需按当前版本复核。
