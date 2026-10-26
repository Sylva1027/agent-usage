import assert from "node:assert/strict";
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
const WORKBUDDY_MISMATCH_CODE = "HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH";

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

async function copyDatabase(sourceFile, destinationFile) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, destinationFile);
  } finally {
    source.close();
  }
}

function workbuddyObservationSnapshot(database, homeId) {
  const observations = database
    .prepare(
      `SELECT home_id, message_id, duration_ms, ended_at_ms, capture_version, captured_at
       FROM workbuddy_generation_duration_observations
       WHERE home_id = ? AND message_id = ?
       ORDER BY duration_ms`,
    )
    .all(homeId, MESSAGE_ID)
    .map((row) => ({ ...row }));
  const sourceIdentities = database
    .prepare(
      `SELECT path, kind, home_id, home_label, home_path
       FROM source_files
       WHERE kind = 'workbuddy' AND home_id = ?
       ORDER BY path`,
    )
    .all(homeId)
    .map((row) => ({ ...row }));
  const perfSampleCount = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM perf_samples
         WHERE source_kind = 'workbuddy' AND home_id = ?`,
      )
      .get(homeId).count,
  );
  return { observations, sourceIdentities, perfSampleCount };
}

function selectColdWorkbuddyBinding(database) {
  const homes = database
    .prepare(
      `SELECT DISTINCT home_id FROM workbuddy_generation_duration_observations
       WHERE message_id = ? ORDER BY home_id`,
    )
    .all(MESSAGE_ID);
  assert.equal(homes.length, 1, "fixture message must belong to exactly one WorkBuddy home");
  const homeId = String(homes[0].home_id);
  const event = database
    .prepare(
      `SELECT events.home_id, events.source_path, events.timestamp_ms
       FROM events
       JOIN source_files ON source_files.path = events.source_path
       WHERE events.home_id = ? AND source_files.kind = 'workbuddy'
       ORDER BY events.timestamp_ms, events.source_path
       LIMIT 1`,
    )
    .get(homeId);
  assert.ok(event, "WorkBuddy observation home must own a cold usage event");
  return { homeId, event: { ...event } };
}

test("cold WorkBuddy native duration observations are covered by archive verification", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cold-workbuddy-manifest-"));
  const homePath = path.join(root, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  const sessionFile = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const candidateFile = path.join(root, "cold-workbuddy-manifest-candidate.sqlite");
  const tamperedFile = path.join(root, "cold-workbuddy-manifest-tampered.sqlite");
  const repackedFile = path.join(root, "cold-workbuddy-manifest-repacked.sqlite");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(sessionFile, jsonl([usageRecord()]));
  writeFileSync(path.join(traceDir, "trace_fixture.jsonl"), jsonl([traceRow(800), traceRow(850)]));

  const options = { homeDir: root, env: {} };
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "index.sqlite") });
  try {
    await store.sync({ options });
    const binding = selectColdWorkbuddyBinding(store.database);
    assert.equal(String(binding.event.home_id), binding.homeId, "cold event must belong to the observation home");
    assert.equal(path.resolve(String(binding.event.source_path)), path.resolve(sessionFile));
    assert.equal(usageRecord().providerData.messageId, MESSAGE_ID, "native usage record must reference the message");

    const sourceBefore = workbuddyObservationSnapshot(store.database, binding.homeId);
    assert.deepEqual(
      sourceBefore.observations.map((row) => [row.message_id, row.duration_ms]),
      [
        [MESSAGE_ID, 800],
        [MESSAGE_ID, 850],
      ],
      "the real source must retain both conflicting native duration observations",
    );
    assert.ok(
      sourceBefore.sourceIdentities.some((row) => path.resolve(String(row.path)) === path.resolve(sessionFile)),
      "the cold event source must retain its five-column WorkBuddy identity",
    );
    assert.equal(sourceBefore.perfSampleCount, 0, "conflicting native durations must not force a perf sample");

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: Number(binding.event.timestamp_ms),
      endMs: Number(binding.event.timestamp_ms) + 1,
    });
    assert.deepEqual(
      workbuddyObservationSnapshot(store.database, binding.homeId),
      sourceBefore,
      "candidate creation must not mutate source observations or identities",
    );
    await verifyHistoryArchiveCandidate(candidateFile);

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateSnapshot;
    try {
      candidateSnapshot = workbuddyObservationSnapshot(candidate, binding.homeId);
    } finally {
      candidate.close();
    }
    assert.deepEqual(candidateSnapshot, sourceBefore, "candidate must preserve referenced WorkBuddy observations");

    await copyDatabase(candidateFile, tamperedFile);
    const tampered = new DatabaseSync(tamperedFile);
    let changedDuration;
    try {
      const target = tampered
        .prepare(
          `SELECT duration_ms FROM workbuddy_generation_duration_observations
           WHERE home_id = ? AND message_id = ? ORDER BY duration_ms LIMIT 1`,
        )
        .get(binding.homeId, MESSAGE_ID);
      assert.ok(target, "candidate must retain a referenced duration observation to modify");
      changedDuration = Number(target.duration_ms) + 1;
      const changed = tampered
        .prepare(
          `UPDATE workbuddy_generation_duration_observations SET duration_ms = ?
           WHERE home_id = ? AND message_id = ? AND duration_ms = ?`,
        )
        .run(changedDuration, binding.homeId, MESSAGE_ID, target.duration_ms);
      assert.equal(Number(changed.changes), 1, "test must modify exactly one referenced observation");
      assert.equal(
        Number(
          tampered
            .prepare(
              `SELECT COUNT(*) AS count FROM workbuddy_generation_duration_observations
               WHERE home_id = ? AND message_id = ?`,
            )
            .get(binding.homeId, MESSAGE_ID).count,
        ),
        2,
        "the native message must still reference both duration observations after modification",
      );
    } finally {
      tampered.close();
    }

    const repackSource = new DatabaseSync(tamperedFile, { readOnly: true });
    try {
      await createHistoryBackup(repackSource, repackedFile);
    } finally {
      repackSource.close();
    }
    const outer = await verifyHistoryBackup(repackedFile);
    assert.equal(outer.ok, true, "repacked candidate must retain a valid outer backup checksum");

    await assert.rejects(
      verifyHistoryArchiveCandidate(repackedFile),
      (error) => error?.code === WORKBUDDY_MISMATCH_CODE,
      `verification accepted modified WorkBuddy duration ${changedDuration} for ${binding.homeId}/${MESSAGE_ID}`,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
