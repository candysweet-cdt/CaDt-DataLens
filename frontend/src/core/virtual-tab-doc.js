// @ts-check
// virtual-tab-doc.js：虚拟标签页（path === null）的 doc 字面量工厂。
//
// 背景：7 个域的 openXxxTab 各自手写了一份几乎逐字相同的 ~14 字段公共块，
// 只有 id / name / format / mode / 标记位 / 域私有字段不同。字段集散成 7 份，
// 加字段要改 7 处，漏改一处只有运行时才暴露（这类 doc 不进 createDoc 的校验）。
//
// 本模块只负责「无路径 doc 的公共字段」，**不接管** id 生成策略与视图挂载：
//   · id 里带身份键（`bgterm-<jobId>` / `agentview-<subId>`），去重依赖它，
//     由各域自己生成后传入
//   · 视图挂载在 createDocEditor / 各域 createXxxView，与本模块无关
//
// 放 core/ 的理由同 tab-kinds.js：bridge/ 与 editor/ 互相不 import，但都要造这类 doc。

/**
 * @param {object} data
 * @param {string|number} data.id 调用方生成的文档 id（带身份键，用于去重）
 * @param {string} data.name 标签页名
 * @param {object} data.format 格式描述（`{id, name, extensions, aceMode, rawOnly}`）
 * @param {string} data.mode 视图模式名（`'browser'` / `'bgterm'` …）
 * @param {string} [data.marker] 标记位名（`'browser'` / `'bgTerm'` …），与 data.key 成对
 * @param {*} [data.key] 标记位取值（`true` / jobId / sessionId / 复合键）
 * @param {object} [data.extra] 域私有字段（browserUrl / agentViewSpec / bgTermCommand …）
 */
export function createVirtualTabDoc(data) {
    /** @type {Record<string, any>} */
    const doc = {
        id: data.id,
        path: null,
        name: data.name,
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: data.format,
        mode: data.mode,
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    // marker 与 key 必须成对传：只传 key 会得到一个永远命中不了的「孤儿」标记值，
    // 只传 marker 会让去重判断（docs.find(d => d.X === key)）恒假 → 每次点开都新建一个。
    if (data.marker != null) doc[data.marker] = data.key;
    if (data.extra) Object.assign(doc, data.extra);
    return doc;
}
