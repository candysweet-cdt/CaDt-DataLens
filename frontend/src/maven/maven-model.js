// maven-model.js：Maven 工具窗口的纯函数层——执行开关、命令拼装、
// dependency:tree / effective-pom / effective-settings 文本解析。
// 不碰 DOM、不发请求；pom 结构解析在 Go（internal/mavenproject），这里只收规整好的数据。

import {XMLParser} from 'fast-xml-parser';

// Maven 标准生命周期（固定列表，不随项目变，不解析 pom——方案 §4.3）。
export const MAVEN_LIFECYCLE = ['clean', 'validate', 'compile', 'test', 'package', 'verify', 'install', 'site', 'deploy'];

// 执行开关：id 存进 settings.mavenFlags，arg 是拼进命令行的原文。
export const MAVEN_FLAG_DEFS = [
    {id: 'offline', label: '离线', arg: '-o', tip: '-o：只用本地仓库，不联网'},
    {id: 'skipTests', label: '跳过测试', arg: '-DskipTests', tip: '-DskipTests：构建期间跳过测试'},
    {id: 'updateSnapshots', label: '强制更新快照', arg: '-U', tip: '-U：强制刷新 SNAPSHOT 依赖'},
    {id: 'noTransferProgress', label: '精简进度', arg: '-ntp', tip: '-ntp：大下载时不逐行刷进度'},
];

// settings.mavenFlags 规整成完整布尔表（缺省全关）。
export function mavenFlagsOrDefaults(settings) {
    const flags = (settings && settings.mavenFlags) || {};
    const out = {};
    for (const def of MAVEN_FLAG_DEFS) out[def.id] = !!flags[def.id];
    return out;
}

// 开关 → 命令行参数（保持 MAVEN_FLAG_DEFS 的固定顺序）。
export function mavenFlagArgs(flags) {
    const f = mavenFlagsOrDefaults({mavenFlags: flags});
    return MAVEN_FLAG_DEFS.filter((def) => f[def.id]).map((def) => def.arg);
}

// goal / 参数词元白名单：词元按 argv 传给 RunExec，不经 shell 拼接（方案 §8），
// 但 Windows 外层还有 cmd /c 包装，cmd 元字符（& | < > ^ % ! 引号 空白）会被再解释，一律不收。
const SAFE_TOKEN_RE = /^[A-Za-z0-9_\-:.,+=?@/\\]+$/;

// 模块相对路径白名单：relPath 来自**不可信 pom** 的 <module> 原文，与 goal 词元进同一条
// cmd /c 命令行——goal 有白名单这里也必须有，否则 <module>foo&calc</module> 会绕过整道防线。
// 模块路径本就只需要字母数字与 . / _ -（Go 侧 RelPath 已 ToSlash，`\` 一律异常）。
const SAFE_MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// 把自由文本拆成词元；任一词元含不允许的字符即抛错（错误文案直接给 flash）。
export function splitGoalTokens(text) {
    const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        if (!SAFE_TOKEN_RE.test(token)) {
            throw new Error('参数含不允许的字符：' + token + '（& | < > ^ % 等为 cmd 保留字符）');
        }
    }
    return tokens;
}

// 拼装 RunExec 的 argv（不含 cmd /c 包装——包装在执行层按平台加）：
// [flagArgs..., ('-pl', relPath)?, goalTokens...]。
export function assembleMavenArgs({flags, goal, moduleRelPath} = {}) {
    const args = mavenFlagArgs(flags || {});
    const rel = String(moduleRelPath || '').trim();
    if (rel) {
        if (!SAFE_MODULE_RE.test(rel) || rel.includes('..') || rel.includes(':') || rel.includes('\\')) {
            throw new Error('非法模块路径：' + rel);
        }
        args.push('-pl', rel);
    }
    args.push(...splitGoalTokens(goal));
    if (!args.length) throw new Error('没有可执行的参数');
    return args;
}

// ---------- dependency:tree 文本解析 ----------

// 解析 dependency:tree 输出为节点树，返回顶层根节点数组（通常一个）。
// 兼容带 [INFO] 前缀与 -DoutputFile 纯文本两种形态；节点 {label, scope, children}。
// 缩进口径：树形连接符（+- / \- ）每 3 字符一层；尾注「(omitted …)」截掉不入 label。
export function parseDependencyTreeText(text) {
    const roots = [];
    const stack = []; // stack[d] = 当前深度 d 的最近节点
    for (const raw of String(text || '').split(/\r?\n/)) {
        // 前缀剥掉后必须保留剩余缩进：树形深度靠 +- / \- 前面的 3 字符一层（|  / 空格）。
        // 只剥一个空格——[INFO] 后面的空格属于前缀，再往后就是树形缩进本身。
        const line = raw.replace(/^\[(?:INFO|WARNING|ERROR)\]\s?/, '');
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('[')) continue;
        // 先试连接符（+- / \-，前面每 3 字符一层缩进），剥掉后再验坐标——
        // 顺序反了会把所有带连接符的行当非坐标行跳掉。
        const m = line.match(/^((?:.{3})*?)(?:\+- |\\- )(.+)$/);
        let label = m ? m[2].trim() : trimmed;
        const paren = label.indexOf(' (');
        if (paren > 0) label = label.slice(0, paren).trim();
        if (!isCoordinate(label)) continue; // 头部说明等非坐标行
        const node = {label, scope: coordinateScope(label), children: []};
        if (!m) {
            // 无连接符的坐标行 = 新树根；上一棵树到此为止
            roots.push(node);
            stack.length = 0;
            stack[0] = node;
            continue;
        }
        const depth = m[1].length / 3;
        while (stack.length > depth) stack.pop();
        const parent = stack[depth - 1] || roots[roots.length - 1];
        if (parent) parent.children.push(node);
        stack[depth] = node;
        stack.length = depth + 1;
    }
    return roots;
}

function isCoordinate(text) {
    return /^[\w.-]+:[\w.-]+:[\w.-]+(:[\w.-]+)*$/.test(text);
}

// 坐标 groupId:artifactId:type:version[:scope]——第 5 段是 scope，没有则空（根 / 缺省 compile）。
function coordinateScope(label) {
    const parts = String(label).split(':');
    return parts.length >= 5 ? parts[4] : '';
}

// ---------- effective-pom / effective-settings XML 解析 ----------

const FXP_OPTIONS = {ignoreAttributes: true, parseTagValue: false, trimValues: true};

function xmlParse(text) {
    return new XMLParser(FXP_OPTIONS).parse(String(text || ''));
}

function xmlChild(obj, tag) {
    const v = obj && obj[tag];
    return v === undefined ? null : v;
}

function xmlList(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

function xmlText(v) {
    return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v));
}

// 取文档根节点：help:effective-pom 在聚合根上会按 reactor 输出多个 <project>（fast-xml-parser
// 把同名兄弟收进数组），effective-settings 同理——只取第一个根。
function firstNode(doc, key) {
    const raw = doc && (doc[key] || Object.values(doc || {})[0]);
    return Array.isArray(raw) ? raw[0] : raw;
}

// effective-pom 的 build/plugins——生效插件清单（pluginManagement 已被 Maven 解析进去）。
// 只取顶层 <build><plugins>：Maven 的 help:effective-pom 已把激活 profile 与父 POM 的插件
// 合并到这里，未激活 profile 的插件不在其中（有意为之，不单独展示）。
// 返回 [{groupId, artifactId, version}]；解析失败抛错（调用方负责兜 UI）。
export function parseEffectivePomPlugins(text) {
    const doc = xmlParse(text);
    const project = firstNode(doc, 'project');
    if (!project || typeof project !== 'object') return [];
    const build = xmlChild(project, 'build');
    const plugins = build && xmlChild(build, 'plugins');
    return xmlList(plugins && xmlChild(plugins, 'plugin'))
        .map((p) => ({
            groupId: xmlText(xmlChild(p, 'groupId')),
            artifactId: xmlText(xmlChild(p, 'artifactId')),
            version: xmlText(xmlChild(p, 'version')),
        }))
        .filter((p) => p.artifactId);
}

// effective-settings：本地仓库路径 + 镜像 + profile 注入的远程仓库。
// 返回 {localRepository, mirrors:[{id,url,mirrorOf}], repositories:[{id,url}]}。
export function parseEffectiveSettings(text) {
    const doc = xmlParse(text);
    const settings = firstNode(doc, 'settings');
    const empty = {localRepository: '', mirrors: [], repositories: []};
    if (!settings || typeof settings !== 'object') return empty;
    const mirrorNodes = xmlChild(settings, 'mirrors');
    const mirrors = xmlList(mirrorNodes && xmlChild(mirrorNodes, 'mirror')).map((m) => ({
        id: xmlText(xmlChild(m, 'id')),
        url: xmlText(xmlChild(m, 'url')),
        mirrorOf: xmlText(xmlChild(m, 'mirrorOf')),
    }));
    // 仓库可声明在 settings 根下，也可藏在某个 profile 里——两处都要收，按 id+url 去重。
    const repositories = [];
    const seenRepo = new Set();
    const collectRepos = (owner) => {
        const repos = xmlChild(owner, 'repositories');
        for (const repo of xmlList(repos && xmlChild(repos, 'repository'))) {
            const item = {id: xmlText(xmlChild(repo, 'id')), url: xmlText(xmlChild(repo, 'url'))};
            if (!item.id && !item.url) continue;
            const key = item.id + '|' + item.url;
            if (seenRepo.has(key)) continue;
            seenRepo.add(key);
            repositories.push(item);
        }
    };
    collectRepos(settings);
    const profiles = xmlChild(settings, 'profiles');
    for (const profile of xmlList(profiles && xmlChild(profiles, 'profile'))) {
        collectRepos(profile);
    }
    return {
        localRepository: xmlText(xmlChild(settings, 'localRepository')),
        mirrors,
        repositories,
    };
}
