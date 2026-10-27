#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$refreshPrivateRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.codex-usage/refresh-latency-20261026'))
$refreshManifest = Get-Content -LiteralPath (Join-Path $refreshPrivateRoot 'freeze.json') -Raw | ConvertFrom-Json
$refreshCount = 0
foreach ($refreshFile in $refreshManifest.copied) {
    $refreshMapping = $refreshManifest.mappings | Where-Object {
        $refreshFile.file.StartsWith($_.original + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if (-not $refreshMapping) { throw 'Unmapped captured file' }
    $refreshRelative = [IO.Path]::GetRelativePath($refreshMapping.original, $refreshFile.file)
    $refreshTarget = [IO.Path]::GetFullPath((Join-Path $refreshMapping.copy $refreshRelative))
    if (-not $refreshTarget.StartsWith($refreshPrivateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Timestamp target escaped private snapshot'
    }
    [IO.File]::SetLastWriteTimeUtc($refreshTarget, [IO.File]::GetLastWriteTimeUtc($refreshFile.file))
    $refreshCount++
}
@{ timestampFiles = $refreshCount; precision = 'Windows DateTime 100ns'; writes = 'private copies only' } | ConvertTo-Json -Compress
