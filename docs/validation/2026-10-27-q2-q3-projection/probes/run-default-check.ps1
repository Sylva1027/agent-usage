#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$stageRoot = Join-Path $PWD 'output/q2-q3-projection-20261027'
$nodeBinary = 'C:\Program Files\nodejs\node.exe'
$env:REFRESH_TRACE = '0'
$env:FOLLOWUP_ROUNDS = '3'
$results = [Collections.Generic.List[object]]::new()
foreach ($preset in @('today', 'month')) {
    $env:Q23_PRESET = $preset
    $env:Q23_RESULT = "default-$preset-results.json"
    $started = [datetime]::UtcNow
    $code = -1
    try {
        & pwsh -NoProfile -File (Join-Path $stageRoot 'run-measured.ps1') `
            -FilePath $nodeBinary `
            -ArgumentsJson '["--max-old-space-size=1536","--import","./output/q2-q3-projection-20261027/runtime-hook.mjs","./output/q2-q3-projection-20261027/default-refresh-paired.mjs"]' `
            -WorkingDirectory $PWD -LimitMiB 7168 -TimeoutSeconds 300 `
            *> (Join-Path $stageRoot "evidence/default-$preset.txt")
        $code = $LASTEXITCODE
    } finally {
        & pwsh -NoProfile -File ./output/refresh-sync-latency-implementation/restore-inputs.ps1 `
            *> (Join-Path $stageRoot "evidence/restore-default-$preset.txt")
    }
    & pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $nodeBinary `
        -ArgumentsJson '["--max-old-space-size=512","./output/refresh-sync-latency-implementation/check-inputs.mjs"]' `
        -LimitMiB 1024 -TimeoutSeconds 60 *> (Join-Path $stageRoot "evidence/check-default-$preset.txt")
    $checkCode = $LASTEXITCODE
    $row = [pscustomobject]@{preset=$preset; startedAt=$started.ToString('o'); endedAt=[datetime]::UtcNow.ToString('o'); code=$code; inputCheckCode=$checkCode}
    $results.Add($row)
    $results.ToArray() | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $stageRoot 'evidence/default-runs.json') -Encoding utf8
    $row | ConvertTo-Json -Compress
    if ($code -ne 0 -or $checkCode -ne 0) { throw "default-$preset failed: execution=$code, input-check=$checkCode" }
}
