// git-graph-lane.test.mjs —— Git 图谱泳道 SVG 几何纯函数测试。
// 布局由 `git log --graph`（graph.c 权威算法）产生、Go 侧解析成组内字形表，
// 前端按 Gitea svgcontainer.tmpl 映射逐字形直译成 SVG 段；这里测渲染几何：
// glyphX / laneSvgWidth / buildLaneSvg / parseCommitRefs / fileTreeFromChanges。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    glyphX, laneSvgWidth, buildLaneSvg, parseCommitRefs, fileTreeFromChanges,
    buildSkeletonHtml, clampPaneWidth, buildCommitMatcher, graphPageFailed,
} from '../../src/git-graph/git-graph.js';

test('glyphX：字形竖线画在格子右边界，相邻位差半泳道', () => {
    assert.equal(glyphX(1) - glyphX(0), 8, '相邻字形位差 = 半泳道宽');
    assert.equal(glyphX(2) - glyphX(1), 8);
    assert.ok(glyphX(0) > 0, '首字形留左留白');
});

test('laneSvgWidth 容纳所有泳道且不小于单泳道', () => {
    assert.ok(laneSvgWidth(1) >= glyphX(0) + 8);
    assert.ok(laneSvgWidth(4) > laneSvgWidth(1));
});

test('buildLaneSvg 直线历史：每行一个圆点 + 一条满行竖线', () => {
    const commits = [
        {sha: 'a', dotPos: 0, dotFlow: 1, rows: 1, glyphs: [{r: 0, p: 0, c: '*', f: 1}]},
        {sha: 'b', dotPos: 0, dotFlow: 1, rows: 1, glyphs: [{r: 0, p: 0, c: '*', f: 1}]},
    ];
    const svg = buildLaneSvg(commits, 1);
    assert.equal((svg.match(/class="gg-dot"/g) || []).length, 2);
    // 每行一条竖线段：M glyphX(0),行顶 → L glyphX(0),行底，首尾相接
    assert.equal((svg.match(/class="gg-line"/g) || []).length, 2);
    assert.ok(svg.includes(`M${glyphX(0)},0 L${glyphX(0)},26`), '第一行竖线应满行');
    assert.ok(svg.includes(`M${glyphX(0)},26 L${glyphX(0)},52`), '第二行竖线应从上一行底接起');
});

test('buildLaneSvg 分叉：关系行的反斜线从主线跨 2 格到下一泳道', () => {
    // 组 = 提交行 `*` + 关系行 `|\`（2 行 → 行高 13）
    const commits = [
        {sha: 'm', dotPos: 0, dotFlow: 1, rows: 2, glyphs: [
            {r: 0, p: 0, c: '*', f: 1},
            {r: 1, p: 0, c: '|', f: 1},
            {r: 1, p: 1, c: '\\', f: 2},
        ]},
        {sha: 'b', dotPos: 2, dotFlow: 2, rows: 1, glyphs: [{r: 0, p: 2, c: '*', f: 2}]},
    ];
    const svg = buildLaneSvg(commits, 2);
    // 主线：组内两行竖线 (0..13, 13..26) 相接成满行
    assert.ok(svg.includes(`M${glyphX(0)},0 L${glyphX(0)},13`), '提交行主线竖线');
    assert.ok(svg.includes(`M${glyphX(0)},13 L${glyphX(0)},26`), '关系行主线竖线');
    // 分叉斜线：直线从 glyphX(0),13 到 glyphX(2),26（跨 2 格，下一行 pos2 相接）。
    // 用直线而非 S 形贝塞尔：贝塞尔把横移压在行首形成台阶/凹陷（作者反馈「凹进去一块」）。
    assert.ok(svg.includes(`M${glyphX(0)},13 L${glyphX(2)},26`), '分叉斜线应为直线并跨 2 格落到 lane1');
    // 分支圆点在 x=glyphX(2)、组顶 + 行中（gh=26）
    assert.ok(svg.includes(`cx="${glyphX(2)}"`), '分支圆点 x 应在 lane1');
});

test('buildLaneSvg 汇入：斜杠与横线字形按映射画段', () => {
    // `|/ `：pos1 的 `/` 从右格右界到左格左界（跨 2 格）
    const commits = [
        {sha: 'b', dotPos: 2, dotFlow: 2, rows: 2, glyphs: [
            {r: 0, p: 2, c: '*', f: 2},
            {r: 1, p: 1, c: '/', f: 2},
        ]},
        {sha: 'm', dotPos: 0, dotFlow: 1, rows: 1, glyphs: [{r: 0, p: 0, c: '*', f: 1}]},
    ];
    const svg = buildLaneSvg(commits, 2);
    assert.ok(svg.includes(`M${glyphX(2)},13 L${glyphX(0)},26`), '汇入斜线应为直线并落到主线泳道底');
});

test('buildLaneSvg 缺省 glyphs 只画圆点（容错）', () => {
    const commits = [{sha: 'a', dotPos: 0, dotFlow: 1, rows: 1}];
    const svg = buildLaneSvg(commits, 1);
    assert.equal((svg.match(/gg-dot/g) || []).length, 1);
    assert.equal((svg.match(/gg-line/g) || []).length, 0);
});

test('buildLaneSvg 空列表返回空 svg', () => {
    const svg = buildLaneSvg([], 1);
    assert.ok(svg.includes('<svg'));
    assert.equal((svg.match(/gg-dot/g) || []).length, 0);
});

test('parseCommitRefs 把 %D 装饰器拆成分类徽章', () => {
    const chips = parseCommitRefs('HEAD -> master, origin/master, tag: v1.0');
    assert.deepEqual(chips, [
        {kind: 'head', name: 'HEAD'},
        {kind: 'local', name: 'master'},
        {kind: 'remote', name: 'origin/master'},
        {kind: 'tag', name: 'v1.0'},
    ]);
});

test('parseCommitRefs 空装饰器与 detached HEAD', () => {
    assert.deepEqual(parseCommitRefs(''), []);
    assert.deepEqual(parseCommitRefs(null), []);
    assert.deepEqual(parseCommitRefs('HEAD'), [{kind: 'head', name: 'HEAD'}]);
    assert.deepEqual(parseCommitRefs('feat/gear162-back'), [{kind: 'local', name: 'feat/gear162-back'}]);
});

test('fileTreeFromChanges 组目录树：目录在前、按名排序、保留状态', () => {
    const nodes = fileTreeFromChanges([
        {path: 'src/zz.js', status: 'M'},
        {path: 'src/api/b.js', status: 'A'},
        {path: 'src/api/a.js', status: 'D'},
        {path: 'root.md', status: 'M'},
        {path: 'src/new.js', oldPath: 'src/old.js', status: 'R'},
    ]);
    // 根级：先目录 src，后文件 root.md
    assert.equal(nodes[0].type, 'dir');
    assert.equal(nodes[0].name, 'src');
    assert.equal(nodes[1].type, 'file');
    assert.equal(nodes[1].name, 'root.md');
    // src 下：api 目录在前，文件按名排序
    const src = nodes[0].children;
    assert.equal(src[0].type, 'dir');
    assert.equal(src[0].name, 'api');
    assert.equal(src[1].name, 'new.js');
    assert.equal(src[1].oldPath, 'src/old.js');
    assert.deepEqual(src.map((n) => n.name), ['api', 'new.js', 'zz.js']);
    // api 内按名排序
    assert.deepEqual(src[0].children.map((n) => n.name), ['a.js', 'b.js']);
});

test('fileTreeFromChanges 空列表返回空数组', () => {
    assert.deepEqual(fileTreeFromChanges([]), []);
    assert.deepEqual(fileTreeFromChanges(null), []);
});

test('fileTreeFromChanges 传 rootName 时套一层工作区顶层节点', () => {
    const nodes = fileTreeFromChanges([
        {path: 'src/a.js', status: 'M'},
        {path: 'README.md', status: 'M'},
    ], 'CaDt-DataLens');
    assert.equal(nodes.length, 1, '只返回一个根节点');
    assert.equal(nodes[0].type, 'dir');
    assert.equal(nodes[0].name, 'CaDt-DataLens');
    assert.equal(nodes[0].root, true);
    assert.deepEqual(nodes[0].children.map((n) => n.name), ['src', 'README.md']);
    assert.deepEqual(nodes[0].children[0].children.map((n) => n.name), ['a.js']);
});

const MATCH_COMMITS = [
    {sha: 'abc1234def', subject: 'Fix Login Bug', author: 'Alice', email: 'alice@x.com', date: '2026-11-20 10:00', refs: 'HEAD -> master'},
    {sha: '9990000aaa', subject: 'fix logout bug', author: 'Bob', email: 'bob@x.com', date: '2026-11-01 09:00', refs: ''},
];

test('buildCommitMatcher 文本模式默认不区分大小写', () => {
    const {match} = buildCommitMatcher({query: 'login'});
    assert.equal(match(MATCH_COMMITS[0]), true, 'login 命中 Fix Login Bug');
    assert.equal(match(MATCH_COMMITS[1]), false);
});

test('buildCommitMatcher 区分大小写', () => {
    const exact = buildCommitMatcher({query: 'Login', caseSensitive: true}).match;
    assert.equal(exact(MATCH_COMMITS[0]), true, '区分大小写时 Login 命中 Login');
    const lower = buildCommitMatcher({query: 'login', caseSensitive: true}).match;
    assert.equal(lower(MATCH_COMMITS[0]), false, '区分大小写时 login 不命中 Login');
});

test('buildCommitMatcher 正则模式与非法正则', () => {
    const {match} = buildCommitMatcher({query: '^fix.*bug$', regex: true});
    assert.equal(match(MATCH_COMMITS[0]), true);
    assert.equal(match(MATCH_COMMITS[1]), true);
    const bad = buildCommitMatcher({query: '[', regex: true});
    assert.ok(bad.error, '非法正则应返回 error 而非抛异常');
});

test('buildCommitMatcher 用户与日期筛选', () => {
    assert.equal(buildCommitMatcher({user: 'alice'}).match(MATCH_COMMITS[0]), true);
    assert.equal(buildCommitMatcher({user: 'alice'}).match(MATCH_COMMITS[1]), false);
    const now = Date.parse('2026-11-20T12:00:00');
    assert.equal(buildCommitMatcher({date: '7d', now}).match(MATCH_COMMITS[0]), true);
    assert.equal(buildCommitMatcher({date: '7d', now}).match(MATCH_COMMITS[1]), false, '11-01 不在最近 7 天');
});

test('buildSkeletonHtml 三栏齐全且条块数量合理', () => {
    const html = buildSkeletonHtml();
    assert.ok(html.includes('gg-sk-refs'), '应有 ref 树骨架');
    assert.ok(html.includes('gg-sk-commits'), '应有提交列表骨架');
    assert.ok(html.includes('gg-sk-detail'), '应有详情骨架');
    assert.ok((html.match(/gg-sk-row/g) || []).length >= 8, '提交骨架应有多行占位');
    assert.ok((html.match(/gg-sk-dot/g) || []).length >= 8, '每行应有泳道圆点占位');
    assert.ok((html.match(/gg-sk-line/g) || []).length >= 4, 'ref 树应有多行占位');
});

test('buildSkeletonHtml 纯静态、条块宽度合法（无注入风险）', () => {
    const html = buildSkeletonHtml();
    // 所有 width 都是合法的百分比数字，不含脚本或用户输入
    const widths = [...html.matchAll(/width:(\d+)%/g)].map((m) => Number(m[1]));
    assert.ok(widths.length > 0, '应有宽度声明');
    assert.ok(widths.every((w) => w > 0 && w <= 100), '宽度应在 1–100% 之间');
    assert.ok(!/<script|on\w+=/.test(html), '骨架 HTML 不应含脚本或事件处理器');
});

test('clampPaneWidth 把拖动宽度限制在 [min, max]', () => {
    assert.equal(clampPaneWidth(250, 120, 400), 250, '区间内原样返回');
    assert.equal(clampPaneWidth(50, 120, 400), 120, '低于下限钳到 min');
    assert.equal(clampPaneWidth(900, 120, 400), 400, '超过上限钳到 max');
});

test('clampPaneWidth 非法值与退化区间回落到 min', () => {
    assert.equal(clampPaneWidth(NaN, 120, 400), 120, 'NaN 回落 min');
    assert.equal(clampPaneWidth(undefined, 120, 400), 120, 'undefined 回落 min');
    assert.equal(clampPaneWidth(Infinity, 120, 400), 120, '无穷回落 min');
    assert.equal(clampPaneWidth(250, 120, 100), 120, 'max<min 的退化区间回落 min');
});

// 2026-11-20 实测回归：缓存命中路径（再次点同一提交）在首个 await 前同步调用
// fillFiles / fillBody，而两个 const 声明在函数后半段——TDZ 直接炸出
// 「Cannot access 'fillFiles' before initialization」的未处理 Promise 拒绝。
test('loadCommitDetail：fillFiles / fillBody 声明先于缓存命中调用（TDZ 回归护栏）', () => {
    const src = readFileSync(new URL('../../src/git-graph/git-graph.js', import.meta.url), 'utf8');
    const body = /async function loadCommitDetail\([\s\S]*?\n    \}/.exec(src);
    assert.ok(body, 'loadCommitDetail 应存在');
    const b = body[0];
    assert.ok(b.includes('const fillFiles') && b.includes('const fillBody'), '两个填充函数应存在');
    assert.ok(b.indexOf('const fillFiles') < b.indexOf('fillFiles(cacheHit.files)'),
        'fillFiles 声明必须先于缓存命中路径的调用（const TDZ）');
    assert.ok(b.indexOf('const fillBody') < b.indexOf('fillBody(bodyEl, sha, cacheHit.body)'),
        'fillBody 声明必须先于缓存命中路径的调用（const TDZ）');
    // 签名单参：缓存路径只传 files（曾误传 filesWrap 把详情容器当文件数组用）
    assert.match(b, /fillFiles\(cacheHit\.files\)/);
    assert.doesNotMatch(b, /fillFiles\(filesWrap/);
});

// graphPageFailed：Go 侧 available 在跑 git log 前就置 true，坏 ref 只写 reason。
// 「available=true + 零提交 + reason」必须判失败，否则 initialized 被置 true、列表空、连刷新都救不回。
test('graphPageFailed：空页 / 未 available / 有 reason 零提交 都算失败', () => {
    assert.equal(graphPageFailed(null), true, 'null 页');
    assert.equal(graphPageFailed(undefined), true, 'undefined 页');
    assert.equal(graphPageFailed({available: false, commits: [], reason: '不在 git 仓库内'}), true,
        'available=false');
    assert.equal(graphPageFailed({available: true, commits: [], reason: '非法修订'}), true,
        'available=true 但坏 ref 零提交（Go 不撤 available）');
});

test('graphPageFailed：正常页与合法的空仓库都不算失败', () => {
    assert.equal(graphPageFailed({available: true, commits: [{sha: 'a'}], reason: ''}), false,
        '有提交');
    // 空仓库：available + 零提交 + 无 reason —— 合法的「没有提交」，不算失败
    assert.equal(graphPageFailed({available: true, commits: [], reason: ''}), false,
        '合法空仓库');
    // commits 缺失但无 reason：容错成空，不误判失败
    assert.equal(graphPageFailed({available: true, reason: ''}), false,
        'commits 缺失容错');
});
