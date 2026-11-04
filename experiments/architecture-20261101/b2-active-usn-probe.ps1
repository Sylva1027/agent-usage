[CmdletBinding()]
param(
    [string]$RunLabel = 'natural-and-seal',
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

public sealed class B2FileIdentity
{
    public uint VolumeSerialNumber;
    public ulong FileIndex64;
    public string FileId128Hex;
    public long CreationTimeUtcTicks;

    public string Signature64
    {
        get { return VolumeSerialNumber.ToString("X8") + ":" + FileIndex64.ToString("X16"); }
    }

    public string Signature
    {
        get { return Signature64 + ":" + FileId128Hex; }
    }
}

public sealed class B2UsnRecord
{
    public int MajorVersion;
    public int MinorVersion;
    public int RecordLength;
    public long Usn;
    public uint Reason;
    public string FileReferenceHex;
    public string FileId128Hex;
    public string FileName;
    public int TargetMatch;
}

public sealed class B2ReadPage
{
    public B2IoResult Io;
    public long NextUsn;
    public int RecordCount;
    public int TargetRecordCount;
    public int V2RecordCount;
    public int V3RecordCount;
    public int UnsupportedRecordCount;
    public int MalformedRecordCount;
    public bool BufferBoundsRespected;
    public List<B2UsnRecord> TargetRecords = new List<B2UsnRecord>();
}

[StructLayout(LayoutKind.Sequential)]
public struct BY_HANDLE_FILE_INFORMATION
{
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
}

public static class B2ActiveUsnNative
{
    public const uint FSCTL_QUERY_USN_JOURNAL = 0x000900F4;
    public const uint FSCTL_READ_UNPRIVILEGED_USN_JOURNAL = 0x000903AB;
    public const uint FSCTL_WRITE_USN_CLOSE_RECORD = 0x000900EF;

    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint FILE_SHARE_DELETE = 0x00000004;
    public const uint OPEN_EXISTING = 3;
    public const uint CREATE_ALWAYS = 2;
    public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    public const uint FILE_BEGIN = 0;
    public const uint FILE_END = 2;

    private const int FileIdInfoClass = 18;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle hFile,
        out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle hFile,
        int fileInformationClass,
        IntPtr lpFileInformation,
        uint dwBufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        SafeFileHandle hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle hFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetEndOfFile(SafeFileHandle hFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFilePointerEx(
        SafeFileHandle hFile,
        long liDistanceToMove,
        out long lpNewFilePointer,
        uint dwMoveMethod);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(
        string lpExistingFileName,
        string lpNewFileName,
        uint dwFlags);

    public static SafeFileHandle OpenPath(
        string path,
        uint desiredAccess,
        uint creationDisposition,
        uint flagsAndAttributes)
    {
        return CreateFileW(
            path,
            desiredAccess,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
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
        if (code == 32) return "ERROR_SHARING_VIOLATION";
        if (code == 87) return "ERROR_INVALID_PARAMETER";
        if (code == 122) return "ERROR_INSUFFICIENT_BUFFER";
        if (code == 234) return "ERROR_MORE_DATA";
        if (code == 1179) return "ERROR_JOURNAL_NOT_ACTIVE";
        return new Win32Exception(code).Message;
    }

    public static B2IoResult Invoke(
        SafeFileHandle handle,
        uint code,
        byte[] input,
        int outputSize)
    {
        if (handle == null || handle.IsInvalid)
            throw new ArgumentException("Invalid file handle.", nameof(handle));
        if (outputSize < 0)
            throw new ArgumentOutOfRangeException(nameof(outputSize));

        byte[] output = outputSize == 0 ? null : new byte[outputSize];
        uint returned;
        Marshal.SetLastSystemError(0);
        bool ok = DeviceIoControl(
            handle,
            code,
            input,
            input == null ? 0u : (uint)input.Length,
            output,
            output == null ? 0u : (uint)output.Length,
            out returned,
            IntPtr.Zero);
        int error = ok ? 0 : Marshal.GetLastWin32Error();
        return new B2IoResult
        {
            Success = ok,
            ErrorCode = error,
            ErrorName = ErrorName(error),
            Buffer = output ?? new byte[0],
            BytesReturned = (int)returned
        };
    }

    public static B2IoResult SealRecord(SafeFileHandle handle)
    {
        return Invoke(handle, FSCTL_WRITE_USN_CLOSE_RECORD, null, 8);
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

    public static B2FileIdentity GetIdentity(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info))
            throw new Win32Exception(Marshal.GetLastWin32Error());

        long fileTime = ((long)info.CreationTime.dwHighDateTime << 32) |
                        (uint)info.CreationTime.dwLowDateTime;
        long ticks = fileTime == 0 ? 0 : DateTime.FromFileTimeUtc(fileTime).Ticks;
        ulong index64 = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;

        byte[] fileId128 = new byte[16];
        IntPtr buffer = Marshal.AllocHGlobal(24);
        try
        {
            if (GetFileInformationByHandleEx(handle, FileIdInfoClass, buffer, 24))
                Marshal.Copy(IntPtr.Add(buffer, 8), fileId128, 0, 16);
            else
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        return new B2FileIdentity
        {
            VolumeSerialNumber = info.VolumeSerialNumber,
            FileIndex64 = index64,
            FileId128Hex = Hex(fileId128),
            CreationTimeUtcTicks = ticks
        };
    }

    public static B2ReadPage ReadJournal(
        SafeFileHandle handle,
        long startUsn,
        ulong journalId,
        int outputSize,
        ushort minMajor,
        ushort maxMajor,
        B2FileIdentity targetA,
        B2FileIdentity targetB)
    {
        if (outputSize < 8)
            throw new ArgumentOutOfRangeException(nameof(outputSize));

        byte[] input = new byte[44];
        Buffer.BlockCopy(BitConverter.GetBytes(startUsn), 0, input, 0, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(uint.MaxValue), 0, input, 8, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(0u), 0, input, 12, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(0ul), 0, input, 16, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(0ul), 0, input, 24, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(journalId), 0, input, 32, 8);
        Buffer.BlockCopy(BitConverter.GetBytes(minMajor), 0, input, 40, 2);
        Buffer.BlockCopy(BitConverter.GetBytes(maxMajor), 0, input, 42, 2);

        B2ReadPage result = new B2ReadPage
        {
            Io = Invoke(handle, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, input, outputSize),
            BufferBoundsRespected = true
        };

        if (!result.Io.Success)
            return result;
        return ParseJournalPayload(result.Io, targetA, targetB, result);
    }

    public static B2ReadPage ParseSyntheticPayload(
        byte[] buffer,
        int bytesReturned,
        B2FileIdentity targetA,
        B2FileIdentity targetB)
    {
        if (buffer == null)
            throw new ArgumentNullException(nameof(buffer));
        if (bytesReturned < 0 || bytesReturned > buffer.Length)
            throw new ArgumentOutOfRangeException(nameof(bytesReturned));

        B2IoResult io = new B2IoResult
        {
            Success = true,
            ErrorCode = 0,
            ErrorName = "ERROR_SUCCESS",
            Buffer = buffer,
            BytesReturned = bytesReturned
        };
        return ParseJournalPayload(io, targetA, targetB, new B2ReadPage
        {
            Io = io,
            BufferBoundsRespected = true
        });
    }

    private static B2ReadPage ParseJournalPayload(
        B2IoResult io,
        B2FileIdentity targetA,
        B2FileIdentity targetB,
        B2ReadPage result)
    {
        if (io.BytesReturned < 8 || io.BytesReturned > io.Buffer.Length)
        {
            result.BufferBoundsRespected = false;
            result.MalformedRecordCount++;
            return result;
        }

        result.NextUsn = BitConverter.ToInt64(io.Buffer, 0);
        int offset = 8;
        while (offset < io.BytesReturned)
        {
            if (io.BytesReturned - offset < 8)
            {
                result.MalformedRecordCount++;
                break;
            }

            int length = BitConverter.ToInt32(io.Buffer, offset);
            ushort major = BitConverter.ToUInt16(io.Buffer, offset + 4);
            ushort minor = BitConverter.ToUInt16(io.Buffer, offset + 6);

            if (major != 2 && major != 3)
            {
                result.UnsupportedRecordCount++;
                break;
            }

            int minimum = major == 2 ? 60 : 76;
            if (length < minimum || offset + length > io.BytesReturned)
            {
                result.MalformedRecordCount++;
                break;
            }

            int nameLengthOffset = major == 2 ? 56 : 72;
            int nameOffsetOffset = major == 2 ? 58 : 74;
            int nameLength = BitConverter.ToUInt16(io.Buffer, offset + nameLengthOffset);
            int nameOffset = BitConverter.ToUInt16(io.Buffer, offset + nameOffsetOffset);
            if (nameOffset < minimum || (nameLength & 1) != 0 || nameLength > length - nameOffset)
            {
                result.MalformedRecordCount++;
                break;
            }

            B2UsnRecord record = new B2UsnRecord
            {
                MajorVersion = major,
                MinorVersion = minor,
                RecordLength = length,
                Usn = BitConverter.ToInt64(io.Buffer, offset + (major == 2 ? 24 : 40)),
                Reason = BitConverter.ToUInt32(io.Buffer, offset + (major == 2 ? 40 : 56)),
                FileName = nameLength == 0
                    ? string.Empty
                    : Encoding.Unicode.GetString(io.Buffer, offset + nameOffset, nameLength)
            };

            if (major == 2)
            {
                ulong fileReference = BitConverter.ToUInt64(io.Buffer, offset + 8);
                record.FileReferenceHex = fileReference.ToString("X16");
                record.FileId128Hex = string.Empty;
                record.TargetMatch = Matches64(targetA, fileReference) ? 0 :
                                     Matches64(targetB, fileReference) ? 1 : -1;
                result.V2RecordCount++;
            }
            else
            {
                byte[] fileReference = new byte[16];
                Buffer.BlockCopy(io.Buffer, offset + 8, fileReference, 0, 16);
                record.FileReferenceHex = Hex(fileReference);
                record.FileId128Hex = record.FileReferenceHex;
                record.TargetMatch = Matches128(targetA, fileReference) ? 0 :
                                     Matches128(targetB, fileReference) ? 1 : -1;
                result.V3RecordCount++;
            }

            result.RecordCount++;
            if (record.TargetMatch >= 0)
            {
                result.TargetRecordCount++;
                result.TargetRecords.Add(record);
            }
            offset += length;
        }

        return result;
    }

    private static bool Matches64(B2FileIdentity identity, ulong fileReference)
    {
        return identity != null && identity.FileIndex64 == fileReference;
    }

    private static bool Matches128(B2FileIdentity identity, byte[] fileReference)
    {
        return identity != null &&
               string.Equals(identity.FileId128Hex, Hex(fileReference), StringComparison.OrdinalIgnoreCase);
    }

    private static string Hex(byte[] value)
    {
        StringBuilder builder = new StringBuilder(value.Length * 2);
        foreach (byte item in value)
            builder.Append(item.ToString("x2"));
        return builder.ToString();
    }

    public static void WriteBytes(SafeFileHandle handle, byte[] bytes)
    {
        int offset = 0;
        while (offset < bytes.Length)
        {
            int remaining = bytes.Length - offset;
            byte[] chunk = bytes;
            if (offset != 0 || remaining != bytes.Length)
            {
                chunk = new byte[remaining];
                Buffer.BlockCopy(bytes, offset, chunk, 0, remaining);
            }

            uint wrote;
            if (!WriteFile(handle, chunk, (uint)chunk.Length, out wrote, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (wrote == 0)
                throw new IOException("WriteFile returned zero bytes.");
            offset += (int)wrote;
        }
    }

    public static void Flush(SafeFileHandle handle)
    {
        if (!FlushFileBuffers(handle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void Seek(SafeFileHandle handle, long offset, uint origin)
    {
        long position;
        if (!SetFilePointerEx(handle, offset, out position, origin))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void TruncateAtEnd(SafeFileHandle handle)
    {
        if (!SetEndOfFile(handle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void Move(string source, string destination)
    {
        if (!MoveFileExW(source, destination, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static byte[] ReadAll(string path)
    {
        using (FileStream stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete))
        {
            if (stream.Length > int.MaxValue)
                throw new IOException("Fixture is too large for the probe.");
            byte[] data = new byte[(int)stream.Length];
            int offset = 0;
            while (offset < data.Length)
            {
                int read = stream.Read(data, offset, data.Length - offset);
                if (read == 0)
                    throw new EndOfStreamException();
                offset += read;
            }
            return data;
        }
    }
}
'@

$script:AssertionCount = 0

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    $script:AssertionCount++
    if (-not $Condition) {
        throw "SELF-CHECK FAILED: $Message"
    }
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Bytes))
}

function New-PatternBytes {
    param(
        [int]$Seed,
        [int]$Length
    )
    $bytes = [byte[]]::new($Length)
    [uint32]$state = [uint32]$Seed
    for ($i = 0; $i -lt $Length; $i++) {
        $state = [uint32](($state * [uint32]1664525 + [uint32]1013904223) -band [uint32]::MaxValue)
        $bytes[$i] = [byte](($state -shr 24) -band 0xFF)
    }
    return ,$bytes
}

function Join-ByteArrays {
    param(
        [byte[]]$Left,
        [byte[]]$Right
    )
    $result = [byte[]]::new($Left.Length + $Right.Length)
    [Array]::Copy($Left, 0, $result, 0, $Left.Length)
    [Array]::Copy($Right, 0, $result, $Left.Length, $Right.Length)
    return ,$result
}

function Set-ByteRange {
    param(
        [byte[]]$Target,
        [int]$Offset,
        [byte[]]$Replacement
    )
    Assert-True ($Offset -ge 0 -and $Offset + $Replacement.Length -le $Target.Length) 'overwrite range is within the expected file'
    [Array]::Copy($Replacement, 0, $Target, $Offset, $Replacement.Length)
}

function Convert-MajorVersionCount {
    param([System.Collections.Generic.List[B2UsnRecord]]$Records)
    return [ordered]@{
        v2 = @($Records | Where-Object MajorVersion -eq 2).Count
        v3 = @($Records | Where-Object MajorVersion -eq 3).Count
    }
}

function Get-ReasonMask {
    param([System.Collections.Generic.List[B2UsnRecord]]$Records)
    [uint32]$mask = 0
    foreach ($record in $Records) {
        $mask = [uint32]($mask -bor $record.Reason)
    }
    return $mask
}

function Format-ReasonMask {
    param([uint32]$Mask)
    $names = [System.Collections.Generic.List[string]]::new()
    if (($Mask -band 0x00000001) -ne 0) { $names.Add('DATA_OVERWRITE') }
    if (($Mask -band 0x00000002) -ne 0) { $names.Add('DATA_EXTEND') }
    if (($Mask -band 0x00000004) -ne 0) { $names.Add('DATA_TRUNCATION') }
    if (($Mask -band 0x00000100) -ne 0) { $names.Add('FILE_CREATE') }
    if (($Mask -band 0x00000200) -ne 0) { $names.Add('FILE_DELETE') }
    if (($Mask -band 0x00001000) -ne 0) { $names.Add('RENAME_OLD_NAME') }
    if (($Mask -band 0x00002000) -ne 0) { $names.Add('RENAME_NEW_NAME') }
    if (($Mask -band 0x80000000) -ne 0) { $names.Add('CLOSE') }
    return @($names)
}

function Convert-IoEvidence {
    param([B2IoResult]$Io)
    return [ordered]@{
        success = $Io.Success
        win32 = $Io.ErrorCode
        error = $Io.ErrorName
        bytesReturned = $Io.BytesReturned
    }
}

function Convert-SealEvidence {
    param([B2IoResult]$Io)
    $result = [ordered]@{
        success = $Io.Success
        win32 = $Io.ErrorCode
        error = $Io.ErrorName
        bytesReturned = $Io.BytesReturned
        sealUsn = $null
    }
    if ($Io.Success -and $Io.BytesReturned -ge 8) {
        $result.sealUsn = [BitConverter]::ToInt64($Io.Buffer, 0)
    }
    return $result
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
        minSupportedMajorVersion = $Data.MinSupportedMajorVersion
        maxSupportedMajorVersion = $Data.MaxSupportedMajorVersion
    }
}

function Convert-IdentityEvidence {
    param([B2FileIdentity]$Identity)
    return [ordered]@{
        volumeSerialNumber = ('0x{0:X8}' -f $Identity.VolumeSerialNumber)
        fileIndex64 = ('0x{0:X16}' -f $Identity.FileIndex64)
        fileId128 = $Identity.FileId128Hex
        creationTimeUtcTicks = $Identity.CreationTimeUtcTicks
        signature = $Identity.Signature
    }
}

function Query-JournalOrThrow {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
        [string]$Label
    )
    $query = [B2ActiveUsnNative]::Query($Handle)
    Assert-True $query.Success "journal query must succeed at $Label; got $($query.ErrorName) ($($query.ErrorCode))"
    Assert-True ($query.BytesReturned -ge 64) "journal query returned a complete structure at $Label"
    return $query
}

function Assert-Content {
    param(
        [string]$Path,
        [byte[]]$Expected,
        [string]$Label
    )
    $actual = [B2ActiveUsnNative]::ReadAll($Path)
    $expectedHash = Get-Sha256Hex $Expected
    $actualHash = Get-Sha256Hex $actual
    Assert-True ($actual.Length -eq $Expected.Length) "full byte length matches at $Label"
    Assert-True ([string]::Equals($expectedHash, $actualHash, [StringComparison]::Ordinal)) "full byte SHA-256 matches at $Label"
    $state.contentChecks[$Label] = [ordered]@{
        length = $actual.Length
        sha256 = $actualHash
    }
}

function Write-AllBytes {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
        [byte[]]$Bytes,
        [string]$Path,
        [byte[]]$Expected,
        [string]$Label
    )
    [B2ActiveUsnNative]::WriteBytes($Handle, $Bytes)
    [B2ActiveUsnNative]::Flush($Handle)
    Assert-Content -Path $Path -Expected $Expected -Label $Label
}

function Open-HandleOrThrow {
    param(
        [string]$Path,
        [uint32]$DesiredAccess,
        [uint32]$CreationDisposition,
        [uint32]$FlagsAndAttributes,
        [string]$Label
    )
    $handle = [B2ActiveUsnNative]::OpenPath($Path, $DesiredAccess, $CreationDisposition, $FlagsAndAttributes)
    if ($handle.IsInvalid) {
        $code = [B2ActiveUsnNative]::LastError()
        $handle.Dispose()
        throw "Open failed at $Label`: $([B2ActiveUsnNative]::ErrorName($code)) ($code)"
    }
    $script:openHandles.Add($handle)
    return $handle
}

function Read-BoundedRange {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
        [long]$StartUsn,
        [long]$EndUsn,
        [ulong]$JournalId,
        [B2FileIdentity]$TargetA,
        [B2FileIdentity]$TargetB,
        [int]$OutputSize = 65536,
        [int]$MaxPages = 64,
        [long]$MaxScannedBytes = 4194304,
        [int]$MaxUnrelatedRecords = 16384
    )

    $result = [ordered]@{
        startUsn = $StartUsn
        endUsn = $EndUsn
        currentUsn = $StartUsn
        outputSize = $OutputSize
        pageCount = 0
        recordCount = 0
        unrelatedRecordCount = 0
        targetRecordCount = 0
        scannedBytes = 0
        v2RecordCount = 0
        v3RecordCount = 0
        malformedRecordCount = 0
        unsupportedRecordCount = 0
        bufferBoundsRespected = $true
        coverageState = 'KNOWN'
        gapReason = $null
        targetRecords = @()
    }

    if ($StartUsn -gt $EndUsn) {
        $result.coverageState = 'UNKNOWN'
        $result.gapReason = 'START_AFTER_END'
        return $result
    }

    $current = $StartUsn
    $allTargets = [System.Collections.Generic.List[B2UsnRecord]]::new()
    while ($current -lt $EndUsn) {
        if ($result.pageCount -ge $MaxPages) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = 'PAGE_LIMIT'
            break
        }
        if ($result.scannedBytes -ge $MaxScannedBytes) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = 'BYTE_LIMIT'
            break
        }

        $page = [B2ActiveUsnNative]::ReadJournal(
            $Handle,
            $current,
            $JournalId,
            $OutputSize,
            2,
            3,
            $TargetA,
            $TargetB
        )
        $result.pageCount++
        if (-not $page.Io.Success) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = "READ_FAILED:$($page.Io.ErrorName):$($page.Io.ErrorCode)"
            break
        }
        $result.scannedBytes += $page.Io.BytesReturned
        $result.recordCount += $page.RecordCount
        $result.targetRecordCount += $page.TargetRecordCount
        $result.unrelatedRecordCount += ($page.RecordCount - $page.TargetRecordCount)
        $result.v2RecordCount += $page.V2RecordCount
        $result.v3RecordCount += $page.V3RecordCount
        $result.malformedRecordCount += $page.MalformedRecordCount
        $result.unsupportedRecordCount += $page.UnsupportedRecordCount
        $result.bufferBoundsRespected = $result.bufferBoundsRespected -and $page.BufferBoundsRespected

        foreach ($record in $page.TargetRecords) {
            $allTargets.Add($record)
        }

        if (-not $page.BufferBoundsRespected -or $page.MalformedRecordCount -gt 0) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = 'MALFORMED_OR_BOUNDS'
            break
        }
        if ($page.UnsupportedRecordCount -gt 0) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = 'UNSUPPORTED_RECORD_VERSION'
            break
        }
        if ($result.unrelatedRecordCount -gt $MaxUnrelatedRecords) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = 'EXCESSIVE_UNRELATED_ACTIVITY'
            break
        }
        if ($page.NextUsn -le $current) {
            $result.coverageState = 'UNKNOWN'
            $result.gapReason = 'NO_USN_PROGRESS'
            break
        }
        $current = $page.NextUsn
    }

    if ($current -lt $EndUsn -and $result.coverageState -eq 'KNOWN') {
        $result.coverageState = 'UNKNOWN'
        $result.gapReason = 'INCOMPLETE_RANGE'
    }
    $result.currentUsn = $current
    [uint32]$reasonMask = Get-ReasonMask $allTargets
    $result.targetRecords = @(
        $allTargets | ForEach-Object {
            [ordered]@{
                majorVersion = $_.MajorVersion
                minorVersion = $_.MinorVersion
                recordLength = $_.RecordLength
                usn = $_.Usn
                reason = ('0x{0:X8}' -f $_.Reason)
                reasonNames = @(Format-ReasonMask $_.Reason)
                fileReference = $_.FileReferenceHex
                targetIdentity = if ($_.TargetMatch -eq 0) { 'A' } else { 'B' }
            }
        }
    )
    $result.reasonMask = ('0x{0:X8}' -f $reasonMask)
    $result.reasonNames = @(Format-ReasonMask $reasonMask)
    return $result
}

function Capture-Interval {
    param(
        [string]$Label,
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$JournalHandle,
        [long]$StartUsn,
        [ulong]$JournalId,
        [B2FileIdentity]$TargetA,
        [B2FileIdentity]$TargetB = $null
    )
    $after = Query-JournalOrThrow -Handle $JournalHandle -Label "$Label/after"
    Assert-True ($after.JournalId -eq $JournalId) "journal ID remains stable for $Label"
    if ($StartUsn -lt $after.FirstUsn) {
        $range = [ordered]@{
            startUsn = $StartUsn
            endUsn = $after.NextUsn
            currentUsn = $StartUsn
            outputSize = 65536
            pageCount = 0
            recordCount = 0
            unrelatedRecordCount = 0
            targetRecordCount = 0
            scannedBytes = 0
            v2RecordCount = 0
            v3RecordCount = 0
            malformedRecordCount = 0
            unsupportedRecordCount = 0
            bufferBoundsRespected = $true
            coverageState = 'UNKNOWN'
            gapReason = 'CHECKPOINT_BEFORE_FIRST_USN'
            targetRecords = @()
            reasonMask = '0x00000000'
            reasonNames = @()
        }
    }
    else {
        $range = Read-BoundedRange `
            -Handle $JournalHandle `
            -StartUsn $StartUsn `
            -EndUsn $after.NextUsn `
            -JournalId $JournalId `
            -TargetA $TargetA `
            -TargetB $TargetB
    }

    $postRead = Query-JournalOrThrow -Handle $JournalHandle -Label "$Label/post-read"
    if ($postRead.JournalId -ne $JournalId) {
        $range.coverageState = 'UNKNOWN'
        $range.gapReason = 'JOURNAL_ID_CHANGED_DURING_READ'
    }
    $state.intervals[$Label] = $range
    return $range
}

function Write-Append {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Writer,
        [string]$Path,
        [byte[]]$Expected,
        [int]$Seed,
        [int]$Length,
        [string]$Label
    )
    $suffix = New-PatternBytes -Seed $Seed -Length $Length
    [B2ActiveUsnNative]::Seek($Writer, 0, [B2ActiveUsnNative]::FILE_END)
    $next = Join-ByteArrays -Left $Expected -Right $suffix
    Write-AllBytes -Handle $Writer -Bytes $suffix -Path $Path -Expected $next -Label $Label
    return ,$next
}

function Write-OverwriteAppend {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Writer,
        [string]$Path,
        [byte[]]$Expected,
        [int]$Offset,
        [int]$OverwriteSeed,
        [int]$OverwriteLength,
        [int]$AppendSeed,
        [int]$AppendLength,
        [string]$Label
    )
    $replacement = New-PatternBytes -Seed $OverwriteSeed -Length $OverwriteLength
    $next = [byte[]]$Expected.Clone()
    Set-ByteRange -Target $next -Offset $Offset -Replacement $replacement
    [B2ActiveUsnNative]::Seek($Writer, $Offset, [B2ActiveUsnNative]::FILE_BEGIN)
    [B2ActiveUsnNative]::WriteBytes($Writer, $replacement)

    $suffix = New-PatternBytes -Seed $AppendSeed -Length $AppendLength
    $final = Join-ByteArrays -Left $next -Right $suffix
    [B2ActiveUsnNative]::Seek($Writer, 0, [B2ActiveUsnNative]::FILE_END)
    [B2ActiveUsnNative]::WriteBytes($Writer, $suffix)
    [B2ActiveUsnNative]::Flush($Writer)
    Assert-Content -Path $Path -Expected $final -Label $Label
    return ,$final
}

function Truncate-Content {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Writer,
        [string]$Path,
        [byte[]]$Expected,
        [int]$Length,
        [string]$Label
    )
    Assert-True ($Length -ge 0 -and $Length -le $Expected.Length) 'truncate length is within the expected file'
    $next = [byte[]]::new($Length)
    [Array]::Copy($Expected, 0, $next, 0, $Length)
    [B2ActiveUsnNative]::Seek($Writer, $Length, [B2ActiveUsnNative]::FILE_BEGIN)
    [B2ActiveUsnNative]::TruncateAtEnd($Writer)
    [B2ActiveUsnNative]::Flush($Writer)
    Assert-Content -Path $Path -Expected $next -Label $Label
    return ,$next
}

function Invoke-WriterSeal {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
        [string]$Label
    )
    $io = [B2ActiveUsnNative]::SealRecord($Handle)
    $state.seals[$Label] = Convert-SealEvidence $io
    return $io
}

function Get-TargetRecordCount {
    param($Range)
    if ($null -eq $Range.targetRecords) {
        return 0
    }
    return @($Range.targetRecords).Count
}

$state = [ordered]@{
    card = 'W2'
    runLabel = $RunLabel
    generatedUtc = [DateTime]::UtcNow.ToString('o')
    executionContext = $ProbeContext
    identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    pwsh = $PSVersionTable.PSVersion.ToString()
    os = [System.Environment]::OSVersion.VersionString
    outcome = 'RUNNING'
    failedStage = $null
    error = $null
    temp = [ordered]@{
        root = $null
        fixtureDirectory = $null
        fixturePath = $null
        renamedPath = $null
        resolvedBeforeCleanup = $null
        cleanupVerified = $false
        cleanupAttempted = $false
        cleanupSucceeded = $false
        cleanupError = $null
    }
    api = [ordered]@{
        query = $null
        bufferProbe = @()
    }
    identities = [ordered]@{}
    contents = [ordered]@{}
    contentChecks = [ordered]@{}
    seals = [ordered]@{}
    intervals = [ordered]@{}
    phases = [ordered]@{}
    summary = [ordered]@{}
    assertions = [ordered]@{
        count = 0
        result = 'not-run'
    }
}

$script:openHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$safeLabel = ($RunLabel -replace '[^A-Za-z0-9._-]', '-')
$runId = "w2-$timestamp-$safeLabel-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../output/architecture-20261103/b2'))
$runRoot = Join-Path $outputRoot "usn-active-$runId"
$resultPath = Join-Path $runRoot 'result.json'
$state.runId = $runId
$state.paths = [ordered]@{
    outputRoot = $outputRoot
    runRoot = $runRoot
    result = $resultPath
}

$writer = $null
$writer2 = $null
$writer3 = $null
$reader = $null
$rootHandle = $null

function Close-ProbeHandles {
    for ($i = $script:openHandles.Count - 1; $i -ge 0; $i--) {
        $handle = $script:openHandles[$i]
        if ($null -ne $handle) {
            try {
                if (-not $handle.IsClosed) {
                    $handle.Dispose()
                }
            }
            catch {
            }
        }
    }
}

try {
    New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
    Assert-True ($state.identity -eq 'DESKTOP-D61AMRC\Silver') 'probe runs as the expected ordinary user'
    Assert-True (-not $state.administrator) 'probe runs without an administrator token'

    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $tempRootWithSeparator = $tempRoot.TrimEnd('\') + '\'
    Assert-True ($tempRootWithSeparator.StartsWith('C:\', [StringComparison]::OrdinalIgnoreCase)) 'current user temp root is on C:'
    $fixtureToken = "active-usn-w2-$([guid]::NewGuid().ToString('N'))"
    $fixtureDirectory = [System.IO.Path]::GetFullPath((Join-Path $tempRoot $fixtureToken))
    Assert-True $fixtureDirectory.StartsWith($tempRootWithSeparator, [StringComparison]::OrdinalIgnoreCase) 'fixture directory is under the current user temp root'
    Assert-True (-not [System.IO.Directory]::Exists($fixtureDirectory)) 'fixture directory is unique'
    [void][System.IO.Directory]::CreateDirectory($fixtureDirectory)
    $fixturePath = Join-Path $fixtureDirectory 'fixture.jsonl'
    $renamedPath = Join-Path $fixtureDirectory 'fixture-renamed.jsonl'
    $state.temp.root = $tempRoot
    $state.temp.fixtureDirectory = $fixtureDirectory
    $state.temp.fixturePath = $fixturePath
    $state.temp.renamedPath = $renamedPath

    $rootHandle = Open-HandleOrThrow `
        -Path 'C:\' `
        -DesiredAccess 0 `
        -CreationDisposition ([B2ActiveUsnNative]::OPEN_EXISTING) `
        -FlagsAndAttributes ([B2ActiveUsnNative]::FILE_FLAG_BACKUP_SEMANTICS) `
        -Label 'C root directory'
    $initialQuery = Query-JournalOrThrow -Handle $rootHandle -Label 'initial C root'
    $state.api.query = Convert-JournalEvidence $initialQuery
    Assert-True ($initialQuery.MinSupportedMajorVersion -le 2 -and $initialQuery.MaxSupportedMajorVersion -ge 3) 'journal supports V2/V3 records'
    Assert-True ($initialQuery.JournalId -ne 0) 'journal ID is nonzero'

    foreach ($size in @(8, 64, 4096, 65536)) {
        $page = [B2ActiveUsnNative]::ReadJournal(
            $rootHandle,
            $initialQuery.NextUsn,
            $initialQuery.JournalId,
            $size,
            2,
            3,
            $null,
            $null
        )
        Assert-True ($page.Io.BytesReturned -le $size) "buffer size $size is respected"
        Assert-True ($page.BufferBoundsRespected) "buffer parsing respects bounds at size $size"
        $state.api.bufferProbe += [ordered]@{
            requestedBytes = $size
            success = $page.Io.Success
            win32 = $page.Io.ErrorCode
            error = $page.Io.ErrorName
            bytesReturned = $page.Io.BytesReturned
            records = $page.RecordCount
            targetRecords = $page.TargetRecordCount
            malformedRecords = $page.MalformedRecordCount
            unsupportedRecords = $page.UnsupportedRecordCount
        }
    }

    $naturalStartQuery = Query-JournalOrThrow -Handle $rootHandle -Label 'before synthetic file create'
    $journalId = [ulong]$naturalStartQuery.JournalId
    $writer = Open-HandleOrThrow `
        -Path $fixturePath `
        -DesiredAccess ([B2ActiveUsnNative]::GENERIC_READ -bor [B2ActiveUsnNative]::GENERIC_WRITE) `
        -CreationDisposition ([B2ActiveUsnNative]::CREATE_ALWAYS) `
        -FlagsAndAttributes ([B2ActiveUsnNative]::FILE_ATTRIBUTE_NORMAL) `
        -Label 'private synthetic fixture create/writer'
    $identityA = [B2ActiveUsnNative]::GetIdentity($writer)
    Assert-True ($identityA.FileIndex64 -ne 0) 'fixture has a nonzero 64-bit FRN'
    Assert-True ($identityA.FileId128Hex.Length -eq 32) 'fixture has a 128-bit file ID'
    $state.identities.original = Convert-IdentityEvidence $identityA

    $syntheticV3Name = [System.Text.Encoding]::Unicode.GetBytes('fixture.jsonl')
    $syntheticV3RecordLength = 76 + $syntheticV3Name.Length
    $syntheticV3Payload = [byte[]]::new(8 + $syntheticV3RecordLength)
    $syntheticV3FileId = [Convert]::FromHexString($identityA.FileId128Hex)
    $syntheticFields = @(
        @{ Offset = 0; Bytes = [BitConverter]::GetBytes([int64]9001) },
        @{ Offset = 8; Bytes = [BitConverter]::GetBytes([int]$syntheticV3RecordLength) },
        @{ Offset = 12; Bytes = [BitConverter]::GetBytes([uint16]3) },
        @{ Offset = 14; Bytes = [BitConverter]::GetBytes([uint16]0) },
        @{ Offset = 16; Bytes = $syntheticV3FileId },
        @{ Offset = 48; Bytes = [BitConverter]::GetBytes([int64]9001) },
        @{ Offset = 64; Bytes = [BitConverter]::GetBytes([uint32]0x00000002) },
        @{ Offset = 80; Bytes = [BitConverter]::GetBytes([uint16]$syntheticV3Name.Length) },
        @{ Offset = 82; Bytes = [BitConverter]::GetBytes([uint16]76) },
        @{ Offset = 84; Bytes = $syntheticV3Name }
    )
    foreach ($field in $syntheticFields) {
        [System.Buffer]::BlockCopy($field.Bytes, 0, $syntheticV3Payload, $field.Offset, $field.Bytes.Length)
    }
    $syntheticV3Page = [B2ActiveUsnNative]::ParseSyntheticPayload(
        $syntheticV3Payload,
        $syntheticV3Payload.Length,
        $identityA,
        $null
    )
    Assert-True $syntheticV3Page.BufferBoundsRespected 'synthetic V3 parser self-check respects buffer bounds'
    Assert-True ($syntheticV3Page.RecordCount -eq 1) 'synthetic V3 parser self-check returns one record'
    Assert-True ($syntheticV3Page.V3RecordCount -eq 1) 'synthetic V3 parser self-check recognizes V3'
    Assert-True ($syntheticV3Page.TargetRecordCount -eq 1) 'synthetic V3 parser self-check matches the 128-bit file ID'
    Assert-True ($syntheticV3Page.TargetRecords[0].RecordLength -eq $syntheticV3RecordLength) 'synthetic V3 parser self-check preserves the record length'
    Assert-True ($syntheticV3Page.TargetRecords[0].Reason -eq 0x00000002) 'synthetic V3 parser self-check preserves DATA_EXTEND'
    $syntheticMalformed = [B2ActiveUsnNative]::ParseSyntheticPayload(
        $syntheticV3Payload,
        84,
        $identityA,
        $null
    )
    Assert-True ($syntheticMalformed.MalformedRecordCount -eq 1) 'synthetic V3 parser self-check rejects a truncated record'
    Assert-True ($syntheticMalformed.RecordCount -eq 0) 'synthetic V3 parser self-check emits no truncated record'
    $state.api.syntheticV3Parser = [ordered]@{
        recordLength = $syntheticV3RecordLength
        nameLength = $syntheticV3Name.Length
        nextUsn = $syntheticV3Page.NextUsn
        records = $syntheticV3Page.RecordCount
        v3Records = $syntheticV3Page.V3RecordCount
        targetRecords = $syntheticV3Page.TargetRecordCount
        reason = ('0x{0:X8}' -f $syntheticV3Page.TargetRecords[0].Reason)
        truncatedMalformedRecords = $syntheticMalformed.MalformedRecordCount
    }

    $naturalInitialStart = Query-JournalOrThrow -Handle $rootHandle -Label 'natural initial write/before'
    $expected = New-PatternBytes -Seed 1001 -Length 4096
    Write-AllBytes -Handle $writer -Bytes $expected -Path $fixturePath -Expected $expected -Label 'natural-initial-open-write'
    [void](Capture-Interval -Label 'natural-initial-open-write' -JournalHandle $rootHandle -StartUsn $naturalInitialStart.NextUsn -JournalId $journalId -TargetA $identityA)
    $state.contents.initial = [ordered]@{ length = $expected.Length; sha256 = Get-Sha256Hex $expected }

    $v3Page = [B2ActiveUsnNative]::ReadJournal(
        $rootHandle,
        $naturalInitialStart.NextUsn,
        $journalId,
        65536,
        3,
        3,
        $identityA,
        $null
    )
    Assert-True $v3Page.Io.Success "forced V3 journal read succeeds: $($v3Page.Io.ErrorName) ($($v3Page.Io.ErrorCode))"
    Assert-True $v3Page.BufferBoundsRespected 'forced V3 read respects the returned-buffer bounds'
    Assert-True ($v3Page.TargetRecordCount -ge 1) 'forced V3 read matches the synthetic fixture by 128-bit file ID'
    Assert-True ($v3Page.MalformedRecordCount -eq 0) 'forced V3 read has no malformed records'
    Assert-True ($v3Page.UnsupportedRecordCount -eq 0) 'forced V3 read has no unsupported records'
    $state.api.v3Read = [ordered]@{
        requestedMinMajorVersion = 3
        requestedMaxMajorVersion = 3
        success = $v3Page.Io.Success
        win32 = $v3Page.Io.ErrorCode
        error = $v3Page.Io.ErrorName
        bytesReturned = $v3Page.Io.BytesReturned
        nextUsn = $v3Page.NextUsn
        records = $v3Page.RecordCount
        v2Records = $v3Page.V2RecordCount
        v3Records = $v3Page.V3RecordCount
        returnedMajorVersions = @(
            if ($v3Page.V2RecordCount -gt 0) { 2 }
            if ($v3Page.V3RecordCount -gt 0) { 3 }
        )
        targetRecords = $v3Page.TargetRecordCount
        malformedRecords = $v3Page.MalformedRecordCount
        unsupportedRecords = $v3Page.UnsupportedRecordCount
        firstTargetRecord = if ($v3Page.TargetRecordCount -gt 0) {
            $record = $v3Page.TargetRecords[0]
            [ordered]@{
                majorVersion = $record.MajorVersion
                minorVersion = $record.MinorVersion
                recordLength = $record.RecordLength
                usn = $record.Usn
                reason = ('0x{0:X8}' -f $record.Reason)
                reasonNames = @(Format-ReasonMask $record.Reason)
                fileId128 = $record.FileId128Hex
            }
        }
        else {
            $null
        }
    }

    $appendOneStart = Query-JournalOrThrow -Handle $rootHandle -Label 'natural append one/before'
    $expected = Write-Append -Writer $writer -Path $fixturePath -Expected $expected -Seed 1102 -Length 777 -Label 'natural-append-one'
    [void](Capture-Interval -Label 'natural-append-one' -JournalHandle $rootHandle -StartUsn $appendOneStart.NextUsn -JournalId $journalId -TargetA $identityA)

    $appendTwoStart = Query-JournalOrThrow -Handle $rootHandle -Label 'natural append two/before'
    $expected = Write-Append -Writer $writer -Path $fixturePath -Expected $expected -Seed 1203 -Length 555 -Label 'natural-append-two'
    [void](Capture-Interval -Label 'natural-append-two' -JournalHandle $rootHandle -StartUsn $appendTwoStart.NextUsn -JournalId $journalId -TargetA $identityA)

    $mixedOneStart = Query-JournalOrThrow -Handle $rootHandle -Label 'natural mixed one/before'
    $expected = Write-OverwriteAppend `
        -Writer $writer `
        -Path $fixturePath `
        -Expected $expected `
        -Offset 0 `
        -OverwriteSeed 1304 `
        -OverwriteLength 97 `
        -AppendSeed 1405 `
        -AppendLength 211 `
        -Label 'natural-overwrite-append-one'
    [void](Capture-Interval -Label 'natural-overwrite-append-one' -JournalHandle $rootHandle -StartUsn $mixedOneStart.NextUsn -JournalId $journalId -TargetA $identityA)

    $mixedTwoStart = Query-JournalOrThrow -Handle $rootHandle -Label 'natural mixed two/before'
    $expected = Write-OverwriteAppend `
        -Writer $writer `
        -Path $fixturePath `
        -Expected $expected `
        -Offset 17 `
        -OverwriteSeed 1506 `
        -OverwriteLength 83 `
        -AppendSeed 1607 `
        -AppendLength 199 `
        -Label 'natural-overwrite-append-two'
    [void](Capture-Interval -Label 'natural-overwrite-append-two' -JournalHandle $rootHandle -StartUsn $mixedTwoStart.NextUsn -JournalId $journalId -TargetA $identityA)

    $truncateStart = Query-JournalOrThrow -Handle $rootHandle -Label 'natural truncate/before'
    $expected = Truncate-Content -Writer $writer -Path $fixturePath -Expected $expected -Length 3000 -Label 'natural-truncate'
    [void](Capture-Interval -Label 'natural-truncate' -JournalHandle $rootHandle -StartUsn $truncateStart.NextUsn -JournalId $journalId -TargetA $identityA)

    $naturalSeal = Invoke-WriterSeal -Handle $writer -Label 'writer-seal-after-natural-batch'
    Assert-True $naturalSeal.Success "writer-handle seal succeeds after the natural batch: $($naturalSeal.ErrorName)"
    [void](Capture-Interval -Label 'natural-batch-summary-after-writer-seal' -JournalHandle $rootHandle -StartUsn $naturalInitialStart.NextUsn -JournalId $journalId -TargetA $identityA)

    $paginationProbe = Read-BoundedRange `
        -Handle $rootHandle `
        -StartUsn $naturalInitialStart.NextUsn `
        -EndUsn $state.intervals['natural-batch-summary-after-writer-seal'].endUsn `
        -JournalId $journalId `
        -TargetA $identityA `
        -OutputSize 72 `
        -MaxPages 64 `
        -MaxScannedBytes 1048576 `
        -MaxUnrelatedRecords 1024
    Assert-True ($paginationProbe.coverageState -eq 'KNOWN') "forced pagination covers the fixture interval: $($paginationProbe.gapReason)"
    Assert-True ($paginationProbe.pageCount -ge 2) '72-byte page requests force multiple bounded pages'
    Assert-True ($paginationProbe.bufferBoundsRespected) 'forced pagination respects returned-buffer bounds'
    Assert-True ($paginationProbe.malformedRecordCount -eq 0) 'forced pagination has no malformed records'
    Assert-True ($paginationProbe.unsupportedRecordCount -eq 0) 'forced pagination has no unsupported records'
    Assert-True ($paginationProbe.targetRecordCount -eq 4) 'forced pagination returns all four synthetic fixture records'
    $state.api.paginationProbe = [ordered]@{
        outputSize = $paginationProbe.outputSize
        pageCount = $paginationProbe.pageCount
        scannedBytes = $paginationProbe.scannedBytes
        records = $paginationProbe.recordCount
        targetRecords = $paginationProbe.targetRecordCount
        unrelatedRecords = $paginationProbe.unrelatedRecordCount
        malformedRecords = $paginationProbe.malformedRecordCount
        unsupportedRecords = $paginationProbe.unsupportedRecordCount
        bufferBoundsRespected = $paginationProbe.bufferBoundsRespected
        coverageState = $paginationProbe.coverageState
        gapReason = $paginationProbe.gapReason
    }

    $reader = Open-HandleOrThrow `
        -Path $fixturePath `
        -DesiredAccess ([B2ActiveUsnNative]::GENERIC_READ) `
        -CreationDisposition ([B2ActiveUsnNative]::OPEN_EXISTING) `
        -FlagsAndAttributes ([B2ActiveUsnNative]::FILE_ATTRIBUTE_NORMAL) `
        -Label 'synthetic fixture read-only handle'
    $readerIdentity = [B2ActiveUsnNative]::GetIdentity($reader)
    Assert-True ($readerIdentity.Signature -eq $identityA.Signature) 'read-only handle observes the same identity'

    $readSealBoundary = Query-JournalOrThrow -Handle $rootHandle -Label 'read-only seal/boundary'
    $expected = Write-Append -Writer $writer -Path $fixturePath -Expected $expected -Seed 1708 -Length 145 -Label 'before-read-only-seal-append'
    $beforeReadOnlySeal = Capture-Interval -Label 'before-read-only-seal-open-writer' -JournalHandle $rootHandle -StartUsn $readSealBoundary.NextUsn -JournalId $journalId -TargetA $identityA
    $readOnlySeal = Invoke-WriterSeal -Handle $reader -Label 'read-only-handle-seal-with-writer-open'
    [void](Capture-Interval -Label 'after-read-only-handle-seal' -JournalHandle $rootHandle -StartUsn $readSealBoundary.NextUsn -JournalId $journalId -TargetA $identityA)
    [void](Capture-Interval -Label 'read-only-handle-seal-delta' -JournalHandle $rootHandle -StartUsn $beforeReadOnlySeal.currentUsn -JournalId $journalId -TargetA $identityA)

    $writerSealAfterReadOnlyNoChange = Invoke-WriterSeal -Handle $writer -Label 'writer-seal-after-read-only-seal-with-no-new-mutation'
    Assert-True $writerSealAfterReadOnlyNoChange.Success "writer-handle seal succeeds after the read-only seal and no new mutation: $($writerSealAfterReadOnlyNoChange.ErrorName)"
    [void](Capture-Interval -Label 'writer-seal-after-read-only-seal-no-new-mutation' -JournalHandle $rootHandle -StartUsn $readSealBoundary.NextUsn -JournalId $journalId -TargetA $identityA)
    [void](Capture-Interval -Label 'writer-seal-after-read-only-seal-no-new-mutation-delta' -JournalHandle $rootHandle -StartUsn $state.intervals['after-read-only-handle-seal'].currentUsn -JournalId $journalId -TargetA $identityA)

    $expected = Write-OverwriteAppend `
        -Writer $writer `
        -Path $fixturePath `
        -Expected $expected `
        -Offset 31 `
        -OverwriteSeed 1809 `
        -OverwriteLength 41 `
        -AppendSeed 1910 `
        -AppendLength 67 `
        -Label 'after-read-only-seal-overwrite-append'
    $writerSealAfterReadOnly = Invoke-WriterSeal -Handle $writer -Label 'writer-seal-after-read-only-seal-mutation'
    Assert-True $writerSealAfterReadOnly.Success "writer-handle seal succeeds after the read-only seal trial: $($writerSealAfterReadOnly.ErrorName)"
    [void](Capture-Interval -Label 'writer-seal-after-read-only-seal-mutation' -JournalHandle $rootHandle -StartUsn $readSealBoundary.NextUsn -JournalId $journalId -TargetA $identityA)

    $writerSealMixedLabels = @()
    for ($i = 1; $i -le 2; $i++) {
        $boundary = Query-JournalOrThrow -Handle $rootHandle -Label "writer-seal mixed $i/boundary"
        $label = "writer-seal-overwrite-append-$i"
        $expected = Write-OverwriteAppend `
            -Writer $writer `
            -Path $fixturePath `
            -Expected $expected `
            -Offset (40 + ($i * 23)) `
            -OverwriteSeed (2000 + $i) `
            -OverwriteLength (29 + $i) `
            -AppendSeed (2100 + $i) `
            -AppendLength (47 + $i) `
            -Label $label
        $beforeWriterSeal = Capture-Interval -Label "$label-before-writer-seal" -JournalHandle $rootHandle -StartUsn $boundary.NextUsn -JournalId $journalId -TargetA $identityA
        $seal = Invoke-WriterSeal -Handle $writer -Label "$label-seal"
        Assert-True $seal.Success "writer seal succeeds for $label"
        [void](Capture-Interval -Label $label -JournalHandle $rootHandle -StartUsn $boundary.NextUsn -JournalId $journalId -TargetA $identityA)
        [void](Capture-Interval -Label "$label-seal-delta" -JournalHandle $rootHandle -StartUsn $beforeWriterSeal.currentUsn -JournalId $journalId -TargetA $identityA)
        $writerSealMixedLabels += $label
    }

    $writerSealAppendLabels = @()
    for ($i = 1; $i -le 2; $i++) {
        $boundary = Query-JournalOrThrow -Handle $rootHandle -Label "writer-seal append $i/boundary"
        $label = "writer-seal-append-only-$i"
        $expected = Write-Append -Writer $writer -Path $fixturePath -Expected $expected -Seed (2200 + $i) -Length (73 + $i) -Label $label
        $beforeWriterSeal = Capture-Interval -Label "$label-before-writer-seal" -JournalHandle $rootHandle -StartUsn $boundary.NextUsn -JournalId $journalId -TargetA $identityA
        $seal = Invoke-WriterSeal -Handle $writer -Label "$label-seal"
        Assert-True $seal.Success "writer seal succeeds for $label"
        [void](Capture-Interval -Label $label -JournalHandle $rootHandle -StartUsn $boundary.NextUsn -JournalId $journalId -TargetA $identityA)
        [void](Capture-Interval -Label "$label-seal-delta" -JournalHandle $rootHandle -StartUsn $beforeWriterSeal.currentUsn -JournalId $journalId -TargetA $identityA)
        $writerSealAppendLabels += $label
    }

    $closeBoundary = Query-JournalOrThrow -Handle $rootHandle -Label 'writer close/boundary'
    $writer.Dispose()
    $reader.Dispose()
    [void](Capture-Interval -Label 'writer-close-record' -JournalHandle $rootHandle -StartUsn $closeBoundary.NextUsn -JournalId $journalId -TargetA $identityA)

    $writer2 = Open-HandleOrThrow `
        -Path $fixturePath `
        -DesiredAccess ([B2ActiveUsnNative]::GENERIC_READ -bor [B2ActiveUsnNative]::GENERIC_WRITE) `
        -CreationDisposition ([B2ActiveUsnNative]::OPEN_EXISTING) `
        -FlagsAndAttributes ([B2ActiveUsnNative]::FILE_ATTRIBUTE_NORMAL) `
        -Label 'closed/reopened writer'
    $identityReopen = [B2ActiveUsnNative]::GetIdentity($writer2)
    Assert-True ($identityReopen.Signature -eq $identityA.Signature) 'close/reopen preserves full file identity'
    $state.identities.reopened = Convert-IdentityEvidence $identityReopen
    $reopenBoundary = Query-JournalOrThrow -Handle $rootHandle -Label 'reopen append/boundary'
    $expected = Write-Append -Writer $writer2 -Path $fixturePath -Expected $expected -Seed 2301 -Length 93 -Label 'reopened-same-identity-append'
    $reopenSeal = Invoke-WriterSeal -Handle $writer2 -Label 'reopened-writer-seal'
    Assert-True $reopenSeal.Success 'reopened writer seal succeeds'
    [void](Capture-Interval -Label 'reopened-same-identity-append' -JournalHandle $rootHandle -StartUsn $reopenBoundary.NextUsn -JournalId $journalId -TargetA $identityA)

    $renameBoundary = Query-JournalOrThrow -Handle $rootHandle -Label 'rename/boundary'
    [B2ActiveUsnNative]::Move($fixturePath, $renamedPath)
    $identityAfterRename = [B2ActiveUsnNative]::GetIdentity($writer2)
    Assert-True ($identityAfterRename.Signature -eq $identityA.Signature) 'rename preserves full file identity'
    $state.identities.renamed = Convert-IdentityEvidence $identityAfterRename
    $expected = Write-Append -Writer $writer2 -Path $renamedPath -Expected $expected -Seed 2402 -Length 89 -Label 'renamed-same-identity-append'
    $renameSeal = Invoke-WriterSeal -Handle $writer2 -Label 'renamed-writer-seal'
    Assert-True $renameSeal.Success 'renamed writer seal succeeds'
    [void](Capture-Interval -Label 'rename-and-append-same-identity' -JournalHandle $rootHandle -StartUsn $renameBoundary.NextUsn -JournalId $journalId -TargetA $identityA)
    $writer2.Dispose()

    $replacementBoundary = Query-JournalOrThrow -Handle $rootHandle -Label 'replacement/boundary'
    $writer3 = Open-HandleOrThrow `
        -Path $fixturePath `
        -DesiredAccess ([B2ActiveUsnNative]::GENERIC_READ -bor [B2ActiveUsnNative]::GENERIC_WRITE) `
        -CreationDisposition ([B2ActiveUsnNative]::CREATE_ALWAYS) `
        -FlagsAndAttributes ([B2ActiveUsnNative]::FILE_ATTRIBUTE_NORMAL) `
        -Label 'replacement fixture create/writer'
    $identityB = [B2ActiveUsnNative]::GetIdentity($writer3)
    Assert-True ($identityB.Signature -ne $identityA.Signature) 'same-path replacement receives a different full file identity'
    $state.identities.replacement = Convert-IdentityEvidence $identityB
    $replacementExpected = New-PatternBytes -Seed 2503 -Length 1024
    Write-AllBytes -Handle $writer3 -Bytes $replacementExpected -Path $fixturePath -Expected $replacementExpected -Label 'same-path-replacement-content'
    $replacementSeal = Invoke-WriterSeal -Handle $writer3 -Label 'replacement-writer-seal'
    Assert-True $replacementSeal.Success 'replacement writer seal succeeds'
    $writer3.Dispose()
    [void](Capture-Interval -Label 'same-path-replacement-identity-split' -JournalHandle $rootHandle -StartUsn $replacementBoundary.NextUsn -JournalId $journalId -TargetA $identityA -TargetB $identityB)

    $renamedIdentity = [B2ActiveUsnNative]::GetIdentity(
        (Open-HandleOrThrow `
            -Path $renamedPath `
            -DesiredAccess ([B2ActiveUsnNative]::GENERIC_READ) `
            -CreationDisposition ([B2ActiveUsnNative]::OPEN_EXISTING) `
            -FlagsAndAttributes ([B2ActiveUsnNative]::FILE_ATTRIBUTE_NORMAL) `
            -Label 'renamed identity verification')
    )
    Assert-True ($renamedIdentity.Signature -eq $identityA.Signature) 'renamed path still resolves to original identity'
    Assert-Content -Path $renamedPath -Expected $expected -Label 'renamed-original-final-content'
    Assert-Content -Path $fixturePath -Expected $replacementExpected -Label 'replacement-new-content'

    $state.phases.natural = [ordered]@{
        writerHandleStayedOpen = $true
        openWriterTargetRecordCounts = @(
            'natural-initial-open-write',
            'natural-append-one',
            'natural-append-two',
            'natural-overwrite-append-one',
            'natural-overwrite-append-two',
            'natural-truncate'
        ) | ForEach-Object {
            [ordered]@{
                label = $_
                targetRecordCount = Get-TargetRecordCount $state.intervals[$_]
                coverageState = $state.intervals[$_].coverageState
            }
        }
        postSealTargetRecordCount = Get-TargetRecordCount $state.intervals['natural-batch-summary-after-writer-seal']
        postSealReasonMask = $state.intervals['natural-batch-summary-after-writer-seal'].reasonMask
        postSealReasonNames = @($state.intervals['natural-batch-summary-after-writer-seal'].reasonNames)
    }
    $state.phases.readOnlySealTrial = [ordered]@{
        seal = Convert-SealEvidence $readOnlySeal
        beforeSealRecords = Get-TargetRecordCount $beforeReadOnlySeal
        beforeSealReasonMask = $beforeReadOnlySeal.reasonMask
        beforeSealReasonNames = @($beforeReadOnlySeal.reasonNames)
        recordsAfterReadSeal = Get-TargetRecordCount $state.intervals['after-read-only-handle-seal']
        reasonAfterReadSeal = $state.intervals['after-read-only-handle-seal'].reasonMask
        readSealDeltaRecords = Get-TargetRecordCount $state.intervals['read-only-handle-seal-delta']
        readSealDeltaReasonMask = $state.intervals['read-only-handle-seal-delta'].reasonMask
        readSealDeltaReasonNames = @($state.intervals['read-only-handle-seal-delta'].reasonNames)
        recordsAfterWriterSealWithNoNewMutation = Get-TargetRecordCount $state.intervals['writer-seal-after-read-only-seal-no-new-mutation']
        reasonAfterWriterSealWithNoNewMutation = $state.intervals['writer-seal-after-read-only-seal-no-new-mutation'].reasonMask
        noNewMutationDeltaRecords = Get-TargetRecordCount $state.intervals['writer-seal-after-read-only-seal-no-new-mutation-delta']
        noNewMutationDeltaReasonMask = $state.intervals['writer-seal-after-read-only-seal-no-new-mutation-delta'].reasonMask
        noNewMutationDeltaReasonNames = @($state.intervals['writer-seal-after-read-only-seal-no-new-mutation-delta'].reasonNames)
        combinedWriterTargetRecords = Get-TargetRecordCount $state.intervals['writer-seal-after-read-only-seal-mutation']
        combinedWriterReasonMask = $state.intervals['writer-seal-after-read-only-seal-mutation'].reasonMask
        combinedWriterReasonNames = @($state.intervals['writer-seal-after-read-only-seal-mutation'].reasonNames)
    }
    $state.phases.writerSealMixed = @(
        $writerSealMixedLabels | ForEach-Object {
            [ordered]@{
                label = $_
                coverageState = $state.intervals[$_].coverageState
                targetRecordCount = Get-TargetRecordCount $state.intervals[$_]
                reasonMask = $state.intervals[$_].reasonMask
                reasonNames = @($state.intervals[$_].reasonNames)
                beforeSealTargetRecordCount = Get-TargetRecordCount $state.intervals["$_--before-writer-seal".Replace('--', '-')]
                beforeSealReasonMask = $state.intervals["$_--before-writer-seal".Replace('--', '-')].reasonMask
                sealDeltaTargetRecordCount = Get-TargetRecordCount $state.intervals["$_--seal-delta".Replace('--', '-')]
                sealDeltaReasonMask = $state.intervals["$_--seal-delta".Replace('--', '-')].reasonMask
            }
        }
    )
    $state.phases.writerSealAppendOnly = @(
        $writerSealAppendLabels | ForEach-Object {
            [ordered]@{
                label = $_
                coverageState = $state.intervals[$_].coverageState
                targetRecordCount = Get-TargetRecordCount $state.intervals[$_]
                reasonMask = $state.intervals[$_].reasonMask
                reasonNames = @($state.intervals[$_].reasonNames)
                beforeSealTargetRecordCount = Get-TargetRecordCount $state.intervals["$_--before-writer-seal".Replace('--', '-')]
                beforeSealReasonMask = $state.intervals["$_--before-writer-seal".Replace('--', '-')].reasonMask
                sealDeltaTargetRecordCount = Get-TargetRecordCount $state.intervals["$_--seal-delta".Replace('--', '-')]
                sealDeltaReasonMask = $state.intervals["$_--seal-delta".Replace('--', '-')].reasonMask
            }
        }
    )
    $state.phases.identity = [ordered]@{
        closeReopenSame = ($identityReopen.Signature -eq $identityA.Signature)
        renameSame = ($identityAfterRename.Signature -eq $identityA.Signature)
        replacementDifferent = ($identityB.Signature -ne $identityA.Signature)
        replacementIntervalTargetA = @($state.intervals['same-path-replacement-identity-split'].targetRecords | Where-Object targetIdentity -eq 'A').Count
        replacementIntervalTargetB = @($state.intervals['same-path-replacement-identity-split'].targetRecords | Where-Object targetIdentity -eq 'B').Count
    }

    $naturalNoOpenTarget = $true
    foreach ($label in @('natural-initial-open-write', 'natural-append-one', 'natural-append-two', 'natural-overwrite-append-one', 'natural-overwrite-append-two', 'natural-truncate')) {
        if ($state.intervals[$label].coverageState -ne 'KNOWN') {
            $naturalNoOpenTarget = $false
        }
        if ((Get-TargetRecordCount $state.intervals[$label]) -ne 0) {
            $naturalNoOpenTarget = $false
        }
    }

    $readSealRange = $state.intervals['after-read-only-handle-seal']
    $readSealDeltaRange = $state.intervals['read-only-handle-seal-delta']
    $readSealNoChangeDeltaRange = $state.intervals['writer-seal-after-read-only-seal-no-new-mutation-delta']
    $readSealRecords = Get-TargetRecordCount $readSealRange
    $combinedReadSealRange = $state.intervals['writer-seal-after-read-only-seal-mutation']
    $writerChangeVisibleBeforeReadSeal =
        $beforeReadOnlySeal.coverageState -eq 'KNOWN' -and
        (Get-TargetRecordCount $beforeReadOnlySeal) -gt 0 -and
        (([uint32]$beforeReadOnlySeal.reasonMask -band 0x00000007) -ne 0)
    $readOnlySealSucceeded =
        $readOnlySeal.Success -and
        $readSealDeltaRange.coverageState -eq 'KNOWN' -and
        (Get-TargetRecordCount $readSealDeltaRange) -gt 0
    $writerStillHadPendingChangeAfterReadSeal =
        $writerSealAfterReadOnlyNoChange.Success -and
        $readSealNoChangeDeltaRange.coverageState -eq 'KNOWN' -and
        (([uint32]$readSealNoChangeDeltaRange.reasonMask -band 0x00000007) -ne 0)
    $readOnlySealCreatedBoundedState =
        $readOnlySealSucceeded -and
        -not $writerStillHadPendingChangeAfterReadSeal

    $writerSealIntervalFailures = @(
        @($writerSealMixedLabels + $writerSealAppendLabels) | Where-Object {
            $range = $state.intervals[$_]
            $range.coverageState -ne 'KNOWN' -or (Get-TargetRecordCount $range) -eq 0
        }
    )
    $writerSealAppendFailures = @(
        $writerSealAppendLabels | Where-Object {
            [uint32]$mask = $state.intervals[$_].reasonMask
            (($mask -band 0x00000002) -eq 0) -or
            (($mask -band 0x00000005) -ne 0)
        }
    )
    $writerSealMixedFailures = @(
        $writerSealMixedLabels | Where-Object {
            [uint32]$mask = $state.intervals[$_].reasonMask
            (($mask -band 0x00000001) -eq 0) -or
            (($mask -band 0x00000002) -eq 0)
        }
    )
    $state.summary = [ordered]@{
        naturalOpenWriterHadNoVisibleTargetRecords = $naturalNoOpenTarget
        naturalBatchAfterWriterSealWasCoalesced = ((Get-TargetRecordCount $state.intervals['natural-batch-summary-after-writer-seal']) -eq 1)
        readOnlySealSuccess = $readOnlySeal.Success
        readOnlySealError = $readOnlySeal.ErrorName
        readOnlySealErrorCode = $readOnlySeal.ErrorCode
        writerChangeVisibleBeforeReadSeal = $writerChangeVisibleBeforeReadSeal
        readOnlySealRecordsObserved = $readSealRecords
        readOnlySealDeltaRecords = Get-TargetRecordCount $readSealDeltaRange
        readOnlySealDeltaReasonMask = $readSealDeltaRange.reasonMask
        writerStillHadPendingChangeAfterReadSeal = $writerStillHadPendingChangeAfterReadSeal
        readOnlySealCreatedBoundedState = $readOnlySealCreatedBoundedState
        combinedAfterReadSealIncludesWriterMutation = (
            ($combinedReadSealRange.reasonMask -band 0x00000001) -ne 0 -and
            ($combinedReadSealRange.reasonMask -band 0x00000002) -ne 0
        )
        writerSealProducedBoundedIntervals = ($writerSealIntervalFailures.Count -eq 0)
        writerSealAppendOnlyReasonsSafe = ($writerSealAppendFailures.Count -eq 0)
        writerSealMixedReasonsShowOverwrite = ($writerSealMixedFailures.Count -eq 0)
        writerSealIntervalFailures = @($writerSealIntervalFailures)
        writerSealAppendFailures = @($writerSealAppendFailures)
        writerSealMixedFailures = @($writerSealMixedFailures)
        remainingProofObligations = @(
            'The collector does not own the writer handle.',
            'A read-only seal must not be assumed to close another open writer record.',
            'Natural coalescing still needs a source contract or a cooperating writer seal.',
            'Journal retention, unrelated activity, version support, and permission behavior vary by volume and deployment.',
            'The tested local volume behavior does not establish a universal Windows guarantee.'
        )
    }

    if (-not $state.summary.writerSealProducedBoundedIntervals) {
        $state.summary.classification = 'UNKNOWN_OR_INCOMPLETE_WRITER_SEAL_INTERVALS'
    }
    elseif ($state.summary.readOnlySealCreatedBoundedState -and $state.summary.writerChangeVisibleBeforeReadSeal) {
        $state.summary.classification = 'READ_ONLY_SEAL_CREATED_BOUNDARY_AFTER_ALREADY_VISIBLE_WRITER_CHANGE_IN_THIS_TEST'
    }
    elseif ($state.summary.readOnlySealCreatedBoundedState) {
        $state.summary.classification = 'READ_ONLY_SEAL_CREATED_BOUNDED_STATE_IN_THIS_TEST'
    }
    elseif ($state.summary.writerStillHadPendingChangeAfterReadSeal) {
        $state.summary.classification = 'WRITER_COOPERATION_REQUIRED_FOR_SEALED_INTERVALS'
    }
    else {
        $state.summary.classification = 'UNKNOWN_READ_ONLY_SEAL_EFFECT'
    }
    $state.outcome = 'COMPLETED'
}
catch {
    $state.outcome = 'FAILED'
    $state.error = $_.Exception.Message
    $state.failedStage = $_.InvocationInfo.PositionMessage
}
finally {
    Close-ProbeHandles
    if ($state.temp.fixtureDirectory -and [System.IO.Directory]::Exists($state.temp.fixtureDirectory)) {
        $state.temp.cleanupAttempted = $true
        try {
            $resolvedTempRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $state.temp.root).Path).TrimEnd('\') + '\'
            $resolvedCandidate = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $state.temp.fixtureDirectory).Path)
            $candidateItem = Get-Item -LiteralPath $resolvedCandidate -Force
            $prefixSafe = $resolvedCandidate.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)
            $notTempRoot = -not [string]::Equals($resolvedCandidate.TrimEnd('\'), $resolvedTempRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
            $leafSafe = $candidateItem.Name.StartsWith('active-usn-w2-', [StringComparison]::Ordinal)
            $notReparse = ($candidateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0
            $state.temp.resolvedBeforeCleanup = $resolvedCandidate
            Assert-True ($prefixSafe -and $notTempRoot -and $leafSafe -and $notReparse) 'fixture cleanup target is a unique non-reparse directory under the temp root'
            $state.temp.cleanupVerified = $true
            Remove-Item -LiteralPath $resolvedCandidate -Recurse -Force
            $state.temp.cleanupSucceeded = -not [System.IO.Directory]::Exists($resolvedCandidate)
            Assert-True $state.temp.cleanupSucceeded 'fixture directory cleanup completed'
        }
        catch {
            $state.temp.cleanupError = $_.Exception.Message
            if ($state.outcome -eq 'COMPLETED') {
                $state.outcome = 'FAILED'
                $state.error = "Cleanup failed: $($_.Exception.Message)"
                $state.assertions.result = 'failed-or-incomplete'
            }
        }
    }

    $state.assertions.count = $script:AssertionCount
    $state.assertions.result = if ($state.outcome -eq 'COMPLETED') { 'passed' } else { 'failed-or-incomplete' }
    New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
    $state | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $resultPath -Encoding utf8
    Write-Output $runRoot
}

if ($state.outcome -ne 'COMPLETED') {
    exit 1
}
