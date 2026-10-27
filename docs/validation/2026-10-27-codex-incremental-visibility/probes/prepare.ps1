#requires -Version 7.0
param(
    [string]$CodeRoot = 'output/codex-incremental-visibility-20261027/preimage',
    [string]$IdentityFile = 'output/codex-incremental-visibility-20261027/probes/identity.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path
$probeRoot = Join-Path $repoRoot 'output/codex-incremental-visibility-20261027/probes'
$frozenRoot = Join-Path $repoRoot '.codex-usage/refresh-latency-20261026'
$manifestFile = Join-Path $frozenRoot 'freeze.json'
$codeDirectory = (Resolve-Path -LiteralPath $CodeRoot).Path
$identityPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $IdentityFile))
if (-not $identityPath.StartsWith($probeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'IdentityFile must be inside the new output probes directory'
}
if (Test-Path -LiteralPath $identityPath) { throw "Refusing to replace frozen identity: $identityPath" }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -AsHashtable
function Get-Identity([string]$File) {
    $resolved = (Resolve-Path -LiteralPath $File).Path
    if (-not $resolved.StartsWith($frozenRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Input outside the existing frozen directory: $resolved"
    }
    $item = Get-Item -LiteralPath $resolved
    if ($item.LinkType) { throw "Frozen inputs must be ordinary files: $resolved" }
    return [ordered]@{
        path = $resolved
        size = $item.Length
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$inputs = [Collections.Generic.List[object]]::new()
$inputs.Add((Get-Identity $manifestFile))
$inputs.Add((Get-Identity $manifest.database))
foreach ($mapping in $manifest.mappings) {
    Get-ChildItem -LiteralPath $mapping.copy -File -Recurse | ForEach-Object { $inputs.Add((Get-Identity $_.FullName)) }
}
# Pin the complete module tree, including dynamically imported modules.
$code = foreach ($directory in @('src', 'public')) {
    Get-ChildItem -LiteralPath (Join-Path $codeDirectory $directory) -File -Recurse | ForEach-Object {
        [ordered]@{
            path = [IO.Path]::GetRelativePath($codeDirectory, $_.FullName).Replace('\', '/')
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
}
$identity = [ordered]@{
    formatVersion = 1
    createdAt = [DateTimeOffset]::UtcNow.ToString('O')
    root = $repoRoot
    codeRoot = $codeDirectory
    frozenRoot = $frozenRoot
    manifest = $manifestFile
    database = $manifest.database
    oldAfter = [ordered]@{
        path = Join-Path $repoRoot 'docs/validation/2026-10-26-refresh-sync-latency-implementation/evidence/after-results.json'
        sha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'docs/validation/2026-10-26-refresh-sync-latency-implementation/evidence/after-results.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    inputs = @($inputs.ToArray())
    code = @($code)
}
$identity | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $identityPath -Encoding utf8NoBOM
Write-Output "Frozen identity: $identityPath ($($inputs.Count) inputs, $(@($code).Count) code files)"
