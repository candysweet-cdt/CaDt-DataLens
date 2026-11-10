# 打包与发布流程

本文档描述 CaDt-DataLens 的两种发布形态、构建命令、安装/卸载行为、代码签名和发布前检查。

- 便携版：单个 `datalens.exe`，不写注册表也能运行。
- 安装包：NSIS 安装程序（按当前用户安装），负责注册表集成、开始菜单、卸载项、WebView2 运行时和可选的 Agent Skill。

产物统一输出到 `build/bin/`。

## 1. 前置工具

| 工具 | 用途 | 获取方式 |
| --- | --- | --- |
| Go 1.26+ | 编译后端 | 系统安装 |
| Node.js 20.19+ / 22.12+ | 构建前端 | 系统安装 |
| Wails CLI v2.17.1 | 构建入口 | `go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1` |
| NSIS 3（`makensis`） | 生成安装包 | 安装 [NSIS](https://nsis.sourceforge.io/)，或用便携版目录 |
| `signtool` | 代码签名 | Windows SDK，或 NuGet 包 `Microsoft.Windows.SDK.BuildTools` |

`scripts/build-installer.ps1` 自动查找工具，顺序如下：

- `makensis`：`-MakeNsis` 参数 → 环境变量 `makensis` → PATH → `%LOCALAPPDATA%\cadt-tools\**` → `%LOCALAPPDATA%\Temp\nsis-portable\**` → `C:\Program Files (x86)\NSIS\makensis.exe`
- `signtool`：`-SignTool` 参数 → 环境变量 `signtool` → PATH → `%LOCALAPPDATA%\cadt-tools\sdk-buildtools\bin\*\x64\signtool.exe` → Windows Kits 目录

`wails build -nsis` 本身也要求 `makensis` 在 PATH 中；缺失时它只打印警告、不生成安装包，脚本会自行补上路径。

## 2. 版本号

版本号只有一个真源：`app.go` 的 `appVersion`（当前 `v1.0.0`）。

- `wails.json` 的 `info.productVersion` 决定 exe 文件属性与安装包版本，必须与 `appVersion` 一致（去掉 `v` 前缀）。
- 单测 `TestWailsInfoVersionMatchesAppVersion` 会强制校验，不一致时 `go test ./...` 失败。
- NSIS 要求四段数字，Wails 会自动把 `1.0.0` 补成 `1.0.0.0`。
- 发新版本时两处一起改，再跑测试。

### Release 命名与检查更新

程序内的“检查更新”读取 Gitee 的 `GET /repos/candysweet-cdt/CaDt-DataLens/releases/latest`：

- 版本号取 Release 的 **tag_name**（必须是 `vX.Y.Z`，例如 `v1.0.1`），按数字段与当前 `appVersion` 比较。
- 更新说明取 Release 的 `body`，在软件内按 Markdown 渲染。
- 安装包取 Release 资产中文件名带 `installer` 的 `.exe`，没有时取第一个 `.exe`。
- 还没有任何 Release 时，软件显示“仓库尚未发布正式版本”。

发布新版本时：改版本号 → 构建安装包 → 在 Gitee 用同名 tag 创建 Release，把安装包作为资产上传，并在说明里写本次变更（可直接复制 `CHANGELOG.md` 对应小节）。

## 3. 便携版

```bash
wails build -devtools
```

`-devtools` 让生产版保留 WebView2 开发者工具；软件内“设置 → 开发者模式”开启后，帮助菜单会出现“开发者工具”。不加该参数时其余功能不受影响，但帮助菜单无法打开开发者工具。

产物：`build/bin/CaDt-DataLens.exe`。发布时通常改名为 `datalens.exe`（程序内的 `datalens` PATH 命令、Agent Skill 文档都按这个文件名工作）。

便携版不写任何注册表；文件关联、右键菜单、PATH、Agent Skill 都可以在程序内“设置 → 系统集成”里按需开启。

## 4. 安装包

一键构建（含签名）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1
```

脚本流程：

1. `wails build -nsis -installscope user`：编译程序，重新生成 `build/windows/installer/wails_tools.nsh`、WebView2 bootstrapper（`build/windows/installer/tmp/`）和安装包模板需要的文件。
2. 用 `signtool` 签名 `build/bin/CaDt-DataLens.exe`（安装包内嵌的就是这个已签名文件）。
3. 在 `build/windows/installer` 目录手工调用 `makensis` 重新打包，并传入 `-DSIGNTOOL`、`-DSIGN_ARGS`；`project.nsi` 中的 `!finalize` / `!uninstfinalize` 负责给安装包和卸载程序签名。
4. 对程序 exe 和安装包执行 `signtool verify /pa /v`。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-SkipFrontend` | 跳过前端构建（`frontend/dist` 已是最新时） |
| `-SkipSign` | 只打包、不签名 |
| `-Certificate <pfx 路径 \| 证书指纹>` | 指定签名证书 |
| `-CertificatePassword <密码>` | pfx 密码 |
| `-SignTool <路径>`、`-MakeNsis <路径>` | 指定工具路径 |
| `-TimestampUrl ""` | 关闭时间戳（离线构建） |

不签名的快速打包：

```bash
wails build -nsis -installscope user
```

产物：`build/bin/CaDt-DataLens-amd64-installer.exe`（安装包）和 `build/bin/CaDt-DataLens.exe`（程序本体）。

为什么用 `-installscope user`：

- 安装到 `%LOCALAPPDATA%\Programs\CaDt-DataLens`，不需要管理员权限。
- 程序默认的 `plugins\` 目录在 exe 旁，装在用户目录下才可直接写插件；装到 `Program Files` 会需要提权。
- 文件关联、右键菜单、PATH、Agent Skill 都写 HKCU，与程序内设置逻辑一致。

若确实要全机安装，可改用 `-installscope machine`（需管理员，插件目录建议在设置里切到应用数据目录）。

## 5. 安装包行为

### 组件

| 组件 | 默认 | 内容 |
| --- | --- | --- |
| CaDt-DataLens（必需） | 必装 | 程序文件、开始菜单快捷方式、卸载项、WebView2 运行时检测 |
| 文件关联 | 勾选 | `datalens.exe --integrate=assoc`，写 HKCU，加入“打开方式”，不改默认程序 |
| 资源管理器右键菜单 | 勾选 | `datalens.exe --integrate=menu`，文件/文件夹/文件夹空白处 |
| 注册全局 Agent Skill | 不勾选 | `datalens.exe --integrate=skill`，写 `~/.agents/skills`、`~/.claude/skills` |
| 加入用户 PATH | 不勾选 | `datalens.exe --integrate=path`，之后可在任意目录执行 `datalens` |
| 创建桌面快捷方式 | 不勾选 | 创建 `CaDt-DataLens.lnk` |

注册表集成不在 NSIS 里重复实现，安装/卸载调用程序自身的 `--integrate=...` / `--unintegrate=all`，与“设置 → 系统集成”共用同一套代码。安装包只写 HKCU，卸载时撤销；程序移动位置后重新勾选即可更新路径。

### WebView2

`build/windows/installer/tmp/MicrosoftEdgeWebview2Setup.exe` 由 Wails 在构建时下载并内嵌（`-webview2 download`，默认）。安装时若检测不到 WebView2 运行时则静默安装；该文件被 `.gitignore` 忽略，`project.nsi` 用 `!if /FileExists` 做了缺失兜底。

### 升级覆盖

- 安装时把安装目录写入卸载注册表项 `InstallLocation`（user 范围在 HKCU，machine 范围在 HKLM）。
- 新版本安装时自动读取该值，沿用上次安装目录（包括用户手动指定的路径）；读不到才用默认路径。
- 程序或安装包在程序运行时会被文件占用，因此安装前会检查：交互式提示先关闭，静默安装直接以退出码 **66** 失败。
- 程序文件直接覆盖；当前安装包只包含 `datalens.exe` 和 `uninstall.exe`，不存在旧版本残留文件问题。
- `%APPDATA%\CandySweet\CaDt-DataLens` 下的配置、WebView2 用户数据始终保留。

### 卸载

- 先调用 `datalens.exe --unintegrate=all` 撤销文件关联、右键菜单、PATH、Agent Skill。
- 删除开始菜单/桌面快捷方式和卸载注册表项。
- 安装目录下的 `plugins\` 属于用户数据：交互式卸载询问是否一并删除，静默卸载默认保留。
- `%APPDATA%\CandySweet\CaDt-DataLens` 不删除。

### 静默安装/卸载

```bat
CaDt-DataLens-amd64-installer.exe /S
CaDt-DataLens-amd64-installer.exe /S /D=C:\path\to\install
uninstall.exe /S
```

`/D=` 必须是最后一个参数且不能加引号；静默安装只安装默认勾选的组件。

## 6. 代码签名

### 证书来源

脚本按以下顺序选择证书：

1. `-Certificate <pfx 路径>` + `-CertificatePassword`（正式证书推荐）。
2. `-Certificate <证书指纹>`（证书已安装到当前用户证书库）。
3. 环境变量 `CADT_SIGN_THUMBPRINT`。
4. 当前用户证书库中 FriendlyName 为 `CaDt-DataLens Self-Signed (Dev)` 的开发自签名证书。

### 开发自签名证书

只在本机测试签名流程时使用：

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=CandySweet, O=CandySweet, C=CN" `
  -FriendlyName "CaDt-DataLens Self-Signed (Dev)" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(3) -KeyExportPolicy Exportable -HashAlgorithm SHA256

Export-Certificate -Cert $cert -FilePath "$env:LOCALAPPDATA\cadt-tools\signing\cadt-datalens-dev.cer"

# 加入当前用户“受信任根”，让 signtool verify /pa 通过。
# 注意：Import-Certificate 会弹安全确认框，用证书存储 API 可静默写入。
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$store.Add($cert)
$store.Close()
```

删除开发证书（含信任根）：

```powershell
$thumb = (Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.FriendlyName -eq 'CaDt-DataLens Self-Signed (Dev)' }).Thumbprint
Remove-Item "Cert:\CurrentUser\My\$thumb" -Force
Remove-Item "Cert:\CurrentUser\Root\$thumb" -Force
```

### 正式证书

- 拿到 CA 签发的 `.pfx` 后：`scripts/build-installer.ps1 -Certificate D:\path\code-signing.pfx -CertificatePassword <密码>`
- 或把证书导入当前用户证书库，用指纹签名。
- 时间戳默认 `http://timestamp.digicert.com`（RFC3161）；离线构建传 `-TimestampUrl ""`。

### 验签

```powershell
signtool verify /pa /v build/bin/CaDt-DataLens.exe
signtool verify /pa /v build/bin/CaDt-DataLens-amd64-installer.exe
```

卸载程序 `uninstall.exe` 在安装时生成，签名在编译期由 NSIS `!uninstfinalize` 完成，安装后可在安装目录单独验签。

### 关于 SmartScreen

- 自签名只在本机信任根下通过校验，分发给其他人仍显示“未知发布者”，不要用于正式发布。
- OV 证书需要积累下载/安装信誉后 SmartScreen 才会放行；EV 证书可立即获得信任。
- 未签名/自签名安装包在 Windows 上会弹“Windows 已保护你的电脑”，属正常现象。

## 7. 发布前检查清单

- [ ] `app.go` 的 `appVersion` 与 `wails.json` 的 `info.productVersion` 一致。
- [ ] `go test ./...` 通过。
- [ ] `wails build` 产出的便携版能正常启动。
- [ ] `scripts/build-installer.ps1` 成功，并打印 `Successfully verified`。
- [ ] 静默安装 → 检查开始菜单快捷方式、卸载项、关联/右键菜单指向安装目录 → 静默卸载 → 检查清理。
- [ ] 覆盖安装（不带 `/D`）仍装回上次目录。
- [ ] 在 Windows 10 和 Windows 11 各验证一次（WebView2、SmartScreen 表现不同）。
- [ ] 发布说明标注版本号、签名方式和变更内容。

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 只有 exe，没有安装包 | `makensis` 不在 PATH，`wails build -nsis` 只打印警告；用脚本指定 `-MakeNsis` |
| PowerShell 脚本报中文语法错 | 脚本必须保存为 UTF-8 **带 BOM**（Windows PowerShell 5.1 按 ANSI 解析无 BOM 文件） |
| 安装向导中文乱码 | `project.nsi` 必须是 UTF-8 带 BOM |
| 静默安装退出码 66 | 程序正在运行，先关闭 `datalens.exe` 再装 |
| `signtool` 时间戳失败 | 网络不通；用 `-TimestampUrl ""` 离线构建，或换可达的时间戳服务器 |
| 自定义 `project.nsi` 被覆盖 | `wails_tools.nsh` 每次构建都会重新生成，自定义只能写在 `project.nsi` |
| 安装后右键菜单不显示 | 需要重启资源管理器或重新登录；Windows 11 在“显示更多选项”里 |
| 卸载后插件还在 | 设计如此：`plugins\` 是用户数据，静默卸载一律保留 |

## 9. 仓库内相关文件

| 文件 | 作用 |
| --- | --- |
| `scripts/build-installer.ps1` | 一键构建 + 签名 + 验签 |
| `build/windows/installer/project.nsi` | 安装包模板（组件、升级、卸载、签名钩子） |
| `build/windows/installer/wails_tools.nsh` | Wails 自动生成，勿手改 |
| `build/windows/info.json` | exe 文件属性（版本、公司、版权） |
| `wails.json` | 构建配置与安装包版本 |
| `installer_cli_windows.go` | `--integrate` / `--unintegrate` 集成命令 |
