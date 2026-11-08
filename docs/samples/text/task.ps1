param(
    [string[]]$Path = @()
)

$exe = Join-Path $PSScriptRoot 'build\bin\CaDt-DataLens.exe'
if (-not (Test-Path $exe)) {
    throw "Missing $exe"
}

Write-Host 'Starting CaDt-DataLens'
Start-Process -FilePath $exe -ArgumentList $Path
