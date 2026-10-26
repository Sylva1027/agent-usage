import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyPublishedHistoryArchiveBundle } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const PUBLIC_FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const SNAPSHOT_TABLES = Object.freeze([
  "events",
  "perf_samples",
  "source_files",
  "history_replaced_facts",
  "perf_sample_sources",
  "perf_rollout_threads",
  "perf_codex_projections",
  "workbuddy_generation_durations",
  "workbuddy_generation_duration_observations",
  "perf_request_timing_meta",
  "perf_request_timing_evidence",
  "perf_request_timing_threads",
  "perf_request_timing_dirty_threads",
  "archive_segments",
  "store_meta",
  "usage_rollup_format",
  "usage_rollup_days",
  "usage_rollup_daily",
  "usage_rollup_sessions",
  "usage_rollup_dirty_days",
]);
const RETAINED_GRAPH_TABLES = Object.freeze([
  ["source_files", "path"],
  ["perf_rollout_threads", "source_path"],
  ["perf_codex_projections", "path"],
  ["perf_request_timing_meta", "singleton"],
  ["perf_request_timing_evidence", "home_id, evidence_origin, response_id, variant_key"],
  ["perf_request_timing_threads", "home_id, response_id, thread_id"],
  ["perf_request_timing_dirty_threads", "home_id, thread_id"],
]);

function runCli(args, homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_USAGE_HOMES: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

function rows(database, sql, ...params) {
  return database
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));
}

function perfRows(database, where, ...params) {
  return rows(
    database,
    `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE ${where} ORDER BY sample_key`,
    ...params,
  );
}

function dependencyRows(database, sampleKeys) {
  return rows(
    database,
    `SELECT sample_key, source_path, role FROM perf_sample_sources
     WHERE sample_key IN (SELECT value FROM json_each(?))
     ORDER BY sample_key, source_path`,
    JSON.stringify(sampleKeys),
  );
}

function retainedGraph(database) {
  return Object.fromEntries(
    RETAINED_GRAPH_TABLES.map(([table, orderBy]) => [
      table,
      rows(database, `SELECT * FROM ${table} ORDER BY ${orderBy}`),
    ]),
  );
}

function publicEvidence(summary, report) {
  const perf = structuredClone(summary.perf);
  perf.indexedAt = null;
  if (perf.meta) perf.meta.indexedAt = null;
  return {
    events: report.events,
    totals: summary.totals,
    costEstimate: summary.costEstimate,
    perf,
  };
}

function logicalSnapshot(database) {
  return Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => [table, rows(database, `SELECT * FROM ${table} ORDER BY rowid`)]),
  );
}

function insertUnplacedSample(store, templateSampleKey) {
  const [template] = rows(
    store.database,
    `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`,
    templateSampleKey,
  );
  assert.ok(template, "the fixture must provide a cold sample to model an unplaced sample");
  const keyParts = JSON.parse(String(template.sample_key));
  assert.equal(keyParts.length, 4);
  keyParts[3] = "turn-unplaced";
  const sampleKey = JSON.stringify(keyParts);
  const unplaced = {
    ...template,
    sample_key: sampleKey,
    turn_key: "turn-unplaced",
    ts_ms: null,
    window_start_ms: null,
    window_end_ms: null,
  };
  store.database
    .prepare(
      `INSERT INTO perf_samples (${PERF_COLUMNS.join(", ")})
       VALUES (${PERF_COLUMNS.map(() => "?").join(", ")})`,
    )
    .run(...PERF_COLUMNS.map((column) => unplaced[column]));
  const dependencies = rows(
    store.database,
    "SELECT source_path, role FROM perf_sample_sources WHERE sample_key = ? ORDER BY source_path",
    templateSampleKey,
  );
  assert.ok(dependencies.length > 0);
  const insertDependency = store.database.prepare(
    "INSERT INTO perf_sample_sources (sample_key, source_path, role) VALUES (?, ?, ?)",
  );
  for (const dependency of dependencies) {
    insertDependency.run(sampleKey, dependency.source_path, dependency.role);
  }
  return sampleKey;
}

test("formal Codex perf CLI commits native tps-v2 samples and replays both backups", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "archive-commit-codex-cli.sqlite");
  const oracleFile = path.join(homeDir, "archive-commit-codex-cli-oracle.sqlite");
  const candidateFile = path.join(homeDir, "archive-commit-codex-cli-candidate.sqlite");
  const firstBundle = path.join(homeDir, "archive-commit-codex-cli-bundle-1");
  const replayBundle = path.join(homeDir, "archive-commit-codex-cli-bundle-2");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "archive-commit-codex-cli-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  let opened = null;
  try {
    appendFileSync(
      fixture.rolloutFiles[0],
      `${JSON.stringify({
        timestamp: "2026-10-04T12:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
        },
      })}\n`,
    );
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    await fixture.seedRequestTiming(archived);
    await fixture.seedRequestTiming(oracle);

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    assert.ok(Number.isSafeInteger(coldStartMs) && coldStartMs < COLD_END_MS);
    const coldPerf = perfRows(archived.database, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS);
    assert.ok(coldPerf.length > 0, "fixture must contain cold Codex perf samples");
    assert.deepEqual([...new Set(coldPerf.map((sample) => sample.source_kind))], ["codex"]);
    assert.deepEqual(
      [...new Set(coldPerf.map((sample) => sample.method_version))],
      [PERF_METHOD_VERSION],
      "formal CLI coverage must start with supported tps-v2 samples",
    );
    assert.ok(coldPerf.every((sample) => sample.status === "completed"));
    assert.ok(coldPerf.every((sample) => sample.timing_kind === "request_e2e"));
    assert.ok(coldPerf.every((sample) => sample.timing_source === "explicit"));
    const coldKeys = coldPerf.map((sample) => String(sample.sample_key));
    const coldDependencies = dependencyRows(archived.database, coldKeys);
    assert.ok(coldDependencies.length > 0, "cold samples must retain their native dependency graph");
    const nativeTimingSamples = Number(
      archived.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM perf_samples AS samples
           WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
             AND samples.timing_source = 'explicit'
             AND EXISTS (
               SELECT 1
               FROM perf_sample_sources AS dependencies
               JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
               JOIN perf_request_timing_threads AS links
                 ON links.home_id = owners.home_id AND links.thread_id = owners.thread_id
               JOIN perf_request_timing_evidence AS evidence
                 ON evidence.home_id = links.home_id AND evidence.response_id = links.response_id
               WHERE dependencies.sample_key = samples.sample_key
             )`,
        )
        .get(coldStartMs, COLD_END_MS).count,
    );
    assert.ok(nativeTimingSamples > 0, "the oracle must include real native request timing");

    const unplacedKey = insertUnplacedSample(archived, coldPerf[0].sample_key);
    assert.equal(insertUnplacedSample(oracle, coldPerf[0].sample_key), unplacedKey);
    const outOfRangeBefore = perfRows(archived.database, "ts_ms >= ?", COLD_END_MS);
    const unplacedBefore = perfRows(archived.database, "ts_ms IS NULL");
    assert.ok(outOfRangeBefore.length > 0, "fixture must retain out-of-range perf samples");
    assert.equal(unplacedBefore.length, 1);
    const retainedKeys = [...outOfRangeBefore, ...unplacedBefore].map((sample) => String(sample.sample_key));
    const retainedDependenciesBefore = dependencyRows(archived.database, retainedKeys);
    const graphBefore = retainedGraph(archived.database);

    const oracleReport = await oracle.publishedHistoryUsageReport();
    const oracleSummary = await oracle.summarizeHistory(PUBLIC_FILTERS);
    const expected = publicEvidence(oracleSummary, oracleReport);
    assert.ok(expected.perf.coverage.sampled > 0, "the unarchived oracle must include complete perf evidence");

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      assert.deepEqual(
        perfRows(candidate, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS),
        coldPerf,
        "the candidate must contain every cold Codex sample",
      );
      assert.deepEqual(dependencyRows(candidate, coldKeys), coldDependencies);
    } finally {
      candidate.close();
    }
    archived.close();

    const first = await runCli(
      ["history", "archive", archivedFile, "--commit", candidateFile, "--backup", firstBundle, "--home-dir", homeDir],
      homeDir,
    );
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /Replay: no\b/);
    await verifyPublishedHistoryArchiveBundle(firstBundle);

    opened = new UsageStore(archivedOptions);
    await opened.open();
    assert.equal(
      Number(
        opened.database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
          .get(coldStartMs, COLD_END_MS).count,
      ),
      0,
      "the formal CLI must remove sealed events from the hot carrier",
    );
    assert.equal(
      Number(
        opened.database
          .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
          .get(coldStartMs, COLD_END_MS).count,
      ),
      0,
      "the formal CLI must move sealed Codex perf samples out of the hot carrier",
    );
    assert.deepEqual(dependencyRows(opened.database, coldKeys), [], "cold dependencies must cascade out of hot");
    assert.deepEqual(perfRows(opened.database, "ts_ms >= ?", COLD_END_MS), outOfRangeBefore);
    assert.deepEqual(perfRows(opened.database, "ts_ms IS NULL"), unplacedBefore);
    assert.deepEqual(dependencyRows(opened.database, retainedKeys), retainedDependenciesBefore);
    assert.deepEqual(retainedGraph(opened.database), graphBefore);
    assert.deepEqual(
      publicEvidence(await opened.summarizeHistory(PUBLIC_FILTERS), await opened.publishedHistoryUsageReport()),
      expected,
      "the committed Codex history must match the unarchived public oracle",
    );
    const committedSnapshot = logicalSnapshot(opened.database);
    opened.close();
    opened = null;

    const replay = await runCli(
      ["history", "archive", archivedFile, "--commit", candidateFile, "--backup", replayBundle, "--home-dir", homeDir],
      homeDir,
    );
    assert.equal(replay.code, 0, replay.output);
    assert.match(replay.output, /Deleted events: 0\b/);
    assert.match(replay.output, /Replay: yes\b/);
    await verifyPublishedHistoryArchiveBundle(replayBundle);

    opened = new UsageStore(archivedOptions);
    await opened.open();
    assert.deepEqual(
      logicalSnapshot(opened.database),
      committedSnapshot,
      "formal CLI replay must not change the committed logical database state",
    );
    assert.deepEqual(
      publicEvidence(await opened.summarizeHistory(PUBLIC_FILTERS), await opened.publishedHistoryUsageReport()),
      expected,
      "replay must preserve the complete public history oracle",
    );
  } finally {
    opened?.close();
    archived.close();
    oracle.close();
    fixture.close();
  }
});
