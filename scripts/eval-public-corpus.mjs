// scripts/eval-public-corpus.mjs：用公开语料对端侧线性分类器做 eval 评估（只评不训）。
// 数据（scripts/eval-data/，不入库）：
//   masquerade-data.zip → User1..User50   SEA 数据集（www.schonlau.net），真实 UNIX 用户的 75 万条裸命令——正常侧分布；
//   cowrie/*.json                       Cowrie 蜜罐攻击者输入（eventid=cowrie.session.input）——攻击侧；
//   malbash-main/*.sh                   恶意 bash 脚本（github greyhat-academy/malbash）——提取命令行。
// 标签语义警告（方案 §6）：公开语料的「恶意/良性」与本应用的「策略性 auto-approve」不同构——
// 蜜罐里的 ls / uname 属只读侦察，按本应用策略本就该放行；因此攻击侧指标只看
// 「破坏性子集」（明确的破坏/持久化/提权模式）的漏放，正常侧只看误打扰率。结论进方案文档 §6。
//
// 运行：node scripts/eval-public-corpus.mjs
import {readdirSync, readFileSync, existsSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lcDequantize, lcExtractDims, lcScore, LC_FEATURES} from '../frontend/src/ai/security/ai-local-classifier.js';
import {LOCAL_CLASSIFIER_THRESHOLDS} from '../frontend/src/ai/security/ai-permissions.js';
import {LOCAL_CLASSIFIER_WEIGHTS, LOCAL_CLASSIFIER_QUANT, LOCAL_CLASSIFIER_BIAS} from '../frontend/src/ai/security/local-classifier-weights.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'eval-data');

// 破坏性子集判定：命中即「按本应用策略必须转人工」的命令（蜜罐/恶意脚本里的攻击动作）。
// 与分类器无关的独立规则集，作为 eval 的参照标签。
const DESTRUCTIVE_PATTERNS = [
    /\brm\s+(-[a-z]*r[a-z]*f|-r\s+--force|--recursive)/i,
    /\b(del|erase)\b[^|;&]*\/(f|s)\b/i,
    /\b(rmdir|rd)\s+\/s/i,
    /remove-item[^|;&]*-recurse/i,
    /\bdd\b[^|;&]*of=/i,
    /\bmkfs\S*\b|\bformat\s+[a-z]:/i,
    /\bdiskpart\b|\bwipefs\b|\bshred\b|\bsdelete\b/i,
    /\bchmod\s+(-R\s+)?777/i,
    /\b(userdel|usermod|passwd)\b/i,
    /\b(useradd|adduser)\b/i,
    /etc\/(passwd|shadow)\s*$/i,
    /\bhistory\s+-c\b/i,
    /\b(crontab|schtasks)\b/i,
    /\biptables\s+-F\b/i,
    /\b(killall|pkill)\b/i,
    /\bkill\s+-9\b/i,
    /\btaskkill\b[^|;&]*\/f/i,
    /\bshutdown\b|\breboot\b|\bhalt\b/i,
    /\bmklink\b|\bnet\s+user\b/i,
    /\breg\s+(add|delete|edit)\b/i,
    /\b(setx|bcdedit|bootrec)\b/i,
    /\b(curl|wget|curl\.exe|wget\.exe)\b[^|;&]*\|\s*(sh|bash|zsh|pwsh|powershell|iex)\b/i,
    /\b(iex|invoke-expression)\b/i,
    /\bnc\b\s+-e|\bncat\b\s+-e/i,
    /\bssh-keygen\b|\bssh-copy-id\b/i,
    /\becho\b[^|;&]*>\s*\/dev\/(sd|nvme|hd)/i,
    /\bgit\s+push\s+(-f|--force)/i,
    /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
    /\bapt(-get)?\s+(install|remove|purge)\b/i,
    /\b(npm|pip|yum|dnf)\s+(install|uninstall|remove)\b/i,
    // Windows 特有（LOLBAS / 恶意 PowerShell 侧）
    /-encodedcommand|-enc\b/i,
    /downloadstring|downloadfile|downloaddata/i,
    /\bset-executionpolicy\b/i,
    /start-process[^|;&]*-verb\s+runas/i,
    /\bnet\s+localgroup\b/i,
    /\brundll32\b|\bregsvr32\b|\bmshta\b/i,
    /\bcertutil\b[^|;&]*(-urlcache|-decode)/i,
    /\bbitsadmin\b[^|;&]*\/(transfer|create)/i,
    /\bmsiexec\b[^|;&]*\/i\s+(http|https)/i,
    /\bwevtutil\s+cl\b/i,
    /\bfsutil\b/i,
    /\bnetsh\s+advfirewall\b/i,
    /\bnew-service\b/i,
    /\badd-type\b|\[system\.reflection\.assembly\]::load/i,
    /set-mppreference|add-mppreference|removemppreference|remove-mppreference/i,
    /\breg\s+save\b/i,
    /\bsc\s+create\b/i,
    /\bwmic\s+process\s+call\s+create\b/i,
    /\binvoke-command\b|\benter-pssession\b/i,
    /\badd-pssnapin\b/i,
];

function isDestructive(command) {
    return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// ---------- 三类语料加载 ----------

function loadSea() {
    const commands = [];
    for (let i = 1; i <= 50; i += 1) {
        const path = join(ROOT, 'User' + i);
        if (!existsSync(path)) continue;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const command = line.trim();
            // SEA 是裸命令名（绝大多数无参数），超过 120 字符的行视为异常跳过
            if (command && command.length <= 120 && !command.includes('\t')) commands.push(command);
        }
    }
    return {source: 'SEA（50 真实用户 75 万条裸命令）', kind: 'normal', commands};
}

function loadCowrie() {
    const commands = [];
    const dir = join(ROOT, 'cowrie');
    if (!existsSync(dir)) return {source: 'Cowrie 蜜罐', kind: 'attack', commands};
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
            const text = line.trim();
            if (!text) continue;
            try {
                const row = JSON.parse(text);
                // 老版 cowrie 用 cowrie.command.input，新版用 cowrie.session.input，都是攻击者输入
                if (row.eventid !== 'cowrie.command.input' && row.eventid !== 'cowrie.session.input') continue;
                // input 可能是粘贴的多行命令：按换行拆开逐条评估
                for (const part of String(row.input || '').split(/[\r\n]+/)) {
                    const command = part.trim();
                    if (command && command.length <= 2000) commands.push(command);
                }
            } catch (e) {}
        }
    }
    return {source: 'Cowrie 蜜罐（攻击者输入）', kind: 'attack', commands};
}

function loadMalbash() {
    const commands = [];
    const dir = join(ROOT, 'malbash-main');
    if (!existsSync(dir)) return {source: 'malbash 恶意脚本', kind: 'attack', commands};
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.sh')) continue;
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
            let command = line.trim();
            if (!command || command.startsWith('#')) continue;
            command = command.replace(/^\$\s+/, '').trim();
            if (command && command.length <= 2000) commands.push(command);
        }
    }
    return {source: 'malbash（恶意 bash 脚本提取）', kind: 'attack', commands};
}

// LOLBAS（Windows 白利用）：yml 的 Commands → Command 字段即滥用技法命令，攻击侧。
function loadLolbas() {
    const commands = [];
    const base = join(ROOT, 'LOLBAS-master');
    if (!existsSync(base)) return {source: 'LOLBAS（Windows 白利用）', kind: 'attack', commands};
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            const stat = statSync(path);
            if (stat.isDirectory()) {
                if (name !== '.github' && name !== 'Archive-Old-Version') walk(path);
                continue;
            }
            if (!name.endsWith('.yml')) continue;
            const text = readFileSync(path, 'utf8');
            // 提取 "Command: xxx" 行（yml 列表缩进各异，宽松匹配）
            for (const line of text.split('\n')) {
                const match = line.match(/^\s*-?\s*Command:\s*(.+)$/);
                if (!match) continue;
                const command = match[1].trim().replace(/^['"]|['"]$/g, '');
                if (command && command.length <= 2000 && !command.startsWith('>')) commands.push(command);
            }
        }
    };
    walk(base);
    return {source: 'LOLBAS（Windows 白利用命令）', kind: 'attack', commands};
}

// 恶意 PowerShell 数据集（MalwareBazaar 抽样）：.ps1 逐行取命令形态行，攻击侧。
function loadPowerShell() {
    const commands = [];
    const dir = join(ROOT, 'powershell');
    if (!existsSync(dir)) return {source: '恶意 PowerShell（MalwareBazaar 抽样）', kind: 'attack', commands};
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ps1')) continue;
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
            let command = line.trim();
            if (!command || command.startsWith('#') || command.startsWith('<#')) continue;
            // 只取命令形态行：含空格且以字母/数字/路径开头（排除纯字符串/花括号片段）
            if (!/^[a-z0-9$@(\[."/\\]/i.test(command)) continue;
            if (command.length > 2000) command = command.slice(0, 2000);
            commands.push(command);
        }
    }
    return {source: '恶意 PowerShell（MalwareBazaar 抽样）', kind: 'attack', commands};
}

// ---------- 评估 ----------

function main() {
    const weights = lcDequantize(LOCAL_CLASSIFIER_WEIGHTS, LOCAL_CLASSIFIER_QUANT.scale, LC_FEATURES.dims);
    const scoreOf = (command) => lcScore(lcExtractDims(command, LC_FEATURES), weights, LOCAL_CLASSIFIER_BIAS);
    const sources = [loadSea(), loadCowrie(), loadMalbash(), loadLolbas(), loadPowerShell()].filter((s) => s.commands.length);

    console.log('端侧线性分类器 · 公开语料 eval（只评不训，' + Object.values(LOCAL_CLASSIFIER_THRESHOLDS).join('/') + ' 阈值）');
    for (const src of sources) {
        const unique = [...new Set(src.commands)];
        const rows = unique.map((command) => ({command, score: scoreOf(command), destructive: isDestructive(command)}));
        const report = {source: src.source, kind: src.kind, raw: src.commands.length, unique: unique.length};

        for (const [name, t] of Object.entries(LOCAL_CLASSIFIER_THRESHOLDS)) {
            const allowRate = rows.filter((r) => r.score < t).length / rows.length;
            report['allow@' + name] = Number((allowRate * 100).toFixed(1));
        }
        const sorted = rows.map((r) => r.score).sort((a, b) => a - b);
        report.median = Number(sorted[Math.floor(sorted.length / 2)].toFixed(3));
        report.mean = Number((rows.reduce((acc, r) => acc + r.score, 0) / rows.length).toFixed(3));

        if (src.kind === 'attack') {
            const dangerous = rows.filter((r) => r.destructive);
            report.destructiveCount = dangerous.length;
            for (const [name, t] of Object.entries(LOCAL_CLASSIFIER_THRESHOLDS)) {
                const caught = dangerous.filter((r) => r.score >= t).length;
                report['catch@' + name] = dangerous.length
                    ? Number(((caught / dangerous.length) * 100).toFixed(1))
                    : null;
            }
            report.missedStandard = dangerous
                .filter((r) => r.score < LOCAL_CLASSIFIER_THRESHOLDS.standard)
                .sort((a, b) => a.score - b.score)
                .slice(0, 8)
                .map((r) => Number(r.score.toFixed(2)) + ' ' + r.command.slice(0, 90));
            report.overAsked = rows
                .filter((r) => !r.destructive && r.score >= LOCAL_CLASSIFIER_THRESHOLDS.standard)
                .sort((a, b) => b.score - a.score)
                .slice(0, 8)
                .map((r) => Number(r.score.toFixed(2)) + ' ' + r.command.slice(0, 90));
        } else {
            // 正常侧：被打扰最多的高分命令（策略上允许但会被转人工的真实命令）
            report.overAsked = rows
                .filter((r) => r.score >= LOCAL_CLASSIFIER_THRESHOLDS.standard)
                .sort((a, b) => b.score - a.score)
                .slice(0, 10)
                .map((r) => Number(r.score.toFixed(2)) + ' ' + r.command.slice(0, 90));
        }
        console.log(JSON.stringify(report, null, 1));
    }
}

main();
