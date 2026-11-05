[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "bin"),
  [string]$TargetDirectory = (Join-Path $PSScriptRoot "target"),
  [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "windows-source-proof must be built on Windows."
}

$nativeOutput = [IO.Path]::GetFullPath($OutputDirectory)
$nativeTargetDirectory = [IO.Path]::GetFullPath($TargetDirectory)
$nativeDestination = Join-Path $nativeOutput "windows-source-proof.exe"
$nativeReceiptFile = Join-Path $nativeOutput "windows-source-proof.build.json"

function Get-NativeSourceHashes {
  $nativeFiles = @("Cargo.toml", "Cargo.lock", "build.ps1")
  $nativeFiles += Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "src") -Filter "*.rs" -Recurse -File |
    ForEach-Object { [IO.Path]::GetRelativePath($PSScriptRoot, $_.FullName).Replace('\', '/') }
  $nativeHashes = [ordered]@{}
  foreach ($nativeFile in ($nativeFiles | Sort-Object)) {
    $nativeHashes[$nativeFile] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $nativeFile) -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $nativeHashes
}

$nativeSourceHashes = Get-NativeSourceHashes
if ($Check) {
  if (-not (Test-Path -LiteralPath $nativeDestination -PathType Leaf) -or -not (Test-Path -LiteralPath $nativeReceiptFile -PathType Leaf)) {
    throw "Native helper or build receipt is missing. Run npm run native:build before packaging."
  }
  $nativeReceipt = Get-Content -Raw -LiteralPath $nativeReceiptFile | ConvertFrom-Json -AsHashtable
  if ($nativeReceipt.format -ne 1 -or $nativeReceipt.sourceSha256 -isnot [Collections.IDictionary] -or
      $nativeReceipt.sourceSha256.Count -ne $nativeSourceHashes.Count -or $nativeReceipt.artifact -ne "windows-source-proof.exe") {
    throw "Native build receipt is invalid. Rebuild the helper from this checkout."
  }
  foreach ($nativeFile in $nativeSourceHashes.Keys) {
    if ($nativeReceipt.sourceSha256[$nativeFile] -ne $nativeSourceHashes[$nativeFile]) {
      throw "Native helper source changed: $nativeFile. Rebuild before packaging."
    }
  }
  $nativeActualHash = (Get-FileHash -LiteralPath $nativeDestination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($nativeActualHash -ne $nativeReceipt.sha256) { throw "Native helper bytes do not match the build receipt." }
  [ordered]@{ checked = $true; path = $nativeDestination; sha256 = $nativeActualHash; target = $nativeReceipt.target } | ConvertTo-Json -Compress
  exit 0
}

$nativeCargo = Get-Command cargo -ErrorAction Stop
$nativeRustc = Get-Command rustc -ErrorAction Stop
$nativeRustInfo = & $nativeRustc.Source -vV
if ($LASTEXITCODE -ne 0) { throw "rustc host detection failed." }
$nativeHostLine = @($nativeRustInfo | Where-Object { $_ -match '^host: ' })
if ($nativeHostLine.Count -ne 1) { throw "rustc did not report a unique host target." }
$nativeHost = $nativeHostLine[0].Substring(6)
if ($nativeHost -notmatch '-windows-') { throw "A Windows Rust host toolchain is required." }

& $nativeCargo.Source build --manifest-path (Join-Path $PSScriptRoot "Cargo.toml") --release --locked --target $nativeHost --target-dir $nativeTargetDirectory
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
$nativeSource = Join-Path $nativeTargetDirectory "$nativeHost/release/windows-source-proof.exe"
if (-not (Test-Path -LiteralPath $nativeSource -PathType Leaf)) { throw "release helper was not produced at $nativeSource" }
$nativeAfterBuild = Get-NativeSourceHashes
if (($nativeSourceHashes | ConvertTo-Json -Compress) -ne ($nativeAfterBuild | ConvertTo-Json -Compress)) {
  throw "Native source changed during the build; artifact was not installed."
}

New-Item -ItemType Directory -Path $nativeOutput -Force | Out-Null
$nativeTemporary = Join-Path $nativeOutput ".windows-source-proof-$([Guid]::NewGuid().ToString('N'))"
$nativeTemporaryReceipt = "$nativeTemporary.json"
try {
  Copy-Item -LiteralPath $nativeSource -Destination $nativeTemporary
  $nativeArtifact = Get-Item -LiteralPath $nativeTemporary
  $nativeReceipt = [ordered]@{ format = 1; artifact = "windows-source-proof.exe"; target = $nativeHost;
    bytes = $nativeArtifact.Length; sha256 = (Get-FileHash -LiteralPath $nativeTemporary -Algorithm SHA256).Hash.ToLowerInvariant();
    sourceSha256 = $nativeSourceHashes }
  [IO.File]::WriteAllText($nativeTemporaryReceipt, ($nativeReceipt | ConvertTo-Json -Depth 5) + "`n", [Text.UTF8Encoding]::new($false))
  # Replacing a closed binary avoids exposing a partly copied executable.
  [IO.File]::Move($nativeTemporary, $nativeDestination, $true)
  [IO.File]::Move($nativeTemporaryReceipt, $nativeReceiptFile, $true)
  [ordered]@{ path = $nativeDestination; bytes = $nativeReceipt.bytes; sha256 = $nativeReceipt.sha256;
    target = $nativeHost; receipt = $nativeReceiptFile } | ConvertTo-Json -Compress
} finally {
  foreach ($nativeFile in @($nativeTemporary, $nativeTemporaryReceipt)) {
    if (Test-Path -LiteralPath $nativeFile) { Remove-Item -LiteralPath $nativeFile -Force }
  }
}
