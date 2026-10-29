use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, c_char, c_void};
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::Instant;

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Parser,
    Semantic,
}

impl Mode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "parser" => Some(Self::Parser),
            "semantic" => Some(Self::Semantic),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Parser => "parser",
            Self::Semantic => "semantic",
        }
    }
}

#[derive(Default)]
struct ParserAggregates {
    usage_input_tokens: u64,
    usage_cached_tokens: u64,
    usage_cache_write_tokens: u64,
    usage_output_tokens: u64,
    usage_total_tokens: u64,
}

impl ParserAggregates {
    fn add(&mut self, other: &Self) {
        self.usage_input_tokens += other.usage_input_tokens;
        self.usage_cached_tokens += other.usage_cached_tokens;
        self.usage_cache_write_tokens += other.usage_cache_write_tokens;
        self.usage_output_tokens += other.usage_output_tokens;
        self.usage_total_tokens += other.usage_total_tokens;
    }

    fn json(&self) -> Value {
        json!({
            "usageInputTokens": self.usage_input_tokens,
            "usageCachedTokens": self.usage_cached_tokens,
            "usageCacheWriteTokens": self.usage_cache_write_tokens,
            "usageOutputTokens": self.usage_output_tokens,
            "usageTotalTokens": self.usage_total_tokens,
        })
    }
}

#[derive(Default)]
struct FileSummary {
    path: String,
    bytes: u64,
    rows: u64,
    usage_rows: u64,
    nonzero_usage_events: u64,
    stream_items: u64,
    header_rows: u64,
    parser: ParserAggregates,
    warnings: Vec<String>,
    digest: Option<String>,
    trace: Vec<Value>,
    field_trace: Option<Value>,
}

#[derive(Default)]
struct RowState {
    header: Option<Value>,
    model: String,
    model_provider: String,
    conversation_name: String,
}

fn put_len(hasher: &mut Sha256, len: u64) {
    hasher.update(len.to_be_bytes());
}

fn put_string(hasher: &mut Sha256, value: &str) {
    hasher.update([b's']);
    put_len(hasher, value.len() as u64);
    hasher.update(value.as_bytes());
}

fn put_value(hasher: &mut Sha256, value: &Value) {
    match value {
        Value::Null => hasher.update([b'n']),
        Value::Bool(value) => {
            hasher.update([b'b']);
            hasher.update([u8::from(*value)]);
        }
        Value::Number(value) => {
            hasher.update([b'f']);
            let number = value.as_f64().unwrap_or(f64::NAN);
            hasher.update(number.to_bits().to_be_bytes());
        }
        Value::String(value) => put_string(hasher, value),
        Value::Array(values) => {
            hasher.update([b'a']);
            put_len(hasher, values.len() as u64);
            for value in values {
                put_value(hasher, value);
            }
        }
        Value::Object(values) => {
            hasher.update([b'o']);
            put_len(hasher, values.len() as u64);
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort();
            for key in keys {
                put_string(hasher, key);
                put_value(hasher, &values[key]);
            }
        }
    }
}

fn put_field(hasher: &mut Sha256, value: Option<&Value>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            put_value(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn data_value<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get("data")?.get(key)
}

fn string_field(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) | Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn truthy_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(value)) if value.as_f64() == Some(0.0) => String::new(),
        Some(Value::String(value)) if value.is_empty() => String::new(),
        Some(value) => string_field(Some(value)).trim().to_string(),
    }
}

fn numeric(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|value| value.is_finite())
}

fn non_negative_int(value: Option<&Value>) -> i64 {
    numeric(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or(0)
}

fn non_negative_u64(value: Option<&Value>) -> u64 {
    numeric(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.floor() as u64)
        .unwrap_or(0)
}

fn normalized_session_header(row: &Value) -> Value {
    json!({
        "id": truthy_string(row.get("id")),
        "version": numeric(row.get("version")),
        "cwd": truthy_string(row.get("cwd")),
        "delegationDepth": non_negative_int(row.get("delegationDepth")),
        "createdAtMs": numeric(row.get("createdAt")),
        "agentPreset": truthy_string(row.get("agentPreset")),
    })
}

fn mapped_usage(raw: &Value) -> Value {
    let input_tokens = non_negative_int(raw.get("inputTokens"));
    let cache_read_tokens = non_negative_int(raw.get("cacheReadTokens"));
    let cache_write_tokens = non_negative_int(raw.get("cacheWriteTokens"));
    let output_tokens = non_negative_int(raw.get("outputTokens"));
    let input = input_tokens + cache_read_tokens + cache_write_tokens;
    let total = numeric(raw.get("totalTokens"))
        .map(|value| value.floor() as i64)
        .unwrap_or(input + output_tokens);
    json!({
        "total": total,
        "input": input,
        "cached": cache_read_tokens,
        "output": output_tokens,
        "reasoning": 0,
        "cacheWriteTokens": cache_write_tokens,
        "requestInputTokens": input,
    })
}

fn update_row_state(row: &Value, state: &mut RowState) {
    let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
    let data = row.get("data");
    if row_type == "session" && state.header.is_none() {
        state.header = Some(normalized_session_header(row));
    }
    if row_type == "request/header" || row_type == "request/context" {
        let config = data
            .and_then(|value| value.get("header"))
            .and_then(|value| value.get("config"));
        let model = config
            .and_then(|value| value.get("model"))
            .filter(|value| truthy_string(Some(value)).len() > 0)
            .or_else(|| data.and_then(|value| value.get("model")))
            .map(|value| truthy_string(Some(value)))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| state.model.clone());
        let provider = config
            .and_then(|value| value.get("provider"))
            .filter(|value| truthy_string(Some(value)).len() > 0)
            .or_else(|| data.and_then(|value| value.get("provider")))
            .map(|value| truthy_string(Some(value)))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| state.model_provider.clone());
        state.model = model;
        state.model_provider = provider;
    }
    if row_type == "session/title" {
        let title = truthy_string(data_value(row, "title"));
        if !title.is_empty() {
            state.conversation_name = if title.chars().count() > 120 {
                format!("{}…", title.chars().take(120).collect::<String>())
            } else {
                title
            };
        }
    }
}

fn update_projection(
    hasher: &mut Sha256,
    row: &Value,
    state: &RowState,
) -> (bool, bool, u64, bool) {
    put_string(hasher, "row");
    put_field(hasher, row.get("type"));
    put_field(hasher, row.get("seq"));
    put_field(hasher, row.get("time"));
    put_field(hasher, row.get("surfaceOp"));
    put_field(hasher, row.get("sourceEventSeqs"));
    put_field(hasher, data_value(row, "header"));
    put_field(hasher, data_value(row, "usage"));
    put_field(hasher, data_value(row, "stream"));
    put_field(hasher, data_value(row, "title"));
    put_field(hasher, data_value(row, "messageSeqs"));
    put_field(hasher, data_value(row, "turn"));
    put_field(hasher, data_value(row, "step"));
    put_field(hasher, state.header.as_ref());
    put_string(hasher, &state.model);
    put_string(hasher, &state.model_provider);
    put_string(hasher, &state.conversation_name);

    let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
    let usage = data_value(row, "usage").filter(|value| is_truthy(value));
    let mapped = if row_type == "assistant/message" {
        usage.map(mapped_usage)
    } else {
        None
    };
    put_field(hasher, mapped.as_ref());
    let turn = data_value(row, "turn").map(|value| Value::from(non_negative_int(Some(value))));
    let step = data_value(row, "step").map(|value| Value::from(non_negative_int(Some(value))));
    put_field(hasher, turn.as_ref());
    put_field(hasher, step.as_ref());

    let stream_items = data_value(row, "stream")
        .and_then(Value::as_array)
        .map(|values| values.len() as u64)
        .unwrap_or(0);
    let nonzero_event = mapped.as_ref().is_some_and(|value| {
        ["total", "input", "cached", "output", "reasoning"]
            .iter()
            .any(|key| value[*key].as_i64().unwrap_or(0) != 0)
            && numeric(row.get("time")).is_some()
    });
    let has_usage = row_type == "assistant/message" && usage.is_some();
    let has_header =
        row_type == "session" || row_type == "request/header" || row_type == "request/context";
    (has_usage, nonzero_event, stream_items, has_header)
}

fn accumulate_parser_row(
    row: &Value,
    aggregates: &mut ParserAggregates,
) -> (bool, bool, u64, bool) {
    let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
    let usage = data_value(row, "usage").filter(|value| is_truthy(value));
    let has_usage = row_type == "assistant/message" && usage.is_some();
    let mut nonzero_event = false;

    if let Some(raw) = usage.filter(|_| has_usage) {
        let input_tokens = non_negative_u64(raw.get("inputTokens"));
        let cache_read_tokens = non_negative_u64(raw.get("cacheReadTokens"));
        let cache_write_tokens = non_negative_u64(raw.get("cacheWriteTokens"));
        let output_tokens = non_negative_u64(raw.get("outputTokens"));
        let input = input_tokens + cache_read_tokens + cache_write_tokens;
        let total = numeric(raw.get("totalTokens"))
            .map(|value| value.floor() as u64)
            .unwrap_or(input + output_tokens);
        aggregates.usage_input_tokens += input;
        aggregates.usage_cached_tokens += cache_read_tokens;
        aggregates.usage_cache_write_tokens += cache_write_tokens;
        aggregates.usage_output_tokens += output_tokens;
        aggregates.usage_total_tokens += total;
        nonzero_event = [total, input, cache_read_tokens, output_tokens]
            .iter()
            .any(|value| *value != 0)
            && numeric(row.get("time")).is_some();
    }

    let stream_items = data_value(row, "stream")
        .and_then(Value::as_array)
        .map(|values| values.len() as u64)
        .unwrap_or(0);
    let has_header =
        row_type == "session" || row_type == "request/header" || row_type == "request/context";
    (has_usage, nonzero_event, stream_items, has_header)
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

fn component_digest(label: &str, value: Option<&Value>) -> String {
    let mut hasher = Sha256::new();
    put_string(&mut hasher, label);
    put_field(&mut hasher, value);
    format!("{:x}", hasher.finalize())
}

fn field_trace(row: &Value, state: &RowState) -> Value {
    let data = row.get("data");
    let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
    let usage = data.and_then(|value| value.get("usage"));
    let mapped = if row_type == "assistant/message" && usage.is_some_and(is_truthy) {
        usage.map(mapped_usage)
    } else {
        None
    };
    json!({
        "type": component_digest("type", row.get("type")),
        "seq": component_digest("seq", row.get("seq")),
        "time": component_digest("time", row.get("time")),
        "surfaceOp": component_digest("surfaceOp", row.get("surfaceOp")),
        "sourceEventSeqs": component_digest("sourceEventSeqs", row.get("sourceEventSeqs")),
        "header": component_digest("header", data.and_then(|value| value.get("header"))),
        "header.config": component_digest("header.config", data.and_then(|value| value.get("header")).and_then(|value| value.get("config"))),
        "header.adapterDefaults": component_digest("header.adapterDefaults", data.and_then(|value| value.get("header")).and_then(|value| value.get("adapterDefaults"))),
        "header.tools": component_digest("header.tools", data.and_then(|value| value.get("header")).and_then(|value| value.get("tools"))),
        "usage": component_digest("usage", usage),
        "stream": component_digest("stream", data.and_then(|value| value.get("stream"))),
        "title": component_digest("title", data.and_then(|value| value.get("title"))),
        "messageSeqs": component_digest("messageSeqs", data.and_then(|value| value.get("messageSeqs"))),
        "turn": component_digest("turn", data.and_then(|value| value.get("turn"))),
        "step": component_digest("step", data.and_then(|value| value.get("step"))),
        "stateHeader": component_digest("stateHeader", state.header.as_ref()),
        "model": component_digest("model", Some(&Value::String(state.model.clone()))),
        "modelProvider": component_digest("modelProvider", Some(&Value::String(state.model_provider.clone()))),
        "conversationName": component_digest("conversationName", Some(&Value::String(state.conversation_name.clone()))),
        "mappedUsage": component_digest("mappedUsage", mapped.as_ref()),
    })
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        Value::Bool(true) => true,
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

fn summary_path(root: Option<&Path>, path: &Path) -> String {
    if let Some(root) = root
        && let Ok(relative) = path.strip_prefix(root)
    {
        return relative.to_string_lossy().replace('\\', "/");
    }
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn summarize_file(
    root: Option<&Path>,
    path: &Path,
    mode: Mode,
    trace_limit: usize,
    field_trace_row: u64,
) -> Result<FileSummary, String> {
    let buffer = fs::read(path).map_err(|error| format!("read failed: {error}"))?;
    let mut offsets = Vec::new();
    let mut search_at = 0;
    while let Some(offset) = find_magic(&buffer, search_at) {
        offsets.push(offset);
        search_at = offset + ZSTD_MAGIC.len();
    }

    let mut hasher = (mode == Mode::Semantic).then(Sha256::new);
    if let Some(hasher) = &mut hasher {
        hasher.update(b"dsh-rust-parsing-20261029\0");
    }
    let mut pending = String::new();
    let mut state = RowState::default();
    let mut parser = ParserAggregates::default();
    let mut successful_frames = 0_u64;
    let mut failed_frames = 0_u64;
    let mut malformed_lines = 0_u64;
    let mut rows = 0_u64;
    let mut usage_rows = 0_u64;
    let mut nonzero_usage_events = 0_u64;
    let mut stream_items = 0_u64;
    let mut header_rows = 0_u64;
    let mut trace = Vec::new();
    let mut field_trace_value = None;

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
        let mut parts: Vec<&str> = combined.split('\n').collect();
        pending = parts.pop().unwrap_or("").to_string();
        for line in parts {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(line) else {
                malformed_lines += 1;
                continue;
            };
            let row = black_box(row);
            let (has_usage, nonzero_event, row_stream_items, has_header) =
                accumulate_parser_row(&row, &mut parser);
            if let Some(hasher) = &mut hasher {
                update_row_state(&row, &mut state);
                update_projection(hasher, &row, &state);
            }
            rows += 1;
            usage_rows += u64::from(has_usage);
            nonzero_usage_events += u64::from(nonzero_event);
            stream_items += row_stream_items;
            header_rows += u64::from(has_header);
            if let Some(hasher) = &mut hasher {
                if trace.len() < trace_limit {
                    trace.push(json!({
                        "row": rows,
                        "digest": format!("{:x}", hasher.clone().finalize()),
                    }));
                }
                if rows == field_trace_row {
                    field_trace_value = Some(field_trace(&row, &state));
                }
            }
        }
    }

    if successful_frames == 0 {
        return Err(format!(
            "无法解压 DSH 会话日志（{} 个候选帧全部失败）",
            offsets.len()
        ));
    }

    if !pending.trim().is_empty() {
        match serde_json::from_str::<Value>(&pending) {
            Ok(row) => {
                let row = black_box(row);
                let (has_usage, nonzero_event, row_stream_items, has_header) =
                    accumulate_parser_row(&row, &mut parser);
                if let Some(hasher) = &mut hasher {
                    update_row_state(&row, &mut state);
                    update_projection(hasher, &row, &state);
                }
                rows += 1;
                usage_rows += u64::from(has_usage);
                nonzero_usage_events += u64::from(nonzero_event);
                stream_items += row_stream_items;
                header_rows += u64::from(has_header);
                if let Some(hasher) = &mut hasher {
                    if trace.len() < trace_limit {
                        trace.push(json!({
                            "row": rows,
                            "digest": format!("{:x}", hasher.clone().finalize()),
                        }));
                    }
                    if rows == field_trace_row {
                        field_trace_value = Some(field_trace(&row, &state));
                    }
                }
            }
            Err(_) => malformed_lines += 1,
        }
    }

    let mut warnings = Vec::new();
    if failed_frames > 0 {
        warnings.push(format!(
            "DSH 会话日志 <file> 有 {failed_frames} 个损坏帧或空帧被跳过"
        ));
    }
    if malformed_lines > 0 {
        warnings.push(format!(
            "MALFORMED_JSON:{malformed_lines} DSH 会话日志 <file> 有 {malformed_lines} 行 JSON 无法解析被跳过"
        ));
    }
    if let Some(hasher) = &mut hasher {
        put_string(hasher, "warnings");
        for warning in &warnings {
            put_string(hasher, warning);
        }
    }

    Ok(FileSummary {
        path: summary_path(root, path),
        bytes: buffer.len() as u64,
        rows,
        usage_rows,
        nonzero_usage_events,
        stream_items,
        header_rows,
        parser,
        warnings,
        digest: hasher.map(|hasher| format!("{:x}", hasher.finalize())),
        trace,
        field_trace: field_trace_value,
    })
}

fn is_session_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !name.starts_with("session.v") || !name.ends_with(".jsonl.zstd") {
        return false;
    }
    let version = &name["session.v".len()..name.len() - ".jsonl.zstd".len()];
    !version.is_empty() && version.bytes().all(|value| value.is_ascii_digit())
}

fn collect_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("read_dir failed: {error}"))? {
        let entry = entry.map_err(|error| format!("read_dir entry failed: {error}"))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| format!("file_type failed: {error}"))?;
        if kind.is_dir() {
            collect_files(&path, output)?;
        } else if kind.is_file() && is_session_file(&path) {
            output.push(path);
        }
    }
    Ok(())
}

fn file_json(summary: &FileSummary) -> Value {
    let mut value = json!({
        "path": summary.path,
        "bytes": summary.bytes,
        "rows": summary.rows,
        "usageRows": summary.usage_rows,
        "nonzeroUsageEvents": summary.nonzero_usage_events,
        "streamItems": summary.stream_items,
        "headerRows": summary.header_rows,
        "parser": summary.parser.json(),
        "warnings": summary.warnings,
    });
    if let Some(digest) = &summary.digest {
        value["digest"] = Value::String(digest.clone());
    }
    if !summary.trace.is_empty() {
        value["trace"] = Value::Array(summary.trace.clone());
    }
    if let Some(field_trace) = &summary.field_trace {
        value["fieldTrace"] = field_trace.clone();
    }
    value
}

fn main() {
    let started = Instant::now();
    let mut root: Option<PathBuf> = None;
    let mut files: Vec<PathBuf> = Vec::new();
    let mut startup = false;
    let mut mode = Mode::Semantic;
    let mut trace_limit = 0_usize;
    let mut field_trace_row = 0_u64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--startup" => startup = true,
            "--mode" => {
                let Some(value) = args.next() else {
                    eprintln!("--mode requires parser or semantic");
                    std::process::exit(2);
                };
                let Some(parsed) = Mode::parse(&value) else {
                    eprintln!("invalid mode: {value}");
                    std::process::exit(2);
                };
                mode = parsed;
            }
            "--root" => root = args.next().map(PathBuf::from),
            "--file" => {
                if let Some(path) = args.next() {
                    files.push(PathBuf::from(path));
                }
            }
            "--trace-limit" => {
                trace_limit = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
            }
            "--field-trace-row" => {
                field_trace_row = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    if startup {
        println!(
            "{}",
            json!({
                "engine": "rust",
                "startup": true,
                "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
                "zstdVersion": zstd_version(),
            })
        );
        return;
    }

    let (root_for_paths, files) = if let Some(root) = root {
        let mut discovered = Vec::new();
        if let Err(error) = collect_files(&root, &mut discovered) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        discovered.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
        (Some(root), discovered)
    } else {
        (None, files)
    };

    let mut summaries = Vec::with_capacity(files.len());
    for file in &files {
        match summarize_file(
            root_for_paths.as_deref(),
            file,
            mode,
            trace_limit,
            field_trace_row,
        ) {
            Ok(summary) => summaries.push(file_json(&summary)),
            Err(error) => summaries.push(json!({
                "path": summary_path(root_for_paths.as_deref(), file),
                "error": error,
            })),
        }
    }

    let totals = {
        let mut totals = Map::new();
        totals.insert("files".to_string(), json!(summaries.len()));
        totals.insert(
            "rows".to_string(),
            json!(
                summaries
                    .iter()
                    .map(|value| value["rows"].as_u64().unwrap_or(0))
                    .sum::<u64>()
            ),
        );
        totals.insert(
            "usageRows".to_string(),
            json!(
                summaries
                    .iter()
                    .map(|value| value["usageRows"].as_u64().unwrap_or(0))
                    .sum::<u64>()
            ),
        );
        totals.insert(
            "nonzeroUsageEvents".to_string(),
            json!(
                summaries
                    .iter()
                    .map(|value| value["nonzeroUsageEvents"].as_u64().unwrap_or(0))
                    .sum::<u64>()
            ),
        );
        totals.insert(
            "streamItems".to_string(),
            json!(
                summaries
                    .iter()
                    .map(|value| value["streamItems"].as_u64().unwrap_or(0))
                    .sum::<u64>()
            ),
        );
        let mut parser = ParserAggregates::default();
        for summary in &summaries {
            if let Some(values) = summary.get("parser") {
                parser.add(&ParserAggregates {
                    usage_input_tokens: values["usageInputTokens"].as_u64().unwrap_or(0),
                    usage_cached_tokens: values["usageCachedTokens"].as_u64().unwrap_or(0),
                    usage_cache_write_tokens: values["usageCacheWriteTokens"].as_u64().unwrap_or(0),
                    usage_output_tokens: values["usageOutputTokens"].as_u64().unwrap_or(0),
                    usage_total_tokens: values["usageTotalTokens"].as_u64().unwrap_or(0),
                });
            }
        }
        totals.insert("parser".to_string(), parser.json());
        totals.insert(
            "errors".to_string(),
            json!(
                summaries
                    .iter()
                    .filter(|value| value.get("error").is_some())
                    .count()
            ),
        );
        Value::Object(totals)
    };

    println!(
        "{}",
        json!({
            "engine": "rust",
            "mode": mode.as_str(),
            "zstdVersion": zstd_version(),
            "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
            "totals": totals,
            "files": summaries,
        })
    );
}
