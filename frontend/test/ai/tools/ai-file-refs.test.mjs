// ai-file-refs.test.mjs：文件引用识别纯函数的表驱动测试（与源码同目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFileRefChip, parseFileRef, pickOpenFileMatch} from '../../../src/ai/tools/ai-file-refs.js';

// 最简 inline code 桩：够 applyFileRefChip 用的 dataset / classList 两面
function stubCode(connected) {
    const added = [];
    return {
        dataset: {},
        isConnected: !!connected,
        classList: {add(name) { added.push(name); }},
        addedClasses: added,
    };
}

test('parseFileRef：可带 :行[:列] 后缀的路径', () => {
    assert.deepEqual(parseFileRef('src/main.js'), {path: 'src/main.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('frontend/src/ai/model-catalog.js'), {path: 'frontend/src/ai/model-catalog.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('src/main.js:42'), {path: 'src/main.js', line: 42, col: 0});
    assert.deepEqual(parseFileRef('src/main.js:42:8'), {path: 'src/main.js', line: 42, col: 8});
    assert.deepEqual(parseFileRef('model-catalog.js'), {path: 'model-catalog.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('../../src/ai/src/main.js'), {path: '../../src/ai/src/main.js', line: 0, col: 0});
});

test('parseFileRef：:起-止 行区间后缀取起始行，lineEnd 仅区间命中时出现', () => {
    // 截图回归：AI 描述函数跨行写的区间后缀要能升级成芯片
    assert.deepEqual(parseFileRef('frontend/src/ai/ai-tool-defs.js:65-84'),
        {path: 'frontend/src/ai/ai-tool-defs.js', line: 65, col: 0, lineEnd: 84});
    assert.deepEqual(parseFileRef('src/main.js:42-56'), {path: 'src/main.js', line: 42, col: 0, lineEnd: 56});
    assert.deepEqual(parseFileRef('model-catalog.js:10-20'), {path: 'model-catalog.js', line: 10, col: 0, lineEnd: 20});
    assert.deepEqual(parseFileRef('D:\\proj\\src\\main.js:42-56'), {path: 'D:/proj/src/main.js', line: 42, col: 0, lineEnd: 56});
    // 退化区间 :42-42 归一成单行 :42（不出现 lineEnd 键）
    assert.deepEqual(parseFileRef('src/main.js:42-42'), {path: 'src/main.js', line: 42, col: 0});
    // 回归（scheme 误判）：裸文件名+行号/区间曾被 SCHEME_RE 当成 URL scheme 整体拒绝，
    // 导致 pickOpenFileMatch 对带行号的 basename 永远轮不到；scheme 检查已挪到后缀剥离之后
    assert.deepEqual(parseFileRef('model-catalog.js:42'), {path: 'model-catalog.js', line: 42, col: 0});
    assert.deepEqual(parseFileRef('model-catalog.js:10-20'), {path: 'model-catalog.js', line: 10, col: 0, lineEnd: 20});
});

test('parseFileRef：倒序 / 超纲区间不命中', () => {
    // 倒序区间视为笔误，直接拒绝（保持普通 code，不做静默换序）
    assert.equal(parseFileRef('src/main.js:84-65'), null);
    // 区间后再带列号的超纲形状不命中（LINE_COL_RE 抢走 :8，剩下的 -56 结尾过不了扩展名检查）
    assert.equal(parseFileRef('src/main.js:42-56:8'), null);
    // 数字位数超限（1–7 位）不命中
    assert.equal(parseFileRef('src/main.js:12345678-90'), null);
    assert.equal(parseFileRef('src/main.js:42-12345678'), null);
    // 普通文件名含 -数字 不误伤（没有冒号前缀）
    assert.deepEqual(parseFileRef('build-2026.log'), {path: 'build-2026.log', line: 0, col: 0});
});

test('parseFileRef：Windows 路径与反斜杠归一', () => {
    assert.deepEqual(parseFileRef('D:/proj/src/main.js'), {path: 'D:/proj/src/main.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('D:\\proj\\src\\main.js'), {path: 'D:/proj/src/main.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('D:\\proj\\src\\main.js:42'), {path: 'D:/proj/src/main.js', line: 42, col: 0});
});

test('parseFileRef：拒绝 URL / 通配 / 空白 / 数字 / 无扩展名', () => {
    assert.equal(parseFileRef('https://example.com/a.js'), null);
    assert.equal(parseFileRef('http://x'), null);
    assert.equal(parseFileRef('mailto:a@b.c'), null);
    assert.equal(parseFileRef('src/*.js'), null);
    assert.equal(parseFileRef('src / main.js'), null);
    assert.equal(parseFileRef(''), null);
    assert.equal(parseFileRef(null), null);
    assert.equal(parseFileRef('v1.2'), null);
    assert.equal(parseFileRef('1.5'), null);
    assert.equal(parseFileRef('README'), null);
    assert.equal(parseFileRef('src/'), null);
    assert.equal(parseFileRef('foo.bar/baz'), null);
    assert.equal(parseFileRef('src/main.js:abc'), null);
    assert.equal(parseFileRef('src/main.js:'), null);
});

test('parseFileRef：超长路径不命中', () => {
    assert.equal(parseFileRef('a/'.repeat(160) + 'b.js'), null);
});

test('pickOpenFileMatch：裸文件名按打开标签页匹配（大小写不敏感、反斜杠兼容）', () => {
    const open = ['D:\\Ws\\frontend\\src\\ai\\model-catalog.js', 'D:/Ws/README.md', ''];
    assert.equal(pickOpenFileMatch(parseFileRef('model-catalog.js'), open), 'D:\\Ws\\frontend\\src\\ai\\model-catalog.js');
    assert.equal(pickOpenFileMatch(parseFileRef('MODEL-CATALOG.JS'), open), 'D:\\Ws\\frontend\\src\\ai\\model-catalog.js');
    assert.equal(pickOpenFileMatch(parseFileRef('readme.md'), open), 'D:/Ws/README.md');
    // 带目录的引用不走 basename 匹配（交给工作区相对解析）
    assert.equal(pickOpenFileMatch(parseFileRef('src/ai/model-catalog.js'), open), '');
    assert.equal(pickOpenFileMatch(parseFileRef('missing.js'), open), '');
    assert.equal(pickOpenFileMatch(null, open), '');
});

// 回归：整屏重放时 renderMessage 先建游离 wrap 再 append，而 stat 结果缓存命中时升级是
// **同步**调用——早期版本在 isConnected=false 时直接 return，且 state 停在 pending 不再重试，
// 于是「第一次进对话链接正常，切走再切回退化成普通代码」。这里钉死「游离节点也上 chip」。
test('applyFileRefChip：未挂载的节点同样升级（缓存命中同步路径）', () => {
    const code = stubCode(false);
    assert.equal(code.isConnected, false, '桩要模拟「还没 append」');
    applyFileRefChip(code, 'D:/Ws/frontend/src/core/wordcloud-render.js',
        parseFileRef('frontend/src/core/wordcloud-render.js:215'));
    assert.equal(code.dataset.aiRefState, 'file');
    assert.equal(code.dataset.aiRefPath, 'D:/Ws/frontend/src/core/wordcloud-render.js');
    assert.equal(code.dataset.aiRefLine, '215');
    assert.equal(code.dataset.aiRefCol, '0');
    assert.deepEqual(code.addedClasses, ['ai-file-ref']);
    assert.equal(code.dataset.tip, 'D:/Ws/frontend/src/core/wordcloud-render.js · 第 215 行');
});

test('applyFileRefChip：tooltip 带行与列，缺参数不抛', () => {
    const code = stubCode(true);
    applyFileRefChip(code, 'D:/a.js', {line: 12, col: 8});
    assert.equal(code.dataset.tip, 'D:/a.js · 第 12 行 第 8 列');
    // 区间引用：tooltip 显示起止行，dataset 仍只带起始行（点击行为不变）
    const ranged = stubCode(true);
    applyFileRefChip(ranged, 'D:/a.js', parseFileRef('src/main.js:42-56'));
    assert.equal(ranged.dataset.aiRefLine, '42');
    assert.equal(ranged.dataset.aiRefCol, '0');
    assert.equal(ranged.dataset.tip, 'D:/a.js · 第 42–56 行');
    const noLine = stubCode(true);
    applyFileRefChip(noLine, 'D:/a.js', {line: 0, col: 0});
    assert.equal(noLine.dataset.tip, 'D:/a.js');
    assert.equal(noLine.dataset.aiRefLine, '0');
    // 防御：没有节点 / 没有 dataset 都不炸（虚拟文档、测试桩可能没有 dataset）
    assert.doesNotThrow(() => applyFileRefChip(null, 'x', null));
    assert.doesNotThrow(() => applyFileRefChip({}, 'x', null));
});
