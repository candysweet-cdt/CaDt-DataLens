#!/usr/bin/env node
// sync-version.mjs：把 app_core.go 的 appVersion 同步到其余四处版本文件。
//
// 为什么不能只留一处：这四处是四个不同阶段、不同工具链的输入，互相读不到——
//   ① wails.json                安装包/exe 属性的元数据（v2 遗留，本项目仅作回退源与约定）
//   ② build/windows/info.json   wails3 generate syso 的输入，决定 exe 的 PE 版本资源
//   ③ wails_tools.nsh           NSIS 脚本的 !define，决定安装包版本与注册表 DisplayVersion
//   ④ build/config.yml          wails3 update build-assets 的模板源，会回灌 ②③
// 所以只能「改一处 + 机器同步其余」，别靠发版时手工对齐（漏改等于发出去一个版本错的安装包）。
//
// 用法：
//   node scripts/sync-version.mjs          # 把不一致的四处写成 appVersion 的值
//   node scripts/sync-version.mjs --check  # 只检查，不一致退出码 1（挂 CI / 测试用）

import {readFileSync, writeFileSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 每条 spec 的 pattern 必须交出两个捕获组：组 1 = 值之前的全部文本、组 2 = 值之后的文本，
// 值本体不含引号。expect 是「这份文件里应命中几处」，文件结构被改坏时能当场发现。
export const SPECS = [
    {
        file: 'wails.json',
        label: 'wails.json info.productVersion',
        pattern: /("productVersion"\s*:\s*")[^"]*(")/,
        expect: 1,
    },
    {
        file: 'build/windows/info.json',
        label: 'build/windows/info.json 版本资源',
        // fixed.file_version / fixed.product_version / info.0409.FileVersion / ProductVersion
        pattern: /("(?:file_version|product_version|FileVersion|ProductVersion)"\s*:\s*")[^"]*(")/g,
        expect: 4,
    },
    {
        file: 'build/windows/installer/wails_tools.nsh',
        label: 'wails_tools.nsh INFO_PRODUCTVERSION',
        pattern: /(!define\s+INFO_PRODUCTVERSION\s+")[^"]*(")/,
        expect: 1,
    },
    {
        file: 'build/config.yml',
        label: 'build/config.yml info.version',
        // 只认 info: 块下两空格缩进的 version；顶部 version: '3' 是 schema 版本、注释里的不匹配
        pattern: /(^info:\n(?:[^\n]*\n)*?[ \t]{2}version:[ \t]+")[^"]*(")/m,
        expect: 1,
    },
];

// 从 app_core.go 源码抽出不带 v 前缀的版本号（NSIS / PE 资源都不接受 v 前缀）。
export function parseAppVersion(goSource) {
    const m = goSource.match(/const\s+appVersion\s*=\s*"([^"]*)"/);
    if (!m) throw new Error('app_core.go 里找不到 `const appVersion = "…"`');
    const raw = m[1];
    const version = raw.startsWith('v') ? raw.slice(1) : raw;
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`appVersion 不是 vX.Y.Z 形式：${raw}`);
    }
    return version;
}

// 把一份文件的版本字段改写成 version，返回新文本与命中数（命中数交给调用方与 expect 对账）。
export function applyVersion(spec, text, version) {
    let hits = 0;
    const next = text.replace(spec.pattern, (_m, pre, post) => {
        hits += 1;
        return pre + version + post;
    });
    return {next, hits};
}

function main() {
    const check = process.argv.includes('--check');
    const version = parseAppVersion(readFileSync(join(ROOT, 'app_core.go'), 'utf8'));
    let drift = 0;
    for (const spec of SPECS) {
        const path = join(ROOT, spec.file);
        const text = readFileSync(path, 'utf8');
        const {next, hits} = applyVersion(spec, text, version);
        if (hits !== spec.expect) {
            console.error(`✗ ${spec.label}：应命中 ${spec.expect} 处版本字段，实际 ${hits} 处（文件结构改了？）`);
            process.exitCode = 1;
            continue;
        }
        if (next === text) {
            console.log(`= ${spec.label} 已是 ${version}`);
            continue;
        }
        drift += 1;
        if (check) {
            console.error(`✗ ${spec.label} 与 appVersion ${version} 不一致`);
            continue;
        }
        writeFileSync(path, next);
        console.log(`✓ ${spec.label} → ${version}`);
    }
    if (check) {
        if (drift === 0) console.log(`全部 ${SPECS.length} 处与 appVersion ${version} 一致`);
        else process.exitCode = 1;
    } else if (drift > 0) {
        console.log(`已同步 ${drift} 处；记得提交这些文件`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
