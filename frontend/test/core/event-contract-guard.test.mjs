// event-contract-guard.test.mjs：前后端**事件契约**的双向守卫。
//
// 已有的 event-bridge-guard 只管两件前端内部的事：EventsOn 只许出现在桥里、订阅的事件名必须已
// 在 event-scope.js 分类。它管不到最常坏的那一侧——**Go 发射的名字与前端订阅的名字对不对得上**：
//   · 前端订阅了、Go 从来不发射 → 那条 UI 永远不响应（而且不报错，最难查）；
//   · Go 发射了、前端没人订阅 → 白算一次序列化与广播（或名字拼错，真实消费者永远收不到）。
// 这里从两侧源码抽集合做双向差集：Go 侧认 `emit(` / `emitAppEvent(` / `emitWindowEventTo(` /
// `x.emit(` / `x.EmitEvent(` 等调用点（含 aitransport.Event* 常量解析），前端侧认事件桥的
// 字面量订阅 + main.js 里 ai-* 的动态注册列表 + 前端自己的 EventsEmit。
//
// 已知边界（写清楚免得后来者以为漏了）：
//   · Go 侧用**变量**传事件名的调用点抽不出来（如 `emitEvent(ev, payload)` 的包装层），
//     这类点被静默跳过——所以本守卫保证的是「抽出来的都成对」，不是「所有发射都成对」；
//   · 事件名约定 kebab-case（`ai-chunk` / `app-open-memo`），不符合这个形状的字面量不参与比对
//     （避免把 payload 里的 "running" 之类误当事件名）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..'); // 仓库根
const FRONTEND_SRC = join(HERE, '..', '..', 'src');

// 事件名的形状约定：小写 + 至少一个连字符（ai-chunk / app-open-memo / term-popout-closed）
const EVENT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

// 前端订阅了，但确实**没有**发射方——每条都必须写明原因，且一旦 Go 侧补上就会红（见第二个 test）。
// 新增条目要谨慎：这等于给它发了「永远不会触发」的免死金牌。
const ALLOWED_WITHOUT_EMITTER = new Map([
    ['browser-title', '预留：WebView2 的 DocumentTitleChanged 尚未接，标题当前由 browser-nav.title 承载（Go internal/browser/browser_windows.go）'],
    ['desktop-grant-changed', '预留：Go 侧还没有跨窗口广播这条状态（面板内的 grant/revoke 走本地状态），等 desktopmcp 加全窗广播时接上'],
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cadt', 'spike', 'build', 'frontend']);

function walk(dir, ext, out = []) {
    let names = [];
    try {
        names = readdirSync(dir);
    } catch (e) {
        return out;
    }
    for (const name of names) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch (e) {
            continue;
        }
        if (st.isDirectory()) walk(full, ext, out);
        else if (name.endsWith(ext)) out.push(full);
    }
    return out;
}

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkJs(full, out);
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

// aitransport 的事件常量表：EventChunk = "ai-chunk" 等（SSE 侧是这些名字的单一来源）。
function goEventConstants() {
    const file = join(ROOT, 'internal', 'aitransport', 'types.go');
    const text = readFileSync(file, 'utf8');
    const map = new Map();
    for (const m of text.matchAll(/^\s*(Event[A-Z]\w*)\s*=\s*"([^"]+)"/gm)) map.set(m[1], m[2]);
    return map;
}

// Go 侧发射集合：调用点所在行里取「第一个事件形状的 token」（字面量或 Event 常量）。
// 跨行的 payload 不在本行，所以按行取第一个 token 足够；emitWindowEventTo 的窗口参数是表达式、
// 不含带连字符的字面量，不会抢先命中。
function goEmittedEvents() {
    const constMap = goEventConstants();
    const out = new Map(); // name -> [relPath:line]
    const CALL_RE = /(?:^|[^A-Za-z0-9_])(?:emit|emitEvent|emitAppEvent|emitWindowEventTo)\s*\(|\.(?:emit|EmitEvent|Emit)\s*\(/;
    const TOKEN_RE = /"([^"]+)"|(?:aitransport\.)?(Event[A-Z]\w*)/g;
    for (const file of walk(ROOT, '.go')) {
        const rel = relative(ROOT, file).split(sep).join('/');
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/^\s*\/\//.test(line) || !CALL_RE.test(line)) return;
            TOKEN_RE.lastIndex = 0;
            let m;
            while ((m = TOKEN_RE.exec(line))) {
                let name = '';
                if (m[1] && EVENT_NAME_RE.test(m[1])) name = m[1];
                else if (m[2] && constMap.has(m[2])) name = constMap.get(m[2]);
                if (!name) continue;
                if (!out.has(name)) out.set(name, []);
                out.get(name).push(rel + ':' + (index + 1));
                break;
            }
        });
    }
    return out;
}

// main.js 里 ai-* 的动态注册列表（8 条流式事件走 for 循环注册，不是字面量调用点）。
function dynamicSubscribedNames() {
    const main = readFileSync(join(FRONTEND_SRC, 'main.js'), 'utf8');
    const m = main.match(/for \(const eventName of \[([^\]]+)\]\)/);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// 前端侧集合：情况分三张表——事件桥的订阅点、动态注册的 ai-*、前端自己的 EventsEmit。
function frontendEvents() {
    const subscribed = new Map();
    const selfEmitted = new Map();
    const SUB_RE = /(?:__appEvents\.[a-zA-Z]+|appEvents\.[a-zA-Z]+|bridge\.[a-zA-Z]+)\(\s*'([^']+)'/g;
    const EMIT_RE = /EventsEmit\(\s*'([^']+)'/g;
    for (const file of walkJs(FRONTEND_SRC)) {
        const rel = relative(FRONTEND_SRC, file).split(sep).join('/');
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/^\s*\/\//.test(line)) return;
            for (const [re, bag] of [[SUB_RE, subscribed], [EMIT_RE, selfEmitted]]) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(line))) {
                    const name = m[1];
                    if (!EVENT_NAME_RE.test(name)) continue;
                    if (!bag.has(name)) bag.set(name, []);
                    bag.get(name).push(rel + ':' + (index + 1));
                }
            }
        });
    }
    for (const name of dynamicSubscribedNames()) {
        if (!EVENT_NAME_RE.test(name)) continue;
        if (!subscribed.has(name)) subscribed.set(name, []);
        subscribed.get(name).push('main.js:ai-* 动态注册');
    }
    return {subscribed, selfEmitted};
}

// ---- 抽取器健全性：先证明自己看得见，否则下面两条会「两边都空 → 双双通过」假绿 ----
test('抽取器健全：两侧都能看见已知事件，且 ai-* 常量被解析成事件名', () => {
    const emitted = goEmittedEvents();
    const {subscribed, selfEmitted} = frontendEvents();
    // Go 侧：字面量发射与常量发射各取一个已知的
    assert.ok(emitted.has('app-open-memo'), 'Go 侧认不出 emitWindowEventTo 的字面量（抽取器坏了）');
    assert.ok(emitted.has('ai-chunk'), 'Go 侧认不出 aitransport.EventChunk 常量（抽取器坏了）');
    // 前端侧：字面量订阅与动态注册各取一个已知的
    assert.ok(subscribed.has('settings-changed'), '前端侧认不出事件桥订阅（抽取器坏了）');
    assert.ok(subscribed.has('ai-chunk'), '前端侧认不出 ai-* 动态注册列表（抽取器坏了）');
    // 前端自发射：settings-changed 是前端广播的（Go 不发射它）
    assert.ok(selfEmitted.has('settings-changed'), '前端侧认不出自己的 EventsEmit');
    assert.ok(emitted.size >= 20, 'Go 发射集合小得不像话（' + emitted.size + '），正则或跳过规则被改坏了');
});

// ---- 方向一：前端订阅的，必须有发射方（Go 或前端自己） ----
test('前端订阅的事件都有发射方（Go 发射 或 前端自 EventsEmit）', () => {
    const emitted = goEmittedEvents();
    const {subscribed, selfEmitted} = frontendEvents();
    const orphans = [];
    for (const [name, places] of subscribed) {
        if (emitted.has(name) || selfEmitted.has(name)) continue;
        if (ALLOWED_WITHOUT_EMITTER.has(name)) continue;
        orphans.push(name + ' @ ' + places.join(', '));
    }
    assert.deepEqual(orphans, [],
        '这些事件前端在订阅，但 Go 与前端都没有任何发射点（永远不会触发）：\n' + orphans.join('\n') +
        '\n若确属预留，请登记到 ALLOWED_WITHOUT_EMITTER 并写明原因。');
});

// ---- 方向二：Go 发射的，必须有人消费（前端字面订阅 / ai-* 动态列表） ----
test('Go 发射的事件都有前端消费者', () => {
    const emitted = goEmittedEvents();
    const {subscribed} = frontendEvents();
    const unheard = [];
    for (const [name, places] of emitted) {
        if (subscribed.has(name)) continue;
        unheard.push(name + ' @ ' + places.slice(0, 2).join(', ') + (places.length > 2 ? ' …' : ''));
    }
    assert.deepEqual(unheard, [],
        '这些事件 Go 在发射，但前端没有任何订阅点（白广播，或名字拼错了）：\n' + unheard.join('\n'));
});

// ---- 白名单不许烂：预留项一旦有了发射方，就要删掉白名单并留下真实断言 ----
test('ALLOWED_WITHOUT_EMITTER 里的条目必须仍然没有发射方', () => {
    const emitted = goEmittedEvents();
    const {selfEmitted} = frontendEvents();
    const stale = [];
    for (const name of ALLOWED_WITHOUT_EMITTER.keys()) {
        if (emitted.has(name) || selfEmitted.has(name)) stale.push(name);
    }
    assert.deepEqual(stale, [],
        '这些事件已经有发射方了，请从 ALLOWED_WITHOUT_EMITTER 删除（并按需补一条成对断言）：' + stale.join(', '));
});
