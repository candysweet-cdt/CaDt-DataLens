import {load as yamlLoad, dump as yamlDump} from 'js-yaml';
import {parse as tomlParse, stringify as tomlStringify} from 'smol-toml';
import {XMLParser, XMLBuilder, XMLValidator} from 'fast-xml-parser';
import Papa from 'papaparse';

const xmlParserOptions = {
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    ignoreDeclaration: true,
    ignorePiTags: true,
    trimValues: false,
};

const xmlBuilderOptions = {
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    format: true,
    indentBy: '  ',
    suppressEmptyNode: false,
};

// ===== 格式辅助与 TOML/INI 解析 =====
function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToml(value) {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(normalizeToml);
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, child] of Object.entries(value)) out[key] = normalizeToml(child);
        return out;
    }
    return value;
}

function parseIni(text) {
    const root = {};
    let section = root;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        const header = line.match(/^\[(.+)\]$/);
        if (header) {
            const name = header[1].trim();
            if (!isPlainObject(root[name])) root[name] = {};
            section = root[name];
            continue;
        }
        const split = line.search(/[=:]/);
        const key = (split < 0 ? line : line.slice(0, split)).trim();
        if (!key) continue;
        let value = split < 0 ? '' : line.slice(split + 1).trim();
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        section[key] = value;
    }
    return root;
}

function iniValue(value) {
    if (value == null) return '';
    if (Array.isArray(value) || isPlainObject(value)) return JSON.stringify(value);
    return String(value);
}

// ===== INI 序列化 =====
function stringifyIni(value) {
    if (!isPlainObject(value)) return '';
    const lines = [];
    const sections = [];
    for (const [key, child] of Object.entries(value)) {
        if (isPlainObject(child)) sections.push([key, child]);
        else lines.push(key + '=' + iniValue(child));
    }
    if (sections.length && lines.length) lines.push('');
    sections.forEach(([name, child], index) => {
        lines.push('[' + name + ']');
        for (const [key, entry] of Object.entries(child)) lines.push(key + '=' + iniValue(entry));
        if (index < sections.length - 1) lines.push('');
    });
    return lines.length ? lines.join('\n') + '\n' : '';
}

export const formats = {
    json: {
        id: 'json',
        name: 'JSON',
        extensions: ['json', 'jsonc', 'json5'],
        aceMode: 'json',
        parse(text) {
            return JSON.parse(text);
        },
        stringify(value) {
            return JSON.stringify(value, null, 2);
        },
    },
    jsonl: {
        id: 'jsonl',
        name: 'JSONL',
        extensions: ['jsonl', 'ndjson'],
        aceMode: 'json',
        parse(text) {
            const values = [];
            const lines = String(text).split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                try {
                    values.push(JSON.parse(lines[i]));
                } catch (e) {
                    throw new Error('第 ' + (i + 1) + ' 行：' + e.message);
                }
            }
            return values;
        },
        stringify(value) {
            const items = Array.isArray(value) ? value : [value];
            return items.map((item) => JSON.stringify(item)).join('\n');
        },
    },
    yaml: {
        id: 'yaml',
        name: 'YAML',
        extensions: ['yaml', 'yml'],
        aceMode: 'yaml',
        parse(text) {
            const value = yamlLoad(text);
            if (value === undefined) throw new Error('空文档');
            return value;
        },
        stringify(value) {
            return yamlDump(value, {indent: 2, lineWidth: -1, noRefs: true});
        },
    },
    xml: {
        id: 'xml',
        name: 'XML',
        extensions: ['xml', 'svg'],
        aceMode: 'xml',
        parse(text) {
            const result = XMLValidator.validate(text);
            if (result !== true) {
                throw new Error(result.err.msg + '（行 ' + result.err.line + '）');
            }
            return new XMLParser(xmlParserOptions).parse(text);
        },
        stringify(value) {
            return new XMLBuilder(xmlBuilderOptions).build(value);
        },
    },
    csv: {
        id: 'csv',
        name: 'CSV',
        extensions: ['csv', 'tsv'],
        aceMode: 'text',
        table: true,
        parse(text) {
            const result = Papa.parse(text, {header: true, skipEmptyLines: 'greedy', dynamicTyping: false});
            if (result.errors.length) throw new Error(result.errors[0].message);
            return result.data;
        },
        parseTable(text) {
            const result = Papa.parse(text, {header: false, skipEmptyLines: 'greedy', dynamicTyping: false});
            if (result.errors.length) throw new Error(result.errors[0].message);
            const data = result.data;
            return {headers: data[0] || [], rows: data.slice(1)};
        },
        stringifyTable(headers, rows) {
            return Papa.unparse([headers, ...rows], {newline: '\n'});
        },
        stringify(value) {
            return Papa.unparse(value, {newline: '\n'});
        },
    },
    toml: {
        id: 'toml',
        name: 'TOML',
        extensions: ['toml'],
        aceMode: 'toml',
        parse(text) {
            return normalizeToml(tomlParse(text));
        },
        stringify(value) {
            return tomlStringify(value);
        },
    },
    ini: {
        id: 'ini',
        name: 'INI/Properties',
        extensions: ['ini', 'properties', 'cfg'],
        aceMode: 'ini',
        parse(text) {
            return parseIni(text);
        },
        stringify(value) {
            return stringifyIni(value);
        },
    },
    markdown: {
        id: 'markdown',
        name: 'Markdown',
        extensions: ['md', 'markdown', 'mdx'],
        aceMode: 'markdown',
        rawOnly: true,
        preview: true,
    },
    // 代码类格式：rawOnly（不解析成结构树），各自独立成组是为了
    // ① 状态栏 / 界面显示正确的语言名（此前全部显示「纯文本」）；
    // ② 每个语言自己的默认缩进（如 Python 4 空格、Go 用 Tab）。
    //   默认缩进在 main.js 的 defaultFormatSettings() 里按组给值。
    python: {
        id: 'python',
        name: 'Python',
        extensions: ['py', 'pyw', 'pyi'],
        aceMode: 'python',
        rawOnly: true,
    },
    golang: {
        id: 'golang',
        name: 'Go',
        extensions: ['go', 'mod', 'work', 'sum'],
        aceMode: 'go',
        rawOnly: true,
    },
    web: {
        id: 'web',
        name: 'Web 前端',
        extensions: ['html', 'htm', 'xhtml', 'css', 'scss', 'less',
            'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue'],
        aceMode: 'text',
        rawOnly: true,
    },
    clang: {
        id: 'clang',
        name: 'C/C++',
        extensions: ['c', 'h', 'cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'ino'],
        aceMode: 'c_cpp',
        rawOnly: true,
    },
    jvm: {
        id: 'jvm',
        name: 'Java/Kotlin/C#',
        extensions: ['java', 'kt', 'kts', 'cs', 'swift', 'scala', 'groovy', 'gradle', 'nf'],
        aceMode: 'java',
        rawOnly: true,
    },
    shell: {
        id: 'shell',
        name: 'Shell/Batch',
        extensions: ['sh', 'bash', 'zsh', 'ksh', 'bat', 'cmd', 'ps1', 'psm1', 'psd1'],
        aceMode: 'sh',
        rawOnly: true,
    },
    script: {
        id: 'script',
        name: 'Ruby/PHP/Lua 等',
        extensions: ['rb', 'php', 'phtml', 'pl', 'pm', 't', 'r', 'lua', 'm', 'mm', 'dart', 'sc'],
        aceMode: 'text',
        rawOnly: true,
    },
    sql: {
        id: 'sql',
        name: 'SQL',
        extensions: ['sql'],
        aceMode: 'sql',
        rawOnly: true,
    },
    patch: {
        id: 'patch',
        name: '补丁',
        extensions: ['patch', 'diff'],
        aceMode: 'diff',
        rawOnly: true,
        patch: true,
    },
    text: {
        id: 'text',
        name: '纯文本',
        extensions: ['txt', 'log', 'conf',
            'mak', 'mk', 'cmake', 'dockerfile',
            'proto', 'graphql', 'gql', 'plist',
            'gitignore', 'gitattributes', 'gitmodules'],
        aceMode: 'text',
        rawOnly: true,
    },
    image: {
        id: 'image',
        name: '图片',
        extensions: [],
        aceMode: 'text',
        rawOnly: true,
        image: true,
    },
    video: {
        id: 'video',
        name: '视频',
        extensions: [],
        aceMode: 'text',
        rawOnly: true,
        video: true,
    },
    audio: {
        id: 'audio',
        name: '音频',
        extensions: [],
        aceMode: 'text',
        rawOnly: true,
        audio: true,
    },
    bytes: {
        id: 'bytes',
        name: '字节数据',
        extensions: [],
        aceMode: 'text',
        rawOnly: true,
    },
};

export const imageExtensions = [
    'png', 'jpg', 'jpeg', 'jfif', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff',
    'avif', 'heic', 'heif', 'psd', 'raw', 'cr2', 'nef', 'arw', 'dng',
];

// 视频容器：与 Go 侧 internal/fileio 的 videoExtensions 保持同表（那边同时看 ftyp/EBML 头，
// 这里只用于「打开对话框能选、拖进来自动打开」的扩展名判定）。
export const videoExtensions = ['mp4', 'm4v', 'webm', 'mov', 'mkv'];

// 音频容器：与 Go 侧 internal/fileio 的 audioExtensions 保持同表（那边同时看
// RIFF-WAVE / fLaC / OggS / ID3 魔数）。只收 WebView2 能解码的格式。
export const audioExtensions = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'];

// ===== 插件格式注册 =====
/**
 * 判定媒体文档（图片 / 视频 / 音频）的首屏视图。
 * 有对应媒体就先给它自己的视图，binary / text 只是手动备份视图。
 * createDoc 的初始 mode 与启动恢复都走这里——持久化下来的 binary
 * （历史版本或播放失败自动回退留下的）不能变成「默认视图」。
 * @param {object|null} source 格式驱动对象，可含 image / video / audio 布尔字段
 * @returns {string} 'image' | 'video' | 'audio' | ''（非媒体返回空串）
 */
export function defaultMediaMode(source) {
    if (!source) return '';
    if (source.video) return 'video';
    if (source.audio) return 'audio';
    if (source.image) return 'image';
    return '';
}

// 插件注册的自定义格式；内置格式优先，插件格式不能覆盖内置格式
/** @type {Array<object>} */
export const pluginFormats = [];

/**
 * 注册插件自定义格式驱动。
 * @param {object} driver 格式驱动对象，需含 id / name / extensions / parse / stringify
 * @returns {object} 归一化后的格式驱动（extensions 已转小写、去前导点）
 * @throws {Error} id 无效、与内置冲突、缺 extensions / parse / stringify 时抛错
 */
export function registerPluginFormat(driver) {
    if (!driver || typeof driver !== 'object') {
        throw new Error('registerFormat 需要一个格式对象');
    }
    const id = String(driver.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        throw new Error(`格式 id 无效（只允许小写字母、数字和连字符）：${JSON.stringify(driver.id)}`);
    }
    if (formats[id]) {
        throw new Error(`格式 id ${id} 与内置格式冲突`);
    }
    if (pluginFormats.some((f) => f.id === id)) {
        throw new Error(`格式 id ${id} 已被注册`);
    }
    if (!Array.isArray(driver.extensions) || !driver.extensions.length) {
        throw new Error(`格式 ${id} 缺少 extensions`);
    }
    if (typeof driver.parse !== 'function' || typeof driver.stringify !== 'function') {
        throw new Error(`格式 ${id} 缺少 parse 或 stringify`);
    }
    const normalized = {
        ...driver,
        id,
        name: String(driver.name || id),
        extensions: driver.extensions.map((e) => String(e).toLowerCase().replace(/^\./, '')),
    };
    pluginFormats.push(normalized);
    return normalized;
}

/**
 * 清空所有插件注册的自定义格式（用于插件卸载 / 重载）。
 * @returns {void}
 */
export function unregisterAllPluginFormats() {
    pluginFormats.length = 0;
}

// ===== 格式检测与映射 =====
/**
 * 判定文件名是否属于可打开的受支持类型（内置格式 / 媒体扩展名 / 插件格式 / 已知文件名）。
 * @param {string} name 文件名（可含路径，取末段 base 判定）
 * @returns {boolean} true = 文件树可点击打开
 */
export function isSupportedFile(name) {
    const base = String(name || '').split(/[\\/]/).pop();
    if (knownFileNames.has(base.toLowerCase())) return true;
    const dot = base.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = base.slice(dot + 1).toLowerCase();
    if (imageExtensions.includes(ext)) return true;
    if (videoExtensions.includes(ext)) return true;
    if (audioExtensions.includes(ext)) return true;
    if (pluginFormats.some((f) => f.extensions.includes(ext))) return true;
    return Object.values(formats).some((f) => f.extensions.includes(ext));
}

export const openFileFilters = [
    {display: '结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)', pattern: '*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv'},
    {display: '所有文件 (*.*)', pattern: '*.*'},
];

/**
 * 按文件名探测格式驱动，并对 XML 补上带 XML 声明的 stringify。
 * @param {string} fileName 文件名（按扩展名匹配内置格式，未命中再匹配插件格式，兜底 text）
 * @param {string} content 文件内容（仅用于判断 XML 是否带 <?xml ?> 声明）
 * @returns {object} 格式驱动的浅拷贝（XML 会重写 stringify 以按需补声明）
 */
export function detectFormat(fileName, content) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    let driver = formats.text;
    for (const f of Object.values(formats)) {
        if (f.extensions.includes(ext)) {
            driver = f;
            break;
        }
    }
    if (driver === formats.text) {
        for (const f of pluginFormats) {
            if (f.extensions.includes(ext)) {
                driver = f;
                break;
            }
        }
    }
    if (driver.id === 'xml') {
        const hasDecl = /^\s*<\?xml[^>]*\?>/.test(content || '');
        return {
            ...driver,
            stringify(value) {
                const body = new XMLBuilder(xmlBuilderOptions).build(value);
                return (hasDecl ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '') + body;
            },
        };
    }
    return {...driver};
}

/**
 * 取格式驱动的显示名，空值兜底为「未知」。
 * @param {object|null} driver 格式驱动对象
 * @returns {string} 格式名（如 'JSON' / 'YAML'）
 */
export function formatName(driver) {
    return driver ? driver.name : '未知';
}

const extensionAceModes = {
    json: 'json', jsonc: 'json5', json5: 'json5', jsonl: 'json', ndjson: 'json',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', pyw: 'python', pyi: 'python',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss', less: 'less',
    sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', bat: 'batchfile', cmd: 'batchfile',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    go: 'golang', mod: 'gomod', work: 'gomod', sum: 'gosum',
    java: 'java', kt: 'kotlin', kts: 'kotlin', lua: 'lua', sql: 'sql',
    toml: 'toml', ini: 'ini', properties: 'properties', conf: 'ini', cfg: 'ini',
    c: 'c_cpp', h: 'c_cpp', cpp: 'c_cpp', cc: 'c_cpp', cxx: 'c_cpp', 'c++': 'c_cpp',
    hpp: 'c_cpp', hh: 'c_cpp', hxx: 'c_cpp', ino: 'c_cpp',
    cs: 'csharp', rs: 'rust', rb: 'ruby', php: 'php', phtml: 'php', swift: 'swift',
    m: 'objectivec', mm: 'objectivec', pl: 'perl', pm: 'perl', t: 'perl', r: 'r',
    dart: 'dart', scala: 'scala', sc: 'scala', groovy: 'groovy', gradle: 'groovy', nf: 'groovy',
    mak: 'makefile', mk: 'makefile', cmake: 'cmake', dockerfile: 'dockerfile',
    diff: 'diff', patch: 'diff',
    vue: 'vue', proto: 'protobuf', graphql: 'graphqlschema', gql: 'graphqlschema',
};

// 无扩展名或约定文件名按整体名匹配（base 一律小写后比较）
const fileNameAceModes = {
    dockerfile: 'dockerfile',
    makefile: 'makefile', gnumakefile: 'makefile',
    'cmakelists.txt': 'cmake',
    jenkinsfile: 'groovy',
    gemfile: 'ruby', rakefile: 'ruby',
    '.gitignore': 'gitignore', '.gitattributes': 'gitignore', '.gitmodules': 'gitignore', '.dockerignore': 'gitignore',
    '.editorconfig': 'ini', '.env': 'ini',
    '.npmrc': 'ini', '.gitconfig': 'ini', '.npmignore': 'gitignore',
    '.babelrc': 'json', '.prettierrc': 'json', '.eslintrc': 'json',
};

/**
 * 解析文件名对应的 Ace 语法高亮模式。
 * 优先级：整体文件名（Makefile / .gitignore 这类）→ 扩展名 → 格式驱动的 aceMode → 纯文本。
 * @param {string} fileName 文件名（可含路径）
 * @param {object|null} driver detectFormat 返回的格式驱动，可含 aceMode 字段
 * @returns {string} 完整 Ace 模式串，如 'ace/mode/json'
 */
export function aceModeFor(fileName, driver) {
    const base = String(fileName || '').split(/[\\/]/).pop().toLowerCase();
    const nameMode = fileNameAceModes[base] || fileNameAceModes[base.replace(/\.[^.]*$/, '')];
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? '' : base.slice(dot + 1);
    return 'ace/mode/' + (nameMode || extensionAceModes[ext] || (driver && driver.aceMode) || 'text');
}

/**
 * 判定「已知代码 / 配置文件名」：扩展名虽是 .txt（或无扩展名），
 * 但应按代码视图打开并语法高亮，不算纯文本。
 * @param {string} fileName 文件名（可含路径）
 * @returns {boolean} true = 按代码视图打开
 */
export function isKnownCodeFileName(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop().toLowerCase();
    return knownFileNames.has(base) || !!fileNameAceModes[base];
}

const knownFileNames = new Set([
    'dockerfile', 'makefile', 'gnumakefile', 'cmakelists.txt', 'jenkinsfile', 'gemfile', 'rakefile',
    '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.editorconfig', '.env',
    '.babelrc', '.prettierrc', '.eslintrc',
    // 仓库元信息约定名（无扩展名）：保证文件树可直接打开，按代码视图呈现
    'license', 'licence', 'unlicense', 'copying', 'copying.lesser', 'notice', 'patents',
    'authors', 'contributors', 'contributing', 'changelog', 'codeowners', 'security', 'maintainers',
    '.npmrc', '.npmignore', '.gitconfig',
]);