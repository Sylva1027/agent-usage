#![cfg(feature = "sqlite")]

use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct TestServer {
    child: Child,
    base_url: String,
}

struct ResponseData {
    status: u16,
    body: Value,
}

impl TestServer {
    fn launch(database: &Path, web: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_architecture-prototype"))
            .args([
                "--backend",
                "sqlite",
                "--database",
                database.to_str().unwrap(),
                "--port",
                "0",
                "--web",
                web.to_str().unwrap(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.is_empty() {
            let output = child.wait_with_output().unwrap();
            panic!(
                "server exited before readiness: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let startup: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(startup["backend"], "rust-sqlite");
        let port = startup["port"].as_u64().unwrap();
        Self {
            child,
            base_url: format!("127.0.0.1:{port}"),
        }
    }

    fn request(&self, method: &str, route: &str, body: Option<&Value>) -> ResponseData {
        let payload = body.map(serde_json::to_vec).transpose().unwrap();
        let (status, body) = self.request_raw(method, route, payload.as_deref());
        ResponseData {
            status,
            body: serde_json::from_slice(&body).unwrap(),
        }
    }

    fn request_raw(&self, method: &str, route: &str, payload: Option<&[u8]>) -> (u16, Vec<u8>) {
        request_raw_at(&self.base_url, method, route, payload)
    }

    fn get(&self, route: &str) -> ResponseData {
        self.request("GET", route, None)
    }

    fn get_raw(&self, route: &str) -> (u16, Vec<u8>) {
        self.request_raw("GET", route, None)
    }

    fn post(&self, route: &str, body: &Value) -> ResponseData {
        self.request("POST", route, Some(body))
    }

    fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn request_raw_at(
    base_url: &str,
    method: &str,
    route: &str,
    payload: Option<&[u8]>,
) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(base_url).unwrap();
    let mut request =
        format!("{method} {route} HTTP/1.1\r\nHost: {base_url}\r\nConnection: close\r\n");
    if let Some(payload) = payload {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    if let Some(payload) = payload {
        stream.write_all(payload).unwrap();
    }

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let headers = std::str::from_utf8(&raw[..split]).unwrap();
    let status = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, raw[split + 4..].to_vec())
}

fn request_at(base_url: &str, route: &str) -> ResponseData {
    let (status, body) = request_raw_at(base_url, "GET", route, None);
    ResponseData {
        status,
        body: serde_json::from_slice(&body).unwrap(),
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn event(id: &str, timestamp: &str, session: &str, home: &str, total: u64) -> Value {
    json!({
        "eventId": id,
        "timestamp": timestamp,
        "sessionId": session,
        "homeId": home,
        "model": if id == "event-c" { "model-b" } else { "model-a" },
        "channel": "channel-a",
        "cwd": "project-a",
        "repositoryKey": "repository-a",
        "total": {
            "total": total,
            "input": total,
            "cached": 0,
            "output": 0,
            "reasoning": 0
        }
    })
}

fn fixture_events() -> Vec<Value> {
    vec![
        event(
            "event-b",
            "2026-11-01T00:00:00Z",
            "session-shared",
            "home-a",
            10,
        ),
        event(
            "event-a",
            "2026-11-01T00:00:00Z",
            "session-shared",
            "home-b",
            20,
        ),
        event(
            "event-c",
            "2026-11-02T00:00:00Z",
            "session-other",
            "home-a",
            30,
        ),
    ]
}

fn commit_body(events: Vec<Value>) -> Value {
    json!({
        "sourceId": "source-a",
        "events": events,
        "cursor": {"offset": 3},
        "context": {
            "homes": [{"id": "home-a"}, {"id": "home-b"}],
            "sessions": [],
            "warnings": [],
            "rateLimitObservations": [],
            "generatedAt": "2026-11-02T00:00:00Z"
        }
    })
}

fn temp_path(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "architecture-prototype-{label}-{}-{nonce}",
        std::process::id()
    ))
}

fn cleanup_database(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

fn assert_bad_commit(server: &TestServer, body: Value) {
    let response = server.post("/api/commit", &body);
    assert_eq!(response.status, 400, "{}", response.body);
}

#[test]
fn expected_cursor_cas_distinguishes_missing_null_and_exact() {
    let database = temp_path("cas.sqlite");
    let web = temp_path("cas.html");
    cleanup_database(&database);
    fs::write(&web, "<!doctype html><title>prototype</title>").unwrap();

    let server = TestServer::launch(&database, &web);
    let mut create = commit_body(fixture_events());
    create["expectedCursor"] = Value::Null;
    assert_eq!(server.post("/api/commit", &create).status, 200);

    let duplicate_create = server.post("/api/commit", &create);
    assert_eq!(duplicate_create.status, 409);
    assert_eq!(server.get("/api/status").body["revision"], 1);

    let mut mismatch = commit_body(fixture_events());
    mismatch["expectedCursor"] = json!({"offset": 999});
    assert_eq!(server.post("/api/commit", &mismatch).status, 409);
    assert_eq!(server.get("/api/status").body["revision"], 1);

    let mut exact = commit_body(fixture_events());
    exact["expectedCursor"] = json!({"offset": 3});
    let exact_response = server.post("/api/commit", &exact);
    assert_eq!(exact_response.status, 200);
    assert_eq!(exact_response.body["revision"], 2);

    let missing = server.post("/api/commit", &commit_body(fixture_events()));
    assert_eq!(missing.status, 200);
    assert_eq!(missing.body["revision"], 3);

    let mut null_for_existing = commit_body(fixture_events());
    null_for_existing["expectedCursor"] = Value::Null;
    assert_eq!(server.post("/api/commit", &null_for_existing).status, 409);
    assert_eq!(server.get("/api/status").body["revision"], 3);

    let mut new_source = commit_body(vec![event(
        "event-new",
        "2026-11-03T00:00:00Z",
        "session-new",
        "home-c",
        5,
    )]);
    new_source["sourceId"] = json!("source-b");
    new_source["expectedCursor"] = Value::Null;
    let new_source_response = server.post("/api/commit", &new_source);
    assert_eq!(new_source_response.status, 200);
    assert_eq!(new_source_response.body["revision"], 4);

    server.stop();
    cleanup_database(&database);
    let _ = fs::remove_file(web);
}

#[test]
fn changes_feed_covers_increment_empty_snapshot_restart_and_conflicts() {
    let database = temp_path("changes.sqlite");
    let web = temp_path("changes.html");
    cleanup_database(&database);
    fs::write(&web, "<!doctype html><title>prototype</title>").unwrap();

    let mut server = TestServer::launch(&database, &web);
    let empty = server.get("/api/changes");
    assert_eq!(empty.status, 200);
    assert_eq!(empty.body["revision"], 0);
    assert_eq!(empty.body["reset"], true);
    assert!(empty.body["sources"].as_array().unwrap().is_empty());

    assert_eq!(
        server
            .post("/api/commit", &commit_body(fixture_events()))
            .status,
        200
    );
    let full = server.get("/api/changes");
    assert_eq!(full.body["revision"], 1);
    assert_eq!(full.body["reset"], true);
    assert_eq!(full.body["sources"].as_array().unwrap().len(), 1);
    assert_eq!(full.body["sources"][0]["sourceId"], "source-a");
    assert_eq!(
        full.body["sources"][0]["events"].as_array().unwrap().len(),
        3
    );
    assert_eq!(full.body["context"]["generatedAt"], "2026-11-02T00:00:00Z");

    let unchanged = server.get("/api/changes?since=1");
    assert_eq!(unchanged.body["revision"], 1);
    assert_eq!(unchanged.body["reset"], false);
    assert!(unchanged.body["sources"].as_array().unwrap().is_empty());
    let unchanged_context = server.get("/api/changes?since=1&contextSince=1");
    assert!(unchanged_context.body.get("context").is_none());
    assert_eq!(server.get("/api/changes?since=2").status, 400);
    assert_eq!(server.get("/api/changes?since=-1").status, 400);
    assert_eq!(
        server.get("/api/changes?since=1&contextSince=2").status,
        400
    );
    assert_eq!(
        server
            .get("/api/changes?since=1&contextSince=9007199254740992")
            .status,
        400
    );
    assert_eq!(
        server.get("/api/changes?since=9007199254740992").status,
        400
    );

    let mut source_b = commit_body(vec![event(
        "event-source-b",
        "2026-11-03T00:00:00Z",
        "session-source-b",
        "home-c",
        5,
    )]);
    source_b["sourceId"] = json!("source-b");
    source_b["cursor"] = json!({"offset": 9});
    source_b["context"] = json!({"marker": "source-b"});
    let source_b = server.post("/api/commit", &source_b);
    assert_eq!(source_b.status, 200);
    assert_eq!(source_b.body["revision"], 2);

    let increment = server.get("/api/changes?since=1");
    assert_eq!(increment.body["revision"], 2);
    assert_eq!(increment.body["reset"], false);
    assert_eq!(increment.body["sources"].as_array().unwrap().len(), 1);
    assert_eq!(increment.body["sources"][0]["sourceId"], "source-b");
    assert_eq!(increment.body["sources"][0]["cursor"]["offset"], 9);
    assert_eq!(increment.body["context"]["marker"], "source-b");
    let repeat_context = server.get("/api/changes?since=1&contextSince=2");
    assert_eq!(repeat_context.body["revision"], 2);
    assert!(repeat_context.body.get("context").is_none());

    let mut conflict = commit_body(fixture_events());
    conflict["expectedCursor"] = json!({"offset": 999});
    assert_eq!(server.post("/api/commit", &conflict).status, 409);
    let after_conflict = server.get("/api/changes?since=2");
    assert_eq!(after_conflict.body["revision"], 2);
    assert!(
        after_conflict.body["sources"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        server
            .get("/api/changes?since=2&contextSince=2")
            .body
            .get("context")
            .is_none()
    );

    let mut empty_source = commit_body(Vec::new());
    empty_source["cursor"] = json!({"offset": 4});
    empty_source["context"] = json!({"marker": "empty"});
    let empty_source = server.post("/api/commit", &empty_source);
    assert_eq!(empty_source.status, 200);
    assert_eq!(empty_source.body["revision"], 3);

    let empty_increment = server.get("/api/changes?since=2");
    assert_eq!(empty_increment.body["revision"], 3);
    assert_eq!(empty_increment.body["reset"], false);
    assert_eq!(empty_increment.body["sources"].as_array().unwrap().len(), 1);
    assert_eq!(empty_increment.body["sources"][0]["sourceId"], "source-a");
    assert!(
        empty_increment.body["sources"][0]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(empty_increment.body["sources"][0]["cursor"]["offset"], 4);
    assert_eq!(empty_increment.body["context"]["marker"], "empty");

    let frozen = server.post("/api/freeze", &json!({}));
    assert_eq!(frozen.body["snapshot"], 3);
    let frozen_changes = server.get("/api/changes?snapshot=3");
    assert_eq!(frozen_changes.body["revision"], 3);
    assert_eq!(frozen_changes.body["reset"], true);
    assert_eq!(frozen_changes.body["sources"].as_array().unwrap().len(), 2);
    assert!(
        frozen_changes.body["sources"][0]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(server.get("/api/changes?snapshot=3&since=2").status, 400);
    assert_eq!(
        server.get("/api/changes?snapshot=3&contextSince=2").status,
        400
    );
    assert_eq!(server.get("/api/changes?snapshot=999999").status, 404);

    let mut revised_b = commit_body(vec![event(
        "event-source-b-revised",
        "2026-11-04T00:00:00Z",
        "session-source-b",
        "home-c",
        7,
    )]);
    revised_b["sourceId"] = json!("source-b");
    revised_b["cursor"] = json!({"offset": 10});
    revised_b["context"] = json!({"marker": "revised-b"});
    assert_eq!(server.post("/api/commit", &revised_b).status, 200);

    server.stop();
    server = TestServer::launch(&database, &web);
    let restarted = server.get("/api/changes?since=3&contextSince=4");
    assert_eq!(restarted.body["revision"], 4);
    assert_eq!(restarted.body["reset"], true);
    assert_eq!(restarted.body["sources"].as_array().unwrap().len(), 2);
    assert!(restarted.body.get("context").is_some());
    let restarted_current = server.get("/api/changes?since=4");
    assert_eq!(restarted_current.body["reset"], false);
    assert!(
        restarted_current.body["sources"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let mut after_restart = commit_body(vec![event(
        "event-after-restart",
        "2026-11-05T00:00:00Z",
        "session-after-restart",
        "home-a",
        11,
    )]);
    after_restart["cursor"] = json!({"offset": 11});
    assert_eq!(server.post("/api/commit", &after_restart).status, 200);
    let post_restart_delta = server.get("/api/changes?since=4");
    assert_eq!(post_restart_delta.body["revision"], 5);
    assert_eq!(post_restart_delta.body["reset"], false);
    assert_eq!(
        post_restart_delta.body["sources"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        post_restart_delta.body["sources"][0]["sourceId"],
        "source-a"
    );

    server.stop();
    cleanup_database(&database);
    let _ = fs::remove_file(web);
}

#[test]
fn concurrent_expected_cursor_allows_exactly_one_commit() {
    let database = temp_path("cas-concurrent.sqlite");
    let web = temp_path("cas-concurrent.html");
    cleanup_database(&database);
    fs::write(&web, "<!doctype html><title>prototype</title>").unwrap();

    let server = TestServer::launch(&database, &web);
    assert_eq!(
        server
            .post("/api/commit", &commit_body(fixture_events()))
            .status,
        200
    );

    let mut competing = commit_body(fixture_events());
    competing["cursor"] = json!({"offset": 4});
    competing["expectedCursor"] = json!({"offset": 3});
    let payload = serde_json::to_vec(&competing).unwrap();
    let base_url = server.base_url.clone();
    let mut responses = std::thread::scope(|scope| {
        let workers = (0..2)
            .map(|_| {
                let base_url = base_url.clone();
                let payload = payload.clone();
                scope.spawn(move || {
                    let (status, body) =
                        request_raw_at(&base_url, "POST", "/api/commit", Some(&payload));
                    (status, serde_json::from_slice::<Value>(&body).unwrap())
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    responses.sort_by_key(|(status, _)| *status);
    assert_eq!(
        responses
            .iter()
            .map(|(status, _)| *status)
            .collect::<Vec<_>>(),
        vec![200, 409]
    );
    assert!(
        responses[1].1["error"]
            .as_str()
            .unwrap()
            .contains("expectedCursor")
    );
    let report = server.get("/api/report");
    assert_eq!(report.body["revision"], 2);
    assert_eq!(report.body["events"].as_array().unwrap().len(), 3);

    server.stop();
    cleanup_database(&database);
    let _ = fs::remove_file(web);
}

fn assert_concurrent_current_reads(server: &TestServer, revision: u64) {
    let routes = [
        "/api/status",
        "/api/cursors",
        "/api/changes?since=0",
        "/api/report",
        "/api/query",
    ];
    let base_url = server.base_url.clone();
    std::thread::scope(|scope| {
        let workers = (0..24)
            .map(|index| {
                let base_url = base_url.clone();
                let route = routes[index % routes.len()];
                scope.spawn(move || (route, request_at(&base_url, route)))
            })
            .collect::<Vec<_>>();

        for worker in workers {
            let (route, response) = worker.join().unwrap();
            assert_eq!(response.status, 200, "{route}: {}", response.body);
            assert_eq!(response.body["revision"], revision, "{route}");
            match route {
                "/api/status" => assert_eq!(response.body["eventCount"], 3),
                "/api/cursors" => {
                    assert_eq!(response.body["cursors"]["source-a"]["offset"], 3);
                    assert!(response.body.get("events").is_none());
                    assert!(response.body.get("context").is_none());
                }
                "/api/changes?since=0" => {
                    assert_eq!(response.body["sources"].as_array().unwrap().len(), 1);
                    assert_eq!(response.body["sources"][0]["sourceId"], "source-a");
                    assert_eq!(
                        response.body["sources"][0]["events"]
                            .as_array()
                            .unwrap()
                            .len(),
                        3
                    );
                    assert_eq!(response.body["sources"][0]["cursor"]["offset"], 3);
                    assert_eq!(
                        response.body["context"]["generatedAt"],
                        "2026-11-02T00:00:00Z"
                    );
                }
                "/api/report" => {
                    assert_eq!(response.body["events"].as_array().unwrap().len(), 3)
                }
                "/api/query" => {
                    assert_eq!(response.body["eventCount"], 3);
                    assert_eq!(response.body["sessionCount"], 2);
                    assert_eq!(response.body["homeCount"], 2);
                    assert_eq!(response.body["totals"]["total"], 60);
                }
                _ => unreachable!(),
            }
        }
    });
}

#[test]
fn current_reads_use_the_published_memory_state() {
    let database = temp_path("memory.sqlite");
    let web = temp_path("memory.html");
    cleanup_database(&database);
    fs::write(&web, "<!doctype html><title>prototype</title>").unwrap();

    let server = TestServer::launch(&database, &web);
    assert_eq!(
        server
            .post("/api/commit", &commit_body(fixture_events()))
            .status,
        200
    );

    assert_concurrent_current_reads(&server, 1);

    let database_connection = rusqlite::Connection::open(&database).unwrap();
    database_connection
        .execute("UPDATE meta SET revision = 999 WHERE id = 1", [])
        .unwrap();
    drop(database_connection);

    assert_concurrent_current_reads(&server, 1);

    server.stop();
    cleanup_database(&database);
    let _ = fs::remove_file(web);
}

#[test]
fn sql_failure_does_not_publish() {
    let database = temp_path("failure.sqlite");
    let web = temp_path("failure.html");
    cleanup_database(&database);
    fs::write(&web, "<!doctype html><title>prototype</title>").unwrap();

    let server = TestServer::launch(&database, &web);
    let original_events = fixture_events();
    assert_eq!(
        server
            .post("/api/commit", &commit_body(original_events.clone()))
            .status,
        200
    );
    let before_report = server.get("/api/report").body;
    let before_status = server.get("/api/status").body;

    let database_connection = rusqlite::Connection::open(&database).unwrap();
    database_connection
        .execute_batch(
            "CREATE TRIGGER fail_source_event
             BEFORE INSERT ON source_events
             BEGIN
               SELECT RAISE(ABORT, 'forced test failure');
             END;",
        )
        .unwrap();
    drop(database_connection);

    let failed = server.post(
        "/api/commit",
        &commit_body(vec![original_events[0].clone()]),
    );
    assert_eq!(failed.status, 500);
    assert_eq!(server.get("/api/report").body, before_report);
    assert_eq!(server.get("/api/status").body, before_status);

    server.stop();
    cleanup_database(&database);
    let _ = fs::remove_file(web);
}

#[test]
fn http_contract_freezes_survives_restart_and_rejects_failures() {
    let database = temp_path("core.sqlite");
    let web = temp_path("core.html");
    cleanup_database(&database);
    fs::write(&web, "<!doctype html><title>prototype</title>").unwrap();

    let mut server = TestServer::launch(&database, &web);
    assert_eq!(server.get("/api/health").body["ok"], true);
    let (web_status, web_body) = server.get_raw("/");
    assert_eq!(web_status, 200);
    assert_eq!(web_body, b"<!doctype html><title>prototype</title>");

    let original_events = fixture_events();
    let committed = server.post("/api/commit", &commit_body(original_events.clone()));
    assert_eq!(committed.status, 200);
    assert_eq!(committed.body["revision"], 1);
    assert_eq!(committed.body["eventCount"], 3);

    let status = server.get("/api/status");
    assert_eq!(status.status, 200);
    assert_eq!(status.body["revision"], 1);
    assert_eq!(status.body["eventCount"], 3);

    let cursors = server.get("/api/cursors");
    assert_eq!(cursors.status, 200);
    assert_eq!(cursors.body["revision"], 1);
    assert_eq!(cursors.body["cursors"]["source-a"]["offset"], 3);
    assert!(cursors.body.get("events").is_none());
    assert!(cursors.body.get("context").is_none());

    let report = server.get("/api/report");
    assert_eq!(report.status, 200);
    assert_eq!(report.body["events"][0]["eventId"], "event-a");
    assert_eq!(report.body["events"][1]["eventId"], "event-b");
    assert_eq!(report.body["cursors"]["source-a"]["offset"], 3);

    let query = server.get("/api/query");
    assert_eq!(query.body["eventCount"], 3);
    assert_eq!(query.body["sessionCount"], 2);
    assert_eq!(query.body["homeCount"], 2);
    assert_eq!(query.body["totals"]["total"], 60);
    assert_eq!(query.body["timeline"][0]["name"], "2026-11-01");
    assert_eq!(query.body["timeline"][1]["name"], "2026-11-02");
    assert_eq!(query.body["projects"][0]["sessions"], 2);

    let filtered = server.get(
        "/api/query?start=2026-11-01T00%3A00%3A00Z&end=2026-11-01T00%3A00%3A00Z&excludeHomes=home-b",
    );
    assert_eq!(filtered.body["eventCount"], 1);
    assert_eq!(filtered.body["totals"]["total"], 10);

    let frozen = server.post("/api/freeze", &json!({}));
    assert_eq!(frozen.body["snapshot"], 1);

    let replacement = vec![original_events[0].clone(), original_events[1].clone()];
    let revised = server.post("/api/commit", &commit_body(replacement));
    assert_eq!(revised.body["revision"], 2);
    assert_eq!(
        server.get("/api/report").body["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        server.get("/api/report?snapshot=1").body["events"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    let before_failures = server.get("/api/report").body;
    let mut unsafe_event = original_events[0].clone();
    unsafe_event["total"]["input"] = json!(9_007_199_254_740_992_u64);
    assert_bad_commit(&server, commit_body(vec![unsafe_event]));

    let mut negative_event = original_events[0].clone();
    negative_event["total"]["input"] = json!(-1);
    assert_bad_commit(&server, commit_body(vec![negative_event]));

    let mut invalid_timestamp = original_events[0].clone();
    invalid_timestamp["timestamp"] = json!("not-a-time");
    assert_bad_commit(&server, commit_body(vec![invalid_timestamp]));

    let mut empty_home = original_events[0].clone();
    empty_home["homeId"] = json!("");
    assert_bad_commit(&server, commit_body(vec![empty_home]));

    assert_bad_commit(
        &server,
        commit_body(vec![original_events[0].clone(), original_events[0].clone()]),
    );
    let mut empty_source = commit_body(original_events);
    empty_source["sourceId"] = json!("");
    assert_bad_commit(&server, empty_source);
    assert_eq!(server.get("/api/report").body, before_failures);
    assert_eq!(server.get("/api/status").body["revision"], 2);
    assert_eq!(server.get("/api/report?snapshot=999999999").status, 404);

    server.stop();
    server = TestServer::launch(&database, &web);
    assert_eq!(server.get("/api/report").body, before_failures);
    assert_eq!(
        server.get("/api/cursors").body["cursors"]["source-a"]["offset"],
        3
    );
    assert_eq!(
        server.get("/api/report?snapshot=1").body["events"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    let empty = server.post(
        "/api/commit",
        &json!({"sourceId": "empty-source", "events": [], "cursor": {}}),
    );
    assert_eq!(empty.status, 200);
    assert_eq!(empty.body["eventCount"], 2);
    assert_eq!(
        server.get("/api/report").body["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    server.stop();
    cleanup_database(&database);
    let _ = fs::remove_file(web);
}
