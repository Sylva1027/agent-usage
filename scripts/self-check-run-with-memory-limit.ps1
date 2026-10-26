#requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot "run-with-memory-limit.ps1"
$pwsh = (Get-Command pwsh -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$node = (Get-Command node -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "codex-memory-limit-self-check-" + [Guid]::NewGuid().ToString("N"))
$tempPath = [IO.Path]::GetFullPath($tempRoot)
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $tempPath.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Temporary path escaped the system temp directory: $tempPath"
}
[void](New-Item -ItemType Directory -Path $tempPath -Force)

$stressMarker = Join-Path $tempPath "stress-child.pid"
$killMarker = Join-Path $tempPath "kill-child.pid"
$stressChildPid = $null
$killChildPid = $null
$killWrapper = $null

function Wait-ProcessGone {
    param([int]$ProcessId, [int]$TimeoutMs = 5000)

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            return
        }
        Start-Sleep -Milliseconds 50
    }
    throw "Process $ProcessId remained after the job ended"
}

function Read-PidMarker {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Child did not write its PID marker: $Path"
    }
    $value = (Get-Content -LiteralPath $Path -Raw).Trim()
    $processId = 0
    if (-not [int]::TryParse($value, [ref]$processId) -or $processId -le 0) {
        throw "Invalid PID marker: $value"
    }
    return $processId
}

function Invoke-Wrapper {
    param(
        [string[]]$Arguments,
        [int]$TimeoutMs
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwsh
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-File", $wrapper) +
        $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
            throw "Wrapper timed out after $TimeoutMs ms"
        }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Output = ($stdout + $stderr).Trim()
        }
    }
    finally {
        $process.Dispose()
    }
}

try {
    $expectedArgumentsJson = '["","a b","a\"b","tail\\"]'
    $normalScript = 'if(JSON.stringify(process.argv.slice(1))!==' +
        (ConvertTo-Json -Compress -InputObject $expectedArgumentsJson) +
        '||process.cwd()!==' +
        (ConvertTo-Json -Compress -InputObject $repoRoot) +
        ')process.exit(24);process.exit(23)'
    $normal = Invoke-Wrapper -TimeoutMs 10000 -Arguments @(
        "-LimitMiB", "64", "-TimeoutSeconds", "10",
        "-FilePath", $node, "-ArgumentsJson",
        (ConvertTo-Json -Compress -InputObject @("-e", $normalScript, "", "a b", 'a"b', 'tail\')))
    if ($normal.ExitCode -ne 23) {
        throw "Exit code was not preserved: expected 23, got $($normal.ExitCode); output: $($normal.Output)"
    }

    $stressScript = @'
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const marker = process.argv[1];
const childScript = `
  const fs = require("node:fs");
  const block = Buffer.alloc(48 * 1024 * 1024, 1);
  fs.writeFileSync(process.argv[1], String(process.pid));
  setInterval(() => { block[0] ^= 1; }, 1000);
`;
const child = spawn(process.execPath, ["-e", childScript, marker], {
  stdio: "inherit",
  windowsHide: true
});
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10000;
while (!fs.existsSync(marker)) {
  if (Date.now() >= deadline) process.exit(26);
  Atomics.wait(wait, 0, 0, 50);
}
const block = Buffer.alloc(48 * 1024 * 1024, 1);
setInterval(() => { block[0] ^= 1; }, 1000);
'@

    $stress = Invoke-Wrapper -TimeoutMs 15000 -Arguments @(
        "-LimitMiB", "128", "-TimeoutSeconds", "15", "-WorkingDirectory", $repoRoot,
        "-FilePath", $node, "-ArgumentsJson",
        (ConvertTo-Json -Compress -InputObject @("-e", $stressScript, $stressMarker)))
    $stressChildPid = Read-PidMarker -Path $stressMarker
    if ($stress.ExitCode -ne 137) {
        throw "Expected memory-limit exit 137, got $($stress.ExitCode); output: $($stress.Output)"
    }
    if ($stress.Output -notmatch "job memory limit exceeded") {
        throw "Missing job memory limit diagnostic; output: $($stress.Output)"
    }
    Wait-ProcessGone -ProcessId $stressChildPid
    $stressChildPid = $null

    $killScript = @'
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], String(process.pid));
setInterval(() => {}, 1000);
'@

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwsh
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-File", $wrapper,
            "-LimitMiB", "64", "-TimeoutSeconds", "15", "-WorkingDirectory", $repoRoot,
            "-FilePath", $node, "-ArgumentsJson",
            (ConvertTo-Json -Compress -InputObject @("-e", $killScript, $killMarker)))) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    $killWrapper = [Diagnostics.Process]::Start($startInfo)
    $killDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath $killMarker -PathType Leaf)) {
        if ($killWrapper.HasExited) {
            throw "Wrapper exited before its child wrote the marker: $($killWrapper.ExitCode)"
        }
        if ([DateTime]::UtcNow -ge $killDeadline) {
            throw "Timed out waiting for the wrapper child marker"
        }
        Start-Sleep -Milliseconds 50
    }
    $killChildPid = Read-PidMarker -Path $killMarker
    if (-not $killWrapper.HasExited) {
        $killWrapper.Kill()
    }
    [void]$killWrapper.WaitForExit(5000)
    Wait-ProcessGone -ProcessId $killChildPid
    $killChildPid = $null

    "run-with-memory-limit self-check: 3/3 pass"
}
catch {
    [Console]::Error.WriteLine("run-with-memory-limit self-check: $($_.Exception.GetBaseException().Message)")
    exit 1
}
finally {
    if ($killWrapper -and -not $killWrapper.HasExited) {
        $killWrapper.Kill()
        [void]$killWrapper.WaitForExit(2000)
    }
    foreach ($processId in @($stressChildPid, $killChildPid)) {
        if ($processId) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -LiteralPath $tempPath -Recurse -Force
    }
}
