param(
    [ValidateSet('Inventory','Preview','Delete','SelfTest')][string]$Mode = 'Inventory',
    [string]$Workspace = (Join-Path $PSScriptRoot '..'),
    [string]$Manifest,
    [string]$ReportDirectory = 'output/windows-parallel-20261109/cleanup'
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Use pwsh 7 on Windows.' }
$Workspace = [IO.Path]::GetFullPath($Workspace).TrimEnd('\')
function Inside([string]$Parent, [string]$Child) {
    $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
        $Child.StartsWith($Parent + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Absolute([string]$Path) {
    [IO.Path]::GetFullPath($Path, $Workspace).TrimEnd('\')
}
function NoReparse([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path: $cursor" }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
NoReparse $Workspace
$ReportDirectory = Absolute $ReportDirectory
if (-not (Inside (Join-Path $Workspace 'output/windows-parallel-20261109') $ReportDirectory)) {
    throw 'Reports must stay in output/windows-parallel-20261109.'
}
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
NoReparse $ReportDirectory
$prefix = Join-Path $ReportDirectory ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffffffZ') + '-' + $Mode)
function Save([string]$File, $Value) {
    if (Test-Path -LiteralPath $File) { throw "Existing report: $File" }
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $File -Encoding utf8
}

# Metadata handles only: no payload reads, content hashing, SQLite opens, or link traversal.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CloseoutMetadata {
    [StructLayout(LayoutKind.Sequential, Pack=4)] struct Info {
        public uint Attributes; public long Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IdHigh, IdLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetCompressedFileSizeW(string p, out uint high);
    public class FileRow {
        public string Path, Identity; public long LogicalBytes, AllocatedBytes, Written; public uint Links, Attributes;
    }
    public class LinkRow { public string Path, Type, LinkTarget; }
    public class Summary {
        public string Path, Type, MetadataStamp; public uint Attributes; public long LogicalBytes, Files, Images, ImageBytes;
        public long UniqueAllocatedBytes, ReclaimableAllocatedEstimateBytes, SharedOutsideTargetAllocatedBytes;
        public long Errors, ReparseSkipped; public List<string> Issues = new List<string>();
        public List<LinkRow> Links = new List<LinkRow>();
    }
    public static string Excluded, ReportRoot;
    static string NativePath(string p) { return p.StartsWith(@"\\") ? @"\\?\UNC\"+p.Substring(2) : @"\\?\"+p; }
    public static FileRow Read(string path) {
        using (var h = CreateFileW(NativePath(path), 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
            Info i;
            if (h.IsInvalid || !GetFileInformationByHandle(h, out i)) throw new IOException("File metadata unavailable: " + path);
            if ((i.Attributes & 0x400) != 0) throw new IOException("Reparse file: " + path);
            uint high; uint low = GetCompressedFileSizeW(NativePath(path), out high);
            if (low == uint.MaxValue && Marshal.GetLastWin32Error() != 0) throw new IOException("Allocation unavailable: " + path);
            return new FileRow { Path=path, Identity=i.Volume.ToString("x8")+":"+i.IdHigh.ToString("x8")+i.IdLow.ToString("x8"),
                LogicalBytes=((long)i.SizeHigh<<32)|i.SizeLow, AllocatedBytes=((long)high<<32)|low, Written=i.Written, Links=i.Links, Attributes=i.Attributes };
        }
    }
    static string Q(string s) { return "\"" + s.Replace("\"", "\"\"") + "\""; }
    static bool Image(string p) { return " .png .jpg .jpeg .webp .gif .bmp .avif ".Contains(" "+Path.GetExtension(p).ToLowerInvariant()+" "); }
    public static Summary Scan(string path, string csvPrefix) {
        bool writeCsv=!String.IsNullOrEmpty(csvPrefix);
        if (writeCsv && (!Path.IsPathFullyQualified(csvPrefix) || ReportRoot == null ||
            !Path.GetFullPath(csvPrefix).StartsWith(ReportRoot+"\\", StringComparison.OrdinalIgnoreCase)))
            throw new IOException("CSV prefix must be an absolute descendant of the report directory.");
        var result = new Summary { Path=path };
        var identities = new Dictionary<string, (FileRow file, int count)>();
        var stamp = System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
        using (var directories = !writeCsv ? null : new StreamWriter(csvPrefix+"-directories.csv", false, new UTF8Encoding(false)))
        using (var files = !writeCsv ? null : new StreamWriter(csvPrefix+"-files.csv", false, new UTF8Encoding(false))) {
            directories?.WriteLine("path,logicalBytes,files,attributes,type");
            files?.WriteLine("path,logicalBytes,allocatedBytes,identity,links,written,attributes,type");
            void File(string p) {
                var f=Read(p); result.Files++; result.LogicalBytes+=f.LogicalBytes;
                if (Image(p)) { result.Images++; result.ImageBytes+=f.LogicalBytes; }
                if (identities.TryGetValue(f.Identity, out var old)) identities[f.Identity]=(old.file,old.count+1);
                else identities[f.Identity]=(f,1);
                string line=Q(p)+","+f.LogicalBytes+","+f.AllocatedBytes+","+f.Identity+","+f.Links+","+f.Written+","+f.Attributes+",File";
                // Earlier targets may remove another hardlink; that does not change this file's identity or contents.
                string signature=Q(p)+","+f.LogicalBytes+","+f.AllocatedBytes+","+f.Identity+","+f.Written+","+f.Attributes;
                stamp.AppendData(Encoding.UTF8.GetBytes(signature+"\n")); files?.WriteLine(line);
            }
            void Visit(string p) {
                try {
                    if (Excluded != null && (p.Equals(Excluded, StringComparison.OrdinalIgnoreCase) || p.StartsWith(Excluded+"\\", StringComparison.OrdinalIgnoreCase))) return;
                    var attributes=System.IO.File.GetAttributes(p);
                    bool directory=(attributes & FileAttributes.Directory)!=0;
                    if (p == path) { result.Attributes=(uint)attributes; result.Type=directory?"Directory":"File"; }
                    if ((attributes & FileAttributes.ReparsePoint)!=0) {
                        result.ReparseSkipped++;
                        var type=directory?"DirectoryReparsePoint":"FileReparsePoint";
                        if (p == path) result.Type=type;
                        FileSystemInfo info=directory?(FileSystemInfo)new DirectoryInfo(p):new FileInfo(p);
                        result.Links.Add(new LinkRow { Path=p, Type=type, LinkTarget=info.LinkTarget });
                        result.Issues.Add("reparse skipped: "+p); return;
                    }
                    if ((attributes & FileAttributes.Directory)==0) { File(p); return; }
                    long bytes=result.LogicalBytes, count=result.Files;
                    stamp.AppendData(Encoding.UTF8.GetBytes("directory:"+p+"\n"));
                    var entries=Directory.GetFileSystemEntries(p); Array.Sort(entries, StringComparer.OrdinalIgnoreCase);
                    foreach (var entry in entries) Visit(entry);
                    directories?.WriteLine(Q(p)+","+(result.LogicalBytes-bytes)+","+(result.Files-count)+","+(uint)attributes+",Directory");
                } catch (Exception e) { result.Errors++; result.Issues.Add(p+": "+e.Message); }
            }
            Visit(path);
        }
        foreach (var pair in identities.Values) {
            result.UniqueAllocatedBytes+=pair.file.AllocatedBytes;
            if (pair.count == pair.file.Links) result.ReclaimableAllocatedEstimateBytes+=pair.file.AllocatedBytes;
            else result.SharedOutsideTargetAllocatedBytes+=pair.file.AllocatedBytes;
        }
        result.MetadataStamp=Convert.ToHexString(stamp.GetHashAndReset()).ToLowerInvariant(); stamp.Dispose();
        return result;
    }
}
'@
[CloseoutMetadata]::ReportRoot = $ReportDirectory

$generated = [Collections.Generic.List[string]]::new()
foreach ($name in @('output','dist','node_modules','.ct','.playwright-cli','.tmp-tests','.tmp-archive-test','docs/validation')) {
    $path = Absolute $name
    if (Test-Path -LiteralPath $path) { $generated.Add($path) }
}
foreach ($item in Get-ChildItem -LiteralPath $Workspace -Directory -Force -Filter '.codex-ui-preview*') {
    $generated.Add($item.FullName)
}
foreach ($relative in @('native/windows-source-proof/target',
    '.codex-usage/tps-batch-20261030','.codex-usage/tps-aligned-20261030',
    '.codex-usage/codex-release-20261029','.codex-usage/no-tps-cutover-20261101',
    '.codex-usage/tps-deepseek-audit-20261030','.codex-usage/tps-v4-implementation-20261029/codex',
    '.codex-usage/release-v0.7.0-clean-lf/docs/validation',
    '.codex-usage/billing-test-temp','.codex-usage/test-tmp',
    '.codex-usage/dsh-hmr-fix-20261101','.codex-usage/dsh-standard-plugin-20261031',
    '.codex-usage/tps-extraction-20261101','.codex-usage/tps-implementation-20261029',
    '.codex-usage/tps-installed-validation-20261029','.codex-usage/tps-local-adoption-20261029',
    '.codex-usage/tps-simplification-20261101','.codex-usage/tps-upstream-20261031',
    '.codex-usage/release-v0.7.0-clean.tar','.codex-usage/release-v0.7.0-final.tar',
    '.codex-usage/release-v0.7.0-clean-lf.tar')) {
    $path = Absolute $relative
    if (Test-Path -LiteralPath $path) { $generated.Add($path) }
}
$permanent = @($ReportDirectory, (Absolute 'output/cleanup-20261108'), (Absolute 'output/cleanup-20261109'))
$profileFile = Absolute 'output/architecture-20261103/growth-baseline/profile.json'
if (Test-Path -LiteralPath $profileFile) {
    $profile = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
    if (-not $profile.captureFile) { throw 'Missing original capture lineage in growth profile.' }
    $permanent += @($profileFile, [IO.Path]::GetDirectoryName((Absolute $profile.captureFile)),
        (Absolute 'output/architecture-20261102/full-startup/capture-pointer.json'))
} elseif ($Mode -in @('Preview','Delete')) { throw 'Original capture lineage unavailable; keep unknown targets.' }
$holds = @(
    @{path='output/windows-parallel-20261109';consumer='A/B/C/E baseline runtime, diagnostics, final evidence'},
    @{path='output/windows-multitab-20261109';consumer='E preserved 135-source / 134-committed starting point'},
    @{path='output/windows-stability-recovery-20261109';consumer='E recovery origin and oracle'},
    @{path='output/windows-stability-20261109';consumer='E failed state, earlier recovery and upgrade evidence'},
    @{path='output/c1-long-history-20261107';consumer='E six-source inputs and seeds; C1 raw lineage'},
    @{path='output/archive-compaction-20261108';consumer='D/E cold packages, upgrade states, baseline-runtime.json'},
    @{path='output/archive-verification-reuse-20261108';consumer='D/E upstream package and manifest dependencies'},
    @{path='output/persistent-mixed-history-20261107';consumer='E upstream mixed projection fixtures'},
    @{path='output/b3-mixed-history-20261107';consumer='C1 seed-state and upstream input lineage'},
    @{path='output/architecture-20261103/growth-baseline';consumer='C1 profile, captureFile and original-source lineage'},
    @{path='output/delivery-20261105';consumer='D historical delivery evidence and independent runtime'}
    @{path='node_modules';consumer='E final engineering checks'},
    @{path='.ct';consumer='D/E final native build tool cache'},
    @{path='native/windows-source-proof/target';consumer='D/E helper build and fallback executable'}
) | ForEach-Object { [pscustomobject]@{path=(Absolute $_.path);consumer=$_.consumer;released=$false;releaseEvidence=''} }

function TargetProtection([string[]]$Retained, [string[]]$Tracked) {
    $exact = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $ancestors = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($keep in @($permanent) + @($Retained) + @($Tracked)) {
        [void]$exact.Add($keep)
        $cursor = $keep
        while ($cursor) { [void]$ancestors.Add($cursor); $cursor = [IO.Path]::GetDirectoryName($cursor) }
    }
    [pscustomobject]@{exact=$exact;ancestors=$ancestors}
}

function ValidateTarget([string]$Path, $Dependencies, [string[]]$Retained, [string[]]$Tracked, $Protection = $null) {
    $target = Absolute $Path
    if ($target -cne $Path) { throw "Target must be an absolute normalized path: $Path" }
    if (-not @($generated | Where-Object { (Inside $_ $target) -and $_ -ne $target }).Count -and
        -not @($generated | Where-Object { $_ -eq $target -and $_ -notin @((Absolute 'output'), (Absolute 'docs/validation')) }).Count) {
        throw "Target is outside generated scopes or is a protected root: $target"
    }
    if (-not $Protection) { $Protection = TargetProtection $Retained $Tracked }
    if ($Protection.ancestors.Contains($target)) { throw "Target contains retained data: $target" }
    $cursor = $target
    while ($cursor) {
        if ($Protection.exact.Contains($cursor)) { throw "Retained dependency: $cursor" }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    foreach ($dependency in $Dependencies) {
        if ((Inside $target $dependency.path) -or (Inside $dependency.path $target)) {
            if ($dependency.released -ne $true -or [string]::IsNullOrWhiteSpace($dependency.releaseEvidence)) {
                throw "Unreleased consumer: $($dependency.consumer) -> $($dependency.path)"
            }
        }
    }
    NoReparse $target
    if ((Resolve-Path -LiteralPath $target).ProviderPath -cne $target) { throw "Resolved target changed: $target" }
    $target
}

function NoOverlap([string[]]$Paths) {
    $selected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $Paths) {
        if (-not $selected.Add($path)) { throw "Duplicate cleanup target: $path" }
    }
    foreach ($path in $Paths) {
        $parent = [IO.Path]::GetDirectoryName($path)
        while ($parent) {
            if ($selected.Contains($parent)) { throw "Overlapping cleanup targets: $parent -> $path" }
            $parent = [IO.Path]::GetDirectoryName($parent)
        }
    }
}

if ($Mode -eq 'SelfTest') {
    $testRoot = Join-Path (Absolute 'output/windows-parallel-20261109') ('cleanup-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $file = Join-Path $testRoot 'one.bin'
    [IO.File]::WriteAllBytes($file, [byte[]]::new(8192))
    $alias = Join-Path $testRoot 'two.bin'
    New-Item -ItemType HardLink -Path $alias -Target $file | Out-Null
    $measured = [CloseoutMetadata]::Scan($testRoot, $null)
    if ($measured.LogicalBytes -ne 16384 -or $measured.Files -ne 2 -or $measured.UniqueAllocatedBytes -ne $measured.ReclaimableAllocatedEstimateBytes) {
        throw 'Hardlink aggregation failed.'
    }
    $single = [CloseoutMetadata]::Scan($file, $null)
    if ($single.ReclaimableAllocatedEstimateBytes -ne 0) { throw 'External hardlink counted as reclaimable.' }
    Remove-Item -LiteralPath $alias
    $remaining = [CloseoutMetadata]::Scan($file, $null)
    if ($remaining.MetadataStamp -ne $single.MetadataStamp -or $remaining.ReclaimableAllocatedEstimateBytes -ne 8192) {
        throw 'Removing an owned hardlink must not invalidate the next target.'
    }
    if ((ValidateTarget $file @() @() @()) -cne $file) { throw 'Valid generated target rejected.' }
    $longDirectory=Join-Path $testRoot (('long-metadata-path-' * 5)+'\'+('long-metadata-path-' * 5))
    New-Item -ItemType Directory -Path $longDirectory | Out-Null
    $longFile=Join-Path $longDirectory 'long.bin'
    [IO.File]::WriteAllBytes($longFile, [byte[]]::new(4096))
    if ($longFile.Length -le 260 -or [CloseoutMetadata]::Read($longFile).LogicalBytes -ne 4096) { throw 'Long path metadata failed.' }
    if (Inside (Absolute 'output/a') (Absolute 'output/ab')) { throw 'Sibling boundary failed.' }
    $rejects=0
    foreach ($bad in @((Absolute '../outside'), (Absolute 'src'), (Absolute 'output'), (Absolute '.codex-usage/usage-index.sqlite'))) {
        try { ValidateTarget $bad @() @() @() | Out-Null } catch { $rejects++ }
    }
    try { ValidateTarget $testRoot @([pscustomobject]@{path=$testRoot;released=$false;consumer='selftest';releaseEvidence=''}) @() @() | Out-Null } catch { $rejects++ }
    try { ValidateTarget $file @() @() @($file) | Out-Null } catch { $rejects++ }
    if ($rejects -ne 6) { throw 'Target rejection failed.' }
    $protectionRejects = 0
    try { ValidateTarget $testRoot @() @($file) @() | Out-Null } catch { $protectionRejects++ }
    try { ValidateTarget $file @() @($testRoot) @() | Out-Null } catch { $protectionRejects++ }
    if ($protectionRejects -ne 2) { throw 'Retained ancestor/descendant protection failed.' }
    NoOverlap @((Absolute 'output/a'), (Absolute 'output/a-b'), (Absolute 'output/abc/x'))
    $overlapRejects = 0
    try { NoOverlap @((Absolute 'output/a'), (Absolute 'output/a/b')) } catch { $overlapRejects++ }
    try { NoOverlap @((Absolute 'output/a'), (Absolute 'output/a')) } catch { $overlapRejects++ }
    if ($overlapRejects -ne 2) { throw 'Overlap/duplicate detection failed.' }
    $junction = Join-Path $testRoot 'junction'
    New-Item -ItemType Junction -Path $junction -Target $testRoot | Out-Null
    try { NoReparse $junction; throw 'Junction accepted.' } catch { if ($_.Exception.Message -eq 'Junction accepted.') { throw } }
    $after = [CloseoutMetadata]::Scan($testRoot, $null)
    if ($after.ReparseSkipped -ne 1 -or $after.Errors) { throw 'Junction traversal guard failed.' }
    [IO.File]::AppendAllText($file, 'changed')
    if (([CloseoutMetadata]::Scan($file, $null)).MetadataStamp -eq $single.MetadataStamp) { throw 'Metadata drift not detected.' }
    try { [CloseoutMetadata]::Scan($file, (Absolute 'bad-prefix')) | Out-Null; throw 'Bad CSV prefix accepted.' }
    catch { if ($_.Exception.Message -eq 'Bad CSV prefix accepted.') { throw } }
    if ((Test-Path -LiteralPath (Absolute '-files.csv')) -or (Test-Path -LiteralPath (Absolute '-directories.csv'))) {
        throw 'Unexpected root CSV; inspect before moving owned output.'
    }
    Save ($prefix + '.json') @{passed=$true;checks=20;fixture=$testRoot;deletedFixtureLinks=1;deleted=0;links=$after.Links}
    Write-Output "SelfTest passed; fixture retained: $testRoot"
    exit
}

if ($Mode -eq 'Inventory') {
    [CloseoutMetadata]::Excluded = $ReportDirectory
    $rows = @(); $index = 0
    foreach ($scope in $generated) {
        # Each output child is independent; shared hardlinks across children remain non-reclaimable estimates.
        $targets = if ($scope -eq (Absolute 'output')) { @(Get-ChildItem -LiteralPath $scope -Force | ForEach-Object FullName) } else { @($scope) }
        foreach ($target in $targets) {
            if (Inside $ReportDirectory $target) { continue }
            NoReparse ([IO.Path]::GetDirectoryName($target))
            $index++
            $row = [CloseoutMetadata]::Scan($target, ($prefix + '-' + $index))
            $rows += $row
            if ($row.LogicalBytes -ge 100MB -or $row.Errors -or $row.ReparseSkipped) {
                Write-Host ("Inventory {0}: {1:N3} logical GB; {2}" -f $index, ($row.LogicalBytes/1e9), $target)
            }
        }
    }
    $receipts = foreach ($relative in @('output/cleanup-20261108/WORKSPACE-FINAL-SUMMARY.json',
        'output/cleanup-20261108/final-summary.json','output/cleanup-20261109/deletion-receipt.json',
        'output/windows-stability-20261109/cleanup-success-receipt.json')) {
        $file = Absolute $relative
        if (Test-Path -LiteralPath $file) {
            $data=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
            [pscustomobject]@{path=$file;data=$data;previousTargets=@($data.results | Where-Object { $_.path } | ForEach-Object {
                [pscustomobject]@{path=$_.path;currentlyExists=(Test-Path -LiteralPath $_.path)}
            })}
        }
    }
    Save ($prefix + '.json') @{workspace=$Workspace;at=[DateTimeOffset]::Now.ToString('o');rows=$rows;holds=$holds;previousReceipts=$receipts;
        excluded='User/history roots, .git, src, public, source/test trees and unrelated work; no links followed';
        allocationBasis='GetCompressedFileSize, deduplicated by volume/file ID per scope. Reclaimable estimate requires every hardlink within that scope. Directory metadata, shared extents, open handles and concurrent volume writes prevent an exact physical-reclaim promise.';
        contentBytesRead=0;databaseOpens=0;deleted=0}
    Save ($prefix + '-manifest-template.json') @{format=1;workspace=$Workspace;timingFinished=$false;dependencies=$holds;retainedPaths=$permanent;targets=@()}
    Write-Output "Inventory complete: $prefix.json"
    exit
}

if (-not $Manifest) { throw 'Preview/Delete requires an explicit manifest.' }
$plan = Get-Content -LiteralPath (Absolute $Manifest) -Raw | ConvertFrom-Json
if ($plan.format -ne 1 -or $plan.workspace -cne $Workspace -or -not @($plan.targets).Count) { throw 'Invalid/empty cleanup manifest.' }
foreach ($hold in $holds) {
    if (-not @($plan.dependencies | Where-Object { $_.path -ceq $hold.path }).Count) { throw "Manifest omitted current consumer: $($hold.path)" }
}
$tracked = @(& git -C $Workspace -c core.quotepath=false ls-files | ForEach-Object { Absolute $_ })
if ($LASTEXITCODE) { throw 'Cannot inspect tracked files.' }
$untracked = @(& git -C $Workspace -c core.quotepath=false ls-files --others --exclude-standard | ForEach-Object { Absolute $_ })
if ($LASTEXITCODE) { throw 'Cannot inspect unrelated work.' }
$retained = @($plan.retainedPaths | ForEach-Object { Absolute $_ }) + $untracked + @((Absolute $Manifest))
NoOverlap @($plan.targets | ForEach-Object { Absolute $_.path })
$protection = TargetProtection $retained $tracked
$validated = @()
foreach ($entry in $plan.targets) {
    if ([string]::IsNullOrWhiteSpace($entry.reason)) { throw 'Every cleanup target needs a concrete reason.' }
    $path = ValidateTarget $entry.path $plan.dependencies $retained $tracked $protection
    $measured = [CloseoutMetadata]::Scan($path, $null)
    if ($measured.Errors -or $measured.ReparseSkipped) { throw "Incomplete target metadata: $path" }
    $validated += [pscustomobject]@{path=$path;reason=$entry.reason;measurement=$measured}
    if ($validated.Count % 250 -eq 0) { Write-Host "Validated $($validated.Count)/$($plan.targets.Count) targets" }
}
if ($Mode -eq 'Preview') {
    Save ($prefix + '.json') @{manifest=(Absolute $Manifest);targets=$validated;deleted=0}
    Write-Output "Validated preview: $prefix.json"
    exit
}
if ($plan.timingFinished -ne $true) { throw 'Main must finish timing and release consumers before Delete.' }
$active = @(Get-CimInstance Win32_Process | Where-Object {
    $process = $_
    $usesTarget = @($validated | Where-Object {
        $process.CommandLine -and $process.CommandLine.Contains($_.path, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    $process.ProcessId -ne $PID -and ($usesTarget -or $process.CommandLine -match 'node(?:\.exe)?[" ]+.*(?:--test|windows-stability-run|c1-run|archive-compaction-(?:run|upgrade))')
})
if ($active.Count) { throw 'Tests/benchmark processes are active; cleanup must run after timing.' }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Workspace))
$receipt = [ordered]@{manifest=(Absolute $Manifest);startedAt=[DateTimeOffset]::Now.ToString('o');status='running';
    freeBytesBefore=$drive.TotalFreeSpace;results=@()}
$receiptPath=$prefix + '-receipt.json'
Save $receiptPath $receipt
function FlushReceipt {
    $next = $receiptPath + '.next'
    $receipt | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $next -Encoding utf8
    Move-Item -LiteralPath $next -Destination $receiptPath -Force
}
try {
    foreach ($entry in $validated) {
        $target = ValidateTarget $entry.path $plan.dependencies $retained $tracked $protection
        $current = [CloseoutMetadata]::Scan($target, $null)
        if ($current.Errors -or $current.ReparseSkipped -or $current.MetadataStamp -ne $entry.measurement.MetadataStamp) {
            throw "Target changed after validation: $target"
        }
        # The normalized target and all ancestors/descendants were checked before this recursive delete.
        Remove-Item -LiteralPath $target -Recurse -Force
        if (Test-Path -LiteralPath $target) { throw "Target remains: $target" }
        $receipt.results += @{path=$target;type=$current.Type;attributes=$current.Attributes;deleted=$true;
            logicalBytes=$current.LogicalBytes;allocatedEstimateBytes=$current.ReclaimableAllocatedEstimateBytes;
            sharedOutsideTargetAllocatedBytes=$current.SharedOutsideTargetAllocatedBytes;links=$current.Links}
        FlushReceipt
    }
    $receipt.status='complete'
} catch { $receipt.status='failed';$receipt.error=$_.Exception.Message;throw }
finally {
    $receipt.finishedAt=[DateTimeOffset]::Now.ToString('o');$receipt.freeBytesAfter=$drive.TotalFreeSpace
    $receipt.observedVolumeNetIncreaseBytes=$receipt.freeBytesAfter-$receipt.freeBytesBefore
    FlushReceipt
}
Write-Output "Cleanup receipt: $receiptPath"
