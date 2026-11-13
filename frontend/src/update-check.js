// update-check.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createUpdateCheck(deps) {


let updateChecking = false;

function openUpdateDialog() {
    deps.elsDialogs.updateStatus.className = 'update-status';
    deps.elsDialogs.updateStatus.textContent = '正在检查更新…';
    deps.elsDialogs.updateNotes.classList.add('hidden');
    deps.elsDialogs.updateNotes.textContent = '';
    deps.elsDialogs.updateDownload.classList.add('hidden');
    deps.elsDialogs.updateDownload.onclick = null;
    deps.elsDialogs.updatePage.classList.add('hidden');
    deps.elsDialogs.updatePage.onclick = null;
    deps.openDialogEl(deps.elsDialogs.update);
}

function renderUpdateResult(info) {
    const status = deps.elsDialogs.updateStatus;
    const pageUrl = info.pageUrl || deps.appReleasesUrl;
    status.className = 'update-status';
    if (info.status === 'no-release') {
        status.textContent = 'Gitee 仓库尚未发布正式版本。当前版本 ' + info.currentVersion + '。';
        status.classList.add('muted');
        deps.elsDialogs.updatePage.classList.remove('hidden');
        deps.elsDialogs.updatePage.onclick = () => deps.openExternalUrl(pageUrl);
        return;
    }
    if (!info.hasUpdate) {
        status.textContent = '当前已是最新版本 ' + info.currentVersion + '。';
        status.classList.add('muted');
        return;
    }
    const date = info.publishedAt ? '，发布于 ' + String(info.publishedAt).slice(0, 10) : '';
    status.textContent = '发现新版本 ' + info.latestVersion + '（当前 ' + info.currentVersion + '）' + date + '。';
    if (info.notes) {
        deps.elsDialogs.updateNotes.innerHTML = deps.renderMarkdownHtml(info.notes);
        deps.elsDialogs.updateNotes.classList.remove('hidden');
        deps.elsDialogs.updateNotes.querySelectorAll('a').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                deps.openExternalUrl(a.getAttribute('href'));
            });
        });
    }
    if (info.downloadUrl) {
        deps.elsDialogs.updateDownload.classList.remove('hidden');
        deps.elsDialogs.updateDownload.onclick = () => deps.openExternalUrl(info.downloadUrl);
    }
    if (pageUrl) {
        deps.elsDialogs.updatePage.classList.remove('hidden');
        deps.elsDialogs.updatePage.onclick = () => deps.openExternalUrl(pageUrl);
    }
}

// ---- 启动时自动检查更新（可在设置关闭），结果展示在右下角状态栏 ----
const SPINNER_HTML = '<svg class="spin-icon" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="20 9" stroke-linecap="round"/></svg>';
let updateStatusTimer = 0;

function setUpdateStatus(html, opts = {}) {
    if (!deps.els.stUpdate) return;
    clearTimeout(updateStatusTimer);
    deps.els.stUpdate.innerHTML = html;
    deps.els.stUpdate.style.display = html ? '' : 'none';
    deps.els.stUpdate.onclick = opts.onClick || null;
    deps.els.stUpdate.classList.toggle('muted', !!opts.muted);
    if (opts.autoHide) {
        updateStatusTimer = setTimeout(() => {
            deps.els.stUpdate.style.display = 'none';
        }, opts.autoHide);
    }
}

function openUpdateDialogWith(info) {
    openUpdateDialog();
    renderUpdateResult(info);
}

async function autoCheckUpdateOnStart() {
    if (!deps.backend.CheckForUpdates || deps.settings.autoCheckUpdate === false) return;
    if (updateChecking) return;
    updateChecking = true;
    setUpdateStatus(SPINNER_HTML + ' 检查更新…');
    try {
        const info = await deps.backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        if (info.status === 'no-release') {
            setUpdateStatus('仓库尚未发布版本', {muted: true, autoHide: 4000});
        } else if (!info.hasUpdate) {
            setUpdateStatus('已是最新版本 ' + info.currentVersion, {muted: true, autoHide: 4000});
        } else {
            setUpdateStatus('发现新版本 ' + info.latestVersion, {onClick: () => openUpdateDialogWith(info)});
            deps.flash('发现新版本 ' + info.latestVersion + '，点击右下角查看');
        }
    } catch (e) {
        setUpdateStatus('检查更新失败', {muted: true, autoHide: 4000});
        deps.logFrontend('error', '自动检查更新失败：' + e);
    } finally {
        updateChecking = false;
    }
}

async function checkForUpdates() {
    if (updateChecking) return;
    updateChecking = true;
    openUpdateDialog();
    try {
        if (!deps.backend.CheckForUpdates) throw new Error('当前版本不支持检查更新');
        const info = await deps.backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        renderUpdateResult(info);
    } catch (e) {
        deps.elsDialogs.updateStatus.className = 'update-status error';
        deps.elsDialogs.updateStatus.textContent = '检查更新失败：' + e;
        deps.elsDialogs.updatePage.classList.remove('hidden');
        deps.elsDialogs.updatePage.onclick = () => deps.openExternalUrl(deps.appReleasesUrl);
        deps.logFrontend('error', '检查更新失败：' + e);
    } finally {
        updateChecking = false;
    }
}

async function checkForUpdatesInline() {
    const btn = document.getElementById('about-check-update');
    const status = document.getElementById('about-update-status');
    if (!btn || !status) return;
    btn.disabled = true;
    status.className = 'about-update-status';
    status.textContent = '正在检查…';
    try {
        if (!deps.backend.CheckForUpdates) throw new Error('当前版本不支持检查更新');
        const info = await deps.backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        status.className = 'about-update-status';
        status.textContent = '';
        if (info.status === 'no-release') {
            status.textContent = '仓库尚未发布版本，当前 ' + info.currentVersion;
            status.classList.add('muted');
        } else if (!info.hasUpdate) {
            status.textContent = '已是最新版本 ' + info.currentVersion;
            status.classList.add('muted');
        } else {
            status.textContent = '发现新版本 ' + info.latestVersion;
            const link = document.createElement('a');
            link.className = 'about-update-link';
            link.textContent = info.downloadUrl ? '下载安装包' : '打开发布页';
            link.addEventListener('click', (e) => {
                e.preventDefault();
                deps.openExternalUrl(info.downloadUrl || info.pageUrl || deps.appReleasesUrl);
            });
            status.appendChild(link);
        }
    } catch (e) {
        status.className = 'about-update-status error';
        status.textContent = '检查失败：' + e;
        deps.logFrontend('error', '检查更新失败：' + e);
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('btn-update-close').addEventListener('click', deps.closeDialogs);
document.getElementById('about-check-update').addEventListener('click', checkForUpdatesInline);


    return {autoCheckUpdateOnStart, checkForUpdates};
}
