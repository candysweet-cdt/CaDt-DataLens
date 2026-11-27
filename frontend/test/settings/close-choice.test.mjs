// 关窗三选一确认框护栏（ask 模式，2026-11-29）：点 X 弹「取消 / 退出应用 / 最小化到托盘」
// +「不再询问」。钉住四件事：事件接线、三按钮回调落点、不再询问走统一落盘通道、
// 对话框进家族栈（Esc / 遮罩收口）。纯源码断言，与项目其余 UI 护栏同风格。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const mainSrc = read('main.js');
const wmSrc = read('writing/writing-mode.js');
const dialogsSrc = read('settings/settings-dialogs.js');
const scopeSrc = read('core/event-scope.js');

// 截到下一个函数标记（而非靠缩进匹配闭合 `}`——CRLF 下内层 4 空格 `}` 会提前命中）。
function sliceTo(src, from, to) {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, `截取失败：${from} → ${to}`);
    return src.slice(a, b);
}

test('对话框 DOM：三按钮 + 不再询问复选框齐备', () => {
    assert.ok(html.includes('id="dlg-close-confirm"'), '缺 #dlg-close-confirm');
    for (const id of ['btn-close-cancel', 'btn-close-exit', 'btn-close-tray', 'close-confirm-remember']) {
        assert.ok(html.includes('id="' + id + '"'), '缺按钮/复选框 #' + id);
    }
    assert.ok(html.includes('最小化到托盘后，Agent 和后台任务会继续运行'), '正文文案缺失');
});

test('close-choice 事件接线：window 作用域 + 前端监听', () => {
    assert.match(scopeSrc, /'close-choice': 'window'/, 'close-choice 必须按窗口消费');
    assert.ok(mainSrc.includes("appEvents.onWindow('close-choice'"), 'main.js 缺 close-choice 处理器');
});

test('三按钮回调：退出走 ForceQuitAll，托盘走 MinimizeToTray，不再询问走 applySettings', () => {
    const body = sliceTo(mainSrc, "appEvents.onWindow('close-choice'", "appEvents.onWindow('confirm-close'");
    assert.match(body, /backend\.ForceQuitAll/, '退出应用应调 ForceQuitAll（退出整个应用）');
    assert.match(body, /backend\.MinimizeToTray/, '最小化到托盘应调 MinimizeToTray');
    assert.match(body, /rememberClose\(remember, 'exit'\)/, '退出分支要处理「不再询问」');
    assert.match(body, /rememberClose\(remember, 'tray'\)/, '托盘分支要处理「不再询问」');
    // helper 把 closeAction 写回并 applySettings（统一落盘/广播通道）
    const helper = sliceTo(mainSrc, 'const rememberClose =', "appEvents.onWindow('close-choice'");
    assert.match(helper, /settings\.closeAction = value/, '不再询问应写 settings.closeAction');
    assert.match(helper, /applySettings\(\)/, '不再询问应 applySettings 落盘');
});

test('openCloseConfirmDialog 与家族栈：独立函数、三回调、入栈', () => {
    const body = sliceTo(wmSrc, 'function openCloseConfirmDialog(', 'function submitCloseConfirm(');
    assert.match(body, /openDialogEl\(/, '对话框必须经 openDialogEl 进 overlay-stack 家族');
    assert.match(wmSrc, /function submitCloseConfirm\(choice\)/, '缺统一收口函数');
    // 家族清单三处都要含 closeConfirm（familyDlgList / openDialogEl 隐藏兄弟 / closeTopDialog）
    assert.equal((dialogsSrc.match(/elsDialogs\.closeConfirm/g) || []).length >= 4, true,
        'closeConfirm 必须进对话框家族的清单/隐藏/收口');
});
