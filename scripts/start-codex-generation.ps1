$ErrorActionPreference = 'Stop'
$rawArguments = @($args)
$Mode = $null
$PackageRoot = $null
$LocalAppDataRoot = $null
$DesktopExecutable = $null
$DesktopArguments = @()
$IdentityTimeoutMilliseconds = 15000
$Arguments = @()

function Write-Result {
    param([System.Collections.IDictionary]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 12 -Compress))
}

function Write-Failure {
    param(
        [string]$Code,
        [string]$Message,
        [System.Collections.IDictionary]$Details
    )
    $result = [ordered]@{
        ok = $false
        error = [ordered]@{
            code = $Code
            message = $Message
        }
    }
    if ($null -ne $Details) {
        foreach ($key in $Details.Keys) {
            $result[$key] = $Details[$key]
        }
    }
    Write-Result $result
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OrdinaryLocalAppDataRoot {
    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates.Add($env:LOCALAPPDATA)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $candidates.Add((Join-Path $env:USERPROFILE 'AppData\Local'))
    }
    $profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (-not [string]::IsNullOrWhiteSpace($profilePath)) {
        $candidates.Add((Join-Path $profilePath 'AppData\Local'))
    }

    foreach ($candidate in $candidates) {
        if (-not [System.IO.Path]::IsPathFullyQualified($candidate)) {
            continue
        }
        $fullPath = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
        if ($fullPath -match '(?i)[\\/]AppData[\\/]Local[\\/]Packages[\\/]') {
            continue
        }
        if (Test-Path -LiteralPath $fullPath -PathType Container) {
            return $fullPath
        }
    }
    throw 'Could not resolve the ordinary user LocalAppData directory.'
}

function Get-DefaultPackageRoot {
    param([string]$ExplicitLocalAppDataRoot)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitLocalAppDataRoot)) {
        if (-not [System.IO.Path]::IsPathFullyQualified($ExplicitLocalAppDataRoot)) {
            throw "LocalAppDataRoot must be an absolute path: $ExplicitLocalAppDataRoot"
        }
        if (-not (Test-Path -LiteralPath $ExplicitLocalAppDataRoot -PathType Container)) {
            throw "LocalAppDataRoot does not exist: $ExplicitLocalAppDataRoot"
        }
        $localAppDataRoot = [System.IO.Path]::GetFullPath($ExplicitLocalAppDataRoot)
    } else {
        $localAppDataRoot = Get-OrdinaryLocalAppDataRoot
    }
    $versionsRoot = Join-Path $localAppDataRoot 'Programs\CodexTps\versions'
    if (-not (Test-Path -LiteralPath $versionsRoot -PathType Container)) {
        throw "No side-by-side Codex package was found under: $versionsRoot"
    }
    $candidates = @(
        Get-ChildItem -LiteralPath $versionsRoot -Directory |
            Where-Object {
                Test-Path -LiteralPath (Join-Path $_.FullName 'codex-package.json') -PathType Leaf
            }
    )
    if ($candidates.Count -eq 0) {
        throw "No side-by-side Codex package was found under: $versionsRoot"
    }
    if ($candidates.Count -gt 1) {
        $names = ($candidates | Sort-Object Name | ForEach-Object Name) -join ', '
        throw "Multiple side-by-side Codex packages were found under ${versionsRoot}; specify -PackageRoot explicitly. Packages: $names"
    }
    return $candidates[0].FullName
}

function Test-CodexPackage {
    param([string]$Root)
    if (-not [System.IO.Path]::IsPathFullyQualified($Root)) {
        throw "PackageRoot must be an absolute path: $Root"
    }
    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
        throw "PackageRoot does not exist: $rootPath"
    }

    $descriptorPath = Join-Path $rootPath 'codex-package.json'
    $manifestPath = Join-Path $rootPath 'codex-generation-manifest.json'
    if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) {
        throw "Package descriptor is missing: $descriptorPath"
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Package integrity manifest is missing: $manifestPath"
    }

    $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    $descriptorNames = @($descriptor.PSObject.Properties.Name | Sort-Object)
    $expectedDescriptorNames = @(
        'entrypoint',
        'layoutVersion',
        'pathDir',
        'resourcesDir',
        'target',
        'variant',
        'version'
    ) | Sort-Object
    if (Compare-Object -ReferenceObject $expectedDescriptorNames -DifferenceObject $descriptorNames) {
        throw 'codex-package.json does not have the native layoutVersion=1 field set.'
    }
    if (
        [int]$descriptor.layoutVersion -ne 1 -or
        $descriptor.entrypoint -ne 'bin/codex.exe' -or
        $descriptor.resourcesDir -ne 'codex-resources' -or
        $descriptor.pathDir -ne 'codex-path'
    ) {
        throw 'codex-package.json has an unsupported native package layout.'
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne 1) {
        throw 'Unsupported codex-generation-manifest.json schemaVersion.'
    }
    foreach ($name in @('version', 'target', 'variant', 'upstreamCommit', 'producerPatch', 'descriptor')) {
        if ($null -eq $manifest.package.PSObject.Properties[$name]) {
            throw "Package manifest is missing package.$name."
        }
    }
    foreach ($name in @('layoutVersion', 'version', 'target', 'variant', 'entrypoint', 'resourcesDir', 'pathDir')) {
        if ($descriptor.$name -ne $manifest.package.descriptor.$name) {
            throw "Package descriptor does not match manifest field: $name"
        }
    }
    if ($manifest.package.upstreamCommit -notmatch '^[0-9a-f]{40}$') {
        throw 'Package manifest has an invalid upstream commit.'
    }
    if ($manifest.package.producerPatch.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'Package manifest has an invalid producer patch hash.'
    }

    $entries = @($manifest.files)
    if ($entries.Count -eq 0) {
        throw 'Package manifest has no file integrity entries.'
    }
    $entryPaths = @($entries.path)
    if (($entryPaths | Select-Object -Unique).Count -ne $entryPaths.Count) {
        throw 'Package manifest contains duplicate file paths.'
    }
    foreach ($requiredPath in @(
        'codex-package.json',
        'bin/codex.exe',
        'bin/codex-code-mode-host.exe',
        'codex-resources/codex-command-runner.exe',
        'codex-resources/codex-windows-sandbox-setup.exe',
        'codex-path/rg.exe'
    )) {
        if ($entryPaths -notcontains $requiredPath) {
            throw "Package manifest is missing required file: $requiredPath"
        }
    }

    $manifestName = 'codex-generation-manifest.json'
    $actualPaths = @(
        Get-ChildItem -LiteralPath $rootPath -File -Recurse |
            Where-Object {
                -not [string]::Equals(
                    $_.FullName,
                    $manifestPath,
                    [StringComparison]::OrdinalIgnoreCase
                )
            } |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($rootPath, $_.FullName).Replace('\', '/')
            } |
            Sort-Object
    )
    if (Compare-Object -ReferenceObject @($entryPaths | Sort-Object) -DifferenceObject $actualPaths) {
        throw 'Package file set does not match the integrity manifest.'
    }

    $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
    foreach ($entry in $entries) {
        if (
            [string]::IsNullOrWhiteSpace($entry.path) -or
            [System.IO.Path]::IsPathRooted($entry.path) -or
            $entry.path.Split('/') -contains '..'
        ) {
            throw "Package manifest contains an unsafe path: $($entry.path)"
        }
        $filePath = [System.IO.Path]::GetFullPath(
            (Join-Path $rootPath ($entry.path.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
        )
        if (-not $filePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Package manifest path escapes the package root: $($entry.path)"
        }
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw "Package file is missing: $($entry.path)"
        }
        $file = Get-Item -LiteralPath $filePath
        if ($file.Length -ne [long]$entry.bytes -or (Get-Sha256 -Path $filePath) -ne $entry.sha256) {
            throw "Package file failed integrity verification: $($entry.path)"
        }
    }

    $engineEntry = $entries | Where-Object path -eq 'bin/codex.exe' | Select-Object -First 1
    if ($engineEntry.role -ne 'engine') {
        throw 'Package manifest does not mark bin/codex.exe as the engine.'
    }
    return [pscustomobject]@{
        Root = $rootPath
        EnginePath = Join-Path $rootPath 'bin\codex.exe'
        EngineSha256 = [string]$engineEntry.sha256
        Manifest = $manifest
    }
}

if (-not ('CodexGeneration.NativeProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexGeneration
{
    public sealed class ProcessInfo
    {
        public uint ProcessId { get; set; }
        public uint ParentProcessId { get; set; }
        public string Name { get; set; }
        public string ExecutablePath { get; set; }
    }

    public static class NativeProcess
    {
        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint INVALID_HANDLE_VALUE = 0xFFFFFFFF;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32W
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageNameW(
            IntPtr hProcess,
            uint dwFlags,
            StringBuilder lpExeName,
            ref uint lpdwSize
        );

        private static string GetExecutablePath(uint processId)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (process == IntPtr.Zero)
            {
                return null;
            }
            try
            {
                var buffer = new StringBuilder(32768);
                uint size = (uint)buffer.Capacity;
                return QueryFullProcessImageNameW(process, 0, buffer, ref size)
                    ? buffer.ToString(0, (int)size)
                    : null;
            }
            finally
            {
                CloseHandle(process);
            }
        }

        public static ProcessInfo[] Snapshot()
        {
            var result = new List<ProcessInfo>();
            IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == new IntPtr(unchecked((int)INVALID_HANDLE_VALUE)))
            {
                return result.ToArray();
            }
            try
            {
                var entry = new PROCESSENTRY32W();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                if (!Process32FirstW(snapshot, ref entry))
                {
                    return result.ToArray();
                }
                do
                {
                    result.Add(new ProcessInfo
                    {
                        ProcessId = entry.th32ProcessID,
                        ParentProcessId = entry.th32ParentProcessID,
                        Name = entry.szExeFile,
                        ExecutablePath = GetExecutablePath(entry.th32ProcessID)
                    });
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                }
                while (Process32NextW(snapshot, ref entry));
            }
            finally
            {
                CloseHandle(snapshot);
            }
            return result.ToArray();
        }
    }
}
'@
}

function Get-DescendantProcesses {
    param([int]$RootProcessId)
    $all = @([CodexGeneration.NativeProcess]::Snapshot())
    $byParent = @{}
    foreach ($process in $all) {
        $parentKey = [int]$process.ParentProcessId
        if (-not $byParent.ContainsKey($parentKey)) {
            $byParent[$parentKey] = [System.Collections.Generic.List[object]]::new()
        }
        $byParent[$parentKey].Add($process)
    }
    $result = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $queue.Enqueue($RootProcessId)
    [void]$seen.Add($RootProcessId)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if (-not $byParent.ContainsKey($parent)) {
            continue
        }
        foreach ($child in $byParent[$parent]) {
            if (-not $seen.Add([int]$child.ProcessId)) {
                continue
            }
            $result.Add($child)
            $queue.Enqueue([int]$child.ProcessId)
        }
    }
    return $result.ToArray()
}

function Get-DesktopExecutableFromManifest {
    param(
        [string]$PackageRoot,
        [string]$ManifestPath
    )
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        return $null
    }
    [xml]$appxManifest = Get-Content -LiteralPath $ManifestPath -Raw
    $applications = @($appxManifest.Package.Applications.Application)
    $application = $applications | Where-Object Id -eq 'App' | Select-Object -First 1
    if ($null -eq $application) {
        $application = $applications |
            Where-Object EntryPoint -eq 'Windows.FullTrustApplication' |
            Select-Object -First 1
    }
    if ($null -eq $application -or [string]::IsNullOrWhiteSpace([string]$application.Executable)) {
        return $null
    }
    $relativeExecutable = ([string]$application.Executable).Replace('/', '\')
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $PackageRoot $relativeExecutable))
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }
    return $null
}

function Get-RegisteredDesktopExecutables {
    $registered = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )

    $repositoryRoot = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
    if (Test-Path -LiteralPath $repositoryRoot) {
        $packages = @(
            Get-ChildItem -LiteralPath $repositoryRoot |
                Where-Object PSChildName -like 'OpenAI.Codex_*' |
                Sort-Object {
                    $match = [regex]::Match($_.PSChildName, '^OpenAI\.Codex_([^_]+)_')
                    $version = $null
                    if ([version]::TryParse($match.Groups[1].Value, [ref]$version)) {
                        return $version
                    }
                    return [version]'0.0'
                } -Descending
        )
        foreach ($package in $packages) {
            $properties = Get-ItemProperty -LiteralPath $package.PSPath
            $packageRoot = [string]$properties.PackageRootFolder
            if (
                [string]::IsNullOrWhiteSpace($packageRoot) -or
                -not (Test-Path -LiteralPath $packageRoot -PathType Container)
            ) {
                continue
            }
            $candidate = Get-DesktopExecutableFromManifest `
                -PackageRoot $packageRoot `
                -ManifestPath (Join-Path $packageRoot 'AppxManifest.xml')
            if ($null -ne $candidate -and $seen.Add($candidate)) {
                $registered.Add($candidate)
            }
        }
    }
    return $registered.ToArray()
}

function Get-DesktopExecutable {
    param(
        [string]$ExplicitPath,
        [string[]]$RegisteredExecutables
    )
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not [System.IO.Path]::IsPathFullyQualified($ExplicitPath)) {
            throw "DesktopExecutable must be an absolute path: $ExplicitPath"
        }
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
            throw "DesktopExecutable does not exist: $ExplicitPath"
        }
        return [System.IO.Path]::GetFullPath($ExplicitPath)
    }

    if (@($RegisteredExecutables).Count -gt 0) {
        return [System.IO.Path]::GetFullPath([string]$RegisteredExecutables[0])
    }
    throw 'Could not resolve the installed Desktop executable; pass -DesktopExecutable explicitly.'
}

function Read-LauncherArguments {
    param([string[]]$RawArguments)
    if ($RawArguments.Count -eq 0) {
        throw 'Usage: start-codex-generation.ps1 <cli|desktop> [options] [-- CLI arguments]'
    }
    $script:Mode = $RawArguments[0].ToLowerInvariant()
    if ($script:Mode -notin @('cli', 'desktop')) {
        throw "Unsupported mode: $($RawArguments[0])"
    }

    if ($script:Mode -eq 'cli') {
        $separatorIndex = -1
        for ($index = 1; $index -lt $RawArguments.Count; $index++) {
            if ($RawArguments[$index] -eq '--') {
                $separatorIndex = $index
                break
            }
        }
        if ($separatorIndex -lt 0) {
            throw 'CLI mode requires -- before engine arguments.'
        }
        $index = 1
        while ($index -lt $separatorIndex) {
            switch -Exact ($RawArguments[$index]) {
                '-PackageRoot' {
                    if ($index + 1 -ge $separatorIndex) {
                        throw '-PackageRoot requires a value.'
                    }
                    $script:PackageRoot = $RawArguments[$index + 1]
                    $index += 2
                }
                '-LocalAppDataRoot' {
                    if ($index + 1 -ge $separatorIndex) {
                        throw '-LocalAppDataRoot requires a value.'
                    }
                    $script:LocalAppDataRoot = $RawArguments[$index + 1]
                    $index += 2
                }
                default {
                    throw "Unknown launcher option before --: $($RawArguments[$index])"
                }
            }
        }
        if ($separatorIndex + 1 -lt $RawArguments.Count) {
            $script:Arguments = @($RawArguments[($separatorIndex + 1)..($RawArguments.Count - 1)])
        } else {
            $script:Arguments = @()
        }
        return
    }

    $index = 1
    while ($index -lt $RawArguments.Count) {
        switch -Exact ($RawArguments[$index]) {
            '-PackageRoot' {
                if ($index + 1 -ge $RawArguments.Count) {
                    throw '-PackageRoot requires a value.'
                }
                $script:PackageRoot = $RawArguments[$index + 1]
                $index += 2
            }
            '-LocalAppDataRoot' {
                if ($index + 1 -ge $RawArguments.Count) {
                    throw '-LocalAppDataRoot requires a value.'
                }
                $script:LocalAppDataRoot = $RawArguments[$index + 1]
                $index += 2
            }
            '-DesktopExecutable' {
                if ($index + 1 -ge $RawArguments.Count) {
                    throw '-DesktopExecutable requires a value.'
                }
                $script:DesktopExecutable = $RawArguments[$index + 1]
                $index += 2
            }
            '-DesktopArgument' {
                if ($index + 1 -ge $RawArguments.Count) {
                    throw '-DesktopArgument requires a value.'
                }
                $script:DesktopArguments += $RawArguments[$index + 1]
                $index += 2
            }
            '-IdentityTimeoutMilliseconds' {
                if ($index + 1 -ge $RawArguments.Count) {
                    throw '-IdentityTimeoutMilliseconds requires a value.'
                }
                $script:IdentityTimeoutMilliseconds = [int]$RawArguments[$index + 1]
                $index += 2
            }
            default {
                throw "Unknown Desktop option: $($RawArguments[$index])"
            }
        }
    }
    if ($script:IdentityTimeoutMilliseconds -lt 100 -or $script:IdentityTimeoutMilliseconds -gt 120000) {
        throw 'IdentityTimeoutMilliseconds must be between 100 and 120000.'
    }
}

try {
    Read-LauncherArguments -RawArguments $rawArguments
    if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
        $PackageRoot = Get-DefaultPackageRoot -ExplicitLocalAppDataRoot $LocalAppDataRoot
    }
    $package = Test-CodexPackage -Root $PackageRoot

    if ($Mode -eq 'cli') {
        $global:LASTEXITCODE = 0
        & $package.EnginePath @Arguments
        exit $LASTEXITCODE
    }

    $registeredDesktopExecutables = @(Get-RegisteredDesktopExecutables)
    $desktopPath = Get-DesktopExecutable `
        -ExplicitPath $DesktopExecutable `
        -RegisteredExecutables $registeredDesktopExecutables
    $desktopIdentityPaths = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($registeredDesktopExecutable in $registeredDesktopExecutables) {
        [void]$desktopIdentityPaths.Add($registeredDesktopExecutable)
    }
    [void]$desktopIdentityPaths.Add($desktopPath)
    $desktopProcesses = @(
        [CodexGeneration.NativeProcess]::Snapshot() |
            Where-Object {
                $_.ExecutablePath -and
                $desktopIdentityPaths.Contains(
                    [System.IO.Path]::GetFullPath($_.ExecutablePath)
                )
            }
    )
    if ($desktopProcesses.Count -gt 0) {
        Write-Failure -Code 'desktop_already_running' -Message 'Desktop is already running. Exit it before starting the generation package.' -Details ([ordered]@{
            desktopExecutable = $desktopPath
            registeredDesktopExecutables = @($registeredDesktopExecutables)
            matchedDesktopExecutables = @(
                $desktopProcesses.ExecutablePath |
                    Sort-Object -Unique
            )
            processIds = @($desktopProcesses.ProcessId)
        })
        exit 2
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $desktopPath
    $startInfo.WorkingDirectory = Split-Path -Parent $desktopPath
    $startInfo.UseShellExecute = $false
    $startInfo.Environment['CODEX_CLI_PATH'] = $package.EnginePath
    foreach ($argument in @($DesktopArguments)) {
        if ($null -ne $argument) {
            $startInfo.ArgumentList.Add([string]$argument)
        }
    }
    $desktopProcess = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $desktopProcess) {
        throw 'Desktop process did not start.'
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($IdentityTimeoutMilliseconds)
    $observedCodexPaths = @{}
    $engineHashMismatch = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $descendants = @(Get-DescendantProcesses -RootProcessId $desktopProcess.Id)
        foreach ($process in $descendants) {
            if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
                continue
            }
            $processPath = [System.IO.Path]::GetFullPath($process.ExecutablePath)
            if ([string]::Equals($processPath, $package.EnginePath, [StringComparison]::OrdinalIgnoreCase)) {
                $actualHash = Get-Sha256 -Path $processPath
                if ($actualHash -eq $package.EngineSha256) {
                    Write-Result ([ordered]@{
                        ok = $true
                        status = 'desktop_engine_verified'
                        desktopProcessId = $desktopProcess.Id
                        desktopExecutable = $desktopPath
                        engineProcessId = $process.ProcessId
                        engineExecutable = $processPath
                        engineSha256 = $actualHash
                    })
                    exit 0
                }
                $engineHashMismatch = [ordered]@{
                    path = $processPath
                    expectedSha256 = $package.EngineSha256
                    actualSha256 = $actualHash
                }
            }
            elseif ([System.IO.Path]::GetFileName($processPath) -ieq 'codex.exe') {
                $observedCodexPaths[$processPath] = $true
            }
        }
        Start-Sleep -Milliseconds 100
    }

    $details = [ordered]@{
        desktopProcessId = $desktopProcess.Id
        desktopExecutable = $desktopPath
        expectedEngine = $package.EnginePath
        expectedEngineSha256 = $package.EngineSha256
        observedCodexExecutables = @($observedCodexPaths.Keys | Sort-Object)
    }
    if ($null -ne $engineHashMismatch) {
        $details['engineHashMismatch'] = $engineHashMismatch
    }
    Write-Failure -Code 'desktop_engine_identity_not_found' -Message 'No descendant process used the verified package engine within the timeout.' -Details $details
    exit 3
}
catch {
    Write-Failure -Code 'launcher_failed' -Message $_.Exception.Message
    exit 1
}
