import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
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

import {
  buildCodexThreadPerfSamples,
  codexSampleAllowed,
  codexSampleThreadId,
  createCodexProjectionCache,
  createCodexPublishFilter,
  decodeCodexPublicationPolicy,
  encodeCodexPublicationPolicy,
  planCodexHomeThreads,
  rankedCodexHomeIds,
  readCodexRollout,
} from "../src/perf-sources/codex-thread.js";
import { buildUsageReport, planStableCodexHome, summarizeUsage } from "../src/usage-core.js";
import { UsageStore, STORE_SCHEMA_VERSION } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const FIXTURE_NOW = new Date("2026-10-04T13:00:00.000Z");

// The Windows sandbox rejects rename(2) even for ordinary temp files.
function moveFixtureFile(from, to) {
  const info = statSync(from);
  copyFileSync(from, to);
  utimesSync(to, info.atime, info.mtime);
  unlinkSync(from);
}

function assertCodexSummary(perf, expected) {
  assert.equal(perf.state, "ready");
  assert.deepEqual(perf.sourceWarnings, []);
  assert.equal(perf.groups.length, 1);
  const group = perf.groups[0];
  const { coverage, ...groupExpected } = expected;
  for (const [key, value] of Object.entries(groupExpected)) assert.deepEqual(group[key], value, `group.${key}`);
  for (const [key, value] of Object.entries(coverage)) {
    assert.deepEqual(perf.coverage[key], value, `coverage.${key}`);
  }
  assert.equal(group.agentKind, "unknown", "a vscode/session source is not evidence of a main agent");
}

test("M7 migration creates v13 rollout/dependency tables and rolls back atomically (lands on the current schema)", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.open();
    assert.equal(STORE_SCHEMA_VERSION, 23);
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 23);
    assert.deepEqual(
      store.database
        .prepare("PRAGMA table_info(perf_sample_sources)")
        .all()
        .map((row) => row.name),
      ["sample_key", "source_path", "role"],
    );
    assert.deepEqual(
      store.database
        .prepare("PRAGMA table_info(perf_rollout_threads)")
        .all()
        .map((row) => row.name),
      ["source_path", "home_id", "thread_id"],
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);

    store.database
      .prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, 'codex', 'fixture-home', 'Fixture', ?, 10, 1, 'now')
    `)
      .run(path.join(fixture.reportOptions.homeDir, "legacy.jsonl"), fixture.reportOptions.homeDir);
    store.database.exec(`
      DROP TABLE perf_sample_sources;
      DROP TABLE perf_rollout_threads;
      PRAGMA user_version = 12;
      CREATE TRIGGER fail_m7_upgrade BEFORE UPDATE OF size ON source_files
      WHEN old.path LIKE '%.jsonl'
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
    `);
  } finally {
    store.close();
  }

  const failed = new UsageStore(fixture.serverOptions);
  await assert.rejects(() => failed.open(), /injected migration failure/);
  const raw = new DatabaseSync(fixture.serverOptions.databaseFile);
  try {
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 12);
    assert.equal(
      raw
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('perf_sample_sources','perf_rollout_threads')",
        )
        .get().count,
      0,
    );
    raw.exec("DROP TRIGGER fail_m7_upgrade");
  } finally {
    raw.close();
  }

  const retry = new UsageStore(fixture.serverOptions);
  try {
    await retry.open();
    assert.equal(retry.database.prepare("PRAGMA user_version").get().user_version, 23);
    assert.equal(
      retry.database.prepare("SELECT size FROM source_files WHERE path LIKE '%legacy.jsonl'").get().size,
      -1,
    );
  } finally {
    retry.close();
    fixture.close();
  }
});

test("M7 indexes one candidate per cross-rollout turn, tracks empty rollouts, and publishes idempotently", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    const first = await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    assert.equal(first.perfState, "ready");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 3);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);
    assert.deepEqual(
      store.database
        .prepare("SELECT role, COUNT(*) AS count FROM perf_sample_sources GROUP BY role ORDER BY role")
        .all()
        .map((row) => ({ role: String(row.role), count: Number(row.count) })),
      [
        { role: "dependency", count: 52 },
        { role: "primary", count: 26 },
      ],
    );
    const longResponses = store.database
      .prepare(
        "SELECT output_tokens, duration_ms, request_count FROM perf_samples WHERE sample_key LIKE '%\"turn-25\"%' ORDER BY sample_key",
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(longResponses, [
      { output_tokens: 60, duration_ms: 200000, request_count: 1 },
      { output_tokens: 64, duration_ms: 200000, request_count: 1 },
    ]);

    const report = await buildUsageReport(fixture.reportOptions);
    const memoryPerf = summarizeUsage(report, { preset: "all", now: FIXTURE_NOW }).perf;
    const indexPerf = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    assertCodexSummary(indexPerf, fixture.expected);
    assert.deepEqual(indexPerf.groups, memoryPerf.groups);
    assert.deepEqual(indexPerf.coverage, memoryPerf.coverage);
    assert.equal(report.perfSamples.length, 26);

    const publishedVersion = store.perfState().indexVersion;
    const emptyRollout = path.join(path.dirname(fixture.rolloutFiles[0]), "rollout-4.jsonl");
    writeFileSync(
      emptyRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "fixture-codex-thread", source: "vscode" } })}\n`,
    );
    const added = await store.sync({ options: fixture.reportOptions });
    assert.equal(added.perfState, "ready");
    assert.notEqual(store.perfState().indexVersion, publishedVersion);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 4);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 104);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );

    const versionAfterAdd = store.perfState().indexVersion;
    const noOp = await store.sync({ options: fixture.reportOptions });
    assert.equal(noOp.updatedFileCount, 0);
    assert.equal(store.perfState().indexVersion, versionAfterAdd);
    assert.equal(store.perfState().state, "ready");
  } finally {
    store.close();
    fixture.close();
  }
});

test("M7 archive moves, transactional rollback, retry, and dependency loss preserve whole-thread state", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const oldVersion = store.perfState().indexVersion;
    const originalPath = fixture.rolloutFiles[0];
    const archivedPath = originalPath.replace(
      `${path.sep}sessions${path.sep}`,
      `${path.sep}archived_sessions${path.sep}`,
    );
    mkdirSync(path.dirname(archivedPath), { recursive: true });
    moveFixtureFile(originalPath, archivedPath);

    store.database.exec(`
      CREATE TRIGGER fail_codex_archive_publish BEFORE INSERT ON perf_rollout_threads
      WHEN NEW.source_path LIKE '%archived_sessions%'
      BEGIN SELECT RAISE(ABORT, 'injected archive publish failure'); END;
    `);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().state, "degraded");
    assert.equal(store.perfState().indexVersion, oldVersion);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?").get(originalPath)
        .count,
      1,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?").get(archivedPath)
        .count,
      0,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);
    store.database.exec("DROP TRIGGER fail_codex_archive_publish");

    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().state, "ready");
    assert.notEqual(store.perfState().indexVersion, oldVersion);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?").get(originalPath)
        .count,
      0,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?").get(archivedPath)
        .count,
      1,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path=?").get(archivedPath)
        .count,
      26,
    );

    const beforeFailure = store.database
      .prepare(
        "SELECT sample_key, source_path, output_tokens, duration_ms FROM perf_samples WHERE source_kind='codex' ORDER BY sample_key",
      )
      .all();
    const versionBeforeFailure = store.perfState().indexVersion;
    const original = readFileSync(archivedPath, "utf8");
    const changed = original.replaceAll('"output_tokens":100', '"output_tokens":150');
    assert.notEqual(changed, original);
    writeFileSync(archivedPath, changed);
    store.database.exec(`
      CREATE TRIGGER fail_codex_publish BEFORE INSERT ON perf_samples
      WHEN NEW.source_kind = 'codex'
      BEGIN SELECT RAISE(ABORT, 'injected candidate failure'); END;
    `);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().state, "degraded");
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, output_tokens, duration_ms FROM perf_samples WHERE source_kind='codex' ORDER BY sample_key",
        )
        .all(),
      beforeFailure,
      "failed replacement rolls candidates back as a whole",
    );
    assert.equal(store.perfState().indexVersion, versionBeforeFailure);
    store.database.exec("DROP TRIGGER fail_codex_publish");

    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "ready");
    assert.notEqual(store.perfState().indexVersion, versionBeforeFailure);
    assert.equal(
      store.database.prepare("SELECT output_tokens FROM perf_samples WHERE sample_key LIKE '%\"response-1-1\"%'").get()
        .output_tokens,
      150,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);

    rmSync(fixture.rolloutFiles[1]);
    const deleted = await store.sync({ options: fixture.reportOptions });
    assert.equal(deleted.perfState, "ready");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 3);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );
    assert.deepEqual(
      deleted.missingSources.map((source) => source.path),
      [fixture.rolloutFiles[1]],
    );

    rmSync(archivedPath);
    rmSync(fixture.rolloutFiles[2]);
    const noRollouts = await store.sync({ options: fixture.reportOptions });
    assert.equal(noRollouts.perfState, "ready");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 3);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );
    assert.deepEqual(
      noRollouts.missingSources.map((source) => source.path).sort(),
      [archivedPath, fixture.rolloutFiles[1], fixture.rolloutFiles[2]].sort(),
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("M7 a changed thread ID rebuilds both the old and new thread identities", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    let currentThreadId = "fixture-codex-thread";
    for (const nextThreadId of ["aaa-renamed-thread", "zzz-renamed-thread"]) {
      for (const file of fixture.rolloutFiles) {
        const original = readFileSync(file, "utf8");
        const changed = original.replaceAll(currentThreadId, nextThreadId);
        assert.notEqual(changed, original);
        writeFileSync(file, changed);
      }

      const result = await store.sync({ options: fixture.reportOptions });
      assert.equal(result.perfState, "ready");
      assert.deepEqual(
        store.database
          .prepare("SELECT DISTINCT thread_id FROM perf_rollout_threads ORDER BY thread_id")
          .all()
          .map((row) => String(row.thread_id)),
        [nextThreadId],
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
        26,
      );
      assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);
      const indexPerf = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
      const memoryReport = await buildUsageReport(fixture.reportOptions);
      const memoryPerf = summarizeUsage(memoryReport, { preset: "all", now: FIXTURE_NOW }).perf;
      assert.deepEqual(indexPerf.groups, memoryPerf.groups);
      assert.deepEqual(indexPerf.coverage, memoryPerf.coverage);
      currentThreadId = nextThreadId;
    }

    const publishedVersion = store.perfState().indexVersion;
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
    assert.equal(store.perfState().indexVersion, publishedVersion);
  } finally {
    store.close();
    fixture.close();
  }
});

test("M7 a new rollout whose thread publish fails leaves indexVersion on the old published set", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const oldVersion = store.perfState().indexVersion;
    const addedPath = path.join(fixture.codexHome, "sessions", "fixture", "rollout-new.jsonl");
    mkdirSync(path.dirname(addedPath), { recursive: true });
    writeFileSync(
      addedPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "fixture-codex-thread", source: "vscode" } })}\n`,
    );
    store.database.exec(`
      CREATE TRIGGER fail_codex_publish BEFORE INSERT ON perf_samples
      WHEN NEW.source_kind = 'codex'
      BEGIN SELECT RAISE(ABORT, 'injected new rollout failure'); END;
    `);

    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().state, "degraded");
    assert.equal(store.perfState().indexVersion, oldVersion);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM source_files WHERE path=?").get(addedPath).count,
      1,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 3);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 78);

    store.database.exec("DROP TRIGGER fail_codex_publish");
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "ready");
    assert.notEqual(store.perfState().indexVersion, oldVersion);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 4);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      26,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 104);
  } finally {
    store.close();
    fixture.close();
  }
});

test("M7 a partial multi-home publish versions only the successfully committed Codex homes", async () => {
  const fixture = createPerfCodexIntegrationFixture({ nativeTiming: false });
  const secondHome = path.join(fixture.reportOptions.homeDir, "codex-fixture-second");
  for (const file of fixture.rolloutFiles) {
    const copy = path.join(secondHome, path.relative(fixture.codexHome, file));
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(file, copy);
  }
  const options = {
    ...fixture.reportOptions,
    extraHomes: [fixture.codexHome, secondHome].join(path.delimiter),
  };
  const partialStore = new UsageStore({ ...fixture.serverOptions, ...options });
  const controlStore = new UsageStore({
    ...fixture.serverOptions,
    ...options,
    databaseFile: path.join(fixture.reportOptions.homeDir, "control-index.sqlite"),
    importStoreFile: path.join(fixture.reportOptions.homeDir, "control-imports.json"),
  });
  try {
    await partialStore.sync({ options });
    await controlStore.sync({ options });
    const firstHomeId = String(
      partialStore.database
        .prepare("SELECT home_id FROM perf_rollout_threads WHERE source_path=?")
        .get(fixture.rolloutFiles[0]).home_id,
    );
    const secondHomeFirstPath = path.join(secondHome, path.relative(fixture.codexHome, fixture.rolloutFiles[0]));
    const secondHomeId = String(
      partialStore.database
        .prepare("SELECT home_id FROM perf_rollout_threads WHERE source_path=?")
        .get(secondHomeFirstPath).home_id,
    );

    const original = readFileSync(secondHomeFirstPath, "utf8");
    const changed = original.replace('"output_tokens":100', '"output_tokens":150');
    assert.notEqual(changed, original);
    writeFileSync(secondHomeFirstPath, changed);
    await controlStore.sync({ options });
    const expectedPartialVersion = controlStore.perfState().indexVersion;

    const addedPath = path.join(fixture.codexHome, "sessions", "fixture", "rollout-new.jsonl");
    writeFileSync(
      addedPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "fixture-codex-thread", source: "vscode" } })}\n`,
    );
    const safeHomeId = firstHomeId.replaceAll("'", "''");
    partialStore.database.exec(`
      CREATE TRIGGER fail_first_home_publish BEFORE INSERT ON perf_samples
      WHEN NEW.source_kind = 'codex' AND NEW.home_id = '${safeHomeId}'
      BEGIN SELECT RAISE(ABORT, 'injected first home failure'); END;
    `);

    const partial = await partialStore.sync({ options });
    assert.equal(partial.perfState, "degraded");
    assert.deepEqual(partial.degradedHomeIds, [firstHomeId]);
    assert.equal(partialStore.perfState().indexVersion, expectedPartialVersion);
    assert.equal(
      partialStore.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE home_id=?")
        .get(firstHomeId).count,
      3,
    );
    assert.equal(
      partialStore.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE home_id=?")
        .get(secondHomeId).count,
      3,
    );
    assert.equal(
      partialStore.database.prepare("SELECT COUNT(*) AS count FROM source_files WHERE path=?").get(addedPath).count,
      1,
    );
    assert.equal(
      partialStore.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?")
        .get(addedPath).count,
      0,
    );
    assert.equal(
      partialStore.database
        .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE home_id=? AND output_tokens IS NULL")
        .get(secondHomeId).count,
      26,
      "the unblocked home publishes its candidates without invented generation timing",
    );

    partialStore.database.exec("DROP TRIGGER fail_first_home_publish");
    assert.equal((await partialStore.sync({ options })).perfState, "ready");
    assert.notEqual(partialStore.perfState().indexVersion, expectedPartialVersion);
    assert.equal(partialStore.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads").get().count, 7);
    assert.equal(
      partialStore.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      52,
    );
    assert.equal(partialStore.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 182);
  } finally {
    partialStore.close();
    controlStore.close();
    fixture.close();
  }
});

test("M7 exchanging two thread IDs clears all old candidates before reassigning rollout paths", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const secondThreadFiles = [];
  for (const [index, file] of fixture.rolloutFiles.entries()) {
    const original = readFileSync(file, "utf8").replaceAll("fixture-codex-thread", "aaa-thread");
    writeFileSync(file, original);
    const clone = path.join(fixture.codexHome, "sessions", "second-thread", `rollout-${index + 1}.jsonl`);
    mkdirSync(path.dirname(clone), { recursive: true });
    writeFileSync(clone, original.replaceAll("aaa-thread", "zzz-thread").replaceAll("turn-", "other-turn-"));
    secondThreadFiles.push(clone);
  }
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      52,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 156);

    for (const file of fixture.rolloutFiles) {
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("aaa-thread", "zzz-thread"));
    }
    for (const file of secondThreadFiles) {
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("zzz-thread", "aaa-thread"));
    }

    const result = await store.sync({ options: fixture.reportOptions });
    assert.equal(result.perfState, "ready");
    assert.deepEqual(
      store.database
        .prepare("SELECT thread_id, COUNT(*) AS count FROM perf_rollout_threads GROUP BY thread_id ORDER BY thread_id")
        .all()
        .map((row) => [String(row.thread_id), Number(row.count)]),
      [
        ["aaa-thread", 3],
        ["zzz-thread", 3],
      ],
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      52,
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources").get().count, 156);

    const indexPerf = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const memoryReport = await buildUsageReport(fixture.reportOptions);
    const memoryPerf = summarizeUsage(memoryReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(indexPerf.groups, memoryPerf.groups);
    assert.deepEqual(indexPerf.coverage, memoryPerf.coverage);
    const version = store.perfState().indexVersion;
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
    assert.equal(store.perfState().indexVersion, version);
  } finally {
    store.close();
    fixture.close();
  }
});

test("M7 uses home plus thread identity, so matching thread IDs in two homes do not collide", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const secondHome = path.join(fixture.reportOptions.homeDir, "codex-fixture-second");
  for (const file of fixture.rolloutFiles) {
    const relative = path.relative(fixture.codexHome, file);
    const copy = path.join(secondHome, relative);
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(file, copy);
  }
  const options = {
    ...fixture.reportOptions,
    extraHomes: [fixture.codexHome, secondHome].join(path.delimiter),
  };
  const store = new UsageStore({ ...fixture.serverOptions, ...options });
  try {
    await store.sync({ options });
    const homes = store.database.prepare("SELECT DISTINCT home_id FROM perf_rollout_threads ORDER BY home_id").all();
    assert.equal(homes.length, 2);
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE thread_id='fixture-codex-thread'")
        .get().count,
      6,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      52,
    );
    for (const home of homes) {
      assert.equal(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex' AND home_id=?")
          .get(home.home_id).count,
        26,
      );
    }

    const dependencyPath = fixture.rolloutFiles[1];
    store.database.prepare("DELETE FROM source_files WHERE path=?").run(dependencyPath);
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?")
        .get(dependencyPath).count,
      0,
    );
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path=?")
        .get(dependencyPath).count,
      0,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind='codex'").get().count,
      52,
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("M8.2 C: revision 1 forces a full replan and stays unchanged after publication rollback", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const oldVersion = store.perfState().indexVersion;
    const oldSamples = store.database
      .prepare(
        "SELECT sample_key, source_path, output_tokens FROM perf_samples WHERE source_kind='codex' ORDER BY sample_key",
      )
      .all();
    const invalidPolicy = JSON.stringify({ revision: 1, partialHomes: [] });
    store.writeMeta("perf_codex_publication_policy", invalidPolicy);
    store.database.exec(`
      CREATE TRIGGER fail_codex_policy_upgrade BEFORE INSERT ON perf_samples
      WHEN NEW.source_kind = 'codex'
      BEGIN SELECT RAISE(ABORT, 'injected policy-upgrade publication failure'); END;
    `);
    // C4：策略升级**不再**顺带重建未受影响线程 ⇒ 若本轮没有任何受影响线程，注入的 INSERT 失败
    // 根本不可达（触发器永不触发）。为了让"发布失败 ⇒ 策略不得被标记升级"这条不变量继续被**真实
    // 触发**，先让一个线程真的受影响（对既有 rollout 追加一个空行：读取器忽略空行 ⇒ 语义中性，
    // 但 `size` 变 ⇒ 指纹变 ⇒ 该线程必须重建 ⇒ 必然产生 INSERT）。
    const dirtyFile = fixture.rolloutFiles[0];
    const originalBytes = readFileSync(dirtyFile);
    const originalMtime = statSync(dirtyFile).mtime;
    const restoreDirtyFile = () => {
      writeFileSync(dirtyFile, originalBytes);
      utimesSync(dirtyFile, originalMtime, originalMtime);
    };
    writeFileSync(dirtyFile, `${originalBytes.toString("utf8")}\n`, "utf8");
    utimesSync(dirtyFile, originalMtime, originalMtime);

    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().state, "degraded", "注入的发布失败必须被归因为 degraded");
    assert.equal(store.perfState().indexVersion, oldVersion, "回滚不得伪造成功变更");
    assert.equal(
      store.readMetaRaw("perf_codex_publication_policy"),
      invalidPolicy,
      "failed migration is not marked upgraded",
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, output_tokens FROM perf_samples WHERE source_kind='codex' ORDER BY sample_key",
        )
        .all(),
      oldSamples,
    );
    assert.deepEqual(store.summarize({ preset: "all", now: FIXTURE_NOW }).perf.groups, []);

    // C4 阶段 3：把内容**逐字还原**（含 mtime）⇒ 该线程回到"未受影响"；触发器**仍然armed**，
    // 于是本轮只要重建候选就会被中止、策略就升级不了。⇒ 升级必须**成功完成**，且候选/版本逐字不变。
    restoreDirtyFile();
    await store.sync({ options: fixture.reportOptions });
    const recoveredPolicy = decodeCodexPublicationPolicy(store.readMetaRaw("perf_codex_publication_policy"));
    assert.equal(recoveredPolicy.usable, true);
    assert.equal(recoveredPolicy.revision, 2);
    assert.deepEqual(recoveredPolicy.partialHomes, []);
    assert.equal(store.perfState().state, "ready");
    assert.equal(
      store.perfState().indexVersion,
      oldVersion,
      "replanning identical published data does not churn the version",
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, output_tokens FROM perf_samples WHERE source_kind='codex' ORDER BY sample_key",
        )
        .all(),
      oldSamples,
      "C4：内容逐字回到已发布态 ⇒ 未受影响 ⇒ 不 delete/insert（触发器未被触发即为证据）",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("M8.2 C: store publishes only the child ledger and revision 1 rebuilds unchanged rollout candidates", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const childPath = path.join(fixture.codexHome, "sessions", "child-shape", "rollout.jsonl");
  const childRows = [
    {
      type: "session_meta",
      payload: {
        id: "Child-store",
        session_id: "Parent-store",
        parent_thread_id: "Parent-store",
        forked_from_id: "Parent-store",
        source: { subagent: { thread_spawn: { id: "Child-agent" } } },
        history_mode: "paginated",
        subagent_history_start_ordinal: 6,
      },
      ordinal: 0,
    },
    {
      type: "session_meta",
      payload: {
        id: "Parent-store",
        session_id: "Parent-store",
        source: "cli",
        history_mode: "paginated",
        forked_from_id: "Ancestor-store",
        forked_from_ordinal_exclusive: 5000,
        history_base: { thread_id: "Ancestor-store", end_ordinal_exclusive: 5000, end_byte_offset: 65536 },
      },
      ordinal: 1,
    },
    { type: "turn_context", payload: { turn_id: "Shared-turn", model: "Parent-model", effort: "low" }, ordinal: 2 },
    {
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:01.000Z",
      payload: { turn_id: "Shared-turn", response_id: "Shared-response", usage: { output_tokens: 900 } },
      ordinal: 3,
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "Shared-turn",
        item: { id: "Shared-item", type: "AgentMessage" },
        started_at_ms: 1_800_000_000_000,
        completed_at_ms: 1_800_000_009_000,
      },
      ordinal: 4,
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "Shared-turn",
        started_at: 1_800_000_000,
        completed_at: 1_800_000_009,
        duration_ms: 9000,
      },
      ordinal: 5,
    },
    {
      type: "turn_context",
      payload: { thread_id: "Child-store", turn_id: "Shared-turn", model: "Child-model", effort: "high" },
      ordinal: 6,
    },
    {
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:02.000Z",
      payload: {
        thread_id: "Child-store",
        turn_id: "Shared-turn",
        response_id: "Shared-response",
        usage: { output_tokens: 40 },
        turn_token_usage: { output_tokens: 40 },
      },
      ordinal: 7,
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Child-store",
        turn_id: "Shared-turn",
        item: { id: "Shared-item", type: "AgentMessage" },
        started_at_ms: 1_800_000_000_000,
        completed_at_ms: 1_800_000_000_400,
      },
      ordinal: 8,
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        thread_id: "Child-store",
        turn_id: "Shared-turn",
        started_at: 1_800_000_000,
        completed_at: 1_800_000_001,
        duration_ms: 1000,
      },
      ordinal: 9,
    },
  ];
  mkdirSync(path.dirname(childPath), { recursive: true });
  for (const row of childRows) {
    if (row.type === "token_usage_record" && row.payload.thread_id === "Child-store") {
      row.payload.generation_timing = fixture.generationTiming(40, 400);
    }
  }
  writeFileSync(childPath, `${childRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  try {
    await store.sync({ options: fixture.reportOptions });
    const childTiming = fixture.addRequestTiming("Child-store", {
      schemaVersion: 2,
      evidenceOrigin: "fixture@1",
      responseId: "Shared-response",
      requestedModel: "Child-model",
      reportedOutputTokens: 40,
      durationMs: 400,
      generation: { outputTokens: 40, durationMs: 400, startOutputTokens: 0, timingKind: "explicit" },
      status: "completed",
      completedAtMs: null,
    });
    await fixture.seedRequestTiming(store, [...fixture.timingRecords, childTiming]);
    const childOwner = store.database
      .prepare("SELECT home_id, thread_id FROM perf_rollout_threads WHERE source_path=?")
      .get(childPath);
    assert.ok(childOwner);
    assert.equal(childOwner.thread_id, "Child-store");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=?").get(childPath)
        .count,
      1,
      "the copied parent header never becomes a second rollout owner",
    );
    const childSampleKey = JSON.stringify([
      "codex",
      childOwner.home_id,
      "Child-store",
      "Shared-turn",
      "Shared-response",
    ]);
    const readChildSample = () => {
      const row = store.database
        .prepare("SELECT output_tokens, duration_ms FROM perf_samples WHERE sample_key=?")
        .get(childSampleKey);
      return row ? { ...row } : null;
    };
    assert.deepEqual(readChildSample(), { output_tokens: 40, duration_ms: 400 });
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path=?").get(childPath)
        .count,
      1,
      "the child sample depends on the complete physical rollout",
    );

    const indexedPerf = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const memoryReport = await buildUsageReport(fixture.reportOptions);
    const memoryPerf = summarizeUsage(memoryReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(indexedPerf.groups, memoryPerf.groups);
    assert.deepEqual(indexedPerf.coverage, memoryPerf.coverage);

    const oldVersion = store.perfState().indexVersion;
    const revisionOne = JSON.stringify({ revision: 1, partialHomes: [] });
    store.writeMeta("perf_codex_publication_policy", revisionOne);
    store.database.exec(`
      CREATE TRIGGER fail_codex_child_revision_upgrade BEFORE INSERT ON perf_samples
      WHEN NEW.source_kind = 'codex'
      BEGIN SELECT RAISE(ABORT, 'injected child policy upgrade failure'); END;
    `);
    // C4：策略升级轮本身不再重建未受影响线程 ⇒ 先让 fixture 线程真的受影响（追加一个读起来
    // 语义中性的空行 ⇒ `size` 变、指纹变 ⇒ 必建 ⇒ 必然产生 INSERT），否则注入的失败不可达。
    const dirtyFile = fixture.rolloutFiles[0];
    const originalBytes = readFileSync(dirtyFile);
    const originalMtime = statSync(dirtyFile).mtime;
    const restoreDirtyFile = () => {
      writeFileSync(dirtyFile, originalBytes);
      utimesSync(dirtyFile, originalMtime, originalMtime);
    };
    writeFileSync(dirtyFile, `${originalBytes.toString("utf8")}\n`, "utf8");
    utimesSync(dirtyFile, originalMtime, originalMtime);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().state, "degraded");
    assert.equal(store.perfState().indexVersion, oldVersion);
    assert.equal(store.readMetaRaw("perf_codex_publication_policy"), revisionOne);
    assert.deepEqual(
      readChildSample(),
      { output_tokens: 40, duration_ms: 400 },
      "rollback retains the old committed graph",
    );

    // C4：内容逐字还原 ⇒ 该线程回到"未受影响"；触发器**仍然注册着**（若本轮重建候选就会被中止）
    // ⇒ 升级必须成功：策略写成 revision 2，儿童线程的已提交图逐字不变。
    restoreDirtyFile();
    await store.sync({ options: fixture.reportOptions });
    const upgraded = decodeCodexPublicationPolicy(store.readMetaRaw("perf_codex_publication_policy"));
    assert.equal(upgraded.usable, true);
    assert.equal(upgraded.revision, 2);
    assert.deepEqual(readChildSample(), { output_tokens: 40, duration_ms: 400 });
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path=? AND thread_id='Child-store'")
        .get(childPath).count,
      1,
    );
    const stableVersion = store.perfState().indexVersion;
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.perfState().indexVersion, stableVersion, "the post-upgrade repeated sync is idempotent");
  } finally {
    store.close();
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// M8.2 Block B §4.1: the shared home ownership planner.
// Runs the real planner; no copied classifier.
// ---------------------------------------------------------------------------

const PLANNER_ROOT = mkdtempSync(path.join(os.tmpdir(), "m82-planner-"));
process.on("exit", () => rmSync(PLANNER_ROOT, { recursive: true, force: true }));

function writeRollout(name, lines) {
  const file = path.join(PLANNER_ROOT, name);
  mkdirSync(path.dirname(file), { recursive: true });
  // A string entry is written verbatim so a fixture can express a genuinely
  // malformed JSON line; an object entry is serialized. JSON.stringify on the
  // string "{not json" would otherwise emit a *valid* JSON string and only
  // exercise the non-object-row counter.
  const body = lines.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  writeFileSync(file, `${body.join("\n")}\n`, "utf8");
  return file;
}

const meta = (id, extra = {}) => ({ type: "session_meta", payload: { id, session_id: id, source: "cli", ...extra } });
const turn = (threadId) => [
  { type: "turn_context", payload: { thread_id: threadId, turn_id: "Turn-1", model: "Model-A" } },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: threadId,
      turn_id: "Turn-1",
      item: { id: "I1", type: "AgentMessage" },
      started_at_ms: 1000,
      completed_at_ms: 1400,
    },
  },
];

test("M8.2 §4.1: the planner groups every discovered file into exactly one proven thread", async () => {
  const a = writeRollout("group/thread-a.jsonl", [meta("Thread-A"), ...turn("Thread-A")]);
  const b = writeRollout("group/thread-b.jsonl", [meta("Thread-B"), ...turn("Thread-B")]);

  const plan = await planCodexHomeThreads("home-1", [b, a]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.unownedFiles, []);
  assert.deepEqual(plan.homeBlocking, []);
  assert.deepEqual(plan.failedThreads, []);
  assert.deepEqual(
    plan.threads.map((entry) => entry.threadId),
    ["Thread-A", "Thread-B"],
  );
  for (const thread of plan.threads) assert.equal(thread.rollouts.length, 1);
});

test("M8.2 §4.1(4): one unreadable file quarantines its WHOLE thread, not just that file", async () => {
  const clean = writeRollout("quarantine/part-1.jsonl", [meta("Thread-Q"), ...turn("Thread-Q")]);
  const broken = writeRollout("quarantine/part-2.jsonl", [meta("Thread-Q"), ...turn("Thread-Q"), "{not json"]);
  const brokenAgain = writeRollout("quarantine/part-3.jsonl", [meta("Thread-Q"), "{still not json"]);
  const other = writeRollout("quarantine/thread-r.jsonl", [meta("Thread-R"), ...turn("Thread-R")]);

  const plan = await planCodexHomeThreads("home-2", [clean, broken, brokenAgain, other]);
  assert.equal(plan.ok, true, "an isolatable failure does not block the home");
  assert.deepEqual(
    plan.threads.map((entry) => entry.threadId),
    ["Thread-R"],
    "the quarantined thread must not appear in the publishable set",
  );
  assert.equal(plan.failedThreads.length, 1);
  assert.equal(plan.failedThreads[0].threadId, "Thread-Q");
  assert.equal(plan.failedThreads[0].reason, "MALFORMED_JSON");
  assert.deepEqual(plan.failedThreads[0].failedFilePaths.slice().sort(), [broken, brokenAgain].sort());
  assert.deepEqual(
    plan.failedThreads[0].filePaths.slice().sort(),
    [clean, broken, brokenAgain].sort(),
    "the whole thread's file set is recorded, including the clean sibling",
  );
});

test("M8.2 §4.1(2): an unreadable file without reliable ownership blocks the whole home", async () => {
  const orphan = writeRollout("unowned/bad-header.jsonl", [
    { type: "session_meta", payload: { session_id: "ROOT", source: "cli" } },
    ...turn("Thread-X"),
    "{not json",
  ]);
  const good = writeRollout("unowned/thread-y.jsonl", [meta("Thread-Y"), ...turn("Thread-Y")]);

  const plan = await planCodexHomeThreads("home-3", [orphan, good]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.threads, []);
  assert.equal(plan.unownedFiles.length, 1);
  assert.equal(plan.unownedFiles[0].filePath, orphan);
});

test("M8.2 §4.1: unknown structure and multiple header ids block the home", async () => {
  const unknownType = writeRollout("blocked/unknown.jsonl", [
    meta("Thread-U"),
    { type: "totally_new_top", payload: {} },
  ]);
  const multiHeader = writeRollout("blocked/multi.jsonl", [meta("Thread-M1"), meta("Thread-M2")]);

  const unknownPlan = await planCodexHomeThreads("home-4", [unknownType]);
  assert.equal(unknownPlan.ok, false);
  assert.deepEqual(unknownPlan.threads, []);

  const multiPlan = await planCodexHomeThreads("home-5", [multiHeader]);
  assert.equal(multiPlan.ok, false);
  assert.equal(multiPlan.unownedFiles.length, 1, "two header ids prove no single ownership");
  assert.deepEqual(multiPlan.threads, []);
});

test("M8.2 §4.1(1): an unreadable path blocks the home instead of being skipped", async () => {
  const good = writeRollout("io/thread-z.jsonl", [meta("Thread-Z"), ...turn("Thread-Z")]);
  const missing = path.join(PLANNER_ROOT, "io", "does-not-exist.jsonl");

  const plan = await planCodexHomeThreads("home-6", [good, missing]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.threads, []);
  assert.equal(plan.homeBlocking.length, 1);
  assert.equal(plan.homeBlocking[0].filePath, missing);
});

test("M8.2 §4.1: a home with no discovered rollouts plans as an empty success", async () => {
  const plan = await planCodexHomeThreads("home-empty", []);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.threads, []);
  assert.deepEqual(plan.failedThreads, []);
  assert.deepEqual(plan.unownedFiles, []);
  assert.deepEqual(plan.homeBlocking, []);
});

test("M8.2 §4.1: a planned thread feeds the real candidate builder unchanged", async () => {
  const file = writeRollout("build/healthy.jsonl", [
    meta("Thread-Build"),
    ...turn("Thread-Build"),
    {
      type: "token_usage_record",
      payload: { thread_id: "Thread-Build", turn_id: "Turn-1", response_id: "R1", usage: { output_tokens: 40 } },
    },
    {
      type: "event_msg",
      payload: { type: "task_complete", thread_id: "Thread-Build", turn_id: "Turn-1", duration_ms: 400 },
    },
  ]);
  const plan = await planCodexHomeThreads("home-build", [file]);
  assert.equal(plan.ok, true);

  const [thread] = plan.threads;
  // Hand the planned rollouts straight to the production builder: no adapter,
  // no per-thread re-read.
  const built = buildCodexThreadPerfSamples("home-build", thread.threadId, thread.rollouts);
  assert.equal(built.samples.length, 1);
  assert.equal(built.samples[0].outputTokens, null);
  assert.equal(built.samples[0].sampleKey, '["codex","home-build","Thread-Build","Turn-1","R1"]');
});

test("M8.2 B3: memory quarantines every rollout of an isolatable thread and keeps healthy threads", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  try {
    const healthyThreadId = "healthy-codex-thread";
    const healthyRollouts = [];
    for (const [index, sourcePath] of fixture.rolloutFiles.entries()) {
      const directory = index === 1 ? "archived_sessions" : "sessions";
      const targetPath = path.join(fixture.codexHome, directory, "m82-healthy-thread", `rollout-${index + 1}.jsonl`);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(
        targetPath,
        readFileSync(sourcePath, "utf8")
          .replaceAll("fixture-codex-thread", healthyThreadId)
          .replaceAll("response-", "healthy-response-"),
      );
      healthyRollouts.push(targetPath);
    }
    fixture.registerThreadTiming(healthyThreadId, "healthy-");
    writeFileSync(fixture.rolloutFiles[1], "{not json\n", { flag: "a" });

    const secondHome = path.join(fixture.reportOptions.homeDir, "codex-second-home");
    for (const sourcePath of healthyRollouts) {
      const targetPath = path.join(secondHome, path.relative(fixture.codexHome, sourcePath));
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, readFileSync(sourcePath, "utf8").replaceAll(healthyThreadId, "second-home-thread"));
    }
    fixture.registerThreadTiming("second-home-thread", "healthy-");
    const options = {
      ...fixture.reportOptions,
      extraHomes: [fixture.codexHome, secondHome].join(path.delimiter),
    };
    const report = await buildUsageReport(options);
    const sameHome = report.homes.find((home) => home.path === fixture.codexHome);
    const otherHome = report.homes.find((home) => home.path === secondHome);
    assert.ok(sameHome);
    assert.ok(otherHome);
    assert.equal(report.perfSamples.length, 52, "bad thread contributes no candidate; both healthy threads remain");
    assert.ok(
      report.perfSamples.every((sample) => JSON.parse(sample.sampleKey)[2] !== "fixture-codex-thread"),
      "all rollout files of the failed thread are excluded",
    );
    const policy = decodeCodexPublicationPolicy(report.perfMeta.codexPublicationPolicy);
    assert.equal(policy.usable, true);
    assert.deepEqual(policy.partialHomes, [{ homeId: sameHome.id, blockedThreadIds: ["fixture-codex-thread"] }]);

    const partialSummary = summarizeUsage(report, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.equal(partialSummary.state, "degraded");
    assert.equal(partialSummary.ready, false);
    assert.equal(partialSummary.coverage.sampled, 52);
    assert.deepEqual(partialSummary.rankedHomeIds, [sameHome.id, otherHome.id].sort());
    assert.deepEqual(partialSummary.sourceWarnings, [
      { sourceKind: "codex", homeId: sameHome.id, code: "MALFORMED_JSON", count: 1 },
    ]);
    assert.equal(JSON.stringify(partialSummary).includes("blockedThreadIds"), false);
    assert.equal(JSON.stringify(partialSummary).includes("fixture-codex-thread"), false);

    const scopedSummary = summarizeUsage(report, {
      preset: "all",
      now: FIXTURE_NOW,
      excludeHomes: [sameHome.id],
    }).perf;
    assert.equal(scopedSummary.coverage.sampled, 26, "partial permission cannot bypass explicit home exclusion");
    assert.deepEqual(
      scopedSummary.rankedHomeIds,
      [sameHome.id, otherHome.id].sort(),
      "home scope affects groups and coverage, not the full unblocked-source universe",
    );

    const brokenLines = readFileSync(fixture.rolloutFiles[1], "utf8").trimEnd().split("\n");
    brokenLines[brokenLines.length - 1] = JSON.stringify({ type: "future_top_level", payload: {} });
    writeFileSync(fixture.rolloutFiles[1], `${brokenLines.join("\n")}\n`);
    const blockedReport = await buildUsageReport(options);
    const blockedSummary = summarizeUsage(blockedReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.equal(blockedReport.perfSamples.length, 26, "unknown structure blocks the entire mixed home");
    assert.deepEqual(decodeCodexPublicationPolicy(blockedReport.perfMeta.codexPublicationPolicy).partialHomes, []);
    assert.deepEqual(blockedSummary.rankedHomeIds, [otherHome.id]);
    assert.equal(blockedSummary.coverage.sampled, 26);
  } finally {
    fixture.close();
  }
});

test("M8.2 B4: store preserves a failed old thread graph while publishing healthy siblings", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const healthyThreadId = "healthy-store-thread";
  const healthyFiles = fixture.rolloutFiles.map((sourcePath, index) => {
    const targetPath = path.join(fixture.codexHome, "sessions", healthyThreadId, `rollout-${index + 1}.jsonl`);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      readFileSync(sourcePath, "utf8")
        .replaceAll("fixture-codex-thread", healthyThreadId)
        .replaceAll("response-", "healthy-response-"),
    );
    return targetPath;
  });
  const healthyTiming = fixture.registerThreadTiming(healthyThreadId, "healthy-");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store, [...fixture.timingRecords, ...healthyTiming]);
    const homeId = String(store.database.prepare("SELECT home_id FROM perf_rollout_threads LIMIT 1").get().home_id);
    const oldVersion = store.perfState().indexVersion;
    const failedSamples = store.database
      .prepare(
        "SELECT sample_key, source_path, output_tokens, duration_ms FROM perf_samples WHERE home_id=? ORDER BY sample_key",
      )
      .all(homeId)
      .filter((row) => JSON.parse(row.sample_key)[2] === "fixture-codex-thread");
    const failedMappings = store.database
      .prepare(
        "SELECT source_path, home_id, thread_id FROM perf_rollout_threads WHERE home_id=? AND thread_id=? ORDER BY source_path",
      )
      .all(homeId, "fixture-codex-thread");
    const failedDependencies = store.database
      .prepare(
        "SELECT sample_key, source_path, role FROM perf_sample_sources WHERE sample_key IN (SELECT sample_key FROM perf_samples WHERE home_id=?) ORDER BY sample_key, source_path",
      )
      .all(homeId)
      .filter((row) => JSON.parse(row.sample_key)[2] === "fixture-codex-thread");
    const failedFingerprint = store.readPublishedFileFingerprints()[fixture.rolloutFiles[1]];
    assert.equal(failedSamples.length, 26);

    writeFileSync(fixture.rolloutFiles[1], "{broken json\n", { flag: "a" });
    await store.sync({ options: fixture.reportOptions });

    assert.equal(store.perfState().state, "degraded");
    assert.equal(store.perfState().indexVersion, oldVersion, "failed bytes never advance the published version");
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, output_tokens, duration_ms FROM perf_samples WHERE home_id=? ORDER BY sample_key",
        )
        .all(homeId)
        .filter((row) => JSON.parse(row.sample_key)[2] === "fixture-codex-thread"),
      failedSamples,
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT source_path, home_id, thread_id FROM perf_rollout_threads WHERE home_id=? AND thread_id=? ORDER BY source_path",
        )
        .all(homeId, "fixture-codex-thread"),
      failedMappings,
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, role FROM perf_sample_sources WHERE sample_key IN (SELECT sample_key FROM perf_samples WHERE home_id=?) ORDER BY sample_key, source_path",
        )
        .all(homeId)
        .filter((row) => JSON.parse(row.sample_key)[2] === "fixture-codex-thread"),
      failedDependencies,
    );
    assert.equal(store.readPublishedFileFingerprints()[fixture.rolloutFiles[1]], failedFingerprint);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE home_id=?").get(homeId).count,
      52,
      "healthy sibling candidates publish even though the old failed graph stays stored",
    );

    const indexPerf = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const memoryReport = await buildUsageReport(fixture.reportOptions);
    const memoryPerf = summarizeUsage(memoryReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(indexPerf.groups, memoryPerf.groups);
    assert.deepEqual(indexPerf.coverage, memoryPerf.coverage);
    assert.deepEqual(indexPerf.sourceWarnings, memoryPerf.sourceWarnings);
    assert.equal(indexPerf.coverage.sampled, 26);
    assert.deepEqual(indexPerf.rankedHomeIds, [homeId]);
    assert.deepEqual(indexPerf.sourceWarnings, [{ sourceKind: "codex", homeId, code: "MALFORMED_JSON", count: 1 }]);
    assert.equal(JSON.stringify(indexPerf).includes("fixture-codex-thread"), false);
    assert.deepEqual(healthyFiles.length, 3);
  } finally {
    store.close();
    fixture.close();
  }
});

test("M8.2 B4: a failed replacement thread also blocks its retained old identity until recovery", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const oldThreadId = "fixture-codex-thread";
  const newThreadId = "fixture-codex-thread-new";
  const healthyThreadId = "healthy-transfer-thread";
  const healthyFiles = fixture.rolloutFiles.map((sourcePath, index) => {
    const targetPath = path.join(fixture.codexHome, "sessions", healthyThreadId, `rollout-${index + 1}.jsonl`);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      readFileSync(sourcePath, "utf8")
        .replaceAll(oldThreadId, healthyThreadId)
        .replaceAll("response-", "healthy-response-"),
    );
    return targetPath;
  });
  const healthyTiming = fixture.registerThreadTiming(healthyThreadId, "healthy-");
  const newTiming = fixture.registerThreadTiming(newThreadId, "new-");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store, [...fixture.timingRecords, ...healthyTiming]);
    const homeId = String(store.database.prepare("SELECT home_id FROM perf_rollout_threads LIMIT 1").get().home_id);
    const originalVersion = store.perfState().indexVersion;
    const oldSamples = store.database
      .prepare(
        "SELECT sample_key, source_path, output_tokens, duration_ms FROM perf_samples WHERE home_id=? ORDER BY sample_key",
      )
      .all(homeId)
      .filter((row) => JSON.parse(row.sample_key)[2] === oldThreadId);
    const oldMappings = store.database
      .prepare(
        "SELECT source_path, home_id, thread_id FROM perf_rollout_threads WHERE home_id=? AND thread_id=? ORDER BY source_path",
      )
      .all(homeId, oldThreadId);
    const oldDependencies = store.database
      .prepare(
        "SELECT sample_key, source_path, role FROM perf_sample_sources WHERE sample_key IN (SELECT sample_key FROM perf_samples WHERE home_id=?) ORDER BY sample_key, source_path",
      )
      .all(homeId)
      .filter((row) => JSON.parse(row.sample_key)[2] === oldThreadId);
    const originalFingerprints = store.readPublishedFileFingerprints();
    const replacementFiles = fixture.rolloutFiles.map((sourcePath) =>
      readFileSync(sourcePath, "utf8").replaceAll(oldThreadId, newThreadId).replaceAll("response-", "new-response-"),
    );
    assert.equal(oldSamples.length, 26);
    assert.equal(oldMappings.length, fixture.rolloutFiles.length);
    assert.equal(healthyFiles.length, fixture.rolloutFiles.length);

    for (const [index, sourcePath] of fixture.rolloutFiles.entries()) {
      writeFileSync(sourcePath, `${replacementFiles[index]}${index === 1 ? "{broken json\n" : ""}`);
    }
    await store.sync({ options: fixture.reportOptions });

    const failedPolicyRaw = store.perfState().codexPublicationPolicy;
    const failedPolicy = decodeCodexPublicationPolicy(failedPolicyRaw);
    assert.deepEqual(failedPolicy.partialHomes, [{ homeId, blockedThreadIds: [oldThreadId, newThreadId] }]);
    const indexedFailed = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const memoryFailedReport = await buildUsageReport(fixture.reportOptions);
    const memoryFailed = summarizeUsage(memoryFailedReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(indexedFailed.groups, memoryFailed.groups);
    assert.deepEqual(indexedFailed.coverage, memoryFailed.coverage);
    assert.deepEqual(indexedFailed.sourceWarnings, memoryFailed.sourceWarnings);
    assert.equal(indexedFailed.coverage.sampled, 26);
    assert.deepEqual(indexedFailed.sourceWarnings, [{ sourceKind: "codex", homeId, code: "MALFORMED_JSON", count: 1 }]);
    assert.equal(store.perfState().indexVersion, originalVersion);
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, output_tokens, duration_ms FROM perf_samples WHERE home_id=? ORDER BY sample_key",
        )
        .all(homeId)
        .filter((row) => JSON.parse(row.sample_key)[2] === oldThreadId),
      oldSamples,
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT source_path, home_id, thread_id FROM perf_rollout_threads WHERE home_id=? AND thread_id=? ORDER BY source_path",
        )
        .all(homeId, oldThreadId),
      oldMappings,
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, source_path, role FROM perf_sample_sources WHERE sample_key IN (SELECT sample_key FROM perf_samples WHERE home_id=?) ORDER BY sample_key, source_path",
        )
        .all(homeId)
        .filter((row) => JSON.parse(row.sample_key)[2] === oldThreadId),
      oldDependencies,
    );
    for (const sourcePath of fixture.rolloutFiles) {
      assert.equal(store.readPublishedFileFingerprints()[sourcePath], originalFingerprints[sourcePath]);
    }
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);

    await store.sync({ options: fixture.reportOptions });
    const repeatedIndex = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const repeatedMemoryReport = await buildUsageReport(fixture.reportOptions);
    const repeatedMemory = summarizeUsage(repeatedMemoryReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(decodeCodexPublicationPolicy(store.perfState().codexPublicationPolicy).partialHomes, [
      { homeId, blockedThreadIds: [oldThreadId, newThreadId] },
    ]);
    assert.deepEqual(repeatedIndex.groups, repeatedMemory.groups);
    assert.deepEqual(repeatedIndex.coverage, repeatedMemory.coverage);
    assert.deepEqual(repeatedIndex.sourceWarnings, repeatedMemory.sourceWarnings);
    assert.equal(repeatedIndex.coverage.sampled, 26);
    assert.equal(store.perfState().indexVersion, originalVersion);
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);

    for (const [index, sourcePath] of fixture.rolloutFiles.entries()) {
      writeFileSync(sourcePath, replacementFiles[index]);
    }
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store, newTiming);

    const recoveredIndex = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const recoveredMemoryReport = await buildUsageReport(fixture.reportOptions);
    const recoveredMemory = summarizeUsage(recoveredMemoryReport, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(recoveredIndex.groups, recoveredMemory.groups);
    assert.deepEqual(recoveredIndex.coverage, recoveredMemory.coverage);
    assert.deepEqual(recoveredIndex.sourceWarnings, recoveredMemory.sourceWarnings);
    assert.equal(recoveredIndex.state, "ready");
    assert.deepEqual(decodeCodexPublicationPolicy(store.perfState().codexPublicationPolicy).partialHomes, []);
    assert.equal(recoveredIndex.coverage.sampled, 52);
    assert.notEqual(store.perfState().indexVersion, originalVersion);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE home_id=?").get(homeId).count,
      52,
    );
    assert.equal(
      store.database
        .prepare("SELECT sample_key FROM perf_samples WHERE home_id=?")
        .all(homeId)
        .filter((row) => JSON.parse(row.sample_key)[2] === oldThreadId).length,
      0,
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("M8.2 B5: indexed and memory summaries share partial policy across range, unplaced, scope and quota", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const healthyThreadId = "healthy-summary-thread";
  const healthyFiles = fixture.rolloutFiles.map((sourcePath, index) => {
    const targetPath = path.join(fixture.codexHome, "sessions", healthyThreadId, `rollout-${index + 1}.jsonl`);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      readFileSync(sourcePath, "utf8")
        .replaceAll("fixture-codex-thread", healthyThreadId)
        .replaceAll("response-", "healthy-response-"),
    );
    return targetPath;
  });
  const healthyTiming = fixture.registerThreadTiming(healthyThreadId, "healthy-");
  const quotaEndSeconds = Math.floor((FIXTURE_NOW.getTime() + 60 * 60 * 1000) / 1000);
  const unplacedTurn = [
    {
      type: "turn_context",
      payload: { thread_id: healthyThreadId, turn_id: "turn-unplaced", model: "codex-fixture-model", effort: "high" },
    },
    {
      type: "token_usage_record",
      payload: {
        thread_id: healthyThreadId,
        turn_id: "turn-unplaced",
        response_id: "response-unplaced",
        usage: { output_tokens: 75 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: healthyThreadId,
        turn_id: "turn-unplaced",
        started_at_ms: FIXTURE_NOW.getTime(),
        completed_at_ms: FIXTURE_NOW.getTime() + 400,
        item: { id: "item-unplaced", type: "AgentMessage" },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        thread_id: healthyThreadId,
        turn_id: "turn-unplaced",
        started_at: Math.floor(FIXTURE_NOW.getTime() / 1000),
        completed_at: Math.floor((FIXTURE_NOW.getTime() + 400) / 1000),
      },
    },
  ];
  const quotaEvent = {
    timestamp: FIXTURE_NOW.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: 100,
          input_tokens: 80,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
      },
      rate_limits: {
        limit_id: "codex",
        primary: { window_minutes: 300, resets_at: quotaEndSeconds, used_percent: 50 },
      },
    },
  };
  writeFileSync(healthyFiles[0], `${[...unplacedTurn, quotaEvent].map((row) => JSON.stringify(row)).join("\n")}\n`, {
    flag: "a",
  });

  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store, [...fixture.timingRecords, ...healthyTiming]);
    const homeId = String(store.database.prepare("SELECT home_id FROM perf_rollout_threads LIMIT 1").get().home_id);
    writeFileSync(fixture.rolloutFiles[1], "{broken json\n", { flag: "a" });
    await store.sync({ options: fixture.reportOptions });

    const report = await buildUsageReport(fixture.reportOptions);
    assert.equal(report.rateLimitObservations.length, 1, "the shared source has a current quota window");
    const cases = [
      { name: "all", filters: { preset: "all", now: FIXTURE_NOW } },
      {
        name: "date range",
        filters: {
          preset: "custom",
          startDate: "2026-10-04",
          endDate: "2026-10-04",
          calendarZone: "utc",
          now: FIXTURE_NOW,
        },
      },
      {
        name: "date range with no placed samples",
        filters: {
          preset: "custom",
          startDate: "2026-10-05",
          endDate: "2026-10-05",
          calendarZone: "utc",
          now: FIXTURE_NOW,
        },
      },
      { name: "quota range", filters: { preset: "quota_5h", now: FIXTURE_NOW } },
      { name: "source/home excluded", filters: { preset: "all", now: FIXTURE_NOW, excludeHomes: [homeId] } },
    ];
    for (const { name, filters } of cases) {
      const indexed = store.summarize(filters, {}).perf;
      const memory = summarizeUsage(report, filters).perf;
      assert.deepEqual(indexed.groups, memory.groups, `${name}: groups`);
      assert.deepEqual(indexed.coverage, memory.coverage, `${name}: coverage`);
      assert.deepEqual(indexed.sourceWarnings, memory.sourceWarnings, `${name}: sourceWarnings`);
      assert.deepEqual(indexed.rankedHomeIds, memory.rankedHomeIds, `${name}: rankedHomeIds`);
      assert.deepEqual(indexed.rankedHomeIds, [homeId], `${name}: scope/range filters do not rewrite available homes`);
    }
    const allPerf = store.summarize({ preset: "all", now: FIXTURE_NOW }, {}).perf;
    assert.equal(allPerf.coverage.unplaced, 1);
    assert.equal(allPerf.coverage.sampled, 26, "unplaced candidates are counted separately from positioned samples");
    assert.deepEqual(allPerf.sourceWarnings, [{ sourceKind: "codex", homeId, code: "MALFORMED_JSON", count: 1 }]);
    assert.equal(JSON.stringify(allPerf).includes(healthyThreadId), false);
  } finally {
    store.close();
    fixture.close();
  }
});

test("M8.2 B5: store warning counts match memory for every unowned Codex file", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    for (const name of ["unowned-a.jsonl", "unowned-b.jsonl"]) {
      const filePath = path.join(fixture.codexHome, "sessions", "unowned", name);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify({ type: "session_meta", payload: { session_id: "root-only" } })}\n`);
    }

    await store.sync({ options: fixture.reportOptions });
    const report = await buildUsageReport(fixture.reportOptions);
    const indexed = store.summarize({ preset: "all", now: FIXTURE_NOW }).perf;
    const memory = summarizeUsage(report, { preset: "all", now: FIXTURE_NOW }).perf;
    assert.deepEqual(indexed.sourceWarnings, memory.sourceWarnings);
    assert.deepEqual(indexed.sourceWarnings, [
      {
        sourceKind: "codex",
        homeId: report.homes.find((home) => home.path === fixture.codexHome).id,
        code: "UNKEYABLE_RECORD",
        count: 2,
      },
    ]);
    assert.equal(indexed.groups.length, 0, "unowned files block the whole Codex home");
  } finally {
    store.close();
    fixture.close();
  }
});

test("M8.2 B3: stable Codex planning detects a new file and same-size/mtime rewrite", async () => {
  const rewriteHomePath = path.join(PLANNER_ROOT, "window-rewrite");
  const rewritePath = writeRollout("window-rewrite/sessions/one.jsonl", [meta("Thread-A"), ...turn("Thread-A")]);
  const original = readFileSync(rewritePath, "utf8");
  const stableMtimeSeconds = 1_800_000_000.123;
  utimesSync(rewritePath, stableMtimeSeconds, stableMtimeSeconds);
  const originalStat = statSync(rewritePath);
  let rewriteDiscoveries = 0;
  let rewrittenStat = null;
  const rewriteHome = {
    id: "home-window-rewrite",
    kind: "codex",
    get path() {
      rewriteDiscoveries += 1;
      if (rewriteDiscoveries === 2) {
        const changed = original.replaceAll("Thread-A", "Thread-B");
        assert.equal(changed.length, original.length);
        writeFileSync(rewritePath, changed);
        utimesSync(rewritePath, stableMtimeSeconds, stableMtimeSeconds);
        rewrittenStat = statSync(rewritePath);
      }
      return rewriteHomePath;
    },
  };
  const rewritten = await planStableCodexHome(rewriteHome);
  assert.equal(rewriteDiscoveries, 2, "the second discovery occurs after the planner await");
  assert.equal(rewrittenStat?.size, originalStat.size);
  assert.equal(rewrittenStat?.mtimeMs, originalStat.mtimeMs);
  assert.equal(rewritten.ok, false);
  assert.equal(rewritten.stable, false);
  assert.equal(
    rewritten.code,
    "LIVE_SOURCE_CHANGED",
    JSON.stringify({ before: rewritten.before, after: rewritten.after, files: rewritten.files }),
  );
  assert.deepEqual(
    rewritten.plan.threads.map((thread) => thread.threadId),
    ["Thread-A"],
  );

  const addedHomePath = path.join(PLANNER_ROOT, "window-add");
  const firstPath = writeRollout("window-add/sessions/one.jsonl", [meta("Thread-A"), ...turn("Thread-A")]);
  let addDiscoveries = 0;
  const addedHome = {
    id: "home-window-add",
    kind: "codex",
    get path() {
      addDiscoveries += 1;
      if (addDiscoveries === 2)
        writeRollout("window-add/archived_sessions/new.jsonl", [meta("Thread-B"), ...turn("Thread-B")]);
      return addedHomePath;
    },
  };
  const added = await planStableCodexHome(addedHome);
  assert.equal(added.ok, false);
  assert.equal(added.stable, false);
  assert.equal(added.code, "LIVE_SOURCE_CHANGED");
  assert.deepEqual(added.files, [firstPath]);
  assert.deepEqual(
    added.plan.threads.map((thread) => thread.threadId),
    ["Thread-A"],
  );
});

test("M8.2 §4.1(2): a file with no header, or a broken header, blocks the home", async () => {
  const healthy = writeRollout("noheader/healthy.jsonl", [meta("Thread-H"), ...turn("Thread-H")]);

  const cases = [
    { name: "no header at all", lines: [...turn("Thread-N")] },
    { name: "no header plus unreadable line", lines: [...turn("Thread-N"), "{not json"] },
    {
      name: "broken header container plus a later healthy header",
      lines: [{ type: "session_meta", payload: null }, meta("Thread-N"), ...turn("Thread-N")],
    },
    {
      name: "session_id-only header plus unreadable line",
      lines: [{ type: "session_meta", payload: { session_id: "ROOT" } }, ...turn("Thread-N"), "{not json"],
    },
  ];

  for (const [index, item] of cases.entries()) {
    const bad = writeRollout(`noheader/${index}.jsonl`, item.lines);
    const plan = await planCodexHomeThreads(`home-nh-${index}`, [healthy, bad]);
    assert.equal(plan.ok, false, item.name);
    assert.deepEqual(plan.threads, [], item.name);
    assert.deepEqual(plan.failedThreads, [], item.name);
    assert.equal(plan.unownedFiles.length, 1, item.name);
    assert.equal(plan.unownedFiles[0].filePath, bad, item.name);
  }
});

test("M8.2 §4.1(4): unknown structure blocks the home even when unreadable lines come first", async () => {
  const healthy = writeRollout("mixed/healthy.jsonl", [meta("Thread-G"), ...turn("Thread-G")]);

  const cases = [
    { name: "unknown top-level", lines: [meta("Thread-B"), { type: "totally_new_top", payload: {} }, "{not json"] },
    {
      name: "unknown event",
      lines: [meta("Thread-B"), { type: "event_msg", payload: { type: "totally_new_event" } }, "{not json"],
    },
    {
      name: "unknown item",
      lines: [
        meta("Thread-B"),
        {
          type: "event_msg",
          payload: { type: "item_completed", thread_id: "Thread-B", item: { id: "I", type: "TotallyNew" } },
        },
        "{not json",
      ],
    },
  ];

  for (const [index, item] of cases.entries()) {
    const bad = writeRollout(`mixed/${index}.jsonl`, item.lines);
    // The public strict reader keeps its original first-error precedence.
    await assert.rejects(readCodexRollout(bad), (error) => error.code === "MALFORMED_JSON", item.name);

    const plan = await planCodexHomeThreads(`home-mixed-${index}`, [healthy, bad]);
    assert.equal(plan.ok, false, `${item.name}: unknown structure must block the home`);
    assert.deepEqual(plan.threads, [], item.name);
    assert.deepEqual(plan.failedThreads, [], `${item.name}: must not be isolated as a bad thread`);
  }
});

test("M8.2 §4.1(4): a sound header with only unreadable lines is still isolatable", async () => {
  const healthy = writeRollout("isolate/healthy.jsonl", [meta("Thread-K"), ...turn("Thread-K")]);
  const bad = writeRollout("isolate/bad.jsonl", [meta("Thread-Q"), ...turn("Thread-Q"), "{not json"]);

  const plan = await planCodexHomeThreads("home-isolate", [healthy, bad]);
  assert.equal(plan.ok, true, "a purely unreadable file with a sound header is isolatable");
  assert.deepEqual(
    plan.threads.map((entry) => entry.threadId),
    ["Thread-K"],
  );
  assert.equal(plan.failedThreads.length, 1);
  assert.equal(plan.failedThreads[0].threadId, "Thread-Q");
});

test("M8.2 §2: the strict reader and the planner agree on every failure class", async () => {
  const cases = [
    { name: "clean", lines: [meta("Thread-OK"), ...turn("Thread-OK")], code: null, homeBlocked: false },
    {
      name: "unreadable",
      lines: [meta("Thread-OK"), ...turn("Thread-OK"), "{not json"],
      code: "MALFORMED_JSON",
      homeBlocked: false,
    },
    {
      name: "non-object-row",
      lines: [meta("Thread-OK"), ...turn("Thread-OK"), "[]"],
      code: "MALFORMED_JSON",
      homeBlocked: false,
    },
    {
      name: "unknown-type",
      lines: [meta("Thread-OK"), { type: "totally_new_top", payload: {} }],
      code: "UNSUPPORTED_SCHEMA",
      homeBlocked: true,
    },
    {
      name: "missing-header-id",
      lines: [{ type: "session_meta", payload: { session_id: "ROOT" } }, ...turn("Thread-OK")],
      code: "UNKEYABLE_RECORD",
      homeBlocked: true,
    },
    { name: "no-header", lines: [...turn("Thread-OK")], code: "UNKEYABLE_RECORD", homeBlocked: true },
  ];
  for (const [index, item] of cases.entries()) {
    const file = writeRollout(`step/${index}-${item.name}.jsonl`, item.lines);
    const plan = await planCodexHomeThreads(`home-step-${index}`, [file]);
    if (item.code === null) {
      assert.equal((await readCodexRollout(file)).threadId, "Thread-OK", item.name);
      assert.equal(plan.ok, true, item.name);
      assert.equal(plan.threads[0].threadId, "Thread-OK", item.name);
      continue;
    }
    await assert.rejects(readCodexRollout(file), (error) => error.code === item.code, item.name);
    // The planner must not merely echo the code: a home-blocking class yields no
    // publishable subset, while an isolatable class yields no publishable thread.
    assert.equal(plan.ok, !item.homeBlocked, item.name);
    assert.deepEqual(plan.threads, [], item.name);
    if (item.homeBlocked) assert.deepEqual(plan.failedThreads, [], item.name);
    else assert.equal(plan.failedThreads.length, 1, item.name);
  }
});

// ---------------------------------------------------------------------------
// M8.2 §4.2: internal publication policy + shared publish filter.
// ---------------------------------------------------------------------------

function codexSampleOf(homeId, threadId, turnId = "Turn-1", sourceKind = "codex") {
  return { sourceKind, homeId, sampleKey: JSON.stringify([sourceKind, homeId, threadId, turnId]) };
}

test("M8.2 §4.2: the policy encodes deterministically and carries identities only", () => {
  const encoded = encodeCodexPublicationPolicy([
    { homeId: "home-b", blockedThreadIds: ["Thread-2", "Thread-1"] },
    { homeId: "home-a", blockedThreadIds: ["Thread-Z"] },
    { homeId: "home-b", blockedThreadIds: ["Thread-1", "Thread-3"] },
  ]);
  assert.equal(
    encoded,
    '{"revision":2,"partialHomes":[{"homeId":"home-a","blockedThreadIds":["Thread-Z"]},' +
      '{"homeId":"home-b","blockedThreadIds":["Thread-1","Thread-2","Thread-3"]}]}',
    "duplicated homes merge, thread ids dedupe, order is stable",
  );
  // Re-encoding the same plan must be byte-identical: exclusion-only changes
  // must not churn the published content version.
  assert.equal(
    encoded,
    encodeCodexPublicationPolicy([
      { homeId: "home-a", blockedThreadIds: ["Thread-Z"] },
      { homeId: "home-b", blockedThreadIds: ["Thread-3", "Thread-2", "Thread-1", "Thread-3"] },
    ]),
  );
  assert.equal(encoded.includes("path"), false);
  assert.equal(encoded.includes("/"), false);
});

test("M8.2 §4.2: a missing, unparsable, wrong-revision, or malformed policy grants NO permission", () => {
  const denied = [
    undefined,
    null,
    "",
    "{not json",
    JSON.stringify({ revision: 1, partialHomes: [] }),
    JSON.stringify({ revision: 3, partialHomes: [] }),
    JSON.stringify({ partialHomes: [] }),
    JSON.stringify({ revision: 2, partialHomes: {} }),
    JSON.stringify({ revision: 2, partialHomes: [null] }),
    JSON.stringify({ revision: 2, partialHomes: [{ blockedThreadIds: [] }] }),
    JSON.stringify({ revision: 2, partialHomes: [{ homeId: "", blockedThreadIds: [] }] }),
    JSON.stringify({ revision: 2, partialHomes: [{ homeId: "home-a" }] }),
    JSON.stringify({ revision: 2, partialHomes: [{ homeId: "home-a", blockedThreadIds: ["", "T"] }] }),
    JSON.stringify({ revision: 2, partialHomes: [{ homeId: "home-a", blockedThreadIds: [7] }] }),
  ];
  for (const raw of denied) {
    const decoded = decodeCodexPublicationPolicy(raw);
    assert.equal(decoded.usable, false, `must deny: ${String(raw)}`);
    assert.deepEqual(decoded.partialHomes, [], `no laxly-emptied entry: ${String(raw)}`);
  }

  const roundTrip = decodeCodexPublicationPolicy(
    encodeCodexPublicationPolicy([{ homeId: "home-a", blockedThreadIds: ["Thread-1"] }]),
  );
  assert.equal(roundTrip.usable, true);
  assert.deepEqual(roundTrip.partialHomes, [{ homeId: "home-a", blockedThreadIds: ["Thread-1"] }]);
});

test("M8.2 §4.2: whole-home exclusion runs first, then blocked threads inside permitted homes", () => {
  const filter = createCodexPublishFilter(
    ["home-permitted", "home-excluded"],
    [{ homeId: "home-permitted", blockedThreadIds: ["Thread-Bad"] }],
  );

  // Excluded home without permission: nothing passes, even a "good" thread.
  assert.equal(filter.homeAllowed("home-excluded"), false);
  assert.equal(filter.threadAllowed("home-excluded", "Thread-Good"), false);

  // Permitted home: good threads pass, blocked ones do not.
  assert.equal(filter.threadAllowed("home-permitted", "Thread-Good"), true);
  assert.equal(filter.threadAllowed("home-permitted", "Thread-Bad"), false);

  // A permitted home must not have its blocked set relaxed to empty.
  assert.equal(filter.threadAllowed("home-permitted", null), false, "an unidentifiable thread is not allowed");

  // Untouched home: everything passes.
  assert.equal(filter.threadAllowed("home-fine", "Thread-Anything"), true);
});

test("M8.2 §4.2: the filter reads thread identity from the frozen sampleKey, not sessionId", () => {
  const filter = createCodexPublishFilter(["home-1"], [{ homeId: "home-1", blockedThreadIds: ["Thread-Bad"] }]);

  assert.equal(codexSampleThreadId(codexSampleOf("home-1", "Thread-Bad")), "Thread-Bad");
  // A SQL session_id or PerfSample.sessionId must not influence the decision.
  assert.equal(
    codexSampleAllowed(filter, { ...codexSampleOf("home-1", "Thread-Good"), sessionId: "Thread-Bad" }),
    true,
  );
  assert.equal(
    codexSampleAllowed(filter, { ...codexSampleOf("home-1", "Thread-Bad"), sessionId: "Thread-Good" }),
    false,
  );

  // Non-Codex samples always pass through.
  assert.equal(codexSampleAllowed(filter, { sourceKind: "dsh", homeId: "home-1", sampleKey: "x" }), true);

  // Unparsable / wrong-shape keys inside a permitted home are excluded.
  assert.equal(codexSampleThreadId({ sourceKind: "codex", sampleKey: "{not json" }), null);
  assert.equal(codexSampleAllowed(filter, { sourceKind: "codex", homeId: "home-1", sampleKey: "{not json" }), false);
  assert.equal(
    codexSampleAllowed(filter, { sourceKind: "codex", homeId: "home-1", sampleKey: '["dsh","h","T","t"]' }),
    false,
  );
});

test("M8.2 §4.2: rankedHomeIds comes from the filtered candidates", () => {
  const filter = createCodexPublishFilter(
    ["home-1", "home-2"],
    [{ homeId: "home-1", blockedThreadIds: ["Thread-Bad"] }],
  );
  const samples = [
    codexSampleOf("home-1", "Thread-Good"),
    codexSampleOf("home-1", "Thread-Bad"),
    codexSampleOf("home-2", "Thread-Whatever"),
    codexSampleOf("home-3", "Thread-Fine"),
  ];
  // home-1 keeps its ranking because it holds partial permission and still has a
  // good candidate; home-2 has no permission and drops out entirely.
  assert.deepEqual(rankedCodexHomeIds(filter, samples), ["home-1", "home-3"]);
  // If a permitted home loses every good candidate it must also drop out.
  assert.deepEqual(rankedCodexHomeIds(filter, [codexSampleOf("home-1", "Thread-Bad"), ...samples.slice(2)]), [
    "home-3",
  ]);
});

// ---------------------------------------------------------------------------
// M8.2 §4.2 rework: permission boundaries.
// ---------------------------------------------------------------------------

test("M8.2 §4.2: duplicate homes UNION their blocked threads — a later entry never revokes a block", () => {
  const duplicated = [
    { homeId: "H", blockedThreadIds: ["Bad"] },
    { homeId: "H", blockedThreadIds: [] },
  ];
  // Encoder, decoder and filter must all agree on the union.
  assert.equal(
    encodeCodexPublicationPolicy(duplicated),
    '{"revision":2,"partialHomes":[{"homeId":"H","blockedThreadIds":["Bad"]}]}',
  );
  const decoded = decodeCodexPublicationPolicy(
    JSON.stringify({ revision: 2, partialHomes: [...duplicated, { homeId: "H", blockedThreadIds: ["Bad-2"] }] }),
  );
  assert.equal(decoded.usable, true);
  assert.deepEqual(decoded.partialHomes, [{ homeId: "H", blockedThreadIds: ["Bad", "Bad-2"] }]);

  // The formal chain: decode then filter must still block Bad.
  const filter = createCodexPublishFilter(["H"], decoded.partialHomes);
  assert.equal(filter.threadAllowed("H", "Bad"), false, "the earlier block must survive the later empty entry");
  assert.equal(filter.threadAllowed("H", "Bad-2"), false);
  assert.equal(filter.threadAllowed("H", "Good"), true);

  // Order must not matter.
  const reversed = createCodexPublishFilter(
    ["H"],
    decodeCodexPublicationPolicy(JSON.stringify({ revision: 2, partialHomes: [...duplicated].reverse() })).partialHomes,
  );
  assert.equal(reversed.threadAllowed("H", "Bad"), false);

  // A directly built filter takes the same union.
  const direct = createCodexPublishFilter(["H"], duplicated);
  assert.equal(direct.threadAllowed("H", "Bad"), false);
  assert.equal(direct.permittedHomeIds.join(","), "H");
});

test("M8.2 §4.2: an invalid entry fails the WHOLE permission set at every entry point", () => {
  const badEntries = [
    null,
    "not-an-object",
    [],
    { blockedThreadIds: [] },
    { homeId: "", blockedThreadIds: [] },
    { homeId: "H" },
    { homeId: "H", blockedThreadIds: "Bad" },
    { homeId: "H", blockedThreadIds: [""] },
    { homeId: "H", blockedThreadIds: [7] },
  ];

  for (const entry of badEntries) {
    const label = JSON.stringify(entry);

    // Encoder: an invalid internal plan throws instead of emitting an empty
    // permission that would look valid.
    assert.throws(
      () => encodeCodexPublicationPolicy([entry]),
      (error) => error instanceof TypeError,
      `encoder must reject ${label}`,
    );

    // Decoder: no permission, and never a laxly-emptied entry.
    const decoded = decodeCodexPublicationPolicy(
      JSON.stringify({ revision: 2, partialHomes: [{ homeId: "H", blockedThreadIds: ["Bad"] }, entry] }),
    );
    assert.equal(decoded.usable, false, `decoder must deny ${label}`);
    assert.deepEqual(decoded.partialHomes, [], `decoder must not keep a partial entry for ${label}`);

    // Filter: a degraded home gets NO partial permission, so neither its
    // healthy nor its blocked threads pass.
    const filter = createCodexPublishFilter(["H"], [{ homeId: "H", blockedThreadIds: ["Bad"] }, entry]);
    assert.deepEqual(filter.permittedHomeIds, [], `filter must grant no permission for ${label}`);
    assert.equal(filter.threadAllowed("H", "Bad"), false, label);
    assert.equal(filter.threadAllowed("H", "Good"), false, `no permission means whole-home exclusion for ${label}`);
    // Other, non-degraded homes keep the existing behaviour and are not dragged in.
    assert.equal(filter.threadAllowed("Other", "Anything"), true, label);
  }

  // A valid empty plan still encodes and decodes as an empty permission.
  assert.equal(encodeCodexPublicationPolicy([]), '{"revision":2,"partialHomes":[]}');
  assert.equal(encodeCodexPublicationPolicy(), '{"revision":2,"partialHomes":[]}');
  assert.equal(decodeCodexPublicationPolicy('{"revision":2,"partialHomes":[]}').usable, true);
});

test("M8.2 §4.2: a sample key must be the complete frozen identity, matching its own home", () => {
  const filter = createCodexPublishFilter(["H"], [{ homeId: "H", blockedThreadIds: ["Bad"] }]);

  const cases = [
    { name: "correct", key: '["codex","H","Good","Turn"]', homeId: "H", expected: "Good" },
    { name: "missing turn", key: '["codex","H","Good"]', homeId: "H", expected: null },
    { name: "response identity", key: '["codex","H","Good","Turn","Response"]', homeId: "H", expected: "Good" },
    { name: "extra element", key: '["codex","H","Good","Turn","Response","Extra"]', homeId: "H", expected: null },
    { name: "home mismatch", key: '["codex","OtherHome","Good","Turn"]', homeId: "H", expected: null },
    { name: "empty turn", key: '["codex","H","Good",""]', homeId: "H", expected: null },
    { name: "empty thread", key: '["codex","H","","Turn"]', homeId: "H", expected: null },
    { name: "wrong source", key: '["dsh","H","Good","Turn"]', homeId: "H", expected: null },
    { name: "non-string turn", key: '["codex","H","Good",7]', homeId: "H", expected: null },
  ];

  for (const item of cases) {
    const sample = { sourceKind: "codex", homeId: item.homeId, sampleKey: item.key };
    assert.equal(codexSampleThreadId(sample), item.expected, item.name);
    // In a home holding partial permission, an unprovable identity is rejected.
    assert.equal(codexSampleAllowed(filter, sample), item.expected === "Good", item.name);
  }
});

test("M8.2 §4.2: a Codex ranking never lists a home seen only in another source", () => {
  const filter = createCodexPublishFilter([], []);
  const samples = [
    { sourceKind: "dsh", homeId: "D", sampleKey: '["dsh","D","T","Turn"]' },
    { sourceKind: "opencode", homeId: "O", sampleKey: '["opencode","O","T","Turn"]' },
    codexSampleOf("C", "Thread-C"),
  ];
  assert.deepEqual(rankedCodexHomeIds(filter, samples), ["C"], "non-Codex homes must not enter a Codex ranking");

  // Non-Codex samples still pass through the general predicate untouched.
  assert.equal(codexSampleAllowed(filter, samples[0]), true);
  assert.equal(codexSampleAllowed(filter, samples[1]), true);
});

// ---------------------------------------------------------------------------
// C1 卡：稳定失败尝试记录与规划复用（`shouldPlan` 入口的复用 + 全部失效条件）
//
// 判别力设计（比"数调用次数"更强）：往**健康兄弟线程**的一行已发布候选写哨兵值。
// 复用轮不进入 `codexPlans` ⇒ 发布循环不触碰该 home ⇒ 候选不被 delete/insert ⇒ 哨兵存活；
// 只要**真的**发生了一次规划 + 发布，该行会被删除重建 ⇒ 哨兵丢失。
// 因此"哨兵存活"同时证明：① 没有全文规划；② 没有候选重写。
// ---------------------------------------------------------------------------

const C1_ROOT = mkdtempSync(path.join(os.tmpdir(), "c1-stable-failure-"));
process.on("exit", () => rmSync(C1_ROOT, { recursive: true, force: true }));
const C1_SENTINEL = "C1-SENTINEL";

/** 与 `writeRollout` 同口径：字符串逐字写入（用来表达**真正的**坏 JSON 行）。 */
function c1WriteLines(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  writeFileSync(file, `${body.join("\n")}\n`, "utf8");
  return file;
}

/** 一条**健康**线程：ownership 可证 + 一个带输出 token 的 turn（能发布候选）。 */
function c1HealthyLines(threadId, token = "aaaa") {
  return [
    { type: "session_meta", payload: { id: threadId, session_id: threadId, source: "cli", cwd: `C:/c1/${token}` } },
    { type: "turn_context", payload: { thread_id: threadId, turn_id: "Turn-1", model: "C1-Model" } },
    {
      type: "token_usage_record",
      timestamp: "2026-10-04T12:00:01.000Z",
      payload: {
        thread_id: threadId,
        turn_id: "Turn-1",
        response_id: `resp-${threadId}`,
        usage: { output_tokens: 120 },
        turn_token_usage: { output_tokens: 120 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: "Turn-1",
        item: { id: "I1", type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    },
  ];
}

/** 一条**坏**线程：ownership 可证 + 一行坏 JSON ⇒ `MALFORMED_JSON`（可隔离，不阻塞 home）。 */
function c1BadLines(threadId) {
  return [
    { type: "session_meta", payload: { id: threadId, session_id: threadId, source: "cli" } },
    { type: "turn_context", payload: { thread_id: threadId, turn_id: "Turn-1", model: "C1-Model" } },
    "{not json",
  ];
}

let c1Seq = 0;
/** 隔离 home：健康线程 A + 坏线程 B（同一个 codex home）。 */
function makeC1Home() {
  const root = path.join(C1_ROOT, `case-${++c1Seq}`);
  const homeDir = path.join(root, "codex-home");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  const healthyFile = c1WriteLines(path.join(sessionsDir, "rollout-a.jsonl"), c1HealthyLines("Thread-A"));
  const badFile = c1WriteLines(path.join(sessionsDir, "rollout-b.jsonl"), c1BadLines("Thread-B"));
  const reportOptions = {
    homeDir: root,
    env: {},
    extraHomes: homeDir,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  return {
    root,
    homeDir,
    sessionsDir,
    healthyFile,
    badFile,
    reportOptions,
    serverOptions: {
      ...reportOptions,
      databaseFile: path.join(root, "index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 往健康兄弟线程的**一行**已发布候选写哨兵，返回该 `sample_key`。 */
function c1MarkSentinel(store) {
  const row = store.database
    .prepare("SELECT sample_key FROM perf_samples WHERE source_kind = 'codex' ORDER BY sample_key LIMIT 1")
    .get();
  assert.ok(row, "前置：健康兄弟线程必须已发布候选");
  store.database
    .prepare("UPDATE perf_samples SET diagnostic_reason = ? WHERE sample_key = ?")
    .run(C1_SENTINEL, row.sample_key);
  return row.sample_key;
}

/** 哨兵是否仍然存活（= 该行没有被 delete/insert 重建）。 */
function c1SentinelSurvives(store, sampleKey) {
  const row = store.database.prepare("SELECT diagnostic_reason FROM perf_samples WHERE sample_key = ?").get(sampleKey);
  return row?.diagnostic_reason === C1_SENTINEL;
}

/** 该 home 的 `homeId`（记录键）。 */
function c1HomeId(store) {
  const degraded = JSON.parse(store.readMeta("perf_degraded_home_ids"));
  assert.equal(degraded.length, 1, "前置：恰好一个 home 处于 degraded");
  return degraded[0];
}

/** 稳定失败尝试记录条数（S2 交付态没有该字段 ⇒ 0，使"无复用"版本得到**断言**失败而不是 TypeError）。 */
function c1RecordCount(store) {
  return store.codexStableAttempts?.size ?? 0;
}

/**
 * 在**读取后窗口成立之后、逐文件判据之前**注入一次原地改写。
 * 注入点 = 逐文件循环读取 `source_files` 的 `get()` 调用（它晚于 codex 规划窗口、
 * 早于 size/mtime/内容刷新判据和发布前复核）。
 */
function injectC1BeforeDecision(store, targetFile, action) {
  const state = { injected: false };
  const realPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (
      !String(sql).includes(
        "SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?",
      )
    ) {
      return stmt;
    }
    const realGet = stmt.get.bind(stmt);
    stmt.get = (...args) => {
      if (String(args[0]) === targetFile && !state.injected) {
        state.injected = true;
        action();
      }
      return realGet(...args);
    };
    return stmt;
  };
  state.restore = () => {
    store.database.prepare = realPrepare;
  };
  return state;
}

/** 等长原地改写 + 把 mtime 钉回原值（`size + mtimeMs` 判据看不见）。 */
function c1RewriteSameMetadata(file, from, to) {
  const before = statSync(file);
  const text = readFileSync(file, "utf8");
  const next = text.replace(from, to);
  assert.equal(next.length, text.length, "前置：原地改写必须**等长**（否则 size 判据会先发现）");
  writeFileSync(file, next);
  utimesSync(file, before.atime, before.mtime);
  const after = statSync(file);
  assert.equal(after.size, before.size, "前置：size 必须未变");
  assert.equal(Math.round(after.mtimeMs), Math.round(before.mtimeMs), "前置：mtime 必须未变");
}

test("C1 · 稳定失败复用：相同坏 JSON 连续三轮不再全文规划，健康兄弟线程候选原样保留", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    const first = await store.sync({ options: fixture.reportOptions });
    assert.equal(first.perfState, "degraded", "坏线程使 home 进入 partial ⇒ degraded");
    assert.equal(c1RecordCount(store), 1, "一次稳定验证完成的部分失败必须留下记录");
    const homeId = c1HomeId(store);
    const policy = store.readMeta("perf_codex_publication_policy");
    const warnings = store.readMeta("perf_source_warnings");
    const version = store.readMeta("perf_index_version");
    assert.match(warnings, /MALFORMED_JSON/, "坏线程的告警必须已投影");
    assert.match(policy, /Thread-B/, "被隔离线程必须写进 partial 策略");
    const sampleKey = c1MarkSentinel(store);
    const rowCount = store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples").get().n;
    for (const round of [2, 3]) {
      const status = await store.sync({ options: fixture.reportOptions });
      assert.equal(status.perfState, "degraded", `第 ${round} 轮状态`);
      assert.equal(store.readMeta("perf_codex_publication_policy"), policy, `第 ${round} 轮 partial 策略必须逐字不变`);
      assert.equal(store.readMeta("perf_source_warnings"), warnings, `第 ${round} 轮告警不得丢失也不得累加`);
      assert.equal(store.readMeta("perf_index_version"), version, `第 ${round} 轮版本不得变化`);
      assert.equal(c1RecordCount(store), 1, `第 ${round} 轮记录仍在`);
      assert.equal(store.codexStableAttempts.has(homeId), true, `第 ${round} 轮记录仍绑在该 home`);
      assert.equal(
        c1SentinelSurvives(store, sampleKey),
        true,
        `第 ${round} 轮必须复用（否则规划+发布会重建健康兄弟线程的候选）`,
      );
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples").get().n, rowCount);
    }
  } finally {
    store.close();
    fixture.close();
  }
});

test("C1 · 失效条件：同尺寸同 mtime 的原地改写使记录立即失效（失败不被粘住）", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c1HomeId(store);
    assert.equal(c1RecordCount(store), 1);
    const recordBefore = store.codexStableAttempts.get(homeId);
    const sampleKey = c1MarkSentinel(store);
    c1RewriteSameMetadata(fixture.badFile, "{not json", "{bad json");
    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "degraded");
    assert.equal(
      c1SentinelSurvives(store, sampleKey),
      true,
      "C4：内容变的是**坏线程**，健康兄弟线程（Thread-A）未受影响 ⇒ 复用已发布候选、不再被顺带重建",
    );
    // C4 独立证据：规划**确实**重跑过（受影响集合为空 + 下面的记录按新指纹重建），
    // 因此"哨兵存活"不是"整轮被跳过"。
    assert.deepEqual(
      c4BuildPlan(store),
      { homeId, staged: [], retained: ["Thread-A"] },
      "C4：本轮进入规划但没有任何线程需要重建（坏线程本就不发布候选）",
    );
    assert.match(store.readMeta("perf_source_warnings"), /MALFORMED_JSON/, "改写后的坏内容仍被隔离");
    const recordAfter = store.codexStableAttempts.get(homeId);
    assert.ok(recordAfter, "重新规划后必须重建记录");
    assert.notEqual(
      recordAfter.fileFingerprints[fixture.badFile],
      recordBefore.fileFingerprints[fixture.badFile],
      "记录必须绑定**新的**内容指纹",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("C1 · 失效条件：完整路径集变化（新增 rollout）使记录立即失效", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c1RecordCount(store), 1);
    const sampleKey = c1MarkSentinel(store);
    c1WriteLines(path.join(fixture.sessionsDir, "rollout-c.jsonl"), c1HealthyLines("Thread-C"));
    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "degraded", "坏线程仍隔离");
    assert.equal(
      c1SentinelSurvives(store, sampleKey),
      true,
      "C4：新增的是**另一个线程**；健康兄弟线程（Thread-A）的依赖集合没变 ⇒ 复用已发布候选",
    );
    assert.deepEqual(
      c4BuildPlan(store),
      { homeId: c1HomeId(store), staged: ["Thread-C"], retained: ["Thread-A"] },
      "C4：只有新线程 C 受影响 ⇒ 只有 C 被构建/发布",
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE sample_key LIKE '%Thread-C%'").get().n > 0,
      true,
      "新增线程的候选必须被发布",
    );
    assert.equal(c1RecordCount(store), 1, "重新规划后记录绑定新路径集");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C1 · 恢复路径：坏内容修好后自动重新规划并回到 ready，记录被清除", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c1RecordCount(store), 1);
    assert.match(store.readMeta("perf_source_warnings"), /MALFORMED_JSON/);
    c1WriteLines(fixture.badFile, c1HealthyLines("Thread-B"));
    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "ready", "坏内容修好 ⇒ 自动恢复");
    assert.equal(store.readMeta("perf_source_warnings"), "[]", "告警必须清空（不得累加）");
    assert.equal(store.readMeta("perf_degraded_home_ids"), "[]");
    assert.equal(c1RecordCount(store), 0, "恢复后记录不再适用，必须清除");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE sample_key LIKE '%Thread-B%'").get().n > 0,
      true,
      "原先被隔离的线程必须重新发布",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("C1 · 瞬态失败不缓存：发布前复核发现来源变化（LIVE_SOURCE_CHANGED）时不得留下可跳过记录", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.open();
    const injection = injectC1BeforeDecision(store, fixture.healthyFile, () =>
      c1RewriteSameMetadata(fixture.healthyFile, "C:/c1/aaaa", "C:/c1/bbbb"),
    );
    try {
      await store.sync({ options: fixture.reportOptions });
    } finally {
      injection.restore();
    }
    assert.equal(injection.injected, true, "前置：注入点必须命中");
    assert.equal(c1RecordCount(store), 0, "读取期间变化 / 发布受阻 ⇒ 绝不记录为可跳过状态");
    assert.match(store.readMeta("perf_source_warnings"), /LIVE_SOURCE_CHANGED/);
    assert.equal(JSON.parse(store.readMeta("perf_degraded_home_ids")).length, 1, "受阻的 home 必须仍计入 degraded");
    // 确定性恢复路径：下一轮（无注入）重新规划并重新建立记录。
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c1RecordCount(store), 1, "恢复后必须重新建立记录");
    assert.match(store.readMeta("perf_source_warnings"), /MALFORMED_JSON/);
    assert.equal(store.readMeta("perf_source_warnings").includes("LIVE_SOURCE_CHANGED"), false, "变化已收敛");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C1 · 瞬态失败不缓存：规划窗口内来源集合变化（窗口不可证）时不得留下可跳过记录", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.open();
    // 注入点 = codex 规划回路**之前**的一条 SQL（`SELECT source_path, home_id, thread_id FROM
    // perf_rollout_threads`）：此刻 `usageFiles` 的发现已完成（`expectedPaths` 已定），规划窗口尚未开始。
    // 于是规划窗口的 `files`（新发现）≠ `expectedPaths` ⇒ `stable=false` + `LIVE_SOURCE_CHANGED`。
    const state = { injected: false };
    const realPrepare = store.database.prepare.bind(store.database);
    store.database.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (!String(sql).includes("SELECT source_path, home_id, thread_id FROM perf_rollout_threads")) return stmt;
      if (!state.injected) {
        state.injected = true;
        c1WriteLines(path.join(fixture.sessionsDir, "rollout-c.jsonl"), c1HealthyLines("Thread-C"));
      }
      return stmt;
    };
    try {
      await store.sync({ options: fixture.reportOptions });
    } finally {
      store.database.prepare = realPrepare;
    }
    assert.equal(state.injected, true, "前置：注入点必须命中");
    assert.equal(c1RecordCount(store), 0, "规划窗口不可证（读取期间集合变化）⇒ 绝不记录");
    assert.match(store.readMeta("perf_source_warnings"), /LIVE_SOURCE_CHANGED/);
    // 确定性恢复路径：下一轮（集合已稳定）重新规划并重新建立记录。
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c1RecordCount(store), 1, "恢复后必须重新建立记录");
    assert.match(store.readMeta("perf_source_warnings"), /MALFORMED_JSON/);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C1 · 瞬态读取失败不缓存为可跳过状态，且存在确定性恢复路径", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  let locker = null;
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c1RecordCount(store), 1, "前提：先有一条稳定失败记录");
    // 让坏 rollout 被**另一进程以 FileShare.None 独占锁定**：`enabledPerfSourceStat` 取不到指纹
    // ⇒ 签名不可证 ⇒ 命中判定必须失配并清除记录；随后规划读到 EBUSY ⇒ READ_ONLY_OPEN_FAILED。
    const lockerScript =
      `$fs=[System.IO.File]::Open('${fixture.badFile.replace(/'/g, "''")}','Open','Read','None'); ` +
      `Start-Sleep -Seconds 30; $fs.Close()`;
    locker = spawn("pwsh", ["-NoProfile", "-Command", lockerScript], { stdio: "ignore" });
    let lockHeld = false;
    for (let attempt = 0; attempt < 40 && !lockHeld; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        closeSync(openSync(fixture.badFile, "r"));
      } catch (error) {
        lockHeld = String(error?.code ?? "") === "EBUSY";
      }
    }
    assert.equal(lockHeld, true, "前提：必须真的持有独占锁（否则测不到读取失败）");
    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "degraded");
    assert.equal(c1RecordCount(store), 0, "读取失败（签名不可证）绝不能被缓存为可跳过状态");
    assert.match(store.readMeta("perf_source_warnings"), /READ_ONLY_OPEN_FAILED/);
    locker.kill();
    locker = null;
    let released = false;
    for (let attempt = 0; attempt < 40 && !released; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        closeSync(openSync(fixture.badFile, "r"));
        released = true;
      } catch {
        released = false;
      }
    }
    assert.equal(released, true, "前置：独占锁必须已释放");
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c1RecordCount(store), 1, "解锁后必须自动恢复并重新记录");
    assert.match(store.readMeta("perf_source_warnings"), /MALFORMED_JSON/);
  } finally {
    locker?.kill();
    store.close();
    fixture.close();
  }
});

test("C1 · 失效条件：方法版本与 home 身份变化立即重试", async () => {
  const fixture = makeC1Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c1HomeId(store);
    assert.equal(c1RecordCount(store), 1);
    // ① 方法版本（解析方法 + 发布策略修订；此处直接改写记录字段，等价于修订号变化）
    let sampleKey = c1MarkSentinel(store);
    store.codexStableAttempts.get(homeId).methodVersion = "stale-method";
    await store.sync({ options: fixture.reportOptions });
    assert.equal(
      c1SentinelSurvives(store, sampleKey),
      true,
      "C4：内容/归属都没变 ⇒ 健康线程的候选必须被**复用**；'规划确实重跑'由下一行的记录刷新证明",
    );
    assert.notEqual(store.codexStableAttempts.get(homeId)?.methodVersion, "stale-method", "记录必须被刷新");
    assert.deepEqual(c4BuildPlan(store), { homeId, staged: [], retained: ["Thread-A"] }, "C4：方法版本失配只重跑规划");
    // ② home 身份（物理路径）
    sampleKey = c1MarkSentinel(store);
    store.codexStableAttempts.get(homeId).homePath = "C:/elsewhere";
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c1SentinelSurvives(store, sampleKey), true, "C4：home 身份失配同样只重跑规划，不重建未受影响线程");
    assert.notEqual(store.codexStableAttempts.get(homeId)?.homePath, "C:/elsewhere", "记录必须被刷新");
    assert.deepEqual(c4BuildPlan(store), { homeId, staged: [], retained: ["Thread-A"] }, "C4：home 身份失配只重跑规划");
  } finally {
    store.close();
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// C2 卡：失败复用的**全部触发 / 告警 / 恢复**
//
// C1 只让"稳定失败"跳过**整 home 规划**；本卡把同一个判定贯通到**同一轮**的逐文件 refresh 判据
// （签名 ⇒ `reusedCurrent`），并把"收尾"补全（策略编码失败时丢弃无法持久化的复用投影）。
//
// S2 的三条红线逐条对齐（报告「实现行为」有论证）：
//   ① 喂进去的摘要与消费点之间**不得有任何对该文件的读取** —— 签名由 `codexStableAttemptMatch`
//      在本轮轮首取到，到逐文件判据之间没有任何读取（复用轮不调用 `planStableCodexHome`）；
//   ② `window.before` 不得喂给 `window.after`；③ `window.after` 不得喂给发布前复核
//      （复用轮该 home 不在 `codexPlans` 里 ⇒ 发布前复核本轮根本不执行）。
//
// 判别力惯用法沿用 C1：往**健康兄弟线程**的一行已发布候选写哨兵 —— 只要真的发生一次规划 + 发布，
// 该行必被 delete/insert 重建 ⇒ 哨兵丢失。它同时证明"没有全文规划"与"没有候选重写"。
// ---------------------------------------------------------------------------

const C2_ROOT = mkdtempSync(path.join(os.tmpdir(), "c2-failure-lifecycle-"));
process.on("exit", () => rmSync(C2_ROOT, { recursive: true, force: true }));
const C2_SENTINEL = "C2-SENTINEL";

function c2WriteLines(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  writeFileSync(file, `${body.join("\n")}\n`, "utf8");
  return file;
}

/** 一条**健康**回合序列（`token` 只影响 cwd，用于"等长原地改写"）。 */
function c2HealthyLines(threadId, { token = "aaaa", turn = "Turn-1", suffix = "" } = {}) {
  return [
    { type: "session_meta", payload: { id: threadId, session_id: threadId, source: "cli", cwd: `C:/c2/${token}` } },
    { type: "turn_context", payload: { thread_id: threadId, turn_id: turn, model: "C2-Model" } },
    {
      type: "token_usage_record",
      timestamp: "2026-10-04T12:00:01.000Z",
      payload: {
        thread_id: threadId,
        turn_id: turn,
        response_id: `resp-${threadId}${suffix}`,
        usage: { output_tokens: 120 },
        turn_token_usage: { output_tokens: 120 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turn,
        item: { id: `I-${turn}`, type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    },
  ];
}

/** 追加一个回合（不含 `session_meta`）。 */
function c2TurnLines(threadId, turn, suffix = "") {
  return c2HealthyLines(threadId, { turn, suffix }).slice(1);
}

/** 坏 JSON 行 ⇒ `MALFORMED_JSON`（**可隔离** ⇒ 部分失败，健康兄弟线程照常发布）。 */
function c2BadJsonLines(threadId) {
  return [...c2HealthyLines(threadId).slice(0, 2), "{not json"];
}

/** 未知顶层记录类型 ⇒ `UNSUPPORTED_SCHEMA`（**不可隔离** ⇒ 整个 home 受阻）。 */
function c2UnknownSchemaLines(threadId) {
  return [...c2HealthyLines(threadId), { type: "c2_unknown_top_level_record", payload: { note: "unsupported" } }];
}

let c2Seq = 0;
/** 隔离 fixture：home A（含一个可隔离的坏线程）+ 可选 home B。两个都是 codex 别名来源。 */
function makeC2Home({ secondHome = false } = {}) {
  const root = path.join(C2_ROOT, `case-${++c2Seq}`);
  const homeDir = path.join(root, "codex-a");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  const healthyFile = c2WriteLines(path.join(sessionsDir, "rollout-a.jsonl"), c2HealthyLines("Thread-A"));
  const badFile = c2WriteLines(path.join(sessionsDir, "rollout-b.jsonl"), c2BadJsonLines("Thread-B"));
  const homeBDir = path.join(root, "codex-b");
  const sessionsBDir = path.join(homeBDir, "sessions", "2026", "10");
  if (secondHome) c2WriteLines(path.join(sessionsBDir, "rollout-d.jsonl"), c2HealthyLines("Thread-D"));
  const reportOptions = {
    homeDir: root,
    env: {},
    extraHomes: secondHome ? `${homeDir}${path.delimiter}${homeBDir}` : homeDir,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  return {
    root,
    homeDir,
    sessionsDir,
    homeBDir,
    sessionsBDir,
    healthyFile,
    badFile,
    reportOptions,
    serverOptions: {
      ...reportOptions,
      databaseFile: path.join(root, "index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function c2MarkSentinel(store) {
  const row = store.database
    .prepare("SELECT sample_key FROM perf_samples WHERE source_kind = 'codex' ORDER BY sample_key LIMIT 1")
    .get();
  assert.ok(row, "前置：健康兄弟线程必须已发布候选");
  store.database
    .prepare("UPDATE perf_samples SET diagnostic_reason = ? WHERE sample_key = ?")
    .run(C2_SENTINEL, row.sample_key);
  return row.sample_key;
}

function c2SentinelSurvives(store, sampleKey) {
  const row = store.database.prepare("SELECT diagnostic_reason FROM perf_samples WHERE sample_key = ?").get(sampleKey);
  return row?.diagnostic_reason === C2_SENTINEL;
}

function c2RecordCount(store) {
  return store.codexStableAttempts?.size ?? 0;
}

function c2OnlyHomeId(store) {
  const ids = [...(store.codexStableAttempts?.keys() ?? [])];
  assert.equal(ids.length, 1, "前置：恰好一条稳定失败记录");
  return ids[0];
}

function c2Warnings(store) {
  return JSON.parse(store.readMeta("perf_source_warnings"));
}

function c2WarningCodes(store) {
  return c2Warnings(store).map((entry) => entry.code);
}

function c2DegradedIds(store) {
  return JSON.parse(store.readMeta("perf_degraded_home_ids"));
}

/**
 * C4 之前，C2 用"哨兵被重建"作为"本轮确实重新规划过"的**代理**。C4 让"重新规划"不再等于
 * "重建未受影响线程的候选" ⇒ 这个代理不再成立。保留等价强度的做法：直接读 C4 的**受影响集合**
 * （实例私有、仅本轮有效）+ 记录/策略是否被重建。两者一起断言，比单看哨兵更精确。
 */
function c2BuildPlan(store) {
  return c4BuildPlan(store);
}

function c2SampleRows(store) {
  return store.database.prepare("SELECT sample_key, output_tokens FROM perf_samples ORDER BY sample_key").all();
}

test("C2 · 复用贯通逐文件判据与收尾：稳定坏线程连续三轮不重读，记录对象不被重建、告警/策略/版本/候选逐字不变", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    const first = await store.sync({ options: fixture.reportOptions });
    assert.equal(first.perfState, "degraded", "坏线程使 home 进入 partial ⇒ degraded");
    assert.equal(c2RecordCount(store), 1, "一次稳定验证完成的部分失败必须留下记录");
    const homeId = c2OnlyHomeId(store);
    const record = store.codexStableAttempts.get(homeId);
    const policy = store.readMeta("perf_codex_publication_policy");
    const warnings = store.readMeta("perf_source_warnings");
    const version = store.readMeta("perf_index_version");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.match(policy, /Thread-B/);
    // 复用**只在 `shouldPlan === true` 时可达** ⇒ 该 home 必然同时是"上一轮 degraded"与"策略里的
    // partial"（`shouldPlan` 的第 2、3 个条件在每条复用路径上都是**既成事实**）。
    assert.equal(c2DegradedIds(store).includes(homeId), true, "shouldPlan 条件②：该 home 在 perf_degraded_home_ids 里");
    assert.equal(
      decodeCodexPublicationPolicy(policy).partialHomes.some((entry) => entry.homeId === homeId),
      true,
      "shouldPlan 条件③：该 home 在 partial 策略里",
    );
    const sampleKey = c2MarkSentinel(store);
    const rows = c2SampleRows(store);
    for (const round of [2, 3]) {
      const status = await store.sync({ options: fixture.reportOptions });
      assert.equal(status.perfState, "degraded", `第 ${round} 轮状态`);
      assert.equal(store.readMeta("perf_codex_publication_policy"), policy, `第 ${round} 轮 partial 策略逐字不变`);
      assert.equal(store.readMeta("perf_source_warnings"), warnings, `第 ${round} 轮告警不得丢失也不得累加`);
      assert.equal(store.readMeta("perf_index_version"), version, `第 ${round} 轮版本不得变化`);
      assert.equal(c2RecordCount(store), 1, `第 ${round} 轮记录仍在`);
      assert.equal(
        store.codexStableAttempts.get(homeId),
        record,
        `第 ${round} 轮不得重建记录对象（重建 = 真的重跑过一次规划 + 收尾提交）`,
      );
      assert.equal(
        c2SentinelSurvives(store, sampleKey),
        true,
        `第 ${round} 轮必须复用（否则规划 + 发布会重建健康兄弟线程的候选）`,
      );
      assert.deepEqual(c2SampleRows(store), rows, `第 ${round} 轮候选逐行不变`);
      assert.equal(status.updatedFileCount, 1, `第 ${round} 轮用量侧仍需重解析的集合不变（只有坏线程的 rollout）`);
    }
    assert.equal(
      first.updatedFileCount,
      2,
      "第 1 轮没有已发布指纹 ⇒ 两份 rollout 都要重解析；第 2 轮起只剩坏线程那份 ⇒ 这个差值正是用量提交独立于 perf 尝试的证据",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 有界后果：签名之后、判据之前的等长原地改写本轮按签名跳过，下一轮必然重新提取并发布（无静默丢失）", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    const first = await store.sync({ options: fixture.reportOptions });
    assert.equal(first.updatedFileCount, 2, "前置：第 1 轮两份 rollout 都还没有已发布指纹");
    const steady = await store.sync({ options: fixture.reportOptions });
    assert.equal(steady.updatedFileCount, 1, "前置：纯复用轮只有坏线程那份需要重解析");
    const sampleKey = c2MarkSentinel(store);
    // 注入点 = 逐文件循环里对该文件执行的 `SELECT DISTINCT session_id FROM events WHERE source_path = ?`
    //（晚于 codex 稳定失败签名，早于该文件的 refresh 判据）⇒ 等价于"签名刚取完文件就被改写"。
    const injection = injectC1BeforeDecision(store, fixture.healthyFile, () =>
      c1RewriteSameMetadata(fixture.healthyFile, "C:/c2/aaaa", "C:/c2/bbbb"),
    );
    let raced;
    try {
      raced = await store.sync({ options: fixture.reportOptions });
    } finally {
      injection.restore();
    }
    assert.equal(injection.injected, true, "前置：注入点必须命中");
    // 复用 ⇒ 判据用的是签名里的旧摘要 ⇒ 本轮**不**重解析该文件（真实探针会看到改写 ⇒ 变 2）。
    assert.equal(
      raced.updatedFileCount,
      1,
      "签名复用 ⇒ 本轮按旧摘要跳过（这条断言就是 `mut-no-reuse-in-loop` 的判别力来源）",
    );
    assert.equal(raced.perfState, "degraded");
    assert.equal(c2RecordCount(store), 1);
    assert.equal(c2SentinelSurvives(store, sampleKey), true, "复用轮不发布 ⇒ 候选保持不动");
    // 下一轮：签名与记录不符 ⇒ 立刻重新规划并按**新内容**发布 ⇒ 有界延迟 ≤1 轮、无静默丢失。
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.updatedFileCount, 2, "恢复轮必须重解析被改写的文件 + 坏线程那份");
    assert.equal(c2RecordCount(store), 1, "恢复后重新建立记录");
    assert.equal(c2SentinelSurvives(store, sampleKey), false, "恢复轮必然重新规划 + 重新发布");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 健康兄弟线程仍更新：坏线程仍隔离时，健康线程新增回合必须重新规划并发布新候选", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const sentinel = c2MarkSentinel(store);
    const turnsOfHealthy = () =>
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE sample_key LIKE '%Thread-A%'").get().n;
    assert.equal(turnsOfHealthy(), 1, "前提：健康线程先有 1 个回合的候选");
    c2WriteLines(fixture.healthyFile, [...c2HealthyLines("Thread-A"), ...c2TurnLines("Thread-A", "Turn-2", "-2")]);
    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "degraded", "坏线程仍隔离");
    assert.equal(turnsOfHealthy(), 2, "健康兄弟线程的新回合必须被发布（签名覆盖全 home ⇒ 内容一变即重新规划）");
    assert.equal(c2SentinelSurvives(store, sentinel), false, "重新规划 + 重新发布必然重建候选");
    assert.equal(c2RecordCount(store), 1, "重新规划后记录绑定新签名");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.equal(c2DegradedIds(store).includes(homeId), true);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 触发矩阵：home 级确定性失败（UNSUPPORTED_SCHEMA）⇒ 记录 home 级告警并复用（哨兵证明没有重建候选）", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const sentinel = c2MarkSentinel(store);
    // 把坏 rollout 换成"未知顶层记录"⇒ `UNSUPPORTED_SCHEMA` 且**不可隔离** ⇒ 整个 home 受阻。
    c2WriteLines(fixture.badFile, c2UnknownSchemaLines("Thread-B"));
    const blocked = await store.sync({ options: fixture.reportOptions });
    assert.equal(blocked.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("UNSUPPORTED_SCHEMA"), true, "home 级失败码必须投影");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), false, "旧的部分失败归因必须消失（不累加）");
    assert.equal(c2RecordCount(store), 1, "home 级确定性失败也必须留下记录");
    assert.equal(c2SentinelSurvives(store, sentinel), true, "home 级受阻 ⇒ 已发布候选保持不动");
    const record = store.codexStableAttempts.get(homeId);
    const warnings = store.readMeta("perf_source_warnings");
    assert.equal(record.blockedHomeWarnings.length, 1);
    assert.equal(record.blockedHomeWarnings[0].code, "UNSUPPORTED_SCHEMA");
    const version = store.readMeta("perf_index_version");
    // 复用轮：home 级告警**逐条重放**（不丢失、不累加），记录对象不被重建。
    const reused = await store.sync({ options: fixture.reportOptions });
    assert.equal(reused.perfState, "degraded");
    assert.equal(store.readMeta("perf_source_warnings"), warnings, "home 级告警必须逐字重放");
    assert.equal(store.readMeta("perf_index_version"), version);
    assert.equal(store.codexStableAttempts.get(homeId), record, "复用轮不得重建记录");
    assert.equal(c2SentinelSurvives(store, sentinel), true);
    // 反向对照：修好这一行 ⇒ 内容变 ⇒ 记录**立刻失效并重建**（下面直接断言记录对象被重建、
    // 且回到 partial 形态）⇒ 上面那条"复用轮记录不得重建"不是空话。
    //
    // C4：这里变的是**坏线程**，健康兄弟线程（Thread-A）的依赖集合与指纹都没变 ⇒ 不再被顺带重建。
    // 因此判据从"哨兵丢失"改为"记录对象被重建 + 受影响集合为空"（两者一起才等价于旧判据的强度）。
    c2WriteLines(fixture.badFile, c2BadJsonLines("Thread-B"));
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c2WarningCodes(store).includes("UNSUPPORTED_SCHEMA"), false);
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.notEqual(store.codexStableAttempts.get(homeId), record, "对照：内容变 ⇒ 记录对象必须被重建");
    assert.deepEqual(store.codexStableAttempts.get(homeId).blockedHomeWarnings, [], "对照：记录回到 partial 形态");
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId, staged: [], retained: ["Thread-A"] },
      "对照：真的规划过（受影响集合为空 ⇒ 只有坏线程，健康兄弟线程未受影响）",
    );
    assert.equal(c2SentinelSurvives(store, sentinel), true, "C4：健康兄弟线程未受影响 ⇒ 复用已发布候选");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 触发矩阵：发布事务回滚 ⇒ 不留下可跳过记录，已发布集合/版本保持旧值；下一轮自动恢复", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const version = store.readMeta("perf_index_version");
    const sentinel = c2MarkSentinel(store);
    // 让 healthy 线程真的变了（⇒ 本轮走规划路径并产生候选），再让 codex 发布事务在插入样本时抛错。
    c2WriteLines(fixture.healthyFile, [...c2HealthyLines("Thread-A"), ...c2TurnLines("Thread-A", "Turn-2", "-2")]);
    const realInsert = store.insertPerfSample.bind(store);
    store.insertPerfSample = () => {
      throw Object.assign(new Error("C2 injected publication failure"), { code: "READ_ONLY_OPEN_FAILED" });
    };
    let failed;
    try {
      failed = await store.sync({ options: fixture.reportOptions });
    } finally {
      store.insertPerfSample = realInsert;
    }
    assert.equal(failed.perfState, "degraded");
    assert.equal(c2RecordCount(store), 0, "发布事务回滚 ⇒ 本轮候选作废，绝不缓存为可跳过状态");
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), true, "发布失败必须归因");
    assert.equal(store.readMeta("perf_index_version"), version, "回滚不得伪造成功变更");
    assert.equal(c2SentinelSurvives(store, sentinel), true, "回滚后已发布候选保持旧值");
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c2RecordCount(store), 1, "下一轮必须自动恢复并重新记录");
    assert.notEqual(store.readMeta("perf_index_version"), version, "恢复轮必须推进版本");
    assert.equal(c2SentinelSurvives(store, sentinel), false, "恢复轮重建候选");
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), false, "瞬态归因随轮消失");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 触发矩阵：跨 home 冲突 ⇒ 记录立刻作废、两个 home 都 degraded；归属收敛后自动恢复", async () => {
  // 真实的跨 home 冲突 = **同一物理路径**被记在另一个 home id 名下。构造方式：同一个 codex 目录
  // 先经 `extraHomes` 被发现（kind `extra`），再经 JetBrains 根被发现（kind `jetbrains`）——
  // 路径字符串逐字不变、home id 不同，正是 `crossHomeBlockedIds` 守卫要抓的输入。
  const root = path.join(C2_ROOT, `cross-${++c2Seq}`);
  const jbHome = path.join(root, "c2home", "AppData", "Local", "JetBrains", "Prod", "aia", "codex");
  const sessionsDir = path.join(jbHome, "sessions", "2026", "10");
  const badFile = c2WriteLines(path.join(sessionsDir, "rollout-b.jsonl"), c2BadJsonLines("Thread-B"));
  const healthyFile = c2WriteLines(path.join(sessionsDir, "rollout-a.jsonl"), c2HealthyLines("Thread-A"));
  const round1 = {
    homeDir: path.join(root, "other"),
    env: {},
    extraHomes: jbHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const round2 = { ...round1, homeDir: path.join(root, "c2home"), extraHomes: "" };
  const store = new UsageStore({
    ...round2,
    databaseFile: path.join(root, "index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
  });
  try {
    await store.sync({ options: round1 });
    assert.equal(c2RecordCount(store), 1, "前提：home A 的坏线程留下记录");
    const sentinel = c2MarkSentinel(store);
    // 同一个目录改成由 JetBrains 根发现 ⇒ 路径不变、home id 变 ⇒ 库里归属与当前发现冲突。
    const conflicted = await store.sync({ options: round2 });
    assert.equal(conflicted.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), true, "跨 home 冲突按 UNKEYABLE_RECORD 归因");
    assert.equal(c2RecordCount(store), 0, "跨 home 冲突 ⇒ 旧记录立刻作废（拒绝被旧投影盖住）");
    assert.equal(c2DegradedIds(store).length, 2, "冲突涉及的两个 home 都计入 degraded");
    assert.equal(c2SentinelSurvives(store, sentinel), true, "冲突轮不发布 ⇒ 已发布候选保持不动");
    // 前向迁移不收敛（**已在报告中登记为既有边界，非本卡引入**）：`perf_rollout_threads` 里的旧
    // 归属行只能由一次成功发布重写，而该守卫恰好阻断发布 ⇒ 只要仍按新 home 发现，就一直是冲突。
    await store.sync({ options: round2 });
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), true, "前向迁移轮仍冲突（有界性说明见报告）");
    assert.equal(c2RecordCount(store), 0);
    // 回到**原归属**的发现方式 ⇒ 两轮内收敛（第一轮先把 `source_files` 的归属改写回去）。
    await store.sync({ options: round1 });
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), true, "回到原归属的第一轮仍是冲突轮");
    assert.equal(c2RecordCount(store), 0);
    const recovered = await store.sync({ options: round1 });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c2RecordCount(store), 1, "归属收敛后必须自动重新规划并重建记录");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), false, "冲突告警随收敛消失（不累加）");
    assert.equal(c2DegradedIds(store).length, 1);
    assert.equal(
      c2SentinelSurvives(store, sentinel),
      true,
      "C4：收敛轮的受影响集合为空（见下一行）⇒ 健康兄弟线程的候选复用，不再被顺带重建",
    );
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId: c2OnlyHomeId(store), staged: [], retained: ["Thread-A"] },
      "C4：收敛轮确实重新规划过（记录已按新签名重建，见上一行），但没有线程需要重建",
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(badFile).n, 1);
    assert.equal(healthyFile.startsWith(sessionsDir), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2 · 触发矩阵：策略编码失败 ⇒ 复用记录被丢弃（不粘住）、绝不写 ready、告警不膨胀；下一轮恢复", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const policy = store.readMeta("perf_codex_publication_policy");
    const malformedBefore = c2WarningCodes(store).filter((code) => code === "MALFORMED_JSON").length;
    // 注入：让命中记录携带一个**不可编码**的被隔离线程 id（`encodeCodexPublicationPolicy` 对空
    // threadId 抛 TypeError）——代表"记录里的身份在编码器口径下非法"，编码器本身是真实代码。
    store.codexStableAttempts.get(homeId).blockedThreadIds = [""];
    const broken = await store.sync({ options: fixture.reportOptions });
    assert.equal(broken.perfState, "degraded", "策略编码失败绝不能让 home 静默变 ready");
    assert.equal(c2DegradedIds(store).includes(homeId), true);
    assert.notEqual(store.readMeta("perf_codex_publication_policy"), policy, "无法编码 ⇒ 权限不得持久化");
    assert.equal(c2RecordCount(store), 0, "复用记录必须被丢弃（否则下一轮再失败 ⇒ 记录粘住）");
    assert.equal(
      c2WarningCodes(store).filter((code) => code === "MALFORMED_JSON").length,
      malformedBefore,
      "被隔离线程的告警不得因策略失败而丢失或累加",
    );
    assert.equal(
      c2WarningCodes(store).filter((code) => code === "READ_ONLY_OPEN_FAILED").length,
      1,
      "策略失败本身按一次受阻归因（与规划路径同型，不膨胀）",
    );
    // 恢复：策略已不可用 ⇒ 下一轮 `policyNeedsUpgrade` ⇒ 重新规划并逐字恢复策略。
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c2RecordCount(store), 1);
    assert.equal(store.readMeta("perf_codex_publication_policy"), policy, "重新规划后策略逐字恢复");
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), false, "瞬态归因随轮消失");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 触发矩阵：用量侧失败 ⇒ 同轮规划候选作废（不写回）；下一轮自动恢复", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const sentinel = c2MarkSentinel(store);
    // healthy 线程真的变了 ⇒ 本轮走规划路径并产生候选；坏 rollout 的 `replaceFile`（用量侧）
    // 在**循环里**抛错 ⇒ 该 home 的受阻事件计数增大 ⇒ 候选必须作废。
    c2WriteLines(fixture.healthyFile, [...c2HealthyLines("Thread-A"), ...c2TurnLines("Thread-A", "Turn-2", "-2")]);
    const realReplace = store.replaceFile.bind(store);
    store.replaceFile = async (file, options) => {
      if (file.filePath === fixture.badFile) {
        throw Object.assign(new Error("C2 injected usage-side failure"), { code: "READ_ONLY_OPEN_FAILED" });
      }
      return realReplace(file, options);
    };
    let failed;
    try {
      failed = await store.sync({ options: fixture.reportOptions });
    } finally {
      store.replaceFile = realReplace;
    }
    assert.equal(failed.perfState, "degraded");
    assert.equal(c2RecordCount(store), 0, "用量侧受阻 ⇒ 同轮候选作废（C1 的受阻事件快照正是为它而设）");
    assert.equal(
      store.warnings.some((line) => String(line).includes("无法索引")),
      true,
      "用量侧告警必须保留（用户明示不得被 perf 归因吞掉）",
    );
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), true);
    assert.equal(c2SentinelSurvives(store, sentinel), true, "本轮没有发布 ⇒ 已发布候选保持不动");
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c2RecordCount(store), 1, "下一轮必须自动恢复并重新记录");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), false, "瞬态归因随轮消失");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 恢复路径：删除 / 重命名 rollout 与 home 别名变化都必须立即失效并重新规划", async () => {
  // ① 重命名（完整路径集变化）
  const renamed = makeC2Home();
  let store = new UsageStore(renamed.serverOptions);
  try {
    await store.sync({ options: renamed.reportOptions });
    const sentinel = c2MarkSentinel(store);
    const nextBad = path.join(renamed.sessionsDir, "rollout-b2.jsonl");
    moveFixtureFile(renamed.badFile, nextBad);
    await store.sync({ options: renamed.reportOptions });
    const record = store.codexStableAttempts.get(c2OnlyHomeId(store));
    assert.equal(record.paths.includes(nextBad), true, "记录必须绑定**新**路径");
    assert.equal(record.paths.includes(renamed.badFile), false, "旧路径不得留在记录里");
    assert.equal(
      c2SentinelSurvives(store, sentinel),
      true,
      "C4：重命名的是**坏线程**的 rollout；健康兄弟线程的路径集/指纹不变 ⇒ 复用已发布候选",
    );
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId: c2OnlyHomeId(store), staged: [], retained: ["Thread-A"] },
      "C4：路径集变化只强制**重新规划**（记录已按新路径重建），不重建未受影响线程",
    );
  } finally {
    store.close();
    renamed.close();
  }
  // ② home 别名（kind）变化
  const aliased = makeC2Home();
  store = new UsageStore(aliased.serverOptions);
  try {
    await store.sync({ options: aliased.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const sentinel = c2MarkSentinel(store);
    store.codexStableAttempts.get(homeId).homeKind = "main";
    await store.sync({ options: aliased.reportOptions });
    assert.notEqual(store.codexStableAttempts.get(homeId)?.homeKind, "main", "记录必须被刷新");
    assert.equal(
      c2SentinelSurvives(store, sentinel),
      true,
      "C4：home 别名/身份失配只强制**重新规划**；未受影响线程的候选复用",
    );
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId, staged: [], retained: ["Thread-A"] },
      "C4：记录已按新 kind 重建（上一行）⇒ 规划确实重跑，但无线程需重建",
    );
  } finally {
    store.close();
    aliased.close();
  }
  // ③ 删除坏 rollout ⇒ 回到 ready 且记录清除
  const deleted = makeC2Home();
  store = new UsageStore(deleted.serverOptions);
  try {
    await store.sync({ options: deleted.reportOptions });
    const sentinel = c2MarkSentinel(store);
    rmSync(deleted.badFile);
    const status = await store.sync({ options: deleted.reportOptions });
    assert.equal(status.perfState, "ready", "唯一坏 rollout 被删除 ⇒ 恢复 ready");
    assert.deepEqual(c2Warnings(store), [], "告警必须清空");
    assert.equal(c2RecordCount(store), 0, "记录不再适用，必须清除");
    // C4：删掉的是**坏线程**的 rollout（它从来没有候选）；健康兄弟线程 Thread-A 的依赖集合没变
    // ⇒ 候选复用。删除本身必须**真的生效**（下面直接查 `source_files`），这才等价于旧的哨兵判据。
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(deleted.badFile).n,
      1,
      "被删除 rollout 的来源身份必须保留",
    );
    assert.deepEqual(
      status.missingSources.map((source) => source.path),
      [deleted.badFile],
      "被删除 rollout 必须登记 missing",
    );
    const deletePlan = c4BuildPlan(store);
    assert.deepEqual(
      { staged: deletePlan.staged, retained: deletePlan.retained },
      { staged: [], retained: ["Thread-A"] },
      "C4：删除轮确实重新规划过，但没有线程需要重建",
    );
    assert.equal(
      c2SentinelSurvives(store, sentinel),
      true,
      "C4：健康兄弟线程未受影响 ⇒ 复用已发布候选（不再被顺带重建）",
    );
  } finally {
    store.close();
    deleted.close();
  }
});

test("C2 · shouldPlan 的其余条件：路径集 / 内容指纹 / 策略升级 / 旧候选不可归属都必须重新规划", async () => {
  // ① 路径集（新增 rollout）
  const added = makeC2Home();
  let store = new UsageStore(added.serverOptions);
  try {
    await store.sync({ options: added.reportOptions });
    const sentinel = c2MarkSentinel(store);
    c2WriteLines(path.join(added.sessionsDir, "rollout-c.jsonl"), c2HealthyLines("Thread-C"));
    await store.sync({ options: added.reportOptions });
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE sample_key LIKE '%Thread-C%'").get().n > 0,
      true,
      "新增线程的候选必须被发布（这条断言就是「路径集变化 ⇒ 重新规划」的**结果**证据）",
    );
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId: c2OnlyHomeId(store), staged: ["Thread-C"], retained: ["Thread-A"] },
      "C4：路径集变化 ⇒ 重新规划；受影响集合恰为新增线程 C",
    );
    assert.equal(c2SentinelSurvives(store, sentinel), true, "C4：健康兄弟线程 Thread-A 未受影响 ⇒ 复用其候选");
  } finally {
    store.close();
    added.close();
  }
  // ② 内容指纹（同尺寸 + 同 mtime 的原地改写）
  const rewritten = makeC2Home();
  store = new UsageStore(rewritten.serverOptions);
  try {
    await store.sync({ options: rewritten.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const recordBefore = store.codexStableAttempts.get(homeId);
    const sentinel = c2MarkSentinel(store);
    c1RewriteSameMetadata(rewritten.badFile, "{not json", "{bad json");
    await store.sync({ options: rewritten.reportOptions });
    assert.notEqual(
      store.codexStableAttempts.get(homeId)?.fileFingerprints[rewritten.badFile],
      recordBefore.fileFingerprints[rewritten.badFile],
      "内容指纹变化 ⇒ 记录必须立刻失效并绑定新指纹（`size+mtime` 判据看不见该改写）",
    );
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId, staged: [], retained: ["Thread-A"] },
      "C4：记录失效 ⇒ 重新规划；受影响集合为空（改的是坏线程，它没有候选）",
    );
    assert.equal(c2SentinelSurvives(store, sentinel), true, "C4：健康兄弟线程 Thread-A 未受影响 ⇒ 复用其候选");
  } finally {
    store.close();
    rewritten.close();
  }
  // ③ `policyNeedsUpgrade`：**有**有效记录时它不是"重新规划"的理由 —— 记录本身就把丢失的策略
  //    逐字恢复（复用不等于跳过收尾）；把记录也清掉（等价于进程刚重启）后，它才是**唯一**真条件。
  const upgraded = makeC2Home();
  store = new UsageStore(upgraded.serverOptions);
  try {
    await store.sync({ options: upgraded.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const sentinel = c2MarkSentinel(store);
    const policy = store.readMeta("perf_codex_publication_policy");
    const warnings = store.readMeta("perf_source_warnings");
    store.writeMeta("perf_codex_publication_policy", "");
    const restored = await store.sync({ options: upgraded.reportOptions });
    assert.equal(restored.perfState, "degraded");
    assert.equal(c2SentinelSurvives(store, sentinel), true, "记录可独立支撑本轮投影 ⇒ 不必重新规划");
    assert.equal(c2RecordCount(store), 1, "记录仍在");
    assert.equal(store.readMeta("perf_codex_publication_policy"), policy, "策略必须由记录逐字恢复（复用不得跳过收尾）");
    assert.equal(store.readMeta("perf_source_warnings"), warnings, "告警逐字恢复");
    // 隔离 `policyNeedsUpgrade`：同时清空策略、degraded 列表与记录 ⇒ 三个 shouldPlan 条件里只剩它。
    store.writeMeta("perf_codex_publication_policy", "");
    store.writeMeta("perf_degraded_home_ids", "[]");
    store.codexStableAttempts.clear();
    await store.sync({ options: upgraded.reportOptions });
    assert.equal(c2RecordCount(store), 1, "重新规划后记录仍在");
    assert.equal(store.readMeta("perf_codex_publication_policy").includes(homeId), true, "策略必须被重建");
    assert.equal(c2DegradedIds(store).includes(homeId), true);
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId, staged: [], retained: ["Thread-A"] },
      "C4：只剩 policyNeedsUpgrade 时确实重新规划（策略已重建，见上两行），但没有线程需要重建",
    );
    assert.equal(c2SentinelSurvives(store, sentinel), true, "C4：未受影响线程的候选复用");
  } finally {
    store.close();
    upgraded.close();
  }
  // ④ `codexHomesWithUnkeyableOldSamples`：往旧候选里放一条身份不可判定的 codex 样本
  const unkeyable = makeC2Home();
  store = new UsageStore(unkeyable.serverOptions);
  try {
    await store.sync({ options: unkeyable.reportOptions });
    assert.equal(c2RecordCount(store), 1);
    const row = store.database
      .prepare("SELECT sample_key FROM perf_samples WHERE source_kind = 'codex' ORDER BY sample_key LIMIT 1")
      .get();
    const badKey = "c2-unkeyable-sample";
    store.database.exec("BEGIN IMMEDIATE");
    store.database.exec("PRAGMA defer_foreign_keys = ON");
    store.database
      .prepare("UPDATE perf_sample_sources SET sample_key = ? WHERE sample_key = ?")
      .run(badKey, row.sample_key);
    store.database.prepare("UPDATE perf_samples SET sample_key = ? WHERE sample_key = ?").run(badKey, row.sample_key);
    store.database.exec("COMMIT");
    const sentinelAlive = () =>
      store.database.prepare("SELECT diagnostic_reason FROM perf_samples WHERE sample_key = ?").get(badKey)
        ?.diagnostic_reason === C2_SENTINEL;
    store.database
      .prepare("UPDATE perf_samples SET diagnostic_reason = ? WHERE sample_key = ?")
      .run(C2_SENTINEL, badKey);
    await store.sync({ options: unkeyable.reportOptions });
    assert.equal(c2RecordCount(store), 0, "旧候选身份不可判定 ⇒ 复用记录作废");
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), true, "必须按 UNKEYABLE_RECORD 归因");
    assert.equal(sentinelAlive(), true, "该守卫在规划之前 `continue` ⇒ 本轮不发布、不改写候选");
    // 收拾干净 ⇒ 下一轮重新规划并重建记录（重放会重建候选 ⇒ 哨兵随之消失）。
    store.database.exec("BEGIN IMMEDIATE");
    store.database.exec("PRAGMA defer_foreign_keys = ON");
    store.database
      .prepare("UPDATE perf_sample_sources SET sample_key = ? WHERE sample_key = ?")
      .run(row.sample_key, badKey);
    store.database.prepare("UPDATE perf_samples SET sample_key = ? WHERE sample_key = ?").run(row.sample_key, badKey);
    store.database.exec("COMMIT");
    await store.sync({ options: unkeyable.reportOptions });
    assert.equal(c2RecordCount(store), 1, "收拾干净后必须自动恢复");
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), false);
    assert.equal(sentinelAlive(), false, "恢复轮重新规划 + 重新发布 ⇒ 候选被重建");
  } finally {
    store.close();
    unkeyable.close();
  }
  // ⑤ 结构性断言：六个条件逐字保留，且复用命中点必须排在 `shouldPlan` **之后**。
  const source = readFileSync(new URL("../src/usage-store.js", import.meta.url), "utf8");
  for (const term of [
    "policyNeedsUpgrade",
    "priorDegradedHomeIds.has(homeId)",
    "priorPartialHomeIds.has(homeId)",
    "pathSetChanged",
    "metadataChanged",
    "codexHomesWithUnkeyableOldSamples.has(homeId)",
  ]) {
    assert.equal(source.includes(term), true, `shouldPlan 条件必须保留：${term}`);
  }
  assert.ok(
    source.indexOf("const shouldPlan =") < source.indexOf("this.codexStableAttemptMatch(homeId, home, expectedPaths)"),
    "复用命中点必须排在 shouldPlan 与三个守卫之后",
  );
});

test("C2 · 复用判定守卫（单元）：codexReusedProbeValue 的来源/身份/路径守卫与记录生命周期", async () => {
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c2OnlyHomeId(store);
    const record = store.codexStableAttempts.get(homeId);
    const signature = { paths: [...record.paths], fileFingerprints: record.fileFingerprints };
    // 命中：逐字路径。
    assert.equal(
      store.codexReusedProbeValue(signature, "extra", fixture.badFile),
      record.fileFingerprints[fixture.badFile],
    );
    // 非 codex 来源 ⇒ 绝不复用（zcode/dsh/opencode 没有这种签名）。
    assert.equal(store.codexReusedProbeValue(signature, "zcode", fixture.badFile), undefined);
    // 无签名（本轮没有命中记录）⇒ 不复用。
    assert.equal(store.codexReusedProbeValue(undefined, "extra", fixture.badFile), undefined);
    // 路径不在签名里 ⇒ 不复用（新观测/重命名 ⇒ 真实探针）。
    assert.equal(
      store.codexReusedProbeValue(signature, "extra", path.join(fixture.sessionsDir, "nope.jsonl")),
      undefined,
    );
    // 大小写写法不同 ⇒ 规范物理路径命中（Windows 大小写不敏感）。
    assert.equal(
      store.codexReusedProbeValue(signature, "extra", fixture.badFile.toUpperCase()),
      record.fileFingerprints[fixture.badFile],
    );
    // 索引身份守卫：`probePathIndex` 缓存在**签名对象**上；`fileFingerprints` 被换成另一个对象后
    // 必须**重建**索引，绝不能拿旧索引给出上一个签名的事实（调用方会拿到过期摘要）。
    const replaced = { ...signature, fileFingerprints: { [fixture.badFile]: "REPLACED-FINGERPRINT" } };
    assert.equal(
      store.codexReusedProbeValue(replaced, "extra", fixture.badFile.toUpperCase()),
      "REPLACED-FINGERPRINT",
      "签名身份变化后路径索引必须重建",
    );
    assert.equal(store.codexReusedProbeValue(replaced, "extra", fixture.badFile), "REPLACED-FINGERPRINT");
    // 记录生命周期：实例私有、`close()` 清空、绝不跨实例。
    assert.equal(store.codexStableAttempts.size, 1);
  } finally {
    store.close();
    assert.equal(store.codexStableAttempts.size, 0, "close() 必须清空记录");
    fixture.close();
  }
});

test("C2 · 触发矩阵（真实路径）：rollout 缺线程身份（UNKEYABLE_RECORD）⇒ home 级受阻、记录可复用、修好后恢复", async () => {
  // 这条用例是"C2 必须在**真实路径**上走通白名单码"的那一半：`UNKEYABLE_RECORD` 不是构造出来的
  // 错误对象，而是**一个真实 rollout 文件**（有回合记录、但没有 `session_meta` ⇒ 归属证明为 null）
  // 被 `evaluateCodexProjection` 判成 `isolatable: false` ⇒ 整个 home 受阻。
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    // 第 1 轮：坏 JSON 是**可隔离**的部分失败 ⇒ 健康兄弟线程（Thread-A）照常发布，先拿到哨兵。
    const partial = await store.sync({ options: fixture.reportOptions });
    assert.equal(partial.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.equal(c2RecordCount(store), 1, "前置：部分失败先留下一条 partial 形态的记录");
    const homeId = c2OnlyHomeId(store);
    assert.deepEqual(store.codexStableAttempts.get(homeId).blockedHomeWarnings, [], "前置：第 1 轮是 partial 形态");
    const sentinel = c2MarkSentinel(store);
    // 第 2 轮：把坏文件换成"有回合、无身份头"的**真实**文件（删掉第 1 行 `session_meta`）⇒
    // 归属证明为 null、`isolatable: false` ⇒ 整个 home 受阻（home 级形态）。
    c2WriteLines(fixture.badFile, c2HealthyLines("Thread-B").slice(1));
    const blocked = await store.sync({ options: fixture.reportOptions });
    assert.equal(blocked.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), true, "真实文件必须在端到端路径上产出该码");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), false, "旧的部分失败归因必须消失（不累加）");
    assert.equal(c2RecordCount(store), 1, "home 级确定性失败也必须留下记录");
    const record = store.codexStableAttempts.get(homeId);
    assert.equal(record.blockedHomeWarnings.length, 1);
    assert.equal(record.blockedHomeWarnings[0].code, "UNKEYABLE_RECORD");
    assert.deepEqual(record.blockedThreadIds, [], "home 级受阻没有 partial 线程清单（与 partial 形态互斥）");
    assert.equal(c2SentinelSurvives(store, sentinel), true, "home 级受阻 ⇒ 已发布候选保持不动");
    const warnings = store.readMeta("perf_source_warnings");
    const version = store.readMeta("perf_index_version");
    // 第 3 轮：复用轮 —— home 级告警逐条重放，记录对象不被重建，候选不动。
    const reused = await store.sync({ options: fixture.reportOptions });
    assert.equal(reused.perfState, "degraded");
    assert.equal(store.readMeta("perf_source_warnings"), warnings, "home 级告警必须逐字重放（不丢失、不累加）");
    assert.equal(store.readMeta("perf_index_version"), version);
    assert.equal(store.codexStableAttempts.get(homeId), record, "复用轮不得重建记录");
    assert.equal(c2SentinelSurvives(store, sentinel), true, "home 级受阻复用轮不发布");
    // 第 4 轮：确定性恢复 —— 换回可隔离的坏 JSON ⇒ 内容变 ⇒ 立即失效、重新规划、重新发布。
    c2WriteLines(fixture.badFile, c2BadJsonLines("Thread-B"));
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), false, "告警随修复消失（不累加）");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    assert.equal(c2RecordCount(store), 1, "记录重新绑定修复后的内容");
    assert.deepEqual(store.codexStableAttempts.get(homeId).blockedHomeWarnings, [], "记录回到 partial 形态");
    assert.deepEqual(
      c2BuildPlan(store),
      { homeId, staged: [], retained: ["Thread-A"] },
      "对照：真的重新规划过（记录回到 partial 形态，见上一行），但没有任何线程需要重建",
    );
    assert.equal(
      c2SentinelSurvives(store, sentinel),
      true,
      "C4：变的是坏线程；健康兄弟线程 Thread-A 未受影响 ⇒ 复用已发布候选",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("C2 · 触发矩阵：发布前复核发现来源变化（LIVE_SOURCE_CHANGED）⇒ 不复用签名、不留下可跳过记录；下一轮恢复", async () => {
  // 主动对齐 S2 红线 ③：**稳定签名绝不能喂给发布前复核**。判别力靠"复核拿到的必须是真实探针"：
  // 在"读取后窗口成立之后、发布前复核之前"对**健康兄弟线程**做等长原地改写（`size + mtime` 看不见），
  // 复核只有真的重新 stat 才会发现它 ⇒ `LIVE_SOURCE_CHANGED` 必须出现、记录必须为 0。
  // 若有人把 `codexReusedProbeValue` 的取到值接到复核上（`mut-publish-reuses-signature`），
  // 或让复核复用 `window.after`（`mut-precheck-reuses-after`），复核就恒真、这条断言必红。
  const fixture = makeC2Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.open();
    const injection = injectC1BeforeDecision(store, fixture.healthyFile, () =>
      c1RewriteSameMetadata(fixture.healthyFile, "C:/c2/aaaa", "C:/c2/bbbb"),
    );
    let raced;
    try {
      raced = await store.sync({ options: fixture.reportOptions });
    } finally {
      injection.restore();
    }
    assert.equal(injection.injected, true, "前置：注入点必须命中（晚于读取窗口、早于发布前复核）");
    assert.equal(raced.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("LIVE_SOURCE_CHANGED"), true, "复核必须真的重新探针");
    assert.equal(c2RecordCount(store), 0, "发布受阻 ⇒ 绝不缓存为可跳过状态");
    // 确定性恢复路径：下一轮（无注入）重新规划并重新建立记录。
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "degraded");
    assert.equal(c2RecordCount(store), 1, "下一轮必须自动恢复并重新记录");
    assert.equal(c2WarningCodes(store).includes("LIVE_SOURCE_CHANGED"), false, "瞬态归因随轮消失（不累加）");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
  } finally {
    store.close();
    fixture.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 卡：未变文件标准化投影复用（lazy planner 下由持久行承载）
//   * 单元：缓存守卫（来源 / 窗口 / 路径 / 指纹 / 方法版本 / home 身份 / 索引身份）。
//   * 端到端：内容真变轮只重读改变的文件；未变文件从持久行 transient 水合，不常驻 parsed cache。
//   * 失效矩阵：同尺寸同 mtime 改写、路径集变化、方法版本、home 变化、跨轮/跨实例、
//     稳定窗口（rollback）与发布事务回滚。
//   * 有界：maxBytes 逐出 + 稳态不增长 + close() 清空 + 只按受影响线程写入私有表。
// ─────────────────────────────────────────────────────────────────────────────
const C3_ROOT = mkdtempSync(path.join(os.tmpdir(), "c3-projection-reuse-"));
process.on("exit", () => rmSync(C3_ROOT, { recursive: true, force: true }));
/** 钉住的 mtime（秒，带小数）—— 让"同尺寸 + 同 mtime 原地改写"可复现。 */
const C3_PINNED_SECONDS = 1_800_000_000.123;

/**
 * 一条健康回合序列。`padBytes > 0` 时在 token 记录**前后各**插入一个登记过的忽略顶层类型
 * （`response_item`）大对象 ⇒ 把 token 记录推到**首尾各 64KiB 探针之外**（边界用例用）。
 */
function c3Lines(threadId, { output = 120, turn = "Turn-1", padBytes = 0 } = {}) {
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, session_id: threadId, source: "cli" } }),
    JSON.stringify({ type: "turn_context", payload: { thread_id: threadId, turn_id: turn, model: "C3-Model" } }),
  ];
  if (padBytes > 0) lines.push(JSON.stringify({ type: "response_item", payload: { pad: "p".repeat(padBytes) } }));
  lines.push(
    JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-10-04T12:00:01.000Z",
      payload: {
        thread_id: threadId,
        turn_id: turn,
        response_id: `resp-${threadId}-${turn}`,
        usage: { output_tokens: output },
        turn_token_usage: { output_tokens: output },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turn,
        item: { id: `I-${turn}`, type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    }),
  );
  if (padBytes > 0) lines.push(JSON.stringify({ type: "response_item", payload: { pad: "q".repeat(padBytes) } }));
  return lines;
}

function c3Write(file, threadId, options) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${c3Lines(threadId, options).join("\n")}\n`, "utf8");
  utimesSync(file, C3_PINNED_SECONDS, C3_PINNED_SECONDS);
  return file;
}

function c3AppendTurn(file, threadId, turn) {
  writeFileSync(file, `${readFileSync(file, "utf8")}${c3Lines(threadId, { turn }).slice(1).join("\n")}\n`, "utf8");
}

let c3Seq = 0;
/** 隔离 fixture：一个 codex home，含 `count` 份**健康** rollout（A/B/C/D…）。 */
function makeC3Home({ count = 3, padBytes = 0 } = {}) {
  const root = path.join(C3_ROOT, `case-${++c3Seq}`);
  const homeDir = path.join(root, "codex");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  const paths = [];
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const name = String.fromCharCode(65 + index);
    names.push(name);
    paths.push(c3Write(path.join(sessionsDir, `rollout-${name.toLowerCase()}.jsonl`), `Thread-${name}`, { padBytes }));
  }
  const options = { homeDir: root, env: {}, extraHomes: homeDir, importDirs: [], automaticDiscoveryEnabled: false };
  return {
    root,
    homeDir,
    sessionsDir,
    paths,
    names,
    reportOptions: options,
    serverOptions: {
      ...options,
      databaseFile: path.join(root, "index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    },
    close: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows 上句柄释放可能滞后：删除失败不影响断言（`process.on("exit")` 会再清一次整棵 C3_ROOT）。
      }
    },
  };
}

/** home 里某个 rollout 文件的路径（按 A/B/C… 名取）。 */
function c3PathOf(fixture, letter) {
  const index = fixture.names.indexOf(letter);
  assert.notEqual(index, -1, `前置：fixture 里必须有 ${letter}`);
  return fixture.paths[index];
}

/** 该线程已发布的候选数 / 首个候选的 output_tokens。 */
function c3Samples(store, threadId) {
  return store.database
    .prepare("SELECT sample_key, output_tokens FROM perf_samples WHERE sample_key LIKE ? ORDER BY sample_key")
    .all(`%"${threadId}"%`);
}

function c3OutputFor(store, threadId) {
  const rows = c3Samples(store, threadId);
  assert.equal(rows.length, 1, `前置：恰好一条 ${threadId} 的候选`);
  // Projection reuse is observable even when no generation timing was recorded.
  const source = store.database
    .prepare("SELECT source_path FROM perf_rollout_threads WHERE thread_id = ?")
    .get(threadId);
  const projection = JSON.parse(
    String(
      store.database
        .prepare("SELECT projection FROM perf_codex_projections WHERE lower(path) = lower(?)")
        .get(source.source_path).projection,
    ),
  );
  return projection.records.find((record) => record.kind === "token_usage_record").outputTokens;
}

function c3StoredEntry(store, filePath) {
  const suffix = path.basename(filePath).toLowerCase();
  return store.database
    .prepare(
      `SELECT path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at
       FROM perf_codex_projections`,
    )
    .all()
    .find((entry) => String(entry.path).endsWith(suffix));
}

function c3StoredSnapshot(store) {
  return Object.fromEntries(
    store.database
      .prepare(
        `SELECT path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at
         FROM perf_codex_projections`,
      )
      .all()
      .map((entry) => [
        String(entry.path),
        {
          homeId: String(entry.home_id),
          kind: String(entry.kind),
          methodVersion: String(entry.method_version),
          fingerprint: String(entry.fingerprint),
          bytes: Number(entry.bytes),
          projection: String(entry.projection),
          updatedAt: String(entry.updated_at),
        },
      ]),
  );
}

function c3PersistenceDelta(before, after) {
  const fields = [
    "hydratedRows",
    "staleFingerprintRows",
    "invalidatedRows",
    "corruptRows",
    "persistedRows",
    "prunedRows",
  ];
  return Object.fromEntries(fields.map((field) => [field, after.persistence[field] - before.persistence[field]]));
}

test("C3 · 端到端：有变更轮只重读改变的文件，未变文件从持久行水合并保持逐字不变", async () => {
  const fixture = makeC3Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const cold = store.codexProjections.stats();
    assert.equal(cold.entries, 0, "lazy planner 冷同步后不保留 parsed projection");
    assert.equal(cold.stagedEntries, 0, "受影响线程提交后不得残留暂存");
    assert.equal(cold.persistence.persistedRows, 3, "3 个受影响线程各落一条投影");
    assert.equal(store.codexProjections.persistedRowCount(), 3, "持久行覆盖当前 3 个文件");
    assert.equal(Array.isArray(store.perfCandidatesForRange(null)), true, "公共范围查询继续返回数组");
    assert.equal(Array.isArray(store.unplacedPerfSamples()), true, "公共 unplaced 查询继续返回数组");
    assert.equal(store.readMeta("perf_state"), "ready");
    // 持久行的完整快照：未变文件的 fingerprint、projection 与 updated_at 都必须逐字不变。
    const snapshotBefore = c3StoredSnapshot(store);

    // 只让 A **真的变了**（追加一个可观测的新回合）⇒ 整 home 必须重新规划。
    const fileA = c3PathOf(fixture, "A");
    writeFileSync(
      fileA,
      `${readFileSync(fileA, "utf8")}${c3Lines("Thread-A", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );
    const changed = await store.sync({ options: fixture.reportOptions });
    assert.equal(changed.perfState, "ready");

    assert.equal(c3Samples(store, "Thread-A").length, 2, "A 真的变了 ⇒ 必须被重新读取并多出一条 Turn-2 候选");
    assert.equal(c3Samples(store, "Thread-B").length, 1, "B 未变 ⇒ 候选数不变");
    const stats = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(cold, stats),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "B/C 从持久行水合；A 定向失效并由受影响线程重新落盘",
    );
    assert.equal(stats.entries, 0, "lazy planner 不把当前 home 的 parsed projection 常驻内存");
    assert.equal(stats.stagedEntries, 0, "逐线程提交后不得残留暂存");

    const snapshotAfter = c3StoredSnapshot(store);
    for (const letter of ["B", "C"]) {
      const stored = c3StoredEntry(store, c3PathOf(fixture, letter));
      assert.ok(stored, `未变文件 ${letter} 的持久行必须保留`);
      assert.deepEqual(
        snapshotAfter[String(stored.path)],
        snapshotBefore[String(stored.path)],
        `${letter} 从持久行水合，不得被重新序列化、改写或刷新 updated_at`,
      );
    }
    const storedA = c3StoredEntry(store, c3PathOf(fixture, "A"));
    assert.ok(storedA, "A 的新投影必须写回");
    assert.notEqual(
      snapshotAfter[String(storedA.path)].fingerprint,
      snapshotBefore[String(storedA.path)].fingerprint,
      "A 的持久 fingerprint 必须随真实内容变化",
    );
    assert.notEqual(
      snapshotAfter[String(storedA.path)].projection,
      snapshotBefore[String(storedA.path)].projection,
      "A 的持久 projection 必须替换为包含 Turn-2 的新值",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("C3 · 失效条件（最强）：同尺寸 + 同 mtime 的原地改写必须重新读取并发布新值（绝不当作未变）", async () => {
  const fixture = makeC3Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c3OutputFor(store, "Thread-A"), 120);
    const before = store.codexProjections.stats();
    const snapshotBefore = c3StoredSnapshot(store);

    const fileA = c3PathOf(fixture, "A");
    const fileBefore = statSync(fileA);
    const original = readFileSync(fileA, "utf8");
    const rewritten = original.replaceAll('"output_tokens":120', '"output_tokens":121');
    assert.notEqual(rewritten, original, "前置：内容确实被改写");
    assert.equal(rewritten.length, original.length, "前置：等长");
    writeFileSync(fileA, rewritten, "utf8");
    utimesSync(fileA, C3_PINNED_SECONDS, C3_PINNED_SECONDS);
    const fileAfter = statSync(fileA);
    assert.equal(fileAfter.size, fileBefore.size, "前置：尺寸完全相同");
    assert.equal(fileAfter.mtimeMs, fileBefore.mtimeMs, "前置：mtime 完全相同 ⇒ 只有内容摘要能发现这次改写");

    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "ready");
    assert.equal(
      c3OutputFor(store, "Thread-A"),
      121,
      "首尾各 64KiB 的既有内容指纹必须发现这次改写 ⇒ 该文件必须重新读取",
    );
    const stats = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(before, stats),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "摘要必须让 A 的旧持久行定向失效；B/C 仍从持久行水合",
    );
    assert.equal(stats.entries, 0, "lazy planner 不常驻整个 home 的 parsed projection");
    const snapshotAfter = c3StoredSnapshot(store);
    const storedA = c3StoredEntry(store, fileA);
    assert.ok(storedA);
    assert.notEqual(
      snapshotAfter[String(storedA.path)].fingerprint,
      snapshotBefore[String(storedA.path)].fingerprint,
      "同尺寸同 mtime 改写必须改变持久 fingerprint",
    );
    assert.notEqual(
      snapshotAfter[String(storedA.path)].projection,
      snapshotBefore[String(storedA.path)].projection,
      "A 的新投影必须写回且只保留当前版本",
    );
    assert.equal(store.codexProjections.persistedRowCount(), 3, "持久行数保持当前文件集大小");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C3 · 边界（如实声明）：首尾 64KiB 探针之外的等长改写对既有变更判据本就不可见", async () => {
  const fixture = makeC3Home({ padBytes: 200_000 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c3OutputFor(store, "Thread-B"), 120);
    const fileB = c3PathOf(fixture, "B");
    const before = statSync(fileB);
    const original = readFileSync(fileB, "utf8");
    const flipped = original.replaceAll('"output_tokens":120', '"output_tokens":121');
    assert.equal(flipped.length, original.length, "前置：等长改写");
    writeFileSync(fileB, flipped, "utf8");
    utimesSync(fileB, C3_PINNED_SECONDS, C3_PINNED_SECONDS);
    const after = statSync(fileB);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    // ① 既有变更判据（size + mtime + 首尾各 64KiB 摘要）对这次改写**完全不可见**：
    //    整轮没有文件被重解析、没有重新规划 —— 这一条在 C2 交付态同样成立（非本卡引入）。
    const blind = await store.sync({ options: fixture.reportOptions });
    assert.equal(blind.updatedFileCount, 0, "探针外的改写不被既有判据看见（C2 也一样）");
    assert.equal(blind.perfState, "ready");
    assert.equal(c3OutputFor(store, "Thread-B"), 120);

    // ② 同轮让 C 发生**探针可见**的变化 ⇒ home 重新规划；此时 B 必须走投影复用而不是全文读取。
    const fileC = c3PathOf(fixture, "C");
    writeFileSync(
      fileC,
      `${readFileSync(fileC, "utf8")}${c3Lines("Thread-C", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );
    const statsBefore = store.codexProjections.stats();
    await store.sync({ options: fixture.reportOptions });
    const statsAfter = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(statsBefore, statsAfter),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "A/B 从持久行水合；只有 C 的可见变化真读并落盘",
    );
    assert.equal(store.codexProjections.stats().entries, 0, "复用轮不得把三份 parsed projection 常驻内存");
    assert.equal(c3OutputFor(store, "Thread-B"), 120, "复用确实发生：B 没有被重读（重读会读到现在文件里的 121）");
    // 同一次 strict reader 直接读文件 ⇒ 磁盘上确实已是 121：差别就是「复用 vs 全文读」。
    const strict = await readCodexRollout(fileB);
    assert.equal(strict.threadId, "Thread-B");
    const strictBuilt = buildCodexThreadPerfSamples("home-c3", "Thread-B", [strict]);
    assert.equal(strictBuilt.samples.length, 1);
    assert.equal(strictBuilt.samples[0].outputTokens, null);
    assert.equal(strict.projection.records.find((record) => record.kind === "token_usage_record").outputTokens, 121);

    // ③ 让 B 的变化变成**探针可见**（mtime 变）⇒ 下一轮必须重新读取并发布新值 ⇒ 有界后果。
    utimesSync(fileB, C3_PINNED_SECONDS + 1, C3_PINNED_SECONDS + 1);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c3OutputFor(store, "Thread-B"), 121, "一旦探针可见，就必须重读并发布新值");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C3 · 失效条件：路径集变化（新增 / 删除）立即重新规划并按当前文件集淘汰投影", async () => {
  const fixture = makeC3Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.codexProjections.stats().entries, 0);
    assert.equal(store.codexProjections.persistedRowCount(), 3);

    // 新增 D（探针天然可见：新路径）⇒ 必须真读 D。
    const beforeAdd = store.codexProjections.stats();
    const fileD = c3Write(path.join(fixture.sessionsDir, "rollout-d.jsonl"), "Thread-D", {});
    const added = await store.sync({ options: fixture.reportOptions });
    assert.equal(added.perfState, "ready");
    assert.equal(c3OutputFor(store, "Thread-D"), 120, "新增文件必须被真正读取");
    let stats = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(beforeAdd, stats),
      {
        hydratedRows: 3,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "A/B/C 从持久行水合；新增 D 作为受影响线程落盘",
    );
    assert.equal(stats.entries, 0, "lazy planner 不常驻 parsed projection");
    assert.equal(store.codexProjections.persistedRowCount(), 4, "新增 ⇒ 当前文件集变成 4 行");
    assert.ok(c3StoredEntry(store, fileD), "新增文件必须拥有持久投影");

    // 删除 D ⇒ home 重新规划（`shouldPlan` 的路径集判据）⇒ 淘汰 D 的投影。
    const beforeDeleteD = store.codexProjections.stats();
    rmSync(fileD, { force: true });
    await store.sync({ options: fixture.reportOptions });
    stats = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(beforeDeleteD, stats),
      {
        hydratedRows: 3,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 0,
        prunedRows: 1,
      },
      "删除 D 只触发定向 prune；其余三行水合且不重写",
    );
    assert.equal(store.codexProjections.persistedRowCount(), 3, "只保留当前文件集");
    assert.equal(c3StoredEntry(store, fileD), undefined, "被删除路径的持久投影不得残留");
    // 再删一份 ⇒ 再淘汰一条（替换 / 删除淘汰是逐条的）。
    const beforeDeleteC = store.codexProjections.stats();
    rmSync(c3PathOf(fixture, "C"), { force: true });
    await store.sync({ options: fixture.reportOptions });
    stats = store.codexProjections.stats();
    assert.deepEqual(c3PersistenceDelta(beforeDeleteC, stats), {
      hydratedRows: 2,
      staleFingerprintRows: 0,
      invalidatedRows: 0,
      corruptRows: 0,
      persistedRows: 0,
      prunedRows: 1,
    });
    assert.equal(store.codexProjections.persistedRowCount(), 2);
    assert.equal(stats.entries, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C3 · 已证明的 append 只隔离变更线程，未受影响的投影仍可提交", async () => {
  const fixture = makeC3Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const golden = store.codexProjections.stats();
    assert.equal(golden.entries, 0);
    assert.equal(golden.persistence.persistedRows, 3);
    const goldenSnapshot = c3StoredSnapshot(store);

    // 先让 A 探针可见地变了（⇒ 本轮必然重新规划）。
    const fileA = c3PathOf(fixture, "A");
    writeFileSync(
      fileA,
      `${readFileSync(fileA, "utf8")}${c3Lines("Thread-A", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );

    // 注入点 = 投影查找本身：它发生在 `before` 指纹之后、`after` 指纹之前 ⇒ 仅 B 发生严格 append。
    const realLookup = store.codexProjections.lookup.bind(store.codexProjections);
    let injected = false;
    store.codexProjections.lookup = (args) => {
      if (!injected) {
        injected = true;
        const fileB = c3PathOf(fixture, "B");
        writeFileSync(fileB, `${readFileSync(fileB, "utf8")}\n`, "utf8");
      }
      return realLookup(args);
    };
    let unstable;
    try {
      unstable = await store.sync({ options: fixture.reportOptions });
    } finally {
      store.codexProjections.lookup = realLookup;
    }
    assert.equal(injected, true, "前置：注入点确实被触发（否则测不到不稳定窗口）");
    assert.equal(unstable.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("LIVE_SOURCE_CHANGED"), true, "被隔离线程必须如实归因");
    const partial = store.codexProjections.stats();
    assert.equal(partial.stagedEntries, 0, "被隔离路径的暂存投影必须被丢弃（不粘到下一轮）");
    assert.equal(partial.entries, 0, "lazy planner 不保留整个 home 的 parsed projection");
    assert.deepEqual(
      c3PersistenceDelta(golden, partial),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 1,
      },
      "只提交 A 的新持久投影；B 的 live-change 旧投影被定向 prune，C 不受影响",
    );
    assert.equal(store.codexProjections.persistedRowCount(), 2, "B 的旧投影必须被淘汰，A/C 保留");
    const partialSnapshot = c3StoredSnapshot(store);
    assert.equal(c3StoredEntry(store, c3PathOf(fixture, "B")), undefined, "live-change 路径不得粘住旧投影");
    const storedC = c3StoredEntry(store, c3PathOf(fixture, "C"));
    assert.ok(storedC);
    assert.deepEqual(
      partialSnapshot[String(storedC.path)],
      goldenSnapshot[String(storedC.path)],
      "C 在隔离轮中必须保持逐字不变",
    );
    const storedA = c3StoredEntry(store, c3PathOf(fixture, "A"));
    assert.ok(storedA);
    assert.notDeepEqual(
      partialSnapshot[String(storedA.path)],
      goldenSnapshot[String(storedA.path)],
      "A 的新持久投影必须先于发布事务提交",
    );
    assert.equal(c3Samples(store, "Thread-B").length, 1, "B 的旧候选在隔离轮保持原发布值");
    assert.equal(c3Samples(store, "Thread-C").length, 1, "C 的候选保持原发布值");

    // 恢复轮：窗口稳定 ⇒ 提交；A 与 B 的新投影必须被读出来并发布。
    const beforeRecovery = partial;
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "ready");
    assert.equal(c3Samples(store, "Thread-A").length, 2, "A 必须被重新读取（不稳定轮的投影没有留下来）");
    const after = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(beforeRecovery, after),
      {
        hydratedRows: 2,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "恢复轮 A/C 水合；B 上轮旧投影已 prune，因此真读后只重写 B；A 可复用已提交的新行再发布",
    );
    assert.equal(c3Samples(store, "Thread-B").length, 1, "B 追加的是空行，重建后公共候选仍只有一条");
    const storedB = c3StoredEntry(store, c3PathOf(fixture, "B"));
    assert.ok(storedB);
    assert.notEqual(
      c3StoredSnapshot(store)[String(storedB.path)].fingerprint,
      goldenSnapshot[String(storedB.path)].fingerprint,
      "B 的持久 fingerprint 必须反映 live append，证明恢复轮真正重读并落盘",
    );
    assert.equal(after.entries, 0);
    assert.equal(store.codexProjections.persistedRowCount(), 3);
    assert.equal(c2WarningCodes(store).includes("LIVE_SOURCE_CHANGED"), false, "告警随恢复消失");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C3 · 发布事务回滚：投影不因回滚失效（文件内容没变），也绝不掩盖回滚的可见状态", async () => {
  const fixture = makeC3Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const version = store.readMeta("perf_index_version");
    const fileA = c3PathOf(fixture, "A");
    writeFileSync(
      fileA,
      `${readFileSync(fileA, "utf8")}${c3Lines("Thread-A", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );
    const baseline = store.codexProjections.stats();

    const realInsert = store.insertPerfSample.bind(store);
    store.insertPerfSample = () => {
      throw Object.assign(new Error("C3 injected publication failure"), { code: "READ_ONLY_OPEN_FAILED" });
    };
    let failed;
    try {
      failed = await store.sync({ options: fixture.reportOptions });
    } finally {
      store.insertPerfSample = realInsert;
    }
    assert.equal(failed.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), true, "发布失败必须如实归因");
    assert.equal(store.readMeta("perf_index_version"), version, "回滚不得伪造成功变更（投影不得掩盖它）");
    assert.equal(c3Samples(store, "Thread-A").length, 1, "回滚后已发布候选保持旧值");
    const afterFailure = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(baseline, afterFailure),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "失败轮里 B/C 从持久行水合；A 真读后先更新缓存行，发布事务仍独立回滚",
    );
    assert.equal(afterFailure.entries, 0, "lazy planner 不常驻整个 home 的 parsed projection");
    assert.equal(store.codexProjections.persistedRowCount(), 3, "投影缓存行不因发布事务回滚而删除");

    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "ready");
    assert.notEqual(store.readMeta("perf_index_version"), version, "恢复轮必须推进版本");
    assert.equal(c3Samples(store, "Thread-A").length, 2, "恢复轮必须发布新候选");
    const stats = store.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(afterFailure, stats),
      {
        hydratedRows: 4,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 0,
        prunedRows: 0,
      },
      "恢复轮 A 经 proof + affected-thread load 两次水合，B/C 各一次；没有任何全量重读或重写",
    );
    assert.equal(c2WarningCodes(store).includes("READ_ONLY_OPEN_FAILED"), false, "瞬态归因随轮消失");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C3 · 生命周期：close() 清空内存、新实例按需水合持久行、schema 与 meta 键保持", async () => {
  const fixture = makeC3Home();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.codexProjections.stats().entries, 0);
    assert.equal(store.codexProjections.persistedRowCount(), 3);
    const metaKeys = store.database
      .prepare("SELECT key FROM store_meta ORDER BY key")
      .all()
      .map((row) => row.key);
    assert.equal(
      metaKeys.some((key) => /projection/i.test(key)),
      false,
      "持久投影只能进入私有表，不得新增任何 meta 键",
    );
    assert.equal(
      store.database.prepare("PRAGMA user_version").get().user_version,
      23,
      "Local quota source evidence moves schema to 23",
    );
    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(
      tables,
      [
        "archive_segments",
        "events",
        "history_replaced_facts",
        "perf_codex_projections",
        "perf_request_timing_dirty_threads",
        "perf_request_timing_evidence",
        "perf_request_timing_meta",
        "perf_request_timing_threads",
        "perf_rollout_threads",
        "perf_sample_sources",
        "perf_samples",
        "quota_usage_sources",
        "rate_limit_observations",
        "source_files",
        "store_meta",
        "usage_rollup_daily",
        "usage_rollup_days",
        "usage_rollup_dirty_days",
        "usage_rollup_format",
        "usage_rollup_sessions",
        "workbuddy_generation_duration_observations",
        "workbuddy_generation_durations",
      ],
      "v20 新增 history_replaced_facts，v21 新增 archive_segments；sync() 安装五张 usage_rollup_* 派生表。此清单保持精确 deepEqual，但这些表都不新增 projection meta 键",
    );
    store.close();
    assert.equal(store.codexProjections.stats().entries, 0, "close() 必须清空实例私有投影（不跨 close/实例存活）");
  } finally {
    fixture.close();
  }

  // 新实例：同一份库 + 同一份来源 ⇒ parsed cache 为空，需要规划时从持久行水合。
  const secondFixture = makeC3Home();
  const first = new UsageStore(secondFixture.serverOptions);
  const second = new UsageStore(secondFixture.serverOptions);
  try {
    await first.sync({ options: secondFixture.reportOptions });
    assert.equal(first.codexProjections.stats().entries, 0);
    assert.equal(first.codexProjections.persistedRowCount(), 3);
    assert.equal(second.codexProjections.stats().entries, 0, "新实例的缓存必须是空的");
    await second.open();
    const beforeSecond = second.codexProjections.stats();
    c3AppendTurn(c3PathOf(secondFixture, "A"), "Thread-A", "Turn-2");
    await second.sync({ options: secondFixture.reportOptions });
    const afterSecond = second.codexProjections.stats();
    assert.deepEqual(
      c3PersistenceDelta(beforeSecond, afterSecond),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "新实例从共享持久表水合 B/C，只为真变的 A 线程重新落盘",
    );
    assert.equal(afterSecond.entries, 0, "水合不能重新制造整 home 的 parsed cache");
    assert.equal(second.codexProjections.persistedRowCount(), 3);
    assert.equal(first.codexProjections.persistedRowCount(), 3, "另一个实例的持久表视图不受影响");
  } finally {
    first.close();
    second.close();
    secondFixture.close();
  }
});

test("C3 · 守卫（单元）：来源 / 窗口 / 路径三条同型守卫与 stage 的准入", () => {
  const cache = createCodexProjectionCache();
  const file = path.join(C3_ROOT, "unit", "guard.jsonl");
  const fingerprints = { [file]: "fp-1" };
  const projection = { records: [{ sourcePath: file }], stats: {}, ordinalSequence: null };
  assert.equal(
    cache.stage({ homeId: "h1", kind: "zcode", filePath: file, fingerprints, projection }),
    false,
    "非 codex 来源不得入缓存",
  );
  assert.equal(cache.stage({ homeId: "h1", kind: "codex", filePath: file, projection }), false, "无窗口指纹 ⇒ 不准入");
  assert.equal(
    cache.stage({ homeId: "h1", kind: "codex", filePath: "", fingerprints, projection }),
    false,
    "空路径 ⇒ 不准入",
  );
  assert.equal(cache.stage({ homeId: "h1", kind: "codex", filePath: file, fingerprints, projection }), true);
  assert.equal(cache.commit("h1"), 1);

  assert.equal(cache.lookup({ homeId: "h1", kind: "zcode", filePath: file, fingerprints }), undefined, "来源守卫");
  assert.equal(cache.lookup({ homeId: "h1", kind: "codex", filePath: file }), undefined, "窗口守卫");
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: path.join(C3_ROOT, "unit", "other.jsonl"), fingerprints }),
    undefined,
    "路径守卫：不在窗口里的文件必须真读",
  );
  assert.equal(cache.lookup({ homeId: "h1", kind: "codex", filePath: file, fingerprints }), projection, "命中");
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "main", filePath: file, fingerprints }),
    projection,
    "kind 同义别名（main/jetbrains/extra）必须 canonical 成 codex",
  );
  // 规范化索引：另一种写法（大小写 / 分隔符）必须命中同一物理文件。
  const alias = process.platform === "win32" ? file.toUpperCase() : file;
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "main", filePath: alias, fingerprints }),
    projection,
    "写法不同仍是同一文件",
  );
  assert.equal(cache.stats().hits, 3);
});

test("C3 · 守卫（单元）：指纹 / 方法版本 / home 身份三类失配各自失效且各自有计数", () => {
  const cache = createCodexProjectionCache();
  const file = path.join(C3_ROOT, "unit", "guards.jsonl");
  const projection = { records: [], stats: {}, ordinalSequence: null };
  const stage = (fingerprint, homeId = "h1", methodVersion = undefined) => {
    assert.equal(
      cache.stage({
        homeId,
        kind: "codex",
        filePath: file,
        fingerprints: { [file]: fingerprint },
        projection,
        methodVersion,
      }),
      true,
    );
    cache.commit(homeId);
  };

  stage("fp-1");
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: file, fingerprints: { [file]: "fp-2" } }),
    undefined,
    "指纹失配必须自证：必须拒绝复用（返回 undefined）",
  );
  assert.equal(cache.stats().staleFingerprint, 1, "指纹失配必须自证");
  assert.equal(cache.stats().entries, 0, "指纹失配必须**立刻删除**旧投影（失效即重算）");

  stage("fp-1");
  assert.equal(
    cache.lookup({
      homeId: "h1",
      kind: "codex",
      filePath: file,
      fingerprints: { [file]: "fp-1" },
      methodVersion: "v-other",
    }),
    undefined,
    "方法版本失配必须自证：旧方法版本的投影必须拒绝复用（返回 undefined）",
  );
  assert.equal(cache.stats().staleMethodVersion, 1, "方法版本失配必须自证");

  stage("fp-1");
  assert.equal(
    cache.lookup({ homeId: "h2", kind: "codex", filePath: file, fingerprints: { [file]: "fp-1" } }),
    undefined,
    "home 身份失配必须自证：跨 home 的同一物理文件必须拒绝复用（返回 undefined）",
  );
  assert.equal(cache.stats().foreignHome, 1, "home 身份失配必须自证");
  assert.equal(cache.stats().entries, 1, "home 失配是「拒绝复用」，不改写另一个 home 的条目");

  stage("fp-1", "h1", "v-fixed");
  assert.equal(
    cache.lookup({
      homeId: "h1",
      kind: "codex",
      filePath: file,
      fingerprints: { [file]: "fp-1" },
      methodVersion: "v-fixed",
    }),
    projection,
    "同一方法版本 + 同一 home + 同一指纹 ⇒ 必须命中",
  );
  assert.equal(
    cache.lookup({
      homeId: "h1",
      kind: "codex",
      filePath: file,
      fingerprints: { [file]: "fp-1" },
      methodVersion: "v-next",
    }),
    undefined,
    "方法版本一变（同一实例内显式传参）⇒ 立即失效",
  );
});

test("C3 · 投影身份对象被替换后必须重建索引（否则旧指纹会让真变的文件被当成未变）", () => {
  const cache = createCodexProjectionCache();
  const file = path.join(C3_ROOT, "unit", "identity.jsonl");
  const projection = { records: [], stats: {}, ordinalSequence: null };
  /**
   * ⚠️ 键刻意写成**规范化别名**（多一个 `.` 段）：`Object.hasOwn(fingerprints, filePath)` 的快路径
   * 因此**不成立**，必须走"路径 → 指纹"索引 —— 这正是本用例要压的那条身份守卫。
   */
  const aliasKey = `${path.dirname(file)}${path.sep}.${path.sep}${path.basename(file)}`;
  assert.notEqual(aliasKey, file);
  assert.equal(path.resolve(aliasKey), path.resolve(file), "前置：别名必须解析到同一物理路径");
  const windowOf = (fingerprint) => ({ [aliasKey]: fingerprint });

  // 第 1 轮：窗口对象 W1 给出 fp-1（走索引快慢路径均须命中）。
  const W1 = windowOf("fp-1");
  assert.equal(Object.hasOwn(W1, file), false, "前置：本轮不走逐字快路径（否则测不到索引守卫）");
  assert.equal(cache.stage({ homeId: "h1", kind: "codex", filePath: file, fingerprints: W1, projection }), true);
  cache.commit("h1");
  assert.equal(cache.lookup({ homeId: "h1", kind: "codex", filePath: file, fingerprints: W1 }), projection);

  // 第 2 轮：**换了一个对象**但内容相同（同一份未变文件）⇒ 索引必须重建，且复用不受影响。
  const W2 = windowOf("fp-1");
  assert.notEqual(W1, W2);
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: file, fingerprints: W2 }),
    projection,
    "换对象但指纹相同 ⇒ 必须仍然命中（重建索引不得误伤复用）",
  );

  // 第 3 轮：**换对象**且指纹真的变了 ⇒ 必须失配（若沿用了 W1 的旧索引，这里会错误命中）。
  const W3 = windowOf("fp-2");
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: file, fingerprints: W3 }),
    undefined,
    "投影身份对象被替换后必须重建索引：新指纹 fp-2 必须让 fp-1 的条目失效",
  );
  assert.equal(cache.stats().staleFingerprint, 1);
  assert.equal(cache.stats().entries, 0);
});

test("C3 · 有界 RAM：maxBytes 超限按 LRU 逐出最旧条目（逐出只影响成本，不影响正确性）", () => {
  const entryBytes = JSON.stringify({ pad: "x".repeat(100) }).length;
  const cache = createCodexProjectionCache({ maxBytes: entryBytes * 2 + 24 });
  const fileOf = (index) => path.join(C3_ROOT, "unit", `bounded-${index}.jsonl`);
  const stageAll = (indexes) => {
    for (const index of indexes) {
      const file = fileOf(index);
      cache.stage({
        homeId: "h1",
        kind: "codex",
        filePath: file,
        fingerprints: { [file]: `fp-${index}` },
        projection: { pad: "x".repeat(100), index },
      });
    }
    cache.commit("h1");
  };

  stageAll([1, 2, 3, 4, 5]);
  const stats = cache.stats();
  assert.equal(stats.entries, 2, `超出预算必须逐出到上限内（entries=${stats.entries}）`);
  assert.equal(stats.evictions, 3, "逐出计数必须自证");
  assert.equal(stats.bytes <= stats.maxBytes, true, "常驻字节数必须被预算约束");
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: fileOf(1), fingerprints: { [fileOf(1)]: "fp-1" } }),
    undefined,
  );
  assert.ok(cache.lookup({ homeId: "h1", kind: "codex", filePath: fileOf(5), fingerprints: { [fileOf(5)]: "fp-5" } }));

  // LRU：命中把条目移到队尾 ⇒ 下一次超限逐出的是更旧的 4，而不是刚用过的 5。
  assert.ok(cache.lookup({ homeId: "h1", kind: "codex", filePath: fileOf(5), fingerprints: { [fileOf(5)]: "fp-5" } }));
  stageAll([6]);
  assert.equal(cache.stats().entries, 2);
  assert.ok(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: fileOf(5), fingerprints: { [fileOf(5)]: "fp-5" } }),
    "最近使用过的 5 必须还在",
  );
  assert.equal(
    cache.lookup({ homeId: "h1", kind: "codex", filePath: fileOf(4), fingerprints: { [fileOf(4)]: "fp-4" } }),
    undefined,
  );

  // 稳态：重复提交同一批路径不得让条目数增长（只保留当前文件版本）。
  for (let round = 0; round < 4; round += 1) stageAll([4, 5]);
  assert.equal(cache.stats().entries, 2, "稳态条目数恒定（与轮数无关）");
});

test("C3 · 单元：retainHomes 淘汰整体消失的 home（含尚未提交的暂存）", () => {
  const cache = createCodexProjectionCache();
  const fileOf = (name) => path.join(C3_ROOT, "unit", `${name}.jsonl`);
  for (const [homeId, name] of [
    ["home-a", "a1"],
    ["home-a", "a2"],
    ["home-b", "b1"],
  ]) {
    const file = fileOf(name);
    cache.stage({
      homeId,
      kind: "codex",
      filePath: file,
      fingerprints: { [file]: `fp-${name}` },
      projection: { name },
    });
    cache.commit(homeId);
  }
  cache.stage({
    homeId: "home-c",
    kind: "codex",
    filePath: fileOf("c1"),
    fingerprints: { [fileOf("c1")]: "fp-c1" },
    projection: { name: "c1" },
  });
  assert.equal(cache.stats().entries, 3);
  assert.equal(cache.stats().stagedEntries, 1);
  assert.equal(cache.retainHomes(["home-a", "home-c"]), 1, "只淘汰 home-b 的那一条");
  const remaining = cache.stats();
  assert.equal(remaining.entries, 2);
  assert.equal(remaining.stagedEntries, 1, "home-c 仍在保留集合里 ⇒ 暂存不动");
  assert.equal(cache.retainHomes(["home-a"]), 0);
  assert.equal(cache.stats().stagedEntries, 0, "home-c 被淘汰 ⇒ 暂存一并丢弃");
  assert.equal(cache.stats().entries, 2);
});

test("C3 · planner 层接缝：lazy transient 下未变文件水合、变更文件真读，归属与 digest 复核不变", async () => {
  const fixture = makeC3Home({ count: 2 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    // 用一次真实 sync 取得**真实探针口径**的逐文件指纹（避免在测试里再镜像一份指纹算法）。
    await store.sync({ options: fixture.reportOptions });
    const cache = store.codexProjections;
    const storedRows = store.database
      .prepare("SELECT path, home_id, fingerprint FROM perf_codex_projections ORDER BY path")
      .all();
    assert.equal(storedRows.length, 2, "前置：冷同步必须留下两份持久投影");
    const files = fixture.paths.slice().sort();
    const fingerprints = Object.fromEntries(
      files.map((file) => {
        const entry = storedRows.find((candidate) =>
          String(candidate.path).endsWith(path.basename(file).toLowerCase()),
        );
        assert.ok(entry, `前置：${path.basename(file)} 必须已有持久行`);
        return [file, String(entry.fingerprint)];
      }),
    );
    const homeId = String(storedRows[0].home_id);
    assert.equal(homeId !== "", true, "前置：持久行必须带真实 home 身份");
    const lookupCalls = [];
    const lazyCache = {
      lazyRollouts: true,
      lookup(args = {}) {
        const projection = cache.lookup({ ...args, transient: true });
        lookupCalls.push({ filePath: path.resolve(String(args.filePath)), hit: projection !== undefined });
        return projection;
      },
      stage(args = {}) {
        return cache.stage({ ...args, transient: true });
      },
      invalidate(args = {}) {
        return cache.invalidate(args);
      },
    };
    const beforeWarm = cache.stats();

    // 指纹逐字相同 ⇒ 两份都复用；归属结果必须与真实读取时一致。
    // ⚠️ homeId 必须用**真实的 home id**（缓存条目按 home 绑定；换 id 会走 foreignHome 守卫）。
    const warm = await planCodexHomeThreads(homeId, files, {
      projectionCache: lazyCache,
      fingerprints,
      kind: "main",
    });
    assert.equal(warm.ok, true);
    assert.deepEqual(
      c3PersistenceDelta(beforeWarm, cache.stats()),
      {
        hydratedRows: 2,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 0,
        prunedRows: 0,
      },
      "指纹逐字相同 ⇒ 两份都从持久行 transient 水合，不产生内存条目或回写",
    );
    assert.equal(lookupCalls.length, 2);
    assert.equal(
      lookupCalls.every((call) => call.hit),
      true,
      "两份 proof lookup 都必须命中持久行",
    );
    assert.equal(cache.stats().entries, 0, "lazy planner 不保留整 home 的 parsed projection");
    assert.equal(cache.stats().stagedEntries, 0, "proof-only 水合不产生暂存");
    assert.deepEqual(
      warm.threads.map((thread) => thread.threadId).sort(),
      ["Thread-A", "Thread-B"],
      "复用不得改变归属结果",
    );
    assert.equal(
      warm.threads.every((thread) => typeof thread.loadRollouts === "function"),
      true,
    );
    assert.equal(Array.isArray(store.perfCandidatesForRange(null)), true, "公共范围查询保持数组契约");

    // 只把一个文件的指纹改掉（等价于"它真的变了"）⇒ 那一份必须真读，另一份仍复用。
    const changedFile = files[0];
    const staleFingerprints = { ...fingerprints, [changedFile]: `${fingerprints[changedFile]}-stale` };
    const beforeMixed = cache.stats();
    const mixed = await planCodexHomeThreads(homeId, files, {
      projectionCache: lazyCache,
      fingerprints: staleFingerprints,
      kind: "main",
    });
    assert.equal(mixed.ok, true);
    assert.deepEqual(
      c3PersistenceDelta(beforeMixed, cache.stats()),
      {
        hydratedRows: 1,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 0,
        prunedRows: 0,
      },
      "未变文件继续水合；变更文件定向删行并真读，proof-only 阶段不落盘",
    );
    assert.equal(cache.stats().entries, 0);
    assert.equal(cache.stats().stagedEntries, 0);
    assert.equal(cache.persistedRowCount(), 1, "变更文件的旧持久行必须被定向删除");

    const changedThread = mixed.threads.find((thread) =>
      thread.rollouts.some((rollout) => path.resolve(rollout.filePath) === path.resolve(changedFile)),
    );
    assert.ok(changedThread, "变更文件必须仍能按完整 home 计划归属到唯一线程");
    assert.equal(changedThread.threadId, "Thread-A");
    const beforeRepair = cache.stats();
    const loaded = await changedThread.loadRollouts();
    assert.equal(loaded.length, 1, "变更线程 lazy load 必须返回完整 rollout 依赖");
    assert.equal(loaded[0].projection && typeof loaded[0].projection === "object", true);
    cache.commit(homeId);
    assert.deepEqual(
      c3PersistenceDelta(beforeRepair, cache.stats()),
      {
        hydratedRows: 0,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
        prunedRows: 0,
      },
      "受影响线程的 lazy 读取经 digest 复核后只回写该文件",
    );
    const repaired = c3StoredEntry(store, changedFile);
    assert.ok(repaired, "懒修复后变更文件必须重新拥有持久投影");
    assert.equal(typeof JSON.parse(String(repaired.projection)), "object");
    assert.equal(cache.persistedRowCount(), 2, "当前文件集恢复为两份持久行");
  } finally {
    store.close();
    fixture.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C4 卡：只构建 / 发布**受影响线程**
//   * 端到端：一文件追加只构建关联线程；无关线程的候选行**一个字节都不动**（rowid 物理身份）。
//   * 多片段（一个线程多份 rollout）/ 删除 / 身份重归属 / 归档迁移 / 跨 home 迁移 逐条语义。
//   * 部分失败：失败线程不得发布其好片段；健康线程必须继续发布。
//   * 边界（如实声明）：探针窗口外的等长改写对既有变更判据本就不可见 —— C4 不再顺带修复。
// ─────────────────────────────────────────────────────────────────────────────
const C4_ROOT = mkdtempSync(path.join(os.tmpdir(), "c4-affected-threads-"));
process.on("exit", () => rmSync(C4_ROOT, { recursive: true, force: true }));

/** C4：一个隔离 codex home（`sessionsDir` 下的 rollout 由调用方写入）。 */
function c4MakeHome(name) {
  const root = path.join(C4_ROOT, name);
  const homeDir = path.join(root, "codex");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const reportOptions = {
    homeDir: root,
    env: {},
    extraHomes: homeDir,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  return {
    root,
    homeDir,
    sessionsDir,
    reportOptions,
    serverOptions: {
      ...reportOptions,
      databaseFile: path.join(root, "index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** C4：本轮"受影响 / 保留"集合（恰好一个被规划的 home；`staged`/`retained` 已排序）。 */
function c4BuildPlan(store) {
  const entries = [...store.codexThreadBuildPlan.entries()];
  assert.equal(entries.length, 1, `前置：恰好一个被规划的 codex home（实测 ${entries.length}）`);
  const [homeId, plan] = entries[0];
  return { homeId, staged: [...plan.staged].sort(), retained: [...plan.retained].sort() };
}

/**
 * C4：`threadId → 物理身份`（**rowid** 口径，逐条列出）。
 *
 * 为什么用 rowid：`perf_samples.sample_key` 是文本主键，行**被 delete+insert 后值完全相同、
 * rowid 必然变大**。因此"未受影响线程的 rowid 逐条不变"就是"没有 delete/insert"的可执行证据
 * （比"候选内容相同"更强：内容相同并不能排除空发布/整表重写）。
 */
function c4Identity(store) {
  const samples = store.database.prepare("SELECT rowid AS rid, sample_key FROM perf_samples").all();
  const rollouts = store.database
    .prepare("SELECT rowid AS rid, source_path, thread_id FROM perf_rollout_threads")
    .all();
  const links = store.database.prepare("SELECT rowid AS rid, sample_key, source_path FROM perf_sample_sources").all();
  const threadIds = [...new Set(rollouts.map((row) => String(row.thread_id)))].sort();
  const out = {};
  for (const threadId of threadIds) {
    const tag = `"${threadId}"`;
    out[threadId] = {
      samples: samples
        .filter((row) => String(row.sample_key).includes(tag))
        .map((row) => `${row.sample_key}=${Number(row.rid)}`)
        .sort(),
      rollouts: rollouts
        .filter((row) => String(row.thread_id) === threadId)
        .map((row) => `${row.source_path}=${Number(row.rid)}`)
        .sort(),
      links: links
        .filter((row) => String(row.sample_key).includes(tag))
        .map((row) => `${row.sample_key}\u0000${row.source_path}=${Number(row.rid)}`)
        .sort(),
    };
  }
  return out;
}

/** C4：已发布候选的**内容哈希**（值口径；rowid 之外的独立证据）。 */
function c4CandidateHash(store) {
  const samples = store.database.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all();
  const links = store.database.prepare("SELECT * FROM perf_sample_sources ORDER BY sample_key, source_path").all();
  return createHash("sha256").update(JSON.stringify({ samples, links })).digest("hex");
}

/** C4：策略里该 home 被阻断的线程 id（未列出 ⇒ 空数组）。 */
function c4BlockedThreads(store, homeId) {
  const policy = decodeCodexPublicationPolicy(store.readMeta("perf_codex_publication_policy"));
  assert.equal(policy.usable, true, "前置：发布策略必须可解码");
  return policy.partialHomes?.find((entry) => entry.homeId === homeId)?.blockedThreadIds ?? [];
}

function c4Fingerprints(store) {
  return JSON.parse(store.readMeta("perf_file_fingerprints"));
}

test("C4 · 端到端：一文件追加只构建关联线程，无关线程的候选行（rowid）原样保留", async () => {
  const fixture = makeC3Home({ count: 3 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    // ── 冷启动：3 个线程**全部**是新的 ⇒ 全部必须构建（不宣称 r1 收益）。 ──
    await store.sync({ options: fixture.reportOptions });
    const cold = c4BuildPlan(store);
    assert.deepEqual(cold.staged, ["Thread-A", "Thread-B", "Thread-C"], "冷启动：没有任何已发布候选 ⇒ 三个线程都要建");
    assert.deepEqual(cold.retained, [], "冷启动不存在可复用的已发布候选");
    const coldIdentity = c4Identity(store);
    const coldHash = c4CandidateHash(store);
    assert.equal(Object.keys(coldIdentity).length, 3);

    // ── 只让 A 追加一个新回合（可观测的内容真变）⇒ 只构建 Thread-A。 ──
    const fileA = c3PathOf(fixture, "A");
    writeFileSync(
      fileA,
      `${readFileSync(fileA, "utf8")}${c3Lines("Thread-A", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );
    const status = await store.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "ready");
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-A"], "内容真变轮只有 A 受影响 ⇒ 只构建 A（B/C 不得重跑 builder）");
    assert.deepEqual(plan.retained, ["Thread-B", "Thread-C"], "B/C 未受影响 ⇒ 复用已发布候选");

    const identity = c4Identity(store);
    assert.equal(c3Samples(store, "Thread-A").length, 2, "A 真的变了 ⇒ 必须被重建并多出一条 Turn-2 候选");
    assert.notDeepEqual(
      identity["Thread-A"],
      coldIdentity["Thread-A"],
      "受影响的 A 必须是 delete+insert（rowid 变化）",
    );
    assert.deepEqual(
      identity["Thread-B"],
      coldIdentity["Thread-B"],
      "B 未受影响 ⇒ 候选行 rowid 必须逐条不变（不 delete/insert）",
    );
    assert.deepEqual(identity["Thread-C"], coldIdentity["Thread-C"], "C 未受影响 ⇒ 候选行 rowid 必须逐条不变");
    assert.notEqual(c4CandidateHash(store), coldHash, "A 的新回合必须真的改变了候选集合");

    // ── 不动的一轮：连规划都不进入 ⇒ 一个字节都不动。 ──
    const stable = await store.sync({ options: fixture.reportOptions });
    assert.equal(stable.updatedFileCount, 0);
    assert.equal(store.codexThreadBuildPlan.size, 0, "无变化轮不进入规划 ⇒ 没有 affected 集合");
    assert.deepEqual(c4Identity(store), identity, "无变化轮必须零改动");
  } finally {
    store.close();
    fixture.close();
  }
});

test("C4 · 多片段：任一 rollout 变化都必须重建整个线程，且其全部 rollout 参与构建", async () => {
  const fixture = c4MakeHome("multi-rollout");
  c3Write(path.join(fixture.sessionsDir, "rollout-a1.jsonl"), "Thread-A", { turn: "Turn-1", output: 100 });
  const fileA2 = c3Write(path.join(fixture.sessionsDir, "rollout-a2.jsonl"), "Thread-A", {
    turn: "Turn-2",
    output: 200,
  });
  c3Write(path.join(fixture.sessionsDir, "rollout-b.jsonl"), "Thread-B", { turn: "Turn-1", output: 300 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const linkCount = (name) =>
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_sample_sources WHERE source_path LIKE ?").get(`%${name}%`)
        .n;
    assert.equal(
      c3Samples(store, "Thread-A").length,
      2,
      "两片 rollout 的 Turn-1/Turn-2 必须在**同一个**线程下折成 2 条候选",
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads WHERE thread_id = 'Thread-A'").get().n,
      2,
      "Thread-A 必须拥有 2 份 rollout（多片段）",
    );
    assert.equal(linkCount("rollout-a1.jsonl"), 2, "每一片都必须是 dependency 行（全片段参与构建）");
    assert.equal(linkCount("rollout-a2.jsonl"), 2);
    const before = c4Identity(store);

    // 只改**第二片** ⇒ 整个线程（两片）必须一起重建。
    writeFileSync(
      fileA2,
      `${readFileSync(fileA2, "utf8")}${c3Lines("Thread-A", { turn: "Turn-3", output: 400 }).slice(1).join("\n")}\n`,
      "utf8",
    );
    await store.sync({ options: fixture.reportOptions });
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-A"], "线程 A 受影响（哪怕只改了一片）");
    assert.deepEqual(plan.retained, ["Thread-B"], "线程 B 未受影响");
    assert.equal(c3Samples(store, "Thread-A").length, 3, "整线程重建后必须有 3 条候选");
    assert.equal(linkCount("rollout-a1.jsonl"), 3, "重建后的每一条候选都必须挂上**全部** rollout（含未改的那片）");
    assert.equal(linkCount("rollout-a2.jsonl"), 3);
    const after = c4Identity(store);
    assert.deepEqual(after["Thread-B"], before["Thread-B"], "兄弟线程 B 必须逐条不变");
    // 未改的第一片也换了 rowid ⇒ 证明"整线程重建"，不是"只重建变化的那片"。
    assert.notDeepEqual(after["Thread-A"].links, before["Thread-A"].links);
  } finally {
    store.close();
    fixture.close();
  }
});

/**
 * C4 · **片段收缩**：多片段线程丢了一个片段、存活片段的指纹**逐字节没变**。
 *
 * 这是判据 ②（路径集：条目数 + 成员）**唯一**被单独隔离出来的输入类：判据 ① 不成立（threadId 还在）、
 * 判据 ③ 也不成立（存活片段的 after 指纹 == 已提交指纹）。所以本用例是"丢判据 ② 就会被抓住"的
 * 判别力来源 —— 变异 `mut-ignore-path-set` 正是被它抓住（见 `C4/mutation-c4.json`）。
 *
 * 语义：片段少了不能把最后一份完整发布替换成缺依赖的新结果；旧样本与 ownership 保留。
 */
test("C4 · 多片段（片段收缩）：保留最后一份完整线程发布，不发布缺依赖替代", async () => {
  const fixture = c4MakeHome("shrunken-rollout");
  const fileA1 = c3Write(path.join(fixture.sessionsDir, "rollout-a1.jsonl"), "Thread-A", {
    turn: "Turn-1",
    output: 100,
  });
  const fileA2 = c3Write(path.join(fixture.sessionsDir, "rollout-a2.jsonl"), "Thread-A", {
    turn: "Turn-2",
    output: 200,
  });
  c3Write(path.join(fixture.sessionsDir, "rollout-b.jsonl"), "Thread-B", { turn: "Turn-1", output: 300 });
  const store = new UsageStore(fixture.serverOptions);
  const rolloutRows = (threadId) =>
    store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads WHERE thread_id = ?").get(threadId).n;
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c3Samples(store, "Thread-A").length, 2, "前置：Thread-A 两片 rollout 折出 2 条候选");
    assert.equal(rolloutRows("Thread-A"), 2, "前置：Thread-A 拥有 2 份 rollout");
    const before = c4Identity(store);
    const fingerprintsBefore = c4Fingerprints(store);
    assert.equal(typeof fingerprintsBefore[fileA1], "string", "前置：存活片段的已提交指纹必须存在");

    // **片段收缩**：删掉第二片，只留第一片。
    rmSync(fileA2, { force: true });
    const shrunk = await store.sync({ options: fixture.reportOptions });

    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-A"], "片段收缩必须让该线程进入受影响集合（不许当成'没变'）");
    assert.deepEqual(plan.retained, ["Thread-B"], "兄弟线程 B 未受影响");

    const fingerprintsAfter = c4Fingerprints(store);
    // 判别力前提：存活片段的指纹**与收缩前完全相同** ⇒ 能抓住错误实现的只可能是判据 ②。
    assert.equal(
      fingerprintsAfter[fileA1],
      fingerprintsBefore[fileA1],
      "存活片段的已提交指纹必须逐字节不变（否则本用例会退化成'指纹变化就能抓住'）",
    );
    assert.equal(c3Samples(store, "Thread-A").length, 2, "最后一次完整线程候选必须保留");
    assert.equal(rolloutRows("Thread-A"), 2, "缺失片段的 ownership 必须保留以解释旧候选");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(fileA2).n,
      1,
      "被删片段的 source_files 行必须保留来源身份",
    );
    assert.equal(Object.hasOwn(fingerprintsAfter, fileA2), true, "最后成功指纹必须保留");
    assert.equal(Object.hasOwn(fingerprintsAfter, fileA1), true, "存活片段的指纹分量必须留下");
    const after = c4Identity(store);
    assert.deepEqual(after["Thread-B"], before["Thread-B"], "兄弟线程 B 必须逐条不变");
    assert.deepEqual(after["Thread-A"], before["Thread-A"], "缺依赖轮不得替换最后完整发布");
    assert.deepEqual(
      shrunk.missingSources.map((source) => source.path),
      [fileA2],
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C4 · 删除：rollout 整体消失 ⇒ 保留所属线程最后完整发布，兄弟线程原样保留", async () => {
  const fixture = makeC3Home({ count: 3 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const before = c4Identity(store);
    const fileB = c3PathOf(fixture, "B");
    rmSync(fileB, { force: true });

    const removed = await store.sync({ options: fixture.reportOptions });
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, [], "删除不产生'受影响线程'（没有线程需要重建）");
    assert.deepEqual(plan.retained, ["Thread-A", "Thread-C"], "A/C 未受影响");
    const after = c4Identity(store);
    assert.deepEqual(after["Thread-B"], before["Thread-B"], "B 的最后完整发布必须保留");
    assert.deepEqual(after["Thread-A"], before["Thread-A"], "A 必须逐条不变");
    assert.deepEqual(after["Thread-C"], before["Thread-C"], "C 必须逐条不变");
    assert.equal(c3Samples(store, "Thread-B").length, 1);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(fileB).n,
      1,
      "来源消失必须保留 source_files 行",
    );
    assert.equal(Object.hasOwn(c4Fingerprints(store), fileB), true, "最后成功指纹必须保留");
    assert.deepEqual(
      removed.missingSources.map((source) => source.path),
      [fileB],
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C4 · 身份重归属：同一物理文件改挂到另一个 threadId ⇒ 新线程必建、旧线程被清除", async () => {
  const fixture = makeC3Home({ count: 3 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const before = c4Identity(store);
    const fileA = c3PathOf(fixture, "A");
    // 同一**路径**、同一**回合**，只换线程身份（session_meta.id / session_id）⇒ 归属整体改写。
    c3Write(fileA, "Thread-A2", { turn: "Turn-1", output: 120 });

    await store.sync({ options: fixture.reportOptions });
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-A2"], "新身份未发布过 ⇒ 必须构建");
    assert.deepEqual(plan.retained, ["Thread-B", "Thread-C"], "B/C 未受影响");
    assert.equal(c3Samples(store, "Thread-A").length, 0, "旧身份的候选必须被清除（不得与旧投影并存）");
    assert.equal(c3Samples(store, "Thread-A2").length, 1, "新身份必须被发布");
    const after = c4Identity(store);
    assert.equal(after["Thread-A"], undefined);
    assert.deepEqual(after["Thread-B"], before["Thread-B"], "B 必须逐条不变");
    assert.deepEqual(after["Thread-C"], before["Thread-C"], "C 必须逐条不变");
    assert.equal(
      store.database.prepare("SELECT thread_id FROM perf_rollout_threads WHERE source_path = ?").get(fileA).thread_id,
      "Thread-A2",
      "同一路径的归属必须被改写成新身份",
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C4 · 归档迁移（同一 home 内重命名）：路径集变化 ⇒ 只重建该线程，兄弟保持", async () => {
  const fixture = makeC3Home({ count: 3 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const before = c4Identity(store);
    const fileA = c3PathOf(fixture, "A");
    const archivedDir = path.join(fixture.homeDir, "archived_sessions", "2026", "10");
    mkdirSync(archivedDir, { recursive: true });
    const archivedPath = path.join(archivedDir, path.basename(fileA));
    moveFixtureFile(fileA, archivedPath);

    await store.sync({ options: fixture.reportOptions });
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-A"], "同一线程的 rollout 换路径（归档片段）⇒ 依赖集合变了 ⇒ 必建");
    assert.deepEqual(plan.retained, ["Thread-B", "Thread-C"], "B/C 未受影响");
    assert.equal(c3Samples(store, "Thread-A").length, 1, "归档只改路径 ⇒ 候选数不变");
    assert.equal(
      store.database.prepare("SELECT source_path FROM perf_rollout_threads WHERE thread_id = 'Thread-A'").get()
        .source_path,
      archivedPath,
      "归属必须指向归档后的**新**路径",
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(fileA).n,
      0,
      "旧路径必须作为真实删除被清掉",
    );
    const after = c4Identity(store);
    assert.deepEqual(after["Thread-B"], before["Thread-B"], "B 必须逐条不变");
    assert.deepEqual(after["Thread-C"], before["Thread-C"], "C 必须逐条不变");
    assert.equal(Object.hasOwn(c4Fingerprints(store), fileA), false);
    assert.equal(Object.hasOwn(c4Fingerprints(store), archivedPath), true);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C4 · 跨 home 迁移：同一路径换 home id ⇒ 两个 home 都受阻、已发布候选一个字节不动", async () => {
  // 与 C2 的跨 home 用例同构：**同一物理目录**先经 `extraHomes` 发现（kind extra），再经
  // JetBrains 根发现（kind jetbrains）—— 路径逐字不变、home id 不同 ⇒ `crossHomeBlockedIds` 命中。
  const root = path.join(C4_ROOT, "cross-home");
  const jbHome = path.join(root, "home", "AppData", "Local", "JetBrains", "Prod", "aia", "codex");
  const sessionsDir = path.join(jbHome, "sessions", "2026", "10");
  c3Write(path.join(sessionsDir, "rollout-a.jsonl"), "Thread-A", { turn: "Turn-1" });
  c3Write(path.join(sessionsDir, "rollout-b.jsonl"), "Thread-B", { turn: "Turn-1" });
  const round1 = {
    homeDir: path.join(root, "other"),
    env: {},
    extraHomes: jbHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const round2 = { ...round1, homeDir: path.join(root, "home"), extraHomes: "" };
  const store = new UsageStore({
    ...round2,
    databaseFile: path.join(root, "index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
  });
  try {
    await store.sync({ options: round1 });
    const before = c4Identity(store);
    const candidateHash = c4CandidateHash(store);
    assert.equal(Object.keys(before).length, 2, "前置：两线程已发布");

    const conflicted = await store.sync({ options: round2 });
    assert.equal(conflicted.perfState, "degraded");
    assert.equal(c2WarningCodes(store).includes("UNKEYABLE_RECORD"), true, "跨 home 迁移仍按 UNKEYABLE_RECORD 归因");
    assert.equal(store.codexThreadBuildPlan.size, 0, "受阻 home 不进入规划 ⇒ 没有 affected 集合");
    assert.deepEqual(c4Identity(store), before, "跨 home 冲突轮不得改动任何已发布候选行");
    assert.equal(c4CandidateHash(store), candidateHash, "候选内容哈希必须逐字不变");
    assert.equal(c2DegradedIds(store).length, 2, "冲突涉及的两个 home 都必须计入 degraded");
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
  }
});

test("C4 · 部分失败：失败线程不得发布其好片段，健康线程必须继续发布；回到已发布态后必须原样保留", async () => {
  const fixture = makeC3Home({ count: 3 });
  const store = new UsageStore(fixture.serverOptions);
  const fileA = c3PathOf(fixture, "A");
  const fileB = c3PathOf(fixture, "B");
  try {
    await store.sync({ options: fixture.reportOptions });
    const homeId = c4BuildPlan(store).homeId;
    const round1 = c4Identity(store);
    const originalB = readFileSync(fileB, "utf8");

    // 同一轮：A 追加新回合（健康、受影响）；B 变成坏 JSON（可隔离失败）。
    writeFileSync(
      fileA,
      `${readFileSync(fileA, "utf8")}${c3Lines("Thread-A", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );
    // 坏 JSON 行但**保留 session_meta 头** ⇒ 可隔离的线程级失败（不是 home 级受阻）。
    c2WriteLines(fileB, c2BadJsonLines("Thread-B"));
    utimesSync(fileB, C3_PINNED_SECONDS, C3_PINNED_SECONDS);
    const partial = await store.sync({ options: fixture.reportOptions });

    assert.equal(partial.perfState, "degraded", "B 的失败必须让 home 降级");
    assert.equal(c2WarningCodes(store).includes("MALFORMED_JSON"), true);
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-A"], "只有 A 是受影响线程 ⇒ 只构建 A");
    assert.deepEqual(plan.retained, ["Thread-C"], "C 未受影响 ⇒ 保留");
    assert.deepEqual(
      c4BlockedThreads(store, homeId),
      ["Thread-B"],
      "失败线程必须在策略里被阻断（它自己的好片段不参与排序）",
    );
    const round2 = c4Identity(store);
    assert.equal(c3Samples(store, "Thread-A").length, 2, "健康线程必须继续发布（A 的新回合落地）");
    assert.deepEqual(
      round2["Thread-B"],
      round1["Thread-B"],
      "失败线程的旧图谱必须原样保留（只是被策略阻断），不得删掉也不得发布其好片段",
    );
    assert.deepEqual(round2["Thread-C"], round1["Thread-C"], "C 必须逐条不变");

    // B 的内容回到**已发布时**的逐字状态（等长 + 同 mtime ⇒ 指纹与已提交指纹逐字相同）⇒
    // 归属/依赖集合/内容三分量全部命中 ⇒ **无需重建**，旧候选原样可用，策略解除阻断。
    c3Write(fileB, "Thread-B", { turn: "Turn-1", output: 120 });
    assert.equal(readFileSync(fileB, "utf8"), originalB, "前置：内容逐字回到已发布态");
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.perfState, "ready", "失败线程恢复 ⇒ home 必须回到 ready");
    const recoveredPlan = c4BuildPlan(store);
    assert.deepEqual(recoveredPlan.staged, [], "内容回到已发布态 ⇒ 没有任何线程需要重建");
    assert.deepEqual(recoveredPlan.retained, ["Thread-A", "Thread-B", "Thread-C"], "三个线程全部原样保留");
    assert.deepEqual(c4Identity(store), round2, "本轮**不开任何替换事务**：候选行 rowid 必须逐条不变");
    assert.deepEqual(c4BlockedThreads(store, homeId), [], "恢复后策略不得再阻断 B");
    assert.equal(c3Samples(store, "Thread-B").length, 1, "B 的原候选仍然在库（从未被删除）");
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("C4 · 边界（如实声明）：探针窗口外的等长改写对既有判据不可见 ⇒ 不再被兄弟变化顺带修复", async () => {
  const fixture = makeC3Home({ count: 3, padBytes: 200_000 });
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(c3OutputFor(store, "Thread-B"), 120);
    const fileB = c3PathOf(fixture, "B");
    const original = readFileSync(fileB, "utf8");
    const flipped = original.replaceAll('"output_tokens":120', '"output_tokens":121');
    assert.equal(flipped.length, original.length, "前置：等长改写");
    writeFileSync(fileB, flipped, "utf8");
    utimesSync(fileB, C3_PINNED_SECONDS, C3_PINNED_SECONDS);
    const before = c4Identity(store);

    // 同轮让 C 发生**探针可见**的变化 ⇒ home 重新规划。B 的改写落在首尾 64KiB 之外 ⇒
    // 指纹与已提交指纹逐字相同 ⇒ 判为未受影响。
    const fileC = c3PathOf(fixture, "C");
    writeFileSync(
      fileC,
      `${readFileSync(fileC, "utf8")}${c3Lines("Thread-C", { turn: "Turn-2" }).slice(1).join("\n")}\n`,
      "utf8",
    );
    await store.sync({ options: fixture.reportOptions });
    const plan = c4BuildPlan(store);
    assert.deepEqual(plan.staged, ["Thread-C"], "只有 C 是探针可见的变化");
    assert.deepEqual(plan.retained, ["Thread-A", "Thread-B"], "B 的探针外改写对既有判据不可见 ⇒ 判为未受影响");
    assert.equal(c3OutputFor(store, "Thread-B"), 120, "B 保留**已发布**候选（120），磁盘上其实是 121");
    assert.deepEqual(c4Identity(store)["Thread-B"], before["Thread-B"], "B 的候选行不得被顺带重建");
    // 独立证据：strict reader 直接读文件 ⇒ 磁盘上确实已是 121。差别就是「复用 vs 顺带重读」。
    const strict = await readCodexRollout(fileB);
    const strictBuilt = buildCodexThreadPerfSamples("home-c4", "Thread-B", [strict]);
    assert.equal(strictBuilt.samples[0].outputTokens, null);
    assert.equal(strict.projection.records.find((record) => record.kind === "token_usage_record").outputTokens, 121);

    // 一旦探针可见（mtime 变）⇒ 下一轮必然重新读取并发布新值 ⇒ 有界后果（≤1 轮，无静默丢失）。
    utimesSync(fileB, C3_PINNED_SECONDS + 1, C3_PINNED_SECONDS + 1);
    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(c4BuildPlan(store).staged, ["Thread-B"], "探针一旦可见 ⇒ 必然重建该线程");
    assert.equal(c3OutputFor(store, "Thread-B"), 121, "探针可见后必须发布新值 121");
  } finally {
    store.close();
    fixture.close();
  }
});
