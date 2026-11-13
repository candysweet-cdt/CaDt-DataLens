// app-links.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import changelogText from '../../CHANGELOG.md?raw';
import termsText from '../../docs/legal/terms.md?raw';
import privacyText from '../../docs/legal/privacy.md?raw';

export function createAppLinks(deps) {

const appFeedbackUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/issues';
const appReleasesUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases';

function openExternalUrl(url) {
    if (!url) return;
    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

function openBundledDoc(key, name, text) {
    const existing = deps.docs.find((d) => d.bundledDoc === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = deps.openVirtualDoc(name, text);
    doc.bundledDoc = key;
    return doc;
}

function showChangelog() {
    openBundledDoc('changelog', '更新日志.md', changelogText);
}

function showTerms() {
    openBundledDoc('terms', '用户协议.md', termsText);
}

function showPrivacy() {
    openBundledDoc('privacy', '隐私协议.md', privacyText);
}

async function openDevTools() {
    if (!deps.backend.OpenDevTools) {
        deps.flash('当前版本不支持打开开发者工具', true);
        return;
    }
    try {
        await deps.backend.OpenDevTools();
    } catch (e) {
        deps.flash('打开开发者工具失败：' + e, true);
        deps.logFrontend('error', '打开开发者工具失败：' + e);
    }
}


    return {appFeedbackUrl, appReleasesUrl, openBundledDoc, openDevTools, openExternalUrl, showChangelog, showPrivacy, showTerms};
}
