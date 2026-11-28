import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeReadRoot,
    normalizeReadRoots,
    readRootCovers,
    readRootCoversAny,
    addReadRoot,
    userNamedPath,
    sensitiveReadDenyReason,
    scanRootDenyReason,
    hardReadDenyReason,
    hardWriteDenyReason,
    ARTIFACT_DIR_NAME,
    BACKING_DIR_NAME,
} from '../../../src/ai/security/ai-read-roots.js';

// ---------- normalizeReadRoot / normalizeReadRoots ----------

test('normalizeReadRoot 归一反斜杠与尾分隔符', () => {
    assert.equal(normalizeReadRoot('D:\\Novel\\日记星辰\\'), 'D:/Novel/日记星辰');
    assert.equal(normalizeReadRoot('  D:/Novel//  '), 'D:/Novel');
    assert.equal(normalizeReadRoot(''), '');
    assert.equal(normalizeReadRoot(null), '');
});

test('normalizeReadRoots 去重（大小写不敏感）、去空、上限 200', () => {
    assert.deepEqual(
        normalizeReadRoots(['D:/Novel', 'd:\\novel\\', 'E:/Books', '', null, 'D:/Novel/']),
        ['D:/Novel', 'E:/Books'],
    );
    const many = Array.from({length: 250}, (_, i) => 'D:/r' + i);
    assert.equal(normalizeReadRoots(many).length, 200);
});

// ---------- readRootCovers / readRootCoversAny ----------

test('readRootCovers：相等与子树覆盖，大小写与分隔符不敏感', () => {
    assert.equal(readRootCovers('D:/Novel', 'D:/Novel'), true);
    assert.equal(readRootCovers('D:/Novel', 'D:/Novel/日记星辰/正文/番外0007.md'), true);
    assert.equal(readRootCovers('d:\\novel\\', 'D:/Novel/a.md'), true);
    assert.equal(readRootCovers('D:/Novel', 'D:/Novels/a.md'), false);
    assert.equal(readRootCovers('D:/Novel', 'E:/Novel/a.md'), false);
    assert.equal(readRootCovers('', 'D:/a.md'), false);
    assert.equal(readRootCovers('D:', 'D:/a.md'), true);
});

test('readRootCoversAny 任一命中即真', () => {
    assert.equal(readRootCoversAny(['D:/A', 'D:/B'], 'D:/B/x.md'), true);
    assert.equal(readRootCoversAny(['D:/A'], 'D:/B/x.md'), false);
    assert.equal(readRootCoversAny(null, 'D:/B/x.md'), false);
});

// ---------- addReadRoot ----------

test('addReadRoot：已覆盖不重复加，新根替换被包含旧根', () => {
    assert.deepEqual(addReadRoot(['D:/Novel'], 'D:/Novel/日记星辰'), ['D:/Novel']);
    assert.deepEqual(addReadRoot(['D:/Novel/日记星辰'], 'D:/Novel'), ['D:/Novel']);
    assert.deepEqual(addReadRoot(['D:/A'], 'D:/B'), ['D:/A', 'D:/B']);
    assert.deepEqual(addReadRoot([], ''), []);
    // 不改入参
    const input = ['D:/A'];
    addReadRoot(input, 'D:/B');
    assert.deepEqual(input, ['D:/A']);
});

// ---------- userNamedPath ----------

const msg = (content, extra) => ({role: 'user', content, ...extra});

test('真用户消息点名文件 → 目标文件与点名的目录子树放行', () => {
    const session = {messages: [
        msg('请总结 D:\\OraSkyC\\Novel\\日记星辰\\正文\\番外0007-最轻松的时光.md'),
        {role: 'assistant', content: '好的'},
    ]};
    assert.equal(userNamedPath(session, 'D:/OraSkyC/Novel/日记星辰/正文/番外0007-最轻松的时光.md'), true);
    // 大小写与分隔符差异不影响判定
    assert.equal(userNamedPath(session, 'd:/oraskyc/novel/日记星辰/正文/番外0007-最轻松的时光.md'), true);
});

test('点名目录 → 该目录下任意文件放行，目录外不放行', () => {
    const session = {messages: [msg('读一下 D:/Novel 目录下的所有 md')]};
    assert.equal(userNamedPath(session, 'D:/Novel/日记星辰/正文/a.md'), true);
    assert.equal(userNamedPath(session, 'D:/Novels/a.md'), false);
    assert.equal(userNamedPath(session, 'E:/Novel/a.md'), false);
});

test('app 卡片 / notice / 模型派单 task 不算点名', () => {
    const session = {messages: [
        msg('读取 D:/secret/key.md', {app: {kind: 'subagent'}}),
        msg('读取 D:/secret/key.md', {notice: true}),
        msg('读取 D:/secret/key.md', {from: 'agent'}),
        {role: 'assistant', content: 'D:/secret/key.md'},
    ]};
    assert.equal(userNamedPath(session, 'D:/secret/key.md'), false);
});

test('无消息或无路径字面量 → false', () => {
    assert.equal(userNamedPath(null, 'D:/a.md'), false);
    assert.equal(userNamedPath({messages: []}, 'D:/a.md'), false);
    assert.equal(userNamedPath({messages: [msg('没有路径的一句话')]}, 'D:/a.md'), false);
    assert.equal(userNamedPath({messages: [msg('总结 D:/Novel')]}, ''), false);
});

// ---------- sensitiveReadDenyReason ----------

test('应用数据目录下的路径硬拒，目录外与空 appDir 放过', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CaDt-DataLens';
    const reason = sensitiveReadDenyReason('C:\\Users\\admin\\AppData\\Roaming\\CaDt-DataLens\\ai-config.json', appDir);
    assert.ok(reason && reason.includes('应用数据目录'));
    assert.equal(sensitiveReadDenyReason('C:/Users/admin/AppData/Roaming/CaDt-DataLensX/a.md', appDir), null);
    assert.equal(sensitiveReadDenyReason('D:/Novel/a.md', appDir), null);
    assert.equal(sensitiveReadDenyReason('D:/Novel/a.md', ''), null);
});

// 产物子树是唯一例外：模型自己落盘的工具结果要能自己读回来（指针才有意义）。
// 同时钉住「例外只到 ai-artifacts 一层」——会话正文与密钥仍在拒绝范围。
test('ai-artifacts 子树可读，密钥与会话目录仍拒', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CaDt-DataLens';
    const artifact = appDir + '/' + ARTIFACT_DIR_NAME + '/session-1/call-1.txt';
    assert.equal(sensitiveReadDenyReason(artifact, appDir), null);
    assert.equal(sensitiveReadDenyReason(appDir + '/' + ARTIFACT_DIR_NAME, appDir), null);
    // 兄弟前缀不能误放行（ai-artifactsX 不是产物目录）
    assert.ok(sensitiveReadDenyReason(appDir + '/' + ARTIFACT_DIR_NAME + 'X/a.txt', appDir));
    // 密钥、会话正文、其他应用数据照旧拒绝
    assert.ok(sensitiveReadDenyReason(appDir + '/ai-config.json', appDir));
    assert.ok(sensitiveReadDenyReason(appDir + '/ai-sessions/x/session.v1.jsonl', appDir));
    // 扫描产物目录本身不触发「包含应用数据目录」的拒绝
    assert.equal(scanRootDenyReason(appDir + '/' + ARTIFACT_DIR_NAME, appDir), null);
});

// 会话沙盒是第二个例外：未绑定工作区的会话（harness 下的会话沙盒）以它为作用域根，
// 被自己这条硬拒规则挡死的话，AI 连自己沙盒里的文件都读写不了（真机实测踩到）。
test('ai-workspaces 会话沙盒可读，密钥与会话目录仍拒', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CaDt-DataLens';
    const sandbox = appDir + '/' + BACKING_DIR_NAME + '/session-abc';
    assert.equal(sensitiveReadDenyReason(sandbox + '/test.md', appDir), null);
    assert.equal(sensitiveReadDenyReason(sandbox, appDir), null);
    // 兄弟前缀不能误放行
    assert.ok(sensitiveReadDenyReason(appDir + '/' + BACKING_DIR_NAME + 'X/a.txt', appDir));
    // 例外只到 ai-workspaces：密钥 / 会话正文 / 产物之外的其它子树照旧拒绝
    assert.ok(sensitiveReadDenyReason(appDir + '/ai-config.json', appDir));
    assert.ok(sensitiveReadDenyReason(appDir + '/ai-sessions/x/session.v1.jsonl', appDir));
    assert.ok(sensitiveReadDenyReason(appDir + '/ai-usage.db', appDir));
    // 扫描沙盒根本身不触发「包含应用数据目录」的拒绝
    assert.equal(scanRootDenyReason(sandbox, appDir), null);
});

// ---------- hardWriteDenyReason ----------

// 写侧对称闸（2026-11-28 写工作区外放行时补）：判定与例外同读侧，文案换成写入。
// full 档同样适用由调用方（resolveWritePath 先于档位判定）保证，纯函数层只管路径。
test('hardWriteDenyReason：应用数据目录拒写入，产物 / 沙盒子树例外', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CaDt-DataLens';
    const reason = hardWriteDenyReason(appDir + '/ai-config.json', appDir);
    assert.ok(reason && reason.includes('拒绝写入'));
    // 工作区外普通路径与空 appDir 放过（走正常审批卡）
    assert.equal(hardWriteDenyReason('D:/notes/todo.md', appDir), null);
    assert.equal(hardWriteDenyReason('D:/Novel/a.md', ''), null);
    // 例外子树：产物（AI 自己落盘的工具结果）与会话沙盒（未绑定工作区会话的作用域根）
    assert.equal(hardWriteDenyReason(appDir + '/' + ARTIFACT_DIR_NAME + '/call-1.txt', appDir), null);
    assert.equal(hardWriteDenyReason(appDir + '/' + BACKING_DIR_NAME + '/session-abc/x.md', appDir), null);
    // 兄弟前缀不能误放行；密钥 / 会话正文照旧拒绝
    assert.ok(hardWriteDenyReason(appDir + '/' + ARTIFACT_DIR_NAME + 'X/a.txt', appDir));
    assert.ok(hardWriteDenyReason(appDir + '/ai-sessions/x/session.v1.jsonl', appDir));
});

// ---------- scanRootDenyReason ----------

test('扫描起点严格包含应用数据目录时拒绝，等于 / 位于其内交给单文件硬拒', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CaDt-DataLens';
    const reason = scanRootDenyReason('C:\\Users\\admin', appDir);
    assert.ok(reason && reason.includes('应用数据目录'));
    assert.ok(scanRootDenyReason('C:/', appDir), '盘符根包含应用数据目录也要拒绝');
    // 起点就是应用数据目录 / 在其内部 → 不归这里管（sensitiveReadDenyReason 已有更准确的文案）
    assert.equal(scanRootDenyReason(appDir, appDir), null);
    assert.equal(scanRootDenyReason(appDir + '/ai-memory', appDir), null);
    // 无关目录、兄弟前缀、空参数放过
    assert.equal(scanRootDenyReason('D:/Novel', appDir), null);
    assert.equal(scanRootDenyReason('C:/Users/admin/AppData/Roaming/CaDt-DataLensX', appDir), null);
    assert.equal(scanRootDenyReason('D:/Novel', ''), null);
    assert.equal(scanRootDenyReason('', appDir), null);
});

// ---------- hardReadDenyReason ----------

test('hardReadDenyReason：应用数据目录硬拒优先，扫描起点包含它时也拒绝', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CandySweet/CaDt-DataLens';
    // 路径在应用数据目录内：读文件与扫描都拒绝，且用「读取」文案
    for (const opts of [undefined, {scanRoot: true}]) {
        const reason = hardReadDenyReason('C:\\Users\\admin\\AppData\\Roaming\\CandySweet\\CaDt-DataLens\\ai-config.json', appDir, opts);
        assert.ok(reason && reason.includes('拒绝读取'), '应用数据目录内优先按单文件硬拒');
    }
    // 扫描起点包含应用数据目录：只有 scanRoot 才拒绝
    assert.ok(hardReadDenyReason('C:/Users/admin/AppData/Roaming/CandySweet', appDir, {scanRoot: true}).includes('拒绝搜索'));
    assert.equal(hardReadDenyReason('C:/Users/admin/AppData/Roaming/CandySweet', appDir), null);
    // 无关路径 / 空 appDir 放过
    assert.equal(hardReadDenyReason('D:/Novel/a.md', appDir, {scanRoot: true}), null);
    assert.equal(hardReadDenyReason('D:/Novel', '', {scanRoot: true}), null);
});
