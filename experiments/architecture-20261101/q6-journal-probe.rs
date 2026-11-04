// Experimental access to the existing reader; source files and journal configuration are unchanged.
#[allow(dead_code)]
mod usn {
    include!("../../native/windows-source-proof/src/usn.rs");
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    fn object(path: &str) -> Result<serde_json::Value, String> {
        let handle = OwnedHandle::open(path, 0, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)?;
        let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut basic) } == 0 {
            return Err(win_error("GetFileInformationByHandle"));
        }
        let mut full: FILE_ID_INFO = unsafe { mem::zeroed() };
        if unsafe { GetFileInformationByHandleEx(handle.0, FileIdInfo,
            &mut full as *mut _ as *mut c_void, size_of::<FILE_ID_INFO>() as u32) } == 0 {
            return Err(win_error("GetFileInformationByHandleEx(FileIdInfo)"));
        }
        let id = format!("{:016x}", ((basic.nFileIndexHigh as u64) << 32) | basic.nFileIndexLow as u64);
        Ok(serde_json::json!({
            "id": id, "ids": [id, hex_bytes(&full.FileId.Identifier)],
            "links": basic.nNumberOfLinks, "attributes": basic.dwFileAttributes,
            "size": ((basic.nFileSizeHigh as u64) << 32) | basic.nFileSizeLow as u64,
        }))
    }

    fn field<'a>(request: &'a serde_json::Value, name: &str) -> Result<&'a str, String> {
        request[name].as_str().ok_or_else(|| format!("missing {name}"))
    }

    fn decoded(bytes: &[u8], at: usize) -> Result<serde_json::Value, String> {
        let parsed = parse_record(bytes, at)?;
        let major = u16::from_le_bytes(bytes[at + 4..at + 6].try_into().unwrap());
        let (parent, no, nl) = if major == 2 {
            (format!("{:016x}", u64::from_le_bytes(bytes[at + 16..at + 24].try_into().unwrap())), 58, 56)
        } else {
            (hex_bytes(&bytes[at + 24..at + 40]), 74, 72)
        };
        let name_at = at + u16::from_le_bytes(bytes[at + no..at + no + 2].try_into().unwrap()) as usize;
        let name_len = u16::from_le_bytes(bytes[at + nl..at + nl + 2].try_into().unwrap()) as usize;
        let utf16: Vec<u16> = bytes[name_at..name_at + name_len].chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let name = String::from_utf16(&utf16).map_err(|_| "invalid UTF-16 name")?;
        let id = match parsed {
            UsnRecord::V2 { file_index_64, .. } => format!("{file_index_64:016x}"),
            UsnRecord::V3 { file_id_128, .. } => hex_bytes(&file_id_128),
        };
        Ok(serde_json::json!({"usn": parsed.usn().to_string(), "id": id,
            "parent": parent, "name": name, "reason": parsed.reason()}))
    }

    pub fn request(request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let path = field(request, "path")?;
        let op = field(request, "op")?;
        if op == "object" { return object(path); }
        if op == "restore-mtime" {
            use windows_sys::Win32::Storage::FileSystem::{SetFileTime, FILE_WRITE_ATTRIBUTES};
            let ns = field(request, "mtimeNs")?.parse::<u64>().map_err(|_| "invalid mtime")?;
            if !ns.is_multiple_of(100) { return Err("mtime is not a Windows tick".to_owned()); }
            let ticks = (ns / 100).checked_add(116_444_736_000_000_000).ok_or("mtime overflow")?;
            let time = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
            let file = OwnedHandle::open(path, FILE_WRITE_ATTRIBUTES, FILE_ATTRIBUTE_NORMAL)?;
            if unsafe { SetFileTime(file.0, ptr::null(), ptr::null(), &time) } == 0 { return Err(win_error("SetFileTime")); }
            return Ok(serde_json::json!({"restored": true}));
        }
        let (root, _) = open_volume_for(Path::new(path))?;
        let (journal, _) = query_journal(&root)?;
        if op == "resolve" {
            use windows_sys::Win32::Storage::FileSystem::{OpenFileById, GetFinalPathNameByHandleW,
                FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_ID_128, ExtendedFileIdType, FileIdType};
            let id = field(request, "id")?;
            if !id.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("bad file ID encoding".to_owned()); }
            let mut descriptor = FILE_ID_DESCRIPTOR::default();
            descriptor.dwSize = size_of::<FILE_ID_DESCRIPTOR>() as u32;
            if id.len() == 32 {
                let mut bytes = [0u8; 16];
                for (at, byte) in bytes.iter_mut().enumerate() {
                    *byte = u8::from_str_radix(&id[at * 2..at * 2 + 2], 16).map_err(|_| "bad file ID")?;
                }
                descriptor.Type = ExtendedFileIdType;
                descriptor.Anonymous = FILE_ID_DESCRIPTOR_0 { ExtendedFileId: FILE_ID_128 { Identifier: bytes } };
            } else if id.len() == 16 {
                descriptor.Type = FileIdType;
                descriptor.Anonymous = FILE_ID_DESCRIPTOR_0 { FileId: u64::from_str_radix(id, 16).map_err(|_| "bad file ID")? as i64 };
            } else { return Err("bad file ID width".to_owned()); }
            let raw = unsafe { OpenFileById(root.0, &descriptor, 0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ptr::null(), FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT) };
            if raw.is_null() || raw == INVALID_HANDLE_VALUE { return Err(win_error("OpenFileById")); }
            let handle = OwnedHandle(raw);
            let mut basic: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
            if unsafe { GetFileInformationByHandle(handle.0, &mut basic) } == 0 { return Err(win_error("GetFileInformationByHandle")); }
            let mut name = vec![0u16; 32768];
            let length = unsafe { GetFinalPathNameByHandleW(handle.0, name.as_mut_ptr(), name.len() as u32, 0) };
            if length == 0 || length as usize >= name.len() { return Err(win_error("GetFinalPathNameByHandleW")); }
            return Ok(serde_json::json!({"path": String::from_utf16(&name[..length as usize]).map_err(|_| "bad resolved path")?,
                "links": basic.nNumberOfLinks, "attributes": basic.dwFileAttributes}));
        }
        if op == "query" {
            return Ok(serde_json::json!({"journalId": journal.journal_id.to_string(),
                "first": journal.first_usn.to_string(), "next": journal.next_usn.to_string(),
                "floor": journal.lowest_valid_usn.to_string(), "object": object(path)?}));
        }
        if op == "seal" {
            let file = OwnedHandle::open(path, GENERIC_READ, FILE_FLAG_BACKUP_SEMANTICS)?;
            return Ok(serde_json::json!({"seal": seal_record(&file)?.0.to_string()}));
        }
        if op != "read" { return Err("unsupported operation".to_owned()); }
        let journal_id = field(request, "journalId")?.parse::<u64>().map_err(|_| "bad journal ID")?;
        let mut cursor = field(request, "start")?.parse::<i64>().map_err(|_| "bad cursor")?;
        if journal_id != journal.journal_id || cursor < journal.first_usn || cursor < journal.lowest_valid_usn
            || cursor > journal.next_usn { return Err("journal coverage gap or changed ID".to_owned()); }
        let end = journal.next_usn;
        if let Some(resume) = request["pauseUntil"].as_str() {
            use std::io::Write;
            println!("{}", serde_json::json!({"phase": "captured-cut", "next": end.to_string()}));
            std::io::stdout().flush().map_err(|error| error.to_string())?;
            let paused = Instant::now();
            while !Path::new(resume).exists() {
                if paused.elapsed() > Duration::from_secs(2) { return Err("probe resume deadline".to_owned()); }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let ids: Vec<&str> = request["ids"].as_array().ok_or("missing oracle IDs")?
            .iter().map(|id| id.as_str().ok_or("bad oracle ID")).collect::<Result<_, _>>()?;
        let mut found = Vec::new();
        let mut total_bytes = 0u64;
        let mut total_records = 0usize;
        let mut pages = 0;
        let started = Instant::now();
        while cursor < end {
            if pages >= MAX_PAGES || total_bytes >= MAX_JOURNAL_BYTES as u64 || started.elapsed() > MAX_SCAN_TIME {
                return Err("bounded probe scan exceeded".to_owned());
            }
            let page = read_page(&root, cursor, journal_id)?;
            pages += 1;
            total_bytes += page.bytes_returned as u64;
            let mut at = 8;
            while at < page.bytes.len() {
                let parsed = parse_record(&page.bytes, at)?;
                total_records += 1;
                if total_records > MAX_RECORDS { return Err("probe record limit exceeded".to_owned()); }
                if parsed.usn() >= cursor && parsed.usn() < end {
                    let row = decoded(&page.bytes, at)?;
                    if request["allRecords"].as_bool() == Some(true)
                        || ids.contains(&row["id"].as_str().unwrap()) { found.push(row); }
                }
                at += u32::from_le_bytes(page.bytes[at..at + 4].try_into().unwrap()) as usize;
            }
            if at != page.bytes.len() || page.next_usn <= cursor { return Err("invalid page progress".to_owned()); }
            cursor = page.next_usn;
        }
        let (after, _) = query_journal(&root)?;
        if after.journal_id != journal_id || after.first_usn > field(request, "start")?.parse::<i64>().unwrap()
            || after.lowest_valid_usn > field(request, "start")?.parse::<i64>().unwrap() {
            return Err("journal coverage lost while scanning".to_owned());
        }
        Ok(serde_json::json!({"next": end.to_string(), "records": found,
            "scannedBytes": total_bytes, "scannedRecords": total_records, "pages": pages}))
    }
}

fn main() {
    use std::io::{self, BufRead, Write};
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let result = line.map_err(|error| error.to_string()).and_then(|line| {
            if line.len() > 128 * 1024 { return Err("oversized request".to_owned()); }
            let request: serde_json::Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
            usn::request(&request)
        });
        let response = match result {
            Ok(value) => serde_json::json!({"ok": true, "value": value}),
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        };
        if writeln!(stdout, "{response}").and_then(|_| stdout.flush()).is_err() { break; }
    }
}
