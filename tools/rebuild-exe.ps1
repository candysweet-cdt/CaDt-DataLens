param(
    # 构建带调试面板的变体（go build -tags production,devtools）
    [switch]$Devtools,
    # 构建内含 v3 MCP server 的变体（-tags mcp）：外部 agent 经 Streamable HTTP 驱动应用，
    # 令牌/端口见 <应用数据目录>\mcp-server.json。标准构建完全不含该端点（见 app-mcp-server.md）
    [switch]$IncludeMCP,
    # 跳过测试门直接构建（测试门失败后选「2 强行构建」走同一条路）
    [switch]$SkipTest,
    # 不停运行中的实例：改用「改名让路」替换（运行中的旧 exe 改名为 datalens.running-old-*.exe）
    [switch]$KeepRunning
)

# rebuild-exe.ps1：一键构建 exe 并替换到仓库根目录的便携副本 datalens.exe（tools\rebuild-exe.cmd 双击入口）。
# 流程：先跑测试门（Go + 前端）→ 通过直接构建；未通过则显示失败摘要，可选
# 「1 复制失败信息到剪贴板（粘贴给 AI 修复）」「2 跳过测试强行构建」「其他退出」。
# 运行中的 exe 无法覆盖——默认先发 --quit 优雅退出（等 10 秒：各窗口结算 AI 回合并落盘），
# 没退的再尝试优雅关闭（等 6 秒，「AI 正在生成」二次确认弹窗在途时会超时转强制结束）；
# 带 -KeepRunning 时改走改名让路（Windows 允许改名运行中的 exe），
# 遗留的 datalens.running-old-*.exe 下次运行清理（名字匹配 .gitignore 的 *.running-old*.exe）。

$ErrorActionPreference = "Stop"
# 子进程输出按 UTF-8 解码：node（npm test）输出是 UTF-8，GBK 控制台会把中文/✔ 测试名
# 解成乱码并污染剪贴板（复制给 AI 的失败信息必须可读）。仅影响解码，不改控制台代码页。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $PSScriptRoot
$binExe = Join-Path $root "build\bin\CaDt-DataLens.exe"
$target = Join-Path $root "datalens.exe"
$testLog = Join-Path $env:TEMP "cadt-rebuild-tests.log"

# 结束前的「按任意键退出」：双击场景由控制台 ReadKey 接住；无控制台 stdin（管道/CI）时
# ReadKey 抛错，回退 ReadLine（EOF 立即返回，不卡）。
function Wait-AnyKey {
    Write-Host ""
    Write-Host "按任意键退出…" -ForegroundColor DarkGray
    try {
        [void][System.Console]::ReadKey($true)
    } catch {
        $null = [System.Console]::In.ReadLine()
    }
}

function Notify-ShellFile([string]$Path, [int]$EventId) {
    try {
        Add-Type -Namespace CaDtShell32 -Name Native -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, string dwItem2);
'@
        # SHCNF_PATH：只刷新指定文件，不重启资源管理器。
        [CaDtShell32.Native]::SHChangeNotify($EventId, 0x00000005, $Path, $null)
    } catch {
        Write-Host "Shell 图标缓存通知失败（不影响 exe）：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

function Clear-ShellIcon([string]$Path) {
    Notify-ShellFile $Path 0x00000000 # SHCNE_DELETE
}

function Update-ShellIcon([string]$Path) {
    Notify-ShellFile $Path 0x00002000 # SHCNE_UPDATEITEM
    Notify-ShellFile $Path 0x00000002 # SHCNE_CREATE
}

# ---------- 运行中的实例处理（构建替换前） ----------
function Stop-RunningInstances {
    # 只停这两个已知路径的实例（按进程路径过滤，不动用户可能装在别处的副本）
    $known = @($binExe, $target)
    $running = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
    if (-not $running) { return }
    Write-Host "发现运行中的实例，尝试优雅关闭…" -ForegroundColor Cyan
    # 先走 --quit 优雅退出（经单实例转发给主实例）：各窗口结算 AI 回合（工具卡标中断、
    # 写队列落盘、释放租约）后退出，跑着的对话不再被强杀「莫名陪葬」。旧版 exe 不识别
    # 该开关时会当成普通启动转发（最多前置一下窗口），等不到退出就落到下面的常规关闭。
    $quitLauncher = $target
    if (-not (Test-Path $quitLauncher)) { $quitLauncher = $binExe }
    if (Test-Path $quitLauncher) {
        try { Start-Process -FilePath $quitLauncher -ArgumentList "--quit" -WindowStyle Hidden | Out-Null } catch { }
        $gracefulDeadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $gracefulDeadline) {
            Start-Sleep -Milliseconds 400
            $alive = Get-Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
            if (-not $alive) {
                Write-Host "已优雅退出（回合已结算落盘）。" -ForegroundColor DarkGray
                return
            }
        }
        Write-Host "优雅退出超时（可能有窗口未响应），转常规关闭…" -ForegroundColor Yellow
    }
    foreach ($proc in $running) { $null = $proc.CloseMainWindow() }
    # 应用有「AI 正在生成」关窗二次确认：等 6 秒，没退的转强制结束
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $deadline) {
        $alive = $running | Where-Object { -not $_.HasExited }
        if (-not $alive) { break }
        Start-Sleep -Milliseconds 300
        $running = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
        if (-not $running) { break }
    }
    $alive = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
    foreach ($proc in $alive) {
        Write-Host "强制结束：$($proc.Path)（可能有未关闭的确认弹窗或仍在流式）" -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    Write-Host "已关闭运行中的实例。" -ForegroundColor DarkGray
}

# ---------- 构建并替换根目录副本 ----------
function Build-AndReplace {
    Get-ChildItem -Path $root -Filter "*.running-old*.exe" -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { }
        }
    if (-not $KeepRunning) { Stop-RunningInstances }

    Push-Location $root
    try {
        # v3 构建：前端 vite → syso（图标/清单/版本资源）→ go build（production 标签）
        $npm = Get-Command npm -ErrorAction SilentlyContinue
        if (-not $npm) { throw "找不到 npm：请先安装 Node.js 20.19+ 并加入 PATH" }
        if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
            Write-Host "安装前端依赖（首次构建）…" -ForegroundColor Cyan
            Push-Location (Join-Path $root "frontend")
            try {
                & npm install
                if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
            } finally { Pop-Location }
        }
        Write-Host "npm run build（frontend）" -ForegroundColor Cyan
        Push-Location (Join-Path $root "frontend")
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "前端构建失败（退出码 $LASTEXITCODE）" }
        } finally { Pop-Location }

        if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
            throw "找不到 wails3 CLI：需要 Wails v3.1.0+（go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0）"
        }
        $tags = "production"
        if ($Devtools) { $tags = "production,devtools" }
        if ($IncludeMCP) { $tags = $tags + ",mcp" }
        $syso = Join-Path $root "rsrc_windows_amd64.syso"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $binExe) | Out-Null
        Write-Host "wails3 generate syso（图标/清单/版本资源）" -ForegroundColor Cyan
        & wails3 generate syso -arch amd64 `
            -icon (Join-Path $root "build\windows\icon.ico") `
            -info (Join-Path $root "build\windows\info.json") `
            -manifest (Join-Path $root "build\windows\wails.exe.manifest") `
            -out $syso
        if ($LASTEXITCODE -ne 0) { throw "wails3 generate syso 失败（退出码 $LASTEXITCODE）" }
        if (-not (Test-Path -LiteralPath $syso) -or (Get-Item -LiteralPath $syso).Length -lt 1024) {
            throw "wails3 generate syso 未生成有效资源文件：$syso"
        }
        try {
            Write-Host ("go build -tags " + $tags + " → " + $binExe) -ForegroundColor Cyan
            & go build -tags $tags -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui" -o $binExe .
            if ($LASTEXITCODE -ne 0) {
                throw "go build 失败（退出码 $LASTEXITCODE），未替换根目录 exe。"
            }
        } finally {
            Remove-Item $syso -Force -ErrorAction SilentlyContinue
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $binExe)) { throw "构建产物不存在：$binExe" }

    # Windows 按“路径 + 文件名”缓存 exe 图标；同名覆盖会保留旧白页。先移走旧文件，
    # 让新 datalens.exe 以全新文件身份创建，运行中的 exe 也允许改名。
    $aside = $null
    if (Test-Path -LiteralPath $target) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $aside = Join-Path $root ("datalens.running-old-" + $stamp + ".exe")
        Rename-Item -LiteralPath $target -Destination $aside -Force
        Clear-ShellIcon $target
        Write-Host "原 exe 已改名为 $(Split-Path -Leaf $aside)（下次运行本工具时清理）" -ForegroundColor DarkGray
    }
    try {
        Copy-Item $binExe $target -Force
    } catch {
        if ($aside) { Rename-Item -LiteralPath $aside -Destination $target -Force }
        throw
    }
    Update-ShellIcon $target

    # exe 未必内嵌版本资源：空则回退读 wails.json 的 productVersion（版本号三处一致之一）
    $version = (Get-Item $target).VersionInfo.ProductVersion
    if (-not $version) {
        try {
            $wailsJson = Get-Content (Join-Path $root "wails.json") -Raw | ConvertFrom-Json
            $version = [string]$wailsJson.info.productVersion
        } catch { }
    }
    $sizeMB = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Host ""
    Write-Host "完成：$target" -ForegroundColor Green
    Write-Host ("版本 " + $version + " · " + $sizeMB + " MB · 构建于 " + (Get-Date -Format "HH:mm:ss"))
}

# ---------- 主流程 ----------
try {
    if (-not $SkipTest) {
        Remove-Item $testLog -ErrorAction SilentlyContinue
        Write-Host "[1/2] 测试门（输出同时写入 $testLog）" -ForegroundColor Cyan

        # 开头选择：是否进行 Go 测试（go test 全仓约 20 秒；2 = 跳过，只跑前端测试门）
        # Console.In 而非 Read-Host：重定向 stdin（管道/CI）下行为一致
        Write-Host "是否进行 Go 测试？输入 1 进行（约 20 秒）/ 输入 2 跳过（只跑前端测试）" -ForegroundColor Yellow
        $goChoice = [System.Console]::In.ReadLine()
        if ([string]::IsNullOrEmpty($goChoice)) { $goChoice = "" }
        $goChoice = $goChoice.Trim()

        # native 命令的 stderr 经 2>&1 进管道时不允许被 ErrorActionPreference=Stop 打断
        #（pwsh 7.3+ 的 $PSNativeCommandUseErrorActionPreference；5.1 下该赋值无副作用）
        $PSNativeCommandUseErrorActionPreference = $false
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"

        # 绑定面一致性：d.ts 由 testdata/app_bindings_baseline.txt 生成，后端改了绑定面却没
        # 重跑生成器时这里当场红（typecheck 只验 d.ts 自洽，验不出它与基线脱节）。当前位于 Go
        # 测试之前、前端测试之前，失败计入 feFail 走同一套失败摘要与「跳过强行构建」流程。
        Write-Host ""
        Write-Host "—— 绑定类型一致性（gen-backend-types --check）——" -ForegroundColor DarkGray
        Push-Location $root
        try {
            & node scripts/gen-backend-types.mjs --check 2>&1 | Tee-Object -FilePath $testLog -Append
            $typesFail = $LASTEXITCODE -ne 0
        } finally {
            Pop-Location
        }

        $goFail = $false
        if ($goChoice -eq "2") {
            Write-Host "已跳过 Go 测试。" -ForegroundColor DarkGray
        } else {
            Push-Location $root
            try {
                Write-Host ""
                Write-Host "—— Go 测试（编译阶段无输出属正常；挂死测试 4 分钟自动终止）——" -ForegroundColor DarkGray
                # -timeout 4m：卡死的测试由 go 强杀并输出 goroutine 堆栈，而不是无限等待
                & go test ./... -timeout 4m 2>&1 | Tee-Object -FilePath $testLog -Append
                $goFail = $LASTEXITCODE -ne 0
            } finally {
                Pop-Location
            }
        }
        Push-Location (Join-Path $root "frontend")
        try {
            Write-Host ""
            Write-Host "—— 前端测试（npm test）——" -ForegroundColor DarkGray
            & npm test 2>&1 | Tee-Object -FilePath $testLog -Append
            $feFail = $LASTEXITCODE -ne 0
        } finally {
            Pop-Location
        }
        $ErrorActionPreference = $prevEAP

        if ($goFail -or $feFail -or $typesFail) {
            Write-Host ""
            $bad = @()
            if ($goFail) { $bad += "Go" }
            if ($typesFail) { $bad += "绑定类型" }
            if ($feFail) { $bad += "前端" }
            Write-Host ("[X] 测试未通过（" + ($bad -join " / ") + "）。失败摘要（最后 60 行）：") -ForegroundColor Red
            Get-Content $testLog -Tail 60 | ForEach-Object { Write-Host $_ }
            Write-Host ""
            Write-Host "完整测试输出：$testLog" -ForegroundColor DarkGray
            # Console.In 而非 Read-Host：重定向 stdin（管道/CI）下行为一致
            Write-Host "输入 1 复制完整失败信息到剪贴板 / 输入 2 跳过测试强行构建 / 其他直接退出" -ForegroundColor Yellow
            $choice = [System.Console]::In.ReadLine()
            if ([string]::IsNullOrEmpty($choice)) { $choice = "" }
            $choice = $choice.Trim()
            if ($choice -eq "1") {
                Set-Clipboard -Value (Get-Content $testLog -Raw)
                Write-Host "已复制完整测试输出到剪贴板，可直接粘贴给 AI 修复。" -ForegroundColor Green
                return
            }
            if ($choice -eq "2") {
                Write-Host "跳过测试门，强行构建…" -ForegroundColor Yellow
            } else {
                return
            }
        } else {
            Write-Host ""
            Write-Host "[✓] 测试门通过，开始构建…" -ForegroundColor Green
        }
    }

    Build-AndReplace
} catch {
    Write-Host ""
    Write-Host "[X] 出错：$($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Message -notmatch "go build 失败") {
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    }
} finally {
    Wait-AnyKey
}
