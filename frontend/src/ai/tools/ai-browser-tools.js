// ai-browser-tools.js：内嵌浏览器工具（AI）的纯函数层——注入脚本构造 + 入参归一。
// 只做字符串与参数处理，不碰 DOM、不调后端；执行与结果整形仍在 ai-panel 的 executeTool。
// 注入脚本一律走 BrowserEval（WebView2 ExecuteScript，CDP 通道已禁用），因此：
//   · 单次脚本不能 await（返回值是完成值，不是 Promise）；
//   · CSS :hover / :active 这类伪类不会因派发事件而改变，只能触发 JS 监听器。

export const WAIT_DEFAULT_MS = 5000;
export const WAIT_MIN_MS = 200;
export const WAIT_MAX_MS = 60000;
export const WAIT_POLL_MS = 200;

// 等待超时归一：非法 / 缺省用 5000，夹在 200–60000。
export function clampWaitTimeout(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_MS;
    return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Number.isFinite(n) ? n : WAIT_DEFAULT_MS));
}

// 等待条件的可读描述（错误信息与成功回执共用）；无任何条件返回空串。
export function describeWait(cond) {
    const {selector, text, url} = cond || {};
    const parts = [];
    if (selector) parts.push('元素 ' + selector + ' 出现');
    if (text) parts.push('页面出现文本「' + text + '」');
    if (url) parts.push('地址包含 ' + url);
    return parts.join('，且');
}

// 轮询用探针脚本：返回 JSON 字符串 {"ok":true|false}，条件之间是「与」关系。
export function buildWaitProbe(cond) {
    const {selector, text, url} = cond || {};
    const checks = [];
    if (selector) checks.push('!!document.querySelector(' + JSON.stringify(selector) + ')');
    if (text) {
        checks.push('((document.body ? document.body.innerText : "").indexOf(' + JSON.stringify(text) + ') >= 0)');
    }
    if (url) checks.push('(location.href.indexOf(' + JSON.stringify(url) + ') >= 0)');
    if (!checks.length) throw new Error('至少给出 selector / text / url 之一');
    return 'JSON.stringify({ok: (' + checks.join(' && ') + ')})';
}

// 滚动脚本：selector（滚到元素）/ byPx（按像素）/ position（top|bottom）三选一。
export function buildScrollScript(opts) {
    const {selector, byPx, position} = opts || {};
    const sel = String(selector || '').trim();
    const hasBy = byPx !== undefined && byPx !== null && String(byPx).trim() !== '' && Number.isFinite(Number(byPx)) && Number(byPx) !== 0;
    const pos = String(position || '').trim().toLowerCase();
    const hasPos = pos === 'top' || pos === 'bottom';
    const modes = [!!sel, hasBy, hasPos].filter(Boolean).length;
    if (modes !== 1) {
        throw new Error('selector / byPx / position 必须三选一（position 只接受 top / bottom）');
    }
    const tail = 'return JSON.stringify({ok: true, scrollY: Math.round(window.scrollY), scrollHeight: Math.round((document.documentElement && document.documentElement.scrollHeight) || 0)});';
    if (sel) {
        return '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
            ' if (!el) return JSON.stringify({ok: false, message: "未找到元素"});' +
            ' el.scrollIntoView({block: "center", inline: "nearest"}); ' + tail + ' })()';
    }
    if (hasBy) {
        return '(() => { window.scrollBy(0, ' + Math.round(Number(byPx)) + '); ' + tail + ' })()';
    }
    const expr = pos === 'top' ? '0' : '((document.documentElement && document.documentElement.scrollHeight) || 0)';
    return '(() => { window.scrollTo(0, ' + expr + '); ' + tail + ' })()';
}

// 悬停脚本：派发 mouseover / mouseenter / mousemove（不改变 CSS :hover 伪类）。
export function buildHoverScript(selector) {
    const sel = String(selector || '').trim();
    if (!sel) throw new Error('selector 为空');
    return '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
        ' if (!el) return JSON.stringify({ok: false, message: "未找到元素"});' +
        ' el.scrollIntoView({block: "center", inline: "nearest"});' +
        ' const r = el.getBoundingClientRect();' +
        ' const x = r.left + r.width / 2, y = r.top + r.height / 2;' +
        ' const base = {bubbles: true, cancelable: true, clientX: x, clientY: y, view: window};' +
        ' el.dispatchEvent(new MouseEvent("mouseover", base));' +
        ' el.dispatchEvent(new MouseEvent("mouseenter", {bubbles: false, cancelable: false, clientX: x, clientY: y, view: window}));' +
        ' el.dispatchEvent(new MouseEvent("mousemove", base));' +
        ' return JSON.stringify({ok: true, tag: el.tagName, text: String(el.innerText || "").trim().slice(0, 60)});' +
        ' })()';
}

// 原生下拉（select 元素）选中脚本：先按 value 精确匹配，再按可见文本（trim 相等 → 包含）匹配。
export function buildSelectScript(selector, opts) {
    const sel = String(selector || '').trim();
    const {value, label} = opts || {};
    const wantValue = value === undefined || value === null ? '' : String(value);
    const wantLabel = label === undefined || label === null ? '' : String(label);
    if (!sel) throw new Error('selector 为空');
    if (!wantValue && !wantLabel) throw new Error('value / label 至少给一个');
    return '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
        ' if (!el) return JSON.stringify({ok: false, message: "未找到元素"});' +
        ' if (String(el.tagName).toUpperCase() !== "SELECT") return JSON.stringify({ok: false, message: "该元素不是原生下拉框（自定义下拉请用 browser_click 展开再点子项）"});' +
        ' const opts = [...el.options];' +
        ' const wantValue = ' + JSON.stringify(wantValue) + ', wantLabel = ' + JSON.stringify(wantLabel) + ';' +
        ' let hit = wantValue ? opts.find((o) => o.value === wantValue) : null;' +
        ' if (!hit && wantLabel) { const l = (o) => String(o.textContent || "").trim();' +
        '   hit = opts.find((o) => l(o) === wantLabel) || opts.find((o) => l(o).indexOf(wantLabel) >= 0); }' +
        ' if (!hit) return JSON.stringify({ok: false, message: "没有匹配的选项", options: opts.slice(0, 20).map((o) => ({value: o.value, label: String(o.textContent || "").trim()}))});' +
        ' el.value = hit.value;' +
        ' el.dispatchEvent(new Event("input", {bubbles: true}));' +
        ' el.dispatchEvent(new Event("change", {bubbles: true}));' +
        ' return JSON.stringify({ok: true, value: el.value, label: String(hit.textContent || "").trim(), count: opts.length});' +
        ' })()';
}

// 按可见文本点击：找文本相等或包含目标的最小可见可点击元素。
export function buildTextClickScript(text) {
    const want = String(text || '').trim();
    if (!want) throw new Error('text 为空');
    return '(() => { const want = ' + JSON.stringify(want) + ';' +
        ' const all = [...document.querySelectorAll("a,button,[role=button],input[type=submit],input[type=button],summary,label,li,td,span,div")];' +
        ' const textOf = (el) => String(el.innerText || el.value || "").trim();' +
        ' const cands = all.filter((el) => { const t = textOf(el);' +
        '   if (!t || (t !== want && t.indexOf(want) < 0)) return false;' +
        '   const r = el.getBoundingClientRect();' +
        '   return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; });' +
        ' if (!cands.length) return JSON.stringify({ok: false, message: "未找到包含该文本的可见可点击元素"});' +
        ' cands.sort((a, b) => textOf(a).length - textOf(b).length || a.children.length - b.children.length);' +
        ' const el = cands[0];' +
        ' el.scrollIntoView({block: "center", inline: "nearest"});' +
        ' el.click();' +
        ' return JSON.stringify({ok: true, tag: el.tagName, text: textOf(el).slice(0, 60)});' +
        ' })()';
}

// 修饰符别名 → KeyboardEvent 的布尔字段。未识别的别名忽略（不报错，避免为了少一个词就失败）。
export const KEY_MODIFIER_PROPS = Object.freeze({
    ctrl: 'ctrlKey', control: 'ctrlKey',
    shift: 'shiftKey',
    alt: 'altKey', option: 'altKey',
    meta: 'metaKey', cmd: 'metaKey', command: 'metaKey', win: 'metaKey',
});

export function keyEventInit(key, modifiers) {
    const init = {key: String(key || '').trim() || 'Enter', bubbles: true, cancelable: true};
    for (const raw of Array.isArray(modifiers) ? modifiers : []) {
        const prop = KEY_MODIFIER_PROPS[String(raw || '').trim().toLowerCase()];
        if (prop) init[prop] = true;
    }
    return init;
}

// 组合键的可读文案（回执用），如 Ctrl+Shift+K。
export function describeKeyCombo(key, modifiers) {
    const names = [];
    for (const raw of Array.isArray(modifiers) ? modifiers : []) {
        const prop = KEY_MODIFIER_PROPS[String(raw || '').trim().toLowerCase()];
        const label = {ctrlKey: 'Ctrl', shiftKey: 'Shift', altKey: 'Alt', metaKey: 'Meta'}[prop];
        if (label && !names.includes(label)) names.push(label);
    }
    return names.concat([String(key || '').trim() || 'Enter']).join('+');
}

// 派发按键：带上修饰符，在 document.activeElement 上 fired（事件冒泡到 document）。
export function buildPressKeyScript(key, modifiers) {
    const init = JSON.stringify(keyEventInit(key, modifiers));
    return '(() => { const el = document.activeElement || document.body; const init = ' + init + ';' +
        ' el.dispatchEvent(new KeyboardEvent("keydown", init));' +
        ' el.dispatchEvent(new KeyboardEvent("keyup", init));' +
        ' return JSON.stringify({ok: true, key: init.key}); })()';
}

// app_control 的浏览器标签动作与 browser_* 工具共享会话标签页身份。
//
// 背景（2026-11-22 高频 bug）：AI 可能用 app_control open_browser_tab 打开网页，
// 而不是 browser_navigate。若这里不把标签页 id 登记到会话，随后 browser_screenshot /
// browser_snapshot / browser_navigate 走 ensureBrowserTab 时看不到 id，就会另开一个
// about:blank「新标签页」并截到白图——正是「打开网页后标签栏多出空标签、截图为空」的根因。
//
// 返回应写入 session.browserTabId 的新值；值与当前相同则调用方无需落盘。
//   · open_browser_tab 成功返回 {browserTab:{id,...}} → 登记该 id；
//   · close_browser_tab 关掉当前标签页（params.id === current）→ 清空；
//   · 其它动作 / 异常返回 → 保持原值。
export function resolveSessionBrowserTabId(action, params, result, currentId) {
    const current = typeof currentId === 'string' ? currentId : '';
    if (action === 'open_browser_tab') {
        const id = result && result.browserTab && result.browserTab.id;
        return typeof id === 'string' && id ? id : current;
    }
    if (action === 'close_browser_tab') {
        const closedId = params && params.id;
        return typeof closedId === 'string' && closedId && closedId === current ? '' : current;
    }
    return current;
}
