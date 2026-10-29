param(
  [string]$ResultsPath = '',
  [string]$SummaryPath = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $ResultsPath) {
  $ResultsPath = Join-Path $repo 'output\rust-parsing-20261029\results-r2.json'
}
$ResultsPath = (Resolve-Path -LiteralPath $ResultsPath).Path
$outputRoot = Split-Path $ResultsPath
if (-not $SummaryPath) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($ResultsPath)
  $suffix = if ($name -match '-r2$') { '-r2' } else { '' }
  $SummaryPath = Join-Path $outputRoot "summary$suffix.json"
}

function Get-Median {
  param([double[]]$Values)
  $sorted = @($Values | Sort-Object)
  if ($sorted.Count -eq 0) { return $null }
  $middle = [int][Math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 1) { return [double]$sorted[$middle] }
  return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2
}

function Get-Stats {
  param([object[]]$Runs, [string]$Field)
  $values = @($Runs | ForEach-Object { [double]$_.$Field })
  [ordered]@{
    median = Get-Median $values
    min = ($values | Measure-Object -Minimum).Minimum
    max = ($values | Measure-Object -Maximum).Maximum
  }
}

function Select-Runs {
  param([string]$Pattern)
  @($runs | Where-Object { $_.id -match $Pattern })
}

function Summarize-Runs {
  param([object[]]$Selected)
  [ordered]@{
    count = $Selected.Count
    ids = @($Selected | ForEach-Object { $_.id })
    wallMs = Get-Stats $Selected 'wallMs'
    processReportedMs = Get-Stats $Selected 'processReportedMs'
    peakWorkingSetBytes = Get-Stats $Selected 'peakWorkingSetBytes'
    peakPrivateBytes = Get-Stats $Selected 'peakPrivateBytes'
    childPeakWorkingSetBytes = Get-Stats $Selected 'childPeakWorkingSetBytes'
    childPeakPrivateBytes = Get-Stats $Selected 'childPeakPrivateBytes'
    treePeakWorkingSetBytes = Get-Stats $Selected 'treePeakWorkingSetBytes'
    treePeakPrivateBytes = Get-Stats $Selected 'treePeakPrivateBytes'
    stdoutBytes = Get-Stats $Selected 'stdoutBytes'
    helperRustProcessMs = Get-Stats $Selected 'helperRustProcessMs'
    helperRustStdoutBytes = Get-Stats $Selected 'helperRustStdoutBytes'
  }
}

function Select-One {
  param([string]$Id)
  $runs | Where-Object { $_.id -ceq $Id } | Select-Object -First 1
}

function Add-Ratio {
  param([object]$Target)
  $Target.wallRatioNodeOverRust = $Target.node.wallMs.median / $Target.rust.wallMs.median
  $Target.processRatioNodeOverRust =
    $Target.node.processReportedMs.median / $Target.rust.processReportedMs.median
}

$result = Get-Content -LiteralPath $ResultsPath -Raw | ConvertFrom-Json
$runs = @($result.runs)
$inputsName = if ($result.schemaVersion -eq 2) { 'inputs-r2.json' } else { 'inputs.json' }
$scanName = if ($result.schemaVersion -eq 2) { 'input-scan-r2.json' } else { 'input-scan.json' }
$inputs = Get-Content -LiteralPath (Join-Path $outputRoot $inputsName) -Raw | ConvertFrom-Json
$inputScan = Get-Content -LiteralPath (Join-Path $outputRoot $scanName) -Raw | ConvertFrom-Json

$summary = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  resultsPath = $ResultsPath
  environment = $result.environment
  inputs = [ordered]@{
    sourceCount = $inputs.fileCount
    compressedBytes = $inputs.compressedBytes
    dshDecompressedBytes = $inputScan.decompressedBytes
    frameCount = $inputScan.frameCount
    failedFrames = $inputScan.failedFrames
    actualMaxCompressedBytes = $inputs.maxFile.compressedBytes
    actualMaxDecompressedBytes = $inputs.maxFile.measuredDecompressedBytes
  }
  parity = $result.parity
  totals = $result.totals
  firstRound = [ordered]@{
    startup = [ordered]@{
      nodeFormal = Select-One 'first-startup-node-formal'
      nodeDefaultV8 = Select-One 'first-startup-node-default'
      rust = Select-One 'first-startup-rust'
    }
    parser = [ordered]@{
      fullNodeFormal = Select-One 'first-full-node-parser-formal'
      fullRust = Select-One 'first-full-rust-parser'
      maxNodeFormal = Select-One 'first-max-node-parser-formal'
      maxRust = Select-One 'first-max-rust-parser'
    }
    semantic = [ordered]@{
      fullNodeFormal = Select-One 'first-full-node-semantic-formal'
      fullRust = Select-One 'first-full-rust-semantic'
      maxNodeFormal = Select-One 'first-max-node-semantic-formal'
      maxRust = Select-One 'first-max-rust-semantic'
    }
  }
  warm = [ordered]@{
    parser = [ordered]@{
      fullNodeFormal = Summarize-Runs (Select-Runs '^warm\d+-full-node-parser-formal$')
      fullNodeDefaultV8 = Summarize-Runs (Select-Runs '^warm\d+-full-node-parser-default-v8$')
      fullRust = Summarize-Runs (Select-Runs '^warm\d+-full-rust-parser$')
      maxNodeFormal = Summarize-Runs (Select-Runs '^warm\d+-max-node-parser-formal$')
      maxRust = Summarize-Runs (Select-Runs '^warm\d+-max-rust-parser$')
      helper = Summarize-Runs (Select-Runs '^warm\d+-full-node-helper-parser-formal$')
    }
    semantic = [ordered]@{
      fullNodeFormal = Summarize-Runs (Select-Runs '^warm\d+-full-node-semantic-formal$')
      fullNodeDefaultV8 = Summarize-Runs (Select-Runs '^warm\d+-full-node-semantic-default-v8$')
      fullRust = Summarize-Runs (Select-Runs '^warm\d+-full-rust-semantic$')
      maxNodeFormal = Summarize-Runs (Select-Runs '^warm\d+-max-node-semantic-formal$')
      maxRust = Summarize-Runs (Select-Runs '^warm\d+-max-rust-semantic$')
      helper = Summarize-Runs (Select-Runs '^warm\d+-full-node-helper-semantic-formal$')
    }
    startup = [ordered]@{
      nodeFormal = Summarize-Runs (Select-Runs '^warm\d+-startup-node-formal$')
      nodeDefaultV8 = Summarize-Runs (Select-Runs '^warm\d+-startup-node-default$')
      rust = Summarize-Runs (Select-Runs '^warm\d+-startup-rust$')
    }
  }
}

foreach ($mode in @('parser', 'semantic')) {
  $modeSummary = $summary.warm[$mode]
  foreach ($workload in @('full', 'max')) {
    $pair = [ordered]@{
      node = $modeSummary["${workload}NodeFormal"]
      rust = $modeSummary["${workload}Rust"]
    }
    Add-Ratio $pair
    $modeSummary["${workload}Ratio"] = $pair
  }

  $formal = $modeSummary.fullNodeFormal
  $default = $modeSummary.fullNodeDefaultV8
  $rust = $modeSummary.fullRust
  $helper = $modeSummary.helper
  $modeSummary.helperOverhead = [ordered]@{
    wallMs = $helper.wallMs.median - $rust.wallMs.median
    wallPercentOfDirectRust = (($helper.wallMs.median / $rust.wallMs.median) - 1) * 100
    processReportedMs = $helper.processReportedMs.median - $rust.processReportedMs.median
    processPercentOfDirectRust =
      (($helper.processReportedMs.median / $rust.processReportedMs.median) - 1) * 100
    helperRustProcessMs = $helper.helperRustProcessMs.median
    directRustProcessMs = $rust.processReportedMs.median
  }
  $modeSummary.defaultV8Difference = [ordered]@{
    wallMs = $default.wallMs.median - $formal.wallMs.median
    percentVersusFormal = (($default.wallMs.median / $formal.wallMs.median) - 1) * 100
    peakWorkingSetBytes = $default.peakWorkingSetBytes.median - $formal.peakWorkingSetBytes.median
    peakPrivateBytes = $default.peakPrivateBytes.median - $formal.peakPrivateBytes.median
  }
  $modeSummary.throughput = [ordered]@{
    nodeFormalDecompressedMiBPerSecond =
      ($inputScan.decompressedBytes / 1MB) / ($formal.wallMs.median / 1000)
    rustDecompressedMiBPerSecond =
      ($inputScan.decompressedBytes / 1MB) / ($rust.wallMs.median / 1000)
  }
}

$parser = $summary.warm.parser
$semantic = $summary.warm.semantic
$summary.semanticDigestOverhead = [ordered]@{
  nodeFormalWallMs = $semantic.fullNodeFormal.wallMs.median - $parser.fullNodeFormal.wallMs.median
  rustWallMs = $semantic.fullRust.wallMs.median - $parser.fullRust.wallMs.median
}

$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $SummaryPath -Encoding utf8
Write-Output $SummaryPath
