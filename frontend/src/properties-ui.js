// properties-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {detectFormat} from './formats.js';

export function createPropertiesUI(deps) {

function newDocumentMenuItems() {
    return [
        {
            label: '文件…',
            icon: 'E7C3',
            disabled: !deps.workspaceFolder,
            action: () => deps.openCreateEntryDialog(deps.workspaceFolder, false, '', '新建文件'),
        },
        {
            label: '目录…',
            icon: 'E8B7',
            disabled: !deps.workspaceFolder,
            action: () => deps.openCreateEntryDialog(deps.workspaceFolder, true, '新建文件夹', '新建文件夹'),
        },
        {sep: true},
        ...deps.newFileTypeMenuItems((type) => {
            const dot = type.name.lastIndexOf('.');
            const ext = dot >= 0 ? type.name.slice(dot) : '';
            deps.newDocumentWith('未命名' + ext, ext.toLowerCase() === '.json' ? '{}' : '');
        }),
    ];
}

function propsTimeText(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
        return new Date(n).toLocaleString('zh-CN', {hour12: false});
    } catch (e) {
        return '';
    }
}

async function showFileProperties(targetPath) {
    if (targetPath) {
        await showPathProperties(targetPath);
        return;
    }
    const doc = deps.file;
    if (!doc || !doc.path) return;
    let info = null;
    if (deps.backend.GetPathInfo) {
        try {
            info = await deps.backend.GetPathInfo(doc.path);
        } catch (e) {}
    }
    const rows = [];
    rows.push(['名称', doc.name || deps.baseNameOf(doc.path), false]);
    rows.push(['路径', doc.path, true]);
    const kind = doc.binary ? (doc.image ? '图片（二进制）' : '二进制') : (doc.format ? doc.format.name : '文本');
    rows.push(['类型', kind, false]);
    const size = info && Number.isFinite(info.size) ? info.size : doc.size;
    if (Number.isFinite(size)) {
        rows.push(['大小', deps.fmtSize(size) + '（' + Number(size).toLocaleString('zh-CN') + ' 字节）', false]);
    }
    const modified = info ? propsTimeText(info.modified) : '';
    if (modified) rows.push(['修改时间', modified, false]);
    if (info) rows.push(['只读', info.readOnly ? '是' : '否', false]);
    if (!doc.binary) {
        rows.push(['编码', String(doc.enc || 'utf-8').toUpperCase(), false]);
        rows.push(['换行符', doc.eol === 'crlf' ? 'CRLF' : 'LF', false]);
        rows.push(['BOM', doc.hasBom ? '有' : '无', false]);
        if (!doc.large) {
            const text = deps.structureTextForDoc(doc) || '';
            rows.push(['行数', text ? String(text.split('\n').length) : '0', false]);
        }
    }
    deps.elsDialogs.propsGrid.textContent = '';
    for (const [key, value, mono] of rows) {
        const k = document.createElement('div');
        k.className = 'props-key';
        k.textContent = key;
        const v = document.createElement('div');
        v.className = 'props-val' + (mono ? ' mono' : '');
        v.textContent = value;
        deps.elsDialogs.propsGrid.append(k, v);
    }
    setPropsDialogTitle('文件属性');
    deps.openDialogEl(deps.elsDialogs.props);
}

// showPathProperties 文件树右键的属性：目标可以是未打开的文件或文件夹，仅展示路径元信息。
async function showPathProperties(path) {
    if (!path) return;
    let info = null;
    if (deps.backend.GetPathInfo) {
        try {
            info = await deps.backend.GetPathInfo(path);
        } catch (e) {}
    }
    const name = (info && info.name) || deps.baseNameOf(path);
    const rows = [];
    rows.push(['名称', name, false]);
    rows.push(['路径', path, true]);
    const isDirEntry = !!(info && info.isDir);
    if (isDirEntry) {
        rows.push(['类型', '文件夹', false]);
    } else {
        let kind = '文件';
        try {
            const fmt = detectFormat(name);
            if (fmt && fmt.name) kind = '文件（' + fmt.name + '）';
        } catch (e) {}
        rows.push(['类型', kind, false]);
        if (info && Number.isFinite(info.size)) {
            rows.push(['大小', deps.fmtSize(info.size) + '（' + Number(info.size).toLocaleString('zh-CN') + ' 字节）', false]);
        }
    }
    const modified = info ? propsTimeText(info.modified) : '';
    if (modified) rows.push(['修改时间', modified, false]);
    if (info) rows.push(['只读', info.readOnly ? '是' : '否', false]);
    deps.elsDialogs.propsGrid.textContent = '';
    for (const [key, value, mono] of rows) {
        const k = document.createElement('div');
        k.className = 'props-key';
        k.textContent = key;
        const v = document.createElement('div');
        v.className = 'props-val' + (mono ? ' mono' : '');
        v.textContent = value;
        deps.elsDialogs.propsGrid.append(k, v);
    }
    setPropsDialogTitle(isDirEntry ? '文件夹属性' : '文件属性');
    deps.openDialogEl(deps.elsDialogs.props);
}

function setPropsDialogTitle(text) {
    const title = deps.elsDialogs.props && deps.elsDialogs.props.querySelector('.dialog-title');
    if (title) title.textContent = text;
}

async function reloadAllFromDisk() {
    const targets = deps.docs.filter((d) => d.path).slice();
    if (!targets.length) return;
    const run = async () => {
        const original = deps.file;
        let ok = 0;
        let failed = 0;
        for (const doc of targets) {
            if (!deps.docs.includes(doc)) continue;
            await deps.activateDoc(doc);
            if (await deps.reloadActive({quiet: true})) ok++;
            else failed++;
        }
        if (original && deps.docs.includes(original) && deps.file !== original) await deps.activateDoc(original);
        deps.flash('已从磁盘重新加载 ' + ok + ' 个文件' + (failed ? '，' + failed + ' 个失败' : ''), failed > 0);
    };
    if (targets.some((d) => d.dirty)) {
        deps.openCloseConfirm('全部重新加载将丢弃所有未保存的修改。', run, '全部重新加载');
    } else {
        await run();
    }
}


    return {newDocumentMenuItems, propsTimeText, reloadAllFromDisk, showFileProperties};
}
