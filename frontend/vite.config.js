import {defineConfig} from 'vite';

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
    plugins: [dropLegacyKatexFonts()],
});
