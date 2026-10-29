import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import {
  createHistoryArchiveCandidate,
  HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const TIMING_MISMATCH_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH";
const TIMING_BAD_METADATA_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_BAD_METADATA";
const TIMING_META_KEY = "history_archive_perf_timing_v1";
const LEGACY_PERF_META_KEYS = Object.freeze([
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
]);
const TIMING_THREAD_COLUMNS = Object.freeze(["home_id", "response_id", "thread_id"]);
const TIMING_EVIDENCE_BASE_COLUMNS = Object.freeze([
  "home_id",
  "evidence_origin",
  "response_id",
  "variant_key",
  "schema_version",
  "requested_model",
  "reported_output_tokens",
  "duration_ms",
  "status",
  "completed_at_ms",
]);
const PERF_SAMPLE_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const TIMING_OWNERS_CTE = `
  WITH owners(home_id, thread_id) AS (
    SELECT DISTINCT rollouts.home_id, rollouts.thread_id
    FROM (
      SELECT source_path FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?
      UNION
      SELECT dependencies.source_path
      FROM perf_samples AS samples
      JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
      WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
    ) AS referenced
    JOIN perf_rollout_threads AS rollouts ON rollouts.source_path = referenced.source_path
  )
`;

async function copyDatabase(sourceFile, destinationFile) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, destinationFile);
  } finally {
    source.close();
  }
}

async function repackMetadata(sourceFile, workingFile, repackedFile, mutate) {
  await copyDatabase(sourceFile, workingFile);
  const working = new DatabaseSync(workingFile);
  try {
    mutate(working);
  } finally {
    working.close();
  }
  const repackSource = new DatabaseSync(workingFile, { readOnly: true });
  try {
    await createHistoryBackup(repackSource, repackedFile);
  } finally {
    repackSource.close();
  }
  const outer = await verifyHistoryBackup(repackedFile);
  assert.equal(outer.ok, true, "metadata mutation tests must retain a valid outer backup checksum");
}

function timingTableEvidence(table, columns, startMs, endMs, iterator) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ table, startMs, endMs, columns }));
  hash.update("\n");
  let rows = 0;
  for (const row of iterator) {
    hash.update(JSON.stringify(Object.fromEntries(columns.map((column) => [column, row[column]]))));
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function timingEvidenceColumns(database) {
  const columns = database
    .prepare("PRAGMA table_info(perf_request_timing_evidence)")
    .all()
    .map((row) => String(row.name));
  return columns.includes("generation_json")
    ? [...TIMING_EVIDENCE_BASE_COLUMNS, "generation_json"]
    : [...TIMING_EVIDENCE_BASE_COLUMNS];
}

function sourceTimingManifest(database, startMs, endMs) {
  const evidenceColumns = timingEvidenceColumns(database);
  const threads = timingTableEvidence(
    "perf_request_timing_threads",
    TIMING_THREAD_COLUMNS,
    startMs,
    endMs,
    database
      .prepare(
        `${TIMING_OWNERS_CTE}
         SELECT timing.home_id, timing.response_id, timing.thread_id
         FROM perf_request_timing_threads AS timing
         JOIN owners ON owners.home_id = timing.home_id AND owners.thread_id = timing.thread_id
         ORDER BY timing.home_id, timing.response_id, timing.thread_id`,
      )
      .iterate(startMs, endMs, startMs, endMs),
  );
  const evidence = timingTableEvidence(
    "perf_request_timing_evidence",
    evidenceColumns,
    startMs,
    endMs,
    database
      .prepare(
        `${TIMING_OWNERS_CTE},
         links(home_id, response_id) AS (
           SELECT DISTINCT timing.home_id, timing.response_id
           FROM perf_request_timing_threads AS timing
           JOIN owners ON owners.home_id = timing.home_id AND owners.thread_id = timing.thread_id
         )
         SELECT ${evidenceColumns.map((column) => `evidence.${column}`).join(", ")}
         FROM perf_request_timing_evidence AS evidence
         JOIN links ON links.home_id = evidence.home_id AND links.response_id = evidence.response_id
         ORDER BY evidence.home_id, evidence.evidence_origin, evidence.response_id, evidence.variant_key`,
      )
      .iterate(startMs, endMs, startMs, endMs),
  );
  return {
    formatVersion: 1,
    startMs,
    endMs,
    tables: {
      perf_request_timing_threads: threads,
      perf_request_timing_evidence: evidence,
    },
  };
}

function selectColdTimingEvidence(database, coldStartMs) {
  return database
    .prepare(
      `SELECT samples.sample_key, samples.ts_ms AS sample_ts_ms,
              owners.home_id, owners.thread_id,
              evidence.evidence_origin, evidence.response_id, evidence.variant_key
       FROM perf_samples AS samples
       JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       JOIN perf_request_timing_threads AS links
         ON links.home_id = owners.home_id AND links.thread_id = owners.thread_id
       JOIN perf_request_timing_evidence AS evidence
         ON evidence.home_id = links.home_id AND evidence.response_id = links.response_id
       WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
       ORDER BY samples.ts_ms, samples.sample_key, evidence.evidence_origin,
                evidence.response_id, evidence.variant_key
       LIMIT 1`,
    )
    .get(coldStartMs, COLD_END_MS);
}

function readTimingBinding(database, selected) {
  const evidence = database
    .prepare(
      `SELECT evidence.*
       FROM perf_request_timing_evidence AS evidence
       JOIN perf_request_timing_threads AS links
         ON links.home_id = evidence.home_id AND links.response_id = evidence.response_id
       WHERE evidence.home_id = ? AND evidence.evidence_origin = ?
         AND evidence.response_id = ? AND evidence.variant_key = ? AND links.thread_id = ?`,
    )
    .get(selected.home_id, selected.evidence_origin, selected.response_id, selected.variant_key, selected.thread_id);
  const sources = database
    .prepare(
      `SELECT dependencies.sample_key, dependencies.source_path, dependencies.role,
              owners.home_id, owners.thread_id
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ?
       ORDER BY dependencies.source_path, dependencies.role`,
    )
    .all(selected.sample_key)
    .map((row) => ({ ...row }));
  return { evidence: evidence === undefined ? undefined : { ...evidence }, sources };
}

test("cold Codex request-timing evidence values are covered by archive verification", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-timing-manifest-candidate.sqlite");
  const tamperedFile = path.join(fixture.serverOptions.homeDir, "cold-timing-manifest-tampered.sqlite");
  const repackedFile = path.join(fixture.serverOptions.homeDir, "cold-timing-manifest-repacked.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const selected = selectColdTimingEvidence(store.database, coldStartMs);
    assert.ok(selected, "fixture must expose a cold sample with a native request-timing evidence link");

    const sourceBinding = readTimingBinding(store.database, selected);
    assert.ok(sourceBinding.evidence, "the selected response must retain its raw timing evidence");
    assert.ok(
      sourceBinding.sources.some((source) => source.role === "primary") &&
        sourceBinding.sources.some((source) => source.role === "dependency"),
      "the selected sample must retain its primary and dependency source identities",
    );
    const expectedTiming = sourceTimingManifest(store.database, coldStartMs, COLD_END_MS);

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(candidateFile);

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateBinding;
    let candidateTiming;
    try {
      candidateBinding = readTimingBinding(candidate, selected);
      const row = candidate.prepare("SELECT value FROM store_meta WHERE key = ?").get(TIMING_META_KEY);
      candidateTiming = row === undefined ? undefined : JSON.parse(String(row.value));
    } finally {
      candidate.close();
    }
    assert.deepEqual(
      candidateBinding,
      sourceBinding,
      "candidate creation must preserve the cold sample's source identities and raw request-timing evidence",
    );
    assert.deepEqual(
      candidateTiming,
      expectedTiming,
      "candidate timing metadata must match the source SQL digest oracle",
    );

    await copyDatabase(candidateFile, tamperedFile);
    const tampered = new DatabaseSync(tamperedFile);
    let changedEvidence;
    try {
      const nextDurationMs = Number(sourceBinding.evidence.duration_ms) + 1;
      const changed = tampered
        .prepare(
          `UPDATE perf_request_timing_evidence
           SET duration_ms = ?
           WHERE home_id = ? AND evidence_origin = ? AND response_id = ? AND variant_key = ?`,
        )
        .run(
          nextDurationMs,
          sourceBinding.evidence.home_id,
          sourceBinding.evidence.evidence_origin,
          sourceBinding.evidence.response_id,
          sourceBinding.evidence.variant_key,
        );
      assert.equal(Number(changed.changes), 1, "test must update exactly one referenced timing evidence row");
      changedEvidence = tampered
        .prepare(
          `SELECT * FROM perf_request_timing_evidence
           WHERE home_id = ? AND evidence_origin = ? AND response_id = ? AND variant_key = ?`,
        )
        .get(
          sourceBinding.evidence.home_id,
          sourceBinding.evidence.evidence_origin,
          sourceBinding.evidence.response_id,
          sourceBinding.evidence.variant_key,
        );
    } finally {
      tampered.close();
    }
    assert.deepEqual(
      { ...changedEvidence, duration_ms: sourceBinding.evidence.duration_ms },
      sourceBinding.evidence,
      "only the referenced evidence duration may change while its primary key and other values remain intact",
    );

    const repackSource = new DatabaseSync(tamperedFile, { readOnly: true });
    try {
      await createHistoryBackup(repackSource, repackedFile);
    } finally {
      repackSource.close();
    }
    const outer = await verifyHistoryBackup(repackedFile);
    assert.equal(outer.ok, true, "the repacked candidate must retain a valid outer backup checksum");

    await assert.rejects(
      verifyHistoryArchiveCandidate(repackedFile),
      (error) => error?.code === TIMING_MISMATCH_CODE,
      `verification accepted changed request-timing evidence for ${sourceBinding.evidence.home_id}/${sourceBinding.evidence.response_id} (${sourceBinding.evidence.variant_key})`,
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("legacy timing manifests without generation_json keep the original ten-column hash", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-timing-legacy-schema-candidate.sqlite");
  const workingFile = path.join(fixture.serverOptions.homeDir, "cold-timing-legacy-schema-working.sqlite");
  const repackedFile = path.join(fixture.serverOptions.homeDir, "cold-timing-legacy-schema.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  let expectedTiming;
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });

    await repackMetadata(candidateFile, workingFile, repackedFile, (database) => {
      const sample = database
        .prepare(
          `SELECT ${PERF_SAMPLE_COLUMNS.join(", ")}
           FROM perf_samples
           WHERE source_kind = 'codex'
             AND timing_kind = 'generation'
             AND timing_source = 'explicit'
           ORDER BY ts_ms, sample_key`,
        )
        .all()
        .map((row) => ({ ...row }))
        .find((row) => {
          try {
            return JSON.parse(String(row.sample_key)).length === 5;
          } catch {
            return false;
          }
        });
      assert.ok(sample, "new archive candidates must contain a v3 sample before legacy conversion");
      const sampleKey = JSON.parse(String(sample.sample_key));
      const responseId = String(sampleKey[4]);
      const evidence = database
        .prepare(
          `SELECT reported_output_tokens, duration_ms
           FROM perf_request_timing_evidence
           WHERE home_id = ? AND response_id = ?
           ORDER BY evidence_origin, variant_key
           LIMIT 1`,
        )
        .get(String(sample.home_id), responseId);
      assert.ok(evidence, "the selected v3 sample must retain request timing evidence");

      const legacySampleKey = JSON.stringify(sampleKey.slice(0, 4));
      const legacySample = {
        ...sample,
        sample_key: legacySampleKey,
        window: "turn",
        timing_kind: "request_e2e",
        token_scope: "reported_output_includes_reasoning",
        duration_ms: Number(evidence.duration_ms),
        output_tokens: Number(evidence.reported_output_tokens),
        request_count: 1,
        method_version: "tps-v2",
      };
      const codexRequestsRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY);
      assert.ok(codexRequestsRow, "the selected v3 sample must retain native request facts");
      const codexRequests = JSON.parse(String(codexRequestsRow.value));
      const requestTurn = codexRequests.turns.find((turn) => turn.sampleKey === String(sample.sample_key));
      assert.ok(requestTurn, "the selected v3 sample must retain its native request turn");
      assert.equal(
        requestTurn.requests.length,
        1,
        "the legacy conversion must select a one-request turn so the v2 whole-turn contract remains valid",
      );
      const legacyRequestTurn = { ...requestTurn, sampleKey: legacySampleKey };
      const dependencies = database
        .prepare(
          `SELECT source_path, role
           FROM perf_sample_sources
           WHERE sample_key = ?
           ORDER BY source_path, role`,
        )
        .all(String(sample.sample_key))
        .map((row) => ({ ...row }));
      assert.ok(dependencies.length > 0, "the selected v3 sample must retain its rollout dependencies");
      database.prepare("DELETE FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?").run(coldStartMs, COLD_END_MS);
      database
        .prepare(
          `INSERT INTO perf_samples (${PERF_SAMPLE_COLUMNS.join(", ")})
           VALUES (${PERF_SAMPLE_COLUMNS.map(() => "?").join(", ")})`,
        )
        .run(...PERF_SAMPLE_COLUMNS.map((column) => legacySample[column]));
      const insertDependency = database.prepare(
        "INSERT INTO perf_sample_sources (sample_key, source_path, role) VALUES (?, ?, ?)",
      );
      for (const dependency of dependencies) {
        insertDependency.run(legacySampleKey, String(dependency.source_path), String(dependency.role));
      }
      database.prepare("UPDATE store_meta SET value = ? WHERE key = ?").run(
        JSON.stringify({
          ...codexRequests,
          turns: [legacyRequestTurn],
        }),
        HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY,
      );

      for (const key of LEGACY_PERF_META_KEYS.filter((key) => key !== TIMING_META_KEY)) {
        database.prepare("DELETE FROM store_meta WHERE key = ?").run(key);
      }
      database.exec("ALTER TABLE perf_request_timing_evidence DROP COLUMN generation_json");
      assert.equal(
        database
          .prepare("PRAGMA table_info(perf_request_timing_evidence)")
          .all()
          .some((row) => row.name === "generation_json"),
        false,
        "the legacy fixture must actually omit generation_json",
      );
      expectedTiming = sourceTimingManifest(database, coldStartMs, COLD_END_MS);
      database
        .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
        .run(JSON.stringify(expectedTiming), TIMING_META_KEY);
    });

    await verifyHistoryArchiveCandidate(repackedFile);
    const legacy = new DatabaseSync(repackedFile, { readOnly: true });
    try {
      const row = legacy.prepare("SELECT value FROM store_meta WHERE key = ?").get(TIMING_META_KEY);
      assert.ok(row, "the legacy candidate must retain timing metadata");
      assert.deepEqual(
        JSON.parse(String(row.value)),
        expectedTiming,
        "the legacy candidate must retain the exact ten-column SQL digest",
      );
      assert.equal(
        legacy
          .prepare("PRAGMA table_info(perf_request_timing_evidence)")
          .all()
          .some((column) => column.name === "generation_json"),
        false,
      );
    } finally {
      legacy.close();
    }
  } finally {
    store.close();
    fixture.close();
  }
});

test("legacy timing metadata is compatible while malformed or mismatched metadata is rejected", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-timing-meta-candidate.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let baseTiming;
    try {
      const row = candidate.prepare("SELECT value FROM store_meta WHERE key = ?").get(TIMING_META_KEY);
      assert.ok(row, "new candidates must carry timing metadata");
      baseTiming = JSON.parse(String(row.value));
    } finally {
      candidate.close();
    }

    const legacyWork = path.join(fixture.serverOptions.homeDir, "cold-timing-meta-legacy-work.sqlite");
    const legacyRepacked = path.join(fixture.serverOptions.homeDir, "cold-timing-meta-legacy.sqlite");
    await repackMetadata(candidateFile, legacyWork, legacyRepacked, (database) => {
      const remove = database.prepare("DELETE FROM store_meta WHERE key = ?");
      for (const key of LEGACY_PERF_META_KEYS) remove.run(key);
    });
    await verifyHistoryArchiveCandidate(legacyRepacked);
    const legacy = new DatabaseSync(legacyRepacked, { readOnly: true });
    try {
      assert.equal(
        Number(
          legacy
            .prepare(
              `SELECT COUNT(*) AS count FROM store_meta WHERE key IN (${LEGACY_PERF_META_KEYS.map(() => "?").join(",")})`,
            )
            .get(...LEGACY_PERF_META_KEYS).count,
        ),
        0,
        "legacy candidates must remain event-compatible without perf capability keys",
      );
    } finally {
      legacy.close();
    }

    const cases = [
      {
        label: "format",
        code: TIMING_BAD_METADATA_CODE,
        mutate: (value) => ({ ...value, formatVersion: 2 }),
      },
      {
        label: "range",
        code: TIMING_BAD_METADATA_CODE,
        mutate: (value) => ({ ...value, startMs: value.startMs + 1 }),
      },
      {
        label: "count",
        code: TIMING_MISMATCH_CODE,
        mutate: (value) => {
          value.tables.perf_request_timing_threads.rows += 1;
          return value;
        },
      },
      {
        label: "hash",
        code: TIMING_MISMATCH_CODE,
        mutate: (value) => {
          value.tables.perf_request_timing_evidence.sha256 = "0".repeat(64);
          return value;
        },
      },
    ];
    for (const entry of cases) {
      const working = path.join(fixture.serverOptions.homeDir, `cold-timing-meta-${entry.label}-work.sqlite`);
      const repacked = path.join(fixture.serverOptions.homeDir, `cold-timing-meta-${entry.label}.sqlite`);
      await repackMetadata(candidateFile, working, repacked, (database) => {
        const value = entry.mutate(JSON.parse(JSON.stringify(baseTiming)));
        database.prepare("UPDATE store_meta SET value = ? WHERE key = ?").run(JSON.stringify(value), TIMING_META_KEY);
      });
      await assert.rejects(
        verifyHistoryArchiveCandidate(repacked),
        (error) => error?.code === entry.code,
        `timing metadata ${entry.label} mismatch must fail with ${entry.code}`,
      );
    }
  } finally {
    store.close();
    fixture.close();
  }
});
