# 代码审查报告核验结果（2026-11-27）

> 核验对象：`docs/reports/code-review-2026-11-27.md`（下称"原报告"）。
> 核验方式：逐条打开被指控代码 + 关键处实跑（`gen-file-maps --check`、`git-guard --check`、版本号比对、git 历史）。
> 核验范围：P0 9 项、P1 34 项、P2 34 项，合计 **77 项**。核验为只读，未改任何业务代码。
> 判定口径：**属实**＝核心事实成立（行号偏差不影响定性）；**部分属实**＝有成立部分，但存在因果倒置、影响夸大或举证错误；**不属实**＝核心事实不成立。

## 一、总体结论

| 级别 | 项数 | 属实 | 部分属实 | 不属实 |
|---|---|---|---|---|
| P0 | 9 | **9** | 0 | 0 |
| P1 | 34 | 27 | 7 | 0 |
| P2 | 34 | 29 | 5 | 0 |
| 合计 | 77 | 65 | 12 | 0 |

**原报告的缺陷判断整体可信：77 项里没有一条是凭空的，9 项 P0 全部落地。** 但有 12 条存在需要修正的成分，其中 4 条的影响描述会误导修复优先级（I11、I14、I19、C5），另有约 10 处行号/路径需要订正。

## 二、P0 逐项核验（9/9 属实）

| # | 结论 | 核验证据与订正 |
|---|---|---|
| S1 | 属实 | `go.mod:9` 为 wails/v3 v3.1.0；`platform_windows.go:202-241` 注释自述"依赖 Wails v2.17.1 结构"，`a.ctx.Value("frontend")` 在 v3 不注入，必返"无法访问界面实例"。v3 公开 API 存在：`webview_window.go:1255 func (w *WebviewWindow) OpenDevTools()`。反射段无 `recover`。 |
| S2 | 属实 | `gitinfo.go:130-132` 收了 stderr，`:145` 只 `return stdout.String()`；`git checkout` 的冲突清单走 stderr，`parseCheckoutConflictFiles` 必然空。 |
| S3 | 属实 | `oauthquota/fetch.go:35` `strings.HasPrefix(target, p.ConsoleOrigin)`，`:50` 发 Bearer。`https://<origin>.evil.com` 与 `<origin>@evil.com` 都能过。 |
| S4 | 属实 | `aigen.go:295` 只查 `http://`/`https://` 前缀，`:305-314` 原样转发 headers（含 Authorization），无 host 校验。 |
| S5 | 属实 | `ai-panel.js:1295-1297` 只脱敏顶层 `copy.proxy`；实测配置结构里 proxy 在 `defaultProfile()`（`:974`）与 `normalizeProfile()`（`:999`），顶层无此字段 → 脱敏永不生效。 |
| S6 | 属实 | `reading.go:476-478` 起 `readingScanWorkers` 个 worker，`:500`/`:554` 直接对共享 `scan.Warnings` append，无锁。 |
| S7 | 属实 | ① `PatchErrRollback`（`patch_types.go:44`）仅被 `patchcli.go:277/382` 读取，全包无赋值点；`rollback()`（`patch_write.go:249-270`）返回值只写进 `res.Unrestored`，错误码仍是 FileLocked/Concurrent/ApplyIO → `patchcli.go:382`"⚠ 有文件未能恢复"整块是死代码，用户只看到"写入失败"。② `patch_write.go:439`、`:460` 两处 `_ = os.WriteFile(..., ".revert-backup", ...)` 吞错后照常覆盖。 |
| S8 | 属实 | `backup.go:386-390` 引用集只由 L1 `keep` 构造，`:404` 据此 `gcOrphanBlobs`；`snapshots.go:356` 明写"与 L1 同一个 objects/"；L1 `retentionDays=7`（`backup.go:36`），快照保留到 28 天（`snapshots.go:675`），`pruneSnapshots`（`:633-639`）只删 manifest 不回收 blob → 双向错配成立。 |
| S9 | 属实 | 4 个主仓脚本仍 import `../frontend/src/ai/ai-local-classifier.js` / `ai-permissions.js`，实际已在 `frontend/src/ai/security/`；`export-model-catalog.mjs:5` 指向 `ai/model-catalog.js`（实际 `ai/core/`）。第 5 个是 `plugins/command-classifier-onnx/scripts/verify.mjs:70`（原报告只写 `verify.mjs:70`，未给前缀）。 |

## 三、P1 逐项核验（27 属实 / 7 部分属实）

### 安全 / 凭据

| # | 结论 | 订正与证据 |
|---|---|---|
| I1 | **部分属实** | 无锁成立：`auth.go:110-112` 声明、`:115` 读、`:123` 写，包内 `grep` 无任何 Mutex。但**触发场景写错了**：JWKS 缓存只经 `sealPassword`（唯一调用点 `login.go:187`）写入，额度刷新走 `Fetch → freshAccessToken` 完全不碰它；真实崩溃场景是"两个窗口同时登录"，不是"并发刷新额度"。报错文案也应是 `concurrent map writes` 或 read/write 两种之一。 |
| I2 | 属实 | `envvars_windows.go:21-27` 解密失败 `return ""`，无日志无 error；`Set()`（`envvars.go:149-169`）整表重建 → 覆盖全部旧密文；`dpapi.Protect("")` 返回 `("", nil)`（`dpapi_windows.go:50-53`）所以"保存成功"。`aiconfig.ErrSealed` 确实存在（`aiconfig.go:36-40`），可作为对照。 |
| I3 | 属实 | 真实行号 `aiusage.go:108-113`（非 113-118），脱敏缺口在 `aiUsageErrorSnippet`（`:176-188`）只截断不脱敏；对照函数 `aigen.go:424-443 aiGenRedactError` 存在且被 5 处使用。前端 `ai-usage-quota.js:98/279/405` 原样展示。 |
| I4 | 属实 | `webtools.go:407` `LookupIP` 校验，`:315-317` 的 Transport 无 `DialContext`，拨号时二次解析 → TOCTOU 成立。补充：`CheckRedirect`（`:322-330`）每跳都校验，但每跳都不 pin，绕过照样成立。 |
| I5 | 属实 | 关键行是 `:182`（`$certArgs += @("/p", $CertificatePassword)`）、`:208`（拼 `$signArgs`）、`:247`（`-DSIGN_ARGS`），不是 `:6`（那只是参数声明）。附带缺陷：`:208` 用空格 join 不加引号，口令含空格会拆参导致签名失败。 |
| I6 | 属实 | `:261`/`:262` 两次 verify，`:263` 只看 `$LASTEXITCODE`（已被 262 覆盖），本体验签失败无人检查；`Select-String` 还会吞掉 signtool 错误输出。 |

### 数据一致性 / 崩溃恢复

| # | 结论 | 订正与证据 |
|---|---|---|
| I7 | 属实 | 实际 `clear.go:63-73`：`:64` 要求"有 Reason + Remaining>0 + Freed==0"三条同时成立才进 Failed，部分成功会落 `default → Succeeded`。 |
| I8 | 属实 | `Close()` 实际在 `:207-216`（`:200-205` 是 `Start`）；`mu` 只保护指针交换，`conn.Close()` 在锁外，`upsertEvent` 是"取指针→锁外 Exec"，TOCTOU 成立；反向还有 `Close` 后 `ensureDB` 复活库文件的问题。 |
| I9 | 属实 | `activity.go:42` 声明、`:300-303` 读改写，`activityMu` 在 `appendActivityEntries` 返回时已释放（`:237`），prune 在锁外跑，race 成立。 |
| I10 | 属实 | `backup.go:89` `data := []byte(call.Content)`，`IndexRow` 无 enc/BOM 字段，`Restore` 直接原子写 → BOM/GBK 不保真。**范围限定**：仅前端 `write_file`/`edit_file` 的 Backup 路径；`Store()`（`:127-141`）字节保真。 |
| I11 | **部分属实** | ACL 残留成立：`Close()` 调 `revokeWrite`，而后者（`:608-609` 注释）明确保留 Everyone 的 FILE_DELETE_CHILD deny；`os.RemoveAll` 错误也确实被 `_ =` 吞（`cmdbridge/ai_command_windows.go:286-290`）。但**"RemoveAll 被拒导致 temp 泄漏"不成立**：只 deny 了 DC 没 deny DELETE，宿主对子对象仍有 DELETE，Go 的 `RemoveAll` 可直接删；`sandbox_windows_test.go:175-193` 在 Close 后由 `t.TempDir` 成功清理同一非空目录，反证该因果。**建议降为 P2**，真实泄漏来自崩溃/异步未收尾。 |
| I12 | 属实 | `service.go:30` 先 `os.ReadFile` 再 `:34` 判 20MB。**措辞订正**：`sqlview` 是独立包不是同包，且其上限是 100MB（`sqlview.go:29`），但"先 Stat 再读"的做法确实正确（`:217-227`）。 |
| I13 | 属实 | 实际 `query.go:48-64`，出错点 `:53` 直接 `return QueryOutcome{}`，已累积 `Results/Writes` 全丢。 |
| I14 | **部分属实** | `:198-203` 置 failed 后 `return`，不 stop、不 cancel，属实。但**"双实例"不成立**：旧进程仍占 `procctl` 注册位，`start()` 会在 `procctl.Register` 处返回"任务 id 已在运行"（`procctl.go:28-38`）。真实症状是"failed 态 + pid=0 + 点 Start 一直报 id 冲突"，修法（failed 后 stop 收口）仍然正确。 |

### 功能正确性

| # | 结论 | 订正与证据 |
|---|---|---|
| I15 | **部分属实** | 键名 bug 成立：`ai-tool-cards.js:47-50` 匹配 `old_string`/`new_string`，`:1075` 读 snake_case，而 schema 与执行侧都是 camelCase（`ai-tool-defs.js:482-486`、`ai-panel.js:12259-12260`）。**两处订正**：① 不是 2026-11-16 改名，`d6789e7`（11-14 17:51）首次写正则就是错的，属"引入即错"；② 不是"从不显示"，审批/完成态走 `approval.added/removed`（`:1066-1071`）仍有 ±，缺的只是流式阶段与执行中阶段。 |
| I16 | 属实 | `reading_search.go:121` 只折叠副本，`:287-290` `queryRun` 保留原大小写，`:318` 拿未折叠的 query 比已折叠的源 → 大写查询永不命中。测试只用全小写查询，恰好漏掉。 |
| I17 | 属实 | `reading.js:541-545` 只渲染 `chunks[0]`；继续阅读（`:738-757`）沿用同一 unit id，`reading-render.js:281-283` 的 `cacheGet(id, mtime)` 因未传 mtime 必命中首块 → 首块重复 append。 |
| I18 | 属实 | `renderChapter`（`:517-585`）直接换 innerHTML，`search.clear()` 只在 `close()`/`closeFindBar()` 调用，计数文本只在 runFind/键盘翻页更新 → 高亮消失、计数滞留。 |
| I19 | **部分属实** | 单布尔守卫成立（`:669-670`），加载中切分支确实被丢弃。但**"下拉 B、列表 A"不是稳定终态**：成功路径 `:698` 会 `branchSel.value = state.currentRef` 把下拉拉回 A；只有请求失败或未返回的窗口内才是 B/A。现象应描述为"切了没反应"。 |
| I20 | 属实 | `:464` `setInterval`，唯一停止入口 `invalidate()`（`:1068`）全仓无调用方；`db-tab-views.js:576-585` 的 unmount 只 destroy/dispose，拿不到 pane。 |
| I21 | 属实 | `:1245` 声明后只在失败分支置 true，成功路径无复位；面板生命周期内（跨会话）后续失败全静默。 |
| I22 | 属实 | `:573-588` `cancel` 事件异步触发旧 `finish`，闭包持旧 `nowHidden=true`，`queueHeightAnim === anim` 只清引用拦不住 `add('hidden')`。 |
| I23 | 属实 | `:1391-1404` `Map.set` 对已存在 key 不改顺序 → 降级后同轮再被取到即 delete，摘要一起丢。 |
| I24 | 属实 | `deleteGroup`（`:243-258`）只删 map 不调 `stopAll`（`:1059-1075`）；运行中循环持局部引用，`relays.delete` 反而让它彻底失联。 |

### 后端功能 / 并发

| # | 结论 | 订正与证据 |
|---|---|---|
| I25 | 属实 | `chat.go:153` `entry.watchdog.Reset(aitransport.IdleTimeout)`，300 是常量（`types.go:19`），用户配置走 `resolveIdleTimeout`（`types.go:96-107`，钳 30–3600s）→ 双向覆盖，超时文案也会说谎。 |
| I26 | 属实 | `http.go:105-127` 落 `ai-last-4xx-request-<ms>.json`，含完整 messages 与图片 base64。**比原报告更严重**：① 覆盖 401/403，Key 填错时每点一次就落一份完整会话；② 清理完全不存在——`applog.prune` 只删 `*.txt`，"清缓存"的 app-logs 条目也只匹配 txt（`storage/specs.go:118/153`），全仓无任何删除该前缀的代码。 |
| I27 | 属实 | `sse.go:519-534` 的 `http.Client` 只有 `Transport`、无 `Timeout`；`ListModels`（`:666-706`）用 `http.NewRequest` 无 ctx。**归属订正**：`AITestConnection` 在 `internal/aichat/chat.go:161-207`（Anthropic 分支 `:184` 同样无 ctx），不在 sse.go。 |
| I28 | 属实 | `http.go:256-259` `ParseFloat` 只校验 `>=0` 无上限，HTTP-date 分支同样；更重的是 429 时 `:96` `freezeUntil(rateKey, now+delay)` 会把同 baseURL+model 的所有请求一起冻结两小时。`aiRetryWait` 每 30s touch 看门狗，空闲超时救不回来。 |
| I29 | 属实 | 失败路径 `browser_windows.go:567-578` 只 `delete(browserInstances, id)`，不 `ShuttingDown/Hide/wvControllerClose`（正确序列见 `BrowserClose` `:962-985`）。行号订正：`BrowserOpen` 实际 `:530-580`，`453-526` 是 `browserCreateOnHost`。 |
| I30 | 属实 | `notify_windows.go:64` 每次 `syscall.NewCallback`，闭包捕获 pid/target 必然新 funcval，无释放 API。**比原报告更严重**：Go 的回调槽上限是 2000（`runtime/zcallback_windows.go`），满了走 `throw("too many callback functions")`——不可 recover，进程直接消失，不是"通知失效"。同仓 `browser_windows.go:284`、`tray_windows.go:85` 都已是包级变量，属漏改。 |
| I31 | **部分属实** | 事实成立：`:739` 回滚用 `git checkout HEAD -- <paths>`，函数内无任何备份（唯一写前备份钩子 `patch.OnWriteBackup` 不经此路径）。**两点订正**：① 命令是 `checkout HEAD --` 不是裸 `checkout --`；② AGENTS.md 的禁令由 `git-guard.mjs` 在"命令位置"判定，管的是 agent 的 shell 调用，不覆盖应用源码里的 Go 实现；另外用户侧其实有确认弹窗（`terminal-ui.js:101-103`、`ai-changes-ui.js:62-65`，后者未注入 `askConfirm` 时无确认）。应表述为"违反仓库回滚纪律的精神 + 无备份"，而非"违反硬规则"。 |

### 前端护栏 / 渲染 / dev

| # | 结论 | 订正与证据 |
|---|---|---|
| I32 | **部分属实** | 语义漏洞成立：`form-controls-factory.test.mjs:212` `if (/\bclass=/.test(...)) continue;`，任何 class 都放行，且 `:241` 自测把该行为写成了预期。**"50 处"数字不实**：按同口径复算，`index.html` 有 204 个静态原生控件，其中 **109 个**带 class 被放行、18 个不带 class 被计数（基线 20）；`src/` 下带 class 的静态控件是 **0** 处。真实缺口在 `index.html` 且量级是 5 倍，不在 src。 |
| I33 | 属实 | `wordcloud-render.js:195` 先 `ensureEcharts()` 使 `window.echarts` 为真，`:198` 再 `loadScript(..., () => !!window.echarts)`，而 `loadScript` 首行就是 `if (globalCheck()) return` → 插件永不注入。插件文件本身存在（`public/vendor/wordcloud/`，16.5 KB），是加载判定自锁。 |
| I34 | 属实 | `bridge-memo-view.js:248-254` 先建 body 再 `appendChild`，而 `buildItem`（`:701-707`）在 append 之前就 `querySelector('.memo-body')` → 恒 null，退回 `window.innerHeight`（面板只占窗口一部分，阈值被抬高）。 |
| dev-1 | 属实 | `mock-backend.js:210-217` 的 `import {legacyPathKey} from '../core/path-key.js';` 落在 Go 示例模板字符串内（`:213`），既不会真导入，还把示例 Go 代码写坏了。`legacyPathKey` 全文件仅字符串内出现 + 三个使用点（`:1754/1759/1766`），调用即 ReferenceError，被调用方 catch 吞掉。 |
| dev-2 | 属实 | `:3620` 局部 `const rt = window.__wailsRuntime` 遮蔽模块级别名 `rt`（`:4646 const rt = mockRt`）；`__wailsRuntime` 全仓无赋值 → 恒 undefined，`mcp-desktop-install` 事件从不发出。 |
| 遗留文件 | 属实 | `frontend/src/core/scratch-note.js` 存在（18 行），头部原文"临时草稿，仅用于测试 worktree 导出流程…测试完直接丢弃"，全仓零引用，是彻底死文件。 |

## 四、P2 逐项核验（29 属实 / 5 部分属实）

### 补丁引擎（8 属实 / 2 部分）

| # | 结论 | 订正与证据 |
|---|---|---|
| A1 | 属实 | `patch_write.go:115` 子集重算硬编码 `false`，预检用 `opts.IgnoreWhitespace`（`patch_plan.go:395`）。根因比"笔误"深：`patchPlan`（`patch_match.go:143-162`）压根没有该字段，选项没随计划持久化。 |
| A2 | 属实 | `patch_parse.go:87/102` 整段 `raw[4:]` 当路径，时间戳里的冒号命中 `:282` 的路径校验 → `blocked`。测试全用 `--- a/x` 形式，无时间戳用例。 |
| A3 | **部分属实** | 静默替换与哈希掩盖都成立（`chardec.go:88` `ReplaceUnsupported`，`patch_write.go:313-317` 重算）。**订正**：替换字符是 `0x1A`（SUB）不是 `?`，更隐蔽。 |
| A4 | 属实 | `patch_write.go:58` `os.Chmod(tmpName, 0o644)`，`patchTargetFile` 不记 Mode，回滚也走同一函数。影响限 POSIX 构建。 |
| A5 | 属实 | 备份 `:200`、manifest `:211-213` 都是裸 `os.WriteFile`（manifest 还 `_ =` 吞错），而目标文件走 `atomfile.Replace`；仓库已有 `atomfile.WriteFileAtomic` 却没用。 |
| A6 | 属实 | 检查在 `:431-467`，加锁在 `:469-473`，加锁后不复核直接写。缓解：入口已持工作区锁（`:409`），窗口只对"外部程序改文件"成立；`ApplyPatchPlan` 有写前复查（`:275-289`），撤销流程缺这一步。 |
| A7 | **部分属实** | 碰撞成立（同 100µs 桶内同 ID，`MkdirAll` 不校验，后写覆盖先写）。**订正**：粒度是 100 **微秒**（`Nanosecond()/1e5`），不是 100ms，差 1000 倍。 |
| A8 | 属实 | `fsops.go:422` 用 `os.Stat`（跟随链接）后递归 `CopyTree`，无 visited 集合、无 `EvalSymlinks` 越界判断 → 越界复制 / junction 无限递归。 |
| A9 | 属实 | `patch_plan.go:343` add 分支 `joinPatchLines(..., true)` 写死补尾换行，`resolveFinalNewline` 只在 modify 分支用。 |
| A10 | 属实 | `patch_parse.go:296-303` 只锚首段：`a/b/.git/config` 可过；`.cadt` 只挡 `patches/` 与 `permissions.json` 两个顶层目标。 |

### 资源 / 生命周期（7 属实，4 处需订正行号/路径）

| # | 结论 | 订正与证据 |
|---|---|---|
| B1 | 属实 | 实际文件 `frontend/src/terminal/debugconsole.js:362`（不是 `core/`，`:344` 是注释）；`setInterval(poll, 300)` 无 `clearInterval`，返回 API 无 dispose。影响有限：只独立控制台窗口走这里，文档生命周期=窗口生命周期。 |
| B2 | 属实 | `db-query-editor.js:99-101` ResizeObserver 实例不保存无法 disconnect，Ace `session.on('change')` 无 removeListener，返回对象无 dispose；`sessionRecovered()` 重跑 `build()` 会叠加实例。 |
| B3 | 属实 | `run.js:804` 登记、`:1083` 仅 run-exit 清理、`closeSession`（`:1002-1026`）不动 `exitWaiters`，`startStep` 无超时兜底 → 条件性悬挂。 |
| B4 | 属实 | `eventowner.go:50-52` 只在 map 无 key 时 append，`Unregister`（`:57-61`）只删 map → `order` 唯一收缩点是上限淘汰分支，而 Unregister 让 `len(m)` 永远到不了上限，单调增长。 |
| B5 | 属实 | 实际 `terminal_windows.go:381-397`（`402-417` 是 TermWrite/TermResize）；检查在 `:381-385`，起 ConPTY 在 `:390`（无锁），插入在 `:394-397` → 上限可被并发突破。 |
| B6 | 属实 | 实际 `run.go:465-488`；两次 select（done/eof 检查 → queue 入队）非原子，pump 退出后会静默吞输入。 |
| B7 | 属实 | `editor-groups.js:1964 closeDocNow` 不调 `closeCsvColumnStats`，CSV 侧也无 `tabUnmount` → `document` 捕获阶段 keydown 监听永久残留，且 Esc 会 `stopPropagation`。 |

### 构建 / 配置（4 属实 / 1 部分）

| # | 结论 | 订正与证据 |
|---|---|---|
| C1 | 属实 | 实跑 `node scripts/gen-file-maps.mjs --check` 退出码 1，两份 `.map.md` 都漂移（HEAD 快照同样漂移：main 340/354 行、ai-panel 977/993 行不同）。仓库无 CI 配置，`Taskfile.yml` 与 `package.json` 的 test 链均无该脚本。 |
| C2 | 属实 | `docs/packaging.md:29` 写"当前 `v1.2.1`"，真源 `app_core.go:73 = "v1.3.0"`，四处同步值（`wails.json:10`、`info.json`、`wails_tools.nsh:17`、`build/config.yml:14`）全部已是 1.3.0。 |
| C3 | 属实 | 实为 **4 个声明点 / 3 个值**：`plugin.json:4`=0.2.4、`package.json:3`=0.2.4、`package-lock.json:3,9`=0.2.1、`main.js:175`（用户可见状态输出）=0.2.2。 |
| C4 | 属实 | 实跑 `node tools/hooks/git-guard.mjs --check "env -u FOO git checkout -- a.js"` → ALLOW/exit=0；`env FOO=1 git restore a.js` 同样放行。缺口精确在 `:163`（`:158` 是函数头）：跳过 `-u/-i/-S` 时不吃其参数值。测试只有 `sudo` 一例。 |
| C5 | **部分属实** | 复用变量 + `:-.` 回退属实（实际在 `:16` 不是 `:18`）。但**"导致钩子跑错目录"不成立**：当前环境 `CLAUDE_PROJECT_DIR` 已注入，且有真实拦截实测记录（`.workbuddy/memory/2026-11-21.md:57`）；回退到 `.` 时 node 找不到模块退出码 1，按协议是静默降级不构成误判。应降为"回退值健壮性建议"。 |

### 其余零散项（10 属实 / 2 部分）

| # | 结论 | 订正与证据 |
|---|---|---|
| D1 | 属实 | `reading_search.go:345-350` 只处理 A-Z；且 `foldReadingText` 根本不折叠查询词（与 I16 同源）。 |
| D2 | 属实 | `search.go:810-811` 建 Scanner 后两处消费循环都不看 `Err()`；后果不是"该行截断"而是 `ErrTooLong` 时**该行及其后整段静默丢弃**，且 `scanned` 已置 true。 |
| D3 | 属实 | **路径订正**：文件是 `internal/search/glob.go`，不存在 `internal/glob/`；`:75` 每次 `regexp.Compile`，按候选文件数调用。 |
| D4 | **部分属实** | 识别确实过窄，但**举证反了**：`WHERE 1`、`WHERE 1=1`、`WHERE TRUE` 三种恰好都被 `:424-428` 覆盖。真正漏的是 `WHERE 0=0`、`WHERE 'a'='a'`、`WHERE 2>1`、`WHERE TRUE AND 1=1`。 |
| D5 | 属实 | `vercmp.go:15` `n, _ := strconv.Atoi(part)`（`:10` 是函数头）；`Compare` 只比前 3 段 → `1.3.0-beta`、`1.3.0.1` 都算 1.3.0。该包无测试。 |
| D6 | 属实 | `appconfig.go:101` 裸 `os.WriteFile`（`:88` 是自认此事的注释）；写坏后 `Read()` 直接回落 `Default()`（`:74-76`）→ 用户设置静默重置。 |
| D7 | 属实 | `installercli_windows.go:49` 空值追加 0 项，`:96-97` 打印 `integration install ok: ` 并成功退出；`--integrate`（不带 `=`）走 `continue`，同样静默忽略。 |
| D8 | 属实 | `previewassets.go:86-93` 全字符串校验（无 Lstat/EvalSymlinks），`:103` `Access-Control-Allow-Origin: *`；`service.go:10-11` 允许前端注册任意目录 → 叠加后是"可跨源读取的通用文件服务"。 |
| D9 | 属实 | `platform_windows.go:157` 每次 `NewCallback`，被 `browser.FindParent`、`screenshot.FindParent` 调用；同仓其它处已是包级变量，属漏改。 |
| D10 | **部分属实** | 守卫缺失属实（`window_factory.go:98-100` 只看 `teardownDone`/`ForceClosed`，普通关闭非最后窗口两者都不置位）。但 wails v3 的 `IsVisible/Show/Run` 对 destroyed 窗口都是空操作（`webview_window.go:791/530/501`），实际只产生一条误导性 warn 日志，**应降为 P3**。 |
| D11 | 属实 | `window_route.go:22` 归一化后 `:27` 再取父目录再归一化，幂等；盘根 `c:` → `c:.` 的收敛已被 `window_route_test.go:48` 固化为有意行为，影响≈0，属可读性问题。 |
| D12 | 属实 | `app_infra.go:52` `_ = os.MkdirAll(root, 0o755)`（`:53` 是收尾括号），无日志；失败会延后成 WebView2 初始化失败。 |

## 五、必须修正的描述偏差（按影响排序）

| # | 原报告说法 | 实际 |
|---|---|---|
| 1 | I11 "RemoveAll 被拒 → temp 持续泄漏" | 只 deny DC 未 deny DELETE，宿主可删；泄漏因果不成立，仅 ACL 残留 + 吞错成立 |
| 2 | I14 "点 Start 再起一个 → 双实例" | procctl 注册位挡住，起不来；真实症状是 id 冲突卡死 |
| 3 | I19 "下拉显示 B、列表仍是 A" | 成功路径 `:698` 会回写下拉，只在失败/未返回窗口成立 |
| 4 | I1 "多窗口并发刷新额度可崩进程" | 额度刷新不碰 JWKS，只有并发登录会 |
| 5 | I32 "50 处游离基线外" | src 内 0 处，index.html 实际 109 处 |
| 6 | I15 "2026-11-16 改名" / "± 从不显示" | 11-14 引入即错；审批/完成态仍显示 ± |
| 7 | I31 "违反 AGENTS.md 硬规则" | 护栏只管 agent shell 调用，不覆盖应用源码；另 `checkout HEAD --` |
| 8 | A7 "100ms 粒度" | 100 微秒 |
| 9 | A3 "替换成 `?`" | 替换成 `0x1A`（SUB） |
| 10 | D4 举例 `WHERE 1/1=1/TRUE` | 这三种已覆盖，漏的是 `0=0`、`'a'='a'`、`2>1` |
| 11 | I27 "AITestConnection 在 sse.go" | 在 `internal/aichat/chat.go:161-207` |
| 12 | I12 "同包 sqlview" | 独立包，且上限 100MB |
| 13 | C3 "三处版本号" | 4 个声明点 / 3 个值 |
| 14 | C5 "钩子跑错目录" | 环境变量已注入，回退只是潜在脆弱点 |
| 15 | D3 "`internal/glob/glob.go`" | `internal/search/glob.go` |

**行号订正汇总**：I3→108-113、I7→63-73、I8→207-216、I11→576-640（结论重写）、I13→48-64、I25 精确、I27→sse.go 666-706 + chat.go 161-207、I29→530-580、I30 结论加重、B1→terminal/debugconsole.js:362、B5→381-397、B6→465-488、D5→15、D6→101、D12→52。

## 六、严重度调整建议

**上调**：
- **I30**（notify）：不是"通知失效"，是 2000 槽后 `throw` 硬崩进程 → 可按 P1 高位处理。
- **I26**（4xx 转储）：覆盖 401/403 且**全仓无清理**，Key 填错时每试一次落一份完整会话+图片 → 与 S5 同级。
- **A10**（`.git`/`.cadt` 保护只挡首段）：子模块场景下是真实写入风险，建议从 P2 提到 P1 尾部。

**下调**：
- **I11** → P2（因果不成立）
- **C5** → P3（潜在脆弱点）
- **D10** → P3（只产生假告警）
- **D11** → P3/可读性

**维持**：其余 P0 九项、I2/I3/I4、I7/I8/I9/I10/I13、I16-I18、I20-I24、I25、I28、I29、I31、I33、I34、A1-A9、B1-B7、C1-C4、D1-D9、D12。

## 七、核验中额外发现（原报告未提）

1. **S7 的用户可见后果比原报告更明确**：`res.Unrestored` 其实已填充，只是输出被 `res.Code` 门控，所以"数据在 JSON 里有、人不一定看得到"——修复只要在 rollback 非空时改写错误码即可，成本极低。
2. **`dpapi.Protect("")` 返回 `("", nil)`**（`dpapi_windows.go:50-53`）：这是 I2"保存成功但落成空值"的关键一环，修复时应一并在 dpapi 层拒绝空输入。
3. **I5 附带签名失败**：`build-installer.ps1:208` 空格 join 不加引号，口令含空格会拆参 → 修 I5 时顺手改数组传参。
4. **dev-1 顺带把 Go 示例代码写坏了**：`mock-backend.js:213` 的 import 插在 `import (` 块中间，示例本身已不合法，不只是 ReferenceError。
5. **C1 的"漂移"在 HEAD 即存在**（非本轮改动引入），且仓库根本没有 CI，所以"接门禁"需要先建门禁载体。

---

> 核验为纯只读，未修改任何业务代码。本文件为原报告的核验附档，原报告保持原样以便对照。
