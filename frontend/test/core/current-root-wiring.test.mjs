// 窗口「当前根」接线守卫：多工作区模式下，注入给各域模块的 workspaceFolder 必须是
// 「当前根」（单工作区=窗口绑定，多工作区=聚焦会话的仓库），而不是裸窗口变量。
//
// 背景（2026-11-26）：多工作区窗口的 workspaceFolder 必须恒为空（它是 activeSessionByWorkspace
// 的 key / 会话快照槽 / scopeRootOf 兜底的判据），但绝大多数模块只想知道「我在哪」。
// 添加 currentRoot() 单一来源后，靠**注入层**统一（main.js 把 get workspaceFolder 改成
// return currentRoot()），而不是逐个模块打补丁——逐处补的后果是「改了这里忘了那里」：
// git / 便签 / 全局搜索 / 终端 / Maven / 草稿 全部静默失效，用户逐个撞见。
//
// 本测试锁两件事：
//   1. 注入层的 workspaceFolder 默认返回 currentRoot()（不是裸变量）；
//   2. 真值例外只有白名单里的两处，新增例外必须在这里登记并写明原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = join(here, '../../src/main.js');
const src = readFileSync(mainPath, 'utf8');

// 允许「注入裸 workspaceFolder」的模块：必须是**窗口绑定**语义，不能是「我在哪」。
// 新增条目要在这里写清原因，否则本测试红。
const RAW_INJECTION_ALLOWED = {
    createSessionRestore: '会话快照按窗口绑定分槽（多工作区用独立 harness 槽），必须真值',
    createExplorerOps: '重命名/移动后要写回窗口绑定根；「我在哪」另走 currentRootOf 注入',
};

test('注入层的 workspaceFolder 默认是 currentRoot()', () => {
    const viaCurrent = src.match(/get workspaceFolder\(\) \{ return currentRoot\(\); \}/g) || [];
    assert.ok(viaCurrent.length >= 10,
        '至少应有 10 处注入改为 currentRoot()，实际 ' + viaCurrent.length + ' 处');
});

test('裸 workspaceFolder 注入只允许白名单模块', () => {
    // 找到每个裸注入点，回溯最近的 `const X = createY(` 声明，核对 X 是否在白名单里。
    const lines = src.split('\n');
    const offenders = [];
    let currentFactory = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const decl = line.match(/^const \w+ = (create\w+)\(/);
        if (decl) currentFactory = decl[1];
        if (/get workspaceFolder\(\) \{ return workspaceFolder; \}/.test(line)) {
            if (!RAW_INJECTION_ALLOWED[currentFactory]) {
                offenders.push((i + 1) + '（' + (currentFactory || '?') + '）');
            }
        }
    }
    assert.deepEqual(offenders, [],
        '这些注入点返回裸 workspaceFolder，但不在真值白名单里——多工作区下「我在哪」类读取会拿到空值：'
        + offenders.join('、') + '。改用 currentRoot()，或把它登记进 RAW_INJECTION_ALLOWED 并写明原因。');
});

test('currentRoot 的单一来源存在且语义正确', () => {
    // currentRoot 已拆到 shell/view-root.js（main.js 超线治理）。
    // 这里检查实现处；下面另有「注入层指向 currentRoot()」的检查仍看 main.js。
    const vsrc = readFileSync(join(here, '../../src/shell/view-root.js'), 'utf8');
    assert.match(vsrc, /function currentRoot\(\) \{[\s\S]{0,400}?lastFocusedRoot/,
        'currentRoot() 必须同时考虑 lastFocusedRoot（多工作区的聚焦会话仓库）');
    assert.match(vsrc, /isMultiWorkspace\(\)/, 'currentRoot() 必须走 isMultiWorkspace()');
    // main.js 里应只剩「解构出来供全文件使用」的那一处，不能再有第二份实现
    assert.ok(!/^function currentRoot\(\)/m.test(src),
        'main.js 不该再有 currentRoot 的实现（已迁到 shell/view-root.js）');
});

test('switchRootLight 在多工作区下不写 workspaceFolder', () => {
    const start = src.indexOf('function switchRootLight(dir) {');
    assert.ok(start > 0, '找不到 switchRootLight');
    // 只看函数开头一段：harness 守卫必须在写入 workspaceFolder 之前
    const head = src.slice(start, start + 1200);
    assert.match(head, /isMultiWorkspace\(\)\)\s*return applyViewRoot/,
        'switchRootLight 必须在 harness 下改走 applyViewRoot（否则会写脏窗口绑定根）');
    const guardIdx = head.indexOf('applyViewRoot');
    const writeIdx = head.indexOf('workspaceFolder = dir');
    // writeIdx < 0 表示这段窗口内没出现写回（函数更靠下），同样说明守卫在前。
    assert.ok(writeIdx < 0 || guardIdx < writeIdx,
        'harness 守卫必须在 `workspaceFolder = dir` 之前');
});

// 入口侧守卫（2026-11-26 实测 bug）：
// 多工作区下从标题栏「打开…」选目录 → openFolderSmart 没分支 → openFolderWorkspace 把
// workspaceFolder 写成新目录；而它末尾的 refreshSessionList 触发 adoptWorkspaceSession，
// 又把文件树改回会话所属仓库。结果**顶部徽标显示新目录、树显示旧仓库**，两个值打架。
// 修法是入口统一守卫 + currentRoot 多工作区优先，这里锁这两点。
test('openFolderWorkspace 在多工作区下不写 workspaceFolder', () => {
    const start = src.indexOf('function openFolderWorkspace(dir) {');
    assert.ok(start > 0, '找不到 openFolderWorkspace');
    const head = src.slice(start, start + 1600);
    assert.match(head, /isMultiWorkspace\(\)\)\s*\{[\s\S]{0,400}?applyViewRoot/,
        'openFolderWorkspace 必须在 harness 下改走 applyViewRoot：'
        + '它被多个入口调用（标题栏「打开…」/ app_control 的 open_folder / decideSessionOpen 的 current 分支），'
        + '逐处补会漏（实测漏了两处）');
    const guardIdx = head.indexOf('isMultiWorkspace');
    const writeIdx = head.indexOf('workspaceFolder = dir;');
    assert.ok(guardIdx > 0 && (writeIdx < 0 || guardIdx < writeIdx),
        'harness 守卫必须在 `workspaceFolder = dir;` 之前，否则多工作区下仍会被写脏');
});

test('currentRoot 在多工作区下优先于 workspaceFolder（防脏值凌驾）', () => {
    const vsrc = readFileSync(join(here, '../../src/shell/view-root.js'), 'utf8');
    const start = vsrc.indexOf('function currentRoot() {');
    assert.ok(start > 0, '找不到 currentRoot');
    const head = vsrc.slice(start, start + 600);
    const harnessIdx = head.indexOf('isMultiWorkspace');
    // 拆分后窗口根经 deps.windowWorkspace() 取，不再直接读 main.js 里的 workspaceFolder
    const folderIdx = head.indexOf('deps.windowWorkspace()');
    assert.ok(harnessIdx > 0 && folderIdx > 0, 'currentRoot 必须同时判多工作区与窗口绑定根');
    assert.ok(harnessIdx < folderIdx,
        'currentRoot 必须先判多工作区：窗口绑定根万一被写脏，'
        + '不能让它凌驾于视图根之上（否则徽标与文件树取到两个不同目录）');
});

// 域模块直接吃裸 workspaceFolder 的另一种形态：把函数本身注入进去。
// 实测 bug（2026-11-26）：ai-git-ui 的 refreshGitEntry 用 windowWorkspacePath() 算按钮可用性，
// 而多工作区下它恒为空 → available 恒 false → 头部 Git 按钮（「快捷操作」）永久消失。
test('Git 快捷操作的根跟会话，不能注入裸 windowWorkspacePath', () => {
    // 注入口在 ai-panel.js（本文件的 src 只是 main.js）
    const aiPanelSrc = readFileSync(join(here, '../../src/ai/ai-panel.js'), 'utf8');
    const start = aiPanelSrc.indexOf('const gitUiMod = createAIGitUi({');
    assert.ok(start > 0, '找不到 createAIGitUi 的构造');
    const seg = aiPanelSrc.slice(start, start + 900);
    assert.ok(!/^\s{8}windowWorkspacePath,\s*$/m.test(seg),
        '不能把裸 windowWorkspacePath 注入 ai-git-ui：多工作区下它恒为空，'
        + 'Git 快捷操作按钮会永久隐藏（改用 sessionScopeRoot(currentSession())）');
    assert.match(seg, /scopeRoot:\s*\(\)\s*=>\s*sessionScopeRoot\(currentSession\(\)\)/,
        'Git 快捷操作的根必须与 AI 工具根同源（会话作用域根）；'
        + '参数名用 scopeRoot 而不是 windowWorkspacePath，防止后来者误传窗口根');
});

// 「跨工作区」判定在多工作区窗口里必须被短路。
// windowWorkspacePath 多工作区下恒为空，任何 `aiWorkspaceKey(session.workspace) !== aiWorkspaceKey(windowWorkspacePath())`
// 都会恒真 —— 后果是「所有绑定工作区的会话都被判成外区」：
//   · 计时器 / 生成任务到点永远报「请到对应窗口处理」，功能静默失效；
//   · 自动化弹层把除沙盒外的会话全折叠掉。
test('多工作区下必须短路「跨工作区」判定（计时器 / 生成任务 / 自动化弹层）', () => {
    const aiPanelSrc = readFileSync(join(here, '../../src/ai/ai-panel.js'), 'utf8');
    // 三处：计时器到点、生成任务结束、isSessionLocal
    const crossWs = aiPanelSrc.match(/session\.workspace\s*&&\s*aiWorkspaceKey\(session\.workspace\)\s*!==\s*aiWorkspaceKey\(windowWorkspacePath\(\)\)/g) || [];
    assert.ok(crossWs.length >= 2, '预期至少两处跨工作区比较（计时器 / 生成任务），实际 ' + crossWs.length);
    // 每一处都必须带 harness 短路：往前找最近的守卫
    const lines = aiPanelSrc.split('\n');
    let guarded = 0;
    lines.forEach((line, i) => {
        if (!/aiWorkspaceKey\(session\.workspace\)\s*!==\s*aiWorkspaceKey\(windowWorkspacePath\(\)\)/.test(line)) return;
        const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (/isMultiWorkspace\(\)/.test(near)) guarded++;
    });
    assert.equal(guarded, crossWs.length,
        '这些跨工作区比较缺少 !isMultiWorkspace() 短路——多工作区下会恒真，'
        + '把本地会话全判成外区（计时器/生成任务永远送达不了）');
    assert.match(aiPanelSrc, /isSessionLocal:[\s\S]{0,260}?isMultiWorkspace\(\)/,
        'isSessionLocal 必须对多工作区返回 true（否则自动化弹层会把会话全折叠）');
});

test('分组内新建会话用 viewRoot 判跨区，不用 windowWorkspacePath', () => {
    const aiPanelSrc = readFileSync(join(here, '../../src/ai/ai-panel.js'), 'utf8');
    const start = aiPanelSrc.indexOf('function newSessionInGroup(');
    assert.ok(start > 0, '找不到 newSessionInGroup');
    const head = aiPanelSrc.slice(start, start + 700);
    assert.ok(!/const now = windowWorkspacePath\(\);/.test(head),
        'newSessionInGroup 不能用 windowWorkspacePath 判「是否跨工作区」：多工作区下它恒空，'
        + '任何分组新建都会被判成跨区，从而不做立即激活（改用 viewRoot）');
    assert.match(head, /const now = viewRoot\(\);/,
        '应与 newSessionInWorkspace 同口径，用 viewRoot()');
});

// 「借来的根」标记（标题栏那个「当前会话没有工作区」提示）。
// 实测 bug：从无工作区会话切回**同根**的普通会话时，applyViewRoot 的同根短路提前 return，
// orphan 停在 true 没被重置 → 标题栏一直挂着提示（树 / git / 分组都正确，只有它错）。
test('applyViewRoot 同根短路必须重置 orphan', () => {
    const vsrc = readFileSync(join(here, '../../src/shell/view-root.js'), 'utf8');
    const start = vsrc.indexOf('function applyViewRoot(root, opts) {');
    assert.ok(start > 0, '找不到 applyViewRoot');
    const head = vsrc.slice(start, start + 1000);
    const shortCircuit = head.indexOf('deps.sessionPathKey(next) === deps.sessionPathKey(lastFocusedRoot)');
    assert.ok(shortCircuit > 0, '找不到同根短路判定');
    const resetIdx = head.indexOf('viewRootOrphan = false', shortCircuit);
    assert.ok(resetIdx > shortCircuit,
        '同根短路分支里必须把 viewRootOrphan 重置为 false：切回同根的普通会话时'
        + 'next 与 lastFocusedRoot 相同会提前返回，标记停在旧值 → 标题一直显示「会话无工作区」');
});

test('「借来的根」判定以面板当前会话为准，不只依赖状态位', () => {
    assert.ok(/function focusedSessionWorkspace\(\)/.test(src),
        '必须有 focusedSessionWorkspace()：直接问面板「当前会话有没有 workspace」');
    const start = src.indexOf('function renderWorkspaceCrumbs() {');
    const body = src.slice(start, start + 2400);
    assert.match(body, /focusedSessionWorkspace\(\)/,
        'renderWorkspaceCrumbs 要按当前会话的真实 workspace 判定，而不是只看 viewRootOrphan——'
        + '那个位要在每条 applyViewRoot 路径上维护，漏一处就长期挂错提示');
    // viewRootOrphan 现在从 view-root 模块的访问器读（状态位已私有化，只能经 getter 拿）
    assert.match(body, /focused === null \? viewRootMod\.viewRootOrphan : !focused/,
        '面板问不到时才回落到状态位（面板未初始化 / 旧宿主）');
});



