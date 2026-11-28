// explorer-ops.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 资源管理器域操作：路径改码（重命名/移动/删除联动）、文件剪贴板、
// 新建/重命名/删除对话框、explorer 右键菜单。
//
// deps 由 main.js 显式传入（getter 延迟求值 + 需要回写的状态带 setter）；
// 原 main.js 裸标识符引用已按 deps 名重写为 deps.X。
import {createExplorerHistory} from './explorer-history.js';
import {BUILTIN_FILE_TYPES, fileTypeMenuItem, resolveNewFileMenu} from './new-file-menu.js';
import {normalizeScratchExt, scratchDraftName, scratchDir} from '../core/scratch.js';
import {iconSvg} from '../core/icons.js';
import {legacyPathKey} from '../core/path-key.js';

export function createExplorerOps(deps) {

// 「当前根」：单工作区 = 窗口工作区；多工作区 = 聚焦会话的工作区（main.js 注入 currentRootOf）。
// 与 deps.workspaceFolder 的区别：那个是**窗口绑定**（多工作区恒空，且本模块会写回它），
// 这个只读来表达「我在哪个目录」（临时文件落点 / 是否可用 / 复制相对路径）。
// 缺 currentRootOf 时（旧 mock / 单测）回落到 workspaceFolder，行为与改前一致。
function rootOf() {
    if (typeof deps.currentRootOf === 'function') return deps.currentRootOf() || '';
    return deps.workspaceFolder || '';
}

// 文件树操作历史（会话内）：删除 / 重命名 / 移动 / 新建各自记录可逆动作。
const history = createExplorerHistory();

// 撤销动作写盘后走差量刷新，保留树的展开态与滚动位置（refresh() 是用户主动点刷新专用）。
function afterHistoryChange(paths) {
    if (!deps.explorer || !deps.explorer.notifyFileChange) return;
    for (const path of paths) {
        if (path) deps.explorer.notifyFileChange(path);
    }
}

function remapPathValue(path, oldPath, newPath) {
    if (!path) return path;
    const target = String(path).replace(/\\/g, '/');
    const oldNorm = String(oldPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!oldNorm) return path;
    const lowerTarget = target.toLowerCase();
    const lowerOld = oldNorm.toLowerCase();
    if (lowerTarget === lowerOld) return newPath;
    if (!lowerTarget.startsWith(lowerOld + '/')) return path;
    return String(newPath).replace(/\\/g, '/').replace(/\/+$/, '') + target.slice(oldNorm.length);
}

function parentFolderOf(path) {
    const text = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const index = text.lastIndexOf('/');
    if (index < 0) return '';
    let dir = text.slice(0, index);
    if (/^[a-z]:$/i.test(dir)) dir += '/';
    return dir;
}

function samePathValue(a, b) {
    const left = legacyPathKey(a || '')
    const right = legacyPathKey(b || '')
    return !!left && left === right;
}

function pathWithinValue(root, target) {
    const base = legacyPathKey(root || '')
    const child = legacyPathKey(target || '')
    return !!base && (child === base || child.startsWith(base + '/'));
}

function clipboardItems(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    const out = [];
    for (const item of list) {
        if (!item || !item.path) continue;
        if (out.some((entry) => samePathValue(entry.path, item.path))) continue;
        out.push({path: item.path, name: item.name || deps.baseNameOf(item.path), isDir: !!item.isDir});
    }
    return out;
}

function setFileClipboard(targets, cut) {
    const all = clipboardItems(targets);
    const items = all.filter((item) =>
        !all.some((other) =>
            other.isDir && !samePathValue(other.path, item.path) && pathWithinValue(other.path, item.path)));
    if (!items.length) return;
    const same = deps.fileClipboard && deps.fileClipboard.cut === !!cut &&
        deps.fileClipboard.items.length === items.length &&
        items.every((item) => deps.fileClipboard.items.some((old) => samePathValue(old.path, item.path)));
    if (same) {
        if (deps.explorer) deps.explorer.setCutPaths(cut ? items.map((item) => item.path) : []);
        return;
    }
    deps.fileClipboard = {items, cut: !!cut};
    if (deps.explorer) deps.explorer.setCutPaths(cut ? items.map((item) => item.path) : []);
    deps.flash(items.length === 1
        ? (cut ? '已剪切：' : '已复制：') + items[0].name
        : (cut ? '已剪切 ' : '已复制 ') + items.length + ' 项');
}

function applyMovedPath(oldPath, newPath) {
    let activeChanged = false;
    for (const doc of deps.docs) {
        if (!doc.path) continue;
        const next = remapPathValue(doc.path, oldPath, newPath);
        if (next === doc.path) continue;
        doc.path = next;
        doc.name = deps.baseNameOf(next);
        if (doc === deps.file) activeChanged = true;
    }
    const rootChanged = remapRoots(oldPath, newPath);
    for (const entry of deps.closedTabs) {
        if (entry.path) entry.path = remapPathValue(entry.path, oldPath, newPath);
    }
    if (activeChanged && deps.file) {
        deps.setFilename(deps.file.name, deps.file.path);
        deps.renderBreadcrumb(deps.file.path);
        deps.updateWindowTitle();
    }
    deps.renderTabs();
    return {activeChanged, rootChanged};
}

// 移动可撤销：记录每项的原路径与新路径，正反两个方向都调 MoveEntry + applyMovedPath。
function recordMove(results, destDir) {
    if (!results.length) return;
    const moves = results.map((result) => ({
        from: result.path,
        to: result.newPath,
        name: result.name || deps.baseNameOf(result.path),
        isDir: !!result.isDir,
    }));
    const replay = (forward) => async () => {
        const failures = [];
        for (const move of moves) {
            const src = forward ? move.from : move.to;
            const dir = forward ? destDir : parentFolderOf(move.from);
            try {
                const landed = await deps.backend.MoveEntry(src, dir, move.name);
                applyMovedPath(src, landed);
                afterHistoryChange([src, landed]);
            } catch (e) {
                failures.push(move.name + '：' + ((e && e.message) || e));
            }
        }
        if (failures.length) {
            deps.flash((forward ? '移动' : '移回') + '失败：' + failures[0], true);
            return false;
        }
        deps.flash(forward ? '已移动 ' + moves.length + ' 项' : '已移回 ' + moves.length + ' 项');
        return true;
    };
    history.push({
        label: moves.length > 1 ? '移动 ' + moves.length + ' 项' : '移动“' + moves[0].name + '”',
        undo: replay(false),
        redo: replay(true),
    });
}

async function runPasteItems(clip, destDir, names) {
    if (!clip || !clip.items.length) throw new Error('剪贴板中没有文件');
    if (!deps.backend.CopyEntry || !deps.backend.MoveEntry) throw new Error('当前版本不支持粘贴');
    const cut = !!clip.cut;
    const results = [];
    const errors = [];
    for (const item of clip.items) {
        const name = (names && names[item.path]) || item.name;
        try {
            const newPath = cut
                ? await deps.backend.MoveEntry(item.path, destDir, name)
                : await deps.backend.CopyEntry(item.path, destDir, name);
            results.push({...item, newPath});
        } catch (e) {
            errors.push({item, error: (e && e.message) || String(e)});
        }
    }
    let activeChanged = false;
    let rootChanged = false;
    if (cut && results.length) {
        for (const result of results) {
            const flags = applyMovedPath(result.path, result.newPath);
            activeChanged = activeChanged || flags.activeChanged;
            rootChanged = rootChanged || flags.rootChanged;
            if (deps.explorer) deps.explorer.removePath(result.path);
            deps.activityLog.log('file.move', destDir, {from: deps.actRel(result.path), count: results.length});
        }
        const moved = new Set(results.map((result) => result.path));
        const remaining = clip.items.filter((item) => !moved.has(item.path));
        if (remaining.length) {
            deps.fileClipboard = {items: remaining, cut: true};
            if (deps.explorer) deps.explorer.setCutPaths(remaining.map((item) => item.path));
        } else {
            deps.fileClipboard = null;
            if (deps.explorer) deps.explorer.setCutPaths([]);
        }
        recordMove(results, destDir);
    }
    if (rootChanged && deps.explorer) deps.explorer.setRoot(rootOf());
    if (rootChanged) deps.renderWorkspaceCrumbs();
    if (deps.explorer && results.length) {
        await deps.explorer.refreshDir(destDir);
        deps.explorer.selectPaths(results.map((result) => ({
            path: result.newPath,
            name: deps.baseNameOf(result.newPath),
            isDir: result.isDir,
        })));
        if (activeChanged && deps.file) deps.explorer.setActive(deps.file.path);
    }
    return {
        okCount: results.length,
        failCount: errors.length,
        firstError: errors.length ? errors[0].error : '',
        results,
    };
}

async function moveEntriesByDrag(items, destDir) {
    if (deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能移动文件', true);
        return;
    }
    if (!deps.backend.MoveEntry) {
        deps.flash('当前版本不支持移动文件', true);
        return;
    }
    const all = clipboardItems(items);
    // 选中的父目录和子项同时拖动时只移动父目录
    const unique = all.filter((item) =>
        !all.some((other) => other.isDir && !samePathValue(other.path, item.path) && pathWithinValue(other.path, item.path)));
    const movable = unique.filter((item) =>
        !samePathValue(item.path, destDir) &&
        !(item.isDir && pathWithinValue(item.path, destDir)) &&
        !samePathValue(parentFolderOf(item.path), destDir));
    if (!movable.length) {
        deps.flash('文件已在该目录中', true);
        return;
    }
    const results = [];
    const errors = [];
    for (const item of movable) {
        try {
            const newPath = await deps.backend.MoveEntry(item.path, destDir, item.name);
            results.push({...item, newPath});
            deps.activityLog.log('file.move', destDir, {from: deps.actRel(item.path), count: movable.length});
        } catch (e) {
            errors.push({item, error: (e && e.message) || String(e)});
        }
    }
    let activeChanged = false;
    let rootChanged = false;
    for (const result of results) {
        const flags = applyMovedPath(result.path, result.newPath);
        activeChanged = activeChanged || flags.activeChanged;
        rootChanged = rootChanged || flags.rootChanged;
        if (deps.explorer) deps.explorer.removePath(result.path);
    }
    if (rootChanged && deps.explorer) deps.explorer.setRoot(rootOf());
    recordMove(results, destDir);
    if (deps.explorer && results.length) {
        await deps.explorer.refreshDir(destDir);
        deps.explorer.selectPaths(results.map((result) => ({
            path: result.newPath,
            name: deps.baseNameOf(result.newPath),
            isDir: result.isDir,
        })));
        if (activeChanged && deps.file) deps.explorer.setActive(deps.file.path);
    }
    if (errors.length) {
        const ok = results.length ? '已移动 ' + results.length + ' 项，' : '';
        deps.flash(ok + errors.length + ' 项失败：' + errors[0].error, true);
    } else {
        deps.flash(results.length === 1 ? '已移动：' + deps.baseNameOf(results[0].newPath) : '已移动 ' + results.length + ' 项');
    }
}

async function pasteFileClipboard(targetInfo) {
    if (!deps.fileClipboard || !deps.fileClipboard.items.length) {
        deps.flash('剪贴板中没有文件', true);
        return;
    }
    if (deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能粘贴', true);
        return;
    }
    const clip = deps.fileClipboard;
    const destDir = targetInfo && targetInfo.isDir ? targetInfo.path : parentFolderOf(targetInfo && targetInfo.path);
    if (!destDir) {
        deps.flash('无法确定粘贴目录', true);
        return;
    }
    const items = clip.items.filter((item) => {
        if (item.isDir && pathWithinValue(item.path, destDir)) return false;
        if (clip.cut && samePathValue(parentFolderOf(item.path), destDir)) return false;
        return true;
    });
    if (!items.length) {
        deps.flash(clip.cut ? '源文件已经在该目录中' : '不能粘贴到文件夹自身或其子目录', true);
        return;
    }
    const skipped = clip.items.length - items.length;
    if (items.length === 1 && clip.items.length === 1) {
        const item = items[0];
        let suggested;
        try {
            suggested = await deps.backend.SuggestCopyName(destDir, item.name, item.isDir);
        } catch (e) {
            deps.flash('粘贴失败：' + e, true);
            return;
        }
        if (suggested === item.name) {
            try {
                const result = await runPasteItems({items, cut: clip.cut}, destDir);
                if (result.failCount) deps.flash('粘贴失败：' + result.firstError, true);
                else deps.flash((clip.cut ? '已移动：' : '已粘贴：') + item.name);
            } catch (e) {
                deps.flash('粘贴失败：' + e, true);
            }
            return;
        }
        deps.openNameDialog({
            title: clip.cut ? '移动' : '粘贴',
            label: '新名称',
            value: suggested,
            selectStem: !item.isDir,
            okLabel: clip.cut ? '移动' : '粘贴',
            onSubmit: async (name) => {
                const result = await runPasteItems({items, cut: clip.cut}, destDir, {[item.path]: name});
                if (result.failCount) throw new Error(result.firstError);
            },
        });
        return;
    }
    const names = {};
    let renamed = 0;
    for (const item of items) {
        try {
            const suggested = await deps.backend.SuggestCopyName(destDir, item.name, item.isDir);
            if (suggested !== item.name) {
                names[item.path] = suggested;
                renamed++;
            }
        } catch (e) {
            deps.flash('粘贴失败：' + e, true);
            return;
        }
    }
    try {
        const result = await runPasteItems({items, cut: clip.cut}, destDir, names);
        if (result.failCount) {
            deps.flash('已粘贴 ' + result.okCount + ' 项，' + result.failCount + ' 项失败：' + result.firstError, true);
        } else {
            deps.flash((clip.cut ? '已移动 ' : '已粘贴 ') + result.okCount + ' 项' +
                (renamed ? '（' + renamed + ' 项自动重命名）' : '') +
                (skipped ? '，跳过 ' + skipped + ' 项' : ''));
        }
    } catch (e) {
        deps.flash('粘贴失败：' + e, true);
    }
}

function openCreateEntryDialog(dirPath, isDir, suggestedName, title, initialContent) {
    deps.openNameDialog({
        title: title || (isDir ? '新建文件夹' : '新建文件'),
        label: isDir ? '文件夹名称' : '文件名',
        value: suggestedName || '',
        placeholder: isDir ? '例如：config' : '例如：data.json',
        selectStem: !isDir,
        okLabel: '创建',
        onSubmit: async (name) => {
            if (!deps.backend.CreateEntry) throw new Error('当前版本不支持新建');
            const target = await deps.backend.CreateEntry(dirPath, name, isDir);
            // 自定义模板：CreateEntry 建的是空文件（O_EXCL），模板正文随后由 SaveFile 写入。
            const body = !isDir && initialContent ? String(initialContent) : '';
            if (body && deps.backend.SaveFile) await deps.backend.SaveFile(target, body, 'lf', false, 'utf-8');
            if (deps.explorer) {
                await deps.explorer.refreshDir(dirPath);
                deps.explorer.selectPath(target, isDir);
            }
            if (isDir) {
                deps.flash('已新建文件夹：' + name.trim());
            } else {
                await deps.openPath(target);
            }
            // 新建可撤销：撤销删除（进回收站），重做则重新创建同名条目并回填模板正文
            history.push({
                label: '新建“' + deps.baseNameOf(target) + '”',
                undo: async () => {
                    if (!deps.backend.DeleteEntry) return false;
                    await deps.backend.DeleteEntry(target);
                    afterHistoryChange([target]);
                    return true;
                },
                redo: async () => {
                    const created = await deps.backend.CreateEntry(dirPath, deps.baseNameOf(target), isDir);
                    if (body && deps.backend.SaveFile) await deps.backend.SaveFile(created, body, 'lf', false, 'utf-8');
                    afterHistoryChange([created]);
                    if (deps.explorer) await deps.explorer.refreshDir(dirPath);
                    return true;
                },
            });
        },
    });
}

// ---- 临时草稿（docs/finished-plans/scratch-file.md）----
//
// 语言清单直接复用「新建文件」的内置类型表：应用里高亮 / 视图 / 运行配方全部按扩展名分派，
// 没有内容嗅探，所以「选语言」= 选扩展名（方案 §6）。零新表。
const scratchLangs = BUILTIN_FILE_TYPES.map((type) => {
    const dot = type.name.lastIndexOf('.');
    return {
        ext: type.name.slice(dot).toLowerCase(),
        // 'Markdown 文件' → 'Markdown'；'Shell 脚本' 原样
        label: type.label.replace(/文件$/, ''),
        group: type.group,
    };
});

// scratchLangItems：语言项 → 菜单项（只决定出现与标签，可用性由 scratchMenuItems 统一套）。
function scratchLangItems(dirPath, langs) {
    return langs.map((lang) => ({
        label: lang.label,
        shortcut: lang.ext,
        action: () => createScratchFile(dirPath, lang.ext),
    }));
}

// scratchMenuItems：新建菜单里「临时文件」的子菜单。
// 首行 = 上次用过的扩展名（settings.scratchExt，缺省 .md）一键建，其余是语言清单 + 更多…
function scratchMenuItems(dirPath) {
    const defExt = normalizeScratchExt(deps.settings && deps.settings.scratchExt);
    const readOnly = !!(deps.settings && deps.settings.readOnlyMode);
    const items = [
        {label: '临时文件（' + defExt + '）', icon: 'doc', action: () => createScratchFile(dirPath, defExt)},
        {sep: true},
        ...scratchLangItems(dirPath, scratchLangs.filter((lang) => lang.group === 'top')),
    ];
    const more = scratchLangs.filter((lang) => lang.group !== 'top');
    if (more.length) items.push({label: '更多…', submenu: scratchLangItems(dirPath, more)});
    for (const item of items) {
        if (!item.sep) item.disabled = readOnly;
    }
    return items;
}

// createScratchFile(dirPath, ext, opts)：临时文件的唯一编排。
//   dirPath —— 只表达「从哪个新建入口进来」，**不参与拼路径**：临时文件一律落工作区根的
//              .cadt/scratch/，不能跟着右键点中的子目录走（也不能落进 AI 免审写区 .cadt/tmp）。
//   ext     —— 临时文件扩展名（= 语言）。
//   opts.content —— 初始内容（编辑器选区「存为临时文件」用）。
// 落盘链路：AIEnsureDir（MkdirAll 幂等）→ CreateEntry（O_EXCL）→ SaveFile（有初始内容时）→ openPath。
// 不刷文件树：.cadt 在文件树里本来就被跳过，刷了也看不见，改为一句话 flash。
async function createScratchFile(dirPath, ext, opts = {}) {
    const ws = rootOf();
    if (!ws) {
        deps.flash('临时文件需要先打开工作区文件夹', true);
        return '';
    }
    if (deps.settings && deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能新建临时文件', true);
        return '';
    }
    if (!deps.backend.AIEnsureDir || !deps.backend.CreateEntry || !deps.backend.SaveFile) {
        deps.flash('当前版本不支持临时文件', true);
        return '';
    }
    const dir = scratchDir(ws);
    const usedExt = normalizeScratchExt(ext);
    const content = opts && opts.content != null ? String(opts.content) : '';
    try {
        await deps.backend.AIEnsureDir(dir);
    } catch (e) {
        deps.flash('创建草稿目录失败：' + e, true);
        return '';
    }
    // JetBrains 风格命名：scratch.<ext>，同扩展名撞名时递增 scratch_1 / scratch_2 …
    // CreateEntry 走 O_EXCL 会报「已存在」，递增重试直到成功（上限 100，防极端堆积）。
    let target = '';
    let name = '';
    for (let seq = 0; seq < 100; seq += 1) {
        name = scratchDraftName(usedExt, seq);
        try {
            target = await deps.backend.CreateEntry(dir, name, false);
            break;
        } catch (e) {
            if (seq >= 99) {
                deps.flash('创建临时文件失败：' + e, true);
                return '';
            }
        }
    }
    if (!target) return '';
    if (content) {
        try {
            await deps.backend.SaveFile(target, content, 'lf', false, 'utf-8');
        } catch (e) {
            deps.flash('临时文件已建，但写入内容失败：' + e, true);
        }
    }
    // 「上次用过的扩展名」只影响下一次一键建临时文件，不值得走整份 applySettings（会重刷主题/字体）
    if (typeof deps.rememberScratchExt === 'function') deps.rememberScratchExt(usedExt);
    if (deps.openPath) await deps.openPath(target);
    // 文件树的「临时文件」节点要立刻能看到这份新临时文件（.cadt 不在文件系统通知范围内），
    // 顺手展开 + 选中它——比一句 flash 更明确的「东西在这儿」
    if (deps.explorer && typeof deps.explorer.refreshScratch === 'function') {
        try {
            await deps.explorer.refreshScratch({expand: true});
            if (typeof deps.explorer.selectPath === 'function') deps.explorer.selectPath(target, false);
        } catch (e) {}
    }
    const doc = deps.docs.find((item) => samePathValue(item.path, target));
    // 打开路径时 openPathsHere 已按目录判定过；这里补一次，保证「刚建的这份」一定有标记
    if (doc) {
        doc.draft = true;
        // 临时文件的预期是「立刻能写」：空内容 + 预览型格式（.md / .html）的首屏在 createDoc 里
        // 一律是预览视图，这里只对**刚建的空临时文件**改走代码视图，普通文件与已有内容不受影响。
        if (!content && doc.format && doc.format.preview && doc.mode === 'preview' &&
            doc === deps.file && typeof deps.switchMode === 'function') {
            deps.switchMode('code');
        }
    }
    deps.flash('已建临时文件：' + name + '（文件树「临时文件」）');
    history.push({
        label: '新建临时文件“' + name + '”',
        undo: async () => {
            if (!deps.backend.DeleteEntry) return false;
            await deps.backend.DeleteEntry(target); // 回收站，误撤销可取回
            afterHistoryChange([target]);
            return true;
        },
        redo: async () => {
            const created = await deps.backend.CreateEntry(dir, name, false);
            if (content && deps.backend.SaveFile) await deps.backend.SaveFile(created, content, 'lf', false, 'utf-8');
            afterHistoryChange([created]);
            return true;
        },
    });
    return target;
}

// 打开「菜单管理」设置页（右键子菜单底部的「配置菜单…」入口）。
function openNewFileMenuSettings() {
    if (!deps.openSettings) return;
    deps.openSettings('new-file-menu');
}

// newFileMenuItems：按 settings.newFileMenu 合成「新建」子菜单。
// 只决定「出现与顺序」，不绕过 readOnlyMode（入口在 showExplorerMenu 里整体禁用，这里再兜一层）。
function newFileMenuItems(dirPath) {
    const {top, more} = resolveNewFileMenu(deps.settings && deps.settings.newFileMenu);
    const readOnly = !!(deps.settings && deps.settings.readOnlyMode);
    const createType = (type) => openCreateEntryDialog(
        dirPath, false, type.name, '新建 ' + type.label, type.content);
    const items = [];
    let specials = 0;
    let types = 0;
    for (const entry of top) {
        if (entry.kind === 'special') {
            specials += 1;
            if (entry.id === 'file.dialog') {
                items.push({label: entry.label, icon: 'file', disabled: readOnly,
                    action: () => openCreateEntryDialog(dirPath, false, '', '新建文件')});
            } else if (entry.id === 'dir.dialog') {
                items.push({label: entry.label, icon: 'folder', disabled: readOnly,
                    action: () => openCreateEntryDialog(dirPath, true, '新建文件夹', '新建文件夹')});
            } else if (entry.id === 'scratch') {
                // 临时草稿：有工作区且非只读才可用；不可用时保留灰占位（不给点了没反应的条目）。
                // 子菜单首行是「上次用过的扩展名」一键建，其余是语言清单（方案 §6）。
                const available = !!rootOf() && !readOnly;
                items.push({
                    label: entry.label,
                    icon: 'doc',
                    disabled: !available,
                    submenu: available ? scratchMenuItems(dirPath) : undefined,
                });
            }
            continue;
        }
        if (specials && !types) items.push({sep: true});
        types += 1;
        items.push({...fileTypeMenuItem(entry, createType), disabled: readOnly});
    }
    if (more.length) {
        items.push({sep: true});
        items.push({
            label: '更多', icon: 'more', disabled: readOnly,
            submenu: more.map((type) => fileTypeMenuItem(type, createType)),
        });
    }
    items.push({sep: true});
    items.push({label: '配置菜单…', icon: 'gear', action: openNewFileMenuSettings});
    return items;
}

// 窗口根被重命名/移动后同步所有「当前根」：
//   · 窗口绑定（单工作区）→ 写回 deps.workspaceFolder（真值）
//   · 视图根（多工作区）  → 经 setCurrentRoot 写 lastFocusedRoot
// 只改窗口绑定是不够的：多工作区下 deps.workspaceFolder 恒空、分支根本不进来，
// 而 currentRoot() 仍返回旧路径 → 面包屑 / git / 便签 / 草稿目录全部指向已不存在的目录。
// 返回是否真的改了（调用方据此决定要不要 setRoot / 重画）。
function remapRoots(oldPath, newPath) {
    let changed = false;
    if (deps.workspaceFolder) {
        const next = remapPathValue(deps.workspaceFolder, oldPath, newPath);
        if (next !== deps.workspaceFolder) {
            deps.workspaceFolder = next;
            changed = true;
        }
    }
    if (typeof deps.setCurrentRoot === 'function') {
        const cur = typeof deps.currentRootOf === 'function' ? deps.currentRootOf() : '';
        const next = cur ? remapPathValue(cur, oldPath, newPath) : '';
        if (next && next !== cur) {
            deps.setCurrentRoot(next);
            changed = true;
        }
    }
    return changed;
}

function applyRenamedPath(oldPath, newPath) {
    let activeChanged = false;
    for (const doc of deps.docs) {
        if (!doc.path) continue;
        const next = remapPathValue(doc.path, oldPath, newPath);
        if (next === doc.path) continue;
        doc.path = next;
        doc.name = deps.baseNameOf(next);
        if (doc === deps.file) activeChanged = true;
    }
    if (remapRoots(oldPath, newPath)) deps.renderWorkspaceCrumbs();
    for (const entry of deps.closedTabs) {
        if (entry.path) entry.path = remapPathValue(entry.path, oldPath, newPath);
    }
    if (deps.fileClipboard) {
        for (const item of deps.fileClipboard.items) {
            const next = remapPathValue(item.path, oldPath, newPath);
            if (next === item.path) continue;
            item.path = next;
            item.name = deps.baseNameOf(next);
        }
    }
    if (deps.explorer) {
        deps.explorer.pathRenamed(oldPath, newPath);
        if (deps.fileClipboard && deps.fileClipboard.cut) deps.explorer.setCutPaths(deps.fileClipboard.items.map((item) => item.path));
        if (activeChanged && deps.file) deps.explorer.setActive(deps.file.path);
    }
    if (activeChanged && deps.file) {
        deps.setFilename(deps.file.name, deps.file.path);
        deps.renderBreadcrumb(deps.file.path);
        deps.updateWindowTitle();
    }
    deps.renderTabs();
    deps.flash('已重命名为：' + deps.baseNameOf(newPath));
}

// 真正执行删除并做联动（关闭文档 / 清剪贴板 / 差量刷新 / 留痕）。
// deleteExplorerEntries 与历史回放共用，避免两套逻辑分叉。
async function performDelete(items, opts) {
    const skipLog = !!(opts && opts.skipLog);
    const deleted = [];
    const failures = [];
    for (const item of items) {
        try {
            await deps.backend.DeleteEntry(item.path);
            deleted.push(item);
        } catch (e) {
            failures.push(item.name + '：' + ((e && e.message) || e));
        }
    }
    if (deleted.length) {
        for (const doc of deps.docs.slice()) {
            if (!doc.path) continue;
            if (deleted.some((item) =>
                item.isDir ? pathWithinValue(item.path, doc.path) : samePathValue(item.path, doc.path))) {
                deps.closeDocNow(doc, false);
            }
        }
        deps.closedTabs = deps.closedTabs.filter((entry) => !deleted.some((item) =>
            item.isDir ? pathWithinValue(item.path, entry.path) : samePathValue(item.path, entry.path)));
        if (deps.fileClipboard && deps.fileClipboard.cut) {
            deps.fileClipboard.items = deps.fileClipboard.items.filter((item) => !deleted.some((target) =>
                target.isDir ? pathWithinValue(target.path, item.path) : samePathValue(target.path, item.path)));
            if (!deps.fileClipboard.items.length) deps.fileClipboard = null;
        }
        if (deps.explorer) {
            for (const item of deleted) deps.explorer.removePath(item.path);
            deps.explorer.setCutPaths(deps.fileClipboard && deps.fileClipboard.cut ? deps.fileClipboard.items.map((item) => item.path) : []);
            // 删除已在树里就地摘掉；这里只把该目录标脏走差量刷新（列表模式靠它重扫）。
            // 绝不能调 explorer.refresh()：那是「点刷新按钮」的全量重建（tree=null → 逐级重载），
            // 会把展开态与滚动位置一起丢掉，看起来就是整棵树闪一下又折叠回去。
            for (const item of deleted) deps.explorer.notifyFileChange(item.path);
        }
        // 操作留痕：逐项记录（回收站可撤销，故记路径而非仅计数）。回放不重复记。
        if (!skipLog) {
            for (const item of deleted) {
                deps.activityLog.log('file.delete', item.path, {count: deleted.length, toRecycle: true});
            }
        }
    }
    if (failures.length) {
        deps.flash('删除失败：' + failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''), true);
        return false;
    }
    deps.flash(deleted.length > 1 ? '已删除 ' + deleted.length + ' 个项目' : '已删除：' + deleted[0].name);
    return true;
}

// 从系统回收站还原（撤销删除）；整批全部成功才算成功，避免栈状态与实际文件不一致。
async function performRestore(items) {
    if (!deps.backend.RestoreEntry) {
        deps.flash('当前版本不支持从回收站还原', true);
        return false;
    }
    const failures = [];
    for (const item of items) {
        try {
            await deps.backend.RestoreEntry(item.path);
            afterHistoryChange([item.path]);
        } catch (e) {
            failures.push(item.name + '：' + ((e && e.message) || e));
        }
    }
    if (failures.length) {
        deps.flash('还原失败：' + failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''), true);
        return false;
    }
    deps.flash(items.length > 1 ? '已还原 ' + items.length + ' 个项目' : '已还原：' + items[0].name);
    return true;
}

function deleteExplorerEntries(targets) {
    const list = clipboardItems(targets);
    if (!list.length) return;
    if (!deps.backend.DeleteEntry) {
        deps.flash('当前版本不支持删除', true);
        return;
    }
    if (deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能删除', true);
        return;
    }
    const rootPath = deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '';
    const deletable = list.filter((item) => !(rootPath && samePathValue(rootPath, item.path)));
    if (!deletable.length) {
        deps.flash('不能删除文件树的根目录', true);
        return;
    }
    const openDocs = deps.docs.filter((doc) => doc.path && deletable.some((item) =>
        item.isDir ? pathWithinValue(item.path, doc.path) : samePathValue(item.path, doc.path)));
    const dirty = openDocs.some((doc) => doc.dirty);
    const what = deletable.length === 1 ? '“' + deletable[0].name + '”' : '选中的 ' + deletable.length + ' 个项目';
    const message = dirty
        ? what + '已打开且有未保存的修改，删除后这些修改会一并丢失。\n确定移到回收站吗？'
        : what + '将被移到回收站，确定继续吗？';
    deps.openConfirmDialog(message, async () => {
        const items = deletable.map((item) => ({...item}));
        const ok = await performDelete(items);
        if (ok) {
            const label = items.length > 1 ? '删除 ' + items.length + ' 项' : '删除“' + items[0].name + '”';
            history.push({
                label,
                undo: () => performRestore(items),
                redo: () => performDelete(items, {skipLog: true}),
            });
        }
    }, '删除', '删除', 'danger');
}

// 重命名到指定路径并做全链联动；正向与撤销共用。
async function performRename(path, newName, opts) {
    const newPath = await deps.backend.RenameEntry(path, newName);
    if (!newPath || newPath === path) return false;
    applyRenamedPath(path, newPath);
    afterHistoryChange([path, newPath]);
    if (!(opts && opts.quiet)) deps.activityLog.log('file.rename', newPath, {from: deps.actRel(path)});
    return {newPath};
}

function openRenameEntryDialog(info) {
    deps.openNameDialog({
        title: info.isDir ? '重命名文件夹' : '重命名文件',
        label: '新名称',
        value: info.name,
        selectStem: !info.isDir,
        okLabel: '重命名',
        onSubmit: async (name) => {
            if (!deps.backend.RenameEntry) throw new Error('当前版本不支持重命名');
            const oldPath = info.path;
            const oldName = deps.baseNameOf(oldPath);
            const result = await performRename(oldPath, name);
            if (!result) return;
            const newPath = result.newPath;
            const label = '重命名“' + oldName + '”';
            history.push({
                label,
                undo: () => performRename(newPath, oldName, {quiet: true}),
                redo: () => performRename(oldPath, name, {quiet: true}),
            });
        },
    });
}

function relativePathFrom(path, root) {
    if (!path || !root) return '';
    const target = String(path).replace(/\\/g, '/');
    const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!base) return '';
    const lowerTarget = target.toLowerCase();
    const lowerBase = base.toLowerCase();
    if (lowerTarget === lowerBase) return '.';
    if (!lowerTarget.startsWith(lowerBase + '/')) return '';
    return target.slice(base.length + 1);
}

function copyPathMenuItems(targets) {
    const list = clipboardItems(targets);
    const root = rootOf() || (deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '');
    const absolute = list.map((item) => item.path).join('\r\n');
    const relativeParts = list.map((item) => relativePathFrom(item.path, root));
    const relative = relativeParts.every(Boolean) ? relativeParts.join('\r\n') : '';
    const names = list.map((item) => item.name).join('\r\n');
    return [
        {label: '绝对路径', disabled: !absolute, action: () => deps.copyText(absolute, '绝对路径')},
        {label: '相对路径', disabled: !relative, action: () => deps.copyText(relative, '相对路径')},
        {sep: true},
        {label: '文件名', disabled: !names, action: () => deps.copyText(names, '文件名')},
    ];
}

async function undoExplorer() {
    if (!history.canUndo()) return false;
    const label = history.peekUndo();
    const ok = await history.undo();
    if (ok) deps.flash('已撤销：' + label);
    return ok;
}

async function redoExplorer() {
    if (!history.canRedo()) return false;
    const label = history.peekRedo();
    const ok = await history.redo();
    if (ok) deps.flash('已重做：' + label);
    return ok;
}

function showExplorerMenu(info, x, y) {
    if (!deps.ctxMenu || !info) return;
    // 「临时草稿」固定节点是界面给的入口，不是一个用户可以搬/删的普通目录：
    // 只给「新建草稿 / 刷新 / 定位 / 去清理」四件事，避免误删整个 scratch 目录。
    if (info.scratch) {
        const readOnly = !!(deps.settings && deps.settings.readOnlyMode);
        deps.ctxMenu.open([
            {label: '新建临时文件', icon: 'plus', disabled: readOnly, submenu: scratchMenuItems(info.path)},
            {sep: true},
            {label: '刷新', icon: 'refresh', action: () => deps.explorer && deps.explorer.refreshScratch && deps.explorer.refreshScratch({expand: true})},
            {label: '在文件管理器中显示', icon: 'folder', action: () => deps.showPathInFolder(info.path)},
            {sep: true},
            {label: '存储与清理…', icon: 'gear', action: () => deps.openSettings && deps.openSettings('storage')},
        ], x, y);
        return;
    }
    const isDir = !!info.isDir;
    const selected = deps.explorer ? deps.explorer.getSelection() : [];
    const targets = selected.length ? selected : [{path: info.path, name: info.name, isDir}];
    const rootPath = deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '';
    const deletable = targets.filter((item) => !(rootPath && samePathValue(rootPath, item.path)));
    const items = [];
    if (isDir) {
        items.push({
            label: '新建',
            icon: 'plus',
            disabled: !!deps.settings.readOnlyMode,
            submenu: newFileMenuItems(info.path),
        });
        items.push({label: '作为书籍阅读', icon: 'doc', action: () => deps.readingMode && deps.readingMode.openBook(info.path)});
        items.push({label: '用默认应用打开', icon: 'open-folder', action: () => deps.openWithDefaultApp(info.path)});
    } else {
        items.push({label: '打开', icon: 'open-folder', action: () => deps.openPath(info.path)});
        items.push({label: '以只读打开', icon: 'open-folder', action: () => deps.openPath(info.path, {readOnly: true})});
        items.push({label: '用默认应用打开', icon: 'open-folder', action: () => deps.openWithDefaultApp(info.path)});
        items.push({label: '在新窗口中打开', icon: 'new-window', action: () => deps.openInNewWindows([info.path])});
        // 轻量查看窗（辅助窗第二批）：只读、不占工作区归属，双击即看的正路
        if (deps.backend && deps.backend.OpenLightView) {
            items.push({label: '在独立窗口查看（轻量）', icon: 'new-window', action: () => {
                deps.backend.OpenLightView(info.path).catch((e) => deps.flash && deps.flash('打开轻量查看窗失败：' + ((e && e.message) || e), true));
            }});
        }
        if (deps.readingMode && /\.(md|markdown|mdx|txt|docx|epub)$/i.test(info.name || '')) {
            items.push({label: '阅读此文件', icon: 'doc', action: () => deps.readingMode.openSingleFile(info.path)});
        }
        items.push(...deps.aiReferenceFileMenuItems({path: info.path, name: info.name}));
        if (deps.gitStateCache.map.get(info.path.replace(/\\/g, '/'))) {
            items.push({label: 'Git：查看差异', icon: 'diff', action: () => deps.showGitDiff(info.path)});
        }
        const compareTargets = selected.filter((item) => item && item.path && !item.isDir);
        if (compareTargets.length === 2) {
            items.push({
                label: '比较这两个文件…',
                icon: 'doc',
                action: () => deps.openDiffDialog(compareTargets[0].path, compareTargets[1].path),
            });
        }
    }
    items.push({sep: true});
    // 插件文件树右键动作（按路径/扩展名命中）：宿主只拿菜单项数据，执行体在插件侧
    if (typeof deps.pluginFileActionsFor === 'function') {
        try {
            const pluginActions = deps.pluginFileActionsFor(info.path) || [];
            for (const a of pluginActions) {
                items.push({
                    label: '插件：' + a.label,
                    icon: 'puzzle',
                    action: () => Promise.resolve(a.run(a.ctx || {path: info.path, name: info.name, isDir}))
                        .catch((e) => deps.flash && deps.flash('插件动作失败：' + ((e && e.message) || e), true)),
                });
            }
            if (pluginActions.length) items.push({sep: true});
        } catch (e) {}
    }
    items.push({label: '复制', shortcut: 'Ctrl+C', icon: 'copy', action: () => setFileClipboard(targets, false)});
    items.push({
        label: '剪切',
        shortcut: 'Ctrl+X',
        icon: 'cut',
        disabled: !!deps.settings.readOnlyMode,
        action: () => setFileClipboard(targets, true),
    });
    items.push({
        label: '粘贴',
        shortcut: 'Ctrl+V',
        icon: 'paste',
        disabled: !!deps.settings.readOnlyMode || !deps.fileClipboard || !deps.fileClipboard.items.length,
        action: () => pasteFileClipboard(info),
    });
    items.push({sep: true});
    if (isDir) {
        items.push({label: '设为文件树根目录', icon: 'folder', action: () => deps.openFolderWorkspace(info.path)});
        items.push({
            label: '结构化目录',
            iconHtml: iconSvg('structured-dir'),
            submenu: [
                {label: '复制', icon: 'copy', action: () => deps.copyStructuredDir(info.path)},
                {label: '导出…', icon: 'save', action: () => deps.exportStructuredDir(info.path)},
            ],
        });
        items.push({sep: true});
    }
    items.push({
        label: '重命名…',
        icon: 'rename',
        disabled: !!deps.settings.readOnlyMode || targets.length !== 1,
        action: () => openRenameEntryDialog(info),
    });
    items.push({
        label: '删除',
        shortcut: 'Delete',
        icon: 'trash',
        danger: true,
        disabled: !!deps.settings.readOnlyMode || !deletable.length,
        action: () => deleteExplorerEntries(targets),
    });
    items.push({label: '复制路径', icon: 'copy', submenu: copyPathMenuItems(targets)});
    items.push({label: '在文件管理器中显示', icon: 'folder', action: () => deps.showPathInFolder(info.path)});
    items.push({sep: true});
    items.push({label: '刷新', icon: 'refresh', action: () => deps.explorer && deps.explorer.refresh()});
    items.push({sep: true});
    items.push({label: '属性…', icon: 'info', action: () => deps.showFileProperties(info.path)});
    deps.ctxMenu.open(items, x, y);
}

    return {
        remapPathValue,
        parentFolderOf,
        samePathValue,
        pathWithinValue,
        clipboardItems,
        setFileClipboard,
        applyMovedPath,
        runPasteItems,
        moveEntriesByDrag,
        pasteFileClipboard,
        openCreateEntryDialog,
        newFileMenuItems,
        // 临时草稿：编排与菜单各一份，供 文件 → 新建 / 编辑器右键 复用（不复制实现）
        createScratchFile,
        scratchMenuItems,
        applyRenamedPath,
        deleteExplorerEntries,
        openRenameEntryDialog,
        undoExplorer,
        redoExplorer,
        canUndoExplorer: () => history.canUndo(),
        canRedoExplorer: () => history.canRedo(),
        relativePathFrom,
        copyPathMenuItems,
        showExplorerMenu,
    };
}
