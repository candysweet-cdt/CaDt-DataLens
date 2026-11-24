import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import {compileBuiltInThemeCss, legacyThemeMap} from './src/core/theme-model.js';

const themeDefinitions = JSON.parse(readFileSync(new URL('./src/core/themes.json', import.meta.url), 'utf8'));
const builtInThemeCss = compileBuiltInThemeCss(themeDefinitions);
const themeBootstrap = JSON.stringify({defaultTheme: 'dark', legacyThemes: legacyThemeMap(themeDefinitions)});

function injectBuiltInThemes() {
    return {
        name: 'cadt-built-in-themes',
        transformIndexHtml(html) {
            return html
                .replace('<head>', `<head>\n    <script>window.__CADT_THEME_BOOTSTRAP__=${themeBootstrap};</script>`)
                .replace('</head>', `    <style data-builtin-themes>\n${builtInThemeCss}    </style>\n</head>`);
        },
    };
}

// WebView2（Chromium）只需 woff2：把 KaTeX 自带的 woff/ttf 副本从产物里丢掉，
// 同时改写 CSS 里的 @font-face src，避免残留 404 请求。省约 800 KB 内嵌体积。
const katexLegacyFont = /^assets\/KaTeX[^/]*\.(?:ttf|woff)$/i;

function dropLegacyKatexFonts() {
    return {
        name: 'cadt-drop-legacy-katex-fonts',
        generateBundle(_options, bundle) {
            for (const [key, asset] of Object.entries(bundle)) {
                if (asset.type !== 'asset' || !key.endsWith('.css')) continue;
                const css = typeof asset.source === 'string'
                    ? asset.source
                    : Buffer.from(asset.source).toString('utf8');
                asset.source = css
                    .replace(/,\s*url\([^)]*\.woff\)\s*format\((["'])woff\1\)/gi, '')
                    .replace(/,\s*url\([^)]*\.ttf\)\s*format\((["'])truetype\1\)/gi, '');
            }
            for (const key of Object.keys(bundle)) {
                if (katexLegacyFont.test(key)) delete bundle[key];
            }
        },
    };
}

export default defineConfig({
    plugins: [injectBuiltInThemes(), dropLegacyKatexFonts()],
    resolve: {
        alias: [{
            find: /^highlight\.js\/lib\/common$/,
            replacement: fileURLToPath(new URL('./node_modules/highlight.js/es/common.js', import.meta.url)),
        }],
    },
});
