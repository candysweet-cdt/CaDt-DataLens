// ai-path-hints.js：read_file 读不到文件时的「同名文件在哪」提示（纯组装，IO 经 deps 注入）。
// 背景：模型最常把 test/ 镜像位的测试猜成 src/（或被过期文档带偏），原来只能拿到
// Go 的原始英文报错，得再花一轮 glob 找回真路径。现在一轮就能拿到可行动的替代路径。
// 只对「真不存在」给建议：目录 / 过大 / 二进制等错误不属于「路径猜错」，照常抛出。

// Windows：The system cannot find the file specified.；Go：no such file or directory；
// 我们自己的包装文案里出现「找不到 / 不存在」。其余（过大 / 二进制 / 目录）不匹配。
export const NOT_FOUND_RE = /cannot find|no such file|找不到|不存在|does not exist/i;

export function splitBasename(p) {
    return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

/**
 * @param {Error|string|null} err readTextFile 抛出的错误
 * @param {string} inputPath 模型给的原始路径（展示用，走脱敏）
 * @param {string} absPath 已解析的绝对路径（取 basename 用）
 * @param {object} deps IO 注入：findFiles(root, pattern, max) / resolveRoot() / redact(text, session) / session
 * @returns {Promise<string|null>} 提示文本；拿不到可靠信息时返回 null（调用方回退原始错误）
 */
export async function missingFileHint(err, inputPath, absPath, deps) {
    const message = String((err && err.message) || err || '');
    if (!NOT_FOUND_RE.test(message)) return null;
    const base = splitBasename(absPath);
    if (!base || typeof deps.findFiles !== 'function') return null;
    const root = await deps.resolveRoot();
    if (!root) return null;
    let matches = [];
    try {
        const result = await deps.findFiles(root, '**/' + base, 20);
        matches = ((result && result.files) || [])
            .map((file) => String(file.path || ''))
            .filter((p) => p === base || p.endsWith('/' + base))
            .slice(0, 5);
    } catch (e) {
        return null; // 扫描失败就退回原始错误，别拿猜测掩盖真实原因
    }
    const shown = deps.redact ? deps.redact(inputPath || absPath, deps.session) : (inputPath || absPath);
    if (!matches.length) {
        return '文件不存在：' + shown + '（范围根下也没有同名文件）。' +
            '可用 glob 按文件名关键词找相近路径，或确认文件名拼写。';
    }
    return '文件不存在：' + shown + '\n同名文件在以下位置（路径相对范围根，可直接用它们重试 read_file）：\n' +
        matches.map((p) => '- ' + p).join('\n');
}
