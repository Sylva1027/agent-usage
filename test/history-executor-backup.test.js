import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { loadHistoryBackupContext, verifyHistoryBackup } from "../src/history-backup.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { serviceTierEvidenceSnapshot } from "../src/service-tier-evidence.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

function isolatedOptions(root, fixture) {
  return {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [fixture.codexHome],
    automaticDiscoveryEnabled: false,
  };
}

async function optionalFile(file) {
  return existsSync(file) ? readFile(file) : null;
}

async function seedRequestTiming(fixture, options) {
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    await fixture.seedRequestTiming(store);
  } finally {
    store.close();
  }
}

function publishedState(executor) {
  const metadata = executor.metadata();
  const { modelUsageAsOf: _modelUsageAsOf, ...stableMetadata } = metadata ?? {};
  return structuredClone({
    status: executor.status,
    metadata: stableMetadata,
    serviceTierEvidence:
      executor.serviceTierEvidence === null ? null : serviceTierEvidenceSnapshot(executor.serviceTierEvidence),
    checkedAt: executor.checkedAt,
  });
}

const tierThreadId = "executor-priority-thread";
const tierLogTime = Date.parse("2026-09-24T10:01:00Z");
const tierEventTime = Date.parse("2026-09-24T10:01:05Z");

function tierOptions(root) {
  const codexHome = path.join(root, ".codex");
  return {
    codexHome,
    options: {
      homeDir: root,
      env: {},
      databaseFile: path.join(root, "tier-usage.sqlite"),
      importStoreFile: path.join(root, "tier-imports.json"),
      importDirs: [codexHome],
      automaticDiscoveryEnabled: false,
    },
  };
}

function writeRollout(codexHome, total, rateLimits) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "09", "24");
  mkdirSync(sessionDir, { recursive: true });
  const usage = {
    total_tokens: total,
    input_tokens: total,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
  };
  const rows = [
    {
      timestamp: "2026-09-24T10:00:00Z",
      type: "session_meta",
      payload: { id: tierThreadId, source: "cli", originator: "codex-tui", cwd: codexHome },
    },
    { timestamp: "2026-09-24T10:00:01Z", type: "turn_context", payload: { model: "gpt-6-sol" } },
    {
      timestamp: "2026-09-24T10:01:05Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: usage, last_token_usage: usage },
        ...(rateLimits ? { rate_limits: rateLimits } : {}),
      },
    },
  ];
  const file = path.join(sessionDir, "rollout-executor-priority.jsonl");
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

function writeTierEvidence(codexHome, { tier = "priority", time = tierLogTime } = {}) {
  const log = new DatabaseSync(path.join(codexHome, "logs_2.sqlite"));
  try {
    log.exec(
      "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)",
    );
    log
      .prepare(
        "INSERT INTO logs (ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, 0, ?, 'codex_core::session::handlers', ?)",
      )
      .run(
        time / 1000,
        tierThreadId,
        `session_loop{thread_id=${tierThreadId}}: Submission sub=Submission { id: "executor-tier", op: TurnInput { request: { input: UserInput { content: [] }, service_tier: Some(Some("${tier}")), collaboration_mode: None } } }`,
      );
  } finally {
    log.close();
  }
}

function packageEventTotals(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare("SELECT total FROM events ORDER BY id")
      .all()
      .map((row) => Number(row.total));
  } finally {
    database.close();
  }
}

function costEvidence(summary) {
  const cost = summary.costEstimate;
  return {
    totalUsd: cost.totalUsd,
    currencies: cost.currencies,
    pricedRecords: cost.pricedRecords,
  };
}

test("executor backupHistory publishes a verified package with an empty tier snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-backup-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  const destination = path.join(root, "package", "history.sqlite");
  const executor = createUsageExecutor(options);
  try {
    await seedRequestTiming(fixture, options);
    await executor.sync({ options: { ...options, force: true } });
    const published = publishedState(executor);
    const sourceFiles = [options.databaseFile, `${options.databaseFile}-wal`];
    const sourceBefore = await Promise.all(sourceFiles.map(optionalFile));

    const manifest = await executor.backupHistory(destination);
    await verifyHistoryBackup(destination);
    const context = await loadHistoryBackupContext(destination);

    assert.ok(Object.keys(manifest.pricing.catalog.models).length > 0);
    assert.deepEqual(context.pricingCatalog, manifest.pricing.catalog);
    assert.notEqual(manifest.serviceTierEvidence, null);
    assert.notEqual(context.serviceTierEvidence, null);
    assert.deepEqual(manifest.serviceTierEvidence.snapshot, { formatVersion: 1, threads: [] });
    assert.equal(context.serviceTierEvidence.resolve("missing-thread", 0), "unknown");
    assert.deepEqual(publishedState(executor), published);
    assert.deepEqual(await Promise.all(sourceFiles.map(optionalFile)), sourceBefore);
    assert.equal(existsSync(`${destination}-wal`), false);
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("backupHistory captures catalog A while global pricing changes to B", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-pricing-freeze-"));
  const { codexHome, options } = tierOptions(root);
  const destination = path.join(root, "package", "history.sqlite");
  const originalCatalog = getPricingCatalog();
  const catalogInput = getPricingCatalog();
  catalogInput.checkedAt = "2026-10-22";
  const baseRates = catalogInput.models["gpt-6-sol"].short;
  catalogInput.models["gpt-6-sol"].short = {
    input: baseRates.input + 1,
    cachedInput: baseRates.cachedInput,
    cacheWrite: baseRates.cacheWrite,
    output: baseRates.output,
  };
  const catalogA = setPricingCatalog(catalogInput);
  const executor = createUsageExecutor(options);
  try {
    writeRollout(codexHome, 100_000);
    await executor.sync({ options: { ...options, force: true } });
    const costA = costEvidence(await executor.summarize({ preset: "all" }));

    const backup = executor.backupHistory(destination);
    const catalogBInput = structuredClone(catalogA);
    catalogBInput.checkedAt = "2026-10-23";
    catalogBInput.models["gpt-6-sol"].short.input = catalogA.models["gpt-6-sol"].short.input + 1;
    setPricingCatalog(catalogBInput);

    const manifest = await backup;
    const script = `
      import { DatabaseSync } from "node:sqlite";
      import { loadHistoryBackupContext } from ${JSON.stringify(new URL("../src/history-backup.js", import.meta.url).href)};
      import { setPricingCatalog } from ${JSON.stringify(new URL("../src/pricing.js", import.meta.url).href)};
      import { sourceGroup } from ${JSON.stringify(new URL("../public/timeline-utils.js", import.meta.url).href)};
      import { UsageStore } from ${JSON.stringify(new URL("../src/usage-store.js", import.meta.url).href)};
      const context = await loadHistoryBackupContext(process.argv[1]);
      setPricingCatalog(context.pricingCatalog);
      const database = new DatabaseSync(context.databaseFile, { readOnly: true });
      database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
      const store = new UsageStore({ databaseFile: context.databaseFile });
      store.database = database;
      store.homes = database
        .prepare("SELECT kind, home_id, home_label, home_path FROM source_files")
        .all()
        .map((row) => ({ kind: row.kind, id: row.home_id, label: row.home_label, path: row.home_path }));
      store.observedDataVersion = store.readDataVersion();
      store.generatedAt = store.readMeta("generated_at");
      const cost = store.summarize({ preset: "all" }).costEstimate;
      process.stdout.write(JSON.stringify({
        totalUsd: cost.totalUsd,
        currencies: cost.currencies,
        pricedRecords: cost.pricedRecords,
      }));
      store.close();
    `;
    const restoredCost = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script, destination], { encoding: "utf8" }),
    );
    const costB = costEvidence(await executor.summarize({ preset: "all" }));
    assert.deepEqual(manifest.pricing.catalog, catalogA);
    assert.deepEqual(restoredCost, costA);
    assert.notEqual(costB.totalUsd, costA.totalUsd);
  } finally {
    setPricingCatalog(originalCatalog);
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("snapshot carries catalog A after the main thread switches to B", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-snapshot-pricing-"));
  const originalCatalog = getPricingCatalog();
  const catalogAInput = structuredClone(originalCatalog);
  catalogAInput.checkedAt = "2026-10-22";
  const ratesA = catalogAInput.models["gpt-6-sol"];
  ratesA.short.input += 1;
  ratesA.fast.short.input += 1;
  const catalogA = setPricingCatalog(catalogAInput);
  const { codexHome, options } = tierOptions(root);
  const databaseFile = path.join(root, "snapshot.sqlite");
  const executor = createUsageExecutor(options);
  try {
    writeRollout(codexHome, 100_000);
    await executor.sync({ options: { ...options, force: true } });

    writeRollout(codexHome, 200_000);
    writeTierEvidence(codexHome);
    const prioritySync = executor.sync({ options: { ...options, force: true } });
    const frozenPromise = executor.snapshot({ databaseFile, asOf: tierEventTime });
    const catalogBInput = structuredClone(catalogA);
    catalogBInput.checkedAt = "2026-10-23";
    const ratesB = catalogBInput.models["gpt-6-sol"];
    ratesB.short.input += 1;
    ratesB.fast.short.input += 1;
    const catalogB = setPricingCatalog(catalogBInput);

    await prioritySync;
    const frozen = await frozenPromise;
    assert.deepEqual(getPricingCatalog(), catalogB);
    assert.deepEqual(
      {
        pricingCatalog: frozen.pricingCatalog,
        events: packageEventTotals(databaseFile),
        tier: frozen.serviceTierEvidence.resolve(tierThreadId, tierEventTime),
      },
      { pricingCatalog: catalogA, events: [200_000], tier: "priority" },
    );
  } finally {
    setPricingCatalog(originalCatalog);
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("executor sync/backup barrier preserves the published round and priority evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-barrier-"));
  const { codexHome, options } = tierOptions(root);
  const executor = createUsageExecutor(options);
  const emptyDestination = path.join(root, "empty-package", "history.sqlite");
  const priorityDestination = path.join(root, "priority-package", "history.sqlite");
  try {
    writeRollout(codexHome, 100_000);
    await executor.sync({ options: { ...options, force: true } });

    // Backup is queued first, so the following sync must wait and the package stays on the old round.
    writeRollout(codexHome, 200_000);
    writeTierEvidence(codexHome);
    const backupBeforeSync = executor.backupHistory(emptyDestination);
    const syncAfterBackup = executor.sync({ options: { ...options, force: true } });
    const emptyManifest = await backupBeforeSync;
    await syncAfterBackup;

    await verifyHistoryBackup(emptyDestination);
    assert.deepEqual(packageEventTotals(emptyDestination), [100_000]);
    assert.deepEqual(emptyManifest.serviceTierEvidence.snapshot, { formatVersion: 1, threads: [] });
    const emptyContext = await loadHistoryBackupContext(emptyDestination);
    assert.equal(emptyContext.serviceTierEvidence.resolve(tierThreadId, tierEventTime), "unknown");
    assert.equal((await executor.summarize({ preset: "all" })).totals.total, 200_000);

    // Sync is queued first, so the following backup must see both its facts and its priority evidence.
    writeRollout(codexHome, 300_000);
    const expectedPricing = getPricingCatalog();
    const syncBeforeBackup = executor.sync({ options: { ...options, force: true } });
    const backupAfterSync = executor.backupHistory(priorityDestination);
    await syncBeforeBackup;
    const priorityManifest = await backupAfterSync;

    await verifyHistoryBackup(priorityDestination);
    assert.deepEqual(packageEventTotals(priorityDestination), [300_000]);
    assert.deepEqual(priorityManifest.serviceTierEvidence.snapshot.threads, [
      { threadId: tierThreadId, turns: [{ time: tierLogTime, tier: "priority" }] },
    ]);
    const priorityContext = await loadHistoryBackupContext(priorityDestination);
    assert.deepEqual(priorityManifest.pricing.catalog, expectedPricing);
    assert.deepEqual(priorityContext.pricingCatalog, priorityManifest.pricing.catalog);
    assert.equal(priorityContext.serviceTierEvidence.resolve(tierThreadId, tierEventTime), "priority");
    assert.equal(existsSync(`${priorityDestination}-wal`), false);

    const frozenTier = await executor.snapshot({
      databaseFile: path.join(root, "tier-snapshot.sqlite"),
      asOf: tierEventTime,
    });
    assert.equal(executor.serviceTierEvidence.resolve(tierThreadId, tierEventTime), "priority");
    assert.equal(frozenTier.serviceTierEvidence.resolve(tierThreadId, tierEventTime), "priority");
    const laterTierTime = tierLogTime + 1_000;
    writeTierEvidence(codexHome, { tier: "default", time: laterTierTime });
    await executor.sync({ options: { ...options, force: true } });
    assert.deepEqual(
      {
        current: executor.serviceTierEvidence.resolve(tierThreadId, laterTierTime),
        frozen: frozenTier.serviceTierEvidence.resolve(tierThreadId, laterTierTime),
      },
      { current: "default", frozen: "priority" },
    );
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("snapshot joins the sync barrier and freezes one published round", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-snapshot-barrier-"));
  const { codexHome, options } = tierOptions(root);
  const executor = createUsageExecutor(options);
  const afterSyncSnapshot = path.join(root, "after-sync.sqlite");
  const beforeSyncSnapshot = path.join(root, "before-sync.sqlite");
  try {
    writeRollout(codexHome, 100_000);
    await executor.sync({ options: { ...options, force: true } });

    writeRollout(codexHome, 200_000);
    writeTierEvidence(codexHome);
    const prioritySync = executor.sync({ options: { ...options, force: true } });
    const frozenAfterSync = executor.snapshot({ databaseFile: afterSyncSnapshot, asOf: tierEventTime });
    const priorityStatus = await prioritySync;
    const frozenRound = await frozenAfterSync;
    assert.deepEqual(
      {
        events: packageEventTotals(afterSyncSnapshot),
        tier: frozenRound.serviceTierEvidence.resolve(tierThreadId, tierEventTime),
      },
      { events: [200_000], tier: "priority" },
    );
    assert.equal(frozenRound.status.fingerprint, priorityStatus.fingerprint);

    const laterTierTime = tierLogTime + 1_000;
    writeRollout(codexHome, 300_000);
    writeTierEvidence(codexHome, { tier: "default", time: laterTierTime });
    const frozenBeforeSync = executor.snapshot({ databaseFile: beforeSyncSnapshot, asOf: tierEventTime });
    const syncAfterSnapshot = executor.sync({ options: { ...options, force: true } });
    const previousRound = await frozenBeforeSync;
    await syncAfterSnapshot;
    assert.deepEqual(
      {
        events: packageEventTotals(beforeSyncSnapshot),
        status: previousRound.status.fingerprint === priorityStatus.fingerprint,
        current: executor.serviceTierEvidence.resolve(tierThreadId, laterTierTime),
        frozen: previousRound.serviceTierEvidence.resolve(tierThreadId, laterTierTime),
      },
      { events: [200_000], status: true, current: "default", frozen: "priority" },
    );
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("executor publishes retained project-log events across source removal and restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-published-events-"));
  const importDir = path.join(root, "import-a");
  const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
  const options = {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [importDir],
    automaticDiscoveryEnabled: false,
  };
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
      usage: { total: 123, input: 100, cached: 20, output: 3, reasoning: 0 },
    })}\n`,
  );
  const executor = createUsageExecutor(options);
  try {
    await executor.sync({ options: { ...options, force: true } });
    const removed = await executor.sync({ options: { ...options, importDirs: [], force: true } });
    assert.deepEqual(
      removed.missingSources.map((source) => [source.path, source.kind]),
      [[usageFile, "project-log"]],
    );
    assert.deepEqual(
      (await executor.publishedUsageEvents()).map(({ timestamp, sessionId, total }) => ({
        timestamp,
        sessionId,
        total,
      })),
      [
        {
          timestamp: "2026-07-12T02:00:00.000Z",
          sessionId: "import-session",
          total: { total: 123, input: 100, cached: 20, output: 3, reasoning: 0 },
        },
      ],
    );

    const restored = await executor.sync({ options: { ...options, force: true } });
    assert.deepEqual(restored.missingSources, []);
    assert.deepEqual(
      (await executor.publishedUsageEvents()).map((event) => event.total.total),
      [123],
    );
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("executor publishes one carrier across two missing homes without duplication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-published-report-"));
  const projectDir = path.join(root, "project");
  const usageFile = path.join(projectDir, ".codex-usage", "usage.jsonl");
  const codexHome = path.join(root, "extra-codex");
  const rolloutFile = path.join(codexHome, "sessions", "2026", "07", "rollout-carrier.jsonl");
  const options = {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [projectDir],
    extraHomes: codexHome,
    automaticDiscoveryEnabled: false,
  };
  mkdirSync(path.dirname(usageFile), { recursive: true });
  mkdirSync(path.dirname(rolloutFile), { recursive: true });
  writeFileSync(
    usageFile,
    `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-07-12T02:00:00.000Z",
      source: "test",
      channel: "Test",
      project_root: "/work/project",
      cwd: "/work/project",
      session_id: "project-session",
      model: "gpt-6-luna",
      usage: { total: 123, input: 100, cached: 20, output: 3, reasoning: 0 },
    })}\n`,
  );
  writeFileSync(
    rolloutFile,
    `${[
      { type: "session_meta", payload: { id: "codex-session", source: "cli", cwd: "/work/codex" } },
      { type: "turn_context", payload: { model: "codex-model" } },
      {
        timestamp: "2026-07-12T02:01:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 1_000,
              input_tokens: 800,
              cached_input_tokens: 100,
              output_tokens: 100,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  const executor = createUsageExecutor(options);
  const carrier = (report) => ({
    events: report.events.map(({ timestamp, sessionId, homeId, sourceKind, total }) => ({
      timestamp,
      sessionId,
      homeId,
      sourceKind,
      total: total.total,
    })),
    homes: report.homes.map(({ id, label, path: homePath, kind }) => ({ id, label, path: homePath, kind })),
    sessionCount: report.sessions.length,
  });
  try {
    await executor.sync({ options: { ...options, force: true } });
    const initial = await executor.publishedUsageReport();
    const homeIdByKind = Object.fromEntries(initial.homes.map((home) => [home.kind, home.id]));
    assert.deepEqual(
      {
        events: initial.events.map(({ sessionId, homeId, sourceKind, total }) => ({
          sessionId,
          sourceKind,
          homeMatches: homeId === homeIdByKind[sourceKind],
          total: total.total,
        })),
        homeKinds: initial.homes.map((home) => home.kind).sort(),
        sessionCount: initial.sessions.length,
      },
      {
        events: [
          { sessionId: "project-session", sourceKind: "project-log", homeMatches: true, total: 123 },
          { sessionId: "codex-session", sourceKind: "extra", homeMatches: true, total: 1_000 },
        ],
        homeKinds: ["extra", "project-log"],
        sessionCount: 2,
      },
    );
    const expected = carrier(initial);

    await executor.sync({ options: { ...options, importDirs: [], extraHomes: "", force: true } });
    assert.deepEqual(carrier(await executor.publishedUsageReport()), expected);

    await executor.sync({ options: { ...options, force: true } });
    assert.deepEqual(carrier(await executor.publishedUsageReport()), expected);
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("executor quota carrier survives source removal and restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-quota-carrier-"));
  const { codexHome, options } = tierOptions(root);
  const rateLimits = {
    limit_id: "codex",
    limit_name: "Codex",
    plan_type: "plus",
    primary: { window_minutes: 300, resets_at: Date.parse("2026-09-24T15:01:05Z") / 1000, used_percent: 42.5 },
    secondary: {
      window_minutes: 10_080,
      resets_at: Date.parse("2026-10-01T10:01:05Z") / 1000,
      used_percent: null,
    },
  };
  const rolloutFile = writeRollout(codexHome, 100_000, rateLimits);
  const expected = [
    {
      sourcePath: rolloutFile,
      lineNumber: 3,
      role: "primary",
      observedAtMs: tierEventTime,
      limitId: "codex",
      limitName: "Codex",
      planType: "plus",
      windowMinutes: 300,
      resetsAtMs: rateLimits.primary.resets_at * 1000,
      usedPercent: 42.5,
    },
    {
      sourcePath: rolloutFile,
      lineNumber: 3,
      role: "secondary",
      observedAtMs: tierEventTime,
      limitId: "codex",
      limitName: "Codex",
      planType: "plus",
      windowMinutes: 10_080,
      resetsAtMs: rateLimits.secondary.resets_at * 1000,
      usedPercent: null,
    },
  ];
  const executor = createUsageExecutor(options);
  try {
    await executor.sync({ options: { ...options, force: true } });
    assert.deepEqual((await executor.publishedUsageReport()).rateLimitObservations, expected);

    await rm(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await executor.sync({ options: { ...options, force: true } });
    assert.deepEqual((await executor.publishedUsageReport()).rateLimitObservations, expected);

    writeRollout(codexHome, 100_000, rateLimits);
    await executor.sync({ options: { ...options, force: true } });
    assert.deepEqual((await executor.publishedUsageReport()).rateLimitObservations, expected);
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("close drains a queued snapshot before releasing the store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-close-drain-"));
  const { codexHome, options } = tierOptions(root);
  const databaseFile = path.join(root, "snapshot.sqlite");
  const executor = createUsageExecutor(options);
  let closePromise;
  try {
    writeRollout(codexHome, 100_000);
    await executor.sync({ options: { ...options, force: true } });

    const snapshotPromise = executor.snapshot({ databaseFile, asOf: tierEventTime });
    closePromise = executor.close();
    assert.strictEqual(executor.close(), closePromise);
    await snapshotPromise;
    await closePromise;

    assert.deepEqual(packageEventTotals(databaseFile), [100_000]);
    assert.equal(executor.alive, false);
  } finally {
    await closePromise;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("backup failure does not poison the queued sync or the next backup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-executor-barrier-error-"));
  const { codexHome, options } = tierOptions(root);
  const collision = path.join(root, "collision", "history.sqlite");
  const recovered = path.join(root, "recovered", "history.sqlite");
  const foreign = Buffer.from("foreign file must survive\n");
  const executor = createUsageExecutor(options, { requestTimeoutMs: 5_000 });
  try {
    writeRollout(codexHome, 100_000);
    await executor.sync({ options: { ...options, force: true } });
    mkdirSync(path.dirname(collision), { recursive: true });
    writeFileSync(collision, foreign);

    writeRollout(codexHome, 200_000);
    const failedBackup = executor.backupHistory(collision);
    const queuedSync = executor.sync({ options: { ...options, force: true } });
    await assert.rejects(failedBackup, { code: "HISTORY_BACKUP_DESTINATION_EXISTS" });
    await queuedSync;

    assert.deepEqual(await readFile(collision), foreign);
    await executor.backupHistory(recovered);
    await verifyHistoryBackup(recovered);
    assert.deepEqual(packageEventTotals(recovered), [200_000]);
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
