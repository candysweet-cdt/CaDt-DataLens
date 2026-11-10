// palette.js：命令面板（Ctrl+Shift+P）。扁平动作注册表 + 模糊过滤 + 键盘导航。
export function createPalette(options) {
    const mask = options.mask;
    const input = options.input;
    const list = options.list;
    let openState = false;
    let rows = [];
    let index = 0;

    function fuzzyScore(label, query) {
        if (!query) return 1;
        const q = query.toLowerCase();
        const l = label.toLowerCase();
        const idx = l.indexOf(q);
        if (idx === 0) return 100;
        if (idx > 0) return 60 - Math.min(idx, 40);
        let pi = 0;
        for (let i = 0; i < l.length && pi < q.length; i++) {
            if (l[i] === q[pi]) pi++;
        }
        return pi === q.length ? 30 : -1;
    }

    function updateSelection() {
        for (let i = 0; i < rows.length; i++) {
            rows[i].el.classList.toggle('selected', i === index);
        }
        const cur = rows[index];
        if (cur && cur.el.scrollIntoView) cur.el.scrollIntoView({block: 'nearest'});
    }

    function render() {
        const query = input.value.trim();
        const actions = options.getActions() || [];
        rows = [];
        list.textContent = '';
        let number = 0;
        for (const item of actions) {
            const score = fuzzyScore(item.label, query);
            if (score < 0) continue;
            const idx = number++;
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'quick-switch-item' + (idx === index ? ' selected' : '');
            const labelEl = document.createElement('span');
            labelEl.className = 'quick-switch-label';
            labelEl.textContent = item.label;
            el.appendChild(labelEl);
            if (item.shortcut) {
                const sc = document.createElement('span');
                sc.className = 'quick-switch-value';
                sc.textContent = item.shortcut;
                el.appendChild(sc);
            }
            el.addEventListener('click', () => run(idx));
            list.appendChild(el);
            rows.push({item, el});
        }
        if (index >= rows.length) index = Math.max(0, rows.length - 1);
        updateSelection();
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'quick-switch-item disabled';
            empty.textContent = '没有匹配的命令';
            list.appendChild(empty);
        }
    }

    function run(idx) {
        const row = rows[idx];
        if (!row || !row.item || typeof row.item.action !== 'function') return;
        close();
        try {
            row.item.action();
        } catch (e) {}
    }

    function openPalette() {
        openState = true;
        mask.classList.remove('hidden');
        input.value = '';
        index = 0;
        render();
        setTimeout(() => input.focus(), 0);
    }

    function close() {
        openState = false;
        mask.classList.add('hidden');
    }

    function toggle() {
        if (openState) close();
        else openPalette();
    }

    function handleKey(e) {
        if (e.key === 'ArrowDown') {
            index = Math.min(rows.length - 1, index + 1);
            updateSelection();
            return true;
        }
        if (e.key === 'ArrowUp') {
            index = Math.max(0, index - 1);
            updateSelection();
            return true;
        }
        if (e.key === 'PageDown') {
            index = Math.min(rows.length - 1, index + 8);
            updateSelection();
            return true;
        }
        if (e.key === 'PageUp') {
            index = Math.max(0, index - 8);
            updateSelection();
            return true;
        }
        if (e.key === 'Enter') {
            run(index);
            return true;
        }
        if (e.key === 'Escape') {
            close();
            return true;
        }
        return false;
    }

    input.addEventListener('input', () => {
        index = 0;
        render();
    });
    input.addEventListener('keydown', (e) => {
        if (handleKey(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    });
    mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) close();
    });

    return {toggle, close, isOpen: () => openState};
}
