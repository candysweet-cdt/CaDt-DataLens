---
name: cadt-mcp-config
description: 帮用户配置本机 MCP 服务器（外部工具 → MCP）：代填 command/args/cwd 与超时，环境变量值、密钥与工具授权由用户完成
---

# MCP 服务器配置（cadt-mcp-config）

用户要接入本机 MCP server 时，用 app_control 的 get_mcp_servers / set_mcp_server / delete_mcp_server 代填配置（动作签名见 cadt-ui 技能）。**环境变量值、密钥与工具授权永远由用户完成**——你只能登记 env 键名（值留空），不能设置 enabledTools。

## 字段

- name：服务器名，字母数字下划线连字符，最长 32；公开工具名会变成 mcp__<name>__<tool>。
- command + args：启动命令与参数（每项一个字符串）。npx / uvx / 绝对路径 exe 都可以；参数里如含令牌，提醒用户在设置里改，避免贴进对话。
- cwd：可选工作目录；留空继承应用目录。
- startupTimeoutMs / callTimeoutMs / closeTimeoutMs：毫秒，0 = 默认 30000 / 60000 / 5000。
- enabled：缺省启用；停用保留条目。
- envKeys：只登记环境变量名（如 ["GITHUB_TOKEN"]），值留空由用户在设置里填。已配置环境变量的服务器，AI 不能再修改或删除。

## 工作流

1. get_mcp_servers 防重名，了解已有服务器与环境变量键。
2. 按 server 官方文档写 command + args（常见：npx -y @playwright/mcp@latest；uvx mcp-server-fetch；绝对路径 exe + 参数）。
3. set_mcp_server 保存；弹出本机命令确认，用户批准后才生效。
4. **保存后必须提醒用户**：去 应用页面 → 外部工具 → MCP 服务器 → 该行「工具」勾选要授权给 AI 的工具（默认全不勾）；需要环境变量的在「编辑」里填值。
5. 用户勾选工具之前不要调用该 server 的工具；需要切换外部能力来源时，再提示用户到「能力来源」把搜索/抓取/OCR/语音绑定到该工具。

## 红线

- 不写 env 值、不设置 enabledTools；已配环境变量的服务器不可修改/删除（让用户手动操作）。
- 命令与包名必须来自用户给出的官方文档或本机已有安装，不编造包名、域名或参数。
- 每次新增/修改/删除都会弹本机命令执行确认；不要绕过，也不要让用户「直接信任」。
- 保存后提醒用户逐字核对 command/args 与文档一致，再勾选工具。
