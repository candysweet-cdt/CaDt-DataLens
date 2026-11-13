# AI 面板 v3：模型账号多模型、双层级选择器与体验批量升级

状态：已实施（2026-11-13；追加第 9 项「会话置顶」）。对应 CHANGELOG「AI 助手」小节新增条目。

## 背景

一批面向日常使用体验的升级需求（用户编号 1、2、4、5、6、7、8，无第 3 条；后续追加 9）：

1. 模型选择改为双层级（Qoder 风格两行 chip + 搜索分组下拉）
2. 停靠分屏模式下 AI 面板与内容区左右互换
4. 一个 API Key（账号）配置多个模型；每模型独立配置窗口与输入能力；窗口支持 K/M 单位
5. cc-switch 式用量查询
6. 审批接管卡临时收起
7. 每轮结束显示「已编辑 N 个文件」汇总卡
8. 内置浏览器视口宽高可由用户或 AI 控制

体积约束：零新依赖（前端原生 JS/CSS，Go 标准库）。

## 关键设计

### 数据结构（前端全权定义，`aiconfig.go` 仍只透明读写）

- `profile`（账号）：`{id, name, provider, baseURL, apiKey, proxy, extraHeaders, temperature, models[], lastModelId}`
- 模型条目：`{id, model, contextWindow, outputWindow, modalities:{text,image,video,audio}, reasoningEffort, thinking, thinkingBudget}`
- `config.activeModelId` 全局激活条目；`profile.lastModelId` 记住每个账号的选择
- **迁移**：旧单模型字段（`model/maxTokens/contextWindow/...`）→ 迁移为首条目（`maxTokens`→`outputWindow`），旧字段保留并镜像激活条目（`saveAIConfig` 前统一 `syncActiveMirror`），旧版本 exe 回滚仍可用
- 纯函数集中在 `frontend/src/ai-config-model.js`（`parseTokenAmount` / `formatTokenAmount` / `windowValue` / `migrateAccountModels` / `configForModel` / `resolveModelRef` / `modelRefLabel`），配套 `ai-config-model.test.mjs`（已加入 `npm test`）
- 分类器引用升级为 `账号id|模型id`（`resolveModelRef` 兼容旧纯账号 id），下拉按账号×条目生成

### 双层级选择器（`ai-panel.js`）

- chip（`renderModelChip`）改两行：模型 / 推理等级，各自带 chevron
- `showModelPicker()` 自绘弹层（append 到 body，fixed 定位在 chip 上方）：搜索框（token 匹配模型名+账号名）、按账号分组的条目列表（当前条目 ✓、窗口 K/M 小字、↑↓/Enter/Esc 键盘导航）、底部推理等级选项行与「模型设置…」；`closeModelPicker()` 在切换后调用
- `/model` 斜杠命令直接打开选择器

### 设置界面

- `#dlg-model-editor` 改「模型账号」编辑器：上区账号字段；下区模型条目 strip（`.ai-entry-chip` 选中态）+ 添加/删除（至少保留 1 条）；条目字段（模型 ID、上下文窗口、输出窗口、模态勾选框、推理强度、思考）实时写入当前编辑条目
- 「获取列表」→ `showModelListPicker` 多选弹层，勾选批量添加条目
- `renderModelList` 改账号卡片（N 个模型 + 当前条目 + 查询用量/编辑/复制/删除）
- 窗口输入 `type=text`：失焦 `parseTokenAmount` → clamp（上下文 2048–8M，输出 1–2M）→ `formatTokenAmount` 回显

### 模态能力生效

- `addAttachment` 图像分支拒绝（当前条目 `modalities.image === false` 时 flash 提示）
- `updateSendState`：已附加图片但模型不支持时禁用发送并在提示条说明

### 用量查询（Go）

- `ai_usage.go`：`AIUsageResult{Supported,Provider,Items,Error}` + 内置端点表（host 匹配，容忍默认端口）：DeepSeek `/user/balance`（origin 拼，不带 /v1）、OpenRouter 固定 `/api/v1/credits`、SiliconFlow `/v1/user/info`；复用 `newAIHTTPClient`（代理生效）+ `aiForbiddenHeader` 校验的自定义头；15s ctx、64KB LimitReader、非 200 报 `HTTP %d：响应片段`
- 前端 `queryUsageForAccount` / `showUsagePopover`：账号卡片按钮触发的弹层（Label/Value 列表；不支持/错误文案区分）

### 每轮文件汇总卡

- 时机：`finishStream` → `appendChangesSummary(session, stream.startedAt)`：聚合 `session.changes` 中 `time >= startedAt` 的记录按 relPath 合并
- 持久化：assistant 消息 `kind:'changes-summary'`（`normalizeMessage` 放行 kind+changes；`serializeSessionMessage` 白名单外键全保留 → JSONL 重放可渲染）
- 不发模型：`buildApiMessages` 跳过；渲染：`turnFinalItem` 跳过、`renderTurn` 抽出 processAll、在 final answer 后渲染 `.ai-changes-card`（默认 3 条 + 「再显示 N 个文件」，`changesSummaryFold` Map 记忆；审阅 = 逐文件 `GitDiffFor` 拼接 → `openVirtualDoc`（main.js 经 opts 注入））

### 审批卡收起

- 模块级 `approvalTakeoverKey/Collapsed`；换审批或 `decideApproval` 复位
- 收起态渲染单行 `.ai-takeover-bar`（图标 + 文案 + 统计 + 展开箭头），展开态头部右侧 `.ai-takeover-collapse` 按钮

### 布局互换

- `settings.aiPanelSide`（`left/right`，main.js 归一化 + `applySettings` 应用 `#top-row.ai-left`）
- ai-panel `applyPanelSide/togglePanelSide` + 头部 `#ai-side-btn`；`APP_SETTING_RULES.aiPanelSide`（enum）供 AI `set_setting`
- CSS：`order:-1` + 边框朝向翻转 + 手柄切换（左置时显示 `ai-resize-r`、dock-fill 双侧都藏）；`startResize` 放行 `r` 手柄、`moveResize` 按 side 取反 dx

### 浏览器视口

- 单一真源 `.browser-surface`：`doc.browserViewport = {mode:'fit'|'fixed', width, height}`；`applyBrowserViewport` 设内联尺寸 + `margin:auto` 居中，ResizeObserver → `syncBrowserTab` 自动同步原生 WebView2（Go 零改动）
- 用户入口：工具条 `.browser-viewport-btn`（当前尺寸文本）→ `showBrowserViewportMenu`（自适应/4 预设/自定义）→ `showBrowserViewportDialog`（单输入「宽×高」，`parseBrowserViewportText` 200–8000 校验）
- AI：`browser_resize` 工具（write 档以上）→ `browserHost.applyViewport` 桥（main.js 按 doc id 找标签）→ 同一 `setBrowserViewport`

### 会话置顶（追加的需求 9）

- 数据：`session.pinned` boolean；`buildSessionMeta` 写入 meta.json（签名变化自动触发重写），`normalizeSession` / `createSessionData` 归一化默认 false；Go 侧 meta 只取已知字段，未知字段被 json 忽略，零改动
- 排序：置顶会话从工作区分组中抽出，固定渲染在列表最上方的「置顶」分区头之后（分区头只提示数量，不折叠）；组内与时间排序不受影响
- 入口：会话条目右键 / ⋯ 菜单「置顶会话 / 取消置顶」、会话列表更多菜单「置顶当前会话」；`toggleSessionPin` 走 persistSessions + renderSessionList + flash，已归档会话拒绝置顶
- 视觉：条目标题行左侧图钉标记（icons.js 新增 `pin` 实心图标），置顶分区头同款图标

## 文件清单

- 新增：`frontend/src/ai-config-model.js`（+test）、`ai_usage.go`（+test）
- 修改：`frontend/src/ai-panel.js`（数据层接入/选择器/设置编辑器/汇总卡/收起/工具/会话置顶）、`frontend/src/ai-session-store.js`（meta 增加 pinned）、`frontend/src/icons.js`（pin 图标）、`frontend/src/main.js`（settings、applySettings、initAIPanel 桥、浏览器视口）、`frontend/index.html`（编辑器对话框、头部换侧按钮、模型 pane 文案）、`frontend/src/style.css`（新组件样式）、`frontend/src/ai-permissions.js` 保持不动（旧导出留给兼容与测试）、`frontend/package.json`（test 脚本）

## 验证

- `npm test`（111+ 用例，含新增 ai-config-model 11 例）
- `go test ./...`（含 ai_usage 表驱动 + httptest mock）
- `wails build -devtools` 构建通过，`AIUsageQuery` 绑定自动生成
- 手动冒烟清单：chip 两行与选择器搜索/分组/等级；账号多模型 + K/M 输入 + 获取列表多选；图像禁用；三服务商用量 + 不支持提示；左右互换（含拖拽方向）；审批卡收起/展开；连续写文件两轮后的汇总卡（重放会话仍在）；浏览器预设/自定义视口 + AI browser_resize。
