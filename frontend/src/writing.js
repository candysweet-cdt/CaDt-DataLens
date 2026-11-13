// 写作模式纯函数：中文排版整理、起名器、场景分隔符。
// 无 DOM 依赖，可独立 node 测试（参照 ai-command-rules.test.mjs 的模式）。

// 写作字体：family 为中日韩字体族，拉丁部分跟随编辑器主字体（main.js 拼接）
export const WRITING_FONTS = [
    {id: 'kaiti', name: '楷体', family: '"KaiTi", "楷体"'},
    {id: 'simsun', name: '宋体', family: '"SimSun", "宋体"'},
    {id: 'fangsong', name: '仿宋', family: '"FangSong", "仿宋"'},
    {id: 'follow', name: '跟随编辑器字体', family: null},
];

export const WRITING_PAPERS = [
    {id: 'off', name: '无'},
    {id: 'sepia', name: '暖黄护眼'},
    {id: 'dim', name: '调暗'},
];

export const SCENE_SEPARATOR = '\n\n* * *\n\n';

// md 语法行：行首缩进保护（嵌套列表/引用/表格/代码块不能丢行首空白）
//  - ATX 标题、引用、无序/有序列表、表格、围栏代码块（≤3 空格缩进）
//  - 4 空格以上缩进的缩进式代码块
const MD_SYNTAX_LINE = /^ {0,3}(?:#{1,6}(?: |\t|$)|>|[-*+](?: |\t|$)|\d+[.)](?: |\t|$)|\||`{3,}|~{3,})|^ {4,}/;

function isMdSyntaxLine(line) {
    return MD_SYNTAX_LINE.test(line);
}

function stripTrailing(line) {
    // 全角空格 / nbsp 也算行尾空白
    const trimmed = line.replace(/[ \t\u3000\u00a0]+$/, '');
    return trimmed.length === line.length ? null : trimmed;
}

function stripLeading(line) {
    // 只清 ASCII 空白；全角空格缩进（段首「　　」）是正文的一部分，保留
    const trimmed = line.replace(/^[ \t\u00a0]+/, '');
    return trimmed.length === line.length ? null : trimmed;
}

// formatWritingText：写作排版整理（按 docs/finished-plans/writing-mode.md §⑤ 的规则顺序）
//  1. \r\n → \n（保存沿用现有 EOL 策略还原 CRLF）
//  2. 删行尾空白
//  3. ≥3 连续空行收敛为 1 个空行
//  4. 行首空白清除；markdown 语法行与围栏代码块内不动行首
//  5. indent=true：空行后（含文首）首个非空行首加两个全角空格「　　」，md 语法行除外
// 返回 {text, trailing, collapsed, leading, indented}
export function formatWritingText(text, {markdown, indent} = {}) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = s.split('\n');
    const fenced = new Array(lines.length).fill(false); // 围栏代码块内容行（含围栏行）
    let trailing = 0;
    let leading = 0;
    let indented = 0;
    let fence = null; // {char, len}
    let listIndent = -1; // 生效中的列表标记缩进：其后缩进更大的行是列表续段/子块
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const fenceMatch = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(raw) : null;
        if (fenceMatch) {
            fenced[i] = true;
            if (!fence) fence = {char: fenceMatch[1][0], len: fenceMatch[1].length};
            else if (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.len) fence = null;
        } else if (fence) {
            fenced[i] = true;
        }
        // 行尾空白：围栏内保留代码原样；markdown 行尾 2 个以上空格是硬换行（<br>），保留
        const hardBreak = markdown && /[^ \t\u3000\u00a0] {2,}$/.test(raw);
        if (!fenced[i] && !hardBreak) {
            const trimmed = stripTrailing(raw);
            if (trimmed !== null) {
                trailing++;
                lines[i] = trimmed;
            }
        }
        if (fenced[i]) continue; // 围栏行与围栏内容不动行首
        const line = lines[i];
        const marker = markdown ? /^( {0,3})(?:[-*+]|\d+[.)])(?:[ \t]|$)/.exec(line) : null;
        if (marker) {
            listIndent = marker[1].length;
            continue; // 列表标记行由 isMdSyntaxLine 保护，这里只记录层级
        }
        if (markdown && listIndent >= 0) {
            if (!line.trim()) continue; // 空行不结束列表（续段可跨空行）
            const lead = /^[ \t\u00a0]*/.exec(line)[0].length;
            if (lead > listIndent) continue; // 列表续段/子块：保留缩进，否则会被顶格拆出列表
            listIndent = -1; // 回到顶层，列表结束
        }
        if (markdown && isMdSyntaxLine(line)) continue; // 语法行不动行首（嵌套列表/引用/表格/缩进代码）
        const stripped = stripLeading(line);
        if (stripped !== null) {
            leading++;
            lines[i] = stripped;
        }
    }
    // 规则 5：段首缩进（在行首清除之后执行，全角缩进不会被清掉）
    if (indent) {
        const PARAGRAPH_INDENT = '\u3000\u3000';
        let prevEmpty = true;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const empty = !line.trim();
            // txt 没有 md 语法；markdown 下跳过语法行、列表续段（已有 ASCII 缩进）与已全角缩进行
            if (!empty && prevEmpty && !fenced[i] && !(markdown && isMdSyntaxLine(line)) &&
                !/^[ \t\u00a0]/.test(line) && !line.startsWith(PARAGRAPH_INDENT)) {
                lines[i] = PARAGRAPH_INDENT + line;
                indented++;
            }
            prevEmpty = empty;
        }
    }
    // 规则 3：≥3 连续空行收敛为 1 个空行；按空行计数，文首文末同口径
    let collapsed = 0;
    const outLines = [];
    let emptyRun = 0;
    for (const line of lines) {
        if (!line.trim()) {
            emptyRun++;
            continue;
        }
        if (emptyRun > 0) {
            if (emptyRun >= 3) {
                collapsed++;
                outLines.push('');
            } else {
                for (let k = 0; k < emptyRun; k++) outLines.push('');
            }
            emptyRun = 0;
        }
        outLines.push(line);
    }
    if (emptyRun > 0) {
        if (emptyRun >= 3) collapsed++;
        outLines.push(''); // 保留结尾换行本身，多余的尾部空行不保留
    }
    return {text: outLines.join('\n'), trailing, collapsed, leading, indented};
}

// ===== 起名器 =====

const SURNAMES = [
    '王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '高',
    '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹', '彭', '曾', '肖', '田', '董', '潘', '袁', '蔡', '蒋', '余',
    '于', '杜', '叶', '程', '苏', '魏', '吕', '丁', '任', '沈', '姚', '卢', '姜', '崔', '钟', '谭', '陆', '汪', '范', '金',
    '石', '廖', '贾', '夏', '韦', '傅', '方', '白', '邹', '孟', '熊', '秦', '邱', '江', '尹', '薛', '闫', '段', '雷', '侯',
    '龙', '史', '陶', '黎', '贺', '顾', '毛', '郝', '龚', '邵', '万', '钱', '严', '覃', '武', '戴', '莫', '孔', '向', '汤',
    '常', '温', '康', '施', '文', '牛', '樊', '葛', '邢', '安', '齐', '易', '乔', '伍', '庞', '颜', '倪', '庄', '聂', '章',
    '岳', '简', '裴', '关', '米', '甘', '祁', '路', '云',
    // 复姓
    '欧阳', '上官', '司马', '诸葛', '夏侯', '皇甫', '尉迟', '公孙', '慕容', '司徒',
    '端木', '申屠', '东方', '独孤', '南宫', '西门', '令狐', '宇文', '轩辕', '长孙',
];

const MALE_CHARS = [
    '伟', '强', '军', '磊', '勇', '杰', '涛', '斌', '波', '辉', '刚', '健', '俊', '峰', '鹏', '飞', '宇', '浩', '然', '志',
    '明', '龙', '世', '天', '文', '博', '思', '辰', '旭', '晨', '昊', '凯', '泽', '洋', '瑞', '铭', '鑫', '皓', '睿', '渊',
    '霆', '峥', '扬', '骁', '毅', '恒', '擎', '昭', '远', '安', '邦',
];

const FEMALE_CHARS = [
    '芳', '娟', '敏', '静', '丽', '娜', '燕', '婷', '雪', '梅', '琳', '晶', '欣', '怡', '佳', '颖', '露', '薇', '晓', '妍',
    '慧', '莹', '云', '丹', '萍', '红', '玉', '蓉', '梦', '柔', '婉', '清', '岚', '月', '雅', '絮', '烟', '黛', '绫',
    '绮', '姝', '嬛', '滢', '玥', '嫣', '瑾', '澜', '蔻', '梨', '霞',
];

const NEUTRAL_CHARS = [
    '子', '亦', '凡', '和', '平', '乐', '川', '岩', '松', '竹', '风', '秋', '白', '书', '南', '北', '溪', '桥', '一',
    '之', '言', '行', '木', '水', '山', '青', '玄',
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function pickUnique(list, used) {
    for (let i = 0; i < 8; i++) {
        const ch = pick(list);
        if (!used.has(ch)) {
            used.add(ch);
            return ch;
        }
    }
    return pick(list);
}

// genName(gender)：gender ∈ male / female / random，返回「姓 + 1~2 字名」
export function genName(gender) {
    let g;
    if (gender === 'male' || gender === 'female') g = gender;
    else g = Math.random() < 0.5 ? 'male' : 'female';
    const pool = g === 'male' ? MALE_CHARS.concat(NEUTRAL_CHARS) : FEMALE_CHARS.concat(NEUTRAL_CHARS);
    const used = new Set();
    const given = Math.random() < 0.72
        ? pickUnique(pool, used) + pickUnique(pool, used)
        : pickUnique(pool, used);
    return pick(SURNAMES) + given;
}
