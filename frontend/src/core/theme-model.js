// @ts-check
// theme-model.js：主题声明校验、继承展开与 CSS 生成的纯函数。

import themeDefinitions from './themes.json' with {type: 'json'};

/** @typedef {'ui' | 'code' | 'icon'} ThemeKind */
/**
 * @typedef {object} ThemeSpec
 * @property {string} id
 * @property {string} name
 * @property {string | null} [extends]
 * @property {Record<string, string>} [vars]
 * @property {string} [colorScheme]
 * @property {string} [bg]
 * @property {string} [accent]
 * @property {string} [defaultCodeStyle]
 * @property {string} [group]
 * @property {string} [from]
 * @property {string} [css]
 * @property {string} [mode]
 * @property {Record<string, string>} [icons]
 */

export const CODE_STYLE_AUTO = 'auto';
export const CODE_TOKEN_VARS = [
    '--syn-keyword', '--syn-operator', '--syn-comment', '--syn-tag', '--syn-attr',
    '--syn-attr-value', '--syn-yaml-key', '--syn-json-key', '--syn-function', '--syn-heading',
    '--py-builtin', '--py-doc', '--py-self',
    '--code-val-key', '--code-val-string', '--code-val-number', '--code-val-bool', '--code-val-null',
];
export const EDITOR_CHROME_VARS = [
    '--editor-bg', '--editor-text',
    '--ace-selection', '--ace-active', '--ace-indent', '--ace-punct', '--ace-gutter',
];
const CODE_VARS = new Set([...CODE_TOKEN_VARS, ...EDITOR_CHROME_VARS]);
const UI_VARS = new Set([
    ...Object.keys(themeDefinitions.uiThemes[0].vars || {}),
    ...themeDefinitions.uiThemes.flatMap((theme) => Object.keys(theme.vars || {})),
]);
export const UI_THEME_VARS = [...UI_VARS];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_CSS_LENGTH = 64 * 1024;

/** @param {string} message */
function fail(message) {
    throw new Error(message);
}

/** @param {any} value @param {string} label @param {string} [fallback] */
function stringValue(value, label, fallback = '') {
    if (value == null) return fallback;
    if (typeof value !== 'string') fail(label + ' 必须是字符串');
    return value.trim();
}

/** @param {any} input @param {string} kind */
function normalizeBase(input, kind) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(kind + ' 主题必须是对象');
    const id = stringValue(input.id, '主题 id');
    if (!ID_PATTERN.test(id)) fail('主题 id 无效：' + JSON.stringify(input.id));
    const name = stringValue(input.name, '主题名称', id).slice(0, 80);
    const parent = input.extends == null ? null : stringValue(input.extends, '继承主题');
    if (parent !== null && !ID_PATTERN.test(parent)) fail('继承主题 id 无效：' + parent);
    return {id, name, extends: parent};
}

/** @param {any} input @param {Set<string>} allowed @param {string} label */
function normalizeVars(input, allowed, label) {
    if (input == null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) fail(label + ' vars 必须是对象');
    const entries = Object.entries(input);
    if (entries.length > 256) fail(label + ' vars 超过 256 项');
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, raw] of entries) {
        if (!allowed.has(key)) fail(label + ' 包含未知变量：' + key);
        if (typeof raw !== 'string' || !raw.trim()) fail(label + ' 变量 ' + key + ' 必须是非空字符串');
        const value = raw.trim();
        if (value.length > 2048 || /[;{}<>\r\n]/.test(value)) fail(label + ' 变量 ' + key + ' 含非法内容');
        out[key] = value;
    }
    return out;
}

/** @param {any} input @param {string} label */
function normalizeCss(input, label) {
    const css = stringValue(input.css, label + ' css');
    if (css.length > MAX_CSS_LENGTH) fail(label + ' css 超过 64 KiB');
    return css;
}

/** @param {any} input */
export function normalizeUiTheme(input) {
    const base = normalizeBase(input, 'ui');
    if (!input || typeof input !== 'object') fail('ui 主题必须是对象');
    const colorScheme = stringValue(input.colorScheme, 'colorScheme');
    if (colorScheme && colorScheme !== 'dark' && colorScheme !== 'light') fail('colorScheme 只能是 dark / light');
    const bg = stringValue(input.bg, 'bg');
    const accent = stringValue(input.accent, 'accent');
    if (bg && !HEX_COLOR.test(bg)) fail('bg 必须是六位十六进制颜色');
    if (accent && !HEX_COLOR.test(accent)) fail('accent 必须是六位十六进制颜色');
    return {
        ...base,
        colorScheme,
        bg,
        accent,
        defaultCodeStyle: stringValue(input.defaultCodeStyle, 'defaultCodeStyle'),
        vars: normalizeVars(input.vars, UI_VARS, 'ui 主题 ' + base.id),
        css: normalizeCss(input, 'ui 主题 ' + base.id),
    };
}

/** @param {any} input */
export function normalizeCodeTheme(input) {
    const base = normalizeBase(input, 'code');
    if (!input || typeof input !== 'object') fail('code 主题必须是对象');
    const group = stringValue(input.group, 'group', 'dark');
    if (group !== 'dark' && group !== 'light') fail('代码主题 group 只能是 dark / light');
    return {
        ...base,
        group,
        from: stringValue(input.from, 'from'),
        vars: normalizeVars(input.vars, CODE_VARS, '代码主题 ' + base.id),
    };
}

/** @param {any} input */
export function normalizeIconTheme(input) {
    const base = normalizeBase(input, 'icon');
    if (!input || typeof input !== 'object') fail('icon 主题必须是对象');
    const mode = stringValue(input.mode, 'mode');
    if (mode && mode !== 'opensource' && mode !== 'mono' && mode !== 'plain') fail('图标主题 mode 无效');
    /** @type {Record<string, string>} */
    let icons = {};
    if (input.icons != null) {
        if (typeof input.icons !== 'object' || Array.isArray(input.icons)) fail('图标主题 icons 必须是对象');
        const entries = Object.entries(input.icons);
        if (entries.length > 512) fail('图标主题 icons 超过 512 项');
        for (const [key, value] of entries) {
            if (!/^[a-z0-9_-]+$/.test(key)) fail('图标类型无效：' + key);
            if (typeof value !== 'string' || !value.includes('<' + 'svg') || value.length > 128 * 1024) {
                fail('图标 ' + key + ' 必须是合法 SVG 字符串');
            }
            icons[key] = value;
        }
    }
    if (!base.extends && !mode && !Object.keys(icons).length) fail('图标主题缺少 icons 映射');
    return {...base, mode, icons};
}

/** @param {any} input @param {string} kind */
function normalizeCatalog(input, kind) {
    if (!Array.isArray(input)) fail(kind + ' 主题清单必须是数组');
    const normalize = kind === 'ui' ? normalizeUiTheme : kind === 'code' ? normalizeCodeTheme : normalizeIconTheme;
    const specs = /** @type {any[]} */ (input).map((spec) => normalize(spec));
    const ids = new Set();
    for (const spec of specs) {
        if (ids.has(spec.id)) fail(kind + ' 主题 id 重复：' + spec.id);
        ids.add(spec.id);
    }
    return specs;
}

/** @param {any} spec @param {any[]} catalog @param {string} kind @param {string[]} [stack] @returns {any} */
function resolveInCatalog(spec, catalog, kind, stack = []) {
    if (stack.includes(spec.id)) fail('主题继承循环：' + [...stack, spec.id].join(' -> '));
    if (stack.length >= 8) fail('主题继承超过 8 层：' + spec.id);
    const parent = spec.extends ? catalog.find((item) => item.id === spec.extends) : null;
    if (spec.extends && !parent) fail(kind + ' 主题 ' + spec.id + ' 的继承目标不存在：' + spec.extends);
    const resolvedParent = parent ? resolveInCatalog(parent, catalog, kind, [...stack, spec.id]) : null;
    if (kind === 'ui') {
        const colorScheme = spec.colorScheme || resolvedParent?.colorScheme || 'dark';
        const vars = {...(resolvedParent?.vars || {}), ...spec.vars};
        const bg = spec.bg || vars['--bg'] || resolvedParent?.bg || '#1e1f24';
        const accent = spec.accent || vars['--accent'] || resolvedParent?.accent || '#4f8cff';
        if (vars['--bg'] && bg.toLowerCase() !== vars['--bg'].toLowerCase()) fail('界面主题 ' + spec.id + ' 的 bg 与 --bg 不一致');
        return {
            ...spec,
            colorScheme,
            bg,
            accent,
            defaultCodeStyle: spec.defaultCodeStyle || resolvedParent?.defaultCodeStyle || '',
            vars,
        };
    }
    if (kind === 'code') {
        const vars = {...(resolvedParent?.vars || {}), ...spec.vars};
        for (const key of CODE_VARS) {
            if (!vars[key]) fail('代码主题 ' + spec.id + ' 缺少变量：' + key);
        }
        return {...spec, group: spec.group || resolvedParent?.group || 'dark', vars};
    }
    return {
        ...spec,
        mode: spec.mode || resolvedParent?.mode || '',
        icons: {...(resolvedParent?.icons || {}), ...spec.icons},
    };
}

/** @param {any} input @param {string} kind */
export function resolveThemeCatalog(input, kind) {
    const specs = normalizeCatalog(input, kind);
    return specs.map((spec) => resolveInCatalog(spec, specs, kind));
}

export const BUILTIN_UI_THEMES = resolveThemeCatalog(themeDefinitions.uiThemes, 'ui');
export const BUILTIN_CODE_THEMES = resolveThemeCatalog(themeDefinitions.codeThemes, 'code');
export const BUILTIN_ICON_THEMES = resolveThemeCatalog(themeDefinitions.iconThemes, 'icon');
export const LEGACY_THEMES = /** @type {Record<string, {theme: string, codeStyle: string}>} */ (themeDefinitions.legacyThemes);
export const THEME_CODE_STYLE = /** @type {Record<string, string>} */ (themeDefinitions.themeCodeStyleFallback);

/** @param {string} themeId @param {string} codeStyle */
export function migrateLegacyTheme(themeId, codeStyle) {
    const legacy = LEGACY_THEMES[themeId];
    if (!legacy) return null;
    const out = {theme: legacy.theme, codeStyle: String(codeStyle || CODE_STYLE_AUTO)};
    if (out.codeStyle === CODE_STYLE_AUTO) out.codeStyle = legacy.codeStyle;
    return out;
}

/** @param {any} [definitions] */
export function legacyThemeMap(definitions = themeDefinitions) {
    return Object.fromEntries(Object.entries(definitions.legacyThemes).map(([id, value]) => [id, value.theme]));
}

/** @param {string} id @param {any[]} [styles] */
export function isValidCodeStyleId(id, styles = BUILTIN_CODE_THEMES) {
    return id === CODE_STYLE_AUTO || styles.some((style) => style.id === id);
}

/** @param {string} themeId @param {string} codeStyle @param {any[]} [styles] @param {any[]} [themes] */
export function effectiveCodeStyleId(themeId, codeStyle, styles = BUILTIN_CODE_THEMES, themes = BUILTIN_UI_THEMES) {
    const id = String(codeStyle || CODE_STYLE_AUTO);
    if (id !== CODE_STYLE_AUTO && styles.some((style) => style.id === id)) return id;
    const theme = themes.find((item) => item.id === themeId);
    return theme?.defaultCodeStyle || THEME_CODE_STYLE[themeId] || 'jetbrains-dark';
}

/** @param {string} themeId @param {string} codeStyle @param {any[]} [styles] @param {any[]} [themes] */
export function currentCodeStyleName(themeId, codeStyle, styles = BUILTIN_CODE_THEMES, themes = BUILTIN_UI_THEMES) {
    const id = String(codeStyle || CODE_STYLE_AUTO);
    if (id === CODE_STYLE_AUTO) {
        const effective = effectiveCodeStyleId(themeId, id, styles, themes);
        const style = styles.find((item) => item.id === effective);
        return '跟随软件主题（' + (style ? style.name : effective) + '）';
    }
    const style = styles.find((item) => item.id === id);
    return style ? style.name : id;
}

/** @param {Record<string, string>} vars */
function declarations(vars) {
    return Object.entries(vars).map(([key, value]) => '    ' + key + ': ' + value + ';').join('\n');
}

/** @param {any} theme @param {string} kind */
export function compileThemeCss(theme, kind) {
    const selector = kind === 'ui'
        ? `html[data-theme="${theme.id}"]`
        : `html[data-theme][data-code-style="${theme.id}"]`;
    const scheme = kind === 'ui' ? '    color-scheme: ' + theme.colorScheme + ';\n' : '';
    const css = `${selector} {\n${scheme}${declarations(theme.vars)}\n}`;
    return theme.css ? css + '\n' + theme.css : css;
}

/** @param {any} [definitions] */
export function compileBuiltInThemeCss(definitions = themeDefinitions) {
    const uiThemes = resolveThemeCatalog(definitions.uiThemes, 'ui');
    const codeThemes = resolveThemeCatalog(definitions.codeThemes, 'code');
    return [
        .../** @type {any[]} */ (uiThemes).map((theme) => compileThemeCss(theme, 'ui')),
        .../** @type {any[]} */ (codeThemes).map((theme) => compileThemeCss(theme, 'code')),
    ].join('\n\n') + '\n';
}
