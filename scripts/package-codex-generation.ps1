[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Engine,

    [Parameter(Mandatory)]
    [string]$Helpers,

    [Parameter(Mandatory)]
    [string]$Destination,

    [Parameter(Mandatory)]
    [string]$Version,

    [Parameter(Mandatory)]
    [string]$UpstreamCommit,

    [Parameter(Mandatory)]
    [string]$Patch,

    [string]$Target = 'x86_64-pc-windows-msvc',
    [string]$Variant = 'codex'
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param([System.Collections.IDictionary]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 12 -Compress))
}

function Write-Failure {
    param(
        [string]$Code,
        [string]$Message
    )
    Write-Result ([ordered]@{
        ok = $false
        error = [ordered]@{
            code = $Code
            message = $Message
        }
    })
}

function Get-AbsoluteFile {
    param(
        [string]$Path,
        [string]$Name
    )
    if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Name must be an absolute path: $Path"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name does not exist or is not a file: $Path"
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-JsonFile {
    param(
        [string]$Path,
        [System.Collections.IDictionary]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText(
        $Path,
        $json + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
}

$createdDestinationPath = $null

try {
    $enginePath = Get-AbsoluteFile -Path $Engine -Name 'Engine'
    if ([System.IO.Path]::GetFileName($enginePath) -ne 'codex.exe') {
        throw "Engine must be named codex.exe: $enginePath"
    }

    if (-not [System.IO.Path]::IsPathFullyQualified($Destination)) {
        throw "Destination must be an absolute path: $Destination"
    }
    $destinationPath = [System.IO.Path]::GetFullPath($Destination).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (Test-Path -LiteralPath $destinationPath) {
        throw "Destination already exists: $destinationPath"
    }

    $patchPath = Get-AbsoluteFile -Path $Patch -Name 'Patch'
    if ($UpstreamCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'UpstreamCommit must be a 40-character Git commit SHA.'
    }
    if ([string]::IsNullOrWhiteSpace($Version)) {
        throw 'Version must not be empty.'
    }
    if ([string]::IsNullOrWhiteSpace($Target)) {
        throw 'Target must not be empty.'
    }
    if ([string]::IsNullOrWhiteSpace($Variant)) {
        throw 'Variant must not be empty.'
    }

    $helperLayout = @{
        'codex-code-mode-host.exe' = [ordered]@{
            path = 'bin/codex-code-mode-host.exe'
            role = 'code_mode_host'
            required = $true
        }
        'codex-command-runner.exe' = [ordered]@{
            path = 'codex-resources/codex-command-runner.exe'
            role = 'command_runner'
            required = $true
        }
        'codex-windows-sandbox-setup.exe' = [ordered]@{
            path = 'codex-resources/codex-windows-sandbox-setup.exe'
            role = 'windows_sandbox_setup'
            required = $true
        }
        'rg.exe' = [ordered]@{
            path = 'codex-path/rg.exe'
            role = 'ripgrep'
            required = $true
        }
        'codex-windows-sandbox-service.exe' = [ordered]@{
            path = 'codex-resources/codex-windows-sandbox-service.exe'
            role = 'windows_sandbox_service'
            required = $false
        }
    }

    $helperPaths = @{}
    $helperItems = @(
        $Helpers -split ';' |
            ForEach-Object { $_.Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($helperItems.Count -eq 0) {
        throw 'Helpers must contain at least one absolute file path.'
    }
    foreach ($helper in $helperItems) {
        $helperPath = Get-AbsoluteFile -Path $helper -Name 'Helper'
        $helperName = [System.IO.Path]::GetFileName($helperPath)
        if (-not $helperLayout.ContainsKey($helperName)) {
            throw "Unsupported helper filename: $helperName"
        }
        if ($helperPaths.ContainsKey($helperName)) {
            throw "Duplicate helper filename: $helperName"
        }
        $helperPaths[$helperName] = $helperPath
    }

    foreach ($requiredName in @(
        'codex-code-mode-host.exe',
        'codex-command-runner.exe',
        'codex-windows-sandbox-setup.exe',
        'rg.exe'
    )) {
        if (-not $helperPaths.ContainsKey($requiredName)) {
            throw "Missing required helper: $requiredName"
        }
    }

    $destinationParent = Split-Path -Parent $destinationPath
    if ([string]::IsNullOrWhiteSpace($destinationParent)) {
        throw "Destination has no parent directory: $destinationPath"
    }
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    New-Item -ItemType Directory -Path $destinationPath | Out-Null
    $createdDestinationPath = $destinationPath

    $sourceByLayout = @{}
    $engineLayout = 'bin/codex.exe'
    $engineTarget = Join-Path $destinationPath $engineLayout
    New-Item -ItemType Directory -Path (Split-Path -Parent $engineTarget) -Force | Out-Null
    Copy-Item -LiteralPath $enginePath -Destination $engineTarget
    $sourceByLayout[$engineLayout] = [ordered]@{
        source = $enginePath
        role = 'engine'
        required = $true
    }

    foreach ($helperName in ($helperPaths.Keys | Sort-Object)) {
        $layout = $helperLayout[$helperName]
        $targetPath = Join-Path $destinationPath $layout.path
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $helperPaths[$helperName] -Destination $targetPath
        $sourceByLayout[$layout.path] = [ordered]@{
            source = $helperPaths[$helperName]
            role = $layout.role
            required = $layout.required
        }
    }

    $descriptor = [ordered]@{
        layoutVersion = 1
        version = $Version
        target = $Target
        variant = $Variant
        entrypoint = 'bin/codex.exe'
        resourcesDir = 'codex-resources'
        pathDir = 'codex-path'
    }
    $descriptorPath = Join-Path $destinationPath 'codex-package.json'
    Write-JsonFile -Path $descriptorPath -Value $descriptor
    $sourceByLayout['codex-package.json'] = [ordered]@{
        source = 'generated:codex-package.json'
        role = 'package_descriptor'
        required = $true
    }

    $manifestName = 'codex-generation-manifest.json'
    $payloadFiles = @(
        Get-ChildItem -LiteralPath $destinationPath -File -Recurse |
            Where-Object Name -ne $manifestName |
            Sort-Object FullName
    )
    $fileEntries = @(
        foreach ($file in $payloadFiles) {
            $relativePath = [System.IO.Path]::GetRelativePath($destinationPath, $file.FullName).Replace('\', '/')
            $source = $sourceByLayout[$relativePath]
            if ($null -eq $source) {
                throw "No provenance entry for package file: $relativePath"
            }
            [ordered]@{
                path = $relativePath
                role = $source.role
                required = [bool]$source.required
                source = $source.source
                bytes = [long]$file.Length
                sha256 = Get-Sha256 -Path $file.FullName
            }
        }
    )

    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        package = [ordered]@{
            version = $Version
            target = $Target
            variant = $Variant
            upstreamCommit = $UpstreamCommit.ToLowerInvariant()
            producerPatch = [ordered]@{
                name = [System.IO.Path]::GetFileName($patchPath)
                bytes = [long](Get-Item -LiteralPath $patchPath).Length
                sha256 = Get-Sha256 -Path $patchPath
            }
            descriptor = $descriptor
        }
        files = $fileEntries
        manifest = [ordered]@{
            path = $manifestName
            filesExcludedFromIntegrityList = @($manifestName)
        }
    }
    $manifestPath = Join-Path $destinationPath $manifestName
    Write-JsonFile -Path $manifestPath -Value $manifest

    $actualPayloadPaths = @(
        Get-ChildItem -LiteralPath $destinationPath -File -Recurse |
            Where-Object Name -ne $manifestName |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($destinationPath, $_.FullName).Replace('\', '/')
            } |
            Sort-Object
    )
    $expectedPayloadPaths = @($fileEntries.path | Sort-Object)
    if (Compare-Object -ReferenceObject $expectedPayloadPaths -DifferenceObject $actualPayloadPaths) {
        throw 'Package file set does not match the manifest after copying.'
    }
    foreach ($entry in $fileEntries) {
        $path = Join-Path $destinationPath ($entry.path.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        $file = Get-Item -LiteralPath $path
        if ($file.Length -ne $entry.bytes -or (Get-Sha256 -Path $path) -ne $entry.sha256) {
            throw "Staged file failed integrity verification: $($entry.path)"
        }
    }

    $finalEnginePath = Join-Path $destinationPath $engineLayout
    Write-Result ([ordered]@{
        ok = $true
        packageRoot = $destinationPath
        engine = [ordered]@{
            path = $finalEnginePath
            bytes = [long](Get-Item -LiteralPath $finalEnginePath).Length
            sha256 = Get-Sha256 -Path $finalEnginePath
        }
        manifest = [ordered]@{
            path = Join-Path $destinationPath $manifestName
            bytes = [long](Get-Item -LiteralPath (Join-Path $destinationPath $manifestName)).Length
            sha256 = Get-Sha256 -Path (Join-Path $destinationPath $manifestName)
        }
        fileCount = $fileEntries.Count
        upstreamCommit = $UpstreamCommit.ToLowerInvariant()
        producerPatchSha256 = $manifest.package.producerPatch.sha256
    })
    $createdDestinationPath = $null
}
catch {
    if ($null -ne $createdDestinationPath -and (Test-Path -LiteralPath $createdDestinationPath)) {
        $resolvedCreatedPath = [System.IO.Path]::GetFullPath($createdDestinationPath)
        $resolvedExpectedPath = [System.IO.Path]::GetFullPath($destinationPath)
        if (
            $resolvedCreatedPath -ieq $resolvedExpectedPath
        ) {
            Remove-Item -LiteralPath $resolvedCreatedPath -Recurse -Force
        }
    }
    Write-Failure -Code 'package_failed' -Message ("{0} (line {1})" -f $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber)
    exit 1
}
