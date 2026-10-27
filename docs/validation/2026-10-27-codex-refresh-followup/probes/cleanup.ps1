#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath '.').Path
$stage = (Resolve-Path -LiteralPath 'output/codex-refresh-followup-20261027').Path
$frozen = (Resolve-Path -LiteralPath '.codex-usage/refresh-latency-20261026').Path
$databases = @(
    (Join-Path $stage 'probes/runs/prescan-before/usage-index.sqlite'),
    (Join-Path $stage 'probes/runs/prescan-after/usage-index.sqlite'),
    (Join-Path $stage 'reader-before-actual-fixed/usage-index.sqlite'),
    (Join-Path $stage 'reader-ledger-actual-after/usage-index.sqlite'),
    (Join-Path $frozen 'incremental-controls-45712.sqlite')
)
$files = @()
foreach ($database in $databases) {
    foreach ($suffix in @('', '-wal', '-shm')) {
        $candidate = $database + $suffix
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $resolved = (Resolve-Path -LiteralPath $candidate).Path
        if (-not $resolved.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Outside workspace: $resolved"
        }
        if (-not $resolved.StartsWith($stage + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
            $resolved -ne (Join-Path $frozen ('incremental-controls-45712.sqlite' + $suffix))) {
            throw "Outside own measurement paths: $resolved"
        }
        $item = Get-Item -LiteralPath $resolved
        if ($item.PSIsContainer) { throw "Expected measurement file: $resolved" }
        $files += [pscustomobject]@{ path = $resolved; bytes = $item.Length; deleted = $false }
    }
}
$report = [pscustomobject]@{
    startedAt = [DateTimeOffset]::Now.ToString('o')
    files = $files
    bytes = ($files | Measure-Object -Property bytes -Sum).Sum
    completed = $false
}
$reportPath = Join-Path $stage 'evidence/cleanup.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
foreach ($file in $files) {
    Remove-Item -LiteralPath $file.path
    $file.deleted = -not (Test-Path -LiteralPath $file.path)
    if (-not $file.deleted) { throw "Cleanup failed: $($file.path)" }
}
$report.completed = $true
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
[pscustomobject]@{ count = $files.Count; bytes = $report.bytes; completed = $report.completed } | ConvertTo-Json -Compress
