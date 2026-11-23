// AI 面板「始终折叠」模式的默认值判定（设置 aiAlwaysCollapse，默认关）。
//
// 只改「默认值」，不加新折叠层——turn-fold-redesign.md 两次回滚的红线是
// 「整轮外壳吞用户消息」与「已答提问卡紧凑态」，本模块不碰回合边界语义与
// pending 接管区。已答提问卡并入过程流后（2026-11-19）随过程一起开合、默认收起
// （作者裁定：宁可点开看问答，也不要长轮次一直铺开）。手动记忆（processFoldState /
// thinkFoldState）的语义照旧，这里只决定「没有手动记忆时」的默认开合。
//
// 抽成纯函数是因为它横跨 renderTurn / 两处思考块 / body 懒建四处，
// 任何一处漏改都表现为「开关点了没反应」或「点开折叠头看到空白」，只靠手测难发现。

/**
 * 轮级过程条的默认展开值。
 * 默认模式：流式中展开、结束后按「最终回答有无正文」决定；始终折叠模式恒收起。
 * @param {boolean} turnRunning 轮次是否进行中
 * @param {boolean} finalHasBody 最终回答是否有正文（流式/出错/停止都算）
 * @param {boolean} alwaysCollapse 是否开启始终折叠
 * @returns {boolean} 默认是否展开
 */
export function turnProcessDefaultExpanded(turnRunning, finalHasBody, alwaysCollapse) {
    if (alwaysCollapse) return false;
    return turnRunning ? true : !finalHasBody;
}

/**
 * 回答气泡内思考块的默认折叠值。
 * 默认模式：流式展开、expandThinking（过程区展开）展开，其余收起；始终折叠模式恒收起。
 * 手动记忆 storedThink 优先于本判定，留在调用处处理。
 * @param {boolean} streaming 是否流式
 * @param {boolean} expandThinking 调用方是否显式要求展开（过程折叠体展开时联动传 true）
 * @param {boolean} alwaysCollapse 是否开启始终折叠
 * @returns {boolean} 默认是否折叠
 */
export function answerThinkingDefaultCollapsed(streaming, expandThinking, alwaysCollapse) {
    // expandThinking 是「过程折叠体已展开、里面思考链跟着展开」的显式联动信号，
    // 优先于 alwaysCollapse——否则用户展开过程体后里面的思考链全是收起的，很割裂。
    if (expandThinking) return false;
    if (alwaysCollapse) return true;
    return !streaming;
}

/**
 * 过程折叠体内思考块的默认折叠值。
 * 默认模式恒展开；始终折叠模式恒收起。
 * 手动记忆（thinkFoldState）优先于本判定，留在调用处处理——与回答气泡内思考块同构：
 * 用户手动展开过的思考块，即便切始终折叠也不该被强制收起。
 * @param {boolean} alwaysCollapse 是否开启始终折叠
 * @returns {boolean} 默认是否折叠
 */
export function processThinkingDefaultCollapsed(alwaysCollapse) {
    return alwaysCollapse === true;
}

/**
 * 流式过程中是否要预建折叠体 body（R1 护栏）。
 * 折叠只是 CSS display:none；始终折叠模式下流式仍建 body，增量更新才找得到节点，
 * 用户中途点开折叠头也能看到「当前」内容而非空白或旧签名。
 * @param {boolean} expanded 当前是否展开
 * @param {boolean} turnRunning 轮次是否进行中
 * @param {boolean} alwaysCollapse 是否开启始终折叠
 * @returns {boolean} 是否调用 ensureBody
 */
export function shouldEnsureBody(expanded, turnRunning, alwaysCollapse) {
    return expanded || (alwaysCollapse === true && turnRunning === true);
}
