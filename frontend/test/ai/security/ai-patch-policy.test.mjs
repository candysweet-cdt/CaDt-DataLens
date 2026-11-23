// ai-patch-policy 纯函数测试：完全权限下是否弹补丁审批卡、最后一条用户消息取文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {patchAllowApply, lastUserTextOf} from '../../../src/ai/security/ai-patch-policy.js';

const user = (text) => ({role: 'user', content: text});
const assistant = (text) => ({role: 'assistant', content: text});

test('lastUserTextOf：取最后一条用户消息，跳过 assistant/tool', () => {
    const messages = [user('第一句'), assistant('回'), user('第二句'), assistant('再回')];
    assert.equal(lastUserTextOf(messages), '第二句');
    // 多段内容（图片 + 文本）拼接
    assert.equal(lastUserTextOf([{role: 'user', content: [{type: 'text', text: '看图'}, {type: 'image'}]}]), '看图');
    assert.equal(lastUserTextOf([]), '');
    assert.equal(lastUserTextOf(null), '');
    assert.equal(lastUserTextOf([assistant('只有助手')]), '');
});

test('patchAllowApply：模型显式 apply:false 永远只产出文件', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        assert.equal(patchAllowApply({apply: false}, scope, '应用这个补丁'), false, scope);
    }
});

test('patchAllowApply：非完全权限档保持弹卡', () => {
    for (const scope of ['edit', 'auto']) {
        assert.equal(patchAllowApply({apply: true}, scope, ''), true, scope);
        assert.equal(patchAllowApply({}, scope, '随便改'), true, scope);
    }
});

test('patchAllowApply：完全权限档缺省看用户最近一句（应用措辞或短肯定句）', () => {
    const cases = [
        ['把补丁应用上去', true],
        ['先给 patch，然后 apply 一下', true],
        ['这个补丁合入吧', true],
        ['可以', true],        // 事先同意，补丁生成后它就是最后一句（2026-11-18 真机）
        ['好的', true],
        ['没问题', true],
        ['ok', true],
        ['好的，就这么办', true],
        ['我不同意这个方案', false], // 负向后顾：不/没 前缀不算同意
        ['给我一份 patch 我要转给同事', false], // 要分享 → 只产出文件
        ['顺手改掉就行', false],
        ['', false],
    ];
    for (const [text, want] of cases) {
        assert.equal(patchAllowApply({}, 'full', text), want, text);
    }
    assert.equal(patchAllowApply({}, 'full', null), false);
});

test('patchAllowApply：apply:true 强制弹卡（用户事先同意时的确定性出口）', () => {
    // 旧实现只认 apply:false，true 被忽略——模型带 true 重试也弹不出卡（2026-11-18 真机）
    for (const text of ['可以', '给我一份 patch 我要转给同事', '', '顺手改掉就行']) {
        assert.equal(patchAllowApply({apply: true}, 'full', text), true, text);
    }
    // false 仍优先：显式「不要弹」压过一切
    assert.equal(patchAllowApply({apply: false}, 'full', '应用这个补丁'), false);
});

test('patchAllowApply：隔离工作区开启时全档必弹（apply=false 仍只产出文件）', () => {
    // 主根只读闸下 propose_patch 是唯一能写主根的通道——回灌必须过人工审阅，
    // 与 worktree_manage(export) 的回灌卡同一条红线（2026-11-18 用户决策）
    for (const scope of ['edit', 'auto', 'full']) {
        assert.equal(patchAllowApply({}, scope, '', true), true, scope);
        assert.equal(patchAllowApply({}, scope, '给我一份 patch 我要转给同事', true), true, scope);
    }
    assert.equal(patchAllowApply({apply: false}, 'full', '应用这个补丁', true), false);
    // worktreeActive=false 走原逻辑：full 缺省不弹
    assert.equal(patchAllowApply({}, 'full', '', false), false);
});
