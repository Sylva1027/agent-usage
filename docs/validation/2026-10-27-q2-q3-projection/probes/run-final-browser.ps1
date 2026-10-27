#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$stageRoot = Join-Path $PWD 'output/q2-q3-projection-20261027'
$nodeBinary = 'C:\Program Files\nodejs\node.exe'
$env:REFRESH_TRACE = '0'
$env:REFRESH_RESULT_FILE = 'browser-final-results.json'
if (Test-Path -LiteralPath (Join-Path $stageRoot $env:REFRESH_RESULT_FILE)) { throw 'Final browser result already exists; preserve it before a deliberate rerun.' }
$started = [datetime]::UtcNow
$code = -1
try {
    & pwsh -NoProfile -File (Join-Path $stageRoot 'run-measured.ps1') `
        -FilePath $nodeBinary `
        -ArgumentsJson '["--max-old-space-size=1536","--import","./output/q2-q3-projection-20261027/runtime-hook.mjs","./output/q2-q3-projection-20261027/runtime-http-browser.mjs","--browser-only"]' `
        -WorkingDirectory $PWD -LimitMiB 7168 -TimeoutSeconds 600 `
        *> (Join-Path $stageRoot 'evidence/browser-final.txt')
    $code = $LASTEXITCODE
} finally {
    & pwsh -NoProfile -File ./output/refresh-sync-latency-implementation/restore-inputs.ps1 `
        *> (Join-Path $stageRoot 'evidence/restore-browser-final.txt')
}
& pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $nodeBinary `
    -ArgumentsJson '["--max-old-space-size=512","./output/refresh-sync-latency-implementation/check-inputs.mjs"]' `
    -LimitMiB 1024 -TimeoutSeconds 60 *> (Join-Path $stageRoot 'evidence/check-browser-final.txt')
$checkCode = $LASTEXITCODE
[pscustomobject]@{startedAt=$started.ToString('o'); endedAt=[datetime]::UtcNow.ToString('o'); code=$code; inputCheckCode=$checkCode} |
    ConvertTo-Json | Set-Content (Join-Path $stageRoot 'evidence/browser-final-run.json') -Encoding utf8
if ($code -ne 0 -or $checkCode -ne 0) { throw "browser-final failed: execution=$code, input-check=$checkCode" }
