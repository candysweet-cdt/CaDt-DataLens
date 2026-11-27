# CaDt-DataLens 全项目代码审查报告（2026-11-27）

> 本报告由 18 个并行子代理按域极细粒度只读审查 + 主代理跨切面横向扫描汇总而成。
> 审查为纯只读，未修改任何业务代码。所有结论均带具体位置，可点击文件路径跳转核对。

## 一、审查概况

| 项 | 内容 |
|---|---|
| 审查日期 | 2026-11-27 |
| 审查方式 | 18 个子代理并行、按域极细粒度只读审查 + 主代理跨切面横向扫描 |
| 覆盖范围 | Go 非测试 6.9 万行（306 文件）、前端 15.4 万行（335 文件）、测试 8.4 万行（482 文件）、构建/脚本/插件/配置 |
| 验证手段 | 子代理实跑 `go test` / `node --test` / `git 实证` / 跨平台 `go build` / vtable 常量比对 / 版本号同步校验 |
| 工作区状态 | 审查针对当前含 61 项未提交改动的树；已确认多个缺陷在 HEAD 中即存在，非本轮改动引入 |

**结论摘要**：共确认 **9 项严重、约 34 项重要、约 30 项建议**。项目整体工程质量高——安全模型、竞态防护、崩溃恢复、硬规范护栏（设置同步/弹层栈/图标/表单/类型生成）都经过多轮打磨且有测试护航。但存在一簇真实且用户可见的缺陷，集中在四类：① 凭据/密钥处理（明文落盘、SSRF 外泄）；② 失败路径静默吞错（回滚、清理、备份）；③ 事故兜底失效（wipeguard CAS 快照）；④ 工具链与遗留代码失修（脚本路径漂移、v2 遗留）。

### 分片与子代理清单

| # | 分片 | 覆盖 | # | 分片 | 覆盖 |
|---|---|---|---|---|---|
| 1 | Go 根包 | 34 个 package main 文件 | 10 | AI 会话聊天 | `ai/session/` + `ai/chat/` |
| 2 | 数据库搜索 | `dbclient` `search` `sqlview` `reading` | 11 | 文件补丁 | `patch` `patchcli` `fsops` `fileio` 等 |
| 3 | 其余 Go 包 | `gitinfo` `cognition` `plugins` `oauthquota` 等 | 12 | AI 其余能力 | `ai/agent` `group` `settings` `gen` `security` |
| 4 | AI 会话存储 | `sessionstore` `storage` `usagestats` 等 | 13 | 安全沙箱 | `wipeguard` `sandbox` `cmdbridge` `dpapi` 等 |
| 5 | AI 传输工具 | `aitransport` `mcp` `webtools` `aigen` 等 | 14 | 运行终端窗口 | `run` `terminal` `browser` `windowreg` 等 |
| 6 | 前端组合根 | `main.js` `mock-backend.js` `app-pages` | 15 | 前端 core-bridge | `core/` + `bridge/` |
| 7 | ai-panel | `ai-panel.js`（21441 行） | 16 | 前端编辑阅读 | `editor/` `reading/` `writing/` |
| 8 | AI 工具定义 | `ai/tools/` + `ai/core/` | 17 | 前端其余域 | `shell` `settings` `db` `git-graph` 等 |
| 9 | 测试质量 | 168 个 Go 测试 + 314 个前端测试 | 18 | 构建脚本 | `tools/` `scripts/` `build/` 配置与插件 |

---

## 二、严重问题（P0 · 建议立即修复）

### S1. `OpenDevTools` 是 Wails v2 遗留实现，在 v3.1.0 上 100% 失效
- **位置**：`platform_windows.go:202-240`（`a.ctx.Value("frontend")`、`FieldByName("chromium"/"mainWindow")`）
- **问题**：项目已迁移 Wails v3（`go.mod:11`），但该函数仍反射 v2 私有结构。v3 从不向 context 注入 `"frontend"` 键，`a.ctx.Value("frontend")` 恒为 nil，必然返回"无法访问界面实例"。反射路径还缺 `recover`，有 panic 击穿绑定层风险。
- **影响**：设置页开启开发者模式后点"开发者工具"永远失败。
- **修复**：改用 v3 公开 API `(*WebviewWindow).OpenDevTools()`，窗口取自 `callerWindow(ctx)`/`currentWindow()`；同步绑定基线与 `backend.d.ts`。〔Go根包分片〕

### S2. `gitRun` 只返回 stdout、丢弃 stderr —— 签出冲突对话框永久失效（已实证）
- **位置**：`internal/gitinfo/gitinfo.go:130-145`，受害点 `:534`
- **问题**：git 把 `error: Your local changes ... would be overwritten by checkout:` 及文件清单写到 **stderr**，代码只 `return stdout.String()`。子代理在临时仓库实证：冲突时 stdout 为空、stderr 含完整清单。
- **影响**：`parseCheckoutConflictFiles` 恒返回空，前端三选一冲突处理对话框（强制/智能/不签出）永远无法触发，用户无法从 UI 处理脏工作树签出。
- **修复**：失败时把 stderr 并入返回文本（或新增 `gitRunBoth`），并修正 `graph_test.go:244` 把错误文本塞进 stdout 的失真夹具。〔其余Go包分片〕

### S3. OAuth 额度查询 URL 前缀校验可绕过，Bearer token 泄露到任意主机
- **位置**：`internal/oauthquota/fetch.go:35-40`（`strings.HasPrefix(target, p.ConsoleOrigin)`）、`:50`（`Authorization: Bearer`）
- **问题**：只做字符串前缀比较。`https://platform.sensenova.cn.evil.com/x`、`https://platform.sensenova.cn@evil.com/x` 均通过校验，而 URL 来自用户可编辑的额度脚本文本（不可信）。现有测试只测完全不同域名，覆盖不到前缀绕过。
- **影响**：长期有效的 OAuth access token 被发给攻击者域名，凭据外泄。
- **修复**：用 `net/url` 解析，严格比对 scheme+host、拒绝 userinfo，并补两类绕过 URL 的测试。〔其余Go包分片〕

### S4. 生图产物下载把鉴权头发给服务端返回的任意 URL（API Key 外泄 + SSRF）
- **位置**：`internal/aigen/aigen.go:293-315`（`aiGenDownloadURL`）
- **问题**：产物 URL 来自生成服务端响应，代码只检查 `http(s)` 前缀，不校验 host；同时把含 `Authorization: Bearer {{apiKey}}` 的请求头原样带上。恶意/抢注 URL（云元数据 `169.254.169.254`、内网、攻击者域名）都会收到 Key。与 `webtools` 严格的 URL 校验形成信任级别倒挂。
- **影响**：API Key 泄露 + 以本机为跳板的 SSRF。
- **修复**：校验产物 host（拒绝环回/私网/链路本地，或仅允许与生成端点同 host），仅同 host 时转发鉴权头。〔AI传输工具分片〕

### S5. localStorage 配置镜像未脱敏 `profile.proxy`，代理凭据明文落盘
- **位置**：`frontend/src/ai/ai-panel.js:1280-1301`（`mirrorWithoutKeys`），关键 `:1295-1297`
- **问题**：函数注释明确要清除"代理地址里的 user:pass@"，但实际只对**顶层** `copy.proxy` 做替换，而 `normalizeAIConfig` 产出的配置**根本没有顶层 proxy 字段**——proxy 只在每个 `profile`（ `:999`）。profile 循环只清了 apiKey 等，没清 `profile.proxy`。
- **影响**：配置形如 `http://user:password@proxy.host:8080` 时，明文凭据被写进未加密的 localStorage 镜像（磁盘配置是 DPAPI 密文），备份/云同步会一并带走。
- **修复**：在 profile 循环内脱敏 `profile.proxy`，删除失效的顶层分支，补单测。〔ai-panel 分片〕

### S6. 阅读扫描 4 个 worker 并发写 `scan.Warnings`，数据竞争
- **位置**：`internal/reading/reading.go:465-487`（`scanReadingDir` 起 4 worker）、`:500`、`:554`（`append`）
- **问题**：`processReadingFile` 在两个分支直接对共享 slice `append`，多 worker 并发读写同一 slice header，`go test -race` 必报。
- **影响**：警告丢失（用户看不到"文件已跳过"）、race 检测下 CI 失败、极端情况 slice 头损坏。
- **修复**：`ReadingScan` 加 `sync.Mutex` + 带锁 `warn()` 方法，统一所有 append 点。〔数据库搜索分片〕

### S7. 补丁回滚链路两处数据丢失（敏感区）
- **位置**：`internal/patch/patch_write.go:280-339`（回滚失败码）、`:437-466`（stash 备份）
- **问题**：① `PATCH_ROLLBACK_FAILED` 常量定义了却从未被赋值，六处回滚失败只设其他错误码，CLI 的"⚠ 有文件未能恢复"分支是死代码；② `onConflict="stash"` 时 `os.WriteFile(.revert-backup)` 的错误被 `_ =` 丢弃，随后照样强制覆盖用户改动。
- **影响**：回滚失败被静默降级，用户不知道工作区处于半应用/半回滚状态、拿不到备份路径；选了"另存后撤销"却静默抹掉改动且无备份——正是 AGENTS.md 记载事故的同型形态。
- **修复**：回滚返回非空时统一改写错误码并保留原因；stash 备份必须成功（用原子写）才允许覆盖。〔文件补丁分片〕

### S8. wipeguard：L1 备份与 L3 CAS 快照共用 blob 库，GC 只认 L1 索引 → CAS 快照 7 天后系统性失去可恢复性
- **位置**：`internal/wipeguard/backup.go:389-425`（`referenced` 仅由 L1 `keep` 行构造）、`snapshots.go:452`（写同一 `objects/`）
- **问题**：CAS manifest 按 hash 引用 blob，但 `gcOrphanBlobs` 的引用集只收集存活 L1 行。L1 保留 7 天、CAS 保留 28 天，7 天前的 CAS 快照 blob 几乎必然被清；反之 `pruneSnapshots` 删 manifest 后其独占 blob 又从不回收。
- **影响**：这是整个包存在意义（事故后兜底恢复）的直接失效——点"还原快照"得到 `blob 读取失败`，且无前置提示。
- **修复**：GC 引用集同时覆盖 L1 索引 + 全部存活 CAS manifest，做统一可达性回收。〔安全沙箱分片〕

### S9. 5 个脚本因 AI 源码目录重构路径未同步，全部崩溃（已实证）
- **位置**：`scripts/train-local-classifier.mjs:12-13`、`eval-public-corpus.mjs:14-16`、`export-model-catalog.mjs:5`、`plugins/command-classifier-onnx/scripts/train-head.mjs:26`、`verify.mjs:70`
- **问题**：仍从旧路径 `frontend/src/ai/ai-local-classifier.js` 等导入，文件已在 `133dd23` 重构中迁到 `ai/security/` 与 `ai/core/`。子代理实跑三个主仓脚本均 `ERR_MODULE_NOT_FOUND`，且确认 HEAD 中旧路径已不存在。
- **影响**：AGENTS.md 指定的重训出厂权重命令、公开语料评测、模型目录导出、ONNX 语义头训练全部失效；`npm test` 与构建测试门都不覆盖这些脚本，CI 全绿也发现不了。
- **修复**：更新 5 处 import/输出路径，并加一条"脚本可解析"守卫测试纳入 `npm test`。〔构建脚本分片〕

---

## 三、重要问题（P1 · 建议本轮处理）

### 安全 / 凭据

| # | 位置 | 问题与影响 | 修复方向 |
|---|---|---|---|
| I1 | `internal/oauthquota/auth.go:112-124` | `jwksCache.entries` map 无锁并发读写，Wails 多窗口并发刷新额度可触发 `fatal error: concurrent map read and map write`，崩溃整个 GUI 进程 | 加 `sync.RWMutex`/`sync.Map` + 并发单测 |
| I2 | `internal/envvars/envvars.go:84-88,149-176` | DPAPI 解密失败被静默吞成空串；换机/换用户后只要保存一次任意变量，就把所有解不开的密钥整体覆盖为空，且 `MergeEnv` 注入空值 | 解密失败 fail-closed（参照 `aiconfig.ErrSealed`），解不开时拒绝写回 |
| I3 | `internal/aiusage/aiusage.go:113-118` | 白名单查询把错误响应体原文回传前端，未像同域另一路径那样做密钥脱敏；网关回显 header 时泄露 API Key | 复用 aigen 脱敏函数处理错误片段 |
| I4 | `internal/webtools/webtools.go:374-419` | SSRF 校验用 `LookupIP` 验 IP、`net/http` 连接时重新解析 → DNS 重绑定（TOCTOU）可绕过，访问内网/元数据 | 校验后 pin IP（`DialContext` 连已验证 IP） |
| I5 | `tools/build-installer.ps1:6,182,247` | 证书口令以 `/p <明文>` 进 signtool 并拼进 `SIGN_ARGS` 传给 makensis，进程列表可见 | 改用指纹 `/sha1`，或从安全源读取且只单次展开 |
| I6 | `tools/build-installer.ps1:261-263` | 两次 `signtool verify` 只检查第二个的退出码，本体验签失败被吞 | 逐个捕获并断言退出码 |

### 数据一致性 / 崩溃恢复

| # | 位置 | 问题与影响 | 修复方向 |
|---|---|---|---|
| I7 | `internal/storage/clear.go:59-70` | 部分删除成功（`Freed>0`）即计入"成功"，密钥文件残留也不进 `failed` 列表——破坏性操作误报成功 | 按"是否有残留"判定失败 |
| I8 | `internal/usagestats/usagestats.go:200-208` | `Close()` 与并发 `Record`/`SyncAll` 有窗口，清理 ai-usage 瞬间可能拿到已关闭句柄，子代理用量（不可重建）静默丢失 | 取句柄+执行放同一临界区，或 RWMutex |
| I9 | `internal/activity/activity.go:42,295-303` | `activityPruneAt` 跨 goroutine 无锁读写，data race | 纳入 `activityMu` 或独立锁 |
| I10 | `internal/wipeguard/backup.go:85-102` | L1 写前备份存的是**解码后文本**（`[]byte(call.Content)`），非磁盘原始字节 → 带 BOM/GBK 文件还原不保真 | 备份时 `os.ReadFile(absPath)` 取原始字节（L3 CAS 已是字节精确） |
| I11 | `internal/sandbox/sandbox_windows.go:576-640` | 沙箱退出后残留 ambient-delete deny ACE，宿主 `os.RemoveAll(tempDir)` 被拒且错误被吞 → 私有 temp 持续泄漏 | 在撤销 ACL 前先清 temp，或 Close 内移除 deny |
| I12 | `internal/dbclient/service.go:29-36` | `DBReadImportFile` 先 `os.ReadFile` 后判 20MB → 拖入 2GB 文件直接 OOM/卡死 | 先 `os.Stat` 判大小再读（同包 `sqlview` 已正确） |
| I13 | `internal/dbclient/query.go:53-73` | 多语句批量查询任一条失败即返回全零值 `QueryOutcome`，已执行结果/Writes 计数全丢，用户误判"到底改没改数据" | 出错时返回已累积结果 + 错误说明 |
| I14 | `internal/appservices/process.go:198-203` | 健康检查置 failed 后不杀进程，用户点 Start 再起一个 → 双实例与 id 冲突，服务再也无法重启 | failed 后调 stop 收口进程 |

### 功能正确性 / 异步竞态

| # | 位置 | 问题与影响 | 修复方向 |
|---|---|---|---|
| I15 | `frontend/src/ai/tools/ai-tool-cards.js:47-50,1075` | `edit_file` 参数在 2026-11-16 改名（oldString/newString）时漏改工具卡，仍读 snake_case → ± 行数统计从头到尾不显示（已由 git blame 定位根因） | 统一 camelCase + 补工具卡参数守卫 |
| I16 | `internal/reading/reading_search.go:121,287-290` | 全书搜索大小写折叠只作用于源文本、不作用于查询词 → 搜 "HELLO" 命中不了 "hello"，测试用全小写查询恰好掩盖 | 查询词同样折叠 + 回归测试 |
| I17 | `frontend/src/reading/reading.js:541-557,738-761` | 长章节"继续阅读"分块复用首块缓存 id → 每次都把第一块 HTML 再追加一遍，第 2/3 块永远读不到 | 分块用唯一缓存 id 或跳过缓存 |
| I18 | `frontend/src/reading/reading.js:517-597` | 查找中切换章节，`renderChapter` 换掉 DOM 却不 `search.clear()` → 高亮全消失但计数仍显示旧结果 | 统一 `replaceReaderHtml()` 收口清理 |
| I19 | `frontend/src/git-graph/git-graph.js:400-407,662-707` | 单布尔 `state.loading` 守卫不区分 ref → 加载中切分支请求被静默丢弃，下拉显示 B 分支、列表仍是 A 分支 | 按请求令牌作废旧请求而非拒绝新请求 |
| I20 | `frontend/src/db/db-table-grid.js:45-47,457-473` | 自动刷新 `setInterval` 的停止入口 `invalidate()` 全仓无调用方 → 关标签/断会话后定时器永久泄漏并持续查询、弹提示 | pane 暴露 `destroy()` 并在卸载链调用 |
| I21 | `frontend/src/ai/session/ai-session-disk.js:1245,1431-1438` | `logSaveErrorShown` 从不清零 → 生命周期内一次落盘失败后，此后所有失败全静默，用户以为日志一直在写 | 成功路径复位标志 |
| I22 | `frontend/src/ai/chat/ai-message-queue.js:573-599` | 动画 `cancel()` 异步触发旧 `finish` 回调（闭包捕获旧 `nowHidden`）→ 快速删后再入队时，有消息的队列被错误保持隐藏 | finish 读取当前意图 / cancel 后重新对账 |
| I23 | `frontend/src/ai/agent/ai-subagents.js:1391-1404` | LRU"降级"依赖 `Map.set` 改变顺序，但对已存在 key 顺序不变 → 降级后同一轮立即删除，最早记录连摘要一起丢失 | 可续配额与总上限分离 |
| I24 | `frontend/src/ai/group/ai-group-runtime.js:243-258` | 删除群聊不调 `stopAll`、不停讨论/接力循环 → 后台继续消耗模型额度，租约延迟释放 | deleteGroup 先收尾在飞请求与循环 |
| I25 | `internal/aichat/chat.go:153` | `AITouchStream` 硬编码 300s 重置看门狗，覆盖用户配置的空闲超时（30s 被放大、3600s 被缩短） | 按本次请求真实 idleTimeout 重置 |
| I26 | `internal/aitransport/http.go:105-127` | 4xx 把完整请求体（会话正文 + 图片 base64）明文转储到日志目录，每次新建文件、无上限无清理 | 只存最小定位结构 + 环形覆盖 |
| I27 | `internal/aitransport/sse.go:519-534,666-681` | `ListModels`/`AITestConnection` 用无 ctx、无超时的请求 → 端点挂起时绑定调用永久卡死 | 加 `ResponseHeaderTimeout` + `NewRequestWithContext` |
| I28 | `internal/aitransport/http.go:256-264` | `Retry-After` 无上限，故障/恶意网关可让单请求及同 key 全部并发请求挂起数小时 | 设上限，超限回落指数退避 |
| I29 | `internal/browser/browser_windows.go:453-578` | `BrowserOpen` 创建失败路径只删注册表、不销毁已嵌入的 WebView2 控件 → 原生窗口盖界面、渲染进程长期驻留 | 抽统一 `browserDestroyOnHost` 收口 |
| I30 | `internal/notify/notify_windows.go:64` | `NotifyAttention` 每次 `syscall.NewCallback` 且永不释放 → 回调槽累积，达上限后通知失效甚至拖垮进程 | 提升为包级变量（同仓 tray/browser 已如此） |
| I31 | `internal/gitinfo/gitinfo.go:739` | 回滚用 AGENTS.md 明令禁止的 `git checkout --`，且引擎层无备份 → 多会话叠加改动被一起丢弃且无法恢复 | 写前备份 + 用户确认，避免直接 checkout -- |
| I32 | `frontend/test/core/form-controls-factory.test.mjs:212` | 表单护栏只判断"有没有 class="，带任意 class 的裸控件全部放行（实测 50 处游离于基线外）→ 核心规范 guard 部分形同虚设 | 改为封装 class 白名单精确匹配 + 补自测 |
| I33 | `frontend/src/core/wordcloud-render.js:198` | `loadScript` 的 `globalCheck` 用 `!!window.echarts`，而 `ensureEcharts` 刚让它为真 → wordcloud 插件脚本永不加载，SSR 分支成死代码，永远走兜底布局 | 用 `window['echarts-wordcloud']` 判定 + 独立已加载集合 |
| I34 | `frontend/src/bridge/bridge-memo-view.js:701-707` | 便签折叠测量 `.memo-body` 时它尚未入树（`querySelector` 恒 null）→ 用窗口高度替代，中等长度长条目不折叠 | 缓存上一帧 body 高度 |

> 另有 dev-only 缺陷（不进生产包）：`frontend/src/dev/mock-backend.js:213` 的 `legacyPathKey` import 误嵌进 Go 示例模板字符串致 3 个绑定恒抛 `ReferenceError`；`:3620` 局部变量 `rt` 遮蔽模块级 `mockRt` 致桌面安装进度事件发不出。建议修复并补 mock 冒烟测试。〔前端组合根分片〕

---

## 四、建议（P2 · 归纳）

**补丁引擎健壮性**（文件补丁分片）：按 hunk 子集应用硬编码 `ignoreWS=false` 与预检不一致；普通 `diff -u` 时间戳被当文件名致外部补丁无法应用；GBK 不可编码字符静默替换且哈希重算掩盖损坏；写入硬编码 `0644` 抹掉可执行位；备份/manifest 非原子写；撤销"先检查后加锁"TOCTOU；`NewPatchRunID` 仅 100ms 粒度可碰撞；`CopyTree` 跟随符号链接可越界/无限递归；新建文件一律补尾换行；`.git`/`.cadt` 保护只覆盖路径首段。

**资源 / 生命周期收口**：`debugconsole.js:344` 轮询定时器无清理；`db-query-editor.js:97` 的 ResizeObserver/Ace 订阅不随销毁解绑；`run.js:380` `exitWaiters` 悬挂；`eventowner.go:28-61` `order` 切片只增不减；`terminal_windows.go:402-417` `TermCreate` 上限 TOCTOU；`run.go:389-405` `RunInput` 竞态丢输入；`editor-groups.js:1964` 关标签不清理 CSV 列统计的 document Esc 监听。

**构建 / 配置一致性**：`gen-file-maps.mjs` 生成的地图在 HEAD 即漂移且 `--check` 未接门禁；`docs/packaging.md:29` 版本号注释过期（写 v1.2.1，真源已 v1.3.0）；ONNX 插件三处版本号矛盾（0.2.4/0.2.1/0.2.2）；`git-guard.mjs:158` 对 `env -u FOO git checkout` 存在绕过；`.workbuddy/settings.json:18` 复用 Claude 的 `CLAUDE_PROJECT_DIR` 回退到 `.`。

**其余**：`reading_search.go` 的 `unicodeToLower` 只处理 A-Z；`search.go:810` 不检查 `scanner.Err()` 致超长行静默截断；`glob.go:41` 每次调用重编译正则无缓存；`dbclient/guard.go:412` "WHERE 恒真"识别过窄；`vercmp.go:10` 非数字版本段当 0；`appconfig.go:88` 配置非原子覆盖写；`installercli_windows.go:30` `--integrate=` 空动作静默成功；`previewassets.go:88` 符号链接逃逸 + CORS `*`；`platform_windows.go:157` `findWailsWindow` 每次新建回调；`window_factory.go:96` 8 秒兜底定时器操作已销毁窗口；`window_route.go:22` 在归一化 key 上再取父目录；`app_infra.go:53` `MkdirAll` 错误静默吞。

**遗留文件（主代理横向扫描发现）**：`frontend/src/core/scratch-note.js` 自述"临时草稿，仅用于测试 worktree 导出流程，测试完直接丢弃，不要回灌主根"，却已存在于主源码树。建议确认后删除。

---

## 五、跨切面观察

1. **凭据/密钥处理是系统性薄弱环节**：代理凭据明文落盘（S5）、API Key 经产物下载 SSRF 外泄（S4）、OAuth token 前缀绕过泄露（S3）、错误响应体未脱敏（I3）、口令明文进命令行（I5）、DPAPI 解密失败覆盖密钥（I2）——六处独立问题指向同一短板，建议统一做一次"凭据生命周期"审计（产生→传输→落盘→日志→错误回显）。
2. **失败路径静默吞错反复出现**：回滚失败码死代码（S7）、stash 备份错误被吞（S7）、清理部分失败误报成功（I7）、GC 误删（S8）、temp 清理失败被吞（I11）、日志失败提示永久抑制（I21）、`os.ReadFile` 全量读入（I12）——多处 `err` 被 `_ =` 或错误分支降级，与 AGENTS.md"禁止空 catch 吞错"呼应。
3. **data race 集中在包级可变全局**：`scan.Warnings`（S6）、`jwksCache`（I1）、`activityPruneAt`（I9）、`usagestats` 句柄窗口（I8）——Wails 多窗口/多 goroutine 调用放大了这类问题，建议对导出绑定方法统一做 `-race` 压测。
4. **正面确认**：18 个分片一致确认以下维度扎实——XSS/原始 HTML 不执行（markdown-it→DOMPurify 链）、SQL 参数化与标识符白名单、git 命令注入防护、设置同步三通道、弹层栈/图标/表单/工具函数硬规范、TestMain 子进程模式、版本号同步机制、跨平台编译（linux/darwin 实跑通过）、COM vtable 常量核对无误。

---

## 六、建议修复顺序

1. **第一批（安全与数据丢失）**：S3、S4、S5、S7、S8、I2 —— 涉及凭据外泄与不可逆数据丢失。
2. **第二批（核心功能失效）**：S1、S2、S9、I15、I16、I17、I19、I20 —— 用户可直接感知的功能/展示错误。
3. **第三批（并发与资源）**：S6、I1、I8、I9、I29、I30 及其余 P1。
4. **第四批**：建议级与遗留文件清理；同时把"脚本可解析""工具卡参数""分块缓存"等守卫补进 `npm test`，防止回归。

---

> 本次审查为纯只读，未修改任何业务代码。报告落盘于 `docs/reports/code-review-2026-11-27.md`。
