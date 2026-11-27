// ai-outline.js：【维护文件大纲】快捷操作的提示词构造（纯函数，无 DOM）。
// 仿 ai-git.js：菜单/按钮只把这段提示词注入当前会话，实际诊断与写入由 AI 通过
// code_outline / glob / read_file 完成，权限与审批沿用当前会话设置。

/**
 * 构造「工作区智能批量维护文件大纲」提示词。
 * @param {string} root 工作区根路径
 * @returns {string}
 */
export function buildOutlineMaintainPrompt(root) {
    const ws = String(root || '').trim() || '（当前工作区）';
    return [
        '［快捷操作 · 维护文件大纲］',
        '工作区：' + ws,
        '',
        '为本工作区值得建大纲的源码文件建立分节注释（跨语言，工具会自动识别语言）：',
        '1. 先用 glob / list_dir 摸清工作区里的源码文件（.js/.ts/.go/.py/.java/.c/.cpp/.cs/.rs/.rb/.php/.swift/.kt/.sql/.sh 等）。跳过 node_modules / dist / .git / vendor / 依赖目录与二进制文件。',
        '2. 对每个候选文件先 code_outline {path, sectionsOnly:true} 看行数与是否已有分节注释。只对「值得建大纲的大文件」处理，判定标准：源码文件且（>500 行或 >20KB）且尚无分节注释。小文件、已有分节的文件一律跳过，不要画蛇添足。',
        '3. 对每个入选文件：先 code_outline {path, action:read} 拿完整函数/类清单，再把它们归纳成 5~10 个语义分区（每区一个语义标题 + 该区首个符号名 startName，或符号名列表 symbolNames）。标题要有意义（如「配置与启动」「解析与格式化」「工具执行」），不要只写「函数」。',
        '4. 用 code_outline {path, action:maintain, sections:[...]} 写入分节注释。工具会按语言自动选注释符（JS/Go/Java 用 //，Python/Shell/YAML 用 #，SQL 用 --，HTML/XML 用 <!-- -->），把注释插到各区首个符号前，写入会弹 diff 预览与审批——逐个确认，不要跳过审批或绕过工具直接改文件。',
        '5. 若某文件符号名匹配失败、写入被拒或用户否决，跳过该文件并在汇报里说明原因，不要强推。',
        '6. 简要汇报：处理了哪些文件（各插入几处分节）、跳过了哪些及原因。',
        '',
        '约束：分节注释是可选导航约定，目的是让后续读大文件更快定位，不是给代码加文档注释；不要改动函数体、不要重命名符号、不要动无关文件。写入需要写权限档；只读会话请提示用户切换权限后再试。',
    ].join('\n');
}
