[CmdletBinding()]
param(
  [string]$ResultDir,[int]$ServicePid,[int]$RunnerPid,[string]$StopFile,[string]$StateDir,[string]$TempDir,
  [ValidateSet(250,500)][int]$SampleIntervalMilliseconds=250,[switch]$SelfTest
)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major-lt7){throw 'Use pwsh 7.'}
if(-not ('WindowsStabilityResource.Snapshot' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace WindowsStabilityResource {
  public sealed class ProcessSnapshot {
    public int Id, ParentProcessId;
    public string ProcessName, ObservedAt;
    public DateTime StartTime;
    public long CreationFileTime, WorkingSet64, PrivateMemorySize64, PeakWorkingSet64, HandleCount;
    public double CPU;
    public long ReadOperationCount, WriteOperationCount, ReadTransferCount, WriteTransferCount;
  }

  public static class Snapshot {
    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString {
      public ushort Length, MaximumLength;
      public IntPtr Buffer;
    }

    // https://github.com/golang/sys/blob/master/windows/types_windows.go (SYSTEM_PROCESS_INFORMATION)
    // https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
      public uint NextEntryOffset, NumberOfThreads;
      public long WorkingSetPrivateSize;
      public uint HardFaultCount, NumberOfThreadsHighWatermark;
      public ulong CycleTime;
      public long CreateTime, UserTime, KernelTime;
      public UnicodeString ImageName;
      public int BasePriority;
      public IntPtr UniqueProcessId, InheritedFromUniqueProcessId;
      public uint HandleCount, SessionId;
      public UIntPtr UniqueProcessKey, PeakVirtualSize, VirtualSize;
      public uint PageFaultCount;
      public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
      public UIntPtr QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivatePageCount;
      public long ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public long ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQuerySystemInformation(int informationClass, IntPtr buffer, int length, out int required);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);

    static Snapshot() {
      if (RuntimeInformation.ProcessArchitecture != Architecture.X64 || Marshal.SizeOf<ProcessInfo>() != 256 ||
          Marshal.OffsetOf<ProcessInfo>("CreateTime").ToInt32() != 32 ||
          Marshal.OffsetOf<ProcessInfo>("UniqueProcessId").ToInt32() != 80 ||
          Marshal.OffsetOf<ProcessInfo>("WorkingSetSize").ToInt32() != 144 ||
          Marshal.OffsetOf<ProcessInfo>("ReadTransferCount").ToInt32() != 232)
        throw new PlatformNotSupportedException("Uncalibrated SYSTEM_PROCESS_INFORMATION layout");
    }

    public static string Confirm(ProcessSnapshot row) {
      if (row.CreationFileTime <= 0) return "missing";
      IntPtr handle = OpenProcess(0x1000, false, row.Id);
      if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "exited" : "missing";
      try {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return "missing";
        if (creation != row.CreationFileTime) return "pid-reused";
        return exit == 0 ? "live" : "exited";
      } finally { CloseHandle(handle); }
    }

    public static ProcessSnapshot[] Capture() {
      int size = 65536;
      for (;;) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          int required;
          int status = NtQuerySystemInformation(5, buffer, size, out required);
          if (status == unchecked((int)0xC0000004)) {
            size = Math.Max(size * 2, required);
            continue;
          }
          if (status < 0) throw new InvalidOperationException("Process snapshot failed: NTSTATUS " + status.ToString("X8"));
          var rows = new List<ProcessSnapshot>();
          string at = DateTime.UtcNow.ToString("O");
          IntPtr cursor = buffer;
          for (;;) {
            long offset = cursor.ToInt64() - buffer.ToInt64();
            if (required > size || offset < 0 || offset > required - 256)
              throw new InvalidOperationException("Unrecognized native process record bounds");
            var row = Marshal.PtrToStructure<ProcessInfo>(cursor);
            long nameOffset = row.ImageName.Buffer.ToInt64() - buffer.ToInt64();
            if ((row.NextEntryOffset != 0 && row.NextEntryOffset < 256) ||
                (row.ImageName.Length > 0 && (row.ImageName.Length % 2 != 0 || row.ImageName.Length > row.ImageName.MaximumLength ||
                  nameOffset < 0 || nameOffset > required - row.ImageName.Length)))
              throw new InvalidOperationException("Unrecognized native process record layout");
            rows.Add(new ProcessSnapshot {
              Id = row.UniqueProcessId.ToInt32(), ParentProcessId = row.InheritedFromUniqueProcessId.ToInt32(),
              ProcessName = row.ImageName.Buffer == IntPtr.Zero ? "unknown" : Marshal.PtrToStringUni(row.ImageName.Buffer, row.ImageName.Length / 2),
              ObservedAt = at, CreationFileTime = row.CreateTime,
              StartTime = row.CreateTime > 0 ? DateTime.FromFileTimeUtc(row.CreateTime) : DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc),
              WorkingSet64 = (long)row.WorkingSetSize.ToUInt64(), PrivateMemorySize64 = (long)row.PrivatePageCount.ToUInt64(),
              PeakWorkingSet64 = (long)row.PeakWorkingSetSize.ToUInt64(), HandleCount = row.HandleCount,
              CPU = (row.UserTime + row.KernelTime) / (double)TimeSpan.TicksPerSecond,
              ReadOperationCount = row.ReadOperationCount, WriteOperationCount = row.WriteOperationCount,
              ReadTransferCount = row.ReadTransferCount, WriteTransferCount = row.WriteTransferCount
            });
            if (row.NextEntryOffset == 0) {
              if (!rows.Exists(process => process.Id == Environment.ProcessId && Confirm(process) == "live"))
                throw new InvalidOperationException("Native snapshot identity/layout verification failed");
              return rows.ToArray();
            }
            cursor = IntPtr.Add(cursor, checked((int)row.NextEntryOffset));
          }
        } finally {
          Marshal.FreeHGlobal(buffer);
        }
      }
    }
  }
}
'@
}

function Set-ResourceBinding {
  param([string]$Source,[string]$Before,[string]$After)
  if(($Source.Split($Before).Count)-ne2){throw "Resource binding changed: $Before"}
  return $Source.Replace($Before,$After)
}

function Get-WindowsResourceProcessState($Process) {
  return [WindowsStabilityResource.Snapshot]::Confirm($Process)
}

function New-ResourceIdentityEvidence($Process,[long]$Ticks) {
  return [ordered]@{
    source=if($Ticks-gt0){'NtQuerySystemInformation/SystemProcessInformation'}else{'missing'}
    precision=if($Ticks-gt0){'100ns'}else{$null}
    snapshotSource='NtQuerySystemInformation/SystemProcessInformation'
    observedAt=$Process.ObservedAt
    pid=$Process.Id
    creationFileTime=[string]$Process.CreationFileTime
    startTimeUtcTicks=if($Ticks-gt0){[string]$Ticks}else{$null}
  }
}

$source=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'b2-attribution-resource.ps1') -Raw).Replace("`r`n","`n")
$source=Set-ResourceBinding $source '  $processes = @(Get-Process -ErrorAction SilentlyContinue)' @'
  $processes = [WindowsStabilityResource.Snapshot]::Capture()
'@
$source=Set-ResourceBinding $source '    [Parameter(Mandatory = $true)][hashtable]$PreviousCounters' @'
    [Parameter(Mandatory = $true)][hashtable]$PreviousCounters,
    [Collections.Generic.List[object]]$Tombstones = [Collections.Generic.List[object]]::new()
'@
$source=Set-ResourceBinding $source '    $cpuSeconds = $null' @'
    $processState = Get-WindowsResourceProcessState $process
    if ($processState -in @('exited','pid-reused')) {
      $Tombstones.Add([pscustomobject][ordered]@{
        status='tombstone'; reason=$processState; pid=$id; role=$role; name=$process.ProcessName
        confirmedAt=[DateTime]::UtcNow.ToString('O')
        confirmationSource='OpenProcess/GetProcessTimes'
        identityEvidence=(New-ResourceIdentityEvidence $process $startTicks)
        resourceSnapshot=[ordered]@{
          startTimeUtc=if($startTicks-gt0){[DateTime]::new($startTicks,[DateTimeKind]::Utc).ToString('O')}else{$null}
          workingSetBytes=[long]$process.WorkingSet64
          reportedPeakWorkingSetBytes=[long]$process.PeakWorkingSet64
          cpuSeconds=[double]$process.CPU
          logicalReadBytes=[long]$process.ReadTransferCount
          logicalWriteBytes=[long]$process.WriteTransferCount
        }
      })
      continue
    }
    if ($processState -ne 'live') { $startTicks = [long]0 }
    $cpuSeconds = $null
'@
$source=Set-ResourceBinding $source @'
    $io = [CodexGrowthResource.IoCounters]::new()
    $ioAvailable = [CodexGrowthResource.Interop]::TryGetIoCounters($id, [ref]$io)
'@ @'
    $io = $process
    $ioAvailable = $true
'@
$source=Set-ResourceBinding $source @'
    $parentPid = if ($Parents.ContainsKey([string]$id)) { [int]$Parents[[string]$id] } else { 0 }
    $name = if ($Names.ContainsKey([string]$id)) {
      [string]$Names[[string]$id]
    } else {
      try { [string]$process.ProcessName } catch { "unknown" }
    }
'@ @'
    $parentPid = $process.ParentProcessId
    $name = $process.ProcessName
'@
$source=Set-ResourceBinding $source '      $processMap = Get-LiveProcessMap' @'
      $processMap = Get-LiveProcessMap
      $sampleTombstones = [Collections.Generic.List[object]]::new()
      $snapshotParents = @{}
      foreach ($process in $processMap.Values) {
        $snapshotParents[[string]$process.Id] = $process.ParentProcessId
      }
'@
$source=Set-ResourceBinding $source '  $previousCounters = @{}' @'
  $previousCounters = @{}
  $allTombstones = [Collections.Generic.List[object]]::new()
'@
$source=Set-ResourceBinding $source '-PreviousCounters $previousCounters)' '-PreviousCounters $previousCounters -Tombstones $sampleTombstones)'
$source=Set-ResourceBinding $source '      $serviceRows = @($rows | Where-Object { $_.role -eq "service" })' @'
      $allTombstones.AddRange($sampleTombstones)
      $serviceRows = @($rows | Where-Object { $_.role -eq "service" })
'@
# CIM remains a periodic audit; tree membership and identities use the current native snapshot.
if(($source.Split('-Parents $treeMetadata.Parents').Count)-ne3){throw 'Resource tree bindings changed.'}
$source=$source.Replace('-Parents $treeMetadata.Parents','-Parents $snapshotParents')
$source=Set-ResourceBinding $source '    $rows.Add([pscustomobject][ordered]@{' @'
    $handleCount=$null
    try{$handleCount=[long]$process.HandleCount}catch{}
    $rows.Add([pscustomobject][ordered]@{
      handleCount=$handleCount
      liveness=$processState
      identityEvidence=(New-ResourceIdentityEvidence $process $startTicks)
'@
$source=Set-ResourceBinding $source '        processes = $rows' @'
        processes = $rows
        tombstones = @($sampleTombstones)
'@
$source=Set-ResourceBinding $source '      processes = @($processPeaks.Values | Sort-Object firstSeenAt, pid)' @'
      processes = @($processPeaks.Values | Sort-Object firstSeenAt, pid)
      tombstones = @($allTombstones)
'@
$source=Set-ResourceBinding $source '        startTimeUtc = $row.startTimeUtc' @'
        startTimeUtc = $row.startTimeUtc
        identityEvidence = $row.identityEvidence
'@
$source=Set-ResourceBinding $source '          cimProcessRecords = $treeMetadata.CimRecords' @'
          cimProcessRecords = $treeMetadata.CimRecords
          processTreeSource = "NtQuerySystemInformation/SystemProcessInformation"
          processSnapshotAt = $processMap[[string]$PID].ObservedAt
          processSnapshotRecords = $processMap.Count
'@
$source=$source.Replace('Get-Process WorkingSet64','SystemProcessInformation.WorkingSetSize')
$source=$source.Replace('Get-Process PrivateMemorySize64','SystemProcessInformation.PrivatePageCount')
$source=$source.Replace('Get-Process PeakWorkingSet64','SystemProcessInformation.PeakWorkingSetSize')
$source=$source.Replace('Get-Process CPU','SystemProcessInformation UserTime + KernelTime')
$source=$source.Replace('GetProcessIoCounters transfer','SystemProcessInformation I/O transfer')
$source=$source.Replace('from GetProcessIoCounters','from SystemProcessInformation')
& ([scriptblock]::Create($source)) @PSBoundParameters
