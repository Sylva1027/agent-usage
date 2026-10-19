import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageServer } from "../src/server.js";
import { renderPerfCoverageHtml, renderPerfDetailHtml } from "../public/perf-ui.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

test("M7 Codex estimate reaches dashboard, summary, full detail, UI labels, and immutable snapshots", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const server = createUsageServer({
    ...fixture.serverOptions,
    heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const get = async (route, query) => {
    const response = await fetch(`${baseUrl}/api/${route}?${query}`);
    assert.equal(response.status, 200, `${route}?${query}`);
    return response.json();
  };

  try {
    const dashboard = await get("usage", "preset=all&view=dashboard&skipCheck=1");
    const summary = await get("summary", "preset=all&skipCheck=1");
    const full = await get("usage", "preset=all&detail=full&skipCheck=1");
    const frozen = await get("usage", "preset=all&freeze=1&skipCheck=1");

    for (const body of [dashboard, summary, full, frozen]) {
      const perf = body.summary.perf;
      assert.equal(perf.state, "ready");
      assert.equal(perf.groups.length, 1);
      assert.equal(perf.groups[0].sourceKind, "codex");
      assert.equal(perf.groups[0].timingKind, "item_span_estimate");
      assert.equal(perf.groups[0].tokenScope, "reported_output_includes_reasoning");
      assert.equal(perf.groups[0].agentKind, "unknown");
      assert.deepEqual(perf.groups[0].tps, fixture.expected.tps);
      assert.deepEqual(perf.coverage, summary.summary.perf.coverage);
    }
    assert.deepEqual(dashboard.summary.perf.groups, summary.summary.perf.groups);
    assert.deepEqual(full.summary.perf.groups, summary.summary.perf.groups);
    assert.ok(full.report);
    assert.equal("perfSamples" in full.report, false);
    assert.equal("perfMeta" in full.report, false);
    assert.doesNotMatch(JSON.stringify(full), /sampleKey|sourcePath|fixture-codex-thread/);

    const group = dashboard.summary.perf.groups[0];
    const detailZh = renderPerfDetailHtml(group, dashboard.summary.perf.coverage);
    const detailEn = renderPerfDetailHtml(group, dashboard.summary.perf.coverage, { locale: "en-US" });
    const coverageZh = renderPerfCoverageHtml(dashboard.summary.perf);
    assert.match(detailZh, /轮级 item 时窗 TPS 估算/);
    assert.match(detailZh, /代理未知/);
    assert.match(detailEn, /Turn-level item-window TPS estimate/);
    assert.match(detailEn, /Unknown agent/);
    assert.match(coverageZh, /近期/);
    assert.match(coverageZh, /历史/);

    const snapshotId = frozen.snapshotId;
    assert.ok(snapshotId);
    const frozenSummary = await get("summary", `preset=all&snapshot=${snapshotId}`);
    const livePath = fixture.rolloutFiles[0];
    const liveBefore = readFileSync(livePath, "utf8");
    writeFileSync(livePath, liveBefore.replaceAll('"output_tokens":100', '"output_tokens":150'));
    const live = await get("summary", "preset=all");
    assert.notEqual(live.summary.perf.indexVersion, frozen.summary.perf.indexVersion);
    assert.notDeepEqual(live.summary.perf.groups[0].tps, frozen.summary.perf.groups[0].tps);
    assert.deepEqual(
      (await get("summary", `preset=all&snapshot=${snapshotId}`)).summary.perf,
      frozenSummary.summary.perf,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
