// 把内置模型配置表导出成远端单文件仓库（cadt-datalens-data/model-catalog）用的 catalog.json。
// 用法：node scripts/export-model-catalog.mjs > catalog.json
// 内置表（frontend/src/ai/core/model-catalog.js）是随版本发布的快照，仓库里那份是
// 不发版也能更新的远端表；两者格式完全一致，字段归一与合并规则都在同一个模块里。
import {BUILTIN_CATALOG} from '../frontend/src/ai/core/model-catalog.js';

const output = {
    version: BUILTIN_CATALOG.version,
    source: 'cadt-datalens-data/model-catalog',
    models: BUILTIN_CATALOG.models,
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
