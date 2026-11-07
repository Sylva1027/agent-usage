use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fs;
use std::mem::{self, size_of};
use std::path::{Component, Path, Prefix};
use std::ptr;
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_STANDARD_INFO, FILE_TYPE_DISK, FileIdInfo, FileStandardInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, GetFileType, GetVolumeInformationByHandleW, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, FSCTL_WRITE_USN_CLOSE_RECORD,
    READ_USN_JOURNAL_DATA_V1, USN_JOURNAL_DATA_V2,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub const KIND: &str = "ntfs-usn-v1";
pub const MAX_TOKEN_BYTES: usize = 512;
pub const DIRECTORY_KIND: &str = "ntfs-usn-directory-v1";
pub const ARCHIVE_LOCK_KIND: &str = "windows-archive-read-lock-v2";
const MAX_ARCHIVE_HANDLES: usize = 64;

const GENERIC_READ: u32 = 0x8000_0000;
const IO_PAGE_BYTES: usize = 65_536;
const MAX_PAGES: usize = 64;
const MAX_JOURNAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 16_384;
const MAX_UNRELATED_RECORDS: usize = 8_192;
const MAX_SCAN_TIME: Duration = Duration::from_secs(2);

#[cfg(test)]
const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
const USN_REASON_DATA_EXTEND: u32 = 0x0000_0002;
#[cfg(test)]
const USN_REASON_DATA_TRUNCATION: u32 = 0x0000_0004;
#[cfg(test)]
const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
#[cfg(test)]
const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
const USN_REASON_BASIC_INFO_CHANGE: u32 = 0x0000_8000;
const USN_REASON_CLOSE: u32 = 0x8000_0000;
const ALLOWED_REASON_MASK: u32 =
    USN_REASON_DATA_EXTEND | USN_REASON_BASIC_INFO_CHANGE | USN_REASON_CLOSE;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpectedInfo {
    pub size: u64,
    pub mtime_ns: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Identity {
    volume_hex: String,
    file_id_128_hex: String,
    file_index_64_hex: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Snapshot {
    size: u64,
    mtime_ns: u64,
    identity: Identity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Token {
    journal_id: u64,
    seal_usn: i64,
    identity: Identity,
    offset: u64,
    size: u64,
    mtime_ns: u64,
}

#[derive(Debug)]
pub struct ProofResult {
    pub offset: u64,
    pub token: String,
    pub journal_bytes: u64,
}

#[derive(Clone, Debug)]
struct JournalData {
    journal_id: u64,
    first_usn: i64,
    next_usn: i64,
    lowest_valid_usn: i64,
    max_usn: i64,
    min_version: u16,
    max_version: u16,
    flags: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UsnRecord {
    V2 {
        usn: i64,
        file_index_64: u64,
        reason: u32,
    },
    V3 {
        usn: i64,
        file_id_128: [u8; 16],
        reason: u32,
    },
}

impl UsnRecord {
    fn usn(self) -> i64 {
        match self {
            Self::V2 { usn, .. } | Self::V3 { usn, .. } => usn,
        }
    }

    fn reason(self) -> u32 {
        match self {
            Self::V2 { reason, .. } | Self::V3 { reason, .. } => reason,
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

impl OwnedHandle {
    fn open(path: &str, desired_access: u32, flags_and_attributes: u32) -> Result<Self, String> {
        Self::open_shared(
            path,
            desired_access,
            flags_and_attributes,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
    }

    fn open_shared(
        path: &str,
        desired_access: u32,
        flags_and_attributes: u32,
        sharing: u32,
    ) -> Result<Self, String> {
        let wide = wide_null(path)?;
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                desired_access,
                sharing,
                ptr::null(),
                OPEN_EXISTING,
                flags_and_attributes,
                ptr::null_mut(),
            )
        };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(win_error("CreateFileW"))
        } else {
            Ok(Self(handle))
        }
    }
}

fn win_error(operation: &str) -> String {
    let code = unsafe { GetLastError() };
    format!("{operation} failed with Win32 error {code}")
}

fn wide_null(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("path contains NUL".to_owned());
    }
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    if wide.len() >= 32_768 {
        return Err("path is too long".to_owned());
    }
    wide.push(0);
    Ok(wide)
}

fn expected_matches(snapshot: &Snapshot, expected: &ExpectedInfo) -> bool {
    snapshot.size == expected.size && snapshot.mtime_ns == expected.mtime_ns
}

fn snapshot(handle: &OwnedHandle) -> Result<Snapshot, String> {
    let mut standard: FILE_STANDARD_INFO = unsafe { mem::zeroed() };
    let standard_ok = unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileStandardInfo,
            &mut standard as *mut _ as *mut c_void,
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if standard_ok == 0 {
        return Err(win_error("GetFileInformationByHandleEx(FileStandardInfo)"));
    }
    if standard.Directory || standard.EndOfFile < 0 {
        return Err("source is not a regular file".to_owned());
    }

    let mut id_info: FILE_ID_INFO = unsafe { mem::zeroed() };
    let id_ok = unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileIdInfo,
            &mut id_info as *mut _ as *mut c_void,
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if id_ok == 0 {
        return Err(win_error("GetFileInformationByHandleEx(FileIdInfo)"));
    }

    let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut basic) } == 0 {
        return Err(win_error("GetFileInformationByHandle"));
    }
    let write_time = filetime_value(basic.ftLastWriteTime);
    const WINDOWS_TO_UNIX_EPOCH_100NS: u64 = 116_444_736_000_000_000;
    if write_time < WINDOWS_TO_UNIX_EPOCH_100NS {
        return Err("unsupported source timestamp".to_owned());
    }
    let mtime_ns = (write_time - WINDOWS_TO_UNIX_EPOCH_100NS)
        .checked_mul(100)
        .ok_or_else(|| "source timestamp overflow".to_owned())?;
    let file_index_64 = ((basic.nFileIndexHigh as u64) << 32) | basic.nFileIndexLow as u64;

    Ok(Snapshot {
        size: standard.EndOfFile as u64,
        mtime_ns,
        identity: Identity {
            volume_hex: format!("{:016x}", id_info.VolumeSerialNumber),
            file_id_128_hex: hex_bytes(&id_info.FileId.Identifier),
            file_index_64_hex: format!("{file_index_64:016x}"),
        },
    })
}

fn validate_archive_path(path: &str) -> Result<(), String> {
    let bytes = path.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || path.encode_utf16().count() >= 32_768
    {
        return Err("invalid archive path".to_owned());
    }
    for part in path[3..].split(['\\', '/']) {
        let stem = part.split('.').next().unwrap_or("").to_uppercase();
        let device = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || device
            || part
                .chars()
                .any(|c| c.is_control() || ":<>\"|?*".contains(c))
        {
            return Err("invalid archive path component".to_owned());
        }
    }
    Ok(())
}

struct ArchiveReadLock {
    path: String,
    file: OwnedHandle,
    snapshot: Snapshot,
    parents: Vec<Rc<ArchiveDirectory>>,
}

struct ArchiveDirectory {
    file: OwnedHandle,
    identity: Identity,
    final_path: String,
}

fn object_identity(info: &serde_json::Value) -> Identity {
    Identity {
        volume_hex: info["volume"].as_str().unwrap_or("").to_owned(),
        file_id_128_hex: info["id128"].as_str().unwrap_or("").to_owned(),
        file_index_64_hex: info["id64"].as_str().unwrap_or("").to_owned(),
    }
}

fn archive_directory_info(file: &OwnedHandle) -> Result<serde_json::Value, String> {
    let info = directory_info(file)?;
    if info["attributes"].as_u64().unwrap_or(0) as u32
        & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
        != FILE_ATTRIBUTE_DIRECTORY
    {
        return Err("archive ancestor is not a non-reparse directory".to_owned());
    }
    Ok(info)
}

fn assert_archive_child(
    file: &OwnedHandle,
    parent: &ArchiveDirectory,
    name: &str,
) -> Result<(), String> {
    let info = directory_info(file)?;
    let expected = format!("{}\\{}", parent.final_path.trim_end_matches('\\'), name);
    if !info["path"]
        .as_str()
        .unwrap_or("")
        .eq_ignore_ascii_case(&expected)
        || object_identity(&archive_directory_info(&parent.file)?) != parent.identity
    {
        return Err("archive ancestor changed during acquisition".to_owned());
    }
    Ok(())
}

fn open_archive_file(path: &str) -> Result<OwnedHandle, String> {
    validate_archive_path(path)?;
    let file = OwnedHandle::open_shared(
        path,
        GENERIC_READ,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ,
    )?;
    let info = directory_info(&file)?;
    if unsafe { GetFileType(file.0) } != FILE_TYPE_DISK
        || info["attributes"].as_u64().unwrap_or(0) as u32
            & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            != 0
    {
        return Err("archive is not a regular non-reparse file".to_owned());
    }
    Ok(file)
}

pub struct ArchiveLocks {
    files: BTreeMap<String, ArchiveReadLock>,
    parents: BTreeMap<String, Weak<ArchiveDirectory>>,
    instance: String,
    next: u64,
}

impl ArchiveLocks {
    pub fn new() -> Self {
        Self {
            files: BTreeMap::new(),
            parents: BTreeMap::new(),
            instance: format!(
                "{}-{:x}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            next: 0,
        }
    }

    fn parent(
        &mut self,
        path: &str,
        parent: Option<&ArchiveDirectory>,
        name: &str,
    ) -> Result<Rc<ArchiveDirectory>, String> {
        let key = path.to_owned();
        if let Some(held) = self.parents.get(&key).and_then(Weak::upgrade) {
            if object_identity(&archive_directory_info(&held.file)?) != held.identity {
                return Err("archive ancestor identity changed".to_owned());
            }
            return Ok(held);
        }
        // Reserve one slot for the archive file as well as all retained ancestors.
        if self.files.len() + self.parents.len() + 1 >= MAX_ARCHIVE_HANDLES {
            return Err("archive lock limit".to_owned());
        }
        let file = OwnedHandle::open_shared(
            path,
            FILE_LIST_DIRECTORY,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )?;
        let info = archive_directory_info(&file)?;
        let final_path = info["path"]
            .as_str()
            .ok_or("archive ancestor path unavailable")?
            .to_owned();
        if let Some(parent) = parent {
            assert_archive_child(&file, parent, name)?;
        } else {
            if !final_path.eq_ignore_ascii_case(&format!("\\\\?\\{path}")) {
                return Err("archive drive root is redirected".to_owned());
            }
            let mut filesystem = [0u16; 32];
            if unsafe {
                GetVolumeInformationByHandleW(
                    file.0,
                    ptr::null_mut(),
                    0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    filesystem.as_mut_ptr(),
                    filesystem.len() as u32,
                )
            } == 0
                || filesystem[..5] != [78, 84, 70, 83, 0]
            {
                return Err("archive path requires local NTFS".to_owned());
            }
        }
        let held = Rc::new(ArchiveDirectory {
            identity: object_identity(&info),
            final_path,
            file,
        });
        self.parents.insert(key, Rc::downgrade(&held));
        Ok(held)
    }

    pub fn lock(&mut self, path: &str) -> Result<String, String> {
        self.parents.retain(|_, held| held.strong_count() > 0);
        let result = (|| {
            validate_archive_path(path)?;
            if self.files.len() + self.parents.len() >= MAX_ARCHIVE_HANDLES {
                return Err("archive lock limit".to_owned());
            }
            self.next = self
                .next
                .checked_add(1)
                .ok_or("archive lock token exhausted")?;
            let mut prefix = format!("{}:\\", path.as_bytes()[0] as char);
            let mut parents = vec![self.parent(&prefix, None, "")?];
            let parts: Vec<_> = path[3..].split(['\\', '/']).collect();
            for part in &parts[..parts.len() - 1] {
                if !prefix.ends_with('\\') {
                    prefix.push('\\');
                }
                prefix.push_str(part);
                let held = self.parent(&prefix, parents.last().map(Rc::as_ref), part)?;
                parents.push(held);
            }
            let file = open_archive_file(path)?;
            assert_archive_child(&file, parents.last().unwrap(), parts.last().unwrap())?;
            // Every non-reparse ancestor now contains a pinned child: NTFS refuses
            // FSCTL_SET_REPARSE_POINT on a nonempty directory, including attribute-only handles.
            let locked = ArchiveReadLock {
                path: path.to_owned(),
                snapshot: snapshot(&file)?,
                file,
                parents,
            };
            let token = format!("{}-{:x}", self.instance, self.next);
            self.files.insert(token.clone(), locked);
            Ok(token)
        })();
        self.parents.retain(|_, held| held.strong_count() > 0);
        result
    }

    pub fn check(&mut self, path: &str, token: &str) -> Result<(), String> {
        let locked = self.files.get(token).ok_or("archive lock is not alive")?;
        if locked.path != path {
            return Err("archive lock path mismatch".to_owned());
        }
        let valid = (|| {
            for parent in &locked.parents {
                if object_identity(&archive_directory_info(&parent.file)?) != parent.identity {
                    return Ok(false);
                }
            }
            let current = open_archive_file(path)?;
            Ok::<bool, String>(
                snapshot(&locked.file)? == locked.snapshot
                    && snapshot(&current)? == locked.snapshot,
            )
        })()
        .unwrap_or(false);
        if !valid {
            self.files.remove(token);
            self.parents.retain(|_, held| held.strong_count() > 0);
            return Err("archive lock identity changed".to_owned());
        }
        Ok(())
    }

    pub fn unlock(&mut self, path: &str, token: &str) -> Result<(), String> {
        if self
            .files
            .get(token)
            .is_some_and(|locked| locked.path != path)
        {
            return Err("archive lock path mismatch".to_owned());
        }
        self.files.remove(token);
        self.parents.retain(|_, held| held.strong_count() > 0);
        Ok(())
    }
}

fn filetime_value(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

fn volume_root(path: &Path) -> Result<String, String> {
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                Ok(format!("{}:\\", (letter as char).to_ascii_uppercase()))
            }
            _ => Err("only local drive-letter source paths are supported".to_owned()),
        },
        _ => Err("source path is not absolute".to_owned()),
    }
}

fn open_volume_for(path: &Path) -> Result<(OwnedHandle, String), String> {
    let canonical = fs::canonicalize(path).map_err(|_| "source path is unavailable".to_owned())?;
    let root = volume_root(&canonical)?;
    let handle = OwnedHandle::open(&root, 0, FILE_FLAG_BACKUP_SEMANTICS)?;
    Ok((handle, root))
}

fn device_io(
    handle: &OwnedHandle,
    code: u32,
    input: *const c_void,
    input_size: u32,
    output: *mut c_void,
    output_size: u32,
) -> Result<u32, String> {
    let mut returned = 0u32;
    let success = unsafe {
        DeviceIoControl(
            handle.0,
            code,
            input,
            input_size,
            output,
            output_size,
            &mut returned,
            ptr::null_mut(),
        )
    };
    if success == 0 {
        Err(win_error("DeviceIoControl"))
    } else {
        Ok(returned)
    }
}

fn query_journal(handle: &OwnedHandle) -> Result<(JournalData, u64), String> {
    let mut data: USN_JOURNAL_DATA_V2 = unsafe { mem::zeroed() };
    let returned = device_io(
        handle,
        FSCTL_QUERY_USN_JOURNAL,
        ptr::null(),
        0,
        &mut data as *mut _ as *mut c_void,
        size_of::<USN_JOURNAL_DATA_V2>() as u32,
    )?;
    if returned < size_of::<USN_JOURNAL_DATA_V2>() as u32 {
        return Err("journal query returned an incomplete V2 structure".to_owned());
    }
    let journal = JournalData {
        journal_id: data.UsnJournalID,
        first_usn: data.FirstUsn,
        next_usn: data.NextUsn,
        lowest_valid_usn: data.LowestValidUsn,
        max_usn: data.MaxUsn,
        min_version: data.MinSupportedMajorVersion,
        max_version: data.MaxSupportedMajorVersion,
        flags: data.Flags,
    };
    validate_journal(&journal)?;
    Ok((journal, returned as u64))
}

fn validate_journal(journal: &JournalData) -> Result<(), String> {
    if journal.journal_id == 0 {
        return Err("journal ID is zero".to_owned());
    }
    if journal.flags != 0 {
        return Err("journal flags are unsupported".to_owned());
    }
    if journal.min_version > 3 || journal.max_version < 2 {
        return Err("journal does not support V2/V3 records".to_owned());
    }
    if journal.first_usn < 0
        || journal.next_usn < journal.first_usn
        || journal.lowest_valid_usn < 0
        || journal.max_usn < journal.next_usn
    {
        return Err("journal USN bounds are invalid".to_owned());
    }
    Ok(())
}

fn seal_record(handle: &OwnedHandle) -> Result<(i64, u64), String> {
    let mut output = [0u8; 8];
    let returned = device_io(
        handle,
        FSCTL_WRITE_USN_CLOSE_RECORD,
        ptr::null(),
        0,
        output.as_mut_ptr() as *mut c_void,
        output.len() as u32,
    )?;
    if returned != output.len() as u32 {
        return Err("file seal returned an invalid USN buffer".to_owned());
    }
    let seal_usn = i64::from_le_bytes(output);
    if seal_usn <= 0 {
        return Err("file seal returned a nonpositive USN".to_owned());
    }
    Ok((seal_usn, returned as u64))
}

fn begin_with_indices(
    path: &str,
    offset: u64,
    expected: &ExpectedInfo,
) -> Result<ProofResult, String> {
    if offset != 0 {
        return Err("begin offset must be zero".to_owned());
    }
    let source_path = Path::new(path);
    let file = OwnedHandle::open(path, GENERIC_READ, FILE_ATTRIBUTE_NORMAL)?;
    let before = snapshot(&file)?;
    if !expected_matches(&before, expected) {
        return Err("expected source size or mtime does not match".to_owned());
    }
    let (root, _) = open_volume_for(source_path)?;
    let (start, mut journal_bytes) = query_journal(&root)?;
    if start.first_usn > start.next_usn {
        return Err("journal start bounds are invalid".to_owned());
    }
    let (seal_usn, seal_bytes) = seal_record(&file)?;
    journal_bytes += seal_bytes;
    let (end, query_bytes) = query_journal(&root)?;
    journal_bytes += query_bytes;
    if end.journal_id != start.journal_id
        || end.flags != start.flags
        || end.min_version != start.min_version
        || end.max_version != start.max_version
    {
        return Err("journal changed while establishing the baseline".to_owned());
    }
    if seal_usn < start.next_usn || seal_usn >= end.next_usn {
        return Err("baseline seal USN is outside the observed journal range".to_owned());
    }
    if seal_usn < end.first_usn || seal_usn < end.lowest_valid_usn {
        return Err("baseline seal fell below the end-of-query retention floor".to_owned());
    }
    let after = snapshot(&file)?;
    if before != after {
        return Err("source changed while establishing the baseline".to_owned());
    }
    let token = Token {
        journal_id: end.journal_id,
        seal_usn,
        identity: after.identity,
        offset,
        size: after.size,
        mtime_ns: after.mtime_ns,
    };
    Ok(ProofResult {
        offset,
        token: encode_token(&token),
        journal_bytes,
    })
}

pub fn begin(path: &str, offset: u64, expected: &ExpectedInfo) -> Result<ProofResult, String> {
    begin_with_indices(path, offset, expected)
}

pub fn prove_interval(
    path: &str,
    new_offset: u64,
    expected: &ExpectedInfo,
    token_text: &str,
) -> Result<ProofResult, String> {
    let token = decode_token(token_text)?;
    if new_offset < token.offset {
        return Err("cursor offset moved backwards".to_owned());
    }
    let source_path = Path::new(path);
    let file = OwnedHandle::open(path, GENERIC_READ, FILE_ATTRIBUTE_NORMAL)?;
    let before = snapshot(&file)?;
    if !expected_matches(&before, expected) {
        return Err("expected source size or mtime does not match".to_owned());
    }
    if before.identity != token.identity {
        return Err("source file identity changed".to_owned());
    }
    if new_offset > before.size {
        return Err("cursor offset is beyond the source size".to_owned());
    }
    let (root, _) = open_volume_for(source_path)?;
    let (start, query_bytes_start) = query_journal(&root)?;
    validate_start_journal(&start, &token)?;

    let (seal_usn, seal_bytes) = seal_record(&file)?;
    if seal_usn <= token.seal_usn {
        return Err("file seal did not advance".to_owned());
    }
    let (end, query_bytes_end) = query_journal(&root)?;
    validate_end_journal(&start, &end, &token, seal_usn)?;

    let after = snapshot(&file)?;
    if before != after {
        return Err("source changed during the proof interval".to_owned());
    }
    let mut journal_bytes = query_bytes_start + seal_bytes + query_bytes_end;
    let interval = scan_interval(
        &root,
        start.journal_id,
        token.seal_usn,
        seal_usn,
        &token.identity,
    )?;
    journal_bytes += interval.journal_bytes;
    if !interval.saw_old_baseline {
        return Err("old seal baseline was absent from the inclusive scan".to_owned());
    }
    if !interval.saw_new_seal {
        return Err("new seal record was absent from the inclusive scan".to_owned());
    }
    if interval.unrelated_records > MAX_UNRELATED_RECORDS {
        return Err("journal interval contained excessive unrelated activity".to_owned());
    }
    if interval.reason_mask & !ALLOWED_REASON_MASK != 0 {
        return Err("journal interval contains unsafe reasons".to_owned());
    }
    if before.size < token.size {
        return Err("source size decreased".to_owned());
    }
    if before.size > token.size && interval.reason_mask & USN_REASON_DATA_EXTEND == 0 {
        return Err("source extent grew without DATA_EXTEND evidence".to_owned());
    }
    let next = Token {
        journal_id: end.journal_id,
        seal_usn,
        identity: after.identity,
        offset: new_offset,
        size: after.size,
        mtime_ns: after.mtime_ns,
    };
    Ok(ProofResult {
        offset: new_offset,
        token: encode_token(&next),
        journal_bytes,
    })
}

fn validate_start_journal(journal: &JournalData, token: &Token) -> Result<(), String> {
    if journal.journal_id != token.journal_id {
        return Err("journal ID changed".to_owned());
    }
    if token.seal_usn < journal.first_usn || token.seal_usn >= journal.next_usn {
        return Err("journal retention gap or invalid baseline USN".to_owned());
    }
    if token.seal_usn < journal.lowest_valid_usn {
        return Err("baseline USN is below the valid journal floor".to_owned());
    }
    Ok(())
}

fn validate_end_journal(
    start: &JournalData,
    end: &JournalData,
    token: &Token,
    seal_usn: i64,
) -> Result<(), String> {
    if end.journal_id != start.journal_id || end.journal_id != token.journal_id {
        return Err("journal ID changed during the proof interval".to_owned());
    }
    if end.flags != start.flags
        || end.min_version != start.min_version
        || end.max_version != start.max_version
    {
        return Err("journal flags or versions changed during the proof interval".to_owned());
    }
    if end.first_usn > token.seal_usn || end.lowest_valid_usn > token.seal_usn {
        return Err("old seal baseline fell below the end-of-interval retention floor".to_owned());
    }
    if end.first_usn > seal_usn || end.lowest_valid_usn > seal_usn {
        return Err("new seal fell below the end-of-interval retention floor".to_owned());
    }
    if seal_usn < end.first_usn || seal_usn >= end.next_usn {
        return Err("new seal USN is outside the observed journal range".to_owned());
    }
    Ok(())
}

#[derive(Default)]
struct IntervalResult {
    reason_mask: u32,
    records: usize,
    target_records: usize,
    unrelated_records: usize,
    journal_bytes: u64,
    saw_old_baseline: bool,
    saw_new_seal: bool,
}

fn scan_interval(
    root: &OwnedHandle,
    journal_id: u64,
    start_usn: i64,
    new_seal_usn: i64,
    identity: &Identity,
) -> Result<IntervalResult, String> {
    if new_seal_usn <= start_usn {
        return Err("seal interval is empty".to_owned());
    }
    let started = Instant::now();
    let mut result = IntervalResult::default();
    let mut current = start_usn;
    let mut pages = 0usize;
    let mut previous_usn = i64::MIN;

    while current <= new_seal_usn {
        if started.elapsed() > MAX_SCAN_TIME {
            return Err("journal scan exceeded its time bound".to_owned());
        }
        if pages >= MAX_PAGES {
            return Err("journal scan exceeded its page bound".to_owned());
        }
        if result.journal_bytes as usize >= MAX_JOURNAL_BYTES {
            return Err("journal scan exceeded its byte bound".to_owned());
        }
        let page = read_page(root, current, journal_id)?;
        pages += 1;
        result.journal_bytes += page.bytes_returned as u64;
        if result.journal_bytes as usize > MAX_JOURNAL_BYTES {
            return Err("journal scan exceeded its byte bound".to_owned());
        }
        let mut offset = 8usize;
        while offset < page.bytes.len() {
            if page.bytes.len() - offset < 8 {
                return Err("journal page ended within a record header".to_owned());
            }
            let record = parse_record(&page.bytes, offset)?;
            let length = i32::from_le_bytes(
                page.bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| "record length conversion failed".to_owned())?,
            ) as usize;
            if record.usn() <= previous_usn {
                return Err("journal record USNs are not monotonic".to_owned());
            }
            previous_usn = record.usn();
            result.records += 1;
            if result.records > MAX_RECORDS {
                return Err("journal scan exceeded its record bound".to_owned());
            }
            if matches_identity(record, identity) {
                if record.usn() == start_usn {
                    if record.reason() & USN_REASON_CLOSE == 0 {
                        return Err("old seal baseline record has no CLOSE reason".to_owned());
                    }
                    result.saw_old_baseline = true;
                } else if record.usn() > start_usn && record.usn() <= new_seal_usn {
                    result.target_records += 1;
                    result.reason_mask |= record.reason();
                    if record.usn() == new_seal_usn {
                        if record.reason() & USN_REASON_CLOSE == 0 {
                            return Err("new seal record has no CLOSE reason".to_owned());
                        }
                        result.saw_new_seal = true;
                    }
                }
            } else if record.usn() >= start_usn && record.usn() <= new_seal_usn {
                result.unrelated_records += 1;
                if result.unrelated_records > MAX_UNRELATED_RECORDS {
                    return Err("journal scan exceeded its unrelated-record bound".to_owned());
                }
            }
            offset += length;
        }
        if offset != page.bytes.len() {
            return Err("journal page record lengths are inconsistent".to_owned());
        }
        if page.next_usn <= current {
            return Err("journal read made no monotonic progress".to_owned());
        }
        current = page.next_usn;
    }
    Ok(result)
}

struct Page {
    next_usn: i64,
    bytes_returned: u32,
    bytes: Vec<u8>,
}

fn read_page(root: &OwnedHandle, start_usn: i64, journal_id: u64) -> Result<Page, String> {
    let input = READ_USN_JOURNAL_DATA_V1 {
        StartUsn: start_usn,
        ReasonMask: u32::MAX,
        ReturnOnlyOnClose: 0,
        Timeout: 0,
        BytesToWaitFor: 0,
        UsnJournalID: journal_id,
        MinMajorVersion: 2,
        MaxMajorVersion: 3,
    };
    let mut output = vec![0u8; IO_PAGE_BYTES];
    let returned = device_io(
        root,
        FSCTL_READ_UNPRIVILEGED_USN_JOURNAL,
        &input as *const _ as *const c_void,
        size_of::<READ_USN_JOURNAL_DATA_V1>() as u32,
        output.as_mut_ptr() as *mut c_void,
        output.len() as u32,
    )?;
    if returned < 8 || returned as usize > output.len() {
        return Err("journal read returned an invalid buffer size".to_owned());
    }
    output.truncate(returned as usize);
    let next_usn = i64::from_le_bytes(
        output[..8]
            .try_into()
            .map_err(|_| "journal header conversion failed".to_owned())?,
    );
    Ok(Page {
        next_usn,
        bytes_returned: returned,
        bytes: output,
    })
}

fn parse_record(bytes: &[u8], offset: usize) -> Result<UsnRecord, String> {
    if bytes.len().saturating_sub(offset) < 8 {
        return Err("truncated USN record header".to_owned());
    }
    let length = i32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .map_err(|_| "record length conversion failed".to_owned())?,
    );
    let major = u16::from_le_bytes(
        bytes[offset + 4..offset + 6]
            .try_into()
            .map_err(|_| "record version conversion failed".to_owned())?,
    );
    let minor = u16::from_le_bytes(
        bytes[offset + 6..offset + 8]
            .try_into()
            .map_err(|_| "record version conversion failed".to_owned())?,
    );
    if minor != 0 {
        return Err("unsupported USN minor version".to_owned());
    }
    let minimum = match major {
        2 => 60usize,
        3 => 76usize,
        _ => return Err("unsupported USN record version".to_owned()),
    };
    if length < minimum as i32 {
        return Err("USN record length is too short".to_owned());
    }
    let length = length as usize;
    if offset
        .checked_add(length)
        .is_none_or(|end| end > bytes.len())
    {
        return Err("USN record extends beyond the page".to_owned());
    }
    let (name_length_offset, name_offset_offset) = if major == 2 { (56, 58) } else { (72, 74) };
    let name_length = u16::from_le_bytes(
        bytes[offset + name_length_offset..offset + name_length_offset + 2]
            .try_into()
            .map_err(|_| "USN name length conversion failed".to_owned())?,
    ) as usize;
    let name_offset = u16::from_le_bytes(
        bytes[offset + name_offset_offset..offset + name_offset_offset + 2]
            .try_into()
            .map_err(|_| "USN name offset conversion failed".to_owned())?,
    ) as usize;
    if name_offset < minimum
        || name_offset > length
        || !name_length.is_multiple_of(2)
        || name_length > length - name_offset
    {
        return Err("USN record name bounds are invalid".to_owned());
    }
    let usn = i64::from_le_bytes(
        bytes[offset + if major == 2 { 24 } else { 40 }..][..8]
            .try_into()
            .map_err(|_| "USN value conversion failed".to_owned())?,
    );
    let reason = u32::from_le_bytes(
        bytes[offset + if major == 2 { 40 } else { 56 }..][..4]
            .try_into()
            .map_err(|_| "USN reason conversion failed".to_owned())?,
    );
    let record = if major == 2 {
        UsnRecord::V2 {
            usn,
            file_index_64: u64::from_le_bytes(
                bytes[offset + 8..offset + 16]
                    .try_into()
                    .map_err(|_| "V2 file reference conversion failed".to_owned())?,
            ),
            reason,
        }
    } else {
        UsnRecord::V3 {
            usn,
            file_id_128: bytes[offset + 8..offset + 24]
                .try_into()
                .map_err(|_| "V3 file ID conversion failed".to_owned())?,
            reason,
        }
    };
    Ok(record)
}

fn matches_identity(record: UsnRecord, identity: &Identity) -> bool {
    match record {
        UsnRecord::V2 { file_index_64, .. } => {
            format!("{file_index_64:016x}") == identity.file_index_64_hex
        }
        UsnRecord::V3 { file_id_128, .. } => hex_bytes(&file_id_128) == identity.file_id_128_hex,
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn encode_token(token: &Token) -> String {
    format!(
        "{KIND}:{:016x}:{:016x}:{}:{}:{}:{:x}:{:x}:{:x}",
        token.journal_id,
        token.seal_usn as u64,
        token.identity.volume_hex,
        token.identity.file_id_128_hex,
        token.identity.file_index_64_hex,
        token.offset,
        token.size,
        token.mtime_ns
    )
}

fn directory_info(handle: &OwnedHandle) -> Result<serde_json::Value, String> {
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    let mut full: FILE_ID_INFO = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut basic) } == 0 {
        return Err(win_error("GetFileInformationByHandle"));
    }
    if unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileIdInfo,
            &mut full as *mut _ as *mut c_void,
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(win_error("GetFileInformationByHandleEx"));
    }
    let mut name = vec![0u16; 32768];
    let count =
        unsafe { GetFinalPathNameByHandleW(handle.0, name.as_mut_ptr(), name.len() as u32, 0) };
    if count == 0 || count as usize >= name.len() {
        return Err(win_error("GetFinalPathNameByHandleW"));
    }
    Ok(serde_json::json!({"format": 1,
        "path": String::from_utf16(&name[..count as usize]).map_err(|_| "invalid object path")?,
        "volume": format!("{:016x}", full.VolumeSerialNumber),
        "id64": format!("{:016x}", ((basic.nFileIndexHigh as u64) << 32) | basic.nFileIndexLow as u64),
        "id128": hex_bytes(&full.FileId.Identifier), "links": basic.nNumberOfLinks,
        "attributes": basic.dwFileAttributes,
        "size": (((basic.nFileSizeHigh as u64) << 32) | basic.nFileSizeLow as u64).to_string()}))
}

pub fn directory_object(path: &str) -> Result<serde_json::Value, String> {
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    let file = OwnedHandle::open(
        path,
        0,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    )?;
    directory_info(&file)
}

pub fn directory_resolve(path: &str, id: &str) -> Result<serde_json::Value, String> {
    use windows_sys::Win32::Storage::FileSystem::{
        ExtendedFileIdType, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_128, FILE_ID_DESCRIPTOR,
        FILE_ID_DESCRIPTOR_0, FileIdType, OpenFileById,
    };
    if !matches!(id.len(), 16 | 32) || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid object identity".to_owned());
    }
    let (volume, _) = open_volume_for(Path::new(path))?;
    let mut descriptor = FILE_ID_DESCRIPTOR::default();
    descriptor.dwSize = size_of::<FILE_ID_DESCRIPTOR>() as u32;
    if id.len() == 16 {
        descriptor.Type = FileIdType;
        descriptor.Anonymous = FILE_ID_DESCRIPTOR_0 {
            FileId: u64::from_str_radix(id, 16).map_err(|_| "invalid 64-bit object identity")?
                as i64,
        };
    } else {
        let mut bytes = [0u8; 16];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&id[index * 2..index * 2 + 2], 16)
                .map_err(|_| "invalid 128-bit object identity")?;
        }
        descriptor.Type = ExtendedFileIdType;
        descriptor.Anonymous = FILE_ID_DESCRIPTOR_0 {
            ExtendedFileId: FILE_ID_128 { Identifier: bytes },
        };
    }
    let raw = unsafe {
        OpenFileById(
            volume.0,
            &descriptor,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        )
    };
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(win_error("OpenFileById"));
    }
    directory_info(&OwnedHandle(raw))
}

pub fn directory_journal(path: &str) -> Result<serde_json::Value, String> {
    let (volume, _) = open_volume_for(Path::new(path))?;
    let (journal, _) = query_journal(&volume)?;
    let object = directory_object(path)?;
    if object["attributes"].as_u64().unwrap_or(0) & 0x400 != 0 {
        return Err("reparse root".to_owned());
    }
    Ok(serde_json::json!({"format": 1, "volume": object["volume"],
        "journalId": journal.journal_id.to_string(), "firstUsn": journal.first_usn.to_string(),
        "nextUsn": journal.next_usn.to_string(), "lowestValidUsn": journal.lowest_valid_usn.to_string()}))
}

#[derive(Debug)]
struct DirectoryChange {
    usn: i64,
    reason: u32,
}

fn add_directory_change(
    records: &mut BTreeMap<(String, String), DirectoryChange>,
    id: String,
    parent: String,
    usn: i64,
    reason: u32,
) -> Result<(), String> {
    let key = (id, parent);
    if let Some(previous) = records.get_mut(&key) {
        previous.usn = usn;
        previous.reason |= reason;
    } else {
        if records.len() >= 2048 {
            return Err("directory response object-parent limit".to_owned());
        }
        records.insert(key, DirectoryChange { usn, reason });
    }
    Ok(())
}

pub fn directory_changes(path: &str, id: &str, start: &str) -> Result<serde_json::Value, String> {
    if id.is_empty()
        || id.len() > 20
        || !id.bytes().all(|byte| byte.is_ascii_digit())
        || start.is_empty()
        || start.len() > 19
        || !start.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("invalid journal cursor".to_owned());
    }
    let journal_id = id.parse::<u64>().map_err(|_| "invalid journal ID")?;
    let start_usn = start.parse::<i64>().map_err(|_| "invalid journal start")?;
    let (volume, _) = open_volume_for(Path::new(path))?;
    let (before, _) = query_journal(&volume)?;
    if before.journal_id != journal_id
        || start_usn < before.first_usn
        || start_usn < before.lowest_valid_usn
        || start_usn > before.next_usn
    {
        return Err("journal coverage is incomplete".to_owned());
    }
    let end = before.next_usn;
    let mut cursor = start_usn;
    let mut previous_usn = i64::MIN;
    let mut bytes = 0u64;
    let mut pages = 0;
    let mut records = BTreeMap::new();
    let started = Instant::now();
    while cursor < end {
        if pages >= MAX_PAGES || started.elapsed() > MAX_SCAN_TIME {
            return Err("journal scan limit".to_owned());
        }
        let page = read_page(&volume, cursor, journal_id)?;
        bytes += page.bytes_returned as u64;
        pages += 1;
        if bytes > MAX_JOURNAL_BYTES as u64 {
            return Err("journal byte limit".to_owned());
        }
        let mut at = 8;
        while at < page.bytes.len() {
            let record = parse_record(&page.bytes, at)?;
            if record.usn() <= previous_usn {
                return Err("nonmonotonic journal records".to_owned());
            }
            previous_usn = record.usn();
            // JS already ignores exact CLOSE records; keep mixed data/namespace reasons.
            if record.usn() >= start_usn
                && record.usn() < end
                && record.reason() != USN_REASON_CLOSE
            {
                let (object_id, parent_id) = match record {
                    UsnRecord::V2 { file_index_64, .. } => (
                        format!("{file_index_64:016x}"),
                        format!(
                            "{:016x}",
                            u64::from_le_bytes(page.bytes[at + 16..at + 24].try_into().unwrap())
                        ),
                    ),
                    UsnRecord::V3 { file_id_128, .. } => (
                        hex_bytes(&file_id_128),
                        hex_bytes(&page.bytes[at + 24..at + 40]),
                    ),
                };
                add_directory_change(
                    &mut records,
                    object_id,
                    parent_id,
                    record.usn(),
                    record.reason(),
                )?;
            }
            at += u32::from_le_bytes(page.bytes[at..at + 4].try_into().unwrap()) as usize;
        }
        if at != page.bytes.len() || page.next_usn <= cursor {
            return Err("invalid journal page progress".to_owned());
        }
        cursor = page.next_usn;
    }
    let (after, _) = query_journal(&volume)?;
    if after.journal_id != journal_id
        || after.first_usn > start_usn
        || after.lowest_valid_usn > start_usn
        || after.flags != before.flags
        || after.min_version != before.min_version
        || after.max_version != before.max_version
    {
        return Err("journal coverage changed during scan".to_owned());
    }
    // Latest position retains every uncovered mutation; OR keeps unsafe mixed reasons.
    let mut records: Vec<_> = records.into_iter().collect();
    records.sort_unstable_by_key(|(_, record)| record.usn);
    let records: Vec<_> = records
        .into_iter()
        .map(|((id, parent), record)| {
            serde_json::json!({
                "id": id, "parent": parent, "usn": record.usn.to_string(), "reason": record.reason,
            })
        })
        .collect();
    Ok(
        serde_json::json!({"format": 1, "journalId": id, "startUsn": start,
        "nextUsn": end.to_string(), "journalBytes": bytes, "records": records}),
    )
}

fn decode_token(value: &str) -> Result<Token, String> {
    if value.len() > MAX_TOKEN_BYTES {
        return Err("proof token is oversized".to_owned());
    }
    let fields: Vec<&str> = value.split(':').collect();
    if fields.len() != 9 || fields[0] != KIND {
        return Err("proof token is malformed".to_owned());
    }
    let seal_raw = parse_hex_u64(fields[2], "seal USN")?;
    if seal_raw > i64::MAX as u64 {
        return Err("proof token seal USN is invalid".to_owned());
    }
    if fields[3].len() != 16 || fields[4].len() != 32 || fields[5].len() != 16 {
        return Err("proof token identity is malformed".to_owned());
    }
    parse_hex_u64(fields[3], "volume serial")?;
    parse_hex_u64(fields[5], "file index")?;
    if !fields[4].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("proof token file ID is malformed".to_owned());
    }
    Ok(Token {
        journal_id: parse_hex_u64(fields[1], "journal ID")?,
        seal_usn: seal_raw as i64,
        identity: Identity {
            volume_hex: fields[3].to_ascii_lowercase(),
            file_id_128_hex: fields[4].to_ascii_lowercase(),
            file_index_64_hex: fields[5].to_ascii_lowercase(),
        },
        offset: parse_hex_u64(fields[6], "offset")?,
        size: parse_hex_u64(fields[7], "source size")?,
        mtime_ns: parse_hex_u64(fields[8], "source mtime")?,
    })
}

fn parse_hex_u64(value: &str, label: &str) -> Result<u64, String> {
    if value.is_empty() || value.len() > 16 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("proof token {label} is malformed"));
    }
    u64::from_str_radix(value, 16).map_err(|_| format!("proof token {label} is malformed"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    working_set_bytes: u64,
    peak_working_set_bytes: u64,
    pagefile_usage_bytes: u64,
}

pub fn process_footprint() -> Option<Footprint> {
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { mem::zeroed() };
    let success = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if success == 0 {
        return None;
    }
    Some(Footprint {
        working_set_bytes: counters.WorkingSetSize as u64,
        peak_working_set_bytes: counters.PeakWorkingSetSize as u64,
        pagefile_usage_bytes: counters.PagefileUsage as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_changes_keep_latest_position_and_all_unsafe_reasons() {
        let mut records = BTreeMap::new();
        for usn in 0..3000 {
            add_directory_change(&mut records, "file".into(), "parent".into(), usn, 2).unwrap();
        }
        add_directory_change(
            &mut records,
            "file".into(),
            "parent".into(),
            3000,
            1 | 0x80000000,
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        let original = ("file".to_owned(), "parent".to_owned());
        assert_eq!(records[&original].usn, 3000);
        assert_eq!(records[&original].reason, 0x80000003);
        add_directory_change(&mut records, "file".into(), "parent".into(), 3001, 0x10000).unwrap();
        assert_ne!(records[&original].reason & 0x10000, 0);
        add_directory_change(
            &mut records,
            "file".into(),
            "different".into(),
            3002,
            0x2000,
        )
        .unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[&original].usn, 3001);
        assert_eq!(
            records[&("file".to_owned(), "different".to_owned())].reason,
            0x2000
        );
    }

    #[test]
    fn directory_changes_keep_the_2048_object_budget() {
        let mut records = BTreeMap::new();
        for usn in 0..2048 {
            add_directory_change(&mut records, usn.to_string(), "parent".into(), usn, 2).unwrap();
        }
        assert!(add_directory_change(&mut records, "0".into(), "parent".into(), 2048, 2).is_ok());
        assert!(
            add_directory_change(&mut records, "new".into(), "parent".into(), 2049, 2).is_err()
        );
        assert_eq!(records.len(), 2048);
    }

    fn v2_record(usn: i64, file_index: u64, reason: u32) -> Vec<u8> {
        let name: Vec<u16> = "fixture.jsonl".encode_utf16().collect();
        let length = 60 + name.len() * 2;
        let mut record = vec![0u8; length];
        record[0..4].copy_from_slice(&(length as i32).to_le_bytes());
        record[4..6].copy_from_slice(&2u16.to_le_bytes());
        record[8..16].copy_from_slice(&file_index.to_le_bytes());
        record[24..32].copy_from_slice(&usn.to_le_bytes());
        record[40..44].copy_from_slice(&reason.to_le_bytes());
        record[56..58].copy_from_slice(&((name.len() * 2) as u16).to_le_bytes());
        record[58..60].copy_from_slice(&60u16.to_le_bytes());
        for (index, value) in name.iter().enumerate() {
            record[60 + index * 2..62 + index * 2].copy_from_slice(&value.to_le_bytes());
        }
        record
    }

    fn v3_record(usn: i64, file_id: [u8; 16], reason: u32) -> Vec<u8> {
        let name: Vec<u16> = "fixture.jsonl".encode_utf16().collect();
        let length = 76 + name.len() * 2;
        let mut record = vec![0u8; length];
        record[0..4].copy_from_slice(&(length as i32).to_le_bytes());
        record[4..6].copy_from_slice(&3u16.to_le_bytes());
        record[8..24].copy_from_slice(&file_id);
        record[40..48].copy_from_slice(&usn.to_le_bytes());
        record[56..60].copy_from_slice(&reason.to_le_bytes());
        record[72..74].copy_from_slice(&((name.len() * 2) as u16).to_le_bytes());
        record[74..76].copy_from_slice(&76u16.to_le_bytes());
        for (index, value) in name.iter().enumerate() {
            record[76 + index * 2..78 + index * 2].copy_from_slice(&value.to_le_bytes());
        }
        record
    }

    #[test]
    fn parses_exact_v2_and_v3_identity() {
        let v2 = v2_record(101, 0x0123_4567_89ab_cdef, USN_REASON_DATA_EXTEND);
        let parsed_v2 = parse_record(&v2, 0).unwrap();
        assert_eq!(
            parsed_v2,
            UsnRecord::V2 {
                usn: 101,
                file_index_64: 0x0123_4567_89ab_cdef,
                reason: USN_REASON_DATA_EXTEND,
            }
        );

        let id = [0x10, 0x88, 0x0c, 0, 0, 0, 0, 0x3d, 1, 0, 0, 0, 0, 0, 0, 0];
        let v3 = v3_record(202, id, USN_REASON_DATA_EXTEND | USN_REASON_CLOSE);
        assert_eq!(
            parse_record(&v3, 0).unwrap(),
            UsnRecord::V3 {
                usn: 202,
                file_id_128: id,
                reason: USN_REASON_DATA_EXTEND | USN_REASON_CLOSE,
            }
        );
    }

    #[test]
    fn rejects_truncation_unsupported_versions_and_bad_bounds() {
        let v2 = v2_record(101, 7, USN_REASON_DATA_EXTEND);
        assert!(parse_record(&v2[..v2.len() - 1], 0).is_err());

        let mut v4 = v2.clone();
        v4[4..6].copy_from_slice(&4u16.to_le_bytes());
        assert!(parse_record(&v4, 0).is_err());

        let mut bad_name_offset = v2;
        bad_name_offset[58..60].copy_from_slice(&999u16.to_le_bytes());
        assert!(parse_record(&bad_name_offset, 0).is_err());
    }

    #[test]
    fn token_round_trip_is_identity_and_range_bound() {
        let token = Token {
            journal_id: 0x1234_5678_9abc_def0,
            seal_usn: 0x0000_0005_0000_0010,
            identity: Identity {
                volume_hex: "00000000c69d8ea8".to_owned(),
                file_id_128_hex: "10880c0000003d010000000000000000".to_owned(),
                file_index_64_hex: "013d0000000c8810".to_owned(),
            },
            offset: 4096,
            size: 4096,
            mtime_ns: 1_700_000_000_000_000_000,
        };
        assert_eq!(decode_token(&encode_token(&token)).unwrap(), token);
        assert!(decode_token("ntfs-usn-v1:broken").is_err());
        assert!(decode_token(&"x".repeat(MAX_TOKEN_BYTES + 1)).is_err());
    }

    #[test]
    fn mutation_policy_allows_extent_and_metadata_but_not_overwrite() {
        assert_eq!(USN_REASON_DATA_EXTEND & !ALLOWED_REASON_MASK, 0);
        assert_eq!(USN_REASON_BASIC_INFO_CHANGE & !ALLOWED_REASON_MASK, 0);
        assert_eq!(USN_REASON_CLOSE & !ALLOWED_REASON_MASK, 0);
        assert_ne!(USN_REASON_DATA_OVERWRITE & !ALLOWED_REASON_MASK, 0);
        assert_ne!(USN_REASON_DATA_TRUNCATION & !ALLOWED_REASON_MASK, 0);
        assert_ne!(USN_REASON_FILE_CREATE & !ALLOWED_REASON_MASK, 0);
        assert_ne!(USN_REASON_FILE_DELETE & !ALLOWED_REASON_MASK, 0);
    }

    #[test]
    fn journal_metadata_rejects_flags_gaps_and_unsupported_versions() {
        let valid = JournalData {
            journal_id: 1,
            first_usn: 10,
            next_usn: 20,
            lowest_valid_usn: 10,
            max_usn: 100,
            min_version: 2,
            max_version: 4,
            flags: 0,
        };
        assert!(validate_journal(&valid).is_ok());
        let mut invalid = valid.clone();
        invalid.flags = 1;
        assert!(validate_journal(&invalid).is_err());
        let mut invalid = valid.clone();
        invalid.min_version = 4;
        assert!(validate_journal(&invalid).is_err());
        let mut invalid = valid;
        invalid.next_usn = invalid.first_usn - 1;
        assert!(validate_journal(&invalid).is_err());
    }

    #[test]
    fn interval_validation_rejects_retention_gaps_at_either_floor() {
        let token = Token {
            journal_id: 1,
            seal_usn: 20,
            identity: Identity {
                volume_hex: "00000000c69d8ea8".to_owned(),
                file_id_128_hex: "10880c0000003d010000000000000000".to_owned(),
                file_index_64_hex: "013d0000000c8810".to_owned(),
            },
            offset: 10,
            size: 10,
            mtime_ns: 1,
        };
        let start = JournalData {
            journal_id: 1,
            first_usn: 10,
            next_usn: 21,
            lowest_valid_usn: 10,
            max_usn: 30,
            min_version: 2,
            max_version: 4,
            flags: 0,
        };
        let end = JournalData {
            first_usn: 10,
            next_usn: 31,
            lowest_valid_usn: 10,
            max_usn: 31,
            ..start.clone()
        };

        let mut gap_at_start = start.clone();
        gap_at_start.first_usn = 21;
        gap_at_start.lowest_valid_usn = 21;
        assert!(validate_start_journal(&gap_at_start, &token).is_err());

        let mut gap_at_old_seal = end.clone();
        gap_at_old_seal.first_usn = 21;
        gap_at_old_seal.lowest_valid_usn = 21;
        assert!(validate_end_journal(&start, &gap_at_old_seal, &token, 30).is_err());

        let mut gap_at_new_seal = end.clone();
        gap_at_new_seal.first_usn = 31;
        gap_at_new_seal.lowest_valid_usn = 31;
        assert!(validate_end_journal(&start, &gap_at_new_seal, &token, 30).is_err());
    }

    #[test]
    fn interval_validation_rejects_changed_versions() {
        let token = Token {
            journal_id: 1,
            seal_usn: 20,
            identity: Identity {
                volume_hex: "00000000c69d8ea8".to_owned(),
                file_id_128_hex: "10880c0000003d010000000000000000".to_owned(),
                file_index_64_hex: "013d0000000c8810".to_owned(),
            },
            offset: 10,
            size: 10,
            mtime_ns: 1,
        };
        let start = JournalData {
            journal_id: 1,
            first_usn: 10,
            next_usn: 21,
            lowest_valid_usn: 10,
            max_usn: 30,
            min_version: 2,
            max_version: 4,
            flags: 0,
        };
        let end = JournalData {
            next_usn: 31,
            max_usn: 31,
            max_version: 5,
            ..start.clone()
        };
        assert!(validate_end_journal(&start, &end, &token, 30).is_err());
    }
}
