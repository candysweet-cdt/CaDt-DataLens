# 内置技能统一为文件化（SKILL.md + go:embed）

> 状态：**待开工方案**，尚未实施。落地后移入 `docs/finished-plans/`。
>
> 背景：2026-11-24 一次关于「内置技能硬编码在 `ai-constants.js` 是否合适」的讨论。结论是现状的「一半硬编码、一半文件化」并存状态应当收敛，但**不能一刀切全搬**——`cadt-ui` 等少数技能被测试当作源码真源静态解析，必须留在源码。
>
> **2026-11-27 依据代码现状复核并修订**（原评估日 2026-11-24）。本文所有行号为 **2026-11-27 快照**，实施时以代码现状为准。

---

## 0. 修订记录（2026-11-27 核对结论）

| 原方案 | 现状 | 本次修订 |
| --- | --- | --- |
| `AI_BUILTIN_SKILLS` 162-716 行、约 555 行、16 个技能 | `ai-constants.js:182-791`、**610 行、17 个技能**（新增 `orchestrate`） | 清单与统计全部更新；**`orchestrate` 列为留源码**（见 §2.3） |
| `cadt-datalens` 迁到 `docs/skills/` | **该目录早已存在**（72 行 + `reference/cli.md`），硬编码那份是 5 行精简版 | 改为「**删除硬编码重复项**」，并明确这是**正文/描述变更**（见 §2.4） |
| 未提及文件化正文的 frontmatter | `parseSkillText` 返回 `content: text`（**含 YAML 头**），`body` 只用于推导 description | 新增 §1.4，把「正文多 4-6 行 frontmatter」列为已知差异 |
| 两处前端守卫「无需改动」 | `ai-app-actions.test.mjs:29` 的区间右界锚在 `cadt-gen-models` 上，该技能搬走后锚点失效 | 改为**必须同步改锚点**（见 §4 阶段 3） |
| 释放时传 exe | stamp 只含版本 + 清单，程序移动后路径不刷新 | stamp 追加 exe 路径（见 §4 阶段 2） |
| `writeSkillDirAt` 无条件替换 | 对任何含 `{{EXE_PATH}}` 的 SKILL.md 都改写 | 替换收窄为只对 `cadt-datalens`（见 §4 阶段 2） |
| 收益之一隐含「体积」 | 文案只是从前端 bundle 挪到 Go embed，exe 净变化≈0 | 删掉体积暗示，只留职责 / 可编辑性 / 可覆盖 |

---

## 1. 现状：两套内置技能机制并存

### 1.1 机制 A：硬编码 `AI_BUILTIN_SKILLS`

- 定义：`frontend/src/ai/core/ai-constants.js:182-791`，**610 行**，占该文件（1249 行）近一半。
- 共 17 个技能：`code-review`、`json-toolkit`、`release-notes`、`patch-workflow`、`cadt-datalens`、`cadt-ui`、`cadt-gen-models`、`cadt-mcp-samples`、`cadt-mcp-config`、`web-research`、`docx`、`pdf`、`skill-creator`、`plugin-creator`、`inline-visual`、`answer-me-with-html`、`orchestrate`。
- 消费：`ai-panel.js:7831-7919` 的 `listSkillsRaw()` 遍历数组，`content` 经 `builtinSkillText()`（`:7815`）做 `{{EXE_PATH}}` 运行时替换（`getAIExePath()` 在 `:7808`）。

### 1.2 机制 B：文件化 `docs/skills/` + `go:embed`

- 编译期：`embed_assets.go:20` 的 `//go:embed all:docs/skills` 把整棵树编进 exe。
- 清单：`internal/skills/skills.go:52` 的 `appBuiltinSkillDirs`，当前 4 个：`cadt-file-layout`、`reverse-engineer-anything`、`chinese-formal-document-format`、`landing-page-design`。
- 运行期：`materializeBuiltinSkills()`（`skills.go:157`）按应用版本释放到 `%APPDATA%\CandySweet\CaDt-DataLens\builtin-skills\`；前端 `resolveSkillDirs()`（`ai-panel.js:7701-7715`）把它当普通技能根扫描。

`docs/skills/` 下另有 `cadt-datalens/`，但它当前**不在** `appBuiltinSkillDirs` 里——只被 `RegisterAgentSkill()` 用于写入 `~/.agents/skills` 与 `~/.claude/skills`。

### 1.3 两套机制的优先级关系

排序 `ai-panel.js:7903-7908`：rank 小者优先；同 rank 按 `rootOrder`，再按 `localOrder`，先到先得。

- 硬编码项 `rank: AI_SKILL_RANKS.builtin (600)`、`rootOrder: 0`（`:7853-7854`）；
- 文件化内置根 `rank: 600`，`rootOrder` 从 1 开始（`:7858-7860`）；
- 用户目录 `~/.agents/skills` 为 `rank: 500`（`:7677`）。

**同 rank 时硬编码恒优先于文件化。** 当前 `cadt-datalens` 就是这个状态的实例：硬编码精简版压过 `docs/skills/cadt-datalens` 详细版；若用户注册过全局 Agent Skill（rank 500），则用户版再压过两者。

### 1.4 `parseSkillText` 的 content 语义（新增）

`ai-panel.js:7753-7779`：`body` 变量只用于在缺少 `description` 时推导首行摘要，**返回的 `content` 是原始 `text`（含 `---` YAML 头）**。

后果：技能搬进文件后，模型看到的正文会比硬编码版多出 4-6 行 frontmatter。本方案**接受**该差异（模型能理解 frontmatter，且这是所有现有文件化技能的既有行为）；若将来要剥掉，应改 `parseSkillText` 返回 `body`，那会同时影响现有 4 个内置技能与全部用户自定义技能，属独立变更，不在本次范围。

### 1.5 为什么要收敛

1. **职责污染**：常量文件被 610 行 Markdown 文案撑满，违反 AGENTS.md「出现第二个互不相关域就必须拆」。
2. **编辑体验差**：JS 里写 Markdown 要处理引号/反引号/换行，用 `.join('\n')` 或模板字符串，满屏转义（`ai-constants.js:736` 等），一个引号写错就编译失败。
3. **用户不可定制**：硬编码 content 不经文件系统，改措辞只能改源码重建；文件化那套天然支持同名覆盖（rank 100/200/400/500 均可盖过 600）。
4. **双份静默冲突**：`cadt-datalens` 已证明「同 rank 双份、硬编码胜出」会让人误以为改 md 生效。

---

## 2. 为什么不能一刀切

### 2.1 `cadt-ui`：动作表是被静态解析的代码真源

三处硬依赖：

1. **三方对账守卫** `frontend/test/ai/ai-app-actions.test.mjs:27-31` 直接读 `ai-constants.js` 源码：
   ```js
   const start = text.indexOf("name: 'cadt-ui'");
   const nextSkill = text.indexOf("name: 'cadt-gen-models'", start);
   const segment = text.slice(start, nextSkill > 0 ? nextSkill : text.length);
   return [...segment.matchAll(/^\s*'- ([a-z][a-z0-9_]+)(?=[ {：])/gm)].map((m) => m[1]);
   ```
   抓出的动作表与 `main.js` 的 `APP_ACTIONS`、`runAppAction` 的 switch、`ai-panel.js` 的 `MCP_CONFIG_ACTIONS` 做四方对账。这是**「模型唯一能看到的动作清单」**。
2. **书签守卫** `frontend/test/editor/bookmark-list.test.mjs:64`：`assert.ok(constants.includes(`'- ${action}`))`。
3. **动态开关** `ai-panel.js:7845`：`appControlOn()` 关闭时按 `builtin.name === 'cadt-ui'` 隐藏技能。

把动作表搬进 md 会让前两处守卫失效，牵一发动全身。**收益（省 113 行）远小于风险。**

### 2.2 `inline-visual`：content 来自单一来源 `visual-spec.js`

`ai-constants.js:600` 的 content 是 `VISUAL_RULES.inlineVisual`，由 `frontend/src/core/visual-spec.js` 拼装，同时被 `core/widget.js`（限额）与图表引擎（主题色）消费。固化成静态 md 会形成两份事实，违反单一来源原则。**保留引用。**

### 2.3 `orchestrate`：被单元测试按名字硬依赖（新增）

`frontend/test/ai/core/ai-constants.test.mjs:279-297`：

```js
const names = AI_BUILTIN_SKILLS.map((s) => s.name);
const skill = AI_BUILTIN_SKILLS.find((s) => s.name === 'orchestrate');
assert.ok(skill, '缺内置编排技能 orchestrate');
// 正文必须含 orchestration_plan / orchestration_status / orchestration_control
// 与 owns / dependsOn / verify / spec，且讲清审查门与返工
```

它是 2026-11-24 之后新增的技能（原方案快照里没有）。搬走后 `find` 返回 `undefined`，测试直接红。

两条路，**本期选 A**：

- **A（推荐）**：列为留源码第三项，与 `cadt-ui` 同级；
- B：搬文件 + 把该测试改成读 `docs/skills/orchestrate/SKILL.md`——需要为新路径写文件读取与 frontmatter 解析，收益不足以支撑本期一并做。

### 2.4 `cadt-datalens`：不是搬家，是删重复 + 换正文（新增）

事实对照：

| | 硬编码版（`ai-constants.js:282-296`） | 文件化版（`docs/skills/cadt-datalens/SKILL.md`） |
| --- | --- | --- |
| 规模 | 5 行正文 | 72 行正文 + `reference/cli.md` |
| description | 「用 CaDt-DataLens 图形界面为用户打开/预览工作区文件……」 | 「用 CaDt-DataLens 在 Windows 上为用户打开和查看本地数据文件（……）」 |
| 生效条件 | rank 600 / rootOrder 0 | rank 600 / rootOrder 1（**被压制**） |

所以这次动作的实质是「**让详细版对 AI 面板生效**」，而不是把内容原样挪个位置。方案 §7 原写的「不改 description / 正文语义」对它不成立。

**决策：接受切到详细版**（信息更全，且用户目录 rank 500 已长期覆盖它的机器上行为不变）。需要在提交信息与 CHANGELOG 里写明这一条，避免被当成纯重构。

### 2.5 结论：混合形态

最终 `AI_BUILTIN_SKILLS` 只留 **3 项**（`cadt-ui` / `inline-visual` / `orchestrate`，约 170 行），其余 **14 项**走文件化（13 个新建目录 + `cadt-datalens` 启用已有目录）。划分理由写进数组上方注释，比现状的「无理由混搭」清晰。

---

## 3. 分类决策

| 类别 | 技能 | 处理 | 理由 |
| --- | --- | --- | --- |
| **留源码** | `cadt-ui` | 保留在 `AI_BUILTIN_SKILLS` | 动作表是四方对账真源；动态开关按 name 判断 |
| **留源码** | `inline-visual` | 保留，content 仍引用 `VISUAL_RULES.inlineVisual` | 单一来源在 `visual-spec.js` |
| **留源码** | `orchestrate` | 保留 | `ai-constants.test.mjs` 按名字 `find` 并断言正文 |
| **删硬编码** | `cadt-datalens` | 删掉硬编码项，把目录名加进 `appBuiltinSkillDirs` | 文件化版已存在且更详细；硬编码版是压制的重复项 |
| **搬文件** | `code-review`、`json-toolkit`、`release-notes`、`patch-workflow`、`cadt-gen-models`、`cadt-mcp-samples`、`cadt-mcp-config`、`web-research`、`docx`、`pdf`、`skill-creator`、`plugin-creator`、`answer-me-with-html` | 迁到 `docs/skills/<name>/SKILL.md` | 纯文案，无静态依赖 |

搬走 13 个 + 删 1 个重复，`AI_BUILTIN_SKILLS` 从 610 行缩到约 170 行。

---

## 4. 实施步骤

### 阶段 0：备份（必做）

```bash
cp frontend/src/ai/core/ai-constants.js .cadt/tmp/ai-constants.js.bak
```

删 610 行后靠「反向编辑」回滚不现实；本仓库禁止 `git checkout` / `git restore`（AGENTS.md 硬规则），备份是唯一低成本后路。

### 阶段 1：准备 13 个 SKILL.md

1. 在 `docs/skills/` 下为阶段 3 表中的 13 个技能各建目录，写 `SKILL.md`：
   - frontmatter 的 `name` **必须等于目录名**（`TestBuiltinSkillAssetsPresent` 逐字校验 `strings.Contains(data, "name: "+dir)`）。
   - `description` **逐字照搬**硬编码值（模型判断何时加载的唯一依据，不要改写）。
   - 正文把 `.join('\n')` 数组还原成正常 Markdown，去掉 JS 转义（如 `\`` → `` ` ``）。
   - `answer-me-with-html` 是模板字符串（`ai-constants.js:602-737`），`\`` 转义要还原；已确认全文无 `${` 插值，可安全转成普通 md。
   - `orchestrate` 不搬（§2.3）。
2. `cadt-datalens/SKILL.md` 不动（已存在，含 `{{EXE_PATH}}` 占位符）。
3. 单文件体积：前端扫描上限是 `readTextFile(path, 64 << 10)`（**6.5 万字符**，不是字节）。现有最大 `reverse-engineer-anything/SKILL.md` 为 44192 字符，搬入的 13 个均远小于此，无需拆分。

### 阶段 2：Go 侧清单与释放

`internal/skills/skills.go`：

1. `appBuiltinSkillDirs`（`:52`）追加 14 个目录名：13 个新技能 + `cadt-datalens`（追加在末尾，保持 `[0]` 仍是 `cadt-file-layout`，`TestMaterializeBuiltinSkills` 的 probe 依赖它）。
2. `materializeBuiltinSkills()`（`:157`）：
   - 开头取 `exe, err := os.Executable()`；失败记 warn 并置空串（不中断物化）。
   - **stamp 追加 exe**：`want := Version + "|" + strings.Join(appBuiltinSkillDirs, ",") + "|" + exe`，解决程序移动后技能里的旧路径不刷新（原方案遗漏）。
   - `writeSkillDirAt(target, "docs/skills/"+dir, dir, exe)`（`:173`）。
3. `writeSkillDirAt`（`:110`）的替换条件（`:124`）**收窄**为只对 `cadt-datalens`：
   ```go
   if exe != "" && strings.EqualFold(rel, "SKILL.md") && dirName == skillDirName {
   ```
   否则将来任何提到 `{{EXE_PATH}}` 的文档（如 `cadt-file-layout` 讲占位符机制）都会被静默改写。
4. 版本标记格式变化会自动触发一次全量重新释放，无需手工清理。

### 阶段 3：前端收敛

1. `frontend/src/ai/core/ai-constants.js`：
   - `AI_BUILTIN_SKILLS`（`:182-791`）只保留 `cadt-ui`（`:298-410`）、`inline-visual`（`:598-600`）、`orchestrate`（`:738-790`）。
   - 删除 `cadt-datalens` 硬编码项（`:281-296`）。
   - `import {VISUAL_RULES}` **保留**（`inline-visual` 仍引用）。
   - 数组上方补一句注释，说明三项留源码的理由（指向本方案 §2）。
2. `frontend/src/ai/ai-panel.js`：
   - `appControlOn()` 隐藏 cadt-ui 的判断（`:7845`）保留（cadt-ui 仍在数组里）。
   - `builtinSkillText()`（`:7815`）、`getAIExePath()`（`:7808`）与 `exePathPromise`（`:7807`）：剩余三项都不含 `{{EXE_PATH}}`（已确认 `visual-spec.js` 无该 token），可删。**删除前再全局搜一遍** `builtinSkillText` / `getAIExePath`。
   - Go 侧 `AIExePath` 绑定（`internal/aichat/chat.go:250`）与 `mock-backend.js` 的同名 mock **保留**——删绑定要连带改 `testdata/app_bindings_baseline.txt` 与 `scripts/gen-backend-types.mjs` 产物，属无关变更。
3. `frontend/test/ai/ai-app-actions.test.mjs`（**原方案漏了这一步**）：
   - `:29` 的右界锚点 `"name: 'cadt-gen-models'"` 指向的技能即将搬走，`indexOf` 会返回 -1 并把区间退化成「cadt-ui 到文件末尾」。虽然当前碰巧不误报（剩余技能的数组行以中文/反引号开头，不匹配 `'- [a-z]`），但守卫实质上已失效。
   - 改为通用锚点，例如：
     ```js
     const rest = text.slice(start + 10);
     const next = rest.search(/\n\s{4}\{\n\s+name: '/);
     assert.ok(next > 0, 'cadt-ui 之后找不到下一个技能条目');
     const segment = rest.slice(0, next);
     ```
     这样以后无论谁被搬走、顺序怎么变都不依赖具体技能名。

### 阶段 4：测试护栏调整

1. `internal/skills/skills_test.go` 的 `TestBuiltinSkillAssetsPresent`（`:82`）：
   - 现在 `len(paths) < 2` 即失败（`:89`）。新搬的技能多为纯 `SKILL.md`。
   - **放宽为「至少 1 个文件」**（`len(paths) < 1`）——`SKILL.md` 存在 + frontmatter name 匹配已足够抓住「误把非技能目录加进清单」。
   - 备选（不推荐）：给每个新技能配附属文件凑数。
2. `TestMaterializeBuiltinSkills`（`:102`）补两条断言：
   - 释放后的 `cadt-datalens/SKILL.md` 不含 `{{EXE_PATH}}` 字面量；
   - 释放后的 `cadt-datalens/SKILL.md` 含 `os.Executable()` 返回值（测试里是 go test 二进制路径）。
3. **新增「双份」护栏**（放 `frontend/test/ai/core/ai-constants.test.mjs` 或独立小测试）：
   - 断言 `AI_BUILTIN_SKILLS` 的 name 集合与内置文件化清单（可读 `internal/skills/skills.go` 的 `appBuiltinSkillDirs` 字面量，或直接枚举 `docs/skills/*`）**无交集**。
   - 理由：`cadt-datalens` 已证明「同 rank 双份、硬编码静默胜出」是真实陷阱，且没有任何现有测试能发现它。
4. 前端守卫 `frontend/test/editor/bookmark-list.test.mjs:64` **无需改动**——它是全文件 `includes`，cadt-ui 留在原位即可。

### 阶段 5：文档

`docs/skills/README.md`：

- 「随 exe 分发」表格补 14 行（13 个新技能 + `cadt-datalens` 同时是「注册全局 Agent Skill」与「应用内置技能」）。
- 「内置技能：随应用分发」小节的目录树示例更新（现在会列 18 个目录）。
- **末段两处字数要求必须同步改**：`docs/skills/README.md` 的「至少含 `SKILL.md` 与一个附属文件」与「目录内至少两个文件」，与放宽后的测试保持一致。
- 「上游与许可」表：新增项多为本项目自研（随 Apache-2.0）；`answer-me-with-html` 照抄正文末尾已有的 qingyuna MIT 声明，不要丢。若确有上游，补进 `THIRD_PARTY_LICENSES.md`。

---

## 5. 已知行为差异（实施后必须核对）

| 差异 | 说明 | 处置 |
| --- | --- | --- |
| 正文多 frontmatter | 文件化 `content` 含 YAML 头（§1.4） | 接受，写入 CHANGELOG |
| `cadt-datalens` 换正文与描述 | 精简版 → 详细版（§2.4） | 接受，提交信息写明 |
| 技能内容来自磁盘 | 用户手改 `builtin-skills/` 在版本不变时不被覆盖（既有行为） | 不变 |
| 列表顺序 | 最终按 name 排序（`ai-panel.js:7915`），与来源无关 | 不变 |
| 启停 / 隐藏状态 | 按 name 记录，搬走不改变 name | 不变，用户设置继续有效 |

---

## 6. 验证方式

按项目规范，测试/构建命令**不接 grep/tail 等管道**，看退出码本身；Go 测试一律后台执行并显式带 `-timeout`。

| 项 | 命令 / 动作 | 期望 |
| --- | --- | --- |
| Go 单测 | `go test -timeout 300s ./internal/skills/ ./...`（后台） | 全绿，含 `TestBuiltinSkillAssetsPresent`、`TestMaterializeBuiltinSkills` |
| 前端测试门 | `cd frontend && npm test` | 全绿，尤其 `ai-app-actions.test.mjs`、`bookmark-list.test.mjs`、`ai-constants.test.mjs` |
| 类型检查 | `cd frontend && npm run typecheck`（`npm test` 前置门） | 零错误 |
| 绑定面 | `go test -run TestAppBindingBaseline .` | 基线 420 条不变（本次不增删绑定） |
| 交叉编译 | `tools\check-crossbuild.cmd` | linux/darwin 三目标可编译（`os.Executable` 为平台无关 API） |
| 重建 exe | `powershell -ExecutionPolicy Bypass -File tools/rebuild-exe.ps1` | 先关运行中的实例；测试门通过后才构建 |
| 体积 | 对比重建前后 exe 大小 | 应在 ±200 KB 内（文案只是换了存放位置） |
| 手动验收 | 启动应用 → 设置 → AI 助手 → 技能 | ① 17 个技能全部在列、来源标记「内置」；② 关掉「AI 工具权限 → 应用操作」后 cadt-ui 消失；③ `skill_use` 加载 `cadt-datalens` 得到**详细版**正文，且 exe 路径是真实路径而非 `{{EXE_PATH}}`；④ 用户目录同名技能仍覆盖内置版；⑤ 移动 exe 后重启，`cadt-datalens` 里的路径已刷新 |

---

## 7. 风险与回滚

- **风险 1：description 措辞丢失**。搬文件时若改写 description，会改变模型的加载判断。缓解：逐字复制；验收时抽查。
- **风险 2：`answer-me-with-html` 的转义还原出错**。正文含大量 `\`` 转义。缓解：搬完用 `read_file` 对照原数组逐节核；前端测试门只能抓编译错误，抓不到文案走样。
- **风险 3：`cadt-datalens` 换版引起模型行为变化**。详细版正文更长、描述更宽泛，可能让模型更积极地推荐打开文件。缓解：验收时实际跑一次「看第 42 行」类请求；必要时把详细版 `description` 收敛到与硬编码版同粒度。
- **风险 4：exe 路径替换失败**。`os.Executable()` 失败时占位符残留，模型拿到的启动命令含字面量。缓解：记 warn 日志；正常环境不会失败。
- **风险 5：stamp 加 exe 后额外全量重写**。程序换路径会触发一次技能目录重写（几十 KB），可忽略；用户手改过的内置技能会被覆盖一次（既有设计已如此）。
- **回滚**：改动集中在新目录（`docs/skills/`）、`ai-constants.js`（删）、`skills.go`（清单 / 参数 / stamp）、两个 Go 测试、一个前端测试。回滚用 `.cadt/tmp/ai-constants.js.bak` 恢复 + 逐文件反向编辑；**不要用 `git checkout` / `git restore`**（AGENTS.md 硬规则）。

---

## 8. 不在本次范围

- 不新增或删减技能条目，只改变存放形态（`cadt-datalens` 换版除外，见 §2.4）。
- 不改 `orchestrate` / `cadt-ui` / `inline-visual` 的正文与描述。
- 不改 rank 体系与去重逻辑。
- 不改 `parseSkillText` 的 frontmatter 剥离语义（§1.4）。
- 不删 Go 侧 `AIExePath` 绑定。
- `cadt-ui` 动作表真源迁移到 md 的改造——需同步改四方守卫，收益不足以支撑本次一并做。
