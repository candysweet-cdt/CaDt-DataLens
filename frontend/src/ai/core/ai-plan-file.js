// ai-plan-file.js：计划文档的拼装、命名与回注规则（纯函数，可单测）。
//
// 状态不在这里：当前计划是 session.activePlan（{title, goal, files, steps, verification,
// risks, markdown, status, ts, fileRel}），由 submit_plan 执行时写入、审批卡/落盘/回注/角标
// 统一读它。本文件只负责：
//   · 结构化字段 → Markdown 文档（planMarkdownFrom）
//   · 文档 → 固定落盘路径（planFileRelPath：.cadt/plan/plan-<会话id>.md，同会话覆盖同一份）
//   · 数据归一（normalizeActivePlan）与 compact 回注块（planReferenceBlock）
// 消息不再承载任何计划字段（planText / planFile 已移除）。

export const PLAN_DIR_REL = '.cadt/plan';

// 单份计划文档上限（与 ai-constants 的 AI_CHAT_INPUT_LIMIT 同量级；超出直接报工具错误）
export const PLAN_MAX_CHARS = 100000;

// 计划标题：优先第一个 ATX 标题（# / ## …），退化到第一行非空文本（去掉列表符号）。
export function planTitleOf(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (m && m[1].trim()) return m[1].trim();
    }
    for (const line of lines) {
        // 退化路径也要先摘掉裸的 # 记号（`#   ` 这种空标题不能变成 '#'）
        const value = line
            .replace(/^\s*#{1,6}\s*/, '')
            .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
            .trim();
        if (value) return value;
    }
    return '';
}

// 时间戳（本地时间，秒级）：只用于落盘正文尾部的来源注释，不参与文件名。
export function planStamp(ts) {
    const date = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return '' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
        '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

// 会话 id 清洗：只留文件名安全字符（参考 ZCode plan-file-continuity 的做法），空值回落 'session'。
export function planSessionSlug(sessionId) {
    const value = String(sessionId == null ? '' : sessionId)
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return value || 'session';
}

// 会话固定路径：同一会话的计划永远落在同一个文件（批准时覆盖写），修订轮自然演进同一份。
export function planFileRelPath(sessionId) {
    return PLAN_DIR_REL + '/plan-' + planSessionSlug(sessionId) + '.md';
}

// 展示用短路径：从绝对路径里切出 .cadt/plan/… 一段；不是计划文件时回落文件名。
export function planDisplayPath(absPath) {
    const value = String(absPath == null ? '' : absPath).replace(/\\/g, '/');
    const m = value.match(/(?:^|\/)\.cadt\/plan\/[^/]+$/);
    if (m) return m[0].replace(/^\//, '');
    const idx = value.lastIndexOf('/');
    return idx >= 0 ? value.slice(idx + 1) : value;
}

// 规模摘要：行数 + 字数（去空白），给「够不够长 / 值不值得点开」一个判断依据。
export function planDigest(text) {
    const raw = String(text == null ? '' : text);
    const lines = raw ? raw.split(/\r?\n/).length : 0;
    const chars = raw.replace(/\s+/g, '').length;
    return {title: planTitleOf(raw), lines, chars};
}

// 审批卡预览的截断预算（字符）：渲染成 Markdown 后约一屏（.ai-plan-preview 280px）的量级
export const PLAN_PREVIEW_CHARS = 1600;

// 审批卡预览截断（纯函数）：只在「行边界 + 围栏外」切。计划是结构化生成的（planMarkdownFrom
// 固定分节），按整行保留就保得住格式——不切半行、不悬空 ``` 围栏：围栏要么整体保留（连闭合行
// 都放得下时），要么整体丢弃（回退到开栏之前）。预算内一行都放不下时返回空正文（省略号由调用方补）。
// 返回 {text, truncated}。
export function planPreviewSlice(text, budget) {
    const raw = String(text == null ? '' : text);
    const limit = Math.max(0, Number(budget) || 0);
    if (raw.length <= limit) return {text: raw, truncated: false};
    const lines = raw.split('\n');
    let off = 0;
    let inFence = false;
    let cut = 0; // 保底一行不留
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (off > limit) break; // 行起点单调递增，之后的行整体超预算
        const isFenceLine = /^\s{0,3}(?:```|~~~)/.test(line);
        if (inFence) {
            // 闭合行：围栏标记后只许空白（```js 这种带 info string 的不是闭合）
            if (isFenceLine && /^\s{0,3}(?:```|~~~)\s*$/.test(line)) inFence = false;
        } else {
            cut = i;
            if (isFenceLine) inFence = true;
        }
        off += line.length + 1;
    }
    return {text: lines.slice(0, cut).join('\n').replace(/\s+$/, ''), truncated: true};
}

// 落盘正文：原文 + 一行 HTML 注释（Markdown 预览不显示，纯文本编辑可见），便于回查来源。
export function planFileBody(text, meta) {
    const raw = String(text == null ? '' : text).replace(/\s+$/, '');
    const info = meta || {};
    const parts = [];
    if (Number(info.ts)) parts.push(planStamp(info.ts));
    if (info.title) parts.push('会话「' + String(info.title).replace(/\s+/g, ' ').trim() + '」');
    if (info.model) parts.push(String(info.model).trim());
    const footer = parts.length ? '\n\n<!-- 计划由 CaDt-DataLens 生成 · ' + parts.join(' · ') + ' -->\n' : '\n';
    return raw + footer;
}

// 结构化小节 → Markdown 文档（submit_plan 的主路径）。
// 为什么不让模型直接传整篇长文：实测部分模型（GLM 系）会把他想说的话当 plan 参数
// （一次 176 字摘要、一次 94 字解释）。但六个固定字段又把文档压成填表（ZCode 的计划
// 是按组件自由分节的）。折中：模型按逻辑自由分节（sections），每节是独立的短文本
// （在它能力圈内），拼起来就是自由结构的长文档——层级和内容深度都回来了。
// body 是自由 Markdown：允许 ### 子标题、列表、行内代码，只纠正顶层 ## 防层级跑飞。
export function planMarkdownFrom(input) {
    const value = input || {};
    const title = String(value.title == null ? '' : value.title).trim().replace(/\s+/g, ' ');
    const sections = normalizePlanSections(value.sections);
    const parts = ['# ' + (title || planTitleOf(sections.map((s) => s.body).join('\n')) || '实施计划')];
    for (const section of sections) {
        parts.push('', '## ' + section.heading, '', section.body);
    }
    return parts.join('\n').trim() + '\n';
}

// 小节归一：heading 补空、body 里的顶层 ## 降为 ###（# title 之外不该再有同级标题），
// 空节剔除。返回 [{heading, body}]。
export function normalizePlanSections(raw) {
    return (Array.isArray(raw) ? raw : [])
        .map((section) => {
            const src = section && typeof section === 'object' ? section : {};
            const heading = String(src.heading == null ? '' : src.heading)
                .trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
            const body = String(src.body == null ? '' : src.body)
                .split(/\r?\n/)
                .map((line) => (/^##(?!#)\s/.test(line) ? '###' + line.slice(2) : line))
                .join('\n')
                .trim();
            return {heading: heading || '未命名小节', body};
        })
        .filter((section) => section.body);
}

// 小节内容量：合计去空白字数，校验「写得实不实」用。
export function planSectionsChars(sections) {
    return (Array.isArray(sections) ? sections : [])
        .reduce((total, section) => total + String(section && section.body == null ? '' : section.body)
            .replace(/\s+/g, '').length, 0);
}

// submit_plan 申报命令条目归一（activePlan.declaredCommands 会随会话落盘）：字段白名单 +
// 长度兜底，脏数据不炸、不放大。mode family 必须 带 signature，缺了降级为不预授权。
function normalizeDeclaredCommand(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const command = String(raw.command == null ? '' : raw.command).trim();
    if (!command || command.length > 200) return null;
    let mode = raw.mode === 'family' || raw.mode === 'exact' ? raw.mode : null;
    const signature = mode === 'family' ? String(raw.signature || '') : '';
    if (mode === 'family' && !signature) mode = null;
    return {
        command,
        purpose: String(raw.purpose == null ? '' : raw.purpose).trim().replace(/\s+/g, ' ').slice(0, 80),
        mode,
        signature,
        dangerous: raw.dangerous === true,
        dangerLabel: String(raw.dangerLabel == null ? '' : raw.dangerLabel).trim().slice(0, 80),
        reason: String(raw.reason == null ? '' : raw.reason).trim().slice(0, 80),
    };
}

// session.activePlan 归一（读盘 / 组装请求时用）：字段白名单 + 长度兜底，脏数据不炸。
// markdown 为空视为没有计划（返回 null）——状态只有 pending / approved 两种。
export function normalizeActivePlan(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const markdown = String(raw.markdown == null ? '' : raw.markdown).trim();
    if (!markdown) return null;
    const declared = Array.isArray(raw.declaredCommands)
        ? raw.declaredCommands.map(normalizeDeclaredCommand).filter(Boolean).slice(0, 8)
        : null;
    const plan = {
        title: String(raw.title == null ? '' : raw.title).trim().replace(/\s+/g, ' ').slice(0, 120),
        markdown: markdown.slice(0, PLAN_MAX_CHARS),
        status: raw.status === 'approved' ? 'approved' : 'pending',
        ts: Number(raw.ts) || 0,
        fileRel: String(raw.fileRel == null ? '' : raw.fileRel).trim(),
    };
    if (declared && declared.length) plan.declaredCommands = declared;
    return plan;
}

// compact 后的计划回注块（对齐 ZCode 的 plan_file_reference）：压缩把前段消息移入
// session.archived，计划可能只剩摘要。这里直接从 session.activePlan 取完整文档，
// 让压缩后的下一轮仍能「继续按计划执行 / 修订」。只在 summary 存在时注入——
// 未压缩时模型在历史里看得到；没有计划时返回 ''。
export function planReferenceBlock(session) {
    if (!session) return '';
    const summary = session.summary;
    if (!summary || !String(summary.text == null ? '' : summary.text).trim()) return '';
    const plan = session.activePlan && typeof session.activePlan === 'object' ? session.activePlan : null;
    const content = plan ? String(plan.markdown == null ? '' : plan.markdown).trim() : '';
    if (!content) return '';
    const approved = plan.status === 'approved';
    return [
        '<plan_reference>',
        '本会话发生过上下文压缩，此前历史已归档为摘要；下面的计划可能已不在可见消息里。',
        approved
            ? '当前计划已批准并保存为工作区文件：' + planFileRelPath(session.id) + '。'
            : '当前计划尚未批准（等用户点「执行计划」）。',
        '',
        content,
        '',
        '如果该计划与当前工作相关且尚未完成，继续按计划推进，不要重新规划；用户发送的补充意见是对本计划的修订要求，基于它输出修订版。',
        '</plan_reference>',
    ].join('\n');
}

// 计划提交后用户是否还没针对它发言。用于「计划等待批准」横条：用户点了「继续规划」后
// 横条作为「可回到审批卡」的入口短暂出现，一旦用户发出修订消息（ts 晚于计划提交时刻），
// 说明已经在继续规划，横条就该收起，不再反复提示批准。纯从会话数据派生，不额外存状态。
export function planAwaitingUserReply(session) {
    const plan = session && session.activePlan;
    if (!plan) return true;
    const planTs = Number(plan.ts) || 0;
    for (const msg of (session.messages || [])) {
        if (msg && msg.role === 'user' && Number(msg.ts) > planTs) return false;
    }
    return true;
}
