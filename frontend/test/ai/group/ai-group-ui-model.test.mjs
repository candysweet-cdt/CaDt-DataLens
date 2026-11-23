// ai-group-ui-model.test.mjs：群聊视图纯函数层（G6）——时间线合并/分隔、@ 补全、
// 状态文案与预览截断。护栏 docs/finished-plans/ai-group-chat.md G6 重写。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyMention,
    buildRichHtml,
    dateLabel,
    discussionActionLabel,
    eventLineText,
    expandDeletionRange,
    filterMentionCandidates,
    groupStatusText,
    memberInitial,
    mentionQuery,
    needsDateBreak,
    needsRoundBreak,
    previewOfMessage,
    scanMentions,
    shouldMerge,
    statusLineOf,
    timeLabel,
} from '../../../src/ai/group/ai-group-ui-model.js';

const NOW = new Date('2026-11-18T12:00:00').getTime();
const msg = (over = {}) => ({
    gid: 'gm-1',
    role: 'assistant',
    agentId: 'a1',
    agentName: '架构师',
    agentColor: 'blue',
    content: '正文',
    ts: NOW - 60000,
    round: 1,
    status: 'done',
    ...over,
});

test('dateLabel / timeLabel：今天 / 昨天 / 跨年', () => {
    assert.equal(dateLabel(NOW, NOW), '今天');
    assert.equal(dateLabel(NOW - 86400000, NOW), '昨天');
    assert.equal(dateLabel(new Date('2025-03-05T08:00:00').getTime(), NOW), '2025年3月5日');
    assert.equal(dateLabel(new Date('2026-03-05T08:00:00').getTime(), NOW), '3月5日');
    assert.equal(timeLabel(new Date('2026-11-18T09:07:00').getTime()), '09:07');
    assert.equal(needsDateBreak(null, NOW, NOW), true);
    assert.equal(needsDateBreak(NOW, NOW - 86400000, NOW), true);
    assert.equal(needsDateBreak(NOW - 60000, NOW - 30000, NOW), false);
});

test('shouldMerge：同作者 5 分钟内合并；系统/纪要/失败/换轮不合并', () => {
    const base = msg();
    assert.equal(shouldMerge(base, msg({ts: base.ts + 60000})), true);
    assert.equal(shouldMerge(base, msg({ts: base.ts + 6 * 60000})), false);
    assert.equal(shouldMerge(base, msg({agentId: 'a2', agentName: '审查员'})), false);
    assert.equal(shouldMerge(base, msg({role: 'user'})), false);
    assert.equal(shouldMerge(base, msg({round: 2})), false);
    assert.equal(shouldMerge(base, msg({status: 'error'})), false);
    assert.equal(shouldMerge(base, msg({kind: 'minutes'})), false);
    assert.equal(shouldMerge(msg({role: 'system'}), msg()), false);
});

test('needsRoundBreak：轮次变化处分隔；系统/纪要后必分隔；free 不分隔', () => {
    const meta = {mode: 'roundtable'};
    assert.equal(needsRoundBreak(null, msg({round: 1}), meta), true);
    assert.equal(needsRoundBreak(msg({round: 1}), msg({round: 2}), meta), true);
    assert.equal(needsRoundBreak(msg({round: 1}), msg({round: 1}), meta), false);
    assert.equal(needsRoundBreak(msg({round: 1}), msg({role: 'system'}), meta), false);
    assert.equal(needsRoundBreak(msg({role: 'system'}), msg({round: 2}), meta), true);
    assert.equal(needsRoundBreak(msg({round: 1}), msg({round: 2}), {mode: 'free'}), false);
    assert.equal(needsRoundBreak(msg({round: 1}), msg({round: 0}), meta), false);
});

test('mentionQuery / applyMention：@ 触发（允许紧跟文字）、空白截断、插入替换', () => {
    assert.deepEqual(mentionQuery('你好 @审查', 8), {start: 3, query: '审查'});
    assert.equal(mentionQuery('你好 审查', 8), null);
    assert.deepEqual(mentionQuery('@', 1), {start: 0, query: ''});
    // 中文输入习惯：@ 紧跟文字后面也触发补全
    assert.deepEqual(mentionQuery('请@审', 3), {start: 1, query: '审'});
    assert.equal(mentionQuery('请 @审 完', 7), null); // @ 与光标之间出现空白
    assert.deepEqual(mentionQuery('@甲 @乙', 6), {start: 3, query: '乙'});
    const applied = applyMention('请@审', 3, '审查员');
    assert.equal(applied.text, '请@审查员 ');
    assert.equal(applied.caret, '请@审查员 '.length);
    const atStart = applyMention('@全体', 3, '全体成员');
    assert.equal(atStart.text, '@全体成员 ');
    assert.equal(atStart.caret, '@全体成员 '.length);
});

test('filterMentionCandidates：包含过滤 + 空查询全量', () => {
    const all = ['全体成员', '架构师', '审查员'];
    assert.deepEqual(filterMentionCandidates(all, ''), all);
    assert.deepEqual(filterMentionCandidates(all, '审'), ['审查员']);
    assert.deepEqual(filterMentionCandidates(all, '成员'), ['全体成员']);
    assert.deepEqual(filterMentionCandidates(all, 'zz'), []);
});

test('groupStatusText / discussionActionLabel：free / 运行 / 暂停 / 纪要', () => {
    const roundtable = {mode: 'roundtable', discussion: {round: 2}};
    assert.equal(groupStatusText(roundtable, null), '');
    assert.equal(groupStatusText(roundtable, {running: true, speeches: 3}), '讨论中 · 3 次发言');
    assert.equal(groupStatusText(roundtable, {running: false, paused: true}), '已暂停 · 点「继续」接着讨论');
    assert.equal(groupStatusText({mode: 'roundtable', minutes: {text: 'x'}, discussion: {round: 1}}, null), '本场已产出纪要');
    assert.equal(groupStatusText({mode: 'free'}, null).includes('自由聊天'), true);
    assert.equal(discussionActionLabel(roundtable, null), '继续讨论');
    assert.equal(discussionActionLabel({mode: 'roundtable', discussion: {round: 0}}, null), '开始讨论');
    assert.equal(discussionActionLabel(roundtable, {running: true}), '暂停');
    assert.equal(discussionActionLabel(roundtable, {paused: true}), '继续');
    assert.equal(discussionActionLabel({mode: 'free'}, null), '');
});

test('eventLineText / statusLineOf / memberInitial / previewOfMessage', () => {
    assert.equal(eventLineText({type: 'mention', text: '用户点名：@全体成员'}), '用户点名：@全体成员');
    assert.equal(eventLineText({type: 'unknown', text: 'x'}), '');
    assert.equal(eventLineText({type: 'compress'}), '');
    assert.equal(statusLineOf({timeout: true}), '超时未发言，已跳过');
    assert.equal(statusLineOf({status: 'error', error: 'boom'}), '发言失败：boom');
    assert.equal(statusLineOf({status: 'stopped'}), '已停止');
    assert.equal(statusLineOf({status: 'done'}), '');
    assert.equal(memberInitial('架构师'), '架');
    assert.equal(memberInitial(''), '?');
    assert.equal(memberInitial('🤖bot'), '🤖');
    assert.equal(previewOfMessage(msg({content: '第一行\n第二行'})), '架构师：第一行 第二行');
    assert.equal(previewOfMessage(msg({role: 'user', content: 'hi'})), '你：hi');
    assert.equal(previewOfMessage(msg({chair: true})), '主持人：正文');
    assert.equal(previewOfMessage(msg({kind: 'minutes'})), '纪要：正文');
    assert.equal(previewOfMessage(msg({content: 'x'.repeat(300)})).length, 100);
    assert.equal(previewOfMessage(msg({content: '   '})), '');
});

test('scanMentions：@合法名扫成胶囊 range（长名优先、不重叠、@全体成员）', () => {
    const names = ['架构师', '审查员', '审查员长', '全体成员'];
    assert.deepEqual(scanMentions('请@审查员 看看', names), [{start: 1, end: 5, name: '审查员'}]);
    // 长名优先：@审查员长 整体是一颗胶囊，而不是 审查员 + 残字
    assert.deepEqual(scanMentions('@审查员长 到了', names), [{start: 0, end: 5, name: '审查员长'}]);
    assert.deepEqual(scanMentions('@全体成员 集合', names), [{start: 0, end: 5, name: '全体成员'}]);
    // 不合法的 @ 不产胶囊
    assert.deepEqual(scanMentions('邮箱 a@b.com 与 @路人', names), []);
    // 相邻两颗
    assert.deepEqual(scanMentions('@架构师@审查员', names), [
        {start: 0, end: 4, name: '架构师'},
        {start: 4, end: 8, name: '审查员'},
    ]);
    assert.deepEqual(scanMentions('', names), []);
});

test('buildRichHtml：胶囊 span 占据与原文一致的字符（含尾随空格）、转义、尾换行占位', () => {
    const ranges = [{start: 1, end: 5, name: '审查员'}];
    const html = buildRichHtml('请@审查员 看看', ranges);
    assert.equal(html, '请<span class="gc-pill" data-name="审查员">@审查员 </span>看看');
    // HTML 注入被转义
    const evil = buildRichHtml('<img src=x onerror=1>', []);
    assert.equal(evil.includes('<img'), false);
    assert.equal(evil.includes('&lt;img'), true);
    // 尾换行补零宽占位，镜像层行数与文本域一致
    assert.equal(buildRichHtml('第一行\n', []).endsWith('\u200b'), true);
    // range 越界/重叠防御
    assert.equal(buildRichHtml('abc', [{start: 2, end: 9, name: 'x'}]), 'ab' + '<span class="gc-pill" data-name="x">c</span>');
});

test('expandDeletionRange：Backspace/Delete 命中胶囊整段删、选区扩到完整胶囊', () => {
    const pills = [{start: 1, end: 5, name: '审查员'}]; // '请@审查员 '
    // 光标在胶囊尾（@审查员 之后、空格之前）→ 整颗删
    assert.deepEqual(expandDeletionRange(pills, 5, 5, 'backspace'), {start: 1, end: 5});
    // 光标在胶囊中间（改字后想删）→ 也是整颗删
    assert.deepEqual(expandDeletionRange(pills, 3, 3, 'backspace'), {start: 1, end: 5});
    // 光标在胶囊头 → 不命中（删前面的字，交给浏览器）
    assert.equal(expandDeletionRange(pills, 1, 1, 'backspace'), null);
    // 光标在胶囊尾之后（隔着空格）→ 不命中
    assert.equal(expandDeletionRange(pills, 6, 6, 'backspace'), null);
    // Delete：光标在胶囊头 → 整颗删
    assert.deepEqual(expandDeletionRange(pills, 1, 1, 'delete'), {start: 1, end: 5});
    // Delete：光标在胶囊尾 → 不命中（删后面的字）
    assert.equal(expandDeletionRange(pills, 5, 5, 'delete'), null);
    // 选区跨进胶囊 → 扩到整颗
    assert.deepEqual(expandDeletionRange(pills, 4, 8, 'backspace'), {start: 1, end: 8});
    // 纯文本选区不扩
    assert.equal(expandDeletionRange(pills, 7, 9, 'backspace'), null);
    assert.equal(expandDeletionRange([], 1, 1, 'backspace'), null);
});
