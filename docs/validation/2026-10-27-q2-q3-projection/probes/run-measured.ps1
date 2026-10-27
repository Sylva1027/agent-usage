#requires -Version 7.0
param(
    [string]$FilePath,

    [string]$ArgumentsJson = "[]",

    [ValidateSet(64, 128, 1024, 7168)]
    [int]$LimitMiB = 1024,

    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 900,

    [string]$WorkingDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($FilePath)) { throw "An executable path is required" }
$decodedArguments = ConvertFrom-Json -InputObject $ArgumentsJson -NoEnumerate
if ($decodedArguments -isnot [Array] -or @($decodedArguments | Where-Object { $_ -isnot [string] }).Count -gt 0) {
    throw "ArgumentsJson must be an array of strings"
}
if ($args.Count -gt 0) { throw "Pass child arguments with -ArgumentsJson" }
$ArgumentList = [string[]]$decodedArguments
function Resolve-ExecutablePath {
    param([string]$Path)

    if ([IO.Path]::IsPathRooted($Path) -or
        $Path.Contains([IO.Path]::DirectorySeparatorChar) -or
        $Path.Contains([IO.Path]::AltDirectorySeparatorChar)) {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    }
    else {
        $command = Get-Command -Name $Path -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        $resolved = $command.Source
    }

    if ([IO.Path]::GetExtension($resolved) -in @(".cmd", ".bat", ".ps1")) {
        throw "Shell wrappers are not supported; pass an executable path: $resolved"
    }

    return [IO.Path]::GetFullPath($resolved)
}

if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = Split-Path -Parent $PSScriptRoot
}

$executable = Resolve-ExecutablePath -Path $FilePath
$workingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory -ErrorAction Stop).Path
if (-not [IO.Directory]::Exists($workingDirectory)) {
    throw "Working directory does not exist: $workingDirectory"
}

if (-not ("Q23Measurement.JobMemoryLimit" -as [type])) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Q23Measurement
{
    public static class JobMemoryLimit
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_FAILED = 0xFFFFFFFF;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
        private const int JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_INFORMATION = 7;
        private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
        private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
        private const uint ERROR_WAIT_TIMEOUT = 258;
        private const uint MEMORY_LIMIT_EXIT_CODE = 137;
        private const uint TIMEOUT_EXIT_CODE = 124;
        private const int TERMINATION_TIMEOUT_MS = 5000;

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            public int cb;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpReserved;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpDesktop;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
        {
            public UIntPtr CompletionKey;
            public IntPtr CompletionPort;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob,
            int jobObjectInformationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInformation,
            uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob,
            int jobObjectInformationClass,
            ref JOBOBJECT_ASSOCIATE_COMPLETION_PORT lpJobObjectInformation,
            uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr hJob,
            int jobObjectInformationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION lpJobObjectInformation,
            uint cbJobObjectInformationLength,
            IntPtr lpReturnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr hJob, int kind, out JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
            uint length, IntPtr returned);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateIoCompletionPort(
            IntPtr fileHandle,
            IntPtr existingCompletionPort,
            UIntPtr completionKey,
            uint numberOfConcurrentThreads);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetQueuedCompletionStatus(
            IntPtr completionPort,
            out uint lpNumberOfBytes,
            out UIntPtr lpCompletionKey,
            out IntPtr lpOverlapped,
            uint dwMilliseconds);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(
            IntPtr hSourceProcessHandle,
            IntPtr hSourceHandle,
            IntPtr hTargetProcessHandle,
            out IntPtr lpTargetHandle,
            uint dwDesiredAccess,
            bool bInheritHandle,
            uint dwOptions);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        public static int Run(
            string executable,
            string[] arguments,
            string workingDirectory,
            ulong limitBytes,
            int timeoutMs)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr completionPort = IntPtr.Zero;
            IntPtr process = IntPtr.Zero;
            IntPtr thread = IntPtr.Zero;
            IntPtr stdin = IntPtr.Zero;
            IntPtr stdout = IntPtr.Zero;
            IntPtr stderr = IntPtr.Zero;
            bool running = false;

            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    throw LastError("CreateJobObject");
                }

                var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                limits.JobMemoryLimit = new UIntPtr(limitBytes);
                if (!SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    ref limits,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                {
                    throw LastError("SetInformationJobObject(limit)");
                }

                completionPort = CreateIoCompletionPort(
                    new IntPtr(-1),
                    IntPtr.Zero,
                    UIntPtr.Zero,
                    1);
                if (completionPort == IntPtr.Zero)
                {
                    throw LastError("CreateIoCompletionPort");
                }

                var association = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT
                {
                    CompletionKey = UIntPtr.Zero,
                    CompletionPort = completionPort
                };
                if (!SetInformationJobObject(
                    job,
                    JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_INFORMATION,
                    ref association,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT))))
                {
                    throw LastError("SetInformationJobObject(completion port)");
                }

                stdin = DuplicateStandardHandle(STD_INPUT_HANDLE, GENERIC_READ);
                stdout = DuplicateStandardHandle(STD_OUTPUT_HANDLE, GENERIC_WRITE);
                stderr = DuplicateStandardHandle(STD_ERROR_HANDLE, GENERIC_WRITE);

                var startup = new STARTUPINFO
                {
                    cb = Marshal.SizeOf(typeof(STARTUPINFO)),
                    dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = stdin,
                    hStdOutput = stdout,
                    hStdError = stderr
                };

                string commandLine = Quote(executable);
                if (arguments != null)
                {
                    foreach (string argument in arguments)
                    {
                        commandLine += " " + Quote(argument);
                    }
                }

                var mutableCommandLine = new StringBuilder(commandLine, commandLine.Length + 2);
                PROCESS_INFORMATION processInformation;
                if (!CreateProcess(
                    executable,
                    mutableCommandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out processInformation))
                {
                    throw LastError("CreateProcess");
                }

                process = processInformation.hProcess;
                thread = processInformation.hThread;
                CloseHandle(stdin);
                stdin = IntPtr.Zero;
                CloseHandle(stdout);
                stdout = IntPtr.Zero;
                CloseHandle(stderr);
                stderr = IntPtr.Zero;

                if (!AssignProcessToJobObject(job, process))
                {
                    throw LastError("AssignProcessToJobObject");
                }
                if (ResumeThread(thread) == uint.MaxValue)
                {
                    throw LastError("ResumeThread");
                }

                running = true;
                return MonitorJob(job, completionPort, process, timeoutMs);
            }
            finally
            {
                if (stdin != IntPtr.Zero)
                {
                    CloseHandle(stdin);
                }
                if (stdout != IntPtr.Zero)
                {
                    CloseHandle(stdout);
                }
                if (stderr != IntPtr.Zero)
                {
                    CloseHandle(stderr);
                }
                if (process != IntPtr.Zero && !running)
                {
                    TerminateProcess(process, 1);
                    WaitForSingleObject(process, 1000);
                }
                if (thread != IntPtr.Zero)
                {
                    CloseHandle(thread);
                }
                if (process != IntPtr.Zero)
                {
                    CloseHandle(process);
                }
                if (completionPort != IntPtr.Zero)
                {
                    CloseHandle(completionPort);
                }
                if (job != IntPtr.Zero)
                {
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION peak;
                    if (QueryInformationJobObject(job, 9, out peak, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), IntPtr.Zero))
                        Console.Error.WriteLine("Q23_JOB_PEAK bytes=" + peak.PeakJobMemoryUsed.ToUInt64() + " processBytes=" + peak.PeakProcessMemoryUsed.ToUInt64());
                    CloseHandle(job);
                }
            }
        }

        private static int MonitorJob(
            IntPtr job,
            IntPtr completionPort,
            IntPtr process,
            int timeoutMs)
        {
            bool memoryLimitHit = false;
            bool timedOut = false;
            bool terminationRequested = false;
            bool fallbackTermination = false;
            DateTime terminationDeadline = DateTime.MinValue;
            DateTime overallDeadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

            while (true)
            {
                DrainCompletionPort(completionPort, ref memoryLimitHit);

                if (memoryLimitHit && !terminationRequested)
                {
                    Console.Error.WriteLine("run-with-memory-limit: job memory limit exceeded; terminating job");
                    fallbackTermination = !TerminateJobObject(job, MEMORY_LIMIT_EXIT_CODE);
                    terminationRequested = true;
                    terminationDeadline = DateTime.UtcNow.AddMilliseconds(TERMINATION_TIMEOUT_MS);
                }
                else if (!terminationRequested && DateTime.UtcNow >= overallDeadline)
                {
                    timedOut = true;
                    Console.Error.WriteLine("run-with-memory-limit: overall timeout exceeded; terminating job");
                    fallbackTermination = !TerminateJobObject(job, TIMEOUT_EXIT_CODE);
                    terminationRequested = true;
                    terminationDeadline = DateTime.UtcNow.AddMilliseconds(TERMINATION_TIMEOUT_MS);
                }

                uint waitResult = WaitForSingleObject(process, 0);
                if (waitResult == WAIT_FAILED)
                {
                    throw LastError("WaitForSingleObject");
                }

                if (waitResult == WAIT_OBJECT_0)
                {
                    uint exitCode;
                    if (!GetExitCodeProcess(process, out exitCode))
                    {
                        throw LastError("GetExitCodeProcess");
                    }
                    if (terminationRequested && !fallbackTermination)
                    {
                        WaitForJobTermination(job, terminationDeadline);
                    }
                    return memoryLimitHit
                        ? (int)MEMORY_LIMIT_EXIT_CODE
                        : timedOut
                            ? (int)TIMEOUT_EXIT_CODE
                            : unchecked((int)exitCode);
                }

                if (terminationRequested && DateTime.UtcNow >= terminationDeadline)
                {
                    TerminateProcess(process, memoryLimitHit ? MEMORY_LIMIT_EXIT_CODE : TIMEOUT_EXIT_CODE);
                    if (WaitForSingleObject(process, 1000) == WAIT_FAILED)
                    {
                        throw LastError("WaitForSingleObject(terminated process)");
                    }
                    return memoryLimitHit ? (int)MEMORY_LIMIT_EXIT_CODE : (int)TIMEOUT_EXIT_CODE;
                }

                Thread.Sleep(50);
            }
        }

        private static void WaitForJobTermination(IntPtr job, DateTime deadline)
        {
            while (true)
            {
                if (ActiveProcessCount(job) == 0 || DateTime.UtcNow >= deadline)
                {
                    return;
                }
                Thread.Sleep(50);
            }
        }

        private static uint ActiveProcessCount(IntPtr job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(
                job,
                JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                out accounting,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                IntPtr.Zero))
            {
                throw LastError("QueryInformationJobObject");
            }
            return accounting.ActiveProcesses;
        }

        private static void DrainCompletionPort(IntPtr completionPort, ref bool memoryLimitHit)
        {
            while (true)
            {
                uint bytes;
                UIntPtr completionKey;
                IntPtr overlapped;
                if (!GetQueuedCompletionStatus(
                    completionPort,
                    out bytes,
                    out completionKey,
                    out overlapped,
                    0))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ERROR_WAIT_TIMEOUT)
                    {
                        return;
                    }
                    throw new Win32Exception(error, "GetQueuedCompletionStatus failed");
                }

                if (bytes == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT)
                {
                    memoryLimitHit = true;
                }
            }
        }

        private static IntPtr DuplicateStandardHandle(int standardHandle, uint fallbackAccess)
        {
            IntPtr source = GetStdHandle(standardHandle);
            bool closeSource = false;
            if (source == IntPtr.Zero || source == new IntPtr(-1))
            {
                source = CreateFile(
                    "NUL",
                    fallbackAccess,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    IntPtr.Zero,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    IntPtr.Zero);
                closeSource = true;
            }

            if (source == IntPtr.Zero || source == new IntPtr(-1))
            {
                throw LastError("CreateFile(NUL)");
            }

            try
            {
                IntPtr duplicate;
                if (!DuplicateHandle(
                    GetCurrentProcess(),
                    source,
                    GetCurrentProcess(),
                    out duplicate,
                    0,
                    true,
                    DUPLICATE_SAME_ACCESS))
                {
                    throw LastError("DuplicateHandle");
                }
                return duplicate;
            }
            finally
            {
                if (closeSource)
                {
                    CloseHandle(source);
                }
            }
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                value = string.Empty;
            }

            if (value.Length > 0 &&
                value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return value;
            }

            var result = new StringBuilder();
            result.Append('"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                if (backslashes > 0)
                {
                    result.Append('\\', backslashes);
                    backslashes = 0;
                }
                result.Append(character);
            }
            if (backslashes > 0)
            {
                result.Append('\\', backslashes * 2);
            }
            result.Append('"');
            return result.ToString();
        }

        private static Win32Exception LastError(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
        }
    }
}
'@
}

$limitBytes = [UInt64]$LimitMiB * 1MB
$timeoutMs = $TimeoutSeconds * 1000
try {
    $exitCode = [Q23Measurement.JobMemoryLimit]::Run(
        $executable,
        [string[]]$ArgumentList,
        $workingDirectory,
        $limitBytes,
        $timeoutMs)
    exit $exitCode
}
catch {
    [Console]::Error.WriteLine("run-with-memory-limit: $($_.Exception.GetBaseException().Message)")
    exit 125
}

