mod usn;

use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Write};

const MAX_REQUEST_BYTES: usize = 128 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    op: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    expected: Option<ExpectedInfoDto>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default, rename = "journalId")]
    journal_id: Option<String>,
    #[serde(default, rename = "startUsn")]
    start_usn: Option<String>,
    #[serde(default, rename = "fileId")]
    file_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedInfoDto {
    size: String,
    mtime_ns: String,
}

impl ExpectedInfoDto {
    fn parse(&self) -> Result<usn::ExpectedInfo, String> {
        let size = parse_u64(&self.size, "expected size")?;
        let mtime_ns = parse_u64(&self.mtime_ns, "expected mtimeNs")?;
        Ok(usn::ExpectedInfo { size, mtime_ns })
    }
}

fn parse_u64(value: &str, label: &str) -> Result<u64, String> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("invalid {label}"));
    }
    value.parse::<u64>().map_err(|_| format!("invalid {label}"))
}

fn read_line_bounded<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unterminated request",
                ))
            };
        }
        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            if output.len().saturating_add(position) > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "request exceeds frame limit",
                ));
            }
            output.extend_from_slice(&available[..position]);
            reader.consume(position + 1);
            return Ok(Some(output));
        }
        if output.len().saturating_add(available.len()) > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request exceeds frame limit",
            ));
        }
        output.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

fn write_response<W: Write>(writer: &mut W, value: serde_json::Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, &value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn error_response(id: u64, reason: impl Into<String>) -> serde_json::Value {
    json!({
        "id": id,
        "ok": false,
        "available": false,
        "reason": reason.into(),
    })
}

fn proof_response(id: u64, proof: usn::ProofResult) -> serde_json::Value {
    json!({
        "id": id,
        "ok": true,
        "available": true,
        "kind": usn::KIND,
        "offset": proof.offset,
        "token": proof.token,
        "journalBytes": proof.journal_bytes,
    })
}

fn handle_request(request: Request, archive_locks: &mut usn::ArchiveLocks) -> serde_json::Value {
    if request.id == 0 {
        return error_response(0, "request id must be nonzero");
    }
    if request.op == "stats" {
        return json!({
            "id": request.id,
            "ok": true,
            "available": true,
            "footprint": usn::process_footprint(),
        });
    }
    if request.path.is_empty() || request.path.encode_utf16().count() >= 32_768 {
        return error_response(request.id, "invalid path");
    }
    if matches!(
        request.op.as_str(),
        "archiveLock" | "archiveCheck" | "archiveUnlock"
    ) {
        if request.offset.is_some()
            || request.expected.is_some()
            || request.journal_id.is_some()
            || request.start_usn.is_some()
            || request.file_id.is_some()
        {
            return error_response(request.id, "unexpected archive lock fields");
        }
        let result = if request.op == "archiveLock" {
            if request.token.is_some() {
                return error_response(request.id, "unexpected archive lock token");
            }
            archive_locks.lock(&request.path)
        } else {
            let token = match request.token {
                Some(token) if !token.is_empty() && token.len() <= usn::MAX_TOKEN_BYTES => token,
                _ => return error_response(request.id, "invalid archive lock token"),
            };
            let result = if request.op == "archiveCheck" {
                archive_locks.check(&request.path, &token)
            } else {
                archive_locks.unlock(&request.path, &token)
            };
            result.map(|()| token)
        };
        return match result {
            Ok(token) => json!({"id": request.id, "ok": true, "available": true,
                "kind": usn::ARCHIVE_LOCK_KIND, "token": token}),
            Err(reason) => error_response(request.id, reason),
        };
    }
    if matches!(
        request.op.as_str(),
        "journal" | "changes" | "object" | "resolve"
    ) {
        let result = match request.op.as_str() {
            "journal" => usn::directory_journal(&request.path),
            "object" => usn::directory_object(&request.path),
            "resolve" => {
                usn::directory_resolve(&request.path, request.file_id.as_deref().unwrap_or(""))
            }
            "changes" => usn::directory_changes(
                &request.path,
                request.journal_id.as_deref().unwrap_or(""),
                request.start_usn.as_deref().unwrap_or(""),
            ),
            _ => unreachable!(),
        };
        return match result {
            Ok(value) => json!({"id": request.id, "ok": true, "available": true,
                "kind": usn::DIRECTORY_KIND, "value": value}),
            Err(reason) => error_response(request.id, reason),
        };
    }
    let offset = match request.offset {
        Some(offset) => offset,
        None => return error_response(request.id, "offset is required"),
    };
    let expected = match request.expected {
        Some(expected) => match expected.parse() {
            Ok(expected) => expected,
            Err(reason) => return error_response(request.id, reason),
        },
        None => return error_response(request.id, "expected info is required"),
    };
    let result = match request.op.as_str() {
        "begin" => {
            if offset != 0 {
                Err("begin offset must be zero".to_owned())
            } else {
                usn::begin(&request.path, offset, &expected)
            }
        }
        "verify" | "advance" => {
            let token = match request.token {
                Some(token) if !token.is_empty() && token.len() <= usn::MAX_TOKEN_BYTES => token,
                _ => return error_response(request.id, "invalid token"),
            };
            usn::prove_interval(&request.path, offset, &expected, &token)
        }
        _ => return error_response(request.id, "unsupported operation"),
    };
    match result {
        Ok(proof) => proof_response(request.id, proof),
        Err(reason) => error_response(request.id, reason),
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let mut archive_locks = usn::ArchiveLocks::new();

    loop {
        let line = match read_line_bounded(&mut reader, MAX_REQUEST_BYTES) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                let _ = write_response(
                    &mut writer,
                    error_response(0, format!("invalid request frame: {error}")),
                );
                break;
            }
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => request,
            Err(_) => {
                let response = error_response(0, "malformed request");
                if write_response(&mut writer, response).is_err() {
                    break;
                }
                continue;
            }
        };
        let response = handle_request(request, &mut archive_locks);
        if write_response(&mut writer, response).is_err() {
            break;
        }
    }
}
