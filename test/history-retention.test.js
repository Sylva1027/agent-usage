import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture, createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";
import { DEDUPE, toJsonl, withClaudeFile } from "../test-support/claude-perf-fixture.mjs";

const NOW = new Date("2026-10-22T00:00:00.000Z");

function countSamples(store, kind) {
  return Number(store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE source_kind = ?").get(kind).n);
}

function canonicalRowPayload(row) {
  const { id: _id, ...payload } = row;
  return JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function samplePayload(store, kind) {
  return store.database
    .prepare("SELECT * FROM perf_samples WHERE source_kind = ? ORDER BY sample_key")
    .all(kind)
    .map(({ source_path: _sourcePath, ...row }) => row);
}

function eventCountsByKind(store) {
  return store.database
    .prepare(
      `SELECT files.kind, COUNT(*) AS n
       FROM events
       JOIN source_files AS files ON files.path = events.source_path
       GROUP BY files.kind
       ORDER BY files.kind`,
    )
    .all()
    .map((row) => ({ ...row }));
}

function summaryPayload(store) {
  const summary = store.summarize({ preset: "all", now: NOW });
  return {
    eventCount: summary.eventCount,
    totals: summary.totals,
    groups: summary.perf.groups,
    coverage: summary.perf.coverage,
  };
}

function moveFixtureFile(from, to) {
  const info = statSync(from);
  copyFileSync(from, to);
  utimesSync(to, info.atime, info.mtime);
  unlinkSync(from);
}

function restoreFile(filePath, contents, info) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  utimesSync(filePath, info.atime, info.mtime);
}

function collectFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

test("Codex partial and whole-home loss retains history, dependency ownership, and a stable version", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const samplesBefore = samplePayload(store, "codex");
    const summaryBefore = summaryPayload(store);
    const initialVersion = store.perfState().indexVersion;
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 23);

    const [movedFrom] = fixture.rolloutFiles;
    const movedTo = movedFrom.replace(`${path.sep}sessions${path.sep}`, `${path.sep}archived_sessions${path.sep}`);
    mkdirSync(path.dirname(movedTo), { recursive: true });
    moveFixtureFile(movedFrom, movedTo);

    const moved = await store.sync({ options: fixture.reportOptions });
    const movedVersion = store.perfState().indexVersion;
    assert.equal(moved.perfState, "ready");
    assert.deepEqual(moved.missingSources, []);
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads WHERE source_path = ?").get(movedFrom).n,
      0,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads WHERE source_path = ?").get(movedTo).n,
      1,
    );
    assert.deepEqual(samplePayload(store, "codex"), samplesBefore);
    assert.deepEqual(summaryPayload(store), summaryBefore);
    assert.notEqual(movedVersion, initialVersion);

    const noOp = await store.sync({ options: fixture.reportOptions });
    assert.equal(noOp.updatedFileCount, 0);
    assert.equal(store.perfState().indexVersion, movedVersion);

    const missingPath = fixture.rolloutFiles[1];
    const missingInfo = statSync(missingPath);
    const missingContents = readFileSync(missingPath);
    rmSync(missingPath);
    const partial = await store.sync({ options: fixture.reportOptions });
    const partialVersion = store.perfState().indexVersion;
    assert.equal(partial.perfState, "ready");
    assert.deepEqual(
      partial.missingSources.map((source) => [source.path, source.kind]),
      [[missingPath, "extra"]],
    );
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads").get().n, 3);
    assert.deepEqual(samplePayload(store, "codex"), samplesBefore);
    assert.deepEqual(summaryPayload(store), summaryBefore);
    assert.deepEqual(store.summarize({ preset: "today", now: NOW }).perf.missingSources, partial.missingSources);
    assert.deepEqual(
      store.summarize({
        preset: "all",
        now: NOW,
        excludeHomes: [partial.missingSources[0].homeId],
      }).perf.missingSources,
      [],
    );
    assert.notEqual(partialVersion, movedVersion);

    const missingSinceMs = partial.missingSources[0].missingSinceMs;
    const missingNoOp = await store.sync({ options: fixture.reportOptions });
    assert.equal(missingNoOp.updatedFileCount, 0);
    assert.equal(store.perfState().indexVersion, partialVersion);
    assert.equal(store.perfState().missingSources[0].missingSinceMs, missingSinceMs);

    restoreFile(missingPath, missingContents, missingInfo);
    const recovered = await store.sync({ options: fixture.reportOptions });
    const recoveredVersion = store.perfState().indexVersion;
    assert.equal(recovered.perfState, "ready");
    assert.deepEqual(recovered.missingSources, []);
    assert.deepEqual(store.summarize({ preset: "all", now: NOW }).perf.missingSources, []);
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);
    assert.deepEqual(samplePayload(store, "codex"), samplesBefore);
    assert.deepEqual(summaryPayload(store), summaryBefore);
    assert.notEqual(recoveredVersion, partialVersion);

    const currentFiles = [movedTo, fixture.rolloutFiles[1], fixture.rolloutFiles[2]].sort();
    const backups = new Map(
      currentFiles.map((filePath) => {
        const info = statSync(filePath);
        return [filePath, { contents: readFileSync(filePath), info }];
      }),
    );
    rmSync(fixture.codexHome, { recursive: true });
    const homeGone = await store.sync({ options: fixture.reportOptions });
    assert.equal(homeGone.perfState, "ready");
    assert.deepEqual(homeGone.degradedHomeIds, []);
    assert.deepEqual(
      homeGone.missingSources.map((source) => source.path),
      currentFiles,
    );
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads").get().n, 3);
    assert.deepEqual(samplePayload(store, "codex"), samplesBefore);
    assert.deepEqual(summaryPayload(store), summaryBefore);

    for (const [filePath, backup] of backups) restoreFile(filePath, backup.contents, backup.info);
    const homeRestored = await store.sync({ options: fixture.reportOptions });
    assert.equal(homeRestored.perfState, "ready");
    assert.deepEqual(homeRestored.missingSources, []);
    assert.equal(store.perfState().indexVersion, recoveredVersion);
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);
    assert.deepEqual(samplePayload(store, "codex"), samplesBefore);
    assert.deepEqual(summaryPayload(store), summaryBefore);
  } finally {
    store.close();
    fixture.close();
  }
});

test("Codex compression transition replaces paths without duplicating facts", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    const [plainPath] = fixture.rolloutFiles;
    const resetsAt = Date.parse("2026-10-04T17:00:05.000Z") / 1000;
    appendFileSync(
      plainPath,
      `${JSON.stringify({
        timestamp: "2026-10-04T12:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
          rate_limits: {
            limit_id: "codex",
            primary: { window_minutes: 300, resets_at: resetsAt, used_percent: 37 },
            secondary: { window_minutes: 10080, resets_at: resetsAt + 7 * 24 * 60 * 60, used_percent: null },
          },
        },
      })}\n`,
    );
    await store.sync({ options: fixture.reportOptions });
    const samplesBefore = samplePayload(store, "codex");
    const summaryBefore = summaryPayload(store);
    const compressedPath = `${plainPath}.zst`;
    const oldSource = store.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
      .get(plainPath);
    const oldEvents = store.database.prepare("SELECT * FROM events WHERE source_path = ?").all(plainPath);
    const oldQuota = store.database
      .prepare("SELECT * FROM rate_limit_observations WHERE source_path = ? ORDER BY role")
      .all(plainPath);
    const eventCountBefore = Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n);
    const quotaCountBefore = Number(
      store.database.prepare("SELECT COUNT(*) AS n FROM rate_limit_observations").get().n,
    );
    assert.ok(oldSource);
    assert.ok(oldEvents.length > 0);
    assert.equal(oldQuota.length, 2);
    const info = statSync(plainPath);
    writeFileSync(compressedPath, zstdCompressSync(readFileSync(plainPath)));
    utimesSync(compressedPath, info.atime, info.mtime);
    unlinkSync(plainPath);

    const converted = await store.sync({ options: fixture.reportOptions });
    const convertedVersion = store.perfState().indexVersion;
    assert.equal(converted.perfState, "ready");
    assert.deepEqual(converted.missingSources, []);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(plainPath).n, 0);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(compressedPath).n,
      1,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events WHERE source_path = ?").get(plainPath).n, 0);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM events WHERE source_path = ?").get(compressedPath).n,
      oldEvents.length,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, eventCountBefore);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM rate_limit_observations WHERE source_path = ?").get(plainPath)
        .n,
      0,
    );
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS n FROM rate_limit_observations WHERE source_path = ?")
        .get(compressedPath).n,
      oldQuota.length,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM rate_limit_observations").get().n, quotaCountBefore);
    const restored = store.database
      .prepare(
        `SELECT source_kind, home_id, source_home_label, source_home_path, occurrence_count, payload
         FROM history_replaced_facts
         WHERE fact_table = 'events' AND source_path = ?`,
      )
      .all(plainPath)
      .map((row) => ({ ...row }));
    assert.ok(restored.length > 0);
    for (const row of restored) {
      assert.equal(row.source_kind, oldSource.kind);
      assert.equal(row.home_id, oldSource.home_id);
      assert.equal(row.source_home_label, oldSource.home_label);
      assert.equal(row.source_home_path, oldSource.home_path);
    }
    assert.deepEqual(
      restored
        .flatMap((row) =>
          Array.from({ length: Number(row.occurrence_count) }, () => canonicalRowPayload(JSON.parse(row.payload))),
        )
        .sort(),
      oldEvents.map(canonicalRowPayload).sort(),
    );
    const restoredQuota = store.database
      .prepare(
        `SELECT source_kind, home_id, source_home_label, source_home_path, method_version,
                occurrence_count, payload
         FROM history_replaced_facts
         WHERE fact_table = 'rate_limit_observations' AND source_path = ?`,
      )
      .all(plainPath)
      .map((row) => ({ ...row }));
    assert.ok(restoredQuota.length > 0);
    for (const row of restoredQuota) {
      assert.equal(row.source_kind, oldSource.kind);
      assert.equal(row.home_id, oldSource.home_id);
      assert.equal(row.source_home_label, oldSource.home_label);
      assert.equal(row.source_home_path, oldSource.home_path);
      assert.equal(row.method_version, "rate_limit_observations.v1");
    }
    const restoredQuotaPayloads = restoredQuota.flatMap((row) =>
      Array.from({ length: Number(row.occurrence_count) }, () => JSON.parse(row.payload)),
    );
    assert.deepEqual(restoredQuotaPayloads.map(canonicalRowPayload).sort(), oldQuota.map(canonicalRowPayload).sort());
    const restoredSecondary = restoredQuotaPayloads.find((payload) => payload.role === "secondary");
    assert.equal(restoredSecondary.source_path, plainPath);
    assert.equal(restoredSecondary.used_percent, null);
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);
    assert.deepEqual(samplePayload(store, "codex"), samplesBefore);
    assert.deepEqual(summaryPayload(store), summaryBefore);

    const historySnapshot = {
      ...store.database
        .prepare(
          "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
        )
        .get(),
    };
    const noOp = await store.sync({ options: fixture.reportOptions });
    assert.equal(noOp.updatedFileCount, 0);
    assert.equal(store.perfState().indexVersion, convertedVersion);
    assert.deepEqual(store.perfState().missingSources, []);
    assert.deepEqual(
      {
        ...store.database
          .prepare(
            "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
          )
          .get(),
      },
      historySnapshot,
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("Codex partial rollout loss retains old turns while a surviving rollout ingests a new turn", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const initialSamples = samplePayload(store, "codex");
    const initialKeys = new Set(initialSamples.map((sample) => sample.sample_key));
    const initialSummary = summaryPayload(store);

    const missingPath = fixture.rolloutFiles[1];
    rmSync(missingPath);
    const partial = await store.sync({ options: fixture.reportOptions });
    assert.equal(partial.perfState, "ready");
    assert.deepEqual(
      partial.missingSources.map((source) => [source.path, source.kind]),
      [[missingPath, "extra"]],
    );
    assert.deepEqual(samplePayload(store, "codex"), initialSamples);
    assert.deepEqual(summaryPayload(store), initialSummary);

    const threadId = "fixture-codex-thread";
    const turnId = "turn-26";
    const responseId = "response-26-1";
    const base = Date.parse("2026-10-04T12:00:00.000Z");
    const startedAtMs = base + 26 * 10000;
    const activePath = fixture.rolloutFiles[2];
    appendFileSync(
      activePath,
      `${[
        {
          type: "turn_context",
          payload: { thread_id: threadId, turn_id: turnId, model: "codex-fixture-model", effort: "high" },
        },
        {
          type: "token_usage_record",
          timestamp: new Date(startedAtMs + 2500).toISOString(),
          payload: {
            thread_id: threadId,
            turn_id: turnId,
            response_id: responseId,
            usage: { output_tokens: 77 },
            turn_token_usage: { output_tokens: 77 },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: threadId,
            turn_id: turnId,
            started_at_ms: startedAtMs,
            completed_at_ms: startedAtMs + 1234,
            item: { id: "item-26", type: "AgentMessage" },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            thread_id: threadId,
            turn_id: turnId,
            started_at: Math.floor(startedAtMs / 1000),
            completed_at: Math.floor((startedAtMs + 1234) / 1000),
            duration_ms: 1234,
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const advanced = await store.sync({ options: fixture.reportOptions });
    assert.equal(advanced.perfState, "ready");
    assert.deepEqual(
      advanced.missingSources.map((source) => [source.path, source.kind]),
      [[missingPath, "extra"]],
    );

    const samplesAfter = samplePayload(store, "codex");
    assert.equal(samplesAfter.length, initialSamples.length + 1);
    assert.deepEqual(
      samplesAfter.filter((sample) => initialKeys.has(sample.sample_key)),
      initialSamples,
    );
    const newSample = samplesAfter.find((sample) => !initialKeys.has(sample.sample_key));
    assert.ok(newSample);
    assert.equal(
      newSample.sample_key,
      JSON.stringify(["codex", initialSamples[0].home_id, threadId, turnId, responseId]),
    );
    assert.equal(newSample.model, "codex-fixture-model");
    assert.equal(newSample.model_evidence, "turn_context");
    assert.equal(newSample.output_tokens, null, "the surviving rollout adds a candidate without generation evidence");
    assert.equal(newSample.duration_ms, null);
    assert.equal(newSample.timing_kind, "generation");
    assert.equal(newSample.status, "completed");
    assert.equal(newSample.request_count, 1);
    assert.equal(newSample.item_count, 0, "a turn item without response ownership is not assigned to the new request");
    assert.equal(newSample.ts_ms, startedAtMs + 2500);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE sample_key = ?").get(newSample.sample_key).n,
      1,
    );
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS n FROM perf_sample_sources WHERE sample_key = ?")
        .get(newSample.sample_key).n,
      2,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 80);
  } finally {
    store.close();
    fixture.close();
  }
});

test("Codex thread publication retains replaced samples and dependencies", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    store.database.prepare("DELETE FROM history_replaced_facts").run();
    const threadId = "fixture-codex-thread";
    const sampleKey = JSON.stringify([
      "codex",
      store.database.prepare("SELECT home_id FROM perf_samples LIMIT 1").get().home_id,
      threadId,
      "turn-24",
      "response-24-1",
    ]);
    const oldSample = store.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(sampleKey);
    assert.equal(oldSample.output_tokens, 123);
    assert.equal(oldSample.duration_ms, 1000);
    assert.equal(oldSample.source_path, fixture.rolloutFiles[0]);

    store.database
      .prepare("UPDATE perf_sample_sources SET role = 'dependency' WHERE sample_key = ? AND source_path = ?")
      .run(sampleKey, oldSample.source_path);
    const oldDependencies = store.database
      .prepare("SELECT * FROM perf_sample_sources WHERE sample_key = ? ORDER BY source_path")
      .all(sampleKey);
    const oldSource = store.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
      .get(oldSample.source_path);
    assert.ok(oldSource);
    assert.equal(oldDependencies.length, 3);

    const rolloutPath = fixture.rolloutFiles[2];
    const rolloutRows = readFileSync(rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const row of rolloutRows) {
      if (row.payload?.turn_id !== "turn-24") continue;
      if (row.type === "token_usage_record") {
        row.timestamp = new Date(Date.parse(row.timestamp) + 2000).toISOString();
      }
    }
    writeFileSync(rolloutPath, `${rolloutRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const changed = await store.sync({ options: fixture.reportOptions });
    assert.equal(changed.updatedFileCount, 1);

    const liveSample = store.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(sampleKey);
    assert.equal(liveSample.output_tokens, 123);
    assert.equal(liveSample.duration_ms, 1000);
    assert.equal(liveSample.ts_ms, oldSample.ts_ms + 2000);
    assert.equal(countSamples(store, "codex"), 26);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources").get().n, 78);

    const replacedFacts = store.database
      .prepare(
        `SELECT fact_table, source_kind, home_id, source_home_label, source_home_path,
                method_version, occurrence_count, payload
         FROM history_replaced_facts
         WHERE source_path = ? AND fact_table IN ('perf_samples', 'perf_sample_sources')`,
      )
      .all(oldSource.path)
      .map((row) => ({ ...row }));
    const sampleFacts = replacedFacts.filter((row) => row.fact_table === "perf_samples");
    const dependencyFacts = replacedFacts.filter((row) => row.fact_table === "perf_sample_sources");
    assert.equal(sampleFacts.length, 1);
    assert.equal(dependencyFacts.length, 1);
    for (const row of replacedFacts) {
      assert.equal(row.source_kind, oldSource.kind);
      assert.equal(row.home_id, oldSource.home_id);
      assert.equal(row.source_home_label, oldSource.home_label);
      assert.equal(row.source_home_path, oldSource.home_path);
      assert.equal(row.method_version, PERF_METHOD_VERSION);
    }
    const oldSamplePayload = JSON.parse(sampleFacts[0].payload);
    assert.deepEqual(canonicalRowPayload(oldSamplePayload), canonicalRowPayload(oldSample));
    assert.equal(oldSamplePayload.ts_ms, oldSample.ts_ms);
    assert.equal(oldSamplePayload.duration_ms, 1000);
    assert.equal(oldSamplePayload.diagnostic_reason_chain, oldSample.diagnostic_reason_chain);
    const nullField = Object.keys(oldSample).find((field) => oldSample[field] === null);
    assert.ok(nullField);
    assert.equal(oldSamplePayload[nullField], null);
    assert.equal(
      canonicalRowPayload(JSON.parse(dependencyFacts[0].payload)),
      canonicalRowPayload(oldDependencies.find((row) => row.source_path === oldSource.path)),
    );

    const historySnapshot = {
      ...store.database
        .prepare(
          "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
        )
        .get(),
    };
    const noOp = await store.sync({ options: fixture.reportOptions });
    assert.equal(noOp.updatedFileCount, 0);
    assert.deepEqual(
      {
        ...store.database
          .prepare(
            "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
          )
          .get(),
      },
      historySnapshot,
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("Codex request timing evidence remains unchanged by a real reparse", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const homeId = String(
      store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.codexHome)).id,
    );
    const threadId = "fixture-codex-thread";
    const responseId = "response-24-1";
    const readEvidence = () =>
      store.database
        .prepare(
          `SELECT * FROM perf_request_timing_evidence
           WHERE home_id = ? AND response_id = ?
           ORDER BY evidence_origin, variant_key`,
        )
        .all(homeId, responseId)
        .map((row) => ({ ...row }));
    const readLinks = () =>
      store.database
        .prepare(
          `SELECT * FROM perf_request_timing_threads
           WHERE home_id = ? AND response_id = ?
           ORDER BY thread_id`,
        )
        .all(homeId, responseId)
        .map((row) => ({ ...row }));
    const evidenceBefore = readEvidence();
    const linksBefore = readLinks();
    assert.equal(evidenceBefore.length, 1);
    assert.equal(linksBefore.length, 1);

    const rolloutPath = fixture.rolloutFiles[2];
    const rolloutRows = readFileSync(rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const row of rolloutRows) {
      if (row.payload?.turn_id !== "turn-24") continue;
      if (row.type === "token_usage_record") {
        row.timestamp = new Date(Date.parse(row.timestamp) + 2000).toISOString();
      }
    }
    writeFileSync(rolloutPath, `${rolloutRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const changed = await store.sync({ options: fixture.reportOptions });
    assert.equal(changed.updatedFileCount, 1);
    assert.deepEqual(readEvidence(), evidenceBefore);
    assert.deepEqual(readLinks(), linksBefore);
    assert.deepEqual(store.lookupRequestTiming({ homeId, threadId, turnId: "turn-24", responseId }), {
      state: "available",
      durationMs: 1500,
      reportedOutputTokens: 123,
      requestedModel: "codex-fixture-model",
      generation: {
        outputTokens: 123,
        durationMs: 1000,
        startOutputTokens: 0,
        timingKind: "explicit",
      },
    });
  } finally {
    store.close();
    fixture.close();
  }
});

test("WorkBuddy duration observations survive a real source reparse", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-retention-workbuddy-"));
  const workbuddyHome = path.join(root, ".workbuddy-ai");
  const workbuddyFile = path.join(workbuddyHome, "projects", "fixture", "fixture-session.jsonl");
  const traceFile = path.join(workbuddyHome, "traces", "fixture", "trace_fixture.jsonl");
  const usage = (outputTokens) => ({
    timestamp: 1792537466382,
    type: "function_call",
    providerData: {
      messageId: "workbuddy-message",
      model: "deepseek-v4.1-flash",
      usage: { inputTokens: 1000, outputTokens, totalTokens: 1000 + outputTokens },
    },
    sessionId: "workbuddy-session",
    cwd: "/work/fixture",
  });
  const span = (duration) => ({
    type: "span_end",
    span: {
      traceId: "trace_1",
      spanId: "span_1",
      name: "generation",
      type: "generation",
      endedAt: "2026-10-21T00:08:56.704Z",
      duration,
      status: "ok",
      toolOutput: JSON.stringify([{ id: "workbuddy-message" }]),
    },
  });
  mkdirSync(path.dirname(workbuddyFile), { recursive: true });
  mkdirSync(path.dirname(traceFile), { recursive: true });
  writeFileSync(workbuddyFile, toJsonl([usage(200)]));
  writeFileSync(traceFile, toJsonl([span(900)]));
  const initialMtimeMs = Math.max(statSync(workbuddyFile).mtimeMs, statSync(traceFile).mtimeMs);

  const store = new UsageStore({
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "history-retention.sqlite"),
  });
  const options = { homeDir: root, env: {} };
  try {
    await store.sync({ options });
    assert.deepEqual(
      store.database
        .prepare("SELECT duration_ms FROM workbuddy_generation_duration_observations ORDER BY duration_ms")
        .all()
        .map((row) => row.duration_ms),
      [900],
    );
    const initialSample = store.database
      .prepare("SELECT output_tokens, duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'")
      .get();
    assert.ok(initialSample);
    assert.equal(initialSample.output_tokens, null);
    assert.equal(initialSample.duration_ms, null);

    writeFileSync(workbuddyFile, toJsonl([usage(201)]));
    writeFileSync(traceFile, toJsonl([span(850)]));
    const changedTime = new Date(initialMtimeMs + 2000);
    utimesSync(workbuddyFile, changedTime, changedTime);
    utimesSync(traceFile, changedTime, changedTime);
    const changed = await store.sync({ options });
    assert.equal(changed.updatedFileCount, 1);

    const source = store.database.prepare("SELECT path, home_id FROM source_files WHERE path = ?").get(workbuddyFile);
    assert.ok(source);
    assert.deepEqual(
      store.database
        .prepare(
          `SELECT home_id, message_id, duration_ms
           FROM workbuddy_generation_duration_observations
           WHERE home_id = ? AND message_id = ?
           ORDER BY duration_ms`,
        )
        .all(source.home_id, "workbuddy-message")
        .map((row) => ({ ...row })),
      [
        { home_id: source.home_id, message_id: "workbuddy-message", duration_ms: 850 },
        { home_id: source.home_id, message_id: "workbuddy-message", duration_ms: 900 },
      ],
    );
    const changedSample = store.database
      .prepare("SELECT output_tokens, duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'")
      .get();
    assert.ok(changedSample);
    assert.equal(changedSample.output_tokens, null);
    assert.equal(changedSample.duration_ms, null);
    assert.equal(countSamples(store, "workbuddy"), 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude and WorkBuddy file loss retain usage and samples independently", async () => {
  await withClaudeFile(
    DEDUPE.rows,
    async ({ root, files }) => {
      const claudeFile = files[0];
      const workbuddyHome = path.join(root, ".workbuddy-ai");
      const workbuddyProject = path.join(workbuddyHome, "projects", "fixture");
      const workbuddyFile = path.join(workbuddyProject, "fixture-session.jsonl");
      const traceFile = path.join(workbuddyHome, "traces", "fixture", "trace_fixture.jsonl");
      mkdirSync(workbuddyProject, { recursive: true });
      mkdirSync(path.dirname(traceFile), { recursive: true });
      writeFileSync(
        workbuddyFile,
        toJsonl([
          {
            timestamp: 1792537466382,
            type: "function_call",
            providerData: {
              messageId: "workbuddy-message",
              model: "deepseek-v4.1-flash",
              usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
            },
            sessionId: "workbuddy-session",
            cwd: "/work/fixture",
          },
        ]),
      );
      writeFileSync(
        traceFile,
        toJsonl([
          {
            type: "span_end",
            span: {
              traceId: "trace_1",
              spanId: "span_1",
              name: "generation",
              type: "generation",
              endedAt: "2026-10-21T00:08:56.704Z",
              duration: 15455,
              status: "ok",
              toolOutput: JSON.stringify([{ id: "workbuddy-message" }]),
            },
          },
        ]),
      );

      const store = new UsageStore({
        homeDir: root,
        env: {},
        databaseFile: path.join(root, "history-retention.sqlite"),
      });
      try {
        const options = { homeDir: root, env: {} };
        await store.sync({ options });
        const eventsBefore = eventCountsByKind(store);
        assert.equal(countSamples(store, "claude"), 1);
        assert.equal(countSamples(store, "workbuddy"), 1);

        const oldSample = store.database.prepare("SELECT * FROM perf_samples WHERE source_kind = 'claude'").get();
        const oldSource = store.database
          .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
          .get(claudeFile);
        assert.ok(oldSample);
        assert.ok(oldSource);
        store.database
          .prepare(
            "INSERT INTO perf_sample_sources (sample_key, source_path, role) VALUES (?, ?, 'primary'), (?, ?, 'dependency')",
          )
          .run(oldSample.sample_key, claudeFile, oldSample.sample_key, workbuddyFile);
        const oldDependencies = store.database
          .prepare("SELECT * FROM perf_sample_sources WHERE sample_key = ? ORDER BY source_path")
          .all(oldSample.sample_key);
        assert.equal(oldDependencies.length, 2);

        const changedRows = structuredClone(DEDUPE.rows);
        const lastAssistant = changedRows.at(-1);
        lastAssistant.timestamp = new Date(Date.parse(lastAssistant.timestamp) + 5000).toISOString();
        lastAssistant.message.usage.output_tokens = 300;
        writeFileSync(claudeFile, toJsonl(changedRows));

        const changed = await store.sync({ options });
        assert.equal(changed.updatedFileCount, 1);
        const liveSample = store.database
          .prepare("SELECT * FROM perf_samples WHERE sample_key = ?")
          .get(oldSample.sample_key);
        assert.equal(liveSample.duration_ms, null);
        assert.equal(liveSample.output_tokens, null);
        assert.equal(
          store.database
            .prepare("SELECT COUNT(*) AS n FROM perf_sample_sources WHERE sample_key = ?")
            .get(oldSample.sample_key).n,
          0,
        );

        const replacedFacts = store.database
          .prepare(
            `SELECT fact_table, source_kind, home_id, source_home_label, source_home_path,
                    method_version, occurrence_count, payload
             FROM history_replaced_facts
             WHERE source_path = ? AND fact_table IN ('perf_samples', 'perf_sample_sources')`,
          )
          .all(claudeFile)
          .map((row) => ({ ...row }));
        const sampleFacts = replacedFacts.filter((row) => row.fact_table === "perf_samples");
        const dependencyFacts = replacedFacts.filter((row) => row.fact_table === "perf_sample_sources");
        assert.equal(sampleFacts.length, 1);
        assert.equal(dependencyFacts.length, 2);
        for (const row of replacedFacts) {
          assert.equal(row.source_kind, oldSource.kind);
          assert.equal(row.home_id, oldSource.home_id);
          assert.equal(row.source_home_label, oldSource.home_label);
          assert.equal(row.source_home_path, oldSource.home_path);
          assert.equal(row.method_version, PERF_METHOD_VERSION);
        }
        const oldSamplePayload = JSON.parse(sampleFacts[0].payload);
        assert.deepEqual(canonicalRowPayload(oldSamplePayload), canonicalRowPayload(oldSample));
        assert.equal(oldSamplePayload.sample_key, oldSample.sample_key);
        assert.equal(oldSamplePayload.method_version, oldSample.method_version);
        assert.equal(oldSamplePayload.diagnostic_reason_chain, oldSample.diagnostic_reason_chain);
        const nullField = Object.keys(oldSample).find((field) => oldSample[field] === null);
        assert.ok(nullField);
        assert.equal(oldSamplePayload[nullField], null);
        assert.deepEqual(
          dependencyFacts.map((row) => canonicalRowPayload(JSON.parse(row.payload))).sort(),
          oldDependencies.map(canonicalRowPayload).sort(),
        );

        const historySnapshot = {
          ...store.database
            .prepare(
              "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
            )
            .get(),
        };
        const noOp = await store.sync({ options });
        assert.equal(noOp.updatedFileCount, 0);
        assert.deepEqual(
          {
            ...store.database
              .prepare(
                "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
              )
              .get(),
          },
          historySnapshot,
        );

        const claudeInfo = statSync(claudeFile);
        const claudeContents = readFileSync(claudeFile);
        rmSync(claudeFile);
        const claudeMissing = await store.sync({ options });
        assert.equal(claudeMissing.perfState, "ready");
        assert.deepEqual(
          claudeMissing.missingSources.map((source) => [source.path, source.kind]),
          [[claudeFile, "claude"]],
        );
        assert.equal(countSamples(store, "claude"), 1);
        assert.equal(countSamples(store, "workbuddy"), 1);
        assert.deepEqual(eventCountsByKind(store), eventsBefore);

        const workbuddyInfo = statSync(workbuddyFile);
        const workbuddyContents = readFileSync(workbuddyFile);
        rmSync(workbuddyFile);
        const bothMissing = await store.sync({ options });
        assert.equal(bothMissing.perfState, "ready");
        assert.deepEqual(
          bothMissing.missingSources.map((source) => [source.path, source.kind]).sort(),
          [
            [claudeFile, "claude"],
            [workbuddyFile, "workbuddy"],
          ].sort(),
        );
        assert.equal(countSamples(store, "claude"), 1);
        assert.equal(countSamples(store, "workbuddy"), 1);
        assert.deepEqual(eventCountsByKind(store), eventsBefore);

        restoreFile(claudeFile, claudeContents, claudeInfo);
        const claudeRestored = await store.sync({ options });
        assert.equal(claudeRestored.perfState, "ready");
        assert.deepEqual(
          claudeRestored.missingSources.map((source) => source.path),
          [workbuddyFile],
        );
        assert.equal(countSamples(store, "claude"), 1);
        assert.equal(countSamples(store, "workbuddy"), 1);
        assert.deepEqual(eventCountsByKind(store), eventsBefore);

        restoreFile(workbuddyFile, workbuddyContents, workbuddyInfo);
        const allRestored = await store.sync({ options });
        assert.equal(allRestored.perfState, "ready");
        assert.deepEqual(allRestored.missingSources, []);
        assert.equal(countSamples(store, "claude"), 1);
        assert.equal(countSamples(store, "workbuddy"), 1);
        assert.deepEqual(eventCountsByKind(store), eventsBefore);
      } finally {
        store.close();
      }
    },
    { dirs: [".claude", "projects", "fixture-project"] },
  );
});

test("ZCode, DSH, and OpenCode loss does not block new data; unreadable stays distinct from missing", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const eventsBefore = eventCountsByKind(store);
    const sampleCountsBefore = {
      zcode: countSamples(store, "zcode"),
      dsh: countSamples(store, "dsh"),
      opencode: countSamples(store, "opencode"),
    };
    const opencodeSamplesBefore = samplePayload(store, "opencode");

    const zcodeHomes = fixture.reportOptions.extraZcodeHomes.split(path.delimiter);
    const removedZcodeHome = zcodeHomes[0];
    const removedZcodeDb = path.join(removedZcodeHome, "cli", "db", "db.sqlite");
    rmSync(removedZcodeHome, { recursive: true });

    const dshHome = fixture.reportOptions.extraDshHomes;
    const removedDshFile = collectFiles(dshHome).find((filePath) => filePath.endsWith(".jsonl.zstd"));
    assert.ok(removedDshFile);
    rmSync(removedDshFile);

    const opencodeHome = fixture.reportOptions.extraOpencodeHomes;
    const removedOpencodeDb = path.join(opencodeHome, "opencode-extra.db");
    rmSync(removedOpencodeDb);

    const missing = await store.sync({ options: fixture.reportOptions });
    const expectedMissing = [removedZcodeDb, removedDshFile, removedOpencodeDb].sort();
    assert.equal(missing.perfState, "ready");
    assert.deepEqual(missing.degradedHomeIds, []);
    assert.deepEqual(
      missing.missingSources.map((source) => source.path),
      expectedMissing,
    );
    assert.equal(countSamples(store, "zcode"), sampleCountsBefore.zcode);
    assert.equal(countSamples(store, "dsh"), sampleCountsBefore.dsh);
    assert.equal(countSamples(store, "opencode"), sampleCountsBefore.opencode);
    assert.deepEqual(eventCountsByKind(store), eventsBefore);

    const activeZcodeDb = path.join(zcodeHomes[1], "cli", "db", "db.sqlite");
    const writer = new DatabaseSync(activeZcodeDb);
    try {
      const columns = writer
        .prepare("PRAGMA table_info(model_usage)")
        .all()
        .map((row) => String(row.name));
      const source = writer.prepare("SELECT * FROM model_usage LIMIT 1").get();
      const values = columns.map((column) => (column === "id" ? "retention-new-row" : source[column]));
      writer
        .prepare(`INSERT INTO model_usage (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...values);
    } finally {
      writer.close();
    }

    const active = await store.sync({ options: fixture.reportOptions });
    assert.equal(active.perfState, "ready");
    assert.deepEqual(
      active.missingSources.map((source) => source.path),
      expectedMissing,
    );
    assert.equal(countSamples(store, "zcode"), sampleCountsBefore.zcode + 1);
    assert.equal(countSamples(store, "dsh"), sampleCountsBefore.dsh);
    assert.equal(countSamples(store, "opencode"), sampleCountsBefore.opencode);
    assert.ok(
      eventCountsByKind(store).find((row) => row.kind === "zcode").n >
        eventsBefore.find((row) => row.kind === "zcode").n,
    );

    writeFileSync(path.join(opencodeHome, "opencode.db"), "not a sqlite database");
    const unreadable = await store.sync({ options: fixture.reportOptions });
    assert.equal(unreadable.perfState, "degraded");
    assert.ok(unreadable.degradedHomeIds.length > 0);
    assert.deepEqual(
      unreadable.missingSources.map((source) => source.path),
      expectedMissing,
    );
    assert.equal(countSamples(store, "opencode"), sampleCountsBefore.opencode);
    assert.deepEqual(samplePayload(store, "opencode"), opencodeSamplesBefore);
  } finally {
    store.close();
    fixture.close();
  }
});

test("A failed replacement does not authorize deleting a previously retained source identity", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const dshHome = fixture.reportOptions.extraDshHomes;
    const replacement = collectFiles(dshHome).find((filePath) => filePath.endsWith(".jsonl.zstd"));
    assert.ok(replacement);
    const replacementRow = store.database
      .prepare("SELECT kind, home_id, home_label, home_path, size, mtime_ms FROM source_files WHERE path = ?")
      .get(replacement);
    const removedPath = path.join(path.dirname(replacement), "retained-source", "session.v4.jsonl.zstd");

    store.database
      .prepare(`
        INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        removedPath,
        replacementRow.kind,
        replacementRow.home_id,
        replacementRow.home_label,
        replacementRow.home_path,
        replacementRow.size,
        replacementRow.mtime_ms,
        new Date().toISOString(),
      );
    const fingerprints = JSON.parse(store.readMeta("perf_file_fingerprints"));
    fingerprints[removedPath] = fingerprints[replacement];
    store.writeMeta("perf_file_fingerprints", JSON.stringify(fingerprints));
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(replacement);

    const replaceFile = store.replaceFile.bind(store);
    store.replaceFile = async (file, options) => {
      if (file.filePath === replacement) throw new Error("injected replacement failure");
      return replaceFile(file, options);
    };
    let failed;
    try {
      failed = await store.sync({ options: fixture.reportOptions });
    } finally {
      store.replaceFile = replaceFile;
    }

    assert.equal(failed.perfState, "degraded");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(removedPath).n, 1);
    assert.ok(failed.missingSources.some((source) => source.path === removedPath));
  } finally {
    store.close();
    fixture.close();
  }
});

test("Equal size and mtime do not authorize a generic rename without content fingerprints", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-retention-mtime-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const fixedTime = new Date("2026-07-12T02:00:00.000Z");
    const usageLine = (sessionId) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        model: "gpt-6-luna",
        usage: { total: 10, input: 8, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    const currentContents = usageLine("new-session");
    const oldContents = usageLine("old-session");
    assert.equal(Buffer.byteLength(oldContents), Buffer.byteLength(currentContents));
    assert.notEqual(oldContents, currentContents);

    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, currentContents);
    utimesSync(usageFile, fixedTime, fixedTime);
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
    try {
      await store.sync({ options });
      const currentInfo = statSync(usageFile);
      const currentRow = store.database
        .prepare("SELECT kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(usageFile);
      const removedPath = path.join(importDir, "old-usage.jsonl");
      writeFileSync(removedPath, oldContents);
      utimesSync(removedPath, fixedTime, fixedTime);
      const oldInfo = statSync(removedPath);
      assert.equal(oldInfo.size, currentInfo.size);
      assert.equal(oldInfo.mtimeMs, currentInfo.mtimeMs);
      store.database
        .prepare(`
          INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          removedPath,
          currentRow.kind,
          currentRow.home_id,
          currentRow.home_label,
          currentRow.home_path,
          oldInfo.size,
          oldInfo.mtimeMs,
          new Date().toISOString(),
        );
      rmSync(removedPath);

      // Force the current file through replaceFile so a false rename would be
      // treated as committed; only content fingerprints may authorize it.
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      const round = await store.sync({ options });
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(removedPath).n,
        1,
      );
      assert.ok(round.missingSources.some((source) => source.path === removedPath));
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Removing an import directory retains its usage history and restores without duplication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-retention-import-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: "import-session",
        model: "gpt-6-luna",
        usage: { total: 10, input: 8, cached: 0, output: 2, reasoning: 0 },
      })}\n`,
    );
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
    try {
      await store.sync({ options });
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);

      const removed = await store.sync({ options: { ...options, importDirs: [] } });
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
      assert.deepEqual(
        removed.missingSources.map((source) => [source.path, source.kind]),
        [[usageFile, "project-log"]],
      );

      const restored = await store.sync({ options });
      assert.deepEqual(restored.missingSources, []);
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UsageStore applies the WAL journal size limit on every open", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-retention-wal-limit-"));
  const options = { homeDir: root, env: {}, importDirs: [] };
  const databaseFile = path.join(root, "index.sqlite");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new UsageStore({ ...options, databaseFile });
      try {
        await store.open();
        assert.equal(Number(store.database.prepare("PRAGMA journal_size_limit").get().journal_size_limit), 67108864);
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reparse stores one recoverable old event fact for an old10-to-new20 replacement", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-replace-facts-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const usageLine = (sessionId, total) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        model: "gpt-6-luna",
        usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${usageLine("old-session", 10)}${usageLine("old-session", 10)}`);
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const databaseFile = path.join(root, "index.sqlite");
    const store = new UsageStore({ ...options, databaseFile });
    try {
      await store.sync({ options });
      assert.deepEqual(
        store.database
          .prepare("SELECT session_id, total FROM events WHERE source_path = ?")
          .all(usageFile)
          .map((row) => ({ ...row })),
        [
          { session_id: "old-session", total: 10 },
          { session_id: "old-session", total: 10 },
        ],
      );

      writeFileSync(usageFile, usageLine("new-session", 20));
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options });

      assert.deepEqual(
        store.database
          .prepare("SELECT session_id, total FROM events WHERE source_path = ?")
          .all(usageFile)
          .map((row) => ({ ...row })),
        [{ session_id: "new-session", total: 20 }],
      );
      const replaced = store.database
        .prepare(`
          SELECT fact_table, source_kind, source_path, method_version, revision_reason, occurrence_count, payload
          FROM history_replaced_facts
        `)
        .all()
        .map((row) => ({ ...row }));
      assert.equal(replaced.length, 1);
      assert.equal(replaced[0].fact_table, "events");
      assert.equal(replaced[0].source_kind, "project-log");
      assert.equal(replaced[0].source_path, usageFile);
      assert.equal(replaced[0].method_version, "events.v1");
      assert.equal(replaced[0].revision_reason, "reparse_replaced");
      assert.equal(replaced[0].occurrence_count, 2);
      const payload = JSON.parse(replaced[0].payload);
      assert.equal(payload.session_id, "old-session");
      assert.equal(payload.total, 10);
      assert.equal(payload.source_path, usageFile);
      assert.equal(Object.hasOwn(payload, "id"), false);

      writeFileSync(usageFile, `${usageLine("new-session", 20)}${usageLine("append-session", 30)}`);
      await store.sync({ options });
      const stableHistory = store.database
        .prepare("SELECT COUNT(*) AS n, MAX(occurrence_count) AS occurrence_count FROM history_replaced_facts")
        .get();
      assert.equal(stableHistory.n, 1);
      assert.equal(stableHistory.occurrence_count, 2);
    } finally {
      store.close();
    }
    const v19 = new DatabaseSync(databaseFile);
    try {
      v19.exec("DROP TABLE history_replaced_facts; PRAGMA user_version = 19;");
    } finally {
      v19.close();
    }
    const migrated = new UsageStore({ ...options, databaseFile });
    try {
      await migrated.open();
      assert.equal(migrated.database.prepare("PRAGMA user_version").get().user_version, 23);
      assert.equal(
        migrated.database.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('history_replaced_facts')").get().n,
        12,
      );
      assert.equal(
        migrated.database.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('archive_segments')").get().n,
        7,
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reparse retains one missing duplicate occurrence without accumulating on repeat", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-duplicate-count-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const usageLine = `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-07-12T02:00:00.000Z",
      source: "test",
      channel: "Test",
      project_root: "/work/import",
      cwd: "/work/import",
      session_id: "same-session",
      model: "gpt-6-luna",
      usage: { total: 10, input: 8, cached: 0, output: 2, reasoning: 0 },
    })}\n`;
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${usageLine}${usageLine}`);
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
    const forceSync = async () => {
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options });
    };
    const liveEvents = () =>
      store.database
        .prepare("SELECT session_id, total FROM events WHERE source_path = ?")
        .all(usageFile)
        .map((row) => ({ ...row }));
    const replacedFacts = () =>
      store.database
        .prepare("SELECT occurrence_count, payload FROM history_replaced_facts ORDER BY payload_digest")
        .all()
        .map((row) => ({ occurrence_count: Number(row.occurrence_count), payload: JSON.parse(row.payload) }));
    try {
      await store.sync({ options });
      assert.deepEqual(liveEvents(), [
        { session_id: "same-session", total: 10 },
        { session_id: "same-session", total: 10 },
      ]);

      writeFileSync(usageFile, usageLine);
      await forceSync();
      assert.deepEqual(liveEvents(), [{ session_id: "same-session", total: 10 }]);
      assert.equal(replacedFacts().length, 1);
      assert.equal(replacedFacts()[0].occurrence_count, 1);
      assert.equal(replacedFacts()[0].payload.session_id, "same-session");
      assert.equal(replacedFacts()[0].payload.total, 10);

      await forceSync();
      assert.equal(replacedFacts()[0].occurrence_count, 1);

      writeFileSync(usageFile, `${usageLine}${usageLine}`);
      await forceSync();
      writeFileSync(usageFile, usageLine);
      await forceSync();
      assert.equal(replacedFacts().length, 1);
      assert.equal(replacedFacts()[0].occurrence_count, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stable project-log truncation is not silently accepted", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-truncation-oracle-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const usageLine = (sessionId, total, second) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: new Date(Date.parse("2026-07-12T02:00:00.000Z") + second * 1000).toISOString(),
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        request_id: `request-${sessionId}`,
        model: "gpt-6-luna",
        usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    const keptLine = usageLine("kept-session", 10, 0);
    const droppedLine = usageLine("dropped-session", 20, 1);
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${keptLine}\n${droppedLine}`);
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const databaseFile = path.join(root, "index.sqlite");
    const store = new UsageStore({ ...options, databaseFile });
    const events = () =>
      store.database
        .prepare("SELECT session_id, total FROM events WHERE source_path = ? ORDER BY timestamp_ms")
        .all(usageFile)
        .map((row) => ({ ...row }));
    const historyCounts = () => {
      const row = store.database
        .prepare(
          "SELECT COUNT(*) AS rows, COALESCE(SUM(occurrence_count), 0) AS occurrences FROM history_replaced_facts",
        )
        .get();
      return { rows: Number(row.rows), occurrences: Number(row.occurrences) };
    };
    const isTruncationWarning = (warning) => String(warning).includes("来源文件缩短（截断）");
    let truncated;
    let observedWarnings;
    try {
      await store.sync({ options });
      assert.deepEqual(events(), [
        { session_id: "kept-session", total: 10 },
        { session_id: "dropped-session", total: 20 },
      ]);

      writeFileSync(usageFile, keptLine);
      store.database.exec(`
        CREATE TRIGGER history_truncation_fail
        BEFORE INSERT ON history_replaced_facts
        BEGIN
          SELECT RAISE(ABORT, 'injected history failure');
        END;
      `);
      await store.sync({ options: { ...options, force: true } });
      assert.ok(store.warnings.some((warning) => warning.includes("injected history failure")));
      assert.equal(store.warnings.some(isTruncationWarning), false, JSON.stringify(store.warnings));
      assert.deepEqual(events(), [
        { session_id: "kept-session", total: 10 },
        { session_id: "dropped-session", total: 20 },
      ]);
      store.database.exec("DROP TRIGGER history_truncation_fail");

      truncated = await store.sync({ options: { ...options, force: true } });
      assert.equal(truncated.updatedFileCount, 1);
      assert.equal(truncated.perfState, "ready");
      assert.deepEqual(events(), [{ session_id: "kept-session", total: 10 }]);

      const evidence = store.database
        .prepare("SELECT occurrence_count, payload FROM history_replaced_facts WHERE source_path = ?")
        .all(usageFile)
        .map((row) => ({ occurrence_count: Number(row.occurrence_count), payload: JSON.parse(row.payload) }));
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].occurrence_count, 1);
      assert.equal(evidence[0].payload.session_id, "dropped-session");
      assert.equal(evidence[0].payload.total, 20);
      assert.equal(evidence[0].payload.source_path, usageFile);
      observedWarnings = [...store.warnings];
      assert.equal(observedWarnings.filter(isTruncationWarning).length, 1);

      writeFileSync(usageFile, `${keptLine}${usageLine("later-session", 30, 2)}`);
      const appended = await store.sync({ options });
      assert.equal(appended.updatedFileCount, 1);
      assert.equal(appended.perfState, "ready");
      assert.deepEqual(store.warnings, observedWarnings);
      assert.deepEqual(historyCounts(), { rows: 1, occurrences: 1 });
      assert.deepEqual(events(), [
        { session_id: "kept-session", total: 10 },
        { session_id: "later-session", total: 30 },
      ]);

      const noop = await store.sync({ options });
      assert.equal(noop.updatedFileCount, 0);
      assert.equal(noop.perfState, "ready");
      assert.deepEqual(store.warnings, observedWarnings);
      assert.deepEqual(historyCounts(), { rows: 1, occurrences: 1 });
    } finally {
      store.close();
    }

    const reopened = new UsageStore({ ...options, databaseFile });
    try {
      await reopened.open();
      const reopenedNoop = await reopened.sync({ options });
      assert.equal(reopenedNoop.updatedFileCount, 0);
      assert.equal(reopenedNoop.perfState, "ready");
      assert.deepEqual(reopened.warnings, observedWarnings);
      const retained = reopened.database
        .prepare("SELECT occurrence_count, payload FROM history_replaced_facts WHERE source_path = ?")
        .all(usageFile)
        .map((row) => ({ occurrence_count: Number(row.occurrence_count), payload: JSON.parse(row.payload) }));
      assert.equal(retained.length, 1);
      assert.equal(retained[0].occurrence_count, 1);
      assert.equal(retained[0].payload.session_id, "dropped-session");
      assert.equal(retained[0].payload.total, 20);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stable malformed project-log replacement preserves the removed payload and warns", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-badline-oracle-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const usageLine = (sessionId, total, second) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: new Date(Date.parse("2026-07-12T02:00:00.000Z") + second * 1000).toISOString(),
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        request_id: `request-${sessionId}`,
        model: "gpt-6-luna",
        usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    const keptLine = usageLine("kept-session", 10, 0);
    const droppedLine = usageLine("dropped-session", 20, 1);
    const laterLine = usageLine("later-session", 30, 2);
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${keptLine}${droppedLine}`);
    const originalSize = statSync(usageFile).size;
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const databaseFile = path.join(root, "index.sqlite");
    const store = new UsageStore({ ...options, databaseFile });
    const isMalformedWarning = (warning) => String(warning).includes("无法解析的 JSONL 行");
    const isTruncationWarning = (warning) => String(warning).includes("来源文件缩短（截断）");
    let liveEvents;
    let warnings;
    let warningsWithBoth;
    let warningsAfterRepair;
    let perfState;
    let updatedFileCount;
    let reopenedWarnings;
    try {
      await store.sync({ options });
      assert.equal(store.warnings.some(isMalformedWarning), false, JSON.stringify(store.warnings));

      const badLine = `{"broken":${"x".repeat(Buffer.byteLength(droppedLine) + 32)}\n`;
      writeFileSync(usageFile, `${keptLine}${badLine}`);
      assert.ok(statSync(usageFile).size > originalSize);

      store.database.exec(`
        CREATE TRIGGER history_badline_fail
        BEFORE INSERT ON history_replaced_facts
        BEGIN
          SELECT RAISE(ABORT, 'injected bad-line history failure');
        END;
      `);
      await store.sync({ options: { ...options, force: true } });
      assert.ok(store.warnings.some((warning) => warning.includes("injected bad-line history failure")));
      assert.equal(store.warnings.some(isMalformedWarning), false, JSON.stringify(store.warnings));
      assert.equal(
        (store.readPublishedFileWarnings()[usageFile] || []).some(
          (warning) => warning.code === "PROJECT_LOG_MALFORMED_JSONL",
        ),
        false,
      );
      assert.deepEqual(
        store.database
          .prepare("SELECT session_id, total FROM events WHERE source_path = ? ORDER BY timestamp_ms")
          .all(usageFile)
          .map((row) => ({ ...row })),
        [
          { session_id: "kept-session", total: 10 },
          { session_id: "dropped-session", total: 20 },
        ],
      );
      store.database.exec("DROP TRIGGER history_badline_fail");

      const replaced = await store.sync({ options: { ...options, force: true } });
      updatedFileCount = replaced.updatedFileCount;
      perfState = replaced.perfState;
      liveEvents = store.database
        .prepare("SELECT session_id, total FROM events WHERE source_path = ? ORDER BY timestamp_ms")
        .all(usageFile)
        .map((row) => ({ ...row }));
      warnings = [...store.warnings];
      assert.deepEqual(
        warnings.filter(isMalformedWarning),
        [`project-log 来源存在无法解析的 JSONL 行：${usageFile}（第 2 行）`],
        `expected one malformed-line warning; warnings=${JSON.stringify(warnings)}`,
      );
      assert.equal(
        warnings.some((warning) => String(warning).includes("broken")),
        false,
      );
      assert.deepEqual(
        (store.readPublishedFileWarnings()[usageFile] || []).find(
          (warning) => warning.code === "PROJECT_LOG_MALFORMED_JSONL",
        )?.lineNumbers,
        [2],
      );

      const noop = await store.sync({ options });
      assert.equal(noop.updatedFileCount, 0);
      assert.deepEqual(store.warnings, warnings);

      writeFileSync(usageFile, `${keptLine}${badLine}${laterLine}`);
      await store.sync({ options: { ...options, force: true } });
      writeFileSync(usageFile, `${keptLine}${badLine}`);
      await store.sync({ options: { ...options, force: true } });
      warningsWithBoth = [...store.warnings];
      assert.equal(warningsWithBoth.filter(isMalformedWarning).length, 1);
      assert.equal(warningsWithBoth.filter(isTruncationWarning).length, 1);
      assert.deepEqual((store.readPublishedFileWarnings()[usageFile] || []).map((warning) => warning.code).sort(), [
        "PROJECT_LOG_MALFORMED_JSONL",
        "PROJECT_LOG_TRUNCATED",
      ]);
    } finally {
      store.close();
    }

    let retained;
    const reopened = new UsageStore({ ...options, databaseFile });
    try {
      await reopened.open();
      const reopenedNoop = await reopened.sync({ options });
      assert.equal(reopenedNoop.updatedFileCount, 0);
      reopenedWarnings = [...reopened.warnings];
      assert.deepEqual(reopenedWarnings, warningsWithBoth);
      retained = reopened.database
        .prepare("SELECT occurrence_count, payload FROM history_replaced_facts WHERE source_path = ?")
        .all(usageFile)
        .map((row) => ({ occurrence_count: Number(row.occurrence_count), payload: JSON.parse(row.payload) }))
        .filter((row) => row.payload.session_id === "dropped-session");

      writeFileSync(usageFile, `${keptLine}${laterLine}`);
      const repaired = await reopened.sync({ options: { ...options, force: true } });
      assert.equal(repaired.updatedFileCount, 1);
      warningsAfterRepair = [...reopened.warnings];
      assert.equal(warningsAfterRepair.some(isMalformedWarning), false, JSON.stringify(warningsAfterRepair));
      assert.equal(warningsAfterRepair.filter(isTruncationWarning).length, 1);
      assert.deepEqual(
        (reopened.readPublishedFileWarnings()[usageFile] || []).map((warning) => warning.code),
        ["PROJECT_LOG_TRUNCATED"],
      );
      const repairedNoop = await reopened.sync({ options });
      assert.equal(repairedNoop.updatedFileCount, 0);
      assert.deepEqual(reopened.warnings, warningsAfterRepair);
    } finally {
      reopened.close();
    }

    assert.deepEqual(liveEvents, [{ session_id: "kept-session", total: 10 }]);
    assert.deepEqual(
      retained?.map((row) => ({
        occurrence_count: row.occurrence_count,
        session_id: row.payload.session_id,
        total: row.payload.total,
        source_path: row.payload.source_path,
      })),
      [{ occurrence_count: 1, session_id: "dropped-session", total: 20, source_path: usageFile }],
    );
    assert.equal(updatedFileCount, 1);
    assert.equal(perfState, "ready");
    assert.equal(reopenedWarnings.some(isMalformedWarning), true, JSON.stringify(reopenedWarnings));
    assert.equal(reopenedWarnings.some(isTruncationWarning), true, JSON.stringify(reopenedWarnings));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("One hundred ordinary project-log appends do not grow replaced-fact history", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-append-growth-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const usageLine = (sessionId, total, second) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: new Date(Date.parse("2026-07-12T02:00:00.000Z") + second * 1000).toISOString(),
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        model: "gpt-6-luna",
        usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    const eventCount = () =>
      Number(store.database.prepare("SELECT COUNT(*) AS n FROM events WHERE source_path = ?").get(usageFile).n);
    const historySnapshot = () => ({
      rows: Number(store.database.prepare("SELECT COUNT(*) AS n FROM history_replaced_facts").get().n),
      occurrences: Number(
        store.database.prepare("SELECT COALESCE(SUM(occurrence_count), 0) AS n FROM history_replaced_facts").get().n,
      ),
      payloadBytes: Number(
        store.database.prepare("SELECT COALESCE(SUM(length(payload)), 0) AS n FROM history_replaced_facts").get().n,
      ),
    });
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, usageLine("base-session", 10, 0));
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
    try {
      await store.sync({ options });
      writeFileSync(usageFile, usageLine("base-session", 20, 0));
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options });
      assert.equal(eventCount(), 1);
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM history_replaced_facts").get().n, 1);
      const stableHistory = historySnapshot();
      assert.equal(stableHistory.rows, 1);
      assert.equal(stableHistory.occurrences, 1);
      assert.ok(stableHistory.payloadBytes > 0);
      assert.equal(
        store.warnings.some((warning) => warning.includes("来源文件缩短（截断）")),
        false,
      );

      for (let index = 1; index <= 100; index++) {
        appendFileSync(usageFile, usageLine(`append-${index}`, 30 + index, index));
        const round = await store.sync({ options });
        assert.equal(round.updatedFileCount, 1);
        assert.equal(
          store.warnings.some((warning) => warning.includes("来源文件缩短（截断）")),
          false,
        );
        assert.equal(eventCount(), index + 1);
        const currentHistory = historySnapshot();
        assert.equal(currentHistory.rows, stableHistory.rows);
        assert.deepEqual(
          { occurrences: currentHistory.occurrences, payloadBytes: currentHistory.payloadBytes },
          { occurrences: stableHistory.occurrences, payloadBytes: stableHistory.payloadBytes },
        );
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A failure after history evidence insert rolls back the whole replacement", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-replace-rollback-"));
  try {
    const importDir = path.join(root, "import-a");
    const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
    const usageLine = (sessionId, total) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        model: "gpt-6-luna",
        usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, usageLine("old-session", 10));
    const options = { homeDir: root, env: {}, importDirs: [importDir] };
    const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
    const liveEvents = () =>
      store.database
        .prepare("SELECT session_id, total FROM events WHERE source_path = ?")
        .all(usageFile)
        .map((row) => ({ ...row }));
    const sourceRow = () =>
      store.database
        .prepare(
          "SELECT path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at FROM source_files WHERE path = ?",
        )
        .get(usageFile);
    try {
      await store.sync({ options });
      const sourceBefore = sourceRow();
      writeFileSync(usageFile, usageLine("new-session", 20));
      store.database.exec(`
        CREATE TRIGGER history_fail_after_insert
        AFTER INSERT ON history_replaced_facts
        BEGIN
          SELECT RAISE(ABORT, 'injected history evidence failure');
        END;
      `);

      await store.sync({ options });
      assert.ok(
        store.warnings.some((warning) => warning.includes("injected history evidence failure")),
        "sync must expose the real trigger failure",
      );
      assert.deepEqual(liveEvents(), [{ session_id: "old-session", total: 10 }]);
      assert.deepEqual(sourceRow(), sourceBefore);
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM history_replaced_facts").get().n, 0);

      store.database.exec("DROP TRIGGER history_fail_after_insert");
      await store.sync({ options });
      assert.deepEqual(liveEvents(), [{ session_id: "new-session", total: 20 }]);
      const replaced = store.database
        .prepare("SELECT occurrence_count, payload FROM history_replaced_facts")
        .all()
        .map((row) => ({ occurrence_count: Number(row.occurrence_count), payload: JSON.parse(row.payload) }));
      assert.equal(replaced.length, 1);
      assert.equal(replaced[0].occurrence_count, 1);
      assert.equal(replaced[0].payload.session_id, "old-session");
      assert.equal(replaced[0].payload.total, 10);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reparse retains replaced Codex quota payloads without growth on unchanged append", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-quota-facts-"));
  try {
    const rolloutFile = path.join(root, ".codex", "sessions", "2026", "07", "12", "rollout-quota.jsonl");
    const oldTimestamp = "2026-07-12T11:30:00.000Z";
    const newTimestamp = "2026-07-12T11:35:00.000Z";
    const resetsAt = Date.parse("2026-07-12T16:30:00.000Z") / 1000;
    const rollout = (timestamp, model, usedPercent) => [
      {
        timestamp,
        type: "session_meta",
        payload: { id: "quota-session", source: "cli", originator: "codex-tui", cwd: "/work/quota" },
      },
      { type: "turn_context", payload: { model } },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 120,
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
            },
          },
          rate_limits: {
            limit_id: "codex",
            primary: { window_minutes: 300, resets_at: resetsAt, used_percent: usedPercent },
            secondary: { window_minutes: 10080, resets_at: resetsAt + 7 * 24 * 60 * 60 },
          },
        },
      },
    ];
    mkdirSync(path.dirname(rolloutFile), { recursive: true });
    writeFileSync(
      rolloutFile,
      `${rollout(oldTimestamp, "gpt-6-quota", 11)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const options = { homeDir: root, env: {} };
    const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
    const liveQuota = () =>
      store.database
        .prepare(
          "SELECT role, observed_at_ms, used_percent FROM rate_limit_observations WHERE source_path = ? ORDER BY role",
        )
        .all(rolloutFile)
        .map((row) => ({ ...row }));
    const quotaHistory = () =>
      store.database
        .prepare(
          "SELECT occurrence_count, method_version, payload FROM history_replaced_facts WHERE fact_table = 'rate_limit_observations' ORDER BY payload_digest",
        )
        .all()
        .map((row) => ({
          occurrence_count: Number(row.occurrence_count),
          method_version: String(row.method_version),
          payload: JSON.parse(row.payload),
        }));
    try {
      await store.sync({ options });
      assert.deepEqual(liveQuota(), [
        { role: "primary", observed_at_ms: Date.parse(oldTimestamp), used_percent: 11 },
        { role: "secondary", observed_at_ms: Date.parse(oldTimestamp), used_percent: null },
      ]);

      writeFileSync(
        rolloutFile,
        `${rollout(newTimestamp, "gpt-6-quota-new", 42)
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(rolloutFile);
      await store.sync({ options });

      assert.deepEqual(liveQuota(), [
        { role: "primary", observed_at_ms: Date.parse(newTimestamp), used_percent: 42 },
        { role: "secondary", observed_at_ms: Date.parse(newTimestamp), used_percent: null },
      ]);
      const replaced = quotaHistory();
      assert.equal(replaced.length, 2);
      assert.ok(replaced.every((row) => row.occurrence_count === 1));
      assert.ok(replaced.every((row) => row.method_version === "rate_limit_observations.v1"));
      const replacedByRole = Object.fromEntries(replaced.map((row) => [row.payload.role, row.payload]));
      assert.equal(replacedByRole.primary.observed_at_ms, Date.parse(oldTimestamp));
      assert.equal(replacedByRole.primary.used_percent, 11);
      assert.equal(replacedByRole.primary.limit_name, null);
      assert.equal(replacedByRole.primary.plan_type, null);
      assert.equal(replacedByRole.secondary.observed_at_ms, Date.parse(oldTimestamp));
      assert.equal(replacedByRole.secondary.used_percent, null);

      appendFileSync(
        rolloutFile,
        `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-quota-new" } })}\n`,
      );
      await store.sync({ options });
      assert.equal(quotaHistory().length, 2);
      assert.deepEqual(
        quotaHistory().map((row) => row.occurrence_count),
        [1, 1],
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
