import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCostEstimateAccumulator, estimateCostForEvents, estimateEventCost } from "../src/pricing.js";
import { UsageStore } from "../src/usage-store.js";

const START = new Date("2026-07-12T00:00:00.000Z");
const END = new Date("2026-07-12T23:59:59.999Z");
const RANGE = {
  preset: "custom",
  start: START,
  end: END,
  calendarZone: "utc",
};
const MEMO_FIELDS = ["hits", "misses", "evictions", "clears"];

function statsDelta(before, after) {
  return Object.fromEntries(MEMO_FIELDS.map((field) => [field, after[field] - before[field]]));
}

function usage(total, input, cached, output, reasoning, cacheWrite = 0) {
  return {
    total,
    input,
    cached,
    output,
    reasoning,
    cache_write_input_tokens: cacheWrite,
  };
}

function projectLogRow(sessionId, timestamp, model, details, extra = {}) {
  return {
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "ZCode",
    project_root: "/work/timeline-direct",
    cwd: "/work/timeline-direct",
    session_id: sessionId,
    model,
    usage: details,
    ...extra,
  };
}

test("timeline estimates each event directly without consuming the store memo", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-timeline-direct-"));
  const projectRoot = path.join(homeDir, "project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const rows = [
    projectLogRow("glm-short-output", "2026-07-12T02:00:00.000Z", "glm-4.7", usage(10_100, 10_000, 0, 100, 0), {
      request_id: "glm-short-request",
      service_tier: "standard",
    }),
    projectLogRow("glm-long-output", "2026-07-12T03:00:00.000Z", "glm-4.7", usage(10_500, 10_000, 0, 500, 0), {
      request_id: "glm-long-request",
      service_tier: "standard",
    }),
    projectLogRow("priced-codex", "2026-07-12T04:00:00.000Z", "gpt-6-sol", usage(110, 100, 20, 10, 0), {
      request_id: "priced-request",
      service_tier: "standard",
    }),
    projectLogRow(
      "unknown-minimum",
      "2026-07-12T05:00:00.000Z",
      "unknown-direct-model",
      {
        total: 300,
        input: 200,
        cached: 0,
      },
      { service_tier: "mystery" },
    ),
    projectLogRow("inconsistent-details", "2026-07-12T06:00:00.000Z", "gpt-6-sol", usage(100, 60, 0, 60, 0), {
      request_id: "inconsistent-request",
      service_tier: "standard",
    }),
  ];

  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: [projectRoot],
    automaticDiscoveryEnabled: false,
  });

  try {
    await store.sync();
    store.eventCostMemo.clear("timeline-direct-test");
    const events = [...store.costEventsForRange(RANGE)];
    assert.equal(events.length, rows.length, "fixture must materialize every project-log row");
    assert.equal(store.eventCostMemo.size(), 0, "memo starts empty");

    const beforeTimeline = store.eventCostMemo.stats();
    const observed = [];
    const accumulator = createCostEstimateAccumulator();
    const timeline = store.timelineRange(RANGE, "day", {
      onEstimate(event, estimate) {
        observed.push({ event, estimate });
        accumulator.add(event, estimate);
      },
    });
    const afterTimeline = store.eventCostMemo.stats();

    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].count, events.length);
    assert.equal(observed.length, events.length, "onEstimate must run exactly once per event");
    const bySession = new Map(observed.map(({ event, estimate }) => [event.sessionId, estimate]));
    assert.equal(bySession.size, events.length, "fixture sessions must be unique");
    for (const event of events) {
      assert.deepEqual(bySession.get(event.sessionId), estimateEventCost(event), event.sessionId);
    }

    const observedCost = accumulator.result();
    const oracleCost = estimateCostForEvents(events);
    assert.deepEqual(observedCost, oracleCost, "timeline estimates must aggregate to the pricing oracle");

    const glmShort = bySession.get("glm-short-output");
    const glmLong = bySession.get("glm-long-output");
    assert.equal(glmShort.currency, "CNY");
    assert.equal(glmLong.currency, "CNY");
    assert.ok(Math.abs(glmShort.totalUsd - 0.0208) < 1e-12);
    assert.ok(Math.abs(glmLong.totalUsd - 0.037) < 1e-12);

    const unknown = bySession.get("unknown-minimum");
    assert.equal(unknown.currency, "CNY");
    assert.equal(unknown.pricingStatus, "minimum-estimate");
    assert.ok(unknown.minimumEstimatedTokens > 0);
    assert.ok(unknown.serviceTierUnknownTokens > 0);
    assert.ok(unknown.contextUnknownTokens > 0);
    assert.ok(unknown.cacheWriteUnknownTokens > 0);
    assert.ok(unknown.unpricedReasons.includes("unknown-model-price-minimum-scenario"));
    assert.ok(unknown.unpricedReasons.includes("output-detail-missing"));

    const inconsistent = bySession.get("inconsistent-details");
    assert.equal(inconsistent.pricingStatus, "minimum-estimate");
    assert.ok(inconsistent.unpricedReasons.includes("usage-detail-inconsistent-minimum-scenario"));
    assert.equal(events.find((event) => event.sessionId === "inconsistent-details").detailMask & 16, 16);

    assert.deepEqual(
      statsDelta(beforeTimeline, afterTimeline),
      { hits: 0, misses: 0, evictions: 0, clears: 0 },
      "timeline must not read or populate the event cost memo",
    );

    const beforeCostEstimate = store.eventCostMemo.stats();
    const memoCost = store.costEstimateRange(RANGE);
    const afterCostEstimate = store.eventCostMemo.stats();
    assert.deepEqual(memoCost, oracleCost, "costEstimateRange must keep the memo-backed oracle result");
    assert.deepEqual(statsDelta(beforeCostEstimate, afterCostEstimate), {
      hits: 0,
      misses: events.length,
      evictions: 0,
      clears: 0,
    });
    assert.equal(store.eventCostMemo.size(), events.length);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
