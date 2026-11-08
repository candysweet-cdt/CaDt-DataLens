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
        extensions: ['md', 'markdown'],
        aceMode: 'markdown',
        rawOnly: true,
        preview: true,
    },
    text: {
        id: 'text',
        name: '纯文本',
        extensions: ['txt', 'log', 'conf',
            'html', 'htm', 'css', 'js', 'ts', 'py', 'sh', 'bat', 'ps1', 'go', 'java', 'kt', 'lua', 'sql'],
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

export function isSupportedFile(name) {
    const base = String(name || '').split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = base.slice(dot + 1).toLowerCase();
    if (imageExtensions.includes(ext)) return true;
    return Object.values(formats).some((f) => f.extensions.includes(ext));
}

export const openFileFilters = [
    {display: '结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)', pattern: '*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv'},
    {display: '所有文件 (*.*)', pattern: '*.*'},
];

export function detectFormat(fileName, content) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    let driver = formats.text;
    for (const f of Object.values(formats)) {
        if (f.extensions.includes(ext)) {
            driver = f;
            break;
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

export function formatName(driver) {
    return driver ? driver.name : '未知';
}

const extensionAceModes = {
    json: 'json', jsonc: 'json5', json5: 'json5', jsonl: 'json', ndjson: 'json',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    md: 'markdown', markdown: 'markdown',
    html: 'html', htm: 'html', css: 'css',
    sh: 'sh', bash: 'sh', zsh: 'sh', bat: 'batchfile', ps1: 'powershell',
    go: 'golang', java: 'java', kt: 'kotlin', lua: 'lua', sql: 'sql',
    toml: 'toml', ini: 'ini', properties: 'properties', conf: 'ini', cfg: 'ini',
};

export function aceModeFor(fileName, driver) {
    const base = String(fileName || '').split(/[\\/]/).pop().toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? '' : base.slice(dot + 1);
    return 'ace/mode/' + (extensionAceModes[ext] || (driver && driver.aceMode) || 'text');
}