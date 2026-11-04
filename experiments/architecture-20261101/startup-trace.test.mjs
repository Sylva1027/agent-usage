import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const traceModule = path.join(experimentDirectory, "startup-trace.mjs");
const serverModule = path.resolve(experimentDirectory, "..", "..", "src", "server.js");
const usageStoreModule = path.resolve(experimentDirectory, "..", "..", "src", "usage-store.js");
const usageCoreModule = path.resolve(experimentDirectory, "..", "..", "src", "usage-core.js");
const periodComparisonModule = path.resolve(
  experimentDirectory,
  "..",
  "..",
  "public",
  "period-comparison.js",
);
const gateSymbol = Symbol.for("architecture.startup.gate");
const wrapperMarker = Symbol.for("architecture.startup.wrapper.test");

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function sourceDiscoveryEnv(overrides = {}) {
  return {
    ...process.env,
    CODEX_USAGE_ZCODE: "0",
    CODEX_USAGE_DSH: "0",
    CODEX_USAGE_OPENCODE: "0",
    CODEX_USAGE_CLAUDE: "0",
    CODEX_USAGE_WORKBUDDY: "0",
    ...overrides,
  };
}

async function readNdjson(file) {
  const content = await readFile(file, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("startup trace preserves call semantics and instruments the real server gate", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-trace-"));
  const traceDirectory = path.join(root, "trace");
  const fixtureHome = path.join(root, "fixture-home");
  const sessionDirectory = path.join(fixtureHome, ".codex", "sessions", "2026", "11", "02");
  const sessionFile = path.join(sessionDirectory, "rollout-fixture.jsonl");
  const privateDatabase = path.join(root, "private", "usage-index.sqlite");
  const privatePricing = path.join(root, "private", "pricing.json");
  const privateAutomaticPricing = path.join(root, "private", "pricing-auto.json");
  const privateImports = path.join(root, "private", "imports.json");
  const ignoredDatabase = path.join(root, "ignored", "usage-index.sqlite");
  const ignoredPricing = path.join(root, "ignored", "pricing.json");
  const ignoredImports = path.join(root, "ignored", "imports.json");
  const optionsFile = path.join(root, "startup-options.json");
  const wrapperFile = path.join(root, "startup-server-wrapper.mjs");
  const wrapperFileUrl = pathToFileURL(wrapperFile).href;
  let server = null;

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-11-02T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "startup-trace-fixture", source: "cli", originator: "codex-tui", cwd: "/fixture" },
      },
      {
        timestamp: "2026-11-02T01:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 123,
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 23,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ]),
  );
  await writeFile(
    optionsFile,
    JSON.stringify({
      databaseFile: privateDatabase,
      pricingFile: privatePricing,
      automaticPricingFile: privateAutomaticPricing,
      importStoreFile: privateImports,
    }),
  );
  await writeFile(
    wrapperFile,
    `
      const marker = Symbol.for("architecture.startup.wrapper.test");
      export function wrapStartupServer(sourceServer, options) {
        return new Proxy(sourceServer, {
          get(target, property) {
            if (property === marker) return { sourceServer: target, options };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
          set(target, property, value) {
            return Reflect.set(target, property, value, target);
          },
        });
      }
    `,
  );

  process.env.ARCH_STARTUP_TRACE_DIR = traceDirectory;
  process.env.ARCH_STARTUP_OPTIONS_FILE = optionsFile;
  process.env.ARCH_STARTUP_BRIDGE = "1";
  process.env.ARCH_STARTUP_SERVER_WRAPPER = wrapperFileUrl;

  const trace = await import(`${pathToFileURL(traceModule).href}?test=${Date.now()}`);
  const paths = trace.getTracePaths();
  try {
    assert.deepEqual(
      trace.applyStartupOptions({
        homeDir: fixtureHome,
        databaseFile: ignoredDatabase,
        automaticDiscoveryEnabled: true,
        pricingRefreshSchedulerEnabled: false,
      }),
      {
        homeDir: fixtureHome,
        databaseFile: privateDatabase,
        pricingFile: privatePricing,
        automaticPricingFile: privateAutomaticPricing,
        importStoreFile: privateImports,
        automaticDiscoveryEnabled: true,
        pricingRefreshSchedulerEnabled: false,
      },
    );

    const syncResult = trace.wrapFunction((value) => value + 1, "unit.sync");
    assert.equal(syncResult(41), 42);

    const syncError = new Error("sync failure");
    const throwing = trace.wrapFunction(
      () => {
        throw syncError;
      },
      "unit.sync.error",
    );
    assert.throws(() => throwing(), (error) => error === syncError);

    let resolveOriginal;
    const originalPromise = new Promise((resolve) => {
      resolveOriginal = resolve;
    });
    const asyncIdentity = trace.wrapFunction(() => originalPromise, "unit.promise");
    assert.equal(asyncIdentity(), originalPromise);
    resolveOriginal("settled");
    assert.equal(await originalPromise, "settled");

    const asyncError = new Error("async failure");
    let rejectOriginal;
    const rejectedPromise = new Promise((_resolve, reject) => {
      rejectOriginal = reject;
    });
    const asyncReject = trace.wrapFunction(() => rejectedPromise, "unit.promise.error");
    assert.equal(asyncReject(), rejectedPromise);
    rejectOriginal(asyncError);
    await assert.rejects(rejectedPromise, (error) => error === asyncError);

    const generator = trace.wrapFunction(
      async function* fixtureGenerator() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield 2;
      },
      "unit.asyncGenerator",
      { traceIterations: true },
    );
    const iterator = generator();
    assert.equal((await iterator.next()).value, 1);
    trace.flushTrace();
    let spans = await readNdjson(paths.ndjsonFile);
    assert.equal(spans.some((span) => span.label === "unit.asyncGenerator.next"), true);
    assert.equal(spans.some((span) => span.label === "unit.asyncGenerator"), false);
    assert.equal((await iterator.next()).value, 2);
    assert.equal((await iterator.next()).done, true);
    trace.flushTrace();
    spans = await readNdjson(paths.ndjsonFile);
    assert.equal(
      spans.some((span) => span.label === "unit.asyncGenerator" && span.status === "ok"),
      true,
    );

    const generatorError = new Error("generator failure");
    const failingGenerator = trace.wrapFunction(
      async function* failingFixtureGenerator() {
        yield 1;
        throw generatorError;
      },
      "unit.asyncGenerator.error",
      { traceIterations: true },
    );
    const failingIterator = failingGenerator();
    await failingIterator.next();
    await assert.rejects(failingIterator.next(), (error) => error === generatorError);

    const syncGenerator = trace.wrapFunction(
      function* fixtureSyncGenerator() {
        yield 1;
        yield 2;
      },
      "unit.asyncGenerator.sync",
      { traceIterations: true },
    );
    const syncIterator = syncGenerator();
    assert.equal(syncIterator.next().value, 1);
    trace.flushTrace();
    spans = await readNdjson(paths.ndjsonFile);
    assert.equal(spans.some((span) => span.label === "unit.asyncGenerator.sync"), false);
    assert.equal(syncIterator.next().value, 2);
    assert.equal(syncIterator.next().done, true);

    const { summarizePeriodComparison } = await import(pathToFileURL(periodComparisonModule).href);
    summarizePeriodComparison([], { now: new Date("2026-11-02T00:00:00.000Z"), calendarZone: "utc" });

    const usageStoreNamespace = await import(pathToFileURL(usageStoreModule).href);
    const { UsageStore } = usageStoreNamespace;
    assert.equal("publishedUsageEventFromRow" in usageStoreNamespace, false);
    const rawStore = new UsageStore({ databaseFile: path.join(root, "raw", "usage-index.sqlite") });
    await rawStore.open();
    const sessionInfo = await stat(sessionFile);
    await rawStore.replaceFile({
      filePath: sessionFile,
      source: {
        id: "fixture-main",
        label: "Fixture Main",
        path: path.join(fixtureHome, ".codex"),
        kind: "main",
      },
      info: { size: sessionInfo.size, mtimeMs: sessionInfo.mtimeMs },
    });
    rawStore.metadata();

    const { loadQuotaSourceEvidence } = await import(
      pathToFileURL(path.resolve(experimentDirectory, "..", "..", "src", "quota-source-evidence.js")).href
    );
    loadQuotaSourceEvidence([]);
    const { createUsageRollups, rebuildUsageRollups, rebuildUsageRollupsFromEvents } = await import(
      pathToFileURL(path.resolve(experimentDirectory, "..", "..", "src", "usage-rollups.js")).href
    );
    createUsageRollups(rawStore.database);
    rebuildUsageRollups(rawStore.database, { days: ["2026-11-02"], calendarZone: "utc" });
    rebuildUsageRollupsFromEvents(rawStore.database, { days: [], events: [] });
    rawStore.close();

    const { parseSessionFile } = await import(pathToFileURL(usageCoreModule).href);
    const parsed = await parseSessionFile(sessionFile, {
      id: "fixture-main",
      label: "Fixture Main",
      kind: "main",
    });
    assert.equal(parsed.events.length, 1);

    const { createUsageServer } = await import(pathToFileURL(serverModule).href);
    server = createUsageServer({
      homeDir: fixtureHome,
      databaseFile: ignoredDatabase,
      pricingFile: ignoredPricing,
      importStoreFile: ignoredImports,
      env: sourceDiscoveryEnv(),
      automaticDiscoveryEnabled: true,
      pricingRefreshSchedulerEnabled: true,
    });
    const wrapper = server[wrapperMarker];
    assert.equal(Boolean(wrapper), true);
    assert.equal(wrapper.sourceServer[gateSymbol], server[gateSymbol]);
    assert.equal(wrapper.options.databaseFile, privateDatabase);
    assert.equal(wrapper.options.homeDir, fixtureHome);
    const gate = server[gateSymbol];
    assert.equal(Boolean(gate), true);
    assert.equal(typeof gate.loadUsageStore, "function");
    assert.equal(typeof gate.usageStore.open, "function");
    assert.equal(typeof gate.pricingCatalog, "function");
    await gate.pricingReady;
    await gate.loadUsageStore();
    assert.ok((await stat(privateDatabase)).size > 0);
    await assert.rejects(stat(ignoredDatabase), { code: "ENOENT" });
    await server.close();
    server = null;

    const summary = trace.closeTrace();
    spans = await readNdjson(paths.ndjsonFile);
    const summaryJson = JSON.parse(await readFile(paths.summaryFile, "utf8"));
    assert.equal(spans.length > 0, true);
    for (const span of spans) {
      assert.equal(span.pid, process.pid);
      assert.equal(span.parentPid, process.ppid);
      assert.equal(typeof span.id, "string");
      assert.equal(span.parentId === null || typeof span.parentId === "string", true);
      assert.equal(typeof span.label, "string");
      assert.equal(typeof span.start, "number");
      assert.equal(typeof span.duration, "number");
      assert.match(span.status, /^(ok|error|unsettled)$/);
    }
    assert.equal(spans.some((span) => span.label === "server.createUsageServer" && span.status === "ok"), true);
    assert.equal(spans.some((span) => span.label === "server.loadUsageStore" && span.status === "ok"), true);
    const fingerprintSpans = spans.filter((span) => span.label === "usage-store.usageSourceFingerprint");
    assert.equal(fingerprintSpans.length > 0, true);
    assert.equal(fingerprintSpans.every((span) => span.source === sessionFile), true);
    assert.equal(
      fingerprintSpans.some((span) => {
        const parent = spans.find((candidate) => candidate.id === span.parentId);
        return parent?.label === "usage-store.replaceFile";
      }),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "usage-store.loadQuotaSourceEvidence" && span.status === "ok"),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "usage-rollups.createUsageRollups" && span.status === "ok"),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "usage-rollups.rebuildUsageRollups" && span.status === "ok"),
      true,
    );
    assert.equal(
      spans.some(
        (span) => span.label === "usage-rollups.rebuildUsageRollupsFromEvents" && span.status === "ok",
      ),
      true,
    );
    assert.equal(spans.some((span) => span.label === "usage-store.metadata" && span.status === "ok"), true);
    assert.equal(spans.some((span) => span.label === "usage-store.open" && span.status === "ok"), true);
    assert.equal(
      spans.some((span) => span.label === "usage-summary-cache.open" && span.status === "ok"),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "usage-summary-cache.readSourceState" && span.status === "ok"),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "usage-summary-cache.readPublication" && span.status === "ok"),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "usage-summary-cache.stateFor" && span.status === "ok"),
      true,
    );
    assert.equal(spans.some((span) => span.label === "public.summarizePeriodComparison"), true);
    assert.equal(spans.some((span) => span.label === "usage-core.parseSessionFile"), true);
    assert.equal(spans.some((span) => span.label === "codex-rollout.readRolloutLines"), true);
    assert.equal(spans.some((span) => span.label === "codex-rollout.readRolloutLines.next"), false);
    assert.equal(spans.some((span) => span.label === "usage-core.parseRateLimitObservations"), false);
    assert.equal(spans.some((span) => span.label === "unit.sync.error" && span.status === "error"), true);
    assert.equal(spans.some((span) => span.label === "unit.promise.error" && span.status === "error"), true);
    assert.equal(
      spans.some((span) => span.label === "unit.asyncGenerator.error" && span.status === "error"),
      true,
    );
    assert.equal(
      spans.some((span) => span.label === "unit.asyncGenerator.sync" && span.status === "ok"),
      true,
    );
    assert.equal(summaryJson.spanCount, spans.length);
    assert.equal(summary.labels["usage-core.parseSessionFile"].count > 0, true);
    assert.equal(
      summary.labels["usage-core.parseSessionFile"].topSources.some((entry) => entry.source === sessionFile),
      true,
    );

    const bridgeOnlyEnv = sourceDiscoveryEnv();
    delete bridgeOnlyEnv.ARCH_STARTUP_TRACE_DIR;
    delete bridgeOnlyEnv.ARCH_STARTUP_SERVER_WRAPPER;
    bridgeOnlyEnv.ARCH_STARTUP_BRIDGE = "1";
    bridgeOnlyEnv.ARCH_STARTUP_OPTIONS_FILE = optionsFile;
    const bridgeOnlyChild = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(traceModule).href,
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { createUsageServer } from ${JSON.stringify(pathToFileURL(serverModule).href)};
          const server = createUsageServer(${JSON.stringify({
            homeDir: fixtureHome,
            env: sourceDiscoveryEnv(),
            pricingRefreshSchedulerEnabled: false,
            automaticDiscoveryEnabled: false,
          })});
          assert.ok(server[Symbol.for("architecture.startup.gate")]);
          assert.equal(server[Symbol.for("architecture.startup.wrapper.test")], undefined);
          await server.close();
          process.stdout.write("bridge-only-ok");
        `,
      ],
      {
        cwd: path.resolve(experimentDirectory, "..", ".."),
        encoding: "utf8",
        env: bridgeOnlyEnv,
      },
    );
    assert.equal(bridgeOnlyChild.status, 0, bridgeOnlyChild.stderr);
    assert.equal(bridgeOnlyChild.stdout, "bridge-only-ok");

    const wrapperOnlyEnv = sourceDiscoveryEnv();
    delete wrapperOnlyEnv.ARCH_STARTUP_TRACE_DIR;
    wrapperOnlyEnv.ARCH_STARTUP_BRIDGE = "1";
    wrapperOnlyEnv.ARCH_STARTUP_OPTIONS_FILE = optionsFile;
    wrapperOnlyEnv.ARCH_STARTUP_SERVER_WRAPPER = wrapperFileUrl;
    const wrapperOnlyChild = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(traceModule).href,
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { createUsageServer } from ${JSON.stringify(pathToFileURL(serverModule).href)};
          const server = createUsageServer(${JSON.stringify({
            homeDir: fixtureHome,
            env: sourceDiscoveryEnv(),
            pricingRefreshSchedulerEnabled: false,
            automaticDiscoveryEnabled: false,
          })});
          const marker = server[Symbol.for("architecture.startup.wrapper.test")];
          assert.ok(marker);
          assert.ok(marker.sourceServer[Symbol.for("architecture.startup.gate")]);
          assert.equal(marker.options.databaseFile, ${JSON.stringify(privateDatabase)});
          await server.close();
          process.stdout.write("wrapper-only-ok");
        `,
      ],
      {
        cwd: path.resolve(experimentDirectory, "..", ".."),
        encoding: "utf8",
        env: wrapperOnlyEnv,
      },
    );
    assert.equal(wrapperOnlyChild.status, 0, wrapperOnlyChild.stderr);
    assert.equal(wrapperOnlyChild.stdout, "wrapper-only-ok");

    const rowsExportEnv = sourceDiscoveryEnv();
    delete rowsExportEnv.ARCH_STARTUP_TRACE_DIR;
    delete rowsExportEnv.ARCH_STARTUP_BRIDGE;
    delete rowsExportEnv.ARCH_STARTUP_OPTIONS_FILE;
    delete rowsExportEnv.ARCH_STARTUP_SERVER_WRAPPER;
    rowsExportEnv.ARCH_STARTUP_EXPORT_ROWS = "1";
    const rowsExportChild = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(traceModule).href,
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { publishedUsageEventFromRow } from ${JSON.stringify(pathToFileURL(usageStoreModule).href)};
          const event = publishedUsageEventFromRow({
            timestamp_ms: Date.parse("2026-11-02T01:01:00.000Z"),
            session_id: "rows-fixture",
            home_id: "rows-home",
            home_label: "Rows Home",
            channel: "cli",
            project: "/fixture",
            model: "gpt-5",
            cwd: "/fixture",
            repository_key: "repo",
            repository_path: "/fixture",
            repository_kind: "git",
            detail_mask: 0,
            reconciliation_gap: 0,
            cache_write_tokens: 0,
            cache_write_known: 0,
            request_input_tokens: 0,
            context_level: "unknown",
            service_tier: "standard",
            price_version: "fixture",
            total: 123,
            input: 100,
            cached: 20,
            output: 23,
            reasoning: 5,
          }, "extra", null);
          assert.equal(event.sessionId, "rows-fixture");
          assert.equal(event.total.total, 123);
          process.stdout.write("rows-export-ok");
        `,
      ],
      {
        cwd: path.resolve(experimentDirectory, "..", ".."),
        encoding: "utf8",
        env: rowsExportEnv,
      },
    );
    assert.equal(rowsExportChild.status, 0, rowsExportChild.stderr);
    assert.equal(rowsExportChild.stdout, "rows-export-ok");

    const preloadTraceDirectory = path.join(root, "preload-trace");
    const preloadEnv = sourceDiscoveryEnv();
    preloadEnv.ARCH_STARTUP_TRACE_DIR = preloadTraceDirectory;
    preloadEnv.ARCH_STARTUP_BRIDGE = "1";
    preloadEnv.ARCH_STARTUP_OPTIONS_FILE = optionsFile;
    const preloadChild = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(traceModule).href,
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { createUsageServer } from ${JSON.stringify(pathToFileURL(serverModule).href)};
          const server = createUsageServer(${JSON.stringify({
            homeDir: fixtureHome,
            env: sourceDiscoveryEnv(),
            pricingRefreshSchedulerEnabled: false,
            automaticDiscoveryEnabled: false,
          })});
          const gate = server[Symbol.for("architecture.startup.gate")];
          assert.ok(gate);
          assert.ok(server[Symbol.for("architecture.startup.wrapper.test")]);
          await gate.pricingReady;
          await server.close();
          process.stdout.write("preload-ok");
        `,
      ],
      {
        cwd: path.resolve(experimentDirectory, "..", ".."),
        encoding: "utf8",
        env: preloadEnv,
      },
    );
    assert.equal(preloadChild.status, 0, preloadChild.stderr);
    assert.equal(preloadChild.stdout, "preload-ok");
    const preloadTraceFiles = await readdir(preloadTraceDirectory);
    const preloadNdjson = preloadTraceFiles.find((file) => file.endsWith(".ndjson"));
    assert.ok(preloadNdjson);
    const preloadSpans = await readNdjson(path.join(preloadTraceDirectory, preloadNdjson));
    assert.equal(preloadSpans.some((span) => span.label === "server.createUsageServer"), true);
    assert.equal(preloadSpans.some((span) => span.label === "pricing-store.loadPricingFile"), true);
  } finally {
    if (server) await server.close();
    trace.closeTrace();
    await rm(root, { recursive: true, force: true });
  }
});
