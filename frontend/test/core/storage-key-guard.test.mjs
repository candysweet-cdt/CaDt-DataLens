// storage-key-guard.test.mjs：持久化键名只能有一处登记处（src/core/storage-keys.js）。
//
// 背景：同一件事四种命名风格并存（datalens-xxx / cadt.xxx.v1 / cadt-xxx / 无前缀 camelCase），
// 而「按名单枚举键」的地方（设置页清缓存、仓库外数据清理、导出、重置、多窗口认领标记）各写
// 各的字面量——加一个键就要在 N 个地方补一次，漏一次的表现是「清理不干净」或「状态看起来
// 没保存」。这里用源码扫描把口子焊住：非登记处的键名字面量直接红。
//
// 扫描口径：
//   - 只看 src/**/*.js 的字符串字面量，**跳过整行注释**（头注释里写键名是说明，不是定义）；
//   - 命中前缀 `cadt.<…>` / `cadt-<…>` / `datalens-<…>`；
//   - 合法来源：registry 导出的键值、动态键构造器的前缀、NON_STORAGE 白名单（逐条带原因）。
// 白名单不是许愿池：条目必须仍出现在某处（成了死条目就红），新增条目必须在这里写原因——
// 这是「只减不增」的落法：新写一个键时让测试变绿的正确做法是登记进 registry，不是加白名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

import * as registry from '../../src/core/storage-keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');
const REGISTRY_FILE = join(SRC, 'core', 'storage-keys.js');

// 键名形态：两种历史风格都在用；新键写 `cadt.<域>.<名称>.v<版本>`。
const KEY_PREFIX_RE = /^(cadt[.-]|datalens-)/;
// 字符串字面量：单引号 / 双引号（不处理模板串——模板串里的键前缀也会被构造器收录）
const LITERAL_RE = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;
// 整行注释：`// …`、`/* …`、` * …`（块注释中间的星号行）
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/;

// 与键名同前缀、但**不是**持久化键的字面量。每条都写明为什么不是键——
// 认不出来的就别往这里塞，先确认它到底是不是一个键。
const NON_STORAGE = new Map([
    ['cadt-ui', '内置技能名（ai-constants.js 的 BUILTIN_SKILLS / 工具文案）'],
    ['cadt-gen-models', '内置技能名，同时也是 ai-gen-model.js 的 GEN_CONFIG_KIND（配置块类型，不进 localStorage）'],
    ['cadt-plugins-loaded', 'window 自定义事件名（插件表加载完成的广播），不是键'],
    ['cadt-datalens-plugins', '官方插件组织名（Gitee/GitHub 的 org），不是键'],
    ['cadt-selftest-ok', '自检程序的 stdout 标记（terminal/run.js 的 SELF_TEST_MARK），不是键'],
    ['cadt-cmpl-icon', 'CSS 类名（补全列表图标列），不是键'],
    ['cadt-find-match', 'CSS 类名（查找高亮），不是键'],
    ['cadt-ai-config.json', '导出对话框的默认文件名，不是键'],
    ['cadt-ai-accounts.json', '导出对话框的默认文件名，不是键'],
    ['cadt-gen-models.json', '导出对话框的默认文件名，不是键'],
    ['cadt-memo://', '便签定位点的 URL scheme（--memo 参数 / AI 粘贴用），不是键'],
    ['datalens-', 'newId 的 id 前缀（ai-config-model.js），不是键'],
]);

// 整目录排除：dev/ 是浏览器调试用的 mock 后端——里面是「演示插件脚本的源码字符串」
// （cadt.registerFormat / cadt.addCommand 之类）与假数据集，不是生产代码路径，也不碰真存储。
// 它自己的 mock 存储键也已经从 registry 取（MOCK_DB_CONNECTIONS_KEY / MOCK_SAVE_KEY）。
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dev']);

function listJsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...listJsFiles(full));
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

// 扫出的所有「同前缀字面量」：value -> 出现位置（相对 src，1 基行号）
function scanLiterals() {
    const hits = new Map();
    for (const file of listJsFiles(SRC)) {
        if (file === REGISTRY_FILE) continue;
        const rel = relative(SRC, file).split('\\').join('/');
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (COMMENT_LINE_RE.test(line)) return;
            LITERAL_RE.lastIndex = 0;
            let m;
            while ((m = LITERAL_RE.exec(line))) {
                const value = m[1] != null ? m[1] : m[2];
                if (!value || !KEY_PREFIX_RE.test(value)) continue;
                if (!hits.has(value)) hits.set(value, []);
                hits.get(value).push(rel + ':' + (index + 1));
            }
        });
    }
    return hits;
}

function registryValues() {
    const values = new Set();
    for (const value of Object.values(registry)) {
        if (typeof value === 'string') values.add(value);
    }
    for (const prefix of registry.DYNAMIC_KEY_PREFIXES || []) values.add(prefix);
    return values;
}

test('键名字面量只出现在 core/storage-keys.js（或非键白名单里）', () => {
    const registered = registryValues();
    const hits = scanLiterals();
    const bad = [];
    for (const [value, places] of hits) {
        if (NON_STORAGE.has(value)) continue;
        const hint = registered.has(value) ? '（已登记，但此处应 import 而不是重抄字面量）' : '（未登记）';
        bad.push(value + hint + ' @ ' + places.join(', '));
    }
    assert.deepEqual(bad, [], '键名字面量必须从 core/storage-keys.js 取：\n' + bad.join('\n'));
});

test('非键白名单不留死条目（删掉的字面量要一起清理）', () => {
    const hits = scanLiterals();
    const stale = [...NON_STORAGE.keys()].filter((value) => !hits.has(value));
    assert.deepEqual(stale, [], '白名单里有已经不存在于源码的条目，请删除：' + stale.join(', '));
});

test('动态键构造器：拼接结果与登记的前缀一致，脏值不产生 undefined', () => {
    assert.equal(registry.draftLSKey('s-1'), 'datalens-ai-draft:s-1');
    assert.equal(registry.wsDraftLSKey('d:/work/a'), 'datalens-ai-draft-ws:d:/work/a');
    // 归一化后为空的工作区也要拼出稳定的键（历史上出现过 undefined 拼进键名，读回来对不上）
    assert.equal(registry.wsDraftLSKey(''), 'datalens-ai-draft-ws:');
    assert.equal(registry.draftLSKey(null), 'datalens-ai-draft:');
    assert.equal(registry.schedFireKey('sch-1', 3), 'datalens-sched-fire-sch-1-3');
    assert.equal(registry.schedFireKey('sch-1'), 'datalens-sched-fire-sch-1-0');
    assert.equal(registry.schedFireKey(null, null), 'datalens-sched-fire--0');
    // 窗口快照槽：harness（多工作区）窗口与普通窗口必须分开，否则空工作区布局会污染下次启动
    assert.equal(registry.windowSessionKeyOf(false), registry.WINDOW_SESSION_KEY);
    assert.equal(registry.windowSessionKeyOf(true), registry.WINDOW_SESSION_HARNESS_KEY);
    assert.notEqual(registry.WINDOW_SESSION_KEY, registry.WINDOW_SESSION_HARNESS_KEY);
    for (const key of [registry.draftLSKey('x'), registry.wsDraftLSKey('x'), registry.schedFireKey('x', 1)]) {
        assert.match(key, KEY_PREFIX_RE, '构造出的键必须带登记前缀：' + key);
        assert.equal(key.includes('undefined'), false, '键名里不许出现 undefined：' + key);
    }
});

test('键名互不重复（同一个键被两个模块当成两件事是最难查的串台）', () => {
    const seen = new Map();
    const dup = [];
    for (const [name, value] of Object.entries(registry)) {
        if (typeof value !== 'string') continue;
        const prev = seen.get(value);
        if (prev) dup.push(prev + ' / ' + name + ' = ' + value);
        else seen.set(value, name);
    }
    assert.deepEqual(dup, [], '同一个键名被登记了两次：' + dup.join(', '));
});
