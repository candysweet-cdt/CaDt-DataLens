// code-styles.js：代码主题设置的兼容出口；声明真源在 core/themes.json。
// 运行时的菜单、校验与插件扩展统一读取 core/theme-registry.js。
import {
    BUILTIN_CODE_THEMES, BUILTIN_UI_THEMES, CODE_STYLE_AUTO, CODE_TOKEN_VARS,
    EDITOR_CHROME_VARS, LEGACY_THEMES, THEME_CODE_STYLE,
    currentCodeStyleName as codeStyleName,
    effectiveCodeStyleId as resolveCodeStyleId,
    isValidCodeStyleId as validCodeStyleId,
    migrateLegacyTheme as migrateTheme,
} from '../core/theme-model.js';

export {
    CODE_STYLE_AUTO, CODE_TOKEN_VARS, EDITOR_CHROME_VARS,
    LEGACY_THEMES, THEME_CODE_STYLE, migrateTheme as migrateLegacyTheme,
};

export const CODE_STYLES = BUILTIN_CODE_THEMES;

export function isValidCodeStyleId(id, styles = CODE_STYLES) {
    return validCodeStyleId(id, styles);
}

export function effectiveCodeStyleId(themeId, codeStyle, styles = CODE_STYLES, themes = BUILTIN_UI_THEMES) {
    return resolveCodeStyleId(themeId, codeStyle, styles, themes);
}

export function currentCodeStyleName(themeId, codeStyle, styles = CODE_STYLES, themes = BUILTIN_UI_THEMES) {
    return codeStyleName(themeId, codeStyle, styles, themes);
}
