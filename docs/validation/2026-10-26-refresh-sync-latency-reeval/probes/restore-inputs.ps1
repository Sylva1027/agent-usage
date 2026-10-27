#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$refreshBase = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.codex-usage/refresh-latency-20261026'))
$refreshFreeze = Get-Content -LiteralPath (Join-Path $refreshBase 'freeze.json') -Raw | ConvertFrom-Json
$refreshRestored = 0
foreach ($refreshEntry in $refreshFreeze.copied) {
  if ($refreshEntry.file -notmatch '\\.claude\\|\\\.config\\magpie\\usage\.jsonl$') { continue }
  $refreshMapping = $refreshFreeze.mappings | Where-Object { $refreshEntry.file.StartsWith($_.original + '\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  $refreshTarget = [IO.Path]::GetFullPath((Join-Path $refreshMapping.copy ([IO.Path]::GetRelativePath($refreshMapping.original, $refreshEntry.file))))
  if (-not $refreshTarget.StartsWith($refreshBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped isolated snapshot' }
  $refreshStream = [IO.File]::Open($refreshTarget, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $refreshStream.SetLength([long]$refreshEntry.bytes) } finally { $refreshStream.Dispose() }
  $refreshTicks = [long][Math]::Round([decimal]$refreshEntry.mtimeMs * 10000)
  [IO.File]::SetLastWriteTimeUtc($refreshTarget, [datetime]::UnixEpoch.AddTicks($refreshTicks))
  $refreshRestored++
}
$refreshNewFiles = @(Get-ChildItem -LiteralPath (Join-Path $refreshBase 'home/.codex/sessions/2026/10/26') -Filter 'rollout-refresh-diagnostic-*.jsonl' -File)
foreach ($refreshNewFile in $refreshNewFiles) {
  $refreshResolved = [IO.Path]::GetFullPath($refreshNewFile.FullName)
  if (-not $refreshResolved.StartsWith($refreshBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Removal target escaped isolated snapshot' }
  Remove-Item -LiteralPath $refreshResolved
}
@{ restored = $refreshRestored; syntheticFilesRemoved = $refreshNewFiles.Count; scope = 'private snapshot only' } | ConvertTo-Json -Compress
