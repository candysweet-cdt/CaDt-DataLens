// ai-agent-tree.js：智能体团队弹层的嵌套树构建（纯函数，无 DOM）。
// 父子靠 parentSessionId ↔ 子代理会话 id（HUD 条目的 subId）还原；
// 父不在列表 / 成环一律回落为根，排序沿用「运行中优先、新派在前」。

function startedDesc(a, b) {
    return (b.startedAt || 0) - (a.startedAt || 0);
}

function levelCompare(a, b) {
    return ((b.agent.state === 'running') - (a.agent.state === 'running')) || startedDesc(a.agent, b.agent);
}

function countDescendants(node) {
    let n = 0;
    for (const child of node.children) n += 1 + countDescendants(child);
    return n;
}

// 成环保护：沿 parent 链最多走 list.length 步，回到自己就说明有环。
// （正常数据不会成环，这里只防脏数据把渲染挂死。）
function createsCycle(node, maxSteps) {
    let cur = node.parent;
    for (let i = 0; i < maxSteps && cur; i++) {
        if (cur === node) return true;
        cur = cur.parent;
    }
    return false;
}

// agents: listAgentsForHud() 的条目（可带 subId / parentSessionId / state / startedAt）
// 返回根节点数组；每个节点 {agent, children, descendantCount}。
export function buildAgentTree(agents) {
    const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
    const nodes = list.map((agent) => ({agent, parent: null, children: [], descendantCount: 0}));
    const nodeOf = new Map();
    for (const node of nodes) {
        const sid = node.agent.subId || node.agent.id;
        // 同一会话 id 只认第一条（上游已按 key 去重，这里再兜一层脏数据）
        if (sid && !nodeOf.has(sid)) nodeOf.set(sid, node);
    }
    for (const node of nodes) {
        const pid = node.agent.parentSessionId;
        const parent = pid ? nodeOf.get(pid) : null;
        if (!parent || parent === node) continue;
        node.parent = parent;
    }
    // 断环：把成环节点提升为根（子树跟着走，不会丢条目）。
    // 先断父指针、全部确认完再挂 children，避免留下「既是根又是别人的子节点」的脏环。
    for (const node of nodes) {
        if (node.parent && createsCycle(node, nodes.length + 1)) node.parent = null;
    }
    for (const node of nodes) {
        if (node.parent) node.parent.children.push(node);
    }
    for (const node of nodes) {
        node.children.sort(levelCompare);
        node.descendantCount = countDescendants(node);
    }
    const roots = nodes.filter((node) => !node.parent);
    roots.sort(levelCompare);
    return roots;
}

// 展开成显示行序（深度优先）。isCollapsed(key) 返回真且该节点有子级时不展开后代。
// 行：{agent, level, key, guides, isLast, childCount, descendantCount, collapsed}
//   key    —— 折叠态标识（与 isCollapsed 入参同一口径）
//   guides —— 祖先列的「是否还有后续兄弟」布尔数组（长度 = level - 1，根层为空）；
//             渲染树形连线时，guides[i] 为真表示第 i 列竖线要贯穿到下一行。
//   isLast —— 本节点是否为父的最后一个孩子；决定自己那列竖线是止于本行中心还是贯穿。
// 只描述结构、不含 DOM/CSS，团队协作视图据此画连线（层级封顶由视图侧处理）。
export function flattenAgentTree(roots, isCollapsed) {
    const rows = [];
    const collapsedOf = typeof isCollapsed === 'function' ? isCollapsed : () => false;
    const walk = (nodes, level, guides) => {
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index];
            const key = node.agent.key || node.agent.toolCallId || node.agent.subId || '';
            const collapsed = node.children.length > 0 && !!collapsedOf(key);
            const isLast = index === nodes.length - 1;
            rows.push({
                agent: node.agent,
                level,
                key,
                guides: guides.slice(),
                isLast,
                childCount: node.children.length,
                descendantCount: node.descendantCount,
                collapsed,
            });
            if (!collapsed) {
                // 根层不占连线段；从 level>=1 起把「是否有后续兄弟」传给子级画贯穿竖线。
                const childGuides = level === 0 ? [] : guides.concat(!isLast);
                walk(node.children, level + 1, childGuides);
            }
        }
    };
    walk(Array.isArray(roots) ? roots : [], 0, []);
    return rows;
}
