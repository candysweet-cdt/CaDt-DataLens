// .patch / .diff 的结构化补丁视图：
// 文件卡 + hunk 高亮 + 预检状态 + 应用（整体成功 / 允许部分成功）+ 撤销。
// 另有「只读审阅」模式（doc.patchReview）：复用同一套文件卡 / hunk 渲染，
// 但走 PatchParseText 纯解析——不做预检、不生成计划、没有应用 / 撤销 / 目标目录。
// 所有解析与写入都走 Go 侧（PatchParseText / PatchPreviewFile / PatchApply / PatchRevert），
// 本模块只负责渲染与交互，不重复实现补丁逻辑。

import {createCheckbox, createSelect} from '../core/form-controls.js';
import {el} from '../core/dom.js';
import {isTabReadOnlyFixed, isTabReadOnlyLocked} from '../core/readonly.js';

const MODE_ATOMIC = 'atomic';
const MODE_PARTIAL = 'partial';

const STATUS_LABEL = {
    ok: '可应用',
    conflict: '冲突',
    blocked: '不可用',
    unsupported: '不支持',
    missing: '文件缺失',
};

// ===== 补丁视图状态与工具 =====
function formatCount(n) {
    return n > 0 ? '+' + n : '0';
}

function suggestFor(file) {
    const reason = String((file && file.reason) || '');
    if (file.status === 'conflict') {
        if (reason.includes('生成后被修改')) return '重新生成补丁，或先手工合并该文件的改动';
        return '打开目标文件核对上下文后重新生成这一处，或取消勾选它';
    }
    if (file.status === 'blocked') {
        if (reason.includes('已存在')) return '比较两者内容后决定保留哪个（不会自动覆盖）';
        if (reason.includes('不存在')) return '确认路径是否正确，或改用「新建文件」补丁';
        if (reason.includes('符号链接')) return '该文件是链接，请手工处理';
        return '按提示修正路径或权限后重试';
    }
    if (file.status === 'unsupported') return '拆成「删除旧文件 + 新建文件」两步文本操作';
    return '';
}

// 视图状态挂在 doc 上，切换标签页后仍能复用（不重复请求后端）
export function patchViewState(doc) {
    if (!doc.patchState) {
        doc.patchState = {
            el: null,
            plan: null,
            mode: MODE_ATOMIC,
            selected: new Set(),
            collapsed: new Set(),
            result: null,
            loading: false,
            error: '',
            expanded: new Set(),
            root: '',
            ignoreWhitespace: false,
            allowOffset: false,
            // 只读审阅快照（doc.patchReview）：硬只读、不可解锁，永久走纯 diff 展示。
            // 标签只读锁（readOnlyFixed/readOnlyLocked）可随时开关，不缓存，每轮经 plainDiff() 重算。
            review: !!doc.patchReview,
            reviewNotes: Array.isArray(doc.reviewNotes) ? doc.reviewNotes : [],
        };
    }
    return doc.patchState;
}

// 补丁视图是否退化为纯 diff 展示（不预检、不报红、不显示应用入口）。
// 两条来源：审阅快照（硬只读，缓存在 st.review）与标签只读锁（可随时开关，每轮重算）。
function plainDiff(doc, st) {
    return !!(st.review || doc.readOnlyFixed || doc.readOnlyLocked);
}

export function disposePatchView(doc) {
    const st = doc.patchState;
    if (st && st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
    if (doc) doc.patchState = null;
}

export function showPatchView(doc, ctx) {
    if (!doc || !doc.pane || !doc.format || !doc.format.patch) return;
    const st = patchViewState(doc);
    if (!st.el) {
        st.el = el('div', 'patch-view' + (doc.patchReview ? ' patch-review' : ''));
        doc.pane.appendChild(st.el);
    }
    doc.pane.classList.add('patch-active');
    doc.pane.classList.toggle('patch-review', !!doc.patchReview);
    render(doc, ctx);
    if (!st.plan && !st.loading) loadPreview(doc, ctx);
}

export function hidePatchView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('patch-active');
}

export async function refreshPatchView(doc, ctx) {
    const st = patchViewState(doc);
    st.plan = null;
    await loadPreview(doc, ctx);
}

// ===== 补丁预览加载 =====
// 虚拟 diff 文档在 createDocEditor 完成后 doc.content 会被清空，刷新时仍要能取到原文。
function patchTextOf(doc) {
    if (!doc) return '';
    if (doc.content != null) return String(doc.content);
    if (doc.text != null) return String(doc.text);
    try {
        return doc.editor ? String(doc.editor.getText() || '') : '';
    } catch (e) {
        return '';
    }
}

// 只读审阅只保留展示字段：预检状态 / 原因 / 落点 / 计划 ID 一律不进入视图状态，
// 免得任何路径（包括 app_control 的 get_patch 快照）把它当成可应用的补丁。
function sanitizeReviewPlan(plan) {
    if (!plan) return {files: [], added: 0, removed: 0};
    return {
        files: (plan.files || []).map((f) => ({
            relPath: f.relPath || '',
            kind: f.kind || '',
            added: f.added || 0,
            removed: f.removed || 0,
            hunks: (f.hunks || []).map((h) => ({
                header: h.header || '',
                oldStart: h.oldStart || 0,
                newStart: h.newStart || 0,
                lines: (h.lines || []).map((l) => ({
                    t: l.t || ' ',
                    text: l.text == null ? '' : l.text,
                    oldLine: l.oldLine || 0,
                    newLine: l.newLine || 0,
                })),
            })),
        })),
        added: plan.added || 0,
        removed: plan.removed || 0,
    };
}

async function loadPreview(doc, ctx, options) {
    const st = patchViewState(doc);
    const opts = options || {};
    if (plainDiff(doc, st)) {
        st.loading = true;
        st.error = '';
        render(doc, ctx);
        try {
            const text = patchTextOf(doc);
            let plan = null;
            if (String(text).trim()) {
                if (typeof ctx.backend.PatchParseText === 'function') {
                    plan = await ctx.backend.PatchParseText(text);
                } else if (typeof ctx.backend.PatchPreviewText === 'function') {
                    // 旧后端回退：同样只取展示字段，不带预检结果进视图
                    plan = await ctx.backend.PatchPreviewText(text, ctx.getRoot ? ctx.getRoot() : '');
                } else {
                    throw new Error('当前运行环境没有补丁解析能力（需要桌面版后端）');
                }
            }
            st.plan = sanitizeReviewPlan(plan);
            st.selected = new Set();
            st.result = null;
        } catch (e) {
            st.plan = null;
            st.error = String((e && e.message) || e);
        } finally {
            st.loading = false;
            render(doc, ctx);
        }
        return;
    }
    if (opts.root) st.root = opts.root;
    if (typeof opts.ignoreWhitespace === 'boolean') st.ignoreWhitespace = opts.ignoreWhitespace;
    if (typeof opts.allowOffset === 'boolean') st.allowOffset = opts.allowOffset;
    const canRepreview = st.plan && st.plan.planId && !opts.root;
    st.loading = true;
    st.error = '';
    render(doc, ctx);
    try {
        let plan;
        if (canRepreview) {
            plan = await ctx.backend.PatchRepreview(st.plan.planId, st.allowOffset, st.ignoreWhitespace);
        } else if (!doc.path && String(patchTextOf(doc)).trim() && /\.(diff|patch)$/i.test(doc.name || '')) {
            // 虚拟 diff 文档（AI 审阅 / Git 差异拼接）：path 为空、内容即补丁文本，
            // 走文本预览（不落盘），否则会掉进「缺少补丁文件路径」
            const root = st.root || ctx.getRoot();
            plan = await ctx.backend.PatchPreviewText(patchTextOf(doc), root);
            if (st.ignoreWhitespace || st.allowOffset) {
                plan = await ctx.backend.PatchRepreview(plan.planId, st.allowOffset, st.ignoreWhitespace);
            }
        } else {
            const root = st.root || ctx.getRoot();
            plan = await ctx.backend.PatchPreviewFile(doc.path, root);
            if (st.ignoreWhitespace || st.allowOffset) {
                plan = await ctx.backend.PatchRepreview(plan.planId, st.allowOffset, st.ignoreWhitespace);
            }
        }
        st.plan = plan;
        st.root = plan.root || st.root;
        st.selected = new Set((plan.files || []).filter((f) => f.status === 'ok').map((f) => f.relPath));
        st.result = null;
    } catch (e) {
        st.plan = null;
        st.error = String((e && e.message) || e);
    } finally {
        st.loading = false;
        render(doc, ctx);
    }
}

async function chooseTargetRoot(doc, ctx, plan) {
    const current = (plan && plan.root) || ctx.getRoot() || '';
    let picked = '';
    try {
        picked = await ctx.chooseFolder(current);
    } catch (e) {
        ctx.flash('选择目标目录失败：' + ((e && e.message) || e), true);
        return;
    }
    if (!picked || (current && picked.toLowerCase() === current.toLowerCase())) return;
    await loadPreview(doc, ctx, {root: picked});
}

// ===== 视图渲染 =====
function render(doc, ctx) {
    const st = patchViewState(doc);
    const host = st.el;
    if (!host) return;
    host.replaceChildren();

    const plan = st.plan;
    const review = !!st.review;
    const plain = plainDiff(doc, st);  // 纯 diff 模式：审阅快照 + 标签只读锁
    const bar = el('div', 'patch-bar');
    const title = el('div', 'patch-title');
    title.appendChild(el('span', 'patch-name', doc.name || '补丁'));
    if (plan && plan.patchPath) title.dataset.tip = plan.patchPath;
    const stats = el('span', 'patch-stats');
    if (plan) {
        stats.appendChild(el('span', 'patch-add', '+' + plan.added));
        stats.appendChild(el('span', 'patch-del', '−' + plan.removed));
    }
    title.appendChild(stats);
    if (review) title.appendChild(el('span', 'patch-tag', '只读快照'));
    else if (plain) title.appendChild(el('span', 'patch-tag', '只读'));
    else if (plan && plan.external) title.appendChild(el('span', 'patch-tag', '外部补丁'));
    bar.appendChild(title);

    const actions = el('div', 'patch-actions');
    // 只读开关：常显（开只读后应用行会整块隐藏，开关必须留在外面才关得掉）。
    // 审阅快照是硬只读，不给开关。
    if (!review) {
        const locked = isTabReadOnlyLocked(doc);
        const ro = createCheckbox({
            checked: locked,
            label: '只读',
            title: locked ? '取消只读，恢复预检与应用入口' : '只读：不预检、不报红，只按 diff 展示',
            onChange: () => ctx.setDocReadOnly(doc, !isTabReadOnlyLocked(doc)),
        });
        if (isTabReadOnlyFixed(doc)) ro.control.disabled = true;
        ro.element.classList.add('patch-readonly-toggle');
        actions.appendChild(ro.element);
    }
    let modeSelectEl = null;
    if (plan && !plain) {
        const modeWrap = el('label', 'patch-mode');
        modeWrap.appendChild(el('span', 'patch-mode-label', '应用模式'));
        const mode = createSelect({
            className: 'patch-mode-select',
            options: [
                {value: MODE_ATOMIC, label: '整体成功', selected: st.mode === MODE_ATOMIC},
                {value: MODE_PARTIAL, label: '允许部分成功', selected: st.mode === MODE_PARTIAL},
            ],
            onChange: () => {
                st.mode = mode.control.value;
                render(doc, ctx);
            },
        });
        modeWrap.appendChild(mode.element);
        actions.appendChild(modeWrap);
        modeSelectEl = mode.control;

        const revertable = !!plan.patchId && !plan.external;
        const btnRevert = el('button', 'dlg-btn', '撤销');
        btnRevert.type = 'button';
        btnRevert.disabled = !revertable;
        btnRevert.addEventListener('click', () => {
            // 与其他破坏性操作一致：走统一确认弹窗，不做「再点一次按钮」的就地确认
            ctx.openConfirmDialog(
                '撤销这次补丁应用？已写入的文件会恢复到应用前的内容。',
                () => revert(doc, ctx),
                '撤销',
                '撤销补丁',
                'danger'
            );
        });
        actions.appendChild(btnRevert);

        const btnApply = el('button', 'dlg-btn primary', applyLabel(st));
        btnApply.type = 'button';
        btnApply.disabled = !canApply(st);
        btnApply.addEventListener('click', () => apply(doc, ctx));
        actions.appendChild(btnApply);
    }
    bar.appendChild(actions);
    const head = el('div', 'patch-head');
    head.appendChild(bar);
    host.appendChild(head);
    // 去掉浏览器原生下拉外观：设置页同款触发器 + 浮层（原生 select 仍是值真源）。
    // 必须在 append 进 DOM 之后调，增强器要读布局算浮层位置。
    if (modeSelectEl && typeof ctx.enhanceSelect === 'function') ctx.enhanceSelect(modeSelectEl);

    if (plan && !plain) {
        const toolbar = el('div', 'patch-subbar');
        const rootWrap = el('span', 'patch-root-wrap');
        rootWrap.appendChild(el('span', 'patch-root-label', '目标：'));
        const rootBtn = el('button', 'patch-link patch-root', plan.root || '（未选择）');
        rootBtn.type = 'button';
        rootBtn.addEventListener('click', () => chooseTargetRoot(doc, ctx, plan));
        rootWrap.appendChild(rootBtn);
        const btnRoot = el('button', 'patch-link', '更改…');
        btnRoot.type = 'button';
        btnRoot.addEventListener('click', () => chooseTargetRoot(doc, ctx, plan));
        rootWrap.appendChild(btnRoot);
        toolbar.appendChild(rootWrap);
        const ws = el('label', 'patch-opt');
        const wsBox = document.createElement('input');
        wsBox.type = 'checkbox';
        wsBox.checked = st.ignoreWhitespace;
        wsBox.addEventListener('change', () => {
            loadPreview(doc, ctx, {ignoreWhitespace: wsBox.checked, allowOffset: wsAllow.checked});
        });
        ws.append(wsBox, document.createTextNode(' 忽略行尾空白'));
        const wsAllowLabel = el('label', 'patch-opt');
        const wsAllow = document.createElement('input');
        wsAllow.type = 'checkbox';
        wsAllow.checked = st.allowOffset;
        wsAllow.addEventListener('change', () => {
            loadPreview(doc, ctx, {ignoreWhitespace: wsBox.checked, allowOffset: wsAllow.checked});
        });
        wsAllowLabel.append(wsAllow, document.createTextNode(' 允许上下文位移'));
        toolbar.append(ws, wsAllowLabel);
        const btnReload = el('button', 'patch-link', '重新预检');
        btnReload.type = 'button';
        btnReload.addEventListener('click', () => loadPreview(doc, ctx, {root: plan.root || st.root}));
        toolbar.appendChild(btnReload);
        head.appendChild(toolbar);
        if (!st.loading && plan.suggestedRoot && plan.suggestedRoot !== plan.root) {
            host.appendChild(renderRootSuggestion(doc, ctx, plan));
        }
    }

    if (st.loading) {
        host.appendChild(el('div', 'patch-note', plain ? '正在解析差异…' : '正在预检…'));
        return;
    }
    if (st.error) {
        const box = el('div', 'patch-error');
        box.appendChild(el('div', 'patch-error-title', plain ? '无法解析该差异' : '无法解析该补丁'));
        box.appendChild(el('pre', 'patch-error-detail', st.error));
        host.appendChild(box);
        return;
    }
    if (!plan) return;

    if (review) {
        if (st.reviewNotes.length) {
            const notes = el('div', 'patch-review-notes');
            notes.appendChild(el('div', 'patch-note', '以下文件没有可展示的 Git 差异：'));
            for (const note of st.reviewNotes) notes.appendChild(el('div', 'patch-note', '· ' + note));
            host.appendChild(notes);
        }
        if (!(plan.files || []).length) {
            host.appendChild(el('div', 'patch-note', '本轮改动没有可展示的 Git 差异（文件可能未被 Git 跟踪）。'));
        }
    } else if (!plain && !(plan.files || []).some((f) => f.status === 'ok')) {
        host.appendChild(el('div', 'patch-note warn', '没有可直接应用的文件：请按下方原因处理后重新预检。'));
    }

    if (!plain && st.result) host.appendChild(renderResult(st.result));

    const list = el('div', 'patch-files');
    for (const file of plan.files || []) {
        list.appendChild(renderFile(doc, ctx, file, st, review, plain));
    }
    host.appendChild(list);

    if (!plain) {
        const hint = el('div', 'patch-footnote', '应用是两阶段操作：先预检，再写入；写入前会把原始文件备份到 .cadt/patches/backup/，可随时撤销。');
        host.appendChild(hint);
    }
}

// ===== 应用状态与快照 =====
function applyLabel(st) {
    const count = st.selected.size;
    if (st.mode === MODE_PARTIAL) {
        return count > 0 ? `应用（${count} 个，失败跳过）` : '应用';
    }
    return count > 0 ? `应用选中（${count}）` : '应用';
}

function canApply(st) {
    if (!st.plan || st.loading) return false;
    if (st.selected.size === 0) return false;
    if (st.mode === MODE_ATOMIC) {
        // 整体成功：选中集合里不能有不可应用的文件
        return (st.plan.files || []).every((f) => !st.selected.has(f.relPath) || f.status === 'ok');
    }
    return true;
}

// 给 app_control 的只读快照：补丁目标、逐文件状态/失败原因、建议目录与最近一次结果。
export function patchViewSnapshot(doc) {
    const st = doc && doc.patchState;
    if (!st) return null;
    const plan = st.plan;
    if (st.review) {
        // 只读审阅：只回展示数据，不暴露 applicable / mode / selected / root / planId 等应用语义
        return {
            loaded: !!plan,
            loading: !!st.loading,
            error: st.error || '',
            review: true,
            name: (doc && doc.name) || '',
            added: plan ? (plan.added || 0) : 0,
            removed: plan ? (plan.removed || 0) : 0,
            notes: (st.reviewNotes || []).slice(),
            files: (plan ? plan.files || [] : []).map((f) => ({
                relPath: f.relPath || '',
                kind: f.kind || '',
                added: f.added || 0,
                removed: f.removed || 0,
                hunks: (f.hunks || []).map((h) => ({header: h.header || ''})),
            })),
        };
    }
    if (!plan) {
        return {
            loaded: false,
            loading: !!st.loading,
            error: st.error || '',
            patchPath: (doc && doc.path) || '',
        };
    }
    const out = {
        loaded: true,
        name: doc.name || '',
        patchPath: plan.patchPath || doc.path || '',
        root: plan.root || '',
        summary: plan.summary || '',
        patchId: plan.patchId || '',
        external: !!plan.external,
        mode: st.mode || '',
        selected: Array.from(st.selected || []),
        added: plan.added || 0,
        removed: plan.removed || 0,
        applicable: !!plan.applicable,
        files: (plan.files || []).map((f) => ({
            relPath: f.relPath || '',
            kind: f.kind || '',
            status: f.status || '',
            reason: f.reason || '',
            added: f.added || 0,
            removed: f.removed || 0,
            hunks: (f.hunks || []).map((h) => ({
                header: h.header || '',
                status: h.status || '',
                reason: h.reason || '',
                applyAtLine: h.applyAtLine || 0,
            })),
        })),
    };
    if (plan.suggestedRoot) {
        out.suggestedRoot = plan.suggestedRoot;
        out.suggestedHits = plan.suggestedHits || 0;
        out.suggestedNeeded = plan.suggestedNeeded || 0;
    }
    if (st.result) {
        out.result = {
            ok: !!st.result.ok,
            mode: st.result.mode || '',
            applied: st.result.applied || 0,
            skipped: st.result.skipped || 0,
            message: st.result.message || '',
        };
    }
    return out;
}

// ===== 目标根与重预览 =====
function isAbsolutePath(text) {
    return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(text);
}

export async function setPatchTargetRoot(doc, ctx, root) {
    if (doc && doc.patchReview) throw new Error('只读审阅文档不支持设置目标目录');
    let target = String(root == null ? '' : root).trim();
    if (!target) throw new Error('root 不能为空');
    if (!isAbsolutePath(target)) {
        const base = ctx.getRoot();
        if (!base) throw new Error('未打开工作区，请传绝对路径');
        target = String(base).replace(/[\\/]+$/, '') + '/' + target.replace(/\\/g, '/');
    }
    await loadPreview(doc, ctx, {root: target});
    const st = patchViewState(doc);
    if (st.error) throw new Error(st.error);
    if (!st.plan) throw new Error('补丁预览失败');
    return patchViewSnapshot(doc);
}

export async function repreviewPatchView(doc, ctx, options) {
    if (doc && doc.patchReview) throw new Error('只读审阅文档不做预检');
    const opts = options || {};
    await loadPreview(doc, ctx, {
        ignoreWhitespace: typeof opts.ignoreWhitespace === 'boolean' ? opts.ignoreWhitespace : undefined,
        allowOffset: typeof opts.allowOffset === 'boolean' ? opts.allowOffset : undefined,
    });
    const st = patchViewState(doc);
    if (st.error) throw new Error(st.error);
    if (!st.plan) throw new Error('补丁预览失败');
    return patchViewSnapshot(doc);
}

function renderRootSuggestion(doc, ctx, plan) {
    const box = el('div', 'patch-suggest');
    const left = el('div', 'patch-suggest-left');
    left.appendChild(el('span', 'patch-suggest-text', '目标目录可能不对：'));
    const pathBtn = el('button', 'patch-link patch-suggest-path', plan.suggestedRoot);
    pathBtn.type = 'button';
    pathBtn.dataset.tip = plan.suggestedRoot;
    pathBtn.addEventListener('click', () => loadPreview(doc, ctx, {root: plan.suggestedRoot}));
    left.appendChild(pathBtn);
    box.appendChild(left);
    const right = el('div', 'patch-suggest-right');
    right.appendChild(el('span', 'patch-suggest-hits', '命中 ' + plan.suggestedHits + '/' + plan.suggestedNeeded + ' 个目标文件。'));
    const use = el('button', 'patch-link patch-suggest-use', '使用该目录');
    use.type = 'button';
    use.addEventListener('click', () => loadPreview(doc, ctx, {root: plan.suggestedRoot}));
    right.appendChild(use);
    box.appendChild(right);
    return box;
}

// ===== 差异渲染 =====
function renderFile(doc, ctx, file, st, review, plain) {
    const card = el('div', 'patch-file ' + (plain ? '' : (file.status || '')));
    const head = el('div', 'patch-file-head');
    if (!plain) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'patch-file-check';
        box.checked = st.selected.has(file.relPath);
        box.disabled = file.status !== 'ok' && st.mode === MODE_ATOMIC;
        box.addEventListener('change', () => {
            if (box.checked) st.selected.add(file.relPath);
            else st.selected.delete(file.relPath);
            render(doc, ctx);
        });
        head.appendChild(box);
    }

    const pathWrap = el('div', 'patch-file-path');
    const link = el('button', 'patch-link patch-path-link', file.relPath);
    link.type = 'button';
    link.dataset.tip = '在编辑器中打开该文件';
    link.addEventListener('click', () => ctx.openPath(file.relPath));
    pathWrap.appendChild(link);
    if (file.kind === 'add') pathWrap.appendChild(el('span', 'patch-tag', '新建'));
    if (file.kind === 'delete') pathWrap.appendChild(el('span', 'patch-tag danger', '删除'));
    head.appendChild(pathWrap);

    const stat = el('span', 'patch-file-stat');
    stat.append(el('span', 'patch-add', formatCount(file.added)), el('span', 'patch-del', '−' + file.removed));
    head.appendChild(stat);
    if (!plain) head.appendChild(el('span', 'patch-file-status ' + (file.status || ''), STATUS_LABEL[file.status] || file.status));

    const fold = el('button', 'patch-fold', st.collapsed.has(file.relPath) ? '展开' : '收起');
    fold.type = 'button';
    fold.addEventListener('click', () => {
        if (st.collapsed.has(file.relPath)) st.collapsed.delete(file.relPath);
        else st.collapsed.add(file.relPath);
        render(doc, ctx);
    });
    head.appendChild(fold);
    card.appendChild(head);

    if (!plain && file.reason) {
        const reason = el('div', 'patch-file-reason', file.reason);
        card.appendChild(reason);
        const fix = suggestFor(file);
        if (fix && file.status !== 'ok') card.appendChild(el('div', 'patch-file-hint', '→ ' + fix));
    }

    if (!st.collapsed.has(file.relPath)) {
        const body = el('div', 'patch-hunks');
        const expanded = st.expanded.has(file.relPath);
        let budget = expanded ? 1e9 : 400;
        for (const hunk of file.hunks || []) {
            if (budget <= 0) {
                body.appendChild(el('div', 'patch-note', '…内容较多，点击「展开」查看全部'));
                break;
            }
            body.appendChild(renderHunk(doc, ctx, hunk, file, st, review, plain));
            budget -= (hunk.lines || []).length + 1;
        }
        if (!expanded && budget <= 0) {
            const more = el('button', 'patch-link', '展开全部');
            more.type = 'button';
            more.addEventListener('click', () => {
                st.expanded.add(file.relPath);
                render(doc, ctx);
            });
            body.appendChild(more);
        }
        card.appendChild(body);
    }
    return card;
}

function renderHunk(doc, ctx, hunk, file, st, review, plain) {
    const wrap = el('div', 'patch-hunk ' + (plain ? '' : (hunk.status || '')));
    const head = el('div', 'patch-hunk-head');
    head.appendChild(el('span', 'patch-hunk-range', hunk.header || `@@ -${hunk.oldStart} +${hunk.newStart} @@`));
    if (!plain && hunk.status === 'ok' && hunk.applyAtLine) {
        head.appendChild(el('span', 'patch-hunk-at', '落到第 ' + hunk.applyAtLine + ' 行'));
    }
    if (!plain && hunk.status !== 'ok' && hunk.reason) {
        head.appendChild(el('span', 'patch-hunk-reason', hunk.reason));
    }
    wrap.appendChild(head);
    for (const line of hunk.lines || []) {
        const row = el('div', 'patch-line ' + (line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'ctx'));
        row.appendChild(el('span', 'patch-no', line.t === '-' ? String(line.oldLine || '') : String(line.newLine || '')));
        row.appendChild(el('span', 'patch-sign', line.t === ' ' ? '' : line.t));
        row.appendChild(el('span', 'patch-text', line.text == null ? '' : line.text));
        wrap.appendChild(row);
    }
    return wrap;
}

function renderResult(result) {
    const box = el('div', 'patch-result ' + (result.ok ? 'ok' : 'fail'));
    const head = el('div', 'patch-result-title');
    if (result.ok) {
        head.textContent = `已应用 ${result.applied} 个文件` + (result.skipped ? `，跳过 ${result.skipped} 个` : '');
    } else if (result.applied > 0) {
        head.textContent = `已应用 ${result.applied} 个文件，跳过 ${result.skipped} 个`;
    } else {
        head.textContent = '未应用任何更改';
    }
    box.appendChild(head);
    if (result.message) box.appendChild(el('div', 'patch-result-msg', result.message));
    for (const f of result.files || []) {
        const row = el('div', 'patch-result-row');
        const label = {applied: '✓', skipped: '⚠', failed: '✗', notapplied: '·'}[f.status] || '·';
        row.appendChild(el('span', 'patch-result-mark ' + f.status, label));
        row.appendChild(el('span', 'patch-result-path', f.relPath));
        if (f.reason) row.appendChild(el('span', 'patch-result-reason', f.reason));
        box.appendChild(row);
    }
    if (result.unrestored && result.unrestored.length) {
        box.appendChild(el('div', 'patch-result-msg danger', '有文件未能恢复，请用备份手工覆盖：' + result.unrestored.join('、')));
        if (result.backupDir) box.appendChild(el('div', 'patch-result-msg', '备份目录：' + result.backupDir));
    }
    if (result.revertId) {
        box.appendChild(el('div', 'patch-result-msg', '可点顶部「撤销」回退本次应用。'));
    }
    return box;
}

// ===== 应用与回退 =====
async function apply(doc, ctx) {
    const st = patchViewState(doc);
    if (st.review || !st.plan || !canApply(st)) return;
    const root = st.plan.root;
    const files = Array.from(st.selected);
    try {
        const result = await ctx.backend.PatchApply(st.plan.planId, files, null, st.mode);
        st.result = result;
        if (result && result.applied > 0) ctx.notifyChanged(files);
        // 完整重检一次：应用后索引里已有记录，能找回补丁 ID 让「撤销」可用
        await loadPreview(doc, ctx, {root});
        st.result = result;
        st.plan = st.plan;
        render(doc, ctx);
    } catch (e) {
        st.error = String((e && e.message) || e);
        render(doc, ctx);
    }
}

async function revert(doc, ctx) {
    const st = patchViewState(doc);
    if (st.review || !st.plan || !st.plan.patchId) return;
    try {
        const res = await ctx.backend.PatchRevert(st.plan.patchId, st.plan.root, 'abort');
        if (!res || !res.ok) {
            st.error = (res && res.message) || '撤销失败';
        } else {
            st.error = '';
            ctx.notifyChanged(res.files || []);
        }
        await loadPreview(doc, ctx);
    } catch (e) {
        st.error = String((e && e.message) || e);
        render(doc, ctx);
    }
}

// 供 AI 审批卡复用：把后端结果渲染成一段纯文本摘要（不依赖 DOM）
export function summarizePatchResult(result) {
    if (!result) return '';
    const lines = [];
    lines.push(`【patch:result】mode=${result.mode || 'atomic'} applied=${result.applied || 0} skipped=${result.skipped || 0} added=${result.added || 0} removed=${result.removed || 0}`);
    for (const f of result.files || []) {
        const label = {applied: '已应用', skipped: '已跳过', failed: '失败', notapplied: '未执行'}[f.status] || f.status;
        lines.push(`${label}：${f.relPath}` + (f.reason ? `（${f.reason}）` : ''));
    }
    if (result.message) lines.push(result.message);
    return lines.join('\n');
}
