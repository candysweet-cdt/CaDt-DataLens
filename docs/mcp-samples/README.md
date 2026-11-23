# docs/mcp-samples：外部工具本地来源示例

这些示例用于验证「关闭 / 本地 MCP / 服务提供商」三种来源都能跑通。**自 2026-11-16 起，
三份脚本已随 exe 内嵌**：设置 → AI → 外部工具 → MCP 服务器 → 内置示例可一键释放并注册；
本目录保留用于单独分发、审查与修改脚本。核心不打包 OCR / ASR / TTS 引擎与模型（体积红线），
Python、whisper.cpp 与 ggml 模型仍由用户自备。

| 能力 | 示例 | 工具名 | 运行环境 | 说明 |
| --- | --- | --- | --- | --- |
| 语音合成 | `tts-sapi.ps1` | `tts_sapi` | **Windows PowerShell 5.1**（自带） | Windows SAPI 落盘 WAV，零安装 |
| OCR / 文件解析 | `ocr-windows.ps1` | `ocr_windows` | **Windows PowerShell 5.1**（WinRT） | Windows.Media.Ocr；中文需语言包；PDF 先转图 |
| 语音识别 | `asr-whisper.md` | `asr_whisper` | Python 3 + whisper.cpp | 模型自备；见文档内嵌脚本 |

## 配置步骤（三个示例通用）

1. 设置 → AI → 外部工具 → MCP 服务器 → 添加服务器：
   - 名称：字母数字下划线连字符（如 `tts_sapi`）；公开工具名 = `mcp__<名称>__<工具名>`。
   - 启动命令 + 参数：
     - TTS：`powershell` / `-NoProfile -ExecutionPolicy Bypass -File D:\...\tts-sapi.ps1`
     - OCR：`powershell` / `-NoProfile -ExecutionPolicy Bypass -File D:\...\ocr-windows.ps1`
     - ASR：`python` / `-u D:\...\asr-whisper.py`（环境变量见 asr-whisper.md）
   - 服务器命令会在本机执行，等同于用户自己运行它；保存前应用会要求确认。
2. 保存后在服务器行的「工具」面板勾选对应工具。
3. 回「能力来源」把该能力设为「本地 MCP」，二级下拉选 `mcp__<名称>__<工具名>`。
4. 来源=本地 MCP 时，AI 只在**写权限档（非计划模式）**能看到这些工具，调用走写工具审批
   （按绑定工具名匹配项目规则）。

## 参数契约（核心固定传入）

| 能力 | 核心参数 | server 返回 |
| --- | --- | --- |
| 搜索 | `{query, count}` | 纯文本 |
| 抓取 | `{url}` | 纯文本 |
| OCR | `{path, purpose}` | 纯文本（可按页分节） |
| 语音合成 | `{text, voice}` | server 落盘并把文件路径写进返回文本 |
| 语音识别 | `{path}` | 纯文本 |

结果一律按文本透传；核心只做来源标注，不解析 server 的结构化返回。
