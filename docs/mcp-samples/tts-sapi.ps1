# tts-sapi.ps1 - minimal MCP stdio server (line-delimited JSON-RPC 2.0).
# Tool: tts_sapi { text, voice? ("stella" | "tide"), outputPath? }
# Writes a WAV file with Windows SAPI (offline, no extra install) and returns its path.
# Configure in CaDt-DataLens: Settings -> AI -> External Tools -> MCP servers.
#   command: powershell   args: -NoProfile -ExecutionPolicy Bypass -File <path to this file>
# Use Windows PowerShell 5.1 (powershell.exe, shipped with Win10/11): `pwsh` is PowerShell 7,
# which is an extra install and is missing on clean machines. This script only needs
# System.Speech, so 5.1 runs it fine.
# Keep stdout protocol-only: never Write-Host / Write-Output from this script.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Speech

function Send-Json($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 12
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Send-Result($id, $result) {
    Send-Json ([ordered]@{jsonrpc = '2.0'; id = $id; result = $result})
}

function Send-Error($id, $code, $message) {
    Send-Json ([ordered]@{jsonrpc = '2.0'; id = $id; error = [ordered]@{code = $code; message = $message}})
}

$tool = [ordered]@{
    name        = 'tts_sapi'
    description = 'Synthesize text to a WAV file with Windows SAPI (offline). Returns the saved file path. voice: stella (female, default) or tide (male).'
    inputSchema = [ordered]@{
        type       = 'object'
        properties = [ordered]@{
            text       = [ordered]@{type = 'string'; description = 'Text to speak (required)'}
            voice      = [ordered]@{type = 'string'; enum = @('stella', 'tide'); description = 'Voice hint'}
            outputPath = [ordered]@{type = 'string'; description = 'Optional absolute WAV path; defaults to %TEMP%\cadt-tts'}
        }
        required   = @('text')
    }
    annotations = [ordered]@{readOnlyHint = $false; destructiveHint = $false; openWorldHint = $false}
}

function Invoke-Tts($toolArgs) {
    $text = [string]$toolArgs.text
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'text is required' }
    $voice = ([string]$toolArgs.voice).ToLowerInvariant()
    $path = [string]$toolArgs.outputPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        $dir = Join-Path $env:TEMP 'cadt-tts'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $suffix = [guid]::NewGuid().ToString('N').Substring(0, 6)
        $path = Join-Path $dir ('tts-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $suffix + '.wav')
    } else {
        $parent = Split-Path -Parent $path
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    }
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voiceName = ''
    try {
        if ($voice -eq 'tide') {
            try { $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male) } catch { }
        } elseif ($voice -eq 'stella') {
            try { $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) } catch { }
        }
        $synth.SetOutputToWaveFile($path)
        $synth.Speak($text)
        $voiceName = $synth.Voice.VoiceInfo.Name
        if ([string]::IsNullOrWhiteSpace($voiceName)) { $voiceName = $synth.Voice.Name }
    } finally {
        $synth.Dispose()
    }
    $info = Get-Item -LiteralPath $path
    $lines = @('Saved WAV: ' + $info.FullName, 'Bytes: ' + $info.Length)
    if (-not [string]::IsNullOrWhiteSpace($voiceName)) { $lines += ('Voice: ' + $voiceName) }
    return [string]::Join("`n", $lines)
}

$stdin = [Console]::In
while ($null -ne ($line = $stdin.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $msg = $null
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    $id = $null
    if ($null -ne $msg.id) { $id = $msg.id }
    $method = [string]$msg.method
    try {
        switch ($method) {
            'initialize' {
                $version = '2025-06-18'
                if ($msg.params -and $msg.params.protocolVersion) { $version = [string]$msg.params.protocolVersion }
                Send-Result $id ([ordered]@{
                    protocolVersion = $version
                    capabilities    = [ordered]@{tools = [ordered]@{}}
                    serverInfo      = [ordered]@{name = 'cadt-tts-sapi'; version = '1.0.0'}
                })
            }
            'notifications/initialized' { }
            'ping' { Send-Result $id ([ordered]@{}) }
            'tools/list' { Send-Result $id ([ordered]@{tools = @($tool)}) }
            'tools/call' {
                $name = [string]$msg.params.name
                if ($name -ne 'tts_sapi') {
                    Send-Result $id ([ordered]@{
                        content = @([ordered]@{type = 'text'; text = ('Unknown tool: ' + $name)})
                        isError = $true
                    })
                    break
                }
                try {
                    $textResult = Invoke-Tts $msg.params.arguments
                    Send-Result $id ([ordered]@{
                        content = @([ordered]@{type = 'text'; text = $textResult})
                        isError = $false
                    })
                } catch {
                    Send-Result $id ([ordered]@{
                        content = @([ordered]@{type = 'text'; text = ('Error: ' + $_.Exception.Message)})
                        isError = $true
                    })
                }
            }
            default {
                if ($null -ne $id) { Send-Error $id -32601 ('Method not found: ' + $method) }
            }
        }
    } catch {
        if ($null -ne $id) { Send-Error $id -32603 ('Internal error: ' + $_.Exception.Message) }
    }
}
