// @ts-check
// theme-registry.js：内置与插件主题的统一注册表和样式生命周期。

import {
    BUILTIN_CODE_THEMES, BUILTIN_ICON_THEMES, BUILTIN_UI_THEMES, CODE_STYLE_AUTO,
    compileThemeCss, normalizeCodeTheme, normalizeIconTheme, normalizeUiTheme,
    resolveThemeCatalog,
} from './theme-model.js';

/** @param {any} theme @param {any} source @param {string} kind */
function withSource(theme, source, kind) {
    const pluginId = String(source?.id || '');
    return {
        ...theme,
        group: kind === 'ui' ? 'plugin' : theme.group,
        pluginId,
        pluginName: String(source?.name || pluginId),
        builtin: !pluginId,
    };
}

/** @param {Document | undefined} [doc] */
export function createThemeRegistry(doc = globalThis.document) {
    /** @type {Map<string, any>} */
    const uiThemes = new Map(/** @type {any[]} */ (BUILTIN_UI_THEMES).map((theme) => [theme.id, {...theme, group: 'base', builtin: true}]));
    /** @type {Map<string, any>} */
    const codeThemes = new Map(/** @type {any[]} */ (BUILTIN_CODE_THEMES).map((theme) => [theme.id, {...theme, builtin: true}]));
    /** @type {Map<string, any>} */
    const iconThemes = new Map(/** @type {any[]} */ (BUILTIN_ICON_THEMES).map((theme) => [theme.id, {...theme, builtin: true}]));
    /** @type {Map<string, HTMLStyleElement>} */
    const styles = new Map();
    /** @type {Set<() => void>} */
    const listeners = new Set();
    let revision = 0;

    function notify() {
        revision++;
        for (const listener of [...listeners]) listener();
    }

    /** @param {Map<string, any>} map @param {string} id */
    function ensureAvailable(map, id) {
        if (map.has(id)) throw new Error('主题 ' + id + ' 已注册');
    }

    /** @param {any} spec @param {Map<string, any>} map @param {string} kind */
    function resolveAgainst(spec, map, kind) {
        const catalog = [...map.values()].map((theme) => ({...theme, extends: null}));
        return resolveThemeCatalog([...catalog, spec], kind).find((/** @type {any} */ theme) => theme.id === spec.id);
    }

    /** @param {string} key @param {any} theme @param {string} kind */
    function mountStyle(key, theme, kind) {
        if (!doc?.head) return;
        const style = doc.createElement('style');
        style.dataset.pluginTheme = theme.id;
        style.dataset.themeKind = kind;
        style.textContent = compileThemeCss(theme, kind);
        doc.head.appendChild(style);
        styles.set(key, style);
    }

    /** @param {any} spec @param {any} source @param {string} kind */
    function register(spec, source, kind) {
        const normalize = kind === 'ui' ? normalizeUiTheme : kind === 'code' ? normalizeCodeTheme : normalizeIconTheme;
        const normalized = normalize(spec);
        const map = kind === 'ui' ? uiThemes : kind === 'code' ? codeThemes : iconThemes;
        ensureAvailable(map, normalized.id);
        const resolved = resolveAgainst(normalized, map, kind);
        if (!resolved) throw new Error('主题 ' + normalized.id + ' 注册失败');
        const entry = withSource(resolved, source, kind);
        const key = entry.pluginId + ':' + kind + ':' + entry.id;
        if (kind !== 'icon') mountStyle(key, entry, kind);
        map.set(entry.id, entry);
        notify();
        return entry;
    }

    /** @param {(theme: any) => boolean} predicate */
    function removeWhere(predicate) {
        let changed = false;
        /** @type {[string, Map<string, any>][]} */
        const catalogs = [['ui', uiThemes], ['code', codeThemes], ['icon', iconThemes]];
        for (const [kind, map] of catalogs) {
            for (const [id, theme] of map) {
                if (theme.builtin || !predicate(theme)) continue;
                const style = styles.get(theme.pluginId + ':' + kind + ':' + id);
                style?.remove();
                styles.delete(theme.pluginId + ':' + kind + ':' + id);
                map.delete(id);
                changed = true;
            }
        }
        if (changed) notify();
        return changed;
    }

    return {
        /** @param {any} spec @param {any} source */
        registerUiTheme(spec, source) { return register(spec, source, 'ui'); },
        /** @param {any} spec @param {any} source */
        registerCodeTheme(spec, source) { return register(spec, source, 'code'); },
        /** @param {any} spec @param {any} source */
        registerIconTheme(spec, source) { return register(spec, source, 'icon'); },
        /** @param {string} pluginId */
        removePluginThemes(pluginId) { return removeWhere((theme) => theme.pluginId === pluginId); },
        clearPluginThemes() { return removeWhere(() => true); },
        listUiThemes() { return [...uiThemes.values()]; },
        listCodeThemes() { return [...codeThemes.values()]; },
        listIconThemes() { return [...iconThemes.values()]; },
        /** @param {string} id */
        getUiTheme(id) { return uiThemes.get(id) || null; },
        /** @param {string} id */
        getCodeTheme(id) { return codeThemes.get(id) || null; },
        /** @param {string} id */
        getIconTheme(id) { return iconThemes.get(id) || null; },
        /** @param {string} id */
        hasUiTheme(id) { return uiThemes.has(id); },
        /** @param {string} id */
        hasCodeTheme(id) { return codeThemes.has(id); },
        /** @param {string} id */
        hasIconTheme(id) { return iconThemes.has(id); },
        iconThemeMap() { return Object.fromEntries(iconThemes); },
        /** @param {{theme?: string, codeStyle?: string, iconTheme?: string}} settings */
        reconcileSettings(settings) {
            let changed = false;
            if (!uiThemes.has(settings.theme || '')) {
                settings.theme = BUILTIN_UI_THEMES[0].id;
                changed = true;
            }
            const codeStyle = String(settings.codeStyle || CODE_STYLE_AUTO);
            if (codeStyle !== CODE_STYLE_AUTO && !codeThemes.has(codeStyle)) {
                settings.codeStyle = CODE_STYLE_AUTO;
                changed = true;
            }
            if (!iconThemes.has(settings.iconTheme || '')) {
                settings.iconTheme = BUILTIN_ICON_THEMES[0].id;
                changed = true;
            }
            return changed;
        },
        getRevision() { return revision; },
        /** @param {() => void} listener */
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export const themeRegistry = createThemeRegistry();
