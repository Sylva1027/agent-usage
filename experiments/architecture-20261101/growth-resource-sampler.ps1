[CmdletBinding(DefaultParameterSetName = "Run")]
param(
  [Parameter(Mandatory = $true, ParameterSetName = "Run")]
  [string]$ResultDir,

  [Parameter(Mandatory = $true, ParameterSetName = "Run")]
  [int]$ServicePid,

  [Parameter(Mandatory = $true, ParameterSetName = "Run")]
  [int]$RunnerPid,

  [Parameter(Mandatory = $true, ParameterSetName = "Run")]
  [string]$StopFile,

  [Parameter(Mandatory = $true, ParameterSetName = "SelfTest")]
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$observerCpuStart = [Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalSeconds

if (-not ("CodexGrowthResource.Interop" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexGrowthResource {
  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  public static class Interop {
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessIoCounters(IntPtr process, out IoCounters counters);

    public static bool TryGetIoCounters(int pid, out IoCounters counters) {
      IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
      if (handle == IntPtr.Zero) {
        counters = default(IoCounters);
        return false;
      }

      try {
        return GetProcessIoCounters(handle, out counters);
      } finally {
        CloseHandle(handle);
      }
    }
  }
}
'@
}

function Get-LiveProcessMap {
  $processes = @(Get-Process -ErrorAction SilentlyContinue)
  $byId = @{}
  foreach ($process in $processes) {
    $byId[[string]$process.Id] = $process
  }
  return $byId
}

function Get-TreeMetadata {
  param([Parameter(Mandatory = $true)][string]$Directory)

  $parents = @{}
  $names = @{}
  $telemetryRecords = 0
  $warnings = [Collections.Generic.List[string]]::new()
  $telemetryFiles = @(
    Get-ChildItem -LiteralPath $Directory -File -Filter "process-*.ndjson" -ErrorAction SilentlyContinue
  )
  foreach ($file in $telemetryFiles) {
    $reader = $null
    try {
      $sharedStream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $reader = [IO.StreamReader]::new($sharedStream)
      $line = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($line)) {
        continue
      }
      $record = $line | ConvertFrom-Json
      if ($record.type -ne "start") {
        continue
      }
      $pidValue = [int]$record.pid
      $parentValue = [int]$record.ppid
      $parents[[string]$pidValue] = $parentValue
      $telemetryRecords += 1
    } catch {
      $warnings.Add("telemetry: $($file.Name): $($_.Exception.Message)")
    } finally {
      if ($null -ne $reader) {
        $reader.Dispose()
      }
    }
  }

  $cimRecords = 0
  try {
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name -ErrorAction Stop)
    foreach ($row in $rows) {
      $pidValue = [int]$row.ProcessId
      $parents[[string]$pidValue] = [int]$row.ParentProcessId
      $names[[string]$pidValue] = [string]$row.Name
      $cimRecords += 1
    }
  } catch {
    $warnings.Add("cim: $($_.Exception.Message)")
  }

  return [pscustomobject]@{
    Parents = $parents
    Names = $names
    TelemetryRecords = $telemetryRecords
    CimRecords = $cimRecords
    RefreshedAt = [DateTimeOffset]::UtcNow
    Warnings = @($warnings)
  }
}

function Get-TreeIds {
  param(
    [Parameter(Mandatory = $true)][int]$RootPid,
    [Parameter(Mandatory = $true)][hashtable]$Parents
  )

  $children = @{}
  foreach ($entry in $Parents.GetEnumerator()) {
    $childPid = [int]$entry.Key
    $parentPid = [int]$entry.Value
    $parentKey = [string]$parentPid
    if (-not $children.ContainsKey($parentKey)) {
      $children[$parentKey] = [Collections.Generic.List[int]]::new()
    }
    $children[$parentKey].Add($childPid)
  }

  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootPid)
  $queue = [Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    $key = [string]$current
    if (-not $children.ContainsKey($key)) {
      continue
    }
    foreach ($child in $children[$key]) {
      if ($ids.Add($child)) {
        $queue.Enqueue($child)
      }
    }
  }
  return @($ids)
}

function Get-ProcessRows {
  param(
    [Parameter(Mandatory = $true)][hashtable]$ProcessMap,
    [AllowEmptyCollection()]
    [Parameter(Mandatory = $true)][Collections.Generic.HashSet[int]]$ServiceIds,
    [AllowEmptyCollection()]
    [Parameter(Mandatory = $true)][Collections.Generic.HashSet[int]]$BrowserIds,
    [Parameter(Mandatory = $true)][int]$RunnerPid,
    [Parameter(Mandatory = $true)][int]$ObserverPid,
    [Parameter(Mandatory = $true)][hashtable]$Parents,
    [Parameter(Mandatory = $true)][hashtable]$Names
  )

  $rows = [Collections.Generic.List[object]]::new()
  $allIds = [Collections.Generic.HashSet[int]]::new()
  foreach ($id in $ServiceIds) { [void]$allIds.Add($id) }
  foreach ($id in $BrowserIds) { [void]$allIds.Add($id) }
  [void]$allIds.Add($RunnerPid)
  [void]$allIds.Add($ObserverPid)

  foreach ($id in $allIds) {
    if ($id -eq $ObserverPid) {
      $role = "observer"
    } elseif ($ServiceIds.Contains($id)) {
      $role = "service"
    } elseif ($BrowserIds.Contains($id)) {
      $role = "browser"
    } elseif ($id -eq $RunnerPid) {
      $role = "runner"
    } else {
      continue
    }

    $process = $ProcessMap[[string]$id]
    if ($null -eq $process) {
      continue
    }

    $startTicks = [long]0
    try {
      $startTicks = $process.StartTime.ToUniversalTime().Ticks
    } catch {
      # Short-lived processes may exit before their start time can be queried.
    }
    $cpuSeconds = [double]0
    try {
      $cpuSeconds = [double]$process.CPU
    } catch {
      # CPU is optional for processes that exit during sampling.
    }
    $io = [CodexGrowthResource.IoCounters]::new()
    $ioAvailable = [CodexGrowthResource.Interop]::TryGetIoCounters($id, [ref]$io)
    $parentPid = if ($Parents.ContainsKey([string]$id)) { [int]$Parents[[string]$id] } else { 0 }
    $name = if ($Names.ContainsKey([string]$id)) { [string]$Names[[string]$id] } else { [string]$process.ProcessName }

    $rows.Add([pscustomobject][ordered]@{
      pid = $id
      parentPid = $parentPid
      name = $name
      role = $role
      startTimeUtcTicks = $startTicks
      workingSetBytes = [long]$process.WorkingSet64
      privateBytes = [long]$process.PrivateMemorySize64
      reportedPeakWorkingSetBytes = [long]$process.PeakWorkingSet64
      cpuSeconds = $cpuSeconds
      ioAvailable = [bool]$ioAvailable
      logicalReadBytes = if ($ioAvailable) { [long]$io.ReadTransferCount } else { $null }
      logicalWriteBytes = if ($ioAvailable) { [long]$io.WriteTransferCount } else { $null }
      readOperations = if ($ioAvailable) { [long]$io.ReadOperationCount } else { $null }
      writeOperations = if ($ioAvailable) { [long]$io.WriteOperationCount } else { $null }
    })
  }
  return @($rows)
}

function Measure-Scope {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [object[]]$Rows
  )

  $workingSetBytes = [long]0
  $privateBytes = [long]0
  $reportedPeakWorkingSetBytes = [long]0
  $cpuSeconds = [double]0
  $logicalReadBytes = [long]0
  $logicalWriteBytes = [long]0
  foreach ($row in $Rows) {
    $workingSetBytes += [long]$row.workingSetBytes
    $privateBytes += [long]$row.privateBytes
    $reportedPeakWorkingSetBytes += [long]$row.reportedPeakWorkingSetBytes
    $cpuSeconds += [double]$row.cpuSeconds
    if ($row.ioAvailable) {
      $logicalReadBytes += [long]$row.logicalReadBytes
      $logicalWriteBytes += [long]$row.logicalWriteBytes
    }
  }
  return [pscustomobject]@{
    processCount = $Rows.Count
    workingSetBytes = $workingSetBytes
    privateBytes = $privateBytes
    reportedPeakWorkingSetBytes = $reportedPeakWorkingSetBytes
    cpuSeconds = $cpuSeconds
    logicalReadBytes = $logicalReadBytes
    logicalWriteBytes = $logicalWriteBytes
  }
}

function ConvertTo-ScopePeakSummary {
  param([Parameter(Mandatory = $true)]$Peak)
  return [ordered]@{
    peakSampledProcessCount = $Peak.processCount
    peakSampledWorkingSetBytes = $Peak.workingSetBytes
    peakSampledPrivateBytes = $Peak.privateBytes
    peakSampledReportedProcessPeakWorkingSetBytes = $Peak.reportedPeakWorkingSetBytes
    peakSampledCpuSeconds = $Peak.cpuSeconds
    peakSampledLogicalReadBytes = $Peak.logicalReadBytes
    peakSampledLogicalWriteBytes = $Peak.logicalWriteBytes
  }
}

function New-ScopePeak {
  return [pscustomobject]@{
    processCount = 0
    workingSetBytes = [long]0
    privateBytes = [long]0
    reportedPeakWorkingSetBytes = [long]0
    cpuSeconds = [double]0
    logicalReadBytes = [long]0
    logicalWriteBytes = [long]0
  }
}

function Get-SqliteStateSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [Parameter(Mandatory = $true)][string]$ResultDirectory
  )

  if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container)) {
    return [pscustomobject]@{ totalBytes = [long]0; files = @() }
  }
  $files = @(
    Get-ChildItem -LiteralPath $StateDirectory -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "*sqlite*" } |
      Sort-Object FullName
  )
  $rows = [Collections.Generic.List[object]]::new()
  $totalBytes = [long]0
  foreach ($file in $files) {
    $size = [long]$file.Length
    $totalBytes += $size
    $rows.Add([pscustomobject]@{
      relativePath = [IO.Path]::GetRelativePath($ResultDirectory, $file.FullName).Replace("\", "/")
      bytes = $size
    })
  }
  return [pscustomobject]@{ totalBytes = $totalBytes; files = @($rows) }
}

function Update-Maximum {
  param(
    [Parameter(Mandatory = $true)]$Target,
    [Parameter(Mandatory = $true)][string]$Property,
    [Parameter(Mandatory = $true)][long]$Value
  )
  if ($Value -gt [long]$Target.$Property) {
    $Target.$Property = $Value
  }
}

function Update-ProcessPeaks {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Peaks,
    [AllowEmptyCollection()]
    [Parameter(Mandatory = $true)][object[]]$Rows,
    [Parameter(Mandatory = $true)][string]$At
  )

  foreach ($row in $Rows) {
    $key = "$($row.pid):$($row.startTimeUtcTicks)"
    if (-not $Peaks.ContainsKey($key)) {
      $Peaks[$key] = [pscustomobject][ordered]@{
        pid = [int]$row.pid
        name = [string]$row.name
        role = [string]$row.role
        firstSeenAt = $At
        lastSeenAt = $At
        samples = 0
        peakWorkingSetBytes = [long]0
        peakPrivateBytes = [long]0
        reportedPeakWorkingSetBytes = [long]0
        peakCpuSeconds = [double]0
        maxLogicalReadBytes = [long]0
        maxLogicalWriteBytes = [long]0
        maxReadOperations = [long]0
        maxWriteOperations = [long]0
      }
    }
    $peak = $Peaks[$key]
    $peak.lastSeenAt = $At
    $peak.samples += 1
    Update-Maximum $peak "peakWorkingSetBytes" ([long]$row.workingSetBytes)
    Update-Maximum $peak "peakPrivateBytes" ([long]$row.privateBytes)
    Update-Maximum $peak "reportedPeakWorkingSetBytes" ([long]$row.reportedPeakWorkingSetBytes)
    if ([double]$row.cpuSeconds -gt $peak.peakCpuSeconds) {
      $peak.peakCpuSeconds = [double]$row.cpuSeconds
    }
    if ($row.ioAvailable) {
      Update-Maximum $peak "maxLogicalReadBytes" ([long]$row.logicalReadBytes)
      Update-Maximum $peak "maxLogicalWriteBytes" ([long]$row.logicalWriteBytes)
      Update-Maximum $peak "maxReadOperations" ([long]$row.readOperations)
      Update-Maximum $peak "maxWriteOperations" ([long]$row.writeOperations)
    }
  }
}

function Write-SummaryFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Summary
  )
  [IO.File]::WriteAllText(
    $Path,
    ($Summary | ConvertTo-Json -Depth 12),
    [Text.UTF8Encoding]::new($false)
  )
}

function Invoke-GrowthResourceSampler {
  param(
    [Parameter(Mandatory = $true)][string]$ResultDirectory,
    [Parameter(Mandatory = $true)][int]$ServiceTreePid,
    [Parameter(Mandatory = $true)][int]$BrowserRunnerPid,
    [Parameter(Mandatory = $true)][string]$StopMarker,
    [int]$SampleIntervalMilliseconds = 1000,
    [int]$CimRefreshMilliseconds = 3000,
    [int]$MaxSamples = 0
  )

  $null = New-Item -ItemType Directory -Path $ResultDirectory -Force
  $stateDirectory = Join-Path $ResultDirectory "state"
  $samplesPath = Join-Path $ResultDirectory "resource-samples.ndjson"
  $summaryPath = Join-Path $ResultDirectory "resource-summary.json"
  $writer = [IO.StreamWriter]::new($samplesPath, $false, [Text.UTF8Encoding]::new($false))
  $writer.AutoFlush = $true
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $startedAt = [DateTimeOffset]::UtcNow
  $treeMetadata = $null
  $treeMetadataAt = [DateTimeOffset]::MinValue
  $sampleCount = 0
  $stopReason = "unknown"
  $failure = $null
  $warnings = [Collections.Generic.List[string]]::new()
  $processPeaks = @{}
  $sqlitePeaks = @{}
  $sqlitePeakTotalBytes = [long]0
  $scopePeaks = @{
    service = (New-ScopePeak)
    browser = (New-ScopePeak)
    runner = (New-ScopePeak)
    observer = (New-ScopePeak)
  }

  try {
    while ($true) {
      $now = [DateTimeOffset]::UtcNow
      if ($null -eq $treeMetadata -or ($now - $treeMetadataAt).TotalMilliseconds -ge $CimRefreshMilliseconds) {
        $treeMetadata = Get-TreeMetadata -Directory $ResultDirectory
        $treeMetadataAt = $now
        foreach ($warning in $treeMetadata.Warnings) {
          if (-not $warnings.Contains($warning)) {
            $warnings.Add($warning)
          }
        }
      }

      $processMap = Get-LiveProcessMap
      $serviceIds = [Collections.Generic.HashSet[int]]::new()
      foreach ($id in @(Get-TreeIds -RootPid $ServiceTreePid -Parents $treeMetadata.Parents)) {
        [void]$serviceIds.Add([int]$id)
      }
      $runnerTree = [Collections.Generic.HashSet[int]]::new()
      foreach ($id in @(Get-TreeIds -RootPid $BrowserRunnerPid -Parents $treeMetadata.Parents)) {
        [void]$runnerTree.Add([int]$id)
      }
      $browserIds = [Collections.Generic.HashSet[int]]::new()
      foreach ($id in $runnerTree) {
        if ($id -ne $BrowserRunnerPid -and $id -ne $PID -and -not $serviceIds.Contains($id)) {
          [void]$browserIds.Add($id)
        }
      }
      [void]$serviceIds.Remove($PID)

      $rows = @(Get-ProcessRows `
        -ProcessMap $processMap `
        -ServiceIds $serviceIds `
        -BrowserIds $browserIds `
        -RunnerPid $BrowserRunnerPid `
        -ObserverPid $PID `
        -Parents $treeMetadata.Parents `
        -Names $treeMetadata.Names)
      $serviceRows = @($rows | Where-Object { $_.role -eq "service" })
      $browserRows = @($rows | Where-Object { $_.role -eq "browser" })
      $runnerRows = @($rows | Where-Object { $_.role -eq "runner" })
      $observerRows = @($rows | Where-Object { $_.role -eq "observer" })
      $serviceMeasure = Measure-Scope $serviceRows
      $browserMeasure = Measure-Scope $browserRows
      $runnerMeasure = Measure-Scope $runnerRows
      $observerMeasure = Measure-Scope $observerRows

      foreach ($scope in @(
        @{ name = "service"; value = $serviceMeasure },
        @{ name = "browser"; value = $browserMeasure },
        @{ name = "runner"; value = $runnerMeasure },
        @{ name = "observer"; value = $observerMeasure }
      )) {
        $peak = $scopePeaks[$scope.name]
        Update-Maximum $peak "processCount" ([long]$scope.value.processCount)
        Update-Maximum $peak "workingSetBytes" ([long]$scope.value.workingSetBytes)
        Update-Maximum $peak "privateBytes" ([long]$scope.value.privateBytes)
        Update-Maximum $peak "reportedPeakWorkingSetBytes" ([long]$scope.value.reportedPeakWorkingSetBytes)
        Update-Maximum $peak "logicalReadBytes" ([long]$scope.value.logicalReadBytes)
        Update-Maximum $peak "logicalWriteBytes" ([long]$scope.value.logicalWriteBytes)
        if ([double]$scope.value.cpuSeconds -gt $peak.cpuSeconds) {
          $peak.cpuSeconds = [double]$scope.value.cpuSeconds
        }
      }

      $at = $now.ToString("O")
      Update-ProcessPeaks -Peaks $processPeaks -Rows $rows -At $at
      $sqliteSnapshot = Get-SqliteStateSnapshot -StateDirectory $stateDirectory -ResultDirectory $ResultDirectory
      if ($sqliteSnapshot.totalBytes -gt $sqlitePeakTotalBytes) {
        $sqlitePeakTotalBytes = [long]$sqliteSnapshot.totalBytes
      }
      foreach ($file in $sqliteSnapshot.files) {
        if (-not $sqlitePeaks.ContainsKey($file.relativePath)) {
          $sqlitePeaks[$file.relativePath] = [pscustomobject]@{
            relativePath = $file.relativePath
            peakBytes = [long]0
          }
        }
        Update-Maximum $sqlitePeaks[$file.relativePath] "peakBytes" ([long]$file.bytes)
      }

      $sample = [ordered]@{
        schemaVersion = "growth-resource-sample.v1"
        sample = $sampleCount + 1
        at = $at
        atUnixMs = $now.ToUnixTimeMilliseconds()
        elapsedMilliseconds = $stopwatch.ElapsedMilliseconds
        treeMetadata = [ordered]@{
          refreshedAt = $treeMetadata.RefreshedAt.ToString("O")
          ageMilliseconds = [long]($now - $treeMetadataAt).TotalMilliseconds
          telemetryStartRecords = $treeMetadata.TelemetryRecords
          cimProcessRecords = $treeMetadata.CimRecords
          servicePids = @($serviceIds | Sort-Object)
          browserPids = @($browserIds | Sort-Object)
          runnerPid = $BrowserRunnerPid
          observerPid = $PID
        }
        service = $serviceMeasure
        browser = $browserMeasure
        runner = $runnerMeasure
        observer = $observerMeasure
        sqlite = $sqliteSnapshot
        processes = $rows
        ioMetricNote = "logical cumulative transfer bytes from GetProcessIoCounters; not physical disk I/O"
      }
      $writer.WriteLine(($sample | ConvertTo-Json -Depth 10 -Compress))
      $sampleCount += 1

      if (Test-Path -LiteralPath $StopMarker) {
        $stopReason = "stop-file"
        break
      }
      if ($MaxSamples -gt 0 -and $sampleCount -ge $MaxSamples) {
        $stopReason = "self-test-limit"
        break
      }
      if (
        $MaxSamples -eq 0 -and
        $sampleCount -ge 2 -and
        -not $processMap.ContainsKey([string]$ServiceTreePid) -and
        -not $processMap.ContainsKey([string]$BrowserRunnerPid)
      ) {
        $stopReason = "roots-gone"
        break
      }
      Start-Sleep -Milliseconds $SampleIntervalMilliseconds
    }
  } catch {
    $failure = $_
    throw
  } finally {
    $stopwatch.Stop()
    $writer.Dispose()
    $endedAt = [DateTimeOffset]::UtcNow
    $observerCpuEnd = [Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalSeconds
    $observerCpuSeconds = [double]($observerCpuEnd - $observerCpuStart)
    $wallSeconds = $stopwatch.Elapsed.TotalSeconds
    $summary = [ordered]@{
      schemaVersion = "growth-resource-sampler.v1"
      startedAt = $startedAt.ToString("O")
      endedAt = $endedAt.ToString("O")
      wallMilliseconds = $stopwatch.ElapsedMilliseconds
      sampleIntervalMilliseconds = $SampleIntervalMilliseconds
      cimRefreshMilliseconds = $CimRefreshMilliseconds
      sampleCount = $sampleCount
      stopReason = $stopReason
      tree = [ordered]@{
        serviceRootPid = $ServiceTreePid
        runnerRootPid = $BrowserRunnerPid
        observerPid = $PID
      }
      metricDefinitions = [ordered]@{
        workingSet = "Get-Process WorkingSet64, sampled current RSS"
        privateBytes = "Get-Process PrivateMemorySize64, sampled current private bytes"
        reportedPeakWorkingSet = "Get-Process PeakWorkingSet64, process-lifetime peak reported by Windows"
        cpuSeconds = "Get-Process CPU, cumulative processor-time seconds; can exceed wall seconds across cores"
        logicalIo = "GetProcessIoCounters transfer bytes and operation counts; logical I/O, not physical disk I/O"
        sqliteFiles = "recursive files under ResultDir/state whose name contains sqlite"
      }
      service = ConvertTo-ScopePeakSummary $scopePeaks.service
      browser = ConvertTo-ScopePeakSummary $scopePeaks.browser
      runner = ConvertTo-ScopePeakSummary $scopePeaks.runner
      observer = [ordered]@{
        processCountPeak = $scopePeaks.observer.processCount
        workingSetBytesPeak = $scopePeaks.observer.workingSetBytes
        privateBytesPeak = $scopePeaks.observer.privateBytes
        reportedPeakWorkingSetBytes = $scopePeaks.observer.reportedPeakWorkingSetBytes
        cpuSecondsAtStart = [double]$observerCpuStart
        cpuSecondsAtEnd = [double]$observerCpuEnd
        cpuSecondsUsed = $observerCpuSeconds
        cpuPercentOfWall = if ($wallSeconds -gt 0) { [double](100 * $observerCpuSeconds / $wallSeconds) } else { 0 }
        logicalReadBytesPeak = $scopePeaks.observer.logicalReadBytes
        logicalWriteBytesPeak = $scopePeaks.observer.logicalWriteBytes
      }
      sqlite = [ordered]@{
        peakTotalBytes = $sqlitePeakTotalBytes
        files = @($sqlitePeaks.Values | Sort-Object relativePath)
      }
      processes = @($processPeaks.Values | Sort-Object firstSeenAt, pid)
      warnings = @($warnings)
      failure = if ($null -eq $failure) { $null } else { [string]$failure.Exception.Message }
    }
    Write-SummaryFile -Path $summaryPath -Summary $summary
  }
  return $summary
}

if ($SelfTest) {
  $selfTestRoot = Join-Path (
    [IO.Path]::GetTempPath()
  ) ("growth-resource-sampler-{0}" -f [Guid]::NewGuid().ToString("N"))
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $selfTestFull = [IO.Path]::GetFullPath($selfTestRoot)
  if (-not $selfTestFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Self-test path escaped the temporary directory"
  }

  try {
    $syntheticParents = @{
      "101" = 1
      "102" = 1
      "103" = 101
      "104" = 1
      "105" = 104
    }
    $syntheticService = @(Get-TreeIds -RootPid 101 -Parents $syntheticParents) | Sort-Object
    $syntheticRunner = @(Get-TreeIds -RootPid 1 -Parents $syntheticParents) | Sort-Object
    $syntheticBrowser = @(
      $syntheticRunner |
        Where-Object { $_ -ne 1 -and $_ -ne $PID -and $_ -notin $syntheticService }
    ) | Sort-Object
    if (
      ($syntheticService -join ",") -ne "101,103" -or
      ($syntheticRunner -join ",") -ne "1,101,102,103,104,105" -or
      ($syntheticBrowser -join ",") -ne "102,104,105"
    ) {
      throw "Self-test process-tree classification failed"
    }

    $null = New-Item -ItemType Directory -Path (Join-Path $selfTestRoot "state") -Force
    $telemetryPath = Join-Path $selfTestRoot ("process-{0}.ndjson" -f $PID)
    $telemetry = [ordered]@{
      type = "start"
      pid = $PID
      ppid = 0
      at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    [IO.File]::WriteAllText($telemetryPath, (($telemetry | ConvertTo-Json -Compress) + "`n"))
    $activeWriter = [IO.File]::Open($telemetryPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try {
      $sharedMetadata = Get-TreeMetadata -Directory $selfTestRoot
      if ($sharedMetadata.TelemetryRecords -ne 1) { throw "Telemetry reader blocked an active writer" }
      $activeReader = [IO.File]::Open($telemetryPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      try {
        $appender = [IO.File]::Open($telemetryPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $appender.Dispose()
      } finally { $activeReader.Dispose() }
    } finally { $activeWriter.Dispose() }
    [IO.File]::WriteAllBytes((Join-Path $selfTestRoot "state/selftest.sqlite"), [byte[]](0..31))
    $stopMarker = Join-Path $selfTestRoot "stop"

    $summary = Invoke-GrowthResourceSampler `
      -ResultDirectory $selfTestRoot `
      -ServiceTreePid $PID `
      -BrowserRunnerPid $PID `
      -StopMarker $stopMarker `
      -SampleIntervalMilliseconds 10 `
      -CimRefreshMilliseconds 1000 `
      -MaxSamples 2

    $samplesPath = Join-Path $selfTestRoot "resource-samples.ndjson"
    $summaryPath = Join-Path $selfTestRoot "resource-summary.json"
    $samples = @(Get-Content -LiteralPath $samplesPath | ForEach-Object { $_ | ConvertFrom-Json })
    $writtenSummary = Get-Content -Raw -LiteralPath $summaryPath | ConvertFrom-Json
    if ($summary.sampleCount -ne 2 -or $samples.Count -ne 2 -or $writtenSummary.sampleCount -ne 2) {
      throw "Self-test did not write two matching samples"
    }
    if ($samples[0].observer.processCount -ne 1 -or $writtenSummary.observer.cpuSecondsUsed -lt 0) {
      throw "Self-test observer metrics are missing"
    }
    if (-not $samples[0].processes[0].ioAvailable) {
      throw "Self-test logical I/O counters are unavailable for the current process"
    }
    if ($writtenSummary.sqlite.peakTotalBytes -ne 32) {
      throw "Self-test SQLite size peak is incorrect"
    }
    [pscustomobject]@{
      ok = $true
      samples = $samples.Count
      summary = $writtenSummary.schemaVersion
      observerCpuSeconds = $writtenSummary.observer.cpuSecondsUsed
    } | ConvertTo-Json -Compress
  } finally {
    if (
      (Test-Path -LiteralPath $selfTestFull) -and
      $selfTestFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)
    ) {
      Remove-Item -LiteralPath $selfTestFull -Recurse -Force
    }
  }
  return
}

if ([string]::IsNullOrWhiteSpace($ResultDir) -or [string]::IsNullOrWhiteSpace($StopFile)) {
  throw "ResultDir and StopFile must be non-empty"
}
if ($ServicePid -le 0 -or $RunnerPid -le 0) {
  throw "ServicePid and RunnerPid must be positive"
}
$resultDirectory = [IO.Path]::GetFullPath($ResultDir)
$stopPath = [IO.Path]::GetFullPath($StopFile)
$null = Invoke-GrowthResourceSampler `
  -ResultDirectory $resultDirectory `
  -ServiceTreePid $ServicePid `
  -BrowserRunnerPid $RunnerPid `
  -StopMarker $stopPath
