// palette-model.js：命令面板的纯逻辑（标签拆分 / 分组 / 模糊评分 / 组图标）。
// 从 palette.js 抽出，使这部分可脱离 DOM 单测；渲染仍留在 palette.js。

// 组名 → 命名图标（键必须已在 core/icons.js 注册，否则静默渲染为空）。
const GROUP_ICONS = {
    '文件': 'file',
    '编辑': 'code',
    '格式': 'braces',
    '视图': 'eye',
    '工具': 'gear',
    '主题': 'star',
    '帮助': 'question',
    'AI': 'sparkles',
    '书签': 'bookmark',
    '阅读': 'book-open',
    '数据': 'database',
    '设置': 'gear',
    '插件': 'puzzle',
};
export const DEFAULT_GROUP_ICON = 'chevron-right';

// 中文冒号前缀拆分：'文件： Markdown' → {group:'文件', text:'Markdown'}。
// 无前缀（或空段）归入 group=''，渲染时不显示组标题。只认中文冒号：
// label 里可能出现的英文冒号（如路径、URL）不应被误拆成组。
export function parsePaletteLabel(label) {
    const s = String(label == null ? '' : label);
    const m = s.match(/^([^：]+)：\s*(.*)$/);
    if (m && m[1].trim() && m[2].trim()) {
        return {group: m[1].trim(), text: m[2].trim()};
    }
    return {group: '', text: s};
}

// 模糊评分：整串命中 > 任意位置命中 > 子序列命中；不命中返回 -1。
// 用完整 label（含前缀）评分，保证搜「文件」能命中整组、搜「Markdown」能命中项。
export function fuzzyScore(label, query) {
    if (!query) return 1;
    const q = String(query).toLowerCase();
    const l = String(label == null ? '' : label).toLowerCase();
    const idx = l.indexOf(q);
    if (idx === 0) return 100;
    if (idx > 0) return 60 - Math.min(idx, 40);
    let pi = 0;
    for (let i = 0; i < l.length && pi < q.length; i++) {
        if (l[i] === q[pi]) pi++;
    }
    return pi === q.length ? 30 : -1;
}

// 按前缀分组 + 查询过滤。组按首次出现顺序（actions 已按菜单分类排好），
// 组内保持原顺序；无 action 函数的项（分隔符等）直接跳过。
export function groupActions(actions, query = '') {
    const map = new Map();
    for (const action of actions || []) {
        if (!action || action.sep || action.disabled || typeof action.action !== 'function') continue;
        const label = String(action.label == null ? '' : action.label);
        if (fuzzyScore(label, query) < 0) continue;
        const {group, text} = parsePaletteLabel(label);
        if (!map.has(group)) {
            map.set(group, {
                group,
                icon: group ? (GROUP_ICONS[group] || DEFAULT_GROUP_ICON) : '',
                items: [],
            });
        }
        map.get(group).items.push({action, text});
    }
    return [...map.values()];
}

export function groupIcon(group) {
    return (group && GROUP_ICONS[group]) || DEFAULT_GROUP_ICON;
}
