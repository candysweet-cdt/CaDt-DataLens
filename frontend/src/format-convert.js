// format-convert.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// ---- 格式互转 + JSON 修复 ----
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {formats} from './formats.js';
import {repairJson} from './jsonrepair.js';

export function createFormatConvert(deps) {


const CONVERT_TARGET_LABELS = {json: 'JSON', yaml: 'YAML', toml: 'TOML', jsonl: 'JSONL', csv: 'CSV', xml: 'XML'};
const CONVERT_EXT = {json: '.json', yaml: '.yaml', toml: '.toml', jsonl: '.jsonl', csv: '.csv', xml: '.xml'};

function convertTargetsFor(sourceId) {
    const table = {
        json: ['yaml', 'toml', 'jsonl', 'csv', 'xml'],
        yaml: ['json', 'toml', 'jsonl', 'csv'],
        toml: ['json', 'yaml', 'csv'],
        jsonl: ['json', 'yaml', 'csv'],
        csv: ['json', 'yaml'],
        xml: ['json', 'yaml'],
    };
    return (table[sourceId] || []).filter((tid) => formats[tid] && formats[tid].stringify);
}

async function convertCurrentTo(targetId) {
    if (!deps.file || !deps.file.editor || !deps.file.format) return;
    const target = formats[targetId];
    if (!target || !target.stringify) return;
    const text = deps.file.editor.getText();
    let value;
    try {
        value = deps.file.format.parse(text);
    } catch (e) {
        deps.flash('当前内容解析失败：' + e.message, true);
        return;
    }
    if (targetId === 'jsonl' && !Array.isArray(value)) value = [value];
    let out;
    try {
        out = target.stringify(value);
    } catch (e) {
        deps.flash('转换失败：' + e.message, true);
        return;
    }
    const base = deps.baseNameOf(deps.file.path || deps.file.name || '未命名');
    const stem = base.replace(/\.[^.]+$/, '') || '转换结果';
    let destPath = '';
    try {
        destPath = await deps.backend.SaveFileDialog(stem + (CONVERT_EXT[targetId] || '.txt'));
    } catch (e) {
        return;
    }
    if (!destPath) return;
    try {
        await deps.backend.SaveFile(destPath, out, '', false, 'utf-8');
    } catch (e) {
        deps.flash('保存失败：' + e.message, true);
        return;
    }
    await deps.openPath(destPath);
    deps.flash('已转换为 ' + (CONVERT_TARGET_LABELS[targetId] || targetId) + '：' + deps.baseNameOf(destPath));
}

function convertMenuItems() {
    const id = deps.file && deps.file.format ? deps.file.format.id : '';
    const targets = convertTargetsFor(id);
    if (!targets.length) return [{label: '当前格式不支持转换', disabled: true}];
    return targets.map((tid) => ({
        label: (CONVERT_TARGET_LABELS[tid] || tid) + '（另存为新文件）',
        action: () => convertCurrentTo(tid),
    }));
}

function repairJsonAction() {
    if (!deps.file || !deps.file.editor) return;
    const text = deps.file.editor.getText();
    let invalid = null;
    try {
        JSON.parse(text);
    } catch (e) {
        invalid = e;
    }
    if (!invalid) {
        deps.flash('JSON 本身有效，无需修复');
        return;
    }
    const result = repairJson(text);
    if (!result.ok) {
        deps.flash('无法自动修复（' + (invalid.message || '解析失败') + '），请手动处理', true);
        return;
    }
    deps.file.editor.setText(result.text);
    deps.file.text = result.text;
    deps.flash('已修复 ' + (result.fixes.length ? '：' + result.fixes.join('、') : ''));
}


    return {convertCurrentTo, convertMenuItems, repairJsonAction};
}
