#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$refreshRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.codex-usage/refresh-latency-20261026'))
$refreshRaw = [IO.File]::ReadAllText((Join-Path $refreshRoot 'freeze.json'))
$refreshManifest = $refreshRaw | ConvertFrom-Json
$refreshDocument = [System.Text.Json.JsonDocument]::Parse($refreshRaw)
$refreshCount = 0
try {
  foreach ($refreshEntry in $refreshDocument.RootElement.GetProperty('copied').EnumerateArray()) {
    $refreshFile = $refreshEntry.GetProperty('file').GetString()
    if ($refreshFile -notmatch '\\.claude\\|\\\.config\\magpie\\usage\.jsonl$') { continue }
    $refreshMapping = $refreshManifest.mappings | Where-Object { $refreshFile.StartsWith($_.original + '\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    $refreshTarget = [IO.Path]::GetFullPath((Join-Path $refreshMapping.copy ([IO.Path]::GetRelativePath($refreshMapping.original, $refreshFile))))
    if (-not $refreshTarget.StartsWith($refreshRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped private snapshot' }
    $refreshStream = [IO.File]::Open($refreshTarget, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $refreshStream.SetLength($refreshEntry.GetProperty('bytes').GetInt64()) } finally { $refreshStream.Dispose() }
    # Parse the JSON decimal directly; casting a Double to Decimal rounds away sub-ms digits.
    $refreshTicks = [long][Math]::Round($refreshEntry.GetProperty('mtimeMs').GetDecimal() * 10000)
    [IO.File]::SetLastWriteTimeUtc($refreshTarget, [datetime]::UnixEpoch.AddTicks($refreshTicks))
    $refreshCount++
  }
} finally { $refreshDocument.Dispose() }
$refreshSynthetic = @(Get-ChildItem -LiteralPath (Join-Path $refreshRoot 'home/.codex/sessions/2026/10/26') -Filter 'rollout-refresh-diagnostic-*.jsonl' -File)
foreach ($refreshFile in $refreshSynthetic) {
  $refreshTarget = [IO.Path]::GetFullPath($refreshFile.FullName)
  if (-not $refreshTarget.StartsWith($refreshRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Removal escaped private snapshot' }
  Remove-Item -LiteralPath $refreshTarget
}
@{restored=$refreshCount;syntheticFilesRemoved=$refreshSynthetic.Count;precision='raw JSON decimal to 100ns';scope='private snapshot only'} | ConvertTo-Json -Compress
