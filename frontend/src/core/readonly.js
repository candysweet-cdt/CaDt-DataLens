// @ts-check
// readonly.js：只读判定的单一来源。
//
// 四层只读来源，彼此独立、可叠加：
//   - settings.readOnlyMode：编辑器全局只读锁（设置页锁按钮），覆盖所有标签；
//   - doc.readOnlyLocked：标签页只读锁，只作用于该 doc，其它标签照常可编辑，可解锁；
//   - doc.readOnlyFixed：固定只读（审阅快照这类虚拟文档），不可解锁，也不随全局锁开关变化；
//   - doc.large / doc.binary：大文件与二进制天然不可编辑。
//
// 凡是「当前文档能不能编辑 / 保存 / 运行 / 自动保存」的判断都走这里，
// 不要再各处散写 deps.settings.readOnlyMode —— 那样会漏掉标签页锁。
// 文件树上的增删改（重命名 / 删除 / 剪贴板）只受全局锁约束，不走这个函数。

/**
 * 只读判定用到的文档字段子集（不需要完整的 doc 类型）。
 * @typedef {object} ReadOnlyDoc
 * @property {boolean} [readOnlyFixed] 固定只读（审阅快照），不可解锁
 * @property {boolean} [readOnlyLocked] 标签页只读锁，可解锁
 * @property {boolean} [large] 大文件
 * @property {boolean} [binary] 二进制
 */

/**
 * 只读判定用到的设置子集。
 * @typedef {object} ReadOnlySettings
 * @property {boolean} [readOnlyMode] 全局只读锁
 */

/**
 * 判定当前文档是否只读（综合四层只读来源）。
 * @param {ReadOnlyDoc|null} doc 文档对象，可含 readOnlyFixed / readOnlyLocked / large / binary 字段
 * @param {ReadOnlySettings|null} settings 应用设置，可含 readOnlyMode（全局只读锁）
 * @returns {boolean} true = 文档不可编辑/保存/运行/自动保存
 */
export function isDocReadOnly(doc, settings) {
    if (settings && settings.readOnlyMode) return true;
    if (!doc) return false;
    return !!(doc.readOnlyFixed || doc.readOnlyLocked || doc.large || doc.binary);
}

// 固定只读：连「解除」入口都不该出现，setDocReadOnly 也必须拒绝解锁。
/**
 * 判定标签是否被固定只读（不可解锁，如审阅快照）。
 * @param {ReadOnlyDoc|null} doc 文档对象
 * @returns {boolean} true = 连「解除」入口都不该出现
 */
export function isTabReadOnlyFixed(doc) {
    return !!(doc && doc.readOnlyFixed);
}

/**
 * 判定标签是否被锁（普通锁或固定锁），用于状态栏文案与标签角标。
 * 不含全局锁 / 大文件。
 * @param {ReadOnlyDoc|null} doc 文档对象
 * @returns {boolean} true = 标签显示锁角标
 */
export function isTabReadOnlyLocked(doc) {
    return !!(doc && (doc.readOnlyLocked || doc.readOnlyFixed));
}
