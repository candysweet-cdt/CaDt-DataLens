// ai-search-advanced.test.mjs —— search_text 高级参数归一化 / 结果聚合 / 接线护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    absoluteSearchPath,
    filterSearchResult,
    filterSearchResultToFile,
    formatSearchAnswer,
    normalizeSearchOptions,
    relativeToRoot,
    regexHintFor,
} from '../../../src/ai/tools/ai-search-advanced.js';
import {AI_TOOL_DEFS} from '../../../src/ai/tools/ai-tool-defs.js';

const simpleGlob = (pattern, rel, name) => {
    const target = String(pattern).includes('/') ? rel : (name || rel.split('/').pop());
    return new RegExp('^' + String(pattern).replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$').test(target);
};

test('参数归一化：缺省与钳制', () => {
    assert.deepEqual(normalizeSearchOptions({}), {
        regex: false, wholeWord: false, pattern: '', excludePattern: '',
        outputMode: 'content', context: 0, maxResults: 200, includeIgnored: false,
    });
    const opts = normalizeSearchOptions({
        regex: true, wholeWord: 'true', pattern: '  *.go  ', excludePattern: ' tests/** ',
        outputMode: 'FILES', context: 99, maxResults: 5000,
    });
    assert.equal(opts.regex, true);
    assert.equal(opts.wholeWord, true);
    assert.equal(opts.pattern, '*.go');
    assert.equal(opts.excludePattern, 'tests/**');
    assert.equal(opts.outputMode, 'files');
    assert.equal(opts.context, 3);
    assert.equal(opts.maxResults, 1000);
    assert.equal(normalizeSearchOptions({includeIgnored: true}).includeIgnored, true);
    assert.equal(normalizeSearchOptions({includeIgnored: 'true'}).includeIgnored, true);
    assert.equal(normalizeSearchOptions({includeIgnored: false}).includeIgnored, false);
    assert.equal(normalizeSearchOptions({outputMode: 'bogus', context: -5, maxResults: 0}).outputMode, 'content');
    assert.equal(normalizeSearchOptions({context: -5}).context, 0);
});

test('filePattern 兜底过滤：files / count / hits 三种结果形态', () => {
    const result = {
        hits: [
            {path: 'C:/ws/src/a.go', name: 'a.go', line: 2, preview: 'needle'},
            {path: 'C:/ws/tests/a_test.go', name: 'a_test.go', line: 3, preview: 'needle'},
        ],
        fileList: ['C:/ws/src/a.go', 'C:/ws/tests/a_test.go'],
        counts: [{path: 'C:/ws/src/a.go', count: 2}, {path: 'C:/ws/tests/a_test.go', count: 5}],
        truncated: false,
    };
    const {result: filtered, note} = filterSearchResult(result, 'src/*.go', 'C:/ws', simpleGlob);
    assert.equal(filtered.hits.length, 1);
    assert.equal(filtered.fileList.length, 1);
    assert.equal(filtered.counts.length, 1);
    assert.match(note, /过滤前 2/);
    assert.equal(relativeToRoot('C:/WS/src/a.go', 'C:/ws/'), 'src/a.go');
});

test('content 模式带前后文输出', () => {
    const result = {hits: [{
        path: 'C:/ws/src/a.go', name: 'a.go', line: 2, preview: 'call foo()',
        before: [{line: 1, text: 'func main() {'}],
        after: [{line: 3, text: '} '}],
    }]};
    const text = formatSearchAnswer(result, {outputMode: 'content'}, {
        rootNorm: 'C:/ws', start: 'src', query: 'foo',
    });
    assert.match(text, /搜索起点：src/);
    assert.match(text, /src\/a\.go:2: call foo\(\)/);
    assert.match(text, /1- func main\(\) \{/);
    assert.match(text, /3\+ \}/);
});

test('files / count 模式与空结果', () => {
    const result = {
        fileList: ['C:/ws/a.go', 'C:/ws/b.go'],
        counts: [{path: 'C:/ws/a.go', count: 3}, {path: 'C:/ws/b.go', count: 1}],
        truncated: true,
    };
    // mock 后端会把 hits 置为空数组，不能因此误判成「没有找到匹配」
    const mockStyle = {...result, hits: []};
    const files = formatSearchAnswer(mockStyle, {outputMode: 'files'}, {rootNorm: 'C:/ws'});
    assert.match(files, /匹配文件（2 个）：/);
    assert.match(files, /a\.go/);
    assert.match(files, /结果已截断/);
    const counts = formatSearchAnswer(result, {outputMode: 'count'}, {rootNorm: 'C:/ws'});
    assert.match(counts, /a\.go: 3/);
    assert.match(counts, /b\.go: 1/);
    assert.equal(formatSearchAnswer({hits: []}, {}, {query: 'nope'}), '没有找到匹配：nope');
});

test('工具定义 / Go 绑定 / mock 三处接线齐全', () => {
    const props = AI_TOOL_DEFS.search_text.parameters.properties;
    for (const key of ['regex', 'wholeWord', 'excludePattern', 'outputMode', 'context', 'maxResults']) {
        assert.ok(props[key], 'search_text 缺参数 ' + key);
    }
    const read = (rel) => readFileSync(new URL('../../../' + rel, import.meta.url), 'utf8');
    // v3 不再生成 wailsjs：绑定由 runtime Call.ByName 动态解析，接线核对直接对 Go 方法签名。
    assert.match(read('../internal/search/search.go'), /func \(s \*Searcher\) SearchWorkspaceAdvanced\(root, query string, opts SearchOptions\)/);
    assert.match(read('src/dev/mock-backend.js'), /async SearchWorkspaceAdvanced\(/);
    assert.match(read('src/ai/ai-panel.js'), /backend\.SearchWorkspaceAdvanced\(searchRoot, query,/);
});

// ==================== 正则软提示（零命中时提醒忘了开 regex） ====================

test('regexHintFor：正则元字符未开 regex 才提示，已开 / 无元字符不提示', () => {
    assert.equal(regexHintFor('function On|const On|\\bOn\\(', false),
        '；提示：查询含正则元字符（| ( \\b）但未启用 regex，当前按字面量搜索。若想按正则匹配，请传 regex:true 重试');
    assert.equal(regexHintFor('function On|const On|\\bOn\\(', true), '');
    assert.equal(regexHintFor('applySettings', false), '');
    // 常见字面量符号不误报
    assert.equal(regexHintFor('file.ts', false), '');
    assert.equal(regexHintFor('$HOME', false), '');
    assert.equal(regexHintFor('C++', false), '');
    assert.equal(regexHintFor('a-b/c', false), '');
});

test('零命中结果附正则提示；有命中不附（字面量搜索有效不打扰）', () => {
    const empty = formatSearchAnswer({hits: []}, {}, {query: 'foo|bar'});
    assert.match(empty, /没有找到匹配：foo\|bar/);
    assert.match(empty, /未启用 regex/);
    assert.match(empty, /regex:true/);
    const hit = formatSearchAnswer({hits: [{path: 'C:/ws/a.js', line: 1, preview: 'foo|bar'}]}, {}, {query: 'foo|bar'});
    assert.doesNotMatch(hit, /未启用 regex/);
    // 显式开 regex 时即使零命中也不提示
    const regexEmpty = formatSearchAnswer({hits: []}, {regex: true}, {query: 'foo|bar'});
    assert.doesNotMatch(regexEmpty, /未启用 regex/);
});

// ==================== 单文件搜索（path 直接传文件） ====================

test('filterSearchResultToFile：只保留目标文件（绝对/相对/大小写/反斜杠）', () => {
    const root = 'D:/proj/src';
    const result = {
        hits: [
            {path: 'D:\\proj\\src\\a.js', name: 'a.js', line: 1, preview: 'x'},
            {path: 'D:/proj/src/a.js', line: 2, preview: 'y'},
            {path: 'b.js', line: 3, preview: 'z'},
        ],
        fileList: ['D:/proj/src/a.js', 'b.js'],
        counts: [{path: 'a.js', count: 2}, {path: 'b.js', count: 1}],
    };
    const narrowed = filterSearchResultToFile(result, 'd:/PROJ/src/A.js', root);
    assert.equal(narrowed.hits.length, 2);
    assert.deepEqual(narrowed.fileList, ['D:/proj/src/a.js']);
    assert.deepEqual(narrowed.counts, [{path: 'a.js', count: 2}]);
    assert.equal(absoluteSearchPath('b.js', root), 'D:/proj/src/b.js');
    assert.equal(absoluteSearchPath('D:\\x\\b.js', root), 'D:/x/b.js');
    assert.equal(absoluteSearchPath('D:/proj/src/b.js', root), 'D:/proj/src/b.js');
});

test('单文件搜索：文件头用 scopeNote 替代「相对起点」提示', () => {
    const text = formatSearchAnswer({hits: [{path: 'a.js', line: 3, preview: 'hit'}]}, {outputMode: 'content'}, {
        rootNorm: 'D:/proj/src',
        start: 'D:/proj/src/a.js',
        scopeNote: '只搜索文件：D:/proj/src/a.js（路径相对其所在目录）',
    });
    assert.match(text, /只搜索文件/);
    assert.ok(!text.includes('以下路径相对该起点'));
    assert.match(text, /a\.js:3: hit/);
    const empty = formatSearchAnswer({hits: []}, {outputMode: 'content'}, {
        rootNorm: 'D:/proj/src', start: 'D:/proj/src/a.js', scopeNote: '只搜索文件：a.js', query: 'nope',
    });
    assert.match(empty, /只搜索文件/);
});
