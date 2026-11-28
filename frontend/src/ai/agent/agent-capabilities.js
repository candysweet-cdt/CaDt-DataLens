// agent-capabilities.js：子代理能力快照（DelegatedCapabilities）的合成、收窄、校验与序列化。
// 方案 docs/finished-plans/subagent-capabilities-redesign.md §3 / §4.2 / §10.3。
//
// 职责边界（§4.4）：本模块只做「preset × 派单参数 × 父级约束 → 不可变快照」的纯计算，
// preset 的归一化在 ai-agent-preset.js（normalizeAgentPreset），运行时注册表在
// ai-agent-preset-registry.js；消费方（ai-subagents.js）负责解析 preset 与落快照。
// 纯函数无副作用：所有路径判定基于字符串规范化，Go 侧（WriteBoundaryCheck）才是权威判定，
// 这里的 writableRoots 前缀比对只是「前端快筛」（§5.5 / §7）。

import {PRESET_FS_MODES, PRESET_COMMAND_EXECUTIONS} from './ai-agent-preset.js';
import {toPosixPath, fsPathContains} from '../../core/path-key.js';

// fs.mode 的宽严序（数值越大越宽）——父档上限取交用。
export const FS_MODE_RANK = Object.freeze({'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2});

// 父会话权限档 → 子代理 fs.mode 上限（§10.3 父档上限取交）。
// full → danger-full-access；auto → workspace-write；read/edit → read-only（edit 档的写审批
// 依赖「人在场」，子代理没有审批通道，preset 声明 workspace-write 会直接派单失败）。
export const PARENT_FS_CAP = Object.freeze({
    full: 'danger-full-access',
    auto: 'workspace-write',
    edit: 'read-only',
    read: 'read-only',
});

// 无快照（异常 / 旧数据）时的防御性缺省：最窄。
export const READ_ONLY_CAPABILITIES = Object.freeze({
    preset: '',
    tools: Object.freeze({allow: Object.freeze([]), deny: Object.freeze([])}),
    fs: Object.freeze({mode: 'read-only', workspaceRoot: '', writableRoots: Object.freeze([]), readRoots: null}),
    execution: Object.freeze({approval: 'never', command: 'denied'}),
    delegation: Object.freeze({canSpawn: false, maxDepth: 0}),
    interaction: Object.freeze({askParent: false}),
    granted: Object.freeze({pluginId: '', parentSessionId: '', at: 0}),
});

function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

// 路径归一与包含判定：**containment 边界统一走 core/path-key.js 的 fsPathContains**
//（唯一实现——「D:/a/bc 误判成 D:/a/b 子路径」这类 bug 正是那道守卫要焊死的）。
// 大小写语义：本前端快筛沿用 Windows 口径（legacyPathKey 转小写，产品单平台）；Go 侧
// 权威判定按平台条件化（fsCaseInsensitiveFS，writeboundary.go）——非 Windows 上前端
// 放宽、Go 收紧，整体仍 fail-closed。
// 本模块额外保留 collapseDotDot（点段折叠）：path-key.js 刻意不解析 `.`/`..`，
// 而防穿越快筛必须在比对前把 `..` 折掉（与 ai-session-scope 的同类豁免口径一致）。
// 注意：fsPathContains 不折叠点段，直接喂原始路径会把 `D:/ws/../x` 误判进 `D:/ws`——
// 所以这里的顺序永远是「先折叠、再 fsPathContains」。

/** 路径是否落在 root 内（含 root 本身），分隔符边界对齐——`D:/a/bc` 不算在 `D:/a/b` 内。 */
export function pathWithin(path, root) {
    return fsPathContains(collapseDotDot(root), collapseDotDot(path));
}

// 逐段折叠 `.` / `..`（防穿越快筛的第一步；符号链接归 Go 侧权威判定，§5.5）。
// 盘符（D:/）与 POSIX 根（/）都算绝对：`..` 不越过根；保留各自的前缀形态。
function collapseDotDot(p) {
    const raw = toPosixPath(String(p || ''));
    const isPosixRoot = raw.startsWith('/');
    const isDriveRoot = /^[a-z]:\//i.test(raw);
    const out = [];
    for (const seg of raw.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!isPosixRoot && !isDriveRoot) out.push('..');
            continue;
        }
        out.push(seg);
    }
    return (isPosixRoot ? '/' : '') + out.join('/');
}

/**
 * writableRoots 前缀快筛：目标绝对路径是否落在任一可写根内。
 * 这是「前端快筛」层，只做字符串规范化比对；符号链接 / TOCTOU 由 Go 侧 WriteBoundaryCheck 兜底（§5.5）。
 */
export function pathInWritableRoots(path, roots) {
    const list = Array.isArray(roots) ? roots : [];
    return list.some((root) => pathWithin(path, root));
}

// Windows 绝对路径（盘符 / UNC）或 POSIX 绝对路径判定。
function isAbsolutePath(p) {
    return /^[a-z]:[\\/]/i.test(p) || /^\\\\/.test(p) || /^[\\/]/.test(p);
}

/**
 * 解析 preset 声明的可写根：相对声明相对 workspaceRoot 解析为绝对路径，解析后定死（§3）。
 * 解析结果逃出 workspaceRoot（`..` 穿越、绝对路径指向工作区外）→ 抛错（§4.2 非法情形）。
 * 没有工作区时相对声明无法解析 → 同样抛错，绝不悄悄放宽。
 * @param {string[]} roots preset 里的 writableRoots（可相对可绝对）
 * @param {string} workspaceRoot 会话工作区绝对路径（可为空串）
 * @returns {string[]} 绝对路径数组（正斜杠形态）
 */
export function resolveWritableRoots(roots, workspaceRoot) {
    const base = textOf(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    /** @type {string[]} */
    const out = [];
    for (const item of Array.isArray(roots) ? roots : []) {
        const raw = textOf(item).trim();
        if (!raw) continue;
        let abs;
        if (isAbsolutePath(raw)) {
            if (!base) {
                // 与相对根同口径 fail-closed：没有工作区根就没有 containment 基准，
                // 绝对可写根等于「无边界写」——不能因为没工作区反而放宽（§4.2）。
                throw new Error('可写根「' + raw + '」是绝对路径，但本次派单没有工作区根，无法校验边界（请先打开文件夹）');
            }
            abs = collapseDotDot(raw);
        } else {
            if (!base) {
                throw new Error('可写根「' + raw + '」是相对路径，但本次派单没有工作区根，无法解析（请先打开文件夹）');
            }
            abs = collapseDotDot(base + '/' + raw);
        }
        if (base && !pathWithin(abs, base)) {
            throw new Error('preset 可写根「' + raw + '」解析后（' + abs + '）逃出工作区 ' + base + '，派单拒绝');
        }
        out.push(abs);
    }
    return out;
}

/**
 * 合成一份子代理能力快照（§3）。所有非法情形直接抛错（§4.2：派单时失败，错误信息带说明）。
 *
 * @param {object} options
 * @param {object} options.preset 归一化后的 preset（normalizeAgentPreset / 宿主内置同形状）
 * @param {string} options.owner preset 注册者（'host' = 宿主内置；插件 id = 插件 preset）
 * @param {string} options.parentScope 派出方会话权限档（read/edit/auto/full）
 * @param {string} options.parentSessionId 派出方会话 id（审计 granted.grantedBy 用）
 * @param {string} options.workspaceRoot 会话工作区绝对路径（可为空）
 * @param {string} [options.worktreePath] 隔离 worktree 绝对路径（isolation=worktree 时由调用方创建后传入）
 * @param {string[]|null} [options.parentToolFace] 父级可让渡工具面；null = 主代理（不设限），
 *        数组 = 嵌套派单时父快照的 allow（父代理自己没有的工具不能给下级，§10.3）
 * @param {Set<string>|string[]} options.knownTools 宿主已知工具全集（未知名 → 派单失败，§4.2）
 * @param {number} options.globalMaxDepth 全局层级上限（subAgentMaxDepth()，0 = 不设限）
 * @param {boolean} [options.grantPresetWrite] preset 自身的写能力是否已获用户确认（§6.3 能力确认）。
 *        false 时 preset 声明的写边界与写工具一律剥掉（降级只读）；worktree 隔离不受它影响——
 *        worktree 写是隔离车道，改动经 export 人工审批回灌，不构成越权写入。
 * @returns {object} DelegatedCapabilities（全部绝对路径，运行期不可变约定由调用方保证）
 */
export function composeAgentCapabilities(options) {
    const opt = options && typeof options === 'object' ? options : {};
    const preset = opt.preset && typeof opt.preset === 'object' ? opt.preset : {};
    const owner = textOf(opt.owner) || 'host';
    const known = opt.knownTools instanceof Set ? opt.knownTools : new Set(Array.isArray(opt.knownTools) ? opt.knownTools : []);
    const parentScope = textOf(opt.parentScope);
    const parentCap = PARENT_FS_CAP[parentScope] || 'read-only';
    const workspaceRoot = textOf(opt.workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    const worktreePath = textOf(opt.worktreePath).replace(/\\/g, '/').replace(/\/+$/, '');

    // —— 工具名校验（§4.2：未知名派单失败，对齐 DSH tools.restrict 的 unknown-name 拒绝）——
    const declaredTools = Array.isArray(preset.tools) ? preset.tools.map(textOf).filter(Boolean) : [];
    const unknown = declaredTools.filter((name) => !known.has(name));
    if (unknown.length) {
        throw new Error('preset「' + textOf(preset.id) + '」声明了未知工具：' + unknown.join('、') + '（工具名必须在宿主工具表里）');
    }
    // 能力面校验（§4.2）：声明「已知但子代理投影不到」的工具（terminal / app_control /
    // memory_write / browser_* 等）同样派单失败——运行期它们永远不会下发，静默损失只会
    // 让模型对着「超出能力快照」的拒绝浪费轮次，错误该在派单期就暴露。
    const projectable = opt.projectableTools instanceof Set
        ? opt.projectableTools
        : (Array.isArray(opt.projectableTools) ? new Set(opt.projectableTools) : null);
    if (projectable) {
        const outside = declaredTools.filter((name) => !projectable.has(name));
        if (outside.length) {
            throw new Error('preset「' + textOf(preset.id) + '」声明了子代理工具面之外的工具：' + outside.join('、')
                + '（这些工具不会下发给子代理；请改用受支持的只读 / 命令 / 写工具）');
        }
    }

    // —— 写边界（§4.2 / §10.3 父档上限取交）——
    const fsDecl = preset.fs && typeof preset.fs === 'object' ? preset.fs : {};
    let fsMode = PRESET_FS_MODES.includes(fsDecl.mode) ? fsDecl.mode : 'read-only';
    // 插件声明 danger-full-access 一律拒绝（§4.2 提权漏洞封堵）；宿主 host.full-write 是唯一
    // 合法来源（用户显式点名的逃生舱，且仅父档 full 可派——下方 cap 校验兜住）。
    if (fsMode === 'danger-full-access' && owner !== 'host') {
        throw new Error('preset「' + textOf(preset.id) + '」不得声明 fs.mode=danger-full-access（完全权限只能由宿主内置 host.full-write 提供）');
    }
    const grantWrite = opt.grantPresetWrite !== false;
    // followParent 是宿主内置 preset 专用语义（§10.4 host.default）：只对 owner='host' 生效。
    // 插件声明它一律按「未声明」处理、走下方显式 mode 的 §10.3 父档校验——否则插件可以借道
    // 跳过父档校验拿到 workspace-write（归一化后的 fs.mode 是 read-only，还会顺带绕过
    // ai-subagents 的能力确认闸：2026-11-28 审查实证的提权口）。
    const followParent = fsDecl.followParent === true && owner === 'host';
    if (!followParent) {
        const rank = FS_MODE_RANK[fsMode];
        const capRank = FS_MODE_RANK[parentCap];
        if (rank > capRank) {
            throw new Error('父会话权限档「' + (parentScope || 'read') + '」不足以授予该能力（需要 fs.mode=' + fsMode +
                '，父档上限是 ' + parentCap + '）。请先提升会话权限档，或换用更窄的 preset。');
        }
    } else {
        // followParent（宿主 host.default 专用）：fs.mode = min(workspace-write, 父档上限)，
        // 等价旧「默认封顶 auto」——full 档父会话也只给 workspace-write（现状默认派单语义）。
        fsMode = FS_MODE_RANK[parentCap] >= FS_MODE_RANK['workspace-write'] ? 'workspace-write' : parentCap;
    }
    let writableRoots = [];
    if (grantWrite && fsMode !== 'read-only' && fsMode !== 'danger-full-access') {
        writableRoots = resolveWritableRoots(fsDecl.writableRoots, workspaceRoot);
        if (!writableRoots.length && workspaceRoot) writableRoots = [workspaceRoot];
    }

    // —— 工具面（§10.3 同取交；嵌套派单时父快照 allow 是上限）——
    const face = Array.isArray(opt.parentToolFace) ? new Set(opt.parentToolFace) : null;
    const allow = declaredTools.filter((name) => !face || face.has(name));

    // —— 隔离 worktree（§7 / §10.1 语义纯化）：只表达隔离方式——
    // **替换语义**（§11.1「worktree 子代理仍只能写隔离前缀」）：writableRoots 一律收敛为
    // 前缀本身——preset 自身声明的根与 host.default 的默认工作区根都不带入（否则
    // host.default + auto 父档会拿到 [前缀 + 整个工作区]，旧 agentWorktreeWriteVerdict 的
    // 前缀外确定性拒绝就丢了：2026-11-28 审查实证的隔离击穿）。写边界收窄到前缀内
    // （连 danger-full-access 也被它收窄——现状 sandbox:'full' + worktree 即如此），
    // 改动经 worktree_manage(export) 人工审批回灌主根。
    // 父档上限取交：preset **显式声明**的写边界照常在上方校验（read/edit 父档拿不到
    // workspace-write，前缀写 ≠ 工作区写）；只有 followParent 的 host.default 例外——
    // 它经这条车道在任意父档（含 read / 计划模式）获得前缀写（现状等价）。
    if (worktreePath) {
        if (fsDecl.mode !== 'read-only') {
            fsMode = 'workspace-write';
            for (const name of ['write_file', 'edit_file']) {
                if (known.has(name) && !allow.includes(name)) allow.push(name);
            }
        }
        // host.read-only（声明只读）+ worktree：preset 声明赢——不挂写工具、fs 保持只读，
        // worktree 只是空隔离区（§10.1「写工具与否由 preset 决定」，2026-11-28 审查定案）。
        writableRoots = [worktreePath];
    }
    if (!grantWrite && !worktreePath) {
        // 未获确认的插件写能力：preset 自身写边界与写工具剥掉（§6.3 撤销后恢复默认只读）。
        // worktree 隔离不受影响——它是隔离车道（改动经 export 人工审批回灌），不是 preset 写能力。
        fsMode = 'read-only';
        writableRoots = [];
        for (const name of ['write_file', 'edit_file']) {
            const at = allow.indexOf(name);
            if (at >= 0) allow.splice(at, 1);
        }
    }

    // 沙箱根：worktree 优先，其次会话工作区，取不到留空由 Go 侧 fail-closed（现状 P2 语义）。
    const sandboxRoot = worktreePath || workspaceRoot;

    // —— 命令通道 / 再派 / 提问 ——
    const execDecl = preset.execution && typeof preset.execution === 'object' ? preset.execution : {};
    const command = PRESET_COMMAND_EXECUTIONS.includes(execDecl.command) ? execDecl.command : 'sandboxed';
    const delegationSource = preset.delegation && typeof preset.delegation === 'object' ? preset.delegation : {};
    const globalMax = Math.max(0, Math.round(Number(opt.globalMaxDepth)) || 0);
    const presetMax = Math.max(0, Math.round(Number(delegationSource.maxDepth)) || 0);
    // 父快照的层级收窄要跨层累积（§3「快照只收窄不放宽」）：只取 min(全局, preset 自己)
    // 的话，祖先 preset 的限制在第二跳就失效（B 插到 C 的判定只看 B 的快照）。
    const parentMax = Math.max(0, Math.round(Number(opt.parentCapsMaxDepth)) || 0);
    const caps = [globalMax, presetMax, parentMax].filter((n) => n > 0);
    // 快照只收窄不放宽：与全局设置 / preset 声明 / 父快照三者取 min；全 0 = 不设限。
    const maxDepth = caps.length ? Math.min(...caps) : 0;
    const interDecl = preset.interaction && typeof preset.interaction === 'object' ? preset.interaction : {};

    // 深冻结：把「快照运行期不可变」从注释约定变成机制——任何代码路径写快照字段（含
    // tools/fs 的数组）在 ESM 严格模式下直接 TypeError，而不是悄悄造成授权漂移。
    return deepFreezeCapabilities({
        preset: textOf(preset.id),
        tools: {allow, deny: []},
        fs: {
            mode: fsMode,
            workspaceRoot: sandboxRoot,
            writableRoots,
            // 读边界沿用现有 scope 授权链，快照不接管（§0.3 第 3 条）。
            readRoots: null,
        },
        execution: {approval: 'never', command},
        delegation: {canSpawn: delegationSource.canSpawn === true, maxDepth},
        interaction: {askParent: interDecl.askParent !== false},
        granted: {
            pluginId: owner,
            parentSessionId: textOf(opt.parentSessionId),
            at: Date.now(),
        },
    });
}

// 递归冻结纯数据快照（对象 / 数组；不含 Map/Set——快照只有纯数据）。
function deepFreezeCapabilities(value) {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreezeCapabilities(value[key]);
        Object.freeze(value);
    }
    return value;
}

/**
 * 结构化拒绝文案（§5.2 执行前 guard / §6.1：拒绝信息必须包含「缺什么权限/路径」）。
 * @param {string} toolName 被拒工具名
 * @param {object|null} caps 能力快照
 */
export function subToolDenyText(toolName, caps) {
    const fs = caps && caps.fs ? caps.fs : READ_ONLY_CAPABILITIES.fs;
    const preset = caps && caps.preset ? '（preset ' + caps.preset + '）' : '';
    const detail = fs.mode === 'read-only'
        ? '本子代理为只读授权，未获得写工具与写边界。'
        : '本子代理可写范围（writableRoots）：' + (fs.writableRoots || []).join('、') + '；该工具不在授权工具面内。';
    return '工具 ' + toolName + ' 超出子代理能力快照' + preset + '：工具面在派出时已固定，无法从会话内放宽。'
        + detail
        + '不要重试或换写法，在最终结论中说明该限制即可，由主代理决定如何处理。';
}

/**
 * 子代理文件写入判定（§5.3）：按 fs.mode + writableRoots 快筛。
 * 前端只做快筛；workspace-write 的落盘前权威判定在 Go 侧（WriteBoundaryCheck，§5.5）。
 * @returns {{verdict:'allow'|'deny', source:string, reason:string}}
 */
export function subWriteVerdict(caps, absPath) {
    const fs = caps && caps.fs ? caps.fs : READ_ONLY_CAPABILITIES.fs;
    const mode = PRESET_FS_MODES.includes(fs.mode) ? fs.mode : 'read-only';
    if (mode === 'danger-full-access') return {verdict: 'allow', source: 'agent-full', reason: ''};
    if (mode === 'workspace-write') {
        const roots = Array.isArray(fs.writableRoots) ? fs.writableRoots : [];
        if (pathInWritableRoots(absPath, roots)) return {verdict: 'allow', source: 'agent-caps', reason: ''};
        return {verdict: 'deny', source: 'agent-caps', reason: '超出子代理可写范围（writableRoots：' + roots.join('、') + '）'};
    }
    return {verdict: 'deny', source: 'agent-caps', reason: '能力快照为只读（fs.mode=read-only），写工具本不该挂载'};
}

/**
 * 序列化能力快照（§8.1：全绝对路径，恢复时不需重新解析）。结构不完整返回 null。
 */
export function serializeCapabilities(caps) {
    if (!caps || typeof caps !== 'object') return null;
    const fs = caps.fs && typeof caps.fs === 'object' ? caps.fs : null;
    if (!fs || !PRESET_FS_MODES.includes(fs.mode)) return null;
    const tools = caps.tools && typeof caps.tools === 'object' ? caps.tools : {};
    const execution = caps.execution && typeof caps.execution === 'object' ? caps.execution : {};
    const delegation = caps.delegation && typeof caps.delegation === 'object' ? caps.delegation : {};
    const interaction = caps.interaction && typeof caps.interaction === 'object' ? caps.interaction : {};
    const granted = caps.granted && typeof caps.granted === 'object' ? caps.granted : {};
    return {
        preset: textOf(caps.preset),
        tools: {
            allow: (Array.isArray(tools.allow) ? tools.allow : []).map(textOf).filter(Boolean),
            deny: (Array.isArray(tools.deny) ? tools.deny : []).map(textOf).filter(Boolean),
        },
        fs: {
            mode: fs.mode,
            workspaceRoot: textOf(fs.workspaceRoot),
            writableRoots: (Array.isArray(fs.writableRoots) ? fs.writableRoots : []).map(textOf).filter(Boolean),
            readRoots: null,
        },
        execution: {
            approval: 'never',
            command: PRESET_COMMAND_EXECUTIONS.includes(execution.command) ? execution.command : 'sandboxed',
        },
        delegation: {
            canSpawn: delegation.canSpawn === true,
            maxDepth: Math.max(0, Math.round(Number(delegation.maxDepth)) || 0),
        },
        interaction: {askParent: interaction.askParent !== false},
        granted: {
            pluginId: textOf(granted.pluginId),
            parentSessionId: textOf(granted.parentSessionId),
            at: Math.max(0, Math.round(Number(granted.at)) || 0),
        },
    };
}

/**
 * 解析落盘的能力快照（§8.2）：字段逐个校验，坏数据返回 null（快照缺关键字段 → 拒绝续跑）。
 * 恢复只按快照重建、不能扩大原授权：工具名原样保留（不与当前注册表取交——卸载的插件工具
 * 会在投影层天然失效，删名字反而可能让「恢复后的面」与审计记录不一致）。
 */
export function parseCapabilities(raw) {
    const caps = serializeCapabilities(raw);
    if (!caps) return null;
    return caps;
}
