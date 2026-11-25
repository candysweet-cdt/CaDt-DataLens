// 轮次过程折叠的结构护栏：一轮只能有一条折叠条（一个头 + 一个折叠状态）。
//
// 背景：过程内容曾按「已回答的提问卡」切成多段以守住时间序，2026-11-17 先把折叠头
// 收到轮级（否则同一轮里「已完成 · 用时 13 分 9 秒」重复出现三次，看起来像跑了三轮）；
// 2026-11-19 起提问卡不再切段——「body｜卡｜body」展开时过程被打断，改由
// 「含已答提问的轮完成后默认展开」兜住问答记录的可见性（turn-fold-redesign.md §5）。
//
// 这些不变量写在渲染函数里（renderTurn 依赖 DOM 与后端，无法直接单测），所以按项目惯例
// 用源码断言钉住，改动时先确认是不是真的要拆掉它们：
//   R1 折叠状态 key 不带段号（带段号就等于每段一个开关）
//   R2 折叠头只在 isFoldHead 段创建，续段只出无头 body 容器
//   R3 点头后同一轮所有段同步开合
//   R4 续段收起时不占位（否则空容器把卡片间距翻倍）
//   R5 已答提问卡不切段，留在过程流里按时间序渲染
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function read(rel) {
    return readFileSync(join(SRC, rel), 'utf8');
}

test('轮次折叠：key 只到轮，段号不进折叠状态', () => {
    const panel = read('ai/ai-panel.js');
    assert.ok(!/\+\s*':s'\s*\+\s*segIndex/.test(panel),
        '折叠状态 key 不许再拼段号——那一轮就会按段数长出多个独立开关');
    assert.match(panel, /const turnFoldKey = session\.id \+ ':' \+ \(group\.user \? 'u' \+ group\.user\.ts : 'g' \+ group\.startIndex\)/);
    // 同一个 key 同时用于状态记忆、DOM 标记与点击同步
    assert.match(panel, /const key = turnFoldKey;/);
});

test('轮次折叠：折叠头只在首个可渲染段创建', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /const foldHeadIndex = segments\.findIndex\(\(seg, idx\) => !seg\.steer && segRenderable\(seg, idx\)\)/);
    // head 的创建必须在 isFoldHead 分支里，续段只挂 body
    const headBlock = panel.match(/if \(isFoldHead\) \{[\s\S]*?fold\.appendChild\(head\);\s*\}/);
    assert.ok(headBlock, '折叠头应当被 isFoldHead 包住');
    assert.match(headBlock[0], /className = 'ai-process-head'/);
    // 续段靠 cont 类区分：无头、共享同一个开合状态
    assert.match(panel, /\(isFoldHead \? '' : ' cont'\)/);
});

test('轮次折叠：已答提问卡不切段，留在过程流里', () => {
    const panel = read('ai/ai-panel.js');
    assert.ok(!/segments\.push\(\{ask:/.test(panel),
        '已答提问卡不许再把过程流切成 body｜卡｜body（2026-11-19 作者裁定）');
    // 卡片随过程一起开合，默认值不再为提问特判
    assert.ok(!/hasSettledAsk/.test(panel),
        '提问卡不参与默认展开判定——与其他过程条目同一条开合规则');
});

test('轮次折叠：用户插话整条渲染在折叠区外', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /segments\.push\(\{steer: item\}\)/);
    assert.match(panel, /if \(seg\.steer\) \{[\s\S]*?renderMessage\(seg\.steer\.message, seg\.steer\.index, session, host, turnOptions\);[\s\S]*?return;/);
    // 插话段不参与折叠判定，避免把用户消息塞进过程 body
    assert.match(panel, /const segHasBody = \(seg, segIndex\) => !seg\.steer &&/);
    assert.match(panel, /const segRenderable = \(seg, segIndex\) => !seg\.steer &&/);
});

test('轮次折叠：点头同步同一轮所有段', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /for \(const node of host\.querySelectorAll\('\.ai-process'\)\) \{/);
    assert.match(panel, /if \(node\.dataset\.processKey === key\) node\.classList\.toggle\('collapsed', !next\)/);
    // 展开时每个段各自的懒建 body 都要补上（各段 ensureBody 是独立闭包）
    assert.match(panel, /segEnsureBody\.push\(ensureBody\)/);
    assert.match(panel, /if \(next\) segEnsureBody\.forEach\(\(fn\) => fn\(\)\)/);
});

test('轮次折叠：续段收起不占位，展开与首段同缩进', () => {
    const css = read('style.css');
    assert.match(css, /\.ai-process\.cont\.collapsed \{ display: none; \}/);
    assert.match(css, /\.ai-process\.cont > \.ai-process-body \{ margin-top: 0; \}/);
});

test('分支会话：标题派生自母会话，不留成「新会话」', () => {
    const panel = read('ai/ai-panel.js');
    const start = panel.indexOf('function branchSessionAt');
    const block = panel.slice(start, panel.indexOf('function editLast', start));
    assert.ok(block.length > 100, 'branchSessionAt 源码切片失效');
    // 派生标题必须真的传给 createSessionData，而不是再调一次空的
    assert.match(block, /createSessionData\(sourceTitle \? '分支 · ' \+ sourceTitle : '分支'\)/,
        '分支标题须带上母会话标题，母会话无标题时退化为「分支」');
    // 占位标题（新会话 / 会话）不能派生出「分支 - 新会话」这种无意义标题
    assert.match(block, /source\.title !== '新会话' && source\.title !== '会话'/);
});

test('轮次折叠：点头开合后以折叠头为锚补偿 scrollTop，视图不跳', () => {
    const panel = read('ai/ai-panel.js');
    const start = panel.indexOf("head.addEventListener('click'");
    const end = panel.indexOf('fold.appendChild(head)', start);
    const click = panel.slice(start, end);
    assert.ok(click.length > 100, '折叠头 click 源码切片失效');
    // 开合前量锚点、开合后按锚点位移补偿 scrollTop（同一轮续段同步开合会顶走视口）
    assert.match(click, /head\.getBoundingClientRect\(\)\.top/, '点击前要量折叠头的视口位置');
    assert.match(click, /anchorScrollDelta\(/, '要用锚定纯函数算补偿量');
    assert.match(click, /host\.scrollTop = scrollBefore \+ delta/, '要把补偿量写回 scrollTop');
    // 补偿后同步滚动基准，避免程序位移被滚动监听当成用户上滚、误解除贴底
    assert.match(click, /scrollLastTop = host\.scrollTop/);
    assert.match(click, /scrollGesture\.reset\(\)/);
    // 只从单一来源导入锚定函数，不许就地重写
    assert.match(panel, /anchorScrollDelta[^\n]*from '\.\/chat\/ai-scroll-follow\.js'/);
});

test('消息操作栏：纯图标按钮必须挂 data-tip，否则悬停无气泡', () => {
    const panel = read('ai/ai-panel.js');
    const append = panel.slice(panel.indexOf('function appendActions'));
    assert.ok(append.length > 100, 'appendActions 源码切片失效');
    const addFn = append.match(/const add = \(act, label, disabled\) => \{[\s\S]*?\n        \};/);
    assert.ok(addFn, '找不到 appendActions 里的 add() 按钮工厂');
    // tooltip 运行时只认 data-tip；只设 aria-label 不会弹气泡（2026-11-17 用户反馈「分不清按钮干啥的」）
    assert.match(addFn[0], /button\.dataset\.tip = label/, 'add() 必须把 label 同时写进 data-tip');
    // 文案与无障碍名同源：两处都还留着，别顾此失彼
    assert.match(addFn[0], /setAttribute\('aria-label', label\)/, '无障碍名不能因为加了 tooltip 就丢');
});
