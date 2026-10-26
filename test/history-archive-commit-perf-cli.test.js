import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyPublishedHistoryArchiveBundle } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const PUBLIC_FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
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

function runCli(args, homeDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ...extraEnv },
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
    SNAPSHOT_TABLES.map((table) => [
      table,
      database
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
}

test("formal CLI moves ZCode perf with its archive commit and replays without changing the source", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "archive-commit-perf-cli.sqlite");
  const oracleFile = path.join(homeDir, "archive-commit-perf-cli-oracle.sqlite");
  const candidateFile = path.join(homeDir, "archive-commit-perf-cli-candidate.sqlite");
  const firstBundle = path.join(homeDir, "archive-commit-perf-cli-bundle-1");
  const replayBundle = path.join(homeDir, "archive-commit-perf-cli-bundle-2");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "archive-commit-perf-cli-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  let opened = null;
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    archived.close();

    const oracleReport = await oracle.publishedHistoryUsageReport();
    const oracleSummary = await oracle.summarizeHistory(PUBLIC_FILTERS);
    const expected = publicEvidence(oracleSummary, oracleReport);

    const first = await runCli(
      ["history", "archive", archivedFile, "--commit", candidateFile, "--backup", firstBundle, "--home-dir", homeDir],
      homeDir,
      { CODEX_USAGE_ZCODE_HOMES: fixture.reportOptions.extraZcodeHomes },
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
          .get(coldStartMs, HOT_START_MS).count,
      ),
      0,
      "the archive commit must remove the sealed events from the hot carrier",
    );
    assert.equal(
      Number(
        opened.database
          .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
          .get(coldStartMs, HOT_START_MS).count,
      ),
      0,
      "the archive commit must move the sealed perf samples out of the hot carrier",
    );
    assert.deepEqual(
      publicEvidence(await opened.summarizeHistory(PUBLIC_FILTERS), await opened.publishedHistoryUsageReport()),
      expected,
      "the committed cold events and perf must match the unarchived oracle",
    );
    const committedSnapshot = logicalSnapshot(opened.database);
    opened.close();
    opened = null;

    const replay = await runCli(
      ["history", "archive", archivedFile, "--commit", candidateFile, "--backup", replayBundle, "--home-dir", homeDir],
      homeDir,
      { CODEX_USAGE_ZCODE_HOMES: fixture.reportOptions.extraZcodeHomes },
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
      "a formal CLI replay must not change the committed logical database state",
    );
  } finally {
    opened?.close();
    archived.close();
    oracle.close();
    fixture.close();
  }
});
