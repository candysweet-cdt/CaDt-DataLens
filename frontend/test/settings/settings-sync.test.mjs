// settings-sync 纯逻辑测试：跨窗口设置同步的原地合并语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSettingsInto, stripPerWindowLayout, PER_WINDOW_LAYOUT_KEYS} from '../../src/settings/settings-sync.js';

test('mergeSettingsInto：原地合并，保持持有者引用有效', () => {
    const settings = {aiCognition: false, theme: 'dark', nested: {a: 1}};
    const heldRef = settings; // 模拟 ai-panel.js:327 `const settings = opts.settings`
    const changed = mergeSettingsInto(settings, {aiCognition: true, theme: 'dark', added: 42});
    assert.deepEqual(changed.sort(), ['added', 'aiCognition']);
    assert.equal(settings, heldRef, '引用不能被替换');
    assert.equal(heldRef.aiCognition, true, '持有者必须读到新值——这是修复的核心');
    assert.equal(heldRef.added, 42);
    assert.equal(heldRef.theme, 'dark');
});

test('mergeSettingsInto：同值不写入，返回空变更列表（幂等回声）', () => {
    const settings = {aiCognition: true, theme: 'dark'};
    const changed = mergeSettingsInto(settings, {aiCognition: true, theme: 'dark'});
    assert.deepEqual(changed, []);
});

test('mergeSettingsInto：畸形快照被忽略', () => {
    for (const bad of [null, undefined, 'x', 42, ['a']]) {
        const settings = {aiCognition: false};
        assert.deepEqual(mergeSettingsInto(settings, bad), [], 'bad=' + String(bad));
        assert.equal(settings.aiCognition, false);
    }
});

test('mergeSettingsInto：目标非对象时安全返回', () => {
    assert.deepEqual(mergeSettingsInto(null, {a: 1}), []);
    assert.deepEqual(mergeSettingsInto('x', {a: 1}), []);
});

test('mergeSettingsInto：嵌套对象是整体替换（设置快照为全量，符合预期）', () => {
    const settings = {formatSettings: {json: {view: 'tree'}}};
    const newObj = {json: {view: 'code'}};
    mergeSettingsInto(settings, {formatSettings: newObj});
    assert.equal(settings.formatSettings, newObj);
});

test('mergeSettingsInto：内容相同的对象/数组键不算变更（回声幂等，防多窗闪烁）', () => {
    // 快照永远是 JSON.parse 的深拷贝：对象键引用必然不同，按 Object.is 会永远「有变更」，
    // 导致每次广播接收方 + 发送方回声都全量 applySettings（历史成因见 settings-ui.js applyAlwaysOnTop）。
    const settings = {
        runArgs: {'a.go': '-v'},
        runProfiles: [{name: 'dev', cwd: 'file'}],
        formatSettings: {json: {view: 'tree', indent: '2'}},
        langEnv: {},
    };
    const snapshot = JSON.parse(JSON.stringify(settings)); // 模拟广播 payload
    const changed = mergeSettingsInto(settings, snapshot);
    assert.deepEqual(changed, [], '内容没变不得报变更');
    assert.equal(settings.runArgs === snapshot.runArgs, false, 'target 侧引用应原样保留');
});

test('mergeSettingsInto：对象键序无关、数组序敏感', () => {
    const settings = {runArgs: {a: 1, b: 2}};
    assert.deepEqual(mergeSettingsInto(settings, {runArgs: {b: 2, a: 1}}), [], '键序不同不算变更');
    assert.deepEqual(mergeSettingsInto(settings, {runArgs: {a: 1, b: 3}}), ['runArgs'], '值不同必须报变更');
    const withArr = {runProfiles: [1, 2, 3]};
    assert.deepEqual(mergeSettingsInto(withArr, {runProfiles: [1, 2, 3]}), [], '数组同内容不算变更');
    assert.deepEqual(mergeSettingsInto(withArr, {runProfiles: [1, 3, 2]}), ['runProfiles'], '数组不同序是变更');
});

test('mergeSettingsInto：深层嵌套差异能检出（formatSettings.json.view）', () => {
    const settings = {formatSettings: {json: {view: 'tree'}, csv: {view: 'table'}}};
    const snapshot = {formatSettings: {json: {view: 'tree'}, csv: {view: 'table'}}};
    assert.deepEqual(mergeSettingsInto(settings, snapshot), [], '全等嵌套不算变更');
    const snapshot2 = {formatSettings: {json: {view: 'tree'}, csv: {view: 'raw'}}};
    assert.deepEqual(mergeSettingsInto(settings, snapshot2), ['formatSettings'], '深层差异要检出');
});

test('mergeSettingsInto：非 plain 对象不同引用一律视为变更（不做假相等）', () => {
    const settings = {weird: new Date(0)};
    assert.deepEqual(mergeSettingsInto(settings, {weird: new Date(0)}), ['weird']);
    assert.deepEqual(mergeSettingsInto(settings, {weird: null}), ['weird']);
    assert.deepEqual(mergeSettingsInto(settings, {weird: 1}), ['weird']);
});

test('stripPerWindowLayout：剥掉布局键、保留数据键、不改入参', () => {
    const snapshot = {
        showSidebar: true, sidebarView: 'git', sidebarMode: 'list', sidebarWidth: 300,
        terminalHeight: 400, gitCommitAreaHeight: 120,
        aiPanelOpen: true, aiPanelWidth: 500, aiPanelSide: 'left', aiFloatMode: 'float',
        splitRatio: 0.7,
        alwaysOnTop: true, writingMode: true, runActiveProfile: 'p1',
        windowMode: 'multi',
        theme: 'light', editorFont: 15, aiCognition: true,
    };
    const out = stripPerWindowLayout(snapshot);
    for (const key of PER_WINDOW_LAYOUT_KEYS) {
        assert.ok(!(key in out), '布局键必须被剥掉：' + key);
    }
    assert.equal(out.theme, 'light');
    assert.equal(out.editorFont, 15);
    assert.equal(out.aiCognition, true);
    assert.ok('showSidebar' in snapshot, '入参不得被修改（浅拷贝）');
});

test('stripPerWindowLayout：畸形输入原样返回', () => {
    assert.equal(stripPerWindowLayout(null), null);
    assert.equal(stripPerWindowLayout('x'), 'x');
    assert.deepEqual(stripPerWindowLayout([1, 2]), [1, 2]);
});

test('合并语义：带布局键的快照不改动本窗布局（点侧边栏 icon 不镜像到别的窗口）', () => {
    const settings = {showSidebar: true, sidebarView: 'files', theme: 'dark'};
    // 模拟窗口 A 的广播 payload：A 切到 git 视图并收起侧栏，主题同步改了
    const payload = JSON.parse(JSON.stringify({showSidebar: false, sidebarView: 'git', theme: 'light'}));
    const changed = mergeSettingsInto(settings, stripPerWindowLayout(payload));
    assert.deepEqual(changed, ['theme'], '只有数据键参与合并');
    assert.equal(settings.showSidebar, true, '本窗侧栏显隐不被远端覆盖');
    assert.equal(settings.sidebarView, 'files', '本窗侧栏视图不被远端覆盖');
});
