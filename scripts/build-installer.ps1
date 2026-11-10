param(
    [string]$Certificate = "",
    [string]$CertificatePassword = "",
    [string]$SignTool = "",
    [string]$MakeNsis = "",
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [switch]$SkipSign,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root "build\windows\installer"
$binDir = Join-Path $root "build\bin"
$appExe = Join-Path $binDir "CaDt-DataLens.exe"
$installerExe = Join-Path $binDir "CaDt-DataLens-amd64-installer.exe"

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

if (-not $MakeNsis) {
    $MakeNsis = Resolve-Tool "" "makensis" @(
        "$env:LOCALAPPDATA\cadt-tools\**\makensis.exe",
        "$env:LOCALAPPDATA\Temp\nsis-portable\**\Bin\makensis.exe",
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe"
    )
}
if (-not $MakeNsis) { throw "找不到 makensis：请安装 NSIS 3 或通过 -MakeNsis 指定路径" }

$signToolPath = ""
$certArgs = @()
if (-not $SkipSign) {
    $signToolPath = Resolve-Tool $SignTool "signtool" @(
        "$env:LOCALAPPDATA\cadt-tools\sdk-buildtools\bin\*\x64\signtool.exe",
        "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
        "C:\Program Files (x86)\Windows Kits\10\bin\*\x86\signtool.exe"
    )
    if (-not $signToolPath) { throw "找不到 signtool：可用 -SignTool 指定，或安装 Windows SDK" }

    if ($Certificate -and (Test-Path $Certificate)) {
        $certArgs = @("/f", (Resolve-Path $Certificate).Path)
        if ($CertificatePassword) { $certArgs += @("/p", $CertificatePassword) }
    } else {
        $thumbprint = $Certificate
        if (-not $thumbprint) { $thumbprint = $env:CADT_SIGN_THUMBPRINT }
        if (-not $thumbprint) {
            $dev = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
                Where-Object { $_.FriendlyName -eq "CaDt-DataLens Self-Signed (Dev)" } | Select-Object -First 1
            if ($dev) { $thumbprint = $dev.Thumbprint }
        }
        if (-not $thumbprint) { throw "没有可用签名证书：用 -Certificate <pfx或指纹> 指定，或先生成开发证书" }
        $certArgs = @("/sha1", $thumbprint)
    }
}

$wailsArgs = @("build", "-nsis", "-installscope", "user", "-devtools")
if ($SkipFrontend) { $wailsArgs += "-s" }

Write-Host "==> wails $($wailsArgs -join ' ')" -ForegroundColor Cyan
$env:PATH = (Split-Path -Parent $MakeNsis) + ";" + $env:PATH
Push-Location $root
try {
    & wails @wailsArgs
    if ($LASTEXITCODE -ne 0) { throw "wails build 失败（退出码 $LASTEXITCODE）" }
} finally {
    Pop-Location
}

if (-not $SkipSign) {
    $signBase = @("sign", "/fd", "sha256")
    if ($TimestampUrl) { $signBase += @("/tr", $TimestampUrl, "/td", "sha256") }

    Write-Host "==> 签名 $appExe" -ForegroundColor Cyan
    & $signToolPath @signBase @certArgs $appExe
    if ($LASTEXITCODE -ne 0) { throw "签名程序失败（退出码 $LASTEXITCODE）" }
}

$signArgs = ""
if (-not $SkipSign) {
    $signArgs = (@("sign", "/fd", "sha256") + ($(if ($TimestampUrl) { @("/tr", $TimestampUrl, "/td", "sha256") } else { @() })) + $certArgs) -join " "
}

Write-Host "==> makensis（安装包 + 卸载程序签名）" -ForegroundColor Cyan
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

if (-not $SkipSign) {
    Write-Host "==> 校验签名" -ForegroundColor Cyan
    & $signToolPath verify /pa /v $appExe | Select-String "Successfully verified|Issued to|Number of"
    & $signToolPath verify /pa /v $installerExe | Select-String "Successfully verified|Issued to|Number of"
}

Write-Host ""
Write-Host "完成：$installerExe" -ForegroundColor Green
if ($SkipSign) { Write-Host "（本次未签名：-SkipSign）" -ForegroundColor Yellow }
