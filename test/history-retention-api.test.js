import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { renderPerfCoverageHtml } from "../public/perf-ui.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

function installExecutorPreload(root, fileName, source) {
  const preloadFile = path.join(root, fileName);
  writeFileSync(preloadFile, source);
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --import=${pathToFileURL(preloadFile).href}`.trim();
  return () => {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getSummary(baseUrl, excludeHome = "") {
  const response = await fetch(
    `${baseUrl}/api/summary?preset=all${excludeHome ? `&exclude=${encodeURIComponent(excludeHome)}` : ""}`,
  );
  assert.equal(response.status, 200);
  return response.json();
}

async function getFullSummary(baseUrl, excludeHome = "") {
  const response = await fetch(
    `${baseUrl}/api/usage?preset=all&detail=full${excludeHome ? `&exclude=${encodeURIComponent(excludeHome)}` : ""}`,
  );
  if (response.status !== 200) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

function retainedStats(perf) {
  return { groups: perf.groups, models: perf.models, coverage: perf.coverage };
}

function projectEvents(events) {
  return events
    .filter((event) => event.channel === "Test")
    .map(({ sessionId, timestamp, total }) => ({ sessionId, timestamp, total }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function projectSessions(sessions, sessionIds) {
  return sessions
    .filter((session) => sessionIds.has(session.id))
    .map(({ id, homeId, eventCount }) => ({ id, homeId, eventCount }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function projectHomes(homes) {
  return homes
    .filter((home) => home.kind === "project-log")
    .map(({ id, kind, path: homePath }) => ({ id, kind, path: homePath }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

const tierThreadId = "history-api-tier-thread";
const tierTime = Date.parse("2026-09-24T10:01:00Z");
const tierEventTime = Date.parse("2026-09-24T10:01:05Z");

function writeTierRollout(codexHome, { model = "gpt-6-sol", eventTime = tierEventTime } = {}) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "09", "24");
  mkdirSync(sessionDir, { recursive: true });
  const usage = {
    total_tokens: 100_000,
    input_tokens: 100_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
  };
  const rows = [
    {
      timestamp: new Date(eventTime - 65_000).toISOString(),
      type: "session_meta",
      payload: { id: tierThreadId, source: "cli", originator: "codex-tui", cwd: codexHome },
    },
    { timestamp: new Date(eventTime - 64_000).toISOString(), type: "turn_context", payload: { model } },
    {
      timestamp: new Date(eventTime).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    },
  ];
  writeFileSync(path.join(sessionDir, "rollout-tier.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function writeTierEvidence(codexHome, { id, tier = "priority" }) {
  const serviceTier = tier === null ? "Some(None)" : `Some(Some("${tier}"))`;
  const log = new DatabaseSync(path.join(codexHome, "logs_2.sqlite"));
  try {
    log.exec(
      "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)",
    );
    log
      .prepare(
        "INSERT INTO logs (id, ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, ?, 0, ?, 'codex_core::session::handlers', ?)",
      )
      .run(
        id,
        tierTime / 1000,
        tierThreadId,
        `session_loop{thread_id=${tierThreadId}}: Submission sub=Submission { id: "history-api-tier", op: TurnInput { request: { input: UserInput { content: [] }, service_tier: ${serviceTier}, collaboration_mode: None } } }`,
      );
  } finally {
    log.close();
  }
}

function snapshotCost(summary) {
  const cost = summary.costEstimate;
  return {
    totalUsd: cost.totalUsd,
    serviceTierUnknownRecords: cost.serviceTierUnknownRecords,
    serviceTierUnknownTokens: cost.serviceTierUnknownTokens,
    pricedRecords: cost.pricedRecords,
  };
}

test("full and summary independently preserve missing sources while historical stats stay unchanged", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  let server;
  try {
    const store = new UsageStore(fixture.serverOptions);
    try {
      await store.sync({ options: fixture.reportOptions });
      await fixture.seedRequestTiming(store);
    } finally {
      store.close();
    }

    server = createUsageServer({
      ...fixture.serverOptions,
      pricingRefreshSchedulerEnabled: false,
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);

    const initial = (await getSummary(baseUrl)).summary.perf;
    assert.deepEqual(initial.missingSources, []);

    const missingPath = fixture.rolloutFiles[1];
    const missingInfo = statSync(missingPath);
    const missingContents = readFileSync(missingPath);
    unlinkSync(missingPath);

    const fullMissing = (await getFullSummary(baseUrl)).summary.perf;
    const missing = (await getSummary(baseUrl)).summary.perf;
    assert.deepEqual(
      missing.missingSources.map(({ path, kind }) => ({ path, kind })),
      [{ path: missingPath, kind: "extra" }],
    );
    assert.deepEqual(
      fullMissing.missingSources.map(({ path, kind }) => ({ path, kind })),
      [{ path: missingPath, kind: "extra" }],
    );
    assert.deepEqual(retainedStats(fullMissing), retainedStats(initial));
    assert.deepEqual(retainedStats(missing), retainedStats(initial));
    assert.match(renderPerfCoverageHtml(missing), /部分来源已缺失，已保留历史数据。/);
    assert.match(
      renderPerfCoverageHtml(missing, { locale: "en-US" }),
      /Some sources are missing\. Historical data is preserved\./,
    );

    writeFileSync(missingPath, missingContents);
    utimesSync(missingPath, missingInfo.atime, missingInfo.mtime);
    const fullRestored = (await getFullSummary(baseUrl)).summary.perf;
    const restored = (await getSummary(baseUrl)).summary.perf;
    assert.deepEqual(restored.missingSources, []);
    assert.deepEqual(fullRestored.missingSources, []);
    assert.deepEqual(retainedStats(fullRestored), retainedStats(initial));
    assert.deepEqual(retainedStats(restored), retainedStats(initial));
    assert.doesNotMatch(renderPerfCoverageHtml(restored), /保留历史数据/);
    assert.doesNotMatch(renderPerfCoverageHtml(restored, { locale: "en-US" }), /Historical data is preserved/);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("full and summary preserve usage after a project-log source disappears", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const projectRoot = path.join(fixture.serverOptions.homeDir, "usage-project");
  const retainedProjectRoot = path.join(fixture.serverOptions.homeDir, "retained-usage-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const retainedUsageFile = path.join(retainedProjectRoot, ".codex-usage", "usage.jsonl");
  const usageRow = {
    schema_version: "codex-usage.project-log.v1",
    timestamp: "2026-07-12T02:00:00.000Z",
    source: "test",
    channel: "Test",
    project_root: projectRoot,
    cwd: projectRoot,
    session_id: "history-api-usage-session",
    model: "gpt-6-luna",
    usage: { total: 123, input: 100, cached: 20, output: 23, reasoning: 5 },
  };
  const retainedUsageRow = {
    schema_version: "codex-usage.project-log.v1",
    timestamp: "2026-07-12T02:01:00.000Z",
    source: "test",
    channel: "Test",
    project_root: retainedProjectRoot,
    cwd: retainedProjectRoot,
    session_id: "history-api-retained-session",
    model: "gpt-6-sol",
    usage: { total: 77, input: 60, cached: 5, output: 17, reasoning: 3 },
  };
  const options = { ...fixture.serverOptions, importDirs: [projectRoot, retainedProjectRoot] };
  let server;
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${JSON.stringify(usageRow)}\n`);
    mkdirSync(path.dirname(retainedUsageFile), { recursive: true });
    writeFileSync(retainedUsageFile, `${JSON.stringify(retainedUsageRow)}\n`);
    const store = new UsageStore(options);
    try {
      await store.sync({ options });
    } finally {
      store.close();
    }

    server = createUsageServer({
      ...options,
      pricingRefreshSchedulerEnabled: false,
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);
    const initial = await getFullSummary(baseUrl);
    assert.equal(initial.summary.totals.total, 200);
    const originalEvents = projectEvents(initial.report.events);
    assert.equal(originalEvents.length, 2);
    const projectSessionIds = new Set(originalEvents.map((event) => event.sessionId));
    const originalSessions = projectSessions(initial.report.sessions, projectSessionIds);
    assert.equal(originalSessions.length, 2);
    const originalProjectHomes = projectHomes(initial.report.homes);
    assert.equal(originalProjectHomes.length, 2);
    const projectHome = initial.metadata.homes.find(
      (home) => home.kind === "project-log" && path.resolve(home.path) === path.resolve(projectRoot),
    );
    const retainedProjectHome = initial.metadata.homes.find(
      (home) => home.kind === "project-log" && path.resolve(home.path) === path.resolve(retainedProjectRoot),
    );
    assert.ok(projectHome);
    assert.ok(retainedProjectHome);

    const missingInfo = statSync(usageFile);
    const missingContents = readFileSync(usageFile);
    unlinkSync(usageFile);

    const fullMissing = await getFullSummary(baseUrl);
    const missing = await getSummary(baseUrl);
    assert.deepEqual(
      {
        totals: fullMissing.summary.totals,
        events: projectEvents(fullMissing.report.events),
      },
      {
        totals: missing.summary.totals,
        events: originalEvents,
      },
    );
    assert.equal(fullMissing.summary.totals.total, 200);
    assert.deepEqual(projectSessions(fullMissing.report.sessions, projectSessionIds), originalSessions);
    assert.equal(
      fullMissing.metadata.sessionCount,
      new Set(fullMissing.report.sessions.map((session) => session.id)).size,
    );
    assert.deepEqual(projectHomes(fullMissing.report.homes), originalProjectHomes);
    const fullExcluded = await getFullSummary(baseUrl, projectHome.id);
    const excluded = await getSummary(baseUrl, projectHome.id);
    assert.deepEqual(
      {
        totals: fullExcluded.summary.totals,
        events: projectEvents(fullExcluded.report.events),
      },
      {
        totals: excluded.summary.totals,
        events: originalEvents.filter((event) => event.sessionId === retainedUsageRow.session_id),
      },
    );
    assert.equal(fullExcluded.summary.totals.total, 77);

    writeFileSync(usageFile, missingContents);
    utimesSync(usageFile, missingInfo.atime, missingInfo.mtime);
    const fullRestored = await getFullSummary(baseUrl);
    const restored = await getSummary(baseUrl);
    assert.deepEqual(fullRestored.summary.totals, initial.summary.totals);
    assert.deepEqual(restored.summary.totals, initial.summary.totals);
    assert.deepEqual(projectEvents(fullRestored.report.events), originalEvents);
    assert.deepEqual(projectSessions(fullRestored.report.sessions, projectSessionIds), originalSessions);
    assert.equal(
      fullRestored.metadata.sessionCount,
      new Set(fullRestored.report.sessions.map((session) => session.id)).size,
    );
    assert.deepEqual(projectHomes(fullRestored.report.homes), originalProjectHomes);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("full preserves published rate-limit observations after a rollout disappears", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const rolloutPath = fixture.rolloutFiles[1];
  const observedAt = "2026-10-04T12:00:05.000Z";
  const resetsAt = Date.parse("2026-10-04T17:00:05.000Z") / 1000;
  let server;
  try {
    appendFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: observedAt,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
          rate_limits: {
            limit_id: "codex",
            primary: { window_minutes: 300, resets_at: resetsAt, used_percent: 37 },
          },
        },
      })}\n`,
    );
    const store = new UsageStore(fixture.serverOptions);
    try {
      await store.sync({ options: fixture.reportOptions });
    } finally {
      store.close();
    }

    server = createUsageServer({
      ...fixture.serverOptions,
      pricingRefreshSchedulerEnabled: false,
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);
    const initial = await getFullSummary(baseUrl);
    assert.equal(initial.report.rateLimitObservations.length, 1);
    const originalObservations = initial.report.rateLimitObservations;

    const missingInfo = statSync(rolloutPath);
    const missingContents = readFileSync(rolloutPath);
    unlinkSync(rolloutPath);
    const missing = await getFullSummary(baseUrl);
    assert.deepEqual(missing.report.rateLimitObservations, originalObservations);

    writeFileSync(rolloutPath, missingContents);
    utimesSync(rolloutPath, missingInfo.atime, missingInfo.mtime);
    const restored = await getFullSummary(baseUrl);
    assert.deepEqual(restored.report.rateLimitObservations, originalObservations);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("HTTP snapshot keeps priority tier evidence after the live tier log changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-api-tier-freeze-"));
  const codexHome = path.join(root, ".codex");
  const options = {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  let server;
  try {
    writeTierRollout(codexHome);
    writeTierEvidence(codexHome, { id: 1, tier: "priority" });
    server = createUsageServer({ ...options, heapSizeLimitBytes: 4 * 1024 * 1024 * 1024 });
    const baseUrl = await listen(server);

    const freezeResponse = await fetch(`${baseUrl}/api/summary?preset=all&freeze=1`);
    assert.equal(freezeResponse.status, 200);
    const frozen = await freezeResponse.json();
    const frozenCost = snapshotCost(frozen.summary);
    assert.equal(frozenCost.serviceTierUnknownRecords, 0);

    unlinkSync(path.join(codexHome, "logs_2.sqlite"));
    writeTierEvidence(codexHome, { id: 2, tier: null });
    const liveCost = snapshotCost((await getSummary(baseUrl)).summary);
    const snapshotResponse = await fetch(`${baseUrl}/api/summary?preset=all&snapshot=${frozen.snapshotId}`);
    assert.equal(snapshotResponse.status, 200);
    const frozenAfter = await snapshotResponse.json();

    assert.deepEqual(snapshotCost(frozenAfter.summary), frozenCost);
    assert.deepEqual(
      {
        unknownRecords: liveCost.serviceTierUnknownRecords,
        unknownTokens: liveCost.serviceTierUnknownTokens,
        amountChanged: liveCost.totalUsd !== frozenCost.totalUsd,
      },
      { unknownRecords: 1, unknownTokens: 100_000, amountChanged: true },
    );
  } finally {
    if (server) await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("HTTP snapshot keeps catalog A pricing after live pricing changes to B", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-api-price-freeze-"));
  const codexHome = path.join(root, ".codex");
  const options = {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  const originalCatalog = getPricingCatalog();
  const markerFile = path.join(root, "force-snapshot-summarize-failure");
  const usageStoreUrl = new URL("../src/usage-store.js", import.meta.url).href;
  const liveDatabaseFile = path.resolve(options.databaseFile);
  let restoreExecutorPreload;
  let server;
  try {
    restoreExecutorPreload = installExecutorPreload(
      root,
      "snapshot-summarize-failure.mjs",
      `import { existsSync } from "node:fs";
import path from "node:path";
import { UsageStore } from ${JSON.stringify(usageStoreUrl)};

if (process.env.CODEX_USAGE_EXECUTOR_CHILD === "1" && typeof process.send === "function") {
  const markerFile = ${JSON.stringify(markerFile)};
  const liveDatabaseFile = ${JSON.stringify(liveDatabaseFile)};
  const shouldFail = (store) =>
    existsSync(markerFile) &&
    typeof store.databaseFile === "string" &&
    path.resolve(store.databaseFile) !== liveDatabaseFile;
  for (const method of ["summarizeInReadTransaction", "summarizeHistoryReport"]) {
    const original = UsageStore.prototype[method];
    UsageStore.prototype[method] = function (...args) {
      if (shouldFail(this)) throw new Error("forced snapshot summarize failure");
      return Reflect.apply(original, this, args);
    };
  }
}
`,
    );
    writeTierRollout(codexHome);
    writeTierEvidence(codexHome, { id: 1, tier: "priority" });
    server = createUsageServer({ ...options, heapSizeLimitBytes: 4 * 1024 * 1024 * 1024 });
    const baseUrl = await listen(server);
    assert.equal((await fetch(`${baseUrl}/api/pricing`)).status, 200);

    const catalogAInput = structuredClone(originalCatalog);
    catalogAInput.checkedAt = "2026-10-22";
    const ratesA = catalogAInput.models["gpt-6-sol"];
    ratesA.short.input += 1;
    ratesA.long.input += 1;
    ratesA.fast.short.input += 1;
    ratesA.fast.long.input += 1;
    const catalogA = setPricingCatalog(catalogAInput);

    const freezeResponse = await fetch(`${baseUrl}/api/summary?preset=all&freeze=1`);
    assert.equal(freezeResponse.status, 200);
    const frozen = await freezeResponse.json();
    const frozenCost = snapshotCost(frozen.summary);

    const catalogBInput = structuredClone(getPricingCatalog());
    catalogBInput.checkedAt = "2026-10-23";
    const ratesB = catalogBInput.models["gpt-6-sol"];
    ratesB.short.input += 1;
    ratesB.long.input += 1;
    ratesB.fast.short.input += 1;
    ratesB.fast.long.input += 1;
    const catalogB = setPricingCatalog(catalogBInput);

    const liveCost = snapshotCost((await getSummary(baseUrl)).summary);
    const snapshotResponse = await fetch(`${baseUrl}/api/summary?preset=all&snapshot=${frozen.snapshotId}`);
    assert.equal(snapshotResponse.status, 200);
    const frozenAfter = await snapshotResponse.json();
    const pricingResponse = await fetch(`${baseUrl}/api/pricing?snapshot=${frozen.snapshotId}`);
    assert.equal(pricingResponse.status, 200);
    const frozenPricing = await pricingResponse.json();
    const liveAfterCost = snapshotCost((await getSummary(baseUrl)).summary);

    assert.deepEqual(
      {
        liveTotalUsd: liveCost.totalUsd,
        catalog: getPricingCatalog(),
        liveAfter: liveAfterCost,
      },
      {
        liveTotalUsd: frozenCost.totalUsd + 0.1,
        catalog: catalogB,
        liveAfter: liveCost,
      },
    );
    assert.deepEqual(
      {
        cost: snapshotCost(frozenAfter.summary),
        version: frozenPricing.version,
        rates: {
          short: frozenPricing.models["gpt-6-sol"].short.input,
          long: frozenPricing.models["gpt-6-sol"].long.input,
          fastShort: frozenPricing.models["gpt-6-sol"].fast.short.input,
          fastLong: frozenPricing.models["gpt-6-sol"].fast.long.input,
        },
      },
      {
        cost: frozenCost,
        version: catalogA.version,
        rates: {
          short: catalogA.models["gpt-6-sol"].short.input,
          long: catalogA.models["gpt-6-sol"].long.input,
          fastShort: catalogA.models["gpt-6-sol"].fast.short.input,
          fastLong: catalogA.models["gpt-6-sol"].fast.long.input,
        },
      },
      `live response after catalog B: ${JSON.stringify(liveCost)}`,
    );

    let failedStatus;
    let catalogAfterFailure;
    let liveDuringFailure;
    try {
      writeFileSync(markerFile, "fail frozen summaries");
      liveDuringFailure = snapshotCost((await getSummary(baseUrl)).summary);
      failedStatus = (await fetch(`${baseUrl}/api/summary?preset=all&snapshot=${frozen.snapshotId}`)).status;
      catalogAfterFailure = getPricingCatalog();
    } finally {
      await rm(markerFile, { force: true });
    }
    const recoveredResponse = await fetch(`${baseUrl}/api/summary?preset=all&snapshot=${frozen.snapshotId}`);
    const recovered = await recoveredResponse.json();
    assert.deepEqual(
      {
        failedStatus,
        catalogAfterFailure,
        liveDuringFailure,
        recoveredStatus: recoveredResponse.status,
        recovered: snapshotCost(recovered.summary),
      },
      {
        failedStatus: 500,
        catalogAfterFailure: catalogB,
        liveDuringFailure: liveCost,
        recoveredStatus: 200,
        recovered: frozenCost,
      },
    );
  } finally {
    try {
      if (server) await server.close();
    } finally {
      restoreExecutorPreload?.();
      setPricingCatalog(originalCatalog);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("snapshot pricing coverage stays on catalog A after live catalog drops its model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-api-coverage-freeze-"));
  const codexHome = path.join(root, ".codex");
  const coverageModel = "coverage-only-probe";
  const options = {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  const originalCatalog = getPricingCatalog();
  let server;
  try {
    writeTierRollout(codexHome, { model: coverageModel, eventTime: Date.now() - 60_000 });
    server = createUsageServer({ ...options, heapSizeLimitBytes: 4 * 1024 * 1024 * 1024 });
    const baseUrl = await listen(server);
    assert.equal((await fetch(`${baseUrl}/api/pricing`)).status, 200);

    const catalogAInput = structuredClone(originalCatalog);
    catalogAInput.checkedAt = "2026-10-22";
    catalogAInput.models[coverageModel] = structuredClone(catalogAInput.models["gpt-6-sol"]);
    const catalogA = setPricingCatalog(catalogAInput);

    const freezeResponse = await fetch(`${baseUrl}/api/summary?preset=all&freeze=1`);
    assert.equal(freezeResponse.status, 200);
    const frozen = await freezeResponse.json();
    const frozenCost = snapshotCost(frozen.summary);

    const catalogBInput = structuredClone(catalogA);
    catalogBInput.checkedAt = "2026-10-23";
    delete catalogBInput.models[coverageModel];
    const catalogB = setPricingCatalog(catalogBInput);

    const snapshotPricingResponse = await fetch(`${baseUrl}/api/pricing?snapshot=${frozen.snapshotId}`);
    const livePricingResponse = await fetch(`${baseUrl}/api/pricing`);
    const snapshotSummaryResponse = await fetch(`${baseUrl}/api/summary?preset=all&snapshot=${frozen.snapshotId}`);
    assert.deepEqual(
      {
        snapshotStatus: snapshotPricingResponse.status,
        liveStatus: livePricingResponse.status,
        summaryStatus: snapshotSummaryResponse.status,
      },
      { snapshotStatus: 200, liveStatus: 200, summaryStatus: 200 },
    );
    const snapshotPricing = await snapshotPricingResponse.json();
    const livePricing = await livePricingResponse.json();
    const snapshotSummary = await snapshotSummaryResponse.json();
    const coverageEvidence = (pricing) => ({
      matched: pricing.usageCoverage.matchedUsedModelCount,
      missing: pricing.usageCoverage.missingUsedModels.map(({ model }) => model),
    });

    assert.deepEqual(
      {
        snapshotVersion: snapshotPricing.version,
        snapshotCoverage: coverageEvidence(snapshotPricing),
        liveVersion: livePricing.version,
        liveCoverage: coverageEvidence(livePricing),
        snapshotCost: snapshotCost(snapshotSummary.summary),
      },
      {
        snapshotVersion: catalogA.version,
        snapshotCoverage: { matched: 1, missing: [] },
        liveVersion: catalogB.version,
        liveCoverage: { matched: 0, missing: [coverageModel] },
        snapshotCost: frozenCost,
      },
    );
  } finally {
    setPricingCatalog(originalCatalog);
    if (server) await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
