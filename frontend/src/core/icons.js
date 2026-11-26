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
    // 生命周期（预指令/生命周期钩子设置页）：循环箭头 + 中心播放三角，表「随事件循环自动跑」
    'lifecycle': '<path d="M5.7 7v2l5 3.5z" fill="currentColor" stroke="none"/>'
        + '<path d="M12.9 6.1a5.3 5.3 0 0 0-9.5-1.2"/>'
        + '<path d="M3.4 3.2v2.4h2.4"/>'
        + '<path d="M3.1 9.9a5.3 5.3 0 0 0 9.5 1.2"/>'
        + '<path d="M12.6 12.8v-2.4h-2.4"/>',
    'plus': '<path d="M8 3.5v9M3.5 8h9"/>',
    'close': '<path d="M4 4l8 8M12 4l-8 8"/>',
    'check': '<path d="M3.4 8.7l3.1 3.1 6.1-6.6"/>',
    // 圆圈勾 / 圆圈叉：状态徽标造型（消息中心成功/失败、分支弹层当前分支），与裸勾/叉区分
    'circle-check': '<circle cx="8" cy="8" r="5.6"/><path d="M5.5 8.2l1.7 1.7 3.3-3.5"/>',
    'circle-x': '<circle cx="8" cy="8" r="5.6"/><path d="M6 6l4 4M10 6l-4 4"/>',
    'question': '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.7.6-.7 1.1v.4"/><circle cx="8" cy="11.6" r=".75" fill="currentColor" stroke="none"/>',
    'chevron-right': '<path d="M6 3.6L10.4 8 6 12.4"/>',
    'chevron-left': '<path d="M10 3.6L5.6 8l4.4 4.4"/>',
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
    'layout-dock': '<rect x="2.4" y="3" width="11.2" height="10" rx="1"/><path d="M9.8 3v10"/>',
    'layout-fullscreen': '<rect x="2.4" y="3" width="11.2" height="10" rx="1"/><path d="M6 6.2h1.4V4.8M10 6.2H8.6V4.8M6 9.8h1.4v1.4M10 9.8H8.6v1.4"/>',
    'layout-float': '<rect x="2.4" y="3" width="8.4" height="7.4" rx="1"/><rect x="6.4" y="6.4" width="7.2" height="6.4" rx="1"/>',
    'swap-side': '<rect x="2.4" y="3" width="11.2" height="10" rx="1"/><path d="M6.2 3v10"/><path d="M9.6 6.6L11.4 8.4 9.6 10.2"/>',
    'search': '<circle cx="6.8" cy="6.8" r="3.9"/><path d="M9.7 9.7l3.4 3.4"/>',
    'web-search': '<rect x="2.1" y="2.9" width="11.8" height="10.2" rx="1.2"/><path d="M2.1 5.3h11.8"/><circle cx="7.2" cy="8.5" r="2"/><path d="M8.7 10l1.5 1.5"/>',
    'eye': '<path d="M2.1 8c1.5-2.6 3.5-3.9 5.9-3.9s4.4 1.3 5.9 3.9c-1.5 2.6-3.5 3.9-5.9 3.9S3.6 10.6 2.1 8z"/><circle cx="8" cy="8" r="2.1"/>',
    'compass': '<circle cx="8" cy="8" r="5.6"/><path d="M10.6 5.4l-1.6 3.7-3.7 1.6 1.6-3.7 3.7-1.6z"/>',
    'clock': '<circle cx="8" cy="8" r="5.9"/><path d="M8 4.6V8l2.4 1.6"/>',
    'bell': '<path d="M8 2.2a3.7 3.7 0 0 0-3.7 3.7v2.5L3 11.3h10l-1.3-2.9V5.9A3.7 3.7 0 0 0 8 2.2z"/><path d="M6.6 13.2a1.4 1.4 0 0 0 2.8 0"/>',
    'agents': '<circle cx="4" cy="4.6" r="2.1"/><circle cx="12" cy="4.6" r="2.1"/><circle cx="8" cy="11.8" r="2.1"/><path d="M5.7 6.1l1.5 3.6M10.3 6.1l-1.5 3.6M6.1 4.6h3.8"/>',
    // Maven 工具窗口：字母 M 造型（Maven 标识的简化笔顺），侧栏活动栏与树节点共用
    'maven': '<path d="M3.2 12.6V3.8L8 9.2l4.8-5.4v8.8"/>',
    'gear': '<path d="M6.9 1.8h2.2l.4 1.8c.5.2 1 .4 1.4.7l1.7-.6 1.1 1.9-1.3 1.2c.1.5.1 1 0 1.5l1.3 1.2-1.1 1.9-1.7-.6c-.4.3-.9.5-1.4.7l-.4 1.8H6.9l-.4-1.8c-.5-.2-1-.4-1.4-.7l-1.7.6-1.1-1.9 1.3-1.2c-.1-.5-.1-1 0-1.5l-1.3-1.2 1.1-1.9 1.7.6c.4-.3.9-.5 1.4-.7l.4-1.8z"/><circle cx="8" cy="8" r="2"/>',
    'refresh': '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.3 1.7v3h-3"/>',
    'play': '<path fill="currentColor" stroke="none" d="M5.3 3.5l7 4.5-7 4.5V3.5z"/>',
    'pause': '<rect x="4.6" y="3.5" width="2.3" height="9" rx="0.6" fill="currentColor" stroke="none"/><rect x="9.1" y="3.5" width="2.3" height="9" rx="0.6" fill="currentColor" stroke="none"/>',
    // 停止（结束运行）：实心圆角方块，与输入区 #ai-stop 的停止字形一致
    'stop': '<rect x="4" y="4" width="8" height="8" rx="1.3" fill="currentColor" stroke="none"/>',
    'shield': '<path d="M8 1.9l5 1.9v3.6c0 3.1-2 5.2-5 6.6-3-1.4-5-3.5-5-6.6V3.8l5-1.9z"/>',
    'shield-plus': '<path d="M8 1.9l5 1.9v3.6c0 3.1-2 5.2-5 6.6-3-1.4-5-3.5-5-6.6V3.8l5-1.9z"/><path d="M8 5.7v3.4M6.3 7.4h3.4"/>',
    'zap': '<path d="M8.7 1.9L4 8.3h3.1l-.8 5.8 4.7-6.4H7.9l.8-5.8z"/>',
    'sparkles': '<path d="M6.2 2.3c.5 2.4 1.7 3.6 4.1 4.1-2.4.5-3.6 1.7-4.1 4.1-.5-2.4-1.7-3.6-4.1-4.1 2.4-.5 3.6-1.7 4.1-4.1z"/><path d="M11.6 9.6c.3 1.5 1 2.2 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.3 2.2-1 2.5-2.5z"/>',
    // 多工作区（窗口模式 chip）：三层叠放，表「一个窗口管多个目录」
    'layers': '<path d="M8 2.3L2.3 5.4 8 8.5l5.7-3.1z"/><path d="M2.3 8.3L8 11.4l5.7-3.1"/><path d="M2.3 11.2L8 14.3l5.7-3.1"/>',
    'chart': '<path d="M3.6 13V8.4"/><path d="M8 13V3.6"/><path d="M12.4 13V6"/>',
    // 外部工具：扫描框（OCR）/ 麦克风（ASR）/ 扬声器（TTS）
    'scan': '<path d="M3 5.6V3.8c0-.4.4-.8.8-.8h1.8"/><path d="M13 5.6V3.8c0-.4-.4-.8-.8-.8h-1.8"/><path d="M3 10.4v1.8c0 .4.4.8.8.8h1.8"/><path d="M13 10.4v1.8c0 .4-.4.8-.8.8h-1.8"/><path d="M5.2 8h5.6"/>',
    'microphone': '<path d="M8 2.2a2 2 0 0 0-2 2v3.2a2 2 0 0 0 4 0V4.2a2 2 0 0 0-2-2z"/><path d="M4.8 7.2a3.2 3.2 0 0 0 6.4 0"/><path d="M8 10.4v3.4"/><path d="M6.2 13.8h3.6"/>',
    'speaker': '<path d="M3 6.2h2l3-2.4v8.4l-3-2.4H3V6.2z"/><path d="M10.4 6.2a2.6 2.6 0 0 1 0 3.6"/><path d="M12.1 4.6a5 5 0 0 1 0 6.8"/>',
    'trash': '<path d="M2.8 4.4h10.4M6.4 4.4V3.1c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.3M4.4 4.4l.6 8.3c0 .6.5 1.1 1.1 1.1h3.8c.6 0 1.1-.5 1.1-1.1l.6-8.3"/><path d="M6.7 7v3.8M9.3 7v3.8"/>',
    'eraser': '<path d="M9.5 2.7l3.8 3.8-6 6H4.5L2.6 10.6l6.9-6.9z"/><path d="M6.1 6.2l3.7 3.7"/><path d="M2.6 13.6h8.6"/>',
    'terminal': '<rect x="1.9" y="2.8" width="12.2" height="10.4" rx="1.4"/><path d="M4.5 6.3l2.3 2-2.3 2"/><path d="M8.6 10.6h3"/>',
    'browser': '<rect x="2.1" y="2.8" width="11.8" height="10.4" rx="1.2"/><path d="M2.1 5.4h11.8"/><path d="M4.2 4.1h.1M5.8 4.1h.1M7.4 4.1h.1"/>',
    'memo': '<path d="M2.6 3.2l1.5 1.5L6.4 2.2"/><path d="M9.4 3.6h4M2.6 8h2.6M9.4 8h4M2.6 12.6h2.6M9.4 12.6h4"/>',
    'more': '<circle cx="3.4" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
    // 拖动排序手柄（3×3 点阵，实心）
    'grip': '<g fill="currentColor" stroke="none"><circle cx="5" cy="4" r="1.05"/><circle cx="8" cy="4" r="1.05"/><circle cx="11" cy="4" r="1.05"/><circle cx="5" cy="8" r="1.05"/><circle cx="8" cy="8" r="1.05"/><circle cx="11" cy="8" r="1.05"/><circle cx="5" cy="12" r="1.05"/><circle cx="8" cy="12" r="1.05"/><circle cx="11" cy="12" r="1.05"/></g>',
    'camera': '<path d="M2.6 5.4h2.1l.8-1.4h5l.8 1.4h2.1v6.5c0 .6-.5 1.1-1.1 1.1H3.7c-.6 0-1.1-.5-1.1-1.1V5.4z"/><circle cx="8" cy="8.7" r="2"/>',
    // 生图与视频（设置导航）：相框 + 太阳 + 山形
    'image': '<rect x="2.6" y="2.9" width="10.8" height="10.2" rx="1.2"/><circle cx="5.9" cy="6.2" r="1.1"/><path d="M3.2 11.3l3-2.9 2.6 2.4 2.3-2.1 1.9 1.8"/>',
    'cursor': '<path fill="currentColor" stroke="none" d="M4.6 2.6l6.6 6.6-3 .3 1.7 3.7-1.5.5-1.8-3.9-2 1.4V2.6z"/>',
    'keyboard': '<rect x="1.9" y="4.2" width="12.2" height="7.6" rx="1.2"/><path d="M4.1 6.3h.1M6.1 6.3h.1M8 6.3h.1M9.9 6.3h.1M11.8 6.3h.1"/><path d="M5 9.9h6"/>',
    'keycap': '<rect x="3.4" y="5" width="9.2" height="6" rx="1.4"/><path d="M5.6 8h4.8"/>',
    'code': '<path d="M5.4 4.4L2.6 8l2.8 3.6"/><path d="M10.6 4.4L13.4 8l-2.8 3.6"/><path d="M9.1 3.2l-2.2 9.6"/>',
    // 花括号对（补全候选的「键」类型：JSON/YAML/TOML 的字段名）
    'braces': '<path d="M6.2 3c-1.6.2-2.1 1-2 2.2v1.5c0 .9-.6 1.5-1.6 1.8 1 .3 1.6.9 1.6 1.8v1.5c-.1 1.2.4 2 2 2.2"/><path d="M9.8 3c1.6.2 2.1 1 2 2.2v1.5c0 .9.6 1.5 1.6 1.8-1 .3-1.6.9-1.6 1.8v1.5c.1 1.2-.4 2-2 2.2"/>',
    'git': '<circle cx="4.6" cy="3.4" r="1.5"/><circle cx="4.6" cy="12.6" r="1.5"/><circle cx="11.4" cy="5.6" r="1.5"/><path d="M4.6 4.9v6.2"/><path d="M11.4 7.1v1.2c0 1.4-1.1 2.6-2.5 2.6H6.1"/>',
    // Git 提交节点：横线贯穿的圆环（git-commit 造型）
    'git-commit': '<circle cx="8" cy="8" r="2"/><path d="M2.8 8h3.2M10 8h3.2"/>',
    // 提交并推送：提交节点 + 上行箭头
    'git-commit-push': '<circle cx="8" cy="11.8" r="1.8"/><path d="M2.7 11.8h3.5M9.8 11.8h3.5"/><path d="M8 10V3.8"/><path d="M5.9 5.9L8 3.8l2.1 2.1"/>',
    'save': '<path d="M2.8 3.4c0-.4.4-.8.8-.8h7.6l2 2v8.8c0 .4-.4.8-.8.8H3.6c-.4 0-.8-.4-.8-.8V3.4z"/><path d="M5 2.6v3.2h6V2.6"/><path d="M4.8 13.4V8.6h6.4v4.8"/>',
    // 归档（带盖的归档盒 + 正面标签槽）
    'archive': '<rect x="2.4" y="2.6" width="11.2" height="3.1" rx="0.7"/><path d="M3.5 5.7v6.7c0 .6.5 1.1 1.1 1.1h6.8c.6 0 1.1-.5 1.1-1.1V5.7"/><path d="M6.3 8.7h3.4"/>',
    // 取消归档（归档盒 + 向上取出的箭头）
    'unarchive': '<rect x="2.4" y="6.8" width="11.2" height="6.6" rx="0.7"/><path d="M4.6 9.6h6.8"/><path d="M8 11.8V7.4M6.5 8.9L8 7.4l1.5 1.5"/>',
    'paste': '<rect x="3.4" y="2.6" width="9.2" height="11.6" rx="1.2"/><rect x="6" y="1.6" width="4" height="2" rx="0.6"/>',
    'redo': '<path d="M4 12a4.7 4.7 0 0 1 3.8-7.6h4.4"/><path d="M9.6 1.8l2.9 2.6-2.9 2.6"/>',
    'undo': '<path d="M12 12a4.7 4.7 0 0 0-3.8-7.6H3.8"/><path d="M6.4 1.8L3.5 4.4l2.9 2.6"/>',
    'file': '<path d="M4 2.4h4.6l2.6 2.6v8.2a.7.7 0 0 1-.7.7H4a.7.7 0 0 1-.7-.7V3.1c0-.4.3-.7.7-.7z"/><path d="M8.6 2.4V5h2.6"/>',
    'doc': '<path d="M4 2.4h4.6l2.6 2.6v8.2a.7.7 0 0 1-.7.7H4a.7.7 0 0 1-.7-.7V3.1c0-.4.3-.7.7-.7z"/><path d="M8.6 2.4V5h2.6"/><path d="M6 8.4h4M6 10.6h4"/>',
    // 条目清单（设置导航「用户偏好」）：三个实心圆点 + 等长文本行
    'list': '<circle cx="3.6" cy="4.2" r=".9" fill="currentColor" stroke="none"/><circle cx="3.6" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="3.6" cy="11.8" r=".9" fill="currentColor" stroke="none"/><path d="M6.4 4.2h7M6.4 8h7M6.4 11.8h7"/>',
    'book': '<rect x="3.2" y="2.6" width="9.6" height="10.8" rx="0.8"/><path d="M5.6 2.6v10.8"/><path d="M8.2 5.4h2.9M8.2 8h2.9"/>',
    'book-open': '<path d="M8 3.6C6.7 2.7 5.1 2.2 3.4 2.2v9.2c1.7 0 3.3.5 4.6 1.4 1.3-.9 2.9-1.4 4.6-1.4V2.2c-1.7 0-3.3.5-4.6 1.4z"/><path d="M8 3.6v9.2"/>',
    'book-plus': '<rect x="3.2" y="2.6" width="9.6" height="10.8" rx="0.8"/><path d="M5.6 2.6v10.8"/><path d="M9 6.2v3.6M7.2 8h3.6"/>',
    'bookmark': '<path d="M4.1 3c0-.5.4-.9.9-.9h6c.5 0 .9.4.9.9v10.1L8 10.4l-3.9 2.6V3z"/>',
    // 支线对话：主气泡 + 旁挂的小气泡（与「分支」的节点图区分开）
    'sidechat': '<path d="M12.6 9.2a2 2 0 0 1-2 2H6.6L3.4 13.8v-3.2"/><path d="M3 6.2A2 2 0 0 1 5 4.2h6a2 2 0 0 1 2 2v.6a2 2 0 0 1-2 2H7l-2.6 2V8.2H5a2 2 0 0 1-2-2z"/>',
    // 群聊（圆桌）：两个交叠人像
    'group': '<circle cx="5.6" cy="5.6" r="2.1"/><path d="M2.2 13.2c.4-2.5 1.8-4 3.4-4s3 1.5 3.4 4"/><circle cx="10.9" cy="6.2" r="1.7"/><path d="M10.9 9.2c1.8 0 3 1.3 3.4 3.6"/>',
    'bookmark-plus': '<path d="M4.1 3c0-.5.4-.9.9-.9h6c.5 0 .9.4.9.9v10.1L8 10.4l-3.9 2.6V3z"/><path d="M8 4.6v3.2M6.4 6.2h3.2"/>',
    'history': '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.6V8l2.3 1.5"/>',
    'download': '<path d="M8 2.4v7M5.2 6.6L8 9.4l2.8-2.8"/><path d="M2.8 11.2v1.6c0 .5.4.9.9.9h8.6c.5 0 .9-.4.9-.9v-1.6"/>',
    // 上传/推送：与 download 同托盘，箭头朝上
    'upload': '<path d="M8 2.4v7M5.2 5.2L8 2.4l2.8 2.8"/><path d="M2.8 11.2v1.6c0 .5.4.9.9.9h8.6c.5 0 .9-.4.9-.9v-1.6"/>',
    // 插件设置（拼图块）：主体 + 朝上、朝右两个凸头
    'puzzle': '<path d="M3 5h2.1a1.9 1.9 0 0 1 3.8 0H11v2.1a1.9 1.9 0 0 1 0 3.8V13H3z"/>',
    'export': '<path d="M8.8 3H4.2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h4.6"/><path d="M6.8 8h6.6"/><path d="M11.2 5.4L13.8 8l-2.6 2.6"/>',
    'new-window': '<path d="M9.6 2.6H3.4a.9.9 0 0 0-.9.9v9a.9.9 0 0 0 .9.9h9a.9.9 0 0 0 .9-.9V6.2"/><path d="M7 9l6.4-6.4"/><path d="M9.8 2.6h3.6v3.6"/>',
    'rename': '<path d="M10.4 2.6l3 3-7.8 7.8-3.7.7.7-3.7 7.8-7.8z"/>',
    'select-all': '<rect x="2.4" y="2.4" width="7.4" height="7.4" rx="1" stroke-dasharray="2.3 1.5"/><rect x="6.6" y="6.6" width="6.8" height="6.8" rx="1"/>',
    'folder': '<path d="M2.2 4.4c0-.6.5-1.1 1.1-1.1h2.9l1.5 1.7h4.9c.6 0 1.1.5 1.1 1.1v5.9c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1V4.4z"/>',
    'open-folder': '<path d="M2.2 12.4l1.5-4h11.5l-1.5 4H2.2z"/><path d="M3.7 8.4V4.4c0-.6.5-1.1 1.1-1.1h2.7l1.5 1.7h4.7c.6 0 1.1.5 1.1 1.1v2.3"/>',
    'cut': '<circle cx="4.9" cy="4.9" r="1.9"/><circle cx="4.9" cy="11.1" r="1.9"/><path d="M6.5 6.2l7 6.5M6.5 9.8l7-6.5"/>',
    'copy': '<rect x="5.4" y="5.4" width="8" height="8" rx="1"/><path d="M10.2 2.6H3.6a1 1 0 0 0-1 1v6.6"/>',
    // 引用（AI 消息右键「引用所选 / 引用整条回复」）：一对左双引号
    'quote': '<path d="M6.4 4.4c-2 .7-3.2 2.3-3.2 4.4h2.6v2.8H2.6V8.4C2.6 6.2 3.9 4.8 6.4 4.4z"/><path d="M13.2 4.4c-2 .7-3.2 2.3-3.2 4.4h2.6v2.8H9.4V8.4C9.4 6.2 10.7 4.8 13.2 4.4z"/>',
    'diff': '<path d="M8 2.2v11.6"/><path d="M2.8 5.6h3.4M4.5 3.9v3.4"/><path d="M9.8 10.4h3.4"/>',
    'feedback': '<path d="M2.6 4.2c0-.7.6-1.3 1.3-1.3h8.2c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H7.6l-3.3 2.8v-2.8H3.9c-.7 0-1.3-.6-1.3-1.3V4.2z"/>',
    'info': '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.4v3.4"/><path d="M8 5.2v.1"/>',
    'star': '<path fill="currentColor" stroke="none" d="M8 1.9l1.9 3.9 4.2.6-3.1 2.9.9 4.2L8 11.4l-3.9 2.1.9-4.2L1.9 6.4l4.2-.6L8 1.9z"/>',
    'pin': '<path fill="currentColor" stroke="none" d="M10.6 1.7l3.7 3.7-2.4.7-1.8 1.8.3 2.8-1.3 1.3-2.5-2.5-3.9 3.9-.8-.8 3.9-3.9-2.5-2.5 1.3-1.3 2.8.3 1.8-1.8.4-2.6z"/>',
    // 竖直图钉（固定态）：与斜的 pin 配对，表示「已固定」。Git 弹层固定按钮用
    'pin-upright': '<path fill="currentColor" stroke="none" d="M5.5 2h5v1.5h-5z"/><path fill="currentColor" stroke="none" d="M6.2 3.5h3.6l-.7 5.8L8 13.8l-1.1-4.5z"/>',
    'lock': '<rect x="3.4" y="7" width="9.2" height="6.8" rx="1.4"/><path d="M6 7V5.6a2 2 0 0 1 4 0V7"/><circle cx="8" cy="10.4" r=".9" fill="currentColor" stroke="none"/>',
    // 搜索选项（Git 图谱提交搜索）：正则用「点 + 星形」，大小写用「大小两个圆环」，筛选下拉用漏斗
    'regex': '<circle cx="4.2" cy="11.4" r="1.1" fill="currentColor" stroke="none"/><path d="M8.4 4.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7z"/><path d="M11.8 9.2l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4.4-1.1z"/>',
    'case-sensitive': '<circle cx="5.4" cy="10.4" r="2.2"/><circle cx="10.8" cy="5.8" r="3.2"/>',
    'filter': '<path d="M2.4 3.2h11.2L9.2 8.6v4.2l-2.4 1.2V8.6L2.4 3.2z"/>',
    'user': '<circle cx="8" cy="5.4" r="2.8"/><path d="M2.8 13.4c0-2.6 2.3-4.6 5.2-4.6s5.2 2 5.2 4.6"/>',
    'calendar': '<rect x="2.6" y="3.6" width="10.8" height="9.8" rx="1.3"/><path d="M2.6 6.6h10.8"/><path d="M5.4 2.4v2.4M10.6 2.4v2.4"/>',
    // 数据库（本轮用量 / SQL 视图）：双壁圆柱
    'database': '<ellipse cx="8" cy="4.2" rx="4.5" ry="1.7"/><path d="M3.5 4.2v3.7c0 .94 2.01 1.7 4.5 1.7s4.5-.76 4.5-1.7V4.2"/><path d="M3.5 7.9v3.7c0 .94 2.01 1.7 4.5 1.7s4.5-.76 4.5-1.7V7.9"/>',
    // 钥匙（Redis 连接与键值）：圆环头 + 斜杆 + 两齿
    'key': '<circle cx="5.2" cy="5.6" r="3"/><path d="M7.5 7.9l5 5M10.7 11.1l1.7-1.7M9.1 12.7l1.5-1.5"/>',
    // 结构化目录（复制 / 导出目录结构）：逐级缩进的四行
    'structured-dir': '<path d="M2.4 3.6h11.2M4.4 6.8h9.2M6.4 10h7.2M8.4 13.2h5.2"/>',
    // 解锁（与 lock 成对：文档只读锁的解锁态，锁梁张开）
    'unlock': '<rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4"/><path d="M6 7V5.6A2.5 2.5 0 0 1 10.8 4.4"/><circle cx="8" cy="10.4" r="1" fill="currentColor" stroke="none"/>',
    // 回退到此轮（AI 消息动作）：左箭头 + 拖回的弧线（弧底收在 14.8，避免描边溢出 16 网格被裁）
    'rewind': '<path d="M6.2 4L2.8 7.4l3.4 3.4"/><path d="M3 7.4h6.2a3.7 3.7 0 1 1 0 7.4H6.2"/>',
    // 带回主对话（支线对话动作）：右箭头 + 右壁
    'bringback': '<path d="M3 8h8.6"/><path d="M8.4 4.6L11.8 8l-3.4 3.4"/><path d="M13 3.2v9.6"/>',
    // 投递（AI 消息投递到其他会话/子代理）：纸飞机
    'deliver': '<path d="M3.2 8l9.2-4.6v9.2z"/><path d="M12.4 8h1.9"/><path d="M3.2 8h1.2"/>',
    // 标签（Git tag）：吊牌 + 圆点
    'tag': '<path d="M2.6 3.2h5.1l5 5-4.5 4.5-5-5z"/><circle cx="5.3" cy="5.9" r="1" fill="currentColor" stroke="none"/>',
    // 全部折叠 / 全部展开（结构面板工具栏）：上下箭头指向 / 背离中线
    // （原 14 网格的四角斜线正反画渲染像素级一致、两态不可区分，复审后改为折叠箭头造型）
    'collapse-all': '<path d="M4.8 2.6L8 5.8l3.2-3.2"/><path d="M4.8 13.4L8 10.2l3.2 3.2"/><path d="M2.8 8h10.4"/>',
    'expand-all': '<path d="M4.8 5.8L8 2.6l3.2 3.2"/><path d="M4.8 10.2L8 13.4l3.2-3.2"/><path d="M2.8 8h10.4"/>',
    // 目录树（explorer 列表/树切换）：树干 + 两个分支盒
    'tree': '<path d="M3 3.2v9.6M3 6h4.2M3 11.8h4.2"/><path d="M7.2 4.6h5.2v2.8H7.2zM7.2 10.4h5.2v2.8H7.2z" stroke-width="1.1"/>',
    // 定位（在资源管理器中显示）：靶心十字
    'locate': '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.5"/><path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2"/>',
    // 任务清单（AI 任务卡头）：实心圆点 + 实心条 ×2
    'checklist': '<circle cx="3" cy="4.6" r="1.25" fill="currentColor" stroke="none"/><rect x="6" y="3.8" width="8" height="1.6" rx="0.8" fill="currentColor" stroke="none"/><circle cx="3" cy="11.4" r="1.25" fill="currentColor" stroke="none"/><rect x="6" y="10.6" width="8" height="1.6" rx="0.8" fill="currentColor" stroke="none"/>',
    // 环境变量（创建环境变量卡头）：输入框 + 占位横线
    'env': '<rect x="2.2" y="3.8" width="11.6" height="8.4" rx="1.6"/><path d="M5.6 8h4.8"/>',
    // 计划（计划等待批准卡头）：方框 + 文本行
    'plan': '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/><path d="M5.5 6h5M5.5 8.4h5M5.5 10.8h3"/>',
    // 竖排三点（更多操作，列布局），与横排 more 区分
    'more-vertical': '<circle cx="8" cy="3.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="12.6" r="1.15" fill="currentColor" stroke="none"/>',
    // ---- 视图模式族（editor-groups 视图下拉收编，14 网格重画为 16 网格）----
    'view-tree': '<path d="M1.7 3.7h12.6M1.7 8h8.7M1.7 12.3h5"/>',
    'view-table': '<rect x="1.7" y="2.5" width="12.6" height="11" rx="1.1"/><path d="M1.7 6.4h12.6M6.1 2.5v11M10.3 2.5v11" stroke-width="1.1"/>',
    'view-binary': '<rect x="2.2" y="4.4" width="4.8" height="7.2" rx="1"/><rect x="9" y="4.4" width="4.8" height="7.2" rx="1"/>',
    'view-video': '<rect x="1.7" y="3" width="12.6" height="10" rx="1.6"/><path d="M6.7 6l3.8 2-3.8 2z" fill="currentColor" stroke="none"/>',
    'view-audio': '<ellipse cx="5.9" cy="11.2" rx="2.5" ry="1.9" fill="currentColor" stroke="none"/><path d="M8.5 11.2V3.7c3 .5 4.2 1.5 4.2 3.3"/>',
    'view-render': '<path d="M2.3 12.6c3.2 0 3.9-8 7.1-8 1.9 0 2.3 1.8 4.3 1.8"/><circle cx="2.3" cy="12.6" r="1.3" fill="currentColor" stroke="none"/><circle cx="13.7" cy="6.4" r="1.3" fill="currentColor" stroke="none"/>',
    'view-patch': '<path d="M2.3 3.9h11.4M2.3 8h7.3M2.3 12.1h4.6"/><path d="M11 9.4l2.7 2.7-2.7 2.7"/>',
    'view-split': '<rect x="1.7" y="2.5" width="12.6" height="11" rx="1.1"/><path d="M8 2.9v10.2"/>',
    // 插件视图兜底（面板 + 文本行 + 圆点）
    'view-panel': '<rect x="1.7" y="2.5" width="12.6" height="11" rx="1.1"/><path d="M4.8 6.3h6.4M4.8 9.1h3.7"/><circle cx="12.1" cy="10.9" r="1.4" fill="currentColor" stroke="none"/>',
    // 应用页面（活动栏 ab-app-pages 同款 2×2 方格，20 网格按 0.8 缩到 16 网格）
    'apps': '<rect x="2.6" y="2.9" width="4.3" height="4.3" rx="0.9"/><rect x="9.1" y="2.9" width="4.3" height="4.3" rx="0.9"/><rect x="2.6" y="9" width="4.3" height="4.3" rx="0.9"/><rect x="9.1" y="9" width="4.3" height="4.3" rx="0.9"/>',
};

// 注册表整体导出（冻结）：供图标表页/测试枚举展示，业务代码请用 iconSvg()。
export const ICONS = Object.freeze({...rawIcons});

// 遗留映射：旧菜单数据里的 Segoe MDL2 码位 -> 注册表命名图标。
// 2026-11-22 图标收编后本仓 src 已零码位（护栏 test/core/icon-guard.test.mjs 强制），
// 这张表只为外部插件菜单数据的兼容保留；新代码一律直接写命名图标。
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
    'E768': 'play',
    'E71A': 'close',
    'E716': 'sparkles',
    'E7B3': 'terminal',
    'E9D2': 'chart',
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
