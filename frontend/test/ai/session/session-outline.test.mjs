import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionOutlineItems, assistantPreviewAfter} from '../../../src/ai/session/session-outline.js';

// 会话结构（用户消息定位条）的数据整理规则：
// 只留用户说过的消息，轮次序号连续，超长文本压成一行，条数超上限只保留最近的。

test('只保留用户消息，系统注记 / 静默注入 / 应用注入 / 模型切换都不算一轮', () => {
    const messages = [
        {role: 'user', content: '第一条'},
        {role: 'assistant', content: '好的'},
        {role: 'tool', content: 'tool output'},
        {role: 'user', content: '系统注记', systemNote: true},
        {role: 'user', content: '静默注入', silent: true},
        {role: 'user', content: '定时任务指令', app: {label: '定时任务'}},
        {role: 'user', content: '切换模型', kind: 'model-switch'},
        {role: 'user', content: '第二条'},
    ];
    const out = buildSessionOutlineItems(messages);
    assert.equal(out.total, 2);
    assert.deepEqual(out.items.map((item) => item.index), [0, 7]);
    assert.deepEqual(out.items.map((item) => item.round), [1, 2]);
    assert.deepEqual(out.items.map((item) => item.text), ['第一条', '第二条']);
    assert.equal(out.truncated, false);
});

test('换行与连续空白压成单行，空文本用图片数量兜底', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '第一行\n\n第二行\t结束'},
        {role: 'user', content: '', images: [{}, {}]},
    ]);
    assert.equal(out.items[0].text, '第一行 第二行 结束');
    assert.equal(out.items[1].text, '（2 张图片）');
});

test('剥掉开头的宿主环境块，只预览用户正文', () => {
    const content = '<system-reminder>\n<workspace_context>\n当前活动文件：a.js\n</workspace_context>\n</system-reminder>\n\n真的改了吗我怎么没看见';
    const out = buildSessionOutlineItems([{role: 'user', content}]);
    assert.equal(out.items[0].text, '真的改了吗我怎么没看见');
});

test('剥掉开头的引用块，只预览用户正文', () => {
    const content = '<quote source="assistant" index="713" scope="selection">\n建议装 VS Build Tools\n</quote>\n\n你推荐哪个';
    const out = buildSessionOutlineItems([{role: 'user', content}]);
    assert.equal(out.items[0].text, '你推荐哪个');
});

test('环境块 + 引用块连续剥掉，只留正文', () => {
    const content = '<system-reminder>\n<workspace_context>\n当前活动文件：a.js\n</workspace_context>\n</system-reminder>\n\n' +
        '<quote source="assistant" index="3" scope="message">\n引用的回复\n</quote>\n\n正文在这里';
    const out = buildSessionOutlineItems([{role: 'user', content}]);
    assert.equal(out.items[0].text, '正文在这里');
});

test('只有引用块没有正文的消息不占行，带图片仍以数量兜底', () => {
    const quote = '<quote source="assistant" index="3" scope="message">\n引用的回复\n</quote>';
    const out = buildSessionOutlineItems([
        {role: 'user', content: quote},
        {role: 'user', content: quote, images: [{}]},
        {role: 'user', content: '正文'},
    ]);
    assert.equal(out.total, 2);
    assert.deepEqual(out.items.map((item) => item.index), [1, 2]);
    assert.deepEqual(out.items.map((item) => item.text), ['（1 张图片）', '正文']);
});

test('只有环境块的纯注入消息不占行，带图片/视频仍以数量兜底', () => {
    const reminder = '<system-reminder>\n<workspace_context>\n当前活动文件：a.js\n</workspace_context>\n</system-reminder>';
    const out = buildSessionOutlineItems([
        {role: 'user', content: reminder},
        {role: 'user', content: reminder, images: [{}, {}]},
        {role: 'user', content: reminder, videos: [{}]},
        {role: 'user', content: '正文'},
    ]);
    assert.equal(out.total, 3);
    assert.deepEqual(out.items.map((item) => item.index), [1, 2, 3]);
    assert.deepEqual(out.items.map((item) => item.round), [1, 2, 3]);
    assert.deepEqual(out.items.map((item) => item.text), ['（2 张图片）', '（1 个视频）', '正文']);
});

test('插话（steer）不占新轮号，但作为可定位项列出并带标记', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '第一轮'},
        {role: 'assistant', content: '好的'},
        {role: 'user', content: '补充一句', steer: true},
        {role: 'assistant', content: '继续'},
        {role: 'user', content: '第二轮'},
    ]);
    assert.deepEqual(out.items.map((item) => item.text), ['第一轮', '补充一句', '第二轮']);
    assert.deepEqual(out.items.map((item) => item.round), [1, 1, 2]);
    assert.deepEqual(out.items.map((item) => item.steer === true), [false, true, false]);
});

test('超过上限只保留最近若干轮，并标记 truncated', () => {
    const messages = [];
    for (let i = 0; i < 10; i += 1) messages.push({role: 'user', content: '第 ' + i + ' 轮'});
    const out = buildSessionOutlineItems(messages, {max: 3});
    assert.equal(out.total, 10);
    assert.equal(out.truncated, true);
    assert.equal(out.items.length, 3);
    assert.deepEqual(out.items.map((item) => item.text), ['第 7 轮', '第 8 轮', '第 9 轮']);
    // 序号仍按全量计算，不因截断从 1 重新开始
    assert.deepEqual(out.items.map((item) => item.round), [8, 9, 10]);
});

test('空会话与非法输入不报错', () => {
    assert.deepEqual(buildSessionOutlineItems([]).items, []);
    assert.deepEqual(buildSessionOutlineItems(null).items, []);
    assert.deepEqual(buildSessionOutlineItems(undefined).items, []);
    assert.equal(buildSessionOutlineItems([{role: 'user', content: 'x'}], {max: 0}).items.length, 1);
});

test('时间戳取 ts，缺失时退回 turnStartedAt', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: 'a', ts: 100},
        {role: 'user', content: 'b', turnStartedAt: 200},
        {role: 'user', content: 'c'},
    ]);
    assert.deepEqual(out.items.map((item) => item.ts), [100, 200, 0]);
});

// ---- 导航滑轨气泡描述（summary）----

test('summary 取该轮用户消息之后最近一条助手回复正文', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '第一轮'},
        {role: 'assistant', content: '这是第一轮的回复'},
        {role: 'user', content: '第二轮'},
        {role: 'assistant', content: '这是第二轮的回复'},
    ]);
    assert.deepEqual(out.items.map((item) => item.summary), ['这是第一轮的回复', '这是第二轮的回复']);
});

test('summary 跳过 tool 结果与注入类消息，找到真正的助手回复', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '问题'},
        {role: 'tool', content: '工具输出'},
        {role: 'assistant', content: '', silent: true},
        {role: 'assistant', content: '最终回答'},
    ]);
    assert.equal(out.items[0].summary, '最终回答');
});

test('summary 遇下一轮用户消息即停，末尾待回复的轮次 summary 为空', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '第一轮'},
        {role: 'assistant', content: '第一轮的回复'},
        {role: 'user', content: '第二轮（待回复）'},
    ]);
    assert.equal(out.items[0].summary, '第一轮的回复');
    assert.equal(out.items[1].summary, '');
});

test('插话（steer）后的助手回复归属给插话项，不串给上一轮', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '第一轮'},
        {role: 'assistant', content: '第一轮回复'},
        {role: 'user', content: '插一句', steer: true},
        {role: 'assistant', content: '插话的回复'},
    ]);
    assert.deepEqual(out.items.map((item) => item.summary), ['第一轮回复', '插话的回复']);
});

test('summary 压空白并截断到 160 字符', () => {
    const long = '词 '.repeat(120);
    const out = buildSessionOutlineItems([
        {role: 'user', content: '问题'},
        {role: 'assistant', content: '第一行\n\n第二行\t结束'},
        {role: 'user', content: '问题2'},
        {role: 'assistant', content: long},
    ]);
    assert.equal(out.items[0].summary, '第一行 第二行 结束');
    assert.equal(out.items[1].summary.length, 161); // 160 字符 + 省略号
    assert.ok(out.items[1].summary.endsWith('…'));
});

test('assistantPreviewAfter 非法输入与边界不报错', () => {
    assert.equal(assistantPreviewAfter(null, 0), '');
    assert.equal(assistantPreviewAfter([], 0), '');
    assert.equal(assistantPreviewAfter([{role: 'assistant', content: 'x'}], -1), '');
    assert.equal(assistantPreviewAfter([{role: 'assistant', content: 'x'}], 0), ''); // 越界
});

test('截断后 summary 仍按原始 index 取值，不随 items 切片错配', () => {
    const messages = [];
    for (let i = 0; i < 5; i += 1) {
        messages.push({role: 'user', content: '第 ' + i + ' 轮'});
        messages.push({role: 'assistant', content: '回复 ' + i});
    }
    const out = buildSessionOutlineItems(messages, {max: 2});
    assert.deepEqual(out.items.map((item) => item.summary), ['回复 3', '回复 4']);
});
