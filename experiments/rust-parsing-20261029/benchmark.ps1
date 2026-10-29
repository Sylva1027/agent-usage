param(
  [switch]$SkipBuild,
  [string]$SourcePath = 'C:\Users\Silver\AppData\Local\Temp\codex-local-summary-FvxvXj\endurance\source\src\dsh-usage.js',
  [ValidateRange(3, 20)][int]$WarmPairs = 3
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$experiment = $PSScriptRoot
$output = Join-Path $repo 'output\rust-parsing-20261029'
$raw = Join-Path $output 'raw-r2'
$fixture = Join-Path $experiment 'fixture\session.v4.jsonl.zstd'
$target = Join-Path $repo '.codex-usage\local-summary-adoption-20261029\rust-target'
$dshRoot = 'C:\Users\Silver\AppData\Local\Temp\codex-local-summary-FvxvXj\inputs\home\.dsh\sessions'
$maxFile = 'C:\Users\Silver\AppData\Local\Temp\codex-local-summary-FvxvXj\inputs\home\.dsh\sessions\--E-12~0020AI-rea--\session-9b728039-0a64-424f-8ab7-78bada98f4dd\session.v4.jsonl.zstd'
$zstdBin = 'C:\Users\Silver\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin'
$zstdDll = Join-Path $zstdBin 'zstd.dll'
$expectedSourceHash = 'fb68ed271387d075241c1e2632b4638f567d5c74a09c2c21b285d033393c0fd4'
$expectedFixtureDigest = '68c411e7b9a0ad2288cba12f133a3375d6bdd563adae7d5eb9e9d73d3205d331'
$formalNodeFlags = @('--max-old-space-size=224', '--max-semi-space-size=4')
$env:PATH = "$zstdBin;$env:PATH"

New-Item -ItemType Directory -Force -Path $output, $raw, (Join-Path $experiment 'fixture') | Out-Null
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
if (-not (Test-Path -LiteralPath $zstdDll)) { throw "zstd DLL missing: $zstdDll" }

if (-not $SkipBuild) {
  cargo build --manifest-path (Join-Path $experiment 'Cargo.toml') --release --offline --target-dir $target
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed: $LASTEXITCODE" }
}

$rust = Join-Path $target 'release\dsh-rust-parsing.exe'
$node = (Get-Command node).Source
$pwsh = (Get-Command pwsh).Source
$nodeBaseline = Join-Path $experiment 'node-baseline.mjs'
$nodeHelper = Join-Path $experiment 'node-helper.mjs'

& $node (Join-Path $experiment 'make-fixture.mjs') $fixture
if ($LASTEXITCODE -ne 0) { throw "fixture generation failed: $LASTEXITCODE" }

$allFiles = @(
  Get-ChildItem -LiteralPath $dshRoot -Recurse -File -Filter 'session.v4.jsonl.zstd' |
    Sort-Object FullName
)
if ($allFiles.Count -ne 160) { throw "expected 160 DSH files, found $($allFiles.Count)" }
if (-not (Test-Path -LiteralPath $maxFile)) { throw "max file missing" }

[ordered]@{
  dshRoot = $dshRoot
  fileCount = $allFiles.Count
  compressedBytes = ($allFiles | Measure-Object Length -Sum).Sum
  maxFile = [ordered]@{
    path = $maxFile
    compressedBytes = (Get-Item -LiteralPath $maxFile).Length
    measuredDecompressedBytes = 53927502
  }
  files = @($allFiles.FullName)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'inputs-r2.json') -Encoding utf8

& $node (Join-Path $experiment 'inspect-inputs.mjs') $dshRoot (Join-Path $output 'input-scan-r2.json')
if ($LASTEXITCODE -ne 0) { throw "input scan failed: $LASTEXITCODE" }

$runs = [System.Collections.Generic.List[object]]::new()
function Invoke-MeasuredRun {
  param(
    [string]$Id,
    [string]$Executable,
    [string[]]$Arguments,
    [string]$Mode,
    [string]$Config,
    [string]$ChildPidPath = ''
  )
  $stdoutPath = Join-Path $raw "$Id.stdout.json"
  $stderrPath = Join-Path $raw "$Id.stderr.log"
  $metricsPath = Join-Path $raw "$Id.metrics.json"
  & $pwsh -NoProfile -File (Join-Path $experiment 'measure.ps1') `
    -Executable $Executable `
    -ArgumentsJson (ConvertTo-Json -InputObject @($Arguments) -Compress) `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -MetricsPath $metricsPath `
    -ChildPidPath $ChildPidPath
  if ($LASTEXITCODE -ne 0) { throw "measurement wrapper failed for $Id" }
  $metrics = Get-Content -LiteralPath $metricsPath -Raw | ConvertFrom-Json
  if ($metrics.exitCode -ne 0) {
    throw "run $Id failed with exit $($metrics.exitCode): $(Get-Content -LiteralPath $stderrPath -Raw)"
  }
  $payload = Get-Content -LiteralPath $stdoutPath -Raw | ConvertFrom-Json
  $record = [ordered]@{
    id = $Id
    mode = $Mode
    config = $Config
    executable = $Executable
    arguments = $Arguments
    wallMs = [double]$metrics.wallMs
    processReportedMs = [double]$payload.elapsedMs
    peakWorkingSetBytes = [long]$metrics.peakWorkingSetBytes
    peakPrivateBytes = [long]$metrics.peakPrivateBytes
    stdoutBytes = [long]$metrics.stdoutBytes
    childPeakWorkingSetBytes = [long]$metrics.childPeakWorkingSetBytes
    childPeakPrivateBytes = [long]$metrics.childPeakPrivateBytes
    treePeakWorkingSetBytes = [long]$metrics.treePeakWorkingSetBytes
    treePeakPrivateBytes = [long]$metrics.treePeakPrivateBytes
  }
  if ($payload.helper) {
    $record.helperRustProcessMs = [double]$payload.helper.rustProcessMs
    $record.helperRustStdoutBytes = [long]$payload.helper.stdoutBytes
    $record.helperRustStderrBytes = [long]$payload.helper.stderrBytes
  }
  $runs.Add([pscustomobject]$record)
  return $payload
}

function Values-Match {
  param($Left, $Right)
  if ($null -eq $Left -and $null -eq $Right) { return $true }
  return ([string]$Left -ceq [string]$Right)
}

function Compare-Payload {
  param($NodePayload, $RustPayload, [string]$Mode)
  if ($NodePayload.mode -cne $Mode -or $RustPayload.mode -cne $Mode) { return $false }
  if ($NodePayload.files.Count -ne $RustPayload.files.Count) { return $false }
  for ($index = 0; $index -lt $NodePayload.files.Count; $index += 1) {
    $nodeFile = $NodePayload.files[$index]
    $rustFile = $RustPayload.files[$index]
    foreach ($field in @(
      'path',
      'bytes',
      'rows',
      'usageRows',
      'nonzeroUsageEvents',
      'streamItems',
      'headerRows'
    )) {
      if (-not (Values-Match $nodeFile.$field $rustFile.$field)) { return $false }
    }
    foreach ($field in @(
      'usageInputTokens',
      'usageCachedTokens',
      'usageCacheWriteTokens',
      'usageOutputTokens',
      'usageTotalTokens'
    )) {
      if (-not (Values-Match $nodeFile.parser.$field $rustFile.parser.$field)) { return $false }
    }
    if (($nodeFile.warnings -join "`n") -cne ($rustFile.warnings -join "`n")) { return $false }
    if ($Mode -eq 'semantic' -and -not (Values-Match $nodeFile.digest $rustFile.digest)) {
      return $false
    }
    if ($Mode -eq 'parser' -and $null -ne $nodeFile.digest) { return $false }
    if ($Mode -eq 'parser' -and $null -ne $rustFile.digest) { return $false }
  }
  return $true
}

function Assert-Parity {
  param($NodePayload, $RustPayload, [string]$Mode, [string]$Label)
  if (-not (Compare-Payload $NodePayload $RustPayload $Mode)) {
    throw "$Label Node/Rust $Mode payloads differ"
  }
}

function Node-Arguments {
  param(
    [string]$Mode,
    [string[]]$Tail,
    [switch]$DefaultV8
  )
  $flags = if ($DefaultV8) { @() } else { @($formalNodeFlags) }
  return @($flags) + @($nodeBaseline, '--mode', $Mode, '--source', $SourcePath) + @($Tail)
}

function Rust-Arguments {
  param([string]$Mode, [string[]]$Tail)
  return @('--mode', $Mode) + @($Tail)
}

$fixturePayloads = @{}
foreach ($mode in @('parser', 'semantic')) {
  $nodeFixture = Invoke-MeasuredRun `
    "fixture-node-$mode-formal" `
    $node `
    (Node-Arguments -Mode $mode -Tail @('--file', $fixture)) `
    $mode `
    'formal-v8'
  $rustFixture = Invoke-MeasuredRun `
    "fixture-rust-$mode" `
    $rust `
    (Rust-Arguments -Mode $mode -Tail @('--file', $fixture)) `
    $mode `
    'rust'
  Assert-Parity $nodeFixture $rustFixture $mode 'fixture'
  $fixturePayloads[$mode] = [ordered]@{
    node = $nodeFixture
    rust = $rustFixture
  }
}
$fixtureDigest = $fixturePayloads['semantic'].node.files[0].digest
if ($fixtureDigest -cne $expectedFixtureDigest) {
  throw "fixture semantic digest changed: $fixtureDigest"
}

$firstPayloads = @{}
foreach ($mode in @('parser', 'semantic')) {
  $fullNode = Invoke-MeasuredRun `
    "first-full-node-$mode-formal" `
    $node `
    (Node-Arguments -Mode $mode -Tail @('--root', $dshRoot)) `
    $mode `
    'formal-v8'
  $fullRust = Invoke-MeasuredRun `
    "first-full-rust-$mode" `
    $rust `
    (Rust-Arguments -Mode $mode -Tail @('--root', $dshRoot)) `
    $mode `
    'rust'
  Assert-Parity $fullNode $fullRust $mode 'first full corpus'

  $maxNode = Invoke-MeasuredRun `
    "first-max-node-$mode-formal" `
    $node `
    (Node-Arguments -Mode $mode -Tail @('--file', $maxFile)) `
    $mode `
    'formal-v8'
  $maxRust = Invoke-MeasuredRun `
    "first-max-rust-$mode" `
    $rust `
    (Rust-Arguments -Mode $mode -Tail @('--file', $maxFile)) `
    $mode `
    'rust'
  Assert-Parity $maxNode $maxRust $mode 'first max file'

  $firstPayloads[$mode] = [ordered]@{
    fullNode = $fullNode
    fullRust = $fullRust
    maxNode = $maxNode
    maxRust = $maxRust
  }
}

$startupNodeFormalFirst = Invoke-MeasuredRun `
  'first-startup-node-formal' `
  $node `
  (@($formalNodeFlags) + @($nodeBaseline, '--startup')) `
  'startup' `
  'formal-v8'
$startupNodeDefaultFirst = Invoke-MeasuredRun `
  'first-startup-node-default' `
  $node `
  @($nodeBaseline, '--startup') `
  'startup' `
  'default-v8'
$startupRustFirst = Invoke-MeasuredRun `
  'first-startup-rust' `
  $rust `
  @('--startup') `
  'startup' `
  'rust'
if ($startupRustFirst.zstdVersion -cne '1.5.7') {
  throw "unexpected zstd version: $($startupRustFirst.zstdVersion)"
}

for ($round = 1; $round -le $WarmPairs; $round += 1) {
  $nodeFirst = ($round % 2 -eq 1)
  foreach ($mode in @('parser', 'semantic')) {
    $fullNodeArgs = Node-Arguments -Mode $mode -Tail @('--root', $dshRoot)
    $fullRustArgs = Rust-Arguments -Mode $mode -Tail @('--root', $dshRoot)
    if ($nodeFirst) {
      $fullNode = Invoke-MeasuredRun "warm$round-full-node-$mode-formal" $node $fullNodeArgs $mode 'formal-v8'
      $fullRust = Invoke-MeasuredRun "warm$round-full-rust-$mode" $rust $fullRustArgs $mode 'rust'
    } else {
      $fullRust = Invoke-MeasuredRun "warm$round-full-rust-$mode" $rust $fullRustArgs $mode 'rust'
      $fullNode = Invoke-MeasuredRun "warm$round-full-node-$mode-formal" $node $fullNodeArgs $mode 'formal-v8'
    }
    Assert-Parity $fullNode $fullRust $mode "warm$round full corpus"

    $maxNodeArgs = Node-Arguments -Mode $mode -Tail @('--file', $maxFile)
    $maxRustArgs = Rust-Arguments -Mode $mode -Tail @('--file', $maxFile)
    if ($nodeFirst) {
      $maxNode = Invoke-MeasuredRun "warm$round-max-node-$mode-formal" $node $maxNodeArgs $mode 'formal-v8'
      $maxRust = Invoke-MeasuredRun "warm$round-max-rust-$mode" $rust $maxRustArgs $mode 'rust'
    } else {
      $maxRust = Invoke-MeasuredRun "warm$round-max-rust-$mode" $rust $maxRustArgs $mode 'rust'
      $maxNode = Invoke-MeasuredRun "warm$round-max-node-$mode-formal" $node $maxNodeArgs $mode 'formal-v8'
    }
    Assert-Parity $maxNode $maxRust $mode "warm$round max file"

    $childPidPath = Join-Path $raw "warm$round-helper-$mode.child.pid"
    Remove-Item -LiteralPath $childPidPath -Force -ErrorAction SilentlyContinue
    $helperArgs = @(
      $formalNodeFlags
      $nodeHelper,
      '--rust', $rust,
      '--mode', $mode,
      '--root', $dshRoot,
      '--child-pid-file', $childPidPath
    )
    $helper = Invoke-MeasuredRun `
      "warm$round-full-node-helper-$mode-formal" `
      $node `
      $helperArgs `
      $mode `
      'formal-v8-helper' `
      $childPidPath
    Assert-Parity $helper.result $fullRust $mode "warm$round helper"

    $defaultNode = Invoke-MeasuredRun `
      "warm$round-full-node-$mode-default-v8" `
      $node `
      (Node-Arguments -Mode $mode -Tail @('--root', $dshRoot) -DefaultV8) `
      $mode `
      'default-v8'
    Assert-Parity $defaultNode $fullRust $mode "warm$round default V8"
  }

  $startupNodeArgs = @($formalNodeFlags) + @($nodeBaseline, '--startup')
  $startupDefaultArgs = @($nodeBaseline, '--startup')
  if ($nodeFirst) {
    $startupNode = Invoke-MeasuredRun "warm$round-startup-node-formal" $node $startupNodeArgs 'startup' 'formal-v8'
    $startupRust = Invoke-MeasuredRun "warm$round-startup-rust" $rust @('--startup') 'startup' 'rust'
  } else {
    $startupRust = Invoke-MeasuredRun "warm$round-startup-rust" $rust @('--startup') 'startup' 'rust'
    $startupNode = Invoke-MeasuredRun "warm$round-startup-node-formal" $node $startupNodeArgs 'startup' 'formal-v8'
  }
  $null = Invoke-MeasuredRun "warm$round-startup-node-default" $node $startupDefaultArgs 'startup' 'default-v8'
}

$sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$rustHash = (Get-FileHash -LiteralPath $rust -Algorithm SHA256).Hash.ToLowerInvariant()
$zstdHash = (Get-FileHash -LiteralPath $zstdDll -Algorithm SHA256).Hash.ToLowerInvariant()
$inputScan = Get-Content -LiteralPath (Join-Path $output 'input-scan-r2.json') -Raw | ConvertFrom-Json
$nodeFullParser = $firstPayloads['parser'].fullNode
$nodeFullSemantic = $firstPayloads['semantic'].fullNode
$results = [ordered]@{
  schemaVersion = 2
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  warmPairs = $WarmPairs
  environment = [ordered]@{
    node = (& node --version)
    nodeV8 = (& node -p 'process.versions.v8')
    cargo = (& cargo --version)
    rustc = (& rustc --version)
    powershell = $PSVersionTable.PSVersion.ToString()
    formalNodeFlags = $formalNodeFlags
    defaultV8Flags = @()
    sourcePath = $SourcePath
    sourceSha256 = $sourceHash
    sourceMatchesR1 = ($sourceHash -eq $expectedSourceHash)
    rustBinary = $rust
    rustBinarySha256 = $rustHash
    zstdVersion = $startupRustFirst.zstdVersion
    zstdLibrary = $zstdDll
    zstdLibraryBytes = (Get-Item -LiteralPath $zstdDll).Length
    zstdLibrarySha256 = $zstdHash
    zstdCrateCache = 'missing'
    serdeJsonCache = 'C:\Users\Silver\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\serde_json-1.0.138'
  }
  corpus = [ordered]@{
    files = $inputScan.count
    compressedBytes = $inputScan.compressedBytes
    decompressedBytes = $inputScan.decompressedBytes
    frameCount = $inputScan.frameCount
    failedFrames = $inputScan.failedFrames
    actualMax = $inputScan.largestDecompressed
    rows = $nodeFullParser.totals.rows
    usageRows = $nodeFullParser.totals.usageRows
    parser = $nodeFullParser.totals.parser
  }
  parity = [ordered]@{
    fixtureParser = Compare-Payload $fixturePayloads['parser'].node $fixturePayloads['parser'].rust 'parser'
    fixtureSemantic = Compare-Payload $fixturePayloads['semantic'].node $fixturePayloads['semantic'].rust 'semantic'
    fixtureSemanticDigest = $fixtureDigest
    firstFullParser = Compare-Payload $firstPayloads['parser'].fullNode $firstPayloads['parser'].fullRust 'parser'
    firstFullSemantic = Compare-Payload $firstPayloads['semantic'].fullNode $firstPayloads['semantic'].fullRust 'semantic'
    firstMaxParser = Compare-Payload $firstPayloads['parser'].maxNode $firstPayloads['parser'].maxRust 'parser'
    firstMaxSemantic = Compare-Payload $firstPayloads['semantic'].maxNode $firstPayloads['semantic'].maxRust 'semantic'
  }
  totals = [ordered]@{
    parser = $nodeFullParser.totals
    semantic = $nodeFullSemantic.totals
  }
  runs = $runs
}
$results | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $output 'results-r2.json') -Encoding utf8

Write-Output "R2 parity OK; results: $(Join-Path $output 'results-r2.json')"
