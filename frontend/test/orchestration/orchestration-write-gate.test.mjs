// orchestration-write-gate.test.mjs：编排写闸对派生子代理的行为护栏。
//
// 背景：写闸原先对「没有 session.orchestration 标记」的会话直接 fail-open 放行；子代理会话
// 不带该标记，于是编排会话派生的子代理绕过 owns 边界（owns 边界只剩「阶段零强制只读」一层）。
// 修复：派单时给编排派生子代理打 _orchestrationDerived + 继承私有执行票据，写闸认凭证并
// fail-closed 校验 owns。这里直接实例化 host 验证行为，而不是只做源码正则断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOrchestrationHost} from '../../src/orchestration/orchestration-ui.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const sourceOf = (rel) => readFileSync(join(SRC, rel), 'utf8');

function makeHost(result) {
    const calls = [];
    const backend = {
        OrchestrationAuthorizeWrite(token, path) {
            calls.push({token, path});
            return Promise.resolve(result || {allowed: true});
        },
    };
    const {adapter} = createOrchestrationHost({backend});
    return {adapter, calls};
}

test('普通会话（无编排标记、非派生）仍直接放行，不碰 Go 写闸', async () => {
    const {adapter, calls} = makeHost({allowed: true});
    const verdict = await adapter.authorizeWrite({id: 's1'}, '/some/path');
    assert.deepEqual(verdict, {allowed: true});
    assert.equal(calls.length, 0, '普通会话不该调用写闸');
});

test('编排批次会话（work/review）持票据走真写闸', async () => {
    const {adapter, calls} = makeHost({allowed: false, message: '越界'});
    const session = {
        orchestration: {role: 'work', owns: ['src/**']},
        _orchestrationToken: 'tok-batch',
    };
    const verdict = await adapter.authorizeWrite(session, '/outside/secret.txt');
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.message, '越界');
    assert.deepEqual(calls, [{token: 'tok-batch', path: '/outside/secret.txt'}]);
});

test('编排派生子代理：有票据时走真写闸（owns 边界对它生效）', async () => {
    const {adapter, calls} = makeHost({allowed: false, message: '路径不在本批 owns 内'});
    const session = {
        parentSessionId: 'batch-session',
        _orchestrationDerived: true,
        _orchestrationWriteToken: 'tok-batch',
    };
    const verdict = await adapter.authorizeWrite(session, '/outside/secret.txt');
    assert.equal(verdict.allowed, false, '派生子代理越界必须被拒（旧代码在此 fail-open）');
    assert.deepEqual(calls, [{token: 'tok-batch', path: '/outside/secret.txt'}]);
});

test('编排派生子代理：票据缺失（跨进程续跑）fail-closed 拒绝，不调 Go', async () => {
    const {adapter, calls} = makeHost({allowed: true});
    const session = {
        parentSessionId: 'batch-session',
        _orchestrationDerived: true,
        _orchestrationWriteToken: '',
    };
    const verdict = await adapter.authorizeWrite(session, '/any/path');
    assert.equal(verdict.allowed, false, '票据失效的派生子代理必须拒绝，不能 fail-open');
    assert.match(verdict.message, /票据已失效/);
    assert.equal(calls.length, 0, '无票据不该调 Go');
});

test('arbiter 会话本身维持原放行语义（无写工具，走不到写路径），不误伤', async () => {
    // arbiter 的工具表只给 orchestration_control，没有 write_file/edit_file（ai-tool-defs.js
    // 的 Worker/arbiter 裁剪），走不到 applyWorkspaceWrite；写闸保持原行为，不因 role 误伤。
    // arbiter 派生的子代理由 _orchestrationDerived + 无票据 fail-closed 覆盖（见上一条测试）。
    const {adapter, calls} = makeHost({allowed: true});
    const session = {orchestration: {role: 'arbiter'}, _orchestrationToken: ''};
    const verdict = await adapter.authorizeWrite(session, '/any/path');
    assert.equal(verdict.allowed, true);
    assert.equal(calls.length, 0);
});

test('arbiter 派生的子代理同样 fail-closed（无票据拒绝）', async () => {
    const {adapter, calls} = makeHost({allowed: true});
    const session = {
        parentSessionId: 'arbiter-session',
        _orchestrationDerived: true,
        _orchestrationWriteToken: '',
    };
    const verdict = await adapter.authorizeWrite(session, '/any/path');
    assert.equal(verdict.allowed, false, 'arbiter 派生的子代理无票据必须拒绝');
    assert.equal(calls.length, 0);
});

test('派单与续跑都写入派生标记；票据逐层继承、不落盘快照', () => {
    const agents = sourceOf('ai/agent/ai-subagents.js');
    const spawn = agents.slice(agents.indexOf('const orcDerived ='), agents.indexOf('sub.profile = profile;'));
    assert.match(spawn, /_orchestrationDerived:\s*orcDerived/, '派单必须给子会话打派生标记');
    assert.match(spawn, /_orchestrationWriteToken:\s*orcWriteToken/, '派单必须继承私有票据');
    assert.match(spawn, /parentSession\._orchestrationToken[\s\S]{0,120}_orchestrationWriteToken/,
        '票据从父批次会话或父派生子代理逐层继承');
    const restore = agents.slice(agents.indexOf('function restoreAgentRuns('), agents.indexOf('function resumeAgentRun(') > 0
        ? agents.indexOf('function resumeAgentRun(') : agents.length);
    assert.match(restore, /_orchestrationDerived:/, '续跑重建必须恢复派生标记');
    assert.match(restore, /_orchestrationWriteToken:\s*''/, '续跑票据必须为空（fail-closed）');

    const resume = sourceOf('ai/agent/ai-agent-resume.js');
    assert.doesNotMatch(resume, /_orchestrationWriteToken/, '私有票据绝不进落盘快照');
});
