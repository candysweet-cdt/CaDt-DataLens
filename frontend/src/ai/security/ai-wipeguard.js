// ai-wipeguard.js：工作区破坏防护的检测控制器（docs/finished-plans/workspace-wipe-guard.md §5）。
//
// 两信号（canary 诱饵已砍——2026-11-19 作者裁定工作区零足迹，方案 §5.2）：
//   ① 主信号：workspace-changed 事件（watcher 内核级——AI 工具、run_command 子进程、
//      工具返回后存活的进程、用户的删除全部可见）→ 10s 滚动窗口的**净消失**计数
//      （删除后又重建同路径 = 替换，不计）；
//   ② 兜底：结构指纹（run_command / background_command 前后保底 + 10 分钟周期校准 +
//      overflow 重扫）。指纹的阈值判定单一来源在 Go（WipeGuardCompare），前端不复制。
//
// critical 只提醒、不打断（2026-11-19 作者裁定）：早先的做法是停会话 + 熔断本轮写命令，
// 但合法批量删除（插件更新、切分支、安装依赖）与真破坏在 watcher 眼里同形，误判一次就把
// 正在干活的会话打断。现在改为把告警**插队投递给被告警工作区里正在跑的会话**，由模型
// 自己判断「跟我有没有关系」——它知道自己刚才在做什么，用户不在场也能自纠。停会话的
// 决定权交回用户（状态栏红条 + 消息中心）。
// 备份 / L3 快照的触发不在本模块（ai-panel 写路径 + 设置页定时器）。

// ---- 常量（工程参数，方案 §3.4：不进设置 UI）----

export const WIPEGUARD_WINDOW_MS = 10 * 1000;       // 滚动窗口
export const WIPEGUARD_DELETE_THRESHOLD = 40;        // 窗口内「净消失」阈值
export const WIPEGUARD_SETTLE_MS = 1200;             // 超阈值后的确认延迟（等重建事件落地）
export const WIPEGUARD_NOTIFY_COOLDOWN_MS = 2 * 60 * 1000; // 向会话投递告警的冷却（防刷屏 + 护上下文）
export const WIPEGUARD_AI_ACTIVE_MS = 60 * 1000;     // AI 活跃窗口
export const WIPEGUARD_FINGERPRINT_DEBOUNCE_MS = 3 * 1000; // 指纹去抖
export const WIPEGUARD_FINGERPRINT_INTERVAL_MS = 10 * 60 * 1000; // 周期校准
// L3 定期状态快照的节拍（main.js 的 setInterval）：与 Go 侧 internal/wipeguard 的
// snapshotInterval = 10 * time.Minute 同值。注意别和上面那行「指纹周期校准」合并——
// 两者数值相同但语义不同：一个是每根指纹的重新校准节奏，一个是全树快照的拍子。
export const WIPEGUARD_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
export const WIPEGUARD_WINDOW_LOG_MIN_MS = 2000; // 「窗口 N/seq」调试日志的最小间隔（同根）
// per-root 状态表容量（方案 §4.9.7 F1/F5）：只保留最近 8 个活跃根。harness 下同时
// 活着的根通常 1–3 个，超出的都是长时间没动静的旧工作区——它们的 watcher 也该退订。
export const WIPEGUARD_PER_ROOT_LIMIT = 8;

// watcher 计数排除的目录：与 Go 侧 skipFingerprintDir 同口径（internal/search 的
// searchSkipDirs 忽略表 + .git + .cadt），另加构建输出与依赖目录——vite/wails 等构建链
// 清空产物目录是合法 churn（dist 一轮就有几十个删除事件），不能计入破坏判定。
//
// 这张表只按「前两段」匹配（顶层 / 二级），因为 dist / build / bin 这类名字埋在源码
// 深处时往往是真源码目录（src/plugins/dist-helper），不能一律排除。
export const WIPEGUARD_SKIP_DIRS = [
    'dist', 'build', 'out', 'bin', 'coverage',
];

// 任意层级命中也排除的目录：名字唯一、必然可重建，深层出现也还是同一类东西。
//   · 版本控制元数据与应用内务目录：消失不构成损失（可重算 / 可从远端恢复）；
//   · 依赖目录与语言缓存（node_modules / .venv / __pycache__ …）：npm ci、pip install、
//     monorepo 里的 packages/*/node_modules 重建都是几秒内几百条删除；
//   · 构建缓存 / 产物（target / obj / .next / .turbo …）：cargo clean、webpack 清缓存的正常 churn。
// 名字带点号或形态唯一，不会和源码目录撞名；dist / build / bin 三个常见源码目录名
// 刻意留在两段表里，避免把主信号弄瞎。
//
// 起因两件（2026-11-19）：插件更新时 plugins/<id>/.git 下的删除落在第三段被计数；
// 举一反三排查发现 monorepo 的 packages/*/node_modules、Python .venv 重建同理。
export const WIPEGUARD_SKIP_ANY_DIRS = [
    '.git', '.cadt', '.svn', '.hg', '.bzr',
    '.idea', '.vscode',
    'node_modules', 'bower_components', 'vendor',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle', '.cache',
    '.venv', 'venv', 'site-packages',
    '.turbo', '.next', '.nuxt', '.svelte-kit', '.output',
    'target', 'obj',
];

// ---- 纯函数（测试见 test/ai/ai-wipeguard.test.mjs）----

// wipeGuardSkipPath：路径命中排除表 → 不计入删除窗口。
//   · 任意层级的版本控制元数据 / 内务目录（.git 等，见 WIPEGUARD_SKIP_ANY_DIRS）；
//   · 前两段（顶层 / 二级）命中构建产物与依赖目录表——二级覆盖 frontend/dist 这类
//     「产物挂在源码目录下」的布局；三级及以下不排除，避免把主信号弄瞎。
// 目录口径之外再排**临时文件形态**（2026-11-19 补丁应用误报实录）：原子写（atomfile
// `<name>.<pid>.<nanos>.tmp` / `<name>.tmp.<pid>.<hash>`）、补丁写入（`.cadt-patch-*.tmp`）、
// 各类锁文件——它们的「消失」是写入流程的正常半程（temp→rename），不是文件被删；一次
// 7 文件的补丁应用能堆出 40+ 条删除事件直接爆阈值。
export function wipeGuardSkipPath(path) {
    const norm = String(path || '').replace(/\\/g, '/').toLowerCase();
    if (!norm) return true;
    const segments = norm.split('/');
    if (segments.some((seg) => WIPEGUARD_SKIP_ANY_DIRS.includes(seg))) {
        return true;
    }
    if (WIPEGUARD_SKIP_DIRS.includes(segments[0]) ||
        (segments.length > 1 && WIPEGUARD_SKIP_DIRS.includes(segments[1]))) {
        return true;
    }
    const base = segments[segments.length - 1];
    return WIPEGUARD_SKIP_BASE_RE.test(base);
}

// 临时/机械文件的 basename 形态：`.tmp` 结尾（atomfile / 补丁 tmp / 通用临时）、
// `.tmp.<pid>.<hash>`（带后缀的原子写变体）、`.cadt-patch-` 前缀（补丁写入 temp）、
// `.lock` / `.gate` 结尾（跨进程锁）。
const WIPEGUARD_SKIP_BASE_RE = /(\.tmp($|\.))|(^\.cadt-patch-)|(\.lock$)|(\.gate$)/;

// registerDeleteEvents：把一批 watcher 事件路径并入滚动窗口（丢弃窗外旧条目）。
// 同一路径在窗口内只计一次——ReadDirectoryChangesW 对一次 rename 会推多条 action
// （temp 消失 + 目标出现 + 父目录变更），重复计数会把量级抬高 3-5 倍（2026-11-19
// 补丁应用误报实录：41 条事件去重后其实只有 ~10 个文件）。
//
// 第四参数 presentPaths 是同一批里的「出现/修改」路径（Go 侧 payload.present）。
// 它不进删除计数，只用于**净消失**判定：删除后又出现同一路径 = 替换（插件更新
// 「删旧目录 → 复制新目录」、整目录重建），不该算文件消失。每条记录带单调递增的
// seq，判定时只认「出现在删除之后」的复活；先出现后删除仍是真删除。
// 已知边界：同一路径窗口内只留首次删除，所以「删→建→再删」只按 1 个路径计且被
// 复活抵消（偏向少报 1 条），量级无关紧要。
// 纯函数：返回新窗口，不改动入参。
export function registerDeleteEvents(win, removedPaths, now, presentPaths) {
    const events = ((win && win.events) || [])
        .filter((e) => now - e.at < WIPEGUARD_WINDOW_MS);
    const presents = ((win && win.presents) || [])
        .filter((e) => now - e.at < WIPEGUARD_WINDOW_MS);
    let seq = (win && win.seq) || 0;
    const seen = new Set(events.map((e) => e.path));
    for (const p of (Array.isArray(removedPaths) ? removedPaths : [])) {
        if (wipeGuardSkipPath(p)) continue;
        const path = String(p);
        if (seen.has(path)) continue;
        seen.add(path);
        seq += 1;
        events.push({at: now, path, seq});
    }
    // present 每路径只留最新一条：抵消判据只关心「最后一次出现」是否晚于删除。
    const presentAt = new Map(presents.map((e, i) => [e.path, i]));
    for (const p of (Array.isArray(presentPaths) ? presentPaths : [])) {
        if (wipeGuardSkipPath(p)) continue;
        const path = String(p);
        seq += 1;
        const i = presentAt.get(path);
        if (i === undefined) {
            presentAt.set(path, presents.length);
            presents.push({at: now, path, seq});
        } else {
            presents[i] = {at: now, path, seq};
        }
    }
    return {events, presents, seq};
}

// shouldAlarmFromWatch：滚动窗口判定。窗口内的「净消失」路径数到阈值 → critical。
// 净消失 = 删除记录减去「在同一窗口内之后又重新出现」的路径。文案用「消失」而不是
// 「被删除」：统计的是最终没回来的文件，不是删除动作次数。
// 返回 {level, reason, paths} 或 null。
export function shouldAlarmFromWatch(win, now) {
    const events = ((win && win.events) || [])
        .filter((e) => now - e.at < WIPEGUARD_WINDOW_MS);
    const revived = new Map();
    for (const p of ((win && win.presents) || [])) {
        if (now - p.at >= WIPEGUARD_WINDOW_MS) continue;
        const prev = revived.get(p.path);
        if (prev === undefined || (p.seq || 0) > prev) revived.set(p.path, p.seq || 0);
    }
    const gone = events.filter((e) => {
        const back = revived.get(e.path);
        return back === undefined || back < (e.seq || 0);
    });
    if (gone.length >= WIPEGUARD_DELETE_THRESHOLD) {
        return {
            level: 'critical',
            reason: `10 秒内 ${gone.length} 个文件消失`,
            paths: gone.map((e) => e.path),
        };
    }
    return null;
}

// normalizeWsKey：工作区根归一化（与后端 WorkspaceKey 的归一化语义一致：\→/、去尾斜杠、小写），
// 用于窗口与指纹基线的工作区切换判定。
// normalizeWsKey：工作区根 → 分键用的归一化 key。
// 与 ai-session-scope.js 的 workspaceKey 同口径地**归一点段**（`.` / `..`）：payload.root 若
// 带 `..` 段，旧实现只做「反斜杠 + 尾斜杠 + 小写」，会与已登记的根分成两个键，事件被防护
// 白名单过滤掉、整根静默失明（独立审查 🟢）。前导 `/` 与 UNC 的 `//` 保留。
export function normalizeWsKey(ws) {
    const raw = String(ws || '').replace(/\\/g, '/');
    if (!raw) return '';
    const lead = raw.startsWith('//') ? '//' : (raw.startsWith('/') ? '/' : '');
    const parts = [];
    for (const seg of raw.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (parts.length) parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return (lead + parts.join('/')).replace(/\/+$/, '').toLowerCase();
}

// humanAgo：时间戳 → 相对时间（告警消息里用最短的说法，别占提示词）。
export function humanAgo(at, now) {
    const ts = Number(at) || 0;
    const ref = Number(now) || Date.now();
    if (!ts) return '';
    const diff = Math.max(0, ref - ts);
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
}

// ---- L3 快照告警（2026-11-21 定）：失败 / 跳过文件升级进消息中心，不再只写调试日志 ----
// 事故背景：frontend\nul 让快照连败 13 轮（约 2 小时），安全网断档没有任何用户可见表象。

export const WIPEGUARD_SNAPSHOT_ALARM_COOLDOWN_MS = 30 * 60 * 1000; // 同车道 30 分钟最多打扰一次

// snapshotAlarmState 的干净初始态（成功一轮后连击清零）。
export function snapshotAlarmReset() {
    return {errAt: 0, excAt: 0, streak: 0};
}

// snapshotAlarmDecide 节流决策（纯函数，可单测）：error 与 excluded 两条车道各自 30 分钟
// 冷却，互不挤占；error 每次出现都累计连击（成功由 snapshotAlarmReset 清零），文案用
// 「已连续 N 次」。返回 {notify, streak, next}——next 是调用方应保存的新状态。
export function snapshotAlarmDecide(prev, now, kind, cooldownMs = WIPEGUARD_SNAPSHOT_ALARM_COOLDOWN_MS) {
    const p = prev || {errAt: 0, excAt: 0, streak: 0};
    const next = {errAt: p.errAt || 0, excAt: p.excAt || 0, streak: p.streak || 0};
    let notify = false;
    if (kind === 'error') {
        next.streak += 1;
        notify = !(next.errAt && now - next.errAt < cooldownMs);
        if (notify) next.errAt = now;
    } else {
        notify = !(next.excAt && now - next.excAt < cooldownMs);
        if (notify) next.excAt = now;
    }
    return {notify, streak: next.streak, next};
}

// compactSnapshotError 把 Go 侧拒绝串收敛成一句话：取最后一条 fatal/error 行
// （CRLF warning 墙被 compactGitOutput 压过，但历史错误串仍可能很长），超长截断。
export function compactSnapshotError(raw, cap = 200) {
    const text = String(raw || '');
    const hits = text.match(/(?:fatal|error):[^\n]*/g) || [];
    let s = hits.length ? hits[hits.length - 1] : text.split('\n')[0];
    s = s.trim();
    if (s.length > cap) s = s.slice(0, cap) + '…';
    return s || '未知错误';
}

// recoveryHintText：告警消息里的「还能不能救回来」一行。
// 有定期快照就说最近一份多久之前；没有就说清楚为什么、以及写前备份仍可还原。
// 只输出一行：这条消息会进会话上下文，越短越好。
export function recoveryHintText(rows, {snapshotsEnabled, now} = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const entry = '入口 设置 → 存储与清理 → 工作区防护';
    if (snapshotsEnabled === false) {
        return '定期快照已关闭，恢复只能靠写前备份（' + entry + '）。';
    }
    if (!list.length) {
        return '还没有定期快照，恢复只能靠写前备份（' + entry + '）。';
    }
    let latest = list[0];
    for (const row of list) {
        if ((Number(row && row.at) || 0) > (Number(latest && latest.at) || 0)) latest = row;
    }
    const ago = humanAgo(latest && latest.at, now);
    return '可回滚：最近一份快照' + (ago ? ' ' + ago : '') + '（共 ' + list.length + ' 份，' + entry + '）。';
}

// clipAlertPath：样例路径截断（头 32 + … + 尾 40）。路径尾部信息量更大
// （`.git/hooks/pre-merge-commit.sample`），头部只留够定位工作区的部分。
function clipAlertPath(path) {
    const text = String(path || '');
    if (text.length <= 76) return text;
    return text.slice(0, 32) + '…' + text.slice(-40);
}

// buildGuardNotice：拼给会话的告警正文。**长度是有意的**：这条消息会进会话上下文，
// 所以只有一句统计 + 三行判断依据 + 最多 8 条截断样例 + 一行恢复提示（约 300~500 字），
// 不把 paths 全量塞进去（几百条路径能把一轮上下文吃掉一大块）。
export function buildGuardNotice(info, hint) {
    const reason = (info && info.reason) || '检测到大范围文件消失';
    const paths = Array.isArray(info && info.paths) ? info.paths : [];
    const samples = paths.slice(0, 8).map(clipAlertPath);
    const lines = [
        '［工作区防护］' + reason + '。',
        '这是应用文件监听的统计，可能与你无关：插件安装/更新、切换分支、安装依赖、构建清理都会合法地批量删除文件。',
        '如果你本轮没有删除这些文件，忽略本条、不必回复，继续当前工作；',
        '如果你确实在删文件，请立即停下并向用户说明原因。',
    ];
    if (samples.length) {
        lines.push('样例：' + samples.join('、') + (paths.length > samples.length ? ' …' : ''));
    }
    if (hint) lines.push(hint);
    return lines.join('\n');
}

// ---- 控制器 ----

export function createAIWipeguard(deps) {
    // deps: {
    //   getBackend   () => 绑定集（WipeGuardFingerprint / WipeGuardCompare / WipeGuardAlarm / ...）
    //   getWsRoot    () => 当前工作区根
    //   getSettings  () => settings 对象（wipeGuard 段：enabled / snapshots / backupRoot）
    //   isAIActive   (root) => 指定工作区（归一化后）有会话最近 60s 在跑工具或正在流式——
    //               决定要不要把告警插队投递给会话（没人在跑就没必要唤醒一个空闲会话）
    //   onCritical   (info) => critical 告警动作（状态栏红条 + 向活跃会话插队投递应用消息）
    //   onWarn       (info) => warn 提示（状态栏黄条）
    //   onRootEvicted （可选）(root) => 某根被 LRU 淘汰 / 显式退订：宿主在这里 Unwatch
    //   settleMs     （可选，测试用）覆盖 WIPEGUARD_SETTLE_MS
    // }
    // per-root 状态表（方案 §4.9.7 F1 / F5）：此前是单值状态机——`handleWorkspaceEvent`
    // 一发现换根就把滚动窗口与指纹基线清零，harness 下 A→B→A 的来回切换于是把「切走期间」
    // 攒下的删除事件整批抹掉（真破坏漏报）；告警冷却也只有全局一份（A 根报过警，2 分钟内
    // B 根的真破坏被抑制）。现在每个根各持一份窗口 / 基线 / 确认延迟 / 冷却，换根只初始化新条目。
    const perRoot = new Map(); // wsKey -> {root, watchWindow, lastFingerprint, lastFingerprintAt,
                              //            settleTimer, lastAlarmAt, lastSeenAt, calibrating, snapshotAlarm}
    let fingerprintTimer = null;
    const settleMs = typeof deps.settleMs === 'number' ? deps.settleMs : WIPEGUARD_SETTLE_MS;

    // ensureRoot：取（必要时初始化）某个根的状态条目，并刷新 lastSeenAt（LRU 依据）。
    // 根为空 = 无条目（harness 下未绑定会话的窗口没有可保护的对象）。
    function ensureRoot(root, now) {
        const key = normalizeWsKey(root);
        if (!key) return null;
        const ts = Number(now) || Date.now();
        let entry = perRoot.get(key);
        if (!entry) {
            entry = {
                root: String(root || ''),
                watchWindow: {events: [], presents: [], seq: 0},
                lastFingerprint: null,
                lastFingerprintAt: 0,
                settleTimer: null,     // 超阈值后的确认延迟（等「删除后又重建」的事件落地）
                lastAlarmAt: 0,
                lastSeenAt: ts,
                lastWindowLogAt: 0,    // 上一条「窗口 N/seq」调试日志的时间（同根节流）
                calibrating: false,
                snapshotAlarm: snapshotAlarmReset(),
            };
            perRoot.set(key, entry);
            evictRoots();
        }
        entry.root = String(root || entry.root || '');
        entry.lastSeenAt = ts;
        return entry;
    }

    // dropRoot：摘条目 + 清确认延迟 + 通知宿主退订 watcher（不再防护的根不该继续烧内核句柄）。
    function dropRoot(key) {
        const entry = perRoot.get(key);
        if (!entry) return;
        if (entry.settleTimer) {
            clearTimeout(entry.settleTimer);
            entry.settleTimer = null;
        }
        perRoot.delete(key);
        if (typeof deps.onRootEvicted === 'function') {
            try {
                deps.onRootEvicted(entry.root);
            } catch (e) {
                console.warn('[wipeguard] 根退出回调失败（该根监听可能残留到窗口关闭）', e);
            }
        }
    }

    // evictRoots：只保留最近 WIPEGUARD_PER_ROOT_LIMIT 个根（LRU）。
    // 取舍顺序：当前根**永不淘汰**（丢了它就是对着正在干活的仓库失明）＞ 有会话在跑的根
    // （isAIActive 为真的根最不能丢，淘汰了它等于让正在删文件的会话失去信号）＞ lastSeenAt 最旧。
    function evictRoots() {
        if (perRoot.size <= WIPEGUARD_PER_ROOT_LIMIT) return;
        const currentKey = normalizeWsKey(deps.getWsRoot ? deps.getWsRoot() : '');
        const cold = [];
        const aiBusy = [];
        for (const [key, entry] of perRoot) {
            if (key === currentKey) continue;
            const active = deps.isAIActive ? !!deps.isAIActive(entry.root) : false;
            (active ? aiBusy : cold).push([key, entry]);
        }
        const pool = cold.length ? cold : aiBusy;
        if (!pool.length) return; // 只剩当前根：宁可短暂超出上限，也不淘汰正在防护的根
        pool.sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0));
        dropRoot(pool[0][0]);
        evictRoots();
    }

    function settingsOf() {
        const wg = (deps.getSettings && deps.getSettings().wipeGuard) || {};
        return {
            enabled: wg.enabled !== false,
            snapshots: wg.snapshots !== false,
            backupRoot: wg.backupRoot || '',
        };
    }

    function backend() { return deps.getBackend(); }

    // ---- 设置同步：settings 对象 → Go 侧（启动与设置页变更后调用）----
    async function syncConfig() {
        const st = settingsOf();
        try {
            await backend().WipeGuardConfigure({
                enabled: st.enabled,
                snapshots: st.snapshots,
                backupRoot: st.backupRoot,
            });
        } catch (e) {
            console.warn('[wipeguard] 配置同步失败（后端不可用？）', e);
        }
    }

    // ---- 指纹兜底（run_command 前后 + 周期校准 + overflow 重扫）----
    async function takeFingerprint(root) {
        try {
            return await backend().WipeGuardFingerprint(root);
        } catch (e) {
            console.warn('[wipeguard] 指纹获取失败（尽力而为）', e);
            return null;
        }
    }

    function fireAlarm(verdict, source, root) {
        const now = Date.now();
        root = root || (deps.getWsRoot ? deps.getWsRoot() : '') || '';
        // 告警去抖（3s）按根独立：A 根刚报过警，不该压住 B 根随即出现的第一次真破坏（F5）。
        const entry = ensureRoot(root, now);
        if (entry) {
            if (now - entry.lastAlarmAt < WIPEGUARD_FINGERPRINT_DEBOUNCE_MS) return;
            entry.lastAlarmAt = now;
        }
        const aiActive = deps.isAIActive ? !!deps.isAIActive(root) : false;
        backend().WipeGuardAlarm(verdict.level, verdict.reason,
            `${source} · AI活跃=${aiActive} · 样例=${(verdict.paths || []).slice(0, 12).join(', ')}`)
            .catch(() => {}); // 告警日志尽力而为
        if (verdict.level === 'critical') {
            // 不在这里停会话：告警交给 onCritical（状态栏红条 + 向活跃会话插队投递
            // 应用消息），由模型自己判断相关性，由用户决定要不要中止。
            deps.onCritical && deps.onCritical({reason: verdict.reason, source, aiActive, root, paths: verdict.paths || []});
        } else {
            deps.onWarn && deps.onWarn({reason: verdict.reason, source, root});
        }
        // 告警后：重扫指纹兜底（尽力而为）
        takeFingerprint(root);
    }

    async function calibrateFingerprint(root, {force} = {}) {
        if (!root) return;
        const now = Date.now();
        const key = normalizeWsKey(root);
        const entry = ensureRoot(root, now);
        if (!entry || entry.calibrating) return;
        if (!force && now - entry.lastFingerprintAt < WIPEGUARD_FINGERPRINT_DEBOUNCE_MS) return;
        entry.calibrating = true;
        try {
            const after = await takeFingerprint(root);
            if (perRoot.get(key) !== entry) return; // 取指纹期间该根被 LRU 淘汰：结果作废
            entry.lastFingerprintAt = Date.now();
            if (after && entry.lastFingerprint) {
                const verdict = await backend().WipeGuardCompare(entry.lastFingerprint, after).catch(() => null);
                if (verdict && verdict.level) {
                    fireAlarm({level: verdict.level, reason: verdict.reason, paths: []}, '指纹校准', root);
                }
            }
            entry.lastFingerprint = after; // 基线滚动（无论是否告警，旧基线已过时）
        } finally {
            entry.calibrating = false;
        }
    }

    // harness / 未绑定会话下 getWsRoot() 可能为空：此前是静默 return，用户以为防护开着
    // 其实周期校准与定期快照都没跑（方案 §4.9.7 F4）。这里只在「由有变无 / 由无变有」时
    // 各记一条，避免每 10 分钟刷一条日志。
    let idleRootWarned = false;
    function reportIdleRoot(kind) {
        const hasRoot = !!(deps.getWsRoot ? deps.getWsRoot() : '');
        if (hasRoot) {
            if (idleRootWarned) {
                idleRootWarned = false;
                console.info('[wipeguard] 已恢复工作区根，' + kind + '恢复运行');
            }
            return false;
        }
        if (!idleRootWarned) {
            idleRootWarned = true;
            console.warn('[wipeguard] 当前没有工作区根：' + kind + '暂停（周期校准 / 定期快照不会执行，' +
                '破坏防护只剩 watcher 主信号）。harness 下请确认会话已绑定工作区或会话沙盒。');
        }
        return true;
    }

    function startCalibrationLoop() {
        if (fingerprintTimer) return;
        fingerprintTimer = setInterval(() => {
            if (!settingsOf().enabled) return;
            if (reportIdleRoot('周期校准')) return;
            const root = deps.getWsRoot ? deps.getWsRoot() : '';
            if (root) calibrateFingerprint(root, {force: true});
        }, WIPEGUARD_FINGERPRINT_INTERVAL_MS);
    }

    function stopCalibrationLoop() {
        if (fingerprintTimer) {
            clearInterval(fingerprintTimer);
            fingerprintTimer = null;
        }
    }

    // ---- 事件入口（main.js 的多根 watcher 转发）----
    // 超阈值不立即告警，而是延迟 WIPEGUARD_SETTLE_MS 再复核：删除与随后的重建常常
    // 不在同一批内核事件里（插件更新 = os.RemoveAll 整目录 + 立刻复制新目录），第一批
    // 只含删除就会被误判成大范围消失。延迟到期时用**同一个根的**窗口重算「净消失」。
    function armSettle(entry) {
        if (entry.settleTimer) return;
        entry.settleTimer = setTimeout(() => {
            entry.settleTimer = null;
            const verdict = shouldAlarmFromWatch(entry.watchWindow, Date.now());
            if (verdict) fireAlarm(verdict, 'watcher', entry.root);
        }, settleMs);
    }

    // handleWorkspaceEvent：按 payload.root 分流到该根自己的滚动窗口。
    // **换根不再清零**（F1）：A 会话跑着长任务、用户切到 B，A 的删除事件仍要攒在 A 的
    // 窗口里；切回来时第一次事件不该从零开始，否则「切走期间的破坏」永远凑不够阈值。
    function handleWorkspaceEvent(payload) {
        if (!settingsOf().enabled) return;
        const root = (payload && payload.root) || (deps.getWsRoot ? deps.getWsRoot() : '') || '';
        const now = Date.now();
        const entry = ensureRoot(root, now);
        if (!entry) return;
        if (payload && payload.overflow) {
            // 内核丢事件：立即重扫指纹兜底（只扫这个根，不牵连别的根）
            calibrateFingerprint(root, {force: true});
        }
        // 只计「消失」类事件（payload.removed 由 Go 侧按 FILE_ACTION_REMOVED / RENAMED_OLD_NAME
        // 分组）：原子写与补丁回灌产生的是 added/renamed_new/modified，几十个文件的合法写入
        // 不该计入破坏判定（2026-11-19 补丁应用误报实录）。
        // payload.present 是同一批的「出现/修改」路径，用于把「删了又建」的替换抵掉
        // （插件更新删旧目录再复制：旧文件消失半程不该算破坏）。
        const removedPaths = (payload && Array.isArray(payload.removed)) ? payload.removed : [];
        const presentPaths = (payload && Array.isArray(payload.present)) ? payload.present : [];
        const prevSeq = (entry.watchWindow && entry.watchWindow.seq) || 0;
        entry.watchWindow = registerDeleteEvents(entry.watchWindow, removedPaths, now, presentPaths);
        // 演练可观测性（方案 §6.1 D1）：`watchWindow.seq` 是纯函数内部值，不打日志就无法
        // 用机械判据区分「换根后窗口清零」与「窗口延续」——只能靠告警 reason 里的 N 猜。
        // 但判据只能是「窗口 seq 有增量」而不是「原批事件非空」：watcher 每批变更都会推
        // 事件，git status 写 `.git/index.lock`、构建写 dist、应用写 .cadt 都是批批都有，
        // 而这些路径全被排除表滤掉、seq 不动（2026-11-26 实录：工作区里有 git 轮询时调试台
        // 每秒刷一条 `seq=0 events=0 removed=0`，纯噪音）。真实删除/重建仍有增量，
        // 再叠同根 2s 节流防事件洪峰刷屏。debug 级别：只进调试台，不影响正常用户。
        const delta = ((entry.watchWindow && entry.watchWindow.seq) || 0) - prevSeq;
        if (delta > 0 && now - (entry.lastWindowLogAt || 0) >= WIPEGUARD_WINDOW_LOG_MIN_MS) {
            entry.lastWindowLogAt = now;
            console.debug('[wipeguard] 窗口 N/seq', root, 'seq=' + entry.watchWindow.seq,
                'events=' + entry.watchWindow.events.length, 'removed=' + removedPaths.length,
                'delta=' + delta);
        }
        if (shouldAlarmFromWatch(entry.watchWindow, now)) armSettle(entry);
    }

    // ---- run_command / background_command 前后保底（ai-panel 调用）----
    // 前后必须用**同一个根**：会话根从窗口根解耦后，换手 / 切会话期间
    // preCommand(A) 与 postCommand 各取一次根，就会拿 B 的 after 跟 A 的 before 比，
    // 判出「整仓顶层条目被清空」这类跨仓库误报（方案 §4.9.7 F3）。
    // 因此 preCommand 返回 {root, fp}，postCommand 只认这一个根，不再接受第二个来源。
    // 基线也按根滚动（entry.lastFingerprint）：多根并存时「最近一次观测到的指纹」若只有
    // 全局一份，周期校准会把 A 的基线与 B 的现状比。
    async function preCommand(root) {
        if (!settingsOf().enabled || !root) return null;
        const fp = await takeFingerprint(root);
        if (!fp) return null;
        const entry = ensureRoot(root, Date.now());
        if (entry) {
            entry.lastFingerprint = fp;
            entry.lastFingerprintAt = Date.now();
        }
        return {root, fp};
    }

    // 新形式 postCommand(before4)；旧形式 postCommand(root, beforeSnapshot) 也兼容。
    // 关键：**只要第二个参数是 preCommand 返回的快照，就用快照自带的 root**——
    // 这比调用方现取的根可信（ai-panel 传的是 getScopeRoot()，换手后已不是 A 了）。
    // 因此即使调用点还没改造，只要 before 是新形式快照，跨仓库误报也已被挡住。
    async function postCommand(a, b) {
        const isSnapshot = (v) => !!(v && typeof v === 'object' && v.root && v.fp);
        let root = '';
        let before = null;
        if (isSnapshot(a)) {
            root = String(a.root);
            before = a.fp;
        } else if (isSnapshot(b)) {
            root = String(b.root);   // 以快照自带根为准，忽略调用方传的根
            before = b.fp;
        } else {
            root = String(a || '');
            before = b || null;      // 未改造的旧调用方：只能信任它传的根
        }
        if (!before || !root) return;
        const after = await takeFingerprint(root);
        if (!after) return;
        // 该根的基线滚动到命令后的现状（周期校准据此比较，不跨根）
        const entry = ensureRoot(root, Date.now());
        if (entry) {
            entry.lastFingerprint = after;
            entry.lastFingerprintAt = Date.now();
        }
        try {
            const verdict = await backend().WipeGuardCompare(before, after);
            if (verdict && verdict.level) {
                fireAlarm({level: verdict.level, reason: verdict.reason, paths: []}, '命令前后指纹', root);
            }
        } catch (e) {
            console.warn('[wipeguard] 指纹对比失败（尽力而为）', e);
        }
    }

    // ---- L3 定期快照（设置页 / main.js 的 10 分钟定时器调用）----
    // 失败 / 跳过文件升级进消息中心（30 分钟节流，见 snapshotAlarmDecide）：
    // 2026-11-21 frontend\nul 让快照连败 13 轮约 2 小时，只有调试日志、没有任何用户可见表象。
    // 只对**当前根**做一拍（一个窗口一份快照，避免磁盘占用随根数线性增长）；
    // 失败连击状态按根记在条目里，切根回来不会把「已连续 N 次」串到别的仓库上。
    async function snapshotTick() {
        const st = settingsOf();
        if (!st.enabled || !st.snapshots) return null;
        if (reportIdleRoot('定期快照')) return null;
        const root = deps.getWsRoot ? deps.getWsRoot() : '';
        if (!root) return null;
        const entry = ensureRoot(root, Date.now());
        try {
            const res = await backend().WipeGuardSnapshot(root);
            if (entry && res && res.excluded) {
                entry.snapshotAlarm = applySnapshotAlarm(entry, 'excluded', res.excluded);
            } else if (entry) {
                entry.snapshotAlarm = snapshotAlarmReset(); // 干净成功：失败连击清零
            }
            return res;
        } catch (e) {
            console.warn('[wipeguard] 定期快照失败（下轮再试）', e);
            if (entry) entry.snapshotAlarm = applySnapshotAlarm(entry, 'error', e && e.message);
            return null;
        }
    }

    // applySnapshotAlarm 走节流决策后投消息中心（deps.notify 由 main.js 注入 messageCenter.add）。
    // 返回该根新的告警状态。通知缺失时只维护状态、不投递（测试/无消息中心环境）。
    function applySnapshotAlarm(entry, kind, detail) {
        const decision = snapshotAlarmDecide(entry && entry.snapshotAlarm, Date.now(), kind);
        if (decision.notify && typeof deps.notify === 'function') {
            if (kind === 'error') {
                deps.notify({
                    kind: 'error',
                    title: '工作区防护：定期快照失败',
                    body: compactSnapshotError(detail) + '（已连续 ' + decision.streak +
                        ' 次，每 10 分钟自动重试）。安全网断档期间请谨慎做批量文件操作；' +
                        '点击直达工作区防护设置查看原因与快照清单。',
                    actionId: 'open-wipeguard-settings',
                }, {toast: decision.streak === 1}); // 连击首轮才弹 toast，后续只进消息中心
            } else {
                deps.notify({
                    kind: 'info',
                    title: '工作区防护：快照有文件被跳过',
                    body: '定期快照已生成，但 ' + detail +
                        '。其余文件已正常备份；若这些文件本该存在，请检查权限或文件名（点击直达工作区防护设置）。',
                    actionId: 'open-wipeguard-settings',
                }, {toast: false});
            }
        }
        return decision.next;
    }

    // ---- 恢复提示：告警消息里的一行（还能不能回滚）----
    // 由 ai-panel 的 wipeguardNotifyForWorkspace 调用。只返回一行文本——这条消息会进
    // 会话上下文，不把快照清单整个塞进去。
    async function recoveryHint(root) {
        const st = settingsOf();
        if (!st.enabled) return '';
        if (!st.snapshots) return recoveryHintText([], {snapshotsEnabled: false});
        let rows;
        try {
            rows = await backend().WipeGuardSnapshotList(root);
        } catch (e) {
            console.warn('[wipeguard] 快照清单读取失败（告警仍照发）', e);
            return '恢复入口 设置 → 存储与清理 → 工作区防护（写前备份与定期快照都在这里）。';
        }
        return recoveryHintText(rows, {snapshotsEnabled: true});
    }

    // ---- 熔断已取消（2026-11-19 作者裁定）----
    // 早先 critical 会熔断本轮写命令（写工具直接返回拒绝文案）。现在改为插队投递应用
    // 消息让模型自己判断，写路径不再拦截——`isWriteBlocked` 恒 false、`clearBlocked`
    // 空操作，保留导出只为不破坏既有调用点与测试夹具。
    function isWriteBlocked() { return false; }

    function clearBlocked() {}

    // ---- L1 写前快照（ai-panel 的 write_file / edit_file 在落盘前调用；方案 §4.6）----
    // 原文本已在内存，这里只是转发给 Go 的内容寻址库。失败只进调试日志、绝不阻断写入——
    // 调用方可以 await 而不必再包 try/catch（本方法自身不抛）。
    async function backupWrite(call) {
        const st = settingsOf();
        if (!st.enabled || !call || !call.existed) return null; // 新建文件无原内容可备份
        try {
            return await backend().WipeGuardBackup({
                sessionId: call.sessionId || '',
                tool: call.tool || 'write_file',
                ws: call.ws || (deps.getWsRoot ? deps.getWsRoot() : '') || '',
                relPath: call.relPath || '',
                absPath: call.absPath || '',
                content: call.content || '',
                existed: true,
            });
        } catch (e) {
            console.warn('[wipeguard] 写前备份失败（继续写入，不影响保存）', e);
            return null;
        }
    }

    // ---- 多根监听登记（main.js 的 wipe-guard watcher 同步调用）----
    // 「条目存在」= 这个根还在防护范围里：订阅一个根就建条目；退订 / LRU 淘汰就摘条目并
    // 清确认延迟、通知宿主 Unwatch。事件入口自己也走 ensureRoot，所以即使调用方没登记
    // （单测 / 旧调用点）事件照样计入判定——登记只影响生命周期与 LRU。
    function trackRoot(root) {
        return !!ensureRoot(root, Date.now());
    }

    function untrackRoot(root) {
        const key = normalizeWsKey(root);
        if (!key || !perRoot.has(key)) return false;
        dropRoot(key);
        return true;
    }

    function tracksRoot(root) {
        const key = normalizeWsKey(root);
        return !!key && perRoot.has(key);
    }

    return {
        syncConfig,
        handleWorkspaceEvent,
        preCommand,
        postCommand,
        backupWrite,
        snapshotTick,
        recoveryHint,
        startCalibrationLoop,
        stopCalibrationLoop,
        isWriteBlocked,
        clearBlocked,
        trackRoot,
        untrackRoot,
        tracksRoot,
    };
}
