import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { renderPerfCoverageHtml, renderPerfDetailHtml, renderPerfModelsHtml } from "../public/perf-ui.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const MODEL_ROW_KEYS = [
  "key",
  "sourceKind",
  "model",
  "reasoningEffort",
  "modelProvider",
  "window",
  "firstSampleAtMs",
  "lastSampleAtMs",
  "rankState",
  "averageTps",
  "p10",
  "p90",
  "n",
  "state",
  "rank",
];

function assertCodexModel(perf, fixture, where) {
  assert.equal(perf.models.length, 1, `${where}: one Codex model row`);
  const model = perf.models[0];
  assert.deepEqual(Object.keys(model).sort(), [...MODEL_ROW_KEYS].sort());
  assert.equal(model.key, JSON.stringify(["codex", fixture.expected.model, "high", ""]));
  assert.equal(model.sourceKind, "codex");
  assert.equal(model.model, fixture.expected.model);
  assert.equal(model.reasoningEffort, "high");
  assert.equal(model.modelProvider, "");
  assert.equal(model.window, "turn");
  assert.equal(model.rankState, "eligible");
  assert.equal(model.firstSampleAtMs, Date.parse("2026-10-04T12:00:12.500Z"));
  assert.equal(model.lastSampleAtMs, Date.parse("2026-10-04T12:04:13.500Z"));
  assert.equal(model.averageTps, fixture.expected.tps.pooled);
  assert.equal(model.p10, fixture.expected.tps.p10);
  assert.equal(model.p90, fixture.expected.tps.p90);
  assert.equal(model.n, fixture.expected.n);
  assert.equal(model.state, "ok");
  assert.equal(model.rank, fixture.expected.rank);
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return serverUrl(server);
}

async function getJson(baseUrl, route, query) {
  const response = await fetch(`${baseUrl}/api/${route}?${query}`);
  assert.equal(response.status, 200, `${route}?${query}`);
  return response.json();
}

test("M7 Codex request timing reaches dashboard, summary, full detail, UI labels, and immutable snapshots", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  await store.sync({ options: fixture.reportOptions });
  await fixture.seedRequestTiming(store);
  store.close();
  const server = createUsageServer({
    ...fixture.serverOptions,
    heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
  });
  const baseUrl = await listen(server);
  const get = (route, query) => getJson(baseUrl, route, query);

  try {
    const usage = await get("usage", "preset=all&skipCheck=1");
    const dashboard = await get("usage", "preset=all&view=dashboard&skipCheck=1");
    const summary = await get("summary", "preset=all&skipCheck=1");
    const full = await get("usage", "preset=all&detail=full&skipCheck=1");
    const frozen = await get("usage", "preset=all&freeze=1&skipCheck=1");

    for (const body of [usage, dashboard, summary, full, frozen]) {
      const perf = body.summary.perf;
      assert.equal(perf.state, "ready");
      assert.equal(perf.meta.methodVersion, "tps-v2");
      assert.equal(perf.groups.length, 1);
      assert.equal(perf.groups[0].sourceKind, "codex");
      assert.equal(perf.groups[0].timingKind, "request_e2e");
      assert.equal(perf.groups[0].tokenScope, "reported_output_includes_reasoning");
      assert.equal(perf.groups[0].agentKind, "unknown");
      assert.equal(perf.groups[0].n, fixture.expected.n);
      assert.deepEqual(perf.groups[0].tps, fixture.expected.tps);
      assertCodexModel(perf, fixture, "Codex API entry");
      const timing = perf.codexTimingCoverage;
      assert.equal(timing.methodVersion, "tps-v2");
      assert.equal(timing.counts.eligible, 25);
      assert.equal(timing.counts.sampled, 25);
      assert.equal(timing.recordedOutputTokens, 2800);
      assert.equal(timing.sampledOutputTokens, 2800);
      assert.equal(timing.unknownOutputCandidates, 0);
      assert.deepEqual(perf.coverage, summary.summary.perf.coverage);
      assert.deepEqual(timing, summary.summary.perf.codexTimingCoverage);
    }
    assert.deepEqual(dashboard.summary.perf.groups, summary.summary.perf.groups);
    assert.deepEqual(dashboard.summary.perf.models, summary.summary.perf.models);
    assert.deepEqual(full.summary.perf.groups, summary.summary.perf.groups);
    assert.deepEqual(full.summary.perf.models, summary.summary.perf.models);
    assert.ok(full.report);
    assert.equal("perfSamples" in full.report, false);
    assert.equal("perfMeta" in full.report, false);
    assert.doesNotMatch(JSON.stringify(full), /sampleKey|sourcePath|fixture-codex-thread/);

    const group = dashboard.summary.perf.groups[0];
    const detailZh = renderPerfDetailHtml(group, dashboard.summary.perf.coverage);
    const detailEn = renderPerfDetailHtml(group, dashboard.summary.perf.coverage, { locale: "en-US" });
    const coverageZh = renderPerfCoverageHtml(dashboard.summary.perf);
    assert.match(detailZh, /请求端到端 TPS（含请求等待）/);
    assert.match(detailZh, /代理未知/);
    assert.match(detailEn, /Request end-to-end TPS \(includes request waiting\)/);
    assert.match(detailEn, /Unknown agent/);
    assert.match(coverageZh, /近期/);
    assert.match(coverageZh, /历史/);
    const modelHtml = renderPerfModelsHtml(dashboard.summary.perf, { calendarZone: "utc" });
    assert.match(modelHtml, /25 个回合/);
    assert.match(modelHtml, /样本日期 2026-10-04/);
    assert.doesNotMatch(modelHtml, /perf-codex-coverage|候选采样覆盖率|已记录输出覆盖率/);

    const snapshotId = frozen.snapshotId;
    assert.ok(snapshotId);
    const frozenSummary = await get("summary", `preset=all&snapshot=${snapshotId}`);
    const frozenModels = frozen.summary.perf.models;
    const frozenTiming = frozen.summary.perf.codexTimingCoverage;
    const livePath = fixture.rolloutFiles[0];
    const liveBefore = readFileSync(livePath, "utf8");
    writeFileSync(livePath, liveBefore.replaceAll('"output_tokens":100', '"output_tokens":150'));
    const live = await get("summary", "preset=all");
    assert.notEqual(live.summary.perf.indexVersion, frozen.summary.perf.indexVersion);
    assert.notDeepEqual(live.summary.perf.groups[0].tps, frozen.summary.perf.groups[0].tps);
    assert.notDeepEqual(live.summary.perf.models, frozenModels);
    assert.equal(live.summary.perf.models[0].n, 24);
    assert.equal(live.summary.perf.codexTimingCoverage.counts.eligible, 25);
    assert.equal(live.summary.perf.codexTimingCoverage.counts.sampled, 24);
    const frozenAfterMutation = await get("summary", `preset=all&snapshot=${snapshotId}`);
    assert.deepEqual(frozenAfterMutation.summary.perf.models, frozenModels);
    assert.deepEqual(frozenAfterMutation.summary.perf.codexTimingCoverage, frozenTiming);
    assert.deepEqual(frozenAfterMutation.summary.perf, frozenSummary.summary.perf);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fixture.close();
  }
});

test("Codex API drops a turn with missing request timing without falling back to item spans", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  let server;
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(
      store,
      fixture.timingRecords.filter((record) => record.responseId !== "response-25-2"),
    );
    const missing = store.database.prepare("SELECT duration_ms FROM perf_samples WHERE output_tokens = 124").get();
    assert.equal(missing.duration_ms, null, "the whole turn must have no denominator");
    store.close();

    server = createUsageServer({
      ...fixture.serverOptions,
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);
    const body = await getJson(baseUrl, "summary", "preset=all&skipCheck=1");
    const perf = body.summary.perf;
    assert.equal(perf.meta.methodVersion, "tps-v2");
    assert.equal(perf.groups[0].n, 24);
    assert.equal(perf.models[0].n, 24);
    assert.equal(perf.models[0].rank, 1);
    assert.deepEqual(perf.groups[0].tps, {
      p10: 102,
      p50: 111,
      p90: 121,
      pooled: 111.5,
    });
    assert.equal(perf.models[0].averageTps, perf.groups[0].tps.pooled);
    assert.equal(perf.codexTimingCoverage.counts.eligible, 25);
    assert.equal(perf.codexTimingCoverage.counts.sampled, 24);
    assert.equal(perf.codexTimingCoverage.recordedOutputTokens, 2800);
    assert.equal(perf.codexTimingCoverage.sampledOutputTokens, 2676);
    assert.equal(perf.codexTimingCoverage.unknownOutputCandidates, 0);
    const html = renderPerfModelsHtml(perf, { calendarZone: "utc" });
    assert.match(html, /24 个回合/);
    assert.doesNotMatch(html, /perf-codex-coverage|已记录输出覆盖率|缺失或无效时长/);
  } finally {
    store.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    fixture.close();
  }
});

test("Codex API explains current-method candidates when no request timing is available", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  let server;
  try {
    await store.sync({ options: fixture.reportOptions });
    store.close();
    server = createUsageServer({
      ...fixture.serverOptions,
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);
    const body = await getJson(baseUrl, "summary", "preset=all&skipCheck=1");
    const perf = body.summary.perf;
    assert.equal(perf.models.length, 1);
    assert.equal(perf.models[0].state, "missing_duration");
    assert.equal(perf.models[0].candidateCount, 25);
    assert.equal(perf.models[0].n, 0);
    assert.deepEqual([perf.models[0].averageTps, perf.models[0].p10, perf.models[0].p90], [null, null, null]);
    assert.deepEqual(perf.groups, []);
    assert.equal(perf.codexTimingCoverage.counts.eligible, 25);
    assert.equal(perf.codexTimingCoverage.counts.sampled, 0);
    assert.equal(perf.codexTimingCoverage.recordedOutputTokens, 2800);
    assert.equal(perf.codexTimingCoverage.sampledOutputTokens, 0);
    const html = renderPerfModelsHtml(perf);
    assert.match(html, /日志未记录请求耗时/);
    assert.doesNotMatch(html, /perf-codex-coverage|缺失或无效时长|候选采样覆盖率/);
    assert.match(html, /perf-model-data-row/);
    assert.doesNotMatch(html, /n=0/);
  } finally {
    store.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// C2：失败复用的**端到端**消费者读数（HTTP 层）——告警不累加、读数 = 库内已提交值、修好后恢复
// ---------------------------------------------------------------------------
//
// 这条用例覆盖 C1/C2 在 store 层看不到的一面：`/api/summary` 的 `perf` 投影是否与库里
// **已提交**的 `perf_state` / `perf_source_warnings` / `perf_degraded_home_ids` 逐字一致，
// 以及连续多轮（每次请求都触发一次 sync）复用之后告警既不丢失也不累加。

const C2_API_ROOT = mkdtempSync(path.join(os.tmpdir(), "c2-codex-api-"));
process.on("exit", () => rmSync(C2_API_ROOT, { recursive: true, force: true }));

function c2ApiWrite(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return file;
}

test("C2 · 端到端 API：坏 rollout 的告警跨多轮不累加、读数 = 库内已提交值、修好后恢复 ready", async () => {
  const homeDir = path.join(C2_API_ROOT, "codex-home");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  const healthy = c2ApiWrite(path.join(sessionsDir, "rollout-a.jsonl"), [
    { type: "session_meta", payload: { id: "ApiThread-A", session_id: "ApiThread-A", source: "cli" } },
    { type: "turn_context", payload: { thread_id: "ApiThread-A", turn_id: "Turn-1", model: "C2-Model" } },
    {
      type: "token_usage_record",
      timestamp: "2026-10-04T12:00:01.000Z",
      payload: {
        thread_id: "ApiThread-A",
        turn_id: "Turn-1",
        response_id: "resp-api-a",
        usage: { output_tokens: 120 },
        turn_token_usage: { output_tokens: 120 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "ApiThread-A",
        turn_id: "Turn-1",
        item: { id: "I1", type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    },
  ]);
  const badFile = path.join(sessionsDir, "rollout-b.jsonl");
  writeFileSync(
    badFile,
    `${JSON.stringify({ type: "session_meta", payload: { id: "ApiThread-B", session_id: "ApiThread-B" } })}\n{not json\n`,
    "utf8",
  );
  const options = {
    homeDir: C2_API_ROOT,
    env: {},
    extraHomes: homeDir,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const server = createUsageServer({
    ...options,
    databaseFile: path.join(C2_API_ROOT, "index.sqlite"),
    importStoreFile: path.join(C2_API_ROOT, "imports.json"),
    heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const getSummary = async (skipCheck = true) => {
    const response = await fetch(`${baseUrl}/api/summary?preset=all${skipCheck ? "&skipCheck=1" : ""}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = await getSummary(false);
    assert.equal(first.summary.perf.state, "degraded", "坏 rollout 必须让 perf 进入 degraded");
    assert.equal(
      first.summary.perf.sourceWarnings.some((warning) => warning.code === "MALFORMED_JSON"),
      true,
      "坏 rollout 的归因必须抵达消费者",
    );
    const warningCount = (body) =>
      body.summary.perf.sourceWarnings.reduce((total, warning) => total + Number(warning.count ?? 0), 0);
    const baseline = warningCount(first);
    assert.equal(baseline >= 1, true);
    for (const round of [2, 3, 4]) {
      const body = await getSummary(false);
      assert.equal(body.summary.perf.state, "degraded", `第 ${round} 轮状态`);
      assert.equal(warningCount(body), baseline, `第 ${round} 轮告警不得丢失也不得累加`);
      assert.deepEqual(body.summary.perf.sourceWarnings, first.summary.perf.sourceWarnings);
      // 消费者读数 = 库内**已提交**值（C2 的复用轮重放必须与库内投影逐字一致）。
      assert.deepEqual(body.summary.perf.degradedHomeIds, first.summary.perf.degradedHomeIds);
      assert.deepEqual(body.summary.perf.groups, first.summary.perf.groups, `第 ${round} 轮排名分组不得变化`);
    }
    // 修好坏 rollout ⇒ 下一轮必须回到 ready 并清空告警（复用不得把失败粘住）。
    writeFileSync(
      badFile,
      `${JSON.stringify({ type: "session_meta", payload: { id: "ApiThread-B", session_id: "ApiThread-B" } })}\n${JSON.stringify({ type: "turn_context", payload: { thread_id: "ApiThread-B", turn_id: "Turn-1", model: "C2-Model" } })}\n`,
      "utf8",
    );
    const recovered = await getSummary(false);
    assert.equal(recovered.summary.perf.state, "ready", "坏内容修好后必须恢复 ready");
    assert.deepEqual(recovered.summary.perf.sourceWarnings, []);
    assert.deepEqual(recovered.summary.perf.degradedHomeIds, []);
    assert.equal(readFileSync(healthy, "utf8").includes("ApiThread-A"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("L1 published perf revision changes the shared status/usage fingerprint and preserves frozen reads", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  let server;
  try {
    await store.sync({ options: fixture.reportOptions });
    server = createUsageServer({
      ...fixture.serverOptions,
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);

    const initial = await getJson(baseUrl, "usage", "preset=all&skipCheck=1");
    assert.equal(initial.summary.perf.models.length, 1);
    assert.equal(initial.summary.perf.models[0].state, "missing_duration");
    assert.equal(initial.summary.perf.models[0].candidateCount, 25);
    assert.equal(initial.summary.perf.models[0].n, 0);
    assert.equal(initial.summary.perf.models[0].averageTps, null);
    assert.deepEqual(initial.summary.perf.groups, []);
    const initialStatus = await getJson(baseUrl, "status", `since=${initial.fingerprint}`);
    assert.equal(initialStatus.changed, false);
    assert.equal(initialStatus.fingerprint, initial.fingerprint);

    const initialFrozen = await getJson(baseUrl, "usage", "preset=all&freeze=1&skipCheck=1");
    assert.ok(initialFrozen.snapshotId);
    assert.deepEqual(initialFrozen.summary.perf.models, initial.summary.perf.models);

    const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.codexHome));
    assert.ok(home);
    const initialTimingRecords = fixture.timingRecords.filter(
      (record) => !record.responseId.startsWith("response-25-"),
    );
    const imported = store.importRequestTimingEvidence({
      homeId: String(home.id),
      records: initialTimingRecords,
      reviewedOrigins: ["fixture@1"],
    });
    assert.equal(imported.changed, true);
    const pendingStatus = await getJson(baseUrl, "status", `since=${initial.fingerprint}`);
    assert.equal(pendingStatus.changed, true);
    assert.notEqual(pendingStatus.fingerprint, initial.fingerprint);
    const stablePendingStatus = await getJson(baseUrl, "status", `since=${pendingStatus.fingerprint}`);
    assert.equal(stablePendingStatus.changed, false);
    assert.equal(stablePendingStatus.fingerprint, pendingStatus.fingerprint);

    const published = await getJson(baseUrl, "usage", "preset=all");

    const changedStatus = await getJson(baseUrl, "status", `since=${initial.fingerprint}`);
    assert.equal(changedStatus.changed, true);
    assert.notEqual(changedStatus.fingerprint, initial.fingerprint);
    assert.equal(published.fingerprint, changedStatus.fingerprint);

    const live = await getJson(baseUrl, "usage", "preset=all&skipCheck=1");
    const summary = await getJson(baseUrl, "summary", "preset=all&skipCheck=1");
    assert.equal(live.fingerprint, changedStatus.fingerprint);
    assert.equal(summary.fingerprint, changedStatus.fingerprint);
    assert.equal(live.summary.perf.models[0].n, 24);
    assert.equal(summary.summary.perf.models[0].n, 24);

    const stableStatus = await getJson(baseUrl, "status", `since=${live.fingerprint}`);
    assert.equal(stableStatus.changed, false);
    assert.equal(stableStatus.fingerprint, live.fingerprint);

    const externalImport = store.importRequestTimingEvidence({
      homeId: String(home.id),
      records: fixture.timingRecords.filter((record) => record.responseId.startsWith("response-25-")),
      reviewedOrigins: ["fixture@1"],
    });
    assert.equal(externalImport.changed, true);
    await store.sync({ options: fixture.reportOptions });

    // Only status may observe the external store.sync; an already-open page does not fetch usage first.
    const externalStatus = await getJson(baseUrl, "status", `since=${live.fingerprint}`);
    assert.equal(externalStatus.changed, true);
    assert.notEqual(externalStatus.fingerprint, live.fingerprint);

    const externalLive = await getJson(baseUrl, "usage", "preset=all&skipCheck=1");
    const externalSummary = await getJson(baseUrl, "summary", "preset=all&skipCheck=1");
    assert.equal(externalLive.fingerprint, externalStatus.fingerprint);
    assert.equal(externalSummary.fingerprint, externalStatus.fingerprint);
    assert.equal(externalLive.summary.perf.models[0].n, 25);
    assert.equal(externalSummary.summary.perf.models[0].n, 25);

    const externalStableStatus = await getJson(baseUrl, "status", `since=${externalLive.fingerprint}`);
    assert.equal(externalStableStatus.changed, false);
    assert.equal(externalStableStatus.fingerprint, externalLive.fingerprint);

    const duplicate = store.importRequestTimingEvidence({
      homeId: String(home.id),
      records: fixture.timingRecords,
      reviewedOrigins: ["fixture@1"],
    });
    assert.equal(duplicate.changed, false);
    const duplicateStatus = await getJson(baseUrl, "status", `since=${externalLive.fingerprint}`);
    assert.equal(duplicateStatus.changed, false);
    assert.equal(duplicateStatus.fingerprint, externalLive.fingerprint);

    assert.throws(
      () =>
        store.importRequestTimingEvidence({
          homeId: String(home.id),
          records: [{ ...fixture.timingRecords[0], durationMs: fixture.timingRecords[0].durationMs + 1 }],
          reviewedOrigins: ["unreviewed@1"],
        }),
      (error) => error.code === "REQUEST_TIMING_ORIGIN_UNREVIEWED",
    );
    const afterConflict = await getJson(baseUrl, "usage", "preset=all&skipCheck=1");
    const afterConflictSummary = await getJson(baseUrl, "summary", "preset=all&skipCheck=1");
    const afterConflictStatus = await getJson(baseUrl, "status", `since=${externalLive.fingerprint}`);
    assert.equal(afterConflict.fingerprint, externalLive.fingerprint);
    assert.equal(afterConflictSummary.fingerprint, externalLive.fingerprint);
    assert.equal(afterConflictStatus.changed, false);
    assert.equal(afterConflictStatus.fingerprint, externalLive.fingerprint);
    assert.equal(afterConflict.summary.perf.models[0].n, 25);
    assert.equal(afterConflictSummary.summary.perf.models[0].n, 25);

    const frozen = await getJson(
      baseUrl,
      "usage",
      `preset=all&snapshot=${encodeURIComponent(initialFrozen.snapshotId)}`,
    );
    assert.equal(frozen.fingerprint, initialFrozen.fingerprint);
    assert.deepEqual(frozen.summary.perf.models, initialFrozen.summary.perf.models);
    assert.deepEqual(frozen.summary.perf.groups, []);
  } finally {
    if (server) await server.close();
    store.close();
    fixture.close();
  }
});
