# 内置数据库连接与浏览工具（分期方案）

> 状态：**P0–P3 已实施并收口**（2026-11-22 评估、调研、评审、实施；2026-11-27 验收缺口修复并归档；落地决策与偏离记录见 §11；
> P3 Redis 见 §11.13，收口记录见 §11.14）
>
> 目标形态：类 JetBrains DataGrip / Beekeeper Studio 的「连接 → 对象树 → 表数据网格 → SQL 查询 → 受控编辑」，
> 但严格保持本项目「单 exe、零依赖、无索引、轻快」的核心竞争力——**做一个够用的轻量数据查看器，不做一个瘦版 DataGrip**。
>
> 本文分两部分：第 2–3 节是调研结论与现状事实（为什么这么设计），第 4–9 节是实施契约（怎么落地）。

---

## 1. 结论摘要

1. **可行且比想象便宜**：现有代码已具备约 70% 的基础——`internal/sqlview` 的查询管线与结果结构、`editor-csv-view.js` 的虚拟表格与单元格编辑、`editor-sql-view.js` 的查询 UI、`internal/dpapi` 的凭据加密、`core/app-pages.js` 的页面入口。前端 0 新增依赖。
2. **三种数据库不是一种功能**：SQLite（本地文件、已有驱动）、MySQL（远程连接、需新驱动）、Redis（KV，无表无 SQL）是三种语义，必须分期、分 UI。Redis 尤其不能塞进「表→行→单元格」模型——连 DataGrip 的 Redis 支持都做到「只读 + 伪造表格」的别扭程度。
3. **写入是本项目有史以来风险最高的能力**：它能改工作区之外的真实数据，wipeguard 完全护不住。默认只读、写操作独立授权、SQL 预览 + 事务 + 操作留痕是硬要求，且**安全拦截必须在 P0 就埋进查询路径**，不能等做编辑时再补。
4. **体积可控，但引入新依赖需作者批准**：SQLite 复用已有 `modernc.org/sqlite`（`go.mod:12`，其 +3.9 MB 已经是作者批准的派生索引例外，见 `docs/reports/optimization-proposals.md:695`）；MySQL 纯 Go 驱动约 +0.5 MB；Redis 若自写精简 RESP 客户端则 0。**任何新依赖先问「能否不引入」**。
5. **分期建议**：P0 SQLite 只读浏览（验证产品形态）→ P1 MySQL 只读连接 → P2 受控写入（单独安全评审）→ P3 Redis（独立模块、单独立项）。**先做 P0+P1 只读版验证需求**，不要一上来对标 DataGrip 全功能。

---

## 2. 本项目现状（代码事实，2026-11-22 核对）

### 2.1 Go 侧可复用基础

| 模块 | 现状 | 复用点 |
|---|---|---|
| `go.mod:12` | `modernc.org/sqlite v1.62.0`（纯 Go，无 cgo） | SQLite 连接零新依赖；`database/sql` 接口可直接换成真实连接 |
| `internal/sqlview/sqlview.go` | CSV/TSV/JSONL 只读查询引擎（临时 SQLite） | `SQLResult{Columns, Rows, Nulls, Truncated, ElapsedMs}` 结果结构、`sqlCellString` 类型转换、查询超时（`sqlview.go:33`，20s）、行数上限（`sqlview.go:34-35`，默认 500 / 上限 5000）、`stripSQLLiterals` 字面量清洗（`sqlview.go:91`）；**guard.go 的现成起点**：`sqlExternalWriteRe` 写语句检测（`sqlview.go:134`）与 ATTACH/DETACH/VACUUM 拒绝（`sqlview.go:658`） |
| `sqlview_app.go` | Wails 薄绑定：`SQLImport` / `SQLQuery` / `SQLClose` | 新绑定的分层范式（引擎下沉 `internal/<域>`，根壳只转发） |
| `internal/dpapi/dpapi_windows.go` | DPAPI 加密（AI 配置、环境变量已用） | 连接密码加密落盘，无需自建加密 |
| `internal/activity/` | 追加式操作留痕（脱敏、跨进程锁） | 记录「谁在何时对哪张表执行了何种写操作」，不记密码/参数值 |
| `internal/resourcelease/` | 跨进程资源写权租约 | 连接配置的单写者保护（多窗口场景） |

### 2.2 前端可复用基础

| 模块 | 现状 | 复用点 |
|---|---|---|
| `frontend/src/editor/editor-csv-view.js` | CSV/TSV 虚拟滚动表格 + 列排序筛选 + 单元格编辑回写 | 数据表浏览/编辑 UI 的最大一笔节省；导出名为 `createEditorCsvView(deps)`（editor-csv-view.js:9），复用纯函数时按此签名 |
| `frontend/src/editor/editor-sql-view.js` | SQL 查询输入 + 状态条 + 结果表渲染 | SQL 查询页 |
| `frontend/src/core/app-pages.js` | `APP_PAGES` 应用页面注册表 | 加一项「数据库连接」，入口/标签页/AI 上下文描述自动生效 |
| `frontend/src/core/readonly.js` | 只读判定单一来源（全局锁 + 标签锁 + 固定锁 + 大文件/二进制） | 默认只读门禁的落点；需扩展覆盖 SQL 执行路径 |
| `frontend/src/core/wails-runtime.js` | v3 `Call.ByName('main.App.<Method>')` 动态绑定 | 新绑定调用方式（v3 无生成 wailsjs） |
| `dev/mock-backend.js` | dev 模式 mock 绑定 | **新增绑定必须补同名 mock**，否则 dev 模式崩 |

### 2.3 架构约定（来自 AGENTS.md，必须遵守）

- 纯引擎下沉 `internal/dbclient/`，不 import main、不碰 App；位置与外部动作经 `Deps` 钩子注入。根目录留 `dbclient_app.go` 薄绑定。
- 前端新域模块用 `createXxx(deps)` factory + 显式依赖注入，不回填 `main.js`。
- 平台相关代码 `*_windows.go` + `*_other.go` 成对出现；平台无关文件不许出现 Windows 专属符号（守 `crossplatform_guard_test.go`）。
- 前端表单控件走 `core/form-controls.js`，弹层走 `core/overlay-stack.js`，图标走 `core/icons.js` 的 `iconSvg()`（守 `form-controls-factory` / `overlay-esc-guard` / `icon-guard` 三道测试基线）。
- 新增纯逻辑配测试并登记 `npm test` 清单；Go 表驱动 `*_test.go`；`go test` 一律后台执行并带 `-timeout`。

---

## 3. 业界调研结论（80+ 一手来源，2026-11-22）

### 3.1 关系型工具已收敛到「三层模型」

| 层 | 共识做法 | 代表证据 |
|---|---|---|
| 元数据加载 | 分层按需：先名字、点开才拉详情；按 schema 勾选；执行写后 smart refresh | JetBrains introspection levels（≤1000 对象 L3 / ≤3000 L2 / 否则 L1，[文档](https://www.jetbrains.com/help/datagrip/introspection-levels.html)） |
| 结果集 | LIMIT 下推 + 服务端分页 + 前端虚拟滚动 + 默认行数上限；fetch size 与 page size 分离；不自动 `COUNT(*)` | DBeaver `setLimit/setResultsFetchSize` + "Use SQL to limit fetch size"；DataGrip 默认 500 行 |
| 编辑回写 | dirty model → SQL 预览 → 显式 Submit → 单事务；必须有主键定位；无主键只读/仅插入 | Beekeeper `pendingChanges{inserts,updates,deletes}` + `executeApplyChanges()`；DBeaver 唯一键解析；DataGrip `Preview Pending Changes` |

### 3.2 安全教训（对我们最关键）

1. **只读是 UI 层保护，不是数据库层强制**。DataGrip 官方明确警告：只读数据源下「Data modifications might be possible in the query console if the driver does not support the read-only status」。→ 必须**同时禁用编辑 UI + 拒绝执行 DML/DDL SQL**。
2. **不安全 SQL 静态检测**：DELETE/UPDATE 缺 WHERE 或 `WHERE TRUE` 时强确认（DataGrip `Show warning before running potentially unsafe queries`）。
3. **DROP 确认框**：展示完整 SQL + `DROP CASCADE` 显式勾选 + 「复制 SQL 而不执行」；TRUNCATE 与逐行 DELETE 分开入口。
4. **权限细分优于单一只读开关**：DBeaver 四级 `Restrict data edit / structure edit / script execute / data import`。
5. **凭据**：密码存 OS keystore / DPAPI，配置与凭据分离；DataGrip URL-only 明文、SQLTools 单薄凭据键（server/user）都是反面教材。

### 3.3 架构教训

- **并发隔离**：Beekeeper 用 Electron utility process 隔离 DB 操作。Wails 单进程无法照搬，但必须用 **goroutine + context + 事件桥**做逻辑隔离，否则慢查询卡死 WebView2 UI 线程。
- **驱动抽象**：抄 SQLTools 的 `Driver` 接口 + 注册表思想，**不抄运行时插件加载**——Go `plugin` 在 Windows 不可用且要求 toolchain 完全一致（[pkg.go.dev/plugin](https://pkg.go.dev/plugin)），与单 exe 冲突。改为**编译期静态注册**。
- **Redis 是异类**：只用 `SCAN`（`KEYS` 被官方标 `@dangerous`、O(N) 阻塞）；value 按类型分派编辑器；`SET` 清 TTL 所以 string 保存后必须重新 `EXPIRE`；DataGrip 都做不到编辑。→ 独立子系统，单独立项。

> 完整调研（含全部 URL 与日期）见本轮对话的调研汇总；核心来源列于第 10 节。

---

## 4. 总体架构设计

### 4.1 分层与数据流

```
┌─────────────────────────────────────────────────────────────┐
│ 前端（WebView2）                                             │
│  src/db/ 新域模块（factory + deps 注入）                      │
│   ├─ db-connection-view.js   连接管理页（应用页面 mount）      │
│   ├─ db-object-tree.js       对象树（两级按需加载）            │
│   ├─ db-table-grid.js        表数据网格（复用 csv-view 思路）  │
│   ├─ db-query-editor.js      SQL 查询页（复用 sql-view）       │
│   └─ db-model.js             纯函数（状态格式化、SQL 预览渲染）│
│  经 core/wails-runtime.js 的 Call.ByName 调 Go 绑定            │
└──────────────────────┬──────────────────────────────────────┘
                       │ Wails 绑定（异步 Promise）+ EventsEmit 事件
┌──────────────────────▼──────────────────────────────────────┐
│ 根壳：dbclient_app.go（薄绑定，只转发 + 参数整理）             │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ 引擎：internal/dbclient/（纯引擎，不碰 main/App）              │
│   ├─ driver.go       Driver interface + Registry             │
│   ├─ base.go         BaseDriver 通用逻辑                      │
│   ├─ sqlite.go       SQLite 驱动（复用 modernc）              │
│   ├─ mysql.go        MySQL 驱动（P1）                         │
│   ├─ session.go      连接注册表 + 生命周期 + 租约              │
│   ├─ metadata.go     两级元数据内省                           │
│   ├─ query.go        查询执行（分页/超时/取消/截断）           │
│   ├─ edit.go         dirty model → SQL 预览 → 事务提交（P2）   │
│   ├─ config.go       连接配置读写（凭据经 dpapi 钩子）         │
│   └─ guard.go        SQL 安全分类（只读拦截/危险操作检测）      │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Go 侧接口契约（草案）

```go
// Driver 是数据库驱动的统一契约；编译期静态注册，不做运行时插件。
type Driver interface {
    Kind() string                                   // "sqlite" | "mysql" | "redis"
    Open(cfg ConnectionConfig) (Session, error)
    Capabilities() Capabilities                     // 只读/事务/DDL/编辑等能力位
}

// Capabilities 用于前端能力探测与 feature flag（借鉴 Beekeeper supportedFeatures）。
type Capabilities struct {
    ReadOnly      bool  // 驱动层面是否只读
    Transaction   bool  // 是否支持手动事务
    Editable      bool  // 是否支持单元格编辑
    DDL           bool  // 是否允许结构变更（P2 默认 false）
}

// Session 是单个连接的会话；一个连接一个 goroutine 持有。
type Session interface {
    ListDatabases(ctx context.Context) ([]string, error)          // 元数据 L1
    ListObjects(ctx context.Context, db string) ([]Object, error) // 元数据 L1：表名
    DescribeTable(ctx context.Context, db, table string) (TableMeta, error) // 元数据 L2：列/主键
    Query(ctx context.Context, req QueryRequest) (SQLResult, error)
    Close() error
}

// QueryRequest 统一查询入参；复用 sqlview.SQLResult 作为出参。
type QueryRequest struct {
    SQL    string
    Offset int   // 分页下推
    Limit  int   // 默认 500，上限 5000（与 sqlview 对齐）
}
```

**配置与凭据分离**：连接配置存 `<应用数据>/db-connections.json`（非敏感字段），密码经 `internal/dpapi` 加密后单独存；凭据键用复合键 `connectionID+host+port+user`，避免 SQLTools 式冲突。

### 4.3 前端接线点

- `core/app-pages.js` 的 `APP_PAGES` 加一项 `{id:'database', label:'数据库连接', icon:'database', group:'数据', ...}`（`database` 图标已在 `core/icons.js:135` 注册，无需新增）。
- 视图工厂 `bridge/bridge-app-page-view.js` 登记一行，mount 到 `src/db/db-connection-view.js`。
- 主窗口 `main.js` 的 `appPageMounters` 注入 mount（bridge 不 import db 域，经 deps 注入）。
- `dev/mock-backend.js` 补全部新绑定的 mock。

---

## 5. 分期方案

### 5.1 P0：SQLite 本地库只读浏览（3–5 人天）

**范围**：打开本地 `.db` 文件 → 库/表对象树（两级加载）→ 表数据网格（分页 + 虚拟滚动 + 筛选排序）→ SQL 查询页。**全程只读**。

**设计决策（2026-11-22 评审定）**
1. **入口 = 应用页面内文件选择对话框**，不做双击 `.db` 当文件标签页打开——后者要动 `formats.js` 格式注册，且会撞上 >10 MB 只读 / >100 MB 拒开的大文件限制（`app_core.go`）；双击打开待只读版验证需求后另议。
2. **布局 = 「数据库连接」一个 app-page 内三栏**（对象树 | 数据网格 | SQL 查询），查询结果随连接会话走、不再另开标签页——贴 DataGrip 习惯，改动面也最小。

**Go 侧**
- 新建 `internal/dbclient/` 骨架：`driver.go` / `base.go` / `sqlite.go` / `session.go` / `metadata.go` / `query.go` / `guard.go` / `config.go` + 表驱动测试。
- SQLite 驱动：`sql.Open("sqlite", path)`，只读模式打开（`file:...?mode=ro`，防误写）。**WAL 注意**：`mode=ro` 打开 WAL 库需要对 `-wal`/`-shm` 的读权限，只读目录下会失败——报错要带原因提示，必要时以 `immutable=1` 兜底（仅对确认不在写的库）。
- 元数据 L1：`SELECT name FROM sqlite_master WHERE type IN ('table','view')`；L2：`PRAGMA table_info` + `PRAGMA foreign_key_list` + 主键识别（为 P2 铺路）。
- 查询：复用 `sqlview.SQLResult` 与 `sqlCellString`；`QueryContext` + 20s 超时 + 分页下推 + 500 行默认上限 + 截断标记。
- `guard.go`：**P0 就埋好**——SQL 分类为 read / write / ddl / dangerous；只读会话下 write/ddl 直接拒绝（不依赖驱动只读标志）。**以 `sqlview` 的现成拦截为起点**（`sqlExternalWriteRe` + `stripSQLLiterals`，见 §2.1）；多语句口径：**逐条分类，任一条非只读即整批拒**。
- 根壳 `dbclient_app.go`：`DBOpen` / `DBListObjects` / `DBDescribe` / `DBQuery` / `DBClose` 五个绑定。

**前端**
- 新建 `src/db/` 域模块（factory + deps），对象树 + 数据网格 + 查询页。
- 数据网格复用 `editor-csv-view.js` 的虚拟滚动与列渲染思路（必要时抽公共纯函数，不复制整文件）。
- `app-pages.js` 加入口 + `appPageMounters` 接线 + `dev/mock-backend.js` mock。

**安全边界**：只读会话拒绝一切 DML/DDL；SQL 查询走 `guard.go` 分类；连接目标限定工作区内或用户显式选择的本地文件（复用 `ai-read-roots` 的路径授权思路，但不给 AI 暴露）。

**测试与登记**：Go 表驱动（元数据解析、SQL 分类、分页截断）；前端 `db-model.test.mjs` 并登记 `npm test`；`npm run build` + `go build` 通过。

**验收**：打开一个含多表的 `.db`，对象树两级加载正确；表数据分页/排序/筛选正常；`SELECT` 返回结果、`DELETE` 被拒；`go test ./internal/dbclient/...` 与 `npm test` 绿。

---

### 5.2 P1：MySQL 只读连接（5–8 人天）

**范围**：在 P0 基础上增加远程 MySQL 连接管理（新建/编辑/测试连接、密码加密存储）、库/表/视图/索引内省、只读查询。**仍不含写入**。

**依赖**：新增 `github.com/go-sql-driver/mysql`（纯 Go，约 +0.5 MB）——**作者已批准**（2026-11-22：基线 exe 34.2 MB，全功能最坏 +1.5 MB 可接受）。

**Go 侧**
- `internal/dbclient/mysql.go`：实现 `Driver` / `Session`；元数据用 `information_schema` 查询（可控、可分页），不依赖 `SHOW` 的不可控输出。
- `config.go`：连接配置读写 + dpapi 加密密码 + 复合凭据键 + `DBTestConnection`（两级：先连再查元数据）。
- 连接注册表加空闲超时断连、连接数上限；`session.go` 加租约（多窗口单写者，复用 `resourcelease` 思路）。
- 连接目标校验：禁止连到云元数据服务（IMDS 169.254.169.254）与内网保留段（可由配置项放行，默认拒绝）——本地工具风险可控但不能不设防。

**前端**
- 连接管理 UI（新建/编辑/测试/删除连接），表单走 `core/form-controls.js`；密码输入框不回显、不进配置 JSON。
- 连接选择下拉 + 状态指示（已连接/断开/错误）。

**安全边界**：默认只读；密码不明文落盘、不进日志、不进操作留痕、不进 AI 上下文；连接配置不进会话搜索索引。

**测试与登记**：MySQL 驱动单测（元数据 SQL 生成、连接串校验、凭据加解密往返）；集成测试用 docker MySQL（可跳过）；前端连接表单纯函数测试登记 `npm test`。

**验收**：能连本地/测试 MySQL，库表树与数据查询正常；重启后凭据仍在但不明文；断网/错密码有清晰错误；`go build` 体积增量实测并记录。

---

### 5.3 P2：受控写入（5–10 人天，**需单独安全评审后开工**）

**范围**：单元格编辑、行增删、SQL 执行、事务提交/回滚、操作留痕。这是风险最高的一期，**开工前必须先过安全设计评审**。

**Go 侧**
- `edit.go`：`pendingChanges{inserts,updates,deletes}` dirty model；行定位只认主键/唯一索引（**无主键表一律只读并说明原因**，不学 DBeaver「所有列当键」）；UPDATE 的 WHERE 带原值，`RowsAffected==0` 判冲突并提示刷新。
- SQL 预览：提交前生成参数化 SQL 展示给用户（借鉴 `Preview Pending Changes`），不自动执行。
- 事务：默认手动模式，一批编辑包在单个 `sql.Tx` 里，显式 `Commit` / `RollBack`；自动模式需提示「不可回滚」。
- `guard.go` 增强：DROP/TRUNCATE 二次确认 + 展示 SQL + CASCADE 显式勾选；无 WHERE 的 UPDATE/DELETE 强确认；只读会话拦截写路径（与 UI 层双保险）。
- 操作留痕：经 `internal/activity` 记录「连接 + 库表 + 操作类型 + 影响行数 + 耗时」，**不记 SQL 参数值与密码**。

**前端**
- 单元格编辑 dirty 态标记 + 待提交计数 + 「预览 SQL / 提交 / 撤销 / 回滚」按钮。
- 危险操作确认弹层走 `core/overlay-stack.js`；SQL 预览只读展示。

**安全边界（硬要求）**
- 写操作需用户显式开启（连接级「允许编辑」开关 + 每次提交确认），默认全关。
- wipeguard 不覆盖远程库——DB 层自建保护，不承诺「可回滚到任意历史点」（只保证当前事务内 RollBack）。
- 不给 AI 暴露数据库连接/写入工具（除非另立授权设计）。

**测试与登记**：事务回滚、冲突检测、SQL 生成、危险操作拦截的表驱动测试；模拟无主键表只读；操作留痕脱敏断言。

**验收**：编辑单元格 → 预览 SQL → 提交 → 回读正确；冲突场景提示刷新；RollBack 生效；无主键表不可编辑；DROP 需二次确认；留痕无敏感值。

---

### 5.4 P3：Redis 独立模块（8–15 人天，**单独立项**）

**范围**：作为**独立子系统**（不复用 SQL 结果网格）：key 虚拟树（默认 `:` 分隔、可切扁平）、按 value 类型分派的编辑器（string/hash/list/set/zset/stream/JSON）、TTL 展示与修改、单命令 CLI、编辑生成命令预览。

**依赖（2026-11-22 作者拍板：自写）**：自写精简 RESP2 客户端（0 新依赖；浏览面只需约 20 条命令 + 一条通用管线，单连接串行，不需要 go-redis 的池化/Cluster/RESP3）；**实施时在客户端文件头注释注明「后续如有真实需求（Cluster/Pub-Sub/RESP3）可替换 go-redis/v9（约 +1 MB，体积已批）」**。

**关键约束**（来自调研）
- 只用 `SCAN`（可调 COUNT、客户端去重、cursor==0 判结束）；**绝不用 `KEYS`**；精确查找走 `EXISTS`；不依赖 `INFO`/`CONFIG` 列 key（托管 Redis 常禁用）。
- 「已扫描 N / 已匹配 M + 加载更多」的诚实 UI，不做假分页；树节点带数量角标，删除「文件夹」= 前缀 pattern 批量删，需明确确认。
- 二进制安全（全程 Buffer）；formatter 支持 Text/JSON/HEX/Binary。
- string 保存后必须重新 `EXPIRE`（SET 清 TTL）；TTL `-1` = `PERSIST`；TTL≤0 当删除确认。
- 连接级只读 + 引导服务端 ACL；危险命令（FLUSHALL/DEL/批量删）Type-to-Confirm；不做 MONITOR/Profiler。

**验收**：key 树虚拟滚动与前缀分组正常；五种 value 类型可查看/谨慎编辑；TTL 保存后不丢；`KEYS` 不在代码路径中；危险操作需确认。

---

## 6. 安全设计（贯穿各期）

| 风险 | 防线 | 落地位置 |
|---|---|---|
| 只读被绕过 | UI 禁用编辑 **+** 查询路径拒绝 DML/DDL（双保险） | `core/readonly.js` + `internal/dbclient/guard.go` |
| 误删/误改 | SQL 预览 + 二次确认 + 事务回滚 + 无主键只读 | `edit.go` + overlay-stack 确认层 |
| 危险 DDL | DROP/TRUNCATE 强确认 + CASCADE 显式勾选 + 复制不执行 | `guard.go` |
| 凭据泄露 | dpapi 加密 + 配置/凭据分离 + 复合键 + 不进日志/AI | `config.go` + `internal/dpapi` |
| 慢查询卡 UI | goroutine + context 超时/取消 + EventsEmit 事件桥 | `session.go` + 绑定层 |
| 资源耗尽 | 连接数上限 + 空闲断连 + 行数上限 + 查询超时 | `session.go` + `query.go` |
| 目标校验 | 禁连 IMDS/内网保留段（可配置放行）+ 本地文件授权 | `config.go` + 路径授权复用 |
| 操作审计 | 脱敏留痕（无参数值/密码） | `internal/activity` |

**明确不承诺**：wipeguard 不保护远程数据库；不提供任意时间点回滚（仅事务内）；不做服务端 ACL 的替代品（引导用户配只读账号）。

---

## 7. 通用收尾（每期必做）

1. 新增 Go 导出方法后，前端经 `Call.ByName` 动态解析（v3 无生成绑定），**必须**在 `dev/mock-backend.js` 补同名 mock。
2. 平台无关文件不许出现 Windows 专属符号；`_other.go` 桩同样要能编译；跑 `go test ./...` 后台 + `tools/check-crossbuild.cmd`。
3. 纯逻辑配测试并登记 `npm test`；测试/构建命令不接 grep/tail 管道（吞退出码）。
4. 用户可见变更同步 `CHANGELOG.md` 与 `README.md` 对应小节。
5. 体积基线实测记录（P1/P3 引入依赖后），对照 `docs/reports/optimization-proposals.md` 的基线。
6. 全部实施完成后，方案从 `docs/unfinished-plans/` 移入 `docs/finished-plans/`。

---

## 8. 验收与回退

- **验收**：每期按文中「验收」条逐项过；`go test ./...`（后台、`-timeout 300s`）+ `npm test` + `npm run build` + `go build` 全绿。
- **回退**：各期独立 commit（conventional commits + 中文描述），可单独 revert；新依赖单独一个 commit，便于回退体积。
- **开关**：连接功能加总开关（默认关），出问题可一键隐藏入口，不影响其他功能。

---

## 9. 明确不做（本期边界）

- 不做 ORM、不做通用 DB 抽象层的过度设计（只要够 3 种数据库用的薄接口）。
- 不给 AI 暴露数据库连接/查询/写入工具（需另立授权方案）。
- 不做 SSH 隧道（可能破坏零依赖，需产品决策后再议）。
- 不做 ERD、数据对比、图表、迁移、备份调度等 IDE 级功能。
- 不做 Redis 的 Workbench 插件生态、教程、schema-aware Search（做到「多行命令 + 结果分块 + 历史」即可）。
- 不在 P0/P1 做写入；不把 Redis 塞进 SQL 表格模型。
- 不引入 cgo、外部 CLI、npm 运行时安装、平台 backend 下载（守单 exe 零依赖）。

---

## 10. 主要调研来源（本次实际打开，2026-11-22）

**JetBrains**：[introspection](https://www.jetbrains.com/help/datagrip/introspection.html) · [introspection levels](https://www.jetbrains.com/help/datagrip/introspection-levels.html) · [data editor](https://www.jetbrains.com/help/datagrip/data-editor.html) · [submit changes](https://www.jetbrains.com/help/datagrip/submitting-and-reverting-changes.html) · [query execution](https://www.jetbrains.com/help/datagrip/query-execution.html) · [confirm drop](https://www.jetbrains.com/help/datagrip/confirm-drop-dialog.html) · [Redis support](https://www.jetbrains.com/help/datagrip/redis.html)

**Beekeeper Studio**：[CLAUDE.md 架构](https://github.com/beekeeper-studio/beekeeper-studio/blob/master/CLAUDE.md) · [进程架构](https://deepwiki.com/beekeeper-studio/beekeeper-studio/2.1-electron-process-architecture) · [DB clients](https://deepwiki.com/beekeeper-studio/beekeeper-studio/3.2-database-clients-implementation)

**DBeaver**：[架构约定](https://github.com/dbeaver/dbeaver/blob/c69e7f6ff6b952b9e036ba61c377432f0da1acdd/AGENTS-Architecture.md) · [Data Editor](https://dbeaver.com/docs/dbeaver/Data-Editor/) · [Virtual Keys](https://dbeaver.com/docs/dbeaver/25.2/Virtual-Keys/) · [安全限制](https://dbeaver.com/docs/dbeaver/25.2/Managing-security-restrictions-for-database-connection/)

**SQLTools / VSCode**：[driver template](https://github.com/mtxr/vsc-sqltools-driver-template) · [language server 源码](https://github.com/mtxr/vscode-sqltools) · [Go plugin 警告](https://pkg.go.dev/plugin)

**Redis**：[RedisInsight 官方](https://redis.io/docs/latest/develop/tools/insight/) · [SCAN](https://redis.io/docs/latest/commands/scan/) · [KEYS](https://redis.io/docs/latest/commands/keys/) · [ARDM 源码](https://github.com/qishibo/AnotherRedisDesktopManager)

---

## 11. 实施记录（2026-11-22，P0–P2 一次落地）

### 11.1 交付物

- **Go 引擎 `internal/dbclient/`**（纯引擎，不 import main）：`dbclient.go`（类型/常量/入口）、`driver.go`（契约+编译期注册）、`guard.go`（SQL 分类器）、`sqlite.go`、`mysql.go`、`session.go`（注册表/空闲回收/取消）、`query.go`（控制台+浏览下推）、`edit.go`（受控写入）、`config.go`（连接配置+dpapi 凭据）；测试 `guard_test.go` / `dbclient_test.go` / `config_test.go`（含真实 SQLite 端到端）。
- **根壳绑定**：首次落地为根目录 `dbclient_app.go` 的 15 个绑定（DBOpen / DBConnect / DBListDatabases / DBListObjects / DBDescribe / DBBrowse / DBQuery / DBCancel / DBClose / DBListConnections / DBSaveConnection / DBDeleteConnection / DBTestConnection / DBPreviewChanges / DBApplyChanges）；当前按服务化嵌入约定迁至 `internal/dbclient/service.go`，共 25 个 `DB*` 绑定，mock-backend 全部补齐。
- **前端 `src/db/`**（新域，factory+deps）：`db-page.js`（三栏装配+启用门）、`db-object-tree.js`、`db-table-grid.js`、`db-query-editor.js`、`db-connections.js`、`db-grid-core.js`、`db-model.js`（纯函数）；测试 `frontend/test/db/db-model.test.mjs` 已登记 `npm test`。
- 接线：`core/app-pages.js` 加 `database` 页、`main.js` appPageMounters 注入、样式追加 `style.css` 尾段。

### 11.2 评审决策落地（§5.1/§5.2 开工前四项）

1. **guard 分类器**：词法级 tokenizer（引号/注释/括号深度）+ 语句拆分（方言感知：MySQL `#` 注释、`--` 需空白、反斜杠转义）+ 首关键字分类；**数据变更 CTE 逐体检查**（`WITH x AS (DELETE … RETURNING …)` 判写）；未知语句 fail-closed 按写拒绝；PRAGMA 赋值/`wal_checkpoint` 判写；MySQL `INTO OUTFILE/DUMPFILE/@var`、`CALL`、`GRANT`、`LOAD` 等归危险。逗号词法化修复了多 CTE 列表的误判（测试抓出）。
2. **排序/筛选下推**：表浏览全下推——ORDER BY / 结构化筛选（列名经元数据白名单、值全走占位参数）/ LIMIT OFFSET；contains 用 `ESCAPE '!'`（反斜杠在 MySQL 字面量里语义危险）。
3. **页内多对象导航**：面板内子标签页（`db-tabbar`），每张打开过的表一个标签，关标签不清会话（空闲回收兜底）。
4. **取消路径**：第六个绑定 `DBCancel(sessionID, queryID)`；控制台执行中可取消，慢查询不再只能等 20s 超时。

### 11.3 与正文的偏离（已确认）

- **连接目标校验收窄**（§5.2）：只拦链路本地地址（169.254.0.0/16 含 IMDS）与 metadata 主机名，内网保留段默认放行——开发库多在 192.168.x.x，默认拒内网等于让多数用户第一次用就去改配置。
- **行定位只认主键**（§5.3 原文「主键/唯一索引」）：唯一索引不做行身份（NULL 语义与组合键歧义），无主键表一律只读，UI 给出原因。
- **两阶段确认协议**（§5.3 DROP 确认等）：guard 返回 `Status=confirm + 原因`（danger / missingWhere），前端确认层后带 `confirmed=true` 重发；DDL 恒拒（`Capabilities.DDL=false`），确认层只对写路径生效。
- **截断判定**：分页下推 LIMIT 取 limit+1，由结果组装层截断打标——LIMIT 在服务端截掉后客户端看不到第 limit+1 行，少取一行永远标不出 Truncated（测试抓出）。
- **MySQL 只读第二道**（评审建议）：池限 1 连接 + 建连后 `SET SESSION TRANSACTION READ ONLY`（best-effort，连接重建会丢——guard 分类是主防线）。
- **总开关**（§8）：落 `settings.dbToolsEnabled`（默认关），启用门做在页面内（开关在页面上，未启用时页面只显示启用门）；未接入设置树，避免新增 `opt-` 行的联动成本。
- **SQLite 打开是临时会话**，不落连接表（§5.1 原文的 `config.go` 移到 P1，服务 MySQL 连接管理）；「允许编辑」在打开对话框显式勾选（默认只读 mode=ro）。
- **WAL/immutable 兜底**：mode=ro 失败（WAL -shm 无读权限）自动以 immutable=1 重试一次，SessionInfo.Immutable 标记 + 界面「只读快照」徽标提示，非静默降级。

### 11.4 留痕与凭据

- 写留痕经前端 activity 攒批：控制台写语句（`db.exec`）与提交（`db.apply`），detail 只含类型/行数/耗时，**不含参数值与密码**（与方案 §5.3 一致）。
- 密码：dpapi 加密（Sealed 标记）单独落 `db-credentials.json`，复合键 `connectionID|host|port|user`；非 Windows（dpapi.Supported()==false）退明文（envvars/aiconfig 同款退路）；凭据文件损坏时报错不覆盖。

### 11.5 验证（全部通过）

- `go test ./internal/dbclient/`：表驱动分类/拆分/批量口径 + 真实 SQLite 端到端（只读拦截含 CTE bypass、下推浏览、截断、冲突回滚、会话上限回收、取消）。
- `go test ./...`（后台 + `-timeout 300s`）：62 包全绿；`go vet`、`gofmt` 干净。
- `npm test`：2324 例全绿（含 icon-guard / form-controls-factory / overlay-esc-guard / test-manifest 等守卫）；`npm run build` 通过。
- `tools/check-crossbuild.cmd`：linux/amd64、darwin/arm64、darwin/amd64 全过（go-sql-driver 纯 Go）。
- 体积：`go build -tags production` 实测 46,088,192 B（≈43.9 MiB）；本功能增量以 **go-sql-driver ~0.6 MB + 前端 dist ~30 KB** 计（同期有并行特性合入，无法与旧 exe 基线逐字节剥离），在批准的 +1.5 MB 预算内。

### 11.6 入口重构：应用页面 → 侧栏面板 + 一切皆标签（2026-11-22 作者纠正后返工）

首次实施把数据库做成应用页面（APP_PAGES 一项，三栏一个页面）。作者纠正：要符合「一切皆标签」语义，但**不进应用页面**——改为：

- **入口**：活动栏新增 `ab-database` 图标 → 侧栏「数据库」面板（`sidebarView='database'`，与 files/git/structure/chats/app-pages 同一套切换器；白名单在 `terminal-ui.js` 的 currentSidebarView/switchSidebarView 两处 + main.js 的 applySidebarUI）。
- **工作区清单**：`settings.dbWorkspaceDatabases`（平铺数组、条目带 `workspace` 字段，lifecycleHooks 同款「本机设置、按工作区生效」模式；跨窗经 settings-changed 同步）。条目：`{id, workspace, kind, name, path?|connectionId?, allowEdit?, addedAt}`——SQLite 存路径（allowEdit 条目级开关，菜单切换、重开标签生效）；MySQL 引用全局连接 id（配置与凭据仍在 Go 侧，多工作区共享，`db-ui.js` 只存引用）。
- **面板交互**：按类型分组（SQLite / MySQL，可折叠）；顶部「+ SQLite 库文件 / + MySQL 连接」；MySQL 添加 = 未引用的已保存连接清单 + 「新建连接…」；双击行 → 开标签页；右键或行尾 `[...]` → 菜单（打开 / 允许编辑 / 测试连接 / 编辑连接 / 删除连接（全局）/ 从工作区移除，`ctxMenu` 右键菜单）。
- **标签页**：`core/tab-kinds.js` 新增视图型 `{marker:'dbView', kind:'database', icon:'database', label:'数据库'}`（resolve 细分为条目名，AI 上下文能认出具体库）；创建点在 `bridge/bridge-database-view.js`（marker + key 成对，key = 条目 id 去重）；分派在 `editor-groups.js` 的 `VIRTUAL_TAB_VIEWS.database`；视图本体 `src/db/db-tab.js`——**一个标签页 = 一个库会话**：挂载时连接、`doc.tabUnmount` 统一契约断开（网格未提交修改随关标签丢弃）；页内仍是「对象树 | 表网格（面板内子标签）| SQL 控制台」三栏。
- **原应用页面形态移除**：APP_PAGES 条目、appPageMounters 条目、`db-page.js` 删除；接线守卫 `virtual-doc-wiring.test.mjs` 的 tabUnmount owners 清单加入 `bridge-database-view.js`。
- **连接对话框化**：`db-connections.js` 收敛为纯对话框族（`openConnectionEditor` / `confirmDeleteConnection` + 共用 `openMaskDialog`），供菜单与添加流复用。
- **TDZ 防线**：`dbUi` 建得晚（bridgeUI 解构后），侧栏重绘经早期 hook 间接层 `dbSidebarRenderHook`（仓库 2026-11-18 教训的同款处理）；terminal-ui / editor-groups 的 deps 一律 lazy getter。

### 11.7 新建连接对齐 JetBrains「数据源和驱动程序」（2026-11-22 作者要求）

MySQL 的添加/编辑从「先选已有再新建」两步流收敛为**统一管理对话框**（`db-connections.js` 的 `openConnectionsManager`）：左侧连接清单（+ 新建 / − 删除，行带「工作区」引用徽标）、右侧表单——名称自动建议 `user@host:port`（nameTouched 前跟随主机/用户/端口，对应 JetBrains 的 `@localhost`）、主机端口并排、用户/密码（密码留空保持已存）、数据库、允许编辑开关、**「加入当前工作区」开关**（对应 JetBrains 的「项目数据源」概念，应用时经 `syncWorkspaceRef` 同步引用）、URL 只读预览；底部 测试连接 / 取消 / 应用 / 确定（应用 = 保存草稿并刷新列表不关窗）。SQLite 添加保持文件选择（JetBrains 的 SQLite 数据源同样只选文件）。连接对话框仅此一处入口：侧栏 [+ MySQL 连接] 与行菜单「编辑连接…（打开连接管理并定位该连接）」。

### 11.8 入口重构 v2：会话面板化（2026-11-22 作者纠正「方向错了」）

作者以 JetBrains DataGrip 截图为准：侧栏「数据库」面板本身就是**会话面板**——连接条目展开即建立会话，树直接长在侧栏（连接 → 库 → 分组「表 N」「视图 N」+ MySQL 专属「服务器对象」→ 排序规则 / 用户 / 虚拟视图）；**双击数据表直接以独立虚拟标签页打开全宽数据网格**（一个表一个标签），不再有「库标签页内嵌树+子标签+控制台」的三栏布局。旧 `db-tab.js` / `db-object-tree.js` 删除，演进为：

- **`db-sessions.js`（会话管理器）**：模块级单例。一个工作区条目至多一个会话（幂等连接、并发共享 pending）；disconnect/reconnect 沿用 connectEpoch 世代防线（在飞连接 resolve 后自释放）；订阅通知驱动树与标签页刷新。会话生命周期挂侧栏：关标签页只关视图，断开靠行菜单或 Go 侧 15min 空闲回收兜底（面板给重连入口）。
- **`db-session-tree.js`（侧栏会话树）**：全部懒加载（沿用 L1/L2 按需语义）。表/视图节点行尾 muted 注释（MySQL `TABLE_COMMENT`，`DBObject.Comment`）；服务器对象分组仅 MySQL 显示，`DBListServerObjects` 每组独立查询独立容错（权限不足的组隐藏整组）；类型分组折叠沿用原语义。
- **`db-tab-views.js`（表/控制台标签页）**：`TAB_KINDS` 的 `dbView` 拆为 `dbTable`（key=条目|库|表，图标按表/视图细分）与 `dbConsole`（每会话一个，key=条目 id）两个 marker；marker 字段保持去重 key 字符串、域数据在 `dbTableSpec`/`dbConsoleSpec`。会话三态壳（连接中/失败/断开+重连）由 `mountWithSession` 收口。
- **编辑链路对齐（图4/图5）**：内联编辑框完全接管 `.dlg-input` 对话框形态（26px 行高内占满单元格、无圆角缝隙、accent 描边）；修改单元格显示**新值**（修掉 displayRows 不应用 updates 的显示 bug）+ `db-cell-dirty` 高亮 + 行号列同色高亮（`db-row-dirty`）；提交改 icon 按钮——无修改灰、有修改亮，**点击出预览弹层（两阶段确认保留），Ctrl+Enter 直接提交**（作者拍板对齐 JetBrains 默认行为）。顺带修掉 `.db-btn[hidden]` 被 `display:inline-flex` 覆盖导致编辑簇在只读会话也显示的老坑，以及预览弹层取消路径只 dispose 不清 DOM 的残留（overlay-stack 收口规范同款）。
- **Go 协议扩展**：`DBObject.Comment` / `DBTableMeta.TableComment`（information_schema.tables 顺带把行数与注释合并成一次查询）、`ListServerObjects`（排序规则/用户/系统视图，`ServerObjectGroup.Error` 单组容错）、绑定 `DBListServerObjects`；mock-backend 同步。

### 11.9 从零建库建表（2026-11-22 作者要求「建库 + SQLite 开放建表」）

此前只能接入已有库文件，且 guard 对 DDL 恒拒——「从零建库」链路不存在。本次开放（作者在两个选项里拍板选了带建表的方案）：

- **新建空库文件**：Go `CreateSQLite(path)`——`O_CREATE|O_EXCL` 原子判定「已存在」（绝不覆盖）；0 字节文件对 `mode=rw` 的 file: URI 合法，随后「建 `_cadt_init` 表再删」的真实写事务落盘 100 字节文件头（`PRAGMA journal_mode` 不产生写 I/O，试过会留下 0 字节半截文件——失败路径 `os.Remove` 清理）。绑定 `DBCreateSQLite`；前端「新建 SQLite 数据库…」（保存对话框，mock 同步），建好默认 `allowEdit: true` 加入工作区。
- **DDL 能力位开放（仅 SQLite）**：`sqliteDriver.Capabilities().DDL = true`——`checkBatch` 的 `ddlAllowed` 参数早已存在，DDL+危险语句（DROP/TRUNCATE/…）未确认时仍走 `confirmDanger` 两阶段确认；只读会话被 editable 门挡住；**MySQL 驱动保持 DDL=false 恒拒**。control 台 `CREATE TABLE` 直接执行、`DROP TABLE` 确认后执行。
- **结构化「新建表」表单**（`db-create-table.js`）：入口在树「表」分组行尾的 + 按钮（仅 SQLite editable 会话渲染）；表名/列名保守校验（`isValidIdent`：字母数字下划线、不以数字开头——双引号包裹只是兜底，明防线避开关键字）；类型白名单 INTEGER/TEXT/REAL/BLOB/NUMERIC；单主键落列内（INTEGER 主键保留 rowid 别名）、复合主键表级 `PRIMARY KEY (…)` 声明、主键列隐含 NOT NULL；生成的 SQL 走控制台同一条 `DBQuery` 通道（guard 分类全部生效，不做旁路），成功后清树缓存刷新清单。SQL 生成纯函数 `buildCreateTableSQL` 有表驱动测试（已登记 npm test）。
- **测试**：`guard_test` 的 DDL 用例改为能力位语义（未开放拒 / CREATE 直接放行 / DROP 确认链路），`TestSQLiteEditableFlow` 的「DDL 恒拒」改写为「确认后 DROP 真实执行」，新增 `TestCreateSQLite`（落盘 / 已存在报错 / 空库可开可建表）。

### 11.10 对齐 JetBrains 的八项打磨（2026-11-22 用户实测反馈）

1. **自动重连**：空闲回收是服务端静默行为，网格/控制台调用失败识别 `isSessionMissing` → `sessionLost()`（`db-tab-views` 挂载壳提供，`reconnectSession` + 5s 节流）→ 成功即 `sessionRecovered()` 重建面板自动重载；再失败落回错误态。防循环靠节流 + 重建后新会话 lastUsed 新鲜。
2. **树缩进**：固定步进（条目 20 → 库 36 → 分组 52 → 表节点 68；服务器子分组 68/叶子 84）——修正库行父子倒挂与表节点平级问题。
3. **树箭头 SVG**：`iconSvg('chevron-right')` 替代文字「▸」。
4. **右键菜单层级补齐**：库/表分组/视图分组/服务器对象分组/表视图节点/条目行各有动作集合；`[...]` 去 tooltip；MySQL 菜单「编辑连接…」→「属性…」。
5. **AI 上下文**：`appTabViewOf` 对 dbTable/dbConsole 注入 desc（连接/库/类型），`ai-system-context` 拼括号说明。
6. **筛选重排 + 多列 ORDER BY**：WHERE/ORDER BY 分区标签；条件行栅格按 `.db-filter-col/.db-filter-op` 类定宽（enhanceSelect 触发器 wrap 继承原 select 类；**必须先入行再增强**——`sel.after(wrap)` 对未挂载节点无效，首版时序 bug 的教训）；`BrowseRequest.OrderCols` 结构化多列，Go 侧逐列 `resolveColumn` 白名单 + `quoteIdent`。
7. **分页档位/导出/导入/自动刷新**：pageSize 档位在状态条（自定义走 prompt，回填列表首位）；导出 CSV（`formats.csv.stringifyTable`）/JSONL（null 显式）；导入走受控写入（解析 → 列映射 → inserts → 预览/直提单事务），`DBReadImportFile` 绑定（UTF-8/20MB）；自动刷新档位菜单（`deps.ctxMenu`），编辑中/dirty 暂停、invalidate 静默停。
8. **单元格垂直居中**：`.db-grid-cell` line-height 20px。

### 11.11 行高列宽 / DDL 导出 / 控制台多结果（2026-11-22 用户反馈 9–11）

1. **列宽拖拽**：表头右缘 `.db-grid-colresize` 手柄（5px 命中区）横向拖动 → `colWidths` Map → 列模板经 `--db-grid-cols` 单一来源更新（拖过的列固定 px、未拖保持 minmax 弹性）；双击手柄恢复自适应；手柄 mousedown 阻断 click 防误触排序。**行高档位**：`ROW_HEIGHT` 常量改 `rowHeight` 可变 + `setRowHeight(h)`（canvas 高度与可视窗口重算），CSS 行高与 cell line-height 走 `--db-grid-rowh` 变量（`calc(行高 - 6px)` 保证文字随档位居中）；状态条档位 紧凑22/常规26/宽松32。
2. **DDL 导出**：`buildDDL(kind, meta)` 纯函数（db-model）——方言引号、DEFAULT 字面量转义（数字裸值/NULL/字符串）、单主键列内 + 复合主键表级、索引还原（SQLite autoindex 跳过）；朴素还原不虚构 ENGINE/自增。入口：树表节点右键（异步 DBDescribe）+ 表标签页「DDL」按钮（meta 在手同步生成）。
3. **控制台多结果**：`QueryOutcome.Results []StatementResult`（逐条 SQL 截断留档 + 结果 + wrote；兼容 Result = 最后一条）。前端结果区 tab 化：grid 共享 + 切换重放（不为每结果建 grid 实例），「输出」摘要逐条语句/行数/消息 + 总耗时；mock 同步按分号拆语句演示。Ace 多行编辑器（高亮/补全/Ctrl+Enter）由编辑器补全方案（editor-completion）落地，此处只做结果呈现。

### 11.12 控制台配色对齐编辑区（2026-11-22 用户反馈）

控制台 Ace（`window.ace.edit()` 运行时创建）会被 Ace **动态注入默认主题 CSS**（晚于构建期样式表），token 硬色盖掉应用的代码风格变量——关键字变默认蓝紫，与编辑区（jsoneditor 主题 CSS 打包在构建期、被 style.css 按序覆盖）不一致。修复：`.db-sql-ace` 的全部 token 框架规则（关键字/字符串/注释/数字/布尔/NULL/函数/标点/标识符/选区/gutter）加 `!important`，颜色永远走 `--syn-*`/`--code-val-*`/`--editor-*` 变量——随 `data-code-style` 代码主题与界面主题切换，控制台与编辑区永远同源（实测 auto（expUI dark）下关键字 #cf8e6d、字符串绿、注释灰）。

### 11.13 P3 Redis 实施（2026-11-22，用户拍板「完整 §5.4 一步到位」）

**范围**：连接（驱动下拉 + ACL 用户名/库编号）→ 会话树键空间（SCAN 分层聚合、`:` 前缀分组/扁平切换、诚实计数 + 加载更多）→ 键查看器标签页（五类型行集 + string 四档 formatter + 行编辑）→ TTL 修改/PERSIST → 单键删除 + 前缀批量删（Type-to-Confirm）→ 查询控制台（词表 guard + 两阶段确认）。0 新依赖。

**落地决策与偏离**（对照 §5.4）：
- **会话架构**：`dbSession` 加 `redis *redisClient` 字段（nil = SQL 会话）——生命周期登记/空闲回收/取消与 SQL 会话共用一条流程；Redis 不进 Driver 注册表（遵守 driver.go:5「独立子系统」声明），在 `openSession` 分派最前面走 `openRedisSession`。Close/sweep 三处 `s.db.Close()` 收口为 `closeSessionConn`。
- **RESP2 客户端**（`redis.go`）：单连接串行 + pipeline（TYPE/TTL/长度批量）；`-ERR` 回复作为**回复值**（`*respError`）不中断 pipeline——单条命令打错类型不毁连接；IO/协议错误才断连。文件头注明可替换 go-redis/v9。
- **guard**（`guard_redis.go`）：首词 + 白名单 + fail closed 与 SQL 同模型；读白名单精确枚举（`config get` 两词精确放行，config 其余 danger）；MULTI/EXEC/WATCH → classCtrl（控制台拒，与 SQL BEGIN/COMMIT 同口径）；`xread/xreadgroup` 不进读白名单（BLOCK 参数会阻塞）；memory/client/object/acl 整体不进白名单（子命令混杂）。控制台按行拆（`splitRedisStatements`），一行一条命令。
- **编辑提交走结构化 `RedisOp`**（`DBRedisApply`，RESP 直发不经文本解析——多行/二进制值安全），弹层展示等价命令文本（§5.4「编辑生成命令预览」）；`setString` 携带原 TTL（SET 清 TTL → 第二条 EXPIRE 补偿，不用 SET KEEPTTL 因 Redis <6.0 不支持）。控制台文本命令才走 guard 词表。
- **键空间树**：分层懒加载（每前缀层独立 SCAN 缓存，COUNT 250/批 + cursor 续扫），`redisPrefixTree` 客户端聚合（组名与叶子名共存互不吞并，尾分隔符键 `user:` 是叶子）；根层搜索 = SCAN MATCH；组右键「删除此前缀」走 Type-to-Confirm（输入完整前缀才可确认）。
- **键查看器**：`dbRedisKey` 新虚拟标签页（marker/key 成对、tab-kinds 单一来源）；集合类型双击行弹层编辑（hash field/list index/set member/zset score；stream 只读）；string 编辑走「整值覆盖 + TTL 保持」语义并在弹层标题明示截断覆盖。
- **mock**：演示连接管理（DBListConnections/DBSaveConnection 内存 store）+ Redis 键空间 store（五类型 + 中文前缀组）+ 控制台按行拆的 guard 行为演示——浏览器 mock 环境全流程可测。
- **测试**：Go 假 server（每用例独立 listener，不写 TestMain——规避 AGENTS.md 子进程递归陷阱）全链路 8 例 + RESP/词表/拆行表驱动；前端 `db-redis.test.mjs` 9 例（聚合/转义/TTL 文案）。
- **已知边界**：不支持 Cluster/Sentinel/TLS/Pub-Sub/MONITOR/Lua 编辑；SCAN 期间键增删不承诺快照一致；非 UTF-8 键名显示转义、操作全程精确传值；string 预览截断 256KB、集合行集截断 5000 元素。

### 11.14 验收缺口收口与归档（2026-11-27）

逐项对照 §5.1–§5.4 复查后，修复五处未收口点：

1. **Redis 测试连接**：`TestConnection` 对 Redis 走独立分派，不再调用只注册 SQLite/MySQL 的 `driverFor`；正常连接与测试连接共用 `openRedisConnection`，AUTH/SELECT/PING 完全一致，测试再读 `INFO server` 版本（ACL 禁用 INFO 时返回 `Redis unknown`，不把可选元数据权限误判成连接失败）。
2. **Redis 目标校验**：`openRedisConnection` 复用 `resolveSafeAddrs`，拒绝云元数据/链路本地地址，并直连校验后的 IP，封住校验与拨号间的 DNS rebinding 窗口；localhost 多候选按 IPv4 优先逐个尝试。
3. **SQLite 外键元数据**：`DBTableMeta` 新增 `ForeignKeys`，`sqliteDescribe` 读取 `PRAGMA foreign_key_list`，按 id/seq 聚合复合外键，保留引用表/列与 ON UPDATE/DELETE 动作。
4. **浏览取消**：`BrowseRequest.QueryID` 与 `DBCancel` 对齐；前端每次浏览带模块级唯一 `queryId`，新请求先取消旧请求，会话失效也取消在飞浏览。取消只中断服务端执行，旧响应仍由 `loadSeq` 丢弃，不回写新状态。
5. **Redis TTL=0**：TTL 输入 `0` 先弹删除确认，再走 `DEL` 等价命令预览；`-1` 为永久，空值与小于 `-1` 的输入拒绝，避免空输入被 `Number('')` 误当成 0。

回归测试新增：`TestSQLiteDescribeForeignKeys`、`TestBrowseCancel`、`TestRedisTestConnection`、`TestRedisRejectsLinkLocalTarget`，以及前端 `redisTTLDraftAction` 与浏览取消接线守卫。真实 MySQL/Redis 服务端联调未在本次重跑；Redis 后端链路由进程内假 server 覆盖，SQLite 使用真实临时库。

**验证（2026-11-27）**：

- `go test -timeout 180s ./internal/dbclient`、`go test -timeout 120s -run TestAppBindingBaseline .`：通过。
- `npm test`：typecheck + 1737 + 777 + 537 + 21，共 3072 例通过；`npm run build`、`go build`：通过。
- `tools/check-crossbuild.cmd`：linux/amd64、darwin/arm64、darwin/amd64 全部通过。
- `go test -timeout 300s ./...`：通过。初次全量运行暴露的既有 `internal/search` rg 取反缺陷已于同日另行修复，最终全量复跑通过。