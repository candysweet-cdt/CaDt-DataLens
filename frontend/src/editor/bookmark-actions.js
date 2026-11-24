// bookmark-actions.js：app_control 书签动作（list/add/remove/clear/goto）的执行体。
// 从 main.js 的 runAppAction switch 拆出（phase4 M2），函数体逐字搬移；
// 编辑器域：状态经 getter 活引用（getDocs/getFile），函数经 deps 直接注入（稳定引用）；bookmark-list 纯函数直接 import。

import {bookmarkOverview, formatBookmarkListText} from './bookmark-list.js';

export function createBookmarkActions(deps) {
    // 按 path 定位文档：有 path 就找/开，没 path 用当前文件；拒绝二进制与大文件。
    async function appActionBookmarkDoc(p) {
        const path = String(p.path || '').trim();
        let doc = null;
        if (path) {
            doc = deps.findDocByPath(path);
            if (!doc) {
                await deps.openPaths([path]);
                doc = deps.findDocByPath(path);
            }
            if (!doc) throw new Error('文件不存在或无法打开：' + path);
        } else {
            doc = deps.getFile();
            if (!doc) throw new Error('当前没有打开的文件；请传 path 指定文件');
        }
        if (doc.binary || doc.large) throw new Error((doc.name || '该文件') + ' 是二进制或大文件，不支持行书签');
        return doc;
    }

    function listBookmarks() {
        return formatBookmarkListText(bookmarkOverview(deps.getDocs()));
    }

    async function addBookmark(p) {
        const doc = await appActionBookmarkDoc(p);
        const line = Math.round(Number(p.line));
        if (!line || line < 1) throw new Error('add_bookmark 需要 line（1 起的行号）');
        // 没有行号视图（如树视图）时先切到代码视图定位到该行，保证行数钳制可用
        let ace = doc.editor && doc.editor.aceEditor;
        if (!ace) {
            const landed = await deps.selectLineInDoc(doc, line);
            if (!landed) throw new Error((doc.name || '该文件') + ' 当前没有支持行号的视图，无法加书签');
            ace = doc.editor && doc.editor.aceEditor;
        }
        const result = deps.addBookmarkAt(doc, line - 1);
        if (!result) throw new Error('添加书签失败：该文件没有可用的代码/文本编辑器');
        deps.rememberDocView(doc);
        let lineCount = 0;
        try { lineCount = ace.session.getLength(); } catch (e) {}
        const out = {file: doc.name || doc.path, line: result.row + 1, added: !result.existed};
        if (lineCount && line > lineCount) {
            out.note = '请求行超出范围（共 ' + lineCount + ' 行），已加在第 ' + (result.row + 1) + ' 行';
        }
        return out;
    }

    async function removeBookmark(p) {
        const doc = await appActionBookmarkDoc(p);
        const line = Math.round(Number(p.line));
        if (!line || line < 1) throw new Error('remove_bookmark 需要 line（1 起的行号）');
        const result = deps.removeBookmarkAt(doc, line - 1);
        if (!result || !result.existed) {
            const rows = [...(doc.bookmarks || [])].sort((a, b) => a - b).map((row) => row + 1);
            throw new Error('该文件第 ' + line + ' 行没有书签' +
                (rows.length ? '（现有书签行：' + rows.join('、') + '）' : '（该文件还没有书签）'));
        }
        deps.rememberDocView(doc);
        return {file: doc.name || doc.path, line, removed: true};
    }

    async function clearBookmarks(p) {
        const doc = await appActionBookmarkDoc(p);
        const removed = deps.clearDocBookmarks(doc);
        deps.rememberDocView(doc);
        return {file: doc.name || doc.path, removed};
    }

    async function gotoBookmark(p) {
        const path = String(p.path || '').trim();
        if (!path) throw new Error('goto_bookmark 需要 path');
        const line = Math.round(Number(p.line));
        if (!line || line < 1) throw new Error('goto_bookmark 需要 line（1 起的行号）');
        await deps.openPaths([path]);
        const doc = deps.findDocByPath(path);
        if (!doc) throw new Error('文件不存在或无法打开：' + path);
        const landed = await deps.selectLineInDoc(doc, line);
        if (!landed) throw new Error((doc.name || '该文件') + ' 不支持按行定位');
        const out = {file: doc.name || doc.path, line: landed.line};
        if (landed.clamped) {
            out.note = '请求行超出范围（共 ' + landed.lineCount + ' 行），已定位到第 ' + landed.line + ' 行';
        }
        return out;
    }

    return {appActionBookmarkDoc, listBookmarks, addBookmark, removeBookmark, clearBookmarks, gotoBookmark};
}
