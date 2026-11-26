// backend-constants-parity.test.mjs：前后端**同一件事的阈值**必须逐项相等。
//
// 为什么要有它：这些数值在两侧各写一份、谁也不知道对方改了没有。改错的表现不是报错，而是
// 「前端允许、后端强杀」或「后端放行、前端先拦」——用户看到的是随机失败。范式照
// test/ai/tools/ai-image-policy.test.mjs：从 Go 源码里把常量抠出来，与前端导出的常量比对；
// 任何一侧单独改动都让这条红。
//
// 刻意**不**合并的「同形不同义」（数值相同也各留各的）：
//   - `settings/activity-pane.js` 的 ACTIVITY_PAGE_SIZES 上限 500：那是**操作记录**分页的
//     limit，不是 DB 结果行数；
//   - `ai-wipeguard.js` 的 WIPEGUARD_FINGERPRINT_INTERVAL_MS（10 分钟）：指纹周期校准，
//     与快照节拍数值相同但语义不同；
//   - `plugin-ai-providers.js` 的 AI_PROVIDER_MAX_MODELS（50）：单个插件的模型条数上限，
//     与 Go 侧 aiMaxModels（500，全局模型条目上限）不是一件事。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {AI_SHELL_TIMEOUT_DEFAULT_MS, AI_SHELL_TIMEOUT_MAX_MS, AI_SESSION_READ_LIMIT, AI_WRITE_LIMIT, AI_PATCH_LIMIT,
    AI_IMAGE_MAX_BASE64, AI_VIDEO_LIMIT, AI_VIDEO_MAX_INPUT_BYTES, AI_VIDEO_MAX_BASE64} from '../../src/ai/core/ai-constants.js';
import {MCP_TIMEOUT_MAX_MS} from '../../src/ai/tools/ai-mcp-settings.js';
import {AI_PROVIDER_MAX_HEADERS, AI_PROVIDER_MAX_BODY_KEYS, AI_PROVIDER_MAX_BODY_BYTES} from '../../src/shell/plugin-ai-providers.js';
import {WORKTREE_PATCH_LIMIT} from '../../src/ai/tools/ai-worktree.js';
import {SEARCH_DEFAULT_LIMIT, SEARCH_HARD_LIMIT} from '../../src/ai/tools/ai-search-advanced.js';
import {WIPEGUARD_SNAPSHOT_INTERVAL_MS} from '../../src/ai/security/ai-wipeguard.js';
import {DB_ROW_DEFAULT, DB_ROW_MAX} from '../../src/db/db-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // 仓库根
const KIB = 1024;
const MIB = 1024 * 1024;

// ---- Go 常量抠取 ----
// 只支持这些常量实际使用的写法（十进制、`a << b`、`a * b`、`a * time.Minute`）：
// 故意不写通用表达式求值——遇到新写法时让它红，逼人来看一眼，而不是猜。
function evalGoNumber(expr) {
    const raw = String(expr || '').trim();
    const timeUnit = /^(\d+)\s*\*\s*time\.(Second|Minute|Hour)$/.exec(raw);
    if (timeUnit) {
        const scale = {Second: 1000, Minute: 60 * 1000, Hour: 60 * 60 * 1000}[timeUnit[2]];
        return Number(timeUnit[1]) * scale;
    }
    const shift = /^(\d+)\s*<<\s*(\d+)$/.exec(raw);
    if (shift) return Number(shift[1]) * Math.pow(2, Number(shift[2]));
    const product = /^(\d+(?:\s*\*\s*\d+)+)$/.exec(raw);
    if (product) return raw.split('*').reduce((acc, part) => acc * Number(part.trim()), 1);
    if (/^\d+$/.test(raw)) return Number(raw);
    throw new Error('无法求值的 Go 常量表达式：' + raw + '（backend-constants-parity 需要扩展 evalGoNumber）');
}

// 在 Go 源文件里找 `name = <expr>`（含单行 `const name = …` 写法；跳过纯注释行，去掉行尾注释）。
function goConst(relPath, name) {
    const file = join(ROOT, relPath);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const re = new RegExp('^\\s*(?:const\\s+)?' + name + '\\s*=\\s*(.+?)\\s*$');
    for (const line of lines) {
        if (/^\s*\/\//.test(line)) continue;
        const withoutComment = line.replace(/\s\/\/.*$/, '');
        const m = re.exec(withoutComment);
        if (m) return evalGoNumber(m[1]);
    }
    throw new Error('在 ' + relPath + ' 里找不到常量 ' + name + '（改名或搬家了？请同步本测试）');
}

// ---- 逐组比对 ----
// 每组一个 test：失败时直接指出是哪一对阈值漂了。

test('run_command 超时：默认 / 上限 ↔ cmdbridge 的 aiShellDefaultTimeout / aiShellMaxTimeout', () => {
    assert.equal(AI_SHELL_TIMEOUT_DEFAULT_MS, goConst('internal/cmdbridge/ai_command_windows.go', 'aiShellDefaultTimeout'));
    assert.equal(AI_SHELL_TIMEOUT_MAX_MS, goConst('internal/cmdbridge/ai_command_windows.go', 'aiShellMaxTimeout'));
    assert.ok(AI_SHELL_TIMEOUT_DEFAULT_MS < AI_SHELL_TIMEOUT_MAX_MS, '默认必须小于上限');
});

test('MCP 服务器超时上限 ↔ internal/mcp 的 mcpTimeoutMaxMs', () => {
    assert.equal(MCP_TIMEOUT_MAX_MS, goConst('internal/mcp/mcp_config.go', 'mcpTimeoutMaxMs'));
});

test('插件 provider 请求补丁上限 ↔ aitransport 的 aiMaxExtraHeaders / BodyKeys / BodyBytes', () => {
    assert.equal(AI_PROVIDER_MAX_HEADERS, goConst('internal/aitransport/types.go', 'aiMaxExtraHeaders'));
    assert.equal(AI_PROVIDER_MAX_BODY_KEYS, goConst('internal/aitransport/types.go', 'aiMaxExtraBodyKeys'));
    assert.equal(AI_PROVIDER_MAX_BODY_BYTES, goConst('internal/aitransport/types.go', 'aiMaxExtraBodyBytes'));
});

test('会话正文读取上限 ↔ sessionstore 的 aiSessionReadLimit', () => {
    assert.equal(AI_SESSION_READ_LIMIT, goConst('internal/sessionstore/sessionstore.go', 'aiSessionReadLimit'));
    assert.equal(AI_SESSION_READ_LIMIT, 256 * MIB, '超限会话走「拒载 + 整理」流程，改这个值要同时看 ai-session-disk 的整理逻辑');
});

test('AI 单次写入 / 补丁上限 ↔ patch 的 patchAIMaxBytes', () => {
    const goLimit = goConst('internal/patch/patch_types.go', 'patchAIMaxBytes');
    assert.equal(AI_WRITE_LIMIT, goLimit);
    assert.equal(AI_PATCH_LIMIT, goLimit);
    assert.equal(WORKTREE_PATCH_LIMIT, goLimit);
    assert.equal(AI_WRITE_LIMIT, 256 * KIB);
});

test('DB 结果行数默认 / 上限 ↔ dbclient 的 rowDefault / rowMax 与 sqlview 的同名口径', () => {
    assert.equal(DB_ROW_DEFAULT, goConst('internal/dbclient/dbclient.go', 'rowDefault'));
    assert.equal(DB_ROW_MAX, goConst('internal/dbclient/dbclient.go', 'rowMax'));
    // sqlview 是 SQL 导入 / 预览那一侧，同一套行数口径
    assert.equal(DB_ROW_DEFAULT, goConst('internal/sqlview/sqlview.go', 'sqlQueryRowDefault'));
    assert.equal(DB_ROW_MAX, goConst('internal/sqlview/sqlview.go', 'sqlQueryRowMax'));
});

test('wipeguard 定期快照节拍 ↔ internal/wipeguard 的 snapshotInterval', () => {
    assert.equal(WIPEGUARD_SNAPSHOT_INTERVAL_MS, goConst('internal/wipeguard/snapshots.go', 'snapshotInterval'));
    assert.equal(WIPEGUARD_SNAPSHOT_INTERVAL_MS, 10 * 60 * 1000);
});

test('视频附件：每条条数 / 源文件 / base64 上限 ↔ aitransport + fileio', () => {
    assert.equal(AI_VIDEO_LIMIT, goConst('internal/aitransport/types.go', 'aiMaxVideosPerMessage'));
    assert.equal(AI_VIDEO_MAX_BASE64, goConst('internal/aitransport/types.go', 'aiMaxVideoBase64'));
    // 源文件上限在 fileio.ReadVideoAsDataURL（AI 附件与 read_video 工具同一条链）
    assert.equal(AI_VIDEO_MAX_INPUT_BYTES, goConst('internal/fileio/fileio.go', 'videoPreviewLimit'));
    // base64 一定比源文件大（4/3 膨胀），两者相等意味着有一侧改了体积口径
    assert.ok(AI_VIDEO_MAX_BASE64 > AI_VIDEO_MAX_INPUT_BYTES, 'base64 上限必须大于源文件上限');
    assert.equal(AI_VIDEO_LIMIT, 1);
});

test('search 分页：默认每页 / 硬顶 ↔ internal/search 的 searchDefaultLimit / searchHardMaxResults', () => {
    assert.equal(SEARCH_DEFAULT_LIMIT, goConst('internal/search/search.go', 'searchDefaultLimit'));
    assert.equal(SEARCH_HARD_LIMIT, goConst('internal/search/search.go', 'searchHardMaxResults'));
});

// 截图回传的 base64 上限是 Go 侧**保守**值（留余量），只需要不超过前端单图上限；
// 两者相等反而说明余量被吃干了（前端再降一点就会触发「截好的图发不出去」）。
test('截图 base64 上限必须落在前端单图上限之内且留出余量', () => {
    const shotMaxBase64 = goConst('internal/screenshot/screenshot_windows.go', 'shotMaxBase64');
    assert.ok(shotMaxBase64 > 0);
    assert.ok(shotMaxBase64 < AI_IMAGE_MAX_BASE64,
        '截图 base64 上限（' + shotMaxBase64 + '）必须小于前端 AI_IMAGE_MAX_BASE64（' + AI_IMAGE_MAX_BASE64 + '）');
    assert.ok(shotMaxBase64 >= AI_IMAGE_MAX_BASE64 * 0.5,
        '余量不该夸张到「明明能传 4 MiB 却只截 1 MiB」，' + shotMaxBase64 + ' vs ' + AI_IMAGE_MAX_BASE64);
});
