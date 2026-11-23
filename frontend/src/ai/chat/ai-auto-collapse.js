// AI 回合驱动「编辑区自动收起」的判定（副作用留给 main.js）。
//
// 为什么抽成纯函数：自动收起会改变布局，规则一旦叠上粘性位、脏文档、面板形态，
// 就只能靠手测。这里把「这一刻该收 / 该还 / 不动」收敛成一个可断言的判断，
// main.js 的 applyAutoCollapse 只负责把结论变成 DOM 动作。
//
// 语义要点（改动前先读这里）：
// - 回合**开始**才收货，回合**结束**只还原「自动收起的」。用户手动收起的编辑区，
//   AI 跑完不许顶开——反过来，AI 自动收起后用户手动展开，本次让位过程不再自动收。
// - 「有内容被打开」不在这里判定：那是 main.js 的 revealEditorForContent（任何内容
//   出现都解开收起态，因为收起不是固定锁）。本函数只管「回合驱动的开合」。
// - `isCurrent` 为 false（后台会话在跑）一律不动布局。
// - 只在 `dock`（停靠分屏）生效：`fullscreen` 已经覆盖内容区，再收起会留白；
//   `float` 是独立窗口，与本窗口布局无关。
// - 有未保存修改时不收：收起会把脏标记藏起来，用户会误以为已保存。

/**
 * @param {object} state
 * @param {boolean} state.enabled        设置开关 settings.aiAutoCollapseEditor
 * @param {boolean} state.isCurrent      这个回合是否属于用户正在查看的会话
 * @param {boolean} state.running        true = 回合开始，false = 回合结束
 * @param {string}  state.collapseReason 当前收起原因 '' | 'manual' | 'auto'
 * @param {boolean} state.suppressed     用户手动展开过的粘性位
 * @param {string}  state.mode           面板形态 'dock' | 'fullscreen'
 * @param {boolean} state.panelOpen      AI 面板是否已打开
 * @param {boolean} state.hasDirtyDoc    是否有未保存修改的文档
 * @returns {'' | 'collapse' | 'expand'}
 */
export function decideAutoCollapse(state) {
    const s = state || {};
    if (!s.enabled) return '';
    if (!s.isCurrent) return '';
    if (!s.running) return s.collapseReason === 'auto' ? 'expand' : '';
    if (s.collapseReason) return '';
    if (s.suppressed) return '';
    if (!s.panelOpen) return '';
    if (s.mode !== 'dock') return '';
    if (s.hasDirtyDoc) return '';
    return 'collapse';
}

// 「新标签页出现 → 取消收起」的判定（settings.editorExpandOnNewTab，默认开）。
// 收起只是把位置让给对话，不是固定锁：有新内容要显示就该让出来。
// 只在停靠分屏生效——全屏盖住内容区、悬浮是另一个窗口，展开都看不见。
export function shouldExpandEditorOnTab(state) {
    const s = state || {};
    if (s.enabled === false) return false;
    if (!s.collapsed) return false;
    return s.mode === 'dock';
}
