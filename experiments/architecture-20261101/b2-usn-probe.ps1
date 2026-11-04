[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../output/architecture-20261103/b2'),
    [ValidateSet('sandboxed', 'outside', 'unspecified')]
    [string]$ProbeContext = 'unspecified'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class B2IoResult
{
    public bool Success;
    public int ErrorCode;
    public string ErrorName;
    public byte[] Buffer;
    public int BytesReturned;

    public override string ToString()
    {
        return Success
            ? "success bytes=" + BytesReturned
            : "win32=" + ErrorCode + " (" + ErrorName + ")";
    }
}

public sealed class B2JournalData
{
    public bool Success;
    public int ErrorCode;
    public string ErrorName;
    public int BytesReturned;
    public ulong JournalId;
    public long FirstUsn;
    public long NextUsn;
    public long LowestValidUsn;
    public long MaxUsn;
    public ulong MaximumSize;
    public ulong AllocationDelta;
    public ushort MinSupportedMajorVersion;
    public ushort MaxSupportedMajorVersion;
}

public sealed class B2UsnRecord
{
    public ushort MajorVersion;
    public ushort MinorVersion;
    public long Usn;
    public uint Reason;
    public string FileName;
    public int RecordLength;
}

public sealed class B2ReadSummary
{
    public B2IoResult Io;
    public long NextUsn;
    public int RecordCount;
    public int TargetRecordCount;
    public int MalformedRecordCount;
    public List<B2UsnRecord> TargetRecords = new List<B2UsnRecord>();
}

public static class B2UsnNative
{
    public const uint FSCTL_QUERY_USN_JOURNAL = 0x000900F4;
    public const uint FSCTL_READ_USN_JOURNAL = 0x000900BB;
    public const uint FSCTL_READ_FILE_USN_DATA = 0x000900EB;
    public const uint FSCTL_WRITE_USN_CLOSE_RECORD = 0x000900EF;
    public const uint FSCTL_READ_UNPRIVILEGED_USN_JOURNAL = 0x000903AB;

    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        byte[] lpInBuffer,
        uint nInBufferSize,
        byte[] lpOutBuffer,
        uint nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);

    public static SafeFileHandle OpenVolume(string volumePath, uint desiredAccess)
    {
        return CreateFileW(
            volumePath,
            desiredAccess,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            IntPtr.Zero);
    }

    public static SafeFileHandle OpenExisting(
        string path,
        uint desiredAccess,
        uint shareMode,
        uint creationDisposition,
        uint flagsAndAttributes)
    {
        return CreateFileW(
            path,
            desiredAccess,
            shareMode,
            IntPtr.Zero,
            creationDisposition,
            flagsAndAttributes,
            IntPtr.Zero);
    }

    public static int LastError()
    {
        return Marshal.GetLastWin32Error();
    }

    public static string ErrorName(int code)
    {
        if (code == 0) return "ERROR_SUCCESS";
        if (code == 1) return "ERROR_INVALID_FUNCTION";
        if (code == 5) return "ERROR_ACCESS_DENIED";
        if (code == 87) return "ERROR_INVALID_PARAMETER";
        if (code == 122) return "ERROR_INSUFFICIENT_BUFFER";
        if (code == 234) return "ERROR_MORE_DATA";
        if (code == 1179) return "ERROR_JOURNAL_NOT_ACTIVE";
        return new Win32Exception(code).Message;
    }

    public static B2IoResult Invoke(SafeFileHandle handle, uint code, byte[] input, int outputSize)
    {
        if (handle == null || handle.IsInvalid)
            throw new ArgumentException("Invalid file handle.", nameof(handle));
        if (outputSize < 8)
            throw new ArgumentOutOfRangeException(nameof(outputSize));

        byte[] output = new byte[outputSize];
        uint returned;
        Marshal.SetLastSystemError(0);
        bool ok = DeviceIoControl(
            handle,
            code,
            input,
            input == null ? 0u : (uint)input.Length,
            output,
            (uint)output.Length,
            out returned,
            IntPtr.Zero);
        int error = ok ? 0 : Marshal.GetLastWin32Error();
        return new B2IoResult
        {
            Success = ok,
            ErrorCode = error,
            ErrorName = ErrorName(error),
            Buffer = output,
            BytesReturned = (int)returned
        };
    }

    public static B2JournalData Query(SafeFileHandle handle)
    {
        B2IoResult io = Invoke(handle, FSCTL_QUERY_USN_JOURNAL, null, 128);
        B2JournalData result = new B2JournalData
        {
            Success = io.Success,
            ErrorCode = io.ErrorCode,
            ErrorName = io.ErrorName,
            BytesReturned = io.BytesReturned
        };
        if (io.Success && io.BytesReturned >= 64)
        {
            result.JournalId = BitConverter.ToUInt64(io.Buffer, 0);
            result.FirstUsn = BitConverter.ToInt64(io.Buffer, 8);
            result.NextUsn = BitConverter.ToInt64(io.Buffer, 16);
            result.LowestValidUsn = BitConverter.ToInt64(io.Buffer, 24);
            result.MaxUsn = BitConverter.ToInt64(io.Buffer, 32);
            result.MaximumSize = BitConverter.ToUInt64(io.Buffer, 40);
            result.AllocationDelta = BitConverter.ToUInt64(io.Buffer, 48);
            if (io.BytesReturned >= 68)
            {
                result.MinSupportedMajorVersion = BitConverter.ToUInt16(io.Buffer, 56);
                result.MaxSupportedMajorVersion = BitConverter.ToUInt16(io.Buffer, 58);
            }
        }
        return result;
    }

    public static B2ReadSummary Read(
        SafeFileHandle handle,
        uint code,
        long startUsn,
        ulong journalId,
        int outputSize,
        string targetFileName,
        ushort minMajor,
        ushort maxMajor)
    {
        byte[] input = new byte[44];
        Buffer.BlockCopy(BitConverter.GetBytes(startUsn), 0, input, 0, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(uint.MaxValue), 0, input, 8, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(0u), 0, input, 12, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(0ul), 0, input, 16, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(0ul), 0, input, 24, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(journalId), 0, input, 32, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(minMajor), 0, input, 40, 2);
        Buffer.BlockCopy(BitConverter.GetBytes(maxMajor), 0, input, 42, 2);

        B2ReadSummary result = new B2ReadSummary();
        result.Io = Invoke(handle, code, input, outputSize);
        if (!result.Io.Success || result.Io.BytesReturned < 8)
            return result;

        result.NextUsn = BitConverter.ToInt64(result.Io.Buffer, 0);
        int offset = 8;
        while (offset + 8 <= result.Io.BytesReturned)
        {
            int length = BitConverter.ToInt32(result.Io.Buffer, offset);
            ushort major = BitConverter.ToUInt16(result.Io.Buffer, offset + 4);
            int minimum = major == 2 ? 60 : major == 3 ? 76 : 0;
            if (length < minimum || offset + length > result.Io.BytesReturned)
            {
                result.MalformedRecordCount++;
                break;
            }

            result.RecordCount++;
            int nameLengthOffset = major == 2 ? 56 : 72;
            int nameOffsetOffset = major == 2 ? 58 : 74;
            int nameLength = BitConverter.ToUInt16(result.Io.Buffer, offset + nameLengthOffset);
            int nameOffset = BitConverter.ToUInt16(result.Io.Buffer, offset + nameOffsetOffset);
            if (nameOffset >= minimum && nameLength <= length - nameOffset && (nameLength & 1) == 0)
            {
                string name = Encoding.Unicode.GetString(result.Io.Buffer, offset + nameOffset, nameLength);
                if (string.Equals(name, targetFileName, StringComparison.OrdinalIgnoreCase))
                {
                    result.TargetRecordCount++;
                    result.TargetRecords.Add(new B2UsnRecord
                    {
                        MajorVersion = major,
                        MinorVersion = BitConverter.ToUInt16(result.Io.Buffer, offset + 6),
                        Usn = BitConverter.ToInt64(result.Io.Buffer, offset + (major == 2 ? 24 : 40)),
                        Reason = BitConverter.ToUInt32(result.Io.Buffer, offset + (major == 2 ? 40 : 56)),
                        FileName = name,
                        RecordLength = length
                    });
                }
            }
            else
            {
                result.MalformedRecordCount++;
                break;
            }
            offset += length;
        }
        return result;
    }

    public static B2IoResult ReadFileUsn(SafeFileHandle handle, int outputSize)
    {
        byte[] input = new byte[4];
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)2), 0, input, 0, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)2), 0, input, 2, 2);
        return Invoke(handle, FSCTL_READ_FILE_USN_DATA, input, outputSize);
    }
}
'@

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw "SELF-CHECK FAILED: $Message"
    }
}

function Convert-IoEvidence {
    param([B2IoResult]$Io)
    return [ordered]@{
        success = $Io.Success
        win32 = $Io.ErrorCode
        error = $Io.ErrorName
        bytesReturned = $Io.BytesReturned
        requestedBytes = $Io.Buffer.Length
    }
}

function Convert-JournalEvidence {
    param([B2JournalData]$Data)
    return [ordered]@{
        success = $Data.Success
        win32 = $Data.ErrorCode
        error = $Data.ErrorName
        bytesReturned = $Data.BytesReturned
        journalId = $Data.JournalId
        firstUsn = $Data.FirstUsn
        nextUsn = $Data.NextUsn
        lowestValidUsn = $Data.LowestValidUsn
        maxUsn = $Data.MaxUsn
        maximumSize = $Data.MaximumSize
        allocationDelta = $Data.AllocationDelta
        minSupportedMajorVersion = $Data.MinSupportedMajorVersion
        maxSupportedMajorVersion = $Data.MaxSupportedMajorVersion
    }
}

function Convert-ReadEvidence {
    param([B2ReadSummary]$Summary)
    $records = @(
        $Summary.TargetRecords | ForEach-Object {
            [ordered]@{
                majorVersion = $_.MajorVersion
                minorVersion = $_.MinorVersion
                usn = $_.Usn
                reason = ('0x{0:X8}' -f $_.Reason)
                recordLength = $_.RecordLength
            }
        }
    )
    return [ordered]@{
        success = $Summary.Io.Success
        win32 = $Summary.Io.ErrorCode
        error = $Summary.Io.ErrorName
        bytesReturned = $Summary.Io.BytesReturned
        requestedBytes = $Summary.Io.Buffer.Length
        nextUsn = $Summary.NextUsn
        recordCount = $Summary.RecordCount
        targetRecordCount = $Summary.TargetRecordCount
        malformedRecordCount = $Summary.MalformedRecordCount
        targetRecords = $records
    }
}

function Get-FileUsnEvidence {
    param([Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle)
    $io = [B2UsnNative]::ReadFileUsn($Handle, 4096)
    $result = [ordered]@{
        success = $io.Success
        win32 = $io.ErrorCode
        error = $io.ErrorName
        bytesReturned = $io.BytesReturned
        requestedBytes = $io.Buffer.Length
        recordLength = $null
        majorVersion = $null
        minorVersion = $null
        usn = $null
        rawReason = $null
        reasonUsable = $false
    }
    if ($io.Success -and $io.BytesReturned -ge 8) {
        $recordLength = [BitConverter]::ToInt32($io.Buffer, 0)
        $major = [BitConverter]::ToUInt16($io.Buffer, 4)
        $result.recordLength = $recordLength
        $result.majorVersion = $major
        $result.minorVersion = [BitConverter]::ToUInt16($io.Buffer, 6)
        if ($recordLength -le $io.BytesReturned -and ($major -eq 2 -or $major -eq 3)) {
            $reasonOffset = if ($major -eq 2) { 40 } else { 56 }
            $usnOffset = if ($major -eq 2) { 24 } else { 40 }
            $result.usn = [BitConverter]::ToInt64($io.Buffer, $usnOffset)
            $reason = [BitConverter]::ToUInt32($io.Buffer, $reasonOffset)
            $result.rawReason = '0x{0:X8}' -f $reason
        }
    }
    return $result
}

function Invoke-ReadMatrix {
    param(
        [hashtable]$Handles,
        [long]$StartUsn,
        [ulong]$JournalId,
        [string]$TargetName
    )

    $matrix = [ordered]@{}
    foreach ($handleName in @('volume0', 'volumeReadAttributes', 'volumeGenericRead', 'fixtureDirectory', 'fixtureRead')) {
        if ($Handles.ContainsKey($handleName) -and -not $Handles[$handleName].IsInvalid) {
            foreach ($fsctlName in @('unprivileged', 'standard')) {
                $code = if ($fsctlName -eq 'unprivileged') {
                    [B2UsnNative]::FSCTL_READ_UNPRIVILEGED_USN_JOURNAL
                } else {
                    [B2UsnNative]::FSCTL_READ_USN_JOURNAL
                }
                foreach ($outputSize in @(8, 64, 4096, 65536)) {
                    $summary = [B2UsnNative]::Read(
                        $Handles[$handleName],
                        $code,
                        $StartUsn,
                        $JournalId,
                        $outputSize,
                        $TargetName,
                        2,
                        2)
                    $evidence = Convert-ReadEvidence $summary
                    $evidence.startUsn = $StartUsn
                    $evidence.journalId = $JournalId
                    $matrix["$handleName/$fsctlName/$outputSize"] = $evidence
                }
            }
        }
    }
    return $matrix
}

function Test-VolumeCapability {
    param(
        [string]$Label,
        [string]$VolumePath,
        [string]$RootPath,
        [string]$TargetName
    )

    $handles = @{}
    $evidence = [ordered]@{
        label = $Label
        volumePath = $VolumePath
        rootPath = $RootPath
        handles = [ordered]@{}
        query = $null
        queryHandle = $null
        readVectors = [ordered]@{}
        limits = [ordered]@{
            requestedSizes = @(8, 64, 4096, 65536)
            persistedRecordContents = 'none; only status, counts, sizes, and next USN are retained'
        }
    }
    try {
        $handles.volume0 = [B2UsnNative]::OpenVolume($VolumePath, 0)
        $openErrors = @{
            volume0 = [B2UsnNative]::LastError()
        }
        $handles.volumeReadAttributes = [B2UsnNative]::OpenVolume($VolumePath, 0x00000080)
        $openErrors.volumeReadAttributes = [B2UsnNative]::LastError()
        $handles.volumeGenericRead = [B2UsnNative]::OpenVolume($VolumePath, [uint32]2147483648)
        $openErrors.volumeGenericRead = [B2UsnNative]::LastError()
        $handles.fixtureDirectory = [B2UsnNative]::OpenExisting(
            $RootPath,
            0x00000081,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete),
            3,
            0x02000000)
        $openErrors.fixtureDirectory = [B2UsnNative]::LastError()

        foreach ($handleName in @('volume0', 'volumeReadAttributes', 'volumeGenericRead', 'fixtureDirectory')) {
            $handle = $handles[$handleName]
            $openError = $openErrors[$handleName]
            $evidence.handles[$handleName] = [ordered]@{
                invalid = $handle.IsInvalid
                win32 = $openError
                error = [B2UsnNative]::ErrorName($openError)
            }
            if (-not $handle.IsInvalid) {
                $query = [B2UsnNative]::Query($handle)
                $evidence["query/$handleName"] = Convert-JournalEvidence $query
                if (-not $evidence.queryHandle -and $query.Success) {
                    $evidence.queryHandle = $handleName
                    $evidence.query = Convert-JournalEvidence $query
                }
            }
        }

        if ($evidence.queryHandle) {
            $query = [B2UsnNative]::Query($handles[$evidence.queryHandle])
            $evidence.readVectors['fromFirstUsn'] = Invoke-ReadMatrix `
                -Handles $handles `
                -StartUsn $query.FirstUsn `
                -JournalId $query.JournalId `
                -TargetName $TargetName
            $evidence.readVectors['fromNextUsn'] = Invoke-ReadMatrix `
                -Handles $handles `
                -StartUsn $query.NextUsn `
                -JournalId $query.JournalId `
                -TargetName $TargetName
        }
        else {
            # The FSCTL itself is still probed when no checkpoint can be obtained.
            $evidence.readVectors['withoutCheckpoint'] = Invoke-ReadMatrix `
                -Handles $handles `
                -StartUsn 0 `
                -JournalId 0 `
                -TargetName $TargetName
        }

        $allReads = @(
            foreach ($vector in $evidence.readVectors.Values) {
                $vector.Values
            }
        )
        $evidence.bufferBoundsRespected = @(
            $allReads | Where-Object { $_.success -and $_.bytesReturned -gt $_.requestedBytes }
        ).Count -eq 0
        $evidence.privateTargetRecordsPersisted = @(
            $allReads | Where-Object { $_.targetRecordCount -gt 0 }
        ).Count
        return $evidence
    }
    finally {
        foreach ($handle in $handles.Values) {
            if ($handle -and -not $handle.IsInvalid) {
                $handle.Dispose()
            }
        }
    }
}

Assert-True ([B2UsnNative]::FSCTL_QUERY_USN_JOURNAL -eq 0x000900F4) 'FSCTL_QUERY_USN_JOURNAL constant'
Assert-True ([B2UsnNative]::FSCTL_READ_UNPRIVILEGED_USN_JOURNAL -eq 0x000903AB) 'FSCTL_READ_UNPRIVILEGED_USN_JOURNAL constant'
Assert-True ([B2UsnNative]::FSCTL_READ_USN_JOURNAL -eq 0x000900BB) 'FSCTL_READ_USN_JOURNAL constant'
Assert-True ([B2UsnNative]::FSCTL_READ_FILE_USN_DATA -eq 0x000900EB) 'FSCTL_READ_FILE_USN_DATA constant'
Assert-True ([B2UsnNative]::FSCTL_WRITE_USN_CLOSE_RECORD -eq 0x000900EF) 'FSCTL_WRITE_USN_CLOSE_RECORD constant'
Assert-True ([B2UsnNative]::FSCTL_READ_FILE_USN_DATA -ne [B2UsnNative]::FSCTL_WRITE_USN_CLOSE_RECORD) 'read-file and close-record controls differ'

$runId = 'w1-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runRoot = Join-Path $OutputRoot "usn-probe-$runId"
$fixtureRoot = Join-Path $runRoot 'synthetic'
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
$fixtureName = "usn-probe-$([Guid]::NewGuid().ToString('N')).log"
$fixturePath = Join-Path $fixtureRoot $fixtureName
$eVolumePath = '\\.\E:'
$cVolumePath = '\\.\C:'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$drive = [IO.DriveInfo]::new('E:\')
$result = [ordered]@{
    runId = $runId
    generatedUtc = [DateTime]::UtcNow.ToString('O')
    executionContext = $ProbeContext
    identity = $identity.Name
    administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    ownerSid = $identity.Owner.Value
    pwsh = $PSVersionTable.PSVersion.ToString()
    os = [Environment]::OSVersion.VersionString
    processorCount = [Environment]::ProcessorCount
    priorAttemptInvalid = [ordered]@{
        run = 'usn-probe-w1-20261103T042052375Z-797935bf'
        reason = 'READ_FILE_USN_DATA was encoded as 0x000900EF (FSCTL_WRITE_USN_CLOSE_RECORD); its file-USN evidence is invalid.'
        correctReadFileControl = '0x000900EB'
        mistakenControl = '0x000900EF'
    }
    paths = [ordered]@{
        eVolume = $eVolumePath
        cVolume = $cVolumePath
        eVolumeHasNoTrailingBackslash = -not $eVolumePath.EndsWith('\')
        cVolumeHasNoTrailingBackslash = -not $cVolumePath.EndsWith('\')
    }
    fixturePath = $fixturePath
    drive = [ordered]@{
        name = $drive.Name
        format = $drive.DriveFormat
        type = $drive.DriveType.ToString()
        totalSize = $drive.TotalSize
        availableFreeSpace = $drive.AvailableFreeSpace
    }
    constants = [ordered]@{
        query = '0x{0:X8}' -f [B2UsnNative]::FSCTL_QUERY_USN_JOURNAL
        unprivilegedRead = '0x{0:X8}' -f [B2UsnNative]::FSCTL_READ_UNPRIVILEGED_USN_JOURNAL
        standardRead = '0x{0:X8}' -f [B2UsnNative]::FSCTL_READ_USN_JOURNAL
        readFile = '0x{0:X8}' -f [B2UsnNative]::FSCTL_READ_FILE_USN_DATA
        writeCloseRecord = '0x{0:X8}' -f [B2UsnNative]::FSCTL_WRITE_USN_CLOSE_RECORD
    }
    handles = [ordered]@{}
    checkpoints = [ordered]@{}
    steps = [ordered]@{}
    beforeClose = [ordered]@{}
    afterClose = [ordered]@{}
    activeVolumeCapability = $null
    coverage = [ordered]@{}
    assertions = [ordered]@{}
}

$handles = @{}
$writer = $null
$reopened = $null
$writerHandleKeptOpen = $false
try {
    $handles.volume0 = [B2UsnNative]::OpenVolume($eVolumePath, 0)
    $volume0Error = [B2UsnNative]::LastError()
    $handles.volumeReadAttributes = [B2UsnNative]::OpenVolume($eVolumePath, 0x00000080)
    $volumeReadAttributesError = [B2UsnNative]::LastError()
    $handles.volumeGenericRead = [B2UsnNative]::OpenVolume($eVolumePath, [uint32]2147483648)
    $volumeGenericReadError = [B2UsnNative]::LastError()
    $handles.fixtureDirectory = [B2UsnNative]::OpenExisting(
        $fixtureRoot,
        0x00000081,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete),
        3,
        0x02000000)
    $fixtureDirectoryError = [B2UsnNative]::LastError()
    $result.handles.volume0 = [ordered]@{ invalid = $handles.volume0.IsInvalid; win32 = $volume0Error; error = [B2UsnNative]::ErrorName($volume0Error) }
    $result.handles.volumeReadAttributes = [ordered]@{ invalid = $handles.volumeReadAttributes.IsInvalid; win32 = $volumeReadAttributesError; error = [B2UsnNative]::ErrorName($volumeReadAttributesError) }
    $result.handles.volumeGenericRead = [ordered]@{ invalid = $handles.volumeGenericRead.IsInvalid; win32 = $volumeGenericReadError; error = [B2UsnNative]::ErrorName($volumeGenericReadError) }
    $result.handles.fixtureDirectory = [ordered]@{ invalid = $handles.fixtureDirectory.IsInvalid; win32 = $fixtureDirectoryError; error = [B2UsnNative]::ErrorName($fixtureDirectoryError) }

    $queryHandles = [ordered]@{}
    foreach ($handleName in @('volume0', 'volumeReadAttributes', 'volumeGenericRead', 'fixtureDirectory')) {
        if (-not $handles[$handleName].IsInvalid) {
            $queryHandles[$handleName] = Convert-JournalEvidence ([B2UsnNative]::Query($handles[$handleName]))
        }
    }
    $result.steps.preOpenQueries = $queryHandles

    $queryHandleName = @('volume0', 'volumeReadAttributes', 'volumeGenericRead', 'fixtureDirectory') |
        Where-Object { -not $handles[$_].IsInvalid } |
        Where-Object { $queryHandles[$_].success } |
        Select-Object -First 1
    $queryHandle = if ($queryHandleName) { $handles[$queryHandleName] } else { $null }
    if ($queryHandle) {
        $initialJournal = [B2UsnNative]::Query($queryHandle)
        Assert-True $initialJournal.Success 'selected initial journal query remains successful'
        Assert-True ($initialJournal.JournalId -ne 0) 'journal ID is nonzero'
        $result.checkpoints.preOpen = Convert-JournalEvidence $initialJournal
        $result.checkpoints.capturedAvailable = $true
        $result.checkpoints.capturedOnHandle = $queryHandleName
    }
    else {
        $result.checkpoints.capturedAvailable = $false
        $result.checkpoints.blocker = 'No ordinary-token E: handle returned a journal checkpoint; append intervals cannot be anchored by journal USN.'
    }

    $writer = [IO.FileStream]::new(
        $fixturePath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete),
        4096,
        [IO.FileOptions]::WriteThrough)
    $writerHandleKeptOpen = $true
    $handles.fixtureRead = [B2UsnNative]::OpenExisting(
        $fixturePath,
        [uint32]2147483648,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete),
        3,
        0)
    $fixtureReadError = [B2UsnNative]::LastError()
    $result.handles.fixtureRead = [ordered]@{ invalid = $handles.fixtureRead.IsInvalid; win32 = $fixtureReadError; error = [B2UsnNative]::ErrorName($fixtureReadError) }

    $bytes = [Text.Encoding]::UTF8.GetBytes("initial-alpha`ninitial-beta`n")
    $writer.Write($bytes, 0, $bytes.Length)
    $writer.Flush($true)
    $result.steps.initialWrite = [ordered]@{
        bytes = $bytes.Length
        lengthAfter = $writer.Length
        fileUsn = Get-FileUsnEvidence $writer.SafeFileHandle
    }

    $checkpoint = $null
    if ($queryHandle) {
        $checkpoint = [B2UsnNative]::Query($queryHandle)
        Assert-True $checkpoint.Success 'checkpoint query succeeds'
        $result.checkpoints.capturedAfterInitialOpenWrite = Convert-JournalEvidence $checkpoint
    }
    $result.steps.checkpointFileUsn = Get-FileUsnEvidence $writer.SafeFileHandle

    $bytes = [Text.Encoding]::UTF8.GetBytes("append-one`n")
    $writer.Write($bytes, 0, $bytes.Length)
    $writer.Flush($true)
    $result.steps.appendOne = [ordered]@{
        bytes = $bytes.Length
        lengthAfter = $writer.Length
        fileUsn = Get-FileUsnEvidence $writer.SafeFileHandle
    }

    $bytes = [Text.Encoding]::UTF8.GetBytes("append-two`n")
    $writer.Write($bytes, 0, $bytes.Length)
    $writer.Flush($true)
    $result.steps.appendTwo = [ordered]@{
        bytes = $bytes.Length
        lengthAfter = $writer.Length
        fileUsn = Get-FileUsnEvidence $writer.SafeFileHandle
    }

    $middle = [Text.Encoding]::UTF8.GetBytes('XXXXX')
    $writer.Position = 2
    $writer.Write($middle, 0, $middle.Length)
    $writer.Flush($true)
    $writer.Position = $writer.Length
    $bytes = [Text.Encoding]::UTF8.GetBytes("append-after-overwrite`n")
    $writer.Write($bytes, 0, $bytes.Length)
    $writer.Flush($true)
    $result.steps.middleOverwritePlusAppend = [ordered]@{
        overwriteBytes = $middle.Length
        appendBytes = $bytes.Length
        lengthAfter = $writer.Length
        fileUsn = Get-FileUsnEvidence $writer.SafeFileHandle
    }

    $preCloseJournal = $null
    if ($queryHandle) {
        $preCloseJournal = [B2UsnNative]::Query($queryHandle)
        Assert-True $preCloseJournal.Success 'pre-close journal query succeeds'
        $result.beforeClose.query = Convert-JournalEvidence $preCloseJournal
        if ($checkpoint) {
            $result.beforeClose.intervalDelta = $preCloseJournal.NextUsn - $checkpoint.NextUsn
            $result.beforeClose.readFromCheckpoint = Invoke-ReadMatrix `
                -Handles $handles `
                -StartUsn $checkpoint.NextUsn `
                -JournalId $checkpoint.JournalId `
                -TargetName $fixtureName
        }
    }
    else {
        $result.beforeClose.queryAvailable = $false
        $result.beforeClose.readWithoutCheckpoint = Invoke-ReadMatrix `
            -Handles $handles `
            -StartUsn 0 `
            -JournalId 0 `
            -TargetName $fixtureName
    }
    $result.beforeClose.fileUsn = Get-FileUsnEvidence $writer.SafeFileHandle

    $writerHandleKeptOpen = -not $writer.SafeFileHandle.IsClosed -and -not $writer.SafeFileHandle.IsInvalid
    $writer.Dispose()
    $writer = $null

    $afterCloseJournal = $null
    if ($queryHandle) {
        $afterCloseJournal = [B2UsnNative]::Query($queryHandle)
        Assert-True $afterCloseJournal.Success 'post-close journal query succeeds'
        $result.afterClose.query = Convert-JournalEvidence $afterCloseJournal
        if ($preCloseJournal) {
            $result.afterClose.closeDelta = $afterCloseJournal.NextUsn - $preCloseJournal.NextUsn
        }

        $checkpointNames = @('preOpen', 'capturedAfterInitialOpenWrite')
        foreach ($checkpointName in $checkpointNames) {
            if ($result.checkpoints.Contains($checkpointName)) {
                $point = $result.checkpoints[$checkpointName]
                $result.afterClose["readFrom$($checkpointName.Substring(0,1).ToUpperInvariant() + $checkpointName.Substring(1))"] =
                    Invoke-ReadMatrix `
                        -Handles $handles `
                        -StartUsn $point.nextUsn `
                        -JournalId $point.journalId `
                        -TargetName $fixtureName
            }
        }
    }
    else {
        $result.afterClose.queryAvailable = $false
        $result.afterClose.readWithoutCheckpoint = Invoke-ReadMatrix `
            -Handles $handles `
            -StartUsn 0 `
            -JournalId 0 `
            -TargetName $fixtureName
    }

    $reopened = [IO.FileStream]::new(
        $fixturePath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete),
        4096,
        [IO.FileOptions]::None)
    $result.afterClose.fileUsn = Get-FileUsnEvidence $reopened.SafeFileHandle
    $actualContent = [IO.File]::ReadAllText($fixturePath, [Text.Encoding]::UTF8)
    $expectedContent = 'initial-alpha' + "`n" + 'initial-beta' + "`n" + 'append-one' + "`n" + 'append-two' + "`n" + 'append-after-overwrite' + "`n"
    $expectedContent = $expectedContent.Substring(0, 2) + 'XXXXX' + $expectedContent.Substring(7)
    $result.afterClose.expectedContentMatches = $actualContent -ceq $expectedContent
    $result.afterClose.contentSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath).Hash
    $result.afterClose.length = (Get-Item -LiteralPath $fixturePath).Length

    $syntheticReadSections = @()
    foreach ($entry in @(
        @{ owner = $result.beforeClose; key = 'readFromCheckpoint' },
        @{ owner = $result.beforeClose; key = 'readWithoutCheckpoint' },
        @{ owner = $result.afterClose; key = 'readFromPreOpen' },
        @{ owner = $result.afterClose; key = 'readFromCapturedAfterInitialOpenWrite' },
        @{ owner = $result.afterClose; key = 'readWithoutCheckpoint' })) {
        if ($entry.owner.Contains($entry.key)) {
            $syntheticReadSections += $entry.owner[$entry.key]
        }
    }
    $allSyntheticReads = @(
        foreach ($section in $syntheticReadSections) {
            if ($section) {
                $section.Values
            }
        }
    )
    $result.coverage.eJournalCheckpointAvailable = [bool]$queryHandle
    $result.coverage.eJournalInactiveObserved = @(
        $queryHandles.Values | Where-Object { -not $_.success -and $_.win32 -eq 1179 }
    ).Count -gt 0
    $result.coverage.newApiProbedWithoutCheckpoint = -not [bool]$queryHandle
    $result.coverage.bufferBoundsRespected = @(
        $allSyntheticReads | Where-Object { $_.success -and $_.bytesReturned -gt $_.requestedBytes }
    ).Count -eq 0
    $result.coverage.beforeCloseTargetRecordCount = if ($result.beforeClose.Contains('readFromCheckpoint')) {
        @($result.beforeClose.readFromCheckpoint.Values | ForEach-Object { $_.targetRecordCount } | Measure-Object -Sum).Sum
    } else { $null }
    $result.coverage.afterCloseTargetRecordCount = if ($result.afterClose.Contains('readFromCapturedAfterInitialOpenWrite')) {
        @($result.afterClose.readFromCapturedAfterInitialOpenWrite.Values | ForEach-Object { $_.targetRecordCount } | Measure-Object -Sum).Sum
    } else { $null }
    $result.coverage.appendBehaviorObserved = [bool]$queryHandle
    $result.coverage.finalJournalCanAttributeAllFourIntervals = $false
    $result.coverage.fileUsnReasonCertifiesAppend = $false
    $result.coverage.intervalCoverage = @(
        [ordered]@{
            interval = 'initial-open-write'
            checkpointBefore = 'preOpen (only if available)'
            observedFileUsnAfter = $result.steps.initialWrite.fileUsn.usn
            canProveExtendFromJournalWithoutOverwrite = $false
        },
        [ordered]@{
            interval = 'append-one'
            checkpointBefore = 'capturedAfterInitialOpenWrite (only if available)'
            observedFileUsnAfter = $result.steps.appendOne.fileUsn.usn
            canProveExtendFromJournalWithoutOverwrite = $false
        },
        [ordered]@{
            interval = 'append-two'
            checkpointBefore = 'not captured independently; coalescing may merge the open-handle interval'
            observedFileUsnAfter = $result.steps.appendTwo.fileUsn.usn
            canProveExtendFromJournalWithoutOverwrite = $false
        },
        [ordered]@{
            interval = 'middle-overwrite-plus-append'
            checkpointBefore = 'not captured independently; coalescing may merge the open-handle interval'
            observedFileUsnAfter = $result.steps.middleOverwritePlusAppend.fileUsn.usn
            canProveExtendFromJournalWithoutOverwrite = $false
        }
    )

    $cTargetName = "__b2_absent_target_$([Guid]::NewGuid().ToString('N'))"
    $result.activeVolumeCapability = Test-VolumeCapability `
        -Label 'C: ordinary-token read-only capability; no third-party record contents retained' `
        -VolumePath $cVolumePath `
        -RootPath 'C:\' `
        -TargetName $cTargetName
    $cPairs = @(
        foreach ($vectorName in $result.activeVolumeCapability.readVectors.Keys) {
            $vector = $result.activeVolumeCapability.readVectors[$vectorName]
            foreach ($key in $vector.Keys) {
                [pscustomobject]@{
                    vector = $vectorName
                    name = $key
                    evidence = $vector[$key]
                }
            }
        }
    )
    $result.activeVolumeCapability.unprivilegedSuccesses = @(
        $cPairs | Where-Object { $_.name -like '*/unprivileged/*' -and $_.evidence.success }
    ).Count
    $result.activeVolumeCapability.unprivilegedErrors = @(
        $cPairs |
            Where-Object { $_.name -like '*/unprivileged/*' -and -not $_.evidence.success } |
            ForEach-Object { $_.evidence.win32 } |
            Sort-Object -Unique
    )
    $result.activeVolumeCapability.standardSuccesses = @(
        $cPairs | Where-Object { $_.name -like '*/standard/*' -and $_.evidence.success }
    ).Count
    $result.activeVolumeCapability.standardErrors = @(
        $cPairs |
            Where-Object { $_.name -like '*/standard/*' -and -not $_.evidence.success } |
            ForEach-Object { $_.evidence.win32 } |
            Sort-Object -Unique
    )

    Assert-True ($result.drive.format -eq 'NTFS') 'fixture is on NTFS'
    Assert-True (-not $result.administrator) 'probe process is an ordinary Windows token'
    Assert-True ($eVolumePath -ceq '\\.\E:') 'E volume path is exactly \\.\E:'
    Assert-True ($cVolumePath -ceq '\\.\C:') 'C volume path is exactly \\.\C:'
    Assert-True $result.paths.eVolumeHasNoTrailingBackslash 'E volume path has no trailing backslash'
    Assert-True $writerHandleKeptOpen 'writer handle remained open through all four synthetic intervals'
    Assert-True ($result.coverage.bufferBoundsRespected -eq $true) 'all successful synthetic reads respect requested buffer bounds'
    Assert-True ($result.coverage.fileUsnReasonCertifiesAppend -eq $false) 'file USN reason is intentionally not trusted'
    Assert-True $result.afterClose.expectedContentMatches 'fixture contains all three appends and middle overwrite'
    Assert-True ($result.coverage.finalJournalCanAttributeAllFourIntervals -eq $false) 'coalesced or unavailable records cannot attribute every interval'
    Assert-True ($result.activeVolumeCapability.privateTargetRecordsPersisted -eq 0) 'no third-party journal target record was retained'
    Assert-True ($result.activeVolumeCapability.bufferBoundsRespected -eq $true) 'all successful active-volume reads respect requested bounds'
    $result.assertions.cliSelfChecks = 'passed'
}
catch {
    $result.failure = [ordered]@{
        message = $_.Exception.Message
        type = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
    }
    $result.assertions.cliSelfChecks = 'failed'
    throw
}
finally {
    if ($writer) { $writer.Dispose() }
    if ($reopened) { $reopened.Dispose() }
    foreach ($handle in $handles.Values) {
        if ($handle -and -not $handle.IsInvalid) { $handle.Dispose() }
    }

    $resultPath = Join-Path $runRoot 'result.json'
    $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resultPath -Encoding utf8
    Write-Output $runRoot
}
