mod model;
mod storage;

use model::{ExpectedCursor, Filters, ModelError, PreparedSource, PublishedState, ValidatedCommit};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::storage::{Source, State, Storage};

const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const WORKER_COUNT: usize = 4;
type HttpResponse = Response<std::io::Cursor<Vec<u8>>>;

#[derive(Debug)]
struct Config {
    backend: String,
    database: PathBuf,
    port: u16,
    web: Option<Vec<u8>>,
}

#[derive(Debug)]
enum HttpError {
    BadRequest(String),
    Conflict(String),
    NotFound(String),
    Internal(String),
}

impl HttpError {
    fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode(400),
            Self::Conflict(_) => StatusCode(409),
            Self::NotFound(_) => StatusCode(404),
            Self::Internal(_) => StatusCode(500),
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::BadRequest(message)
            | Self::Conflict(message)
            | Self::NotFound(message)
            | Self::Internal(message) => message,
        }
    }
}

#[derive(Serialize)]
struct Startup {
    port: u16,
    backend: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitResponse {
    revision: u64,
    event_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    revision: u64,
    event_count: u64,
}

#[derive(Serialize)]
struct FreezeResponse {
    snapshot: u64,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    backend: &'static str,
}

#[derive(Debug)]
enum QueryPayload {
    Backend(serde_json::Value),
    Native(model::QueryResponse),
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn StdError>> {
    let config = parse_args()?;
    let mut store = storage::open(&config.backend, &config.database)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let loaded = store
        .load(None)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let current =
        PublishedState::new(loaded).map_err(|error| io::Error::other(error.to_string()))?;
    let store = Arc::new(Mutex::new(store));
    let current = Arc::new(RwLock::new(current));
    let web = Arc::new(config.web);
    let server = Server::http(("127.0.0.1", config.port)).map_err(|error| {
        io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            format!("failed to listen on 127.0.0.1:{}: {error}", config.port),
        )
    })?;
    let address = server.server_addr().to_ip().ok_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "HTTP server is not on IP")
    })?;
    let backend = backend_label(&config.backend);
    println!(
        "{}",
        serde_json::to_string(&Startup {
            port: address.port(),
            backend,
        })?
    );
    io::stdout().flush()?;

    let keep_running = Arc::new(AtomicBool::new(true));
    let signal_flag = Arc::clone(&keep_running);
    ctrlc::set_handler(move || signal_flag.store(false, Ordering::SeqCst))?;

    let server = Arc::new(server);
    let worker_error = Arc::new(Mutex::new(None));
    let mut workers = Vec::new();
    for _ in 0..WORKER_COUNT {
        let worker_server = Arc::clone(&server);
        let worker_store = Arc::clone(&store);
        let worker_current = Arc::clone(&current);
        let worker_web = Arc::clone(&web);
        let worker_running = Arc::clone(&keep_running);
        let worker_error = Arc::clone(&worker_error);
        workers.push(thread::spawn(move || {
            while worker_running.load(Ordering::SeqCst) {
                match worker_server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => {
                        handle_request(
                            request,
                            &worker_store,
                            &worker_current,
                            backend,
                            worker_web.as_ref().as_deref(),
                        );
                    }
                    Ok(None) => {}
                    Err(error) if worker_running.load(Ordering::SeqCst) => {
                        *worker_error
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(error.to_string());
                        worker_running.store(false, Ordering::SeqCst);
                    }
                    Err(_) => break,
                }
            }
        }));
    }
    while keep_running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(200));
    }
    for worker in workers {
        if worker.join().is_err() {
            eprintln!("request worker panicked");
        }
    }
    if let Some(error) = worker_error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        return Err(Box::new(io::Error::other(error)));
    }
    Ok(())
}

fn parse_args() -> Result<Config, Box<dyn StdError>> {
    let mut backend = None;
    let mut database = None;
    let mut port = None;
    let mut web_path = None;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        let mut value = |flag: &str| {
            arguments
                .next()
                .ok_or_else(|| format!("{flag} requires a value"))
        };
        match argument.as_str() {
            "--backend" => backend = Some(value("--backend")?),
            "--database" => database = Some(PathBuf::from(value("--database")?)),
            "--port" => {
                let raw = value("--port")?;
                port =
                    Some(raw.parse::<u16>().map_err(|_| {
                        format!("invalid --port value {raw:?}; expected 0..=65535")
                    })?);
            }
            "--web" => web_path = Some(PathBuf::from(value("--web")?)),
            other => return Err(format!("unknown argument {other:?}").into()),
        }
    }

    let backend = backend.ok_or("missing --backend sqlite|redb|duckdb")?;
    if !matches!(backend.as_str(), "sqlite" | "redb" | "duckdb") {
        return Err(format!("unsupported backend {backend:?}").into());
    }
    let web = web_path.map(std::fs::read).transpose()?;
    Ok(Config {
        backend,
        database: database.ok_or("missing --database <path>")?,
        port: port.ok_or("missing --port <0..=65535>")?,
        web,
    })
}

fn backend_label(backend: &str) -> &'static str {
    match backend {
        "sqlite" => "rust-sqlite",
        "redb" => "rust-redb",
        "duckdb" => "rust-duckdb",
        _ => unreachable!("backend was validated by parse_args"),
    }
}

fn handle_request(
    mut request: Request,
    store: &Mutex<Box<dyn Storage>>,
    current: &RwLock<PublishedState>,
    backend: &'static str,
    web: Option<&[u8]>,
) {
    let response =
        route(&mut request, store, current, backend, web).unwrap_or_else(http_error_response);
    if let Err(error) = request.respond(response) {
        eprintln!("response write failed: {error}");
    }
}

fn route(
    request: &mut Request,
    store: &Mutex<Box<dyn Storage>>,
    current: &RwLock<PublishedState>,
    backend: &'static str,
    web: Option<&[u8]>,
) -> Result<HttpResponse, HttpError> {
    let url = request.url().to_owned();
    let (path, query) = url
        .split_once('?')
        .map_or((url.as_str(), ""), |(path, query)| (path, query));
    let is_get = request.method() == &Method::Get;
    let is_post = request.method() == &Method::Post;

    if is_get && path == "/api/health" {
        return json_response(StatusCode(200), &HealthResponse { ok: true, backend });
    }
    if is_get && path == "/api/status" {
        let state = read_current(current);
        let response = StatusResponse {
            revision: state.revision(),
            event_count: state.event_count().map_err(internal_model_error)?,
        };
        drop(state);
        return json_response(StatusCode(200), &response);
    }
    if is_get && path == "/api/cursors" {
        let state = read_current(current);
        let response = model::cursors(&state);
        drop(state);
        return json_response(StatusCode(200), &response);
    }
    if is_get && path == "/api/changes" {
        let parameters = parse_query(query)?;
        let since = parameters
            .get("since")
            .map(|value| parse_since(value))
            .transpose()?;
        let context_since = parameters
            .get("contextSince")
            .map(|value| parse_context_since(value))
            .transpose()?;
        let snapshot = parameters
            .get("snapshot")
            .map(|value| {
                value.parse::<u64>().map_err(|_| {
                    HttpError::BadRequest("snapshot must be an unsigned integer".into())
                })
            })
            .transpose()?;
        if since.is_some() && snapshot.is_some() {
            return Err(HttpError::BadRequest(
                "since and snapshot cannot be combined".into(),
            ));
        }
        if context_since.is_some() && snapshot.is_some() {
            return Err(HttpError::BadRequest(
                "contextSince and snapshot cannot be combined".into(),
            ));
        }
        if let Some(snapshot) = snapshot {
            let state = load_snapshot(store, snapshot)?;
            let state = PublishedState::new(state).map_err(internal_model_error)?;
            return json_response(
                StatusCode(200),
                &model::changes(&state, None).map_err(model_error)?,
            );
        }
        let state = read_current(current);
        let response =
            model::changes_with_context(&state, since, context_since).map_err(model_error)?;
        drop(state);
        return json_response(StatusCode(200), &response);
    }
    if is_get && path == "/api/report" {
        let filters = parse_filters(query)?;
        if let Some(snapshot) = filters.snapshot {
            let state = load_snapshot(store, snapshot)?;
            let state = PublishedState::new(state).map_err(internal_model_error)?;
            return json_response(
                StatusCode(200),
                &model::report(&state, &filters).map_err(internal_model_error)?,
            );
        }
        let state = read_current(current);
        let response = model::report(&state, &filters).map_err(internal_model_error)?;
        drop(state);
        return json_response(StatusCode(200), &response);
    }
    if is_get && path == "/api/query" {
        let filters = parse_filters(query)?;
        if let Some(snapshot) = filters.snapshot {
            let state = load_snapshot(store, snapshot)?;
            let state = PublishedState::new(state).map_err(internal_model_error)?;
            return json_response(
                StatusCode(200),
                &model::query(&state, &filters).map_err(internal_model_error)?,
            );
        }
        return match query_current_payload(store, current, &filters)? {
            QueryPayload::Backend(response) => json_response(StatusCode(200), &response),
            QueryPayload::Native(response) => json_response(StatusCode(200), &response),
        };
    }
    if is_post && path == "/api/commit" {
        let body = read_body(request)?;
        let commit = model::parse_commit(&body).map_err(model_error)?;
        return commit_response(store, current, commit);
    }
    if is_post && path == "/api/freeze" {
        let snapshot = lock_store(store).freeze().map_err(storage_error)?;
        return json_response(StatusCode(200), &FreezeResponse { snapshot });
    }
    if is_get && path == "/" {
        return web
            .map(static_response)
            .ok_or_else(|| HttpError::NotFound("web page is not configured".into()));
    }

    Err(HttpError::NotFound(format!("unknown route {path}")))
}

fn query_current_payload(
    store: &Mutex<Box<dyn Storage>>,
    current: &RwLock<PublishedState>,
    filters: &Filters,
) -> Result<QueryPayload, HttpError> {
    let start_ms = filters
        .start
        .as_ref()
        .map(|timestamp| timestamp.timestamp_millis());
    let end_ms = filters
        .end
        .as_ref()
        .map(|timestamp| timestamp.timestamp_millis());
    let mut excluded_homes = filters.exclude_homes.iter().cloned().collect::<Vec<_>>();
    excluded_homes.sort();

    let backend_response = {
        let mut store = lock_store(store);
        store
            .query_current(start_ms, end_ms, &excluded_homes)
            .map_err(storage_error)?
    };
    if let Some(response) = backend_response {
        return Ok(QueryPayload::Backend(response));
    }

    let state = read_current(current);
    let response = model::query(&state, filters).map_err(internal_model_error)?;
    drop(state);
    Ok(QueryPayload::Native(response))
}

fn commit_response(
    store: &Mutex<Box<dyn Storage>>,
    current: &RwLock<PublishedState>,
    commit: ValidatedCommit,
) -> Result<HttpResponse, HttpError> {
    let mut store = lock_store(store);
    {
        let current = read_current(current);
        let matches = match &commit.expected_cursor {
            ExpectedCursor::Any => true,
            ExpectedCursor::Absent => current.cursor(&commit.source_id).is_none(),
            ExpectedCursor::Exact(expected) => current.cursor(&commit.source_id) == Some(expected),
        };
        if !matches {
            return Err(HttpError::Conflict(format!(
                "expectedCursor conflict for source {}",
                commit.source_id
            )));
        }
    }
    let source = Source {
        events: commit.events,
        cursor: commit.cursor,
    };
    let prepared = PreparedSource::new(&commit.source_id, source).map_err(internal_model_error)?;
    let revision = store
        .commit_delta(
            &commit.source_id,
            prepared.source(),
            commit.context.as_ref(),
        )
        .map_err(storage_error)?;
    let published = {
        let previous = read_current(current);
        PublishedState::from_prepared_commit(
            revision,
            &commit.source_id,
            prepared,
            commit.context,
            &previous,
        )
        .map_err(internal_model_error)?
    };
    let revision = published.revision();
    let event_count = published.event_count().map_err(internal_model_error)?;
    *write_current(current) = published;
    drop(store);
    json_response(
        StatusCode(200),
        &CommitResponse {
            revision,
            event_count,
        },
    )
}

fn load_snapshot(store: &Mutex<Box<dyn Storage>>, snapshot: u64) -> Result<State, HttpError> {
    lock_store(store).load(Some(snapshot)).map_err(|error| {
        if error_is_not_found(error.as_ref()) {
            HttpError::NotFound(error.to_string())
        } else {
            storage_error(error)
        }
    })
}

fn lock_store(store: &Mutex<Box<dyn Storage>>) -> MutexGuard<'_, Box<dyn Storage>> {
    store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_current(current: &RwLock<PublishedState>) -> RwLockReadGuard<'_, PublishedState> {
    current
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_current(current: &RwLock<PublishedState>) -> RwLockWriteGuard<'_, PublishedState> {
    current
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_body(request: &mut Request) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| HttpError::BadRequest(format!("failed to read request body: {error}")))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(HttpError::BadRequest(format!(
            "request body exceeds {MAX_BODY_BYTES} bytes"
        )));
    }
    Ok(body)
}

fn parse_filters(query: &str) -> Result<Filters, HttpError> {
    let parameters = parse_query(query)?;
    let start = parameters
        .get("start")
        .map(|value| model::parse_timestamp(value).map_err(model_error))
        .transpose()?;
    let end = parameters
        .get("end")
        .map(|value| model::parse_timestamp(value).map_err(model_error))
        .transpose()?;
    let snapshot = parameters
        .get("snapshot")
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| HttpError::BadRequest("snapshot must be an unsigned integer".into()))
        })
        .transpose()?;
    let exclude_homes = parameters
        .get("excludeHomes")
        .map(|value| {
            value
                .split(',')
                .filter(|home| !home.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    Ok(Filters {
        start,
        end,
        exclude_homes,
        snapshot,
    })
}

fn parse_since(value: &str) -> Result<u64, HttpError> {
    parse_revision_parameter(value, "since")
}

fn parse_context_since(value: &str) -> Result<u64, HttpError> {
    parse_revision_parameter(value, "contextSince")
}

fn parse_revision_parameter(value: &str, name: &str) -> Result<u64, HttpError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(HttpError::BadRequest(format!(
            "{name} must be a non-negative safe integer"
        )));
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= model::MAX_SAFE_INTEGER)
        .ok_or_else(|| HttpError::BadRequest(format!("{name} must be a non-negative safe integer")))
}

fn parse_query(query: &str) -> Result<HashMap<String, String>, HttpError> {
    let mut parameters = HashMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(key)?;
        let value = percent_decode(value)?;
        parameters.insert(key, value);
    }
    Ok(parameters)
}

fn percent_decode(value: &str) -> Result<String, HttpError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err(HttpError::BadRequest(
                        "truncated percent escape in query".into(),
                    ));
                }
                let high = hex(bytes[index + 1])?;
                let low = hex(bytes[index + 2])?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| HttpError::BadRequest("query is not valid UTF-8".into()))
}

fn hex(byte: u8) -> Result<u8, HttpError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(HttpError::BadRequest(
            "invalid percent escape in query".into(),
        )),
    }
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Result<HttpResponse, HttpError> {
    let body = serde_json::to_vec(value)
        .map_err(|error| HttpError::Internal(format!("failed to serialize response: {error}")))?;
    let content_type = Header::from_bytes("Content-Type", "application/json; charset=utf-8")
        .expect("static content type");
    let no_store = Header::from_bytes("Cache-Control", "no-store").expect("static cache header");
    Ok(Response::from_data(body)
        .with_status_code(status)
        .with_header(content_type)
        .with_header(no_store))
}

fn static_response(body: &[u8]) -> HttpResponse {
    let content_type = Header::from_bytes("Content-Type", "text/html; charset=utf-8")
        .expect("static content type");
    Response::from_data(body.to_vec()).with_header(content_type)
}

fn http_error_response(error: HttpError) -> HttpResponse {
    let status = error.status();
    let body = serde_json::to_vec(&json!({ "error": error.message() }))
        .unwrap_or_else(|_| b"{\"error\":\"internal error\"}".to_vec());
    let content_type = Header::from_bytes("Content-Type", "application/json; charset=utf-8")
        .expect("static content type");
    let no_store = Header::from_bytes("Cache-Control", "no-store").expect("static cache header");
    Response::from_data(body)
        .with_status_code(status)
        .with_header(content_type)
        .with_header(no_store)
}

fn model_error(error: ModelError) -> HttpError {
    match error {
        ModelError::Invalid(message) => HttpError::BadRequest(message),
        ModelError::Internal(message) => HttpError::Internal(message),
    }
}

fn internal_model_error(error: ModelError) -> HttpError {
    HttpError::Internal(error.to_string())
}

fn storage_error(error: Box<dyn StdError + Send + Sync>) -> HttpError {
    HttpError::Internal(error.to_string())
}

fn error_is_not_found(mut error: &(dyn StdError + 'static)) -> bool {
    loop {
        if let Some(io_error) = error.downcast_ref::<io::Error>() {
            if io_error.kind() == io::ErrorKind::NotFound {
                return true;
            }
        }
        let message = error.to_string().to_ascii_lowercase();
        if message.contains("not found")
            || (message.contains("snapshot")
                && (message.contains("does not exist") || message.contains("missing")))
        {
            return true;
        }
        match error.source() {
            Some(source) => error = source,
            None => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{Condvar, mpsc};

    struct BlockingSnapshotStorage {
        entered: mpsc::Sender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    struct PublishingStorage {
        commit_entered: mpsc::Sender<()>,
        release_commit: Arc<(Mutex<bool>, Condvar)>,
        current: Arc<RwLock<PublishedState>>,
        frozen_revision: mpsc::Sender<u64>,
    }

    struct BackendQueryStorage {
        observed_filters: mpsc::Sender<(Option<i64>, Option<i64>, Vec<String>)>,
        response: Option<serde_json::Value>,
    }

    impl Storage for BlockingSnapshotStorage {
        fn load(&mut self, snapshot: Option<u64>) -> storage::StoreResult<State> {
            if snapshot.is_some() {
                self.entered.send(()).unwrap();
                let (lock, condition) = &*self.release;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = condition.wait(released).unwrap();
                }
            }
            Ok(State::default())
        }

        fn commit(
            &mut self,
            _source_id: &str,
            _source: &Source,
            _context: Option<&serde_json::Value>,
        ) -> storage::StoreResult<State> {
            unreachable!("commit is not used by this test")
        }

        fn freeze(&mut self) -> storage::StoreResult<u64> {
            unreachable!("freeze is not used by this test")
        }
    }

    impl Storage for PublishingStorage {
        fn load(&mut self, _snapshot: Option<u64>) -> storage::StoreResult<State> {
            unreachable!("load is not used by this test")
        }

        fn commit(
            &mut self,
            _source_id: &str,
            _source: &Source,
            _context: Option<&serde_json::Value>,
        ) -> storage::StoreResult<State> {
            self.commit_entered.send(()).unwrap();
            let (lock, condition) = &*self.release_commit;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = condition.wait(released).unwrap();
            }
            Ok(State {
                revision: 2,
                ..State::default()
            })
        }

        fn freeze(&mut self) -> storage::StoreResult<u64> {
            let revision = read_current(&self.current).revision();
            self.frozen_revision.send(revision).unwrap();
            Ok(revision)
        }
    }

    impl Storage for BackendQueryStorage {
        fn load(&mut self, _snapshot: Option<u64>) -> storage::StoreResult<State> {
            unreachable!("load is not used by this test")
        }

        fn commit(
            &mut self,
            _source_id: &str,
            _source: &Source,
            _context: Option<&serde_json::Value>,
        ) -> storage::StoreResult<State> {
            unreachable!("commit is not used by this test")
        }

        fn freeze(&mut self) -> storage::StoreResult<u64> {
            unreachable!("freeze is not used by this test")
        }

        fn query_current(
            &mut self,
            start_ms: Option<i64>,
            end_ms: Option<i64>,
            excluded_homes: &[String],
        ) -> storage::StoreResult<Option<serde_json::Value>> {
            self.observed_filters
                .send((start_ms, end_ms, excluded_homes.to_vec()))
                .unwrap();
            Ok(self.response.clone())
        }
    }

    #[test]
    fn backend_query_uses_utc_millis_filters_and_returns_directly() {
        let (observed_tx, observed_rx) = mpsc::channel();
        let expected = serde_json::json!({
            "revision": 7,
            "eventCount": 1,
            "sessionCount": 1,
            "homeCount": 1,
            "totals": {"total": 1, "input": 1, "cached": 0, "output": 0, "reasoning": 0},
            "models": [],
            "channels": [],
            "projects": [],
            "repositories": [],
            "timeline": []
        });
        let store = Arc::new(Mutex::new(Box::new(BackendQueryStorage {
            observed_filters: observed_tx,
            response: Some(expected.clone()),
        }) as Box<dyn Storage>));
        let current = Arc::new(RwLock::new(
            PublishedState::new(State {
                revision: 99,
                ..State::default()
            })
            .unwrap(),
        ));
        let filters = Filters {
            start: Some(model::parse_timestamp("2026-11-01T00:00:00Z").unwrap()),
            end: Some(model::parse_timestamp("2026-11-02T00:00:00Z").unwrap()),
            exclude_homes: HashSet::from(["home-b".into(), "home-a".into()]),
            snapshot: None,
        };

        match query_current_payload(&store, &current, &filters).unwrap() {
            QueryPayload::Backend(actual) => assert_eq!(actual, expected),
            QueryPayload::Native(_) => panic!("backend query unexpectedly used native fallback"),
        }
        let (start_ms, end_ms, excluded_homes) =
            observed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            start_ms,
            Some(
                model::parse_timestamp("2026-11-01T00:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
        assert_eq!(
            end_ms,
            Some(
                model::parse_timestamp("2026-11-02T00:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
        assert_eq!(
            excluded_homes,
            vec!["home-a".to_owned(), "home-b".to_owned()]
        );
    }

    #[test]
    fn native_query_fallback_releases_store_before_reading_current() {
        let (observed_tx, observed_rx) = mpsc::channel();
        let store = Arc::new(Mutex::new(Box::new(BackendQueryStorage {
            observed_filters: observed_tx,
            response: None,
        }) as Box<dyn Storage>));
        let current = Arc::new(RwLock::new(
            PublishedState::new(State {
                revision: 7,
                ..State::default()
            })
            .unwrap(),
        ));
        let current_guard = write_current(&current);

        let query_store = Arc::clone(&store);
        let query_current = Arc::clone(&current);
        let worker = thread::spawn(move || {
            query_current_payload(&query_store, &query_current, &Filters::default())
        });
        observed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("backend query did not run");

        let mut released = false;
        for _ in 0..500 {
            if store.try_lock().is_ok() {
                released = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            released,
            "native fallback must release the store lock before reading current"
        );

        drop(current_guard);
        match worker.join().unwrap().unwrap() {
            QueryPayload::Native(response) => assert_eq!(response.revision, 7),
            QueryPayload::Backend(_) => panic!("None backend response used the backend path"),
        }
    }

    #[test]
    fn blocked_snapshot_load_does_not_block_current_reads() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let store = Arc::new(Mutex::new(Box::new(BlockingSnapshotStorage {
            entered: entered_tx,
            release: Arc::clone(&release),
        }) as Box<dyn Storage>));
        let current = Arc::new(RwLock::new(
            PublishedState::new(State {
                revision: 7,
                ..State::default()
            })
            .unwrap(),
        ));

        let snapshot_store = Arc::clone(&store);
        let snapshot_worker =
            thread::spawn(move || lock_store(&snapshot_store).load(Some(1)).unwrap());
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("snapshot load did not start");

        let revision = {
            let state = read_current(&current);
            let result = model::query(&state, &Filters::default()).unwrap();
            result.revision
        };

        let (lock, condition) = &*release;
        *lock.lock().unwrap() = true;
        condition.notify_all();
        snapshot_worker.join().unwrap();
        assert_eq!(revision, 7);
    }

    #[test]
    fn freeze_waits_for_commit_to_publish_the_same_revision() {
        let (commit_entered_tx, commit_entered_rx) = mpsc::channel();
        let (freeze_attempted_tx, freeze_attempted_rx) = mpsc::channel();
        let (frozen_revision_tx, frozen_revision_rx) = mpsc::channel();
        let release_commit = Arc::new((Mutex::new(false), Condvar::new()));
        let current = Arc::new(RwLock::new(
            PublishedState::new(State {
                revision: 1,
                ..State::default()
            })
            .unwrap(),
        ));
        let store = Arc::new(Mutex::new(Box::new(PublishingStorage {
            commit_entered: commit_entered_tx,
            release_commit: Arc::clone(&release_commit),
            current: Arc::clone(&current),
            frozen_revision: frozen_revision_tx,
        }) as Box<dyn Storage>));

        let commit_store = Arc::clone(&store);
        let commit_current = Arc::clone(&current);
        let commit_worker = thread::spawn(move || {
            commit_response(
                &commit_store,
                &commit_current,
                ValidatedCommit {
                    source_id: "source-a".into(),
                    events: Vec::new(),
                    cursor: serde_json::Value::Null,
                    context: None,
                    expected_cursor: ExpectedCursor::Any,
                },
            )
            .unwrap();
        });
        commit_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("commit did not enter storage");

        let freeze_store = Arc::clone(&store);
        let freeze_worker = thread::spawn(move || {
            freeze_attempted_tx.send(()).unwrap();
            lock_store(&freeze_store).freeze().unwrap()
        });
        freeze_attempted_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("freeze did not start");

        let (lock, condition) = &*release_commit;
        *lock.lock().unwrap() = true;
        condition.notify_all();
        commit_worker.join().unwrap();
        assert_eq!(freeze_worker.join().unwrap(), 2);
        assert_eq!(
            frozen_revision_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("freeze did not record a revision"),
            2
        );
        assert_eq!(read_current(&current).revision(), 2);
    }
}
