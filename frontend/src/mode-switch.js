// mode-switch.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {showPatchView, hidePatchView} from './patch-view.js';

export function createModeSwitch(deps) {

function switchMode(mode) {
    const fromMode = deps.currentMode;
    const docBefore = deps.file;
    const wasSplit = !!(docBefore && docBefore.splitActive);
    applySwitchMode(mode);
    if (deps.file && deps.file.format && deps.file.format.patch && deps.currentMode !== 'patch') deps.refreshPatchMarkers(deps.file);
    const splitChanged = !!(deps.file && deps.file.splitActive) !== wasSplit;
    if (deps.currentMode !== fromMode || splitChanged) {
        deps.activityLog.log('view.switch', deps.currentMode, {from: fromMode});
    }
}

function applySwitchMode(mode) {
    if (!deps.editor) return;
    const doc = deps.file;
    if (mode === 'split') {
        if (doc) deps.enterSplitView(doc);
        return;
    }
    if (doc && doc.splitActive) deps.exitSplitView(doc);
    if (mode === 'sql') {
        // SQL 是覆盖层：再点一次（或菜单再次选择）关闭，回到原视图
        if (doc && doc.sqlActive) deps.closeSqlView(doc);
        else deps.enterSqlView(doc);
        return;
    }
    if (doc && doc.sqlActive) deps.closeSqlView(doc);
    // patch 是覆盖层：即使 currentMode 仍是 patch，也要允许重新显示（状态错位时可自愈）
    if (deps.currentMode === mode && mode !== 'patch') return;
    if (mode === 'image') {
        if (doc && doc.image) deps.enterImageView(doc);
        return;
    }
    if (mode === 'binary') {
        if (doc && doc.binary) deps.enterBinaryView(doc);
        return;
    }
    if (mode === 'text' && (deps.currentMode === 'image' || deps.currentMode === 'binary') && doc) {
        deps.enterTextView(doc);
        return;
    }
    if (mode === 'preview') {
        if (doc && doc.format.preview) deps.enterMarkdownPreview(doc);
        return;
    }
    if (mode === 'render') {
        if (doc && deps.isSvgDoc(doc)) deps.enterSvgRender(doc);
        return;
    }
    if (deps.currentMode === 'render') {
        if (doc) {
            deps.hideSvgRender(doc);
            // 退出渲染视图：先恢复 SVG 源文本到 code 模式编辑器，
            // 再按 code 视图继续走通用切换（render→tree 走 XML 解析建树）
            doc.loading = true;
            try {
                doc.editor.setMode('code');
                const src = doc._svgSrcText != null && doc._svgSrcText.trim()
                    ? doc._svgSrcText
                    : (doc.rawText != null ? doc.rawText : (doc.text || ''));
                doc.editor.setText(src);
                doc.text = src;
            } catch (e) {
                console.warn('leave render view failed', e);
            } finally {
                doc.loading = false;
            }
            doc.mode = 'code';
            deps.currentMode = 'code';
            delete doc._svgSrcText;
            deps.updateStatus();
            deps.updateSearchState();
        }
    }
    if (deps.currentMode === 'preview') {
        if (doc) deps.leaveMarkdownPreview(doc, mode);
        return;
    }
    if (mode === 'patch') {
        if (doc && doc.format && doc.format.patch) {
            doc.mode = 'patch';
            deps.currentMode = 'patch';
            deps.applyReadOnlyToDoc(doc);
            showPatchView(doc, deps.patchViewContext());
            deps.updateStatus();
            deps.updateSearchState();
        }
        return;
    }
    if (deps.currentMode === 'patch') {
        hidePatchView(doc);
        if (doc && (mode === 'code' || mode === 'text')) {
            // 底层编辑器可能已经是目标模式，setMode 不会触发 onModeChange；
            // 这里显式同步 doc.mode/currentMode，否则按钮会卡在「补丁视图」。
            const text = deps.editor.getText();
            doc.loading = true;
            try {
                deps.editor.setMode(mode);
                deps.editor.setText(text);
            } catch (e) {
                console.warn('switch mode failed', e);
            } finally {
                doc.loading = false;
            }
            doc.mode = mode;
            deps.currentMode = mode;
            doc.text = text;
            if (!doc.dirty) doc.bases[mode] = text;
            deps.applyAceMode();
            deps.updateStatus();
            deps.updateSearchState();
            deps.applyReadOnlyToDoc(doc);
            deps.scheduleGitGutter(doc, 300);
            return;
        }
    }
    if (mode === 'table') {
        if (doc && doc.format.table) deps.enterCsvTable(doc);
        return;
    }
    if (deps.currentMode === 'table') {
        if (doc) deps.leaveCsvTable(doc, mode);
        return;
    }
    if ((mode === 'code' || mode === 'text') && deps.currentMode === 'tree' && doc && !deps.dirty && doc.rawText != null) {
        doc.loading = true;
        try {
            deps.editor.setMode(mode);
            deps.editor.setText(doc.rawText);
            if (deps.editor.aceEditor) { deps.hookCodeFoldPreviews(deps.editor.aceEditor); deps.hookMultiCursor(deps.editor.aceEditor); deps.updateCodeFoldPreviews(deps.editor.aceEditor); }
        } catch (e) {
            console.warn('switch mode failed', e);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if ((mode === 'code' || mode === 'text') && deps.currentMode === 'tree' && doc && doc.format.id !== 'json') {
        let value;
        try {
            value = deps.editor.get();
        } catch (e) {
            deps.flash('无法读取树内容：' + e.message, true);
            return;
        }
        const text = doc.format.stringify(value);
        doc.loading = true;
        try {
            deps.editor.setMode(mode);
            deps.editor.setText(text);
            doc.text = text;
        } catch (e) {
            deps.flash('切换视图失败：' + e.message, true);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if ((mode === 'code' || mode === 'text') && (deps.currentMode === 'code' || deps.currentMode === 'text') && doc) {
        const text = deps.editor.getText();
        doc.loading = true;
        try {
            deps.editor.setMode(mode);
            deps.editor.setText(text);
        } catch (e) {
            console.warn('switch mode failed', e);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if (mode === 'tree' && (deps.currentMode === 'code' || deps.currentMode === 'text') && doc && doc.format.id !== 'json') {
        let value;
        try {
            value = doc.format.parse(deps.editor.getText());
        } catch (e) {
            deps.flash(doc.format.name + ' 解析失败：' + e.message, true);
            return;
        }
        doc.loading = true;
        try {
            deps.editor.setText(JSON.stringify(value, null, 2));
            deps.editor.setMode('tree');
            deps.editor.set(value);
        } catch (e) {
            deps.flash('切换树视图失败：' + e.message, true);
        } finally {
            doc.loading = false;
        }
        return;
    }
    try {
        deps.editor.setMode(mode);
    } catch (e) {}
}


    return {switchMode};
}
