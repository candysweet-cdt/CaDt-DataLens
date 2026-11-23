// ai-audio-transcode 测试：WAV 头字段、声道交错、采样裁剪与直传扩展名判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWav16, isDirectAsrPath} from '../../../src/ai/tools/ai-audio-transcode.js';

const readString = (view, offset, length) => {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
    return out;
};

test('encodeWav16：44 字节头与 PCM 参数正确', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buffer = encodeWav16([samples], 16000);
    const view = new DataView(buffer);
    assert.equal(readString(view, 0, 4), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 5 * 2);
    assert.equal(readString(view, 8, 4), 'WAVE');
    assert.equal(readString(view, 12, 4), 'fmt ');
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 16000);
    assert.equal(view.getUint32(28, true), 32000);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(readString(view, 36, 4), 'data');
    assert.equal(view.getUint32(40, true), 10);
    assert.equal(view.byteLength, 54);
    assert.equal(view.getInt16(44, true), 0);
    assert.equal(view.getInt16(46, true), Math.round(0.5 * 0x7fff));
    assert.equal(view.getInt16(48, true), Math.round(-0.5 * 0x8000));
    assert.equal(view.getInt16(50, true), 0x7fff);
    assert.equal(view.getInt16(52, true), -0x8000);
});

test('encodeWav16：双声道按帧交错', () => {
    const left = new Float32Array([1, 0]);
    const right = new Float32Array([0, 1]);
    const view = new DataView(encodeWav16([left, right], 16000));
    assert.equal(view.getUint16(22, true), 2);
    assert.equal(view.getUint32(28, true), 64000);
    assert.equal(view.getInt16(44, true), 0x7fff);
    assert.equal(view.getInt16(46, true), 0);
    assert.equal(view.getInt16(48, true), 0);
    assert.equal(view.getInt16(50, true), 0x7fff);
});

test('encodeWav16：越界采样被裁剪，非法输入报错', () => {
    const view = new DataView(encodeWav16([new Float32Array([2, -2])], 16000));
    assert.equal(view.getInt16(44, true), 0x7fff);
    assert.equal(view.getInt16(46, true), -0x8000);
    assert.throws(() => encodeWav16([], 16000));
    assert.throws(() => encodeWav16([new Float32Array([0, 1]), new Float32Array([0])], 16000), /不一致/);
});

test('isDirectAsrPath：只有 wav / ogg / opus 直传', () => {
    assert.equal(isDirectAsrPath('C:/a/b.wav'), true);
    assert.equal(isDirectAsrPath('voice.OGG'), true);
    assert.equal(isDirectAsrPath('x.opus'), true);
    assert.equal(isDirectAsrPath('x.mp3'), false);
    assert.equal(isDirectAsrPath('x.m4a'), false);
    assert.equal(isDirectAsrPath('noext'), false);
});
