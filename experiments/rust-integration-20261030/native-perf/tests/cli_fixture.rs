use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn fixture_matches_perf_kernel_contract_and_writes_pid_immediately() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/small.ndjson");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let pid_file =
        std::env::temp_dir().join(format!("native-perf-{}-{nonce}.pid", std::process::id()));

    let child = Command::new(env!("CARGO_BIN_EXE_native-perf"))
        .args(["--input"])
        .arg(&fixture)
        .args(["--pid-file"])
        .arg(&pid_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn native-perf");
    let child_pid = child.id().to_string();
    let output = child.wait_with_output().expect("wait for native-perf");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read_to_string(&pid_file).expect("pid file"), child_pid);
    let _ = fs::remove_file(pid_file);

    let raw = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(
        raw.starts_with("{\"groups\":"),
        "stdout prefix: {:?}",
        raw.chars().take(80).collect::<String>()
    );
    let result: Value = serde_json::from_str(&raw).expect("output JSON");

    let groups = result["groups"].as_array().expect("groups");
    assert_eq!(groups.len(), 4);
    assert_eq!(groups[0]["model"], "B");
    assert_eq!(groups[0]["n"], 2);
    assert_eq!(groups[0]["rank"], Value::Null);
    assert_eq!(groups[0]["insufficientSamples"], false);
    assert_eq!(groups[1]["model"], "Z");
    assert_eq!(groups[2]["model"], "A");
    assert_eq!(groups[2]["n"], 2);
    assert_eq!(groups[2]["rank"], 1);
    assert_eq!(groups[3]["model"], "O");
    assert_eq!(groups[3]["state"], "overflow");
    assert_eq!(groups[3]["tps"]["p50"], Value::Null);

    let coverage = &result["coverage"];
    assert_eq!(coverage["eligible"], 13);
    assert_eq!(coverage["positiveOutput"], 13);
    assert_eq!(coverage["timedPositiveOutput"], 11);
    assert_eq!(coverage["completeTimedPositiveOutput"], 10);
    assert_eq!(coverage["sampled"], 7);
    assert_eq!(coverage["dropped"], 5);
    assert_eq!(coverage["pending"], 1);
    assert_eq!(coverage["unplaced"], 1);
    assert_eq!(coverage["byEra"], Value::Null);
    assert_eq!(coverage["byFlag"]["PARTIAL_ITEM_SPAN"], 1);
    assert_eq!(coverage["byFlag"]["MISSING_DURATION"], 2);
    assert_eq!(coverage["byFlag"]["RECORD_CONFLICT"], 1);
    assert_eq!(
        coverage["droppedByReason"]["duration_missing_nonpositive_invalid"],
        2
    );
    assert_eq!(coverage["droppedByReason"]["source_semantics_mismatch"], 1);
    assert_eq!(coverage["bySource"]["codex"]["eligible"], 9);
    assert_eq!(coverage["bySource"]["codex"]["unplaced"], 1);
    assert_eq!(
        coverage["bySource"]["codex"]["byEra"]["recent"]["sampled"],
        3
    );
    assert_eq!(
        coverage["bySource"]["codex"]["byEra"]["legacy"]["sampled"],
        1
    );
    assert_eq!(coverage["byGroup"]["(unkeyed)"]["dropped"], 1);
    let group_a = coverage["byGroup"]
        .as_object()
        .expect("byGroup")
        .iter()
        .find(|(key, _)| key.contains("\"A\""))
        .map(|(_, value)| value)
        .expect("group A coverage");
    assert_eq!(group_a["eligible"], 3);
    assert_eq!(group_a["sampled"], 2);
    assert_eq!(group_a["dropped"], 1);

    let timing = &result["codexTimingCoverage"];
    assert_eq!(timing["methodVersion"], "tps-v4");
    assert_eq!(timing["recordedOutputTokens"], 653);
    assert_eq!(timing["sampledOutputTokens"], 402);
    assert_eq!(timing["unknownOutputCandidates"], 0);
    assert_eq!(timing["counts"]["eligible"], 9);
    assert_eq!(timing["counts"]["sampled"], 4);
    assert_eq!(timing["counts"]["dropped"], 4);
    assert_eq!(timing["counts"]["pending"], 1);
    assert_eq!(timing["counts"]["unplaced"], 1);

    let models = result["models"].as_array().expect("models");
    assert_eq!(
        models
            .iter()
            .map(|model| model["model"].as_str().expect("model name"))
            .collect::<Vec<_>>(),
        ["A", "B", "Z", "O", "M"]
    );
    assert_eq!(models[0]["rankState"], "eligible");
    assert_eq!(models[0]["rank"], 1);
    assert_eq!(models[0].get("candidateCount"), None);
    assert_eq!(models[1]["rankState"], "unverified");
    assert_eq!(models[2]["rankState"], "insufficient_samples");
    assert_eq!(models[3]["rankState"], "overflow");
    assert_eq!(models[4]["state"], "missing_duration");
    assert_eq!(models[4]["candidateCount"], 1);

    let warnings = result["meta"]["sourceWarnings"]
        .as_array()
        .expect("warnings");
    assert_eq!(warnings.len(), 3);
    assert_eq!(warnings[0]["code"], "AGGREGATE_OVERFLOW");
    assert_eq!(warnings[1]["code"], "UNKEYABLE_RECORD");
    assert_eq!(warnings[2]["code"], "MALFORMED_JSON");
}
