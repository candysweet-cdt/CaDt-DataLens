// AI 会话磁盘存储适配：把事件日志与 meta.json 落到 backend 提供的会话接口上。
// 追加式 JSONL 为唯一真源；编码/重放/指纹等纯逻辑在 ai-session-store.js，本模块只做
// 排队、写入、图片落盘、meta 同步与错误上报（依赖注入 backend，不碰 DOM）。
import {
    buildSessionMeta,
    encodeArchiveEvent,
    encodeMessageEvent,
    encodeMetaEvent,
    encodeSessionHeader,
    encodeSessionLines,
    encodeTruncateEvent,
    messageFingerprint,
    metaSignature,
    replaySessionLog,
    safeImageName,
    safeVideoName,
    textOf,
} from './ai-session-store.js';
import {
    aiFormatDuration,
    aiImageExt,
    aiImageSrc,
    aiNormalizeImage,
    aiNowId,
    aiSafeFileStem,
} from '../core/ai-constants.js';
import {isTransientSession} from './ai-session-scope.js';
import {newId} from '../../core/id.js';

// ---------- 磁盘适配 ----------

// 超限错误的稳定前缀契约（internal/sessionstore.Read）——前端据此分流「打开即自动
// 整理」（方案 §5.2 S2 上限语义反转），不做字符串模糊匹配。
export const SESSION_TOO_LARGE_PREFIX = 'session-too-large:';

// createSessionDiskStore 的 options 约定：
//   onTidy(id, result)    超限自动整理成功后的宿主回调（toast / 列表刷新），可缺省。
//   normalizeMessage(...) 消息归一（与 loadAll/hydrate 共用），可缺省。
export function createSessionDiskStore(options) {
    const backend = options.backend || {};
    const onTidy = typeof options.onTidy === 'function' ? options.onTidy : null;
    // genId 保留为可注入覆盖点（测试与真实存储校验假 id），默认形状见 core/id.js。
    const genId = options.genId || ((prefix) => newId(prefix));
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    const queues = new Map();
    const pending = new Set();
    // 每个会话最后一次写盘错误：enqueue 的 catch 会把错误吞成 resolved promise，
    // whenIdle 只能靠这张表判断“队列排空但实际失败”。下一次任务开始即清除。
    const lastErrors = new Map();

    function requireBackend() {
        for (const name of ['AISessionList', 'AISessionRead', 'AISessionAppend', 'AISessionRewrite', 'AISessionWriteMeta', 'AISessionDelete']) {
            if (!backend[name]) throw new Error('当前版本缺少会话存储接口：' + name);
        }
    }

    function enqueue(id, task) {
        const key = textOf(id);
        const prev = queues.get(key) || Promise.resolve();
        const run = () => {
            lastErrors.delete(key);
            return task();
        };
        const next = prev.then(run, run).catch((err) => {
            lastErrors.set(key, err);
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

    // whenIdle 等某个会话的写队列真正排空，并带回最后一次写盘错误。
    // 交接协议（释放回合租约前）必须用它，不能只看 persistSession 的返回值：
    // pending 时 persistSession 直接 resolve，flush 又感知不到被 catch 的错误。
    async function whenIdle(id) {
        const key = textOf(id);
        for (;;) {
            const tail = queues.get(key);
            if (!tail) break;
            await tail;
            if (queues.get(key) === tail) {
                queues.delete(key);
                break;
            }
        }
        const err = lastErrors.get(key);
        return err ? {ok: false, error: String((err && err.message) || err)} : {ok: true};
    }

    function newMid() {
        return genId('m-');
    }

    // 已落盘消息的指纹表（mid → 指纹）。按 mid 存，不随消息下标变化而错位。
    function fingerprintsOf(session) {
        if (!(session._fps instanceof Map)) session._fps = new Map();
        return session._fps;
    }

    function resetFingerprints(session, list) {
        const fps = new Map();
        for (const message of list || []) {
            const mid = textOf(message && message._mid);
            if (mid) fps.set(mid, messageFingerprint(message));
        }
        session._fps = fps;
        return fps;
    }

    // 写盘失败时把日志记账恢复到写前状态，保证下一次持久化会重试这批消息。
    function snapshotLogState(session) {
        return {
            mids: Array.isArray(session._mids) ? session._mids.slice() : [],
            archivedMids: Array.isArray(session._archivedMids) ? session._archivedMids.slice() : [],
            logCreated: !!session._logCreated,
            logMeta: session._logMeta ? Object.assign({}, session._logMeta) : session._logMeta,
            needsRewrite: !!session._needsRewrite,
            fps: session._fps instanceof Map ? new Map(session._fps) : null,
        };
    }

    function restoreLogState(session, state) {
        session._mids = state.mids;
        session._archivedMids = state.archivedMids;
        session._logCreated = state.logCreated;
        session._logMeta = state.logMeta;
        session._needsRewrite = state.needsRewrite;
        session._fps = state.fps;
    }

    // 追加式日志不会自动覆盖已落盘的消息。消息首次落盘后被就地修改（审批对象的
    // pending → approved/denied/failed、自动放行来源等）时调用这里：把该消息从
    // 「已持久化前缀」里摘出，下一次 persistSession 会在它的位置断开公共前缀，
    // 发 truncate 截掉旧事件后按当前状态重追加，避免 JSONL 永远留着旧状态
    // （如分类器放行来源、用户裁定结果丢失，或残留「pending」）。
    function invalidateMessage(session, message) {
        if (!session || session._loadError) return;
        if (!message || typeof message !== 'object' || message.status === 'streaming') return;
        if (!Array.isArray(session.messages) || !Array.isArray(session._mids)) return;
        const index = session.messages.indexOf(message);
        if (index < 0 || index >= session._mids.length) return; // 从未落盘的消息无需失效
        const mid = textOf(message._mid);
        if (mid && session._mids[index] === mid) session._mids[index] = '';
    }

    // 附件落盘带 workspace：新会话带附件时图片/视频先于正文 header 落盘，
    // 桶归属（Go 侧按工作区短哈希分桶）只能由调用方传入。
    async function saveImageFile(sessionId, workspace, image) {
        if (!image || typeof image !== 'object') return;
        if (!image.data || image.file) return;
        if (!backend.AISessionSaveImage) return; // 旧后端：保留内嵌 base64，不丢图
        const rel = await backend.AISessionSaveImage(
            sessionId,
            safeImageName(image),
            'data:' + (image.mime || 'image/png') + ';base64,' + image.data,
            textOf(workspace),
        );
        if (rel) image.file = rel;
    }

    // 会话视频落盘（<id>/videos/）：与图片同构，只是换 Go 绑定与安全名。
    async function saveVideoFile(sessionId, workspace, video) {
        if (!video || typeof video !== 'object') return;
        if (!video.data || video.file) return;
        if (!backend.AISessionSaveVideo) return; // 旧后端：保留内嵌 base64，不丢视频
        const rel = await backend.AISessionSaveVideo(
            sessionId,
            safeVideoName(video),
            'data:' + (video.mime || 'video/mp4') + ';base64,' + video.data,
            textOf(workspace),
        );
        if (rel) video.file = rel;
    }

    async function prepareImages(session, messages) {
        for (const message of messages || []) {
            if (!message) continue;
            if (Array.isArray(message.images)) {
                for (const image of message.images) {
                    try {
                        await saveImageFile(session.id, session.workspace, image);
                    } catch (e) {
                        // 落盘失败时保留 base64，事件里继续内嵌，保证图片不丢。
                    }
                }
            }
            if (Array.isArray(message.videos)) {
                for (const video of message.videos) {
                    try {
                        await saveVideoFile(session.id, session.workspace, video);
                    } catch (e) {
                        // 落盘失败时保留 base64，事件里继续内嵌，保证视频不丢。
                    }
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

    // 整份重写的事件装配：header + meta + summary + 归档（a:1）+ live。
    // 归档必须随载荷落盘——其中「已落盘为归档态」的部分（_archivedMids 登记过的前缀）
    // 在重写前已由 ensureArchivedSpilled + adoptVacuumSpill 搬进 sidecar 并清出内存，
    // 这里编码的只剩「尚未落盘为归档态」的尾部（本次压缩刚切进来、vacuum 看不见的）；
    // 若 vacuum 失败（spill=null，未 adopt），内存归档原样全量编码——与旧路径等价，数据不丢。
    // 任何情况下都不得把内存归档从载荷里排除：排除 = 把 vacuum 看不见的消息从磁盘抹掉
    // （审查发现的 P0，曾在此处用 excludeArchived 丢过刚压缩的消息）。
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
            // mids 条目可能被 invalidateMessage 清空：回退到消息自带的 _mid，整份重写时不能丢消息。
            const event = encodeMessageEvent(message, session._archivedMids[index] || textOf(message && message._mid), true);
            if (event) events.push(event);
        });
        messages.forEach((message, index) => {
            const event = encodeMessageEvent(message, session._mids[index] || textOf(message && message._mid), false);
            if (event) events.push(event);
        });
        // 整份重写后磁盘内容与内存一致：指纹表按当前消息重建。
        resetFingerprints(session, messages);
        return events;
    }

    // ---------- 归档出栈（S3 重写收窄的前提，复用 Go vacuum） ----------

    // 重写之前把主文件里「已落盘为归档态」的消息搬进 sidecar（Go AISessionVacuum 幂等：
    // 已整理过的会话只搬增量）。失败（另一窗口占用 / 磁盘错误 / 旧后端缺绑定）返回 null，
    // 调用方不 adopt，重写按旧路径全量编码内存归档——数据不丢，只是不瘦身。
    async function ensureArchivedSpilled(session) {
        if (!(session.archived || []).length || !backend.AISessionVacuum) return null;
        try {
            return await backend.AISessionVacuum(session.id, true) || null;
        } catch (e) {
            return null;
        }
    }

    // vacuum 成功后的内存对账。关键不变量：_archivedMids 登记的条目 = 「磁盘上已是归档态」
    // 的消息（loadOne/hydrate/reload 从重放建立；archiveSession 在 append 成功后登记；
    // buildRewriteEvents 的 syncMids 在重写落盘后重建）。vacuum 搬走的正是磁盘归档态全集，
    // 因此只清登记过的前缀；未登记的尾部是刚切进归档、尚未落盘的消息——清掉就是丢消息
    // （vacuum 只搬磁盘归档态，看不见这些尾部）。主文件已被 Go 重写，stat 基线必须刷新，
    // 否则本窗口误判「另一窗口写过」触发多余重读。
    async function adoptVacuumSpill(session, result) {
        if (!session || !result) return;
        const archived = Array.isArray(session.archived) ? session.archived : [];
        const registered = Math.min(archived.length, Math.max(0, (session._archivedMids || []).length));
        session.archived = archived.slice(registered);
        session._archivedMids = [];
        const sidecarLines = Math.max(0, Number(result.sidecarLines) || 0);
        if (sidecarLines || !session._archiveSidecarTotal) session._archiveSidecarTotal = sidecarLines;
        await refreshStat(session);
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
        // 落过盘了：面板打开时的 meta 对账靠它区分「新建还没写完」和「别处删了」
        session._unsaved = false;
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
        // 懒加载占位会话（正文还没读上来）：内存里的 messages 是空的，走日志重写会把历史抹平。
        // 只允许写 meta（标题 / 未读 / 置顶 / 待办 / 归档态都在里面）。
        if (session._stub) {
            return enqueue(session.id, async () => {
                // 基线由 toStubs 按读盘时的 meta 记好：没真改过就不写（否则每次 persistSessions
                // 都会给几十个占位各写一次 meta.json）
                await writeMetaIfChanged(session, false);
            });
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
            // S3 重写收窄：先把磁盘归档出栈到 sidecar，再只写 live；出栈失败回退旧路径。
            const spill = await ensureArchivedSpilled(session);
            await adoptVacuumSpill(session, spill);
            try {
                const events = buildRewriteEvents(session);
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
            await refreshStat(session);
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
        const fps = fingerprintsOf(session);
        // 前缀要 mid 与指纹都对上才算「已落盘」：就地改过状态的消息会让前缀在这里断开，
        // 下面 truncate 后按当前内容重追加（见 messageFingerprint 的说明）。
        while (common < mids.length && common < messages.length &&
               textOf(messages[common] && messages[common]._mid) === mids[common] &&
               fps.get(mids[common]) === messageFingerprint(messages[common])) {
            common++;
        }
        if (common < mids.length) {
            events.push(encodeTruncateEvent(common));
            for (let i = common; i < mids.length; i++) if (mids[i]) fps.delete(mids[i]);
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
            fps.set(mid, messageFingerprint(message));
            const event = encodeMessageEvent(message, mid, false);
            if (event) events.push(event);
        }
        try {
            session._mids = mids;
            session._fps = fps;
            if (events.length) {
                ensureHeaderEvent(session, events);
                // allowCreate 用进门时的快照：新会话首落盘此处 _logCreated 已被上面的
                // header unshift 置 true，再用它取反会把首落盘也当成扇出写（allowCreate
                // =false），目录缺失 → session-gone 死循环（ed23473 引入，02:17 实测炸）。
                await backend.AISessionAppend(session.id, encodeSessionLines(events), !state.logCreated);
            }
        } catch (e) {
            restoreLogState(session, state);
            throw e;
        }
        const wrote = events.length > 0;
        await writeMetaIfChanged(session, wrote);
        // 只有真的写了日志才刷新 _logStat；meta-only 的扇出写不额外打一次 Wails 往返。
        if (wrote) await refreshStat(session);
    }

    // 归档必须先于调用方裁剪 messages 执行：这里捕获裁剪前的快照，
    // 保证被移动的消息先落进日志，再追加 archive 事件。
    // 三个「整份重写日志」的入口（归档 / 清空 / 重写）绝不能作用在懒加载占位上：占位的
    // messages 是空的，重写等于把历史抹平。对应 dsh 那条「根本没有 save 整个会话的 API」——
    // 我们这边 rewrite 能力还在，所以把护栏钉在入口。调用方一律先 hydrateSession 再进来。
    function requireBody(session) {
        if (session && session._stub) {
            throw new Error('会话正文尚未加载，禁止改写磁盘历史（' + session.id + '）');
        }
    }

    function archiveSession(session, keep, summary) {
        if (!session || !session.id) return;
        requireBackend();
        requireBody(session);
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
                    // S3 重写收窄：归档先出栈到 sidecar，再只写 live；出栈失败回退旧路径。
                    const spill = await ensureArchivedSpilled(session);
                    await adoptVacuumSpill(session, spill);
                    const events = buildRewriteEvents(session);
                    await backend.AISessionRewrite(session.id, encodeSessionLines(events));
                } catch (e) {
                    restoreLogState(session, state);
                    throw e;
                }
                await writeMetaIfChanged(session, true);
                await refreshStat(session);
                return;
            }
            const mids = midsNow;
            const archivedMids = archivedMidsNow;
            const fps = fingerprintsOf(session);
            await prepareImages(session, snapshot);
            const events = [];
            let common = 0;
            while (common < mids.length && common < snapshot.length &&
                   textOf(snapshot[common] && snapshot[common]._mid) === mids[common] &&
                   fps.get(mids[common]) === messageFingerprint(snapshot[common])) {
                common++;
            }
            if (common < mids.length) {
                events.push(encodeTruncateEvent(common));
                for (let i = common; i < mids.length; i++) if (mids[i]) fps.delete(mids[i]);
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
                fps.set(mid, messageFingerprint(message));
                const event = encodeMessageEvent(message, mid, false);
                if (event) events.push(event);
            }
            events.push(encodeArchiveEvent(keepCount, summary));
            try {
                // keep 是保留数：[0, keep) 移入归档，[keep, end) 留在live。
                session._mids = mids.slice(keepCount);
                session._archivedMids = archivedMids.concat(mids.slice(0, keepCount));
                ensureHeaderEvent(session, events);
                // 同 runPersistSession：allowCreate 看进门快照，不能用已被 header unshift
                // 置位的 _logCreated（否则归档路径的首落盘同样进 GONE 死循环）。
                await backend.AISessionAppend(session.id, encodeSessionLines(events), !state.logCreated);
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
            await refreshStat(session);
        });
    }

    function resetSession(session) {
        if (!session || !session.id) return;
        requireBackend();
        requireBody(session);
        return enqueue(session.id, async () => {
            const state = snapshotLogState(session);
            try {
                session._mids = [];
                session._archivedMids = [];
                session._fps = new Map();
                const events = [encodeSessionHeader(session)];
                if (session.summary) events.push(encodeMetaEvent({summary: session.summary}));
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
                session._logCreated = true;
                session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
                // 清空的语义是「抹掉全部消息」：归档 sidecar 若保留，重启后归档卡会凭
                // 侧车探测复活。用户显式发起的销毁，与 Remove 同级（旧后端尽力而为）；
                // 侧车计数只在删除成功后才归零（失败保留旧值，避免 UI 短暂矛盾）。
                if (backend.AISessionArchiveClear) {
                    try {
                        await backend.AISessionArchiveClear(session.id);
                        session._archiveSidecarTotal = 0;
                    } catch (e) {}
                }
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
            await refreshStat(session);
        });
    }

    function rewriteSession(session) {
        if (!session || !session.id) return;
        requireBackend();
        requireBody(session);
        return enqueue(session.id, async () => {
            const state = snapshotLogState(session);
            try {
                await prepareImages(session, (session.archived || []).concat(session.messages || []));
                // S3 重写收窄：迁移/归一化场景同样先出栈归档再只写 live。
                const spill = await ensureArchivedSpilled(session);
                await adoptVacuumSpill(session, spill);
                const events = buildRewriteEvents(session);
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
            await refreshStat(session);
        });
    }

    // 启动读盘并发度：每个会话都要整份重放 JSONL（几十个会话、单个几 MB 时串行 await
    // 叠加 Wails 往返能把面板空白拖到好几秒）。6 路足够摊平 IO，也不至于让 WebView
    // 同时持有过多大字符串；结果按下标回填，顺序与原串行实现一致。
    const LOAD_CONCURRENCY = 6;

    // ---------- 超限自动整理（方案 §5.2 S2：256 MB 从「拒绝服务」改为「打开即自动整理」） ----------

    // 读正文；撞上 session-too-large: 时自动 AISessionVacuum（唯一自动写盘路径，理由链
    // 见方案 §5.2）后重读。错误对象带三类标记供拒载卡片分流：
    //   tooLarge    —— 稳定前缀命中（超限家族）
    //   tidyFailed  —— 自动整理执行失败（磁盘错误 / 另一窗口占用）→ 卡片「重试整理」
    //   liveDominant —— 整理后 live 段自身仍超限（真空角落）→ 卡片「临时加载」
    async function readBodyAutoTidy(id) {
        let text = '';
        try {
            text = await backend.AISessionRead(id);
            return {text, tidy: null};
        } catch (e) {
            const msg = String((e && e.message) || e);
            const tooLarge = new Error(msg);
            tooLarge.tooLarge = msg.startsWith(SESSION_TOO_LARGE_PREFIX);
            if (!tooLarge.tooLarge || !backend.AISessionVacuum) throw tooLarge;
            let tidy = null;
            try {
                tidy = await backend.AISessionVacuum(id, false);
            } catch (vacuumErr) {
                const err = new Error('自动整理失败：' + String((vacuumErr && vacuumErr.message) || vacuumErr));
                err.tooLarge = true;
                err.tidyFailed = true;
                throw err;
            }
            if (tidy && tidy.liveDominant) {
                tooLarge.liveDominant = true;
                tooLarge.tidyResult = tidy;
                throw tooLarge;
            }
            try {
                text = await backend.AISessionRead(id);
            } catch (retryErr) {
                const retryMsg = String((retryErr && retryErr.message) || retryErr);
                const err = new Error(retryMsg);
                err.tooLarge = retryMsg.startsWith(SESSION_TOO_LARGE_PREFIX);
                err.liveDominant = err.tooLarge; // 已整理过仍超限 = live 主导
                err.tidyResult = tidy;
                throw err;
            }
            return {text, tidy};
        }
    }

    // 归档侧车记账：自动整理成功时用 vacuum 统计；否则在 stat 报告 sidecar 存在时探测一次
    // 总数。混合态（vacuum 过又压缩过）下内存归档非空也要探测——侧车历史与内存归档互不
    // 重叠，消费点按「侧车 + 内存」合并展示，少探测会把侧车历史藏没（审查发现的 P1）。
    async function syncArchiveSidecarMeta(session, tidy) {
        if (!session || !session.id) return;
        if (tidy && typeof tidy.sidecarLines === 'number') {
            session._archiveSidecarTotal = Math.max(0, Number(tidy.sidecarLines) || 0);
            return;
        }
        const stat = session._logStat;
        if (!stat || !stat.archiveExists) return;
        if (!backend.AISessionReadArchive) return;
        try {
            const page = await backend.AISessionReadArchive(session.id, 0, 0);
            session._archiveSidecarTotal = Math.max(0, Number(page && page.total) || 0);
        } catch (e) {
            // 探测失败不阻塞加载：卡片与对话框按需再试。
        }
    }

    // 分页读回 sidecar 归档（消费点共用）：返回消息数组与总数；offset 语义与
    // Go AISessionReadArchive 一致（非空事件行）。
    async function readArchivedPage(id, offset, limit) {
        if (!backend.AISessionReadArchive) return {messages: [], total: 0};
        const page = await backend.AISessionReadArchive(id, Math.max(0, offset || 0), Math.max(0, limit || 0));
        const events = Array.isArray(page && page.events) ? page.events : [];
        const replay = events.length ? replaySessionLog(events.join('\n') + '\n') : replaySessionLog('');
        return {
            messages: replay.archived || [],
            total: Math.max(0, Number(page && page.total) || 0),
        };
    }

    async function loadOne(meta, normalizeSession) {
        let replay = replaySessionLog('');
        let loadError = '';
        let loadErrorFlags = null;
        let bodyText = '';
        let tidy = null;
        try {
            const read = await readBodyAutoTidy(meta.id);
            bodyText = read.text;
            tidy = read.tidy;
            replay = replaySessionLog(bodyText);
        } catch (e) {
            loadError = (e && e.message) || String(e);
            loadErrorFlags = e;
        }
        const combined = Object.assign({}, meta, {
            messages: replay.messages,
            archived: replay.archived,
            summary: meta.summary && typeof meta.summary === 'object' ? meta.summary : replay.summary,
        });
        const session = normalizeSession ? normalizeSession(combined) : combined;
        if (!session) return null;
        // 归一化可能丢掉无效消息，_mids 必须按归一化后的消息顺序重建，否则索引错位会触发重复追加。
        session._mids = (session.messages || []).map((message) => textOf(message && message._mid));
        session._archivedMids = (session.archived || []).map((message) => textOf(message && message._mid));
        // 刚读出来的消息就是磁盘状态，指纹按当前内容建立基线。
        resetFingerprints(session, session.messages);
        session._logMeta = {title: textOf(meta.title), workspace: textOf(meta.workspace)};
        session._logCreated = !!replay.header;
        // 重放折叠掉的同类 dedupeKey 旧注入（droppedTransient>0）也要整份重写：
        // 内存已不含这些条目，不重写的话磁盘 JSONL 里的冗余行永远清不掉。
        session._needsRewrite = !!session._recovered || (session.messages || []).length !== replay.messages.length || replay.droppedTransient > 0;
        session.updatedAt = Number(meta.updatedAt) || Number(meta.createdAt) || 0;
        session._loadError = loadError;
        session._tidyFailed = !!(loadErrorFlags && loadErrorFlags.tidyFailed);
        session._liveDominant = !!(loadErrorFlags && loadErrorFlags.liveDominant);
        session._metaSig = metaSignature(buildSessionMeta(session));
        await hydrateImages(session);
        await refreshStat(session);
        await syncArchiveSidecarMeta(session, tidy);
        if (tidy && onTidy) {
            try {
                onTidy(meta.id, tidy);
            } catch (e) {}
        }
        return session;
    }

    // 临时会话（meta.temp）：落盘只作留档，列表里不该出现——启动加载与磁盘重读一律滤掉，
    // 这样才能做到「关闭应用就没了」。会话本体还活在内存里（用户删它走正常删除路径），
    // 所以调用方需要时传 includeTemp 才读得回来（诊断 / 测试用）。
    function keepMeta(meta, includeTemp) {
        if (!meta || !meta.id) return false;
        if (!includeTemp && isTransientSession({temp: meta.temp})) return false;
        return true;
    }

    async function loadAll(normalizeSession, opts) {
        requireBackend();
        const includeTemp = !!(opts && opts.includeTemp);
        let metas = [];
        try {
            metas = await backend.AISessionList();
        } catch (e) {
            throw e;
        }
        const parsed = [];
        for (const item of metas || []) {
            let meta = null;
            try {
                meta = JSON.parse(item);
            } catch (e) {
                continue;
            }
            if (keepMeta(meta, includeTemp)) parsed.push(meta);
        }
        const loaded = new Array(parsed.length).fill(null);
        let cursor = 0;
        async function worker() {
            while (cursor < parsed.length) {
                const index = cursor++;
                const meta = parsed[index];
                // 单个会话读坏不影响整轮加载：与串行的 loadError 语义一致
                try {
                    loaded[index] = await loadOne(meta, normalizeSession);
                } catch (e) {
                    loaded[index] = null;
                }
            }
        }
        const workers = [];
        const lanes = Math.min(LOAD_CONCURRENCY, parsed.length);
        for (let i = 0; i < lanes; i++) workers.push(worker());
        await Promise.all(workers);
        return loaded.filter(Boolean);
    }

    // ---------- 懒加载：先只要 meta，正文按需补 ----------
    // 列表页只用到 meta（标题/时间/条数/未读/置顶/工作区/待办/摘要…），正文整份重放是启动
    // 几十个会话时的主要开销。启动先 loadMetas 画列表，正文交给 hydrateSession 按需补。

    async function loadMetas(opts) {
        requireBackend();
        const includeTemp = !!(opts && opts.includeTemp);
        const raw = await backend.AISessionList();
        const metas = [];
        for (const item of raw || []) {
            let meta = null;
            try {
                meta = JSON.parse(item);
            } catch (e) {
                continue;
            }
            if (keepMeta(meta, includeTemp)) metas.push(meta);
        }
        return metas;
    }

    // 把单个占位会话的正文就地补上：对象引用不变（列表、桥、通知里拿的都是同一个对象）。
    // 失败时退化成「正文不可用」：清掉占位标记 + 打 _loadError（等于禁止写盘），由既有错误 UI 兜住。
    // 把 meta 列表变成「占位会话」：只有列表字段，正文待 hydrateSession 补。
    // normalizeSession 由调用方给（与启动读盘同一套字段归一），保证两条路径形状一致。
    function toStubs(metas, normalizeSession) {
        const out = [];
        for (const meta of metas || []) {
            const session = normalizeSession ? normalizeSession(meta, out.length) : Object.assign({}, meta);
            if (!session) continue;
            session._stub = true;
            session._msgCount = Math.max(0, Number(meta.messageCount) || 0);
            session._archivedCount = Math.max(0, Number(meta.archivedCount) || 0);
            // 排序键缓存：占位没有正文，列表的时间与顺序只能读 meta 里的结束时间 / 轮次起点
            session._turnTs = Math.max(0, Number(meta.turnTs) || 0);
            session._endTs = Math.max(0, Number(meta.endTs) || 0);
            session._metaSig = metaSignature(buildSessionMeta(session));
            out.push(session);
        }
        return out;
    }

    async function hydrateSession(session) {
        if (!session || !session.id) return false;
        if (!session._stub) return true;
        requireBackend();
        let replay = replaySessionLog('');
        let tidy = null;
        try {
            const read = await readBodyAutoTidy(session.id);
            tidy = read.tidy;
            replay = replaySessionLog(read.text);
        } catch (e) {
            delete session._stub;
            delete session._msgCount;
            delete session._archivedCount;
            session._loadError = (e && e.message) || String(e);
            session._tidyFailed = !!(e && e.tidyFailed);
            session._liveDominant = !!(e && e.liveDominant);
            return false;
        }
        const normalize = typeof options.normalizeMessage === 'function' ? options.normalizeMessage : null;
        const messages = normalize ? replay.messages.map(normalize).filter(Boolean) : replay.messages;
        session.messages = messages;
        session.archived = replay.archived || [];
        if (!session.summary && replay.summary) session.summary = replay.summary;
        session._recovered = messages.some((message) => message && message._recovered);
        // 归一化可能丢掉无效消息，_mids 必须按归一化后的顺序重建，否则索引错位会重复追加。
        session._mids = messages.map((message) => textOf(message && message._mid));
        session._archivedMids = session.archived.map((message) => textOf(message && message._mid));
        resetFingerprints(session, messages);
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        session._logCreated = !!replay.header;
        // 重放折叠掉的同类 dedupeKey 旧注入也要整份重写（与 loadOne 同理，清磁盘冗余）。
        session._needsRewrite = !!session._recovered || messages.length !== replay.messages.length || replay.droppedTransient > 0;
        session._metaSig = metaSignature(buildSessionMeta(session));
        delete session._stub;
        delete session._msgCount;
        delete session._archivedCount;
        await hydrateImages(session);
        await refreshStat(session);
        await syncArchiveSidecarMeta(session, tidy);
        if (tidy && onTidy) {
            try {
                onTidy(session.id, tidy);
            } catch (e) {}
        }
        return true;
    }

    // 多个会话并发补水（启动的热会话用）。返回补成功的条数。
    async function hydrateSessions(list) {
        const targets = (list || []).filter((session) => session && session._stub);
        let cursor = 0;
        let done = 0;
        async function worker() {
            while (cursor < targets.length) {
                const index = cursor++;
                try {
                    if (await hydrateSession(targets[index])) done++;
                } catch (e) {}
            }
        }
        const lanes = Math.min(LOAD_CONCURRENCY, targets.length);
        const workers = [];
        for (let i = 0; i < lanes; i++) workers.push(worker());
        await Promise.all(workers);
        return done;
    }

    // refreshStat 刷新会话正文的磁盘基线；交接协议比较它判断“另一个窗口写过”。
    async function refreshStat(session) {
        if (!session || !session.id || !backend.AISessionStat) return null;
        try {
            session._logStat = await backend.AISessionStat(session.id) || null;
        } catch (e) {
            session._logStat = null;
        }
        return session._logStat;
    }

    // reloadSession 在拿到回合租约、发现日志 stat 与内存基线不一致时整份重放。
    // 不能只追加：retry/edit 的 truncate 依赖 _mids 与磁盘一致，旧前缀会截掉
    // 另一个窗口已经提交的消息。
    async function reloadSession(session) {
        if (!session || !session.id) return false;
        requireBackend();
        let tidy = null;
        let bodyText = '';
        try {
            const read = await readBodyAutoTidy(session.id);
            tidy = read.tidy;
            bodyText = read.text;
        } catch (e) {
            // 重读撞上超限（另一窗口写入把正文推过了上限）：标记后交给拒载卡片，
            // 不把错误吞成「重读成功」。
            session._loadError = (e && e.message) || String(e);
            session._tidyFailed = !!(e && e.tidyFailed);
            session._liveDominant = !!(e && e.liveDominant);
            throw e;
        }
        // 已有会话读到空日志 = 已被另一窗口删除；不能当成“新会话”重放，
        // 否则 _logCreated 被清掉，下一次 Append 会把目录重建出来。
        if (!bodyText && session._logCreated) {
            const err = new Error('session-gone: 会话已被删除');
            err.code = 'session-gone';
            throw err;
        }
        await applySessionReplay(session, replaySessionLog(bodyText));
        session._loadError = '';
        session._tidyFailed = false;
        session._liveDominant = false;
        await hydrateImages(session);
        await refreshStat(session);
        await syncArchiveSidecarMeta(session, tidy);
        if (tidy && onTidy) {
            try {
                onTidy(session.id, tidy);
            } catch (e) {}
        }
        return true;
    }

    // 真空角落的「临时加载」（方案 §5.4）：live 段自身超限时用户显式要求整份读入，
    // 载入后可正常对话，压缩一次即回归常态。与 reloadSession 共用装配。
    async function reloadSessionForce(session) {
        if (!session || !session.id) return false;
        requireBackend();
        const bodyText = await backend.AISessionReadForce(session.id);
        if (!bodyText && session._logCreated) {
            const err = new Error('session-gone: 会话已被删除');
            err.code = 'session-gone';
            throw err;
        }
        await applySessionReplay(session, replaySessionLog(bodyText));
        session._loadError = '';
        session._tidyFailed = false;
        session._liveDominant = false;
        await hydrateImages(session);
        await refreshStat(session);
        await syncArchiveSidecarMeta(session, null);
        return true;
    }

    // 重放结果装配（reloadSession / reloadSessionForce / hydrate 的公共尾部）。
    async function applySessionReplay(session, replay) {
        const normalize = typeof options.normalizeMessage === 'function' ? options.normalizeMessage : null;
        const messages = normalize ? replay.messages.map(normalize).filter(Boolean) : replay.messages;
        session.messages = messages;
        session.archived = replay.archived || [];
        if (replay.summary) session.summary = replay.summary;
        session._recovered = messages.some((message) => message && message._recovered);
        // 归一化可能丢掉无效消息，_mids 必须按归一化后的顺序重建。
        session._mids = messages.map((message) => textOf(message && message._mid));
        session._archivedMids = session.archived.map((message) => textOf(message && message._mid));
        resetFingerprints(session, messages);
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        session._logCreated = !!replay.header;
        // 重放折叠掉的同类 dedupeKey 旧注入也要整份重写（与 loadOne 同理，清磁盘冗余）。
        session._needsRewrite = !!session._recovered || messages.length !== replay.messages.length || replay.droppedTransient > 0;
        session._metaSig = metaSignature(buildSessionMeta(session));
        delete session._stub;
        delete session._msgCount;
        delete session._archivedCount;
    }

    // sameLogStat 供交接协议比较 AISessionStat 与内存基线。
    function sameLogStat(a, b) {
        const left = a || {};
        const right = b || {};
        return !!left.exists === !!right.exists
            && Number(left.mtimeMs) === Number(right.mtimeMs)
            && Number(left.size) === Number(right.size);
    }

    async function hydrateImages(session) {
        const lists = [session.messages, session.archived];
        for (const list of lists) {
            for (const message of list || []) {
                if (!message) continue;
                if (Array.isArray(message.images) && backend.AISessionReadImage) {
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
                if (Array.isArray(message.videos) && backend.AISessionReadVideo) {
                    for (const video of message.videos) {
                        if (!video || video.data || !video.file) continue;
                        const name = textOf(video.file).replace(/^videos[\\/]/, '');
                        if (!name || name.includes('/') || name.includes('\\')) continue;
                        try {
                            const url = await backend.AISessionReadVideo(session.id, name);
                            const marker = 'base64,';
                            const index = textOf(url).indexOf(marker);
                            if (index >= 0) video.data = textOf(url).slice(index + marker.length);
                        } catch (e) {}
                    }
                }
            }
        }
    }

    async function removeSession(id) {
        requireBackend();
        await flush();
        const result = await backend.AISessionDelete(id);
        // 会话级产物随会话一起删（ai-artifacts/<会话 id>/）：正文都没了，指针必然失效，
        // 留着只是磁盘垃圾。清理失败不影响删除本身。
        if (backend.AIArtifactClear) {
            try {
                await backend.AIArtifactClear(id);
            } catch (e) {}
        }
        return result;
    }

    async function removeAll() {
        requireBackend();
        await flush();
        if (!backend.AISessionDeleteAll) throw new Error('当前版本缺少批量删除接口');
        const result = await backend.AISessionDeleteAll();
        if (backend.AIArtifactClearAll) {
            try {
                await backend.AIArtifactClearAll();
            } catch (e) {}
        }
        return result;
    }

    // 手动「瘦身归档」（右键入口，≥16 MB 显示）：force vacuum + 内存对账 + 整份重读。
    // 调用方必须先确认该会话没有在跑的回合（流式消息不落盘，重放会把它从内存里甩掉）。
    function vacuumSessionArchive(session) {
        if (!session || !session.id) return Promise.resolve(null);
        requireBackend();
        if (!backend.AISessionVacuum) return Promise.reject(new Error('当前版本缺少会话整理接口：AISessionVacuum'));
        return enqueue(session.id, async () => {
            const result = await backend.AISessionVacuum(session.id, true);
            await adoptVacuumSpill(session, result);
            if (result && result.changed) await reloadSession(session);
            return result;
        });
    }

    // 归档侧车分页读回（归档卡 / 对话框 / 导出的消费通道）。
    function readArchivePage(id, offset, limit) {
        return readArchivedPage(id, offset, limit);
    }

    return {
        loadAll,
        loadMetas,
        toStubs,
        hydrateSession,
        hydrateSessions,
        persistSession,
        invalidateMessage,
        archiveSession,
        resetSession,
        rewriteSession,
        removeSession,
        removeAll,
        flush,
        whenIdle,
        refreshStat,
        reloadSession,
        reloadSessionForce,
        vacuumSessionArchive,
        readArchivePage,
        sameLogStat,
        hydrateImages,
        newMid,
    };
}

// ---------- 对话日志自动落盘（方案 M3 从 ai-panel.js 搬入） ----------
// Markdown 构建（含工具 / ask / 图片附件）+ 图片归档 + 400ms 防抖后按会话串行排队。
// 目录定位（应用数据 ai-logs）、配置开关与审批文案（askStateLabel / askResultText）
// 由宿主注入——本模块不碰面板闭包。
export function createAIConversationLog(ctx) {
    const backend = ctx.backend || {};
    const getConfig = ctx.getConfig;
    const ensureLogDir = ctx.ensureLogDir;
    const persistSessions = ctx.persistSessions;
    const flash = ctx.flash;
    const notifyFailure = typeof ctx.notifyFailure === 'function' ? ctx.notifyFailure : () => {};
    const askStateLabel = ctx.askStateLabel;
    const askResultText = ctx.askResultText;
    const joinPath = ctx.joinPath;

    let logSaveErrorShown = false;
    const logTimers = new Map();
    const logQueues = new Map();

    function logTimestamp(ts) {
        return new Date(Number(ts) || Date.now()).toLocaleString();
    }

    function logTruncate(text, max) {
        const value = textOf(text);
        if (value.length <= max) return value;
        return value.slice(0, max) + '\n…（已截断 ' + (value.length - max) + ' 字符）';
    }

    function appendAskMarkdown(lines, ask) {
        if (!ask) return;
        (ask.questions || []).forEach((question, index) => {
            lines.push('问题 ' + (index + 1) + '：' + question.question, '');
            for (const option of question.options || []) {
                lines.push('- ' + option.label + (option.recommended ? '（推荐）' : '') +
                    (option.description ? ' — ' + option.description : ''));
            }
            const answer = (ask.answers || []).find((item) => item.id === question.id) || {};
            const selected = Array.isArray(answer.selected) ? answer.selected : [];
            if (selected.length) lines.push('回答：' + selected.join('、'));
            if (answer.custom) lines.push('补充：' + answer.custom);
            if (!selected.length && !answer.custom) lines.push('回答：（未回答）');
            lines.push('');
        });
        const result = askResultText(ask);
        if (result) lines.push('状态：' + askStateLabel(ask) + ' · ' + result, '');
    }

    function appendLogMessage(lines, message, level) {
        if (!message || !message.role) return;
        if (message.role === 'user') {
            if (message.kind === 'model-switch') {
                if (message.content) lines.push('> ' + message.content, '');
                return;
            }
            const images = (message.images || []).map(aiNormalizeImage).filter(Boolean);
            const videos = (message.videos || []).filter((video) => video && (video.data || video.file));
            if (!message.content && !images.length && !videos.length) return;
            lines.push(level + ' 用户 · ' + logTimestamp(message.ts), '');
            if (message.content) lines.push(message.content, '');
            for (const image of images) {
                if (image.logFile) lines.push('![图片](<' + image.logFile + '>)', '');
            }
            for (const video of videos) {
                lines.push('（视频附件：' + (video.file || video.name || 'video') + '）', '');
            }
            return;
        }
        if (message.role === 'tool') {
            lines.push(level + ' 工具：' + (message.name || 'tool') + ' · ' + (message.status || 'done'), '');
            if (message.arguments) lines.push('参数：`' + logTruncate(message.arguments, 4000) + '`', '');
            if (message.ask) appendAskMarkdown(lines, message.ask);
            lines.push('```text', logTruncate(message.content || '（无输出）', 50000), '```', '');
            return;
        }
        if (!message.content && !message.reasoning && !(message.toolCalls || []).length && !message.error) return;
        lines.push(level + ' AI' + (message.model ? '（' + message.model + '）' : '') + ' · ' + logTimestamp(message.ts), '');
        if (message.turnMs) lines.push('用时：' + aiFormatDuration(message.turnMs), '');
        if (message.reasoning) {
            lines.push('<details>', '<summary>思考过程</summary>', '', message.reasoning, '', '</details>', '');
        }
        if (message.content) lines.push(message.content, '');
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
            lines.push('工具调用：' + message.toolCalls.map((call) => call.name).filter(Boolean).join('、'), '');
        }
        if (message.usage && message.usage.totalTokens) {
            lines.push('tokens：输入 ' + (message.usage.promptTokens || 0) + ' · 输出 ' + (message.usage.completionTokens || 0) +
                ' · 合计 ' + message.usage.totalTokens, '');
        }
        if (message.status === 'error' && message.error) lines.push('> 错误：' + message.error, '');
    }

    // 对话日志的归档侧车预算：vacuum 后归档正文只存 sidecar（可能几十万条），自动落盘
    // 每轮都会跑，全量读回会把日志拖成巨文档。取最近的 ARCHIVE cap 条（时间序尾部，
    // 紧邻内存归档），更早的留给「导出 Markdown」（导出全量读回）。
    const LOG_SIDECAR_ARCHIVED_CAP = 200;

    // 读回 sidecar 归档的尾部（尽力而为：缺绑定 / 读失败都退化为空）。
    async function loadSidecarArchived(session, cap) {
        if (!backend.AISessionReadArchive || !session || !session.id) {
            return {messages: [], total: 0};
        }
        try {
            const head = await backend.AISessionReadArchive(session.id, 0, 0);
            const total = Math.max(0, Number(head && head.total) || 0);
            if (!total) return {messages: [], total: 0};
            const limit = Math.min(total, Math.max(0, Number(cap) || 0));
            const offset = Math.max(0, total - limit);
            const page = await backend.AISessionReadArchive(session.id, offset, limit);
            const events = Array.isArray(page && page.events) ? page.events : [];
            const replay = events.length ? replaySessionLog(events.join('\n') + '\n') : replaySessionLog('');
            return {messages: replay.archived || [], total};
        } catch (e) {
            return {messages: [], total: 0};
        }
    }

    function buildConversationLogMarkdown(session, archivedOverride, omittedArchived) {
        const config = getConfig();
        const lines = ['# ' + (session.title || 'AI 会话'), ''];
        lines.push('- 会话 ID：`' + session.id + '`');
        lines.push('- 创建时间：' + new Date(Number(session.createdAt) || Date.now()).toLocaleString());
        lines.push('- 最近更新：' + new Date().toLocaleString());
        const profile = config.profiles.find((item) => item.id === session.profileId);
        if (profile) lines.push('- 最后配置：' + profile.name + (profile.model ? '（' + profile.model + '）' : ''));
        lines.push('');
        if (session.summary && session.summary.text) {
            lines.push('## 会话摘要', '', session.summary.text, '');
        }
        // 归档 = sidecar 尾部（vacuum 前的历史）+ 内存归档（vacuum 后新增的压缩）。
        const archived = Array.isArray(archivedOverride)
            ? archivedOverride
            : (Array.isArray(session.archived) ? session.archived : []);
        if (archived.length) {
            lines.push('## 已归档消息（压缩前，不进入当前上下文）', '');
            const omitted = Math.max(0, Number(omittedArchived) || 0);
            if (omitted) {
                lines.push('> 另有 ' + omitted + ' 条更早的归档在会话侧车中，此处省略；完整历史用「导出 Markdown」。', '');
            }
            for (const message of archived) appendLogMessage(lines, message, '###');
            lines.push('');
        }
        lines.push('## 当前对话', '');
        for (const message of session.messages) appendLogMessage(lines, message, '###');
        if (Array.isArray(session.changes) && session.changes.length) {
            lines.push('', '## 变更记录', '');
            for (const change of session.changes) {
                lines.push('- `' + (change.relPath || change.path) + '` +' + change.added + ' −' + change.removed +
                    ' · ' + new Date(change.time).toLocaleString());
            }
        }
        return lines.join('\n');
    }

    async function saveConversationLog(session) {
        const config = getConfig();
        if (!config.logEnabled || !session) return;
        if (!backend.SaveFile || !backend.SaveDataURL) return;
        try {
            const dir = await ensureLogDir();
            if (!session.logFile) {
                session.logFile = aiSafeFileStem(session.title || 'AI 会话') + '-' + String(session.id).slice(-8) + '.md';
            }
            // S1 消费点接线：归档 = 内存 + sidecar 尾部（超过 cap 的部分注明省略）。
            const sidecar = await loadSidecarArchived(session, LOG_SIDECAR_ARCHIVED_CAP);
            const memoryArchived = Array.isArray(session.archived) ? session.archived : [];
            const archived = sidecar.messages.concat(memoryArchived);
            const omitted = Math.max(0, sidecar.total - sidecar.messages.length);
            const messages = archived.concat(session.messages);
            const imagesDir = joinPath(dir, 'images');
            let imagesSaved = false;
            let imagesDirReady = false;
            for (const message of messages) {
                if (!message || message.role !== 'user' || !Array.isArray(message.images)) continue;
                for (let i = 0; i < message.images.length; i++) {
                    const image = aiNormalizeImage(message.images[i]);
                    if (!image) continue;
                    message.images[i] = image;
                    if (!image.logFile && image.data) {
                        if (!imagesDirReady) {
                            if (backend.AIEnsureDir) await backend.AIEnsureDir(imagesDir);
                            imagesDirReady = true;
                        }
                        const name = aiSafeFileStem(String(session.id).slice(-16) + '-' + (image.id || aiNowId('img-')))
                            .replace(/\s+/g, '_').slice(0, 100) + '.' + aiImageExt(image.mime);
                        const rel = 'images/' + name;
                        await backend.SaveDataURL(joinPath(imagesDir, name), aiImageSrc(image));
                        image.logFile = rel;
                        imagesSaved = true;
                    }
                }
            }
            if (imagesSaved) persistSessions();
            const markdown = buildConversationLogMarkdown(session, archived, omitted);
            await backend.SaveFile(joinPath(dir, session.logFile), markdown, 'lf', false, 'utf-8');
            session.logSavedAt = Date.now();
            persistSessions();
        } catch (e) {
            if (!logSaveErrorShown) {
                logSaveErrorShown = true;
                const detail = String((e && e.message) || e);
                flash('对话日志保存失败：' + detail, true);
                // A 级：日志落盘失败意味着会话 Markdown 留存没写出去，需用户回来处理。
                notifyFailure('对话日志保存失败', detail, {key: 'log-save', kind: 'error'});
            }
        }
    }

    function queueLogSave(session) {
        if (!getConfig().logEnabled || !session) return;
        const existing = logTimers.get(session.id);
        if (existing) clearTimeout(existing);
        logTimers.set(session.id, setTimeout(() => {
            logTimers.delete(session.id);
            const previous = logQueues.get(session.id) || Promise.resolve();
            const next = previous.catch(() => {}).then(() => saveConversationLog(session));
            logQueues.set(session.id, next);
            next.finally(() => {
                if (logQueues.get(session.id) === next) logQueues.delete(session.id);
            });
        }, 400));
    }

    return {queueLogSave, saveConversationLog, buildConversationLogMarkdown, appendAskMarkdown};
}
