// ai-plugin-context-merge.test.mjs —— 插件上下文合并（稳定块 + 按轮 provider）的纯逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePluginContextText} from '../../src/ai/ai-plugin-context-merge.js';

test('两个模块都缺席时返回空', () => {
    assert.deepEqual(mergePluginContextText(null, null, {}), {text: '', count: 0, truncated: false});
});

test('只接稳定块时原样透传', () => {
    const stable = {renderPluginContextBlocks: (ctx) => {
        assert.equal(ctx.workspace, 'D:/ws');
        assert.equal(ctx.sessionId, 's1');
        assert.equal(ctx.origin, 'prompt');
        return {text: '稳定知识', count: 1, truncated: false};
    }};
    const out = mergePluginContextText(stable, null, {workspace: 'D:/ws', sessionId: 's1'});
    assert.equal(out.text, '稳定知识');
    assert.equal(out.count, 1);
    assert.equal(out.truncated, false);
});

test('稳定块 + provider 拼接，count/truncated 合并', () => {
    const stable = {renderPluginContextBlocks: () => ({text: '稳定', count: 2, truncated: false})};
    const provider = {renderContextProviders: () => ({text: '按轮任务书', count: 1, truncated: true})};
    const out = mergePluginContextText(stable, provider, {workspace: 'D:/ws'});
    assert.equal(out.text, '稳定\n按轮任务书');
    assert.equal(out.count, 3);
    assert.equal(out.truncated, true);
});

test('provider 抛错只跳过它，稳定块仍在', () => {
    const stable = {renderPluginContextBlocks: () => ({text: '稳定', count: 1, truncated: false})};
    const provider = {renderContextProviders: () => { throw new Error('boom'); }};
    const out = mergePluginContextText(stable, provider, {});
    assert.equal(out.text, '稳定');
    assert.equal(out.count, 1);
});

test('provider 返回空文本时不计 count', () => {
    const stable = {renderPluginContextBlocks: () => ({text: '', count: 0, truncated: false})};
    const provider = {renderContextProviders: () => ({text: '   ', count: 1, truncated: false})};
    assert.equal(mergePluginContextText(stable, provider, {}).count, 0);
});
