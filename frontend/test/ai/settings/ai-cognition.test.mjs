// ai-cognition.test.mjs —— 认知索引前端域的纯函数守卫（§8 验证矩阵的注入 / 提醒 / 回执三行）。
// 覆盖：只注入一次判定（含压缩后重注）、needsReread 回执、overview 三级降级、
// 维护提醒的积累 / 清账 / 去重方向、覆盖判定（目录条目前缀）、写类工具触碰路径提取。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OVERVIEW_BODY_BUDGET,
    createAICognition,
    renderOverviewBlock,
    resolveNeedsReread,
    shouldInjectCognitionOverview,
    shouldNudgeCognition,
    coveredByIndex,
    normalizeRelKey,
    touchedPathsOfCall,
    cognitionRulesText,
} from '../../../src/ai/settings/ai-cognition.js';

const msg = (role, content, extra = {}) => ({role, content, ...extra});

test('shouldInjectCognitionOverview：只在无 cognition_index 块时为真', () => {
    assert.equal(shouldInjectCognitionOverview([]), true);
    assert.equal(shouldInjectCognitionOverview([msg('user', 'hello')]), true);
    // 块随起轮的用户消息落盘：出现在 user 消息里 → 已注入过
    assert.equal(shouldInjectCognitionOverview([
        msg('assistant', 'ok'),
        msg('user', '<system-reminder>\n<cognition_index>\nsrc/\n</cognition_index>\n</system-reminder>\n\n继续'),
    ]), false);
    // 出现在工具结果 / 助手回复里不算（只认 user 正文）
    assert.equal(shouldInjectCognitionOverview([
        msg('assistant', '我读了 <cognition_index>'),
        {role: 'tool', name: 'cognition_read', content: '<cognition_index>x'},
    ]), true);
});

test('resolveNeedsReread：登记缺失 / 指纹不一致都算需要重读', () => {
    assert.equal(resolveNeedsReread(undefined, 'fp1'), true);
    assert.equal(resolveNeedsReread('fp1', 'fp1'), false);
    assert.equal(resolveNeedsReread('fp0', 'fp1'), true);
    assert.equal(resolveNeedsReread('fp1', ''), false); // 无当前卷 → 无需重读
});

test('renderOverviewBlock 三级降级：全量 → 目录条目 → 顶层目录', () => {
    const small = {
        lines: [
            {path: 'src/a.js', labels: ['hot'], dir: false},
            {path: 'src/pkg/', dir: true},
        ],
    };
    const r1 = renderOverviewBlock(small, 1000);
    assert.equal(r1.tier, 1);
    assert.match(r1.text, /src\/a\.js \[hot\]/);
    assert.match(r1.text, /src\/pkg\//);

    // 超预算 → 只剩目录条目（tier 2）
    const big = {lines: []};
    for (let i = 0; i < 30; i++) {
        big.lines.push({path: 'src/deep/file' + i + '.js', labels: ['x'.repeat(30)], dir: false});
    }
    for (let i = 0; i < 5; i++) {
        big.lines.push({path: 'src/pkg' + i + '/', dir: true});
    }
    const r2 = renderOverviewBlock(big, 1000);
    assert.equal(r2.tier, 2);
    assert.match(r2.text, /src\/pkg0\//);
    assert.doesNotMatch(r2.text, /src\/deep\/file0\.js/);

    // 目录条目也超 → 顶层目录（深度 ≤ 2，tier 3）
    const huge = {lines: []};
    for (let i = 0; i < 200; i++) {
        huge.lines.push({path: 'a' + (i % 40) + '/b' + (i % 5) + '/c' + i + '.go', dir: false});
        huge.lines.push({path: 'a' + (i % 40) + '/b' + (i % 5) + '/', dir: true});
    }
    const r3 = renderOverviewBlock(huge, 1000);
    assert.equal(r3.tier, 3);
    for (const line of r3.text.split('\n')) {
        const segs = line.replace(/\/$/, '').split('/');
        assert.ok(segs.length <= 2, '顶层目录深度 ≤2：' + line);
    }
    assert.equal(renderOverviewBlock({lines: []}).text, '');
});

test('coveredByIndex：文件条目精确命中 + 目录条目前缀覆盖（大小写与分隔符归一）', () => {
    const lines = [
        {path: 'internal/cognition/service.go', dir: false},
        {path: 'src/utils/', dir: true},
    ];
    assert.equal(coveredByIndex('internal/cognition/service.go', lines), true);
    assert.equal(coveredByIndex('INTERNAL\\COGNITION\\SERVICE.GO', lines), true);
    assert.equal(coveredByIndex('./internal/cognition/service.go', lines), true);
    assert.equal(coveredByIndex('src/utils/helper.js', lines), true); // 目录条目覆盖
    assert.equal(coveredByIndex('src/utilsx/other.js', lines), false); // 前缀不误伤
    assert.equal(coveredByIndex('other/main.go', lines), false);
    assert.equal(normalizeRelKey('.\\A\\B.js'), 'a/b.js');
});

test('touchedPathsOfCall：write/edit 取 path，apply_patch 从补丁头提取', () => {
    assert.deepEqual(touchedPathsOfCall('write_file', {path: 'a.go'}), ['a.go']);
    assert.deepEqual(touchedPathsOfCall('edit_file', {path: 'src\\b.js'}), ['src\\b.js']);
    assert.deepEqual(touchedPathsOfCall('read_file', {path: 'c.go'}), []);
    assert.deepEqual(touchedPathsOfCall('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: src/a.js\n+x\n*** Add File: new.js\n+y\n*** End Patch\n',
    }), ['src/a.js', 'new.js']);
    // arguments 为 JSON 字符串（部分通道）也能解析
    assert.deepEqual(touchedPathsOfCall('write_file', JSON.stringify({path: 'd.go'})), ['d.go']);
});

function userMsgWithNudge() {
    return msg('user', '<system-reminder>\n<cognition_nudge>\na.go\n</cognition_nudge>\n</system-reminder>\n\n继续');
}

test('shouldNudgeCognition：覆盖内改动积累、edit 清账、提醒过的批次不重复', () => {
    const lines = [
        {path: 'a.go', dir: false},
        {path: 'b.go', dir: false},
    ];
    const toolCall = (name, args) => ({role: 'assistant', toolCalls: [{name, arguments: args}]});
    const toolDone = (name) => ({role: 'tool', name, status: 'done', content: 'ok'});

    // 改了 a.go（有条目）+ zzz-not-indexed.go（不在索引）→ 只提醒 a.go
    let hit = shouldNudgeCognition([toolCall('write_file', {path: 'a.go'}), toolCall('write_file', {path: 'zzz-not-indexed.go'})], lines);
    assert.ok(hit && hit.count === 1 && hit.paths[0] === 'a.go', '未覆盖文件不提醒：' + JSON.stringify(hit));

    // 之后成功的 cognition_edit 清账 → 不再提醒
    hit = shouldNudgeCognition([
        toolCall('write_file', {path: 'a.go'}),
        toolDone('cognition_edit'),
    ], lines);
    assert.equal(hit, null);

    // 提醒过后同批文件不再重复（nudge 块出现在下一轮用户消息里）
    hit = shouldNudgeCognition([
        toolCall('write_file', {path: 'b.go'}),
        userMsgWithNudge(),
    ], lines);
    assert.equal(hit, null);

    // 提醒后又改新文件 → 重新提醒
    hit = shouldNudgeCognition([
        toolCall('write_file', {path: 'b.go'}),
        userMsgWithNudge(),
        toolCall('write_file', {path: 'a.go'}),
    ], lines);
    assert.ok(hit && hit.paths[0] === 'a.go', '新改动重新积累');

    // edit 失败（status != done）不清账
    hit = shouldNudgeCognition([
        toolCall('write_file', {path: 'a.go'}),
        {role: 'tool', name: 'cognition_edit', status: 'error', content: 'x'},
    ], lines);
    assert.ok(hit && hit.count === 1);

    // 无索引（空 lines）→ 永不提醒
    assert.equal(shouldNudgeCognition([toolCall('write_file', {path: 'a.go'})], []), null);
});

test('cognitionRulesText 两态：启用态讲职责与分工，关闭态给审批卡入口', () => {
    const on = cognitionRulesText(true);
    assert.match(on, /<cognition_rules>/);
    assert.match(on, /cognition_edit/);
    assert.match(on, /session_search/);
    const off = cognitionRulesText(false);
    assert.match(off, /cognition_toggle \{enabled:true\}/);
    assert.match(off, /审批/);
    assert.doesNotMatch(off, /职责不是可选项/);
});

test('overview 注入正文预算默认值与方案口径一致（4–6K 字符带余量）', () => {
    assert.ok(OVERVIEW_BODY_BUDGET >= 4000 && OVERVIEW_BODY_BUDGET <= 5500);
});

// ---- 预取缓存分桶（批次 E5）：单槽 → Map<workspaceKey, snapshot> ----
// 单槽的实测缺陷：两窗口 / 两会话各绑不同工作区、用户在两处交替起轮时，每轮都把对方的
// 槽冲掉——预取缓存永远 miss，「起轮前刷一次」等于每轮白跑一遍后端读。
function fakeCognitionBackend(byWs) {
    const calls = [];
    return {
        calls,
        async CognitionRead(ws) {
            calls.push(ws);
            const snapshot = byWs[ws];
            if (!snapshot) return JSON.stringify({exists: false});
            return JSON.stringify({exists: true, scene: 'code', entries: snapshot.lines.length, lines: snapshot.lines});
        },
    };
}

test('overview 预取缓存按工作区分桶：两会话交替起轮不互相清空', async () => {
    const backend = fakeCognitionBackend({
        'D:/a': {lines: [{path: 'a/only.js', dir: false}]},
        'D:/b': {lines: [{path: 'b/only.js', dir: false}]},
    });
    const mod = createAICognition({
        settings: {aiCognition: true},
        backend,
        getScopeRoot: () => 'D:/window',
        scopeRootOf: (session) => (session && session.workspace) || '',
    });
    const a = {id: 's1', workspace: 'D:/a', messages: []};
    const b = {id: 's2', workspace: 'D:/b', messages: []};
    await mod.prefetchTurnCache(a);
    await mod.prefetchTurnCache(b);
    // 两个卷同时在缓存里（单槽时代第二个会把第一个冲掉，这里读到的是空 index）
    assert.match(mod.turnBlocks(a).index, /a\/only\.js/);
    assert.match(mod.turnBlocks(b).index, /b\/only\.js/);
    assert.equal(backend.calls.length, 2, '交替消费不该触发重读');
});

test('overview 缓存键与 Go 分桶同口径：同一目录换个拼写不另开一格', async () => {
    const backend = fakeCognitionBackend({'D:/repo': {lines: [{path: 'x.js', dir: false}]}});
    const mod = createAICognition({
        settings: {aiCognition: true},
        backend,
        getScopeRoot: () => '',
        scopeRootOf: (session) => session.workspace,
    });
    await mod.prefetchTurnCache({id: 's', workspace: 'D:/repo', messages: []});
    // 尾斜杠 + 大小写变化 → workspaceKey 归一后仍是同一桶
    assert.match(mod.turnBlocks({id: 's', workspace: 'd:/repo/', messages: []}).index, /x\.js/);
    assert.equal(backend.calls.length, 1);
});

test('overview 缓存上限 8：第 9 个工作区进来后最旧的桶被淘汰', async () => {
    const byWs = {};
    for (let i = 0; i < 9; i += 1) byWs['D:/w' + i] = {lines: [{path: 'f' + i + '.js', dir: false}]};
    const backend = fakeCognitionBackend(byWs);
    const mod = createAICognition({
        settings: {aiCognition: true},
        backend,
        getScopeRoot: () => '',
        scopeRootOf: (session) => session.workspace,
    });
    const sessions = [];
    for (let i = 0; i < 9; i += 1) {
        const session = {id: 's' + i, workspace: 'D:/w' + i, messages: []};
        sessions.push(session);
        await mod.prefetchTurnCache(session);
    }
    assert.match(mod.turnBlocks(sessions[8]).index, /f8\.js/);
    assert.match(mod.turnBlocks(sessions[1]).index, /f1\.js/);
    assert.equal(mod.turnBlocks(sessions[0]).index, '', '最旧的桶被淘汰，不会无限增长');
});

test('无 scopeRootOf 注入时回落 getScopeRoot（旧宿主行为不变）', async () => {
    const backend = fakeCognitionBackend({'D:/win': {lines: [{path: 'w.js', dir: false}]}});
    const mod = createAICognition({settings: {aiCognition: true}, backend, getScopeRoot: () => 'D:/win'});
    await mod.prefetchTurnCache({id: 's', messages: []});
    assert.match(mod.turnBlocks({id: 's', messages: []}).index, /w\.js/);
});

