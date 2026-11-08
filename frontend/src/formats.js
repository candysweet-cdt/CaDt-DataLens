import {load as yamlLoad, dump as yamlDump} from 'js-yaml';
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
    yaml: {
        id: 'yaml',
        name: 'YAML',
        extensions: ['yaml', 'yml'],
        aceMode: 'text',
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
        aceMode: 'text',
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
            const result = Papa.parse(text, {header: true, skipEmptyLines: 'greedy', dynamicTyping: false});
            if (result.errors.length) throw new Error(result.errors[0].message);
            return {headers: result.meta.fields || [], rows: result.data};
        },
        stringify(value) {
            return Papa.unparse(value, {newline: '\n'});
        },
    },
    text: {
        id: 'text',
        name: '纯文本',
        extensions: ['txt', 'md', 'markdown', 'log', 'ini', 'properties', 'conf', 'cfg', 'toml',
            'html', 'htm', 'css', 'js', 'ts', 'py', 'sh', 'bat', 'ps1', 'go', 'java', 'kt', 'lua', 'sql'],
        aceMode: 'text',
        rawOnly: true,
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
    {display: '结构化数据 (*.json;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)', pattern: '*.json;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv'},
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