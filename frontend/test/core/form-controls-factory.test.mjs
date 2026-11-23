// 表单控件封装的测试 + 「禁止新增裸原生控件」静态防线。
// 规范见 docs/frontend-form-controls.md / AGENTS.md「前端侧」。
//
// BASELINE 是 2026-11-15 的存量快照，按文件记录裸原生控件数：
//   - 新增任何一处裸 <input>/<select>/<textarea> 或 createElement 表单控件都会让计数超基线而失败；
//   - 迁移存量后把对应数字调小，**永远不要调大**；
//   - 新文件里出现裸用法直接失败（基线里没有该文件）。
// 用 `PRINT_FORM_BASELINE=1 node --test test/core/form-controls-factory.test.mjs` 可重新打印当前快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    createSwitch,
    createSelect,
    createInput,
    createTextarea,
    createCheckbox,
} from '../../src/core/form-controls.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 轻量 DOM 桩：工厂只用到 createElement / append / appendChild / setAttribute ----
function fakeEl(tag) {
    return {
        tag,
        className: '',
        children: [],
        attrs: {},
        dataset: {},
        listeners: {},
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        setAttribute(key, value) { this.attrs[key] = String(value); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    };
}
globalThis.document = {
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({textContent: String(text)}),
};

test('createSwitch 生成 .set-switch 三段结构，control 是值真源', () => {
    const {element, control} = createSwitch({id: 'foo-enabled', checked: true});
    assert.equal(element.className, 'set-switch');
    assert.equal(control.type, 'checkbox');
    assert.equal(control.checked, true);
    assert.equal(control.id, 'foo-enabled');
    assert.equal(element.children.length, 3);
    assert.equal(element.children[0], control);
    assert.deepEqual(element.children.slice(1).map((c) => c.className),
        ['set-switch-track', 'set-switch-thumb']);
});

test('createSelect 带 .opt-select 且生成 option', () => {
    const {element, control} = createSelect({
        id: 'foo-scope',
        options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B', selected: true}],
    });
    assert.equal(element, control);
    assert.equal(control.className, 'opt-select');
    assert.equal(control.id, 'foo-scope');
    assert.equal(control.children.length, 2);
    assert.equal(control.children[1].value, 'b');
    assert.equal(control.children[1].textContent, 'B');
    assert.equal(control.children[1].selected, true);
});

test('createInput / createTextarea 带封装 class 且透传常用属性与事件', () => {
    const onChange = () => {};
    const input = createInput({
        id: 'foo-name', type: 'password', placeholder: 'MY_API_KEY',
        spellcheck: false, autocomplete: 'off', onChange,
    });
    assert.equal(input.element, input.control);
    assert.equal(input.control.className, 'dlg-input');
    assert.equal(input.control.type, 'password');
    assert.equal(input.control.placeholder, 'MY_API_KEY');
    assert.equal(input.control.spellcheck, false);
    assert.equal(input.control.autocomplete, 'off');
    assert.deepEqual(input.control.listeners.change, [onChange]);

    const area = createTextarea({id: 'foo-prompt', rows: 5, disabled: true, attrs: {'data-k': 'v'}});
    assert.equal(area.control.className, 'dlg-input ai-settings-textarea');
    assert.equal(area.control.rows, 5);
    assert.equal(area.control.disabled, true);
    assert.equal(area.control.attrs['data-k'], 'v');

    // 存量迁移时显式 className 覆盖默认值，保证各域原有外观零变化
    const legacy = createInput({className: 'ai-settings-input'});
    assert.equal(legacy.control.className, 'ai-settings-input');
});

test('createCheckbox 生成紧凑行内勾选（label 内带文字），control 是值真源', () => {
    const onChange = () => {};
    const {element, control} = createCheckbox({
        id: 'gs-fuzzy-enabled', label: '模糊', checked: true,
        disabled: true, title: '提示', onChange,
    });
    assert.equal(element.className, 'set-check');
    assert.equal(control.type, 'checkbox');
    assert.equal(control.checked, true);
    assert.equal(control.disabled, true);
    assert.equal(control.id, 'gs-fuzzy-enabled');
    assert.equal(element.dataset.tip, '提示');
    assert.equal(element.children[0], control);
    assert.equal(element.children[1].textContent, '模糊');
    assert.deepEqual(control.listeners.change, [onChange]);
});

// ---- 静态防线 ----

// 2026-11-15 存量快照。迁移一处就把对应数字减一；新增一处会让测试失败。
const BASELINE = {
    'index.html': 20,
    'src/ai/settings/ai-manage-dialogs.js': 1,
    'src/ai/tools/ai-mcp-settings.js': 2,
    // phase3 A2 把 ai-takeover 的补丁卡 / ask 卡拆成兄弟模块：4 处裸控件随域迁移
    // （ask-cards 2 + patch-card 2），宿主 11 → 7，总量不变、非新增债务
    'src/ai/chat/ai-ask-cards.js': 2,
    'src/ai/ai-panel.js': 2,
    'src/ai/chat/ai-patch-card.js': 2,
    'src/ai/chat/ai-reminders.js': 4,
    'src/ai/session/ai-session-list.js': 1,
    'src/ai/chat/ai-takeover.js': 7,
    'src/ai/settings/ai-timer.js': 3,
    'src/ai/tools/ai-tool-cards.js': 2,
    'src/editor/editor-browser-tab.js': 1,
    'src/editor/editor-csv-view.js': 1,
    'src/editor/editor-sql-view.js': 2,
    'src/editor/foot-menus.js': 1,
    'src/editor/patch-view.js': 4,
    'src/reading/reading.js': 1,
    'src/settings/settings-pane-envvars.js': 1,
    'src/settings/settings-pane-lang.js': 3,
    'src/settings/settings-pane-plugins.js': 1,
    'src/terminal/terminal-ui.js': 2,
};

function sourceFiles() {
    const out = [join(FRONTEND, 'index.html')];
    const src = join(FRONTEND, 'src');
    for (const rel of readdirSync(src, {recursive: true, encoding: 'utf8'})) {
        const norm = rel.replace(/\\/g, '/');
        if (!norm.endsWith('.js')) continue;
        if (norm === 'core/form-controls.js') continue; // 封装实现本身是唯一例外
        out.push(join(src, rel));
    }
    return out;
}

function countRawControls(text) {
    // 已封装的 .set-switch 结构内部的隐藏 checkbox 不算裸用法
    const cleaned = text.replace(
        /<label[^>]*class="[^"]*set-switch[^"]*"[^>]*>[\s\S]*?<\/label>/g, '',
    );
    let count = 0;
    for (const m of cleaned.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
        if (/\bclass=/.test(m[0])) continue; // 带封装 class 的静态写法是合规的
        count++;
    }
    for (const _m of cleaned.matchAll(/createElement\(\s*['"](?:input|select|textarea)['"]\s*\)/gi)) {
        count++;
    }
    return count;
}

function scan() {
    const counts = {};
    for (const file of sourceFiles()) {
        const n = countRawControls(readFileSync(file, 'utf8'));
        if (n > 0) counts[relative(FRONTEND, file).replace(/\\/g, '/')] = n;
    }
    return counts;
}

const snapshot = scan();
if (process.env.PRINT_FORM_BASELINE === '1') {
    console.log('CURRENT_RAW_CONTROL_COUNTS=' + JSON.stringify(snapshot, null, 2));
}

// 防止扫描器本身空转（module-scope 扫描器曾因正则漏匹配长期假绿）
test('扫描器自测：抓得到裸控件、放得过封装结构', () => {
    assert.equal(countRawControls('<input type="checkbox">'), 1);
    assert.equal(countRawControls('<select><option>x</option></select>'), 1);
    assert.equal(countRawControls('<textarea></textarea>'), 1);
    assert.equal(countRawControls("document.createElement('select')"), 1);
    assert.equal(countRawControls('<input class="dlg-input" type="text">'), 0);
    assert.equal(countRawControls('<label class="set-switch"><input type="checkbox"></label>'), 0);
    assert.equal(countRawControls("const el = document.createElement('div');"), 0);
});

test('禁止新增裸原生表单控件（按文件基线，只许减不许增）', () => {
    for (const [file, count] of Object.entries(snapshot)) {
        const base = BASELINE[file];
        assert.ok(base !== undefined,
            `新文件 ${file} 出现 ${count} 处裸原生控件；请改用 core/form-controls.js 工厂或静态封装结构`);
        assert.ok(count <= base,
            `${file} 的裸原生控件从 ${base} 增到 ${count}；新增 UI 一律用封装（迁移存量后把基线调小）`);
    }
});
