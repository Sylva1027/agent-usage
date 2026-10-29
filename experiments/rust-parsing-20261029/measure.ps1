param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$ArgumentsJson,
  [Parameter(Mandatory = $true)][string]$StdoutPath,
  [Parameter(Mandatory = $true)][string]$StderrPath,
  [Parameter(Mandatory = $true)][string]$MetricsPath,
  [int]$SampleMilliseconds = 2,
  [string]$ChildPidPath = ''
)

$argumentList = @($ArgumentsJson | ConvertFrom-Json)
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $Executable
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true
foreach ($argument in $argumentList) {
  [void]$startInfo.ArgumentList.Add($argument)
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
[void]$process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$peakWorkingSet = 0L
$peakPrivate = 0L
$childPeakWorkingSet = 0L
$childPeakPrivate = 0L
$treePeakWorkingSet = 0L
$treePeakPrivate = 0L
$childProcessId = 0
$childProcess = $null

while (-not $process.HasExited) {
  try {
    $process.Refresh()
    $peakWorkingSet = [Math]::Max($peakWorkingSet, $process.WorkingSet64)
    $peakPrivate = [Math]::Max($peakPrivate, $process.PrivateMemorySize64)
  } catch {
  }
  if ($ChildPidPath) {
    if ($childProcessId -eq 0) {
      if (Test-Path -LiteralPath $ChildPidPath) {
        $pidText = [System.IO.File]::ReadAllText($ChildPidPath)
        $parsedPid = 0
        if ([int]::TryParse($pidText, [ref]$parsedPid) -and $parsedPid -gt 0) {
          $childProcessId = $parsedPid
        }
      }
      if ($childProcessId -gt 0) {
        try {
          $childProcess = [System.Diagnostics.Process]::GetProcessById($childProcessId)
        } catch {
          $childProcessId = 0
        }
      }
    }
    if ($childProcess) {
      try {
        $childProcess.Refresh()
        if (-not $childProcess.HasExited) {
          $childPeakWorkingSet = [Math]::Max($childPeakWorkingSet, $childProcess.WorkingSet64)
          $childPeakPrivate = [Math]::Max($childPeakPrivate, $childProcess.PrivateMemorySize64)
          $treePeakWorkingSet = [Math]::Max($treePeakWorkingSet, $process.WorkingSet64 + $childProcess.WorkingSet64)
          $treePeakPrivate = [Math]::Max($treePeakPrivate, $process.PrivateMemorySize64 + $childProcess.PrivateMemorySize64)
        }
      } catch {
      }
    }
  }
  Start-Sleep -Milliseconds $SampleMilliseconds
}

$process.WaitForExit()
$stopwatch.Stop()
try {
  $process.Refresh()
  $peakWorkingSet = [Math]::Max($peakWorkingSet, $process.WorkingSet64)
  $peakPrivate = [Math]::Max($peakPrivate, $process.PrivateMemorySize64)
} catch {
}

$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()
[System.IO.File]::WriteAllText($StdoutPath, $stdout)
[System.IO.File]::WriteAllText($StderrPath, $stderr)
$metrics = [ordered]@{
  exitCode = $process.ExitCode
  wallMs = $stopwatch.Elapsed.TotalMilliseconds
  peakWorkingSetBytes = $peakWorkingSet
  peakPrivateBytes = $peakPrivate
  stdoutBytes = [Text.Encoding]::UTF8.GetByteCount($stdout)
  stderrBytes = [Text.Encoding]::UTF8.GetByteCount($stderr)
  childProcessId = if ($childProcessId -gt 0) { $childProcessId } else { $null }
  childPeakWorkingSetBytes = $childPeakWorkingSet
  childPeakPrivateBytes = $childPeakPrivate
  treePeakWorkingSetBytes = $treePeakWorkingSet
  treePeakPrivateBytes = $treePeakPrivate
}
$metrics | ConvertTo-Json -Compress | Set-Content -LiteralPath $MetricsPath -Encoding utf8
$process.Dispose()
if ($childProcess) { $childProcess.Dispose() }
