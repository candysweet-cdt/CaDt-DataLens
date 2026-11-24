// @ts-check
// keymap.js：快捷键风格的运行时（事件归一化 + 按当前风格查表分发）。
//
// 组合键归一化成 'Ctrl+Shift+P' 这样的串：字母 / 数字走 e.code（物理键位），
// 中文输入法下 e.key 会变成组字字符（'中'）而 e.code 仍是 'KeyZ' —— 取 e.code 更稳，
// 也顺带解决输入法态下「按了字母却被当成中文」的老问题。
//
// 风格（settings.keyStyle）只换一张索引：行为立即跟着变，且与设置页文案同源
// （两者都来自 core/keybindings.js 同一张表），不会出现「表里写一套、实际按另一套」。
//
// 一个动作可以登记多个组合（keys[style] 是数组）：数组每一项都能独立触发它，
// 见 is(combo, id) —— 命中任一项即为真。
//
// 非组合键的特殊触发（双击 Shift）不进索引，用 hasSpecial(id, token) 判断：
// 当前风格不含该特殊触发时，双击 Shift 不生效。

import {
    KEY_BINDINGS, KEY_STYLES, DEFAULT_KEY_STYLE, DOUBLE_SHIFT,
    keyListFor, isValidKeyStyleId,
} from './keybindings.js';

// 物理键位 → 组合串里的主键名（只列有专门写法的；其余走 e.key）
/** @type {Record<string, string>} */
const CODE_TOKENS = {
    Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'",
};

// 事件 → 组合串（'Ctrl+Shift+P' / 'F5' / 'Alt+1' / 'Ctrl+`'）。
/**
 * 把键盘事件归一化成组合串（'Ctrl+Shift+P' / 'F5' / 'Alt+1'）。
 * 字母与数字优先取 e.code（物理键位），中文输入法态下也能稳定命中。
 * @param {KeyboardEvent} e 键盘事件
 * @returns {string} 组合串；无法识别时返回空串
 */
export function comboFromEvent(e) {
    if (!e) return '';
    const code = e.code || '';
    let key = '';
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (code === 'NumpadAdd') key = '+';
    else if (code === 'NumpadSubtract') key = '-';
    else if (code === 'NumpadMultiply') key = '*';
    else if (code === 'NumpadDivide') key = '/';
    else if (Object.prototype.hasOwnProperty.call(CODE_TOKENS, code)) key = CODE_TOKENS[code];
    else if (typeof e.key === 'string' && e.key) key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!key) return '';
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
}

// 修饰键写法（大小写不敏感；兼容常见别名与符号）
/** @type {Record<string, string>} */
const MODIFIER_TOKENS = {
    ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl',
    alt: 'alt', option: 'alt', '⌥': 'alt',
    shift: 'shift', '⇧': 'shift',
    meta: 'meta', win: 'meta', cmd: 'meta', command: 'meta', '⌘': 'meta',
};

/** @type {Record<string, {key: string, code: string}>} */
const NAMED_KEYS = {
    enter: {key: 'Enter', code: 'Enter'}, return: {key: 'Enter', code: 'Enter'},
    esc: {key: 'Escape', code: 'Escape'}, escape: {key: 'Escape', code: 'Escape'},
    tab: {key: 'Tab', code: 'Tab'},
    space: {key: ' ', code: 'Space'}, spacebar: {key: ' ', code: 'Space'},
    backspace: {key: 'Backspace', code: 'Backspace'},
    delete: {key: 'Delete', code: 'Delete'}, del: {key: 'Delete', code: 'Delete'},
    insert: {key: 'Insert', code: 'Insert'}, ins: {key: 'Insert', code: 'Insert'},
    home: {key: 'Home', code: 'Home'}, end: {key: 'End', code: 'End'},
    pageup: {key: 'PageUp', code: 'PageUp'}, pagedown: {key: 'PageDown', code: 'PageDown'},
    up: {key: 'ArrowUp', code: 'ArrowUp'}, arrowup: {key: 'ArrowUp', code: 'ArrowUp'},
    down: {key: 'ArrowDown', code: 'ArrowDown'}, arrowdown: {key: 'ArrowDown', code: 'ArrowDown'},
    left: {key: 'ArrowLeft', code: 'ArrowLeft'}, arrowleft: {key: 'ArrowLeft', code: 'ArrowLeft'},
    right: {key: 'ArrowRight', code: 'ArrowRight'}, arrowright: {key: 'ArrowRight', code: 'ArrowRight'},
};

/** @type {Record<string, string>} */
const TOKEN_TO_CODE = Object.fromEntries(Object.entries(CODE_TOKENS).map(([code, token]) => [token, code]));

/**
 * 组合串 → 合成按键规格（comboFromEvent 的逆运算，press_key 动作用）。
 * 支持 'Ctrl+Shift+P' / 'Alt+7' / 'Ctrl+`' / 'Shift+F4' / 'Ctrl++'（主键是加号）。
 * key 是 KeyboardEvent.key（字母按 Shift 大写、空格为 ' '），code 是物理键位——
 * 应用自己的快捷键按 e.code 匹配，所以 code 必须准确。
 * @param {string} text 组合串
 * @returns {{ok: boolean, error?: string, key?: string, code?: string,
 *            modifiers?: {ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}, combo?: string}}
 */
export function comboSpecFromText(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return {ok: false, error: '按键为空'};
    const fail = (/** @type {string} */ error) => ({ok: false, error});
    let tokens = raw.split('+').map((part) => part.trim());
    let main = '';
    if (tokens.length >= 3 && tokens[tokens.length - 1] === '' && tokens[tokens.length - 2] === '') {
        // 'Ctrl++' 拆成 ['Ctrl', '', '']：末尾两个空串表示主键是 '+'
        tokens = tokens.slice(0, -2);
        main = '+';
    } else {
        main = tokens.pop() || '';
        if (!main) return fail('组合键格式不对：' + raw + '（多余的 +）');
    }
    const modifiers = /** @type {{ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}} */ ({ctrl: false, alt: false, shift: false, meta: false});
    for (const token of tokens) {
        const modifier = MODIFIER_TOKENS[token.toLowerCase()];
        if (!modifier) {
            return fail('不认识的修饰键「' + token + '」（可用 Ctrl / Alt / Shift / Meta）');
        }
        modifiers[/** @type {'ctrl'|'alt'|'shift'|'meta'} */ (modifier)] = true;
    }
    const lower = main.toLowerCase();
    if (MODIFIER_TOKENS[lower]) {
        return fail('组合键缺少主键：' + raw + '（修饰键后面要写主键，如 Ctrl+P）');
    }
    let spec = null;
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
        const name = 'F' + lower.slice(1);
        spec = {key: name, code: name};
    } else if (NAMED_KEYS[lower]) {
        spec = {...NAMED_KEYS[lower]};
    } else if (/^[a-z]$/.test(lower)) {
        spec = {key: modifiers.shift ? lower.toUpperCase() : lower, code: 'Key' + lower.toUpperCase()};
    } else if (/^[0-9]$/.test(main)) {
        spec = {key: main, code: 'Digit' + main};
    } else if (TOKEN_TO_CODE[main]) {
        spec = {key: main, code: TOKEN_TO_CODE[main]};
    } else if (main === '+') {
        spec = {key: '+', code: 'Equal'};
    } else if ([...main].length === 1) {
        // 未登记的单字符：只给 key，组合串归一化会回退到 e.key
        spec = {key: main, code: ''};
    } else {
        return fail('不认识的按键「' + main + '」（可用字母 / 数字 / F1–F24 / Enter / Escape / Tab / ' +
            'Space / Backspace / Delete / 方向键 / PageUp / PageDown / Home / End / 常用符号）');
    }
    const parts = [];
    if (modifiers.ctrl) parts.push('Ctrl');
    if (modifiers.alt) parts.push('Alt');
    if (modifiers.shift) parts.push('Shift');
    if (modifiers.meta) parts.push('Meta');
    const displayMain = lower === 'space' || lower === 'spacebar'
        ? 'Space'
        : (NAMED_KEYS[lower] ? spec.key : (spec.key.length === 1 ? spec.key.toUpperCase() : spec.key));
    parts.push(displayMain);
    return {ok: true, key: spec.key, code: spec.code, modifiers, combo: parts.join('+')};
}

/**
 * @param {{bindings?: any[], styles?: any[], style?: string, onChange?: (id: string) => void}} [options]
 */
export function createKeymap(options = {}) {
    const bindings = options.bindings || KEY_BINDINGS;
    const styles = options.styles || KEY_STYLES;
    let style = options.style || DEFAULT_KEY_STYLE;

    let index = new Map();     // 组合串 → 动作 id
    let combos = new Map();    // 动作 id → Set(组合串)
    let specials = new Map();  // 动作 id → Set(特殊触发)
    /** @type {Set<(id: string) => void>} */
    const listeners = new Set();

    function build() {
        index = new Map();
        combos = new Map();
        specials = new Map();
        for (const b of bindings) {
            const comboSet = new Set();
            const specialSet = new Set();
            for (const item of keyListFor(b, style)) {
                if (item === DOUBLE_SHIFT) {
                    specialSet.add(item);
                    continue;
                }
                comboSet.add(item);
                if (!index.has(item)) index.set(item, b.id);
            }
            combos.set(b.id, comboSet);
            specials.set(b.id, specialSet);
        }
    }
    build();

    return {
        get style() { return style; },
        get styles() { return styles.map((s) => s.id); },
        // 切风格：重建索引 + 通知调用方（文案表要跟着重绘）。
        /** @param {*} next */
        setStyle(next) {
            const id = String(next || '');
            if (!isValidKeyStyleId(id)) return false;
            if (id === style) return false;
            style = id;
            build();
            if (typeof options.onChange === 'function') options.onChange(id);
            for (const fn of listeners) {
                try { fn(id); } catch (e) {}
            }
            return true;
        },
        // 订阅风格变化（设置页据此重绘快捷键文案表；main.js 启动时按存档切换也会触发）。
        /** @param {(id: string) => void} fn */
        subscribe(fn) {
            if (typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        /** @param {KeyboardEvent} e */
        combo(e) { return comboFromEvent(e); },
        // 该组合是否触发这个动作（多组合：命中任一项即为真）。
        /** @param {string} combo @param {string} id */
        is(combo, id) {
            const set = combos.get(id);
            return !!set && set.has(combo);
        },
        // 该组合对应哪个动作（先到先得；风格内已保证不冲突）。
        /** @param {string} combo */
        match(combo) { return index.get(combo) || null; },
        /** @param {string} id */
        combosFor(id) {
            const set = combos.get(id);
            return set ? [...set] : [];
        },
        // 特殊触发（如双击 Shift）在当前风格是否生效。
        /** @param {string} id @param {string} token */
        hasSpecial(id, token) {
            const set = specials.get(id);
            return !!set && set.has(token);
        },
    };
}

// 全局单例：main.js 的按键链与设置页共用同一份运行时状态。
export const keymap = createKeymap();
