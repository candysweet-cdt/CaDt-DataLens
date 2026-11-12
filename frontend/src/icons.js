// 图标注册表：全项目唯一图标体系（规范见 docs/icon-guidelines.md）。
// 规则：UI 图标一律内联 SVG；禁止用文字字符（＋ ▾ ✕ ▸ ★ ✓ ○ 等）、emoji 或
// 图标字体（Segoe MDL2 等）充当图标。新图标先查这里，没有就登记后再用。
//
// SVG 约定：viewBox="0 0 16 16"，默认 fill="none" stroke="currentColor"
// stroke-width="1.4" linecap/linejoin round；实心图标（如 star）单独覆盖 fill。
// 尺寸常用 12 / 14 / 16px，由调用方决定，路径一律按 16 网格绘制。

const STROKE_ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

// 注册表整体导出（冻结）：供图标表页/测试枚举展示，业务代码请用 iconSvg()。
// name -> 内部图形（不含 <svg> 壳）。实心图标在这里自带 fill/stroke 覆盖。
const rawIcons = {
    'plus': '<path d="M8 3.5v9M3.5 8h9"/>',
    'close': '<path d="M4 4l8 8M12 4l-8 8"/>',
    'check': '<path d="M3.4 8.7l3.1 3.1 6.1-6.6"/>',
    'chevron-right': '<path d="M6 3.6L10.4 8 6 12.4"/>',
    'chevron-up': '<path d="M3.6 10L8 5.6l4.4 4.4"/>',
    'chevron-down': '<path d="M3.6 6L8 10.4l4.4-4.4"/>',
    'back': '<path d="M13 8H3.4"/><path d="M7.4 3.6L3.4 8l4 4.4"/>',
    'forward': '<path d="M3 8h9.6"/><path d="M8.6 3.6L12.6 8l-4 4.4"/>',
    'globe': '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2"/><path d="M8 2.4c1.8 1.6 2.7 3.4 2.7 5.6S9.8 12 8 13.6C6.2 12 5.3 10.2 5.3 8S6.2 4 8 2.4z"/>',
    'circle': '<circle cx="8" cy="8" r="4.4"/>',
    'warn': '<path d="M8 2.6L14 12.8H2L8 2.6z"/><path d="M8 6.6v2.8"/><path d="M8 11.5v.1"/>',
    'minimize': '<path d="M2.5 8.5h11"/>',
    'maximize': '<rect x="2.9" y="2.9" width="10.2" height="10.2" rx="0.8"/>',
    'restore': '<rect x="2.8" y="5.4" width="7.8" height="7.8" rx="0.8"/><path d="M5.4 5.4V3.6c0-.4.3-.8.8-.8h6.4c.4 0 .8.3.8.8V10c0 .4-.3.8-.8.8h-2"/>',
    'search': '<circle cx="6.8" cy="6.8" r="3.9"/><path d="M9.7 9.7l3.4 3.4"/>',
    'web-search': '<rect x="2.1" y="2.9" width="11.8" height="10.2" rx="1.2"/><path d="M2.1 5.3h11.8"/><circle cx="7.2" cy="8.5" r="2"/><path d="M8.7 10l1.5 1.5"/>',
    'eye': '<path d="M2.1 8c1.5-2.6 3.5-3.9 5.9-3.9s4.4 1.3 5.9 3.9c-1.5 2.6-3.5 3.9-5.9 3.9S3.6 10.6 2.1 8z"/><circle cx="8" cy="8" r="2.1"/>',
    'compass': '<circle cx="8" cy="8" r="5.6"/><path d="M10.6 5.4l-1.6 3.7-3.7 1.6 1.6-3.7 3.7-1.6z"/>',
    'clock': '<circle cx="8" cy="8" r="5.9"/><path d="M8 4.6V8l2.4 1.6"/>',
    'agents': '<circle cx="4" cy="4.6" r="2.1"/><circle cx="12" cy="4.6" r="2.1"/><circle cx="8" cy="11.8" r="2.1"/><path d="M5.7 6.1l1.5 3.6M10.3 6.1l-1.5 3.6M6.1 4.6h3.8"/>',
    'gear': '<path d="M6.9 1.8h2.2l.4 1.8c.5.2 1 .4 1.4.7l1.7-.6 1.1 1.9-1.3 1.2c.1.5.1 1 0 1.5l1.3 1.2-1.1 1.9-1.7-.6c-.4.3-.9.5-1.4.7l-.4 1.8H6.9l-.4-1.8c-.5-.2-1-.4-1.4-.7l-1.7.6-1.1-1.9 1.3-1.2c-.1-.5-.1-1 0-1.5l-1.3-1.2 1.1-1.9 1.7.6c.4-.3.9-.5 1.4-.7l.4-1.8z"/><circle cx="8" cy="8" r="2"/>',
    'refresh': '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.3 1.7v3h-3"/>',
    'shield': '<path d="M8 1.9l5 1.9v3.6c0 3.1-2 5.2-5 6.6-3-1.4-5-3.5-5-6.6V3.8l5-1.9z"/>',
    'shield-plus': '<path d="M8 1.9l5 1.9v3.6c0 3.1-2 5.2-5 6.6-3-1.4-5-3.5-5-6.6V3.8l5-1.9z"/><path d="M8 5.7v3.4M6.3 7.4h3.4"/>',
    'zap': '<path d="M8.7 1.9L4 8.3h3.1l-.8 5.8 4.7-6.4H7.9l.8-5.8z"/>',
    'trash': '<path d="M2.8 4.4h10.4M6.4 4.4V3.1c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.3M4.4 4.4l.6 8.3c0 .6.5 1.1 1.1 1.1h3.8c.6 0 1.1-.5 1.1-1.1l.6-8.3"/><path d="M6.7 7v3.8M9.3 7v3.8"/>',
    'eraser': '<path d="M9.5 2.7l3.8 3.8-6 6H4.5L2.6 10.6l6.9-6.9z"/><path d="M6.1 6.2l3.7 3.7"/><path d="M2.6 13.6h8.6"/>',
    'terminal': '<rect x="1.9" y="2.8" width="12.2" height="10.4" rx="1.4"/><path d="M4.5 6.3l2.3 2-2.3 2"/><path d="M8.6 10.6h3"/>',
    'browser': '<rect x="2.1" y="2.8" width="11.8" height="10.4" rx="1.2"/><path d="M2.1 5.4h11.8"/><path d="M4.2 4.1h.1M5.8 4.1h.1M7.4 4.1h.1"/>',
    'camera': '<path d="M2.6 5.4h2.1l.8-1.4h5l.8 1.4h2.1v6.5c0 .6-.5 1.1-1.1 1.1H3.7c-.6 0-1.1-.5-1.1-1.1V5.4z"/><circle cx="8" cy="8.7" r="2"/>',
    'cursor': '<path fill="currentColor" stroke="none" d="M4.6 2.6l6.6 6.6-3 .3 1.7 3.7-1.5.5-1.8-3.9-2 1.4V2.6z"/>',
    'keyboard': '<rect x="1.9" y="4.2" width="12.2" height="7.6" rx="1.2"/><path d="M4.1 6.3h.1M6.1 6.3h.1M8 6.3h.1M9.9 6.3h.1M11.8 6.3h.1"/><path d="M5 9.9h6"/>',
    'keycap': '<rect x="3.4" y="5" width="9.2" height="6" rx="1.4"/><path d="M5.6 8h4.8"/>',
    'code': '<path d="M5.4 4.4L2.6 8l2.8 3.6"/><path d="M10.6 4.4L13.4 8l-2.8 3.6"/><path d="M9.1 3.2l-2.2 9.6"/>',
    'save': '<path d="M2.8 3.4c0-.4.4-.8.8-.8h7.6l2 2v8.8c0 .4-.4.8-.8.8H3.6c-.4 0-.8-.4-.8-.8V3.4z"/><path d="M5 2.6v3.2h6V2.6"/><path d="M4.8 13.4V8.6h6.4v4.8"/>',
    'paste': '<rect x="3.4" y="2.6" width="9.2" height="11.6" rx="1.2"/><rect x="6" y="1.6" width="4" height="2" rx="0.6"/>',
    'redo': '<path d="M4 12a4.7 4.7 0 0 1 3.8-7.6h4.4"/><path d="M9.6 1.8l2.9 2.6-2.9 2.6"/>',
    'undo': '<path d="M12 12a4.7 4.7 0 0 0-3.8-7.6H3.8"/><path d="M6.4 1.8L3.5 4.4l2.9 2.6"/>',
    'file': '<path d="M4 2.4h4.6l2.6 2.6v8.2a.7.7 0 0 1-.7.7H4a.7.7 0 0 1-.7-.7V3.1c0-.4.3-.7.7-.7z"/><path d="M8.6 2.4V5h2.6"/>',
    'doc': '<path d="M4 2.4h4.6l2.6 2.6v8.2a.7.7 0 0 1-.7.7H4a.7.7 0 0 1-.7-.7V3.1c0-.4.3-.7.7-.7z"/><path d="M8.6 2.4V5h2.6"/><path d="M6 8.4h4M6 10.6h4"/>',
    'book': '<rect x="3.2" y="2.6" width="9.6" height="10.8" rx="0.8"/><path d="M5.6 2.6v10.8"/><path d="M8.2 5.4h2.9M8.2 8h2.9"/>',
    'book-open': '<path d="M8 3.6C6.7 2.7 5.1 2.2 3.4 2.2v9.2c1.7 0 3.3.5 4.6 1.4 1.3-.9 2.9-1.4 4.6-1.4V2.2c-1.7 0-3.3.5-4.6 1.4z"/><path d="M8 3.6v9.2"/>',
    'book-plus': '<rect x="3.2" y="2.6" width="9.6" height="10.8" rx="0.8"/><path d="M5.6 2.6v10.8"/><path d="M9 6.2v3.6M7.2 8h3.6"/>',
    'bookmark': '<path d="M4.1 3c0-.5.4-.9.9-.9h6c.5 0 .9.4.9.9v10.1L8 10.4l-3.9 2.6V3z"/>',
    'bookmark-plus': '<path d="M4.1 3c0-.5.4-.9.9-.9h6c.5 0 .9.4.9.9v10.1L8 10.4l-3.9 2.6V3z"/><path d="M8 4.6v3.2M6.4 6.2h3.2"/>',
    'history': '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.6V8l2.3 1.5"/>',
    'download': '<path d="M8 2.4v7M5.2 6.6L8 9.4l2.8-2.8"/><path d="M2.8 11.2v1.6c0 .5.4.9.9.9h8.6c.5 0 .9-.4.9-.9v-1.6"/>',
    'export': '<path d="M8.8 3H4.2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h4.6"/><path d="M6.8 8h6.6"/><path d="M11.2 5.4L13.8 8l-2.6 2.6"/>',
    'new-window': '<path d="M9.6 2.6H3.4a.9.9 0 0 0-.9.9v9a.9.9 0 0 0 .9.9h9a.9.9 0 0 0 .9-.9V6.2"/><path d="M7 9l6.4-6.4"/><path d="M9.8 2.6h3.6v3.6"/>',
    'rename': '<path d="M10.4 2.6l3 3-7.8 7.8-3.7.7.7-3.7 7.8-7.8z"/>',
    'select-all': '<rect x="2.4" y="2.4" width="7.4" height="7.4" rx="1" stroke-dasharray="2.3 1.5"/><rect x="6.6" y="6.6" width="6.8" height="6.8" rx="1"/>',
    'folder': '<path d="M2.2 4.4c0-.6.5-1.1 1.1-1.1h2.9l1.5 1.7h4.9c.6 0 1.1.5 1.1 1.1v5.9c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1V4.4z"/>',
    'open-folder': '<path d="M2.2 12.4l1.5-4h11.5l-1.5 4H2.2z"/><path d="M3.7 8.4V4.4c0-.6.5-1.1 1.1-1.1h2.7l1.5 1.7h4.7c.6 0 1.1.5 1.1 1.1v2.3"/>',
    'cut': '<circle cx="4.9" cy="4.9" r="1.9"/><circle cx="4.9" cy="11.1" r="1.9"/><path d="M6.5 6.2l7 6.5M6.5 9.8l7-6.5"/>',
    'copy': '<rect x="5.4" y="5.4" width="8" height="8" rx="1"/><path d="M10.2 2.6H3.6a1 1 0 0 0-1 1v6.6"/>',
    'diff': '<path d="M8 2.2v11.6"/><path d="M2.8 5.6h3.4M4.5 3.9v3.4"/><path d="M9.8 10.4h3.4"/>',
    'feedback': '<path d="M2.6 4.2c0-.7.6-1.3 1.3-1.3h8.2c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H7.6l-3.3 2.8v-2.8H3.9c-.7 0-1.3-.6-1.3-1.3V4.2z"/>',
    'info': '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.4v3.4"/><path d="M8 5.2v.1"/>',
    'star': '<path fill="currentColor" stroke="none" d="M8 1.9l1.9 3.9 4.2.6-3.1 2.9.9 4.2L8 11.4l-3.9 2.1.9-4.2L1.9 6.4l4.2-.6L8 1.9z"/>',
};

// 注册表整体导出（冻结）：供图标表页/测试枚举展示，业务代码请用 iconSvg()。
export const ICONS = Object.freeze({...rawIcons});

// 遗留映射：旧菜单数据里的 Segoe MDL2 码位 -> 注册表命名图标。
// 仅作迁移兼容，新代码一律直接写命名图标。
const LEGACY_ICONS = {
    'E70D': 'chevron-down',
    'E70E': 'chevron-up',
    'E72B': 'back',
    'E710': 'plus',
    'E713': 'gear',
    'E721': 'search',
    'E72C': 'refresh',
    'E72E': 'shield',
    'E74D': 'trash',
    'E74E': 'save',
    'E756': 'terminal',
    'E77F': 'paste',
    'E7A6': 'redo',
    'E7A7': 'undo',
    'E7C3': 'file',
    'E81C': 'history',
    'E895': 'download',
    'E896': 'export',
    'E8A5': 'doc',
    'E8A7': 'new-window',
    'E8AC': 'rename',
    'E8B3': 'select-all',
    'E8B7': 'folder',
    'E8BB': 'close',
    'E8C6': 'cut',
    'E8C8': 'copy',
    'E8D3': 'diff',
    'E8E5': 'open-folder',
    'E939': 'feedback',
    'E946': 'info',
    'E73E': 'check',
    'E76C': 'chevron-right',
    'E7BA': 'warn',
    'E921': 'minimize',
    'E922': 'maximize',
};

// 菜单数据里的 icon 字段：MDL2 码位（迁移兼容）或命名图标，返回注册表键。
export function resolveIconName(icon) {
    if (!icon) return null;
    if (/^E[0-9A-F]{3,4}$/.test(String(icon))) return LEGACY_ICONS[icon] || null;
    return ICONS[icon] ? icon : null;
}

// 返回可直接赋给 innerHTML 的 <svg> 字符串；未知键返回空串（不渲染占位符）。
export function iconSvg(name, size = 14) {
    const body = ICONS[name];
    if (!body) return '';
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" ${STROKE_ATTRS}>${body}</svg>`;
}

// 渲染菜单项图标槽（contextmenu.js 菜单与各弹出菜单共用）：
// 优先级 checked(勾) > swatch(主题色板) > iconHtml(现成 HTML/SVG) > icon(命名/遗留码位)。
export function renderMenuIcon(iconEl, item) {
    iconEl.innerHTML = '';
    if (item.checked) {
        iconEl.classList.add('checked');
        iconEl.innerHTML = iconSvg('check', 14);
        return;
    }
    iconEl.classList.remove('checked');
    if (item.swatch) {
        const dot = document.createElement('span');
        dot.className = 'mi-swatch';
        dot.style.background = 'linear-gradient(135deg, ' + item.swatch + ' 55%, ' + (item.swatchAccent || item.swatch) + ' 55%)';
        iconEl.appendChild(dot);
        return;
    }
    if (item.iconHtml) {
        iconEl.innerHTML = item.iconHtml;
        if (item.iconClass) iconEl.dataset.fi = item.iconClass.replace(/^fi-/, '');
        return;
    }
    const name = resolveIconName(item.icon);
    if (name) iconEl.innerHTML = iconSvg(name, 14);
}
