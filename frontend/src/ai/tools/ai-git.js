// AI 面板 Git 快捷操作：动作表 + 预设提示词（纯函数，无 DOM）。
// 菜单只负责把提示词注入当前会话，具体提交/推送/拉取由 AI 通过
// run_command / ask_user / write_file 完成，权限与审批沿用当前会话设置。
import {buildOutlineMaintainPrompt} from './ai-outline.js';

// 每个工作区自己的提交风格配置（相对范围根）；首次提交时由 AI 询问用户后写入。
export const GIT_COMMIT_STYLE_PATH = '.cadt/config/git-commit-style.json';

export const GIT_ACTIONS = [
    {id: 'commit-push', label: '提交并推送', icon: 'git-commit-push', isGit: true},
    {id: 'commit', label: '提交代码', icon: 'git-commit', isGit: true},
    {id: 'push', label: '推送代码', icon: 'upload', isGit: true},
    {id: 'pull', label: '拉取代码', icon: 'download', isGit: true},
];

// 「其他操作」分组：与 git 动作同属快捷操作菜单，但走各自的提示词。
// requiresCognition=true 的项只在认知索引开关打开时显示（显隐判定在 ai-git-ui.js）。
// msgIcon 用于应用消息卡片覆盖 kind='git' 的默认图标。
export const OTHER_ACTIONS = [
    {id: 'cognition-maintain', label: '维护认知索引', icon: 'book-plus', msgIcon: 'book-plus', requiresCognition: true},
    {id: 'release-notes', label: '生成更新日志', icon: 'doc', msgIcon: 'doc'},
    {id: 'outline-maintain', label: '维护文件大纲', icon: 'list', msgIcon: 'list'},
];

const STYLE_RULES = [
    '提交信息风格：先读取工作区的 `' + GIT_COMMIT_STYLE_PATH + '`。',
    '- 文件存在且可解析：严格按其中的 style / language / coAuthors / coAuthorLine / custom / granularity / allowCrossFiles / autoResolveConflict / autoSetUpstream / autoStashOnPull / allowAmend / repository 字段执行。',
    '- 文件若带 remark 等额外字段：remark 视为用户的补充说明一并遵守（例如「允许文件交叉」即等价于 allowCrossFiles 的行为）。',
    '- 文件不存在或无法解析：先用 git remote 列出全部上游远端，再用 ask_user 一次性询问用户（最多 8 个问题，这里 5 或 6 题取决于远端数量；每个都标 recommended，并传 timeoutAction="recommended"，超时自动采用推荐项）：',
    '  1) 提交信息风格：Conventional Commits「type(scope): 描述」（推荐）/ 简洁中文说明 / Gitmoji / 自定义（由用户自己输入要求）；',
    '  2) 提交信息语言：中文（推荐）/ 英文；',
    '  3) 是否在提交信息末尾追加 Co-authored-by 署名：不追加（推荐）/ 追加（再让用户输入署名内容）；',
    '  4) 提交粒度：按功能/主题分批提交（推荐）/ 一次性全部提交；',
    '  5) 附加行为偏好（多选，可一项都不选；超时默认一项都不选，保持当前安全行为）：允许主题/文件交叉（提交分组时不过度拆分，耦合/交叉文件可放同一批）/ 自动处理合并冲突（push/pull 冲突时不再询问，逐文件读取冲突内容智能判断取舍，处理后汇报）/ 推送自动设上游（无上游时自动 git push -u，不再询问）/ 拉取自动 stash（被本地未提交改动阻止时自动 stash 后重试并恢复）/ 允许 amend 修正（用户明确要求时可 git commit --amend 修正上次提交）。',
    '  6) 允许推送到哪些远端（仅当 git remote 检测到多于一个上游远端时才问这一题；只有一个远端时跳过、自动把该唯一远端名写入 repository。多选，选项为 git remote 列出的全部远端名，默认全部勾选；超时采用推荐项即全部勾选）：推送时按勾选的远端逐一推送。',
    '  拿到答案后把配置写入 `' + GIT_COMMIT_STYLE_PATH + '`（父目录会自动创建），JSON 格式：',
    '  {"version":3,"style":"conventional|plain|gitmoji|custom","language":"zh|en","coAuthors":false,"coAuthorLine":"","custom":"","granularity":"batch|single","allowCrossFiles":false,"autoResolveConflict":false,"autoSetUpstream":false,"autoStashOnPull":false,"allowAmend":false,"repository":["origin"]}',
    '  风格含义：conventional =「type(scope): 描述」；plain = 简洁的自然语言说明；gitmoji = emoji 前缀 + 说明；custom = 按 custom 字段的自定义要求；coAuthors=true 时把 coAuthorLine 原样追加到提交信息末尾。',
    '  粒度含义：batch = 按功能/主题分批提交（一批一 commit，符合项目惯例）；single = 所有改动一次提交。',
    '  附加行为偏好含义（第 5 题勾选的项置 true，其余 false）：allowCrossFiles = 提交分组时不过度拆分，耦合/交叉文件允许同批；autoResolveConflict = push/pull 遇冲突不再 ask_user，逐文件智能判断保留内容后解决并汇报取舍；autoSetUpstream = push 无上游时自动 git push -u；autoStashOnPull = pull 被本地未提交改动阻止时自动 stash 后重试并恢复；allowAmend = 用户明确要求时可用 git commit --amend。以上偏好未勾选时一律沿用「先询问 / 不自动处理」的安全默认。',
    '  repository 含义（第 6 题勾选的远端名数组）：列出允许推送的 git remote 名；推送时按此数组逐一推送到各远端。只有一个远端时自动写入该远端、不问第 6 题；多远端时才问。',
    '  之后同一工作区的提交直接读这个文件，不要重复询问（包括 repository 也不再问）。',
].join('\n');

// 附加行为偏好：读取配置后覆盖下文各流程的默认步骤。字段为 false / 缺失 /
// 配置文件不存在时，一律沿用「先询问 / 不自动处理」的安全默认。
const BEHAVIOR_RULES = [
    '［附加行为偏好 · 按配置覆盖］读取 `' + GIT_COMMIT_STYLE_PATH + '`，按以下字段覆盖下文流程的默认步骤（字段为 false / 缺失 / 文件不存在时沿用默认）：',
    '- allowCrossFiles=true：提交分组时不强求文件互不相干，改动高度耦合的文件可放同一批，不要为拆分而拆分。',
    '- autoResolveConflict=true：push/pull 合并产生冲突时不再 ask_user，改为逐文件读取冲突标记（<<<<<<< / ======= / >>>>>>>）理解双方意图，结合 git log 与文件上下文智能判断保留内容，解决后 git add 并完成合并提交，简要汇报每个冲突文件的取舍；个别冲突无法可靠判断时该处仍回退到 ask_user。',
    '- autoSetUpstream=true：push 无上游时自动执行 git push -u origin <分支>，不再提示。',
    '- autoStashOnPull=true：pull 因本地未提交改动被阻止时，自动 git stash（带说明消息）后重试 git pull，成功后 git stash pop 恢复；pop 产生冲突时按 autoResolveConflict 的规则处理，仍无法解决则保留 stash 并告知用户用 git stash list 找回，绝不丢弃改动。',
    '- allowAmend=true：仅当用户明确要求「修正上一次提交 / amend」时才用 git commit --amend，绝不主动 amend。',
    '- repository（远端名数组）：推送时按其中列出的每个 git remote 逐一执行 git push <远端名> <分支>；字段缺失或为空数组时退回默认行为（推当前分支的上游，无上游按 autoSetUpstream 处理），不要臆造远端名。',
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
        BEHAVIOR_RULES,
        '',
        '流程：',
        '1. 运行 git status / git diff 查看改动，只挑选应当提交的文件（跳过构建产物、临时文件与明显无关的内容；必要时先看 .gitignore）。',
        '2. 按配置写提交信息：主题行说明「为什么」而不只是「改了什么」，不要编造没有做过的改动；conventional 风格用 feat/fix/refactor/docs/chore/test/build/perf 等类型，可按改动范围加 scope。',
        '3. 按配置的 granularity 决定提交粒度：batch = 按功能/主题分组，一组一组逐文件 git add（不要 git add -A / git add .）分别 commit，每批一个主题（allowCrossFiles=true 时耦合/交叉文件可同批，不要为拆分而拆分）；single = 全部改动一次提交。',
        '4. 汇报每个提交的哈希与完整提交信息。没有可提交的改动就直说，不要制造空提交。',
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
        BEHAVIOR_RULES,
        '',
        '1. 运行 git status -sb 与 git log @{u}..HEAD --oneline 查看上游与待推送提交；读取配置里的 repository 远端名数组。',
        '2. 推送：repository 非空时按其中每个远端逐一执行 git push <远端名> ' + (tip || '<当前分支>') + '；repository 缺失或为空时执行 git push，没有上游时 autoSetUpstream=true 则直接 git push -u origin ' + (tip || '<当前分支>') + '，否则提示用户设置上游后再推送。',
        '3. 如果 push 被拒绝且原因只是远端有新提交（non-fast-forward）：',
        '   - 直接执行 git pull --no-rebase --no-edit 自动合并，不要询问用户；',
        '   - 合并成功后重新执行 git push；',
        '   - 如果合并产生冲突：autoResolveConflict=true 时按上文「附加行为偏好」逐文件智能解决后重新 push；否则先 ask_user 询问冲突处理偏好（例如整体以本地还是远端为准、或逐文件判断），再按回答解决冲突、git add、完成合并提交后重新 push。',
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
        BEHAVIOR_RULES,
        '',
        '1. 运行 git status -sb 查看当前分支、上游与工作区改动。',
        '2. 执行 git pull --no-rebase --no-edit。',
        '3. 能快进或自动合并时直接完成，不要询问用户。',
        '4. 如果因为本地未提交改动被阻止：autoStashOnPull=true 时按上文「附加行为偏好」自动 stash 后重试并恢复；否则用 ask_user 询问用户如何处理（先提交 / 暂存 stash 后重试 / 取消拉取），按回答执行；无论如何都不要丢弃用户改动。',
        '5. 如果合并产生冲突：autoResolveConflict=true 时按上文「附加行为偏好」逐文件智能解决；否则先 ask_user 询问冲突处理偏好（例如整体以本地还是远端为准、或逐文件判断），再按回答解决冲突、git add 并完成合并提交。',
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
        BEHAVIOR_RULES,
        '',
        '提交：',
        '1. 运行 git status / git diff 查看改动，只挑选应当提交的文件（跳过构建产物、临时文件与明显无关的内容）。',
        '2. 按配置的 granularity 决定提交粒度：batch = 按功能/主题分组，一组一组逐文件 git add（不要 git add -A）分别 commit，每批一个主题（allowCrossFiles=true 时耦合/交叉文件可同批）；single = 全部改动一次提交。',
        '3. 按配置写提交信息后 git commit；汇报每个提交的哈希与完整提交信息，没有可提交的改动就直说。',
        '',
        '推送：',
        '4. 推送：repository 非空时按其中每个远端逐一执行 git push <远端名> ' + (tip || '<当前分支>') + '；repository 缺失或为空时执行 git push，没有上游时 autoSetUpstream=true 则直接 git push -u origin ' + (tip || '<当前分支>') + '，否则提示用户设置上游后再推送。',
        '5. 如果 push 被拒绝且原因只是远端有新提交（non-fast-forward）：直接执行 git pull --no-rebase --no-edit 自动合并（不要询问用户），合并成功后重新 push。',
        '6. 如果合并产生冲突：autoResolveConflict=true 时按上文「附加行为偏好」逐文件智能解决后重新 push；否则先 ask_user 询问冲突处理偏好（例如整体以本地还是远端为准、或逐文件判断），再按回答解决冲突、git add、完成合并提交后重新 push。',
        '7. 汇报分支、远端与推送结果。',
        '',
        '约束：不要使用 git push --force；命令需要当前会话处于写权限档；工具不可用或被拒绝时说明并停止。',
    ].join('\n');
}

function cognitionMaintainFlow(root) {
    return [
        '［快捷操作 · 维护认知索引］',
        repoLine(root, ''),
        '',
        '为本工作区维护 .cadt/cognition/ 认知索引卷（场景 scene=code）：',
        '1. 先调用 cognition_status 看当前卷的治理状态（scene、条目 / 字节与预算、drift 四态与卷指纹）。',
        '2. 卷不存在或几乎为空：按认知索引规范为本工作区首建——按目录分批，一批只读该目录直接成员、读完立即写该批条目；首建第一批必须带 meta（scene / budget / 标签字典 / build / ruleN）。',
        '3. 卷已存在：只修与当前任务相关的 Missing / Stale 条目；drift 与本任务无关的忽略，Missing 不要求清零。',
        '4. 本轮若改动过代码文件，完成改动后用 cognition_edit 维护受影响条目（这是职责不是可选项）；条目语义与代码冲突时以代码为准并修正条目。',
        '5. 全程只经 cognition_edit 以 CAS 写卷，不要用 write_file / edit_file 直写 .cadt/cognition（会绕过预算、规则与 CAS 校验，覆盖锁文件还会打破单写者互斥）。',
        '6. 简要汇报：新建 / 更新了多少条目、当前预算占用与剩余 drift。',
        '',
        '约束：认知卷是给 AI 的跨会话语义层，不存代码内容（找代码用 search_text / glob）；工作区外与数据目录不建卷。',
    ].join('\n');
}

function releaseNotesFlow(root, branch) {
    return [
        '［快捷操作 · 生成更新日志］',
        repoLine(root, branch),
        '',
        '基于本会话变更记录与 git 记录生成面向用户的更新日志 / 发布说明：',
        '1. 汇总依据：当前会话的变更记录、git diff / 提交信息、用户描述；没有依据的内容不要编造。',
        '2. 面向最终用户写：说明「能做什么、有什么变化、修复了什么」，不堆工程术语。',
        '3. 使用 Markdown，按「新增 / 改进 / 修复 / 移除」分组；每条一句话，必要时附一句使用方式；没有内容的分类直接省略。',
        '4. 保持克制：小改动不要写成大版本；给出建议版本号与发布日期，但不要擅自写入文件（除非用户明确要求）。',
        '5. 结果先输出到会话里给用户过目，不直接改 CHANGELOG.md。',
        '',
        '约束：与提交工作流配套，但不替用户执行 git commit；命令需要写权限档时按会话权限走审批。',
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
        case 'cognition-maintain': return cognitionMaintainFlow(root);
        case 'release-notes': return releaseNotesFlow(root, branch);
        case 'outline-maintain': return buildOutlineMaintainPrompt(root);
        default: return '';
    }
}
