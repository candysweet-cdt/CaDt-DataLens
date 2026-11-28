// @ts-check
// ai-datetime-picker.js：自绘通用日期时间选择器（无原生 datetime-local、无第三方日期库）。
// 一个组件，参数不同结果不同：
//   fields: ('year'|'month'|'day'|'hour'|'minute'|'second')[] —— 决定渲染哪些粒度列/日历
//   range: boolean —— true 时渲染起止两个触发器（复用同一套面板）
// 浮层走 overlayStack（Esc/外点收口 dispose）+ placePopover 定位；图标 iconSvg；配色全用主题变量。

import {iconSvg} from '../../core/icons.js';
import {overlayStack} from '../../core/overlay-stack.js';
import {placePopover} from '../../core/popover-position.js';
import {createInput} from '../../core/form-controls.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/** 默认值：完整日期时间（年月日 + 时分），无秒。 */
export const FIELDS_DATETIME = ['year', 'month', 'day', 'hour', 'minute'];
/** 仅日期。 */
export const FIELDS_DATE = ['year', 'month', 'day'];
/** 仅时间（时分秒）。 */
export const FIELDS_TIME = ['hour', 'minute', 'second'];

/** @type {Record<string, string>} */
const FIELD_LABEL = {year: '年', month: '月', day: '日', hour: '时', minute: '分', second: '秒'};

/**
 * 解析 'YYYY-MM-DD HH:mm[:ss]' 为 {y,m,d,h,mi,s}；无效返回 null。
 * @param {string} text
 */
export function parseValue(text) {
    const m = String(text || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (!m) return null;
    return {y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0)};
}

/**
 * 按 fields 格式化值：只输出启用的粒度。
 * @param {{y:number,mo:number,d:number,h:number,mi:number,s:number}} v
 * @param {string[]} fields
 */
export function formatValue(v, fields) {
    /** @param {string} f */
    const has = (f) => fields.includes(f);
    const date = has('year') || has('month') || has('day')
        ? [has('year') ? String(v.y).padStart(4, '0') : '', has('month') ? pad(v.mo) : '', has('day') ? pad(v.d) : '']
            .filter(Boolean).join('-')
        : '';
    const time = has('hour') || has('minute') || has('second')
        ? [has('hour') ? pad(v.h) : '', has('minute') ? pad(v.mi) : '', has('second') ? pad(v.s) : '']
            .filter(Boolean).join(':')
        : '';
    return [date, time].filter(Boolean).join(' ');
}

/**
 * 某月天数
 * @param {number} y
 * @param {number} mo
 */
function daysInMonth(y, mo) {
    return new Date(y, mo, 0).getDate();
}

/**
 * 创建选择器工厂。
 * @param {{fields?:string[], range?:boolean, placeholder?:string}} [options]
 */
export function createDateTimePicker(options = {}) {
    const fields = Array.isArray(options.fields) && options.fields.length ? options.fields : FIELDS_DATETIME;
    const range = !!options.range;
    const placeholder = options.placeholder || '选择日期时间…';
    /** @param {string} f */
    const hasDate = fields.some((f) => ['year', 'month', 'day'].includes(f));
    /** @param {string} f */
    const hasTime = fields.some((f) => ['hour', 'minute', 'second'].includes(f));
    /** @type {{dispose:Function}|null} */
    let openHandle = null;

    /** 关闭当前浮层（必须走 onClose：它负责把浮层 DOM 从 body 摘掉，只 dispose 会留下残影） */
    function close() {
        const h = openHandle;
        if (!h) return;
        openHandle = null;
        const entry = /** @type {{entry?:{onClose?:Function}}} */ (h).entry;
        if (entry && typeof entry.onClose === 'function') entry.onClose();
        h.dispose();
    }

    /**
     * 创建一个「可手输 + 日历按钮」控件。形状与 createInput 一致：{element, control}。
     * 点输入框 / 点日历按钮都弹自绘选择器；输入框保持可键入（手输直接生效，change 回调）。
     * @param {{value?:string, onChange?:(v:string)=>void, ariaLabel?:string}} [cfg]
     * @returns {{element:HTMLElement, control:HTMLInputElement}}
     */
    function createTrigger(cfg = {}) {
        const wrap = document.createElement('div');
        wrap.className = 'dtp-trigger';
        const inputCtl = createInput({className: 'dlg-input ai-settings-input', placeholder});
        const input = inputCtl.control;
        input.setAttribute('aria-label', cfg.ariaLabel || placeholder);
        if (cfg.value) input.value = String(cfg.value);
        const calBtn = document.createElement('button');
        calBtn.type = 'button';
        calBtn.className = 'dtp-cal-btn';
        calBtn.setAttribute('aria-label', '打开日历选择');
        calBtn.dataset.tip = '日历选择';
        calBtn.innerHTML = iconSvg('calendar', 14);
        /** 打开面板（锚点用输入框，外点判定把输入框与按钮都算在内） */
        const open = () => openPanel(input, (v) => {
            input.value = v;
            input.dispatchEvent(new Event('change', {bubbles: true}));
        }, input.value, [input, calBtn]);
        calBtn.addEventListener('click', () => {
            if (openHandle) { close(); return; }
            open();
        });
        // 点输入框即弹面板（面板已打开时不再重建，否则会把正在编辑的输入打断）
        input.addEventListener('click', () => {
            if (!openHandle) open();
        });
        // 手输也走同一 onChange（change 事件），与日历选定一致
        input.addEventListener('change', () => {
            if (typeof cfg.onChange === 'function') cfg.onChange(input.value);
        });
        wrap.append(input, calBtn);
        return {element: wrap, control: input};
    }

    /**
     * 打开浮层。
     * 面板结构：日期用日历（标题可点，日 → 月 → 年逐级放大，年/月也可直接点选），
     * 时间用可滚动的整列，不再把年月日同时渲染成列（旧实现日历 + 年月日列重复，宽度直接溢出弹层）。
     * @param {HTMLElement} anchor 定位锚点
     * @param {(v:string)=>void} onPick
     * @param {string} initial
     * @param {HTMLElement[]} [anchors] 外点关闭时算作「面板内」的额外节点
     */
    function openPanel(anchor, onPick, initial, anchors) {
        const now = new Date();
        const cur = parseValue(initial) || {y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), mi: now.getMinutes(), s: 0};
        let viewY = cur.y, viewMo = cur.mo;
        /** 'day' 日历网格 / 'month' 年选月 / 'year' 12 年一页 */
        let viewMode = 'day';
        let yearPage = Math.floor(cur.y / 12) * 12;
        const picked = {...cur};
        const timeFields = fields.filter((f) => ['hour', 'minute', 'second'].includes(f));

        const pop = document.createElement('div');
        pop.className = 'dtp-pop';

        // --- 头部：‹ 标题 › 三段式（标题可点，逐级放大粒度） ---
        const hd = document.createElement('div');
        hd.className = 'dtp-hd';
        const prev = document.createElement('button');
        prev.type = 'button'; prev.className = 'dtp-nav'; prev.setAttribute('aria-label', '上一页');
        prev.innerHTML = iconSvg('chevron-left', 13);
        const title = document.createElement('button');
        title.type = 'button'; title.className = 'dtp-title';
        const next = document.createElement('button');
        next.type = 'button'; next.className = 'dtp-nav'; next.setAttribute('aria-label', '下一页');
        next.innerHTML = iconSvg('chevron-right', 13);
        hd.append(prev, title, next);
        if (hasDate) pop.appendChild(hd);

        const body = document.createElement('div');
        body.className = 'dtp-body';
        pop.appendChild(body);

        /** 重绘标题 + 主体（视图切换 / 选日 / 选时后调用） */
        function render() {
            if (hasDate) {
                title.textContent = viewMode === 'day'
                    ? viewY + ' 年 ' + pad(viewMo) + ' 月'
                    : viewMode === 'month' ? viewY + ' 年' : yearPage + ' – ' + (yearPage + 11);
                title.dataset.tip = viewMode === 'day' ? '选择月份' : viewMode === 'month' ? '选择年份' : '返回月份';
            }
            body.textContent = '';
            if (hasDate) {
                body.appendChild(viewMode === 'day' ? renderCalendar()
                    : viewMode === 'month' ? renderMonthGrid() : renderYearGrid());
            }
            if (hasDate && hasTime) {
                const sep = document.createElement('div');
                sep.className = 'dtp-sep';
                body.appendChild(sep);
            }
            if (hasTime) body.appendChild(renderTimeCols());
            // 列刚重建：把当前值滚到列中间（选择器打开/改日期后不会看到「选中的看不见」）
            syncColumnScroll();
        }

        /** 年月日网格外框 */
        function cellGrid() {
            const grid = document.createElement('div');
            grid.className = 'dtp-cellgrid';
            return grid;
        }

        /** 日历网格（月内翻页） */
        function renderCalendar() {
            const cal = document.createElement('div');
            cal.className = 'dtp-cal';
            const wk = document.createElement('div');
            wk.className = 'dtp-week';
            for (const w of WD) { const s = document.createElement('span'); s.textContent = w; wk.appendChild(s); }
            cal.appendChild(wk);
            const grid = document.createElement('div');
            grid.className = 'dtp-grid';
            const firstDow = new Date(viewY, viewMo - 1, 1).getDay();
            const dim = daysInMonth(viewY, viewMo);
            const prevDim = daysInMonth(viewY, viewMo - 1);
            const today = new Date();
            const cells = [];
            for (let i = 0; i < firstDow; i++) cells.push({d: prevDim - firstDow + 1 + i, out: true});
            for (let d = 1; d <= dim; d++) cells.push({d, out: false});
            while (cells.length % 7) cells.push({d: cells.length - firstDow - dim + 1, out: true});
            for (const c of cells) {
                const el = document.createElement('button');
                el.type = 'button';
                el.className = 'dtp-day' + (c.out ? ' out' : '') +
                    (!c.out && picked.y === viewY && picked.mo === viewMo && picked.d === c.d ? ' sel' : '') +
                    (!c.out && today.getFullYear() === viewY && today.getMonth() + 1 === viewMo && today.getDate() === c.d ? ' today' : '');
                el.textContent = String(c.d);
                el.addEventListener('click', () => {
                    picked.y = viewY; picked.mo = viewMo; picked.d = c.d;
                    render();
                });
                grid.appendChild(el);
            }
            cal.appendChild(grid);
            return cal;
        }

        /** 年视图：12 个月网格 */
        function renderMonthGrid() {
            const grid = cellGrid();
            for (let m = 1; m <= 12; m += 1) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dtp-cell' + (picked.y === viewY && picked.mo === m ? ' sel' : '');
                b.textContent = m + ' 月';
                b.addEventListener('click', () => {
                    viewMo = m; picked.y = viewY; picked.mo = m;
                    viewMode = 'day';
                    render();
                });
                grid.appendChild(b);
            }
            return grid;
        }

        /** 年视图：12 年一页 */
        function renderYearGrid() {
            const grid = cellGrid();
            for (let i = 0; i < 12; i += 1) {
                const y = yearPage + i;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dtp-cell' + (picked.y === y ? ' sel' : '');
                b.textContent = String(y);
                b.addEventListener('click', () => {
                    viewY = y; picked.y = y;
                    viewMo = picked.mo;
                    yearPage = Math.floor(y / 12) * 12;
                    viewMode = 'month';
                    render();
                });
                grid.appendChild(b);
            }
            return grid;
        }

        /** 时间滚轮列：只渲染时间粒度（年月日由日历负责），整列可滚动 */
        function renderTimeCols() {
            const wrap = document.createElement('div');
            wrap.className = 'dtp-cols';
            for (const f of timeFields) {
                const col = document.createElement('div');
                col.className = 'dtp-col';
                const head = document.createElement('div');
                head.className = 'dtp-col-h';
                head.textContent = FIELD_LABEL[f] || f;
                col.appendChild(head);
                const list = document.createElement('div');
                list.className = 'dtp-col-list';
                const range = columnRange(f, picked);
                const curVal = columnValue(f, picked);
                list.dataset.selIndex = String(Math.max(0, range.indexOf(curVal)));
                for (const val of range) {
                    const c = document.createElement('button');
                    c.type = 'button';
                    c.className = 'dtp-cv' + (val === curVal ? ' sel' : '');
                    c.textContent = String(val).padStart(2, '0');
                    c.addEventListener('click', () => {
                        setColumnValue(f, picked, val);
                        if (f === 'year' || f === 'month') { viewY = picked.y; viewMo = picked.mo; }
                        render();
                    });
                    list.appendChild(c);
                }
                col.appendChild(list);
                wrap.appendChild(col);
            }
            return wrap;
        }

        /** 把每列的选中项滚到可视区中间（列表上下各有半屏 padding，滚到 idx*行高即居中） */
        function syncColumnScroll() {
            const lists = /** @type {NodeListOf<HTMLElement>} */ (pop.querySelectorAll('.dtp-col-list'));
            for (const list of lists) {
                const idx = Number(list.dataset.selIndex) || 0;
                const row = list.firstElementChild;
                if (!row) continue;
                const rowH = row.getBoundingClientRect().height || 0;
                list.scrollTop = Math.max(0, idx * rowH);
            }
        }

        prev.addEventListener('click', () => {
            if (viewMode === 'day') {
                viewMo--; if (viewMo < 1) { viewMo = 12; viewY--; }
            } else if (viewMode === 'month') {
                viewY--; yearPage = Math.floor(viewY / 12) * 12;
            } else {
                yearPage -= 12;
            }
            render();
        });
        next.addEventListener('click', () => {
            if (viewMode === 'day') {
                viewMo++; if (viewMo > 12) { viewMo = 1; viewY++; }
            } else if (viewMode === 'month') {
                viewY++; yearPage = Math.floor(viewY / 12) * 12;
            } else {
                yearPage += 12;
            }
            render();
        });
        title.addEventListener('click', () => {
            // 日 → 月 → 年 → 日 三级循环（再点一次从年视图直接回日历，不必先选年月）
            viewMode = viewMode === 'day' ? 'month' : viewMode === 'month' ? 'year' : 'day';
            render();
        });

        const foot = document.createElement('div');
        foot.className = 'dtp-foot';
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button'; clearBtn.className = 'dtp-btn'; clearBtn.textContent = '清除';
        clearBtn.addEventListener('click', () => { close(); onPick(''); });
        const okBtn = document.createElement('button');
        okBtn.type = 'button'; okBtn.className = 'dtp-btn primary'; okBtn.textContent = '确定';
        okBtn.addEventListener('click', () => {
            const v = clampValue(picked, fields);
            close();
            onPick(formatValue(v, fields));
        });
        foot.append(clearBtn, okBtn);
        pop.appendChild(foot);

        document.body.appendChild(pop);
        // 必须先渲染内容再定位：placePopover 按 offsetWidth/Height 钳制，
        // 空面板量出来的宽高偏小，内容填进去后就会溢出视口（旧顺序就是先定位后渲染）。
        render();
        placePopover(pop, anchor, {placement: 'bottom', gap: 6});
        openHandle = overlayStack.open({
            id: 'dtp-' + Math.random().toString(36).slice(2),
            kind: 'popover',
            el: pop,
            onClose: () => {
                if (pop.isConnected) pop.remove();
                openHandle = null;
                return true;
            },
            closeOnOutsideClick: true,
            anchors: Array.isArray(anchors) && anchors.length ? anchors : [anchor],
        });
    }

    return {createTrigger, fields, range};
}

/**
 * @typedef {{y:number, mo:number, d:number, h:number, mi:number, s:number}} DTValue
 */

/**
 * 列的取值序列
 * @param {string} f
 * @param {DTValue} picked
 * @returns {number[]}
 */
function columnRange(f, picked) {
    if (f === 'year') {
        const y = picked.y;
        return Array.from({length: 21}, (_, i) => y - 10 + i);
    }
    if (f === 'month') return Array.from({length: 12}, (_, i) => i + 1);
    if (f === 'day') return Array.from({length: daysInMonth(picked.y, picked.mo)}, (_, i) => i + 1);
    if (f === 'hour') return Array.from({length: 24}, (_, i) => i);
    if (f === 'minute' || f === 'second') return Array.from({length: 60}, (_, i) => i);
    return [];
}
/**
 * @param {string} f
 * @param {DTValue} v
 */
function columnValue(f, v) {
    /** @type {Record<string, number>} */
    const map = {year: v.y, month: v.mo, day: v.d, hour: v.h, minute: v.mi, second: v.s};
    return map[f] || 0;
}
/**
 * @param {string} f
 * @param {DTValue} v
 * @param {number} val
 */
function setColumnValue(f, v, val) {
    if (f === 'year') v.y = val;
    else if (f === 'month') v.mo = val;
    else if (f === 'day') v.d = val;
    else if (f === 'hour') v.h = val;
    else if (f === 'minute') v.mi = val;
    else if (f === 'second') v.s = val;
}
/**
 * 钳制日期合法性（如 2 月 30 日 → 月末）
 * @param {DTValue} v
 * @param {string[]} fields
 */
function clampValue(v, fields) {
    const out = {...v};
    out.d = Math.min(out.d, daysInMonth(out.y, out.mo));
    return out;
}
