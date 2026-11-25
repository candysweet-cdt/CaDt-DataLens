// 滚动条护栏（规范见 docs/scrollbar-guidelines.md）：把「滚动条尺寸只有 --sb-unit 一个
// 数值旋钮、用途靠语义别名表达」变成机制，防止各处裸写 px 或私加写死的档位。
// 三条规则：
//   ① 四级令牌定义齐全，三个语义令牌都基于 --sb-unit；
//   ② 任何 ::-webkit-scrollbar 规则块的 width/height/border-radius 不得裸写 Npx（隐藏用的 0 不算）；
//   ③ 所有 --scrollbar-* 令牌（除基础尺度本身）都必须引用 var(--sb-unit)，
//      防止有人新增 --scrollbar-size-xs: 4px 这种写死档位绕过规则②。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(FRONTEND, 'src', 'style.css'), 'utf8');

test('滚动条尺寸令牌齐全且语义令牌基于 --sb-unit', () => {
    for (const token of ['--sb-unit', '--scrollbar-size', '--scrollbar-size-sm', '--scrollbar-thumb-radius']) {
        assert.match(css, new RegExp(token + '\\s*:'), `${token} 未在 style.css 定义`);
    }
    for (const token of ['--scrollbar-size', '--scrollbar-size-sm', '--scrollbar-thumb-radius']) {
        const m = css.match(new RegExp(token + '\\s*:\\s*([^;]+);'));
        assert.ok(m && m[1].includes('var(--sb-unit)'),
            `${token} 必须基于 var(--sb-unit)，不得写死数值`);
    }
});

test('滚动条伪元素块尺寸不得裸写 px（只能用语义令牌）', () => {
    const offenders = [];
    const blockRe = /([^{}]*::-webkit-scrollbar[^{}]*)\{([^}]*)\}/g;
    let m;
    while ((m = blockRe.exec(css))) {
        const selector = m[1].trim().replace(/\s+/g, ' ');
        if (/(?:width|height|border-radius)\s*:[^;]*\b\d+px\b/.test(m[2])) offenders.push(selector);
    }
    assert.deepEqual([...new Set(offenders)], [],
        '以下滚动条规则裸写了 px 尺寸，应改用 var(--scrollbar-size*) 令牌：\n' + offenders.join('\n'));
});

test('不得新增写死的 --scrollbar-* 档位令牌', () => {
    const offenders = [];
    const tokenRe = /(--scrollbar-[\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = tokenRe.exec(css))) {
        const [, token, value] = m;
        if (!value.includes('var(--sb-unit)')) offenders.push(token + ': ' + value.trim());
    }
    assert.deepEqual(offenders, [],
        '所有 --scrollbar-* 令牌都必须基于 var(--sb-unit)（唯一数值旋钮），不得写死：\n' + offenders.join('\n'));
});

test('会话列表滚动条只在 hover 列表时显示，且所有主题一致', () => {
    assert.match(css, /\.ai-session-list \{\s*scrollbar-color:\s*transparent transparent;\s*\}/);
    assert.match(css, /\.ai-session-list::-webkit-scrollbar-thumb \{\s*background:\s*transparent;/);
    assert.match(css, /\.ai-session-list:hover \{\s*scrollbar-color:\s*var\(--scroll-thumb\) transparent;\s*\}/);
    assert.match(css, /\.ai-session-list:hover::-webkit-scrollbar-thumb \{\s*background:\s*var\(--scroll-thumb\);\s*\}/);
});
