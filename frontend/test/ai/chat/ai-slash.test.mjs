// ai-slash 测试：斜杠补全的过滤分组与技能带参调用解析（纯函数，无 DOM）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_COMMANDS} from '../../../src/ai/core/ai-constants.js';
import {
    extractSlashArgs,
    filterSlashCommands,
    filterSlashSkills,
    findSkillBySlashToken,
    slashScrollDelta,
    slashSkillInvocation,
} from '../../../src/ai/chat/ai-slash.js';

const SKILLS = [
    {name: 'app-error-log', source: 'workspace-agents', description: '查询生产库错误记录'},
    {name: 'app-local-log', source: 'user-agents', description: '查询本地行为日志包'},
    {name: 'cadt-datalens', source: 'builtin', description: '打开本地数据文件'},
];

test('filterSlashCommands：按前缀过滤固定指令，大小写不敏感', () => {
    assert.deepEqual(filterSlashCommands(AI_COMMANDS, 'co').map((c) => c.name), ['/context', '/compact']);
    assert.deepEqual(filterSlashCommands(AI_COMMANDS, 'CLEAR').map((c) => c.name), ['/clear']);
    assert.equal(filterSlashCommands(AI_COMMANDS, 'zzz').length, 0);
    assert.equal(filterSlashCommands(AI_COMMANDS, '').length, AI_COMMANDS.length, '空查询 = 全部指令');
});

test('filterSlashSkills：技能名 includes 匹配（/err 命中 app-error-log），大小写不敏感', () => {
    assert.deepEqual(filterSlashSkills(SKILLS, 'err').map((s) => s.name), ['app-error-log']);
    assert.deepEqual(filterSlashSkills(SKILLS, 'APP').map((s) => s.name), ['app-error-log', 'app-local-log']);
    assert.deepEqual(filterSlashSkills(SKILLS, 'cadt').map((s) => s.name), ['cadt-datalens']);
    assert.equal(filterSlashSkills(SKILLS, 'zzz').length, 0);
});

test('extractSlashArgs：提取 /技能名 之后的参数，大小写不敏感', () => {
    assert.equal(extractSlashArgs('/app-error-log 123', 'app-error-log'), '123');
    assert.equal(extractSlashArgs('/APP-ERROR-LOG 123 多个词', 'app-error-log'), '123 多个词');
    assert.equal(extractSlashArgs('/app-error-log', 'app-error-log'), '', '无参数');
    assert.equal(extractSlashArgs('/app-error-log   ', 'app-error-log'), '', '纯空白当无参数');
    assert.equal(extractSlashArgs('/app 123', 'app-error-log'), '', '首 token 不是完整技能名 → 无参数');
    assert.equal(extractSlashArgs('/compact 保住补丁库', 'app-error-log'), '', '别的命令文本');
    assert.equal(extractSlashArgs('', 'app-error-log'), '');
});

test('extractSlashArgs + filterSlashSkills 组合：带参技能调用的完整解析链', () => {
    const typed = '/app-local-log --list';
    const firstToken = typed.trim().split(/\s+/)[0];
    const hit = filterSlashSkills(SKILLS, firstToken.slice(1).toLowerCase());
    assert.deepEqual(hit.map((s) => s.name), ['app-local-log']);
    const skill = hit[0];
    assert.equal(extractSlashArgs(typed, skill.name), '--list');
});

test('slashSkillInvocation：无参数只发 skill（空文案），带参数连原文一起发', () => {
    // 无参数：立即发送但文案为空串，skill 正文随附件注入、空文案由 startSessionTurn 补占位
    assert.deepEqual(slashSkillInvocation('/app-error-log', 'app-error-log'), {args: '', textToSend: ''});
    assert.deepEqual(slashSkillInvocation('/APP-ERROR-LOG   ', 'app-error-log'), {args: '', textToSend: ''});
    // 带参数：原文（含 /技能名）作为 textToSend
    assert.deepEqual(slashSkillInvocation('/app-error-log 123', 'app-error-log'), {args: '123', textToSend: '/app-error-log 123'});
    assert.deepEqual(slashSkillInvocation('/app-error-log --list 全部', 'app-error-log'),
        {args: '--list 全部', textToSend: '/app-error-log --list 全部'});
    // 首 token 不是该技能名 → 无参数（与其他命令文本边界一致）
    assert.deepEqual(slashSkillInvocation('/compact 保住补丁库', 'app-error-log'), {args: '', textToSend: ''});
    assert.deepEqual(slashSkillInvocation('', 'app-error-log'), {args: '', textToSend: ''});
});

test('findSkillBySlashToken：/技能名 精确命中（大小写不敏感、去前导 /），不命中返回 null', () => {
    assert.equal(findSkillBySlashToken(SKILLS, '/app-error-log').name, 'app-error-log');
    assert.equal(findSkillBySlashToken(SKILLS, '/APP-LOCAL-LOG').name, 'app-local-log');
    assert.equal(findSkillBySlashToken(SKILLS, 'app-local-log').name, 'app-local-log', '无前导 / 也认');
    assert.equal(findSkillBySlashToken(SKILLS, '/workspace'), null, '工作区里的技能不在表里就不命中');
    assert.equal(findSkillBySlashToken(SKILLS, '/app'), null, '前缀不算命中（与补全的 includes 区分）');
    assert.equal(findSkillBySlashToken([], '/anything'), null);
    assert.equal(findSkillBySlashToken(SKILLS, '/'), null);
    assert.equal(findSkillBySlashToken(SKILLS, ''), null);
    assert.equal(findSkillBySlashToken(null, '/app-error-log'), null);
});

// 斜杠补全的方向键滚动跟随：容器（.ai-slash）只滚够让选中行露出来
test('slashScrollDelta：选中行完全可见不滚，被裁在上方贴顶、下方贴底', () => {
    const box = {top: 100, bottom: 200};
    // 完全可见 → 不动
    assert.equal(slashScrollDelta(box, {top: 100, bottom: 125}), 0);
    assert.equal(slashScrollDelta(box, {top: 175, bottom: 200}), 0);
    // 露在可视区上方 → 负增量（向上滚回贴顶量）
    assert.equal(slashScrollDelta(box, {top: 60, bottom: 85}), -40);
    // 露在下方 → 正增量（向下滚到贴底）
    assert.equal(slashScrollDelta(box, {top: 210, bottom: 235}), 35);
    // 缺参 / 空容器 → 不动（补全未渲染时的兜底）
    assert.equal(slashScrollDelta(null, {top: 0, bottom: 10}), 0);
    assert.equal(slashScrollDelta(box, null), 0);
});
