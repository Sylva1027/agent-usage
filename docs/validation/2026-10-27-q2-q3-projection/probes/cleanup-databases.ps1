#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$stage = Join-Path $PWD 'output/q2-q3-projection-20261027'
$frozen = (Resolve-Path -LiteralPath '.codex-usage/refresh-latency-20261026').Path
$rows = [Collections.Generic.List[object]]::new()
$databases = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$failedClock = Get-Content -LiteralPath (Join-Path $stage 'evidence/browser-clock-failure.json') -Raw | ConvertFrom-Json
[void]$databases.Add($failedClock.databaseFile)
foreach ($name in @('browser-partial-v2-results.json', 'browser-controls-v3-results.json', 'browser-controls-results.json', 'browser-worst-phase-results.json', 'browser-final-results.json')) {
    $file = Join-Path $stage $name
    if (!(Test-Path -LiteralPath $file)) { throw "Missing cleanup ownership record: $name" }
    $record = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if (!$record.databaseFile) { throw "Missing database path: $name" }
    if ($null -eq $record.walAfterClose) {
        $processes = Get-Content -LiteralPath (Join-Path $stage 'evidence/processes-final.json') -Raw | ConvertFrom-Json
        if ($name -ne 'browser-partial-v2-results.json' -or $processes.status -ne 'checked' -or
            $processes.stoppedV2PidPresent -or @($processes.remainingTaskProcesses).Count -ne 0) {
            throw "Missing close record without stopped-process evidence: $name"
        }
        $rows.Add([pscustomobject]@{database=$record.databaseFile; interruptedRun=$true; closeRecordAvailable=$false; processEvidence='processes-final.json'})
    }
    elseif ($record.walAfterClose -ne 0) { throw "Nonzero final WAL recorded by $name" }
    [void]$databases.Add($record.databaseFile)
}
# The first sandbox launch predates databaseFile recording; creation matches its launch and bytes must match seed.
$launchFile = Join-Path $frozen 'incremental-http-browser-36720.sqlite'
if (Test-Path -LiteralPath $launchFile) {
    $launch = Get-Item -LiteralPath $launchFile
    if ($launch.CreationTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss') -ne '2026-10-27T03:32:48') { throw 'Initial launch database creation time differs' }
    $sha = (Get-FileHash -LiteralPath $launchFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sha -ne 'cfc35c20b32efd09328fde9ba477d25be3ebac5da33e55a26d9555090a085bd5') { throw 'Initial launch database differs from the untouched seed copy' }
    $rows.Add([pscustomobject]@{database=$launchFile; initialLaunchCreationUtc=$launch.CreationTimeUtc.ToString('o'); seedEquivalentSha256=$sha})
    [void]$databases.Add($launchFile)
}
foreach ($database in $databases) {
    $absolute = [IO.Path]::GetFullPath($database)
    if ([IO.Path]::GetDirectoryName($absolute) -ne $frozen -or [IO.Path]::GetFileName($absolute) -notmatch '^incremental-(http-browser|controls)-\d+\.sqlite$') { throw "Unexpected cleanup target: $absolute" }
    $files = [Collections.Generic.List[string]]::new()
    foreach ($suffix in @('', '-wal', '-shm')) {
        $file = $absolute + $suffix
        if (!(Test-Path -LiteralPath $file)) { continue }
        $item = Get-Item -LiteralPath $file
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup target is a reparse point: $file" }
        if ($suffix -eq '-wal' -and $item.Length -ne 0) { throw "WAL still contains bytes: $file" }
        $files.Add($file)
    }
    foreach ($file in $files) { Remove-Item -LiteralPath $file }
    foreach ($suffix in @('', '-wal', '-shm')) {
        if (Test-Path -LiteralPath ($absolute + $suffix)) { throw "Cleanup did not remove $absolute$suffix" }
    }
    $rows.Add([pscustomobject]@{database=$absolute; removedFiles=$files.ToArray(); walBeforeRemovalBytes=0; allRemoved=$true})
}
$rows.ToArray() | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage 'evidence/database-cleanup.json') -Encoding utf8
$rows.ToArray() | ConvertTo-Json -Depth 8
