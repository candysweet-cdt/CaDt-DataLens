---
name: cadt-mcp-samples
description: 内置 MCP 示例：用户缺本地 TTS / OCR / ASR 时，推荐并用 install_mcp_sample 安装（脚本内嵌，引擎与模型由系统/用户提供）
---

# 内置 MCP 示例（cadt-mcp-samples）

用户缺本地语音合成 / OCR / 语音识别，又不想接外部服务商时，先 list_mcp_samples，再按需要推荐：

- tts_sapi：Windows SAPI 语音合成，系统自带、离线；无需额外安装。
- ocr_windows：Windows.Media.Ocr 图片文字识别；需要 Windows PowerShell 5.1 与对应语言包，PDF 需先转图片。
- asr_whisper：whisper.cpp 语音识别；需要 Python、whisper-cli.exe 与 ggml 模型（用户自备，应用不打包）。

## 工作流

1. 说明该示例的能力、前置条件、会写入 mcp.json；问用户是否安装。
2. 用户同意后调用 install_mcp_sample {id}；会弹「本机命令执行」确认，批准后才释放脚本并注册服务器。
3. 安装后提醒用户：去 应用页面 → 外部工具 → 能力来源 把对应能力（tts / ocr / asr）绑定到示例返回的 publicToolName；ASR 还要在 MCP 服务器 → 编辑 里填写 WHISPER_CLI / WHISPER_MODEL 的值。
4. 本机 MCP 只在写权限档（非计划模式）向 AI 开放；只读档/计划模式看不到这些工具。

## 红线

- 不要不经用户同意就安装；每次安装都要经过确认卡。
- 不要声称应用内置了 Python、whisper 模型或 OCR 引擎——只内置脚本。
- 不要替用户填环境变量值、不要替用户勾选其他工具；安装示例只启用该示例自己的工具。
- 已存在同名服务器时安装会被拒绝，让用户在设置里先处理。
