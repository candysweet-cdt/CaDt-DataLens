// ai-tool-defs 工具表测试：按档位 / 计划模式决定哪些工具下发。
// 重点锁住「计划模式只给 propose_patch 的预检形态、不给任何写工具」这条约定，
// 以及「新增工具必须写进目录」的作者规则（.cadt/memory/ai-tool-catalog-rule.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_TOOL_CATALOG, AI_TOOL_DEFS, AI_TOOL_GROUPS, buildSpawnAgentDef, createAIToolDefs} from '../../../src/ai/tools/ai-tool-defs.js';
import {externalCapabilityUsable} from '../../../src/ai/tools/ai-external-tools.js';

const {toolsForScope} = createAIToolDefs({appControlOn: () => false});
const names = (scope, planMode) => toolsForScope(scope, planMode).map((t) => t.name);

test('buildSpawnAgentDef：默认轮次取自设置，模型看到的是真实值而不是写死的 200', () => {
    const with120 = buildSpawnAgentDef([], 120);
    assert.ok(with120.parameters.properties.maxRounds.description.includes('default 120'),
        '设置改了默认轮次，工具描述必须跟着变');
    assert.ok(!with120.parameters.properties.maxRounds.description.includes('default 200'),
        '不能同时留着旧默认值');
    // 无设置值（0 / 未传）时保留静态基线
    for (const value of [undefined, 0, null]) {
        const base = buildSpawnAgentDef([], value);
        assert.ok(base.parameters.properties.maxRounds.description.includes('default 200'), '缺省仍是 200');
    }
    // 不污染常量对象：def 是新建的，AI_TOOL_DEFS.spawn_agent 保持原样
    assert.ok(AI_TOOL_DEFS.spawn_agent.parameters.properties.maxRounds.description.includes('default 200'));
    // 没候选时不出现 model 参数；有候选才拼进去
    assert.equal(with120.parameters.properties.model, undefined);
    const withModel = buildSpawnAgentDef([{ref: 'a|b', label: '便宜模型', model: 'm1'}], 60);
    assert.ok(withModel.parameters.properties.model, '有候选要加 model 参数');
    assert.ok(withModel.description.includes('「m1」（便宜模型）'), '候选清单要写进描述');
    assert.ok(withModel.parameters.properties.maxRounds.description.includes('default 60'));
});

test('buildSpawnAgentDef：def 仍是纯 name/description/parameters 载荷', () => {
    const def = buildSpawnAgentDef([{ref: 'a|b', label: 'L', model: 'm'}], 80);
    assert.deepEqual(Object.keys(def).sort(), ['description', 'name', 'parameters']);
    assert.deepEqual(Object.keys(def.parameters).sort(), ['properties', 'required', 'type']);
});

test('目录一致性：每个工具定义必须写进目录，目录条目必须指向存在的工具', () => {
    const defs = Object.keys(AI_TOOL_DEFS);
    const catalog = Object.keys(AI_TOOL_CATALOG);
    const missing = defs.filter((name) => !catalog.includes(name));
    assert.deepEqual(missing, [], 'AI_TOOL_DEFS 有工具漏写 <tool_catalog> 目录：' + missing.join(', '));
    const orphan = catalog.filter((name) => !defs.includes(name));
    assert.deepEqual(orphan, [], 'AI_TOOL_CATALOG 有条目指向不存在的工具：' + orphan.join(', '));
});

test('目录一致性：组键必须在注册表里且唯一，每个条目有文案', () => {
    const keys = AI_TOOL_GROUPS.map((group) => group.key);
    assert.equal(new Set(keys).size, keys.length, 'AI_TOOL_GROUPS 组键重复');
    for (const group of AI_TOOL_GROUPS) {
        assert.ok(group.title, '组 ' + group.key + ' 缺标题');
    }
    for (const [name, entry] of Object.entries(AI_TOOL_CATALOG)) {
        assert.ok(keys.includes(entry.group), name + ' 的组键 ' + entry.group + ' 不在注册表');
        assert.ok(entry.blurb && entry.blurb.trim(), name + ' 缺目录文案');
    }
});

test('载荷纯净：toolsForScope 下发的 def 只含 name/description/parameters', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            for (const def of toolsForScope(scope, planMode)) {
                assert.deepEqual(
                    Object.keys(def).sort(),
                    ['description', 'name', 'parameters'],
                    def.name + ' 的下发载荷混入额外字段（目录数据必须独立成表）',
                );
            }
        }
    }
});

test('generate_*：配置了启用条目才下发，计划模式不注入，check_gen 随同', () => {
    const on = createAIToolDefs({appControlOn: () => false, genModelsOn: () => true}).toolsForScope;
    const off = createAIToolDefs({appControlOn: () => false, genModelsOn: () => false}).toolsForScope;
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        const enabled = on(scope, false).map((t) => t.name);
        for (const name of ['generate_image', 'generate_video', 'check_gen']) {
            assert.ok(enabled.includes(name), scope + ' 档未下发 ' + name);
        }
        assert.deepEqual(off(scope, false).map((t) => t.name).filter((n) => n.startsWith('generate') || n === 'check_gen'),
            [], '未配置条目时不应下发生成工具：' + scope);
    }
    const plan = on('read', true).map((t) => t.name);
    assert.ok(!plan.includes('generate_image'), '计划模式不下发 generate_image');
    assert.ok(!plan.includes('generate_video'), '计划模式不下发 generate_video');
    assert.ok(!plan.includes('check_gen'), '计划模式不下发 check_gen');
});

test('toolCatalogText：按档位过滤、合并同文案相邻工具、含会话新组', () => {
    const catalogText = createAIToolDefs({appControlOn: () => false}).toolCatalogText;
    const read = catalogText('read', false);
    assert.ok(read.includes('- list_dir: List directory entries and file sizes; depth 2-8 recurses into a tree'));
    assert.ok(read.includes('- memory_list / memory_read / memory_write: Cross-session facts and conclusions'));
    assert.ok(read.includes('## Sessions, reminders, and notifications'));
    assert.ok(read.includes('- reminder_add / reminder_list / reminder_update / reminder_remove:'));
    assert.ok(!read.includes('## File writes'), '只读档非计划模式不应出现写组');
    assert.ok(!read.includes('- write_file'));

    const plan = catalogText('read', true);
    assert.ok(plan.includes('## File writes (read first, then edit; goes through approval)'), '计划模式有 propose_patch 预检，写组应出现');
    assert.ok(plan.includes('- propose_patch:'));
    assert.ok(!plan.includes('- reminder_add'), '计划模式不下发 reminder_add');
    assert.ok(plan.includes('- reminder_list:'), '计划模式保留 reminder_list（只读）单列一行');
});

test('toolCatalogText：app_control 与 MCP 工具按可用性出现，结构段完整', () => {
    const withoutApp = createAIToolDefs({appControlOn: () => false}).toolCatalogText('full', false);
    assert.ok(!withoutApp.includes('## App UI (current window)'));
    assert.ok(!withoutApp.includes('## External MCP servers (third-party tools)'));
    const withAll = createAIToolDefs({
        appControlOn: () => true,
        mcpToolDefs: () => [{name: 'mcp__demo_lookup', description: '演示', input_schema: {type: 'object'}}],
    }).toolCatalogText('full', false);
    assert.ok(withAll.includes('## App UI (current window)'));
    assert.ok(withAll.includes('## External MCP servers (third-party tools)'));
    assert.ok(withAll.includes('Dispatch rules:'));
    assert.ok(withAll.includes('Typical task → tool chain:'));
    assert.ok(withAll.endsWith('</tool_catalog>'));
});

test('计划模式：只读/写档都给 propose_patch（预检用），但不给任何写工具', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        const list = names(scope, true);
        assert.ok(list.includes('propose_patch'), scope + ' 计划模式应可用 propose_patch');
        for (const tool of ['write_file', 'edit_file', 'run_command', 'background_command', 'browser_click', 'todo_write']) {
            assert.ok(!list.includes(tool), scope + ' 计划模式不应下发 ' + tool);
        }
    }
});

test('非计划模式：写工具与 propose_patch 按档位下发', () => {
    for (const scope of ['edit', 'auto', 'full']) {
        const list = names(scope, false);
        for (const tool of ['write_file', 'edit_file', 'propose_patch', 'run_command']) {
            assert.ok(list.includes(tool), scope + ' 应下发 ' + tool);
        }
    }
    const readOnly = names('read', false);
    for (const tool of ['write_file', 'edit_file', 'propose_patch']) {
        assert.ok(!readOnly.includes(tool), '只读档不应下发 ' + tool);
    }
});

test('timer_list：所有权限档与计划模式都下发只读时钟，且不接受任何参数', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.ok(names(scope, planMode).includes('timer_list'), scope + ' / planMode=' + planMode + ' 应下发 timer_list');
        }
    }
    const def = toolsForScope('read', false).find((t) => t.name === 'timer_list');
    assert.deepEqual(Object.keys(def.parameters.properties), [], 'timer_list 是纯快照，不接受参数');
    assert.match(AI_TOOL_DEFS.timer_list.description, /Read-only/);
    assert.match(AI_TOOL_DEFS.timer_list.description, /do not call it repeatedly/);
    assert.ok(AI_TOOL_CATALOG.timer_list, '工具目录必须登记 timer_list');
});

test('list_dir：depth 参数递归列子目录，缺省仍是单层', () => {
    const def = toolsForScope('read', false).find((t) => t.name === 'list_dir');
    assert.deepEqual(Object.keys(def.parameters.properties), ['path', 'depth']);
    // P2-1：depth 的缺省/depth 上限细节只在参数说明里写一次
    assert.match(AI_TOOL_DEFS.list_dir.parameters.properties.depth.description, /omitted\/1 lists one level/,
        '参数说明要写清缺省行为不变');
    assert.match(AI_TOOL_DEFS.list_dir.parameters.properties.depth.description, /400 entries/,
        '参数说明要交代条目预算，别让模型以为无限递归');
    assert.match(AI_TOOL_DEFS.list_dir.description, /one recursive call/,
        '描述要明确「一次递归代替逐层调用」的行为指引');
});

test('计划模式仍保留只读探索与子代理', () => {
    const list = names('read', true);
    for (const tool of ['list_dir', 'read_file', 'search_text', 'spawn_agent']) {
        assert.ok(list.includes(tool), '计划模式应保留 ' + tool);
    }
});

test('read_image：只读档与计划模式都下发，且必须登记目录', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.ok(names(scope, planMode).includes('read_image'),
                scope + ' / planMode=' + planMode + ' 应下发 read_image（只读能力，不该被档位挡住）');
        }
    }
    const def = toolsForScope('read', false).find((tool) => tool.name === 'read_image');
    assert.deepEqual(Object.keys(def.parameters.properties), ['path'], 'read_image 只接受 path');
    assert.match(AI_TOOL_DEFS.read_image.description, /read_file/, '描述里要点明与 read_file 的分工');
    assert.match(AI_TOOL_DEFS.read_image.description, /800–1600 token/, '描述里要写上下文成本');
    assert.equal(AI_TOOL_CATALOG.read_image.group, 'read', 'read_image 属于只读组');
    // 目录文案必须真的描述「看画面」，别退回成读文本
    assert.match(AI_TOOL_CATALOG.read_image.blurb, /picture/);
});

test('read_video：只读档与计划模式都下发，且必须登记目录', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.ok(names(scope, planMode).includes('read_video'),
                scope + ' / planMode=' + planMode + ' 应下发 read_video（只读能力，不该被档位挡住）');
        }
    }
    const def = toolsForScope('read', false).find((tool) => tool.name === 'read_video');
    assert.deepEqual(Object.keys(def.parameters.properties), ['path'], 'read_video 只接受 path');
    assert.match(AI_TOOL_DEFS.read_video.description, /read_file/, '描述里要点明与 read_file 的分工');
    assert.match(AI_TOOL_DEFS.read_video.description, /read_image/, '描述里要点明与 read_image 的分工');
    assert.match(AI_TOOL_DEFS.read_video.description, /4000 token/, '描述里要写上下文成本');
    assert.match(AI_TOOL_DEFS.read_video.description, /mp4/, '描述里要写格式限制');
    assert.match(AI_TOOL_DEFS.read_video.description, /no video input enabled/, '描述里要写模型未勾选视频输入时的行为');
    assert.equal(AI_TOOL_CATALOG.read_video.group, 'read', 'read_video 属于只读组');
    assert.match(AI_TOOL_CATALOG.read_video.blurb, /mp4/);
});

test('read_video 按会话视频能力裁剪：不支持时工具与目录链一起消失', () => {
    const session = {id: 's-video'};
    const capable = (enabled) => createAIToolDefs({
        appControlOn: () => false,
        videoCapableOf: (s) => s === session && enabled,
    });
    const has = (enabled, scope, planMode) =>
        capable(enabled).toolsForScope(scope, planMode, session).some((t) => t.name === 'read_video');
    // 支持视频：所有档位与计划模式都下发（与旧行为一致）
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.equal(has(true, scope, planMode), true, scope + ' / ' + planMode + ' 支持视频应下发 read_video');
        }
    }
    // 不支持视频：所有档位与计划模式都不下发
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.equal(has(false, scope, planMode), false, scope + ' / ' + planMode + ' 不支持视频不该下发 read_video');
        }
    }
    // 目录：能力判定必须透传到 toolCatalogText，否则"看视频"工具链仍会错误展示
    const catalogOn = capable(true).toolCatalogText('read', false, session);
    const catalogOff = capable(false).toolCatalogText('read', false, session);
    assert.match(catalogOn, /read_video/, '支持视频时目录含 read_video');
    assert.match(catalogOn, /Watch a video/, '支持视频时目录含"看视频"工具链');
    assert.doesNotMatch(catalogOff, /read_video/, '不支持视频时目录不该出现 read_video');
    assert.doesNotMatch(catalogOff, /Watch a video/, '不支持视频时目录不该出现"看视频"工具链');
    // 顺序稳定：下发列表里 read_video 仍紧跟 read_image
    const enabledNames = capable(true).toolsForScope('read', false, session).map((t) => t.name);
    assert.equal(enabledNames[enabledNames.indexOf('read_video') - 1], 'read_image', 'read_video 应紧跟 read_image');
});

test('网图走 read_image：描述里写明 URL 通道，web_fetch 把图片指向它', () => {
    // web_fetch 遇到 image/* 只会报错，模型必须知道改投 read_image（否则就像 2026-11-17 那张
    // picsum 链接：报一次失败后只能猜「URL 有效但看不了」）。
    assert.match(AI_TOOL_DEFS.read_image.description, /URL/, 'read_image 描述要写明接受公网图片 URL');
    assert.match(AI_TOOL_DEFS.read_image.parameters.properties.path.description, /URL/,
        'path 参数描述要点明可传 URL（模型只看参数说明也会填）');
    assert.match(AI_TOOL_DEFS.web_fetch.description, /read_image/, 'web_fetch 描述要把图片链接指向 read_image');
    // 不新增 url 参数：少一个字段就少一次填错
    assert.deepEqual(Object.keys(AI_TOOL_DEFS.read_image.parameters.properties), ['path'],
        'read_image 仍只接受 path（URL 走同一个入参）');
});

test('外部工具来源：off 不注册、provider 按档、MCP 只在写档非计划模式', () => {
    const modesFor = (modes) => (cap, scope, planMode) =>
        externalCapabilityUsable(cap, modes[cap] || 'off', scope, planMode);
    const tools = (modes) => createAIToolDefs({appControlOn: () => false, externalToolsOn: modesFor(modes)}).toolsForScope;
    const namesOf = (modes, scope, planMode) => tools(modes)(scope, planMode).map((t) => t.name);

    const allOff = namesOf({}, 'full', false);
    for (const name of ['web_search', 'web_fetch', 'ocr', 'text_to_speech', 'transcribe_audio']) {
        assert.ok(!allOff.includes(name), '来源关闭时不应注册 ' + name);
    }
    const builtin = namesOf({search: 'builtin', fetch: 'builtin'}, 'read', true);
    assert.ok(builtin.includes('web_search') && builtin.includes('web_fetch'), '内置搜索/抓取全档可用（含计划模式）');
    assert.ok(!builtin.includes('ocr'), '未启用的 OCR 不应下发');

    const provider = namesOf({ocr: 'provider', asr: 'provider', tts: 'provider'}, 'read', false);
    assert.ok(provider.includes('ocr') && provider.includes('transcribe_audio'), 'provider 识别能力只读档可用');
    assert.ok(!provider.includes('text_to_speech'), 'TTS 写工作区产物，只读档不下发');
    assert.ok(!namesOf({tts: 'provider'}, 'edit', true).includes('text_to_speech'), '计划模式不下发 TTS');
    assert.ok(namesOf({tts: 'provider'}, 'edit', false).includes('text_to_speech'), '写档非计划模式下发 TTS');

    const mcp = namesOf({search: 'mcp', ocr: 'mcp'}, 'read', false);
    assert.ok(!mcp.includes('web_search') && !mcp.includes('ocr'), 'MCP 来源沿用写权限档边界');
    const mcpWrite = namesOf({search: 'mcp', ocr: 'mcp'}, 'auto', false);
    assert.ok(mcpWrite.includes('web_search') && mcpWrite.includes('ocr'), '写档非计划模式可用 MCP 来源');
});

test('write_worklog：标题只写索引里那一句，细节留给 summary', () => {
    const def = AI_TOOL_DEFS.write_worklog;
    // 标题会进 .cadt/logs/{YYYY}/{MM}/INDEX.md，索引一行一条，长了就退化成正文复制
    assert.match(def.description, /month index/, '描述要点明标题进索引、索引只显示标题');
    assert.match(def.parameters.properties.title.description, /≤40/,
        '标题要限长：索引行只放这一句');
    assert.match(def.parameters.properties.title.description, /summary/,
        '标题描述要把细节推向 summary');
    assert.match(def.parameters.properties.summary.description, /Detail summary/,
        'summary 是细节摘要，不是第二份标题');
    assert.ok(def.parameters.required.includes('title') && !def.parameters.required.includes('summary'),
        '标题必填、摘要可选');
});

test('任务提醒与任务清单：描述里互相写清分工，避免把拆步塞进提醒', () => {
    assert.match(AI_TOOL_DEFS.reminder_add.description, /todo_write/,
        'reminder_add 描述要把拆步场景指向 todo_write');
    assert.doesNotMatch(AI_TOOL_DEFS.reminder_add.description, /拆步后怕丢步骤/,
        '不能再把「长任务拆步」说成提醒的用途');
    assert.match(AI_TOOL_DEFS.todo_write.description, /reminder_add/,
        'todo_write 描述要把零散备忘指向 reminder_add');
});

// 英文化护栏（2026-11-30）：工具描述已全部改为英文，允许保留的中文只剩界面专有名词
// （「快捷便签」「任务提醒」「应用页面 → 外部工具」等用户要照着找的词），总量按字符锁定。
// 只许减不许增：新增工具写中文描述会让模型侧中英混排回归，这条会直接红。
// 现网实测 645 字（工具级 + 参数级合计），基线留 55 字余量。
const DESCRIPTION_CJK_BASELINE = 700;

test('工具描述的中文字符总量不回升（英文化护栏，基线只减不增）', () => {
    const CJK_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g;
    let total = 0;
    const offenders = [];
    for (const [name, def] of Object.entries(AI_TOOL_DEFS)) {
        const texts = [def.description];
        for (const spec of Object.values((def.parameters && def.parameters.properties) || {})) {
            if (spec && typeof spec.description === 'string') texts.push(spec.description);
        }
        for (const text of texts) {
            const hits = String(text || '').match(CJK_RE) || [];
            total += hits.length;
            if (hits.length > 40) offenders.push(name + '（' + hits.length + ' 字）');
        }
    }
    assert.ok(total <= DESCRIPTION_CJK_BASELINE,
        '工具描述中文字符从 645 涨到 ' + total + '：新增描述请写英文（界面专有名词除外）');
    assert.deepEqual(offenders, [],
        '单个工具的中文描述超过 40 字，多半是整句中文漏翻：' + offenders.join(', '));
});
