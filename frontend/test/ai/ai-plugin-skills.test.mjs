// ai-plugin-skills.test.mjs —— 插件技能并入 AI 技能表的接线守卫 + 排序契约。
//
// ai-panel.js 是组合根，listSkillsRaw 依赖大量宿主状态，难以脱离面板单测。这里做两件事：
//   ① 用 plugin-skills 的产出验证「rank 300 排在 workspace 之后 / app 之前」的去重契约；
//   ② 静态断言 ai-panel.js 的关键接线确实存在（漏接线时红），这是守卫测试的常见做法。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {registerPluginSkill, clearPluginSkills, getPluginSkillList} from '../../src/shell/plugin-skills.js';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../../src/ai/ai-panel.js'), 'utf8');
const pluginsSrc = readFileSync(resolve(here, '../../src/shell/plugins.js'), 'utf8');
const mainSrc = readFileSync(resolve(here, '../../src/main.js'), 'utf8');

// 模拟 ai-panel.js 的合并排序（同一口径：rank → rootOrder → localOrder，先到先得）
function mergeSkills(candidates) {
    candidates.sort((a, b) => a.rank - b.rank || a.rootOrder - b.rootOrder || a.localOrder - b.localOrder);
    const merged = new Map();
    for (const c of candidates) if (!merged.has(c.name)) merged.set(c.name, c);
    return [...merged.values()];
}

test('排序契约：插件技能(rank 300) 在工作区之后、应用/用户/内置之前', () => {
    const merged = mergeSkills([
        {name: 'builtin-skill', rank: 600, rootOrder: 0, localOrder: 0, source: 'builtin'},
        {name: 'app-skill', rank: 400, rootOrder: 3, localOrder: 0, source: 'app'},
        {name: 'plugin-skill', rank: 300, rootOrder: 0, localOrder: 0, source: 'plugin'},
        {name: 'ws-skill', rank: 100, rootOrder: 1, localOrder: 0, source: 'workspace'},
    ]);
    assert.deepEqual(merged.map((s) => s.name), ['ws-skill', 'plugin-skill', 'app-skill', 'builtin-skill']);
});

test('去重契约：工作区同名技能压过插件技能（rank 小者先到先得）', async () => {
    clearPluginSkills();
    registerPluginSkill('p1', 'P1', {
        name: 'same-name', description: '插件版', content: () => '插件正文',
    });
    const pluginSkills = await getPluginSkillList({workspace: 'D:/ws'});
    const merged = mergeSkills([
        ...pluginSkills.map((s) => ({...s, rootOrder: 0, localOrder: 0})),
        {name: 'same-name', rank: 100, rootOrder: 1, localOrder: 0, source: 'workspace', content: '工作区正文'},
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'workspace', '工作区技能不被插件覆盖');
    clearPluginSkills();
});

test('接线守卫：ai-panel.js 有 rank 300 / source label / 合并 / 缓存失效订阅', () => {
    assert.match(panelSrc, /plugin:\s*300/, 'AI_SKILL_RANKS 需要 plugin=300');
    assert.match(panelSrc, /source === 'plugin'.*?return '插件'/, 'skillSourceLabel 需识别 plugin');
    assert.match(panelSrc, /getPluginSkillList\(/, 'listSkillsRaw 需合并插件技能');
    assert.match(panelSrc, /cadt-plugins-loaded[\s\S]{0,300}invalidateSkillsCache/, '插件加载完成需失效技能缓存');
});

test('接线守卫：plugins.js 导出 registerSkill/readTextAsset 并在重载时清空技能', () => {
    assert.match(pluginsSrc, /registerSkill\(spec\)/, 'apiFor 需提供 registerSkill');
    assert.match(pluginsSrc, /readTextAsset\(path\)/, 'apiFor 需提供 readTextAsset');
    assert.match(pluginsSrc, /clearPluginSkills\(\)/, 'reloadPlugins 需清空插件技能');
});

test('接线守卫：main.js 注入 pluginSkills 给 AI 面板', () => {
    assert.match(mainSrc, /pluginSkills:\s*pluginHostWiring\.pluginSkillsMod/, 'initAIPanel 需注入 pluginSkills');
});

test('接线守卫：命令的所有执行入口都走 runPluginCommand（含快捷键）', () => {
    // 直接裸调 cmd.run( 只允许在 runner 内部（plugin-command-runner.js），main.js 里不允许
    const bareRuns = mainSrc.match(/pluginCmd\.run\(|cmd\.run\(/g) || [];
    assert.equal(bareRuns.length, 0, 'main.js 不应有裸 cmd.run 调用，都要走 runPluginCommand');
    assert.match(mainSrc, /runPluginCommand\(pluginCmd\)/, '快捷键入口也要走写回包装');
});

test('接线守卫：半插件失败时按 owner 撤销平台扩展', () => {
    assert.match(pluginsSrc, /revokePlatformOwner\(source\.id\)/, 'catch 分支需撤销平台扩展 owner');
});
