# AI 会话存储：磁盘 JSONL 追加式

> 分析/实施日期：2026-11-11
> 触发问题：localStorage 配额告急导致会话被**静默归档**，用户无从判断"对话为什么凭空少了一半"
> 参考实现：`D:/OraSkyC/Project/OpenSource/deepseek-harness`（下称 dsh）
> 原则：会话正文延续「单 exe、零依赖、系统提供引擎」，**不把主存储搬进 SQLite**；
> 2026-11-11 经作者同意，仅引入一个**可重建的派生 SQLite 搜索索引**（pure-Go modernc）
> 状态：**已实施**（Go 阶段 A + 前端阶段 B–E 已落地；版本号未变更，仍为 1.0.0）

---

## 摘要

| 项 | 原方案（localStorage） | 现方案（磁盘 JSONL） |
|---|---|---|
| 存储介质 | WebView2 localStorage 单 key（约 5 MB） | `%APPDATA%/…/ai-sessions/<id>/` |
| 写入方式 | 每次全量 `JSON.stringify(sessions)` | 追加式（append-only），单条 O(1)，每会话写锁串行 |
| 崩溃安全 | `setItem` 失败 = 该 key 数据全丢 | 追加式 + 每批 fsync + 失败回滚；撕裂尾截断，瞬态消息收尾为中断 |
| 列表加载 | 全量 blob 解析 | 每会话 `meta.json`，正文按需 |
| 压缩 | 无 | 不压缩，明文可直接 grep（决策见 §7） |
| 新增体积 | — | 会话存储 0；派生搜索索引 modernc ≈ 实测整包 **+3.9 MB**（详见 §3.9） |
| 会话数量 | 超上限自动删除（会删到正在用的） | **不再自动删除**；手动删除进回收站 |

---

## 一、原问题（已修复）

### 1.1 触发链路

```
setItem 抛 QuotaExceededError
  → stripSessionImages(keepNewest)   // 先砍图片
  → stripSessionImages(false)        // 再砍全部图片
  → archiveOldestMessagesForStorage()// 最后把最旧消息推进 session.archived
  → flash(...)                       // 30 秒内只提示一次，状态栏一闪而过
```

实测症状：某会话归档 **153 条**、界面只剩 **49 条**，用户完全不知道发生了什么。

### 1.2 同一根因的三个附带缺陷

| 缺陷 | 后果 | 处理 |
|---|---|---|
| `session.archived` 不参与消息流渲染 | 归档内容只能从弹窗或导出 Markdown 看到 | 保留（归档是上下文压缩的正常产物），弹窗可查 |
| `AI_ARCHIVE_LIMIT = 400` 超限 `.slice(-400)` | **真丢弃**，且原先静默 | 提到 5000，并保持显式提示 |
| `maxSessions()` 默认 50，超限删会话 | 原先优先删**未归档**的，等于优先删正在用的 | **删除自动淘汰逻辑** |

---

## 二、主流 harness 的存储方案

| Harness | 介质 | 格式 | 每会话独立 | 压缩 |
|---|---|---|---|---|
| **dsh** | 文件系统 `<root>/--<cwd>--/<id>/` | JSONL，仅追加 | ✅ | Zstandard（带校验和） |
| **opencode** | `~/.local/share/opencode/opencode.db` | SQLite | — | 数据库级 |
| **Claude Code** | `~/.claude/projects/` | 明文 JSONL | ✅ | 无 |
| **本项目** | `%APPDATA%/…/ai-sessions/<id>/` | 明文 JSONL | ✅ | 无 |

> dsh 来源：本机源码 `packages/session/session-persistence-jsonl/README.zh.md`；
> opencode 来源：`opencode.ai/docs/troubleshooting/`；Claude Code 来源：
> `docs.anthropic.com/en/docs/claude-code/data-usage`。

---

## 三、最终设计

### 3.1 磁盘布局（扁平，不按 workspace 分目录）

```text
%APPDATA%/CandySweet/CaDt-DataLens/
  ai-sessions/
    <encoded-id>/
      meta.json            # 会话摘要（列表只读它）
      session.v1.jsonl     # 事件日志：唯一真源
      .session.lock        # 跨进程写锁（空文件，常驻）
      images/
        <image-id>.png     # 图片外置，事件里只留 file 引用
```

**为什么不按 workspace 分目录**：启动参数 `--ai-session=<id>` 只带会话 id
（`app.go` 的 `OpenWorkspaceForConversation`），且 `session.workspace` 可变；
按 workspace 分组后按 id 查找要遍历全部目录，换工作区还要移动目录。
dsh 按 cwd 分组是因为 CLI 一次只在 cwd 里跑，本应用 UI 是全局会话列表，条件不同。

> 早期草案里的全局 `index.json` 已取消：多窗口（`--new-window` 是独立进程）同时写一个
> 全局索引会互相覆盖。改为每会话独立 `meta.json` 后，列表 = 扫目录聚合，无共享写点。

### 3.2 `meta.json`（原子替换）

```json
{
  "v": 1,
  "id": "session-mwbkc7pskomrq",
  "title": "这个项目是什么",
  "createdAt": 1794293140610,
  "updatedAt": 1794294355000,
  "workspace": "D:/OraSkyC/Project/CandySweet/CaDt-DataLens",
  "scope": "read",
  "profileId": "",
  "planMode": false,
  "archivedAt": 0,
  "messageCount": 49,
  "archivedCount": 153,
  "summary": {"text": "…", "upTo": 153},
  "todos": [],
  "changes": [],
  "approvedPaths": [],
  "logFile": "…-mwbkc7ps.md",
  "logSavedAt": 0
}
```

- 列表、排序、分组只读 `meta.json`，不碰正文。
- 先写 `meta.json.tmp` + `Sync`，再用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` 替换；
  非 Windows 用 `os.Rename`。
- 内容没变化时按签名跳过写入，避免每轮把全部会话的 meta 重写一遍。

### 3.3 `session.v1.jsonl`：头部行 + 事件行

```jsonl
{"v":1,"t":"header","id":"session-…","title":"…","createdAt":1794293140610,"workspace":"D:/…"}
{"v":1,"t":"msg","mid":"m-…","m":{"role":"user","content":"…","ts":…}}
{"v":1,"t":"msg","mid":"m-…","m":{"role":"assistant","content":"…","status":"done","usage":{…}}}
{"v":1,"t":"truncate","keep":7}
{"v":1,"t":"archive","keep":153,"summary":{"text":"…","upTo":153}}
{"v":1,"t":"meta","patch":{"title":"新标题"}}
{"v":1,"t":"reset"}
```

| 事件 | 语义 |
|---|---|
| `header` | 首行；便于单独用编辑器/`grep` 判读 |
| `msg` | 追加一条消息；`a:1` 表示直接进归档（整份重写时使用） |
| `truncate{keep}` | 保留前 N 条（编辑重发、重新生成） |
| `archive{keep,summary}` | 把前 N 条移入归档并设置摘要（`/compact`） |
| `meta{patch}` | 标题/工作区等标量变更 |
| `reset` | 清空（正常清空走整份重写，不留明文；此事件用于容错/外部工具） |

**为什么必须有 `truncate`**：本应用支持编辑重发、重新生成、压缩、清空——
这四种操作会改写历史。只追加 `msg` 的日志在重放时会把已删消息"复活"。

### 3.4 崩溃恢复（torn tail + 语义收尾）

- 追加前检查文件是否以 `\n` 结尾；不是则回扫到最后一个换行并 `Truncate`，再追加。
- 读取时忽略没有换行结尾的尾行（与追加行为保持一致）。
- **语义收尾（对齐 dsh 的 recovery closer）**：加载时把上次进程留下的瞬态状态就地降级——
  - `running` / `pending` 工具 → `error` + "执行被中断，结果未知"（等价 dsh 的 `TOOL_OUTCOME_UNKNOWN`）；
  - `streaming` assistant → `stopped`；
  - 挂起的审批 / 提问 / 环境变量创建 → 取消/过期。
  收尾后的状态会标记 `_needsRewrite`，启动加载完成后异步整份写回，磁盘上不再保留永久 `running`。
- 每批 append 写入后 `Sync`（fsync）；写入或同步失败把文件截回追加前长度，并在内存里回滚 `_mids`/`_logMeta`，下次持久化会重试这批消息。

### 3.5 多进程并发

`--new-window` 会起**独立进程**（`app.go` 的 `OpenNewWindow`），锁 ID 按参数区分，
WebView2 用户目录共享，因此多窗口并发写是真实存在的：

| 风险 | 设计应对 |
|---|---|
| 全局索引互相覆盖 | **没有全局索引**，每会话独立 meta |
| 两窗口同时追加同一会话 | 每会话 `.session.lock`：Windows `LockFileEx`、POSIX `flock(2)`，写操作串行；读取与删除不加锁 |
| 两窗口同时改写历史 | 写锁保证不会撕裂/交错；逻辑冲突仍是 last-writer-wins，下次加载以日志重放结果为准 |
| 写者卡死 | 取锁最多等 5 秒，超时返回"会话正被其他窗口写入"，不无限挂起 UI |

### 3.6 图片外置

- 消息里的图片在首次持久化时写入 `images/<image-id>.<ext>`，事件只存 `file: "images/…"`。
- 加载时通过 `AISessionReadImage` 读回 base64；读不到则保留"图片已归档"占位。
- 落盘失败时**退回内嵌 base64**，宁可撑大日志也不丢图。
- 原 `AI_IMAGE_STORAGE_BUDGET`、`trimSessionImagesForStorage`、`stripSessionImages`
  **整体删除**——磁盘没有 3.2 MB 预算问题。

### 3.7 读取上限

单会话正文超过 **64 MB** 时 `AISessionRead` 返回错误，前端提示"请先压缩或清空该会话"。
`/compact` 与清空都会整份重写正文，正常使用不会触顶；不做"只读尾部"，
因为尾部读取会丢 header/truncate/summary，无法正确重放。

### 3.8 保留策略

- **不自动删除会话**（磁盘足够；自动删除是数据丢失）。
- 单会话归档上限 5000 条，超出显式提示（仍建议导出 Markdown）。
- 手动删除会话 → 整个会话目录进回收站（Windows `SHFileOperation`）。
- 设置页的"会话保留上限"已移除；`aiMaxSessions` 仅保留在旧配置里不再生效。

### 3.9 派生 SQLite 搜索索引（2026-11-11 追加）

- 位置：`%APPDATA%/CandySweet/CaDt-DataLens/ai-index.db`（**在 `ai-sessions/` 之外**，删会话不清索引库）。
- 地位：**只是可重建的派生索引**，JSONL 仍是唯一真源；索引坏了删掉重建即可。
- 表：`sessions`（标题/工作区/计数/脏标记）、`messages`（live_index / mid / role / name / ts / text）、
  FTS5 `ai_messages_fts`（优先 `trigram`，不支持时退回默认分词 + LIKE 兜底）。
- 写入策略：会话写入只在索引已存在时标脏（`dirty=1`），首次搜索才创建 DB 并全量重建；
  搜索前重建所有脏会话，搜索只查 live 消息（归档不进结果）。
- 查询：≥3 字符走 FTS5（trigram 子串匹配），1–2 字符走 `LIKE`；标题命中排在最前；
  结果带 `\x01…\x02` 高亮标记，前端渲染 `<mark>` 并跳转到对应 live 索引。
- 体积：modernc.org/sqlite v1.62.0（pure Go，无 cgo），实测整包 exe 23.8 → 27.9 MB（**+3.9 MB**）；
  按当前 NSIS 45% 压缩比，安装包约 **+1.8 MB**。
- 诊断：会话数据诊断里显示索引会话/消息/脏数/字节数/trigram 状态，并可「重建搜索索引」（删库重来）。

---

## 四、Go 后端接口（`sessionstore.go`）

| 方法 | 作用 |
|---|---|
| `AISessionList() ([]string, error)` | 扫描 `ai-sessions/*/meta.json`，返回原始 JSON 数组 |
| `AISessionRead(id) (string, error)` | 读正文；不存在返回空串；>64 MB 报错 |
| `AISessionAppend(id, lines) error` | 追加若干行；写前修半行 |
| `AISessionRewrite(id, content) error` | 整份原子替换（迁移、清空、兜底） |
| `AISessionWriteMeta(id, data) error` | 原子写 `meta.json` |
| `AISessionDelete(id) error` | 删除会话目录（回收站） |
| `AISessionDeleteAll() error` | 清空全部会话目录（回收站） |
| `AISessionSaveImage(id, name, dataURL) (string, error)` | 图片写入 `images/`，返回相对路径；文件名白名单校验 |
| `AISessionReadImage(id, name) (string, error)` | 图片读为 data URL；拒绝路径穿越 |
| `AISessionSearch(q, limit)` | 查询派生索引；首次搜索自动建库、搜索前重建脏会话 |
| `AISessionReindex()` | 删除索引库并全量重建，返回已索引会话数 |
| `AISessionIndexStats()` | 索引会话/消息/脏数/体积/trigram 状态 |

平台差异按现有约定分文件：`sessionstore_windows.go`（`MoveFileExW`）+
`sessionstore_other.go`（`os.Rename`）。会话 id 严格校验（字母数字 `-_.`，不以点开头，≤128），
杜绝路径穿越。

**写路径**：`AISessionAppend/Rewrite/WriteMeta` 都会先取 `.session.lock`
（Windows `LockFileEx` / 其余 `flock(2)`，最多等 5 秒）；append 批次写完 `fsync`，
失败截回追加前长度。读取和删除不加锁。

---

## 五、前端结构（`frontend/src/ai-session-store.js`）

| 导出 | 作用 |
|---|---|
| `replaySessionLog(text)` | 纯函数重放：header/msg/truncate/archive/reset/meta → 当前状态 |
| `encode*` / `serializeSessionMessage` | 事件编码；图片有 `file` 时剥离 base64 |
| `buildSessionMeta(session)` | 生成 `meta.json` 摘要 |
| `createSessionDiskStore({backend,genId,onError})` | 磁盘适配：加载/增量持久化/归档/重写/删除（路径与图片文件由 Go 侧校验） |

`ai-panel.js` 只负责：
- `persistSessions()` → 逐会话调用 `store.persistSession(session)`（按 `_mid` 前缀差分，只追加新消息）。
- `/compact` 在裁剪内存**之前**调用 `store.archiveSession(session, cutoff, summary)`。
- 清空 → `store.resetSession()`（整份重写，真正抹掉明文）。
- 删除 → `store.removeSession()`；清空全部 → `removeAll()` 后重建当前会话。
- 面板每次打开按 2 秒节流重读磁盘，合并其他窗口的写入。
- 加载时把瞬态消息收尾为中断（见 §3.4），启动后异步写回。

纯函数与磁盘适配都有 Node 测试：
`node --test frontend/src/ai-session-store.test.mjs`（18 项，含追加/截断/归档/图片外置/归一化重写/失败重试/清空）。

---

## 六、迁移与回退

### 6.1 首次启动迁移

```
读 localStorage 的 datalens-ai-sessions
  → 对每个未迁移过的 id：写 <id>/session.v1.jsonl + meta.json（图片同时外置）
  → 重新按磁盘加载一遍（多窗口同时迁移时以落盘结果为准）
  → localStorage 原数据保留 30 天，id 记入 datalens-ai-sessions-migrated-ids
  → 失败：不清理 localStorage，本次回退到旧路径
```

- 记录的已迁移 id 集合避免"用户删掉的会话又被旧 blob 迁回来"。
- 迁移后再按磁盘重读，保证内存里的消息 id 与文件一致。
- 30 天后启动时清理旧 key；`datalens-ai-storage=legacy` 时不清理。

### 6.2 回退开关

```js
localStorage.setItem('datalens-ai-storage', 'legacy');   // 强制走旧 localStorage 路径
localStorage.removeItem('datalens-ai-storage');          // 恢复磁盘路径
```

legacy 路径保留旧的整包写入，但**不再做配额降级归档**：写失败只提示，不静默改历史。

---

## 七、明确不做

| 项 | 理由 |
|---|---|
| SQLite 作为主存储 / 配置存储 | 会话与配置需要明文、可手改、同步读取；主存储仍用 JSONL/JSON |
| SQLite 派生搜索索引 | **已做**（§3.9）：pure-Go modernc，可重建，不参与真源；同驱动另用于 CSV/TSV/JSONL 只读查询的临时库（`sqlview.go`） |
| zstd / flate | 第三方或不可 grep；明文排障价值高于磁盘占用 |
| 全局 `index.json` | 多窗口写竞争；每会话 meta 已足够 |
| 格式代际迁移 / Worker 校验 | 目前只有 `v:1` 一代，等 schema 真升级时再引入 |
| 只读尾部加载 | 丢 header/truncate/summary，重放结果错误 |
| 自动删除旧会话 | 数据丢失不可接受 |

---

## 八、验收

1. **配额消失**：写入 200 MB 会话后无 `QuotaExceededError`，无自动归档
2. **崩溃安全**：写入中杀进程，重启后会话可用，最多丢最后一批（每批 fsync + torn tail 单测覆盖）
3. **语义收尾**：重启后被中断的 `running` 工具显示为错误、`streaming` 回复显示为已停止，且磁盘不再保留这些瞬态状态
4. **多窗口**：两个窗口同时写同一会话不会出现撕裂/交错行；写者卡死时另一个窗口 5 秒后得到明确错误
5. **性能**：500 个会话时列表打开 < 200 ms（只读 meta；正文后台加载）
6. **明文可读**：`type session.v1.jsonl` 每条消息一行，图片不内嵌 base64
7. **迁移无损**：迁移前后 `messages.length + archived.length` 一致（迁移后重新按磁盘加载校验）
8. **可回退**：`datalens-ai-storage=legacy` 后旧数据仍可用
9. **改写历史正确**：编辑重发 / 重新生成 / `/compact` / 清空 后重放结果与界面一致
10. **索引可丢弃**：删除 `ai-index.db` 后首次搜索自动重建，结果与会话内容一致

---

## 附：与 `ai-logs/*.md` 的关系

| 产物 | 用途 | 格式 |
|---|---|---|
| `ai-sessions/<id>/session.v1.jsonl` | **唯一真源**，程序读写 | JSONL |
| `ai-sessions/<id>/images/` | 原始图片 | PNG/JPEG/WebP/GIF |
| `ai-logs/<title>-<id>.md` | 人类阅读 / 分享 / 排障 | Markdown |

`ai-logs` 保留不动——真实 `usage`、归档分段、日期追踪都靠它排查，
它的价值已被证明，不应被 JSONL 取代。
