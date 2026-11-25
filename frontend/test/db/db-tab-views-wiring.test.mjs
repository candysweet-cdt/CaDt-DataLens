// db-tab-views-wiring.test.mjs —— 数据表标签页「插件视图切换」的接线守卫。
//
// 事故背景（2026-11-23）：视图切换用 .hidden 类藏表格面板，而 style.css 里后加的
// `.db-tab-view-pane { display: flex }` 与 `.hidden { display: none }` 同特异性、位置更靠后，
// 直接把 display:none 盖掉——结果切到「图」档时表格仍在、插件视图被挤成 0 高度，
// 界面上表现为「点开图什么都没有」。
// 约定：显隐一律用内联 style.display，别用会被同特异性规则覆盖的类。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/db/db-tab-views.js', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../src/style.css', import.meta.url)), 'utf8');

test('视图切换：表格面板显隐必须走内联 display，不得用 .hidden 类', () => {
    assert.ok(/tablePane\.style\.display = 'none'/.test(src), '切到插件视图时用内联 display:none 藏表格');
    assert.ok(/tablePane\.style\.display = ''/.test(src), '切回表格 / 挂载失败回滚时用内联 display 恢复');
    assert.ok(!/tablePane\.classList\.add\('hidden'\)/.test(src),
        '不得再用 .hidden 类藏表格：它与 .db-tab-view-pane 的 display:flex 同特异性且更靠前');
    assert.ok(!/tablePane\.classList\.remove\('hidden'\)/.test(src), '同上，恢复也不走类');
});

test('样式：.db-tab-view-pane.hidden 兜底规则存在（防同特异性覆盖回归）', () => {
    assert.ok(/\.db-tab-views-body > \.db-tab-view-pane\.hidden \{ display: none; \}/.test(css),
        'CSS 里要有更高特异性的兜底，别只依赖 .hidden');
});

test('插件视图宿主：挂载失败要回滚到表格并提示，不能留空白容器', () => {
    assert.ok(/if \(deps\.flash\) deps\.flash\('「' \+ view\.label \+ '」视图加载失败/.test(src),
        'mount 抛错时要 flash 出原因');
    assert.ok(/wrap\.remove\(\);[\s\S]{0,120}tablePane\.style\.display = '';/.test(src),
        '挂载失败要摘掉容器并把表格显回来');
});

test('插件视图宿主：切走 / 关标签必须销毁插件视图并断开观察器', () => {
    assert.ok(/if \(handle && typeof handle\.destroy === 'function'\) handle\.destroy\(\)/.test(src),
        '切视图时要调插件的 destroy');
    assert.ok(/if \(ro\) ro\.disconnect\(\)/.test(src), 'destroy 要断开 ResizeObserver');
    assert.ok(/if \(themeObs\) themeObs\.disconnect\(\)/.test(src), 'destroy 要断开主题 MutationObserver');
});

// ---------- 查询框（驱动 console 声明）的交互健壮性 ----------
// 这几条来自 PR #4 的代码审查：都是「能跑但不安全」的问题，用源码守卫钉住。

test('查询框：keydown 必须挡输入法组字（中文按 Enter 不执行）', () => {
    assert.ok(/if \(ev\.isComposing \|\| ev\.keyCode === 229\) return;/.test(src),
        'keydown 首行要做 isComposing / keyCode 229 早退（项目既定规范）');
    // 早退必须排在 Enter 判定之前，否则组字中的回车仍会 preventDefault + 执行
    const kd = src.indexOf('input.addEventListener(\'keydown\'');
    const guard = src.indexOf('if (ev.isComposing || ev.keyCode === 229) return;', kd);
    const enter = src.indexOf('ev.key === \'Enter\'', kd);
    assert.ok(guard > kd && enter > guard, 'IME 早退必须排在 Enter 分支之前');
});

test('查询框：竞态防线——自增 token，过期响应不覆盖新结果', () => {
    assert.ok(/let querySeq = 0;/.test(src), '要有自增 token');
    assert.ok(/const my = \+\+querySeq;/.test(src), '每次执行取一份 token');
    assert.ok(/if \(destroyed \|\| my !== querySeq\) return;/.test(src),
        '渲染/报错前必须校验 token，两条路径共用');
    // 直发与「确认执行」必须都走同一个 execute，否则两个锁互不感知
    assert.ok(/function execute\(sql, confirmed\)/.test(src), '直发与确认共用 execute');
    const confirms = src.match(/execute\(sql, true\)/g) || [];
    assert.equal(confirms.length, 1, '确认路径也走 execute(sql, true)');
});

test('查询框：确认横幅在输入变化时作废，避免执行旧语句', () => {
    assert.ok(/let pending = null;/.test(src), '要记待确认的语句');
    const inputHandler = src.indexOf('input.addEventListener(\'input\'');
    const invalidate = src.indexOf('if (pending) {', inputHandler);
    assert.ok(invalidate > inputHandler, 'input 监听里要在 pending 存在时作废');
    assert.ok(/上一次的写操作确认已作废/.test(src), '作废要给用户提示');
    assert.ok(/if \(!pending \|\| pending\.sql !== sql\) return;/.test(src),
        '确认按钮点击时再校验一次（防双击 / 已作废）');
});

test('查询框：写操作两条路径留痕一致，且用既有 db.exec 类型', () => {
    assert.ok(/function renderWithWrites\(outcome, started\)/.test(src), '写收尾要抽公共函数');
    assert.ok(/deps\.logActivity\('db\.exec'/.test(src), '留痕类型用既有的 db.exec');
    assert.ok(!/db\.query\.write/.test(src), '不得新造 db.query.write 类型');
    const calls = src.match(/renderWithWrites\(/g) || [];
    assert.ok(calls.length >= 2, '直发与确认都要走同一个收尾');
});

test('查询框：插件不返回 elapsedMs 时用本地计时兜底', () => {
    assert.ok(/function elapsedOf\(result, started\)/.test(src), '要有本地计时兜底');
    assert.ok(/if \(result && result\.elapsedMs != null\) return result\.elapsedMs;/.test(src),
        '优先用后端 elapsedMs');
    assert.ok(/return Math\.max\(0, Date\.now\(\) - started\);/.test(src),
        '缺失时退回本地差值（不外露 undefined / NaN）');
});

test('查询框：宿主销毁时作废在途请求', () => {
    assert.ok(/wrap\.__destroy = \(\) => \{/.test(src), '要暴露 __destroy');
    assert.ok(/if \(queryBar && typeof queryBar\.__destroy === 'function'\)/.test(src),
        '宿主 destroy 要调到它');
});

