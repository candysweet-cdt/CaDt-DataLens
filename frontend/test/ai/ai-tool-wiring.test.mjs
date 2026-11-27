// ai-tool-wiring.test.mjs —— 新增 AI 工具时的接线守卫。
//
// 背景：加工具漏接线**不会报错**，只会静默退化——目录里看不见它、永不下发、调用报「未知工具」、
// 卡头显示英文工具名和通用图标。人眼很难在 70 个工具里发现少了一个，所以由测试兜住。
//
// 覆盖五处（每处都对应一次真实踩坑）：
//   1. AI_TOOL_CATALOG + AI_TOOL_GROUPS：漏目录 → <tool_catalog> 里没有它，模型不知道有这个工具；
//      group 写成未注册的 key 同样会静默丢（渲染按 AI_TOOL_GROUPS 遍历）。
//   2. toolsForScope：定义了却一次都没 push → 永不下发（四档 × 计划模式取并集判断）。
//   3. executeTool 分支（ai-panel.js，case 在包装层 executeToolInner）：漏了 → 模型调用时拿到「未知工具」。
//   4. 工具卡 toolMeta（ai-tool-cards.js）：漏了 → 卡头显示 `glob` 这种英文名 + 通用 doc 图标。
//   5. 图标名必须在 core/icons.js 注册：iconSvg 对未知名返回空串，图标位静默留白。
//
// 允许「执行不在 ai-panel.js」的工具显式登记到 EXECUTED_ELSEWHERE（要写文件与原因）；
// 除此外任何缺口都直接红——守卫的意义就是逼人做一次明确决定，而不是靠记性。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AI_TOOL_CATALOG, AI_TOOL_DEFS, AI_TOOL_GROUPS, createAIToolDefs} from '../../src/ai/tools/ai-tool-defs.js';
import {ICONS} from '../../src/core/icons.js';

const toolNames = Object.keys(AI_TOOL_DEFS);
const groupKeys = new Set(AI_TOOL_GROUPS.map((group) => group.key));

// 执行分支不在 ai-panel.js 的工具：{工具名: '文件 · 原因'}。目前没有——新增时补理由，
// 不要为了让测试变绿而把分支写进别的 switch 里。
const EXECUTED_ELSEWHERE = {};

const read = (rel) => readFileSync(new URL('../../src/' + rel, import.meta.url), 'utf8');

// 切出某个顶层函数体：从签名到下一个 4 空格缩进的函数声明（文件里的域函数都在这个缩进层）。
function sliceTopFunction(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到函数签名：' + signature);
    const rest = text.slice(start + signature.length);
    const next = /\n {4}(?:async )?function [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

const panelSrc = read('ai/ai-panel.js');
const cardSrc = read('ai/tools/ai-tool-cards.js');
const subSrc = read('ai/agent/ai-subagents.js');

// executeTool 是生命周期钩子包装层（pre/post-tool-use 挂钩），真正的 case 分支在 executeToolInner
const executeBody = sliceTopFunction(panelSrc, 'async function executeTool(name, args, ctx) {') +
    sliceTopFunction(panelSrc, 'async function executeToolInner(name, args, ctx) {');
const metaBody = sliceTopFunction(cardSrc, 'function toolMeta(name, approval) {');

const casesIn = (text) => new Set([...text.matchAll(/case '([a-z_][a-z0-9_]*)':/g)].map((m) => m[1]));
const executeCases = casesIn(executeBody);

// toolMeta 的每个 case 是一条「verb + icon」的 return（write_file 的 verb 是三元表达式，
// 个别条目换行写），按 12 空格缩进切段再取这两个字段。
function parseToolMeta(body) {
    const out = new Map();
    for (const chunk of body.split(/\n {12}case '/).slice(1)) {
        const name = chunk.slice(0, chunk.indexOf("'"));
        const hit = /verb: ([\s\S]*?), icon: '([a-z-]+)'/.exec(chunk);
        out.set(name, {
            // 只要写了字面量（含三元里的两个分支）就算有动词；退回 name 的 default 不算
            verb: hit && /'/.test(hit[1]) ? hit[1] : '',
            icon: hit ? hit[2] : '',
        });
    }
    return out;
}

const meta = parseToolMeta(metaBody);

test('工具定义与目录一一对应（新增/删除都要两边同步）', () => {
    assert.deepEqual(
        [...toolNames].sort(),
        Object.keys(AI_TOOL_CATALOG).sort(),
        'AI_TOOL_DEFS 与 AI_TOOL_CATALOG 的键必须完全一致',
    );
    for (const name of toolNames) {
        const def = AI_TOOL_DEFS[name];
        assert.equal(def.name, name, name + '：def.name 必须与键一致（发请求时用的是 def.name）');
        const desc = String(def.description || '').trim();
        // 长度不设硬门槛（browser_back 这类就是「后退一页。」），但占位描述要拦住
        assert.ok(desc.length >= 4 && desc !== name, name + '：描述缺失或只是占位，模型没有行为依据');
        assert.ok(!/TODO|待补|占位/.test(desc), name + '：描述还是占位文本');
        const params = def.parameters;
        assert.equal(typeof params, 'object', name + '：缺少 parameters');
        assert.equal(typeof params.properties, 'object', name + '：parameters.properties 必须是对象');
        const required = Array.isArray(params.required) ? params.required : [];
        for (const key of required) {
            assert.ok(Object.prototype.hasOwnProperty.call(params.properties, key),
                name + '：required 里的 ' + key + ' 不在 properties 里');
        }
        for (const [key, spec] of Object.entries(params.properties)) {
            assert.ok(String(spec && spec.description || '').trim(),
                name + '.' + key + '：参数缺 description（模型只能靠它判断怎么填）');
        }
        const entry = AI_TOOL_CATALOG[name];
        assert.ok(groupKeys.has(entry.group),
            name + '：目录 group「' + entry.group + '」不在 AI_TOOL_GROUPS 里（会静默不进 <tool_catalog>）');
        assert.ok(String(entry.blurb || '').trim(), name + '：目录缺一句话说明（blurb）');
    }
});

test('桌面控制：装了就给入口，未启用不给桌面工具；启用 + 控制模式才全量下发', () => {
    const base = {appControlOn: () => true};
    // 未安装：连入口都不下发（避免模型对不存在的能力反复尝试）
    const notInstalled = createAIToolDefs(Object.assign({}, base, {
        desktopInstalledOn: () => false,
        desktopEnabledOn: () => true,
        desktopDefsForSession: () => [{name: 'mcp__windows__Snapshot', description: 'x', parameters: {}}],
    }));
    const noneNames = notInstalled.toolsForScope('full', false, {id: 's'}).map((t) => t.name);
    assert.ok(!noneNames.includes('windows_control_mode'), '未安装时不应下发入口');

    // 已安装 + 会话未启用：**入口下发**（2026-11-22 实测：不下发时模型改用 PowerShell SendKeys 绕过），
    // 但一个桌面工具都不给
    const disabled = createAIToolDefs(Object.assign({}, base, {
        desktopInstalledOn: () => true,
        desktopEnabledOn: () => false,
        desktopDefsForSession: () => [{name: 'mcp__windows__Snapshot', description: 'x', parameters: {}}],
    }));
    const disabledNames = disabled.toolsForScope('full', false, {id: 's'}).map((t) => t.name);
    assert.ok(disabledNames.includes('windows_control_mode'), '已安装时入口应在（会话未启用也要有，供模型申请）');
    assert.ok(!disabledNames.includes('mcp__windows__Snapshot'), '会话未启用时不得下发桌面工具');

    // 已启用但未进入控制模式：入口在，桌面工具仍不在（控制模式是动手前的显式闸）
    const enabled = createAIToolDefs(Object.assign({}, base, {
        desktopInstalledOn: () => true,
        desktopEnabledOn: () => true,
        desktopDefsForSession: () => [],
    }));
    const enabledNames = enabled.toolsForScope('full', false, {id: 's'}).map((t) => t.name);
    assert.ok(enabledNames.includes('windows_control_mode'));
    assert.ok(!enabledNames.includes('mcp__windows__Snapshot'));

    // 进入控制模式：白名单工具全量下发
    const active = createAIToolDefs(Object.assign({}, base, {
        desktopInstalledOn: () => true,
        desktopEnabledOn: () => true,
        desktopDefsForSession: () => [
            {name: 'mcp__windows__Snapshot', description: 'x', parameters: {}},
            {name: 'mcp__windows__Click', description: 'y', parameters: {}},
        ],
    }));
    const activeNames = active.toolsForScope('full', false, {id: 's'}).map((t) => t.name);
    assert.ok(activeNames.includes('mcp__windows__Snapshot') && activeNames.includes('mcp__windows__Click'));

    // 计划模式一律不给（桌面是执行阶段的能力）
    assert.ok(!active.toolsForScope('full', true, {id: 's'}).some((t) => t.name === 'windows_control_mode'));
});

test('browser_evaluate：写权限档下发、read 档不下发、计划模式不下发', () => {
    const api = createAIToolDefs({
        appControlOn: () => true,
        externalToolsOn: () => true,
        genModelsOn: () => true,
        desktopInstalledOn: () => false,
    });
    const has = (scope, planMode) => api.toolsForScope(scope, planMode).some((t) => t.name === 'browser_evaluate');
    // 写权限档可见（执行分支弹审批卡，完全权限直通）
    assert.equal(has('edit', false), true, 'edit 档应下发 browser_evaluate');
    assert.equal(has('auto', false), true, 'auto 档应下发 browser_evaluate');
    assert.equal(has('full', false), true, 'full 档应下发 browser_evaluate（直通）');
    // read 档不下发（工具本身不在模型可见清单里）
    assert.equal(has('read', false), false, 'read 档不应下发 browser_evaluate');
    // 计划模式一律不下发（执行阶段能力）
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        assert.equal(has(scope, true), false, scope + ' 档计划模式不应下发 browser_evaluate');
    }
});

test('每个工具至少在一个权限档下发（四档 × 计划模式取并集）', () => {
    const api = createAIToolDefs({
        appControlOn: () => true,
        externalToolsOn: () => true,
        genModelsOn: () => true,
        // 桌面控制（Computer Use）：入口 windows_control_mode 只要桌面 server 已安装就下发
        // （与会话启用无关——不下发时模型会改用 PowerShell SendKeys 绕过）；
        // 白名单桌面工具仍只在「已启用 + 控制模式」时注入
        desktopInstalledOn: () => true,
        desktopEnabledOn: () => true,
        // 编排：report/control 按会话角色下发；四档并集测试要分别路过执行者 / 审查者 / 仲裁者。
        orchestrationInfoOf: (session) => (session && session.orchestration) || null,
    });
    const sessions = [
        {id: 'plain'},
        {id: 'worker', scope: 'edit', orchestration: {role: 'work', owns: ['src/**']}},
        {id: 'reviewer', scope: 'read', orchestration: {role: 'review', owns: []}},
        {id: 'arbiter', orchestration: {role: 'arbiter', generation: 1}},
    ];
    const delivered = new Set();
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            for (const session of sessions) {
                for (const tool of api.toolsForScope(scope, planMode, session)) delivered.add(tool.name);
            }
        }
    }
    const missing = toolNames.filter((name) => !delivered.has(name));
    assert.deepEqual(missing, [], '这些工具定义了但任何档位都不下发；在 toolsForScope 里登记');
});

test('每个工具有 executeTool 分支（或在 EXECUTED_ELSEWHERE 登记）', () => {
    const missing = toolNames.filter((name) => !executeCases.has(name) && !EXECUTED_ELSEWHERE[name]);
    assert.deepEqual(missing, [],
        '这些工具没有执行分支：在 ai-panel.js 的 executeToolInner 加 case（异步要 await；executeTool 只是钩子包装层），' +
        '或登记到本文件的 EXECUTED_ELSEWHERE 并写明文件与原因');
});

test('每个工具有工具卡元数据，图标必须已注册', () => {
    const missing = toolNames.filter((name) => !meta.has(name));
    assert.deepEqual(missing, [],
        '这些工具没有 toolMeta（卡头会显示英文工具名 + 通用 doc 图标）：在 ai-tool-cards.js 补 verb + icon');
    const bad = [];
    for (const name of toolNames) {
        const info = meta.get(name);
        if (!info) continue;
        if (!info.verb) bad.push(name + '：缺 verb');
        if (!info.icon) bad.push(name + '：缺 icon');
        else if (!ICONS[info.icon]) bad.push(name + '：图标「' + info.icon + '」未在 core/icons.js 注册（渲染为空）');
    }
    assert.deepEqual(bad, []);
    const extra = [...meta.keys()].filter((name) => !toolNames.includes(name));
    assert.deepEqual(extra, [], '这些 toolMeta 条目没有对应工具（删工具时没清）');
});

test('子代理白名单只引用已定义的工具', () => {
    const refs = new Set([...subSrc.matchAll(/AI_TOOL_DEFS\.([a-z_]+)/g)].map((m) => m[1]));
    const unknown = [...refs].filter((name) => !toolNames.includes(name));
    assert.deepEqual(unknown, [], 'ai-subagents.js 引用了不存在的工具定义');
});

// 描述里「参数样」的 token 只能靠全量参数词表识别（中文描述里参数名就是裸标识符，没有标记）。
// 下面这些词撞了词表但在描述里不是本工具入参，逐条写清原因；**新出现的参数名不在表里**，
// 所以「描述写了 depth 却忘了加 properties」会直接红。确实需要同名入参的工具由下面
// 「执行分支不得读取未声明参数」那条兜住。
const PROSE_TOKENS = {
    full: '权限档取值（auto / full）',
    id: '返回值里的会话 / 任务标识',
    jobId: '返回值里的作业标识',
    status: '命令名（git status）与退出状态',
    shell: 'run_command / background_command 已声明该入参；其余工具描述里只是解释 shell 优先级',
    cwd: '多数工具是 run_command 的参数，此处只是引用 / 归其他工具声明',
    depth: 'list_dir 的参数，glob 描述里指引去用它',
    oldString: 'edit_file 的参数，read_file 描述里提醒不要带行号',
    file: 'worktree_manage 的参数（conflict_detail 指定主根文件），其他工具描述里只是普通名词',
    ignore: 'cognition_edit 的参数；cognition_status 描述与 hint 指引去用它（Missing 噪音大的收窄出口）',
    verify: 'orchestration_plan 的批次级验收字段；report / control 描述里只是说“会复跑验收/不要绕过验收”，不是入参',
};

test('描述里提到的参数名必须已声明', () => {
    const vocab = new Set();
    for (const name of toolNames) {
        for (const key of Object.keys(AI_TOOL_DEFS[name].parameters.properties)) vocab.add(key);
    }
    const problems = [];
    for (const name of toolNames) {
        const def = AI_TOOL_DEFS[name];
        const props = new Set(Object.keys(def.parameters.properties));
        const desc = String(def.description);
        for (const token of vocab) {
            if (props.has(token) || PROSE_TOKENS[token]) continue;
            if (!new RegExp('(^|[^A-Za-z0-9_])' + token + '([^A-Za-z0-9_]|$)').test(desc)) continue;
            problems.push(name + '：描述里提到「' + token + '」，但 parameters.properties 没有它' +
                '（要么补参数，要么把说法改成不误导；确有正当理由就登记 PROSE_TOKENS）');
        }
    }
    assert.deepEqual(problems, []);
});

test('执行分支不得读取未声明的参数', () => {
    const problems = [];
    for (const part of executeBody.split(/\n {12}case '/).slice(1)) {
        // split 吃掉的是「case '」本身，所以这一段以 `名字':` 开头
        const name = part.slice(0, part.indexOf("'"));
        const def = AI_TOOL_DEFS[name];
        if (!def) continue;
        const props = new Set(Object.keys(def.parameters.properties));
        for (const key of new Set([...part.matchAll(/\binput\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))) {
            if (!props.has(key)) {
                problems.push(name + '：读了 input.' + key + '，但没在 parameters.properties 声明（模型不会知道要填）');
            }
        }
    }
    assert.deepEqual(problems, []);
});
