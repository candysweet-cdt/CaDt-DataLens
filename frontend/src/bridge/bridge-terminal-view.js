// bridge-terminal-view.js：后台终端标签页视图：AI background_command 作业在内容区的只读视图。
// 从 bridge-ui.js 拆出；依赖仍经 deps 延迟求值，不持有宿主状态。
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';
import {kvGet, kvSet} from '../core/kv-store.js';
import {BGTERM_SPLIT_KEY} from '../core/storage-keys.js';
export function createBridgeTerminalView(deps) {

// ===== 后台终端标签页（AI background_command 作业在内容区的视图）=====
// 数据来自 aiPanel 桥接（bridgeBgJob / bridgeOnBgUpdate / bridgeStopBgJob）；
// 上栏命令信息、下栏实时输出，中间分割线可拖拽（比例存 localStorage）；关闭标签不影响作业。
// 分割比例的 localStorage 键名来自 core/storage-keys.js。

function bgTermSplitRatio() {
    const raw = Number(kvGet(BGTERM_SPLIT_KEY));
    if (!Number.isFinite(raw) || raw < 0.15 || raw > 0.85) return 0.34;
    return raw;
}

function bgTermTabName(command) {
    const line = String(command || '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
    if (!line) return '后台终端';
    return line.length > 28 ? line.slice(0, 28) + '…' : line;
}

function openBgTermTab(info) {
    const jobId = String((info && info.jobId) || '');
    if (!jobId) return null;
    const existing = deps.docs.find((d) => d.bgTerm === jobId);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = createVirtualTabDoc({
        id: 'bgterm-' + jobId,
        name: bgTermTabName(info && info.command),
        format: {id: 'bgterm', name: '后台终端', extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'bgterm',
        marker: 'bgTerm',
        key: jobId,
        extra: {bgTermCommand: String((info && info.command) || '')},
    });
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

function bgTermStateLabel(state, code) {
    if (state === 'running') return '运行中';
    if (state === 'exited') return '已退出（' + (code == null ? '?' : code) + '）';
    if (state === 'stopped') return '已停止';
    if (state === 'notfound') return '不存在';
    return state || '未知';
}

function createBgTermView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active bgterm-pane';
    deps.els.editor.appendChild(pane);

    // 上栏：命令 + 元信息 + 停止
    const info = document.createElement('div');
    info.className = 'bgterm-info';
    const cmdRow = document.createElement('div');
    cmdRow.className = 'bgterm-cmd-row';
    const cmdLabel = document.createElement('span');
    cmdLabel.className = 'bgterm-label';
    cmdLabel.textContent = '命令';
    const cmd = document.createElement('pre');
    cmd.className = 'bgterm-cmd';
    cmd.textContent = doc.bgTermCommand || '（读取中…）';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'dlg-btn bgterm-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => deps.copyText(doc.bgTermCommand || '', '命令'));
    cmdRow.append(cmdLabel, cmd, copyBtn);

    const metaRow = document.createElement('div');
    metaRow.className = 'bgterm-meta-row';
    const stateBadge = document.createElement('span');
    stateBadge.className = 'bgterm-state';
    const metaText = document.createElement('span');
    metaText.className = 'bgterm-meta';
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'dlg-btn bgterm-stop';
    stopBtn.textContent = '停止';
    metaRow.append(stateBadge, metaText, stopBtn);
    info.append(cmdRow, metaRow);

    // 中间分割线：拖拽调整上下比例
    const split = document.createElement('div');
    split.className = 'bgterm-split';

    // 下栏：输出
    const out = document.createElement('pre');
    out.className = 'bgterm-out empty';
    out.textContent = '（暂无输出；作业产生输出后会实时显示在这里）';

    pane.append(info, split, out);
    doc.pane = pane;
    doc.bgTermEl = out;
    doc.bgTermStateEl = stateBadge;
    doc.bgTermMetaEl = metaText;

    doc.bgTermRatio = bgTermSplitRatio();
    info.style.flexBasis = (doc.bgTermRatio * 100) + '%';
    let dragging = false;
    const onMove = (e) => {
        if (!dragging || !pane.isConnected) return;
        const rect = pane.getBoundingClientRect();
        if (!rect.height) return;
        const ratio = Math.min(0.85, Math.max(0.15, (e.clientY - rect.top) / rect.height));
        doc.bgTermRatio = ratio;
        info.style.flexBasis = (ratio * 100) + '%';
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('bgterm-dragging');
        kvSet(BGTERM_SPLIT_KEY, String(doc.bgTermRatio)); // 存储不可用：会话内仍生效
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    split.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        document.body.classList.add('bgterm-dragging');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    stopBtn.addEventListener('click', async () => {
        if (!deps.aiPanel || !deps.aiPanel.bridgeStopBgJob) return deps.flash('当前版本不支持停止后台命令', true);
        stopBtn.disabled = true;
        try {
            await deps.aiPanel.bridgeStopBgJob(doc.bgTerm);
            deps.flash('已发送停止指令');
        } catch (e) {
            deps.flash('停止失败：' + ((e && e.message) || e), true);
        } finally {
            stopBtn.disabled = false;
        }
    });

    const render = () => {
        const snapshot = deps.aiPanel && deps.aiPanel.bridgeBgJob ? deps.aiPanel.bridgeBgJob(doc.bgTerm) : null;
        if (!snapshot) {
            stateBadge.textContent = '已丢失';
            stateBadge.className = 'bgterm-state st-lost';
            metaText.textContent = '作业句柄不在本运行期（应用重启后无法查看实时输出）';
            stopBtn.classList.add('hidden');
            return;
        }
        if (snapshot.command && !doc.bgTermCommand) {
            doc.bgTermCommand = snapshot.command;
            cmd.textContent = snapshot.command;
        }
        const state = snapshot.state || 'unknown';
        stateBadge.textContent = bgTermStateLabel(state, snapshot.code);
        stateBadge.className = 'bgterm-state st-' + state;
        const bits = [];
        if (snapshot.cwd) bits.push('目录 ' + snapshot.cwd);
        bits.push('jobId ' + doc.bgTerm);
        if (snapshot.startedAt) bits.push('启动 ' + new Date(snapshot.startedAt).toLocaleTimeString());
        metaText.textContent = bits.join(' · ');
        stopBtn.classList.toggle('hidden', state !== 'running');
        const text = String(snapshot.log || '');
        // 用户往上翻历史时不强制拉回底部
        const nearBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 60;
        if (text) {
            out.textContent = text;
            out.classList.remove('empty');
            if (nearBottom) out.scrollTop = out.scrollHeight;
        } else {
            out.textContent = '（暂无输出；作业产生输出后会实时显示在这里）';
            out.classList.add('empty');
        }
        renderBgTermTabTitle(doc, snapshot.command);
    };

    if (deps.aiPanel && deps.aiPanel.bridgeOnBgUpdate) {
        // 卸载契约：虚拟标签页的清理函数统一挂 doc.tabUnmount（closeDocNow 只调这一条）
        const unsub = deps.aiPanel.bridgeOnBgUpdate((jobId) => {
            if (jobId !== doc.bgTerm || !doc.pane || !doc.pane.isConnected) return;
            render();
        });
        doc.tabUnmount = () => {
            unsub();
            doc.tabUnmount = null;
        };
    }
    render();
}

function renderBgTermTabTitle(doc, command) {
    const name = bgTermTabName(command || doc.bgTermCommand);
    if (name && name !== doc.name) {
        doc.name = name;
        deps.renderTabs();
    }
}


return {createBgTermView, openBgTermTab};
}
