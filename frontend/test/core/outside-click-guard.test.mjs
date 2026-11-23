// 外点关闭护栏（2026-11-23 overlay-stack 支持 closeOnOutsideClick 后定）。
// 背景：外点关闭浮层的 document 级 pointerdown/mousedown 监听曾在 ~14 个模块各写一遍，
// 与 Esc/z-index 一起属「弹层三件套」，前两件已收口 overlay-stack，外点关闭也应走
// overlayStack.open({closeOnOutsideClick: true, anchors})。
//
// 本护栏扫 document 级 pointerdown/mousedown 监听里「点外部就 close 浮层」的特征
// （contains(e.target) + close），命中文件必须在白名单里。**新增浮层想变绿，正确做法是
// 用 overlayStack 的 closeOnOutsideClick，而不是加白名单**；白名单只登记确实无法进栈的存量
// （面板层叠上下文内自管、多个弹层共用一个监听、全屏视图状态机等），且必须写明原因。
// 白名单按文件计，新文件出现命中直接失败——只许减不许增。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir, {recursive: true, encoding: 'utf8'})) {
        if (name.replace(/\\/g, '/').endsWith('.js')) out.push(name.replace(/\\/g, '/'));
    }
    return out;
}

// 合理存量：无法进 overlay-stack 的外点关闭监听，写明原因，只许减不许增
const OUTSIDE_CLICK_WHITELIST = {
    'ai/group/ai-group-view.js': '群聊菜单/mention pop 在群聊视图 shell 层叠上下文内自管（非页面级浮层）',
    'ai/chat/ai-reminders.js': '提醒浮层是面板内全局单监听（初始化挂一次、按 hidden 判断），非每开一次挂一个',
    'ai/ai-panel.js': '用量弹层无栈条目、面板内自管（待迁移）；另 17895 处是消息选择等非关闭语义',
    'shell/contextmenu.js': '右键菜单需记录 lastPointerTarget 供动作判定，外点关闭只是其副作用之一',
    'shell/titlebar-git-branch.js': '项目/Git分支/运行配置三个标题栏弹层共用一个 document 监听，含 pin 状态判定',
    'reading/reading.js': '阅读模式是全屏视图状态机，设置浮层在其层叠上下文内自管',
};

// 外点关闭特征：监听回调里同时出现 contains(target) 与 close（关闭/收起/hide）
const OUTSIDE_CLOSE_RE = /addEventListener\('(?:pointerdown|mousedown)'[\s\S]{0,600}?\.contains\([\s\S]{0,300}?\b(?:close|hide|dismiss)[\w]*\(/i;

test('document 级外点关闭监听只允许在白名单里（新浮层请用 overlayStack.closeOnOutsideClick）', () => {
    const offenders = [];
    for (const rel of walkJs(SRC)) {
        if (rel.endsWith('.test.js')) continue;
        if (OUTSIDE_CLICK_WHITELIST[rel]) continue;
        const src = readFileSync(join(SRC, rel), 'utf8');
        // 只看 document 级监听（排除 el.addEventListener 的元素级监听）
        const docListeners = src.match(/document\.addEventListener\('(?:pointerdown|mousedown)'[\s\S]{0,700}?\}\);/g) || [];
        if (docListeners.some((chunk) => OUTSIDE_CLOSE_RE.test(chunk))) offenders.push(rel);
    }
    assert.deepEqual(offenders, [],
        '以下文件写了 document 级外点关闭监听（应改用 overlayStack.open({closeOnOutsideClick:true})，或登记白名单并写明原因）：\n' +
        offenders.join('\n'));
});

test('白名单里的文件都真实存在（改名/迁移后清掉对应条目）', () => {
    const missing = Object.keys(OUTSIDE_CLICK_WHITELIST).filter((rel) => {
        try { readFileSync(join(SRC, rel), 'utf8'); return false; } catch (e) { return true; }
    });
    assert.deepEqual(missing, [], '白名单里这些文件不存在，迁移完成后应清掉条目');
});
