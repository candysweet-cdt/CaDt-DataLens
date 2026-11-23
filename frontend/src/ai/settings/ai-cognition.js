// ai-cognition.js：认知索引的前端域——工具执行支撑（会话指纹登记 / CAS base 自动附加）、
// overview 预取与轮上下文注入（<cognition_index> 只注一次、压缩后重注是预期恢复行为 +
// <cognition_nudge> 维护提醒）、守则两态文案；三组纯函数导出供单测。
// 方案 docs/finished-plans/ai-cognition-index.md（§4.3 / §4.4 / §5.3 / §5.5）；可选启用默认关。
// 注入落点是轮上下文（turnContextBundle）不是系统提示词：卷会被 edit 改写，进稳定区等于
// 每次维护都击穿前缀缓存（§5.3 硬约束）。bundle 是同步组装，缓存由 prefetchTurnCache 在
// 起轮前刷新（本地文件读 ≈1–2ms），bundle 只消费缓存。

import {parseJson} from '../../core/json-safe.js';

// 注入正文预算（字符）：overview 注入总量 1–2K token ≈ 4–6K 字符，正文留 4500（§5.3）。
export const OVERVIEW_BODY_BUDGET = 4500;
// 路径地图行预算：单条路径 + 标签的展示上限（超长路径截断展示）。
const OVERVIEW_LINE_MAX = 160;

const INDEX_BLOCK_MARK = '<cognition_index>';
const NUDGE_BLOCK_MARK = '<cognition_nudge>';

// ---------- 纯函数（导出供 ai-cognition.test.mjs） ----------

// resolveNeedsReread：会话登记的指纹 ≠ 当前卷指纹（登记缺失也算不一致——保守方向，
// 误报一次重读的代价远小于基于脏指纹改卷，§4.4）。
export function resolveNeedsReread(registered, current) {
    if (!current) return false;
    return registered !== current;
}

// shouldInjectCognitionOverview：本会话历史里还没有 <cognition_index> 块时才注入（§5.3）。
// 只扫用户消息正文（块随起轮的用户消息落盘）；auto-compact 裁掉历史后块消失、判定自然
// 再次为真——压缩后重注入是预期恢复行为，不是缺陷。
export function shouldInjectCognitionOverview(messages) {
    return !(messages || []).some((m) => m && m.role === 'user' &&
        typeof m.content === 'string' && m.content.includes(INDEX_BLOCK_MARK));
}

// coveredByIndex：文件是否被索引覆盖（文件条目精确命中，或落在目录条目前缀下）。
// 比对一律小写 + 正斜杠（与 Go PathKey 同口径，§3.2）。
export function coveredByIndex(relPath, lines) {
    const key = normalizeRelKey(relPath);
    if (!key) return false;
    let covered = false;
    for (const line of lines || []) {
        const lineKey = normalizeRelKey(line.path);
        if (!lineKey) continue;
        if (line.dir) {
            if (key.startsWith(lineKey)) return true;
        } else if (lineKey === key) {
            covered = true;
        }
    }
    return covered;
}

export function normalizeRelKey(p) {
    let text = String(p == null ? '' : p).trim().replace(/\\/g, '/');
    while (text.startsWith('./')) text = text.slice(2);
    text = text.replace(/^\/+/, '').replace(/ +$/, '').toLowerCase();
    return text;
}

// touchedPathsOfCall：写类工具调用涉及的路径（write_file / edit_file 取 path；
// apply_patch 从补丁头提取文件清单；其余工具不涉及）。
export function touchedPathsOfCall(name, args) {
    const input = args && typeof args === 'object' ? args : safeParse(args);
    if (!input) return [];
    if (name === 'write_file' || name === 'edit_file') {
        return [String(input.path || '')];
    }
    if (name === 'apply_patch') {
        const text = String(input.patch || input.text || '');
        const out = [];
        for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
            out.push(m[1].trim());
        }
        return out;
    }
    return [];
}

// shouldNudgeCognition：本会话改过索引覆盖内的文件、且此后没有成功的 cognition_edit、
// 也没有提醒过 → 返回要提醒的路径集（≤5 条 + 总数）；否则 null（§5.5）。
// 方向必须是「少提醒」而非「误提醒」：未覆盖的改动不提醒、提醒过的批次不再重复。
export function shouldNudgeCognition(messages, lines) {
    const entries = (lines || []).filter((line) => line && line.path);
    if (!entries.length) return null;
    const pending = new Set();
    for (const m of messages || []) {
        if (!m) continue;
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const call of m.toolCalls) {
                if (!call || typeof call.name !== 'string') continue;
                for (const path of touchedPathsOfCall(call.name, call.arguments)) {
                    if (path && coveredByIndex(path, entries)) pending.add(path);
                }
            }
            continue;
        }
        if (m.role === 'tool' && m.name === 'cognition_edit' && m.status === 'done') {
            pending.clear();
            continue;
        }
        if (m.role === 'user' && typeof m.content === 'string' && m.content.includes(NUDGE_BLOCK_MARK)) {
            pending.clear(); // 已提醒过的批次不再重复；之后的新改动重新积累
        }
    }
    if (!pending.size) return null;
    const paths = [...pending].sort();
    return {paths: paths.slice(0, 5), count: paths.length};
}

// renderOverviewBlock：路径地图 + 三级降级（§5.3）——①全量；②目录条目；③顶层目录（深度 ≤2）。
// 返回 {text, tier}；空索引返回 {text:'', tier:-1}。
export function renderOverviewBlock(snapshot, budgetChars = OVERVIEW_BODY_BUDGET) {
    const lines = (snapshot && snapshot.lines) || [];
    if (!lines.length) return {text: '', tier: -1};
    const full = lines.map(formatLine).join('\n');
    if (charsOf(full) <= budgetChars) return {text: full, tier: 1};
    const dirs = lines.filter((l) => l.dir).map(formatLine).join('\n');
    if (dirs && charsOf(dirs) <= budgetChars) return {text: dirs, tier: 2};
    const tops = topDirLines(lines).map(formatLine).join('\n');
    return {text: tops, tier: 3};
}

function formatLine(line) {
    const raw = String(line.path);
    const path = raw.length > OVERVIEW_LINE_MAX ? raw.slice(0, OVERVIEW_LINE_MAX) + '…' : raw;
    // 目录条目的 path 本就带尾 /（Go 端约定）：marker 只在缺尾 / 时补，避免双斜杠
    const marker = line.dir && !path.endsWith('/') ? '/' : '';
    const labels = Array.isArray(line.labels) && line.labels.length ? ' [' + line.labels.join(' ') + ']' : '';
    return path + marker + labels;
}

function topDirLines(lines) {
    const seen = new Set();
    const out = [];
    for (const line of lines) {
        const segs = String(line.path).replace(/\/+$/, '').split('/');
        // 根级文件（单段）保留原名，不冒充目录（诱导模型对它 list_dir）
        if (segs.length < 2) {
            if (seen.has(String(line.path))) continue;
            seen.add(String(line.path));
            out.push({path: String(line.path), labels: [], dir: false});
            continue;
        }
        const top = segs.slice(0, 2).join('/') + '/';
        if (seen.has(top)) continue;
        seen.add(top);
        out.push({path: top, labels: [], dir: true});
    }
    return out;
}

function charsOf(text) { return text.length; }

function safeParse(raw) {
    if (typeof raw !== 'string') return null;
    return parseJson(raw, null);
}

// cognitionRulesText：守则段两态文案（属系统提示词稳定区——变的是卷不是守则，§5.4）。
// 关闭态只留一句启用入口（app_control 的 cognition_toggle，必弹审批面板由用户拍板）。
export function cognitionRulesText(enabled) {
    if (enabled) {
        return [
            '<cognition_rules>',
            '工作区认知索引（<cognition_index> 块每会话注入一次）回答「这个文件是什么 / 改它要动谁」：',
            '- 动手改代码前，先确认相关文件的条目（地图命中或 cognition_read 按 paths / labels / query 过滤）；条目里的 R（强关联）与 S（暗约束）是「改这里必须同时知道的事」。',
            '- 完成一次实质改动后，用 cognition_edit 维护受影响条目——这是职责不是可选项；改过文件却没维护时，下一轮会有 <cognition_nudge> 提醒，相关就顺手改，不相关忽略。',
            '- cognition_status 报的 drift（Missing / Stale 等）与当前任务相关时顺手修；Missing 不用清零——作用域排除文件 .cadt/cognition/ignore.txt（gitignore 简化语法）里的模式不进清单、不需要条目；Missing 噪音大且还没有排除文件时（status 响应的 hint 会提示），在下一次 cognition_edit 里带 ignore 参数创建（整卷替换，写错语法最坏是排除不到、下轮可改），或建议用户手写该文件。',
            '- 条目语义与代码现状冲突时，以代码为准并修正条目，同时在回复里点出冲突。',
            '- 分工：找代码内容用 search_text / glob（索引不存代码内容）；聊天历史用 session_search；用户偏好与教训在记忆；全局约定看 AGENTS.md / <workspace_rules>——索引条目不重复守则内容。',
            '</cognition_rules>',
        ].join('\n');
    }
    return [
        '<cognition_rules>',
        '本工作区未启用认知索引（跨会话记住「文件职责 / 改动联动 / 暗约束」的可选语义层，开关在 设置 → AI → 上下文与记忆）。',
        '如果用户在这个代码工作区反复进行 AI 编码会话、或希望跨会话沉淀文件间的联动与暗约束，可以主动建议启用：调用 app_control 的 cognition_toggle {enabled:true}，会弹出审批面板由用户拍板。数据目录不建议建。',
        '</cognition_rules>',
    ].join('\n');
}

// ---------- 运行时（factory + 显式依赖注入） ----------

export function createAICognition(deps) {
    // deps: {settings(对象，活引用), backend, getScopeRoot}
    const isEnabled = () => !!(deps.settings && deps.settings.aiCognition === true);
    // 会话指纹登记表（内存，不持久化）：应用重启 / 恢复会话后为空 → 首次 status 必报
    // needsReread，这是预期行为不是缺陷（保守方向，§4.4）。登记表同时是 edit 的 CAS base 来源。
    const fingerprints = new Map(); // sessionId -> fingerprint
    // overview 预取缓存（按工作区）：bundle 同步消费；每轮起轮前刷新（本地文件读，≈1–2ms）。
    let cache = {ws: '', snapshot: null};

    const wsOf = () => {
        try { return deps.getScopeRoot() || ''; } catch (e) { return ''; }
    };

    async function prefetchTurnCache(session) {
        if (!isEnabled()) return;
        // 支线对话不注入（§5.3：v1 只挂主会话轮）
        if (session && session.sideOf) return;
        const ws = wsOf();
        if (!ws || !deps.backend || !deps.backend.CognitionRead) return;
        try {
            const raw = await deps.backend.CognitionRead(ws, '{}');
            const snapshot = JSON.parse(raw);
            cache = {ws, snapshot: snapshot && snapshot.exists ? snapshot : null};
            // 刻意不写 fingerprints：CAS base / needsReread 只由 cognition_read / status / edit
            // 三个工具响应登记（§4.3/§4.4——预取若续期登记，会把「没读就改拒绝」与
            // 「恢复会话首查必报 needsReread」两条保守防线静默拆掉）
        } catch (e) {
            cache = {ws, snapshot: null}; // 预取失败按无索引处理，不阻塞起轮（§5.3）
        }
    }

    function noteRead(sessionId, fingerprint) {
        if (sessionId && fingerprint) fingerprints.set(sessionId, fingerprint);
    }

    function noteEditSuccess(sessionId, fingerprint) {
        if (sessionId && fingerprint) fingerprints.set(sessionId, fingerprint);
    }

    function baseFor(sessionId) {
        return (sessionId && fingerprints.get(sessionId)) || '';
    }

    // turnBlocks：bundle 的同步消费口。index 只注一次（shouldInjectCognitionOverview）；
    // nudge 按消息史现算。任何条件不满足返回空串（不生成空包装）。
    function turnBlocks(session) {
        if (!isEnabled()) return {index: '', nudge: ''};
        if (session && session.sideOf) return {index: '', nudge: ''}; // 支线对话不注入（§5.3）
        const ws = wsOf();
        const snapshot = cache.ws === ws ? cache.snapshot : null;
        if (!snapshot) return {index: '', nudge: ''};
        const messages = (session && session.messages) || [];
        let index = '';
        if (shouldInjectCognitionOverview(messages)) {
            const rendered = renderOverviewBlock(snapshot);
            if (rendered.text) {
                const tierNote = rendered.tier === 1
                    ? '路径地图（无字段正文；详情用 cognition_read 过滤取）'
                    : rendered.tier === 2
                        ? '仅目录条目（条目较多已降级）；目录全貌与细节用 cognition_read 过滤取'
                        : '仅顶层目录（大仓稳态降级）；目录全貌与细节用 cognition_read 过滤取';
                index = [
                    INDEX_BLOCK_MARK,
                    '工作区认知索引（scene=' + (snapshot.scene || 'code') + '，' + snapshot.entries + ' 条；' + tierNote + '）：',
                    '分工提醒：索引回答「这个文件是什么 / 改它要动谁」；找代码内容用 search_text / glob；聊天历史用 session_search；全局约定看 AGENTS.md。',
                    rendered.text,
                    '</cognition_index>',
                ].join('\n');
            }
        }
        let nudge = '';
        if (session && session.id && baseFor(session.id)) {
            const hit = shouldNudgeCognition(messages, snapshot.lines);
            if (hit) {
                const shown = hit.paths.map((p) => '`' + p + '`').join('、');
                nudge = [
                    NUDGE_BLOCK_MARK,
                    '本会话已改动 ' + hit.count + ' 个认知索引覆盖内的文件（' + shown +
                        (hit.count > hit.paths.length ? ' 等' : '') + '）但对应条目还没更新；相关就顺手 cognition_edit，不相关忽略本条。',
                    '</cognition_nudge>',
                ].join('\n');
            }
        }
        return {index, nudge};
    }

    return {isEnabled, prefetchTurnCache, turnBlocks, noteRead, noteEditSuccess, baseFor};
}
