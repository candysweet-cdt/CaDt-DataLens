import 'katex/dist/katex.min.css';
import './style.css';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import markdownItKatex from '@vscode/markdown-it-katex';
import {aceModeFor, detectFormat, formats, isSupportedFile, pluginFormats} from './formats.js';
import {createExplorer} from './explorer.js';
import {createStructurePanel} from './structure.js';
import {createContextMenu} from './contextmenu.js';
import {createFileIcon, fileIconSpec} from './fileicons.js';
import {getPluginCommands, initPluginRuntime, loadPlugins} from './plugins.js';

window.addEventListener('error', (e) => {
    window.__modErr = (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno;
});

const UNLOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.6A2.4 2.4 0 0 1 10.8 4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="10.4" r="1" fill="currentColor"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 7V5.6A2 2 0 0 1 10 5.6V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="10.4" r="1" fill="currentColor"/></svg>';
const plainTextExtensions = new Set(['txt', 'log', 'conf']);

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

const sampleGoMod = `module candysweet.example/datalens-samples

go 1.22

require (
\tgithub.com/pkg/errors v0.9.1
\tgolang.org/x/text v0.14.0
)

require github.com/google/uuid v1.6.0 // indirect

replace golang.org/x/text => "golang.org/x/text" v0.13.0

exclude github.com/pkg/errors v0.8.1
`;

const sampleGoSum = `github.com/google/uuid v1.6.0 h1:GHsaKmPqE5XjG0dJXuXY9X2cQ8vY0McZn2PQ3XW9sL4=
github.com/google/uuid v1.6.0/go.mod h1:UHvbB7d8MzUiGb3ZPQTb5s68v2mMB6dWX0OcdSFvnlM=
github.com/pkg/errors v0.9.1 h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTqv4=
github.com/pkg/errors v0.9.1/go.mod h1:bwawxfHBFNV+G2So6ik+0qS4yXaDcB7MSkZKcHbnS8k=
`;

const samplePy = `#!/usr/bin/env python3
"""CaDt-DataLens Python 示例。"""

from pathlib import Path


def merge_blocks(left: int, right: int) -> int:
    return left * 60 + right


def summarize(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    return {
        "name": path.stem,
        "lines": len(lines),
        "chars": len(text),
        "preview": lines[:3],
    }


if __name__ == "__main__":
    print(merge_blocks(3, 7))
    print(summarize(Path(__file__)))
    sum(1, 2)
`;

const sampleAgentsMd = [
    '# 星轨工坊 (Starrail Workshop)',
    '',
    '## 0. 你手上只有这一个仓库',
    '',
    '- 先读 README',
    '',
    '## 1. 必读（按任务挑，但前两行必读）',
    '',
    '```bash',
    '# 这是代码块里的注释，不应出现在结构里',
    'git status',
    '```',
    '',
    '### 1.1 子标题',
    '',
    '## 2. 硬规则（违反即返工）',
    '',
    '## 3. 常见任务从哪进',
    '',
    '## 4. 提交前必须过',
    '',
    '## 5. 分支、提交、协作',
    '',
    '## 6. 当前状态（截至 2026-10-26，改之前先知道）',
].join('\n');

const sampleHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CaDt-DataLens</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
`;

const sampleJs = `import {readFileSync} from 'node:fs';

export class MachineBase {
  static LIMIT = 3;
  #secret = 1;

  constructor(system, dimension) {
    this.system = system;
  }

  get(key, defaultValue = null) {
    return this.system.get(key, defaultValue);
  }

  async load() {
    const parse = (text) => JSON.parse(text);
    return parse('{}');
  }
}

export function beGet(data, key, defaultVal = null) {
  return data.get(key, defaultVal);
}

const formatText = (value) => String(value);
export const LEVEL_COMP_CACHE = new Map();
`;

const sampleGo = `package main

type MachineBase struct {
    ID string
    Name string
}

type Handler interface {
    Handle(key string) error
}

func (m *MachineBase) Get(key string) string {
    return m.ID
}

func beGet(data map[string]string) string {
    return data["x"]
}

const LEVEL_CACHE = "x"
`;

const sampleMachinePy = `#!/usr/bin/env python3
"""机器结构示例。"""
STALE_CLOCK_KEYS = {"a", "b"}
_LEVEL_COMP_CACHE = {}

class MachineBase(object):
    """机器基类。"""
    LIMIT = 3

    def __init__(self, system, dimension, pos, block):
        self.system = system

    @staticmethod
    def fix_stale_clock(data, now):
        return data

    def data(self):
        return {"x": 1}

def be_get(data, key, default=None):
    return data.get(key, default)

async def fetch(url: str) -> dict:
    return {}
`;

const mockScenario = new URLSearchParams(location.search);
const mockDir = 'mock://samples/';
const mockHex = '00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|';
const mockImageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAAFjUlEQVR42u3dS0jU+wLA8d84MyTOpmUGRZALD4ExdKiF0CJ6bjwJQQWRVJyKmlUrF+VkT6KzyejdQiuTooVBYkJUKwOppANigtCDCFq0qLB8ztzFXOaGo3O4J7r3lJ/Paob/7zH68zv/mZWR3/7IhqJ6zy6a7lJpPFp87vDYxHSXknv67Gtf+37jviUB+GEJGAQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAcPPJPYjvuhffv/z+y2e3NP3f/mh7PtP2Lf/UpU7MCBg4Kf8CJ032PKrI+TbVdQ9dgcGBAwIGAQMCBgQMCBgEDAgYEDAIGBAwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwMAP/s/NvoeVK1euXr36y5cvw8PDFy9efP/+feGY1tbWwcHBbDYbi8Xu3bv38OHDEML69evb29v/ctgkhbNyWlpa6urqHAcC/i9UVVVVV1fv379/dHQ0mUymUqnGxsbCYePj4+l0OoQwa9as+vr6kZGRR48e1dbWTkpxymGTliqcBQL+m2pqatra2kZHR0MIvb29S5cujUajc+fO3blzZyKRuH///p07d74ePzIycvXq1W3bts2fP7+0tPTAgQOHDx8uXDY/7M2bN18vtXHjxtys5ubm6bbISSQSO3bsmD17diwWu3LlyuDgYO4ufffu3crKykQicfPmzZ6ennXr1q1YsSKbzba2tj579syB+g48s8ybN+/Fixf5pxcuXJiYmFi7du3169cbGhpqamoKp7x69aq8vPzGjRvDw8NT1vv1sElL5WcV3yKEsHXr1s7OzkOHDjU1Ne3atevf776x2KdPn9Lp9MmTJ7dv3x5C2LBhQ0NDw6lTp5YvX+403YFn3vtZyRTvaNeuXauurl6yZElZWVnh1Wg0Oj4+nn+6efPmysrKjo6Onp6ewmHTLVV8ixDC4sWL58yZk3tcWlpaUlKSyWQikciDBw9CCO/evctNfPr0aSqV6urqOn36tNN0B55x3r59u2DBgtzjSCSSSqVCCPv27QshdHZ2ZjKZwikVFRWvX7/OP21ra0un05PqzQ+bbqniW+T6P3LkSDqdPnjw4Llz53LDxsfHh4aGcgOy2WwI4cyZMx0dHWvWrNm7d6/TFPCM09XVtWnTpng8HkKorq7OPVi4cGF3d3c8Hs89nfTVdMuWLbdv384FH4lEplw2P6xwqdysIlvkPH/+fNmyZSGEZDJZW1v7dbR5ZWVljY2NAwMDTU1NyWTSafoIPeN0d3eXl5efOHHi48ePHz58uHz5cq7qo0ePvnz5cmhoKB6Pj42NxWKxxsbGbDYbjUbb29v7+vpCCP39/fX19cePH//PL7dgWOFSuVlTbpH/Rj0wMNDc3Lx79+5Vq1ZlMpnz589P+eI/f/785MmTY8eOlZSU3Lp1y2nOBJHf/sgWH9F7dtF0l0rj0eJzh8cmpruU3NP3t/fNzx1s+dUR8u0q6h7nHvRfqvrf/z1/S0c+QoPvwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwICAQcCAgAEBg4ABAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgOEnFPuhX31F3WNHiDswIGDAR+i/1H+pqviA4bGJ6S4l9/QVn9t7dtF0l0rjUfvO5H3dgQEBAwIGAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwIGAQMCBgQMAgYEDDwXf0LSiE2qQDYwMoAAAAASUVORK5CYII=';
const mockFiles = {
    yaml: {name: 'sample.yaml', content: sampleYaml},
    xml: {name: 'sample.xml', content: sampleXml},
    svg: {name: 'diagram.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" rx="10" fill="#4f8cff"/><circle cx="52" cy="60" r="26" fill="#ffb648"/><text x="96" y="68" fill="#fff" font-family="sans-serif" font-size="20">SVG OK</text></svg>'},
    csv: {name: 'sample.csv', content: sampleCsv},
    text: {name: 'notes.md', content: sampleText},
    json: {name: 'sample.json', content: sampleJson},
    jsonl: {name: 'sample.jsonl', content: sampleJsonl},
    toml: {name: 'sample.toml', content: sampleToml},
    ini: {name: 'sample.ini', content: sampleIni},
    gomod: {name: 'go.mod', content: sampleGoMod},
    gosum: {name: 'go.sum', content: sampleGoSum},
    bak: {name: 'sample.bak', content: sampleJson},
    py: {name: 'sample.py', content: samplePy},
    md: {name: 'AGENTS.md', content: sampleAgentsMd},
    html: {name: 'index.html', content: sampleHtml},
    js: {name: 'app.js', content: sampleJs},
    go: {name: 'server.go', content: sampleGo},
    machine: {name: 'machine.py', content: sampleMachinePy},
    brokensvg: {name: 'broken.svg', content: '{ not a svg {'},
};
const mockTree = {
    'mock://samples': [
        {name: 'cache', path: 'mock://samples/cache', isDir: true},
        {name: 'config', path: 'mock://samples/config', isDir: true},
        {name: 'images', path: 'mock://samples/images', isDir: true},
        {name: 'AGENTS.md', path: 'mock://samples/AGENTS.md', isDir: false},
        {name: 'notes.md', path: 'mock://samples/notes.md', isDir: false},
        {name: 'index.html', path: 'mock://samples/index.html', isDir: false},
        {name: 'app.js', path: 'mock://samples/app.js', isDir: false},
        {name: 'server.go', path: 'mock://samples/server.go', isDir: false},
        {name: 'machine.py', path: 'mock://samples/machine.py', isDir: false},
        {name: 'sample.csv', path: 'mock://samples/sample.csv', isDir: false},
        {name: 'sample.json', path: 'mock://samples/sample.json', isDir: false},
        {name: 'diagram.svg', path: 'mock://samples/diagram.svg', isDir: false},
        {name: 'broken.svg', path: 'mock://samples/broken.svg', isDir: false},
        {name: 'sample.jsonl', path: 'mock://samples/sample.jsonl', isDir: false},
        {name: 'sample.py', path: 'mock://samples/sample.py', isDir: false},
        {name: 'sample.ini', path: 'mock://samples/sample.ini', isDir: false},
        {name: 'sample.png', path: 'mock://samples/sample.png', isDir: false},
        {name: 'sample.xml', path: 'mock://samples/sample.xml', isDir: false},
        {name: 'sample.yaml', path: 'mock://samples/sample.yaml', isDir: false},
        {name: 'secrets.bin', path: 'mock://samples/secrets.bin', isDir: false},
    ],
    'mock://samples/cache': [
        {name: 'data-001.bin', path: 'mock://samples/cache/data-001.bin', isDir: false},
        {name: 'data-002.bin', path: 'mock://samples/cache/data-002.bin', isDir: false},
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
        for (const key of ['yaml', 'xml', 'svg', 'brokensvg', 'csv', 'text', 'jsonl', 'toml', 'ini', 'gomod', 'gosum', 'bak', 'py', 'md', 'html', 'js', 'go', 'machine']) {
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
    async StructureDir(dir) {
        const norm = String(dir || '').replace(/\/+$/, '');
        const ignored = new Set(['.git', '__pycache__']);
        const lines = [norm.split('/').pop() || norm];
        const walk = (path, prefix) => {
            const entries = (mockTree[path] || []).filter((entry) => !ignored.has(entry.name)).slice();
            entries.sort((a, b) => {
                if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name, 'zh-CN', {numeric: true, sensitivity: 'base'});
            });
            entries.forEach((entry, index) => {
                const last = index === entries.length - 1;
                lines.push(prefix + (last ? '└── ' : '├── ') + entry.name);
                if (entry.isDir) walk(entry.path, prefix + (last ? '    ' : '│   '));
            });
        };
        walk(norm, '');
        window.__mockStructuredDir = lines.join('\n');
        return window.__mockStructuredDir;
    },
    async ExportStructureDir(dir) {
        const text = await this.StructureDir(dir);
        const name = (String(dir || '').replace(/\/+$/, '').split('/').pop() || '目录') + '-目录结构.txt';
        // 浏览器 mock 没有系统保存对话框，用 prompt 模拟选择路径（测试可通过 __mockExportPath 指定）
        let path;
        if (window.__mockExportPath !== undefined) path = window.__mockExportPath;
        else path = window.prompt('导出结构化目录到（模拟路径）', 'mock://' + name);
        if (path == null || !String(path).trim()) return '';
        path = String(path).trim();
        await this.SaveFile(path, text, 'lf', false, 'utf-8');
        return path;
    },
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
    async DeleteEntry(path) {
        const key = String(path || '').replace(/\/+$/, '');
        if (!mockFindEntry(key)) throw new Error('文件不存在');
        mockDropPath(key);
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
            pathRegistered: !!(window.__mockIntegration && window.__mockIntegration.pathCmd),
            fileAssoc: !!window.__mockIntegration.fileAssoc,
            contextMenu: !!window.__mockIntegration.contextMenu,
        };
    },
    async SetPathRegistered(enabled) {
        if (!window.__mockIntegration) {
            window.__mockIntegration = {fileAssoc: false, contextMenu: false};
        }
        window.__mockIntegration.pathCmd = !!enabled;
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
    async GetAgentSkillStatus() {
        if (!window.__mockSkill) {
            window.__mockSkill = {registered: false};
        }
        return {
            home: 'C:\\Users\\demo',
            targets: [
                {dir: 'C:\\Users\\demo\\.agents\\skills', registered: !!window.__mockSkill.registered},
                {dir: 'C:\\Users\\demo\\.claude\\skills', registered: !!window.__mockSkill.registered},
            ],
        };
    },
    async SetAgentSkill(enabled) {
        if (!window.__mockSkill) {
            window.__mockSkill = {registered: false};
        }
        window.__mockSkill.registered = !!enabled;
    },
    async TermCreate(cols, rows, shell, cwd) {
        window.__mockTermSeq = (window.__mockTermSeq || 0) + 1;
        const id = 'term-' + window.__mockTermSeq;
        setTimeout(() => {
            if (rt && rt.EventsEmit) {
                rt.EventsEmit('term-out', {id, data: 'CaDt-DataLens 模拟终端（开发预览）\r\nPS ' + (cwd || 'C:\\') + '> '});
            }
        }, 200);
        return {id};
    },
    async TermWrite(id, data) {
        if (rt && rt.EventsEmit && data && !data.includes('\r')) {
            rt.EventsEmit('term-out', {id, data});
        }
    },
    async TermResize() {},
    async TermClose() {},
    async RunCommandSync(exe, args, cwd, timeoutMs) {
        return {code: 0, stdout: '[mock] ' + exe + ' ' + (args || []).join(' ') + (cwd ? ' (cwd ' + cwd + ')' : ''), stderr: ''};
    },
    async StartCommand(id, exe, args) {
        setTimeout(() => {
            if (rt && rt.EventsEmit) {
                rt.EventsEmit('cmd-out', {id, stream: 'out', data: '[mock] ' + exe + ' ' + (args || []).join(' ')});
                rt.EventsEmit('cmd-exit', {id, code: '0'});
            }
        }, 150);
        return null;
    },
    async StopCommand() {},
    async GitStatusFor(dir) {
        if (!mockScenario.has('gitmock')) {
            return {available: false, reason: 'mock 无 git', entries: []};
        }
        return {
            available: true,
            root: dir,
            branch: 'mock/main',
            entries: [
                {path: dir + '\\sample.json', state: 'modified'},
                {path: dir + '\\sample.yaml', state: 'added'},
                {path: dir + '\\sample.toml', state: 'deleted'},
                {path: dir + '\\sample.ini', state: 'conflict'},
                {path: dir + '\\config\\nested.yaml', state: 'modified'},
                {path: dir + '\\新文件.md', state: 'untracked'},
                {path: dir + '\\secrets.bin', state: 'ignored'},
                {path: dir + '\\cache', state: 'ignored'},
            ],
        };
    },
    async GitRollbackFor(dir, paths, untracked) {
        return null;
    },
    async GitFileHistoryFor(dir, path, limit) {
        return '[mock] a1b2c3d | 2026-11-08 12:00 | CandySweet | 提交 ' + path;
    },
    async GitRecentLogFor(dir, limit) {
        return '[mock] a1b2c3d | 2026-11-08 12:00 | CandySweet | 提交一';
    },
    async GitCommitChanges(dir, message, paths, amend, push) {
        return {success: true, output: '[mock] ' + (amend ? '修正提交' : '提交') + ' ' + (paths || []).length + ' 个文件' + (push ? ' 并推送' : '')};
    },
    async GitDiffFor(dir, path) {
        return {
            hasChanges: true,
            diff: 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1 +1 @@\n-旧内容\n+新内容（mock）\n',
        };
    },
    async ReadImageAsDataURL(path) {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mNkYPjPgAyYGBgYmRgAHPoBG0gGtMUAAAAASUVORK5CYII=';
    },
    async GetAppVersion() {
        return 'v1.0.0';
    },
    async GetPlugins() {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        if (!st.present) return [];
        return [{
            id: 'demo-format',
            name: '演示插件',
            version: '1.0.0',
            author: 'CandySweet',
            description: '注册 .bak 为 JSON 查看，并演示工具命令与主题',
            dir: 'C:\\plugins\\demo-format',
            entry: 'main.js',
            extensions: ['bak'],
            homepage: 'https://gitee.com/cadt-datalens-plugins',
            repository: 'https://gitee.com/cadt-datalens-plugins/bak-json',
            license: 'MIT',
            keywords: ['示例', 'json'],
            minAppVersion: '1.0.0',
            iconData: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#ef86aa"/></svg>'),
            enabled: !st.disabled['demo-format'],
            entryOk: true,
        }];
    },
    async GetPluginsDir() {
        return 'C:\\plugins';
    },
    async GetPluginsPathMode() {
        return (window.__mockPlugins || {}).mode || 'portable';
    },
    async SetPluginsPathMode(mode) {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        st.mode = mode === 'appdata' ? 'appdata' : 'portable';
    },
    async AddPluginFromFolder() {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        st.present = true;
        delete st.disabled['demo-format'];
        const list = await this.GetPlugins();
        return list[0];
    },
    async ImportPluginFromZip() {
        return this.AddPluginFromFolder();
    },
    async InstallPluginFromUrl(rawUrl) {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        st.present = true;
        delete st.disabled['demo-format'];
        const list = await this.GetPlugins();
        return list[0];
    },
    async DeletePlugin(id) {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        if (id === 'demo-format') st.present = false;
    },
    async SetPluginEnabled(id, enabled) {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        if (enabled) delete st.disabled[id];
        else st.disabled[id] = true;
    },
    async GetPluginSources() {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable'});
        if (!st.present || st.disabled['demo-format']) return [];
        return [{
            id: 'demo-format',
            name: '演示插件',
            version: '1.0.0',
            dir: 'C:\\plugins\\demo-format',
            code: [
                "cadt.registerFormat({",
                "  id: 'demo-bak-json',",
                "  name: 'JSON 备份',",
                "  extensions: ['bak'],",
                "  parse: (text) => JSON.parse(text),",
                "  stringify: (value) => JSON.stringify(value, null, 2),",
                "});",
                "cadt.addCommand({",
                "  id: 'char-count',",
                "  label: '统计当前文件字符数',",
                "  run() {",
                "    const f = cadt.getActiveFile();",
                "    const t = cadt.getActiveText();",
                "    cadt.flash((f ? f.name : '无文件') + ' 共 ' + (t ? t.length : 0) + ' 字符');",
                "  },",
                "});",
                "cadt.addTheme({",
                "  id: 'plugin-demo',",
                "  name: '演示主题',",
                "  bg: '#241f31',",
                "  accent: '#c58af9',",
                "  css: 'html[data-theme=\"plugin-demo\"] { --bg: #241f31; --text: #e8e3f2; --muted: #9d94b8; --border: #3a3350; --hover: #2e2842; --accent: #c58af9; --on-accent: #1b1626; }',",
                "});",
            ].join('\n'),
        }];
    },
    async OpenInNewWindows(paths) { window.__mockNewWindows = (window.__mockNewWindows || []).concat([paths]); },
    async OpenNewWindow() { window.__mockNewWindow = (window.__mockNewWindow || 0) + 1; },
    async OpenDirInNewWindow(dir) { window.__mockNewWindowDir = dir; window.__mockNewWindows = (window.__mockNewWindows || []).concat([[dir]]); },
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
// 暴露给插件作者与调试：生产环境插件同样可以直接访问 window.go
window.__backend = backend;


const mockRt = {
    _max: false,
    _calls: [],
    _events: {},
    EventsOn(name, cb) {
        (this._events[name] = this._events[name] || []).push(cb);
    },
    EventsEmit(name, data) {
        (this._events[name] || []).slice().forEach((cb) => cb(data));
    },
    async WindowIsMaximised() { return this._max; },
    WindowToggleMaximise() { this._max = !this._max; this._calls.push('toggle:' + this._max); },
    WindowMinimise() { this._calls.push('min'); },
    WindowUnminimise() { this._calls.push('unmin'); },
    WindowClose() { this._calls.push('close'); },
    Quit() { this._calls.push('quit'); },
    WindowSetTitle(title) { this._title = title; this._calls.push('title:' + title); },
    WindowSetAlwaysOnTop(b) { window.__mockAlwaysOnTop = !!b; this._topmost = !!b; this._calls.push('topmost:' + !!b); },
    WindowFullscreen() { this._fs = true; this._calls.push('fs:on'); },
    WindowUnfullscreen() { this._fs = false; this._calls.push('fs:off'); },
    async WindowIsFullscreen() { return !!this._fs; },
    BrowserOpenURL(url) { window.__mockOpenUrl = url; this._calls.push('url:' + url); },
    EventsOn() {},
};
// 调试/测试用：暴露 mock 运行时（仅 mock 场景存在）
window.__mockRt = mockRt;
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
    stPos: document.getElementById('st-pos'),
    stEol: document.getElementById('st-eol'),
    stEnc: document.getElementById('st-enc'),
    stMessage: document.getElementById('st-message'),
    stDirty: document.getElementById('st-dirty'),
    breadcrumb: document.getElementById('breadcrumb'),
    searchInput: document.getElementById('search-input'),
    editorArea: document.getElementById('editor-area'),
    sidebar: document.getElementById('sidebar'),
    sbBody: document.getElementById('sb-body'),
    sbTitle: document.getElementById('sb-title'),
    sbRefresh: document.getElementById('sb-refresh'),
    sbModeList: document.getElementById('sb-mode-list'),
    sbModeTree: document.getElementById('sb-mode-tree'),
    structurePanel: document.getElementById('structure-panel'),
    structureBody: document.getElementById('structure-body'),
    structureRefresh: document.getElementById('structure-refresh'),
    structureCollapse: document.getElementById('structure-collapse'),
    btnSidebar: document.getElementById('btn-sidebar'),
    lock: document.getElementById('btn-lock'),
    activityBar: document.getElementById('activity-bar'),
    abFiles: document.getElementById('ab-files'),
    abStructure: document.getElementById('ab-structure'),
    abSearch: document.getElementById('ab-search'),
    abMore: document.getElementById('ab-more'),
    abTerminal: document.getElementById('ab-terminal'),
    abGit: document.getElementById('ab-git'),
    termNew: document.getElementById('term-new'),
    termPanelClose: document.getElementById('term-panel-close'),
    terminalResize: document.getElementById('terminal-resize'),
    sidebarResize: document.getElementById('sidebar-resize'),
    sidebar: document.getElementById('sidebar'),
    terminalPanel: document.getElementById('terminal-panel'),
    gitPanel: document.getElementById('git-panel'),
    gitBranch: document.getElementById('git-branch'),
    gitHint: document.getElementById('git-hint'),
    gitChanges: document.getElementById('git-changes'),
    gitRefresh: document.getElementById('git-refresh'),
    gitRecentLog: document.getElementById('git-recent-log'),
    gitAmend: document.getElementById('git-amend'),
    gitMessage: document.getElementById('git-message'),
    gitCommitBtn: document.getElementById('git-commit-btn'),
    gitCommitPushBtn: document.getElementById('git-commit-push-btn'),
    gitSplitter: document.getElementById('git-splitter'),
    gitCommitArea: document.getElementById('git-commit-area'),
    abSettings: document.getElementById('ab-settings'),
    abAbout: document.getElementById('ab-about'),
};

let editor = null;
let file = null;
let docs = [];
let docSeq = 0;
let autoSaveTimer = 0;
let explorer = null;
let structurePanel = null;
let structureRefreshTimer = 0;
let workspaceFolder = null;
let fileClipboard = null;
let ctxMenu = null;
let closedTabs = [];
window.__lens = {
    get editor() { return editor; },
    get file() { return file; },
    get docs() { return docs; },
    get explorer() { return explorer; },
    get structurePanel() { return structurePanel; },
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

function allFormatDefs() {
    return formatDefs.concat(pluginFormats.map((f) => ({id: f.id, name: f.name})));
}

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
    sidebarView: 'files',
    showSidebar: false,
    csvTableMigrated: false,
    keyWidth: 160,
    sidebarFont: 12.5,
    treeGuides: false,
    treeCounts: false,
    treeRefreshInterval: 3,
    terminalHeight: 240,
    sidebarWidth: 264,
    gitCommitAreaHeight: 0,
    codeGuides: false,
    alwaysOnTop: false,
    editorFont: 13,
    codeWrap: false,
    mdLineNumbers: false,
    treeExpandDefault: 'expand',
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
// 未知主题（可能是已卸载插件注册的）先保留，等插件加载后 CSS 生效
if (!uiFonts.some((f) => f.id === settings.uiFont)) settings.uiFont = 'inter';
if (!editorFonts.some((f) => f.id === settings.editorFontFamily)) settings.editorFontFamily = 'jetbrains';
if (!cjkFonts.some((f) => f.id === settings.uiCjkFont)) settings.uiCjkFont = 'auto';
if (!cjkFonts.some((f) => f.id === settings.editorCjkFont)) settings.editorCjkFont = 'auto';
settings.autoSave = !!settings.autoSave;
if (settings.openMode !== 'window') settings.openMode = 'tab';
if (settings.sidebarMode !== 'list') settings.sidebarMode = 'tree';
if (!['files', 'git', 'structure'].includes(settings.sidebarView)) settings.sidebarView = 'files';
settings.showSidebar = !!settings.showSidebar;
settings.treeGuides = !!settings.treeGuides;
settings.treeCounts = !!settings.treeCounts;
settings.codeGuides = !!settings.codeGuides;
settings.alwaysOnTop = !!settings.alwaysOnTop;
settings.treeRefreshInterval = Number(settings.treeRefreshInterval);
if (![0, 1, 2, 3, 5, 10].includes(settings.treeRefreshInterval)) settings.treeRefreshInterval = 3;
settings.terminalHeight = Math.min(480, Math.max(120, Number(settings.terminalHeight) || 240));
settings.sidebarWidth = Math.min(500, Math.max(160, Number(settings.sidebarWidth) || 264));
settings.codeWrap = !!settings.codeWrap;
settings.mdLineNumbers = !!settings.mdLineNumbers;
settings.treeExpandDefault = settings.treeExpandDefault === 'collapse' ? 'collapse' : 'expand';
settings.showBanners = settings.showBanners !== false;
settings.readOnlyMode = !!settings.readOnlyMode;
if (!['always', 'hover', 'none'].includes(settings.tabCloseMode)) settings.tabCloseMode = 'always';
settings.dblClickClose = !!settings.dblClickClose;
settings.shiftClickClose = settings.shiftClickClose !== false;
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
    treeGuides: document.getElementById('opt-tree-guides'),
    treeCounts: document.getElementById('opt-tree-counts'),
    treeRefresh: document.getElementById('opt-tree-refresh'),
    codeGuides: document.getElementById('opt-code-guides'),
    alwaysOnTop: document.getElementById('opt-always-on-top'),
    codeWrap: document.getElementById('opt-code-wrap'),
    mdLineNumbers: document.getElementById('opt-md-line-numbers'),
    treeExpand: document.getElementById('opt-tree-expand'),
    showBanners: document.getElementById('opt-show-banners'),
    autoSave: document.getElementById('opt-auto-save'),
    openMode: document.getElementById('opt-open-mode'),
    tabClose: document.getElementById('opt-tab-close'),
    dblClickClose: document.getElementById('opt-dblclick-close'),
    shiftClickClose: document.getElementById('opt-shiftclick-close'),
    uiFont: document.getElementById('opt-ui-font'),
    uiCjkFont: document.getElementById('opt-ui-cjk-font'),
    editorFontFamily: document.getElementById('opt-editor-font'),
    editorCjkFont: document.getElementById('opt-editor-cjk-font'),
    fileAssoc: document.getElementById('opt-file-assoc'),
    contextMenu: document.getElementById('opt-context-menu'),
    agentSkill: document.getElementById('opt-agent-skill'),
    skillDirs: document.getElementById('opt-skill-dirs'),
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
    goto: document.getElementById('dlg-goto'),
    gotoInput: document.getElementById('dlg-goto-input'),
    gotoError: document.getElementById('dlg-goto-error'),
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
    if (!themes.some((t) => t.id === id)) return;
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

function applyCodeGuides() {
    for (const doc of docs) {
        const ace = doc && doc.editor && doc.editor.aceEditor;
        if (!ace) continue;
        try {
            ace.setDisplayIndentGuides(!!settings.codeGuides);
            ace.setHighlightIndentGuides(!!settings.codeGuides);
            ace.renderer.updateFull(true);
        } catch (e) {}
    }
}

function applyAlwaysOnTop() {
    if (!rt || !rt.WindowSetAlwaysOnTop) return;
    try {
        rt.WindowSetAlwaysOnTop(!!settings.alwaysOnTop);
    } catch (e) {}
}

let rtFullscreen = false;

async function syncFullscreenState() {
    if (!rt || !rt.WindowIsFullscreen) return;
    try {
        rtFullscreen = !!(await rt.WindowIsFullscreen());
    } catch (e) {}
}

async function toggleFullscreen() {
    if (!rt || !rt.WindowFullscreen) return;
    await syncFullscreenState();
    try {
        if (rtFullscreen) {
            rt.WindowUnfullscreen();
            rtFullscreen = false;
        } else {
            rt.WindowFullscreen();
            rtFullscreen = true;
        }
        flash('全屏：' + (rtFullscreen ? '开' : '关'));
    } catch (e) {
        flash('全屏切换失败：' + e, true);
    }
}

function toggleAlwaysOnTop() {
    settings.alwaysOnTop = !settings.alwaysOnTop;
    applySettings();
    flash('窗口置顶：' + (settings.alwaysOnTop ? '开' : '关'));
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
        if (textarea) textarea.readOnly = locked || !!doc.binary;
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
    document.documentElement.classList.toggle('tree-guides', !!settings.treeGuides);
    applyTheme();
    if (typeof syncTerminalTheme === 'function') {
        try {
            syncTerminalTheme();
        } catch (e) {}
    }
    if (els.sidebar && settings.sidebarWidth) {
        els.sidebar.style.width = settings.sidebarWidth + 'px';
    }
    if (els.gitCommitArea) {
        if (settings.gitCommitAreaHeight) {
            els.gitCommitArea.style.height = settings.gitCommitAreaHeight + 'px';
            els.gitCommitArea.style.flex = 'none';
        } else {
            els.gitCommitArea.style.height = '';
            els.gitCommitArea.style.flex = '';
        }
    }
    if (typeof applySidebarUI === 'function') {
        try {
            applySidebarUI();
        } catch (e) {}
    }
    document.documentElement.style.setProperty('--key-col-w', settings.keyWidth + 'px');
    elsSettings.fixed.checked = settings.fixedKeys;
    elsSettings.width.value = String(settings.keyWidth);
    elsSettings.width.disabled = !settings.fixedKeys;
    elsSettings.widthVal.textContent = String(settings.keyWidth);
    elsSettings.font.value = String(settings.editorFont);
    elsSettings.fontVal.textContent = String(settings.editorFont);
    elsSettings.sidebarFont.value = String(settings.sidebarFont);
    elsSettings.sidebarFontVal.textContent = String(settings.sidebarFont);
    elsSettings.treeGuides.checked = !!settings.treeGuides;
    elsSettings.treeCounts.checked = !!settings.treeCounts;
    elsSettings.treeRefresh.value = String(settings.treeRefreshInterval);
    if (explorer && explorer.setAutoRefresh) explorer.setAutoRefresh(settings.treeRefreshInterval);
    elsSettings.autoSave.checked = !!settings.autoSave;
    elsSettings.codeGuides.checked = !!settings.codeGuides;
    elsSettings.alwaysOnTop.checked = !!settings.alwaysOnTop;
    elsSettings.codeWrap.checked = !!settings.codeWrap;
    elsSettings.mdLineNumbers.checked = !!settings.mdLineNumbers;
    if (elsSettings.treeExpand) elsSettings.treeExpand.value = settings.treeExpandDefault;
    elsSettings.showBanners.checked = !!settings.showBanners;
    elsSettings.openMode.value = settings.openMode;
    document.documentElement.dataset.tabClose = settings.tabCloseMode;
    if (elsSettings.tabClose) elsSettings.tabClose.value = settings.tabCloseMode;
    if (elsSettings.dblClickClose) elsSettings.dblClickClose.checked = !!settings.dblClickClose;
    if (elsSettings.shiftClickClose) elsSettings.shiftClickClose.checked = settings.shiftClickClose !== false;
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
    applyCodeGuides();
    applyAlwaysOnTop();
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
    elsDialogs.goto.classList.add('hidden');
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
    elsDialogs.goto.classList.add('hidden');
    confirmAction = null;
    nameSubmit = null;
    nameBusy = false;
}

function selectSettingsPane(pane) {
    document.querySelectorAll('.snav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
    document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== pane));
    const group = document.getElementById('snav-formats');
    if (group) {
        const inFormats = pane === 'formats' || String(pane).startsWith('fmt-');
        if (inFormats && !group.classList.contains('expanded')) {
            group.classList.add('expanded');
            const parent = group.querySelector('.snav-parent');
            if (parent) parent.setAttribute('aria-expanded', 'true');
        }
    }
    if (pane === 'formats') renderFmtTable();
    else if (String(pane).startsWith('fmt-')) renderFormatPane(pane.slice(4));
    else if (pane === 'plugins') renderPluginsPane();
}

function openSettings(pane = 'general') {
    openDialogEl(elsDialogs.settings);
    selectSettingsPane(pane);
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
    if (backend.GetAgentSkillStatus && elsSettings.agentSkill) {
        try {
            const skill = await backend.GetAgentSkillStatus();
            elsSettings.agentSkill.checked = skill.targets.some((t) => t.registered);
            if (elsSettings.skillDirs) {
                const home = skill.home || '';
                elsSettings.skillDirs.textContent = skill.targets.map((t) => {
                    const dir = home && t.dir.startsWith(home) ? '~' + t.dir.slice(home.length) : t.dir;
                    return (t.registered ? '✓ ' : '○ ') + dir.replace(/\\/g, '/');
                }).join('，');
            }
        } catch (e) {
            if (elsSettings.skillDirs) elsSettings.skillDirs.textContent = '读取技能状态失败';
        }
    }
}

async function applyIntegration(kind, checkbox, label) {
    const enabled = checkbox.checked;
    if (!backend[kind]) {
        checkbox.checked = !enabled;
        flash('当前版本不支持系统集成', true);
        return;
    }
    for (const el of [elsSettings.fileAssoc, elsSettings.contextMenu, elsSettings.agentSkill]) {
        if (el) el.disabled = true;
    }
    try {
        await backend[kind](enabled);
        flash(label + (enabled ? '已注册' : '已取消'));
    } catch (e) {
        flash(label + (enabled ? '注册失败：' : '取消注册失败：') + e, true);
    } finally {
        for (const el of [elsSettings.fileAssoc, elsSettings.contextMenu, elsSettings.agentSkill]) {
            if (el) el.disabled = false;
        }
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

function cursorPositionForDoc() {
    if (!file) return null;
    if (currentMode === 'code' && file.editor && file.editor.aceEditor) {
        const pos = file.editor.aceEditor.getCursorPosition();
        return {line: pos.row + 1, column: pos.column + 1};
    }
    if (currentMode === 'text' && file.pane) {
        const textarea = file.pane.querySelector('textarea.jsoneditor-text');
        if (textarea) {
            const lines = textarea.value.slice(0, textarea.selectionEnd).split('\n');
            return {line: lines.length, column: lines[lines.length - 1].length + 1};
        }
    }
    return null;
}

function updateCursorPosition() {
    if (!els.stPos) return;
    const pos = cursorPositionForDoc();
    const text = pos ? pos.line + ':' + pos.column : '';
    if (els.stPos.textContent !== text) els.stPos.textContent = text;
    els.stPos.title = text ? '当前光标位置（点击或 Ctrl+G 跳转）' : '';
}

function scheduleCursorPosition() {
    updateCursorPosition();
    setTimeout(updateCursorPosition, 0);
}

function openGotoDialog() {
    const pos = cursorPositionForDoc() || {line: 1, column: 1};
    elsDialogs.gotoInput.value = pos.line + ':' + pos.column;
    elsDialogs.gotoError.textContent = '';
    elsDialogs.gotoError.classList.add('hidden');
    openDialogEl(elsDialogs.goto);
    setTimeout(() => {
        elsDialogs.gotoInput.focus();
        elsDialogs.gotoInput.select();
    }, 0);
}

function gotoDialogError(message) {
    elsDialogs.gotoError.textContent = String(message || '');
    elsDialogs.gotoError.classList.remove('hidden');
}

function jumpToPosition(line, column) {
    if (currentMode === 'code' && file && file.editor && file.editor.aceEditor) {
        const ace = file.editor.aceEditor;
        const total = ace.session.getLength();
        const targetLine = Math.min(Math.max(1, line), total);
        const lineText = ace.session.getLine(targetLine - 1) || '';
        const targetColumn = Math.min(Math.max(1, column), lineText.length + 1);
        ace.selection.moveTo(targetLine - 1, targetColumn - 1);
        ace.clearSelection();
        ace.scrollToLine(targetLine - 1, true, true);
        ace.focus();
        updateCursorPosition();
        if (structurePanel) structurePanel.setCursor(targetLine);
        return true;
    }
    if (currentMode === 'text' && file && file.pane) {
        const textarea = file.pane.querySelector('textarea.jsoneditor-text');
        if (!textarea) return false;
        const lines = textarea.value.split('\n');
        const targetLine = Math.min(Math.max(1, line), lines.length);
        const targetColumn = Math.min(Math.max(1, column), lines[targetLine - 1].length + 1);
        let index = 0;
        for (let i = 0; i < targetLine - 1; i++) index += lines[i].length + 1;
        index += targetColumn - 1;
        textarea.focus();
        textarea.setSelectionRange(index, index);
        const style = getComputedStyle(textarea);
        const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.45;
        textarea.scrollTop = Math.max(0, (targetLine - 1) * lineHeight - textarea.clientHeight / 2 + lineHeight);
        updateCursorPosition();
        if (structurePanel) structurePanel.setCursor(targetLine);
        return true;
    }
    return false;
}

function submitGotoDialog() {
    const raw = elsDialogs.gotoInput.value.trim();
    const match = /^(\d+)(?:\s*[:：]\s*(\d+))?$/.exec(raw);
    if (!match) {
        gotoDialogError('请输入「行:列」，例如 12:43');
        return;
    }
    const line = Number(match[1]);
    const column = match[2] ? Number(match[2]) : 1;
    if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
        gotoDialogError('行号和列号必须大于 0');
        return;
    }
    if (!jumpToPosition(line, column)) {
        gotoDialogError('当前视图不支持跳转');
        return;
    }
    closeDialogs();
}

document.getElementById('btn-goto-ok').addEventListener('click', submitGotoDialog);
document.getElementById('btn-goto-cancel').addEventListener('click', closeDialogs);
elsDialogs.gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitGotoDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialogs();
    }
});
if (els.stPos) {
    els.stPos.addEventListener('click', () => {
        if ((currentMode === 'code' || currentMode === 'text') && file) openGotoDialog();
    });
}

for (const type of ['keyup', 'click', 'input', 'focusin']) {
    els.editor.addEventListener(type, (e) => {
        if (e.target && e.target.matches && e.target.matches('textarea.jsoneditor-text')) updateCursorPosition();
    });
}
document.addEventListener('selectionchange', () => {
    if (currentMode !== 'text') return;
    const textarea = file && file.pane && file.pane.querySelector('textarea.jsoneditor-text');
    if (textarea && document.activeElement === textarea) updateCursorPosition();
});

function openCloseConfirm(message, action, okLabel, title) {
    elsDialogs.confirmText.textContent = message || '有未保存的修改，关闭后将丢弃。';
    elsDialogs.confirmOk.textContent = okLabel || '丢弃并关闭';
    const titleEl = elsDialogs.confirm.querySelector('.dialog-title');
    if (titleEl) titleEl.textContent = title || '关闭';
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

document.querySelector('.settings-nav').addEventListener('click', (e) => {
    const parent = e.target.closest('.snav-parent');
    if (parent) {
        const group = parent.closest('.snav-group');
        const expanded = group.classList.toggle('expanded');
        parent.setAttribute('aria-expanded', String(expanded));
        return;
    }
    const item = e.target.closest('.snav-item[data-pane]');
    if (!item) return;
    selectSettingsPane(item.dataset.pane);
    if (item.dataset.pane === 'integration') syncIntegrationStatus();
});
setupFormatSettings();

function refreshPluginUI() {
    // 清掉已失效的插件格式导航与面板（插件被禁用/删除后）
    const children = document.querySelector('#snav-formats .snav-children');
    const content = document.querySelector('.settings-content');
    if (children && content) {
        const valid = new Set(allFormatDefs().map((f) => 'fmt-' + f.id));
        for (const nav of [...children.querySelectorAll('.snav-fmt')]) {
            if (!valid.has(nav.dataset.pane)) {
                const pane = content.querySelector(`.settings-pane[data-pane="${nav.dataset.pane}"]`);
                if (pane) pane.remove();
                nav.remove();
            }
        }
    }
    setupFormatSettings();
    if (elsDialogs.settings && !elsDialogs.settings.classList.contains('hidden')) {
        const active = document.querySelector('.snav-item.active');
        if (active && active.dataset.pane === 'plugins') renderPluginsPane();
    }
}

initPluginRuntime({
    flash,
    getActiveFile: () => file ? {path: file.path || '', name: file.name || '', size: file.size || 0, formatId: file.format ? file.format.id : null} : null,
    getActiveText: () => {
        if (!file) return null;
        if (currentMode === 'code' && editor && editor.aceEditor) return editor.aceEditor.getValue();
        if (currentMode === 'tree' && editor && file.format && typeof file.format.stringify === 'function') {
            try {
                return file.format.stringify(editor.get());
            } catch (e) {
                return null;
            }
        }
        const ta = textArea();
        if (ta) return ta.value;
        return file.binary ? null : file.content;
    },
    openPath: (p) => {
        if (p) openPaths([p]);
    },
    runCommandSync: (opts) => backend.RunCommandSync(opts.exe, opts.args, opts.cwd || '', opts.timeoutMs || 20000),
    runCommand: (opts) => {
        const id = 'cmd-' + ++cmdSeq;
        cmdOutHandlers.set(id, (stream, data) => {
            if (stream === 'out' && opts.onOut) opts.onOut(data);
            if (stream === 'err' && opts.onErr) opts.onErr(data);
        });
        cmdExitHandlers.set(id, (code) => {
            cmdOutHandlers.delete(id);
            if (opts.onExit) opts.onExit(code);
        });
        Promise.resolve(backend.StartCommand(id, opts.exe, opts.args, opts.cwd || '')).catch((e) => {
            flash('启动命令失败：' + e, true);
            cmdExitHandlers.delete(id);
            if (opts.onExit) opts.onExit(-1);
        });
        return {stop: () => backend.StopCommand(id).catch(() => {})};
    },
    openVirtualDoc: (name, content) => openVirtualDoc(name, content),
    addPluginTheme: (theme) => {
        if (themes.some((t) => t.id === theme.id)) {
            throw new Error(`主题 ${theme.id} 与内置主题冲突`);
        }
        themes.push({...theme, group: 'plugin'});
    },
    onPluginsChanged: () => refreshPluginUI(),
});

async function reloadPluginErrors(prefix) {
    const errors = await loadPlugins(backend);
    for (const err of errors) flash(prefix + err, true);
}

if (elsSettings.fileAssoc) {
    elsSettings.fileAssoc.addEventListener('change', () => applyIntegration('SetFileAssociation', elsSettings.fileAssoc, '文件关联'));
    elsSettings.contextMenu.addEventListener('change', () => applyIntegration('SetContextMenu', elsSettings.contextMenu, '右键菜单'));
    elsSettings.agentSkill.addEventListener('change', () => applyIntegration('SetAgentSkill', elsSettings.agentSkill, 'Agent Skill '));
    elsSettings.refreshIntegration.addEventListener('click', syncIntegrationStatus);
}

function setupPluginsSettings() {
    const addBtn = document.getElementById('plugin-add');
    const importBtn = document.getElementById('plugin-import');
    const cloneBtn = document.getElementById('plugin-clone');
    const openDirBtn = document.getElementById('plugin-open-dir');
    const modeSel = document.getElementById('plugin-path-mode');
    if (!addBtn) return;
    addBtn.addEventListener('click', async () => {
        if (!backend.AddPluginFromFolder) return flash('当前版本不支持插件', true);
        try {
            const installed = await backend.AddPluginFromFolder();
            if (installed) {
                await reloadPluginErrors('');
                flash('已添加插件：' + installed.name);
            }
        } catch (e) {
            flash('添加插件失败：' + e, true);
        }
        renderPluginsPane();
    });
    importBtn.addEventListener('click', async () => {
        if (!backend.ImportPluginFromZip) return flash('当前版本不支持插件', true);
        try {
            const installed = await backend.ImportPluginFromZip();
            if (installed) {
                await reloadPluginErrors('');
                flash('已导入插件：' + installed.name);
            }
        } catch (e) {
            flash('导入插件失败：' + e, true);
        }
        renderPluginsPane();
    });
    cloneBtn.addEventListener('click', () => {
        if (!backend.InstallPluginFromUrl) {
            flash('当前版本不支持从仓库地址安装', true);
            return;
        }
        openNameDialog({
            title: '从仓库地址安装插件',
            label: '仓库地址',
            placeholder: 'https://gitee.com/cadt-datalens-plugins/git-flow',
            okLabel: '安装',
            onSubmit: async (url) => {
                const installed = await backend.InstallPluginFromUrl(url);
                if (!installed) {
                    throw new Error('仓库地址为空');
                }
                await reloadPluginErrors('');
                renderPluginsPane();
                flash('已安装插件：' + installed.name);
            },
        });
    });
    openDirBtn.addEventListener('click', async () => {
        try {
            const dir = backend.GetPluginsDir ? await backend.GetPluginsDir() : '';
            if (dir) await backend.ShowInFolder(dir);
        } catch (e) {
            flash('打开插件目录失败：' + e, true);
        }
    });
    modeSel.addEventListener('change', async () => {
        try {
            await backend.SetPluginsPathMode(modeSel.value);
            await reloadPluginErrors('');
            flash('插件目录已切换，重新打开文件生效');
        } catch (e) {
            flash('切换插件目录失败：' + e, true);
        }
        renderPluginsPane();
    });
}

let cachedAppVersion = '';
function appVersionValue() {
    return cachedAppVersion;
}

function versionAtLeast(current, required) {
    const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const [c1 = 0, c2 = 0, c3 = 0] = parse(current);
    const [r1 = 0, r2 = 0, r3 = 0] = parse(required);
    if (c1 !== r1) return c1 > r1;
    if (c2 !== r2) return c2 > r2;
    return c3 >= r3;
}

async function renderPluginsPane() {
    const listEl = document.getElementById('plugin-list');
    if (!listEl) return;
    const modeSel = document.getElementById('plugin-path-mode');
    try {
        if (backend.GetAppVersion) cachedAppVersion = await backend.GetAppVersion();
        const plugins = backend.GetPlugins ? await backend.GetPlugins() : [];
        const dir = backend.GetPluginsDir ? await backend.GetPluginsDir() : '—';
        if (modeSel && backend.GetPluginsPathMode) {
            modeSel.value = await backend.GetPluginsPathMode();
        }
        if (document.getElementById('plugin-dir-line')) {
            document.getElementById('plugin-dir-line').textContent = '插件目录：' + dir;
        }
        listEl.textContent = '';
        if (!plugins || !plugins.length) {
            const empty = document.createElement('div');
            empty.className = 'plugin-empty';
            empty.textContent = '暂无插件。点「添加插件」选择包含 plugin.json 的文件夹，或导入 .zip 插件包；插件可注册新的文件格式、工具菜单命令和主题。';
            listEl.appendChild(empty);
            return;
        }
        for (const p of plugins) {
            const item = document.createElement('div');
            item.className = 'plugin-item';
            const head = document.createElement('div');
            head.className = 'plugin-head';
            if (p.iconData) {
                const icon = document.createElement('img');
                icon.className = 'plugin-icon';
                icon.src = p.iconData;
                icon.alt = '';
                icon.draggable = false;
                head.appendChild(icon);
            }
            const name = document.createElement('span');
            name.className = 'plugin-name';
            name.textContent = p.name;
            const ver = document.createElement('span');
            ver.className = 'plugin-version';
            ver.textContent = p.version ? 'v' + p.version : '';
            const author = document.createElement('span');
            author.className = 'plugin-author';
            author.textContent = p.author ? '作者：' + p.author : '';
            const license = document.createElement('span');
            license.className = 'plugin-license';
            license.textContent = p.license || '';
            license.title = '许可证';
            const enabledLabel = document.createElement('label');
            enabledLabel.className = 'popover-label plugin-enabled';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!p.enabled;
            cb.addEventListener('change', async () => {
                try {
                    await backend.SetPluginEnabled(p.id, cb.checked);
                    await reloadPluginErrors('');
                } catch (e) {
                    flash('切换失败：' + e, true);
                }
                renderPluginsPane();
            });
            enabledLabel.append(cb, document.createTextNode('启用'));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'dlg-btn plugin-del';
            del.textContent = '删除';
            del.addEventListener('click', async () => {
                if (!del.dataset.armed) {
                    del.dataset.armed = '1';
                    del.textContent = '确认删除？';
                    del.classList.add('danger');
                    setTimeout(() => {
                        if (del.isConnected) {
                            del.dataset.armed = '';
                            del.textContent = '删除';
                            del.classList.remove('danger');
                        }
                    }, 3000);
                    return;
                }
                try {
                    await backend.DeletePlugin(p.id);
                    await reloadPluginErrors('');
                    flash('插件已删除：' + p.name);
                } catch (e) {
                    flash('删除失败：' + e, true);
                }
                renderPluginsPane();
            });
            head.append(name, ver, author, license, enabledLabel, del);
            const desc = document.createElement('div');
            desc.className = 'plugin-desc';
            desc.textContent = p.description || '无描述';
            const meta = document.createElement('div');
            meta.className = 'plugin-meta';
            if (p.extensions && p.extensions.length) {
                const exts = document.createElement('span');
                exts.textContent = '扩展名：' + p.extensions.join('、');
                meta.appendChild(exts);
            }
            for (const kw of (p.keywords || []).slice(0, 6)) {
                const chip = document.createElement('span');
                chip.className = 'plugin-tag';
                chip.textContent = kw;
                meta.appendChild(chip);
            }
            if (p.minAppVersion && !versionAtLeast(appVersionValue(), p.minAppVersion)) {
                const warn = document.createElement('span');
                warn.className = 'plugin-warn';
                warn.textContent = '需要应用 ≥ ' + p.minAppVersion;
                meta.appendChild(warn);
            }
            for (const [label, url] of [['主页', p.homepage], ['源码', p.repository]]) {
                if (!url) continue;
                const link = document.createElement('a');
                link.className = 'plugin-link';
                link.textContent = label;
                link.href = url;
                link.dataset.url = url;
                link.title = url;
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(url);
                    else window.open(url, '_blank', 'noopener');
                });
                meta.appendChild(link);
            }
            if (!p.entryOk) {
                const warn = document.createElement('span');
                warn.className = 'plugin-warn';
                warn.textContent = '入口文件缺失或过大';
                meta.appendChild(warn);
            }
            item.append(head, desc, meta);
            listEl.appendChild(item);
        }
    } catch (e) {
        flash('读取插件失败：' + e, true);
    }
}

setupPluginsSettings();

const ENCODINGS = [['auto', '自动'], ['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const CONVERT_ENCODINGS = [['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const INDENTS = [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']];
const EOLS = [['follow', '跟随原文件'], ['lf', 'LF'], ['crlf', 'CRLF']];
const VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];
const CSV_VIEWS = [['table', '表格视图'], ['tree', '树视图'], ['text', '文本视图']];
const MARKDOWN_VIEWS = [['preview', '预览'], ['code', '代码视图'], ['text', '文本视图']];
const IMAGE_VIEWS = [['image', '图片视图'], ['binary', '二进制视图'], ['text', '文本视图']];
const BINARY_VIEWS = [['binary', '二进制视图'], ['text', '文本视图']];
const SVG_VIEWS = [['render', '渲染视图'], ['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];

function isSvgDoc(doc) {
    return !!(doc && /\.svg$/i.test(doc.name || ''));
}
const CSV_TABLE_ROW_LIMIT = 5000;
const CSV_ROW_NUM_WIDTH = 44;
const CSV_COL_MIN_WIDTH = 56;

function viewOptionsFor(fmt, doc) {
    if (fmt && fmt.image) return IMAGE_VIEWS;
    if (fmt && fmt.id === 'bytes') return BINARY_VIEWS;
    if (fmt && fmt.id === 'markdown') return MARKDOWN_VIEWS;
    if (isSvgDoc(doc)) return SVG_VIEWS;
    return fmt && (fmt.table || fmt.id === 'csv') ? CSV_VIEWS : VIEWS;
}

function viewDisabled(mode) {
    if (!file) return true;
    if (mode === 'image') return !file.image;
    if (mode === 'binary') return !file.binary;
    if (mode === 'tree') return !file.treeAvailable;
    if (mode === 'text') return false;
    if (mode === 'preview') return !(file.format && file.format.preview) || !!file.large;
    if (mode === 'render') return !isSvgDoc(file);
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
    if (mode === 'render') return '渲染视图';
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

// resolveMarkdownImages 把 Markdown 预览里相对路径/本地绝对路径的图片换成后端读取的 data URL。
function resolveMarkdownImages(doc) {
    if (!doc || !doc.previewBody) return;
    const BS = String.fromCharCode(92); // 反斜杠（避免注入层转义问题）
    const raw0 = doc.path || '';
    const cut = Math.max(raw0.lastIndexOf('/'), raw0.lastIndexOf(BS));
    const base = cut >= 0 ? raw0.slice(0, cut) : '';
    for (const img of doc.previewBody.querySelectorAll('img')) {
        const raw = img.getAttribute('src') || '';
        if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
        let p = raw;
        if (/^file:/i.test(p)) p = p.slice(7);
        p = p.replace(/^\/+/, '');
        try { p = decodeURIComponent(p); } catch (e) {}
        p = p.split('/').join(BS);
        let abs;
        if (/^[A-Za-z]:/.test(p)) abs = p;
        else if (base) abs = base + BS + p;
        else continue;
        const parts = [];
        for (const seg of abs.split(BS)) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') { parts.pop(); continue; }
            parts.push(seg);
        }
        abs = parts.join(BS);
        if (!backend.ReadImageAsDataURL) continue;
        backend.ReadImageAsDataURL(abs).then((url) => { if (url) img.src = url; }).catch(() => {});
    }
}

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
    for (const [mode, label] of viewOptionsFor(file && file.format, file)) {
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

function renderTableZoomMenu() {
    if (!file || !file.format || !file.format.table) return;
    const doc = file;
    footPopover.appendChild(popTitle('表格缩放'));
    for (const percent of [25, 50, 75, 100, 150, 200, 400, 800]) {
        footPopover.appendChild(popItem(percent + '%', {
            current: Math.round((doc.tableZoom || 1) * 100) === percent,
            onClick: () => {
                doc.tableZoom = percent / 100;
                applyCsvTableZoom(doc);
                updateStatus();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popFoot('当前', Math.round((doc.tableZoom || 1) * 100) + '%'));
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
    else if (kind === 'zoom') {
        if (currentMode === 'table' && file.format && file.format.table) renderTableZoomMenu();
        else renderImageZoomMenu();
    }
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

function setupFormatSettings() {
    const children = document.querySelector('#snav-formats .snav-children');
    const content = document.querySelector('.settings-content');
    if (!children || !content) return;
    for (const f of allFormatDefs()) {
        if (children.querySelector(`[data-pane="fmt-${f.id}"]`)) continue;
        const nav = document.createElement('button');
        nav.type = 'button';
        nav.className = 'snav-item snav-child snav-fmt';
        nav.dataset.pane = 'fmt-' + f.id;
        nav.textContent = f.name;
        children.appendChild(nav);
        if (!content.querySelector(`.settings-pane[data-pane="fmt-${f.id}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = 'fmt-' + f.id;
            content.appendChild(pane);
        }
    }
}

function renderFormatPane(id) {
    const f = allFormatDefs().find((item) => item.id === id);
    const pane = document.querySelector(`.settings-pane[data-pane="fmt-${id}"]`);
    if (!f || !pane) return;
    const fs = getFormatSettings(id);
    pane.textContent = '';
    const title = document.createElement('div');
    title.className = 'fmt-pane-title';
    title.textContent = f.name + ' 文件';
    const extensions = formats[id] && formats[id].extensions ? formats[id].extensions : [];
    const sub = document.createElement('div');
    sub.className = 'fmt-pane-sub';
    sub.textContent = extensions.length ? '扩展名：' + extensions.join('、') : '';
    pane.append(title, sub);
    const update = (key) => (value) => {
        settings.formatSettings[id][key] = value;
        applySettings();
    };
    const addRow = (label, control) => {
        const row = document.createElement('div');
        row.className = 'popover-row';
        const text = document.createElement('span');
        text.className = 'popover-label';
        text.textContent = label;
        row.append(text, control);
        pane.appendChild(row);
    };
    addRow('编码', makeSelect(ENCODINGS, fs.encoding, update('encoding')));
    addRow('缩进', makeSelect(INDENTS, fs.indent, update('indent')));
    addRow('保存换行', makeSelect(EOLS, fs.eol, update('eol')));
    const viewSel = makeSelect(viewOptionsFor(f), fs.view, (value) => {
        settings.formatSettings[id].view = value;
        applySettings();
        if (file && file.format.id === id) switchMode(value);
    });
    if (id === 'text') viewSel.disabled = true;
    addRow('默认视图', viewSel);
    const hint = document.createElement('div');
    hint.className = 'fmt-hint';
    hint.textContent = '编码 / 缩进 / 保存换行对之后打开或保存的文件生效；默认视图对当前同类文件立即生效。';
    if (id === 'text') hint.textContent += ' txt/log/conf 默认文本视图，代码类扩展名按代码视图打开。';
    pane.appendChild(hint);
}

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
    for (const f of allFormatDefs()) {
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
    const el = document.querySelector('.etabs .tab[data-doc-id="' + doc.id + '"]');
    if (el) el.classList.toggle('dirty', !!doc.dirty);
}

// ===== 编辑器分栏（编辑器组 + 二叉分割树，VS Code 式） =====
let editorGroups = [];
let splitRoot = null;
let focusedGroupId = null;
let groupSeq = 0;
let dragTabId = null;
let dragTabGroupId = null;
let dropZone = null;
const SPLIT_MAX_DEPTH = 3;
const SPLIT_MIN_W = 240;
const SPLIT_MIN_H = 180;

function nextGroupId() { return 'g' + (++groupSeq); }
function groupById(gid) { return editorGroups.find((g) => g.id === gid) || null; }
function groupOfDoc(docId) { return editorGroups.find((g) => g.docIds.includes(docId)) || null; }
function groupDocs(g) { return (g ? g.docIds.map((id) => docs.find((d) => d.id === id)).filter(Boolean) : []); }
function focusedGroup() { return groupById(focusedGroupId) || editorGroups[0] || null; }
function createGroup(docIds) {
    const g = { id: nextGroupId(), docIds: docIds || [], activeId: (docIds && docIds.length ? docIds[0] : null) };
    editorGroups.push(g);
    if (!focusedGroupId) focusedGroupId = g.id;
    return g;
}
// 新开文件归入当前聚焦组（多开时只 activate 最后一个，其余仍需可见）
function addDocToFocusedGroup(doc) {
    if (!doc) return null;
    const g = focusedGroup() || createGroup();
    if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    return g;
}
function leafDepth(node, gid, d) {
    if (!node) return -1;
    if (typeof node === 'string') return node === gid ? d : -1;
    const a = leafDepth(node.a, gid, d + 1);
    if (a >= 0) return a;
    return leafDepth(node.b, gid, d + 1);
}
function groupDepth(gid) { return splitRoot ? leafDepth(splitRoot, gid, 0) : 0; }
function splitReplaceLeaf(node, gid, dir, side, newGid) {
    const mkSplit = (existing) => ({ dir, ratio: 0.5, a: side === 'before' ? newGid : existing, b: side === 'before' ? existing : newGid });
    if (!node) return mkSplit(gid);
    if (typeof node === 'string') return node === gid ? mkSplit(node) : node;
    if (node.a === gid) return { dir: node.dir, ratio: node.ratio, a: mkSplit(gid), b: node.b };
    if (node.b === gid) return { dir: node.dir, ratio: node.ratio, a: node.a, b: mkSplit(gid) };
    return { dir: node.dir, ratio: node.ratio, a: splitReplaceLeaf(node.a, gid, dir, side, newGid), b: splitReplaceLeaf(node.b, gid, dir, side, newGid) };
}
function collapseTree(node) {
    if (typeof node === 'string') return groupById(node) ? node : null;
    const a = collapseTree(node.a);
    const b = collapseTree(node.b);
    if (a === null) return b;
    if (b === null) return a;
    return { dir: node.dir, ratio: node.ratio, a, b };
}
function removeGroupIfEmpty(gid) {
    if (!gid) return;
    const idx = editorGroups.findIndex((g) => g.id === gid);
    if (idx < 0) return;
    if (editorGroups[idx].docIds.length) return;
    editorGroups.splice(idx, 1);
    if (splitRoot) splitRoot = collapseTree(splitRoot);
    if (focusedGroupId === gid || !groupById(focusedGroupId)) {
        const fg = focusedGroup();
        focusedGroupId = fg ? fg.id : null;
    }
}
function moveTabInGroup(gid, srcId, targetId, before) {
    const g = groupById(gid);
    if (!g) return;
    const si = g.docIds.indexOf(srcId);
    const ti = g.docIds.indexOf(targetId);
    if (si < 0 || ti < 0 || srcId === targetId) return;
    g.docIds.splice(si, 1);
    const idx = g.docIds.indexOf(targetId);
    g.docIds.splice(before ? idx : idx + 1, 0, srcId);
    renderTabs();
}

function renderTabs() { renderEditorLayout(); }

function renderEditorLayout() {
    // 提示条先移出布局区，避免被整体清空
    if (els.banner && els.banner.parentElement === els.editor) els.editorArea.appendChild(els.banner);
    els.editor.textContent = '';
    const root = splitRoot || (focusedGroupId || (editorGroups[0] && editorGroups[0].id));
    if (!root || !editorGroups.length) return;
    buildSplitNode(els.editor, root);
    for (const g of editorGroups) {
        const host = els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
        if (!host) continue;
        const list = groupDocs(g);
        for (const d of list) {
            if (d.pane && d.pane.parentElement !== host) host.appendChild(d.pane);
        }
        const active = list.find((d) => d.id === g.activeId) || list[0];
        if (active) g.activeId = active.id;
        for (const d of list) {
            if (d.pane) d.pane.classList.toggle('active', d.id === g.activeId);
        }
    }
    // 提示条：放在聚焦分栏的标签条下方
    const fgWrap = els.editor.querySelector('.egroup[data-gid="' + (focusedGroupId || (editorGroups[0] && editorGroups[0].id) || '') + '"]');
    if (fgWrap) {
        const fgHost = fgWrap.querySelector('.ehost');
        if (fgHost && els.banner.parentElement !== fgWrap) fgWrap.insertBefore(els.banner, fgHost);
    }
    // 全局 file 对齐聚焦组（直接更新 chrome，绝不递归回 renderTabs）
    if (!file || !groupOfDoc(file.id)) {
        const fg = focusedGroup();
        const fd = fg ? docs.find((d) => d.id === fg.activeId) : null;
        if (fd) {
            file = fd;
            dirty = !!fd.dirty;
        }
    }
    if (file) {
        setFilename(file.name, file.path);
        renderBreadcrumb(file.path);
        showBanner(file, file.parseError);
        updateWindowTitle();
        updateStatus();
        updateSearchState();
    }
}

function buildSplitNode(parent, node) {
    if (typeof node === 'string') { buildGroup(parent, node); return; }
    const wrap = document.createElement('div');
    wrap.className = 'esplit esplit-' + node.dir;
    const a = document.createElement('div');
    a.className = 'esplit-child';
    a.style.flexBasis = (node.ratio * 100) + '%';
    buildSplitNode(a, node.a);
    const b = document.createElement('div');
    b.className = 'esplit-child';
    buildSplitNode(b, node.b);
    wrap.append(a, makeSplitDivider(node), b);
    parent.appendChild(wrap);
}

function makeSplitDivider(node) {
    const d = document.createElement('div');
    d.className = 'esplit-divider';
    d.addEventListener('mousedown', (e) => {
        const childA = d.previousElementSibling;
        const childB = d.nextElementSibling;
        if (!childA || !childB) return;
        const horiz = node.dir === 'col';
        const start = horiz ? e.clientX : e.clientY;
        const rectA = childA.getBoundingClientRect();
        const total = horiz ? (rectA.width + childB.getBoundingClientRect().width) : (rectA.height + childB.getBoundingClientRect().height);
        const startRatio = node.ratio;
        setDragCursor(horiz ? 'ew' : 'ns');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const delta = (horiz ? ev.clientX : ev.clientY) - start;
            node.ratio = Math.min(0.8, Math.max(0.2, startRatio + delta / total));
            childA.style.flexBasis = (node.ratio * 100) + '%';
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            setDragCursor(null);
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    return d;
}

function buildGroup(parent, gid) {
    const g = groupById(gid);
    const wrap = document.createElement('div');
    wrap.className = 'egroup';
    wrap.dataset.gid = gid;
    const strip = document.createElement('div');
    strip.className = 'etabs';
    const single = editorGroups.length === 1 && !splitRoot;
    const hide = !g || !g.docIds.length || (settings.openMode === 'window' && g.docIds.length === 1 && single);
    if (hide) strip.classList.add('hidden');
    const host = document.createElement('div');
    host.className = 'ehost';
    if (g) for (const d of groupDocs(g)) strip.appendChild(buildGroupTab(g, d, strip));
    wrap.append(strip, host);
    wireHostDnd(host, gid);
    host.addEventListener('mousedown', () => {
        if (focusedGroupId !== gid) focusGroupById(gid);
    });
    parent.appendChild(wrap);
    // 标签条右侧工具区（视图切换 + 标签页操作），每个分栏组独立一份
    if (!hide) {
        const tools = buildGroupTools(gid);
        if (tools) {
            wrap.appendChild(tools);
            const spacer = document.createElement('div');
            spacer.className = 'tb-spacer';
            spacer.style.width = tools.offsetWidth + 'px';
            strip.appendChild(spacer);
        }
    }
}

const VIEW_ICONS = {
    tree: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3.2h11M1.5 7h7.6M1.5 10.8h4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>',
    table: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M1.5 5.6h11M5.3 2.2v9.6M9 2.2v9.6" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
    code: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4.4 3.6 1.7 7l2.7 3.4M9.6 3.6 12.3 7l-2.7 3.4M7.9 2.4 6.1 11.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    text: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.6h5.6L11.4 4v8.4H3z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5 7.2h4M5 9.6h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    preview: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    binary: '<svg viewBox="0 0 14 14" aria-hidden="true"><text x="2" y="10.6" font-size="9" font-family="JetBrains Mono, Consolas, monospace" font-weight="700" fill="currentColor">01</text></svg>',
    render: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 11c2.8 0 3.4-7 6.2-7 1.7 0 2 1.6 3.8 1.6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="12" cy="5.6" r="1.1" fill="currentColor"/></svg>',
};
const MORE_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="2.9" r="1.25" fill="currentColor"/><circle cx="7" cy="7" r="1.25" fill="currentColor"/><circle cx="7" cy="11.1" r="1.25" fill="currentColor"/></svg>';

function viewDisabledFor(doc, mode) {
    if (!doc) return true;
    if (mode === 'image') return !doc.image;
    if (mode === 'binary') return !doc.binary;
    if (mode === 'tree') return !doc.treeAvailable;
    if (mode === 'preview') return !(doc.format && doc.format.preview) || !!doc.large;
    if (mode === 'table') return !(doc.format && doc.format.table);
    if (mode === 'render') return !isSvgDoc(doc);
    return false;
}

function buildGroupTools(gid) {
    const g = groupById(gid);
    if (!g || !g.docIds.length) return null;
    const doc = docs.find((d) => d.id === g.activeId) || groupDocs(g)[0];
    if (!doc) return null;
    const tools = document.createElement('div');
    tools.className = 'tb-tools';
    for (const [mode, label] of viewOptionsFor(doc.format, doc)) {
        // 不可用的视图不显示（IDEA 只列可用视图），不摆灰态占位
        if (viewDisabledFor(doc, mode)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tb-view' + (doc.mode === mode ? ' active' : '');
        btn.title = label;
        btn.innerHTML = VIEW_ICONS[mode] || '';
        btn.addEventListener('click', async () => {
            if (file !== doc) await activateDoc(doc);
            if (currentMode !== mode) switchMode(mode);
            renderTabs();
        });
        tools.appendChild(btn);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tb-more';
    more.title = '标签页操作';
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        showTabbarToolsMenu(r.left, r.bottom + 4);
    });
    tools.appendChild(more);
    return tools;
}

function showTabbarToolsMenu(x, y) {
    if (!ctxMenu) return;
    const clean = docs.filter((d) => !d.dirty);
    ctxMenu.open([
        {label: '转到文件…', shortcut: 'Ctrl+Shift+N', icon: 'E721', action: () => {}},
        {sep: true},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '配置编辑器标签页…', icon: 'E713', action: () => openSettings('editor-tabs')},
    ], x, y);
}

function focusGroupById(gid) {
    focusedGroupId = gid;
    const g = groupById(gid);
    const d = g ? docs.find((x) => x.id === g.activeId) : null;
    if (d && file !== d) activateDoc(d);
}

function buildGroupTab(g, doc, strip) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (doc.id === g.activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '');
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
    tab.append(icon, dot, name, close);
    tab.addEventListener('click', (e) => {
        if (e.shiftKey && settings.shiftClickClose !== false) {
            e.preventDefault();
            requestCloseDoc(doc);
            return;
        }
        activateDoc(doc);
    });
    tab.addEventListener('dblclick', () => {
        if (settings.dblClickClose) requestCloseDoc(doc);
    });
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
    // 拖动：组内排序 + 跨区拖出分栏
    tab.draggable = true;
    const clearDropGaps = () => {
        strip.querySelectorAll('.tab.drop-gap-before, .tab.drop-gap-after').forEach((t) => {
            t.classList.remove('drop-gap-before', 'drop-gap-after');
        });
    };
    tab.addEventListener('dragstart', (e) => {
        dragTabId = doc.id;
        dragTabGroupId = g.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(doc.id)); } catch (err) {}
    });
    tab.addEventListener('dragend', () => {
        dragTabId = null;
        dragTabGroupId = null;
        tab.classList.remove('dragging');
        clearDropGaps();
        hideSplitMask();
        dropZone = null;
    });
    tab.addEventListener('dragover', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id || dragTabId === doc.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        clearDropGaps();
        if (before) tab.classList.add('drop-gap-before');
        else {
            const next = tab.nextElementSibling;
            if (next && next.classList.contains('tab')) next.classList.add('drop-gap-before');
            else tab.classList.add('drop-gap-after');
        }
    });
    tab.addEventListener('drop', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id) return;
        e.preventDefault();
        e.stopPropagation();
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        clearDropGaps();
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        moveTabInGroup(g.id, srcId, doc.id, before);
    });
    if (doc.id === g.activeId) setTimeout(() => {
        try { tab.scrollIntoView({block: 'nearest', inline: 'nearest'}); } catch (err) {}
    }, 0);
    return tab;
}

function wireHostDnd(host, gid) {
    host.addEventListener('dragover', (e) => {
        if (dragTabId === null) return;
        const srcG = groupById(dragTabGroupId);
        const selfSingle = srcG && srcG.id === gid && srcG.docIds.length <= 1;
        const tg = groupById(gid);
        const canSplit = !selfSingle && !!tg && tg.docIds.length > 0 && groupDepth(gid) < SPLIT_MAX_DEPTH;
        const cell = host.parentElement;
        if (!cell) return;
        const rect = cell.getBoundingClientRect();
        const relX = (e.clientX - rect.x) / rect.width;
        const relY = (e.clientY - rect.y) / rect.height;
        let zone = 'center';
        if (canSplit) {
            if (relX < 0.25) zone = 'left';
            else if (relX > 0.75) zone = 'right';
            else if (relY < 0.25) zone = 'top';
            else if (relY > 0.75) zone = 'bottom';
        }
        if (zone === 'left' || zone === 'right') {
            if (rect.width / 2 < SPLIT_MIN_W) zone = 'center';
        } else if (zone === 'top' || zone === 'bottom') {
            if (rect.height / 2 < SPLIT_MIN_H) zone = 'center';
        }
        dropZone = { gid, zone, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        showSplitMask();
    });
    host.addEventListener('dragleave', (e) => {
        if (!host.contains(e.relatedTarget)) { hideSplitMask(); dropZone = null; }
    });
    host.addEventListener('drop', (e) => {
        if (dragTabId === null) return;
        e.preventDefault();
        e.stopPropagation();
        const dz = dropZone;
        hideSplitMask();
        dropZone = null;
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        if (!dz) { renderTabs(); return; }
        try {
            performDrop(dz, srcId);
        } catch (err) {
            flash('分栏失败：' + (err && err.message || err), true);
            renderTabs();
        }
    });
}

function ensureSplitMask() {
    let m = document.getElementById('split-mask');
    if (!m) {
        m = document.createElement('div');
        m.id = 'split-mask';
        els.editorArea.appendChild(m);
    }
    return m;
}

function showSplitMask() {
    if (!dropZone) return;
    const area = els.editorArea.getBoundingClientRect();
    const r = dropZone.rect;
    let mx = r.x, my = r.y, mw = r.w, mh = r.h;
    if (dropZone.zone === 'left' || dropZone.zone === 'right') mw = r.w / 2;
    if (dropZone.zone === 'right') mx = r.x + r.w / 2;
    if (dropZone.zone === 'top' || dropZone.zone === 'bottom') mh = r.h / 2;
    if (dropZone.zone === 'bottom') my = r.y + r.h / 2;
    const m = ensureSplitMask();
    m.style.left = Math.round(mx - area.x) + 'px';
    m.style.top = Math.round(my - area.y) + 'px';
    m.style.width = Math.round(mw) + 'px';
    m.style.height = Math.round(mh) + 'px';
    m.style.display = 'block';
}

function hideSplitMask() {
    const m = document.getElementById('split-mask');
    if (m) m.style.display = 'none';
}

function performDrop(dz, srcId) {
    const doc = docs.find((d) => d.id === srcId);
    if (!doc) { renderTabs(); return; }
    const srcG = groupOfDoc(doc.id);
    if (!srcG) { renderTabs(); return; }
    if (dz.zone === 'center' || (srcG.id === dz.gid && srcG.docIds.length <= 1)) {
        activateDoc(doc);
        renderTabs();
        return;
    }
    const dir = (dz.zone === 'left' || dz.zone === 'right') ? 'col' : 'row';
    const side = (dz.zone === 'left' || dz.zone === 'top') ? 'before' : 'after';
    // 从源组移除
    srcG.docIds = srcG.docIds.filter((id) => id !== doc.id);
    if (srcG.activeId === doc.id) srcG.activeId = srcG.docIds[0] || null;
    removeGroupIfEmpty(srcG.id);
    // 目标组保留剩余文档，新组获得被拖文档
    const tg = groupById(dz.gid);
    if (!tg) { activateDoc(doc); renderTabs(); return; }
    tg.docIds = tg.docIds.filter((id) => id !== doc.id);
    if (tg.activeId === doc.id) tg.activeId = tg.docIds[0] || null;
    const ng = createGroup([doc.id]);
    ng.activeId = doc.id;
    // 单组尚未成树时以该组为根直接生成两层；已有树则替换对应叶子
    const base = splitRoot || dz.gid;
    splitRoot = (typeof base === 'string')
        ? { dir, ratio: 0.5, a: side === 'before' ? ng.id : base, b: side === 'before' ? base : ng.id }
        : splitReplaceLeaf(base, dz.gid, dir, side, ng.id);
    focusedGroupId = ng.id;
    renderTabs();
    activateDoc(doc);
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
    if (currentMode === 'tree') {
        const btn = editor.dom && editor.dom.undo;
        if (btn && !btn.disabled) { treeHistory('undo'); return; }
    } else if (currentMode === 'table') {
        if (file && file.tableUndo && file.tableUndo.length) { tableHistory('undo'); return; }
    } else if (currentMode === 'code' && editor.aceEditor) {
        const um = editor.aceEditor.session.getUndoManager();
        if (um && um.hasUndo()) { editor.aceEditor.execCommand('undo'); return; }
    } else if (currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            if (document.execCommand('undo')) return;
        }
    }
    // 操作栈为空但文件仍处于修改状态：Ctrl+Z 直接退回未修改（已保存）状态
    if (file && file.dirty) revertDocToSaved(file);
}

// revertDocToSaved：把文档内容回退到最后一次保存（或打开/新建）时的状态
function revertDocToSaved(doc) {
    if (!doc || !doc.editor) return;
    const target = doc.savedText != null ? doc.savedText : (doc.content != null ? doc.content : '');
    let value = null;
    if (currentMode === 'tree') {
        try { value = doc.format.parse(target); } catch (e) { flash('无法回退：已保存内容解析失败', true); return; }
    }
    doc.loading = true;
    try {
        if (currentMode === 'tree') editor.set(value);
        else editor.setText(target);
        doc.text = target;
        doc.bases[doc.mode] = target;
        doc.dirty = false;
        if (file === doc) {
            setDirty(false);
            updateStatus();
            updateWindowTitle();
        }
        updateTabDirty(doc);
        updateBackendDirty();
        if (currentMode === 'table') renderCsvTableView(doc);
    } finally {
        doc.loading = false;
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
    const tableZoom = currentMode === 'table' && file.format && file.format.table;
    const renderZoom = currentMode === 'render' && file && file.svgRenderScale
        ? Math.round(file.svgRenderScale * 100) + '%' : '';
    const zoom = file.image && currentMode === 'image' && file.imageScale
        ? Math.round(file.imageScale * 100) + '%'
        : renderZoom || (tableZoom ? Math.round((file.tableZoom || 1) * 100) + '%' : '');
    els.stZoom.textContent = zoom;
    els.stZoom.title = zoom
        ? (tableZoom ? '表格缩放比例（点击选择，Ctrl+滚轮调整）' : '图片缩放比例（点击选择，Ctrl+滚轮调整，双击图片恢复适配）')
        : '';
    if (file.binary) {
        els.stEol.textContent = '';
        els.stEnc.textContent = '';
        els.stEol.style.display = 'none';
        els.stEnc.style.display = 'none';
        scheduleCursorPosition();
        return;
    }
    els.stEol.style.display = '';
    els.stEnc.style.display = '';
    const eolSetting = fmt ? getFormatSettings(fmt.id).eol : 'follow';
    els.stEol.textContent = (eolSetting === 'follow' ? file.eol : eolSetting).toUpperCase();
    const enc = (file.enc || 'utf-8').toUpperCase();
    els.stEnc.textContent = enc + (file.hasBom && enc === 'UTF-8' ? ' BOM' : '');
    scheduleCursorPosition();
    if (typeof scheduleStructureRefresh === 'function') scheduleStructureRefresh(file);
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
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return '[...]';
    if (typeof value === 'object') return '{...}';
    return String(value);
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
    return {
        kind: 'object',
        keyText,
        valueText: clipFoldText(foldPrimitive(value[keys[0]]), 30),
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
                    renderFoldPreview(el, 'o:empty', (wrap) => foldSpan(wrap, '{}', 'jsoneditor-fold-text'));
                } else if (spec) {
                    renderFoldPreview(el, 'o:' + JSON.stringify(spec), (wrap) => {
                        foldSpan(wrap, '{', 'jsoneditor-fold-text');
                        foldSpan(wrap, spec.keyText, 'jsoneditor-fold-text');
                        foldSpan(wrap, ': ', 'jsoneditor-fold-text');
                        foldSpan(wrap, spec.valueText, 'jsoneditor-fold-text');
                        foldSpan(wrap, '...', 'jsoneditor-fold-text');
                        foldSpan(wrap, '}', 'jsoneditor-fold-text');
                    });
                } else {
                    renderFoldPreview(el, 'of:' + count, (wrap) => {
                        foldSpan(wrap, '{' + count + ' 项}', 'jsoneditor-fold-text');
                    });
                }
            } else if (count === 0) {
                renderFoldPreview(el, 'a:0', (wrap) => foldSpan(wrap, '[]', 'jsoneditor-fold-text'));
            } else {
                renderFoldPreview(el, 'a:' + count, (wrap) => {
                    foldSpan(wrap, '[ ', 'jsoneditor-fold-text');
                    foldSpan(wrap, count + ' 个元素', 'jsoneditor-fold-text');
                    foldSpan(wrap, '... ]', 'jsoneditor-fold-text');
                });
            }
            el.removeAttribute('title');
        } else {
            const text = settings.treeCounts ? count + ' 项' : '';
            if (el.textContent !== text || el.querySelector('.jsoneditor-fold-preview')) el.textContent = text;
            el.dataset.foldSig = 'e:' + count + ':' + (settings.treeCounts ? '1' : '0');
            el.title = settings.treeCounts ? (isObject ? '对象' : '数组') + '，共 ' + count + ' 项' : '';
        }
        el.classList.toggle('value-fold', collapsed);
        el.classList.toggle('value-count', !collapsed && !!settings.treeCounts);
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

function applyAceMode(force) {
    if (!force && (currentMode !== 'code' && currentMode !== 'binary')) return;
    if (!editor || !editor.aceEditor) return;
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
        // 关闭 worker 后旧 JSON 校验注解不会自动消失（切到 Markdown 等模式仍留红叉）
        if (!pureJson) {
            try { editor.aceEditor.session.clearAnnotations(); } catch (e) {}
        }
        editor.aceEditor.setReadOnly(!!(file && (file.large || file.binary)) || !!settings.readOnlyMode);
        editor.aceEditor.setFontSize(settings.editorFont);
        editor.aceEditor.session.setUseWrapMode(!!settings.codeWrap);
        if (file && file.format) {
            const fs = getFormatSettings(file.format.id);
            const tab = fs.indent === 'tab';
            editor.aceEditor.session.setUseSoftTabs(!tab);
            editor.aceEditor.session.setTabSize(tab ? 4 : Number(fs.indent));
        }
        editor.aceEditor.setDisplayIndentGuides(!!settings.codeGuides);
        editor.aceEditor.setHighlightIndentGuides(!!settings.codeGuides);
        hookCodeFoldPreviews(editor.aceEditor);
        hookFoldChevronHover(editor.aceEditor);
        hookPythonTokenClasses(editor.aceEditor);
        hookCursorTracking(editor.aceEditor);
        updateCodeFoldPreviews(editor.aceEditor);
    } catch (e) {
        console.warn('ace mode switch failed', e);
    }
}

const codeFoldLanguages = {
    json: 'json', json5: 'json', jsonl: 'json',
    yaml: 'yaml', xml: 'xml', html: 'xml', css: 'css',
    javascript: 'javascript', typescript: 'typescript',
    markdown: 'markdown', python: 'python', sh: 'bash', bash: 'bash',
    batchfile: 'dos', powershell: 'powershell', golang: 'go', go: 'go',
    java: 'java', kotlin: 'kotlin', lua: 'lua', sql: 'sql',
    toml: 'ini', ini: 'ini', properties: 'ini', text: 'plaintext',
};

let codeFoldHoverEl = null;
let codeFoldHoverGutter = null;
let codeFoldHoverCode = null;
let codeFoldHoverShowTimer = 0;
let codeFoldHoverHideTimer = 0;
let codeFoldHoverTarget = null;

function ensureCodeFoldHover() {
    if (codeFoldHoverEl) return codeFoldHoverEl;
    codeFoldHoverEl = document.createElement('div');
    codeFoldHoverEl.id = 'code-fold-hover';
    codeFoldHoverEl.className = 'hidden';
    codeFoldHoverGutter = document.createElement('pre');
    codeFoldHoverGutter.className = 'code-fold-gutter';
    codeFoldHoverCode = document.createElement('pre');
    codeFoldHoverCode.className = 'code-fold-code';
    codeFoldHoverEl.append(codeFoldHoverGutter, codeFoldHoverCode);
    codeFoldHoverEl.addEventListener('mouseenter', () => {
        clearTimeout(codeFoldHoverHideTimer);
    });
    codeFoldHoverEl.addEventListener('mouseleave', () => {
        codeFoldHoverHideTimer = setTimeout(hideCodeFoldHover, 120);
    });
    document.body.appendChild(codeFoldHoverEl);
    return codeFoldHoverEl;
}

function hideCodeFoldHover() {
    clearTimeout(codeFoldHoverShowTimer);
    clearTimeout(codeFoldHoverHideTimer);
    codeFoldHoverTarget = null;
    if (codeFoldHoverEl) codeFoldHoverEl.classList.add('hidden');
}

function codeFoldLineFromEvent(e) {
    const target = e.target;
    if (!target || !target.closest) return null;
    const line = target.closest('.ace_line');
    if (!line || !line.querySelector('.ace_fold')) return null;
    const ace = editor && editor.aceEditor;
    if (!ace || !ace.container.contains(line)) return null;
    return line;
}

function codeFoldForLine(lineEl) {
    const ace = editor && editor.aceEditor;
    if (!ace || !lineEl || !ace.container.contains(lineEl)) return null;
    let row = null;
    try {
        const rect = lineEl.getBoundingClientRect();
        const position = ace.renderer.screenToTextCoordinates(rect.left + 1, rect.top + rect.height / 2);
        row = position.row;
    } catch (e) {
        return null;
    }
    const folds = ace.session.getAllFolds();
    const starts = folds.filter((fold) => fold.range && fold.range.start && fold.range.start.row === row);
    if (starts.length) {
        starts.sort((left, right) => right.range.end.row - left.range.end.row);
        return {ace, fold: starts[0]};
    }
    const containing = folds.find((fold) => fold.range && row >= fold.range.start.row && row <= fold.range.end.row);
    return containing ? {ace, fold: containing} : null;
}

function codeFoldLanguage(session) {
    const id = session && session.getMode ? String(session.getMode().$id || '').split('/').pop() : '';
    return codeFoldLanguages[id] || 'plaintext';
}

function clipCodeFoldPreview(text, max) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    return compact.length > max ? compact.slice(0, max) : compact;
}

function codeFoldDisplayWidth(text) {
    let width = 0;
    for (const ch of String(text)) {
        width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    }
    return width;
}

function clipCodeFoldText(text, maxWidth) {
    const raw = String(text == null ? '' : text);
    if (codeFoldDisplayWidth(raw) <= maxWidth) return raw;
    let out = '';
    let width = 0;
    for (const ch of raw) {
        const chWidth = codeFoldDisplayWidth(ch);
        if (width + chWidth > maxWidth) break;
        out += ch;
        width += chWidth;
    }
    return out + (raw.startsWith('"') ? '"' : '');
}

function extendCodeFoldRange(session, fold) {
    const range = fold && fold.range;
    if (!range || !range.start || !range.end) return;
    const startLine = session.getLine(range.start.row) || '';
    if (range.start.column > 0) {
        const before = startLine[range.start.column - 1];
        if (before === '{' || before === '[') range.start.column -= 1;
    }
    const endLine = session.getLine(range.end.row) || '';
    const after = endLine[range.end.column];
    if (after === '}' || after === ']') range.end.column += 1;
}

function codeFoldPreviewFor(ace, fold) {
    const session = ace.session;
    const startLine = (session.getLine(fold.range.start.row) || '').trimEnd();
    const inner = (session.getTextRange(fold.range) || '').trimStart();
    // JetBrains 风格：花括号块 {...}、方括号块 [...]、缩进块 ...
    if (/\{$/.test(startLine) || inner.startsWith('{')) return '{...}';
    if (/\[$/.test(startLine) || inner.startsWith('[')) return '[...]';
    return '...';
}

function updateCodeFoldPreviews(ace) {
    if (!ace || !ace.session || !ace.session.getAllFolds) return;
    const folds = ace.session.getAllFolds();
    if (!folds.length) return;
    let changed = false;
    for (const fold of folds) {
        extendCodeFoldRange(ace.session, fold);
        let preview = '';
        try {
            preview = codeFoldPreviewFor(ace, fold);
        } catch (e) {
            continue;
        }
        if (fold.placeholder !== preview) {
            fold.placeholder = preview;
            changed = true;
        }
    }
    if (changed) {
        try {
            ace.renderer.updateFull(true);
        } catch (e) {
            ace.renderer.updateFull();
        }
    }
}

function hookCodeFoldPreviews(ace) {
    if (!ace || ace._foldPreviewHooked) return;
    ace._foldPreviewHooked = true;
    hookFoldChevronHover(ace);
    const schedule = () => {
        clearTimeout(ace._foldPreviewTimer);
        ace._foldPreviewTimer = setTimeout(() => {
            ace._foldPreviewTimer = 0;
            updateCodeFoldPreviews(ace);
        }, 40);
    };
    ace.session.on('changeFold', () => updateCodeFoldPreviews(ace));
    ace.session.on('change', schedule);
}

// hookFoldChevronHover：鼠标进入行号区时显示全部展开态折叠箭头（∨），离开隐藏；折叠态（>）常显由 CSS 保证
function hookFoldChevronHover(ace) {
    if (!ace || !ace.renderer || ace._chevHover) return;
    ace._chevHover = true;
    const layer = ace.renderer.$gutterLayer;
    if (!layer || !layer.element) { window.__chevErr = 'no layer'; return; }
    window.__chevErr = null;
    layer.element.dataset.chevHooked = '1';
    layer.element.addEventListener('mouseenter', () => layer.element.classList.add('chev-show'));
    layer.element.addEventListener('mouseleave', () => layer.element.classList.remove('chev-show'));
}

function hookCursorTracking(ace) {
    if (!ace || ace._cursorTracked) return;
    ace._cursorTracked = true;
    const update = () => {
        if (file && currentMode === 'code' && file.editor && file.editor.aceEditor === ace) {
            updateCursorPosition();
            if (structurePanel) structurePanel.setCursor(ace.getCursorPosition().row + 1);
        }
    };
    try {
        ace.selection.on('changeCursor', update);
        ace.on('focus', update);
    } catch (e) {}
}

function applyPythonTokenClasses(ace) {
    if (!ace || !ace.container || !ace.container.classList.contains('ace-mode-python')) return;
    const layer = ace.container.querySelector('.ace_text-layer');
    if (!layer) return;
    for (const el of layer.querySelectorAll('.py-kwarg, .py-builtin, .py-doc')) el.classList.remove('py-kwarg', 'py-builtin', 'py-doc');
    for (const line of layer.querySelectorAll('.ace_line')) {
        const spans = [...line.children];
        let depth = 0;
        let isDefinition = false;
        for (const span of spans) {
            if (span.classList.contains('ace_keyword') && /^(def|class)$/.test(span.textContent || '')) isDefinition = true;
        }
        if (isDefinition) continue;
        // 双下划线预定义名（__name__/__file__…）→ 内置名紫色（PyCharm PY.BUILTIN_NAME）
        for (const span of spans) {
            if (span.classList.contains('ace_identifier') && /^__\w+__$/.test((span.textContent || '').trim())) {
                span.classList.add('py-builtin');
            }
        }
        // 整行都是字符串 → 三引号 docstring（PyCharm 文档字符串：弱绿斜体）
        const nonEmpty = spans.filter((sp) => (sp.textContent || '').trim());
        if (nonEmpty.length && nonEmpty.every((sp) => sp.classList.contains('ace_string'))) {
            for (const sp of nonEmpty) sp.classList.add('py-doc');
        }
        for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            const text = span.textContent || '';
            for (const ch of text) {
                if (ch === '(') depth++;
                else if (ch === ')') depth = Math.max(0, depth - 1);
            }
            if (depth <= 0 || !span.classList.contains('ace_identifier')) continue;
            const next = spans[i + 1];
            if (next && next.classList.contains('ace_keyword') && next.classList.contains('ace_operator') && next.textContent === '=') {
                span.classList.add('py-kwarg');
            }
        }
    }
}

function hookPythonTokenClasses(ace) {
    if (!ace || ace._pythonTokenHooked) return;
    const layer = ace.container && ace.container.querySelector('.ace_text-layer');
    if (!layer) return;
    ace._pythonTokenHooked = true;
    let timer = 0;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = 0;
            applyPythonTokenClasses(ace);
        }, 30);
    };
    new MutationObserver(schedule).observe(layer, {childList: true, subtree: true});
    try {
        ace.renderer.on('afterRender', schedule);
    } catch (e) {}
    schedule();
}

function showCodeFoldHover(lineEl) {
    const found = codeFoldForLine(lineEl);
    if (!found) return;
    const {ace, fold} = found;
    const start = fold.range.start.row;
    const end = fold.range.end.row;
    let lines = ace.session.getLines(start, end);
    const truncated = lines.length > 200;
    if (truncated) lines = lines.slice(0, 200);
    let text = lines.join('\n');
    if (truncated) text += '\n…';
    const gutterText = Array.from({length: lines.length}, (_, index) => String(start + 1 + index)).join('\n');
    ensureCodeFoldHover();
    codeFoldHoverGutter.textContent = gutterText;
    const language = codeFoldLanguage(ace.session);
    let highlighted = '';
    try {
        if (hljs.getLanguage(language)) highlighted = hljs.highlight(text, {language}).value;
    } catch (e) {}
    if (highlighted) codeFoldHoverCode.innerHTML = highlighted;
    else codeFoldHoverCode.textContent = text;
    codeFoldHoverEl.scrollTop = 0;
    codeFoldHoverEl.scrollLeft = 0;
    codeFoldHoverEl.style.visibility = 'hidden';
    codeFoldHoverEl.style.left = '0px';
    codeFoldHoverEl.style.top = '0px';
    codeFoldHoverEl.classList.remove('hidden');
    const width = codeFoldHoverEl.offsetWidth;
    const height = codeFoldHoverEl.offsetHeight;
    const rect = lineEl.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 4;
    top = Math.max(margin, top);
    codeFoldHoverEl.style.left = left + 'px';
    codeFoldHoverEl.style.top = top + 'px';
    codeFoldHoverEl.style.visibility = '';
    codeFoldHoverTarget = lineEl;
}

function initCodeFoldHover() {
    if (!els.editor) return;
    ensureCodeFoldHover();
    els.editor.addEventListener('mouseover', (e) => {
        const line = codeFoldLineFromEvent(e);
        if (!line || line === codeFoldHoverTarget) return;
        if (!codeFoldForLine(line)) return;
        codeFoldHoverTarget = line;
        clearTimeout(codeFoldHoverShowTimer);
        clearTimeout(codeFoldHoverHideTimer);
        if (codeFoldHoverEl) codeFoldHoverEl.classList.add('hidden');
        codeFoldHoverShowTimer = setTimeout(() => showCodeFoldHover(line), 280);
    });
    els.editor.addEventListener('mouseout', (e) => {
        const line = codeFoldLineFromEvent(e);
        const related = e.relatedTarget;
        if (related && ((line && line.contains(related)) || (codeFoldHoverEl && codeFoldHoverEl.contains(related)))) return;
        if (!codeFoldHoverTarget) return;
        if (line && line !== codeFoldHoverTarget) return;
        clearTimeout(codeFoldHoverShowTimer);
        codeFoldHoverHideTimer = setTimeout(hideCodeFoldHover, 140);
    });
    document.addEventListener('pointerdown', (e) => {
        if (codeFoldHoverEl && e.target && codeFoldHoverEl.contains(e.target)) return;
        hideCodeFoldHover();
    }, true);
    window.addEventListener('scroll', (e) => {
        if (codeFoldHoverEl && e.target && codeFoldHoverEl.contains(e.target)) return;
        hideCodeFoldHover();
    }, true);
    window.addEventListener('resize', hideCodeFoldHover);
    window.addEventListener('blur', hideCodeFoldHover);
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
    if (typeof scheduleStructureRefresh === 'function') scheduleStructureRefresh(doc);
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
    let startMode = doc.mode === 'text' ? 'text' : (!doc.treeAvailable ? 'code' : (doc.mode === 'code' ? 'code' : 'tree'));
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
        modes: fmt.table ? ['tree', 'text'] : (doc.treeAvailable ? ['tree', 'code', 'text'] : ['code', 'text']),
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
    if (ed.aceEditor) { hookCodeFoldPreviews(ed.aceEditor); hookFoldChevronHover(ed.aceEditor); }
    if (settings.treeExpandDefault === 'collapse' && startMode === 'tree' && doc.treeAvailable && !doc.large) {
        setTimeout(() => {
            try { if (doc.editor) doc.editor.collapseAll(); } catch (e) {}
        }, 50);
    }
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
            ed.aceEditor.setDisplayIndentGuides(!!settings.codeGuides);
            ed.aceEditor.setHighlightIndentGuides(!!settings.codeGuides);
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
        ? '文件超过 10 MB，表格只读；可拖表头边缘调列宽；Ctrl+滚轮缩放'
        : '点击单元格编辑；拖表头边缘调列宽；Ctrl+滚轮缩放；Enter 确认，Esc 取消';
    bar.append(meta, hint);
    const scroll = document.createElement('div');
    scroll.className = 'csv-table-scroll';
    wrap.append(bar, scroll);
    doc.pane.appendChild(wrap);
    doc.tableEl = wrap;
    doc.tableMeta = meta;
    doc.tableScroll = scroll;
    if (!doc.tableZoom) doc.tableZoom = 1;
    applyCsvTableZoom(doc);
}

function applyCsvTableZoom(doc) {
    if (!doc || !doc.tableEl) return;
    doc.tableEl.style.setProperty('--csv-zoom', String(doc.tableZoom || 1));
}

function zoomCsvTable(doc, deltaY) {
    if (!doc || !doc.tableEl || !deltaY) return;
    const dir = deltaY < 0 ? 1 : -1;
    const current = doc.tableZoom || 1;
    const next = Math.min(8, Math.max(0.25, Math.round((current + dir * 0.1) * 10) / 10));
    if (next === current) return;
    doc.tableZoom = next;
    applyCsvTableZoom(doc);
    updateStatus();
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
    const zoom = doc.tableZoom || 1;
    doc.tableColWidths = ths.map((th) => Math.max(CSV_COL_MIN_WIDTH, Math.round(th.getBoundingClientRect().width / zoom)));
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
    const zoom = doc.tableZoom || 1;
    const onMove = (ev) => {
        const next = Math.max(CSV_COL_MIN_WIDTH, Math.round(startWidth + (ev.clientX - startX) / zoom));
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
    if (op.full) {
        applyCsvTableText(doc, action === 'undo' ? op.before : op.after);
        to.push(op);
        renderCsvTableView(doc);
        return;
    }
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
        resolveMarkdownImages(doc);
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
    // 预览底层编辑器本来就是 code 模式，setMode('code') 不会触发 onModeChange，
    // 必须显式应用 Markdown 等语法模式（否则残留 jsoneditor 默认 JSON 模式）
    if (doc === file && mode === 'code') applyAceMode(true);
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

function applySvgZoom(doc) {
    if (!doc || !doc.svgRenderImg || !doc.svgRenderScroll || !doc.svgRenderW || !doc.svgRenderH) return;
    const scroll = doc.svgRenderScroll;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width < 20 || height < 20) return;
    const availableWidth = Math.max(1, width - 36);
    const availableHeight = Math.max(1, height - 36);
    const scale = doc.svgRenderZoom == null
        ? Math.min(1, availableWidth / doc.svgRenderW, availableHeight / doc.svgRenderH)
        : doc.svgRenderZoom;
    const previous = doc.svgRenderScale || 0;
    const centerX = scroll.scrollLeft + width / 2;
    const centerY = scroll.scrollTop + height / 2;
    doc.svgRenderScale = scale;
    doc.svgRenderImg.style.width = Math.max(1, Math.round(doc.svgRenderW * scale)) + 'px';
    doc.svgRenderImg.style.height = Math.max(1, Math.round(doc.svgRenderH * scale)) + 'px';
    if (previous > 0 && Math.abs(scale - previous) > 0.0001) {
        const ratio = scale / previous;
        requestAnimationFrame(() => {
            if (!doc.svgRenderScroll) return;
            scroll.scrollLeft = Math.max(0, centerX * ratio - width / 2);
            scroll.scrollTop = Math.max(0, centerY * ratio - height / 2);
        });
    }
    if (doc === file) updateStatus();
}

function zoomSvgRenderBy(doc, deltaY) {
    if (!doc || !doc.svgRenderW || !deltaY) return;
    const base = doc.svgRenderScale || 1;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    doc.svgRenderZoom = Math.min(8, Math.max(0.05, Math.round(base * factor * 1000) / 1000));
    applySvgZoom(doc);
}

function showSvgRender(doc) {
    createSvgRenderView(doc);
    if (doc.pane) doc.pane.classList.add('svg-render-active');
    if (!doc.svgRenderImg || !doc.editor) return;
    // 树模式下 getText() 是 JSON 序列化，必须走 format.stringify(editor.get()) 还原成 SVG 文本
    let svgText = null;
    try { svgText = doc.format.stringify(doc.editor.get()); } catch (e) {
        svgText = doc.rawText != null ? doc.rawText : (doc.content || '');
    }
    doc.svgRenderImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
}

function hideSvgRender(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('svg-render-active');
}

function enterSvgRender(doc) {
    if (!doc || !doc.editor) return;
    doc.loading = true;
    try {
        // 记录退出渲染视图时的 SVG 源文本：
        // 树模式下 getText() 是树值的 JSON 序列化，必须用 format.stringify 还原 XML 源
        let src = null;
        if (doc.mode === 'tree') {
            try { src = doc.format.stringify(doc.editor.get()); } catch (e) {}
        }
        if (!src || !src.trim()) src = doc.editor.getText();
        if (!src || !src.trim()) src = doc.rawText != null ? doc.rawText : (doc.content || '');
        doc._svgSrcText = src;
        doc.editor.setMode('code');
        doc.mode = 'render';
        currentMode = 'render';
        showSvgRender(doc);
        showBanner(doc, doc.parseError);
        updateStatus();
        updateSearchState();
    } finally {
        doc.loading = false;
    }
}

function createSvgRenderView(doc) {
    if (doc.svgRenderEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'svg-render-view';
    const scroll = document.createElement('div');
    scroll.className = 'svg-render-scroll';
    const img = document.createElement('img');
    img.className = 'svg-render-img';
    img.alt = doc.name || 'SVG';
    img.onload = () => {
        doc.svgRenderW = img.naturalWidth || 240;
        doc.svgRenderH = img.naturalHeight || 120;
        applySvgZoom(doc);
    };
    scroll.appendChild(img);
    doc.svgRenderScroll = scroll;
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.svgRenderEl = wrap;
    doc.svgRenderImg = img;
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

function enterTextView(doc) {
    if (!doc || !doc.editor) return;
    hideImageView(doc);
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode('text');
        doc.mode = 'text';
        currentMode = 'text';
        if (doc.pane) doc.pane.classList.add('active');
        showBanner(doc, doc.parseError);
        updateStatus();
        updateSearchState();
    } catch (e) {
        flash('切换文本视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    applyReadOnlyToDoc(doc);
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
            savedText: data.content,
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
    const ext = String(data.name || '').split('.').pop().toLowerCase();
    const plainTextView = format.id === 'text' && plainTextExtensions.has(ext) && !data.large;
    const preferredMode = plainTextView ? 'text' : format.preview
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
        mode: plainTextView ? 'text' : format.preview ? (data.large ? 'code' : preferredMode) : (treeAvailable ? preferredMode : 'code'),
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null, text: null, table: null, preview: null},
        savedText: data.content,
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
    if (!docs.length) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
    }
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
    if (structurePanel) structurePanel.setDoc(null);
}

let activateToken = 0;

async function activateDoc(doc) {
    if (!doc) return;
    if (doc === file) {
        const g0 = groupOfDoc(doc.id);
        if (g0) { g0.activeId = doc.id; focusedGroupId = g0.id; }
        return;
    }
    let g = groupOfDoc(doc.id);
    if (!g) {
        g = focusedGroup() || createGroup();
        if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    }
    g.activeId = doc.id;
    focusedGroupId = g.id;
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
    if (!els.editor.querySelector('.egroup[data-gid="' + g.id + '"]')) renderEditorLayout();
    for (const d of groupDocs(g)) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    const host = els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
    if (host && doc.pane && doc.pane.parentElement !== host) host.appendChild(doc.pane);
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
    if (structurePanel) structurePanel.setDoc(doc);
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

function closeDocNow(doc, remember = true) {
    const idx = docs.indexOf(doc);
    if (idx < 0) return;
    const wasActive = doc === file;
    if (doc.path && remember) {
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
    const g = groupOfDoc(doc.id);
    if (g) {
        g.docIds = g.docIds.filter((id) => id !== doc.id);
        if (g.activeId === doc.id) g.activeId = g.docIds[0] || null;
        removeGroupIfEmpty(g.id);
    }
    if (docs.length === 0) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
        editor = null;
        showWelcome();
        return;
    }
    if (wasActive) {
        editor = null;
        file = null;
        dirty = false;
        let next = null;
        if (g && g.docIds.length) {
            const at = Math.min(idx, g.docIds.length - 1);
            next = docs.find((d) => d.id === g.docIds[at]) || docs.find((d) => d.id === g.docIds[0]);
        }
        if (!next) {
            const fg = focusedGroup();
            next = fg ? docs.find((d) => d.id === fg.activeId) : null;
        }
        if (!next) next = docs[Math.min(idx, docs.length - 1)] || docs[0];
        renderTabs();
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
    const g0 = groupOfDoc(doc.id);
    const gdocs = g0 ? groupDocs(g0) : docs.slice();
    const idx = gdocs.indexOf(doc);
    const others = gdocs.filter((d) => d !== doc);
    const left = gdocs.slice(0, Math.max(0, idx));
    const clean = gdocs.filter((d) => !d.dirty);
    const hasPath = !!doc.path;
    ctxMenu.open([
        {label: '关闭', shortcut: 'Ctrl+W / Shift+点击', icon: 'E8BB', action: () => requestCloseDoc(doc)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => closeDocsWithConfirm(others)},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(gdocs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
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

function deleteExplorerEntries(targets) {
    const list = clipboardItems(targets);
    if (!list.length) return;
    if (!backend.DeleteEntry) {
        flash('当前版本不支持删除', true);
        return;
    }
    if (settings.readOnlyMode) {
        flash('只读模式下不能删除', true);
        return;
    }
    const rootPath = explorer && explorer.getRoot ? explorer.getRoot() : '';
    const deletable = list.filter((item) => !(rootPath && samePathValue(rootPath, item.path)));
    if (!deletable.length) {
        flash('不能删除文件树的根目录', true);
        return;
    }
    const openDocs = docs.filter((doc) => doc.path && deletable.some((item) =>
        item.isDir ? pathWithinValue(item.path, doc.path) : samePathValue(item.path, doc.path)));
    const dirty = openDocs.some((doc) => doc.dirty);
    const what = deletable.length === 1 ? '“' + deletable[0].name + '”' : '选中的 ' + deletable.length + ' 个项目';
    const message = dirty
        ? what + '已打开且有未保存的修改，删除后这些修改会一并丢失。\n确定移到回收站吗？'
        : what + '将被移到回收站，确定继续吗？';
    openCloseConfirm(message, async () => {
        const deleted = [];
        const failures = [];
        for (const item of deletable) {
            try {
                await backend.DeleteEntry(item.path);
                deleted.push(item);
            } catch (e) {
                failures.push(item.name + '：' + ((e && e.message) || e));
            }
        }
        if (deleted.length) {
            for (const doc of docs.slice()) {
                if (!doc.path) continue;
                if (deleted.some((item) =>
                    item.isDir ? pathWithinValue(item.path, doc.path) : samePathValue(item.path, doc.path))) {
                    closeDocNow(doc, false);
                }
            }
            closedTabs = closedTabs.filter((entry) => !deleted.some((item) =>
                item.isDir ? pathWithinValue(item.path, entry.path) : samePathValue(item.path, entry.path)));
            if (fileClipboard && fileClipboard.cut) {
                fileClipboard.items = fileClipboard.items.filter((item) => !deleted.some((target) =>
                    target.isDir ? pathWithinValue(target.path, item.path) : samePathValue(target.path, item.path)));
                if (!fileClipboard.items.length) fileClipboard = null;
            }
            if (explorer) {
                for (const item of deleted) explorer.removePath(item.path);
                explorer.setCutPaths(fileClipboard && fileClipboard.cut ? fileClipboard.items.map((item) => item.path) : []);
                explorer.refresh();
            }
        }
        if (failures.length) {
            flash('删除失败：' + failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''), true);
        } else {
            flash(deleted.length > 1 ? '已删除 ' + deleted.length + ' 个项目' : '已删除：' + deleted[0].name);
        }
    }, '删除', '删除');
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
    const rootPath = explorer && explorer.getRoot ? explorer.getRoot() : '';
    const deletable = targets.filter((item) => !(rootPath && samePathValue(rootPath, item.path)));
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
        if (gitStateCache.map.get(info.path.replace(/\\/g, '/'))) {
            items.push({label: 'Git：查看差异', icon: 'E8D3', action: () => showGitDiff(info.path)});
        }
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
        items.push({
            label: '结构化目录',
            iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14M5.5 8.5h11.5M8 12.5h9M10.5 16.5h6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
            submenu: [
                {label: '复制', icon: 'E8C8', action: () => copyStructuredDir(info.path)},
                {label: '导出…', icon: 'E74E', action: () => exportStructuredDir(info.path)},
            ],
        });
        items.push({sep: true});
    }
    items.push({
        label: '重命名…',
        shortcut: 'F2',
        icon: 'E8AC',
        disabled: !!settings.readOnlyMode || targets.length !== 1,
        action: () => openRenameEntryDialog(info),
    });
    items.push({
        label: '删除',
        shortcut: 'Delete',
        icon: 'E74D',
        danger: true,
        disabled: !!settings.readOnlyMode || !deletable.length,
        action: () => deleteExplorerEntries(targets),
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
                await openFolderSmart(data.path);
                continue;
            }
            const doc = createDoc(data);
            docs.push(doc);
            addDocToFocusedGroup(doc);
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

// 结构视图读取的源文本：树视图用打开时的原文（行号与源文件一致），
// 代码/文本/预览用编辑器当前内容，SVG 渲染视图用进入渲染前保存的原文。
function structureTextForDoc(doc) {
    if (!doc || doc.binary) return '';
    if (doc === file && doc.editor) {
        if (currentMode === 'render') {
            return doc._svgSrcText || doc.rawText || doc.text || '';
        }
        if (currentMode === 'tree' && doc.format && !doc.format.rawOnly) {
            return doc.rawText != null ? doc.rawText : (doc.text || '');
        }
        if (currentMode === 'table' && doc.pane) {
            const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
            if (textarea) return textarea.value;
        }
        return doc.editor.getText() || '';
    }
    return doc.rawText != null ? doc.rawText : (doc.text || doc.content || '');
}

async function jumpToStructureNode(node) {
    if (!file || !node || file.binary) return;
    const line = Math.max(1, Number(node.line) || 1);
    const column = Math.max(1, Number(node.column) || 1);
    await selectLineInDoc(file, line, column);
    if (structurePanel) structurePanel.setCursor(line);
}

function scheduleStructureRefresh(doc) {
    if (!structurePanel || !settings.showSidebar || currentSidebarView() !== 'structure') return;
    if (doc && file && doc !== file) return;
    clearTimeout(structureRefreshTimer);
    structureRefreshTimer = setTimeout(() => {
        structureRefreshTimer = 0;
        if (!structurePanel || !settings.showSidebar || currentSidebarView() !== 'structure') return;
        structurePanel.refresh();
    }, 500);
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
        if (dir) await openFolderSmart(dir);
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

// 一目录一窗口：本窗口已有工作区目录时，新目录另开窗口；
// 当前窗口没有目录时才在本窗口打开。
async function openFolderSmart(dir) {
    if (!dir) return;
    if (workspaceFolder) {
        const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (norm(dir) === norm(workspaceFolder)) {
            flash('该目录已在当前窗口打开');
            return;
        }
        try {
            if (backend.OpenDirInNewWindow) await backend.OpenDirInNewWindow(dir);
            else await backend.OpenInNewWindows([dir]);
            flash('已在新窗口打开：' + (baseNameOf(dir) || dir));
        } catch (e) {
            flash('打开新窗口失败：' + e, true);
        }
        return;
    }
    openFolderWorkspace(dir);
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
    els.sidebar.dataset.sidebarView = currentSidebarView();
    if (els.btnSidebar) {
        els.btnSidebar.classList.toggle('active', !!settings.showSidebar);
        els.btnSidebar.setAttribute('aria-pressed', String(!!settings.showSidebar));
    }
    if (els.abFiles) {
        const filesActive = !!settings.showSidebar && settings.sidebarView === 'files' && settings.sidebarMode === 'tree';
        els.abFiles.classList.toggle('active', filesActive);
        els.abFiles.setAttribute('aria-pressed', String(filesActive));
    }
    if (els.abGit) {
        const gitActive = !!settings.showSidebar && settings.sidebarView === 'git';
        els.abGit.classList.toggle('active', gitActive);
        els.abGit.setAttribute('aria-pressed', String(gitActive));
    }
    if (els.abStructure) {
        const structureActive = !!settings.showSidebar && settings.sidebarView === 'structure';
        els.abStructure.classList.toggle('active', structureActive);
        els.abStructure.setAttribute('aria-pressed', String(structureActive));
    }
    const filesVisible = !!settings.showSidebar && currentSidebarView() === 'files';
    if (explorer) explorer.setVisible(filesVisible);
    if (structurePanel) structurePanel.setVisible(!!settings.showSidebar && currentSidebarView() === 'structure');
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
    if (els.abFiles) els.abFiles.addEventListener('click', () => toggleSidebarView('files'));
    if (els.abStructure) els.abStructure.addEventListener('click', () => toggleSidebarView('structure'));
    if (els.abSearch) els.abSearch.addEventListener('click', () => {
        if (els.searchInput.disabled) {
            flash('当前视图不支持节点搜索', true);
            return;
        }
        focusSearch();
    });
    if (els.abTerminal) els.abTerminal.addEventListener('click', () => toggleTerminalPanel());
    if (els.abGit) els.abGit.addEventListener('click', () => toggleSidebarView('git'));
    if (els.abMore) els.abMore.addEventListener('click', () => {
        if (!ctxMenu) return;
        const rect = els.abMore.getBoundingClientRect();
        ctxMenu.open(menuItems('view'), rect.right + 6, rect.top - 4);
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
    explorer.setAutoRefresh(settings.treeRefreshInterval);
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

function initStructurePanel() {
    if (!els.structureBody) return;
    structurePanel = createStructurePanel({
        body: els.structureBody,
        refreshBtn: els.structureRefresh,
        collapseBtn: els.structureCollapse,
        getText: (doc) => structureTextForDoc(doc),
        getCursorLine: () => {
            try {
                return file && file.editor && file.editor.aceEditor
                    ? file.editor.aceEditor.getCursorPosition().row + 1 : 0;
            } catch (e) {
                return 0;
            }
        },
        onJump: (node) => jumpToStructureNode(node),
    });
    structurePanel.setDoc(file);
    applySidebarUI();
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

async function copyStructuredDir(dir) {
    if (!backend.StructureDir) {
        flash('当前版本不支持结构化目录', true);
        return;
    }
    flash('正在生成结构化目录…');
    try {
        const text = await backend.StructureDir(dir);
        await copyText(text, '结构化目录');
    } catch (e) {
        flash('复制结构化目录失败：' + e, true);
    }
}

async function exportStructuredDir(dir) {
    if (!backend.ExportStructureDir) {
        flash('当前版本不支持导出结构化目录', true);
        return;
    }
    try {
        const path = await backend.ExportStructureDir(dir);
        if (!path) {
            flash('已取消导出');
            return;
        }
        flash('已导出结构化目录：' + (baseNameOf(path) || path));
    } catch (e) {
        flash('导出结构化目录失败：' + e, true);
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
        doc.savedText = snapshot;
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
elsSettings.codeGuides.addEventListener('change', () => {
    settings.codeGuides = elsSettings.codeGuides.checked;
    applySettings();
});
elsSettings.alwaysOnTop.addEventListener('change', () => {
    settings.alwaysOnTop = elsSettings.alwaysOnTop.checked;
    applySettings();
});
elsSettings.codeWrap.addEventListener('change', () => {
    settings.codeWrap = elsSettings.codeWrap.checked;
    applySettings();
});
elsSettings.tabClose.addEventListener('change', () => {
    settings.tabCloseMode = elsSettings.tabClose.value;
    applySettings();
});
elsSettings.dblClickClose.addEventListener('change', () => {
    settings.dblClickClose = elsSettings.dblClickClose.checked;
    applySettings();
});
elsSettings.shiftClickClose.addEventListener('change', () => {
    settings.shiftClickClose = elsSettings.shiftClickClose.checked;
    applySettings();
});
elsSettings.treeExpand.addEventListener('change', () => {
    settings.treeExpandDefault = elsSettings.treeExpand.value;
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
elsSettings.treeGuides.addEventListener('change', () => {
    settings.treeGuides = elsSettings.treeGuides.checked;
    applySettings();
});
elsSettings.treeCounts.addEventListener('change', () => {
    settings.treeCounts = elsSettings.treeCounts.checked;
    applySettings();
    humanizeCounts();
});
elsSettings.treeRefresh.addEventListener('change', () => {
    settings.treeRefreshInterval = Number(elsSettings.treeRefresh.value) || 0;
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
    if (currentMode === 'table' && file && file.format.table) {
        zoomCsvTable(file, e.deltaY);
        return;
    }
    if (currentMode === 'image' && file && file.image) {
        zoomImageBy(file, e.deltaY);
        return;
    }
    if (currentMode === 'render' && file && isSvgDoc(file)) {
        zoomSvgRenderBy(file, e.deltaY);
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
    if (currentMode === 'table') {
        if (!doc.tableUndo) doc.tableUndo = [];
        if (!doc.tableRedo) doc.tableRedo = [];
        doc.tableUndo.push({full: true, before: text, after: formatted});
        if (doc.tableUndo.length > 100) doc.tableUndo.shift();
        doc.tableRedo.length = 0;
    }
    doc.loading = true;
    try {
        if (currentMode === 'code' && editor.aceEditor) {
            const ace = editor.aceEditor;
            ace.selectAll();
            ace.session.replace(ace.getSelectionRange(), formatted);
            ace.selection.moveTo(0, 0);
            ace.clearSelection();
        } else if (currentMode === 'text') {
            const ta = textArea();
            if (ta) {
                ta.focus();
                ta.select();
                let inserted = false;
                try {
                    inserted = document.execCommand('insertText', false, formatted);
                } catch (e) {}
                if (!inserted) {
                    ta.value = formatted;
                    ta.dispatchEvent(new Event('input', {bubbles: true}));
                }
                ta.setSelectionRange(0, 0);
            } else {
                editor.setText(formatted);
            }
        } else {
            editor.setText(formatted);
        }
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
    if (mode === 'text' && (currentMode === 'image' || currentMode === 'binary') && doc) {
        enterTextView(doc);
        return;
    }
    if (mode === 'preview') {
        if (doc && doc.format.preview) enterMarkdownPreview(doc);
        return;
    }
    if (mode === 'render') {
        if (doc && isSvgDoc(doc)) enterSvgRender(doc);
        return;
    }
    if (currentMode === 'render') {
        if (doc) {
            hideSvgRender(doc);
            // 退出渲染视图：先恢复 SVG 源文本到 code 模式编辑器，
            // 再按 code 视图继续走通用切换（render→tree 走 XML 解析建树）
            doc.loading = true;
            try {
                doc.editor.setMode('code');
                const src = doc._svgSrcText != null && doc._svgSrcText.trim()
                    ? doc._svgSrcText
                    : (doc.rawText != null ? doc.rawText : (doc.text || ''));
                doc.editor.setText(src);
                doc.text = src;
            } catch (e) {
                console.warn('leave render view failed', e);
            } finally {
                doc.loading = false;
            }
            doc.mode = 'code';
            currentMode = 'code';
            delete doc._svgSrcText;
            updateStatus();
            updateSearchState();
        }
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
            if (editor.aceEditor) { hookCodeFoldPreviews(editor.aceEditor); hookFoldChevronHover(editor.aceEditor); updateCodeFoldPreviews(editor.aceEditor); }
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
            const items = viewOptionsFor(file && file.format, file).map(([mode, label]) => ({
                label,
                checked: currentMode === mode,
                disabled: viewDisabled(mode),
                action: () => switchMode(mode),
            }));
            items.push(
                {sep: true},
                {label: '终端面板', shortcut: 'Alt+F12', checked: terminalUI.open, action: () => toggleTerminalPanel()},
                {label: '文件侧边栏', shortcut: 'Alt+1', checked: !!settings.showSidebar, action: () => toggleSidebar()},
                {label: '文件列表', checked: settings.sidebarMode === 'list', action: () => setSidebarMode('list')},
                {label: '文件树', checked: settings.sidebarMode === 'tree', action: () => setSidebarMode('tree')},
                {label: '结构视图', shortcut: 'Alt+7', checked: !!settings.showSidebar && currentSidebarView() === 'structure', action: () => toggleSidebarView('structure')},
                {sep: true},
                {label: '自动换行', checked: !!settings.codeWrap, action: toggleCodeWrap},
                {label: '展开全部', shortcut: 'Ctrl+Shift+=', disabled: !tree, action: () => editor && editor.expandAll()},
                {label: '收起全部', shortcut: 'Ctrl+Shift+-', disabled: !tree, action: () => editor && editor.collapseAll()},
                {sep: true},
                {label: '全屏', shortcut: 'F11', checked: !!rtFullscreen, action: toggleFullscreen},
                {label: '窗口置顶', checked: !!settings.alwaysOnTop, action: toggleAlwaysOnTop},
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
        case 'tools': {
            const cmds = getPluginCommands();
            if (!cmds.length) {
                return [{label: '（暂无插件命令）', disabled: true}];
            }
            return cmds.map((cmd) => ({label: cmd.label, action: () => cmd.run()}));
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
    } else if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'Digit7' || e.key === '7')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarView('structure');
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
    } else if (e.key === 'Delete' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const selected = treeShortcutSelection();
        if (selected && selected.length) {
            e.preventDefault();
            e.stopPropagation();
            deleteExplorerEntries(selected);
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
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'g') {
        if ((currentMode === 'code' || currentMode === 'text') && file && !isDialogOpen()) {
            e.preventDefault();
            e.stopPropagation();
            openGotoDialog();
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
    } else if (e.key === 'F11' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
    } else if (e.altKey && e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalPanel();
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
        const vplus = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        if (currentMode === 'image' && file && file.image) {
            e.preventDefault();
            e.stopPropagation();
            zoomImageBy(file, vplus ? -1 : 1);
            return;
        }
        if (currentMode === 'table' && file && file.format && file.format.table) {
            e.preventDefault();
            e.stopPropagation();
            zoomCsvTable(file, vplus ? -1 : 1);
            return;
        }
        if (currentMode === 'render' && file && isSvgDoc(file)) {
            e.preventDefault();
            e.stopPropagation();
            zoomSvgRenderBy(file, vplus ? -1 : 1);
            return;
        }
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
    rt.EventsOn('term-out', (data) => {
        const s = terminalUI.sessions.get(data.id);
        if (s) s.term.write(data.data);
    });
    rt.EventsOn('term-exit', (data) => {
        const s = terminalUI.sessions.get(data.id);
        if (s) s.term.write('\r\n\x1b[90m[进程已退出，代码 ' + data.code + ']\x1b[0m');
    });
    rt.EventsOn('cmd-out', (payload) => {
        const h = cmdOutHandlers.get(payload.id);
        if (h) h(payload.stream, payload.data);
    });
    rt.EventsOn('cmd-exit', (payload) => {
        const h = cmdExitHandlers.get(payload.id);
        if (h) {
            cmdExitHandlers.delete(payload.id);
            h(Number(payload.code));
        }
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

els.editor.addEventListener('wheel', (e) => {
    const strip = e.target && e.target.closest ? e.target.closest('.etabs') : null;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? strip.clientWidth : 1;
    e.preventDefault();
    strip.scrollLeft += delta * unit;
}, {passive: false});

// Ctrl+Z 捕获拦截：代码模式下 ace 聚焦时会吞掉 Ctrl+Z（空栈静默），这里在捕获阶段先判空栈+脏 → 直接回退已保存状态
window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 'z') return;
    if (currentMode !== 'code' || !editor || !editor.aceEditor || settings.readOnlyMode) return;
    let um = null;
    try { um = editor.aceEditor.session.getUndoManager(); } catch (err) { return; }
    if (um && um.hasUndo()) return;
    e.preventDefault();
    e.stopPropagation();
    if (file && file.dirty) revertDocToSaved(file);
}, true);

initContextMenus();
initExplorer();
initStructurePanel();
initActivityBar();

// ===== Win11/系统调整光标（后端读注册表当前主题 + 内置候选，失败回落 CSS 关键字） =====
// 注意：Windows 的 .cur 是多尺寸帧容器（aero_* 含 32/48/64/96/128 五帧），每帧在 ICONDIRENTRY
// 的 planes/bitcount 位置存自己的热点。以前按 ICONDIR 头部读热点是错的（读到 dwImageOffset），
// 而且浏览器默认会挑最大帧再缩放，导致糊、偏、尺寸不对。这里自己解析 .cur、按基准尺寸取帧原样使用。
let sysCursor = null;
// 系统光标逻辑基准尺寸（96dpi CSS px）：后端读 CursorBaseSize（默认 32；辅助功能放大光标时更大）。
// 高 DPI 缩放不写死，由 image-set 按运行时 devicePixelRatio 自动选帧。
let cursorCssSize = 32;

function setDragCursor(kind) {
    document.body.classList.toggle('cursor-ew', kind === 'ew');
    document.body.classList.toggle('cursor-ns', kind === 'ns');
}

function parseCurFrames(dataUrl) {
    try {
        const bin = atob((dataUrl || '').split(',')[1] || '');
        const n = bin.length;
        if (n < 22) return null;
        const u16 = (o) => bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8);
        const u32 = (o) => (bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) | (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24)) >>> 0;
        if (u16(2) !== 2) return null; // 2 = CUR（1 = ICO）
        const count = u16(4);
        const out = [];
        for (let i = 0; i < count; i++) {
            const e = 6 + i * 16;
            if (e + 16 > n) break;
            const w = bin.charCodeAt(e) || 256;
            const h = bin.charCodeAt(e + 1) || 256;
            const hx = u16(e + 4); // CUR 的 wPlanes 字段实为热点 X
            const hy = u16(e + 6); // CUR 的 wBitCount 字段实为热点 Y
            const size = u32(e + 8);
            const off = u32(e + 12);
            if (!size || off + size > n) continue;
            out.push({bin, w, h, hx, hy, size, off});
        }
        return out.length ? out : null;
    } catch (e) { return null; }
}

function pickCurFrame(frames, target) {
    let best = null;
    let bestScore = Infinity;
    for (const f of frames) {
        // 优先选不小于目标的帧（放大精度更好），再取尺寸差最小
        const score = Math.abs(f.w - target) + (f.w < target ? 1024 : 0);
        if (score < bestScore) { bestScore = score; best = f; }
    }
    return best;
}

function curFrameDataUrl(fr) {
    // 重新打包成单帧 .cur，避免浏览器在多帧文件里挑到最大帧
    const le = (v, bytes) => {
        let s = '';
        for (let i = 0; i < bytes; i++) s += String.fromCharCode((v >> (8 * i)) & 255);
        return s;
    };
    let head = le(0, 2) + le(2, 2) + le(1, 2);
    head += String.fromCharCode(fr.w === 256 ? 0 : fr.w, fr.h === 256 ? 0 : fr.h, 0, 0);
    head += le(fr.hx, 2) + le(fr.hy, 2) + le(fr.size, 4) + le(22, 4);
    return 'data:image/x-icon;base64,' + btoa(head + fr.bin.substr(fr.off, fr.size));
}

function rasterizeCurFrame(fr, size) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const iw = img.naturalWidth || img.width;
                const ih = img.naturalHeight || img.height;
                const c = document.createElement('canvas');
                c.width = size;
                c.height = size;
                const ctx = c.getContext('2d');
                const scaled = iw !== size || ih !== size;
                ctx.imageSmoothingEnabled = scaled; // 1:1 帧原样拷贝，不做二次插值
                if (scaled) ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, size, size);
                resolve({png: c.toDataURL('image/png'), iw, ih});
            } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = curFrameDataUrl(fr);
    });
}

let imageSetCursorSupport = null;
function supportsImageSetCursor() {
    if (imageSetCursorSupport == null) {
        try {
            imageSetCursorSupport = !!(window.CSS && CSS.supports && CSS.supports('cursor', 'image-set(url("x") 1x) 0 0, auto'));
        } catch (e) { imageSetCursorSupport = false; }
    }
    return imageSetCursorSupport;
}

function fmtResolution(res) {
    if (Number.isInteger(res)) return res + 'x';
    return res.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'x';
}

async function buildCursorValue(kind, keyFallback) {
    const url = sysCursor[kind];
    if (!url) return null;
    const frames = parseCurFrames(url);
    if (!frames) return null;
    const base = pickCurFrame(frames, cursorCssSize);
    const one = await rasterizeCurFrame(base, cursorCssSize);
    if (!one) return null;
    // 热点按实际帧尺寸换算到 CSS 逻辑尺寸；CSS 只接受整数
    const hx = Math.max(0, Math.min(cursorCssSize - 1, Math.round(base.hx * cursorCssSize / base.w)));
    const hy = Math.max(0, Math.min(cursorCssSize - 1, Math.round(base.hy * cursorCssSize / base.h)));
    const plain = 'url("' + one.png + '") ' + hx + ' ' + hy + ', ' + keyFallback;

    // image-set 让 Chromium 按 DPR 选原生帧：@150% 用 48px 帧，不再把 32px 位图向上插值（糊）
    let set = null;
    if (supportsImageSetCursor()) {
        const cands = [];
        const seen = {};
        for (const f of frames) {
            if (f.w < 16) continue;
            const res = f.w / cursorCssSize;
            if (res < 1 || res > 4) continue; // 原生帧按「基准尺寸」换算成 1x~4x 档
            const key = res.toFixed(2);
            if (seen[key]) continue;
            seen[key] = true;
            const png = await rasterizeCurFrame(f, f.w); // 原生像素，1:1，不插值
            if (png) cands.push({res, png: png.png});
        }
        if (!seen['1.00']) cands.push({res: 1, png: one.png});
        cands.sort((a, b) => a.res - b.res);
        if (cands.length) {
            set = 'image-set(' + cands.map((c) => 'url("' + c.png + '") ' + fmtResolution(c.res)).join(', ') + ') ' + hx + ' ' + hy + ', ' + keyFallback;
        }
    }
    return {plain, set};
}

async function applySystemCursors() {
    if (!sysCursor) return;
    const ew = await buildCursorValue('ew', 'ew-resize');
    const ns = await buildCursorValue('ns', 'ns-resize');
    const parts = [];
    const pushRule = (selector, v) => {
        if (!v) return;
        let rule = selector + ' { cursor: ' + v.plain + ';';
        if (v.set) rule += ' cursor: ' + v.set + ';';
        parts.push(rule + ' }');
    };
    pushRule('.sidebar-resize, .esplit-col > .esplit-divider', ew);
    pushRule('body.cursor-ew', ew);
    pushRule('.term-resize, .git-splitter, .esplit-row > .esplit-divider', ns);
    pushRule('body.cursor-ns', ns);
    if (!parts.length) return;
    let style = document.getElementById('sys-cursors');
    if (!style) {
        style = document.createElement('style');
        style.id = 'sys-cursors';
        document.head.appendChild(style);
    }
    style.textContent = parts.join('\n');
}

if (backend.GetSystemCursors) {
    backend.GetSystemCursors().then((c) => {
        if (!c || !(c.ew || c.ns)) return;
        const base = Number(c.base);
        if (Number.isFinite(base) && base >= 16 && base <= 128) cursorCssSize = Math.round(base);
        sysCursor = c;
        applySystemCursors();
    }).catch(() => {});
}
// ===== 内置终端 =====
const terminalUI = {open: false, sessions: new Map(), order: [], activeId: null};
const cmdOutHandlers = new Map();
const cmdExitHandlers = new Map();
let cmdSeq = 0;



// gitRelParentDir 返回 path 相对仓库根的父目录（JetBrains 式灰字，Windows 反斜杠显示）。
function gitRelParentDir(path) {
    const root = (gitStateCache.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const p = String(path || '').replace(/\\/g, '/');
    if (!root || !p.toLowerCase().startsWith(root.toLowerCase() + '/')) return '';
    const rel = p.slice(root.length + 1);
    const idx = rel.lastIndexOf('/');
    if (idx <= 0) return '';
    return rel.slice(0, idx).replace(/\//g, '\\');
}

function renderGitPanel() {
    if (!els.gitChanges) return;
    const available = gitStateCache.available && gitStateCache.dir;
    els.gitBranch.textContent = gitStateCache.branch ? '分支：' + gitStateCache.branch : '';
    if (!available) {
        els.gitHint.textContent = gitStateCache.reason || '当前目录不在 git 仓库内';
        els.gitChanges.innerHTML = '';
        els.gitCommitBtn.disabled = true;
        els.gitCommitPushBtn.disabled = true;
        return;
    }
    els.gitHint.textContent = '';
    els.gitCommitBtn.disabled = false;
    els.gitCommitPushBtn.disabled = false;
    const changes = [];
    const untracked = [];
    for (const [path, state] of gitStateCache.map) {
        if (state === 'untracked') untracked.push(path);
        else changes.push({path, state});
    }
    els.gitChanges.textContent = '';
    if (!changes.length && !untracked.length) {
        const empty = document.createElement('div');
        empty.className = 'git-empty';
        empty.textContent = '（工作区干净，没有变更）';
        els.gitChanges.appendChild(empty);
        return;
    }
    const makeRow = (path, checked, state) => {
        const row = document.createElement('label');
        row.className = 'git-file-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.dataset.path = path;
        const name = document.createElement('span');
        name.className = 'git-fname git-st-' + (state || 'modified');
        name.textContent = path.replace(/^.*[\\/]/, '');
        row.append(cb, name);
        // JetBrains 式：文件名后跟一行淡灰小字 = 相对仓库根的父目录
        const relParent = gitRelParentDir(path);
        if (relParent) {
            const dirSpan = document.createElement('span');
            dirSpan.className = 'git-fpath';
            dirSpan.textContent = relParent;
            row.append(dirSpan);
        }
        row.title = path;
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!ctxMenu) return;
            const isUntracked = gitStateCache.untrackedSet.has(path);
            ctxMenu.open([
                {label: '查看差异', icon: 'E8D3', action: () => showGitDiff(path)},
                {label: '文件历史', icon: 'E81C', action: () => showGitFileHistory(path)},
                {sep: true},
                {label: '回滚更改', icon: 'E7A7', danger: true, action: () => {
                    const what = isUntracked ? '该文件未被版本管理，回滚将删除文件：' : '将丢弃该文件的全部未提交修改：';
                    openCloseConfirm(what + '\n' + path, () => gitRollbackPaths([path], isUntracked ? [path] : []), '回滚');
                }},
            ], e.clientX, e.clientY);
        });
        return row;
    };
    // 分组块：组头勾选框 = 全选/全不选该组文件（JetBrains 式，支持半选态）；组头箭头 = 展开/收起（跨轮询重渲染保留）
    const makeGroupBlock = (title, rows, key) => {
        const block = document.createElement('div');
        block.className = 'git-group-block';
        const head = document.createElement('div');
        head.className = 'git-group';
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'git-chev';
        chev.title = '展开/收起';
        chev.textContent = gitGroupCollapsed[key] ? '\uE76C' : '\uE70D';
        const gcb = document.createElement('input');
        gcb.type = 'checkbox';
        gcb.className = 'git-group-cb';
        const label = document.createElement('span');
        label.textContent = title;
        head.append(chev, gcb, label);
        const rowsWrap = document.createElement('div');
        rowsWrap.className = 'git-group-rows' + (gitGroupCollapsed[key] ? ' collapsed' : '');
        const rowCbs = () => [...rowsWrap.querySelectorAll('.git-file-row input[type="checkbox"]')];
        const updateGroupState = () => {
            const cbs = rowCbs();
            const checkedCount = cbs.filter((c) => c.checked).length;
            gcb.checked = cbs.length > 0 && checkedCount === cbs.length;
            gcb.indeterminate = checkedCount > 0 && checkedCount < cbs.length;
        };
        gcb.addEventListener('change', () => {
            for (const c of rowCbs()) c.checked = gcb.checked;
            updateGroupState();
        });
        chev.addEventListener('click', () => {
            gitGroupCollapsed[key] = !gitGroupCollapsed[key];
            rowsWrap.classList.toggle('collapsed', gitGroupCollapsed[key]);
            chev.textContent = gitGroupCollapsed[key] ? '\uE76C' : '\uE70D';
        });
        block.append(head, rowsWrap);
        for (const row of rows) {
            rowsWrap.append(row);
            row.querySelector('input[type="checkbox"]').addEventListener('change', updateGroupState);
        }
        updateGroupState();
        return block;
    };
    if (changes.length) {
        const rows = changes.map((item) => {
            const row = makeRow(item.path, true, item.state);
            row.querySelector('input').dataset.path = item.path;
            row.addEventListener('dblclick', () => showGitDiff(item.path));
            return row;
        });
        els.gitChanges.appendChild(makeGroupBlock('更改（' + changes.length + ' 个文件）', rows, 'changes'));
    }
    if (untracked.length) {
        const rows = untracked.map((path) => {
            const row = makeRow(path, true, 'untracked');
            row.addEventListener('dblclick', () => showGitDiff(path));
            return row;
        });
        els.gitChanges.appendChild(makeGroupBlock('未进行版本管理的文件（' + untracked.length + ' 个文件）', rows, 'untracked'));
    }
}

function currentSidebarView() {
    if (settings.sidebarView === 'git' || settings.sidebarView === 'structure') return settings.sidebarView;
    return 'files';
}

function switchSidebarView(view) {
    if (!['files', 'git', 'structure'].includes(view)) view = 'files';
    settings.sidebarView = view;
    if (structurePanel && view === 'structure') structurePanel.setDoc(file);
    applySettings();
    if (view === 'git') {
        refreshGitStatus().then(() => renderGitPanel()).catch(() => renderGitPanel());
    }
}

function toggleSidebarView(view) {
    if (settings.showSidebar && currentSidebarView() === view) {
        settings.showSidebar = false;
    } else {
        settings.showSidebar = true;
        switchSidebarView(view);
    }
    applySettings();
}

function termCwd() {
    return workspaceFolder || (file && file.path ? file.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
}

function termTheme() {
    const cs = getComputedStyle(document.documentElement);
    return {
        background: cs.getPropertyValue('--bg').trim() || '#1e1f24',
        foreground: cs.getPropertyValue('--text').trim() || '#e0e0e0',
        cursor: cs.getPropertyValue('--accent').trim() || '#4f8cff',
        cursorAccent: cs.getPropertyValue('--bg').trim() || '#1e1f24',
        selectionBackground: '#88888855',
    };
}

function toggleTerminalPanel(force) {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const show = force === undefined ? panel.classList.contains('hidden') : force;
    if (show) {
        panel.classList.remove('hidden');
        terminalUI.open = true;
        if (!terminalUI.sessions.size) createTermSession();
        else fitActiveTerm();
    } else {
        panel.classList.add('hidden');
        terminalUI.open = false;
    }
    if (els.abTerminal) {
        els.abTerminal.classList.toggle('active', terminalUI.open);
        els.abTerminal.setAttribute('aria-pressed', String(terminalUI.open));
    }
}

async function createTermSession() {
    if (!backend.TermCreate) {
        flash('当前版本不支持内置终端', true);
        return;
    }
    const body = document.getElementById('term-body');
    const host = document.createElement('div');
    host.className = 'term-session';
    body.appendChild(host);
    let created;
    try {
        created = await backend.TermCreate(termDefaultCols(), termDefaultRows(), 'powershell', termCwd());
    } catch (e) {
        flash('创建终端失败：' + e, true);
        host.remove();
        return;
    }
    const id = created.id;
    const term = new window.Terminal({
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        fontSize: 12,
        scrollback: 2000,
        cursorBlink: true,
        theme: termTheme(),
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
        fit.fit();
    } catch (e) {}
    term.onData((data) => {
        backend.TermWrite(id, data).catch(() => {});
    });
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'term-tab';
    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = '终端 ' + (terminalUI.order.length + 1);
    const tabClose = document.createElement('span');
    tabClose.className = 'term-tab-close';
    tabClose.textContent = '✕';
    tabClose.title = '关闭终端';
    tab.append(label, tabClose);
    tab.addEventListener('click', (e) => {
        if (e.shiftKey && !e.target.classList.contains('term-tab-close')) {
            e.preventDefault();
            closeTermSession(id);
            return;
        }
        if (e.target.classList.contains('term-tab-close')) {
            closeTermSession(id);
            return;
        }
        activateTermSession(id);
    });
    document.getElementById('term-tabs').appendChild(tab);
    terminalUI.sessions.set(id, {id, term, fit, host, tab});
    terminalUI.order.push(id);
    activateTermSession(id);
    setTimeout(() => {
        try {
            fit.fit();
            term.focus();
        } catch (e) {}
    }, 80);
}

function termDefaultCols() {
    return 80;
}

function termDefaultRows() {
    return 24;
}

function activateTermSession(id) {
    terminalUI.activeId = id;
    for (const [sid, s] of terminalUI.sessions) {
        s.host.classList.toggle('hidden', sid !== id);
        s.tab.classList.toggle('active', sid === id);
    }
    const s = terminalUI.sessions.get(id);
    if (s) {
        try {
            s.fit.fit();
            s.term.focus();
        } catch (e) {}
    }
}

function fitActiveTerm() {
    const s = terminalUI.sessions.get(terminalUI.activeId);
    if (s) {
        try {
            s.fit.fit();
        } catch (e) {}
    }
}

async function closeTermSession(id) {
    try {
        await backend.TermClose(id);
    } catch (e) {}
    removeTermSession(id);
    if (!terminalUI.sessions.size) toggleTerminalPanel(false);
    else activateTermSession(terminalUI.order[terminalUI.order.length - 1]);
}

function removeTermSession(id) {
    const s = terminalUI.sessions.get(id);
    if (s) {
        try {
            s.term.dispose();
        } catch (e) {}
        s.tab.remove();
        s.host.remove();
    }
    terminalUI.sessions.delete(id);
    terminalUI.order = terminalUI.order.filter((x) => x !== id);
}

function syncTerminalTheme() {
    for (const s of terminalUI.sessions.values()) {
        try {
            s.term.options.theme = termTheme();
        } catch (e) {}
    }
}

window.addEventListener('resize', () => {
    if (terminalUI.open) fitActiveTerm();
});

els.gitRefresh.addEventListener('click', () => refreshGitStatus());

if (els.gitSplitter) {
    let gitSplitting = false;
    let gitSplitStartY = 0;
    let gitSplitStartH = 0;
    els.gitSplitter.addEventListener('mousedown', (e) => {
        if (!els.gitCommitArea) return;
        gitSplitting = true;
        gitSplitStartY = e.clientY;
        gitSplitStartH = els.gitCommitArea.offsetHeight;
        setDragCursor('ns');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!gitSplitting) return;
        const h = Math.min(300, Math.max(90, gitSplitStartH - (e.clientY - gitSplitStartY)));
        els.gitCommitArea.style.height = h + 'px';
        els.gitCommitArea.style.flex = 'none';
    });
    window.addEventListener('mouseup', () => {
        if (!gitSplitting) return;
        gitSplitting = false;
        setDragCursor(null);
        document.body.style.userSelect = '';
        settings.gitCommitAreaHeight = Math.min(300, Math.max(90, els.gitCommitArea.offsetHeight));
        applySettings();
    });
}
els.gitRecentLog.addEventListener('click', () => showGitRecentLog());
els.gitCommitBtn.addEventListener('click', () => runGitCommit(false));
els.gitCommitPushBtn.addEventListener('click', () => runGitCommit(true));

function collectCheckedPaths() {
    return [...els.gitChanges.querySelectorAll('.git-file-row input[type="checkbox"]:checked')].map((cb) => cb.dataset.path);
}

async function runGitCommit(push) {
    if (!backend.GitCommitChanges) {
        flash('当前版本不支持 git 提交', true);
        return;
    }
    const paths = collectCheckedPaths();
    const message = els.gitMessage.value.trim();
    const amend = els.gitAmend.checked;
    if (!amend && !message) {
        flash('请填写提交消息', true);
        els.gitMessage.focus();
        return;
    }
    if (!paths.length && !amend) {
        flash('请勾选要提交的文件', true);
        return;
    }
    els.gitCommitBtn.disabled = true;
    els.gitCommitPushBtn.disabled = true;
    try {
        const res = await backend.GitCommitChanges(gitStateCache.dir, message, paths, amend, push);
        const tail = (res.output || '').trim().split('\n').slice(-4).join('\n');
        if (res.success) {
            flash((push ? '提交并推送完成' : '提交完成') + (tail ? '：' + tail : ''));
            els.gitMessage.value = '';
        } else {
            flash('git 提交失败：' + (tail || '无输出'), true);
        }
    } catch (e) {
        flash('git 提交失败：' + e, true);
    } finally {
        els.gitCommitBtn.disabled = false;
        els.gitCommitPushBtn.disabled = false;
        await refreshGitStatus();
        renderGitPanel();
    }
}

if (els.termNew) els.termNew.addEventListener('click', () => createTermSession());
if (els.termPanelClose) els.termPanelClose.addEventListener('click', () => toggleTerminalPanel(false));
if (els.terminalPanel && settings.terminalHeight) {
    els.terminalPanel.style.height = settings.terminalHeight + 'px';
}
if (els.sidebarResize) {
    let sidebarResizing = false;
    let sidebarStartX = 0;
    let sidebarStartW = 0;
    els.sidebarResize.addEventListener('mousedown', (e) => {
        if (!settings.showSidebar) return;
        sidebarResizing = true;
        sidebarStartX = e.clientX;
        sidebarStartW = els.sidebar.offsetWidth;
        setDragCursor('ew');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!sidebarResizing) return;
        const w = Math.min(500, Math.max(160, sidebarStartW + (e.clientX - sidebarStartX)));
        els.sidebar.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!sidebarResizing) return;
        sidebarResizing = false;
        setDragCursor(null);
        document.body.style.userSelect = '';
        settings.sidebarWidth = Math.min(500, Math.max(160, els.sidebar.offsetWidth));
        applySettings();
    });
}

if (els.terminalResize) {
    let termResizing = false;
    let termResizeStartY = 0;
    let termResizeStartH = 0;
    els.terminalResize.addEventListener('mousedown', (e) => {
        if (!terminalUI.open) return;
        termResizing = true;
        termResizeStartY = e.clientY;
        termResizeStartH = els.terminalPanel.offsetHeight;
        setDragCursor('ns');
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!termResizing) return;
        const h = Math.min(480, Math.max(120, termResizeStartH + (termResizeStartY - e.clientY)));
        els.terminalPanel.style.height = h + 'px';
        fitActiveTerm();
    });
    window.addEventListener('mouseup', () => {
        if (!termResizing) return;
        termResizing = false;
        setDragCursor(null);
        fitActiveTerm();
        settings.terminalHeight = Math.min(480, Math.max(120, els.terminalPanel.offsetHeight));
        applySettings();
    });
}

// ===== 进程桥 / 虚拟文档 =====
function openVirtualDoc(name, content) {
    const doc = createDoc({
        path: null,
        name,
        content,
        size: content.length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    docs.push(doc);
    activateDoc(doc);
    return doc;
}

// ===== git 浅集成 =====
const gitStateCache = {dir: '', map: new Map(), branch: '', available: false, reason: '', untrackedSet: new Set(), ignoredSet: new Set()};
const gitGroupCollapsed = {changes: false, untracked: false};
let gitTimer = null;

function gitRootDir() {
    return workspaceFolder || (file && file.path ? file.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
}

async function refreshGitStatus() {
    if (!backend.GitStatusFor) return;
    const root = gitRootDir();
    if (!root) {
        gitStateCache.dir = '';
        gitStateCache.map.clear();
        applyGitBadges();
        return;
    }
    if (root !== gitStateCache.dir) {
        gitStateCache.dir = root;
        gitStateCache.map.clear();
    }
    try {
        const status = await backend.GitStatusFor(root);
        if (!status || !status.available) {
            gitStateCache.map.clear();
            gitStateCache.branch = '';
            gitStateCache.available = !!status.available;
            gitStateCache.reason = status.reason || '';
        } else {
            gitStateCache.available = true;
            gitStateCache.branch = status.branch || '';
            gitStateCache.map.clear();
            gitStateCache.untrackedSet.clear();
            gitStateCache.ignoredSet.clear();
            for (const entry of status.entries || []) {
                const p = entry.path.replace(/\\/g, '/').replace(/\/+$/, '');
                if (entry.state === 'ignored') {
                    gitStateCache.ignoredSet.add(p);
                    continue;
                }
                gitStateCache.map.set(p, entry.state);
                if (entry.state === 'untracked') gitStateCache.untrackedSet.add(p);
            }
        }
    } catch (e) {}
    applyGitBadges();
    applyGitDot();
    if (currentSidebarView() === 'git' && settings.showSidebar && els.gitChanges) {
        renderGitPanel();
    }
}

function applyGitBadges() {
    document.querySelectorAll('.sb-row[data-path]').forEach((row) => {
        for (const cls of Array.from(row.classList)) {
            if (cls.startsWith('git-')) row.classList.remove(cls);
        }
        const key = row.dataset.path.replace(/\\/g, '/').replace(/\/+$/, '');
        const st = gitStateCache.map.get(key);
        // 已删除文件磁盘上不存在、不会出现在文件树；灰色删除态只在 Git 提交面板显示
        if (st && st !== 'deleted') row.classList.add('git-' + st);
        else if (gitStateCache.ignoredSet.has(key)) row.classList.add('git-ignored');
    });
}

const gitBadgeObserver = new MutationObserver(() => applyGitBadges());

function restartGitTimer() {
    if (gitTimer) clearInterval(gitTimer);
    const sec = Math.max(1, settings.treeRefreshInterval || 3);
    gitTimer = setInterval(refreshGitStatus, sec * 1000);
}

function openGitChangesDoc() {
    if (!backend.GitStatusFor) {
        flash('当前版本不支持 git 集成', true);
        return;
    }
    const marks = {new: '新增', modified: '修改', deleted: '删除', renamed: '重命名', conflict: '冲突'};
    const lines = [];
    for (const [path, state] of gitStateCache.map) {
        lines.push('[' + (marks[state] || state) + '] ' + path);
    }
    if (!lines.length) {
        refreshGitStatus().then(() => {
            const still = [];
            for (const [path, state] of gitStateCache.map) {
                still.push('[' + (marks[state] || state) + '] ' + path);
            }
            const head = gitStateCache.branch ? '分支：' + gitStateCache.branch + '\n\n' : '';
            openVirtualDoc('Git 变更列表' + (gitStateCache.dir ? ' — ' + gitStateCache.dir : '') + '.gitstatus', head + (still.length ? still.join('\n') : '（工作区干净，没有变更）'));
        });
        return;
    }
    const head = gitStateCache.branch ? '分支：' + gitStateCache.branch + '\n\n' : '';
    openVirtualDoc('Git 变更列表' + (gitStateCache.dir ? ' — ' + gitStateCache.dir : '') + '.gitstatus', head + lines.join('\n'));
}

function applyGitDot() {
    if (els.abGit) els.abGit.classList.toggle('has-changes', gitStateCache.map.size > 0);
}

async function showGitRecentLog() {
    if (!backend.GitRecentLogFor) {
        flash('当前版本不支持查看提交历史', true);
        return;
    }
    const dir = gitStateCache.dir || gitRootDir();
    if (!dir) {
        flash('请先打开一个文件或目录', true);
        return;
    }
    try {
        const log = await backend.GitRecentLogFor(dir, 100);
        openVirtualDoc('Git 最近提交.gitlog', log || '（没有提交）');
    } catch (e) {
        flash('读取提交历史失败：' + e, true);
    }
}

async function showGitFileHistory(path) {
    if (!backend.GitFileHistoryFor) {
        flash('当前版本不支持查看文件历史', true);
        return;
    }
    const dir = gitStateCache.dir || gitRootDir();
    if (!dir) return;
    try {
        const log = await backend.GitFileHistoryFor(dir, path, 50);
        openVirtualDoc('Git 文件历史 — ' + path.replace(/^.*[\\/]/, '') + '.history', log || '（该文件没有提交历史）');
    } catch (e) {
        flash('读取文件历史失败：' + e, true);
    }
}

async function gitRollbackPaths(paths, untracked) {
    if (!backend.GitRollbackFor) {
        flash('当前版本不支持回滚', true);
        return;
    }
    const root = gitStateCache.dir || gitRootDir();
    const tracked = paths.filter((p) => !untracked.includes(p));
    const realUntracked = untracked.filter((p) => untracked.includes(p));
    try {
        await backend.GitRollbackFor(root, tracked, realUntracked);
        flash('已回滚 ' + (tracked.length + realUntracked.length) + ' 个文件');
    } catch (e) {
        flash('回滚失败：' + e, true);
    }
    await refreshGitStatus();
    renderGitPanel();
}

async function showGitDiff(path) {
    if (!backend.GitDiffFor) return;
    try {
        const res = await backend.GitDiffFor(gitStateCache.dir || gitRootDir(), path);
        if (!res || !res.hasChanges) {
            flash('该文件暂无差异');
            return;
        }
        openVirtualDoc('Git 差异 — ' + path.replace(/^.*[\\/]/, '') + '.diff', res.diff);
    } catch (e) {
        flash('读取差异失败：' + e, true);
    }
}


try {
    if (els.sbBody) gitBadgeObserver.observe(els.sbBody, {childList: true, subtree: false});
    restartGitTimer();
    refreshGitStatus();
    if (settings.sidebarView === 'git') switchSidebarView('git');
} catch (e) {
    window.__gitInitErr = String((e && e.stack) || e);
}
initCodeFoldHover();

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
    if (backend.GetPluginSources) {
        try {
            const errors = await loadPlugins(backend);
            window.__pluginLoadErrors = errors;
            for (const err of errors) flash(err, true);
        } catch (e) {
            window.__pluginLoadErrors = ['异常：' + (e && e.stack || e)];
            flash('插件加载失败：' + e, true);
        }
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
