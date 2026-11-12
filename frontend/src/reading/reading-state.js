// 阅读状态持久化（docs/reading-mode.md §8.1）：
// localStorage key "datalens-reading-state"，版本化；进度/书签/统计不进设置。
// storage 可注入（Node --test 用内存 mock）。

import {normalizeBookKey} from './reading-model.js';

export const READING_STATE_KEY = 'datalens-reading-state';
const STATE_VERSION = 1;
const RECENT_MAX = 10;
const DAILY_KEEP_DAYS = 365;
const WRITE_DEBOUNCE_MS = 500;

function emptyState() {
    return {version: STATE_VERSION, books: {}, recent: []};
}

function todayKey(now) {
    const d = now instanceof Date ? now : new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
}

function yesterdayKey(now) {
    const d = now instanceof Date ? new Date(now.getTime()) : new Date();
    d.setDate(d.getDate() - 1);
    return todayKey(d);
}

// createReadingState 创建状态存储实例。
export function createReadingState(storage) {
    const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!ls) throw new Error('reading-state 需要 storage');

    let state = loadState(ls);
    let saveTimer = 0;

    function loadState(store) {
        try {
            const raw = store.getItem(READING_STATE_KEY);
            if (!raw) return emptyState();
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return emptyState();
            if (parsed.version !== STATE_VERSION) return migrate(parsed);
            if (!parsed.books || typeof parsed.books !== 'object') parsed.books = {};
            if (!Array.isArray(parsed.recent)) parsed.recent = [];
            return parsed;
        } catch (e) {
            return emptyState();
        }
    }

    // migrate 旧版本 schema：v1 之前没有历史版本，损坏数据直接重建。
    function migrate(old) {
        const next = emptyState();
        if (old && old.books && typeof old.books === 'object') next.books = old.books;
        if (old && Array.isArray(old.recent)) next.recent = old.recent;
        return next;
    }

    function persist(immediate) {
        clearTimeout(saveTimer);
        const write = () => {
            saveTimer = 0;
            try {
                ls.setItem(READING_STATE_KEY, JSON.stringify(state));
            } catch (e) { /* 配额满：忽略，下次再写 */ }
        };
        if (immediate) write();
        else saveTimer = setTimeout(write, WRITE_DEBOUNCE_MS);
    }

    function book(key, create) {
        const k = normalizeBookKey(key);
        if (!k) return null;
        if (!state.books[k]) {
            if (!create) return null;
            state.books[k] = {
                root: '',
                title: '',
                profile: '',
                chapterLevel: null,
                lastUnitId: '',
                lastUnitTitle: '',
                lastUnitOrdinal: 0,
                lastRel: '',
                scrollRatio: 0,
                progress: 0,
                updatedAt: 0,
                bookmarks: [],
                stats: {totalSec: 0, sessions: 0, daily: {}, streak: 0, lastReadDate: ''},
            };
        }
        const b = state.books[k];
        if (!b.stats || typeof b.stats !== 'object') b.stats = {totalSec: 0, sessions: 0, daily: {}, streak: 0, lastReadDate: ''};
        if (!Array.isArray(b.bookmarks)) b.bookmarks = [];
        if (!b.stats.daily || typeof b.stats.daily !== 'object') b.stats.daily = {};
        return b;
    }

    return {
        // ---- 书进度 ----
        getBook(key) {
            const b = book(key, false);
            return b ? JSON.parse(JSON.stringify(b)) : null;
        },
        updateBook(key, fields) {
            const b = book(key, true);
            Object.assign(b, fields);
            b.updatedAt = Date.now();
            persist(false);
        },
        setProgress(key, patch) {
            // patch: {lastUnitId, lastUnitTitle, lastUnitOrdinal, lastRel, scrollRatio, progress}
            this.updateBook(key, patch);
        },

        // ---- 最近阅读 ----
        recent() {
            return state.recent.slice();
        },
        touchRecent(key) {
            const k = normalizeBookKey(key);
            if (!k) return;
            state.recent = [k].concat(state.recent.filter((x) => x !== k)).slice(0, RECENT_MAX);
            persist(false);
        },
        forgetBook(key) {
            const k = normalizeBookKey(key);
            delete state.books[k];
            state.recent = state.recent.filter((x) => x !== k);
            persist(true);
        },

        // ---- 书签（§8.4） ----
        addBookmark(key, entry) {
            const b = book(key, true);
            const dup = b.bookmarks.find((x) => x.unitId === entry.unitId &&
                Math.abs((x.ratio || 0) - (entry.ratio || 0)) < 0.02);
            if (dup) return {ok: false, existing: dup};
            const bm = {
                id: 'bm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
                unitId: entry.unitId,
                rel: entry.rel || '',
                title: entry.title || '',
                ratio: entry.ratio || 0,
                excerpt: String(entry.excerpt || '').slice(0, 40),
                createdAt: Date.now(),
            };
            b.bookmarks.push(bm);
            persist(false);
            return {ok: true, bookmark: bm};
        },
        removeBookmark(key, id) {
            const b = book(key, false);
            if (!b) return false;
            const before = b.bookmarks.length;
            b.bookmarks = b.bookmarks.filter((x) => x.id !== id);
            const changed = b.bookmarks.length !== before;
            if (changed) persist(false);
            return changed;
        },

        // ---- 阅读统计（§8.5） ----
        recordReading(key, seconds, now) {
            if (!(seconds > 0)) return;
            const b = book(key, true);
            const today = todayKey(now);
            b.stats.totalSec += Math.round(seconds);
            b.stats.daily[today] = (b.stats.daily[today] || 0) + Math.round(seconds);
            pruneDaily(b.stats.daily, now);
            updateStreak(b.stats, now);
            persist(false);
        },
        startSession(key) {
            const b = book(key, true);
            b.stats.sessions += 1;
            persist(false);
        },
        stats(key) {
            const b = book(key, false);
            if (!b) return null;
            return JSON.parse(JSON.stringify(b.stats));
        },

        flush() {
            persist(true);
        },
        _raw() {
            return state;
        },
    };
}

function pruneDaily(daily, now) {
    const keys = Object.keys(daily).sort();
    if (keys.length <= DAILY_KEEP_DAYS) return;
    const cutoff = new Date(now instanceof Date ? now.getTime() : Date.now());
    cutoff.setDate(cutoff.getDate() - DAILY_KEEP_DAYS);
    const cutoffKey = todayKey(cutoff);
    for (const k of keys) {
        if (k < cutoffKey) delete daily[k];
    }
}

function updateStreak(stats, now) {
    const today = todayKey(now);
    if (stats.lastReadDate === today) return;
    stats.streak = stats.lastReadDate === yesterdayKey(now) ? (stats.streak || 0) + 1 : 1;
    stats.lastReadDate = today;
}
