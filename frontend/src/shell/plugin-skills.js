// @ts-check
// plugin-skills.js：插件注册的斜杠技能（cadt.registerSkill）注册表——纯逻辑、无 DOM，可单测。
//
// 与文件技能（ai-panel.js 的 listSkillsRaw 扫 SKILL.md）并列：插件用声明式 API 注册
// 技能，正文由 content() 惰性提供（插件 apply 只有 5 秒，不能预加载全部正文）。
// 本模块负责归一化、上限、重名检测、when 求值与错误隔离；AI 面板把 getPluginSkillList()
// 的结果合并进技能候选（rank 300，位于工作区之后 / 应用之前）。

import {PLUGIN_CTX_ORIGINS, pluginCtxBase, withCtx} from './plugin-ctx.js';

export const MAX_SKILLS_PER_PLUGIN = 64;
export const MAX_SKILLS_TOTAL = 200;
export const MAX_SKILL_DESC = 200;
export const MAX_SKILL_CONTENT = 64 * 1024;
export const SKILL_NAME_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @type {Map<string, any>} fullName(`${pluginId}:${name}`) → record */
const skills = new Map();

/** @param {string} message */
function bad(message) {
    throw new Error('[registerSkill] ' + message);
}

/** @param {any} value */
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * 归一化一条技能声明。校验失败抛错（plugins.js 包成插件名前缀）。
 * @param {string} pluginId
 * @param {string} pluginName
 * @param {any} spec
 */
export function normalizePluginSkill(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner) bad('缺少插件 id');
    if (!isPlainObject(spec)) bad('需要一个技能对象');
    const name = String(spec.name || '').trim();
    if (!SKILL_NAME_RULE.test(name)) bad(`技能名无效：${JSON.stringify(spec.name)}（需小写字母/数字/连字符）`);
    if (typeof spec.content !== 'function') bad(`技能 ${name} 缺少 content 函数`);
    if (spec.when != null && typeof spec.when !== 'function') bad(`技能 ${name} 的 when 必须是函数`);
    const description = String(spec.description == null ? '' : spec.description).trim().slice(0, MAX_SKILL_DESC);
    if (!description) bad(`技能 ${name} 缺少 description`);
    return {
        key: owner + ':' + name,
        pluginId: owner,
        pluginName: String(pluginName || owner),
        name,
        description,
        content: spec.content,
        when: typeof spec.when === 'function' ? spec.when : null,
    };
}

/**
 * 注册技能，返回撤销函数。
 * @param {string} pluginId
 * @param {string} pluginName
 * @param {any} spec
 * @returns {() => void}
 */
export function registerPluginSkill(pluginId, pluginName, spec) {
    const record = normalizePluginSkill(pluginId, pluginName, spec);
    if (skills.has(record.key)) bad(`技能 ${record.name} 已注册`);
    let owned = 0;
    for (const item of skills.values()) if (item.pluginId === record.pluginId) owned += 1;
    if (owned >= MAX_SKILLS_PER_PLUGIN) bad(`单插件技能数超过上限 ${MAX_SKILLS_PER_PLUGIN}`);
    if (skills.size >= MAX_SKILLS_TOTAL) bad(`插件技能总数超过上限 ${MAX_SKILLS_TOTAL}`);
    skills.set(record.key, record);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        if (skills.get(record.key) === record) skills.delete(record.key);
    };
}

export function clearPluginSkills() {
    skills.clear();
}

/** @param {string} pluginId */
export function removePluginSkillsByOwner(pluginId) {
    for (const [key, rec] of skills) if (rec.pluginId === pluginId) skills.delete(key);
}

/** 原始记录（含 content 函数），供需要懒求值的消费方使用。 */
export function getPluginSkillRecords() {
    return [...skills.values()];
}

/**
 * 求值 when + 读取 content，产出可直接并入技能候选的列表。
 * 单条失败（when/content 抛错、超时、超限、非字符串）只跳过该条，不影响其他技能。
 * @param {any} runtimeCtx 传给 when/content 的上下文（含 plugin / workspace / sessionId / origin）
 * @returns {Promise<Array<{name:string,description:string,path:string,source:string,rank:number,content:string,pluginId:string,pluginName:string,when:boolean}>>}
 */
export async function getPluginSkillList(runtimeCtx) {
    const ctx = runtimeCtx && typeof runtimeCtx === 'object' ? runtimeCtx : {};
    // 先同步筛 when，再**并发**读取所有 content（不能串行 await——12 个技能会变成 12 个往返）
    const pending = [];
    for (const record of skills.values()) {
        // 每条技能按自己的身份重建 ctx 基座：插件在 when/content 里读 ctx.plugin.id
        // 应拿到自己的 id，而不是宿主传进来的空壳（plugin-ctx.js 的 withCtx 保证 plugin 恒取基座）。
        const callCtx = withCtx(pluginCtxBase({
            pluginId: record.pluginId,
            pluginName: record.pluginName,
            workspace: ctx.workspace,
            sessionId: ctx.sessionId,
            origin: PLUGIN_CTX_ORIGINS.prompt,
        }), ctx);
        // when 同步返回布尔；抛错 / 非布尔按「不满足」处理（防御插件误写 async when）
        if (record.when) {
            try {
                const verdict = record.when(callCtx);
                if (verdict !== true) continue;
            } catch (e) {
                continue;
            }
        }
        pending.push({record, promise: readContent(record, callCtx)});
    }
    const out = [];
    for (const {record, promise} of pending) {
        let content;
        try {
            content = await promise;
        } catch (e) {
            continue; // 单条失败（抛错 / 超时 / 非字符串）只跳过该条
        }
        out.push({
            name: record.name,
            description: content.description,
            path: '', // 插件技能无磁盘路径，附件走 content
            source: 'plugin',
            rank: 300, // AI_SKILL_RANKS.plugin：工作区(100/200) 之后、应用(400) 之前
            content: content.text,
            pluginId: record.pluginId,
            pluginName: record.pluginName,
            when: true,
        });
    }
    return out;
}

/**
 * 读取单条 content：string 或 Promise<string>，单点超时 1 s；非字符串 / 空正文拒绝。
 * @param {any} record
 * @param {any} ctx
 * @returns {Promise<{text: string, description: string}>}
 */
function readContent(record, ctx) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('content 超时（1 s）')), 1000);
    });
    return Promise.race([
        Promise.resolve().then(() => record.content(ctx)).then((value) => {
            clearTimeout(timer);
            // 只接受字符串：数字 / 对象等视为无效声明，跳过该技能（不静默 String() 化）
            if (typeof value !== 'string') throw new Error('content 必须返回字符串');
            let text = value;
            let description = record.description;
            if (text.length > MAX_SKILL_CONTENT) {
                text = text.slice(0, MAX_SKILL_CONTENT);
                description = description.slice(0, Math.max(0, MAX_SKILL_DESC - 7)) + '（已截断）';
            }
            if (!text.trim()) throw new Error('content 为空');
            return {text, description};
        }, (e) => {
            clearTimeout(timer);
            throw e;
        }),
        timeout,
    ]);
}
