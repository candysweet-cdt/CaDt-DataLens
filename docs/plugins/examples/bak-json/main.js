// JSON 备份查看插件示例：
// - 注册 .bak 扩展名为 JSON 格式（树视图编辑、格式化、保存都走 JSON）
// - parse 失败时应用会自动退回文本视图，无需插件处理
// - 注册一个工具菜单命令和一个演示主题

cadt.registerFormat({
    id: 'bak-json-format',
    name: 'JSON 备份',
    extensions: ['bak'],
    aceMode: 'json',
    parse: (text) => JSON.parse(text),
    stringify: (value) => JSON.stringify(value, null, 2),
});

cadt.addCommand({
    id: 'char-count',
    label: '统计当前文件字符数',
    run() {
        const file = cadt.getActiveFile();
        const text = cadt.getActiveText();
        cadt.flash((file ? file.name : '无文件') + ' 共 ' + (text ? text.length : 0) + ' 字符');
    },
});

cadt.addTheme({
    id: 'bak-demo-dark',
    name: '演示主题',
    bg: '#241f31',
    accent: '#c58af9',
    css: [
        'html[data-theme="bak-demo-dark"] {',
        '    --bg: #241f31;',
        '    --text: #e8e3f2;',
        '    --muted: #9d94b8;',
        '    --border: #3a3350;',
        '    --hover: #2e2842;',
        '    --accent: #c58af9;',
        '    --on-accent: #1b1626;',
        '}',
    ].join('\n'),
});
