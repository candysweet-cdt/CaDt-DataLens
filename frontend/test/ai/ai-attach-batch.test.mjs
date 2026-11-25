// ai-attach-batch.test.mjs：AI 面板批量附件（拖入多文件）——去重/汇总的纯逻辑 + 接线护栏。
//
// 纯逻辑部分直接在 node 跑；「拖放按钮到 composer」的接线（面板转发、暴露给 main.js）用源码断言钉住，
// 与 ai-composer-esc.test.mjs 同款做法（DOM 事件在 node 里派发不了）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {dedupeAttachPaths, attachSummary} from '../../src/ai/chat/ai-attach-batch.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('dedupeAttachPaths：批内与已有附件一起去重，保序、大小写不敏感、反斜杠归一', () => {
    const out = dedupeAttachPaths(
        ['D:\\a.png', 'd:/A.PNG', '', 'D:\\b.md', null],
        ['d:\\b.MD'],
    );
    assert.deepEqual(out.paths, ['D:\\a.png']);
    assert.equal(out.skipped, 4, '重复 1 + 空 1 + 已有 1 + null 1');
});

test('dedupeAttachPaths：没有已有附件时全部保留顺序', () => {
    const out = dedupeAttachPaths(['a.txt', 'b.png', 'c.mp4']);
    assert.deepEqual(out.paths, ['a.txt', 'b.png', 'c.mp4']);
    assert.equal(out.skipped, 0);
});

test('attachSummary：单条成功不打扰，多条或确有跳过才提示', () => {
    assert.equal(attachSummary(1, 0), '');
    assert.equal(attachSummary(0, 0), '');
    assert.equal(attachSummary(3, 0), '已附加 3 个文件');
    assert.equal(attachSummary(2, 5), '已附加 2 个文件，跳过 5 个');
    assert.equal(attachSummary(0, 2), '已附加 0 个文件，跳过 2 个');
});

test('接线：composer 提供 attachPaths（顺序附加 / 触上限后同类静默跳过 / 汇总一次）', () => {
    const src = read('ai/chat/ai-composer.js');
    assert.match(src, /import \{dedupeAttachPaths, attachSummary\} from '\.\/ai-attach-batch\.js';/,
        '去重与汇总走单一实现，不在 composer 里重写');
    const fn = src.match(/async function attachPaths\(paths, opts\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'attachPaths 应存在');
    assert.match(fn[0], /dedupeAttachPaths\(paths, existing\)/, '先按路径去重（含已有附件）');
    assert.match(fn[0], /if \(blocked\.has\(kind\)\) \{/, '某类触上限后同批同类静默跳过，不再逐条报错');
    assert.match(fn[0], /const summary = attachSummary\(attached, skipped\);/, '结束只汇总一次');
    assert.match(src, /\n        attachPaths,/, 'attachPaths 必须导出给面板');
    // 图片 / 视频附件带 path：批内去重靠它（粘贴来的图片没有 path，不影响）
    assert.match(src, /prepared\.path = path;/, '按路径构造的图片附件要记 path 供去重');
    assert.match(src, /return \{kind: 'video', label: payload\.name, path, \.\.\.payload\};/, '视频附件同样记 path');
});

test('接线：面板转发 attachPaths、main.js 处理群聊视图与自动开面板', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /const attachPaths = \(\.\.\.args\) => composerMod\.attachPaths\(\.\.\.args\);/, '经 composerMod 惰性转发');
    assert.match(panel, /\n        attachPaths,/, '对外暴露（main.js 的拖放路由要用）');

    const main = read('main.js');
    assert.match(main, /function attachPathsToAI\(paths\) \{/, 'main.js 有拖放→附件的入口');
    assert.match(main, /aiPanel\.open\(true\);/, '面板关着时先打开');
    assert.match(main, /aiPanel\.attachPaths\(list\)/, '走面板暴露的批量附加');
    assert.match(main, /ai-group-mode/, '群聊视图（#ai-panel.ai-group-mode）单独判定');
});
