// ai-tool-cards 纯函数测试：流式工具卡的增量摘要（liveToolSummary）、占位行顺序对齐、spinner CSS 接线、
// 「已停止但还在转」的运行态口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {liveToolSummary, liveToolParts, liveToolStateText, planLiveRowOrder, toolIsLive, toolShowsFileLink, toolFileOpenTarget} from '../../../src/ai/tools/ai-tool-cards.js';

test('liveToolSummary：能从未闭合的参数 JSON 里捞出 path 与已接收体积', () => {
    // write_file 流式中途：content 字符串尚未闭合，path 已完整
    const partial = '{"path":"docs/笔记.md","content":"# 标题\\n正文第一段';
    const text = liveToolSummary(partial);
    assert.match(text, /^docs\/笔记\.md · 参数接收中 \d+(\.\d+)? (B|KB)$/);
    // 完整 JSON 也能取 path
    assert.match(liveToolSummary('{"path":"a/b.json","content":"{}"}'), /^a\/b\.json · /);
});

test('liveToolSummary：无 path 时只报体积；空参数报 0 B', () => {
    assert.equal(liveToolSummary('{"command":"git status"}'), '参数接收中 24 B');
    assert.equal(liveToolSummary(''), '参数接收中 0 B');
    assert.equal(liveToolSummary(null), '参数接收中 0 B');
    // 超过 1 KB 换算成 KB 显示
    const big = 'x'.repeat(2048);
    assert.match(liveToolSummary(big), /参数接收中 2\.0 KB$/);
});

test('liveToolSummary：path 含转义字符且未闭合时退回原文显示', () => {
    // \" 被截断在反斜杠处：JSON.parse 会失败，退回原文（不抛异常）
    const tricky = '{"path":"a\\\\b\\';
    const text = liveToolSummary(tricky);
    assert.match(text, /参数接收中 \d+ B$/);
});

test('liveToolParts：拆出文件名 / 目录 / 已接收体积与 content-so-far', () => {
    const partial = '{"path":"frontend/src/ai/ai-classifier-verdict.js","content":"// 注释\nexport function foo() {\n  return 1;';
    const parts = liveToolParts(partial);
    assert.equal(parts.name, 'ai-classifier-verdict.js');
    assert.equal(parts.dir, 'frontend/src/ai');
    assert.equal(parts.path, 'frontend/src/ai/ai-classifier-verdict.js');
    assert.match(parts.size, /^(\d+(\.\d+)? (B|KB))$/);
    // 未闭合的 content 字面量解码：\n 换行可用，截断处原文保留
    assert.equal(parts.content, '// 注释\nexport function foo() {\n  return 1;');
});

test('liveToolParts：Windows 反斜杠路径与无 path 场景', () => {
    const win = liveToolParts('{"path":"D:\\data\\样本.json","content":"{}"}');
    assert.equal(win.name, '样本.json');
    assert.equal(win.dir, 'D:\\data');
    const none = liveToolParts('{"command":"git status"}');
    assert.equal(none.path, '');
    assert.equal(none.name, '');
    assert.equal(none.content, null);
    assert.match(none.size, /^\d+ B$/);
});

test('liveToolParts：content 中途截断在转义序列上不抛异常', () => {
    // content 值以 \u 截断：decode 截掉悬空反斜杠后仍可能 parse 失败 → 退回手写替换
    const tricky = liveToolParts('{"path":"a.md","content":"x\\u00e9\\u0');
    assert.ok(typeof tricky.content === 'string');
});

test('liveToolStateText：零字节显示「等待参数…」，收到首块才报体积', () => {
    // 工具调用头（name）先到、参数还在路上：显示「接收中 0 B」像计数器坏了
    assert.equal(liveToolStateText(liveToolParts('')), '等待参数…');
    assert.equal(liveToolStateText(liveToolParts(null)), '等待参数…');
    // 有字节后按已接收体积上报（1 字节也要报，不能因为没 path 就退回等待态）
    assert.equal(liveToolStateText(liveToolParts('{"path"')), '接收中 7 B');
    assert.equal(liveToolStateText(liveToolParts('{"command":"git status"}')), '接收中 24 B');
    assert.equal(liveToolStateText(liveToolParts('x'.repeat(2048))), '接收中 2.0 KB');
    // chars 是原始长度：格式化后仍要能判定「是不是一字未到」
    assert.equal(liveToolParts('').chars, 0);
    assert.equal(liveToolParts('{"path":"a.md"}').chars, '{"path":"a.md"}'.length);
});

test('planLiveRowOrder：顺序不变时零 DOM 操作（spinner 不会每帧回弹）', () => {
    const a = {id: 'a'}, b = {id: 'b'}, c = {id: 'c'};
    const same = planLiveRowOrder([a, b], [a, b]);
    assert.deepEqual(same.moves, [], '顺序没变却要移动节点 → 会重启 ::before 动画');
    assert.equal(same.trim, 0);
    assert.deepEqual(same.final, [a, b]);
    // 追加新行：只动新位置，已有行保持原位
    const add = planLiveRowOrder([a], [a, b]);
    assert.deepEqual(add.moves, [1]);
    assert.equal(add.trim, 0);
    assert.deepEqual(add.final, [a, b]);
    // 删除行：只裁尾部，不移动保留下来的行
    const del = planLiveRowOrder([a, b], [b]);
    assert.deepEqual(del.final, [b]);
    assert.equal(del.trim, 1);
    // 换序 / 反序：最小移动且最终顺序正确
    const swap = planLiveRowOrder([a, b], [b, a]);
    assert.deepEqual(swap.final, [b, a]);
    assert.ok(swap.moves.length <= 1);
    const rev = planLiveRowOrder([a, b, c], [c, b, a]);
    assert.deepEqual(rev.final, [c, b, a]);
    assert.equal(rev.trim, 0);
});

test('spinner 相位接线：CSS 周期与 JS 常量一致，且接受 --ai-spin-phase', () => {
    const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.ai-tool-spinner::before\s*\{[^}]*\}/);
    assert.ok(rule, '找不到 .ai-tool-spinner::before 规则');
    assert.match(rule[0], /animation:\s*ai-todo-spin\s+0\.9s/, '周期须与 AI_SPIN_MS = 900 同步');
    assert.match(rule[0], /animation-delay:\s*var\(--ai-spin-phase/, '负 delay 变量不能丢，否则重建仍会回弹');
});

test('工具卡折叠动画：refreshToolWrap 在整卡重建时补收缩，且尊重减少动画', () => {
    // 工具卡 run_command / search_text 等 running 展开、done 折叠；状态更新走整卡重建
    // （wrap.innerHTML=''），新节点一出生就折叠，纯 CSS transition 不会触发。试点用 Web Animations
    // 从旧高度补一段收缩，避免跑完瞬间矮一截的闪。这里断言接线没被后续重构碰掉。
    const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    const fn = panel.slice(panel.indexOf('function refreshToolWrap'), panel.indexOf('function sendAppMessage'));
    assert.ok(fn.length > 100, 'refreshToolWrap 源码切片失效');
    // 只在「旧卡展开 → 新卡折叠」的状态翻转时触发（避免每次刷新都播）
    assert.match(fn, /oldCard\.classList\.contains\('collapsed'\)/, '必须读旧卡的折叠态');
    assert.match(fn, /newCard\.classList\.contains\('collapsed'\)/, '必须读新卡的折叠态');
    // 补动画用 Web Animations（height 只改视觉、不占布局，贴底一次到位）
    assert.match(fn, /newCard\.animate\(/, '折叠收缩须走 Web Animations');
    assert.match(fn, /prefers-reduced-motion: reduce/, '必须尊重系统减少动画');
});

test('审批正文：低优先级项被 flex 压缩时不能压成「一行都看不见」', () => {
    // .ai-tool-body.ai-tool-approval-body 是 max-height + overflow:hidden 的纵向 flex，
    // 命令块与结果输出是 flex: 0 1 auto（可缩）。不设 min-height 时，长 diff 会把它们
    // 压到几 px —— 表现为卡片底部「已应用更改…」只剩半行（2026-11-19 用户报告）。
    const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');
    for (const sel of ['.ai-tool-approval-body .ai-command-line', '.ai-tool-approval-body .ai-approval-output']) {
        const rule = css.match(new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{[^}]*\\}'));
        assert.ok(rule, '找不到规则 ' + sel);
        assert.match(rule[0], /min-height:\s*[\d.]+em/, sel + ' 必须留 min-height 保底一行');
    }
});

test('toolIsLive：interrupted 是终止态最高优先级（「已停止」的卡片不许再算运行中）', () => {
    // 用户停止时先落 interrupted，status 可能被迟到的审批/分类器回调改回 running：
    // 只看 status 会让 spinner 继续转、正文继续写「执行中…」，与头部「已停止」自相矛盾。
    assert.equal(toolIsLive({status: 'running', interrupted: true}), false);
    assert.equal(toolIsLive({status: 'running'}), true);
    assert.equal(toolIsLive({status: 'pending', interrupted: true}), false);
    assert.equal(toolIsLive({status: 'done'}), false);
    assert.equal(toolIsLive({status: 'error', interrupted: true}), false);
    assert.equal(toolIsLive(null), false);
});

test('工具卡渲染统一走 toolIsLive：不再用裸 status === \'running\' 判定运行态', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function createAIToolCards'));
    assert.ok(body.length > 1000, 'createAIToolCards 源码切片失效');
    assert.match(body, /const live = toolIsLive\(message\)/, 'renderToolMessage 必须先算一次 live');
    assert.equal(
        /message\.status\s*===\s*'running'/.test(body),
        false,
        'spinner / 「执行中…」/ 卡片状态色都要走 toolIsLive，否则停止后仍会转圈',
    );
});

test('停止闸门接线：审批 / 分类器回调不许把已停止的卡片点回 running', () => {
    const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.match(panel, /function toolHalted\(toolMessage\)/, '缺少 toolHalted 单一判定');
    // 自动放行、人工裁定、审批弹窗、run_command、background_command、写入、补丁：每处 await 之后都要查
    const guards = panel.match(/toolHalted\(/g) || [];
    assert.ok(guards.length >= 6, '停止闸门覆盖不足（只有 ' + guards.length + ' 处）');
    assert.match(panel, /if \(toolHalted\(ctx\.toolMessage\)\) return '用户已停止生成，命令未执行。'/, 'run_command 审批后必须停手');
    assert.match(panel, /function settleInterruptedTool\(/, '结束后仍停在 running 的卡片需要收口兜底');
});

test('liveToolParts：edit_file 的 old_string（闭合才算完整）与 new_string-so-far', () => {
    // old_string 已闭合、new_string 还在流式接收
    const streaming = liveToolParts('{"path":"a.js","old_string":"const a = 1;\nconst b = 2;","new_string":"const a = 1;\nconst b = 2;\nconst c = 3;');
    assert.equal(streaming.oldString, 'const a = 1;\nconst b = 2;');
    assert.equal(streaming.newString, 'const a = 1;\nconst b = 2;\nconst c = 3;');
    // 两个都闭合（new_string 未闭合正则照样能取完整值）
    const done = liveToolParts('{"path":"a.js","old_string":"x","new_string":"y"}');
    assert.equal(done.oldString, 'x');
    assert.equal(done.newString, 'y');
    // old_string 尚未闭合 → null（不产出 ± 统计的信号）
    const oldStreaming = liveToolParts('{"path":"a.js","old_string":"const a =');
    assert.equal(oldStreaming.oldString, null);
    assert.equal(oldStreaming.newString, null);
    // 无 edit 字段的工具不受影响
    assert.equal(liveToolParts('{"command":"git status"}').oldString, null);
});

test('审批正文：读类审批（无 added/removed）不渲染 ± 统计，避免出现 +undefined', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function renderApprovalBody'));
    assert.ok(body.length > 100, 'renderApprovalBody 源码切片失效');
    // ± 统计必须有 added/removed 门卫（与工具卡头部统计同一判定）：read 审批
    // （read_file / 列目录 / 搜索起点）没有 diff 数字，直接拼会出「+undefined −undefined」
    assert.match(
        body,
        /if \(approval\.added \|\| approval\.removed\) \{\s*const stat = document\.createElement/,
        '审批 meta 的 ± 统计缺少 added/removed 门卫',
    );
    // 读类审批收尾文案按读取措辞，不写「已应用更改」
    assert.match(body, /readKind \? '已授权读取'/, '读类审批收尾文案应按读取措辞');
});

test('生成卡正文渲染完整提示词：头部只有 60 字摘要，全文放展开正文并按命令卡模式折叠', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('} else if (message.gen) {'));
    assert.ok(body.length > 100, 'message.gen 源码切片失效');
    // 完整提示词必须渲染在展开正文里（generate_image / generate_video 共用 gen 分支）
    assert.match(body, /ai-gen-prompt/, '生成卡正文缺少完整提示词块');
    // 长提示词折叠：阈值与命令卡一致（>120 字符或含换行），按钮文案「展开/收起提示词」
    assert.match(body, /genPrompt\.length > 120/, '折叠阈值应与命令卡一致（120 字符）');
    assert.match(body, /展开提示词/, '长提示词要有展开/收起按钮');
    // 提示词块排在状态行之前（输入在上、进度在下，同命令卡「命令 → 输出」的次序）
    assert.ok(
        body.indexOf('ai-gen-prompt') < body.indexOf('ai-gen-status'),
        '提示词块应排在状态行之前',
    );
});

test('代码块工具条：思考链走 noBar 不建「语言 + 复制」栏，主回答区仍建', () => {

    const cards = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const fn = cards.slice(cards.indexOf('function enhanceAICodeBlocks'));
    // noBar 开关必须真的门住 bar 的创建，而不只是加个空类
    assert.match(fn, /const noBar = !!\(\opts && opts\.noBar\)/);
    const barBlock = fn.match(/if \(!noBar\) \{[\s\S]*?card\.appendChild\(bar\);\s*\}/);
    assert.ok(barBlock, 'bar 的创建必须被 if (!noBar) 门住');
    assert.match(barBlock[0], /ai-code-bar/, '门住的应是工具栏本体');
    assert.match(barBlock[0], /ai-code-copy/, '复制按钮也要在门内');
    // noBar 卡仍带代码区（高亮/边框/滚动照旧），只是没有条
    assert.match(fn, /card\.appendChild\(body\)/);
    // 正文增强链默认不传 noBar → 主回答区/子代理详情仍有工具条可复制
    const answer = cards.slice(cards.indexOf('function enhanceAnswerBody'), cards.indexOf('function codeBlockLanguage'));
    assert.match(answer, /enhanceAICodeBlocks\(root\)\s*;/, '正文增强链必须调用默认带条版本');

    const panel = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.match(panel, /enhanceAICodeBlocks\(body, \{noBar: true\}\)/,
        '思考链必须走 noBar——「js + 复制」栏在弱化的思考区里很突兀');
});

test('工具卡文件名超链接：read/write/edit/ocr/转写可点，非文件工具不挂链接', () => {
    assert.equal(toolShowsFileLink({name: 'read_file'}), true);
    assert.equal(toolShowsFileLink({name: 'read_image'}), true);
    assert.equal(toolShowsFileLink({name: 'write_file'}), true);
    assert.equal(toolShowsFileLink({name: 'edit_file'}), true);
    assert.equal(toolShowsFileLink({name: 'ocr'}), true);
    assert.equal(toolShowsFileLink({name: 'transcribe_audio'}), true);
    // list_dir 的 primary 是目录、generate_* 是提示词、watch/计划等都不是文件路径
    assert.equal(toolShowsFileLink({name: 'list_dir'}), false);
    assert.equal(toolShowsFileLink({name: 'search_text'}), false);
    assert.equal(toolShowsFileLink({name: 'generate_image'}), false);
    assert.equal(toolShowsFileLink({name: 'run_command'}), false);
    assert.equal(toolShowsFileLink(null), false);
});

test('toolFileOpenTarget：审批落盘绝对路径优先，历史卡用工作区根 + 相对路径兜底', () => {
    const info = {primary: 'graph.go', dir: 'internal/gitinfo'};
    // 写入/编辑卡：审批带落盘绝对路径（applyWorkspaceWrite 写入），直接用
    const withApproval = {name: 'write_file', approval: {path: 'D:/proj/internal/gitinfo/graph.go'},
        arguments: JSON.stringify({path: 'internal/gitinfo/graph.go'})};
    assert.equal(toolFileOpenTarget(withApproval, info, 'D:/proj'), 'D:/proj/internal/gitinfo/graph.go');
    // 历史卡：没有 approval.path，用工作区根 + 卡头相对路径
    const history = {name: 'write_file', arguments: JSON.stringify({path: 'internal/gitinfo/graph.go'})};
    assert.equal(toolFileOpenTarget(history, info, 'D:/proj/'), 'D:/proj/internal/gitinfo/graph.go');
    // 读取卡：执行时挂的 targetPath 优先（含窗口起始行由调用方另取）
    const read = {name: 'read_file', targetPath: 'D:/other/a.go', arguments: JSON.stringify({path: 'a.go'})};
    assert.equal(toolFileOpenTarget(read, info, 'D:/proj'), 'D:/other/a.go');
    // 参数里已是绝对路径（full 档）：不拼工作区根
    const absolute = {name: 'write_file', arguments: JSON.stringify({path: 'D:/abs/x.go'})};
    assert.equal(toolFileOpenTarget(absolute, {primary: 'x.go', dir: 'D:/abs'}, 'D:/proj'), 'D:/abs/x.go');
    // 网图 / 无文件名：不挂链接
    assert.equal(toolFileOpenTarget({name: 'read_image'}, {remote: true, primary: 'x', dir: ''}, 'D:/proj'), '');
    assert.equal(toolFileOpenTarget({name: 'write_file'}, {primary: '—', dir: ''}, 'D:/proj'), '');
});

test('文件名链接只加在 primary，卡头其余区域照旧展开/折叠（stopPropagation 兜底）', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function renderToolMessage'), src.indexOf('function enhanceAnswerBody'));
    assert.ok(fn.length > 100, 'renderToolMessage 源码切片失效');
    assert.match(fn, /if \(toolShowsFileLink\(message\) && !info\.remote && openTargets\)/,
        '文件链接判定必须统一走 toolShowsFileLink（含 write_file / edit_file）');
    assert.match(fn, /primary\.classList\.add\('ai-tool-link'\)/, '链接类必须加在文件名上');
    assert.match(fn, /e\.stopPropagation\(\); \/\/ 别冒泡到卡头的折叠 toggle/,
        '点文件名不能触发卡头折叠');
    // 卡头折叠 toggle 仍在（对其他区域生效）
    assert.match(fn, /head\.addEventListener\('click', \(\) => \{[\s\S]*card\.classList\.toggle\('collapsed'\)/,
        '卡头其余区域必须照旧展开/折叠');
    // CSS 的 hover 下划线不能丢
    const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.ai-tool-link:hover \{[^}]*text-decoration: underline/,
        '.ai-tool-link 必须有 hover 下划线');
});

// 没有可展开正文的卡（wait_agent 执行中只有一行「执行中…」）不该有折叠箭头：
// 箭头展开只有一行字，属于纯噪音（头部状态徽标已经说明结果）。
test('无正文的工具卡不摆折叠箭头与空 body', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function renderToolMessage'), src.indexOf('function enhanceAnswerBody'));
    assert.ok(fn.length > 100, 'renderToolMessage 源码切片失效');
    assert.match(fn, /statusOnlyBody = !inlineText\.trim\(\)/,
        '通用分支必须记下「正文只有状态占位」');
    assert.match(fn, /if \(\(isRead && !isReadLines\) \|\| isBuiltinSkill \|\| statusOnlyBody\) card\.appendChild\(head\);/,
        '无正文时不要 append body（否则展开只有「执行中…」）；按行读取卡有正文，字符模式读取卡与内置技能卡无正文');
    assert.match(fn, /if \(statusOnlyBody\) chev\.remove\(\)/, '无正文时不显示折叠箭头');
    assert.match(fn, /if \(statusOnlyBody\) return; \/\/ 无正文可展开/,
        '无正文时点卡头不做折叠 toggle');
});

// 按行读取（startLine/endLine）的读取卡支持展开折叠：正文显示带行号的内容片段，
// 卡头带行范围徽标。字符模式读取卡仍不做展开。
test('按行读取卡支持展开折叠，字符模式读取卡不展开', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function renderToolMessage'), src.indexOf('function enhanceAnswerBody'));
    assert.ok(fn.length > 100, 'renderToolMessage 源码切片失效');
    // 按行读取判定：解析 startLine
    assert.match(fn, /const isReadLines = !!readLineRange;/, '必须有按行读取判定 isReadLines');
    // 箭头：字符模式读取卡移除，按行读取卡保留
    assert.match(fn, /if \(\(isRead && !isReadLines\) \|\| isBuiltinSkill\) chev\.remove\(\)/,
        '字符模式读取卡不摆箭头，按行读取卡保留箭头');
    // 正文：按行读取卡渲染内容片段（去掉 head 元信息），走与 diff 同款背景框结构
    assert.match(fn, /if \(isReadLines\) \{[\s\S]*?renderReadLinesInto\(body, bodyText\);/,
        '按行读取卡必须把内容片段渲染进背景框');
    // 卡头行范围徽标
    assert.match(fn, /if \(info\.range\) \{[\s\S]*?range\.textContent = '行 ' \+ info\.range;/,
        '卡头必须显示行范围徽标');
});
// read_file 展开区与 edit_file diff 视觉语义统一：同款「背景框 + 行号列 + 代码列」结构，
// 行号独立成列（不是内嵌在文本里），四位数行号不折行。
test('读取展开区用 diff 同款背景框结构，行号独立成列', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function renderReadLinesInto'), src.indexOf('function renderToolMessage'));
    assert.ok(fn.length > 100, 'renderReadLinesInto 源码切片失效');
    assert.match(fn, /box\.className = 'ai-read-body'/, '外层必须是背景框 ai-read-body');
    assert.match(fn, /no\.className = 'ai-read-no'/, '行号独立成列 ai-read-no');
    assert.match(fn, /code\.className = 'ai-read-text'/, '代码独立成列 ai-read-text');
    assert.match(fn, /--ai-read-no-w/, '行号列宽随位数走，四位数行号不折行');
    // CSS：背景框与 diff 同款（border + radius + background: var(--bg)），行号列 nowrap
    const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');
    const box = css.slice(css.indexOf('.ai-read-body {'), css.indexOf('.ai-read-line'));
    assert.match(box, /border: 1px solid var\(--border\)/, '读取框必须有边框');
    assert.match(box, /border-radius: 4px/, '读取框必须有圆角');
    assert.match(box, /background: var\(--bg\)/, '读取框底色须与 diff 一致用 --bg（不是贴近卡片的 --panel2）');
    const no = css.slice(css.indexOf('.ai-read-no {'), css.indexOf('.ai-read-text'));
    assert.match(no, /white-space: nowrap/, '行号列禁止折行');
});

// （截图里就是「等待新输入 {"timeoutSec":300}」），各自给一句人话。
test('等待 / 协作 / 会话类工具卡头给人话，不摆原始参数 JSON', () => {
    const src = readFileSync(new URL('../../../src/ai/tools/ai-tool-cards.js', import.meta.url), 'utf8');
    assert.match(src, /case 'wait_agent': \{[\s\S]{0,200}?最多 ' \+ Math\.max\(1, Math\.round\(sec \/ 60\)\) \+ ' 分钟'/,
        'wait_agent 卡头应显示等多久，而不是 {"timeoutSec":300}');
    for (const name of ['agent_send', 'agent_stop', 'agent_compact', 'notify_send', 'session_send', 'start_timer']) {
        assert.match(src, new RegExp("case '" + name + "':"), name + ' 需要自己的 primary 分支');
    }
});
