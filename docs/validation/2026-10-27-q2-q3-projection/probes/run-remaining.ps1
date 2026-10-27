#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$stageRoot = Join-Path $PWD 'output/q2-q3-projection-20261027'
$nodeBinary = 'C:\Program Files\nodejs\node.exe'
$env:REFRESH_TRACE = '0'
$env:FOLLOWUP_ROUNDS = '20'
$runs = @(
    @{ Name='q2-formal-v4'; Script='q2-paired-final-v4.mjs'; Timeout=1200; Hook=$true; Result='q2-formal-v4-results.json' },
    @{ Name='q3-formal'; Script='q3-executor-paired.mjs'; Timeout=900; Hook=$true; Execution=$true; Result='q3-formal-results.json' },
    @{ Name='append-control'; Script='append-paired.mjs'; Timeout=1200; Hook=$true; Result='append-control-results.json' },
    @{ Name='query-control'; Script='query-paired.mjs'; Timeout=600; Hook=$true },
    @{ Name='ledger-exact'; Script='ledger-exact.mjs'; Timeout=600; Hook=$true },
    @{ Name='retained'; Script='runtime-retained.mjs'; Timeout=240; Hook=$true },
    @{ Name='browser-controls'; Script='runtime-controls.mjs'; Timeout=600; Hook=$true; Browser=$true },
    @{ Name='gates'; Script='gates.mjs'; Timeout=2100; Hook=$false },
    @{ Name='verify-inputs'; Script='runtime-verify-inputs.mjs'; Timeout=240; Hook=$false },
    @{ Name='summarize'; Script='summarize-results.mjs'; Timeout=60; Hook=$false }
)
$results = [Collections.Generic.List[object]]::new()
foreach ($run in $runs) {
    $started = [datetime]::UtcNow
    $env:Q23_RESULT = $run.Result
    $env:Q23_LOG_FILE = Join-Path $stageRoot "evidence/$($run.Name)-execution.jsonl"
    if ($run.Browser) { $env:REFRESH_RESULT_FILE = 'browser-controls-results.json' }
    $arguments = [Collections.Generic.List[string]]::new()
    $arguments.Add('--max-old-space-size=1536')
    if ($run.Hook) {
        $arguments.Add('--import')
        $arguments.Add('./output/q2-q3-projection-20261027/runtime-hook.mjs')
    }
    if ($run.Execution) {
        $arguments.Add('--import')
        $arguments.Add('./output/q2-q3-projection-20261027/execution-hook.mjs')
    }
    $arguments.Add("./output/q2-q3-projection-20261027/$($run.Script)")
    if ($run.Browser) { $arguments.Add('--probe-smoke') }
    $code = -1
    try {
        & pwsh -NoProfile -File (Join-Path $stageRoot 'run-measured.ps1') `
            -FilePath $nodeBinary -ArgumentsJson (ConvertTo-Json -InputObject $arguments.ToArray() -Compress) `
            -WorkingDirectory $PWD -LimitMiB 7168 -TimeoutSeconds $run.Timeout `
            *> (Join-Path $stageRoot "evidence/$($run.Name).txt")
        $code = $LASTEXITCODE
    } finally {
        & pwsh -NoProfile -File ./output/refresh-sync-latency-implementation/restore-inputs.ps1 `
            *> (Join-Path $stageRoot "evidence/restore-$($run.Name).txt")
    }
    & pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $nodeBinary `
        -ArgumentsJson '["--max-old-space-size=512","./output/refresh-sync-latency-implementation/check-inputs.mjs"]' `
        -LimitMiB 1024 -TimeoutSeconds 60 *> (Join-Path $stageRoot "evidence/check-$($run.Name).txt")
    $checkCode = $LASTEXITCODE
    $row = [pscustomobject]@{name=$run.Name; startedAt=$started.ToString('o'); endedAt=[datetime]::UtcNow.ToString('o'); code=$code; inputCheckCode=$checkCode}
    $results.Add($row)
    $results.ToArray() | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $stageRoot 'evidence/remaining-runs.json') -Encoding utf8
    $row | ConvertTo-Json -Compress
    if ($code -ne 0 -or $checkCode -ne 0) { throw "$($run.Name) failed: execution=$code, input-check=$checkCode" }
}

