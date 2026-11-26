// db-table-grid.test.mjs —— 数据表状态条两个档位下拉的接线守卫。
// 行高（紧凑/常规/宽松）与分页（10/500/…行）原是裸原生 select，展开露出系统菜单，
// 与界面其余自绘控件两套外观（表单控件硬规范禁止）。修法：入 DOM 后走 deps.enhanceSelect
// 增强，且 renderStatus 不能再用 textContent='' 重建（会清掉 enhanceSelect 插入的 .set-select 包装层）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/db/db-table-grid.js', import.meta.url)), 'utf8');

test('数据表状态条：行高 / 分页下拉必须走 enhanceSelect 增强', () => {
    assert.ok(/const rowHeightSel = createSelect\(/.test(src), '行高档位下拉必须由 createSelect 建（form-controls 工厂）');
    assert.ok(/const pageSizeSel = createSelect\(/.test(src), '分页档位下拉必须由 createSelect 建');
    assert.ok(/deps\.enhanceSelect\(rowHeightSel\.control\)/.test(src), '行高下拉必须经 enhanceSelect 增强');
    assert.ok(/deps\.enhanceSelect\(pageSizeSel\.control\)/.test(src), '分页下拉必须经 enhanceSelect 增强');
    assert.ok(/if \(typeof deps\.enhanceSelect === 'function'\)/.test(src), '增强前必须有能力探测（旧宿主降级）');
});

test('数据表状态条：renderStatus 只更新文本 span，不清空整个 statusBar', () => {
    // 回归：textContent='' 会把 enhanceSelect 的 sel.after(wrap) 包装层一起清掉，下拉又变回裸原生
    assert.ok(!/statusBar\.textContent = ''/.test(src), 'renderStatus 不得再清空整个 statusBar');
    assert.ok(/const statusText = document\.createElement\('span'\)/.test(src), '必须有独立持久的状态文本节点');
    assert.ok(/statusText\.textContent = parts\.join/.test(src), '状态文本必须只更新 statusText');
    assert.ok(/if \(!statusBar\.firstChild\)[\s\S]*statusBar\.append\(statusText, rowHeightSel\.element, pageSizeSel\.element\)/.test(src),
        '两个下拉与文本节点只在首次挂载一次，后续重绘不重建（保住增强包装层）');
});

test('表浏览：每次请求带取消句柄，新请求先取消旧请求', () => {
    assert.ok(/queryId: queryID/.test(src), 'DBBrowse 必须带 queryId，后端才能登记到 DBCancel');
    assert.ok(/deps\.backend\.DBCancel\(session\.id, queryID\)/.test(src), '旧浏览请求必须走统一取消入口');
    assert.ok(/let browseRequestSeq = 0/.test(src), '取消句柄必须跨表标签页唯一');
});
