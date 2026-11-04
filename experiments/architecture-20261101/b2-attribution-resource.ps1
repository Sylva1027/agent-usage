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

  [Parameter(Mandatory = $true, ParameterSetName = "Run")]
  [string]$StateDir,

  [Parameter(ParameterSetName = "Run")]
  [string]$TempDir,

  [Parameter(ParameterSetName = "Run")]
  [ValidateSet(250, 500)]
  [int]$SampleIntervalMilliseconds = 500,

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
    const uint INVALID_FILE_SIZE = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessIoCounters(IntPtr process, out IoCounters counters);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetCompressedFileSize(string fileName, out uint fileSizeHigh);

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

    public static bool TryGetStorageBytes(string fileName, out long allocatedBytes) {
      uint high;
      uint low = GetCompressedFileSize(fileName, out high);
      if (low == INVALID_FILE_SIZE && Marshal.GetLastWin32Error() != 0) {
        allocatedBytes = 0;
        return false;
      }
      allocatedBytes = ((long)high << 32) | low;
      return true;
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

function Get-ProcessStartTicks {
  param([Parameter(Mandatory = $true)]$Process)
  try {
    return [long]$Process.StartTime.ToUniversalTime().Ticks
  } catch {
    return [long]0
  }
}

function Test-RootIdentityAlive {
  param(
    [Parameter(Mandatory = $true)][int]$RootPid,
    [Parameter(Mandatory = $true)][long]$ExpectedStartTicks,
    [Parameter(Mandatory = $true)][hashtable]$ProcessMap
  )
  $process = $ProcessMap[[string]$RootPid]
  if ($null -eq $process) {
    return $false
  }
  if ($ExpectedStartTicks -le 0) {
    return $true
  }
  return (Get-ProcessStartTicks $process) -eq $ExpectedStartTicks
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

function Get-ProcessScopeIds {
  param(
    [Parameter(Mandatory = $true)][int]$ServiceRootPid,
    [Parameter(Mandatory = $true)][int]$RunnerRootPid,
    [Parameter(Mandatory = $true)][int]$ObserverPid,
    [Parameter(Mandatory = $true)][hashtable]$Parents
  )
  $serviceIds = [Collections.Generic.HashSet[int]]::new()
  foreach ($id in @(Get-TreeIds -RootPid $ServiceRootPid -Parents $Parents)) {
    [void]$serviceIds.Add([int]$id)
  }
  $runnerTree = [Collections.Generic.HashSet[int]]::new()
  foreach ($id in @(Get-TreeIds -RootPid $RunnerRootPid -Parents $Parents)) {
    [void]$runnerTree.Add([int]$id)
  }
  $browserIds = [Collections.Generic.HashSet[int]]::new()
  foreach ($id in $runnerTree) {
    if ($id -ne $RunnerRootPid -and $id -ne $ObserverPid -and -not $serviceIds.Contains($id)) {
      [void]$browserIds.Add($id)
    }
  }
  [void]$serviceIds.Remove($ObserverPid)
  return [pscustomobject]@{
    service = $serviceIds
    browser = $browserIds
    runner = $RunnerRootPid
    observer = $ObserverPid
  }
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
    [Parameter(Mandatory = $true)][hashtable]$Names,
    [Parameter(Mandatory = $true)][hashtable]$PreviousCounters
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
    $cpuSeconds = $null
    $cpuAvailable = $false
    try {
      $cpuSeconds = [double]$process.CPU
      $cpuAvailable = $true
    } catch {
      # CPU is optional for processes that exit during sampling.
    }
    $io = [CodexGrowthResource.IoCounters]::new()
    $ioAvailable = [CodexGrowthResource.Interop]::TryGetIoCounters($id, [ref]$io)
    $parentPid = if ($Parents.ContainsKey([string]$id)) { [int]$Parents[[string]$id] } else { 0 }
    $name = if ($Names.ContainsKey([string]$id)) {
      [string]$Names[[string]$id]
    } else {
      try { [string]$process.ProcessName } catch { "unknown" }
    }
    $workingSetBytes = $null
    $privateBytes = $null
    $reportedPeakWorkingSetBytes = $null
    try {
      $workingSetValue = [long]$process.WorkingSet64
      $privateValue = [long]$process.PrivateMemorySize64
      $reportedPeakValue = [long]$process.PeakWorkingSet64
      $workingSetBytes = $workingSetValue
      $privateBytes = $privateValue
      $reportedPeakWorkingSetBytes = $reportedPeakValue
    } catch {
      # Preserve process identity and counters when a short-lived process exits mid-sample.
    }
    $counterKey = "$id`:$startTicks"
    $previous = if ($startTicks -gt 0 -and $PreviousCounters.ContainsKey($counterKey)) {
      $PreviousCounters[$counterKey]
    } else {
      $null
    }
    $cpuSecondsIncrement = if (
      $cpuAvailable -and
      $null -ne $previous -and
      $previous.cpuAvailable -and
      [double]$cpuSeconds -ge [double]$previous.cpuSeconds
    ) {
      [double]([double]$cpuSeconds - [double]$previous.cpuSeconds)
    } else {
      $null
    }
    $ioDeltaAvailable = $ioAvailable -and $null -ne $previous -and $previous.ioAvailable
    $logicalReadBytesIncrement = if (
      $ioDeltaAvailable -and
      [long]$io.ReadTransferCount -ge [long]$previous.logicalReadBytes
    ) {
      [long]([long]$io.ReadTransferCount - [long]$previous.logicalReadBytes)
    } else {
      $null
    }
    $logicalWriteBytesIncrement = if (
      $ioDeltaAvailable -and
      [long]$io.WriteTransferCount -ge [long]$previous.logicalWriteBytes
    ) {
      [long]([long]$io.WriteTransferCount - [long]$previous.logicalWriteBytes)
    } else {
      $null
    }
    if ($startTicks -gt 0) {
      $PreviousCounters[$counterKey] = [pscustomobject]@{
        cpuAvailable = $cpuAvailable
        cpuSeconds = $cpuSeconds
        ioAvailable = $ioAvailable
        logicalReadBytes = if ($ioAvailable) { [long]$io.ReadTransferCount } else { $null }
        logicalWriteBytes = if ($ioAvailable) { [long]$io.WriteTransferCount } else { $null }
      }
    }

    $rows.Add([pscustomobject][ordered]@{
      pid = $id
      parentPid = $parentPid
      name = $name
      role = $role
      startTimeUtcTicks = $startTicks
      startTimeUtc = if ($startTicks -gt 0) { [DateTime]::new($startTicks, [DateTimeKind]::Utc).ToString("O") } else { $null }
      workingSetBytes = $workingSetBytes
      privateBytes = $privateBytes
      reportedPeakWorkingSetBytes = $reportedPeakWorkingSetBytes
      cpuAvailable = [bool]$cpuAvailable
      cpuSeconds = $cpuSeconds
      cpuSecondsIncrement = $cpuSecondsIncrement
      ioAvailable = [bool]$ioAvailable
      logicalReadBytes = if ($ioAvailable) { [long]$io.ReadTransferCount } else { $null }
      logicalWriteBytes = if ($ioAvailable) { [long]$io.WriteTransferCount } else { $null }
      logicalReadBytesIncrement = $logicalReadBytesIncrement
      logicalWriteBytesIncrement = $logicalWriteBytesIncrement
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
  $cpuAvailableProcessCount = 0
  $ioAvailableProcessCount = 0
  $cpuIncrementObservedProcessCount = 0
  $readIncrementObservedProcessCount = 0
  $writeIncrementObservedProcessCount = 0
  $cpuSecondsIncrement = [double]0
  $logicalReadBytesIncrement = [long]0
  $logicalWriteBytesIncrement = [long]0
  $memoryAvailableProcessCount = 0
  foreach ($row in $Rows) {
    if ($null -ne $row.workingSetBytes) {
      $memoryAvailableProcessCount += 1
      $workingSetBytes += [long]$row.workingSetBytes
      $privateBytes += [long]$row.privateBytes
      $reportedPeakWorkingSetBytes += [long]$row.reportedPeakWorkingSetBytes
    }
    if ($row.cpuAvailable) {
      $cpuAvailableProcessCount += 1
      $cpuSeconds += [double]$row.cpuSeconds
    }
    if ($row.ioAvailable) {
      $ioAvailableProcessCount += 1
      $logicalReadBytes += [long]$row.logicalReadBytes
      $logicalWriteBytes += [long]$row.logicalWriteBytes
    }
    if ($null -ne $row.cpuSecondsIncrement) {
      $cpuIncrementObservedProcessCount += 1
      $cpuSecondsIncrement += [double]$row.cpuSecondsIncrement
    }
    if ($null -ne $row.logicalReadBytesIncrement) {
      $readIncrementObservedProcessCount += 1
      $logicalReadBytesIncrement += [long]$row.logicalReadBytesIncrement
    }
    if ($null -ne $row.logicalWriteBytesIncrement) {
      $writeIncrementObservedProcessCount += 1
      $logicalWriteBytesIncrement += [long]$row.logicalWriteBytesIncrement
    }
  }
  return [pscustomobject]@{
    processCount = $Rows.Count
    memoryAvailableProcessCount = $memoryAvailableProcessCount
    workingSetBytes = $workingSetBytes
    privateBytes = $privateBytes
    reportedPeakWorkingSetBytes = $reportedPeakWorkingSetBytes
    cpuAvailableProcessCount = $cpuAvailableProcessCount
    cpuSeconds = $cpuSeconds
    cpuIncrementObservedProcessCount = $cpuIncrementObservedProcessCount
    cpuSecondsIncrement = if ($cpuIncrementObservedProcessCount -gt 0) { [double]$cpuSecondsIncrement } else { $null }
    ioAvailableProcessCount = $ioAvailableProcessCount
    logicalReadBytes = $logicalReadBytes
    logicalWriteBytes = $logicalWriteBytes
    readIncrementObservedProcessCount = $readIncrementObservedProcessCount
    writeIncrementObservedProcessCount = $writeIncrementObservedProcessCount
    logicalReadBytesIncrement = if ($readIncrementObservedProcessCount -gt 0) { [long]$logicalReadBytesIncrement } else { $null }
    logicalWriteBytesIncrement = if ($writeIncrementObservedProcessCount -gt 0) { [long]$logicalWriteBytesIncrement } else { $null }
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
    sampledCpuSecondsIncrement = $Peak.cpuSecondsIncrementObserved
    sampledLogicalReadBytesIncrement = $Peak.logicalReadBytesIncrementObserved
    sampledLogicalWriteBytesIncrement = $Peak.logicalWriteBytesIncrementObserved
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
    cpuSecondsIncrementObserved = [double]0
    logicalReadBytesIncrementObserved = [long]0
    logicalWriteBytesIncrementObserved = [long]0
  }
}

function Get-SqliteArtifactKind {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("state", "temp")][string]$Scope
  )

  $lowerName = $Name.ToLowerInvariant()
  if ($lowerName -match '\.(sqlite3?|db3?)-wal$') {
    return "wal"
  }
  if ($lowerName -match '\.(sqlite3?|db3?)-shm$') {
    return "shm"
  }
  if ($lowerName -match '\.(sqlite3?|db3?)-journal$') {
    return "journal"
  }
  if ($lowerName -match '\.(sqlite3?|db3?)$') {
    return "database"
  }
  if ($Scope -eq "temp" -and $lowerName -like "etilqs_*") {
    return "anonymousTemp"
  }
  return $null
}

function Get-AttributionTargetSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][ValidateSet("state", "temp")][string]$Scope,
    [Parameter(Mandatory = $true)][string]$ResultDirectory
  )

  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
    return [pscustomobject]@{
      scope = $Scope
      directory = [IO.Path]::GetFullPath($Directory)
      status = "missing"
      complete = $false
      totalBytes = $null
      allocatedBytes = $null
      fileCount = 0
      categoryBytes = [ordered]@{}
      files = @()
      warnings = @("directory does not exist")
    }
  }

  $directoryFull = [IO.Path]::GetFullPath($Directory)
  $enumerationErrors = @()
  $candidates = @(
    Get-ChildItem -LiteralPath $directoryFull -File -Recurse -ErrorAction SilentlyContinue -ErrorVariable +enumerationErrors
  )
  $rows = [Collections.Generic.List[object]]::new()
  $warnings = [Collections.Generic.List[string]]::new()
  foreach ($errorRecord in $enumerationErrors) {
    $warnings.Add("enumerate: $($errorRecord.Exception.Message)")
  }
  $totalBytes = [long]0
  $allocatedBytes = [long]0
  $allocationComplete = $true
  $categoryBytes = [ordered]@{}
  foreach ($file in $candidates) {
    $kind = Get-SqliteArtifactKind -Name $file.Name -Scope $Scope
    if ($null -eq $kind) {
      continue
    }
    $logicalSize = $null
    $allocatedSize = $null
    try {
      $logicalSize = [long]$file.Length
    } catch {
      $warnings.Add("length: $($file.FullName): $($_.Exception.Message)")
    }
    $allocatedValue = [long]0
    if ([CodexGrowthResource.Interop]::TryGetStorageBytes($file.FullName, [ref]$allocatedValue)) {
      $allocatedSize = $allocatedValue
    } else {
      $allocationComplete = $false
      $warnings.Add("allocation: $($file.FullName): unavailable")
    }
    if ($null -eq $logicalSize) {
      continue
    }
    $totalBytes += $logicalSize
    if ($null -ne $allocatedSize) {
      $allocatedBytes += $allocatedSize
    }
    if (-not $categoryBytes.Contains($kind)) {
      $categoryBytes[$kind] = [long]0
    }
    $categoryBytes[$kind] = [long]$categoryBytes[$kind] + $logicalSize
    $rows.Add([pscustomobject]@{
      relativePath = [IO.Path]::GetRelativePath($directoryFull, $file.FullName).Replace("\", "/")
      kind = $kind
      bytes = $logicalSize
      allocatedBytes = $allocatedSize
    })
  }
  $complete = $enumerationErrors.Count -eq 0 -and $warnings.Count -eq 0
  return [pscustomobject]@{
    scope = $Scope
    directory = $directoryFull
    status = if ($complete) { "observed" } else { "partial" }
    complete = $complete
    totalBytes = if ($complete) { $totalBytes } else { $null }
    observedBytes = $totalBytes
    allocatedBytes = if ($complete -and $allocationComplete) { $allocatedBytes } else { $null }
    observedAllocatedBytes = if ($allocationComplete) { $allocatedBytes } else { $null }
    fileCount = $rows.Count
    categoryBytes = $categoryBytes
    files = @($rows)
    warnings = @($warnings)
  }
}

function New-DirectorySnapshotPlaceholder {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("state", "temp")][string]$Scope,
    [string]$Directory,
    [Parameter(Mandatory = $true)][string]$Status,
    [string]$Reason
  )
  return [pscustomobject]@{
    scope = $Scope
    directory = $Directory
    status = $Status
    complete = $false
    totalBytes = $null
    observedBytes = $null
    allocatedBytes = $null
    observedAllocatedBytes = $null
    fileCount = $null
    categoryBytes = [ordered]@{}
    files = @()
    warnings = if ([string]::IsNullOrWhiteSpace($Reason)) { @() } else { @($Reason) }
  }
}

function New-DirectoryPeak {
  param([Parameter(Mandatory = $true)][string]$Scope)
  return [pscustomobject]@{
    scope = $Scope
    observed = $false
    totalBytes = [long]0
    allocatedBytes = [long]0
    fileCount = 0
    categories = @{}
  }
}

function Update-DirectoryPeak {
  param(
    [Parameter(Mandatory = $true)]$Peak,
    [Parameter(Mandatory = $true)]$Snapshot
  )
  if ($null -ne $Snapshot.totalBytes) {
    $Peak.observed = $true
    Update-Maximum $Peak "totalBytes" ([long]$Snapshot.totalBytes)
    Update-Maximum $Peak "fileCount" ([long]$Snapshot.fileCount)
  }
  if ($null -ne $Snapshot.allocatedBytes) {
    Update-Maximum $Peak "allocatedBytes" ([long]$Snapshot.allocatedBytes)
  }
  foreach ($kind in $Snapshot.categoryBytes.Keys) {
    if (-not $Peak.categories.ContainsKey([string]$kind)) {
      $Peak.categories[[string]$kind] = [long]0
    }
    if ([long]$Snapshot.categoryBytes[$kind] -gt [long]$Peak.categories[[string]$kind]) {
      $Peak.categories[[string]$kind] = [long]$Snapshot.categoryBytes[$kind]
    }
  }
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
        startTimeUtcTicks = [long]$row.startTimeUtcTicks
        startTimeUtc = $row.startTimeUtc
        firstSeenAt = $At
        lastSeenAt = $At
        samples = 0
        peakWorkingSetBytes = $null
        peakPrivateBytes = $null
        reportedPeakWorkingSetBytes = $null
        peakCpuSeconds = [double]0
        maxLogicalReadBytes = [long]0
        maxLogicalWriteBytes = [long]0
        maxReadOperations = [long]0
        maxWriteOperations = [long]0
        sampledCpuSecondsIncrement = [double]0
        sampledLogicalReadBytesIncrement = [long]0
        sampledLogicalWriteBytesIncrement = [long]0
      }
    }
    $peak = $Peaks[$key]
    $peak.lastSeenAt = $At
    $peak.samples += 1
    foreach ($memoryMetric in @(
      @{ property = "peakWorkingSetBytes"; value = $row.workingSetBytes },
      @{ property = "peakPrivateBytes"; value = $row.privateBytes },
      @{ property = "reportedPeakWorkingSetBytes"; value = $row.reportedPeakWorkingSetBytes }
    )) {
      if (
        $null -ne $memoryMetric.value -and
        ($null -eq $peak.($memoryMetric.property) -or [long]$memoryMetric.value -gt [long]$peak.($memoryMetric.property))
      ) {
        $peak.($memoryMetric.property) = [long]$memoryMetric.value
      }
    }
    if ($row.cpuAvailable -and [double]$row.cpuSeconds -gt $peak.peakCpuSeconds) {
      $peak.peakCpuSeconds = [double]$row.cpuSeconds
    }
    if ($row.ioAvailable) {
      Update-Maximum $peak "maxLogicalReadBytes" ([long]$row.logicalReadBytes)
      Update-Maximum $peak "maxLogicalWriteBytes" ([long]$row.logicalWriteBytes)
      Update-Maximum $peak "maxReadOperations" ([long]$row.readOperations)
      Update-Maximum $peak "maxWriteOperations" ([long]$row.writeOperations)
    }
    if ($null -ne $row.cpuSecondsIncrement) {
      $peak.sampledCpuSecondsIncrement += [double]$row.cpuSecondsIncrement
    }
    if ($null -ne $row.logicalReadBytesIncrement) {
      $peak.sampledLogicalReadBytesIncrement += [long]$row.logicalReadBytesIncrement
    }
    if ($null -ne $row.logicalWriteBytesIncrement) {
      $peak.sampledLogicalWriteBytesIncrement += [long]$row.logicalWriteBytesIncrement
    }
  }
}

function ConvertTo-DirectoryPeakSummary {
  param(
    [Parameter(Mandatory = $true)]$Peak,
    [Parameter(Mandatory = $true)]$Latest
  )
  $categoryPeak = [ordered]@{}
  foreach ($kind in @($Peak.categories.Keys | Sort-Object)) {
    $categoryPeak[$kind] = $Peak.categories[$kind]
  }
  return [ordered]@{
    directory = $Latest.directory
    latestStatus = $Latest.status
    latestComplete = $Latest.complete
    latestBytes = $Latest.totalBytes
    latestObservedBytes = $Latest.observedBytes
    latestAllocatedBytes = $Latest.allocatedBytes
    latestObservedAllocatedBytes = $Latest.observedAllocatedBytes
    latestFileCount = $Latest.fileCount
    peakTotalBytes = if ($Peak.observed) { $Peak.totalBytes } else { $null }
    peakAllocatedBytes = if ($Peak.observed -and $Peak.allocatedBytes -ge 0) { $Peak.allocatedBytes } else { $null }
    peakFileCount = if ($Peak.observed) { $Peak.fileCount } else { $null }
    peakCategoryBytes = $categoryPeak
    latestWarnings = @($Latest.warnings)
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

function Invoke-B2AttributionSampler {
  param(
    [Parameter(Mandatory = $true)][string]$ResultDirectory,
    [Parameter(Mandatory = $true)][int]$ServiceTreePid,
    [Parameter(Mandatory = $true)][int]$BrowserRunnerPid,
    [Parameter(Mandatory = $true)][string]$StopMarker,
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [string]$TemporaryDirectory,
    [ValidateSet(250, 500)]
    [int]$SampleIntervalMilliseconds = 500,
    [int]$CimRefreshMilliseconds = 3000,
    [int]$MaxSamples = 0
  )

  $null = New-Item -ItemType Directory -Path $ResultDirectory -Force
  $resultDirectory = [IO.Path]::GetFullPath($ResultDirectory)
  $stateDirectory = [IO.Path]::GetFullPath($StateDirectory)
  $temporaryDirectory = if ([string]::IsNullOrWhiteSpace($TemporaryDirectory)) {
    $null
  } else {
    [IO.Path]::GetFullPath($TemporaryDirectory)
  }
  $samplesPath = Join-Path $resultDirectory "resources.ndjson"
  $summaryPath = Join-Path $resultDirectory "resources.json"
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
  $previousCounters = @{}
  $filePeaks = @{}
  $statePeak = New-DirectoryPeak "state"
  $tempPeak = New-DirectoryPeak "temp"
  $latestStateSnapshot = New-DirectorySnapshotPlaceholder `
    -Scope "state" `
    -Directory $stateDirectory `
    -Status "not-sampled"
  $latestTempSnapshot = if ($null -eq $temporaryDirectory) {
    New-DirectorySnapshotPlaceholder `
      -Scope "temp" `
      -Status "not-configured" `
      -Reason "TempDir was not provided; anonymous temporary files were not observable"
  } else {
    New-DirectorySnapshotPlaceholder `
      -Scope "temp" `
      -Directory $temporaryDirectory `
      -Status "not-sampled"
  }
  $initialProcessMap = Get-LiveProcessMap
  $serviceRootProcess = $initialProcessMap[[string]$ServiceTreePid]
  $runnerRootProcess = $initialProcessMap[[string]$BrowserRunnerPid]
  $serviceRootStartTicks = if ($null -ne $serviceRootProcess) { Get-ProcessStartTicks $serviceRootProcess } else { [long]0 }
  $runnerRootStartTicks = if ($null -ne $runnerRootProcess) { Get-ProcessStartTicks $runnerRootProcess } else { [long]0 }
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
      $scopeIds = Get-ProcessScopeIds `
        -ServiceRootPid $ServiceTreePid `
        -RunnerRootPid $BrowserRunnerPid `
        -ObserverPid $PID `
        -Parents $treeMetadata.Parents
      $serviceIds = $scopeIds.service
      $browserIds = $scopeIds.browser

      $rows = @(Get-ProcessRows `
        -ProcessMap $processMap `
        -ServiceIds $serviceIds `
        -BrowserIds $browserIds `
        -RunnerPid $BrowserRunnerPid `
        -ObserverPid $PID `
        -Parents $treeMetadata.Parents `
        -Names $treeMetadata.Names `
        -PreviousCounters $previousCounters)
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
        if ($scope.value.cpuAvailableProcessCount -gt 0 -and [double]$scope.value.cpuSeconds -gt $peak.cpuSeconds) {
          $peak.cpuSeconds = [double]$scope.value.cpuSeconds
        }
        if ($null -ne $scope.value.cpuSecondsIncrement) {
          $peak.cpuSecondsIncrementObserved += [double]$scope.value.cpuSecondsIncrement
        }
        if ($null -ne $scope.value.logicalReadBytesIncrement) {
          $peak.logicalReadBytesIncrementObserved += [long]$scope.value.logicalReadBytesIncrement
        }
        if ($null -ne $scope.value.logicalWriteBytesIncrement) {
          $peak.logicalWriteBytesIncrementObserved += [long]$scope.value.logicalWriteBytesIncrement
        }
      }

      $at = $now.ToString("O")
      Update-ProcessPeaks -Peaks $processPeaks -Rows $rows -At $at
      $latestStateSnapshot = Get-AttributionTargetSnapshot `
        -Directory $stateDirectory `
        -Scope "state" `
        -ResultDirectory $resultDirectory
      Update-DirectoryPeak -Peak $statePeak -Snapshot $latestStateSnapshot
      $latestTempSnapshot = if ($null -eq $temporaryDirectory) {
        New-DirectorySnapshotPlaceholder `
          -Scope "temp" `
          -Status "not-configured" `
          -Reason "TempDir was not provided; anonymous temporary files were not observable"
      } else {
        Get-AttributionTargetSnapshot `
          -Directory $temporaryDirectory `
          -Scope "temp" `
          -ResultDirectory $resultDirectory
      }
      Update-DirectoryPeak -Peak $tempPeak -Snapshot $latestTempSnapshot
      foreach ($snapshot in @($latestStateSnapshot, $latestTempSnapshot)) {
        foreach ($file in $snapshot.files) {
          $fileKey = "$($snapshot.scope):$($file.relativePath)"
          if (-not $filePeaks.ContainsKey($fileKey)) {
            $filePeaks[$fileKey] = [pscustomobject]@{
              scope = $snapshot.scope
              directory = $snapshot.directory
              relativePath = $file.relativePath
              kind = $file.kind
              peakBytes = [long]0
              peakAllocatedBytes = $null
            }
          }
          Update-Maximum $filePeaks[$fileKey] "peakBytes" ([long]$file.bytes)
          if ($null -ne $file.allocatedBytes) {
            if (
              $null -eq $filePeaks[$fileKey].peakAllocatedBytes -or
              [long]$file.allocatedBytes -gt [long]$filePeaks[$fileKey].peakAllocatedBytes
            ) {
              $filePeaks[$fileKey].peakAllocatedBytes = [long]$file.allocatedBytes
            }
          }
        }
      }

      $sample = [ordered]@{
        schemaVersion = "b2-attribution-resource-sample.v1"
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
          serviceRootStartTimeUtcTicks = $serviceRootStartTicks
          runnerRootStartTimeUtcTicks = $runnerRootStartTicks
        }
        stateDir = $stateDirectory
        tempDir = $temporaryDirectory
        service = $serviceMeasure
        browser = $browserMeasure
        runner = $runnerMeasure
        observer = $observerMeasure
        state = $latestStateSnapshot
        temp = $latestTempSnapshot
        sqlite = $latestStateSnapshot
        processes = $rows
        metricNotes = [ordered]@{
          cpu = "cpuSeconds is cumulative; cpuSecondsIncrement is the observed delta from the previous sample of the same process identity"
          logicalIo = "logical cumulative transfer bytes from GetProcessIoCounters; increments are observed deltas, not physical disk I/O"
          disk = "bytes are file lengths; legacy allocatedBytes is GetCompressedFileSize storage bytes, equal to length for ordinary uncompressed/non-sparse files, not cluster allocation"
          temp = "when temp.status is not observed, null is an unobserved value rather than zero"
        }
        ioMetricNote = "logical transfer bytes and increments from GetProcessIoCounters; not physical disk I/O"
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
        -not (Test-RootIdentityAlive $ServiceTreePid $serviceRootStartTicks $processMap) -and
        -not (Test-RootIdentityAlive $BrowserRunnerPid $runnerRootStartTicks $processMap)
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
    $stateSummary = ConvertTo-DirectoryPeakSummary -Peak $statePeak -Latest $latestStateSnapshot
    $tempSummary = ConvertTo-DirectoryPeakSummary -Peak $tempPeak -Latest $latestTempSnapshot
    foreach ($snapshot in @($latestStateSnapshot, $latestTempSnapshot)) {
      if ($null -eq $snapshot) {
        continue
      }
      foreach ($warning in $snapshot.warnings) {
        $prefixed = "$($snapshot.scope): $warning"
        if (-not $warnings.Contains($prefixed)) {
          $warnings.Add($prefixed)
        }
      }
    }
    $stateFilePeaks = @(
      $filePeaks.Values |
        Where-Object { $_.scope -eq "state" } |
        Sort-Object relativePath
    )
    $tempFilePeaks = @(
      $filePeaks.Values |
        Where-Object { $_.scope -eq "temp" } |
        Sort-Object relativePath
    )
    $summary = [ordered]@{
      schemaVersion = "b2-attribution-resource-sampler.v1"
      startedAt = $startedAt.ToString("O")
      endedAt = $endedAt.ToString("O")
      wallMilliseconds = $stopwatch.ElapsedMilliseconds
      sampleIntervalMilliseconds = $SampleIntervalMilliseconds
      cimRefreshMilliseconds = $CimRefreshMilliseconds
      sampleCount = $sampleCount
      stopReason = $stopReason
      samplesFile = $samplesPath
      summaryFile = $summaryPath
      tree = [ordered]@{
        serviceRootPid = $ServiceTreePid
        serviceRootStartTimeUtcTicks = $serviceRootStartTicks
        runnerRootPid = $BrowserRunnerPid
        runnerRootStartTimeUtcTicks = $runnerRootStartTicks
        observerPid = $PID
      }
      metricDefinitions = [ordered]@{
        workingSet = "Get-Process WorkingSet64, sampled current RSS"
        privateBytes = "Get-Process PrivateMemorySize64, sampled current private bytes"
        reportedPeakWorkingSet = "Get-Process PeakWorkingSet64, process-lifetime peak reported by Windows"
        cpuSeconds = "Get-Process CPU, cumulative processor-time seconds; can exceed wall seconds across cores"
        cpuSecondsIncrement = "Observed delta between consecutive samples of the same pid and process creation time"
        logicalIo = "GetProcessIoCounters transfer bytes and operation counts; logical I/O, not physical disk I/O"
        logicalIoIncrement = "Observed transfer-byte delta between consecutive samples of the same pid and process creation time"
        stateFiles = "Recursive sqlite/db/wal/shm/journal files under the explicit StateDir"
        tempFiles = "Recursive sqlite/db/wal/shm/journal and SQLite etilqs_* files under optional TempDir"
        fileBytes = "File length; legacy allocatedBytes is GetCompressedFileSize storage bytes, not a cluster-allocation measurement"
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
        sampledCpuSecondsIncrement = $scopePeaks.observer.cpuSecondsIncrementObserved
        sampledLogicalReadBytesIncrement = $scopePeaks.observer.logicalReadBytesIncrementObserved
        sampledLogicalWriteBytesIncrement = $scopePeaks.observer.logicalWriteBytesIncrementObserved
      }
      state = $stateSummary
      temp = $tempSummary
      stateFiles = $stateFilePeaks
      tempFiles = $tempFilePeaks
      sqlite = [ordered]@{
        peakTotalBytes = $stateSummary.peakTotalBytes
        files = @($stateFilePeaks)
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
  ) ("b2-attribution-resource-{0}" -f [Guid]::NewGuid().ToString("N"))
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $selfTestFull = [IO.Path]::GetFullPath($selfTestRoot)
  if (-not $selfTestFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Self-test path escaped the temporary directory"
  }

  try {
    $syntheticParents = @{
      "1" = 0
      "101" = 1
      "102" = 101
      "103" = 101
      "104" = 101
      "105" = 104
      "106" = 105
      "107" = 1
    }
    $syntheticParents["105"] = 1
    $scopes = Get-ProcessScopeIds `
      -ServiceRootPid 101 `
      -RunnerRootPid 1 `
      -ObserverPid 107 `
      -Parents $syntheticParents
    $syntheticService = @($scopes.service | Sort-Object)
    $syntheticBrowser = @($scopes.browser | Sort-Object)
    if (
      ($syntheticService -join ",") -ne "101,102,103,104" -or
      ($syntheticBrowser -join ",") -ne "105,106" -or
      $scopes.runner -ne 1 -or
      $scopes.observer -ne 107
    ) {
      throw "Self-test process-tree classification failed"
    }

    $stateDirectory = Join-Path $selfTestRoot "state"
    $temporaryDirectory = Join-Path $selfTestRoot "temp"
    $null = New-Item -ItemType Directory -Path $stateDirectory -Force
    $null = New-Item -ItemType Directory -Path $temporaryDirectory -Force
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

    [IO.File]::WriteAllBytes((Join-Path $stateDirectory "live.sqlite"), [byte[]](0..63))
    [IO.File]::WriteAllBytes((Join-Path $stateDirectory "live.sqlite-wal"), [byte[]](0..127))
    [IO.File]::WriteAllBytes((Join-Path $stateDirectory "live.sqlite-shm"), [byte[]](0..31))
    [IO.File]::WriteAllBytes((Join-Path $stateDirectory "old.db"), [byte[]](0..47))
    [IO.File]::WriteAllBytes((Join-Path $stateDirectory "old.db-wal"), [byte[]](0..15))
    [IO.File]::WriteAllText((Join-Path $stateDirectory "ignore.txt"), "not a sqlite artifact")
    [IO.File]::WriteAllBytes((Join-Path $temporaryDirectory "etilqs_self"), [byte[]](0..255))
    [IO.File]::WriteAllBytes((Join-Path $temporaryDirectory "scratch.db"), [byte[]](0..127))
    [IO.File]::WriteAllText((Join-Path $temporaryDirectory "ignore.tmp"), "not a sqlite artifact")

    $stateSnapshot = Get-AttributionTargetSnapshot `
      -Directory $stateDirectory `
      -Scope "state" `
      -ResultDirectory $selfTestRoot
    $tempSnapshot = Get-AttributionTargetSnapshot `
      -Directory $temporaryDirectory `
      -Scope "temp" `
      -ResultDirectory $selfTestRoot
    if (
      $stateSnapshot.status -ne "observed" -or
      $stateSnapshot.totalBytes -ne 288 -or
      $stateSnapshot.fileCount -ne 5 -or
      $stateSnapshot.categoryBytes.database -ne 112 -or
      $stateSnapshot.categoryBytes.wal -ne 144 -or
      $stateSnapshot.categoryBytes.shm -ne 32
    ) {
      throw "Self-test state directory size or classification is incorrect"
    }
    if (
      $tempSnapshot.status -ne "observed" -or
      $tempSnapshot.totalBytes -ne 384 -or
      $tempSnapshot.fileCount -ne 2 -or
      $tempSnapshot.categoryBytes.database -ne 128 -or
      $tempSnapshot.categoryBytes.anonymousTemp -ne 256
    ) {
      throw "Self-test temporary directory size or classification is incorrect"
    }
    $missingSnapshot = Get-AttributionTargetSnapshot `
      -Directory (Join-Path $selfTestRoot "missing-temp") `
      -Scope "temp" `
      -ResultDirectory $selfTestRoot
    if ($null -ne $missingSnapshot.totalBytes -or $missingSnapshot.status -ne "missing") {
      throw "Self-test represented an unobservable temporary directory as zero"
    }
    $notConfiguredSnapshot = New-DirectorySnapshotPlaceholder `
      -Scope "temp" `
      -Status "not-configured" `
      -Reason "not requested"
    if ($null -ne $notConfiguredSnapshot.totalBytes -or $notConfiguredSnapshot.status -ne "not-configured") {
      throw "Self-test represented an unconfigured temporary directory as zero"
    }

    $highWater = New-DirectoryPeak "state"
    Update-DirectoryPeak -Peak $highWater -Snapshot $stateSnapshot
    [IO.File]::WriteAllBytes((Join-Path $stateDirectory "old.db"), [byte[]](0..159))
    $grownStateSnapshot = Get-AttributionTargetSnapshot `
      -Directory $stateDirectory `
      -Scope "state" `
      -ResultDirectory $selfTestRoot
    Update-DirectoryPeak -Peak $highWater -Snapshot $grownStateSnapshot
    if ($grownStateSnapshot.totalBytes -ne 400 -or $highWater.totalBytes -ne 400) {
      throw "Self-test state size high-water is incorrect"
    }

    $stopMarker = Join-Path $selfTestRoot "stop"

    $summary = Invoke-B2AttributionSampler `
      -ResultDirectory $selfTestRoot `
      -ServiceTreePid $PID `
      -BrowserRunnerPid $PID `
      -StopMarker $stopMarker `
      -StateDirectory $stateDirectory `
      -TemporaryDirectory $temporaryDirectory `
      -SampleIntervalMilliseconds 250 `
      -CimRefreshMilliseconds 1000 `
      -MaxSamples 2

    $samplesPath = Join-Path $selfTestRoot "resources.ndjson"
    $summaryPath = Join-Path $selfTestRoot "resources.json"
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
    if (
      $samples[1].observer.cpuSecondsIncrement -eq $null -or
      $samples[1].observer.logicalReadBytesIncrement -eq $null -or
      $samples[1].observer.logicalWriteBytesIncrement -eq $null
    ) {
      throw "Self-test process CPU or logical I/O increments are missing"
    }
    if (
      $writtenSummary.state.peakTotalBytes -ne 400 -or
      $writtenSummary.temp.peakTotalBytes -ne 384 -or
      $writtenSummary.state.peakCategoryBytes.database -ne 224 -or
      $writtenSummary.temp.peakCategoryBytes.anonymousTemp -ne 256 -or
      $null -eq $writtenSummary.tree.serviceRootStartTimeUtcTicks -or
      $writtenSummary.tree.serviceRootStartTimeUtcTicks -le 0
    ) {
      throw "Self-test directory, process identity, or high-water summary is incorrect"
    }
    [pscustomobject]@{
      ok = $true
      samples = $samples.Count
      summary = $writtenSummary.schemaVersion
      observerCpuSeconds = $writtenSummary.observer.cpuSecondsUsed
      statePeakBytes = $writtenSummary.state.peakTotalBytes
      tempPeakBytes = $writtenSummary.temp.peakTotalBytes
      serviceCount = $syntheticService.Count
      browserCount = $syntheticBrowser.Count
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

if (
  [string]::IsNullOrWhiteSpace($ResultDir) -or
  [string]::IsNullOrWhiteSpace($StopFile) -or
  [string]::IsNullOrWhiteSpace($StateDir)
) {
  throw "ResultDir, StopFile, and StateDir must be non-empty"
}
if ($ServicePid -le 0 -or $RunnerPid -le 0) {
  throw "ServicePid and RunnerPid must be positive"
}
$initialProcesses = Get-LiveProcessMap
if (-not $initialProcesses.ContainsKey([string]$ServicePid)) {
  throw "ServicePid $ServicePid is not running"
}
if (-not $initialProcesses.ContainsKey([string]$RunnerPid)) {
  throw "RunnerPid $RunnerPid is not running"
}
if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) {
  throw "StateDir does not exist: $StateDir"
}
if (-not [string]::IsNullOrWhiteSpace($TempDir) -and -not (Test-Path -LiteralPath $TempDir -PathType Container)) {
  throw "TempDir does not exist: $TempDir"
}
$resultDirectory = [IO.Path]::GetFullPath($ResultDir)
$stopPath = [IO.Path]::GetFullPath($StopFile)
$stateDirectory = [IO.Path]::GetFullPath($StateDir)
$temporaryDirectory = if ([string]::IsNullOrWhiteSpace($TempDir)) { $null } else { [IO.Path]::GetFullPath($TempDir) }
$null = Invoke-B2AttributionSampler `
  -ResultDirectory $resultDirectory `
  -ServiceTreePid $ServicePid `
  -BrowserRunnerPid $RunnerPid `
  -StopMarker $stopPath `
  -StateDirectory $stateDirectory `
  -TemporaryDirectory $temporaryDirectory `
  -SampleIntervalMilliseconds $SampleIntervalMilliseconds
