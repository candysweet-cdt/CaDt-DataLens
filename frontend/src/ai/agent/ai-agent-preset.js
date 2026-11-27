// ai-agent-preset.js：声明式 Agent Preset + 每 agent 的作用域注册层（平台原语 S6，对齐 Cordis）。
//
// DSH 的 Agent Preset 是「一个目录（agent.cordis.yml + preset.yml）决定工具集 + persona +
// prompt sections + realm 隔离」。本模块把这套契约落成纯数据 + 纯函数：
//   · normalizeAgentPreset：把一份声明（可来自插件 / 配置 / 会话 meta）归一成稳定形状；
//   · createAgentScope：每个 live agent 的扁平注册层 agent.ctx——工具 / 提示 / 变量只对该
//     agent 可见，按 owner 一次性撤销（与 container/hook-bus 同口径）。
//
// 边界：这里只管「声明与作用域」，不读文件、不碰 DOM、不解析 YAML——YAML→对象的解析由宿主
// 负责（本仓库不打包 YAML 解析器，插件可直接传 JS 对象）。纯函数便于单测，无副作用。

/** preset 字段上限：防止一份恶意声明把上下文撑爆。 */
export const PRESET_NAME_MAX = 64;
export const PRESET_PERSONA_MAX = 4096;
export const PRESET_SECTION_MAX = 24;
export const PRESET_SECTION_TEXT_MAX = 8000;
export const PRESET_TOOLS_MAX = 128;
export const PRESET_VARS_MAX = 64;
export const PRESET_REALM_MAX = 64;

function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function clampText(value, max) {
    return textOf(value).slice(0, max);
}

/** realm 名规则：点分命名空间，与容器服务名 / 钩子事件名同口径。 */
const REALM_RULE = /^[a-z0-9][a-z0-9._:/-]*$/i;

/**
 * 归一化一份声明式 preset。
 * 输入形状（均可缺省）：
 *   {id, name, persona, promptSections: [{id, text}], tools: [string], realm, variables: {k:v}}
 * 输出字段全部有值，数组/对象为新建副本（不引用入参），便于冻结与比较。
 * @param {any} raw
 * @returns {{id:string,name:string,persona:string,promptSections:Array<{id:string,text:string}>,tools:string[],realm:string,variables:Record<string,string>}}
 */
export function normalizeAgentPreset(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = clampText(source.id, PRESET_NAME_MAX).trim();
    const realmRaw = clampText(source.realm, PRESET_REALM_MAX).trim();
    const realm = REALM_RULE.test(realmRaw) ? realmRaw : '';
    const sections = [];
    if (Array.isArray(source.promptSections)) {
        for (const item of source.promptSections.slice(0, PRESET_SECTION_MAX)) {
            if (!item || typeof item !== 'object') continue;
            const sid = clampText(item.id, PRESET_NAME_MAX).trim();
            if (!sid) continue;
            sections.push({id: sid, text: clampText(item.text, PRESET_SECTION_TEXT_MAX)});
        }
    }
    const tools = [];
    if (Array.isArray(source.tools)) {
        for (const name of source.tools) {
            const t = clampText(name, PRESET_NAME_MAX).trim();
            if (t && !tools.includes(t) && tools.length < PRESET_TOOLS_MAX) tools.push(t);
        }
    }
    /** @type {Record<string,string>} */
    const variables = {};
    if (source.variables && typeof source.variables === 'object' && !Array.isArray(source.variables)) {
        let count = 0;
        for (const [key, value] of Object.entries(source.variables)) {
            if (count >= PRESET_VARS_MAX) break;
            const k = clampText(key, PRESET_NAME_MAX).trim();
            if (!k) continue;
            variables[k] = clampText(value, PRESET_SECTION_TEXT_MAX);
            count += 1;
        }
    }
    return {
        id,
        name: clampText(source.name, PRESET_NAME_MAX).trim() || id || '未命名预设',
        persona: clampText(source.persona, PRESET_PERSONA_MAX),
        promptSections: sections,
        tools,
        realm,
        variables,
    };
}

/**
 * 把 preset 的提示片段按 id 拼成一段文本（稳定顺序：按声明顺序）。
 * persona 单独返回，便于宿主放进 persona 专用槽而不是混进系统提示词。
 * @param {ReturnType<typeof normalizeAgentPreset>} preset
 */
export function presetPromptSections(preset) {
    const sections = preset && Array.isArray(preset.promptSections) ? preset.promptSections : [];
    return sections.map((s) => clampText(s && s.text, PRESET_SECTION_TEXT_MAX)).filter(Boolean).join('\n\n');
}

/**
 * 创建每 live agent 的扁平注册层 agent.ctx。
 *
 * 三层内容：tools（工具白名单）/ prompts（提示片段）/ vars（变量），全部按 key 隔离；
 * 同 key 后写覆盖前写；set 返回撤销函数（幂等，只撤自己那一份）。
 * dispose() 一次性清空该 agent 的全部注册——agent 结束时不残留、不串到别的 agent。
 * @param {{owner?: string, realm?: string}} [meta]
 */
export function createAgentScope(meta = {}) {
    const owner = textOf(meta.owner).trim();
    const realm = textOf(meta.realm).trim();
    /** @type {Map<string, any>} */
    const tools = new Map();
    /** @type {Map<string, string>} */
    const prompts = new Map();
    /** @type {Map<string, any>} */
    const vars = new Map();
    let disposed = false;

    function assertKey(key) {
        const k = textOf(key).trim();
        if (!k) throw new Error('[agent-scope] key 不能为空');
        return k;
    }

    function setter(store) {
        return (key, value) => {
            if (disposed) throw new Error('[agent-scope] 作用域已释放');
            const k = assertKey(key);
            store.set(k, value);
            return () => { if (store.get(k) === value) store.delete(k); };
        };
    }

    const setTool = setter(tools);
    const setPrompt = setter(prompts);
    const setVar = setter(vars);

    /** 用一份 preset 初始化作用域（工具集 / 提示片段 / 变量）。 */
    function applyPreset(preset) {
        const p = normalizeAgentPreset(preset);
        for (const name of p.tools) setTool(name, true);
        for (const section of p.promptSections) setPrompt(section.id, section.text);
        for (const [key, value] of Object.entries(p.variables)) setVar(key, value);
        return p;
    }

    function dispose() {
        disposed = true;
        tools.clear();
        prompts.clear();
        vars.clear();
    }

    return {
        owner,
        realm,
        setTool,
        setPrompt,
        setVar,
        applyPreset,
        hasTool: (key) => tools.has(textOf(key).trim()),
        getPrompt: (key) => prompts.get(textOf(key).trim()),
        getVar: (key) => vars.get(textOf(key).trim()),
        toolNames: () => [...tools.keys()],
        promptIds: () => [...prompts.keys()],
        varKeys: () => [...vars.keys()],
        dispose,
        get disposed() { return disposed; },
    };
}
