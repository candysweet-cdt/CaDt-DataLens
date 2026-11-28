---
name: answer-me-with-html
description: 把复杂回答做成一页多面板图文 HTML（结构 / 流程 / 对比 / 排查 / 方案），写入工作区并在内嵌浏览器打开；需要留存、分享、打印或一屏放不下时使用（对话内单张图请用 inline-visual）
---

# Answer me with HTML：用一张网页回答复杂问题

你负责写一页**自包含 HTML**（内容 + 内联样式），写进工作区，再用应用的内嵌浏览器打开。不要交一段只能读的文字。

## 0. 先选形态

- **一张图 / 一块对比、看完就过去** → 不要写文件：用 inline-visual 技能的围栏卡片（```svg / ```html / ```mermaid / ```echarts），直接在对话里渲染，零权限、零等待、离线也还在；形态决策表以 inline-visual 为单一来源。
- 只有满足任一条件才做页面：≥4 个面板；需要留存 / 分享 / 打印；内容一屏放不下；用户明确说「给我一页网页 / 存成文件」。
- 判断不清时先给卡片；用户说「还不够 / 想留一份」再升级成页面。

## 1. 什么时候做页面

满足任一条件就做：
- 有 ≥3 个相互关联的概念 / 模块，读者需要看清关系。
- 有流程、协议、调用链、状态机（尤其带分支或几个角色）。
- 有 ≥3 个维度的对比、取舍、能做 / 不能做清单。
- 有层级、目录结构或时间演进。
- 用户说「没看懂 / 画个图 / 讲讲原理 / 解释一下 / 出个图」。
- 不确定时：越需要图才能讲清，越该做页面。

不要做：闲聊、一句话能答完的问题、用户明确要纯文本、纯命令输出。

## 2. 工作流

1. 先在脑子里列 3–8 个面板，一个面板只回答一个子问题；第一屏先给结论。
2. 用 write_file 写单文件 HTML 到 `.cadt/answers/<主题-slug>.html`（相对范围根，父目录会自动创建）。语言跟随用户。
3. 用 app_control 在内嵌浏览器打开（地址 = `file:///` + 范围根 + `/.cadt/answers/<slug>.html`；
   范围根取自系统上下文里的「范围根」，反斜杠换成正斜杠、空格换成 %20）：
   `{"action":"open_browser_tab","params":{"url":"file:///<范围根>/.cadt/answers/<slug>.html"}}`
   - 系统上下文里没有范围根（未打开工作区）：先让用户打开一个文件夹再继续。
   - 打开失败就用 run_command 退回系统浏览器：`cmd /c start "" "<HTML 绝对路径>"`。
4. 回复只写 2–4 行：一句核心结论 + 页面路径。不要把 HTML 或草稿再贴回聊天。

## 3. 硬性要求

- 该技能需要写权限（write_file）与 app_control；只读档时不要硬做，直接用 Markdown 回答并说明一句。
- 单文件、离线可看：样式写在 `<style>` 里；不引 CDN、外链字体、远程图片；不要 `<script>`。
- `<html lang="zh-CN">`；`<meta name="color-scheme" content="light dark">`；用 `prefers-color-scheme` 适配深色。
- 页面 `max-width:1100px`；面板用 grid，窄屏变单列；不要让表格或长代码撑破布局。
- 不编造数据；示意数据标明「示意」；结论给证据（`path:line`、数字、命令）。
- 不做动画、不自动播放、不弹窗、不要表单。

## 4. 页面骨架（照抄结构，只替换标题与面板内容）

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>页面标题</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--text:#1f2328;--muted:#5b636e;--border:#e3e6ea;--accent:#2563eb;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--code:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--text:#e6e9ee;--muted:#9aa4b2;--border:#2a313a;--accent:#6ea8fe;--ok:#4ade80;--warn:#fbbf24;--err:#f87171;--code:#11151a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 "Segoe UI","Microsoft YaHei UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:40px 24px 64px}
header h1{margin:0 0 6px;font-size:30px;line-height:1.25}
header .sub{color:var(--muted)}
.lead{margin:18px 0 26px;padding:14px 18px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;background:var(--panel)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 18px;min-width:0}
.panel h2{margin:0 0 10px;font-size:17px}
.panel h2 .id{color:var(--accent);margin-right:6px}
.panel p{margin:8px 0}.panel ul,.panel ol{margin:8px 0;padding-left:22px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{padding:7px 9px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600}
.badge{display:inline-block;padding:0 6px;border-radius:5px;font-size:12px;line-height:18px;white-space:nowrap}
.badge.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.badge.no{background:color-mix(in srgb,var(--err) 16%,transparent);color:var(--err)}
.badge.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.callout{margin:10px 0;padding:10px 12px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--code)}
.callout.ok{border-left-color:var(--ok)}.callout.warn{border-left-color:var(--warn)}.callout.err{border-left-color:var(--err)}
.flow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}
.node{padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--code);font-size:13px}
.arrow{color:var(--muted)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13.5px;margin:8px 0}
.kv dt{color:var(--muted)}.kv dd{margin:0}
.steps{counter-reset:s;margin:8px 0;padding:0;list-style:none}
.steps li{counter-increment:s;position:relative;padding-left:28px;margin:8px 0}
.steps li::before{content:counter(s);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;line-height:20px;text-align:center}
.timeline{border-left:2px solid var(--border);margin:8px 0 8px 6px;padding-left:14px}
.timeline .item{margin:10px 0}
.timeline .t{color:var(--muted);font-size:12.5px}
pre{margin:10px 0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--code);overflow:auto;font-size:12.5px}
code{font-family:"JetBrains Mono",Consolas,monospace}
footer{margin-top:28px;color:var(--muted);font-size:12px}
@media (max-width:640px){.wrap{padding:24px 14px}}
</style>
</head>
<body>
<div class="wrap">
  <header><h1>标题</h1><div class="sub">一句话副标题（可选）</div></header>
  <div class="lead">核心结论先写在这里：一句话 + 一个关键证据。</div>
  <main class="grid">
    <section class="panel">
      <h2><span class="id">A</span>面板标题</h2>
      <p>正文。</p>
    </section>
    <section class="panel">
      <h2><span class="id">B</span>面板标题</h2>
      <table><thead><tr><th>项</th><th>说明</th><th>状态</th></tr></thead>
      <tbody><tr><td>示例</td><td>说明</td><td><span class="badge ok">可行</span></td></tr></tbody></table>
    </section>
  </main>
  <footer>由 CaDt-DataLens AI 生成 · 离线单文件</footer>
</div>
</body>
</html>
```

## 5. 组件速查

- 结论 / 警示：`<div class="callout ok|warn|err">`。
- 对比、能做 / 不能做：表格 + `<span class="badge ok|no|warn">`。
- 流程 / 架构：`.flow` 里放 `.node`，中间用 `<span class="arrow">→</span>`；分支多时拆成几个 flow。
- 步骤：`<ol class="steps"><li>…</li></ol>`。
- 参数 / 上限：`.kv`（dt + dd）。
- 时间线：`.timeline` + `.item` + `.t`。
- 代码 / 命令：`<pre><code>`。
- 一屏先给结论：lead + 第一个面板，不要先铺背景。

## 6. 写作规则

- 先给答案，不写「下面我来介绍」；结尾不写总结或客套。
- 一句一个事实；同一个概念始终用同一个名字。
- 表格或图已经表达的，不再用文字重复。
- 步骤写成命令，条件在前；没验证的事实要说明，并给出验证方式。
- 页面是给人看的：保留关键数字、路径和结论，删掉过程性闲聊。

> 规则参考 MIT 许可的 answer-me-with-html（qingyuna）；本内置版已适配 CaDt-DataLens：不需要 Node，也不依赖外置 CLI。
