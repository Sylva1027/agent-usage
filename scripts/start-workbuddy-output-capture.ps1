#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$CliEntry = $null
$CaptureHome = [IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.workbuddy-ai')
$CliArguments = @()
for ($index = 0; $index -lt $args.Count; $index++) {
    $argument = $args[$index]
    if ($argument -eq '--') {
        if ($index + 1 -lt $args.Count) { $CliArguments = @($args[($index + 1)..($args.Count - 1)]) }
        break
    }
    if ($argument -notin @('-CliEntry', '-CaptureHome') -or $index + 1 -ge $args.Count) {
        throw 'Usage: start-workbuddy-output-capture.ps1 -CliEntry <path> [-CaptureHome <path>] -- <CLI arguments>'
    }
    $index++
    if ($argument -eq '-CliEntry') { $CliEntry = $args[$index] }
    else { $CaptureHome = $args[$index] }
}
if ([string]::IsNullOrWhiteSpace($CliEntry)) { throw '-CliEntry is required.' }
$entry = (Resolve-Path -LiteralPath $CliEntry -ErrorAction Stop).Path
$collector = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'workbuddy-output-capture.mjs')).Path
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$oldCaptureHome = $env:CODEX_USAGE_CAPTURE_HOME
try {
    $env:CODEX_USAGE_CAPTURE_HOME = [IO.Path]::GetFullPath($CaptureHome)
    & $nodePath --import ([Uri]$collector).AbsoluteUri $entry @CliArguments
    $result = $LASTEXITCODE
} finally {
    $env:CODEX_USAGE_CAPTURE_HOME = $oldCaptureHome
}
exit $result
