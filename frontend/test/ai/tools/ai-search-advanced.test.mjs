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
    SEARCH_DEFAULT_LIMIT,
    SEARCH_OUTPUT_CHAR_BUDGET,
} from '../../../src/ai/tools/ai-search-advanced.js';
import {AI_TOOL_DEFS} from '../../../src/ai/tools/ai-tool-defs.js';

const simpleGlob = (pattern, rel, name) => {
    const target = String(pattern).includes('/') ? rel : (name || rel.split('/').pop());
    return new RegExp('^' + String(pattern).replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$').test(target);
};

test('参数归一化：缺省与钳制', () => {
    assert.deepEqual(normalizeSearchOptions({}), {
        regex: false,
        wholeWord: false, pattern: '', excludePattern: '',
        outputMode: 'content', context: 0, offset: 0, limit: SEARCH_DEFAULT_LIMIT, includeIgnored: false,
    });
    const opts = normalizeSearchOptions({
        regex: true, wholeWord: 'true', pattern: '  *.go  ', excludePattern: ' tests/** ',
        outputMode: 'FILES', context: 99, limit: 5000, offset: 120,
    });
    assert.equal(opts.regex, true);
    assert.equal(opts.wholeWord, true);
    assert.equal(opts.pattern, '*.go');
    assert.equal(opts.excludePattern, 'tests/**');
    assert.equal(opts.outputMode, 'files');
    assert.equal(opts.context, 3);
    assert.equal(opts.limit, 1000);
    assert.equal(opts.offset, 120);
    assert.equal(normalizeSearchOptions({includeIgnored: true}).includeIgnored, true);
    assert.equal(normalizeSearchOptions({includeIgnored: 'true'}).includeIgnored, true);
    assert.equal(normalizeSearchOptions({includeIgnored: false}).includeIgnored, false);
    assert.equal(normalizeSearchOptions({outputMode: 'bogus', context: -5, limit: 0}).outputMode, 'content');
    assert.equal(normalizeSearchOptions({context: -5}).context, 0);
    assert.equal(normalizeSearchOptions({offset: -9}).offset, 0);
    // 旧 maxResults 作为 limit 兼容别名
    assert.equal(normalizeSearchOptions({maxResults: 300}).limit, 300);
    // filePattern 是工具定义下发的字段名，必须被识别；旧 pattern 仍兼容，filePattern 优先
    assert.equal(normalizeSearchOptions({filePattern: '*.go'}).pattern, '*.go');
    assert.equal(normalizeSearchOptions({pattern: '*.ts'}).pattern, '*.ts');
    assert.equal(normalizeSearchOptions({filePattern: '*.go', pattern: '*.ts'}).pattern, '*.go');
});

test('regex 保持纯显式：任何 query 都不会被自动改成正则（防误伤回归）', () => {
    // 曾尝试按 query 自动识别正则，但实测把 Windows 路径 / TS 类型联合变成非法正则报错
    // 或全表命中。现在 regex 纯显式：不传一律 false，无论 query 长什么样。
    for (const q of ['foo|bar', '\\d{4}-\\d{2}', '^func\\s+\\w+', 'C:\\data\\x', 'string | number', '.*', '^']) {
        assert.equal(normalizeSearchOptions({query: q}).regex, false, 'query ' + q + ' 不应自动开正则');
    }
    // 显式 true / 'true' 才开
    assert.equal(normalizeSearchOptions({query: 'foo', regex: true}).regex, true);
    assert.equal(normalizeSearchOptions({query: 'foo', regex: 'true'}).regex, true);
    // 显式 false 保持字面量
    assert.equal(normalizeSearchOptions({query: 'foo|bar', regex: false}).regex, false);
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
    assert.match(files, /匹配文件（本次显示 2 条（offset 0）/);
    assert.match(files, /a\.go/);
    assert.match(files, /结果已截断/);
    const counts = formatSearchAnswer(result, {outputMode: 'count'}, {rootNorm: 'C:/ws'});
    assert.match(counts, /a\.go: 3/);
    assert.match(counts, /b\.go: 1/);
    assert.equal(formatSearchAnswer({hits: []}, {}, {query: 'nope'}), '没有找到匹配：nope');
});

test('工具定义 / Go 绑定 / mock 三处接线齐全', () => {
    const props = AI_TOOL_DEFS.search_text.parameters.properties;
    for (const key of ['regex', 'wholeWord', 'excludePattern', 'outputMode', 'context', 'offset', 'limit']) {
        assert.ok(props[key], 'search_text 缺参数 ' + key);
    }
    assert.ok(!props.maxResults, 'search_text 不应再下发旧参数 maxResults');
    const read = (rel) => readFileSync(new URL('../../../' + rel, import.meta.url), 'utf8');
    // v3 不再生成 wailsjs：绑定由 runtime Call.ByName 动态解析，接线核对直接对 Go 方法签名。
    assert.match(read('../internal/search/search.go'), /func \(s \*Searcher\) SearchWorkspaceAdvanced\(root, query string, opts SearchOptions\)/);
    assert.match(read('src/dev/mock-backend.js'), /async SearchWorkspaceAdvanced\(/);
    const panel = read('src/ai/ai-panel.js');
    assert.match(panel, /backend\.SearchWorkspaceAdvanced\(searchRoot, query,/);
    // 群成员执行分支 execMemberTool 是第二处 search_text 执行体，必须同样下传 offset/limit。
    // 群成员复用同一份工具定义，漏接会导致模型按回报续取时永远拿到第一页（死循环）。
    const execMember = panel.slice(panel.indexOf('function execMemberTool'));
    assert.ok(execMember.length > 0, '应存在 execMemberTool 分支');
    const memberSearch = execMember.slice(execMember.indexOf("name === 'search_text'"), execMember.indexOf("name === 'glob'"));
    assert.match(memberSearch, /offset: opts\.offset/, '群成员 search_text 未下传 offset');
    assert.match(memberSearch, /limit: opts\.limit/, '群成员 search_text 未下传 limit');
    assert.doesNotMatch(memberSearch, /maxResults: opts\.maxResults/, '群成员 search_text 仍在用已废弃的 maxResults');
});

// ==================== 正则软提示（零命中时提醒忘了开 regex） ====================

test('regexHintFor：正则语法未开 regex 才提示，已开 / 无信号不提示', () => {
    const hint = regexHintFor('function On|const On|\\bOn\\(', false);
    assert.match(hint, /查询含正则语法/);
    assert.match(hint, /\|/, '应识别出 | 信号');
    assert.match(hint, /\\b/, '应识别出 \\b 信号');
    assert.match(hint, /regex:true 重试/);
    assert.equal(regexHintFor('function On|const On|\\bOn\\(', true), '');
    assert.equal(regexHintFor('applySettings', false), '');
    // 常见字面量符号不误报（. $ + 括号都不在信号集）
    assert.equal(regexHintFor('file.ts', false), '');
    assert.equal(regexHintFor('$HOME', false), '');
    assert.equal(regexHintFor('C++', false), '');
    assert.equal(regexHintFor('a-b/c', false), '');
    assert.equal(regexHintFor('foo(bar)', false), '', '裸括号不触发提示');
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

// ==================== 分页回报 + 字符预算（防一次搜索撑爆上下文） ====================

test('分页回报：主动返回本次条数/总条数/offset，并提示下一页 offset', () => {
    const result = {hits: [
        {path: 'C:/ws/a.go', line: 1, preview: 'hit1'},
        {path: 'C:/ws/a.go', line: 2, preview: 'hit2'},
    ], total: 137, returned: 2, offset: 50, truncated: false};
    const text = formatSearchAnswer(result, {outputMode: 'content', offset: 50}, {rootNorm: 'C:/ws', query: 'x'});
    assert.match(text, /本次显示 2 条 \/ 本次取回 2 条 \/ 共 137 条（offset 50）/);
    assert.match(text, /offset=52 继续取下一页/);
    // 已取完时不提示下一页
    const done = formatSearchAnswer({hits: [{path: 'C:/ws/a.go', line: 1, preview: 'x'}], total: 1, returned: 1, offset: 0},
        {outputMode: 'content'}, {rootNorm: 'C:/ws'});
    assert.match(done, /本次显示 1 条 \/ 本次取回 1 条 \/ 共 1 条（offset 0）/);
    assert.doesNotMatch(done, /继续取下一页/);
});

test('字符预算：按整条命中截断，不切半条，提示已截断与续取 offset', () => {
    const big = 'x'.repeat(1000);
    const hits = [1, 2, 3, 4, 5].map((n) => ({path: 'C:/ws/a.go', line: n, preview: big}));
    const text = formatSearchAnswer({hits, total: 5, returned: 5, offset: 0},
        {outputMode: 'content', outputCharBudget: 2500}, {rootNorm: 'C:/ws'});
    assert.match(text, /a\.go:1:/);
    assert.match(text, /a\.go:2:/);
    assert.doesNotMatch(text, /a\.go:3:/, '第 3 条应被预算挡下');
    assert.match(text, /超过字符预算/);
    assert.match(text, /另有 3 条未显示/);
    assert.match(text, /offset=2 继续取/);
});

test('files/count 模式也带分页回报', () => {
    const files = formatSearchAnswer({fileList: ['C:/ws/a.go', 'C:/ws/b.go'], total: 80, returned: 2, offset: 10},
        {outputMode: 'files'}, {rootNorm: 'C:/ws'});
    assert.match(files, /匹配文件（本次显示 2 条 \/ 本次取回 2 条 \/ 共 80 条（offset 10）/);
    const counts = formatSearchAnswer({counts: [{path: 'C:/ws/a.go', count: 3}], total: 80, returned: 1, offset: 10},
        {outputMode: 'count'}, {rootNorm: 'C:/ws'});
    assert.match(counts, /每文件命中数（本次显示 1 条 \/ 本次取回 1 条 \/ 共 80 条（offset 10）/);
});

test('预算截断与分页回报只有一条续取提示，且按实际显示数算 offset（不丢数据）', () => {
    // 后端回报 returned=50、total=1000，但预算只显示 2 条 → 续取必须按 offset=2，不能按 50
    const hits = Array.from({length: 50}, (_, i) => ({path: 'C:/ws/a.go', line: i + 1, preview: 'x'.repeat(100)}));
    const text = formatSearchAnswer({hits, total: 1000, returned: 50, offset: 0},
        {outputMode: 'content', outputCharBudget: 2500}, {rootNorm: 'C:/ws'});
    assert.match(text, /本次显示 \d+ 条 \/ 本次取回 50 条 \/ 共 1000 条/);
    // 续取 offset 必须等于实际显示条数（22），绝不能是后端 returned（50）
    const shown = Number((text.match(/本次显示 (\d+) 条/) || [])[1]);
    assert.ok(shown > 0 && shown < 50, '预算应截断部分命中');
    assert.match(text, new RegExp('offset=' + shown + ' 继续取未显示部分'));
    assert.doesNotMatch(text, /offset=50 继续取下一页/, '不能出现按后端 returned 算的第二条 offset');
    assert.equal((text.match(/继续取/g) || []).length, 1, '只能有一条续取提示');
});

test('单条命中超预算也保留它并截断 context 行，不输出空、不原地打转', () => {
    const hit = {path: 'C:/ws/a.go', line: 1, preview: 'hit',
        before: [{line: 0, text: 'y'.repeat(5000)}], after: [{line: 2, text: 'z'.repeat(5000)}]};
    const text = formatSearchAnswer({hits: [hit], total: 1, returned: 1, offset: 0},
        {outputMode: 'content', outputCharBudget: 2000}, {rootNorm: 'C:/ws'});
    assert.match(text, /a\.go:1: hit/, '超预算也应保留第一条正文');
    assert.ok(text.includes('…'), 'context 行应被截断并加省略号');
    assert.ok(text.length < 1000, '超长 context 行不应原样进入输出');
    assert.doesNotMatch(text, /offset=0 继续/, '不应给原地打转的 offset');
});

test('扫描达硬顶时提示收窄条件（total=1000）', () => {
    const text = formatSearchAnswer({hits: [{path: 'C:/ws/a.go', line: 1, preview: 'x'}], total: 1000, returned: 1, offset: 0},
        {outputMode: 'content'}, {rootNorm: 'C:/ws'});
    assert.match(text, /已达扫描上限/);
});

test('零命中正则提示：含正则语法忘传 regex 时明确提示，有命中不打扰', () => {
    const opts = normalizeSearchOptions({query: 'foo|bar'}); // regex 未开（纯显式）
    // 零命中 + 含正则语法 → 提示忘传 regex:true
    const empty = formatSearchAnswer({hits: []}, opts, {rootNorm: 'C:/ws', query: 'foo|bar'});
    assert.match(empty, /忘传 regex:true/);
    assert.match(empty, /regex:true 重试/);
    // 有命中时不提示（字面量搜索有效，不打扰）
    const hit = formatSearchAnswer({hits: [{path: 'C:/ws/a.go', line: 1, preview: 'foobar'}], total: 1, returned: 1, offset: 0},
        opts, {rootNorm: 'C:/ws', query: 'foo|bar'});
    assert.doesNotMatch(hit, /忘传 regex:true/);
    // 已开 regex 时零命中也不提示（不是忘传）
    const opened = normalizeSearchOptions({query: 'foo|bar', regex: true});
    const emptyOpened = formatSearchAnswer({hits: []}, opened, {rootNorm: 'C:/ws', query: 'foo|bar'});
    assert.doesNotMatch(emptyOpened, /忘传 regex:true/);
    // 纯字面量零命中不提示（无正则信号）
    const plain = formatSearchAnswer({hits: []}, normalizeSearchOptions({query: 'applySettings'}),
        {rootNorm: 'C:/ws', query: 'applySettings'});
    assert.doesNotMatch(plain, /忘传 regex:true/);
});
