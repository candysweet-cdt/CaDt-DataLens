import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyChapterTitle, parseCnNumeral, naturalLess, compareSortKeys,
    buildBookModel, flattenChapters, computeProgress, locateUnit,
    joinSoftLines, stripFrontMatter, normalizeBookKey, unitIdOf, parseUnitId,
    GROUP, minutesFor,
} from './reading-model.js';

// ---- parseCnNumeral ----

test('parseCnNumeral 中文数字', () => {
    assert.equal(parseCnNumeral('1'), 1);
    assert.equal(parseCnNumeral('0001'), 1);
    assert.equal(parseCnNumeral('一'), 1);
    assert.equal(parseCnNumeral('十'), 10);
    assert.equal(parseCnNumeral('十一'), 11);
    assert.equal(parseCnNumeral('二十一'), 21);
    assert.equal(parseCnNumeral('一百零三'), 103);
    assert.equal(parseCnNumeral('两'), 2);
    assert.equal(parseCnNumeral('〇'), 0);
    assert.equal(parseCnNumeral('一万二千'), 12000);
    assert.equal(parseCnNumeral('二十万'), 200000);
    assert.ok(Number.isNaN(parseCnNumeral('abc')));
    assert.ok(Number.isNaN(parseCnNumeral('')));
});

// ---- classifyChapterTitle ----

test('classifyChapterTitle 分组', () => {
    const cases = [
        ['第0卷 基本信息', GROUP.DETAIL, 0, true, true],
        ['第0000章-引言', GROUP.FRONT, 0, true, true],
        ['序章', GROUP.FRONT, 0, false, true],
        ['楔子', GROUP.FRONT, 0, false, true],
        ['第0012章-初遇微光', GROUP.MAIN, 12, true, true],
        ['第9章', GROUP.MAIN, 9, true, true],
        ['12. 番外-来路归途', GROUP.MAIN, 12, true, true],
        ['1. 基石时代', GROUP.MAIN, 1, true, true],
        ['尾声', GROUP.MAIN, 0, false, true],
        ['终章', GROUP.MAIN, 0, false, true],
        ['番外0001-来路归途', GROUP.EXTRA, 1, true, true],
        ['番外1 自我独白', GROUP.EXTRA, 1, true, true],
        ['番外卷 星落人间', GROUP.APPENDIX, 0, false, true],
        ['扩展卷 星火长明', GROUP.APPENDIX, 0, false, true],
        ['扩展章', GROUP.APPENDIX, 0, false, true],
        ['人物卷', GROUP.APPENDIX, 0, false, true],
        ['后记', GROUP.APPENDIX, 0, false, true],
        ['附录', GROUP.APPENDIX, 0, false, true],
        ['普通标题', GROUP.MAIN, 0, false, false],
    ];
    for (const [input, group, num, hasNum, ok] of cases) {
        const k = classifyChapterTitle(input);
        assert.equal(k.ok, ok, input + ' ok');
        if (!ok) continue;
        assert.equal(k.group, group, input + ' group');
        assert.equal(k.num, num, input + ' num');
        assert.equal(k.hasNum, hasNum, input + ' hasNum');
    }
});

// ---- naturalLess / 排序 ----

test('naturalLess 数字段按数值', () => {
    assert.ok(naturalLess('第2章', '第10章'));
    assert.ok(!naturalLess('第10章', '第2章'));
    assert.ok(naturalLess('abc', 'abd'));
    assert.ok(!naturalLess('相同', '相同'));
});

test('compareSortKeys 章节顺序', () => {
    const mk = (name) => {
        const k = classifyChapterTitle(name);
        return {group: k.group, num: k.num, hasNum: k.hasNum, title: name, rel: name};
    };
    const names = ['番外0002-乙', '尾声', '第10章', '第0卷 基本信息', '番外0001-甲', '第0001章-a', '扩展卷', '第0002章-b', '后记', '第0000章-引言', '第9章-c'];
    const sorted = names.map(mk).sort(compareSortKeys).map((k) => k.title);
    assert.deepEqual(sorted, [
        '第0卷 基本信息',
        '第0000章-引言',
        '第0001章-a', '第0002章-b', '第9章-c', '第10章', '尾声',
        '番外0001-甲', '番外0002-乙',
        '后记', '扩展卷',
    ]);
});

// ---- buildBookModel ----

function mockScan(files, profile) {
    return {root: 'D:/x/书', title: '书', author: '', intro: '', profile, confidence: 1, files, warnings: [], scanMs: 1};
}

test('buildBookModel file profile：文件即章 + 排序 + 详情页', () => {
    const scan = mockScan([
        {rel: '第0002章-再遇.md', name: '第0002章-再遇.md', ext: '.md', words: 100, headings: [{offset: 1, level: 1, title: '第0002章 再遇', words: 100}]},
        {rel: '第0000章-引言.md', name: '第0000章-引言.md', ext: '.md', words: 50, headings: [{offset: 1, level: 1, title: '第0000章 引言', words: 50}]},
        {rel: '番外0001-独白.md', name: '番外0001-独白.md', ext: '.md', words: 30, headings: [{offset: 1, level: 1, title: '番外1 自我独白', words: 30}]},
        {rel: '第0001章-初遇.md', name: '第0001章-初遇.md', ext: '.md', words: 80, headings: [{offset: 1, level: 1, title: '第0001章 初遇', words: 80}]},
    ], 'file');
    const model = buildBookModel(scan);
    assert.equal(model.profile, 'file');
    assert.ok(!model.detail);
    const titles = model.chapters.map((c) => c.title);
    assert.deepEqual(titles, ['第0000章 引言', '第0001章 初遇', '第0002章 再遇', '番外1 自我独白']);
    const flat = flattenChapters(model);
    assert.equal(flat[0].cumWords, 0);
    assert.equal(flat[1].cumWords, 50);
});

test('buildBookModel split profile：卷文件切章', () => {
    const scan = mockScan([
        {
            rel: '第1卷.md', name: '第1卷.md', ext: '.md', words: 500,
            headings: [
                {offset: 1, level: 2, title: '第1章 起', words: 100},
                {offset: 40, level: 2, title: '第2章 承', words: 200},
                {offset: 120, level: 2, title: '第3章 转', words: 200},
            ],
        },
        {
            rel: '第0卷 基本信息.md', name: '第0卷 基本信息.md', ext: '.md', words: 60,
            headings: [{offset: 1, level: 1, title: '基本信息', words: 60}],
        },
    ], 'split');
    const model = buildBookModel(scan);
    assert.equal(model.profile, 'split');
    assert.ok(model.detail, '第0卷 应识别为详情页');
    assert.equal(model.chapters.length, 3);
    assert.equal(model.chapters[0].title, '第1章 起');
    assert.equal(model.chapters[0].endOffset, 40);
    assert.equal(model.chapters[2].endOffset, Infinity);
    // 卷首语可渲染
    const vol = model.top.find((n) => n.title === '第1卷');
    assert.ok(vol.renderable, '卷文件本身可渲染（卷首语）');
});

test('buildBookModel 目录卷：正文/扩展章', () => {
    const scan = mockScan([
        {rel: '第0001章-a.md', name: '第0001章-a.md', ext: '.md', words: 10, headings: []},
        {rel: '扩展章/沈世安列传/x.md', name: 'x.md', ext: '.md', words: 10, headings: []},
        {rel: '扩展章/沈世安列传/y.md', name: 'y.md', ext: '.md', words: 10, headings: []},
        {rel: '番外0001-独白.md', name: '番外0001-独白.md', ext: '.md', words: 10, headings: []},
    ], 'file');
    const model = buildBookModel(scan);
    const kinds = model.top.map((n) => n.title);
    assert.deepEqual(kinds, ['第0001章-a', '番外0001-独白', '扩展章']);
    const vol = model.top[2];
    assert.equal(vol.kind, 'volume');
    assert.equal(vol.children.length, 1);
    assert.equal(vol.children[0].title, '沈世安列传');
    assert.equal(model.chapters.length, 4);
});

test('buildBookModel 番外卷 split 兜底', () => {
    const scan = mockScan([
        {
            rel: '番外卷 星落人间.md', name: '番外卷 星落人间.md', ext: '.md', words: 100,
            headings: [
                {offset: 1, level: 2, title: '番外1 自我独白', words: 50},
                {offset: 20, level: 2, title: '番外2 星落', words: 50},
            ],
        },
    ], 'split');
    const model = buildBookModel(scan);
    const vol = model.top[0];
    assert.equal(vol.kind, 'volume');
    assert.equal(vol.children.length, 2);
    assert.equal(model.chapters[0].title, '番外1 自我独白');
});

// ---- locateUnit ----

test('locateUnit 四级回退', () => {
    const scan = mockScan([
        {rel: 'a.md', name: 'a.md', ext: '.md', words: 100, headings: []},
        {rel: 'b.md', name: 'b.md', ext: '.md', words: 100, headings: []},
        {rel: 'c.md', name: 'c.md', ext: '.md', words: 100, headings: []},
    ], 'file');
    const model = buildBookModel(scan);
    const chapters = flattenChapters(model);
    assert.equal(locateUnit(chapters, {lastUnitId: 'b.md#L1'}, model).matched, 'id');
    assert.equal(locateUnit(chapters, {lastUnitId: 'missing.md#L1', lastRel: 'b.md', lastUnitTitle: 'b', lastUnitOrdinal: 1}, model).matched, 'rel-title');
    assert.equal(locateUnit(chapters, {lastUnitTitle: 'c'}, model).matched, 'title');
    const p = locateUnit(chapters, {progress: 0.9}, model);
    assert.equal(p.matched, 'progress');
    assert.equal(p.index, 2);
    assert.equal(locateUnit(chapters, null, model).matched, 'first');
    assert.equal(locateUnit(chapters, {}, model).matched, 'first');
});

// ---- 进度 ----

test('computeProgress 字数加权', () => {
    const scan = mockScan([
        {rel: 'a.md', name: 'a.md', ext: '.md', words: 100, headings: []},
        {rel: 'b.md', name: 'b.md', ext: '.md', words: 300, headings: []},
    ], 'file');
    const model = buildBookModel(scan);
    const chapters = flattenChapters(model);
    assert.equal(computeProgress(chapters, model.totalWords, 0, 0), 0);
    assert.equal(computeProgress(chapters, model.totalWords, 1, 0.5), 0.625); // (100+150)/400
    assert.equal(computeProgress(chapters, model.totalWords, 1, 1), 1);
});

// ---- joinSoftLines ----

test('joinSoftLines 中文一句一行直接拼接', () => {
    assert.equal(joinSoftLines('他说：\n走吧。'), '他说：走吧。');
    assert.equal(joinSoftLines('hello\nworld'), 'hello world');
});

test('joinSoftLines 保留空行/标题/列表/代码块/硬换行', () => {
    const md = '# 标题\n\n第一段：\n继续。\n\n- 列表项\n- 第二项\n\n```\nkeep\n  spaced\n```\n\n硬换行  \n下一行。\n';
    const out = joinSoftLines(md);
    assert.ok(out.includes('# 标题'));
    assert.ok(out.includes('第一段：继续。'));
    assert.ok(out.includes('- 列表项'));
    assert.ok(out.includes('keep\n  spaced'));
    assert.ok(/\n硬换行  \n下一行。/.test(out));
});

test('joinSoftLines 英文行间补空格且代码内不动', () => {
    const md = 'The quick\nbrown fox\n\n```js\nconst a=1;\nconst b=2;\n```';
    const out = joinSoftLines(md);
    assert.ok(out.startsWith('The quick brown fox'));
    assert.ok(out.includes('const a=1;\nconst b=2;'));
});

// ---- 其它 ----

test('stripFrontMatter', () => {
    const {text, meta} = stripFrontMatter('---\ntitle: 书名\nauthor: 人\n---\n\n正文');
    assert.equal(meta.title, '书名');
    assert.equal(meta.author, '人');
    assert.equal(text, '正文');
    const r2 = stripFrontMatter('无 front matter');
    assert.equal(r2.text, '无 front matter');
    assert.equal(r2.meta, null);
});

test('normalizeBookKey / unitId', () => {
    assert.equal(normalizeBookKey('D:\\OraSkyC\\Novel\\日记星辰\\正文\\'), 'd:/oraskyc/novel/日记星辰/正文');
    assert.equal(unitIdOf('a.md', 12, false), 'a.md#L12');
    assert.equal(unitIdOf('a.docx', 3, true), 'a.docx#B3');
    assert.deepEqual(parseUnitId('a.md#L12'), {rel: 'a.md', block: false, offset: 12});
    assert.deepEqual(parseUnitId('a.docx#B3'), {rel: 'a.docx', block: true, offset: 3});
    assert.equal(parseUnitId('bad'), null);
});

test('minutesFor', () => {
    assert.equal(minutesFor(0), 1);
    assert.equal(minutesFor(399), 1);
    assert.equal(minutesFor(401), 2);
});
