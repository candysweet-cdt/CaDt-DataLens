// browser-tab-restore.js：个人浏览器标签页的关闭保存与启动恢复（P0）。
//
// 方案：docs/finished-plans/browser-tab-restore.md。三类浏览器标签里只有个人浏览器
// （browserPersist: true，固定 profile 'user'，登录态落盘保留）值得恢复；AI 会话浏览器
// 与普通临时标签的 profile 目录随随机 tabId 走，恢复出来是未登录空白页（P1 另评估）。
//
// 存储：localStorage 'cadt.browser-tabs.v1'，全局单份、不按工作区分桶（个人浏览器是
// 全局单实例）：{ urls: [...], savedAt: ts }，只存地址、过滤空白与 about:blank、
// 上限 20 条。登录态在固定 profile 的磁盘里，恢复地址即可续上。
//
// 关键不变量：**只有实例在本窗口确认打开成功（onOpened 通知过）才写这个 key**（heldPersonal）。
// 打开失败回滚的关闭通知对未确认 doc 是 no-op——绝不能把（可能是别的窗口写下的）存档抹掉。
// 关闭个人浏览器标签 = 用户不想看它了：从恢复列表移除（登录态仍在，重开不用重新登录）。
//
// 多窗口并发恢复用轻量 owner 租约（'cadt.browser-tabs.owner'，{id, ts}）串行化：
// 15s 过期 + 5s 心跳，退出 / 关标签时释放（仅当 owner 是自己）。租约之外的保险：
// 恢复前先问 Go 侧 BrowserState——个人浏览器实例 id 全进程唯一，已在别的窗口活着
// 就跳过（WebView2 不允许两个 environment 共用同一 user data 目录，第二个必失败）。

import {parseJson} from '../core/json-safe.js';
import {kvGet, kvGetJson, kvRemove, kvSet, kvSetJson} from '../core/kv-store.js';
import {BROWSER_TABS_KEY, BROWSER_TABS_OWNER_KEY} from '../core/storage-keys.js';

// ---- 纯函数与常量（导出供单测）----
// 键名定义在 core/storage-keys.js（这里转出，保持既有 import 面不变）。
export {BROWSER_TABS_KEY, BROWSER_TABS_OWNER_KEY};
export const BROWSER_TABS_LIMIT = 20;
export const BROWSER_TABS_LEASE_TTL = 15000;
export const BROWSER_TABS_HEARTBEAT_MS = 5000;
export const BROWSER_TABS_SAVE_DEBOUNCE_MS = 500;
// 与 bridge-ui.js 的 PERSONAL_BROWSER_ID 同值：固定实例 id ⇒ Go 侧 user data 目录固定。
export const PERSONAL_BROWSER_ID = 'browser-user';

/** 地址列表归一化：只收字符串、trim、过滤空白与 about:blank、去重（保序）、截断到上限。 */
export function normalizeBrowserUrls(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const url = item.trim();
        if (!url || url === 'about:blank') continue;
        if (out.indexOf(url) !== -1) continue;
        out.push(url);
        if (out.length >= BROWSER_TABS_LIMIT) break;
    }
    return out;
}

/** 快照序列化：{urls, savedAt}。 */
export function serializeBrowserTabs(urls) {
    return JSON.stringify({urls: normalizeBrowserUrls(urls), savedAt: Date.now()});
}

/** 快照反序列化：坏数据一律当空列表（恢复路径宁可不开标签也不能崩）。 */
export function parseBrowserUrls(text) {
    const data = parseJson(text, null);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return normalizeBrowserUrls(data.urls);
    }
    return [];
}

/** owner 租约是否存活：id 非空且 ts 在 TTL 内（同机时钟；时钟回拨导致的未来 ts 视为过期）。 */
export function leaseAlive(owner, now) {
    if (!owner || typeof owner !== 'object') return false;
    const id = String(owner.id || '');
    const ts = Number(owner.ts) || 0;
    if (!id || !ts) return false;
    const age = now - ts;
    return age >= 0 && age < BROWSER_TABS_LEASE_TTL;
}

// ---- 控制器 ----
// factory + deps 延迟求值（调用方传 getter），与 session-restore.js 同款约定：
// 不依赖 main.js 的声明顺序，不把 let 状态拍成快照。
export function createBrowserTabRestore(deps) {

const windowId = 'w-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffffff).toString(36);
// 本窗口是否确认打开成功过个人浏览器实例：一切写盘路径的前提（见文件头不变量）。
// 置位点只有两处：onOpened 确认打开成功、已开着再导航（实例此前已在）。
// 关闭路径只读不置位——「打开失败回滚」的 close 通知落到这里就是 no-op。
let heldPersonal = false;
let lastUrls = [];
let lastNavUrl = '';
let saveTimer = 0;
let heartbeatTimer = 0;

function log(level, message) {
    if (typeof deps.logFrontend === 'function') deps.logFrontend(level, message);
}

// AI 悬浮窗 / 调试控制台与主窗口共享同一 localStorage（同 session-restore 的口径）。
function auxWindowNoSession() {
    return !!(window.__aiFloatWindow || window.__consoleWindowMode);
}

function readSavedUrls() {
    return parseBrowserUrls(kvGet(BROWSER_TABS_KEY));
}

// 写盘路径的总闸：没持有过实例的窗口、悬浮窗 / 控制台，一律什么都不做。
function writeUrls(urls, opts) {
    const immediate = !!(opts && opts.immediate);
    if (!heldPersonal || auxWindowNoSession()) return;
    lastUrls = normalizeBrowserUrls(urls);
    const write = () => {
        saveTimer = 0;
        if (!kvSet(BROWSER_TABS_KEY, serializeBrowserTabs(lastUrls))) {
            log('warn', '浏览器标签快照写入失败：localStorage 不可用或配额已满');
        }
    };
    clearTimeout(saveTimer);
    if (immediate) write();
    else saveTimer = setTimeout(write, BROWSER_TABS_SAVE_DEBOUNCE_MS);
}

// ---- owner 租约 ----
function readOwner() {
    const owner = kvGetJson(BROWSER_TABS_OWNER_KEY, null);
    return owner && typeof owner === 'object' ? owner : null;
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        try {
            const owner = readOwner();
            if (!owner || owner.id !== windowId) {
                stopHeartbeat(); // 租约被别人接管（或已释放）：停止续期
                return;
            }
            owner.ts = Date.now();
            kvSetJson(BROWSER_TABS_OWNER_KEY, owner);
        } catch (e) {
            stopHeartbeat();
        }
    }, BROWSER_TABS_HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = 0;
    }
}

// CAS 获取：owner 不存在或已过期才写入自己；成功即开始心跳。localStorage 不可用时放弃。
function acquireLease() {
    if (leaseAlive(readOwner(), Date.now())) return false;
    if (!kvSetJson(BROWSER_TABS_OWNER_KEY, {id: windowId, ts: Date.now()})) return false;
    startHeartbeat();
    return true;
}

function releaseLease() {
    stopHeartbeat();
    const owner = readOwner();
    if (owner && owner.id === windowId) kvRemove(BROWSER_TABS_OWNER_KEY);
}

// ---- 保存时机（openBrowserTab / browser-nav / closeDocNow 三个通知点调用）----

// 个人浏览器实例确认打开成功（bridge-ui onOpened）、或已开着再导航到新地址时调用。
// 必须在实例真正可用之后才通知：打开失败回滚不能置写权（写权 = 真持有过实例）。
// about:blank 不记：新开空白页不代表用户要看某个网页，别覆盖掉已有恢复数据。
function notePersonalOpened(url) {
    const target = String(url || '').trim();
    if (!target || target === 'about:blank') return;
    heldPersonal = true;
    lastNavUrl = target;
    writeUrls([target]);
}

// 个人浏览器地址变化（main.js browser-nav，仅 browserPersist 文档）。
// 以写权已置位为前提：实例打开完成前 Go 侧没有注册事件归属，竞态导航会走广播兜底
// 到达本窗口——此时不落盘，避免随后打开失败回滚时把存档抹掉（同一根因见文件头）。
function notePersonalNav(url) {
    if (!heldPersonal) return;
    const target = String(url || '').trim();
    if (!target || target === lastNavUrl) return;
    lastNavUrl = target;
    // 导回 about:blank 视为没有要恢复的地址（归一化本来也会滤掉它）
    writeUrls(target === 'about:blank' ? [] : [target]);
}

// 个人浏览器标签关闭：从恢复列表移除（立即写，防抖窗口内退出也不丢），并释放恢复租约。
// 只读写权不置位：从未打开成功的 doc（打开失败回滚）走到这里是 no-op，存档原样保留。
function notePersonalClosed() {
    lastNavUrl = '';
    writeUrls([], {immediate: true});
    releaseLease();
}

// ---- 恢复时机（bridge-ui 启动编排末尾调用：文件标签先恢复，再恢复网页）----
// 返回恢复出的地址数（0 = 没恢复：无存档 / aux 窗 / 实例已在别的窗口活着 / 租约被占）。
async function restoreOnStartup() {
    if (auxWindowNoSession()) return 0;
    const urls = readSavedUrls();
    if (!urls.length) return 0;
    // Go 侧实例已在（别的窗口开着）：跳过。个人浏览器实例 id 全进程唯一，
    // BrowserState 能查到就说明 user data 目录已被占用，恢复必失败。
    const backend = deps.backend;
    if (backend && typeof backend.BrowserState === 'function') {
        try {
            await backend.BrowserState(PERSONAL_BROWSER_ID);
            return 0;
        } catch (e) { /* 不存在 → 正常继续 */ }
    }
    if (!acquireLease()) return 0;
    const open = deps.openBrowserTab;
    if (typeof open !== 'function') {
        releaseLease();
        return 0;
    }
    let restored = 0;
    for (const url of urls) {
        try {
            open(url, 'user', {personal: true});
            restored += 1;
        } catch (e) {
            log('warn', '个人浏览器标签恢复失败：' + ((e && (e.stack || e.message)) || e));
            break;
        }
    }
    if (restored) log('info', '个人浏览器恢复：' + restored + ' 个地址');
    return restored;
}

// 退出兜底：冲刷防抖中的快照（尽力而为）+ 释放租约。悬浮窗 / 控制台、没持有过
// 实例的窗口不写（共享 localStorage，不能覆盖持有窗口的数据）。
window.addEventListener('pagehide', () => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
    }
    if (!auxWindowNoSession() && heldPersonal) {
        // localStorage 不可用时放弃：防抖路径大概率已写过
        kvSet(BROWSER_TABS_KEY, serializeBrowserTabs(lastUrls));
    }
    releaseLease();
});

    return {notePersonalNav, notePersonalOpened, notePersonalClosed, restoreOnStartup, releaseLease};
}
