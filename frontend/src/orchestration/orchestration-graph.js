// orchestration-graph.js：审批卡的执行顺序依赖图（纯布局 + 内联 SVG）。
//
// 列 = PlanDryRun 给出的波次；同列批次可并行，受 maxParallel 与 owns 交集约束。
// 这里不判断调度，只把后端已算好的 waves + dependsOn 画成人能看懂的关系图。

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 150;
const NODE_H = 42;
const NODE_X0 = 30;
const LANE_X0 = 18;
const LANE_W = 174;
const COL_STEP = 200;
const Y0 = 62;
const ROW_GAP = 60;

function textOf(value) {
    return value == null ? '' : String(value);
}

function clipText(value, max) {
    const text = textOf(value);
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (value == null || value === '') continue;
            node.setAttribute(key, String(value));
        }
    }
    return node;
}

/**
 * 纯布局：输入计划与后端 dry-run 结果，输出可直接交给 renderExecutionGraph 的坐标。
 * options = {finalReview, finalReviewCount, maxParallel}
 */
export function buildExecutionGraph(plan, preview, options) {
    const opts = options || {};
    const batches = Array.isArray(plan && plan.batches) ? plan.batches : [];
    const byId = new Map(batches.map((b) => [textOf(b && b.id), b]).filter(([id]) => id));
    const rawWaves = Array.isArray(preview && preview.waves) ? preview.waves : [];
    let waves = rawWaves
        .map((ids) => (Array.isArray(ids) ? ids : []).map(textOf).filter((id) => byId.has(id)))
        .filter((ids) => ids.length);
    const placed = new Set(waves.flat());
    const missing = batches.map((b) => textOf(b && b.id)).filter((id) => id && !placed.has(id));
    if (missing.length) waves = waves.concat([missing]);
    if (!waves.length && batches.length) waves = [batches.map((b) => textOf(b.id))];

    const finalReview = opts.finalReview === true;
    const finalCount = finalReview
        ? Math.max(1, Math.min(3, Number(opts.finalReviewCount) || 1)) : 0;
    const maxParallel = Math.max(1, Number(opts.maxParallel) || 2);
    const columns = waves.map((ids) => ids.map((id) => byId.get(id)).filter(Boolean));
    const totalCols = columns.length + (finalReview ? 2 : 0);
    const width = Math.max(720, LANE_X0 * 2 + totalCols * LANE_W + Math.max(0, totalCols - 1) * (COL_STEP - LANE_W));
    const maxRows = Math.max(1, ...columns.map((col) => col.length), finalCount);
    const height = Math.max(240, Y0 + maxRows * ROW_GAP + 18);

    const lanes = [];
    const waveLabels = [];
    const nodes = [];
    const edges = [];
    const pos = new Map();

    const makeLane = (index) => {
        lanes.push({
            x: LANE_X0 + index * COL_STEP,
            y: 40,
            width: LANE_W,
            height: Math.max(200, height - 40),
        });
    };

    columns.forEach((col, index) => {
        const x = NODE_X0 + index * COL_STEP;
        makeLane(index);
        waveLabels.push({
            x, y: 26, label: '第 ' + (index + 1) + ' 波', count: col.length + ' 路并行',
        });
        col.forEach((batch, row) => {
            const node = {
                id: textOf(batch.id), title: textOf(batch.title),
                kind: 'work', x, y: Y0 + row * ROW_GAP,
            };
            nodes.push(node);
            pos.set(node.id, node);
        });
    });

    for (const batch of batches) {
        const target = pos.get(textOf(batch && batch.id));
        if (!target) continue;
        for (const dep of Array.isArray(batch.dependsOn) ? batch.dependsOn : []) {
            const source = pos.get(textOf(dep));
            if (!source) continue;
            edges.push({from: source, to: target, dashed: false});
        }
    }

    let barrier = null;
    const finalNodes = [];
    if (finalReview) {
        const barrierCol = columns.length;
        makeLane(barrierCol);
        barrier = {
            id: 'all-done', title: '全部批次完成', kind: 'barrier',
            x: NODE_X0 + barrierCol * COL_STEP,
            y: Y0 + Math.floor((maxRows - 1) / 2) * ROW_GAP,
        };
        waveLabels.push({x: barrier.x, y: 26, label: '汇合', count: '同步屏障'});
        const lastCol = columns.length ? columns[columns.length - 1] : [];
        for (const batch of lastCol) {
            const source = pos.get(textOf(batch.id));
            if (source) edges.push({from: source, to: barrier, dashed: false});
        }
        const reviewCol = barrierCol + 1;
        makeLane(reviewCol);
        waveLabels.push({
            x: NODE_X0 + reviewCol * COL_STEP, y: 26,
            label: '终审', count: finalCount + ' 个只读',
        });
        for (let i = 0; i < finalCount; i++) {
            const node = {
                id: 'final-review-' + (i + 1),
                title: i === 0 ? '整体接线审查' : '终审 ' + (i + 1),
                kind: 'review',
                x: NODE_X0 + reviewCol * COL_STEP,
                y: Y0 + i * ROW_GAP,
            };
            finalNodes.push(node);
            edges.push({from: barrier, to: node, dashed: true});
        }
    }

    return {
        width, height, lanes, waveLabels, nodes, edges, barrier, finalNodes,
        waves: columns.map((col) => col.map((b) => textOf(b.id))),
        maxParallel,
    };
}

function edgePath(from, to) {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const dx = Math.max(18, (x2 - x1) / 2);
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' '
        + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
}

function appendText(parent, className, x, y, text) {
    const node = svgEl('text', {class: className, x, y});
    node.textContent = text;
    parent.appendChild(node);
    return node;
}

/** 把布局写入一个 SVG 元素；节点/边全部走 DOM，不拼字符串。 */
export function renderExecutionGraph(svg, layout) {
    if (!svg || !layout) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '编排执行顺序依赖图');
    svg.style.minWidth = layout.width + 'px';

    const defs = svgEl('defs');
    for (const [id, color] of [['orch-graph-arrow', 'var(--border, #555)'],
        ['orch-graph-arrow-review', 'var(--fg-muted, #888)']]) {
        const marker = svgEl('marker', {
            id, viewBox: '0 0 10 10', refX: 8.5, refY: 5,
            markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
        });
        marker.appendChild(svgEl('path', {d: 'M0,0 L10,5 L0,10 z', fill: color}));
        defs.appendChild(marker);
    }
    svg.appendChild(defs);

    for (const lane of layout.lanes) {
        svg.appendChild(svgEl('rect', {
            class: 'orch-graph-lane', x: lane.x, y: lane.y,
            width: lane.width, height: lane.height, rx: 8,
        }));
    }

    for (const label of layout.waveLabels) {
        appendText(svg, 'orch-graph-wave-label', label.x, label.y, label.label);
        appendText(svg, 'orch-graph-wave-count', label.x + 52, label.y, label.count);
    }

    for (const edge of layout.edges) {
        svg.appendChild(svgEl('path', {
            class: 'orch-graph-edge' + (edge.dashed ? ' review' : ''),
            d: edgePath(edge.from, edge.to),
            'marker-end': 'url(#' + (edge.dashed ? 'orch-graph-arrow-review' : 'orch-graph-arrow') + ')',
        }));
    }

    for (const node of layout.nodes.concat(layout.finalNodes)) {
        const g = svgEl('g', {class: 'orch-graph-node ' + node.kind});
        const title = svgEl('title');
        title.textContent = node.title || node.id;
        g.appendChild(title);
        g.appendChild(svgEl('rect', {
            x: node.x, y: node.y, width: NODE_W, height: NODE_H, rx: 7,
        }));
        appendText(g, 'orch-graph-node-id', node.x + 12, node.y + 17, clipText(node.id, 18));
        appendText(g, 'orch-graph-node-title', node.x + 12, node.y + 33, clipText(node.title, 16));
        svg.appendChild(g);
    }
}