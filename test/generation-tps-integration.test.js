import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const DATE = "2026-10-27T12:00:00.000Z";
const FILTERS = { preset: "all", now: new Date(DATE), calendarZone: "utc" };
const generation = {
  outputTokens: 80,
  durationMs: 1000,
  startOutputTokens: 1,
  timingKind: "first_output_response_end",
};

function timing(responseId, extra = {}) {
  return {
    schemaVersion: 2,
    evidenceOrigin: "fixture.native-stream.v1",
    responseId,
    requestedModel: "model-a",
    reportedOutputTokens: 100,
    durationMs: 2000,
    status: "completed",
    completedAtMs: null,
    generation,
    ...extra,
  };
}

async function writeRows(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "generation-tps-"));
  const options = {
    homeDir: root,
    env: {},
    automaticDiscoveryEnabled: false,
    importDirs: [],
    databaseFile: path.join(root, "usage.sqlite"),
    extraHomes: path.join(root, "codex"),
  };
  const store = new UsageStore(options);
  try {
    await writeRows(path.join(options.extraHomes, "sessions", "rollout.jsonl"), [
      { type: "session_meta", payload: { id: "thread-a", source: "cli" } },
      { type: "turn_context", payload: { thread_id: "thread-a", turn_id: "turn-a", model: "model-a", effort: "high" } },
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "token_usage_record",
        timestamp: DATE,
        payload: {
          thread_id: "thread-a",
          turn_id: "turn-a",
          response_id: `response-${i}`,
          usage: { output_tokens: 100, reasoning_output_tokens: 20 },
        },
      })),
    ]);
    await store.sync();
    const homeId = store.homes.find((home) => home.path === options.extraHomes).id;
    const importTimings = (records) =>
      store.importRequestTimingEvidence({
        homeId,
        records,
        reviewedOrigins: ["fixture.native-stream.v1"],
      });
    await run({ root, options, store, importTimings });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("explicit evidence samples responses independently and upgrades without changing usage", async () => {
  await fixture(async ({ options, store, importTimings }) => {
    importTimings(Array.from({ length: 8 }, (_, i) => timing(`response-${i}`)));
    await store.sync();
    let calls = 0;
    const original = store.timelineRange;
    store.timelineRange = function (...args) {
      calls += 1;
      return original.apply(this, args);
    };
    const before = await store.summarize(FILTERS);
    assert.equal(before.perf.meta.methodVersion, "tps-v5");
    assert.equal(before.perf.models[0].n, 8);
    assert.equal(before.perf.models[0].averageTps, 79);
    assert.equal(before.perf.coverage.eligible, 10);
    const memory = summarizeUsage(
      await buildUsageReport({
        ...options,
        lookupRequestTiming: (query) => store.lookupRequestTiming(query),
      }),
      FILTERS,
    );
    assert.deepEqual(memory.perf.models, before.perf.models);
    const warmCalls = calls;
    assert.ok(warmCalls > 0);
    const additions = [
      timing("response-8"),
      timing("response-9"),
      timing("response-0", {
        generation: { ...generation, durationMs: 800, timingKind: "first_last_output" },
      }),
    ];
    importTimings(additions);
    await store.sync();
    const after = await store.summarize(FILTERS);
    assert.equal(after.perf.models[0].n, 10);
    assert.equal(after.perf.models[0].averageTps, 790000 / 9800);
    assert.notEqual(after.perf.indexVersion, before.perf.indexVersion);
    assert.deepEqual(after.totals, before.totals);
    assert.equal(calls, warmCalls);
    assert.equal(importTimings(additions).changed, false);
    await store.sync();
    assert.deepEqual((await store.summarize(FILTERS)).perf.models, after.perf.models);
  });
});

test("native memory and indexed reports ignore Magpie data and unreadable ledger paths", async () => {
  await fixture(async ({ root, options, store }) => {
    options.automaticDiscoveryEnabled = true;
    await writeRows(path.join(root, ".claude", "projects", "fixture", "session.jsonl"), [
      {
        type: "assistant",
        timestamp: DATE,
        sessionId: "claude-session",
        message: {
          id: "message-a",
          model: "claude-a",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 20 } },
        },
      },
    ]);
    await store.sync();
    const before = await store.summarize(FILTERS);
    const memoryBefore = await buildUsageReport(options);
    assert.equal(before.perf.models.length, 2);
    assert.ok(before.perf.models.every((model) => model.n === 0 && model.averageTps === null));
    const ledgerPath = path.join(root, ".config", "magpie", "usage.jsonl");
    await writeRows(ledgerPath, [
      {
        agent: "codex",
        req: "model-a",
        response_id: "response-0",
        status: 200,
        out: 100,
        ms: 2000,
        generation,
        ep: "/v1/responses",
      },
      {
        agent: "claude",
        req: "claude-a",
        response_id: "message-a",
        status: 200,
        out: 100,
        ms: 2000,
        generation,
        ep: "/v1/messages",
      },
    ]);
    for (const change of [
      () => appendFile(ledgerPath, "invalid\n"),
      async () => {
        await rm(ledgerPath);
        await mkdir(ledgerPath);
      },
    ]) {
      await change();
      await store.sync();
      const after = await store.summarize(FILTERS);
      const memoryAfter = await buildUsageReport(options);
      assert.deepEqual(after.perf.models, before.perf.models);
      assert.equal(after.perf.indexVersion, before.perf.indexVersion);
      assert.deepEqual(after.totals, before.totals);
      assert.deepEqual(memoryAfter.perfSamples, memoryBefore.perfSamples);
      assert.equal(memoryAfter.perfMeta.indexVersion, memoryBefore.perfMeta.indexVersion);
      assert.deepEqual(memoryAfter.perfMeta.sourceWarnings, memoryBefore.perfMeta.sourceWarnings);
      assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM perf_request_timing_evidence").get().n), 0);
    }
  });
});
