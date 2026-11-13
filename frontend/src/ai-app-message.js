// 应用消息的通用元数据与图标：AI 面板里的「应用消息」卡片由任何功能复用，
// 调用方只需给 {kind, label, icon?, content}，不必自己拼消息结构或图标。
import {ICONS} from './icons.js';

// kind -> 默认图标；未登记或未知 kind 一律回落到 info。
export const APP_MESSAGE_ICONS = {
    git: 'git',
    schedule: 'clock',
    browser: 'camera',
    app: 'camera',
    notice: 'info',
    update: 'refresh',
    plugin: 'agents',
    error: 'warn',
};

export function normalizeAppMessage(raw) {
    const app = raw && typeof raw === 'object' ? raw : {};
    const kind = String(app.kind == null ? '' : app.kind).trim().slice(0, 32);
    const label = String(app.label == null ? '' : app.label).trim().slice(0, 80);
    const icon = String(app.icon == null ? '' : app.icon).trim().slice(0, 32);
    return {kind, label: label || '应用消息', icon};
}

export function appMessageIcon(app) {
    const custom = String((app && app.icon) || '').trim();
    if (custom && ICONS[custom]) return custom;
    return APP_MESSAGE_ICONS[String((app && app.kind) || '').trim()] || 'info';
}

// 旧会话没有 app 元数据时，按注入指令的固定前缀识别应用消息。
export function detectAppMessage(content) {
    const text = String(content || '').trim();
    const git = text.match(/^［Git 快捷操作 · ([^］]+)］/);
    if (git) return {kind: 'git', label: 'Git 快捷操作 · ' + git[1].trim(), icon: ''};
    const scheduled = text.match(/^\[定时任务 · ([^\]]+)\]/);
    if (scheduled) return {kind: 'schedule', label: '定时任务 · ' + scheduled[1].trim(), icon: ''};
    if (/^\[浏览器截图（browser_screenshot 工具自动附加）\]/.test(text)) {
        return {kind: 'browser', label: '浏览器截图', icon: 'camera'};
    }
    return null;
}
