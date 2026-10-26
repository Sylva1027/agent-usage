import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { estimateCostForEvents } from "../src/pricing.js";
import { COMPARISON_PERIOD_KEYS } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { queryUsageRollupModelsRange, queryUsageRollupsRange, rebuildUsageRollups } from "../src/usage-rollups.js";

function glmEvent({ total, input, output }) {
  return {
    model: "glm-4.7",
    channel: "ZCode",
    serviceTier: "standard",
    contextLevel: "short",
    requestInputTokens: input,
    detailMask: 47,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    total: { total, input, cached: 0, output, reasoning: 0 },
  };
}

test("GLM output tier is applied per event, not after aggregation", () => {
  const events = [
    glmEvent({ total: 1100, input: 1000, output: 100 }),
    glmEvent({ total: 1100, input: 1000, output: 100 }),
  ];
  const merged = glmEvent({ total: 2200, input: 2000, output: 200 });

  const perEvent = estimateCostForEvents(events);
  const aggregated = estimateCostForEvents([merged]);

  assert.ok(Math.abs(perEvent.totalCny - 0.0056) < 1e-12);
  assert.equal(perEvent.pricedRecords, 2);
  assert.ok(Math.abs(aggregated.totalCny - 0.0088) < 1e-12);
  assert.equal(aggregated.pricedRecords, 1);
});

test("session count is distinct across models within one day", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-parity-session-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const events = [
    ["2026-07-12T02:00:00.000Z", "gpt-6-sol", 10],
    ["2026-07-12T02:01:00.000Z", "gpt-6-sol", 20],
    ["2026-07-12T02:02:00.000Z", "gpt-6-luna", 30],
  ].map(([timestamp, model, total]) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/switch",
    cwd: "/work/switch",
    session_id: "switch-session",
    model,
    usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
  }));
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: [projectRoot],
  });

  try {
    await store.sync();
    const summary = store.summarize({
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-12",
      bucket: "day",
      calendarZone: "utc",
    });
    const modelSessions = Object.fromEntries(summary.models.map((model) => [model.name, model.sessions]));

    assert.equal(summary.sessionCount, 1);
    assert.equal(modelSessions["gpt-6-sol"], 1);
    assert.equal(modelSessions["gpt-6-luna"], 1);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("repository path count follows the selected date range", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-parity-range-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const repositoryRoot = path.join(homeDir, "repository");
  const cwdA = path.join(repositoryRoot, "cwd-a");
  const cwdB = path.join(repositoryRoot, "cwd-b");
  const events = [
    ["2026-07-12T02:00:00.000Z", cwdA],
    ["2026-07-13T02:00:00.000Z", cwdB],
  ].map(([timestamp, cwd], index) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: repositoryRoot,
    cwd,
    session_id: `range-session-${index}`,
    model: "gpt-6-sol",
    usage: { total: 10, input: 8, cached: 0, output: 2, reasoning: 0 },
  }));
  await mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
  await mkdir(cwdA, { recursive: true });
  await mkdir(cwdB, { recursive: true });
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: [projectRoot],
  });
  const summarize = (startDate, endDate) =>
    store.summarize({ preset: "custom", startDate, endDate, bucket: "day", calendarZone: "utc" });

  try {
    await store.sync();
    const narrow = summarize("2026-07-12", "2026-07-12");
    const all = summarize("2026-07-12", "2026-07-13");
    const narrowRepository = narrow.repositories.find((row) => row.kind === "git");
    const allRepository = all.repositories.find((row) => row.kind === "git");

    assert.deepEqual(
      { paths: narrow.projects.map((project) => project.name), pathCount: narrowRepository.pathCount },
      { paths: [cwdA], pathCount: 1 },
    );
    assert.deepEqual(
      {
        paths: all.projects.map((project) => project.name).sort(),
        pathCount: allRepository.pathCount,
      },
      { paths: [cwdA, cwdB].sort(), pathCount: 2 },
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("excluded homes are removed from repository path counts", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-parity-exclude-"));
  const repositoryRoot = path.join(homeDir, "repository");
  const cwdA = path.join(repositoryRoot, "cwd-a");
  const cwdB = path.join(repositoryRoot, "cwd-b");
  const projectRoots = [path.join(homeDir, "log-a"), path.join(homeDir, "log-b")];
  await mkdir(path.join(repositoryRoot, ".git"), { recursive: true });
  await mkdir(cwdA, { recursive: true });
  await mkdir(cwdB, { recursive: true });
  for (const [index, [projectRoot, cwd]] of projectRoots.map((root, index) => [root, [cwdA, cwdB][index]]).entries()) {
    await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".codex-usage", "usage.jsonl"),
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: `2026-07-12T0${index}:00:00.000Z`,
        source: "test",
        channel: "Test",
        project_root: repositoryRoot,
        cwd,
        session_id: `exclude-session-${index}`,
        model: "gpt-6-sol",
        usage: { total: 10, input: 8, cached: 0, output: 2, reasoning: 0 },
      })}\n`,
    );
  }
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: projectRoots,
  });

  try {
    await store.sync();
    const all = store.summarize({ preset: "all", bucket: "day", calendarZone: "utc" });
    const excluded = store.summarize({
      preset: "all",
      bucket: "day",
      calendarZone: "utc",
      excludeHomes: [store.homes[0].id],
    });
    const allRepository = all.repositories.find((row) => row.kind === "git");
    const excludedRepository = excluded.repositories.find((row) => row.kind === "git");

    assert.equal(allRepository.pathCount, 2);
    assert.deepEqual(
      { paths: excluded.projects.map((project) => project.name), pathCount: excludedRepository.pathCount },
      { paths: [cwdB], pathCount: 1 },
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("detail masks derive known and inconsistent metrics per event", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-parity-detail-"));
  const projectRoot = path.join(homeDir, "log");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const base = {
    schema_version: "codex-usage.project-log.v1",
    timestamp: "2026-07-12T02:00:00.000Z",
    source: "test",
    channel: "Test",
    project_root: "/work/detail",
    cwd: "/work/detail",
    model: "gpt-6-sol",
  };
  const events = [
    { ...base, session_id: "detail-a", usage: { total: 100, input: 80, output: 20 } },
    {
      ...base,
      timestamp: "2026-07-12T02:01:00.000Z",
      session_id: "detail-b",
      usage: { total: 50, cached: 5, reasoning: 5 },
    },
    {
      ...base,
      timestamp: "2026-07-12T02:02:00.000Z",
      session_id: "detail-c",
      usage: { total: 40, input: 0, output: 0 },
    },
  ];
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: [projectRoot],
  });

  try {
    await store.sync();
    const comparison = store.periodComparison({ now: "2026-07-12T12:00:00.000Z", calendarZone: "utc" });
    const today = comparison.totals.today;

    assert.deepEqual(
      {
        input: today.input,
        inputUnavailableTokens: today.inputUnavailableTokens,
        output: today.output,
        outputUnavailableTokens: today.outputUnavailableTokens,
      },
      { input: 80, inputUnavailableTokens: 90, output: 20, outputUnavailableTokens: 90 },
    );
    assert.deepEqual(
      {
        unattributedDetailTokens: today.unattributedDetailTokens,
        inconsistentTokens: today.inconsistentTokens,
        reconciliationGap: today.reconciliationGap,
      },
      { unattributedDetailTokens: 190, inconsistentTokens: 40, reconciliationGap: 40 },
    );
    assert.deepEqual(comparison.models[0].periods.today, today);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("rollup detail metrics match the raw periodAggregate oracle", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-parity-rollup-detail-"));
  const projectRoots = [path.join(homeDir, "log-a"), path.join(homeDir, "log-b")];
  const base = {
    schema_version: "codex-usage.project-log.v1",
    timestamp: "2026-07-12T02:00:00.000Z",
    source: "test",
    channel: "Test",
    project_root: "/work/detail",
    cwd: "/work/detail",
    model: "gpt-6-sol",
  };
  const events = [
    { ...base, session_id: "detail-a", usage: { total: 100, input: 80, output: 20 } },
    {
      ...base,
      timestamp: "2026-07-12T02:01:00.000Z",
      session_id: "detail-b",
      usage: { total: 50, cached: 5, reasoning: 5 },
    },
    {
      ...base,
      timestamp: "2026-07-12T02:02:00.000Z",
      session_id: "detail-c",
      usage: { total: 40, input: 0, output: 0 },
    },
  ];
  const eventsByRoot = [[events[0], events[2]], [events[1]]];
  for (const [index, projectRoot] of projectRoots.entries()) {
    const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(usageFile, `${eventsByRoot[index].map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: projectRoots,
  });
  const fields = [
    "total",
    "input",
    "inputUnavailableTokens",
    "cached",
    "cachedUnavailableTokens",
    "uncachedInput",
    "uncachedInputUnavailableTokens",
    "cacheRateInput",
    "cacheRateCached",
    "output",
    "outputUnavailableTokens",
    "reasoning",
    "reasoningUnavailableTokens",
    "unattributedDetailTokens",
    "inconsistentTokens",
    "reconciliationGap",
  ];
  const pick = (row) => Object.fromEntries(fields.map((field) => [field, row[field]]));

  try {
    await store.sync();
    const start = new Date(Date.UTC(2026, 6, 12));
    const endExclusive = new Date(Date.UTC(2026, 6, 13));
    // periodAggregate uses an inclusive end; convert the rollup half-open boundary.
    const range = { start, end: new Date(endExclusive.getTime() - 1) };
    const ranges = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, range]));
    const oracle = (excludeHomes = []) =>
      pick(
        store.periodAggregate(null, null, new Date("2026-07-12T12:00:00.000Z"), ranges, { excludeHomes })[0].periods
          .today,
      );
    const rollup = (excludeHomes = []) =>
      pick(
        queryUsageRollupsRange(store.database, {
          startDay: "2026-07-12",
          endDay: "2026-07-12",
          calendarZone: "utc",
          excludeHomes,
        }),
      );
    const excludedHomeId = store.homes.find((home) => home.path === projectRoots[0]).id;
    const expectedAll = {
      total: 190,
      input: 80,
      inputUnavailableTokens: 90,
      cached: 5,
      cachedUnavailableTokens: 140,
      uncachedInput: 0,
      uncachedInputUnavailableTokens: 190,
      cacheRateInput: 0,
      cacheRateCached: 0,
      output: 20,
      outputUnavailableTokens: 90,
      reasoning: 5,
      reasoningUnavailableTokens: 140,
      unattributedDetailTokens: 190,
      inconsistentTokens: 40,
      reconciliationGap: 40,
    };
    const expectedExcluded = {
      total: 50,
      input: 0,
      inputUnavailableTokens: 50,
      cached: 5,
      cachedUnavailableTokens: 0,
      uncachedInput: 0,
      uncachedInputUnavailableTokens: 50,
      cacheRateInput: 0,
      cacheRateCached: 0,
      output: 0,
      outputUnavailableTokens: 50,
      reasoning: 5,
      reasoningUnavailableTokens: 0,
      unattributedDetailTokens: 50,
      inconsistentTokens: 0,
      reconciliationGap: 0,
    };
    const before = queryUsageRollupsRange(store.database, {
      startDay: "2026-07-12",
      endDay: "2026-07-12",
      calendarZone: "utc",
    });

    assert.deepEqual(
      {
        rollupAll: rollup(),
        rollupExcluded: rollup([excludedHomeId]),
        oracleAll: oracle(),
        oracleExcluded: oracle([excludedHomeId]),
      },
      {
        rollupAll: expectedAll,
        rollupExcluded: expectedExcluded,
        oracleAll: expectedAll,
        oracleExcluded: expectedExcluded,
      },
    );

    rebuildUsageRollups(store.database, { days: ["2026-07-12"], calendarZone: "utc" });
    assert.deepEqual(
      queryUsageRollupsRange(store.database, {
        startDay: "2026-07-12",
        endDay: "2026-07-12",
        calendarZone: "utc",
      }),
      before,
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("model range rollups match raw periodAggregate models across UTC boundaries", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-parity-model-range-"));
  const projectRoots = [path.join(homeDir, "log-a"), path.join(homeDir, "log-b")];
  const base = {
    schema_version: "codex-usage.project-log.v1",
    source: "test",
    channel: "Test",
    project_root: "/work/model-range",
    cwd: "/work/model-range",
  };
  const makeEvent = (timestamp, model, session_id, usage) => ({
    ...base,
    timestamp,
    model,
    session_id,
    usage,
  });
  const eventsByRoot = [
    [
      makeEvent("2026-07-12T02:00:00.000Z", "gpt-6-sol", "range-a-sol", {
        total: 100,
        input: 80,
        cached: 20,
        output: 20,
        reasoning: 5,
      }),
      makeEvent("2026-07-12T23:59:59.999Z", "gpt-6-luna", "range-a-luna", {
        total: 30,
        input: 12,
        cached: 4,
      }),
    ],
    [
      makeEvent("2026-07-13T00:00:00.000Z", "gpt-6-sol", "range-b-sol", {
        total: 50,
        output: 10,
      }),
      makeEvent("2026-07-13T03:00:00.000Z", "gpt-6-luna", "range-b-luna", {
        total: 70,
        input: 40,
        cached: 10,
        output: 30,
      }),
    ],
  ];
  for (const [index, projectRoot] of projectRoots.entries()) {
    const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(usageFile, `${eventsByRoot[index].map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: projectRoots,
  });

  try {
    await store.sync();
    const oracle = (start, end, excludeHomes = []) => {
      const range = { start, end };
      const ranges = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, range]));
      return store
        .periodAggregate("model", "model", new Date("2026-07-13T12:00:00.000Z"), ranges, { excludeHomes })
        .map(({ name, periods }) => ({ model: name, ...periods.today }))
        .sort((a, b) => a.model.localeCompare(b.model));
    };
    const rollup = (startDay, endDay, excludeHomes = []) =>
      queryUsageRollupModelsRange(store.database, {
        startDay,
        endDay,
        excludeHomes,
        calendarZone: "utc",
      }).sort((a, b) => a.model.localeCompare(b.model));
    const day12Start = new Date(Date.UTC(2026, 6, 12));
    const twoDayEndExclusive = new Date(Date.UTC(2026, 6, 14));
    const twoDayEndInclusive = new Date(twoDayEndExclusive.getTime() - 1);
    const excludedHomeId = store.homes.find((home) => home.path === projectRoots[0]).id;

    assert.deepEqual(
      rollup("2026-07-12", "2026-07-13").map(({ model }) => model),
      ["gpt-6-luna", "gpt-6-sol"],
    );
    assert.deepEqual(rollup("2026-07-12", "2026-07-13"), oracle(day12Start, twoDayEndInclusive));
    assert.deepEqual(
      rollup("2026-07-12", "2026-07-13", [excludedHomeId]),
      oracle(day12Start, twoDayEndInclusive, [excludedHomeId]),
    );
    assert.deepEqual(rollup("2026-07-12", "2026-07-12"), oracle(day12Start, new Date(Date.UTC(2026, 6, 13) - 1)));
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
