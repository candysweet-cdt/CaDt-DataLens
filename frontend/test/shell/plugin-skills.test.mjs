// plugin-skills.test.mjs —— 插件斜杠技能注册表（shell/plugin-skills.js）。
// 钉住：归一化校验、上限、重名、撤销、when 条件、content 惰性求值/错误隔离/截断。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    registerPluginSkill, clearPluginSkills, getPluginSkillRecords, getPluginSkillList,
    MAX_SKILLS_PER_PLUGIN, MAX_SKILL_CONTENT,
} from '../../src/shell/plugin-skills.js';

function reset() {
    clearPluginSkills();
}

const spec = (name = 'demo-write', extra = {}) => ({
    name,
    description: '演示写作技能',
    content: () => '# 技能正文\n做点事。',
    ...extra,
});

test('注册 → 可列举 → 撤销 → 重载清空', () => {
    reset();
    const off = registerPluginSkill('p1', '插件一', spec());
    assert.equal(getPluginSkillRecords().length, 1);
    assert.equal(getPluginSkillRecords()[0].key, 'p1:demo-write');
    off();
    assert.equal(getPluginSkillRecords().length, 0);
    registerPluginSkill('p2', '插件二', spec('other'));
    clearPluginSkills();
    assert.equal(getPluginSkillRecords().length, 0);
});

test('非法声明抛错：名称 / 缺 description / 缺 content / when 非函数', () => {
    reset();
    assert.throws(() => registerPluginSkill('p1', 'P1', spec('Bad_Name')), /技能名无效/);
    assert.throws(() => registerPluginSkill('p1', 'P1', {name: 'x', content() {}}), /缺少 description/);
    assert.throws(() => registerPluginSkill('p1', 'P1', {name: 'x', description: 'd'}), /缺少 content/);
    assert.throws(() => registerPluginSkill('p1', 'P1', spec('x', {when: 1})), /when 必须是函数/);
    assert.throws(() => registerPluginSkill('', 'P1', spec()), /缺少插件 id/);
});

test('重名与单插件上限', () => {
    reset();
    registerPluginSkill('p1', 'P1', spec());
    assert.throws(() => registerPluginSkill('p1', 'P1', spec()), /已注册/);
    // 不同插件可注册同名（去重交给 AI 面板按 rank 处理）
    registerPluginSkill('p2', 'P2', spec());
    assert.equal(getPluginSkillRecords().length, 2);
    for (let i = 0; i < MAX_SKILLS_PER_PLUGIN; i += 1) {
        registerPluginSkill('p3', 'P3', spec('skill-' + i));
    }
    assert.throws(() => registerPluginSkill('p3', 'P3', spec('overflow')), /超过上限/);
});

test('getPluginSkillList：产出可合并的技能候选（path 空 / source plugin / rank 300）', async () => {
    reset();
    registerPluginSkill('p1', '插件一', spec());
    const list = await getPluginSkillList({workspace: 'D:/ws', sessionId: 's1'});
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'demo-write');
    assert.equal(list[0].path, '');
    assert.equal(list[0].source, 'plugin');
    assert.equal(list[0].rank, 300);
    assert.equal(list[0].pluginId, 'p1');
    assert.match(list[0].content, /技能正文/);
});

test('when/content 的 ctx 带插件自身身份（ctx.plugin），不被宿主空壳覆盖', async () => {
    reset();
    let seenWhen = null;
    let seenContent = null;
    registerPluginSkill('my-plugin', '我的插件', spec('identified', {
        when: (ctx) => { seenWhen = ctx; return ctx.plugin.id === 'my-plugin'; },
        content: (ctx) => { seenContent = ctx; return '正文'; },
    }));
    // 宿主传空壳身份，技能应仍拿到自己的 id/name
    const list = await getPluginSkillList({plugin: {id: '', name: ''}, workspace: 'D:/ws', sessionId: 's1'});
    assert.equal(list.length, 1, 'when 按 ctx.plugin.id 判定应通过');
    assert.deepEqual(seenWhen.plugin, {id: 'my-plugin', name: '我的插件'});
    assert.deepEqual(seenContent.plugin, {id: 'my-plugin', name: '我的插件'});
    assert.equal(seenWhen.workspace, 'D:/ws');
    assert.equal(seenContent.sessionId, 's1');
    assert.equal(seenWhen.origin, 'prompt');
});

test('when 返回 Promise（误写 async）按不满足处理，不被 truthy 放行', async () => {
    reset();
    registerPluginSkill('p1', 'P1', spec('async-when', {when: async () => true}));
    const list = await getPluginSkillList({workspace: 'D:/ws'});
    assert.equal(list.length, 0);
});

test('when 条件：false 不出现；抛错当不满足；ctx 传给 when/content', async () => {
    reset();
    let seenWhen = null;
    let seenContent = null;
    registerPluginSkill('p1', 'P1', spec('gated', {
        when: (ctx) => { seenWhen = ctx; return !!ctx.workspace; },
        content: (ctx) => { seenContent = ctx; return '正文'; },
    }));
    registerPluginSkill('p1', 'P1', spec('boom', {when: () => { throw new Error('x'); }}));
    registerPluginSkill('p1', 'P1', spec('never', {when: () => false}));
    const ctx = {workspace: 'D:/ws', sessionId: 's1'};
    const list = await getPluginSkillList(ctx);
    assert.deepEqual(list.map((s) => s.name), ['gated']);
    assert.equal(seenWhen.workspace, 'D:/ws');
    assert.equal(seenContent.sessionId, 's1');
    const none = await getPluginSkillList({workspace: ''});
    assert.equal(none.length, 0);
});

test('content 错误隔离：抛错 / 空串 / 非字符串都只跳过该条', async () => {
    reset();
    registerPluginSkill('p1', 'P1', spec('ok'));
    registerPluginSkill('p1', 'P1', spec('throw', {content: () => { throw new Error('boom'); }}));
    registerPluginSkill('p1', 'P1', spec('empty', {content: () => '   '}));
    registerPluginSkill('p1', 'P1', spec('num', {content: () => 12345}));
    const list = await getPluginSkillList({workspace: 'D:/ws'});
    assert.deepEqual(list.map((s) => s.name), ['ok']);
});

test('content 超时（>1 s）只跳过该条，不拖慢其他技能', async () => {
    reset();
    registerPluginSkill('p1', 'P1', spec('ok'));
    registerPluginSkill('p1', 'P1', spec('slow', {
        content: () => new Promise((resolve) => setTimeout(() => resolve('太慢'), 1200)),
    }));
    const start = Date.now();
    const list = await getPluginSkillList({workspace: 'D:/ws'});
    assert.deepEqual(list.map((s) => s.name), ['ok'], '超时那条被跳过');
    assert.ok(Date.now() - start < 1150, '不应等满 1.2 s（并发 + 1 s 单点超时）');
});

test('content 支持 async 并并发求值（不串行等待）', async () => {
    reset();
    const order = [];
    registerPluginSkill('p1', 'P1', spec('slow', {
        content: async () => { await new Promise((r) => setTimeout(r, 60)); order.push('slow'); return '慢'; },
    }));
    registerPluginSkill('p1', 'P1', spec('fast', {
        content: async () => { order.push('fast'); return '快'; },
    }));
    const list = await getPluginSkillList({workspace: 'D:/ws'});
    assert.equal(list.length, 2);
    assert.deepEqual(order, ['fast', 'slow'], '快的先完成，说明是并发不是串行 await');
});

test('正文超过 64 KiB 截断并在描述尾部标注', async () => {
    reset();
    registerPluginSkill('p1', 'P1', spec('huge', {content: () => 'x'.repeat(MAX_SKILL_CONTENT + 500)}));
    const list = await getPluginSkillList({workspace: 'D:/ws'});
    assert.equal(list.length, 1);
    assert.equal(list[0].content.length, MAX_SKILL_CONTENT);
    assert.match(list[0].description, /已截断/);
});
