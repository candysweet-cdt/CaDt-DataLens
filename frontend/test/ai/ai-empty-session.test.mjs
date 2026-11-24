// 空会话「切走即删」与草稿按工作区接续的结构护栏。
//
// 场景：新建会话后没发消息就切去别的会话，它不该留在列表里占位——带着创建时间参与
// 排序会把刚用过的活跃会话一路挤下去。但用户可能已经在输入框里写了字、粘了图片，
// 这部分草稿不能跟着会话消失，要按工作区暂存，下次在该工作区新建会话时回填。
//
// 不变量写在 switchSession / newSession / 草稿存取里（依赖 DOM 与后端，无法直接单测），
// 按项目惯例用源码断言钉住：
//   E1 只有「正在看的会话被切走」才删（activeSessionId 尚未改）
//   E2 支线 / 运行中 / 压缩中的会话不静默删
//   E3 切会话与新建会话都要先存草稿再删
//   E4 槽键是归一化工作区路径，stash/take 对称
//   E5 只给空会话回填，已有历史的会话不被塞草稿
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const panel = readFileSync(join(SRC, 'ai', 'ai-panel.js'), 'utf8');

test('空会话切走即删：只处理正在看的那个会话，且不碰支线/运行中/压缩中', () => {
    assert.match(panel, /function discardVirginOnLeave\(session\) \{/);
    // 身份守卫 + virgin 判定：不在内存表里的对象（磁盘重读已替换）一律不碰
    assert.match(panel, /if \(!session \|\| !sessions\.includes\(session\)\) return false;/);
    assert.match(panel, /if \(!isVirginSession\(session\)\) return false;/);
    // E1：activeSessionId 还没改，对不上就不是「离开」（工作区分桶后经 activeSessionId() 取本工作区条目）
    assert.match(panel, /if \(session\.id !== activeSessionId\(\)\) return false;/);
    // E2：支线有独立标签页承载；有流 / 正在压缩的不能删
    assert.match(panel, /if \(aiTextOf\(session\.sideOf\)\) return false;/);
    assert.match(panel, /if \(streams\.has\(session\.id\) \|\| compactOf\(session\.id\)\) return false;/);
});

test('空会话切走即删：switchSession 与 newSession 都先存草稿再删', () => {
    // E3（切会话）：previous 块里 save 必须在 discard 之前。sameSession（同 id 重复切换）
    // 保持输入区现场、不走 save/discard——那是 2026-11-22 排队消息回流修复的一部分
    //（见 ai-draft-hygiene.test.mjs），真实跨会话切换仍是「先存草稿再删空会话」。
    const switchBlock = panel.match(/const previous = currentSession\(\);[\s\S]*?const sameSession = !!\(previous && previous\.id === id\);\s*if \(previous && !sameSession\) \{[\s\S]*?\n        \}/);
    assert.ok(switchBlock, 'switchSession 里应有 previous 处理块（含 sameSession 守卫）');
    assert.match(switchBlock[0], /saveComposerDraft\(previous\.id\);/);
    assert.match(switchBlock[0], /discardVirginOnLeave\(previous\);/);
    assert.ok(
        switchBlock[0].indexOf('saveComposerDraft(previous.id)') < switchBlock[0].indexOf('discardVirginOnLeave(previous)'),
        '必须先保存草稿再删会话，否则输入框内容没进草稿槽',
    );

    // E3（新建）：新建分支也是「离开当前会话」，同样先存后删
    const newBlock = panel.match(/saveComposerDraft\(current && current\.id\);\s*\/\/[\s\S]*?discardVirginOnLeave\(current\);\s*const session = createSessionData\(\);/);
    assert.ok(newBlock, 'newSession 新建分支应先存草稿、删空会话，再建新会话');
});

test('空会话切走即删：磁盘删目录，legacy 重写全量快照', () => {
    const discard = panel.match(/function discardVirginOnLeave\(session\) \{[\s\S]*?\n    \}/);
    assert.ok(discard);
    assert.match(discard[0], /sessionStore\.removeSession\(session\.id\)\.catch\(notifySessionStoreError\)/);
    assert.match(discard[0], /persistSessions\(\);/);
});

test('草稿按工作区暂存：槽键统一为归一化工作区路径', () => {
    assert.match(panel, /const workspaceDrafts = new Map\(\);/);
    assert.match(panel, /const AI_WS_DRAFT_KEY_PREFIX = 'datalens-ai-draft-ws:'/);
    assert.match(panel, /function wsDraftLSKey\(wsKey\) \{/);

    const stash = panel.match(/function stashWorkspaceDraft\(session\) \{[\s\S]*?\n    \}/);
    assert.ok(stash, '缺少 stashWorkspaceDraft');
    assert.match(stash[0], /const key = aiWorkspaceKey\(sessionWorkspacePath\(session\)\);/);
    assert.match(stash[0], /workspaceDrafts\.set\(key, \{text, attachments\}\);/);

    const take = panel.match(/function takeWorkspaceDraft\(session\) \{[\s\S]*?\n    \}/);
    assert.ok(take, '缺少 takeWorkspaceDraft');
    assert.match(take[0], /const key = aiWorkspaceKey\(sessionWorkspacePath\(session\)\);/);
    // 取用即清空：同一份草稿不能一辈子反复塞给每个新会话
    assert.match(take[0], /workspaceDrafts\.delete\(key\);/);
});

test('草稿只回填给空会话，两个切换入口都要带上会话对象', () => {
    const load = panel.match(/function loadComposerDraft\(sessionId, session\) \{[\s\S]*?\n    \}/);
    assert.ok(load, 'loadComposerDraft 应接受会话对象');
    // E5：切到有历史的会话时不能把工作区草稿塞进它的输入框
    assert.match(load[0], /if \(!draft && session && isVirginSession\(session\)\) \{/);
    assert.match(load[0], /draft = takeWorkspaceDraft\(session\);/);

    assert.match(panel, /loadComposerDraft\(id, target\);/);
    assert.match(panel, /loadComposerDraft\(session\.id, session\);/);
});

test('图片附件随草稿走：stash 复制附件，回填时恢复', () => {
    assert.match(panel, /const attachments = Array\.isArray\(draft\.attachments\) \? draft\.attachments\.slice\(\) : \[\];/);
    assert.match(panel, /setAttachments\(draft \? draft\.attachments\.slice\(\) : \[\]\);/);
});

test('复用当前空会话时也接回工作区草稿，但不覆盖正在写的输入', () => {
    const reuse = panel.match(/const typing = [\s\S]*?if \(!typing && isVirginSession\(current\)\) loadComposerDraft\(current\.id, current\);/);
    assert.ok(reuse, '复用分支应先判断输入框是否已有内容，再把工作区草稿接回来');
});
