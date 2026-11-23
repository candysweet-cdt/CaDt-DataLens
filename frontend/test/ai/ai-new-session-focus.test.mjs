// ai-new-session-focus.test.mjs —— app_control 的 ai_new_session 动作「后台新建 / focus 抢占」合同。
//
// bridgeNewSession 在 ai-panel.js 的大闭包里，node 无法直接实例化（依赖 Wails 后端与 DOM），
// 因此按项目 wiring 测试的惯例做源码级断言：锁住 focus 参数的三处接线（技能表 / main.js 分发 /
// bridgeNewSession 实现）与后台路径的关键不变量（不切 currentSession、不碰 UI、走 startSessionTurn）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = read('../../src/ai/ai-panel.js');
const main = read('../../src/main.js');
const constants = read('../../src/ai/core/ai-constants.js');

function sliceFunction(source, marker, nextMarker = '\n        bridge') {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const end = source.indexOf(nextMarker, start + marker.length);
    return source.slice(start, end < 0 ? undefined : end);
}

test('bridgeNewSession 解析 focus 参数，默认后台', () => {
    const fn = sliceFunction(panel, 'bridgeNewSession: async (opts2) => {');
    assert.match(fn, /const focus = !!\(opts2 && opts2\.focus\);/);
    // focus 分支必有 open(true)+newSession()（抢占），否则语义反了
    const focusBranch = fn.slice(fn.indexOf('if (focus) {'), fn.indexOf('// 后台路径'));
    assert.match(focusBranch, /open\(true\);/);
    assert.match(focusBranch, /newSession\(\);/);
    assert.match(focusBranch, /submitText\(message\)/);
    // 抢占路径也如实带出发送结果（sent），不能误报「已发送」
    assert.match(focusBranch, /const sent = message \? !!\(await submitText\(message\)\) : null;/);
    assert.match(focusBranch, /\{id: session\.id, title: session\.title, sent\}/);
});

test('后台路径：不打开面板、不切会话、不碰输入区，走 startSessionTurn', () => {
    const fn = sliceFunction(panel, 'bridgeNewSession: async (opts2) => {');
    const bg = fn.slice(fn.indexOf('// 后台路径'));
    // 后台路径不得出现抢占三件套
    assert.doesNotMatch(bg, /\bopen\(true\)/);
    assert.doesNotMatch(bg, /\bnewSession\(\)/);
    assert.doesNotMatch(bg, /\bsubmitText\(/);
    assert.doesNotMatch(bg, /setActiveSessionId\(/);
    // 必须经会话级内核起轮，且落盘 + 刷列表
    assert.match(bg, /createSessionData\(title \|\| undefined\)/);
    assert.match(bg, /sessions\.push\(session\)/);
    assert.match(bg, /persistSessions\(\)/);
    assert.match(bg, /startSessionTurn\(session, message\)/);
});

test('后台继承当前会话：createSessionData 走 inheritModelRef（读 currentSession，不切它）', () => {
    const fn = sliceFunction(panel, 'bridgeNewSession: async (opts2) => {');
    assert.match(fn, /createSessionData 继承面板当前会话的模型\/权限（inheritModelRef 读\s*\n?\s*\/\/?\s*currentSession/);
    // createSessionData 内部确实调用 inheritModelRef（继承当前会话 pin 的模型）
    const create = sliceFunction(panel, 'function createSessionData(title, sessionOpts) {', '\n    function ');
    assert.match(create, /const inherited = inheritModelRef\(\);/);
    assert.match(create, /profileId: inherited\.profileId/);
    assert.match(create, /modelId: inherited\.modelId/);
});

test('main.js 透传 focus，note 区分后台/抢占', () => {
    const start = main.indexOf("case 'ai_new_session': {");
    assert.notEqual(start, -1);
    const body = main.slice(start, start + 700);
    assert.match(body, /const focus = p\.focus === true;/);
    assert.match(body, /bridgeNewSession\(\{title: p\.title, message: p\.message, focus\}\)/);
    assert.match(body, /focus \? '并已切到该会话' : '（后台运行，面板当前会话未变）'/);
    // note 按 sent 如实生成：发送失败时不说「已发送」
    assert.match(body, /else if \(session && session\.sent === false\) sendPart = '会话已建但消息发送失败（见面板错误提示）'/);
});

test('技能表声明 focus 参数与默认后台语义', () => {
    const line = constants.split('\n').find((l) => l.includes("'- ai_new_session"));
    assert.ok(line, '找不到技能表 ai_new_session 行');
    assert.match(line, /focus\?/);
    assert.match(line, /默认后台创建/);
    assert.match(line, /focus=true 才抢占面板/);
});
