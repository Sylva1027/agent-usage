import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { correctResourceIdentity, parseResourceSample, resourceSnapshotRows } from "./resource-identity-analysis.mjs";
import { analyzeWindowsStability as oldAnalyze } from "./windows-stability-analyze.mjs";
import { instrumentMemory } from "./windows-memory-lifetime-hook.mjs";

const wrapper = fileURLToPath(new URL("./windows-stability-resource.ps1", import.meta.url));

test("memory diagnostic keeps scope close pending until the last active member finishes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "windows-memory-scope-"));
  try {
    const hook = new URL("./windows-memory-lifetime-hook.mjs", import.meta.url).href;
    const source = new URL("../../src/history-backup.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", hook, "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const {createHistoryVerificationScope}=await import(${JSON.stringify(source)});
      const scope=createHistoryVerificationScope();let release,closed=false;
      const work=scope.run(()=>new Promise(resolve=>release=resolve));
      const closing=scope.close().then(()=>closed=true);
      await Promise.resolve();assert.equal(closed,false);
      release();await work;await closing;assert.equal(closed,true);
    `], { encoding: "utf8", windowsHide: true, timeout: 5000,
      env: { ...process.env, WINDOWS_MEMORY_DIAGNOSTIC_DIR: directory } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(path.join(directory, `memory-${result.pid}.ndjson`), "utf8").trim().split("\n").map(JSON.parse);
    const scope = rows.filter(row => row.event.startsWith("scope-"));
    assert.deepEqual(scope.map(row => row.event), ["scope-open", "scope-close-requested", "scope-released"]);
    assert.equal(new Set(scope.map(row => row.scopeId)).size, 1);
    assert.equal(scope[1].active, 1);
    assert.equal(scope[2].readers, 0);
    for (const row of rows) for (const field of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) assert.ok(Number.isFinite(row.memory[field]));
    assert.equal(rows.at(-1).event, "process-exit");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("memory diagnostic changes only known scope anchors and rejects drift", () => {
  const url = new URL("../../src/history-backup.js", import.meta.url), source = readFileSync(url, "utf8").replaceAll("\r\n", "\n");
  assert.equal(instrumentMemory("file:///unrelated.mjs", source), source);
  const instrumented = instrumentMemory(url.href, source);
  for (const event of ["scope-open", "scope-close-requested", "scope-released"]) assert.ok(instrumented.includes(event));
  assert.throws(() => instrumentMemory(url.href, source.replace("  let resolveClose;", "")), /Memory diagnostic anchor changed/);
});

test("memory diagnostic reaches the isolated server when the runner removes NODE_OPTIONS", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "windows-memory-launch-"));
  try {
    const hook = new URL("./windows-memory-lifetime-hook.mjs", import.meta.url).href;
    const fixture = path.join(directory, "windows-stability-server.mjs");
    writeFileSync(fixture, "console.log(JSON.stringify({pid:process.pid,execArgv:process.execArgv}));");
    const result = spawnSync(process.execPath, ["--import", hook, "--input-type=module", "-e", `
      import {spawn} from 'node:child_process';
      const env={...process.env};delete env.NODE_OPTIONS;
      const child=spawn(process.execPath,[${JSON.stringify(fixture)}],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
      process.exitCode=await new Promise(resolve=>child.once('exit',resolve));
    `], { encoding: "utf8", windowsHide: true, timeout: 5000,
      env: { ...process.env, WINDOWS_MEMORY_DIAGNOSTIC_DIR: directory } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(result.stdout);
    assert.deepEqual(child.execArgv, ["--import", hook]);
    const rows = readFileSync(path.join(directory, `memory-${child.pid}.ndjson`), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows[0].role, "gateway");
    assert.equal(rows.at(-1).event, "process-exit");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows resource identity calibration (pwsh 7, tiny processes only)", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "windows-stability-resource-"));
  try {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
$legacy = . $env:WINDOWS_RESOURCE_WRAPPER -SelfTest | ConvertFrom-Json
# Load the bound sampler functions, without its CLI entry point or another sampler run.
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($statement.Extent.Text))
  }
}
$observerCpuStart = [Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalSeconds
$nativeType = [WindowsStabilityResource.Snapshot].GetNestedType('ProcessInfo', [Reflection.BindingFlags]::NonPublic)
$offsets = @{}
foreach ($field in @('CreateTime','UniqueProcessId','WorkingSetSize','ReadTransferCount')) {
  $offsets[$field] = [Runtime.InteropServices.Marshal]::OffsetOf($nativeType, $field).ToInt32()
}
$layout = @{ architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString(); size=[Runtime.InteropServices.Marshal]::SizeOf([type]$nativeType); offsets=$offsets }
$wrapperAst = [Management.Automation.Language.Parser]::ParseFile($env:WINDOWS_RESOURCE_WRAPPER, [ref]$null, [ref]$null)
$nativeSource = $wrapperAst.Find({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.StartsWith('using System;') }, $true).Value
$unknownLayout = $nativeSource.Replace('namespace WindowsStabilityResource {', 'namespace WindowsStabilityResourceBadLayout {').Replace('public long CreateTime,', 'public long UnknownLayoutPadding; public long CreateTime,')
Add-Type -TypeDefinition $unknownLayout
$layoutRejection = $null
try { $null = [WindowsStabilityResourceBadLayout.Snapshot]::Capture() } catch { $layoutRejection = $_.Exception.GetBaseException().Message }
Assert ($layoutRejection -eq 'Uncalibrated SYSTEM_PROCESS_INFORMATION layout') 'Unknown native layout did not fail before sampling'

function Start-TinyProcess {
  $info = [Diagnostics.ProcessStartInfo]::new($env:WINDOWS_RESOURCE_NODE)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.ArgumentList.Add('-e')
  $info.ArgumentList.Add('process.stdin.resume(); console.log("ready")')
  $child = [Diagnostics.Process]::Start($info)
  try {
    Assert ($child.StandardOutput.ReadLine() -eq 'ready') 'Tiny child did not initialize'
    return $child
  } catch {
    try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } finally { $child.Dispose() }
    throw
  }
}
function Stop-TinyProcess($Child) {
  $Child.StandardInput.Close()
  Assert ($Child.WaitForExit(5000)) 'Tiny child did not exit on stdin EOF'
  Assert ($Child.ExitCode -eq 0) 'Tiny child failed'
}
function Read-Row([hashtable]$Map, [int]$ChildId, [hashtable]$Counters, $Tombstones = [Collections.Generic.List[object]]::new()) {
  $serviceIds = [Collections.Generic.HashSet[int]]::new()
  [void]$serviceIds.Add($ChildId)
  $browserIds = [Collections.Generic.HashSet[int]]::new()
  return @(Get-ProcessRows -ProcessMap $Map -ServiceIds $serviceIds -BrowserIds $browserIds -RunnerPid 1 -ObserverPid 2 -Parents @{} -Names @{} -PreviousCounters $Counters -Tombstones $Tombstones) |
    Where-Object pid -eq $ChildId
}
function New-Fixture([long]$Ticks, [double]$Cpu, [long]$Io) {
  $fixture = [WindowsStabilityResource.ProcessSnapshot]::new()
  $fixture.Id = 424242
  $fixture.ParentProcessId = 42
  $fixture.ProcessName = 'synthetic.exe'
  $fixture.ObservedAt = [DateTime]::UtcNow.ToString('O')
  $fixture.StartTime = [DateTime]::new($Ticks, [DateTimeKind]::Utc)
  $fixture.CreationFileTime = if ($Ticks -gt 0) { $fixture.StartTime.ToFileTimeUtc() } else { 0 }
  $fixture.WorkingSet64 = 10
  $fixture.PrivateMemorySize64 = 20
  $fixture.PeakWorkingSet64 = 30
  $fixture.HandleCount = 7
  $fixture.CPU = $Cpu
  $fixture.ReadTransferCount = $Io
  $fixture.WriteTransferCount = $Io
  return $fixture
}
function Read-Fixture($Fixture, [hashtable]$Counters) {
  return Read-Row @{ '424242' = $Fixture } 424242 $Counters
}

$first = $null
$second = $null
$sampleChild = $null
try {
  $first = Start-TinyProcess
  $firstId = $first.Id
  $firstTicks = $first.StartTime.ToUniversalTime().Ticks
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$firstId" -Property ProcessId, ParentProcessId, Name, CreationDate
  $captured = Get-LiveProcessMap
  $native = $captured[[string]$firstId]
  Assert ($null -ne $native) 'Tiny child missing from native snapshot'
  foreach ($unknown in @($captured.Values | Where-Object CreationFileTime -le 0)) {
    Assert ($unknown.StartTime.Kind -eq [DateTimeKind]::Utc -and $unknown.StartTime.ToUniversalTime().Ticks -eq 0) 'Missing native creation time became a local-time identity'
  }
  Assert ($native.StartTime.Ticks -eq $firstTicks) 'Native creation time differs from actual process handle'
  Assert ($native.ParentProcessId -eq $cim.ParentProcessId -and $native.ProcessName -eq $cim.Name) 'CIM/native process provenance mismatch'
  # CIM dates have lower precision; they corroborate the record and never supply exact identity.
  Assert ([Math]::Abs($native.StartTime.Ticks - $cim.CreationDate.ToUniversalTime().Ticks) -lt 10000) 'CIM creation time differs by at least 1ms'
  $nativeIo = [CodexGrowthResource.IoCounters]::new()
  Assert ([CodexGrowthResource.Interop]::TryGetIoCounters($firstId, [ref]$nativeIo)) 'Independent I/O query failed'
  Assert ($native.ReadTransferCount -le $nativeIo.ReadTransferCount -and $native.WriteTransferCount -le $nativeIo.WriteTransferCount) 'Native I/O layout is inconsistent'
  Assert ($native.WorkingSet64 -gt 0 -and $native.PrivateMemorySize64 -gt 0 -and $native.PeakWorkingSet64 -ge $native.WorkingSet64) 'Native memory layout is inconsistent'
  $first.Refresh()
  Assert ([Math]::Abs($native.WorkingSet64 - $first.WorkingSet64) -lt 2MB) 'Native RSS differs from actual process measurement'
  Assert ([Math]::Abs($native.PrivateMemorySize64 - $first.PrivateMemorySize64) -lt 2MB) 'Native private bytes differ from actual process measurement'
  Assert ([Math]::Abs($native.PeakWorkingSet64 - $first.PeakWorkingSet64) -lt 2MB) 'Native peak RSS differs from actual process measurement'
  Assert ([Math]::Abs($native.CPU - $first.TotalProcessorTime.TotalSeconds) -lt 0.1) 'Native CPU units differ from actual process measurement'
  $snapshotParents = @{}
  foreach ($process in $captured.Values) { $snapshotParents[[string]$process.Id] = $process.ParentProcessId }
  $scope = Get-ProcessScopeIds -ServiceRootPid $PID -RunnerRootPid $PID -ObserverPid $PID -Parents $snapshotParents
  Assert ($scope.service.Contains($firstId)) 'Snapshot tree did not discover the new child'
  $counters = @{}
  $firstLive = Read-Row $captured $firstId $counters
  Stop-TinyProcess $first
  Assert ($null -eq (Get-Process -Id $firstId -ErrorAction SilentlyContinue)) 'First child still running'
  $exited = [Collections.Generic.List[object]]::new()
  $exitedRows = @(Read-Row $captured $firstId $counters $exited)
  Assert ($exitedRows.Count -eq 0 -and $exited.Count -eq 1) 'Confirmed exit remained in live rows'
  Assert ($exited[0].identityEvidence.startTimeUtcTicks -eq [string]$firstTicks) 'Identity lost after child exit'
  Assert ($firstLive.workingSetBytes -eq $native.WorkingSet64 -and $firstLive.logicalReadBytes -eq $native.ReadTransferCount) 'Live record mixed snapshots'
  $first.Dispose()
  $first = $null

  $second = Start-TinyProcess
  $secondId = $second.Id
  $secondTicks = $second.StartTime.ToUniversalTime().Ticks
  $rebuiltMap = Get-LiveProcessMap
  Assert ($firstId -eq $secondId -or -not $rebuiltMap.ContainsKey([string]$firstId)) 'Exited child remained in fresh snapshot'
  $rebuilt = Read-Row $rebuiltMap $secondId $counters
  Assert ($rebuilt.startTimeUtcTicks -eq $secondTicks -and $secondTicks -ne $firstTicks) 'Rebuilt child borrowed the old identity'
  Assert ($null -eq $rebuilt.cpuSecondsIncrement -and $null -eq $rebuilt.logicalReadBytesIncrement) 'Rebuilt child borrowed old counters'

  $peaks = @{}
  Update-ProcessPeaks -Peaks $peaks -Rows @($firstLive, $rebuilt) -At ([DateTime]::UtcNow.ToString('O'))
  Assert ($peaks.Count -eq 2) 'Real process generations merged in peak summary'
  # A fabricated prior generation of this live PID must fail the native handle check.
  $priorGeneration = [WindowsStabilityResource.ProcessSnapshot]::new()
  $priorGeneration.Id = $secondId
  $priorGeneration.ProcessName = 'prior-generation.exe'
  $priorGeneration.StartTime = [DateTime]::new(($secondTicks - 1), [DateTimeKind]::Utc)
  $priorGeneration.CreationFileTime = $priorGeneration.StartTime.ToFileTimeUtc()
  $priorGeneration.ObservedAt = $rebuiltMap[[string]$secondId].ObservedAt
  $priorGeneration.WorkingSet64 = 111
  $priorGeneration.PrivateMemorySize64 = 555
  $priorGeneration.HandleCount = 66
  $priorGeneration.PeakWorkingSet64 = 222
  $priorGeneration.CPU = 3.25
  $priorGeneration.ReadTransferCount = 333
  $priorGeneration.WriteTransferCount = 444
  $reusedTombstones = [Collections.Generic.List[object]]::new()
  $reusedRows = @(Read-Row @{ ([string]$secondId) = $priorGeneration } $secondId $counters $reusedTombstones)
  Assert ($reusedRows.Count -eq 0 -and $reusedTombstones[0].reason -eq 'pid-reused') 'Native confirmation accepted a recycled PID'
  Stop-TinyProcess $second

  $nativeState = (Get-Item -LiteralPath Function:Get-WindowsResourceProcessState).ScriptBlock
  function Get-WindowsResourceProcessState($Process) { return $script:fixtureState }
  $script:fixtureState = 'live'
  $ticks = [long]639296804262091236
  $syntheticCounters = @{}
  $old = Read-Fixture (New-Fixture $ticks 1 10) $syntheticCounters
  $same = Read-Fixture (New-Fixture $ticks 2 20) $syntheticCounters
  $script:fixtureState = 'missing'
  $missing = Read-Fixture (New-Fixture 0 90 900) $syntheticCounters
  $unconfirmed = Read-Fixture (New-Fixture $ticks 91 901) $syntheticCounters
  $script:fixtureState = 'live'
  $reused = Read-Fixture (New-Fixture ($ticks + 1) 100 1000) $syntheticCounters
  $reusedAgain = Read-Fixture (New-Fixture ($ticks + 1) 101 1010) $syntheticCounters
  $syntheticPeaks = @{}
  Update-ProcessPeaks -Peaks $syntheticPeaks -Rows @($old, $reused) -At ([DateTime]::UtcNow.ToString('O'))
  $syntheticRootAlive = Test-RootIdentityAlive 424242 $ticks @{ '424242' = (New-Fixture ($ticks + 1) 1 1) }
  Set-Item -LiteralPath Function:Get-WindowsResourceProcessState -Value $nativeState

  $state = Join-Path $env:WINDOWS_RESOURCE_DIRECTORY 'state'
  $null = New-Item -ItemType Directory -Path $state
  $sampleChild = Start-TinyProcess
  $script:snapshotCalls = 0
  $nativeMap = (Get-Item -LiteralPath Function:Get-LiveProcessMap).ScriptBlock
  function Get-LiveProcessMap {
    $map = & $nativeMap
    $script:snapshotCalls++
    # End the child after discovery in the second sample, before row collection.
    if ($script:snapshotCalls -eq 3) { Stop-TinyProcess $sampleChild }
    return $map
  }
  $sampleDir = Join-Path $env:WINDOWS_RESOURCE_DIRECTORY 'diagnostic/current/resources'
  $summary = Invoke-B2AttributionSampler -ResultDirectory $sampleDir -ServiceTreePid $sampleChild.Id -BrowserRunnerPid $PID -StopMarker (Join-Path $state 'stop') -StateDirectory $state -TemporaryDirectory $state -SampleIntervalMilliseconds 250 -MaxSamples 2
  $samples = @(Get-Content -LiteralPath $summary.samplesFile | ForEach-Object { $_ | ConvertFrom-Json })
  $written = Get-Content -LiteralPath $summary.summaryFile -Raw | ConvertFrom-Json
  [ordered]@{
    legacy = $legacy
    layout = $layout
    layoutRejection = $layoutRejection
    runtime = @{ pwsh=$PSVersionTable.PSVersion.ToString(); windows=[Environment]::OSVersion.VersionString; dotnet=[Runtime.InteropServices.RuntimeInformation]::FrameworkDescription }
    real = @($firstLive, $rebuilt)
    exited = @($exited)
    reusedTombstones = @($reusedTombstones)
    actualTicks = @([string]$firstTicks, [string]$secondTicks)
    cim = @{ pid = $cim.ProcessId; parentPid = $cim.ParentProcessId; name = $cim.Name; creationDate = $cim.CreationDate.ToUniversalTime().ToString('O') }
    synthetic = @{ old = $old; same = $same; missing = $missing; unconfirmed = $unconfirmed; reused = $reused; again = $reusedAgain;
      peakIdentities = @($syntheticPeaks.Values | ForEach-Object { $_.identityEvidence.startTimeUtcTicks }); rootAlive = $syntheticRootAlive }
    samples = $samples
    summary = $written
  } | ConvertTo-Json -Depth 14 -Compress
} finally {
  foreach ($child in @($first, $second, $sampleChild)) {
    if ($null -eq $child) { continue }
    try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } finally { $child.Dispose() }
  }
}
`;
    const fixtureFile = path.join(directory, "windows-stability-resource-calibration.ps1");
    writeFileSync(fixtureFile, script);
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-File", fixtureFile], {
      encoding: "utf8", windowsHide: true, timeout: 25_000,
      env: { ...process.env, WINDOWS_RESOURCE_WRAPPER: wrapper, WINDOWS_RESOURCE_NODE: process.execPath, WINDOWS_RESOURCE_DIRECTORY: directory },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const evidence = JSON.parse(result.stdout.trim());
    const raw = readFileSync(evidence.summary.samplesFile, "utf8");
    evidence.samples = raw.trim().split(/\r?\n/).map(parseResourceSample);
    evidence.summary = JSON.parse(readFileSync(evidence.summary.summaryFile, "utf8"));
    const source = "NtQuerySystemInformation/SystemProcessInformation";
    let checksPassed = true;
    const check = (name, run) => t.test(name, async () => {
      try { await run(); } catch (error) { checksPassed = false; throw error; }
    });

    await check("existing wrapper self-test still passes", () => {
      assert.equal(evidence.legacy.ok, true);
      assert.equal(evidence.legacy.samples, 2);
    });
    await check("x64 native layout matches the calibrated size and offsets", () => {
      assert.deepEqual(evidence.layout, { architecture: "X64", size: 256,
        offsets: { CreateTime: 32, UniqueProcessId: 80, WorkingSetSize: 144, ReadTransferCount: 232 } });
    });
    await check("an unknown native layout fails before collecting any sample", () => {
      assert.equal(evidence.layoutRejection, "Uncalibrated SYSTEM_PROCESS_INFORMATION layout");
    });
    await check("actual child exit and rebuild preserve independently verified exact identities", () => {
      for (const [index, row] of evidence.real.entries()) {
        assert.equal(row.identityEvidence.startTimeUtcTicks, evidence.actualTicks[index]);
        assert.equal(row.identityEvidence.source, source);
        assert.equal(row.identityEvidence.precision, "100ns");
        assert.equal(row.identityEvidence.pid, row.pid);
        assert.equal(BigInt(row.identityEvidence.creationFileTime) + 504911232000000000n, BigInt(evidence.actualTicks[index]));
        assert.match(row.startTimeUtc, /\.\d{7}Z$/);
        assert.ok(row.workingSetBytes > 0);
        assert.ok(row.handleCount > 0);
      }
      assert.notEqual(evidence.actualTicks[0], evidence.actualTicks[1]);
      t.diagnostic(JSON.stringify({ actualTicks: evidence.actualTicks, identities: evidence.real.map(row => ({ pid: row.pid, ...row.identityEvidence })), cim: evidence.cim }));
    });
    await check("confirmed exits and recycled generations become precise tombstones outside live rows", () => {
      assert.equal(evidence.exited.length, 1);
      assert.equal(evidence.exited[0].status, "tombstone");
      assert.equal(evidence.exited[0].name, evidence.real[0].name);
      assert.equal(evidence.exited[0].identityEvidence.startTimeUtcTicks, evidence.actualTicks[0]);
      const fields = ["startTimeUtc", "workingSetBytes", "privateBytes", "handleCount", "reportedPeakWorkingSetBytes", "cpuSeconds", "logicalReadBytes", "logicalWriteBytes"];
      assert.deepEqual(evidence.exited[0].resourceSnapshot, Object.fromEntries(fields.map(key => [key, evidence.real[0][key]])));
      assert.equal(evidence.reusedTombstones[0].reason, "pid-reused");
      assert.equal(evidence.reusedTombstones[0].identityEvidence.precision, "100ns");
      const reused = evidence.reusedTombstones[0];
      assert.equal(reused.name, "prior-generation.exe");
      assert.notEqual(reused.name, evidence.real[1].name);
      assert.equal(BigInt(reused.identityEvidence.startTimeUtcTicks), BigInt(evidence.actualTicks[1]) - 1n);
      assert.notEqual(reused.resourceSnapshot.startTimeUtc, evidence.real[1].startTimeUtc);
      assert.deepEqual(reused.resourceSnapshot, { startTimeUtc: reused.resourceSnapshot.startTimeUtc,
        workingSetBytes: 111, privateBytes: 555, handleCount: 66, reportedPeakWorkingSetBytes: 222, cpuSeconds: 3.25, logicalReadBytes: 333, logicalWriteBytes: 444 });
      const childId = evidence.summary.tree.serviceRootPid;
      const live = evidence.samples[0].processes.find(row => row.pid === childId);
      const tombstone = evidence.samples[1].tombstones.find(row => row.pid === childId);
      assert.equal(live.role, "service");
      assert.equal(tombstone.name, live.name);
      assert.equal(tombstone.identityEvidence.startTimeUtcTicks, live.identityEvidence.startTimeUtcTicks);
      assert.equal(tombstone.resourceSnapshot.startTimeUtc, live.startTimeUtc);
      assert.ok(tombstone.resourceSnapshot.workingSetBytes > 0);
      assert.ok(tombstone.resourceSnapshot.privateBytes > 0);
      assert.ok(tombstone.resourceSnapshot.handleCount > 0);
      assert.ok(tombstone.resourceSnapshot.reportedPeakWorkingSetBytes >= tombstone.resourceSnapshot.workingSetBytes);
      assert.equal(evidence.summary.tombstones.length, evidence.samples[1].tombstones.length);
      assert.deepEqual(evidence.summary.tombstones, evidence.samples[1].tombstones);
      assert.ok(!evidence.samples[1].processes.some(row => row.pid === childId));
      for (const sample of evidence.samples) {
        assert.equal(sample.service.processCount, sample.processes.filter(row => row.role === "service").length);
        assert.equal(sample.service.workingSetBytes, sample.processes.filter(row => row.role === "service").reduce((sum, row) => sum + row.workingSetBytes, 0));
      }
    });
    await check("PID reuse one 100ns tick apart cannot merge counters, roots or peaks", () => {
      const { old, same, reused, again, peakIdentities, rootAlive } = evidence.synthetic;
      assert.equal(BigInt(reused.identityEvidence.startTimeUtcTicks) - BigInt(old.identityEvidence.startTimeUtcTicks), 1n);
      assert.notEqual(reused.startTimeUtc, old.startTimeUtc);
      assert.equal(same.cpuSecondsIncrement, 1);
      assert.equal(same.logicalReadBytesIncrement, 10);
      for (const key of ["cpuSecondsIncrement", "logicalReadBytesIncrement", "logicalWriteBytesIncrement"]) assert.equal(reused[key], null);
      assert.equal(again.cpuSecondsIncrement, 1);
      assert.equal(again.logicalReadBytesIncrement, 10);
      assert.equal(again.logicalWriteBytesIncrement, 10);
      assert.equal(new Set(peakIdentities).size, 2);
      assert.equal(rootAlive, false);
    });
    await check("unknown creation time stays missing even after a known generation of the same PID", () => {
      for (const row of [evidence.synthetic.missing, evidence.synthetic.unconfirmed]) {
        assert.equal(row.startTimeUtc, null);
        assert.equal(row.startTimeUtcTicks, 0);
        assert.equal(row.identityEvidence.source, "missing");
        assert.equal(row.identityEvidence.precision, null);
        assert.equal(row.identityEvidence.startTimeUtcTicks, null);
        assert.equal(row.cpuSecondsIncrement, null);
        assert.equal(row.logicalReadBytesIncrement, null);
        assert.equal(row.logicalWriteBytesIncrement, null);
        assert.equal(row.workingSetBytes, 10);
      }
    });
    await check("250ms output retains native provenance, periodic CIM and exact summary identities", () => {
      assert.equal(evidence.samples.length, 2);
      assert.equal(evidence.summary.cimRefreshMilliseconds, 3000);
      assert.equal(evidence.summary.sampleIntervalMilliseconds, 250);
      assert.equal(evidence.samples[0].treeMetadata.refreshedAt, evidence.samples[1].treeMetadata.refreshedAt);
      for (const sample of evidence.samples) {
        assert.ok(sample.treeMetadata.cimProcessRecords > 0);
        assert.ok(sample.treeMetadata.processSnapshotRecords > 0);
        assert.equal(sample.treeMetadata.processTreeSource, source);
        assert.ok(sample.processes.every(row => row.identityEvidence.source === source));
        assert.equal(sample.processes.find(row => row.role === "observer").identityEvidence.observedAt, sample.treeMetadata.processSnapshotAt);
      }
      assert.ok(evidence.summary.processes.every(row => row.identityEvidence.source === source));
    });
    await check("existing identity correction preserves native source, precision and tombstones", () => {
      for (const line of raw.trim().split(/\r?\n/)) {
        const parsed = parseResourceSample(line), corrected = correctResourceIdentity(parsed);
        assert.deepEqual(corrected.sample, parsed);
        for (const row of [...parsed.processes, ...parsed.tombstones]) {
          assert.equal(row.identityEvidence.source, source);
          assert.equal(row.identityEvidence.precision, "100ns");
        }
      }
    });
    let consumed;
    await check("existing snapshot consumers retain tombstone names, observed RSS and cumulative costs", async () => {
      const analysis = await oldAnalyze(directory, { referenceFile: path.join(directory, "no-reference.json"), upgradeFile: path.join(directory, "no-upgrade.json") });
      consumed = analysis.contexts.find(row => row.label === "current").resources;
      assert.equal(consumed.samples, 2);
      assert.equal(consumed.missingIdentitySamples, 0);
      assert.equal(consumed.missingMemorySamples, 0);
      const snapshotServiceRows = evidence.samples.flatMap(sample => resourceSnapshotRows(sample).filter(row => row.role === "service"));
      assert.deepEqual(new Set(consumed.processes.map(row => `${row.pid}|${row.startTimeUtc}`)),
        new Set(snapshotServiceRows.map(row => `${row.pid}|${row.startTimeUtc}`)));
      assert.equal(consumed.sampledPeakBytes, Math.max(...evidence.samples.map(sample =>
        resourceSnapshotRows(sample).filter(row => row.role === "service").reduce((sum, row) => sum + row.workingSetBytes, 0))));
      for (const sample of evidence.samples) {
        for (const tombstone of sample.tombstones) {
          const converted = resourceSnapshotRows(sample).find(row => row.pid === tombstone.pid && row.startTimeUtc === tombstone.resourceSnapshot.startTimeUtc);
          assert.equal(converted.name, tombstone.name);
          assert.equal(converted.privateBytes, tombstone.resourceSnapshot.privateBytes);
          assert.equal(converted.handleCount, tombstone.resourceSnapshot.handleCount);
          assert.equal(converted.identityEvidence.precision, "100ns");
        }
      }
      for (const row of consumed.processes) {
        const observations = snapshotServiceRows.filter(value => value.pid === row.pid && value.startTimeUtc === row.startTimeUtc);
        for (const key of ["cpuSeconds", "logicalReadBytes", "logicalWriteBytes"]) {
          assert.equal(row[key], Math.max(...observations.map(value => value[key])));
        }
      }
      assert.ok(!analysis.evidence.some(row => row.file?.endsWith("resources.ndjson")));
      assert.equal(analysis.passed, false); // A tiny calibration cannot satisfy a formal long-run report.
    });
    await check("old analyzer retains missing-identity rejection and the unchanged 512/256 MiB gates", async () => {
      for (const [name, processRow, bytes, expected] of [
        ["missing", evidence.synthetic.unconfirmed, 10, "incomplete"],
        ["over-budget", evidence.synthetic.old, 512 * 1048576 + 1, "failed"],
      ]) {
        const root = path.join(directory, name), context = path.join(root, "diagnostic/current"), resources = path.join(context, "resources");
        mkdirSync(resources, { recursive: true });
        const sample = { ...evidence.samples[0], processes: [{ ...processRow, workingSetBytes: bytes, reportedPeakWorkingSetBytes: bytes }],
          tombstones: [], service: { ...evidence.samples[0].service, processCount: 1, memoryAvailableProcessCount: 1,
            workingSetBytes: bytes, reportedPeakWorkingSetBytes: bytes } };
        writeFileSync(path.join(resources, "resources.ndjson"), `${JSON.stringify(sample)}\n`);
        writeFileSync(path.join(context, "resource-summary.json"), JSON.stringify({ idle: [{ atMs: sample.atUnixMs }] }));
        const analysis = await oldAnalyze(root, { referenceFile: path.join(root, "no-reference.json"), upgradeFile: path.join(root, "no-upgrade.json") });
        const active = analysis.resource.checks.find(row => row.id === "current/active-memory");
        const idle = analysis.resource.checks.find(row => row.id === "current/idle-memory");
        assert.equal(active.status, expected);
        assert.equal(active.evidence.limitBytes, 512 * 1048576);
        assert.equal(idle.evidence.limitBytes, 256 * 1048576);
        if (name === "over-budget") assert.equal(idle.status, "failed");
      }
    });
    assert.ok(checksPassed, "A preflight receipt requires every calibration check to pass");
    if (process.env.WINDOWS_STABILITY_RESOURCE_RECEIPT) {
      const receiptFile = path.resolve(process.env.WINDOWS_STABILITY_RESOURCE_RECEIPT);
      const hashes = [wrapper, fileURLToPath(import.meta.url), fileURLToPath(new URL("./b2-attribution-resource.ps1", import.meta.url)),
        fileURLToPath(new URL("./resource-identity-analysis.mjs", import.meta.url)), fileURLToPath(new URL("./windows-stability-analyze.mjs", import.meta.url))]
        .map(file => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }));
      const receipt = { version: 1, group: 4, kind: "windows-stability-resource-preflight", passed: true,
        at: new Date().toISOString(), testCommand: "node --test experiments/architecture-20261101/windows-stability-resource.test.mjs",
        runtime: evidence.runtime, checksPassed: 11,
        receiptCommand: "$env:WINDOWS_STABILITY_RESOURCE_RECEIPT='output/windows-stability-recovery-20261109/preflight/resource.json'; node --test experiments/architecture-20261101/windows-stability-resource.test.mjs",
        processCommand: [process.execPath, "-e", 'process.stdin.resume(); console.log("ready")'],
        sampler: { sampleIntervalMilliseconds: 250, cimRefreshMilliseconds: 3000, maxSamples: 2 },
        layoutSources: [{ url: "https://github.com/golang/sys/blob/master/windows/types_windows.go", blobSha: "643737d4553b28d68f08e958c90ec49f3631c3e3" },
          { url: "https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation" }],
        layout: { ...evidence.layout, unknownLayoutRejected: true }, realIdentities: evidence.real.map(row => ({ pid: row.pid, ...row.identityEvidence })),
        cimCorroboration: { ...evidence.cim, precision: "microsecond", usedForExactTicks: false },
        tombstones: [...evidence.exited, ...evidence.reusedTombstones.map(row => ({ ...row, calibrationFixture: "synthetic-prior-generation" })), ...evidence.summary.tombstones],
        tombstoneResources: { fields: ["startTimeUtc", "workingSetBytes", "privateBytes", "handleCount", "reportedPeakWorkingSetBytes", "cpuSeconds", "logicalReadBytes", "logicalWriteBytes"],
          source: "same captured native process record", namePreserved: true, exitedSnapshotPreserved: true, reusedPidKeepsPriorSnapshot: true, liveRowsUnchanged: true },
        syntheticPidReuse: { pid: evidence.synthetic.old.pid, old: evidence.synthetic.old.identityEvidence,
          next: evidence.synthetic.reused.identityEvidence, differenceTicks: "1", countersSeparated: true, unknownStaysMissing: true },
        consumers: { identityCorrection: "passed; native source/precision and tombstones retained", oldAnalyze: { samples: consumed.samples,
          missingIdentitySamples: consumed.missingIdentitySamples, missingMemorySamples: consumed.missingMemorySamples, snapshotGenerations: consumed.processes.length,
          tombstoneNamesRetained: true, livePlusExitedRssVerified: true, cumulativeMaxPerIdentityVerified: true },
          missingIdentityGate: "incomplete", over512ActiveGate: "failed", over256IdleGate: "failed" },
        coverage: ["x64 layout size/offsets and unknown-layout rejection", "CIM/native/actual-process identity", "native RSS/private/peak/CPU/I/O calibration",
          "actual child exit/rebuild", "confirmed exit tombstones with same-snapshot names and resource costs", "native PID-reuse rejection retaining prior-generation names/costs", "100ns synthetic generations",
          "missing/unconfirmed identity", "250ms sample and summary JSON", "existing identity correction and old stability analyzer", "unchanged 512/256 MiB gates"],
        limits: { activeBytes: 512 * 1048576, idleBytes: 256 * 1048576, standardsChanged: false },
        boundaries: ["tiny processes and two sampler iterations on this Windows x64 host", "no formal long run or heavy archive", "no production changes or commits"],
        hashes };
      mkdirSync(path.dirname(receiptFile), { recursive: true });
      writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("windows-stability-resource-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
