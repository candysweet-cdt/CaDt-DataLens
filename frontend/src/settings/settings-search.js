// 设置搜索：左栏顶部搜索框，跨面板检索设置项并跳转。
// 从 settings-ui.js 拆出；跳转经宿主注入的 selectSettingsPane 复用分发器。
export function createSettingsSearch(deps) {

// ---- 设置搜索：左栏顶部搜索框，跨面板检索设置项并跳转 ----

function buildSettingsSearchIndex() {
    const entries = [];
    const navLabels = {};
    document.querySelectorAll('.snav-item[data-pane]').forEach((b) => {
        // 锚点入口（data-anchor）与主入口指向同一 pane，标签不能覆盖主入口名
        if (b.dataset.anchor) return;
        navLabels[b.dataset.pane] = (b.textContent || '').trim();
    });
    for (const paneEl of document.querySelectorAll('.settings-pane')) {
        const pane = paneEl.dataset.pane;
        // 动态面板（数据格式 / 编程语言子页）打开前没有内容，跳过，用下面的静态条目兜底
        if (paneEl.classList.contains('hidden') && (pane.startsWith('fmt-') || pane.startsWith('lang-'))) continue;
        for (const row of paneEl.querySelectorAll('.set-row, .popover-row, .fmt-pane-title, .fmt-pane-sub, .settings-section-title')) {
            let text = (row.textContent || '').replace(/\s+/g, ' ').trim();
            // ⓘ 气泡里的长说明也参与检索（data-tip 不在 textContent 里）
            const tip = row.querySelector ? row.querySelector('.info-tip[data-tip]') : null;
            if (tip) text = (text + ' ' + tip.dataset.tip).replace(/\s+/g, ' ').trim();
            if (text) entries.push({pane, text, el: row});
        }
    }
    for (const f of deps.allFormatDefs()) {
        entries.push({pane: 'fmt-' + f.id, text: f.name + '：编码 / 缩进 / 保存换行 / 默认视图', el: null});
    }
    for (const l of deps.LANG_DEFS) {
        entries.push({pane: 'lang-' + l.id, text: l.name + '：环境检测（路径 / 版本）', el: null});
        for (const t of l.tools || []) {
            entries.push({pane: 'lang-' + l.id, text: l.name + ' · ' + t.name, el: null});
        }
    }
    return {entries, navLabels};
}

function renderSettingsSearch(query) {
    const box = deps.elsSettings.settingsSearchResults;
    if (!box) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
        box.classList.add('hidden');
        box.textContent = '';
        return;
    }
    const {entries, navLabels} = buildSettingsSearchIndex();
    const hits = [];
    for (const e of entries) {
        const hay = (navLabels[e.pane] || '') + ' ' + e.text;
        if (hay.toLowerCase().includes(q)) hits.push(e);
        if (hits.length >= 12) break;
    }
    box.textContent = '';
    if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'settings-search-empty';
        empty.textContent = '没有匹配的设置';
        box.appendChild(empty);
    } else {
        for (const hit of hits) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'settings-search-item';
            const nav = document.createElement('span');
            nav.className = 'settings-search-nav';
            nav.textContent = navLabels[hit.pane] || hit.pane;
            const text = document.createElement('span');
            text.className = 'settings-search-text';
            text.textContent = hit.text.length > 64 ? hit.text.slice(0, 64) + '…' : hit.text;
            row.append(nav, text);
            row.addEventListener('click', () => {
                box.classList.add('hidden');
                deps.selectSettingsPane(hit.pane);
                if (hit.el && hit.el.isConnected) {
                    hit.el.scrollIntoView({block: 'center'});
                    hit.el.classList.add('settings-hit');
                    setTimeout(() => hit.el.classList.remove('settings-hit'), 1600);
                }
            });
            box.appendChild(row);
        }
    }
    box.classList.remove('hidden');
}

function resetSettingsSearch() {
    if (deps.elsSettings.settingsSearch) deps.elsSettings.settingsSearch.value = '';
    if (deps.elsSettings.settingsSearchResults) {
        deps.elsSettings.settingsSearchResults.classList.add('hidden');
        deps.elsSettings.settingsSearchResults.textContent = '';
    }
}

if (deps.elsSettings.settingsSearch) {
    deps.elsSettings.settingsSearch.addEventListener('input', () => renderSettingsSearch(deps.elsSettings.settingsSearch.value));
    deps.elsSettings.settingsSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            resetSettingsSearch();
            deps.elsSettings.settingsSearch.blur();
        } else if (e.key === 'Enter') {
            const first = deps.elsSettings.settingsSearchResults.querySelector('.settings-search-item');
            if (first) first.click();
        }
    });
}



return {buildSettingsSearchIndex, renderSettingsSearch, resetSettingsSearch};
}
