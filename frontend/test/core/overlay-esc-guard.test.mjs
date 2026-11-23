// 弹层 Esc 护栏（2026-11-20 弹层栈落地时定）：页面级浮层的 Esc 一律归 core/overlay-stack.js
// 栈序分发，不许再自挂 window/document 级 Escape 监听——落地时已退役全部旧监听
// （main.js 手写优先级链、AI 弹窗让路、envvars 抢跑、灯箱 DOM 反查、标题栏逐个点名等）。
// 本护栏扫描 src/**.js 中 window/document 级 keydown 监听（向下 16 行 + 向上 4 行窗口内
// 提及 Escape，覆盖内联箭头 handler 与紧邻定义的具名 handler），命中文件必须在下方豁免
// 清单里。**新增弹层想让测试变绿，正确做法是 overlayStack.open 注册，而不是加豁免**；
// 确属「面板/视图层叠上下文内自管的小浮层」才可登记豁免，且必须写明原因。
// 已知盲区：超长 handler（main.js 全局键链）与远处定义的具名函数（reading.js
// onCaptureKey、csv-view 的 per-doc handler）扫不到，靠文件级豁免清单兜住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');

// 豁免清单：文件 → 原因。只允许「非页面级弹层」的 Esc 监听（详见 AGENTS.md 前端侧弹层硬规范）。
const ESCAPE_LOCAL_WHITELIST = {
    // 全局键链宿主：Esc 分支本身已是弹层栈分发 + 空栈守卫兜底，不是弹层自管监听
    'main.js': '全局键链（分发器宿主 + Shift+Esc dock 关闭）',
    // 气泡不进弹层栈（跟随指针的转瞬浮层）：任何 Esc 顺手隐藏且不消费事件
    'core/tooltip.js': 'tooltip 非栈成员：任何 Esc 顺手藏气泡，不 preventDefault',
    // 面板层叠上下文内自管的小浮层（栈消费时被抢占、栈空时自关，见 AGENTS.md）
    'ai/ai-panel.js': '面板内 ctx/changes pop：面板层叠上下文内自管',
    'ai/group/ai-group-view.js': '群聊菜单/mention pop：挂群聊视图 shell 内自管',
    // 全屏视图 / 文档内浮层：非页面级弹层
    'reading/reading.js': '阅读模式是全屏视图状态机，Esc 链只管视图内部',
    'editor/editor-csv-view.js': 'CSV 统计面板挂 doc.tableEl 内，per-doc 自管',
};

function walkJs(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walkJs(p));
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

function toRel(file) {
    return file.slice(SRC.length + 1).replace(/\\/g, '/');
}

test('window/document 级 Esc 监听只允许出现在豁免清单里（新弹层请走 overlayStack.open）', () => {
    const hits = [];
    for (const file of walkJs(SRC)) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (!/(window|document)\.addEventListener\('keydown'/.test(lines[i])) continue;
            const around = lines.slice(Math.max(0, i - 4), i + 17).join('\n');
            if (/Escape/.test(around)) hits.push({file: toRel(file), line: i + 1});
        }
    }
    const offenders = hits.filter((hit) => !ESCAPE_LOCAL_WHITELIST[hit.file]);
    assert.deepEqual(
        offenders,
        [],
        '以下文件自挂了 window/document 级 Esc 监听——页面级弹层请改为 overlayStack.open 注册；' +
        '确属面板/视图内自管小浮层的，登记 ESCAPE_LOCAL_WHITELIST 并写明原因：\n' +
        offenders.map((hit) => `${hit.file}:${hit.line}`).join('\n'),
    );
    assert.ok(hits.length >= 3, `豁免清单应与实际扫描结果有交集（扫到 ${hits.length} 处，清单是否过期？）`);
});

test('豁免清单里的文件必须真实存在（改名/删除后清掉对应条目）', () => {
    for (const rel of Object.keys(ESCAPE_LOCAL_WHITELIST)) {
        assert.ok(existsSync(join(SRC, rel)), `豁免清单指向不存在的文件：${rel}（${ESCAPE_LOCAL_WHITELIST[rel]}）`);
        assert.ok(ESCAPE_LOCAL_WHITELIST[rel], `豁免条目必须写明原因：${rel}`);
    }
});
