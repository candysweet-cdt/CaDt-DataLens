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
export function normalizeWsKey(ws) {
    return String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
    //   settleMs     （可选，测试用）覆盖 WIPEGUARD_SETTLE_MS
    // }
    let watchWindow = null;
    let wsKey = '';
    let lastFingerprint = null;   // run_command 前的基线
    let lastFingerprintAt = 0;
    let lastAlarmAt = 0;
    let fingerprintTimer = null;
    let settleTimer = null;       // 超阈值后的确认延迟（等「删除后又重建」的事件落地）
    let calibrating = false;
    const settleMs = typeof deps.settleMs === 'number' ? deps.settleMs : WIPEGUARD_SETTLE_MS;

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
        if (now - lastAlarmAt < WIPEGUARD_FINGERPRINT_DEBOUNCE_MS) return;
        lastAlarmAt = now;
        root = root || (deps.getWsRoot ? deps.getWsRoot() : '') || '';
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
        if (!root || calibrating) return;
        const now = Date.now();
        if (!force && now - lastFingerprintAt < WIPEGUARD_FINGERPRINT_DEBOUNCE_MS) return;
        calibrating = true;
        try {
            const after = await takeFingerprint(root);
            lastFingerprintAt = Date.now();
            if (after && lastFingerprint) {
                const verdict = await backend().WipeGuardCompare(lastFingerprint, after).catch(() => null);
                if (verdict && verdict.level) {
                    fireAlarm({level: verdict.level, reason: verdict.reason, paths: []}, '指纹校准', root);
                }
            }
            lastFingerprint = after; // 基线滚动（无论是否告警，旧基线已过时）
        } finally {
            calibrating = false;
        }
    }

    function startCalibrationLoop() {
        if (fingerprintTimer) return;
        fingerprintTimer = setInterval(() => {
            if (!settingsOf().enabled) return;
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

    // ---- 事件入口（main.js 的 workspace-changed 监听转发）----
    // 超阈值不立即告警，而是延迟 WIPEGUARD_SETTLE_MS 再复核：删除与随后的重建常常
    // 不在同一批内核事件里（插件更新 = os.RemoveAll 整目录 + 立刻复制新目录），第一批
    // 只含删除就会被误判成大范围消失。延迟到期时用同一窗口重算「净消失」。
    function armSettle(root) {
        if (settleTimer) return;
        settleTimer = setTimeout(() => {
            settleTimer = null;
            const verdict = shouldAlarmFromWatch(watchWindow, Date.now());
            if (verdict) fireAlarm(verdict, 'watcher', root);
        }, settleMs);
    }

    function clearSettle() {
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
    }

    function handleWorkspaceEvent(payload) {
        if (!settingsOf().enabled) return;
        const root = (payload && payload.root) || (deps.getWsRoot ? deps.getWsRoot() : '') || '';
        const key = normalizeWsKey(root);
        if (key !== wsKey) {
            // 切工作区：窗口与指纹基线重置（防止跨工作区误判）
            watchWindow = {events: [], presents: [], seq: 0};
            wsKey = key;
            lastFingerprint = null;
            clearSettle();
        }
        if (payload && payload.overflow) {
            // 内核丢事件：立即重扫指纹兜底
            calibrateFingerprint(root, {force: true});
        }
        const now = Date.now();
        // 只计「消失」类事件（payload.removed 由 Go 侧按 FILE_ACTION_REMOVED / RENAMED_OLD_NAME
        // 分组）：原子写与补丁回灌产生的是 added/renamed_new/modified，几十个文件的合法写入
        // 不该计入破坏判定（2026-11-19 补丁应用误报实录）。
        // payload.present 是同一批的「出现/修改」路径，用于把「删了又建」的替换抵掉
        // （插件更新删旧目录再复制：旧文件消失半程不该算破坏）。
        const removedPaths = (payload && Array.isArray(payload.removed)) ? payload.removed : [];
        const presentPaths = (payload && Array.isArray(payload.present)) ? payload.present : [];
        watchWindow = registerDeleteEvents(watchWindow, removedPaths, now, presentPaths);
        if (shouldAlarmFromWatch(watchWindow, now)) armSettle(root);
    }

    // ---- run_command / background_command 前后保底（ai-panel 调用）----
    async function preCommand(root) {
        if (!settingsOf().enabled || !root) return null;
        return takeFingerprint(root);
    }

    async function postCommand(root, before) {
        if (!before || !root) return;
        const after = await takeFingerprint(root);
        if (!after) return;
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
    let snapshotAlarmState = snapshotAlarmReset();
    async function snapshotTick() {
        const st = settingsOf();
        if (!st.enabled || !st.snapshots) return null;
        const root = deps.getWsRoot ? deps.getWsRoot() : '';
        if (!root) return null;
        try {
            const res = await backend().WipeGuardSnapshot(root);
            if (res && res.excluded) {
                snapshotAlarmState = applySnapshotAlarm('excluded', res.excluded);
            } else {
                snapshotAlarmState = snapshotAlarmReset(); // 干净成功：失败连击清零
            }
            return res;
        } catch (e) {
            console.warn('[wipeguard] 定期快照失败（下轮再试）', e);
            snapshotAlarmState = applySnapshotAlarm('error', e && e.message);
            return null;
        }
    }

    // applySnapshotAlarm 走节流决策后投消息中心（deps.notify 由 main.js 注入 messageCenter.add）。
    // 返回新的告警状态。通知缺失时只维护状态、不投递（测试/无消息中心环境）。
    function applySnapshotAlarm(kind, detail) {
        const decision = snapshotAlarmDecide(snapshotAlarmState, Date.now(), kind);
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
    };
}
