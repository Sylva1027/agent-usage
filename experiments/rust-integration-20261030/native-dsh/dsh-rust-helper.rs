use serde_json::{Map, Value, json};
use std::ffi::{CStr, c_char, c_void};
use std::fs;
use std::io::{self, BufRead, BufWriter, Write};
use std::path::Path;

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
const BATCH_ROWS: usize = 64;

#[cfg(windows)]
#[link(name = "zstd", kind = "raw-dylib")]
unsafe extern "C" {
    fn ZSTD_decompressBound(src: *const c_void, src_size: usize) -> u64;
    fn ZSTD_decompress(
        dst: *mut c_void,
        dst_capacity: usize,
        src: *const c_void,
        compressed_size: usize,
    ) -> usize;
    fn ZSTD_isError(code: usize) -> u32;
    fn ZSTD_versionString() -> *const c_char;
}

fn zstd_version() -> String {
    let pointer = unsafe { ZSTD_versionString() };
    if pointer.is_null() {
        "unknown".to_string()
    } else {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}

fn find_magic(buffer: &[u8], start: usize) -> Option<usize> {
    buffer[start..]
        .windows(ZSTD_MAGIC.len())
        .position(|window| window == ZSTD_MAGIC)
        .map(|offset| start + offset)
}

fn decompress_frame(source: &[u8]) -> Option<Vec<u8>> {
    let bound = unsafe { ZSTD_decompressBound(source.as_ptr().cast(), source.len()) };
    if unsafe { ZSTD_isError(bound as usize) } != 0 || bound > usize::MAX as u64 {
        return None;
    }
    let mut output = vec![0_u8; bound as usize];
    let written = unsafe {
        ZSTD_decompress(
            output.as_mut_ptr().cast(),
            output.len(),
            source.as_ptr().cast(),
            source.len(),
        )
    };
    if unsafe { ZSTD_isError(written) } != 0 {
        return None;
    }
    output.truncate(written);
    Some(output)
}

fn take(object: &mut Map<String, Value>, key: &str) -> Option<Value> {
    object.remove(key)
}

fn take_fields(object: &mut Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    let mut projected = Map::new();
    for key in keys {
        if let Some(value) = take(object, key) {
            projected.insert((*key).to_string(), value);
        }
    }
    projected
}

fn presence_string(value: Value) -> Value {
    match value {
        Value::String(value) if value.is_empty() => Value::String(String::new()),
        Value::String(_) => Value::String("x".to_string()),
        _ => Value::Null,
    }
}

fn presence_strings(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(presence_string).collect()),
        _ => Value::Null,
    }
}

fn integer_like(value: Value) -> Value {
    match value {
        Value::Number(_) => value,
        _ => Value::Null,
    }
}

fn integer_array(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(integer_like).collect()),
        _ => value,
    }
}

fn output_tokens(value: Option<Value>) -> Value {
    match value {
        Some(value @ Value::Number(_)) => value,
        _ => Value::Null,
    }
}

fn project_block(value: Option<Value>) -> Value {
    let Some(Value::Object(mut block)) = value else {
        return Value::Null;
    };
    let mut projected = Map::new();
    if let Some(value) = take(&mut block, "type") {
        projected.insert(
            "type".to_string(),
            match value {
                Value::String(value) => Value::String(value),
                _ => Value::Null,
            },
        );
    }
    Value::Object(projected)
}

fn project_stream_usage(value: Option<Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let Value::Object(mut usage) = value else {
        return Value::Null;
    };
    let mut projected = Map::new();
    projected.insert(
        "outputTokens".to_string(),
        output_tokens(take(&mut usage, "outputTokens")),
    );
    Value::Object(projected)
}

fn project_finish_reason(value: Option<Value>) -> Value {
    let Some(Value::Object(mut reason)) = value else {
        return Value::Null;
    };
    let mut projected = Map::new();
    if let Some(value) = take(&mut reason, "kind") {
        projected.insert(
            "kind".to_string(),
            match value {
                Value::String(value) => Value::String(value),
                _ => Value::Null,
            },
        );
    }
    Value::Object(projected)
}

fn project_chunk(value: Value) -> Value {
    let Value::Object(mut chunk) = value else {
        return Value::Null;
    };
    let mut projected = Map::new();
    let chunk_type = match take(&mut chunk, "type") {
        Some(Value::String(value)) => value,
        Some(_) => {
            projected.insert("type".to_string(), Value::Null);
            return Value::Object(projected);
        }
        None => return Value::Object(projected),
    };
    projected.insert("type".to_string(), Value::String(chunk_type.clone()));

    match chunk_type.as_str() {
        "text-delta" | "reasoning-delta" => {
            if let Some(value) = take(&mut chunk, "text") {
                projected.insert("text".to_string(), presence_string(value));
            }
        }
        "tool-call-delta" => {
            if let Some(value) = take(&mut chunk, "argumentsDelta") {
                projected.insert("argumentsDelta".to_string(), presence_string(value));
            }
        }
        "block-start" => {
            if let Some(value) = take(&mut chunk, "blockType") {
                projected.insert(
                    "blockType".to_string(),
                    match value {
                        Value::String(value) => Value::String(value),
                        _ => Value::Null,
                    },
                );
            }
        }
        "block-end" => {
            if let Some(value) = take(&mut chunk, "block") {
                projected.insert("block".to_string(), project_block(Some(value)));
            }
        }
        "usage" => {
            projected.insert(
                "usage".to_string(),
                project_stream_usage(take(&mut chunk, "usage")),
            );
        }
        "finish" => {
            projected.insert(
                "reason".to_string(),
                project_finish_reason(take(&mut chunk, "reason")),
            );
        }
        _ => {}
    }
    Value::Object(projected)
}

fn project_stream_record(value: Value) -> Value {
    let Value::Object(mut record) = value else {
        return Value::Null;
    };
    let mut projected = Map::new();
    let record_type = match take(&mut record, "type") {
        Some(Value::String(value)) => value,
        Some(_) => {
            projected.insert("type".to_string(), Value::Null);
            return Value::Object(projected);
        }
        None => return Value::Object(projected),
    };
    projected.insert("type".to_string(), Value::String(record_type.clone()));

    match record_type.as_str() {
        "text-chunks" | "reasoning-chunks" => {
            if let Some(value) = take(&mut record, "texts") {
                projected.insert("texts".to_string(), presence_strings(value));
            }
            if let Some(value) = take(&mut record, "time0") {
                projected.insert("time0".to_string(), integer_like(value));
            }
            if let Some(value) = take(&mut record, "index") {
                projected.insert("index".to_string(), integer_like(value));
            }
            if let Some(value) = take(&mut record, "dt") {
                projected.insert("dt".to_string(), integer_array(value));
            }
        }
        "tool-call-chunks" => {
            if let Some(value) = take(&mut record, "args") {
                projected.insert("args".to_string(), presence_strings(value));
            }
            if let Some(value) = take(&mut record, "id") {
                projected.insert("id".to_string(), presence_string(value));
            }
            if let Some(value) = take(&mut record, "name") {
                projected.insert("name".to_string(), presence_string(value));
            }
            if let Some(value) = take(&mut record, "time0") {
                projected.insert("time0".to_string(), integer_like(value));
            }
            if let Some(value) = take(&mut record, "index") {
                projected.insert("index".to_string(), integer_like(value));
            }
            if let Some(value) = take(&mut record, "dt") {
                projected.insert("dt".to_string(), integer_array(value));
            }
        }
        "chunk" => {
            if let Some(value) = take(&mut record, "time") {
                projected.insert("time".to_string(), integer_like(value));
            }
            if let Some(value) = take(&mut record, "chunk") {
                projected.insert("chunk".to_string(), project_chunk(value));
            }
        }
        _ => {}
    }
    Value::Object(projected)
}

fn project_stream(value: Value) -> Value {
    match value {
        Value::Array(records) => {
            Value::Array(records.into_iter().map(project_stream_record).collect())
        }
        Value::Null => Value::Null,
        _ => Value::Object(Map::new()),
    }
}

fn project_request_data(value: Option<Value>) -> Option<Value> {
    let Value::Object(mut data) = value? else {
        return None;
    };
    let mut projected = Map::new();
    for key in ["model", "provider"] {
        if let Some(value) = take(&mut data, key) {
            projected.insert(key.to_string(), value);
        }
    }
    if let Some(Value::Object(mut header)) = take(&mut data, "header") {
        if let Some(config) = take(&mut header, "config") {
            if config.is_object() || config.is_array() {
                let mut config = match config {
                    Value::Object(config) => config,
                    _ => Map::new(),
                };
                let config = take_fields(&mut config, &["model", "provider", "reasoningEffort"]);
                projected.insert(
                    "header".to_string(),
                    json!({ "config": Value::Object(config) }),
                );
            }
        }
    }
    Some(Value::Object(projected))
}

fn project_usage(value: Value) -> Value {
    let mut usage = match value {
        Value::Object(usage) => usage,
        _ => return Value::Null,
    };
    Value::Object(take_fields(
        &mut usage,
        &[
            "inputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "outputTokens",
            "totalTokens",
            "reasoningTokens",
        ],
    ))
}

fn project_message_source(value: Value) -> Option<Value> {
    let Value::Object(mut source) = value else {
        return None;
    };
    let source = take_fields(&mut source, &["model", "provider"]);
    if source.is_empty() {
        None
    } else {
        Some(Value::Object(source))
    }
}

fn project_assistant_data(value: Option<Value>) -> Option<Value> {
    let Value::Object(mut data) = value? else {
        return None;
    };
    let mut projected = Map::new();
    for key in ["turn", "step"] {
        if let Some(value) = take(&mut data, key) {
            projected.insert(key.to_string(), value);
        }
    }
    if let Some(value) = take(&mut data, "usage") {
        projected.insert("usage".to_string(), project_usage(value));
    }
    if let Some(Value::Object(mut message)) = take(&mut data, "message") {
        if let Some(source) = take(&mut message, "source").and_then(project_message_source) {
            projected.insert("message".to_string(), json!({ "source": source }));
        }
    }
    if let Some(value) = take(&mut data, "stream") {
        projected.insert("stream".to_string(), project_stream(value));
    }
    Some(Value::Object(projected))
}

fn project_title_data(value: Option<Value>) -> Option<Value> {
    let Value::Object(mut data) = value? else {
        return None;
    };
    let mut projected = Map::new();
    if let Some(value) = take(&mut data, "title") {
        projected.insert("title".to_string(), value);
    }
    Some(Value::Object(projected))
}

fn project_identity_data(value: Option<Value>) -> Option<Value> {
    let Value::Object(mut data) = value? else {
        return None;
    };
    let mut projected = Map::new();
    for key in ["turn", "step"] {
        if let Some(value) = take(&mut data, key) {
            projected.insert(key.to_string(), value);
        }
    }
    Some(Value::Object(projected))
}

fn project_row(value: Value) -> Value {
    let Value::Object(mut row) = value else {
        return Value::Object(Map::new());
    };
    let row_type = match take(&mut row, "type") {
        Some(Value::String(value)) => value,
        Some(_) => return Value::Object(Map::new()),
        None => return Value::Object(Map::new()),
    };
    let mut projected = Map::new();
    projected.insert("type".to_string(), Value::String(row_type.clone()));

    match row_type.as_str() {
        "session" => {
            for key in [
                "id",
                "version",
                "cwd",
                "delegationDepth",
                "createdAt",
                "agentPreset",
            ] {
                if let Some(value) = take(&mut row, key) {
                    projected.insert(key.to_string(), value);
                }
            }
        }
        "request/header" | "request/context" => {
            if let Some(data) = project_request_data(take(&mut row, "data")) {
                projected.insert("data".to_string(), data);
            }
        }
        "session/title" => {
            if let Some(data) = project_title_data(take(&mut row, "data")) {
                projected.insert("data".to_string(), data);
            }
        }
        "assistant/message" => {
            for key in ["seq", "time"] {
                if let Some(value) = take(&mut row, key) {
                    projected.insert(key.to_string(), value);
                }
            }
            if let Some(data) = project_assistant_data(take(&mut row, "data")) {
                projected.insert("data".to_string(), data);
            }
        }
        "step/start" | "llm/retry-started" => {
            if let Some(value) = take(&mut row, "time") {
                projected.insert("time".to_string(), value);
            }
            if let Some(data) = project_identity_data(take(&mut row, "data")) {
                projected.insert("data".to_string(), data);
            }
        }
        "step/end" => {
            if let Some(data) = project_identity_data(take(&mut row, "data")) {
                projected.insert("data".to_string(), data);
            }
        }
        _ => {}
    }
    Value::Object(projected)
}

fn send<W: Write>(writer: &mut W, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn flush_rows<W: Write>(writer: &mut W, rows: &mut Vec<Value>) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let payload = json!({ "kind": "batch", "rows": std::mem::take(rows) });
    send(writer, &payload)
}

fn push_row<W: Write>(writer: &mut W, rows: &mut Vec<Value>, row: Value) -> Result<(), String> {
    rows.push(project_row(row));
    if rows.len() >= BATCH_ROWS {
        flush_rows(writer, rows)?;
    }
    Ok(())
}

fn parse_and_push<W: Write>(
    writer: &mut W,
    rows: &mut Vec<Value>,
    line: &str,
    malformed_lines: &mut u64,
) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }
    match serde_json::from_str::<Value>(line) {
        Ok(row) => push_row(writer, rows, row),
        Err(_) => {
            *malformed_lines += 1;
            Ok(())
        }
    }
}

fn scan_file<W: Write>(writer: &mut W, file_path: &Path, display_path: &str) -> Result<(), String> {
    let buffer = fs::read(file_path).map_err(|error| format!("read failed: {error}"))?;
    let mut offsets = Vec::new();
    let mut search_at = 0;
    while let Some(offset) = find_magic(&buffer, search_at) {
        offsets.push(offset);
        search_at = offset + ZSTD_MAGIC.len();
    }

    let mut rows = Vec::with_capacity(BATCH_ROWS);
    let mut pending = String::new();
    let mut successful_frames = 0_u64;
    let mut failed_frames = 0_u64;
    let mut malformed_lines = 0_u64;

    for (index, start) in offsets.iter().copied().enumerate() {
        let end = offsets.get(index + 1).copied().unwrap_or(buffer.len());
        let Some(decompressed) = decompress_frame(&buffer[start..end]) else {
            failed_frames += 1;
            continue;
        };
        if decompressed.is_empty() {
            failed_frames += 1;
            continue;
        }
        successful_frames += 1;

        let text = String::from_utf8_lossy(&decompressed);
        let combined = format!("{pending}{text}");
        let mut lines = combined.split('\n').collect::<Vec<_>>();
        pending = lines.pop().unwrap_or("").to_string();
        for line in lines {
            parse_and_push(writer, &mut rows, line, &mut malformed_lines)?;
        }
    }

    if successful_frames == 0 {
        return Err(format!(
            "无法解压 DSH 会话日志（{} 个候选帧全部失败）",
            offsets.len()
        ));
    }

    if !pending.trim().is_empty() {
        parse_and_push(writer, &mut rows, &pending, &mut malformed_lines)?;
    }
    flush_rows(writer, &mut rows)?;

    let file_text = display_path;
    if failed_frames > 0 {
        send(
            writer,
            &json!({
                "kind": "warning",
                "text": format!(
                    "DSH 会话日志 {file_text} 有 {failed_frames} 个损坏帧或空帧被跳过"
                ),
            }),
        )?;
    }
    if malformed_lines > 0 {
        send(
            writer,
            &json!({
                "kind": "warning",
                "text": format!(
                    "MALFORMED_JSON:{malformed_lines} DSH 会话日志 {file_text} 有 {malformed_lines} 行 JSON 无法解析被跳过"
                ),
            }),
        )?;
    }
    send(writer, &json!({ "kind": "done" }))
}

fn send_error<W: Write>(writer: &mut W, message: &str) -> Result<(), String> {
    send(writer, &json!({ "kind": "error", "message": message }))
}

fn main() {
    if let Some(file) = std::env::var_os("RUST_DSH_PID_FILE") {
        fs::write(file, std::process::id().to_string()).expect("write experiment helper pid");
    }
    eprintln!("dsh-rust-helper zstd={}", zstd_version());
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Object(request)) => request,
            _ => {
                if send_error(&mut writer, "invalid helper request").is_err() {
                    break;
                }
                continue;
            }
        };
        let file_path_text = match request.get("filePath").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value,
            _ => {
                if send_error(&mut writer, "helper request requires filePath").is_err() {
                    break;
                }
                continue;
            }
        };
        let display_path = request
            .get("displayPath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(file_path_text);
        if let Err(error) = scan_file(&mut writer, Path::new(file_path_text), display_path) {
            if send_error(&mut writer, &error).is_err() {
                break;
            }
        }
    }
}
