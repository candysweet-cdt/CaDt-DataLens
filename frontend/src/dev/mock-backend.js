// dev/mock-backend.js：vite dev 浏览器调试用的 mock 后端（动态 import，不进生产包）。
// 模拟 Wails 桥（window.go.main.App）、窗口运行时（mockRt）与全部后端接口；
// mock 场景由 URL 参数驱动（?jsonl ?csv ?text ?image ?large ?invalid ?multi ?empty ?gbk ?ai* …）。
// 由 main.js 在 !hasWails 时动态加载；生产环境永不触碰本模块。
import {MOCK_DB_CONNECTIONS_KEY, MOCK_SAVE_KEY} from '../core/storage-keys.js';

const mockScenario = new URLSearchParams(location.search);

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

import (
import {legacyPathKey} from '../core/path-key.js';
\t"strings"
\t"testing"
\t"time"
)

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

func findGitBash() string {
    return "Git Bash"
}

func TestToolchainPriority(t *testing.T) {
    shell, exe := "Git Bash", "bash.exe"
    args := []string{"echo", "hi"}
    switch {
    case findGitBash() != "":
        if shell != "Git Bash" || !strings.Contains(strings.ToLower(exe), "bash") {
            t.Fatalf("应优先 Git Bash, 实际 %s (%s)", shell, exe)
        }
        if len(args) < 3 || args[len(args)-1] != "echo hi" {
            t.Fatalf("应优先 echo hi, 实际 %s (%d)", args, len(args))
        }
        time.Sleep(0)
    }
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

const mockDir = 'mock://samples/';

// AI 计时器 mock 的内存注册表（仅 dev 浏览器场景）
const mockTimerStore = new Map();
function mockTimerList() {
    return [...mockTimerStore.values()].map((info) => ({
        id: info.id, mode: info.mode, label: info.label, startMs: info.startMs, endMs: info.endMs,
    }));
}
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
// AI 群聊（ai-groups）：meta + 共享日志 + 各成员私有日志，纯内存
const mockAIGroups = new Map();
function mockAIGroupEnsure(id) {
    const key = String(id);
    let item = mockAIGroups.get(key);
    if (!item) {
        item = {meta: '{}', log: '', priv: {}};
        mockAIGroups.set(key, item);
    }
    return item;
}
let mockAIConfigText = '';
const dbCredentialMock = new Map(); // 插件数据库驱动的通用凭据（模拟 dpapi 表）
const mockDbSession = {tables: []}; // 演示会话内存状态：editable（DBOpen 的 allowEdit）、tables（建表表单/控制台新建的表）
// mockDbConnections / mockRedis：连接管理对话框落盘的演示连接 + Redis 键空间的内存 store
// （演示键覆盖五类型 + 中文前缀组，方案 §5.4 的键空间树/键查看器/控制台全流程浏览器实测用；
//  连接经 localStorage 持久化——模拟 Go 侧 db-connections.json，页面刷新后连接仍在）
function loadMockConnections() {
    try { return JSON.parse(localStorage.getItem(MOCK_DB_CONNECTIONS_KEY) || '[]'); } catch (e) { return []; }
}
function persistMockConnections(list) {
    try { localStorage.setItem(MOCK_DB_CONNECTIONS_KEY, JSON.stringify(list)); } catch (e) { /* 尽力而为：mock 存储失败不影响演示 */ }
}
const mockDbConnections = loadMockConnections();
const mockRedis = {
    editable: false,
    data: {
        'user:1001': {type: 'string', value: '张三的用户资料（演示 string）'},
        'user:1002': {type: 'hash', value: {name: '李四', age: '28', city: '上海'}},
        'user:1003': {type: 'string', value: '王五'},
        'config:debug': {type: 'string', value: '{"level":"info","traces":false}'},
        'queue:jobs': {type: 'list', value: ['job-1', 'job-2', 'job-3']},
        'tags:java': {type: 'set', value: ['ee', 'spring', 'jvm']},
        'leaderboard': {type: 'zset', value: [['alice', '98.5'], ['bob', '88'], ['carol', '77.5']]},
        'logs:2026': {type: 'stream', value: [['1-1', 'level', 'info'], ['1-2', 'level', 'warn'], ['1-3', 'level', 'error']]},
    },
    ttl: {'user:1001': 3600, 'config:debug': -1, 'leaderboard': -1},
};

// mockRedisEntry(key) → {name, type, ttl, length}（树摘要形状，对齐 Go RedisKeyEntry）
function mockRedisEntry(name) {
    const d = mockRedis.data[name];
    if (!d) return null;
    const ttl = mockRedis.ttl[name] != null ? mockRedis.ttl[name] : -1;
    const length = d.type === 'string' ? String(d.value).length
        : d.type === 'hash' ? Object.keys(d.value).length
        : d.type === 'list' || d.type === 'set' ? d.value.length
        : d.type === 'zset' ? d.value.length
        : d.value.length; // stream：条目数
    return {name, type: d.type, ttl, length};
}

// mockRedisApplyOps 结构化编辑的内存落地（对齐 Go redisOpCommands：setString 带 TTL 补偿）
function mockRedisApplyOps(ops) {
    const rows = [];
    for (const op of ops || []) {
        let result = 'OK';
        const key = op.Key || op.key;
        const field = op.Field || op.field;
        const value = op.Value != null ? op.Value : op.value;
        switch (op.kind) {
            case 'setString': {
                mockRedis.data[key] = {type: 'string', value: String(value)};
                // SET 清 TTL：原 TTL > 0 → EXPIRE 补回（-1 永久/0 无过期语义不补）
                if ((op.TTLSeconds || op.ttlSeconds || 0) > 0) {
                    mockRedis.ttl[key] = op.TTLSeconds || op.ttlSeconds;
                } else if (mockRedis.ttl[key] > 0) {
                    delete mockRedis.ttl[key];
                }
                break;
            }
            case 'setHashField':
                if (!mockRedis.data[key]) mockRedis.data[key] = {type: 'hash', value: {}};
                mockRedis.data[key].value[field] = String(value);
                break;
            case 'delHashField':
                if (mockRedis.data[key] && mockRedis.data[key].value) delete mockRedis.data[key].value[field];
                break;
            case 'setListItem': {
                const idx = Number(op.Index != null ? op.Index : op.index);
                if (mockRedis.data[key] && mockRedis.data[key].value[idx] !== undefined) {
                    mockRedis.data[key].value[idx] = String(value);
                } else {
                    result = '失败：index 越界（ERR index out of range）';
                }
                break;
            }
            case 'addSetMember':
                if (!mockRedis.data[key]) mockRedis.data[key] = {type: 'set', value: []};
                if (!mockRedis.data[key].value.includes(String(value))) mockRedis.data[key].value.push(String(value));
                break;
            case 'delSetMember': {
                const arr = mockRedis.data[key] && mockRedis.data[key].value || [];
                const at = arr.indexOf(String(value));
                if (at >= 0) arr.splice(at, 1);
                else result = '失败：成员不存在（ERR no such member）';
                break;
            }
            case 'addZSetMember': {
                const score = String(op.Score != null ? op.Score : op.score);
                if (!mockRedis.data[key]) mockRedis.data[key] = {type: 'zset', value: []};
                const list = mockRedis.data[key].value;
                const at = list.findIndex((m) => m[0] === String(value));
                if (at >= 0) list[at][1] = score;
                else list.push([String(value), score]);
                break;
            }
            case 'delZSetMember': {
                const list = mockRedis.data[key] && mockRedis.data[key].value || [];
                const at = list.findIndex((m) => m[0] === String(value));
                if (at >= 0) list.splice(at, 1);
                else result = '失败：成员不存在（ERR no such member）';
                break;
            }
            case 'setTTL': {
                const sec = Number(op.TTLSeconds != null ? op.TTLSeconds : op.ttlSeconds);
                if (sec < 0) mockRedis.ttl[key] = -1;
                else mockRedis.ttl[key] = sec;
                break;
            }
            case 'persist':
                mockRedis.ttl[key] = -1;
                break;
            case 'delKey':
                if (mockRedis.data[key]) {
                    delete mockRedis.data[key];
                    delete mockRedis.ttl[key];
                } else {
                    result = '失败：键不存在';
                }
                break;
            default:
                result = '失败：未知操作 ' + op.kind;
        }
        rows.push(['(' + op.kind + ') ' + key, result]);
    }
    return rows;
}

// 与 frontend/src/ai/tools/ai-file-tools.js / Go globMatchPath 同规则的简易通配（mock 专用，避免跨模块依赖）
function mockGlobMatch(pattern, relPath, name) {
    const pat = String(pattern || '').trim();
    if (!pat) return true;
    const subject = String(relPath || '').replace(/\\/g, '/');
    const target = pat.includes('/') ? subject : String(name || subject.split('/').pop() || '');
    const wildcard = pat.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000');
    let re = '';
    for (const ch of wildcard) {
        if (ch === '\u0001') re += '(?:.*/)?';
        else if (ch === '\u0000') re += '.*';
        else if (ch === '*') re += '[^/]*';
        else if (ch === '?') re += '[^/]';
        else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    try {
        return new RegExp('^' + re + '$', 'i').test(target);
    } catch (e) {
        return true;
    }
}

// mock 侧的 fzf 式子序列匹配：返回收紧后的最小窗口 [start, end)，无命中返回 [-1, -1]。
// 规则与 Go 侧 internal/search/fuzzy.go 对齐（正向贪婪 + 反向收紧、200 字符窗口上限）。
function mockFuzzyWindow(line, needle, caseSensitive) {
    if (!needle) return [-1, -1];
    const fold = (ch) => (caseSensitive ? ch : ch.toLowerCase());
    const want = Array.from(needle);
    const chars = Array.from(line);
    let hi = 0;
    for (const w of want) {
        let found = false;
        while (hi < chars.length) {
            const ch = chars[hi++];
            if (fold(ch) === fold(w)) { found = true; break; }
        }
        if (!found) return [-1, -1];
    }
    let lo = hi;
    for (let k = want.length - 1; k >= 0; k--) {
        let found = false;
        while (lo > 0) {
            const ch = chars[--lo];
            if (fold(ch) === fold(want[k])) { found = true; break; }
        }
        if (!found) return [-1, -1];
    }
    if (hi - lo > 200) return [-1, -1];
    return [lo, hi];
}

// 存储与清理的 mock 数据：字段与 Go 侧 internal/storage 的 Item / Tile / Report 一致，
// 清除后把对应条目清零，用来在浏览器里看排版、勾选与回执。
const MOCK_APP_ROOT = 'C:\\Users\\dev\\AppData\\Roaming\\CandySweet\\CaDt-DataLens';
const mockStorageItems = [
    {id: 'run-temp', label: '运行临时副本', note: '运行未保存内容时的临时副本与编译产物。', kind: 'cache', scope: 'app', inCache: true, path: MOCK_APP_ROOT + '\\run', bytes: 3 * 1024 * 1024, files: 42, entries: 6, exists: true},
    {id: 'browser-profiles', label: '内嵌浏览器实例数据', note: '每个浏览器标签一份 WebView2 配置，关掉标签不会自动回收。', kind: 'cache', scope: 'app', inCache: true, path: MOCK_APP_ROOT + '\\BrowserSessions', bytes: 1128 * 1024 * 1024, files: 88120, entries: 44, blocked: 1, exists: true},
    {id: 'webview-cache', label: '界面浏览器缓存', note: 'WebView2 自己的网络/代码/着色器缓存。', kind: 'cache', scope: 'webview', inCache: true, path: MOCK_APP_ROOT + '\\WebView2\\EBWebView', bytes: 152 * 1024 * 1024, files: 4210, entries: 6, pending: true, exists: true},
    {id: 'session-index', label: '会话搜索索引', note: 'AI 会话全文搜索的派生库，删后下次搜索重建。', kind: 'cache', scope: 'app', inCache: true, path: MOCK_APP_ROOT + '\\ai-index.db', bytes: 41 * 1024 * 1024, files: 3, entries: 0, exists: true},
    {id: 'app-logs', label: '运行日志', note: '每次启动一份的排障日志。', kind: 'cache', scope: 'app', inCache: true, path: MOCK_APP_ROOT + '\\logs', bytes: 1400 * 1024, files: 61, entries: 61, exists: true},
    {id: 'ai-logs', label: 'AI 对话导出', note: '每轮对话写出的 markdown 副本。', kind: 'cache', scope: 'app', inCache: true, path: MOCK_APP_ROOT + '\\ai-logs', bytes: 52 * 1024 * 1024, files: 318, entries: 0, exists: true},
    {id: 'temp-scratch', label: '系统临时文件', note: '%TEMP% 下本应用写的临时库与插件暂存。', kind: 'cache', scope: 'temp', inCache: true, path: 'C:\\Users\\dev\\AppData\\Local\\Temp', bytes: 720 * 1024, files: 12, entries: 12, exists: true},
    {id: 'ws-worklog', label: 'AI 工作日志（本工作区）', note: '.cadt/logs 下的工作日志索引与正文。', kind: 'cache', scope: 'workspace', inCache: true, path: '', bytes: 0, files: 0, entries: 0, exists: false},
    {id: 'ws-gen', label: '生图与视频产物', note: '.cadt/gen 里保存下来的生成图片与视频。', kind: 'data', scope: 'workspace', inCache: false, path: '', bytes: 0, files: 0, entries: 0, exists: false},
    {id: 'ws-scratch', label: '临时文件（本工作区）', note: '.cadt/scratch 里的临时文件，不进一键清缓存，删除走回收站。', kind: 'data', scope: 'workspace', inCache: false, path: '', bytes: 0, files: 0, entries: 0, exists: false},
    {id: 'ws-memory', label: '工作区 AI 记忆', note: '.cadt/memory 里的记忆与索引。', kind: 'danger', scope: 'workspace', inCache: false, path: '', bytes: 0, files: 0, entries: 0, exists: false},
    {id: 'ai-sessions', label: 'AI 会话记录', note: '所有会话的正文 JSONL 与附图，是唯一真源。', kind: 'danger', scope: 'app', inCache: false, path: MOCK_APP_ROOT + '\\ai-sessions', bytes: 60 * 1024 * 1024, files: 1204, entries: 0, exists: true},
    {id: 'ai-schedule', label: 'AI 定时任务', note: '定时任务定义与运行记录。', kind: 'danger', scope: 'app', inCache: false, path: MOCK_APP_ROOT + '\\ai-schedule.db', bytes: 184 * 1024, files: 3, entries: 0, exists: true},
    {id: 'activity', label: '操作记录', note: '按月的操作摘要 JSONL。', kind: 'data', scope: 'app', inCache: false, path: MOCK_APP_ROOT + '\\activity', bytes: 1500 * 1024, files: 3, entries: 0, exists: true},
    {id: 'classifier', label: '端侧分类器个性化', note: '命令审批分类器的样本与权重。', kind: 'data', scope: 'app', inCache: false, path: MOCK_APP_ROOT + '\\local-classifier', bytes: 48 * 1024, files: 2, entries: 0, exists: true},
    {id: 'ui-state', label: '界面状态（WebView2）', note: '界面设置的 localStorage、网页登录态与浏览历史。', kind: 'danger', scope: 'webview', inCache: false, path: MOCK_APP_ROOT + '\\WebView2', bytes: 222 * 1024 * 1024, files: 9800, entries: 0, exists: true},
    {id: 'app-config', label: '全部配置', note: 'config / ai-config / mcp / env-vars，删除即恢复出厂。', kind: 'danger', scope: 'app', inCache: false, path: MOCK_APP_ROOT + '\\config.json', bytes: 32 * 1024, files: 4, entries: 0, exists: true},
];

// 操作记录的 mock 数据：最新在前（与后端 Read 的「新→旧」口径一致），
// 覆盖有参数 / 长对象 / 短对象三种形态，供列表、展开区、复制、分页实测。
function mockActivityEntries() {
    const now = Date.now();
    const mk = (i, actor, action, target, detail) => ({
        v: 1,
        ts: now - i * 61 * 1000,
        actor,
        source: 'mock',
        action,
        target,
        seq: 1000 - i,
        ...(detail ? {detail} : {}),
    });
    return [
        mk(0, 'ai', 'ai.tool', 'read_file {"path":"internal/search/glob.go"}', {status: 'done', ms: 12}),
        mk(1, 'ai', 'ai.approve', 'grep -n "runDesktopInstall\\|setDesktop" docs/mcp-desktop/', {kind: 'command', rule: null}),
        mk(2, 'user', 'tab.switch', '操作记录'),
        mk(3, 'user', 'tab.close', '定时任务'),
        mk(4, 'user', 'file.open', 'D:\\Projects\\CaDt-DataLens\\docs\\reports\\incident-2026-11-18-workspace-wipe.md'),
        mk(5, 'system', 'app.start', ''),
        mk(6, 'ai', 'ai.session', '窄宽度操作记录布局问题', {op: 'create', scope: 'auto'}),
        mk(7, 'user', 'settings.change', 'activity.retentionMonths', {from: 12, to: 24}),
        mk(8, 'user', 'view.mode', '操作记录'),
        mk(9, 'ai', 'ai.tool', 'run_command {"command":"npm run build"}', {status: 'done', ms: 6540}),
    ];
}

function buildMockStorageReport(workspaceRoot) {
    const items = mockStorageItems.map((item) => ({...item}));
    if (workspaceRoot) {
        const apply = (id, sub, bytes, files) => {
            const item = items.find((row) => row.id === id);
            if (item) Object.assign(item, {path: workspaceRoot + '\\.cadt\\' + sub, bytes, files, entries: 0, exists: bytes > 0});
        };
        apply('ws-worklog', 'logs', 29 * 1024, 9);
        apply('ws-gen', 'gen', 2200 * 1024, 24);
        apply('ws-memory', 'memory', 48 * 1024, 3);
    }
    const tile = (scope, label, path, bytes, files, otherBytes) => ({scope, label, path, bytes, files, otherBytes, otherFiles: otherBytes ? 3 : 0, available: bytes > 0});
    const sum = (scope) => items.filter((item) => (item.scope === 'webview' ? 'app' : item.scope) === scope)
        .reduce((acc, item) => acc + item.bytes, 0);
    const sumFiles = (scope) => items.filter((item) => (item.scope === 'webview' ? 'app' : item.scope) === scope)
        .reduce((acc, item) => acc + item.files, 0);
    const tiles = [
        tile('app', '应用数据目录', MOCK_APP_ROOT, sum('app'), sumFiles('app'), 4 * 1024 * 1024),
        tile('workspace', '工作区 .cadt', workspaceRoot ? workspaceRoot + '\\.cadt' : '', sum('workspace'), sumFiles('workspace'), workspaceRoot ? 1024 : 0),
        tile('temp', '系统临时目录', 'C:\\Users\\dev\\AppData\\Local\\Temp', sum('temp'), sumFiles('temp'), 0),
    ];
    return {
        items,
        tiles,
        cacheBytes: items.filter((item) => item.inCache).reduce((a, b) => a + b.bytes, 0),
        dataBytes: items.filter((item) => !item.inCache).reduce((a, b) => a + b.bytes, 0),
        truncated: false,
        workspaceSet: !!workspaceRoot,
        pending: items.filter((item) => item.pending).map((item) => item.id),
        scannedAt: Date.now(),
    };
}

function applyMockStorageClear(ids, workspaceRoot) {
    const report = {results: [], freed: 0, succeeded: 0, scheduled: [], skipped: [], failed: []};
    for (const id of ids || []) {
        const item = mockStorageItems.find((row) => row.id === id);
        if (!item) {
            report.failed.push(id);
            continue;
        }
        const scheduled = item.scope === 'webview';
        const freed = Number(item.bytes) || 0;
        if (scheduled) item.pending = true;
        else Object.assign(item, {bytes: 0, files: 0, entries: 0, blocked: 0, exists: false});
        const result = {id, label: item.label, freed: scheduled ? 0 : freed, entries: scheduled ? 0 : 1, blocked: 0, skipped: 0, remaining: 0, scheduled, reason: ''};
        report.results.push(result);
        report.freed += result.freed;
        if (scheduled) report.scheduled.push(item.label);
        else report.succeeded += 1;
    }
    return report;
}

// 显式 shell → 展示名（与 Go 侧 aiShellInvocation 的 shellName 对齐；空串 = 自动档）
function mockShellLabel(shell) {
    switch (String(shell || '').trim().toLowerCase()) {
        case 'gitbash':
        case 'bash':
            return 'Git Bash';
        case 'pwsh':
            return 'PowerShell 7';
        case 'powershell':
            return 'Windows PowerShell';
        case 'cmd':
        case 'cmd.exe':
            return 'Command Prompt';
        default:
            return '';
    }
}

// mockUsageStats 生成一份稳定的演示快照（模块级缓存，多次打开面板数字不跳）。
let mockUsageCache = null;
function mockUsageStats() {
    if (mockUsageCache) return mockUsageCache;
    const now = new Date();
    const HEAT_DAYS = 120;
    const heatDays = [];
    const dailyModelUsage = [];
    const modelTotals = new Map();
    const pad = (v) => String(v).padStart(2, '0');
    for (let i = HEAT_DAYS - 1; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
        const wave = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.63));
        const idle = i % 6 === 5 ? 0.15 : 1;
        const total = Math.round((4000 + 160000 * wave) * idle);
        const fast = Math.round(total * 0.62);
        const smart = total - fast;
        const requests = total > 0 ? 2 + (i % 7) : 0;
        heatDays.push({date: key, tokens: total, requests});
        dailyModelUsage.push({
            date: key,
            models: total > 0
                ? [{model: 'deepseek-chat', tokens: fast}, {model: 'claude-sonnet', tokens: smart}]
                : [],
        });
        modelTotals.set('deepseek-chat', (modelTotals.get('deepseek-chat') || 0) + fast);
        modelTotals.set('claude-sonnet', (modelTotals.get('claude-sonnet') || 0) + smart);
    }
    const totalTokens = heatDays.reduce((sum, day) => sum + day.tokens, 0);
    const activeDays = heatDays.filter((day) => day.tokens > 0).length;
    const peak = heatDays.reduce((best, day) => (day.tokens > best.tokens ? day : best), {date: '', tokens: 0});
    const modelList = [...modelTotals.entries()]
        .filter(([, tokens]) => tokens > 0)
        .map(([model, tokens]) => ({
            model, tokens,
            inputTokens: Math.round(tokens * 0.72),
            outputTokens: tokens - Math.round(tokens * 0.72),
            requests: Math.max(1, Math.round(tokens / 900)),
            share: totalTokens > 0 ? tokens / totalTokens : 0,
        }))
        .sort((a, b) => b.tokens - a.tokens);
    const snapshot = {
        generatedAt: Date.now(),
        range: '30d',
        summary: {
            totalTokens,
            peakDayTokens: peak.tokens,
            peakDay: peak.date,
            longestSessionMs: 2 * 3600_000 + 13 * 60_000,
            currentStreakDays: 4,
            longestStreakDays: 9,
            activeDays,
            totalSessions: 23,
            totalRequests: heatDays.reduce((sum, day) => sum + day.requests, 0),
            firstDay: heatDays[0].date,
            lastDay: heatDays[heatDays.length - 1].date,
        },
        heatmap: {
            startDate: heatDays[0].date,
            endDate: heatDays[heatDays.length - 1].date,
            maxTokens: peak.tokens,
            days: heatDays,
        },
        dailyModelUsage,
        models: modelList,
    };
    mockUsageCache = {snapshot};
    return mockUsageCache;
}

// mockUsageRequests 请求日志演示数据：确定性生成 137 条，覆盖分页/缓存/速度/首字。
let mockUsageRequestsCache = null;
function mockUsageRequests() {
    if (mockUsageRequestsCache) return mockUsageRequestsCache;
    const now = Date.now();
    const models = [
        {model: 'deepseek-chat', account: 'DeepSeek 官方'},
        {model: 'claude-sonnet', account: 'Anthropic 主账号'},
        {model: 'gpt-5.2', account: 'OpenAI 备用'},
    ];
    const rows = [];
    for (let i = 0; i < 137; i++) {
        const base = models[i % models.length];
        const prompt = 800 + ((i * 137) % 12000);
        const cached = Math.min(prompt, Math.round(prompt * (0.35 + ((i % 6) * 0.1))));
        const cacheWrite = i % 3 === 0 ? Math.round(prompt * 0.05) : 0;
        const ttft = 300 + ((i * 211) % 2400);
        rows.push({
            ts: now - i * 7 * 60 * 1000,
            model: base.model,
            modelAccount: base.account,
            promptTokens: prompt,
            completionTokens: 80 + ((i * 53) % 900),
            cachedTokens: cached,
            cacheWriteTokens: cacheWrite,
            modelMs: ttft + 1200 + ((i * 317) % 6000),
            ttftMs: ttft,
            statusCode: 200,
        });
    }
    mockUsageRequestsCache = rows;
    return rows;
}

const mockBackend = {
    async AIConfigRead() {
        return mockAIConfigText;
    },
    async AIConfigWrite(data) {
        mockAIConfigText = String(data || '');
        return null;
    },
    // 比较-交换写：dev 模式下也要能复现「另一窗口改过配置」的冲突路径。
    async AIConfigWriteIfUnchanged(base, data) {
        const current = String(mockAIConfigText || '');
        if (current !== String(base == null ? '' : base)) {
            return {written: false, current};
        }
        mockAIConfigText = String(data || '');
        return {written: true, current: ''};
    },
    // 使用统计 mock：确定性生成的 30 天演示数据（只走面板渲染链路）
    async AIUsageStatsRecord() {
        return '';
    },
    async AIUsageStatsSync() {
        return '';
    },
    async AIUsageStatsSnapshot(rangeKey) {
        const {snapshot} = mockUsageStats();
        const days = rangeKey === '7d' ? 7 : 30;
        const dailyModelUsage = snapshot.dailyModelUsage.slice(-days);
        // 与 Go 侧一致：summary/heatmap 恒为全量，models 按窗口重算
        const totals = new Map();
        for (const row of dailyModelUsage) {
            for (const item of row.models || []) {
                totals.set(item.model, (totals.get(item.model) || 0) + item.tokens);
            }
        }
        const rangeTotal = [...totals.values()].reduce((sum, value) => sum + value, 0);
        const models = [...totals.entries()]
            .map(([model, tokens]) => ({
                model, tokens,
                inputTokens: Math.round(tokens * 0.72),
                outputTokens: tokens - Math.round(tokens * 0.72),
                requests: Math.max(1, Math.round(tokens / 900)),
                share: rangeTotal ? tokens / rangeTotal : 0,
            }))
            .sort((a, b) => b.tokens - a.tokens);
        return {
            ...snapshot,
            range: rangeKey === '7d' ? '7d' : '30d',
            generatedAt: Date.now(),
            dailyModelUsage,
            models,
        };
    },
    async AIUsageStatsRequests(offset, limit) {
        const rows = mockUsageRequests();
        const start = Math.max(0, Number(offset) || 0);
        const size = Math.max(1, Math.min(200, Number(limit) || 10));
        return {items: rows.slice(start, start + size), total: rows.length, offset: start, limit: size};
    },
    // 官方白名单引擎 mock：回两条示意余额（dev 调试只看渲染链路）
    async AIUsageQuery() {
        return {
            supported: true,
            provider: 'Mock',
            items: [
                {label: '总额余额（USD）', value: '18.00'},
                {label: '账户可用', value: '是'},
            ],
        };
    },
    // 通用 OAuth 额度 mock：未登录态 + 一份模拟 pool-usage 响应（SenseNova 预设 extractor 可解析）
    async AIOAuthQuotaProviders() {
        return [{id: 'sensenova', name: 'SenseNova'}];
    },
    async AIOAuthQuotaLogin(providerID, username) {
        return {ok: true, username: String(username || 'mock'), expiresAt: Math.floor(Date.now() / 1000) + 10800};
    },
    async AIOAuthQuotaStatus() {
        return {loggedIn: false};
    },
    async AIOAuthQuotaLogout() {
        return '';
    },
    async AIOAuthQuotaFetch() {
        return {
            status: 200, contentType: 'application/json', bytes: 120, truncated: false,
            body: JSON.stringify({plan: {name: 'Mock Plan'}, pools: [{
                id: 'mock', name: 'Mock 池', window_5h: {limit: '1000000', used: '340000', remaining: '660000', reset_at: ''},
                window_7d: {limit: '5000000', used: '1200000', remaining: '3800000', reset_at: ''},
                grant_balance: '500',
            }]}),
        };
    },
    // 脚本额度查询哑通道 mock：回 200 + 通用 balance 形态（通用模板 extractor 可直接解析）
    async AIUsageHTTPRequest(specJSON) {
        let url = '';
        try {
            url = String((JSON.parse(String(specJSON || '{}')) || {}).url || '');
        } catch (_) { /* 规格坏就当空 URL，走下方错误回包 */ }
        return {
            status: url.startsWith('http') ? 200 : 400,
            contentType: 'application/json',
            body: JSON.stringify({is_active: true, balance: 42.5, planName: 'mock plan'}),
            bytes: 64,
            truncated: false,
        };
    },
    async AISessionStoreRoot() {
        return 'mock://appdata/CandySweet/CaDt-DataLens/ai-sessions';
    },
    async AISessionList() {
        return Array.from(mockAISessions.values()).map((item) => item.meta);
    },
    async AISessionPath(id) {
        const item = mockAISessions.get(String(id));
        if (!item) throw new Error('session-gone: 会话已被删除');
        return 'C:\\mock\\ai-sessions\\_unbound\\' + String(id) + '\\session.v1.jsonl';
    },
    async AISessionRead(id) {
        const item = mockAISessions.get(String(id));
        // window.__mockSessionTooLarge = true 可模拟超限会话（S2「打开即自动整理」链路的 dev 联调）。
        if (window.__mockSessionTooLarge) {
            throw new Error('session-too-large: 会话正文 300 MB，超过 256 MB 上限（打开时将自动整理归档）');
        }
        return item ? item.log : '';
    },
    async AISessionAppend(id, lines, allowCreate) {
        const key = String(id);
        const existing = mockAISessions.get(key);
        if (!existing && allowCreate === false) throw new Error('session-gone: 会话已被删除');
        const item = existing || {meta: '{}', log: ''};
        item.log += lines;
        item.mtimeMs = Date.now();
        item.bytes = item.log.length;
        item.mtimeMs = Date.now();
        item.bytes = item.log.length;
        mockAISessions.set(key, item);
        return null;
    },
    async AISessionRewrite(id, content) {
        const key = String(id);
        const item = mockAISessions.get(key) || {meta: '{}', log: ''};
        item.log = content;
        item.mtimeMs = Date.now();
        item.bytes = item.log.length;
        item.mtimeMs = Date.now();
        item.bytes = item.log.length;
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
    async AISessionStat(id) {
        const item = mockAISessions.get(String(id));
        if (!item) return {exists: false, mtimeMs: 0, size: 0};
        const stat = {exists: true, mtimeMs: Number(item.mtimeMs) || 0, size: Number(item.bytes) || 0};
        if (item.archive) {
            stat.archiveExists = true;
            stat.archiveSize = item.archive.length;
        }
        return stat;
    },
    // mock：会话回合租约。window.__mockSessionLeaseBusy=true 可模拟另一窗口正在跑。
    async AISessionLeaseAcquire(id, purpose, label, timeoutMs) {
        const key = String(id);
        if (window.__mockSessionLeaseBusy) {
            return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}, stat: await this.AISessionStat(key)};
        }
        window.__mockSessionLeases = window.__mockSessionLeases || {};
        window.__mockSessionLeases[key] = (window.__mockSessionLeases[key] || 0) + 1;
        return {
            acquired: true,
            busy: false,
            owner: {pid: 1, label: String(label || 'mock')},
            stat: await this.AISessionStat(key),
        };
    },
    async AISessionLeaseRelease(id) {
        const key = String(id);
        const leases = window.__mockSessionLeases = window.__mockSessionLeases || {};
        if (leases[key] > 0) leases[key]--;
        return null;
    },
    async AISessionLeaseStatus(id) {
        const key = String(id);
        const leases = window.__mockSessionLeases = window.__mockSessionLeases || {};
        if (leases[key] > 0) {
            return {acquired: true, busy: false, owner: {pid: 1, label: 'mock'}, stat: await this.AISessionStat(key)};
        }
        if (window.__mockSessionLeaseBusy) {
            return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}, stat: await this.AISessionStat(key)};
        }
        return {acquired: false, busy: false, stat: await this.AISessionStat(key)};
    },
    async AISessionStat(id) {
        const item = mockAISessions.get(String(id));
        if (!item) return {exists: false, mtimeMs: 0, size: 0};
        const stat = {exists: true, mtimeMs: Number(item.mtimeMs) || 0, size: Number(item.bytes) || 0};
        if (item.archive) {
            stat.archiveExists = true;
            stat.archiveSize = item.archive.length;
        }
        return stat;
    },
    // mock：会话回合租约。window.__mockSessionLeaseBusy=true 可模拟另一窗口正在跑。
    async AISessionLeaseAcquire(id, purpose, label, timeoutMs) {
        const key = String(id);
        if (window.__mockSessionLeaseBusy) {
            return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}, stat: await this.AISessionStat(key)};
        }
        window.__mockSessionLeases = window.__mockSessionLeases || {};
        window.__mockSessionLeases[key] = (window.__mockSessionLeases[key] || 0) + 1;
        return {
            acquired: true,
            busy: false,
            owner: {pid: 1, label: String(label || 'mock')},
            stat: await this.AISessionStat(key),
        };
    },
    async AISessionLeaseRelease(id) {
        const key = String(id);
        const leases = window.__mockSessionLeases = window.__mockSessionLeases || {};
        if (leases[key] > 0) leases[key]--;
        return null;
    },
    async AISessionLeaseStatus(id) {
        const key = String(id);
        const leases = window.__mockSessionLeases = window.__mockSessionLeases || {};
        if (leases[key] > 0) {
            return {acquired: true, busy: false, owner: {pid: 1, label: 'mock'}, stat: await this.AISessionStat(key)};
        }
        if (window.__mockSessionLeaseBusy) {
            return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}, stat: await this.AISessionStat(key)};
        }
        return {acquired: false, busy: false, stat: await this.AISessionStat(key)};
    },
    async AISessionSaveImage(id, name, dataURL, workspace) {
        mockAISessionImages.set(String(id) + '/' + name, dataURL);
        return 'images/' + name;
    },
    async AISessionReadImage(id, name) {
        return mockAISessionImages.get(String(id) + '/' + name) || '';
    },
    async AISessionSaveVideo(id, name, dataURL, workspace) {
        mockAISessionImages.set(String(id) + '/videos/' + name, dataURL);
        return 'videos/' + name;
    },
    async AISessionReadVideo(id, name) {
        return mockAISessionImages.get(String(id) + '/videos/' + name) || '';
    },
    async AISessionDelete(id) {
        mockAISessions.delete(String(id));
        return null;
    },
    async AISessionDeleteAll() {
        mockAISessions.clear();
        return null;
    },
    // —— 会话数据整形 mock（vacuum / 侧车读回 / 临时加载 / 侧车清理，随 Go 绑定同名）——
    // dev mock 的极简重放：只认 msg（含 a:1）/ truncate / archive / reset / meta.summary，
    // 坏行按 issues 计数跳过。dedupeKey 折叠与 torn 细节不在 dev 演示范围。
    __mockVacuumPlan(log) {
        const lines = log.split('\n');
        const live = [];
        const archived = [];
        let summary = null;
        let issues = 0;
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            let event = null;
            try { event = JSON.parse(line); } catch (e) { issues++; continue; }
            if (!event || typeof event !== 'object' || (Number(event.v) || 0) > 1) { issues++; continue; }
            if (event.t === 'msg' && event.m && typeof event.m === 'object') {
                const message = Object.assign({}, event.m, {_mid: String(event.mid == null ? '' : event.mid)});
                (event.a ? archived : live).push(message);
            } else if (event.t === 'truncate') {
                live.length = Math.max(0, Math.min(live.length, Number(event.keep) || 0));
            } else if (event.t === 'archive') {
                const keep = Math.max(0, Math.min(live.length, Number(event.keep) || 0));
                archived.push(...live.slice(0, keep));
                // 语义对齐 replaySessionLog：移走 [0,keep)，保留尾部 slice(keep)。
                live.splice(0, keep);
                if (event.summary && typeof event.summary === 'object') summary = event.summary;
            } else if (event.t === 'reset') {
                live.length = 0;
                archived.length = 0;
                summary = null;
            } else if (event.t === 'meta' && event.patch && typeof event.patch === 'object' &&
                Object.prototype.hasOwnProperty.call(event.patch, 'summary')) {
                summary = (event.patch.summary && typeof event.patch.summary === 'object') ? event.patch.summary : null;
            }
        }
        return {live, archived, summary, issues};
    },
    async AISessionVacuum(id, force) {
        const key = String(id);
        const item = mockAISessions.get(key);
        const before = item ? item.log.length : 0;
        const result = {
            skipped: false, changed: false, movedArchived: 0, liveKept: 0, droppedTransient: 0,
            issues: 0, torn: false, beforeBytes: before, afterBytes: before,
            sidecarLines: 0, sidecarAppendedLines: 0, liveDominant: false,
        };
        if (!item) { result.skipped = true; return result; }
        const plan = this.__mockVacuumPlan(item.log);
        result.issues = plan.issues;
        if (!plan.archived.length) {
            result.skipped = true;
            result.liveDominant = before > 256 * 1024 * 1024;
            return result;
        }
        const header = item.log.split('\n').find((line) => line.includes('"t":"header"')) || '';
        const out = [header];
        if (plan.summary) out.push(JSON.stringify({v: 1, t: 'meta', patch: {summary: plan.summary}}));
        const stripMid = (message) => {
            const copy = Object.assign({}, message);
            delete copy._mid;
            return copy;
        };
        for (const message of plan.live) {
            out.push(JSON.stringify({v: 1, t: 'msg', mid: message._mid, m: stripMid(message)}));
        }
        const sidecarLines = plan.archived.map((message) => JSON.stringify({v: 1, t: 'msg', mid: message._mid, a: 1, m: stripMid(message)}));
        item.archive = (item.archive || '') + sidecarLines.join('\n') + '\n';
        item.log = out.filter(Boolean).join('\n') + '\n';
        item.mtimeMs = Date.now();
        item.bytes = item.log.length;
        result.changed = true;
        result.movedArchived = plan.archived.length;
        result.liveKept = plan.live.length;
        result.beforeBytes = before;
        result.afterBytes = item.log.length;
        result.sidecarAppendedLines = sidecarLines.length;
        result.sidecarLines = item.archive.split('\n').filter((line) => line.trim()).length;
        result.liveDominant = result.afterBytes > 256 * 1024 * 1024;
        return result;
    },
    async AISessionReadArchive(id, offset, limit) {
        const item = mockAISessions.get(String(id));
        const lines = (item && item.archive ? item.archive.split('\n') : []).filter((line) => line.trim());
        const total = lines.length;
        const start = Math.max(0, Math.min(total, Math.max(0, Math.round(Number(offset) || 0))));
        const count = Math.max(0, Math.round(Number(limit) || 0));
        return {total, offset: start, events: lines.slice(start, start + count)};
    },
    async AISessionReadForce(id) {
        const item = mockAISessions.get(String(id));
        return item ? item.log : '';
    },
    async AISessionArchiveClear(id) {
        const item = mockAISessions.get(String(id));
        if (item) item.archive = '';
        return null;
    },
    // AI 群聊存储（ai-groups，与 Go groupstore 同形）
    async AIGroupList() {
        return Array.from(mockAIGroups.values()).map((item) => item.meta);
    },
    async AIGroupRead(id) {
        const item = mockAIGroups.get(String(id));
        return item ? item.log : '';
    },
    async AIGroupAppend(id, lines) {
        const item = mockAIGroupEnsure(id);
        item.log += lines.endsWith('\n') ? lines : lines + '\n';
        return null;
    },
    async AIGroupRewrite(id, content) {
        const item = mockAIGroupEnsure(id);
        item.log = content;
        return null;
    },
    async AIGroupWriteMeta(id, data) {
        const item = mockAIGroupEnsure(id);
        item.meta = data;
        return null;
    },
    async AIGroupDelete(id) {
        mockAIGroups.delete(String(id));
        return null;
    },
    async AIGroupDeleteAll() {
        mockAIGroups.clear();
        return null;
    },
    async AIGroupPrivateRead(groupId, agentId) {
        const item = mockAIGroups.get(String(groupId));
        return item && item.priv[String(agentId)] ? item.priv[String(agentId)] : '';
    },
    async AIGroupPrivateAppend(groupId, agentId, lines) {
        const item = mockAIGroupEnsure(groupId);
        const key = String(agentId);
        item.priv[key] = (item.priv[key] || '') + (lines.endsWith('\n') ? lines : lines + '\n');
        return null;
    },
    async AIGroupPrivateRewrite(groupId, agentId, content) {
        const item = mockAIGroupEnsure(groupId);
        item.priv[String(agentId)] = content;
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
    async GetStartupMemoLocator() { return window.__mockStartupMemoLocator || ''; },
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
    // ---- 数据库连接页（internal/dbclient 的同名绑定；dev 下返回静态演示数据）----
    // mockDbSession：演示会话的内存状态（SQLite 打开时的 allowEdit 决定 Describe 的 editable）
    async DBOpen(path, allowEdit) {
        mockDbSession.editable = !!allowEdit;
        return {id: 'mock-db-sqlite', kind: 'sqlite', name: '演示.db', editable: !!allowEdit, immutable: false};
    },
    async DBReadImportFile(path) {
        const w = (window.__mockWrites || {})[String(path || '')];
        if (w != null) return w;
        throw new Error('mock 场景没有该文件的内容（先导出再导入可闭环）');
    },
    async DBCreateSQLite(path) {
        mockDbSession.created = String(path || '');
        return null;
    },
    async DBConnect(connectionID) {
        // 演示连接管理里保存的 Redis 连接 → redis 会话（键空间树/键查看器/控制台全流程）
        const cfg = mockDbConnections.find((c) => c.id === connectionID);
        if (cfg && cfg.kind === 'redis') {
            mockRedis.editable = !!cfg.allowEdit;
            return {
                id: 'mock-db-redis', kind: 'redis', name: cfg.name || '演示 Redis',
                server: (cfg.host || '127.0.0.1') + ':' + (cfg.port || 6379),
                database: 'db' + (Number(cfg.database) || 0), editable: !!cfg.allowEdit,
            };
        }
        return {id: 'mock-db-mysql', kind: 'mysql', name: '演示 MySQL', server: '127.0.0.1:3306', database: 'demo', editable: false};
    },
    // ---------- Redis 键空间（方案 §11.13；演示 store 在 mockRedis） ----------
    async DBRedisScan(id, database, pattern, cursor, count) {
        const p = String(pattern || '').replace(/\*/g, '');
        let names = Object.keys(mockRedis.data);
        if (p) names = names.filter((n) => n.startsWith(p) || (!p.endsWith(':') && n.includes(p)));
        names.sort();
        const total = names.length;
        const start = Number(cursor) || 0;
        const batch = names.slice(start, start + Math.max(Number(count) || 250, 1));
        const next = start + batch.length;
        return {cursor: next < total ? next : 0, keys: batch.map(mockRedisEntry).filter(Boolean)};
    },
    async DBRedisFetchValue(id, database, key) {
        const d = mockRedis.data[String(key || '')];
        if (!d) return {type: 'none', ttl: -2, length: 0, isBinary: false, text: '', hexText: '', columns: [], rows: [], nulls: [], truncated: false, message: '键不存在（可能已被删除）'};
        const ttl = mockRedis.ttl[String(key)] != null ? mockRedis.ttl[String(key)] : -1;
        const base = {type: d.type, ttl, isBinary: false, text: '', hexText: '', truncated: false, message: ''};
        switch (d.type) {
            case 'string': {
                const bytes = new TextEncoder().encode(String(d.value));
                const hex = [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                return Object.assign(base, {length: bytes.length, text: String(d.value), hexText: hex});
            }
            case 'hash':
                return Object.assign(base, {
                    length: Object.keys(d.value).length, columns: ['field', 'value'],
                    rows: Object.entries(d.value).map(([f, v]) => [f, String(v)]),
                    nulls: Object.keys(d.value).map(() => [false, false]),
                });
            case 'list':
                return Object.assign(base, {
                    length: d.value.length, columns: ['index', 'value'],
                    rows: d.value.map((x, i) => [String(i), String(x)]),
                    nulls: d.value.map(() => [false, false]),
                });
            case 'set':
                return Object.assign(base, {
                    length: d.value.length, columns: ['member'],
                    rows: d.value.map((x) => [String(x)]), nulls: d.value.map(() => [false]),
                });
            case 'zset':
                return Object.assign(base, {
                    length: d.value.length, columns: ['member', 'score'],
                    rows: d.value.map(([m, s]) => [String(m), String(s)]),
                    nulls: d.value.map(() => [false, false]),
                });
            case 'stream':
                return Object.assign(base, {
                    length: d.value.length, columns: ['id', 'field', 'value'],
                    rows: d.value.map(([sid, f, v]) => [String(sid), String(f), String(v)]),
                    nulls: d.value.map(() => [false, false, false]),
                });
            default:
                return Object.assign(base, {length: 0, message: '该类型请用查询控制台查看'});
        }
    },
    async DBRedisApply(id, ops) {
        const rows = mockRedisApplyOps(ops);
        return {columns: ['操作', '结果'], rows, nulls: rows.map(() => [false, false]), truncated: false, elapsedMs: 1, message: '已执行 ' + rows.length + ' 条操作'};
    },
    async DBRedisDeleteByPrefix(id, database, prefix) {
        const p = String(prefix || '').replace(/\*/g, '');
        let deleted = 0;
        for (const name of Object.keys(mockRedis.data)) {
            if (name.startsWith(p)) {
                delete mockRedis.data[name];
                delete mockRedis.ttl[name];
                deleted++;
            }
        }
        return {deleted};
    },
    async DBListDatabases(id) {
        // Redis 会话返回连接绑定的库（对齐 Go listDatabasesMeta 的 redis 分支）
        if (id === 'mock-db-redis') return ['db0'];
        return ['main'];
    },
    async DBListObjects() {
        const base = [
            {name: 'products', kind: 'table', rowEstimate: 3, comment: '演示商品表'},
            {name: 'logs', kind: 'table', rowEstimate: 1, comment: ''},
            {name: 'v_summary', kind: 'view', rowEstimate: 0, comment: '汇总视图'},
        ];
        // 建表表单在 mock 会话里新建的表（DBQuery 捕获 CREATE TABLE），让树刷新可见
        const extra = mockDbSession.tables.map((t) => ({name: t, kind: 'table', rowEstimate: 0, comment: ''}));
        return base.concat(extra);
    },
    async DBListServerObjects() {
        return {groups: [
            {id: 'collations', label: '排序规则', items: ['utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin']},
            {id: 'users', label: '用户', items: ['root@localhost', 'demo@%']},
            {id: 'sysviews', label: '虚拟视图', items: ['SCHEMATA', 'TABLES']},
        ]};
    },
    async DBDescribe(id, database, table) {
        const hasPk = table !== 'logs';
        return {
            table: String(table || 'products'), database: '', kind: 'table',
            columns: [
                {name: 'id', type: 'INTEGER', notNull: true, pk: hasPk},
                {name: 'name', type: 'TEXT', notNull: false, pk: false},
                {name: 'price', type: 'REAL', notNull: false, pk: false},
            ],
            pk: hasPk ? ['id'] : [],
            indexes: hasPk ? [{name: 'sqlite_autoindex_products_1', unique: true, columns: ['id']}] : [],
            rowEstimate: 3, tableComment: hasPk ? '演示商品表' : '', editable: hasPk && !!mockDbSession.editable,
        };
    },
    async DBBrowse(id, req) {
        const rows = [
            ['1', 'alpha', '1.5'],
            ['2', 'beta', '2.5'],
            ['3', 'gamma', '3.5'],
        ];
        const want = Number(req && req.limit || 0);
        const truncated = want > 0 && want < rows.length;
        return {
            columns: ['id', 'name', 'price'],
            rows: truncated ? rows.slice(0, want) : rows,
            nulls: rows.map(() => [false, false, false]),
            truncated, elapsedMs: 1, message: '',
        };
    },
    async DBQuery(id, queryID, query, confirmed) {
        const q = String(query || '');
        // Redis 会话：按行拆命令，读命令演示真值，写命令走 editable + 确认链（对齐 Go guard 行为）
        if (id === 'mock-db-redis') {
            const lines = q.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
            const results = [];
            for (const line of lines) {
                const toks = line.split(/\s+/);
                const head = (toks[0] || '').toUpperCase();
                let result;
                let wrote = false;
                if (head === 'GET' && mockRedis.data[toks[1]]) {
                    result = {columns: ['结果'], rows: [[String(mockRedis.data[toks[1]].value)]], nulls: [[false]], truncated: false, elapsedMs: 1, message: ''};
                } else if (head === 'PING') {
                    result = {columns: ['结果'], rows: [['PONG']], nulls: [[false]], truncated: false, elapsedMs: 1, message: ''};
                } else if (head === 'TTL' && mockRedis.data[toks[1]]) {
                    const t = mockRedis.ttl[toks[1]] != null ? mockRedis.ttl[toks[1]] : -1;
                    result = {columns: ['结果'], rows: [[String(t)]], nulls: [[false]], truncated: false, elapsedMs: 1, message: ''};
                } else if (head === 'SET' || head === 'DEL' || head === 'EXPIRE' || head === 'HSET' || head === 'HDEL') {
                    if (!mockRedis.editable) {
                        throw new Error('只读连接拒绝写操作；如需编辑请在打开连接时显式开启「允许编辑」');
                    }
                    if (!confirmed && (head === 'DEL' || head === 'EXPIRE')) {
                        return {status: 'confirm', confirm: 'danger', message: '演示模式：写命令需确认后重发。'};
                    }
                    const ops = head === 'SET'
                        ? [{kind: 'setString', Key: toks[1], Value: toks.slice(2).join(' '), TTLSeconds: mockRedis.ttl[toks[1]] != null ? mockRedis.ttl[toks[1]] : -1}]
                        : (head === 'DEL' ? toks.slice(1) : []).map((k) => ({kind: 'delKey', Key: k}));
                    const rows = mockRedisApplyOps(ops);
                    result = {columns: ['结果'], rows: [['OK']], nulls: [[false]], truncated: false, elapsedMs: 1, message: '已执行'};
                    wrote = true;
                } else if (head === 'FLUSHALL' || head === 'FLUSHDB' || head === 'CONFIG' || head === 'SHUTDOWN' || head === 'MULTI') {
                    if (head === 'MULTI') throw new Error('控制台不支持手动事务（MULTI/EXEC）：编辑走「预览并提交」');
                    return {status: 'confirm', confirm: 'danger', message: '演示模式：危险命令需确认后重发。'};
                } else {
                    throw new Error('无法识别的命令（按写拒绝，fail closed）演示：' + line);
                }
                results.push({sql: line.length > 80 ? line.slice(0, 80) + '…' : line, result, wrote});
            }
            const last = results.length ? results[results.length - 1].result : {columns: ['结果'], rows: [], nulls: [], truncated: false, elapsedMs: 1, message: ''};
            return {status: 'ok', result: last, results, statements: results.length, writes: results.filter((r) => r.wrote).length};
        }
        // 建表表单 / 控制台在 mock 会话里的 CREATE TABLE 记进会话，DBListObjects 随之可见
        const m = q.match(/CREATE\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
        if (m && !mockDbSession.tables.includes(m[1])) mockDbSession.tables.push(m[1]);
        if (!confirmed && /update|delete|drop|insert/i.test(q)) {
            return {status: 'confirm', confirm: 'missingWhere', message: '演示模式：写语句需确认。'};
        }
        // 按分号拆语句，每条一个结果（对齐 Go Results 协议的演示形态）
        const stmts = q.split(';').map((s) => s.trim()).filter(Boolean);
        const results = stmts.map((s) => ({
            sql: s.length > 80 ? s.slice(0, 80) + '…' : s,
            result: {
                columns: ['id', 'name'], rows: [['1', 'alpha'], ['2', 'beta']],
                nulls: [[false, false], [false, false]], truncated: false, elapsedMs: 1, message: '',
            },
            wrote: false,
        }));
        return {
            status: 'ok',
            result: results.length ? results[results.length - 1].result : {
                columns: ['id', 'name'], rows: [['1', 'alpha'], ['2', 'beta']],
                nulls: [[false, false], [false, false]], truncated: false, elapsedMs: 1, message: '',
            },
            results,
            statements: stmts.length, writes: 0,
        };
    },
    async DBCancel() { return null; },
    async DBClose() { return null; },
    async DBListConnections() { return mockDbConnections; },
    async DBSaveConnection(cfg) {
        const saved = Object.assign({}, cfg, {id: cfg.id || 'mock-dbc-' + Date.now(), updatedAt: Date.now()});
        const at = mockDbConnections.findIndex((c) => c.id === saved.id);
        if (at >= 0) mockDbConnections[at] = saved;
        else mockDbConnections.push(saved);
        persistMockConnections(mockDbConnections);
        return saved;
    },
    async DBDeleteConnection(id) {
        const at = mockDbConnections.findIndex((c) => c.id === id);
        if (at >= 0) mockDbConnections.splice(at, 1);
        persistMockConnections(mockDbConnections);
        return null;
    },
    async DBTestConnection(cfg) {
        return cfg && cfg.kind === 'redis' ? 'Redis 7.2（mock）' : 'MySQL 8.0（mock）';
    },
    // 连接配置文件导入（dev 下演示「导入一条 + 跳过一条」，不读磁盘）
    async DBImportConnections(path) {
        return {
            imported: [{
                id: 'mock-dbc-imported', name: '导入的演示库（' + String(path || '').split(/[\\/]/).pop() + '）',
                kind: 'mysql', host: '127.0.0.1', port: 3306, database: '', user: 'demo', allowEdit: false, updatedAt: Date.now(),
            }],
            updated: [],
            skipped: [{name: 'demo-redis', reason: '演示模式：跳过条目'}],
        };
    },
    async DBPreviewChanges(id, changes) {
        return (changes && changes.updates || []).map((u) => ({
            kind: 'update',
            sql: 'UPDATE ' + changes.table + ' SET ' + u.column + " = '" + (u.newValue || '') + "' WHERE id = " + ((u.keys && u.keys.id) || '?'),
        }));
    },
    async DBApplyChanges(id, changes) {
        return {
            updates: (changes && changes.updates || []).length,
            deletes: (changes && changes.deletes || []).length,
            inserts: (changes && changes.inserts || []).length,
            elapsedMs: 2,
        };
    },
    // 插件数据库驱动的通用凭据存取（dev 下内存 Map 模拟 dpapi 表）
    async DBCredentialPut(key, plain) {
        if (!plain) dbCredentialMock.delete(String(key || ''));
        else dbCredentialMock.set(String(key), String(plain));
        return null;
    },
    async DBCredentialGet(key) {
        return dbCredentialMock.get(String(key || '')) || '';
    },
    async TermShells() { return [{id: 'bash', name: 'Git Bash'}]; },
    async DetectToolchain() { return {envs: []}; },
    async PrepareRun(spec) {
        return {sourcePath: (spec && spec.srcPath) || 'mock://run/main.py', workDir: 'mock://run', tempDir: '', tempCopy: !!(spec && spec.content)};
    },
    async RunExec(id, exe, args, cwd, pathPrepend, timeoutMs) {
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
    async MavenProjectInfo() {
        return {
            root: 'mock://workspace/sky', pomPath: 'mock://workspace/sky/pom.xml',
            artifactId: 'sky', name: 'sky', packaging: 'pom',
            modules: [
                {name: 'sky-admin', relPath: 'sky-admin', dir: 'mock://workspace/sky/sky-admin', hasPom: true, artifactId: 'sky-admin', modules: []},
                {name: 'sky-common', relPath: 'sky-common', dir: 'mock://workspace/sky/sky-common', hasPom: true, artifactId: 'sky-common', modules: []},
            ],
            settingsPath: 'mock://home/.m2/settings.xml', settingsExists: true,
        };
    },
    async MavenData(workspaceRoot, mvnPath, timeoutMs, kind) {
        if (kind === 'dependency-tree') {
            return [
                'com.sky:sky:jar:1.0.0',
                '+- org.springframework:spring-core:jar:5.3.31:compile',
                '|  \\- org.springframework:spring-jcl:jar:5.3.31:compile',
                '\\- junit:junit:jar:4.13.2:test',
            ].join('\n');
        }
        if (kind === 'effective-pom') {
            return '<project><build><plugins>'
                + '<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin>'
                + '<plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>'
                + '</plugins></build></project>';
        }
        if (kind === 'effective-settings') {
            return '<settings><localRepository>mock://home/.m2/repository</localRepository>'
                + '<mirrors><mirror><id>aliyun</id><url>https://maven.aliyun.com/repository/public</url><mirrorOf>central</mirrorOf></mirror></mirrors>'
                + '</settings>';
        }
        return '';
    },
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
    // wipe-guard 多根监听（真实后端用合成工作区槽，事件仍是 workspace-changed 带
    // removed/present）。mock 只记订阅表，供 dev 下核对前端有没有多订/漏退。
    async WatchWipeguardRoot(root) {
        const list = window.__mockWipeguardRoots || (window.__mockWipeguardRoots = []);
        const key = legacyPathKey(root || '')
        if (key && !list.includes(key)) list.push(key);
        return null;
    },
    async UnwatchWipeguardRoot(root) {
        const key = legacyPathKey(root || '')
        window.__mockWipeguardRoots = (window.__mockWipeguardRoots || []).filter((item) => item !== key);
        return null;
    },
    // 「本进程已打开过」账本：mock 用同一个 Map 复现首次/重复语义（归一化同真实后端）。
    async WorkspaceMarkOpened(dir) {
        const map = window.__mockOpenedWorkspaces || (window.__mockOpenedWorkspaces = {});
        const key = legacyPathKey(dir || '')
        if (!key) return false;
        if (map[key]) return false;
        map[key] = true;
        return true;
    },
    async UnwatchWorkspace() { return null; },
    async GetConvertRequest() { return null; },
    async FinishConvert() { return null; },
    async IsAIFloatWindow() { return false; },
    async IsDebugConsoleWindow() { return false; },
    async OpenDebugConsoleWindow() { return null; },
    async AITouchStream() { return null; },
    async AISessionSearch() { return []; },
    // 跨会话检索（session_search 工具 / 全局搜索的 AI 会话分类）：直接从 mock 会话日志里搜
    async AISessionSearchScoped(query, limit, brief) {
        const q = String(query || '').trim().toLowerCase();
        const hits = [];
        const max = Math.max(1, Number(limit) || 30);
        if (!q) return {hits, truncated: false, brief: !!brief};
        for (const [id, item] of mockAISessions) {
            const log = String(item.log || '');
            const at = log.toLowerCase().indexOf(q);
            if (at < 0) continue;
            let title = '';
            let group = '';
            try {
                const meta = JSON.parse(item.meta || '{}') || {};
                title = meta.title || '';
                group = meta.group || '';
            } catch (e) {}
            hits.push({
                sessionId: id,
                title: title || '(mock 会话)',
                group,
                role: 'user',
                name: '',
                mid: '',
                liveIndex: 0,
                snippet: log.slice(Math.max(0, at - 40), at + q.length + 60).replace(/\s+/g, ' '),
                kind: '',
                ts: 0,
            });
            if (hits.length >= max) break;
        }
        return {hits, truncated: hits.length >= max, brief: !!brief};
    },
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
    // ---- AI 计时器 mock（类一-11）：内存计时 + 到点广播，供浏览器端验证胶囊与唤醒链路 ----
    async StartTimer(mode, seconds, label) {
        if (mockTimerStore.size >= 5) throw new Error('最多同时运行 5 个计时器，请先停止部分计时器');
        const info = {
            id: 't-' + Math.random().toString(36).slice(2, 10),
            mode: mode === 'countup' ? 'countup' : 'countdown',
            label: String(label || '').slice(0, 60),
            startMs: Date.now(),
            endMs: 0,
        };
        if (info.mode === 'countdown') {
            info.endMs = info.startMs + Math.max(1, Math.round(Number(seconds) || 0)) * 1000;
            info._h = setTimeout(() => {
                mockTimerStore.delete(info.id);
                mockRt.EventsEmit('ai-timer-fired', {id: info.id, mode: info.mode, label: info.label, startMs: info.startMs, endMs: info.endMs});
            }, Math.max(1, Math.round(Number(seconds) || 0)) * 1000);
        }
        mockTimerStore.set(info.id, info);
        return {list: mockTimerList(), created: {...info, _h: undefined}};
    },
    async StopTimer(id) {
        const info = mockTimerStore.get(id);
        const found = !!info;
        if (found) {
            if (info._h) clearTimeout(info._h);
            mockTimerStore.delete(info.id);
            setTimeout(() => mockRt.EventsEmit('ai-timer-stopped', {id: info.id, mode: info.mode, label: info.label, startMs: info.startMs, endMs: info.endMs}), 0);
        }
        return {
            list: mockTimerList(),
            stopped: info ? {id: info.id, mode: info.mode, label: info.label, startMs: info.startMs, endMs: info.endMs} : {id: String(id || ''), mode: '', label: '', startMs: 0, endMs: 0},
            found,
        };
    },
    async ListTimers() { return mockTimerList(); },
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
    async ReadDirTree(path, depth) {
        // 与 app_fs.go ReadDirTree 同语义的 mock：跳过垃圾目录、400 项预算、深度钳 1–8
        const key = String(path || '').replace(/\/+$/, '');
        if (!mockTree[key]) throw new Error('目录不存在');
        const skip = new Set(['.git', '.svn', '.hg', '.idea', '.vscode', 'node_modules', '__pycache__']);
        const maxDepth = Math.max(1, Math.min(8, Math.round(Number(depth) || 1)));
        let budget = 400;
        let total = 0;
        let truncated = false;
        const walk = (dir, remaining) => {
            const node = {name: dir.split('/').pop() || dir, isDir: true, children: []};
            if (remaining <= 0) return node;
            const entries = mockTree[dir];
            if (!entries) return node;
            const sorted = entries.slice().sort((a, b) => ((b.isDir ? 1 : 0) - (a.isDir ? 1 : 0)) || a.name.localeCompare(b.name));
            for (const entry of sorted) {
                if (entry.isDir && skip.has(entry.name)) continue;
                if (budget <= 0) {
                    node.omitted = true;
                    truncated = true;
                    return node;
                }
                budget -= 1;
                total += 1;
                const child = {name: entry.name, isDir: !!entry.isDir};
                if (!entry.isDir) child.size = 128;
                node.children.push(child);
                if (entry.isDir) {
                    const sub = walk(entry.path, remaining - 1);
                    child.children = sub.children;
                    child.omitted = sub.omitted;
                }
            }
            return node;
        };
        const root = walk(key, maxDepth);
        return {root, depth: maxDepth, total, truncated};
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
    async RestoreEntry(path) {
        // mock 后端是内存文件系统，没有系统回收站可还原
        throw new Error('调试模式不支持从回收站还原：' + String(path || ''));
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
    async SearchWorkspaceFuzzy(root, query, caseSensitive, maxResults) {
        const text = String(query == null ? '' : query);
        const limit = Math.max(1, Math.min(Number(maxResults) || 400, 1000));
        const hits = [];
        if (!text) return {hits, truncated: false, files: 0};
        const needle = caseSensitive ? text : text.toLowerCase();
        const pushHit = (item, lineNo, line, start, end) => hits.push({
            path: mockDir + item.name,
            name: item.name,
            dir: 'samples',
            line: lineNo,
            column: start + 1,
            length: end - start,
            preview: line,
            matchStart: start,
            matchEnd: end,
        });
        let files = 0;
        for (const item of Object.values(mockFiles)) {
            files++;
            const lines = String(item.content || '').split('\n');
            for (let i = 0; i < lines.length && hits.length < limit; i++) {
                const line = lines[i].replace(/\r$/, '');
                if (!line) continue;
                const hay = caseSensitive ? line : line.toLowerCase();
                const before = hits.length;
                let from = 0;
                while (hits.length < limit) {
                    const idx = hay.indexOf(needle, from);
                    if (idx < 0) break;
                    pushHit(item, i + 1, line, idx, idx + needle.length);
                    from = idx + Math.max(1, needle.length);
                }
                // 整行没有字面命中时才做子序列匹配（与 Go 侧一致），每行至多一条
                if (hits.length === before) {
                    const [start, end] = mockFuzzyWindow(line, text, caseSensitive);
                    if (start >= 0) pushHit(item, i + 1, line, start, end);
                }
            }
        }
        return {hits, truncated: hits.length >= limit, files};
    },
    async SearchWorkspaceFiltered(root, query, caseSensitive, maxResults, pattern) {
        const pat = String(pattern || '').trim();
        // mock 里文件都在 samples 一层，先取大窗再按通配过滤即可
        const res = await this.SearchWorkspace(root, query, caseSensitive, 1000);
        const hits = pat ? (res.hits || []).filter((hit) => mockGlobMatch(pat, hit.name || '', hit.name || '')) : (res.hits || []);
        const limit = Math.max(1, Math.min(Number(maxResults) || 400, 1000));
        return {hits: hits.slice(0, limit), truncated: !!res.truncated || hits.length > limit, files: res.files || 0};
    },
    // 与 Go SearchWorkspaceAdvanced 同参数面的 mock：dev 模式下 AI 调高级搜索不会崩，
    // 且 regex / wholeWord / excludePattern / outputMode / context / maxResults / includeIgnored 的行为可调试。
    // includeIgnored：mockFiles 都是样本文件、无目录忽略表，接收参数但无需过滤（对齐参数面）。
    async SearchWorkspaceAdvanced(root, query, opts = {}) {
        const text = String(query == null ? '' : query);
        // 分页：offset/limit 与 Go 同口径；旧 maxResults 作为 limit 兼容别名。
        const legacy = Number(opts.maxResults);
        const limitRaw = Number(opts.limit) || (Number.isFinite(legacy) && legacy > 0 ? legacy : 50);
        const limit = Math.max(1, Math.min(limitRaw, 1000));
        const offset = Math.max(0, Number(opts.offset) || 0);
        if (!text) return {hits: [], truncated: false, files: 0, total: 0, returned: 0, offset};
        const caseSensitive = !!opts.caseSensitive;
        const context = Math.max(0, Math.min(Number(opts.context) || 0, 3));
        const mode = ['content', 'files', 'count'].includes(opts.outputMode) ? opts.outputMode : 'content';
        let re = null;
        if (opts.regex) {
            let src = text;
            if (opts.wholeWord) src = '\\b(?:' + src + ')\\b';
            try {
                re = new RegExp(src, caseSensitive ? '' : 'i');
            } catch (e) {
                throw new Error('正则表达式无效：' + e.message);
            }
        }
        const needle = caseSensitive ? text : text.toLowerCase();
        const isWord = (ch) => !!ch && /[\w\u0080-\uffff]/.test(ch);
        const hits = [];
        let files = 0;
        // fileOnly：root 是单个文件时只扫该文件（与真实 Go 后端同语义）
        const fileOnlyName = opts.fileOnly ? String(root || '').split('/').pop() : '';
        for (const item of Object.values(mockFiles)) {
            const name = String(item.name || '');
            if (opts.fileOnly && name !== fileOnlyName) continue;
            if (opts.pattern && !mockGlobMatch(opts.pattern, name, name)) continue;
            if (opts.excludePattern && mockGlobMatch(opts.excludePattern, name, name)) continue;
            files++;
            const lines = String(item.content || '').split('\n').map((line) => line.replace(/\r$/, ''));
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;
                const spans = [];
                if (re) {
                    re.lastIndex = 0;
                    let m;
                    while ((m = re.exec(line)) !== null) {
                        spans.push([m.index, m.index + m[0].length]);
                        if (!m[0]) re.lastIndex++;
                    }
                } else {
                    const hay = caseSensitive ? line : line.toLowerCase();
                    let from = 0;
                    while (from <= hay.length) {
                        const idx = hay.indexOf(needle, from);
                        if (idx < 0) break;
                        const end = idx + needle.length;
                        if (!opts.wholeWord || (!isWord(line[idx - 1]) && !isWord(line[end]))) spans.push([idx, end]);
                        from = idx + Math.max(1, needle.length);
                    }
                }
                for (const [start, end] of spans) {
                    const before = [];
                    const after = [];
                    for (let n = i - context; n < i; n++) if (n >= 0) before.push({line: n + 1, text: lines[n]});
                    for (let n = i + 1; n <= i + context && n < lines.length; n++) after.push({line: n + 1, text: lines[n]});
                    hits.push({
                        path: mockDir + name,
                        name,
                        dir: 'samples',
                        line: i + 1,
                        column: start + 1,
                        length: end - start,
                        preview: line,
                        matchStart: start,
                        matchEnd: end,
                        before,
                        after,
                    });
                }
            }
        }
        const total = hits.length;
        const page = hits.slice(offset, offset + limit);
        const result = {hits: page, truncated: total > offset + limit, files, total, returned: page.length, offset};
        if (mode === 'files') {
            // 与 Go applyPagination 同口径：先对全量命中去重成文件清单，再按 offset/limit 切文件。
            const allFiles = [...new Set(hits.map((hit) => hit.path))];
            result.fileList = allFiles.slice(offset, offset + limit);
            result.total = allFiles.length;
            result.returned = result.fileList.length;
            result.hits = [];
        } else if (mode === 'count') {
            const index = new Map();
            for (const hit of hits) index.set(hit.path, (index.get(hit.path) || 0) + 1);
            const allCounts = [...index].map(([path, count]) => ({path, count}));
            result.counts = allCounts.slice(offset, offset + limit);
            result.total = allCounts.length;
            result.returned = result.counts.length;
            result.hits = [];
        }
        return result;
    },
    async FindFiles(root, pattern, maxResults) {
        const pat = String(pattern || '*').trim() || '*';
        const limit = Math.max(1, Math.min(Number(maxResults) || 300, 1000));
        const files = [];
        for (const item of Object.values(mockFiles)) {
            const name = String(item.name || '');
            if (!mockGlobMatch(pat, name, name)) continue;
            files.push({path: name, name, dir: '', size: String(item.content || '').length});
            if (files.length >= limit) break;
        }
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return {files, truncated: files.length >= limit, scanned: Object.keys(mockFiles).length};
    },
    async ReadImageAsDataURL() { return mockImageDataUrl; },
    async ReadVideoAsDataURL() { throw new Error('mock 环境不读取视频'); },
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
        localStorage.setItem(MOCK_SAVE_KEY, content);
        console.info('[mock] SaveFile', path, content.length, 'chars', enc);
    },
    // .cadt/** 内务文件的原子落盘（真实后端走临时文件 + fsync + 替换）；
    // mock 复用 SaveFile 的记录语义，另记一条原子写清单供测试断言。
    async SaveFileAtomic(path, content, eol, hasBom, enc) {
        await this.SaveFile(path, content, eol, hasBom, enc);
        window.__mockAtomicSaves = (window.__mockAtomicSaves || []).concat([{path, content, eol, hasBom, enc}]);
    },
    async SetDirty(flag) { console.info('[mock] SetDirty', flag); },
    async SetWindowBg(r, g, b) { window.__mockWindowBg = [r, g, b]; },
    async GetOpenMode() {
        if (!window.__mockOpenMode) window.__mockOpenMode = 'tab';
        return window.__mockOpenMode;
    },
    async SetOpenMode(mode) { window.__mockOpenMode = mode; },
    async GetCloseAction() {
        if (!window.__mockCloseAction) window.__mockCloseAction = 'exit';
        return window.__mockCloseAction;
    },
    async SetCloseAction(action) { window.__mockCloseAction = action === 'tray' ? 'tray' : 'exit'; },
    async QuitApp() { this._calls.push('quit-app'); },
    async ForceQuitAll() { window.__mockForceQuitAll = (window.__mockForceQuitAll || 0) + 1; },
    // --quit 优雅退出的窗口 ack（真实后端按窗口名去重；mock 记数即可）
    async AppGracefulQuitAck() { window.__mockGracefulQuitAck = (window.__mockGracefulQuitAck || 0) + 1; },
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
        window.__mockTermIds = (window.__mockTermIds || []).concat([id]);
        window.__mockTermShells = window.__mockTermShells || {};
        window.__mockTermShells[id] = usedShell;
        window.__mockTermLogs = window.__mockTermLogs || {};
        window.__mockTermPush = window.__mockTermPush || {};
        const push = (data) => {
            window.__mockTermLogs[id] = String(window.__mockTermLogs[id] || '') + data;
            if (rt && rt.EventsEmit) rt.EventsEmit('term-out', {id, data});
        };
        window.__mockTermPush[id] = push;
        setTimeout(() => {
            push('CaDt-DataLens 模拟终端（开发预览）\r\nPS ' + (cwd || 'C:\\') + '> ');
        }, 200);
        return {id, shell: usedShell};
    },
    async TermWrite(id, data) {
        const push = (window.__mockTermPush || {})[id];
        if (!push || !data) return;
        // 带回车 = 执行一行：回显命令并给一句模拟结果（AI 的 terminal send/read 在 dev 下可用）
        if (data.includes('\r') || data.includes('\n')) {
            const command = data.replace(/[\r\n]+$/, '');
            push((command || '') + '\r\n[mock] 执行：' + (command || '') + '\r\nPS > ');
        } else {
            push(data);
        }
    },
    async TermRead(id, maxChars) {
        const text = String((window.__mockTermLogs || {})[id] || '');
        const limit = Math.max(200, Math.min(Number(maxChars) || 4000, 20000));
        const truncated = text.length > limit;
        return {
            id,
            shell: String((window.__mockTermShells || {})[id] || 'pwsh'),
            cwd: '',
            text: truncated ? text.slice(text.length - limit) : text,
            truncated,
            exited: false,
            exitCode: 0,
            bytes: text.length,
        };
    },
    async TermList() {
        const logs = window.__mockTermLogs || {};
        return (window.__mockTermIds || []).map((id) => {
            const text = String(logs[id] || '');
            const lines = text.split(/\r?\n/).filter((line) => line.trim());
            return {
                id,
                shell: String((window.__mockTermShells || {})[id] || 'pwsh'),
                cwd: '',
                exited: false,
                exitCode: 0,
                bytes: text.length,
                last: (lines[lines.length - 1] || '').slice(-160),
            };
        });
    },
    async PopOutTerminal(id) { this._calls.push('popout-terminal:' + id); },
    async IsTerminalWindow() { return !!window.__mockTerminalWindow; },
    async GetStartupTermID() { return window.__mockTerminalTermId || ''; },
    // 辅助独立窗（便签/会话监控/文件对比，aux_windows.go）：dev 浏览器调试按普通窗口处理，
    // 弹出动作只记调用；要调试窗口形态本身请用真实 exe。
    async GetAuxWindowKind() { return window.__mockAuxWindowKind || ''; },
    async PopOutMemo(scope, workspace) { this._calls.push('popout-memo:' + scope + ':' + (workspace || '')); },
    async PopOutSession(sessionId, kind, workspace) { this._calls.push('popout-session:' + kind + ':' + sessionId); },
    async OpenDiffWindow(pathA, pathB) { this._calls.push('open-diff:' + pathA + '|' + pathB); },
    async OpenLightView(path) { this._calls.push('open-light:' + path); },
    async OpenLivePreview(path) { this._calls.push('open-preview:' + path); },
    async GetStartupMemo() { return window.__mockAuxWindowKind === 'memo' ? {scope: 'global', workspace: ''} : null; },
    async GetStartupMonitorSession() { return null; },
    async GetStartupDiff() { return null; },
    async GetStartupLight() { return window.__mockAuxWindowKind === 'light' ? {path: ''} : null; },
    async GetStartupPreview() { return window.__mockAuxWindowKind === 'preview' ? {path: '', origin: ''} : null; },
    // 群讨论租约（multi-instance-sync P6）：mock 恒成功（dev 单窗口）
    async GroupLeaseAcquire(id, label) { this._calls.push('group-lease-acquire:' + id); return {acquired: true}; },
    async GroupLeaseRelease(id) { this._calls.push('group-lease-release:' + id); },
    async GroupLeaseStatus(id) { return {acquired: false, busy: false}; },
    async WindowList() {
        return (window.__mockWindows || [{name: 'main', mode: 'main', self: '1'}]).slice();
    },
    async WindowFocusByName(name) { this._calls.push('focus-window:' + name); return true; },
    async IsWorkspaceOpen(dir) { return !!(window.__mockWorkspaceOpenDirs || []).some((d) => d === dir); },
    async TermResize() {},
    async TermClose() {},
    async RunCommandSync(exe, args, cwd, timeoutMs) {
        return {code: 0, stdout: '[mock] ' + exe + ' ' + (args || []).join(' ') + (cwd ? ' (cwd ' + cwd + ')' : ''), stderr: ''};
    },
    // 插件后台服务（mock）：状态存内存，供插件设置面板/服务 API 在 dev 模式调试。
    async AppServiceSync(specs) {
        const st = window.__mockAppServices || (window.__mockAppServices = {});
        const wanted = new Set((specs || []).map((s) => s.id));
        for (const id of Object.keys(st)) if (!wanted.has(id)) delete st[id];
        for (const s of specs || []) {
            if (!st[s.id]) st[s.id] = {id: s.id, state: 'stopped', pid: 0, healthOK: !s.healthURL, logs: [], spec: s};
        }
    },
    async AppServiceStart(id) {
        const st = window.__mockAppServices || (window.__mockAppServices = {});
        const svc = st[id] || (st[id] = {id, state: 'stopped', pid: 0, healthOK: false, logs: []});
        svc.state = 'running';
        svc.pid = 4242 + Object.keys(st).length;
        svc.healthOK = true;
        svc.logs.push('[mock] service started');
    },
    async AppServiceStop(id) {
        const st = window.__mockAppServices || {};
        if (st[id]) { st[id].state = 'stopped'; st[id].pid = 0; st[id].logs.push('[mock] service stopped'); }
    },
    async AppServiceStatus(id) {
        const st = window.__mockAppServices || {};
        const svc = st[id];
        if (!svc) return {id, state: 'stopped', pid: 0, healthOK: false};
        return {id: svc.id, state: svc.state, pid: svc.pid, healthOK: svc.healthOK};
    },
    async AppServiceList() {
        const st = window.__mockAppServices || {};
        return Object.values(st).map((s) => ({id: s.id, state: s.state, pid: s.pid, healthOK: s.healthOK}));
    },
    async AppServiceLogs(id) {
        const st = window.__mockAppServices || {};
        return st[id] ? [...st[id].logs] : [];
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
    async AIRunShellCommand(command, cwd, timeoutMs, runId, shell) {
        (window.__mockShellLog || (window.__mockShellLog = [])).push({command, cwd, timeoutMs, shell});
        await new Promise((resolve) => setTimeout(resolve, 200));
        // 显式 shell 时如实回显该 shell（与真后端一致：指定了就一定用它）
        const explicit = mockShellLabel(shell);
        return {
            shell: explicit || 'Git Bash',
            exe: explicit === 'PowerShell 7' ? 'C:/Program Files/PowerShell/7/pwsh.exe'
                : explicit === 'Windows PowerShell' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
                    : explicit === 'Command Prompt' ? 'C:/Windows/System32/cmd.exe'
                        : 'C:/Program Files/Git/bin/bash.exe',
            code: 0,
            stdout: '[mock] ' + command + (cwd ? '\n(cwd ' + cwd + ')' : ''),
            stderr: '',
            timedOut: false,
            durationMs: 200,
        };
    },
    async AIRunShellCommandConfined(command, cwd, timeoutMs, runId, mode, workspaceRoot, shell) {
        (window.__mockShellLog || (window.__mockShellLog = [])).push({command, cwd, timeoutMs, mode, workspaceRoot, shell});
        await new Promise((resolve) => setTimeout(resolve, 200));
        const sandboxed = mode !== 'danger-full-access';
        const explicit = mockShellLabel(shell);
        return {
            // 沙箱档的 shell 是 PowerShell（Git Bash 在受限令牌下起不来），如实回显
            shell: sandboxed ? (explicit || 'PowerShell 7') : (explicit || 'Git Bash'),
            exe: sandboxed ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'C:/Program Files/Git/bin/bash.exe',
            code: 0,
            stdout: '[mock] ' + command + (cwd ? '\n(cwd ' + cwd + ')' : ''),
            stderr: '',
            timedOut: false,
            durationMs: 200,
            ...(sandboxed ? {sandboxMode: mode, enforcement: 'partial', tempDir: 'C:/Temp/cadt-sandbox-mock'} : {}),
        };
    },
    async SandboxScan(root) {
        return {root, workspaceSid: 'S-1-4-1001-2002', granted: false, denyPresent: false, labeled: false};
    },
    async SandboxRevoke(root) {
        // mock 里没有真实 ACL：直接回一个「已清空」的状态
        return {root, workspaceSid: 'S-1-4-1001-2002', granted: false, denyPresent: false, labeled: false};
    },
    async AICommandStart(command, cwd, shell) {
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
        return {jobId: id, shell: mockShellLabel(shell) || 'Git Bash'};
    },
    async AICommandStartConfined(command, cwd, mode, workspaceRoot, shell) {
        // 沙箱档的后台作业：结构与 AICommandStart 相同，额外回显档位与写根
        const started = await this.AICommandStart(command, cwd, shell);
        const sandboxed = mode !== 'danger-full-access';
        if (!sandboxed) return started;
        return {
            ...started,
            shell: mockShellLabel(shell) || 'PowerShell 7',
            sandboxMode: mode,
            enforcement: 'partial',
            tempDir: 'C:/Temp/cadt-sandbox-mock',
            workspaceRoot,
        };
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
        tab.dataset.tip = '[mock] ' + url.replace(/^https?:\/\//, '');
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
        const s = String(script);
        // browser_wait / scroll / hover / select / 按文本点击都靠 JSON.stringify({ok:...}) 回执：
        // dev 模式直接给成功回执，让这些工具链在 mock 里能走通（不模拟真实 DOM 效果）
        if (s.includes('JSON.stringify({ok:')) {
            return JSON.stringify({ok: true, tag: 'MOCK', text: 'mock', scrollY: 0, scrollHeight: 1000, value: 'mock', label: 'mock', count: 3});
        }
        return JSON.stringify({result: {value: '[mock eval] ' + s.slice(0, 60)}});
    },
    async BrowserCallCDP(id, method, paramsJSON) {
        throw new Error('CDP 通道暂不可用（' + method + '）');
    },
    async BrowserCaptureScreenshot(id) {
        const tab = window.__mockBrowserTabs && window.__mockBrowserTabs.get(id);
        window.__mockShotUrl = tab ? tab.url : id;
        return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    },
    async BrowserSnapshot(id) {
        // 前端定格帧：dev 桩没有原生 WebView2，给一张 1×1 占位图以便走通显隐链路
        return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    },
    // viewportWidth/viewportHeight > 0：页面 CSS 视口（固定分辨率），0 = 自适应
    async BrowserSetBounds(id, x, y, w, h, viewportWidth, viewportHeight) {
        if (!window.__mockBrowserBounds) window.__mockBrowserBounds = new Map();
        window.__mockBrowserBounds.set(id, {x, y, w, h, viewportWidth, viewportHeight});
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
    async GitWorktreeList(dir) {
        const items = (window.__mockWorktrees || []).map((w) => ({
            path: dir + '\\.cadt\\worktree\\' + w.name,
            relPath: '.cadt/worktree/' + w.name,
            branch: 'cadt/wt/' + w.name,
            head: w.baseSha || 'mock-head',
            underCadt: true,
        }));
        return {available: mockScenario.has('gitmock'), root: dir, items};
    },
    async GitWorktreeAdd(dir, label, sessionKey, carry) {
        if (!mockScenario.has('gitmock')) throw new Error('mock 无 git');
        const slug = String(label || 'wt').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'wt';
        const idPart = String(sessionKey || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);
        const name = (slug + (idPart ? '-' + idPart : '')).slice(0, 41);
        const entry = {name, baseSha: 'mock-base-' + (window.__mockWorktrees || []).length};
        window.__mockWorktrees = (window.__mockWorktrees || []).concat([entry]);
        return {
            name,
            branch: 'cadt/wt/' + name,
            path: dir + '\\.cadt\\worktree\\' + name,
            baseSha: carry ? entry.baseSha + '-carried' : entry.baseSha,
            deps: ['node_modules'],
            depErrors: [],
            includeCopied: 1,
            includeErrors: [],
            carried: carry ? 3 : 0,
        };
    },
    async GitWorktreeRemove(dir, name, deleteBranch) {
        window.__mockWorktrees = (window.__mockWorktrees || []).filter((w) => w.name !== name);
        return null;
    },
    async GitWorktreePrune(dir) {
        return null;
    },
    async GitWorktreeStat(dir, name, baseSha) {
        if (!mockScenario.has('gitmock')) throw new Error('mock 无 git');
        if (mockScenario.has('wtempty')) return '';
        return ' sample.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)';
    },
    async GitWorktreeDiff(dir, name, baseSha) {
        if (!mockScenario.has('gitmock')) throw new Error('mock 无 git');
        if (mockScenario.has('wtempty')) throw new Error('worktree 没有改动');
        return 'diff --git a/sample.js b/sample.js\n--- a/sample.js\n+++ b/sample.js\n@@ -1,1 +1,2 @@\n old line\n+new line from worktree\n';
    },
    async GitGraphCommits(dir, ref, limit, skip) {
        if (!mockScenario.has('gitmock')) {
            return {available: false, reason: 'mock 无 git', commits: [], laneCount: 0, hasMore: false, nextSkip: 0};
        }
        const n = Math.min(limit || 500, 20);
        const commits = [];
        for (let i = 0; i < n; i++) {
            const idx = (skip || 0) + i;
            const isMerge = idx % 7 === 3;
            const parents = isMerge ? ['p' + (idx + 1), 'side' + idx] : (idx < 19 ? ['p' + (idx + 1)] : []);
            commits.push({
                sha: 'c' + idx.toString().padStart(6, '0'),
                parents,
                refs: idx === 0 ? 'HEAD -> mock/main, origin/mock/main' : (idx % 5 === 0 ? 'tag: v1.0.' + idx : ''),
                author: 'CandySweet',
                email: 'candy@example.com',
                date: '2026-11-' + String(8 - (idx % 8)).padStart(2, '0') + ' 12:00',
                subject: (isMerge ? 'Merge branch ' : '提交 ') + idx,
                dotPos: 0,
                dotFlow: 1,
            });
        }
        // 简单泳道：字形直译模型（与 Go 侧 --graph 解析一致：dotPos=圆点字形位，
        // rows=组行数，glyphs=[{r,p,c,f}] 组内字形，前端按 Gitea 映射逐字形画段）
        commits.forEach((c, i) => {
            const isMerge = c.parents.length > 1;
            c.dotPos = 0;
            c.dotFlow = 1;
            c.rows = 1;
            c.glyphs = [{ r: 0, p: 0, c: '*', f: 1 }];
            if (isMerge) {
                c.rows = 2;
                c.glyphs = [
                    { r: 0, p: 0, c: '*', f: 1 },
                    { r: 1, p: 0, c: '|', f: 1 },
                    { r: 1, p: 1, c: '\\', f: 2 },
                ];
            } else if (i % 11 === 5) {
                c.dotPos = 2;
                c.dotFlow = 2;
                c.glyphs = [{ r: 0, p: 2, c: '*', f: 2 }];
            }
        });
        return {
            available: true, root: dir, headBranch: window.__mockBranch || 'mock/main',
            ref: ref || '', commits, laneCount: 2,
            hasMore: (skip || 0) + n < 100, nextSkip: (skip || 0) + n,
        };
    },
    async GitGraphRefs(dir) {
        if (!mockScenario.has('gitmock')) {
            return {available: false, reason: 'mock 无 git', local: [], remote: [], tags: [], worktrees: []};
        }
        const current = window.__mockBranch || 'mock/main';
        return {
            available: true, root: dir, current, headSha: 'c000000',
            local: [
                {name: 'mock/main', sha: 'c000000', current: current === 'mock/main'},
                {name: 'mock/feature', sha: 'c000003', current: current === 'mock/feature'},
                {name: 'hotfix/1.0.1', sha: 'c000005', current: current === 'hotfix/1.0.1'},
            ],
            remote: [
                {name: 'origin/mock/main', sha: 'c000000'},
                {name: 'origin/mock/feature', sha: 'c000003'},
            ],
            tags: [
                {name: 'v1.1.0', sha: 'c000002'},
                {name: 'v1.0.1', sha: 'c000005'},
                {name: 'v1.0.0', sha: 'c000009'},
            ],
            worktrees: (window.__mockWorktrees || []).map((w) => ({
                name: 'cadt/wt/' + w.name, sha: w.baseSha, worktree: '.cadt/worktree/' + w.name,
            })),
        };
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
    async GitGraphCheckout(dir, ref) {
        window.__mockBranch = ref;
        return {success: true, output: '[mock] 图谱签出 ' + ref, branch: ref};
    },
    async GitGraphReset(dir, sha, mode) {
        return {success: true, output: '[mock] 重置（' + mode + '）到 ' + sha};
    },
    async GitGraphCherryPick(dir, sha) {
        return {success: true, output: '[mock] cherry-pick ' + sha};
    },
    async GitGraphCreateBranch(dir, name, sha, checkout) {
        if (checkout) window.__mockBranch = name;
        return {success: true, output: '[mock] branch ' + name + ' @ ' + sha, branch: name};
    },
    async GitGraphCheckoutForce(dir, ref) {
        window.__mockBranch = ref;
        return {success: true, output: '[mock] checkout -f ' + ref, branch: ref};
    },
    async GitGraphCheckoutSmart(dir, ref) {
        window.__mockBranch = ref;
        return {success: true, output: '[mock] stash + checkout + stash pop ' + ref, branch: ref};
    },
    async GitGraphCommitBody(dir, sha) {
        return 'mock 正文第 1 行\n\nmock 正文第 2 行';
    },
    async GitGraphCommitFiles(dir, sha) {
        return [
            {path: 'frontend/src/git-graph/git-graph.js', status: 'M'},
            {path: 'internal/gitinfo/graph.go', status: 'M'},
            {path: 'docs/finished-plans/graph-lanes.md', status: 'A'},
            {path: 'frontend/src/dev/mock-backend.js', status: 'M'},
            {path: 'old-name.js', oldPath: 'legacy.js', status: 'R'},
        ];
    },
    async GitGraphCommitFileDiff(dir, sha, path, maxLines) {
        return {
            hasChanges: true,
            diff: 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1 +1 @@\n-旧内容\n+新内容（' + sha + ' 的 mock diff）\n',
        };
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
    // read_video 的读取通道：mock 环境造不出真 mp4（magic 校验过不了），直接报错
    async ReadVideoAsDataURL(path) {
        throw new Error('mock 环境不读取视频');
    },
    // read_image 的网图通道：dev 下给一张 8×8 png 占位，不真联网
    async WebFetchImage(url) {
        window.__mockWebFetchImage = {url};
        return {
            url,
            finalUrl: url,
            status: 200,
            contentType: 'image/png',
            name: '',
            bytes: 68,
            dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mNkYPjPgAyYGBgYmRgAHPoBG0gGtMUAAAAASUVORK5CYII=',
        };
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
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable', source: 'gitee'});
        st.mode = mode === 'appdata' ? 'appdata' : 'portable';
    },
    async GetDataSource() {
        return (window.__mockPlugins || {}).source === 'github' ? 'github' : 'gitee';
    },
    async SetDataSource(source) {
        const st = window.__mockPlugins || (window.__mockPlugins = {present: true, disabled: {}, mode: 'portable', source: 'gitee'});
        st.source = source === 'github' ? 'github' : 'gitee';
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
        // 数据源为 GitHub 时，展示镜像地址（与真实后端 GetPluginMarket 行为一致）
        if (this.GetDataSource && (await this.GetDataSource()) === 'github') {
            for (const it of items) {
                it.url = it.url.replace('https://gitee.com/', 'https://github.com/');
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
    async OpenHarnessWindow() { window.__mockHarnessWindow = (window.__mockHarnessWindow || 0) + 1; },
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
    // 窗口注册表 / 跨窗口会话复用（window_app.go）：浏览器 dev 无跨窗口概念，全部空实现
    async WindowRegister(workspace, seq) { window.__mockWindowReg = workspace || ''; window.__mockWindowRegSeq = Number(seq) || 0; },
    // --harness 窗口探测（不恢复工作区、独立会话快照槽）：mock 下默认关，dev 可置位验证
    async GetWindowHarness() { return !!window.__mockHarnessWindow; },
    async WindowReuseForSession(workspace, sessionId) {
        window.__mockWindowReuse = {workspace, sessionId: sessionId || ''};
        return ''; // mock 永远没有可用窗口：走软切换行为
    },
    async WindowReuseResult(reqId, status) { window.__mockWindowReuseResult = {reqId, status}; },
    async RegisterEventOwner(kind, id) { window.__mockEventOwners = (window.__mockEventOwners || []).concat([[kind, id]]); },
    async UnregisterEventOwner(kind, id) { window.__mockEventOwnerOff = {kind, id}; },
    async WindowActivate() { window.__mockWindowActivated = true; },
    async ShowInFolder(path) { window.__mockShowInFolder = path; },
    // 操作记录（应用页面 → 操作记录）：合成一批记录，覆盖「有参数 / 长对象 / 短对象」三种形态，
    // 让列表、展开区、复制、分页在 dev 浏览器里都能实测（缺这条 mock 时该页永远走「旧版后端」分支）。
    async ActivityRead(queryJSON) {
        const q = JSON.parse(queryJSON || '{}');
        const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
        let list = mockActivityEntries();
        const actions = Array.isArray(q.actions) ? q.actions.filter(Boolean) : [];
        if (actions.length) {
            list = list.filter((e) => actions.some((a) => e.action === a || e.action.startsWith(a + '.')));
        }
        if (q.actor) list = list.filter((e) => e.actor === q.actor);
        if (q.keyword) {
            const kw = String(q.keyword).toLowerCase();
            list = list.filter((e) => (e.action + ' ' + e.target + ' ' + JSON.stringify(e.detail || '')).toLowerCase().includes(kw));
        }
        if (q.beforeTs > 0) {
            list = list.filter((e) => (q.beforeSeq > 0
                ? e.ts < q.beforeTs || (e.ts === q.beforeTs && e.seq < q.beforeSeq)
                : e.ts < q.beforeTs));
        }
        if (q.sinceTs > 0) list = list.filter((e) => e.ts >= q.sinceTs);
        return JSON.stringify({
            entries: list.slice(0, limit),
            truncated: list.length > limit,
            files: ['2026-11.jsonl'],
        });
    },
    async ActivityAppend(entriesJSON) {
        window.__mockActivityAppends = (window.__mockActivityAppends || []).concat([entriesJSON]);
    },
    async ActivityPath() { return 'C:\\Users\\dev\\AppData\\Roaming\\CandySweet\\CaDt-DataLens\\activity'; },
    async ActivityClear() { window.__mockActivityCleared = (window.__mockActivityCleared || 0) + 1; },
    async OpenWithDefaultApp(path) { window.__mockOpenWithDefaultApp = path; },
    async StorageScan(root) { return buildMockStorageReport(root); },
    async StorageClear(ids, root) { return applyMockStorageClear(ids, root); },
    async LogFrontend(level, message) { (window.__mockLogs = window.__mockLogs || []).push(level + ': ' + message); },
    async GetDeveloperMode() { return !!window.__mockDevMode; },
    async SetDeveloperMode(on) { window.__mockDevMode = !!on; },
    async GetLogPath() { return 'C:\\Users\\dev\\AppData\\Roaming\\CandySweet\\CaDt-DataLens\\logs\\2026-11-09_13-00-00.txt'; },
    async OpenLogDir() { window.__mockOpenLogDir = (window.__mockOpenLogDir || 0) + 1; },
    async CopyText(text) { window.__mockCopied = text; window.__mockClipboard = text; },
    async SaveDataURL(path) { window.__mockSaved = path; return path; },
    async CopyFileTo(srcPath) { return srcPath; },
    async GetClipboardText() { return window.__mockClipboard || ''; },
    // mock：浏览器调试时没有系统剪贴板图片，用 window.__mockClipboardImage 模拟 data URL。
    async GetClipboardImage() { return window.__mockClipboardImage || ''; },
    // mock：快捷便签存储。内存态按「作用域+工作区」键缓存，CAS 只对 mtime 做等值比较。
    async MemoLoad(scope, workspace) {
        const store = window.__mockMemo = window.__mockMemo || {};
        const key = scope + '|' + (workspace || '');
        if (!store[key]) store[key] = {data: '{"version":1,"updatedAt":0,"blocks":[]}', mtimeMs: 0};
        return JSON.stringify({data: store[key].data, mtimeMs: store[key].mtimeMs});
    },
    async MemoSave(scope, workspace, doc, baseMtimeMs) {
        const store = window.__mockMemo = window.__mockMemo || {};
        const key = scope + '|' + (workspace || '');
        const cur = store[key];
        if (baseMtimeMs > 0 && (!cur || cur.mtimeMs !== baseMtimeMs)) {
            return {ok: false, conflict: true, error: 'conflict: 快捷便签已在其他窗口修改'};
        }
        if (baseMtimeMs === 0 && cur && cur.mtimeMs > 0) {
            return {ok: false, conflict: true, error: 'conflict: 快捷便签已在其他窗口创建'};
        }
        store[key] = {data: String(doc || ''), mtimeMs: Date.now()};
        return {ok: true, mtimeMs: store[key].mtimeMs};
    },
    async MemoSaveImage(scope, workspace, dataURL) {
        window.__mockMemoImages = window.__mockMemoImages || [];
        window.__mockMemoImages.push({scope, workspace, bytes: String(dataURL || '').length});
        return 'img/img-' + Date.now().toString(36) + '.png';
    },
    // mock：便签写权租约。window.__mockMemoLeaseBusy=true 可模拟另一窗口正在编辑。
    async MemoLeaseAcquire(scope, workspace, label) {
        const key = scope + '|' + (workspace || '');
        if (window.__mockMemoLeaseBusy) {
            return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}};
        }
        window.__mockMemoLeases = window.__mockMemoLeases || {};
        window.__mockMemoLeases[key] = (window.__mockMemoLeases[key] || 0) + 1;
        return {acquired: true, busy: false, owner: {pid: 1, label: String(label || 'mock')}};
    },
    async MemoLeaseRelease(scope, workspace) {
        const key = scope + '|' + (workspace || '');
        const leases = window.__mockMemoLeases = window.__mockMemoLeases || {};
        if (leases[key] > 0) leases[key]--;
        return null;
    },
    async MemoLeaseStatus(scope, workspace) {
        const key = scope + '|' + (workspace || '');
        const leases = window.__mockMemoLeases = window.__mockMemoLeases || {};
        if (leases[key] > 0) return {acquired: true, busy: false, owner: {pid: 1, label: 'mock'}};
        if (window.__mockMemoLeaseBusy) return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}};
        return {acquired: false, busy: false};
    },
    // mock：认知索引三件（CognitionRead / CognitionEdit / CognitionStatus）。dev 浏览器调试
    // 用——卷是 3 条样例条目（含目录条目），让「认知索引」应用页面在 dev 下有东西可看；
    // 指纹按工作区稳定（CAS base 自洽），edit 模拟成功。
    async CognitionRead(workspace, reqJSON) {
        const req = JSON.parse(reqJSON || '{}');
        const sample = [
            {path: 'frontend/src/core/app-pages.js', labels: ['registry'], f: '应用页面注册表：可开成内容区标签页的功能页单一来源', r: 'frontend/src/bridge/bridge-app-page-view.js', a: 'APP_PAGES / appPageOf / appPageGroups', s: '视图工厂不进表（core/ 不反向依赖域）'},
            {path: 'frontend/src/ai/', labels: ['domain', 'dir'], dir: true, f: 'AI 域模块目录：面板、群聊、调度、认知索引等'},
            {path: 'internal/cognition/service.go', f: '认知索引引擎：Read / Edit（CAS）/ Status / 清理门闩', a: 'CognitionRead 收发 JSON 字符串', s: '写路径全部在同一把独占租约内（src=service.go 头注释）'},
        ];
        const prefixes = (Array.isArray(req.paths) ? req.paths : []).map((p) => String(p || '').toLowerCase().replace(/\\/g, '/')).filter(Boolean);
        const labels = (Array.isArray(req.labels) ? req.labels : []).map((l) => String(l || '').toLowerCase()).filter(Boolean);
        const query = String(req.query || '').trim().toLowerCase();
        const filterOn = prefixes.length > 0 || labels.length > 0 || query !== '';
        const hit = sample.filter((e) => {
            const key = e.path.toLowerCase();
            if (prefixes.length && !prefixes.some((pre) => key.startsWith(pre))) return false;
            if (labels.length && !(e.labels || []).some((t) => labels.includes(String(t).toLowerCase()))) return false;
            if (query && ![e.f, e.r, e.a, e.s].some((v) => v && String(v).toLowerCase().includes(query))) return false;
            return true;
        });
        if (filterOn) {
            return JSON.stringify({
                exists: true,
                mode: 'entries',
                text: '命中 ' + hit.length + ' 条：\n' + hit.map((e) => e.path + '\t' + (e.labels || []).join(' ')).join('\n'),
                hitCount: hit.length,
                hitEntries: hit,
                fingerprint: 'mock' + String(workspace || '').length.toString(16) + 'deadbeef',
            });
        }
        return JSON.stringify({
            exists: true,
            mode: 'overview',
            text: '认知索引 overview：' + sample.length + ' 条（mock dev 环境样例卷）',
            fingerprint: 'mock' + String(workspace || '').length.toString(16) + 'deadbeef',
            scene: 'code',
            entries: sample.length,
            bytes: 1024,
            lines: sample.map((e) => ({path: e.path, labels: e.labels, dir: !!e.dir})),
        });
    },
    async CognitionEdit(workspace, reqJSON) {
        const req = JSON.parse(reqJSON || '{}');
        const warnings = ['mock dev 环境：未写真实卷'];
        if (typeof req.ignore === 'string' && req.ignore.trim()) {
            warnings.push('mock dev 环境：ignore 参数已受理（未写真实卷），排除表不生效');
        }
        return JSON.stringify({
            applied: true,
            fingerprint: 'mock' + Date.now().toString(16),
            entries: Array.isArray(req.entries) ? req.entries.length : 0,
            bytes: 0,
            bookkept: 0,
            warnings,
        });
    },
    async CognitionStatus(workspace, verbose) {
        return JSON.stringify({
            exists: true,
            scene: 'code',
            entries: 3,
            bytes: 1024,
            budgetEntries: 600,
            budgetBytes: 262144,
            fingerprint: 'mock' + String(workspace || '').length.toString(16) + 'deadbeef',
            hasBaseline: true,
            // 样例非 0：让应用页面的 drift 徽标在 dev 下有形态可看
            missing: {total: 1},
            orphan: {total: 0},
            stale: {total: 1},
            unbaselined: {total: 0},
        });
    },
    // mock：便签写权租约。window.__mockMemoLeaseBusy=true 可模拟另一窗口正在编辑。
    async MemoLeaseAcquire(scope, workspace, label) {
        const key = scope + '|' + (workspace || '');
        if (window.__mockMemoLeaseBusy) {
            return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}};
        }
        window.__mockMemoLeases = window.__mockMemoLeases || {};
        window.__mockMemoLeases[key] = (window.__mockMemoLeases[key] || 0) + 1;
        return {acquired: true, busy: false, owner: {pid: 1, label: String(label || 'mock')}};
    },
    async MemoLeaseRelease(scope, workspace) {
        const key = scope + '|' + (workspace || '');
        const leases = window.__mockMemoLeases = window.__mockMemoLeases || {};
        if (leases[key] > 0) leases[key]--;
        return null;
    },
    async MemoLeaseStatus(scope, workspace) {
        const key = scope + '|' + (workspace || '');
        const leases = window.__mockMemoLeases = window.__mockMemoLeases || {};
        if (leases[key] > 0) return {acquired: true, busy: false, owner: {pid: 1, label: 'mock'}};
        if (window.__mockMemoLeaseBusy) return {acquired: false, busy: true, owner: {pid: 999, label: '另一窗口'}};
        return {acquired: false, busy: false};
    },
    async ForceClose() { window.__mockForceClosed = (window.__mockForceClosed || 0) + 1; },
    async SetWindowCollapsed(collapsed) { window.__mockWindowCollapsed = !!collapsed; },
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
    // 外部工具（应用页面 → 外部工具）：mock 只在内存里保存来源矩阵，便于浏览器调试页面。
    async WebToolsConfigGet() {
        return window.__mockExternalTools || {
            enabled: false,
            baseUrl: '',
            apiKeySet: false,
            searchCount: 10,
            capabilities: {
                search: {mode: 'builtin'}, fetch: {mode: 'builtin'},
                ocr: {mode: 'off'}, tts: {mode: 'off'}, asr: {mode: 'off'},
            },
            mcpBindings: {search: '', fetch: '', ocr: '', tts: '', asr: ''},
            defaultBaseUrl: 'https://api.deepseek.com/v1/tools',
        };
    },
    async WebToolsConfigSave(payload) {
        const prev = await this.WebToolsConfigGet();
        const next = Object.assign({}, prev, payload || {});
        next.apiKeySet = !!((payload && payload.apiKey) || prev.apiKeySet);
        delete next.apiKey;
        window.__mockExternalTools = next;
    },
    async WebToolsConfigClearKey() {
        const prev = await this.WebToolsConfigGet();
        window.__mockExternalTools = Object.assign({}, prev, {apiKeySet: false});
    },
    // ---- wipe-guard（工作区破坏防护）：内存态 mock，够 dev 模式冒烟 ----
    async WipeGuardConfigure(settings) {
        window.__mockWipeGuard = Object.assign({enabled: true, snapshots: true, backupRoot: ''}, window.__mockWipeGuard, settings || {});
        return window.__mockWipeGuard;
    },
    async WipeGuardFingerprint(ws) {
        return {rootEntries: 8, depth1Dirs: 5, markers: {'.git': true, 'go.mod': true}, fileCount: 1611, sampled: false};
    },
    async WipeGuardCompare(before, after) {
        if (after && before && after.rootEntries <= 1 && before.rootEntries >= 5) {
            return {level: 'critical', reason: '整仓顶层条目被清空（' + before.rootEntries + ' → ' + after.rootEntries + '）'};
        }
        return {level: '', reason: ''};
    },
    async WipeGuardAlarm(level, reason, detail) {
        window.__mockWipeGuardAlarms = window.__mockWipeGuardAlarms || [];
        window.__mockWipeGuardAlarms.push({level, reason, detail, at: Date.now()});
    },
    async WipeGuardBackup(call) {
        window.__mockWipeGuardRows = window.__mockWipeGuardRows || [];
        const row = {
            id: 'b-' + Date.now() + '-mock',
            ws: 'mock0000', session: call && call.sessionId, tool: (call && call.tool) || 'write_file',
            rel: (call && call.relPath) || '', blob: (call && call.existed) ? '9f86d081884c7d65' : '',
            bytes: call && call.existed ? (call.content || '').length : 0,
            at: Date.now(), skipped: (call && call.existed && (call.content || '').length > 4 * 1024 * 1024) ? 'too-large' : '',
        };
        window.__mockWipeGuardRows.push(row);
        return {entryId: row.id, skipped: row.skipped, bytes: row.bytes};
    },
    async WipeGuardList(ws) { return (window.__mockWipeGuardRows || []).slice().reverse(); },
    async WipeGuardRestore(entryId, ws) { return 'D:\\mock\\' + entryId; },
    async WipeGuardClear() { window.__mockWipeGuardRows = []; },
    async WipeGuardStatus(ws) { return {mode: 'git', reason: '有版本控制'}; },
    async WipeGuardSnapshot(ws) { return {mode: 'git', name: '20260119-010000.tar', path: 'D:\\mock\\snap.tar', files: -1, bytes: 550000}; },
    async WipeGuardSnapshotList(ws) {
        return [{name: '20260119-010000.tar', kind: 'tar', at: Date.now() - 600000, bytes: 550000}];
    },
    async WipeGuardSnapshotRestore(ws, name) { return 'D:\\mock\\' + name; },
    async MCPSamplesList() {
        const installed = window.__mockMcpInstalled || new Set();
        const base = [
            {id: 'tts_sapi', name: 'Windows 语音合成（SAPI）', description: '用系统 SAPI 把文本合成 WAV 文件，离线、零安装。', capability: 'tts', serverName: 'tts_sapi', toolName: 'tts_sapi', publicToolName: 'mcp__tts_sapi__tts_sapi', prerequisites: ['Windows PowerShell 5.1（Win10/11 自带，无需另装 PowerShell 7）'], envKeys: [], scriptPath: 'C:\\mock\\builtin-mcp-samples\\tts-sapi.ps1', scriptExists: false, commandPreview: 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\mock\\tts-sapi.ps1', clientEnabled: true},
            {id: 'ocr_windows', name: 'Windows OCR（系统引擎）', description: '用 Windows.Media.Ocr 识别图片中的文字。', capability: 'ocr', serverName: 'ocr_windows', toolName: 'ocr_windows', publicToolName: 'mcp__ocr_windows__ocr_windows', prerequisites: ['Windows PowerShell 5.1', 'OCR 语言包'], envKeys: [], scriptPath: 'C:\\mock\\builtin-mcp-samples\\ocr-windows.ps1', scriptExists: false, commandPreview: 'powershell -File C:\\mock\\ocr-windows.ps1', clientEnabled: true},
            {id: 'asr_whisper', name: 'whisper.cpp 语音识别', description: '用本机 whisper.cpp 把音频转成文字。', capability: 'asr', serverName: 'asr_whisper', toolName: 'asr_whisper', publicToolName: 'mcp__asr_whisper__asr_whisper', prerequisites: ['Python 3.9+', 'whisper.cpp', 'ggml 模型'], envKeys: ['WHISPER_CLI', 'WHISPER_MODEL'], scriptPath: 'C:\\mock\\builtin-mcp-samples\\asr-whisper.py', scriptExists: false, commandPreview: 'python -u C:\\mock\\asr-whisper.py', clientEnabled: true},
        ];
        return base.map((item) => Object.assign({}, item, {installed: installed.has(item.id)}));
    },
    async MCPInstallSample(id) {
        window.__mockMcpInstalled = window.__mockMcpInstalled || new Set();
        window.__mockMcpInstalled.add(id);
        return {installed: true, id, publicToolName: 'mcp__' + id + '__' + id, note: 'mock 安装完成'};
    },
    // MCP 配置读口（桌面控制可用性判定 + 外部工具页共用）：mock 维护一份最小配置，
    // 已装的内置示例/桌面组件写进对应行，让 dev 模式的「装没装」判定走真实路径——
    // 缺这个方法时 refreshDesktopAvailability 会把 configKnown=false、判定退化成 FAILED。
    async MCPGetConfig() {
        const installed = window.__mockMcpInstalled || new Set();
        const mcpServers = {};
        if (installed.has('tts_sapi')) {
            mcpServers.tts_sapi = {command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\mock\\tts-sapi.ps1'], enabledTools: ['tts_sapi']};
        }
        if (installed.has('ocr_windows')) {
            mcpServers.ocr_windows = {command: 'powershell', args: [], enabledTools: ['ocr_windows']};
        }
        if (installed.has('asr_whisper')) {
            mcpServers.asr_whisper = {command: 'python', args: ['-u', 'C:\\mock\\asr-whisper.py'], enabledTools: ['asr_whisper']};
        }
        if (window.__mockDesktopInstall && window.__mockDesktopInstall.done) {
            mcpServers.windows = {command: 'uvx', args: ['--from', 'C:\\mock\\windows_mcp.whl', 'windows-mcp', 'serve', '--no-control'], enabledTools: ['Snapshot']};
        }
        return {version: 1, mcpServers};
    },
    // MCP 运行态快照：mock 没有真实 server 进程，返回空列表 + enabled=true，
    // 让 getState().loaded=true，桌面判定不会因「快照没拉到」误报。
    async MCPSnapshot() {
        return {enabled: true, servers: []};
    },
    // 桌面控制「安装…」：mock 只回成功步骤（真装依赖要下载 uv / Python，dev 环境不跑）
    async MCPDesktopInstall() {
        return {ok: true, steps: ['uv 已就绪', '预热 windows-mcp 依赖']};
    },
    // 桌面控制安装计划：与 Go 侧 internal/desktopmcp.BuildPlan 同形（21 个工具 + 内置 wheel 路径）
    async MCPDesktopPlan() {
        const tools = [
            {name: 'Snapshot', note: '屏幕截图 + 可交互元素树'},
            {name: 'Screenshot', note: '纯截图，不提取元素'},
            {name: 'DisplayInventory', note: '显示器清单与坐标系'},
            {name: 'Click', note: '点击 / 双击 / 右键'},
            {name: 'Type', note: '输入文本（可按元素编号定位）'},
            {name: 'Scroll', note: '滚动'},
            {name: 'Move', note: '移动指针 / 拖拽'},
            {name: 'Shortcut', note: '键盘快捷键'},
            {name: 'Wait', note: '固定时长等待'},
            {name: 'WaitFor', note: '等元素 / 窗口 / 文本出现'},
            {name: 'Find', note: '按名字找元素并直接点击 / 输入'},
            {name: 'Clipboard', risk: 'high', note: '读写系统剪贴板'},
            {name: 'Scrape', note: '抓取网页正文（可选当前页 DOM）'},
            {name: 'MultiSelect', note: '批量点选'},
            {name: 'MultiEdit', risk: 'high', note: '批量填充输入框'},
            {name: 'App', risk: 'high', note: '启动程序 / 切换与调整窗口'},
            {name: 'Notification', risk: 'high', note: '弹系统通知'},
            {name: 'Process', risk: 'high', note: '进程列表与结束进程'},
            {name: 'PowerShell', risk: 'high', note: '执行任意 PowerShell 脚本'},
            {name: 'FileSystem', risk: 'high', note: '读写任意路径文件'},
            {name: 'Registry', risk: 'high', note: '读写注册表'},
            {name: 'ControlStatus', note: '上游的接管状态查询'},
        ];
        const wheelPath = 'C:\\mock\\builtin-desktop-mcp\\0.8.9\\windows_mcp-0.8.9-py3-none-any.whl';
        return {
            version: '0.8.9',
            serverName: 'windows',
            wheelPath,
            wheelReady: true,
            command: 'uvx',
            args: ['--from', wheelPath, 'windows-mcp', 'serve', '--no-control'],
            enabledTools: tools.map((tool) => tool.name),
            startupTimeoutMs: 600000,
            notes: '桌面控制（Computer Use）：mock 环境的使用约定。',
            tools,
        };
    },
    // 异步安装：mock 分三段推事件后收尾（不真下载）
    async MCPDesktopInstallStart() {
        const rt = window.__wailsRuntime;
        const emit = (payload) => {
            if (rt && rt.EventsEmit) rt.EventsEmit('mcp-desktop-install', payload);
        };
        window.__mockDesktopInstall = {running: true, percent: 1, stage: 'release', detail: '准备安装'};
        setTimeout(() => emit({phase: 'running', stage: 'release', detail: '释放内置桌面组件', percent: 10}), 20);
        setTimeout(() => emit({phase: 'running', stage: 'warm', detail: '下载 Python 与依赖', percent: 45, line: 'Resolving packages…'}), 120);
        setTimeout(() => {
            window.__mockDesktopInstall = {running: false, done: true, percent: 100, stage: 'done', detail: '安装完成'};
            emit({phase: 'done', stage: 'done', detail: '安装完成', percent: 100, steps: ['释放内置组件 windows-mcp 0.8.9', 'uv 已就绪', '预热 windows-mcp 依赖']});
        }, 260);
        return {started: true};
    },
    async MCPDesktopInstallStatus() {
        const st = window.__mockDesktopInstall || {running: false, done: false, percent: 0, stage: '', detail: ''};
        return {
            running: !!st.running,
            done: !!st.done,
            failed: false,
            error: '',
            progress: {stage: st.stage || '', detail: st.detail || '', percent: st.percent || 0},
        };
    },
    async ExternalSearch() { throw new Error('mock 环境不调用外部服务'); },
    async ExternalFetch() { throw new Error('mock 环境不调用外部服务'); },
    async ExternalOCR() { throw new Error('mock 环境不调用外部服务'); },
    async ExternalTTS() { throw new Error('mock 环境不调用外部服务'); },
    async ExternalASR() { throw new Error('mock 环境不调用外部服务'); },
    async ReadAudioDataURL() { throw new Error('mock 环境不读取音频'); },
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
        // 群成员只读工具（G5）：roundId 带 #（群命名空间）且下发了工具时模拟一轮 read_file；
        // 真正的读取由面板 execMemberTool 走 mock OpenFile 完成，这里只负责「模型决定调工具」。
        // schedule 在下方定义，工具模拟统一挪到 schedule 之后（见 hasReadTool 分支）
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
        // 群成员只读工具（G5）：roundId 带 #（群命名空间）且下发了 read_file 时模拟一轮工具调用；
        // 真正的读取由面板 execMemberTool 走 mock OpenFile 完成，这里只负责「模型决定调工具」
        const isGroupRound = /#/.test(String(sessionId || ''));
        // 接力轮（G7）：接力焦点（棒次/回问/纪要）出现时不走 G5 工具模拟，让链能推进
        const relayRound = isGroupRound && /接力第|【交棒】|成果纪要/.test(prompt);
        const hasReadTool = (tools || []).some((tool) => tool && tool.name === 'read_file');
        const lastIsToolResult = !!(messages || []).length && ((messages[messages.length - 1] || {}).role === 'tool');
        if (isGroupRound && !relayRound && hasReadTool && !lastIsToolResult) {
            const mention = (prompt.match(/[\w\u4e00-\u9fff-]+\.(?:md|json|txt|csv|yaml)/) || [])[0] || 'sample.json';
            const gmArgs = '{"path": "' + mention + '"}';
            const gmChunks = gmArgs.match(/.{1,16}/gs) || [];
            schedule(() => emit('ai-chunk', {id: sessionId, delta: '我先读一下工作区里的这份文件。\n\n'}), 20);
            gmChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-toolcall', {
                    id: sessionId,
                    index: 0,
                    callId: i === 0 ? 'call_mock_gm_read' : '',
                    name: i === 0 ? 'read_file' : '',
                    argsDelta: chunk,
                }), 60 + i * 40);
            });
            schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 90 + gmChunks.length * 40 + 50);
            return null;
        }
        if (isGroupRound && !relayRound && hasReadTool && lastIsToolResult) {
            const toolMsg = messages[messages.length - 1];
            const finalText = '（mock）已用 read_file 读了「' + String(toolMsg.name || 'file') + '」，结果开头：\n\n> '
                + String(toolMsg.content || '').split('\n').slice(0, 6).join('\n> ')
                + '\n\n成员先读文件再发言——G5 只读工具链路工作正常。';
            const finalChunks = finalText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let finalDelay = 30;
            finalChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), finalDelay + i * slow);
            });
            finalDelay += finalChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop', usage: {promptTokens: 40, completionTokens: 56, totalTokens: 96, cachedTokens: 0}});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, finalDelay + 40);
            return null;
        }
        // 接力模式（G7）：带接力焦点时按棒次产出可区分的 mock 回复——常规棒末尾带
        // 【交棒】（链能推进到下一棒）；被回问的回答与链尾成果纪要不带标记
        if (relayRound) {
            const isAnswer = prompt.includes('不要写【交棒】');
            const isSummary = prompt.includes('成果纪要');
            const stageMatch = /接力第 (\d+)\/(\d+) 棒/.exec(prompt);
            let relayText;
            if (isSummary) {
                relayText = '## 成果纪要（mock）\n\n- 目标：完成本次接力任务\n- 各棒产出：见上方各成员发言\n- 最终成果：mock 汇总完成\n- 遗留问题：无';
            } else if (isAnswer) {
                relayText = '（mock 回答）就你回问的点：按共享对话里已有产出，可以直接接着做。';
            } else if (stageMatch) {
                relayText = `〔mock 第 ${stageMatch[1]}/${stageMatch[2]} 棒〕已按需求产出本棒结果（mock 演示）。\n\n【交棒】`;
            } else {
                relayText = '〔mock 成员〕已产出本棒结果（mock 演示）。\n\n【交棒】';
            }
            const relayChunks = relayText.match(/[^\n]{1,8}|[\n]{1,2}/g) || [];
            let relayDelay = 30;
            relayChunks.forEach((chunk, i) => {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: chunk}), relayDelay + i * slow);
            });
            relayDelay += relayChunks.length * slow;
            schedule(() => {
                emit('ai-done', {id: sessionId, finishReason: 'stop', usage: {promptTokens: 40, completionTokens: 56, totalTokens: 96, cachedTokens: 0}});
                (window.__mockAiRuns || new Map()).delete(sessionId);
            }, relayDelay + 40);
            return null;
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
        if (mockScenario.has('aisearchfile')) {
            // search_text 单文件起点：path 直接给文件，结果应只含该文件
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我在单个文件里搜一下。\n\n'}), 20);
                const args = '{"query":"name","path":"mock://samples/sample.json"}';
                const argChunks = args.match(/.{1,16}/gs) || [];
                argChunks.forEach((chunk, i) => {
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: i === 0 ? 'call_mock_search' : '',
                        name: i === 0 ? 'search_text' : '',
                        argsDelta: chunk,
                    }), 60 + i * 40);
                });
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 120 + argChunks.length * 40);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '搜索完成：' + String(lastTool.content || '').slice(0, 200);
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
        if (mockScenario.has('aiapproval')) {
            // 高危动作审批链路：发一条 app_control set_setting_row（子代理层级，high 风险），
            // 由真实面板弹 composer 接管卡；批准/拒绝后继续收尾。
            const toolMessages = (messages || []).filter((message) => message.role === 'tool');
            if (!toolMessages.length) {
                schedule(() => emit('ai-chunk', {id: sessionId, delta: '我来调整子代理层级上限。\n\n'}), 20);
                const args = '{"action":"set_setting_row","params":{"id":"ai-opt-subagent-depth","value":6}}';
                const argChunks = args.match(/.{1,16}/gs) || [];
                argChunks.forEach((chunk, i) => {
                    schedule(() => emit('ai-toolcall', {
                        id: sessionId,
                        index: 0,
                        callId: i === 0 ? 'call_mock_approval' : '',
                        name: i === 0 ? 'app_control' : '',
                        argsDelta: chunk,
                    }), 60 + i * 40);
                });
                schedule(() => emit('ai-done', {id: sessionId, finishReason: 'tool'}), 120 + argChunks.length * 40);
                return null;
            }
            const lastTool = toolMessages[toolMessages.length - 1];
            const finalText = '设置动作已处理：' + String(lastTool.content || '').slice(0, 120);
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
    // mock 环境没有原生窗口判定：退化成页面焦点，行为与真实构建一致（后台才弹系统卡片）
    async AppWindowActive() { return typeof document.hasFocus === 'function' ? document.hasFocus() : true; },
    async NotifyAttention(beep) { window.__mockNotify = (window.__mockNotify || []).concat([!!beep]); },
    async NotifySystemToast(title, body, payload, silent) {
        window.__mockSystemToast = (window.__mockSystemToast || []).concat([{title, body, payload: String(payload || ''), silent: !!silent}]);
    },
    async AITestConnection(cfg) { window.__mockAiTestCfg = cfg; return '连接成功（mock）'; },
    async AIListModels(cfg) { window.__mockAiModelsCfg = cfg; return ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.7-plus', 'kimi-k3.1-pro']; },
    // 图片三层限制（internal/aiimagepolicy 的投影）：数值必须与 Go 侧保持一致，
    // 否则 dev 模式的预检行为会和真机分叉（window.__mockImageLimits 可覆盖做边界演练）。
    async AIImageLimits() {
        return window.__mockImageLimits || {
            maxImagesPerMessage: 10,
            maxSourceImageBytes: 50 * 1024 * 1024,
            maxMessageSourceBytes: 200 * 1024 * 1024,
            maxImagePixels: 64000000,
            maxImageDimension: 65535,
            maxNormalizedDimension: 2048,
            maxNormalizedBase64: 4 * 1024 * 1024,
            maxRequestImageBytes: 32 * 1024 * 1024,
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        };
    },
    // 模型配置表：mock 里不落盘，同步返回一份固定表，便于验证回填与提示行
    async AIModelCatalogCached() { return {text: window.__mockModelCatalog || '', fetchedAt: window.__mockModelCatalogAt || 0}; },
    async AIModelCatalogSync(url) {
        window.__mockModelCatalogUrl = url;
        const text = JSON.stringify({
            version: 'mock-2026.11.15',
            source: 'mock',
            models: [
                {id: 'deepseek-flash', vendor: 'deepseek', contextWindow: 1048576, outputWindow: 393216, modalities: {text: true, image: true}, reasoningEffort: true},
                {id: 'deepseek-v4-pro', vendor: 'deepseek', contextWindow: 1048576, outputWindow: 393216, modalities: {text: true, image: false}, reasoningEffort: true},
                {id: 'claude-sonnet-5-5', vendor: 'anthropic', contextWindow: 1048576, outputWindow: 131072, modalities: {text: true, image: true}, thinking: true, thinkingBudget: false},
            ],
        });
        window.__mockModelCatalog = text;
        window.__mockModelCatalogAt = Math.floor(Date.now() / 1000);
        return {text, fetchedAt: window.__mockModelCatalogAt};
    },
    async AIAppDir() { return 'mock://appdata/CandySweet/CaDt-DataLens'; },
    // 未绑定工作区会话的沙盒目录：mock 没有真实磁盘，返回空串表示「无 backing」，
    // 前端按 scopeRootOf 第 2 步落空（与真实后端「会话不存在/无根」同一退路）。
    async AIBackingWorkspace(sessionId) { return ''; },
    async AIHomeDir() { return window.__mockHomeDir || 'mock://home'; },
    async AIBuiltinSkillsDir() { return window.__mockBuiltinSkillsDir || ''; },
    async AIExePath() { return window.__mockExePath || 'mock://bin/datalens.exe'; },
    // 记忆 / 权限规则的后端写通道（真实后端：跨窗口锁 + 原子替换）。mock 只记内容；
    // 权限规则的「必须是 JSON 对象」校验照做，免得 dev 下把坏 JSON 当成功。
    async AIMemoryWrite(dir, name, content) {
        const path = String(dir || '').replace(/\/+$/, '') + '/' + name;
        window.__mockWrites = window.__mockWrites || {};
        window.__mockWrites[path] = String(content == null ? '' : content);
        window.__mockMemoryWrites = (window.__mockMemoryWrites || []).concat([{path, name, content}]);
        return path;
    },
    async AIProjectRulesWrite(root, jsonText) {
        if (String(jsonText || '').trim() === '') throw new Error('权限规则为空');
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('权限规则不是合法 JSON 对象：顶层必须是对象');
        }
        const path = String(root || '').replace(/\/+$/, '') + '/.cadt/permissions.json';
        window.__mockWrites = window.__mockWrites || {};
        window.__mockWrites[path] = String(jsonText);
        window.__mockPermissionsWrites = (window.__mockPermissionsWrites || []).concat([{path, jsonText}]);
        return path;
    },
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
};
// 调试/测试用：暴露 mock 运行时（仅 mock 场景存在）
// 裸 rt 别名：mockBackend 里 RunExec / term-out / cmd-exit 等事件都写 ，
// 模块里此前没有 rt 绑定（浏览器 dev 下静默 ReferenceError，事件从未发出）。统一指向 mockRt。
const rt = mockRt;
window.__mockRt = mockRt;

export {mockBackend, mockRt};
