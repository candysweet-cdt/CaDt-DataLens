// 图标护栏（icon-consolidation 方案 P0，2026-11-21 定）：core/icons.js 是全项目唯一
// 通用 UI 图标注册表（规范见 docs/icon-guidelines.md），本护栏把「规范存在、执行失效」
// 变成「靠机制」，五条规则：
//   ① 业务代码禁止内联 <svg> 字面量——图标一律 iconSvg()；合理例外域直接豁免，
//      其余存量进按文件计数的基线，只许减不许增；
//   ② 菜单数据禁止遗留 Segoe MDL2 码位——任何带引号的 'E8C8' 一类字面量都算
//      （含 icon: / 三元式 / 点赋值 / case 标签 / iconSvg() 实参），一律写命名图标；
//   ③ iconHtml 只允许 iconSvg() 来源；其他来源必须带 // iconHtml-exception: 原因注释；
//   ④ 注册表自身规范：图形不得含硬编码颜色（currentColor 着色是硬要求）、不得嵌套 <svg>；
//   ⑤ 字面量键引用必须已注册：iconSvg('x') / icon: 'x' 里的键名要在 ICONS 中——
//      未知键 iconSvg 静默返回空串、图标无声消失（2026-11-22 复审：explorer 的 tree 键
//      漏登记导致树视图按钮渲染为空，npm test 全绿也看不见，靠这条守）。
// 基线机制仿 form-controls-factory.test.mjs：迁移一处就把对应数字调小，**永远不要调大**；
// 新文件出现命中直接失败（基线里没有该文件）。
// 用 `PRINT_ICON_BASELINE=1 node --test test/core/icon-guard.test.mjs` 重新打印当前快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ICONS, iconSvg, resolveIconName} from '../../src/core/icons.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(FRONTEND, 'src');

// 合理例外域（docs/icon-guidelines.md + 方案第二节第 2 条）：专用图标语义或非图标产物，
// 禁止并入通用注册表，也不参与护栏计数。
const EXEMPT_FILES = new Set([
    'core/icons.js',           // 注册表本体（iconSvg 包壳所在；LEGACY_ICONS 的码位键形态也在豁免内）
    'core/fileicons.js',       // 文件类型图标域
    'core/fileicons-os.js',    // 文件类型图标域（OS 主题）
    'core/visual-spec.js',     // 可视化规范内嵌示例 SVG
    'core/widget.js',          // AI 可视化引擎（检测/补壳用户 SVG 产物）
    'core/layout-render.js',   // graph 关系图渲染（图表产物，非图标）
    'core/wordcloud-render.js',// 词云渲染（图表产物，非图标）
    'ai/core/ai-provider-icons.js', // 供应商品牌图标域
    // 非图标命中（文件级豁免，写明原因）：
    'dev/mock-backend.js',     // mock 的文件内容/插件图标数据，非 UI 图标
    'shell/plugins.js',        // 插件运行时只检查插件提供的字符串是否含 SVG，不自产图标
]);

// 引号紧跟 <svg> 才算图标字面量：放行正则字面量 /<svg[\s>]/、报错文案「缺少 <svg> 根元素」、
// 注释里带空格的提法；命中 `'<svg …'`、`` `<svg … ``、`"<svg>"`、拼接首段 `'<svg'`。
const INLINE_SVG_RE = /['"`]<svg[\s>/>'"]/gi;
// 遗留码位：任何带引号的 E 码字面量都算（规则②的键形态 'E70D': 'x' 在豁免文件 icons.js 里，不参与扫描）
const LEGACY_CODE_RE = /['"]E[0-9A-Fa-f]{3,4}['"]/g;
// 字面量注册表键引用（小写 kebab 开头；大写 E 码归规则②管，动态键名取值不在此列）
const ICON_REF_RE = /(?:\bicon:\s*|iconSvg\(\s*)['"]([a-z][a-z0-9-]{0,30})['"]/g;

// 规则⑤放行名单：字面量形态但语义不是注册表键的（写明原因）
const ICON_REF_ALLOW = {
    'roundRect': 'ECharts legend 内置图标保留值（settings-pane-usage-stats.js 的图例配置），非本仓注册表键',
};

function sourceFiles() {
    const out = [];
    for (const rel of readdirSync(SRC, {recursive: true, encoding: 'utf8'})) {
        const norm = rel.replace(/\\/g, '/');
        if (!norm.endsWith('.js')) continue;
        if (EXEMPT_FILES.has(norm)) continue;
        out.push({norm, path: join(SRC, rel)});
    }
    return out;
}

function readLines() {
    return sourceFiles().map(({norm, path}) => ({norm, path, lines: readFileSync(path, 'utf8').split(/\r?\n/)}));
}

function countMatches(lines, re) {
    let n = 0;
    for (const line of lines) {
        re.lastIndex = 0;
        const m = line.match(re);
        if (m) n += m.length;
    }
    return n;
}

// ---- 存量基线（2026-11-22 收编后）：只许减不许增 ----

// 内联 <svg> 字面量。git-graph 剩的 1 处是泳道画布 <svg class="gg-lane-svg">（图表产物，
// 同 layout-render 性质），不是图标。
const INLINE_SVG_BASELINE = {
    'git-graph/git-graph.js': 1,
};

// 遗留码位基线：2026-11-22 已全仓清零（162 处迁移 + 4 处三元式补迁），空表 = 任何文件出现即红。
const LEGACY_CODE_BASELINE = {};

// iconHtml 非 iconSvg() 来源且无例外注释：已清零。永久合规的两处
// （shell/app-actions.js、explorer/new-file-menu.js 走 fileIconSpec 文件类型域）带
// // iconHtml-exception: 注释放行。
const ICON_HTML_BASELINE = {};

// 规则⑤键引用基线：空表 = 未注册键字面量一出现即红。
const ICON_REF_BASELINE = {};

function snapshot() {
    const inline = {};
    const legacy = {};
    const iconHtml = {};
    const iconRef = {};
    for (const {norm, lines} of readLines()) {
        const a = countMatches(lines, INLINE_SVG_RE);
        if (a) inline[norm] = a;
        const b = countMatches(lines, LEGACY_CODE_RE);
        if (b) legacy[norm] = b;
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
            if (!/iconHtml:/.test(lines[i])) {
                // 规则⑤：iconSvg('x') / icon: 'x' 字面量必须是注册表键（注释行不算）
                if (!isComment) {
                    ICON_REF_RE.lastIndex = 0;
                    for (const m of lines[i].matchAll(ICON_REF_RE)) {
                        const key = m[1];
                        if (ICONS[key] || ICON_REF_ALLOW[key]) continue;
                        iconRef[norm] = (iconRef[norm] || 0) + 1;
                    }
                }
                continue;
            }
            if (isComment) continue; // 注释行不算
            const prev = i > 0 ? lines[i - 1] : '';
            if (/iconHtml:\s*iconSvg\(/.test(lines[i])) continue; // 注册表来源天然合规
            if (/iconHtml-exception:/.test(lines[i]) || /iconHtml-exception:/.test(prev)) continue;
            iconHtml[norm] = (iconHtml[norm] || 0) + 1;
        }
    }
    return {inline, legacy, iconHtml, iconRef};
}

const current = snapshot();
if (process.env.PRINT_ICON_BASELINE === '1') {
    console.log('CURRENT_ICON_BASELINE=' + JSON.stringify(current, null, 2));
}

// ---- 扫描器自测：抓得到真命中、放得过合理写法（防扫描器空转假绿）----
test('扫描器自测：抓得到内联 svg / 码位 / 未注册键、放得过正则与文案', () => {
    assert.equal(countMatches(["const I = '<svg viewBox=\"0 0 16 16\">'"], INLINE_SVG_RE), 1);
    assert.equal(countMatches(["x.innerHTML = `<svg class='q'/>`"], INLINE_SVG_RE), 1);
    assert.equal(countMatches(["s = '<svg>'"], INLINE_SVG_RE), 1);
    assert.equal(countMatches(["p = '<svg' + path"], INLINE_SVG_RE), 1);
    assert.equal(countMatches(["/<svg[\\s>]/i.test(text)"], INLINE_SVG_RE), 0);
    assert.equal(countMatches(["msg = '缺少 <svg> 根元素'"], INLINE_SVG_RE), 0);
    assert.equal(countMatches(['// 返回 <svg> 的 innerHTML'], INLINE_SVG_RE), 0);
    assert.equal(countMatches(["{icon: 'E8C8'}", "iconSvg('E70D')"], LEGACY_CODE_RE), 2);
    // 三元式 / 点赋值 / case 标签的码位也要抓（2026-11-22 复审补的盲区；三元一行两个码位）
    assert.equal(countMatches(["x = cond ? 'E70D' : 'E70E'", "item.icon = 'E8C8'", "case 'E74D':"], LEGACY_CODE_RE), 4);
    assert.equal(countMatches(["{icon: 'copy'}", "iconSvg('check')"], LEGACY_CODE_RE), 0);
    // LEGACY_ICONS 键形态 'E8C8': 'copy' 会被抓到——但它在豁免文件 core/icons.js 里，不参与扫描
    assert.equal(countMatches(["'E8C8': 'copy'"], LEGACY_CODE_RE), 1);
    // 规则⑤：iconSvg('x') / icon: 'x' 字面量（放行注册表键与名单，抓未注册键）
    const refCount = (line) => {
        ICON_REF_RE.lastIndex = 0;
        let n = 0;
        for (const m of line.matchAll(ICON_REF_RE)) {
            if (ICONS[m[1]] || ICON_REF_ALLOW[m[1]]) continue;
            n++;
        }
        return n;
    };
    assert.equal(refCount("el.innerHTML = iconSvg('close', 12)"), 0);
    assert.equal(refCount("{icon: 'folder', label: '打开文件夹'}"), 0);
    assert.equal(refCount("icon: 'roundRect'"), 0); // 名单放行（ECharts 内置）
    assert.equal(refCount("tree: iconSvg('tree-not-registered')"), 1); // tree 键漏登记的真实回归形态（键现已在册，换假键名自测）
    assert.equal(refCount("iconSvg('not-registered-yet')"), 1);
    assert.equal(refCount("icon: cond ? 'folder' : undefined"), 0); // 动态表达式不在此列（码位归规则②）
    assert.equal(refCount("icon: 'E8C8'"), 0); // 大写 E 开头归规则②
});

// ---- 规则 ①：内联 <svg> 字面量 ----
test('业务代码禁止内联 <svg> 字面量（合理例外域外，按文件基线只减不增）', () => {
    for (const [file, count] of Object.entries(current.inline)) {
        const base = INLINE_SVG_BASELINE[file];
        assert.ok(base !== undefined,
            `新文件 ${file} 出现 ${count} 处内联 <svg>；请改用 core/icons.js 的 iconSvg()`);
        assert.ok(count <= base,
            `${file} 的内联 <svg> 从 ${base} 增到 ${count}；新图标先登记 core/icons.js 再用 iconSvg()（迁移存量后把基线调小）`);
    }
});

// ---- 规则 ②：遗留码位 ----
test('菜单数据禁止遗留 MDL2 码位（一律写命名图标，基线只减不增）', () => {
    for (const [file, count] of Object.entries(current.legacy)) {
        const base = LEGACY_CODE_BASELINE[file];
        assert.ok(base !== undefined,
            `新文件 ${file} 出现 ${count} 处遗留码位；请改用命名图标（见 core/icons.js 的 ICONS）`);
        assert.ok(count <= base,
            `${file} 的遗留码位从 ${base} 增到 ${count}；请改为命名图标（迁移存量后把基线调小）`);
    }
});

// ---- 规则 ③：iconHtml 来源 ----
test('iconHtml 只允许 iconSvg() 来源，其他来源必须带 // iconHtml-exception: 注释', () => {
    for (const [file, count] of Object.entries(current.iconHtml)) {
        const base = ICON_HTML_BASELINE[file];
        assert.ok(base !== undefined,
            `新文件 ${file} 出现 ${count} 处无豁免的 iconHtml；请改用 iconSvg(注册表键)，确属例外加 // iconHtml-exception: 注释`);
        assert.ok(count <= base,
            `${file} 的无豁免 iconHtml 从 ${base} 增到 ${count}；iconHtml 只该包 iconSvg() 或登记例外注释`);
    }
});

// ---- 规则 ⑤：字面量键引用必须已注册 ----
test("iconSvg('x') / icon: 'x' 字面量必须是注册表键（未知键静默渲染为空）", () => {
    for (const [file, count] of Object.entries(current.iconRef)) {
        const base = ICON_REF_BASELINE[file];
        assert.ok(base !== undefined,
            `新文件 ${file} 出现 ${count} 处未注册的图标键字面量；请先在 core/icons.js 登记该键（确属非注册表语义的写明放行名单）`);
        assert.ok(count <= base,
            `${file} 的未注册键引用从 ${base} 增到 ${count}；先登记 core/icons.js 再用（名单放行要有原因）`);
    }
});

// ---- 规则 ④：注册表自身规范 ----
test('注册表图形不得含硬编码颜色 / 嵌套 <svg> / 空图形（currentColor 着色是硬要求）', () => {
    const keys = Object.keys(ICONS);
    assert.ok(keys.length >= 80, '注册表键数量异常，是否被误删？');
    for (const [name, body] of Object.entries(ICONS)) {
        assert.ok(body && body.length > 0, `注册表键 ${name} 的图形为空`);
        assert.doesNotMatch(body, /<svg/i, `注册表键 ${name} 的图形内嵌了 <svg>（应只存内部图形，壳由 iconSvg 统一包）`);
        assert.doesNotMatch(body, /#[0-9A-Fa-f]{3,8}\b/, `注册表键 ${name} 含硬编码颜色（UI 图标一律 currentColor 着色）`);
        assert.match(iconSvg(name), /^<svg viewBox="0 0 16 16"/, `注册表键 ${name} 经 iconSvg 包壳异常`);
    }
    assert.equal(iconSvg('__no_such_icon__'), '', '未知键应返回空串（不渲染占位符）');
    assert.equal(resolveIconName('E8C8'), 'copy', '遗留码位映射应保持可用（外部插件菜单数据兼容）');
});

// ---- 基线卫生：文件改名/删除后清掉对应条目 ----
test('基线里的文件必须真实存在（改名/删除后清掉对应条目）', () => {
    for (const [table, name] of [
        [INLINE_SVG_BASELINE, '内联'],
        [LEGACY_CODE_BASELINE, '码位'],
        [ICON_HTML_BASELINE, 'iconHtml'],
        [ICON_REF_BASELINE, '键引用'],
    ]) {
        for (const file of Object.keys(table)) {
            assert.ok(existsSync(join(SRC, file)), `${name}基线指向不存在的文件：${file}（清掉该条目）`);
        }
    }
});
