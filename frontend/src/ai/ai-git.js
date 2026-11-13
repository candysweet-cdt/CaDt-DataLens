// AI 面板 Git 快捷操作：动作表 + 预设提示词（纯函数，无 DOM）。
// 菜单只负责把提示词注入当前会话，具体提交/推送/拉取由 AI 通过
// run_command / ask_user / write_file 完成，权限与审批沿用当前会话设置。

// 每个工作区自己的提交风格配置（相对范围根）；首次提交时由 AI 询问用户后写入。
export const GIT_COMMIT_STYLE_PATH = '.cadt/git-commit-style.json';

export const GIT_ACTIONS = [
    {id: 'commit-push', label: '提交并推送'},
    {id: 'commit', label: '提交代码'},
    {id: 'push', label: '推送代码'},
    {id: 'pull', label: '拉取代码'},
];

const STYLE_RULES = [
    '提交信息风格：先读取工作区的 `' + GIT_COMMIT_STYLE_PATH + '`。',
    '- 文件存在且可解析：严格按其中的 style / language / coAuthors / coAuthorLine / custom 字段执行。',
    '- 文件不存在或无法解析：用 ask_user 一次性询问用户（最多 3 个问题，每个都标 recommended，并传 timeoutAction="recommended"，超时自动采用推荐项）：',
    '  1) 提交信息风格：Conventional Commits「type(scope): 描述」（推荐）/ 简洁中文说明 / Gitmoji / 自定义（由用户自己输入要求）；',
    '  2) 提交信息语言：中文（推荐）/ 英文；',
    '  3) 是否在提交信息末尾追加 Co-authored-by 署名：不追加（推荐）/ 追加（再让用户输入署名内容）。',
    '  拿到答案后把配置写入 `' + GIT_COMMIT_STYLE_PATH + '`（父目录会自动创建），JSON 格式：',
    '  {"version":1,"style":"conventional|plain|gitmoji|custom","language":"zh|en","coAuthors":false,"coAuthorLine":"","custom":""}',
    '  风格含义：conventional =「type(scope): 描述」；plain = 简洁的自然语言说明；gitmoji = emoji 前缀 + 说明；custom = 按 custom 字段的自定义要求；coAuthors=true 时把 coAuthorLine 原样追加到提交信息末尾。',
    '  之后同一工作区的提交直接读这个文件，不要重复询问。',
].join('\n');

function repoLine(root, branch) {
    const path = String(root || '').trim() || '（当前工作区）';
    const tip = String(branch || '').trim();
    return '工作区：' + path + (tip ? '\n当前分支：' + tip : '');
}

function commitFlow(root, branch) {
    return [
        '［Git 快捷操作 · 提交代码］',
        repoLine(root, branch),
        '',
        STYLE_RULES,
        '',
        '流程：',
        '1. 运行 git status / git diff 查看改动，只挑选应当提交的文件（跳过构建产物、临时文件与明显无关的内容；必要时先看 .gitignore）。',
        '2. 按配置写提交信息：主题行说明「为什么」而不只是「改了什么」，不要编造没有做过的改动；conventional 风格用 feat/fix/refactor/docs/chore/test/build/perf 等类型，可按改动范围加 scope。',
        '3. 逐文件 git add（不要 git add -A / git add .），再 git commit。',
        '4. 汇报提交哈希与完整提交信息。没有可提交的改动就直说，不要制造空提交。',
        '',
        '约束：命令需要当前会话处于写权限档；工具不可用或被拒绝时向用户说明原因并停止，不要绕过审批。',
    ].join('\n');
}

function pushFlow(root, branch) {
    const tip = String(branch || '').trim();
    return [
        '［Git 快捷操作 · 推送代码］',
        repoLine(root, branch),
        '',
        '1. 运行 git status -sb 与 git log @{u}..HEAD --oneline 查看上游与待推送提交。',
        '2. 执行 git push；没有上游时用 git push -u origin ' + (tip || '<当前分支>') + '。',
        '3. 如果 push 被拒绝且原因只是远端有新提交（non-fast-forward）：',
        '   - 直接执行 git pull --no-rebase --no-edit 自动合并，不要询问用户；',
        '   - 合并成功后重新执行 git push；',
        '   - 如果合并产生冲突：先 ask_user 询问冲突处理偏好（例如整体以本地还是远端为准、或逐文件判断），再按回答解决冲突、git add、完成合并提交后重新 push。',
        '4. 汇报分支、远端与推送结果。',
        '',
        '约束：不要使用 git push --force；命令需要当前会话处于写权限档；工具不可用或被拒绝时说明并停止。',
    ].join('\n');
}

function pullFlow(root, branch) {
    return [
        '［Git 快捷操作 · 拉取代码］',
        repoLine(root, branch),
        '',
        '1. 运行 git status -sb 查看当前分支、上游与工作区改动。',
        '2. 执行 git pull --no-rebase --no-edit。',
        '3. 能快进或自动合并时直接完成，不要询问用户。',
        '4. 如果因为本地未提交改动被阻止：用 ask_user 询问用户如何处理（先提交 / 暂存 stash 后重试 / 取消拉取），按回答执行；不要丢弃用户改动。',
        '5. 如果合并产生冲突：先 ask_user 询问冲突处理偏好（例如整体以本地还是远端为准、或逐文件判断），再按回答解决冲突、git add 并完成合并提交。',
        '6. 汇报拉取结果（新增提交与合并情况）。',
        '',
        '约束：命令需要当前会话处于写权限档；工具不可用或被拒绝时说明并停止。',
    ].join('\n');
}

function commitPushFlow(root, branch) {
    const tip = String(branch || '').trim();
    return [
        '［Git 快捷操作 · 提交并推送］',
        repoLine(root, branch),
        '',
        STYLE_RULES,
        '',
        '提交：',
        '1. 运行 git status / git diff 查看改动，只挑选应当提交的文件（跳过构建产物、临时文件与明显无关的内容）。',
        '2. 按配置写提交信息后，逐文件 git add（不要 git add -A），再 git commit。',
        '3. 汇报提交哈希与完整提交信息；没有可提交的改动就直说。',
        '',
        '推送：',
        '4. 执行 git push；没有上游时用 git push -u origin ' + (tip || '<当前分支>') + '。',
        '5. 如果 push 被拒绝且原因只是远端有新提交（non-fast-forward）：直接执行 git pull --no-rebase --no-edit 自动合并（不要询问用户），合并成功后重新 push。',
        '6. 如果合并产生冲突：先 ask_user 询问冲突处理偏好（例如整体以本地还是远端为准、或逐文件判断），再按回答解决冲突、git add、完成合并提交后重新 push。',
        '7. 汇报分支、远端与推送结果。',
        '',
        '约束：不要使用 git push --force；命令需要当前会话处于写权限档；工具不可用或被拒绝时说明并停止。',
    ].join('\n');
}

export function buildGitActionPrompt(id, context) {
    const root = (context && context.root) || '';
    const branch = (context && context.branch) || '';
    switch (id) {
        case 'commit': return commitFlow(root, branch);
        case 'push': return pushFlow(root, branch);
        case 'pull': return pullFlow(root, branch);
        case 'commit-push': return commitPushFlow(root, branch);
        default: return '';
    }
}
