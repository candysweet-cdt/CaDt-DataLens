import 'katex/dist/katex.min.css';
import './style.css';
import './reading.css';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import {aceModeFor, detectFormat, formats, isKnownCodeFileName, isSupportedFile, pluginFormats} from './formats.js';
import {createExplorer} from './explorer.js';
import {createStructurePanel, parseStructure} from './structure.js';
import {createContextMenu} from './contextmenu.js';
import {copyImageBlobToClipboard} from './image-clipboard.js';
import {createDebugConsole} from './debugconsole.js';
import {createActivityLog} from './activity-log.js';
import {iconSvg, renderMenuIcon} from './icons.js';
import {createPalette} from './palette.js';
import {createAIPanel} from './ai-panel.js';
import {createReadingMode} from './reading/reading.js';
import {repairJson} from './jsonrepair.js';
import {createFileIcon, fileIconSpec} from './fileicons.js';
import {buildJsonLineMap, queryJsonPath} from './jsonpath.js';
import {semanticDiff, semanticEntryText, unifiedDiff} from './diff.js';
import {validateJsonSchema} from './jsonschema.js';
import {getPluginCommands, initPluginRuntime, loadPlugins} from './plugins.js';
import {createMarkdownRenderer} from './markdown.js';
import {showPatchView, hidePatchView, disposePatchView, refreshPatchView} from './patch-view.js';
import {WRITING_FONTS, WRITING_PAPERS, formatWritingText, genName, SCENE_SEPARATOR} from './writing.js';
import changelogText from '../../CHANGELOG.md?raw';
import termsText from '../../docs/legal/terms.md?raw';
import privacyText from '../../docs/legal/privacy.md?raw';

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

// 写作模式主场景是纯文本（默认落在 text 视图），mock 里单独给一个 .txt
const sampleNovelTxt = `第一章 山雨欲来

少年推开柴门，山风扑面而来。

他望着远处的群山，忽然想起师父说过的话。

第二章 夜行

月色如水，照在青石板上。
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
    txt: {name: 'novel.txt', content: sampleNovelTxt},
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
    aiMemory: {name: 'MEMORY.md', content: '# 记忆索引\n\n- 用户偏好：回答尽量简洁，先给结论（user-preferences.md）\n- 项目事实：这是一个用于演示 AI 面板的 mock 工作区。\n'},
    aiPreferences: {name: 'user-preferences.md', content: '# 用户偏好\n\n- 喜欢简洁表格，先结论后细节。\n'},
    aiSkill: {name: 'SKILL.md', content: '---\nname: demo-skill\ndescription: 演示技能：回答先给结论\n---\n\n# Demo Skill\n\n回答时先给结论，再列要点。\n'},
    workspaceSkill: {name: 'workspace-skill.md', content: '---\nname: workspace-skill\ndescription: 工作区技能：回答附示例\n---\n\n# Workspace Skill\n\n回答时附一个最小示例。\n'},
    workspaceAgentsSkill: {name: 'workspace-agents-skill.md', content: '---\nname: workspace-agents-skill\ndescription: 工作区通用技能：来自 <工作区>/.agents/skills\n---\n\n# Workspace Agents Skill\n\n来自工作区通用目录的示例技能。\n'},
    userAgentsSkill: {name: 'agents-skill.md', content: '---\nname: agents-skill\ndescription: 用户通用技能：来自 ~/.agents/skills\n---\n\n# User Agents Skill\n\n来自用户主目录通用技能目录的示例技能。\n'},
};
const mockTree = {
    'mock://samples': [
        {name: 'cache', path: 'mock://samples/cache', isDir: true},
        {name: 'config', path: 'mock://samples/config', isDir: true},
        {name: 'images', path: 'mock://samples/images', isDir: true},
        {name: 'empty-dir', path: 'mock://samples/empty-dir', isDir: true},
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
    'mock://samples/empty-dir': [],
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
    'mock://samples/.cadt': [
        {name: 'memory', path: 'mock://samples/.cadt/memory', isDir: true},
        {name: 'skills', path: 'mock://samples/.cadt/skills', isDir: true},
    ],
    'mock://samples/.cadt/memory': [
        {name: 'MEMORY.md', path: 'mock://samples/.cadt/memory/MEMORY.md', isDir: false},
        {name: 'user-preferences.md', path: 'mock://samples/.cadt/memory/user-preferences.md', isDir: false},
    ],
    'mock://samples/.cadt/skills': [
        {name: 'demo-skill', path: 'mock://samples/.cadt/skills/demo-skill', isDir: true},
        {name: 'workspace-skill.md', path: 'mock://samples/.cadt/skills/workspace-skill.md', isDir: false},
    ],
    'mock://samples/.cadt/skills/demo-skill': [
        {name: 'SKILL.md', path: 'mock://samples/.cadt/skills/demo-skill/SKILL.md', isDir: false},
    ],
    'mock://samples/.agents/skills': [
        {name: 'demo-skill', path: 'mock://samples/.agents/skills/demo-skill', isDir: true},
        {name: 'workspace-agents-skill.md', path: 'mock://samples/.agents/skills/workspace-agents-skill.md', isDir: false},
    ],
    'mock://samples/.agents/skills/demo-skill': [
        {name: 'SKILL.md', path: 'mock://samples/.agents/skills/demo-skill/SKILL.md', isDir: false},
    ],
    'mock://home/.agents/skills': [
        {name: 'demo-skill', path: 'mock://home/.agents/skills/demo-skill', isDir: true},
        {name: 'agents-skill.md', path: 'mock://home/.agents/skills/agents-skill.md', isDir: false},
    ],
    'mock://home/.agents/skills/demo-skill': [
        {name: 'SKILL.md', path: 'mock://home/.agents/skills/demo-skill/SKILL.md', isDir: false},
    ],
    'mock://appdata/CandySweet/CaDt-DataLens': [
        {name: 'ai-memory', path: 'mock://appdata/CandySweet/CaDt-DataLens/ai-memory', isDir: true},
        {name: 'ai-skills', path: 'mock://appdata/CandySweet/CaDt-DataLens/ai-skills', isDir: true},
    ],
    'mock://appdata/CandySweet/CaDt-DataLens/ai-memory': [
        {name: 'MEMORY.md', path: 'mock://appdata/CandySweet/CaDt-DataLens/ai-memory/MEMORY.md', isDir: false},
        {name: 'user-preferences.md', path: 'mock://appdata/CandySweet/CaDt-DataLens/ai-memory/user-preferences.md', isDir: false},
    ],
    'mock://appdata/CandySweet/CaDt-DataLens/ai-skills': [
        {name: 'demo-skill', path: 'mock://appdata/CandySweet/CaDt-DataLens/ai-skills/demo-skill', isDir: true},
    ],
    'mock://appdata/CandySweet/CaDt-DataLens/ai-skills/demo-skill': [
        {name: 'SKILL.md', path: 'mock://appdata/CandySweet/CaDt-DataLens/ai-skills/demo-skill/SKILL.md', isDir: false},
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

const mockAISessions = new Map();
const mockAISessionImages = new Map();
let mockAIConfigText = '';

const mockBackend = {
    async AIConfigRead() {
        return mockAIConfigText;
    },
    async AIConfigWrite(data) {
        mockAIConfigText = String(data || '');
        return null;
    },
    async AISessionStoreRoot() {
        return 'mock://appdata/CandySweet/CaDt-DataLens/ai-sessions';
    },
    async AISessionList() {
        return Array.from(mockAISessions.values()).map((item) => item.meta);
    },
    async AISessionRead(id) {
        const item = mockAISessions.get(String(id));
        return item ? item.log : '';
    },
    async AISessionAppend(id, lines) {
        const key = String(id);
        const item = mockAISessions.get(key) || {meta: '{}', log: ''};
        item.log += lines;
        mockAISessions.set(key, item);
        return null;
    },
    async AISessionRewrite(id, content) {
        const key = String(id);
        const item = mockAISessions.get(key) || {meta: '{}', log: ''};
        item.log = content;
        mockAISessions.set(key, item);
        return null;
    },
    async AISessionWriteMeta(id, data) {
        const key = String(id);
        const item = mockAISessions.get(key) || {meta: '{}', log: ''};
        item.meta = data;
        mockAISessions.set(key, item);
        return null;
    },
    async AISessionSaveImage(id, name, dataURL) {
        mockAISessionImages.set(String(id) + '/' + name, dataURL);
        return 'images/' + name;
    },
    async AISessionReadImage(id, name) {
        return mockAISessionImages.get(String(id) + '/' + name) || '';
    },
    async AISessionDelete(id) {
        mockAISessions.delete(String(id));
        return null;
    },
    async AISessionDeleteAll() {
        mockAISessions.clear();
        return null;
    },
    async GetStartupFiles() {
        if (mockScenario.has('empty')) return [];
        if (mockScenario.has('wsdir')) return [];
        if (mockScenario.has('gbk')) return [mockDir + 'sample-gbk.json'];
        if (mockScenario.has('image')) return [mockDir + 'sample.png'];
        if (mockScenario.has('large')) return [mockDir + 'large.json'];
        if (mockScenario.has('invalid')) return [mockDir + 'invalid.json'];
        if (mockScenario.has('bigcsv')) return [mockDir + 'big.csv'];
        for (const key of ['yaml', 'xml', 'svg', 'brokensvg', 'csv', 'text', 'txt', 'jsonl', 'toml', 'ini', 'gomod', 'gosum', 'bak', 'py', 'md', 'html', 'js', 'go', 'machine']) {
            if (mockScenario.has(key)) return [mockDir + mockFiles[key].name];
        }
        return [mockDir + 'sample.json'];
    },
    async GetStartupTargets() {
        if (mockScenario.has('line')) return [{path: mockDir + 'sample.json', line: 5, column: 3}];
        if (mockScenario.has('wsdir')) return [{path: mockScenario.get('wsdir') || mockDir.slice(0, -1), line: 0, column: 0}];
        const files = await this.GetStartupFiles();
        return files.map((path) => ({path, line: 0, column: 0}));
    },
    async GetStartupAISession() {
        return window.__mockStartupAISession || mockScenario.get('aisession') || '';
    },
    async OpenFile(path, enc) {
        window.__mockLastOpenEnc = enc;
        const dirKey = String(path || '').replace(/\/+$/, '');
        if (mockTree[dirKey]) {
            return {path: dirKey, name: dirKey.split('/').pop(), isDir: true};
        }
        const base = path.split('/').pop();
        if (base === 'big.csv') {
            if (!window.__mockBigCsv) {
                const rows = ['id,name,count'];
                for (let i = 1; i <= 5000; i++) rows.push(i + ',name-' + i + ',' + (i % 97));
                window.__mockBigCsv = rows.join('\n');
            }
            const content = window.__mockBigCsv;
            return {path, name: base, content, size: content.length, eol: 'lf', hasBom: false, large: false, enc: 'utf-8'};
        }
        if (window.__mockWrites && Object.prototype.hasOwnProperty.call(window.__mockWrites, path)) {
            const content = String(window.__mockWrites[path] || '');
            return {path, name: base, content, size: content.length, eol: 'lf', hasBom: false, large: false, enc: 'utf-8'};
        }
        if (path.includes('new-file') || path.includes('missing')) {
            throw new Error('The system cannot find the file specified.');
        }
        if (base === 'AGENTS.md' &&
            !(window.__mockWrites && Object.prototype.hasOwnProperty.call(window.__mockWrites, path)) &&
            !(window.__mockCreated && window.__mockCreated[path])) {
            throw new Error('The system cannot find the file specified.');
        }
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
    // ---- 阅读模式（浏览器 mock：内存里造一本书，字段名与 Go 的 json tag 一致） ----
    async ScanReadingRoot(root) {
        const base = String(root || 'mock://books').replace(/[\\/]+$/, '');
        const file = (name, words, title) => ({
            rel: name, name, ext: name.split('.').pop().toLowerCase(), size: words * 3,
            modTime: 0, encoding: 'utf-8', words,
            headings: title ? [{offset: 1, level: 1, title, words}] : [],
        });
        return {
            root: base, title: '演示书籍', author: '甜澄', intro: '', profile: 'file',
            confidence: 1, warnings: [], scanMs: 1,
            files: [
                file('01-山雨欲来.txt', 800, '第一章 山雨欲来'),
                file('02-夜行.txt', 600, '第二章 夜行'),
                file('03-番外篇.txt', 300, '番外篇 旧梦'),
            ],
        };
    },
    async PrepareReadingEpub(path) {
        return {
            id: 'mock-epub', path, title: '演示 EPUB', author: '甜澄',
            cacheDir: '', token: '', modTime: 0,
            chapters: [
                {index: 0, href: 'ch1.xhtml', title: '第一章 山雨欲来', words: 800},
                {index: 1, href: 'ch2.xhtml', title: '第二章 夜行', words: 600},
            ],
        };
    },
    async ReadReadingEpubChapter(id, index) {
        return {index: Number(index) || 0, title: '演示章节', html: '<p>这是 EPUB 演示章节的正文。</p>', words: 12};
    },
    async ParseReadingDocx() {
        return {
            title: '演示 DOCX',
            author: '甜澄',
            blocks: [
                {kind: 'heading', level: 1, text: '第一章 山雨欲来'},
                {kind: 'p', text: '少年推开柴门，山风扑面而来。'},
                {kind: 'heading', level: 1, text: '第二章 夜行'},
                {kind: 'p', text: '月色如水，照在青石板上。'},
            ],
        };
    },
    async SearchReadingBook(requestID, root, query) {
        const q = String(query || '');
        const hits = q ? [
            {rel: '01-山雨欲来.txt', offset: 3, before: '少年推开', match: q, after: '，山风扑面而来。', unitOffset: 1, unitTitle: '第一章 山雨欲来'},
            {rel: '02-夜行.txt', offset: 3, before: '月色如水，照在', match: q, after: '上。', unitOffset: 1, unitTitle: '第二章 夜行'},
        ] : [];
        return {hits, filesScanned: 3, filesTotal: 3, truncated: false, elapsedMs: 1};
    },
    async CancelReadingSearch() { return null; },
    async SuggestReadingBooks() {
        return [{root: 'mock://books/demo', name: '演示书籍', bookFiles: 3, namedFiles: 3, bytes: 5100, estWords: 1700, score: 1}];
    },
    // ---- 其余后端能力：给中性返回，避免浏览器 dev 下调用到 undefined ----
    async SQLImport(path, kind, enc, text) {
        return {id: 'mock-sql', kind, rows: 2, columns: ['id', 'name'], bytes: String(text || '').length, elapsedMs: 1, truncated: false};
    },
    async SQLQuery() {
        return {
            columns: ['id', 'name'],
            rows: [['1', 'alpha'], ['2', 'beta']],
            nulls: [[false, false], [false, false]],
            truncated: false, elapsedMs: 1, message: '',
        };
    },
    async SQLClose() { return null; },
    async TermShells() { return [{id: 'bash', name: 'Git Bash'}]; },
    async DetectToolchain() { return {envs: []}; },
    async ListLangPackages() { return {packages: [], exists: true}; },
    async GitLineMarksFor() { return []; },
    async GetSystemCursors() { return {}; },
    async RegisterPreviewRoot() { return null; },
    async ExportStructureText() { return null; },
    async DebugConsoleRead(offset) {
        const all = window.__mockDebugEntries || [];
        return all.slice(Number(offset) || 0);
    },
    async WatchWorkspace() { return null; },
    async UnwatchWorkspace() { return null; },
    async GetConvertRequest() { return null; },
    async FinishConvert() { return null; },
    async IsAIFloatWindow() { return false; },
    async IsDebugConsoleWindow() { return false; },
    async OpenDebugConsoleWindow() { return null; },
    async AITouchStream() { return null; },
    async AISessionSearch() { return []; },
    async AISessionIndexStats() { return {exists: true, sessions: 0, messages: 0, dirty: 0, bytes: 0, trigram: false}; },
    async AISessionReindex() { return 0; },
    async GetPathInfo(path) {
        const base = String(path || '').split('/').pop();
        const isDir = !!mockTree[String(path || '').replace(/\/+$/, '')];
        return {
            path,
            name: base,
            isDir,
            size: isDir ? 0 : (mockFiles.base || mockFiles.json).content.length,
            modified: Date.now() - 3600 * 1000,
            readOnly: false,
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
        return {entries: entries.slice(0, cap), truncated: entries.length > cap, mtime: 0};
    },
    async DirMtime(path) {
        const key = String(path || '').replace(/\/+$/, '');
        if (!mockTree[key]) throw new Error('目录不存在');
        return 0;
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
    async SearchWorkspace(root, query, caseSensitive, maxResults) {
        const text = String(query == null ? '' : query);
        const limit = Math.max(1, Math.min(Number(maxResults) || 400, 1000));
        const hits = [];
        if (!text) return {hits, truncated: false, files: 0};
        const needle = caseSensitive ? text : text.toLowerCase();
        let files = 0;
        for (const item of Object.values(mockFiles)) {
            files++;
            const lines = String(item.content || '').split('\n');
            for (let i = 0; i < lines.length && hits.length < limit; i++) {
                const line = lines[i].replace(/\r$/, '');
                if (!line) continue;
                const hay = caseSensitive ? line : line.toLowerCase();
                let from = 0;
                while (hits.length < limit) {
                    const idx = hay.indexOf(needle, from);
                    if (idx < 0) break;
                    hits.push({
                        path: mockDir + item.name,
                        name: item.name,
                        dir: 'samples',
                        line: i + 1,
                        column: idx + 1,
                        length: text.length,
                        preview: line,
                        matchStart: idx,
                        matchEnd: idx + text.length,
                    });
                    from = idx + Math.max(1, needle.length);
                }
            }
        }
        return {hits, truncated: hits.length >= limit, files};
    },
    async ReadImageDataURL() { return mockImageDataUrl; },
    async SaveFileDialog(name) { return 'mock://' + (window.__mockSaveDialogName || name); },
    async ShowSaveFileDialog(title, defaultName) {
        return 'mock://' + (window.__mockExportName || defaultName || 'export.json');
    },
    async ShowOpenFileDialog(title, filter) {
        return window.__mockOpenDialogPath || 'mock://import-ai-config.json';
    },
    async ExportDebugConsoleLog(defaultName, content) {
        const path = 'mock://' + (window.__mockExportName || defaultName || 'debug-console.log');
        window.__mockWrites = window.__mockWrites || {};
        window.__mockWrites[path] = String(content == null ? '' : content);
        window.__mockSaves = (window.__mockSaves || []).concat([{path, content, eol: 'lf', hasBom: false, enc: 'utf-8'}]);
        window.__mockLastSavePath = path;
        return path;
    },
    async SaveFile(path, content, eol, hasBom, enc) {
        window.__mockLastSaveEnc = enc;
        window.__mockLastSavePath = path;
        window.__mockSaves = (window.__mockSaves || []).concat([{path, content, eol, hasBom, enc}]);
        window.__mockWrites = window.__mockWrites || {};
        window.__mockWrites[path] = String(content == null ? '' : content);
        try {
            const idx = String(path).lastIndexOf('/');
            const dir = idx > 0 ? String(path).slice(0, idx) : '';
            const name = idx > 0 ? String(path).slice(idx + 1) : String(path);
            if (dir && mockTree[dir] && !mockTree[dir].some((entry) => entry.name === name)) {
                mockTree[dir].push({name, path, isDir: false});
            }
        } catch (e) {}
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
        const usedShell = shell || 'pwsh';
        setTimeout(() => {
            if (rt && rt.EventsEmit) {
                rt.EventsEmit('term-out', {id, data: 'CaDt-DataLens 模拟终端（开发预览）\r\nPS ' + (cwd || 'C:\\') + '> '});
            }
        }, 200);
        return {id, shell: usedShell};
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
    async GetEnvVars() {
        if (!window.__mockEnvVars) {
            window.__mockEnvVars = {
                encrypted: true,
                supported: true,
                vars: [{name: 'DEMO_API_KEY', value: 'sk-demo-123', description: '演示密钥（mock）', enabled: true}],
            };
        }
        return JSON.parse(JSON.stringify(window.__mockEnvVars));
    },
    async SetEnvVars(vars) {
        if (!window.__mockEnvVars) window.__mockEnvVars = {encrypted: true, vars: []};
        window.__mockEnvVars.vars = JSON.parse(JSON.stringify(vars || []));
        return null;
    },
    async SetEnvVarEncrypted(on) {
        if (!window.__mockEnvVars) window.__mockEnvVars = {encrypted: false, vars: []};
        window.__mockEnvVars.encrypted = !!on;
        return null;
    },
    async AIRunShellCommand(command, cwd, timeoutMs) {
        (window.__mockShellLog || (window.__mockShellLog = [])).push({command, cwd, timeoutMs});
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
            shell: 'Git Bash',
            exe: 'C:/Program Files/Git/bin/bash.exe',
            code: 0,
            stdout: '[mock] ' + command + (cwd ? '\n(cwd ' + cwd + ')' : ''),
            stderr: '',
            timedOut: false,
            durationMs: 200,
        };
    },
    async AICommandStart(command, cwd) {
        const jobs = window.__mockBgJobs || (window.__mockBgJobs = new Map());
        const id = 'bg-mock-' + (++mockBgSeq);
        const job = {id, state: 'running', code: null, output: [], startedAtMs: Date.now()};
        jobs.set(id, job);
        const emit = (name, data) => {
            if (rt && rt.EventsEmit) rt.EventsEmit(name, data);
        };
        setTimeout(() => {
            const line = '[mock] $ ' + command + (cwd ? '  (cwd ' + cwd + ')' : '');
            job.output.push(line);
            emit('cmd-out', {id, stream: 'out', data: line});
        }, 60);
        for (let i = 1; i <= 3; i++) {
            setTimeout(() => {
                if (job.state !== 'running') return;
                const line = '[mock] line ' + i + ' / ' + command;
                job.output.push(line);
                emit('cmd-out', {id, stream: 'out', data: line});
            }, 60 + i * 220);
        }
        setTimeout(() => {
            if (job.state !== 'running') return;
            job.state = 'exited';
            job.code = 0;
            emit('cmd-exit', {id, code: '0'});
        }, 950);
        return {jobId: id, shell: 'Git Bash'};
    },
    async AICommandStatus(jobId, since) {
        const jobs = window.__mockBgJobs || (window.__mockBgJobs = new Map());
        const job = jobs.get(jobId);
        if (!job) {
            return {jobId, state: 'notfound', code: -1, durationMs: 0, output: '', cursor: 0, truncated: false, startedAtMs: 0};
        }
        const text = job.output.length ? job.output.join('\n') + '\n' : '';
        const cursor = text.length;
        return {
            jobId,
            state: job.state,
            code: job.code == null ? -1 : job.code,
            durationMs: Math.max(0, Date.now() - job.startedAtMs),
            output: since < cursor ? text.slice(since) : '',
            cursor,
            truncated: false,
            startedAtMs: job.startedAtMs,
        };
    },
    async AICommandStop(jobId) {
        const jobs = window.__mockBgJobs || (window.__mockBgJobs = new Map());
        const job = jobs.get(jobId);
        if (!job) {
            return {jobId, state: 'notfound', code: -1, durationMs: 0, output: '', cursor: 0, truncated: false, startedAtMs: 0};
        }
        if (job.state === 'running') {
            job.state = 'exited';
            job.code = -1;
            if (rt && rt.EventsEmit) rt.EventsEmit('cmd-exit', {id: jobId, code: '-1'});
        }
        return this.AICommandStatus(jobId, 0);
    },
    async AIScheduleList() {
        return [...(window.__mockSchedules || (window.__mockSchedules = new Map())).values()]
            .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
    },
    async AIScheduleCreate(input) {
        const store = window.__mockSchedules || (window.__mockSchedules = new Map());
        const kind = String(input.kind || 'once');
        const now = Date.now();
        const schedule = {
            id: 'sch-mock-' + (++mockSchedSeq),
            name: String(input.name || '').trim() || String(input.prompt || '').trim().slice(0, 30) || '未命名任务',
            kind,
            at: String(input.at || ''),
            intervalMinutes: Number(input.intervalMinutes) || 0,
            cron: String(input.cron || ''),
            prompt: String(input.prompt || ''),
            sessionId: String(input.sessionId || ''),
            scope: ['chat', 'read', 'edit'].includes(input.scope) ? input.scope : 'chat',
            enabled: true,
            createdAt: now,
            lastRunAt: 0,
            nextRunAt: kind === 'once'
                ? (input.at ? Date.parse(input.at) || now + 60000 : now + (Number(input.delayMinutes) || 1) * 60000)
                : (kind === 'interval' ? now + (Number(input.intervalMinutes) || 1) * 60000 : now + 60000),
            runCount: 0,
            maxRuns: kind === 'once' ? 1 : (Number(input.maxRuns) || 0),
            lastResult: '',
        };
        store.set(schedule.id, schedule);
        if (rt && rt.EventsEmit) rt.EventsEmit('schedules-changed', {changed: true});
        return JSON.parse(JSON.stringify(schedule));
    },
    async AIScheduleUpdate(id, input) {
        const store = window.__mockSchedules || (window.__mockSchedules = new Map());
        const schedule = store.get(id);
        if (!schedule) throw new Error('定时任务不存在：' + id);
        Object.assign(schedule, {
            name: String(input.name || '').trim() || schedule.name,
            kind: String(input.kind || schedule.kind),
            at: String(input.at || ''),
            intervalMinutes: Number(input.intervalMinutes) || 0,
            cron: String(input.cron || ''),
            prompt: String(input.prompt || schedule.prompt),
            scope: ['chat', 'read', 'edit'].includes(input.scope) ? input.scope : schedule.scope,
            maxRuns: Number(input.maxRuns) || 0,
            nextRunAt: Date.now() + 60000,
        });
        if (rt && rt.EventsEmit) rt.EventsEmit('schedules-changed', {changed: true});
        return JSON.parse(JSON.stringify(schedule));
    },
    async AIScheduleDelete(id) {
        const store = window.__mockSchedules || (window.__mockSchedules = new Map());
        if (!store.delete(id)) throw new Error('定时任务不存在：' + id);
        if (rt && rt.EventsEmit) rt.EventsEmit('schedules-changed', {changed: true});
        return null;
    },
    async AIScheduleToggle(id, enabled) {
        const store = window.__mockSchedules || (window.__mockSchedules = new Map());
        const schedule = store.get(id);
        if (!schedule) throw new Error('定时任务不存在：' + id);
        schedule.enabled = enabled !== false;
        if (schedule.enabled) schedule.nextRunAt = Date.now() + 60000;
        if (rt && rt.EventsEmit) rt.EventsEmit('schedules-changed', {changed: true});
        return JSON.parse(JSON.stringify(schedule));
    },
    async AIScheduleSetResult(id, ok, note) {
        const store = window.__mockSchedules || (window.__mockSchedules = new Map());
        const schedule = store.get(id);
        if (schedule) schedule.lastResult = (ok ? '执行成功' : '执行失败') + (note ? '：' + note : '');
        return null;
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
    async BrowserOpen(id, url, profileKey) {
        if (!window.__mockBrowserTabs) window.__mockBrowserTabs = new Map();
        if (window.__mockBrowserTabs.size >= 4) throw new Error('浏览器标签页最多同时 4 个');
        const title = (url && url !== 'about:blank') ? '[mock] ' + url.replace(/^https?:\/\//, '') : '[mock] 新标签页';
        window.__mockBrowserTabs.set(id, {id, url: url || 'about:blank', title});
        return {id, url: url || 'about:blank', title};
    },
    async BrowserNavigate(id, url) {
        const tab = window.__mockBrowserTabs && window.__mockBrowserTabs.get(id);
        if (!tab) throw new Error('浏览器标签页不存在');
        tab.url = url;
        tab.title = '[mock] ' + url.replace(/^https?:\/\//, '');
        return null;
    },
    async BrowserGoBack(id) { return null; },
    async BrowserGoForward(id) { return null; },
    async BrowserReload(id) { return null; },
    async BrowserStop(id) { return null; },
    async BrowserState(id) {
        const tab = window.__mockBrowserTabs && window.__mockBrowserTabs.get(id);
        if (!tab) throw new Error('浏览器标签页不存在');
        return {id, url: tab.url, title: tab.title, canGoBack: false, canGoForward: false, loading: false};
    },
    async BrowserEval(id, script) {
        return JSON.stringify({result: {value: '[mock eval] ' + String(script).slice(0, 60)}});
    },
    async BrowserCallCDP(id, method, paramsJSON) {
        throw new Error('CDP 通道暂不可用（' + method + '）');
    },
    async BrowserCaptureScreenshot(id) {
        const tab = window.__mockBrowserTabs && window.__mockBrowserTabs.get(id);
        window.__mockShotUrl = tab ? tab.url : id;
        return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    },
    async BrowserSetBounds(id, x, y, w, h) {
        if (!window.__mockBrowserBounds) window.__mockBrowserBounds = new Map();
        window.__mockBrowserBounds.set(id, {x, y, w, h});
        if (w > 0 && h > 0) {
            if (!window.__mockBrowserVisible) window.__mockBrowserVisible = new Map();
            window.__mockBrowserVisible.set(id, true);
        }
        return null;
    },
    async BrowserSetVisible(id, visible) {
        if (!window.__mockBrowserVisible) window.__mockBrowserVisible = new Map();
        window.__mockBrowserVisible.set(id, !!visible);
        return null;
    },
    async BrowserFocus(id) { return null; },
    async BrowserClose(id) {
        if (window.__mockBrowserTabs) window.__mockBrowserTabs.delete(id);
        return null;
    },
    async GitStatusFor(dir) {
        if (!mockScenario.has('gitmock')) {
            return {available: false, reason: 'mock 无 git', entries: []};
        }
        return {
            available: true,
            root: dir,
            branch: window.__mockBranch || 'mock/main',
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
    async GitBranchesFor(dir, includeRemote) {
        window.__mockBranchCalls = (window.__mockBranchCalls || []).concat([{includeRemote: !!includeRemote}]);
        if (!mockScenario.has('gitmock')) {
            return {available: false, reason: 'mock 无 git', recent: [], local: [], remote: [], tags: []};
        }
        const current = window.__mockBranch || 'mock/main';
        return {
            available: true,
            root: dir,
            current,
            recent: ['mock/feature', 'hotfix/1.0.1'],
            local: [
                {name: 'hotfix/1.0.1', current: current === 'hotfix/1.0.1', upstream: 'origin/hotfix/1.0.1', ahead: 0, behind: 3},
                {name: 'mock/feature', current: current === 'mock/feature', upstream: 'origin/mock/feature', ahead: 2, behind: 1},
                {name: 'mock/main', current: current === 'mock/main', upstream: 'origin/mock/main', ahead: 0, behind: 0},
                {name: 'feature/api', current: current === 'feature/api', upstream: 'origin/feature/api', ahead: 1, behind: 0},
                {name: 'feature/ui', current: current === 'feature/ui', upstream: 'origin/feature/ui', ahead: 0, behind: 0},
            ],
            remote: includeRemote ? [
                {name: 'origin/mock/main', current: false},
                {name: 'origin/mock/feature', current: false},
                {name: 'origin/feature/api', current: false},
                {name: 'origin/release/2.0', current: false},
            ] : [],
            tags: ['v1.0.0', 'v1.0.1', 'v1.1.0'],
        };
    },
    async GitCheckoutBranch(dir, name, remote) {
        const branch = remote ? name.replace(/^[^/]+\//, '') : name;
        window.__mockBranch = branch;
        return {success: true, output: '[mock] switched to ' + branch, branch};
    },
    async GitCreateBranch(dir, name) {
        window.__mockBranch = name;
        return {success: true, output: '[mock] created ' + name, branch: name};
    },
    async GitCheckoutRefFor(dir, ref) {
        return {success: true, output: '[mock] checkout ' + ref, branch: ref};
    },
    async GitPullFor(dir) {
        return {success: true, output: '[mock] Already up to date.'};
    },
    async GitPushFor(dir) {
        return {success: true, output: '[mock] Everything up-to-date'};
    },
    async GitFetchFor(dir) {
        return {success: true, output: '[mock] fetched'};
    },
    async GitCloneRepository(url, target) {
        return {success: true, output: '[mock] cloned ' + url, path: target};
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
    async CheckForUpdates() {
        if (mockScenario.has('updateerror')) throw new Error('模拟网络错误');
        if (mockScenario.has('updatenorelease')) {
            return {currentVersion: 'v1.0.0', hasUpdate: false, status: 'no-release', pageUrl: 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases'};
        }
        if (mockScenario.has('updatenone')) {
            return {currentVersion: 'v1.0.0', latestVersion: 'v1.0.0', hasUpdate: false, status: 'ok', pageUrl: 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases'};
        }
        return {
            currentVersion: 'v1.0.0',
            latestVersion: 'v1.1.0',
            hasUpdate: true,
            status: 'ok',
            title: 'CaDt-DataLens 1.1.0',
            notes: '## 本次更新\n\n- 新增检查更新与帮助菜单\n- 优化文件属性对话框\n- 修复若干问题',
            pageUrl: 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases',
            downloadUrl: 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases',
            downloadName: 'CaDt-DataLens-amd64-installer.exe',
            publishedAt: '2026-11-20T10:00:00+08:00',
        };
    },
    async OpenDevTools() {
        window.__mockDevTools = true;
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
    async OpenPluginsDir() {
        window.__mockOpenPluginsDir = (window.__mockOpenPluginsDir || 0) + 1;
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
    async GetPluginMarket() {
        if (window.__mockMarketError) throw new Error(window.__mockMarketError);
        const items = [
            {
                id: 'bak-json',
                name: 'JSON 备份查看',
                version: '1.0.0',
                author: 'CandySweet',
                description: '把 .bak 文件按 JSON 解析；解析失败时自动退回文本视图，并附演示命令与主题',
                repo: 'cadt-datalens-plugins/bak-json',
                url: 'https://gitee.com/cadt-datalens-plugins/bak-json',
                updatedAt: '2026-11-08T20:34:34+08:00',
                stars: 2,
                minAppVersion: '1.0.0',
                manifestOk: true,
                installed: true,
                installedVersion: '0.9.0',
            },
            {
                id: 'git-flow',
                name: 'Git 工作流',
                version: '1.0.0',
                author: 'CandySweet',
                description: '变更列表 / 历史 / 文件历史 / 差异 / 分支，只读查询',
                repo: 'cadt-datalens-plugins/git-flow',
                url: 'https://gitee.com/cadt-datalens-plugins/git-flow',
                updatedAt: '2026-11-08T20:34:34+08:00',
                stars: 0,
                manifestOk: true,
                installed: false,
            },
        ];
        if (mockScenario.has('marketmany')) {
            for (let i = 1; i <= 3; i += 1) {
                items.push({...items[0], id: 'bak-json-' + i, name: 'JSON 备份查看 ' + i});
            }
        }
        return items;
    },
    async ReadPluginAsset(pluginId, relPath) {
        if (!relPath) throw new Error('资产路径为空');
        window.__mockPluginAssets = (window.__mockPluginAssets || []).concat([pluginId + ':' + relPath]);
        return mockImageDataUrl;
    },
    async OpenNewWindow() { window.__mockNewWindow = (window.__mockNewWindow || 0) + 1; },
    async UpdatePluginFromUrl(id, url) {
        window.__mockUpdated = (window.__mockUpdated || []).concat([[id, url]]);
        return {id, name: 'JSON 备份查看', version: '1.0.0'};
    },
    async OpenInNewWindows(paths) { window.__mockNewWindows = (window.__mockNewWindows || []).concat([paths]); },
    async OpenDirInNewWindow(dir) { window.__mockNewWindowDir = dir; window.__mockNewWindows = (window.__mockNewWindows || []).concat([[dir]]); },
    async OpenWorkspaceForConversation(dir, sessionId) {
        window.__mockSoftSwitch = {dir, sessionId: sessionId || ''};
        window.__mockNewWindows = (window.__mockNewWindows || []).concat([[dir]]);
    },
    async ShowInFolder(path) { window.__mockShowInFolder = path; },
    async LogFrontend(level, message) { (window.__mockLogs = window.__mockLogs || []).push(level + ': ' + message); },
    async GetDeveloperMode() { return !!window.__mockDevMode; },
    async SetDeveloperMode(on) { window.__mockDevMode = !!on; },
    async GetLogPath() { return 'C:\\Users\\admin\\AppData\\Roaming\\CandySweet\\CaDt-DataLens\\logs\\2026-11-09_13-00-00.txt'; },
    async OpenLogDir() { window.__mockOpenLogDir = (window.__mockOpenLogDir || 0) + 1; },
    async CopyText(text) { window.__mockCopied = text; window.__mockClipboard = text; },
    async SaveDataURL(path) { window.__mockSaved = path; return path; },
    async CopyFileTo(srcPath) { return srcPath; },
    async GetClipboardText() { return window.__mockClipboard || ''; },
    async ForceClose() { window.__mockForceClosed = (window.__mockForceClosed || 0) + 1; },
    async WebSearch(query, maxResults) {
        window.__mockWebSearch = {query, maxResults};
        return {
            query,
            engine: 'bing',
            endpoint: 'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query),
            results: [
                {
                    title: 'Wails v2 发布 | Wails 框架',
                    url: 'https://wails.io/zh-Hans/blog/wails-v2-released/',
                    snippet: 'Wails v2 正式发布：用 Go 与 Web 前端构建桌面应用，内置原生窗口与单文件打包。',
                    published: 'Sat, 12 Sep 2026 17:27:00 GMT',
                },
                {
                    title: 'The Wails Project | Wails',
                    url: 'https://wails.io/zh-Hans/',
                    snippet: 'Wails v2 turns what used to be tedious and painful into a delightfully simple process.',
                    published: 'Mon, 26 Oct 2026 03:20:00 GMT',
                },
            ].slice(0, maxResults || 8),
        };
    },
    async WebFetch(url, maxChars) {
        window.__mockWebFetch = {url, maxChars};
        return {
            url,
            finalUrl: url,
            status: 200,
            contentType: 'text/html',
            charset: 'utf-8',
            title: 'Wails v2 发布 | Wails 框架',
            text: 'Wails v2 正式发布\n\nWails v2 允许使用 Go 和任意前端技术栈构建桌面应用。\n它内置原生窗口、WebView2 与单一可执行文件打包。\n\n（mock 页面正文）',
            links: [
                {text: '快速开始', url: 'https://wails.io/zh-Hans/docs/gettingstarted/installation'},
                {text: 'GitHub 仓库', url: 'https://github.com/wailsapp/wails'},
            ],
            truncated: false,
            bytes: 2048,
        };
    },
    async AISendChat(sessionId, cfg, messages, tools, retryMax) {
        const run = {stopped: false, timers: []};
        window.__mockAiRuns = window.__mockAiRuns || new Map();
        window.__mockAiRuns.set(sessionId, run);
        const emit = (name, payload) => {
            if (typeof window.__mockAiEmit !== 'function') return;
            try { window.__mockAiEmit(name, payload); } catch (e) {}
        };
        const last = (messages || []).filter((m) => m.role === 'user').pop();
        const prompt = last ? String(last.content || '') : '';
        window.__mockAiLastCfg = cfg;
        window.__mockAiLastMessages = messages;
        window.__mockAiLastTools = tools;
        const systemMessage = (messages || []).find((message) => message.role === 'system');
        window.__mockAiSystemLog = (window.__mockAiSystemLog || []).concat([systemMessage ? systemMessage.content : '']);
        window.__mockAiToolsLog = (window.__mockAiToolsLog || []).concat([(tools || []).map((tool) => tool.name)]);
        if (mockScenario.has('aierr')) {
            run.timers.push(setTimeout(() => {
                if (run.stopped) return;
                emit('ai-error', {
                    id: sessionId,
                    message: '模拟错误：API Key 无效（地址栏加 ?aierr）',
                });
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, 120));
            return null;
        }
        const slow = mockScenario.has('aislow') ? 180 : 24;
        const retryLead = mockScenario.has('airetry');
        const leadDelay = retryLead ? 2000 : 0;
        const reasoningText = mockScenario.has('aithink') ? '先读取用户的问题，再给出简洁回答。' : '';
        let content = '这是浏览器 mock 回复：已收到「' + prompt.slice(0, 60) + '」。\n\n';
        content += '在地址栏加 `?aithink` 可预览思考链，`?aierr` 预览错误，`?aislow` 测试停止按钮。';
        const thinkChunks = reasoningText ? reasoningText.match(/[^\n]{1,4}/g) || [] : [];
        const contentChunks = content.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
        let delay = 30 + leadDelay;
        const schedule = (fn, ms) => {
            const timer = setTimeout(() => {
                if (run.stopped) return;
                fn();
            }, ms);
            run.timers.push(timer);
        };
        if (retryLead) {
            schedule(() => emit('ai-retry', {id: sessionId, attempt: 1, max: 5, delayMs: 1500, reason: 'HTTP 429'}), 60);
        }
        if (mockScenario.has('aibrowser')) {
            const lastMsg = (messages || [])[messages.length - 1];
            const isToolRound = !!(lastMsg && lastMsg.role === 'tool');
            const emitToolcall = (name, args) => {
                const argChunks = args.match(/.{1,16}/gs) || [];
                argChunks.forEach((chunk, i) => {
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: i === 0 ? 'call_mock_browser' : '',
                        name: i === 0 ? name : '',
                        argsDelta: chunk,
                    }), 60 + i * 40);
                });
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 90 + argChunks.length * 40 + 50);
            };
            const hasBrowserTool = (messages || []).some((m) => m.role === 'tool' && /^browser_/.test(m.name || ''));
            if (!isToolRound && !hasBrowserTool) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我来打开页面并截图。' + String.fromCharCode(10) + String.fromCharCode(10)}), 20);
                emitToolcall('browser_navigate', '{"url": "https://mock.example.com"}');
                return null;
            }
            // 按最后一个工具名推进（中间可能插入带图 user 消息，不能用最后一条消息判断）
            const lastTool = [...(messages || [])].reverse().find((m) => m.role === 'tool');
            const prevName = lastTool ? lastTool.name : '';
            if (prevName === 'browser_navigate') {
                emitToolcall('browser_snapshot', '{}');
                return null;
            }
            if (prevName === 'browser_snapshot') {
                emitToolcall('browser_screenshot', '{}');
                return null;
            }
            const finalText = '浏览器链路完成：' + String.fromCharCode(10, 10, 96, 96, 96) + String(lastMsg.content || '').slice(0, 200) + String.fromCharCode(96, 96, 96, 10) + 'mock browser 链路结束。';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop', usage: {promptTokens: 32, completionTokens: 48, totalTokens: 80, cachedTokens: 0}});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aicreateenv')) {
            // 只有「最后一条消息是工具结果」才算工具回传轮，避免历史 tool 消息造成误判
            const lastMsg = (messages || [])[messages.length - 1];
            const isToolRound = !!(lastMsg && lastMsg.role === 'tool');
            if (!isToolRound) {
                const wantList = /env_list|列出环境变量|有哪些变量/.test(prompt);
                const args = wantList ? '{}' : '{"name": "USER_SECRET_TOKEN", "description": "AI 请求创建的演示变量（mock 场景）"}';
                const argChunks = args.match(/.{1,16}/gs) || [];
                schedule(() => emit('ai-chunk', {id: sessionId, delta: wantList ? '我列一下已配置的环境变量。\n\n' : '我来帮你创建一个环境变量。\n\n'}), 20);
                argChunks.forEach((chunk, i) => {
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: i === 0 ? 'call_mock_env_1' : '',
                        name: i === 0 ? (wantList ? 'env_list' : 'env_create') : '',
                        argsDelta: chunk,
                    }), 70 + i * 50);
                });
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 90 + argChunks.length * 50 + 60);
                return null;
            }
            const finalText = 'env 工具返回：\n\n```\n' + String(lastMsg.content || '') + '\n```\n\nmock env 工具链路完成。';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {
                    id: sessionId,
                    finishReason: 'stop',
                    usage: {promptTokens: 24, completionTokens: 40, totalTokens: 64, cachedTokens: 0},
                });
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aiweb')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            const emitToolcall = (name, args) => {
                const argChunks = args.match(/.{1,16}/gs) || [];
                argChunks.forEach((chunk, i) => {
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: i === 0 ? 'call_mock_web_' + name : '',
                        name: i === 0 ? name : '',
                        argsDelta: chunk,
                    }), 70 + i * 40);
                });
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 90 + argChunks.length * 40 + 50);
            };
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先联网查一下 Wails v2 的资料。\n\n'}), 20);
                emitToolcall('web_search', JSON.stringify({query: 'Wails v2 发布时间', maxResults: 3}));
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            if (lastTool.name === 'web_search') {
                emitToolcall('web_fetch', JSON.stringify({url: 'https://wails.io/zh-Hans/blog/wails-v2-released/', maxChars: 4000}));
                return null;
            }
            const finalText = [
                '查到了：Wails v2 于 2022 年 9 月正式发布，支持 Go + Web 前端构建桌面应用。',
                '',
                '来源：',
                '- [Wails v2 发布 | Wails 框架](https://wails.io/zh-Hans/blog/wails-v2-released/)',
                '- [The Wails Project](https://wails.io/zh-Hans/)',
                '',
                '（mock 联网检索链路结束）',
            ].join('\n');
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aitool')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先查看一下目录。\n\n'}), 20);
                const argChunks = ['{"pa', 'th": "."}'];
                argChunks.forEach((chunk, i) => {
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: i === 0 ? 'call_mock_1' : '',
                        name: i === 0 ? 'list_dir' : '',
                        argsDelta: chunk,
                    }), 70 + i * 50);
                });
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 210);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const summary = String(lastTool.content || '').split('\n').slice(0, 8).join('\n');
            const finalText = '工具返回结果：\n\n```\n' + summary + '\n```\n\n这是 mock 工具链路的最终回复。';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                const promptTokens = Math.ceil(prompt.length / 4);
                const completionTokens = Math.ceil(finalText.length / 4);
                emit('ai-done', {
                    id: sessionId,
                    finishReason: 'stop',
                    usage: {
                        promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
                        cachedTokens: Math.ceil(promptTokens * 0.75),
                    },
                });
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('airun')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                // ?airun&aithink：模拟「只有思考链、没有正文」的工具轮（回归：工具执行期间思考链不能消失）
                if (mockScenario.has('aithink')) {
                    const think = '先确认仓库状态，再执行命令。';
                    const thinkChunks = think.match(/[^\n]{1,3}/g) || [];
                    thinkChunks.forEach((chunk, i) => schedule(() => emit('ai-think', {id: sessionId, delta: chunk}), 20 + i * slow));
                    const base = 20 + thinkChunks.length * slow;
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: 'call_mock_runcmd',
                        name: 'run_command',
                        argsDelta: JSON.stringify({command: 'git status --short'}),
                    }), base + 50);
                    schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), base + 160);
                    return null;
                }
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先执行一条命令确认环境。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_runcmd',
                    name: 'run_command',
                    argsDelta: JSON.stringify({command: 'git status --short'}),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '命令输出：\n\n```\n' + String(lastTool.content || '').slice(0, 400) + '\n```\n\n（mock run_command 链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aibg')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我在后台启动一个耗时命令。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_bgcmd',
                    name: 'background_command',
                    argsDelta: JSON.stringify({command: 'npm run build'}),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            if (toolMessages.length === 1) {
                const jobId = (String(toolMessages[toolMessages.length - 1].content || '').match(/jobId=([\w-]+)/) || [])[1] || 'bg-mock-1';
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_bgcheck',
                    name: 'check_command',
                    argsDelta: JSON.stringify({jobId}),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '后台命令已结束：\n\n```\n' + String(lastTool.content || '').slice(0, 400) + '\n```\n\n（mock background_command 链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aispawn')) {
            const isSub = String(sessionId).startsWith('sub-');
            if (isSub) {
                // 子代理第一轮直接给结论（不发起工具调用）
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '探索完成：工作区包含 sample.json（时空纪元 v1.0.0，2 个数据项），结构完好，无异常字段。'}), 40);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'stop'}), 160);
                return null;
            }
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我派一个子代理去做只读探索。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_spawn',
                    name: 'spawn_agent',
                    argsDelta: JSON.stringify({name: '探索员', task: '查看工作区数据文件并总结内容', maxRounds: 5}),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '子代理返回：\n\n' + String(lastTool.content || '').slice(0, 400) + '\n\n（mock spawn_agent 链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('airunseq')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            const steps = ['git status --short', 'git status --porcelain'];
            if (toolMessages.length < steps.length) {
                const index = toolMessages.length;
                schedule(() => emit('ai-chunk', {id: sessionId, delta: index ? '再执行一条同类命令。\n\n' : '先执行一条命令。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_runcmd_seq_' + index,
                    name: 'run_command',
                    argsDelta: JSON.stringify({command: steps[index]}),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '两条命令都已执行：\n\n```\n' + String(lastTool.content || '').slice(0, 400) + '\n```\n\n（mock 命令放行链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('airunpower')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            const steps = [
                'powershell -NoProfile -Command "Get-Process"',
                'powershell -NoProfile -Command "Get-Date"',
                'powershell -NoProfile -Command "Get-Process"',
            ];
            if (toolMessages.length < steps.length) {
                const index = toolMessages.length;
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '执行第 ' + (index + 1) + ' 条 PowerShell 命令。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_runcmd_power_' + index,
                    name: 'run_command',
                    argsDelta: JSON.stringify({command: steps[index]}),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = 'PowerShell 命令已执行：\n\n```\n' + String(lastTool.content || '').slice(0, 400) + '\n```\n\n（mock 精确命令放行链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aiask')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我需要你确认一下方案。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_ask',
                    name: 'ask_user',
                    argsDelta: JSON.stringify({
                        questions: [
                            {
                                id: 'merge',
                                header: '合并方式',
                                question: '这次要采用哪种合并策略？',
                                options: [
                                    {label: '按文件合并', description: '逐文件对比后合并，最稳', recommended: true},
                                    {label: '整目录覆盖', description: '用新目录整体替换旧目录'},
                                ],
                            },
                            {
                                id: 'checks',
                                header: '验证',
                                question: '除了主流程，还要跑哪些检查？',
                                multiSelect: true,
                                options: [
                                    {label: '单元测试', recommended: true},
                                    {label: '构建验证', recommended: true},
                                    {label: '不做额外检查'},
                                ],
                            },
                            {
                                id: 'extra',
                                header: '补充',
                                question: '还有别的约束吗？',
                                allow_custom: true,
                                options: [],
                            },
                        ],
                    }),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '已收到回答：' + String(lastTool.content || '').slice(0, 300) + '\n\n（mock ask_user 链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aibigwrite')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                const lines = [];
                for (let i = 1; i <= 80; i += 1) lines.push('- 第 ' + i + ' 行：mock 大 diff 演示内容');
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_bigwrite',
                    name: 'write_file',
                    argsDelta: JSON.stringify({
                        path: 'big-diff.md',
                        content: '# Mock 大文件\n\n' + lines.join('\n') + '\n',
                    }),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
                return null;
            }
            const finalText = '大 diff 写入结果：' + String(toolMessages[toolMessages.length - 1].content || '').slice(0, 200) + '\n\n（mock 大 diff 链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aipref')) {
            const userCount = (messages || []).filter((message) => message.role === 'user').length;
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            const lastTool = toolMessages[toolMessages.length - 1];
            const lastContent = String((lastTool && lastTool.content) || '');
            const emitTool = (callId, name, args) => {
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId,
                    name,
                    argsDelta: JSON.stringify(args),
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 180);
            };
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先把这条偏好记下来。\n\n'}), 20);
                emitTool('call_mock_pref_write', 'preference_write', {text: '演示偏好：回答尽量简洁'});
                return null;
            }
            if (lastContent.startsWith('已记录用户偏好') || lastContent.startsWith('已更新用户偏好')) {
                emitTool('call_mock_pref_list', 'preference_list', {});
                return null;
            }
            if (lastContent.startsWith('用户偏好（共')) {
                const match = lastContent.match(/\[(pref-[^\]]+)\]/);
                if (match && userCount < 2 && !lastContent.includes('更新版')) {
                    emitTool('call_mock_pref_edit', 'preference_write', {
                        id: match[1],
                        text: '演示偏好：回答尽量简洁（更新版）',
                    });
                    return null;
                }
                if (match && userCount >= 2) {
                    emitTool('call_mock_pref_remove', 'preference_remove', {id: match[1]});
                    return null;
                }
            }
            const finalText = '偏好工具结果：' + lastContent.slice(0, 300) + '\n\n（mock 用户偏好链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aiwrite') || mockScenario.has('aiedit') || mockScenario.has('aitodo')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            const emitToolCall = (callId, name, args, doneDelay) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先执行工具操作。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId,
                    name,
                    argsDelta: args,
                }), 70);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), doneDelay || 180);
            };
            if (mockScenario.has('aiwrite')) {
                if (!toolMessages.length) {
                    emitToolCall('call_mock_write', 'write_file', JSON.stringify({
                        path: 'new-file.md',
                        content: '# AI 写入演示\n\n- 第一行\n- 第二行\n- 第三行\n',
                    }));
                    return null;
                }
            } else if (mockScenario.has('aiedit')) {
                if (!toolMessages.length) {
                    emitToolCall('call_mock_edit', 'edit_file', JSON.stringify({
                        path: 'notes.md',
                        oldString: '- 电缆：每格每日 4 件',
                        newString: '- 电缆：每格每日 6 件（AI 修改）',
                    }));
                    return null;
                }
            } else if (mockScenario.has('aitodo')) {
                if (!toolMessages.length) {
                    emitToolCall('call_mock_todo1', 'todo_write', JSON.stringify({
                        todos: [
                            {content: '读取项目说明', status: 'completed'},
                            {content: '修改配置', status: 'in_progress'},
                            {content: '验证结果', status: 'pending'},
                        ],
                    }));
                    return null;
                }
                if (toolMessages.length === 1) {
                    emitToolCall('call_mock_todo2', 'todo_write', JSON.stringify({
                        todos: [
                            {content: '读取项目说明', status: 'completed'},
                            {content: '修改配置', status: 'completed'},
                            {content: '验证结果', status: 'completed'},
                        ],
                    }));
                    return null;
                }
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '工具结果：' + String((lastTool && lastTool.content) || '').slice(0, 300) + '\n\n（mock 写操作链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (mockScenario.has('aiskill') || mockScenario.has('aimem')) {
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                const isSkill = mockScenario.has('aiskill');
                const toolName = isSkill ? 'skill_use' : 'memory_write';
                const args = JSON.stringify(isSkill
                    ? {name: 'demo-skill'}
                    : {name: 'test-note.md', content: '# 测试记忆\n\n- 用户喜欢胶囊表格。'});
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先调用工具处理一下。\n\n'}), 20);
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: 'call_mock_2',
                    name: toolName,
                    argsDelta: args,
                }), 80);
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 200);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '工具结果：' + String(lastTool.content || '').slice(0, 300) + '\n\n（mock 工具链路结束）';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop'});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        if (thinkChunks.length) {
            thinkChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-think', {id: sessionId, delta: chunk}), delay + i * slow * 0.6);
            });
            delay += thinkChunks.length * slow * 0.6;
        }
        contentChunks.forEach((chunk, i) => {
            schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), delay + i * slow);
        });
        delay += contentChunks.length * slow;
        schedule(() => {
            const promptTokens = Math.ceil(prompt.length / 4);
            const completionTokens = Math.ceil(content.length / 4);
            emit('ai-done', {
                id: sessionId,
                finishReason: 'stop',
                usage: {
                    promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
                    cachedTokens: Math.ceil(promptTokens * 0.75),
                },
            });
            (window.__mockAiRuns || new Map()).delete(sessionId);
        }, delay + 40);
        return null;
    },
    async AIStop(sessionId) {
        const map = window.__mockAiRuns || new Map();
        for (const [id, run] of map) {
            if (id === sessionId || id.startsWith(sessionId + '#')) {
                run.stopped = true;
                run.timers.forEach((timer) => clearTimeout(timer));
                map.delete(id);
                if (typeof window.__mockAiEmit === 'function') {
                    try { window.__mockAiEmit('ai-done', {id, finishReason: 'stopped'}); } catch (e) {}
                }
            }
        }
    },
    async NotifyAttention(beep) { window.__mockNotify = (window.__mockNotify || []).concat([!!beep]); },
    async NotifySystemToast(title, body, silent) {
        window.__mockSystemToast = (window.__mockSystemToast || []).concat([{title, body, silent: !!silent}]);
    },
    async AITestConnection(cfg) { window.__mockAiTestCfg = cfg; return '连接成功（mock）'; },
    async AIListModels(cfg) { window.__mockAiModelsCfg = cfg; return ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash']; },
    async AIAppDir() { return 'mock://appdata/CandySweet/CaDt-DataLens'; },
    async AIHomeDir() { return window.__mockHomeDir || 'mock://home'; },
    async AIBuiltinSkillsDir() { return window.__mockBuiltinSkillsDir || ''; },
    async AIExePath() { return window.__mockExePath || 'mock://bin/datalens.exe'; },
    async OpenAIFloatWindow(root) { window.__mockAIFloatRoot = root; return null; },
    async OpenSettingsInMainWindow(pane) { window.__mockOpenSettingsInMain = pane; return null; },
    async ConsumeStartupSettings() { const pane = window.__mockStartupSettings || ''; window.__mockStartupSettings = ''; return pane; },
    async AIEnsureDir(path) {
        window.__mockLastEnsureDir = path;
        const key = String(path || '').replace(/\/+$/, '');
        if (!key) return null;
        const match = key.match(/^([a-z]+:\/\/)(.*)$/i);
        const prefix = match ? match[1] : '';
        const rest = match ? match[2] : key;
        let cur = prefix;
        let prev = '';
        for (const part of rest.split('/')) {
            if (!part) continue;
            cur += (cur && !cur.endsWith('/') ? '/' : '') + part;
            if (!mockTree[cur]) mockTree[cur] = [];
            if (prev && mockTree[prev] && !mockTree[prev].some((entry) => entry.name === part && entry.isDir)) {
                mockTree[prev].push({name: part, path: cur, isDir: true});
            }
            prev = cur;
        }
        return null;
    },
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

let developerMode = false;

function formatLogArg(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    } catch (e) {
        return String(value);
    }
}

// 独立调试控制台窗口探测（异步尽早开始；普通窗口为 false）
const consoleWindowMode = (async () => {
    try {
        if (!(backend && backend.IsDebugConsoleWindow)) return false;
        return !!(await backend.IsDebugConsoleWindow());
    } catch (e) {
        return false;
    }
})();
let consoleWindowResolved = null; // true=独立窗口 false=普通窗口 null=未定

// 悬浮调试控制台（F12）：先于 console 捕获补丁创建，保证所有日志都能进面板
const debugConsole = createDebugConsole({
    // 停靠到底部面板容器（与终端共用），显示/隐藏由底部面板控制
    mount: document.getElementById('debug-view'),
    // 面板关闭按钮：收起底部面板
    onClose: () => {
        try { toggleTerminalPanel(false); } catch (e) {}
    },
    // 主窗口把日志批量转给独立窗口（共享中继文件）；独立窗口自身不转发
    relay: (entries) => {
        if (consoleWindowResolved !== false) return;
        try { backend.DebugConsoleAppend?.(entries)?.catch?.(() => {}); } catch (e) {}
    },
    onDetach: () => {
        try {
            if (!backend.OpenDebugConsoleWindow) {
                flash('当前版本不支持独立窗口', true);
                return;
            }
            Promise.resolve(backend.OpenDebugConsoleWindow())
                .catch((e) => flash('打开调试控制台窗口失败：' + e, true));
        } catch (e) {}
    },
    onExport: (name, text) => exportDebugConsoleLog(name, text),
});

// 导出调试控制台日志：弹出保存对话框并写文件；取消时静默
async function exportDebugConsoleLog(name, text) {
    try {
        if (!backend.ExportDebugConsoleLog) {
            flash('当前版本不支持导出日志', true);
            return;
        }
        const path = await backend.ExportDebugConsoleLog(name, text);
        if (!path) return;
        flash('日志已导出：' + path);
    } catch (e) {
        flash('导出日志失败：' + e, true);
    }
}

// 独立控制台窗口内的轻提示：状态栏被隐藏，借用窗口标题提示
function notifyConsoleWindow(message) {
    try {
        const base = '调试控制台 · CaDt-DataLens';
        document.title = message + ' · ' + base;
        setTimeout(() => { document.title = base; }, 2500);
    } catch (e) {}
}
consoleWindowMode.then((v) => { consoleWindowResolved = v; });
window.__debugConsole = debugConsole;

// 独立控制台窗口：隐藏主应用 UI，铺满渲染控制台并轮询中继日志
function startConsoleWindowMode() {
    window.__consoleWindowMode = true;
    document.body.classList.add('console-only');
    document.title = '调试控制台 · CaDt-DataLens';
    const dc = createDebugConsole({
        detached: true,
        remote: (offset) => backend.DebugConsoleRead(offset),
        onExport: async (name, text) => {
            try {
                if (!backend.ExportDebugConsoleLog) return;
                const path = await backend.ExportDebugConsoleLog(name, text);
                if (path) notifyConsoleWindow('日志已导出');
            } catch (e) {
                notifyConsoleWindow('导出失败');
            }
        },
        onClose: () => {
            try {
                if (window.runtime && window.runtime.Quit) {
                    window.runtime.Quit();
                    return;
                }
                if (window.runtime && window.runtime.WindowClose) {
                    window.runtime.WindowClose();
                    return;
                }
                if (backend.ForceClose) backend.ForceClose();
            } catch (e) {}
        },
    });
    window.__debugConsole = dc;
    dc.open();
}

function logFrontend(level, message) {
    try {
        if (!backend || !backend.LogFrontend) return;
        const text = String(message == null ? '' : message);
        if (!text) return;
        const capped = text.length > 16000 ? text.slice(0, 16000) + '…' : text;
        Promise.resolve(backend.LogFrontend(level, capped)).catch(() => {});
    } catch (e) {}
}

for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        original(...args);
        // 调试控制台不按开发者模式过滤：打开面板即回放缓冲（含历史）
        debugConsole.push(level, args);
        if ((level === 'log' || level === 'info' || level === 'debug') && !developerMode) return;
        logFrontend(level, args.map(formatLogArg).join(' '));
    };
}

window.addEventListener('error', (event) => {
    const err = event.error;
    const detail = (err && (err.stack || err.message)) || event.message || '未知错误';
    debugConsole.push('error', ['未捕获异常：' + detail]);
    logFrontend('error', '未捕获异常：' + detail);
});
window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const detail = (reason && (reason.stack || reason.message)) || String(reason);
    debugConsole.push('error', ['未处理的 Promise 拒绝：' + detail]);
    logFrontend('error', '未处理的 Promise 拒绝：' + detail);
});

async function refreshDeveloperMode() {
    if (!backend.GetDeveloperMode) return;
    try {
        developerMode = !!(await backend.GetDeveloperMode());
        if (elsSettings.developerMode) elsSettings.developerMode.checked = developerMode;
    } catch (e) {}
    syncDevConsoleVisibility();
}

// 调试控制台入口跟随开发者模式：关闭时隐藏活动栏图标 / 视图菜单 / F12 / 设置按钮
function syncDevConsoleVisibility() {
    if (els.abDebug) els.abDebug.classList.toggle('hidden', !developerMode);
    const btn = document.getElementById('opt-debug-console');
    if (btn) btn.disabled = !developerMode;
    // 关闭开发者模式时若正在看调试控制台，切回终端（没有终端会话则收起面板）
    if (!developerMode && terminalUI.open && dockView === 'debug') {
        if (terminalUI.sessions.size) {
            dockView = 'terminal';
            applyDockView();
        } else {
            toggleTerminalPanel(false);
        }
    }
}

async function refreshLogPath() {
    if (!backend.GetLogPath) return;
    try {
        const path = await backend.GetLogPath();
        if (elsSettings.logPath) {
            elsSettings.logPath.textContent = path ? '日志文件：' + path : '日志文件：—';
            elsSettings.logPath.title = path || '';
        }
    } catch (e) {}
}

const els = {
    filename: document.getElementById('filename'),
    filenameIcon: document.getElementById('filename-icon'),
    filenameText: document.getElementById('filename-text'),
    wsCrumbs: document.getElementById('ws-crumbs'),
    wsProject: document.getElementById('ws-project'),
    wsProjectBadge: document.getElementById('ws-project-badge'),
    wsProjectName: document.getElementById('ws-project-name'),
    wsBranch: document.getElementById('ws-branch'),
    wsBranchName: document.getElementById('ws-branch-name'),
    projectPop: document.getElementById('project-pop'),
    projectPopBody: document.getElementById('project-pop-body'),
    gitBranchPop: document.getElementById('git-branch-pop'),
    gbSearch: document.getElementById('gb-search'),
    gbBody: document.getElementById('gb-body'),
    gbFetch: document.getElementById('gb-fetch'),
    gbPin: document.getElementById('gb-pin'),
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
    stMdWidth: document.getElementById('st-md-width'),
    stAiWidth: document.getElementById('st-ai-width'),
    stUpdate: document.getElementById('st-update'),
    stWriting: document.getElementById('st-writing'),
    stPos: document.getElementById('st-pos'),
    stEol: document.getElementById('st-eol'),
    stEnc: document.getElementById('st-enc'),
    stMessage: document.getElementById('st-message'),
    stDirty: document.getElementById('st-dirty'),
    stAiWrite: document.getElementById('st-ai-write'),
    stAwIcon: document.querySelector('#st-ai-write .st-aw-icon'),
    stAwState: document.querySelector('#st-ai-write .st-aw-state'),
    stAwPath: document.querySelector('#st-ai-write .st-aw-path'),
    stAwAdd: document.querySelector('#st-ai-write .add'),
    stAwDel: document.querySelector('#st-ai-write .del'),
    stCount: document.getElementById('st-count'),
    breadcrumb: document.getElementById('breadcrumb'),
    findBar: document.getElementById('find-bar'),
    findInput: document.getElementById('find-input'),
    findCase: document.getElementById('find-case'),
    findWord: document.getElementById('find-word'),
    findRegex: document.getElementById('find-regex'),
    findCount: document.getElementById('find-count'),
    findPrev: document.getElementById('find-prev'),
    findNext: document.getElementById('find-next'),
    findClose: document.getElementById('find-close'),
    quickSwitchMask: document.getElementById('quick-switch-mask'),
    quickSwitch: document.getElementById('quick-switch'),
    quickSwitchList: document.getElementById('quick-switch-list'),
    quickSwitchTitle: document.getElementById('quick-switch-title-text'),
    quickSwitchBack: document.getElementById('quick-switch-back'),
    gsMask: document.getElementById('gs-mask'),
    gsPanel: document.getElementById('gs-panel'),
    gsInput: document.getElementById('gs-input'),
    gsList: document.getElementById('gs-list'),
    gsCount: document.getElementById('gs-count'),
    gsRoot: document.getElementById('gs-root'),
    editorArea: document.getElementById('editor-area'),
    sidebar: document.getElementById('sidebar'),
    sbBody: document.getElementById('sb-body'),
    sbTitle: document.getElementById('sb-title'),
    sbRefresh: document.getElementById('sb-refresh'),
    paletteMask: document.getElementById('palette-mask'),
    paletteInput: document.getElementById('palette-input'),
    paletteList: document.getElementById('palette-list'),
    sbFilterBtn: document.getElementById('sb-filter-btn'),
    sbFilterRow: document.getElementById('sb-filter-row'),
    sbFilter: document.getElementById('sb-filter'),
    sbModeList: document.getElementById('sb-mode-list'),
    sbModeTree: document.getElementById('sb-mode-tree'),
    structurePanel: document.getElementById('structure-panel'),
    structureBody: document.getElementById('structure-body'),
    structureRefresh: document.getElementById('structure-refresh'),
    structureCollapse: document.getElementById('structure-collapse'),
    structureExport: document.getElementById('structure-export'),
    btnSidebar: document.getElementById('btn-sidebar'),
    lock: document.getElementById('btn-lock'),
    activityBar: document.getElementById('activity-bar'),
    abFiles: document.getElementById('ab-files'),
    abStructure: document.getElementById('ab-structure'),
    abSearch: document.getElementById('ab-search'),
    abMore: document.getElementById('ab-more'),
    abTerminal: document.getElementById('ab-terminal'),
    abDebug: document.getElementById('ab-debug'),
    abGit: document.getElementById('ab-git'),
    abAi: document.getElementById('ab-ai'),
    abChats: document.getElementById('ab-chats'),
    tbAi: document.getElementById('tb-ai'),
    aiPanel: document.getElementById('ai-panel'),
    termNew: document.getElementById('term-new'),
    termShellMenu: document.getElementById('term-shell-menu'),
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
let structureWorker = null;
let structureWorkerSeq = 0;
let structureWorkerBroken = false;
const structureWorkerPending = new Map();
const structureCache = new Map();
const STRUCTURE_CACHE_LIMIT = 12;
let workspaceFolder = null;
let watchedWorkspaceRoot = '';
let fileClipboard = null;
let ctxMenu = null;
let palette = null;
let aiPanel = null;
let closedTabs = [];

// 应用操作桥：AI 面板 app_control 工具的执行端（仅当前窗口，语义化动作，不模拟 DOM 事件）。
const APP_SETTING_RULES = {
    autoSave: {type: 'bool'},
    showSidebar: {type: 'bool'},
    alwaysOnTop: {type: 'bool'},
    codeWrap: {type: 'bool'},
    codeGuides: {type: 'bool'},
    treeGuides: {type: 'bool'},
    treeCounts: {type: 'bool'},
    mdLineNumbers: {type: 'bool'},
    mdScrollSync: {type: 'bool'},
    readOnlyMode: {type: 'bool'},
    fixedKeys: {type: 'bool'},
    treeRefreshInterval: {type: 'enum', values: [0, 1, 2, 3, 5, 10]},
    sidebarFont: {type: 'number', min: 10, max: 20},
    editorFont: {type: 'number', min: 10, max: 24},
    treeExpandDefault: {type: 'enum', values: ['expand', 'collapse']},
    openMode: {type: 'enum', values: ['tab', 'window']},
    theme: {type: 'theme'},
    sidebarWidth: {type: 'number', min: 160, max: 500},
    terminalHeight: {type: 'number', min: 120, max: 480},
    aiPanelWidth: {type: 'number', min: 280, max: 800},
    aiPanelSide: {type: 'enum', values: ['right', 'left']},
};

const APP_ACTIONS = [
    'get_state', 'screenshot', 'open_file', 'open_folder', 'activate_tab', 'close_tab', 'reopen_closed_tab', 'move_tab',
    'set_view', 'goto_line', 'toggle_sidebar', 'set_sidebar_view', 'toggle_terminal', 'toggle_ai_panel',
    'toggle_fullscreen', 'toggle_always_on_top', 'set_theme', 'open_settings', 'set_setting',
    'ai_new_session', 'ai_switch_session', 'flash', 'refresh_explorer', 'type_text', 'press_key',
    'open_browser_tab', 'close_browser_tab',
    'get_settings', 'get_editor', 'get_content', 'get_git', 'get_ai', 'get_explorer', 'get_plugins', 'get_terminal',
    'get_activity',
];

function appActionDocInfo(doc) {
    if (!doc) return null;
    return {name: doc.name, path: doc.path || '', mode: doc.mode || '', dirty: !!doc.dirty, format: (doc.format && doc.format.id) || ''};
}

function appActionDocCaret(doc) {
    const out = {cursor: null, selection: null};
    if (!doc || doc.binary) return out;
    const lineColAt = (text, offset) => {
        const before = String(text).slice(0, Math.max(0, Math.min(Number(offset) || 0, String(text).length)));
        const lines = before.split('\n');
        return {line: lines.length, column: lines[lines.length - 1].length + 1};
    };
    try {
        const mode = String(doc.mode || '');
        const ace = doc.editor && doc.editor.aceEditor;
        if ((!mode || mode === 'code' || mode === 'split') && ace && ace.getCursorPosition) {
            const pos = ace.getCursorPosition();
            out.cursor = {line: (Number(pos.row) || 0) + 1, column: (Number(pos.column) || 0) + 1};
            if (ace.getSelectionRange && ace.getSelectedText) {
                const sel = ace.getSelectionRange();
                const empty = sel.start.row === sel.end.row && sel.start.column === sel.end.column;
                if (!empty) {
                    const selected = ace.getSelectedText() || '';
                    out.selection = {
                        start: {line: sel.start.row + 1, column: sel.start.column + 1},
                        end: {line: sel.end.row + 1, column: sel.end.column + 1},
                        chars: selected.length,
                        preview: selected.slice(0, 300),
                    };
                }
            }
            if (ace.renderer && ace.renderer.getFirstVisibleRow && ace.session && ace.session.screenToDocumentRow) {
                try {
                    const first = ace.renderer.getFirstVisibleRow();
                    const last = ace.renderer.getLastVisibleRow ? ace.renderer.getLastVisibleRow() : first;
                    out.viewport = {
                        fromLine: (Number(ace.session.screenToDocumentRow(first, 0)) || 0) + 1,
                        toLine: (Number(ace.session.screenToDocumentRow(last, 0)) || 0) + 1,
                    };
                } catch (e) {}
            }
            return out;
        }
        const textarea = doc.pane && doc.pane.querySelector('textarea.jsoneditor-text');
        if ((!mode || mode === 'text') && textarea && typeof textarea.selectionStart === 'number') {
            out.cursor = lineColAt(textarea.value, textarea.selectionEnd);
            if (textarea.selectionEnd > textarea.selectionStart) {
                const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
                out.selection = {
                    start: lineColAt(textarea.value, textarea.selectionStart),
                    end: lineColAt(textarea.value, textarea.selectionEnd),
                    chars: selected.length,
                    preview: selected.slice(0, 300),
                };
            }
        }
    } catch (e) {}
    return out;
}

function appActionResolveDoc(ref) {
    if (ref == null || ref === '') return file;
    if (typeof ref === 'number' && Number.isFinite(ref)) {
        const idx = ref < 0 ? docs.length + ref : ref;
        return docs[idx] || null;
    }
    const text = String(ref).trim();
    if (!text || text.toLowerCase() === 'active') return file;
    if (/^\d+$/.test(text)) return docs[Number(text)] || null;
    return findDocByPath(text);
}

function appActionEditableTarget(selector, allowNonEditable) {
    let el = null;
    if (selector) {
        try {
            el = document.querySelector(String(selector));
        } catch (e) {
            return null;
        }
    } else {
        el = document.activeElement;
    }
    if (!el || el === document.body) return allowNonEditable ? (el || document.body) : null;
    const editable = el.matches && (el.matches('input, textarea') || el.isContentEditable);
    if (!editable && !allowNonEditable) return null;
    return el;
}

// 文档当前文本（含未保存修改）：编辑器在树/代码模式下 getText 会按当前设置序列化
function appActionDocText(doc) {
    if (!doc || doc.binary) return '';
    try {
        if (doc.editor && typeof doc.editor.getText === 'function') return String(doc.editor.getText() || '');
    } catch (e) {}
    return String(doc.content || '');
}

function appActionTermTail(term, maxLines) {
    const buf = term && term.buffer && term.buffer.active;
    if (!buf) return '';
    const end = Number(buf.length) || 0;
    const start = Math.max(0, end - maxLines);
    const lines = [];
    for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
}

async function runAppAction(action, params, scope) {
    const actionScope = scope || 'full';
    const p = params || {};
    switch (String(action || '').trim()) {
        case 'get_state': {
            const aiOpen = !!(aiPanel && aiPanel.isOpen && aiPanel.isOpen());
            return {
                workspace: workspaceFolder || null,
                activeFile: appActionDocInfo(file),
                tabs: docs.map((doc, index) => ({index, ...appActionDocInfo(doc), active: doc === file})),
                closedTabsCount: closedTabs.length,
                sidebar: {visible: !!settings.showSidebar, view: currentSidebarView()},
                terminal: {open: !!(terminalUI && terminalUI.open), view: dockView},
                aiPanel: {
                    open: aiOpen,
                    mode: aiPanel && aiPanel.getMode ? aiPanel.getMode() : '',
                    sessions: aiPanel && aiPanel.bridgeListSessions ? aiPanel.bridgeListSessions() : [],
                },
                theme: settings.theme,
                fullscreen: !!rtFullscreen,
                alwaysOnTop: !!settings.alwaysOnTop,
                readOnlyMode: !!settings.readOnlyMode,
            };
        }
        case 'get_settings': {
            const all = JSON.parse(JSON.stringify(settings));
            const keys = Array.isArray(p.keys) ? p.keys.map((key) => String(key)) : null;
            if (!keys) return {values: all, writableKeys: Object.keys(APP_SETTING_RULES)};
            const values = {};
            const missing = [];
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(all, key)) values[key] = all[key];
                else missing.push(key);
            }
            return {values, missing, writableKeys: Object.keys(APP_SETTING_RULES)};
        }
        case 'get_editor': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            const text = appActionDocText(doc);
            const detail = {
                ...appActionDocInfo(doc),
                path: doc.path || '',
                active: doc === file,
                enc: doc.enc || '',
                eol: doc.eol || '',
                hasBom: !!doc.hasBom,
                size: Number(doc.size) || 0,
                large: !!doc.large,
                binary: !!doc.binary,
                image: !!doc.image,
                untitled: !!doc.untitled,
                treeAvailable: !!doc.treeAvailable,
                parseError: doc.parseError ? String((doc.parseError && doc.parseError.message) || doc.parseError) : '',
                readOnly: !!(settings.readOnlyMode || doc.large || doc.binary),
                lines: doc.binary ? 0 : (text ? text.split('\n').length : 0),
                chars: doc.binary ? 0 : text.length,
                cursor: null,
                selection: null,
            };
            const caret = appActionDocCaret(doc);
            detail.cursor = caret.cursor;
            detail.selection = caret.selection;
            detail.viewport = caret.viewport || null;
            return detail;
        }
        case 'get_content': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (doc.binary) throw new Error('二进制/图片文档没有文本内容；可改用 read_file 读取磁盘文件');
            const text = appActionDocText(doc);
            const allLines = text.split('\n');
            const startLine = Math.max(1, Math.round(Number(p.startLine) || 1));
            const endLine = p.endLine != null && p.endLine !== '' ? Math.max(startLine, Math.round(Number(p.endLine))) : 0;
            const maxChars = Math.max(1000, Math.min(60000, Math.round(Number(p.maxChars) || 20000)));
            let content = endLine ? allLines.slice(startLine - 1, endLine).join('\n') : text;
            let truncated = endLine ? endLine < allLines.length : text.length > maxChars;
            if (content.length > maxChars) {
                content = content.slice(0, maxChars);
                truncated = true;
            }
            return {
                name: doc.name,
                path: doc.path || '',
                dirty: !!doc.dirty,
                totalLines: allLines.length,
                totalChars: text.length,
                startLine,
                endLine: endLine || undefined,
                truncated,
                content,
            };
        }
        case 'get_git': {
            const changes = [];
            for (const [path, state] of gitStateCache.map) changes.push({path, state});
            changes.sort((a, b) => a.path.localeCompare(b.path));
            const counts = {};
            for (const change of changes) counts[change.state] = (counts[change.state] || 0) + 1;
            const activeKey = file && file.path ? String(file.path).replace(/\\/g, '/') : '';
            return {
                available: !!(gitStateCache.available && gitStateCache.dir),
                dir: gitStateCache.dir || '',
                branch: gitStateCache.branch || '',
                reason: gitStateCache.reason || '',
                counts,
                total: changes.length,
                changes: changes.slice(0, 300),
                truncated: changes.length > 300,
                activeFileState: activeKey ? (gitStateCache.map.get(activeKey) || '') : '',
            };
        }
        case 'get_ai': {
            if (!aiPanel) throw new Error('AI 面板未初始化');
            if (aiPanel.bridgeGetState) return aiPanel.bridgeGetState();
            return {open: !!(aiPanel.isOpen && aiPanel.isOpen()), mode: aiPanel.getMode ? aiPanel.getMode() : ''};
        }
        case 'get_explorer': {
            const selection = explorer && explorer.getSelection ? explorer.getSelection() : [];
            return {
                visible: !!settings.showSidebar,
                view: currentSidebarView(),
                mode: explorer && explorer.getMode ? explorer.getMode() : '',
                root: (explorer && explorer.getRoot ? explorer.getRoot() : '') || '',
                selectionCount: selection.length,
                selection: selection.slice(0, 50).map((item) => ({path: item.path, name: item.name, isDir: !!item.isDir})),
            };
        }
        case 'get_plugins': {
            let list;
            try {
                list = await backend.GetPlugins();
            } catch (e) {
                throw new Error('读取插件失败：' + ((e && e.message) || e));
            }
            const plugins = (Array.isArray(list) ? list : []).map((plugin) => ({
                id: plugin.id,
                name: plugin.name,
                version: plugin.version || '',
                author: plugin.author || '',
                description: plugin.description || '',
                enabled: plugin.enabled !== false,
                extensions: Array.isArray(plugin.extensions) ? plugin.extensions : [],
            }));
            return {count: plugins.length, plugins};
        }
        case 'get_terminal': {
            const lines = Math.max(1, Math.min(200, Math.round(Number(p.lines) || 40)));
            const sessions = [];
            for (const session of terminalUI.sessions.values()) {
                sessions.push({
                    id: session.id,
                    label: session.customName || session.defaultLabel || session.baseName || '',
                    shell: session.shell || '',
                    active: session.id === terminalUI.activeId,
                });
            }
            const target = p.id ? terminalUI.sessions.get(String(p.id)) : (terminalUI.sessions.get(terminalUI.activeId) || null);
            return {
                open: !!(terminalUI && terminalUI.open),
                activeId: terminalUI.activeId || '',
                sessions,
                tailSessionId: target ? target.id : '',
                tail: target ? appActionTermTail(target.term, lines) : '',
            };
        }
        case 'open_file': {
            const target = String(p.path || '').trim();
            if (!target) throw new Error('open_file 需要 path');
            await openPathsHere([target]);
            const doc = findDocByPath(target);
            if (!doc) throw new Error('打开失败或文件不存在：' + target);
            return {opened: appActionDocInfo(doc), tabs: docs.length};
        }
        case 'open_folder': {
            const dir = String(p.dir || '').trim();
            if (!dir) throw new Error('open_folder 需要 dir');
            openFolderWorkspace(dir);
            return {workspace: workspaceFolder || dir};
        }
        case 'activate_tab': {
            const doc = appActionResolveDoc(p.index != null ? p.index : p.path);
            if (!doc) throw new Error('找不到标签：' + (p.index != null ? p.index : p.path));
            await activateDoc(doc);
            return {active: appActionDocInfo(file)};
        }
        case 'close_tab': {
            const target = p.target == null ? 'active' : p.target;
            if (target === 'all') {
                closeDocsWithConfirm(docs.slice(), '关闭全部标签页？未保存的修改将丢弃。');
                return {closing: 'all', count: docs.length};
            }
            if (target === 'unmodified') {
                const list = docs.filter((doc) => !doc.dirty);
                closeDocsWithConfirm(list.slice(), '关闭全部未修改标签页？');
                return {closing: 'unmodified', count: list.length};
            }
            const doc = appActionResolveDoc(target);
            if (!doc) throw new Error('找不到标签：' + target);
            const info = appActionDocInfo(doc);
            requestCloseDoc(doc);
            return {closing: info, note: info.dirty ? '该标签有未保存修改，已弹出确认框等待用户选择' : '已关闭'};
        }
        case 'reopen_closed_tab': {
            reopenClosedTab();
            return {active: appActionDocInfo(file)};
        }
        case 'move_tab': {
            const src = appActionResolveDoc(p.source);
            const dst = appActionResolveDoc(p.target);
            if (!src || !dst) throw new Error('move_tab 需要 source 与 target（索引或路径）');
            if (src === dst) throw new Error('source 与 target 是同一标签');
            const group = groupOfDoc(src.id);
            if (!group || !group.docIds.includes(dst.id)) throw new Error('两个标签不在同一分栏，无法移动');
            moveTabInGroup(group.id, src.id, dst.id, p.before !== false);
            return {order: groupDocs(group).map((doc) => doc.name)};
        }
        case 'set_view': {
            const mode = String(p.mode || '').trim();
            if (!mode) throw new Error('set_view 需要 mode');
            if (!file || !editor) throw new Error('当前没有打开的文件');
            switchMode(mode);
            return {activeFile: appActionDocInfo(file), mode: file.mode || currentMode};
        }
        case 'goto_line': {
            const line = Math.round(Number(p.line));
            if (!line || line < 1) throw new Error('goto_line 需要正整数 line');
            if (!file) throw new Error('当前没有打开的文件');
            if (file.binary) throw new Error('当前文档是二进制或图片文件，没有行号可定位');
            const column = Math.max(0, Math.round(Number(p.column) || 0));
            const landed = await selectLineInDoc(file, line, column);
            if (!landed) throw new Error('当前文档不支持按行定位（该视图没有行号）');
            const result = {file: file.name, line: landed.line, column: landed.column};
            if (landed.clamped) {
                result.requestedLine = landed.requestedLine;
                if (landed.requestedColumn && landed.requestedColumn !== landed.column) {
                    result.requestedColumn = landed.requestedColumn;
                }
                result.note = '请求位置超出范围（共 ' + landed.lineCount + ' 行），已定位到第 ' + landed.line + ' 行';
            }
            return result;
        }
        case 'toggle_sidebar': {
            toggleSidebarView(['files', 'git', 'structure', 'chats'].includes(p.view) ? p.view : settings.sidebarView || 'files');
            return {sidebar: {visible: !!settings.showSidebar, view: currentSidebarView()}};
        }
        case 'set_sidebar_view': {
            if (!['files', 'git', 'structure'].includes(p.view)) throw new Error('set_sidebar_view 需要 view = files / git / structure');
            switchSidebarView(p.view);
            if (!settings.showSidebar) {
                settings.showSidebar = true;
                applySettings();
            }
            return {sidebar: {visible: !!settings.showSidebar, view: currentSidebarView()}};
        }
        case 'toggle_terminal': {
            toggleDockView('terminal');
            return {terminal: {open: !!(terminalUI && terminalUI.open), view: dockView}};
        }
        case 'open_browser_tab': {
            const doc = openBrowserTab(p.url || 'about:blank', p.profileKey || '');
            return {browserTab: {id: doc.id, name: doc.name, url: doc.browserUrl}};
        }
        case 'close_browser_tab': {
            const target = docs.find((d) => d.browser && (d.id === p.id || d.name === p.name || d.browserUrl === p.url));
            if (!target) throw new Error('未找到浏览器标签页');
            closeDocNow(target, false);
            return {closed: true};
        }
        case 'toggle_ai_panel': {
            if (!aiPanel) throw new Error('AI 面板未初始化');
            if (p.open == null) aiPanel.toggle();
            else aiPanel.open(!!p.open);
            return {aiPanel: {open: !!(aiPanel.isOpen && aiPanel.isOpen())}};
        }
        case 'toggle_fullscreen': {
            await toggleFullscreen();
            return {fullscreen: !!rtFullscreen};
        }
        case 'toggle_always_on_top': {
            toggleAlwaysOnTop();
            return {alwaysOnTop: !!settings.alwaysOnTop};
        }
        case 'set_theme': {
            if (!p.theme) throw new Error('set_theme 需要 theme');
            setTheme(String(p.theme));
            return {theme: settings.theme};
        }
        case 'open_settings': {
            openSettings(p.pane ? String(p.pane) : 'general');
            return {opened: true, pane: p.pane || 'general'};
        }
        case 'set_setting': {
            const key = String(p.key || '').trim();
            const rule = APP_SETTING_RULES[key];
            if (!rule) {
                throw new Error('不支持设置「' + key + '」。可写键：' + Object.keys(APP_SETTING_RULES).join(', '));
            }
            let value = p.value;
            if (rule.type === 'bool') {
                value = !!value;
            } else if (rule.type === 'number') {
                value = Math.round(Number(value));
                if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
                    throw new Error(key + ' 需要数字 ' + rule.min + '–' + rule.max);
                }
            } else if (rule.type === 'enum') {
                const num = Number(value);
                const match = rule.values.some((v) => v === value) || (typeof value === 'string' && value !== '' && rule.values.includes(num));
                if (!match) throw new Error(key + ' 仅支持：' + rule.values.join(' / '));
                value = typeof rule.values[0] === 'number' ? num : value;
            } else if (rule.type === 'theme') {
                value = String(value || '').trim();
                if (!value) throw new Error('theme 不能为空');
            }
            if (key === 'theme') {
                setTheme(value);
                return {key, value: settings.theme};
            }
            settings[key] = value;
            applySettings();
            return {key, value: settings[key]};
        }
        case 'get_activity': {
            // 操作留痕只读查询：帮用户回忆「刚才做了什么」与排障。
            if (!backend.ActivityRead) throw new Error('当前版本不支持操作记录');
            const query = {
                limit: Math.min(500, Math.max(1, Math.round(Number(p.limit) || 50))),
                sinceTs: Number(p.sinceTs) || 0,
                beforeTs: Number(p.beforeTs) || 0,
                actions: Array.isArray(p.actions) ? p.actions.filter((a) => typeof a === 'string' && a) : [],
                actor: String(p.actor || ''),
                keyword: String(p.keyword || ''),
            };
            let parsed;
            try {
                parsed = JSON.parse(await backend.ActivityRead(JSON.stringify(query)));
            } catch (e) {
                throw new Error('操作记录读取失败：' + ((e && e.message) || e));
            }
            const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
            if (!entries.length) {
                return '最近没有匹配的操作记录（功能开关在 设置 → 操作记录；仅记录操作摘要，不记录内容）';
            }
            const lines = entries.map((entry) => {
                const time = new Date(entry.ts || 0).toLocaleTimeString();
                const target = entry.target ? ' → ' + entry.target : '';
                const detail = entry.detail && Object.keys(entry.detail).length ? ' ' + JSON.stringify(entry.detail) : '';
                return '[' + time + '] ' + (entry.actor || '?') + '/' + (entry.source || '?') + ' ' +
                    (entry.action || '?') + target + detail;
            });
            return lines.join('\n') + (parsed.truncated ? '\n（结果超出上限被截断；可用 limit / sinceTs / keyword 缩小范围）' : '');
        }
        case 'ai_new_session': {
            if (!aiPanel || !aiPanel.bridgeNewSession) throw new Error('AI 面板未初始化');
            const session = await aiPanel.bridgeNewSession({title: p.title, message: p.message});
            return {created: session, note: p.message ? '已在新会话发送消息（真实触发一次模型调用）' : '已创建空会话'};
        }
        case 'ai_switch_session': {
            if (!aiPanel || !aiPanel.bridgeSwitchSession) throw new Error('AI 面板未初始化');
            const session = aiPanel.bridgeSwitchSession(p.id);
            if (!session) throw new Error('找不到会话：' + p.id);
            return {switched: session};
        }
        case 'flash': {
            const message = String(p.message || '').trim();
            if (!message) throw new Error('flash 需要 message');
            flash(message, !!p.isError);
            return {shown: true};
        }
        case 'refresh_explorer': {
            if (explorer && explorer.refresh) explorer.refresh();
            return {refreshed: true};
        }
        case 'type_text': {
            // 模拟键盘输入（仅完全权限档）：输入到焦点元素或 target 选择器匹配的输入框
            if (actionScope !== 'full') throw new Error('type_text 需要「完全权限」权限档');
            const text = String(p.text == null ? '' : p.text);
            if (!text) throw new Error('type_text 需要 text');
            const target = appActionEditableTarget(p.target);
            if (!target) throw new Error('找不到可输入目标：先聚焦输入框，或用 target 传选择器');
            target.focus();
            let ok = false;
            try {
                ok = document.execCommand('insertText', false, text);
            } catch (e) {}
            if (!ok) {
                if (typeof target.selectionStart === 'number') {
                    target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
                } else {
                    target.value += text;
                }
                target.dispatchEvent(new Event('input', {bubbles: true}));
            }
            return {typed: text.length, target: target.id || target.name || 'activeElement'};
        }
        case 'press_key': {
            // 模拟按键（仅完全权限档）：派发 keydown/keyup 并冒泡，可触发对话框确认、Esc 关闭、全局快捷键等
            if (actionScope !== 'full') throw new Error('press_key 需要「完全权限」权限档');
            const key = String(p.key || '').trim();
            if (!key) throw new Error('press_key 需要 key（如 Enter / Escape / F3 / a）');
            const target = appActionEditableTarget(p.target, true) || document.activeElement || document.body;
            target.focus && target.focus();
            const init = {key, bubbles: true, cancelable: true};
            target.dispatchEvent(new KeyboardEvent('keydown', init));
            target.dispatchEvent(new KeyboardEvent('keyup', init));
            return {dispatched: key, target: target.id || target.name || target.tagName || 'body'};
        }
        case 'screenshot': {
            // 截取应用主窗口（含 WebView2 与内嵌浏览器）；由 ai-panel 转成图片消息附加给模型
            if (!backend.CaptureAppScreenshot) throw new Error('截图通道不可用（请重新构建或更新应用）');
            const image = await backend.CaptureAppScreenshot();
            if (!image || image.length < 50) throw new Error('截图数据为空');
            return {image, mime: 'image/png', name: '应用截图'};
        }
        default:
            throw new Error('未知动作「' + action + '」');
    }
}

window.__lens = {
    get editor() { return editor; },
    get file() { return file; },
    get docs() { return docs; },
    get currentMode() { return currentMode; },
    get explorer() { return explorer; },
    get structurePanel() { return structurePanel; },
    get terminalUI() { return terminalUI; },
    get closedTabs() { return closedTabs; },
    openCloseConfirm,
    openPaths,
    openTargets,
    openFolderWorkspace,
    reopenClosedTab,
    setTheme,
    runAppAction,
};
let dirty = false;
let currentMode = 'tree';
let flashTimer = 0;
let readingMode = null;

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
    {id: 'harness', name: 'Harness', group: 'harness', bg: '#ffffff', accent: '#4d6bfe'},
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
    // 代码语言组（formats.js 里与 text 拆开）：indent/view 为该组默认值
    {id: 'python', name: 'Python', indent: '4', view: 'code'},
    {id: 'golang', name: 'Go', indent: 'tab', view: 'code'},
    {id: 'web', name: 'Web 前端', indent: '2', view: 'code'},
    {id: 'clang', name: 'C/C++', indent: '4', view: 'code'},
    {id: 'jvm', name: 'Java/Kotlin/C#', indent: '4', view: 'code'},
    {id: 'shell', name: 'Shell/Batch', indent: '4', view: 'code'},
    {id: 'script', name: 'Ruby/PHP/Lua 等', indent: '4', view: 'code'},
    {id: 'sql', name: 'SQL', indent: '4', view: 'code'},
    {id: 'text', name: '纯文本', view: 'code'},
];

function allFormatDefs() {
    return formatDefs.concat(pluginFormats.map((f) => ({id: f.id, name: f.name})));
}

function defaultFormatSettings() {
    return Object.fromEntries(formatDefs.map((f) => [f.id, {
        encoding: 'auto',
        indent: f.indent || '2',
        eol: 'follow',
        view: f.id === 'csv' ? 'table' : f.id === 'markdown' ? 'preview' : f.view || 'tree',
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
    mdScrollSync: true,
    mdPreviewWidth: '0',
    aiFullscreenWidth: 'auto',
    autoCheckUpdate: true,
    structureExportLineNums: false,
    langEnv: {},
    treeExpandDefault: 'expand',
    showBanners: true,
    readOnlyMode: false,
    theme: 'dark',
    uiFont: 'inter',
    uiCjkFont: 'auto',
    editorFontFamily: 'jetbrains',
    editorCjkFont: 'auto',
    splitRatio: 0.5,
    aiPanelOpen: false,
    aiPanelWidth: 380,
    aiFloatMode: 'dock',
    aiSendKey: 'enter',
    aiChatFont: 13,
    aiChatFontEn: 'follow',
    aiChatFontCjk: 'follow',
    aiChatCodeFont: 'follow',
    aiShowThinking: true,
    aiShowUsage: false,
    aiAssistantCard: false,
    aiInlineWidgets: true,
    aiMaxSessions: 50,
    aiInjectContext: true,
    aiInjectRoot: true,
    aiInjectActiveFile: true,
    aiInjectCaret: true,
    aiInjectViewport: true,
    aiInjectOpenFiles: true,
    aiInjectAgentsMd: true,
    aiInjectMemory: true,
    aiInjectSkills: true,
    aiInjectPreferences: true,
    aiInjectEnvVars: true,
    writingMode: false,
    writingFont: 'kaiti',
    writingFontSize: 16,
    writingPaper: 'off',
    writingLineNumbers: false,
    writingTypewriter: true,
    writingFocus: true,
    writingDailyGoal: 0,
    formatSettings: defaultFormatSettings(),
    // 阅读模式（docs/finished-plans/reading-mode.md §14.1）
    readingFont: 'songti',
    readingFontSize: 19,
    readingLineHeight: 1.9,
    readingPageWidth: 42,
    readingParagraphGap: 0.6,
    readingIndent: false,
    readingTheme: 'auto',
    readingJoinSoftLines: true,
    readingContinuous: false,
    readingPaged: false,
    readingTocDepth: 2,
    readingRestoreSession: true,
    readingTtsRate: 1,
    readingTtsAutoNext: true,
    // 操作留痕（docs/unfinished-plans/operation-audit-log.md）
    activityLog: true,
    activityRetentionMonths: 12,
};
let settings = JSON.parse(JSON.stringify(defaultSettings));
try {
    const stored = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    settings = {...settings, ...stored};
    settings.formatSettings = {...defaultFormatSettings(), ...(stored.formatSettings || {})};
    for (const f of formatDefs) {
        settings.formatSettings[f.id] = {...defaultFormatSettings()[f.id], ...(settings.formatSettings[f.id] || {})};
    }
    const fineInjectKeys = ['aiInjectRoot', 'aiInjectActiveFile', 'aiInjectCaret', 'aiInjectViewport', 'aiInjectOpenFiles',
        'aiInjectMemory', 'aiInjectSkills', 'aiInjectPreferences'];
    if (stored.aiInjectContext === false && !fineInjectKeys.some((key) => Object.prototype.hasOwnProperty.call(stored, key))) {
        for (const key of fineInjectKeys) settings[key] = false;
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
if (!['files', 'git', 'structure', 'chats'].includes(settings.sidebarView)) settings.sidebarView = 'files';
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
settings.mdScrollSync = settings.mdScrollSync !== false;
settings.writingMode = !!settings.writingMode;
if (!WRITING_FONTS.some((f) => f.id === settings.writingFont)) settings.writingFont = 'kaiti';
settings.writingFontSize = Math.min(22, Math.max(12, Number(settings.writingFontSize) || 16));
if (!WRITING_PAPERS.some((p) => p.id === settings.writingPaper)) settings.writingPaper = 'off';
settings.writingLineNumbers = !!settings.writingLineNumbers;
settings.writingTypewriter = settings.writingTypewriter !== false;
settings.writingFocus = settings.writingFocus !== false;
settings.writingDailyGoal = Math.max(0, Number(settings.writingDailyGoal) || 0);
if (!['0', '720', '860', '920', '1100', '1300'].includes(String(settings.mdPreviewWidth))) settings.mdPreviewWidth = '0';
if (!['auto', '0', '720', '860', '920', '1100', '1300'].includes(String(settings.aiFullscreenWidth))) settings.aiFullscreenWidth = 'auto';
if (settings.aiWidthAutoDefaultMigrated !== true) {
    // 旧版默认是「跟随」；自动模式引入后，未显式选过固定宽度的用户迁到新默认
    if (String(settings.aiFullscreenWidth) === '0') settings.aiFullscreenWidth = 'auto';
    settings.aiWidthAutoDefaultMigrated = true;
}
settings.autoCheckUpdate = settings.autoCheckUpdate !== false;
// 一次性迁移：曾以 920px 作为出厂默认被写入本地存储，改为新的默认值“自适应”
if (settings.mdPreviewWidth === '920' && settings.mdWidthMigrated !== true) {
    settings.mdPreviewWidth = '0';
    settings.mdWidthMigrated = true;
}
settings.structureExportLineNums = !!settings.structureExportLineNums;
if (!settings.langEnv || typeof settings.langEnv !== 'object') settings.langEnv = {};
settings.splitRatio = Number(settings.splitRatio);
if (!Number.isFinite(settings.splitRatio)) settings.splitRatio = 0.5;
settings.splitRatio = Math.min(0.85, Math.max(0.15, settings.splitRatio));
settings.treeExpandDefault = settings.treeExpandDefault === 'collapse' ? 'collapse' : 'expand';
settings.showBanners = settings.showBanners !== false;
settings.readOnlyMode = !!settings.readOnlyMode;
if (!['always', 'hover', 'none'].includes(settings.tabCloseMode)) settings.tabCloseMode = 'always';
settings.dblClickClose = !!settings.dblClickClose;
settings.shiftClickClose = settings.shiftClickClose !== false;
settings.sidebarFont = Number(settings.sidebarFont);
if (!Number.isFinite(settings.sidebarFont)) settings.sidebarFont = 12.5;
settings.sidebarFont = Math.min(20, Math.max(10, settings.sidebarFont));
settings.aiPanelOpen = !!settings.aiPanelOpen;
settings.aiPanelWidth = Math.min(640, Math.max(280, Number(settings.aiPanelWidth) || 380));
settings.aiFloatMode = ['dock', 'fullscreen'].includes(settings.aiFloatMode) ? settings.aiFloatMode : 'dock';
// AI 面板停靠侧（dock 分屏模式下与内容区互换左右）
settings.aiPanelSide = settings.aiPanelSide === 'left' ? 'left' : 'right';
settings.aiSendKey = settings.aiSendKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
settings.aiChatFont = Math.min(32, Math.max(10, Number(settings.aiChatFont) || 13));
for (const key of ['aiChatFontEn', 'aiChatFontCjk', 'aiChatCodeFont']) {
    if (typeof settings[key] !== 'string' || !settings[key]) settings[key] = 'follow';
}
settings.aiShowThinking = settings.aiShowThinking !== false;
settings.aiShowUsage = settings.aiShowUsage === true;
settings.aiAssistantCard = settings.aiAssistantCard === true;
// AI 回答里把 svg / html 围栏渲染成可视化卡片（默认开；关闭后按普通代码块显示）
settings.aiInlineWidgets = settings.aiInlineWidgets !== false;
settings.aiMaxSessions = Math.min(500, Math.max(2, Number(settings.aiMaxSessions) || 50));
settings.aiInjectContext = settings.aiInjectContext !== false;
for (const key of ['aiInjectRoot', 'aiInjectActiveFile', 'aiInjectCaret', 'aiInjectViewport', 'aiInjectOpenFiles',
    'aiInjectAgentsMd', 'aiInjectMemory', 'aiInjectSkills', 'aiInjectPreferences', 'aiInjectEnvVars']) {
    settings[key] = settings[key] !== false;
}
// 阅读模式设置归一化（§14.1）
if (!['songti', 'kaiti', 'yahei', 'dengxian', 'system'].includes(settings.readingFont)) settings.readingFont = 'songti';
settings.readingFontSize = Math.min(28, Math.max(16, Number(settings.readingFontSize) || 19));
settings.readingLineHeight = Math.min(2.2, Math.max(1.6, Number(settings.readingLineHeight) || 1.9));
settings.readingPageWidth = Math.min(56, Math.max(32, Number(settings.readingPageWidth) || 42));
settings.readingParagraphGap = Math.min(1.2, Math.max(0, Number(settings.readingParagraphGap) || 0.6));
settings.readingIndent = !!settings.readingIndent;
if (!['auto', 'paper', 'sepia', 'light', 'dark'].includes(settings.readingTheme)) settings.readingTheme = 'auto';
settings.readingJoinSoftLines = settings.readingJoinSoftLines !== false;
settings.readingContinuous = !!settings.readingContinuous;
settings.readingPaged = !!settings.readingPaged;
settings.readingTocDepth = Math.min(4, Math.max(1, Number(settings.readingTocDepth) || 2));
settings.readingRestoreSession = settings.readingRestoreSession !== false;
settings.readingTtsRate = Math.min(2, Math.max(0.5, Number(settings.readingTtsRate) || 1));
settings.readingTtsAutoNext = settings.readingTtsAutoNext !== false;
if (!settings.csvTableMigrated) {
    settings.formatSettings.csv.view = 'table';
    settings.csvTableMigrated = true;
}
if (!['table', 'tree', 'text'].includes(settings.formatSettings.csv.view)) {
    settings.formatSettings.csv.view = 'table';
}
if (!['split', 'preview', 'code', 'text'].includes(settings.formatSettings.markdown.view)) {
    settings.formatSettings.markdown.view = 'preview';
}

// ===== 操作留痕（docs/unfinished-plans/operation-audit-log.md）=====
// 只记状态改变类操作摘要；文件正文/剪贴板/密钥永不落盘，开关在设置 → 操作记录。
const activityLog = createActivityLog({
    backend,
    settings: () => settings,
    relativize: (p) => actRel(p),
});

// actRel 工作区内转相对路径（正斜杠）；工作区外保留用户主动打开的绝对路径。
function actRel(path) {
    const raw = String(path || '');
    if (!raw) return '';
    try {
        const root = workspaceFolder || (explorer && explorer.getRoot ? explorer.getRoot() : '');
        if (root) {
            const rel = relativePathFrom(raw, root);
            if (rel) return rel;
        }
    } catch (e) {}
    return raw;
}

// 设置变更留痕：与上次 applySettings 的快照对比；逐键记 ≤8 条，超出合并为一条汇总。
let lastSettingsSnapshot = null;

function diffSettingsForLog(prev, next) {
    const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
    const changed = [];
    for (const key of keys) {
        const before = prev ? prev[key] : undefined;
        if (Object.is(before, next[key]) && typeof before === typeof next[key]) continue;
        if (JSON.stringify(before) === JSON.stringify(next[key])) continue;
        changed.push({key, from: before, to: next[key]});
    }
    return changed;
}

function logSettingsChange(snapshot) {
    if (lastSettingsSnapshot === null) return;
    const changed = diffSettingsForLog(lastSettingsSnapshot, snapshot);
    if (changed.length === 1) {
        activityLog.log('settings.change', changed[0].key, {from: changed[0].from, to: changed[0].to});
    } else if (changed.length > 1 && changed.length <= 8) {
        for (const item of changed) {
            activityLog.log('settings.change', item.key, {from: item.from, to: item.to});
        }
    } else if (changed.length > 8) {
        activityLog.log('settings.change', '', {count: changed.length, keys: changed.map((c) => c.key).join(',')});
    }
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
    mdScrollSync: document.getElementById('opt-md-scroll-sync'),
    settingsSearch: document.getElementById('settings-search'),
    settingsSearchResults: document.getElementById('settings-search-results'),
    mdPreviewWidth: document.getElementById('opt-md-preview-width'),
    autoCheckUpdate: document.getElementById('opt-auto-update'),
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
    writingMode: document.getElementById('opt-writing-mode'),
    writingFont: document.getElementById('opt-writing-font'),
    writingFontSize: document.getElementById('opt-writing-size'),
    writingFontSizeVal: document.getElementById('opt-writing-size-val'),
    writingPaper: document.getElementById('opt-writing-paper'),
    writingLineNumbers: document.getElementById('opt-writing-line-numbers'),
    writingTypewriter: document.getElementById('opt-writing-typewriter'),
    writingFocus: document.getElementById('opt-writing-focus'),
    writingDailyGoal: document.getElementById('opt-writing-goal'),
    aiChatFontEn: document.getElementById('ai-opt-chatfont-en'),
    aiChatFontCjk: document.getElementById('ai-opt-chatfont-cjk'),
    aiChatCodeFont: document.getElementById('ai-opt-chatfont-code'),
    fileAssoc: document.getElementById('opt-file-assoc'),
    contextMenu: document.getElementById('opt-context-menu'),
    agentSkill: document.getElementById('opt-agent-skill'),
    skillDirs: document.getElementById('opt-skill-dirs'),
    exePath: document.getElementById('opt-exe-path'),
    refreshIntegration: document.getElementById('opt-refresh-integration'),
    developerMode: document.getElementById('opt-developer-mode'),
    openLogs: document.getElementById('opt-open-logs'),
    logPath: document.getElementById('opt-log-path'),
    activityLog: document.getElementById('opt-activity-log'),
    activityRetention: document.getElementById('opt-activity-retention'),
    openActivity: document.getElementById('opt-open-activity'),
    exportActivityJson: document.getElementById('opt-export-activity-json'),
    exportActivityCsv: document.getElementById('opt-export-activity-csv'),
    clearActivity: document.getElementById('opt-clear-activity'),
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
fillFontSelect(elsSettings.aiChatFontEn, [
    {id: 'follow', name: '跟随界面英文字体'},
    ...uiFonts.map((f) => ({id: 'ui:' + f.id, name: f.name})),
    ...editorFonts.map((f) => ({id: 'mono:' + f.id, name: f.name + '（等宽）'})),
]);
fillFontSelect(elsSettings.aiChatFontCjk, [
    {id: 'follow', name: '跟随界面中文字体'},
    ...cjkFonts.map((f) => ({id: 'cjk:' + f.id, name: f.name})),
]);
fillFontSelect(elsSettings.aiChatCodeFont, [
    {id: 'follow', name: '跟随编辑器字体'},
    ...editorFonts.map((f) => ({id: 'mono:' + f.id, name: f.name})),
]);

const elsDialogs = {
    mask: document.getElementById('dialog-mask'),
    settings: document.getElementById('dlg-settings'),
    confirm: document.getElementById('dlg-confirm'),
    confirmText: document.getElementById('dlg-confirm-text'),
    confirmOk: document.getElementById('btn-discard'),
    conflict: document.getElementById('dlg-save-conflict'),
    conflictText: document.getElementById('dlg-save-conflict-text'),
    conflictReload: document.getElementById('btn-conflict-reload'),
    conflictOverwrite: document.getElementById('btn-conflict-overwrite'),
    conflictCancel: document.getElementById('btn-conflict-cancel'),
    name: document.getElementById('dlg-name'),
    nameTitle: document.getElementById('dlg-name-title'),
    nameLabel: document.getElementById('dlg-name-label'),
    nameInput: document.getElementById('dlg-name-input'),
    nameError: document.getElementById('dlg-name-error'),
    nameOk: document.getElementById('btn-name-ok'),
    goto: document.getElementById('dlg-goto'),
    gotoInput: document.getElementById('dlg-goto-input'),
    gotoError: document.getElementById('dlg-goto-error'),
    props: document.getElementById('dlg-props'),
    propsGrid: document.getElementById('dlg-props-grid'),
    update: document.getElementById('dlg-update'),
    updateStatus: document.getElementById('dlg-update-status'),
    updateNotes: document.getElementById('dlg-update-notes'),
    updateDownload: document.getElementById('btn-update-download'),
    updatePage: document.getElementById('btn-update-page'),
    writing: document.getElementById('dlg-writing'),
    writingToday: document.getElementById('dlg-writing-today'),
    writingSession: document.getElementById('dlg-writing-session'),
    writingSpeed: document.getElementById('dlg-writing-speed'),
    writingTotal: document.getElementById('dlg-writing-total'),
    writingGoalBar: document.getElementById('dlg-writing-goalbar'),
    writingGoalFill: document.getElementById('dlg-writing-goalfill'),
    writingGoalInput: document.getElementById('dlg-writing-goal-input'),
    writingName: document.getElementById('dlg-writing-name'),
    writingNameText: document.getElementById('dlg-writing-name-text'),
    writingNameGender: document.getElementById('opt-writing-name-gender'),
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
    if (file && currentMode === 'preview' && doc && false) {}
    if (file && currentMode === 'preview') renderMarkdownPreview(file);
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
    const mdWidth = String(settings.mdPreviewWidth || '0');
    document.documentElement.style.setProperty('--md-preview-max', mdWidth === '0' ? 'none' : mdWidth + 'px');
    const aiWidth = String(settings.aiFullscreenWidth || 'auto');
    document.documentElement.style.setProperty('--ai-fullscreen-width',
        aiWidth === 'auto' ? 'min(100%, 920px)' : (aiWidth === '0' ? '100%' : aiWidth + 'px'));
    updateAiWidthWidget();
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
    // AI 面板停靠侧（dock 分屏与内容区互换；ai-panel.js 的 applyPanelSide 同步按钮态）
    const topRowEl = document.getElementById('top-row');
    if (topRowEl) topRowEl.classList.toggle('ai-left', settings.aiPanelSide === 'left');
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
    elsSettings.mdScrollSync.checked = settings.mdScrollSync !== false;
    elsSettings.mdPreviewWidth.value = String(settings.mdPreviewWidth);
    elsSettings.autoCheckUpdate.checked = settings.autoCheckUpdate !== false;
    if (elsSettings.treeExpand) elsSettings.treeExpand.value = settings.treeExpandDefault;
    elsSettings.showBanners.checked = !!settings.showBanners;
    elsSettings.openMode.value = settings.openMode;
    if (elsSettings.activityLog) elsSettings.activityLog.checked = settings.activityLog !== false;
    if (elsSettings.activityRetention) elsSettings.activityRetention.value = String(settings.activityRetentionMonths || 12);
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
    if (aiPanel && typeof aiPanel.applySettings === 'function') {
        try { aiPanel.applySettings(); } catch (e) {}
    }
    elsSettings.uiFont.value = uiFace.id;
    elsSettings.uiCjkFont.value = uiCjk.id;
    elsSettings.editorFontFamily.value = editorFace.id;
    elsSettings.editorCjkFont.value = editorCjk.id;
    elsSettings.writingMode.checked = !!settings.writingMode;
    elsSettings.writingFont.value = settings.writingFont;
    elsSettings.writingFontSize.value = String(settings.writingFontSize);
    elsSettings.writingFontSizeVal.textContent = String(settings.writingFontSize);
    elsSettings.writingPaper.value = settings.writingPaper;
    elsSettings.writingLineNumbers.checked = !!settings.writingLineNumbers;
    elsSettings.writingTypewriter.checked = settings.writingTypewriter !== false;
    elsSettings.writingFocus.checked = settings.writingFocus !== false;
    elsSettings.writingDailyGoal.value = String(settings.writingDailyGoal || 0);
    if (editor && editor.aceEditor) {
        try {
            editor.aceEditor.setFontSize(settings.editorFont);
        } catch (e) {}
    }
    applyCodeWrap();
    applyCodeGuides();
    applyAlwaysOnTop();
    applyReadOnlyMode();
    applyWritingMode();
    if (aiPanel && aiPanel.applySettings) {
        try { aiPanel.applySettings(); } catch (e) {}
    }
    if (readingMode) {
        try { readingMode.applyReadingSettings(); } catch (e) {}
    }
    try {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
    } catch (e) {}
    // 设置变更留痕：首次调用（启动恢复）只建快照，不记变更。
    try {
        logSettingsChange(JSON.parse(JSON.stringify(settings)));
        lastSettingsSnapshot = JSON.parse(JSON.stringify(settings));
    } catch (e) {}
    if (settings.autoSave && dirty && !settings.readOnlyMode) scheduleAutoSave();
    else cancelAutoSave();
}

function openDialogEl(dlg, options) {
    const keepSettings = !!(options && options.keepSettings) &&
        dlg !== elsDialogs.settings &&
        !elsDialogs.settings.classList.contains('hidden');
    elsDialogs.mask.classList.remove('hidden');
    if (!keepSettings) elsDialogs.settings.classList.add('hidden');
    for (const other of [elsDialogs.confirm, elsDialogs.conflict, elsDialogs.name, elsDialogs.goto, elsDialogs.props, elsDialogs.update, elsDialogs.writing, elsDialogs.writingName]) {
        if (other !== dlg) other.classList.add('hidden');
    }
    dlg.dataset.parentSettings = keepSettings ? '1' : '';
    dlg.style.left = '';
    dlg.style.top = '';
    dlg.style.transform = '';
    dlg.classList.remove('hidden');
    syncAllBrowserTabs();
}

function closeTopDialog() {
    if (!elsDialogs.settings.classList.contains('hidden')) {
            for (const dlg of [elsDialogs.confirm, elsDialogs.conflict, elsDialogs.name, elsDialogs.goto, elsDialogs.props, elsDialogs.update, elsDialogs.writing, elsDialogs.writingName]) {
            if (dlg.classList.contains('hidden') || dlg.dataset.parentSettings !== '1') continue;
            dlg.classList.add('hidden');
            if (dlg === elsDialogs.confirm) confirmAction = null;
            if (dlg === elsDialogs.conflict) finishSaveConflict('cancel');
            if (dlg === elsDialogs.name) {
                nameSubmit = null;
                nameBusy = false;
            }
            syncAllBrowserTabs();
            return;
        }
    }
    closeDialogs();
}

function closeDialogs() {
    if (aiPanel && typeof aiPanel.closeModelEditor === 'function') {
        try { aiPanel.closeModelEditor(false); } catch (e) {}
    }
    elsDialogs.mask.classList.add('hidden');
    elsDialogs.settings.classList.add('hidden');
    elsDialogs.confirm.classList.add('hidden');
    if (saveConflictResolve) finishSaveConflict('cancel');
    elsDialogs.conflict.classList.add('hidden');
    elsDialogs.name.classList.add('hidden');
    elsDialogs.goto.classList.add('hidden');
    elsDialogs.props.classList.add('hidden');
    elsDialogs.update.classList.add('hidden');
    elsDialogs.writing.classList.add('hidden');
    elsDialogs.writingName.classList.add('hidden');
    confirmAction = null;
    syncAllBrowserTabs();
    nameSubmit = null;
    nameBusy = false;
}

function selectSettingsPane(pane) {
    resetSettingsSearch();
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
    const langGroup = document.getElementById('snav-langs');
    if (langGroup) {
        const inLangs = String(pane).startsWith('lang-');
        if (inLangs && !langGroup.classList.contains('expanded')) {
            langGroup.classList.add('expanded');
            const parent = langGroup.querySelector('.snav-parent');
            if (parent) parent.setAttribute('aria-expanded', 'true');
        }
    }
    const aiGroup = document.getElementById('snav-ai');
    if (aiGroup) {
        const inAI = pane === 'models' || pane === 'ai' || pane === 'context' || pane === 'preferences' || pane === 'schedules';
        if (inAI && !aiGroup.classList.contains('expanded')) {
            aiGroup.classList.add('expanded');
            const parent = aiGroup.querySelector('.snav-parent');
            if (parent) parent.setAttribute('aria-expanded', 'true');
        }
    }
    if (pane === 'formats') renderFmtTable();
    else if (String(pane).startsWith('fmt-')) renderFormatPane(pane.slice(4));
    else if (String(pane).startsWith('lang-')) renderLangPane(pane.slice(5));
    else if (pane === 'plugins') renderPluginsPane();
    else if (pane === 'envvars') renderEnvVarsPane();
    else if (pane === 'activity') renderActivityPane();
    if (pane === 'ai' || pane === 'models' || pane === 'context' || pane === 'preferences') {
        if (!aiPanel) initAIPanel();
        if (aiPanel && typeof aiPanel.refreshSettings === 'function') {
            try { aiPanel.refreshSettings(); } catch (e) {}
        }
    }
    if (pane === 'schedules') {
        if (!aiPanel) initAIPanel();
        if (aiPanel && typeof aiPanel.refreshScheduleSettings === 'function') {
            try { aiPanel.refreshScheduleSettings(); } catch (e) {}
        }
    }
}

function openSettings(pane = 'general') {
    openDialogEl(elsDialogs.settings);
    resetSettingsSearch();
    selectSettingsPane(pane);
    refreshDeveloperMode();
    refreshLogPath();
    if (pane === 'about') {
        const status = document.getElementById('about-update-status');
        if (status) {
            status.textContent = '';
            status.className = 'about-update-status';
        }
    }
    if (pane === 'integration') syncIntegrationStatus();
}

// ---- 设置搜索：左栏顶部搜索框，跨面板检索设置项并跳转 ----

function buildSettingsSearchIndex() {
    const entries = [];
    const navLabels = {};
    document.querySelectorAll('.snav-item[data-pane]').forEach((b) => {
        navLabels[b.dataset.pane] = (b.textContent || '').trim();
    });
    for (const paneEl of document.querySelectorAll('.settings-pane')) {
        const pane = paneEl.dataset.pane;
        // 动态面板（数据格式 / 编程语言子页）打开前没有内容，跳过，用下面的静态条目兜底
        if (paneEl.classList.contains('hidden') && (pane.startsWith('fmt-') || pane.startsWith('lang-'))) continue;
        for (const row of paneEl.querySelectorAll('.popover-row, .fmt-pane-title, .fmt-pane-sub, .settings-section-title')) {
            const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) entries.push({pane, text, el: row});
        }
    }
    for (const f of allFormatDefs()) {
        entries.push({pane: 'fmt-' + f.id, text: f.name + '：编码 / 缩进 / 保存换行 / 默认视图', el: null});
    }
    for (const l of LANG_DEFS) {
        entries.push({pane: 'lang-' + l.id, text: l.name + '：环境检测（路径 / 版本）', el: null});
        for (const t of l.tools || []) {
            entries.push({pane: 'lang-' + l.id, text: l.name + ' · ' + t.name, el: null});
        }
    }
    return {entries, navLabels};
}

function renderSettingsSearch(query) {
    const box = elsSettings.settingsSearchResults;
    if (!box) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
        box.classList.add('hidden');
        box.textContent = '';
        return;
    }
    const {entries, navLabels} = buildSettingsSearchIndex();
    const hits = [];
    for (const e of entries) {
        const hay = (navLabels[e.pane] || '') + ' ' + e.text;
        if (hay.toLowerCase().includes(q)) hits.push(e);
        if (hits.length >= 12) break;
    }
    box.textContent = '';
    if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'settings-search-empty';
        empty.textContent = '没有匹配的设置';
        box.appendChild(empty);
    } else {
        for (const hit of hits) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'settings-search-item';
            const nav = document.createElement('span');
            nav.className = 'settings-search-nav';
            nav.textContent = navLabels[hit.pane] || hit.pane;
            const text = document.createElement('span');
            text.className = 'settings-search-text';
            text.textContent = hit.text.length > 64 ? hit.text.slice(0, 64) + '…' : hit.text;
            row.append(nav, text);
            row.addEventListener('click', () => {
                box.classList.add('hidden');
                selectSettingsPane(hit.pane);
                if (hit.el && hit.el.isConnected) {
                    hit.el.scrollIntoView({block: 'center'});
                    hit.el.classList.add('settings-hit');
                    setTimeout(() => hit.el.classList.remove('settings-hit'), 1600);
                }
            });
            box.appendChild(row);
        }
    }
    box.classList.remove('hidden');
}

function resetSettingsSearch() {
    if (elsSettings.settingsSearch) elsSettings.settingsSearch.value = '';
    if (elsSettings.settingsSearchResults) {
        elsSettings.settingsSearchResults.classList.add('hidden');
        elsSettings.settingsSearchResults.textContent = '';
    }
}

if (elsSettings.settingsSearch) {
    elsSettings.settingsSearch.addEventListener('input', () => renderSettingsSearch(elsSettings.settingsSearch.value));
    elsSettings.settingsSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            resetSettingsSearch();
            elsSettings.settingsSearch.blur();
        } else if (e.key === 'Enter') {
            const first = elsSettings.settingsSearchResults.querySelector('.settings-search-item');
            if (first) first.click();
        }
    });
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
                elsSettings.skillDirs.innerHTML = skill.targets.map((t) => {
                    const raw = home && t.dir.startsWith(home) ? '~' + t.dir.slice(home.length) : t.dir;
                    const dir = raw.replace(/\\/g, '/');
                    const mark = iconSvg(t.registered ? 'check' : 'circle', 11);
                    return '<span class="skill-dir-state">' + mark + dir + '</span>';
                }).join('');
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
// 保存冲突对话框的 Promise resolver：关闭对话框（按钮 / Esc / 遮罩）一律按取消处理
let saveConflictResolve = null;

function finishSaveConflict(choice) {
    const resolve = saveConflictResolve;
    saveConflictResolve = null;
    elsDialogs.conflict.classList.add('hidden');
    if (!elsDialogs.mask.classList.contains('hidden')) closeTopDialog();
    if (resolve) resolve(choice);
}

function openSaveConflictDialog(doc, deleted) {
    return new Promise((resolve) => {
        saveConflictResolve = resolve;
        const name = (doc && (doc.name || doc.path)) || '文件';
        elsDialogs.conflictText.textContent = deleted
            ? '「' + name + '」已在磁盘上被删除或移动，但编辑器里还有未保存的修改。'
            : '「' + name + '」已被其他程序修改，但编辑器里还有未保存的修改。请选择如何处理：';
        elsDialogs.conflictReload.disabled = !!deleted;
        openDialogEl(elsDialogs.conflict);
    });
}

elsDialogs.conflictReload.addEventListener('click', () => finishSaveConflict('reload'));
elsDialogs.conflictOverwrite.addEventListener('click', () => finishSaveConflict('overwrite'));
elsDialogs.conflictCancel.addEventListener('click', () => finishSaveConflict('cancel'));
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
    openDialogEl(elsDialogs.name, {keepSettings: true});
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
        closeTopDialog();
    } catch (e) {
        nameDialogError((e && e.message) || e);
        nameBusy = false;
        elsDialogs.nameOk.disabled = false;
    }
}

elsDialogs.nameOk.addEventListener('click', submitNameDialog);
document.getElementById('btn-name-cancel').addEventListener('click', closeTopDialog);
elsDialogs.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitNameDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTopDialog();
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

// countWords 字数统计：CJK 字符逐个计 + 拉丁单词计 1（IDEA 风格)
// 对最近一次输入做备忘：updateWordCount 与写作统计同 tick 各调一次，大文本免二次正则
let countWordsCacheText = null;
let countWordsCacheTotal = 0;
function countWords(text) {
    const s = String(text || '');
    if (!s) return 0;
    if (s === countWordsCacheText) return countWordsCacheTotal;
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const latin = (s.match(/[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*/g) || []).length;
    countWordsCacheText = s;
    countWordsCacheTotal = cjk + latin;
    return countWordsCacheTotal;
}

let wordCountTimer = 0;

function updateWordCount() {
    if (!els.stCount) return;
    const show = !!(file && file.editor && !file.binary && !file.large);
    els.stCount.style.display = show ? '' : 'none';
    if (!show) return;
    let sel = 0;
    const ace = file.editor.aceEditor;
    if (ace && !ace.selection.isEmpty()) {
        sel = countWords(ace.getSelectedText());
    } else if (currentMode === 'preview') {
        sel = countWords(String(window.getSelection ? window.getSelection().toString() : ''));
    }
    const total = countWords(file.editor.getText());
    els.stCount.textContent = sel > 0 ? ('选中 ' + sel + ' · 全文 ' + total + ' 字') : ('全文 ' + total + ' 字');
    els.stCount.title = '字数统计（CJK 字符数 + 英文单词数）';
}

function scheduleWordCount() {
    clearTimeout(wordCountTimer);
    wordCountTimer = setTimeout(() => {
        updateWordCount();
        updateWritingStats();
    }, 150);
}

// ===== 写作模式 =====

let writingLastSig = '';
let writingPrevFamily = '';
let writingSwitchWasOn = !!settings.writingMode; // 跟踪总开关本身；视图/文档临时切换不重置「本次」基线
let writingCaretRaf = 0;
let writingCaretTimer = 0;

// 生效条件：总开关开启 + 当前文档为 text/markdown + 处于源码/分屏视图（不满足时样式行为自动退避）
function writingActive() {
    return !!settings.writingMode && !!file && !file.binary && !file.large
        && !!file.format && (file.format.id === 'text' || file.format.id === 'markdown')
        && (currentMode === 'code' || currentMode === 'text' || currentMode === 'split');
}

function editorFontFamilyVar() {
    const editorFace = editorFonts.find((f) => f.id === settings.editorFontFamily) || editorFonts[0];
    const editorCjk = cjkFonts.find((f) => f.id === settings.editorCjkFont) || cjkFonts[0];
    return editorFace.family + ', ' + editorCjk.family + ', monospace';
}

// applyWritingMode：data-writing 属性 + 字体/字号 CSS 变量 + 逐 doc 的 Ace 字号/行号/边距
// 由 applySettings 尾部与 updateStatus（模式/文档切换）调用；签名未变时跳过
function applyWritingMode() {
    // 总开关切换才重置基线（本次/今日从开启时刻起算）；必须放在签名早返回之前，
    // 否则在非生效文档/视图上关→开时 sig 不变，重置被跳过，切回正文仍累计上一轮。
    if (!!settings.writingMode !== writingSwitchWasOn) {
        writingSwitchWasOn = !!settings.writingMode;
        for (const d of docs) {
            delete d._writingBase;
            delete d._writingLast;
        }
    }
    const on = writingActive();
    const paper = on ? (settings.writingPaper || 'off') : 'off';
    const face = on ? (WRITING_FONTS.find((f) => f.id === settings.writingFont) || WRITING_FONTS[0]) : null;
    const size = on ? settings.writingFontSize : settings.editorFont;
    const showLines = on ? !!settings.writingLineNumbers : true;
    const sig = [on ? '1' : '0', paper, face ? face.id : 'follow', size, showLines ? '1' : '0',
        settings.writingFocus ? '1' : '0', settings.writingTypewriter ? '1' : '0',
        file ? (file.path || file.name) : '', currentMode].join('|');
    if (sig === writingLastSig) return;
    writingLastSig = sig;

    const root = document.documentElement;
    if (on) {
        root.dataset.writing = 'on';
        if (paper !== 'off') root.dataset.writingPaper = paper;
        else delete root.dataset.writingPaper;
    } else {
        root.dataset.writing = 'off';
        delete root.dataset.writingPaper;
    }
    // 字体族：只替换 CJK 部分，拉丁保持编辑器主字体；follow = 不改族
    const family = on && face && face.family
        ? (editorFonts.find((f) => f.id === settings.editorFontFamily) || editorFonts[0]).family + ', ' + face.family + ', monospace'
        : editorFontFamilyVar();
    document.documentElement.style.setProperty('--editor-font', size + 'px');
    document.documentElement.style.setProperty('--editor-font-family', family);
    if (!on || !settings.writingFocus) {
        for (const d of docs) clearWritingMarkers(d);
    }

    // 逐 doc 应用 Ace：字号、行号；族/字号变化后必须 resize 重排版，否则光标错位
    const familyChanged = family !== writingPrevFamily;
    writingPrevFamily = family;
    let sizeChanged = false;
    for (const d of docs) {
        const ace = d.editor && d.editor.aceEditor;
        if (!ace) continue;
        try {
            if (ace.getFontSize() !== size) {
                ace.setFontSize(size);
                sizeChanged = true;
            }
            ace.setOption('showLineNumbers', showLines);
        } catch (e) {}
    }
    if (familyChanged || sizeChanged) {
        for (const d of docs) {
            const ace = d.editor && d.editor.aceEditor;
            if (ace) {
                try {
                    ace.renderer.setPadding(on ? 40 : 0);
                    ace.resize();
                } catch (e) {}
            }
        }
    } else {
        for (const d of docs) {
            const ace = d.editor && d.editor.aceEditor;
            if (ace) {
                try { ace.renderer.setPadding(on ? 40 : 0); } catch (e) {}
            }
        }
    }
    if (on) {
        // 开关/视图切换后立即建立统计基线并显示状态栏，不等第一次输入
        updateWritingStats();
        scheduleWritingCaret();
    } else if (els.stWriting) els.stWriting.style.display = 'none';
}

// ---- 专注模式：打字机滚动 + 段落聚焦 ----

// 仅 Ace（code/split 左栏）；text 视图为 textarea，v1 不做打字机/聚焦
function scheduleWritingCaret(aceArg) {
    const doc = file;
    if (!doc || !doc.editor || !writingActive()) return;
    const ace = doc.editor.aceEditor;
    if (!ace) return;
    if (aceArg && aceArg !== ace) return; // 背景文档的事件不作用到当前编辑器
    if (currentMode === 'text' && !doc.splitActive) return;
    if (settings.writingTypewriter) {
        if (writingCaretRaf) cancelAnimationFrame(writingCaretRaf);
        writingCaretRaf = requestAnimationFrame(() => {
            writingCaretRaf = 0;
            writingTypewriterScroll(ace);
        });
    }
    clearTimeout(writingCaretTimer);
    writingCaretTimer = setTimeout(() => writingFocusParagraph(ace), 150);
}

function writingTypewriterScroll(ace) {
    if (!settings.writingTypewriter || !writingActive()) return;
    try {
        const session = ace.session;
        const pos = ace.getCursorPosition();
        const screenRow = session.documentToScreenRow(pos.row, pos.column);
        const lineHeight = Number(ace.renderer.lineHeight) || (() => {
            const el = ace.container.querySelector('.ace_line');
            return el ? parseFloat(getComputedStyle(el).lineHeight) || 20 : 20;
        })();
        const pad = Number(ace.renderer.$padding) || 0;
        const scroller = ace.renderer.scroller;
        const target = pad + screenRow * lineHeight + lineHeight / 2 - (scroller ? scroller.clientHeight : 0) / 2;
        if (Math.abs(session.getScrollTop() - target) > 2) session.setScrollTop(Math.max(0, target));
    } catch (e) {}
}

function writingRangeClass(editor) {
    // vendored Ace 暴露在 window.ace；编辑器实例本身没有 Range/require
    if (editor.Range) return editor.Range;
    const g = window.ace;
    if (g && g.require) {
        try { return g.require('ace/range').Range; } catch (e) {}
    }
    try { return editor.require && editor.require('ace/range').Range || null; } catch (e) { return null; }
}

function clearWritingMarkers(doc) {
    const marks = doc && doc._writingMarkers;
    if (!marks) return;
    doc._writingMarkers = null;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    try {
        if (marks.top) ace.session.removeMarker(marks.top);
        if (marks.bottom) ace.session.removeMarker(marks.bottom);
    } catch (e) {}
}

// 段落聚焦：当前段落外上下两个全行遮罩 marker（inFront，用主题底色半透明盖住实现淡出）
function writingFocusParagraph(ace) {
    const doc = file;
    if (!doc || !doc.editor || doc.editor.aceEditor !== ace) return;
    if (!writingActive() || !settings.writingFocus) {
        clearWritingMarkers(doc);
        return;
    }
    try {
        const session = ace.session;
        const total = session.getLength();
        const row = ace.getCursorPosition().row;
        const emptyLine = (r) => !String(session.getLine(r) || '').trim();
        let paraStart = row;
        while (paraStart > 0 && !emptyLine(paraStart - 1)) paraStart--;
        let paraEnd = row;
        while (paraEnd < total - 1 && !emptyLine(paraEnd + 1)) paraEnd++;
        const marks = doc._writingMarkers;
        if (marks && marks.session === session && marks.paraStart === paraStart && marks.paraEnd === paraEnd) return;
        clearWritingMarkers(doc);
        const Range = writingRangeClass(ace);
        if (!Range) return;
        const top = paraStart > 0
            ? session.addMarker(new Range(0, 0, paraStart - 1, 0), 'writing-dim', 'fullLine', true) : 0;
        const bottom = paraEnd < total - 1
            ? session.addMarker(new Range(paraEnd + 1, 0, total - 1, 0), 'writing-dim', 'fullLine', true) : 0;
        doc._writingMarkers = {top, bottom, paraStart, paraEnd, session};
    } catch (e) {}
}

// ---- 码字统计 ----

const WRITING_DAILY_KEY = 'datalens-writing-daily';
let writingSpeedSamples = []; // {t, chars} 正增量采样

function writingTodayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadWritingDaily() {
    let store = null;
    try {
        store = JSON.parse(localStorage.getItem(WRITING_DAILY_KEY) || 'null');
    } catch (e) {}
    const today = writingTodayStr();
    if (!store || store.date !== today || typeof store.count !== 'number') {
        store = {date: today, count: 0, goalHit: false};
    }
    return store;
}

function saveWritingDaily(store) {
    try {
        localStorage.setItem(WRITING_DAILY_KEY, JSON.stringify(store));
    } catch (e) {}
}

// 挂在字数防抖管线与 updateStatus 上；写作模式生效时累计今日/本次增量
function updateWritingStats() {
    const doc = file;
    const active = writingActive();
    if (!doc || !doc.editor || doc.binary || doc.large) {
        updateWritingStatusBar(0, false);
        return;
    }
    // doc.text 由 markDocDirty 随每次编辑维护，避免再拉一次全文；缺失时兜底 getText
    const total = countWords(doc.text != null ? doc.text : doc.editor.getText());
    if (!active) {
        // 仅清观察基线；_writingBase 保留，切回写作视图时「本次」继续累计
        if (doc._writingLast != null) delete doc._writingLast;
        updateWritingStatusBar(total, false);
        return;
    }
    // 首次观察：只记基线不计增量；其后 delta = 当前全文 − 上次观察
    if (typeof doc._writingLast !== 'number') {
        doc._writingLast = total;
        if (typeof doc._writingBase !== 'number') doc._writingBase = total;
    } else {
        const delta = total - doc._writingLast;
        doc._writingLast = total;
        if (delta !== 0) {
            const store = loadWritingDaily();
            store.count = Math.max(0, store.count + delta);
            const goal = Number(settings.writingDailyGoal) || 0;
            if (goal > 0 && !store.goalHit && store.count >= goal) {
                store.goalHit = true;
                flash('今日目标达成 🎉');
            }
            saveWritingDaily(store);
            if (delta > 0) {
                writingSpeedSamples.push({t: Date.now(), chars: delta});
                if (writingSpeedSamples.length > 600) writingSpeedSamples.splice(0, writingSpeedSamples.length - 600);
            }
        }
    }
    updateWritingStatusBar(total, true);
}

function writingSpeedPerMin() {
    const now = Date.now();
    writingSpeedSamples = writingSpeedSamples.filter((s) => now - s.t <= 5 * 60 * 1000);
    let sum = 0;
    for (const s of writingSpeedSamples) sum += s.chars;
    return Math.round(sum / 5);
}

function writingSessionSum(total) {
    return file && typeof file._writingBase === 'number' ? Math.max(0, total - file._writingBase) : 0;
}

function updateWritingStatusBar(total, active) {
    const el = els.stWriting;
    if (!el) return;
    if (!active) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    const store = loadWritingDaily();
    const goal = Number(settings.writingDailyGoal) || 0;
    const text = '今日 ' + Math.max(0, store.count) + (goal > 0 ? '/' + goal : '') + ' · 本次 +' + writingSessionSum(total);
    if (el.textContent !== text) el.textContent = text;
    el.style.display = '';
}

function openWritingStatsDialog() {
    if (!writingActive() || !file || !file.editor) return;
    const total = countWords(file.editor.getText());
    const store = loadWritingDaily();
    const goal = Number(settings.writingDailyGoal) || 0;
    elsDialogs.writingToday.textContent = String(Math.max(0, store.count));
    elsDialogs.writingSession.textContent = '+' + writingSessionSum(total);
    elsDialogs.writingSpeed.textContent = String(writingSpeedPerMin());
    elsDialogs.writingTotal.textContent = String(total);
    elsDialogs.writingGoalBar.style.display = goal > 0 ? '' : 'none';
    elsDialogs.writingGoalFill.style.width = goal > 0 ? Math.min(100, Math.round(store.count / goal * 100)) + '%' : '0';
    elsDialogs.writingGoalInput.value = goal > 0 ? String(goal) : '';
    openDialogEl(elsDialogs.writing);
}

function saveWritingGoal() {
    const goal = Math.max(0, Number(elsDialogs.writingGoalInput.value) || 0);
    settings.writingDailyGoal = goal;
    const store = loadWritingDaily();
    store.goalHit = goal > 0 && store.count >= goal;
    saveWritingDaily(store);
    applySettings();
    updateWritingStats();
    flash(goal > 0 ? '每日目标已保存：' + goal + ' 字' : '每日目标已关闭');
    openWritingStatsDialog();
}

// ---- 动作：开关 / 一键排版 / 起名器 / 场景分隔符 ----

function toggleWritingMode() {
    settings.writingMode = !settings.writingMode;
    applySettings();
    flash(settings.writingMode ? '写作模式已开启' : '写作模式已关闭');
}

function writingFormatable() {
    return !!file && !!file.editor && !file.binary && !file.large
        && !!file.format && (file.format.id === 'text' || file.format.id === 'markdown');
}

// 一键排版：writing.js 纯函数 transform → setText + markDocDirty
function applyWritingFormat(indent) {
    if (!writingFormatable()) return;
    if (indent && file.format.id !== 'text') return;
    const doc = file;
    const isMd = doc.format.id === 'markdown';
    const res = formatWritingText(doc.editor.getText(), {markdown: isMd, indent: !!indent});
    const parts = [];
    if (res.trailing) parts.push('去 ' + res.trailing + ' 处行尾空白');
    if (res.leading) parts.push('清 ' + res.leading + ' 处行首空白');
    if (res.collapsed) parts.push('收敛 ' + res.collapsed + ' 处空行');
    if (res.indented) parts.push('缩进 ' + res.indented + ' 段');
    if (!parts.length) {
        flash('未发现需要整理的内容');
        return;
    }
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setText(res.text);
        doc.text = res.text;
    } catch (e) {
        flash('排版失败：' + e.message, true);
        return;
    } finally {
        doc.loading = loading;
    }
    markDocDirty(doc);
    // 整页预览模式下底层编辑器仍存活但预览不随 setText 自动刷新，手动重渲染
    if (currentMode === 'preview' && doc.format && doc.format.preview) renderMarkdownPreview(doc);
    // jsoneditor setText 会清空撤销历史（vendor 已确认 history.clear()）
    flash('已整理：' + parts.join('、') + '（撤销历史已重置，可从 Git 历史找回）');
}

function openWritingNameDialog() {
    rollWritingName();
    openDialogEl(elsDialogs.writingName);
}

function rollWritingName() {
    const gender = elsDialogs.writingNameGender.value || 'random';
    elsDialogs.writingNameText.textContent = genName(gender);
}

// code 视图走 ace.insert，text 视图走 textarea setRangeText（同 jumpToPosition 的双路处理）
function insertTextAtCursor(text) {
    if (!file || file.binary || file.large) return false;
    if (file.editor && file.editor.aceEditor && (currentMode === 'code' || (file.splitActive && currentMode === 'split'))) {
        file.editor.aceEditor.insert(text);
        file.editor.aceEditor.focus();
        return true;
    }
    if (currentMode === 'text' && file.pane) {
        const ta = file.pane.querySelector('textarea.jsoneditor-text');
        if (ta) {
            const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
            const end = ta.selectionEnd != null ? ta.selectionEnd : start;
            ta.setRangeText(text, start, end, 'end');
            ta.focus();
            ta.dispatchEvent(new Event('input', {bubbles: true}));
            markDocDirty(file);
            return true;
        }
    }
    return false;
}

function insertWritingName() {
    const name = elsDialogs.writingNameText.textContent || '';
    if (!insertTextAtCursor(name)) flash('当前视图不支持插入，请切换到源码或纯文本视图', true);
    else closeTopDialog();
}

function insertSceneSeparator() {
    if (!insertTextAtCursor(SCENE_SEPARATOR)) flash('当前视图不支持插入，请切换到源码或纯文本视图', true);
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
document.getElementById('btn-goto-cancel').addEventListener('click', closeTopDialog);
elsDialogs.gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitGotoDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTopDialog();
    }
});
if (els.stPos) {
    els.stPos.addEventListener('click', () => {
        if ((currentMode === 'code' || currentMode === 'text') && file) openGotoDialog();
    });
}

// 写作模式：状态栏入口与对话框按钮
if (els.stWriting) els.stWriting.addEventListener('click', openWritingStatsDialog);
document.getElementById('btn-writing-goal-save').addEventListener('click', saveWritingGoal);
document.getElementById('btn-writing-close').addEventListener('click', closeDialogs);
document.getElementById('btn-writing-name-roll').addEventListener('click', rollWritingName);
document.getElementById('btn-writing-name-copy').addEventListener('click', () => copyText(elsDialogs.writingNameText.textContent, '名字'));
document.getElementById('btn-writing-name-insert').addEventListener('click', insertWritingName);
document.getElementById('btn-writing-name-close').addEventListener('click', closeDialogs);
elsDialogs.writingNameGender.addEventListener('change', rollWritingName);
elsDialogs.writingGoalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveWritingGoal();
    }
});

for (const type of ['keyup', 'click', 'input', 'focusin']) {
    els.editor.addEventListener(type, (e) => {
        if (!e.target || !e.target.matches || !e.target.matches('textarea.jsoneditor-text')) return;
        updateCursorPosition();
        // 文本视图是 textarea：字数与码字统计要和 Ace 走同一条防抖管线，否则打字时数字冻结
        if (type === 'input') scheduleWordCount();
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
    openDialogEl(elsDialogs.confirm, {keepSettings: true});
}

document.getElementById('btn-discard').addEventListener('click', () => {
    const action = confirmAction;
    confirmAction = null;
    closeTopDialog();
    if (action) action();
});
document.getElementById('btn-cancel-close').addEventListener('click', closeTopDialog);
document.getElementById('btn-props-ok').addEventListener('click', closeDialogs);

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
document.querySelectorAll('.dialog-close').forEach((btn) => btn.addEventListener('click', closeTopDialog));
elsDialogs.mask.addEventListener('click', (e) => {
    if (e.target !== elsDialogs.mask) return;
    if (!elsDialogs.confirm.classList.contains('hidden') || !elsDialogs.conflict.classList.contains('hidden') ||
        !elsDialogs.name.classList.contains('hidden') ||
        !elsDialogs.props.classList.contains('hidden') || !elsDialogs.update.classList.contains('hidden') ||
        !elsDialogs.writing.classList.contains('hidden') ||
        !elsDialogs.writingName.classList.contains('hidden')) closeTopDialog();
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
// 常用编程语言：独立于数据格式，每个语言单独配置环境信息（为后续辅助运行代码预留）
const LANG_DEFS = [
    {id: 'python', name: 'Python', tools: [{id: 'python', name: '解释器'}, {id: 'pip', name: 'pip', optional: true}], pkgs: [{id: 'env', label: '当前环境'}]},
    {id: 'node', name: 'Node.js', tools: [{id: 'node', name: 'Node'}, {id: 'npm', name: 'npm'}, {id: 'pnpm', name: 'pnpm', optional: true}, {id: 'yarn', name: 'yarn', optional: true}], pkgs: [{id: 'global', label: '全局（npm -g）'}, {id: 'project', label: '项目（node_modules）'}]},
    {id: 'go', name: 'Go', tools: [{id: 'go', name: 'Go 工具链'}], pkgs: [{id: 'project', label: '项目依赖（go.mod）'}]},
    {id: 'java', name: 'Java', tools: [{id: 'java', name: 'JDK'}, {id: 'maven', name: 'Maven', optional: true}, {id: 'gradle', name: 'Gradle', optional: true}]},
    {id: 'c', name: 'C', tools: [{id: 'c', name: '编译器（gcc / clang）'}, {id: 'cmake', name: 'CMake', optional: true}]},
    {id: 'cpp', name: 'C++', tools: [{id: 'cpp', name: '编译器（g++）'}, {id: 'cmake', name: 'CMake', optional: true}]},
    {id: 'rust', name: 'Rust', tools: [{id: 'rust', name: 'rustc'}, {id: 'cargo', name: 'cargo'}]},
    {id: 'php', name: 'PHP', tools: [{id: 'php', name: 'PHP'}, {id: 'composer', name: 'Composer', optional: true}]},
    {id: 'ruby', name: 'Ruby', tools: [{id: 'ruby', name: 'Ruby'}, {id: 'gem', name: 'gem'}]},
    {id: 'lua', name: 'Lua', tools: [{id: 'lua', name: 'Lua'}]},
];

setupFormatSettings();
setupLanguageSettings();

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
    setupLanguageSettings();
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
    readPluginAsset: (pluginId, relPath) => backend.ReadPluginAsset(pluginId, relPath),
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
                activityLog.log('plugin.change', installed.id || installed.name, {op: 'install-folder'});
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
                activityLog.log('plugin.change', installed.id || installed.name, {op: 'install-zip'});
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
                if (!url || !url.trim()) throw new Error('仓库地址为空');
                // 安装插件 = 执行第三方代码：先明示权限范围，确认后再装
                openCloseConfirm('插件代码以与应用相同的权限运行，可读写本机文件、执行命令。仅安装你信任的来源：' + url, () => {
                    (async () => {
                        try {
                            const installed = await backend.InstallPluginFromUrl(url);
                            await reloadPluginErrors('');
                            renderPluginsPane();
                            flash('已安装插件：' + installed.name);
                            activityLog.log('plugin.change', (installed && (installed.id || installed.name)) || url, {op: 'install-url'});
                        } catch (e) {
                            flash('安装失败：' + e, true);
                        }
                    })();
                }, '继续安装', '安装第三方插件');
            },
        });
    });
    openDirBtn.addEventListener('click', async () => {
        try {
            await backend.OpenPluginsDir();
        } catch (e) {
            flash('打开插件目录失败：' + e, true);
        }
    });
    const trustIcon = document.querySelector('.plugin-trust-icon');
    if (trustIcon) trustIcon.innerHTML = iconSvg('warn', 12);
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
    const marketRefresh = document.getElementById('plugin-market-refresh');
    if (marketRefresh) {
        marketRefresh.addEventListener('click', () => renderPluginMarket(true));
    }
    const marketSource = document.getElementById('plugin-market-source');
    if (marketSource) {
        marketSource.addEventListener('click', (e) => {
            e.preventDefault();
            const url = marketSource.dataset.url;
            if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(url);
            else window.open(url, '_blank', 'noopener');
        });
    }
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

function compareVersion(a, b) {
    const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const ap = parse(a);
    const bp = parse(b);
    for (let i = 0; i < 3; i += 1) {
        const av = ap[i] || 0;
        const bv = bp[i] || 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
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
        renderPluginMarket(false);
        listEl.textContent = '';
        if (!plugins || !plugins.length) {
            const empty = document.createElement('div');
            empty.className = 'plugin-empty';
            empty.textContent = '暂无插件。点「添加插件」选择包含 plugin.json 的文件夹，或导入 .zip 插件包；插件可注册新的文件格式、工具菜单命令和主题。';
            listEl.appendChild(empty);
            fitPluginListBox(listEl);
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
                    activityLog.log('plugin.change', p.id, {op: cb.checked ? 'enable' : 'disable'});
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
                    activityLog.log('plugin.change', p.id, {op: 'uninstall'});
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
        fitPluginListBox(listEl);
    } catch (e) {
        flash('读取插件失败：' + e, true);
    }
}

let pluginMarketCache = null;
const PLUGIN_MARKET_TTL = 5 * 60 * 1000;

async function renderPluginMarket(force) {
    const listEl = document.getElementById('plugin-market-list');
    if (!listEl) return;
    if (!backend.GetPluginMarket) {
        listEl.textContent = '';
        const unsupported = document.createElement('div');
        unsupported.className = 'plugin-empty';
        unsupported.textContent = '当前版本不支持插件市场。';
        listEl.appendChild(unsupported);
        fitPluginListBox(listEl);
        return;
    }
    if (!force && pluginMarketCache && Date.now() - pluginMarketCache.at < PLUGIN_MARKET_TTL) {
        renderPluginMarketList(listEl, pluginMarketCache.items);
        return;
    }
    listEl.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'plugin-empty';
    loading.textContent = force ? '正在刷新插件市场…' : '正在读取插件市场…';
    listEl.appendChild(loading);
    fitPluginListBox(listEl);
    try {
        const items = (await backend.GetPluginMarket()) || [];
        pluginMarketCache = {at: Date.now(), items};
        renderPluginMarketList(listEl, items);
    } catch (e) {
        listEl.textContent = '';
        const err = document.createElement('div');
        err.className = 'plugin-empty plugin-market-error';
        err.textContent = '插件市场加载失败：' + e + '（点「刷新」重试）';
        listEl.appendChild(err);
        fitPluginListBox(listEl);
        logFrontend('error', '插件市场加载失败：' + e);
    }
}

function renderPluginMarketList(listEl, items) {
    listEl.textContent = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'plugin-empty';
        empty.textContent = '插件市场暂无公开插件。';
        listEl.appendChild(empty);
        fitPluginListBox(listEl);
        return;
    }
    for (const m of items) {
        const item = document.createElement('div');
        item.className = 'plugin-item';
        const head = document.createElement('div');
        head.className = 'plugin-head';
        const name = document.createElement('span');
        name.className = 'plugin-name';
        name.textContent = m.name || m.repo;
        const ver = document.createElement('span');
        ver.className = 'plugin-version';
        ver.textContent = m.version ? 'v' + m.version : '';
        const author = document.createElement('span');
        author.className = 'plugin-author';
        author.textContent = m.author ? '作者：' + m.author : '';
        head.append(name, ver, author);
        const installedVersion = m.installedVersion || '';
        const updateAvailable = m.installed && installedVersion && m.version && compareVersion(m.version, installedVersion) > 0;
        if (updateAvailable) {
            const update = document.createElement('button');
            update.type = 'button';
            update.className = 'dlg-btn primary plugin-market-action';
            update.textContent = '更新';
            update.title = '当前 v' + installedVersion + ' → v' + m.version;
            update.addEventListener('click', async () => {
                update.disabled = true;
                update.textContent = '更新中…';
                try {
                    const pluginId = m.id || (m.repo || '').split('/').pop();
                    const updated = await backend.UpdatePluginFromUrl(pluginId, m.url);
                    if (!updated) throw new Error('更新失败');
                    m.installed = true;
                    m.installedVersion = m.version;
                    await reloadPluginErrors('');
                    renderPluginsPane();
                    flash('已更新插件：' + (updated.name || m.name) + (m.version ? ' v' + m.version : ''));
                } catch (e) {
                    update.disabled = false;
                    update.textContent = '更新';
                    flash('更新失败：' + e, true);
                }
            });
            head.appendChild(update);
        } else if (m.installed) {
            const tag = document.createElement('span');
            tag.className = 'plugin-market-installed';
            tag.textContent = '已安装' + (installedVersion ? ' v' + installedVersion : '');
            head.appendChild(tag);
        } else if (m.minAppVersion && !versionAtLeast(appVersionValue(), m.minAppVersion)) {
            const warn = document.createElement('span');
            warn.className = 'plugin-warn plugin-market-action';
            warn.textContent = '需要应用 ≥ ' + m.minAppVersion;
            head.appendChild(warn);
        } else {
            const install = document.createElement('button');
            install.type = 'button';
            install.className = 'dlg-btn plugin-market-action';
            install.textContent = '安装';
            install.addEventListener('click', () => {
                openCloseConfirm('插件代码以与应用相同的权限运行，可读写本机文件、执行命令。仅安装你信任的来源：' + (m.name || m.url), async () => {
                    install.disabled = true;
                    install.textContent = '安装中…';
                    try {
                        const installed = await backend.InstallPluginFromUrl(m.url);
                        if (!installed) throw new Error('仓库地址为空');
                        m.installed = true;
                        await reloadPluginErrors('');
                        renderPluginsPane();
                        flash('已安装插件：' + (installed.name || m.name));
                        activityLog.log('plugin.change', (installed.id || installed.name || m.url), {op: 'install-url'});
                    } catch (e) {
                        install.disabled = false;
                        install.textContent = '安装';
                        flash('安装失败：' + e, true);
                    }
                }, '继续安装', '安装第三方插件');
            });
            head.appendChild(install);
        }
        const desc = document.createElement('div');
        desc.className = 'plugin-desc';
        desc.textContent = m.description || '无描述';
        const meta = document.createElement('div');
        meta.className = 'plugin-meta';
        const repo = document.createElement('span');
        repo.textContent = m.repo;
        meta.appendChild(repo);
        const date = marketDate(m.updatedAt);
        if (date) {
            const updated = document.createElement('span');
            updated.textContent = '更新于 ' + date;
            meta.appendChild(updated);
        }
        if (m.stars > 0) {
            const stars = document.createElement('span');
            stars.className = 'market-stars';
            stars.innerHTML = iconSvg('star', 11) + '<span>' + m.stars + '</span>';
            meta.appendChild(stars);
        }
        if (!m.manifestOk) {
            const warn = document.createElement('span');
            warn.className = 'plugin-warn';
            warn.textContent = '未读取到插件清单';
            meta.appendChild(warn);
        }
        const link = document.createElement('a');
        link.className = 'plugin-link';
        link.textContent = '主页';
        link.href = m.url;
        link.dataset.url = m.url;
        link.title = m.url;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(m.url);
            else window.open(m.url, '_blank', 'noopener');
        });
        meta.appendChild(link);
        item.append(head, desc, meta);
        listEl.appendChild(item);
    }
    fitPluginListBox(listEl);
}

// 列表外层框最多显示三格，超出的内容在框内滚动。
function fitPluginListBox(listEl, maxItems = 3) {
    const box = listEl && listEl.parentElement;
    if (!box || !box.classList.contains('plugin-list-box')) return;
    const items = Array.from(listEl.children);
    if (!items.length || !items[0].offsetHeight) {
        box.style.maxHeight = '';
        return;
    }
    const listStyle = getComputedStyle(listEl);
    const gap = parseFloat(listStyle.rowGap || listStyle.gap) || 0;
    let height = 0;
    const visible = Math.min(items.length, maxItems);
    for (let i = 0; i < visible; i += 1) {
        height += items[i].offsetHeight;
        if (i > 0) height += gap;
    }
    const boxStyle = getComputedStyle(box);
    height += (parseFloat(boxStyle.paddingTop) || 0) + (parseFloat(boxStyle.paddingBottom) || 0);
    height += (parseFloat(boxStyle.borderTopWidth) || 0) + (parseFloat(boxStyle.borderBottomWidth) || 0);
    box.style.maxHeight = Math.ceil(height) + 'px';
}

function marketDate(iso) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
    return match ? match[1] : '';
}

setupPluginsSettings();

// ---- 设置：环境变量（私密值注入终端/命令桥；AI 只见名称与描述） ----

const ENVVAR_NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const envVarState = {vars: [], encrypted: false, supported: false};
let envEditorEditing = '';

async function renderEnvVarsPane() {
    const listEl = document.getElementById('envvar-list');
    if (!listEl) return;
    const sel = document.getElementById('envvar-encrypted');
    const hint = document.getElementById('envvar-storage-hint');
    let snap = {encrypted: false, supported: false, vars: []};
    try {
        snap = (await backend.GetEnvVars()) || snap;
    } catch (e) {
        if (hint) hint.textContent = '读取环境变量失败：' + e;
    }
    envVarState.vars = Array.isArray(snap.vars) ? snap.vars : [];
    envVarState.encrypted = !!snap.encrypted;
    envVarState.supported = !!snap.supported;
    if (sel) {
        const encOpt = sel.querySelector('option[value="encrypted"]');
        if (encOpt) {
            encOpt.disabled = !envVarState.supported;
            encOpt.textContent = envVarState.supported ? 'DPAPI 加密（仅本机可解）' : 'DPAPI 加密（当前平台不支持）';
        }
        sel.value = envVarState.encrypted && envVarState.supported ? 'encrypted' : 'plain';
    }
    if (hint) {
        hint.textContent = envVarState.supported
            ? (envVarState.encrypted
                ? '当前：DPAPI 加密，绑定本机与当前用户，配置文件拷到别的机器也解不开。'
                : '当前：明文 JSON，可手动备份编辑；文件位于应用数据目录 env-vars.json。')
            : '当前：明文 JSON（本平台不支持 DPAPI 加密）。';
    }
    listEl.textContent = '';
    if (!envVarState.vars.length) {
        const empty = document.createElement('div');
        empty.className = 'envvar-empty';
        empty.textContent = '还没有环境变量。点「新增变量」添加 API key 等私密值；之后新开的终端会话与命令桥命令都会注入它们。';
        listEl.appendChild(empty);
        return;
    }
    for (const v of envVarState.vars) {
        listEl.appendChild(buildEnvVarRow(v));
    }
}

function buildEnvVarRow(v) {
    const row = document.createElement('div');
    row.className = 'envvar-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'envvar-name';
    nameEl.textContent = v.name;
    const descEl = document.createElement('span');
    descEl.className = 'envvar-desc';
    descEl.textContent = v.description || '（无描述）';
    descEl.title = v.description || '';
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'popover-label envvar-enabled';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!v.enabled;
    cb.addEventListener('change', async () => {
        try {
            await saveEnvVarsAll(envVarState.vars.map((item) => (
                item.name === v.name ? {...item, enabled: cb.checked} : item
            )));
        } catch (e) {
            flash('切换失败：' + e, true);
            renderEnvVarsPane();
        }
    });
    enabledLabel.append(cb, document.createTextNode('注入'));
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'dlg-btn';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => openEnvVarEditor(v.name));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dlg-btn envvar-del';
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
            await saveEnvVarsAll(envVarState.vars.filter((item) => item.name !== v.name));
            flash('已删除环境变量：' + v.name);
        } catch (e) {
            flash('删除失败：' + e, true);
        }
    });
    row.append(nameEl, descEl, enabledLabel, editBtn, del);
    return row;
}

async function saveEnvVarsAll(vars) {
    await backend.SetEnvVars((vars || []).map((v) => ({
        name: v.name,
        value: v.value,
        description: v.description || '',
        enabled: !!v.enabled,
    })));
    await renderEnvVarsPane();
}

function showEnvEditorError(message) {
    const errorEl = document.getElementById('env-opt-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
}

function closeEnvVarEditor() {
    const dlg = document.getElementById('dlg-env-editor');
    const mask = document.getElementById('dlg-env-editor-mask');
    if (dlg) dlg.classList.add('hidden');
    if (mask) mask.classList.add('hidden');
    envEditorEditing = '';
    showEnvEditorError('');
    const input = document.getElementById('env-opt-value');
    const toggle = document.getElementById('env-opt-value-toggle');
    if (input) input.type = 'password';
    if (toggle) toggle.textContent = '显示';
}

function openEnvVarEditor(name) {
    const dlg = document.getElementById('dlg-env-editor');
    if (!dlg) return;
    const mask = document.getElementById('dlg-env-editor-mask');
    envEditorEditing = envVarState.vars.some((v) => v.name === name) ? name : '';
    const existing = envEditorEditing
        ? envVarState.vars.find((v) => v.name === envEditorEditing)
        : null;
    const title = document.getElementById('dlg-env-title');
    const nameInput = document.getElementById('env-opt-name');
    const descInput = document.getElementById('env-opt-desc');
    const valueInput = document.getElementById('env-opt-value');
    const enabledInput = document.getElementById('env-opt-enabled');
    const warn = document.getElementById('env-opt-name-warn');
    if (title) title.textContent = existing ? '编辑变量：' + existing.name : '新增变量';
    if (nameInput) nameInput.value = existing ? existing.name : '';
    if (descInput) descInput.value = existing ? (existing.description || '') : '';
    if (valueInput) valueInput.value = existing ? (existing.value || '') : '';
    if (enabledInput) enabledInput.checked = existing ? !!existing.enabled : true;
    if (warn) warn.classList.toggle('hidden', !existing || existing.name.toUpperCase() !== 'PATH');
    showEnvEditorError('');
    if (valueInput) valueInput.type = 'password';
    const toggle = document.getElementById('env-opt-value-toggle');
    if (toggle) toggle.textContent = '显示';
    if (mask) mask.classList.remove('hidden');
    dlg.classList.remove('hidden');
    setTimeout(() => {
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }, 50);
}

async function saveEnvVarEditor() {
    const nameInput = document.getElementById('env-opt-name');
    const descInput = document.getElementById('env-opt-desc');
    const valueInput = document.getElementById('env-opt-value');
    const enabledInput = document.getElementById('env-opt-enabled');
    if (!nameInput || !valueInput) return;
    const name = String(nameInput.value || '').trim();
    if (!ENVVAR_NAME_RULE.test(name)) {
        showEnvEditorError('名称无效：字母/数字/下划线，字母或下划线开头，最长 128 字符');
        nameInput.focus();
        return;
    }
    const dup = envVarState.vars.some((v) => v.name === name && v.name !== envEditorEditing);
    if (dup) {
        showEnvEditorError('已存在同名变量：' + name);
        nameInput.focus();
        return;
    }
    const entry = {
        name,
        value: String(valueInput.value || ''),
        description: String((descInput && descInput.value) || '').trim(),
        enabled: !!(enabledInput && enabledInput.checked),
    };
    const list = envEditorEditing
        ? envVarState.vars.map((v) => (v.name === envEditorEditing ? entry : v))
        : envVarState.vars.concat([entry]);
    const wasEditing = envEditorEditing;
    try {
        await backend.SetEnvVars(list);
        closeEnvVarEditor();
        flash((wasEditing ? '已保存环境变量：' : '已新增环境变量：') + name);
        await renderEnvVarsPane();
    } catch (e) {
        showEnvEditorError(String(e));
    }
}

function setupEnvVarsSettings() {
    const addBtn = document.getElementById('envvar-add');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => openEnvVarEditor(''));
    const saveBtn = document.getElementById('dlg-env-save');
    if (saveBtn) saveBtn.addEventListener('click', saveEnvVarEditor);
    const cancelBtn = document.getElementById('dlg-env-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEnvVarEditor);
    const closeBtn = document.getElementById('dlg-env-editor-close');
    if (closeBtn) closeBtn.addEventListener('click', closeEnvVarEditor);
    const mask = document.getElementById('dlg-env-editor-mask');
    if (mask) mask.addEventListener('click', closeEnvVarEditor);
    // 捕获阶段拦截 Esc：编辑器开着时只关编辑器，不动背后的设置窗口
    // （main.js 的全局 Esc 走 window capture，这里必须同样挂 window capture 且先注册才能拦住）
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const dlg = document.getElementById('dlg-env-editor');
        if (!dlg || dlg.classList.contains('hidden')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        closeEnvVarEditor();
    }, true);
    const valueToggle = document.getElementById('env-opt-value-toggle');
    if (valueToggle) {
        valueToggle.addEventListener('click', () => {
            const input = document.getElementById('env-opt-value');
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            valueToggle.textContent = show ? '隐藏' : '显示';
        });
    }
    const nameInput = document.getElementById('env-opt-name');
    if (nameInput) {
        nameInput.addEventListener('input', () => {
            const warn = document.getElementById('env-opt-name-warn');
            if (warn) warn.classList.toggle('hidden', nameInput.value.trim().toUpperCase() !== 'PATH');
        });
    }
    const sel = document.getElementById('envvar-encrypted');
    if (sel) {
        sel.addEventListener('change', async () => {
            try {
                await backend.SetEnvVarEncrypted(sel.value === 'encrypted');
                flash(sel.value === 'encrypted' ? '已切换为 DPAPI 加密存储' : '已切换为明文存储');
            } catch (e) {
                flash('切换存储方式失败：' + e, true);
            }
            renderEnvVarsPane();
        });
    }
}

setupEnvVarsSettings();

const ENCODINGS = [['auto', '自动'], ['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const CONVERT_ENCODINGS = [['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const INDENTS = [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']];
const EOLS = [['follow', '跟随原文件'], ['lf', 'LF'], ['crlf', 'CRLF']];
const VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];
const PATCH_VIEWS = [['patch', '补丁视图'], ['code', '代码视图'], ['text', '文本视图']];
const CSV_VIEWS = [['table', '表格视图'], ['sql', 'SQL 查询'], ['tree', '树视图'], ['text', '文本视图']];
const JSONL_VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图'], ['sql', 'SQL 查询']];
const MARKDOWN_VIEWS = [['split', '分屏'], ['preview', '预览'], ['code', '代码视图'], ['text', '文本视图']];
const HTML_VIEWS = [['split', '分屏'], ['code', '代码视图'], ['text', '文本视图']];
const IMAGE_VIEWS = [['image', '图片视图'], ['binary', '二进制视图'], ['text', '文本视图']];
const BINARY_VIEWS = [['binary', '二进制视图'], ['text', '文本视图']];
const SVG_VIEWS = [['split', '分屏'], ['render', '渲染视图'], ['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];

function isSvgDoc(doc) {
    return !!(doc && /\.svg$/i.test(doc.name || ''));
}

function isHtmlDoc(doc) {
    return !!(doc && /\.(html?|xhtml)$/i.test(doc.name || ''));
}

// 分屏种类：markdown / svg / html；其他格式暂不支持
function splitKindFor(doc) {
    if (!doc || !doc.format) return '';
    if (doc.format.preview) return 'markdown';
    if (isSvgDoc(doc)) return 'svg';
    if (isHtmlDoc(doc)) return 'html';
    return '';
}

function canSplitDoc(doc) {
    return !!doc && !doc.binary && !doc.large && !!splitKindFor(doc);
}
const CSV_ROW_NUM_WIDTH = 44;
const CSV_COL_MIN_WIDTH = 56;

function viewOptionsFor(fmt, doc) {
    if (doc && (doc.browser || doc.bgTerm)) return [];
    if (fmt && fmt.image) return IMAGE_VIEWS;
    if (fmt && fmt.id === 'bytes') return BINARY_VIEWS;
    if (isHtmlDoc(doc)) return HTML_VIEWS;
    if (fmt && fmt.id === 'markdown') return MARKDOWN_VIEWS;
    if (isSvgDoc(doc)) return SVG_VIEWS;
    if (fmt && fmt.id === 'jsonl') return JSONL_VIEWS;
    if (fmt && fmt.patch) return PATCH_VIEWS;
    return fmt && (fmt.table || fmt.id === 'csv') ? CSV_VIEWS : VIEWS;
}

function isSqlSupportedDoc(doc) {
    const id = doc && doc.format && doc.format.id;
    return id === 'csv' || id === 'jsonl';
}

// 旧版本把 sql 当视图模式持久化过；SQL 现在是覆盖层，恢复时归一为底层视图
function normalizeLegacySqlMode(doc) {
    if (doc && doc.mode === 'sql') {
        doc.mode = doc.sqlPrevMode || 'text';
        doc.sqlActive = false;
        if (doc.pane) doc.pane.classList.remove('sql-active');
    }
    return (doc && doc.mode) || 'tree';
}

function viewDisabled(mode) {
    if (!file) return true;
    if (mode === 'image') return !file.image;
    if (mode === 'binary') return !file.binary;
    if (mode === 'tree') return !file.treeAvailable;
    if (mode === 'text') return false;
    if (mode === 'preview') return !(file.format && file.format.preview) || !!file.large;
    if (mode === 'render') return !isSvgDoc(file);
    if (mode === 'split') return !canSplitDoc(file);
    if (mode === 'sql') return !isSqlSupportedDoc(file);
    return false;
}

function viewDisabledTitle(mode) {
    if (mode === 'preview' && file && file.large) return '大文件不支持预览';
    if (mode === 'sql') return 'SQL 查询仅支持 CSV / TSV / JSONL';
    return '当前文件只支持代码视图';
}

// text 组是兜底组（纯文本 + CMake/Make/Dockerfile/Git 规则等特殊文件名），
// 状态栏按 ace 语法模式细化显示，不再一律叫「纯文本」
const TEXT_MODE_NAMES = {
    cmake: 'CMake', dockerfile: 'Dockerfile', makefile: 'Makefile',
    diff: 'Diff', protobuf: 'Protobuf', graphqlschema: 'GraphQL', gitignore: 'Git 规则',
};

function formatDisplayName(doc) {
    if (doc && doc.format && doc.format.id === 'text' && doc.name) {
        try {
            const mode = aceModeFor(doc.name, doc.format).split('/').pop();
            if (TEXT_MODE_NAMES[mode]) return TEXT_MODE_NAMES[mode];
        } catch (e) {}
    }
    return (doc && doc.format && doc.format.name) || '';
}

function viewLabel(mode) {
    if (mode === 'browser') return '网页视图';
    if (mode === 'split') return '分屏';
    if (mode === 'image') return '图片视图';
    if (mode === 'binary') return '二进制视图';
    if (mode === 'preview') return '预览';
    if (mode === 'render') return '渲染视图';
    if (mode === 'table') return '表格视图';
    if (mode === 'patch') return '补丁视图';
    if (mode === 'sql') return 'SQL 查询';
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
        'editor.tooltip.disable-editing': '只读模式下无法编辑',
    },
};

// 兜底：Ace 只读提示的内核文案是英文，观察器改写成中文（若语言包已生效则不会命中）。
// 注意：hoverTooltip 会把消息 <div> 作为子节点插入，addedNode 通常是内层 div 而不是
// .ace_tooltip 容器本身，所以这里要向上找容器。
const readonlyTipObserver = new MutationObserver((muts) => {
    for (const m of muts) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tip = node.classList.contains('ace_tooltip')
                ? node
                : (node.parentElement ? node.parentElement.closest('.ace_tooltip') : null);
            if (tip && tip.textContent === 'Editing is disabled') {
                tip.textContent = '只读模式下无法编辑';
            }
        }
    }
});
readonlyTipObserver.observe(document.body, {childList: true, subtree: true});

// 治本：把只读提示的中文文案直接注册进 Ace 的 nls（单参数为消息表）。
// jsoneditor 的语言包不进 Ace nls，二进制 / 文本等只读编辑器此前一直是英文；
// 这里注册后所有 Ace 实例生效，观察器仅作兜底。
try {
    if (window.ace && ace.config && typeof ace.config.setMessages === 'function') {
        ace.config.setMessages({'editor.tooltip.disable-editing': '只读模式下无法编辑'});
    }
} catch (e) {}

// 共享 Markdown 渲染层（frontend/src/markdown.js）：主界面与阅读模式共用，
// sanitize 规则单一来源（docs/finished-plans/reading-mode.md §10.2）。mermaid 脚本加载仍在 main.js。
let markdownRenderer;
const sharedMarkdown = createMarkdownRenderer({
    mdLineNumbers: () => settings.mdLineNumbers,
    mermaidPlaceholder: (text) => renderMermaidPlaceholder(text),
});
markdownRenderer = sharedMarkdown.markdownRenderer;
const renderMarkdownHtml = sharedMarkdown.renderMarkdownHtml;

// renderMermaidPlaceholder mermaid 图表占位：渲染后异步替换为 SVG
function renderMermaidPlaceholder(text) {
    return '<div class="md-mermaid" data-src="' + markdownRenderer.utils.escapeHtml(text) + '"></div>';
}

let mermaidScriptLoading = false;

function ensureMermaidScript() {
    if (window.mermaid || mermaidScriptLoading) return;
    mermaidScriptLoading = true;
    const script = document.createElement('script');
    script.src = '/vendor/mermaid/mermaid.min.js';
    script.onload = () => {
        mermaidScriptLoading = false;
        try {
            window.mermaid.initialize({startOnLoad: false, securityLevel: 'strict'});
        } catch (e) {}
        if (file && currentMode === 'preview') renderMarkdownPreview(file);
    };
    script.onerror = () => {
        mermaidScriptLoading = false;
        for (const el of document.querySelectorAll('.md-mermaid')) {
            el.textContent = 'mermaid 库加载失败';
        }
    };
    document.head.appendChild(script);
}

function mermaidThemeForCurrent() {
    const id = currentTheme().id;
    return /dark|darcula/.test(id) ? 'dark' : 'neutral';
}

async function renderMermaidBlocks(root) {
    const blocks = (root || document).querySelectorAll('.md-mermaid:not([data-rendered])');
    if (!blocks.length) return;
    if (!window.mermaid) {
        ensureMermaidScript();
        if (!window.mermaid) return;
    }
    try {
        window.mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme: mermaidThemeForCurrent()});
    } catch (e) {}
    for (const block of blocks) {
        const msrc = block.dataset.src || '';
        if (!msrc.trim()) continue;
        block.dataset.rendered = '1';
        try {
            const {svg} = await window.mermaid.render('mmd-' + Math.random().toString(36).slice(2), msrc);
            // mermaid strict 已自净化，这里再过一遍 DOMPurify（SVG 档）兜底；
            // style/foreignObject 是 mermaid 自带样式与 HTML 标签所需，保留但内容仍被消毒。
            block.innerHTML = DOMPurify.sanitize(svg, {
                USE_PROFILES: {svg: true, svgFilters: true},
                ADD_TAGS: ['style', 'foreignObject'],
            });
        } catch (e) {
            block.classList.add('md-mermaid-error');
            block.textContent = 'mermaid 图表渲染失败：' + (e && e.message || e);
        }
    }
}

// renderMarkdownCodeBlock / fence / link_open 规则已随渲染器抽到 markdown.js。

// resolveMarkdownImages 把 Markdown 预览里相对路径/本地绝对路径的图片换成后端读取的 data URL。
function resolveMarkdownImages(doc) {
    if (!doc || !doc.previewBody) return;
    const BS = String.fromCharCode(92); // 反斜杠（避免注入层转义问题）
    const raw0 = doc.path || '';
    const cut = Math.max(raw0.lastIndexOf('/'), raw0.lastIndexOf(BS));
    const base = cut >= 0 ? raw0.slice(0, cut) : '';
    for (const img of doc.previewBody.querySelectorAll('img')) {
        const raw = img.getAttribute('data-ai-src') || img.getAttribute('src') || '';
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

// renderMarkdownHtml 已抽到 markdown.js（共享 sanitize 配置）。

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
const FOOT_WIDGETS = {encoding: els.stEnc, view: els.stMode, eol: els.stEol, zoom: els.stZoom, mdWidth: els.stMdWidth, aiWidth: els.stAiWidth};
let footPopoverKind = null;
// 编码/换行/缩进弹出面板的行图标用 icons.js 渲染（不再使用 MDL2 字符）
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
    if (opts.current) ic.innerHTML = iconSvg('check', 12);
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
            ic.innerHTML = iconSvg(ok ? 'check' : 'warn', 12);
            ic.className = 'enc-ic ' + (ok ? 'ok' : 'warn');
            ic.title = ok ? '可无损表示当前内容' : '包含无法表示的字符，转换后可能丢失';
        } catch (e) {}
    }
}

function renderViewMenu() {
    footPopover.appendChild(popTitle('视图'));
    const splitActive = !!(file && file.splitActive);
    for (const [mode, label] of viewOptionsFor(file && file.format, file)) {
        const disabled = viewDisabled(mode);
        footPopover.appendChild(popItem(label, {
            current: mode === 'split' ? splitActive
                : (mode === 'sql' ? !!(file && file.sqlActive) : (!splitActive && currentMode === mode)),
            disabled,
            disabledTitle: viewDisabledTitle(mode),
            onClick: () => { switchMode(mode); closeFootPopover(); },
        }));
    }
    footPopover.appendChild(popFoot('当前', splitActive ? viewLabel('split') : viewLabel(currentMode)));
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

function mdPreviewWidthLabel(value) {
    return String(value) === '0' ? '自适应' : value + 'px';
}

function aiFullscreenWidthLabel(value) {
    const current = String(value || 'auto');
    if (current === 'auto') return '自动';
    return current === '0' ? '跟随' : current + 'px';
}

function updateAiWidthWidget() {
    if (!els.stAiWidth) return;
    const show = !!settings.aiPanelOpen;
    els.stAiWidth.style.display = show ? '' : 'none';
    if (!show) {
        els.stAiWidth.textContent = '';
        return;
    }
    const value = String(settings.aiFullscreenWidth || 'auto');
    els.stAiWidth.textContent = 'AI 宽度 · ' + aiFullscreenWidthLabel(value);
    els.stAiWidth.title = value === 'auto'
        ? 'AI 内容宽度（停靠 / 全屏通用）：自动（< 920px 跟随，≥ 920px 最大 920px）'
        : 'AI 内容宽度（停靠 / 全屏通用）：' + (value === '0' ? '跟随' : value + 'px');
}

function renderAiWidthMenu() {
    footPopover.appendChild(popTitle('AI 内容宽度（停靠 / 全屏）'));
    const options = [['auto', '自动（默认）'], ['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随']];
    for (const [value, label] of options) {
        footPopover.appendChild(popItem(label, {
            current: String(settings.aiFullscreenWidth) === value,
            onClick: () => {
                settings.aiFullscreenWidth = value;
                applySettings();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popSep());
    footPopover.appendChild(popFoot('当前', aiFullscreenWidthLabel(settings.aiFullscreenWidth)));
    footPopover.appendChild(popFoot('自动规则', '<920px 跟随 / ≥920px 最大 920px'));
}

function renderMdWidthMenu() {
    footPopover.appendChild(popTitle('Markdown 预览宽度'));
    const options = [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随窗口宽度']];
    for (const [value, label] of options) {
        footPopover.appendChild(popItem(label, {
            current: String(settings.mdPreviewWidth) === value,
            onClick: () => {
                settings.mdPreviewWidth = value;
                applySettings();
                updateStatus();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popSep());
    footPopover.appendChild(popItem('更多设置…', {
        onClick: () => {
            closeFootPopover();
            openSettings('general');
        },
    }));
    footPopover.appendChild(popFoot('当前', mdPreviewWidthLabel(settings.mdPreviewWidth)));
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
    if (!file && kind !== 'aiWidth') return;
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
    else if (kind === 'mdWidth') renderMdWidthMenu();
    else if (kind === 'aiWidth') renderAiWidthMenu();
    else renderEolMenu();
    const r = anchor.getBoundingClientRect();
    const pr = footPopover.getBoundingClientRect();
    // 向上弹出，空间不足时限制高度内部滚动，避免被窗口顶部截断
    const available = r.top - 14;
    if (pr.height > available && available > 120) {
        footPopover.style.maxHeight = available + 'px';
        footPopover.style.overflowY = 'auto';
        const pr2 = footPopover.getBoundingClientRect();
        footPopover.style.left = Math.max(8, Math.round(r.right - pr2.width)) + 'px';
        footPopover.style.top = Math.round(r.top - pr2.height - 6) + 'px';
    } else {
        footPopover.style.maxHeight = '';
        footPopover.style.overflowY = '';
        footPopover.style.left = Math.max(8, Math.round(r.right - pr.width)) + 'px';
        footPopover.style.top = Math.round(r.top - pr.height - 6) + 'px';
    }
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

function setupLanguageSettings() {
    const children = document.getElementById('snav-lang-children');
    const content = document.querySelector('.settings-content');
    if (!children || !content) return;
    for (const lang of LANG_DEFS) {
        if (children.querySelector(`[data-pane="lang-${lang.id}"]`)) continue;
        const nav = document.createElement('button');
        nav.type = 'button';
        nav.className = 'snav-item snav-child snav-lang';
        nav.dataset.pane = 'lang-' + lang.id;
        nav.textContent = lang.name;
        children.appendChild(nav);
        if (!content.querySelector(`.settings-pane[data-pane="lang-${lang.id}"]`)) {
            const pane = document.createElement('div');
            pane.className = 'settings-pane hidden';
            pane.dataset.pane = 'lang-' + lang.id;
            content.appendChild(pane);
        }
    }
}

// 每个语言的环境状态按工具拆分存放在 settings.langEnv[id].tools[toolId]
function langEnvFor(id) {
    if (!settings.langEnv || typeof settings.langEnv !== 'object') settings.langEnv = {};
    const entry = settings.langEnv[id];
    if (!entry || typeof entry !== 'object') {
        settings.langEnv[id] = {tools: {}};
    } else if (Array.isArray(entry.envs) && !entry.tools) {
        // 旧结构迁移：语言级缓存挪到该语言的主工具下
        const lang = LANG_DEFS.find((l) => l.id === id);
        const primary = lang && lang.tools && lang.tools[0] ? lang.tools[0].id : id;
        const migrated = {
            envs: entry.envs,
            selectedPath: entry.selectedPath || '',
            pathOverride: entry.pathOverride || '',
            scannedAt: entry.scannedAt || 0,
        };
        settings.langEnv[id] = {tools: {}};
        settings.langEnv[id].tools[primary] = migrated;
    }
    if (!settings.langEnv[id].tools || typeof settings.langEnv[id].tools !== 'object') settings.langEnv[id].tools = {};
    return settings.langEnv[id];
}

function toolEnvFor(id, toolId) {
    const e = langEnvFor(id);
    if (!e.tools[toolId] || typeof e.tools[toolId] !== 'object') e.tools[toolId] = {};
    return e.tools[toolId];
}

// effectiveToolEnv 当前生效的环境：手动指定 > 手动选择 > 默认第一个
function effectiveToolEnv(id, toolId) {
    const env = toolEnvFor(id, toolId);
    const list = Array.isArray(env.envs) ? env.envs : [];
    if (env.pathOverride) {
        const hit = list.find((x) => x.path && String(x.path).toLowerCase() === env.pathOverride.toLowerCase());
        if (hit) return hit;
        return {ok: false, path: env.pathOverride, error: env.error || '指定的路径不可用'};
    }
    const hit = env.selectedPath ? list.find((x) => x.path && String(x.path).toLowerCase() === env.selectedPath.toLowerCase()) : null;
    return hit || list[0] || {ok: false, error: env.error || '未找到可用环境'};
}

function renderLangPane(id) {
    const lang = LANG_DEFS.find((l) => l.id === id);
    const pane = document.querySelector(`.settings-pane[data-pane="lang-${id}"]`);
    if (!lang || !pane) return;
    pane.textContent = '';
    const title = document.createElement('div');
    title.className = 'fmt-pane-title';
    title.textContent = lang.name;
    const sub = document.createElement('div');
    sub.className = 'fmt-pane-sub';
    sub.textContent = '环境信息（解释器 / 编译器与配套工具链的路径和版本），缓存到本地，为后续的辅助运行代码功能预留';
    pane.append(title, sub);

    for (const tool of lang.tools) {
        const env = toolEnvFor(id, tool.id);
        const list = Array.isArray(env.envs) ? env.envs : [];
        const eff = effectiveToolEnv(id, tool.id);

        const sec = document.createElement('div');
        sec.className = 'env-tool';

        const head = document.createElement('div');
        head.className = 'env-tool-head';
        const dot = document.createElement('span');
        dot.className = 'env-dot' + (env.scanning ? ' busy' : (env.scannedAt ? (eff && eff.ok ? ' ok' : (tool.optional ? '' : ' fail')) : ''));
        const headText = document.createElement('span');
        headText.textContent = tool.name + (tool.optional ? '（可选）' : '');
        head.append(dot, headText);
        sec.appendChild(head);

        // 多环境选择框：扫描出多个时默认选第一个，可手动切换
        if (list.length) {
            const sel = document.createElement('select');
            sel.className = 'env-select';
            for (const e of list) {
                const opt = document.createElement('option');
                opt.value = e.path || '';
                opt.textContent = (e.version ? e.version + ' ｜ ' : '') + (e.path || '');
                sel.appendChild(opt);
            }
            if (eff && eff.path && list.some((e) => e.path === eff.path)) sel.value = eff.path;
            if (env.pathOverride) {
                sel.disabled = true;
                sel.title = '手动指定路径时忽略此选择';
            }
            sel.addEventListener('change', () => {
                env.selectedPath = sel.value;
                applySettings();
                if (id === 'python') resetLangPkgs(id);
                renderLangPane(id);
            });
            sec.appendChild(sel);
        }

        const body = document.createElement('div');
        body.className = 'env-status';
        if (env.scanning) {
            const line = document.createElement('div');
            line.className = 'env-meta';
            line.textContent = '正在扫描…';
            body.appendChild(line);
        } else if (!env.scannedAt) {
            const line = document.createElement('div');
            line.className = 'env-meta';
            line.textContent = '未检测';
            body.appendChild(line);
        } else if (eff && eff.ok) {
            const vRow = document.createElement('div');
            vRow.className = 'env-status-row';
            const vk = document.createElement('span');
            vk.className = 'env-status-key';
            vk.textContent = '版本';
            const vv = document.createElement('span');
            vv.className = 'env-status-val';
            vv.textContent = eff.version || '';
            vRow.append(vk, vv);
            body.appendChild(vRow);
            const pRow = document.createElement('div');
            pRow.className = 'env-status-row';
            const pk = document.createElement('span');
            pk.className = 'env-status-key';
            pk.textContent = '路径';
            const pv = document.createElement('span');
            pv.className = 'env-status-val mono';
            pv.textContent = eff.path || '';
            pv.title = eff.path || '';
            pRow.append(pk, pv);
            body.appendChild(pRow);
        } else {
            const line = document.createElement('div');
            line.className = 'env-error';
            line.textContent = (eff && eff.error) || env.error || '未找到可用环境';
            body.appendChild(line);
        }
        if (env.scannedAt && !env.scanning) {
            const meta = document.createElement('div');
            meta.className = 'env-meta';
            const source = env.pathOverride ? '手动指定' : (env.selectedPath ? '手动选择' : '默认');
            meta.textContent = '上次扫描 ' + propsTimeText(env.scannedAt) + ' · ' + source;
            body.appendChild(meta);
        }
        sec.appendChild(body);

        // 手动指定：输入框 + 「…」按钮，可手输也可打开文件对话框选择
        const overrideRow = document.createElement('div');
        overrideRow.className = 'env-override-row';
        const overrideInput = document.createElement('input');
        overrideInput.type = 'text';
        overrideInput.className = 'env-override';
        overrideInput.placeholder = '手动指定可执行文件路径';
        overrideInput.value = env.pathOverride || '';
        overrideInput.addEventListener('change', () => {
            env.pathOverride = overrideInput.value.trim();
            applySettings();
            if (id === 'python') resetLangPkgs(id);
            renderLangPane(id);
        });
        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'env-browse';
        browseBtn.title = '浏览…';
        browseBtn.textContent = '…';
        browseBtn.disabled = !!env.scanning;
        browseBtn.addEventListener('click', async () => {
            if (!backend.ShowOpenFileDialog) {
                flash('当前版本不支持选择文件', true);
                return;
            }
            try {
                const picked = await backend.ShowOpenFileDialog('选择 ' + tool.name + ' 可执行文件', 'exe');
                if (!picked) return;
                overrideInput.value = picked;
                env.pathOverride = picked;
                applySettings();
                if (tool.id === 'python') resetLangPkgs(id);
                await scanLanguageTool(id, tool.id);
            } catch (e) {
                flash('选择文件失败：' + ((e && e.message) || e), true);
            }
        });
        overrideRow.append(overrideInput, browseBtn);
        sec.appendChild(overrideRow);

        pane.appendChild(sec);
    }

    const anyScanning = lang.tools.some((t) => toolEnvFor(id, t.id).scanning);
    const btnRow = document.createElement('div');
    btnRow.className = 'popover-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-btn';
    const scanned = lang.tools.every((t) => toolEnvFor(id, t.id).scannedAt);
    btn.textContent = scanned ? '重新扫描' : '扫描环境';
    btn.disabled = anyScanning;
    btn.addEventListener('click', () => scanLanguageAll(id));
    btnRow.appendChild(btn);
    pane.appendChild(btnRow);

    const hint = document.createElement('div');
    hint.className = 'fmt-hint';
    hint.textContent = '首次打开会自动扫描一次并缓存；扫描出多个环境时默认选第一个，可用下拉切换，或在各工具的「手动指定」里填路径。';
    pane.appendChild(hint);

    // 已安装的包：python（pip 全局 / .venv）与 node（npm 全局 / 项目 node_modules）
    if (lang.pkgs && lang.pkgs.length) {
        const pkgSec = document.createElement('div');
        pkgSec.className = 'env-tool';
        const pkgHead = document.createElement('div');
        pkgHead.className = 'env-tool-head';
        pkgHead.textContent = '已安装的包';
        pkgSec.appendChild(pkgHead);
        for (const scope of lang.pkgs) {
            pkgSec.appendChild(renderPkgScope(id, scope));
        }
        pane.appendChild(pkgSec);
    }

    // 自动扫描：还没扫过的工具按顺序补一次（结果缓存，不重复扫）
    const pending = lang.tools.filter((t) => {
        const e = toolEnvFor(id, t.id);
        return !e.scanning && !e.scannedAt;
    });
    const container = langEnvFor(id);
    if (pending.length && !anyScanning && !container._autoScanning) {
        container._autoScanning = true;
        (async () => {
            try {
                for (const t of pending) {
                    await scanLanguageTool(id, t.id);
                }
            } finally {
                container._autoScanning = false;
            }
        })();
    }

    // 包列表：还没有缓存结果的作用域按顺序补一次
    if (lang.pkgs && lang.pkgs.length) {
        const pendingPkgs = lang.pkgs.filter((s) => {
            const st = pkgStateFor(id, s.id);
            return !st.scanning && !st.scannedAt;
        });
        if (pendingPkgs.length && !container._pkgAutoScanning) {
            container._pkgAutoScanning = true;
            (async () => {
                try {
                    for (const s of pendingPkgs) {
                        await scanLanguagePkgs(id, s.id);
                    }
                } finally {
                    container._pkgAutoScanning = false;
                }
            })();
        }
    }
}

async function scanLanguageTool(id, toolId) {
    const env = toolEnvFor(id, toolId);
    if (env.scanning) return;
    env.scanning = true;
    renderLangPane(id);
    let res = null;
    try {
        res = backend.DetectToolchain ? await backend.DetectToolchain(toolId, env.pathOverride || '') : null;
    } catch (e) {
        res = {envs: []};
    }
    env.scanning = false;
    env.scannedAt = Date.now();
    const list = res && Array.isArray(res.envs) ? res.envs : [];
    env.envs = list;
    const prev = env.selectedPath;
    env.selectedPath = prev && list.some((x) => x.path && String(x.path).toLowerCase() === prev.toLowerCase()) ? prev : '';
    env.error = list.length ? '' : ((res && res.error) || '未找到可用环境');
    applySettings();
    renderLangPane(id);
}

async function scanLanguageAll(id) {
    const lang = LANG_DEFS.find((l) => l.id === id);
    if (!lang) return;
    for (const tool of lang.tools) {
        await scanLanguageTool(id, tool.id);
    }
}

// ---- 已安装的包列表：python（pip）与 node（npm）----

function pkgStateFor(id, scope) {
    const container = langEnvFor(id);
    if (!container.pkgs || typeof container.pkgs !== 'object') container.pkgs = {};
    if (!container.pkgs[scope] || typeof container.pkgs[scope] !== 'object') container.pkgs[scope] = {};
    return container.pkgs[scope];
}

function resetLangPkgs(id) {
    const container = langEnvFor(id);
    if (!container.pkgs || typeof container.pkgs !== 'object') return;
    for (const key of Object.keys(container.pkgs)) {
        container.pkgs[key].scannedAt = 0;
    }
}

function renderPkgScope(id, scope) {
    const lang = LANG_DEFS.find((l) => l.id === id);
    // scope 兼容传对象或 id 字符串
    const scopeDef = typeof scope === 'object'
        ? scope
        : ((lang.pkgs || []).find((s) => s.id === scope) || {id: scope, label: scope});
    const scopeId = scopeDef.id;
    const st = pkgStateFor(id, scopeId);
    const wrap = document.createElement('div');
    wrap.className = 'pkg-scope';

    const head = document.createElement('div');
    head.className = 'pkg-scope-head';
    const name = document.createElement('span');
    name.className = 'env-tool-head';
    name.style.marginBottom = '0';
    const dot = document.createElement('span');
    dot.className = 'env-dot' + (st.scanning ? ' busy' : (st.scannedAt ? (st.error ? ' fail' : ' ok') : ''));
    const nameText = document.createElement('span');
    nameText.textContent = scopeDef.label;
    name.append(dot, nameText);
    const count = document.createElement('span');
    count.className = 'pkg-count';
    count.textContent = st.scanning || st.error
        ? ''
        : (st.exists ? ((Array.isArray(st.list) ? st.list.length : 0) + ' 个包') : '未找到');
    name.appendChild(count);
    head.appendChild(name);

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'pkg-filter';
    filter.placeholder = '过滤包名…';
    filter.value = st.filterText || '';
    filter.addEventListener('input', () => {
        st.filterText = filter.value;
        renderPkgRows();
    });

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'tb-btn';
    refresh.textContent = '刷新';
    refresh.disabled = !!st.scanning;
    refresh.addEventListener('click', () => scanLanguagePkgs(id, scopeId));
    head.append(filter, refresh);
    wrap.appendChild(head);

    const listBox = document.createElement('div');
    listBox.className = 'pkg-list';
    const renderPkgRows = () => {
        listBox.textContent = '';
        if (st.scanning) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = '正在扫描…';
            listBox.appendChild(line);
            return;
        }
        if (st.error) {
            const line = document.createElement('div');
            line.className = 'env-error';
            line.textContent = st.error;
            listBox.appendChild(line);
            return;
        }
        if (!st.exists) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = scopeId === 'env'
                ? '未检测到可用的 Python 解释器'
                : (id === 'go' ? '当前工作区没有 go.mod' : '当前目录没有 package.json');
            listBox.appendChild(line);
            return;
        }
        const q = (st.filterText || '').trim().toLowerCase();
        const list = (Array.isArray(st.list) ? st.list : []).filter((p) => !q || String(p.name).toLowerCase().includes(q));
        if (!list.length) {
            const line = document.createElement('div');
            line.className = 'pkg-empty';
            line.textContent = q ? '没有匹配的包' : '没有已安装的包';
            listBox.appendChild(line);
            return;
        }
        for (const p of list) {
            const row = document.createElement('div');
            row.className = 'pkg-row';
            const n = document.createElement('span');
            n.className = 'pkg-name';
            n.textContent = p.name;
            const v = document.createElement('span');
            v.className = 'pkg-ver';
            v.textContent = p.version || '';
            row.append(n, v);
            listBox.appendChild(row);
        }
    };
    renderPkgRows();
    wrap.appendChild(listBox);
    return wrap;
}

async function scanLanguagePkgs(id, scope) {
    const scopeId = typeof scope === 'object' ? scope.id : scope;
    const st = pkgStateFor(id, scopeId);
    if (st.scanning) return;
    st.scanning = true;
    renderLangPane(id);
    const kind = id === 'python' ? 'pip' : (id === 'node' ? 'npm' : (id === 'go' ? 'go' : ''));
    // python：包列表跟随所选解释器；npm/project：用当前工作区目录
    let target = '';
    if (id === 'python') {
        const eff = effectiveToolEnv(id, 'python');
        target = (eff && eff.path) || '';
    } else if (scopeId === 'project') {
        target = termCwd() || '';
    }
    let res = null;
    try {
        res = backend.ListLangPackages ? await backend.ListLangPackages(kind, scopeId, target) : null;
    } catch (e) {
        res = {packages: [], exists: true, error: String((e && e.message) || e)};
    }
    st.scanning = false;
    st.scannedAt = Date.now();
    st.list = res && Array.isArray(res.packages) ? res.packages : [];
    st.exists = !!(res && res.exists !== false);
    st.error = (res && res.error) || '';
    applySettings();
    renderLangPane(id);
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
    // 扩展名列表太长很难看（纯文本有几十个），收进标题悬停提示
    const extensions = formats[id] && formats[id].extensions ? formats[id].extensions : [];
    if (extensions.length) title.title = '扩展名：' + extensions.join('、');
    pane.append(title);
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
    if (id === 'text') hint.textContent += ' txt/log/conf 默认按所在扩展名打开；CMake / Dockerfile / Git 规则等特殊文件名按代码视图打开。';
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
    logFrontend(isError ? 'error' : 'info', msg);
}

function updateWindowTitle() {
    const title = window.__aiFloatWindow ? 'AI 助手 · CaDt-DataLens' : (file ? file.name + ' - CaDt-DataLens' : 'CaDt-DataLens');
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
    scheduleSessionSave();
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
            // file 对齐到新活动 doc 时必须同步 currentMode，否则残留上一个 doc 的
            // 视图模式（browser doc 关闭后状态栏/工具条会卡在「网页视图」）
            currentMode = normalizeLegacySqlMode(fd);
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
    sql: '<svg viewBox="0 0 14 14" aria-hidden="true"><ellipse cx="7" cy="3.2" rx="4.7" ry="1.8" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2.3 3.2v7.6c0 1 2.1 1.8 4.7 1.8s4.7-.8 4.7-1.8V3.2" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2.3 7c0 1 2.1 1.8 4.7 1.8s4.7-.8 4.7-1.8" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>',
    code: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4.4 3.6 1.7 7l2.7 3.4M9.6 3.6 12.3 7l-2.7 3.4M7.9 2.4 6.1 11.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    text: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.6h5.6L11.4 4v8.4H3z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5 7.2h4M5 9.6h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    preview: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    binary: '<svg viewBox="0 0 14 14" aria-hidden="true"><text x="2" y="10.6" font-size="9" font-family="JetBrains Mono, Consolas, monospace" font-weight="700" fill="currentColor">01</text></svg>',
    render: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 11c2.8 0 3.4-7 6.2-7 1.7 0 2 1.6 3.8 1.6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="12" cy="5.6" r="1.1" fill="currentColor"/></svg>',
    patch: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.4h10M2 7h6.4M2 10.6h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M9.6 8.2l2.4 2.4-2.4 2.4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    split: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 2.6v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
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
    if (mode === 'patch') return !(doc.format && doc.format.patch);
    return false;
}

function buildGroupTools(gid) {
    const g = groupById(gid);
    if (!g || !g.docIds.length) return null;
    const doc = docs.find((d) => d.id === g.activeId) || groupDocs(g)[0];
    if (!doc) return null;
    const tools = document.createElement('div');
    tools.className = 'tb-tools';
    const activeMode = doc.splitActive ? 'split' : doc.mode;
    for (const [mode, label] of viewOptionsFor(doc.format, doc)) {
        // 不可用的视图不显示（IDEA 只列可用视图），不摆灰态占位
        if (viewDisabledFor(doc, mode)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        // SQL 是覆盖层：选中态独立于当前视图（开着才亮），底层视图按钮保持自己的选中态
        const on = mode === 'sql' ? !!doc.sqlActive : (activeMode === mode);
        btn.className = 'tb-view' + (on ? ' active' : '');
        btn.dataset.mode = mode;
        btn.title = label;
        btn.innerHTML = VIEW_ICONS[mode] || '';
        btn.addEventListener('click', async () => {
            if (file !== doc) await activateDoc(doc);
            if (mode === 'sql') {
                switchMode('sql');
            } else if (doc.splitActive || currentMode !== mode) {
                switchMode(mode);
            }
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

// 视图切换不一定重建标签条（底部状态栏、设置默认视图、快捷菜单等入口只调 switchMode），
// 这里按各分栏组当前文档同步视图按钮的选中态。
function syncTabViewTools() {
    for (const wrap of document.querySelectorAll('.egroup[data-gid]')) {
        const g = groupById(wrap.dataset.gid);
        const doc = g ? (docs.find((d) => d.id === g.activeId) || groupDocs(g)[0]) : null;
        const activeMode = doc ? (doc.splitActive ? 'split' : doc.mode) : '';
        for (const btn of wrap.querySelectorAll('.tb-view[data-mode]')) {
            const isSql = btn.dataset.mode === 'sql';
            btn.classList.toggle('active', isSql ? !!(doc && doc.sqlActive) : btn.dataset.mode === activeMode);
        }
    }
}

function showTabbarToolsMenu(x, y) {
    if (!ctxMenu) return;
    const clean = docs.filter((d) => !d.dirty);
    ctxMenu.open([
        {label: '新建浏览器标签页', icon: 'E721', action: () => openBrowserTab('about:blank')},
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

function bgTermTabIcon() {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg('terminal', 13);
    return span;
}

function buildGroupTab(g, doc, strip) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (doc.id === g.activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '') + (doc.staleOnDisk ? ' stale' : '');
    tab.dataset.docId = String(doc.id);
    tab.title = (doc.path || doc.name) + (doc.staleOnDisk ? '\n（已在外部修改）' : '');
    // 后台终端标签页用 terminal 图标（非文件，没有扩展名图标）
    const icon = doc.bgTerm ? bgTermTabIcon() : createFileIcon(doc.name, 'tab-icon');
    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = doc.name;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = '关闭';
    close.innerHTML = iconSvg('close', 12);
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
    syncAllBrowserTabs();
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
    syncAllBrowserTabs();
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
            sep.innerHTML = iconSvg('chevron-right', 10);
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

// ---- 状态栏「AI 写入」徽标 ----
// 由 ai-panel 的写操作事件驱动：每次落盘推一次状态，不轮询磁盘，
// 因此外部编辑器 / git 造成的改动不会点亮它。
// 显隐沿用状态栏既有做法（切换 display），自动隐藏时长与 flash() 的 5s 对齐。
const AI_WRITE_LABELS = {pending: '待确认', running: '写入中', done: '已修改', failed: '写入失败', denied: '被规则阻止'};
const AI_WRITE_TRANSIENT = new Set(['done', 'failed', 'denied']);
const AI_WRITE_HIDE_MS = 5000;
let aiWriteHideTimer = 0;

function hideAiWriteBadge() {
    if (aiWriteHideTimer) { clearTimeout(aiWriteHideTimer); aiWriteHideTimer = 0; }
    if (!els.stAiWrite) return;
    els.stAiWrite.style.display = 'none';
    els.stAiWrite.classList.remove('pending', 'running', 'done', 'failed', 'denied');
}

function updateAiWriteBadge(payload) {
    const el = els.stAiWrite;
    if (!el) return;
    if (aiWriteHideTimer) { clearTimeout(aiWriteHideTimer); aiWriteHideTimer = 0; }
    const state = payload && AI_WRITE_LABELS[payload.state] ? payload.state : 'idle';
    if (state === 'idle') {
        // 本轮结束不立刻抹掉「已修改」提示，交给瞬时态的自动隐藏计时器
        if (AI_WRITE_TRANSIENT.has(currentAiWriteState())) return;
        hideAiWriteBadge();
        return;
    }
    const label = AI_WRITE_LABELS[state];
    el.classList.remove('pending', 'running', 'done', 'failed', 'denied');
    el.classList.add(state);
    el.style.display = '';
    if (els.stAwState) els.stAwState.textContent = label;
    if (els.stAwPath) els.stAwPath.textContent = baseNameOf(payload.relPath || payload.path);
    if (els.stAwAdd) els.stAwAdd.textContent = payload.added > 0 ? '+' + payload.added : '';
    if (els.stAwDel) els.stAwDel.textContent = payload.removed > 0 ? '−' + payload.removed : '';
    const counts = (payload.added || payload.removed) ? '（+' + (payload.added || 0) + ' −' + (payload.removed || 0) + '）' : '';
    el.title = label + counts + '\n' + (payload.path || payload.relPath || '');
    if (AI_WRITE_TRANSIENT.has(state)) {
        aiWriteHideTimer = setTimeout(() => { aiWriteHideTimer = 0; hideAiWriteBadge(); }, AI_WRITE_HIDE_MS);
    }
}

function currentAiWriteState() {
    const el = els.stAiWrite;
    if (!el || el.style.display === 'none') return '';
    for (const state of Object.keys(AI_WRITE_LABELS)) {
        if (el.classList.contains(state)) return state;
    }
    return '';
}

function updateStatus() {
    if (aiPanel && aiPanel.refreshContext) {
        try { aiPanel.refreshContext(); } catch (e) {}
    }
    if (!file) return;
    scheduleSessionSave();
    syncTabViewTools();
    const fmt = file.format;
    const view = file.splitActive ? viewLabel('split') : viewLabel(file.sqlActive ? 'sql' : currentMode);
    els.stMode.textContent = formatDisplayName(file) + ' · ' + view + (file.large || file.binary || settings.readOnlyMode ? ' · 只读' : '');
    if (file.browser) {
        const url = String(file.browserUrl || '');
        els.stMode.textContent = '网页 · ' + (url === 'about:blank' ? '空白页' : (url.length > 60 ? url.slice(0, 60) + '…' : url));
        els.stSize.textContent = '';
        els.stZoom.textContent = '';
        els.stMdWidth.style.display = 'none';
        els.stEol.textContent = '';
        els.stEnc.textContent = '';
        const stCount = document.getElementById('st-count');
        if (stCount) stCount.textContent = '';
        if (els.stWriting) els.stWriting.style.display = 'none';
        els.stPos.textContent = '';
        return;
    }
    els.stSize.textContent = fmtSize(file.size);
    els.stSize.title = file.image && file.imageWidth ? file.imageWidth + ' × ' + file.imageHeight : '';
    const tableZoom = currentMode === 'table' && file.format && file.format.table;
    const svgScale = file.svgRenderScale && (currentMode === 'render' || (file.splitActive && file.splitKind === 'svg'));
    const renderZoom = svgScale ? Math.round(file.svgRenderScale * 100) + '%' : '';
    const zoom = file.image && currentMode === 'image' && file.imageScale
        ? Math.round(file.imageScale * 100) + '%'
        : renderZoom || (tableZoom ? Math.round((file.tableZoom || 1) * 100) + '%' : '');
    els.stZoom.textContent = zoom;
    els.stZoom.title = zoom
        ? (tableZoom ? '表格缩放比例（点击选择，Ctrl+滚轮调整）' : '图片缩放比例（点击选择，Ctrl+滚轮调整，双击图片恢复适配）')
        : '';
    const showMdWidth = !!(file.format && file.format.preview && currentMode === 'preview' && !file.large);
    els.stMdWidth.style.display = showMdWidth ? '' : 'none';
    els.stMdWidth.textContent = showMdWidth ? '宽度 · ' + mdPreviewWidthLabel(settings.mdPreviewWidth) : '';
    updateWordCount();
    updateWritingStats();
    applyWritingMode();
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
        hookMultiCursor(editor.aceEditor);
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

function codeFoldPreviewFor(ace, fold) {
    // JetBrains 风格：折叠后把块内容压成一行内联显示，括号保留在外面
    const inner = (ace.session.getTextRange(fold.range) || '').trim();
    if (!inner) return '';
    const flat = inner.replace(/\s+/g, ' ');
    const clipped = clipCodeFoldText(flat, 120);
    return clipped === flat ? flat : clipped + ' …';
}

function updateCodeFoldPreviews(ace) {
    if (!ace || !ace.session || !ace.session.getAllFolds) return;
    const folds = ace.session.getAllFolds();
    if (!folds.length) return;
    let changed = false;
    for (const fold of folds) {
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

// ---- 行书签：F11 切换光标行书签，F2/Shift+F2 循环跳转，gutter 紫色标记 ----

function bookmarkRowsForDoc(doc) {
    if (!doc || !doc.editor || !doc.editor.aceEditor) return [];
    try {
        return [...(doc.bookmarks || [])].sort((a, b) => a - b);
    } catch (e) {
        return [];
    }
}

function renderBookmarks(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    if (doc.bmApplied) {
        for (const [row, cls] of doc.bmApplied) {
            try { ace.session.removeGutterDecoration(row, cls); } catch (e) {}
        }
    }
    const list = [];
    const rows = bookmarkRowsForDoc(doc);
    let lineCount = 0;
    try { lineCount = ace.session.getLength(); } catch (e) { lineCount = 0; }
    for (const row of rows) {
        if (!(row >= 0) || row >= lineCount) continue;
        try {
            ace.session.addGutterDecoration(row, 'bm-gutter');
            list.push([row, 'bm-gutter']);
        } catch (e) {}
    }
    doc.bmApplied = list;
}

function toggleBookmark() {
    const ace = file && file.editor && file.editor.aceEditor;
    if (!ace) {
        flash('书签仅在代码/文本视图可用', true);
        return;
    }
    if (!file.bookmarks) file.bookmarks = new Set();
    const row = ace.getCursorPosition().row;
    if (file.bookmarks.has(row)) {
        file.bookmarks.delete(row);
        flash('已移除书签：' + (row + 1) + ' 行');
    } else {
        file.bookmarks.add(row);
        flash('已添加书签：' + (row + 1) + ' 行');
    }
    renderBookmarks(file);
}

function jumpBookmark(delta) {
    const ace = file && file.editor && file.editor.aceEditor;
    if (!ace) {
        flash('书签仅在代码/文本视图可用', true);
        return;
    }
    const rows = bookmarkRowsForDoc(file);
    if (!rows.length) {
        flash('当前文件还没有书签（F11 在光标行添加）', true);
        return;
    }
    const cur = ace.getCursorPosition().row;
    let target = null;
    if (delta > 0) target = rows.find((r) => r > cur);
    else {
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i] < cur) { target = rows[i]; break; }
        }
        if (target == null) target = rows[rows.length - 1];
    }
    if (target == null) target = rows[0];
    jumpToPosition(target + 1, 1);
}

// ---- 视图状态：光标/滚动/折叠/书签随会话保存 ----

function captureDocView(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return null;
    const view = {};
    try {
        const pos = ace.getCursorPosition();
        view.cursor = [pos.row, pos.column];
    } catch (e) {}
    try { view.scrollTop = Math.max(0, Math.round(ace.session.getScrollTop() || 0)); } catch (e) {}
    try {
        const folds = typeof ace.session.getAllFolds === 'function' ? ace.session.getAllFolds() : [];
        const ranges = [];
        for (const fold of folds || []) {
            const start = fold && fold.start ? fold.start.row : -1;
            const end = fold && fold.end ? fold.end.row : -1;
            if (start >= 0 && end > start) ranges.push([start, end]);
            if (ranges.length >= 500) break;
        }
        if (ranges.length) view.folds = ranges;
    } catch (e) {}
    const marks = bookmarkRowsForDoc(doc);
    if (marks.length) view.bookmarks = marks.slice(0, 500);
    if (!view.cursor && !view.scrollTop && !view.folds && !view.bookmarks) return null;
    return view;
}

function applyDocView(doc, view) {
    if (!doc || !view) return false;
    if (Array.isArray(view.bookmarks)) {
        doc.bookmarks = new Set(view.bookmarks.filter((n) => Number.isInteger(n) && n >= 0));
    }
    const ace = doc.editor && doc.editor.aceEditor;
    if (!ace) return false;
    renderBookmarks(doc);
    try {
        const Range = ace.Range || (ace.require && ace.require('ace/range').Range) ||
            (window.ace && window.ace.require ? window.ace.require('ace/range').Range : null);
        if (Range && Array.isArray(view.folds)) {
            const lineCount = ace.session.getLength();
            for (const pair of view.folds) {
                const start = Number(pair && pair[0]);
                const end = Number(pair && pair[1]);
                if (!(start >= 0) || !(end > start) || start >= lineCount) continue;
                try { ace.session.addFold('', new Range(start, 0, Math.min(end, lineCount - 1), Infinity)); } catch (e) {}
            }
        }
    } catch (e) {}
    try {
        if (Array.isArray(view.cursor)) {
            const lineCount = Math.max(1, ace.session.getLength());
            const row = Math.max(0, Math.min(lineCount - 1, Number(view.cursor[0]) || 0));
            const col = Math.max(0, Number(view.cursor[1]) || 0);
            ace.clearSelection();
            ace.moveCursorTo(row, col);
        }
    } catch (e) {}
    try {
        if (Number.isFinite(view.scrollTop)) ace.session.setScrollTop(view.scrollTop);
    } catch (e) {}
    return true;
}

function applyPendingDocView(doc) {
    if (!doc || !doc.path) return;
    const key = sessionPathKey(doc.path);
    const view = pendingDocViews.get(key);
    if (!view) return;
    pendingDocViews.delete(key);
    applyDocView(doc, view);
}

function rememberDocView(doc) {
    if (!doc || !doc.path) return;
    const key = sessionPathKey(doc.path);
    const view = captureDocView(doc) || knownDocViews.get(key);
    if (view) knownDocViews.set(key, view);
}

// ---- Git 行级标记：代码视图行号左侧色条（JetBrains 风格） ----
// 绿=新增、蓝=修改、灰点=此处上方有删除的行。数据来自 git diff HEAD（未保存内容不参与）。

const GIT_GUTTER_ADD = 'git-gutter-add';
const GIT_GUTTER_MOD = 'git-gutter-mod';
const GIT_GUTTER_DEL = 'git-gutter-del';

function renderGitGutter(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    if (doc.gitGutterApplied) {
        for (const [row, cls] of doc.gitGutterApplied) {
            try { ace.session.removeGutterDecoration(row, cls); } catch (e) {}
        }
    }
    const list = [];
    const marks = doc.gitGutterData;
    if (marks) {
        let lineCount = 0;
        try { lineCount = ace.session.getLength(); } catch (e) { lineCount = 0; }
        const put = (row, cls) => {
            if (!(row >= 0) || row >= lineCount) return;
            try {
                ace.session.addGutterDecoration(row, cls);
                list.push([row, cls]);
            } catch (e) {}
        };
        for (const row of marks.added) put(row, GIT_GUTTER_ADD);
        for (const row of marks.modified) put(row, GIT_GUTTER_MOD);
        for (const row of marks.delBefore) put(row, GIT_GUTTER_DEL);
    }
    doc.gitGutterApplied = list;
}

function clearGitGutterData(doc) {
    doc.gitGutterData = null;
    renderGitGutter(doc);
}

// scheduleGitGutter 按需取 git diff 并刷新标记；900ms 防抖，状态机见 refreshGitStatus。
function scheduleGitGutter(doc, delay) {
    if (!doc || !doc.path || doc.large || !gitStateCache.available || !gitStateCache.dir) return;
    const key = doc.path.replace(/\\/g, '/');
    const st = gitStateCache.map.get(key);
    if (!st || st === 'untracked') {
        // 无变更或未跟踪：清掉旧标记即可，不用对比
        if (doc.gitGutterData) clearGitGutterData(doc);
        return;
    }
    clearTimeout(doc.gitGutterTimer);
    doc.gitGutterTimer = setTimeout(async () => {
        doc.gitGutterTimer = 0;
        if (!docs.includes(doc) || !doc.path || doc.large || !doc.editor) return;
        if (!gitStateCache.available || !gitStateCache.dir) return;
        if (!backend.GitLineMarksFor) return;
        let text = '';
        try { text = doc.editor.getText(); } catch (e) { return; }
        try {
            // 直接对比 HEAD 与编辑器当前内容：未保存的输入也实时参与
            doc.gitGutterData = await backend.GitLineMarksFor(gitStateCache.dir, doc.path, text);
        } catch (e) {
            doc.gitGutterData = null;
        }
        renderGitGutter(doc);
    }, delay || 900);
}

// 多光标：Alt+单击添加光标；中键拖动建立列光标/矩形选区；普通单击回到单光标
function hookMultiCursor(ace) {
    if (!ace || ace._multiCursorHooked || !ace.container) return;
    ace._multiCursorHooked = true;
    try { ace.setOption('enableMultiselect', true); } catch (e) {}

    const pointAt = (e) => {
        try { return ace.renderer.screenToTextCoordinates(e.clientX, e.clientY); } catch (err) { return null; }
    };
    const rangeFor = (start, end) => {
        const range = ace.selection.getRange().clone();
        range.start = {row: start.row, column: start.column};
        range.end = {row: end.row, column: end.column};
        range.cursor = range.end;
        return range;
    };
    const refresh = () => {
        ace.renderer.updateCursor();
        ace.renderer.updateBackMarkers();
    };
    const applyRanges = (ranges) => {
        if (!ranges || !ranges.length) return;
        ace.selection.toSingleRange(ranges[0]);
        for (let i = 1; i < ranges.length; i++) ace.selection.addRange(ranges[i], true);
        refresh();
    };

    let drag = null;
    const onDragMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        const end = pointAt(e);
        if (!end) return;
        const from = ace.session.documentToScreenPosition(drag.start);
        const to = ace.session.documentToScreenPosition(end);
        let ranges = [];
        try { ranges = ace.selection.rectangularRangeBlock(from, to) || []; } catch (err) {}
        applyRanges(ranges);
        ace.renderer.scrollCursorIntoView(end, 0.15);
    };
    const onDragEnd = (e) => {
        if (!drag) return;
        drag = null;
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('mousemove', onDragMove, true);
        window.removeEventListener('mouseup', onDragEnd, true);
    };

    ace.container.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('.ace_gutter')) return;
        const altAdd = e.button === 0 && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
        const middle = e.button === 1;
        if (!altAdd && !middle) return;
        const pos = pointAt(e);
        if (!pos) return;
        e.preventDefault();
        e.stopPropagation();
        ace.focus();
        if (altAdd) {
            ace.selection.addRange(rangeFor(pos, pos));
            refresh();
            return;
        }
        ace.selection.toSingleRange(rangeFor(pos, pos));
        drag = {start: pos};
        refresh();
        window.addEventListener('mousemove', onDragMove, true);
        window.addEventListener('mouseup', onDragEnd, true);
    }, true);
    ace.container.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
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
    if (file.splitActive && file.htmlFrame) file.htmlFrame.srcdoc = '';
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
    if (typeof scheduleStructureRefresh === 'function') {
        doc.structureRev = (doc.structureRev || 0) + 1;
        scheduleStructureRefresh(doc);
    }
    if (doc.splitActive) scheduleSplitPreview(doc);
    scheduleGitGutter(doc);
}

// ---- 浏览器使用标签页：内容区内嵌 WebView2（browser-use） ----

// 地址栏目标解析：协议原样；Windows 绝对/UNC 路径转 file://；其余补 https://
function browserTargetUrl(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z]:[\\/]/.test(raw)) return encodeURI('file:///' + raw.replace(/\\/g, '/'));
    if (raw.startsWith('\\\\')) return encodeURI('file:' + raw.replace(/\\/g, '/'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    return 'https://' + raw;
}

// 地址栏里优先用户正在输入的内容，否则用当前页面地址
function browserAddressOf(doc) {
    const typed = doc.browserAddr ? String(doc.browserAddr.value || '').trim() : '';
    if (typed) return typed;
    const current = String(doc.browserUrl || '').trim();
    return current && current !== 'about:blank' ? current : '';
}

function openBrowserExternally(doc) {
    const target = browserAddressOf(doc);
    if (!target) {
        flash('地址栏为空，先输入网址或文件路径', true);
        return;
    }
    const url = browserTargetUrl(target);
    if (!url) return;
    if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

function showBrowserMoreMenu(doc, anchor) {
    if (!ctxMenu) return;
    const target = browserAddressOf(doc);
    const url = target ? browserTargetUrl(target) : '';
    const rect = anchor.getBoundingClientRect();
    ctxMenu.open([
        {label: '用默认浏览器打开', icon: 'browser', disabled: !url, action: () => openBrowserExternally(doc)},
        {label: '复制网页地址', icon: 'copy', disabled: !target, action: () => copyText(target, '网页地址')},
        {label: '在新标签页中打开', icon: 'new-window', disabled: !url, action: () => openBrowserTab(url, doc.browserProfile)},
        {sep: true},
        {label: '刷新页面', icon: 'refresh', action: () => backend.BrowserReload(doc.id).catch(() => {})},
        {label: '停止加载', icon: 'close', disabled: !doc.loading, action: () => backend.BrowserStop(doc.id).catch(() => {})},
    ], rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    // 菜单已进 DOM：作废显隐缓存，让同步逻辑把原生控件先藏起来（否则菜单会被它盖住）
    doc.browserApplied = null;
    syncBrowserTab(doc);
}

// ---------- 浏览器视口尺寸（用户菜单或 AI browser_resize 工具控制） ----------
// fit = 随标签页撑满（默认）；fixed = 固定宽高居中显示。.browser-surface 是唯一
// 真源：ResizeObserver 会把新尺寸同步到原生 WebView2（syncBrowserTab）。

const BROWSER_VIEWPORT_PRESETS = [
    {label: '1280 × 720（桌面）', width: 1280, height: 720},
    {label: '1440 × 900（桌面）', width: 1440, height: 900},
    {label: '375 × 812（iPhone）', width: 375, height: 812},
    {label: '768 × 1024（iPad）', width: 768, height: 1024},
];

// 解析「宽×高」文本（支持 × x * 与逗号分隔），非法返回 null
function parseBrowserViewportText(text) {
    const match = String(text || '').trim().match(/^(\d{1,5})\s*[×xX*,:，]\s*(\d{1,5})$/);
    if (!match) return null;
    const width = Math.round(Number(match[1]));
    const height = Math.round(Number(match[2]));
    if (width < 200 || width > 8000 || height < 200 || height > 8000) return null;
    return {mode: 'fixed', width, height};
}

function applyBrowserViewport(doc) {
    if (!doc || !doc.browserEl) return;
    const surface = doc.browserEl;
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) {
        surface.classList.remove('browser-surface-fixed');
        surface.style.width = '';
        surface.style.height = '';
        surface.style.flex = '';
        surface.style.margin = '';
    } else {
        surface.classList.add('browser-surface-fixed');
        surface.style.width = Math.round(vp.width) + 'px';
        surface.style.height = Math.round(vp.height) + 'px';
        surface.style.flex = 'none';
        surface.style.margin = 'auto';
    }
    updateBrowserViewportBtn(doc);
    syncBrowserTab(doc);
}

function setBrowserViewport(doc, viewport) {
    if (!doc || !doc.browserEl) return false;
    doc.browserViewport = viewport && viewport.mode === 'fixed' && viewport.width > 0 && viewport.height > 0
        ? {mode: 'fixed', width: Math.round(viewport.width), height: Math.round(viewport.height)}
        : {mode: 'fit'};
    applyBrowserViewport(doc);
    return true;
}

function browserViewportLabel(doc) {
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0)) return '自适应';
    return Math.round(vp.width) + '×' + Math.round(vp.height);
}

function updateBrowserViewportBtn(doc) {
    if (!doc || !doc.browserViewportBtn) return;
    doc.browserViewportBtn.textContent = browserViewportLabel(doc);
    doc.browserViewportBtn.title = '视口尺寸：' + browserViewportLabel(doc) + '（点击切换预设或自定义）';
}

function showBrowserViewportMenu(doc, anchor) {
    if (!ctxMenu) return;
    const rect = anchor.getBoundingClientRect();
    const vp = doc.browserViewport;
    const isFit = !vp || vp.mode !== 'fixed';
    const items = [{label: '自适应容器', checked: isFit, action: () => setBrowserViewport(doc, {mode: 'fit'})}, {sep: true}];
    for (const preset of BROWSER_VIEWPORT_PRESETS) {
        const active = !isFit && Math.round(vp.width) === preset.width && Math.round(vp.height) === preset.height;
        items.push({
            label: preset.label,
            checked: active,
            action: () => setBrowserViewport(doc, {mode: 'fixed', width: preset.width, height: preset.height}),
        });
    }
    items.push({sep: true});
    items.push({label: '自定义尺寸…', action: () => showBrowserViewportDialog(doc)});
    ctxMenu.open(items, rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    doc.browserApplied = null;
    syncBrowserTab(doc);
}

function showBrowserViewportDialog(doc) {
    const vp = doc.browserViewport && doc.browserViewport.mode === 'fixed' ? doc.browserViewport : {width: 1280, height: 800};
    openNameDialog({
        title: '自定义视口尺寸',
        label: '宽 × 高（像素，如 1280×800）',
        value: Math.round(vp.width) + '×' + Math.round(vp.height),
        placeholder: '1280×800',
        okLabel: '应用',
        onSubmit: async (value) => {
            const parsed = parseBrowserViewportText(value);
            if (!parsed) {
                throw new Error('格式应为「宽×高」，宽高各 200–8000 像素');
            }
            setBrowserViewport(doc, parsed);
            flash('浏览器视口已设为 ' + parsed.width + '×' + parsed.height);
        },
    });
}

function createBrowserView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active browser-pane';
    els.editor.appendChild(pane);
    const view = document.createElement('div');
    view.className = 'browser-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'browser-toolbar';
    const mkBtn = (icon, title, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'browser-btn';
        b.title = title;
        b.innerHTML = iconSvg(icon, 14);
        b.addEventListener('click', action);
        return b;
    };
    const backBtn = mkBtn('back', '后退', () => backend.BrowserGoBack(doc.id).catch(() => {}));
    const fwdBtn = mkBtn('forward', '前进', () => backend.BrowserGoForward(doc.id).catch(() => {}));
    const reloadBtn = mkBtn('refresh', '刷新', () => backend.BrowserReload(doc.id).catch(() => {}));
    // 左侧浏览器图标：交给系统默认浏览器打开当前地址/文件；右侧「更多」：复制地址、新标签页、刷新等
    const externalBtn = mkBtn('browser', '用默认浏览器打开', () => openBrowserExternally(doc));
    const moreBtn = mkBtn('more', '更多操作', () => showBrowserMoreMenu(doc, moreBtn));
    const addr = document.createElement('input');
    addr.className = 'browser-addr';
    addr.type = 'text';
    addr.spellcheck = false;
    addr.placeholder = '输入网址或文件路径后回车（默认 https://）';
    addr.value = doc.browserUrl && doc.browserUrl !== 'about:blank' ? doc.browserUrl : '';
    addr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const target = addr.value.trim();
        if (!target) return;
        const url = browserTargetUrl(target);
        if (!url) return;
        doc.browserUrl = url;
        backend.BrowserNavigate(doc.id, url).catch((err) => flash('导航失败：' + err, true));
    });
    // 视口尺寸按钮：预设（桌面/手机/平板）+ 自定义宽高；AI browser_resize 走同一入口
    const viewportBtn = document.createElement('button');
    viewportBtn.type = 'button';
    viewportBtn.className = 'browser-btn browser-viewport-btn';
    viewportBtn.addEventListener('click', () => showBrowserViewportMenu(doc, viewportBtn));
    toolbar.append(backBtn, fwdBtn, reloadBtn, externalBtn, addr, viewportBtn, moreBtn);
    const surface = document.createElement('div');
    surface.className = 'browser-surface';
    const empty = document.createElement('div');
    empty.className = 'browser-empty';
    empty.textContent = '网页区域加载中…';
    surface.appendChild(empty);
    view.append(toolbar, surface);
    pane.appendChild(view);
    doc.pane = pane;
    doc.browserEl = surface;
    doc.browserEmpty = empty;
    doc.browserAddr = addr;
    doc.browserBackBtn = backBtn;
    doc.browserFwdBtn = fwdBtn;
    doc.browserViewportBtn = viewportBtn;
    if (!doc.browserViewport) doc.browserViewport = {mode: 'fit'};
    updateBrowserViewportBtn(doc);
    if (typeof ResizeObserver === 'function') {
        doc.browserRO = new ResizeObserver(() => syncBrowserTab(doc));
        doc.browserRO.observe(surface);
        doc.browserRO.observe(pane);
    }
    syncBrowserTab(doc);
}

function browserSurfaceRect(doc) {
    if (!doc.browserEl || !doc.browserEl.isConnected) return null;
    const rect = doc.browserEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    return {
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        w: Math.round(rect.width * dpr),
        h: Math.round(rect.height * dpr),
    };
}

// WebView2 是原生窗口，永远盖在主 WebView 之上：对话框/菜单/面板等浮层打开时必须隐藏它
const BROWSER_POPUP_SELECTORS = [
    '.dialog:not(.hidden)',
    '.ai-model-editor-mask:not(.hidden)',
    '.ctx-menu:not(.hidden)',
    '#menubar .menu.open',
    '#palette-mask:not(.hidden)',
    '#ai-panel.ai-fullscreen:not(.hidden)',
];

function browserVisibleFor(doc) {
    if (doc !== file) return false;
    for (const sel of BROWSER_POPUP_SELECTORS) {
        if (document.querySelector(sel)) return false;
    }
    const mask = document.getElementById('split-mask');
    if (mask && mask.style.display === 'block') return false;
    return true;
}

let browserSyncPending = false;
function syncBrowserTab(doc) {
    if (!doc.browser || browserSyncPending || !backend.BrowserSetBounds) return;
    browserSyncPending = true;
    // setTimeout 而非 rAF：后台标签页 rAF 冻结会让 bounds/可见性同步永久卡住
    setTimeout(() => {
        browserSyncPending = false;
        if (!docs.includes(doc) || !doc.browserEl) return;
        const rect = browserSurfaceRect(doc);
        const visible = !!rect && browserVisibleFor(doc);
        const last = doc.browserApplied;
        // 轮询同步会反复进来：状态没变就别再跨进程调后端
        if (!visible) {
            if (last && !last.visible) return;
            doc.browserApplied = {visible: false};
            backend.BrowserSetVisible(doc.id, false).catch(() => {});
            return;
        }
        if (last && last.visible && last.x === rect.x && last.y === rect.y && last.w === rect.w && last.h === rect.h) return;
        doc.browserApplied = {visible: true, x: rect.x, y: rect.y, w: rect.w, h: rect.h};
        backend.BrowserSetBounds(doc.id, rect.x, rect.y, rect.w, rect.h).catch(() => {});
    }, 0);
}

function syncAllBrowserTabs() {
    for (const d of docs) {
        if (d.browser) syncBrowserTab(d);
    }
}

function updateBrowserTitle(doc, title) {
    if (!title || title === 'about:blank') return;
    if (doc.name !== title) {
        doc.name = title;
        renderTabs();
    }
    if (doc === file) {
        setFilename(doc.name, '');
        updateWindowTitle();
    }
}

// 补丁视图的宿主上下文：把主界面的能力（打开文件、重载、提示）注入进去，
// 补丁视图本身不直接依赖 main.js 的全局状态。
let patchViewHostCtx = null;

function patchRootPath() {
    if (explorer && typeof explorer.getRoot === 'function') return explorer.getRoot() || '';
    return workspaceFolder || '';
}

function patchAbsPath(rel) {
    const root = patchRootPath().replace(/[\\/]+$/, '');
    if (!root || !rel) return rel || '';
    return root + '/' + String(rel).replace(/\\/g, '/');
}

async function reloadAfterPatch(files) {
    if (explorer && explorer.refresh) explorer.refresh();
    for (const rel of files || []) {
        const doc = findDocByPath(patchAbsPath(rel));
        if (!doc) continue;
        if (doc.dirty) {
            flash(doc.name + ' 已被补丁修改，但编辑器里有未保存内容，未自动重载', true);
            continue;
        }
        if (doc === file) {
            patchViewHostCtx.suppressNotify = true;
            try { await reloadActive({quiet: true}); } catch (e) {}
            patchViewHostCtx.suppressNotify = false;
        } else {
            doc.staleOnDisk = true;
        }
    }
}

function patchViewContext() {
    if (patchViewHostCtx) return patchViewHostCtx;
    patchViewHostCtx = {
        backend,
        suppressNotify: false,
        getRoot: patchRootPath,
        openPath: (rel) => {
            const abs = patchAbsPath(rel);
            if (abs) openPath(abs);
        },
        notifyChanged: (files) => { reloadAfterPatch(files); },
        flash: (msg, isErr) => flash(msg, isErr),
    };
    return patchViewHostCtx;
}

// 补丁在代码视图里除 token 着色外，给整行铺淡底色（Ace marker，fullLine）。
// 超过 5000 行只保留 token 着色，避免 marker 过多拖慢滚动。
function refreshPatchMarkers(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || !doc.format || !doc.format.patch) return;
    const session = ace.session;
    if (!session) return;
    for (const id of (doc._patchMarkers || [])) {
        try { session.removeMarker(id); } catch (e) {}
    }
    doc._patchMarkers = [];
    const total = session.getLength();
    if (total > 5000) return;
    const aceLib = window.ace;
    if (!aceLib || typeof aceLib.require !== 'function') return;
    let Range = null;
    try { Range = aceLib.require('ace/range').Range; } catch (e) { return; }
    if (!Range) return;
    for (let row = 0; row < total; row += 1) {
        const text = session.getLine(row) || '';
        if (text.startsWith('+++') || text.startsWith('---')) continue;
        let cls = '';
        if (text.startsWith('+')) cls = 'dl-diff-add-line';
        else if (text.startsWith('-')) cls = 'dl-diff-del-line';
        if (!cls) continue;
        try {
            doc._patchMarkers.push(session.addMarker(new Range(row, 0, row, 1), cls, 'fullLine'));
        } catch (e) {
            break;
        }
    }
}


function createDocEditor(doc) {
    if (doc.editor) return;
    if (doc.browser) {
        createBrowserView(doc);
        return;
    }
    if (doc.bgTerm) {
        createBgTermView(doc);
        return;
    }
    const fmt = doc.format;
    const fs = getFormatSettings(fmt.id);
    const showJsonErrors = fmt.id === 'json' && /\.json$/i.test(doc.name || '');
    const patchRequested = !!fmt.patch && (doc.mode === 'patch' || !doc.mode);
    const tableRequested = !!fmt.table && doc.mode === 'table';
    const previewRequested = !!fmt.preview && doc.mode === 'preview';
    const splitRequested = doc.mode === 'split' && !!splitKindFor(doc);
    const imageRequested = !!fmt.image && doc.mode === 'image';
    const binaryMode = !!fmt.image || fmt.id === 'bytes';
    let startMode = doc.mode === 'text' ? 'text' : (!doc.treeAvailable ? 'code' : (doc.mode === 'code' ? 'code' : 'tree'));
    if (tableRequested || patchRequested) startMode = 'text';
    if (previewRequested || splitRequested) startMode = 'code';
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
            if (doc.splitActive && mode !== 'code') exitSplitView(doc);
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
                scheduleGitGutter(doc, 300);
            }, 0);
        },
        onError(err) {
            if (file === doc) flash(err.message, true);
        },
    });
    doc.editor = ed;
    doc.pane = pane;
    if (ed.aceEditor) {
        hookCodeFoldPreviews(ed.aceEditor);
        hookMultiCursor(ed.aceEditor);
        ed.aceEditor.on('changeSelection', scheduleWordCount);
        ed.aceEditor.on('input', scheduleWordCount);
        // 写作模式：光标变化驱动打字机滚动与段落聚焦（内部自判生效条件）
        ed.aceEditor.on('changeSelection', () => scheduleWritingCaret(ed.aceEditor));
        ed.aceEditor.on('input', () => scheduleWritingCaret(ed.aceEditor));
    }
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
    setupTreeContextMenu(doc);
    doc.mode = splitRequested ? 'split' : previewRequested ? 'preview' : tableRequested ? 'table' : imageRequested ? 'image' : binaryMode ? 'binary' : startMode;
    doc.text = ed.getText();
    // 打开/恢复/重载属于程序化全文替换：清掉码字观察基线，下一次观察以当前内容重新起算
    delete doc._writingLast;
    delete doc._writingBase;
    if (fmt.table) createCsvTableView(doc);
    if (fmt.preview) createMarkdownPreview(doc);
    if (fmt.image) createImageView(doc);
    if (patchRequested) showPatchView(doc, patchViewContext());
    if (tableRequested) showCsvTableView(doc);
    if (previewRequested) showMarkdownPreview(doc);
    if (imageRequested) showImageView(doc);
    if (!doc.dirty) doc.bases[doc.mode] = doc.text;
    applyReadOnlyToDoc(doc);
    doc.content = null;
    doc.loading = false;
    if (fmt.patch) refreshPatchMarkers(doc);
    scheduleGitGutter(doc, 200);
}

function createCsvTableView(doc) {
    if (doc.tableEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'csv-table-view';
    const bar = document.createElement('div');
    bar.className = 'csv-table-bar';
    const meta = document.createElement('span');
    meta.className = 'csv-table-meta';
    const filterWrap = document.createElement('label');
    filterWrap.className = 'csv-table-filter';
    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = '筛选所有列…';
    filterInput.title = '对所有列做子串筛选；只影响表格显示，不改文件内容';
    filterInput.spellcheck = false;
    const filterClear = document.createElement('button');
    filterClear.type = 'button';
    filterClear.className = 'csv-filter-clear';
    filterClear.textContent = '×';
    filterClear.title = '清除筛选';
    filterWrap.append(filterInput, filterClear);
    const hint = document.createElement('span');
    hint.className = 'csv-table-hint';
    hint.textContent = doc.large
        ? '文件超过 10 MB，表格只读'
        : '';
    const statsBtn = document.createElement('button');
    statsBtn.type = 'button';
    statsBtn.className = 'csv-stats-btn';
    statsBtn.textContent = '列统计';
    statsBtn.title = '查看当前列统计（也可右键表头指定列）';
    bar.append(meta, filterWrap, statsBtn, hint);
    const scroll = document.createElement('div');
    scroll.className = 'csv-table-scroll';
    wrap.append(bar, scroll);
    doc.pane.appendChild(wrap);
    doc.tableEl = wrap;
    doc.tableMeta = meta;
    doc.tableScroll = scroll;
    doc.tableFilterInput = filterInput;
    doc.tableFilterClear = filterClear;
    if (!doc.tableZoom) doc.tableZoom = 1;
    let filterTimer = 0;
    filterInput.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            filterTimer = 0;
            const view = ensureCsvView(doc);
            const next = filterInput.value;
            if (view.filter === next) return;
            view.filter = next;
            renderCsvTableView(doc, {resetScroll: true});
        }, 120);
    });
    filterClear.addEventListener('click', () => {
        filterInput.value = '';
        const view = ensureCsvView(doc);
        if (!view.filter) return;
        view.filter = '';
        renderCsvTableView(doc, {resetScroll: true});
    });
    statsBtn.addEventListener('pointerdown', () => {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('csv-cell') && active.dataset.col != null) {
            doc.csvActiveCol = Number(active.dataset.col);
        }
    });
    statsBtn.addEventListener('click', () => {
        if (doc !== file) return;
        const view = ensureCsvView(doc);
        let col = doc.csvActiveCol;
        if (!Number.isInteger(col)) col = view.sortCol >= 0 ? view.sortCol : 0;
        openCsvColumnStats(doc, col);
    });
    scroll.addEventListener('scroll', () => {
        if (doc.csvVirtual) scheduleCsvVirtualRender(doc);
    }, {passive: true});
    applyCsvTableZoom(doc);
}

function ensureCsvView(doc) {
    if (!doc.csvView) doc.csvView = {sortCol: -1, sortDir: 0, filter: ''};
    return doc.csvView;
}

const csvCollator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});

function csvSortKey(value) {
    const text = value == null ? '' : String(value);
    const trimmed = text.trim();
    if (!trimmed) return {empty: true, kind: 3, num: 0, str: ''};
    const num = Number(trimmed.replace(/,/g, ''));
    if (trimmed !== '' && Number.isFinite(num)) return {empty: false, kind: 0, num, str: trimmed};
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
        const time = Date.parse(trimmed);
        if (Number.isFinite(time)) return {empty: false, kind: 1, num: time, str: trimmed};
    }
    return {empty: false, kind: 2, num: 0, str: trimmed};
}

// 排序/筛选只产生视图索引，绝不改动 doc.tableRows 的原始顺序
function csvViewIndices(doc) {
    const view = ensureCsvView(doc);
    const rows = doc.tableRows || [];
    const headers = doc.tableHeaders || [];
    const filter = String(view.filter || '').trim().toLowerCase();
    const sortable = view.sortDir !== 0 && view.sortCol >= 0 && view.sortCol < headers.length;
    if (!filter && !sortable) return null;
    const indices = [];
    for (let i = 0; i < rows.length; i++) {
        if (filter) {
            const row = rows[i] || [];
            let hit = false;
            for (let c = 0; c < row.length; c++) {
                const cell = row[c] == null ? '' : String(row[c]);
                if (cell.toLowerCase().includes(filter)) {
                    hit = true;
                    break;
                }
            }
            if (!hit) continue;
        }
        indices.push(i);
    }
    if (sortable) {
        const col = view.sortCol;
        const dir = view.sortDir;
        indices.sort((a, b) => {
            const ka = csvSortKey((rows[a] || [])[col]);
            const kb = csvSortKey((rows[b] || [])[col]);
            if (ka.empty || kb.empty) {
                if (ka.empty === kb.empty) return a - b;
                return ka.empty ? 1 : -1;
            }
            let cmp;
            if (ka.kind === kb.kind && ka.kind !== 2) cmp = ka.num - kb.num;
            else cmp = csvCollator.compare(ka.str, kb.str);
            if (cmp === 0) cmp = a - b;
            return cmp * dir;
        });
    }
    return indices;
}

function computeCsvColumnStats(doc, col) {
    const rows = doc.tableRows || [];
    const values = [];
    let empty = 0;
    for (const row of rows) {
        const raw = (row || [])[col];
        const text = raw == null ? '' : String(raw);
        if (!text.trim()) empty++;
        else values.push(text);
    }
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let numericCount = 0;
    let dateCount = 0;
    let emailCount = 0;
    let urlCount = 0;
    let boolCount = 0;
    let maxLen = 0;
    const numbers = [];
    for (const text of values) {
        const trimmed = text.trim();
        maxLen = Math.max(maxLen, text.length);
        const num = Number(trimmed.replace(/,/g, ''));
        if (trimmed && Number.isFinite(num)) {
            numericCount++;
            numbers.push(num);
        }
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed) && Number.isFinite(Date.parse(trimmed))) dateCount++;
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) emailCount++;
        if (/^https?:\/\//i.test(trimmed)) urlCount++;
        if (/^(true|false|yes|no|是|否)$/i.test(trimmed)) boolCount++;
    }
    let type = '文本';
    if (values.length && numericCount === values.length) type = '数字';
    else if (values.length && dateCount === values.length) type = '日期';
    else if (values.length && emailCount === values.length) type = '邮箱';
    else if (values.length && urlCount === values.length) type = 'URL';
    else if (values.length && boolCount === values.length) type = '布尔';
    else if (counts.size && counts.size <= Math.min(20, Math.max(2, Math.round(values.length * 0.2)))) type = '枚举';
    const stats = {
        total: rows.length,
        nonEmpty: values.length,
        empty,
        unique: counts.size,
        maxLen,
        type,
        top,
        numeric: null,
    };
    if (values.length && numericCount === values.length) {
        let min = numbers[0];
        let max = numbers[0];
        let sum = 0;
        for (const n of numbers) {
            if (n < min) min = n;
            if (n > max) max = n;
            sum += n;
        }
        stats.numeric = {min, max, avg: sum / numbers.length};
    }
    return stats;
}

function closeCsvColumnStats(doc) {
    if (!doc) return;
    if (doc.csvStatsPanel) doc.csvStatsPanel.classList.add('hidden');
    doc.csvStatsOpen = false;
    if (doc.csvStatsEscHandler) {
        document.removeEventListener('keydown', doc.csvStatsEscHandler, true);
        doc.csvStatsEscHandler = null;
    }
}

function ensureCsvStatsPanel(doc) {
    if (doc.csvStatsPanel) return doc.csvStatsPanel;
    const panel = document.createElement('div');
    panel.className = 'csv-stats-panel hidden';
    panel.setAttribute('role', 'dialog');
    doc.tableEl.appendChild(panel);
    doc.csvStatsPanel = panel;
    return panel;
}

function openCsvColumnStats(doc, col) {
    const headers = doc.tableHeaders || [];
    if (!headers.length) return;
    const index = Math.max(0, Math.min(headers.length - 1, Number(col) || 0));
    doc.csvActiveCol = index;
    const panel = ensureCsvStatsPanel(doc);
    panel.textContent = '';
    const head = document.createElement('div');
    head.className = 'csv-stats-head';
    const title = document.createElement('span');
    title.className = 'csv-stats-title';
    title.textContent = '列统计 · ' + (headers[index] || '(空列名)');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'csv-stats-close';
    close.textContent = '×';
    close.title = '关闭（Esc）';
    close.addEventListener('click', () => closeCsvColumnStats(doc));
    head.append(title, close);
    panel.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'csv-stats-sub';
    sub.textContent = '第 ' + (index + 1) + ' 列';
    panel.appendChild(sub);
    const stats = computeCsvColumnStats(doc, index);
    const addRow = (label, value) => {
        const row = document.createElement('div');
        row.className = 'csv-stats-row';
        const key = document.createElement('span');
        key.className = 'csv-stats-label';
        key.textContent = label;
        const val = document.createElement('span');
        val.className = 'csv-stats-value';
        val.textContent = value;
        row.append(key, val);
        panel.appendChild(row);
    };
    addRow('行数', String(stats.total));
    addRow('非空 / 空', stats.nonEmpty + ' / ' + stats.empty);
    addRow('唯一值', String(stats.unique));
    if (stats.numeric) {
        const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
        addRow('最小 / 最大', fmt(stats.numeric.min) + ' / ' + fmt(stats.numeric.max));
        addRow('平均值', fmt(stats.numeric.avg));
    }
    addRow('最长值', stats.maxLen + ' 字符');
    addRow('疑似类型', stats.type);
    if (stats.top.length) {
        addRow('出现最多', stats.top.map(([value, count]) => value + '（' + count + '）').join('、'));
    }
    panel.classList.remove('hidden');
    doc.csvStatsOpen = true;
    if (!doc.csvStatsEscHandler) {
        doc.csvStatsEscHandler = (e) => {
            if (e.key !== 'Escape' || !doc.csvStatsOpen) return;
            e.preventDefault();
            e.stopPropagation();
            closeCsvColumnStats(doc);
        };
        document.addEventListener('keydown', doc.csvStatsEscHandler, true);
    }
}

function applyCsvTableZoom(doc) {
    if (!doc || !doc.tableEl) return;
    doc.tableEl.style.setProperty('--csv-zoom', String(doc.tableZoom || 1));
    if (doc.csvVirtual) {
        doc.csvRowScreenH = (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * (doc.tableZoom || 1);
        doc.csvVisibleStart = -1;
        doc.csvVisibleEnd = -1;
        scheduleCsvVirtualRender(doc);
    }
}

function zoomCsvTable(doc, deltaY) {
    if (!doc || !doc.tableEl || !deltaY) return;
    const dir = deltaY < 0 ? 1 : -1;
    const current = doc.tableZoom || 1;
    const next = Math.min(8, Math.max(0.25, Math.round((current + dir * 0.1) * 10) / 10));
    if (next === current) return;
    const scroll = doc.tableScroll;
    const oldRowH = doc.csvRowScreenH || (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * current;
    const topRow = oldRowH > 0 ? scroll.scrollTop / oldRowH : 0;
    doc.tableZoom = next;
    applyCsvTableZoom(doc);
    if (doc.csvVirtual && scroll) {
        scroll.scrollTop = Math.max(0, topRow * (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * next);
        doc.csvVisibleStart = -1;
        doc.csvVisibleEnd = -1;
        renderCsvVirtualRows(doc, true);
    }
    updateStatus();
}

const CSV_VIRTUAL_THRESHOLD = 300;
const CSV_VIRTUAL_OVERSCAN = 10;
const CSV_DEFAULT_ROW_LAYOUT_H = 24;

function estimateCsvColumnWidths(doc) {
    const headers = doc.tableHeaders || [];
    const rows = doc.tableRows || [];
    const widths = headers.map((header) => Math.max(CSV_COL_MIN_WIDTH, Math.min(420, 24 + String(header || '').length * 8)));
    const sample = Math.min(rows.length, 300);
    for (let i = 0; i < sample; i++) {
        const row = rows[i] || [];
        for (let c = 0; c < headers.length; c++) {
            const len = row[c] == null ? 0 : String(row[c]).length;
            const width = Math.min(420, 24 + Math.min(len, 48) * 8);
            if (width > widths[c]) widths[c] = width;
        }
    }
    return widths;
}

function createCsvVirtualRow(doc, editable, headerCount) {
    const tr = document.createElement('tr');
    tr.className = 'csv-row';
    const num = document.createElement('td');
    num.className = 'csv-rownum';
    tr.appendChild(num);
    const cells = [];
    for (let col = 0; col < headerCount; col++) {
        const td = document.createElement('td');
        td.className = 'csv-cell';
        if (editable) {
            td.contentEditable = 'plaintext-only';
            td.spellcheck = false;
            td.dataset.col = String(col);
            td.addEventListener('focus', () => { doc.csvActiveCol = col; });
            td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
            td.addEventListener('input', () => markCsvCellTyping(doc));
            td.addEventListener('blur', () => commitCsvCell(doc, td));
        }
        tr.appendChild(td);
        cells.push(td);
    }
    return {tr, num, cells};
}

function scheduleCsvVirtualRender(doc) {
    if (!doc || !doc.csvVirtual || doc.csvRenderScheduled) return;
    doc.csvRenderScheduled = true;
    requestAnimationFrame(() => {
        doc.csvRenderScheduled = false;
        renderCsvVirtualRows(doc);
    });
}

// 只更新视口附近的真实行，滚动时复用同一批 tr/td
function renderCsvVirtualRows(doc, force) {
    if (!doc || !doc.csvVirtual || !doc.csvTBody || !doc.csvTopSpacer || !doc.csvBottomSpacer) return;
    const scroll = doc.tableScroll;
    const tbody = doc.csvTBody;
    const total = doc.csvViewTotal || 0;
    const zoom = doc.tableZoom || 1;
    if (!doc.csvRowLayoutH) doc.csvRowLayoutH = CSV_DEFAULT_ROW_LAYOUT_H;
    let rowH = doc.csvRowScreenH || doc.csvRowLayoutH * zoom;
    if (!rowH || rowH < 6) rowH = CSV_DEFAULT_ROW_LAYOUT_H * zoom;
    const viewH = scroll.clientHeight || 480;
    const maxTop = Math.max(0, total * rowH - viewH);
    if (scroll.scrollTop > maxTop) scroll.scrollTop = maxTop;
    let start = Math.floor(scroll.scrollTop / rowH) - CSV_VIRTUAL_OVERSCAN;
    if (start < 0) start = 0;
    let count = Math.ceil(viewH / rowH) + CSV_VIRTUAL_OVERSCAN * 2;
    let end = Math.min(total, start + count);
    if (start >= total && total > 0) {
        start = Math.max(0, total - count);
        end = total;
    }
    if (!force && start === doc.csvVisibleStart && end === doc.csvVisibleEnd &&
        doc.csvPool && doc.csvPool.length && doc.csvPool[0].cells.length === doc.tableHeaders.length) {
        return;
    }
    if (start !== doc.csvVisibleStart || end !== doc.csvVisibleEnd) {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('csv-cell') && tbody.contains(active)) {
            active.blur();
        }
    }
    doc.csvVisibleStart = start;
    doc.csvVisibleEnd = end;
    const layoutH = doc.csvRowLayoutH;
    doc.csvTopSpacer.firstChild.style.height = Math.max(0, start * layoutH) + 'px';
    doc.csvBottomSpacer.firstChild.style.height = Math.max(0, (total - end) * layoutH) + 'px';
    const needed = Math.max(0, end - start);
    const headers = doc.tableHeaders || [];
    const rows = doc.tableRows || [];
    const indices = doc.csvViewIndices;
    const editable = !doc.large && !doc.binary && !settings.readOnlyMode;
    if (!doc.csvPool || (doc.csvPool.length && doc.csvPool[0].cells.length !== headers.length)) {
        for (const row of doc.csvPool || []) row.tr.remove();
        doc.csvPool = [];
    }
    while (doc.csvPool.length < needed) {
        const row = createCsvVirtualRow(doc, editable, headers.length);
        tbody.insertBefore(row.tr, doc.csvBottomSpacer);
        doc.csvPool.push(row);
    }
    for (let i = 0; i < doc.csvPool.length; i++) {
        const slot = doc.csvPool[i];
        if (i >= needed) {
            slot.tr.hidden = true;
            continue;
        }
        slot.tr.hidden = false;
        const viewPos = start + i;
        const rowIndex = indices ? indices[viewPos] : viewPos;
        const row = rows[rowIndex] || [];
        slot.num.textContent = String(rowIndex + 1);
        for (let col = 0; col < headers.length; col++) {
            const td = slot.cells[col];
            const display = row[col] == null ? '' : String(row[col]);
            if (td.textContent !== display) td.textContent = display;
            td.title = display;
            td.dataset.row = String(rowIndex);
            td.dataset.vpos = String(viewPos);
        }
    }
    const first = doc.csvPool.find((slot) => !slot.tr.hidden);
    if (first) {
        const measured = first.tr.getBoundingClientRect().height;
        if (measured > 4 && Math.abs(measured - (doc.csvRowScreenH || 0)) > 0.6) {
            doc.csvRowScreenH = measured;
            doc.csvRowLayoutH = measured / zoom;
            doc.csvTopSpacer.firstChild.style.height = Math.max(0, start * doc.csvRowLayoutH) + 'px';
            doc.csvBottomSpacer.firstChild.style.height = Math.max(0, (total - end) * doc.csvRowLayoutH) + 'px';
        }
    }
}

function renderCsvTableView(doc, opts = {}) {
    if (!doc || !doc.tableEl || !doc.editor) return;
    const scroll = doc.tableScroll;
    const keepTop = opts.resetScroll ? 0 : scroll.scrollTop;
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
    doc.tableHeaders = headers;
    doc.tableRows = rows;
    const view = ensureCsvView(doc);
    if (view.sortCol >= headers.length) {
        view.sortCol = -1;
        view.sortDir = 0;
    }
    if (doc.tableFilterInput && doc.tableFilterInput.value !== (view.filter || '')) {
        doc.tableFilterInput.value = view.filter || '';
    }
    const viewIndices = csvViewIndices(doc);
    const shown = viewIndices ? viewIndices.length : rows.length;
    doc.csvViewIndices = viewIndices;
    doc.csvViewTotal = shown;
    const virtual = shown > CSV_VIRTUAL_THRESHOLD;
    doc.csvVirtual = virtual;
    doc.csvVisibleStart = -1;
    doc.csvVisibleEnd = -1;
    doc.csvRenderScheduled = false;
    doc.csvPool = [];
    if (!Array.isArray(doc.tableColWidths) || doc.tableColWidths.length !== headers.length) {
        doc.tableColWidths = null;
    }
    if (virtual && !doc.tableColWidths) {
        doc.tableColWidths = estimateCsvColumnWidths(doc);
    }
    if (!doc.tableUndo) doc.tableUndo = [];
    if (!doc.tableRedo) doc.tableRedo = [];
    const filtered = !!String(view.filter || '').trim();
    doc.tableMeta.textContent = rows.length + ' 行 × ' + headers.length + ' 列' +
        (filtered ? ' · 匹配 ' + shown + ' 行' : '');
    if (!headers.length) {
        const empty = document.createElement('div');
        empty.className = 'csv-table-empty';
        empty.textContent = filtered ? '没有匹配的行' : '没有可显示的表格内容';
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
        th.title = header + (doc.large ? '' : '（点击排序）');
        if (view.sortCol === col && view.sortDir !== 0) {
            th.dataset.sort = view.sortDir > 0 ? 'asc' : 'desc';
        }
        const label = document.createElement('span');
        label.className = 'csv-head-text';
        label.textContent = header === '' ? '(空列名)' : header;
        const handle = document.createElement('span');
        handle.className = 'csv-col-resize';
        handle.title = '拖动调整列宽';
        handle.dataset.col = String(col);
        handle.addEventListener('pointerdown', (e) => startCsvColumnResize(doc, col, e));
        handle.addEventListener('click', (e) => e.stopPropagation());
        th.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.csv-col-resize')) return;
            if (doc !== file) return;
            doc.csvActiveCol = col;
            const csvView = ensureCsvView(doc);
            if (csvView.sortCol === col) {
                csvView.sortDir = csvView.sortDir === 1 ? -1 : (csvView.sortDir === -1 ? 0 : 1);
                if (csvView.sortDir === 0) csvView.sortCol = -1;
            } else {
                csvView.sortCol = col;
                csvView.sortDir = 1;
            }
            renderCsvTableView(doc, {resetScroll: true});
        });
        th.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            doc.csvActiveCol = col;
            if (!ctxMenu) return;
            const csvView = ensureCsvView(doc);
            ctxMenu.open([
                {
                    label: '升序排序',
                    icon: 'E70D',
                    action: () => {
                        csvView.sortCol = col;
                        csvView.sortDir = 1;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {
                    label: '降序排序',
                    icon: 'E70E',
                    action: () => {
                        csvView.sortCol = col;
                        csvView.sortDir = -1;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {
                    label: '清除排序',
                    disabled: csvView.sortDir === 0,
                    action: () => {
                        csvView.sortCol = -1;
                        csvView.sortDir = 0;
                        renderCsvTableView(doc, {resetScroll: true});
                    },
                },
                {sep: true},
                {label: '列统计…', icon: 'E9D2', action: () => openCsvColumnStats(doc, col)},
            ], e.clientX, e.clientY);
        });
        th.append(label, handle);
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    if (virtual) {
        const topSpacer = document.createElement('tr');
        topSpacer.className = 'csv-spacer';
        topSpacer.appendChild(document.createElement('td'));
        const bottomSpacer = document.createElement('tr');
        bottomSpacer.className = 'csv-spacer';
        bottomSpacer.appendChild(document.createElement('td'));
        const colspanCell = (row) => {
            const cell = row.firstChild;
            cell.colSpan = headers.length + 1;
            cell.style.padding = '0';
            cell.style.border = '0';
            return cell;
        };
        colspanCell(topSpacer);
        colspanCell(bottomSpacer);
        tbody.append(topSpacer, bottomSpacer);
        doc.csvTBody = tbody;
        doc.csvTopSpacer = topSpacer;
        doc.csvBottomSpacer = bottomSpacer;
    } else {
        doc.csvTBody = tbody;
        doc.csvTopSpacer = null;
        doc.csvBottomSpacer = null;
    }
    const fragment = document.createDocumentFragment();
    const editable = !doc.large && !doc.binary && !settings.readOnlyMode;
    if (!virtual) {
        for (let viewRow = 0; viewRow < shown; viewRow++) {
            const rowIndex = viewIndices ? viewIndices[viewRow] : viewRow;
            const row = rows[rowIndex] || [];
            const tr = document.createElement('tr');
            const num = document.createElement('td');
            num.className = 'csv-rownum';
            num.textContent = String(rowIndex + 1);
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
                    td.dataset.row = String(rowIndex);
                    td.dataset.col = String(col);
                    td.dataset.vpos = String(viewRow);
                    td.addEventListener('focus', () => { doc.csvActiveCol = col; });
                    td.addEventListener('keydown', (e) => onCsvCellKeyDown(doc, e));
                    td.addEventListener('input', () => markCsvCellTyping(doc));
                    td.addEventListener('blur', () => commitCsvCell(doc, td));
                }
                tr.appendChild(td);
            }
            fragment.appendChild(tr);
        }
    }
    tbody.appendChild(fragment);
    table.appendChild(tbody);
    scroll.appendChild(table);
    scroll.scrollTop = keepTop;
    scroll.scrollLeft = keepLeft;
    if (virtual) {
        renderCsvVirtualRows(doc, true);
        if (scroll.scrollTop !== keepTop) {
            scroll.scrollTop = keepTop;
            renderCsvVirtualRows(doc, true);
        }
    }
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
    if (doc.csvVirtual && td.dataset.vpos != null) {
        const targetPos = Number(td.dataset.vpos) + offset;
        const total = doc.csvViewTotal || 0;
        if (!(targetPos >= 0) || targetPos >= total) {
            td.blur();
            return;
        }
        const selector = 'td.csv-cell[data-vpos="' + targetPos + '"]';
        let target = doc.tableScroll.querySelector(selector);
        if (!target) {
            const rowH = doc.csvRowScreenH || (doc.csvRowLayoutH || CSV_DEFAULT_ROW_LAYOUT_H) * (doc.tableZoom || 1);
            doc.tableScroll.scrollTop = Math.max(0, targetPos * rowH - doc.tableScroll.clientHeight / 2);
            renderCsvVirtualRows(doc, true);
            target = doc.tableScroll.querySelector(selector);
        }
        if (!target) {
            td.blur();
            return;
        }
        target.focus();
        target.scrollIntoView({block: 'nearest', inline: 'nearest'});
        return;
    }
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

function renderMarkdownPreview(doc, opts = {}) {
    if (!doc || !doc.editor || !doc.previewBody) return;
    const scrollTop = doc.previewScroll ? doc.previewScroll.scrollTop : 0;
    try {
        const patched = !!(opts.incremental && patchMarkdownPreview(doc));
        if (!patched) doc.previewBody.innerHTML = renderMarkdownBlocksHtml(doc.editor.getText());
        resolveMarkdownImages(doc);
    } catch (e) {
        doc.previewBody.textContent = 'Markdown 渲染失败：' + e.message;
    }
    if (doc.previewScroll) doc.previewScroll.scrollTop = scrollTop;
    mdSyncScrollFromAce(doc);
    renderMermaidBlocks(doc.previewBody);
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

// ---- 单标签页分屏：左源码 / 右预览 ----

function splitRatioFor(doc) {
    const r = Number(doc && doc.splitRatio != null ? doc.splitRatio : settings.splitRatio);
    return Number.isFinite(r) ? Math.min(0.85, Math.max(0.15, r)) : 0.5;
}

function ensureSplitDivider(doc) {
    if (doc.splitDivider || !doc.pane) return;
    const bar = document.createElement('div');
    bar.className = 'vp-split-divider';
    bar.title = '拖动调整左右宽度';
    doc.pane.appendChild(bar);
    bar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !doc.pane) return;
        const rect = doc.pane.getBoundingClientRect();
        if (rect.width < 40) return;
        const startX = e.clientX;
        const startRatio = splitRatioFor(doc);
        setDragCursor('ew');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const ratio = Math.min(0.85, Math.max(0.15, startRatio + (ev.clientX - startX) / rect.width));
            doc.splitRatio = ratio;
            doc.pane.style.setProperty('--split-ratio', String(ratio));
            if (!doc._splitResizePending) {
                doc._splitResizePending = true;
                requestAnimationFrame(() => {
                    doc._splitResizePending = false;
                    if (doc.editor && doc.editor.aceEditor) {
                        try { doc.editor.aceEditor.resize(); } catch (err) {}
                    }
                });
            }
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            setDragCursor(null);
            document.body.style.userSelect = '';
            settings.splitRatio = doc.splitRatio;
            try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch (err) {}
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    doc.splitDivider = bar;
}

// ---- Markdown 分屏滚动同步：左源码滚动 → 右预览按比例跟随（单向，不回环） ----

function mdSyncScrollFromAce(doc) {
    if (!doc || !doc.splitActive || doc.splitKind !== 'markdown') return;
    if (settings.mdScrollSync === false) return;
    const scroll = doc.previewScroll;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!scroll || !ace) return;
    let ratio = 0;
    try {
        // 比例统一用屏幕坐标系（像素同源）：文档行经 documentToScreenRow 转换，
        // 否则开启自动换行时与反向（预览→源码按像素驱动）的坐标系不一致
        const firstDoc = ace.getFirstVisibleRow();
        const first = ace.session.documentToScreenRow(firstDoc, 0);
        const last = ace.session.documentToScreenRow(ace.getLastVisibleRow(), 0);
        const visRows = Math.max(1, last - first + 1);
        const denom = ace.session.getScreenLength() - visRows;
        ratio = denom > 0 ? Math.min(1, Math.max(0, first / denom)) : 0;
    } catch (e) {
        return;
    }
    const max = scroll.scrollHeight - scroll.clientHeight;
    if (max <= 0) return;
    doc._previewEcho = Math.round(ratio * max);
    scroll.scrollTop = doc._previewEcho;
}

// 反方向：预览滚动 → 源码跟随。该内核 session.setScrollTop 收像素
// （scrollToLine 内部就是 getPixelPosition(row).top 直接喂给 setScrollTop）。
function mdSyncScrollFromPreview(doc) {
    if (!doc || !doc.splitActive || doc.splitKind !== 'markdown') return;
    if (settings.mdScrollSync === false) return;
    const scroll = doc.previewScroll;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!scroll || !ace) return;
    const denom = scroll.scrollHeight - scroll.clientHeight;
    if (denom <= 0) return;
    const ratio = Math.min(1, Math.max(0, scroll.scrollTop / denom));
    try {
        const lineHeight = ace.renderer.lineHeight || 16;
        const scroller = ace.renderer.scroller || ace.container;
        const maxPx = Math.max(0, ace.session.getScreenLength() * lineHeight - scroller.clientHeight);
        if (maxPx <= 0) return;
        doc._aceEcho = Math.round(ratio * maxPx);
        ace.session.setScrollTop(doc._aceEcho);
    } catch (e) {}
}

// hookPreviewScrollSync 监听预览滚动做反向同步；自激事件（左源码写入引起）值与
// _previewEcho 相同，直接忽略，防止两侧互相追逐。
function hookPreviewScrollSync(doc) {
    const scroll = doc && doc.previewScroll;
    if (!scroll || doc._splitPreviewHooked === scroll) return;
    doc._splitPreviewHooked = scroll;
    const onScroll = () => {
        if (!doc.splitActive || doc.splitKind !== 'markdown') return;
        if (settings.mdScrollSync === false) return;
        if (Math.round(scroll.scrollTop) === doc._previewEcho) return;
        mdSyncScrollFromPreview(doc);
    };
    scroll.addEventListener('scroll', onScroll);
    doc._splitPreviewDetach = () => {
        scroll.removeEventListener('scroll', onScroll);
        doc._splitPreviewHooked = null;
        doc._splitPreviewDetach = null;
    };
}

// hookSplitScrollSync 挂 Ace 滚动监听；setMode 可能更换 session，用 changeSession 重新挂。
// changeScrollTop 触发时渲染层还没更新到新位置，延一帧再读，否则比例会慢一拍。
function hookSplitScrollSync(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || doc._splitSyncAce === ace) return;
    unhookSplitScrollSync(doc);
    // changeScrollTop 回调参数就是滚动值（像素）：预览反向驱动写入的值与 _aceEcho 相同，忽略
    const onScroll = (top) => {
        if (top != null && Math.round(top) === doc._aceEcho) return;
        if (doc._splitSyncRaf) cancelAnimationFrame(doc._splitSyncRaf);
        doc._splitSyncRaf = requestAnimationFrame(() => {
            doc._splitSyncRaf = 0;
            mdSyncScrollFromAce(doc);
        });
    };
    const attach = (sess) => {
        if (!sess || sess === doc._splitSyncSession) return;
        detachSession();
        doc._splitSyncSession = sess;
        sess.on('changeScrollTop', onScroll);
    };
    const detachSession = () => {
        if (doc._splitSyncSession) {
            try { doc._splitSyncSession.off('changeScrollTop', onScroll); } catch (e) {}
            doc._splitSyncSession = null;
        }
    };
    const onSession = (e) => attach(e && e.session ? e.session : ace.session);
    doc._splitSyncAce = ace;
    doc._splitSyncDetach = () => {
        detachSession();
        try { ace.off('changeSession', onSession); } catch (e) {}
    };
    attach(ace.session);
    ace.on('changeSession', onSession);
}

function unhookSplitScrollSync(doc) {
    if (doc && doc._splitSyncDetach) {
        try { doc._splitSyncDetach(); } catch (e) {}
    }
    if (doc) {
        if (doc._splitSyncRaf) {
            cancelAnimationFrame(doc._splitSyncRaf);
            doc._splitSyncRaf = 0;
        }
        doc._splitSyncAce = null;
        doc._splitSyncDetach = null;
        doc._splitSyncSession = null;
    }
}

function createHtmlPreviewView(doc) {
    if (doc.htmlPreviewEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'html-preview-view';
    const frame = document.createElement('iframe');
    frame.className = 'html-preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = doc.name || 'HTML 预览';
    wrap.appendChild(frame);
    doc.pane.appendChild(wrap);
    doc.htmlPreviewEl = wrap;
    doc.htmlFrame = frame;
}

function relativeDirUrl(root, filePath) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const r = norm(root);
    const d = norm(parentFolderOf(filePath));
    if (!r || !d) return '';
    if (d.toLowerCase() === r.toLowerCase()) return '';
    if (!d.toLowerCase().startsWith(r.toLowerCase() + '/')) return '';
    return d.slice(r.length + 1).split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
}

async function ensureHtmlPreviewRoot(doc) {
    if (doc.htmlPreviewRoot || !doc.path || !backend.RegisterPreviewRoot) return;
    let root = '';
    if (workspaceFolder && pathWithinValue(workspaceFolder, doc.path)) root = workspaceFolder;
    else root = parentFolderOf(doc.path);
    if (!root) return;
    try {
        const token = await backend.RegisterPreviewRoot(root);
        if (token) doc.htmlPreviewRoot = {root, token};
    } catch (e) {}
}

function injectHtmlBase(text, baseTag) {
    const src = String(text || '');
    if (!baseTag) return src;
    const doctype = /^\s*<!doctype[^>]*>/i.exec(src);
    if (doctype) return src.slice(0, doctype[0].length) + baseTag + src.slice(doctype[0].length);
    return baseTag + src;
}

function renderHtmlPreview(doc) {
    if (!doc || !doc.htmlFrame || !doc.editor) return;
    const apply = () => {
        if (!doc.htmlFrame || !doc.editor) return;
        let base = '<base target="_blank">';
        if (doc.htmlPreviewRoot) {
            const sub = relativeDirUrl(doc.htmlPreviewRoot.root, doc.path);
            base = '<base href="/__local/' + doc.htmlPreviewRoot.token + '/' + sub + '" target="_blank">';
        }
        doc.htmlFrame.srcdoc = injectHtmlBase(doc.editor.getText(), base);
    };
    if (doc.htmlPreviewRoot || doc.htmlRootTried || !doc.path) {
        apply();
        return;
    }
    doc.htmlRootTried = true;
    ensureHtmlPreviewRoot(doc).then(apply).catch(() => apply());
}

// SVG 渲染用的源文本：渲染视图下 jsoneditor 可能已把树值序列化成 JSON 填进编辑器，
// 真源保存在 _svgSrcText；其余情况以编辑器文本为准，最后回退打开时的原文。
function svgSourceFor(doc) {
    if (!doc) return '';
    if (doc.mode === 'render' && doc._svgSrcText != null && doc._svgSrcText.trim()) return doc._svgSrcText;
    let text = '';
    try { text = doc.editor ? doc.editor.getText() : ''; } catch (e) { text = ''; }
    if (!text.trim() && doc._svgSrcText != null && doc._svgSrcText.trim()) text = doc._svgSrcText;
    if (!text.trim() && doc.rawText != null) text = doc.rawText;
    return text;
}

function looksLikeSvg(text) {
    return /<svg[\s>]/i.test(String(text || ''));
}

// 渲染失败时隐藏 <img> 并在画布中央显示原因，避免只剩一片空白（图片 onerror 原本没有处理）
function setSvgRenderError(doc, message) {
    if (!doc || !doc.svgRenderImg) return;
    const status = doc.svgRenderStatus;
    if (!message) {
        doc.svgRenderError = '';
        doc.svgRenderImg.style.display = '';
        if (status) {
            status.classList.add('hidden');
            status.textContent = '';
        }
        return;
    }
    doc.svgRenderError = message;
    doc.svgRenderImg.style.display = 'none';
    if (status) {
        status.textContent = message;
        status.classList.remove('hidden');
    }
}

function renderSplitSvg(doc) {
    if (!doc || !doc.svgRenderImg || !doc.editor) return;
    const text = svgSourceFor(doc);
    if (!text || !text.trim()) {
        setSvgRenderError(doc, '当前没有可渲染的 SVG 源码');
        return;
    }
    if (!looksLikeSvg(text)) {
        setSvgRenderError(doc, '当前源码不是 SVG（缺少 <svg> 根元素），已停止渲染');
        return;
    }
    setSvgRenderError(doc, '');
    doc.svgRenderImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
}

function renderSplitPreview(doc) {
    if (!doc || !doc.splitActive) return;
    if (doc.splitKind === 'markdown') renderMarkdownPreview(doc, {incremental: true});
    else if (doc.splitKind === 'svg') renderSplitSvg(doc);
    else if (doc.splitKind === 'html') renderHtmlPreview(doc);
}

function scheduleSplitPreview(doc) {
    if (!doc || !doc.splitActive) return;
    clearTimeout(doc.splitTimer);
    doc.splitTimer = setTimeout(() => {
        doc.splitTimer = 0;
        renderSplitPreview(doc);
    }, doc.splitKind === 'html' ? 350 : 160);
}

function enterSplitView(doc) {
    if (!doc || !doc.editor) return;
    const kind = splitKindFor(doc);
    if (!kind) {
        flash('当前文件不支持分屏预览', true);
        return;
    }
    if (doc.large || doc.binary) {
        flash('大文件不支持分屏预览', true);
        return;
    }
    if (doc.splitActive) {
        if (doc.pane) doc.pane.style.setProperty('--split-ratio', String(splitRatioFor(doc)));
        renderSplitPreview(doc);
        if (kind === 'markdown') {
            hookSplitScrollSync(doc);
            hookPreviewScrollSync(doc);
            mdSyncScrollFromAce(doc);
        }
        setTimeout(() => {
            if (doc.editor && doc.editor.aceEditor) {
                try { doc.editor.aceEditor.resize(); } catch (e) {}
            }
        }, 0);
        return;
    }
    const loading = doc.loading;
    doc.loading = true;
    try {
        let src = null;
        if (kind === 'svg' && doc.mode === 'tree') {
            try { src = doc.format.stringify(doc.editor.get()); } catch (e) {}
        }
        // 从渲染视图切分屏时真源是 _svgSrcText：走到这里时编辑器文本可能已经被序列化成 JSON
        if (src == null) src = kind === 'svg' ? svgSourceFor(doc) : doc.editor.getText();
        doc.editor.setMode('code');
        if (kind === 'svg') doc.editor.setText(src);
        doc.text = doc.editor.getText();
        if (!doc.dirty) doc.bases.code = doc.text;
        doc.mode = 'code';
        currentMode = 'code';
        if (doc.pane) {
            doc.pane.classList.remove('preview-active', 'svg-render-active');
            doc.pane.classList.add('split-active');
            doc.pane.classList.toggle('split-markdown', kind === 'markdown');
            doc.pane.classList.toggle('split-svg', kind === 'svg');
            doc.pane.classList.toggle('split-html', kind === 'html');
            doc.pane.style.setProperty('--split-ratio', String(splitRatioFor(doc)));
        }
        if (kind === 'markdown') createMarkdownPreview(doc);
        else if (kind === 'svg') createSvgRenderView(doc);
        else if (kind === 'html') createHtmlPreviewView(doc);
        ensureSplitDivider(doc);
        doc.splitKind = kind;
        doc.splitActive = true;
        renderSplitPreview(doc);
        if (kind === 'markdown') {
            hookSplitScrollSync(doc);
            hookPreviewScrollSync(doc);
        }
        applyAceMode(true);
        showBanner(doc, doc.parseError);
        updateStatus();
        updateSearchState();
    } catch (e) {
        flash('打开分屏失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    setTimeout(() => {
        if (doc.splitActive && doc.editor && doc.editor.aceEditor) {
            try { doc.editor.aceEditor.resize(); } catch (e) {}
        }
    }, 0);
}

function exitSplitView(doc) {
    if (!doc || !doc.splitActive) return;
    doc.splitActive = false;
    doc.splitKind = '';
    clearTimeout(doc.splitTimer);
    doc.splitTimer = 0;
    unhookSplitScrollSync(doc);
    if (doc._splitPreviewDetach) {
        try { doc._splitPreviewDetach(); } catch (e) {}
    }
    if (doc.htmlFrame) doc.htmlFrame.srcdoc = '';
    if (doc.splitDivider) {
        doc.splitDivider.remove();
        doc.splitDivider = null;
    }
    if (doc.pane) {
        doc.pane.classList.remove('split-active', 'split-markdown', 'split-svg', 'split-html');
        doc.pane.style.removeProperty('--split-ratio');
    }
    if (doc.editor && doc.editor.aceEditor) {
        try { doc.editor.aceEditor.resize(); } catch (e) {}
    }
    syncTabViewTools();
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
    // 真源优先用进入渲染视图时保存的 _svgSrcText（树模式下 getText() 是 JSON 序列化）
    const svgText = svgSourceFor(doc);
    if (!svgText || !svgText.trim()) {
        setSvgRenderError(doc, '当前没有可渲染的 SVG 源码');
        return;
    }
    if (!looksLikeSvg(svgText)) {
        setSvgRenderError(doc, '当前内容不是 SVG（缺少 <svg> 根元素），已停止渲染');
        return;
    }
    setSvgRenderError(doc, '');
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
        // setMode('code') 会把树值序列化成 JSON 填进编辑器，必须立刻写回 SVG 源文本，
        // 否则随后切分屏/保存拿到的都是 JSON（渲染本身正常，分屏则整片空白）
        doc.editor.setText(src);
        doc.text = src;
        if (!doc.dirty) doc.bases.code = src;
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
        setSvgRenderError(doc, '');
        applySvgZoom(doc);
    };
    img.onerror = () => setSvgRenderError(doc, 'SVG 渲染失败：浏览器无法解码该内容');
    const status = document.createElement('div');
    status.className = 'svg-render-status hidden';
    scroll.append(img, status);
    doc.svgRenderScroll = scroll;
    doc.svgRenderStatus = status;
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

// ---------- 大文件只读 SQL 查询视图 ----------

function sqlKindFor(doc) {
    if (!doc) return '';
    if (doc.format && doc.format.id === 'jsonl') return 'jsonl';
    const ext = String(doc.name || '').split('.').pop().toLowerCase();
    return ext === 'tsv' ? 'tsv' : 'csv';
}

function currentSqlSourceText(doc) {
    try {
        if (doc && doc.editor) {
            const sourceMode = doc.sqlSourceMode || doc.mode;
            if (sourceMode === 'tree' && doc.format && typeof doc.format.stringify === 'function') {
                return doc.format.stringify(doc.editor.get());
            }
            return doc.editor.getText();
        }
    } catch (e) {}
    return (doc && (doc.text || doc.savedText || doc.content)) || '';
}

function createSqlView(doc) {
    if (!doc || !doc.pane || doc.sqlEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'sql-view';
    const bar = document.createElement('div');
    bar.className = 'sql-bar';
    const meta = document.createElement('span');
    meta.className = 'sql-meta';
    meta.textContent = '尚未导入';
    const hint = document.createElement('span');
    hint.className = 'sql-hint';
    hint.textContent = '查询临时副本，不会修改原文件';
    const limit = document.createElement('select');
    limit.className = 'sql-limit opt-select';
    for (const n of [100, 500, 1000, 5000]) {
        const option = document.createElement('option');
        option.value = String(n);
        option.textContent = '最多 ' + n + ' 行';
        limit.appendChild(option);
    }
    limit.value = '500';
    const reimport = document.createElement('button');
    reimport.type = 'button';
    reimport.className = 'sql-btn';
    reimport.textContent = '重新导入';
    bar.append(meta, hint, limit, reimport);
    const queryWrap = document.createElement('div');
    queryWrap.className = 'sql-query-wrap';
    const input = document.createElement('textarea');
    input.className = 'sql-query';
    input.spellcheck = false;
    input.placeholder = 'SELECT * FROM t LIMIT 100;';
    input.value = 'SELECT * FROM t LIMIT 100;';
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'sql-btn primary';
    run.textContent = '运行 (Ctrl+Enter)';
    queryWrap.append(input, run);
    const status = document.createElement('div');
    status.className = 'sql-status';
    const result = document.createElement('div');
    result.className = 'sql-result-wrap';
    wrap.append(bar, queryWrap, status, result);
    doc.pane.appendChild(wrap);
    doc.sqlEl = {wrap, meta, input, run, status, result, limit, reimport};
    run.addEventListener('click', () => runSqlQuery(doc));
    reimport.addEventListener('click', () => importSqlDoc(doc, true));
    input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runSqlQuery(doc);
        }
    });
    limit.addEventListener('change', () => {
        if (doc.sqlInfo) runSqlQuery(doc);
    });
}

function sqlSetStatus(doc, text, isError) {
    if (!doc || !doc.sqlEl) return;
    doc.sqlEl.status.textContent = text || '';
    doc.sqlEl.status.classList.toggle('error', !!isError);
}

async function importSqlDoc(doc, force) {
    if (!doc || !doc.sqlEl || doc.sqlImporting) return;
    if (doc.sqlInfo && !force) return;
    if (!backend.SQLImport) {
        sqlSetStatus(doc, '当前版本不支持 SQL 查询', true);
        return;
    }
    if (doc.sqlInfo) {
        try { await backend.SQLClose(doc.sqlInfo.id); } catch (e) {}
        doc.sqlInfo = null;
    }
    doc.sqlImporting = true;
    sqlSetStatus(doc, '正在导入临时副本…', false);
    if (doc.sqlEl.run) doc.sqlEl.run.disabled = true;
    try {
        const kind = sqlKindFor(doc);
        const useText = !doc.path || !!doc.dirty;
        const text = useText ? currentSqlSourceText(doc) : '';
        const info = await backend.SQLImport(doc.path || '', kind, doc.enc || 'utf-8', text, useText);
        doc.sqlInfo = info;
        doc.sqlEl.meta.textContent = info.rows + ' 行 × ' + (info.columns || []).length + ' 列 · 导入 ' +
            info.elapsedMs + ' ms' + (info.truncated ? ' · 已截断' : '');
        doc.sqlEl.input.value = doc.sqlQuery || 'SELECT * FROM t LIMIT 100;';
        doc.sqlQuery = doc.sqlEl.input.value;
        sqlSetStatus(doc, useText ? '已导入编辑器当前内容（含未保存修改）' : '已导入磁盘文件', false);
        await runSqlQuery(doc);
    } catch (e) {
        sqlSetStatus(doc, '导入失败：' + ((e && e.message) || e), true);
    } finally {
        doc.sqlImporting = false;
        if (doc.sqlEl && doc.sqlEl.run) doc.sqlEl.run.disabled = false;
    }
}

async function runSqlQuery(doc) {
    if (!doc || !doc.sqlEl || !doc.sqlInfo) return;
    if (!backend.SQLQuery) {
        sqlSetStatus(doc, '当前版本不支持 SQL 查询', true);
        return;
    }
    const query = doc.sqlEl.input.value.trim();
    if (!query) {
        sqlSetStatus(doc, '请输入 SQL', true);
        return;
    }
    doc.sqlQuery = doc.sqlEl.input.value;
    const limit = Number(doc.sqlEl.limit.value) || 500;
    doc.sqlEl.run.disabled = true;
    sqlSetStatus(doc, '查询中…', false);
    try {
        const result = await backend.SQLQuery(doc.sqlInfo.id, query, limit);
        renderSqlResult(doc, result);
    } catch (e) {
        doc.sqlEl.result.textContent = '';
        sqlSetStatus(doc, '查询失败：' + ((e && e.message) || e), true);
    } finally {
        doc.sqlEl.run.disabled = false;
    }
}

function renderSqlResult(doc, result) {
    const box = doc.sqlEl.result;
    box.textContent = '';
    const columns = (result && result.columns) || [];
    const rows = (result && result.rows) || [];
    const nulls = (result && result.nulls) || [];
    const meta = rows.length + ' 行 × ' + columns.length + ' 列 · ' + (result.elapsedMs || 0) + ' ms' +
        (result.truncated ? ' · 已截断（可加 LIMIT 或调大上限）' : '') +
        (result.message ? ' · ' + result.message : '');
    sqlSetStatus(doc, meta, false);
    if (!columns.length) {
        const empty = document.createElement('div');
        empty.className = 'sql-empty';
        empty.textContent = result.message || '语句已执行（无结果集）';
        box.appendChild(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'sql-result-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of columns) {
        const th = document.createElement('th');
        th.textContent = column;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows.length; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < columns.length; c++) {
            const td = document.createElement('td');
            const isNull = !!(nulls[r] && nulls[r][c]);
            if (isNull) {
                const span = document.createElement('span');
                span.className = 'sql-null';
                span.textContent = 'NULL';
                td.appendChild(span);
            } else {
                const value = rows[r][c] == null ? '' : String(rows[r][c]);
                td.textContent = value;
                if (value) td.title = value.length > 200 ? value.slice(0, 200) + '…' : value;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
}

function disposeSqlDoc(doc) {
    if (!doc || !doc.sqlInfo) return;
    const id = doc.sqlInfo.id;
    doc.sqlInfo = null;
    try {
        if (backend.SQLClose) Promise.resolve(backend.SQLClose(id)).catch(() => {});
    } catch (e) {}
}

// SQL 查询是可开关的覆盖层（类似搜索栏）：打开时盖在当前视图上，视图选中态不变；
// 关闭时直接移除覆盖层，底层视图原样恢复，无需重新解析。
function enterSqlView(doc) {
    if (!doc || !isSqlSupportedDoc(doc) || !doc.editor) return;
    if (doc.splitActive) exitSplitView(doc);
    doc.sqlSourceMode = currentMode;
    doc.pane.classList.add('sql-active');
    doc.sqlActive = true;
    createSqlView(doc);
    updateStatus();
    updateSearchState();
    if (!doc.sqlInfo) importSqlDoc(doc, false);
    else if (doc.dirty) sqlSetStatus(doc, '文件有未保存修改；点「重新导入」可生效', false);
    setTimeout(() => {
        if (doc.sqlEl && doc.sqlEl.input) doc.sqlEl.input.focus();
    }, 0);
}

function closeSqlView(doc) {
    if (!doc || !doc.sqlActive || !doc.pane) return;
    doc.pane.classList.remove('sql-active');
    doc.sqlActive = false;
    updateStatus();
    updateSearchState();
}

// ---------- 树视图右键菜单：展开 / 折叠当前节点、全部展开 / 收起、复制树 ----------

// 全部展开会一次性渲染整棵树（jsoneditor 无虚拟滚动）：大文件几万节点时会卡几秒，
// 展开后界面也长时间卡顿。超过阈值先确认，并提示可右键逐层展开。
const TREE_EXPAND_WARN_NODES = 12000;

function estimateJsonNodes(value, budget) {
    let count = 0;
    const stack = [value];
    while (stack.length) {
        const cur = stack.pop();
        count++;
        if (count > budget) return count;
        if (cur && typeof cur === 'object') {
            if (Array.isArray(cur)) {
                for (const item of cur) stack.push(item);
            } else {
                for (const key in cur) {
                    if (Object.prototype.hasOwnProperty.call(cur, key)) stack.push(cur[key]);
                }
            }
        }
    }
    return count;
}

function expandAllWithGuard(doc) {
    const ed = doc && doc.editor;
    if (!ed) return;
    let nodes = 0;
    try { nodes = estimateJsonNodes(ed.get(), 200000); } catch (e) { nodes = 0; }
    const run = () => { try { ed.expandAll(); } catch (err) {} };
    if (!nodes || nodes <= TREE_EXPAND_WARN_NODES) {
        run();
        return;
    }
    openCloseConfirm(
        '「' + (doc.name || '当前文件') + '」约含 ' + nodes.toLocaleString() + ' 个节点，全部展开需要一次性渲染整棵树，会卡顿数秒，展开后浏览 / 编辑也会明显变慢。可改用树视图右键「展开该节点」逐层展开。仍要全部展开吗？',
        run, '全部展开', '全部展开');
}

// jsoneditor 每个节点渲染成两层：外层「状态行」（直系 td 含 contextmenu 按钮，
// 子节点嵌在内嵌 values 表里）+ 内层「字段行」（直系第一个 td 就是本节点的
// 展开/收起按钮）。右键可能落在这两层任意元素上，这里统一解析出本节点按钮。

function jsonTreeNodeToggle(target) {
    const tr = target && target.closest ? target.closest('tr') : null;
    if (!tr || !tr.closest('.jsoneditor-tree')) return null;
    const fieldRow = tr.querySelector(':scope > td > table.jsoneditor-values > tbody > tr')
        || tr;
    const btn = fieldRow.querySelector(':scope > td > button.jsoneditor-expanded, :scope > td > button.jsoneditor-collapsed');
    return btn
        ? {btn, expanded: btn.classList.contains('jsoneditor-expanded')}
        : null;
}

function openTreeContextMenu(e, doc) {
    if (!ctxMenu || !doc || !doc.editor) return;
    const node = jsonTreeNodeToggle(e.target);
    const ed = doc.editor;
    ctxMenu.open([
        {label: '展开该节点', icon: 'chevron-down', disabled: !node || node.expanded, action: () => node.btn.click()},
        {label: '折叠该节点', icon: 'chevron-up', disabled: !node || !node.expanded, action: () => node.btn.click()},
        {sep: true},
        {label: '全部展开', shortcut: 'Ctrl+Shift+=', action: () => expandAllWithGuard(doc)},
        {label: '全部收起', shortcut: 'Ctrl+Shift+-', action: () => { try { ed.collapseAll(); } catch (err) {} }},
        {sep: true},
        {label: '复制树', action: () => { try { copyText(ed.getText(), '树内容'); } catch (err) {} }},
    ], e.clientX, e.clientY);
}

function setupTreeContextMenu(doc) {
    if (!doc || !doc.editor || !doc.editor.container || doc.editor.container.dataset.treeCtxBound) return;
    const container = doc.editor.container;
    container.dataset.treeCtxBound = '1';
    container.addEventListener('contextmenu', (e) => {
        if (!e.target || !e.target.closest || !e.target.closest('.jsoneditor-tree')) return;
        e.preventDefault();
        e.stopPropagation();
        openTreeContextMenu(e, doc);
    });
}

function createDoc(data) {
    if (data.binary) {        return {
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
            diskMtime: data.mtime || '',
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
    // CMakeLists.txt / Makefile / .gitignore 等已知文件名按代码视图打开（带语法高亮），不算纯文本
    const plainTextView = format.id === 'text' && plainTextExtensions.has(ext)
        && !isKnownCodeFileName(data.name) && !data.large;
    const preferredMode = plainTextView ? 'text' : format.preview
        ? (['split', 'preview', 'code', 'text'].includes(fs.view) ? fs.view : 'preview')
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
        mode: format.patch ? 'patch' : (plainTextView ? 'text' : format.preview ? (data.large ? 'code' : preferredMode) : (treeAvailable ? preferredMode : 'code')),
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null, text: null, table: null, preview: null},
        savedText: data.content,
        bookmarks: new Set(),
        diskMtime: data.mtime || '',
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
    updateWindowTitle();
    updateStatus();
    updateSearchState();
    renderTabs();
    if (aiPanel) aiPanel.refreshDockFill();
    syncAllBrowserTabs();
}

function showWelcome() {
    syncAllBrowserTabs();
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
    closeFootPopover();
    closeDialogs();
    if (els.stWriting) els.stWriting.style.display = 'none';
    applyWritingMode();
    updateSearchState();
    renderTabs();
    updateBackendDirty();
    updateWindowTitle();
    syncExplorerActive();
    if (structurePanel) structurePanel.setDoc(null);
    if (aiPanel) aiPanel.refreshDockFill();
}

let activateToken = 0;
let lastTabSwitchLog = {id: null, at: 0};

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
    currentMode = normalizeLegacySqlMode(doc);
    els.welcome.classList.add('hidden');
    els.editor.classList.remove('hidden');
    if (!els.editor.querySelector('.egroup[data-gid="' + g.id + '"]')) renderEditorLayout();
    for (const d of groupDocs(g)) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    renderBookmarks(doc);
    const host = els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
    if (host && doc.pane && doc.pane.parentElement !== host) host.appendChild(doc.pane);
    doc.pane.classList.add('active');
    editor = doc.editor;
    updateDocChrome();
    setDirty(doc.dirty);
    applyAceMode();
    if (doc.splitActive || doc.mode === 'split') enterSplitView(doc);
    humanizeCounts();
    if (editor && editor.aceEditor) {
        setTimeout(() => {
            if (editor === doc.editor && editor && editor.aceEditor) {
                editor.aceEditor.resize();
                if (file === doc) applyPendingDocView(doc);
            }
        }, 0);
    }
    syncExplorerActive();
    if (structurePanel) structurePanel.setDoc(doc);
    // 操作留痕：标签切换，同一标签 2s 内去重（避免连点噪音）。
    const now = Date.now();
    if (lastTabSwitchLog.id !== doc.id || now - lastTabSwitchLog.at > 2000) {
        lastTabSwitchLog = {id: doc.id, at: now};
        activityLog.log('tab.switch', doc.name, {});
    }
    if (doc.staleOnDisk && !doc.dirty) {
        doc.staleOnDisk = false;
        reloadActive({quiet: true});
    }
}

// ---------- 外部修改检测（写盘前冲突 + 读盘自动刷新） ----------
const externalDocTimers = new Map();

function handleExternalDocChanges(payload) {
    if (!payload || !backend.GetFileStat) return;
    const root = String(payload.root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!root) return;
    const changed = new Set();
    if (payload.overflow) {
        for (const doc of docs) if (doc.path && !doc.browser) changed.add(doc);
    } else {
        for (const rel of payload.paths || []) {
            const full = root + '/' + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
            for (const doc of docs) {
                if (!doc.path || doc.browser) continue;
                if (doc.path.replace(/\\/g, '/').toLowerCase() === full) changed.add(doc);
            }
        }
    }
    for (const doc of changed) {
        const prev = externalDocTimers.get(doc.id);
        if (prev) clearTimeout(prev);
        externalDocTimers.set(doc.id, setTimeout(() => {
            externalDocTimers.delete(doc.id);
            checkDocExternalChange(doc).catch(() => {});
        }, 350));
    }
}

// 磁盘 mtime 与打开/上次保存时不同：干净文档自动重载，脏文档标记 staleOnDisk（保存时弹冲突）
async function checkDocExternalChange(doc) {
    if (!doc || !doc.path || doc.browser || !backend.GetFileStat) return;
    if (!doc.diskMtime) return;
    let st = null;
    try {
        st = await backend.GetFileStat(doc.path);
    } catch (e) {
        return;
    }
    if (!st || !st.exists || st.mtime === doc.diskMtime) return;
    if (doc.dirty) {
        doc.staleOnDisk = true;
        renderTabs();
        return;
    }
    if (doc === file) {
        await reloadActive({quiet: true});
        flash('文件已在外部修改，已自动重新加载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        renderTabs();
    }
}

async function handleAIWorkspaceFileChanged(path) {
    if (explorer && explorer.refresh) explorer.refresh();
    const doc = findDocByPath(path);
    if (!doc) return;
    if (doc.dirty) {
        flash('AI 已修改 ' + doc.name + '，但编辑器中有未保存修改，未自动重载', true);
        return;
    }
    if (doc === file) {
        const ok = await reloadActive({quiet: true});
        if (ok) flash('AI 已修改并重载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        flash('AI 已修改 ' + doc.name + '，切换到该标签时自动重载');
    }
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
    // 操作留痕：脏标签关闭 = 放弃修改（保存后的关闭到这里 dirty 已清零）。
    if (doc.dirty) activityLog.log('tab.closeDirty', doc.name, {discarded: true});
    else activityLog.log('tab.close', doc.name, {});
    disposeSqlDoc(doc);
    disposePatchView(doc);
    const wasActive = doc === file;
    if (doc.path && remember) {
        closedTabs.push({path: doc.path, name: doc.name});
        if (closedTabs.length > 12) closedTabs.shift();
    }
    if (doc.browser && backend.BrowserClose) {
        backend.BrowserClose(doc.id).catch(() => {});
    }
    // 后台终端标签页：只断开输出订阅，作业继续在后台运行
    if (doc.bgTerm && doc.bgTermUnsub) {
        doc.bgTermUnsub();
        doc.bgTermUnsub = null;
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
        // 用户主动关掉最后一个标签：允许写入空快照
        saveSessionNow({allowEmpty: true});
        return;
    }
    scheduleSessionSave({allowEmpty: true});
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
    activityLog.log('tab.reopen', entry.name, {});
    openPath(entry.path);
}

// renderMarkdownBlocks 按顶层块渲染 Markdown，并用 data-md-start/end
// 标注每块对应的源码行区间（0 基，含头不含尾），供预览选区反向取 md 源码。
function renderMarkdownBlocks(text) {
    const env = {};
    const tokens = markdownRenderer.parse(text || '', env);
    const blocks = [];
    let i = 0;
    while (i < tokens.length) {
        const start = i;
        let level = 0;
        do {
            const t = tokens[i];
            if (t.nesting === 1) level++;
            else if (t.nesting === -1) level--;
            i++;
        } while (i < tokens.length && level > 0);
        const group = tokens.slice(start, i);
        const html = markdownRenderer.renderer.render(group, markdownRenderer.options, env);
        const map = group[0] && group[0].map;
        blocks.push({
            start: map && map.length === 2 ? map[0] : null,
            end: map && map.length === 2 ? map[1] : null,
            html,
        });
    }
    return blocks;
}

function markdownBlockHash(html) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < html.length; i++) {
        hash ^= html.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36) + ':' + html.length.toString(36);
}

function sanitizeMarkdownSegment(html) {
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel'],
    });
}

function renderMarkdownBlocksHtml(text) {
    let blocks;
    try {
        blocks = renderMarkdownBlocks(text);
    } catch (e) {
        return renderMarkdownHtml(text);
    }
    let html = '';
    for (const block of blocks) {
        if (block.start != null && block.end != null) {
            html += '<div class="md-block" style="display:contents" data-md-start="' + block.start +
                '" data-md-end="' + block.end + '" data-md-hash="' + markdownBlockHash(block.html) + '">' +
                block.html + '</div>';
        } else {
            html += block.html;
        }
    }
    // 整页只净化一次：逐块 sanitize 会为每个顶层块各建一个 document 并全量遍历
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel', 'data-md-start', 'data-md-end', 'data-md-hash'],
    });
}

// patchMarkdownPreview 复用未变化块的 DOM，只更新行区间或替换变化块；
// 任一块缺少源码行区间（无法安全对齐）时返回 false，调用方回退整页渲染。
function patchMarkdownPreview(doc) {
    const body = doc && doc.previewBody;
    if (!body) return false;
    let blocks;
    try {
        blocks = renderMarkdownBlocks(doc.editor.getText());
    } catch (e) {
        return false;
    }
    if (blocks.some((block) => block.start == null || block.end == null)) return false;
    const oldEls = Array.from(body.children);
    if (oldEls.some((el) => !el.classList || !el.classList.contains('md-block'))) return false;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let el = oldEls[i];
        if (!el) {
            el = document.createElement('div');
            el.className = 'md-block';
            el.style.display = 'contents';
            body.appendChild(el);
        }
        el.dataset.mdStart = String(block.start);
        el.dataset.mdEnd = String(block.end);
        const hash = markdownBlockHash(block.html);
        if (el.dataset.mdHash !== hash) {
            el.innerHTML = sanitizeMarkdownSegment(block.html);
            el.dataset.mdHash = hash;
        }
    }
    for (let i = blocks.length; i < oldEls.length; i++) oldEls[i].remove();
    return true;
}

// rangeIntersectsNode 判断选区 range 是否与节点内容相交。
function rangeIntersectsNode(range, node) {
    try {
        const nr = document.createRange();
        nr.selectNodeContents(node);
        return range.compareBoundaryPoints(Range.END_TO_START, nr) < 0 &&
            range.compareBoundaryPoints(Range.START_TO_END, nr) > 0;
    } catch (e) {
        return false;
    }
}

// copySelectedMarkdown 把预览选区还原成对应的 markdown 源码行并复制。
// 精度是块级：选中段落的任何部分都会取回该块（及跨到的最后一个块）的完整源码行。
function copySelectedMarkdown(doc) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const blocks = doc.previewBody ? Array.from(doc.previewBody.querySelectorAll('.md-block[data-md-start]')) : [];
    const hit = blocks.filter((b) => rangeIntersectsNode(range, b));
    if (!hit.length) return false;
    const start = Number(hit[0].dataset.mdStart);
    const end = Number(hit[hit.length - 1].dataset.mdEnd);
    if (!(start >= 0) || !(end > start)) return false;
    const lines = doc.editor.getText().split('\n');
    const text = lines.slice(start, end).join('\n');
    return copyText(text, 'markdown 源码');
}

// getSelectionHtml 取当前选区的 HTML 片段（支持多选区）。
function getSelectionHtml(sel) {
    if (!sel || !sel.rangeCount) return '';
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
        container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    return container.innerHTML;
}

// copySelectionRich 富文本复制：同时写入 text/html 与 text/plain，
// 粘到 Word/微信等会保留渲染样式。Clipboard API 不可用时回退临时选区 + execCommand。
async function copySelectionRich() {
    const sel = window.getSelection();
    const plain = sel ? sel.toString() : '';
    if (!plain) return false;
    const html = getSelectionHtml(sel);
    try {
        if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html], {type: 'text/html'}),
                'text/plain': new Blob([plain], {type: 'text/plain'}),
            })]);
            return true;
        }
    } catch (e) {}
    try {
        const holder = document.createElement('div');
        holder.contentEditable = 'true';
        holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        holder.innerHTML = html || '';
        document.body.appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(holder);
        const tmpSel = window.getSelection();
        tmpSel.removeAllRanges();
        tmpSel.addRange(range);
        const ok = document.execCommand('copy');
        tmpSel.removeAllRanges();
        holder.remove();
        if (ok) return true;
    } catch (e) {}
    return await copyText(plain, '所选文本');
}

// copyImageBlobToClipboard 把图片 Blob 写入剪贴板（image/png）。
// svgToPngBlob 把 SVG 文本转成 2x 尺寸的 PNG Blob。
function svgToPngBlob(svgText) {
    return new Promise((resolve, reject) => {
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        const img = new Image();
        img.onload = () => {
            try {
                const scale = 2;
                const w = Math.max(1, img.naturalWidth || 800);
                const h = Math.max(1, img.naturalHeight || 600);
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(w * scale);
                canvas.height = Math.round(h * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('canvas 转换失败'));
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = () => reject(new Error('SVG 加载失败'));
        img.src = url;
    });
}

function fileStem(name) {
    const base = baseNameOf(name || '图表');
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

// showSvgMenu SVG 渲染视图的右键菜单（完整渲染 + 分屏右栏）。
function showSvgMenu(doc, x, y) {
    if (!ctxMenu || !doc) return;
    const items = [
        {label: '导出为 PNG…（2x）', icon: 'E74E', action: async () => {
            try {
                const svgText = doc.editor.getText();
                const blob = await svgToPngBlob(svgText);
                const dataUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => resolve('');
                    reader.readAsDataURL(blob);
                });
                if (!dataUrl) throw new Error('PNG 数据生成失败');
                let dest = '';
                try {
                    dest = await backend.SaveFileDialog(fileStem(doc.path || doc.name) + '.png');
                } catch (e) {
                    return;
                }
                if (!dest) return;
                await backend.SaveDataURL(dest, dataUrl);
                flash('已导出 PNG：' + baseNameOf(dest));
            } catch (e) {
                flash('导出失败：' + (e && e.message || e), true);
            }
        }},
        {label: '复制图片', icon: 'E8C8', action: async () => {
            try {
                const blob = await svgToPngBlob(doc.editor.getText());
                const ok = await copyImageBlobToClipboard(blob);
                flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
            } catch (e) {
                flash('复制失败：' + (e && e.message || e), true);
            }
        }},
        {sep: true},
        ...aiReferenceFileMenuItems(doc),
        {label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => copyText(doc.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => showPathInFolder(doc.path)},
    ];
    ctxMenu.open(items, x, y);
}

// showImageMenu 图片视图的右键菜单。
function showImageMenu(doc, x, y) {
    if (!ctxMenu || !doc) return;
    const items = [
        {label: '另存为…', icon: 'E74E', disabled: !doc.path, action: async () => {
            let dest = '';
            try {
                dest = await backend.SaveFileDialog(baseNameOf(doc.path));
            } catch (e) {
                return;
            }
            if (!dest) return;
            try {
                await backend.CopyFileTo(doc.path, dest);
                flash('已另存为：' + baseNameOf(dest));
            } catch (e) {
                flash('另存为失败：' + (e && e.message || e), true);
            }
        }},
        {label: '复制图片', icon: 'E8C8', action: async () => {
            try {
                const url = doc.imageUrl || await backend.ReadImageAsDataURL(doc.path);
                const blob = await (await fetch(url)).blob();
                const ok = await copyImageBlobToClipboard(blob);
                flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
            } catch (e) {
                flash('复制失败：' + (e && e.message || e), true);
            }
        }},
        {sep: true},
        ...aiReferenceFileMenuItems(doc),
        {label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => copyText(doc.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => showPathInFolder(doc.path)},
    ];
    ctxMenu.open(items, x, y);
}

// showMdPreviewMenu Markdown 预览区的右键菜单：常用操作 + 预览宽度调整。
function showMdPreviewMenu(doc, x, y) {
    if (!ctxMenu || !doc) return;
    const selText = String(window.getSelection ? window.getSelection().toString() : '');
    const widthOptions = [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随窗口宽度']];
    const items = [
        {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !selText, submenu: [
            {label: '纯文本', action: () => copyText(selText, '所选文本')},
            {label: '富文本', action: async () => {
                const ok = await copySelectionRich();
                if (!ok) flash('复制失败', true);
            }},
            {label: 'markdown文本', action: async () => {
                const ok = await copySelectedMarkdown(doc);
                if (!ok) flash('无法定位所选内容对应的源码', true);
            }},
        ]},
        {label: '全选', shortcut: 'Ctrl+A', action: () => {
            const sel = window.getSelection();
            if (sel && doc.previewBody) sel.selectAllChildren(doc.previewBody);
        }},
        {sep: true},
        {label: '切换到代码视图', action: () => switchMode('code')},
        {label: '分屏预览（左源码右预览）', disabled: doc.splitActive || !canSplitDoc(doc), action: () => switchMode('split')},
    ];
    if (!doc.splitActive) {
        items.push({sep: true});
        items.push({
            label: '预览宽度',
            submenu: widthOptions.map(([value, label]) => ({
                label,
                checked: String(settings.mdPreviewWidth) === value,
                action: () => {
                    settings.mdPreviewWidth = value;
                    applySettings();
                    updateStatus();
                },
            })),
        });
        items.push({label: '刷新预览', icon: 'E72C', action: () => renderMarkdownPreview(doc)});
    }
    items.push({sep: true});
    items.push(...aiReferenceFileMenuItems(doc));
    items.push({label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => copyText(doc.path, '路径')});
    items.push({label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => showPathInFolder(doc.path)});
    ctxMenu.open(items, x, y);
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
        {label: '与另一个标签页比较…', icon: 'E8A5', disabled: gdocs.filter((d) => d.path && !d.binary).length < 2, action: () => openDiffDialog(doc.path)},
        ...aiReferenceFileMenuItems(doc),
        {label: '在 AI 中询问此文件', iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2l1.1 3.1 3.1 1.1-3.1 1.1L10 11.6 8.9 8.5 5.8 7.4l3.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M15.2 12.3l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="currentColor"/></svg>', disabled: !hasPath, action: () => askAIAboutPath(doc.path)},
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
];

// 不常用的代码类文件收进「更多」二级菜单
const NEW_FILE_TYPES_MORE = [
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

function fileTypeMenuItem(type, action) {
    const spec = fileIconSpec(type.name);
    const dot = type.name.lastIndexOf('.');
    return {
        label: type.label,
        shortcut: dot >= 0 ? type.name.slice(dot) : '',
        iconHtml: spec.svg,
        iconClass: spec.className,
        action: () => action(type),
    };
}

function newFileTypeMenuItems(action) {
    return [
        ...NEW_FILE_TYPES.map((type) => fileTypeMenuItem(type, action)),
        {sep: true},
        {
            label: '更多',
            icon: 'more',
            submenu: NEW_FILE_TYPES_MORE.map((type) => fileTypeMenuItem(type, action)),
        },
    ];
}

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
            activityLog.log('file.move', destDir, {from: actRel(result.path), count: results.length});
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
    if (rootChanged) renderWorkspaceCrumbs();
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

async function moveEntriesByDrag(items, destDir) {
    if (settings.readOnlyMode) {
        flash('只读模式下不能移动文件', true);
        return;
    }
    if (!backend.MoveEntry) {
        flash('当前版本不支持移动文件', true);
        return;
    }
    const all = clipboardItems(items);
    // 选中的父目录和子项同时拖动时只移动父目录
    const unique = all.filter((item) =>
        !all.some((other) => other.isDir && !samePathValue(other.path, item.path) && pathWithinValue(other.path, item.path)));
    const movable = unique.filter((item) =>
        !samePathValue(item.path, destDir) &&
        !(item.isDir && pathWithinValue(item.path, destDir)) &&
        !samePathValue(parentFolderOf(item.path), destDir));
    if (!movable.length) {
        flash('文件已在该目录中', true);
        return;
    }
    const results = [];
    const errors = [];
    for (const item of movable) {
        try {
            const newPath = await backend.MoveEntry(item.path, destDir, item.name);
            results.push({...item, newPath});
            activityLog.log('file.move', destDir, {from: actRel(item.path), count: movable.length});
        } catch (e) {
            errors.push({item, error: (e && e.message) || String(e)});
        }
    }
    let activeChanged = false;
    let rootChanged = false;
    for (const result of results) {
        const flags = applyMovedPath(result.path, result.newPath);
        activeChanged = activeChanged || flags.activeChanged;
        rootChanged = rootChanged || flags.rootChanged;
        if (explorer) explorer.removePath(result.path);
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
    if (errors.length) {
        const ok = results.length ? '已移动 ' + results.length + ' 项，' : '';
        flash(ok + errors.length + ' 项失败：' + errors[0].error, true);
    } else {
        flash(results.length === 1 ? '已移动：' + baseNameOf(results[0].newPath) : '已移动 ' + results.length + ' 项');
    }
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
    return [
        {label: '文件…', icon: 'E7C3', action: () => openCreateEntryDialog(dirPath, false, '', '新建文件')},
        {label: '目录…', icon: 'E8B7', action: () => openCreateEntryDialog(dirPath, true, '新建文件夹', '新建文件夹')},
        {sep: true},
        ...newFileTypeMenuItems((type) => openCreateEntryDialog(dirPath, false, type.name, '新建 ' + type.label)),
    ];
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
    if (workspaceFolder) {
        const next = remapPathValue(workspaceFolder, oldPath, newPath);
        if (next !== workspaceFolder) {
            workspaceFolder = next;
            renderWorkspaceCrumbs();
        }
    }
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
            // 操作留痕：逐项记录（回收站可撤销，故记路径而非仅计数）。
            for (const item of deleted) {
                activityLog.log('file.delete', item.path, {count: deleted.length, toRecycle: true});
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
            if (newPath && newPath !== info.path) {
                applyRenamedPath(info.path, newPath);
                activityLog.log('file.rename', newPath, {from: actRel(info.path)});
            }
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
        items.push({label: '作为书籍阅读', icon: 'E8A5', action: () => readingMode && readingMode.openBook(info.path)});
    } else {
        items.push({label: '打开', icon: 'E8E5', action: () => openPath(info.path)});
        items.push({label: '在新窗口中打开', icon: 'E8A7', action: () => openInNewWindows([info.path])});
        if (readingMode && /\.(md|markdown|mdx|txt|docx|epub)$/i.test(info.name || '')) {
            items.push({label: '阅读此文件', icon: 'E8A5', action: () => readingMode.openSingleFile(info.path)});
        }
        items.push({
            label: '在 AI 中询问此文件',
            iconHtml: AI_REFERENCE_ICON_HTML,
            action: () => askAIAboutPath(info.path),
        });
        items.push(...aiReferenceFileMenuItems({path: info.path, name: info.name}));
        if (gitStateCache.map.get(info.path.replace(/\\/g, '/'))) {
            items.push({label: 'Git：查看差异', icon: 'E8D3', action: () => showGitDiff(info.path)});
        }
        const compareTargets = selected.filter((item) => item && item.path && !item.isDir);
        if (compareTargets.length === 2) {
            items.push({
                label: '比较这两个文件…',
                icon: 'E8A5',
                action: () => openDiffDialog(compareTargets[0].path, compareTargets[1].path),
            });
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
    items.push({sep: true});
    items.push({label: '属性…', icon: 'E946', action: () => showFileProperties(info.path)});
    ctxMenu.open(items, x, y);
}

function selectedText() {
    if (!editor) return '';
    if ((currentMode === 'code' || currentMode === 'split') && editor.aceEditor) return editor.aceEditor.getSelectedText();
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
    openFindBar();
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
    const referenceItems = aiEditorReferenceMenuItems();
    ctxMenu.open([
        {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', disabled: readonly, action: doUndo},
        {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', disabled: readonly, action: doRedo},
        {sep: true},
        {label: '剪切', shortcut: 'Ctrl+X', icon: 'E8C6', disabled: !editable || readonly, action: ctxCut},
        {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !editable, action: ctxCopy},
        {label: '粘贴', shortcut: 'Ctrl+V', icon: 'E77F', disabled: !editable || readonly, action: ctxPaste},
        {label: '全选', shortcut: 'Ctrl+A', icon: 'E8B3', disabled: !editable, action: ctxSelectAll},
        {sep: true},
        {label: '查找…', shortcut: 'Ctrl+F', icon: 'E721', disabled: !editable, action: ctxFind},
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
        ...referenceItems,
        ...(referenceItems.length ? [{sep: true}] : []),
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

// closeReadingForEditor 退出阅读模式再打开编辑器（阅读模式不进标签页）
function closeReadingForEditor() {
    if (readingMode && readingMode.isActive()) readingMode.close();
}

function initContextMenus() {
    ctxMenu = createContextMenu();
    palette = createPalette({mask: els.paletteMask, input: els.paletteInput, list: els.paletteList, getActions: paletteActions});
    // ---- 阅读模式（docs/finished-plans/reading-mode.md）：视图容器 + 控制器，只读 ----
    const readingContainer = document.getElementById('reading-view');
    if (readingContainer) {
        readingMode = createReadingMode({
            container: readingContainer,
            getBackend: () => backend,
            getSetting: (key, dflt) => {
                const v = settings[key];
                return v === undefined ? dflt : v;
            },
            setSetting: (key, value) => {
                settings[key] = value;
                applySettings();
            },
            getWorkspace: () => workspaceFolder || '',
            isDarkTheme: () => /dark|darcula|night/i.test(String(settings.theme)),
            isDialogOpen,
            openInEditor: (path, line) => {
                closeReadingForEditor();
                openPath(path);
                if (line && line > 0) {
                    setTimeout(() => {
                        try {
                            jumpToPosition(line, 1);
                        } catch (e) {}
                    }, 250);
                }
            },
            showFlash: (msg) => flash(msg),
            chooseDirectory: async () => {
                try {
                    return await backend.OpenFolderDialog(defaultFolderDir());
                } catch (e) {
                    return '';
                }
            },
            showInFolder: (path) => backend.ShowInFolder(path).catch(() => {}),
        });
    }
    if (!els.mainPane) return;
    els.mainPane.addEventListener('contextmenu', (e) => {
        if (e.target.closest && e.target.closest('.ctx-menu')) return;
        if (!file) {
            e.preventDefault();
            e.stopPropagation();
            showBlankMenu(e.clientX, e.clientY);
            return;
        }
        // Markdown 预览区（完整预览或分屏右栏）：专用右键菜单
        const paneEl = e.target.closest && e.target.closest('.jsoneditor-pane');
        const pd = paneEl ? docs.find((d) => d.pane === paneEl) : null;
        if (pd && pd.previewBody && e.target.closest && e.target.closest('.md-preview-view')) {
            e.preventDefault();
            e.stopPropagation();
            showMdPreviewMenu(pd, e.clientX, e.clientY);
            return;
        }
        if (pd && pd.svgRenderEl && e.target.closest && e.target.closest('.svg-render-view')) {
            e.preventDefault();
            e.stopPropagation();
            showSvgMenu(pd, e.clientX, e.clientY);
            return;
        }
        if (pd && pd.imageEl && e.target.closest && e.target.closest('.image-preview-view')) {
            e.preventDefault();
            e.stopPropagation();
            showImageMenu(pd, e.clientX, e.clientY);
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
            rememberRecentOpen(doc.path, doc.name, false);
            activityLog.log('file.open', doc.path, {
                format: (doc.format && doc.format.id) || '',
                size: data.size || 0,
                batch: list.length > 1 ? list.length : undefined,
            });
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
    if (!doc || doc.binary || !doc.editor) return null;
    if (doc !== file) await activateDoc(doc);
    const mode = doc.format && doc.format.table ? 'text' : 'code';
    if (currentMode !== mode) switchMode(mode);
    if (mode === 'code') {
        const ready = await waitUntil(() => doc.editor && doc.editor.aceEditor);
        if (!ready) return null;
        const ace = doc.editor.aceEditor;
        const lineCount = ace.session.getLength();
        const requestedLine = Math.max(1, Math.round(Number(line) || 1));
        const lineNo = Math.min(requestedLine, lineCount);
        const lineText = ace.session.getLine(lineNo - 1) || '';
        const requestedColumn = Math.max(1, Math.round(Number(column) || 1));
        const columnNo = Math.min(requestedColumn, lineText.length + 1);
        ace.gotoLine(lineNo, columnNo - 1, false);
        ace.selection.selectLine();
        ace.scrollToLine(lineNo, true, true, () => {});
        ace.focus();
        return {
            mode: 'code',
            line: lineNo,
            column: columnNo,
            lineCount,
            requestedLine,
            requestedColumn,
            clamped: lineNo !== requestedLine || columnNo !== requestedColumn,
        };
    }
    const ready = await waitUntil(() => doc.pane && doc.pane.querySelector('textarea.jsoneditor-text'));
    if (!ready) return null;
    const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
    const lines = textarea.value.split('\n');
    const requestedLine = Math.max(1, Math.round(Number(line) || 1));
    const index = Math.min(requestedLine - 1, lines.length - 1);
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    const end = start + lines[index].length;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, index * lineHeight - textarea.clientHeight / 2);
    return {
        mode: 'text',
        line: index + 1,
        column: 0,
        lineCount: lines.length,
        requestedLine,
        requestedColumn: 0,
        clamped: index + 1 !== requestedLine,
    };
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

function getStructureWorker() {
    if (structureWorkerBroken) return null;
    if (structureWorker) return structureWorker;
    try {
        structureWorker = new Worker(new URL('./structure-worker.js', import.meta.url), {type: 'module'});
        structureWorker.onmessage = (event) => {
            const data = event.data || {};
            const pending = structureWorkerPending.get(data.id);
            if (!pending) return;
            structureWorkerPending.delete(data.id);
            if (data.ok) {
                pending.resolve(data.result);
            } else {
                pending.reject(new Error(data.error || '结构解析失败'));
            }
        };
        structureWorker.onerror = () => {
            structureWorkerBroken = true;
            structureWorker = null;
            for (const pending of structureWorkerPending.values()) {
                pending.reject(new Error('结构解析 Worker 不可用'));
            }
            structureWorkerPending.clear();
        };
    } catch (e) {
        structureWorkerBroken = true;
        structureWorker = null;
    }
    return structureWorker;
}

function rememberStructureResult(key, parsed) {
    structureCache.set(key, parsed);
    while (structureCache.size > STRUCTURE_CACHE_LIMIT) {
        structureCache.delete(structureCache.keys().next().value);
    }
    return parsed;
}

// 同一文档同一修订只解析一次；解析在 Worker 里做，切标签命中缓存
function parseStructureCached(name, text, doc) {
    const key = (doc && doc.id ? doc.id : '') + ':' + ((doc && doc.structureRev) || 0) + ':' + text.length;
    const cached = structureCache.get(key);
    if (cached) return Promise.resolve(cached);
    const worker = getStructureWorker();
    if (!worker) return Promise.resolve(rememberStructureResult(key, parseStructure(name, text)));
    return new Promise((resolve) => {
        const id = ++structureWorkerSeq;
        structureWorkerPending.set(id, {
            resolve: (parsed) => resolve(rememberStructureResult(key, parsed)),
            reject: () => {
                const workerNow = structureWorker;
                structureWorkerBroken = true;
                structureWorker = null;
                try {
                    if (workerNow) workerNow.terminate();
                } catch (e) {}
                resolve(rememberStructureResult(key, parseStructure(name, text)));
            },
        });
        worker.postMessage({id, name, text});
    });
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

// 项目徽标：取目录名前两个词的首字母（CaDt-DataLens → CD）
function projectBadgeText(name) {
    const words = String(name || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
        .filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

// 标题栏：有工作区时显示「项目 + 当前分支」替代文件名；分支仅 git 仓库内显示
function renderWorkspaceCrumbs() {
    const hasWorkspace = !!workspaceFolder;
    if (els.filename) els.filename.classList.toggle('hidden', hasWorkspace);
    if (!els.wsCrumbs) return;
    els.wsCrumbs.classList.toggle('hidden', !hasWorkspace);
    if (!hasWorkspace) return;
    const name = baseNameOf(workspaceFolder) || workspaceFolder;
    els.wsProjectName.textContent = name;
    els.wsProject.title = workspaceFolder;
    els.wsProjectBadge.textContent = projectBadgeText(name);
    const branch = (gitStateCache.available && gitStateCache.branch) || '';
    els.wsBranch.classList.toggle('hidden', !branch);
    els.wsBranchName.textContent = branch;
    els.wsBranch.title = branch ? '当前 Git 分支：' + branch + '（点击查看更多）' : '';
}

// ===== 标题栏弹层：项目选择（IDEA 简洁版） =====

const POP_ICONS = {
    folder: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.8 4.5c0-.8.6-1.4 1.4-1.4h3l1.5 1.7h5c.8 0 1.4.6 1.4 1.4v5.3c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    branch: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="4.6" cy="3.7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4.6" cy="12.3" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11.4" cy="5.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.6 5.4v5.2M11.4 7.1c0 2.1-2.2 2.9-4.3 3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    reveal: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 5.3V3.9c0-.7.6-1.3 1.3-1.3h3l1.4 1.5h4.9c.8 0 1.4.6 1.4 1.4v.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.4 6.4h11.2l-1.2 5.1c-.1.6-.6 1-1.2 1H4.7c-.6 0-1.1-.4-1.2-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    update: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.8 2.6v3.2H9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    commit: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.4 8.3l2.8 2.8 6-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    push: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 12.4V3.6M4.4 7.2L8 3.6l3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tag: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.6 3.2h5.1l5 5-4.5 4.5-5-5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="5.3" cy="5.9" r="1" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 8.2l1.7 1.7 3.3-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4.4 6.2 8 9.8l3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function isToolbarPopOpen(pop) {
    return !!pop && !pop.classList.contains('hidden');
}

function positionToolbarPopover(pop, anchor) {
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
    top = Math.max(margin, top);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

function closeProjectPopover() {
    if (!els.projectPop) return;
    els.projectPop.classList.add('hidden');
}

function projectBadgeColor(name) {
    const palette = ['#4f8cff', '#3fb950', '#a371f7', '#d18616', '#1fa5a0', '#d4577d'];
    let hash = 0;
    for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return palette[hash % palette.length];
}

function appendProjectAction(body, icon, label, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-item';
    const ic = document.createElement('span');
    ic.className = 'pp-icon';
    ic.innerHTML = icon;
    const text = document.createElement('span');
    text.className = 'pp-name';
    text.textContent = label;
    btn.append(ic, text);
    btn.addEventListener('click', action);
    body.appendChild(btn);
}

function appendProjectLabel(body, text) {
    const label = document.createElement('div');
    label.className = 'pp-label';
    label.textContent = text;
    body.appendChild(label);
}

function appendProjectSep(body) {
    const sep = document.createElement('div');
    sep.className = 'pp-sep';
    body.appendChild(sep);
}

function appendProjectMain(parent, name, path) {
    const main = document.createElement('div');
    main.className = 'pp-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'pp-name';
    nameEl.textContent = name || baseNameOf(path) || path;
    const pathEl = document.createElement('div');
    pathEl.className = 'pp-path';
    pathEl.textContent = path;
    pathEl.title = path;
    main.append(nameEl, pathEl);
    parent.appendChild(main);
}

async function revealWorkspaceFolder() {
    if (!workspaceFolder) return;
    try {
        await backend.ShowInFolder(workspaceFolder);
    } catch (e) {
        flash('打开文件夹位置失败：' + e, true);
    }
}

function renderProjectPopover() {
    const body = els.projectPopBody;
    if (!body) return;
    body.textContent = '';
    appendProjectAction(body, POP_ICONS.folder, '打开…', () => {
        closeProjectPopover();
        openFolderDialog();
    });
    appendProjectAction(body, POP_ICONS.branch, '克隆仓库…', () => {
        closeProjectPopover();
        cloneRepositoryFlow();
    });
    if (workspaceFolder) {
        appendProjectSep(body);
        appendProjectLabel(body, '打开项目');
        const row = document.createElement('div');
        row.className = 'pp-project';
        const badge = document.createElement('span');
        badge.className = 'pp-badge current';
        badge.textContent = projectBadgeText(baseNameOf(workspaceFolder) || workspaceFolder);
        row.appendChild(badge);
        appendProjectMain(row, baseNameOf(workspaceFolder) || workspaceFolder, workspaceFolder);
        body.appendChild(row);
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'pp-subaction';
        reveal.innerHTML = POP_ICONS.reveal + '<span>在文件资源管理器中显示</span>';
        reveal.addEventListener('click', () => {
            closeProjectPopover();
            revealWorkspaceFolder();
        });
        body.appendChild(reveal);
    }
    const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const currentKey = workspaceFolder ? norm(workspaceFolder) : '';
    const recent = readRecentOpen()
        .filter((entry) => entry && entry.isDir && entry.path && norm(entry.path) !== currentKey)
        .slice(0, 8);
    if (recent.length) {
        appendProjectSep(body);
        appendProjectLabel(body, '最近的项目');
        for (const entry of recent) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pp-item pp-recent';
            const badge = document.createElement('span');
            badge.className = 'pp-badge';
            badge.style.background = projectBadgeColor(entry.name || entry.path);
            badge.textContent = projectBadgeText(entry.name || baseNameOf(entry.path));
            btn.appendChild(badge);
            appendProjectMain(btn, entry.name || baseNameOf(entry.path), entry.path);
            btn.addEventListener('click', () => {
                closeProjectPopover();
                openFolderSmart(entry.path);
            });
            body.appendChild(btn);
        }
    }
}

function showProjectMenu(anchor) {
    if (!els.projectPop) return;
    if (isToolbarPopOpen(els.projectPop)) {
        closeProjectPopover();
        return;
    }
    closeGitBranchPopover();
    renderProjectPopover();
    els.projectPop.classList.remove('hidden');
    positionToolbarPopover(els.projectPop, anchor);
}

function joinFsPath(parent, name) {
    const sep = String(parent || '').includes('\\') ? '\\' : '/';
    return String(parent || '').replace(/[\\/]+$/, '') + sep + name;
}

function cloneRepoName(url) {
    let s = String(url || '').trim().replace(/[\\/]+$/, '');
    s = s.replace(/\.git$/i, '');
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
    return s.slice(cut + 1).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function cloneRepositoryFlow() {
    if (!backend.GitCloneRepository) {
        flash('当前版本不支持克隆仓库', true);
        return;
    }
    openNameDialog({
        title: '克隆仓库',
        label: '仓库 URL',
        placeholder: 'https://github.com/owner/repo.git 或 git@host:owner/repo.git',
        okLabel: '选择目录并克隆',
        onSubmit: async (value) => {
            const url = String(value || '').trim();
            if (!url) throw new Error('请输入仓库 URL');
            const repoName = cloneRepoName(url);
            if (!repoName) throw new Error('无法从 URL 解析仓库名');
            const parent = await backend.OpenFolderDialog(workspaceFolder || '');
            if (!parent) return;
            const target = joinFsPath(parent, repoName);
            elsDialogs.nameOk.textContent = '克隆中…';
            try {
                const res = await backend.GitCloneRepository(url, target);
                if (!res || !res.success) throw new Error((res && res.output) || '克隆失败');
                await openFolderSmart(target);
                flash('已克隆仓库：' + repoName);
            } finally {
                elsDialogs.nameOk.textContent = '选择目录并克隆';
            }
        },
    });
}

// ===== 标题栏弹层：Git 分支（IDEA 式） =====

const gitBranchPopState = {
    open: false,
    loading: false,
    data: null,
    error: '',
    query: '',
    active: -1,
    pinned: false,
    collapsed: new Set(),
    anchor: null,
    dir: '',
};
// 本地分支每次打开都刷新；远程分支列表缓存，只在 fetch 按钮或 push/pull 后重读
const gitBranchCache = {dir: '', remote: [], hasRemote: false, result: null};
let gitBranchRows = [];

function invalidateGitBranchRemoteCache() {
    gitBranchCache.hasRemote = false;
    gitBranchCache.remote = [];
    if (gitBranchCache.result) gitBranchCache.result.remote = [];
}

function closeGitBranchPopover() {
    if (!els.gitBranchPop) return;
    els.gitBranchPop.classList.add('hidden');
    gitBranchPopState.open = false;
    gitBranchPopState.loading = false;
    gitBranchPopState.data = null;
    gitBranchPopState.error = '';
    gitBranchPopState.query = '';
    gitBranchPopState.active = -1;
    gitBranchPopState.anchor = null;
    gitBranchPopState.dir = '';
    gitBranchRows = [];
}

function gitBranchPopButton(className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.tabIndex = -1;
    return btn;
}

function gitBranchPopDir() {
    return gitBranchPopState.dir || gitRootDir();
}

function gitBranchPopMatchesQuery(text) {
    const q = gitBranchPopState.query.trim().toLowerCase();
    return !q || String(text || '').toLowerCase().includes(q);
}

function addGitBranchRow(btn, run) {
    btn.addEventListener('click', () => run());
    btn.classList.toggle('active', gitBranchRows.length === gitBranchPopState.active);
    els.gbBody.appendChild(btn);
    gitBranchRows.push({el: btn, run});
}

function addGitBranchAction(icon, label, shortcut, run) {
    const btn = gitBranchPopButton('gb-row gb-action');
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = icon;
    const text = document.createElement('span');
    text.className = 'gb-row-label';
    text.textContent = label;
    btn.append(ic, text);
    if (shortcut) {
        const key = document.createElement('span');
        key.className = 'gb-row-key';
        key.textContent = shortcut;
        btn.appendChild(key);
    }
    addGitBranchRow(btn, run);
}

function addGitBranchGroup(key, label, count, indent, collapsible = true) {
    const collapsed = collapsible && gitBranchPopState.collapsed.has(key);
    const btn = gitBranchPopButton('gb-group' + (collapsed ? ' collapsed' : '') + (collapsible ? '' : ' gb-static'));
    btn.style.paddingLeft = 12 + indent * 14 + 'px';
    if (collapsible) {
        const chev = document.createElement('span');
        chev.className = 'gb-chev';
        chev.innerHTML = POP_ICONS.chevron;
        btn.appendChild(chev);
    }
    const name = document.createElement('span');
    name.className = 'gb-group-name';
    name.textContent = label;
    btn.appendChild(name);
    if (count != null) {
        const countEl = document.createElement('span');
        countEl.className = 'gb-group-count';
        countEl.textContent = String(count);
        btn.appendChild(countEl);
    }
    if (collapsible) {
        btn.addEventListener('click', () => {
            if (gitBranchPopState.collapsed.has(key)) gitBranchPopState.collapsed.delete(key);
            else gitBranchPopState.collapsed.add(key);
            renderGitBranchPopover();
        });
    }
    els.gbBody.appendChild(btn);
}

function addGitBranchRowItem(branch, remote, indent) {
    const btn = gitBranchPopButton('gb-row gb-branch' + (branch.current ? ' current' : ''));
    btn.style.paddingLeft = 12 + indent * 14 + 'px';
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = branch.current ? POP_ICONS.check : POP_ICONS.branch;
    const label = document.createElement('span');
    label.className = 'gb-row-label';
    label.textContent = branch.name;
    btn.append(ic, label);
    const meta = document.createElement('span');
    meta.className = 'gb-row-meta';
    if (!remote) {
        if (branch.gone) {
            const gone = document.createElement('span');
            gone.className = 'gb-gone';
            gone.textContent = '上游已删除';
            meta.appendChild(gone);
        } else if (branch.upstream) {
            const up = document.createElement('span');
            up.textContent = branch.upstream;
            meta.appendChild(up);
        }
        if (branch.ahead > 0) {
            const ahead = document.createElement('span');
            ahead.className = 'gb-ahead';
            ahead.textContent = '↑' + branch.ahead;
            ahead.title = '领先上游 ' + branch.ahead + ' 个提交';
            meta.appendChild(ahead);
        }
        if (branch.behind > 0) {
            const behind = document.createElement('span');
            behind.className = 'gb-behind';
            behind.textContent = '↓' + branch.behind;
            behind.title = '落后上游 ' + branch.behind + ' 个提交';
            meta.appendChild(behind);
        }
    }
    if (meta.childNodes.length) btn.appendChild(meta);
    btn.title = remote ? '签出远程分支 ' + branch.name + '（自动创建本地跟踪分支）' : '签出 ' + branch.name;
    addGitBranchRow(btn, () => gitPopCheckout(branch, remote));
}

function addGitBranchTag(name) {
    const btn = gitBranchPopButton('gb-row gb-tag');
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = POP_ICONS.tag;
    const label = document.createElement('span');
    label.className = 'gb-row-label';
    label.textContent = name;
    btn.append(ic, label);
    btn.title = '签出标记 ' + name;
    addGitBranchRow(btn, () => gitPopCheckoutRefValue(name));
}

function addGitBranchSep() {
    const sep = document.createElement('div');
    sep.className = 'gb-sep';
    els.gbBody.appendChild(sep);
}

function addGitBranchState(text, isError) {
    const state = document.createElement('div');
    state.className = 'gb-state' + (isError ? ' error' : '');
    state.textContent = text;
    els.gbBody.appendChild(state);
}

function gitBranchCountTree(node) {
    let count = node.branches.length;
    for (const child of node.children.values()) count += gitBranchCountTree(child);
    return count;
}

function gitBranchBuildTree(branches) {
    const root = {children: new Map(), branches: []};
    for (const branch of branches) {
        const parts = String(branch.name || '').split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (!node.children.has(key)) node.children.set(key, {children: new Map(), branches: []});
            node = node.children.get(key);
        }
        node.branches.push(branch);
    }
    return root;
}

function gitBranchRenderTree(node, depth, prefix) {
    const groups = Array.from(node.children.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
    for (const [name, child] of groups) {
        const full = prefix ? prefix + '/' + name : name;
        const key = 'localp:' + full;
        addGitBranchGroup(key, name, gitBranchCountTree(child), depth, true);
        if (!gitBranchPopState.collapsed.has(key)) gitBranchRenderTree(child, depth + 1, full);
    }
    const branches = node.branches.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const branch of branches) addGitBranchRowItem(branch, false, depth);
}

function renderGitBranchPopover() {
    if (!els.gbBody || !gitBranchPopState.open) return;
    const body = els.gbBody;
    body.textContent = '';
    gitBranchRows = [];
    gitBranchPopState.active = -1;
    const state = gitBranchPopState;
    if (state.loading && !state.data) {
        addGitBranchState('正在读取分支…');
        positionToolbarPopover(els.gitBranchPop, state.anchor);
        return;
    }
    if (state.error) {
        addGitBranchState(state.error, true);
        positionToolbarPopover(els.gitBranchPop, state.anchor);
        return;
    }
    const data = state.data;
    if (!data) {
        addGitBranchState('正在读取分支…');
        return;
    }
    if (!data.available) {
        addGitBranchState(data.reason || '当前目录不在 Git 仓库内');
        positionToolbarPopover(els.gitBranchPop, state.anchor);
        return;
    }
    const q = state.query.trim().toLowerCase();
    const matches = (text) => !q || String(text || '').toLowerCase().includes(q);
    const allActions = [
        {icon: POP_ICONS.update, label: '更新项目…', shortcut: 'Ctrl+T', run: gitPopUpdateProject},
        {icon: POP_ICONS.commit, label: '提交…', shortcut: 'Ctrl+K', run: gitPopOpenCommit},
        {icon: POP_ICONS.push, label: '推送…', shortcut: 'Ctrl+Shift+K', run: gitPopPush},
        {sep: true},
        {icon: POP_ICONS.plus, label: '新建分支…', shortcut: 'Ctrl+Alt+N', run: gitPopNewBranch},
        {icon: POP_ICONS.tag, label: '签出标记或修订…', run: gitPopCheckoutRef},
    ];
    const actions = q ? allActions.filter((action) => !action.sep && matches(action.label)) : allActions;
    for (const action of actions) {
        if (action.sep) addGitBranchSep();
        else addGitBranchAction(action.icon, action.label, action.shortcut, action.run);
    }
    const localAll = data.local || [];
    const local = localAll.filter((b) => matches(b.name));
    const remote = (data.remote || []).filter((b) => matches(b.name));
    const tags = (data.tags || []).filter((t) => matches(t));
    const recentNames = new Set(data.recent || []);
    const recent = localAll.filter((b) => recentNames.has(b.name) && !b.current && matches(b.name));
    let groupsRendered = 0;
    if (recent.length) {
        if (q) addGitBranchGroup('recent', '最近', recent.length, 0, false);
        else addGitBranchGroup('recent', '最近', recent.length, 0, true);
        if (q || !state.collapsed.has('recent')) {
            for (const branch of recent) addGitBranchRowItem(branch, false, 0);
        }
        groupsRendered++;
    }
    if (local.length) {
        if (q) {
            addGitBranchGroup('local', '本地', local.length, 0, false);
            for (const branch of local) addGitBranchRowItem(branch, false, 0);
        } else {
            addGitBranchGroup('local', '本地', local.length, 0, true);
            if (!state.collapsed.has('local')) gitBranchRenderTree(gitBranchBuildTree(local), 0, '');
        }
        groupsRendered++;
    }
    if (remote.length) {
        addGitBranchGroup('remote', '远程', remote.length, 0, !q);
        if (q || !state.collapsed.has('remote')) {
            for (const branch of remote) addGitBranchRowItem(branch, true, 0);
        }
        groupsRendered++;
    }
    if (tags.length) {
        addGitBranchGroup('tags', '标签', tags.length, 0, !q);
        if (q || !state.collapsed.has('tags')) {
            for (const tag of tags) addGitBranchTag(tag);
        }
        groupsRendered++;
    }
    if (!groupsRendered) {
        addGitBranchState(q ? '没有匹配的分支或操作' : '仓库里还没有可用的分支');
    }
    positionToolbarPopover(els.gitBranchPop, state.anchor);
}

async function loadGitBranches(includeRemote) {
    if (!backend.GitBranchesFor) return;
    const dir = gitBranchPopDir();
    if (!dir) return;
    gitBranchPopState.loading = true;
    if (!gitBranchPopState.data) renderGitBranchPopover();
    try {
        const data = await backend.GitBranchesFor(dir, !!includeRemote);
        if (data && data.available) {
            if (includeRemote) {
                gitBranchCache.remote = data.remote || [];
                gitBranchCache.hasRemote = true;
            } else {
                data.remote = gitBranchCache.remote || [];
            }
            gitBranchCache.dir = dir;
            gitBranchCache.result = data;
        } else {
            gitBranchCache.dir = '';
            gitBranchCache.remote = [];
            gitBranchCache.hasRemote = false;
            gitBranchCache.result = null;
        }
        gitBranchPopState.data = data;
        gitBranchPopState.error = '';
    } catch (e) {
        const message = '读取分支失败：' + ((e && e.message) || e);
        if (gitBranchPopState.data) flash(message, true);
        else gitBranchPopState.error = message;
    }
    gitBranchPopState.loading = false;
    if (gitBranchPopState.open) renderGitBranchPopover();
}

function showBranchMenu(anchor) {
    if (!els.gitBranchPop) return;
    if (isToolbarPopOpen(els.gitBranchPop)) {
        closeGitBranchPopover();
        return;
    }
    closeProjectPopover();
    const dir = gitRootDir();
    if (!dir) {
        flash('请先打开文件或目录', true);
        return;
    }
    if (!backend.GitBranchesFor) {
        flash('当前版本不支持 Git 分支管理', true);
        return;
    }
    const cached = gitBranchCache.result && samePathValue(gitBranchCache.dir, dir) && gitBranchCache.result.available
        ? gitBranchCache.result
        : null;
    gitBranchPopState.open = true;
    gitBranchPopState.loading = true;
    gitBranchPopState.data = cached;
    gitBranchPopState.error = '';
    gitBranchPopState.query = '';
    gitBranchPopState.active = -1;
    gitBranchPopState.dir = dir;
    gitBranchPopState.anchor = anchor;
    gitBranchRows = [];
    els.gbSearch.value = '';
    els.gbBody.textContent = '';
    els.gitBranchPop.classList.remove('hidden');
    if (cached) {
        renderGitBranchPopover();
    } else {
        addGitBranchState('正在读取分支…');
        positionToolbarPopover(els.gitBranchPop, anchor);
    }
    els.gbSearch.focus();
    loadGitBranches(!cached || !gitBranchCache.hasRemote);
}

function gitBranchMoveActive(delta) {
    if (!gitBranchRows.length) return;
    let next = gitBranchPopState.active + delta;
    if (gitBranchPopState.active < 0) next = delta > 0 ? 0 : gitBranchRows.length - 1;
    next = Math.max(0, Math.min(gitBranchRows.length - 1, next));
    gitBranchPopState.active = next;
    gitBranchRows.forEach((row, i) => row.el.classList.toggle('active', i === next));
    gitBranchRows[next].el.scrollIntoView({block: 'nearest'});
}

function gitBranchRunActive() {
    const row = gitBranchRows[gitBranchPopState.active];
    if (row) row.run();
}

function openGitOutput(name, output) {
    openVirtualDoc(name, output || '（命令没有输出）');
}

async function gitPopCheckout(branch, remote) {
    const dir = gitBranchPopDir();
    const name = branch.name;
    closeGitBranchPopover();
    if (branch.current) return;
    flash('正在切换到 ' + name + '…');
    try {
        const res = await backend.GitCheckoutBranch(dir, name, !!remote);
        if (!res || !res.success) {
            flash('切换分支失败', true);
            if (res && res.output) openGitOutput('切换分支失败.txt', res.output);
            return;
        }
        flash('已切换到分支：' + (res.branch || name));
        await refreshGitStatus();
        await reloadAllFromDisk();
    } catch (e) {
        flash('切换分支失败：' + e, true);
    }
}

async function gitPopUpdateProject() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!backend.GitPullFor) return;
    flash('正在更新项目…');
    try {
        const res = await backend.GitPullFor(dir);
        if (!res || !res.success) {
            flash('更新项目失败', true);
            if (res && res.output) openGitOutput('更新项目失败.txt', res.output);
            return;
        }
        flash('项目已更新');
        invalidateGitBranchRemoteCache();
        await refreshGitStatus();
        await reloadAllFromDisk();
    } catch (e) {
        flash('更新项目失败：' + e, true);
    }
}

function gitPopOpenCommit() {
    closeGitBranchPopover();
    settings.showSidebar = true;
    switchSidebarView('git');
    setTimeout(() => {
        if (els.gitMessage) els.gitMessage.focus();
    }, 80);
}

async function gitPopPush() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!backend.GitPushFor) return;
    flash('正在推送…');
    try {
        const res = await backend.GitPushFor(dir);
        if (!res || !res.success) {
            flash('推送失败', true);
            if (res && res.output) openGitOutput('推送失败.txt', res.output);
            return;
        }
        flash('已推送当前分支');
        invalidateGitBranchRemoteCache();
        await refreshGitStatus();
    } catch (e) {
        flash('推送失败：' + e, true);
    }
}

function gitPopNewBranch() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!backend.GitCreateBranch) {
        flash('当前版本不支持新建分支', true);
        return;
    }
    openNameDialog({
        title: '新建分支',
        label: '分支名称',
        placeholder: 'feature/my-branch',
        okLabel: '创建并检出',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            if (!name) throw new Error('请输入分支名');
            const res = await backend.GitCreateBranch(dir, name);
            if (!res || !res.success) throw new Error((res && res.output) || '创建分支失败');
            flash('已创建并切换到分支：' + name);
            await refreshGitStatus();
        },
    });
}

function gitPopCheckoutRefValue(ref) {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!backend.GitCheckoutRefFor) {
        flash('当前版本不支持签出标记或修订', true);
        return;
    }
    flash('正在签出 ' + ref + '…');
    backend.GitCheckoutRefFor(dir, ref).then(async (res) => {
        if (!res || !res.success) {
            flash('签出失败', true);
            if (res && res.output) openGitOutput('签出失败.txt', res.output);
            return;
        }
        flash('已签出：' + ref);
        await refreshGitStatus();
        await reloadAllFromDisk();
    }).catch((e) => flash('签出失败：' + e, true));
}

function gitPopCheckoutRef() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!backend.GitCheckoutRefFor) {
        flash('当前版本不支持签出标记或修订', true);
        return;
    }
    openNameDialog({
        title: '签出标记或修订',
        label: '分支、标记或提交 SHA',
        placeholder: 'v1.0.0 / 1a2b3c4 / feature/x',
        okLabel: '签出',
        onSubmit: async (value) => {
            const ref = String(value || '').trim();
            if (!ref) throw new Error('请输入分支、标记或提交 SHA');
            const res = await backend.GitCheckoutRefFor(dir, ref);
            if (!res || !res.success) throw new Error((res && res.output) || '签出失败');
            flash('已签出：' + ref);
            await refreshGitStatus();
            await reloadAllFromDisk();
        },
    });
}

async function gitPopFetch() {
    if (!gitBranchPopState.open || gitBranchPopState.loading || !backend.GitFetchFor) return;
    if (els.gbFetch) {
        els.gbFetch.disabled = true;
        els.gbFetch.classList.add('active');
    }
    try {
        const res = await backend.GitFetchFor(gitBranchPopDir());
        if (!res || !res.success) {
            closeGitBranchPopover();
            flash('获取远程分支失败', true);
            if (res && res.output) openGitOutput('获取远程分支失败.txt', res.output);
            return;
        }
        flash('已获取远程分支');
        await loadGitBranches(true);
    } catch (e) {
        flash('获取远程分支失败：' + e, true);
    } finally {
        if (els.gbFetch) {
            els.gbFetch.disabled = false;
            els.gbFetch.classList.remove('active');
        }
    }
}

function gitPopTogglePin() {
    gitBranchPopState.pinned = !gitBranchPopState.pinned;
    if (els.gbPin) {
        els.gbPin.classList.toggle('active', gitBranchPopState.pinned);
        els.gbPin.setAttribute('aria-pressed', String(gitBranchPopState.pinned));
        els.gbPin.title = gitBranchPopState.pinned ? '取消固定窗口' : '固定窗口（点击外部不关闭）';
    }
}

if (els.gbSearch) {
    els.gbSearch.addEventListener('input', () => {
        gitBranchPopState.query = els.gbSearch.value;
        renderGitBranchPopover();
    });
    els.gbSearch.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            gitBranchMoveActive(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            gitBranchMoveActive(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            gitBranchRunActive();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeGitBranchPopover();
        }
    });
}
if (els.gbFetch) els.gbFetch.addEventListener('click', gitPopFetch);
if (els.gbPin) els.gbPin.addEventListener('click', gitPopTogglePin);

document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (isToolbarPopOpen(els.projectPop) && !els.projectPop.contains(target) && !els.wsProject.contains(target)) {
        closeProjectPopover();
    }
    if (isToolbarPopOpen(els.gitBranchPop) && !els.gitBranchPop.contains(target) && !els.wsBranch.contains(target) && !gitBranchPopState.pinned) {
        closeGitBranchPopover();
    }
}, true);

document.addEventListener('keydown', (e) => {
    if (isToolbarPopOpen(els.projectPop) && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeProjectPopover();
        return;
    }
    if (!gitBranchPopState.open) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeGitBranchPopover();
        return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (els.gbSearch) {
            els.gbSearch.focus();
            els.gbSearch.select();
        }
    }
}, true);

window.addEventListener('blur', () => {
    closeProjectPopover();
    closeGitBranchPopover();
});
window.addEventListener('resize', () => {
    closeProjectPopover();
    closeGitBranchPopover();
});

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
    if (workspaceFolder && sessionPathKey(dir) !== sessionPathKey(workspaceFolder)) {
        // 切换工作区前先落盘旧工作区环境（per-workspace 会话恢复需要）。
        saveSessionNow();
    }
    workspaceFolder = dir;
    toggleSidebarFilter(false);
    scheduleSessionSave();
    rememberRecentOpen(dir, baseNameOf(dir) || dir, true);
    settings.sidebarMode = 'tree';
    settings.showSidebar = true;
    applySettings();
    if (explorer) {
        explorer.setMode('tree', false);
        explorer.setRoot(dir);
    }
    syncWorkspaceWatcher();
    applySidebarUI();
    renderWorkspaceCrumbs();
    refreshGitStatus();
    if (aiPanel && aiPanel.refreshSessionList) aiPanel.refreshSessionList();
    activityLog.log('workspace.open', dir, {}, {noRel: true});
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
    saveSessionNow({allowEmpty: true});
    workspaceFolder = null;
    if (explorer) explorer.setRoot(null);
    syncWorkspaceWatcher();
    gitStateCache.available = false;
    gitStateCache.branch = '';
    renderWorkspaceCrumbs();
    notifyAIGitEntry();
    scheduleSessionSave();
    if (aiPanel && aiPanel.refreshSessionList) aiPanel.refreshSessionList();
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
        // 文件 icon 在文件侧边栏可见时保持选中，列表/树模式都算
        const filesActive = !!settings.showSidebar && settings.sidebarView === 'files';
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
    if (els.abChats) {
        const chatsActive = !!settings.showSidebar && settings.sidebarView === 'chats';
        els.abChats.classList.toggle('active', chatsActive);
        els.abChats.setAttribute('aria-pressed', String(chatsActive));
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
    syncWorkspaceWatcher();
}

// 文件监听跟随当前树根/工作区；失败时静默降级到轮询
function syncWorkspaceWatcher() {
    if (!backend) return;
    const root = (explorer && explorer.getRoot ? explorer.getRoot() : workspaceFolder) || '';
    if (root === watchedWorkspaceRoot) return;
    watchedWorkspaceRoot = root;
    try {
        if (root && typeof backend.WatchWorkspace === 'function') backend.WatchWorkspace(root).catch(() => {});
        else if (!root && typeof backend.UnwatchWorkspace === 'function') backend.UnwatchWorkspace().catch(() => {});
    } catch (e) {}
}

function initActivityBar() {
    if (!els.activityBar) return;
    if (els.abFiles) els.abFiles.addEventListener('click', () => toggleSidebarView('files'));
    if (els.abStructure) els.abStructure.addEventListener('click', () => toggleSidebarView('structure'));
    if (els.abSearch) els.abSearch.addEventListener('click', () => {
        // 有可搜索视图开内容查找，否则退到全局搜索，保证图标总是有响应
        if (findTarget()) openFindBar();
        else openGlobalSearch();
    });
    if (els.abTerminal) els.abTerminal.addEventListener('click', () => toggleDockView('terminal'));
    if (els.abDebug) els.abDebug.addEventListener('click', () => toggleDockView('debug'));
    if (els.abGit) els.abGit.addEventListener('click', () => toggleSidebarView('git'));
    if (els.abChats) els.abChats.addEventListener('click', () => toggleSidebarView('chats'));
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

function toggleAIPanel(force) {
    if (!aiPanel) initAIPanel();
    if (aiPanel) aiPanel.toggle(force);
}

function askAIAboutPath(path) {
    if (!path) return;
    if (!aiPanel) initAIPanel();
    if (!aiPanel) return;
    aiPanel.open(true);
    if (aiPanel.attachPath) aiPanel.attachPath(path, {focus: true});
}

const AI_REFERENCE_ICON_HTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2l1.1 3.1 3.1 1.1-3.1 1.1L10 11.6 8.9 8.5 5.8 7.4l3.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M15.2 12.3l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="currentColor"/></svg>';

function aiPanelOpenNow() {
    return !!(aiPanel && aiPanel.isOpen && aiPanel.isOpen());
}

function aiReferenceFileMenuItems(doc) {
    if (!aiPanelOpenNow() || !doc || !doc.path) return [];
    return [{
        label: '引用该文件',
        iconHtml: AI_REFERENCE_ICON_HTML,
        action: () => {
            if (aiPanel && aiPanel.referencePath) aiPanel.referencePath(doc.path, doc.name || '');
        },
    }];
}

function aiEditorReferenceMenuItems() {
    if (!aiPanelOpenNow() || !file || !file.path) return [];
    const selected = selectedText();
    if (selected && selected.trim()) {
        const caret = appActionDocCaret(file);
        if (caret.selection) {
            return [{
                label: '引用选取',
                iconHtml: AI_REFERENCE_ICON_HTML,
                action: () => {
                    if (aiPanel && aiPanel.referenceSelection) aiPanel.referenceSelection();
                },
            }];
        }
    }
    return [{
        label: '引用该文件',
        iconHtml: AI_REFERENCE_ICON_HTML,
        action: () => {
            if (aiPanel && aiPanel.referencePath) aiPanel.referencePath(file.path, file.name || '');
        },
    }];
}

function setAIPanelMode(mode) {
    if (!aiPanel) initAIPanel();
    if (aiPanel) aiPanel.setMode(mode);
}

function initAIPanel() {
    if (aiPanel) return;
    const panelEl = els.aiPanel || document.getElementById('ai-panel');
    if (!panelEl) return;
    aiPanel = createAIPanel({
        panel: panelEl,
        dockParent: document.getElementById('top-row'),
        overlayParent: document.getElementById('main-pane'),
        backend,
        settings,
        fonts: {latin: uiFonts, cjk: cjkFonts, mono: editorFonts},
        saveSettings: applySettings,
        activity: activityLog,
        openTermTab: openBgTermTab,
        runAppAction,
        hostAppActions: () => APP_ACTIONS,
        browserHost: {
            ensureTab: async (id, url, profileKey) => {
                const existed = docs.find((d) => d.id === id);
                if (existed && backend.BrowserState) {
                    try {
                        const st = await backend.BrowserState(id);
                        if (st) return {id, url: st.url, title: st.title};
                    } catch (e) {}
                }
                const doc = openBrowserTab(url || 'about:blank', profileKey || '');
                return {id: doc.id, url: doc.browserUrl, title: doc.name};
            },
            closeTab: async (id) => {
                const doc = docs.find((d) => d.id === id);
                if (doc) closeDocNow(doc, false);
                return {closed: true};
            },
            applyViewport: (id, viewport) => {
                const doc = docs.find((d) => d.id === id && d.browser);
                if (!doc || !doc.browserEl) return {applied: false};
                const ok = setBrowserViewport(doc, viewport);
                return {applied: ok, viewport: browserViewportLabel(doc)};
            },
        },
        flash,
        copyText,
        // AI 消息里的 svg / html 围栏按设置渲染成内联可视化卡片；其它 Markdown 视图不传该开关
        renderMarkdown: (text) => renderMarkdownHtml(text, {aiWidgets: settings.aiInlineWidgets !== false}),
        openExternal: openExternalUrl,
        confirm: openCloseConfirm,
        nameDialog: openNameDialog,
        openSettings: (pane) => {
            if (window.__aiFloatWindow && backend.OpenSettingsInMainWindow) {
                Promise.resolve(backend.OpenSettingsInMainWindow(pane || 'models'))
                    .then(() => flash('已在主窗口打开设置'))
                    .catch((e) => flash('打开主窗口设置失败：' + ((e && e.message) || e), true));
                return;
            }
            openSettings(pane);
        },
        setDragCursor,
        openVirtualDoc,
        commandOutput: (id, handlers) => {
            const off = () => {
                cmdOutHandlers.delete(id);
                cmdExitHandlers.delete(id);
            };
            if (!id || !handlers) return {cancel: off};
            if (handlers.onOut || handlers.onErr) {
                cmdOutHandlers.set(id, (stream, data) => {
                    if (stream === 'err') {
                        if (handlers.onErr) handlers.onErr(data);
                    } else if (handlers.onOut) {
                        handlers.onOut(data);
                    }
                });
            }
            if (handlers.onExit) {
                cmdExitHandlers.set(id, (code) => {
                    off();
                    handlers.onExit(code);
                });
            }
            return {cancel: off};
        },
        activityButton: els.abAi,
        toolbarButton: els.tbAi,
        isMock: !hasWails,
        floatWindow: !!window.__aiFloatWindow || (!hasWails && mockScenario.has('aifloat')),
        mockEmpty: mockScenario.has('aiempty'),
        getWorkspaceContext: () => {
            const caret = file ? appActionDocCaret(file) : {cursor: null, selection: null};
            return {
                workspaceFolder: workspaceFolder || '',
                activeFile: file ? {
                    path: file.path || '',
                    name: file.name || '',
                    mode: file.mode || '',
                    dirty: !!file.dirty,
                    cursor: caret.cursor,
                    selection: caret.selection ? {
                        start: caret.selection.start,
                        end: caret.selection.end,
                        chars: caret.selection.chars,
                    } : null,
                    viewport: caret.viewport || null,
                } : null,
                openFiles: docs.map((doc) => doc.path || doc.name).filter(Boolean),
            };
        },
        getGitRepo: () => {
            // 面板可能在模块求值早期自动打开：gitStateCache 尚未完成初始化时按「无仓库」处理，
            // 随后的 refreshGitStatus 会再次通知刷新。
            try {
                return {
                    available: !!gitStateCache.available,
                    root: gitStateCache.dir,
                    branch: gitStateCache.branch,
                };
            } catch (e) {
                return null;
            }
        },
        getScopeRoot: () => workspaceFolder || (file && file.path ? parentDirOf(file.path) : ''),
        openWorkspaceFolder: (dir, sessionId) => {
            if (!dir) return false;
            if (window.__aiFloatWindow) return false;
            const targetKey = sessionPathKey(dir);
            if (workspaceFolder && sessionPathKey(workspaceFolder) === targetKey) return 'same';
            if (!workspaceFolder) {
                openFolderWorkspace(dir);
                return 'current';
            }
            // 当前窗口已有工作区：不硬切换，另开窗口打开目标工作区（软切换）。
            saveSessionNow();
            if (backend.OpenWorkspaceForConversation) {
                Promise.resolve(backend.OpenWorkspaceForConversation(dir, sessionId || ''))
                    .catch((e) => flash('打开新窗口失败：' + ((e && e.message) || e), true));
                return 'window';
            }
            if (backend.OpenDirInNewWindow) {
                Promise.resolve(backend.OpenDirInNewWindow(dir))
                    .catch((e) => flash('打开新窗口失败：' + ((e && e.message) || e), true));
                return 'window';
            }
            return false;
        },
        getSelection: () => {
            const text = selectedText();
            if (!file || !text) return null;
            const caret = appActionDocCaret(file);
            return {
                path: file.path || '',
                name: file.name || '选中内容',
                text,
                selection: caret.selection,
            };
        },
        pickFiles: () => backend.OpenFilesDialog(),
        showContextMenu: (items, x, y, options) => {
            if (ctxMenu) ctxMenu.open(items, x, y, Object.assign({ignoreScrollWithin: '#ai-panel'}, options));
        },
        openPath: (path) => {
            if (window.__aiFloatWindow && backend.OpenInNewWindows) {
                Promise.resolve(backend.OpenInNewWindows([path])).catch((e) => flash('打开失败：' + ((e && e.message) || e), true));
                return;
            }
            openPath(path);
        },
        isFileDirty: (path) => {
            const doc = findDocByPath(path);
            return !!(doc && doc.dirty);
        },
        onFileChanged: (path) => handleAIWorkspaceFileChanged(path),
        collapseSidebar: () => {
            if (!settings.showSidebar) return;
            settings.showSidebar = false;
            applySettings();
        },
        onLayout: () => {
            updateAiWidthWidget();
            if (editor && editor.resize) {
                try { editor.resize(); } catch (e) {}
            }
            // terminalUI 在模块尾部声明：面板按上次状态自动打开时本回调可能先于其初始化
            // 执行（TDZ），一并用 try/catch 兜底，避免中断整个模块求值。
            try {
                if (terminalUI.open) fitActiveTerm();
            } catch (e) {}
        },
    });
    window.__lens.aiPanel = aiPanel;
    // 状态栏「AI 写入」徽标：订阅面板的写操作事件（事件驱动，不轮询磁盘）
    if (typeof aiPanel.onWriteStatus === 'function') {
        // 图标走统一注册表：与工具卡里 edit_file 用的是同一枚铅笔，不在 HTML 里手写路径
        if (els.stAwIcon) els.stAwIcon.innerHTML = iconSvg('rename', 12);
        aiPanel.onWriteStatus((payload) => updateAiWriteBadge(payload));
    }
    window.__mockAiEmit = (name, payload) => {
        if (aiPanel) aiPanel.handleEvent(name, payload);
    };
    if (rt) {
        for (const eventName of ['ai-chunk', 'ai-think', 'ai-toolcall', 'ai-done', 'ai-error']) {
            rt.EventsOn(eventName, (payload) => {
                if (aiPanel) aiPanel.handleEvent(eventName, payload);
            });
        }
        // 定时任务：sched-fire 由 Go 调度器广播（多窗口都会收到，执行去重在面板内裁决）
        rt.EventsOn('sched-fire', (payload) => {
            if (aiPanel && typeof aiPanel.handleScheduleFire === 'function') {
                try { aiPanel.handleScheduleFire(payload); } catch (e) {}
            }
        });
        rt.EventsOn('schedules-changed', () => {
            const activePane = document.querySelector('.settings-pane[data-pane="schedules"]:not(.hidden)');
            if (activePane && aiPanel && typeof aiPanel.refreshScheduleSettings === 'function') {
                try { aiPanel.refreshScheduleSettings(); } catch (e) {}
            }
        });
    }
}

// toggleSidebarFilter 侧边栏文件名过滤框的开关与清理
function toggleSidebarFilter(force) {
    if (!els.sbFilterRow || !els.sbFilter) return;
    const show = typeof force === 'boolean' ? force : els.sbFilterRow.classList.contains('hidden');
    els.sbFilterRow.classList.toggle('hidden', !show);
    if (els.sbFilterBtn) els.sbFilterBtn.classList.toggle('active', show);
    if (els.sbFilterBtn) els.sbFilterBtn.setAttribute('aria-pressed', String(show));
    if (show) {
        els.sbFilter.focus();
        els.sbFilter.select();
    } else if (explorer && explorer.setFilter) {
        els.sbFilter.value = '';
        explorer.setFilter('');
    }
}

function initExplorer() {
    if (!els.sbBody) return;
    explorer = createExplorer({
        body: els.sbBody,
        titleEl: els.sbTitle,
        refreshBtn: els.sbRefresh,
        filterBtn: els.sbFilterBtn,
        listBtn: els.sbModeList,
        treeBtn: els.sbModeTree,
        readDir: (path, limit) => backend.ReadDir(path, limit),
        dirMtime: (path) => (typeof backend.DirMtime === 'function' ? backend.DirMtime(path) : Promise.resolve(0)),
        openPath: (path) => openPath(path),
        openFolder: () => openFolderDialog(),
        openFileDialog: () => openDialog(),
        isSupported: isSupportedFile,
        onContextMenu: (info, x, y, node) => showExplorerMenu(info, x, y, node),
        onMove: (items, destDir) => moveEntriesByDrag(items, destDir),
        onExternalDrop: (destDir) => setPendingExternalDrop(destDir),
        onToggleFilter: toggleSidebarFilter,
        canDrag: () => !settings.readOnlyMode,
        onModeChange: (mode) => {
            settings.sidebarMode = mode;
            applySettings();
        },
    });
    explorer.setMode(settings.sidebarMode, false);
    explorer.setAutoRefresh(settings.treeRefreshInterval);
    if (els.sbFilter) {
        let filterDebounce = 0;
        els.sbFilter.addEventListener('input', () => {
            clearTimeout(filterDebounce);
            filterDebounce = setTimeout(() => {
                if (explorer && explorer.setFilter) explorer.setFilter(els.sbFilter.value);
            }, 150);
        });
        els.sbFilter.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                toggleSidebarFilter(false);
            }
        });
    }
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
        parseAsync: (name, text, doc) => parseStructureCached(name, text, doc),
    });
    if (els.structureExport) {
        els.structureExport.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14M5.5 8.5h11.5M8 12.5h9M10.5 16.5h6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
        els.structureExport.addEventListener('click', () => showStructureExportMenu());
    }
    structurePanel.setDoc(file);
    applySidebarUI();
}

// 结构面板的结构化复制 / 导出：文本格式与「结构化目录」一致
function structureTreeText(format) {
    try {
        return structurePanel && typeof structurePanel.structureText === 'function'
            ? String(structurePanel.structureText(format, settings.structureExportLineNums) || '') : '';
    } catch (e) {
        return '';
    }
}

function showStructureExportMenu() {
    if (!ctxMenu) return;
    const has = !!structureTreeText();
    const copyItems = [
        {label: '树形结构', action: () => copyStructureTree('tree')},
        {label: '缩进列表', action: () => copyStructureTree('indent')},
        {label: 'Markdown 列表', action: () => copyStructureTree('markdown')},
        {label: 'Mermaid 大纲', action: () => copyStructureTree('mermaid')},
    ];
    const exportItems = [
        {label: '树形结构', action: () => exportStructureTree('tree')},
        {label: '缩进列表', action: () => exportStructureTree('indent')},
        {label: 'Markdown 列表', action: () => exportStructureTree('markdown')},
        {label: 'Mermaid 大纲', action: () => exportStructureTree('mermaid')},
    ];
    const r = els.structureExport.getBoundingClientRect();
    ctxMenu.open([
        {label: '复制为', icon: 'E8C8', disabled: !has, submenu: copyItems},
        {label: '导出为…', icon: 'E74E', disabled: !has, submenu: exportItems},
        {sep: true},
        {label: '附带行号', checked: settings.structureExportLineNums, action: toggleStructureExportLineNums},
    ], r.left, r.bottom + 4);
}

function toggleStructureExportLineNums() {
    settings.structureExportLineNums = !settings.structureExportLineNums;
    try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch (e) {}
    showStructureExportMenu();
}

async function copyStructureTree(format) {
    const text = structureTreeText(format);
    if (!text) {
        flash('当前文件没有可复制的结构', true);
        return;
    }
    await copyText(text, '结构');
}

async function exportStructureTree(format) {
    if (!backend.ExportStructureText) {
        flash('当前版本不支持导出结构', true);
        return;
    }
    const text = structureTreeText(format);
    if (!text) {
        flash('当前文件没有可导出的结构', true);
        return;
    }
    try {
        const ext = format === 'mermaid' ? '.mmd' : '.txt';
        const defaultName = (file && file.name ? file.name : '结构') + '-结构' + ext;
        const path = await backend.ExportStructureText(defaultName, text);
        if (!path) {
            flash('已取消导出');
            return;
        }
        flash('已导出结构：' + (baseNameOf(path) || path));
    } catch (e) {
        flash('导出结构失败：' + e, true);
    }
}

let untitledSeq = 0;

function newDocumentWith(baseName, content) {
    untitledSeq += 1;
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : '';
    const name = untitledSeq === 1 ? stem + ext : stem + ' ' + untitledSeq + ext;
    const text = content != null ? content : '';
    const doc = createDoc({
        path: null,
        name,
        content: text,
        size: new TextEncoder().encode(text).length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    doc.dirty = true;
    docs.push(doc);
    activityLog.log('tab.open', name, {format: (doc.format && doc.format.id) || ''});
    activateDoc(doc);
}

function newDocument() {
    newDocumentWith('未命名.json', '{}');
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

async function reloadActive(opts = {}) {
    const doc = file;
    if (!doc || !doc.path) return false;
    try {
        const data = await backend.OpenFile(doc.path, getFormatSettings(doc.format.id).encoding);
        const fresh = createDoc(data);
        const keepMode = doc.mode;
        const wasSplit = !!doc.splitActive;
        clearTimeout(doc.splitTimer);
        doc.splitTimer = 0;
        doc.splitActive = false;
        doc.splitKind = '';
        doc.splitDivider = null;
        doc.htmlPreviewEl = null;
        doc.htmlFrame = null;
        doc.htmlPreviewRoot = null;
        doc.htmlRootTried = false;
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
        Object.assign(doc, fresh, {id: doc.id, dirty: false, untitled: false, text: null, content: data.content, bookmarks: doc.bookmarks || new Set()});
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
        renderBookmarks(doc);
        doc.pane.classList.add('active');
        editor = doc.editor;
        currentMode = doc.mode;
        updateDocChrome();
        setDirty(false);
        applyAceMode();
        if (wasSplit && canSplitDoc(doc)) enterSplitView(doc);
        humanizeCounts();
        if (!opts.quiet) flash('已重新加载 ' + doc.name);
        return true;
    } catch (e) {
        if (!opts.quiet) flash('重新加载失败：' + e, true);
        return false;
    }
}

async function saveDoc(doc, opts = {}) {
    if (!doc || doc.browser || doc.large || doc.binary || !doc.editor) return false;
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
    const origPath = path || '';
    const hadPath = !!path;
    if (opts.saveAs || !path) {
        if (opts.auto) return false;
        path = await backend.SaveFileDialog(doc.name || '未命名.json');
        if (!path) return false;
    }
    try {
        const eol = fs.eol === 'follow' ? doc.eol : fs.eol;
        const enc = fs.encoding === 'auto' ? (doc.enc || 'utf-8') : fs.encoding;
        // 写前冲突检测：磁盘 mtime 与打开 / 上次保存时不一致时不静默覆盖外部修改
        const tracked = !opts.saveAs && hadPath && !doc.untitled && !!doc.diskMtime && !!backend.SaveFileChecked;
        let saveMtime = 0;
        if (tracked) {
            let result = await backend.SaveFileChecked(path, text, eol, doc.hasBom, enc, doc.diskMtime);
            if (result && result.conflict) {
                if (!doc.dirty) {
                    await discardDocAndReload(doc);
                    flash('文件已在外部修改，已重新加载 ' + doc.name);
                    return true;
                }
                if (opts.auto) {
                    doc.staleOnDisk = true;
                    renderTabs();
                    flash('文件已在外部修改，已跳过自动保存：' + doc.name, true);
                    return false;
                }
                const choice = await openSaveConflictDialog(doc, result.deleted);
                if (choice === 'cancel') return false;
                if (choice === 'reload') {
                    await discardDocAndReload(doc);
                    flash('已重新加载 ' + doc.name);
                    return false;
                }
                result = await backend.SaveFileChecked(path, text, eol, doc.hasBom, enc, '');
                if (!result || result.conflict) return false;
            }
            saveMtime = (result && result.mtime) || 0;
        } else {
            await backend.SaveFile(path, text, eol, doc.hasBom, enc);
        }
        if (!saveMtime && backend.GetFileStat) {
            try {
                const st = await backend.GetFileStat(path);
                if (st && st.exists) saveMtime = st.mtime || 0;
            } catch (e) {}
        }
        doc.diskMtime = saveMtime || '';
        doc.staleOnDisk = false;
        doc.enc = enc;
        doc.path = path;
        doc.name = path.split(/[\\/]/).pop();
        doc.untitled = false;
        doc.mode = savedMode;
        // 操作留痕：另存为 / 首次落盘（新建）/ 普通保存三类；自动保存不记。
        if (opts.saveAs) {
            activityLog.log('file.saveAs', path, {from: actRel(origPath), bytes: text.length});
        } else if (!hadPath) {
            activityLog.log('file.create', path, {bytes: text.length});
        } else if (!opts.auto) {
            activityLog.log('file.save', path, {bytes: text.length, mode: 'save'});
        }
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

// 放弃缓冲区修改并以磁盘版本为准：前台标签立即重载，后台标签切换时重载
async function discardDocAndReload(doc) {
    doc.dirty = false;
    if (doc === file) {
        await reloadActive({quiet: true});
        return;
    }
    doc.staleOnDisk = true;
    updateTabDirty(doc);
    renderTabs();
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
elsSettings.mdScrollSync.addEventListener('change', () => {
    settings.mdScrollSync = elsSettings.mdScrollSync.checked;
    applySettings();
    // 关闭后如果预览已经滚偏，立即按当前设置拉回/不再跟随
    if (settings.mdScrollSync && file) mdSyncScrollFromAce(file);
});
elsSettings.mdPreviewWidth.addEventListener('change', () => {
    settings.mdPreviewWidth = elsSettings.mdPreviewWidth.value;
    applySettings();
    updateStatus();
});
elsSettings.autoCheckUpdate.addEventListener('change', () => {
    settings.autoCheckUpdate = elsSettings.autoCheckUpdate.checked;
    applySettings();
});
elsSettings.showBanners.addEventListener('change', () => {
    settings.showBanners = elsSettings.showBanners.checked;
    applySettings();
    if (file) showBanner(file, file.parseError);
    else hideBanner();
});
if (elsSettings.developerMode) {
    elsSettings.developerMode.addEventListener('change', async () => {
        developerMode = elsSettings.developerMode.checked;
        syncDevConsoleVisibility();
        try {
            if (backend.SetDeveloperMode) await backend.SetDeveloperMode(developerMode);
            logFrontend('info', '开发者模式已' + (developerMode ? '开启' : '关闭'));
        } catch (e) {
            flash('保存开发者模式失败：' + e, true);
        }
    });
}
if (elsSettings.openLogs) {
    elsSettings.openLogs.addEventListener('click', async () => {
        if (!backend.OpenLogDir) return flash('当前版本不支持打开日志目录', true);
        try {
            await backend.OpenLogDir();
        } catch (e) {
            flash('打开日志目录失败：' + e, true);
        }
    });
}

// ===== 设置页：操作记录（docs/unfinished-plans/operation-audit-log.md §6.4）=====

const activityView = {entries: [], truncated: false, oldestTs: 0, loading: false};
const ACTIVITY_PAGE_SIZE = 200;

function activityFilterOf() {
    const domain = document.getElementById('activity-filter-domain');
    const actor = document.getElementById('activity-filter-actor');
    const keyword = document.getElementById('activity-filter-keyword');
    return {
        actions: domain && domain.value ? [domain.value] : [],
        actor: actor && actor.value ? actor.value : '',
        keyword: keyword ? keyword.value.trim() : '',
    };
}

async function renderActivityPane(opts = {}) {
    const listEl = document.getElementById('activity-list');
    const statusEl = document.getElementById('activity-list-status');
    const moreBtn = document.getElementById('activity-more');
    if (!listEl || activityView.loading) return;
    if (!backend.ActivityRead) {
        listEl.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'activity-empty';
        empty.textContent = '当前版本不支持操作记录（旧版后端）';
        listEl.appendChild(empty);
        return;
    }
    activityView.loading = true;
    try {
        const query = {limit: ACTIVITY_PAGE_SIZE, ...activityFilterOf()};
        if (opts.append && activityView.oldestTs > 0) query.beforeTs = activityView.oldestTs;
        const parsed = JSON.parse(await backend.ActivityRead(JSON.stringify(query)));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        activityView.entries = opts.append ? activityView.entries.concat(entries) : entries;
        activityView.truncated = !!parsed.truncated;
        const last = activityView.entries[activityView.entries.length - 1];
        activityView.oldestTs = last && last.ts ? last.ts : 0;
        renderActivityList(listEl);
        if (statusEl) {
            statusEl.textContent = activityView.entries.length
                ? '已加载 ' + activityView.entries.length + ' 条（新→旧）' + (activityView.truncated ? '；可能还有更早记录' : '')
                : '暂无记录（功能未开启或近期没有操作）';
        }
        if (moreBtn) moreBtn.classList.toggle('hidden', !activityView.entries.length || !activityView.truncated);
    } catch (e) {
        if (statusEl) statusEl.textContent = '读取失败：' + ((e && e.message) || e);
    } finally {
        activityView.loading = false;
    }
}

const ACTIVITY_ACTOR_LABEL = {user: '用户', ai: 'AI', system: '系统'};

function activityTimeText(ts) {
    const d = new Date(ts || 0);
    if (!d.getTime()) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function renderActivityList(listEl) {
    listEl.textContent = '';
    if (!activityView.entries.length) {
        const empty = document.createElement('div');
        empty.className = 'activity-empty';
        empty.textContent = '暂无记录';
        listEl.appendChild(empty);
        return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of activityView.entries) {
        frag.appendChild(buildActivityRow(entry));
    }
    listEl.appendChild(frag);
}

function buildActivityRow(entry) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = activityTimeText(entry.ts);

    const badge = document.createElement('span');
    badge.className = 'act-badge act-badge-' + (ACTIVITY_ACTOR_LABEL[entry.actor] ? entry.actor : 'system');
    badge.textContent = ACTIVITY_ACTOR_LABEL[entry.actor] || '系统';

    const action = document.createElement('span');
    action.className = 'act-action';
    action.textContent = entry.action || '?';

    const target = document.createElement('span');
    target.className = 'act-target';
    target.textContent = entry.target || '';
    target.title = entry.target || '';

    row.append(time, badge, action, target);

    const detailText = entry.detail && Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : '';
    if (detailText) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'act-detail-btn dlg-btn';
        toggle.textContent = '详情';
        const detail = document.createElement('div');
        detail.className = 'act-detail hidden';
        detail.textContent = detailText;
        toggle.addEventListener('click', () => {
            detail.classList.toggle('hidden');
            toggle.textContent = detail.classList.contains('hidden') ? '详情' : '收起';
        });
        row.appendChild(toggle);
        row.appendChild(detail);
    }
    return row;
}

function activityExportQuery() {
    return {limit: 500, ...activityFilterOf()};
}

function activityCsvCell(value) {
    const text = String(value == null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
}

async function exportActivityRecords(kind) {
    if (!backend.ActivityRead) return flash('当前版本不支持操作记录', true);
    if (!backend.SaveFileDialog || !backend.SaveFile) return flash('当前版本不支持导出', true);
    try {
        const parsed = JSON.parse(await backend.ActivityRead(JSON.stringify(activityExportQuery())));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (!entries.length) return flash('没有可导出的记录（当前筛选条件下）', true);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (kind === 'csv') {
            const rows = [['时间', '来源', '判定来源', '动作', '对象', '详情']];
            for (const e of entries) {
                rows.push([
                    new Date(e.ts || 0).toLocaleString(),
                    ACTIVITY_ACTOR_LABEL[e.actor] || e.actor || '',
                    e.source || '',
                    e.action || '',
                    e.target || '',
                    e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : '',
                ]);
            }
            const csv = '\ufeff' + rows.map((row) => row.map(activityCsvCell).join(',')).join('\r\n');
            const path = await backend.SaveFileDialog('activity-' + stamp + '.csv');
            if (path) await backend.SaveFile(path, csv, 'crlf', true, 'utf-8');
        } else {
            const json = JSON.stringify({exportedAt: Date.now(), count: entries.length, entries}, null, 2);
            const path = await backend.SaveFileDialog('activity-' + stamp + '.json');
            if (path) await backend.SaveFile(path, json, 'lf', false, 'utf-8');
        }
        flash('已导出 ' + entries.length + ' 条记录');
    } catch (e) {
        flash('导出失败：' + ((e && e.message) || e), true);
    }
}

if (elsSettings.activityLog) {
    elsSettings.activityLog.addEventListener('change', () => {
        settings.activityLog = elsSettings.activityLog.checked;
        applySettings();
        flash(settings.activityLog ? '操作记录已开启' : '操作记录已关闭，不再新增记录');
    });
}
if (elsSettings.activityRetention) {
    elsSettings.activityRetention.addEventListener('change', () => {
        const n = Math.round(Number(elsSettings.activityRetention.value) || 12);
        settings.activityRetentionMonths = Math.min(60, Math.max(1, n));
        applySettings();
    });
}
if (elsSettings.openActivity) {
    elsSettings.openActivity.addEventListener('click', async () => {
        if (!backend.ActivityPath || !backend.ShowInFolder) return flash('当前版本不支持', true);
        try {
            await backend.ShowInFolder(await backend.ActivityPath());
        } catch (e) {
            flash('打开记录目录失败：' + ((e && e.message) || e), true);
        }
    });
}
if (elsSettings.exportActivityJson) {
    elsSettings.exportActivityJson.addEventListener('click', () => exportActivityRecords('json'));
}
if (elsSettings.exportActivityCsv) {
    elsSettings.exportActivityCsv.addEventListener('click', () => exportActivityRecords('csv'));
}
if (elsSettings.clearActivity) {
    elsSettings.clearActivity.addEventListener('click', () => {
        if (!backend.ActivityClear) return flash('当前版本不支持操作记录', true);
        openCloseConfirm('将删除全部操作记录（包括按月分文件与滚动分段），只保留一条「已清空」标记。确定继续吗？', async () => {
            try {
                await backend.ActivityClear();
                flash('操作记录已清空');
                renderActivityPane();
            } catch (e) {
                flash('清空失败：' + ((e && e.message) || e), true);
            }
        }, '清空', '清空操作记录');
    });
}
{
    const domainSel = document.getElementById('activity-filter-domain');
    const actorSel = document.getElementById('activity-filter-actor');
    const keywordInput = document.getElementById('activity-filter-keyword');
    const refreshBtn = document.getElementById('activity-refresh');
    const moreBtn = document.getElementById('activity-more');
    if (domainSel) domainSel.addEventListener('change', () => renderActivityPane());
    if (actorSel) actorSel.addEventListener('change', () => renderActivityPane());
    if (keywordInput) keywordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') renderActivityPane();
    });
    if (refreshBtn) refreshBtn.addEventListener('click', () => renderActivityPane());
    if (moreBtn) moreBtn.addEventListener('click', () => renderActivityPane({append: true}));
}
const debugConsoleBtn = document.getElementById('opt-debug-console');
if (debugConsoleBtn) debugConsoleBtn.addEventListener('click', () => toggleDockView('debug'));
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
elsSettings.writingMode.addEventListener('change', () => {
    settings.writingMode = elsSettings.writingMode.checked;
    applySettings();
    flash(settings.writingMode ? '写作模式已开启' : '写作模式已关闭');
});
elsSettings.writingFont.addEventListener('change', () => {
    settings.writingFont = elsSettings.writingFont.value;
    applySettings();
});
elsSettings.writingFontSize.addEventListener('input', () => {
    settings.writingFontSize = Number(elsSettings.writingFontSize.value);
    applySettings();
});
elsSettings.writingPaper.addEventListener('change', () => {
    settings.writingPaper = elsSettings.writingPaper.value;
    applySettings();
});
elsSettings.writingLineNumbers.addEventListener('change', () => {
    settings.writingLineNumbers = elsSettings.writingLineNumbers.checked;
    applySettings();
});
elsSettings.writingTypewriter.addEventListener('change', () => {
    settings.writingTypewriter = elsSettings.writingTypewriter.checked;
    applySettings();
});
elsSettings.writingFocus.addEventListener('change', () => {
    settings.writingFocus = elsSettings.writingFocus.checked;
    applySettings();
});
elsSettings.writingDailyGoal.addEventListener('change', () => {
    settings.writingDailyGoal = Math.max(0, Number(elsSettings.writingDailyGoal.value) || 0);
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
        maxBtn.innerHTML = iconSvg(maximised ? 'restore' : 'maximize', 12);
        maxBtn.title = maximised ? '还原' : '最大化';
        // Wails 运行时的边缘 resize 检测不判断最大化状态：无边框窗口最大化后
        // 鼠标靠近左右两侧仍会亮起调整宽度光标。最大化时直接关掉检测，
        // 还原（含 Win+方向键贴靠，经 resize 事件回到这里）再恢复。
        try {
            if (window.wails && window.wails.flags) window.wails.flags.enableResize = !maximised;
        } catch (e) {}
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

// IDEA 新 UI 式主菜单：平时隐藏，点三横把工具栏左侧换成横排菜单条；Alt+字母直接唤出对应菜单
const tbMenu = document.getElementById('tb-menu');
const menuBar = document.getElementById('menubar');
const toolbarEl = document.getElementById('toolbar');
const menuKeyMap = {KeyF: 'file', KeyE: 'edit', KeyO: 'format', KeyV: 'view', KeyU: 'tools', KeyT: 'theme', KeyH: 'help'};
let openMenuEl = null;

function showMenuBar() {
    toolbarEl.classList.add('menu-active');
    menuBar.classList.remove('hidden');
}

function hideMenuBar() {
    closeAllMenus();
    toolbarEl.classList.remove('menu-active');
    menuBar.classList.add('hidden');
}

function openMenuByKind(kind) {
    const menuEl = menuBar.querySelector('.menu[data-menu="' + kind + '"]');
    if (menuEl) openMenu(menuEl);
}

tbMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenuBar();
});

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
    activityLog.log('file.format', doc.path, {kind: 'format'});
    if (currentMode === 'table') renderCsvTableView(doc);
}

// switchMode 外壳负责操作留痕（view.switch）；实际切换在 applySwitchMode。
function switchMode(mode) {
    const fromMode = currentMode;
    const docBefore = file;
    const wasSplit = !!(docBefore && docBefore.splitActive);
    applySwitchMode(mode);
    if (file && file.format && file.format.patch && currentMode !== 'patch') refreshPatchMarkers(file);
    const splitChanged = !!(file && file.splitActive) !== wasSplit;
    if (currentMode !== fromMode || splitChanged) {
        activityLog.log('view.switch', currentMode, {from: fromMode});
    }
}

function applySwitchMode(mode) {
    if (!editor) return;
    const doc = file;
    if (mode === 'split') {
        if (doc) enterSplitView(doc);
        return;
    }
    if (doc && doc.splitActive) exitSplitView(doc);
    if (mode === 'sql') {
        // SQL 是覆盖层：再点一次（或菜单再次选择）关闭，回到原视图
        if (doc && doc.sqlActive) closeSqlView(doc);
        else enterSqlView(doc);
        return;
    }
    if (doc && doc.sqlActive) closeSqlView(doc);
    if (currentMode === mode) return;
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
    if (mode === 'patch') {
        if (doc && doc.format && doc.format.patch) {
            doc.mode = 'patch';
            currentMode = 'patch';
            applyReadOnlyToDoc(doc);
            showPatchView(doc, patchViewContext());
            updateStatus();
            updateSearchState();
        }
        return;
    }
    if (currentMode === 'patch') {
        hidePatchView(doc);
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
            if (editor.aceEditor) { hookCodeFoldPreviews(editor.aceEditor); hookMultiCursor(editor.aceEditor); updateCodeFoldPreviews(editor.aceEditor); }
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

const findState = {
    open: false,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ranges: [],
    index: -1,
    target: null,
    markerIds: [],
    aceSession: null,
    aceChangeHandler: null,
    host: null,
    textLayer: null,
    textInner: null,
    textMarkerEls: [],
    textScrollTarget: null,
    textScrollHandler: null,
    textResizeObserver: null,
    timer: 0,
};
const findMarkerLimit = 2000;

function findTarget() {
    if (!file || !file.editor) return null;
    if (file.sqlActive) return null; // SQL 覆盖层打开时不可用编辑器查找
    if (currentMode === 'code') {
        const ace = file.editor.aceEditor;
        return ace ? {type: 'ace', ace} : null;
    }
    if (currentMode === 'text') {
        const textarea = file.pane && file.pane.querySelector('textarea.jsoneditor-text');
        return textarea ? {type: 'text', textarea} : null;
    }
    return null;
}

function ensureFindBarHost() {
    const group = file ? groupOfDoc(file.id) : null;
    const host = group ? els.editor.querySelector('.egroup[data-gid="' + group.id + '"] .ehost') : null;
    const target = host || els.editor;
    if (!target) return;
    const hostChanged = findState.host !== target;
    if (findState.host && findState.host !== target) findState.host.classList.remove('find-open');
    target.classList.add('find-open');
    findState.host = target;
    if (els.findBar.parentElement !== target) target.appendChild(els.findBar);
    if (hostChanged) resizeFindEditor();
}

function resizeFindEditor() {
    requestAnimationFrame(() => {
        if (!file || !file.editor) return;
        try {
            if (file.editor.resize) file.editor.resize();
            if (file.editor.aceEditor) file.editor.aceEditor.resize();
        } catch (e) {}
    });
}

function clearFindMarkers() {
    const target = findState.target;
    if (target && target.type === 'ace') {
        const session = target.ace.session;
        for (const id of findState.markerIds) {
            try { session.removeMarker(id); } catch (e) {}
        }
    }
    findState.markerIds = [];
}

function detachFindAceChange() {
    if (findState.aceSession && findState.aceChangeHandler) {
        try { findState.aceSession.off('change', findState.aceChangeHandler); } catch (e) {}
    }
    findState.aceSession = null;
    findState.aceChangeHandler = null;
}

function clearTextFindLayer() {
    if (findState.textScrollTarget && findState.textScrollHandler) {
        findState.textScrollTarget.removeEventListener('scroll', findState.textScrollHandler);
    }
    if (findState.textResizeObserver) {
        findState.textResizeObserver.disconnect();
        findState.textResizeObserver = null;
    }
    findState.textScrollTarget = null;
    findState.textScrollHandler = null;
    if (findState.textLayer) {
        findState.textLayer.remove();
        findState.textLayer = null;
    }
    findState.textInner = null;
    findState.textMarkerEls = [];
}

function syncFindTextLayerScroll() {
    const textarea = findState.textScrollTarget;
    if (!findState.textInner || !textarea) return;
    findState.textInner.style.transform = 'translate(' + (-textarea.scrollLeft) + 'px,' + (-textarea.scrollTop) + 'px)';
}

function positionFindTextLayer() {
    const layer = findState.textLayer;
    const textarea = findState.textScrollTarget;
    const host = findState.host;
    if (!layer || !textarea || !host) return;
    const hostRect = host.getBoundingClientRect();
    const rect = textarea.getBoundingClientRect();
    layer.style.left = (rect.left - hostRect.left) + 'px';
    layer.style.top = (rect.top - hostRect.top) + 'px';
    layer.style.width = textarea.clientWidth + 'px';
    layer.style.height = textarea.clientHeight + 'px';
    if (findState.textInner) findState.textInner.style.width = textarea.clientWidth + 'px';
}

function buildTextFindLayer(target) {
    clearTextFindLayer();
    const textarea = target.textarea;
    const host = findState.host;
    const ranges = findState.ranges;
    if (!textarea || !host || !ranges.length || textarea.value.length > 1500000) return;
    const layer = document.createElement('div');
    layer.className = 'find-text-layer';
    layer.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'find-text-layer-inner';
    const style = getComputedStyle(textarea);
    const copied = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
        'wordSpacing', 'textAlign', 'textIndent', 'textTransform', 'whiteSpace', 'wordBreak',
        'overflowWrap', 'tabSize', 'direction'];
    for (const prop of copied) inner.style[prop] = style[prop];
    inner.style.padding = style.padding;
    inner.style.minHeight = textarea.clientHeight + 'px';
    const text = textarea.value;
    const fragment = document.createDocumentFragment();
    const marks = [];
    let pos = 0;
    const limit = Math.min(ranges.length, findMarkerLimit);
    for (let i = 0; i < limit; i++) {
        const range = ranges[i];
        if (range.start < pos) continue;
        fragment.appendChild(document.createTextNode(text.slice(pos, range.start)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(range.start, range.end);
        if (i === findState.index) mark.classList.add('current');
        fragment.appendChild(mark);
        marks.push(mark);
        pos = range.end;
    }
    fragment.appendChild(document.createTextNode(text.slice(pos)));
    inner.appendChild(fragment);
    layer.appendChild(inner);
    host.appendChild(layer);
    findState.textLayer = layer;
    findState.textInner = inner;
    findState.textMarkerEls = marks;
    findState.textScrollTarget = textarea;
    findState.textScrollHandler = () => syncFindTextLayerScroll();
    textarea.addEventListener('scroll', findState.textScrollHandler, {passive: true});
    if (window.ResizeObserver) {
        findState.textResizeObserver = new ResizeObserver(() => positionFindTextLayer());
        findState.textResizeObserver.observe(textarea);
    }
    positionFindTextLayer();
    syncFindTextLayerScroll();
}

function aceFindRanges(ace) {
    const search = ace.$search;
    if (!search) return [];
    search.set({
        needle: els.findInput.value,
        caseSensitive: findState.caseSensitive,
        wholeWord: findState.wholeWord,
        regExp: findState.regex,
        wrap: false,
        skipCurrent: false,
    });
    return search.findAll(ace.session) || [];
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textFindRanges(text) {
    const query = els.findInput.value;
    if (!query) return [];
    let pattern;
    if (findState.regex) {
        pattern = findState.wholeWord ? '\\b(?:' + query + ')\\b' : query;
    } else {
        const escaped = escapeRegExp(query);
        pattern = findState.wholeWord ? '\\b' + escaped + '\\b' : escaped;
    }
    const re = new RegExp(pattern, findState.caseSensitive ? 'g' : 'gi');
    const ranges = [];
    let match;
    while ((match = re.exec(text)) !== null) {
        if (!match[0].length) {
            re.lastIndex += 1;
            continue;
        }
        ranges.push({start: match.index, end: match.index + match[0].length});
        if (ranges.length >= 20000) break;
    }
    return ranges;
}

function updateFindNav() {
    const has = findState.ranges.length > 0;
    els.findPrev.disabled = !has;
    els.findNext.disabled = !has;
}

function updateFindCount() {
    if (!els.findCount.classList.contains('error')) {
        els.findCount.textContent = findState.ranges.length + ' 个结果';
    }
    updateFindNav();
}

function selectFindMatch(index, opts = {}) {
    const target = findState.target;
    const total = findState.ranges.length;
    if (!target || !total) {
        updateFindCount();
        return;
    }
    findState.index = ((index % total) + total) % total;
    const range = findState.ranges[findState.index];
    if (target.type === 'ace') {
        target.ace.selection.setSelectionRange(range, false);
        if (opts.scroll !== false) target.ace.scrollToLine(range.start.row, true, true);
    } else {
        const textarea = target.textarea;
        textarea.setSelectionRange(range.start, range.end);
        if (opts.scroll !== false) {
            const before = textarea.value.slice(0, range.start);
            const line = before.split('\n').length;
            const style = getComputedStyle(textarea);
            const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.5;
            const top = (line - 1) * lineHeight - textarea.clientHeight / 2 + lineHeight / 2;
            textarea.scrollTop = Math.max(0, Math.min(top, textarea.scrollHeight - textarea.clientHeight));
        }
        for (let i = 0; i < findState.textMarkerEls.length; i++) {
            findState.textMarkerEls[i].classList.toggle('current', i === findState.index);
        }
        syncFindTextLayerScroll();
    }
    updateFindCount();
}

function runFind(opts = {}) {
    if (!findState.open) return;
    const target = findTarget();
    if (!target) {
        closeFindBar({keepFocus: true});
        return;
    }
    ensureFindBarHost();
    clearFindMarkers();
    clearTextFindLayer();
    const previousIndex = findState.index;
    findState.target = target;
    if (target.type === 'ace') {
        const session = target.ace.session;
        if (findState.aceSession !== session) {
            detachFindAceChange();
            const handler = () => {
                if (findState.open && findState.target === target) scheduleFind();
            };
            session.on('change', handler);
            findState.aceSession = session;
            findState.aceChangeHandler = handler;
        }
    } else {
        detachFindAceChange();
    }
    findState.ranges = [];
    findState.index = -1;
    els.findCount.classList.remove('error');
    if (!els.findInput.value) {
        updateFindCount();
        return;
    }
    if (findState.regex) {
        try {
            new RegExp(els.findInput.value);
        } catch (e) {
            els.findCount.textContent = '正则表达式无效';
            els.findCount.classList.add('error');
            updateFindNav();
            return;
        }
    }
    try {
        findState.ranges = target.type === 'ace' ? aceFindRanges(target.ace) : textFindRanges(target.textarea.value);
    } catch (e) {
        els.findCount.textContent = '正则表达式无效';
        els.findCount.classList.add('error');
        updateFindNav();
        return;
    }
    if (target.type === 'ace' && findState.ranges.length) {
        const session = target.ace.session;
        const limit = Math.min(findState.ranges.length, findMarkerLimit);
        for (let i = 0; i < limit; i++) {
            findState.markerIds.push(session.addMarker(findState.ranges[i], 'cadt-find-match', 'text', false));
        }
    }
    if (target.type === 'text' && findState.ranges.length) buildTextFindLayer(target);
    if (!findState.ranges.length) {
        updateFindCount();
        return;
    }
    const keep = opts.keepIndex && previousIndex >= 0 && previousIndex < findState.ranges.length ? previousIndex : 0;
    selectFindMatch(keep, {scroll: true});
}

function stepFind(delta) {
    if (!findState.open || !findState.ranges.length) return;
    selectFindMatch(findState.index + delta, {scroll: true});
}

function scheduleFind() {
    clearTimeout(findState.timer);
    findState.timer = setTimeout(() => {
        findState.timer = 0;
        runFind({keepIndex: false});
    }, 80);
}

function selectedFindText() {
    const target = findTarget();
    if (!target) return '';
    if (target.type === 'ace') return target.ace.getSelectedText() || '';
    const textarea = target.textarea;
    return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
}

function focusFindEditor() {
    if (currentMode === 'code' && file && file.editor && file.editor.aceEditor) {
        file.editor.aceEditor.focus();
    } else if (currentMode === 'text' && file && file.pane) {
        const textarea = file.pane.querySelector('textarea.jsoneditor-text');
        if (textarea) textarea.focus();
    }
}

function openFindBar() {
    if (!findTarget()) {
        flash('内容搜索请在代码视图或文本视图中使用');
        return;
    }
    if (findState.open) {
        els.findInput.focus();
        els.findInput.select();
        return;
    }
    ensureFindBarHost();
    findState.open = true;
    els.findBar.classList.remove('hidden');
    els.abSearch.classList.add('active');
    const selected = selectedFindText();
    if (selected && selected.length <= 200 && !/[\r\n]/.test(selected)) {
        els.findInput.value = selected;
    }
    els.findInput.focus();
    els.findInput.select();
    runFind({keepIndex: false});
}

function closeFindBar(opts = {}) {
    if (!findState.open) return;
    findState.open = false;
    clearFindMarkers();
    clearTextFindLayer();
    detachFindAceChange();
    findState.target = null;
    findState.ranges = [];
    findState.index = -1;
    if (findState.host) {
        findState.host.classList.remove('find-open');
        findState.host = null;
    }
    els.findBar.classList.add('hidden');
    if (els.abSearch) els.abSearch.classList.remove('active');
    resizeFindEditor();
    if (!opts.keepFocus) focusFindEditor();
}

function bindFindBar() {
    els.findBar.addEventListener('keydown', (e) => {
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey &&
            !e.shiftKey && findState.ranges.length) {
            e.preventDefault();
            e.stopPropagation();
            stepFind(e.key === 'ArrowUp' ? -1 : 1);
        }
    });
    els.findInput.addEventListener('input', scheduleFind);
    els.findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            stepFind(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFindBar();
        }
    });
    els.findPrev.addEventListener('click', () => stepFind(-1));
    els.findNext.addEventListener('click', () => stepFind(1));
    els.findClose.addEventListener('click', () => closeFindBar());
    const options = [
        [els.findCase, 'caseSensitive'],
        [els.findWord, 'wholeWord'],
        [els.findRegex, 'regex'],
    ];
    for (const [button, key] of options) {
        button.addEventListener('click', () => {
            findState[key] = !findState[key];
            button.classList.toggle('active', findState[key]);
            button.setAttribute('aria-pressed', String(findState[key]));
            els.findInput.focus();
            runFind({keepIndex: true});
        });
    }
    els.findPrev.disabled = true;
    els.findNext.disabled = true;
}

bindFindBar();

const globalSearch = {
    open: false,
    seq: 0,
    timer: 0,
    hits: [],
    index: -1,
    root: '',
    previousFocus: null,
};

function globalSearchRoot() {
    if (workspaceFolder) return workspaceFolder;
    if (file && file.path) {
        const s = String(file.path).replace(/\\/g, '/');
        const i = s.lastIndexOf('/');
        if (i > 0) return s.slice(0, i);
    }
    return '';
}

function openGlobalSearch() {
    if (globalSearch.open) {
        els.gsInput.focus();
        els.gsInput.select();
        return;
    }
    const root = globalSearchRoot();
    if (!root) {
        flash('请先打开文件夹或文件');
        return;
    }
    globalSearch.open = true;
    globalSearch.root = root;
    globalSearch.previousFocus = document.activeElement;
    globalSearch.hits = [];
    globalSearch.index = -1;
    els.gsRoot.textContent = root;
    els.gsInput.value = '';
    els.gsCount.textContent = '';
    showGlobalSearchEmpty('输入内容，在打开的工作区中搜索文本');
    els.gsMask.classList.remove('hidden');
    els.gsInput.focus();
}

function closeGlobalSearch() {
    if (!globalSearch.open) return;
    globalSearch.open = false;
    clearTimeout(globalSearch.timer);
    globalSearch.seq++;
    els.gsMask.classList.add('hidden');
    const prev = globalSearch.previousFocus;
    globalSearch.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    } else {
        focusFindEditor();
    }
}

function showGlobalSearchEmpty(text) {
    els.gsList.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'gs-empty';
    empty.textContent = text;
    els.gsList.appendChild(empty);
}

function scheduleGlobalSearch() {
    clearTimeout(globalSearch.timer);
    globalSearch.timer = setTimeout(runGlobalSearch, 180);
}

async function runGlobalSearch() {
    if (!globalSearch.open) return;
    const query = els.gsInput.value;
    const seq = ++globalSearch.seq;
    globalSearch.hits = [];
    globalSearch.index = -1;
    if (!query.trim()) {
        els.gsCount.textContent = '';
        showGlobalSearchEmpty('输入内容，在打开的工作区中搜索文本');
        return;
    }
    els.gsCount.textContent = '搜索中…';
    try {
        const res = await backend.SearchWorkspace(globalSearch.root, query, false, 400);
        if (!globalSearch.open || seq !== globalSearch.seq) return;
        renderGlobalSearchResults(res || {hits: []});
    } catch (e) {
        if (seq !== globalSearch.seq) return;
        els.gsCount.textContent = '搜索失败';
        showGlobalSearchEmpty('搜索失败：' + e);
    }
}

function globalSearchRow(hit, index) {
    const row = document.createElement('div');
    row.className = 'gs-row';
    row.dataset.i = String(index);
    row.setAttribute('role', 'option');
    const icon = document.createElement('span');
    icon.className = 'gs-file-icon';
    try {
        const spec = fileIconSpec(hit.name);
        icon.innerHTML = spec.svg;
        icon.classList.add(spec.className);
    } catch (e) {}
    const main = document.createElement('div');
    main.className = 'gs-main';
    const line1 = document.createElement('div');
    line1.className = 'gs-line1';
    const name = document.createElement('span');
    name.className = 'gs-name';
    name.textContent = hit.name || '';
    const dir = document.createElement('span');
    dir.className = 'gs-dir';
    dir.textContent = hit.dir || '';
    line1.append(name, dir);
    const line2 = document.createElement('div');
    line2.className = 'gs-line2';
    const ln = document.createElement('span');
    ln.className = 'gs-ln';
    ln.textContent = String(hit.line || '');
    const preview = document.createElement('span');
    preview.className = 'gs-preview';
    const text = String(hit.preview == null ? '' : hit.preview);
    const start = Math.max(0, Math.min(Number(hit.matchStart) || 0, text.length));
    const end = Math.max(start, Math.min(Number(hit.matchEnd) || 0, text.length));
    if (start > 0) preview.appendChild(document.createTextNode(text.slice(0, start)));
    if (end > start) {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(start, end);
        preview.appendChild(mark);
    }
    if (end < text.length) preview.appendChild(document.createTextNode(text.slice(end)));
    line2.append(ln, preview);
    main.append(line1, line2);
    row.append(icon, main);
    row.addEventListener('click', () => {
        globalSearch.index = index;
        updateGlobalSearchSelection();
        openGlobalSearchHit(hit);
    });
    return row;
}

function renderGlobalSearchResults(res) {
    const hits = Array.isArray(res.hits) ? res.hits : [];
    globalSearch.hits = hits;
    globalSearch.index = hits.length ? 0 : -1;
    els.gsList.textContent = '';
    if (!hits.length) {
        els.gsCount.textContent = '0 个结果';
        showGlobalSearchEmpty('未找到匹配内容');
        return;
    }
    const fragment = document.createDocumentFragment();
    hits.forEach((hit, i) => fragment.appendChild(globalSearchRow(hit, i)));
    els.gsList.appendChild(fragment);
    els.gsCount.textContent = hits.length + ' 个结果' + (res.truncated ? '（仅显示前 ' + hits.length + ' 个）' : '');
    updateGlobalSearchSelection();
}

function updateGlobalSearchSelection() {
    const rows = els.gsList.querySelectorAll('.gs-row');
    for (let i = 0; i < rows.length; i++) {
        const selected = i === globalSearch.index;
        rows[i].classList.toggle('selected', selected);
        rows[i].setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) rows[i].scrollIntoView({block: 'nearest'});
    }
}

function moveGlobalSearchSelection(delta) {
    const total = globalSearch.hits.length;
    if (!total) return;
    globalSearch.index = ((globalSearch.index + delta) % total + total) % total;
    updateGlobalSearchSelection();
}

async function selectMatchInDoc(doc, line, column = 1, length = 1) {
    if (!doc || doc.binary || !doc.editor) return;
    if (doc !== file) await activateDoc(doc);
    const mode = doc.format && doc.format.table ? 'text' : 'code';
    if (currentMode !== mode) switchMode(mode);
    if (mode === 'code') {
        const ready = await waitUntil(() => doc.editor && doc.editor.aceEditor);
        if (!ready) return;
        const ace = doc.editor.aceEditor;
        const lineNo = Math.max(1, Math.min(Number(line) || 1, ace.session.getLength()));
        const col = Math.max(0, (Number(column) || 1) - 1);
        const len = Math.max(1, Number(length) || 1);
        ace.gotoLine(lineNo, col, false);
        ace.selection.setSelectionRange({
            start: {row: lineNo - 1, column: col},
            end: {row: lineNo - 1, column: col + len},
        }, false);
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
    const lineStart = start;
    start += Math.max(0, (Number(column) || 1) - 1);
    const end = Math.min(start + Math.max(1, Number(length) || 1), lineStart + lines[index].length);
    textarea.focus();
    textarea.setSelectionRange(start, Math.max(start, end));
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, index * lineHeight - textarea.clientHeight / 2);
}

async function openGlobalSearchHit(hit) {
    if (!hit || !hit.path) return;
    closeGlobalSearch();
    try {
        await openPaths([hit.path]);
        const doc = findDocByPath(hit.path);
        if (doc) await selectMatchInDoc(doc, hit.line, hit.column, hit.length);
    } catch (e) {
        flash('打开失败：' + e, true);
    }
}

function handleGlobalSearchKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeGlobalSearch();
        return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveGlobalSearchSelection(e.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (globalSearch.hits.length) openGlobalSearchHit(globalSearch.hits[globalSearch.index]);
    }
}

function bindGlobalSearch() {
    els.gsInput.addEventListener('input', scheduleGlobalSearch);
    els.gsInput.addEventListener('keydown', handleGlobalSearchKey);
    els.gsMask.addEventListener('mousedown', (e) => {
        if (e.target === els.gsMask) closeGlobalSearch();
    });
}
bindGlobalSearch();

// ---- JSONPath 查询栏 ----
const JSON_QUERY_FORMATS = new Set(['json', 'jsonl', 'yaml', 'toml', 'ini']);
const JSON_QUERY_LIMIT = 500;
const jsonQuery = {
    open: false,
    doc: null,
    rootValue: null,
    lineMap: new Map(),
    results: [],
    index: -1,
    seq: 0,
    timer: 0,
    previousFocus: null,
};

function jpEls() {
    return {
        mask: document.getElementById('jp-mask'),
        input: document.getElementById('jp-input'),
        list: document.getElementById('jp-list'),
        count: document.getElementById('jp-count'),
        root: document.getElementById('jp-root'),
    };
}

function jsonQuerySupported(doc) {
    return !!doc && !doc.binary && !doc.large && !!doc.format && JSON_QUERY_FORMATS.has(doc.format.id);
}

function jsonQueryValuePreview(value) {
    if (typeof value === 'string') {
        const quoted = JSON.stringify(value);
        return quoted.length > 220 ? quoted.slice(0, 220) + '…"' : quoted;
    }
    try {
        const text = JSON.stringify(value);
        return text.length > 220 ? text.slice(0, 220) + '…' : text;
    } catch (e) {
        return String(value);
    }
}

function showJsonQueryEmpty(text) {
    const {list} = jpEls();
    if (!list) return;
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'gs-empty';
    empty.textContent = text;
    list.appendChild(empty);
}

function openJsonQuery() {
    const doc = file;
    if (!jsonQuerySupported(doc)) {
        flash('当前文件不支持 JSONPath 查询（JSON/JSONL/YAML/TOML/INI）', true);
        return;
    }
    const elsJp = jpEls();
    if (!elsJp.mask || !elsJp.input) return;
    const text = structureTextForDoc(doc);
    let rootValue;
    try {
        rootValue = doc.format.parse(text);
    } catch (e) {
        flash('解析失败：' + ((e && e.message) || e), true);
        return;
    }
    jsonQuery.open = true;
    jsonQuery.doc = doc;
    jsonQuery.rootValue = rootValue;
    jsonQuery.lineMap = doc.format.id === 'json' ? buildJsonLineMap(text) : new Map();
    jsonQuery.results = [];
    jsonQuery.index = -1;
    jsonQuery.seq++;
    jsonQuery.previousFocus = document.activeElement;
    elsJp.mask.classList.remove('hidden');
    elsJp.input.value = '';
    elsJp.count.textContent = '';
    const kind = Array.isArray(rootValue) ? '数组' : (rootValue && typeof rootValue === 'object' ? '对象' : typeof rootValue);
    elsJp.root.textContent = (doc.name || '') + ' · $ · ' + kind;
    showJsonQueryEmpty('输入 JSONPath 后按 Enter 查看结果');
    elsJp.input.focus();
}

function closeJsonQuery() {
    if (!jsonQuery.open) return;
    jsonQuery.open = false;
    clearTimeout(jsonQuery.timer);
    jsonQuery.seq++;
    const {mask} = jpEls();
    if (mask) mask.classList.add('hidden');
    const prev = jsonQuery.previousFocus;
    jsonQuery.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

function scheduleJsonQuery() {
    clearTimeout(jsonQuery.timer);
    jsonQuery.timer = setTimeout(runJsonQuery, 160);
}

function renderJsonQueryResults(matches, truncated) {
    const {list, count} = jpEls();
    if (!list) return;
    jsonQuery.results = matches;
    jsonQuery.index = matches.length ? 0 : -1;
    list.textContent = '';
    count.textContent = matches.length + ' 项' + (truncated ? '（仅显示前 ' + JSON_QUERY_LIMIT + '）' : '');
    if (!matches.length) {
        showJsonQueryEmpty('没有匹配结果');
        return;
    }
    matches.forEach((match, index) => {
        const row = document.createElement('div');
        row.className = 'gs-row jp-row' + (index === 0 ? ' selected' : '');
        row.dataset.i = String(index);
        row.setAttribute('role', 'option');
        const main = document.createElement('div');
        main.className = 'jp-main';
        const path = document.createElement('div');
        path.className = 'jp-path';
        path.textContent = match.path;
        const value = document.createElement('div');
        value.className = 'jp-value';
        value.textContent = jsonQueryValuePreview(match.value);
        main.append(path, value);
        const loc = jsonQuery.lineMap.get(match.path);
        const meta = document.createElement('span');
        meta.className = 'jp-meta';
        meta.textContent = loc ? '第 ' + loc.line + ' 行' : '';
        row.append(main, meta);
        row.addEventListener('click', () => openJsonQueryHit(index));
        row.addEventListener('mouseenter', () => setJsonQuerySelection(index));
        list.appendChild(row);
    });
}

function setJsonQuerySelection(index) {
    const {list} = jpEls();
    if (!list) return;
    const rows = list.querySelectorAll('.jp-row');
    jsonQuery.index = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => row.classList.toggle('selected', i === jsonQuery.index));
    const current = rows[jsonQuery.index];
    if (current && current.scrollIntoView) current.scrollIntoView({block: 'nearest'});
}

function runJsonQuery() {
    if (!jsonQuery.open) return;
    const {input, count} = jpEls();
    const expr = input ? input.value : '';
    const seq = ++jsonQuery.seq;
    if (!expr.trim()) {
        count.textContent = '';
        showJsonQueryEmpty('输入 JSONPath 后按 Enter 查看结果');
        return;
    }
    let matches;
    try {
        matches = queryJsonPath(jsonQuery.rootValue, expr);
    } catch (e) {
        count.textContent = '语法错误';
        showJsonQueryEmpty('JSONPath 无效：' + ((e && e.message) || e));
        return;
    }
    if (!jsonQuery.open || seq !== jsonQuery.seq) return;
    const truncated = matches.length > JSON_QUERY_LIMIT;
    renderJsonQueryResults(matches.slice(0, JSON_QUERY_LIMIT), truncated);
}

async function openJsonQueryHit(index) {
    const match = jsonQuery.results[index];
    if (!match) return;
    const doc = jsonQuery.doc;
    const loc = jsonQuery.lineMap.get(match.path);
    if (loc && doc && docs.includes(doc)) {
        closeJsonQuery();
        await selectLineInDoc(doc, loc.line, loc.column);
        return;
    }
    await copyText(match.path, 'JSONPath 路径');
}

function handleJsonQueryKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeJsonQuery();
        return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setJsonQuerySelection(jsonQuery.index + (e.key === 'ArrowDown' ? 1 : -1));
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        openJsonQueryHit(jsonQuery.index);
    }
}

function bindJsonQuery() {
    const {input, mask} = jpEls();
    if (!input || !mask) return;
    input.addEventListener('input', scheduleJsonQuery);
    input.addEventListener('keydown', handleJsonQueryKey);
    mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) closeJsonQuery();
    });
}
bindJsonQuery();

// ---- 两个文件 Diff ----
const diffState = {open: false, previousFocus: null, running: false};

function diffEls() {
    return {
        mask: document.getElementById('diff-mask'),
        a: document.getElementById('diff-a'),
        b: document.getElementById('diff-b'),
        run: document.getElementById('diff-run'),
        close: document.getElementById('diff-close'),
        semantic: document.getElementById('diff-semantic'),
        summary: document.getElementById('diff-summary'),
        semanticList: document.getElementById('diff-semantic-list'),
        output: document.getElementById('diff-output'),
    };
}

function fillDiffSelect(select, entries) {
    select.textContent = '';
    for (const [path, name] of entries) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = name + ' — ' + path;
        select.appendChild(option);
    }
}

function openDiffDialog(pathA, pathB) {
    const elsD = diffEls();
    if (!elsD.mask) return;
    const candidates = docs.filter((d) => d.path && !d.binary);
    const map = new Map(candidates.map((d) => [d.path, d.name]));
    if (pathA && !map.has(pathA)) map.set(pathA, baseNameOf(pathA) || pathA);
    if (pathB && !map.has(pathB)) map.set(pathB, baseNameOf(pathB) || pathB);
    if (map.size < 2) {
        flash('至少打开两个文本文件才能比较', true);
        return;
    }
    const entries = [...map.entries()].sort((x, y) => x[1].localeCompare(y[1], 'zh-CN'));
    fillDiffSelect(elsD.a, entries);
    fillDiffSelect(elsD.b, entries);
    if (pathA && map.has(pathA)) elsD.a.value = pathA;
    if (pathB && map.has(pathB)) elsD.b.value = pathB;
    if (elsD.b.value === elsD.a.value) {
        const other = entries.find(([path]) => path !== elsD.a.value);
        if (other) elsD.b.value = other[0];
    }
    diffState.open = true;
    diffState.previousFocus = document.activeElement;
    elsD.mask.classList.remove('hidden');
    elsD.semanticList.classList.add('hidden');
    elsD.semanticList.textContent = '';
    elsD.output.textContent = '';
    elsD.summary.textContent = pathA || pathB ? '正在比较…' : '选择两个文件后点击“比较”';
    if (pathA || pathB) runDiffCompare();
}

function closeDiffDialog() {
    if (!diffState.open) return;
    diffState.open = false;
    const {mask} = diffEls();
    if (mask) mask.classList.add('hidden');
    const prev = diffState.previousFocus;
    diffState.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

async function diffReadText(path) {
    const doc = findDocByPath(path);
    if (doc) {
        if (doc.editor) return doc.editor.getText();
        if (doc.text != null) return doc.text;
    }
    const data = await backend.OpenFile(path, 'auto');
    if (!data || data.binary) throw new Error('二进制文件不支持比较');
    return String(data.content == null ? '' : data.content);
}

function renderDiffText(text) {
    const {output} = diffEls();
    if (!output) return;
    output.textContent = '';
    if (!text) {
        output.textContent = '两个文件内容相同。';
        return;
    }
    const lines = text.split('\n');
    const limit = 8000;
    const shown = lines.slice(0, limit);
    const fragment = document.createDocumentFragment();
    for (const line of shown) {
        const row = document.createElement('span');
        row.className = 'diff-line' + (line.startsWith('@@') ? ' diff-hunk' :
            line.startsWith('+') ? ' diff-add' :
                line.startsWith('-') ? ' diff-del' : ' diff-ctx');
        row.textContent = line || ' ';
        fragment.appendChild(row);
    }
    if (lines.length > limit) {
        const more = document.createElement('span');
        more.className = 'diff-line diff-hunk';
        more.textContent = '… 仅显示前 ' + limit + ' 行';
        fragment.appendChild(more);
    }
    output.appendChild(fragment);
}

function parseForDiff(path, text) {
    const driver = detectFormat(path, text);
    if (!driver || typeof driver.parse !== 'function') return null;
    try {
        return {driver, value: driver.parse(text)};
    } catch (e) {
        return null;
    }
}

async function runDiffCompare() {
    const elsD = diffEls();
    if (!elsD.a || !elsD.b || diffState.running) return;
    const pathA = elsD.a.value;
    const pathB = elsD.b.value;
    if (!pathA || !pathB) {
        elsD.summary.textContent = '请选择两个文件';
        return;
    }
    if (samePathValue(pathA, pathB)) {
        elsD.summary.textContent = '两个文件相同，请选择不同的文件';
        return;
    }
    diffState.running = true;
    if (elsD.run) elsD.run.disabled = true;
    elsD.summary.textContent = '正在读取并比较…';
    try {
        const [textA, textB] = await Promise.all([diffReadText(pathA), diffReadText(pathB)]);
        const result = unifiedDiff(textA, textB);
        renderDiffText(result.text);
        let summary = (result.added || result.removed)
            ? '文本差异：+' + result.added + ' 行 / -' + result.removed + ' 行'
            : '文本内容相同';
        elsD.semanticList.textContent = '';
        elsD.semanticList.classList.add('hidden');
        if (elsD.semantic && elsD.semantic.checked) {
            const a = parseForDiff(pathA, textA);
            const b = parseForDiff(pathB, textB);
            if (a && b) {
                const entries = semanticDiff(a.value, b.value);
                summary += ' · 语义差异 ' + entries.length + ' 处';
                if (entries.length) {
                    const fragment = document.createDocumentFragment();
                    for (const entry of entries) {
                        const row = document.createElement('div');
                        row.className = 'diff-sem-row diff-sem-' + entry.kind;
                        const kind = document.createElement('span');
                        kind.className = 'diff-sem-kind';
                        kind.textContent = entry.kind === 'add' ? '新增' : (entry.kind === 'remove' ? '删除' : '修改');
                        const path = document.createElement('span');
                        path.className = 'diff-sem-path';
                        path.textContent = entry.path;
                        const value = document.createElement('span');
                        value.className = 'diff-sem-value';
                        value.textContent = semanticEntryText(entry);
                        row.append(kind, path, value);
                        row.addEventListener('click', () => copyText(entry.path, '路径'));
                        fragment.appendChild(row);
                    }
                    elsD.semanticList.appendChild(fragment);
                    elsD.semanticList.classList.remove('hidden');
                }
            } else {
                summary += ' · 当前格式无可用的数据感知比较';
            }
        }
        elsD.summary.textContent = summary;
    } catch (e) {
        elsD.summary.textContent = '比较失败：' + ((e && e.message) || e);
        renderDiffText('');
    } finally {
        diffState.running = false;
        if (elsD.run) elsD.run.disabled = false;
    }
}

function bindDiffDialog() {
    const elsD = diffEls();
    if (!elsD.mask) return;
    if (elsD.run) elsD.run.addEventListener('click', runDiffCompare);
    if (elsD.close) elsD.close.addEventListener('click', closeDiffDialog);
    if (elsD.semantic) elsD.semantic.addEventListener('change', runDiffCompare);
    elsD.mask.addEventListener('mousedown', (e) => {
        if (e.target === elsD.mask) closeDiffDialog();
    });
    document.addEventListener('keydown', (e) => {
        if (!diffState.open || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeDiffDialog();
    }, true);
}
bindDiffDialog();

// ---- JSON Schema 校验 ----
const schemaState = {open: false, doc: null, lineMap: new Map(), errors: [], previousFocus: null};

function schemaEls() {
    return {
        mask: document.getElementById('js-mask'),
        summary: document.getElementById('js-summary'),
        list: document.getElementById('js-list'),
        schema: document.getElementById('js-schema'),
        close: document.getElementById('js-close'),
        reselect: document.getElementById('js-reselect'),
    };
}

function closeSchemaPanel() {
    if (!schemaState.open) return;
    schemaState.open = false;
    const {mask} = schemaEls();
    if (mask) mask.classList.add('hidden');
    const prev = schemaState.previousFocus;
    schemaState.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

function renderSchemaErrors(errors) {
    const {list} = schemaEls();
    if (!list) return;
    list.textContent = '';
    if (!errors.length) {
        const ok = document.createElement('div');
        ok.className = 'js-ok';
        ok.textContent = '校验通过，没有发现不符合 Schema 的数据。';
        list.appendChild(ok);
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const error of errors) {
        const row = document.createElement('div');
        row.className = 'js-row';
        const path = document.createElement('span');
        path.className = 'js-path';
        path.textContent = error.path;
        const keyword = document.createElement('span');
        keyword.className = 'js-keyword';
        keyword.textContent = error.keyword || '';
        const message = document.createElement('span');
        message.className = 'js-message';
        message.textContent = error.message;
        row.append(path, keyword, message);
        row.addEventListener('click', async () => {
            const loc = schemaState.lineMap.get(error.path);
            if (loc && schemaState.doc && docs.includes(schemaState.doc)) {
                closeSchemaPanel();
                await selectLineInDoc(schemaState.doc, loc.line, loc.column);
            } else {
                await copyText(error.path, '路径');
            }
        });
        fragment.appendChild(row);
    }
    list.appendChild(fragment);
}

async function openSchemaValidation() {
    const doc = file;
    if (!doc || doc.binary || doc.large || !doc.format || (doc.format.id !== 'json' && doc.format.id !== 'jsonl')) {
        flash('JSON Schema 校验仅支持 JSON/JSONL 文件', true);
        return;
    }
    if (!backend.OpenFilesDialog) {
        flash('当前环境不支持选择 Schema 文件', true);
        return;
    }
    let paths = [];
    try {
        paths = await backend.OpenFilesDialog();
    } catch (e) {
        flash('选择 Schema 文件失败：' + e, true);
        return;
    }
    const schemaPath = (paths || [])[0];
    if (!schemaPath) return;
    let schema;
    try {
        const data = await backend.OpenFile(schemaPath, 'auto');
        if (!data || data.binary) throw new Error('Schema 是二进制文件');
        schema = JSON.parse(String(data.content == null ? '' : data.content));
    } catch (e) {
        flash('读取 Schema 失败：' + ((e && e.message) || e), true);
        return;
    }
    const text = structureTextForDoc(doc);
    let value;
    try {
        value = doc.format.parse(text);
    } catch (e) {
        flash('当前文件解析失败：' + ((e && e.message) || e), true);
        return;
    }
    const errors = validateJsonSchema(value, schema);
    if (!schemaState.open) schemaState.previousFocus = document.activeElement;
    schemaState.open = true;
    schemaState.doc = doc;
    schemaState.errors = errors;
    schemaState.lineMap = doc.format.id === 'json' ? buildJsonLineMap(text) : new Map();
    const elsS = schemaEls();
    elsS.mask.classList.remove('hidden');
    elsS.summary.textContent = errors.length
        ? (doc.name + ' · ' + errors.length + ' 个错误')
        : (doc.name + ' · 校验通过');
    elsS.schema.textContent = 'Schema：' + (baseNameOf(schemaPath) || schemaPath);
    renderSchemaErrors(errors);
    if (elsS.list) elsS.list.scrollTop = 0;
}

function bindSchemaPanel() {
    const elsS = schemaEls();
    if (!elsS.mask) return;
    if (elsS.close) elsS.close.addEventListener('click', closeSchemaPanel);
    if (elsS.reselect) elsS.reselect.addEventListener('click', () => openSchemaValidation());
    elsS.mask.addEventListener('mousedown', (e) => {
        if (e.target === elsS.mask) closeSchemaPanel();
    });
    document.addEventListener('keydown', (e) => {
        if (!schemaState.open || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeSchemaPanel();
    }, true);
}
bindSchemaPanel();

const quickSwitch = {
    open: false,
    level: 'main',
    rows: [],
    index: 0,
    mainIndex: 0,
    previousFocus: null,
};

function quickSwitchTitleFor(level) {
    return ({
        main: '切换',
        theme: '主题',
        view: '视图模式',
        font: '编辑器字体',
        size: '字号',
        indent: '缩进',
        layout: '布局',
        openmode: '打开方式',
    })[level] || '切换';
}

function currentIndentLabel() {
    if (!file || !file.format) return '';
    const value = getFormatSettings(file.format.id).indent;
    const found = INDENTS.find(([id]) => id === value);
    return found ? found[1] : value;
}

function quickSwitchMainItems() {
    const font = editorFonts.find((f) => f.id === settings.editorFontFamily);
    return [
        {label: '主题', value: currentTheme().name, enter: 'theme'},
        {label: '视图模式', value: file ? viewLabel(currentMode) : '未打开文件', enter: 'view', disabled: !file},
        {label: '编辑器字体', value: font ? font.name : settings.editorFontFamily, enter: 'font'},
        {label: '字号', value: settings.editorFont + ' px', enter: 'size'},
        {label: '缩进', value: currentIndentLabel(), enter: 'indent', disabled: !file || !file.format},
        {label: '布局', enter: 'layout'},
        {label: '打开方式', value: settings.openMode === 'window' ? '多窗口' : '单窗口标签页', enter: 'openmode'},
    ];
}

function quickSwitchSubItems(level) {
    if (level === 'theme') {
        const items = [];
        let prevGroup = '';
        for (const theme of themes) {
            if (prevGroup && theme.group !== prevGroup) items.push({sep: true});
            items.push({label: theme.name, checked: settings.theme === theme.id, action: () => setTheme(theme.id)});
            prevGroup = theme.group;
        }
        return items;
    }
    if (level === 'view') {
        if (!file) return [{label: '（未打开文件）', disabled: true}];
        const splitActive = !!file.splitActive;
        return viewOptionsFor(file.format, file).map(([mode, label]) => ({
            label,
            checked: mode === 'split' ? splitActive
                : (mode === 'sql' ? !!file.sqlActive : (!splitActive && currentMode === mode)),
            disabled: viewDisabled(mode),
            action: () => switchMode(mode),
        }));
    }
    if (level === 'font') {
        return editorFonts.map((font) => ({
            label: font.name,
            checked: settings.editorFontFamily === font.id,
            action: () => {
                settings.editorFontFamily = font.id;
                applySettings();
            },
        }));
    }
    if (level === 'size') {
        return [11, 12, 13, 14, 15, 16, 18, 20].map((size) => ({
            label: size + ' px',
            checked: Number(settings.editorFont) === size,
            action: () => {
                settings.editorFont = size;
                applySettings();
            },
        }));
    }
    if (level === 'indent') {
        const formatId = file && file.format ? file.format.id : '';
        if (!formatId) return [{label: '（未打开文件）', disabled: true}];
        const current = getFormatSettings(formatId).indent;
        return INDENTS.map(([id, label]) => ({
            label,
            checked: current === id,
            action: () => {
                settings.formatSettings[formatId] = {...getFormatSettings(formatId), indent: id};
                applySettings();
                if (currentMode === 'code' && file && file.format && file.format.id === formatId &&
                    file.editor && file.editor.aceEditor) applyAceMode(true);
            },
        }));
    }
    if (level === 'layout') {
        return [
            {label: '文件侧边栏', checked: !!settings.showSidebar, action: () => toggleSidebar()},
            {label: '文件列表', checked: !!settings.showSidebar && settings.sidebarMode === 'list', action: () => setSidebarMode('list')},
            {label: '文件树', checked: !!settings.showSidebar && settings.sidebarMode === 'tree', action: () => setSidebarMode('tree')},
            {label: '结构视图', checked: !!settings.showSidebar && currentSidebarView() === 'structure', action: () => toggleSidebarView('structure')},
            {label: 'Git 面板', checked: !!settings.showSidebar && currentSidebarView() === 'git', action: () => toggleSidebarView('git')},
            {label: '终端面板', checked: !!terminalUI.open, action: () => toggleTerminalPanel()},
            {label: '自动换行', checked: !!settings.codeWrap, action: () => toggleCodeWrap()},
            {label: '窗口置顶', checked: !!settings.alwaysOnTop, action: () => toggleAlwaysOnTop()},
        ];
    }
    if (level === 'openmode') {
        return [
            {
                label: '单窗口标签页',
                checked: settings.openMode === 'tab',
                action: () => { settings.openMode = 'tab'; applySettings(); },
            },
            {
                label: '多窗口',
                checked: settings.openMode === 'window',
                action: () => { settings.openMode = 'window'; applySettings(); },
            },
        ];
    }
    return [];
}

function updateQuickSwitchSelection() {
    let selected = null;
    for (let i = 0; i < quickSwitch.rows.length; i++) {
        const row = quickSwitch.rows[i].el;
        const on = i === quickSwitch.index;
        row.classList.toggle('selected', on);
        if (on) selected = row;
    }
    if (selected && selected.scrollIntoView) {
        try { selected.scrollIntoView({block: 'nearest'}); } catch (e) {}
    }
}

function renderQuickSwitch() {
    els.quickSwitchTitle.textContent = quickSwitchTitleFor(quickSwitch.level);
    els.quickSwitchBack.classList.toggle('hidden', quickSwitch.level === 'main');
    els.quickSwitchList.textContent = '';
    quickSwitch.rows = [];
    const items = quickSwitch.level === 'main' ? quickSwitchMainItems() : quickSwitchSubItems(quickSwitch.level);
    let number = 0;
    for (const item of items) {
        if (item.sep) {
            const sep = document.createElement('div');
            sep.className = 'quick-switch-sep';
            els.quickSwitchList.appendChild(sep);
            continue;
        }
        const idx = number++;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'quick-switch-item' + (item.disabled ? ' disabled' : '') + (idx === quickSwitch.index ? ' selected' : '');
        const indexEl = document.createElement('span');
        indexEl.className = 'quick-switch-index';
        indexEl.textContent = idx < 9 ? String(idx + 1) : (idx === 9 ? '0' : '');
        const labelEl = document.createElement('span');
        labelEl.className = 'quick-switch-label';
        labelEl.textContent = item.label;
        el.append(indexEl, labelEl);
        if (item.value) {
            const valueEl = document.createElement('span');
            valueEl.className = 'quick-switch-value';
            valueEl.textContent = item.value;
            el.appendChild(valueEl);
        }
        if (item.checked) {
            const checkEl = document.createElement('span');
            checkEl.className = 'quick-switch-check';
            checkEl.innerHTML = iconSvg('check', 12);
            el.appendChild(checkEl);
        }
        el.addEventListener('mouseenter', () => {
            if (item.disabled || quickSwitch.index === idx) return;
            quickSwitch.index = idx;
            updateQuickSwitchSelection();
        });
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            activateQuickSwitch(idx);
        });
        els.quickSwitchList.appendChild(el);
        quickSwitch.rows.push({item, el});
    }
    if (quickSwitch.index >= quickSwitch.rows.length) quickSwitch.index = Math.max(0, quickSwitch.rows.length - 1);
    updateQuickSwitchSelection();
}

function moveQuickSwitch(delta) {
    const total = quickSwitch.rows.length;
    if (!total) return;
    let next = quickSwitch.index;
    for (let step = 0; step < total; step++) {
        next = (next + delta + total) % total;
        if (!quickSwitch.rows[next].item.disabled) break;
    }
    quickSwitch.index = next;
    updateQuickSwitchSelection();
}

function activateQuickSwitch(index) {
    const row = quickSwitch.rows[index];
    if (!row || row.item.disabled) return;
    if (row.item.enter) {
        enterQuickSwitchLevel(row.item.enter);
        return;
    }
    if (row.item.action) {
        closeQuickSwitch();
        row.item.action();
    }
}

function enterQuickSwitchLevel(level) {
    if (level === 'main') {
        quickSwitch.level = 'main';
        quickSwitch.index = quickSwitch.mainIndex;
    } else {
        if ((level === 'view' && !file) || (level === 'indent' && (!file || !file.format))) return;
        quickSwitch.mainIndex = quickSwitch.index;
        quickSwitch.level = level;
        const items = quickSwitchSubItems(level);
        let checked = 0;
        let number = 0;
        for (const item of items) {
            if (item.sep) continue;
            if (item.checked && !item.disabled) {
                checked = number;
                break;
            }
            number++;
        }
        quickSwitch.index = checked;
    }
    renderQuickSwitch();
    els.quickSwitch.focus();
}

function openQuickSwitch() {
    if (quickSwitch.open || isDialogOpen()) return;
    closeAllMenus();
    quickSwitch.open = true;
    quickSwitch.level = 'main';
    quickSwitch.index = 0;
    quickSwitch.mainIndex = 0;
    const active = document.activeElement;
    quickSwitch.previousFocus = active &&
        !(active.closest && (active.closest('#tb-menu') || active.closest('#menubar') || active.closest('.ctx-menu'))) ? active : null;
    els.quickSwitchMask.classList.remove('hidden');
    renderQuickSwitch();
    els.quickSwitch.focus();
}

function closeQuickSwitch() {
    if (!quickSwitch.open) return;
    quickSwitch.open = false;
    els.quickSwitchMask.classList.add('hidden');
    const previous = quickSwitch.previousFocus;
    quickSwitch.previousFocus = null;
    if (previous && previous.isConnected && typeof previous.focus === 'function' &&
        previous !== document.body && previous !== document.documentElement) {
        try {
            previous.focus();
            return;
        } catch (e) {}
    }
    focusFindEditor();
}

function toggleQuickSwitch() {
    if (quickSwitch.open) closeQuickSwitch();
    else openQuickSwitch();
}

function handleQuickSwitchKey(e) {
    if (!quickSwitch.open) return false;
    if (e.key === 'Escape') {
        if (quickSwitch.level === 'main') closeQuickSwitch();
        else enterQuickSwitchLevel('main');
        return true;
    }
    if (e.key === 'ArrowDown') {
        moveQuickSwitch(1);
        return true;
    }
    if (e.key === 'ArrowUp') {
        moveQuickSwitch(-1);
        return true;
    }
    if (e.key === 'Enter') {
        activateQuickSwitch(quickSwitch.index);
        return true;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && quickSwitch.level !== 'main') {
        enterQuickSwitchLevel('main');
        return true;
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[0-9]$/.test(e.key)) {
        const index = e.key === '0' ? 9 : Number(e.key) - 1;
        if (index < quickSwitch.rows.length) {
            activateQuickSwitch(index);
            return true;
        }
    }
    return false;
}

els.quickSwitchMask.addEventListener('click', (e) => {
    if (e.target === els.quickSwitchMask) closeQuickSwitch();
});
els.quickSwitch.addEventListener('click', (e) => e.stopPropagation());
els.quickSwitchBack.addEventListener('click', (e) => {
    e.stopPropagation();
    enterQuickSwitchLevel('main');
});

function exitApp() {
    if (rt && rt.Quit) rt.Quit();
    else if (rt && rt.WindowClose) rt.WindowClose();
    else window.close();
}

function parentDirOf(path) {
    const s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i) : '';
}

const recentOpenKey = 'datalens-recent';
const recentOpenLimit = 12;

function readRecentOpen() {
    try {
        const raw = JSON.parse(localStorage.getItem(recentOpenKey) || '[]');
        return Array.isArray(raw) ? raw.filter((it) => it && it.path) : [];
    } catch (e) {
        return [];
    }
}

function rememberRecentOpen(path, name, isDir) {
    if (!path) return;
    const key = String(path).replace(/\\/g, '/').toLowerCase();
    const list = readRecentOpen().filter((it) => String(it.path || '').replace(/\\/g, '/').toLowerCase() !== key);
    list.unshift({path, name: name || baseNameOf(path), isDir: !!isDir});
    try {
        localStorage.setItem(recentOpenKey, JSON.stringify(list.slice(0, recentOpenLimit)));
    } catch (e) {}
}

function clearRecentOpen() {
    try {
        localStorage.removeItem(recentOpenKey);
    } catch (e) {}
    flash('已清除最近打开记录');
}

function recentOpenMenuItems() {
    const list = readRecentOpen();
    if (!list.length) return [{label: '（无最近记录）', disabled: true}];
    const items = list.map((entry) => {
        const spec = entry.isDir ? null : fileIconSpec(entry.name || entry.path);
        return {
            label: entry.name || baseNameOf(entry.path),
            icon: entry.isDir ? 'E8B7' : undefined,
            iconHtml: spec ? spec.svg : undefined,
            iconClass: spec ? spec.className : undefined,
            action: () => (entry.isDir ? openFolderSmart(entry.path) : openPath(entry.path)),
        };
    });
    items.push({sep: true}, {label: '清除最近记录', action: clearRecentOpen});
    return items;
}

// ---- 外部文件拖到文件树目录行：复制进该目录 ----
// Wails 的 file-drop 事件比 drop 事件晚（要等 Go 原生解析路径），用 pending 标记衔接。
let pendingExternalDrop = null;

function setPendingExternalDrop(destDir) {
    pendingExternalDrop = {destDir, at: Date.now()};
}

async function copyExternalIntoDir(paths, destDir) {
    if (!backend.CopyEntry) {
        flash('当前版本不支持复制到目录', true);
        return;
    }
    let ok = 0;
    let failed = 0;
    for (const p of paths || []) {
        const name = baseNameOf(p);
        if (!name) { failed++; continue; }
        let newName = name;
        try {
            newName = (await backend.SuggestCopyName(destDir, name, false)) || name;
        } catch (e) {}
        try {
            await backend.CopyEntry(p, destDir, newName);
            ok++;
        } catch (e) {
            failed++;
        }
    }
    if (explorer && explorer.refresh) explorer.refresh();
    if (ok) flash('已复制 ' + ok + ' 项到 ' + (baseNameOf(destDir) || destDir));
    if (failed) flash(failed + ' 项复制失败', true);
}

// ---- 会话恢复：标签页/分组/分屏布局持久化，重启后还原 ----
const sessionKey = 'cadt.session.v1';
// 按工作区保存环境：软切换（新窗口打开另一工作区）时恢复该工作区上次的标签/布局。
const workspaceSessionsKey = 'cadt.workspace-sessions.v1';
const WORKSPACE_SESSION_LIMIT = 30;
let sessionTimer = 0;
// 每个文件的光标/滚动/折叠/书签：随会话保存，未激活的文档沿用上次读到的视图
let knownDocViews = new Map();
let pendingDocViews = new Map();

function sessionPathKey(path) {
    return String(path || '').replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase();
}

function readWorkspaceSessions() {
    try {
        const data = JSON.parse(localStorage.getItem(workspaceSessionsKey) || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
        return {};
    }
}

function readWorkspaceSession(dir) {
    const key = sessionPathKey(dir);
    if (!key) return null;
    const map = readWorkspaceSessions();
    const sess = map[key];
    return sess && typeof sess === 'object' ? sess : null;
}

function writeWorkspaceSession(sess) {
    const key = sessionPathKey(sess && sess.workspace);
    if (!key) return;
    // 只保存属于该工作区的文件环境，避免工作区切换后把另一工作区的标签带进本工作区。
    const inside = (path) => {
        const fileKey = sessionPathKey(path);
        return !!fileKey && (fileKey === key || fileKey.startsWith(key + '/'));
    };
    const groups = [];
    let filtered = false;
    for (const group of (sess.groups || [])) {
        const source = group && Array.isArray(group.paths) ? group.paths : [];
        const paths = source.filter(inside);
        if (!paths.length) {
            filtered = true;
            continue;
        }
        if (paths.length !== source.length) filtered = true;
        groups.push({
            paths,
            active: paths.includes(group.active) ? group.active : paths[0],
        });
    }
    const modes = {};
    for (const [path, mode] of Object.entries(sess.modes || {})) {
        if (inside(path)) modes[path] = mode;
    }
    const views = {};
    for (const [path, view] of Object.entries(sess.views || {})) {
        if (inside(path)) views[path] = view;
    }
    const map = readWorkspaceSessions();
    map[key] = {
        workspace: sess.workspace,
        groups,
        current: sess.current && inside(sess.current) ? sess.current : '',
        split: filtered ? null : (sess.split || null),
        modes,
        views,
        savedAt: Date.now(),
    };
    const keys = Object.keys(map);
    if (keys.length > WORKSPACE_SESSION_LIMIT) {
        keys.sort((a, b) => (Number(map[a] && map[a].savedAt) || 0) - (Number(map[b] && map[b].savedAt) || 0));
        for (const k of keys.slice(0, keys.length - WORKSPACE_SESSION_LIMIT)) delete map[k];
    }
    localStorage.setItem(workspaceSessionsKey, JSON.stringify(map));
}

function serializeSplitSession(node, gidToIdx) {
    if (typeof node === 'string') {
        return gidToIdx.has(node) ? gidToIdx.get(node) : null;
    }
    const a = serializeSplitSession(node.a, gidToIdx);
    const b = serializeSplitSession(node.b, gidToIdx);
    if (a == null) return b;
    if (b == null) return a;
    return {dir: node.dir, ratio: node.ratio, a, b};
}

function serializeSession() {
    // 工作区可以单独持久化：只打开文件夹、没有打开文件时也应在重启后恢复。
    if (!docs.length && !workspaceFolder) return null;
    const groups = [];
    const gidToIdx = new Map();
    for (const g of editorGroups) {
        const entries = groupDocs(g).filter((d) => d.path);
        if (!entries.length) continue;
        gidToIdx.set(g.id, groups.length);
        groups.push({
            paths: entries.map((d) => d.path),
            active: (docs.find((d) => d.id === g.activeId && d.path) || entries[0]).path,
        });
    }
    if (!groups.length && !workspaceFolder) return null;
    const modes = {};
    for (const d of docs) {
        if (d.path && d.mode) modes[d.path] = d.mode === 'sql' ? (d.sqlPrevMode || 'text') : d.mode;
    }
    const views = {};
    const liveKeys = new Set();
    for (const d of docs) {
        if (!d.path) continue;
        rememberDocView(d);
        const key = sessionPathKey(d.path);
        liveKeys.add(key);
        const view = knownDocViews.get(key);
        if (view) views[key] = view;
    }
    for (const key of [...knownDocViews.keys()]) {
        if (!liveKeys.has(key)) knownDocViews.delete(key);
    }
    return {
        workspace: workspaceFolder || '',
        groups,
        current: file && file.path ? file.path : '',
        split: splitRoot ? serializeSplitSession(splitRoot, gidToIdx) : null,
        modes,
        views,
    };
}

function auxWindowNoSession() {
    return !!(window.__aiFloatWindow || window.__consoleWindowMode);
}

function scheduleSessionSave(options) {
    if (auxWindowNoSession()) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => saveSessionNow(options), 500);
}

function saveSessionNow(options) {
    if (auxWindowNoSession()) return false;
    sessionTimer = 0;
    try {
        const sess = serializeSession();
        if (sess) {
            const tabs = countSessionTabs(sess);
            if (!tabs && !(options && options.allowEmpty)) {
                const prev = readSession();
                if (countSessionTabs(prev) > 0 &&
                    sessionPathKey(prev && prev.workspace) === sessionPathKey(sess.workspace)) {
                    // 启动恢复、工作区预热等过程性保存不能把上一次的标签页抹成空快照
                    logFrontend('info', '会话保存跳过：空快照未覆盖 ' + countSessionTabs(prev) + ' 个标签页');
                    return false;
                }
            }
            localStorage.setItem(sessionKey, JSON.stringify(sess));
            writeWorkspaceSession(sess);
        } else {
            localStorage.removeItem(sessionKey);
        }
        return true;
    } catch (e) { return false; }
}

function countSessionTabs(sess) {
    let n = 0;
    for (const group of (sess && Array.isArray(sess.groups) ? sess.groups : [])) {
        n += group && Array.isArray(group.paths) ? group.paths.length : 0;
    }
    return n;
}

// 关闭窗口时兜底保存一次，避免刚打开文件夹就退出时丢失（防抖还没触发）。
// AI 悬浮窗与调试控制台共享同一 localStorage，不能让它们覆盖主窗口的会话。
window.addEventListener('pagehide', () => {
    if (auxWindowNoSession()) return;
    // 操作留痕：退出前记一条并冲刷攒批（尽力而为，异步写入不保证完成）。
    activityLog.log('app.exit', '', {}, {actor: 'system', source: 'system'});
    activityLog.flush();
    if (!docs.length && !workspaceFolder) return;
    saveSessionNow();
});

function readSession() {
    try {
        const sess = JSON.parse(localStorage.getItem(sessionKey) || 'null');
        if (sess && (sess.workspace || (Array.isArray(sess.groups) && sess.groups.length))) return sess;
    } catch (e) {}
    return null;
}

function deserializeSplitSession(node, idxToGid) {
    if (typeof node === 'number') {
        return idxToGid.has(node) ? idxToGid.get(node) : null;
    }
    if (!node || typeof node !== 'object') return null;
    const a = deserializeSplitSession(node.a, idxToGid);
    const b = deserializeSplitSession(node.b, idxToGid);
    if (a == null || b == null) return null;
    return {dir: node.dir === 'h' ? 'h' : 'v', ratio: Math.min(0.8, Math.max(0.2, Number(node.ratio) || 0.5)), a, b};
}

async function restoreSession(sess) {
    if (auxWindowNoSession()) return false;
    try {
        if (sess.workspace && !workspaceFolder) openFolderWorkspace(sess.workspace);
        knownDocViews = new Map();
        pendingDocViews = new Map();
        for (const [path, view] of Object.entries(sess.views || {})) {
            if (!path || !view || typeof view !== 'object') continue;
            const key = sessionPathKey(path);
            knownDocViews.set(key, view);
            pendingDocViews.set(key, view);
        }
        const idxToGid = new Map();
        for (const gspec of (sess.groups || [])) {
            const g = createGroup();
            focusedGroupId = g.id;
            idxToGid.set(idxToGid.size, g.id);
            await openPathsHere(gspec.paths || []);
            const activeDoc = findDocByPath(gspec.active);
            if (activeDoc && groupOfDoc(activeDoc.id) === g && g.activeId !== activeDoc.id) {
                await activateDoc(activeDoc);
            }
        }
        if (sess.split && typeof sess.split === 'object') {
            splitRoot = deserializeSplitSession(sess.split, idxToGid);
        }
        const current = sess.current ? findDocByPath(sess.current) : null;
        if (current) {
            await activateDoc(current);
            const mode = sess.modes && sess.modes[current.path];
            if (mode && mode !== currentMode) switchMode(mode);
        } else if (editorGroups.length) {
            const first = groupDocs(editorGroups[0])[0];
            if (first) await activateDoc(first);
        }
        renderEditorLayout();
        const want = countSessionTabs(sess);
        logFrontend('info', '会话恢复：保存 ' + want + ' 个标签页，实际打开 ' + docs.length + ' 个文件');
        flash('已恢复上次会话');
    } catch (e) {
        logFrontend('warn', '会话恢复失败：' + (e && e.message || e));
    }
}

function newDocumentMenuItems() {
    return [
        {
            label: '文件…',
            icon: 'E7C3',
            disabled: !workspaceFolder,
            action: () => openCreateEntryDialog(workspaceFolder, false, '', '新建文件'),
        },
        {
            label: '目录…',
            icon: 'E8B7',
            disabled: !workspaceFolder,
            action: () => openCreateEntryDialog(workspaceFolder, true, '新建文件夹', '新建文件夹'),
        },
        {sep: true},
        ...newFileTypeMenuItems((type) => {
            const dot = type.name.lastIndexOf('.');
            const ext = dot >= 0 ? type.name.slice(dot) : '';
            newDocumentWith('未命名' + ext, ext.toLowerCase() === '.json' ? '{}' : '');
        }),
    ];
}

function propsTimeText(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
        return new Date(n).toLocaleString('zh-CN', {hour12: false});
    } catch (e) {
        return '';
    }
}

async function showFileProperties(targetPath) {
    if (targetPath) {
        await showPathProperties(targetPath);
        return;
    }
    const doc = file;
    if (!doc || !doc.path) return;
    let info = null;
    if (backend.GetPathInfo) {
        try {
            info = await backend.GetPathInfo(doc.path);
        } catch (e) {}
    }
    const rows = [];
    rows.push(['名称', doc.name || baseNameOf(doc.path), false]);
    rows.push(['路径', doc.path, true]);
    const kind = doc.binary ? (doc.image ? '图片（二进制）' : '二进制') : (doc.format ? doc.format.name : '文本');
    rows.push(['类型', kind, false]);
    const size = info && Number.isFinite(info.size) ? info.size : doc.size;
    if (Number.isFinite(size)) {
        rows.push(['大小', fmtSize(size) + '（' + Number(size).toLocaleString('zh-CN') + ' 字节）', false]);
    }
    const modified = info ? propsTimeText(info.modified) : '';
    if (modified) rows.push(['修改时间', modified, false]);
    if (info) rows.push(['只读', info.readOnly ? '是' : '否', false]);
    if (!doc.binary) {
        rows.push(['编码', String(doc.enc || 'utf-8').toUpperCase(), false]);
        rows.push(['换行符', doc.eol === 'crlf' ? 'CRLF' : 'LF', false]);
        rows.push(['BOM', doc.hasBom ? '有' : '无', false]);
        if (!doc.large) {
            const text = structureTextForDoc(doc) || '';
            rows.push(['行数', text ? String(text.split('\n').length) : '0', false]);
        }
    }
    elsDialogs.propsGrid.textContent = '';
    for (const [key, value, mono] of rows) {
        const k = document.createElement('div');
        k.className = 'props-key';
        k.textContent = key;
        const v = document.createElement('div');
        v.className = 'props-val' + (mono ? ' mono' : '');
        v.textContent = value;
        elsDialogs.propsGrid.append(k, v);
    }
    setPropsDialogTitle('文件属性');
    openDialogEl(elsDialogs.props);
}

// showPathProperties 文件树右键的属性：目标可以是未打开的文件或文件夹，仅展示路径元信息。
async function showPathProperties(path) {
    if (!path) return;
    let info = null;
    if (backend.GetPathInfo) {
        try {
            info = await backend.GetPathInfo(path);
        } catch (e) {}
    }
    const name = (info && info.name) || baseNameOf(path);
    const rows = [];
    rows.push(['名称', name, false]);
    rows.push(['路径', path, true]);
    const isDirEntry = !!(info && info.isDir);
    if (isDirEntry) {
        rows.push(['类型', '文件夹', false]);
    } else {
        let kind = '文件';
        try {
            const fmt = detectFormat(name);
            if (fmt && fmt.name) kind = '文件（' + fmt.name + '）';
        } catch (e) {}
        rows.push(['类型', kind, false]);
        if (info && Number.isFinite(info.size)) {
            rows.push(['大小', fmtSize(info.size) + '（' + Number(info.size).toLocaleString('zh-CN') + ' 字节）', false]);
        }
    }
    const modified = info ? propsTimeText(info.modified) : '';
    if (modified) rows.push(['修改时间', modified, false]);
    if (info) rows.push(['只读', info.readOnly ? '是' : '否', false]);
    elsDialogs.propsGrid.textContent = '';
    for (const [key, value, mono] of rows) {
        const k = document.createElement('div');
        k.className = 'props-key';
        k.textContent = key;
        const v = document.createElement('div');
        v.className = 'props-val' + (mono ? ' mono' : '');
        v.textContent = value;
        elsDialogs.propsGrid.append(k, v);
    }
    setPropsDialogTitle(isDirEntry ? '文件夹属性' : '文件属性');
    openDialogEl(elsDialogs.props);
}

function setPropsDialogTitle(text) {
    const title = elsDialogs.props && elsDialogs.props.querySelector('.dialog-title');
    if (title) title.textContent = text;
}

async function reloadAllFromDisk() {
    const targets = docs.filter((d) => d.path).slice();
    if (!targets.length) return;
    const run = async () => {
        const original = file;
        let ok = 0;
        let failed = 0;
        for (const doc of targets) {
            if (!docs.includes(doc)) continue;
            await activateDoc(doc);
            if (await reloadActive({quiet: true})) ok++;
            else failed++;
        }
        if (original && docs.includes(original) && file !== original) await activateDoc(original);
        flash('已从磁盘重新加载 ' + ok + ' 个文件' + (failed ? '，' + failed + ' 个失败' : ''), failed > 0);
    };
    if (targets.some((d) => d.dirty)) {
        openCloseConfirm('全部重新加载将丢弃所有未保存的修改。', run, '全部重新加载');
    } else {
        await run();
    }
}

const appFeedbackUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/issues';
const appReleasesUrl = 'https://gitee.com/candysweet-cdt/CaDt-DataLens/releases';

function openExternalUrl(url) {
    if (!url) return;
    if (rt && rt.BrowserOpenURL) rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

function openBundledDoc(key, name, text) {
    const existing = docs.find((d) => d.bundledDoc === key);
    if (existing) {
        activateDoc(existing);
        return existing;
    }
    const doc = openVirtualDoc(name, text);
    doc.bundledDoc = key;
    return doc;
}

function showChangelog() {
    openBundledDoc('changelog', '更新日志.md', changelogText);
}

function showTerms() {
    openBundledDoc('terms', '用户协议.md', termsText);
}

function showPrivacy() {
    openBundledDoc('privacy', '隐私协议.md', privacyText);
}

async function openDevTools() {
    if (!backend.OpenDevTools) {
        flash('当前版本不支持打开开发者工具', true);
        return;
    }
    try {
        await backend.OpenDevTools();
    } catch (e) {
        flash('打开开发者工具失败：' + e, true);
        logFrontend('error', '打开开发者工具失败：' + e);
    }
}

let updateChecking = false;

function openUpdateDialog() {
    elsDialogs.updateStatus.className = 'update-status';
    elsDialogs.updateStatus.textContent = '正在检查更新…';
    elsDialogs.updateNotes.classList.add('hidden');
    elsDialogs.updateNotes.textContent = '';
    elsDialogs.updateDownload.classList.add('hidden');
    elsDialogs.updateDownload.onclick = null;
    elsDialogs.updatePage.classList.add('hidden');
    elsDialogs.updatePage.onclick = null;
    openDialogEl(elsDialogs.update);
}

function renderUpdateResult(info) {
    const status = elsDialogs.updateStatus;
    const pageUrl = info.pageUrl || appReleasesUrl;
    status.className = 'update-status';
    if (info.status === 'no-release') {
        status.textContent = 'Gitee 仓库尚未发布正式版本。当前版本 ' + info.currentVersion + '。';
        status.classList.add('muted');
        elsDialogs.updatePage.classList.remove('hidden');
        elsDialogs.updatePage.onclick = () => openExternalUrl(pageUrl);
        return;
    }
    if (!info.hasUpdate) {
        status.textContent = '当前已是最新版本 ' + info.currentVersion + '。';
        status.classList.add('muted');
        return;
    }
    const date = info.publishedAt ? '，发布于 ' + String(info.publishedAt).slice(0, 10) : '';
    status.textContent = '发现新版本 ' + info.latestVersion + '（当前 ' + info.currentVersion + '）' + date + '。';
    if (info.notes) {
        elsDialogs.updateNotes.innerHTML = renderMarkdownHtml(info.notes);
        elsDialogs.updateNotes.classList.remove('hidden');
        elsDialogs.updateNotes.querySelectorAll('a').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                openExternalUrl(a.getAttribute('href'));
            });
        });
    }
    if (info.downloadUrl) {
        elsDialogs.updateDownload.classList.remove('hidden');
        elsDialogs.updateDownload.onclick = () => openExternalUrl(info.downloadUrl);
    }
    if (pageUrl) {
        elsDialogs.updatePage.classList.remove('hidden');
        elsDialogs.updatePage.onclick = () => openExternalUrl(pageUrl);
    }
}

// ---- 启动时自动检查更新（可在设置关闭），结果展示在右下角状态栏 ----
const SPINNER_HTML = '<svg class="spin-icon" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="20 9" stroke-linecap="round"/></svg>';
let updateStatusTimer = 0;

function setUpdateStatus(html, opts = {}) {
    if (!els.stUpdate) return;
    clearTimeout(updateStatusTimer);
    els.stUpdate.innerHTML = html;
    els.stUpdate.style.display = html ? '' : 'none';
    els.stUpdate.onclick = opts.onClick || null;
    els.stUpdate.classList.toggle('muted', !!opts.muted);
    if (opts.autoHide) {
        updateStatusTimer = setTimeout(() => {
            els.stUpdate.style.display = 'none';
        }, opts.autoHide);
    }
}

function openUpdateDialogWith(info) {
    openUpdateDialog();
    renderUpdateResult(info);
}

async function autoCheckUpdateOnStart() {
    if (!backend.CheckForUpdates || settings.autoCheckUpdate === false) return;
    if (updateChecking) return;
    updateChecking = true;
    setUpdateStatus(SPINNER_HTML + ' 检查更新…');
    try {
        const info = await backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        if (info.status === 'no-release') {
            setUpdateStatus('仓库尚未发布版本', {muted: true, autoHide: 4000});
        } else if (!info.hasUpdate) {
            setUpdateStatus('已是最新版本 ' + info.currentVersion, {muted: true, autoHide: 4000});
        } else {
            setUpdateStatus('发现新版本 ' + info.latestVersion, {onClick: () => openUpdateDialogWith(info)});
            flash('发现新版本 ' + info.latestVersion + '，点击右下角查看');
        }
    } catch (e) {
        setUpdateStatus('检查更新失败', {muted: true, autoHide: 4000});
        logFrontend('error', '自动检查更新失败：' + e);
    } finally {
        updateChecking = false;
    }
}

async function checkForUpdates() {
    if (updateChecking) return;
    updateChecking = true;
    openUpdateDialog();
    try {
        if (!backend.CheckForUpdates) throw new Error('当前版本不支持检查更新');
        const info = await backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        renderUpdateResult(info);
    } catch (e) {
        elsDialogs.updateStatus.className = 'update-status error';
        elsDialogs.updateStatus.textContent = '检查更新失败：' + e;
        elsDialogs.updatePage.classList.remove('hidden');
        elsDialogs.updatePage.onclick = () => openExternalUrl(appReleasesUrl);
        logFrontend('error', '检查更新失败：' + e);
    } finally {
        updateChecking = false;
    }
}

async function checkForUpdatesInline() {
    const btn = document.getElementById('about-check-update');
    const status = document.getElementById('about-update-status');
    if (!btn || !status) return;
    btn.disabled = true;
    status.className = 'about-update-status';
    status.textContent = '正在检查…';
    try {
        if (!backend.CheckForUpdates) throw new Error('当前版本不支持检查更新');
        const info = await backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        status.className = 'about-update-status';
        status.textContent = '';
        if (info.status === 'no-release') {
            status.textContent = '仓库尚未发布版本，当前 ' + info.currentVersion;
            status.classList.add('muted');
        } else if (!info.hasUpdate) {
            status.textContent = '已是最新版本 ' + info.currentVersion;
            status.classList.add('muted');
        } else {
            status.textContent = '发现新版本 ' + info.latestVersion;
            const link = document.createElement('a');
            link.className = 'about-update-link';
            link.textContent = info.downloadUrl ? '下载安装包' : '打开发布页';
            link.addEventListener('click', (e) => {
                e.preventDefault();
                openExternalUrl(info.downloadUrl || info.pageUrl || appReleasesUrl);
            });
            status.appendChild(link);
        }
    } catch (e) {
        status.className = 'about-update-status error';
        status.textContent = '检查失败：' + e;
        logFrontend('error', '检查更新失败：' + e);
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('btn-update-close').addEventListener('click', closeDialogs);
document.getElementById('about-check-update').addEventListener('click', checkForUpdatesInline);

// ---- 格式互转 + JSON 修复 ----

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
    if (!file || !file.editor || !file.format) return;
    const target = formats[targetId];
    if (!target || !target.stringify) return;
    const text = file.editor.getText();
    let value;
    try {
        value = file.format.parse(text);
    } catch (e) {
        flash('当前内容解析失败：' + e.message, true);
        return;
    }
    if (targetId === 'jsonl' && !Array.isArray(value)) value = [value];
    let out;
    try {
        out = target.stringify(value);
    } catch (e) {
        flash('转换失败：' + e.message, true);
        return;
    }
    const base = baseNameOf(file.path || file.name || '未命名');
    const stem = base.replace(/\.[^.]+$/, '') || '转换结果';
    let destPath = '';
    try {
        destPath = await backend.SaveFileDialog(stem + (CONVERT_EXT[targetId] || '.txt'));
    } catch (e) {
        return;
    }
    if (!destPath) return;
    try {
        await backend.SaveFile(destPath, out, '', false, 'utf-8');
    } catch (e) {
        flash('保存失败：' + e.message, true);
        return;
    }
    await openPath(destPath);
    flash('已转换为 ' + (CONVERT_TARGET_LABELS[targetId] || targetId) + '：' + baseNameOf(destPath));
}

function convertMenuItems() {
    const id = file && file.format ? file.format.id : '';
    const targets = convertTargetsFor(id);
    if (!targets.length) return [{label: '当前格式不支持转换', disabled: true}];
    return targets.map((tid) => ({
        label: (CONVERT_TARGET_LABELS[tid] || tid) + '（另存为新文件）',
        action: () => convertCurrentTo(tid),
    }));
}

function repairJsonAction() {
    if (!file || !file.editor) return;
    const text = file.editor.getText();
    let invalid = null;
    try {
        JSON.parse(text);
    } catch (e) {
        invalid = e;
    }
    if (!invalid) {
        flash('JSON 本身有效，无需修复');
        return;
    }
    const result = repairJson(text);
    if (!result.ok) {
        flash('无法自动修复（' + (invalid.message || '解析失败') + '），请手动处理', true);
        return;
    }
    file.editor.setText(result.text);
    file.text = result.text;
    flash('已修复 ' + (result.fixes.length ? '：' + result.fixes.join('、') : ''));
}

// ---- 命令面板动作注册表 ----
function flattenPaletteItems(prefix, item, out) {
    if (!item || item.sep || item.disabled) return;
    if (item.submenu && item.submenu.length) {
        for (const sub of item.submenu) flattenPaletteItems(prefix, sub, out);
        return;
    }
    if (typeof item.action !== 'function') return;
    out.push({label: prefix + '： ' + item.label, shortcut: item.shortcut || '', action: item.action});
}

function paletteActions() {
    const actions = [];
    const kinds = [['file', '文件'], ['edit', '编辑'], ['format', '格式'], ['view', '视图'], ['tools', '工具'], ['theme', '主题'], ['help', '帮助']];
    for (const [kind, prefix] of kinds) {
        let items = [];
        try { items = menuItems(kind) || []; } catch (e) { items = []; }
        for (const item of items) flattenPaletteItems(prefix, item, actions);
    }
    // 菜单外的高频动作
    actions.push({label: 'AI： 打开 / 关闭助手面板', shortcut: 'Alt+9', action: () => toggleAIPanel()});
    if (aiPanel && typeof aiPanel.paletteActions === 'function') {
        try {
            actions.push(...aiPanel.paletteActions());
        } catch (e) {}
    }
    actions.push({label: '书签： 切换当前行书签', shortcut: 'F11', action: toggleBookmark});
    if (readingMode) {
        actions.push(
            {label: '阅读： 打开书籍…', action: () => readingMode.openBookshelf()},
            {label: '阅读： 添加书签', shortcut: 'Ctrl+D', action: () => readingMode.addBookmark()},
            {label: '阅读： 阅读统计', action: () => readingMode.openStatsDialog()},
            {label: '阅读： 专注模式', action: () => readingMode.toggleFocus()},
        );
    }
    actions.push({label: '书签： 跳到下一个书签', shortcut: 'F2', action: () => jumpBookmark(1)});
    actions.push({label: '书签： 跳到上一个书签', shortcut: 'Shift+F2', action: () => jumpBookmark(-1)});
    actions.push({label: '数据： JSONPath 查询…', shortcut: 'Ctrl+Shift+J', action: openJsonQuery});
    actions.push({label: '数据： 比较两个已打开的文件…', action: () => openDiffDialog()});
    actions.push({label: '数据： JSON Schema 校验…', action: openSchemaValidation});
    for (const [value, label] of [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '自适应']]) {
        actions.push({label: '设置： Markdown 预览宽度 ' + label, action: () => {
            settings.mdPreviewWidth = value;
            applySettings();
            updateStatus();
        }});
    }
    return actions;
}

function menuItems(kind) {
    const tree = currentMode === 'tree' && !!file && !(file.format && file.format.rawOnly);
    const canSave = !!file && !file.large && !file.binary;
    const hasPath = !!(file && file.path);
    const hasDirty = docs.some((d) => d.dirty);
    switch (kind) {
        case 'file': {
            const otherDocs = docs.filter((d) => d !== file);
            const reloadable = docs.some((d) => d.path);
            const exportDir = workspaceFolder || (hasPath ? parentDirOf(file.path) : '');
            return [
                {label: '新建', shortcut: 'Ctrl+N', icon: 'E710', submenu: newDocumentMenuItems()},
                {label: '新建窗口', shortcut: 'Ctrl+Shift+N', icon: 'E8A7', action: openNewWindow},
                {sep: true},
                {label: '打开…', shortcut: 'Ctrl+O', icon: 'E8E5', action: openDialog},
                {label: '打开文件夹…', icon: 'E8B7', action: openFolderDialog},
                {label: '打开书籍…', icon: 'E8A5', action: () => readingMode && readingMode.openBookshelf()},
                {label: '最近打开', icon: 'E81C', submenu: recentOpenMenuItems()},
                {label: '关闭文件夹', icon: 'E8BB', disabled: !workspaceFolder, action: closeFolder},
                {sep: true},
                {label: '保存', shortcut: 'Ctrl+S', icon: 'E74E', disabled: !canSave, action: () => save()},
                {label: '另存为…', shortcut: 'Ctrl+Shift+S', icon: 'E74E', disabled: !canSave, action: saveAs},
                {label: '保存全部', disabled: !hasDirty, action: saveAll},
                {sep: true},
                {label: '重新加载', icon: 'E72C', disabled: !hasPath, action: requestReload},
                {label: '从磁盘全部重新加载', icon: 'E895', disabled: !reloadable, action: reloadAllFromDisk},
                {sep: true},
                {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: showInFolder},
                {
                    label: '复制路径',
                    icon: 'E8C8',
                    disabled: !hasPath,
                    submenu: [
                        {label: '复制完整路径', icon: 'E8C8', action: () => copyText(file.path, '路径')},
                        {label: '复制所在目录', icon: 'E8C8', action: () => copyText(parentDirOf(file.path), '目录路径')},
                        {label: '复制文件名', icon: 'E8C8', action: () => copyText(file.name, '文件名')},
                    ],
                },
                {sep: true},
                {label: '文件属性…', icon: 'E946', disabled: !hasPath, action: showFileProperties},
                {
                    label: '导出',
                    icon: 'E896',
                    submenu: [
                        {label: '复制结构化目录', disabled: !exportDir, action: () => copyStructuredDir(exportDir)},
                        {label: '导出结构化目录…', disabled: !exportDir, action: () => exportStructuredDir(exportDir)},
                    ],
                },
                {sep: true},
                {label: '关闭标签', shortcut: 'Ctrl+W', icon: 'E8BB', disabled: !file, action: () => requestCloseDoc(file)},
                {label: '关闭其他标签', disabled: !otherDocs.length, action: () => closeDocsWithConfirm(otherDocs)},
                {label: '关闭所有标签', disabled: !docs.length, action: () => closeDocsWithConfirm(docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
                {label: '重新打开关闭的标签页', shortcut: 'Ctrl+Shift+T', icon: 'E7A7', disabled: !closedTabs.length, action: reopenClosedTab},
                {sep: true},
                {label: '设置…', shortcut: 'Ctrl+,', icon: 'E713', action: () => openSettings('general')},
                {sep: true},
                {label: '退出', icon: 'E8BB', action: exitApp},
            ];
        }
        case 'edit':
            return [
                {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', action: doUndo},
                {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', action: doRedo},
                {sep: true},
                {label: '查找…', shortcut: 'Ctrl+F', icon: 'E721', disabled: !findTarget(), action: openFindBar},
                {label: '全局搜索…', shortcut: '连按 3 次 Shift', icon: 'E721', action: openGlobalSearch},
            ];
        case 'format':
            return [
                {label: '格式化', shortcut: 'Ctrl+Alt+L', action: formatDocument},
                {label: '压缩', action: () => clickEditorButton('.jsoneditor-compact')},
                {sep: true},
                {label: '修复 JSON', disabled: !file || !file.format || file.format.id !== 'json' || !!file.binary, action: repairJsonAction},
                {label: '转换为…', disabled: !file || !file.format || !!file.binary || !!file.large, submenu: convertMenuItems()},
                {sep: true},
                {
                    label: '小说排版',
                    disabled: !writingFormatable(),
                    submenu: [
                        {label: '整理段落', action: () => applyWritingFormat(false)},
                        {label: '段首缩进两格', disabled: !file || !file.format || file.format.id !== 'text', action: () => applyWritingFormat(true)},
                    ],
                },
                {sep: true},
                {label: '排序', disabled: !tree, action: () => clickEditorButton('.jsoneditor-sort')},
                {label: '变换…', disabled: !tree, action: () => clickEditorButton('.jsoneditor-transform')},
            ];
        case 'view': {
            const structured = !!file && !!file.treeAvailable;
            const items = [{label: '快速切换…', shortcut: 'Ctrl+`', icon: 'E8B3', action: openQuickSwitch}, {sep: true}];
            const splitActive = !!(file && file.splitActive);
            items.push(...viewOptionsFor(file && file.format, file).map(([mode, label]) => ({
                label,
                checked: mode === 'split' ? splitActive
                    : (mode === 'sql' ? !!(file && file.sqlActive) : (!splitActive && currentMode === mode)),
                disabled: viewDisabled(mode),
                action: () => switchMode(mode),
            })));
            items.push(
                {sep: true},
                {label: '终端面板', shortcut: 'Alt+F12', checked: terminalUI.open && dockView === 'terminal', action: () => toggleDockView('terminal')},
                ...(developerMode ? [{label: '调试控制台', shortcut: 'F12', checked: terminalUI.open && dockView === 'debug', action: () => toggleDockView('debug')}] : []),
                {label: '文件侧边栏', shortcut: 'Ctrl+B', checked: !!settings.showSidebar, action: () => toggleSidebar()},
                {label: '文件列表', checked: settings.sidebarMode === 'list', action: () => setSidebarMode('list')},
                {label: '文件树', checked: settings.sidebarMode === 'tree', action: () => setSidebarMode('tree')},
                {label: '结构视图', shortcut: 'Alt+7', checked: !!settings.showSidebar && currentSidebarView() === 'structure', action: () => toggleSidebarView('structure')},
                {label: 'AI 会话', shortcut: 'Alt+8', checked: !!settings.showSidebar && currentSidebarView() === 'chats', action: () => toggleSidebarView('chats')},
                {sep: true},
                {label: '自动换行', checked: !!settings.codeWrap, action: toggleCodeWrap},
                {label: '写作模式', checked: !!settings.writingMode, action: toggleWritingMode},
                {label: '阅读模式', checked: !!(readingMode && readingMode.isActive()), action: () => readingMode && readingMode.toggle()},
                {label: '展开全部', shortcut: 'Ctrl+Shift+=', disabled: !tree, action: () => file && expandAllWithGuard(file)},
                {label: '收起全部', shortcut: 'Ctrl+Shift+-', disabled: !tree, action: () => editor && editor.collapseAll()},
                {sep: true},
                {label: '全屏', checked: !!rtFullscreen, action: toggleFullscreen},
                {label: '窗口置顶', checked: !!settings.alwaysOnTop, action: toggleAlwaysOnTop},
                {sep: true},
                {
                    label: 'AI 助手面板',
                    shortcut: 'Alt+9',
                    checked: aiPanel ? aiPanel.isOpen() : !!settings.aiPanelOpen,
                    action: () => toggleAIPanel(),
                },
                {
                    label: 'AI 面板显示方式',
                    submenu: [
                        {label: '停靠（无文件时占满，打开后分屏）', checked: settings.aiFloatMode === 'dock', action: () => setAIPanelMode('dock')},
                        {label: '全屏（仅覆盖文件内容区）', checked: settings.aiFloatMode === 'fullscreen', action: () => setAIPanelMode('fullscreen')},
                        {label: '悬浮（独立窗口）', action: () => setAIPanelMode('float')},
                    ],
                },
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
            const items = [{
                label: 'JSONPath 查询…',
                shortcut: 'Ctrl+Shift+J',
                icon: 'E721',
                disabled: !jsonQuerySupported(file),
                action: openJsonQuery,
            }, {
                label: '比较两个文件…',
                icon: 'E8A5',
                disabled: docs.filter((d) => d.path && !d.binary).length < 2,
                action: () => openDiffDialog(),
            }, {
                label: 'JSON Schema 校验…',
                icon: 'E73E',
                disabled: !file || file.binary || !file.format || (file.format.id !== 'json' && file.format.id !== 'jsonl'),
                action: openSchemaValidation,
            }];
            items.push({sep: true},
                {label: '起名器…', icon: 'E716', action: openWritingNameDialog},
                {label: '插入： 场景分隔符', icon: 'E710', disabled: !file || !!file.binary || !!file.large, action: insertSceneSeparator});
            const cmds = getPluginCommands();
            if (!cmds.length) {
                items.push({sep: true}, {label: '（暂无插件命令）', disabled: true});
            } else {
                items.push({sep: true}, ...cmds.map((cmd) => ({label: cmd.label, action: () => cmd.run()})));
            }
            return items;
        }
        case 'help': {
            const items = [
                {label: '检查更新…', icon: 'E895', action: checkForUpdates},
                {label: '更新日志', icon: 'E8A5', action: showChangelog},
                {label: '反馈', icon: 'E939', action: () => openExternalUrl(appFeedbackUrl)},
                {sep: true},
                {label: '用户协议', icon: 'E8A5', action: showTerms},
                {label: '隐私协议', icon: 'E72E', action: showPrivacy},
                {sep: true},
                {label: '命令面板', shortcut: 'Ctrl+Shift+P', icon: 'E721', action: () => palette && palette.toggle()},
                {label: '快捷键', action: () => openSettings('shortcuts')},
            ];
            if (developerMode) items.push({label: '开发者工具', icon: 'E756', action: openDevTools});
            items.push({label: '关于 CaDt-DataLens', action: () => openSettings('about')});
            return items;
        }
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
        icon.className = 'mi-icon' + (it.iconClass ? ' ' + it.iconClass : '');
        renderMenuIcon(icon, it);
        const label = document.createElement('span');
        label.className = 'mi-label';
        label.textContent = it.label;
        const key = document.createElement('span');
        key.className = 'mi-key';
        key.textContent = it.shortcut || '';
        row.append(icon, label, key);
        if (it.submenu) {
            const arrow = document.createElement('span');
            arrow.className = 'ctx-arrow';
            arrow.innerHTML = iconSvg('chevron-right', 10);
            row.appendChild(arrow);
            row.addEventListener('mouseenter', () => {
                if (!it.disabled) openDropdownSubmenu(row, it.submenu);
            });
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!it.disabled) openDropdownSubmenu(row, it.submenu);
            });
        } else {
            row.addEventListener('mouseenter', () => {
                if (ctxMenu) ctxMenu.close();
            });
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                if (it.disabled) return;
                hideMenuBar();
                it.action();
            });
        }
        dd.appendChild(row);
    }
}

// 子菜单动作执行后也要把菜单条收回三横（IDEA 同款）
function wrapMenuActions(items) {
    return items.map((it) => {
        if (it.submenu) return {...it, submenu: wrapMenuActions(it.submenu)};
        if (it.action) return {...it, action: (...args) => { hideMenuBar(); it.action(...args); }};
        return it;
    });
}

function openDropdownSubmenu(anchor, items) {
    if (!ctxMenu || !items || !items.length) return;
    const rect = anchor.getBoundingClientRect();
    ctxMenu.open(wrapMenuActions(items), rect.right + 2, rect.top - 4);
}

function closeAllMenus() {
    document.querySelectorAll('#menubar .menu').forEach((m) => {
        m.classList.remove('open');
        m.querySelector('.dropdown').classList.add('hidden');
    });
    if (ctxMenu) ctxMenu.close();
    openMenuEl = null;
}

function openMenu(menuEl) {
    closeAllMenus();
    renderDropdown(menuEl);
    const dd = menuEl.querySelector('.dropdown');
    dd.classList.remove('hidden');
    dd.style.maxHeight = '';
    dd.style.overflowY = '';
    // 窗口高度不够时限制在视口内并内部滚动（IDEA 同款），不再被底边截断
    const rect = dd.getBoundingClientRect();
    const available = window.innerHeight - rect.top - 8;
    if (rect.height > available && available > 120) {
        dd.style.maxHeight = available + 'px';
        dd.style.overflowY = 'auto';
    }
    menuEl.classList.add('open');
    openMenuEl = menuEl;
}

// 菜单条在静止鼠标下唤出时会补发 mouseenter，坐标与上次真实移动相同则不算悬停切换
let lastMouseX = -1, lastMouseY = -1;
document.addEventListener('mousemove', (e) => { lastMouseX = e.clientX; lastMouseY = e.clientY; }, true);
document.querySelectorAll('#menubar .menu').forEach((menuEl) => {
    menuEl.querySelector('.menu-label').addEventListener('click', (e) => {
        e.stopPropagation();
        if (openMenuEl === menuEl) {
            closeAllMenus();
            return;
        }
        openMenu(menuEl);
    });
    menuEl.querySelector('.menu-label').addEventListener('mouseenter', (e) => {
        if (e.clientX === lastMouseX && e.clientY === lastMouseY) return;
        if (openMenuEl && openMenuEl !== menuEl) openMenu(menuEl);
    });
});
window.addEventListener('blur', () => hideMenuBar());
document.addEventListener('click', (e) => {
    if (menuBar.classList.contains('hidden')) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#menubar') || t.closest('.ctx-menu'))) return;
    hideMenuBar();
}, true);

function updateSearchState() {
    if (els.abSearch) {
        els.abSearch.disabled = false;
        els.abSearch.title = '内容搜索 (Ctrl+F)';
        els.abSearch.setAttribute('aria-label', '内容搜索');
    }
    if (!findState.open) return;
    if (!findTarget()) {
        closeFindBar({keepFocus: true});
        return;
    }
    ensureFindBarHost();
    runFind({keepIndex: true});
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

// 编辑器（Ace 隐藏输入框）不算纯文本输入，允许编辑器内使用 Git 快捷键
function isPlainTextEntryTarget() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.closest && el.closest('.ace_editor')) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
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

let gsShiftCount = 0;
let gsShiftAt = 0;

window.addEventListener('keydown', (e) => {
    if (globalSearch.open) return;
    if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
        const now = Date.now();
        if (now - gsShiftAt > 600) gsShiftCount = 0;
        gsShiftCount++;
        gsShiftAt = now;
        if (gsShiftCount >= 3) {
            gsShiftCount = 0;
            if (!quickSwitch.open) {
                e.preventDefault();
                openGlobalSearch();
            }
        }
        return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === 'Backquote' || e.key === '`')) {
        if (isDialogOpen()) return;
        e.preventDefault();
        e.stopPropagation();
        toggleQuickSwitch();
        return;
    }
    if (quickSwitch.open) {
        if (handleQuickSwitchKey(e)) e.preventDefault();
        e.stopPropagation();
        return;
    }
    if (palette && palette.isOpen()) {
        // 输入框内的键由 palette 自行处理，全局键屏蔽
        return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && menuKeyMap[e.code]) {
        e.preventDefault();
        e.stopPropagation();
        showMenuBar();
        openMenuByKind(menuKeyMap[e.code]);
        return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        e.stopPropagation();
        palette.toggle();
        return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
        return;
    }
    const key = e.key.toLowerCase();
    if (!isDialogOpen() && gitStateCache.available && !isPlainTextEntryTarget()) {
        if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'k') {
            e.preventDefault();
            e.stopPropagation();
            gitPopOpenCommit();
            return;
        }
        if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 't') {
            e.preventDefault();
            e.stopPropagation();
            gitPopUpdateProject();
            return;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'k') {
            e.preventDefault();
            e.stopPropagation();
            gitPopPush();
            return;
        }
        if (e.ctrlKey && e.altKey && !e.shiftKey && key === 'n') {
            e.preventDefault();
            e.stopPropagation();
            gitPopNewBranch();
            return;
        }
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'Digit1' || e.key === '1')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
    } else if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'Digit7' || e.key === '7')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarView('structure');
    } else if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'Digit8' || e.key === '8')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarView('chats');
    } else if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'Digit9' || e.key === '9')) {
        e.preventDefault();
        e.stopPropagation();
        toggleAIPanel();
    } else if (e.shiftKey && e.key === 'F4') {
        e.preventDefault();
        e.stopPropagation();
        if (file && file.path) openInNewWindows([file.path]);
    } else if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        jumpBookmark(1);
    } else if (e.shiftKey && e.key === 'F2' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        jumpBookmark(-1);
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
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'j') {
        e.preventDefault();
        e.stopPropagation();
        openJsonQuery();
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
        // F11：切换行书签（全屏不再绑定快捷键）
        e.preventDefault();
        e.stopPropagation();
        toggleBookmark();
    } else if (e.altKey && e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        toggleDockView('terminal');
    } else if (!e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'F12') {
        // F12：底部面板切换到调试控制台（仅开发者模式）
        if (!developerMode) return;
        e.preventDefault();
        e.stopPropagation();
        toggleDockView('debug');
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
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (isDialogOpen()) return;
        const active = document.activeElement;
        const inFind = active === els.findInput;
        const inEditor = !!active && ((active.closest && active.closest('.ace_editor')) ||
            (active.matches && active.matches('textarea.jsoneditor-text')));
        if (!inFind && !inEditor && isTypingTarget()) return;
        e.preventDefault();
        e.stopPropagation();
        if (inFind) {
            els.findInput.select();
            return;
        }
        openFindBar();
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
            if (plus) expandAllWithGuard(file);
            else editor.collapseAll();
        } else {
            toggleFocusedNode(plus ? 'expand' : 'collapse');
        }
    } else if (e.key === 'Escape') {
        if (!isDialogOpen() && findState.open) {
            e.preventDefault();
            e.stopPropagation();
            closeFindBar();
            return;
        }
        closeTopDialog();
        hideMenuBar();
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
    rt.EventsOn('app-open-settings', (pane) => {
        openSettings(String(pane || 'models'));
    });
    rt.EventsOn('open-targets', (targets) => openTargets(targets));
    rt.EventsOn('open-files', (paths) => openPaths(paths));
    rt.EventsOn('workspace-changed', (payload) => {
        if (explorer && typeof explorer.handleExternalChanges === 'function') explorer.handleExternalChanges(payload);
        handleExternalDocChanges(payload);
    });
    // Wails 文件拖放：注册窗口级 dragover/drop 监听（不注册就收不到任何外部拖放），
    // useDropTarget=false 让整个窗口都接受；回调拿到的路径已由 Go 侧解析好
    if (rt.OnFileDrop) {
        rt.OnFileDrop((_x, _y, paths) => {
            if (!Array.isArray(paths) || !paths.length) return;
            // 文件树目录行的外部拖放：先复制进目录，而不是打开
            const pending = pendingExternalDrop;
            if (pending && Date.now() - pending.at < 5000) {
                pendingExternalDrop = null;
                copyExternalIntoDir(paths, pending.destDir);
                return;
            }
            openPaths(paths);
        }, false);
    }
    rt.EventsOn('confirm-close', () => {
        flushCsvCellEditor();
        openCloseConfirm();
    });
    rt.EventsOn('browser-nav', (data) => {
        const doc = docs.find((d) => d.id === (data && data.id));
        if (!doc) return;
        if (data.loading !== undefined) doc.loading = !!data.loading;
        if (doc.browserEmpty) {
            doc.browserEmpty.remove();
            doc.browserEmpty = null;
        }
        if (data.url) doc.browserUrl = data.url;
        if (doc.browserAddr && document.activeElement !== doc.browserAddr) {
            doc.browserAddr.value = data.url && data.url !== 'about:blank' ? data.url : '';
        }
        if (doc.browserBackBtn && data.canGoBack !== undefined) doc.browserBackBtn.disabled = !data.canGoBack;
        if (doc.browserFwdBtn && data.canGoForward !== undefined) doc.browserFwdBtn.disabled = !data.canGoForward;
        if (data.title) updateBrowserTitle(doc, data.title);
    });
    rt.EventsOn('browser-title', (data) => {
        const doc = docs.find((d) => d.id === (data && data.id));
        if (doc && data && data.title) updateBrowserTitle(doc, data.title);
    });
    rt.EventsOn('browser-error', (data) => {
        const doc = docs.find((d) => d.id === (data && data.id));
        if (doc) flash('浏览器进程异常，标签页可能需要重新打开', true);
    });
    window.addEventListener('resize', syncAllBrowserTabs);
    // 菜单/命令面板/AI 面板全屏等浮层没有统一的开关事件：定时兜底同步内嵌浏览器的显隐
    setInterval(() => {
        if (file && file.browser) syncBrowserTab(file);
    }, 250);
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
els.wsProject.addEventListener('click', (e) => {
    e.stopPropagation();
    showProjectMenu(els.wsProject);
});
els.wsBranch.addEventListener('click', (e) => {
    e.stopPropagation();
    showBranchMenu(els.wsBranch);
});
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
const TERM_SHELL_LABELS = {pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt', gitbash: 'Git Bash'};
const cmdOutHandlers = new Map();
const cmdExitHandlers = new Map();
let cmdSeq = 0;
// AI 面板初始化必须在 terminalUI 等模块级声明之后：面板若按上次状态自动打开，
// open() → onLayout 会同步引用这些声明，放在前面会触发 TDZ 中断整个模块求值。
initAIPanel();
let mockBgSeq = 0; // mock 后台作业编号
let mockSchedSeq = 0; // mock 定时任务编号



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
        chev.innerHTML = iconSvg(gitGroupCollapsed[key] ? 'chevron-right' : 'chevron-down', 10);
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
            chev.innerHTML = iconSvg(gitGroupCollapsed[key] ? 'chevron-right' : 'chevron-down', 10);
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
    if (settings.sidebarView === 'git' || settings.sidebarView === 'structure' || settings.sidebarView === 'chats') return settings.sidebarView;
    return 'files';
}

function switchSidebarView(view) {
    if (!['files', 'git', 'structure', 'chats'].includes(view)) view = 'files';
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
    const show = force === undefined ? !terminalUI.open : force;
    if (show) {
        panel.classList.remove('hidden');
        terminalUI.open = true;
        if (dockView === 'terminal' && !terminalUI.sessions.size) createTermSession();
        applyDockView();
    } else {
        panel.classList.add('hidden');
        terminalUI.open = false;
        applyDockView();
    }
}

let dockView = 'terminal'; // 底部面板当前内容：'terminal' | 'debug'

// 应用底部面板视图：终端与调试控制台共用同一个容器
function applyDockView() {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const termOpen = terminalUI.open && dockView === 'terminal';
    const debugOpen = terminalUI.open && dockView === 'debug';
    const head = panel.querySelector('.term-head');
    if (head) head.classList.toggle('hidden', terminalUI.open && dockView === 'debug');
    const termBody = document.getElementById('term-body');
    if (termBody) termBody.classList.toggle('hidden', terminalUI.open && dockView === 'debug');
    const debugView = document.getElementById('debug-view');
    if (debugView) debugView.classList.toggle('hidden', !debugOpen);
    if (els.abTerminal) {
        els.abTerminal.classList.toggle('active', termOpen);
        els.abTerminal.setAttribute('aria-pressed', String(termOpen));
    }
    if (els.abDebug) {
        els.abDebug.classList.toggle('active', debugOpen);
        els.abDebug.setAttribute('aria-pressed', String(debugOpen));
    }
    if (termOpen) fitActiveTerm();
}

// 左下活动栏 / 菜单 / F12 的统一入口：同一视图再点一次收起，不同视图则切换
function toggleDockView(view) {
    const target = view === 'debug' ? 'debug' : 'terminal';
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    if (!terminalUI.open) {
        dockView = target;
        toggleTerminalPanel(true);
        return;
    }
    if (dockView !== target) {
        dockView = target;
        if (target === 'terminal' && !terminalUI.sessions.size) createTermSession();
        applyDockView();
        return;
    }
    toggleTerminalPanel(false);
}

async function createTermSession(shell = '') {
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
        created = await backend.TermCreate(termDefaultCols(), termDefaultRows(), shell, termCwd());
    } catch (e) {
        flash('创建终端失败：' + e, true);
        host.remove();
        return;
    }
    const id = created.id;
    const usedShell = created.shell || shell || 'powershell';
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
    // 页签命名仿 JetBrains：默认 shell 叫「本地」，重复时加 (2)/(3)；显式选择的 shell 用名字
    const baseName = shell ? (TERM_SHELL_LABELS[usedShell] || usedShell) : '本地';
    let dup = 0;
    for (const s of terminalUI.sessions.values()) {
        if (s.baseName === baseName) dup++;
    }
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'term-tab';
    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = dup ? baseName + ' (' + (dup + 1) + ')' : baseName;
    label.title = TERM_SHELL_LABELS[usedShell] || usedShell;
    const tabClose = document.createElement('span');
    tabClose.className = 'term-tab-close';
    tabClose.innerHTML = iconSvg('close', 11);
    tabClose.title = '关闭终端';
    tab.append(label, tabClose);
    tab.addEventListener('click', (e) => {
        const closeHit = e.target.closest('.term-tab-close');
        if (closeHit) {
            e.preventDefault();
            e.stopPropagation();
            closeTermSession(id);
            return;
        }
        if (e.shiftKey) {
            e.preventDefault();
            closeTermSession(id);
            return;
        }
        activateTermSession(id);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateTermSession(id);
        showTermTabMenu(id, e.clientX, e.clientY);
    });
    document.getElementById('term-tabs').appendChild(tab);
    terminalUI.sessions.set(id, {id, term, fit, host, tab, shell: usedShell, baseName,
        defaultLabel: label.textContent, defaultTitle: label.title, customName: ''});
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
if (els.termShellMenu) els.termShellMenu.addEventListener('click', () => showTermShellMenu());

// 新建终端的 shell 菜单（JetBrains 风格）：列出本机可用 shell，选中即新建页签
async function showTermShellMenu() {
    if (!ctxMenu) return;
    let shells = [];
    try {
        shells = backend.TermShells ? await backend.TermShells() : [];
    } catch (e) {}
    if (!shells.length) {
        flash('没有可用的 Shell', true);
        return;
    }
    const r = els.termShellMenu.getBoundingClientRect();
    ctxMenu.open(shells.map((s) => ({
        label: s.name,
        action: () => createTermSession(s.id),
    })), r.left, r.bottom + 4);
}
if (els.termPanelClose) els.termPanelClose.addEventListener('click', () => toggleTerminalPanel(false));

// 终端标签页右键菜单（JetBrains 风格）：新建/重命名/清屏/关闭
async function showTermTabMenu(id, x, y) {
    if (!ctxMenu) return;
    const s = terminalUI.sessions.get(id);
    if (!s) return;
    const others = [...terminalUI.sessions.values()].filter((v) => v.id !== id);
    let shells = [];
    try {
        shells = backend.TermShells ? await backend.TermShells() : [];
    } catch (e) {}
    const items = [
        {label: '新建终端（默认 Shell）', icon: 'E710', action: () => createTermSession()},
    ];
    if (shells.length) {
        items.push({
            label: '用其他 Shell 新建终端',
            icon: 'E756',
            submenu: shells.map((sh) => ({label: sh.name, action: () => createTermSession(sh.id)})),
        });
    }
    items.push(
        {label: '重命名标签页', icon: 'E8AC', action: () => renameTermSession(s)},
        {label: '清屏', icon: 'eraser', action: () => { try { s.term.clear(); s.term.focus(); } catch (e) {} }},
        {sep: true},
        {label: '关闭', shortcut: 'Shift+点击', icon: 'E8BB', action: () => closeTermSession(id)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => { for (const o of others) closeTermSession(o.id); }},
        {label: '关闭所有标签页', action: () => { for (const o of [...terminalUI.sessions.values()]) closeTermSession(o.id); }},
    );
    ctxMenu.open(items, x, y);
}

// 重命名终端标签页：清空并确定则恢复默认名
function renameTermSession(s) {
    if (!s) return;
    openNameDialog({
        title: '重命名终端标签页',
        label: '名称',
        value: s.customName || s.defaultLabel,
        okLabel: '确定',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            const label = s.tab.querySelector('.term-tab-label');
            if (!label) return;
            if (name) {
                s.customName = name;
                label.textContent = name;
                label.title = name;
            } else {
                s.customName = '';
                label.textContent = s.defaultLabel;
                label.title = s.defaultTitle;
            }
        },
    });
}

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

// ===== 浏览器使用标签页 =====
let browserSeq = 0;

function openBrowserTab(url, profileKey) {
    browserSeq += 1;
    const target = (url || '').trim() || 'about:blank';
    const doc = {
        id: 'browser-' + Date.now().toString(36) + '-' + browserSeq,
        path: null,
        name: target !== 'about:blank' ? target : '新标签页',
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'browser', name: '网页', extensions: [], aceMode: 'text', rawOnly: true},
        browser: true,
        mode: 'browser',
        browserUrl: target,
        browserProfile: profileKey || '',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    docs.push(doc);
    addDocToFocusedGroup(doc);
    activateDoc(doc);
    if (backend.BrowserOpen) {
        backend.BrowserOpen(doc.id, target, doc.browserProfile || 'tab-' + doc.id).then((info) => {
            if (info && info.title) updateBrowserTitle(doc, info.title);
            if (doc.browserEmpty) {
                doc.browserEmpty.remove();
                doc.browserEmpty = null;
            }
            syncBrowserTab(doc);
        }).catch((e) => {
            const stack = String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 4).join(' | ');
            flash('浏览器标签页打开失败：' + ((e && e.message) || e) + ' @ ' + stack, true);
            closeDocNow(doc, false);
        });
    } else {
        flash('当前环境不支持内嵌浏览器', true);
    }
    return doc;
}

// ===== 后台终端标签页（AI background_command 作业在内容区的视图）=====
// 数据来自 aiPanel 桥接（bridgeBgJob / bridgeOnBgUpdate / bridgeStopBgJob）；
// 上栏命令信息、下栏实时输出，中间分割线可拖拽（比例存 localStorage）；关闭标签不影响作业。

const BGTERM_SPLIT_KEY = 'datalens-bgterm-split';

function bgTermSplitRatio() {
    const raw = Number(localStorage.getItem(BGTERM_SPLIT_KEY));
    if (!Number.isFinite(raw) || raw < 0.15 || raw > 0.85) return 0.34;
    return raw;
}

function bgTermTabName(command) {
    const line = String(command || '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
    if (!line) return '后台终端';
    return line.length > 28 ? line.slice(0, 28) + '…' : line;
}

function openBgTermTab(info) {
    const jobId = String((info && info.jobId) || '');
    if (!jobId) return null;
    const existing = docs.find((d) => d.bgTerm === jobId);
    if (existing) {
        activateDoc(existing);
        return existing;
    }
    const doc = {
        id: 'bgterm-' + jobId,
        path: null,
        name: bgTermTabName(info && info.command),
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'bgterm', name: '后台终端', extensions: [], aceMode: 'text', rawOnly: true},
        bgTerm: jobId,
        bgTermCommand: String((info && info.command) || ''),
        mode: 'bgterm',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    docs.push(doc);
    addDocToFocusedGroup(doc);
    activateDoc(doc);
    return doc;
}

function bgTermStateLabel(state, code) {
    if (state === 'running') return '运行中';
    if (state === 'exited') return '已退出（' + (code == null ? '?' : code) + '）';
    if (state === 'stopped') return '已停止';
    if (state === 'notfound') return '不存在';
    return state || '未知';
}

function createBgTermView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active bgterm-pane';
    els.editor.appendChild(pane);

    // 上栏：命令 + 元信息 + 停止
    const info = document.createElement('div');
    info.className = 'bgterm-info';
    const cmdRow = document.createElement('div');
    cmdRow.className = 'bgterm-cmd-row';
    const cmdLabel = document.createElement('span');
    cmdLabel.className = 'bgterm-label';
    cmdLabel.textContent = '命令';
    const cmd = document.createElement('pre');
    cmd.className = 'bgterm-cmd';
    cmd.textContent = doc.bgTermCommand || '（读取中…）';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'dlg-btn bgterm-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => copyText(doc.bgTermCommand || '', '命令'));
    cmdRow.append(cmdLabel, cmd, copyBtn);

    const metaRow = document.createElement('div');
    metaRow.className = 'bgterm-meta-row';
    const stateBadge = document.createElement('span');
    stateBadge.className = 'bgterm-state';
    const metaText = document.createElement('span');
    metaText.className = 'bgterm-meta';
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'dlg-btn bgterm-stop';
    stopBtn.textContent = '停止';
    metaRow.append(stateBadge, metaText, stopBtn);
    info.append(cmdRow, metaRow);

    // 中间分割线：拖拽调整上下比例
    const split = document.createElement('div');
    split.className = 'bgterm-split';
    split.title = '拖动调整上下高度';

    // 下栏：输出
    const out = document.createElement('pre');
    out.className = 'bgterm-out empty';
    out.textContent = '（暂无输出；作业产生输出后会实时显示在这里）';

    pane.append(info, split, out);
    doc.pane = pane;
    doc.bgTermEl = out;
    doc.bgTermStateEl = stateBadge;
    doc.bgTermMetaEl = metaText;

    doc.bgTermRatio = bgTermSplitRatio();
    info.style.flexBasis = (doc.bgTermRatio * 100) + '%';
    let dragging = false;
    const onMove = (e) => {
        if (!dragging || !pane.isConnected) return;
        const rect = pane.getBoundingClientRect();
        if (!rect.height) return;
        const ratio = Math.min(0.85, Math.max(0.15, (e.clientY - rect.top) / rect.height));
        doc.bgTermRatio = ratio;
        info.style.flexBasis = (ratio * 100) + '%';
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('bgterm-dragging');
        try { localStorage.setItem(BGTERM_SPLIT_KEY, String(doc.bgTermRatio)); } catch (e) {}
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    split.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        document.body.classList.add('bgterm-dragging');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    stopBtn.addEventListener('click', async () => {
        if (!aiPanel || !aiPanel.bridgeStopBgJob) return flash('当前版本不支持停止后台命令', true);
        stopBtn.disabled = true;
        try {
            await aiPanel.bridgeStopBgJob(doc.bgTerm);
            flash('已发送停止指令');
        } catch (e) {
            flash('停止失败：' + ((e && e.message) || e), true);
        } finally {
            stopBtn.disabled = false;
        }
    });

    const render = () => {
        const snapshot = aiPanel && aiPanel.bridgeBgJob ? aiPanel.bridgeBgJob(doc.bgTerm) : null;
        if (!snapshot) {
            stateBadge.textContent = '已丢失';
            stateBadge.className = 'bgterm-state st-lost';
            metaText.textContent = '作业句柄不在本运行期（应用重启后无法查看实时输出）';
            stopBtn.classList.add('hidden');
            return;
        }
        if (snapshot.command && !doc.bgTermCommand) {
            doc.bgTermCommand = snapshot.command;
            cmd.textContent = snapshot.command;
        }
        const state = snapshot.state || 'unknown';
        stateBadge.textContent = bgTermStateLabel(state, snapshot.code);
        stateBadge.className = 'bgterm-state st-' + state;
        const bits = [];
        if (snapshot.cwd) bits.push('目录 ' + snapshot.cwd);
        bits.push('jobId ' + doc.bgTerm);
        if (snapshot.startedAt) bits.push('启动 ' + new Date(snapshot.startedAt).toLocaleTimeString());
        metaText.textContent = bits.join(' · ');
        stopBtn.classList.toggle('hidden', state !== 'running');
        const text = String(snapshot.log || '');
        // 用户往上翻历史时不强制拉回底部
        const nearBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 60;
        if (text) {
            out.textContent = text;
            out.classList.remove('empty');
            if (nearBottom) out.scrollTop = out.scrollHeight;
        } else {
            out.textContent = '（暂无输出；作业产生输出后会实时显示在这里）';
            out.classList.add('empty');
        }
        renderBgTermTabTitle(doc, snapshot.command);
    };

    if (aiPanel && aiPanel.bridgeOnBgUpdate) {
        doc.bgTermUnsub = aiPanel.bridgeOnBgUpdate((jobId) => {
            if (jobId !== doc.bgTerm || !doc.pane || !doc.pane.isConnected) return;
            render();
        });
    }
    render();
}

function renderBgTermTabTitle(doc, command) {
    const name = bgTermTabName(command || doc.bgTermCommand);
    if (name && name !== doc.name) {
        doc.name = name;
        renderTabs();
    }
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
        gitStateCache.available = false;
        gitStateCache.branch = '';
        applyGitBadges();
        renderWorkspaceCrumbs();
        notifyAIGitEntry();
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
    renderWorkspaceCrumbs();
    // git 状态变化（提交/回滚/外部改动被定时器捕捉）后刷新已打开文件的行级标记
    for (const d of docs) scheduleGitGutter(d, 400);
    if (currentSidebarView() === 'git' && settings.showSidebar && els.gitChanges) {
        renderGitPanel();
    }
    notifyAIGitEntry();
}

// AI 面板头顶的 Git 图标是否出现，取决于当前工作区是不是 git 仓库。
function notifyAIGitEntry() {
    if (aiPanel && typeof aiPanel.refreshGitEntry === 'function') {
        try { aiPanel.refreshGitEntry(); } catch (e) {}
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

// ---- CLI 转换模式：隐藏窗口加载前端格式层，转换完立即退出 ----
function convertTargetDriver(to) {
    const id = String(to || '').toLowerCase().replace(/^\./, '');
    const aliases = {yml: 'yaml', ndjson: 'jsonl'};
    const targetID = aliases[id] || id;
    const driver = formats[targetID] ||
        pluginFormats.find((f) => f.id === targetID) ||
        Object.values(formats).find((f) => f.extensions.includes(targetID));
    if (!driver || typeof driver.parse !== 'function' || typeof driver.stringify !== 'function') {
        throw new Error('不支持的目标格式：' + to);
    }
    return driver;
}

async function maybeRunConvertJob() {
    if (!hasWails || !backend.GetConvertRequest) return false;
    let raw = '';
    try {
        raw = await backend.GetConvertRequest();
    } catch (e) {
        return false;
    }
    if (!raw) return false;
    let req;
    try {
        req = JSON.parse(raw);
    } catch (e) {
        return false;
    }
    let target = null;
    let targetError = '';
    try {
        target = convertTargetDriver(req.to);
    } catch (e) {
        targetError = String((e && e.message) || e);
    }
    const results = [];
    for (const job of req.jobs || []) {
        try {
            if (targetError) throw new Error(targetError);
            const data = await backend.OpenFile(job.input, 'auto');
            if (!data || data.binary) throw new Error('二进制文件不支持转换');
            const content = String(data.content == null ? '' : data.content);
            const source = detectFormat(job.input, content);
            if (typeof source.parse !== 'function' || typeof source.stringify !== 'function') {
                throw new Error('不支持读取该格式：' + (source.name || ''));
            }
            const value = source.parse(content);
            const output = target.stringify(value);
            results.push({
                input: job.input,
                output: job.output || '',
                content: output == null ? '' : String(output),
            });
        } catch (e) {
            results.push({
                input: job.input,
                output: job.output || '',
                error: String((e && e.message) || e),
            });
        }
    }
    try {
        await backend.FinishConvert(JSON.stringify({stdout: !!req.stdout, results}));
    } catch (e) {}
    return true;
}

(async () => {
    if (await maybeRunConvertJob()) return;
    // 独立调试控制台窗口：只渲染控制台面板，跳过正常的应用启动流程
    if (await consoleWindowMode) {
        startConsoleWindowMode();
        return;
    }
    let floatWindow = false;
    try {
        floatWindow = !!(backend.IsAIFloatWindow && await backend.IsAIFloatWindow());
    } catch (e) {
        floatWindow = false;
    }
    if (!floatWindow && !hasWails && mockScenario.has('aifloat')) floatWindow = true;
    if (floatWindow) {
        window.__aiFloatWindow = true;
        document.body.classList.add('ai-float-window');
        document.title = 'AI 助手 · CaDt-DataLens';
    }
    // 操作留痕：主窗口启动标记（悬浮窗/独立控制台/转换模式不记）。
    activityLog.log('app.start', '', {mock: hasWails ? undefined : true}, {actor: 'system', source: 'system'});
    refreshDeveloperMode();
    refreshLogPath();
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
    logFrontend('info', '前端启动完成：' + navigator.userAgent);
    let startupAISession = '';
    if (backend.GetStartupAISession) {
        try {
            startupAISession = await backend.GetStartupAISession() || '';
        } catch (e) {}
    }
    let targets = [];
    if (backend.GetStartupTargets) {
        try {
            targets = await backend.GetStartupTargets();
        } catch (e) {}
    }
    if (targets && targets.length) {
        // 先读取目标目录上次的工作区环境，再打开目标：打开目录会触发一次防抖保存，
        // 若先打开再读，空环境可能把旧环境覆盖掉。
        let workspaceSession = null;
        if (!floatWindow && backend.GetPathInfo) {
            for (const target of targets) {
                if (!target || !target.path) continue;
                let info = null;
                try {
                    info = await backend.GetPathInfo(target.path);
                } catch (e) {}
                if (info && info.isDir) {
                    workspaceSession = readWorkspaceSession(info.path);
                    break;
                }
            }
        }
        await openTargets(targets);
        if (workspaceSession) await restoreSession(workspaceSession);
    } else {
        const files = await backend.GetStartupFiles();
        if (files && files.length) await openPaths(files);
        else {
            const sess = readSession();
            if (sess) await restoreSession(sess);
        }
    }
    if (floatWindow) {
        document.title = 'AI 助手 · CaDt-DataLens';
        if (!aiPanel) initAIPanel();
        if (aiPanel) aiPanel.open(true);
    } else {
        setTimeout(() => autoCheckUpdateOnStart(), 2000);
        // 软切换新窗口：打开 AI 面板并选中目标会话（工作区已在上一步恢复）。
        if (startupAISession && aiPanel && aiPanel.bridgeListSessions) {
            try {
                if (aiPanel.whenReady) await aiPanel.whenReady();
            } catch (e) {}
            const session = aiPanel.bridgeListSessions().find((item) => item.id === startupAISession);
            if (session && (!session.workspace || sessionPathKey(session.workspace) === sessionPathKey(workspaceFolder))) {
                aiPanel.open(true);
                try {
                    aiPanel.bridgeSwitchSession(startupAISession);
                } catch (e) {}
            }
        }
    }
    try {
        if (backend.ConsumeStartupSettings) {
            const pane = await backend.ConsumeStartupSettings();
            if (pane) openSettings(String(pane));
        }
    } catch (e) {}
})();
