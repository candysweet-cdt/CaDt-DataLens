// @ts-check
// path-key.js：文件系统路径的归一化与比较——**唯一实现**。
//
// ── 为什么需要这个模块 ────────────────────────────────────────────────────
// 普查（2026-11-26）结果：路径归一这一件事在全仓有 **19 处完整三段式**
// （`replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()`）、45 处「转斜杠 + 去尾斜杠」、
// 112 处单独的「转斜杠」，另有 8 处各写一遍的「完整目录段包含」判定
// （`key === root || key.startsWith(root + '/')`）。
//
// 危险的不是重复本身，是**边界判定重复**：`startsWith(root + '/')` 少写那个 `/`，
// 就会把 `D:/a/bc` 当成 `D:/a/b` 的子路径 —— 这类 bug 不会报错，只会在某个
// 目录名恰好多两个字符时静默出错。
//
// ── 设计：一个原语 + 两个 preset + 三个谓词（不是万能函数）───────────────
// 普查确认存在**同形不同义**的情况，合并会改变行为，所以刻意分成几个入口，
// 每个都写明「为什么不能和隔壁合并」：
//
//   legacyPathKey   —— 现存 19 处三段式的精确等价（不解析 . 与 ..）
//   fsPathEquals    —— 路径相等（同上口径）
//   fsPathContains  —— 完整目录段包含（含边界，防 /a/b 误伤 /a/bc）
//   relativeToFsRoot—— 求相对路径，**返回原大小写**（用于展示 / 传给后端）
//
// 不在本模块内的（各有理由，见 docs/core-capabilities.md 的豁免清单）：
//   · ai/session/ai-session-scope.js 的 normalizePath / workspaceKey —— 要解析 `.`/`..`
//     且要保留 scheme/盘符，其输出是 Go 侧 WorkspaceBucketKey 的 sha256 输入，
//     改一个字符就换磁盘分桶（有跨语言测试锁死）。
//   · ai/security/ai-wipeguard.js 的 normalizeWsKey —— UNC `//` 与 scheme 口径不同，
//     是 wipeguard per-root 状态表的 key，合并会让 watcher 归属漂移。
//   · ai/tools/ai-file-tools.js 的 normalizeLocalFilePath / resolveWithinRoot ——
//     安全边界，越界必须**拒绝**而不是静默归一（`..` 语义相反）。
//   · core/jsonpath.js / core/jsonschema.js / core/diff.js 的 pathKey ——
//     JSONPath 段转义（`['a\\b']`），与文件系统毫无关系，只是名字像。

/**
 * 反斜杠转正斜杠并去首尾空白。只做这一件事——不做大小写、不去尾斜杠。
 * 「原样保留大小写」的场合（展示、传后端）用这个。
 * @param {*} value
 * @returns {string}
 */
export function toPosixPath(value) {
    return String(value == null ? '' : value).trim().replace(/\\/g, '/');
}

/**
 * 去掉尾部的一个或多个分隔符（`/` 或 `\`）。根路径 `/` 去掉后为空串，
 * 这是可接受的——调用方用 key 比较，空串不会与任何真实路径相等。
 * @param {*} value
 * @returns {string}
 */
export function stripTrailingSlashes(value) {
    return String(value == null ? '' : value).replace(/[\\/]+$/, '');
}

/**
 * 历史三段式的精确等价：转斜杠 + 去尾斜杠 + 转小写。
 *
 * **不解析** `.` 与 `..`（与现存 19 处逐字一致）。要解析点段请用
 * ai/session/ai-session-scope.js 的 normalizePath——那个还要保留 scheme/盘符。
 * @param {*} value
 * @returns {string}
 */
export function legacyPathKey(value) {
    return toPosixPath(value).replace(/\/+$/, '').toLowerCase();
}

/**
 * 两个路径是否指向同一个位置（按 legacyPathKey 口径）。
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function fsPathEquals(a, b) {
    return legacyPathKey(a) === legacyPathKey(b);
}

/**
 * path 是否位于 root 之下（**含 root 自身**）。
 *
 * 边界必须带分隔符：`fsPathContains('D:/a/b', 'D:/a/bc') === false`。
 * 这是全仓 8 处手写实现的统一替代——漏写那个 `/` 就是这类 bug 的唯一来源。
 * @param {*} root
 * @param {*} path
 * @returns {boolean}
 */
export function fsPathContains(root, path) {
    const r = legacyPathKey(root);
    if (!r) return false;
    const p = legacyPathKey(path);
    if (!p) return false;
    return p === r || p.startsWith(r + '/');
}

/**
 * 把 path 表示成相对 root 的路径（root 不是前缀时返回空串）。
 *
 * **返回原大小写**：结果可能用于展示或传给 Go 后端，转小写会改变行为。
 * 比较用归一化 key，切片用原串长度。
 * @param {*} root
 * @param {*} path
 * @returns {string}
 */
export function relativeToFsRoot(root, path) {
    const rootKey = legacyPathKey(root);
    if (!rootKey) return '';
    const posix = toPosixPath(path).replace(/\/+$/, '');
    const key = posix.toLowerCase();
    if (key === rootKey) return '';
    if (!key.startsWith(rootKey + '/')) return '';
    return posix.slice(rootKey.length + 1);
}
