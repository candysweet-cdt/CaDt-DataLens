// ai-mascot-phrases.js：流式状态条看板娘文案池与轮换索引的纯逻辑层。
// 无 DOM、无副作用，便于单测直接断言；ai-panel.js 是唯一调用方。
//
// 设计要点（2026-11-16）：
// - 每 8 秒顺序换下一条，不再写死 30 秒——短对话也能看到多条。
// - 一轮流式开场时随机定起始偏移，每次开场第一条都不同。
// - 阶段切换只换文案池，不重置时间基准与偏移：索引随全局 tick 连续漂移，不回第 0 条。

export const AI_MASCOT_PHRASE_ROTATE_MS = 8000;

// 按工作阶段分组；各组首句互不相同，「甜澄漫游中」只在 wait 出现，
// 避免跨组重复造成「翻来覆去就那几句」的观感。
export const AI_MASCOT_PHRASES = {
    think: ['甜澄翻着思路小本本', '甜澄在字里行间找线索', '甜澄把灵感串成串', '甜澄摊开脑内小地图', '甜澄把想法摆上工作台', '甜澄在脑内搭脚手架'],
    talk: ['甜澄一路小写着答案', '甜澄认真敲字中', '甜澄把话说给文件听', '甜澄把答案码得齐齐的', '甜澄一行行写下答案', '甜澄把光标当笔使'],
    tool: ['甜澄在翻文件抽屉', '甜澄踮脚够代码', '甜澄在工位上小跑', '甜澄帮忙搭着积木', '甜澄在代码丛林里探路', '甜澄把报错捡起来研究'],
    approval: ['甜澄等你点头', '甜澄捧着方案候场', '甜澄在门口举手报到', '甜澄把茶续上了等你', '甜澄举着方案等你过目', '甜澄把笔递到你手里'],
    ask: ['甜澄托着下巴等你回话', '甜澄举着小黑板提问', '甜澄把问题递到你面前', '甜澄歪头等你拿主意', '甜澄把话筒递到你嘴边', '甜澄转着笔等你的答案'],
    env: ['甜澄把新钥匙递给你', '甜澄在登记簿前等你填写', '甜澄把空表格摆上桌', '甜澄等你写下秘密', '甜澄帮你把表格摊平', '甜澄握着印章等你落笔'],
    wait: ['甜澄漫游中', '甜澄在数据溪边散步', '甜澄踮脚看云朵飘过', '甜澄哼着小曲巡山', '甜澄在云朵上打盹', '甜澄数着数据流过的涟漪'],
};

export const MASCOT_PHRASE_PHASES = Object.keys(AI_MASCOT_PHRASES);

export function phrasesForPhase(phase) {
    return AI_MASCOT_PHRASES[phase] || AI_MASCOT_PHRASES.wait;
}

// 开场随机偏移：0..len-1；random 可注入，便于确定性测试。
export function randomMascotSalt(len, random = Math.random) {
    if (!(len > 0)) return 0;
    const r = Number(random());
    if (!Number.isFinite(r)) return 0;
    return Math.min(len - 1, Math.max(0, Math.floor(r * len)));
}

// 轮换索引：elapsedMs 为距该轮流式全局基准的毫秒数（阶段切换不清零），
// salt 为开场偏移。tick 单调递增，故阶段切换后索引继续往前走而不是回到 0。
export function mascotPhraseIndex(elapsedMs, salt, len) {
    if (!(len > 0)) return 0;
    const safeLen = Math.floor(len);
    const rawSalt = Number(salt);
    const start = Number.isFinite(rawSalt) ? ((Math.trunc(rawSalt) % safeLen) + safeLen) % safeLen : 0;
    const elapsed = Number(elapsedMs);
    const tick = Math.floor((Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0) / AI_MASCOT_PHRASE_ROTATE_MS);
    return (start + tick) % safeLen;
}
