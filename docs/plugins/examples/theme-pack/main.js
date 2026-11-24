cadt.addTheme({
    id: 'violet-night',
    name: '紫夜',
    extends: 'dark',
    bg: '#241f31',
    accent: '#c58af9',
    vars: {
        '--bg': '#241f31',
        '--panel': '#2d263b',
        '--panel2': '#352c46',
        '--border': '#493d5c',
        '--text': '#e8e3f2',
        '--muted': '#9d94b8',
        '--accent': '#c58af9',
        '--on-accent': '#1b1626'
    }
});

cadt.addCodeTheme({
    id: 'violet-code',
    name: '紫夜代码',
    extends: 'jetbrains-dark',
    group: 'dark',
    vars: {
        '--editor-bg': '#241f31',
        '--editor-text': '#e8e3f2',
        '--syn-keyword': '#c58af9',
        '--syn-string': '#9ece6a',
        '--syn-number': '#ff9e64'
    }
});

cadt.registerIconTheme({
    id: 'violet-icons',
    name: '紫夜图标',
    extends: 'opensource',
    icons: {
        json: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" fill="#c58af9"/><text x="8" y="10.5" text-anchor="middle" fill="#1b1626" font-size="7" font-family="monospace">{}</text></svg>',
        default_file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L12 4.5V14.5H4z" fill="#6f5a8a"/><path d="M9.5 1.5V4.5H12" fill="#b9a7d1"/></svg>'
    }
});
