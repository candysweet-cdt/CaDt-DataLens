// @ts-check
// editor-keybindings.js：编辑器「内部文本编辑键」的键位单一来源（显示 + 运行时共用）。
//
// 与 core/keybindings.js 的分工：
//   - core/keybindings.js 管「应用级全局键」（打开面板 / 搜索 / 书签…），由 main.js 的
//     document keydown 链分发；
//   - 本文件管「编辑器内文本键」（代码 / 文本视图里 Ace 的复制行 / 删除行 / 多选…），
//     由 editor/editor-keybindings.js 重绑 jsoneditor 内嵌 Ace 的 CommandManager。
// 两张表都读同一个 settings.keyStyle（candysweet / jetbrains / vscode），切换即时生效。
//
// 本文件只放纯数据与纯函数，不 import Ace、不碰 DOM，可独立单测。
// keys[style] 用 Ace 的 bindKey 写法（'Ctrl-D' / 'Ctrl-Shift-K' / 'Alt-Shift-Down'）；
// 空数组表示该风格下不启用这个动作。exec 为 'custom:*' 时由运行时模块提供实现。

import {KEY_STYLES, DEFAULT_KEY_STYLE} from './keybindings.js';

export const CUSTOM_EXEC = {
    SELECT_NEXT_MATCH: 'custom:selectNextMatch',
    SELECT_ALL_MATCHES: 'custom:selectAllMatches',
    TOGGLE_CASE: 'custom:toggleCase',
};

// 每项：{id, label, aceCommand, keys:{candysweet,jetbrains,vscode}}
// aceCommand = Ace 内建命令名（复用其 exec），或 CUSTOM_EXEC 值（自定义实现）。
/**
 * @typedef {{id: string, label: string, aceCommand: string, keys: Record<string, string[]>}} EditorKeyBinding
 */

/** @type {EditorKeyBinding[]} */
export const EDITOR_KEY_BINDINGS = [
    // 复制行 / 选区：JetBrains 与默认都是 Ctrl+D（本需求核心）；VSCode 是 Ctrl+Shift+Alt+↓
    {
        id: 'editorKey.duplicate', label: '复制行 / 选区', aceCommand: 'duplicateSelection',
        keys: {candysweet: ['Ctrl-D'], jetbrains: ['Ctrl-D'], vscode: ['Ctrl-Shift-Alt-Down']},
    },
    // 删除行：JetBrains / 默认 Ctrl+Y；VSCode Ctrl+Shift+K
    {
        id: 'editorKey.removeLine', label: '删除行', aceCommand: 'removeline',
        keys: {candysweet: ['Ctrl-Y'], jetbrains: ['Ctrl-Y'], vscode: ['Ctrl-Shift-K']},
    },
    // 多选下一个匹配：VSCode 标志性 Ctrl+D；其余风格不启用（保留 Ace 原生 Ctrl+Alt+→）
    {
        id: 'editorKey.selectNextMatch', label: '多选下一个匹配', aceCommand: CUSTOM_EXEC.SELECT_NEXT_MATCH,
        keys: {candysweet: [], jetbrains: [], vscode: ['Ctrl-D']},
    },
    // 选中所有匹配：VSCode Ctrl+Shift+L
    {
        id: 'editorKey.selectAllMatches', label: '选中所有匹配', aceCommand: CUSTOM_EXEC.SELECT_ALL_MATCHES,
        keys: {candysweet: [], jetbrains: [], vscode: ['Ctrl-Shift-L']},
    },
    // 复制行到上 / 下：Ace 原生 Alt+Shift+↑/↓ 保留；追加各风格的常用组合
    {
        id: 'editorKey.copyLinesUp', label: '向上复制行', aceCommand: 'copylinesup',
        keys: {candysweet: ['Ctrl-Alt-Up'], jetbrains: ['Ctrl-Alt-Up'], vscode: ['Ctrl-Shift-Alt-Up']},
    },
    {
        // VSCode 的复制行由上面的 duplicate 承担（Ctrl+Shift+Alt+↓），此处留空避免撞键
        id: 'editorKey.copyLinesDown', label: '向下复制行', aceCommand: 'copylinesdown',
        keys: {candysweet: ['Ctrl-Alt-Down'], jetbrains: ['Ctrl-Alt-Down'], vscode: []},
    },
    // 切换大小写：JetBrains Ctrl+Shift+U；VSCode 无默认（留空）
    {
        id: 'editorKey.toggleCase', label: '切换大小写', aceCommand: CUSTOM_EXEC.TOGGLE_CASE,
        keys: {candysweet: ['Ctrl-Shift-U'], jetbrains: ['Ctrl-Shift-U'], vscode: []},
    },
    // 行注释 / 块注释：三风格通用；VSCode 块注释是 Ctrl+Shift+A（本应用全局键无冲突）
    {
        id: 'editorKey.toggleComment', label: '切换行注释', aceCommand: 'togglecomment',
        keys: {candysweet: ['Ctrl-/'], jetbrains: ['Ctrl-/'], vscode: ['Ctrl-/']},
    },
    {
        id: 'editorKey.toggleBlockComment', label: '切换块注释', aceCommand: 'toggleBlockComment',
        keys: {candysweet: ['Ctrl-Shift-/'], jetbrains: ['Ctrl-Shift-/'], vscode: ['Ctrl-Shift-A']},
    },
    // 代码补全（候选弹层）：Ctrl+Space 是 language_tools 的原生触发；Alt+/ 是中文 IME 备用键
    // （Windows 中文输入法把 Ctrl+Space 占成中英切换）。startAutocomplete 命令由启用补全时
    // language_tools 挂上，运行时 execFor 能找到；SQL 控制台不归本表（自带同款命令）。
    {
        id: 'editorKey.startAutocomplete', label: '代码补全（候选弹层）', aceCommand: 'startAutocomplete',
        keys: {candysweet: ['Ctrl-Space', 'Alt-/'], jetbrains: ['Ctrl-Space', 'Alt-/'], vscode: ['Ctrl-Space', 'Alt-/']},
    },
];

/** @param {string} id */
export function isValidEditorStyle(id) {
    return KEY_STYLES.some((s) => s.id === id);
}

// 某动作在某风格下的绑定列表（Ace bindKey 写法）。
/** @param {EditorKeyBinding} binding @param {string} [style] */
export function editorKeyListFor(binding, style = DEFAULT_KEY_STYLE) {
    if (!binding || !binding.keys) return [];
    const list = binding.keys[style];
    if (!list) return binding.keys[DEFAULT_KEY_STYLE] || [];
    return Array.isArray(list) ? list : [list];
}

export function editorBindingsForStyle(style = DEFAULT_KEY_STYLE) {
    return EDITOR_KEY_BINDINGS.map((b) => ({
        id: b.id,
        label: b.label,
        keys: editorKeyListFor(b, style),
    }));
}

// 展示文案：Ace 写法 'Ctrl-Shift-Alt-Down' → 'Ctrl+Shift+Alt+↓'，多组合用 ' / ' 连接。
/** @param {string} combo */
export function formatAceKey(combo) {
    return String(combo || '')
        .replace(/-Down$/i, '+↓').replace(/-Up$/i, '+↑')
        .replace(/-Left$/i, '+←').replace(/-Right$/i, '+→')
        .replace(/-/g, '+');
}

/** @param {string} id @param {string} [style] */
export function getEditorShortcut(id, style = DEFAULT_KEY_STYLE) {
    const binding = EDITOR_KEY_BINDINGS.find((b) => b.id === id);
    if (!binding) return '';
    return editorKeyListFor(binding, style).map(formatAceKey).join(' / ');
}

// 同一风格内两个动作抢同一组合 → 冲突清单（正常应为空）。供测试守卫。
/** @param {string} [style] */
export function findEditorStyleConflicts(style = DEFAULT_KEY_STYLE) {
    /** @type {Map<string, string>} */
    const seen = new Map();
    /** @type {{combo: string, ids: string[]}[]} */
    const conflicts = [];
    for (const b of EDITOR_KEY_BINDINGS) {
        for (const combo of editorKeyListFor(b, style)) {
            if (seen.has(combo)) {
                const hit = conflicts.find((c) => c.combo === combo);
                if (hit) hit.ids.push(b.id);
                else conflicts.push({combo, ids: [/** @type {string} */ (seen.get(combo)), b.id]});
            } else {
                seen.set(combo, b.id);
            }
        }
    }
    return conflicts;
}

/** @param {string} id */
export function editorStyleVariants(id) {
    const binding = EDITOR_KEY_BINDINGS.find((b) => b.id === id);
    if (!binding) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const s of KEY_STYLES) {
        out[s.id] = editorKeyListFor(binding, s.id).map(formatAceKey).join(' / ');
    }
    return out;
}

// 生成设置页「编辑器内键位」表格片段（追加在全局快捷键表下方）。
export function renderEditorShortcutsTable(style = DEFAULT_KEY_STYLE) {
    let html = '<div class="settings-section-title">编辑器内键位（代码 / 文本视图）</div>';
    for (const row of editorBindingsForStyle(style)) {
        const key = row.keys.map(formatAceKey).join(' / ') || '—';
        html += '<div><span>' + row.label + '</span><span class="kbd">' + key + '</span></div>';
    }
    return html;
}
