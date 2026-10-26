import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const SESSION_ID = "21201ca7-ac0f-4672-9745-084a3dfeb70d";
const MESSAGE_ID = "msg-conflict";
const TIMESTAMP = 1792537466382;
const WORKBUDDY_META_KEY = "history_archive_workbuddy_observations_v1";
const WORKBUDDY_MISMATCH_CODE = "HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH";
const WORKBUDDY_BAD_METADATA_CODE = "HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_BAD_METADATA";
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

function tableEvidence(table, columns, rows, startMs, endMs) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ table, startMs, endMs, columns }));
  hash.update("\n");
  for (const row of rows) {
    hash.update(JSON.stringify(Object.fromEntries(columns.map((column) => [column, row[column]]))));
    hash.update("\n");
  }
  return { rows: rows.length, sha256: hash.digest("hex") };
}

function sourceWorkbuddyManifest(database, startMs, endMs) {
  const eventHomes = database
    .prepare(
      `SELECT DISTINCT events.home_id
       FROM events
       JOIN source_files ON source_files.path = events.source_path
       WHERE events.timestamp_ms >= ? AND events.timestamp_ms < ?
         AND source_files.kind = 'workbuddy'
       ORDER BY events.home_id`,
    )
    .all(startMs, endMs)
    .map((row) => String(row.home_id));
  const perfHomes = database
    .prepare(
      `SELECT DISTINCT home_id
       FROM perf_samples
       WHERE ts_ms >= ? AND ts_ms < ? AND source_kind = 'workbuddy'
       ORDER BY home_id`,
    )
    .all(startMs, endMs)
    .map((row) => String(row.home_id));
  const homeIds = [...new Set([...eventHomes, ...perfHomes])].sort();
  assert.ok(homeIds.length > 0, "cold range must reference at least one WorkBuddy home");
  const placeholders = homeIds.map(() => "?").join(",");
  const observations = database
    .prepare(
      `SELECT ${OBSERVATION_COLUMNS.join(", ")}
       FROM workbuddy_generation_duration_observations
       WHERE home_id IN (${placeholders})
       ORDER BY home_id, message_id, duration_ms`,
    )
    .all(...homeIds)
    .map((row) => ({ ...row }));
  const sourceFiles = database
    .prepare(
      `SELECT ${SOURCE_IDENTITY_COLUMNS.join(", ")}
       FROM source_files
       WHERE kind = 'workbuddy' AND home_id IN (${placeholders})
       ORDER BY path`,
    )
    .all(...homeIds)
    .map((row) => ({ ...row }));
  return {
    homeIds,
    observations,
    sourceFiles,
    evidence: {
      formatVersion: 1,
      startMs,
      endMs,
      scope: "referenced-homes",
      tables: {
        workbuddy_generation_duration_observations: tableEvidence(
          "workbuddy_generation_duration_observations",
          OBSERVATION_COLUMNS,
          observations,
          startMs,
          endMs,
        ),
        source_files: tableEvidence("source_files", SOURCE_IDENTITY_COLUMNS, sourceFiles, startMs, endMs),
      },
    },
  };
}

async function copyDatabase(sourceFile, destinationFile) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, destinationFile);
  } finally {
    source.close();
  }
}

async function repackCandidate(sourceFile, workingFile, destinationFile, mutate) {
  await copyDatabase(sourceFile, workingFile);
  const working = new DatabaseSync(workingFile);
  try {
    mutate(working);
  } finally {
    working.close();
  }
  const repackSource = new DatabaseSync(workingFile, { readOnly: true });
  try {
    await createHistoryBackup(repackSource, destinationFile);
  } finally {
    repackSource.close();
  }
  assert.equal((await verifyHistoryBackup(destinationFile)).ok, true);
}

function metaValue(file, key) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  } finally {
    database.close();
  }
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test("candidate seals referenced WorkBuddy observations and rejects drift", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cold-workbuddy-manifest-write-"));
  const homePath = path.join(root, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  const sessionFile = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const candidateFile = path.join(root, "cold-workbuddy-write-candidate.sqlite");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(sessionFile, jsonl([usageRecord()]));
  writeFileSync(path.join(traceDir, "trace_fixture.jsonl"), jsonl([traceRow(800), traceRow(850)]));

  const options = { homeDir: root, env: {} };
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "index.sqlite") });
  try {
    await store.sync({ options });
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
    assert.ok(event, "fixture must expose a cold WorkBuddy usage event");
    assert.equal(path.resolve(String(event.source_path)), path.resolve(sessionFile));
    const startMs = Number(event.timestamp_ms);
    const endMs = startMs + 1;
    const perfSampleCount = Number(
      store.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM perf_samples
           WHERE source_kind = 'workbuddy' AND home_id = ?`,
        )
        .get(event.home_id).count,
    );
    assert.equal(perfSampleCount, 0, "the conflict fixture must reference its home through events, not perf samples");
    const oracle = sourceWorkbuddyManifest(store.database, startMs, endMs);
    assert.deepEqual(oracle.homeIds, [String(event.home_id)]);
    assert.deepEqual(
      oracle.observations.map((row) => [row.message_id, row.duration_ms]),
      [
        [MESSAGE_ID, 800],
        [MESSAGE_ID, 850],
      ],
      "the oracle must include every conflicting observation for the referenced home",
    );
    assert.ok(
      oracle.sourceFiles.some((row) => path.resolve(String(row.path)) === path.resolve(sessionFile)),
      "the oracle must include the five-column identity of the cold source",
    );

    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
    assert.equal((await verifyHistoryArchiveCandidate(candidateFile)).ok, true);
    assert.deepEqual(
      JSON.parse(metaValue(candidateFile, WORKBUDDY_META_KEY)),
      oracle.evidence,
      "candidate WorkBuddy metadata must match the independent source SQL oracle",
    );

    const tamperedFile = path.join(root, "cold-workbuddy-write-tampered.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(root, "cold-workbuddy-write-tampered-work.sqlite"),
      tamperedFile,
      (database) => {
        const changed = database
          .prepare(
            `UPDATE workbuddy_generation_duration_observations
             SET duration_ms = 801
             WHERE home_id = ? AND message_id = ? AND duration_ms = 800`,
          )
          .run(event.home_id, MESSAGE_ID);
        assert.equal(Number(changed.changes), 1);
      },
    );
    await assert.rejects(() => verifyHistoryArchiveCandidate(tamperedFile), expectCode(WORKBUDDY_MISMATCH_CODE));

    const badFormatFile = path.join(root, "cold-workbuddy-write-bad-format.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(root, "cold-workbuddy-write-bad-format-work.sqlite"),
      badFormatFile,
      (database) => {
        const evidence = JSON.parse(metaValue(candidateFile, WORKBUDDY_META_KEY));
        evidence.formatVersion = 2;
        database
          .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
          .run(JSON.stringify(evidence), WORKBUDDY_META_KEY);
      },
    );
    await assert.rejects(() => verifyHistoryArchiveCandidate(badFormatFile), expectCode(WORKBUDDY_BAD_METADATA_CODE));

    const legacyFile = path.join(root, "cold-workbuddy-write-legacy.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(root, "cold-workbuddy-write-legacy-work.sqlite"),
      legacyFile,
      (database) => {
        database.prepare("DELETE FROM store_meta WHERE key = ?").run(WORKBUDDY_META_KEY);
      },
    );
    assert.equal((await verifyHistoryArchiveCandidate(legacyFile)).ok, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
