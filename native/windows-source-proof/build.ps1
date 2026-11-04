[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "windows-source-proof must be built on Windows."
}

$cargo = Get-Command cargo -ErrorAction Stop
$manifest = Join-Path $PSScriptRoot "Cargo.toml"
$releaseDirectory = Join-Path $PSScriptRoot "target/release"
$source = Join-Path $releaseDirectory "windows-source-proof.exe"
$destinationDirectory = Join-Path $PSScriptRoot "bin"
$destination = Join-Path $destinationDirectory "windows-source-proof.exe"

& $cargo.Source build --manifest-path $manifest --release --locked
if ($LASTEXITCODE -ne 0) {
  throw "cargo build failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "release helper was not produced at $source"
}

New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force

$artifact = Get-Item -LiteralPath $destination
[ordered]@{
  path = $artifact.FullName
  bytes = $artifact.Length
  sha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json -Compress
