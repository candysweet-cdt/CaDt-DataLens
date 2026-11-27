// memo-store.js：快捷便签的状态层——按作用域缓存文档，统一读写与防抖保存。
// 视图（bridge-todo-view.js）与 AI 工具（ai-panel.js）都经这里改数据：
// mutate(fn) 改内存 doc → 1s 防抖 MemoSave（带 mtime CAS）。多窗口是多进程，
// 写权由 Go 侧 resourcelease 租约判定；冲突/忙分开处理，不做合并。
//
// 租约模型（docs/unfinished-plans/multi-instance-sync.md §5）：
// - 面板打开时 acquire，持有到关闭/切作用域；只读窗口保留文档但拒绝 mutate。
// - 没开面板的 AI 写入用短租约：变更 → 立即 flush → 释放，拿不到就报忙。
// - busy 不清缓存（那会丢本窗口内容）；只有 mtime CAS 的 conflict 才重读磁盘。

import {parseMemoDoc, defaultMemoData, collectImageRefs} from './memo-model.js';

const SAVE_DEBOUNCE_MS = 1000;

// ===== 便签存储入口 =====
// createMemoStore(deps)：deps 全部 getter 延迟求值（组合根接线约定）。
// - backend：Wails 桥（dev 模式走 mock-backend 同名方法）
// - flash(msg, isErr)：状态栏提示
// - workspaceRoot()：当前工作区根（无则空串）
// - onPendingChange()：pending（有未落盘修改）状态翻转时回调——组合根把它接进
//   关窗脏标记（anyDirty），保证防抖窗口内关窗会走确认流程而不静默丢数据。
// - resolveRoot(scope, workspace)：作用域根目录绝对路径（贴图 GC 定位 img/ 用），
//   必须用缓存捕获的 workspace 而非当前值——换过工作区也要删对文件。
export function createMemoStore(deps) {
  // 失败 / 后台事件通知（消息中心 + toast + 节流）：便签多窗口冲突 / 保存失败
  const notifyFailure = (...args) => (typeof deps.notifyFailure === 'function' ? deps.notifyFailure(...args) : undefined);
  // caches: key → {doc, mtimeMs, dirty, timer, scope, workspace, writer, readOnly, owner}
  const caches = new Map();
  const changeListeners = new Set();
  // 贴图 GC 基准：scopeKey → Set<rel>（上次成功保存/载入时的全量引用集）。
  // 保存成功后 diff 本次引用集——消失的贴图走 DeleteEntry（回收站）。基于差集而非
  // 显式删除清单：×按钮/正文删占位符/删条目/删块/冲突重载后再删，所有路径统一覆盖；
  // 且不能在移除时就删文件——CAS 冲突重载会把引用带回来。
  const lastSavedImageRefs = new Map();

  const normKey = (p) => String(p || '').replace(/[\\/]+$/, '');
  const scopeKey = (scope, workspace) => scope + '|' + normKey(workspace).toLowerCase();

  function resolveWorkspace(scope, workspace) {
    const ws = workspace != null ? workspace : deps.workspaceRoot();
    return scope === 'workspace' ? normKey(ws) : '';
  }

  function leaseLabel(workspace) {
    const ws = String(workspace || '').trim();
    return ws ? ('快捷便签 · ' + ws) : '快捷便签';
  }

  function busyMessage(owner) {
    const pid = owner && owner.pid;
    return '快捷便签正在另一窗口编辑' + (pid ? '（PID ' + pid + '）' : '');
  }

  function notify(scope) {
    for (const fn of changeListeners) {
      try { fn(scope); } catch (e) { /* 单个订阅者出错不打断其余通知 */ }
    }
  }

  function onChange(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  }

// ===== 租约获取与释放 =====
  function hasLeaseBackend() {
    return !!(deps.backend && typeof deps.backend.MemoLeaseAcquire === 'function');
  }

  // acquiring 防止同一作用域的并发长租约获取：两个 trigger（focus + watch）同时到
  // 时只允许一个走 RPC，另一个直接返回“重试”，避免 Go refcount 多 1。
  const retryAcquiring = new Set();

  // releaseAcquiredLease 释放一次“临时/短租约”获取的写权。
  // 不能走 releaseLease：它按 cache.writer 判断，临时租约并不把 cache 标成 writer。
  async function releaseAcquiredLease(scope, workspace) {
    if (!deps.backend || typeof deps.backend.MemoLeaseRelease !== 'function') return {ok: true};
    try {
      await deps.backend.MemoLeaseRelease(scope, workspace);
      return {ok: true};
    } catch (e) {
      return {ok: false, error: String((e && e.message) || e)};
    }
  }

  // acquireLease 调 Go 侧租约；后端缺失时按单窗口语义直接视为 acquired。
  async function acquireLease(scope, workspace) {
    if (!hasLeaseBackend()) return {acquired: true, owner: null};
    try {
      const st = await deps.backend.MemoLeaseAcquire(scope, workspace, leaseLabel(workspace));
      if (st && st.acquired) return {acquired: true, owner: st.owner || null};
      return {acquired: false, busy: !!(st && st.busy), owner: (st && st.owner) || null};
    } catch (e) {
      return {acquired: false, busy: false, error: String((e && e.message) || e)};
    }
  }

// ===== 读取与加载 =====
  function resultOf(cache, extra) {
    return Object.assign({
      doc: cache.doc,
      scope: cache.scope,
      workspace: cache.workspace,
      readOnly: !!cache.readOnly,
      owner: cache.owner || null,
    }, extra || {});
  }

  // readInto 读盘并写入缓存；lease 非空时用它决定 writer/readOnly。
  async function readInto(scope, workspace, key, cached, lease) {
    let envelope;
    try {
      envelope = JSON.parse(await deps.backend.MemoLoad(scope, workspace));
    } catch (e) {
      return {doc: defaultMemoData(), scope, workspace, error: String((e && e.message) || e)};
    }
    const doc = parseMemoDoc(envelope.data);
    const json = JSON.stringify(doc);
    const changed = !!cached && JSON.stringify(cached.doc) !== json;
    const entry = {
      doc,
      mtimeMs: Number(envelope.mtimeMs) || 0,
      dirty: false,
      timer: cached ? cached.timer : 0,
      scope,
      workspace,
      writer: lease ? !!lease.acquired : !!(cached && cached.writer),
      readOnly: lease ? !lease.acquired : !!(cached && cached.readOnly),
      owner: lease ? (lease.owner || null) : (cached ? cached.owner : null),
    };
    caches.set(key, entry);
    // 磁盘现状就是贴图 GC 的基准：重载（冲突恢复 / 外部变更）后引用集跟着重置，
    // 别的窗口保住的图不会被我方后续保存误删
    lastSavedImageRefs.set(key, collectImageRefs(doc));
    if (changed) notify(scope);
    return resultOf(entry, {changed, leaseBusy: !!(lease && lease.busy), error: lease && lease.error});
  }

  // load 读盘并缓存（幂等：已缓存且不 force 时直接返回）。
  // opts.acquire=true：面板打开路径，读盘前先取写权；拿不到就只读加载。
  async function load(scope, opts) {
    const workspace = resolveWorkspace(scope, opts && opts.workspace);
    const key = scopeKey(scope, workspace);
    const cached = caches.get(key);
    const wantAcquire = !!(opts && opts.acquire);

    if (cached && !(opts && opts.force)) {
      if (!wantAcquire || cached.writer) return resultOf(cached);
      // 同窗口另一个 retry 正在拿锁：等它完成后由 notify 触发重渲染，不重复 acquire。
      if (retryAcquiring.has(key)) return resultOf(cached);
      const lease = await acquireLease(scope, workspace);
      if (!lease.acquired) {
        cached.readOnly = true;
        cached.owner = lease.owner || null;
        return resultOf(cached, {leaseBusy: !!lease.busy, error: lease.error});
      }
      cached.writer = true;
      cached.readOnly = false;
      cached.owner = null;
      const fresh = await readInto(scope, workspace, key, cached, lease);
      if (fresh.error) {
        // 读盘失败：把刚拿到的写权还回去，别留下“有锁无缓存”的占用。
        const rel = await releaseLease(scope, {workspace});
        if (!rel || rel.ok) {
          cached.writer = false;
          cached.readOnly = true;
          cached.owner = null;
        }
      }
      return fresh;
    }

    const lease = wantAcquire ? await acquireLease(scope, workspace) : null;
    const res = await readInto(scope, workspace, key, cached, lease);
    if (res.error && lease && lease.acquired) {
      // 没有缓存可挂 writer 状态：直接释放这次获取的短租约，避免泄漏。
      await releaseAcquiredLease(scope, workspace);
    }
    return res;
  }

  // retryAcquire 只读窗口在 focus/watch 时尝试接管；成功则强制重读磁盘再放开编辑。
  async function retryAcquire(scope, opts) {
    const workspace = resolveWorkspace(scope, opts && opts.workspace);
    const key = scopeKey(scope, workspace);
    const cache = caches.get(key);
    if (!cache) return {ok: false, error: '快捷便签 未加载'};
    if (cache.writer) return {ok: true};
    if (retryAcquiring.has(key)) return {ok: false, retry: true};
    retryAcquiring.add(key);
    try {
      const lease = await acquireLease(scope, workspace);
      if (!lease.acquired) {
        cache.readOnly = true;
        cache.owner = lease.owner || null;
        return {ok: false, busy: !!lease.busy, owner: cache.owner, error: lease.error};
      }
      cache.writer = true;
      cache.readOnly = false;
      cache.owner = null;
      const fresh = await readInto(scope, workspace, key, cache, lease);
      if (fresh.error) {
        const rel = await releaseLease(scope, {workspace});
        if (!rel || rel.ok) {
          cache.writer = false;
          cache.readOnly = true;
          cache.owner = null;
        }
        return {ok: false, error: fresh.error};
      }
      notify(scope);
      return {ok: true};
    } finally {
      retryAcquiring.delete(key);
    }
  }

  // releaseLease 让出写权；调用方必须先 flush 成功。release 失败时保留 writer。
  async function releaseLease(scope, opts) {
    const workspace = resolveWorkspace(scope, opts && opts.workspace);
    const key = scopeKey(scope, workspace);
    const cache = caches.get(key);
    if (!cache || !cache.writer) return {ok: true};
    if (deps.backend && typeof deps.backend.MemoLeaseRelease === 'function') {
      try {
        await deps.backend.MemoLeaseRelease(scope, workspace);
      } catch (e) {
        return {ok: false, error: String((e && e.message) || e)};
      }
    }
    cache.writer = false;
    cache.readOnly = false;
    cache.owner = null;
    return {ok: true};
  }

  // releaseAll 关窗/pagehide 兜底：flush 成功后释放本窗口持有的全部便签写权。
  async function releaseAll() {
    const jobs = [];
    for (const cache of Array.from(caches.values())) {
      if (cache.writer) jobs.push(releaseLease(cache.scope, {workspace: cache.workspace}));
    }
    await Promise.all(jobs);
  }

// ===== 缓存与落盘 =====
  // state 给视图渲染只读横幅/禁用控件用。
  function state(scope) {
    const {cache} = findCache(scope);
    if (!cache) return {writer: false, readOnly: false, owner: null};
    return {writer: !!cache.writer, readOnly: !!cache.readOnly, owner: cache.owner || null};
  }

  function cached(scope) {
    const entry = findCache(scope);
    return entry && entry.cache ? entry.cache.doc : null;
  }

  function findCache(scope) {
    const workspace = resolveWorkspace(scope);
    const key = scopeKey(scope, workspace);
    return {key, cache: caches.get(key)};
  }

  // flush 立即保存（关面板/切作用域前调用），返回 {ok, error?, conflict?, busy?}。
  async function flush(scope) {
    const {key, cache} = findCache(scope);
    if (!cache) return {ok: true};
    if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
    if (!cache.dirty) return {ok: true};
    if (!cache.writer) return {ok: false, busy: true, error: busyMessage(cache.owner)};
    cache.dirty = false;
    return saveCache(key, cache);
  }

  async function saveCache(key, cache) {
    try {
      let res;
      try {
        res = await deps.backend.MemoSave(cache.scope, cache.workspace, JSON.stringify(cache.doc), cache.mtimeMs);
      } catch (e) {
        cache.dirty = true;
        return {ok: false, error: String(e && e.message || e)};
      }
      if (res && res.busy) {
        // 写权在另一窗口：保留缓存与 dirty，不能走 conflict 的“删缓存重载”路径。
        cache.dirty = true;
        cache.writer = false;
        cache.readOnly = true;
        cache.owner = null;
        return {ok: false, busy: true, error: res.error || busyMessage(null)};
      }
      if (res && res.conflict) {
        // 冲突重载磁盘，但保留本窗口写权：租约仍在手里，删缓存会让 releaseLease no-op。
        const lease = cache.writer ? {acquired: true, owner: cache.owner} : null;
        const fresh = await readInto(cache.scope, cache.workspace, key, cache, lease);
        // readInto 在内容变化时已经 notify；这里不再重复广播。
        return {ok: false, conflict: true, error: res.error, doc: fresh.error ? cache.doc : fresh.doc};
      }
      if (!res || !res.ok) {
        cache.dirty = true;
        return {ok: false, error: (res && res.error) || '保存失败'};
      }
      cache.mtimeMs = Number(res.mtimeMs) || cache.mtimeMs;
      await gcImages(cache);
      return {ok: true};
    } finally {
      emitPending();
    }
  }

// ===== 图片与待保存 =====
  // gcImages 保存成功后的贴图回收：对比「上次成功保存/载入的引用集」与本次——
  // 消失的引用即被删除的贴图，按缓存捕获的工作区根定位后走 DeleteEntry（回收站，
  // 资源管理器同款校验）。引用口径含正文占位符（collectImageRefs）：正文里删掉
  // 占位符同样回收文件。删文件是尽力而为：失败静默留给「存储与清理」兜底，
  // 不打断保存流程；基准无论成败都刷新为本次引用，避免重复尝试。
  async function gcImages(cache) {
    const key = scopeKey(cache.scope, cache.workspace);
    const prev = lastSavedImageRefs.get(key);
    const curr = collectImageRefs(cache.doc);
    lastSavedImageRefs.set(key, curr);
    if (!prev || !prev.size) return;
    const gone = [];
    for (const rel of prev) {
      if (!curr.has(rel)) gone.push(rel);
    }
    if (!gone.length) return;
    let root = '';
    if (deps.resolveRoot) {
      try { root = await deps.resolveRoot(cache.scope, cache.workspace); } catch (e) { root = ''; }
    }
    if (!root || !deps.backend || !deps.backend.DeleteEntry) return;
    for (const rel of gone) {
      const abs = root.replace(/[\\/]+$/, '') + '/' + String(rel).replace(/[\\/]+/g, '/');
      try {
        await deps.backend.DeleteEntry(abs);
      } catch (e) {
        // 尽力而为：文件可能已被手动删/占用；孤儿由存储清理兜底
      }
    }
  }

  // emitPending：pending 状态可能翻转的每个出口都拉一次钩子（SetDirty 幂等，多调无害）。
  function emitPending() {
    if (deps.onPendingChange) deps.onPendingChange();
  }

  // hasPending 任一作用域还有未落盘的修改（关窗脏标记与测试用）。
  function hasPending() {
    for (const cache of caches.values()) {
      if (cache.dirty) return true;
    }
    return false;
  }

  // scheduleSave 防抖保存（每次 mutate 后调用，合并高频小改动）。
  function scheduleSave(scope) {
    const {cache} = findCache(scope);
    if (!cache) return;
    cache.dirty = true;
    emitPending();
    if (cache.timer) clearTimeout(cache.timer);
    cache.timer = setTimeout(async () => {
      cache.timer = 0;
      if (!cache.dirty) return;
      if (!cache.writer) return;
      cache.dirty = false;
      const res = await saveCache(scopeKey(cache.scope, cache.workspace), cache);
      if (!res.ok && !res.conflict && !res.busy) {
        if (deps.flash) deps.flash('快捷便签 保存失败：' + res.error, true);
        notifyFailure('快捷便签保存失败', String(res.error || '未知错误'), {key: 'memo-save', kind: 'error'});
      }
      if (res.conflict) {
        if (deps.flash) deps.flash('快捷便签 已在其他窗口修改，已刷新为磁盘版本', true);
        notifyFailure('快捷便签已在其他窗口修改', '已刷新为磁盘版本；本窗口未保存的改动可能已被覆盖', {key: 'memo-conflict', kind: 'error'});
      }
      if (res.busy) {
        if (deps.flash) deps.flash('快捷便签正在另一窗口编辑，稍后重试', true);
        notifyFailure('快捷便签正被其他窗口编辑', '稍后重试', {key: 'memo-busy', kind: 'info'});
      }
    }, SAVE_DEBOUNCE_MS);
  }

// ===== 变更与全局操作 =====
  // mutate 统一变更入口：fn(doc) → {ok, doc?, error?}（memo-model 的变更函数）。
  // opts.temporary=true：AI 工具在面板未持锁时用短租约，变更后立即 flush 再释放。
  async function mutate(scope, fn, opts) {
    const temporary = !!(opts && opts.temporary);
    const workspace = resolveWorkspace(scope);
    if (!findCache(scope).cache) {
      const loaded = await load(scope, {workspace, acquire: !temporary});
      if (loaded.error) return {ok: false, error: loaded.error};
    }
    const entry = findCache(scope);
    if (!entry.cache) return {ok: false, error: '快捷便签 未加载'};
    const cache = entry.cache;
    let tempWriter = false;
    if (temporary && !cache.writer) {
      const lease = await acquireLease(scope, cache.workspace);
      if (!lease.acquired) {
        return {ok: false, busy: true, error: busyMessage(lease.owner), owner: lease.owner || null};
      }
      tempWriter = true;
    } else if (!cache.writer) {
      return {ok: false, busy: true, error: busyMessage(cache.owner), owner: cache.owner || null};
    }
    try {
      const result = fn(cache.doc);
      if (!result || !result.ok) return result;
      cache.doc = result.doc;
      if (tempWriter) {
        if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
        cache.dirty = true;
        const saved = await saveCache(entry.key, cache);
        if (!saved.ok) {
          // 临时租约写入失败：按磁盘版本回滚，不能留下 dirty && !writer 的僵尸缓存
          // （否则 hasPending 恒真、flush 永远 busy、关窗一直弹确认）。
          const rollback = await readInto(scope, cache.workspace, entry.key, cache, null);
          cache.dirty = false;
          emitPending();
          return {ok: false, error: saved.error, busy: !!saved.busy, doc: rollback.doc};
        }
        cache.dirty = false;
        emitPending();
      } else {
        scheduleSave(scope);
      }
      notify(scope);
      return result;
    } finally {
      if (tempWriter) await releaseAcquiredLease(scope, cache.workspace);
    }
  }

  // rootFor 作用域缓存捕获的工作区根（导出复制贴图用；未加载返回当前解析值）。
  function rootFor(scope) {
    const entry = findCache(scope);
    return entry && entry.cache ? entry.cache.workspace : resolveWorkspace(scope);
  }

  // flushAll 冲掉所有作用域挂着的未落盘修改（关窗确认流程 / pagehide 兜底调用）。
  // 每份缓存用自己的 workspace 根落盘（载入时捕获），换过工作区也不会写错地方。
  async function flushAll() {
    const jobs = [];
    for (const [key, cache] of Array.from(caches.entries())) {
      if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
      if (!cache.dirty || !cache.writer) continue;
      cache.dirty = false;
      jobs.push(saveCache(key, cache));
    }
    await Promise.all(jobs);
  }

  // reloadExternal 外部文件变更（workspace-changed 事件 / 窗口 focus）时重读；
  // 内容没变就静默返回，变了经 notify 刷新视图。有未保存修改时跳过——
  // 让挂着的防抖保存用 CAS 去判，不静默丢弃用户正要写的内容。
  async function reloadExternal(scope) {
    const {cache} = findCache(scope);
    if (!cache) return false; // 面板没打开/没加载过，不打扰
    if (cache.dirty) return false;
    const res = await load(scope, {force: true, acquire: false});
    if (res.error) {
      if (deps.flash) deps.flash('快捷便签 重载失败：' + res.error, true);
      return false;
    }
    return !!res.changed;
  }

  // saveImage 贴图落盘，返回相对引用（img/xxx.png）或抛错给调用方提示。
  async function saveImage(scope, dataURL, workspace) {
    const ws = resolveWorkspace(scope, workspace);
    return deps.backend.MemoSaveImage(scope, ws, dataURL);
  }

  // forgetWorkspace 切换/关闭工作区时清理工作区作用域的缓存（防串工作区）。
  // 未落盘的修改先按缓存捕获的旧工作区根落盘——自动保存语义，切工作区不丢字。
  async function forgetWorkspace() {
    const jobs = [];
    const releases = [];
    for (const [key, cache] of Array.from(caches.entries())) {
      if (cache.scope !== 'workspace') continue;
      if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
      if (cache.dirty && cache.writer) {
        cache.dirty = false;
        jobs.push(saveCache(key, cache));
      }
      if (cache.writer) {
        releases.push(releaseLease(cache.scope, {workspace: cache.workspace}));
      }
      caches.delete(key);
    }
    await Promise.all(jobs);
    await Promise.all(releases);
    emitPending();
  }

  return {
    load,
    cached,
    mutate,
    flush,
    flushAll,
    hasPending,
    scheduleSave,
    reloadExternal,
    retryAcquire,
    releaseLease,
    releaseAll,
    state,
    saveImage,
    onChange,
    forgetWorkspace,
    rootFor,
  };
}
