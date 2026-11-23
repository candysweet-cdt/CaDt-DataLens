// ai-gen-model.test.mjs：生图/视频模型数据层护栏（归一化、模板渲染、提取路径、预设表形状）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGenConfigExport,
    buildGenMultipart,
    buildGenVars,
    classifyGenRef,
    dataURLBytes,
    defaultGenModelOf,
    extractGenPath,
    extractGenProducts,
    genExtFor,
    GEN_IMAGE_WRAP_DEFAULT,
    genModelByRef,
    genModelEcho,
    genRequestPath,
    GEN_MODEL_PRESETS,
    GEN_PLACEHOLDERS,
    GEN_REF_BYTES_LIMIT,
    GEN_REF_LIMIT,
    isAsyncGenModel,
    mergeGenConfigImport,
    mergeGenModelEntry,
    moveGenModelWithinKind,
    normalizeGenHeaders,
    normalizeGenModel,
    normalizeGenModels,
    normalizeGenSnapshot,
    parseGenConfigImport,
    randomGenSeed,
    renderGenImages,
    renderGenJson,
    renderGenText,
} from '../../../src/ai/gen/ai-gen-model.js';

test('normalizeGenModel：缺省值与 clamp，kind 非法回落 image', () => {
    const entry = normalizeGenModel({id: 'g1', name: '  测试  '}, () => 'gen-x');
    assert.equal(entry.id, 'g1');
    assert.equal(entry.name, '测试');
    assert.equal(entry.kind, 'image');
    assert.equal(entry.enabled, true);
    assert.equal(entry.proxy, 'system');
    assert.equal(entry.timeoutSec, 120);
    assert.equal(entry.resultType, 'b64');
    assert.equal(entry.defaultN, 1);
    assert.deepEqual(entry.headers, []);
    const weird = normalizeGenModel({kind: 'audio', timeoutSec: 1, defaultN: 99, resultType: 'blob', pollIntervalSec: 0, maxPolls: 9999});
    assert.equal(weird.kind, 'image', '非法 kind 回落 image');
    assert.equal(weird.timeoutSec, 30);
    assert.equal(weird.defaultN, 4);
    assert.equal(weird.resultType, 'b64');
    assert.equal(weird.pollIntervalSec, 2);
    assert.equal(weird.maxPolls, 240);
    assert.equal(normalizeGenModel(null, () => 'gen-y').id, 'gen-y', '空输入用 idGen 兜底');
});

test('genModelEcho：回显全部非密钥字段（含 bodyTemplate/resultPath/headers），绝不泄漏 apiKey', () => {
    const entry = normalizeGenModel({
        id: 'g1', name: 'sensenova', kind: 'image',
        baseURL: 'https://token.sensenova.cn', path: '/v1/images/generations',
        bodyTemplate: '{"prompt":{{prompt}}}', resultPath: 'data[*].b64_json', resultType: 'b64',
        headers: [{key: 'Authorization', value: 'Bearer {{apiKey}}'}],
        apiKey: 'sk-super-secret',
    }, () => 'g');
    const echo = genModelEcho(entry);
    assert.equal(echo.bodyTemplate, '{"prompt":{{prompt}}}', 'bodyTemplate 必须回显（缺它曾导致下载 400 排查绕弯）');
    assert.equal(echo.resultPath, 'data[*].b64_json');
    assert.equal(echo.resultType, 'b64');
    assert.deepEqual(echo.headers, [{key: 'Authorization', value: 'Bearer {{apiKey}}'}]);
    assert.equal(Object.prototype.hasOwnProperty.call(echo, 'apiKey'), false, '密钥字段绝不出现');
    assert.equal(JSON.stringify(echo).includes('sk-super-secret'), false, '序列化后也不含密钥明文');
    echo.headers[0].value = 'tampered';
    assert.equal(entry.headers[0].value, 'Bearer {{apiKey}}', 'headers 是深拷贝，改回显不影响原条目');
});

test('randomGenSeed：31 位非负整数，连续多次不全相同', () => {
    for (let i = 0; i < 20; i++) {
        const s = randomGenSeed();
        assert.ok(Number.isInteger(s) && s >= 0 && s <= 0x7fffffff, 'seed 应为 31 位非负整数，实际 ' + s);
    }
    const set = new Set(Array.from({length: 30}, () => randomGenSeed()));
    assert.ok(set.size > 1, '连续随机不应全相同');
});

test('buildGenVars：seed 未指定时随机填充，显式 seed 原样尊重', () => {
    const entry = normalizeGenModel({name: 'x', bodyTemplate: '{"seed":{{seed}}}'}, () => 'g');
    const a = buildGenVars(entry, {prompt: 'p'});
    const b = buildGenVars(entry, {prompt: 'p'});
    assert.ok(Number.isInteger(a.seed) && a.seed >= 0, '未指定 seed 应为随机整数');
    assert.ok(Number.isInteger(b.seed) && b.seed >= 0);
    // 模板渲染出数字字面量（不是 null），发给服务端才有效果
    const body = JSON.parse(renderGenJson(entry.bodyTemplate, a));
    assert.equal(typeof body.seed, 'number', '{{seed}} 应渲染成数字，不再渲染 null');
    assert.equal(buildGenVars(entry, {prompt: 'p', seed: 12345}).seed, 12345, '显式 seed 原样尊重');
    assert.equal(buildGenVars(entry, {prompt: 'p', seed: 0}).seed, 0, 'seed=0 是合法显式值，不当作未指定');
});

test('normalizeGenHeaders：数组 / 对象 / 行文本三种形态，去重去空键剥换行', () => {
    assert.deepEqual(normalizeGenHeaders([{key: 'Authorization', value: 'Bearer {{apiKey}}'}]),
        [{key: 'Authorization', value: 'Bearer {{apiKey}}'}]);
    assert.deepEqual(normalizeGenHeaders({'X-A': '1', 'X-B': '2'}),
        [{key: 'X-A', value: '1'}, {key: 'X-B', value: '2'}]);
    assert.deepEqual(normalizeGenHeaders('X-A: 1\nX-B : 2\nX-A: 3\n: bad'),
        [{key: 'X-A', value: '1'}, {key: 'X-B', value: '2'}], '行文本解析，重名去重，空键丢弃');
    assert.equal(normalizeGenHeaders([{key: 'X-C\r\nX-D', value: 'a\nb'}])[0].key, 'X-CX-D', '键值剥换行（防头注入）');
});

test('normalizeGenModels：按 id 去重、过滤无效项、空输入给空数组', () => {
    assert.deepEqual(normalizeGenModels(null), []);
    assert.deepEqual(normalizeGenModels('x'), []);
    const list = normalizeGenModels([
        {id: 'a', name: '甲'},
        'junk',
        {id: 'a', name: '乙'},
        {id: 'b', kind: 'video'},
    ], () => 'gen-1');
    assert.equal(list.length, 2);
    assert.equal(list[0].name, '甲', '重复 id 后到者让位');
    assert.equal(list[1].kind, 'video');
});

test('defaultGenModelOf / genModelByRef：id 或名称精确匹配、类型与启用过滤、空 ref 回缺省', () => {
    const list = [
        {id: 'g1', name: 'Kolors', kind: 'image', enabled: true},
        {id: 'g2', name: 'Wan', kind: 'video', enabled: true},
        {id: 'g3', name: '停用', kind: 'image', enabled: false},
    ];
    assert.equal(defaultGenModelOf(list, 'image').id, 'g1');
    assert.equal(defaultGenModelOf(list, 'video').id, 'g2');
    assert.equal(defaultGenModelOf([{id: 'g3', kind: 'image', enabled: false}], 'image'), null, '全停用给 null');
    assert.equal(genModelByRef(list, 'image', 'kolors').id, 'g1', '名称大小写不敏感');
    assert.equal(genModelByRef(list, 'image', 'g1').id, 'g1');
    assert.equal(genModelByRef(list, 'video', 'Kolors'), null, '类型不匹配不命中');
    assert.equal(genModelByRef(list, 'image', '不存在'), null, 'ref 没命中返回 null（调用方报错，不静默回落）');
    assert.equal(genModelByRef(list, 'image', '停用'), null, '停用条目不命中，也不回落');
    assert.equal(genModelByRef(list, 'image', '').id, 'g1', '空 ref 回缺省');
});

test('moveGenModelWithinKind：只在同类型槽位内换人，跨类型位置不动，边界原样返回', () => {
    const list = [
        {id: 'a', kind: 'image'},
        {id: 'v1', kind: 'video'},
        {id: 'b', kind: 'image'},
        {id: 'v2', kind: 'video'},
        {id: 'c', kind: 'image'},
    ];
    // a 下移：与 b 交换槽位，v1 仍在原位（夹在中间不动）
    const down = moveGenModelWithinKind(list, 'a', 1);
    assert.deepEqual(down.map((e) => e.id), ['b', 'v1', 'a', 'v2', 'c']);
    // c 上移一位：与 b 交换，v2 不动
    assert.deepEqual(moveGenModelWithinKind(list, 'c', -1).map((e) => e.id), ['a', 'v1', 'c', 'v2', 'b']);
    // 视频组内独立排序：v2 上移到 v1 之前，生图条目位置全不变
    assert.deepEqual(moveGenModelWithinKind(list, 'v2', -1).map((e) => e.id), ['a', 'v2', 'b', 'v1', 'c']);
    // 边界 / 无效输入：返回原引用（调用方据此跳过落盘）
    assert.equal(moveGenModelWithinKind(list, 'a', -1), list, '组首上移');
    assert.equal(moveGenModelWithinKind(list, 'c', 1), list, '组尾下移');
    assert.equal(moveGenModelWithinKind(list, 'nope', 1), list, '找不到条目');
    assert.equal(moveGenModelWithinKind(list, 'a', 0), list, 'delta 为 0');
    const empty = [];
    assert.equal(moveGenModelWithinKind(empty, 'a', 1), empty);
    assert.deepEqual(moveGenModelWithinKind(null, 'a', 1), []);
    // 不修改入参
    assert.deepEqual(list.map((e) => e.id), ['a', 'v1', 'b', 'v2', 'c']);
});

test('moveGenModelWithinKind + defaultGenModelOf：组内顺序即缺省优先级', () => {
    const list = [
        {id: 'a', kind: 'image', enabled: false},
        {id: 'b', kind: 'image', enabled: true},
        {id: 'v', kind: 'video', enabled: true},
    ];
    assert.equal(defaultGenModelOf(list, 'image').id, 'b', '停用条目不占优先级，取第一个启用的');
    const moved = moveGenModelWithinKind(list, 'b', -1);
    assert.deepEqual(moved.map((e) => e.id), ['b', 'a', 'v']);
    assert.equal(defaultGenModelOf(moved, 'image').id, 'b');
});

test('isAsyncGenModel：submit/jobId/pollPath 三者齐备才算异步型', () => {
    assert.equal(isAsyncGenModel({submitPath: '/submit', jobIdPath: 'id', pollPath: '/poll?id={{jobId}}'}), true);
    assert.equal(isAsyncGenModel({submitPath: '/submit'}), false);
    assert.equal(isAsyncGenModel({}), false);
    assert.equal(isAsyncGenModel(null), false);
});

test('renderGenJson：占位符渲染为 JSON 字面量，prompt 注入安全，未知占位符抛错', () => {
    assert.equal(renderGenJson('{"model":{{model}},"prompt":{{prompt}},"n":{{n}}}',
        {model: 'Kolors', prompt: '他说"你好"\n第二行', n: 2}),
        '{"model":"Kolors","prompt":"他说\\"你好\\"\\n第二行","n":2}');
    assert.equal(renderGenJson('{"size":{{size}}}', {}), '{"size":null}', '缺参渲染 null');
    assert.equal(renderGenJson('{{prompt}}-{{prompt}}', {prompt: 'x'}), '"x"-"x"', '同占位符可多次出现');
    assert.equal(renderGenJson('{"seed":{{seed}}}', {seed: 0}), '{"seed":0}', '0 是合法字面量');
    assert.throws(() => renderGenJson('{{evil}}', {}), /未知占位符/);
    assert.throws(() => renderGenJson('   ', {}), /模板为空/);
    assert.deepEqual(GEN_PLACEHOLDERS.includes('prompt') && GEN_PLACEHOLDERS.includes('jobId'), true);
});

test('renderGenText：纯文本替换（headers / 轮询 URL），缺参留空', () => {
    assert.equal(renderGenText('Bearer {{apiKey}}', {apiKey: 'sk-1'}), 'Bearer sk-1');
    assert.equal(renderGenText('/poll?id={{jobId}}', {jobId: 't-9'}), '/poll?id=t-9');
    assert.equal(renderGenText('Bearer {{apiKey}}', {}), 'Bearer ', '缺参留空（不带引号）');
    assert.throws(() => renderGenText('{{nope}}', {}), /未知占位符/);
});

test('extractGenPath：点路径 / 下标 / [*] 多值 / 走不通给空数组 / 语法错抛错', () => {
    const data = {data: [{b64_json: 'AAA', url: 'u1'}, {b64_json: 'BBB', url: 'u2'}], error: {message: 'bad'}};
    assert.deepEqual(extractGenPath(data, 'data[0].b64_json'), ['AAA']);
    assert.deepEqual(extractGenPath(data, 'data[*].url'), ['u1', 'u2']);
    assert.deepEqual(extractGenPath(data, 'error.message'), ['bad']);
    assert.deepEqual(extractGenPath(data, 'data[*].b64_json'), ['AAA', 'BBB']);
    assert.deepEqual(extractGenPath(data, ''), [data], '空路径返回整个值');
    assert.deepEqual(extractGenPath(data, 'data[9].url'), [], '越界给空数组');
    assert.deepEqual(extractGenPath(data, 'nope.deep'), []);
    assert.deepEqual(extractGenPath(data, 'data[*].missing'), []);
    assert.deepEqual(extractGenPath({list: [{v: 1}, {v: 2}]}, 'list[*].v'), [1, 2], '[*] 后继续取字段');
    assert.deepEqual(extractGenPath('plain', 'x'), [], '标量上取字段给空数组');
    assert.throws(() => extractGenPath(data, 'a..b'), /语法无效/);
    assert.throws(() => extractGenPath(data, 'a[x]'), /语法无效/);
});

test('genExtFor：已知 mime 直接映射，未知按产物类型兜底', () => {
    assert.equal(genExtFor('image/png', 'image'), 'png');
    assert.equal(genExtFor('image/jpeg', 'image'), 'jpg');
    assert.equal(genExtFor('video/mp4', 'video'), 'mp4');
    assert.equal(genExtFor('application/octet-stream', 'image'), 'png');
    assert.equal(genExtFor('', 'video'), 'mp4');
});

test('GEN_MODEL_PRESETS：预设条目可归一，模板渲染通过（预设即配置的自检）', () => {
    assert.ok(GEN_MODEL_PRESETS.length >= 3);
    const keys = new Set(GEN_MODEL_PRESETS.map((preset) => preset.key));
    assert.equal(keys.has('openai-b64') && keys.has('openai-url') && keys.has('custom'), true);
    for (const preset of GEN_MODEL_PRESETS) {
        const entry = normalizeGenModel(preset.entry, () => 'gen-p');
        assert.equal(entry.kind, preset.kind);
        // 预设的请求体模板必须能用合法参数渲染出来（占位符拼写自检）
        const body = renderGenJson(entry.bodyTemplate, {
            prompt: '测试', model: entry.defaultModel || 'm', size: entry.defaultSize || '1024x1024', n: 1,
        });
        assert.equal(typeof body, 'string');
        // 预设的提取路径必须能走通语法（用占位响应验证）
        if (entry.resultPath) {
            const sample = entry.resultType === 'b64'
                ? {data: [{b64_json: 'QQ=='}]}
                : {data: [{url: 'https://example.com/a.png'}]};
            assert.equal(extractGenPath(sample, entry.resultPath).length, 1, preset.key + ' 的 resultPath 走得通');
        }
    }
});

test('mergeGenModelEntry：AI 来源合并——字段覆盖，apiKey 只取 existing，命中沿用其 id', () => {
    const existing = {
        id: 'gen-1', name: 'sensenova-u1.5-lite', kind: 'image', enabled: true,
        baseURL: 'https://old.example.com', path: '/v1/images/generations',
        apiKey: 'sk-user-secret', defaultSize: '1024x1024',
    };
    const merged = mergeGenModelEntry(existing, {
        name: 'sensenova-u1.5-lite', kind: 'image',
        baseURL: 'https://token.sensenova.cn', path: '/v1/images/generations',
        defaultSize: '2048x2048',
        // AI 试图塞密钥——必须被丢弃
        apiKey: 'sk-from-ai',
    }, () => 'gen-new');
    assert.equal(merged.id, 'gen-1', '命中已有条目沿用其 id');
    assert.equal(merged.baseURL, 'https://token.sensenova.cn', '其余字段被 incoming 覆盖');
    assert.equal(merged.defaultSize, '2048x2048');
    assert.equal(merged.apiKey, 'sk-user-secret', '密钥只取 existing：AI 写不进也冲不掉');
    // 新建：密钥留空，id 由 idGen 生成
    const fresh = mergeGenModelEntry(null, {name: 'new-entry', kind: 'video'}, () => 'gen-new2');
    assert.equal(fresh.id, 'gen-new2');
    assert.equal(fresh.apiKey, '', '新建条目密钥留空给用户');
    assert.equal(fresh.kind, 'video');
    // incoming 非对象的兜底
    const junk = mergeGenModelEntry(existing, 'junk', () => 'gen-new3');
    assert.equal(junk.apiKey, 'sk-user-secret');
    assert.equal(junk.baseURL, 'https://old.example.com', '坏 incoming 不冲掉已有配置');
});

// ---------- 生成条目配置的导入 / 导出 ----------

test('buildGenConfigExport：只导出 genModels，密钥默认脱敏，勾选才带明文', () => {
    const list = [normalizeGenModel({id: 'g1', name: '甲', apiKey: 'sk-secret', baseURL: 'https://a.test'}, () => 'g')];
    const plain = buildGenConfigExport(list, {now: 1700000000000});
    assert.equal(plain.kind, 'cadt-gen-models');
    assert.equal(plain.version, 1);
    assert.equal(plain.exportedAt, new Date(1700000000000).toISOString());
    assert.equal(plain.genModels[0].id, 'g1');
    assert.equal(plain.genModels[0].apiKey, '', '默认脱敏');
    assert.equal(JSON.stringify(plain).includes('sk-secret'), false);
    const withKeys = buildGenConfigExport(list, {includeKeys: true, now: 1700000000000});
    assert.equal(withKeys.genModels[0].apiKey, 'sk-secret', '勾选后带密钥');
    assert.equal(Object.prototype.hasOwnProperty.call(withKeys, 'profiles'), false, '不夹带账号等其它配置');
});

test('parseGenConfigImport：完整导出对象与裸数组都接受，坏 JSON / 缺数组 / 无有效条目抛错', () => {
    const exported = buildGenConfigExport([{id: 'g1', name: '甲', kind: 'video'}], {now: 1});
    assert.deepEqual(parseGenConfigImport(JSON.stringify(exported), () => 'gen-x').map((e) => e.id), ['g1']);
    assert.deepEqual(parseGenConfigImport('[{"id":"g2","name":"乙"}]', () => 'gen-x').map((e) => e.id), ['g2']);
    assert.throws(() => parseGenConfigImport('not json', () => 'g'), /不是合法的 JSON/);
    assert.throws(() => parseGenConfigImport('{"foo":1}', () => 'g'), /缺少 genModels/);
    assert.throws(() => parseGenConfigImport('{"genModels":[1,null,"x"]}', () => 'g'), /没有有效的生成条目/);
    // 无 id 的条目由 idGen 分配（不复用本地 id）
    assert.equal(parseGenConfigImport('[{"name":"无 id"}]', () => 'gen-new')[0].id, 'gen-new');
});

test('mergeGenConfigImport：merge 按 id 覆盖 / 追加，空密钥保留本地；replace 整体替换', () => {
    const local = [normalizeGenModel({id: 'g1', name: '甲', apiKey: 'sk-local', baseURL: 'https://old.test'}, () => 'g')];
    const incoming = [
        normalizeGenModel({id: 'g1', name: '甲新', apiKey: '', baseURL: 'https://new.test'}, () => 'g'),
        normalizeGenModel({id: 'g2', name: '乙', apiKey: 'sk-2'}, () => 'g'),
    ];
    const merged = mergeGenConfigImport(local, incoming, {mode: 'merge'});
    assert.equal(merged.list.length, 2);
    assert.equal(merged.list[0].name, '甲新', '同 id 字段被覆盖');
    assert.equal(merged.list[0].baseURL, 'https://new.test');
    assert.equal(merged.list[0].apiKey, 'sk-local', '文件里空密钥不冲掉本地密钥');
    assert.equal(merged.list[1].name, '乙');
    assert.equal(merged.added, 1);
    assert.equal(merged.updated, 1);
    assert.equal(merged.replaced, false);
    assert.equal(local[0].name, '甲', '不修改入参');

    const withKey = mergeGenConfigImport(local, [normalizeGenModel({id: 'g1', name: '甲', apiKey: 'sk-file'}, () => 'g')], {mode: 'merge'});
    assert.equal(withKey.list[0].apiKey, 'sk-file', '文件里带密钥则覆盖本地');

    const replaced = mergeGenConfigImport(local, incoming, {mode: 'replace'});
    assert.equal(replaced.list.length, 2);
    assert.equal(replaced.list[0].apiKey, '', '替换模式下空密钥就是空（完整恢复文件状态）');
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.added, 2);
    assert.equal(replaced.updated, 0);
});

// ---------- 参考图（图生图 / edits） ----------

test('normalizeGenModel：editPath 缺省空、editImageWrap 缺省 image_url，显式空串保留为裸数组', () => {
    const plain = normalizeGenModel({id: 'a', name: 'n'}, () => 'g');
    assert.equal(plain.editPath, '', '未配编辑端点 = 不支持参考图');
    assert.equal(plain.editImageWrap, GEN_IMAGE_WRAP_DEFAULT);
    assert.equal(GEN_IMAGE_WRAP_DEFAULT, 'image_url');
    const edited = normalizeGenModel({id: 'b', name: 'n', editPath: ' /v1/images/edits ', editImageWrap: ' image '}, () => 'g');
    assert.equal(edited.editPath, '/v1/images/edits', '首尾空白剥掉');
    assert.equal(edited.editImageWrap, 'image', '自定义包装字段保留');
    // 用户故意清空包装字段 = 裸字符串数组：不能被归一化悄悄改回 image_url
    assert.equal(normalizeGenModel({id: 'c', name: 'n', editImageWrap: ''}, () => 'g').editImageWrap, '');
});

test('renderGenImages：缺省包装 image_url、自定义字段、空字段裸数组、非法字段名抛错', () => {
    assert.equal(renderGenImages([], undefined), '[]');
    assert.equal(renderGenImages(['data:image/png;base64,QQ=='], undefined), '[{"image_url":"data:image/png;base64,QQ=="}]');
    assert.equal(renderGenImages(['https://a/b.png'], 'image'), '[{"image":"https://a/b.png"}]');
    assert.equal(renderGenImages(['u1', 'u2'], ''), '["u1","u2"]', '空包装字段 = 裸字符串数组');
    assert.equal(renderGenImages(['u1'], '  '), '["u1"]', '纯空白同样视为空');
    assert.equal(renderGenImages(null, 'image_url'), '[]', '非数组按空处理');
    assert.throws(() => renderGenImages(['u1'], 'bad name'), /包装字段名无效/);
    assert.throws(() => renderGenImages(['u1'], '1x'), /包装字段名无效/);
});

test('classifyGenRef：http(s) 原样、盘符/相对路径算路径、data:/file: 拒绝、空白丢弃', () => {
    assert.deepEqual(classifyGenRef('https://x.test/a.png'), {kind: 'url', value: 'https://x.test/a.png'});
    assert.equal(classifyGenRef('HTTP://x.test/a.png').kind, 'url', '协议大小写不敏感');
    assert.deepEqual(classifyGenRef('  img/a.png  '), {kind: 'path', value: 'img/a.png'});
    assert.equal(classifyGenRef('D:/work/a.png').kind, 'path', '盘符路径不是协议');
    assert.equal(classifyGenRef('D:\\work\\a.png').kind, 'path');
    assert.equal(classifyGenRef('data:image/png;base64,QQ==').kind, 'invalid', 'data URL 绕开文件授权与体积预算');
    assert.equal(classifyGenRef('file:///D:/a.png').kind, 'invalid');
    assert.equal(classifyGenRef('ftp://x/a.png').kind, 'invalid');
    assert.equal(classifyGenRef('   ').kind, 'empty');
    assert.equal(classifyGenRef(null).kind, 'empty');
});

test('dataURLBytes：base64 段长度 ×3/4，无 base64 段给 0', () => {
    // 'AAAA' 4 个 base64 字符 = 3 字节
    assert.equal(dataURLBytes('data:image/png;base64,AAAA'), 3);
    assert.equal(dataURLBytes('data:image/png;base64,AAAA\nAAAA'), 6, '换行不计入');
    assert.equal(dataURLBytes('https://x/a.png'), 0);
    assert.equal(dataURLBytes(''), 0);
    assert.equal(GEN_REF_BYTES_LIMIT, 4 << 20);
    assert.equal(GEN_REF_LIMIT, 5);
});

test('genRequestPath：带参考图走 editPath，无参考图 / 未配 editPath 回落 path', () => {
    const entry = {path: '/v1/images/generations', editPath: '/v1/images/edits'};
    assert.equal(genRequestPath(entry, {references: ['data:image/png;base64,QQ==']}), '/v1/images/edits');
    assert.equal(genRequestPath(entry, {references: []}), '/v1/images/generations');
    assert.equal(genRequestPath(entry, {}), '/v1/images/generations');
    assert.equal(genRequestPath({path: '/gen'}, {references: ['x']}), '/gen', '没配 editPath 时回落生成端点（调用方先报错）');
    assert.equal(genRequestPath(null, {references: ['x']}), '');
});

test('buildGenVars + renderGenJson：{{images}} 渲染成数组字面量，不二次加引号', () => {
    const entry = normalizeGenModel({
        id: 'e1', name: 'edits', kind: 'image',
        editPath: '/v1/images/edits', editImageWrap: 'image_url',
        bodyTemplate: '{"model":{{model}},"images":{{images}},"prompt":{{prompt}}}',
    }, () => 'g');
    const vars = buildGenVars(entry, {prompt: '把背景换成海边', references: ['data:image/png;base64,QQ==', 'https://x/a.png']});
    const body = JSON.parse(renderGenJson(entry.bodyTemplate, vars));
    assert.deepEqual(body.images, [
        {image_url: 'data:image/png;base64,QQ=='},
        {image_url: 'https://x/a.png'},
    ]);
    assert.equal(body.prompt, '把背景换成海边');
    // 无参考图：渲染成空数组（模板里有 {{images}} 也不会拼出非法 JSON）
    const emptyBody = JSON.parse(renderGenJson(entry.bodyTemplate, buildGenVars(entry, {prompt: 'x'})));
    assert.deepEqual(emptyBody.images, []);
    // 裸数组条目
    const bare = normalizeGenModel({...entry, editImageWrap: ''}, () => 'g');
    const bareBody = JSON.parse(renderGenJson(bare.bodyTemplate, buildGenVars(bare, {prompt: 'x', references: ['u1']})));
    assert.deepEqual(bareBody.images, ['u1']);
    // 模板里没有 {{images}} 时占位符词表仍合法（渲染不报错，参考图被丢弃由调用方校验）
    assert.equal(renderGenJson('{"prompt":{{prompt}}}', vars), '{"prompt":"把背景换成海边"}');
});

test('normalizeGenSnapshot：references 只留路径/URL 摘要（去空、超 5 张截断）', () => {
    const snap = normalizeGenSnapshot({
        kind: 'image', status: 'done',
        references: ['a.png', '', null, 'https://x/a.png'],
    });
    assert.deepEqual(snap.references, ['a.png', 'https://x/a.png']);
    assert.deepEqual(normalizeGenSnapshot({}).references, [], '缺省给空数组');
    const many = normalizeGenSnapshot({references: ['1', '2', '3', '4', '5', '6', '7']});
    assert.equal(many.references.length, GEN_REF_LIMIT);
});

// ---------- multipart 编辑端点（Qwen-Image / OpenAI 官方 /v1/images/edits） ----------

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('normalizeGenModel：editFormat 缺省 json、multipart 保留、非法值回落 json', () => {
    assert.equal(normalizeGenModel({name: 'a'}, () => 'g').editFormat, 'json');
    assert.equal(normalizeGenModel({name: 'b', editFormat: 'multipart'}, () => 'g').editFormat, 'multipart');
    assert.equal(normalizeGenModel({name: 'c', editFormat: 'form'}, () => 'g').editFormat, 'json');
});

test('normalizeGenModel：probePath 缺省空、去首尾空白、保留占位符', () => {
    assert.equal(normalizeGenModel({name: 'a'}, () => 'g').probePath, '');
    assert.equal(normalizeGenModel({name: 'b', probePath: '  /v1/videos/{{jobId}}/content  '}, () => 'g').probePath,
        '/v1/videos/{{jobId}}/content', '探针端点保留 {{jobId}} 占位符（轮询时才渲染）');
});

test('extractGenProducts：滤掉 null / 空串产物值（服务端常用 url:null + 独立端点）', () => {
    // 这是「任务完成却卡在取回产物」的根因：extractGenPath 返回 [null]，长度 1 被误判成有产物
    assert.deepEqual(extractGenPath({url: null}, 'url'), [null], 'extractGenPath 原样返回 null（行为不变）');
    assert.deepEqual(extractGenProducts({url: null}, 'url'), [], 'null 不算产物');
    assert.deepEqual(extractGenProducts({url: '  '}, 'url'), [], '空白串不算产物');
    assert.deepEqual(extractGenProducts({url: 'https://x/a.mp4'}, 'url'), ['https://x/a.mp4']);
    // 多值里混着空值：只保留有效的
    assert.deepEqual(extractGenProducts({data: [{url: null}, {url: 'https://x/b.png'}]}, 'data[*].url'),
        ['https://x/b.png']);
    // b64 空串同样滤掉
    assert.deepEqual(extractGenProducts({data: [{b64_json: ''}, {b64_json: 'QQ=='}]}, 'data[*].b64_json'), ['QQ==']);
});

test('buildGenMultipart：模板生成文本字段，参考图走重复的 image 文件段', () => {
    const entry = normalizeGenModel({
        name: 'qwen',
        path: '/v1/images/generations',
        editPath: '/v1/images/edits',
        editFormat: 'multipart',
        bodyTemplate: '{"model":{{model}},"prompt":{{prompt}},"size":{{size}},"num_inference_steps":40,"images":{{images}}}',
        defaultModel: 'Qwen/Qwen-Image-2.1',
        defaultSize: '1024x1024',
    }, () => 'g');
    const vars = buildGenVars(entry, {prompt: '把背景换成海边'});
    const out = buildGenMultipart(entry, vars,
        ['data:image/png;base64,' + TINY_PNG_B64, 'data:image/png;base64,' + TINY_PNG_B64],
        {boundary: 'BND'});

    assert.equal(out.contentType, 'multipart/form-data; boundary=BND');
    const body = Buffer.from(out.bodyBase64, 'base64');
    assert.equal(out.bytes, body.length);
    const text = body.toString('utf8');
    assert.ok(text.startsWith('--BND\r\n'), '首个分隔行');
    assert.ok(text.includes('name="model"\r\n\r\nQwen/Qwen-Image-2.1\r\n'), 'model 文本字段');
    assert.ok(text.includes('name="prompt"\r\n\r\n把背景换成海边\r\n'), 'prompt 按 UTF-8 写入');
    assert.ok(text.includes('name="size"\r\n\r\n1024x1024\r\n'));
    assert.ok(text.includes('name="num_inference_steps"\r\n\r\n40\r\n'), '数字字段转文本');
    assert.equal((text.match(/name="image"; filename="ref-\d+\.png"/g) || []).length, 2, '两张图 → 两个文件段');
    assert.ok(text.includes('Content-Type: image/png'), '文件段带 mime');
    assert.ok(text.endsWith('--BND--\r\n'), '结尾分隔行');
    // 模板里的 images 不重复出现在文本字段里（参考图只从 references 来）
    assert.ok(!text.includes('name="images"'), 'images 字段被跳过');
    // 图片字节原样落进 body（PNG 魔数）
    assert.ok(body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'PNG 原始字节');
});

test('buildGenMultipart：文件字段名可自定义、URL 参考图与空参考图直接报错', () => {
    const entry = normalizeGenModel({
        name: 'x', editFormat: 'multipart', editImageWrap: 'file',
        bodyTemplate: '{"prompt":{{prompt}}}',
    }, () => 'g');
    const vars = buildGenVars(entry, {prompt: 'p'});
    const out = buildGenMultipart(entry, vars, ['data:image/png;base64,' + TINY_PNG_B64], {boundary: 'B'});
    const text = Buffer.from(out.bodyBase64, 'base64').toString('utf8');
    assert.ok(text.includes('name="file"; filename="ref-1.png"'), '自定义文件字段名');

    assert.throws(() => buildGenMultipart(entry, vars, ['https://example.com/a.png'], {boundary: 'B'}),
        /需要本地图片/, 'URL 参考图在 multipart 下不可用');
    assert.throws(() => buildGenMultipart(entry, vars, [], {boundary: 'B'}), /至少一张参考图/);

    const bad = normalizeGenModel({name: 'y', editFormat: 'multipart', bodyTemplate: 'not json'}, () => 'g');
    assert.throws(() => buildGenMultipart(bad, buildGenVars(bad, {prompt: 'p'}),
        ['data:image/png;base64,' + TINY_PNG_B64], {boundary: 'B'}), /合法 JSON 对象/);
    const arr = normalizeGenModel({name: 'z', editFormat: 'multipart', bodyTemplate: '[1,2]'}, () => 'g');
    assert.throws(() => buildGenMultipart(arr, buildGenVars(arr, {prompt: 'p'}),
        ['data:image/png;base64,' + TINY_PNG_B64], {boundary: 'B'}), /必须是 JSON 对象/);
});
