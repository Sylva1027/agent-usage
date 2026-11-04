import assert from "node:assert/strict";
import { appendFile, constants as fsConstants, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { UsageStore } from "../src/usage-store.js";

const filtersFor = (calendarZone) => ({
  preset: "all",
  bucket: "day",
  calendarZone,
  now: new Date("2026-07-13T12:00:00.000Z"),
});

const originalTimezone = process.env.TZ;
process.env.TZ = "Asia/Shanghai";
test.after(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

test("persisted all-summary releases legacy quote input while retaining reusable aggregates", async () => {
  const fixture = await createFixture("usage-all-summary-carrier-");
  const store = new UsageStore(fixture.options);
  try {
    await store.sync();
    const filters = filtersFor("utc");
    const detailed = await store.summarizeHistory(filters, { includeDetails: true });
    assert.ok(store.summaryProjectionCache?.quoteInputs);
    const projection = store.summaryProjectionCache.projection;
    await store.summarizeHistory(filters, { includeDetails: false });
    assert.ok(store.summaryProjectionCache.quoteInputs === null, "the previous event carrier must be released");
    assert.strictEqual(store.summaryProjectionCache.projection, projection);
    const events = store.costEventsForRange.bind(store);
    let scans = 0;
    store.costEventsForRange = function* (...args) {
      scans++;
      yield* events(...args);
    };
    const repeated = await store.summarizeHistory(filters, { includeDetails: true });
    assert.deepEqual(scrubClocks(repeated), scrubClocks(detailed));
    assert.equal(scans, 0, "returning to the old detail scope should reuse its small aggregates");
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unfiltered event bounds seek index endpoints and preserve empty, epoch, and excluded scopes", async () => {
  const fixture = await createFixture("usage-all-summary-bounds-");
  const store = new UsageStore(fixture.options);
  try {
    await store.sync();
    const prepare = store.database.prepare.bind(store.database);
    let boundsSql;
    store.database.prepare = (sql) => {
      boundsSql = sql;
      return prepare(sql);
    };
    const bounds = store.eventBounds();
    store.database.prepare = prepare;
    assert.deepEqual(
      { ...bounds },
      { minimum: Date.parse("2026-07-12T02:00:00.000Z"), maximum: Date.parse("2026-07-12T23:30:00.000Z") },
    );
    const plan = prepare(`EXPLAIN QUERY PLAN ${boundsSql}`).all();
    assert.ok(plan.some((row) => String(row.detail).includes("SEARCH events")));
    assert.ok(plan.every((row) => !/^SCAN events\b/.test(String(row.detail))));
    store.database.exec("UPDATE events SET timestamp_ms=0 WHERE id=(SELECT MIN(id) FROM events)");
    assert.equal(store.eventBounds().minimum, 0);
    const homes = store.database
      .prepare("SELECT DISTINCT home_id FROM events")
      .all()
      .map((row) => String(row.home_id));
    assert.deepEqual({ ...store.eventBounds(homes) }, { minimum: null, maximum: null });
    store.database.exec("DELETE FROM events");
    assert.deepEqual({ ...store.eventBounds() }, { minimum: null, maximum: null });
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function tokenFrame(timestamp, output, { input = 10, reasoning = 0 } = {}) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          total_tokens: input + output,
          input_tokens: input,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
      },
    },
  };
}

function rollout(threadId, model, frames) {
  return [
    {
      type: "session_meta",
      timestamp: "2026-07-12T01:00:00.000Z",
      payload: {
        id: threadId,
        session_id: threadId,
        source: "cli",
        originator: "codex-tui",
        cwd: "/work/main",
      },
    },
    { type: "turn_context", payload: { model } },
    ...frames,
  ];
}

async function createFixture(prefix = "usage-all-summary-integration-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const codexHome = path.join(root, ".codex");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "12");
  await mkdir(sessionDirectory, { recursive: true });
  const mainFile = path.join(sessionDirectory, "rollout-main.jsonl");
  await writeFile(
    mainFile,
    jsonl(
      rollout("thread-main", "gpt-6-sol", [
        tokenFrame("2026-07-12T02:00:00.000Z", 20),
        tokenFrame("2026-07-12T23:30:00.000Z", 100),
      ]),
    ),
  );
  const options = {
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    env: {},
    extraHomes: "",
    importDirs: [],
  };
  return { root, codexHome, sessionDirectory, mainFile, options };
}

function scrubClocks(value) {
  if (Array.isArray(value)) return value.map(scrubClocks);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["generatedAt", "checkedAt", "fingerprint", "missingSinceMs"].includes(key))
      .map(([key, entry]) => [key, scrubClocks(entry)]),
  );
}

async function legacyDashboard(fixture, source, filters, options) {
  const legacy = new UsageStore(fixture.options);
  try {
    await legacy.open();
    legacy.allSummaryOptions = () => null;
    legacy.homes = structuredClone(source.homes);
    legacy.warnings = [...source.warnings];
    legacy.generatedAt = source.generatedAt;
    legacy.checkedAt = source.checkedAt;
    legacy.fingerprint = source.fingerprint;
    legacy.serviceTierEvidence = source.serviceTierEvidence;
    legacy.serviceTierEvidenceInput = source.serviceTierEvidenceInput;
    legacy.quotaSourceEvidence = source.quotaSourceEvidence;
    return await legacy.dashboardHistory(filters, options);
  } finally {
    legacy.close();
  }
}

async function assertDashboardParity(persisted, fixture, filters, options = { includeDetails: false }) {
  const legacy = await legacyDashboard(fixture, persisted.store, filters, options);
  assert.deepEqual(scrubClocks(persisted.dashboard), scrubClocks(legacy));
}

async function writePriorityEvidence(fixture) {
  const database = new DatabaseSync(path.join(fixture.codexHome, "logs_2.sqlite"));
  try {
    database.exec(
      "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)",
    );
    database
      .prepare(
        "INSERT INTO logs (ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, 0, ?, 'codex_core::session::handlers', ?)",
      )
      .run(
        Date.parse("2026-07-12T01:59:00.000Z") / 1000,
        "thread-main",
        'session_loop{thread_id=thread-main}: Submission sub=Submission { id: "summary-tier", op: TurnInput { request: { input: UserInput { content: [] }, service_tier: Some(Some("priority")), collaboration_mode: None } } }',
      );
  } finally {
    database.close();
  }
}

function activeTimelineTotals(timeline) {
  return new Map(timeline.filter((row) => row.total.total > 0).map((row) => [row.key, row.total.total]));
}

test(
  "persisted all-summary matches legacy across reopen, append, revision, pricing, and evidence changes",
  async () => {
    const originalCatalog = getPricingCatalog();
    const fixture = await createFixture();
    let store = new UsageStore(fixture.options);
    try {
      await store.sync();
      const utc = filtersFor("utc");
      const initial = {
        store,
        dashboard: await store.dashboardHistory(utc, { includeDetails: false }),
      };
      assert.equal(store.lastAllSummaryWork.rebuilt, true);
      assert.equal(store.lastAllSummaryWork.readEvents, 2);
      await assertDashboardParity(initial, fixture, utc);

      store.close();
      store = new UsageStore(fixture.options);
      await store.sync();
      const reopened = {
        store,
        dashboard: await store.dashboardHistory(utc, { includeDetails: false }),
      };
      assert.equal(store.lastAllSummaryWork.reused, true);
      assert.equal(store.lastAllSummaryWork.readEvents, 0);
      await assertDashboardParity(reopened, fixture, utc);

      await appendFile(fixture.mainFile, jsonl([tokenFrame("2026-07-13T01:00:00.000Z", 32)]));
      const appendStatus = await store.sync();
      assert.equal(appendStatus.updatedFileCount, 1);
      const appended = {
        store,
        dashboard: await store.dashboardHistory(utc, { includeDetails: false }),
      };
      assert.equal(store.lastAllSummaryWork.readEvents, 1);
      assert.equal(appended.dashboard.summary.eventCount, 3);
      await assertDashboardParity(appended, fixture, utc);

      const lateFile = path.join(fixture.sessionDirectory, "rollout-late.jsonl");
      await writeFile(lateFile, jsonl(rollout("thread-late", "glm-4.7", [tokenFrame("2026-07-12T03:00:00.000Z", 40)])));
      await store.sync();
      const revised = {
        store,
        dashboard: await store.dashboardHistory(utc, { includeDetails: false }),
      };
      assert.ok(
        store.lastAllSummaryWork.rewinds > 0,
        "an older timestamp must rewind to a checkpoint before the revision",
      );
      assert.equal(revised.dashboard.summary.eventCount, 4);
      await assertDashboardParity(revised, fixture, utc);

      const changedCatalog = structuredClone(originalCatalog);
      const changedRates = changedCatalog.models["gpt-6-sol"];
      for (const rates of [changedRates.short, changedRates.long, changedRates.fast.short, changedRates.fast.long]) {
        for (const field of ["input", "cachedInput", "cacheWrite", "output"]) rates[field] *= 3;
      }
      setPricingCatalog(changedCatalog);
      const repriced = {
        store,
        dashboard: await store.dashboardHistory(utc, { includeDetails: false }),
      };
      assert.notEqual(
        repriced.dashboard.summary.costEstimate.totalUsd,
        revised.dashboard.summary.costEstimate.totalUsd,
      );
      assert.notDeepEqual(
        repriced.dashboard.summary.costEstimate.priceVersions,
        revised.dashboard.summary.costEstimate.priceVersions,
      );
      await assertDashboardParity(repriced, fixture, utc);

      const evidenceBefore = store.serviceTierEvidenceInput;
      await writePriorityEvidence(fixture);
      await store.sync();
      assert.notEqual(store.serviceTierEvidenceInput, evidenceBefore);
      const evidenced = {
        store,
        dashboard: await store.dashboardHistory(utc, { includeDetails: false }),
      };
      assert.notEqual(
        evidenced.dashboard.summary.costEstimate.totalUsd,
        repriced.dashboard.summary.costEstimate.totalUsd,
      );
      await assertDashboardParity(evidenced, fixture, utc);

      const local = {
        store,
        dashboard: await store.dashboardHistory(filtersFor("local"), { includeDetails: false }),
      };
      await assertDashboardParity(local, fixture, filtersFor("local"));
      assert.notDeepEqual(
        [...activeTimelineTotals(evidenced.dashboard.summary.timeline)],
        [...activeTimelineTotals(local.dashboard.summary.timeline)],
        "UTC and local day buckets must be different projections",
      );
    } finally {
      store.close();
      setPricingCatalog(originalCatalog);
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);

test(
  "persisted all-summary is selected only for its supported scope and falls back before cold history",
  async () => {
    const fixture = await createFixture("usage-all-summary-selection-");
    const store = new UsageStore(fixture.options);
    try {
      await store.sync();
      const filters = filtersFor("utc");
      const baseline = {
        store,
        dashboard: await store.dashboardHistory(filters, { includeDetails: false }),
      };
      await assertDashboardParity(baseline, fixture, filters);

      const allSummaryWork = store.lastAllSummaryWork;
      const detailed = {
        store,
        dashboard: await store.dashboardHistory(filters, { includeDetails: true }),
      };
      assert.strictEqual(store.lastAllSummaryWork, allSummaryWork, "includeDetails must bypass the all-summary build");
      assert.ok(detailed.dashboard.summary.homes?.length);
      assert.ok(detailed.dashboard.summary.projects?.length);
      await assertDashboardParity(detailed, fixture, filters, { includeDetails: true });

      const homeId = store.homes.find((home) => home.kind === "main")?.id ?? store.homes[0].id;
      const excludedFilters = { ...filters, excludeHomes: [homeId] };
      const excluded = {
        store,
        dashboard: await store.dashboardHistory(excludedFilters, { includeDetails: false }),
      };
      assert.strictEqual(store.lastAllSummaryWork, allSummaryWork, "excluded homes must bypass the all-summary build");
      assert.equal(excluded.dashboard.summary.eventCount, 0);
      await assertDashboardParity(excluded, fixture, excludedFilters);

      const startMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
      const endMs = Date.parse("2026-07-14T00:00:00.000Z");
      const segmentFile = path.join(fixture.root, "cold.sqlite");
      const fsPromises = process.getBuiltinModule("fs/promises");
      const originalLink = fsPromises.link;
      fsPromises.link = async (source, destination) => copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      syncBuiltinESMExports();
      try {
        await createHistoryArchiveCandidate(store.database, segmentFile, { startMs, endMs });
      } finally {
        fsPromises.link = originalLink;
        syncBuiltinESMExports();
      }
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, segmentFile));

      assert.equal(
        store.allSummaryOptions(filters, { includeDetails: false }),
        null,
        "cold event authority must disable the hot all-summary path",
      );
      const cold = {
        store,
        dashboard: await store.dashboardHistory(filters, { includeDetails: false }),
      };
      assert.deepEqual(scrubClocks(cold.dashboard), scrubClocks(baseline.dashboard));
      await assertDashboardParity(cold, fixture, filters);
    } finally {
      store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);

test(
  "persisted all-summary preserves legacy id order for late floats and replays an updated old id",
  async () => {
    const fixture = await createFixture("usage-all-summary-id-order-");
    const store = new UsageStore(fixture.options);
    const largeOutput = 8_000_000_000_000_000;
    try {
      await writeFile(
        fixture.mainFile,
        jsonl(
          rollout("thread-id-order", "gpt-6-sol", [
            tokenFrame("2026-07-12T02:00:00.000Z", 1, { input: 0 }),
            tokenFrame("2026-07-12T23:30:00.000Z", largeOutput, { input: 0 }),
          ]),
        ),
      );
      await store.sync();

      await appendFile(fixture.mainFile, jsonl([tokenFrame("2026-07-13T01:00:00.000Z", 1, { input: 0 })]));
      await store.sync();

      const lateFile = path.join(fixture.sessionDirectory, "rollout-id-order-late.jsonl");
      await writeFile(
        lateFile,
        jsonl(rollout("thread-id-order-late", "gpt-6-sol", [tokenFrame("2026-07-12T03:00:00.000Z", 1, { input: 0 })])),
      );
      await store.sync();

      const rows = store.database.prepare("SELECT id,timestamp_ms,output FROM events ORDER BY id").all();
      assert.deepEqual(
        rows.map((row) => Number(row.id)),
        [1, 2, 3, 4],
        "the late source must keep the legacy SCAN events id order",
      );
      assert.deepEqual(
        rows.map((row) => Number(row.timestamp_ms)),
        [
          Date.parse("2026-07-12T02:00:00.000Z"),
          Date.parse("2026-07-12T23:30:00.000Z"),
          Date.parse("2026-07-13T01:00:00.000Z"),
          Date.parse("2026-07-12T03:00:00.000Z"),
        ],
      );

      const filters = filtersFor("utc");
      const persisted = {
        store,
        dashboard: await store.dashboardHistory(filters, { includeDetails: false }),
      };
      const legacy = await legacyDashboard(fixture, store, filters, { includeDetails: false });
      assert.equal(legacy.summary.costEstimate.totalUsd, 80000000000.00005);
      assert.equal(persisted.dashboard.summary.costEstimate.totalUsd, 80000000000.00005);
      assert.deepEqual(scrubClocks(persisted.dashboard), scrubClocks(legacy));

      const huge = rows.find((row) => Number(row.output) === largeOutput);
      assert.ok(huge);
      const oldId = Number(huge.id);
      const revisedOutput = largeOutput - 2;
      store.database.prepare("UPDATE events SET total=?,output=? WHERE id=?").run(revisedOutput, revisedOutput, oldId);

      const replay = await store.dashboardHistory(filters, { includeDetails: false });
      assert.ok(store.lastAllSummaryWork.rewinds > 0, "an update to an old id must replay its suffix");
      assert.ok(store.lastAllSummaryWork.readEvents > 0);
      assert.equal(
        Number(store.database.prepare("SELECT id FROM events WHERE id=?").get(oldId).id),
        oldId,
        "the replay fixture must update the existing event id",
      );
      assert.notEqual(replay.summary.costEstimate.totalUsd, persisted.dashboard.summary.costEstimate.totalUsd);
      const replayLegacy = await legacyDashboard(fixture, store, filters, { includeDetails: false });
      assert.deepEqual(scrubClocks(replay), scrubClocks(replayLegacy));
    } finally {
      store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);
