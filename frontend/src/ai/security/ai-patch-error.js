// 补丁失败码还原（纯函数）。
//
// Go 侧 PatchSave 抛的 error 是 "PATCH_XXX: 说明（细节）"（patchError.Error()），
// 前端此前把 catch 到的一切都改写成 PATCH_PARSE + retryable=yes，导致
// PATCH_EMPTY / PATCH_PATH_DENIED 这类确定性失败被当成可重试错误，
// 模型会照着"重试"再提交一遍（实测：空补丁连报两次、越界路径同样报空补丁文案）。
const PATCH_NON_RETRYABLE = new Set([
    'PATCH_EMPTY',
    'PATCH_PARSE',
    'PATCH_LIMIT',
    'PATCH_PATH_DENIED',
    'PATCH_UNSUPPORTED',
    'PATCH_NO_BACKUP',
    'PATCH_BACKEND',
    'PATCH_NOT_REQUESTED',
]);

// patchErrorParts 把后端错误文本拆成 {code, text, retryable}。
// 认不出前缀时按 PATCH_PARSE 处理，并把原文原样带回（解析失败通常值得按建议修一次）。
export function patchErrorParts(message) {
    const raw = String(message == null ? '' : message).trim();
    const matched = raw.match(/^(PATCH_[A-Z_]+)\s*:\s*([\s\S]*)$/);
    if (!matched) {
        return {code: 'PATCH_PARSE', text: raw || '补丁处理失败', retryable: true, matched: false};
    }
    return {
        code: matched[1],
        text: matched[2].trim() || raw,
        retryable: !PATCH_NON_RETRYABLE.has(matched[1]),
        matched: true,
    };
}
