// model-catalog.js：模型配置表——「模型 ID → 窗口 / 能力 / 推理支持」的单一来源。
// 内置一份快照随 exe 走；远端（cadt-datalens-data/model-catalog 的 catalog.json）可在设置页手动同步，
// 或超过 CATALOG_STALE_MS 后启动静默同步。合并规则：远端同 ID 覆盖内置、远端多出的追加；
// 远端内容解析失败整份丢弃，绝不半份生效。
//
// 表只管「事实」（这个模型有多大窗口、收不收图、支不支持 reasoning_effort），
// 不管「偏好」（温度、思考预算这些是用户的，见 ai-config-model.js 的条目字段）。
// 任何字段都可以缺省 —— 缺省表示「不知道」，此时不回填、不改变原有可见性，
// 宁可漏填也不能填错（填错窗口会静默截断输出，比不填更糟）。

import {CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, MODALITY_KEYS, OUTPUT_WINDOW_MAX, OUTPUT_WINDOW_MIN} from './ai-config-model.js';
import {parseJson} from '../../core/json-safe.js';

// 远端单文件仓库的默认地址（Gitee raw，公开组织 cadt-datalens-data）；设置页可覆盖。
export const CATALOG_URL_DEFAULT = 'https://gitee.com/cadt-datalens-data/model-catalog/raw/main/catalog.json';
// GitHub 镜像的默认地址；「设置 → 插件 → 数据源」切到 GitHub 时走这条。
export const CATALOG_URL_GITHUB = 'https://raw.githubusercontent.com/cadt-datalens-data/model-catalog/main/catalog.json';

// 超过这个时长就认为缓存过期（自动同步只在过期时触发）。
export const CATALOG_STALE_MS = 7 * 24 * 3600 * 1000;

// 内置快照。数据由人工维护并**注明出处**，新增模型优先改这里再发版；
// 只是「已知模型」的起点，远端表可以在不发版的情况下覆盖它。
//
// 一致性要求：改这里必须同步更新 version，并跑一次
//   node scripts/export-model-catalog.mjs > catalog.json
// 把远端仓库（cadt-datalens-data/model-catalog）那份一起提交，否则两边会漂。
//
// 出处（2026-11-17 核对）：
//   OpenCode  https://opencode.ai/inference/v1/models（官方元数据端点，覆盖 Anthropic /
//             OpenAI / Google / DeepSeek / GLM / Kimi / MiniMax / Qwen / Grok / Mistral /
//             Muse / Nemotron / 混元 Hy / 小米 MiMo 及全部 -free 免费档；窗口、模态、
//             推理档位均取该端点实测值，最权威）
//   阿里百炼  「文本生成与视觉理解」模型表（qwen4/qwen3.7 等百炼独有 ID）
//   火山方舟  模型列表（doubao-seed-2.1 系列）
//   腾讯混元  TokenHub 模型列表（hy4 / hy3 / hy4-preview 等 Go 专属变体）
//   其它      Step、ERNIE、mimo-v2.6-pro-ultraspeed 取厂商或云平台公开口径
//
// ⚠️ -free 免费档窗口普遍低于付费正主（如 deepseek-v4.1-flash-free 是 200K/32K，付费版
//    1M/384K），所以 -free 一律作为独立条目按实测值录入，**不做后缀剥离复用正主窗口**。
export const BUILTIN_CATALOG = {
    version: '2026.11.17',
    source: '内置',
    models: [
        // ================= DeepSeek（端点：1M 上下文 / 384K 输出；V4.1 Flash 收图）=================
        {id: 'deepseek-flash', vendor: 'deepseek', contextWindow: 1048576, outputWindow: 393216, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'deepseek-v4.1-flash', vendor: 'deepseek', contextWindow: 1000000, outputWindow: 384000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'deepseek-v4.1-flash-free', vendor: 'deepseek', contextWindow: 200000, outputWindow: 32000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'deepseek-v4-pro', vendor: 'deepseek', contextWindow: 1000000, outputWindow: 384000, modalities: {text: true}, reasoningEffort: true},
        // 百炼/方舟上带日期后缀的同款（运维常用这个 ID）
        {id: 'deepseek-v4-pro-0813', vendor: 'deepseek', contextWindow: 1000000, outputWindow: 384000, modalities: {text: true}, reasoningEffort: true},

        // ================= Anthropic（端点：当期 1M / 128K；4.5 及更早 200K / 64K）=================
        // thinking=true 表示支持扩展思考；thinkingBudget=false 表示只接受自适应思考（4.6 起）
        {id: 'claude-fable-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-fable-5-1', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-fable-5-2', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-opus-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-opus-5-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-sonnet-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-sonnet-5-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-haiku-5-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-opus-4-8', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-opus-4-7', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-opus-4-6', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 128000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-sonnet-4-6', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 64000, modalities: {text: true, image: true}, thinking: true},
        // 仍在服务、且是旧预设默认值的型号，保留以免老配置失去回填（端点：sonnet-4-5 已是 1M）
        {id: 'claude-sonnet-4-5', vendor: 'anthropic', contextWindow: 1000000, outputWindow: 64000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-opus-4-5', vendor: 'anthropic', contextWindow: 200000, outputWindow: 64000, modalities: {text: true, image: true}, thinking: true},
        {id: 'claude-haiku-4-5', vendor: 'anthropic', contextWindow: 200000, outputWindow: 64000, modalities: {text: true, image: true}, thinking: true},

        // ================= OpenAI（端点：5.4 起旗舰 1050000/128K；5.x 标准 400K/128K）=================
        // 全系收图 + reasoningEffort；gpt-5.3-codex-spark 例外（纯文本、128K/128K）
        {id: 'gpt-6.1-sol', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-6-astra', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-6-sol', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-6-luna', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.6-sol', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.6-terra', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.6-luna', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.5-pro', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.5', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.4-pro', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.4', vendor: 'openai', contextWindow: 1050000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.4-mini', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.4-nano', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.3-codex', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.3-codex-spark', vendor: 'openai', contextWindow: 128000, outputWindow: 128000, modalities: {text: true}, reasoningEffort: true},
        {id: 'gpt-5.2', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.2-codex', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.1', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.1-codex', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.1-codex-max', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5.1-codex-mini', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5-codex', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'gpt-5-nano', vendor: 'openai', contextWindow: 400000, outputWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: true},
        // chat 档（厂商公开口径，端点未列）：不带推理
        {id: 'gpt-5.3-chat', vendor: 'openai', contextWindow: 128000, modalities: {text: true, image: true}, reasoningEffort: false},
        {id: 'gpt-5.2-chat-latest', vendor: 'openai', contextWindow: 128000, outputWindow: 16384, modalities: {text: true, image: true}, reasoningEffort: false},

        // ================= Google Gemini（端点：3.x/4.x 全部 1048576 / 64K，全模态）=================
        {id: 'gemini-4-argon', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-4-carbon', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-4-hydrogen', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-3.8-flash', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-3.7-flash', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-3.6-flash', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-3.5-flash', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'gemini-3.5-flash-lite', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        // 以下取厂商公开口径（端点未列）
        {id: 'gemini-3.1-pro-preview', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}},
        {id: 'gemini-2.5-pro', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}},
        {id: 'gemini-2.5-flash', vendor: 'google', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true, audio: true}},

        // ================= 通义千问（端点：qwen3.8-max/3.6/3.5-plus 262K；3.8-flash 1M）=================
        // 思考开关是 enable_thinking，不是 reasoning_effort，所以推理强度这行对它们是隐藏的
        {id: 'qwen4-max-preview', aliases: ['qwen4-max'], vendor: 'qwen', contextWindow: 1048576, outputWindow: 393216, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.8-flash', vendor: 'qwen', contextWindow: 1000000, outputWindow: 131072, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.8-max', vendor: 'qwen', contextWindow: 262144, outputWindow: 131072, modalities: {text: true, image: true}, reasoningEffort: false},
        {id: 'qwen3.7-plus', vendor: 'qwen', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.7-max', vendor: 'qwen', contextWindow: 1048576, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.7-flash', vendor: 'qwen', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.6-plus', vendor: 'qwen', contextWindow: 262144, outputWindow: 65536, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.6-flash', vendor: 'qwen', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.5-plus', vendor: 'qwen', contextWindow: 262144, outputWindow: 65536, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3.5-flash', vendor: 'qwen', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen3-coder-flash', vendor: 'qwen', contextWindow: 1048576, modalities: {text: true}, reasoningEffort: false},
        // 滚动别名：始终指向当期版本，输出上限文档没给就不写
        {id: 'qwen-plus', vendor: 'qwen', contextWindow: 1048576, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        {id: 'qwen-flash', vendor: 'qwen', contextWindow: 1048576, modalities: {text: true, image: true, video: true}, reasoningEffort: false},
        // qwen-max 还停在 32K，且不支持思考
        {id: 'qwen-max', vendor: 'qwen', contextWindow: 32768, modalities: {text: true}, reasoningEffort: false},

        // ================= 智谱 GLM（端点：5.2/5.3/5.3-flash 1M/128K；5/5.1 200K/128K）=================
        {id: 'glm-5.3', aliases: ['glm-latest'], vendor: 'glm', contextWindow: 1000000, outputWindow: 131072, modalities: {text: true}, reasoningEffort: true},
        {id: 'glm-5.2', vendor: 'glm', contextWindow: 1000000, outputWindow: 131072, modalities: {text: true}, reasoningEffort: true},
        {id: 'glm-5.1', vendor: 'glm', contextWindow: 204800, outputWindow: 131072, modalities: {text: true}, thinking: true},
        {id: 'glm-5', vendor: 'glm', contextWindow: 204800, outputWindow: 131072, modalities: {text: true}, thinking: true},
        // flash 版是原生多模态，收图 + 视频
        {id: 'glm-5.3-flash', vendor: 'glm', contextWindow: 1000000, outputWindow: 131072, modalities: {text: true, image: true, video: true}, reasoningEffort: true},
        {id: 'glm-5.3-flash-free', vendor: 'glm', contextWindow: 200000, outputWindow: 32000, modalities: {text: true, image: true, video: true}, reasoningEffort: true},

        // ================= Kimi（端点：K3 1M/1M；K2.x 262K；全系收图 + 视频）=================
        {id: 'kimi-k3', vendor: 'kimi', contextWindow: 1048576, outputWindow: 1048576, modalities: {text: true, image: true, video: true}, reasoningEffort: true},
        {id: 'kimi-k2.7-code', vendor: 'kimi', contextWindow: 262144, outputWindow: 262144, modalities: {text: true, image: true, video: true}},
        {id: 'kimi-k2.6', vendor: 'kimi', contextWindow: 262144, outputWindow: 65536, modalities: {text: true, image: true, video: true}},
        {id: 'kimi-k2.5', vendor: 'kimi', contextWindow: 262144, outputWindow: 65536, modalities: {text: true, image: true, video: true}},
        // 以下取厂商公开口径（端点未列）
        {id: 'kimi-k3.1-pro', vendor: 'kimi', contextWindow: 1048576, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'kimi-k3.1-pro-highspeed', vendor: 'kimi', contextWindow: 1048576, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'kimi-k2.8-preview', vendor: 'kimi', contextWindow: 1048576, outputWindow: 1048576, modalities: {text: true, image: true}},

        // ================= MiniMax（官网 https://www.minimax.io/models/text/m3：M3 最高 1M、保障最低 512K）=================
        {id: 'minimax-m3', aliases: ['MiniMax-M3'], vendor: 'minimax', contextWindow: 1048576, outputWindow: 128000, modalities: {text: true, image: true, video: true}},
        {id: 'minimax-m2.7', vendor: 'minimax', contextWindow: 204800, outputWindow: 131072, modalities: {text: true}},
        {id: 'minimax-m2.5', vendor: 'minimax', contextWindow: 204800, outputWindow: 131072, modalities: {text: true}},
        // M3.1-Flash：官网定价页 $0.15/$0.60，窗口官方未给明确值（OpenCode 端点亦无），只记 ID 走兜底
        {id: 'minimax-m3.1-flash', vendor: 'minimax', modalities: {text: true, image: true}},

        // ================= xAI Grok（端点：4.5/4.6/4.7 500K/500K；build-0.1 256K/256K）=================
        {id: 'grok-4.7', vendor: 'xai', contextWindow: 500000, outputWindow: 500000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'grok-4.6', vendor: 'xai', contextWindow: 500000, outputWindow: 500000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'grok-4.5', vendor: 'xai', contextWindow: 500000, outputWindow: 500000, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'grok-build-0.1', vendor: 'xai', contextWindow: 256000, outputWindow: 256000, modalities: {text: true, image: true}},

        // ================= Mistral（端点：Large 4 512K/256K 收图）=================
        {id: 'mistral-large-4', vendor: 'mistral', contextWindow: 524288, outputWindow: 262144, modalities: {text: true, image: true}, reasoningEffort: true},

        // ================= Meta Muse（端点：全系 1M/128K，收图+视频+音频）=================
        {id: 'muse-spark-1.3', vendor: 'meta', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'muse-spark-1.2', vendor: 'meta', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'muse-wonder-1.0', vendor: 'meta', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true, video: true, audio: true}, reasoningEffort: true},
        {id: 'muse-ember-1.0', vendor: 'meta', contextWindow: 1048576, outputWindow: 270000, modalities: {text: true, image: true, video: true}, reasoningEffort: true},

        // ================= NVIDIA Nemotron（端点：免费档）=================
        {id: 'nemotron-3.5-super-vl-free', vendor: 'nvidia', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'nemotron-3.5-lightning-free', vendor: 'nvidia', contextWindow: 262144, outputWindow: 262144, modalities: {text: true}},

        // ================= OpenCode 免费档（端点实测，窗口普遍低于付费正主）=================
        {id: 'beam-free', vendor: 'reflection', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true}, reasoningEffort: true},
        {id: 'longcat-2.5-free', vendor: 'meituan', contextWindow: 1000000, outputWindow: 262144, modalities: {text: true, image: true}},
        // LongCat-2.0：美团技术博客 https://tech.meituan.com/2026/06/30/LongCat2.0.html 明确「原生支持 1M 超长上下文」；最大输出官方未给，只记上下文
        {id: 'longcat-2.0', vendor: 'meituan', contextWindow: 1048576, modalities: {text: true, image: true}},
        {id: 'inkling-2-small-free', vendor: 'thinkingmachines', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true}, reasoningEffort: true},
        {id: 'mimo-v2.6-flash-free', vendor: 'xiaomi', contextWindow: 200000, outputWindow: 32000, modalities: {text: true, image: true, video: true, audio: true}},
        {id: 'hy4-flash-free', vendor: 'hunyuan', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true}},
        {id: 'iceman-free', vendor: 'opencode', contextWindow: 262144, outputWindow: 131072, modalities: {text: true}},
        {id: 'flint-40b-free', vendor: 'recursive', contextWindow: 262144, outputWindow: 65536, modalities: {text: true}, reasoningEffort: true},
        {id: 'big-pickle', vendor: 'opencode', contextWindow: 200000, outputWindow: 32000, modalities: {text: true}, reasoningEffort: true},

        // ================= 字节豆包（火山方舟）=================
        {id: 'doubao-seed-evolving', aliases: ['doubao-seed-evolving-latest'], vendor: 'doubao', contextWindow: 1048576, outputWindow: 262144, modalities: {text: true, image: true}},
        {id: 'doubao-seed-2-1-pro-260915', aliases: ['doubao-seed-2.1-pro'], vendor: 'doubao', contextWindow: 1048576, outputWindow: 262144, modalities: {text: true, image: true}},
        {id: 'doubao-seed-2-1-lite-260915', aliases: ['doubao-seed-2.1-lite'], vendor: 'doubao', contextWindow: 1048576, outputWindow: 262144, modalities: {text: true, image: true}},
        {id: 'doubao-seed-2-1-turbo-260628', aliases: ['doubao-seed-2.1-turbo'], vendor: 'doubao', contextWindow: 262144, outputWindow: 262144, modalities: {text: true, image: true}},
        {id: 'doubao-seed-2-0-lite-260428LTS', aliases: ['doubao-seed-2.0-lite'], vendor: 'doubao', contextWindow: 262144, outputWindow: 131072, modalities: {text: true, image: true}},
        {id: 'doubao-seed-2-0-mini-260428LTS', aliases: ['doubao-seed-2.0-mini'], vendor: 'doubao', contextWindow: 262144, outputWindow: 131072, modalities: {text: true, image: true}},

        // ================= 腾讯混元（TokenHub：新模型改叫 Hy）=================
        {id: 'hy4', vendor: 'hunyuan', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true}},
        {id: 'hy4-preview', vendor: 'hunyuan', contextWindow: 1048576, outputWindow: 65536, modalities: {text: true, image: true}},
        {id: 'hy3', vendor: 'hunyuan', contextWindow: 262144, outputWindow: 131072, modalities: {text: true}},

        // ================= 其它（阶跃 / 小米 / 百度）=================
        {id: 'step-5-preview', vendor: 'step', contextWindow: 1048576, modalities: {text: true}},
        {id: 'step-3.7-flash', vendor: 'step', contextWindow: 256000, outputWindow: 65536, modalities: {text: true, image: true}},
        {id: 'mimo-v2.6-pro-ultraspeed', vendor: 'xiaomi', contextWindow: 1048576, modalities: {text: true}},
        // 小米 MiMo Flash 付费版：官网 https://mimo.mi.com 1M 上下文 / 128K 输出，全模态
        {id: 'mimo-v2.6-flash', vendor: 'xiaomi', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true, video: true, audio: true}},
        // MiMo-V2.6-Pro 旗舰：官网 1M 上下文 / 128K 输出，全模态（V2.5/V2.5-Pro 已于 2026-10-21 下线，故不收录）
        {id: 'mimo-v2.6-pro', vendor: 'xiaomi', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true, video: true, audio: true}},
        // 文心：千帆未明确标注输出上限，只记上下文
        {id: 'ernie-4.5-turbo-128k', vendor: 'ernie', contextWindow: 131072, modalities: {text: true}},

        // ================= 商汤 SenseNova（日日新）=================
        // 窗口取官方文档 https://platform.sensenova.cn/docs ；未公开数值的型号留空走兜底 256K/64K。
        // 收录 6.0/5.5/5 等较早 ID（自部署 / 私有化场景 model ID 仍有效）。
        {id: 'senseNova-6.8-flash', aliases: ['sensenova-6.8-flash', 'SenseNova-6.8-Flash'], vendor: 'sensenova', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true}},
        {id: 'senseNova-6.8-flash-lite', aliases: ['sensenova-6.8-flash-lite', 'SenseNova-6.8-Flash-Lite'], vendor: 'sensenova', contextWindow: 262144, outputWindow: 65536, modalities: {text: true, image: true}},
        {id: 'senseNova-6.5', aliases: ['sensenova-6.5', 'SenseNova-6.5'], vendor: 'sensenova', modalities: {text: true, image: true}},
        {id: 'senseNova-6.0', aliases: ['sensenova-6.0', 'SenseNova-6.0'], vendor: 'sensenova', modalities: {text: true, image: true}},
        {id: 'senseNova-5.5', aliases: ['sensenova-5.5', 'SenseNova-5.5'], vendor: 'sensenova', modalities: {text: true, image: true}},
        {id: 'senseNova-5', aliases: ['sensenova-5', 'SenseNova-5'], vendor: 'sensenova', modalities: {text: true, image: true}},

        // ================= 智谱 GLM 历史模型（官网 https://docs.bigmodel.cn 模型概览）=================
        // 自部署 / 老配置仍可能用到，按官网口径收录
        {id: 'glm-4.6', vendor: 'glm', contextWindow: 200000, outputWindow: 131072, modalities: {text: true}},
        {id: 'glm-4.5', vendor: 'glm', contextWindow: 128000, outputWindow: 98304, modalities: {text: true}},
        {id: 'glm-4.5-air', vendor: 'glm', contextWindow: 128000, outputWindow: 98304, modalities: {text: true}},
        {id: 'glm-4.5-flash', vendor: 'glm', contextWindow: 128000, outputWindow: 98304, modalities: {text: true}},
        {id: 'glm-4.7', vendor: 'glm', contextWindow: 200000, outputWindow: 131072, modalities: {text: true}},
        {id: 'glm-4.7-flash', vendor: 'glm', contextWindow: 200000, outputWindow: 131072, modalities: {text: true}},
        {id: 'glm-4-long', vendor: 'glm', contextWindow: 1000000, outputWindow: 4096, modalities: {text: true}},

        // ================= 小米 MiMo（已下线，自部署仍可用）=================
        // V2.5 / V2.5-Pro 已于 2026-10-21 下线（https://mimo.mi.com 公告），云 API 失效；
        // 按用户要求收录以覆盖自部署场景，窗口留空走兜底。
        {id: 'mimo-v2.5', vendor: 'xiaomi', modalities: {text: true, image: true}},
        {id: 'mimo-v2.5-pro', vendor: 'xiaomi', modalities: {text: true, image: true}},
    ],
};

function boolOrUndefined(value) {
    if (value === true || value === false) return value;
    return undefined;
}

function positiveInt(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// 单条归一：id 必填，其余字段缺省即不写（表示「不知道」）；
// 窗口越界按 maxTokens 的量级 clamp，避免远端表写出 0 或天文数字把请求带崩。
export function normalizeCatalogEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const entry = {id};
    const vendor = String(raw.vendor || '').trim();
    if (vendor) entry.vendor = vendor;
    const label = String(raw.label || '').trim();
    if (label) entry.label = label;
    if (Array.isArray(raw.aliases)) {
        const aliases = raw.aliases.map((item) => String(item || '').trim()).filter(Boolean);
        if (aliases.length) entry.aliases = aliases;
    }
    const contextWindow = positiveInt(raw.contextWindow);
    if (contextWindow) entry.contextWindow = Math.min(CONTEXT_WINDOW_MAX, Math.max(CONTEXT_WINDOW_MIN, contextWindow));
    const outputWindow = positiveInt(raw.outputWindow);
    if (outputWindow) entry.outputWindow = Math.min(OUTPUT_WINDOW_MAX, Math.max(OUTPUT_WINDOW_MIN, outputWindow));
    if (raw.modalities && typeof raw.modalities === 'object') {
        const modalities = {};
        for (const key of MODALITY_KEYS) {
            const value = boolOrUndefined(raw.modalities[key]);
            if (value !== undefined) modalities[key] = value;
        }
        if (Object.keys(modalities).length) entry.modalities = modalities;
    }
    // 推理 / 思考支持是三态：true 显示、false 隐藏、缺省则沿用按 protocol 的旧规则
    const reasoningEffort = boolOrUndefined(raw.reasoningEffort);
    if (reasoningEffort !== undefined) entry.reasoningEffort = reasoningEffort;
    const thinking = boolOrUndefined(raw.thinking);
    if (thinking !== undefined) entry.thinking = thinking;
    // 思考预算是否被接受：Opus 4.6 起只接受自适应思考，传 budget_tokens 会 400
    const thinkingBudget = boolOrUndefined(raw.thinkingBudget);
    if (thinkingBudget !== undefined) entry.thinkingBudget = thinkingBudget;
    return entry;
}

// 整份归一：{version, source, models[]}；结构不合法返回 null（调用方据此整份丢弃）。
export function normalizeCatalog(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.models) ? raw.models : null;
    if (!list) return null;
    const seen = new Set();
    const models = [];
    for (const item of list) {
        const entry = normalizeCatalogEntry(item);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        models.push(entry);
    }
    if (!models.length) return null;
    return {
        version: String(raw.version || '').trim() || '未标注',
        source: String(raw.source || '').trim() || '',
        models,
    };
}

// 模型 ID 归一：小写、去 vendor/ 前缀、去 :free / :beta 这类路由后缀、
// 去 -latest 与日期尾巴（-2024-08-06 / -20240806）。刻意不模糊匹配——
// gpt-4 命中 gpt-4o 就填错窗口了，漏填永远比错填安全。
export function normalizeModelId(raw) {
    let id = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!id) return '';
    const slash = id.lastIndexOf('/');
    if (slash >= 0) id = id.slice(slash + 1);
    id = id.replace(/:[a-z0-9.+-]+$/, '');
    id = id.replace(/-latest$/, '');
    id = id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
    return id;
}

// 精确 id → 别名 → 归一化后精确。索引按 catalog 对象缓存，避免每次按键都重建。
const indexCache = new WeakMap();

export function catalogIndex(catalog) {
    const cached = indexCache.get(catalog);
    if (cached) return cached;
    const byId = new Map();
    for (const entry of (catalog && catalog.models) || []) {
        if (!entry || !entry.id) continue;
        byId.set(entry.id.toLowerCase(), entry);
        for (const alias of entry.aliases || []) byId.set(String(alias).toLowerCase(), entry);
    }
    const index = {byId, byNormalized: new Map()};
    for (const [key, entry] of byId) {
        const normalized = normalizeModelId(key);
        if (normalized && !index.byNormalized.has(normalized)) index.byNormalized.set(normalized, entry);
    }
    indexCache.set(catalog, index);
    return index;
}

export function matchCatalogModel(catalog, modelId) {
    const raw = String(modelId == null ? '' : modelId).trim();
    if (!catalog || !raw) return null;
    const index = catalogIndex(catalog);
    const lower = raw.toLowerCase();
    if (index.byId.has(lower)) return index.byId.get(lower);
    const normalized = normalizeModelId(raw);
    if (normalized && index.byNormalized.has(normalized)) return index.byNormalized.get(normalized);
    return null;
}

// 远端覆盖内置：同 ID 以远端为准（远端是更新的口径），内置独有条目保留在原位。
export function mergeCatalogs(builtin, remote) {
    const base = builtin && Array.isArray(builtin.models) ? builtin.models : [];
    const overlay = remote && Array.isArray(remote.models) ? remote.models : [];
    if (!overlay.length) return builtin;
    const overlayById = new Map(overlay.map((entry) => [entry.id, entry]));
    const merged = [];
    const used = new Set();
    for (const entry of base) {
        const next = overlayById.get(entry.id);
        if (next) {
            merged.push({...entry, ...next});
            used.add(entry.id);
        } else {
            merged.push(entry);
        }
    }
    for (const entry of overlay) {
        if (!used.has(entry.id)) merged.push(entry);
    }
    return {
        version: (remote && remote.version) || (builtin && builtin.version) || '未标注',
        source: (remote && remote.source) || (builtin && builtin.source) || '',
        models: merged,
    };
}

// 把表里的字段写进条目；返回是否真的改动了。
// 只写「值」类字段——推理 / 思考的「支持与否」不进条目，渲染时按表判定，
// 这样表更新后旧的条目也能立刻拿到新判断。
export function applyCatalogFields(entry, hit) {
    if (!entry || !hit) return false;
    let changed = false;
    if (hit.contextWindow && entry.contextWindow !== hit.contextWindow) {
        entry.contextWindow = hit.contextWindow;
        changed = true;
    }
    if (hit.outputWindow && entry.outputWindow !== hit.outputWindow) {
        entry.outputWindow = hit.outputWindow;
        changed = true;
    }
    if (hit.modalities) {
        if (!entry.modalities) entry.modalities = {};
        for (const key of MODALITY_KEYS) {
            const value = hit.modalities[key];
            if (value === undefined || entry.modalities[key] === value) continue;
            entry.modalities[key] = value;
            changed = true;
        }
    }
    return changed;
}

// 是否允许自动填充：新建条目在创建时显式打上 autoFilled=true；
// 存量条目没有这个字段（默认 false）一律当手填，避免升级后被表悄悄改掉窗口。
// 用户手改过任一被回填字段也会置回 false。
export function canAutoFill(entry) {
    return !!entry && entry.autoFilled === true;
}

// 一次「按表回填」的完整动作：命中才填，填完打上 autoFilled 标记。
export function fillEntryFromCatalog(catalog, entry, modelId) {
    const hit = matchCatalogModel(catalog, modelId != null ? modelId : (entry && entry.model));
    if (!hit || !entry) return {hit: null, changed: false};
    const changed = applyCatalogFields(entry, hit);
    if (changed) entry.autoFilled = true;
    return {hit, changed};
}

// 支持性判定：表里明确写了就听表的，没写就返回 undefined（调用方沿用旧规则）。
export function catalogSupport(catalog, modelId, field) {
    const hit = matchCatalogModel(catalog, modelId);
    if (!hit) return undefined;
    const value = hit[field];
    return value === true || value === false ? value : undefined;
}

// ---------- 运行时 store：内置 + 远端缓存合并，负责同步与过期判断 ----------

// 后端契约（见 ai_catalog.go）：
//   AIModelCatalogCached() → {text, fetchedAt}（无缓存时 text 为空）
//   AIModelCatalogSync(url) → {text, fetchedAt}（失败抛错）
export function createModelCatalogStore(deps) {
    const backend = deps.backend || {};
    const getSettings = typeof deps.getSettings === 'function' ? deps.getSettings : () => ({});
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    let remote = null;      // 归一化后的远端表
    let fetchedAt = 0;      // 远端表的落盘时间（毫秒）
    let loaded = false;
    let autoTried = false;  // 自动同步每次启动只尝试一次，失败也不反复打网络
    let syncing = null;
    let mergedCache = null; // 合并结果缓存：match/support 每次按键都会调，别每次重建数组
    let source = 'gitee';   // 数据源（gitee/github），随「设置 → 插件 → 数据源」刷新

    async function refreshSource() {
        if (typeof backend.GetDataSource !== 'function') return;
        try {
            source = (await backend.GetDataSource()) === 'github' ? 'github' : 'gitee';
        } catch (e) {
            source = 'gitee';
        }
    }

    function merged() {
        if (mergedCache) return mergedCache;
        mergedCache = remote ? mergeCatalogs(BUILTIN_CATALOG, remote) : BUILTIN_CATALOG;
        return mergedCache;
    }

    function url() {
        const custom = String(getSettings().aiCatalogURL || '').trim();
        if (/^https?:\/\//i.test(custom)) return custom;
        return source === 'github' ? CATALOG_URL_GITHUB : CATALOG_URL_DEFAULT;
    }

    function autoSyncOn() {
        return getSettings().aiCatalogAutoSync !== false;
    }

    function stale() {
        return !fetchedAt || now() - fetchedAt > CATALOG_STALE_MS;
    }

    function adopt(text, at) {
        if (!text) return false;
        const parsed = parseJson(text, null);
        const normalized = normalizeCatalog(parsed);
        if (!normalized) return false;
        remote = normalized;
        mergedCache = null;
        fetchedAt = Number(at) > 0 ? Number(at) * (Number(at) < 1e12 ? 1000 : 1) : now();
        return true;
    }

    // 启动时读一次磁盘缓存；失败静默（远端表只是增益，读不到就用内置）。
    async function load() {
        if (loaded) return merged();
        loaded = true;
        await refreshSource();
        if (typeof backend.AIModelCatalogCached !== 'function') return merged();
        try {
            const cached = await backend.AIModelCatalogCached();
            if (cached && cached.text) adopt(cached.text, cached.fetchedAt);
        } catch (e) {}
        return merged();
    }

    // 同步：同一时刻只允许一个在飞；silent 时不抛错、只返回结果，供启动静默调用。
    async function sync(options) {
        const silent = !!(options && options.silent);
        if (syncing) return syncing;
        if (typeof backend.AIModelCatalogSync !== 'function') {
            return {ok: false, error: '当前版本不支持同步'};
        }
        syncing = (async () => {
            try {
                await refreshSource();
                const result = await backend.AIModelCatalogSync(url());
                if (!result || !result.text) throw new Error('返回内容为空');
                if (!adopt(result.text, result.fetchedAt)) throw new Error('返回内容不是合法的模型配置表');
                loaded = true;
                return {ok: true, version: remote.version, count: merged().models.length};
            } catch (e) {
                if (!silent) throw e;
                return {ok: false, error: (e && e.message) || String(e)};
            } finally {
                syncing = null;
            }
        })();
        return syncing;
    }

    // 启动钩子：只有开关打开且缓存过期才静默拉一次；同一进程内只尝试一次。
    async function autoSync() {
        await load();
        if (autoTried) return {ok: false, skipped: true};
        autoTried = true;
        if (!autoSyncOn() || !stale()) return {ok: false, skipped: true};
        return sync({silent: true});
    }

    function status() {
        return {
            url: url(),
            version: merged().version,
            count: merged().models.length,
            builtinCount: BUILTIN_CATALOG.models.length,
            remote: !!remote,
            fetchedAt,
            autoSync: autoSyncOn(),
        };
    }

    return {
        get: merged,
        status,
        load,
        sync,
        autoSync,
        defaultUrl: url,
        match: (modelId) => matchCatalogModel(merged(), modelId),
        support: (modelId, field) => catalogSupport(merged(), modelId, field),
        fill: (entry, modelId) => fillEntryFromCatalog(merged(), entry, modelId),
    };
}
