import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
} from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const SESSION_ID = "21201ca7-ac0f-4672-9745-084a3dfeb70d";
const MESSAGE_ID = "msg-conflict";
const TIMESTAMP = 1792537466382;
const WORKBUDDY_META_KEY = "history_archive_workbuddy_observations_v1";
const OBSERVATION_COLUMNS = Object.freeze([
  "home_id",
  "message_id",
  "duration_ms",
  "ended_at_ms",
  "capture_version",
  "captured_at",
]);
const SOURCE_IDENTITY_COLUMNS = Object.freeze(["path", "kind", "home_id", "home_label", "home_path"]);

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function usageRecord() {
  return {
    timestamp: TIMESTAMP,
    type: "function_call",
    providerData: {
      messageId: MESSAGE_ID,
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
      },
    },
    sessionId: SESSION_ID,
    cwd: "/work/demo",
  };
}

function traceRow(durationMs) {
  return {
    type: "span_end",
    span: {
      traceId: "trace_1",
      spanId: `span-${durationMs}`,
      name: "generation",
      type: "generation",
      endedAt: "2026-10-21T00:08:56.704Z",
      duration: durationMs,
      status: "ok",
      toolOutput: JSON.stringify([{ id: MESSAGE_ID }]),
    },
  };
}

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function workbuddyMetaValue(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM store_meta WHERE key = ?").get(WORKBUDDY_META_KEY);
    assert.ok(row, `database must contain ${WORKBUDDY_META_KEY}`);
    return String(row.value);
  } finally {
    database.close();
  }
}

function sourceWorkbuddyOracle(database, homeId) {
  const observations = database
    .prepare(
      `SELECT ${OBSERVATION_COLUMNS.join(", ")}
       FROM workbuddy_generation_duration_observations
       WHERE home_id = ?
       ORDER BY home_id, message_id, duration_ms`,
    )
    .all(homeId)
    .map((row) => ({ ...row }));
  const sourceIdentities = database
    .prepare(
      `SELECT ${SOURCE_IDENTITY_COLUMNS.join(", ")}
       FROM source_files
       WHERE kind = 'workbuddy' AND home_id = ?
       ORDER BY path`,
    )
    .all(homeId)
    .map((row) => ({ ...row }));
  return { observations, sourceIdentities };
}

function importedWorkbuddyRows(segmentFile, homeId) {
  const database = new DatabaseSync(segmentFile, { readOnly: true });
  try {
    const observations = database
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS.join(", ")}
         FROM workbuddy_generation_duration_observations
         WHERE home_id = ?
         ORDER BY home_id, message_id, duration_ms`,
      )
      .all(homeId)
      .map((row) => ({ ...row }));
    const sourceIdentities = database
      .prepare(
        `SELECT ${SOURCE_IDENTITY_COLUMNS.join(", ")}
         FROM source_files
         WHERE kind = 'workbuddy' AND home_id = ?
         ORDER BY path`,
      )
      .all(homeId)
      .map((row) => ({ ...row }));
    return { observations, sourceIdentities };
  } finally {
    database.close();
  }
}

test("conflicting WorkBuddy observations survive complete bundle import after source removal", async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "cold-workbuddy-transfer-source-"));
  const importRoot = mkdtempSync(path.join(tmpdir(), "cold-workbuddy-transfer-import-"));
  const homePath = path.join(sourceRoot, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  const sessionFile = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const traceFile = path.join(traceDir, "trace_fixture.jsonl");
  const candidateFile = path.join(sourceRoot, "workbuddy-transfer-candidate.sqlite");
  const bundleDirectory = path.join(importRoot, "published");
  const importDirectory = path.join(importRoot, "imported");
  let store;
  let runtime;
  try {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(sessionFile, jsonl([usageRecord()]));
    writeFileSync(traceFile, jsonl([traceRow(800), traceRow(850)]));

    store = new UsageStore({ homeDir: sourceRoot, databaseFile: path.join(sourceRoot, "index.sqlite") });
    await store.sync({ options: { homeDir: sourceRoot, env: {} } });
    const event = store.database
      .prepare(
        `SELECT events.timestamp_ms, events.home_id, events.source_path
         FROM events
         JOIN source_files ON source_files.path = events.source_path
         WHERE source_files.kind = 'workbuddy' AND events.session_id = ?
         ORDER BY events.timestamp_ms
         LIMIT 1`,
      )
      .get(SESSION_ID);
    assert.ok(event, "fixture must expose a WorkBuddy event for the native observation home");
    assert.equal(path.resolve(String(event.source_path)), path.resolve(sessionFile));
    const homeId = String(event.home_id);
    const startMs = Number(event.timestamp_ms);
    const endMs = startMs + 1;
    const perfSamples = store.database
      .prepare(
        `SELECT sample_key, output_tokens, duration_ms, timing_kind, timing_source, request_count
         FROM perf_samples
         WHERE source_kind = 'workbuddy' AND home_id = ?
         ORDER BY sample_key`,
      )
      .all(homeId)
      .map((row) => ({ ...row }));
    assert.equal(perfSamples.length, 1, "conflicting durations must retain one attributable model row");
    assert.deepEqual(JSON.parse(String(perfSamples[0].sample_key)), ["workbuddy", homeId, MESSAGE_ID]);
    assert.equal(perfSamples[0].duration_ms, null);
    assert.equal(perfSamples[0].timing_kind, "generation");
    assert.equal(perfSamples[0].timing_source, "unknown");
    assert.equal(Number(perfSamples[0].request_count), 1);
    const oracle = sourceWorkbuddyOracle(store.database, homeId);
    assert.deepEqual(
      oracle.observations.map((row) => [row.home_id, row.message_id, row.duration_ms]),
      [
        [homeId, MESSAGE_ID, 800],
        [homeId, MESSAGE_ID, 850],
      ],
      "source SQL must freeze both conflicting native observation primary keys",
    );
    assert.ok(
      oracle.sourceIdentities.some(
        (row) =>
          row.kind === "workbuddy" &&
          row.home_id === homeId &&
          path.resolve(String(row.path)) === path.resolve(sessionFile),
      ),
      "source SQL must freeze the original five-field WorkBuddy identity",
    );

    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
    const candidateMetaBytes = workbuddyMetaValue(candidateFile);
    const candidateDigest = fileSha256(candidateFile);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(registered.databaseSha256, candidateDigest);
    await publishHistoryArchiveBundle(store.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);

    store.close();
    store = undefined;
    rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    assert.equal(existsSync(sourceRoot), false, "the original source tree must be removed");
    for (const identity of oracle.sourceIdentities) {
      assert.equal(existsSync(String(identity.path)), false, `original source ${identity.path} must be gone`);
    }

    const loaded = await loadHistoryArchiveImport(importDirectory);
    runtime = new UsageStore({
      homeDir: importRoot,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      databaseFile: loaded.runtimeFile,
    });
    await runtime.open();
    const segment = runtime.database
      .prepare(
        `SELECT database_path, database_sha256
         FROM archive_segments
         WHERE segment_id = ?`,
      )
      .get(registered.segmentId);
    assert.ok(segment, "the new runtime must register the transferred segment");
    const segmentFile = String(segment.database_path);
    assert.equal(path.relative(importRoot, segmentFile).startsWith(".."), false);
    assert.equal(String(segment.database_sha256), candidateDigest);
    assert.equal(fileSha256(segmentFile), candidateDigest);
    const segmentDigest = fileSha256(segmentFile);

    assert.deepEqual(
      importedWorkbuddyRows(segmentFile, homeId),
      oracle,
      "imported rows must preserve both observation primary keys and the original source identity",
    );
    assert.equal(
      workbuddyMetaValue(segmentFile),
      candidateMetaBytes,
      "the WorkBuddy manifest payload must remain byte-identical",
    );
    assert.equal(
      fileSha256(segmentFile),
      segmentDigest,
      "reading imported native observations must not modify the segment",
    );
  } finally {
    runtime?.close();
    store?.close();
    rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(importRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
