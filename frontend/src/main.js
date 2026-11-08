import 'katex/dist/katex.min.css';
import './style.css';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import markdownItKatex from '@vscode/markdown-it-katex';
import {aceModeFor, detectFormat, formats, isSupportedFile} from './formats.js';
import {createExplorer} from './explorer.js';
import {createContextMenu} from './contextmenu.js';
import {createFileIcon, fileIconSpec} from './fileicons.js';

const UNLOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.6A2.4 2.4 0 0 1 10.8 4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="10.4" r="1" fill="currentColor"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.6A2 2 0 0 1 10 5.6V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="10.4" r="1" fill="currentColor"/></svg>';

const hasWails = !!(window.go && window.go.main && window.go.main.App);

const sampleJson = `{
  "name": "时空纪元",
  "version": "1.0.0",
  "enabled": true,
  "count": 42,
  "nothing": null,
  "tags": ["模组", "网易", "JSON"],
  "author": {"name": "CandySweet", "role": "owner"},
  "items": [{"id": "spacetime:cable", "count": 64}, {"id": "spacetime:machine", "count": 1}]
}`;

const sampleYaml = `name: 时空纪元
version: 1.0.0
enabled: true
tags:
  - 模组
  - 网易
author:
  name: CandySweet
  role: owner
`;

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<mod name="时空纪元" version="1.0.0">
  <items>
    <item id="spacetime:cable" count="64"/>
    <item id="spacetime:machine" count="1"/>
  </items>
</mod>
`;

const sampleCsv = `id,name,count
spacetime:cable,线缆,64
spacetime:machine,机器,1
`;

const sampleText = `# 时空纪元 开发笔记

- 电缆：每格每日 4 件
- 机器：2.10+ 运行时配方
`;

const sampleToml = `title = "时空纪元"
version = "1.0.0"
enabled = true

[server]
host = "127.0.0.1"
port = 8080
tags = ["模组", "网易"]

[limits]
maxPlayers = 16
`;
const sampleIni = `; 示例配置
[general]
name=时空纪元
version=1.0.0
enabled=true

[server]
host=127.0.0.1
port=8080
`;
const sampleJsonl = `{"id":"spacetime:cable","name":"线缆","count":64,"tags":["物流","能源"]}
{"id":"spacetime:machine","name":"机器","count":1,"meta":{"tier":2,"multiblock":true}}
{"id":"spacetime:tank","name":"储罐","count":4,"meta":{"tier":1,"capacity":8000}}
`;

const mockScenario = new URLSearchParams(location.search);
const mockDir = 'mock://samples/';
const mockHex = '00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|';
const mockImageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAAFjUlEQVR42u3dS0jU+wLA8d84MyTOpmUGRZALD4ExdKiF0CJ6bjwJQQWRVJyKmlUrF+VkT6KzyejdQiuTooVBYkJUKwOppANigtCDCFq0qLB8ztzFXOaGo3O4J7r3lJ/Paob/7zH68zv/mZWR3/7IhqJ6zy6a7lJpPFp87vDYxHSXknv67Gtf+37jviUB+GEJGAQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAcPPJPYjvuhffv/z+y2e3NP3f/mh7PtP2Lf/UpU7MCBg4Kf8CJ032PKrI+TbVdQ9dgcGBAwIGAQMCBgQMCBgEDAgYEDAIGBAwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwMAP/s/NvoeVK1euXr36y5cvw8PDFy9efP/+feGY1tbWwcHBbDYbi8Xu3bv38OHDEML69evb29v/ctgkhbNyWlpa6urqHAcC/i9UVVVVV1fv379/dHQ0mUymUqnGxsbCYePj4+l0OoQwa9as+vr6kZGRR48e1dbWTkpxymGTliqcBQL+m2pqatra2kZHR0MIvb29S5cujUajc+fO3blzZyKRuH///p07d74ePzIycvXq1W3bts2fP7+0tPTAgQOHDx8uXDY/7M2bN18vtXHjxtys5ubm6bbISSQSO3bsmD17diwWu3LlyuDgYO4ufffu3crKykQicfPmzZ6ennXr1q1YsSKbzba2tj579syB+g48s8ybN+/Fixf5pxcuXJiYmFi7du3169cbGhpqamoKp7x69aq8vPzGjRvDw8NT1vv1sElL5WcV3yKEsHXr1s7OzkOHDjU1Ne3atevf776x2KdPn9Lp9MmTJ7dv3x5C2LBhQ0NDw6lTp5YvX+403YFn3vtZyRTvaNeuXauurl6yZElZWVnh1Wg0Oj4+nn+6efPmysrKjo6Onp6ewmHTLVV8ixDC4sWL58yZk3tcWlpaUlKSyWQikciDBw9CCO/evctNfPr0aSqV6urqOn36tNN0B55x3r59u2DBgtzjSCSSSqVCCPv27QshdHZ2ZjKZwikVFRWvX7/OP21ra0un05PqzQ+bbqniW+T6P3LkSDqdPnjw4Llz53LDxsfHh4aGcgOy2WwI4cyZMx0dHWvWrNm7d6/TFPCM09XVtWnTpng8HkKorq7OPVi4cGF3d3c8Hs89nfTVdMuWLbdv384FH4lEplw2P6xwqdysIlvkPH/+fNmyZSGEZDJZW1v7dbR5ZWVljY2NAwMDTU1NyWTSafoIPeN0d3eXl5efOHHi48ePHz58uHz5cq7qo0ePvnz5cmhoKB6Pj42NxWKxxsbGbDYbjUbb29v7+vpCCP39/fX19cePH//PL7dgWOFSuVlTbpH/Rj0wMNDc3Lx79+5Vq1ZlMpnz589P+eI/f/785MmTY8eOlZSU3Lp1y2nOBJHf/sgWH9F7dtF0l0rj0eJzh8cmpruU3NP3t/fNzx1s+dUR8u0q6h7nHvRfqvrf/z1/S0c+QoPvwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwICAQcCAgAEBg4ABAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgOEnFPuhX31F3WNHiDswIGDAR+i/1H+pqviA4bGJ6S4l9/QVn9t7dtF0l0rjUfvO5H3dgQEBAwIGAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwIGAQMCBgQMAgYEDDwXf0LSiE2qQDYwMoAAAAASUVORK5CYII=';
const mockFiles = {
    yaml: {name: 'sample.yaml', content: sampleYaml},
    xml: {name: 'sample.xml', content: sampleXml},
    csv: {name: 'sample.csv', content: sampleCsv},
    text: {name: 'notes.md', content: sampleText},
    json: {name: 'sample.json', content: sampleJson},
    jsonl: {name: 'sample.jsonl', content: sampleJsonl},
    toml: {name: 'sample.toml', content: sampleToml},
    ini: {name: 'sample.ini', content: sampleIni},
};
const mockTree = {
    'mock://samples': [
        {name: 'config', path: 'mock://samples/config', isDir: true},
        {name: 'images', path: 'mock://samples/images', isDir: true},
        {name: 'notes.md', path: 'mock://samples/notes.md', isDir: false},
        {name: 'sample.csv', path: 'mock://samples/sample.csv', isDir: false},
        {name: 'sample.json', path: 'mock://samples/sample.json', isDir: false},
        {name: 'sample.jsonl', path: 'mock://samples/sample.jsonl', isDir: false},
        {name: 'sample.toml', path: 'mock://samples/sample.toml', isDir: false},
        {name: 'sample.ini', path: 'mock://samples/sample.ini', isDir: false},
        {name: 'sample.png', path: 'mock://samples/sample.png', isDir: false},
        {name: 'sample.xml', path: 'mock://samples/sample.xml', isDir: false},
        {name: 'sample.yaml', path: 'mock://samples/sample.yaml', isDir: false},
        {name: 'secrets.bin', path: 'mock://samples/secrets.bin', isDir: false},
    ],
    'mock://samples/config': [
        {name: 'deep_well.json', path: 'mock://samples/config/deep_well.json', isDir: false},
        {name: 'nested.yaml', path: 'mock://samples/config/nested.yaml', isDir: false},
        {name: 'readme.txt', path: 'mock://samples/config/readme.txt', isDir: false},
    ],
    'mock://samples/images': [
        {name: 'logo.png', path: 'mock://samples/images/logo.png', isDir: false},
        {name: 'preview.jpg', path: 'mock://samples/images/preview.jpg', isDir: false},
    ],
};

function mockFindEntry(path) {
    for (const entries of Object.values(mockTree)) {
        const index = entries.findIndex((entry) => entry.path === path);
        if (index >= 0) return {entries, index, entry: entries[index]};
    }
    return null;
}

function mockPasteNode(entry, destDir, name) {
    const target = destDir + '/' + name;
    mockTree[destDir].push({name, path: target, isDir: !!entry.isDir});
    if (entry.isDir) {
        mockTree[target] = [];
        for (const child of (mockTree[entry.path] || []).slice()) {
            mockPasteNode(child, target, child.name);
        }
    } else if (window.__mockCreated && window.__mockCreated[entry.path]) {
        window.__mockCreated[target] = true;
    }
    return target;
}

function mockDropPath(path) {
    const found = mockFindEntry(path);
    if (found) found.entries.splice(found.index, 1);
    for (const key of Object.keys(mockTree)) {
        if (key === path || key.startsWith(path + '/')) delete mockTree[key];
    }
    if (window.__mockCreated) {
        for (const key of Object.keys(window.__mockCreated)) {
            if (key === path || key.startsWith(path + '/')) {
                delete window.__mockCreated[key];
            }
        }
    }
}

const mockBackend = {
    async GetStartupFiles() {
        if (mockScenario.has('empty')) return [];
        if (mockScenario.has('gbk')) return [mockDir + 'sample-gbk.json'];
        if (mockScenario.has('image')) return [mockDir + 'sample.png'];
        if (mockScenario.has('large')) return [mockDir + 'large.json'];
        if (mockScenario.has('invalid')) return [mockDir + 'invalid.json'];
        for (const key of ['yaml', 'xml', 'csv', 'text', 'jsonl', 'toml', 'ini']) {
            if (mockScenario.has(key)) return [mockDir + mockFiles[key].name];
        }
        return [mockDir + 'sample.json'];
    },
    async GetStartupTargets() {
        if (mockScenario.has('line')) return [{path: mockDir + 'sample.json', line: 5, column: 3}];
        const files = await this.GetStartupFiles();
        return files.map((path) => ({path, line: 0, column: 0}));
    },
    async OpenFile(path, enc) {
        window.__mockLastOpenEnc = enc;
        const dirKey = String(path || '').replace(/\/+$/, '');
        if (mockTree[dirKey]) {
            return {path: dirKey, name: dirKey.split('/').pop(), isDir: true};
        }
        const base = path.split('/').pop();
        if (window.__mockCreated && window.__mockCreated[path]) {
            return {path, name: base, content: '', size: 0, eol: 'lf', hasBom: false, large: false, enc: 'utf-8'};
        }
        if (base.toLowerCase().endsWith('.png')) {
            return {path, name: base, content: mockHex, size: 16, eol: 'lf', hasBom: false, large: false, enc: 'binary', binary: true, image: true};
        }
        const fileEnc = path.includes('gbk') ? 'gbk' : 'utf-8';
        const ext = (base.split('.').pop() || '').toLowerCase();
        const byExt = ['yaml', 'yml'].includes(ext) ? 'yaml'
            : ['xml', 'svg'].includes(ext) ? 'xml'
                : ['csv', 'tsv'].includes(ext) ? 'csv'
                    : ['jsonl', 'ndjson'].includes(ext) ? 'jsonl'
                        : ext === 'toml' ? 'toml'
                            : ['ini', 'properties', 'cfg'].includes(ext) ? 'ini'
                                : ['md', 'txt', 'log'].includes(ext) ? 'text' : 'json';
        const key = Object.keys(mockFiles).find(k => mockFiles[k].name === base) || byExt;
        let content = mockFiles[key].content;
        let large = false;
        if (path.includes('large')) large = true;
        if (path.includes('invalid')) content = '{ "broken": [1, 2, ';
        return {
            path, name: base, content,
            size: content.length, eol: 'lf', hasBom: false, large, enc: fileEnc,
        };
    },
    async OpenFilesDialog() {
        if (mockScenario.has('multi')) return [mockDir + 'sample.json', mockDir + 'sample.yaml'];
        return [mockDir + 'sample.json'];
    },
    async OpenFolderDialog() { return 'mock://samples'; },
    async ReadDir(path, limit) {
        const key = String(path || '').replace(/\/+$/, '');
        let entries = mockTree[key];
        if (!entries) throw new Error('目录不存在');
        if (mockScenario.has('many') && key === 'mock://samples') {
            const many = Array.from({length: 240}, (_, i) => {
                const name = 'data-' + String(i + 1).padStart(3, '0') + '.json';
                return {name, path: 'mock://samples/' + name, isDir: false};
            });
            entries = entries.concat(many);
        }
        const cap = limit > 0 ? limit : 1000;
        return {entries: entries.slice(0, cap), truncated: entries.length > cap};
    },
    async CreateEntry(dir, name, isDir) {
        const key = String(dir || '').replace(/\/+$/, '');
        const entries = mockTree[key];
        if (!entries) throw new Error('目录不存在');
        const clean = String(name || '').trim();
        if (!clean) throw new Error('名称不能为空');
        if (/[\\/]/.test(clean)) throw new Error('名称不能包含路径分隔符');
        if (entries.some((e) => e.name.toLowerCase() === clean.toLowerCase())) throw new Error('“' + clean + '”已存在');
        const path = key + '/' + clean;
        entries.push({name: clean, path, isDir: !!isDir});
        if (isDir) mockTree[path] = [];
        else (window.__mockCreated || (window.__mockCreated = {}))[path] = true;
        return path;
    },
    async RenameEntry(path, newName) {
        const clean = String(newName || '').trim();
        if (!clean) throw new Error('名称不能为空');
        if (/[\\/]/.test(clean)) throw new Error('名称不能包含路径分隔符');
        const slash = path.lastIndexOf('/');
        const parent = path.slice(0, slash);
        const entries = mockTree[parent];
        if (!entries) throw new Error('目录不存在');
        const index = entries.findIndex((e) => e.path === path);
        if (index < 0) throw new Error('文件不存在');
        if (entries[index].name === clean) return path;
        if (entries.some((e) => e.path !== path && e.name.toLowerCase() === clean.toLowerCase())) {
            throw new Error('“' + clean + '”已存在');
        }
        const target = parent + '/' + clean;
        const wasDir = entries[index].isDir;
        entries[index] = {name: clean, path: target, isDir: wasDir};
        if (wasDir) {
            const moved = {};
            for (const [key, value] of Object.entries(mockTree)) {
                if (key !== path && !key.startsWith(path + '/')) continue;
                moved[target + key.slice(path.length)] = value.map((entry) => ({
                    ...entry,
                    path: target + entry.path.slice(path.length),
                }));
                delete mockTree[key];
            }
            Object.assign(mockTree, moved);
        }
        if (window.__mockCreated && window.__mockCreated[path]) {
            window.__mockCreated[target] = true;
            delete window.__mockCreated[path];
        }
        return target;
    },
    async SuggestCopyName(dir, name, isDir) {
        const key = String(dir || '').replace(/\/+$/, '');
        const entries = mockTree[key];
        if (!entries) throw new Error('目录不存在');
        if (!entries.some((e) => e.name.toLowerCase() === String(name).toLowerCase())) return name;
        let stem = name;
        let ext = '';
        if (!isDir) {
            const dot = name.lastIndexOf('.');
            if (dot > 0) {
                stem = name.slice(0, dot);
                ext = name.slice(dot);
            }
        }
        for (let i = 1; i <= 500; i++) {
            const candidate = stem + (i === 1 ? ' - 副本' : ' - 副本 ' + i) + ext;
            if (!entries.some((e) => e.name.toLowerCase() === candidate.toLowerCase())) return candidate;
        }
        throw new Error('无法生成可用的名称');
    },
    async CopyEntry(src, destDir, name) {
        const key = String(destDir || '').replace(/\/+$/, '');
        if (!mockTree[key]) throw new Error('目录不存在');
        const found = mockFindEntry(src);
        if (!found) throw new Error('源文件不存在');
        if (mockTree[key].some((e) => e.name.toLowerCase() === String(name).toLowerCase())) throw new Error('“' + name + '”已存在');
        return mockPasteNode(found.entry, key, name);
    },
    async MoveEntry(src, destDir, name) {
        const key = String(destDir || '').replace(/\/+$/, '');
        if (!mockTree[key]) throw new Error('目录不存在');
        const found = mockFindEntry(src);
        if (!found) throw new Error('源文件不存在');
        if (mockTree[key].some((e) => e.name.toLowerCase() === String(name).toLowerCase())) throw new Error('“' + name + '”已存在');
        const target = mockPasteNode(found.entry, key, name);
        mockDropPath(src);
        return target;
    },
    async ReadImageDataURL() { return mockImageDataUrl; },
    async SaveFileDialog(name) { return 'mock://' + (window.__mockSaveDialogName || name); },
    async SaveFile(path, content, eol, hasBom, enc) {
        window.__mockLastSaveEnc = enc;
        window.__mockLastSavePath = path;
        window.__mockSaves = (window.__mockSaves || []).concat([{path, content, eol, hasBom, enc}]);
        localStorage.setItem('datalens-mock-save', content);
        console.info('[mock] SaveFile', path, content.length, 'chars', enc);
    },
    async SetDirty(flag) { console.info('[mock] SetDirty', flag); },
    async SetWindowBg(r, g, b) { window.__mockWindowBg = [r, g, b]; },
    async GetOpenMode() {
        if (!window.__mockOpenMode) window.__mockOpenMode = 'tab';
        return window.__mockOpenMode;
    },
    async SetOpenMode(mode) { window.__mockOpenMode = mode; },
    async GetIntegrationStatus() {
        if (!window.__mockIntegration) {
            window.__mockIntegration = {fileAssoc: false, contextMenu: false};
        }
        return {
            executable: 'D:\\Tools\\CaDt-DataLens.exe',
            fileAssoc: !!window.__mockIntegration.fileAssoc,
            contextMenu: !!window.__mockIntegration.contextMenu,
        };
    },
    async SetFileAssociation(enabled) {
        if (!window.__mockIntegration) {
            window.__mockIntegration = {fileAssoc: false, contextMenu: false};
        }
        window.__mockIntegration.fileAssoc = !!enabled;
    },
    async SetContextMenu(enabled) {
        if (!window.__mockIntegration) {
            window.__mockIntegration = {fileAssoc: false, contextMenu: false};
        }
        window.__mockIntegration.contextMenu = !!enabled;
    },
    async OpenInNewWindows(paths) { window.__mockNewWindows = (window.__mockNewWindows || []).concat([paths]); },
    async OpenNewWindow() { window.__mockNewWindow = (window.__mockNewWindow || 0) + 1; },
    async ShowInFolder(path) { window.__mockShowInFolder = path; },
    async CopyText(text) { window.__mockCopied = text; window.__mockClipboard = text; },
    async GetClipboardText() { return window.__mockClipboard || ''; },
    async ForceClose() { window.__mockForceClosed = (window.__mockForceClosed || 0) + 1; },
    async CheckEncoding(content, enc) {
        if (enc === 'utf-8' || enc === 'gbk' || enc === 'gb18030') return true;
        if (enc === 'us-ascii') return !/[^\x00-\x7f]/.test(content);
        if (enc === 'iso-8859-1') return !/[^\x00-\xff]/.test(content);
        return true;
    },
};

const backend = hasWails ? window.go.main.App : mockBackend;


const mockRt = {
    _max: false,
    _calls: [],
    async WindowIsMaximised() { return this._max; },
    WindowToggleMaximise() { this._max = !this._max; this._calls.push('toggle:' + this._max); },
    WindowMinimise() { this._calls.push('min'); },
    WindowUnminimise() { this._calls.push('unmin'); },
    WindowClose() { this._calls.push('close'); },
    Quit() { this._calls.push('quit'); },
    WindowSetTitle(title) { this._title = title; this._calls.push('title:' + title); },
    BrowserOpenURL(url) { window.__mockOpenUrl = url; this._calls.push('url:' + url); },
    EventsOn() {},
};
const rt = window.runtime || (mockScenario.has('winctl') ? mockRt : null);

const els = {
    filename: document.getElementById('filename'),
    filenameIcon: document.getElementById('filename-icon'),
    filenameText: document.getElementById('filename-text'),
    banner: document.getElementById('banner'),
    bannerText: document.getElementById('banner-text'),
    bannerClose: document.getElementById('banner-close'),
    editor: document.getElementById('editor'),
    welcome: document.getElementById('welcome'),
    mainPane: document.getElementById('main-pane'),
    btnWelcomeOpen: document.getElementById('btn-welcome-open'),
    stMode: document.getElementById('st-mode'),
    stSize: document.getElementById('st-size'),
    stZoom: document.getElementById('st-zoom'),
    stEol: document.getElementById('st-eol'),
    stEnc: document.getElementById('st-enc'),
    stMessage: document.getElementById('st-message'),
    stDirty: document.getElementById('st-dirty'),
    breadcrumb: document.getElementById('breadcrumb'),
    searchInput: document.getElementById('search-input'),
    tabbar: document.getElementById('tabbar'),
    sidebar: document.getElementById('sidebar'),
    sbBody: document.getElementById('sb-body'),
    sbTitle: document.getElementById('sb-title'),
    sbRefresh: document.getElementById('sb-refresh'),
    sbModeList: document.getElementById('sb-mode-list'),
    sbModeTree: document.getElementById('sb-mode-tree'),
    btnSidebar: document.getElementById('btn-sidebar'),
    lock: document.getElementById('btn-lock'),
    activityBar: document.getElementById('activity-bar'),
    abFiles: document.getElementById('ab-files'),
    abSearch: document.getElementById('ab-search'),
    abMore: document.getElementById('ab-more'),
    abLock: document.getElementById('ab-lock'),
    abTheme: document.getElementById('ab-theme'),
    abSettings: document.getElementById('ab-settings'),
    abAbout: document.getElementById('ab-about'),
};

let editor = null;
let file = null;
let docs = [];
let docSeq = 0;
let autoSaveTimer = 0;
let explorer = null;
let workspaceFolder = null;
let fileClipboard = null;
let ctxMenu = null;
let closedTabs = [];
window.__lens = {
    get editor() { return editor; },
    get file() { return file; },
    get docs() { return docs; },
    get explorer() { return explorer; },
    get closedTabs() { return closedTabs; },
    openCloseConfirm,
    openPaths,
    openTargets,
    openFolderWorkspace,
    reopenClosedTab,
    setTheme,
};
let dirty = false;
let currentMode = 'tree';
let flashTimer = 0;

const settingsKey = 'datalens-settings';
const themes = [
    {id: 'dark', name: '深色', group: 'base', bg: '#1e1f24', accent: '#4f8cff'},
    {id: 'light', name: '浅色', group: 'base', bg: '#ffffff', accent: '#2f6fd0'},
    {id: 'darcula', name: 'Darcula', group: 'idea', bg: '#2b2b2b', accent: '#548af7'},
    {id: 'idea-dark', name: 'IDEA Dark', group: 'idea', bg: '#1e1f22', accent: '#548af7'},
    {id: 'idea-light', name: 'IDEA Light', group: 'idea', bg: '#ffffff', accent: '#3574f0'},
    {id: 'github', name: 'Github', group: 'classic', bg: '#ffffff', accent: '#0969da'},
    {id: 'newsprint', name: 'Newsprint', group: 'classic', bg: '#f7f2e7', accent: '#8a4b2f'},
    {id: 'night', name: 'Night', group: 'classic', bg: '#16181f', accent: '#7aa2f7'},
    {id: 'pixyll', name: 'Pixyll', group: 'classic', bg: '#fdfbf7', accent: '#c24266'},
    {id: 'whitey', name: 'Whitey', group: 'classic', bg: '#ffffff', accent: '#2b6cb0'},
];
const themeIds = new Set(themes.map((t) => t.id));
const uiFonts = [
    {id: 'inter', name: 'Inter', family: '"Inter"'},
    {id: 'system', name: 'Segoe UI', family: '"Segoe UI"'},
];
const editorFonts = [
    {id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono"'},
    {id: 'fira', name: 'Fira Code', family: '"Fira Code"'},
    {id: 'consolas', name: 'Consolas', family: 'Consolas'},
    {id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code"'},
    {id: 'system', name: '系统等宽', family: 'Consolas, "Courier New"'},
];
const cjkFonts = [
    {id: 'auto', name: '跟随设置', family: '"Microsoft YaHei UI", "微软雅黑"'},
    {id: 'dengxian', name: '等线', family: '"DengXian", "等线"'},
    {id: 'simsun', name: '宋体', family: '"SimSun", "宋体"'},
    {id: 'simhei', name: '黑体', family: '"SimHei", "黑体"'},
    {id: 'kaiti', name: '楷体', family: '"KaiTi", "楷体"'},
    {id: 'fangsong', name: '仿宋', family: '"FangSong", "仿宋"'},
    {id: 'jhenghei', name: '微软正黑体', family: '"Microsoft JhengHei UI", "Microsoft JhengHei", "微软正黑体"'},
];
const treeFonts = [
    {id: 'follow', name: '跟随界面字体', family: null},
    ...uiFonts.map((f) => ({id: 'ui-' + f.id, name: f.name, family: f.family})),
    ...editorFonts.map((f) => ({id: 'editor-' + f.id, name: f.name + '（等宽）', family: f.family})),
];
const treeCjkFonts = [
    {id: 'follow', name: '跟随界面中文字体', family: null},
    ...cjkFonts.filter((f) => f.id !== 'auto'),
];
const formatDefs = [
    {id: 'json', name: 'JSON'},
    {id: 'jsonl', name: 'JSONL'},
    {id: 'yaml', name: 'YAML'},
    {id: 'xml', name: 'XML'},
    {id: 'csv', name: 'CSV'},
    {id: 'toml', name: 'TOML'},
    {id: 'ini', name: 'INI/Properties'},
    {id: 'markdown', name: 'Markdown'},
    {id: 'text', name: '纯文本'},
];
function defaultFormatSettings() {
    return Object.fromEntries(formatDefs.map((f) => [f.id, {
        encoding: 'auto',
        indent: '2',
        eol: 'follow',
        view: f.id === 'csv' ? 'table' : f.id === 'markdown' ? 'preview' : f.id === 'text' ? 'code' : 'tree',
    }]));
}
const defaultSettings = {
    fixedKeys: true,
    autoSave: false,
    openMode: 'tab',
    sidebarMode: 'tree',
    showSidebar: false,
    csvTableMigrated: false,
    keyWidth: 160,
    sidebarFont: 12.5,
    editorFont: 13,
    codeWrap: false,
    mdLineNumbers: false,
    showBanners: true,
    readOnlyMode: false,
    theme: 'dark',
    uiFont: 'inter',
    uiCjkFont: 'auto',
    editorFontFamily: 'jetbrains',
    editorCjkFont: 'auto',
    formatSettings: defaultFormatSettings(),
};
let settings = JSON.parse(JSON.stringify(defaultSettings));
try {
    const stored = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    settings = {...settings, ...stored};
    settings.formatSettings = {...defaultFormatSettings(), ...(stored.formatSettings || {})};
    for (const f of formatDefs) {
        settings.formatSettings[f.id] = {...defaultFormatSettings()[f.id], ...(settings.formatSettings[f.id] || {})};
    }
} catch (e) {}
if (!themeIds.has(settings.theme)) settings.theme = 'dark';
if (!uiFonts.some((f) => f.id === settings.uiFont)) settings.uiFont = 'inter';
if (!editorFonts.some((f) => f.id === settings.editorFontFamily)) settings.editorFontFamily = 'jetbrains';
if (!cjkFonts.some((f) => f.id === settings.uiCjkFont)) settings.uiCjkFont = 'auto';
if (!cjkFonts.some((f) => f.id === settings.editorCjkFont)) settings.editorCjkFont = 'auto';
settings.autoSave = !!settings.autoSave;
if (settings.openMode !== 'window') settings.openMode = 'tab';
if (settings.sidebarMode !== 'list') settings.sidebarMode = 'tree';
settings.showSidebar = !!settings.showSidebar;
settings.codeWrap = !!settings.codeWrap;
settings.mdLineNumbers = !!settings.mdLineNumbers;
settings.showBanners = settings.showBanners !== false;
settings.readOnlyMode = !!settings.readOnlyMode;
settings.sidebarFont = Number(settings.sidebarFont);
if (!Number.isFinite(settings.sidebarFont)) settings.sidebarFont = 12.5;
settings.sidebarFont = Math.min(20, Math.max(10, settings.sidebarFont));
if (!settings.csvTableMigrated) {
    settings.formatSettings.csv.view = 'table';
    settings.csvTableMigrated = true;
}
if (!['table', 'tree', 'text'].includes(settings.formatSettings.csv.view)) {
    settings.formatSettings.csv.view = 'table';
}
if (!['preview', 'code', 'text'].includes(settings.formatSettings.markdown.view)) {
    settings.formatSettings.markdown.view = 'preview';
}

function getFormatSettings(id) {
    return settings.formatSettings[id] || defaultFormatSettings()[id] || {encoding: 'auto', indent: '2', eol: 'follow', view: 'tree'};
}

const elsSettings = {
    fixed: document.getElementById('opt-fixed-keys'),
    width: document.getElementById('opt-key-width'),
    widthVal: document.getElementById('opt-key-width-val'),
    font: document.getElementById('opt-font-size'),
    fontVal: document.getElementById('opt-font-size-val'),
    sidebarFont: document.getElementById('opt-sidebar-font'),
    sidebarFontVal: document.getElementById('opt-sidebar-font-val'),
    codeWrap: document.getElementById('opt-code-wrap'),
    mdLineNumbers: document.getElementById('opt-md-line-numbers'),
    showBanners: document.getElementById('opt-show-banners'),
    autoSave: document.getElementById('opt-auto-save'),
    openMode: document.getElementById('opt-open-mode'),
    uiFont: document.getElementById('opt-ui-font'),
    uiCjkFont: document.getElementById('opt-ui-cjk-font'),
    editorFontFamily: document.getElementById('opt-editor-font'),
    editorCjkFont: document.getElementById('opt-editor-cjk-font'),
    fileAssoc: document.getElementById('opt-file-assoc'),
    contextMenu: document.getElementById('opt-context-menu'),
    exePath: document.getElementById('opt-exe-path'),
    refreshIntegration: document.getElementById('opt-refresh-integration'),
};

function fillFontSelect(select, list) {
    select.textContent = '';
    for (const face of list) {
        const opt = document.createElement('option');
        opt.value = face.id;
        opt.textContent = face.name;
        select.appendChild(opt);
    }
}
fillFontSelect(elsSettings.uiFont, uiFonts);
fillFontSelect(elsSettings.uiCjkFont, cjkFonts);
fillFontSelect(elsSettings.editorFontFamily, editorFonts);
fillFontSelect(elsSettings.editorCjkFont, cjkFonts);

const elsDialogs = {
    mask: document.getElementById('dialog-mask'),
    settings: document.getElementById('dlg-settings'),
    confirm: document.getElementById('dlg-confirm'),
    confirmText: document.getElementById('dlg-confirm-text'),
    confirmOk: document.getElementById('btn-discard'),
    name: document.getElementById('dlg-name'),
    nameTitle: document.getElementById('dlg-name-title'),
    nameLabel: document.getElementById('dlg-name-label'),
    nameInput: document.getElementById('dlg-name-input'),
    nameError: document.getElementById('dlg-name-error'),
    nameOk: document.getElementById('btn-name-ok'),
};

let syncedOpenMode = null;
function syncOpenMode() {
    if (syncedOpenMode === null) {
        syncedOpenMode = settings.openMode;
        return;
    }
    if (syncedOpenMode === settings.openMode) return;
    syncedOpenMode = settings.openMode;
    if (backend && backend.SetOpenMode) {
        try {
            backend.SetOpenMode(settings.openMode);
        } catch (e) {}
    }
}

let appliedTheme = '';
function currentTheme() {
    return themes.find((t) => t.id === settings.theme) || themes[0];
}

function applyTheme() {
    if (appliedTheme === settings.theme) return;
    const theme = currentTheme();
    document.documentElement.dataset.theme = theme.id;
    appliedTheme = theme.id;
    if (backend && backend.SetWindowBg) {
        const n = parseInt(theme.bg.slice(1), 16);
        try {
            backend.SetWindowBg((n >> 16) & 255, (n >> 8) & 255, n & 255);
        } catch (e) {}
    }
}

function setTheme(id) {
    if (!themeIds.has(id)) return;
    settings.theme = id;
    applySettings();
    flash('主题：' + currentTheme().name);
}

function applyCodeWrap() {
    for (const doc of docs) {
        const ace = doc && doc.editor && doc.editor.aceEditor;
        if (!ace) continue;
        try {
            ace.getSession().setUseWrapMode(!!settings.codeWrap);
        } catch (e) {}
    }
    if (editor && editor.aceEditor) {
        try {
            editor.aceEditor.resize();
        } catch (e) {}
    }
}

function toggleCodeWrap() {
    settings.codeWrap = !settings.codeWrap;
    applySettings();
    flash('代码视图自动换行：' + (settings.codeWrap ? '开' : '关'));
}

let appliedReadOnly = null;

function updateLockButton() {
    const locked = !!settings.readOnlyMode;
    if (els.lock) {
        els.lock.classList.toggle('locked', locked);
        els.lock.setAttribute('aria-pressed', String(locked));
        els.lock.title = locked ? '解除只读锁定' : '只读锁定';
        els.lock.innerHTML = locked ? LOCK_ICON : UNLOCK_ICON;
    }
    if (els.abLock) {
        els.abLock.classList.toggle('active', locked);
        els.abLock.setAttribute('aria-pressed', String(locked));
        els.abLock.title = locked ? '解除只读锁定' : '只读锁定';
        els.abLock.innerHTML = locked ? LOCK_ICON : UNLOCK_ICON;
    }
}

function installReadOnlyGuards(pane) {
    if (!pane) return;
    const inTreeField = (target) => target && target.closest && target.closest('.jsoneditor-field, .jsoneditor-value');
    pane.addEventListener('beforeinput', (e) => {
        if (!settings.readOnlyMode || !inTreeField(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    pane.addEventListener('keydown', (e) => {
        if (!settings.readOnlyMode || !inTreeField(e.target)) return;
        const key = e.key;
        if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'a', 'A'].includes(key)) return;
        if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    for (const type of ['paste', 'cut', 'drop']) {
        pane.addEventListener(type, (e) => {
            if (!settings.readOnlyMode || !inTreeField(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }
    pane.addEventListener('contextmenu', (e) => {
        if (!settings.readOnlyMode) return;
        if (e.target.closest && e.target.closest('.jsoneditor-tree')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

function applyReadOnlyToDoc(doc) {
    if (!doc || !doc.editor) return;
    const locked = !!settings.readOnlyMode;
    if (doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.setReadOnly(!!(doc.large || doc.binary || locked));
        } catch (e) {}
    }
    if (doc.pane) {
        doc.pane.classList.toggle('app-readonly', locked);
        const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
        if (textarea) textarea.readOnly = locked;
        doc.pane.querySelectorAll('.jsoneditor-tree input, .jsoneditor-tree select').forEach((control) => {
            control.disabled = locked;
        });
        if (doc.format && doc.format.table && doc.tableEl && doc.pane.classList.contains('table-active')) {
            renderCsvTableView(doc);
        }
    }
}

function applyReadOnlyMode() {
    updateLockButton();
    const locked = !!settings.readOnlyMode;
    if (appliedReadOnly === locked) return;
    appliedReadOnly = locked;
    document.documentElement.classList.toggle('app-locked', locked);
    for (const doc of docs) applyReadOnlyToDoc(doc);
    if (file) updateStatus();
    if (locked) cancelAutoSave();
    else if (settings.autoSave && dirty) scheduleAutoSave();
}

function applySettings() {
    document.documentElement.classList.toggle('keycol-natural', !settings.fixedKeys);
    applyTheme();
    document.documentElement.style.setProperty('--key-col-w', settings.keyWidth + 'px');
    elsSettings.fixed.checked = settings.fixedKeys;
    elsSettings.width.value = String(settings.keyWidth);
    elsSettings.width.disabled = !settings.fixedKeys;
    elsSettings.widthVal.textContent = String(settings.keyWidth);
    elsSettings.font.value = String(settings.editorFont);
    elsSettings.fontVal.textContent = String(settings.editorFont);
    elsSettings.sidebarFont.value = String(settings.sidebarFont);
    elsSettings.sidebarFontVal.textContent = String(settings.sidebarFont);
    elsSettings.autoSave.checked = !!settings.autoSave;
    elsSettings.codeWrap.checked = !!settings.codeWrap;
    elsSettings.mdLineNumbers.checked = !!settings.mdLineNumbers;
    elsSettings.showBanners.checked = !!settings.showBanners;
    elsSettings.openMode.value = settings.openMode;
    syncOpenMode();
    document.documentElement.style.setProperty('--editor-font', settings.editorFont + 'px');
    document.documentElement.style.setProperty('--sidebar-font', settings.sidebarFont + 'px');
    const uiFace = uiFonts.find((f) => f.id === settings.uiFont) || uiFonts[0];
    const editorFace = editorFonts.find((f) => f.id === settings.editorFontFamily) || editorFonts[0];
    const uiCjk = cjkFonts.find((f) => f.id === settings.uiCjkFont) || cjkFonts[0];
    const editorCjk = cjkFonts.find((f) => f.id === settings.editorCjkFont) || cjkFonts[0];
    document.documentElement.style.setProperty('--ui-font', uiFace.family + ', ' + uiCjk.family + ', sans-serif');
    document.documentElement.style.setProperty('--editor-font-family', editorFace.family + ', ' + editorCjk.family + ', monospace');
    elsSettings.uiFont.value = uiFace.id;
    elsSettings.uiCjkFont.value = uiCjk.id;
    elsSettings.editorFontFamily.value = editorFace.id;
    elsSettings.editorCjkFont.value = editorCjk.id;
    if (editor && editor.aceEditor) {
        try {
            editor.aceEditor.setFontSize(settings.editorFont);
        } catch (e) {}
    }
    applyCodeWrap();
    applyReadOnlyMode();
    try {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
    } catch (e) {}
    if (settings.autoSave && dirty && !settings.readOnlyMode) scheduleAutoSave();
    else cancelAutoSave();
}

function openDialogEl(dlg) {
    elsDialogs.mask.classList.remove('hidden');
    elsDialogs.settings.classList.add('hidden');
    elsDialogs.confirm.classList.add('hidden');
    elsDialogs.name.classList.add('hidden');
    dlg.style.left = '';
    dlg.style.top = '';
    dlg.style.transform = '';
    dlg.classList.remove('hidden');
}

function closeDialogs() {
    elsDialogs.mask.classList.add('hidden');
    elsDialogs.settings.classList.add('hidden');
    elsDialogs.confirm.classList.add('hidden');
    elsDialogs.name.classList.add('hidden');
    confirmAction = null;
    nameSubmit = null;
    nameBusy = false;
}

function selectSettingsPane(pane) {
    document.querySelectorAll('.snav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
    document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== pane));
}

function openSettings(pane = 'general') {
    openDialogEl(elsDialogs.settings);
    selectSettingsPane(pane);
    if (pane === 'formats') renderFmtTable();
    if (pane === 'integration') syncIntegrationStatus();
}

async function syncIntegrationStatus() {
    if (!elsSettings.fileAssoc) return;
    if (!backend.GetIntegrationStatus) {
        elsSettings.exePath.textContent = '当前版本不支持系统集成';
        return;
    }
    try {
        const status = await backend.GetIntegrationStatus();
        elsSettings.fileAssoc.checked = !!status.fileAssoc;
        elsSettings.contextMenu.checked = !!status.contextMenu;
        elsSettings.exePath.textContent = status.executable || '—';
        elsSettings.exePath.title = status.executable || '';
    } catch (e) {
        flash('读取系统集成状态失败：' + e, true);
    }
}

async function applyIntegration(kind, checkbox, label) {
    const enabled = checkbox.checked;
    if (!backend[kind]) {
        checkbox.checked = !enabled;
        flash('当前版本不支持系统集成', true);
        return;
    }
    elsSettings.fileAssoc.disabled = true;
    elsSettings.contextMenu.disabled = true;
    try {
        await backend[kind](enabled);
        flash(label + (enabled ? '已注册' : '已取消'));
    } catch (e) {
        flash(label + (enabled ? '注册失败：' : '取消注册失败：') + e, true);
    } finally {
        elsSettings.fileAssoc.disabled = false;
        elsSettings.contextMenu.disabled = false;
        await syncIntegrationStatus();
    }
}

function openAbout() {
    openSettings('about');
}

let confirmAction = null;
let nameSubmit = null;
let nameBusy = false;

function openNameDialog(options) {
    const opts = options || {};
    elsDialogs.nameTitle.textContent = opts.title || '名称';
    elsDialogs.nameLabel.textContent = opts.label || '名称';
    elsDialogs.nameInput.value = opts.value || '';
    elsDialogs.nameInput.placeholder = opts.placeholder || '';
    elsDialogs.nameError.textContent = '';
    elsDialogs.nameError.classList.add('hidden');
    elsDialogs.nameOk.textContent = opts.okLabel || '确定';
    nameSubmit = opts.onSubmit || null;
    nameBusy = false;
    openDialogEl(elsDialogs.name);
    setTimeout(() => {
        const input = elsDialogs.nameInput;
        input.focus();
        const dot = input.value.lastIndexOf('.');
        if (opts.selectStem && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    }, 0);
}

function nameDialogError(message) {
    elsDialogs.nameError.textContent = String(message || '');
    elsDialogs.nameError.classList.remove('hidden');
}

async function submitNameDialog() {
    if (!nameSubmit || nameBusy) return;
    const value = elsDialogs.nameInput.value;
    nameBusy = true;
    elsDialogs.nameOk.disabled = true;
    elsDialogs.nameError.classList.add('hidden');
    try {
        await nameSubmit(value);
        nameBusy = false;
        elsDialogs.nameOk.disabled = false;
        closeDialogs();
    } catch (e) {
        nameDialogError((e && e.message) || e);
        nameBusy = false;
        elsDialogs.nameOk.disabled = false;
    }
}

elsDialogs.nameOk.addEventListener('click', submitNameDialog);
document.getElementById('btn-name-cancel').addEventListener('click', closeDialogs);
elsDialogs.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitNameDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialogs();
    }
});

function openCloseConfirm(message, action, okLabel) {
    elsDialogs.confirmText.textContent = message || '有未保存的修改，关闭后将丢弃。';
    elsDialogs.confirmOk.textContent = okLabel || '丢弃并关闭';
    confirmAction = action || (() => {
        if (backend.ForceClose) backend.ForceClose();
    });
    openDialogEl(elsDialogs.confirm);
}

document.getElementById('btn-discard').addEventListener('click', () => {
    const action = confirmAction;
    confirmAction = null;
    closeDialogs();
    if (action) action();
});
document.getElementById('btn-cancel-close').addEventListener('click', closeDialogs);

let dialogDrag = null;
function startDialogDrag(e) {
    if (e.target.closest('.dialog-close')) return;
    const dlg = e.currentTarget.parentElement;
    const r = dlg.getBoundingClientRect();
    dialogDrag = {el: dlg, dx: e.clientX - r.left, dy: e.clientY - r.top};
    dlg.style.left = r.left + 'px';
    dlg.style.top = r.top + 'px';
    dlg.style.transform = 'none';
    e.preventDefault();
}
window.addEventListener('mousemove', (e) => {
    if (!dialogDrag) return;
    dialogDrag.el.style.left = (e.clientX - dialogDrag.dx) + 'px';
    dialogDrag.el.style.top = (e.clientY - dialogDrag.dy) + 'px';
});
window.addEventListener('mouseup', () => {
    dialogDrag = null;
});
document.querySelectorAll('.dialog-head').forEach((head) => head.addEventListener('mousedown', startDialogDrag));
document.querySelectorAll('.dialog-close').forEach((btn) => btn.addEventListener('click', closeDialogs));
elsDialogs.mask.addEventListener('click', (e) => {
    if (e.target !== elsDialogs.mask) return;
    if (!elsDialogs.confirm.classList.contains('hidden') || !elsDialogs.name.classList.contains('hidden')) closeDialogs();
});

document.querySelectorAll('.snav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
        selectSettingsPane(btn.dataset.pane);
        if (btn.dataset.pane === 'formats') renderFmtTable();
        if (btn.dataset.pane === 'integration') syncIntegrationStatus();
    });
});

if (elsSettings.fileAssoc) {
    elsSettings.fileAssoc.addEventListener('change', () => applyIntegration('SetFileAssociation', elsSettings.fileAssoc, '文件关联'));
    elsSettings.contextMenu.addEventListener('change', () => applyIntegration('SetContextMenu', elsSettings.contextMenu, '右键菜单'));
    elsSettings.refreshIntegration.addEventListener('click', syncIntegrationStatus);
}

const ENCODINGS = [['auto', '自动'], ['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const CONVERT_ENCODINGS = [['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const INDENTS = [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']];
const EOLS = [['follow', '跟随原文件'], ['lf', 'LF'], ['crlf', 'CRLF']];
const VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];
const CSV_VIEWS = [['table', '表格视图'], ['tree', '树视图'], ['text', '文本视图']];
const MARKDOWN_VIEWS = [['preview', '预览'], ['code', '代码视图'], ['text', '文本视图']];
const IMAGE_VIEWS = [['image', '图片视图'], ['binary', '二进制视图']];
const BINARY_VIEWS = [['binary', '二进制视图']];
const CSV_TABLE_ROW_LIMIT = 5000;
const CSV_ROW_NUM_WIDTH = 44;
const CSV_COL_MIN_WIDTH = 56;

function viewOptionsFor(fmt) {
    if (fmt && fmt.image) return IMAGE_VIEWS;
    if (fmt && fmt.id === 'bytes') return BINARY_VIEWS;
    if (fmt && fmt.id === 'markdown') return MARKDOWN_VIEWS;
    return fmt && (fmt.table || fmt.id === 'csv') ? CSV_VIEWS : VIEWS;
}

function viewDisabled(mode) {
    if (!file) return true;
    if (mode === 'image') return !file.image;
    if (mode === 'binary') return !file.binary;
    if (mode === 'tree') return !file.treeAvailable;
    if (mode === 'text') return !(file.treeAvailable || (file.format && file.format.preview));
    if (mode === 'preview') return !(file.format && file.format.preview) || !!file.large;
    return false;
}

function viewDisabledTitle(mode) {
    if (mode === 'preview' && file && file.large) return '大文件不支持预览';
    return '当前文件只支持代码视图';
}

function viewLabel(mode) {
    if (mode === 'image') return '图片视图';
    if (mode === 'binary') return '二进制视图';
    if (mode === 'preview') return '预览';
    if (mode === 'table') return '表格视图';
    if (mode === 'text') return '文本视图';
    if (mode === 'code') return '代码视图';
    return '树视图';
}

const TREE_MAX_CHILDREN = 10000;
const editorLocale = {
    'zh-CN': {
        showMoreStatus: '已显示 ${visibleChilds} / ${totalChilds} 项',
        showMore: '显示更多',
        showAll: '显示全部',
    },
};

const markdownRenderer = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
});
markdownRenderer.use(markdownItKatex, {throwOnError: false, errorColor: '#f75464'});

function renderMarkdownCodeBlock(text, info) {
    const code = String(text || '').replace(/\n$/, '');
    const language = String(info || '').trim().split(/\s+/)[0];
    let highlighted = '';
    if (language && hljs.getLanguage(language)) {
        try {
            highlighted = hljs.highlight(code, {language, ignoreIllegals: true}).value;
        } catch (e) {}
    }
    if (!highlighted) highlighted = markdownRenderer.utils.escapeHtml(code);
    const langClass = language ? ' language-' + language.replace(/[^A-Za-z0-9_+.-]/g, '') : '';
    if (!settings.mdLineNumbers) {
        return '<pre><code class="hljs' + langClass + '">' + highlighted + '</code></pre>\n';
    }
    const lineCount = Math.max(1, code.split('\n').length);
    const numbers = Array.from({length: lineCount}, (_, i) => String(i + 1)).join('\n');
    return '<div class="md-code-frame">' +
        '<pre class="md-code-gutter" aria-hidden="true">' + numbers + '</pre>' +
        '<pre class="md-code-pre"><code class="hljs' + langClass + '">' + highlighted + '</code></pre>' +
        '</div>\n';
}

markdownRenderer.renderer.rules.fence = (tokens, idx) => renderMarkdownCodeBlock(tokens[idx].content, tokens[idx].info);
markdownRenderer.renderer.rules.code_block = (tokens, idx) => renderMarkdownCodeBlock(tokens[idx].content, '');
const defaultLinkOpen = markdownRenderer.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (href && !href.startsWith('#')) {
        token.attrSet('target', '_blank');
        token.attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
};

function renderMarkdownHtml(text) {
    const html = markdownRenderer.render(text || '');
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel'],
    });
}

function makeSelect(options, value, onChange) {
    const sel = document.createElement('select');
    for (const [v, label] of options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = label;
        if (v === value) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

const footPopover = document.getElementById('enc-popover');
const FOOT_WIDGETS = {encoding: els.stEnc, view: els.stMode, eol: els.stEol, zoom: els.stZoom};
let footPopoverKind = null;
const CHECK_ICON = String.fromCharCode(0xE73E);
const WARN_ICON = String.fromCharCode(0xE7BA);

function closeFootPopover() {
    footPopover.classList.add('hidden');
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    footPopoverKind = null;
}

function popTitle(text) {
    const t = document.createElement('div');
    t.className = 'enc-title';
    t.textContent = text;
    return t;
}

function popSep() {
    const s = document.createElement('div');
    s.className = 'enc-sep';
    return s;
}

function popFoot(prefix, value) {
    const foot = document.createElement('div');
    foot.className = 'enc-foot';
    foot.textContent = prefix + ': ';
    const b = document.createElement('b');
    b.textContent = value;
    foot.appendChild(b);
    return foot;
}

function popItem(label, opts = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'enc-item' + (opts.current ? ' current' : '');
    const ic = document.createElement('span');
    ic.className = 'enc-ic' + (opts.current ? ' cur' : (opts.iconClass ? ' ' + opts.iconClass : ''));
    ic.textContent = opts.icon || (opts.current ? CHECK_ICON : '');
    const text = document.createElement('span');
    text.textContent = label;
    row.append(ic, text);
    if (opts.disabled) {
        row.disabled = true;
        row.style.opacity = '0.4';
        row.title = opts.disabledTitle || '';
    } else if (opts.onClick) {
        row.addEventListener('click', opts.onClick);
    }
    return row;
}

function toggleBom() {
    if (!file) return;
    file.hasBom = !file.hasBom;
    setDirty(true);
    updateStatus();
    if (footPopoverKind === 'encoding') {
        footPopover.textContent = '';
        renderEncodingMenu();
    }
}

function convertEncoding(enc) {
    if (!file) return;
    if ((file.enc || 'utf-8') === enc) {
        closeFootPopover();
        return;
    }
    file.enc = enc;
    if (enc !== 'utf-8') file.hasBom = false;
    setDirty(true);
    updateStatus();
    flash('编码已转换为 ' + enc.toUpperCase());
    closeFootPopover();
}

async function renderEncodingMenu() {
    const current = file.enc || 'utf-8';
    footPopover.appendChild(popTitle('文件编码'));
    footPopover.appendChild(popItem(
        current === 'utf-8' ? (file.hasBom ? '移除 BOM' : '添加 BOM') : '添加 BOM（仅 UTF-8）',
        {disabled: current !== 'utf-8', disabledTitle: '仅 UTF-8 支持 BOM', onClick: toggleBom}
    ));
    footPopover.appendChild(popSep());
    const rows = [];
    for (const [enc, label] of CONVERT_ENCODINGS) {
        const row = popItem(label, {current: enc === current, onClick: () => convertEncoding(enc)});
        footPopover.appendChild(row);
        if (enc !== current) rows.push({enc, ic: row.querySelector('.enc-ic')});
    }
    footPopover.appendChild(popFoot('文件编码', current.toUpperCase() + (file.hasBom && current === 'utf-8' ? ' BOM' : '')));
    for (const {enc, ic} of rows) {
        try {
            const ok = await backend.CheckEncoding(file.content || '', enc);
            ic.textContent = ok ? CHECK_ICON : WARN_ICON;
            ic.className = 'enc-ic ' + (ok ? 'ok' : 'warn');
            ic.title = ok ? '可无损表示当前内容' : '包含无法表示的字符，转换后可能丢失';
        } catch (e) {}
    }
}

function renderViewMenu() {
    footPopover.appendChild(popTitle('视图'));
    for (const [mode, label] of viewOptionsFor(file && file.format)) {
        const disabled = viewDisabled(mode);
        footPopover.appendChild(popItem(label, {
            current: currentMode === mode,
            disabled,
            disabledTitle: viewDisabledTitle(mode),
            onClick: () => { switchMode(mode); closeFootPopover(); },
        }));
    }
    footPopover.appendChild(popFoot('当前', viewLabel(currentMode)));
}

function renderImageZoomMenu() {
    if (!file || !file.image) return;
    const doc = file;
    footPopover.appendChild(popTitle('图片缩放'));
    footPopover.appendChild(popItem('自动（适配显示区）', {
        current: doc.imageZoom == null,
        onClick: () => {
            doc.imageZoom = null;
            applyImageZoom(doc);
            closeFootPopover();
        },
    }));
    footPopover.appendChild(popSep());
    for (const percent of [25, 50, 75, 100, 150, 200, 400, 800]) {
        footPopover.appendChild(popItem(percent + '%', {
            current: doc.imageZoom != null && Math.round(doc.imageZoom * 100) === percent,
            onClick: () => {
                doc.imageZoom = percent / 100;
                applyImageZoom(doc);
                closeFootPopover();
            },
        }));
    }
    const current = doc.imageScale ? Math.round(doc.imageScale * 100) + '%' : '—';
    footPopover.appendChild(popFoot('当前', current));
}

function chooseEol(value) {
    if (!file) return;
    const fs = getFormatSettings(file.format.id);
    if (fs.eol === value) {
        closeFootPopover();
        return;
    }
    const before = fs.eol === 'follow' ? file.eol : fs.eol;
    fs.eol = value;
    applySettings();
    const after = value === 'follow' ? file.eol : value;
    if (after !== before) setDirty(true);
    updateStatus();
    flash('保存换行: ' + (value === 'follow' ? '跟随原文件' : value.toUpperCase()));
    closeFootPopover();
}

function renderEolMenu() {
    const fs = getFormatSettings(file.format.id);
    const eff = fs.eol === 'follow' ? file.eol : fs.eol;
    footPopover.appendChild(popTitle('换行符'));
    for (const [value, label] of EOLS) {
        footPopover.appendChild(popItem(label, {
            current: fs.eol === value,
            onClick: () => chooseEol(value),
        }));
    }
    footPopover.appendChild(popFoot('当前', eff.toUpperCase()));
}

function openFootPopover(kind) {
    if (!file) return;
    const anchor = FOOT_WIDGETS[kind];
    if (!anchor) return;
    footPopover.textContent = '';
    footPopover.classList.remove('hidden');
    if (kind === 'encoding') renderEncodingMenu();
    else if (kind === 'view') renderViewMenu();
    else if (kind === 'zoom') renderImageZoomMenu();
    else renderEolMenu();
    const r = anchor.getBoundingClientRect();
    const pr = footPopover.getBoundingClientRect();
    footPopover.style.left = Math.max(8, Math.round(r.right - pr.width)) + 'px';
    footPopover.style.top = Math.round(r.top - pr.height - 6) + 'px';
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    anchor.classList.add('active');
    footPopoverKind = kind;
}

function toggleFootPopover(kind) {
    if (footPopoverKind === kind && !footPopover.classList.contains('hidden')) closeFootPopover();
    else openFootPopover(kind);
}

Object.entries(FOOT_WIDGETS).forEach(([kind, el]) => {
    if (!el) return;
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFootPopover(kind);
    });
});
footPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && (t.closest('#enc-popover') || t.closest('#statusbar'))) return;
    closeFootPopover();
}, true);
window.addEventListener('blur', () => closeFootPopover());

function renderFmtTable() {
    const table = document.getElementById('fmt-table');
    table.textContent = '';
    const head = document.createElement('div');
    head.className = 'fmt-row fmt-head';
    for (const label of ['格式', '编码', '缩进', '保存换行', '默认视图']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.appendChild(cell);
    }
    table.appendChild(head);
    for (const f of formatDefs) {
        const fs = getFormatSettings(f.id);
        const row = document.createElement('div');
        row.className = 'fmt-row';
        const name = document.createElement('span');
        name.textContent = f.name;
        row.appendChild(name);
        const update = (key) => (value) => {
            settings.formatSettings[f.id][key] = value;
            applySettings();
        };
        row.appendChild(makeSelect(ENCODINGS, fs.encoding, update('encoding')));
        row.appendChild(makeSelect(INDENTS, fs.indent, update('indent')));
        row.appendChild(makeSelect(EOLS, fs.eol, update('eol')));
        const viewSel = makeSelect(viewOptionsFor(f), fs.view, (value) => {
            settings.formatSettings[f.id].view = value;
            applySettings();
            if (file && file.format.id === f.id) switchMode(value);
        });
        if (f.id === 'text') viewSel.disabled = true;
        row.appendChild(viewSel);
        table.appendChild(row);
    }
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function flash(msg, isError) {
    els.stMessage.textContent = msg;
    els.stMessage.classList.toggle('error', !!isError);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { els.stMessage.textContent = ''; }, 5000);
}

function updateWindowTitle() {
    const title = file ? file.name + ' - CaDt-DataLens' : 'CaDt-DataLens';
    document.title = title;
    if (rt && rt.WindowSetTitle) {
        try {
            rt.WindowSetTitle(title);
        } catch (e) {}
    }
}

function anyDirty() {
    return docs.some((d) => d.dirty);
}

function updateBackendDirty() {
    backend.SetDirty(anyDirty());
}

function setDirty(flag, opts = {}) {
    dirty = flag;
    if (file) file.dirty = flag;
    updateBackendDirty();
    els.stDirty.textContent = flag ? '未保存' : '';
    els.filename.classList.toggle('dirty', flag);
    if (file) updateTabDirty(file);
    updateWindowTitle();
    if (flag && !opts.noAutoSave) scheduleAutoSave();
    else cancelAutoSave();
}

const autoSaveDelay = 1000;

function cancelAutoSave() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = 0;
    }
}

function scheduleAutoSave() {
    cancelAutoSave();
    if (!settings.autoSave || settings.readOnlyMode || !dirty || !file || file.large || file.binary || !file.path || !editor) return;
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = 0;
        if (dirty && file && settings.autoSave) save({auto: true});
    }, autoSaveDelay);
}

function updateTabDirty(doc) {
    const el = els.tabbar.querySelector('.tab[data-doc-id="' + doc.id + '"]');
    if (el) el.classList.toggle('dirty', !!doc.dirty);
}

function renderTabs() {
    els.tabbar.textContent = '';
    const hide = docs.length === 0 || (settings.openMode === 'window' && docs.length === 1);
    els.tabbar.classList.toggle('hidden', hide);
    for (const doc of docs) {
        const tab = document.createElement('div');
        tab.className = 'tab' + (doc === file ? ' active' : '') + (doc.dirty ? ' dirty' : '');
        tab.dataset.docId = String(doc.id);
        tab.title = doc.path || doc.name;
        const icon = createFileIcon(doc.name, 'tab-icon');
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = doc.name;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.title = '关闭';
        close.textContent = '\uE8BB';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            requestCloseDoc(doc);
        });
        tab.addEventListener('click', () => activateDoc(doc));
        tab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            activateDoc(doc);
            showTabMenu(doc, e.clientX, e.clientY);
        });
        tab.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                requestCloseDoc(doc);
            }
        });
        tab.append(icon, dot, name, close);
        els.tabbar.appendChild(tab);
        if (doc === file) tab.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
}

function renderBreadcrumb(path) {
    els.breadcrumb.textContent = '';
    if (!path) return;
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    let display = parts;
    if (parts.length > 6) {
        display = [parts[0], '…', ...parts.slice(-4)];
    }
    display.forEach((seg, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = '▸';
            els.breadcrumb.appendChild(sep);
        }
        const s = document.createElement('span');
        s.className = 'crumb' + (i === display.length - 1 ? ' crumb-last' : '');
        s.textContent = seg;
        s.title = seg;
        els.breadcrumb.appendChild(s);
    });
}

function treeHistory(action) {
    if (!editor || !editor.dom) return;
    const active = document.activeElement;
    if (active && els.editor.contains(active) && active.blur) active.blur();
    const btn = editor.dom[action];
    if (btn && !btn.disabled) btn.click();
}

function textArea() {
    if (!editor) return null;
    if (editor.textarea) return editor.textarea;
    const pane = file && file.pane ? file.pane : els.editor;
    return pane.querySelector('textarea.jsoneditor-text');
}

function doUndo() {
    if (!editor || settings.readOnlyMode) return;
    if (currentMode === 'tree') treeHistory('undo');
    else if (currentMode === 'table') tableHistory('undo');
    else if (currentMode === 'code' && editor.aceEditor) editor.aceEditor.execCommand('undo');
    else if (currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('undo');
        }
    }
}

function doRedo() {
    if (!editor || settings.readOnlyMode) return;
    if (currentMode === 'tree') treeHistory('redo');
    else if (currentMode === 'table') tableHistory('redo');
    else if (currentMode === 'code' && editor.aceEditor) editor.aceEditor.execCommand('redo');
    else if (currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('redo');
        }
    }
}

function toggleFocusedNode(action) {
    const active = document.activeElement;
    if (!active || !els.editor.contains(active)) return;
    const tr = active.closest('tr');
    if (!tr) return;
    const btn = tr.querySelector('button.jsoneditor-collapsed, button.jsoneditor-expanded');
    if (!btn) return;
    const collapsed = btn.classList.contains('jsoneditor-collapsed');
    if (action === 'expand' && collapsed) btn.click();
    if (action === 'collapse' && !collapsed) btn.click();
}

function updateStatus() {
    if (!file) return;
    const fmt = file.format;
    const view = viewLabel(currentMode);
    els.stMode.textContent = fmt.name + ' · ' + view + (file.large || file.binary || settings.readOnlyMode ? ' · 只读' : '');
    els.stSize.textContent = fmtSize(file.size);
    els.stSize.title = file.image && file.imageWidth ? file.imageWidth + ' × ' + file.imageHeight : '';
    const zoom = file.image && currentMode === 'image' && file.imageScale
        ? Math.round(file.imageScale * 100) + '%'
        : '';
    els.stZoom.textContent = zoom;
    els.stZoom.title = zoom ? '图片缩放比例（点击选择，Ctrl+滚轮调整，双击图片恢复适配）' : '';
    if (file.binary) {
        els.stEol.textContent = '';
        els.stEnc.textContent = '';
        els.stEol.style.display = 'none';
        els.stEnc.style.display = 'none';
        return;
    }
    els.stEol.style.display = '';
    els.stEnc.style.display = '';
    const eolSetting = fmt ? getFormatSettings(fmt.id).eol : 'follow';
    els.stEol.textContent = (eolSetting === 'follow' ? file.eol : eolSetting).toUpperCase();
    const enc = (file.enc || 'utf-8').toUpperCase();
    els.stEnc.textContent = enc + (file.hasBom && enc === 'UTF-8' ? ' BOM' : '');
}

function hideBanner() {
    els.banner.classList.add('hidden');
}

function dismissBanner() {
    if (file) file.bannerDismissed = true;
    hideBanner();
}

function showBanner(data, parseError) {
    if (!data || data.bannerDismissed || !settings.showBanners) {
        hideBanner();
        return;
    }
    if (data.binary) {
        if (data.image && data.mode === 'image') {
            hideBanner();
            return;
        }
        const shown = data.hexShown || data.size;
        const truncated = shown < data.size;
        els.bannerText.textContent = '二进制文件 · ' + data.name + '（' + fmtSize(data.size) + '）：下方从第 0 字节开始，以十六进制字节数据只读展示' +
            (truncated ? '，仅显示前 ' + fmtSize(shown) : '') + '。';
        els.banner.classList.remove('hidden');
    } else if (data.large) {
        els.bannerText.textContent = '大文件（' + fmtSize(data.size) + '）：已切换为只读代码模式，不可编辑保存。';
        els.banner.classList.remove('hidden');
    } else if (parseError) {
        els.bannerText.textContent = data.format.name + ' 解析失败：' + parseError.message + '。已用代码模式打开，可手动修复后保存。';
        els.banner.classList.remove('hidden');
    } else {
        hideBanner();
    }
}

function foldDomCount(el) {
    const raw = el.textContent.trim();
    const exact = raw.match(/^[[{]\s*(\d+)\s*[\]}]$/);
    if (exact) return Number(exact[1]);
    const loose = raw.match(/[[{]\s*(\d+)/);
    if (loose) return Number(loose[1]);
    if (el.dataset.count != null) return Number(el.dataset.count);
    return null;
}

function foldValueAtPath(root, path) {
    let value = root;
    for (const segment of path) {
        if (value == null) return undefined;
        if (Array.isArray(value)) value = value[Number(segment)];
        else if (typeof value === 'object') value = value[segment];
        else return undefined;
    }
    return value;
}

function foldRowPaths(tbody) {
    const paths = new Map();
    const stack = [];
    for (const tr of tbody.children) {
        if (!tr || tr.tagName !== 'TR') continue;
        const table = tr.querySelector('table.jsoneditor-values');
        const keyEl = table ? table.querySelector('.jsoneditor-field, .jsoneditor-readonly') : null;
        if (!keyEl) continue;
        const key = keyEl.textContent.trim();
        if (!key) continue;
        const margin = table ? parseInt(table.style.marginLeft || '0', 10) : 0;
        const depth = Math.max(0, Math.round(margin / 24));
        if (depth === 0) {
            stack.length = 0;
            stack[0] = null;
        } else {
            stack.length = depth;
            stack[depth] = key;
        }
        paths.set(tr, stack.slice(1, depth + 1));
    }
    return paths;
}

function foldPrimitive(value) {
    if (typeof value === 'string') return {text: JSON.stringify(value), cls: 'jsoneditor-fold-string'};
    if (value === null || value === undefined) return {text: 'null', cls: 'jsoneditor-fold-null'};
    if (typeof value === 'boolean') return {text: String(value), cls: 'jsoneditor-fold-bool'};
    if (typeof value === 'number') return {text: String(value), cls: 'jsoneditor-fold-number'};
    if (Array.isArray(value)) return {text: '[...]', cls: 'jsoneditor-fold-nested'};
    if (typeof value === 'object') return {text: '{...}', cls: 'jsoneditor-fold-nested'};
    return {text: String(value), cls: 'jsoneditor-fold-nested'};
}

function clipFoldText(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max) + (text.startsWith('"') ? '"' : '');
}

function foldObjectSpec(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (!keys.length) return {kind: 'empty'};
    const keyText = clipFoldText(JSON.stringify(keys[0]), 36);
    const primitive = foldPrimitive(value[keys[0]]);
    return {
        kind: 'object',
        keyText,
        valueText: clipFoldText(primitive.text, 30),
        valueClass: primitive.cls,
    };
}

function foldSpan(parent, text, className) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
}

function renderFoldPreview(el, sig, build) {
    if (el.dataset.foldSig === sig && el.querySelector('.jsoneditor-fold-preview')) return;
    el.textContent = '';
    const wrap = document.createElement('span');
    wrap.className = 'jsoneditor-fold-preview';
    build(wrap);
    el.appendChild(wrap);
    el.dataset.foldSig = sig;
}

function humanizeCounts() {
    if (!editor || currentMode !== 'tree') return;
    const root = file && file.pane ? file.pane : els.editor;
    const nodes = root.querySelectorAll('div.jsoneditor-value.jsoneditor-object, div.jsoneditor-value.jsoneditor-array');
    const pathMaps = new WeakMap();
    let rootValue;
    let rootLoaded = false;
    const rootData = () => {
        if (!rootLoaded) {
            try {
                rootValue = editor.get();
            } catch (e) {
                rootValue = undefined;
            }
            rootLoaded = true;
        }
        return rootValue;
    };
    nodes.forEach((el) => {
        const isObject = el.classList.contains('jsoneditor-object');
        const collapsed = !!el.closest('tr.jsoneditor-collapsed');
        const row = el.closest('tr.jsoneditor-expandable');
        let path = null;
        if (row && row.parentElement) {
            if (!pathMaps.has(row.parentElement)) pathMaps.set(row.parentElement, foldRowPaths(row.parentElement));
            const map = pathMaps.get(row.parentElement);
            if (map.has(row)) path = map.get(row);
        }
        const value = path ? foldValueAtPath(rootData(), path) : undefined;
        let count = foldDomCount(el);
        if (isObject && value && typeof value === 'object' && !Array.isArray(value)) count = Object.keys(value).length;
        else if (!isObject && Array.isArray(value)) count = value.length;
        if (!Number.isFinite(count)) return;
        el.dataset.count = String(count);
        if (collapsed) {
            if (isObject) {
                const spec = foldObjectSpec(value);
                if (spec && spec.kind === 'empty') {
                    renderFoldPreview(el, 'o:empty', (wrap) => foldSpan(wrap, '{}', 'jsoneditor-fold-punct'));
                } else if (spec) {
                    renderFoldPreview(el, 'o:' + JSON.stringify(spec), (wrap) => {
                        foldSpan(wrap, '{', 'jsoneditor-fold-punct');
                        foldSpan(wrap, spec.keyText, 'jsoneditor-fold-key');
                        foldSpan(wrap, ': ', 'jsoneditor-fold-punct');
                        foldSpan(wrap, spec.valueText, spec.valueClass);
                        foldSpan(wrap, '...', 'jsoneditor-fold-punct');
                        foldSpan(wrap, '}', 'jsoneditor-fold-punct');
                    });
                } else {
                    renderFoldPreview(el, 'of:' + count, (wrap) => {
                        foldSpan(wrap, '{' + count + ' 项}', 'jsoneditor-fold-punct');
                    });
                }
            } else if (count === 0) {
                renderFoldPreview(el, 'a:0', (wrap) => foldSpan(wrap, '[]', 'jsoneditor-fold-punct'));
            } else {
                renderFoldPreview(el, 'a:' + count, (wrap) => {
                    foldSpan(wrap, '[ ', 'jsoneditor-fold-punct');
                    foldSpan(wrap, count + ' 个元素', 'jsoneditor-fold-count');
                    foldSpan(wrap, '... ]', 'jsoneditor-fold-punct');
                });
            }
        } else {
            const text = count + ' 项';
            if (el.textContent !== text || el.querySelector('.jsoneditor-fold-preview')) el.textContent = text;
            el.dataset.foldSig = 'e:' + count;
        }
        el.classList.toggle('value-fold', collapsed);
        el.classList.toggle('value-count', !collapsed);
        el.title = (isObject ? '对象' : '数组') + '，共 ' + count + ' 项' + (collapsed ? '（点击展开）' : '');
    });
}

let countQueued = false;
const countObserver = new MutationObserver(() => {
    if (countQueued) return;
    countQueued = true;
    queueMicrotask(() => {
        countQueued = false;
        humanizeCounts();
    });
});
countObserver.observe(els.editor, {childList: true, subtree: true, characterData: true});

function applyAceMode() {
    if ((currentMode !== 'code' && currentMode !== 'binary') || !editor || !editor.aceEditor) return;
    const want = aceModeFor(file && file.name, file && file.format);
    try {
        if (editor.aceEditor.session.getMode().$id !== want) {
            editor.aceEditor.session.setMode(want);
        }
        const container = editor.aceEditor.container;
        for (const cls of Array.from(container.classList)) {
            if (cls.startsWith('ace-mode-')) container.classList.remove(cls);
        }
        container.classList.add('ace-mode-' + want.split('/').pop());
        const pureJson = !!(file && file.format && file.format.id === 'json' && /\.json$/i.test(file.name || ''));
        editor.aceEditor.session.setUseWorker(pureJson);
        editor.aceEditor.setReadOnly(!!(file && (file.large || file.binary)) || !!settings.readOnlyMode);
        editor.aceEditor.setFontSize(settings.editorFont);
        editor.aceEditor.session.setUseWrapMode(!!settings.codeWrap);
        if (file && file.format) {
            const fs = getFormatSettings(file.format.id);
            const tab = fs.indent === 'tab';
            editor.aceEditor.session.setUseSoftTabs(!tab);
            editor.aceEditor.session.setTabSize(tab ? 4 : Number(fs.indent));
        }
        editor.aceEditor.setDisplayIndentGuides(true);
        editor.aceEditor.setHighlightIndentGuides(true);
    } catch (e) {
        console.warn('ace mode switch failed', e);
    }
}

function snapshotActiveDoc() {
    if (!file || !editor) return;
    file.text = editor.getText();
    file.mode = currentMode;
    file.dirty = dirty;
}

function markDocDirty(doc) {
    if (!doc || !doc.editor) return;
    const text = doc.editor.getText();
    doc.text = text;
    const base = doc.bases[doc.mode];
    const next = doc.untitled ? true : (base == null ? true : text !== base);
    if (file === doc) {
        setDirty(next);
    } else {
        doc.dirty = next;
        updateTabDirty(doc);
        updateBackendDirty();
    }
}

function createDocEditor(doc) {
    if (doc.editor) return;
    const fmt = doc.format;
    const fs = getFormatSettings(fmt.id);
    const showJsonErrors = fmt.id === 'json' && /\.json$/i.test(doc.name || '');
    const tableRequested = !!fmt.table && doc.mode === 'table';
    const previewRequested = !!fmt.preview && doc.mode === 'preview';
    const imageRequested = !!fmt.image && doc.mode === 'image';
    const binaryMode = !!fmt.image || fmt.id === 'bytes';
    let startMode = !doc.treeAvailable ? 'code' : (doc.mode === 'code' || doc.mode === 'text' ? doc.mode : 'tree');
    if (tableRequested) startMode = 'text';
    if (previewRequested) startMode = 'code';
    let initialText = null;
    let initialValue = null;
    if (startMode === 'code' || startMode === 'text') {
        initialText = doc.content || '';
    } else {
        try {
            initialValue = fmt.parse(doc.content || '');
        } catch (e) {
            startMode = 'code';
            initialText = doc.content || '';
            doc.treeAvailable = false;
            doc.parseError = e;
        }
    }
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active';
    els.editor.appendChild(pane);
    installReadOnlyGuards(pane);
    pane.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const fold = target.closest('.jsoneditor-value.value-fold');
        if (fold) {
            const row = fold.closest('tr.jsoneditor-expandable');
            const button = row ? row.querySelector('button.jsoneditor-collapsed') : null;
            if (button) {
                e.preventDefault();
                e.stopPropagation();
                button.click();
                queueMicrotask(humanizeCounts);
                return;
            }
        }
        if (target.closest('button.jsoneditor-collapsed, button.jsoneditor-expanded')) {
            queueMicrotask(humanizeCounts);
        }
    }, true);
    doc.loading = true;
    const ed = new JSONEditor(pane, {
        mode: startMode,
        modes: fmt.table ? ['tree', 'text'] : (doc.treeAvailable ? ['tree', 'code', 'text'] : ['code']),
        mainMenuBar: true,
        navigationBar: !fmt.rawOnly,
        statusBar: false,
        showErrorTable: showJsonErrors,
        maxVisibleChilds: TREE_MAX_CHILDREN,
        language: 'zh-CN',
        languages: editorLocale,
        indentation: fs.indent === 'tab' ? '\t' : Number(fs.indent),
        onChange() {
            if (doc.loading) return;
            markDocDirty(doc);
        },
        onModeChange(mode) {
            if (!doc.editor) return;
            doc.mode = mode;
            if (file === doc) {
                currentMode = mode;
                applyAceMode();
                updateStatus();
                updateSearchState();
            }
            setTimeout(() => {
                if (!doc.editor || doc.mode !== mode) return;
                doc.text = doc.editor.getText();
                if (!doc.dirty) doc.bases[mode] = doc.text;
                applyReadOnlyToDoc(doc);
            }, 0);
        },
        onError(err) {
            if (file === doc) flash(err.message, true);
        },
    });
    doc.editor = ed;
    doc.pane = pane;
    if (startMode === 'code' || startMode === 'text') {
        ed.setText(initialText != null ? initialText : '');
    } else {
        ed.set(initialValue);
    }
    if ((doc.large || doc.binary || settings.readOnlyMode) && ed.aceEditor) {
        ed.aceEditor.setReadOnly(true);
    }
    if (ed.aceEditor) {
        try {
            ed.aceEditor.session.setUseWrapMode(!!settings.codeWrap);
        } catch (e) {}
    }
    doc.mode = previewRequested ? 'preview' : tableRequested ? 'table' : imageRequested ? 'image' : binaryMode ? 'binary' : startMode;
    doc.text = ed.getText();
    if (fmt.table) createCsvTableView(doc);
    if (fmt.preview) createMarkdownPreview(doc);
    if (fmt.image) createImageView(doc);
    if (tableRequested) showCsvTableView(doc);
    if (previewRequested) showMarkdownPreview(doc);
    if (imageRequested) showImageView(doc);
    if (!doc.dirty) doc.bases[doc.mode] = doc.text;
    applyReadOnlyToDoc(doc);
    doc.content = null;
    doc.loading = false;
}

function createCsvTableView(doc) {
    if (doc.tableEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'csv-table-view';
    const bar = document.createElement('div');
    bar.className = 'csv-table-bar';
    const meta = document.createElement('span');
    meta.className = 'csv-table-meta';
    const hint = document.createElement('span');
    hint.className = 'csv-table-hint';
    hint.textContent = doc.large
        ? '文件超过 10 MB，表格只读；可拖表头边缘调列宽'
        : '点击单元格编辑；拖表头边缘调列宽；Enter 确认，Esc 取消';
    bar.append(meta, hint);
    const scroll = document.createElement('div');
    scroll.className = 'csv-table-scroll';
    wrap.append(bar, scroll);
    doc.pane.appendChild(wrap);
    doc.tableEl = wrap;
    doc.tableMeta = meta;
    doc.tableScroll = scroll;
}

function renderCsvTableView(doc) {
    if (!doc || !doc.tableEl || !doc.editor) return;
    const scroll = doc.tableScroll;
    const keepTop = scroll.scrollTop;
    const keepLeft = scroll.scrollLeft;
    scroll.textContent = '';
    const text = doc.editor.getText();
    doc.tableTrailingNewline = /\n$/.test(text);
    let parsed;
    try {
        parsed = doc.format.parseTable ? doc.format.parseTable(text) : {headers: [], rows: []};
    } catch (e) {
        doc.tableMeta.textContent = 'CSV 解析失败';
        const error = document.createElement('div');
        error.className = 'csv-table-empty error';
        error.textContent = e.message;
        scroll.appendChild(error);
        return;
    }
    const headers = parsed.headers || [];
    const rows = parsed.rows || [];
    const shown = Math.min(rows.length, CSV_TABLE_ROW_LIMIT);
    doc.tableHeaders = headers;
    doc.tableRows = rows;
    if (!Array.isArray(doc.tableColWidths) || doc.tableColWidths.length !== headers.length) {
        doc.tableColWidths = null;
    }
    if (!doc.tableUndo) doc.tableUndo = [];
    if (!doc.tableRedo) doc.tableRedo = [];
    doc.tableMeta.textContent = rows.length + ' 行 × ' + headers.length + ' 列' +
        (shown < rows.length ? ' · 仅显示前 ' + shown + ' 行' : '');
    if (!headers.length) {
        const empty = document.createElement('div');
        empty.className = 'csv-table-empty';
        empty.textContent = '没有可显示的表格内容';
        scroll.appendChild(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'csv-table';
    if (Array.isArray(doc.tableColWidths) && doc.tableColWidths.length === headers.length) {
        table.classList.add('fixed-layout');
        table.appendChild(buildCsvColgroup(doc.tableColWidths));
        table.style.width = (CSV_ROW_NUM_WIDTH + doc.tableColWidths.reduce((sum, w) => sum + w, 0)) + 'px';
    }
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'csv-rownum';
    corner.textContent = '#';
    headRow.appendChild(corner);
    for (let col = 0; col < headers.length; col++) {
        const header = headers[col];
        const th = document.createElement('th');
        th.className = 'csv-col-head';
        th.title = header;
        const label = document.createElement('span');
        label.className = 'csv-head-text';
        label.textContent = header === '' ? '(空列名)' : header;
        const handle = document.createElement('span');
        handle.className = 'csv-col-resize';
        handle.title = '拖动调整列宽';
        handle.dataset.col = String(col);
        handle.addEventListener('pointerdown', (e) => startCsvColumnResize(doc, col, e));
        th.append(label, handle);
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    const fragment = document.createDocumentFragment();
    const editable = !doc.large && !doc.binary && !settings.readOnlyMode;
    for (let i = 0; i < shown; i++) {
        const row = rows[i] || [];
        const tr = document.createElement('tr');
        const num = document.createElement('td');
        num.className = 'csv-rownum';
        num.textContent = String(i + 1);
        tr.appendChild(num);
        for (let col = 0; col < headers.length; col++) {
            const td = document.createElement('td');
            td.className = 'csv-cell';
            const value = row[col];
            const display = value == null ? '' : String(value);
            td.textContent = display;
            td.title = display;
            if (editable) {
                td.contentEditable = 'plaintext-only';
                td.spellcheck = false;
                td.dataset.row = String(i);
                td.dataset.col = String(col);
                td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
                td.addEventListener('input', () => markCsvCellTyping(doc));
                td.addEventListener('blur', () => commitCsvCell(doc, td));
            }
            tr.appendChild(td);
        }
        fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
    table.appendChild(tbody);
    scroll.appendChild(table);
    scroll.scrollTop = keepTop;
    scroll.scrollLeft = keepLeft;
}

function buildCsvColgroup(widths) {
    const group = document.createElement('colgroup');
    group.className = 'csv-colgroup';
    const rowCol = document.createElement('col');
    rowCol.style.width = CSV_ROW_NUM_WIDTH + 'px';
    group.appendChild(rowCol);
    for (const width of widths) {
        const col = document.createElement('col');
        col.style.width = width + 'px';
        group.appendChild(col);
    }
    return group;
}

function applyCsvColumnLayout(doc) {
    if (!doc || doc !== file || !doc.tableScroll || !doc.tableColWidths) return;
    const table = doc.tableScroll.querySelector('table.csv-table');
    if (!table) return;
    const headers = doc.tableHeaders || [];
    if (doc.tableColWidths.length !== headers.length) return;
    table.classList.add('fixed-layout');
    let group = table.querySelector('colgroup.csv-colgroup');
    if (!group || group.children.length !== doc.tableColWidths.length + 1) {
        if (group) group.remove();
        group = buildCsvColgroup(doc.tableColWidths);
        table.insertBefore(group, table.firstChild);
    } else {
        for (let i = 0; i < doc.tableColWidths.length; i++) {
            group.children[i + 1].style.width = doc.tableColWidths[i] + 'px';
        }
    }
    table.style.width = (CSV_ROW_NUM_WIDTH + doc.tableColWidths.reduce((sum, w) => sum + w, 0)) + 'px';
}

function freezeCsvColumnWidths(doc) {
    if (!doc || doc !== file || !doc.tableScroll) return;
    const headers = doc.tableHeaders || [];
    if (!headers.length) return;
    if (Array.isArray(doc.tableColWidths) && doc.tableColWidths.length === headers.length) return;
    const ths = Array.from(doc.tableScroll.querySelectorAll('thead th.csv-col-head'));
    if (ths.length !== headers.length) return;
    doc.tableColWidths = ths.map((th) => Math.max(CSV_COL_MIN_WIDTH, Math.round(th.getBoundingClientRect().width)));
    applyCsvColumnLayout(doc);
}

function startCsvColumnResize(doc, colIndex, e) {
    if (!doc || doc !== file || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    freezeCsvColumnWidths(doc);
    if (!doc.tableColWidths || !doc.tableColWidths[colIndex]) return;
    try {
        e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    const startX = e.clientX;
    const startWidth = doc.tableColWidths[colIndex];
    const onMove = (ev) => {
        const next = Math.max(CSV_COL_MIN_WIDTH, Math.round(startWidth + ev.clientX - startX));
        if (next === doc.tableColWidths[colIndex]) return;
        doc.tableColWidths[colIndex] = next;
        applyCsvColumnLayout(doc);
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('blur', cleanup);
        document.body.classList.remove('csv-col-resizing');
    };
    document.body.classList.add('csv-col-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('blur', cleanup);
}

function onCsvCellKeyDown(doc, e) {
    const td = e.currentTarget;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const row = doc.tableRows && doc.tableRows[Number(td.dataset.row)];
        const value = row && row[Number(td.dataset.col)] != null ? String(row[Number(td.dataset.col)]) : '';
        td.textContent = value;
        td.blur();
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        commitCsvCell(doc, td);
        focusAdjacentCsvCell(doc, td, (doc.tableHeaders || []).length || 1);
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        commitCsvCell(doc, td);
        focusAdjacentCsvCell(doc, td, e.shiftKey ? -1 : 1);
    }
}

function focusAdjacentCsvCell(doc, td, offset) {
    if (!doc.tableScroll) return;
    const cells = doc.tableScroll.querySelectorAll('td.csv-cell');
    const index = Array.prototype.indexOf.call(cells, td);
    if (index < 0) return;
    const target = cells[index + offset];
    if (!target) {
        td.blur();
        return;
    }
    target.focus();
    target.scrollIntoView({block: 'nearest', inline: 'nearest'});
}

function csvCellText(td) {
    return String(td.innerText || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function markCsvCellTyping(doc) {
    if (!doc || doc.dirty) return;
    if (file === doc) {
        setDirty(true, {noAutoSave: true});
    } else {
        doc.dirty = true;
        updateTabDirty(doc);
        updateBackendDirty();
    }
}

function flushCsvCellEditor() {
    if (currentMode !== 'table') return;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('csv-cell')) active.blur();
}

function serializeCsvTable(doc) {
    const text = doc.format.stringifyTable(doc.tableHeaders, doc.tableRows);
    return doc.tableTrailingNewline ? text + '\n' : text;
}

function applyCsvTableText(doc, text) {
    if (!doc || !doc.editor || doc.editor.getText() === text) return;
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setText(text);
        doc.text = text;
    } finally {
        doc.loading = loading;
    }
    markDocDirty(doc);
}

function commitCsvCell(doc, td) {
    if (!doc || doc !== file || doc.large || settings.readOnlyMode || !doc.tableRows || !doc.tableHeaders || !td) return;
    const rowIndex = Number(td.dataset.row);
    const colIndex = Number(td.dataset.col);
    const row = doc.tableRows[rowIndex];
    if (!row) return;
    const value = csvCellText(td);
    const before = row[colIndex] == null ? '' : String(row[colIndex]);
    td.textContent = value;
    td.title = value;
    if (value === before) {
        markDocDirty(doc);
        return;
    }
    row[colIndex] = value;
    applyCsvTableText(doc, serializeCsvTable(doc));
    doc.tableUndo.push({row: rowIndex, col: colIndex, before, after: value});
    if (doc.tableUndo.length > 100) doc.tableUndo.shift();
    doc.tableRedo.length = 0;
}

function tableHistory(action) {
    if (currentMode !== 'table' || !file || !file.tableRows) return;
    const doc = file;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('csv-cell')) active.blur();
    if (!doc.tableUndo || !doc.tableRedo) return;
    const from = action === 'undo' ? doc.tableUndo : doc.tableRedo;
    const to = action === 'undo' ? doc.tableRedo : doc.tableUndo;
    if (!from.length) return;
    const op = from.pop();
    const row = doc.tableRows[op.row];
    if (!row) {
        from.push(op);
        return;
    }
    row[op.col] = action === 'undo' ? op.before : op.after;
    to.push(op);
    applyCsvTableText(doc, serializeCsvTable(doc));
    renderCsvTableView(doc);
}

function createMarkdownPreview(doc) {
    if (doc.previewEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-preview-view';
    const scroll = document.createElement('div');
    scroll.className = 'md-preview-scroll';
    const body = document.createElement('div');
    body.className = 'md-preview';
    scroll.appendChild(body);
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.previewEl = wrap;
    doc.previewScroll = scroll;
    doc.previewBody = body;
    wrap.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#')) return;
        e.preventDefault();
        if (!/^(https?:|mailto:)/i.test(href)) return;
        if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(href);
        else window.open(href, '_blank', 'noopener');
    });
}

function renderMarkdownPreview(doc) {
    if (!doc || !doc.editor || !doc.previewBody) return;
    const scrollTop = doc.previewScroll ? doc.previewScroll.scrollTop : 0;
    try {
        doc.previewBody.innerHTML = renderMarkdownHtml(doc.editor.getText());
    } catch (e) {
        doc.previewBody.textContent = 'Markdown 渲染失败：' + e.message;
    }
    if (doc.previewScroll) doc.previewScroll.scrollTop = scrollTop;
}

function showMarkdownPreview(doc) {
    if (!doc || !doc.format.preview) return;
    createMarkdownPreview(doc);
    if (doc.pane) doc.pane.classList.add('preview-active');
    renderMarkdownPreview(doc);
}

function hideMarkdownPreview(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('preview-active');
    if (doc === file && doc.editor && doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function enterMarkdownPreview(doc) {
    if (!doc || !doc.format.preview || !doc.editor) return;
    if (doc.large) {
        flash('大文件不支持 Markdown 预览', true);
        return;
    }
    const text = doc.editor.getText();
    doc.loading = true;
    try {
        doc.editor.setMode('code');
        doc.editor.setText(text);
        doc.text = text;
        if (!doc.dirty && doc.bases.preview == null) doc.bases.preview = text;
        doc.mode = 'preview';
        currentMode = 'preview';
        showMarkdownPreview(doc);
        updateStatus();
        updateSearchState();
    } catch (e) {
        flash('切换预览失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function leaveMarkdownPreview(doc, mode) {
    if (!doc || !doc.editor) return;
    hideMarkdownPreview(doc);
    doc.mode = mode;
    currentMode = mode;
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode(mode);
    } catch (e) {
        flash('切换视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    updateStatus();
    updateSearchState();
}

function createImageView(doc) {
    if (doc.imageEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'image-preview-view';
    const scroll = document.createElement('div');
    scroll.className = 'image-preview-scroll';
    const canvas = document.createElement('div');
    canvas.className = 'image-preview-canvas';
    const status = document.createElement('div');
    status.className = 'image-preview-status';
    status.textContent = '正在加载图片…';
    const img = document.createElement('img');
    img.className = 'image-preview-img';
    img.alt = doc.name;
    img.draggable = false;
    img.hidden = true;
    img.addEventListener('load', () => {
        doc.imageWidth = img.naturalWidth;
        doc.imageHeight = img.naturalHeight;
        doc.imageError = null;
        img.hidden = false;
        status.classList.add('hidden');
        applyImageZoom(doc);
        if (doc === file) updateStatus();
    });
    img.addEventListener('error', () => {
        img.hidden = true;
        doc.imageError = '无法解码该图片';
        status.textContent = '无法预览此图片，可切换到二进制视图';
        status.classList.remove('hidden');
        if (doc === file && currentMode === 'image') {
            flash('图片无法预览，已切换到二进制视图', true);
            switchMode('binary');
        }
    });
    canvas.appendChild(img);
    scroll.append(canvas, status);
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.imageEl = wrap;
    doc.imageScroll = scroll;
    doc.imageCanvas = canvas;
    doc.imageNode = img;
    doc.imageStatus = status;

    scroll.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (scroll.scrollWidth <= scroll.clientWidth + 1 && scroll.scrollHeight <= scroll.clientHeight + 1) return;
        e.preventDefault();
        doc.imagePan = {id: e.pointerId, x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop};
        scroll.classList.add('panning');
        try {
            scroll.setPointerCapture(e.pointerId);
        } catch (err) {}
    });
    scroll.addEventListener('pointermove', (e) => {
        const pan = doc.imagePan;
        if (!pan || e.pointerId !== pan.id) return;
        scroll.scrollLeft = pan.left - (e.clientX - pan.x);
        scroll.scrollTop = pan.top - (e.clientY - pan.y);
    });
    const endPan = (e) => {
        if (!doc.imagePan || (e && e.pointerId !== doc.imagePan.id)) return;
        doc.imagePan = null;
        scroll.classList.remove('panning');
    };
    scroll.addEventListener('pointerup', endPan);
    scroll.addEventListener('pointercancel', endPan);
    scroll.addEventListener('dblclick', () => {
        if (!doc.imageWidth) return;
        doc.imageZoom = null;
        applyImageZoom(doc);
    });
    if (typeof ResizeObserver === 'function') {
        doc.imageResizeObserver = new ResizeObserver(() => {
            if (doc === file && currentMode === 'image') applyImageZoom(doc);
        });
        doc.imageResizeObserver.observe(scroll);
    }
}

function applyImageZoom(doc) {
    if (!doc || !doc.imageNode || !doc.imageScroll || !doc.imageWidth || !doc.imageHeight) return;
    const scroll = doc.imageScroll;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width < 20 || height < 20) return;
    const availableWidth = Math.max(1, width - 48);
    const availableHeight = Math.max(1, height - 48);
    const scale = doc.imageZoom == null
        ? Math.min(1, availableWidth / doc.imageWidth, availableHeight / doc.imageHeight)
        : doc.imageZoom;
    const previous = doc.imageScale || 0;
    const centerX = scroll.scrollLeft + width / 2;
    const centerY = scroll.scrollTop + height / 2;
    doc.imageScale = scale;
    doc.imageNode.style.width = Math.max(1, Math.round(doc.imageWidth * scale)) + 'px';
    doc.imageNode.style.height = Math.max(1, Math.round(doc.imageHeight * scale)) + 'px';
    if (previous > 0 && Math.abs(scale - previous) > 0.0001) {
        const ratio = scale / previous;
        requestAnimationFrame(() => {
            if (!doc.imageScroll) return;
            doc.imageScroll.scrollLeft = Math.max(0, centerX * ratio - width / 2);
            doc.imageScroll.scrollTop = Math.max(0, centerY * ratio - height / 2);
        });
    }
    requestAnimationFrame(() => {
        if (!doc.imageScroll) return;
        const canPan = doc.imageScroll.scrollWidth > doc.imageScroll.clientWidth + 1 ||
            doc.imageScroll.scrollHeight > doc.imageScroll.clientHeight + 1;
        doc.imageScroll.classList.toggle('can-pan', canPan);
    });
    if (doc === file) updateStatus();
}

function zoomImageBy(doc, deltaY) {
    if (!doc || !doc.imageWidth || !deltaY) return;
    const base = doc.imageScale || 1;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    doc.imageZoom = Math.min(8, Math.max(0.05, Math.round(base * factor * 1000) / 1000));
    applyImageZoom(doc);
}

function loadImagePreview(doc) {
    if (!doc || !doc.image) return;
    createImageView(doc);
    if (!doc.imageNode) return;
    if (doc.imageUrl) {
        doc.imageStatus.classList.add('hidden');
        if (doc.imageNode.getAttribute('src') !== doc.imageUrl) doc.imageNode.src = doc.imageUrl;
        applyImageZoom(doc);
        return;
    }
    if (doc.imageLoading) return;
    doc.imageLoading = true;
    doc.imageError = null;
    doc.imageStatus.textContent = '正在加载图片…';
    doc.imageStatus.classList.remove('hidden');
    doc.imageNode.hidden = true;
    const load = backend.ReadImageDataURL
        ? backend.ReadImageDataURL(doc.path)
        : Promise.reject(new Error('当前后端不支持图片预览'));
    Promise.resolve(load).then((url) => {
        doc.imageLoading = false;
        if (!url || !doc.imageNode) throw new Error('图片数据为空');
        doc.imageUrl = url;
        doc.imageNode.src = url;
    }).catch((err) => {
        doc.imageLoading = false;
        doc.imageError = (err && err.message) || String(err);
        if (!doc.imageStatus) return;
        doc.imageStatus.textContent = '无法预览此图片：' + doc.imageError;
        doc.imageStatus.classList.remove('hidden');
        if (doc === file && currentMode === 'image') {
            flash('图片无法预览，已切换到二进制视图', true);
            switchMode('binary');
        }
    });
}

function showImageView(doc) {
    if (!doc || !doc.image) return;
    createImageView(doc);
    if (doc.pane) doc.pane.classList.add('image-active');
    loadImagePreview(doc);
}

function hideImageView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('image-active');
}

function enterImageView(doc) {
    if (!doc || !doc.image || !doc.editor) return;
    doc.loading = true;
    try {
        doc.editor.setMode('code');
        doc.mode = 'image';
        currentMode = 'image';
        showImageView(doc);
        showBanner(doc, doc.parseError);
        updateStatus();
        updateSearchState();
    } finally {
        doc.loading = false;
    }
}

function enterBinaryView(doc) {
    if (!doc || !doc.binary || !doc.editor) return;
    hideImageView(doc);
    doc.mode = 'binary';
    currentMode = 'binary';
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode('code');
    } catch (e) {
        flash('切换二进制视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    if (doc.pane) doc.pane.classList.add('active');
    applyAceMode();
    showBanner(doc, doc.parseError);
    updateStatus();
    updateSearchState();
    try {
        if (doc.editor.aceEditor) doc.editor.aceEditor.resize();
    } catch (e) {}
}

function showCsvTableView(doc) {
    if (!doc || !doc.format.table) return;
    createCsvTableView(doc);
    if (doc.pane) doc.pane.classList.add('table-active');
    renderCsvTableView(doc);
}

function hideCsvTableView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('table-active');
    if (doc === file && doc.editor && doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function enterCsvTable(doc) {
    if (!doc || !doc.format.table || !doc.editor) return;
    let text;
    try {
        text = currentMode === 'tree' ? doc.format.stringify(doc.editor.get()) : doc.editor.getText();
    } catch (e) {
        flash('无法生成 CSV 表格：' + e.message, true);
        return;
    }
    doc.loading = true;
    try {
        doc.editor.setMode('text');
        doc.editor.setText(text);
        doc.text = text;
        if (!doc.dirty && doc.bases.table == null) doc.bases.table = text;
        doc.mode = 'table';
        currentMode = 'table';
        doc.tableUndo = [];
        doc.tableRedo = [];
        showCsvTableView(doc);
        updateStatus();
        updateSearchState();
    } catch (e) {
        flash('切换表格视图失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function leaveCsvTable(doc, mode) {
    if (!doc || !doc.editor) return;
    if (mode === 'text') {
        hideCsvTableView(doc);
        doc.mode = 'text';
        currentMode = 'text';
        try {
            doc.editor.setMode('text');
        } catch (e) {}
        updateStatus();
        updateSearchState();
        return;
    }
    if (mode !== 'tree') return;
    const text = doc.editor.getText();
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        flash('CSV 解析失败：' + e.message, true);
        return;
    }
    doc.loading = true;
    try {
        doc.editor.setText(JSON.stringify(value, null, 2));
        doc.editor.setMode('tree');
        doc.editor.set(value);
        hideCsvTableView(doc);
        doc.mode = 'tree';
        currentMode = 'tree';
        updateStatus();
        updateSearchState();
    } catch (e) {
        flash('切换树视图失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function createDoc(data) {
    if (data.binary) {
        return {
            id: ++docSeq,
            path: data.path,
            name: data.name,
            size: data.size,
            hexShown: data.hexShown || data.size,
            eol: data.eol || 'lf',
            hasBom: false,
            large: false,
            enc: 'binary',
            content: data.content,
            format: data.image ? formats.image : formats.bytes,
            image: !!data.image,
            treeAvailable: false,
            parseError: null,
            mode: data.image ? 'image' : 'binary',
            text: null,
            rawText: null,
            dirty: false,
            untitled: false,
            binary: true,
            bases: {tree: null, code: null},
        };
    }
    const preview = detectFormat(data.name, '');
    const fsPreview = getFormatSettings(preview.id);
    const format = detectFormat(data.name, data.content, {indent: fsPreview.indent});
    const fs = getFormatSettings(format.id);
    let treeAvailable = !(data.large || format.rawOnly);
    let parseError = null;
    if (treeAvailable && !String(data.content || '').trim()) {
        treeAvailable = false;
    } else if (treeAvailable) {
        try {
            format.parse(data.content);
        } catch (e) {
            treeAvailable = false;
            parseError = e;
        }
    }
    const preferredMode = format.preview
        ? (['preview', 'code', 'text'].includes(fs.view) ? fs.view : 'preview')
        : format.table
            ? (['table', 'tree', 'text'].includes(fs.view) ? fs.view : 'table')
            : (fs.view === 'code' || fs.view === 'text' ? fs.view : 'tree');
    return {
        id: ++docSeq,
        path: data.path,
        name: data.name,
        size: data.size,
        eol: data.eol,
        hasBom: data.hasBom,
        large: data.large,
        enc: data.enc,
        content: data.content,
        format,
        treeAvailable,
        parseError,
        mode: format.preview ? (data.large ? 'code' : preferredMode) : (treeAvailable ? preferredMode : 'code'),
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null, text: null, table: null, preview: null},
    };
}

function setFilename(name, path) {
    els.filenameText.textContent = name || '';
    els.filename.title = path || name || '';
    const icon = els.filenameIcon;
    icon.textContent = '';
    icon.className = 'title-icon';
    delete icon.dataset.fi;
    if (!name || name === '未打开文件') return;
    const spec = fileIconSpec(name);
    icon.innerHTML = spec.svg;
    icon.classList.add(spec.className);
    icon.dataset.fi = spec.id;
}

function updateDocChrome() {
    if (!file) return;
    setFilename(file.name, file.path);
    renderBreadcrumb(file.path);
    showBanner(file, file.parseError);
    els.welcome.classList.add('hidden');
    els.editor.classList.remove('hidden');
    els.searchInput.value = '';
    if (editor && editor.searchBox) editor.searchBox.clear();
    updateWindowTitle();
    updateStatus();
    updateSearchState();
    renderTabs();
}

function showWelcome() {
    cancelAutoSave();
    if (editor) {
        editor.destroy();
        editor = null;
    }
    file = null;
    dirty = false;
    currentMode = 'tree';
    els.editor.classList.add('hidden');
    els.welcome.classList.remove('hidden');
    setFilename('未打开文件', '');
    els.filename.classList.remove('dirty');
    els.breadcrumb.textContent = '';
    els.stDirty.textContent = '';
    els.stMessage.textContent = '';
    els.stMode.textContent = '';
    els.stSize.textContent = '';
    els.stEol.textContent = '';
    els.stEnc.textContent = '';
    els.stEol.style.display = '';
    els.stEnc.style.display = '';
    els.banner.classList.add('hidden');
    els.searchInput.value = '';
    closeFootPopover();
    closeDialogs();
    updateSearchState();
    renderTabs();
    updateBackendDirty();
    updateWindowTitle();
    syncExplorerActive();
}

let activateToken = 0;

async function activateDoc(doc) {
    if (!doc || doc === file) return;
    const token = ++activateToken;
    cancelAutoSave();
    if (settings.autoSave && file && dirty && file.path && !file.large) {
        await save({auto: true});
        if (token !== activateToken) return;
    }
    snapshotActiveDoc();
    file = doc;
    dirty = !!doc.dirty;
    currentMode = doc.mode || 'tree';
    els.welcome.classList.add('hidden');
    els.editor.classList.remove('hidden');
    for (const d of docs) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    doc.pane.classList.add('active');
    editor = doc.editor;
    updateDocChrome();
    setDirty(doc.dirty);
    applyAceMode();
    humanizeCounts();
    if (editor && editor.aceEditor) {
        setTimeout(() => {
            if (editor === doc.editor && editor && editor.aceEditor) editor.aceEditor.resize();
        }, 0);
    }
    syncExplorerActive();
}

function requestCloseDoc(doc) {
    if (!doc) return;
    if (doc === file) flushCsvCellEditor();
    if (doc.dirty) {
        openCloseConfirm('“' + doc.name + '”有未保存的修改，关闭标签后将丢弃。', () => closeDocNow(doc));
    } else {
        closeDocNow(doc);
    }
}

function closeDocNow(doc) {
    const idx = docs.indexOf(doc);
    if (idx < 0) return;
    const wasActive = doc === file;
    if (doc.path) {
        closedTabs.push({path: doc.path, name: doc.name});
        if (closedTabs.length > 12) closedTabs.shift();
    }
    docs.splice(idx, 1);
    if (doc.editor) {
        doc.editor.destroy();
        doc.editor = null;
    }
    if (doc.pane) {
        doc.pane.remove();
        doc.pane = null;
    }
    if (docs.length === 0) {
        editor = null;
        showWelcome();
        return;
    }
    if (wasActive) {
        editor = null;
        file = null;
        dirty = false;
        const next = docs[Math.min(idx, docs.length - 1)];
        activateDoc(next);
    } else {
        renderTabs();
        updateBackendDirty();
    }
}

function showPathInFolder(path) {
    if (!path) return;
    backend.ShowInFolder(path).catch((e) => flash('打开文件位置失败：' + e, true));
}

function closeDocsWithConfirm(list, message) {
    const targets = (list || []).filter((doc) => docs.includes(doc));
    if (!targets.length) return;
    const run = () => {
        for (const doc of targets.slice()) closeDocNow(doc);
    };
    if (targets.some((doc) => doc.dirty)) {
        openCloseConfirm(message || '有未保存的修改，关闭后将丢弃。', run);
    } else {
        run();
    }
}

function reopenClosedTab() {
    const entry = closedTabs.pop();
    if (!entry) return;
    openPath(entry.path);
}

function showTabMenu(doc, x, y) {
    if (!ctxMenu || !doc) return;
    const idx = docs.indexOf(doc);
    const others = docs.filter((d) => d !== doc);
    const left = docs.slice(0, Math.max(0, idx));
    const clean = docs.filter((d) => !d.dirty);
    const hasPath = !!doc.path;
    ctxMenu.open([
        {label: '关闭', shortcut: 'Ctrl+W', icon: 'E8BB', action: () => requestCloseDoc(doc)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => closeDocsWithConfirm(others)},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭左侧标签页', disabled: !left.length, action: () => closeDocsWithConfirm(left)},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => copyText(doc.path, '路径')},
        {label: '复制文件名', icon: 'E8C8', action: () => copyText(doc.name, '文件名')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: () => showPathInFolder(doc.path)},
        {sep: true},
        {label: '在新窗口中打开', shortcut: 'Shift+F4', icon: 'E8A7', disabled: !hasPath, action: () => openInNewWindows([doc.path])},
        {label: '重新打开关闭的标签页', shortcut: 'Ctrl+Shift+T', icon: 'E7A7', disabled: !closedTabs.length, action: reopenClosedTab},
    ], x, y);
}

const NEW_FILE_TYPES = [
    {label: 'JSON 文件', name: '新建文件.json'},
    {label: '文本文件', name: '新建文件.txt'},
    {label: 'Markdown 文件', name: '新建文件.md'},
    {label: 'YAML 文件', name: '新建文件.yaml'},
    {label: 'XML 文件', name: '新建文件.xml'},
    {label: 'CSV 文件', name: '新建文件.csv'},
    {label: 'TOML 文件', name: '新建文件.toml'},
    {label: 'JSONL 文件', name: '新建文件.jsonl'},
    {label: 'INI 文件', name: '新建文件.ini'},
    {label: 'Properties 文件', name: '新建文件.properties'},
    {sep: true},
    {label: 'JavaScript 文件', name: '新建文件.js'},
    {label: 'TypeScript 文件', name: '新建文件.ts'},
    {label: 'HTML 文件', name: '新建文件.html'},
    {label: 'CSS 文件', name: '新建文件.css'},
    {label: 'Python 文件', name: '新建文件.py'},
    {label: 'Shell 脚本', name: '新建文件.sh'},
    {label: 'PowerShell 脚本', name: '新建文件.ps1'},
    {label: '批处理文件', name: '新建文件.bat'},
    {label: 'SQL 文件', name: '新建文件.sql'},
    {label: 'Go 文件', name: '新建文件.go'},
    {label: 'Java 文件', name: '新建文件.java'},
    {label: 'Kotlin 文件', name: '新建文件.kt'},
    {label: 'Lua 脚本', name: '新建文件.lua'},
];

function remapPathValue(path, oldPath, newPath) {
    if (!path) return path;
    const target = String(path).replace(/\\/g, '/');
    const oldNorm = String(oldPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!oldNorm) return path;
    const lowerTarget = target.toLowerCase();
    const lowerOld = oldNorm.toLowerCase();
    if (lowerTarget === lowerOld) return newPath;
    if (!lowerTarget.startsWith(lowerOld + '/')) return path;
    return String(newPath).replace(/\\/g, '/').replace(/\/+$/, '') + target.slice(oldNorm.length);
}

function parentFolderOf(path) {
    const text = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const index = text.lastIndexOf('/');
    if (index < 0) return '';
    let dir = text.slice(0, index);
    if (/^[a-z]:$/i.test(dir)) dir += '/';
    return dir;
}

function samePathValue(a, b) {
    const left = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const right = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!left && left === right;
}

function pathWithinValue(root, target) {
    const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const child = String(target || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!base && (child === base || child.startsWith(base + '/'));
}

function clipboardItems(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    const out = [];
    for (const item of list) {
        if (!item || !item.path) continue;
        if (out.some((entry) => samePathValue(entry.path, item.path))) continue;
        out.push({path: item.path, name: item.name || baseNameOf(item.path), isDir: !!item.isDir});
    }
    return out;
}

function setFileClipboard(targets, cut) {
    const all = clipboardItems(targets);
    const items = all.filter((item) =>
        !all.some((other) =>
            other.isDir && !samePathValue(other.path, item.path) && pathWithinValue(other.path, item.path)));
    if (!items.length) return;
    const same = fileClipboard && fileClipboard.cut === !!cut &&
        fileClipboard.items.length === items.length &&
        items.every((item) => fileClipboard.items.some((old) => samePathValue(old.path, item.path)));
    if (same) {
        if (explorer) explorer.setCutPaths(cut ? items.map((item) => item.path) : []);
        return;
    }
    fileClipboard = {items, cut: !!cut};
    if (explorer) explorer.setCutPaths(cut ? items.map((item) => item.path) : []);
    flash(items.length === 1
        ? (cut ? '已剪切：' : '已复制：') + items[0].name
        : (cut ? '已剪切 ' : '已复制 ') + items.length + ' 项');
}

function applyMovedPath(oldPath, newPath) {
    let activeChanged = false;
    let rootChanged = false;
    for (const doc of docs) {
        if (!doc.path) continue;
        const next = remapPathValue(doc.path, oldPath, newPath);
        if (next === doc.path) continue;
        doc.path = next;
        doc.name = baseNameOf(next);
        if (doc === file) activeChanged = true;
    }
    if (workspaceFolder) {
        const next = remapPathValue(workspaceFolder, oldPath, newPath);
        if (next !== workspaceFolder) {
            workspaceFolder = next;
            rootChanged = true;
        }
    }
    for (const entry of closedTabs) {
        if (entry.path) entry.path = remapPathValue(entry.path, oldPath, newPath);
    }
    if (activeChanged && file) {
        setFilename(file.name, file.path);
        renderBreadcrumb(file.path);
        updateWindowTitle();
    }
    renderTabs();
    return {activeChanged, rootChanged};
}

async function runPasteItems(clip, destDir, names) {
    if (!clip || !clip.items.length) throw new Error('剪贴板中没有文件');
    if (!backend.CopyEntry || !backend.MoveEntry) throw new Error('当前版本不支持粘贴');
    const cut = !!clip.cut;
    const results = [];
    const errors = [];
    for (const item of clip.items) {
        const name = (names && names[item.path]) || item.name;
        try {
            const newPath = cut
                ? await backend.MoveEntry(item.path, destDir, name)
                : await backend.CopyEntry(item.path, destDir, name);
            results.push({...item, newPath});
        } catch (e) {
            errors.push({item, error: (e && e.message) || String(e)});
        }
    }
    let activeChanged = false;
    let rootChanged = false;
    if (cut && results.length) {
        for (const result of results) {
            const flags = applyMovedPath(result.path, result.newPath);
            activeChanged = activeChanged || flags.activeChanged;
            rootChanged = rootChanged || flags.rootChanged;
            if (explorer) explorer.removePath(result.path);
        }
        const moved = new Set(results.map((result) => result.path));
        const remaining = clip.items.filter((item) => !moved.has(item.path));
        if (remaining.length) {
            fileClipboard = {items: remaining, cut: true};
            if (explorer) explorer.setCutPaths(remaining.map((item) => item.path));
        } else {
            fileClipboard = null;
            if (explorer) explorer.setCutPaths([]);
        }
    }
    if (rootChanged && explorer) explorer.setRoot(workspaceFolder);
    if (explorer && results.length) {
        await explorer.refreshDir(destDir);
        explorer.selectPaths(results.map((result) => ({
            path: result.newPath,
            name: baseNameOf(result.newPath),
            isDir: result.isDir,
        })));
        if (activeChanged && file) explorer.setActive(file.path);
    }
    return {
        okCount: results.length,
        failCount: errors.length,
        firstError: errors.length ? errors[0].error : '',
        results,
    };
}

async function pasteFileClipboard(targetInfo) {
    if (!fileClipboard || !fileClipboard.items.length) {
        flash('剪贴板中没有文件', true);
        return;
    }
    if (settings.readOnlyMode) {
        flash('只读模式下不能粘贴', true);
        return;
    }
    const clip = fileClipboard;
    const destDir = targetInfo && targetInfo.isDir ? targetInfo.path : parentFolderOf(targetInfo && targetInfo.path);
    if (!destDir) {
        flash('无法确定粘贴目录', true);
        return;
    }
    const items = clip.items.filter((item) => {
        if (item.isDir && pathWithinValue(item.path, destDir)) return false;
        if (clip.cut && samePathValue(parentFolderOf(item.path), destDir)) return false;
        return true;
    });
    if (!items.length) {
        flash(clip.cut ? '源文件已经在该目录中' : '不能粘贴到文件夹自身或其子目录', true);
        return;
    }
    const skipped = clip.items.length - items.length;
    if (items.length === 1 && clip.items.length === 1) {
        const item = items[0];
        let suggested;
        try {
            suggested = await backend.SuggestCopyName(destDir, item.name, item.isDir);
        } catch (e) {
            flash('粘贴失败：' + e, true);
            return;
        }
        if (suggested === item.name) {
            try {
                const result = await runPasteItems({items, cut: clip.cut}, destDir);
                if (result.failCount) flash('粘贴失败：' + result.firstError, true);
                else flash((clip.cut ? '已移动：' : '已粘贴：') + item.name);
            } catch (e) {
                flash('粘贴失败：' + e, true);
            }
            return;
        }
        openNameDialog({
            title: clip.cut ? '移动' : '粘贴',
            label: '新名称',
            value: suggested,
            selectStem: !item.isDir,
            okLabel: clip.cut ? '移动' : '粘贴',
            onSubmit: async (name) => {
                const result = await runPasteItems({items, cut: clip.cut}, destDir, {[item.path]: name});
                if (result.failCount) throw new Error(result.firstError);
            },
        });
        return;
    }
    const names = {};
    let renamed = 0;
    for (const item of items) {
        try {
            const suggested = await backend.SuggestCopyName(destDir, item.name, item.isDir);
            if (suggested !== item.name) {
                names[item.path] = suggested;
                renamed++;
            }
        } catch (e) {
            flash('粘贴失败：' + e, true);
            return;
        }
    }
    try {
        const result = await runPasteItems({items, cut: clip.cut}, destDir, names);
        if (result.failCount) {
            flash('已粘贴 ' + result.okCount + ' 项，' + result.failCount + ' 项失败：' + result.firstError, true);
        } else {
            flash((clip.cut ? '已移动 ' : '已粘贴 ') + result.okCount + ' 项' +
                (renamed ? '（' + renamed + ' 项自动重命名）' : '') +
                (skipped ? '，跳过 ' + skipped + ' 项' : ''));
        }
    } catch (e) {
        flash('粘贴失败：' + e, true);
    }
}

function openCreateEntryDialog(dirPath, isDir, suggestedName, title) {
    openNameDialog({
        title: title || (isDir ? '新建文件夹' : '新建文件'),
        label: isDir ? '文件夹名称' : '文件名',
        value: suggestedName || '',
        placeholder: isDir ? '例如：config' : '例如：data.json',
        selectStem: !isDir,
        okLabel: '创建',
        onSubmit: async (name) => {
            if (!backend.CreateEntry) throw new Error('当前版本不支持新建');
            const target = await backend.CreateEntry(dirPath, name, isDir);
            if (explorer) {
                await explorer.refreshDir(dirPath);
                explorer.selectPath(target, isDir);
            }
            if (isDir) {
                flash('已新建文件夹：' + name.trim());
            } else {
                await openPath(target);
            }
        },
    });
}

function newFileMenuItems(dirPath) {
    const items = [];
    for (const type of NEW_FILE_TYPES) {
        if (type.sep) {
            items.push({sep: true});
            continue;
        }
        const spec = fileIconSpec(type.name);
        const dot = type.name.lastIndexOf('.');
        items.push({
            label: type.label,
            shortcut: dot >= 0 ? type.name.slice(dot) : '',
            iconHtml: spec.svg,
            iconClass: spec.className,
            action: () => openCreateEntryDialog(dirPath, false, type.name, '新建 ' + type.label),
        });
    }
    items.push({sep: true});
    items.push({label: '文件…', icon: 'E7C3', action: () => openCreateEntryDialog(dirPath, false, '', '新建文件')});
    items.push({label: '目录…', icon: 'E8B7', action: () => openCreateEntryDialog(dirPath, true, '新建文件夹', '新建文件夹')});
    return items;
}

function applyRenamedPath(oldPath, newPath) {
    let activeChanged = false;
    for (const doc of docs) {
        if (!doc.path) continue;
        const next = remapPathValue(doc.path, oldPath, newPath);
        if (next === doc.path) continue;
        doc.path = next;
        doc.name = baseNameOf(next);
        if (doc === file) activeChanged = true;
    }
    if (workspaceFolder) workspaceFolder = remapPathValue(workspaceFolder, oldPath, newPath);
    for (const entry of closedTabs) {
        if (entry.path) entry.path = remapPathValue(entry.path, oldPath, newPath);
    }
    if (fileClipboard) {
        for (const item of fileClipboard.items) {
            const next = remapPathValue(item.path, oldPath, newPath);
            if (next === item.path) continue;
            item.path = next;
            item.name = baseNameOf(next);
        }
    }
    if (explorer) {
        explorer.pathRenamed(oldPath, newPath);
        if (fileClipboard && fileClipboard.cut) explorer.setCutPaths(fileClipboard.items.map((item) => item.path));
        if (activeChanged && file) explorer.setActive(file.path);
    }
    if (activeChanged && file) {
        setFilename(file.name, file.path);
        renderBreadcrumb(file.path);
        updateWindowTitle();
    }
    renderTabs();
    flash('已重命名为：' + baseNameOf(newPath));
}

function openRenameEntryDialog(info) {
    openNameDialog({
        title: info.isDir ? '重命名文件夹' : '重命名文件',
        label: '新名称',
        value: info.name,
        selectStem: !info.isDir,
        okLabel: '重命名',
        onSubmit: async (name) => {
            if (!backend.RenameEntry) throw new Error('当前版本不支持重命名');
            const newPath = await backend.RenameEntry(info.path, name);
            if (newPath && newPath !== info.path) applyRenamedPath(info.path, newPath);
        },
    });
}

function relativePathFrom(path, root) {
    if (!path || !root) return '';
    const target = String(path).replace(/\\/g, '/');
    const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!base) return '';
    const lowerTarget = target.toLowerCase();
    const lowerBase = base.toLowerCase();
    if (lowerTarget === lowerBase) return '.';
    if (!lowerTarget.startsWith(lowerBase + '/')) return '';
    return target.slice(base.length + 1);
}

function copyPathMenuItems(targets) {
    const list = clipboardItems(targets);
    const root = workspaceFolder || (explorer && explorer.getRoot ? explorer.getRoot() : '');
    const absolute = list.map((item) => item.path).join('\r\n');
    const relativeParts = list.map((item) => relativePathFrom(item.path, root));
    const relative = relativeParts.every(Boolean) ? relativeParts.join('\r\n') : '';
    const names = list.map((item) => item.name).join('\r\n');
    return [
        {label: '绝对路径', disabled: !absolute, action: () => copyText(absolute, '绝对路径')},
        {label: '相对路径', disabled: !relative, action: () => copyText(relative, '相对路径')},
        {sep: true},
        {label: '文件名', disabled: !names, action: () => copyText(names, '文件名')},
    ];
}

function showExplorerMenu(info, x, y, node) {
    if (!ctxMenu || !info) return;
    const isDir = !!info.isDir;
    const selected = explorer ? explorer.getSelection() : [];
    const targets = selected.length ? selected : [{path: info.path, name: info.name, isDir}];
    const items = [];
    if (isDir) {
        items.push({
            label: '新建',
            icon: 'E710',
            disabled: !!settings.readOnlyMode,
            submenu: newFileMenuItems(info.path),
        });
    } else {
        items.push({label: '打开', icon: 'E8E5', action: () => openPath(info.path)});
        items.push({label: '在新窗口中打开', icon: 'E8A7', action: () => openInNewWindows([info.path])});
    }
    items.push({sep: true});
    items.push({label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', action: () => setFileClipboard(targets, false)});
    items.push({
        label: '剪切',
        shortcut: 'Ctrl+X',
        icon: 'E8C6',
        disabled: !!settings.readOnlyMode,
        action: () => setFileClipboard(targets, true),
    });
    items.push({
        label: '粘贴',
        shortcut: 'Ctrl+V',
        icon: 'E77F',
        disabled: !!settings.readOnlyMode || !fileClipboard || !fileClipboard.items.length,
        action: () => pasteFileClipboard(info),
    });
    items.push({sep: true});
    if (isDir) {
        items.push({
            label: node && node.expanded ? '收起目录' : '展开目录',
            icon: 'E70D',
            disabled: !node,
            action: () => explorer && explorer.toggleNode(node),
        });
        items.push({label: '设为文件树根目录', icon: 'E8B7', action: () => openFolderWorkspace(info.path)});
        items.push({sep: true});
    }
    items.push({
        label: '重命名…',
        shortcut: 'F2',
        icon: 'E8AC',
        disabled: !!settings.readOnlyMode || targets.length !== 1,
        action: () => openRenameEntryDialog(info),
    });
    items.push({label: '复制路径', icon: 'E8C8', submenu: copyPathMenuItems(targets)});
    items.push({label: '在文件管理器中显示', icon: 'E8B7', action: () => showPathInFolder(info.path)});
    items.push({sep: true});
    items.push({label: '刷新', icon: 'E72C', action: () => explorer && explorer.refresh()});
    ctxMenu.open(items, x, y);
}

function selectedText() {
    if (!editor) return '';
    if (currentMode === 'code' && editor.aceEditor) return editor.aceEditor.getSelectedText();
    if (currentMode === 'text') {
        const ta = textArea();
        if (ta) return ta.value.slice(ta.selectionStart, ta.selectionEnd);
    }
    return '';
}

async function ctxCopy() {
    const text = selectedText();
    if (text) await copyText(text, '所选内容');
}

async function ctxCut() {
    if (!editor || file.binary || file.large) return;
    if (currentMode === 'code' && editor.aceEditor) {
        const ace = editor.aceEditor;
        const text = ace.getSelectedText();
        if (!text) return;
        if (!(await copyText(text, '所选内容'))) return;
        ace.session.replace(ace.getSelectionRange(), '');
        ace.focus();
    } else if (currentMode === 'text') {
        const ta = textArea();
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start === end) return;
        if (!(await copyText(ta.value.slice(start, end), '所选内容'))) return;
        ta.setRangeText('', start, end, 'end');
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        ta.focus();
    }
}

async function ctxPaste() {
    if (!editor || file.binary || file.large) return;
    if (!backend.GetClipboardText) return;
    let text = '';
    try {
        text = await backend.GetClipboardText();
    } catch (e) {
        flash('读取剪贴板失败：' + e, true);
        return;
    }
    if (!text) return;
    if (currentMode === 'code' && editor.aceEditor) {
        editor.aceEditor.focus();
        editor.aceEditor.insert(text);
    } else if (currentMode === 'text') {
        const ta = textArea();
        if (!ta) return;
        ta.focus();
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', {bubbles: true}));
    }
}

function ctxSelectAll() {
    if (currentMode === 'code' && editor && editor.aceEditor) {
        editor.aceEditor.focus();
        editor.aceEditor.selectAll();
    } else if (currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            ta.select();
        }
    }
}

function ctxFind() {
    if (currentMode === 'code' && editor && editor.aceEditor) {
        editor.aceEditor.focus();
        editor.aceEditor.execCommand('find');
    }
}

function ctxFold(command) {
    if (currentMode === 'code' && editor && editor.aceEditor) {
        editor.aceEditor.execCommand(command);
    }
}

function showEditorMenu(x, y) {
    if (!ctxMenu || !file) return;
    const code = currentMode === 'code' && !!editor && !!editor.aceEditor;
    const text = currentMode === 'text';
    const editable = code || text;
    const readonly = !!file.binary || !!file.large || !!settings.readOnlyMode;
    const hasPath = !!file.path;
    ctxMenu.open([
        {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', disabled: readonly, action: doUndo},
        {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', disabled: readonly, action: doRedo},
        {sep: true},
        {label: '剪切', shortcut: 'Ctrl+X', icon: 'E8C6', disabled: !editable || readonly, action: ctxCut},
        {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !editable, action: ctxCopy},
        {label: '粘贴', shortcut: 'Ctrl+V', icon: 'E77F', disabled: !editable || readonly, action: ctxPaste},
        {label: '全选', shortcut: 'Ctrl+A', icon: 'E8B3', disabled: !editable, action: ctxSelectAll},
        {sep: true},
        {label: '查找…', shortcut: 'Ctrl+F', icon: 'E721', disabled: !code, action: ctxFind},
        {label: '格式化', shortcut: 'Ctrl+Alt+L', disabled: !file || readonly || !!file.format.rawOnly, action: formatDocument},
        {label: '重新加载', icon: 'E72C', disabled: !hasPath, action: requestReload},
        {sep: true},
        {
            label: '折叠',
            icon: 'E70D',
            disabled: !code,
            submenu: [
                {label: '折叠当前', action: () => ctxFold('fold')},
                {label: '展开当前', action: () => ctxFold('unfold')},
                {sep: true},
                {label: '全部折叠', action: () => ctxFold('foldall')},
                {label: '全部展开', action: () => ctxFold('unfoldall')},
            ],
        },
        {sep: true},
        {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => copyText(file.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: showInFolder},
    ], x, y);
}

function showBlankMenu(x, y) {
    if (!ctxMenu) return;
    const items = [
        {label: '新建', shortcut: 'Ctrl+N', icon: 'E710', action: newDocument},
        {label: '打开文件…', shortcut: 'Ctrl+O', icon: 'E8E5', action: openDialog},
        {label: '打开文件夹…', icon: 'E8B7', action: openFolderDialog},
    ];
    if (workspaceFolder) items.push({label: '关闭文件夹', icon: 'E8BB', action: closeFolder});
    items.push({sep: true}, {label: '设置…', shortcut: 'Ctrl+,', icon: 'E713', action: () => openSettings('general')});
    ctxMenu.open(items, x, y);
}

function initContextMenus() {
    ctxMenu = createContextMenu();
    if (!els.mainPane) return;
    els.mainPane.addEventListener('contextmenu', (e) => {
        if (e.target.closest && e.target.closest('.ctx-menu')) return;
        if (!file) {
            e.preventDefault();
            e.stopPropagation();
            showBlankMenu(e.clientX, e.clientY);
            return;
        }
        if (currentMode === 'tree' || currentMode === 'table' || currentMode === 'preview' ||
            currentMode === 'image' || currentMode === 'binary') return;
        e.preventDefault();
        e.stopPropagation();
        showEditorMenu(e.clientX, e.clientY);
    });
}

function findDocByPath(path) {
    const key = String(path || '').replace(/\\/g, '/').toLowerCase();
    return docs.find((d) => String(d.path || '').replace(/\\/g, '/').toLowerCase() === key) || null;
}

async function openPathsHere(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    let target = null;
    let lastNew = null;
    let lastError = null;
    for (const path of list) {
        const existing = findDocByPath(path);
        if (existing) {
            target = existing;
            continue;
        }
        try {
            const base = String(path).split(/[\\/]/).pop();
            const preview = detectFormat(base, '');
            const enc = getFormatSettings(preview.id).encoding;
            const data = await backend.OpenFile(path, enc);
            if (data && data.isDir) {
                openFolderWorkspace(data.path);
                continue;
            }
            const doc = createDoc(data);
            docs.push(doc);
            target = doc;
            lastNew = doc;
        } catch (e) {
            lastError = e;
        }
    }
    if (target) await activateDoc(lastNew || target);
    if (lastError) flash('打开失败：' + lastError, true);
}

async function openInNewWindows(paths) {
    try {
        await backend.OpenInNewWindows(paths);
        flash('已在新窗口打开 ' + paths.length + ' 个文件');
    } catch (e) {
        flash('打开新窗口失败：' + e, true);
    }
}

async function openPaths(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    if (settings.openMode === 'window') {
        if (docs.length === 0) {
            await openPathsHere([list[0]]);
            if (list.length > 1) await openInNewWindows(list.slice(1));
        } else {
            await openInNewWindows(list);
        }
        return;
    }
    await openPathsHere(list);
}

async function openPath(path) {
    await openPaths([path]);
}

function waitUntil(check, timeout = 1200) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            try {
                if (check()) return resolve(true);
            } catch (e) {}
            if (Date.now() - start >= timeout) return resolve(false);
            setTimeout(tick, 30);
        };
        tick();
    });
}

async function selectLineInDoc(doc, line, column = 0) {
    if (!doc || doc.binary || !doc.editor) return;
    if (doc !== file) await activateDoc(doc);
    const mode = doc.format && doc.format.table ? 'text' : 'code';
    if (currentMode !== mode) switchMode(mode);
    if (mode === 'code') {
        const ready = await waitUntil(() => doc.editor && doc.editor.aceEditor);
        if (!ready) return;
        const ace = doc.editor.aceEditor;
        const lineCount = ace.session.getLength();
        const lineNo = Math.max(1, Math.min(Number(line) || 1, lineCount));
        ace.gotoLine(lineNo, Math.max(0, (Number(column) || 1) - 1), false);
        ace.selection.selectLine();
        ace.scrollToLine(lineNo, true, true, () => {});
        ace.focus();
        return;
    }
    const ready = await waitUntil(() => doc.pane && doc.pane.querySelector('textarea.jsoneditor-text'));
    if (!ready) return;
    const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
    const lines = textarea.value.split('\n');
    const index = Math.max(0, Math.min((Number(line) || 1) - 1, lines.length - 1));
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    const end = start + lines[index].length;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, index * lineHeight - textarea.clientHeight / 2);
}

async function openTargets(targets) {
    const list = Array.isArray(targets) ? targets : [];
    for (const target of list) {
        if (!target || !target.path) continue;
        await openPaths([target.path]);
        if (!target.line) continue;
        const doc = findDocByPath(target.path);
        if (doc) await selectLineInDoc(doc, target.line, target.column);
    }
}

async function openDialog() {
    try {
        const paths = await backend.OpenFilesDialog();
        const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
        if (list.length) await openPaths(list);
    } catch (e) {
        flash('打开失败：' + e, true);
    }
}

function baseNameOf(path) {
    const s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

function defaultFolderDir() {
    if (workspaceFolder) return workspaceFolder;
    if (file && file.path) {
        const s = String(file.path).replace(/\\/g, '/');
        const i = s.lastIndexOf('/');
        if (i > 0) return s.slice(0, i);
    }
    return '';
}

async function openFolderDialog() {
    try {
        const dir = await backend.OpenFolderDialog(defaultFolderDir());
        if (dir) openFolderWorkspace(dir);
    } catch (e) {
        flash('打开文件夹失败：' + e, true);
    }
}

function openFolderWorkspace(dir) {
    if (!dir) return;
    workspaceFolder = dir;
    settings.sidebarMode = 'tree';
    settings.showSidebar = true;
    applySettings();
    if (explorer) {
        explorer.setMode('tree', false);
        explorer.setRoot(dir);
    }
    applySidebarUI();
    flash('已打开文件夹：' + (baseNameOf(dir) || dir));
}

function closeFolder() {
    if (!workspaceFolder) return;
    workspaceFolder = null;
    if (explorer) explorer.setRoot(null);
    flash('已关闭文件夹');
}

function applySidebarUI() {
    if (!els.sidebar) return;
    els.sidebar.classList.toggle('hidden', !settings.showSidebar);
    if (els.btnSidebar) {
        els.btnSidebar.classList.toggle('active', !!settings.showSidebar);
        els.btnSidebar.setAttribute('aria-pressed', String(!!settings.showSidebar));
    }
    if (els.abFiles) {
        els.abFiles.classList.toggle('active', !!settings.showSidebar);
        els.abFiles.setAttribute('aria-pressed', String(!!settings.showSidebar));
    }
    if (explorer) explorer.setVisible(!!settings.showSidebar);
    requestAnimationFrame(() => {
        if (!editor) return;
        try {
            if (editor.resize) editor.resize();
            if (editor.aceEditor) editor.aceEditor.resize();
        } catch (e) {}
    });
}

function toggleSidebar(force) {
    settings.showSidebar = typeof force === 'boolean' ? force : !settings.showSidebar;
    applySettings();
    applySidebarUI();
}

function setSidebarMode(mode) {
    if (mode !== 'list' && mode !== 'tree') return;
    settings.sidebarMode = mode;
    settings.showSidebar = true;
    applySettings();
    if (explorer) explorer.setMode(mode, false);
    applySidebarUI();
}

function syncExplorerActive() {
    if (explorer) explorer.setActive(file && file.path ? file.path : null);
}

function initActivityBar() {
    if (!els.activityBar) return;
    if (els.abFiles) els.abFiles.addEventListener('click', () => toggleSidebar());
    if (els.abSearch) els.abSearch.addEventListener('click', () => {
        if (els.searchInput.disabled) {
            flash('当前视图不支持节点搜索', true);
            return;
        }
        focusSearch();
    });
    if (els.abMore) els.abMore.addEventListener('click', () => {
        if (!ctxMenu) return;
        const rect = els.abMore.getBoundingClientRect();
        ctxMenu.open(menuItems('view'), rect.right + 6, rect.top - 4);
    });
    if (els.abLock) els.abLock.addEventListener('click', () => {
        if (els.lock) els.lock.click();
    });
    if (els.abTheme) els.abTheme.addEventListener('click', () => {
        if (!ctxMenu) return;
        const rect = els.abTheme.getBoundingClientRect();
        ctxMenu.open(menuItems('theme'), rect.right + 6, rect.top - 4);
    });
    if (els.abSettings) els.abSettings.addEventListener('click', () => openSettings('general'));
    if (els.abAbout) els.abAbout.addEventListener('click', () => openSettings('about'));
    applySidebarUI();
    updateLockButton();
}

function initExplorer() {
    if (!els.sbBody) return;
    explorer = createExplorer({
        body: els.sbBody,
        titleEl: els.sbTitle,
        refreshBtn: els.sbRefresh,
        listBtn: els.sbModeList,
        treeBtn: els.sbModeTree,
        readDir: (path, limit) => backend.ReadDir(path, limit),
        openPath: (path) => openPath(path),
        openFolder: () => openFolderDialog(),
        openFileDialog: () => openDialog(),
        isSupported: isSupportedFile,
        onContextMenu: (info, x, y, node) => showExplorerMenu(info, x, y, node),
        onModeChange: (mode) => {
            settings.sidebarMode = mode;
            applySettings();
        },
    });
    explorer.setMode(settings.sidebarMode, false);
    applySidebarUI();
    if (els.btnSidebar) els.btnSidebar.addEventListener('click', () => toggleSidebar());
    if (els.lock) els.lock.addEventListener('click', () => {
        settings.readOnlyMode = !settings.readOnlyMode;
        applySettings();
        if (settings.readOnlyMode) {
            const hasDirty = docs.some((doc) => doc.dirty);
            flash(hasDirty ? '已切换为只读；有未保存修改，解锁后可保存' : '已切换为只读');
        } else {
            flash('已解除只读锁定');
        }
    });
    if (els.bannerClose) els.bannerClose.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissBanner();
    });
}

let untitledSeq = 0;

function newDocument() {
    const seq = ++untitledSeq;
    const name = seq === 1 ? '未命名.json' : '未命名 ' + seq + '.json';
    const doc = createDoc({
        path: null,
        name,
        content: '{}',
        size: 2,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    doc.dirty = true;
    docs.push(doc);
    activateDoc(doc);
}

async function openNewWindow() {
    try {
        await backend.OpenNewWindow();
    } catch (e) {
        flash('新建窗口失败：' + e, true);
    }
}

async function showInFolder() {
    if (!file || !file.path) return;
    try {
        await backend.ShowInFolder(file.path);
    } catch (e) {
        flash('打开文件位置失败：' + e, true);
    }
}

async function copyText(text, label) {
    if (!text) return false;
    try {
        await backend.CopyText(text);
        flash('已复制' + label);
        return true;
    } catch (e) {
        flash('复制失败：' + e, true);
        return false;
    }
}

async function requestReload() {
    const doc = file;
    if (!doc || !doc.path) return;
    if (doc.dirty) {
        openCloseConfirm('重新加载将丢弃未保存的修改。', () => reloadActive(), '丢弃并重新加载');
    } else {
        await reloadActive();
    }
}

async function reloadActive() {
    const doc = file;
    if (!doc || !doc.path) return;
    try {
        const data = await backend.OpenFile(doc.path, getFormatSettings(doc.format.id).encoding);
        const fresh = createDoc(data);
        const keepMode = doc.mode;
        if (doc.editor) doc.editor.destroy();
        if (doc.pane) doc.pane.remove();
        doc.editor = null;
        doc.pane = null;
        doc.tableEl = null;
        doc.tableScroll = null;
        doc.tableMeta = null;
        doc.tableUndo = [];
        doc.tableRedo = [];
        doc.previewEl = null;
        doc.previewScroll = null;
        doc.previewBody = null;
        if (doc.imageResizeObserver) {
            doc.imageResizeObserver.disconnect();
            doc.imageResizeObserver = null;
        }
        doc.imageEl = null;
        doc.imageScroll = null;
        doc.imageCanvas = null;
        doc.imageNode = null;
        doc.imageStatus = null;
        doc.imageUrl = null;
        doc.imageLoading = false;
        doc.imageError = null;
        doc.imageWidth = 0;
        doc.imageHeight = 0;
        doc.imageScale = 0;
        doc.imageZoom = null;
        doc.imagePan = null;
        doc.loading = false;
        doc.bannerDismissed = false;
        Object.assign(doc, fresh, {id: doc.id, dirty: false, untitled: false, text: null, content: data.content});
        let nextMode = keepMode;
        if (doc.binary) {
            nextMode = doc.image && keepMode === 'image' ? 'image' : 'binary';
        } else if (doc.format.preview) {
            if (doc.large) nextMode = 'code';
            else if (!['preview', 'code', 'text'].includes(nextMode)) nextMode = 'preview';
        } else if (!doc.treeAvailable) {
            nextMode = 'code';
        } else if (!['code', 'text', 'table'].includes(nextMode)) {
            nextMode = 'tree';
        }
        if (nextMode === 'table' && !doc.format.table) nextMode = 'tree';
        doc.mode = nextMode;
        editor = null;
        createDocEditor(doc);
        doc.pane.classList.add('active');
        editor = doc.editor;
        currentMode = doc.mode;
        updateDocChrome();
        setDirty(false);
        applyAceMode();
        humanizeCounts();
        flash('已重新加载 ' + doc.name);
    } catch (e) {
        flash('重新加载失败：' + e, true);
    }
}

async function saveDoc(doc, opts = {}) {
    if (!doc || doc.large || doc.binary || !doc.editor) return false;
    if (settings.readOnlyMode) {
        if (!opts.auto && !opts.silent) flash('只读锁定中，解锁后才能保存', true);
        return false;
    }
    if (doc === file) flushCsvCellEditor();
    const fmt = doc.format;
    const fs = getFormatSettings(fmt.id);
    const savedMode = doc.mode;
    const snapshot = doc.editor.getText();
    let text;
    if (!doc.dirty && doc.rawText != null) {
        text = doc.rawText;
    } else if (savedMode === 'table' || savedMode === 'code' || savedMode === 'text' || fmt.rawOnly) {
        text = snapshot;
        if (!fmt.rawOnly) {
            try {
                fmt.parse(text);
            } catch (e) {
                if (!opts.auto) flash(fmt.name + ' 无效，未保存：' + e.message, true);
                return false;
            }
        }
    } else {
        let value;
        try {
            value = JSON.parse(snapshot);
        } catch (e) {
            if (!opts.auto) flash('无法读取树内容：' + e.message, true);
            return false;
        }
        text = fmt.stringify(value);
    }
    let path = doc.path;
    if (opts.saveAs || !path) {
        if (opts.auto) return false;
        path = await backend.SaveFileDialog(doc.name || '未命名.json');
        if (!path) return false;
    }
    try {
        const eol = fs.eol === 'follow' ? doc.eol : fs.eol;
        const enc = fs.encoding === 'auto' ? (doc.enc || 'utf-8') : fs.encoding;
        await backend.SaveFile(path, text, eol, doc.hasBom, enc);
        doc.enc = enc;
        doc.path = path;
        doc.name = path.split(/[\\/]/).pop();
        doc.untitled = false;
        doc.mode = savedMode;
        doc.text = snapshot;
        doc.bases[savedMode] = snapshot;
        if (doc.treeAvailable) doc.rawText = text;
        if (doc.parseError) {
            doc.parseError = null;
            if (file === doc) els.banner.classList.add('hidden');
        }
        if (file === doc) {
            const now = doc.editor ? doc.editor.getText() : snapshot;
            if (now !== snapshot) {
                doc.text = now;
                doc.mode = currentMode;
            }
            updateStatus();
            setFilename(doc.name, doc.path);
            renderBreadcrumb(doc.path);
            renderTabs();
            setDirty(now !== snapshot);
            updateWindowTitle();
        } else {
            doc.dirty = false;
            updateTabDirty(doc);
            renderTabs();
            updateBackendDirty();
        }
        if (!opts.auto && !opts.silent) flash('已保存 ' + doc.name);
        return true;
    } catch (e) {
        flash((opts.auto ? '自动保存失败：' : '保存失败：') + e, true);
        return false;
    }
}

async function save(opts = {}) {
    return saveDoc(file, opts);
}

async function saveAs() {
    const ok = await saveDoc(file, {saveAs: true});
    if (ok) syncExplorerActive();
    return ok;
}

async function saveAll() {
    let saved = 0;
    let failed = false;
    for (const doc of docs.slice()) {
        if (!doc.dirty || !doc.path) continue;
        const ok = await saveDoc(doc, {silent: true});
        if (ok) saved++;
        else failed = true;
    }
    const skipped = docs.some((d) => d.dirty && !d.path);
    if (saved) {
        flash('已保存 ' + saved + ' 个文件' + (failed || skipped ? '，部分未保存' : ''), failed || skipped);
    } else if (failed || skipped) {
        flash(skipped ? '未命名文件请单独另存为' : '保存失败', true);
    }
}

els.btnWelcomeOpen.addEventListener('click', openDialog);

applySettings();
elsSettings.fixed.addEventListener('change', () => {
    settings.fixedKeys = elsSettings.fixed.checked;
    applySettings();
});
elsSettings.autoSave.addEventListener('change', () => {
    settings.autoSave = elsSettings.autoSave.checked;
    applySettings();
});
elsSettings.codeWrap.addEventListener('change', () => {
    settings.codeWrap = elsSettings.codeWrap.checked;
    applySettings();
});
elsSettings.mdLineNumbers.addEventListener('change', () => {
    settings.mdLineNumbers = elsSettings.mdLineNumbers.checked;
    applySettings();
    if (currentMode === 'preview' && file) renderMarkdownPreview(file);
});
elsSettings.showBanners.addEventListener('change', () => {
    settings.showBanners = elsSettings.showBanners.checked;
    applySettings();
    if (file) showBanner(file, file.parseError);
    else hideBanner();
});
elsSettings.openMode.addEventListener('change', () => {
    settings.openMode = elsSettings.openMode.value;
    applySettings();
    renderTabs();
});
elsSettings.width.addEventListener('input', () => {
    settings.keyWidth = Number(elsSettings.width.value);
    applySettings();
});
elsSettings.font.addEventListener('input', () => {
    settings.editorFont = Number(elsSettings.font.value);
    applySettings();
});
elsSettings.sidebarFont.addEventListener('input', () => {
    settings.sidebarFont = Number(elsSettings.sidebarFont.value);
    applySettings();
});
elsSettings.uiFont.addEventListener('change', () => {
    settings.uiFont = elsSettings.uiFont.value;
    applySettings();
});
elsSettings.uiCjkFont.addEventListener('change', () => {
    settings.uiCjkFont = elsSettings.uiCjkFont.value;
    applySettings();
});
elsSettings.editorFontFamily.addEventListener('change', () => {
    settings.editorFontFamily = elsSettings.editorFontFamily.value;
    applySettings();
});
elsSettings.editorCjkFont.addEventListener('change', () => {
    settings.editorCjkFont = elsSettings.editorCjkFont.value;
    applySettings();
});

window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!els.editor.contains(e.target)) return;
    if (currentMode === 'image' && file && file.image) {
        zoomImageBy(file, e.deltaY);
        return;
    }
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(24, Math.max(9, settings.editorFont + dir));
    if (next === settings.editorFont) return;
    settings.editorFont = next;
    applySettings();
    flash('编辑器字号 ' + next);
}, {passive: false, capture: true});

const winControls = document.getElementById('win-controls');
if (rt) {
    const maxBtn = document.getElementById('wc-max');
    const syncMaxIcon = async () => {
        const maximised = await rt.WindowIsMaximised();
        maxBtn.innerHTML = maximised ? '&#xE923;' : '&#xE922;';
        maxBtn.title = maximised ? '还原' : '最大化';
    };
    document.getElementById('wc-min').addEventListener('click', () => rt.WindowMinimise());
    maxBtn.addEventListener('click', async () => {
        rt.WindowToggleMaximise();
        setTimeout(syncMaxIcon, 100);
    });
    document.getElementById('wc-close').addEventListener('click', () => { if (rt.Quit) rt.Quit(); else if (rt.WindowClose) rt.WindowClose(); });
    document.getElementById('toolbar').addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input, select, textarea')) return;
        rt.WindowToggleMaximise();
        setTimeout(syncMaxIcon, 120);
    });
    window.addEventListener('resize', syncMaxIcon);
    syncMaxIcon();
} else {
    winControls.style.display = 'none';
}

const menuBar = document.getElementById('menubar');
let openMenuEl = null;

function clickEditorButton(sel) {
    if (!editor) return;
    const pane = file && file.pane ? file.pane : els.editor;
    const btn = pane.querySelector(sel);
    if (btn) btn.click();
}

function formatDocument() {
    if (!editor || !file) return;
    flushCsvCellEditor();
    const doc = file;
    if (settings.readOnlyMode) {
        flash('只读锁定中，解锁后才能格式化', true);
        return;
    }
    if (doc.large || doc.binary || (doc.format && doc.format.rawOnly)) {
        flash('当前文件不支持格式化', true);
        return;
    }
    if (currentMode === 'tree') {
        flash('格式化请在代码视图或文本视图中使用');
        return;
    }
    const text = editor.getText();
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        flash(doc.format.name + ' 无效，无法格式化：' + e.message, true);
        return;
    }
    let formatted;
    if (doc.format.id === 'json') {
        const indent = getFormatSettings('json').indent;
        formatted = JSON.stringify(value, null, indent === 'tab' ? '\t' : Number(indent));
    } else {
        formatted = doc.format.stringify(value);
    }
    if (formatted === text) return;
    doc.loading = true;
    try {
        editor.setText(formatted);
    } catch (e) {
        flash('格式化失败：' + e.message, true);
        return;
    } finally {
        doc.loading = false;
    }
    markDocDirty(doc);
    updateStatus();
    if (currentMode === 'table') renderCsvTableView(doc);
}

function switchMode(mode) {
    if (!editor || currentMode === mode) return;
    const doc = file;
    if (mode === 'image') {
        if (doc && doc.image) enterImageView(doc);
        return;
    }
    if (mode === 'binary') {
        if (doc && doc.binary) enterBinaryView(doc);
        return;
    }
    if (mode === 'preview') {
        if (doc && doc.format.preview) enterMarkdownPreview(doc);
        return;
    }
    if (currentMode === 'preview') {
        if (doc) leaveMarkdownPreview(doc, mode);
        return;
    }
    if (mode === 'table') {
        if (doc && doc.format.table) enterCsvTable(doc);
        return;
    }
    if (currentMode === 'table') {
        if (doc) leaveCsvTable(doc, mode);
        return;
    }
    if ((mode === 'code' || mode === 'text') && currentMode === 'tree' && doc && !dirty && doc.rawText != null) {
        doc.loading = true;
        try {
            editor.setMode(mode);
            editor.setText(doc.rawText);
        } catch (e) {
            console.warn('switch mode failed', e);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if ((mode === 'code' || mode === 'text') && currentMode === 'tree' && doc && doc.format.id !== 'json') {
        let value;
        try {
            value = editor.get();
        } catch (e) {
            flash('无法读取树内容：' + e.message, true);
            return;
        }
        const text = doc.format.stringify(value);
        doc.loading = true;
        try {
            editor.setMode(mode);
            editor.setText(text);
            doc.text = text;
        } catch (e) {
            flash('切换视图失败：' + e.message, true);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if ((mode === 'code' || mode === 'text') && (currentMode === 'code' || currentMode === 'text') && doc) {
        const text = editor.getText();
        doc.loading = true;
        try {
            editor.setMode(mode);
            editor.setText(text);
        } catch (e) {
            console.warn('switch mode failed', e);
        } finally {
            doc.loading = false;
        }
        return;
    }
    if (mode === 'tree' && (currentMode === 'code' || currentMode === 'text') && doc && doc.format.id !== 'json') {
        let value;
        try {
            value = doc.format.parse(editor.getText());
        } catch (e) {
            flash(doc.format.name + ' 解析失败：' + e.message, true);
            return;
        }
        doc.loading = true;
        try {
            editor.setText(JSON.stringify(value, null, 2));
            editor.setMode('tree');
            editor.set(value);
        } catch (e) {
            flash('切换树视图失败：' + e.message, true);
        } finally {
            doc.loading = false;
        }
        return;
    }
    try {
        editor.setMode(mode);
    } catch (e) {}
}

function focusSearch() {
    els.searchInput.focus();
    els.searchInput.select();
}

function exitApp() {
    if (rt && rt.Quit) rt.Quit();
    else if (rt && rt.WindowClose) rt.WindowClose();
    else window.close();
}

function menuItems(kind) {
    const tree = currentMode === 'tree' && !!file && !(file.format && file.format.rawOnly);
    const canSave = !!file && !file.large && !file.binary;
    const hasPath = !!(file && file.path);
    const hasDirty = docs.some((d) => d.dirty);
    switch (kind) {
        case 'file':
            return [
                {label: '新建', shortcut: 'Ctrl+N', icon: 'E710', action: newDocument},
                {label: '新建窗口', shortcut: 'Ctrl+Shift+N', icon: 'E8A7', action: openNewWindow},
                {sep: true},
                {label: '打开…', shortcut: 'Ctrl+O', icon: 'E8E5', action: openDialog},
                {label: '打开文件夹…', icon: 'E8B7', action: openFolderDialog},
                {label: '关闭文件夹', icon: 'E8BB', disabled: !workspaceFolder, action: closeFolder},
                {sep: true},
                {label: '保存', shortcut: 'Ctrl+S', icon: 'E74E', disabled: !canSave, action: () => save()},
                {label: '另存为…', shortcut: 'Ctrl+Shift+S', icon: 'E74E', disabled: !canSave, action: saveAs},
                {label: '保存全部', disabled: !hasDirty, action: saveAll},
                {sep: true},
                {label: '重新加载', icon: 'E72C', disabled: !hasPath, action: requestReload},
                {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: showInFolder},
                {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => copyText(file.path, '路径')},
                {label: '复制文件名', icon: 'E8C8', disabled: !hasPath, action: () => copyText(file.name, '文件名')},
                {sep: true},
                {label: '关闭标签', shortcut: 'Ctrl+W', icon: 'E8BB', disabled: !file, action: () => requestCloseDoc(file)},
                {label: '设置…', shortcut: 'Ctrl+,', icon: 'E713', action: () => openSettings('general')},
                {sep: true},
                {label: '退出', icon: 'E8BB', action: exitApp},
            ];
        case 'edit':
            return [
                {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', action: doUndo},
                {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', action: doRedo},
                {sep: true},
                {label: '查找…', shortcut: 'Ctrl+F', icon: 'E721', action: focusSearch},
            ];
        case 'format':
            return [
                {label: '格式化', shortcut: 'Ctrl+Alt+L', action: formatDocument},
                {label: '压缩', action: () => clickEditorButton('.jsoneditor-compact')},
                {sep: true},
                {label: '排序', disabled: !tree, action: () => clickEditorButton('.jsoneditor-sort')},
                {label: '变换…', disabled: !tree, action: () => clickEditorButton('.jsoneditor-transform')},
            ];
        case 'view': {
            const structured = !!file && !!file.treeAvailable;
            const items = viewOptionsFor(file && file.format).map(([mode, label]) => ({
                label,
                checked: currentMode === mode,
                disabled: viewDisabled(mode),
                action: () => switchMode(mode),
            }));
            items.push(
                {sep: true},
                {label: '文件侧边栏', shortcut: 'Alt+1', checked: !!settings.showSidebar, action: () => toggleSidebar()},
                {label: '文件列表', checked: settings.sidebarMode === 'list', action: () => setSidebarMode('list')},
                {label: '文件树', checked: settings.sidebarMode === 'tree', action: () => setSidebarMode('tree')},
                {sep: true},
                {label: '自动换行', checked: !!settings.codeWrap, action: toggleCodeWrap},
                {label: '展开全部', shortcut: 'Ctrl+Shift+=', disabled: !tree, action: () => editor && editor.expandAll()},
                {label: '收起全部', shortcut: 'Ctrl+Shift+-', disabled: !tree, action: () => editor && editor.collapseAll()},
            );
            return items;
        }
        case 'theme': {
            const items = [];
            let prevGroup = '';
            themes.forEach((theme) => {
                if (prevGroup && theme.group !== prevGroup) items.push({sep: true});
                items.push({
                    label: theme.name,
                    checked: settings.theme === theme.id,
                    swatch: theme.bg,
                    swatchAccent: theme.accent,
                    action: () => setTheme(theme.id),
                });
                prevGroup = theme.group;
            });
            return items;
        }
        case 'help':
            return [
                {label: '快捷键', action: () => openSettings('shortcuts')},
                {label: '关于 CaDt-DataLens', action: () => openSettings('about')},
            ];
        default:
            return [];
    }
}

function renderDropdown(menuEl) {
    const dd = menuEl.querySelector('.dropdown');
    dd.textContent = '';
    for (const it of menuItems(menuEl.dataset.menu)) {
        if (it.sep) {
            const s = document.createElement('div');
            s.className = 'menu-sep';
            dd.appendChild(s);
            continue;
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'menu-item' + (it.disabled ? ' disabled' : '');
        const icon = document.createElement('span');
        icon.className = 'mi-icon' + (it.checked ? ' checked' : '');
        if (it.checked) {
            icon.textContent = '\uE73E';
        } else if (it.swatch) {
            const dot = document.createElement('span');
            dot.className = 'mi-swatch';
            dot.style.background = 'linear-gradient(135deg, ' + it.swatch + ' 55%, ' + it.swatchAccent + ' 55%)';
            icon.appendChild(dot);
        } else if (it.icon) {
            icon.textContent = String.fromCharCode(parseInt(it.icon, 16));
        }
        const label = document.createElement('span');
        label.className = 'mi-label';
        label.textContent = it.label;
        const key = document.createElement('span');
        key.className = 'mi-key';
        key.textContent = it.shortcut || '';
        row.append(icon, label, key);
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllMenus();
            if (!it.disabled) it.action();
        });
        dd.appendChild(row);
    }
}

function closeAllMenus() {
    document.querySelectorAll('#menubar .menu').forEach((m) => {
        m.classList.remove('open');
        m.querySelector('.dropdown').classList.add('hidden');
    });
    openMenuEl = null;
}

function openMenu(menuEl) {
    closeAllMenus();
    renderDropdown(menuEl);
    menuEl.querySelector('.dropdown').classList.remove('hidden');
    menuEl.classList.add('open');
    openMenuEl = menuEl;
}

document.querySelectorAll('#menubar .menu').forEach((menuEl) => {
    menuEl.querySelector('.menu-label').addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllMenus();
        openMenu(menuEl);
    });
    menuEl.querySelector('.menu-label').addEventListener('mouseenter', () => {
        if (openMenuEl && openMenuEl !== menuEl) openMenu(menuEl);
    });
});
window.addEventListener('blur', () => closeAllMenus());
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#menubar')) return;
    closeAllMenus();
}, true);

els.searchInput.addEventListener('input', () => {
    if (!editor || !editor.searchBox) return;
    editor.searchBox.dom.search.value = els.searchInput.value;
    editor.searchBox.forceSearch();
});
els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (editor && editor.searchBox) {
            if (e.shiftKey) editor.searchBox.previous();
            else editor.searchBox.next();
        }
    } else if (e.key === 'Escape') {
        els.searchInput.blur();
    }
});

function updateSearchState() {
    const tree = currentMode === 'tree' && !!file && !(file.format && file.format.rawOnly);
    els.searchInput.disabled = !tree;
    els.searchInput.placeholder = tree ? '搜索节点…'
        : (currentMode === 'image' || currentMode === 'binary' ? '只读视图' : '代码模式按 Ctrl+F 查找');
    if (els.abSearch) {
        els.abSearch.disabled = !tree;
        els.abSearch.title = tree ? '搜索节点 (Ctrl+F)' : '当前视图不支持节点搜索';
    }
    if (!tree) {
        els.searchInput.value = '';
        if (editor && editor.searchBox) editor.searchBox.clear();
    }
}

function isDialogOpen() {
    return !elsDialogs.mask.classList.contains('hidden');
}

function isTypingTarget() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return !!(el.closest && el.closest('.ace_editor'));
}

function treeShortcutSelection() {
    const selected = explorer && explorer.getSelection();
    if (!selected || !selected.length || !explorer.hasFocus() || isTypingTarget() || isDialogOpen()) return null;
    return selected;
}

document.addEventListener('copy', (e) => {
    const selected = treeShortcutSelection();
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    setFileClipboard(selected, false);
}, true);

document.addEventListener('cut', (e) => {
    const selected = treeShortcutSelection();
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    if (settings.readOnlyMode) flash('只读模式下不能剪切', true);
    else setFileClipboard(selected, true);
}, true);

window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'Digit1' || e.key === '1')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
    } else if (e.shiftKey && e.key === 'F4') {
        e.preventDefault();
        e.stopPropagation();
        if (file && file.path) openInNewWindows([file.path]);
    } else if ((e.key === 'F2' || (e.shiftKey && e.key === 'F6')) && !e.ctrlKey && !e.altKey) {
        const selected = explorer && explorer.getSelection();
        if (selected && selected.length === 1 && !settings.readOnlyMode && !isDialogOpen() && !isTypingTarget()) {
            e.preventDefault();
            e.stopPropagation();
            openRenameEntryDialog(selected[0]);
        }
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (key === 'c' || key === 'x' || key === 'v')) {
        const selected = treeShortcutSelection();
        if (selected) {
            e.preventDefault();
            e.stopPropagation();
            if (key === 'c') setFileClipboard(selected, false);
            else if (key === 'x') {
                if (settings.readOnlyMode) flash('只读模式下不能剪切', true);
                else setFileClipboard(selected, true);
            } else if (key === 'v') {
                if (settings.readOnlyMode) flash('只读模式下不能粘贴', true);
                else pasteFileClipboard(explorer.getAnchor() || selected[selected.length - 1]);
            }
        }
    } else if (e.ctrlKey && e.altKey && (key === 'l' || e.code === 'KeyL')) {
        e.preventDefault();
        e.stopPropagation();
        formatDocument();
    } else if (e.ctrlKey && e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        saveAs();
    } else if (e.ctrlKey && !e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        save();
    } else if (e.ctrlKey && e.shiftKey && key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        openNewWindow();
    } else if (e.ctrlKey && e.shiftKey && key === 't') {
        e.preventDefault();
        e.stopPropagation();
        reopenClosedTab();
    } else if (e.ctrlKey && !e.shiftKey && key === 'n') {
        e.preventDefault();
        e.stopPropagation();
        newDocument();
    } else if (e.ctrlKey && !e.shiftKey && key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        if (file) requestCloseDoc(file);
    } else if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        openSettings('general');
    } else if (e.ctrlKey && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        openDialog();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        doUndo();
    } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        e.stopPropagation();
        doRedo();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        if (currentMode === 'tree' && file && !(file.format && file.format.rawOnly)) {
            e.preventDefault();
            e.stopPropagation();
            focusSearch();
        }
    } else if (e.ctrlKey && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ||
        e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        e.stopPropagation();
        if (!editor || currentMode !== 'tree' || !file || file.format.rawOnly) return;
        const plus = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        if (e.shiftKey) {
            if (plus) editor.expandAll();
            else editor.collapseAll();
        } else {
            toggleFocusedNode(plus ? 'expand' : 'collapse');
        }
    } else if (e.key === 'Escape') {
        closeDialogs();
        closeAllMenus();
        closeFootPopover();
    }
}, {capture: true});

for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(type, (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
        }
    }, true);
}

if (rt) {
    rt.EventsOn('open-targets', (targets) => openTargets(targets));
    rt.EventsOn('open-files', (paths) => openPaths(paths));
    rt.EventsOn('confirm-close', () => {
        flushCsvCellEditor();
        openCloseConfirm();
    });
}

document.querySelectorAll('.about-link').forEach((a) => {
    a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = a.dataset.url;
        if (!url) return;
        if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(url);
        else window.open(url, '_blank', 'noopener');
    });
});

els.tabbar.addEventListener('wheel', (e) => {
    if (els.tabbar.scrollWidth <= els.tabbar.clientWidth) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? els.tabbar.clientWidth : 1;
    e.preventDefault();
    els.tabbar.scrollLeft += delta * unit;
}, {passive: false});

initContextMenus();
initExplorer();
initActivityBar();

(async () => {
    if (backend.GetOpenMode) {
        try {
            const mode = await backend.GetOpenMode();
            if (mode === 'tab' || mode === 'window') {
                settings.openMode = mode;
                syncedOpenMode = mode;
                applySettings();
            }
        } catch (e) {}
    }
    let targets = [];
    if (backend.GetStartupTargets) {
        try {
            targets = await backend.GetStartupTargets();
        } catch (e) {}
    }
    if (targets && targets.length) {
        await openTargets(targets);
    } else {
        const files = await backend.GetStartupFiles();
        if (files && files.length) await openPaths(files);
    }
})();
