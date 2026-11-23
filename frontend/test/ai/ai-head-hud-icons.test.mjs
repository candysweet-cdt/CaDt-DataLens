// ai-head-hud 后台作业状态图标护栏：停止必须是 stop 字形（实心方块，与输入区停止按钮同源），
// 不能退回 || 暂停——后者读作「暂停、还能继续」，而后台作业停下就结束了。
// 同时锁住「退出码参与成功/失败判定」与失败态颜色，防止再退回「非 0 退出也画绿勾」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const hud = readFileSync(new URL('../../src/ai/agent/ai-head-hud.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');

test('已停止用 stop 字形，不再与暂停共用图标', () => {
    assert.match(hud, /state === 'stopped'\) return iconSvg\('stop', 12\)/);
    assert.doesNotMatch(hud, /state === 'stopped' \|\| state === 'notfound'/);
    assert.doesNotMatch(hud, /iconSvg\('pause', 12\)/);
});

test('退出码参与图标：0 成功勾、非 0 失败叉', () => {
    assert.match(hud, /state === 'exited'\) return Number\(code\) \? iconSvg\('close', 12\) : iconSvg\('check', 12\)/);
});

test('查不到的作业用中性信息图标（不是任何终态图标）', () => {
    assert.match(hud, /state === 'notfound'\) return iconSvg\('info', 12\)/);
});

test('非 0 退出的行挂 failed 类，样式表用红色', () => {
    assert.match(hud, /failedExit \? 'failed' : state/);
    assert.match(css, /\.ai-status-failed \{ color: var\(--red\); \}/);
});

test('窄宽度先收「变更」徽标：中等宽度档隐藏它，徽标本身不折行', () => {
    // 用户实测：420–560px 区间「变更 11」被挤成「变 / 更 11」两行。修法是两道：
    // ① .ai-chip-btn 加 white-space:nowrap 永不折行；
    // ② 中等宽度（ai-head-tight）先整块收起徽标，改动汇总在消息流轮尾卡片仍可见。
    assert.match(css, /\.ai-chip-btn \{[^}]*white-space:\s*nowrap/s, '徽标必须禁止折行');
    assert.match(hud, /classList\.toggle\('ai-head-tight',\s*width < 560\)/, 'ResizeObserver 必须在中等宽度加 tight 档');
    assert.match(css, /\.ai-head-tight #ai-changes \{ display: none; \}/, 'tight 档必须收起变更徽标');
});
