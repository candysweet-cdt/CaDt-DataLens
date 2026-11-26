// db-redis-view.js：Redis 键查看器标签页（方案 §11.13，每键一个标签）。
//
// 头部信息条（key/类型/TTL/长度/刷新/删除）+ 按类型分派的内容区：
//   string → 文本区（formatter Text/JSON/HEX/Binary；editable 时可编辑，保存走命令预览确认）；
//   hash/list/set/zset → 行集网格（双击行弹层编辑、右键删除行；stream 只读）。
// 编辑提交统一走结构化 DBRedisApply（RESP 直发，多行/二进制安全），弹层里展示
// 等价命令文本（§5.4「编辑生成命令预览」）；SET 清 TTL 由 setString op 携带原 TTL 自动补偿。
// 弹层全部经 overlay-stack 注册（close/onClose 双路径清理，与 db-create-table.js 同款）。

import {iconSvg} from '../core/icons.js';
import {createInput, createSelect, createTextarea} from '../core/form-controls.js';
import {createDbGrid} from './db-grid-core.js';
import {redisTTLLabel, redisTTLDraftAction} from './db-model.js';

// redisTypeLabel 类型徽标文案
function redisTypeLabel(type) {
    return type || 'unknown';
}

// redisOpCommandPreview op → 等价命令文本（弹层展示，仅供人看；实际走 RESP 直发）
function redisOpCommandPreview(op) {
    const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    switch (op.kind) {
        case 'setString': {
            const lines = ['SET ' + q(op.Key) + ' ' + q(op.Value.length > 64 ? op.Value.slice(0, 64) + '…(' + op.Value.length + ' 字节)' : op.Value)];
            if (op.TTLSeconds > 0) lines.push('EXPIRE ' + q(op.Key) + ' ' + op.TTLSeconds);
            return lines;
        }
        case 'setHashField': return ['HSET ' + q(op.Key) + ' ' + q(op.Field) + ' ' + q(op.Value)];
        case 'delHashField': return ['HDEL ' + q(op.Key) + ' ' + q(op.Field)];
        case 'setListItem': return ['LSET ' + q(op.Key) + ' ' + op.Index + ' ' + q(op.Value)];
        case 'addSetMember': return ['SADD ' + q(op.Key) + ' ' + q(op.Value)];
        case 'delSetMember': return ['SREM ' + q(op.Key) + ' ' + q(op.Value)];
        case 'addZSetMember': return ['ZADD ' + q(op.Key) + ' ' + op.Score + ' ' + q(op.Value)];
        case 'delZSetMember': return ['ZREM ' + q(op.Key) + ' ' + q(op.Value)];
        case 'setTTL': return [op.TTLSeconds < 0 ? 'PERSIST ' + q(op.Key) : 'EXPIRE ' + q(op.Key) + ' ' + op.TTLSeconds];
        case 'persist': return ['PERSIST ' + q(op.Key)];
        case 'delKey': return ['DEL ' + q(op.Key)];
        default: return ['(' + op.kind + ')'];
    }
}

export function createDbRedisKeyPane(deps, session, db, key) {
    const el = document.createElement('div');
    el.className = 'db-redis-view';
    const editable = !!session.editable;
    const backend = deps.backend;
    let value = null; // RedisValue（fetch 结果）

    // ---------- 头部信息条 ----------
    const head = document.createElement('div');
    head.className = 'db-redis-head';
    const headKey = document.createElement('span');
    headKey.className = 'db-redis-keyname';
    headKey.textContent = key;
    headKey.title = key;
    const typeBadge = document.createElement('span');
    typeBadge.className = 'db-redis-type';
    const ttlBadge = document.createElement('span');
    ttlBadge.className = 'db-tree-count db-redis-ttl';
    const lenBadge = document.createElement('span');
    lenBadge.className = 'db-tree-count';
    const headBtns = document.createElement('span');
    headBtns.className = 'db-redis-headbtns';
    const refreshBtn = iconBtn('refresh', '重新读取');
    const ttlBtn = iconBtn('clock', '修改 TTL');
    const delBtn = iconBtn('trash', '删除键');
    if (!editable) {
        ttlBtn.hidden = true;
        delBtn.hidden = true;
    }
    headBtns.append(refreshBtn.element, ttlBtn.element, delBtn.element);
    head.append(headKey, typeBadge, ttlBadge, lenBadge, headBtns);
    el.appendChild(head);

    function iconBtn(icon, tip) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'db-btn';
        b.dataset.tip = tip;
        b.innerHTML = iconSvg(icon, 12);
        return {element: b};
    }

    // ---------- 内容区 ----------
    const body = document.createElement('div');
    body.className = 'db-redis-body';
    el.appendChild(body);

    // 集合类型行集：双击单元格弹层编辑该行（editable 时；行内删除入口在弹层里）
    const grid = createDbGrid({
        onCellActivate: (rowIdx) => {
            if (value && editable && value.type !== 'stream' && (value.rows || [])[rowIdx]) {
                openRowEditDialog(value, rowIdx);
            }
        },
    });
    const gridWrap = document.createElement('div');
    gridWrap.className = 'db-redis-gridwrap hidden';
    gridWrap.appendChild(grid.el);
    const strWrap = document.createElement('div');
    strWrap.className = 'db-redis-str hidden';
    const strPre = document.createElement('pre');
    strPre.className = 'db-redis-strpre';
    strWrap.appendChild(strPre);
    const hintEl = document.createElement('div');
    hintEl.className = 'db-redis-hint hidden';
    body.append(strWrap, gridWrap, hintEl);

    // ---------- 数据加载 ----------

    async function load() {
        hintEl.classList.add('hidden');
        gridWrap.classList.add('hidden');
        strWrap.classList.add('hidden');
        strPre.textContent = '读取中…';
        strWrap.classList.remove('hidden');
        try {
            const v = await backend.DBRedisFetchValue(session.id, db, key);
            value = v;
            renderHead(v);
            renderValue(v);
        } catch (e) {
            if (isSessionError(e)) return; // sessionLost 已处理
            strPre.textContent = '';
            showHint('读取失败：' + (e && e.message || e), true);
        }
    }

    function isSessionError(e) {
        const msg = String(e && e.message || e);
        if (!/会话不存在|重新连接/.test(msg)) return false;
        if (typeof deps.sessionLost === 'function') {
            deps.sessionLost().then((ok) => {
                if (ok && typeof deps.sessionRecovered === 'function') deps.sessionRecovered();
            });
        }
        return true;
    }

    function showHint(text, isError) {
        hintEl.textContent = text;
        hintEl.classList.toggle('error', !!isError);
        hintEl.classList.remove('hidden');
    }

    function renderHead(v) {
        typeBadge.textContent = redisTypeLabel(v.type);
        const ttlText = v.ttl === -2 ? '（不存在）' : redisTTLLabel(v.ttl) || ('TTL ' + v.ttl);
        ttlBadge.textContent = ttlText;
        ttlBadge.dataset.tip = v.ttl === -1 ? '永不过期' : 'TTL ' + v.ttl + ' 秒（点击修改）';
        ttlBadge.style.display = v.ttl === -2 ? 'none' : '';
        lenBadge.textContent = v.truncated ? v.length + '（截断）' : String(v.length);
        lenBadge.dataset.tip = v.type === 'string' ? '字节数' : '元素数';
        lenBadge.style.display = v.length ? '' : 'none';
    }

    // ---------- 按类型渲染 ----------

    function renderValue(v) {
        strWrap.classList.add('hidden');
        gridWrap.classList.add('hidden');
        hintEl.classList.add('hidden');
        if (v.type === 'string') {
            renderString(v);
            return;
        }
        if ((v.columns || []).length) {
            grid.setColumns(v.columns);
            grid.setRows(v.rows || [], v.nulls || [], 0);
            gridWrap.classList.remove('hidden');
            return;
        }
        showHint(v.message || '（无可显示内容）');
    }

    // string：formatter 切换（Text/JSON/HEX/Binary）+ editable 编辑入口
    let strFormatSel = null;
    function renderString(v) {
        strWrap.classList.remove('hidden');
        strPre.textContent = '';
        if (!strFormatSel) {
            const toolbar = document.createElement('div');
            toolbar.className = 'db-redis-strtoolbar';
            strFormatSel = createSelect({
                options: [
                    {value: 'text', label: 'Text'},
                    {value: 'json', label: 'JSON'},
                    {value: 'hex', label: 'HEX'},
                    {value: 'binary', label: 'Binary (Base64)'},
                ],
                title: '查看格式',
            });
            if (typeof deps.enhanceSelect === 'function') deps.enhanceSelect(strFormatSel.element);
            strFormatSel.control.value = v.isBinary ? 'hex' : 'text';
            strFormatSel.control.addEventListener('change', renderStrBody);
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'db-btn';
            editBtn.textContent = '编辑';
            if (editable) {
                editBtn.addEventListener('click', () => openStringEditor(v));
            } else {
                editBtn.hidden = true;
            }
            toolbar.append(strFormatSel.element, editBtn);
            strWrap.appendChild(toolbar);
        }
        strFormatSel.control.style.display = '';
        renderStrBody();
    }

    function renderStrBody() {
        if (!value || value.type !== 'string') return;
        const fmt = strFormatSel ? strFormatSel.control.value : 'text';
        strPre.textContent = formatStringValue(value, fmt);
    }

    // formatStringValue string 值的四档 formatter（§5.4 Text/JSON/HEX/Binary）
    function formatStringValue(v, fmt) {
        if (fmt === 'hex') return v.hexText || '（空）';
        if (fmt === 'binary') {
            try {
                return btoa(unescape(encodeURIComponent(v.text || '')));
            } catch (e) {
                return v.hexText || '（不可编码）';
            }
        }
        const text = v.text || '';
        if (fmt === 'json') {
            try {
                return JSON.stringify(JSON.parse(text), null, 2);
            } catch (e) {
                return text + (text ? '\n\n（不是合法 JSON，按原文显示）' : '（空）');
            }
        }
        return text || '（空）';
    }

    // ---------- 集合类型的行编辑（onCellActivate 双击弹层） ----------

    // rowToOps(v, rowIdx, patch) 把当前行（+可选的修改）转成 RedisOp 列表
    function rowToOps(v, rowIdx, patch) {
        const row = (v.rows || [])[rowIdx] || [];
        const ops = [];
        switch (v.type) {
            case 'hash': {
                const field = row[0];
                if (patch && patch.del) {
                    ops.push({kind: 'delHashField', Key: key, Field: field});
                } else {
                    ops.push({kind: 'setHashField', Key: key, Field: field, Value: patch ? patch.value : row[1]});
                }
                break;
            }
            case 'list': {
                const index = Number(row[0]);
                ops.push({kind: 'setListItem', Key: key, Index: index, Value: patch ? patch.value : row[1]});
                break;
            }
            case 'set': {
                const member = row[0];
                if (patch && patch.del) {
                    ops.push({kind: 'delSetMember', Key: key, Value: member});
                } else if (patch && patch.value !== member) {
                    ops.push({kind: 'delSetMember', Key: key, Value: member});
                    ops.push({kind: 'addSetMember', Key: key, Value: patch.value});
                }
                break;
            }
            case 'zset': {
                const member = row[0];
                if (patch && patch.del) {
                    ops.push({kind: 'delZSetMember', Key: key, Value: member});
                } else {
                    const score = patch && patch.score !== undefined ? Number(patch.score) : Number(row[1]);
                    if (!Number.isFinite(score)) throw new Error('score 必须是数字');
                    ops.push({kind: 'addZSetMember', Key: key, Score: score, Value: member});
                }
                break;
            }
            default:
                throw new Error('该类型不支持行编辑（stream 请用查询控制台）');
        }
        return ops;
    }

    function openRowEditDialog(v, rowIdx) {
        const row = (v.rows || [])[rowIdx] || [];
        const isZset = v.type === 'zset';
        const valueLabel = v.type === 'hash' ? 'value' : (v.type === 'list' ? 'value' : 'member');
        const panel = document.createElement('div');
        panel.className = 'db-preview db-redis-rowedit';
        const headEl = document.createElement('div');
        headEl.className = 'db-preview-head';
        headEl.textContent = v.type + ' 行编辑 · ' + key;
        const bodyEl = document.createElement('div');
        bodyEl.className = 'db-preview-body db-redis-confirm-body';
        const fieldLabel = document.createElement('div');
        fieldLabel.className = 'db-redis-fieldname';
        fieldLabel.textContent = v.type === 'hash' ? 'field：' + row[0] : (v.type === 'zset' ? 'member：' + row[0] : 'index：' + row[0]);
        const valInput = createTextarea({rows: 4, value: row[1] || ''});
        bodyEl.append(fieldLabel, valInput.element);
        if (isZset) {
            const scoreInput = createInput({type: 'number', value: row[1] || '0', step: 'any'});
            const scoreLine = document.createElement('div');
            scoreLine.className = 'db-conn-rowline';
            const scoreLabel = document.createElement('span');
            scoreLabel.className = 'db-conn-label';
            scoreLabel.textContent = 'score';
            scoreLine.append(scoreLabel, scoreInput.element);
            bodyEl.appendChild(scoreLine);
            valInput.element.style.display = 'none'; // zset 只编辑 score（member 是行标识）
            panel._scoreInput = scoreInput;
        }
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'db-btn primary';
        saveBtn.textContent = '保存…';
        const delRowBtn = document.createElement('button');
        delRowBtn.type = 'button';
        delRowBtn.className = 'db-btn danger';
        delRowBtn.textContent = '删除该行';
        foot.append(cancelBtn, delRowBtn, saveBtn);
        panel.append(headEl, bodyEl, foot);

        const mask = document.createElement('div');
        mask.className = 'db-preview-mask';
        mask.appendChild(panel);
        let handle = null;
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            mask.remove();
            panel.remove();
        };
        const close = () => {
            if (cleaned) return;
            if (handle) handle.dispose();
            cleanup();
        };
        handle = overlayStackOpen({
            id: 'db-redis-rowedit',
            kind: 'dialog',
            el: panel,
            underEl: mask,
            onClose: () => {
                if (handle) handle.dispose();
                cleanup();
            },
        });
        document.body.appendChild(mask);
        mask.addEventListener('click', (ev) => {
            if (ev.target === mask) close();
        });
        cancelBtn.addEventListener('click', close);
        delRowBtn.addEventListener('click', () => {
            close();
            confirmAndApply(rowToOps(v, rowIdx, {del: true}));
        });
        saveBtn.addEventListener('click', () => {
            const patch = {value: valInput.control.value};
            if (isZset) patch.score = panel._scoreInput.control.value;
            let ops;
            try {
                ops = rowToOps(v, rowIdx, patch);
            } catch (e) {
                deps.flash(e.message, true);
                return;
            }
            close();
            confirmAndApply(ops);
        });
    }

    // overlayStackOpen 延迟取 overlayStack（保持本文件对 core 的依赖只有 icons/form-controls/grid/model）
    function overlayStackOpen(opts) {
        return deps.overlayStack.open(opts);
    }

    // confirmAndApply 命令预览弹层（§5.4「编辑生成命令预览」）→ 确认后 DBRedisApply
    function confirmAndApply(ops) {
        const panel = document.createElement('div');
        panel.className = 'db-preview db-redis-confirm';
        const headEl = document.createElement('div');
        headEl.className = 'db-preview-head';
        headEl.textContent = '提交修改（等价命令预览）';
        const bodyEl = document.createElement('div');
        bodyEl.className = 'db-preview-body db-redis-confirm-body';
        for (const op of ops) {
            for (const line of redisOpCommandPreview(op)) {
                const code = document.createElement('code');
                code.className = 'db-redis-cmd';
                code.textContent = line;
                bodyEl.appendChild(code);
            }
        }
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'db-btn primary';
        okBtn.textContent = '确认提交';
        foot.append(cancelBtn, okBtn);
        panel.append(headEl, bodyEl, foot);

        const mask = document.createElement('div');
        mask.className = 'db-preview-mask';
        mask.appendChild(panel);
        let handle = null;
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            mask.remove();
            panel.remove();
        };
        const close = () => {
            if (cleaned) return;
            if (handle) handle.dispose();
            cleanup();
        };
        handle = overlayStackOpen({
            id: 'db-redis-apply-preview',
            kind: 'dialog',
            el: panel,
            underEl: mask,
            onClose: () => {
                if (handle) handle.dispose();
                cleanup();
            },
        });
        document.body.appendChild(mask);
        mask.addEventListener('click', (ev) => {
            if (ev.target === mask) close();
        });
        cancelBtn.addEventListener('click', close);
        okBtn.addEventListener('click', async () => {
            close();
            try {
                const out = await backend.DBRedisApply(session.id, ops);
                if (deps.logActivity) {
                    deps.logActivity('db.redis.apply', session.name || 'redis', {kind: 'redis', key, ops: ops.length});
                }
                deps.flash('已提交 ' + ops.length + ' 条操作');
                const failed = (out.rows || []).filter((r) => r[1] && r[1] !== 'OK');
                if (failed.length) deps.flash(failed.map((r) => r[0] + '：' + r[1]).join('；'), true);
                await load();
            } catch (e) {
                if (isSessionError(e)) return;
                deps.flash('提交失败：' + (e && e.message || e), true);
            }
        });
    }

    // ---------- string 编辑器（editable） ----------

    function openStringEditor(v) {
        const editor = createTextarea({rows: 12, value: v.text || '', spellcheck: false});
        editor.control.className = 'dlg-input db-redis-editarea';
        const panel = document.createElement('div');
        panel.className = 'db-preview db-redis-stredit';
        const headEl = document.createElement('div');
        headEl.className = 'db-preview-head';
        headEl.textContent = '编辑 string · ' + key + (v.truncated ? '（截断预览——保存会以编辑框内容整值覆盖）' : '');
        const bodyEl = document.createElement('div');
        bodyEl.className = 'db-preview-body db-redis-confirm-body';
        bodyEl.appendChild(editor.element);
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'db-btn primary';
        saveBtn.textContent = '保存…';
        foot.append(cancelBtn, saveBtn);
        panel.append(headEl, bodyEl, foot);

        const mask = document.createElement('div');
        mask.className = 'db-preview-mask';
        mask.appendChild(panel);
        let handle = null;
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            mask.remove();
            panel.remove();
        };
        const close = () => {
            if (cleaned) return;
            if (handle) handle.dispose();
            cleanup();
        };
        handle = overlayStackOpen({
            id: 'db-redis-stredit',
            kind: 'dialog',
            el: panel,
            underEl: mask,
            onClose: () => {
                if (handle) handle.dispose();
                cleanup();
            },
        });
        document.body.appendChild(mask);
        mask.addEventListener('click', (ev) => {
            if (ev.target === mask) close();
        });
        cancelBtn.addEventListener('click', close);
        saveBtn.addEventListener('click', () => {
            const next = editor.control.value;
            close();
            // SET 会清 TTL：携带原 TTL（>0 → EXPIRE 补回；-1 永久无需补偿）
            confirmAndApply([{kind: 'setString', Key: key, Value: next, TTLSeconds: value ? value.ttl : -1}]);
        });
    }

    // ---------- TTL 修改 / 删除键 ----------

    ttlBtn.element.addEventListener('click', () => {
        if (!value) return;
        const cur = value.ttl;
        const panel = document.createElement('div');
        panel.className = 'db-preview db-redis-confirm';
        const headEl = document.createElement('div');
        headEl.className = 'db-preview-head';
        headEl.textContent = '修改 TTL · ' + key;
        const bodyEl = document.createElement('div');
        bodyEl.className = 'db-preview-body db-redis-confirm-body';
        const ttlInput = createInput({type: 'number', value: cur > 0 ? cur : -1, min: -1});
        const line = document.createElement('div');
        line.className = 'db-conn-rowline';
        const label = document.createElement('span');
        label.className = 'db-conn-label';
        label.textContent = '秒数（-1 = 永久）';
        line.append(label, ttlInput.element);
        const persistBtn = document.createElement('button');
        persistBtn.type = 'button';
        persistBtn.className = 'db-btn';
        persistBtn.textContent = 'PERSIST（改为永久）';
        bodyEl.append(line, persistBtn);
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'db-btn primary';
        okBtn.textContent = '应用';
        foot.append(cancelBtn, okBtn);
        panel.append(headEl, bodyEl, foot);

        const mask = document.createElement('div');
        mask.className = 'db-preview-mask';
        mask.appendChild(panel);
        let handle = null;
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            mask.remove();
            panel.remove();
        };
        const close = () => {
            if (cleaned) return;
            if (handle) handle.dispose();
            cleanup();
        };
        handle = overlayStackOpen({
            id: 'db-redis-ttl',
            kind: 'dialog',
            el: panel,
            underEl: mask,
            onClose: () => {
                if (handle) handle.dispose();
                cleanup();
            },
        });
        document.body.appendChild(mask);
        mask.addEventListener('click', (ev) => {
            if (ev.target === mask) close();
        });
        cancelBtn.addEventListener('click', close);
        persistBtn.addEventListener('click', () => {
            close();
            confirmAndApply([{kind: 'persist', Key: key}]);
        });
        okBtn.addEventListener('click', () => {
            const raw = String(ttlInput.control.value).trim();
            if (raw === '') {
                deps.flash('请输入 ≥ -1 的整数秒数（-1 = 永久，0 = 删除）', true);
                return;
            }
            const n = Math.floor(Number(raw));
            const action = redisTTLDraftAction(n);
            if (action === 'invalid') {
                deps.flash('请输入 ≥ -1 的整数秒数（-1 = 永久，0 = 删除）', true);
                return;
            }
            if (action === 'delete' && typeof deps.openConfirmDialog !== 'function') {
                deps.flash('当前环境无法确认删除操作', true);
                return;
            }
            close();
            if (action === 'delete') {
                deps.openConfirmDialog(
                    'TTL 设为 0 会立即删除键「' + key + '」，此操作不可撤销。',
                    async () => { await confirmAndApply([{kind: 'delKey', Key: key}]); },
                    '删除', 'TTL 设为 0 将删除键？',
                );
                return;
            }
            confirmAndApply([{kind: action === 'persist' ? 'persist' : 'setTTL', Key: key, TTLSeconds: n}]);
        });
    });

    delBtn.element.addEventListener('click', () => {
        if (!deps.openConfirmDialog) return;
        deps.openConfirmDialog(
            '键「' + key + '」将被 DEL 删除，此操作不可撤销。',
            async () => {
                try {
                    await backend.DBRedisApply(session.id, [{kind: 'delKey', Key: key}]);
                    deps.flash('已删除键：' + key);
                    if (deps.onKeyDeleted) deps.onKeyDeleted();
                } catch (e) {
                    deps.flash('删除失败：' + (e && e.message || e), true);
                }
            },
            '删除',
            '删除 Redis 键？',
            'danger',
        );
    });

    refreshBtn.element.addEventListener('click', () => load());

    load();

    return {
        el,
        refresh: () => load(),
        dispose() {}, // 会话订阅由 db-tab-views 的壳管理；这里无自有监听
    };
}
