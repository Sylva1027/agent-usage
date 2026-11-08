[CmdletBinding()]
param(
  [string]$ResultDir,[int]$ServicePid,[int]$RunnerPid,[string]$StopFile,[string]$StateDir,[string]$TempDir,
  [ValidateSet(250,500)][int]$SampleIntervalMilliseconds=250,[switch]$SelfTest
)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major-lt7){throw 'Use pwsh 7.'}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'b2-attribution-resource.ps1') -Raw
$marker='    $rows.Add([pscustomobject][ordered]@{'
if(($source.Split($marker).Count)-ne2){throw 'Resource process-row binding changed.'}
$source=$source.Replace($marker, @'
    $handleCount=$null
    try{$handleCount=[long]$process.HandleCount}catch{}
    $rows.Add([pscustomobject][ordered]@{
      handleCount=$handleCount
'@)
& ([scriptblock]::Create($source)) @PSBoundParameters
