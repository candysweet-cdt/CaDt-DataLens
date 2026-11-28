// ai-system-context 组装域测试：段顺序（稳定 → 动态）、注入开关、附件块格式化、
// workspace_rules 按档位给守则。面板闭包状态全部经 ctx getter 注入，这里用假 ctx。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAISystemContext, buildSkillsIndexEntries, truncateSkillDescription} from '../../../src/ai/core/ai-system-context.js';

function makeCtx(overrides = {}) {
    const settings = {
        aiInjectPersona: false,
        aiInjectAgentsMd: false,
        aiInjectMemory: false,
        aiInjectPreferences: false,
        aiInjectSkills: false,
        aiInjectEnvVars: false,
        aiInjectRoot: false,
        aiInjectActiveFile: false,
        aiInjectCaret: false,
        aiInjectViewport: false,
        aiInjectOpenFiles: false,
        ...(overrides.settings || {}),
    };
    const config = {outputLanguage: 'zh', persona: {}, preferences: [], ...(overrides.config || {})};
    return {
        get settings() { return settings; },
        get config() { return config; },
        effectiveSystemPrompt: () => 'BASE-PROMPT',
        aiProjectRoot: () => '',
        aiJoinPath: (root, rel) => root + '/' + rel,
        readTextFile: async () => ({text: 'FILE-CONTENT'}),
        resolveMemoryDir: async () => ({dir: '/mem', mode: 'workspace'}),
        aiDisplayPath: (path) => path,
        aiDisplayRootLabel: (root) => root,
        aiNormalizePath: (path) => path,
        listSkills: async () => [{name: 'demo-skill', description: '演示技能', source: 'builtin'}],
        skillSourceLabel: (source) => (source === 'builtin' ? '内置' : source),
        listEnvVarsForAI: async () => [{name: 'DEMO_VAR', description: '演示变量', enabled: true}],
        toolCatalogText: () => '<tool_catalog>CATALOG</tool_catalog>',
        currentScopeOf: () => 'read',
        getWorkspaceContext: () => ({activeFile: null, openFiles: []}),
        getScopeRoot: () => '',
        ...overrides.ctx,
    };
}

function sectionOf(text, tag) {
    const match = text.match(new RegExp('<' + tag + '[\\s\\S]*?</' + tag + '>'));
    return match ? match[0] : null;
}

// 多工作区下「工作区知识跟会话走」：同一个面板里 A 会话在 repo-a、B 会话在 repo-b，
// 注入的 AGENTS.md 与记忆目录必须各读各的仓库。
// 这条曾经是测试空白——测试桩把 aiProjectRoot 写成固定 `/w`，多工作区串仓库的 bug
// 无论如何都测不出来（2026-11-26 补）。
test('AGENTS.md 跟会话根走：不同会话读各自仓库的那份', async () => {
    const readPaths = [];
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectAgentsMd: true},
        ctx: {
            // 模拟 aiProjectRoot(session)：根由会话自己带
            aiProjectRoot: (session) => (session && session.workspace) || '',
            readTextFile: async (path) => {
                readPaths.push(path);
                return {text: 'AGENTS of ' + path};
            },
        },
    }));
    const a = await mod.assembleSystemContext({workspace: '/repo-a', todos: []}, []);
    const b = await mod.assembleSystemContext({workspace: '/repo-b', todos: []}, []);
    assert.deepEqual(readPaths, ['/repo-a/AGENTS.md', '/repo-b/AGENTS.md'],
        '两次组装必须各读各自仓库的 AGENTS.md，不能共用固定根');
    assert.match(sectionOf(a.text, 'agents_md'), /AGENTS of \/repo-a\/AGENTS\.md/);
    assert.match(sectionOf(b.text, 'agents_md'), /AGENTS of \/repo-b\/AGENTS\.md/);
    assert.equal(a.meta.agents.path, '/repo-a/AGENTS.md');
    assert.equal(b.meta.agents.path, '/repo-b/AGENTS.md');
});

test('会话根为空时（多工作区无归属）不注入 AGENTS.md', async () => {    const readPaths = [];
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectAgentsMd: true},
        ctx: {
            aiProjectRoot: () => '',   // harness 下无会话根 = 确定结论
            readTextFile: async (path) => { readPaths.push(path); return {text: 'X'}; },
        },
    }));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    assert.equal(readPaths.length, 0, '没有根就不该发起读盘（否则会去读进程 cwd 的 AGENTS.md）');
    assert.equal(sectionOf(text, 'agents_md'), null);
});

test('记忆目录跟会话根走：不同会话各解析各的工作区记忆', async () => {
    const dirs = [];
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectMemory: true},
        ctx: {
            // 模拟 resolveMemoryDir(session)：workspace 模式落在会话自己的仓库
            resolveMemoryDir: async (session) => {
                const dir = ((session && session.workspace) || '/mem') + '/.cadt/memory';
                dirs.push(dir);
                return {dir, mode: 'workspace'};
            },
            readTextFile: async (path) => {
                if (path.endsWith('MEMORY.md')) return {text: 'MEM of ' + path};
                return {text: 'X'};
            },
        },
    }));
    await mod.assembleSystemContext({workspace: '/repo-a', todos: []}, []);
    await mod.assembleSystemContext({workspace: '/repo-b', todos: []}, []);
    assert.deepEqual(dirs, ['/repo-a/.cadt/memory', '/repo-b/.cadt/memory']);
});

// 项目规则文档回退：很多仓库只有 CLAUDE.md（实测「日记星辰」就是），只认 AGENTS.md 会让
// 项目规则完全不注入——AI 不知道写作规范、记忆在哪，行为看起来「怪但没报错」。
// 口径：AGENTS.md 优先且**独占**（存在就不再读 CLAUDE.md，避免两份规则打架）。
const docCtx = (files) => ({
    settings: {aiInjectAgentsMd: true},
    ctx: {
        aiProjectRoot: () => '/repo',
        readTextFile: async (path) => {
            const name = path.split('/').pop();
            if (!(name in files)) throw new Error('ENOENT ' + path);
            return {text: files[name]};
        },
    },
});

test('项目规则文档：AGENTS.md 优先，存在时不读 CLAUDE.md', async () => {
    const reads = [];
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectAgentsMd: true},
        ctx: {
            aiProjectRoot: () => '/repo',
            readTextFile: async (path) => {
                reads.push(path.split('/').pop());
                return {text: 'FROM ' + path.split('/').pop()};
            },
        },
    }));
    const {text, meta} = await mod.assembleSystemContext({todos: []}, []);
    assert.deepEqual(reads, ['AGENTS.md'], '两份都在时只看 AGENTS.md，不该再读 CLAUDE.md');
    assert.equal(meta.agents.file, 'AGENTS.md');
    assert.match(sectionOf(text, 'agents_md'), /FROM AGENTS\.md/);
});

test('项目规则文档：只有 CLAUDE.md 时回退读它，并标明来源', async () => {
    const {text, meta} = await (async () => {
        const mod = createAISystemContext(makeCtx(docCtx({'CLAUDE.md': 'CLAUDE-RULES'})));
        return mod.assembleSystemContext({todos: []}, []);
    })();
    const block = sectionOf(text, 'agents_md');
    assert.ok(block, '只有 CLAUDE.md 也必须注入（否则项目规则整块丢失）');
    assert.match(block, /CLAUDE-RULES/);
    assert.match(block, /file="CLAUDE\.md"/, '标签要标明实际来源文件，便于排查');
    assert.equal(meta.agents.loaded, true);
    assert.equal(meta.agents.file, 'CLAUDE.md');
    assert.equal(meta.agents.path, '/repo/CLAUDE.md');
});

test('项目规则文档：两份都没有时不注入，且 meta 诚实标 loaded=false', async () => {
    const {text, meta} = await (async () => {
        const mod = createAISystemContext(makeCtx(docCtx({})));
        return mod.assembleSystemContext({todos: []}, []);
    })();
    assert.equal(sectionOf(text, 'agents_md'), null);
    assert.equal(meta.agents.loaded, false);
    assert.equal(meta.agents.path, '/repo/CLAUDE.md', '两个候选都试过了，path 留最后一个候选便于排查');
});

test('基座在最前，系统提示词只含稳定段（动态块不进系统提示词）', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {
            aiInjectPersona: true, aiInjectSkills: true, aiInjectEnvVars: true,
            aiInjectActiveFile: true,
        },
        ctx: {
            getWorkspaceContext: () => ({activeFile: {path: '/w/demo.txt', mode: 'code', cursor: {line: 3, column: 5}}, openFiles: []}),
            getScopeRoot: () => '/w',
        },
    }));
    const {text, turnBlock} = await mod.assembleSystemContext({todos: []}, []);
    // 段与段以空行分隔；按「块以 <tag> 开头」定位，避免标签在守则正文里被提及干扰 indexOf
    const chunks = text.split('\n\n');
    const pos = (tag) => chunks.findIndex((chunk) => chunk.startsWith('<' + tag + '>'));
    const order = ['tool_catalog', 'workspace_rules', 'output_language'].map(pos);
    assert.ok(order.every((p) => p >= 0), '缺段：' + order.join(','));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), '段顺序不稳定');
    assert.equal(chunks[0], 'BASE-PROMPT');
    // 动态块（工作区状态 / 清单 / 提醒 / 附件）不再进系统提示词，改由 turnBlock 随用户消息注入
    for (const tag of ['workspace_context', 'task_todos', 'task_reminders', 'attachments']) {
        assert.equal(sectionOf(text, tag), null, '系统提示词不应含动态块 ' + tag);
    }
    assert.ok(turnBlock.startsWith('<system-reminder>'));
    assert.ok(turnBlock.includes('<workspace_context>\n当前活动文件：/w/demo.txt（视图：code）'));
});

test('注入开关逐段生效，关闭时不留空壳', async () => {
    const mod = createAISystemContext(makeCtx());
    const {text, meta} = await mod.assembleSystemContext({todos: []}, []);
    for (const tag of ['skills', 'memory', 'user_preferences', 'env_vars', 'agents_md', 'task_reminders']) {
        assert.equal(sectionOf(text, tag), null, '开关关闭仍注入了 ' + tag);
    }
    assert.equal(meta.skills.count, 0);
    assert.equal(meta.workspace.loaded, false);
});

// 临时会话（session.temp）：一次性白纸——开关全开也不注入工作区知识（AGENTS.md / 记忆 /
// 认知索引卷与守则 / 工作区状态），只留定性块与应用级能力（偏好 / 技能 / 环境变量）。
test('临时会话：不注入 AGENTS.md / 记忆 / 认知索引 / 工作区状态，只留定性块', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {
            aiInjectPersona: true, aiInjectAgentsMd: true, aiInjectMemory: true,
            aiInjectPreferences: true, aiInjectSkills: true, aiInjectEnvVars: true,
            aiInjectActiveFile: true, aiInjectOpenFiles: true, aiInjectRoot: true,
        },
        config: {preferences: [{text: '始终用中文回答'}]},
        ctx: {
            aiProjectRoot: () => '/w',
            resolveMemoryDir: async () => ({dir: '/w/.cadt/memory', mode: 'workspace'}),
            getScopeRoot: () => '/w',
            getWorkspaceContext: () => ({activeFile: {path: '/w/demo.txt', mode: 'code'}, openFiles: ['/w/demo.txt']}),
            cognitionEnabled: () => true,
            cognitionTurnBlocks: () => ({index: '<cognition_index>VOLUME</cognition_index>', nudge: 'NUDGE'}),
        },
    }));
    const {text, turnBlock, meta} = await mod.assembleSystemContext({temp: true, todos: []}, []);

    assert.equal(sectionOf(text, 'agents_md'), null, '临时会话不注入 AGENTS.md');
    assert.equal(sectionOf(text, 'memory'), null, '临时会话不注入记忆');
    assert.equal(sectionOf(text, 'cognition_rules'), null, '临时会话不注入认知索引守则');
    assert.equal(sectionOf(turnBlock, 'workspace_context'), null, '临时会话不注入工作区状态');
    assert.equal(sectionOf(turnBlock, 'cognition_index'), null, '临时会话不注入认知索引卷');
    assert.ok(!turnBlock.includes('NUDGE'), '临时会话不注入认知维护提醒');

    const block = sectionOf(text, 'transient_session');
    assert.ok(block, '应有一条临时会话定性块：' + text);
    assert.ok(block.includes('默认只读'), '定性块要说清只读');
    assert.ok(block.includes('关闭应用后不再出现'), '定性块要说清不留存');
    assert.equal(meta.transient.workspace, '');

    // 应用级能力照旧：偏好 / 技能 / 环境变量是「怎么做事」，不是工作区知识
    assert.ok(sectionOf(text, 'user_preferences'), '偏好不是工作区知识，仍应注入');
    assert.ok(sectionOf(text, 'skills'));
    assert.ok(sectionOf(text, 'env_vars'));
    assert.deepEqual(meta.agents, {loaded: false, chars: 0, path: ''});
    assert.equal(meta.memory.loaded, false);
});

// 无工作区会话（session.noWorkspace）：与临时会话同样不注入工作区知识，但定性块必须是
// <no_workspace_session>（持久、无「关闭后消失」文案），不能串成临时会话的 <transient_session>。
test('无工作区会话：不注入工作区知识，拿 no_workspace_session 块而非 transient_session', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {
            aiInjectPersona: true, aiInjectAgentsMd: true, aiInjectMemory: true,
            aiInjectPreferences: true, aiInjectSkills: true, aiInjectEnvVars: true,
            aiInjectActiveFile: true, aiInjectOpenFiles: true, aiInjectRoot: true,
        },
        config: {preferences: [{text: '始终用中文回答'}]},
        ctx: {
            aiProjectRoot: () => '/w',
            resolveMemoryDir: async () => ({dir: '/w/.cadt/memory', mode: 'workspace'}),
            getScopeRoot: () => '/w',
            getWorkspaceContext: () => ({activeFile: {path: '/w/demo.txt', mode: 'code'}, openFiles: ['/w/demo.txt']}),
            cognitionEnabled: () => true,
            cognitionTurnBlocks: () => ({index: '<cognition_index>VOLUME</cognition_index>', nudge: 'NUDGE'}),
        },
    }));
    const {text, turnBlock, meta} = await mod.assembleSystemContext({noWorkspace: true, todos: []}, []);

    // 与临时会话一致：工作区知识一律不注入
    assert.equal(sectionOf(text, 'agents_md'), null);
    assert.equal(sectionOf(text, 'memory'), null);
    assert.equal(sectionOf(text, 'cognition_rules'), null);
    assert.equal(sectionOf(turnBlock, 'workspace_context'), null);
    assert.equal(sectionOf(turnBlock, 'cognition_index'), null);
    assert.ok(!turnBlock.includes('NUDGE'));

    // 定性块必须是无工作区专属，且不能带临时会话的「关闭后消失」文案
    assert.equal(sectionOf(text, 'transient_session'), null, '无工作区会话不该拿到临时会话定性块');
    const block = sectionOf(text, 'no_workspace_session');
    assert.ok(block, '应有一条无工作区定性块：' + text);
    assert.ok(block.includes('持久会话'));
    assert.ok(block.includes('重启应用后仍可继续'));
    assert.ok(!block.includes('关闭应用后'), '持久会话不能说关闭后消失');
    assert.equal(meta.noWorkspace.workspace, '');

    // 应用级能力照旧
    assert.ok(sectionOf(text, 'user_preferences'));
    assert.ok(sectionOf(text, 'skills'));
    assert.ok(sectionOf(text, 'env_vars'));
});

test('workspace_context：应用内标签页（浏览器 / 便签 / 计划视图）与文件分开列出，不标「范围外」', async () => {    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectOpenFiles: true},
        ctx: {
            getWorkspaceContext: () => ({
                activeFile: null,
                openFiles: ['/w/demo.txt'],
                openViews: [
                    {kind: 'browser', label: '浏览器', name: 'lightbox probe'},
                    {kind: 'memo', label: '快捷便签', name: '快捷便签'},
                    {kind: 'plan', label: '计划文档', name: 'spawn_agent 单向降档.md'},
                ],
            }),
            getScopeRoot: () => '/w',
        },
    }));
    const {turnBlock, meta} = await mod.assembleSystemContext({todos: []}, []);
    const wc = sectionOf(turnBlock, 'workspace_context');
    assert.ok(wc, '应注入 workspace_context');
    assert.ok(wc.includes('已打开文件（1 个）：'), '虚拟标签页不应计入文件数：' + wc);
    assert.ok(wc.includes('- /w/demo.txt'));
    assert.ok(wc.includes('浏览器「lightbox probe」'), '浏览器标签页应单独列出：' + wc);
    assert.ok(wc.includes('快捷便签'), '便签面板无独立标题时只显示类型名');
    assert.ok(wc.includes('计划文档「spawn_agent 单向降档.md」'));
    assert.ok(!wc.includes('范围外'), '视图不是文件，不该出现范围标注');
    assert.equal(meta.workspace.files, 1);
    assert.equal(meta.workspace.views, 3);
});

test('workspace_context：openViews 超过 12 个截断，缺 openViews 字段不报错', async () => {
    const views = [];
    for (let i = 0; i < 15; i++) views.push({kind: 'browser', label: '浏览器', name: '页 ' + i});
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectOpenFiles: true},
        ctx: {getWorkspaceContext: () => ({activeFile: null, openFiles: [], openViews: views})},
    }));
    const {turnBlock, meta} = await mod.assembleSystemContext({todos: []}, []);
    const wc = sectionOf(turnBlock, 'workspace_context');
    assert.ok(wc.includes('页 11」'), '应列前 12 个');
    assert.ok(!wc.includes('页 12」'), '第 13 个起截断');
    assert.equal(meta.workspace.views, 12);
    // 旧宿主（无 openViews 字段）兼容：不出错也不出空行
    const legacy = createAISystemContext(makeCtx({
        settings: {aiInjectOpenFiles: true},
        ctx: {getWorkspaceContext: () => ({activeFile: null, openFiles: []})},
    }));
    const r2 = await legacy.assembleSystemContext({todos: []}, []);
    assert.equal(sectionOf(r2.turnBlock, 'workspace_context'), null, '没有任何内容时不注入空壳');
});

// 会话根 / 分层渲染（批次 E）：aiDisplayPath 的真实口径——根内给相对路径、根外只留文件名。
function displayPath(value, root) {
    const full = String(value == null ? '' : value).replace(/\\/g, '/');
    const base = String(root == null ? '' : root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (base) {
        if (full.toLowerCase() === base.toLowerCase()) return '.';
        if (full.toLowerCase().startsWith(base.toLowerCase() + '/')) return full.slice(base.length + 1);
    }
    const parts = full.split('/').filter(Boolean);
    return parts.length ? '（范围外）' + parts[parts.length - 1] : '（范围外）';
}

test('workspace_context 分层：本工作区给相对路径、其它工作区只折叠出文件名', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectOpenFiles: true},
        ctx: {
            getScopeRoot: () => 'D:/ws',
            aiDisplayPath: displayPath,
            aiNormalizePath: (p) => String(p == null ? '' : p).replace(/\\/g, '/'),
            getWorkspaceContext: () => ({
                activeFile: null,
                openFiles: [
                    'D:/ws/src/a.js',
                    'd:/WS/src/b.js', // 大小写不敏感：仍算本工作区
                    'D:/other/repo/x.js',
                    'D:/other/repo/y.md',
                    'D:/third/z.txt',
                    'E:/fourth/w.txt',
                    'E:/fifth/v.txt',
                ],
            }),
        },
    }));
    const turn = mod.turnContextBundle({todos: []}, []);
    const wc = sectionOf(turn.text, 'workspace_context');
    assert.ok(wc.includes('已打开文件（本工作区 2 个）：'), wc);
    assert.ok(wc.includes('- src/a.js'));
    assert.ok(wc.includes('- src/b.js'), '同根不同大小写仍属本工作区');
    // 5 个外区文件分属 4 个目录：只给目录数 + 文件名前 4 个 + 「等」
    assert.ok(wc.includes('其它工作区的已打开文件（4 个目录 / 5 个文件）：'), wc);
    assert.ok(wc.includes('（范围外）x.js、（范围外）y.md、（范围外）z.txt、（范围外）w.txt 等'), wc);
    assert.ok(!wc.includes('D:/other') && !wc.includes('E:/fourth'), '外区路径不得可解析（会诱导模型直接 read_file）');
    assert.equal(turn.meta.workspace.files, 2);
    assert.equal(turn.meta.workspace.otherFiles, 5);
});

test('workspace_context 分层：全部在本工作区时不加「本工作区」标签（旧形态逐字保留）', () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectOpenFiles: true},
        ctx: {
            getScopeRoot: () => '/w',
            aiDisplayPath: displayPath,
            aiNormalizePath: (p) => String(p == null ? '' : p).replace(/\\/g, '/'),
            getWorkspaceContext: () => ({activeFile: null, openFiles: ['/w/a.js', '/w/b.md']}),
        },
    }));
    const turn = mod.turnContextBundle({todos: []}, []);
    const wc = sectionOf(turn.text, 'workspace_context');
    assert.ok(wc.includes('已打开文件（2 个）：'), wc);
    assert.ok(!wc.includes('本工作区'), '没有外区文件时不引入新标签');
    assert.ok(!wc.includes('其它工作区'));
    assert.equal(turn.meta.workspace.otherFiles, undefined);
});

test('workspace_context：活动文件跨根时追加「属于其它工作区，读取需授权」', () => {
    const inside = createAISystemContext(makeCtx({
        settings: {aiInjectActiveFile: true},
        ctx: {
            getScopeRoot: () => '/w',
            aiDisplayPath: displayPath,
            getWorkspaceContext: () => ({activeFile: {path: '/w/a.md', mode: 'code'}, openFiles: []}),
        },
    }));
    const a = sectionOf(inside.turnContextBundle({todos: []}, []).text, 'workspace_context');
    assert.ok(a.includes('当前活动文件：a.md（视图：code）'), a);
    assert.ok(!a.includes('属于其它工作区'), '同根文件不该带跨根提示');

    const outside = createAISystemContext(makeCtx({
        settings: {aiInjectActiveFile: true},
        ctx: {
            getScopeRoot: () => '/w',
            aiDisplayPath: displayPath,
            getWorkspaceContext: () => ({activeFile: {path: '/elsewhere/repo/a.md', mode: 'code'}, openFiles: []}),
        },
    }));
    const b = sectionOf(outside.turnContextBundle({todos: []}, []).text, 'workspace_context');
    // 活动文件始终注入（用户此刻在看的就是它），只多一句授权提示
    assert.ok(b.includes('当前活动文件：（范围外）a.md（属于其它工作区，读取需授权）（视图：code）'), b);
});

test('范围根跟会话：ctx.scopeRootOf 存在时优先于 getScopeRoot（守则首行与环境块同源）', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectRoot: true, aiInjectActiveFile: true, aiInjectOpenFiles: true},
        ctx: {
            getScopeRoot: () => 'D:/window',
            scopeRootOf: (session) => (session && session.workspace) || '',
            aiDisplayPath: displayPath,
            aiNormalizePath: (p) => String(p == null ? '' : p).replace(/\\/g, '/'),
            getWorkspaceContext: () => ({
                activeFile: {path: 'D:/sess/src/a.md', mode: 'code'},
                openFiles: ['D:/sess/src/a.md', 'D:/window/b.md'],
            }),
        },
    }));
    const {text, turnBlock} = await mod.assembleSystemContext({workspace: 'D:/sess', todos: []}, []);
    assert.ok(sectionOf(text, 'workspace_rules').includes('范围根：D:/sess（工具路径相对此根）'), '守则首行应取会话根');
    assert.ok(turnBlock.includes('当前活动文件：src/a.md'));
    assert.ok(turnBlock.includes('已打开文件（本工作区 1 个）：'), '窗口根下的文件归到「其它工作区」');
    assert.ok(turnBlock.includes('其它工作区的已打开文件（1 个目录 / 1 个文件）'));
    // 无会话根的会话（scopeRootOf 返回空）→ **不再回落窗口根**：harness 下未绑定会话
    // 若回落到活动文件父目录，注入的范围根会指向别的仓库、与工具实际解析不一致
    // （独立审查 🟡）。空即是空，明确告诉模型「未打开工作区」。
    const fallback = await mod.assembleSystemContext({todos: []}, []);
    assert.ok(sectionOf(fallback.text, 'workspace_rules').includes('范围根：（未打开工作区）'),
        'scopeRootOf 存在时它是唯一权威，返回空不许回落窗口根 / 活动文件目录');
    assert.ok(!sectionOf(fallback.text, 'workspace_rules').includes('D:/window'),
        '未绑定会话不得把窗口根注入进来');
});

test('技能 / 环境变量在系统提示词，任务清单 / 提醒随环境块', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectSkills: true, aiInjectEnvVars: true},
        ctx: {listEnvVarsForAI: async () => [{name: 'OFF_VAR', description: '关闭', enabled: false}]},
    }));
    const session = {todos: [{content: '写测试', status: 'in_progress'}, {content: '跑测试', status: 'pending'}], reminders: [{id: 'r1', title: '别忘发版', detail: ''}]};
    const {text, meta, turnBlock} = await mod.assembleSystemContext(session, []);
    const skills = sectionOf(text, 'skills');
    assert.ok(skills.includes('- demo-skill：演示技能（内置）'));
    assert.deepEqual(meta.skills.names, ['demo-skill']);
    assert.equal(sectionOf(text, 'env_vars'), null, '禁用变量不应注入');
    // 清单与提醒随环境块注入，系统提示词里没有
    const todos = sectionOf(turnBlock, 'task_todos');
    assert.ok(todos.includes('共 2 项') && todos.includes('1 项进行中（写测试）') && todos.includes('1 项待处理'));
    const reminders = sectionOf(turnBlock, 'task_reminders');
    assert.ok(reminders.includes('- [r1] 别忘发版'));
    assert.equal(sectionOf(text, 'task_todos'), null);
    assert.equal(sectionOf(text, 'task_reminders'), null);
});

test('附件块：随环境块注入（skill_manual / file_reference / selection_reference / attachment 四种格式）', async () => {
    const mod = createAISystemContext(makeCtx());
    const {text, meta, turnBlock} = await mod.assembleSystemContext({todos: []}, [
        {kind: 'skill', label: 'cadt-ui', content: '动作表'},
        {kind: 'reference', label: 'a.txt', path: '/w/a.txt'},
        {kind: 'selection_reference', label: 'a.txt', path: '/w/a.txt', start: {line: 2, column: 3}, end: {line: 4, column: 6}},
        {kind: 'file', label: 'data.csv', path: '/w/data.csv', content: 'x,y'},
    ]);
    assert.equal(sectionOf(text, 'attachments'), null, '附件不再进系统提示词');
    const block = sectionOf(turnBlock, 'attachments');
    assert.ok(block.includes('<skill_manual name="cadt-ui">\n动作表\n</skill_manual>'));
    assert.ok(block.includes('<file_reference name="a.txt" path="/w/a.txt" />'));
    assert.ok(block.includes('startLine="2" startColumn="3" endLine="4" endColumn="6"'));
    assert.ok(block.includes('<attachment name="data.csv" path="/w/data.csv">\nx,y\n</attachment>'));
    assert.equal(meta.attachments.count, 4);
    assert.equal(meta.attachments.chars, 6); // 动作表(3) + x,y(3)，其余附件无正文
});

test('workspace_rules 按档位给守则，计划模式附加只读约束', async () => {
    const mod = createAISystemContext(makeCtx());
    const read = await mod.assembleSystemContext({todos: []}, []);
    assert.ok(read.text.includes('只读访问：可列目录、读文件、搜索文本'), 'read 档守则缺失');
    const mod2 = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'full'}}));
    const full = await mod2.assembleSystemContext({todos: []}, []);
    assert.ok(full.text.includes('完全权限：可读取与修改工作区内外文件'));
    const mod3 = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'edit'}}));
    const plan = await mod3.assembleSystemContext({todos: [], planMode: true}, []);
    assert.ok(plan.text.includes('（当前为计划模式：只读探索，见 <plan_mode>）'));
    // P1-1：计划模式规则单一来源——workspace_rules 只留指路句，流程细节只在 <plan_mode>
    assert.ok(plan.text.includes('- 计划模式：只读探索并输出计划；规划流程与提交要求见 <plan_mode>。'));
    assert.ok(!plan.text.includes('计划完成后用 submit_plan 提交完整计划并停下等待用户批准'));
    // P0-1：范围外路径与工具描述同口径（可授权，不是一律禁止）
    assert.ok(plan.text.includes('范围外路径需授权：read/edit 档逐次批准'), 'workspace_rules 应说明范围外路径可授权');
});

test('P2-4：稳定区 digest 覆盖 toolCatalogText，MCP/插件名单变化不让 warm cache 命中旧目录', async () => {
    let catalog = '<tool_catalog>mcp__a</tool_catalog>';
    const logs = [];
    const mod = createAISystemContext(makeCtx({ctx: {
        toolCatalogText: () => catalog,
        logFrontend: (line) => logs.push(String(line)),
    }}));
    const session = {id: 's-cache', todos: []};
    const first = await mod.assembleSystemContext(session, []);
    assert.match(first.text, /mcp__a/);
    catalog = '<tool_catalog>mcp__b</tool_catalog>';
    const second = await mod.assembleSystemContext(session, []);
    assert.match(second.text, /mcp__b/);
    // 旧缺陷：digest 不覆盖目录 → 命中旧缓存、文本却不同，走「digest 命中但文本不一致」兜底。
    // 修复后 digest 随目录变化，不应再出现该兜底日志。
    assert.equal(logs.some((line) => line.includes('digest 命中但稳定区文本不一致')), false,
        '目录变化应让 digest 失效，而不是命中后走文本不一致兜底');
    const third = await mod.assembleSystemContext(session, []);
    assert.equal(third.meta.stable.cached, true, '目录未变时应复用缓存');
});

test('planModeBlock 输出计划约定块', () => {
    const mod = createAISystemContext(makeCtx());
    const block = mod.planModeBlock();
    assert.ok(block.startsWith('<plan_mode>') && block.endsWith('</plan_mode>'));
    assert.ok(block.includes('用户必须点「执行计划」才算批准'));
    // 修订语义：补充意见 = 基于原计划修订，不另起炉灶（继续规划场景的模型行为护栏）
    assert.ok(block.includes('修订当前计划'));
    // 纯净文档语义：计划走 submit_plan 参数（正文不承载计划），对话性内容禁入
    assert.ok(block.includes('submit_plan'));
    assert.ok(block.includes('结尾问句'));
    // 澄清语义：意图/方案有歧义时先用 ask_user，疑问不写进计划、也不用普通文本提问
    assert.ok(block.includes('先用 ask_user 澄清'));
    assert.ok(block.includes('核对用户意图'));
    // 提交 ≠ 批准：submit_plan 成功不等于用户批准（实测模型会自称「用户已批准」并开始执行）
    assert.ok(block.includes('提交 ≠ 批准'));
});

test('worktree 块：会话持活跃 worktree 时注入，ctx 未提供或无 worktree 时不注入', async () => {
    const wt = {name: 'demo-ab12', branch: 'cadt/wt/demo-ab12', path: 'D:/repo/.cadt/worktree/demo-ab12', baseSha: 'abc', createdAt: 1};
    // ctx 提供 worktreeBlock（ai-panel 注入 worktreeMod.blockFor）→ 注入且 meta 带名
    const withMod = createAISystemContext(makeCtx({
        ctx: {worktreeBlock: async (session) => (session && session.worktree ? '<worktree>WT-BLOCK ' + session.worktree.name + '</worktree>' : '')},
    }));
    const {text, meta} = await withMod.assembleSystemContext({todos: [], worktree: wt}, []);
    assert.ok(text.includes('<worktree>WT-BLOCK demo-ab12</worktree>'));
    assert.equal(meta.worktree.name, 'demo-ab12');
    // 会话没有 worktree → 块函数返回空串 → 不注入
    const none = await withMod.assembleSystemContext({todos: []}, []);
    assert.ok(!none.text.includes('<worktree>'));
    assert.equal(none.meta.worktree, undefined);
    // ctx 没有该 getter（旧宿主）→ 直接跳过不报错
    const legacy = createAISystemContext(makeCtx());
    const plain = await legacy.assembleSystemContext({todos: [], worktree: wt}, []);
    assert.ok(!plain.text.includes('<worktree>'));
    // 块函数抛错只进 meta.errors，不阻断组装
    const broken = createAISystemContext(makeCtx({
        ctx: {worktreeBlock: async () => { throw new Error('boom'); }},
    }));
    const res = await broken.assembleSystemContext({todos: [], worktree: wt}, []);
    assert.ok(res.meta.errors.some((line) => line.includes('worktree 块：boom')));
});

test('技能索引预算：内置全量必列、用户技能截取上限并报溢出、hidden 过滤', async () => {
    const skills = [
        {name: 'b2', description: '内置 B', source: 'builtin', builtin: true},
        {name: 'u1', description: '用户 1', source: 'workspace', builtin: false},
        {name: 'u2', description: '用户 2', source: 'workspace', builtin: false},
        {name: 'u3', description: '用户 3', source: 'workspace', builtin: false, hidden: true},
        {name: 'u4', description: '用户 4', source: 'workspace', builtin: false},
    ];
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectSkills: true},
        config: {skillIndexMaxUser: 2},
        ctx: {listSkills: async () => skills},
    }));
    const {text, meta} = await mod.assembleSystemContext({todos: []}, []);
    const skillsBlock = sectionOf(text, 'skills');
    assert.ok(skillsBlock.includes('- b2：内置 B（内置）'), '内置技能必须全量列出');
    assert.ok(skillsBlock.includes('- u1：用户 1（workspace）'));
    assert.ok(!skillsBlock.includes('u3'), 'hidden 技能不应出现在索引');
    assert.ok(!skillsBlock.includes('u4'), '超出上限的用户技能不应出现在索引');
    assert.ok(skillsBlock.includes('另有 1 个技能未列出：用 skill_list 查看全部'));
    assert.deepEqual(meta.skills.names, ['b2', 'u1', 'u2']);
    assert.equal(meta.skills.overflow, 1);
});

test('技能索引：上限 clamp 1–100，非法值回落 100；内置不占预算', () => {
    const many = [];
    for (let i = 0; i < 105; i += 1) many.push({name: 'u' + i, description: 'd' + i, source: 'workspace', builtin: false});
    assert.equal(buildSkillsIndexEntries(many, 999).overflow, 5);
    assert.equal(buildSkillsIndexEntries(many, 0).listed.length, 100);
    assert.equal(buildSkillsIndexEntries(many, undefined).listed.length, 100);
    assert.equal(buildSkillsIndexEntries(many, 1).listed.length, 1);
    const withBuiltins = many.map((skill, index) => ({...skill, builtin: index % 2 === 0}));
    const res = buildSkillsIndexEntries(withBuiltins, 1);
    // 内置全量保留（53 个），用户技能只取 1 个
    assert.equal(res.listed.filter((skill) => skill.builtin).length, 53);
    assert.equal(res.listed.filter((skill) => !skill.builtin).length, 1);
});

test('技能描述截断：≤120 原样，超长头 70 + 尾 50，空白折叠', () => {
    assert.equal(truncateSkillDescription('短描述'), '短描述');
    assert.equal(truncateSkillDescription('  a\n b  '), 'a b');
    const head = 'H'.repeat(80);
    const tail = '当用户需要时使用。'.repeat(10); // 90 字
    const cut = truncateSkillDescription(head + tail);
    assert.equal(cut, head.slice(0, 70) + '…' + tail.slice(-50));
    assert.equal(cut.length, 121);
    assert.equal(truncateSkillDescription(null), '');
});

test('记忆占位：MEMORY.md 读不到或为空时注入引导块并标记 placeholder', async () => {
    const missing = createAISystemContext(makeCtx({
        settings: {aiInjectMemory: true},
        ctx: {readTextFile: async () => { throw new Error('not found'); }},
    }));
    const a = await missing.assembleSystemContext({todos: []}, []);
    const memA = sectionOf(a.text, 'memory');
    assert.ok(memA && memA.startsWith('<memory mode="workspace" path="/mem">'));
    assert.ok(memA.includes('（记忆区暂为空）') && memA.includes('MEMORY.md 作为索引'));
    assert.equal(a.meta.memory.placeholder, true);
    assert.equal(a.meta.memory.loaded, true);
    assert.ok(!a.meta.memory.error, '文件不存在不算错误');
    const empty = createAISystemContext(makeCtx({
        settings: {aiInjectMemory: true},
        ctx: {readTextFile: async () => ({text: '   \n'})},
    }));
    const b = await empty.assembleSystemContext({todos: []}, []);
    assert.equal(b.meta.memory.placeholder, true);
    // 有内容：注入原文，不标 placeholder
    const withFile = createAISystemContext(makeCtx({settings: {aiInjectMemory: true}}));
    const c = await withFile.assembleSystemContext({todos: []}, []);
    assert.ok(sectionOf(c.text, 'memory').includes('FILE-CONTENT'));
    assert.ok(!c.meta.memory.placeholder);
});

test('范围根只在 workspace_rules 注入一次；aiInjectRoot 关闭时不再出现', async () => {
    const on = createAISystemContext(makeCtx({
        settings: {aiInjectRoot: true, aiInjectActiveFile: true},
        ctx: {
            getScopeRoot: () => '/w',
            getWorkspaceContext: () => ({activeFile: {path: '/w/a.md', mode: 'code'}, openFiles: []}),
        },
    }));
    const t1 = await on.assembleSystemContext({todos: []}, []);
    const rules = sectionOf(t1.text, 'workspace_rules');
    assert.ok(rules.includes('范围根：/w（工具路径相对此根）'), 'rules 应含范围根（唯一出处）');
    assert.ok(!t1.turnBlock.includes('范围根：'), '环境块不应重复范围根');
    const off = createAISystemContext(makeCtx({
        settings: {aiInjectRoot: false},
        ctx: {getScopeRoot: () => '/w'},
    }));
    const t2 = await off.assembleSystemContext({todos: []}, []);
    assert.ok(!t2.text.includes('范围根：/w（工具路径相对此根）'));
});

test('无工作区 / 无清单 / 无提醒 / 无附件：不生成环境块', async () => {
    const mod = createAISystemContext(makeCtx());
    const {turnBlock, meta} = await mod.assembleSystemContext({todos: []}, []);
    assert.equal(turnBlock, '');
    assert.equal(meta.workspace.loaded, false);
    assert.equal(meta.attachments.count, 0);
});

test('turnContextBundle 可直接调用（起轮路径，同步产出 turnBlock）', () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectActiveFile: true},
        ctx: {
            getWorkspaceContext: () => ({activeFile: {path: '/w/a.md', mode: 'code'}, openFiles: []}),
            getScopeRoot: () => '/w',
        },
    }));
    const turn = mod.turnContextBundle({todos: []}, []);
    assert.ok(turn.text.startsWith('<system-reminder>\n<workspace_context>'));
    assert.ok(turn.text.endsWith('</system-reminder>'));
    assert.equal(turn.meta.workspace.loaded, true);
});

// ---- <plan_status>：审批卡真实状态随轮注入（继续规划讨论轮防幻觉） ----
// 关联 bug：卡片被「继续规划」收起后模型宣称「点「执行计划」我就动手」——它只看得到
// 历史里「提交过计划」，不知道卡此刻在不在。判定经 ctx.planApprovalCardVisible 注入。
const pendingPlanSession = (over = {}) => ({
    planMode: true,
    activePlan: {status: 'pending', markdown: '# 计划', ts: 1},
    todos: [],
    ...over,
});

test('plan_status：卡在输入框上方（待批准）→ 注入等批准状态', () => {
    const mod = createAISystemContext(makeCtx({
        ctx: {planApprovalCardVisible: () => true},
    }));
    const turn = mod.turnContextBundle(pendingPlanSession(), []);
    const block = sectionOf(turn.text, 'plan_status');
    assert.ok(block, '计划待批准时应注入 <plan_status>');
    assert.ok(block.includes('审批卡当前显示在输入框上方'), block);
    assert.ok(block.includes('修订要求'), block);
    assert.deepEqual(turn.meta.planStatus, {visible: true});
});

test('plan_status：卡片已随「继续规划」收起 → 明确告知没有可点的「执行计划」按钮', () => {
    const mod = createAISystemContext(makeCtx({
        ctx: {planApprovalCardVisible: () => false},
    }));
    const turn = mod.turnContextBundle(pendingPlanSession(), []);
    const block = sectionOf(turn.text, 'plan_status');
    assert.ok(block, '卡片已收起时更该注入真实状态');
    assert.ok(block.includes('已随用户点「继续规划」收起'), block);
    assert.ok(block.includes('没有可点的「执行计划」按钮'), block);
    assert.ok(block.includes('重新提交完整修订版'), block);
    assert.deepEqual(turn.meta.planStatus, {visible: false});
});

test('plan_status：非计划模式 / 无计划 / 已批准 → 不注入', () => {
    const mod = createAISystemContext(makeCtx({
        ctx: {planApprovalCardVisible: () => true},
    }));
    for (const session of [
        {planMode: false, activePlan: {status: 'pending', markdown: '# 计划'}, todos: []},
        {planMode: true, activePlan: null, todos: []},
        {planMode: true, activePlan: {status: 'approved', markdown: '# 计划'}, todos: []},
    ]) {
        const turn = mod.turnContextBundle(session, []);
        assert.equal(sectionOf(turn.text, 'plan_status'), null, JSON.stringify(session.activePlan));
        assert.equal(turn.meta.planStatus, undefined);
    }
});

test('plan_status：ctx 未提供判定（旧 mock / 缺绑定）→ 整块跳过，不注入空壳', () => {
    const mod = createAISystemContext(makeCtx());
    const turn = mod.turnContextBundle(pendingPlanSession(), []);
    assert.equal(sectionOf(turn.text, 'plan_status'), null);
});

test('auto 档审批语义收敛进 scopeText：防拆单句保留，重复段已删', async () => {
    const mod = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'auto'}}));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    assert.ok(text.includes('不要把危险操作拆成多条普通命令来规避审批'));
    assert.equal((text.match(/自动审批档：/g) || []).length, 0, 'workspace_rules 里不应再有第二份完整审批表述');
});

test('workspace_rules：memory 守则与涉密引导在，env/spawn 重复行已删', async () => {
    const mod = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'edit'}}));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    const rules = sectionOf(text, 'workspace_rules');
    assert.ok(rules.includes('memory_* 读写跨会话持久记忆'));
    assert.ok(rules.includes('涉密值（API key、令牌、密码等）'));
    assert.ok(!rules.includes('env_list 只返回环境变量的名称与描述'));
    assert.ok(!rules.includes('spawn_agent 派出只读子代理'));
    assert.ok(!rules.includes('write_file 用于新建文件或整体覆盖'), '覆盖前必读语义已收敛到工具描述');
    assert.ok(rules.includes('不要修改 .git 等版本库内部文件'), '.git 红线保留（写档守则）');
});

// 命令 shell 守则（2026-11-18）：模型习惯在默认 Git Bash 档里拼 powershell -Command，
// 双引号内的 $变量 会被 bash 先展开成空串。守则必须写清「怎么用」与「别怎么写」，
// 且只在提供 run_command 的档位出现（只读档没有该工具）。
test('workspace_rules：指定 shell 的守则（写档有、只读档无）', async () => {
    const writable = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'auto'}}));
    const rules = sectionOf((await writable.assembleSystemContext({todos: []}, [])).text, 'workspace_rules');
    assert.ok(rules.includes('shell="pwsh"'), '缺少指定 shell 的守则（模型会继续拼 powershell -Command）');
    assert.ok(rules.includes('powershell -Command'), '守则要写出错误用法，否则模型不知道要避免什么');
    assert.ok(rules.includes('展开成空串'), '守则要给出症状，便于模型自查');

    const readOnly = createAISystemContext(makeCtx());
    const readRules = sectionOf((await readOnly.assembleSystemContext({todos: []}, [])).text, 'workspace_rules');
    assert.ok(!readRules.includes('shell="pwsh"'), '只读档不提供 run_command，不该注入这条');
});

test('env_vars 说明覆盖三种 shell 的引用写法', async () => {
    const mod = createAISystemContext(makeCtx({settings: {aiInjectEnvVars: true}}));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    assert.ok(text.includes('Bash 用 $名称'));
    assert.ok(text.includes('cmd 用 %名称%'));
    assert.ok(text.includes('PowerShell 用 $env:名称'), 'PowerShell 档已支持，说明不能漏');
});
