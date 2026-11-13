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
import {createAIPanel} from './ai/ai-panel.js';
import {createReadingMode} from './reading/reading.js';
import {repairJson} from './jsonrepair.js';
import {createFileIcon, fileIconSpec} from './fileicons.js';
import {createRunController, splitRunArgs, RECIPES, extOf, SELF_TEST} from './run.js';
import {buildJsonLineMap, queryJsonPath} from './jsonpath.js';
import {semanticDiff, semanticEntryText, unifiedDiff} from './diff.js';
import {validateJsonSchema} from './jsonschema.js';
import {getPluginCommands, initPluginRuntime, loadPlugins} from './plugins.js';
import {createMarkdownRenderer} from './markdown.js';
import {
    showPatchView, hidePatchView, disposePatchView, refreshPatchView,
    patchViewSnapshot, setPatchTargetRoot, repreviewPatchView,
} from './patch-view.js';
import {WRITING_FONTS, WRITING_PAPERS, formatWritingText, genName, SCENE_SEPARATOR} from './writing.js';
import changelogText from '../../CHANGELOG.md?raw';
import termsText from '../../docs/legal/terms.md?raw';
import privacyText from '../../docs/legal/privacy.md?raw';
import {createBridgeUI} from './bridge-ui.js';
import {createCursorThemes} from './cursor-themes.js';
import {createTerminalUI} from './terminal-ui.js';
import {createFormatConvert} from './format-convert.js';
import {createUpdateCheck} from './update-check.js';
import {createAppLinks} from './app-links.js';
import {createPropertiesUI} from './properties-ui.js';
import {createSessionRestore} from './session-restore.js';
import {createAppActions} from './app-actions.js';
import {createQuickSwitch} from './quick-switch.js';
import {createSchemaPanel} from './schema-panel.js';
import {createDiffDialog} from './diff-dialog.js';
import {createJsonQuery} from './json-query.js';
import {createGlobalSearch} from './global-search.js';
import {createFindBar} from './find-bar.js';
import {createActivityPane} from './activity-pane.js';
import {createMenuBar} from './menu-bar.js';
import {createModeSwitch} from './mode-switch.js';
import {createTitlebarPopovers} from './titlebar-popovers.js';
import {createSettingsUI} from './settings-ui.js';
import {createWritingUI} from './writing-ui.js';
import {createEditorGroups} from './editor-groups.js';

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
    async PrepareRun(spec) {
        return {sourcePath: (spec && spec.srcPath) || 'mock://run/main.py', workDir: 'mock://run', tempDir: '', tempCopy: !!(spec && spec.content)};
    },
    async RunExec(id, exe, args) {
        setTimeout(() => {
            if (rt && rt.EventsEmit) {
                rt.EventsEmit('run-out', {id, stream: 'out', data: '模拟运行输出：' + exe + ' ' + (args || []).join(' ') + '\n'});
                rt.EventsEmit('run-exit', {id, code: 0, durationMs: 12});
            }
        }, 30);
        return null;
    },
    async RunStop() { return null; },
    async RunInput() { return null; },
    async RunEndInput() { return null; },
    async ResolveRunShell() { return {path: 'mock-shell', name: 'Mock Shell'}; },
    async CleanupRunTemp() { return null; },
    async CleanupRunTempStale() { return 0; },
    async DetectRunProject() { return {root: '', kind: 'Mock', marker: '', commands: [], note: '浏览器 mock 环境没有项目探测'}; },
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
        const id = 'bg-mock-' + nextMockBgSeq();
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
            id: 'sch-mock-' + nextMockSchedSeq(),
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
    // mock：浏览器调试时没有系统剪贴板图片，用 window.__mockClipboardImage 模拟 data URL。
    async GetClipboardImage() { return window.__mockClipboardImage || ''; },
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
    if (!developerMode && terminalUI.open && getDockView() === 'debug') {
        if (terminalUI.sessions.size) {
            setDockView('terminal');
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
    structureTitle: document.querySelector('#structure-panel .sb-title'),
    structureSource: document.getElementById('structure-source'),
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
    abRun: document.getElementById('ab-run'),
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
    'get_activity', 'get_patch', 'patch_set_root', 'patch_repreview',
];

const APP_SCREENSHOT_AREAS = {
    full: {selector: '', label: '整窗'},
    editor: {selector: '#main-pane', label: '编辑区'},
    sidebar: {selector: '#sidebar', label: '侧边栏'},
    ai: {selector: '#ai-panel', label: 'AI 面板'},
    terminal: {selector: '#terminal-panel', label: '终端'},
    patch: {selector: '.jsoneditor-pane.patch-active .patch-view', label: '补丁视图'},
    statusbar: {selector: '#statusbar', label: '状态栏'},
};

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
                terminal: {open: !!(terminalUI && terminalUI.open), view: getDockView()},
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
            return {terminal: {open: !!(terminalUI && terminalUI.open), view: getDockView()}};
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
        case 'get_patch': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (!(doc.format && doc.format.patch)) throw new Error('目标标签不是 .patch / .diff：' + (doc.path || doc.name));
            if (!doc.patchState || !doc.patchState.plan) {
                await refreshPatchView(doc, patchViewContext());
            }
            const snap = patchViewSnapshot(doc);
            if (snap) return snap;
            const err = doc.patchState && doc.patchState.error;
            if (err) throw new Error(err);
            return {loaded: false, name: doc.name, path: doc.path || ''};
        }
        case 'patch_set_root': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (!(doc.format && doc.format.patch)) throw new Error('目标标签不是 .patch / .diff：' + (doc.path || doc.name));
            return setPatchTargetRoot(doc, patchViewContext(), p.root);
        }
        case 'patch_repreview': {
            const doc = appActionResolveDoc(p.target);
            if (!doc) throw new Error('找不到文档：' + (p.target == null ? 'active' : p.target));
            if (!(doc.format && doc.format.patch)) throw new Error('目标标签不是 .patch / .diff：' + (doc.path || doc.name));
            return repreviewPatchView(doc, patchViewContext(), {ignoreWhitespace: p.ignoreWhitespace, allowOffset: p.allowOffset});
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
            // 截取应用主窗口或指定板块（含 WebView2 与内嵌浏览器）；由 ai-panel 转成图片消息附加给模型
            const area = String(p.area || 'full').trim().toLowerCase();
            const spec = APP_SCREENSHOT_AREAS[area];
            if (!spec) throw new Error('未知截图区域「' + area + '」；可用：' + Object.keys(APP_SCREENSHOT_AREAS).join(' / '));
            if (!spec.selector) {
                if (!backend.CaptureAppScreenshot) throw new Error('截图通道不可用（请重新构建或更新应用）');
                const image = await backend.CaptureAppScreenshot();
                if (!image || image.length < 50) throw new Error('截图数据为空');
                return {image, mime: 'image/png', name: '应用截图'};
            }
            const el = document.querySelector(spec.selector);
            if (!el) {
                let hint = '';
                if (area === 'ai') hint = '（AI 面板可能已弹出为独立窗口，先停靠回来）';
                if (area === 'patch') hint = '（先在顶部视图切换里进入补丁视图）';
                throw new Error('找不到板块：' + spec.label + hint);
            }
            const rect = el.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) throw new Error('板块当前不可见：' + spec.label);
            if (!backend.CaptureAppScreenshotRegion) throw new Error('区域截图通道不可用（请重新构建或更新应用）');
            const dpr = window.devicePixelRatio || 1;
            const image = await backend.CaptureAppScreenshotRegion(
                Math.round(rect.left * dpr),
                Math.round(rect.top * dpr),
                Math.max(1, Math.round(rect.width * dpr)),
                Math.max(1, Math.round(rect.height * dpr))
            );
            if (!image || image.length < 50) throw new Error('截图数据为空');
            return {image, mime: 'image/png', name: '应用截图 · ' + spec.label};
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
    // 这些函数拆分到域模块后经 const 解构引入（不再有函数声明提升），
    // 这里必须用 getter 延迟求值，否则顶层急切求值会 TDZ
    get openCloseConfirm() { return openCloseConfirm; },
    get openPaths() { return openPaths; },
    get openTargets() { return openTargets; },
    get openFolderWorkspace() { return openFolderWorkspace; },
    get reopenClosedTab() { return reopenClosedTab; },
    get setTheme() { return setTheme; },
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
    {id: 'harness', name: 'Harness', group: 'harness', bg: '#ffffff', accent: '#4176e6'},
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
    // 结构面板在「文件 + AI 助手」同时存在时的来源偏好（file / session）
    structureSource: 'file',
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
    // 运行代码（docs/finished-plans/run-code.md）
    runCwd: 'file',
    runDirtyMode: 'ask',
    runArgs: {},
    runConfigs: {},
    runProfiles: [],
    runActiveProfile: '',
    runConfirmSeen: [],
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
    aiShowUsage: true,
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
if (settings.structureSource !== 'session') settings.structureSource = 'file';
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
settings.runCwd = settings.runCwd === 'workspace' ? 'workspace' : 'file';
if (!['ask', 'save', 'temp'].includes(settings.runDirtyMode)) settings.runDirtyMode = 'ask';
if (!settings.runArgs || typeof settings.runArgs !== 'object') settings.runArgs = {};
if (!settings.runConfigs || typeof settings.runConfigs !== 'object') settings.runConfigs = {};
if (!Array.isArray(settings.runProfiles)) settings.runProfiles = [];
if (typeof settings.runActiveProfile !== 'string') settings.runActiveProfile = '';
if (!Array.isArray(settings.runConfirmSeen)) settings.runConfirmSeen = [];
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
settings.aiShowUsage = settings.aiShowUsage !== false;
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

const settingsUI = createSettingsUI({
    get aiPanel() { return aiPanel; },
    get allFormatDefs() { return allFormatDefs; },
    get applySidebarUI() { return applySidebarUI; },
    get applyWritingMode() { return applyWritingMode; },
    get backend() { return backend; },
    get cancelAutoSave() { return cancelAutoSave; },
    get cjkFonts() { return cjkFonts; },
    get currentMode() { return currentMode; },
    get defaultFormatSettings() { return defaultFormatSettings; },
    get developerMode() { return developerMode; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get editor() { return editor; },
    get editorFonts() { return editorFonts; },
    get els() { return els; },
    get explorer() { return explorer; },
    get file() { return file; },
    get flash() { return flash; },
    get initAIPanel() { return initAIPanel; },
    get LANG_DEFS() { return LANG_DEFS; },
    get LOCK_ICON() { return LOCK_ICON; },
    get readingMode() { return readingMode; },
    get refreshDeveloperMode() { return refreshDeveloperMode; },
    get refreshLogPath() { return refreshLogPath; },
    get relativePathFrom() { return relativePathFrom; },
    get renderActivityPane() { return renderActivityPane; },
    get renderCsvTableView() { return renderCsvTableView; },
    get renderEnvVarsPane() { return renderEnvVarsPane; },
    get renderFmtTable() { return renderFmtTable; },
    get renderFormatPane() { return renderFormatPane; },
    get renderLangPane() { return renderLangPane; },
    get renderMarkdownPreview() { return renderMarkdownPreview; },
    get renderPluginsPane() { return renderPluginsPane; },
    get renderRunPane() { return renderRunPane; },
    get rt() { return rt; },
    get scheduleAutoSave() { return scheduleAutoSave; },
    get settings() { return settings; },
    get settingsKey() { return settingsKey; },
    get syncAllBrowserTabs() { return syncAllBrowserTabs; },
    get syncRunButtonState() { return syncRunButtonState; },
    get syncTerminalTheme() { return syncTerminalTheme; },
    get themes() { return themes; },
    get uiFonts() { return uiFonts; },
    get UNLOCK_ICON() { return UNLOCK_ICON; },
    get updateAiWidthWidget() { return updateAiWidthWidget; },
    get updateStatus() { return updateStatus; },
    get updateWritingStats() { return updateWritingStats; },
    get workspaceFolder() { return workspaceFolder; },
});
const {actRel, activityLog, applyIntegration, applyReadOnlyToDoc, applySettings, closeDialogs, closeTopDialog, getConfirmAction, setConfirmAction, countWords, currentTheme, cursorPositionForDoc, elsDialogs, elsSettings, getFormatSettings, installReadOnlyGuards, openDialogEl, openNameDialog, openSaveConflictDialog, openSettings, rtFullscreen, scheduleWordCount, selectSettingsPane, setTheme, syncIntegrationStatus, syncedOpenMode, toggleAlwaysOnTop, toggleCodeWrap, toggleFullscreen, updateLockButton, updateWordCount} = settingsUI;
const writingUI = createWritingUI({
    get nextCmdSeq() { return nextCmdSeq; },
    get activityLog() { return activityLog; },
    get allFormatDefs() { return allFormatDefs; },
    get applyCsvTableZoom() { return applyCsvTableZoom; },
    get applyImageZoom() { return applyImageZoom; },
    get applyIntegration() { return applyIntegration; },
    get applySettings() { return applySettings; },
    get autoSaveTimer() { return autoSaveTimer; },
    get backend() { return backend; },
    get cjkFonts() { return cjkFonts; },
    get closeDialogs() { return closeDialogs; },
    get closeTopDialog() { return closeTopDialog; },
    get cmdExitHandlers() { return cmdExitHandlers; },
    get cmdOutHandlers() { return cmdOutHandlers; },
    get copyText() { return copyText; },
    get countWords() { return countWords; },
    get currentMode() { return currentMode; },
    get currentTheme() { return currentTheme; },
    get cursorPositionForDoc() { return cursorPositionForDoc; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get editor() { return editor; },
    get editorFonts() { return editorFonts; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get elsSettings() { return elsSettings; },
    get file() { return file; },
    get flashTimer() { return flashTimer; },
    get getConfirmAction() { return getConfirmAction; },
    get getFormatSettings() { return getFormatSettings; },
    get logFrontend() { return logFrontend; },
    get markDocDirty() { return markDocDirty; },
    get openDialogEl() { return openDialogEl; },
    get openNameDialog() { return openNameDialog; },
    get openPath() { return openPath; },
    get openPaths() { return openPaths; },
    get openSettings() { return openSettings; },
    get openVirtualDoc() { return openVirtualDoc; },
    get propsTimeText() { return propsTimeText; },
    get renderMarkdownPreview() { return renderMarkdownPreview; },
    get rt() { return rt; },
    get runArgsText() { return runArgsText; },
    get runController() { return runController; },
    get save() { return save; },
    get scheduleWordCount() { return scheduleWordCount; },
    get selectSettingsPane() { return selectSettingsPane; },
    get setConfirmAction() { return setConfirmAction; },
    get settings() { return settings; },
    get structurePanel() { return structurePanel; },
    get switchMode() { return switchMode; },
    get syncIntegrationStatus() { return syncIntegrationStatus; },
    get termCwd() { return termCwd; },
    get textArea() { return textArea; },
    get themes() { return themes; },
    get updateStatus() { return updateStatus; },
});
const {CSV_COL_MIN_WIDTH, CSV_ROW_NUM_WIDTH, INDENTS, LANG_DEFS, TREE_MAX_CHILDREN, applyWritingFormat, applyWritingMode, canSplitDoc, cancelAutoSave, closeFootPopover, editorLocale, effectiveToolEnv, flash, fmtSize, formatDisplayName, insertSceneSeparator, isSqlSupportedDoc, isSvgDoc, jumpToPosition, markdownRenderer, mdPreviewWidthLabel, normalizeLegacySqlMode, openCloseConfirm, openGotoDialog, openWritingNameDialog, renderEnvVarsPane, renderFmtTable, renderFormatPane, renderLangPane, renderMarkdownHtml, renderMermaidBlocks, renderPluginsPane, renderRunPane, resolveMarkdownImages, scheduleAutoSave, scheduleCursorPosition, scheduleWritingCaret, setDirty, splitKindFor, toggleWritingMode, toolEnvFor, updateAiWidthWidget, updateBackendDirty, updateCursorPosition, updateTabDirty, updateWindowTitle, updateWritingStats, viewDisabled, viewLabel, viewOptionsFor, writingFormatable} = writingUI;
const editorGroupsMod = createEditorGroups({
    get activityLog() { return activityLog; },
    get aiPanel() { return aiPanel; },
    get aiReferenceFileMenuItems() { return aiReferenceFileMenuItems; },
    get applyReadOnlyToDoc() { return applyReadOnlyToDoc; },
    get applySettings() { return applySettings; },
    get applyWritingMode() { return applyWritingMode; },
    get askAIAboutPath() { return askAIAboutPath; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get cancelAutoSave() { return cancelAutoSave; },
    get canSplitDoc() { return canSplitDoc; },
    get closeDialogs() { return closeDialogs; },
    get closedTabs() { return closedTabs; },
    get closeFootPopover() { return closeFootPopover; },
    get copyText() { return copyText; },
    get createBgTermView() { return createBgTermView; },
    get CSV_COL_MIN_WIDTH() { return CSV_COL_MIN_WIDTH; },
    get CSV_ROW_NUM_WIDTH() { return CSV_ROW_NUM_WIDTH; },
    get ctxMenu() { return ctxMenu; },
    get currentMode() { return currentMode; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get docSeq() { return docSeq; },
    get editor() { return editor; },
    get editorLocale() { return editorLocale; },
    get els() { return els; },
    get explorer() { return explorer; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get fmtSize() { return fmtSize; },
    get formatDisplayName() { return formatDisplayName; },
    get getFormatSettings() { return getFormatSettings; },
    get gitStateCache() { return gitStateCache; },
    get installReadOnlyGuards() { return installReadOnlyGuards; },
    get isSqlSupportedDoc() { return isSqlSupportedDoc; },
    get isSvgDoc() { return isSvgDoc; },
    get jumpToPosition() { return jumpToPosition; },
    get knownDocViews() { return knownDocViews; },
    get markdownRenderer() { return markdownRenderer; },
    get mdPreviewWidthLabel() { return mdPreviewWidthLabel; },
    get normalizeLegacySqlMode() { return normalizeLegacySqlMode; },
    get openBrowserTab() { return openBrowserTab; },
    get openCloseConfirm() { return openCloseConfirm; },
    get openDiffDialog() { return openDiffDialog; },
    get openInNewWindows() { return openInNewWindows; },
    get openNameDialog() { return openNameDialog; },
    get openPath() { return openPath; },
    get openSettings() { return openSettings; },
    get parentFolderOf() { return parentFolderOf; },
    get pathWithinValue() { return pathWithinValue; },
    get pendingDocViews() { return pendingDocViews; },
    get plainTextExtensions() { return plainTextExtensions; },
    get refreshStructureSources() { return refreshStructureSources; },
    get reloadActive() { return reloadActive; },
    get renderMarkdownHtml() { return renderMarkdownHtml; },
    get renderMermaidBlocks() { return renderMermaidBlocks; },
    get resolveMarkdownImages() { return resolveMarkdownImages; },
    get rt() { return rt; },
    get save() { return save; },
    get saveSessionNow() { return saveSessionNow; },
    get scheduleCursorPosition() { return scheduleCursorPosition; },
    get scheduleSessionSave() { return scheduleSessionSave; },
    get scheduleStructureRefresh() { return scheduleStructureRefresh; },
    get scheduleWordCount() { return scheduleWordCount; },
    get scheduleWritingCaret() { return scheduleWritingCaret; },
    get sessionPathKey() { return sessionPathKey; },
    get setDirty() { return setDirty; },
    get setDragCursor() { return setDragCursor; },
    get settings() { return settings; },
    get settingsKey() { return settingsKey; },
    get splitKindFor() { return splitKindFor; },
    get structurePanel() { return structurePanel; },
    get switchMode() { return switchMode; },
    get syncExplorerActive() { return syncExplorerActive; },
    get syncRunButtonState() { return syncRunButtonState; },
    get TREE_MAX_CHILDREN() { return TREE_MAX_CHILDREN; },
    get updateBackendDirty() { return updateBackendDirty; },
    get updateCursorPosition() { return updateCursorPosition; },
    get updateSearchState() { return updateSearchState; },
    get updateTabDirty() { return updateTabDirty; },
    get updateWindowTitle() { return updateWindowTitle; },
    get updateWordCount() { return updateWordCount; },
    get updateWritingStats() { return updateWritingStats; },
    get viewLabel() { return viewLabel; },
    get viewOptionsFor() { return viewOptionsFor; },
    get workspaceFolder() { return workspaceFolder; },
});
const {activateDoc, addDocToFocusedGroup, applyAceMode, applyCsvTableZoom, applyImageZoom, browserViewportLabel, closeDocNow, closeDocsWithConfirm, closeSqlView, createDoc, createDocEditor, createGroup, dismissBanner, doRedo, doUndo, editorGroups, enterBinaryView, enterCsvTable, enterImageView, enterMarkdownPreview, enterSplitView, enterSqlView, enterSvgRender, enterTextView, exitSplitView, expandAllWithGuard, flushCsvCellEditor, focusedGroupId, groupDocs, groupOfDoc, handleAIWorkspaceFileChanged, handleExternalDocChanges, hideBanner, hideSvgRender, hookCodeFoldPreviews, hookMultiCursor, humanizeCounts, initCodeFoldHover, jumpBookmark, leaveCsvTable, leaveMarkdownPreview, markDocDirty, mdSyncScrollFromAce, moveTabInGroup, patchViewContext, refreshPatchMarkers, rememberDocView, renderBookmarks, renderBreadcrumb, renderCsvTableView, renderEditorLayout, renderMarkdownPreview, renderTabs, reopenClosedTab, requestCloseDoc, revertDocToSaved, scheduleGitGutter, setBrowserViewport, setFilename, showBanner, showImageMenu, showMdPreviewMenu, showPathInFolder, showSvgMenu, splitRoot, syncAllBrowserTabs, syncBrowserTab, textArea, toggleBookmark, toggleFocusedNode, updateAiWriteBadge, updateBrowserTitle, updateCodeFoldPreviews, updateDocChrome, updateStatus, zoomCsvTable, zoomImageBy, zoomSvgRenderBy} = editorGroupsMod;
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

const titlebarPopovers = createTitlebarPopovers({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get flash() { return flash; },
    get gitRootDir() { return gitRootDir; },
    get openFolderDialog() { return openFolderDialog; },
    get openFolderSmart() { return openFolderSmart; },
    get openNameDialog() { return openNameDialog; },
    get openVirtualDoc() { return openVirtualDoc; },
    get projectBadgeText() { return projectBadgeText; },
    get readRecentOpen() { return readRecentOpen; },
    get refreshGitStatus() { return refreshGitStatus; },
    get reloadAllFromDisk() { return reloadAllFromDisk; },
    get samePathValue() { return samePathValue; },
    get settings() { return settings; },
    get switchSidebarView() { return switchSidebarView; },
    get workspaceFolder() { return workspaceFolder; },
});
const {closeGitBranchPopover, gitPopNewBranch, gitPopOpenCommit, gitPopPush, gitPopUpdateProject, showBranchMenu, showProjectMenu} = titlebarPopovers;


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
    refreshStructureSources();
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

// 活动栏 ▶ 与工具菜单保持一致的可用状态（菜单是在打开时算的，按钮要随文件切换实时同步）
function syncRunButtonState() {
    if (!els.abRun) return;
    const supported = !!file && !file.binary && !file.large &&
        !!RECIPES[extOf(file.name || file.path)] && !settings.readOnlyMode;
    els.abRun.disabled = !supported;
    els.abRun.title = supported || !file ? '运行当前文件 (F5)'
        : settings.readOnlyMode ? '只读模式下不执行代码'
            : '当前文件不支持运行';
}

function initActivityBar() {
    syncRunButtonState();
    if (!els.activityBar) return;
    if (els.abFiles) els.abFiles.addEventListener('click', () => toggleSidebarView('files'));
    if (els.abStructure) els.abStructure.addEventListener('click', () => toggleSidebarView('structure'));
    if (els.abSearch) els.abSearch.addEventListener('click', () => {
        // 有可搜索视图开内容查找，否则退到全局搜索，保证图标总是有响应
        if (findTarget()) openFindBar();
        else openGlobalSearch();
    });
    if (els.abRun) els.abRun.addEventListener('click', () => runController.run());
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

// 运行面板「发给 AI 分析」：只预填输入框，发送与否由用户决定（不自动触发模型调用）
function openAIPanelWithDraft(text) {
    if (!aiPanel) initAIPanel();
    if (!aiPanel || !aiPanel.bridgeSetDraft) {
        flash('AI 面板不可用', true);
        return;
    }
    aiPanel.bridgeSetDraft(text);
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
        // 面板开合 / 显示方式 / 消息流变化：结构面板据此决定显示文件结构还是会话结构
        onPanelStateChange: () => refreshStructureSources(),
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
        onSessionJump: (index) => {
            if (aiPanel && typeof aiPanel.bridgeJumpToMessage === 'function') aiPanel.bridgeJumpToMessage(index);
        },
    });
    if (els.structureExport) {
        els.structureExport.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14M5.5 8.5h11.5M8 12.5h9M10.5 16.5h6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
        els.structureExport.addEventListener('click', () => showStructureExportMenu());
    }
    if (els.structureSource) {
        els.structureSource.innerHTML = iconSvg('file', 14);
        els.structureSource.addEventListener('click', toggleStructureSource);
    }
    // 会话结构模式下「刷新」要重新向 AI 面板取一次快照（面板内部的 refresh 只重渲染已有数据）
    if (els.structureRefresh) {
        els.structureRefresh.addEventListener('click', () => {
            if (structurePanel && structurePanel.getSource() === 'session') refreshStructureSources();
        });
    }
    structurePanel.setSource(settings.structureSource);
    structurePanel.setDoc(file);
    applySidebarUI();
    refreshStructureSources();
}

// ---- 结构面板的两个来源：文件结构 / 会话结构（用户消息定位条） ----
// 内容区只有文件            → 只显示文件结构
// 内容区只有 AI 助手        → 只显示当前会话的结构（全屏，或停靠且没打开文件时 AI 占满内容区）
// 两者都在                  → 默认文件结构，面板头部图标可在两者间切换（偏好存 settings）
function structureSources() {
    const aiOpen = !!(aiPanel && aiPanel.isOpen && aiPanel.isOpen());
    const aiMode = aiPanel && aiPanel.getMode ? aiPanel.getMode() : '';
    // 悬浮窗在另一个窗口里，本窗口内容区没有 AI，也就没有可定位的会话结构
    const aiVisible = aiOpen && aiMode !== 'float';
    const hasFile = !!file;
    const aiOnly = aiVisible && (aiMode === 'fullscreen' || !hasFile);
    return {file: hasFile && !aiOnly, session: aiVisible};
}

function structureOutlineSnapshot() {
    try {
        if (aiPanel && typeof aiPanel.bridgeSessionOutline === 'function') return aiPanel.bridgeSessionOutline();
    } catch (e) {}
    return null;
}

function syncStructureChrome(effective, sources) {
    const sessionMode = effective === 'session';
    if (els.structureTitle) els.structureTitle.textContent = sessionMode ? '会话结构' : '结构';
    if (els.structureSource) {
        const both = sources.file && sources.session;
        els.structureSource.classList.toggle('hidden', !both);
        els.structureSource.classList.toggle('active', sessionMode);
        els.structureSource.innerHTML = iconSvg(sessionMode ? 'feedback' : 'file', 14);
        els.structureSource.setAttribute('aria-pressed', String(sessionMode));
        els.structureSource.title = sessionMode
            ? '当前：会话结构（点击切到文件结构）'
            : '当前：文件结构（点击切到会话结构）';
    }
    // 复制/导出与「全部折叠」只对文件结构有意义
    if (els.structureExport) els.structureExport.classList.toggle('hidden', sessionMode);
    if (els.structureCollapse) els.structureCollapse.classList.toggle('hidden', sessionMode);
    if (els.structureRefresh) els.structureRefresh.title = sessionMode ? '刷新会话结构' : '刷新结构';
}

function refreshStructureSources() {
    if (!structurePanel) return '';
    const src = structureSources();
    const effective = structurePanel.setSources(src);
    structurePanel.setSessionOutline(src.session ? structureOutlineSnapshot() : null);
    syncStructureChrome(effective, src);
    return effective;
}

function toggleStructureSource() {
    if (!structurePanel) return;
    const next = structurePanel.getSource() === 'session' ? 'file' : 'session';
    settings.structureSource = next;
    try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch (e) {}
    const effective = structurePanel.setSource(next);
    syncStructureChrome(effective, structureSources());
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

const activityPane = createActivityPane({
    get activityLog() { return activityLog; },
    get applySettings() { return applySettings; },
    get backend() { return backend; },
    get elsSettings() { return elsSettings; },
    get flash() { return flash; },
    get openCloseConfirm() { return openCloseConfirm; },
    get settings() { return settings; },
});
const {renderActivityPane} = activityPane;
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

const menuBarMod = createMenuBar({
    get activityLog() { return activityLog; },
    get closeAllMenus() { return closeAllMenus; },
    get currentMode() { return currentMode; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get flushCsvCellEditor() { return flushCsvCellEditor; },
    get getFormatSettings() { return getFormatSettings; },
    get markDocDirty() { return markDocDirty; },
    get openMenu() { return openMenu; },
    get renderCsvTableView() { return renderCsvTableView; },
    get settings() { return settings; },
    get textArea() { return textArea; },
    get updateStatus() { return updateStatus; },
});
const {clickEditorButton, formatDocument, hideMenuBar, menuBar, menuKeyMap, openMenuByKind, openMenuEl, showMenuBar} = menuBarMod;
// switchMode 外壳负责操作留痕（view.switch）；实际切换在 applySwitchMode。
const modeSwitch = createModeSwitch({
    get activityLog() { return activityLog; },
    get applyAceMode() { return applyAceMode; },
    get applyReadOnlyToDoc() { return applyReadOnlyToDoc; },
    get closeSqlView() { return closeSqlView; },
    get currentMode() { return currentMode; },
    get dirty() { return dirty; },
    get editor() { return editor; },
    get enterBinaryView() { return enterBinaryView; },
    get enterCsvTable() { return enterCsvTable; },
    get enterImageView() { return enterImageView; },
    get enterMarkdownPreview() { return enterMarkdownPreview; },
    get enterSplitView() { return enterSplitView; },
    get enterSqlView() { return enterSqlView; },
    get enterSvgRender() { return enterSvgRender; },
    get enterTextView() { return enterTextView; },
    get exitSplitView() { return exitSplitView; },
    get file() { return file; },
    get flash() { return flash; },
    get hideSvgRender() { return hideSvgRender; },
    get hookCodeFoldPreviews() { return hookCodeFoldPreviews; },
    get hookMultiCursor() { return hookMultiCursor; },
    get isSvgDoc() { return isSvgDoc; },
    get leaveCsvTable() { return leaveCsvTable; },
    get leaveMarkdownPreview() { return leaveMarkdownPreview; },
    get patchViewContext() { return patchViewContext; },
    get refreshPatchMarkers() { return refreshPatchMarkers; },
    get scheduleGitGutter() { return scheduleGitGutter; },
    get updateCodeFoldPreviews() { return updateCodeFoldPreviews; },
    get updateSearchState() { return updateSearchState; },
    get updateStatus() { return updateStatus; },
});
const {switchMode} = modeSwitch;

const findBar = createFindBar({
    get currentMode() { return currentMode; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get groupOfDoc() { return groupOfDoc; },
});
const {closeFindBar, ensureFindBarHost, findState, findTarget, focusFindEditor, openFindBar, runFind} = findBar;
const globalSearch = createGlobalSearch({
    get activateDoc() { return activateDoc; },
    get backend() { return backend; },
    get currentMode() { return currentMode; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get focusFindEditor() { return focusFindEditor; },
    get openPaths() { return openPaths; },
    get switchMode() { return switchMode; },
    get waitUntil() { return waitUntil; },
    get workspaceFolder() { return workspaceFolder; },
});
const {openGlobalSearch} = globalSearch;
const jsonQuery = createJsonQuery({
    get copyText() { return copyText; },
    get docs() { return docs; },
    get file() { return file; },
    get flash() { return flash; },
    get selectLineInDoc() { return selectLineInDoc; },
    get structureTextForDoc() { return structureTextForDoc; },
});
const {jsonQuerySupported, openJsonQuery} = jsonQuery;
const diffDialog = createDiffDialog({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get copyText() { return copyText; },
    get docs() { return docs; },
    get editor() { return editor; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get samePathValue() { return samePathValue; },
});
const {openDiffDialog} = diffDialog;
const schemaPanel = createSchemaPanel({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get copyText() { return copyText; },
    get docs() { return docs; },
    get file() { return file; },
    get flash() { return flash; },
    get selectLineInDoc() { return selectLineInDoc; },
    get structureTextForDoc() { return structureTextForDoc; },
});
const {openSchemaValidation} = schemaPanel;
const quickSwitchMod = createQuickSwitch({
    get applyAceMode() { return applyAceMode; },
    get applySettings() { return applySettings; },
    get closeAllMenus() { return closeAllMenus; },
    get currentMode() { return currentMode; },
    get currentSidebarView() { return currentSidebarView; },
    get currentTheme() { return currentTheme; },
    get editor() { return editor; },
    get editorFonts() { return editorFonts; },
    get els() { return els; },
    get file() { return file; },
    get focusFindEditor() { return focusFindEditor; },
    get getFormatSettings() { return getFormatSettings; },
    get INDENTS() { return INDENTS; },
    get isDialogOpen() { return isDialogOpen; },
    get setSidebarMode() { return setSidebarMode; },
    get setTheme() { return setTheme; },
    get settings() { return settings; },
    get switchMode() { return switchMode; },
    get terminalUI() { return terminalUI; },
    get themes() { return themes; },
    get toggleAlwaysOnTop() { return toggleAlwaysOnTop; },
    get toggleCodeWrap() { return toggleCodeWrap; },
    get toggleSidebar() { return toggleSidebar; },
    get toggleSidebarView() { return toggleSidebarView; },
    get toggleTerminalPanel() { return toggleTerminalPanel; },
    get viewDisabled() { return viewDisabled; },
    get viewLabel() { return viewLabel; },
    get viewOptionsFor() { return viewOptionsFor; },
});
const {handleQuickSwitchKey, openQuickSwitch, quickSwitch, toggleQuickSwitch} = quickSwitchMod;
const appActions = createAppActions({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get explorer() { return explorer; },
    get flash() { return flash; },
    get openFolderSmart() { return openFolderSmart; },
    get openPath() { return openPath; },
    get rt() { return rt; },
});
const {copyExternalIntoDir, exitApp, getPendingExternalDrop, parentDirOf, readRecentOpen, recentOpenMenuItems, rememberRecentOpen, setPendingExternalDrop, setPendingExternalDropValue} = appActions;
const sessionRestore = createSessionRestore({
    get activateDoc() { return activateDoc; },
    get activityLog() { return activityLog; },
    get createGroup() { return createGroup; },
    get currentMode() { return currentMode; },
    get docs() { return docs; },
    get editorGroups() { return editorGroups; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get focusedGroupId() { return focusedGroupId; },
    get groupDocs() { return groupDocs; },
    get groupOfDoc() { return groupOfDoc; },
    get logFrontend() { return logFrontend; },
    get openFolderWorkspace() { return openFolderWorkspace; },
    get openPathsHere() { return openPathsHere; },
    get rememberDocView() { return rememberDocView; },
    get renderEditorLayout() { return renderEditorLayout; },
    get splitRoot() { return splitRoot; },
    get switchMode() { return switchMode; },
    get workspaceFolder() { return workspaceFolder; },
});
const {knownDocViews, pendingDocViews, readSession, readWorkspaceSession, restoreSession, saveSessionNow, scheduleSessionSave, sessionPathKey} = sessionRestore;
const propertiesUI = createPropertiesUI({
    get activateDoc() { return activateDoc; },
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get elsDialogs() { return elsDialogs; },
    get file() { return file; },
    get flash() { return flash; },
    get fmtSize() { return fmtSize; },
    get newDocumentWith() { return newDocumentWith; },
    get newFileTypeMenuItems() { return newFileTypeMenuItems; },
    get openCloseConfirm() { return openCloseConfirm; },
    get openCreateEntryDialog() { return openCreateEntryDialog; },
    get openDialogEl() { return openDialogEl; },
    get reloadActive() { return reloadActive; },
    get structureTextForDoc() { return structureTextForDoc; },
    get workspaceFolder() { return workspaceFolder; },
});
const {newDocumentMenuItems, propsTimeText, reloadAllFromDisk, showFileProperties} = propertiesUI;
const appLinks = createAppLinks({
    get activateDoc() { return activateDoc; },
    get backend() { return backend; },
    get docs() { return docs; },
    get flash() { return flash; },
    get logFrontend() { return logFrontend; },
    get openVirtualDoc() { return openVirtualDoc; },
    get rt() { return rt; },
});
const {appFeedbackUrl, appReleasesUrl, openBundledDoc, openDevTools, openExternalUrl, showChangelog, showPrivacy, showTerms} = appLinks;
const updateCheck = createUpdateCheck({
    get appReleasesUrl() { return appReleasesUrl; },
    get backend() { return backend; },
    get closeDialogs() { return closeDialogs; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get flash() { return flash; },
    get logFrontend() { return logFrontend; },
    get openDialogEl() { return openDialogEl; },
    get openExternalUrl() { return openExternalUrl; },
    get renderMarkdownHtml() { return renderMarkdownHtml; },
    get settings() { return settings; },
    get updateStatus() { return updateStatus; },
});
const {autoCheckUpdateOnStart, checkForUpdates} = updateCheck;
const formatConvert = createFormatConvert({
    get backend() { return backend; },
    get baseNameOf() { return baseNameOf; },
    get editor() { return editor; },
    get file() { return file; },
    get flash() { return flash; },
    get openPath() { return openPath; },
});
const {convertMenuItems, repairJsonAction} = formatConvert;

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
                {label: '终端面板', shortcut: 'Alt+F12', checked: terminalUI.open && getDockView() === 'terminal', action: () => toggleDockView('terminal')},
                ...(developerMode ? [{label: '调试控制台', shortcut: 'F12', checked: terminalUI.open && getDockView() === 'debug', action: () => toggleDockView('debug')}] : []),
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
                label: '运行当前文件',
                shortcut: 'F5',
                icon: 'E768',
                disabled: !file || !runController.isSupported({name: file.name, path: file.path}) || !!settings.readOnlyMode,
                action: () => runController.run(),
            }, {
                label: '停止运行',
                shortcut: 'Shift+F5',
                icon: 'E71A',
                disabled: !runController.hasRunning(),
                action: () => runController.stop(),
            }, {
                label: '运行面板',
                shortcut: 'Alt+F11',
                icon: 'E7B3',
                action: () => runController.togglePanel(),
            }, {
                label: '运行项目…',
                shortcut: 'Ctrl+F5',
                icon: 'E7B3',
                disabled: !file && !workspaceFolder,
                action: () => startRunProject(),
            }, {sep: true}, {
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
    if (!isDialogOpen() && e.key === 'F5' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) runController.stop();
        else runController.run();
        return;
    }
    if (!isDialogOpen() && e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'F5') {
        e.preventDefault();
        e.stopPropagation();
        startRunProject();
        return;
    }
    if (!isDialogOpen() && e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        toggleDockView('run');
        return;
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
            const pending = getPendingExternalDrop();
            if (pending && Date.now() - pending.at < 5000) {
                setPendingExternalDropValue(null);
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

const cursorThemes = createCursorThemes({
    get backend() { return backend; },
});
const {setDragCursor} = cursorThemes;
const terminalMod = createTerminalUI({
    get showGitFileHistory() { return showGitFileHistory; },
    get gitRollbackPaths() { return gitRollbackPaths; },
    get gitGroupCollapsed() { return gitGroupCollapsed; },
    get showGitRecentLog() { return showGitRecentLog; },
    get nextCmdSeq() { return nextCmdSeq; },
    get activityLog() { return activityLog; },
    get applySettings() { return applySettings; },
    get backend() { return backend; },
    get closeTopDialog() { return closeTopDialog; },
    get copyText() { return copyText; },
    get ctxMenu() { return ctxMenu; },
    get currentMode() { return currentMode; },
    get dirty() { return dirty; },
    get editor() { return editor; },
    get effectiveToolEnv() { return effectiveToolEnv; },
    get els() { return els; },
    get elsDialogs() { return elsDialogs; },
    get file() { return file; },
    get findDocByPath() { return findDocByPath; },
    get flash() { return flash; },
    get gitStateCache() { return gitStateCache; },
    get initAIPanel() { return initAIPanel; },
    get openAIPanelWithDraft() { return openAIPanelWithDraft; },
    get openCloseConfirm() { return openCloseConfirm; },
    get openDialogEl() { return openDialogEl; },
    get openNameDialog() { return openNameDialog; },
    get openPathsHere() { return openPathsHere; },
    get refreshGitStatus() { return refreshGitStatus; },
    get rt() { return rt; },
    get saveDoc() { return saveDoc; },
    get selectLineInDoc() { return selectLineInDoc; },
    get setDragCursor() { return setDragCursor; },
    get settings() { return settings; },
    get showGitDiff() { return showGitDiff; },
    get structurePanel() { return structurePanel; },
    get textArea() { return textArea; },
    get toolEnvFor() { return toolEnvFor; },
    get workspaceFolder() { return workspaceFolder; },
});
const {applyDockView, renderGitPanel, cmdExitHandlers, cmdOutHandlers, currentSidebarView, fitActiveTerm, runArgsText, runController, switchSidebarView, syncTerminalTheme, termCwd, terminalUI, toggleDockView, toggleSidebarView, toggleTerminalPanel, getDockView, setDockView, nextCmdSeq, nextMockBgSeq, nextMockSchedSeq, startRunProject} = terminalMod;
const bridgeUI = createBridgeUI({
    get activateDoc() { return activateDoc; },
    get activityLog() { return activityLog; },
    get addDocToFocusedGroup() { return addDocToFocusedGroup; },
    get aiPanel() { return aiPanel; },
    get applySettings() { return applySettings; },
    get autoCheckUpdateOnStart() { return autoCheckUpdateOnStart; },
    get backend() { return backend; },
    get closeDocNow() { return closeDocNow; },
    get consoleWindowMode() { return consoleWindowMode; },
    get copyText() { return copyText; },
    get createDoc() { return createDoc; },
    get currentSidebarView() { return currentSidebarView; },
    get dirty() { return dirty; },
    get docs() { return docs; },
    get editor() { return editor; },
    get els() { return els; },
    get file() { return file; },
    get flash() { return flash; },
    get hasWails() { return hasWails; },
    get initAIPanel() { return initAIPanel; },
    get initCodeFoldHover() { return initCodeFoldHover; },
    get logFrontend() { return logFrontend; },
    get mockScenario() { return mockScenario; },
    get openPaths() { return openPaths; },
    get openSettings() { return openSettings; },
    get openTargets() { return openTargets; },
    get readSession() { return readSession; },
    get readWorkspaceSession() { return readWorkspaceSession; },
    get refreshDeveloperMode() { return refreshDeveloperMode; },
    get refreshLogPath() { return refreshLogPath; },
    get renderGitPanel() { return renderGitPanel; },
    get renderTabs() { return renderTabs; },
    get renderWorkspaceCrumbs() { return renderWorkspaceCrumbs; },
    get restoreSession() { return restoreSession; },
    get scheduleGitGutter() { return scheduleGitGutter; },
    get sessionPathKey() { return sessionPathKey; },
    get settings() { return settings; },
    get startConsoleWindowMode() { return startConsoleWindowMode; },
    get switchSidebarView() { return switchSidebarView; },
    get syncBrowserTab() { return syncBrowserTab; },
    get syncedOpenMode() { return syncedOpenMode; },
    get updateBrowserTitle() { return updateBrowserTitle; },
    get workspaceFolder() { return workspaceFolder; },
});
const {createBgTermView, gitGroupCollapsed, gitRootDir, gitStateCache, notifyAIGitEntry, openBgTermTab, openBrowserTab, openVirtualDoc, refreshGitStatus, showGitDiff, showGitFileHistory, showGitRecentLog, gitRollbackPaths} = bridgeUI;
