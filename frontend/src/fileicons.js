const BADGE_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3.2" fill="currentColor" opacity="0.13"></rect>' +
    '<rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3.2" fill="none" stroke="currentColor" stroke-width="0.9" opacity="0.55"></rect>';

function label(text, size, y = 10.9, x = 8, weight = 700) {
    return '<text x="' + x + '" y="' + y + '" text-anchor="middle" fill="currentColor" font-family="\'JetBrains Mono\', Consolas, monospace" font-size="' +
        size + '" font-weight="' + weight + '">' + text + '</text>';
}

function badge(content) {
    return BADGE_OPEN + content + '</svg>';
}

const ICONS = {
    json: badge(label('{}', 6.4)),
    jsonl: badge(label('{}', 5.6, 8.6) +
        '<path d="M5.2 10.7h5.6M5.2 12.4h3.8" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"></path>'),
    yaml: badge(label('Y', 7.4, 11.1)),
    xml: badge(label('&lt;&gt;', 5.8, 11)),
    csv: badge('<path d="M4.8 4.8h6.4v6.4H4.8z" fill="none" stroke="currentColor" stroke-width="0.95"></path>' +
        '<path d="M4.8 7.9h6.4M4.8 10.1h6.4M8 4.8v6.4" fill="none" stroke="currentColor" stroke-width="0.8"></path>'),
    toml: badge(label('T', 7.4, 11.1)),
    ini: badge(label('=', 7.2, 11.1)),
    properties: badge(label('P', 7.2, 11.1)),
    md: badge(label('M', 6.6, 11.2, 6.3) +
        '<path d="M10.2 6.1v5.1M8.75 9.85l1.45 1.45 1.45-1.45" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"></path>'),
    text: badge('<path d="M4.9 5.4h6.2M4.9 7.7h6.2M4.9 10h6.2M4.9 12.3h4" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"></path>'),
    log: badge('<path d="M4.9 5.1h6.2M4.9 7.3h6.2M4.9 9.5h6.2M4.9 11.7h3.4" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"></path>'),
    image: badge('<circle cx="10.7" cy="5.9" r="1.05" fill="currentColor"></circle>' +
        '<path d="M4.5 11.4l2.4-3.2 1.55 1.95 1.15-1.4 2.1 2.65z" fill="currentColor"></path>'),
    binary: badge(label('01', 5.1)),
    js: badge(label('JS', 5.3)),
    ts: badge(label('TS', 5.3)),
    html: badge(label('&lt;&gt;', 5.5, 11)),
    css: badge(label('#', 7.4, 11.1)),
    py: badge(label('Py', 5.4)),
    sh: badge(label('&gt;_', 5.2)),
    ps: badge(label('PS', 5.2)),
    bat: badge(label('B', 7.4, 11.1)),
    sql: badge('<ellipse cx="8" cy="4.9" rx="3.2" ry="1.2" fill="currentColor"></ellipse>' +
        '<path d="M4.8 4.9v4.9c0 .7 1.43 1.25 3.2 1.25s3.2-.55 3.2-1.25V4.9" fill="none" stroke="currentColor" stroke-width="1"></path>' +
        '<path d="M4.8 7.4c0 .7 1.43 1.25 3.2 1.25s3.2-.55 3.2-1.25" fill="none" stroke="currentColor" stroke-width="0.9"></path>'),
    go: badge(label('Go', 5.3)),
    java: badge(label('J', 7.5, 11.1)),
    kotlin: badge(label('K', 7.5, 11.1)),
    lua: badge(label('L', 7.5, 11.1)),
};

const EXTENSIONS = {
    json: 'json', jsonc: 'json', json5: 'json',
    jsonl: 'jsonl', ndjson: 'jsonl',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml',
    csv: 'csv', tsv: 'csv',
    toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini',
    properties: 'properties',
    md: 'md', markdown: 'md', mdx: 'md',
    txt: 'text', text: 'text',
    log: 'log',
    png: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', gif: 'image', bmp: 'image',
    webp: 'image', ico: 'image', tif: 'image', tiff: 'image', avif: 'image', heic: 'image',
    heif: 'image', psd: 'image', raw: 'image', cr2: 'image', nef: 'image', arw: 'image', dng: 'image',
    bin: 'binary', dat: 'binary', exe: 'binary', dll: 'binary', zip: 'binary', gz: 'binary',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    py: 'py', pyw: 'py',
    sh: 'sh', bash: 'sh', zsh: 'sh',
    ps1: 'ps', psm1: 'ps',
    bat: 'bat', cmd: 'bat',
    sql: 'sql',
    go: 'go',
    java: 'java',
    kt: 'kotlin', kts: 'kotlin',
    lua: 'lua',
};

export function fileIconSpec(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop().toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? '' : base.slice(dot + 1);
    const id = EXTENSIONS[ext] || 'text';
    return {id, className: 'fi-' + id, svg: ICONS[id]};
}

export function createFileIcon(fileName, extraClass) {
    const spec = fileIconSpec(fileName);
    const span = document.createElement('span');
    span.className = (extraClass ? extraClass + ' ' : '') + spec.className;
    span.dataset.fi = spec.id;
    span.innerHTML = spec.svg;
    return span;
}
