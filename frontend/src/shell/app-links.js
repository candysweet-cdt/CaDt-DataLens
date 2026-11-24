// app-links.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import termsText from '../../../docs/legal/terms.md?raw';
import privacyText from '../../../docs/legal/privacy.md?raw';
import tutorialText from '../../../docs/tutorial.md?raw';

/**
 * 外链与内置文档动作域（更新日志 / 用户协议 / 隐私协议 / 开发者工具）。
 * 更新日志走内置浏览器打开 Gitee 在线页面（本地 CHANGELOG.md 体积过大，不再打进前端包）；
 * 用户协议 / 隐私协议 / 教程走内置虚拟文档并复用已打开的标签（按 bundledDoc 键去重）。
 * @param {object} deps 依赖（rt / backend / docs / activateDoc / openVirtualDoc / openBrowserTab / flash / logFrontend）
 * @returns {object} 动作面：URL 常量与 openBundledDoc / showChangelog / showTerms / showPrivacy / openDevTools / openExternalUrl
 */
export function createAppLinks(deps) {

const appFeedbackUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/issues';
const appReleasesUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases';
// 更新日志在线地址：Gitee 仓库内的 CHANGELOG.md。本地文件已近 1 MB，
// 不再以 ?raw 打进前端包，改由内置浏览器在线打开。
const appChangelogUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/blob/master/CHANGELOG.md';

function openExternalUrl(url) {
    if (!url) return;
    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

// openBundledDoc 按 bundledDoc 键复用已打开的虚拟文档，否则新建一个并打上该标记。
// readOnlyFixed：虚拟文档没有真实路径、无法保存，法律文本以固定只读打开（不可解锁）。
function openBundledDoc(key, name, text, readOnlyFixed) {
    const existing = deps.docs.find((d) => d.bundledDoc === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = deps.openVirtualDoc(name, text, readOnlyFixed ? {readOnlyFixed: true} : undefined);
    doc.bundledDoc = key;
    return doc;
}

// showChangelog 走内置浏览器标签页打开 Gitee 在线更新日志；已开着同地址标签就直接激活，
// 避免叠标签。宿主未注入 openBrowserTab（mock / 旧宿主）时降级为系统浏览器，不让入口变死链。
function showChangelog() {
    if (typeof deps.openBrowserTab !== 'function') {
        openExternalUrl(appChangelogUrl);
        return;
    }
    // 已开着同地址的浏览器标签就直接激活，避免反复点「更新日志」叠一叠标签。
    const existing = deps.docs.find((d) => d.browser && d.browserUrl === appChangelogUrl);
    if (existing) {
        deps.activateDoc(existing);
        return;
    }
    deps.openBrowserTab(appChangelogUrl);
}

function showTerms() {
    openBundledDoc('terms', '用户协议.md', termsText, true);
}

function showPrivacy() {
    openBundledDoc('privacy', '隐私协议.md', privacyText, true);
}

function showTutorial() {
    openBundledDoc('tutorial', '教程.md', tutorialText, true);
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


    return {appChangelogUrl, appFeedbackUrl, appReleasesUrl, openBundledDoc, openDevTools, openExternalUrl, showChangelog, showPrivacy, showTerms, showTutorial};
}
