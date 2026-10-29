import assert from "node:assert/strict";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const TURN_25_END_MS = Date.parse("2026-10-04T12:05:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PERF_REVISIONS_KEY = "history_archive_perf_revisions";
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function codexHomeId(store, codexHome) {
  const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(codexHome));
  assert.ok(home, "fixture must discover the Codex home");
  return String(home.id);
}

function addSiblingConflicts(database, homeId, turnId, siblingResponseId) {
  let itemConflictAdded = false;
  let rawConflictAdded = false;
  const projections = database
    .prepare("SELECT path, projection FROM perf_codex_projections WHERE home_id = ? ORDER BY path")
    .all(homeId);
  const update = database.prepare("UPDATE perf_codex_projections SET projection = ? WHERE path = ?");
  for (const row of projections) {
    const projection = JSON.parse(String(row.projection));
    const records = Array.isArray(projection.records) ? projection.records : [];
    const requestIndex = records.findIndex(
      (record) =>
        record?.kind === "token_usage_record" && record.turnId === turnId && record.responseId === siblingResponseId,
    );
    if (requestIndex === -1) continue;

    const request = records[requestIndex];
    const timestamp = request.timestamp;
    const lineNumber = Number(request.lineNumber) || 0;
    records.splice(
      requestIndex,
      0,
      {
        kind: "response_item",
        sourcePath: request.sourcePath,
        lineNumber: lineNumber - 0.2,
        threadId: request.threadId,
        turnId,
        itemId: "sibling-conflict-item",
        responseItemType: "message",
        role: "assistant",
        timestamp,
      },
      {
        kind: "response_item",
        sourcePath: request.sourcePath,
        lineNumber: lineNumber - 0.1,
        threadId: request.threadId,
        turnId,
        itemId: "sibling-conflict-item",
        responseItemType: "function_call",
        callId: "sibling-conflict-call",
        timestamp,
      },
    );
    const conflictingRequest = {
      ...JSON.parse(JSON.stringify(request)),
      lineNumber: lineNumber + 0.1,
      outputTokens: Number(request.outputTokens) + 1,
    };
    records.splice(requestIndex + 3, 0, conflictingRequest);
    update.run(JSON.stringify(projection), String(row.path));
    itemConflictAdded = true;
    rawConflictAdded = true;
    break;
  }
  assert.equal(itemConflictAdded, true, "the sibling response must receive a native item conflict");
  assert.equal(rawConflictAdded, true, "the sibling response must receive a raw output conflict");

  const evidence = database
    .prepare(
      `SELECT *
       FROM perf_request_timing_evidence
       WHERE home_id = ? AND response_id = ?
       ORDER BY evidence_origin, variant_key
       LIMIT 1`,
    )
    .get(homeId, siblingResponseId);
  assert.ok(evidence, "the sibling response must retain timing evidence to mutate");
  const generation =
    evidence.generation_json === null || evidence.generation_json === undefined
      ? null
      : JSON.parse(String(evidence.generation_json));
  const conflictingDurationMs = Number(evidence.duration_ms) + 1;
  const conflictingGeneration =
    generation === null ? null : { ...generation, durationMs: Number(generation.durationMs) + 1 };
  const variantKey = JSON.stringify([
    Number(evidence.schema_version),
    String(evidence.requested_model),
    Number(evidence.reported_output_tokens),
    conflictingDurationMs,
    String(evidence.status),
    evidence.completed_at_ms,
    conflictingGeneration,
  ]);
  database
    .prepare(
      `INSERT INTO perf_request_timing_evidence (
         home_id, evidence_origin, response_id, variant_key, schema_version,
         requested_model, reported_output_tokens, duration_ms, status, completed_at_ms, generation_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(evidence.home_id),
      String(evidence.evidence_origin),
      siblingResponseId,
      variantKey,
      Number(evidence.schema_version),
      String(evidence.requested_model),
      Number(evidence.reported_output_tokens),
      conflictingDurationMs,
      String(evidence.status),
      evidence.completed_at_ms,
      conflictingGeneration === null ? null : JSON.stringify(conflictingGeneration),
    );
}

test("v3 archive validation isolates sibling conflicts and missing sibling timing", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const sourceFile = path.join(fixture.serverOptions.homeDir, "cold-codex-response-isolation-source.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-response-isolation-candidate.sqlite");
  const missingSiblingCandidateFile = path.join(
    fixture.serverOptions.homeDir,
    "cold-codex-response-isolation-missing-sibling-candidate.sqlite",
  );
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const selected = store.database
      .prepare(
        `SELECT sample_key, home_id, ts_ms
         FROM perf_samples
         WHERE ts_ms >= ? AND ts_ms < ?
           AND source_kind = 'codex'
           AND status = 'completed'
           AND timing_kind = 'generation'
           AND timing_source = 'explicit'
         ORDER BY ts_ms, sample_key`,
      )
      .all(coldStartMs, TURN_25_END_MS)
      .find((row) => {
        const key = JSON.parse(String(row.sample_key));
        return key[3] === "turn-25" && key[4] === "response-25-1";
      });
    assert.ok(selected, "fixture must expose the first response of the two-response cold turn");
    const sampleKey = JSON.parse(String(selected.sample_key));
    const homeId = String(selected.home_id);
    const threadId = String(sampleKey[2]);
    const turnId = String(sampleKey[3]);
    const responseId = String(sampleKey[4]);
    const siblingResponseId = "response-25-2";
    assert.equal(threadId.length > 0, true);
    assert.equal(responseId, "response-25-1");

    await backup(store.database, sourceFile);
    const isolated = new DatabaseSync(sourceFile);
    try {
      addSiblingConflicts(isolated, homeId, turnId, siblingResponseId);
    } finally {
      isolated.close();
    }

    const isolatedReadOnly = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      await createHistoryArchiveCandidate(isolatedReadOnly, candidateFile, {
        startMs: coldStartMs,
        endMs: Number(selected.ts_ms) + 1,
      });
      await verifyHistoryArchiveCandidate(candidateFile);
    } finally {
      isolatedReadOnly.close();
    }

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      const row = candidate
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get("history_archive_codex_requests_v1");
      assert.ok(row, "the isolated candidate must retain bounded Codex request facts");
      const facts = JSON.parse(String(row.value));
      const turn = facts.turns.find((entry) => entry.sampleKey === String(selected.sample_key));
      assert.ok(turn);
      assert.deepEqual(
        turn.requests.map((request) => request.responseId),
        [responseId],
        "the key5 archive must select the target response rather than every sibling",
      );
    } finally {
      candidate.close();
    }

    const missingSibling = new DatabaseSync(sourceFile);
    try {
      const deleted = missingSibling
        .prepare("DELETE FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
        .run(homeId, siblingResponseId);
      assert.ok(Number(deleted.changes) > 0, "the sibling response must lose all of its timing evidence");
      assert.equal(
        Number(
          missingSibling
            .prepare(
              `SELECT COUNT(*) AS count
               FROM perf_request_timing_threads
               WHERE home_id = ? AND thread_id = ? AND response_id = ?`,
            )
            .get(homeId, threadId, siblingResponseId).count,
        ),
        1,
        "the missing sibling evidence must retain its unrelated native timing link",
      );
      assert.ok(
        Number(
          missingSibling
            .prepare(
              `SELECT COUNT(*) AS count
               FROM perf_request_timing_evidence
               WHERE home_id = ? AND response_id = ?`,
            )
            .get(homeId, responseId).count,
        ) > 0,
        "the selected response must retain its own timing evidence",
      );
    } finally {
      missingSibling.close();
    }

    const missingSiblingReadOnly = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      await createHistoryArchiveCandidate(missingSiblingReadOnly, missingSiblingCandidateFile, {
        startMs: coldStartMs,
        endMs: Number(selected.ts_ms) + 1,
      });
      await verifyHistoryArchiveCandidate(missingSiblingCandidateFile);
    } finally {
      missingSiblingReadOnly.close();
    }

    const missingSiblingCandidate = new DatabaseSync(missingSiblingCandidateFile, { readOnly: true });
    try {
      const linkedResponses = missingSiblingCandidate
        .prepare(
          `SELECT response_id
           FROM perf_request_timing_threads
           WHERE home_id = ? AND thread_id = ?
           ORDER BY response_id`,
        )
        .all(homeId, threadId)
        .map((row) => String(row.response_id));
      assert.ok(linkedResponses.includes(responseId), "the target timing link must remain in the candidate");
      assert.ok(linkedResponses.includes(siblingResponseId), "the unrelated sibling timing link must remain");
      const evidencedResponses = missingSiblingCandidate
        .prepare(
          `SELECT DISTINCT response_id
           FROM perf_request_timing_evidence
           WHERE home_id = ?
           ORDER BY response_id`,
        )
        .all(homeId)
        .map((row) => String(row.response_id));
      assert.ok(evidencedResponses.includes(responseId), "the candidate must retain the target timing evidence");
      assert.equal(
        evidencedResponses.includes(siblingResponseId),
        false,
        "the candidate must retain no sibling timing evidence",
      );
    } finally {
      missingSiblingCandidate.close();
    }

    const archived = new UsageStore({ ...fixture.serverOptions, databaseFile: sourceFile });
    try {
      const registered = await archived.registerHistoryArchiveCandidate(missingSiblingCandidateFile);
      const coldPerf = await archived.readHistoryArchivePerfSamples(registered.segmentId);
      archived.homes = structuredClone(store.homes);
      assert.ok(
        coldPerf.some((sample) => String(sample.sampleKey) === String(selected.sample_key)),
        "a v3 response must remain readable when its own evidence exists and an unrelated sibling link has none",
      );

      const archiveEndMs = Number(selected.ts_ms) + 1;
      archived.database.exec("BEGIN IMMEDIATE");
      try {
        writeMeta(archived.database, EVENT_AUTHORITY_KEY, {
          formatVersion: 1,
          segmentIds: [registered.segmentId],
        });
        writeMeta(archived.database, PERF_AUTHORITY_KEY, {
          formatVersion: 1,
          segments: [
            {
              segmentId: registered.segmentId,
              databaseSha256: registered.databaseSha256,
              sourceKinds: ["codex"],
              methodVersions: [PERF_METHOD_VERSION],
            },
          ],
        });
        archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(archiveEndMs);
        archived.database.exec("COMMIT");
      } catch (error) {
        archived.database.exec("ROLLBACK");
        throw error;
      }

      const baseTiming = fixture.timingRecords.find((record) => record.responseId === responseId);
      assert.ok(baseTiming, "the selected response must have base native timing evidence");
      const lateTiming = {
        ...baseTiming,
        evidenceOrigin: "0-isolation-late@1",
        durationMs: baseTiming.durationMs + 500,
        generation: { ...baseTiming.generation, durationMs: baseTiming.generation.durationMs + 500 },
      };
      const lateTimingImport = archived.importRequestTimingEvidence({
        homeId: codexHomeId(archived, fixture.codexHome),
        records: [lateTiming],
        reviewedOrigins: [lateTiming.evidenceOrigin],
      });
      assert.equal(lateTimingImport.changed, true, "the target late timing variant must be imported");
      await archived.sync({ options: fixture.reportOptions });

      const revisedSample = archived.database
        .prepare("SELECT duration_ms FROM perf_samples WHERE sample_key = ?")
        .get(selected.sample_key);
      assert.equal(Number(revisedSample.duration_ms), Number(lateTiming.generation.durationMs));

      const revisionMetadata = archived.database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(PERF_REVISIONS_KEY)?.value;
      assert.equal(typeof revisionMetadata, "string");
      const revisionRoot = JSON.parse(String(revisionMetadata));
      assert.ok(
        revisionRoot.revisions.some(
          (revision) =>
            revision.factTable === "perf_samples" &&
            revision.added.some((delta) => String(delta.payload.sample_key) === String(selected.sample_key)),
        ),
        "the target-only late timing must create an effective sample revision",
      );

      const summary = await archived.summarizeHistory(FILTERS);
      assert.ok(
        summary.perf,
        "effective revision validation must accept the target when an unrelated sibling link has no evidence",
      );
    } finally {
      archived.close();
    }
  } finally {
    store.close();
    fixture.close();
  }
});
