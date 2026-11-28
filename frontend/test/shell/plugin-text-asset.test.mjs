// plugin-text-asset.test.mjs —— 插件文本资产解码层（shell/plugin-text-asset.js）。
// 钉住：data URL 形状、base64 解码的 UTF-8 正确性（中文不乱码）、大小闸、非 UTF-8 拒绝。

import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDataUrl, dataUrlToText, MAX_TEXT_ASSET_BYTES} from '../../src/shell/plugin-text-asset.js';

// 用 TextEncoder + btoa 造 Go 侧同款 data URL（UTF-8 安全 base64）
function dataUrl(text, mime = 'text/markdown') {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return 'data:' + mime + ';base64,' + btoa(bin);
}

test('decodeDataUrl：拆出 mime 与 base64', () => {
    const out = decodeDataUrl('data:text/markdown;base64,SGVsbG8=');
    assert.equal(out.mime, 'text/markdown');
    assert.equal(out.base64, 'SGVsbG8=');
});

test('decodeDataUrl：拒绝非 data URL / 非 base64 / 混入空白', () => {
    assert.throws(() => decodeDataUrl('hello'), /不是 data URL/);
    assert.throws(() => decodeDataUrl('data:text/plain,hello'), /不是 base64/);
    assert.throws(() => decodeDataUrl('data:text/plain;base64,SG VsbG8='), /载荷无效/);
    assert.throws(() => decodeDataUrl('data:text/plain;base64,SGVsbG8=\n'), /载荷无效/);
    // 空载荷合法（空文件的 base64 就是空串）
    assert.deepEqual(decodeDataUrl('data:text/plain;base64,'), {mime: 'text/plain', base64: ''});
});

test('dataUrlToText：ASCII 与中文都逐字还原（atob 直接当字符串会乱码）', () => {
    assert.equal(dataUrlToText(dataUrl('hello world')), 'hello world');
    const zh = '# 技能\n\n执行完整写章流程。中文不能乱码。';
    assert.equal(dataUrlToText(dataUrl(zh)), zh);
    assert.equal(dataUrlToText(dataUrl('第一行\n第二行\t制表')), '第一行\n第二行\t制表');
});

test('dataUrlToText：超过 1 MiB 明确报错', () => {
    const big = 'a'.repeat(MAX_TEXT_ASSET_BYTES + 1);
    assert.throws(() => dataUrlToText(dataUrl(big)), /过大/);
    // 自定义上限
    assert.throws(() => dataUrlToText(dataUrl('abcdef'), 3), /过大/);
    assert.equal(dataUrlToText(dataUrl('abcdef'), 6), 'abcdef');
});

test('dataUrlToText：非 UTF-8 字节（二进制被误当文本读）报错，不给乱码', () => {
    // 0xFF 0xFE 不是合法 UTF-8
    const bin = String.fromCharCode(0xff, 0xfe, 0x41);
    assert.throws(() => dataUrlToText('data:image/png;base64,' + btoa(bin)), /不是合法 UTF-8/);
});

test('dataUrlToText：空文本合法', () => {
    assert.equal(dataUrlToText(dataUrl('')), '');
});
