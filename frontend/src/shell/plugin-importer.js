// plugin-importer.js：插件文档导入器编排（内置解析不了的文件问一句是否交给插件转文本）。
// 从 main.js 拆出（phase4 M3），函数体逐字搬移；纯函数直接 import，UI/后端能力经 deps 注入。

import {extOf} from '../terminal/run.js';
import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from './plugin-ctx.js';
import {findImporterFor, hexDumpToBase64} from './plugin-importers.js';

export function createPluginImporter(deps) {
    // openConfirmDialog 的签名是 (message, action, okLabel, title, variant)：只有确认回调，
    // **没有取消回调**。需要「是/否」往下走时用这个 Promise 包装：确认走 action；取消（取消按钮 /
    // 遮罩 / Esc / 关闭）一律表现为 confirm 对话框被重新加上 hidden，用 MutationObserver 兜底
    // 判为 false。确认按钮点击时 closeTopDialog 先执行、随后同步 action()，而 MutationObserver
    // 的回调是微任务，所以 action 一定先落 settled，不会误判成取消。
    function askConfirmAsync(message, okLabel, title) {
        return new Promise((resolve) => {
            const el = deps.elsDialogs.confirm;
            let settled = false;
            const obs = new MutationObserver(() => {
                if (settled || !el.classList.contains('hidden')) return;
                settled = true;
                obs.disconnect();
                resolve(false);
            });
            const done = (value) => {
                if (settled) return;
                settled = true;
                obs.disconnect();
                resolve(value);
            };
            obs.observe(el, {attributes: true, attributeFilter: ['class']});
            deps.openConfirmDialog(message, () => done(true), okLabel, title);
        });
    }

    // 导入器拿到的读接口：复用既有绑定（OpenFile / ReadImageAsDataURL），不新造 Go 绑定。
    // 身份与位置来自 shell/plugin-ctx.js 的基座；source:'open' 是历史键（字符串场景名），
    // 保留不动，另有 origin:'open' 与新入口统一口径（见 plugin-ctx.js 头注释）。
    function importerReadContext(base, path, data, plugin) {
        const meta = plugin && typeof plugin === 'object' ? plugin : {};
        return withCtx(pluginCtxBase({
            pluginId: meta.pluginId,
            pluginName: meta.pluginName,
            workspace: deps.workspaceFolder || '',
            sessionId: '',
            origin: PLUGIN_CTX_ORIGINS.open,
        }), {
            source: 'open',
            ext: extOf(base),
            path,
            name: base,
            size: Number((data && data.size) || 0) || 0,
            flash: (msg, isError) => deps.flash(String(msg == null ? '' : msg), isError),
            readTextFile: async (p) => {
                const target = String(p || '').trim();
                if (!target) throw new Error('readTextFile：缺少路径');
                const file = await deps.backend.OpenFile(target, 'utf-8');
                if (!file || file.isDir) throw new Error('不是文件：' + target);
                if (file.binary) throw new Error('不是文本文件：' + target);
                return file.content == null ? '' : file.content;
            },
            readBinaryFile: (p) => readFileBase64(String(p || '').trim()),
        });
    }

    // 二进制读取：优先走读图通道（data URL 自带 base64，≤32 MB）；其余类型退回 OpenFile 的
    // 十六进制视图（Go 侧上限 1 MB）。超过上限直接报错——静默返回半截字节比报错更难排查。
    async function readFileBase64(path) {
        if (!path) throw new Error('readBinaryFile：缺少路径');
        if (deps.backend.ReadImageAsDataURL) {
            try {
                const url = String(await deps.backend.ReadImageAsDataURL(path) || '');
                const comma = url.indexOf(',');
                if (comma > 0) return url.slice(comma + 1);
            } catch (e) {
                // 非图片：继续走 hex 通道（此处尽力而为，不让读图失败打断导入）
            }
        }
        const file = await deps.backend.OpenFile(path, 'utf-8');
        if (!file || file.isDir) throw new Error('不是文件：' + path);
        if (!file.binary) throw new Error('不是二进制文件：' + path);
        const shown = Number(file.hexShown || 0);
        if (shown > 0 && Number(file.size || 0) > shown) {
            throw new Error('文件超过 1 MB，内置读取通道只覆盖前 1 MB；请用插件自己的通道读取');
        }
        return hexDumpToBase64(file.content);
    }

    // 用导入器打开：成功返回新建的只读虚拟文档；用户拒绝 / 没有导入器 / 转换失败一律返回 null，
    // 调用方按常规（二进制视图）打开——导入失败不能让文件打不开。
    async function openWithPluginImporter(base, path, data) {
        if (!data || !data.binary || data.image || data.video || data.audio) return null;
        const importer = findImporterFor(extOf(base));
        if (!importer) return null;
        const ok = await askConfirmAsync(
            '「' + base + '」内置解析不了（只能看二进制）。用插件「' + importer.pluginName + '」的导入器「' +
                importer.label + '」转成文本查看？',
            '导入', '插件导入器');
        if (!ok) return null;
        deps.flash('正在用「' + importer.label + '」导入 ' + base + '…');
        let result;
        try {
            result = await importer.convert(importerReadContext(base, path, data, importer));
        } catch (e) {
            deps.flash('导入失败，已按二进制视图打开：' + ((e && e.message) || e), true);
            return null;
        }
        const text = typeof result === 'string'
            ? result
            : (result && typeof result.text === 'string' ? result.text : '');
        if (!text) {
            deps.flash('导入器「' + importer.label + '」没有返回文本，已按二进制视图打开', true);
            return null;
        }
        // 允许导入器建议一个新文件名（PDF → report.md 才有 Markdown 渲染）：没给就沿用原文件名。
        const suggested = result && typeof result === 'object' ? String(result.name || '').trim() : '';
        const name = suggested ? suggested.slice(0, 120) : base;
        const doc = deps.openVirtualDoc(name, text, {readOnly: true});
        deps.activityLog.log('file.import', path, {
            importer: importer.id,
            plugin: importer.pluginId,
            ext: extOf(base),
        });
        deps.flash('已用插件「' + importer.pluginName + '」的「' + importer.label + '」导入 ' + base);
        return doc || null;
    }

    return {askConfirmAsync, importerReadContext, readFileBase64, openWithPluginImporter};
}
