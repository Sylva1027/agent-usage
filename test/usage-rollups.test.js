import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { COMPARISON_PERIOD_KEYS } from "../public/period-comparison.js";
import { UsageStore } from "../src/usage-store.js";
import { PRICING_MODELS_A } from "../test-support/pricing-official-fixture.mjs";
import {
  createUsageRollups,
  listDirtyUsageRollupDays,
  queryUsageRollupModels,
  queryUsageRollupModelsRange,
  queryUsageRollupModelsWindow,
  queryUsageRollups,
  queryUsageRollupsRange,
  rebuildUsageRollups,
} from "../src/usage-rollups.js";

async function openEventsDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-rollups-"));
  const db = new DatabaseSync(path.join(directory, "index.sqlite"));
  db.exec(`
    CREATE TABLE events (
      timestamp_ms INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      home_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'gpt-6-sol',
      session_id TEXT,
      total INTEGER NOT NULL,
      input INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL,
      detail_mask INTEGER NOT NULL DEFAULT 0,
      reconciliation_gap INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `);
  return { db, directory };
}

const unavailableTokens = (total) => ({
  inputKnownTokens: 0,
  inputUnavailableTokens: total,
  outputKnownTokens: 0,
  outputUnavailableTokens: total,
  cachedKnownTokens: 0,
  cachedUnavailableTokens: total,
  reasoningKnownTokens: 0,
  reasoningUnavailableTokens: total,
  uncachedInput: 0,
  uncachedInputUnavailableTokens: total,
  cacheRateInput: 0,
  cacheRateCached: 0,
  unattributedDetailTokens: total,
  inconsistentTokens: 0,
  reconciliationGap: 0,
});

const detailTokenFields = (row) => ({
  inputKnownTokens: row.input_known_tokens ?? row.inputKnownTokens,
  inputUnavailableTokens: row.input_unavailable_tokens ?? row.inputUnavailableTokens,
  cachedKnownTokens: row.cached_known_tokens ?? row.cachedKnownTokens,
  cachedUnavailableTokens: row.cached_unavailable_tokens ?? row.cachedUnavailableTokens,
  outputKnownTokens: row.output_known_tokens ?? row.outputKnownTokens,
  outputUnavailableTokens: row.output_unavailable_tokens ?? row.outputUnavailableTokens,
  reasoningKnownTokens: row.reasoning_known_tokens ?? row.reasoningKnownTokens,
  reasoningUnavailableTokens: row.reasoning_unavailable_tokens ?? row.reasoningUnavailableTokens,
  uncachedInput: row.uncached_input_tokens ?? row.uncachedInput,
  uncachedInputUnavailableTokens: row.uncached_input_unavailable_tokens ?? row.uncachedInputUnavailableTokens,
  cacheRateInput: row.cache_rate_input_tokens ?? row.cacheRateInput,
  cacheRateCached: row.cache_rate_cached_tokens ?? row.cacheRateCached,
  unattributedDetailTokens: row.unattributed_detail_tokens ?? row.unattributedDetailTokens,
  inconsistentTokens: row.inconsistent_tokens ?? row.inconsistentTokens,
  reconciliationGap: row.reconciliation_gap_tokens ?? row.reconciliationGap,
});

test("rebuilds one UTC day without duplicating events", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "session-a", 10, 7, 2, 3, 1);
    insert.run(Date.parse("2026-07-12T23:30:00.000Z"), "2026-07-13", "home-a", "session-a", 20, 15, 5, 5, 2);
    insert.run(Date.parse("2026-07-13T00:00:00.000Z"), "2026-07-13", "home-a", null, 999, 999, 0, 0, 0);
    createUsageRollups(db);

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    rebuildUsageRollups(db, { days: ["2026-07-12"] });

    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 2,
      sessionCount: 1,
      homeCount: 1,
      total: 30,
      input: 22,
      cached: 7,
      output: 8,
      reasoning: 3,
      ...unavailableTokens(30),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
    assert.equal(queryUsageRollups(db, { day: "2026-07-13" }), null);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains per-bit detail counts and nonzero reconciliation gaps", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning, detail_mask, reconciliation_gap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "detail-a", 80, 80, 2, 20, 3, 5, 0);
    insert.run(Date.parse("2026-07-12T03:00:00.000Z"), "2026-07-12", "home-a", "detail-b", 50, 0, 5, 0, 7, 10, 0);
    insert.run(Date.parse("2026-07-12T04:00:00.000Z"), "2026-07-12", "home-b", "detail-c", 40, 0, 0, 0, 0, 16, 40);
    insert.run(Date.parse("2026-07-12T05:00:00.000Z"), "2026-07-12", "home-b", "detail-d", 90, 10, 20, 30, 4, 3, 0);
    createUsageRollups(db);
    rebuildUsageRollups(db, { days: ["2026-07-12"] });

    const expected = db
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COALESCE(SUM(CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END), 0) AS input_known_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END), 0) AS input_unavailable_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END), 0) AS cached_known_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END), 0) AS cached_unavailable_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END), 0) AS output_known_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END), 0) AS output_unavailable_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END), 0) AS reasoning_known_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END), 0) AS reasoning_unavailable_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END), 0) AS uncached_input_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END), 0) AS uncached_input_unavailable_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END), 0) AS cache_rate_input_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END), 0) AS cache_rate_cached_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END), 0) AS unattributed_detail_tokens,
          COALESCE(SUM(CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END), 0) AS inconsistent_tokens,
          COALESCE(SUM(reconciliation_gap), 0) AS reconciliation_gap_tokens,
          COUNT(CASE WHEN (detail_mask & 1) != 0 THEN 1 END) AS input_known_count,
          COUNT(CASE WHEN (detail_mask & 2) != 0 THEN 1 END) AS cached_known_count,
          COUNT(CASE WHEN (detail_mask & 4) != 0 THEN 1 END) AS output_known_count,
          COUNT(CASE WHEN (detail_mask & 8) != 0 THEN 1 END) AS reasoning_known_count,
          COUNT(CASE WHEN reconciliation_gap != 0 THEN 1 END) AS reconciliation_gap_count
        FROM events
      `)
      .get();
    assert.deepEqual(
      {
        eventCount: expected.event_count,
        ...detailTokenFields(expected),
        inputKnownCount: expected.input_known_count,
        cachedKnownCount: expected.cached_known_count,
        outputKnownCount: expected.output_known_count,
        reasoningKnownCount: expected.reasoning_known_count,
        reconciliationGapCount: expected.reconciliation_gap_count,
      },
      {
        eventCount: 4,
        inputKnownTokens: 90,
        inputUnavailableTokens: 90,
        cachedKnownTokens: 25,
        cachedUnavailableTokens: 120,
        outputKnownTokens: 20,
        outputUnavailableTokens: 180,
        reasoningKnownTokens: 7,
        reasoningUnavailableTokens: 210,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 170,
        cacheRateInput: 10,
        cacheRateCached: 20,
        unattributedDetailTokens: 260,
        inconsistentTokens: 40,
        reconciliationGap: 40,
        inputKnownCount: 2,
        cachedKnownCount: 2,
        outputKnownCount: 1,
        reasoningKnownCount: 1,
        reconciliationGapCount: 1,
      },
    );

    const detailFields = (row) => ({
      eventCount: row.eventCount,
      ...detailTokenFields(row),
      inputKnownCount: row.inputKnownCount,
      cachedKnownCount: row.cachedKnownCount,
      outputKnownCount: row.outputKnownCount,
      reasoningKnownCount: row.reasoningKnownCount,
      reconciliationGapCount: row.reconciliationGapCount,
    });
    const allDetails = {
      eventCount: 4,
      inputKnownTokens: 90,
      inputUnavailableTokens: 90,
      cachedKnownTokens: 25,
      cachedUnavailableTokens: 120,
      outputKnownTokens: 20,
      outputUnavailableTokens: 180,
      reasoningKnownTokens: 7,
      reasoningUnavailableTokens: 210,
      uncachedInput: 0,
      uncachedInputUnavailableTokens: 170,
      cacheRateInput: 10,
      cacheRateCached: 20,
      unattributedDetailTokens: 260,
      inconsistentTokens: 40,
      reconciliationGap: 40,
      inputKnownCount: 2,
      cachedKnownCount: 2,
      outputKnownCount: 1,
      reasoningKnownCount: 1,
      reconciliationGapCount: 1,
    };
    assert.deepEqual(detailFields(queryUsageRollups(db, { day: "2026-07-12" })), allDetails);
    assert.deepEqual(
      detailFields(queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" })),
      allDetails,
    );
    assert.deepEqual(
      detailFields(
        queryUsageRollupsRange(db, {
          startDay: "2026-07-12",
          endDay: "2026-07-12",
          excludeHomes: ["home-a"],
        }),
      ),
      {
        eventCount: 2,
        inputKnownTokens: 10,
        inputUnavailableTokens: 40,
        cachedKnownTokens: 20,
        cachedUnavailableTokens: 40,
        outputKnownTokens: 0,
        outputUnavailableTokens: 130,
        reasoningKnownTokens: 0,
        reasoningUnavailableTokens: 130,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 40,
        cacheRateInput: 10,
        cacheRateCached: 20,
        unattributedDetailTokens: 130,
        inconsistentTokens: 40,
        reconciliationGap: 40,
        inputKnownCount: 1,
        cachedKnownCount: 1,
        outputKnownCount: 0,
        reasoningKnownCount: 0,
        reconciliationGapCount: 1,
      },
    );
    assert.deepEqual(
      detailFields(
        queryUsageRollupsRange(db, {
          startDay: "2026-07-12",
          endDay: "2026-07-12",
          excludeHomes: ["home-b"],
        }),
      ),
      {
        eventCount: 2,
        inputKnownTokens: 80,
        inputUnavailableTokens: 50,
        cachedKnownTokens: 5,
        cachedUnavailableTokens: 80,
        outputKnownTokens: 20,
        outputUnavailableTokens: 50,
        reasoningKnownTokens: 7,
        reasoningUnavailableTokens: 80,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 130,
        cacheRateInput: 0,
        cacheRateCached: 0,
        unattributedDetailTokens: 130,
        inconsistentTokens: 0,
        reconciliationGap: 0,
        inputKnownCount: 1,
        cachedKnownCount: 1,
        outputKnownCount: 1,
        reasoningKnownCount: 1,
        reconciliationGapCount: 0,
      },
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("groups detail metrics by model for one complete UTC day", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO events
        (timestamp_ms, day_key, home_id, model, session_id, total, input, cached, output, reasoning, detail_mask, reconciliation_gap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      Date.parse("2026-07-12T02:00:00.000Z"),
      "2026-07-12",
      "home-a",
      "gpt-6-sol",
      "model-a",
      100,
      80,
      0,
      20,
      0,
      5,
      0,
    );
    insert.run(
      Date.parse("2026-07-12T03:00:00.000Z"),
      "2026-07-12",
      "home-b",
      "gpt-6-sol",
      "model-b",
      50,
      0,
      5,
      0,
      5,
      10,
      0,
    );
    insert.run(
      Date.parse("2026-07-12T04:00:00.000Z"),
      "2026-07-12",
      "home-a",
      "gpt-6-luna",
      "model-c",
      40,
      0,
      0,
      0,
      0,
      16,
      40,
    );
    const factsBefore = db.prepare("SELECT * FROM events ORDER BY timestamp_ms").all();
    const expected = [
      {
        model: "gpt-6-luna",
        total: 40,
        input: 0,
        inputUnavailableTokens: 40,
        cached: 0,
        cachedUnavailableTokens: 40,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 40,
        cacheRateInput: 0,
        cacheRateCached: 0,
        output: 0,
        outputUnavailableTokens: 40,
        reasoning: 0,
        reasoningUnavailableTokens: 40,
        unattributedDetailTokens: 40,
        inconsistentTokens: 40,
        reconciliationGap: 40,
      },
      {
        model: "gpt-6-sol",
        total: 150,
        input: 80,
        inputUnavailableTokens: 50,
        cached: 5,
        cachedUnavailableTokens: 100,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 150,
        cacheRateInput: 0,
        cacheRateCached: 0,
        output: 20,
        outputUnavailableTokens: 50,
        reasoning: 5,
        reasoningUnavailableTokens: 100,
        unattributedDetailTokens: 150,
        inconsistentTokens: 0,
        reconciliationGap: 0,
      },
    ];

    createUsageRollups(db);
    assert.equal(queryUsageRollupModels(db, { day: "2026-07-12" }), null);
    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(queryUsageRollupModels(db, { day: "2026-07-12" }), expected);
    assert.deepEqual(queryUsageRollupModels(db, { day: "2026-07-12", excludeHomes: ["home-a"] }), [
      {
        model: "gpt-6-sol",
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
      },
    ]);

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(queryUsageRollupModels(db, { day: "2026-07-12" }), expected);
    db.prepare("UPDATE usage_rollup_format SET format_version = 6").run();
    assert.equal(queryUsageRollupModels(db, { day: "2026-07-12" }), null);
    assert.deepEqual(db.prepare("SELECT * FROM events ORDER BY timestamp_ms").all(), factsBefore);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("aggregates model detail metrics across complete UTC days", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO events
        (timestamp_ms, day_key, home_id, model, session_id, total, input, cached, output, reasoning, detail_mask, reconciliation_gap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const events = [
      ["2026-07-12T02:00:00.000Z", "2026-07-12", "home-a", "gpt-6-sol", 100, 80, 0, 20, 0, 5, 0],
      ["2026-07-12T03:00:00.000Z", "2026-07-12", "home-b", "gpt-6-sol", 50, 0, 5, 0, 5, 10, 0],
      ["2026-07-12T04:00:00.000Z", "2026-07-12", "home-a", "gpt-6-luna", 40, 0, 0, 0, 0, 16, 40],
      ["2026-07-13T02:00:00.000Z", "2026-07-13", "home-a", "gpt-6-sol", 30, 10, 3, 17, 2, 15, 0],
      ["2026-07-13T03:00:00.000Z", "2026-07-13", "home-c", "gpt-6-luna", 20, 0, 0, 0, 0, 0, 0],
    ];
    for (const [timestamp, day, home, model, ...counts] of events) {
      insert.run(Date.parse(timestamp), day, home, model, `session-${timestamp}`, ...counts);
    }

    createUsageRollups(db);
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] });

    assert.deepEqual(queryUsageRollupModelsRange(db, { startDay: "2026-07-12", endDay: "2026-07-13" }), [
      {
        model: "gpt-6-luna",
        total: 60,
        input: 0,
        inputUnavailableTokens: 60,
        cached: 0,
        cachedUnavailableTokens: 60,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 60,
        cacheRateInput: 0,
        cacheRateCached: 0,
        output: 0,
        outputUnavailableTokens: 60,
        reasoning: 0,
        reasoningUnavailableTokens: 60,
        unattributedDetailTokens: 60,
        inconsistentTokens: 40,
        reconciliationGap: 40,
      },
      {
        model: "gpt-6-sol",
        total: 180,
        input: 90,
        inputUnavailableTokens: 50,
        cached: 8,
        cachedUnavailableTokens: 100,
        uncachedInput: 7,
        uncachedInputUnavailableTokens: 150,
        cacheRateInput: 10,
        cacheRateCached: 3,
        output: 37,
        outputUnavailableTokens: 50,
        reasoning: 7,
        reasoningUnavailableTokens: 100,
        unattributedDetailTokens: 150,
        inconsistentTokens: 0,
        reconciliationGap: 0,
      },
    ]);
    assert.deepEqual(
      queryUsageRollupModelsRange(db, {
        startDay: "2026-07-12",
        endDay: "2026-07-13",
        excludeHomes: ["home-a"],
      }),
      [
        {
          model: "gpt-6-luna",
          total: 20,
          input: 0,
          inputUnavailableTokens: 20,
          cached: 0,
          cachedUnavailableTokens: 20,
          uncachedInput: 0,
          uncachedInputUnavailableTokens: 20,
          cacheRateInput: 0,
          cacheRateCached: 0,
          output: 0,
          outputUnavailableTokens: 20,
          reasoning: 0,
          reasoningUnavailableTokens: 20,
          unattributedDetailTokens: 20,
          inconsistentTokens: 0,
          reconciliationGap: 0,
        },
        {
          model: "gpt-6-sol",
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
        },
      ],
    );

    let missingRange;
    assert.throws(
      () => {
        missingRange = queryUsageRollupModelsRange(db, {
          startDay: "2026-07-12",
          endDay: "2026-07-14",
        });
      },
      (error) => {
        assert.equal(error.code, "ROLLUP_DAYS_MISSING");
        assert.deepEqual(error.missingDays, ["2026-07-14"]);
        return true;
      },
    );
    assert.equal(missingRange, undefined);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads model metrics across partial, complete, and boundary UTC windows", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO events
        (timestamp_ms, day_key, home_id, model, session_id, total, input, cached, output, reasoning, detail_mask, reconciliation_gap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const events = [
      ["2026-07-12T11:59:59.999Z", "2026-07-12", "home-a", "gpt-6-sol", 100, 80, 20, 20, 5, 15, 0],
      ["2026-07-12T12:00:00.000Z", "2026-07-12", "home-a", "gpt-6-sol", 10, 6, 0, 4, 0, 5, 0],
      ["2026-07-12T23:59:59.999Z", "2026-07-12", "home-b", "gpt-6-luna", 20, 0, 5, 0, 2, 10, 0],
      ["2026-07-13T00:00:00.000Z", "2026-07-13", "home-a", "gpt-6-luna", 30, 12, 4, 0, 0, 3, 3],
      ["2026-07-13T12:00:00.000Z", "2026-07-13", "home-b", "gpt-6-sol", 40, 20, 10, 20, 5, 15, 0],
      ["2026-07-13T23:59:59.999Z", "2026-07-13", "home-a", "gpt-6-sol", 50, 0, 0, 10, 0, 4, 0],
      ["2026-07-14T00:00:00.000Z", "2026-07-14", "home-b", "gpt-6-luna", 60, 0, 0, 0, 0, 0, 0],
      ["2026-07-14T01:59:59.999Z", "2026-07-14", "home-a", "gpt-6-sol", 70, 40, 10, 30, 5, 15, 0],
      ["2026-07-14T02:00:00.000Z", "2026-07-14", "home-b", "gpt-6-sol", 80, 50, 10, 30, 5, 15, 0],
    ];
    for (const [timestamp, day, home, model, ...counts] of events) {
      insert.run(Date.parse(timestamp), day, home, model, `window-${timestamp}-${home}`, ...counts);
    }
    createUsageRollups(db);
    rebuildUsageRollups(db, { days: ["2026-07-13"] });

    const raw = (startMs, endMs, excludeHomes = []) => {
      const homeFilter =
        excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
      return db
        .prepare(`
          SELECT model,
            COALESCE(SUM(total), 0) AS total,
            COALESCE(SUM(CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END), 0) AS input,
            COALESCE(SUM(CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END), 0) AS input_unavailable_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END), 0) AS cached,
            COALESCE(SUM(CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END), 0) AS cached_unavailable_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END), 0) AS uncached_input_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END), 0) AS uncached_input_unavailable_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END), 0) AS cache_rate_input_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END), 0) AS cache_rate_cached_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END), 0) AS output,
            COALESCE(SUM(CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END), 0) AS output_unavailable_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END), 0) AS reasoning,
            COALESCE(SUM(CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END), 0) AS reasoning_unavailable_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END), 0) AS unattributed_detail_tokens,
            COALESCE(SUM(CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END), 0) AS inconsistent_tokens,
            COALESCE(SUM(reconciliation_gap), 0) AS reconciliation_gap_tokens
          FROM events
          WHERE timestamp_ms >= ? AND timestamp_ms < ? ${homeFilter}
          GROUP BY model
          ORDER BY model ASC
        `)
        .all(startMs, endMs, ...excludeHomes)
        .map((row) => ({
          model: String(row.model),
          total: Number(row.total),
          input: Number(row.input),
          inputUnavailableTokens: Number(row.input_unavailable_tokens),
          cached: Number(row.cached),
          cachedUnavailableTokens: Number(row.cached_unavailable_tokens),
          uncachedInput: Number(row.uncached_input_tokens),
          uncachedInputUnavailableTokens: Number(row.uncached_input_unavailable_tokens),
          cacheRateInput: Number(row.cache_rate_input_tokens),
          cacheRateCached: Number(row.cache_rate_cached_tokens),
          output: Number(row.output),
          outputUnavailableTokens: Number(row.output_unavailable_tokens),
          reasoning: Number(row.reasoning),
          reasoningUnavailableTokens: Number(row.reasoning_unavailable_tokens),
          unattributedDetailTokens: Number(row.unattributed_detail_tokens),
          inconsistentTokens: Number(row.inconsistent_tokens),
          reconciliationGap: Number(row.reconciliation_gap_tokens),
        }));
    };
    const startMs = Date.parse("2026-07-12T12:00:00.000Z");
    const endMs = Date.parse("2026-07-14T02:00:00.000Z");
    const expected = raw(startMs, endMs);

    assert.deepEqual(
      queryUsageRollupModelsWindow(db, { startMs, endMs }).map(({ model }) => model),
      ["gpt-6-luna", "gpt-6-sol"],
    );
    assert.deepEqual(queryUsageRollupModelsWindow(db, { startMs, endMs }), expected);
    assert.deepEqual(
      queryUsageRollupModelsWindow(db, { startMs, endMs, excludeHomes: ["home-a"] }),
      raw(startMs, endMs, ["home-a"]),
    );

    const partialStart = Date.parse("2026-07-13T00:00:00.000Z");
    const partialEnd = Date.parse("2026-07-13T13:00:00.000Z");
    assert.deepEqual(
      queryUsageRollupModelsWindow(db, { startMs: partialStart, endMs: partialEnd }),
      raw(partialStart, partialEnd),
    );

    let missingWindow;
    assert.throws(
      () => {
        missingWindow = queryUsageRollupModelsWindow(db, {
          startMs,
          endMs: Date.parse("2026-07-15T02:00:00.000Z"),
        });
      },
      (error) => {
        assert.equal(error.code, "ROLLUP_DAYS_MISSING");
        assert.deepEqual(error.missingDays, ["2026-07-14"]);
        return true;
      },
    );
    assert.equal(missingWindow, undefined);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("model day, range, and window reads do not require a model grouping UDF", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO events
        (timestamp_ms, day_key, home_id, model, session_id, total, input, cached, output, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const events = [
      ["2026-07-12T13:00:00.000Z", "2026-07-12", "home-a", "model-a", 10, 8, 2, 3, 1],
      ["2026-07-13T01:00:00.000Z", "2026-07-13", "home-a", "model-a", 30, 20, 5, 6, 2],
      ["2026-07-13T12:00:00.000Z", "2026-07-13", "home-a", "model-b", 20, 15, 5, 5, 1],
    ];
    for (const [timestamp, day, home, model, ...counts] of events) {
      insert.run(Date.parse(timestamp), day, home, model, `${model}-${home}`, ...counts);
    }

    createUsageRollups(db);
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13", "2026-07-14"] });
    const models = (rows) => rows.map(({ model, total }) => ({ model, total }));
    assert.deepEqual(models(queryUsageRollupModels(db, { day: "2026-07-13" })), [
      { model: "model-a", total: 30 },
      { model: "model-b", total: 20 },
    ]);
    assert.deepEqual(models(queryUsageRollupModelsRange(db, { startDay: "2026-07-12", endDay: "2026-07-13" })), [
      { model: "model-a", total: 40 },
      { model: "model-b", total: 20 },
    ]);
    assert.deepEqual(
      models(
        queryUsageRollupModelsWindow(db, {
          startMs: Date.parse("2026-07-12T12:00:00.000Z"),
          endMs: Date.parse("2026-07-14T02:00:00.000Z"),
        }),
      ),
      [
        { model: "model-a", total: 40 },
        { model: "model-b", total: 20 },
      ],
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Store rollup model reads canonicalize aliases through its model grouping UDF", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-canonical-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const events = [
    ["gpt-6.1-sol", "2026-07-12T12:00:00.000Z", 1, 1, 0, 0, 0],
    ["deepseek-v4.1-flash", "2026-07-13T12:00:00.000Z", 10, 8, 2, 3, 1],
    ["opendesign/deepseek-v4.1-flash", "2026-07-13T12:00:00.000Z", 20, 15, 5, 5, 2],
    ["deepseek-flash", "2026-07-13T12:00:00.000Z", 30, 22, 8, 7, 3],
    ["gpt-6.1-sol", "2026-07-14T12:00:00.000Z", 1, 1, 0, 0, 0],
  ].map(([model, timestamp, total, input, cached, output, reasoning]) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: projectRoot,
    cwd: projectRoot,
    session_id: "canonical-session",
    model,
    usage: { total, input, cached, output, reasoning },
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
    rebuildUsageRollups(store.database, { days: ["2026-07-13"] });
    const start = new Date("2026-07-12T00:00:00.000Z");
    const end = new Date("2026-07-14T23:59:59.999Z");
    const range = { calendarZone: "utc", start, end };
    const ranges = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, { ...range, preset: key }]));
    const prepare = store.database.prepare;
    let modelRollupReads = 0;
    store.database.prepare = function prepareWithRollupCount(sql) {
      if (String(sql).includes("FROM usage_rollup_models")) modelRollupReads += 1;
      return prepare.call(this, sql);
    };
    let rows;
    try {
      rows = store.periodAggregate("model", "model", new Date("2026-07-13T12:00:00.000Z"), ranges, {
        pricingModels: PRICING_MODELS_A,
      });
    } finally {
      store.database.prepare = prepare;
    }
    assert.ok(modelRollupReads > 0);
    assert.deepEqual(
      rows.map(({ name, periods }) => ({ name, total: periods.all.total })),
      [
        { name: "deepseek-flash", total: 60 },
        { name: "gpt-6.1-sol", total: 2 },
      ],
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("rejects old rollup markers until the current format is rebuilt", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const timestamp = Date.parse("2026-07-12T02:00:00.000Z");
    db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(timestamp, "2026-07-12", "home-a", "legacy-session", 10, 7, 2, 3, 1);
    db.exec(`
      CREATE TABLE usage_rollup_days (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key)
      ) STRICT;
      CREATE TABLE usage_rollup_daily (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (calendar_zone, day_key, home_id)
      ) STRICT;
      INSERT INTO usage_rollup_days (calendar_zone, day_key, start_ms, end_ms)
      VALUES ('utc', '2026-07-12', ${Date.UTC(2026, 6, 12)}, ${Date.UTC(2026, 6, 13)});
      INSERT INTO usage_rollup_daily
        (calendar_zone, day_key, home_id, event_count, total, input, cached, output, reasoning)
      VALUES ('utc', '2026-07-12', 'home-a', 1, 10, 7, 2, 3, 1);
    `);
    const factsBefore = db.prepare("SELECT * FROM events ORDER BY timestamp_ms").all();

    assert.equal(queryUsageRollups(db, { day: "2026-07-12" }), null);
    assert.throws(
      () => queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" }),
      (error) => {
        assert.equal(error.code, "ROLLUP_DAYS_MISSING");
        assert.deepEqual(error.missingDays, ["2026-07-12"]);
        return true;
      },
    );

    db.exec(`
      CREATE TABLE usage_rollup_format (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO usage_rollup_format (id, format_version) VALUES (1, 999);
    `);
    assert.equal(queryUsageRollups(db, { day: "2026-07-12" }), null);

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 10,
      input: 7,
      cached: 2,
      output: 3,
      reasoning: 1,
      ...unavailableTokens(10),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
    assert.deepEqual(db.prepare("SELECT * FROM events ORDER BY timestamp_ms").all(), factsBefore);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("upgrades a real v2 cache to v7 without changing facts", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning, detail_mask, reconciliation_gap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "detail-a", 80, 80, 0, 20, 0, 5, 0);
    insert.run(Date.parse("2026-07-12T03:00:00.000Z"), "2026-07-12", "home-a", "detail-b", 50, 0, 5, 0, 5, 10, 0);
    insert.run(Date.parse("2026-07-12T04:00:00.000Z"), "2026-07-12", "home-b", "detail-c", 40, 0, 0, 0, 0, 16, 40);
    db.exec(`
      CREATE TABLE usage_rollup_format (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE usage_rollup_days (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key)
      ) STRICT;
      CREATE TABLE usage_rollup_daily (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key, home_id)
      ) STRICT;
      CREATE TABLE usage_rollup_sessions (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (calendar_zone, day_key, home_id, session_id)
      ) STRICT;
      CREATE TABLE usage_rollup_dirty_days (
        day_key TEXT NOT NULL PRIMARY KEY
      ) STRICT;
      CREATE TRIGGER usage_rollup_invalidate_insert
      AFTER INSERT ON events
      BEGIN
        INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key)
          VALUES (date(NEW.timestamp_ms / 1000.0, 'unixepoch'));
        DELETE FROM usage_rollup_days
        WHERE NEW.timestamp_ms >= start_ms AND NEW.timestamp_ms < end_ms;
      END;
      CREATE TRIGGER usage_rollup_invalidate_update
      AFTER UPDATE ON events
      BEGIN
        INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key)
          VALUES (date(OLD.timestamp_ms / 1000.0, 'unixepoch'));
        INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key)
          VALUES (date(NEW.timestamp_ms / 1000.0, 'unixepoch'));
        DELETE FROM usage_rollup_days
        WHERE (OLD.timestamp_ms >= start_ms AND OLD.timestamp_ms < end_ms)
           OR (NEW.timestamp_ms >= start_ms AND NEW.timestamp_ms < end_ms);
      END;
      CREATE TRIGGER usage_rollup_invalidate_delete
      AFTER DELETE ON events
      BEGIN
        INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key)
          VALUES (date(OLD.timestamp_ms / 1000.0, 'unixepoch'));
        DELETE FROM usage_rollup_days
        WHERE OLD.timestamp_ms >= start_ms AND OLD.timestamp_ms < end_ms;
      END;
      INSERT INTO usage_rollup_format (id, format_version) VALUES (1, 2);
      INSERT INTO usage_rollup_days (calendar_zone, day_key, start_ms, end_ms)
        VALUES ('utc', '2026-07-12', ${Date.UTC(2026, 6, 12)}, ${Date.UTC(2026, 6, 13)});
      INSERT INTO usage_rollup_daily
        (calendar_zone, day_key, home_id, event_count, total, input, cached, output, reasoning)
        VALUES ('utc', '2026-07-12', 'home-a', 99, 999, 0, 0, 0, 0);
    `);
    const factsBefore = db.prepare("SELECT * FROM events ORDER BY timestamp_ms").all();

    assert.equal(queryUsageRollups(db, { day: "2026-07-12" }), null);

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    const rebuilt = queryUsageRollups(db, { day: "2026-07-12" });
    assert.deepEqual(
      {
        facts: db.prepare("SELECT * FROM events ORDER BY timestamp_ms").all(),
        rollup: rebuilt,
      },
      {
        facts: factsBefore,
        rollup: {
          day: "2026-07-12",
          eventCount: 3,
          sessionCount: 3,
          homeCount: 2,
          total: 170,
          input: 80,
          cached: 5,
          output: 20,
          reasoning: 5,
          inputKnownTokens: 80,
          inputUnavailableTokens: 90,
          cachedKnownTokens: 5,
          cachedUnavailableTokens: 120,
          outputKnownTokens: 20,
          outputUnavailableTokens: 90,
          reasoningKnownTokens: 5,
          reasoningUnavailableTokens: 120,
          uncachedInput: 0,
          uncachedInputUnavailableTokens: 170,
          cacheRateInput: 0,
          cacheRateCached: 0,
          unattributedDetailTokens: 170,
          inconsistentTokens: 40,
          reconciliationGap: 40,
          inputKnownCount: 1,
          cachedKnownCount: 1,
          outputKnownCount: 1,
          reasoningKnownCount: 1,
          reconciliationGapCount: 1,
        },
      },
    );

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-12" }), rebuilt);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("joins an outer transaction and rolls back facts with the cache", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "outer-session", 10, 7, 2, 3, 1);
    rebuildUsageRollups(db, { days: ["2026-07-12"] });

    db.exec("BEGIN");
    db.prepare(
      "UPDATE events SET total = 20, input = 15, cached = 5, output = 5, reasoning = 2 WHERE session_id = ?",
    ).run("outer-session");
    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.equal(queryUsageRollups(db, { day: "2026-07-12" }).total, 20);
    db.exec("ROLLBACK");

    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 10,
      input: 7,
      cached: 2,
      output: 3,
      reasoning: 1,
      ...unavailableTokens(10),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
    assert.equal(db.prepare("SELECT total FROM events WHERE session_id = ?").get("outer-session").total, 10);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the outer transaction usable when format upgrade fails", async () => {
  const { db, directory } = await openEventsDatabase();
  const prepare = db.prepare;
  try {
    db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "upgrade-session", 10, 7, 2, 3, 1);
    db.exec(`
      CREATE TABLE usage_rollup_days (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key)
      ) STRICT;
      INSERT INTO usage_rollup_days (calendar_zone, day_key, start_ms, end_ms)
      VALUES ('utc', '2026-07-12', ${Date.UTC(2026, 6, 12)}, ${Date.UTC(2026, 6, 13)});
      CREATE TABLE usage_rollup_format (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO usage_rollup_format (id, format_version) VALUES (1, 999);
    `);

    db.exec("BEGIN");
    let injected = false;
    db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (!injected && sql.includes("INSERT INTO usage_rollup_daily")) {
        injected = true;
        db.exec(`
          CREATE TRIGGER fail_format_upgrade
          BEFORE INSERT ON usage_rollup_daily
          BEGIN
            SELECT RAISE(ABORT, 'injected format upgrade failure');
          END
        `);
      }
      return statement;
    };
    assert.throws(() => rebuildUsageRollups(db, { days: ["2026-07-12"] }), /injected format upgrade failure/);
    db.prepare = prepare;
    assert.equal(injected, true);
    assert.equal(db.prepare("SELECT format_version FROM usage_rollup_format").get().format_version, 999);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_rollup_days").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    assert.equal(db.prepare("SELECT 1 AS usable").get().usable, 1);
    db.exec("ROLLBACK");
  } finally {
    db.prepare = prepare;
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rebuilds moved UTC days without duplicating the event", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const oldTimestamp = Date.parse("2026-07-12T02:00:00.000Z");
    insert.run(oldTimestamp, "2026-07-12", "home-a", "session-moved", 10, 7, 2, 3, 1);
    createUsageRollups(db);
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] });
    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-13" }), {
      day: "2026-07-13",
      eventCount: 0,
      sessionCount: 0,
      homeCount: 0,
      total: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      ...unavailableTokens(0),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });

    db.prepare(`
      UPDATE events
      SET timestamp_ms = ?, day_key = ?, total = ?, input = ?, cached = ?, output = ?, reasoning = ?
      WHERE timestamp_ms = ?
    `).run(Date.parse("2026-07-13T02:00:00.000Z"), "2026-07-13", 40, 30, 5, 8, 2, oldTimestamp);
    rebuildUsageRollups(db, {
      days: ["2026-07-12", "2026-07-13", "2026-07-12"],
    });

    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 0,
      sessionCount: 0,
      homeCount: 0,
      total: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      ...unavailableTokens(0),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-13" }), {
      day: "2026-07-13",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 40,
      input: 30,
      cached: 5,
      output: 8,
      reasoning: 2,
      ...unavailableTokens(40),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back every affected UTC day when one rebuild fails", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const oldTimestamp = Date.parse("2026-07-12T02:00:00.000Z");
    insert.run(oldTimestamp, "2026-07-12", "home-a", "session-a", 10, 7, 2, 3, 1);
    insert.run(Date.parse("2026-07-13T02:00:00.000Z"), "2026-07-13", "home-a", "session-b", 20, 15, 5, 5, 2);
    createUsageRollups(db);
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] });
    db.prepare(`
      UPDATE events
      SET timestamp_ms = ?, day_key = ?, total = ?, input = ?, cached = ?, output = ?, reasoning = ?
      WHERE timestamp_ms = ?
    `).run(Date.parse("2026-07-13T03:00:00.000Z"), "2026-07-13", 40, 30, 5, 8, 2, oldTimestamp);
    db.exec(`
      CREATE TEMP TRIGGER fail_rollup_b
      BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.day_key = '2026-07-13'
      BEGIN
        SELECT RAISE(ABORT, 'injected rollup B failure');
      END
    `);

    assert.throws(() => rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] }), /injected rollup B failure/);
    assert.equal(queryUsageRollups(db, { day: "2026-07-12" }), null);
    assert.equal(queryUsageRollups(db, { day: "2026-07-13" }), null);
    db.exec("DROP TRIGGER fail_rollup_b");
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] });
    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 0,
      sessionCount: 0,
      homeCount: 0,
      total: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      ...unavailableTokens(0),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
    assert.deepEqual(queryUsageRollups(db, { day: "2026-07-13" }), {
      day: "2026-07-13",
      eventCount: 2,
      sessionCount: 2,
      homeCount: 1,
      total: 60,
      input: 45,
      cached: 10,
      output: 13,
      reasoning: 4,
      ...unavailableTokens(60),
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
    });
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queries a complete UTC day range against UsageStore totals", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-store-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const events = [
    ["2026-07-12T02:00:00.000Z", 10, 7, 2, 3, 1],
    ["2026-07-13T02:00:00.000Z", 20, 15, 5, 5, 2],
  ].map(([timestamp, total, input, cached, output, reasoning]) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/rollup",
    cwd: "/work/rollup",
    session_id: "rollup-session",
    model: "gpt-6-sol",
    usage: { total, input, cached, output, reasoning },
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
    const expected = store.summarize({
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-13",
      bucket: "day",
      calendarZone: "utc",
    });
    rebuildUsageRollups(store.database, { days: ["2026-07-12"] });
    rebuildUsageRollups(store.database, { days: ["2026-07-13"] });

    assert.deepEqual(queryUsageRollupsRange(store.database, { startDay: "2026-07-12", endDay: "2026-07-13" }), {
      startDay: "2026-07-12",
      endDay: "2026-07-13",
      eventCount: expected.eventCount,
      sessionCount: expected.sessionCount,
      homeCount: expected.homeCount,
      ...expected.totals,
      inputKnownTokens: 22,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 7,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 8,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 3,
      reasoningUnavailableTokens: 0,
      uncachedInput: 15,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 22,
      cacheRateCached: 7,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 2,
      cachedKnownCount: 2,
      outputKnownCount: 2,
      reasoningKnownCount: 2,
      reconciliationGapCount: 0,
    });
    assert.throws(
      () =>
        queryUsageRollupsRange(store.database, {
          startDay: "2026-07-12",
          endDay: "2026-07-14",
        }),
      (error) => {
        assert.equal(error.code, "ROLLUP_DAYS_MISSING");
        assert.deepEqual(error.missingDays, ["2026-07-14"]);
        return true;
      },
    );
    assert.throws(
      () => queryUsageRollupsRange(store.database, { startDay: "2026-07-13", endDay: "2026-07-12" }),
      /startDay must not be after endDay/,
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("range query filters homes and keeps empty built days complete", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-homes-"));
  const projectRoots = [path.join(homeDir, "log-a"), path.join(homeDir, "log-b")];
  const events = [
    ["log-a", "2026-07-12T02:00:00.000Z", 10, 7, 2, 3, 1],
    ["log-b", "2026-07-13T03:00:00.000Z", 20, 15, 5, 5, 2],
  ].map(([_home, timestamp, total, input, cached, output, reasoning]) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/rollup",
    cwd: "/work/rollup",
    session_id: "home-shared-session",
    model: "gpt-6-sol",
    usage: { total, input, cached, output, reasoning },
  }));
  for (const [index, projectRoot] of projectRoots.entries()) {
    const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(usageFile, `${JSON.stringify(events[index])}\n`);
  }
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: projectRoots,
  });

  try {
    await store.sync();
    const excludedHome = store.homes[0].id;
    const expected = store.summarize({
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-14",
      bucket: "day",
      calendarZone: "utc",
      excludeHomes: [excludedHome],
    });
    const allHomes = store.summarize({
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-14",
      bucket: "day",
      calendarZone: "utc",
    });
    const aggregate = (excludeHomes = []) =>
      store.aggregateRange(
        {
          start: new Date(Date.UTC(2026, 6, 12)),
          end: new Date(Date.UTC(2026, 6, 14) - 1),
        },
        excludeHomes,
      );
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13", "2026-07-14"] });

    const allHomesRow = aggregate();
    assert.deepEqual(queryUsageRollupsRange(store.database, { startDay: "2026-07-12", endDay: "2026-07-14" }), {
      startDay: "2026-07-12",
      endDay: "2026-07-14",
      eventCount: Number(allHomesRow.event_count),
      sessionCount: Number(allHomesRow.session_count),
      homeCount: Number(allHomesRow.home_count),
      total: Number(allHomesRow.total),
      input: Number(allHomesRow.input),
      cached: Number(allHomesRow.cached),
      output: Number(allHomesRow.output),
      reasoning: Number(allHomesRow.reasoning),
      inputKnownTokens: 22,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 7,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 8,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 3,
      reasoningUnavailableTokens: 0,
      uncachedInput: 15,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 22,
      cacheRateCached: 7,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 2,
      cachedKnownCount: 2,
      outputKnownCount: 2,
      reasoningKnownCount: 2,
      reconciliationGapCount: 0,
    });
    assert.deepEqual(queryUsageRollups(store.database, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 10,
      input: 7,
      cached: 2,
      output: 3,
      reasoning: 1,
      inputKnownTokens: 7,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 2,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 3,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 1,
      reasoningUnavailableTokens: 0,
      uncachedInput: 5,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 7,
      cacheRateCached: 2,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 1,
      cachedKnownCount: 1,
      outputKnownCount: 1,
      reasoningKnownCount: 1,
      reconciliationGapCount: 0,
    });
    assert.deepEqual(
      queryUsageRollupsRange(store.database, {
        startDay: "2026-07-12",
        endDay: "2026-07-14",
        excludeHomes: [excludedHome],
      }),
      {
        startDay: "2026-07-12",
        endDay: "2026-07-14",
        eventCount: expected.eventCount,
        sessionCount: expected.sessionCount,
        homeCount: expected.homeCount,
        ...expected.totals,
        inputKnownTokens: 15,
        inputUnavailableTokens: 0,
        cachedKnownTokens: 5,
        cachedUnavailableTokens: 0,
        outputKnownTokens: 5,
        outputUnavailableTokens: 0,
        reasoningKnownTokens: 2,
        reasoningUnavailableTokens: 0,
        uncachedInput: 10,
        uncachedInputUnavailableTokens: 0,
        cacheRateInput: 15,
        cacheRateCached: 5,
        unattributedDetailTokens: 0,
        inconsistentTokens: 0,
        reconciliationGap: 0,
        inputKnownCount: 1,
        cachedKnownCount: 1,
        outputKnownCount: 1,
        reasoningKnownCount: 1,
        reconciliationGapCount: 0,
      },
    );
    assert.deepEqual(
      queryUsageRollupsRange(store.database, {
        startDay: "2026-07-12",
        endDay: "2026-07-14",
        excludeHomes: store.homes.map((home) => home.id),
      }),
      {
        startDay: "2026-07-12",
        endDay: "2026-07-14",
        eventCount: 0,
        sessionCount: 0,
        homeCount: 0,
        total: 0,
        input: 0,
        cached: 0,
        output: 0,
        reasoning: 0,
        ...unavailableTokens(0),
        inputKnownCount: 0,
        cachedKnownCount: 0,
        outputKnownCount: 0,
        reasoningKnownCount: 0,
        reconciliationGapCount: 0,
      },
    );
    assert.deepEqual(
      queryUsageRollupsRange(store.database, {
        startDay: "2026-07-12",
        endDay: "2026-07-14",
      }),
      {
        startDay: "2026-07-12",
        endDay: "2026-07-14",
        eventCount: allHomes.eventCount,
        sessionCount: allHomes.sessionCount,
        homeCount: allHomes.homeCount,
        ...allHomes.totals,
        inputKnownTokens: 22,
        inputUnavailableTokens: 0,
        cachedKnownTokens: 7,
        cachedUnavailableTokens: 0,
        outputKnownTokens: 8,
        outputUnavailableTokens: 0,
        reasoningKnownTokens: 3,
        reasoningUnavailableTokens: 0,
        uncachedInput: 15,
        uncachedInputUnavailableTokens: 0,
        cacheRateInput: 22,
        cacheRateCached: 7,
        unattributedDetailTokens: 0,
        inconsistentTokens: 0,
        reconciliationGap: 0,
        inputKnownCount: 2,
        cachedKnownCount: 2,
        outputKnownCount: 2,
        reasoningKnownCount: 2,
        reconciliationGapCount: 0,
      },
    );
    for (const excluded of [[excludedHome], store.homes.map((home) => home.id)]) {
      const row = aggregate(excluded);
      assert.deepEqual(
        queryUsageRollupsRange(store.database, {
          startDay: "2026-07-12",
          endDay: "2026-07-14",
          excludeHomes: excluded,
        }),
        {
          startDay: "2026-07-12",
          endDay: "2026-07-14",
          eventCount: Number(row.event_count),
          sessionCount: Number(row.session_count),
          homeCount: Number(row.home_count),
          total: Number(row.total),
          input: Number(row.input),
          cached: Number(row.cached),
          output: Number(row.output),
          reasoning: Number(row.reasoning),
          inputKnownTokens: excluded.length === 0 ? 22 : excluded.length === 1 ? 15 : 0,
          inputUnavailableTokens: 0,
          cachedKnownTokens: excluded.length === 0 ? 7 : excluded.length === 1 ? 5 : 0,
          cachedUnavailableTokens: 0,
          outputKnownTokens: excluded.length === 0 ? 8 : excluded.length === 1 ? 5 : 0,
          outputUnavailableTokens: 0,
          reasoningKnownTokens: excluded.length === 0 ? 3 : excluded.length === 1 ? 2 : 0,
          reasoningUnavailableTokens: 0,
          uncachedInput: excluded.length === 0 ? 15 : excluded.length === 1 ? 10 : 0,
          uncachedInputUnavailableTokens: 0,
          cacheRateInput: excluded.length === 0 ? 22 : excluded.length === 1 ? 15 : 0,
          cacheRateCached: excluded.length === 0 ? 7 : excluded.length === 1 ? 5 : 0,
          unattributedDetailTokens: 0,
          inconsistentTokens: 0,
          reconciliationGap: 0,
          inputKnownCount: excluded.length === 0 ? 2 : excluded.length === 1 ? 1 : 0,
          cachedKnownCount: excluded.length === 0 ? 2 : excluded.length === 1 ? 1 : 0,
          outputKnownCount: excluded.length === 0 ? 2 : excluded.length === 1 ? 1 : 0,
          reasoningKnownCount: excluded.length === 0 ? 2 : excluded.length === 1 ? 1 : 0,
          reconciliationGapCount: 0,
        },
      );
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("fact changes invalidate built days until rebuilt", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-stale-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const usage = (timestamp, total, input, cached, output, reasoning) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/rollup",
    cwd: "/work/rollup",
    session_id: "stale-session",
    model: "gpt-6-sol",
    usage: { total, input, cached, output, reasoning },
  });
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${JSON.stringify(usage("2026-07-12T02:00:00.000Z", 10, 7, 2, 3, 1))}\n`);
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: [projectRoot],
  });

  try {
    await store.sync();
    rebuildUsageRollups(store.database, { days: ["2026-07-12"] });
    const firstTimestamp = store.database.prepare("SELECT timestamp_ms FROM events").get().timestamp_ms;

    store.database.exec("SAVEPOINT stale_update");
    store.database
      .prepare(`
        UPDATE events
        SET timestamp_ms = ?, total = 20, input = 15, cached = 5, output = 5, reasoning = 2
        WHERE timestamp_ms = ?
      `)
      .run(Date.parse("2026-07-13T02:00:00.000Z"), firstTimestamp);
    store.database.exec("ROLLBACK TO stale_update; RELEASE stale_update");

    assert.deepEqual(queryUsageRollups(store.database, { day: "2026-07-12" }), {
      day: "2026-07-12",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 10,
      input: 7,
      cached: 2,
      output: 3,
      reasoning: 1,
      inputKnownTokens: 7,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 2,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 3,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 1,
      reasoningUnavailableTokens: 0,
      uncachedInput: 5,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 7,
      cacheRateCached: 2,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 1,
      cachedKnownCount: 1,
      outputKnownCount: 1,
      reasoningKnownCount: 1,
      reconciliationGapCount: 0,
    });

    store.database
      .prepare(`
        UPDATE events
        SET timestamp_ms = ?, total = 20, input = 15, cached = 5, output = 5, reasoning = 2
        WHERE timestamp_ms = ?
      `)
      .run(Date.parse("2026-07-13T02:00:00.000Z"), firstTimestamp);

    assert.throws(
      () => queryUsageRollupsRange(store.database, { startDay: "2026-07-12", endDay: "2026-07-13" }),
      (error) => {
        assert.equal(error.code, "ROLLUP_DAYS_MISSING");
        assert.deepEqual(error.missingDays, ["2026-07-12", "2026-07-13"]);
        return true;
      },
    );
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    assert.deepEqual(queryUsageRollupsRange(store.database, { startDay: "2026-07-12", endDay: "2026-07-13" }), {
      startDay: "2026-07-12",
      endDay: "2026-07-13",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 20,
      input: 15,
      cached: 5,
      output: 5,
      reasoning: 2,
      inputKnownTokens: 15,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 5,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 5,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 2,
      reasoningUnavailableTokens: 0,
      uncachedInput: 10,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 15,
      cacheRateCached: 5,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 1,
      cachedKnownCount: 1,
      outputKnownCount: 1,
      reasoningKnownCount: 1,
      reconciliationGapCount: 0,
    });
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("range query holds one snapshot while another connection rebuilds a moved day", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-snapshot-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(
    usageFile,
    `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-07-12T02:00:00.000Z",
      source: "test",
      channel: "Test",
      project_root: "/work/rollup",
      cwd: "/work/rollup",
      session_id: "snapshot-session",
      model: "gpt-6-sol",
      usage: { total: 10, input: 7, cached: 2, output: 3, reasoning: 1 },
    })}\n`,
  );
  const store = new UsageStore({ homeDir, databaseFile, importDirs: [projectRoot] });
  let writer;

  try {
    await store.sync();
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    const oldTimestamp = store.database.prepare("SELECT timestamp_ms FROM events").get().timestamp_ms;
    writer = new DatabaseSync(databaseFile);
    writer.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");

    let interleaved = false;
    const reader = new Proxy(store.database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => {
            const statement = target.prepare(sql);
            if (!interleaved && sql.includes("SELECT day_key, start_ms, end_ms FROM usage_rollup_days")) {
              return {
                all(...args) {
                  const rows = statement.all(...args);
                  interleaved = true;
                  writer
                    .prepare(`
                      UPDATE events
                      SET timestamp_ms = ?, day_key = ?, total = 40, input = 30,
                          cached = 5, output = 8, reasoning = 2
                      WHERE timestamp_ms = ?
                    `)
                    .run(Date.parse("2026-07-13T02:00:00.000Z"), "2026-07-13", oldTimestamp);
                  rebuildUsageRollups(writer, { days: ["2026-07-13"] });
                  return rows;
                },
              };
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    assert.deepEqual(queryUsageRollupsRange(reader, { startDay: "2026-07-12", endDay: "2026-07-13" }), {
      startDay: "2026-07-12",
      endDay: "2026-07-13",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 10,
      input: 7,
      cached: 2,
      output: 3,
      reasoning: 1,
      inputKnownTokens: 7,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 2,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 3,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 1,
      reasoningUnavailableTokens: 0,
      uncachedInput: 5,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 7,
      cacheRateCached: 2,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 1,
      cachedKnownCount: 1,
      outputKnownCount: 1,
      reasoningKnownCount: 1,
      reconciliationGapCount: 0,
    });
    assert.equal(interleaved, true);
    assert.equal(queryUsageRollups(writer, { day: "2026-07-12" }), null);
    assert.deepEqual(queryUsageRollups(writer, { day: "2026-07-13" }), {
      day: "2026-07-13",
      eventCount: 1,
      sessionCount: 1,
      homeCount: 1,
      total: 40,
      input: 30,
      cached: 5,
      output: 8,
      reasoning: 2,
      inputKnownTokens: 30,
      inputUnavailableTokens: 0,
      cachedKnownTokens: 5,
      cachedUnavailableTokens: 0,
      outputKnownTokens: 8,
      outputUnavailableTokens: 0,
      reasoningKnownTokens: 2,
      reasoningUnavailableTokens: 0,
      uncachedInput: 25,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 30,
      cacheRateCached: 5,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 1,
      cachedKnownCount: 1,
      outputKnownCount: 1,
      reasoningKnownCount: 1,
      reconciliationGapCount: 0,
    });
  } finally {
    writer?.close();
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("model window keeps complete-day and raw-edge values on one snapshot", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-window-snapshot-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  await mkdir(path.dirname(usageFile), { recursive: true });

  const events = [
    ["2026-07-12T13:00:00.000Z", "snapshot-left", { total: 20, input: 15, cached: 5, output: 5, reasoning: 2 }],
    ["2026-07-13T12:00:00.000Z", "snapshot-complete", { total: 10, input: 7, cached: 2, output: 3, reasoning: 1 }],
    ["2026-07-14T01:00:00.000Z", "snapshot-right", { total: 30, input: 20, cached: 10, output: 10, reasoning: 3 }],
  ];
  await writeFile(
    usageFile,
    events
      .map(([timestamp, session_id, usage]) =>
        JSON.stringify({
          schema_version: "codex-usage.project-log.v1",
          timestamp,
          source: "test",
          channel: "Test",
          project_root: "/work/rollup",
          cwd: "/work/rollup",
          session_id,
          model: "gpt-6-sol",
          usage,
        }),
      )
      .join("\n")
      .concat("\n"),
  );
  const store = new UsageStore({ homeDir, databaseFile, importDirs: [projectRoot] });
  let writer;

  try {
    await store.sync();
    rebuildUsageRollups(store.database, { days: ["2026-07-13"] });
    writer = new DatabaseSync(databaseFile);
    writer.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");

    let interleaved = false;
    const reader = new Proxy(store.database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => {
            const statement = target.prepare(sql);
            if (!interleaved && sql.includes("FROM usage_rollup_models")) {
              return {
                all(...args) {
                  const rows = statement.all(...args);
                  interleaved = true;
                  const update = writer.prepare(`
                    UPDATE events
                    SET total = ?, input = ?, cached = ?, output = ?, reasoning = ?
                    WHERE timestamp_ms = ?
                  `);
                  update.run(200, 150, 50, 50, 20, Date.parse("2026-07-12T13:00:00.000Z"));
                  update.run(100, 70, 20, 30, 10, Date.parse("2026-07-13T12:00:00.000Z"));
                  update.run(300, 200, 100, 100, 30, Date.parse("2026-07-14T01:00:00.000Z"));
                  rebuildUsageRollups(writer, { days: ["2026-07-13"] });
                  return rows;
                },
              };
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const window = {
      startMs: Date.parse("2026-07-12T12:00:00.000Z"),
      endMs: Date.parse("2026-07-14T02:00:00.000Z"),
    };

    assert.deepEqual(queryUsageRollupModelsWindow(reader, window), [
      {
        model: "gpt-6-sol",
        total: 60,
        input: 42,
        inputUnavailableTokens: 0,
        cached: 17,
        cachedUnavailableTokens: 0,
        uncachedInput: 25,
        uncachedInputUnavailableTokens: 0,
        cacheRateInput: 42,
        cacheRateCached: 17,
        output: 18,
        outputUnavailableTokens: 0,
        reasoning: 6,
        reasoningUnavailableTokens: 0,
        unattributedDetailTokens: 0,
        inconsistentTokens: 0,
        reconciliationGap: 0,
      },
    ]);
    assert.deepEqual(queryUsageRollupModelsWindow(reader, window), [
      {
        model: "gpt-6-sol",
        total: 600,
        input: 420,
        inputUnavailableTokens: 0,
        cached: 170,
        cachedUnavailableTokens: 0,
        uncachedInput: 250,
        uncachedInputUnavailableTokens: 0,
        cacheRateInput: 420,
        cacheRateCached: 170,
        output: 180,
        outputUnavailableTokens: 0,
        reasoning: 60,
        reasoningUnavailableTokens: 0,
        unattributedDetailTokens: 0,
        inconsistentTokens: 0,
        reconciliationGap: 0,
      },
    ]);
    assert.equal(interleaved, true);
  } finally {
    writer?.close();
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("local markers reject a different process timezone until rebuilt", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-rollups-zone-transfer-"));
  const projectRoot = path.join(homeDir, "log-project");
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(
    usageFile,
    `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-07-12T23:30:00.000Z",
      source: "test",
      channel: "Test",
      project_root: "/work/rollup",
      cwd: "/work/rollup",
      session_id: "zone-transfer-session",
      model: "gpt-6-sol",
      usage: { total: 10, input: 7, cached: 2, output: 3, reasoning: 1 },
    })}\n`,
  );
  const setupScript = `
    import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
    import path from "node:path";
    import { UsageStore } from "./src/usage-store.js";
    import { queryUsageRollups, queryUsageRollupsRange, rebuildUsageRollups } from "./src/usage-rollups.js";

    const homeDir = process.env.ROLLUP_HOME;
    const projectRoot = process.env.ROLLUP_PROJECT;
    const store = new UsageStore({
      homeDir,
      databaseFile: process.env.ROLLUP_DB,
      importDirs: [projectRoot],
    });
    try {
      await store.sync();
      rebuildUsageRollups(store.database, { days: ["2026-07-12"], calendarZone: "utc" });
      rebuildUsageRollups(store.database, { days: ["2026-07-13"], calendarZone: "local" });
      const utc = queryUsageRollups(store.database, { day: "2026-07-12", calendarZone: "utc" });
      const local = queryUsageRollups(store.database, { day: "2026-07-13", calendarZone: "local" });
      const localRange = queryUsageRollupsRange(store.database, {
        startDay: "2026-07-13",
        endDay: "2026-07-13",
        calendarZone: "local",
        excludeHomes: [store.homes[0].id],
      });
      console.log(JSON.stringify({ utc, local, localRange }));
    } finally {
      store.close();
    }
  `;
  const setup = spawnSync(process.execPath, ["--input-type=module", "-e", setupScript], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      TZ: "Asia/Shanghai",
      ROLLUP_HOME: homeDir,
      ROLLUP_PROJECT: projectRoot,
      ROLLUP_DB: databaseFile,
    },
  });
  assert.equal(setup.status, 0, setup.stderr);
  const first = JSON.parse(setup.stdout);
  assert.equal(first.utc.total, 10);
  assert.equal(first.local.total, 10);
  assert.equal(first.localRange.total, 0);

  const queryScript = `
    import { UsageStore } from "./src/usage-store.js";
    import { queryUsageRollups, queryUsageRollupsRange, rebuildUsageRollups } from "./src/usage-rollups.js";

    const store = new UsageStore({
      homeDir: process.env.ROLLUP_HOME,
      databaseFile: process.env.ROLLUP_DB,
      importDirs: [process.env.ROLLUP_PROJECT],
    });
    try {
      await store.open();
      const staleLocal = queryUsageRollups(store.database, {
        day: "2026-07-13",
        calendarZone: "local",
      });
      let staleRange;
      try {
        queryUsageRollupsRange(store.database, {
          startDay: "2026-07-13",
          endDay: "2026-07-13",
          calendarZone: "local",
        });
      } catch (error) {
        staleRange = { code: error.code, missingDays: error.missingDays };
      }
      const utc = queryUsageRollups(store.database, {
        day: "2026-07-12",
        calendarZone: "utc",
      });
      rebuildUsageRollups(store.database, {
        days: ["2026-07-12", "2026-07-13"],
        calendarZone: "local",
      });
      const local12 = queryUsageRollups(store.database, {
        day: "2026-07-12",
        calendarZone: "local",
      });
      const local13 = queryUsageRollups(store.database, {
        day: "2026-07-13",
        calendarZone: "local",
      });
      console.log(JSON.stringify({ staleLocal, staleRange, utc, local12, local13 }));
    } finally {
      store.close();
    }
  `;
  const queried = spawnSync(process.execPath, ["--input-type=module", "-e", queryScript], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      TZ: "UTC",
      ROLLUP_HOME: homeDir,
      ROLLUP_PROJECT: projectRoot,
      ROLLUP_DB: databaseFile,
    },
  });
  try {
    assert.equal(queried.status, 0, queried.stderr);
    const second = JSON.parse(queried.stdout);
    assert.equal(second.staleLocal, null);
    assert.deepEqual(second.staleRange, {
      code: "ROLLUP_DAYS_MISSING",
      missingDays: ["2026-07-13"],
    });
    assert.equal(second.utc.total, 10);
    assert.equal(second.local12.total, 10);
    assert.equal(second.local13.total, 0);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("local DST days use 23h/25h windows without leaking boundary events", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "usage-rollups-dst-"));
  const databaseFile = path.join(directory, "index.sqlite");
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { createUsageRollups, queryUsageRollups, queryUsageRollupsRange, rebuildUsageRollups } from "./src/usage-rollups.js";

    const db = new DatabaseSync(process.env.ROLLUP_DB);
    db.exec(\`
      CREATE TABLE events (
        timestamp_ms INTEGER NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'gpt-6-sol',
        session_id TEXT,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0
      ) STRICT
    \`);
    createUsageRollups(db);
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const cases = [
      {
        day: "2026-03-08",
        start: "2026-03-08T05:00:00.000Z",
        last: "2026-03-09T03:59:59.999Z",
        next: "2026-03-09T04:00:00.000Z",
      },
      {
        day: "2026-11-01",
        start: "2026-11-01T04:00:00.000Z",
        last: "2026-11-02T04:59:59.999Z",
        next: "2026-11-02T05:00:00.000Z",
      },
    ];
    const offset = (value) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        timeZoneName: "longOffset",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(value)).find((part) => part.type === "timeZoneName").value;
    const result = [];
    for (const item of cases) {
      insert.run(Date.parse(item.start), item.day, "home-a", "dst-session", 10, 7, 2, 3, 1);
      insert.run(Date.parse(item.last), item.day, "home-a", "dst-session", 20, 15, 5, 5, 2);
      insert.run(Date.parse(item.next), item.day, "home-a", null, 999, 999, 0, 0, 0);
      rebuildUsageRollups(db, { days: [item.day], calendarZone: "local" });
      const marker = db.prepare(
        "SELECT start_ms, end_ms FROM usage_rollup_days WHERE calendar_zone = 'local' AND day_key = ?",
      ).get(item.day);
      result.push({
        day: item.day,
        markerHours: (Number(marker.end_ms) - Number(marker.start_ms)) / 3_600_000,
        startOffset: offset(item.start),
        endOffset: offset(item.next),
        summary: queryUsageRollups(db, { day: item.day, calendarZone: "local" }),
        range: queryUsageRollupsRange(db, {
          startDay: item.day,
          endDay: item.day,
          calendarZone: "local",
        }),
      });
    }
    db.close();
    console.log(JSON.stringify(result));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, TZ: "America/New_York", ROLLUP_DB: databaseFile },
    });
    assert.equal(result.status, 0, result.stderr);
    const [spring, fall] = JSON.parse(result.stdout);

    assert.deepEqual([spring.markerHours, fall.markerHours], [23, 25]);
    assert.deepEqual(
      [spring.startOffset, spring.endOffset, fall.startOffset, fall.endOffset],
      ["GMT-05:00", "GMT-04:00", "GMT-04:00", "GMT-05:00"],
    );
    for (const item of [spring, fall]) {
      assert.equal(item.summary.eventCount, 2);
      assert.equal(item.summary.sessionCount, 1);
      assert.equal(item.summary.homeCount, 1);
      assert.equal(item.summary.total, 30);
      assert.equal(item.range.eventCount, 2);
      assert.equal(item.range.sessionCount, 1);
      assert.equal(item.range.homeCount, 1);
      assert.equal(item.range.total, 30);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("seeds and enqueues UTC dirty days for fact changes", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(Date.parse("2026-07-13T02:00:00.000Z"), "2026-07-13", "home-a", "session-a", 20, 15, 5, 5, 2);
    insert.run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "session-a", 10, 7, 2, 3, 1);
    createUsageRollups(db);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12", "2026-07-13"]);

    db.prepare(`
      UPDATE events
      SET timestamp_ms = ?, day_key = ?
      WHERE timestamp_ms = ?
    `).run(Date.parse("2026-07-14T02:00:00.000Z"), "2026-07-14", Date.parse("2026-07-12T02:00:00.000Z"));
    db.prepare("UPDATE events SET total = total + 1 WHERE timestamp_ms = ?").run(
      Date.parse("2026-07-14T02:00:00.000Z"),
    );
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12", "2026-07-13", "2026-07-14"]);

    db.prepare("DELETE FROM events WHERE timestamp_ms = ?").run(Date.parse("2026-07-13T02:00:00.000Z"));
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12", "2026-07-13", "2026-07-14"]);

    insert.run(Date.parse("2026-07-15T02:00:00.000Z"), "2026-07-15", "home-a", "session-b", 30, 20, 5, 5, 3);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15"]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps sub-second timestamps on their UTC day", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(-1, "1969-12-31", "home-a", "negative", 1, 1, 0, 0, 0);
    createUsageRollups(db);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["1969-12-31"]);

    insert.run(0, "1970-01-01", "home-a", "epoch", 1, 1, 0, 0, 0);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["1969-12-31", "1970-01-01"]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects UTC days onto local days across Shanghai and New York DST", () => {
  const script = `
    import { localUsageRollupDaysForUtcDays } from "./src/usage-rollups.js";
    console.log(JSON.stringify({
      shanghai: localUsageRollupDaysForUtcDays(["2026-07-12"]),
      spring: localUsageRollupDaysForUtcDays(["2026-03-07", "2026-03-08"]),
      fall: localUsageRollupDaysForUtcDays(["2026-10-31", "2026-11-01"]),
    }));
  `;
  const project = (TZ) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, TZ },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  assert.deepEqual(project("Asia/Shanghai").shanghai, ["2026-07-12", "2026-07-13"]);
  const newYork = project("America/New_York");
  assert.deepEqual(newYork.spring, ["2026-03-06", "2026-03-07", "2026-03-08"]);
  assert.deepEqual(newYork.fall, ["2026-10-30", "2026-10-31", "2026-11-01"]);
});

test("deduplicates and sorts projected days while rejecting invalid UTC days", () => {
  const script = `
    import { localUsageRollupDaysForUtcDays } from "./src/usage-rollups.js";
    const days = localUsageRollupDaysForUtcDays([
      "2026-07-12",
      "2026-07-12",
      "2026-07-11",
    ]);
    let invalid;
    try {
      localUsageRollupDaysForUtcDays(["2026-02-30"]);
    } catch (error) {
      invalid = { name: error.name, message: error.message };
    }
    console.log(JSON.stringify({ days, invalid }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, TZ: "Asia/Shanghai" },
  });
  assert.equal(result.status, 0, result.stderr);
  const projected = JSON.parse(result.stdout);
  assert.deepEqual(projected.days, ["2026-07-11", "2026-07-12", "2026-07-13"]);
  assert.equal(projected.invalid.name, "RangeError");
  assert.match(projected.invalid.message, /invalid utc day/);
});

test("rebuild clears only successfully rebuilt UTC dirty days", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "session-a", 10, 7, 2, 3, 1);
    createUsageRollups(db);
    db.exec(`
      CREATE TEMP TRIGGER fail_dirty_rebuild
      BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.day_key = '2026-07-12'
      BEGIN
        SELECT RAISE(ABORT, 'injected dirty rebuild failure');
      END
    `);

    assert.throws(() => rebuildUsageRollups(db, { days: ["2026-07-12"] }), /injected dirty rebuild failure/);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);

    db.exec("DROP TRIGGER fail_dirty_rebuild");
    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(listDirtyUsageRollupDays(db), []);

    db.prepare("UPDATE events SET total = total + 1 WHERE session_id = ?").run("session-a");
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    rebuildUsageRollups(db, { days: ["2026-07-12"], calendarZone: "local" });
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back dirty day enqueue and clear with the outer transaction", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(Date.parse("2026-07-12T02:00:00.000Z"), "2026-07-12", "home-a", "session-a", 10, 7, 2, 3, 1);
    createUsageRollups(db);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);

    db.exec("BEGIN");
    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(listDirtyUsageRollupDays(db), []);
    db.exec("ROLLBACK");
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(listDirtyUsageRollupDays(db), []);

    db.exec("BEGIN");
    db.prepare("UPDATE events SET total = total + 1 WHERE session_id = ?").run("session-a");
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.deepEqual(listDirtyUsageRollupDays(db), []);
    db.exec("ROLLBACK");

    assert.deepEqual(listDirtyUsageRollupDays(db), []);
    assert.equal(queryUsageRollups(db, { day: "2026-07-12" }).total, 10);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dirty day listing rejects a non-current cache format without writing", async () => {
  const { db, directory } = await openEventsDatabase();
  try {
    const timestamp = Date.parse("2026-07-12T02:00:00.000Z");
    db.prepare(
      "INSERT INTO events (timestamp_ms, day_key, home_id, session_id, total, input, cached, output, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(timestamp, "2026-07-12", "home-a", "legacy-session", 10, 7, 2, 3, 1);
    db.exec(`
      CREATE TABLE usage_rollup_format (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO usage_rollup_format (id, format_version) VALUES (1, 999);
    `);
    const formatBefore = db.prepare("SELECT * FROM usage_rollup_format").all();
    assert.throws(
      () => listDirtyUsageRollupDays(db),
      (error) => {
        assert.equal(error.code, "ROLLUP_CACHE_MISSING");
        return true;
      },
    );
    assert.deepEqual(db.prepare("SELECT * FROM usage_rollup_format").all(), formatBefore);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?").get("usage_rollup_dirty_days").count,
      0,
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
