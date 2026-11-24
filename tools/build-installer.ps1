param(
    # 构建内含 v3 MCP server 的变体（-tags mcp），见 docs/finished-plans/app-mcp-server.md
    [switch]$IncludeMCP,
    # 代码签名证书：.pfx 文件路径，或证书指纹；不传则自动找本机开发证书
    [string]$Certificate = "",
    [string]$CertificatePassword = "",
    # 显式指定工具路径；不传则按下面的查找表自动找
    [string]$SignTool = "",
    [string]$MakeNsis = "",
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    # 不签名：产物未签名，别的机器会被 SmartScreen 拦截，仅本机试装用
    [switch]$SkipSign,
    # 复用现有 frontend\dist，跳过 vite 构建（只改了 Go 侧时更快）
    [switch]$SkipFrontend,
    # 不改动正在运行的程序；遇到占用直接报错退出
    [switch]$KeepRunning
)

# build-installer.ps1：一键构建 Windows 安装包（双击入口 tools\build-installer.cmd）。
#
# 流程（每一步都会在控制台打印进度）：
#   [1/6] 前端 vite 构建（-SkipFrontend 跳过）
#   [2/6] go build -tags production,devtools → build\bin\CaDt-DataLens.exe
#   [3/6] 签名程序本体
#   [4/6] 生成 WebView2 引导器 → build\windows\installer\tmp（裸 Win10 也能自动装运行时）
#   [5/6] makensis 打安装包（安装包与卸载程序一并签名）
#   [6/6] signtool verify 校验两个产物
#
# 产出：build\bin\CaDt-DataLens-amd64-installer.exe（当前用户安装，不需要管理员提权）
# 依赖：Node 20.19+、Go、wails3 3.1.0+、NSIS 3、signtool；加 -SkipSign 可免签名环节
# 注意：本工具**不跑测试门**（打的是正式包，耗时长）；要连测试一起跑请用 tools\rebuild-exe.cmd
#
# 常用用法：
#   tools\build-installer.cmd                    默认：构建 + 本机开发证书自签 + 打包
#   tools\build-installer.cmd -SkipSign          跳过签名（本机试装）
#   tools\build-installer.ps1 -SkipFrontend      复用已有 dist，只重建 Go 侧
#   tools\build-installer.ps1 -IncludeMCP        额外编译 MCP server 变体
#   tools\build-installer.ps1 -Certificate D:\code-signing.pfx -CertificatePassword ***
#                                                换正式证书签名

$ErrorActionPreference = "Stop"
# 子进程输出按 UTF-8 解码：node（npm run build）与 wails3 的输出是 UTF-8，GBK 控制台会把中文
# 解成乱码。仅影响解码，不改控制台代码页（与 tools\rebuild-exe.ps1 保持一致）。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root "build\windows\installer"
$binDir = Join-Path $root "build\bin"
$appExe = Join-Path $binDir "CaDt-DataLens.exe"
$installerExe = Join-Path $binDir "CaDt-DataLens-amd64-installer.exe"

# 结束前的「按任意键退出」：双击场景由控制台 ReadKey 接住；无控制台 stdin（管道/CI）时
# ReadKey 抛错，回退 ReadLine（EOF 立即返回，不卡）。
function Wait-AnyKey {
    Write-Host ""
    Write-Host "按任意键退出…" -ForegroundColor DarkGray
    try { [void][System.Console]::ReadKey($true) } catch { $null = [System.Console]::In.ReadLine() }
}

# 找工具：显式路径 > 环境变量 > PATH > 已知安装位置的通配匹配
function Resolve-Tool([string]$explicit, [string]$envName, [string[]]$patterns) {
    if ($explicit) {
        if (-not (Test-Path $explicit)) { throw "找不到工具：$explicit" }
        return (Resolve-Path $explicit).Path
    }
    if ($envName -and [Environment]::GetEnvironmentVariable($envName)) {
        return [Environment]::GetEnvironmentVariable($envName)
    }
    $cmd = Get-Command $envName -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($pattern in $patterns) {
        $hit = Get-ChildItem $pattern -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return ""
}

# 签名要写 build\bin\CaDt-DataLens.exe，运行中的实例会锁住文件，必须先退出。
# 只处理这两个已知路径的实例，不动用户装到别处的副本。
function Stop-RunningApp {
    $known = @($appExe, (Join-Path $root "datalens.exe"))
    $query = {
        @(Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path })
    }
    $running = & $query
    if (-not $running) { return }
    if ($KeepRunning) {
        throw "程序正在运行（$($running[0].Path)），签名无法写入 exe。请先退出程序，或去掉 -KeepRunning。"
    }
    Write-Host "关闭运行中的程序（签名需要写 exe）…" -ForegroundColor Yellow
    foreach ($proc in $running) { $null = $proc.CloseMainWindow() }
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if (-not (& $query)) { break }
    }
    foreach ($proc in (& $query)) {
        Write-Host "强制结束：$($proc.Path)（可能有未关闭的确认弹窗）" -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 400
    Write-Host "已关闭运行中的实例。" -ForegroundColor DarkGray
}

# 构建程序本体：package main 在仓库根，syso 也是根目录临时产物
function Build-App {
    Push-Location $root
    try {
        if (-not $SkipFrontend) {
            if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
                throw "找不到 npm：请先安装 Node.js 20.19+ 并加入 PATH"
            }
            if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
                Write-Host "[1/6] 安装前端依赖（首次构建）" -ForegroundColor Cyan
                Push-Location (Join-Path $root "frontend")
                try {
                    & npm install
                    if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
                } finally { Pop-Location }
            }
            Write-Host "[1/6] 前端构建（npm run build）" -ForegroundColor Cyan
            Push-Location (Join-Path $root "frontend")
            try {
                & npm run build
                if ($LASTEXITCODE -ne 0) { throw "前端构建失败（退出码 $LASTEXITCODE）" }
            } finally { Pop-Location }
        } else {
            Write-Host "[1/6] 跳过前端构建（-SkipFrontend），复用现有 dist" -ForegroundColor DarkGray
        }

        if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
            throw "找不到 wails3 CLI：需要 Wails v3.1.0+（go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0）"
        }
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
        $syso = Join-Path $root "rsrc_windows_amd64.syso"
        Write-Host "[2/6] wails3 generate syso（图标/清单/版本资源）" -ForegroundColor Cyan
        & wails3 generate syso -arch amd64 `
            -icon (Join-Path $root "build\windows\icon.ico") `
            -info (Join-Path $root "build\windows\info.json") `
            -manifest (Join-Path $root "build\windows\wails.exe.manifest") `
            -out $syso
        if ($LASTEXITCODE -ne 0) { throw "wails3 generate syso 失败（退出码 $LASTEXITCODE）" }
        try {
            $tags = "production,devtools"
            if ($IncludeMCP) { $tags = $tags + ",mcp" }
            Write-Host ("go build -tags " + $tags + " → " + $appExe) -ForegroundColor Cyan
            & go build -tags $tags -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui" -o $appExe .
            if ($LASTEXITCODE -ne 0) { throw "go build 失败（退出码 $LASTEXITCODE）" }
        } finally {
            Remove-Item $syso -Force -ErrorAction SilentlyContinue
        }
    } finally {
        Pop-Location
    }
}

# ---------- 主流程 ----------
try {
    Write-Host "构建 Windows 安装包：$(Split-Path -Leaf $installerExe)" -ForegroundColor Cyan
    Write-Host ""

    Stop-RunningApp
    Build-App

    # ---- 签名材料：不传证书就找本机开发证书（证书管理见 docs/packaging.md）----
    $signToolPath = ""
    $certArgs = @()
    $signLabel = "未签名"
    if (-not $SkipSign) {
        $signToolPath = Resolve-Tool $SignTool "signtool" @(
            "$env:LOCALAPPDATA\cadt-tools\sdk-buildtools\bin\*\x64\signtool.exe",
            "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
            "C:\Program Files (x86)\Windows Kits\10\bin\*\x86\signtool.exe"
        )
        if (-not $signToolPath) {
            throw "找不到 signtool：用 -SignTool 指定，或安装 Windows SDK；不想签名就加 -SkipSign"
        }

        if ($Certificate -and (Test-Path $Certificate)) {
            $certArgs = @("/f", (Resolve-Path $Certificate).Path)
            if ($CertificatePassword) { $certArgs += @("/p", $CertificatePassword) }
            $signLabel = "证书文件 " + (Split-Path -Leaf $Certificate)
        } else {
            $thumbprint = $Certificate
            if (-not $thumbprint) { $thumbprint = $env:CADT_SIGN_THUMBPRINT }
            if (-not $thumbprint) {
                $dev = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
                    Where-Object { $_.FriendlyName -eq "CaDt-DataLens Self-Signed (Dev)" } | Select-Object -First 1
                if ($dev) { $thumbprint = $dev.Thumbprint }
            }
            if (-not $thumbprint) {
                throw "没有可用签名证书：用 -Certificate <pfx或指纹> 指定，或先生成开发证书（见 docs/packaging.md），或加 -SkipSign"
            }
            $certArgs = @("/sha1", $thumbprint)
            $signLabel = "本机证书 " + $thumbprint.Substring(0, 8) + "…"
        }

        Write-Host "[3/6] 签名程序本体（$signLabel）" -ForegroundColor Cyan
        & $signToolPath sign /fd sha256 /tr $TimestampUrl /td sha256 @certArgs $appExe
        if ($LASTEXITCODE -ne 0) { throw "签名程序失败（退出码 $LASTEXITCODE）" }
    } else {
        Write-Host "[3/6] 跳过签名（-SkipSign）" -ForegroundColor DarkGray
    }

    $signArgs = ""
    if (-not $SkipSign) {
        $signArgs = (@("sign", "/fd", "sha256") + ($(if ($TimestampUrl) { @("/tr", $TimestampUrl, "/td", "sha256") } else { @() })) + $certArgs) -join " "
    }

    Write-Host "[4/6] 生成 WebView2 引导器（裸 Win10 自动安装运行时）" -ForegroundColor Cyan
    if (Get-Command wails3 -ErrorAction SilentlyContinue) {
        # 路径必须是 ...\installer\tmp：project.nsi 的 `!if /FileExists "tmp\MicrosoftEdgeWebview2Setup.exe"`
        # 只认这个相对位置；写错目录会让安装包静默失去 WebView2 自动安装能力。
        & wails3 generate webview2bootstrapper -dir (Join-Path $installerDir "tmp")
        if ($LASTEXITCODE -ne 0) {
            Write-Host "引导器生成失败：安装包将不含 WebView2 自动安装（目标机器需自带运行时）" -ForegroundColor Yellow
        }
    } else {
        Write-Host "找不到 wails3：跳过 WebView2 引导器生成" -ForegroundColor Yellow
    }

    if (-not $MakeNsis) {
        $MakeNsis = Resolve-Tool "" "makensis" @(
            "$env:LOCALAPPDATA\cadt-tools\**\makensis.exe",
            "$env:LOCALAPPDATA\Temp\nsis-portable\**\Bin\makensis.exe",
            "C:\Program Files (x86)\NSIS\makensis.exe",
            "C:\Program Files\NSIS\makensis.exe"
        )
    }
    if (-not $MakeNsis) {
        throw "找不到 makensis：请安装 NSIS 3（https://nsis.sourceforge.io），或用 -MakeNsis 指定路径"
    }
    # makensis 需要同目录的插件与头文件，临时前置 PATH
    $env:PATH = (Split-Path -Parent $MakeNsis) + ";" + $env:PATH

    Write-Host "[5/6] makensis 打安装包" -ForegroundColor Cyan
    Push-Location $installerDir
    try {
        $nsisArgs = @(
            "-DARG_WAILS_AMD64_BINARY=$appExe",
            "-DWAILS_INSTALL_SCOPE=user",
            "-DREQUEST_EXECUTION_LEVEL=user"
        )
        if (-not $SkipSign) {
            $nsisArgs += "-DSIGNTOOL=$signToolPath"
            $nsisArgs += "-DSIGN_ARGS=$signArgs"
        }
        $nsisArgs += "project.nsi"
        & $MakeNsis @nsisArgs
        if ($LASTEXITCODE -ne 0) { throw "makensis 失败（退出码 $LASTEXITCODE）" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $installerExe)) { throw "安装包未生成：$installerExe" }

    # ---- 收尾：校验签名 + 打印产物清单 ----
    $sigStatus = "-"
    if (-not $SkipSign) {
        Write-Host "[6/6] 校验签名" -ForegroundColor Cyan
        & $signToolPath verify /pa /v $appExe | Select-String "Successfully verified|Issued to|Number of"
        & $signToolPath verify /pa /v $installerExe | Select-String "Successfully verified|Issued to|Number of"
        if ($LASTEXITCODE -ne 0) { throw "签名校验未通过（退出码 $LASTEXITCODE）" }
        $sigStatus = (Get-AuthenticodeSignature $installerExe).Status
    } else {
        Write-Host "[6/6] 跳过验签（-SkipSign）" -ForegroundColor DarkGray
    }

    $version = (Get-Item $appExe).VersionInfo.ProductVersion
    if (-not $version) {
        # exe 未内嵌版本资源时的回退：v3 info.json 的 fixed.product_version，再退到 wails.json。
        # （v3 schema 没有顶层 productVersion，旧写法读 $info.productVersion 永远为空。）
        # 读不到就留空，下面打印 "-"，不影响安装包本身。
        try {
            $info = Get-Content (Join-Path $root "build\windows\info.json") -Raw | ConvertFrom-Json
            $version = [string]$info.fixed.product_version
        } catch { }
        if (-not $version) {
            try {
                $wailsJson = Get-Content (Join-Path $root "wails.json") -Raw | ConvertFrom-Json
                $version = [string]$wailsJson.info.productVersion
            } catch { }
        }
    }
    $sizeMB = [math]::Round((Get-Item $installerExe).Length / 1MB, 2)
    Write-Host ""
    Write-Host "完成：$installerExe" -ForegroundColor Green
    Write-Host ("版本 " + $version + " · " + $sizeMB + " MB · 签名 " + $sigStatus + " · 构建于 " + (Get-Date -Format "HH:mm:ss"))
    Write-Host "当前用户安装，不需要管理员权限；自签证书在别的机器上会被 SmartScreen 提示未知发布者。" -ForegroundColor DarkGray
    if ($SkipSign) { Write-Host "本次未签名（-SkipSign）" -ForegroundColor Yellow }
} catch {
    Write-Host ""
    Write-Host "[X] 出错：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
} finally {
    Wait-AnyKey
}
