// 跨模块符号泄漏扫描（拆分后的第一道静态防线）。
//
// 背景：把函数体从宿主搬到兄弟模块时，「函数体搬走了、它依赖的符号没跟着走」只会在运行时炸
// ——import/link/vite/单元测试全都看不见。2026-11-14 拆设置页时连续踩了三次：
//   elsSettings 未注入 → 整个设置页打不开；RECIPES/SELF_TEST 没 import → 启动即 ReferenceError；
//   initPluginRuntime({ flash }) 对象简写裸引用 → 同上。
//
// 规则：对每个被拆出来的模块，收集两处符号
//   R1 宿主文件的顶层定义（function/const/let/var）
//   R2 宿主文件 import 进来的名字（子模块往往也需要，但没人 import）
// 若模块里裸用（前面不是 . 或标识符字符）其中某个名字，本文件又没定义/import，则报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function read(rel) {
    return readFileSync(join(SRC, rel), 'utf8');
}

// 去掉注释与字符串字面量，避免把说明文字当成代码
function code(text) {
    return text
        // 工作副本是 CRLF（core.autocrlf=true）：先归一到 LF，否则逐行的 // 剥离整条失效
        // （`.*` 不吃 \r、非多行模式的 `$` 也不在 \r 前匹配，注释会被当成代码扫）
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
        .join('\n')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// 宿主多为 factory：内部声明缩进 4 空格。旧版正则用行首 ^ 匹配，把整片 ctx 解包与
// 内部函数声明全漏掉，导致扫描形同虚设（2026-11-15 拆 A3 时发现）。这里放到 0–4 空格，
// 8 空格以上的函数内局部变量仍排除，避免 row/entry 这类通用名制造误报。
function decls(text) {
    const src = code(text);
    const out = new Set();
    for (const m of src.matchAll(/^ {0,4}(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^ {0,4}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^ {0,4}(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
        for (const id of m[1].match(/[A-Za-z_$][\w$]*/g) || []) out.add(id);
    }
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const part of m[1].split(',')) {
            const id = part.trim().split(/\s+as\s+/).pop().trim();
            if (id) out.add(id);
        }
    }
    for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) out.add(m[1]);
    return out;
}


// 形参与解构出来的本地名（模块内部常把 host 的同名顶层标识符当成本地参数，如 title/el/id）
function params(text) {
    const src = code(text);
    const out = new Set();
    const groups = [];
    for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) groups.push(m[1]);
    for (const m of src.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) groups.push(m[1]);
    for (const m of src.matchAll(/for\s*\((?:const|let|var)\s+([^)]*)\)/g)) groups.push(m[1]);
    for (const g of groups) {
        for (const part of g.split(',')) {
            const cleaned = part.replace(/[{}[\]=.\s]/g, ' ').trim();
            for (const id of cleaned.match(/[A-Za-z_$][\w$]*/g) || []) out.add(id);
        }
    }
    return out;
}


// 模块侧要连函数内局部声明一起算（8 空格缩进的 const id / const event 会遮蔽宿主同名顶层）
function locals(text) {
    const src = code(text);
    const out = new Set();
    for (const m of src.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
        for (const id of m[1].match(/[A-Za-z_$][\w$]*/g) || []) out.add(id);
    }
    return out;
}

// 宿主 → 它拆出来的兄弟模块
const HOSTS = [
    {
        host: 'settings/settings-ui.js',
        modules: ['settings/settings-dialogs.js', 'settings/settings-select.js', 'settings/settings-search.js'],
    },
    {
        host: 'writing/writing-ui.js',
        modules: [
            'writing/writing-mode.js',
            'editor/foot-menus.js',
            'editor/markdown-mermaid.js',
            'settings/settings-pane-run.js',
            'settings/settings-pane-plugins.js',
            'settings/settings-pane-envvars.js',
            'settings/settings-pane-lang.js',
        ],
    },
    {
        host: 'terminal/terminal-ui.js',
        modules: ['terminal/run-ui.js', 'terminal/terminal-sessions.js'],
    },
    {
        host: 'bridge/bridge-ui.js',
        modules: ['bridge/bridge-git.js', 'bridge/bridge-terminal-view.js', 'bridge/bridge-cli-convert.js'],
    },
    {
        // 扁平列表引擎与宿主共享选择状态 / 渲染辅助 / options，经 deps 注入；let 状态走 getter/setter
        host: 'explorer/explorer.js',
        modules: ['explorer/explorer-list.js'],
    },
    {
        host: 'shell/titlebar-popovers.js',
        modules: ['shell/titlebar-project.js', 'shell/titlebar-git-branch.js'],
    },
    {
        host: 'ai/session/ai-session-store.js',
        modules: ['ai/session/ai-session-disk.js'],
    },
    {
        // 四个子域与宿主共享同一个 ctx（模块内自取 const x = ctx.x），
        // 宿主函数一律经 extras 注入，故宿主侧只剩 ctx 解包与 binder 两种符号
        host: 'ai/settings/ai-settings-dialog.js',
        modules: [
            'ai/security/ai-permission-settings.js',
            'ai/settings/ai-preference-settings.js',
            'ai/settings/ai-model-settings.js',
            'ai/settings/ai-settings-io.js',
        ],
    },
    {
        // 补丁卡 / 提问卡与宿主共享同一个 ctx；宿主的 updateComposerTakeover / askNavAction
        // 经 extras 注入（分发器在宿主工厂内后定义，extras 传惰性箭头）
        host: 'ai/chat/ai-takeover.js',
        modules: ['ai/chat/ai-patch-card.js', 'ai/chat/ai-ask-cards.js'],
    },
    {
        // 详情视图 / 头部 HUD 与宿主共享同一个 ctx；块模型纯函数与运行态注册表
        // （const Map 活引用）、运行时动作经 extras 注入
        host: 'ai/agent/ai-subagents.js',
        modules: ['ai/agent/ai-agent-view.js', 'ai/agent/ai-head-hud.js'],
    },
    // 注：main.js 是无 export 的顶层脚本，module-scope 的「宿主顶层符号」扫描对它误报
    // （deps 对象的 getter 键如 get flash()/get backend() 会被当成裸用宿主同名符号）。
    // shell/aux-window-modes.js（phase4 M1）改用 .cadt/tmp 一次性静态扫描核对 deps 契约，不进 HOSTS。
];

test('拆出的模块不得裸用宿主定义/宿主 import 的符号', () => {
    const problems = [];
    for (const {host, modules} of HOSTS) {
        const hostNames = decls(read(host));
        for (const mod of modules) {
            const text = read(mod);
            const own = locals(text);
            for (const name of decls(text)) own.add(name); // import 进来的名字
            for (const name of params(text)) own.add(name);
            const body = code(text);
            for (const name of hostNames) {
                if (own.has(name)) continue;
                // 裸用：前面不是 . 与标识符字符；且不是对象键（后面紧跟 :）
                // 排除正则字面量里的 \\s / \\d 之类（前面是反斜杠）
                const re = new RegExp('(?<![\\w$.\\\\])' + name + '\\b', 'g');
                for (const m of body.matchAll(re)) {
                    const after = body.slice(m.index + name.length).trimStart();
                    if (after.startsWith(':')) continue; // 对象字面量的键
                    problems.push(`${mod} 裸用了 ${name}（定义/导入在 ${host}）→ 应 import，或改 deps.${name} 并在宿主注入`);
                    break;
                }
            }
        }
    }
    assert.deepEqual(problems, [], '跨模块符号泄漏：\n' + problems.join('\n'));
});

// 第二道：工厂构造期冒烟。
// 静态扫描只能看「有没有裸用宿主符号」，看不出「模块 A 的初始化调用排在模块 A 构造之前」（TDZ）、
// 「工厂返回面引用了已搬走的标识符」这类只有真正执行一遍才会炸的问题。
// 这里用 Proxy 造一个「任何属性都是函数」的 ctx，把宿主工厂整体构造一次：
// 构造期只解包与建子模块，不触 DOM，因此不需要真实页面。
test('AI 设置域在 mock ctx 下可构造（捕获工厂执行期的 ReferenceError / TDZ）', async () => {
    const g = globalThis;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const anyObj = new Proxy({}, {
        get: (t, key) => (key === 'then' ? undefined : anyFn),
        set: () => true,
    });
    const anyFn = new Proxy(function () {}, {
        get: (t, key) => (key === 'then' ? undefined : anyFn),
        apply: () => anyFn,
        construct: () => anyObj,
    });
    g.window = {addEventListener() {}, removeEventListener() {}};
    g.document = {getElementById: () => null, createElement: () => anyObj};
    try {
        const mod = await import(new URL('../../src/ai/settings/ai-settings-dialog.js', import.meta.url).href);
        const api = mod.createAISettingsDialog(new Proxy({}, {get: () => anyFn}));
        const required = [
            'bindSettingsPane', 'refreshSettingsPane', 'refreshChatSettings', 'setSettingsStatus',
            'renderPermissionSettings', 'renderProjectRuleTable', 'renderPreferenceSettings',
            'renderModelList', 'openModelEditor', 'editorEntryOf', 'exportAIConfig', 'importAIConfig',
            'isPathApproved', 'projectRulesPath', 'commandApprovalRules', 'addCommandApprovalRule',
        ];
        const missing = required.filter((key) => typeof api[key] === 'undefined');
        assert.deepEqual(missing, [], '工厂返回面缺成员：' + missing.join(' '));
    } finally {
        g.window = prevWindow;
        g.document = prevDocument;
    }
});

// AI 接管卡域（phase3 A2）：宿主工厂构造期会先建补丁卡 / 提问卡两个兄弟模块，
// 这里整体构造一次，捕获 extras 接线顺序 / 返回面别名漏配这类只有执行才炸的问题。
test('AI 接管卡域在 mock ctx 下可构造（捕获工厂执行期的 ReferenceError / TDZ）', async () => {
    const g = globalThis;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const anyObj = new Proxy({}, {
        get: (t, key) => (key === 'then' ? undefined : anyFn),
        set: () => true,
    });
    const anyFn = new Proxy(function () {}, {
        get: (t, key) => (key === 'then' ? undefined : anyFn),
        apply: () => anyFn,
        construct: () => anyObj,
    });
    g.window = {addEventListener() {}, removeEventListener() {}};
    g.document = {getElementById: () => null, createElement: () => anyObj};
    try {
        const mod = await import(new URL('../../src/ai/chat/ai-takeover.js', import.meta.url).href);
        const api = mod.createAITakeover(new Proxy({}, {get: () => anyFn}));
        // 返回面 9 键 = ai-panel.js 转发层的全部取用面，缺一即面板接管区失灵
        const required = [
            'requestPatchApproval', 'planApprovalMessage', 'planApprovalKey',
            'renderPatchTakeover', 'renderPatchApprovalBody', 'renderApprovalTakeover',
            'renderAskTakeover', 'renderPlanTakeover', 'updateComposerTakeover',
        ];
        const missing = required.filter((key) => typeof api[key] === 'undefined');
        assert.deepEqual(missing, [], '工厂返回面缺成员：' + missing.join(' '));
    } finally {
        g.window = prevWindow;
        g.document = prevDocument;
    }
});

// AI 子代理域（phase3 A4）：宿主工厂构造期会执行 HUD 绑定块并连带构造详情视图兄弟模块，
// 这里整体构造一次，捕获 extras 接线顺序 / 返回面别名漏配这类只有执行才炸的问题。
test('AI 子代理域在 mock ctx 下可构造（捕获工厂执行期的 ReferenceError / TDZ）', async () => {
    const g = globalThis;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const anyObj = new Proxy({}, {
        get: (t, key) => (key === 'then' ? undefined : anyFn),
        set: () => true,
    });
    const anyFn = new Proxy(function () {}, {
        get: (t, key) => (key === 'then' ? undefined : anyFn),
        apply: () => anyFn,
        construct: () => anyObj,
    });
    g.window = {addEventListener() {}, removeEventListener() {}};
    g.document = {getElementById: () => null, createElement: () => anyObj};
    try {
        const mod = await import(new URL('../../src/ai/agent/ai-subagents.js', import.meta.url).href);
        const api = mod.createAISubagents(new Proxy({}, {get: () => anyFn}));
        // 覆盖三个域：运行时核心 / 头部 HUD / 详情视图（返回面 55 键的代表性子集）
        const required = [
            'startSubAgent', 'runSubAgent', 'runSubRound', 'handleSubEvent', 'finalizeSubAgent',
            'stopSubAgent', 'reviveSubAgent', 'sendToSubAgent', 'waitForInbox',
            'maybeStartSubCompact', 'startSubCompact', 'handleSubCompactEvent',
            'runSubAskQuestion', 'answerSubAsk', 'handleAgentTool',
            'updateHeadHud', 'refreshHeadChips', 'listAgentsForHud', 'renderChipsPop', 'initHud',
            'openAgentView', 'mountAgentView', 'unmountAgentView', 'renderAgentView',
            'bgJobSnapshot', 'notifyBgListeners',
            'subAgents', 'subAgentTranscripts', 'subAgentRecords', 'subCompacts',
        ];
        const missing = required.filter((key) => typeof api[key] === 'undefined');
        assert.deepEqual(missing, [], '工厂返回面缺成员：' + missing.join(' '));
        // 块模型纯函数是模块级导出（宿主经 extras 注入给视图模块），一并核对
        const pureExports = [
            'takeInboxBatch', 'inboxMessageText', 'canReviveRecord', 'isStaleRecord',
            'subAgentScopeOf', 'agentToolArgBrief', 'agentMessageBlocks', 'agentTranscriptBlocks',
            'agentRecordBlocks', 'agentBlockSig',
        ];
        const missingPure = pureExports.filter((key) => typeof mod[key] === 'undefined');
        assert.deepEqual(missingPure, [], '模块级纯函数缺导出：' + missingPure.join(' '));
    } finally {
        g.window = prevWindow;
        g.document = prevDocument;
    }
});
