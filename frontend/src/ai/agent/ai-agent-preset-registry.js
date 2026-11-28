// ai-agent-preset-registry.js：Agent Preset 运行时注册表 + 宿主内置 preset（§4 / §10.4）。
//
// 注册表是唯一的运行时入口：插件经 cadt.registerAgentPreset 声明业务角色（写作插件的
// drafting / review 等），宿主内置三个 preset 承载旧派单参数的语义（§10.4）。归一化统一走
// normalizeAgentPreset（§4.4：不另立第二套 preset 归一化）；本模块只做注册、查找、按 owner
// 撤销与能力确认记录（§6.3）。跨域消费经组合根接线：shell/plugins.js 经 initPluginRuntime
// 的 host 钩子拿注册函数（shell 不直接 import ai/ 域），ai/ 域内部直接 import 本模块。
//
// 注意（§10.4）：未传 preset 参数时用 host.default——这不是兼容层，默认 preset 是新模型的
// 第一等公民，只是其能力面恰好等于现状默认派单。

import {normalizeAgentPreset, PRESET_NAME_MAX} from './ai-agent-preset.js';
import {AI_TOOL_DEFS} from '../tools/ai-tool-defs.js';
import {legacyPathKey} from '../../core/path-key.js';
import {kvGet, kvSet, kvRemove, kvKeysWithPrefix} from '../../core/kv-store.js';
import {AI_AGENT_PRESET_GRANT_KEY_PREFIX} from '../../core/storage-keys.js';

// 宿主内置 preset 的工具面三件套（§10.4）。只读面与现状 subToolsForScope 的静态白名单一致
// （动态条件——视频能力 / 认知开关 / 后台 ask_user / 层级 spawn——由投影层按会话状态收窄，
// 快照只管「许可」，不管「环境可用性」）。
export const HOST_READONLY_TOOLS = Object.freeze([
    'list_dir', 'read_file', 'read_image', 'read_video', 'search_text', 'web_search', 'web_fetch',
    'code_outline', 'memory_list', 'memory_read', 'timer_list', 'agent_tree',
    'skill_use', 'env_list', 'cognition_read', 'cognition_status',
    'ask_user', 'spawn_agent', 'wait_agent', 'agent_send',
]);
export const HOST_COMMAND_TOOLS = Object.freeze(['run_command', 'background_command', 'check_command', 'stop_command']);
export const HOST_WRITE_TOOLS = Object.freeze(['write_file', 'edit_file']);

export const HOST_PRESET_DEFAULT = 'host.default';
export const HOST_PRESET_READ_ONLY = 'host.read-only';
export const HOST_PRESET_FULL_WRITE = 'host.full-write';

// 宿主内置 preset（§10.4 表）。fs.followParent 是 host.default 专用语义：
// fs.mode = min(workspace-write, 父档上限)——等价旧「默认封顶 auto」。
const HOST_PRESETS = [
    {
        id: HOST_PRESET_DEFAULT,
        name: '默认子代理',
        tools: [...HOST_READONLY_TOOLS, ...HOST_COMMAND_TOOLS],
        fs: {mode: 'workspace-write', followParent: true},
        execution: {command: 'sandboxed'},
        delegation: {canSpawn: true},
        interaction: {askParent: true},
    },
    {
        id: HOST_PRESET_READ_ONLY,
        name: '只读子代理',
        tools: [...HOST_READONLY_TOOLS],
        fs: {mode: 'read-only'},
        execution: {command: 'denied'},
        // 只读面不再派下层：编排强制收窄（阶段零）落在这个 preset 上，再派会让孙代理
        // 绕开「强制只读」的收窄范围；显式点名它做纯调查的派单同样不需要下级。
        delegation: {canSpawn: false},
        interaction: {askParent: true},
    },
    {
        id: HOST_PRESET_FULL_WRITE,
        name: '完全权限子代理',
        tools: [...HOST_READONLY_TOOLS, ...HOST_COMMAND_TOOLS, ...HOST_WRITE_TOOLS],
        fs: {mode: 'danger-full-access'},
        execution: {command: 'sandboxed'},
        delegation: {canSpawn: true},
        interaction: {askParent: true},
    },
];

const PRESET_ID_RULE = /^[a-z0-9][a-z0-9._:-]*$/i;

/** @type {Map<string, {owner: string, preset: object}>} id → 注册条目 */
const registry = new Map();

function initHostPresets() {
    for (const raw of HOST_PRESETS) {
        registry.set(raw.id, {owner: 'host', preset: normalizeAgentPreset(raw)});
    }
}
initHostPresets();

/** 宿主已知工具全集（§4.2 未知名拒绝的判定来源）。 */
export function knownAgentToolNames() {
    return new Set(Object.keys(AI_TOOL_DEFS));
}

/**
 * 子代理工具面**可投影**的工具全集（§4.2 能力面校验的判定来源）：宿主内置三件套的并集。
 * 子代理投影层（subToolsForCapabilities）只从固定目录挂载——preset 声明这之外的已知工具
 * （terminal / app_control / memory_write / browser_* 等）虽然「存在」，但永远不会下发，
 * 属于声明期就该失败的能力面错误，而不是运行期静默损失。
 */
export function subagentProjectableToolNames() {
    return new Set([...HOST_READONLY_TOOLS, ...HOST_COMMAND_TOOLS, ...HOST_WRITE_TOOLS]);
}

/**
 * 注册一份 preset。结构性非法直接抛错（id / owner）；能力面的非法声明
 * （danger-full-access、未知工具名）在派单合成时拒绝（§4.2 的「派单时失败」口径），
 * 这里不拦——插件可以先注册、派单时才暴露问题，错误信息会带 preset id。
 * @param {object} raw 声明（normalizeAgentPreset 的输入形状 + fs/delegation/execution/interaction）
 * @param {string} owner 注册者（插件 id；宿主内置不走这里）
 */
export function registerAgentPreset(raw, owner) {
    const ownerText = String(owner == null ? '' : owner).trim();
    if (!ownerText || ownerText === 'host') {
        throw new Error('agent preset 注册缺少插件 owner（宿主内置 preset 不可覆盖）');
    }
    if (!raw || typeof raw !== 'object') {
        throw new Error('registerAgentPreset 需要一个 preset 声明对象');
    }
    const preset = normalizeAgentPreset(raw);
    const id = String(preset.id || '').trim();
    if (!id || id.length > PRESET_NAME_MAX || !PRESET_ID_RULE.test(id)) {
        throw new Error('agent preset id 无效：' + JSON.stringify(raw && raw.id) + '（点分命名空间，如 webnovel.drafting）');
    }
    // host.* 是宿主可信命名空间（模型与文档按前缀判定归属）：插件不得占用，
    // 否则「host. 前缀 = 宿主内置」的语义被稀释（能力判定仍按 owner，这里是身份语义）。
    if (/^host[.:]/i.test(id)) {
        throw new Error('agent preset id 不得占用宿主命名空间 host.*：' + id);
    }
    if (registry.has(id)) {
        throw new Error('agent preset ' + id + ' 已注册（宿主内置或与其他插件冲突）');
    }
    const entry = {owner: ownerText, preset};
    registry.set(id, entry);
    return entry.preset;
}

/** 按 owner 撤销（插件禁用 / 加载失败）。宿主内置（owner='host'）不受影响。返回撤销条数。 */
export function unregisterAgentPresetsByOwner(owner) {
    const ownerText = String(owner == null ? '' : owner).trim();
    if (!ownerText || ownerText === 'host') return 0;
    let n = 0;
    for (const [id, entry] of [...registry]) {
        if (entry.owner === ownerText) {
            registry.delete(id);
            n++;
        }
    }
    return n;
}

/** 清掉全部插件 preset，保留宿主内置（插件重放前调用，与 clearPlugin* 同批）。 */
export function revokeAllPluginAgentPresets() {
    let n = 0;
    for (const [id, entry] of [...registry]) {
        if (entry.owner !== 'host') {
            registry.delete(id);
            n++;
        }
    }
    return n;
}

/** 查找：返回 {owner, preset}；未注册返回 null（派单失败：错误信息带合法候选清单，§4.2）。 */
export function getAgentPreset(id) {
    const key = String(id == null ? '' : id).trim();
    return registry.get(key) || null;
}

/** 全部已注册 preset 的候选清单（错误信息 / 诊断用）。 */
export function listAgentPresetIds() {
    return [...registry.keys()];
}

/** 是否宿主内置 preset（能力确认只针对插件 preset，§6.3）。 */
export function isHostPresetId(id) {
    const entry = registry.get(String(id == null ? '' : id).trim());
    return !!entry && entry.owner === 'host';
}

// ---- 能力确认记录（§6.3）：按「插件 + preset + 工作区 + 声明摘要」存一次授权，localStorage 持久 ----
// 键名前缀登记在 core/storage-keys.js（键名字面量唯一登记处）。

// 声明摘要（非加密，仅防「改宽声明后继承旧授权」）：mode + 排序归一后的 writableRoots。
// 插件把可写根扩宽 → 摘要变化 → 旧确认失效、重新弹卡（确认必须绑定能力内容）。
function presetGrantDigest(fsDecl) {
    const decl = fsDecl && typeof fsDecl === 'object' ? fsDecl : {};
    // 根的形态归一走 core/path-key.js 唯一实现（转斜杠 + 去尾斜杠 + 小写）
    const roots = Array.isArray(decl.writableRoots)
        ? [...decl.writableRoots].map((r) => legacyPathKey(r)).sort()
        : [];
    const payload = JSON.stringify({mode: String(decl.mode || ''), roots});
    let h = 0;
    for (let i = 0; i < payload.length; i++) h = (h * 31 + payload.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

function grantKey(owner, presetId, workspace, fsDecl) {
    // workspace 归一（legacyPathKey：转斜杠 / 去尾斜杠 / 小写），同一工作区不同写法命中同一确认记录。
    // workspace 空（无工作区会话）时归 'default' 桶——跨无工作区会话共享一桶，可接受。
    const ws = legacyPathKey(workspace) || 'default';
    // 分隔符用 ':'：encodeURIComponent 不转义 '.'，而 owner / presetId 都是插件可控的点分串，
    // '.' 拼接会让 (com.x, y.z) 与 (com, x.y.z) 撞键；':' 会被转义成 %3A，无歧义。
    return AI_AGENT_PRESET_GRANT_KEY_PREFIX + encodeURIComponent(String(owner))
        + ':' + encodeURIComponent(String(presetId))
        + ':' + encodeURIComponent(ws)
        + ':' + presetGrantDigest(fsDecl);
}

/** 该插件 preset（按声明摘要）在该工作区是否已获写入确认。 */
export function hasPresetGrant(owner, presetId, workspace, fsDecl) {
    return kvGet(grantKey(owner, presetId, workspace, fsDecl)) === '1';
}

/** 记录一次能力确认（主代理首次派该 preset 的派单调用上由用户拍板）。 */
export function recordPresetGrant(owner, presetId, workspace, fsDecl) {
    kvSet(grantKey(owner, presetId, workspace, fsDecl), '1');
}

/** 撤销确认（撤销后新派子代理恢复默认只读；确认卡会再次出现）。 */
export function revokePresetGrant(owner, presetId, workspace, fsDecl) {
    kvRemove(grantKey(owner, presetId, workspace, fsDecl));
}

// 按 owner 枚举的键前缀：grantKey 里 owner 段后跟 ':'（encodeURIComponent 不产生 ':'），无歧义。
function grantOwnerPrefix(owner) {
    return AI_AGENT_PRESET_GRANT_KEY_PREFIX + encodeURIComponent(String(owner == null ? '' : owner)) + ':';
}

/** 该插件名下已确认的写入授权条数（设置页撤销入口的显隐判定）。 */
export function countPresetGrantsByOwner(owner) {
    return kvKeysWithPrefix(grantOwnerPrefix(owner)).length;
}

/**
 * 按 owner 撤销该插件的全部能力确认（设置页「撤销写入确认」入口，§6.3）。
 * 撤销后新派子代理恢复默认只读，确认卡在下次派单重新出现。返回撤销条数。
 */
export function revokePresetGrantsByOwner(owner) {
    const keys = kvKeysWithPrefix(grantOwnerPrefix(owner));
    for (const key of keys) kvRemove(key);
    return keys.length;
}
