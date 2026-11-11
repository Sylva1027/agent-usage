#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateFile,
    [Parameter(Mandatory)][string]$OutputFile,
    [Parameter(Mandatory)][string]$StopFile,
    [ValidateRange(1, 1000)][int]$IntervalMilliseconds = 20
)

$ErrorActionPreference = 'Stop'
$prototypeWriter = [IO.StreamWriter]::new($OutputFile, $false)
$prototypeWriter.AutoFlush = $true
$prototypeClock = [Diagnostics.Stopwatch]::StartNew()
$prototypeLastSample = $null

try {
    while (-not [IO.File]::Exists($StopFile)) {
        $prototypeLoopStarted = $prototypeClock.Elapsed.TotalMilliseconds
        try {
            $prototypeStateStream = [IO.FileStream]::new(
                $StateFile,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
            )
            $prototypeStateReader = [IO.StreamReader]::new($prototypeStateStream)
            try {
                $prototypeState = $prototypeStateReader.ReadToEnd() | ConvertFrom-Json
            }
            finally {
                $prototypeStateReader.Dispose()
            }
            if ($null -eq $prototypeState -or $null -eq $prototypeState.pids -or -not $prototypeState.phase) {
                throw 'Incomplete sampler state'
            }
            $prototypePids = @($prototypeState.pids | Where-Object { $null -ne $_ -and [int]$_ -gt 0 } | ForEach-Object { [int]$_ } | Sort-Object -Unique)
            $prototypeRss = 0L
            $prototypePrivate = 0L
            $prototypeFound = 0
            $prototypeNodePids = [Collections.Generic.List[int]]::new()
            $prototypeOtherPids = [Collections.Generic.List[int]]::new()
            $prototypeMissingPids = [Collections.Generic.List[int]]::new()

            foreach ($prototypePid in $prototypePids) {
                $prototypeProcess = Get-Process -Id $prototypePid -ErrorAction SilentlyContinue
                if ($null -eq $prototypeProcess) {
                    $prototypeMissingPids.Add($prototypePid)
                    continue
                }
                $prototypeRss += $prototypeProcess.WorkingSet64
                $prototypePrivate += $prototypeProcess.PrivateMemorySize64
                $prototypeFound++
                if ($prototypeProcess.ProcessName -in @('node', 'nodejs')) {
                    $prototypeNodePids.Add($prototypePid)
                }
                else {
                    $prototypeOtherPids.Add($prototypePid)
                }
            }

            $prototypeSample = $prototypeClock.Elapsed.TotalMilliseconds
            $prototypeInterval = if ($null -eq $prototypeLastSample) {
                0
            }
            else {
                [Math]::Round($prototypeSample - $prototypeLastSample, 3)
            }
            $prototypeLastSample = $prototypeSample

            $prototypeRow = [ordered]@{
                at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                intervalMs = $prototypeInterval
                targetIntervalMs = $IntervalMilliseconds
                case = $prototypeState.case
                phase = $prototypeState.phase
                rss = $prototypeRss
                private = $prototypePrivate
                processes = $prototypeFound
                pids = $prototypePids
                nodeProcesses = $prototypeNodePids.Count
                nodePids = @($prototypeNodePids)
                otherPids = @($prototypeOtherPids)
                missingPids = @($prototypeMissingPids)
            }
            $prototypeWriter.WriteLine(($prototypeRow | ConvertTo-Json -Compress))
        }
        catch {
            # A concurrent state-file rewrite can expose empty/partial JSON.
        }

        $prototypeElapsed = $prototypeClock.Elapsed.TotalMilliseconds - $prototypeLoopStarted
        $prototypeRemaining = $IntervalMilliseconds - $prototypeElapsed
        if ($prototypeRemaining -gt 0) {
            Start-Sleep -Milliseconds ([Math]::Max(1, [int][Math]::Round($prototypeRemaining)))
        }
    }
}
finally {
    $prototypeWriter.Dispose()
}
