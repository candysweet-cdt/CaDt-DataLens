# 内置技能统一为文件化（SKILL.md + go:embed）

> 状态：**待开工方案**，尚未实施。落地后移入 `docs/finished-plans/`。
>
> 背景：2026-11-24 一次关于「内置技能硬编码在 `ai-constants.js` 是否合适」的讨论。结论是现状的「一半硬编码、一半文件化」并存状态应当收敛，但**不能一刀切全搬**——`cadt-ui` 等少数技能被测试当作源码真源静态解析，必须留在源码。
>
> 本文所有行号为**评估日快照（2026-11-24）**，实施时以代码现状为准。

---

## 1. 现状：两套内置技能机制并存

### 1.1 机制 A：硬编码 `AI_BUILTIN_SKILLS`

- 定义：`frontend/src/ai/core/ai-constants.js:162-716`，**约 555 行**，占该文件（1167 行）近一半。
- 共 16 个技能：`code-review`、`json-toolkit`、`release-notes`、`patch-workflow`、`cadt-datalens`、`cadt-ui`、`cadt-gen-models`、`cadt-mcp-samples`、`cadt-mcp-config`、`web-research`、`docx`、`pdf`、`skill-creator`、`plugin-creator`、`inline-visual`、`answer-me-with-html`（其中 `cadt-datalens` 被用户目录同名技能覆盖，实际未生效）。
- 消费：`ai-panel.js:7285-7300` 的 `listSkillsRaw()` 遍历数组，`content` 经 `builtinSkillText()`（`:7268`）做 `{{EXE_PATH}}` 运行时替换。

### 1.2 机制 B：文件化 `docs/skills/` + `go:embed`

- 编译期：`embed_assets.go:22` 的 `//go:embed all:docs/skills` 把整棵树编进 exe。
- 清单：`internal/skills/skills.go:46` 的 `appBuiltinSkillDirs`，当前 4 个：`cadt-file-layout`、`reverse-engineer-anything`、`chinese-formal-document-format`、`landing-page-design`。
- 运行期：`materializeBuiltinSkills()`（`skills.go:135`）按应用版本释放到 `%APPDATA%\CandySweet\CaDt-DataLens\builtin-skills\`；前端 `resolveSkillDirs()`（`ai-panel.js:7191`）把它当普通技能根扫描。

### 1.3 两套机制的优先级关系

去重逻辑 `ai-panel.js:7346-7351`：rank 小者优先；同 rank 按 `rootOrder`，再按 `localOrder`，先到先得。

- 硬编码项 `rank: 600, rootOrder: 0`（`:7296-7297`）；
- 文件化内置根 `rank: 600, rootOrder` 从 1 开始（`:7301-7302`）；
- 用户目录 `~/.agents/skills` 为 `rank: 500`（`:7190`），所以用户版 `cadt-datalens` 覆盖内置版——这解释了为何界面里它显示「用户·通用」。

**同 rank 时硬编码恒优先于文件化**，两套机制语义重叠且优先级暗含冲突。

### 1.4 为什么要收敛

1. **职责污染**：常量文件被 555 行 Markdown 文案撑满，违反 AGENTS.md「出现第二个互不相关域就必须拆」。
2. **编辑体验差**：JS 里写 Markdown 要处理引号/反引号/换行，用 `.join('\n')` 或模板字符串，满屏 `\`` 转义（`ai-constants.js:588` 等），一个引号写错就编译失败。
3. **用户不可定制**：硬编码 content 不经文件系统，改措辞只能改源码重建；文件化那套天然支持同名覆盖（rank 100/200/400/500 均可盖过 600）。
4. **两套机制无明确分界**：现状的划分是历史形成的，没有可解释的规则。

---

## 2. 为什么不能一刀切：`cadt-ui` 与 `inline-visual` 的特殊性

### 2.1 `cadt-ui`：动作表是被静态解析的代码真源

三处硬依赖：

1. **三方对账守卫** `frontend/test/ai/ai-app-actions.test.mjs:27-31` 直接读 `ai-constants.js` 源码：
   ```js
   const start = text.indexOf("name: 'cadt-ui'");
   const nextSkill = text.indexOf("name: 'cadt-gen-models'", start);
   const segment = text.slice(start, nextSkill > 0 ? nextSkill : text.length);
   return [...segment.matchAll(/^\s*'- ([a-z][a-z0-9_]+)(?=[ {：])/gm)].map((m) => m[1]);
   ```
   抓出的动作表与 `main.js` 的 `APP_ACTIONS`、`runAppAction` 的 switch、`ai-panel.js` 的 `MCP_CONFIG_ACTIONS` 做四方对账。文件头注释明确：这是**「模型唯一能看到的动作清单」**。
2. **书签守卫** `frontend/test/editor/bookmark-list.test.mjs:64`：
   ```js
   assert.ok(constants.includes(`'- ${action}`), 'cadt-ui 技能动作表缺 ' + action);
   ```
3. **动态开关** `ai-panel.js:7288`：`appControlOn()` 关闭时按 `builtin.name === 'cadt-ui'` 隐藏技能（对应工具下发在 `ai-tool-defs.js:1280`）。

把动作表搬进 `docs/skills/cadt-ui/SKILL.md` 会让前两处守卫直接 assert 失败；要改就得把「动作表真源」从 JS 源码挪到 md，测试路径、正则口径全要跟着改，牵一发动全身。**收益（省 109 行）远小于风险。**

### 2.2 `inline-visual`：content 来自单一来源 `visual-spec.js`

`ai-constants.js:578` 的 content 是 `VISUAL_RULES.inlineVisual`，由 `frontend/src/core/visual-spec.js:357-358` 拼装：

```js
inlineVisual: [INLINE_VISUAL_BASE, MERMAID_SHEET, ECHARTS_TEMPLATE, GRAPH_TEMPLATE, WORDCLOUD_TEMPLATE].join('\n\n'),
```

`visual-spec.js` 是「AI 可视化规范的单一来源」，同时被 `core/widget.js`（限额）与图表引擎（主题色）消费。把它固化成静态 md 会形成两份事实，违反单一来源原则。**保留引用。**

### 2.3 结论：按「是否需静态解析 / 单一来源」分类，而非全搬

修正后的目标形态是**「文件化为主 + 少数留源码」的混合**，但划分理由明确、写进注释，比现状的「无理由混搭」清晰。

---

## 3. 分类决策

| 类别 | 技能 | 处理 | 理由 |
| --- | --- | --- | --- |
| **留源码** | `cadt-ui` | 保留在 `AI_BUILTIN_SKILLS` | 动作表是三方对账真源；动态开关按 name 判断 |
| **留源码** | `inline-visual` | 保留，content 仍引用 `VISUAL_RULES.inlineVisual` | 单一来源在 `visual-spec.js`，静态化会分叉 |
| **搬文件** | `code-review`、`json-toolkit`、`release-notes`、`patch-workflow`、`cadt-gen-models`、`cadt-mcp-samples`、`cadt-mcp-config`、`web-research`、`docx`、`pdf`、`skill-creator`、`plugin-creator`、`answer-me-with-html` | 迁到 `docs/skills/<name>/SKILL.md` | 纯文案，无静态依赖 |
| **搬文件（特殊）** | `cadt-datalens` | 迁到 `docs/skills/cadt-datalens/SKILL.md`，释放时替换 `{{EXE_PATH}}` | 占位符机制可复用 `writeSkillDirAt` 已有能力 |

搬走 14 个，`ai-constants.js` 的 `AI_BUILTIN_SKILLS` 从 ~555 行缩到 ~115 行（主要是 cadt-ui）。

---

## 4. 实施步骤

### 阶段 1：准备 SKILL.md 文件

1. 在 `docs/skills/` 下为阶段 3 表中的 14 个技能各建目录，写 `SKILL.md`：
   - frontmatter 的 `name` **必须等于目录名**（`TestBuiltinSkillAssetsPresent` 会逐字校验 `strings.Contains(data, "name: "+dir)`）。
   - `description` 原样搬 `ai-constants.js` 里的值（这是模型判断何时加载的唯一依据，不要改写）。
   - 正文把 `.join('\n')` 数组还原成正常 Markdown，去掉 JS 转义（如 `\`` → `` ` ``）。
   - `answer-me-with-html` 是模板字符串（`:582-714`），注意其中用于转义的 `\`` 要还原。
2. `cadt-datalens/SKILL.md` 保留 `{{EXE_PATH}}` 占位符原样（替换在释放阶段做，见阶段 2）。

### 阶段 2：Go 侧清单与释放

1. `internal/skills/skills.go` 的 `appBuiltinSkillDirs`（`:46`）加入阶段 1 的 14 个目录名。
2. `materializeBuiltinSkills()`（`:135`）里 `writeSkillDirAt(target, "docs/skills/"+dir, dir, "")` 的第四个参数改为当前 exe 路径：
   - 用 `os.Executable()` 取（与 `RegisterAgentSkill()` 同范式），失败时传空串并记 warn 日志——`writeSkillDirAt` 内部 `exe == ""` 时不替换，SKILL.md 会残留占位符，但不会让物化整体失败。
   - `writeSkillDirAt` 已有替换逻辑（`if exe != "" && strings.EqualFold(rel, "SKILL.md")`，把 `{{EXE_PATH}}` 全量替换），**无需改动该函数**。
   - 只有 `cadt-datalens` 的 md 含该 token，其余技能不受影响。
3. 版本标记 `want` 已包含清单字符串（`:139`），清单变化会自动触发重新释放，无需手动改标记格式。

### 阶段 3：前端收敛

1. `frontend/src/ai/core/ai-constants.js`：
   - `AI_BUILTIN_SKILLS` 只保留 `cadt-ui` 与 `inline-visual` 两项。
   - 删除 `import {VISUAL_RULES}`？**不要**——`inline-visual` 仍引用它。
2. `frontend/src/ai/ai-panel.js`：
   - `appControlOn()` 关闭时隐藏 cadt-ui 的判断（`:7288`）在硬编码循环里保留即可（cadt-ui 仍在数组中）。
   - `builtinSkillText()`（`:7268`）与 `getAIExePath()`（`:7260`）：确认无其他引用后删除（硬编码剩余两项都不含 `{{EXE_PATH}}`，替换逻辑失去作用）。**删除前全局搜索确认**。
3. `docs/skills/README.md`：
   - 「随 exe 分发」表格补上 14 个新技能及其用途。
   - 「内置技能」小节的版本标记目录树示例更新。
   - 「上游与许可」表：这 14 个多为本项目自研（随 Apache-2.0），`answer-me-with-html` 的内置版已注明参考 MIT 许可的 qingyuna 版本——照抄现有正文末尾的许可声明，不要丢。

### 阶段 4：测试护栏调整

1. `internal/skills/skills_test.go` 的 `TestBuiltinSkillAssetsPresent`（`:74`）：
   - 现在要求 `len(paths) < 2` 即失败（`:80`）。新搬的技能多为纯 `SKILL.md`，只有一个文件。
   - **建议放宽为「至少 1 个文件（SKILL.md）」**：检查 SKILL.md 存在 + frontmatter name 匹配已足够抓住「误把非技能目录加进清单」，「至少 2 个文件」这个约束没有额外价值。
   - 备选：给每个新技能配一个附属文件（如 `reference/notes.md`）——不推荐，纯属为凑数造文件。
2. `TestMaterializeBuiltinSkills`（`:95`）：补一条断言——释放后的 `cadt-datalens/SKILL.md` 不含 `{{EXE_PATH}}` 字面量（测试里 `os.Executable()` 指向 go test 二进制，非空即可）。
3. 前端守卫 `frontend/test/ai/ai-app-actions.test.mjs`、`frontend/test/editor/bookmark-list.test.mjs` **无需改动**——cadt-ui 仍在源码原位，定位字符串不变。

---

## 5. 验证方式

按项目规范，测试/构建命令**不接 grep/tail 等管道**，看退出码本身；Go 测试一律后台执行并显式带 `-timeout`。

| 项 | 命令 / 动作 | 期望 |
| --- | --- | --- |
| Go 单测 | `go test -timeout 300s ./internal/skills/ ./...`（后台） | 全绿，含 `TestBuiltinSkillAssetsPresent`、`TestMaterializeBuiltinSkills` |
| 前端测试门 | `cd frontend && npm test` | 全绿，尤其 `ai-app-actions.test.mjs`、`bookmark-list.test.mjs` |
| 类型检查 | `cd frontend && npm run typecheck`（已挂 npm test 前置门） | 零错误 |
| 交叉编译 | `tools\check-crossbuild.cmd` | linux/darwin 三目标可编译（改了 skills.go 的 os.Executable，属平台无关 API，应无碍） |
| 重建 exe | `powershell -ExecutionPolicy Bypass -File tools/rebuild-exe.ps1` | 先关运行中的实例；测试门通过后才构建 |
| 手动验收 | 启动应用 → 设置 → AI 助手 → 技能 | ① 16 个内置技能全部在列、来源标记「内置」；② 关掉「AI 工具权限 → 应用操作」后 cadt-ui 消失；③ `skill_use` 加载 cadt-datalens，正文里的 exe 路径是真实路径而非 `{{EXE_PATH}}`；④ 用户目录同名技能仍覆盖内置版 |

---

## 6. 风险与回滚

- **风险 1：技能描述措辞丢失**。搬文件时若改写 description，会改变模型的加载判断。缓解：description 逐字复制，验收时抽查。
- **风险 2：`answer-me-with-html` 的转义还原出错**。该技能正文含大量 `\`` 转义。缓解：搬完用 `read_file` 对照原数组逐节核；前端测试门会抓编译错误但抓不到文案走样。
- **风险 3：版本标记未刷新导致旧技能残留**。`want` 已含清单字符串，清单变化会自动重写；但若用户手工改过 `builtin-skills/` 里的文件，版本不变时不会覆盖（`skills.go` 的 stamp 命中逻辑）——这是既有设计，不是本次引入。
- **风险 4：cadt-datalens 的 exe 路径替换失败**。`os.Executable()` 失败时占位符残留，模型拿到的启动命令含字面量 `{{EXE_PATH}}`。缓解：记 warn 日志；正常环境不会失败。
- **回滚**：本改动集中在 `docs/skills/`（新增）、`ai-constants.js`（删）、`skills.go`（改清单与参数）、两个测试文件。用 git 逐文件反向编辑即可；**不要用 `git checkout` / `git restore`**（AGENTS.md 硬规则）。

---

## 7. 不在本次范围

- 不新增或删减技能条目，只改变存放形态。
- 不改技能的 description / 正文语义（除必要的 JS 转义还原）。
- 不改 rank 体系与去重逻辑。
- 不处理用户目录 `~/.agents/skills` 下的同名覆盖（行为保持不变）。
- `cadt-ui` 动作表真源迁移到 md 的改造——那是独立课题，需同步改三方守卫，收益不足以支撑本次一并做。
