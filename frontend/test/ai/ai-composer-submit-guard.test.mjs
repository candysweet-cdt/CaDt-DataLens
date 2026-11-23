// AI 输入区「一次 Enter 发出两条消息」修复的接线护栏。
//
// 现象（2026-11 实测）：一次轻按 Enter 偶尔发出两条相同的用户消息，第一条 assistant 显示
// 「已停止生成」、第二条正常处理。根因是提交链路没有防重入——一次按键派发两次 keydown
// （键盘重复 / 中文输入法确认候选词的双事件）时，submitText → startSessionTurn 从入口忙检查
// 到 attachStream 注册流之间有一串 await（whenIdle / 回合租约 / 上下文组装），窗口内流还没
// 注册、输入框也还没清空（清空在 onStarted），第二次会读到同样的文本再起一轮；两个
// startSessionTurn 抢注册流，落败方的占位 assistant 被守卫标成 stopped。
//
// composer 是闭包 + DOM，node 里派发不了按键，按项目惯例（见 ai-composer-esc.test.mjs）用
// 源码断言钉住三处接线：submitInFlight 锁覆盖异步全程 / 直发分支 return submitText / Enter 挡 repeat。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('ai-composer.js：submitFromComposer 有 submitInFlight 防重入锁，且在取文本前就拦下', () => {
    const src = read('ai/chat/ai-composer.js');
    assert.match(src, /let submitInFlight = false;/,
        '必须有 submitInFlight 锁——只靠忙检查挡不住 await 窗口内的第二次提交');
    const fn = src.match(/function submitFromComposer\(ev\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'submitFromComposer 应存在');
    const guardAt = fn[0].indexOf('if (submitInFlight) return;');
    const sendAt = fn[0].indexOf('sendComposerMessage(text, ev)');
    assert.ok(guardAt > 0, '入口必须检查 submitInFlight');
    assert.ok(sendAt > 0, '直发分支应调用 sendComposerMessage');
    assert.ok(guardAt < sendAt, '锁检查必须先于提交调用');
});

test('ai-composer.js：锁在 finally 里释放，同步抛错也不能把输入区永久卡死', () => {
    const src = read('ai/chat/ai-composer.js');
    const fn = src.match(/function submitFromComposer\(ev\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'submitFromComposer 应存在');
    // 锁必须包在 try/finally 里：await 抛错也要走 finally 置回 false，否则下一次提交永远进不来。
    assert.match(fn[0], /try \{[\s\S]*?await sendComposerMessage\(text, ev\);[\s\S]*?\} finally \{[\s\S]*?submitInFlight = false;/,
        '锁释放要在 finally 中，覆盖正常与异常两条路径');
    assert.match(fn[0], /submitInFlight = true;/, '提交前上锁');
});

test('ai-composer.js：直发分支 return submitText 的 Promise，锁才能持有到起轮清空输入区', () => {
    const src = read('ai/chat/ai-composer.js');
    const fn = src.match(/function sendComposerMessage\(text, ev\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'sendComposerMessage 应存在');
    // 不 return 的话 Promise 立刻 resolve，锁在 startSessionTurn 的 await 窗口里就放了，
    // 双发照样能发生——这是修复的关键一半。
    assert.match(fn[0], /return submitText\(text\);/, '直发分支必须把 submitText 的 Promise 交回去');
});

test('ai-composer.js：Enter 处理挡掉键盘重复（e.repeat），先于发送判定', () => {
    const src = read('ai/chat/ai-composer.js');
    const fn = src.match(/function handleComposerKey\(e\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'handleComposerKey 应存在');
    const repeatAt = fn[0].indexOf('if (e.repeat) return;');
    const enterAt = fn[0].indexOf("if (e.key !== 'Enter') return;");
    const sendAt = fn[0].indexOf('submitFromComposer();');
    assert.ok(repeatAt > 0, '必须挡 e.repeat——按住 Enter 的重复事件不是新的发送意图');
    assert.ok(enterAt > 0, 'Enter 分支应存在');
    assert.ok(sendAt > 0, '发送调用应存在');
    assert.ok(enterAt < repeatAt, 'repeat 判定应在确认是 Enter 之后');
    assert.ok(repeatAt < sendAt, 'repeat 判定必须先于发送');
});

test('ai-panel.js：输入框 keydown 只绑定一处，不做重复接线', () => {
    const src = read('ai/ai-panel.js');
    const hits = [...src.matchAll(/el\.input\.addEventListener\('keydown'/g)];
    assert.equal(hits.length, 1, '输入框 keydown 只能挂一处——重复绑定本身就是双发来源');
    assert.match(src, /el\.input\.addEventListener\('keydown', \(e\) => \{\s*if \(handlePasteCapsuleKey\(e\)\) return;\s*handleComposerKey\(e\);/,
        'keydown 包装层应先给胶囊删除、再交给 composer');
});
