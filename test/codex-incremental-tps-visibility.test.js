import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readRequestTimingRevision } from "../src/perf-request-timing-store.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const FILTERS = { preset: "all", now: new Date("2026-10-04T13:00:00.000Z"), calendarZone: "utc" };
const FACT_TABLES = {
  events: "id",
  perf_samples: "sample_key",
  perf_sample_sources: "sample_key, source_path, role",
  perf_rollout_threads: "home_id, thread_id, source_path",
  perf_request_timing_evidence: "home_id, evidence_origin, response_id, variant_key",
  perf_request_timing_threads: "home_id, response_id, thread_id",
};

function ledgerLine(record) {
  return `${JSON.stringify({
    agent: "codex",
    provider: "codex",
    req: `codex/${record.requestedModel}`,
    model: record.requestedModel,
    response_id: record.responseId,
    status: 200,
    ms: record.durationMs,
    out: record.reportedOutputTokens,
    stop: "completed",
    ep: "/backend-api/codex/responses",
  })}\n`;
}

function newTiming(turn, outputTokens, durationMs, model = "codex-fixture-model") {
  return { responseId: `t1-response-${turn}`, requestedModel: model, reportedOutputTokens: outputTokens, durationMs };
}

function appendNativeTurn(fixture, turn, outputTokens, cumulativeOutputTokens, model = "codex-fixture-model") {
  const threadId = "fixture-codex-thread";
  const turnId = `t1-turn-${turn}`;
  const timestamp = new Date(Date.parse("2026-10-04T12:00:00.000Z") + turn * 10_000 + 2500).toISOString();
  const rows = [
    { type: "turn_context", payload: { thread_id: threadId, turn_id: turnId, model, effort: "high" } },
    {
      type: "token_usage_record",
      timestamp,
      payload: {
        thread_id: threadId,
        turn_id: turnId,
        response_id: `t1-response-${turn}`,
        usage: { output_tokens: outputTokens },
        turn_token_usage: { output_tokens: outputTokens },
      },
    },
    {
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: (turn - 25) * 100,
            output_tokens: cumulativeOutputTokens,
            total_tokens: (turn - 25) * 100 + cumulativeOutputTokens,
          },
        },
      },
    },
  ];
  appendFileSync(fixture.rolloutFiles[0], `${rows.map(JSON.stringify).join("\n")}\n`);
  appendFileSync(
    fixture.rolloutFiles[2],
    `${[
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: threadId,
          turn_id: turnId,
          item: { id: `t1-item-${turn}`, type: "AgentMessage" },
          started_at_ms: Date.parse(timestamp) - 1,
          completed_at_ms: Date.parse(timestamp),
        },
      },
      { type: "event_msg", payload: { type: "task_complete", thread_id: threadId, turn_id: turnId } },
    ]
      .map(JSON.stringify)
      .join("\n")}\n`,
  );
}

async function published(store) {
  const summary = structuredClone(await store.summarize(FILTERS));
  delete summary.generatedAt;
  delete summary.perf.indexedAt;
  delete summary.perf.meta.indexedAt;
  return {
    summary,
    facts: Object.fromEntries(
      Object.entries(FACT_TABLES).map(([table, order]) => [
        table,
        store.database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
      ]),
    ),
    publication: {
      ...store.perfPublicationState(),
      revision: readRequestTimingRevision(store.database),
      publishedRevision: store.readMeta("perf_request_timing_published_revision"),
      warnings: store.readPublishedFileWarnings(),
    },
  };
}

async function withStores(run) {
  const fixture = createPerfCodexIntegrationFixture();
  const ledger = path.join(fixture.serverOptions.homeDir, ".config", "magpie", "usage.jsonl");
  const store = new UsageStore(fixture.serverOptions);
  const reference = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "t1-full-reference.sqlite"),
  });
  try {
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, fixture.timingRecords.map(ledgerLine).join(""));
    await store.open();
    await reference.open();
    // The reference rereads every planned rollout and publishes timing through the complete native round.
    reference.codexProjections.lookup = () => undefined;
    reference.publishMagpieRequestTimings = () => false;
    const compare = async (label) => {
      await store.sync();
      await reference.sync();
      const actual = await published(store);
      assert.deepEqual(actual, await published(reference), label);
      assert.equal(actual.publication.timingRevision, "", `${label}: no unpublished timing revision`);
      assert.equal(store.requestTimingDirtyThreadCount(), 0, label);
      assert.equal(store.magpieRequestTimings.pendingChanges().responseIds.size, 0, label);
      return actual;
    };
    await run({ fixture, ledger, store, reference, compare });
  } finally {
    store.close();
    reference.close();
    fixture.close();
  }
}

function assertTimingSummary(summary, eligible, sampled, recordedOutputTokens, sampledOutputTokens) {
  const perf = summary.perf;
  assert.equal(perf.state, "ready");
  for (const counts of [perf.coverage, perf.codexTimingCoverage.counts]) {
    assert.equal(counts.eligible, eligible);
    assert.equal(counts.sampled, sampled);
    assert.equal(counts.dropped, eligible - sampled);
    assert.equal(counts.pending, 0, "completed turns missing timing are dropped, not pending sync work");
    assert.equal(counts.sampleRate, sampled / eligible);
    assert.equal(counts.timingRate, sampled / eligible);
    assert.equal(counts.completeTimingRate, sampled / eligible);
  }
  assert.equal(perf.codexTimingCoverage.recordedOutputTokens, recordedOutputTokens);
  assert.equal(perf.codexTimingCoverage.sampledOutputTokens, sampledOutputTokens);
  assert.equal(perf.codexTimingCoverage.unknownOutputCandidates, 0);
}

test("T1 Codex native-only, ledger-only and same-cycle arrivals match the complete summary and facts", async () => {
  await withStores(async ({ fixture, ledger, store, compare }) => {
    appendFileSync(ledger, ledgerLine(newTiming(26, 200, 2000)));
    const initial = await compare("initial multi-file thread; future timing has no native owner yet");
    assertTimingSummary(initial.summary, 25, 25, 2800, 2800);
    const oldLedger = readFileSync(ledger, "utf8");

    appendNativeTurn(fixture, 26, 200, 200);
    const native = await compare("native-only reuses already acknowledged ledger without new bytes");
    assert.equal(readFileSync(ledger, "utf8"), oldLedger);
    assert.equal(native.summary.totals.total - initial.summary.totals.total, 300);
    assertTimingSummary(native.summary, 26, 26, 3000, 3000);
    assert.equal(native.summary.perf.models[0].averageTps, (3000 * 1000) / 426000);
    assert.notEqual(native.publication.indexVersion, initial.publication.indexVersion);
    assert.equal(native.publication.magpieTimingFingerprint, initial.publication.magpieTimingFingerprint);

    appendNativeTurn(fixture, 27, 300, 500, "t1-late-model");
    const missing = await compare("native-only missing timing retains the candidate and model");
    assert.equal(missing.summary.totals.total - native.summary.totals.total, 400);
    assertTimingSummary(missing.summary, 27, 26, 3300, 3000);
    const missingModel = missing.summary.perf.models.find((model) => model.model === "t1-late-model");
    assert.ok(missingModel);
    assert.equal(missingModel.state, "missing_duration");
    assert.equal(missingModel.candidateCount, 1);
    assert.deepEqual(
      [missingModel.n, missingModel.averageTps, missingModel.p10, missingModel.p90],
      [0, null, null, null],
    );
    assert.notEqual(missing.publication.indexVersion, native.publication.indexVersion);

    appendFileSync(ledger, ledgerLine(newTiming(27, 300, 3000, "t1-late-model")));
    const late = await compare("late ledger-only timing publishes in this sync");
    assert.deepEqual(late.summary.totals, missing.summary.totals);
    assertTimingSummary(late.summary, 27, 27, 3300, 3300);
    const lateModel = late.summary.perf.models.find((model) => model.model === "t1-late-model");
    assert.equal(lateModel.n, 1);
    assert.equal(lateModel.averageTps, 100);
    assert.notEqual(late.publication.indexVersion, missing.publication.indexVersion);

    appendNativeTurn(fixture, 28, 400, 900);
    appendFileSync(ledger, ledgerLine(newTiming(28, 400, 4000)));
    const sameCycle = await compare("same-cycle native plus ledger needs no later sync to expose TPS");
    assert.equal(sameCycle.summary.totals.total - late.summary.totals.total, 500);
    assertTimingSummary(sameCycle.summary, 28, 28, 3700, 3700);
    const model = sameCycle.summary.perf.models.find((entry) => entry.model === fixture.expected.model);
    assert.equal(model.n, 27);
    assert.equal(model.averageTps, (3400 * 1000) / 430000);
    assert.notEqual(sameCycle.publication.indexVersion, late.publication.indexVersion);
    const stable = await compare("no new bytes leave the entire summary and publication unchanged");
    assert.deepEqual(stable, sameCycle);
    assert.equal(store.magpieRequestTimings.pendingChanges().reset, false);
  });
});

test("T1 a timing publication rollback preserves the complete old result and retries without new bytes", async () => {
  await withStores(async ({ fixture, ledger, store, compare }) => {
    await compare("initial timing");
    appendNativeTurn(fixture, 26, 200, 200);
    const before = await compare("native committed before late timing");
    assertTimingSummary(before.summary, 26, 25, 3000, 2800);
    appendFileSync(ledger, ledgerLine(newTiming(26, 200, 2000)));
    const ledgerBytes = readFileSync(ledger, "utf8");
    store.database.exec(`
      CREATE TEMP TRIGGER t1_reject_timing_publication BEFORE UPDATE OF value ON store_meta
      WHEN OLD.key = 'perf_index_version' AND NEW.value <> OLD.value
      BEGIN SELECT RAISE(FAIL, 'T1 injected publication rollback'); END;
    `);
    await store.sync();
    const failed = await published(store);
    assert.deepEqual(failed.summary, before.summary, "no partial TPS, coverage or indexVersion escapes rollback");
    for (const table of ["events", "perf_samples", "perf_sample_sources", "perf_rollout_threads"]) {
      assert.deepEqual(failed.facts[table], before.facts[table], table);
    }
    assert.ok(failed.publication.revision > before.publication.revision, "evidence import did commit");
    assert.equal(failed.publication.publishedRevision, before.publication.publishedRevision);
    assert.equal(failed.publication.magpieTimingFingerprint, before.publication.magpieTimingFingerprint);
    assert.notEqual(failed.publication.timingRevision, "");
    assert.equal(store.requestTimingDirtyThreadCount(), 1);
    assert.ok(store.magpieRequestTimings.pendingChanges().responseIds.has("t1-response-26"));
    assert.ok(store.warnings.some((warning) => String(warning).startsWith("MAGPIE_TIMING_SYNC_FAILED:")));
    store.database.exec("DROP TRIGGER t1_reject_timing_publication");

    const recovered = await compare("retry without new native or ledger bytes matches complete reference");
    assert.equal(readFileSync(ledger, "utf8"), ledgerBytes);
    assert.deepEqual(recovered.summary.totals, before.summary.totals);
    assertTimingSummary(recovered.summary, 26, 26, 3000, 3000);
    assert.equal(recovered.summary.perf.models[0].averageTps, (3000 * 1000) / 426000);
    assert.notEqual(recovered.publication.indexVersion, before.publication.indexVersion);
    assert.notEqual(recovered.publication.magpieTimingFingerprint, before.publication.magpieTimingFingerprint);
  });
});
