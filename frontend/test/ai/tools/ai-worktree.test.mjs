import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    WORKTREE_REL_DIR,
    WORKTREE_PATCH_LIMIT,
    WORKTREE_REASON_MAX,
    normalizeWorktreeState,
    worktreeRelPath,
    pathInsideWorkspace,
    worktreeBlockText,
    formatWorktreeList,
    mainRootWriteVerdict,
    resolveWorktreeTarget,
    worktreeExportPreviewText,
    worktreeReasonCheck,
    createAIWorktree,
    predictWorktreeSlug,
    worktreeStatTotals,
} from '../../../src/ai/tools/ai-worktree.js';

test('normalizeWorktreeState：合法 / 缺 name / 非对象', () => {
    const wt = normalizeWorktreeState({
        name: 'refactor-cdef1234',
        branch: 'cadt/wt/refactor-cdef1234',
        path: 'D:/repo/.cadt/worktree/refactor-cdef1234',
        baseSha: 'abc1234567',
        createdAt: 100,
    });
    assert.equal(wt.name, 'refactor-cdef1234');
    assert.equal(wt.branch, 'cadt/wt/refactor-cdef1234');
    assert.equal(wt.path, 'D:/repo/.cadt/worktree/refactor-cdef1234');
    assert.equal(wt.baseSha, 'abc1234567');
    assert.equal(wt.createdAt, 100);

    assert.equal(normalizeWorktreeState(null), null);
    assert.equal(normalizeWorktreeState('x'), null);
    assert.equal(normalizeWorktreeState({name: '  '}), null);
    assert.equal(normalizeWorktreeState({name: 'ok', extra: 'ignored'}).extra, undefined);
    assert.equal(normalizeWorktreeState({}), null); // 缺 name 整体归一成 null
});

test('worktreeRelPath 与常量口径', () => {
    assert.equal(WORKTREE_REL_DIR, '.cadt/worktree');
    assert.equal(worktreeRelPath('demo-ab12'), '.cadt/worktree/demo-ab12');
    assert.ok(WORKTREE_PATCH_LIMIT > 0);
});

// 归属断言（批次 B）：删隔离区前比对「根 → wt.path」，根取错仓库时绝不删
test('pathInsideWorkspace：归一大小写 / 反斜杠 / 尾斜杠后按前缀断言归属', () => {
    const root = 'D:/repo';
    assert.equal(pathInsideWorkspace(root, 'D:/repo/.cadt/worktree/demo-ab12'), true);
    assert.equal(pathInsideWorkspace(root, 'd:\\REPO\\.cadt\\worktree\\demo-ab12\\'), true); // 反斜杠 + 大小写 + 尾斜杠
    assert.equal(pathInsideWorkspace(root + '/', 'D:/repo'), true, '根本身算在内');
    assert.equal(pathInsideWorkspace(root, 'D:/repo-other/.cadt/worktree/demo-ab12'), false, '同名前缀不算子目录');
    assert.equal(pathInsideWorkspace('D:/other', 'D:/repo/.cadt/worktree/demo-ab12'), false);
    assert.equal(pathInsideWorkspace('', 'D:/repo/x'), false);
    assert.equal(pathInsideWorkspace(root, ''), false);
});

test('worktreeBlockText：写清前缀 / 分支 / 不承诺测试 / export 收尾', () => {
    const block = worktreeBlockText({name: 'demo-ab12', branch: 'cadt/wt/demo-ab12'});
    assert.ok(block.startsWith('<worktree>'));
    assert.ok(block.includes('.cadt/worktree/demo-ab12'));
    assert.ok(block.includes('cadt/wt/demo-ab12'));
    assert.ok(block.includes('action=export'));
    assert.ok(block.includes('discard'));
    assert.ok(block.includes('不要改主根同名文件'));
    // 没有 worktree 时为空串（不注入）
    assert.equal(worktreeBlockText(null), '');
    assert.equal(worktreeBlockText({}), '');
});

test('formatWorktreeList：orphan 判定由会话登记算出', () => {
    const result = {
        available: true,
        items: [
            {path: 'D:/repo/.cadt/worktree/mine', relPath: '.cadt/worktree/mine', branch: 'cadt/wt/mine', underCadt: true},
            {path: 'D:/repo/.cadt/worktree/orphan', relPath: '.cadt/worktree/orphan', branch: 'cadt/wt/orphan', underCadt: true},
            {path: 'D:/elsewhere/wt', relPath: '../../elsewhere/wt', branch: 'main', underCadt: false},
        ],
    };
    const sessions = [
        {id: 's1', worktree: {name: 'mine', path: 'D:/repo/.cadt/worktree/mine'}},
        {id: 's2', _stub: true, worktree: null}, // 占位会话没有 worktree，不参与登记
    ];
    const text = formatWorktreeList(result, sessions);
    assert.ok(text.includes('.cadt/worktree/mine'));
    assert.ok(text.includes('.cadt/worktree/orphan'));
    assert.ok(!text.includes('孤儿（无会话登记') || text.split('\n').find((l) => l.includes('mine') && l.includes('孤儿')) === undefined,
        '本会话登记的 worktree 不应标孤儿');
    const orphanLine = text.split('\n').find((l) => l.includes('orphan'));
    assert.ok(orphanLine.includes('孤儿'), '孤儿条目应标记：' + orphanLine);
    // 非 .cadt/worktree 下的条目不标孤儿（用户自己的 worktree 不归我们管）
    const userLine = text.split('\n').find((l) => l.includes('elsewhere'));
    assert.ok(!userLine.includes('孤儿'));
});

test('formatWorktreeList：git 不可用时优雅降级', () => {
    const text = formatWorktreeList({available: false, reason: '不在 git 仓库内'}, []);
    assert.ok(text.includes('不在 git 仓库内'));
    const empty = formatWorktreeList({available: true, items: []}, []);
    assert.ok(empty.includes('0 个'));
});

test('formatWorktreeList：stats 参数给每个隔离区附改动统计（对比 lite）', () => {
    const result = {
        available: true,
        items: [
            {path: 'D:/repo/.cadt/worktree/a', relPath: '.cadt/worktree/a', branch: 'cadt/wt/a', underCadt: true},
            {path: 'D:/repo/.cadt/worktree/b', relPath: '.cadt/worktree/b', branch: 'cadt/wt/b', underCadt: true},
        ],
    };
    const text = formatWorktreeList(result, [], {'.cadt/worktree/a': ' 2 files changed, 5 insertions(+), 1 deletion(-)', '.cadt/worktree/b': ''});
    const aLine = text.split('\n').find((l) => l.includes('.cadt/worktree/a'));
    const bLine = text.split('\n').find((l) => l.includes('.cadt/worktree/b'));
    const aStat = text.split('\n').find((l) => l.includes('2 files changed'));
    assert.ok(aLine && aStat, '有统计的条目应附一行改动');
    assert.ok(!bLine.includes('改动'), '空统计不附加行');
    // 不传 stats（一期调用形态）不附统计、不报错
    const plain = formatWorktreeList(result, []);
    assert.ok(!plain.includes('改动：'));
});

test('worktree 写闸已迁能力快照：前缀判定由 writableRoots + subWriteVerdict 承担（此处只留主根闸）', () => {
    // agentWorktreeWriteVerdict 随能力快照重构删除（2026-11-28）：子代理 worktree 前缀
    // 由派单快照的 writableRoots 注入，判定收口到 subWriteVerdict（agent-capabilities.js）
    // 与 Go 侧 WriteBoundaryCheck。这里钉住删除事实，防止旧特判回潮。
    const src = readFileSync(new URL('../../../src/ai/tools/ai-worktree.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('agentWorktreeWriteVerdict'), '旧特判不应回归');
});

test('mainRootWriteVerdict：隔离期间主根只读——只有自己的隔离前缀与 .cadt/tmp 能写', () => {
    const wt = {name: 'demo-ab12'};
    // 自己的隔离前缀（大小写 / 正反斜杠经 aiRelPath 归一后为 /）
    assert.equal(mainRootWriteVerdict(wt, '.cadt/worktree/demo-ab12/src/a.js').verdict, 'allow');
    assert.equal(mainRootWriteVerdict(wt, '.CADT/WORKTREE/DEMO-AB12').verdict, 'allow');
    // 临时产物区
    assert.equal(mainRootWriteVerdict(wt, '.cadt/tmp/build.log').verdict, 'allow');
    assert.equal(mainRootWriteVerdict(wt, '.cadt/tmp').verdict, 'allow');
    // 主根项目文件（真机案例：补丁冲突后直接改 style.css）→ 拒绝
    const denied = mainRootWriteVerdict(wt, 'frontend/src/style.css');
    assert.equal(denied.verdict, 'deny');
    assert.ok(denied.message.includes('WORKTREE_MAIN_READONLY'));
    assert.ok(denied.message.includes('.cadt/worktree/demo-ab12/frontend/src/style.css'));
    assert.ok(denied.message.includes('action=export'));
    // 其他主根路径 / 别的隔离区 / 近似前缀
    assert.equal(mainRootWriteVerdict(wt, 'AGENTS.md').verdict, 'deny');
    assert.equal(mainRootWriteVerdict(wt, '.cadt/worktree/other/a.js').verdict, 'deny');
    assert.equal(mainRootWriteVerdict(wt, '.cadt/worktree/demo-ab12-x/a.js').verdict, 'deny');
    assert.equal(mainRootWriteVerdict(wt, '.cadt/patches/x.patch').verdict, 'deny');
    // 范围外盘符绝对路径（full 档）不属于主根，放行
    assert.equal(mainRootWriteVerdict(wt, 'D:/elsewhere/tmp.log').verdict, 'allow');
    // 单斜杠开头（根相对 / UNC / \\?\ 归一后的形状）Win32 会解析到当前盘根，
    // 可能正好命中主根：隔离期间一律拒绝（2026-11-17 复查实测）
    assert.equal(mainRootWriteVerdict(wt, '/tmp/x.log').verdict, 'deny');
    assert.equal(mainRootWriteVerdict(wt, '/frontend/src/style.css').verdict, 'deny');
    assert.equal(mainRootWriteVerdict(wt, '\\\\server\\share\\x.txt').verdict, 'deny');
    assert.equal(mainRootWriteVerdict(wt, '//?/D:/repo/frontend/src/a.js').verdict, 'deny');
    // 没有隔离区 → 不设限
    assert.equal(mainRootWriteVerdict(null, 'frontend/src/style.css').verdict, 'allow');
    assert.equal(mainRootWriteVerdict({}, 'frontend/src/style.css').verdict, 'allow');
});

test('resolveWorktreeTarget：by-name 只认本会话拥有的隔离区', () => {
    const own = {name: 'mine-ab12', branch: 'cadt/wt/mine-ab12', path: 'D:/r/.cadt/worktree/mine-ab12', baseSha: 'sha-own'};
    const subs = [{name: 'sub-1', baseSha: 'sha-1'}, {name: 'sub-2', baseSha: 'sha-2'}];
    // 缺省 = 自己的
    const def = resolveWorktreeTarget(own, subs, '');
    assert.equal(def.wt.name, 'mine-ab12');
    assert.equal(def.own, true);
    // name 命中自己 / 子代理
    assert.equal(resolveWorktreeTarget(own, subs, 'mine-ab12').own, true);
    const subHit = resolveWorktreeTarget(own, subs, 'sub-1');
    assert.equal(subHit.wt.name, 'sub-1');
    assert.equal(subHit.own, false);
    assert.equal(subHit.wt.baseSha, 'sha-1');
    // 大小写不敏感
    assert.equal(resolveWorktreeTarget(own, subs, 'SUB-2').wt.name, 'sub-2');
    // 归属外 / 不存在 → null
    assert.equal(resolveWorktreeTarget(own, subs, 'other-session'), null);
    // 没有自己的隔离区时缺省 → null；带 name 命中子代理仍可用
    assert.equal(resolveWorktreeTarget(null, subs, ''), null);
    assert.equal(resolveWorktreeTarget(null, subs, 'sub-1').wt.name, 'sub-1');
    // baseSha 缺失的登记不可信（不进命中）
    assert.equal(resolveWorktreeTarget(own, [{name: 'sub-3'}], 'sub-3'), null);
});

test('worktreeBlockText：临时文件与重定向指引（2026-11-17 实测补）', () => {
    const block = worktreeBlockText({name: 'demo-ab12', branch: 'cadt/wt/demo-ab12'});
    // 隔离区没有主根 .cadt；路径一律相对主根，与命令 cwd 无关
    assert.ok(block.includes('隔离区里没有主根的 .cadt/'));
    assert.ok(block.includes('相对范围根（主根）'));
    // 临时产物用 write_file 写主根 .cadt/tmp，不要用 ../ 猜
    assert.ok(block.includes('write_file 写到主根 .cadt/tmp/'));
    assert.ok(block.includes('不要在命令里用 ../ 猜路径'));
    // 不要用重定向把测试日志写文件再读（否则复合命令转人工）
    assert.ok(block.includes('不要用输出重定向把日志写文件再 sed 读'));
});

test('worktreeBlockText：主根只读与导出冲突指引（2026-11-17 真机补）', () => {
    const block = worktreeBlockText({name: 'demo-ab12', branch: 'cadt/wt/demo-ab12'});
    // 主根只读：写工具拒绝（.cadt/tmp 例外）
    assert.ok(block.includes('隔离期间主根只读'));
    assert.ok(block.includes('write_file / edit_file 写主根其他路径会被拒绝'));
    // 命令默认 cwd 落在隔离区；要看主根需显式 cwd=.
    assert.ok(block.includes('未显式传 cwd 时默认在 .cadt/worktree/demo-ab12 里执行'));
    assert.ok(block.includes('显式传 cwd=.'));
    // 导出预检冲突时在隔离区修正，不要直接改主根
    assert.ok(block.includes('在隔离区里按主根当前内容修正该文件后重新 export'));
    assert.ok(block.includes('绝不要直接编辑主根绕过审阅'));
});

// ---- worktree_manage AI 动作审批闸（2026-11-17 真机：AI 主动进出隔离区要接管 composer） ----

function makeWorktreeMod({scope = 'full', approval = {approved: true}, backend = {}, session = {id: 's1', title: '会话'}, calls = []} = {}) {
    const mod = createAIWorktree({
        backend: {
            GitWorktreeAdd: async (...args) => {
                calls.push({kind: 'add', args});
                return {
                    name: 'demo-ab12',
                    branch: 'cadt/wt/demo-ab12',
                    path: 'D:/repo/.cadt/worktree/demo-ab12',
                    baseSha: 'abcdef1234',
                    deps: [],
                    includeCopied: 0,
                    includeErrors: [],
                    carried: args[3] ? 3 : 0,
                };
            },
            GitWorktreeRemove: async (...args) => { calls.push({kind: 'remove', args}); },
            GitWorktreeStat: async () => ' frontend/index.html | 3 +++\n 1 file changed, 3 insertions(+)',
            ...backend,
        },
        getScopeRoot: () => 'D:/repo',
        currentSession: () => session,
        currentScopeOf: () => scope,
        persistSessions() {},
        flash() {},
        requestPatchApproval: async () => ({approved: false}),
        requestWorktreeApproval: async (s, tm, info) => {
            calls.push({kind: 'approval', info});
            // 模拟 registerPendingApproval + decideApproval 的落点：批准后 approval 已在 toolMessage 上
            if (approval && approval.approved && tm) tm.approval = {kind: 'worktree', state: 'approved', action: info.action};
            return approval;
        },
        persistApprovalMutation(session, tm) { calls.push({kind: 'persist', state: tm.approval && tm.approval.state}); },
        patchResultText: () => '',
        recordChange() {},
        notifyFileChanged() {},
        refreshToolWrap() {},
        toolHalted: () => false,
        logPermission() {},
        getSessions: () => [session],
        getSubWorktrees: () => [],
        joinPath: (...parts) => parts.join('/'),
        openDialog() {},
        closeDialog() {},
        dialogNode: () => null,
        dialogButton: () => null,
        dialogEl: null,
        isRunning: () => false,
    });
    return {mod, session};
}

test('manageTool(create)：AI 主动创建走审批卡（full 档同样）、批准后才建', async () => {
    const calls = [];
    const {mod, session} = makeWorktreeMod({scope: 'full', calls});
    const out = await mod.manageTool({session, toolMessage: {toolCallId: 'c1'}}, {action: 'create', label: 'demo', reason: '测试：隔离试改'});
    // 顺序：先审批卡，后 GitWorktreeAdd
    assert.equal(calls[0].kind, 'approval');
    assert.equal(calls[0].info.action, 'create');
    assert.equal(calls[0].info.label, 'demo');
    assert.equal(calls[1].kind, 'add');
    assert.equal(session.worktree.name, 'demo-ab12');
    assert.ok(out.includes('已创建隔离工作区'));
});

test('manageTool(create)：审批拒绝/取消时不建 worktree', async () => {
    const calls = [];
    const {mod, session} = makeWorktreeMod({approval: {approved: false}, calls});
    const out = await mod.manageTool({session, toolMessage: {toolCallId: 'c2'}}, {action: 'create', label: 'demo', reason: '测试：拒绝路径'});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'approval');
    assert.equal(session.worktree, undefined);
    assert.ok(out.includes('取消了隔离工作区创建'));
});

test('manageTool(discard)：AI 主动丢弃走审批卡并附改动统计，批准后才删', async () => {
    const calls = [];
    const {mod, session} = makeWorktreeMod({calls});
    session.worktree = {name: 'demo-ab12', branch: 'cadt/wt/demo-ab12', path: 'D:/repo/.cadt/worktree/demo-ab12', baseSha: 'abcdef1234', createdAt: 1};
    const out = await mod.manageTool({session, toolMessage: {toolCallId: 'c3'}}, {action: 'discard', reason: '测试：收尾清理'});
    assert.equal(calls[0].kind, 'approval');
    assert.equal(calls[0].info.action, 'discard');
    assert.equal(calls[0].info.name, 'demo-ab12');
    assert.equal(calls[0].info.stat, '+3 −0 · 1 文件');
    assert.equal(calls[1].kind, 'remove');
    assert.equal(session.worktree, null);
    assert.ok(out.includes('已丢弃隔离工作区'));
});

test('manageTool(create)：审批通过后创建失败要把 approval 落成 failed（不再假成功）', async () => {
    const calls = [];
    const {mod, session} = makeWorktreeMod({
        calls,
        backend: {
            GitWorktreeAdd: async () => {
                throw new Error('boom');
            },
        },
    });
    const tm = {toolCallId: 'c4'};
    const out = await mod.manageTool({session, toolMessage: tm}, {action: 'create', reason: '测试：创建失败落定'});
    assert.equal(tm.approval.state, 'failed');
    assert.equal(tm.approval.error, 'boom');
    // 落定必须经过 persistApprovalMutation（卡片/持久化同步）
    assert.ok(calls.some((c) => c.kind === 'persist' && c.state === 'failed'));
    assert.ok(out.includes('创建失败'));
});

test('manageTool(create)：carry=true 传给后端，结果说明带入量与快照基准', async () => {
    const calls = [];
    const {mod, session} = makeWorktreeMod({calls});
    const out = await mod.manageTool({session, toolMessage: {toolCallId: 'c6'}}, {action: 'create', carry: true, reason: '测试：带未提交改动试改'});
    const addCall = calls.find((c) => c.kind === 'add');
    assert.equal(addCall.args[3], true, 'carry 应作为第 4 参传给 GitWorktreeAdd');
    assert.ok(out.includes('带入 3 个未提交改动'), out);
    assert.ok(out.includes('快照'), out);
});

test('manageTool(discard)：隔离区内有活终端时拒绝，不进审批也不删', async () => {
    const calls = [];
    const wtPath = 'D:/repo/.cadt/worktree/demo-ab12';
    const {mod, session} = makeWorktreeMod({
        calls,
        backend: {
            TermList: async () => [
                {id: 't1', shell: 'pwsh', cwd: wtPath + String.fromCharCode(92) + 'frontend', exited: false},
                {id: 't2', shell: 'pwsh', cwd: 'D:/elsewhere', exited: false},
                {id: 't3', shell: 'pwsh', cwd: wtPath, exited: true}, // 已退出的不算占用
            ],
        },
    });
    session.worktree = {name: 'demo-ab12', branch: 'cadt/wt/demo-ab12', path: wtPath, baseSha: 'sha', createdAt: 1};
    const out = await mod.manageTool({session, toolMessage: {toolCallId: 'c7'}}, {action: 'discard', reason: '测试：终端占用'});
    assert.ok(out.includes('WORKTREE_TERMINAL'), out);
    assert.ok(!calls.some((c) => c.kind === 'approval'), '不应进入审批卡');
    assert.ok(!calls.some((c) => c.kind === 'remove'), '不应执行删除');
});

// ---- predictWorktreeSlug：创建卡显示真实路径（复刻 Go deriveSlug / alnumTail） ----

test('predictWorktreeSlug：与 Go deriveSlug 同规则（清洗/截断/会话尾号）', () => {
    assert.equal(predictWorktreeSlug('', 'mwki81a5gkdgj'), 'wt-1a5gkdgj');
    assert.equal(predictWorktreeSlug('Refactor Parser', 'mwki81a5gkdgj'), 'refactor-parser-1a5gkdgj');
    // CJK 折成 -（按码点，不能截 byte）：清洗后为空回落 wt
    assert.equal(predictWorktreeSlug('器 物', 'mwki81a5gkdgj'), 'wt-1a5gkdgj');
    // 连续分隔符折成一个 -、首尾 - 修剪
    assert.equal(predictWorktreeSlug('refactor---', 'mwki81a5gkdgj'), 'refactor-1a5gkdgj');
    // 超长截 32（不含会话尾号）
    const long = predictWorktreeSlug('a'.repeat(40), '');
    assert.equal(long.length, 32);
    assert.equal(long, 'a'.repeat(32));
    // 无会话 id：只有 base
    assert.equal(predictWorktreeSlug('demo', ''), 'demo');
});

// ---- worktreeStatTotals：丢弃卡/信息卡的「+xx −xx · N 文件」紧凑汇总 ----

test('worktreeStatTotals：多文件 / 单文件纯增删 / 空文本 / 解析失败', () => {
    const multi = worktreeStatTotals(' frontend/index.html | 36 +++---\n frontend/src/style.css | 35 +++---\n 3 files changed, 45 insertions(+), 39 deletions(-)');
    assert.deepEqual(multi, {files: 3, added: 45, removed: 39, label: '+45 −39 · 3 文件'});
    // 单文件只有删除：summary 行没有 insertions 段
    const delOnly = worktreeStatTotals(' a.txt | 1 -\n 1 file changed, 1 deletion(-)');
    assert.deepEqual(delOnly, {files: 1, added: 0, removed: 1, label: '+0 −1 · 1 文件'});
    assert.equal(worktreeStatTotals('').label, '');
    assert.equal(worktreeStatTotals(null).label, '');
    // 没有 summary 行（解析不出）→ 空串，不把逐文件行当数字
    assert.equal(worktreeStatTotals(' frontend/src/style.css | 35 +++---').label, '');
});

// ---- worktreeReasonCheck：create / discard 的必填原因（显示在审批卡上）----

test('worktreeReasonCheck：必填 / 长度上限 / trim', () => {
    // 缺失一律报错（create 与 discard 共用同一校验）
    assert.match(worktreeReasonCheck('').error, /缺少 reason/);
    assert.match(worktreeReasonCheck(null).error, /缺少 reason/);
    assert.match(worktreeReasonCheck(undefined).error, /缺少 reason/);
    assert.match(worktreeReasonCheck('   ').error, /缺少 reason/);
    // 数字会被 aiTextOf 转成字符串，属于「有内容」——不拦（这里只校验空值）
    assert.deepEqual(worktreeReasonCheck(12345), {reason: '12345'});

    // 正常：返回 trim 后的原文
    assert.deepEqual(worktreeReasonCheck('  重构解析器，先隔离试改  '), {reason: '重构解析器，先隔离试改'});

    // 恰好到上限通过
    const atLimit = 'a'.repeat(WORKTREE_REASON_MAX);
    assert.equal(worktreeReasonCheck(atLimit).reason.length, WORKTREE_REASON_MAX);

    // 超一字符即拒绝，报错里带实际字数与上限
    const over = 'a'.repeat(WORKTREE_REASON_MAX + 1);
    const err = worktreeReasonCheck(over).error;
    assert.match(err, /reason 过长/);
    assert.match(err, new RegExp(String(WORKTREE_REASON_MAX + 1)));
    assert.match(err, new RegExp(String(WORKTREE_REASON_MAX)));

    // 中文按字符计数（不是字节）：上限个字的中文应通过
    const cjk = '改'.repeat(WORKTREE_REASON_MAX);
    assert.equal(worktreeReasonCheck(cjk).reason.length, WORKTREE_REASON_MAX, 'CJK 按字符计数');
});


// ---- worktreeExportPreviewText：merge-tree 三栏预检回执（体量护栏）----

test('worktreeExportPreviewText：三栏分类与回执结构', () => {
    const wt = {name: 'demo-ab12'};
    const mp = {
        supported: true,
        clean: false,
        applicable: ['new.txt', 'src/main.js'],
        alreadyApplied: ['docs/README.md'],
        conflicted: [
            {path: 'a.txt', reasons: ['CONFLICT (content): Merge conflict in a.txt']},
            {path: 'lib/heavy.js', reasons: []},
        ],
        reportPath: 'D:/repo/.cadt/export-reports/export-report-demo-ab12-20261119-140000.md',
    };
    const text = worktreeExportPreviewText(wt, mp);
    const lines = text.split('\n');
    // 汇总行：总数字
    assert.ok(lines[0].includes('改动共 5 个文件'), lines[0]);
    assert.ok(lines[0].includes('未写入主根'));
    // 三栏都在
    assert.ok(text.includes('真冲突（需在隔离区重做后重新 export） 2 个'));
    assert.ok(text.includes('· a.txt（CONFLICT (content): Merge conflict in a.txt）'));
    assert.ok(text.includes('本次可应用 2 个'));
    assert.ok(text.includes('已在主根（无需重做） 1 个'));
    // 报告路径与「按需读」指引
    assert.ok(text.includes('.cadt/export-reports/export-report-demo-ab12-20261119-140000.md'));
    assert.ok(text.includes('read_file'));
    // 出路指引：在隔离区重做 + 主根只读
    assert.ok(text.includes('在 .cadt/worktree/demo-ab12/ 里按主根当前内容重做'));
    assert.ok(text.includes('不要直接改主根'));
    // 回执行数有界（护栏：≤60 行）
    assert.ok(lines.length <= 60, '回执超 60 行：' + lines.length);
});

test('worktreeExportPreviewText：全部已应用 → 无需重做，不出真冲突栏', () => {
    const text = worktreeExportPreviewText({name: 'demo-ab12'}, {
        supported: true,
        clean: true,
        applicable: [],
        alreadyApplied: ['a.txt', 'b.txt'],
        conflicted: [],
        reportPath: 'D:/r.md',
    });
    assert.ok(text.includes('已在主根（无需重做） 2 个'));
    assert.ok(text.includes('· a.txt'));
    assert.ok(!text.includes('真冲突'));
    assert.ok(!text.includes('本次可应用'));
});

test('worktreeExportPreviewText：清单超上限折叠为计数（体量护栏）', () => {
    const conflicted = Array.from({length: 30}, (_, i) => ({path: 'f' + i + '.txt', reasons: []}));
    const applicable = Array.from({length: 25}, (_, i) => 'g' + i + '.txt');
    const already = Array.from({length: 15}, (_, i) => 'h' + i + '.txt');
    const text = worktreeExportPreviewText({name: 'demo-ab12'}, {
        supported: true, clean: false, applicable, alreadyApplied: already, conflicted, reportPath: 'D:/r.md',
    });
    const lines = text.split('\n');
    assert.ok(lines.length <= 60, '大冲突场景回执必须仍有界：' + lines.length);
    assert.ok(text.includes('真冲突（需在隔离区重做后重新 export） 30 个'));
    assert.ok(text.includes('另有 10 个见报告文件')); // 30 - 20
    assert.ok(text.includes('另有 5 个见报告文件'));  // 25 - 20
    assert.ok(text.includes('另有 5 个见报告文件'));  // 15 - 10
    assert.ok(!text.includes('f29.txt'), '折叠外的文件名不进回执');
    assert.ok(!text.includes('g24.txt'));
    assert.ok(!text.includes('h14.txt'));
});

test('worktreeExportPreviewText：报告落盘失败时如实带出原因', () => {
    const text = worktreeExportPreviewText({name: 'demo-ab12'}, {
        supported: true, clean: false,
        applicable: [], alreadyApplied: [], conflicted: [{path: 'a.txt', reasons: []}],
        reportErr: '磁盘只读',
    });
    assert.ok(text.includes('全量报告落盘失败：磁盘只读'));
});

test('normalizeWorktreeState：lastExportReport / lastExportPreviewAt 透传（导出状态标记）', () => {
    const wt = normalizeWorktreeState({
        name: 'demo-ab12',
        lastExportReport: 'D:/repo/.cadt/export-reports/r.md',
        lastExportPreviewAt: 1234567890,
    });
    assert.equal(wt.lastExportReport, 'D:/repo/.cadt/export-reports/r.md');
    assert.equal(wt.lastExportPreviewAt, 1234567890);
    assert.equal(normalizeWorktreeState({name: 'demo-ab12'}).lastExportReport, '');
    assert.equal(normalizeWorktreeState({name: 'demo-ab12'}).lastExportPreviewAt, 0);
});
