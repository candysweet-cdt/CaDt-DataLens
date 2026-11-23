// ai-plan-file 纯函数测试：分节拼装 / 固定命名 / activePlan 归一 / 回注块。
// 重点锁住四件事：同会话固定路径（修订轮覆盖同一份）、planMarkdownFrom 的分节拼装
// （body 自由 Markdown、顶层 ## 降级）、normalizePlanSections 归一、planReferenceBlock 只认 activePlan。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PLAN_DIR_REL,
    PLAN_PREVIEW_CHARS,
    planDigest,
    planDisplayPath,
    planFileBody,
    planFileRelPath,
    planMarkdownFrom,
    planPreviewSlice,
    planReferenceBlock,
    planAwaitingUserReply,
    normalizeActivePlan,
    normalizePlanSections,
    planSectionsChars,
    planSessionSlug,
    planStamp,
    planTitleOf,
} from '../../../src/ai/core/ai-plan-file.js';

const PLAN_TEXT = '# 底部面板新视图「Git 图谱」一期\n\n## 目标与现状\n\n在底部面板加一个泳道视图。\n';

test('planTitleOf 取首个 ATX 标题，退化到首行非空文本', () => {
    assert.equal(planTitleOf(PLAN_TEXT), '底部面板新视图「Git 图谱」一期');
    assert.equal(planTitleOf('先做 A，再做 B\n\n- 细节'), '先做 A，再做 B');
    assert.equal(planTitleOf('- 第一步：读代码'), '第一步：读代码');
    assert.equal(planTitleOf('   \n\n'), '');
    assert.equal(planTitleOf(null), '');
});

test('planStamp：本地时间秒级（只用于来源注释，不参与文件名）', () => {
    const ts = new Date(2026, 10, 16, 5, 23, 7).getTime();
    assert.equal(planStamp(ts), '20261116-052307');
});

test('planSessionSlug：清洗为文件名安全字符，空值回落 session', () => {
    assert.equal(planSessionSlug('abc-123'), 'abc-123');
    assert.equal(planSessionSlug('session:with/slashes'), 'session-with-slashes');
    assert.equal(planSessionSlug('  '), 'session');
    assert.equal(planSessionSlug(null), 'session');
    assert.equal(planSessionSlug('---'), 'session');
});

test('planFileRelPath：按会话固定路径（同会话永远覆盖同一份）', () => {
    const rel = planFileRelPath('sess_plan-1');
    assert.equal(rel, PLAN_DIR_REL + '/plan-sess_plan-1.md');
    assert.equal(planFileRelPath('sess_plan-1'), rel, '同一会话算出同一路径（不随时间 / 标题漂移）');
    assert.equal(planFileRelPath(''), PLAN_DIR_REL + '/plan-session.md');
});

test('planDisplayPath：绝对路径切出 .cadt/plan 一段，其它回落文件名', () => {
    assert.equal(planDisplayPath('D:\\ws\\.cadt\\plan\\plan-s1.md'), '.cadt/plan/plan-s1.md');
    assert.equal(planDisplayPath('/home/u/ws/.cadt/plan/a.md'), '.cadt/plan/a.md');
    assert.equal(planDisplayPath('D:\\ws\\notes\\a.md'), 'a.md');
    assert.equal(planDisplayPath(''), '');
});

test('planDigest：标题 / 行数 / 去空白字数', () => {
    const d = planDigest(PLAN_TEXT);
    assert.equal(d.title, '底部面板新视图「Git 图谱」一期');
    assert.equal(planDigest('').lines, 0);
    assert.equal(planDigest('').chars, 0);
});

test('planFileBody：正文保留原文并附来源注释', () => {
    const body = planFileBody(PLAN_TEXT, {ts: new Date(2026, 10, 16, 5, 23, 7).getTime(), title: '会话 A'});
    assert.ok(body.startsWith('# 底部面板新视图「Git 图谱」一期'));
    assert.ok(body.includes('<!-- 计划由 CaDt-DataLens 生成 · 20261116-052307 · 会话「会话 A」 -->'));
    assert.ok(planFileBody('正文').endsWith('\n'));
});

test('planMarkdownFrom：分节拼成完整文档，body 内可自由用子标题', () => {
    const md = planMarkdownFrom({
        title: 'Git 图谱',
        sections: [
            {heading: '目标与现状', body: '在底部面板加 Git 图谱视图。现有 agent 卡片只能看单代理。'},
            {
                heading: '实现',
                body: '### 1. 纯函数 ai-team-model.js（新增）\n- buildTeamTree(mainAgent, agents) 复用 buildAgentTree\n### 2. 视图 ai-team-view.js\n- mountTeamView 建视图并渲染',
            },
            {heading: '实施步骤', body: '- Go 侧算泳道拓扑\n- 前端渲染 SVG\n- 接入底部面板'},
            {heading: '验证方式', body: '- go test ./internal/gitinfo\n- 手动打开面板核对'},
        ],
    });
    assert.ok(md.startsWith('# Git 图谱'));
    assert.ok(md.includes('## 目标与现状'));
    assert.ok(md.includes('## 实现'));
    // body 内的 ### 子标题原样保留（层级更深，像 ZCode 的按组件分节）
    assert.ok(md.includes('### 1. 纯函数 ai-team-model.js（新增）'));
    assert.ok(md.includes('- buildTeamTree(mainAgent, agents) 复用 buildAgentTree'));
    assert.ok(md.includes('## 实施步骤'));
    assert.ok(md.includes('## 验证方式'));
    // body 里模型失误写了顶层 ## 会被降为 ###（# 标题之外不出现同级标题）
    const md2 = planMarkdownFrom({title: 'T', sections: [{heading: 'A', body: 'x\n## 跑飞了\ny'}]});
    assert.ok(!/^## 跑飞了$/m.test(md2), 'body 里的 ## 必须降级');
    assert.ok(md2.includes('### 跑飞了'));
    // 缺 title 回落到首节内容的标题
    const md3 = planMarkdownFrom({sections: [{heading: 'A', body: '给设置页换列表视图'}]});
    assert.ok(md3.startsWith('# 给设置页换列表视图'));
    assert.ok(planMarkdownFrom(null).startsWith('# 实施计划'));
});

test('normalizePlanSections：heading 清洗、空节剔除、body 非法 ## 降级', () => {
    const sections = normalizePlanSections([
        {heading: '## 已经带了井号', body: '内容 A'},
        {heading: '  ', body: '内容 B'},
        {heading: '空 body', body: '   '},
        null,
        {heading: '正常', body: '内容 C'},
    ]);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].heading, '已经带了井号');
    assert.equal(sections[1].heading, '未命名小节');
    assert.equal(sections[2].heading, '正常');
    assert.deepEqual(normalizePlanSections(null), []);
    assert.deepEqual(normalizePlanSections('不是数组'), []);
});

test('planSectionsChars：合计去空白字数', () => {
    assert.equal(planSectionsChars([{heading: 'A', body: 'a b\nc'}]), 3);
    assert.equal(planSectionsChars(null), 0);
    assert.equal(planSectionsChars([{heading: 'A', body: ''}]), 0);
});

test('normalizeActivePlan：白名单归一，markdown 为空视为没有计划', () => {
    const plan = normalizeActivePlan({
        title: 'Git 图谱', markdown: PLAN_TEXT, status: 'weird', ts: 123,
        fileRel: '.cadt/plan/plan-s1.md', extraField: 1,
    });
    assert.equal(plan.status, 'pending', 'status 只认 approved，其余回落 pending');
    assert.equal('extraField' in plan, false, '白名单外字段不得透传');
    assert.equal(plan.ts, 123);
    assert.equal(plan.title, 'Git 图谱');
    assert.equal(normalizeActivePlan(null), null);
    assert.equal(normalizeActivePlan({markdown: '   '}), null, '空正文不算计划');
});

test('normalizeActivePlan：declaredCommands 条目归一与脏数据兜底', () => {
    const plan = normalizeActivePlan({
        markdown: PLAN_TEXT,
        declaredCommands: [
            {command: 'go test ./...', purpose: '后端测试', mode: 'family', signature: 'go test'},
            {command: 'node scripts/x.mjs', mode: 'exact', dangerous: false, junk: 1},
            {command: 'rm -rf /', mode: null, dangerous: true, dangerLabel: '递归强删', reason: '危险命令执行时仍需单次确认'},
            {command: '   ', mode: 'exact'},
            {command: 'x'.repeat(201)},
            'not-an-object',
            null,
            {mode: 'family', signature: 'go test'},
            {command: 'go vet ./...', mode: 'family'},
        ],
    });
    assert.equal(plan.declaredCommands.length, 4);
    assert.equal(plan.declaredCommands[0].signature, 'go test');
    assert.equal(plan.declaredCommands[0].purpose, '后端测试');
    assert.equal(plan.declaredCommands[1].mode, 'exact');
    assert.equal('junk' in plan.declaredCommands[1], false, '条目内白名单外字段不得透传');
    assert.equal(plan.declaredCommands[2].dangerous, true);
    assert.equal(plan.declaredCommands[2].dangerLabel, '递归强删');
    assert.equal(plan.declaredCommands[3].mode, null, 'family 缺 signature 降级为不预授权');
    const bare = normalizeActivePlan({markdown: PLAN_TEXT});
    assert.equal('declaredCommands' in bare, false, '无申报时不出字段');
    const over = normalizeActivePlan({
        markdown: PLAN_TEXT,
        declaredCommands: Array.from({length: 12}, (_, i) => ({command: 'node scripts/t' + i + '.mjs', mode: 'exact'})),
    });
    assert.equal(over.declaredCommands.length, 8, '申报上限 8 条');
});

function mkPlan(overrides) {
    return Object.assign({
        title: 'Git 图谱',
        markdown: PLAN_TEXT,
        status: 'pending',
        ts: 123,
    }, overrides);
}

test('planReferenceBlock：未压缩（无 summary）不注入——计划还在对话上下文里', () => {
    assert.equal(planReferenceBlock(null), '');
    assert.equal(planReferenceBlock({summary: null, activePlan: mkPlan()}), '');
    assert.equal(planReferenceBlock({summary: {text: '  '}, activePlan: mkPlan()}), '');
});

test('planReferenceBlock：压缩后注入 activePlan 文档，按状态区分提示', () => {
    const block = planReferenceBlock({summary: {text: '摘要'}, activePlan: mkPlan()});
    assert.ok(block.startsWith('<plan_reference>') && block.endsWith('</plan_reference>'));
    assert.ok(block.includes(PLAN_TEXT), '回注的是 activePlan.markdown');
    assert.ok(block.includes('尚未批准'));
    // 已批准：提示文件路径
    const approved = planReferenceBlock({summary: {text: '摘要'}, activePlan: mkPlan({status: 'approved'})});
    assert.ok(approved.includes(PLAN_DIR_REL + '/plan-session.md'));
    assert.ok(!approved.includes('尚未批准'));
    // 没有 activePlan（或 markdown 为空）则不注入
    assert.equal(planReferenceBlock({summary: {text: '摘要'}, messages: [{role: 'user', content: 'x'}]}), '');
    assert.equal(planReferenceBlock({summary: {text: '摘要'}, activePlan: {markdown: '  '}}), '');
});

// ---- planPreviewSlice：审批卡预览的结构感知截断 ----
test('planPreviewSlice：短文原样返回；超预算按行边界截断，不切半行', () => {
    const short = '# 计划\n\n## 目标\n\n做 A。';
    assert.deepEqual(planPreviewSlice(short, 100), {text: short, truncated: false});
    const text = 'line1\nline2\nline3\nline4';
    const slice = planPreviewSlice(text, 12);
    assert.equal(slice.truncated, true);
    assert.equal(slice.text, 'line1\nline2', '切在整行边界，kept 长度不超预算');
    for (const line of slice.text.split('\n')) assert.ok(text.includes(line), '保留的都是完整行');
});

test('planPreviewSlice：围栏代码块要么整体保留要么整体丢弃，不悬空', () => {
    const text = '# 计划\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n## 目标\n收尾。';
    // 预算落在围栏中间：整体回退到开栏之前
    const mid = planPreviewSlice(text, 30);
    assert.equal(mid.truncated, true);
    assert.ok(!mid.text.includes('const a = 1;'), '围栏内容整体丢弃');
    assert.ok(!mid.text.includes('```'), '不悬空围栏标记');
    assert.ok(mid.text.startsWith('# 计划'));
    // 预算足够：围栏整体保留（真闭合行放下之后才继续往后切）
    const fit = planPreviewSlice(text, 45);
    assert.equal(fit.truncated, true);
    assert.ok(fit.text.includes('const b = 2;'));
    assert.ok(fit.text.trimEnd().endsWith('```'), '围栏带闭合行整体保留');
    assert.ok(!fit.text.includes('## 目标'), '围栏之后的行截掉');
});

test('planPreviewSlice：围栏内形如 ```js 的行不是闭合，真闭合行整体放得下才保留', () => {
    const text = 'a\n```py\nx = 1\n```js\n```\nb';
    const small = planPreviewSlice(text, 20);
    assert.equal(small.text, 'a', '假闭合不算闭合，围栏整体丢弃');
    const full = planPreviewSlice(text, 24);
    assert.equal(full.truncated, true);
    assert.ok(full.text.includes('```js'), '假闭合行作为内容保留');
    assert.ok(full.text.trimEnd().endsWith('```'), '真闭合行保留');
    assert.ok(!full.text.includes('b'), '围栏之后的行截掉');
});

test('planPreviewSlice：null / 空串 / 预算极小兜底', () => {
    assert.deepEqual(planPreviewSlice(null, 100), {text: '', truncated: false});
    assert.deepEqual(planPreviewSlice('', 0), {text: '', truncated: false});
    const tiny = planPreviewSlice('# 很长的标题\n\n正文', 2);
    assert.equal(tiny.truncated, true);
    assert.equal(tiny.text, '', '一行都放不下时返回空正文');
});

// ---- planAwaitingUserReply：「计划等待批准」横条的收起判定 ----
test('planAwaitingUserReply：无计划视为等待；计划提交后无新用户消息视为等待', () => {
    assert.equal(planAwaitingUserReply(null), true);
    assert.equal(planAwaitingUserReply({messages: []}), true);
    assert.equal(planAwaitingUserReply({activePlan: mkPlan(), messages: []}), true);
    // 只有 assistant / 工具消息，没有新的用户发言：仍等待
    assert.equal(planAwaitingUserReply({
        activePlan: mkPlan(),
        messages: [{role: 'assistant', ts: 9999}, {role: 'tool', ts: 9999}],
    }), true);
});

test('planAwaitingUserReply：计划提交后出现 ts 更晚的用户消息 → 已回复（横条收起）', () => {
    const plan = mkPlan({ts: 1000});
    assert.equal(planAwaitingUserReply({
        activePlan: plan,
        messages: [{role: 'user', ts: 500}, {role: 'user', ts: 1500}],
    }), false, 'ts 晚于计划提交的用户消息 = 修订意见');
    // 计划 ts 之前的旧用户消息不算
    assert.equal(planAwaitingUserReply({
        activePlan: plan,
        messages: [{role: 'user', ts: 500}, {role: 'assistant', ts: 800}],
    }), true);
    // 缺少 ts 的消息不误判
    assert.equal(planAwaitingUserReply({
        activePlan: plan,
        messages: [{role: 'user', content: 'no ts'}],
    }), true);
});
