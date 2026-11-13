# 还原 docs/samples/patch/demo 到初始状态。
#
# 用法（在任意目录执行均可）：
#   powershell -ExecutionPolicy Bypass -File .\reset-samples.ps1
#
# 做三件事：
#   1. 用 pristine/ 覆盖 demo/（还原被补丁改过的内容）
#   2. 删除示例新建的 src/banner.js
#   3. 删除应用留下的 .cadt/（补丁索引、备份、工作区锁）

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root 'pristine'
$dst  = Join-Path $root 'demo'

if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "找不到原始副本目录：$src" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $dst)) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
}

# 1) 覆盖回原始内容
$restored = @()
Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\', '/')
    $target = Join-Path $dst $rel
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    $restored += $rel
}

# 2) 删除示例新建的文件与应用留下的补丁目录
$removed = @()
foreach ($rel in @('src\banner.js')) {
    $p = Join-Path $dst $rel
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force
        $removed += $rel
    }
}
foreach ($rel in @('.cadt')) {
    $p = Join-Path $dst $rel
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Recurse -Force
        $removed += $rel + '\'
    }
}

Write-Host "已还原 $($restored.Count) 个文件：" -ForegroundColor Green
$restored | ForEach-Object { Write-Host "  + $_" }
if ($removed.Count -gt 0) {
    Write-Host "已清理 $($removed.Count) 项示例产物："
    $removed | ForEach-Object { Write-Host "  - $_" }
} else {
    Write-Host "没有需要清理的示例产物。"
}
Write-Host "demo 已回到初始状态，可以重新跑示例。"
