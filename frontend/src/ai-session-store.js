// AI 会话磁盘存储：JSONL 事件日志（唯一真源）+ 每会话 meta.json。
// 纯编解码/重放与磁盘适配放在一起，但代码只依赖注入的 backend，不碰 DOM。

export const AI_SESSION_SCHEMA = 1;

const IMAGE_EXT = {
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/png': 'png',
};

function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function safeImageName(image) {
    const id = textOf(image && image.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'img';
    const ext = IMAGE_EXT[textOf(image && image.mime)] || 'png';
    return id + '.' + ext;
}

function metaSignature(meta) {
    return JSON.stringify(Object.assign({}, meta, {updatedAt: 0}));
}

// ---------- 事件编码 ----------

export function encodeSessionHeader(session) {
    return {
        v: AI_SESSION_SCHEMA,
        t: 'header',
        id: textOf(session && session.id),
        title: textOf(session && session.title),
        createdAt: Number(session && session.createdAt) || 0,
        workspace: textOf(session && session.workspace),
    };
}

// 事件里不保存 base64：图片已落 images/ 时只留 file 引用。
// 只有在落盘失败、没有 file 引用时才退回内嵌 data，宁可撑大也不丢图。
export function serializeSessionMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const out = {};
    for (const key of Object.keys(message)) {
        if (key === '_mid' || key === '_stored' || key.startsWith('_')) continue;
        if (key === 'images') continue;
        out[key] = message[key];
    }
    if (Array.isArray(message.images)) {
        out.images = message.images
            .filter((image) => image && typeof image === 'object')
            .map((image) => {
                const copy = {};
                for (const key of Object.keys(image)) {
                    if (key === 'data' && image.file) continue;
                    copy[key] = image[key];
                }
                return copy;
            });
    }
    return out;
}

export function encodeMessageEvent(message, mid, archived) {
    const payload = serializeSessionMessage(message);
    if (!payload || !mid) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'msg', mid, m: payload};
    if (archived) event.a = 1;
    return event;
}

export function encodeTruncateEvent(keep) {
    return {v: AI_SESSION_SCHEMA, t: 'truncate', keep: Math.max(0, Number(keep) || 0)};
}

export function encodeArchiveEvent(keep, summary) {
    return {
        v: AI_SESSION_SCHEMA,
        t: 'archive',
        keep: Math.max(0, Number(keep) || 0),
        summary: summary && typeof summary === 'object' ? summary : null,
    };
}

export function encodeResetEvent() {
    return {v: AI_SESSION_SCHEMA, t: 'reset'};
}

export function encodeMetaEvent(patch) {
    return {v: AI_SESSION_SCHEMA, t: 'meta', patch: patch && typeof patch === 'object' ? patch : {}};
}

export function encodeSessionLines(events) {
    if (!Array.isArray(events) || !events.length) return '';
    const lines = [];
    for (const event of events) {
        if (!event) continue;
        try {
            lines.push(JSON.stringify(event));
        } catch (e) {}
    }
    return lines.length ? lines.join('\n') + '\n' : '';
}

// ---------- 重放 ----------

export function replaySessionLog(text) {
    const result = {
        header: null,
        messages: [],
        archived: [],
        summary: null,
        meta: {},
        issues: 0,
        torn: false,
    };
    const raw = textOf(text);
    if (!raw) return result;
    const lines = raw.split('\n');
    if (!raw.endsWith('\n')) {
        // 没有换行结尾的尾行视为未提交；append 前也会把它截掉，保持读写一致。
        result.torn = true;
        lines.pop();
    } else {
        lines.pop();
    }
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event = null;
        try {
            event = JSON.parse(trimmed);
        } catch (e) {
            result.issues++;
            continue;
        }
        if (!event || typeof event !== 'object') {
            result.issues++;
            continue;
        }
        if (Number(event.v) > AI_SESSION_SCHEMA) {
            result.issues++;
            continue;
        }
        switch (event.t) {
            case 'header':
                result.header = event;
                break;
            case 'msg': {
                if (!event.m || typeof event.m !== 'object') {
                    result.issues++;
                    break;
                }
                const message = Object.assign({}, event.m, {_mid: textOf(event.mid)});
                (event.a ? result.archived : result.messages).push(message);
                break;
            }
            case 'truncate': {
                const keep = Math.max(0, Math.min(result.messages.length, Number(event.keep) || 0));
                result.messages = result.messages.slice(0, keep);
                break;
            }
            case 'archive': {
                const keep = Math.max(0, Math.min(result.messages.length, Number(event.keep) || 0));
                const moved = result.messages.slice(0, keep);
                result.messages = result.messages.slice(keep);
                result.archived = result.archived.concat(moved);
                if (event.summary && typeof event.summary === 'object') result.summary = event.summary;
                break;
            }
            case 'reset':
                result.messages = [];
                result.archived = [];
                result.summary = null;
                break;
            case 'meta': {
                const patch = event.patch && typeof event.patch === 'object' ? event.patch : {};
                Object.assign(result.meta, patch);
                if (Object.prototype.hasOwnProperty.call(patch, 'summary')) {
                    result.summary = patch.summary && typeof patch.summary === 'object' ? patch.summary : null;
                }
                break;
            }
            default:
                result.issues++;
                break;
        }
    }
    return result;
}

export function buildSessionMeta(session) {
    const summary = session && session.summary && typeof session.summary === 'object' ? session.summary : null;
    return {
        v: AI_SESSION_SCHEMA,
        id: textOf(session && session.id),
        title: textOf(session && session.title),
        createdAt: Number(session && session.createdAt) || 0,
        updatedAt: Number(session && session.updatedAt) || 0,
        workspace: textOf(session && session.workspace),
        scope: ['read', 'edit', 'full'].includes(session && session.scope) ? session.scope : 'read',
        profileId: textOf(session && session.profileId),
        systemPrompt: textOf(session && session.systemPrompt),
        promptTemplateId: textOf(session && session.promptTemplateId),
        planMode: !!(session && session.planMode),
        browserTabId: textOf(session && session.browserTabId),
        round: Number(session && session.round) || 0,
        archivedAt: Number(session && session.archivedAt) || 0,
        messageCount: Array.isArray(session && session.messages) ? session.messages.length : 0,
        archivedCount: Array.isArray(session && session.archived) ? session.archived.length : 0,
        logFile: textOf(session && session.logFile),
        logSavedAt: Number(session && session.logSavedAt) || 0,
        todos: Array.isArray(session && session.todos) ? session.todos : [],
        changes: Array.isArray(session && session.changes) ? session.changes : [],
        approvedPaths: Array.isArray(session && session.approvedPaths) ? session.approvedPaths : [],
        summary,
    };
}

// ---------- 磁盘适配 ----------

export function createSessionDiskStore(options) {
    const backend = options.backend || {};
    const genId = options.genId || ((prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    const queues = new Map();
    const pending = new Set();

    function requireBackend() {
        for (const name of ['AISessionList', 'AISessionRead', 'AISessionAppend', 'AISessionRewrite', 'AISessionWriteMeta', 'AISessionDelete']) {
            if (!backend[name]) throw new Error('当前版本缺少会话存储接口：' + name);
        }
    }

    function enqueue(id, task) {
        const key = textOf(id);
        const prev = queues.get(key) || Promise.resolve();
        const next = prev.then(task, task).catch((err) => {
            onError(err);
        });
        queues.set(key, next);
        pending.add(next);
        next.finally(() => pending.delete(next));
        return next;
    }

    async function flush() {
        while (pending.size) {
            await Promise.all(Array.from(pending));
        }
    }

    function newMid() {
        return genId('m-');
    }

    // 写盘失败时把日志记账恢复到写前状态，保证下一次持久化会重试这批消息。
    function snapshotLogState(session) {
        return {
            mids: Array.isArray(session._mids) ? session._mids.slice() : [],
            archivedMids: Array.isArray(session._archivedMids) ? session._archivedMids.slice() : [],
            logCreated: !!session._logCreated,
            logMeta: session._logMeta ? Object.assign({}, session._logMeta) : session._logMeta,
            needsRewrite: !!session._needsRewrite,
        };
    }

    function restoreLogState(session, state) {
        session._mids = state.mids;
        session._archivedMids = state.archivedMids;
        session._logCreated = state.logCreated;
        session._logMeta = state.logMeta;
        session._needsRewrite = state.needsRewrite;
    }

    async function saveImageFile(sessionId, image) {
        if (!image || typeof image !== 'object') return;
        if (!image.data || image.file) return;
        if (!backend.AISessionSaveImage) return; // 旧后端：保留内嵌 base64，不丢图
        const rel = await backend.AISessionSaveImage(
            sessionId,
            safeImageName(image),
            'data:' + (image.mime || 'image/png') + ';base64,' + image.data,
        );
        if (rel) image.file = rel;
    }

    async function prepareImages(session, messages) {
        for (const message of messages || []) {
            if (!message || !Array.isArray(message.images)) continue;
            for (const image of message.images) {
                try {
                    await saveImageFile(session.id, image);
                } catch (e) {
                    // 落盘失败时保留 base64，事件里继续内嵌，保证图片不丢。
                }
            }
        }
    }

    function syncMids(session, list, archivedList) {
        const mids = Array.isArray(session._mids) ? session._mids : [];
        const next = list.map((message, index) => {
            let mid = textOf(message && message._mid);
            if (!mid) {
                mid = mids[index] || newMid();
                if (message && typeof message === 'object') message._mid = mid;
            }
            return mid;
        });
        session._mids = next;
        const archivedMids = [];
        for (const message of archivedList || []) {
            let mid = textOf(message && message._mid);
            if (!mid) {
                mid = newMid();
                if (message && typeof message === 'object') message._mid = mid;
            }
            archivedMids.push(mid);
        }
        session._archivedMids = archivedMids;
    }

    function buildRewriteEvents(session) {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const archived = Array.isArray(session.archived) ? session.archived : [];
        syncMids(session, messages, archived);
        const events = [encodeSessionHeader(session)];
        session._logCreated = true;
        session._needsRewrite = false;
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        if (session.summary) events.push(encodeMetaEvent({summary: session.summary}));
        archived.forEach((message, index) => {
            const event = encodeMessageEvent(message, session._archivedMids[index], true);
            if (event) events.push(event);
        });
        messages.forEach((message, index) => {
            const event = encodeMessageEvent(message, session._mids[index], false);
            if (event) events.push(event);
        });
        return events;
    }

    // 新会话的第一条事件必须是 header；之后只追加事件行。
    function ensureHeaderEvent(session, events) {
        if (session._logCreated || !events.length) return events;
        events.unshift(encodeSessionHeader(session));
        session._logCreated = true;
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        return events;
    }

    async function writeMetaIfChanged(session, force) {
        const meta = buildSessionMeta(session);
        const signature = metaSignature(meta);
        if (!force && signature === session._metaSig) return;
        session.updatedAt = Date.now();
        meta.updatedAt = session.updatedAt;
        await backend.AISessionWriteMeta(session.id, JSON.stringify(meta));
        session._metaSig = signature;
    }

    // 增量持久化：按 _mid 找共同前缀，截断后追加新消息。
    const pendingPersists = new Set();

    // 同一会话已有排队中的持久化任务时直接复用：任务执行时才读最新状态，
    // 高频 persistSessions（每个工具轮）不会把队列堆长。
    function persistSession(session) {
        if (!session || !session.id) return Promise.resolve();
        if (session._loadError) return Promise.resolve(); // 正文没读出来时禁止写，避免覆盖磁盘历史
        try {
            requireBackend();
        } catch (e) {
            return Promise.reject(e);
        }
        if (pendingPersists.has(session.id)) return Promise.resolve();
        pendingPersists.add(session.id);
        return enqueue(session.id, async () => {
            pendingPersists.delete(session.id);
            await runPersistSession(session);
        });
    }

    async function runPersistSession(session) {
        if (!session || !session.id) return;
        if (session._loadError) return;
        const state = snapshotLogState(session);
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const archived = Array.isArray(session.archived) ? session.archived : [];
        const mids = Array.isArray(session._mids) ? session._mids : [];
        const archivedMids = Array.isArray(session._archivedMids) ? session._archivedMids : [];
        if (session._needsRewrite || archived.length !== archivedMids.length) {
            // 归一化丢过消息 / 归档在不经过 archive() 的情况下被改动：整份重写，保证日志与内存一致。
            await prepareImages(session, archived.concat(messages));
            try {
                const events = buildRewriteEvents(session);
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
            return;
        }
        await prepareImages(session, messages);
        const events = [];
        if (!session._logCreated) {
            // 新会话的正文以 header 开头；先落 header 再算标题补丁，避免重复的 meta 事件。
            events.push(encodeSessionHeader(session));
            session._logCreated = true;
            session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        }
        const logMeta = session._logMeta && typeof session._logMeta === 'object' ? session._logMeta : {};
        const patch = {};
        if (textOf(session.title) !== textOf(logMeta.title)) patch.title = textOf(session.title);
        if (textOf(session.workspace) !== textOf(logMeta.workspace)) patch.workspace = textOf(session.workspace);
        if (Object.keys(patch).length) {
            events.push(encodeMetaEvent(patch));
            session._logMeta = Object.assign({}, logMeta, patch);
        }
        let common = 0;
        while (common < mids.length && common < messages.length && textOf(messages[common] && messages[common]._mid) === mids[common]) {
            common++;
        }
        if (common < mids.length) {
            events.push(encodeTruncateEvent(common));
            mids.length = common;
        }
        for (let i = common; i < messages.length; i++) {
            const message = messages[i];
            if (!message || typeof message !== 'object') continue;
            if (message.status === 'streaming') break;
            let mid = textOf(message._mid);
            if (!mid) {
                mid = newMid();
                message._mid = mid;
            }
            mids[i] = mid;
            const event = encodeMessageEvent(message, mid, false);
            if (event) events.push(event);
        }
        try {
            session._mids = mids;
            if (events.length) {
                ensureHeaderEvent(session, events);
                await backend.AISessionAppend(session.id, encodeSessionLines(events));
            }
        } catch (e) {
            restoreLogState(session, state);
            throw e;
        }
        await writeMetaIfChanged(session, events.length > 0);
    }

    // 归档必须先于调用方裁剪 messages 执行：这里捕获裁剪前的快照，
    // 保证被移动的消息先落进日志，再追加 archive 事件。
    function archiveSession(session, keep, summary) {
        if (!session || !session.id) return;
        requireBackend();
        const snapshot = (Array.isArray(session.messages) ? session.messages : []).slice();
        const keepCount = Math.max(0, Math.min(snapshot.length, Number(keep) || 0));
        return enqueue(session.id, async () => {
            const liveNow = Array.isArray(session.messages) ? session.messages : [];
            const archivedNow = Array.isArray(session.archived) ? session.archived : [];
            const midsNow = Array.isArray(session._mids) ? session._mids : [];
            const archivedMidsNow = Array.isArray(session._archivedMids) ? session._archivedMids : [];
            // 队列里更早的 persist 可能已经把裁剪后的归档状态整份重写进磁盘：
            // 此时 live/archived 与 mids 已对齐，再追加 archive 事件会把消息重复写一遍。
            if (liveNow.length !== snapshot.length &&
                liveNow.length === midsNow.length &&
                archivedNow.length === archivedMidsNow.length) {
                return;
            }
            const state = snapshotLogState(session);
            if (session._needsRewrite) {
                // 加载时归一化丢掉过消息：日志里的下标与内存不一致，直接按裁剪后的状态整份重写。
                try {
                    session._needsRewrite = false;
                    await prepareImages(session, archivedNow.concat(liveNow));
                    const events = buildRewriteEvents(session);
                    await backend.AISessionRewrite(session.id, encodeSessionLines(events));
                } catch (e) {
                    restoreLogState(session, state);
                    throw e;
                }
                await writeMetaIfChanged(session, true);
                return;
            }
            const mids = midsNow;
            const archivedMids = archivedMidsNow;
            await prepareImages(session, snapshot);
            const events = [];
            let common = 0;
            while (common < mids.length && common < snapshot.length && textOf(snapshot[common] && snapshot[common]._mid) === mids[common]) {
                common++;
            }
            if (common < mids.length) {
                events.push(encodeTruncateEvent(common));
                mids.length = common;
            }
            for (let i = common; i < snapshot.length; i++) {
                const message = snapshot[i];
                if (!message || typeof message !== 'object') continue;
                let mid = textOf(message._mid);
                if (!mid) {
                    mid = newMid();
                    message._mid = mid;
                }
                mids[i] = mid;
                const event = encodeMessageEvent(message, mid, false);
                if (event) events.push(event);
            }
            events.push(encodeArchiveEvent(keepCount, summary));
            try {
                // keep 是保留数：[0, keep) 移入归档，[keep, end) 留在live。
                session._mids = mids.slice(keepCount);
                session._archivedMids = archivedMids.concat(mids.slice(0, keepCount));
                ensureHeaderEvent(session, events);
                await backend.AISessionAppend(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
        });
    }

    function resetSession(session) {
        if (!session || !session.id) return;
        requireBackend();
        return enqueue(session.id, async () => {
            const state = snapshotLogState(session);
            try {
                session._mids = [];
                session._archivedMids = [];
                const events = [encodeSessionHeader(session)];
                if (session.summary) events.push(encodeMetaEvent({summary: session.summary}));
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
                session._logCreated = true;
                session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
        });
    }

    function rewriteSession(session) {
        if (!session || !session.id) return;
        requireBackend();
        return enqueue(session.id, async () => {
            const state = snapshotLogState(session);
            try {
                await prepareImages(session, (session.archived || []).concat(session.messages || []));
                const events = buildRewriteEvents(session);
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
        });
    }

    async function loadAll(normalizeSession) {
        requireBackend();
        let metas = [];
        try {
            metas = await backend.AISessionList();
        } catch (e) {
            throw e;
        }
        const sessions = [];
        for (const raw of metas || []) {
            let meta = null;
            try {
                meta = JSON.parse(raw);
            } catch (e) {
                continue;
            }
            if (!meta || !meta.id) continue;
            let replay = replaySessionLog('');
            let loadError = '';
            let bodyText = '';
            try {
                bodyText = await backend.AISessionRead(meta.id);
                replay = replaySessionLog(bodyText);
            } catch (e) {
                loadError = (e && e.message) || String(e);
            }
            const combined = Object.assign({}, meta, {
                messages: replay.messages,
                archived: replay.archived,
                summary: meta.summary && typeof meta.summary === 'object' ? meta.summary : replay.summary,
            });
            const session = normalizeSession ? normalizeSession(combined) : combined;
            if (!session) continue;
            // 归一化可能丢掉无效消息，_mids 必须按归一化后的消息顺序重建，否则索引错位会触发重复追加。
            session._mids = (session.messages || []).map((message) => textOf(message && message._mid));
            session._archivedMids = (session.archived || []).map((message) => textOf(message && message._mid));
            session._logMeta = {title: textOf(meta.title), workspace: textOf(meta.workspace)};
            session._logCreated = !!replay.header;
            session._needsRewrite = !!session._recovered || (session.messages || []).length !== replay.messages.length;
            session.updatedAt = Number(meta.updatedAt) || Number(meta.createdAt) || 0;
            session._loadError = loadError;
            session._metaSig = metaSignature(buildSessionMeta(session));
            await hydrateImages(session);
            sessions.push(session);
        }
        return sessions;
    }

    async function hydrateImages(session) {
        if (!backend.AISessionReadImage) return;
        const lists = [session.messages, session.archived];
        for (const list of lists) {
            for (const message of list || []) {
                if (!message || !Array.isArray(message.images)) continue;
                for (const image of message.images) {
                    if (!image || image.data || !image.file) continue;
                    const name = textOf(image.file).replace(/^images[\\/]/, '');
                    if (!name || name.includes('/') || name.includes('\\')) continue;
                    try {
                        const url = await backend.AISessionReadImage(session.id, name);
                        const marker = 'base64,';
                        const index = textOf(url).indexOf(marker);
                        if (index >= 0) image.data = textOf(url).slice(index + marker.length);
                    } catch (e) {}
                }
            }
        }
    }

    async function removeSession(id) {
        requireBackend();
        await flush();
        return backend.AISessionDelete(id);
    }

    async function removeAll() {
        requireBackend();
        await flush();
        if (!backend.AISessionDeleteAll) throw new Error('当前版本缺少批量删除接口');
        return backend.AISessionDeleteAll();
    }

    return {
        loadAll,
        persistSession,
        archiveSession,
        resetSession,
        rewriteSession,
        removeSession,
        removeAll,
        flush,
        hydrateImages,
        newMid,
    };
}
