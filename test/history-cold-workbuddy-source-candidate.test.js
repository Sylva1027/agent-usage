import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const SESSION_ID = "21201ca7-ac0f-4672-9745-084a3dfeb70d";
const MESSAGE_ID = "msg-conflict";
const TIMESTAMP = 1792537466382;

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

function workbuddyDurationSnapshot(database) {
  const observations = database
    .prepare(
      `SELECT home_id, message_id, duration_ms, ended_at_ms, capture_version, captured_at
       FROM workbuddy_generation_duration_observations
       ORDER BY home_id, message_id, duration_ms`,
    )
    .all()
    .map((row) => ({ ...row }));
  const homeIds = [...new Set(observations.map((row) => String(row.home_id)))];
  const sourceFiles = database
    .prepare(
      `SELECT path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at
       FROM source_files
       WHERE kind = 'workbuddy' AND home_id IN (${homeIds.map(() => "?").join(",")})
       ORDER BY path`,
    )
    .all(...homeIds)
    .map((row) => ({ ...row }));
  const perfSampleKeys = database
    .prepare("SELECT sample_key FROM perf_samples WHERE source_kind = 'workbuddy' ORDER BY sample_key")
    .all()
    .map((row) => String(row.sample_key));
  const perfSamples = database
    .prepare(
      `SELECT sample_key, output_tokens, duration_ms, timing_kind, timing_source, request_count
       FROM perf_samples
       WHERE source_kind = 'workbuddy'
       ORDER BY sample_key`,
    )
    .all()
    .map((row) => ({ ...row }));
  return { observations, sourceFiles, perfSampleKeys, perfSamples };
}

test("cold WorkBuddy duration observations survive in an archive candidate", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cold-workbuddy-duration-"));
  const homePath = path.join(root, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  const candidateFile = path.join(root, "cold-workbuddy-candidate.sqlite");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), jsonl([usageRecord()]));
  writeFileSync(path.join(traceDir, "trace_fixture.jsonl"), jsonl([traceRow(800), traceRow(850)]));

  const options = { homeDir: root, env: {} };
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "index.sqlite") });
  try {
    await store.sync({ options });
    const sourceBefore = workbuddyDurationSnapshot(store.database);
    assert.deepEqual(
      sourceBefore.observations.map((row) => [row.message_id, row.duration_ms]),
      [
        [MESSAGE_ID, 800],
        [MESSAGE_ID, 850],
      ],
      "the real source must retain both conflicting native duration observations",
    );
    for (const homeId of new Set(sourceBefore.observations.map((row) => String(row.home_id)))) {
      assert.ok(
        sourceBefore.sourceFiles.some((row) => String(row.home_id) === homeId),
        `WorkBuddy observation home ${homeId} must retain a source identity`,
      );
    }
    assert.equal(sourceBefore.perfSamples.length, 1, "conflicting durations must retain one attributable model row");
    assert.equal(sourceBefore.perfSamples[0].output_tokens, null);
    assert.equal(sourceBefore.perfSamples[0].duration_ms, null);
    assert.equal(sourceBefore.perfSamples[0].timing_kind, "generation");
    assert.equal(sourceBefore.perfSamples[0].timing_source, "unknown");
    assert.equal(Number(sourceBefore.perfSamples[0].request_count), 1);
    const sourceSampleKey = JSON.parse(sourceBefore.perfSamples[0].sample_key);
    assert.equal(sourceSampleKey[0], "workbuddy");
    assert.equal(sourceSampleKey[2], MESSAGE_ID);

    const startMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs: startMs + 1 });
    const sourceAfter = workbuddyDurationSnapshot(store.database);
    assert.deepEqual(sourceAfter, sourceBefore, "candidate creation must not mutate the source duration facts");

    const digestBefore = fileSha256(candidateFile);
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateSnapshot;
    try {
      candidateSnapshot = workbuddyDurationSnapshot(candidate);
    } finally {
      candidate.close();
    }
    assert.deepEqual(
      candidateSnapshot,
      sourceAfter,
      "the candidate must preserve native WorkBuddy observations and the missing-generation model row",
    );
    assert.equal(fileSha256(candidateFile), digestBefore, "reading the candidate must not modify it");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
