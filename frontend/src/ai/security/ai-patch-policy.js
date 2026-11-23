// 补丁的呈现策略（纯函数）：决定 propose_patch 是否弹审批卡，还是只产出 .patch 文件。
//
// 背景：完全权限档的语义是「别打断我」，但补丁本身是可分享/可转交的交付物，
// 用户也常需要它。两者兼顾的做法是——完全权限下默认只落盘一份 .patch 并给出路径，
// 不弹审批接管卡；用户明确说要「应用」/给出短肯定句，或模型显式 apply:true 时才弹卡。
// 其他档位一切照旧。
import {aiTextOf} from '../core/ai-constants.js';

// 用户明确要求「把补丁应用上去」的措辞（只有这些才值得在完全权限下打断用户）。
// 同意/批准用负向后顾排除「不同意/没批准」；误弹的方向无害（full 档多一张卡，点放弃即可），
// 漏弹才是有害方向——模型拿不到卡就只能让用户去补丁视图手动应用。
const PATCH_APPLY_REQUEST_RE = /(应用|apply|落地|打上|合入|改上去|用这个补丁|就用这个|直接打|就这么办|听你的|(?<![不没])同意|(?<![不没])批准|(?<![不没未])通过)/i;
// 短肯定句也算同意：用户常常在补丁生成**之前**就表过态（「可以」「好的」「同意」），
// 等补丁出来它就是最后一条用户消息。只做整句匹配（≤8 字），不做子串匹配——
// 「执行」「更好」这类词里碰巧含同意字不应触发。
const PATCH_CONSENT_RE = /^(可以(的|呀|啊)?|好的?|同意|确认|没问题|就这么办|就这么干|行[吧!！。]?|嗯+|当然(可以)?|批准|通过|ok(ay)?|yes|sure)[!！。～~\s]*$/i;

// lastUserTextOf 取最后一条用户消息的纯文本（兼容字符串与多段内容数组）。
export function lastUserTextOf(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'user') continue;
        const content = message.content;
        if (Array.isArray(content)) {
            return content
                .map((part) => (part && typeof part === 'object' ? aiTextOf(part.text) : aiTextOf(part)))
                .join(' ')
                .trim();
        }
        return aiTextOf(content).trim();
    }
    return '';
}

// patchAllowApply 是否在审批卡上提供「应用」按钮（= 是否弹卡）。
// - 模型显式 apply:false：只产出文件，永远不弹卡
// - 隔离工作区开启（worktreeActive）：无论档位都弹——隔离期间主根只读，propose_patch
//   是唯一能写主根的通道，必须全档过人工审阅（对齐 worktree_manage(export) 的回灌卡）
// - 模型显式 apply:true：强制弹卡——用户常在补丁生成**之前**就同意了（「可以」），
//   靠猜用户措辞不可靠，模型需要一个确定性的「这补丁要走审批卡」开关（2026-11-18 真机：
//   用户说可以、模型带 apply:true 重试，旧实现只认 false，卡怎么都不弹）
// - 非完全权限档：保持原行为（默认弹卡，用户当场决定）
// - 完全权限档缺省：只有用户最近一句明确要求「应用」或给出短肯定答复才弹，否则只产出文件
export function patchAllowApply(input, scope, lastUserText, worktreeActive) {
    if (input && input.apply === false) return false;
    if (worktreeActive) return true;
    if (input && input.apply === true) return true;
    if (scope !== 'full') return true;
    const text = String(lastUserText || '');
    if (PATCH_APPLY_REQUEST_RE.test(text)) return true;
    return text.length <= 8 && PATCH_CONSENT_RE.test(text);
}
