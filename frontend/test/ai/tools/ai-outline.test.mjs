// test/ai/tools/ai-outline.test.mjs：【维护文件大纲】快捷操作的菜单接线与提示词契约。
// 入口是 Git 快捷操作「其他操作」菜单的一项（OTHER_ACTIONS），提示词是纯函数（ai-outline.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {buildOutlineMaintainPrompt} from '../../../src/ai/tools/ai-outline.js';
import {OTHER_ACTIONS, buildGitActionPrompt} from '../../../src/ai/tools/ai-git.js';
import {ICONS} from '../../../src/core/icons.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

test('buildOutlineMaintainPrompt：含智能批量诊断标准与写入流程', () => {
    const text = buildOutlineMaintainPrompt('D:/repo');
    assert.match(text, /维护文件大纲/);
    assert.match(text, /D:\/repo/);
    assert.match(text, /code_outline/);
    assert.match(text, /sectionsOnly/);
    assert.match(text, /action:maintain/);
    assert.match(text, /5~10 个语义分区/);
    assert.match(text, />500 行或 >20KB/);
    assert.match(text, /小文件.*跳过/);
    assert.match(text, /diff 预览与审批/);
    assert.match(text, /node_modules/);
});

test('buildOutlineMaintainPrompt：空 root 回退占位，不产生空工作区行', () => {
    const text = buildOutlineMaintainPrompt('');
    assert.match(text, /工作区：（当前工作区）/);
});

test('维护文件大纲在「其他操作」菜单里，图标已注册', () => {
    const item = OTHER_ACTIONS.find((a) => a.id === 'outline-maintain');
    assert.ok(item, 'OTHER_ACTIONS 必须有 outline-maintain');
    assert.equal(item.label, '维护文件大纲');
    assert.ok(ICONS[item.icon], '菜单图标未注册：' + item.icon);
    assert.notEqual(item.isGit, true, '维护大纲不是 git 动作，不应打 git 写命令豁免令牌');
    assert.equal(item.requiresCognition, undefined, '维护大纲不依赖认知索引开关');
});

test('buildGitActionPrompt 分派 outline-maintain 到大纲提示词', () => {
    const viaMenu = buildGitActionPrompt('outline-maintain', {root: 'D:/repo'});
    assert.equal(viaMenu, buildOutlineMaintainPrompt('D:/repo'));
});

test('git-ui：非 git 动作不强制仓库检查，非 Git 工作区也可用维护大纲', () => {
    const src = read('frontend/src/ai/tools/ai-git-ui.js');
    assert.match(src, /if \(meta\.isGit && !gitEntryState\.available\)/, '仓库检查须只对 isGit 动作生效');
});

test('code_outline maintain 分支有独立写闸（计划模式/只读档/子代理/路径越界）', () => {
    const src = read('frontend/src/ai/ai-panel.js');
    const caseStart = src.indexOf("case 'code_outline':");
    const caseEnd = src.indexOf("case 'read_image':", caseStart);
    const block = src.slice(caseStart, caseEnd);
    assert.match(block, /session\.planMode === true/, '计划模式闸');
    assert.match(block, /AI_WRITE_SCOPES\.includes\(currentScopeOf\(ctx\.session\)\)/, '只读档闸');
    assert.match(block, /parentSessionId.*normalizeWorktreeState/, '无隔离区子代理闸');
    // 2026-11-28 写工作区外放行：maintain 与 edit_file / write_file 同源走 resolveWritePath
    // （捕获越界标记继续走审批管线，auto 档绝不自动应用），不再直接 aiResolveScopePath 硬拒。
    assert.match(block, /resolveWritePath\(input\.path, ctx\.session\)/, '写路径须走 resolveWritePath（越界弹审批卡）');
    assert.match(block, /outOfWorkspace = resolved\.outOfWorkspace/, '越界标记必须随 info 传入审批判定');
});
