// 「AI 工作时自动收起编辑区」的判定与接线护栏。
//
// 判定是纯函数（src/ai/ai-auto-collapse.js），副作用在 main.js。这里既测判定表，
// 也测「漏一处就坏」的接线点——这个功能横跨 settings / 面板回调 / DOM 状态位 /
// 设置页 UI 四处，任何一处掉了都表现为「开关点了没反应」，只靠手测很难发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decideAutoCollapse, shouldExpandEditorOnTab} from '../../../src/ai/chat/ai-auto-collapse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// 全部条件都满足的基线：开关开、当前会话、回合开始、停靠分屏、面板开着、无脏文档。
function base(over) {
    return Object.assign({
        enabled: true,
        isCurrent: true,
        running: true,
        collapseReason: '',
        suppressed: false,
        mode: 'dock',
        panelOpen: true,
        hasDirtyDoc: false,
    }, over || {});
}

test('基线：回合开始 + 停靠分屏 → 收起', () => {
    assert.equal(decideAutoCollapse(base()), 'collapse');
});

test('开关关闭时什么都不做', () => {
    assert.equal(decideAutoCollapse(base({enabled: false, running: false, collapseReason: 'auto'})), '');
});

test('后台会话在跑不改变当前布局', () => {
    assert.equal(decideAutoCollapse(base({isCurrent: false})), '');
    assert.equal(decideAutoCollapse(base({isCurrent: false, running: false, collapseReason: 'auto'})), '');
});

test('回合结束：只还原自动收起的', () => {
    assert.equal(decideAutoCollapse(base({running: false, collapseReason: 'auto'})), 'expand');
});

test('回合结束：用户手动收起的编辑区不许被 AI 顶开', () => {
    assert.equal(decideAutoCollapse(base({running: false, collapseReason: 'manual'})), '');
});

test('回合结束：本来就没收起时不动作', () => {
    assert.equal(decideAutoCollapse(base({running: false, collapseReason: ''})), '');
});

test('已经收起时回合开始不重复动作（避免布局抖动）', () => {
    assert.equal(decideAutoCollapse(base({collapseReason: 'auto'})), '');
    assert.equal(decideAutoCollapse(base({collapseReason: 'manual'})), '');
});

test('用户手动展开过：本次让位过程中不再自动收（粘性位只保护当下）', () => {
    assert.equal(decideAutoCollapse(base({suppressed: true})), '');
});

test('只在停靠分屏生效：全屏与独立浮窗都不收', () => {
    assert.equal(decideAutoCollapse(base({mode: 'fullscreen'})), '');
    assert.equal(decideAutoCollapse(base({mode: 'float'})), '');
});

test('面板没打开时不收（收了也看不到 AI）', () => {
    assert.equal(decideAutoCollapse(base({panelOpen: false})), '');
});

test('有未保存修改时不收（收起会把脏标记藏起来）', () => {
    assert.equal(decideAutoCollapse(base({hasDirtyDoc: true})), '');
    // 但回合结束时仍然要把自己收起来的还回去，否则编辑区卡在隐藏态
    assert.equal(decideAutoCollapse(base({hasDirtyDoc: true, running: false, collapseReason: 'auto'})), 'expand');
});

test('接线：main.js 用双原因位，AI 自动收起不得覆盖用户意图', () => {
    const code = read('src/main.js');
    assert.match(code, /let editorCollapseReason = ''/, '缺少收起原因位');
    assert.match(code, /reason === 'auto' \? 'auto' : 'manual'/, 'setEditorCollapsed 未区分收起原因');
    assert.match(code, /let autoCollapseSuppressed = false/, '缺少自动收起的粘性位');
    assert.match(code, /onTurnStateChange:\s*\(running, sessionId, isCurrent\)/, '未注入回合状态回调');
    assert.match(code, /decideAutoCollapse\(\{/, 'applyAutoCollapse 未走纯函数判定');
    assert.match(code, /aiAutoCollapseEditor:\s*false/, '默认值必须是关（会改变布局，须用户主动开启）');
    assert.match(code, /settings\.aiAutoCollapseEditor = settings\.aiAutoCollapseEditor === true/, '缺少存量配置归一（缺键即关）');
});

test('接线：有内容打开时解开收起态（含 AI 打开文件 / 浏览器与子代理标签页）', () => {
    const groups = read('src/editor/editor-groups.js');
    const main = read('src/main.js');
    // 唯一收敛点：activateDoc → updateDocChrome。挂在这里才能一网打尽
    // 用户点文件、AI 打开文件、浏览器标签、子代理标签、补丁预览。
    assert.match(groups, /if \(deps\.onDocVisible\) deps\.onDocVisible\(deps\.file\)/, 'updateDocChrome 未通知宿主');
    // 必须在 refreshDockFill 之后：先摘 ai-dock-fill，再展开，否则留下「面板不满 + 内容不可见」
    const chrome = groups.slice(groups.indexOf('function updateDocChrome()'));
    const callRefresh = chrome.indexOf('refreshDockFill()');
    const callVisible = chrome.indexOf('onDocVisible(deps.file)');
    assert.ok(callRefresh >= 0 && callVisible > callRefresh, 'onDocVisible 必须在 refreshDockFill 之后调用');
    assert.match(main, /get onDocVisible\(\) \{ return revealEditorForContent; \}/, '未把回调接进 editor-groups');
    assert.match(main, /function revealEditorForContent\(\)/, '缺展开动作');
    // 收起不是固定锁：不能因为「内容可见」就永久抑制后续回合的让位
    assert.match(main, /if \(running\) autoCollapseSuppressed = false;/, '粘性位必须是回合级，不能跨回合永久锁');
});

test('接线：同一文档重新激活也要解开收起态（单例虚拟文档入口 / 点已激活标签页）', () => {
    const groups = read('src/editor/editor-groups.js');
    // activateDoc 对 doc === deps.file 早退、不走 updateDocChrome——便签是每窗口单例，
    // 已激活时再点活动栏便签按钮 / Ctrl+Alt+T / AI 的 open_memo_panel 都落进这条分支；
    // 收起不是固定锁，「再看一次」的意图必须仍然通知宿主展开，否则点了毫无反应。
    const fn = groups.slice(groups.indexOf('async function activateDoc'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /if \(deps\.onDocVisible\) deps\.onDocVisible\(doc\)/, 'activateDoc 早退分支未通知宿主解开收起态');
});

test('接线：AI 面板在流注册/注销处广播回合状态', () => {
    const code = read('src/ai/ai-panel.js');
    assert.match(code, /const onTurnStateChange = typeof opts\.onTurnStateChange/, '未接宿主回调');
    assert.match(code, /notifyTurnState\(true, next\.sessionId/, 'attachStream 未广播回合开始');
    assert.match(code, /notifyTurnState\(false, next\.sessionId/, 'detachStream 未广播回合结束');
});

test('接线：设置页开关四处齐全', () => {
    const html = read('index.html');
    const panel = read('src/ai/ai-panel.js');
    const dialog = read('src/ai/settings/ai-settings-dialog.js');
    assert.match(html, /id="ai-opt-auto-collapse-editor"/, '设置页缺少开关 DOM');
    assert.match(panel, /autoCollapseEditor:\s*document\.getElementById\('ai-opt-auto-collapse-editor'\)/, 'opt 表缺条目');
    assert.match(dialog, /opt\.autoCollapseEditor\.checked = settings\.aiAutoCollapseEditor === true/, '缺回填');
    assert.match(dialog, /opt\.autoCollapseEditor\.addEventListener\('change'/, '缺写入');
});

// ---- 「新标签页出现 → 取消收起」（settings.editorExpandOnNewTab，默认开）----

test('新标签页展开：收起中 + 停靠分屏 + 开关开 → 展开', () => {
    assert.equal(shouldExpandEditorOnTab({enabled: true, collapsed: true, mode: 'dock'}), true);
});

test('新标签页展开：全屏 / 悬浮不展开（编辑区本来就看不见）', () => {
    assert.equal(shouldExpandEditorOnTab({enabled: true, collapsed: true, mode: 'fullscreen'}), false);
    assert.equal(shouldExpandEditorOnTab({enabled: true, collapsed: true, mode: 'float'}), false);
});

test('新标签页展开：开关关、未收起、缺参数都不动', () => {
    assert.equal(shouldExpandEditorOnTab({enabled: false, collapsed: true, mode: 'dock'}), false);
    assert.equal(shouldExpandEditorOnTab({enabled: true, collapsed: false, mode: 'dock'}), false);
    assert.equal(shouldExpandEditorOnTab(), false);
    assert.equal(shouldExpandEditorOnTab({}), false);
});

test('接线：新标签页展开的判定走进 revealEditorForContent（不再无条件展开）', () => {
    const code = read('src/main.js');
    const fn = code.slice(code.indexOf('function revealEditorForContent'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /shouldExpandEditorOnTab\(/, 'revealEditorForContent 必须走纯函数判定');
    assert.match(body, /editorExpandOnNewTab !== false/, '开关要让「缺省即开」生效');
    assert.match(body, /aiPanel\.getMode/, '形态要取面板当前形态（仅停靠展开）');
    assert.match(body, /if \(expand\) setEditorCollapsed\(false\)/, '展开必须受判定约束，不许无条件调用');
});

test('接线：新标签页展开设置四处齐全', () => {
    const html = read('index.html');
    const panel = read('src/ai/ai-panel.js');
    const dialog = read('src/ai/settings/ai-settings-dialog.js');
    assert.match(html, /id="ai-opt-expand-editor-on-tab"/, '设置页缺少开关 DOM');
    assert.match(panel, /expandEditorOnTab:\s*document\.getElementById\('ai-opt-expand-editor-on-tab'\)/, 'opt 表缺条目');
    assert.match(dialog, /opt\.expandEditorOnTab\.checked = settings\.editorExpandOnNewTab !== false/, '缺回填（缺省即开）');
    assert.match(dialog, /opt\.expandEditorOnTab\.addEventListener\('change'/, '缺写入');
});
