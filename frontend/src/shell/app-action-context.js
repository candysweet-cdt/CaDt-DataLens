// app-action-context.js：app_control 动作执行的「前置解析」域——从 main.js 拆出（超线治理第 3 批）。
//
// 职责：把 app_control 工具收到的参数（文档 ref / DOM 选择器 / 群聊 query / 插件名…）
// 解析成 runAppAction 能直接用的对象或文本。全是「读 + 整形」，不写任何应用状态。
//
// 为什么单独成域：runAppAction 本身（main.js 的 1000+ 行分发枢纽）是组合根，四方对账
// 覆盖全文件、不能拆；但它前面这 340 行是**无状态的纯解析**，与编排无关，拆出去零风险。
//
// ── deps 契约（2026-11-27 踩坑）─────────────────────────────────────────────
// 一律传**函数**（`docs: () => docs`），不是 getter 属性（`get docs() { return docs }`）。
// 模块内部统一写 `deps.docs()`。传 getter 会让 deps.docs 直接是值，`deps.docs()` 变成
// 「对象当函数调」→ TypeError，启动即崩——而 npm test / typecheck / node --check 全绿，
// 因为它们谁都没真正执行过这些函数（见 main-file-size-guard 的运行时冒烟）。
// 这些状态（docs / file / aiPanel / aiGroupRuntime / backend）在模块构造之后才赋值，
// findDocByPath 更定义在 main.js 更下方；传函数延迟求值才不踩 TDZ、不拍快照。
import {tabKindOf} from '../core/tab-kinds.js';
import {listModelOptions} from '../ai/agent/ai-agent-model.js';

// ===== 上下文入口与文档信息 =====
export function createAppActionContext(deps) {
    function appActionDocInfo(doc) {
        if (!doc) return null;
        const info = {name: doc.name, path: doc.path || '', mode: doc.mode || '', dirty: !!doc.dirty, format: (doc.format && doc.format.id) || ''};
        // 浏览器标签给 AI 一个精确定位线索：name 可能是「新标签页」（无 URL），光靠 name/index
        // 不足以让模型选对要接管的标签。只读增强，文件标签不带这两个字段。
        if (doc.browser) {
            info.browserUrl = doc.browserUrl || '';
            info.browserTabId = doc.id;
        }
        return info;
    }

// ===== 文档与标签定位 =====
    // 浏览器标签定位：id / name / url / index 四选一（与 close_browser_tab 的匹配口径一致），
    // 命中多个时报错而不是随便选一个——接管是不可逆的能力授予，必须精确。
    function appActionFindBrowserDoc(ref) {
        const r = ref && typeof ref === 'object' ? ref : {};
        const matches = deps.docs().filter((d, index) => {
            if (!d.browser) return false;
            if (r.id != null && d.id === String(r.id)) return true;
            if (r.name != null && d.name === String(r.name)) return true;
            if (r.url != null && d.browserUrl === String(r.url)) return true;
            if (r.index != null && Number.isFinite(Number(r.index)) && index === Number(r.index)) return true;
            return false;
        });
        if (matches.length === 0) throw new Error('未找到浏览器标签页（用 get_state 的 tabs 看 name / browserUrl / browserTabId / index）');
        if (matches.length > 1) throw new Error('多个浏览器标签页匹配，请用 id 精确定位');
        return matches[0];
    }

    // 标签页 → 应用内视图描述（AI 的 workspace_context 用）。没有 path 的标签页（内嵌浏览器 /
    // 快捷便签 / 计划与差异等虚拟文档 / 子代理详情 / 后台终端）不是文件，混进「已打开文件」
    // 会被 aiDisplayPath 在范围根之外判成「（范围外）xxx」——模型会以为工作区外还有同名文件
    // 可读，用户看到的也是这句没头没尾的标注。返回 null 表示这是真文件（有 path）。
    //
    // 视图型虚拟标签页（浏览器 / 终端 / 子代理 …）的 kind 与 label 在 core/tab-kinds.js；
    // 这里只留文本型虚拟标签页（靠 viewKind 区分）的标签。
    const APP_TAB_KIND_LABELS = {
        plan: '计划文档',
        diff: '差异审阅',
        document: '只读文档',
        untitled: '未保存的新文档',
    };

    function appTabViewOf(doc) {
        if (!doc || doc.path) return null;
        const name = String(doc.name || doc.browserUrl || '').trim();
        // 视图型虚拟标签页：类型名与标签来自 core/tab-kinds.js（单一来源）
        const tabKind = tabKindOf(doc);
        if (tabKind) {
            const base = {kind: tabKind.kind, label: tabKind.label, name};
            // 数据库标签页给 AI 注入比标签标题更丰富的上下文（连接/库/表/类型）。
            // name 已是表名/连接名/键名，desc 不重复它——旧控制台文案会注入成
            // 查询控制台「x」（连接「x」…），同一信息出现两次
            if (doc.dbTableSpec) {
                const t = doc.dbTableSpec;
                return {...base, desc: (t.entry && t.entry.name ? '连接「' + t.entry.name + '」' : '') +
                    (t.db && t.db !== 'main' ? '库 ' + t.db + ' 的' : '') +
                    (t.kind === 'view' ? '视图 ' : '表 ') + t.table};
            }
            if (doc.dbConsoleSpec) {
                const c = doc.dbConsoleSpec;
                // SQL / Redis 控制台共用此标签：SQL 是默认语义不必注，Redis 的命令方言值得点名
                return c.entry && c.entry.kind === 'redis' ? {...base, desc: 'Redis 命令控制台'} : base;
            }
            if (doc.dbRedisKeySpec) {
                const r = doc.dbRedisKeySpec;
                // 键名不重复（name 已带）；库省略口径与表同：Redis db 0 在创建点已归一为 ''
                return {...base, desc: (r.entry && r.entry.name ? '连接「' + r.entry.name + '」' : '') +
                    (r.db ? '库 ' + r.db : '')};
            }
            return base;
        }
        // 文本型虚拟标签页（计划 / 差异 / 只读文档 / 未保存新文档）：靠 viewKind 区分
        const kind = doc.viewKind ? String(doc.viewKind) : 'untitled';
        return {kind, label: APP_TAB_KIND_LABELS[kind] || '标签页', name};
    }

    function appActionDocCaret(doc) {
        const out = {cursor: null, selection: null};
        if (!doc || doc.binary) return out;
        const lineColAt = (text, offset) => {
            const before = String(text).slice(0, Math.max(0, Math.min(Number(offset) || 0, String(text).length)));
            const lines = before.split('\n');
            return {line: lines.length, column: lines[lines.length - 1].length + 1};
        };
        try {
            const mode = String(doc.mode || '');
            const ace = doc.editor && doc.editor.aceEditor;
            if ((!mode || mode === 'code' || mode === 'split') && ace && ace.getCursorPosition) {
                const pos = ace.getCursorPosition();
                out.cursor = {line: (Number(pos.row) || 0) + 1, column: (Number(pos.column) || 0) + 1};
                if (ace.getSelectionRange && ace.getSelectedText) {
                    const sel = ace.getSelectionRange();
                    const empty = sel.start.row === sel.end.row && sel.start.column === sel.end.column;
                    if (!empty) {
                        const selected = ace.getSelectedText() || '';
                        out.selection = {
                            start: {line: sel.start.row + 1, column: sel.start.column + 1},
                            end: {line: sel.end.row + 1, column: sel.end.column + 1},
                            chars: selected.length,
                            preview: selected.slice(0, 300),
                        };
                    }
                }
                if (ace.renderer && ace.renderer.getFirstVisibleRow && ace.session && ace.session.screenToDocumentRow) {
                    try {
                        const first = ace.renderer.getFirstVisibleRow();
                        const last = ace.renderer.getLastVisibleRow ? ace.renderer.getLastVisibleRow() : first;
                        out.viewport = {
                            fromLine: (Number(ace.session.screenToDocumentRow(first, 0)) || 0) + 1,
                            toLine: (Number(ace.session.screenToDocumentRow(last, 0)) || 0) + 1,
                        };
                    } catch (e) {}
                }
                return out;
            }
            const textarea = doc.pane && doc.pane.querySelector('textarea.jsoneditor-text');
            if ((!mode || mode === 'text') && textarea && typeof textarea.selectionStart === 'number') {
                out.cursor = lineColAt(textarea.value, textarea.selectionEnd);
                if (textarea.selectionEnd > textarea.selectionStart) {
                    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
                    out.selection = {
                        start: lineColAt(textarea.value, textarea.selectionStart),
                        end: lineColAt(textarea.value, textarea.selectionEnd),
                        chars: selected.length,
                        preview: selected.slice(0, 300),
                    };
                }
            }
        } catch (e) {}
        return out;
    }

    function appActionResolveDoc(ref) {
        if (ref == null || ref === '') return deps.file();
        if (typeof ref === 'number' && Number.isFinite(ref)) {
            const idx = ref < 0 ? deps.docs().length + ref : ref;
            return deps.docs()[idx] || null;
        }
        const text = String(ref).trim();
        if (!text || text.toLowerCase() === 'active') return deps.file();
        if (/^\d+$/.test(text)) return deps.docs()[Number(text)] || null;
        return deps.findDocByPath(text);
    }

// ===== 交互派发与节点描述 =====
    // click 动作的 DOM 合成：按真实顺序派发 pointer/mouse 事件（不移动系统鼠标）。
    // 合成事件 isTrusted=false、不带用户激活——依赖真实点击校验的行为可能无响应（技能表已注明）。
    function appActionDispatchClick(el, x, y) {
        const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        const screenX = (Number(window.screenX) || 0) + x;
        const screenY = (Number(window.screenY) || 0) + y;
        const base = {bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX, screenY};
        const pointer = (type, extra) => new Pointer(type, {...base, button: 0, buttons: 0, detail: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra});
        const mouse = (type, extra) => new MouseEvent(type, {...base, button: 0, buttons: 0, detail: 0, ...extra});
        el.dispatchEvent(pointer('pointerover'));
        el.dispatchEvent(mouse('mouseover'));
        el.dispatchEvent(pointer('pointerenter', {bubbles: false}));
        el.dispatchEvent(mouse('mouseenter', {bubbles: false}));
        el.dispatchEvent(pointer('pointermove'));
        el.dispatchEvent(mouse('mousemove'));
        el.dispatchEvent(pointer('pointerdown', {buttons: 1, detail: 1}));
        el.dispatchEvent(mouse('mousedown', {buttons: 1, detail: 1}));
        // 真实点击在 mousedown 后聚焦可聚焦目标；合成事件不会自动聚焦，手动补上
        try {
            if (el instanceof HTMLElement && el.tabIndex >= 0) el.focus({preventScroll: true});
        } catch (e) {}
        el.dispatchEvent(pointer('pointerup', {buttons: 0, detail: 1}));
        el.dispatchEvent(mouse('mouseup', {buttons: 0, detail: 1}));
        el.dispatchEvent(mouse('click', {buttons: 0, detail: 1}));
    }

    // press_key 的按键合成：修饰键先按下（带自己与已按修饰键的 flag）→ 主键 down/up →
    // 修饰键逆序抬起。应用全局快捷键按 e.code 匹配（comboFromEvent），故 code 必须是物理键位。
    function appActionDispatchKey(target, spec) {
        const flags = {ctrlKey: false, altKey: false, shiftKey: false, metaKey: false};
        const pressed = [];
        const modifierKeys = [
            ['ctrl', 'Control', 'ControlLeft'],
            ['alt', 'Alt', 'AltLeft'],
            ['shift', 'Shift', 'ShiftLeft'],
            ['meta', 'Meta', 'MetaLeft'],
        ];
        for (const [flag, key, code] of modifierKeys) {
            if (!spec.modifiers[flag]) continue;
            flags[flag + 'Key'] = true;
            target.dispatchEvent(new KeyboardEvent('keydown', {key, code, bubbles: true, cancelable: true, ...flags}));
            pressed.push([flag, key, code]);
        }
        target.dispatchEvent(new KeyboardEvent('keydown', {key: spec.key, code: spec.code, bubbles: true, cancelable: true, ...flags}));
        target.dispatchEvent(new KeyboardEvent('keyup', {key: spec.key, code: spec.code, bubbles: true, cancelable: true, ...flags}));
        for (let i = pressed.length - 1; i >= 0; i--) {
            const [flag, key, code] = pressed[i];
            flags[flag + 'Key'] = false;
            target.dispatchEvent(new KeyboardEvent('keyup', {key, code, bubbles: true, cancelable: true, ...flags}));
        }
    }

    function appActionDescribeNode(el) {
        if (!el) return null;
        let cls = '';
        try {
            cls = typeof el.className === 'string' ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
        } catch (e) {}
        const text = String(el.innerText || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '')
            .replace(/\s+/g, ' ').trim().slice(0, 80);
        return {tag: String(el.tagName || '').toLowerCase(), id: el.id || '', cls: cls.slice(0, 120), text};
    }

    function appActionEditableTarget(selector, allowNonEditable) {
        let el = null;
        if (selector) {
            try {
                el = document.querySelector(String(selector));
            } catch (e) {
                return null;
            }
        } else {
            el = document.activeElement;
        }
        if (!el || el === document.body) return allowNonEditable ? (el || document.body) : null;
        const editable = el.matches && (el.matches('input, textarea') || el.isContentEditable);
        if (!editable && !allowNonEditable) return null;
        return el;
    }

// ===== 上下文内容提取 =====
    // 文档当前文本（含未保存修改）：编辑器在树/代码模式下 getText 会按当前设置序列化
    function appActionDocText(doc) {
        if (!doc || doc.binary) return '';
        try {
            if (doc.editor && typeof doc.editor.getText === 'function') return String(doc.editor.getText() || '');
        } catch (e) {}
        return String(doc.content || '');
    }

    function appActionTermTail(term, maxLines) {
        const buf = term && term.buffer && term.buffer.active;
        if (!buf) return '';
        const end = Number(buf.length) || 0;
        const start = Math.max(0, end - maxLines);
        const lines = [];
        for (let i = start; i < end; i++) {
            const line = buf.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
        }
        return lines.join('\n');
    }

// ===== 配置与智能体快照 =====
    // —— AI 智能体（app_control get_agents / create_agent）——
    // 智能体配置的真源在 AI 面板（ai-config.json 的 agents[]，经 panel 的 aiGroupApi 读写）；
    // 这里只做参数整理与快照整形，校验/去重/编号全走 ai-agent-model 的纯函数。
    function appActionAIConfig() {
        const panel = deps.aiPanel();
        if (!panel || !panel.aiGroupApi) throw new Error('AI 面板未初始化');
        return panel.aiGroupApi.getConfig();
    }

    function appActionAgentSnapshot() {
        const config = appActionAIConfig();
        const options = listModelOptions(config.profiles);
        const labelByRef = new Map(options.map((option) => [option.ref, option.label]));
        const agents = (config.agents || []).map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            group: agent.group,
            modelRef: agent.modelRef,
            model: labelByRef.get(agent.modelRef) || '模型不可用',
            style: agent.replyStyle,
            chair: !!agent.chair,
            slowTier: !!agent.slowTier,
            enabled: agent.enabled !== false,
        }));
        return {agents, models: options.map((option) => ({ref: option.ref, label: option.label}))};
    }

// ===== 工作区与群聊信息 =====
    // 相对路径按工作区根解析（app_control 的文件/目录类动作共用）。
    function appActionWorkspacePath(raw) {
        const text = String(raw == null ? '' : raw).trim();
        if (!text) return '';
        // 绝对路径：盘符 / UNC / POSIX 根 / 带 scheme 的地址（mock、file、http 等）
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) || /^[a-zA-Z]:[\\/]/.test(text) ||
            text.startsWith('\\\\') || text.startsWith('/')) {
            return text;
        }
        const cur = deps.currentRoot();
        if (!cur) return text;
        return cur.replace(/[\\/]+$/, '') + '\\' + text.replace(/^[\\/]+/, '');
    }

    // 群聊摘要（get_groups / send_group_message 共用）：成员名按当前智能体配置解析。
    function appActionGroupBrief(meta) {
        const agents = (appActionAIConfig().agents || []);
        const members = (meta.memberIds || []).map((id) => {
            const agent = agents.find((item) => item && item.id === id);
            return agent ? agent.name : '已删除成员';
        });
        return {
            id: meta.id,
            title: meta.title || '未命名群聊',
            mode: meta.mode,
            goal: meta.goal,
            chair: meta.chair ? {kind: meta.chair.kind, agentId: meta.chair.agentId || ''} : null,
            members,
            messageCount: meta.messageCount || 0,
            updatedAt: meta.updatedAt || 0,
            minutes: meta.minutes && meta.minutes.text
                ? {createdAt: Number(meta.minutes.createdAt) || 0, chars: String(meta.minutes.text).length, source: meta.minutes.source || ''}
                : null,
        };
    }

    // 群聊定位：id 精确 → 标题精确（大小写不敏感）；多命中要求用 id。
    function appActionResolveGroup(query) {
        const runtime = deps.aiGroupRuntime();
        if (!runtime) throw new Error('群聊运行时未初始化');
        const key = String(query == null ? '' : query).trim();
        if (!key) throw new Error('需要群聊 id 或标题');
        const groups = runtime.groupList() || [];
        const byId = groups.find((meta) => meta.id === key);
        if (byId) return byId;
        const exact = groups.filter((meta) => String(meta.title || '').toLowerCase() === key.toLowerCase());
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) {
            throw new Error('群聊标题有多个匹配：' + exact.map((meta) => meta.id).join(' / ') + '；请改用 id');
        }
        throw new Error('找不到群聊「' + key + '」；现有：' +
            (groups.map((meta) => (meta.title || '未命名') + '（' + meta.id + '）').join('、') || '（暂无群聊，先用 create_group 创建）'));
    }

    // 按名字在官方插件市场解析安装地址；多命中/未命中都报候选。
    async function appActionInstallUrlFromName(name) {
        const api = deps.backend();
        if (typeof api.GetPluginMarket !== 'function') throw new Error('当前版本不支持插件市场');
        const list = (await api.GetPluginMarket()) || [];
        const key = String(name || '').trim().toLowerCase();
        const nameOf = (item) => [item && item.name, item && item.id, item && (item.repo || '').split('/').pop()]
            .filter(Boolean).map((value) => String(value).toLowerCase());
        const hits = list.filter((item) => nameOf(item).includes(key));
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) {
            throw new Error('插件名有多个匹配：' + hits.map((item) => item.name + '（' + item.url + '）').join('；') + '；请改用 url 明确');
        }
        throw new Error('官方市场里没有插件「' + name + '」；可用：' +
            (list.slice(0, 30).map((item) => item.name).join('、') || '（市场为空或拉取失败）'));
    }

    return {
        appActionDocInfo,
        appActionFindBrowserDoc,
        APP_TAB_KIND_LABELS,
        appTabViewOf,
        appActionDocCaret,
        appActionResolveDoc,
        appActionDispatchClick,
        appActionDispatchKey,
        appActionDescribeNode,
        appActionEditableTarget,
        appActionDocText,
        appActionTermTail,
        appActionAIConfig,
        appActionAgentSnapshot,
        appActionWorkspacePath,
        appActionGroupBrief,
        appActionResolveGroup,
        appActionInstallUrlFromName,
    };
}
