// W1-a：唯一数据库持有者（执行器）的契约测试。
//
// 覆盖 W1 的三条根因对应的**可观测契约**（不重复 server.test.js 的端到端期望）：
//   1. 执行器独占 `DatabaseSync`：主线程客户端**没有** `database`，只有读侧快照；
//   2. `metadata()` 是"最后一次发布"的读侧快照；**时点语义**必须走 `metadataFor(asOf)`（RC2）；
//   3. `summarize`/`periodComparison` 是 Promise（RC1），结果形状与同步版一致；
//   4. `snapshot` 由执行器做 `backup` 并返回**绑定该 asOf** 的读侧状态（RC3 的执行器半）；
//   5. 连接生命周期归执行器：`close()` 后库文件可删（Windows EBUSY/EPERM 教训）；
//   6. `/api/status` 在主线程就地应答（只扫 fs，状态集 = ∅），执行器在忙也不转发。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { createUsageExecutor } from "../src/usage-executor.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

function isolatedOptions(root, fixture) {
  return {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [fixture.codexHome],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
}

async function seedRequestTiming(fixture, options) {
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    await fixture.seedRequestTiming(store);
  } finally {
    store.close();
  }
}

test("dashboard skipCheck reinitializes the executor after a crash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "executor-dashboard-recovery-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const ledgerFile = path.join(root, ".config", "magpie", "usage.jsonl");
  await mkdir(path.dirname(ledgerFile), { recursive: true });
  await writeFile(ledgerFile, "invalid\n");
  const originalPostMessage = Worker.prototype.postMessage;
  let activeWorker;
  Worker.prototype.postMessage = function (message, ...args) {
    if (message.type === "dashboard") activeWorker = this;
    return originalPostMessage.call(this, message, ...args);
  };
  const server = createUsageServer(options);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/usage?preset=all&view=dashboard`;
    const before = await fetch(url);
    assert.equal(before.status, 200);
    const expected = await before.json();
    assert.ok(activeWorker);
    await activeWorker.terminate();
    const after = await fetch(`${url}&skipCheck=1`);
    const actual = await after.json();
    assert.equal(after.status, 200, JSON.stringify(actual));
    assert.equal(actual.fingerprint, expected.fingerprint);
    assert.deepEqual(actual.summary.totals, expected.summary.totals);
    assert.equal(actual.summary.perf.models.length, 1);
    assert.deepEqual(actual.summary.perf.models, expected.summary.perf.models);
    assert.deepEqual(actual.summary.perf.codexTimingCoverage, expected.summary.perf.codexTimingCoverage);
    assert.equal(actual.summary.perf.codexTimingCoverage.counts.sampled, fixture.expected.n);
    assert.ok(actual.metadata.harnessModels);
  } finally {
    Worker.prototype.postMessage = originalPostMessage;
    await server.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function withExecutor(body) {
  const root = await mkdtemp(path.join(tmpdir(), "w1-executor-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  const databaseFile = options.databaseFile;
  await seedRequestTiming(fixture, options);
  const executor = createUsageExecutor(options);
  try {
    return await body({ executor, databaseFile, root, fixture, options });
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("executor publication and snapshots are independent of a local Magpie installation", async () => {
  await withExecutor(async ({ executor, root, options }) => {
    await executor.sync({ options });
    const before = await executor.perfPublicationState();
    assert.ok(before.indexVersion);
    const ledgerFile = path.join(root, ".config", "magpie", "usage.jsonl");
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(ledgerFile, "invalid\n");
    await executor.sync({ options });
    assert.deepEqual(await executor.perfPublicationState(), before);
    await appendFile(ledgerFile, "unacknowledged\n");
    const dashboard = await executor.dashboard({ preset: "all" });
    assert.equal(dashboard.summary.perf.indexVersion, before.indexVersion);
    const frozen = await executor.snapshot({ databaseFile: path.join(root, "native-frozen.sqlite") });
    assert.equal(frozen.status.fingerprint, dashboard.status.fingerprint);
    const imported = createUsageExecutor(options);
    try {
      await imported.open({ imported: true, serviceTierEvidence: null });
      assert.deepEqual(await imported.perfPublicationState(), before);
    } finally {
      await imported.close();
    }
    await executor.sync({ options });
    assert.deepEqual(await executor.perfPublicationState(), before);
    assert.equal(frozen.status.fingerprint, dashboard.status.fingerprint);
  });
});

test("W1 · 执行器独占数据库连接：主线程客户端没有 database，只有读侧快照", async () => {
  await withExecutor(async ({ executor, databaseFile, options }) => {
    // 连接归属：客户端**不是** UsageStore，没有连接句柄。
    assert.equal(executor.database, undefined);
    assert.equal(typeof executor.metadata, "function");
    // 首次发布前读侧快照为空（不是抛错、也不是 {} 冒充）。
    assert.equal(executor.metadata(), null);
    const status = await executor.sync({ options: { ...options, force: true } });
    assert.ok(status, "sync 必须返回状态");
    const metadata = executor.metadata();
    assert.ok(metadata, "sync 完成后必须发布读侧快照");
    assert.ok(metadata.harnessModels, "读侧快照必须带 harnessModels（F3 症状的反面）");
    assert.ok(Array.isArray(metadata.homes));
    assert.ok(existsSync(databaseFile), "库文件由执行器创建");
  });
});

test("W1 · metadataFor(asOf) 在执行器内按该时刻现算（RC2：metadata() 忽略 asOf）", async () => {
  await withExecutor(async ({ executor, options }) => {
    await executor.sync({ options: { ...options, force: true } });
    const asOf = new Date(Date.now() - 60_000);
    const historical = await executor.metadataFor(asOf);
    assert.ok(historical.harnessModels, "按历史时刻算出的 metadata 仍必须是完整对象");
    assert.ok(historical.homes, "必须带 homes（不是只有 imports 的空壳）");
    assert.ok(Number.isFinite(Date.parse(historical.modelUsageAsOf)), "modelUsageAsOf 必须是可解析时刻");
    // 读侧快照与"按时刻现算"是两条不同路径：前者忽略参数，后者必须接受参数。
    assert.equal(typeof executor.metadataFor, "function");
    const live = await executor.metadataFor(new Date());
    assert.ok(Number.isFinite(Date.parse(live.modelUsageAsOf)));
  });
});

test("W1 · summarize / periodComparison 是 Promise，且形状与同步版一致（RC1）", async () => {
  await withExecutor(async ({ executor, fixture, options }) => {
    await executor.sync({ options: { ...options, force: true } });
    const pending = executor.summarize({ preset: "all", now: new Date() });
    assert.ok(pending instanceof Promise, "summarize 必须是 Promise（跨线程 ⇒ 不可再同步调用）");
    const summary = await pending;
    assert.ok(summary.totals, "summary.totals 必须存在（F1 症状的反面）");
    assert.ok(summary.range, "summary.range 必须存在");
    assert.equal(summary.perf.models.length, 1, "执行器消息必须保留模型速度行");
    const model = summary.perf.models[0];
    assert.deepEqual(Object.keys(model).sort(), [
      "averageTps",
      "firstSampleAtMs",
      "key",
      "lastSampleAtMs",
      "model",
      "modelProvider",
      "n",
      "p10",
      "p90",
      "rank",
      "rankState",
      "reasoningEffort",
      "sourceKind",
      "state",
      "window",
    ]);
    assert.equal(model.key, JSON.stringify(["codex", fixture.expected.model, "high", ""]));
    assert.equal(model.averageTps, fixture.expected.tps.pooled);
    assert.equal(model.n, fixture.expected.n);
    const comparison = executor.periodComparison({ now: new Date() });
    assert.ok(comparison instanceof Promise, "periodComparison 必须是 Promise");
    const periods = await comparison;
    assert.ok(periods.asOf, "periodComparison.asOf 必须存在");
    assert.ok(Array.isArray(periods.periods ?? periods.current ?? []) || periods.current !== undefined);
  });
});

test("R09 · 并发请求各自绑定自己的价格目录", async () => {
  const original = getPricingCatalog();
  try {
    await withExecutor(async ({ executor, options }) => {
      const candidate = structuredClone(original);
      candidate.checkedAt = "2026-10-24";
      candidate.models["gpt-6-sol"].short = { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 2 };
      candidate.models["gpt-6-sol"].long = { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 2 };

      const database = new DatabaseSync(options.databaseFile);
      try {
        database
          .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run("/fixture/usage.jsonl", "main", "home-a", "Home A", options.homeDir, 1, 1, "2026-10-24T00:00:00.000Z");
        database
          .prepare(
            `INSERT INTO events (
               source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
               hour_key, day_key, week_key, month_key, detail_mask, cache_write_tokens, cache_write_known,
               request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "/fixture/usage.jsonl",
            Date.parse("2026-10-24T02:00:00Z"),
            "session-a",
            "home-a",
            "Home A",
            "CLI",
            "project",
            "gpt-6-sol",
            "2026-10-24 02",
            "2026-10-24",
            "2026-10-19",
            "2026-10",
            15,
            0,
            1,
            0,
            "short",
            "standard",
            "fixture",
            1010,
            1000,
            0,
            10,
            0,
          );
      } finally {
        database.close();
      }
      await executor.sync({ options: { ...options, force: true } });

      const catalogA = setPricingCatalog(candidate);
      const pendingA = executor.dashboard({ preset: "all" }, { includeDetails: false });

      candidate.checkedAt = "2026-10-25";
      candidate.models["gpt-6-sol"].short = { input: 10, cachedInput: 1, cacheWrite: 0, output: 20 };
      candidate.models["gpt-6-sol"].long = { input: 10, cachedInput: 1, cacheWrite: 0, output: 20 };
      const catalogB = setPricingCatalog(candidate);
      const pendingB = executor.dashboard({ preset: "all" }, { includeDetails: false });
      const [dashboardA, dashboardB] = await Promise.all([pendingA, pendingB]);

      assert.deepEqual(dashboardA.pricingCatalog, catalogA);
      assert.deepEqual(dashboardB.pricingCatalog, catalogB);
      assert.deepEqual(dashboardA.summary.costEstimate.priceVersions, [catalogA.version]);
      assert.deepEqual(dashboardB.summary.costEstimate.priceVersions, [catalogB.version]);
      assert.ok(dashboardA.summary.costEstimate.totalUsd > 0);
      assert.ok(dashboardB.summary.costEstimate.totalUsd > dashboardA.summary.costEstimate.totalUsd);
    });
  } finally {
    setPricingCatalog(original);
  }
});

test("W1 · snapshot 由执行器 backup，并返回绑定该 asOf 的读侧状态（RC3 执行器半）", async () => {
  await withExecutor(async ({ executor, root, options }) => {
    await executor.sync({ options: { ...options, force: true } });
    const databaseFile = path.join(root, "frozen-copy.sqlite");
    const asOf = new Date();
    const frozen = await executor.snapshot({ databaseFile, asOf: asOf.getTime() });
    assert.ok(existsSync(databaseFile), "备份文件必须由执行器写出");
    assert.ok((await stat(databaseFile)).size > 0);
    assert.equal(frozen.asOf, asOf.getTime(), "返回体必须绑定调用方给的 asOf");
    assert.ok(frozen.metadata?.harnessModels, "冻结 metadata 必须带 harnessModels（F3）");
    assert.ok(Array.isArray(frozen.homes));
    // 备份确实是**可读的库**（而不是空文件）：主线程另开连接读它（冻结副本路径允许）。
    const copy = new DatabaseSync(databaseFile);
    try {
      assert.ok(Number(copy.prepare("SELECT COUNT(*) AS n FROM events").get().n) >= 0);
    } finally {
      copy.close();
    }
    // 执行器返回体**不带** `id`：快照句柄是主线程簿记（RC3 主线程半，见 src/server.js）。
    assert.equal(frozen.id, undefined);
  });
});

test("W1 · close() 释放连接：库文件与目录可立即删除（Windows EBUSY/EPERM 教训）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-executor-close-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const executor = createUsageExecutor(options);
  await executor.sync({ options: { ...options, force: true } });
  await executor.close();
  fixture.close();
  // 不重试：close() 必须已经等到执行器释放连接（否则这里会 EPERM/EBUSY）。
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
});

test("W1 · /api/status 在主线程就地应答：执行器在飞时仍快速返回", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-status-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const server = createUsageServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const inFlight = fetch(`${base}/api/usage?preset=all`).then((response) => response.json());
    const started = performance.now();
    const status = await fetch(`${base}/api/status`).then((response) => response.json());
    const ms = performance.now() - started;
    assert.ok(status.fingerprint, "/api/status 必须由主线程算指纹");
    assert.ok(ms < 250, `/api/status 不得被在飞的重请求拖住（实测 ${ms.toFixed(1)} ms）`);
    await inFlight;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// W1-b：故障路径与发布语义契约（突变靶子；三家族）
// ---------------------------------------------------------------------------
const RETRYABLE_CODES = new Set(["EXECUTOR_UNAVAILABLE", "EXECUTOR_EXITED", "EXECUTOR_TIMEOUT", "EXECUTOR_CLOSED"]);
const settledWithin = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => ({ state: "resolved", value }),
      (error) => ({ state: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ state: "hung" }), ms)),
  ]);

test("W1-b · 家族①：请求超时必须以可重试错误结算，绝不挂死", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-timeout-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  // 1 ms 超时：任何真实请求都来不及应答 ⇒ 必然走超时路径。
  const executor = createUsageExecutor(options, { requestTimeoutMs: 1 });
  try {
    const outcome = await settledWithin(executor.summarize({ preset: "all", now: new Date() }), 5000);
    assert.notEqual(outcome.state, "hung", "超时请求必须结算（不得挂死）");
    assert.equal(outcome.state, "rejected", "超时必须 reject");
    assert.ok(
      RETRYABLE_CODES.has(outcome.error?.code),
      `超时错误码必须可重试，实际 ${outcome.error?.code}：${outcome.error?.message}`,
    );
    assert.equal(outcome.error.retryable, true, "超时错误必须标记 retryable");
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W1-b · 家族①：执行器内失败必须以可重试错误返回（不挂死、不 500）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-failfast-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const executor = createUsageExecutor(options);
  try {
    await executor.sync({ options: { ...options, force: true } });
    // 故意让执行器内的 `backup` 失败（目标目录不存在）⇒ 必须返回可重试错误而不是抛栈/挂死。
    const outcome = await settledWithin(
      executor.snapshot({ databaseFile: path.join(root, "no-such-dir", "copy.sqlite"), asOf: Date.now() }),
      10_000,
    );
    assert.notEqual(outcome.state, "hung", "执行器内失败必须结算");
    assert.equal(outcome.state, "rejected", "执行器内失败必须 reject");
    assert.equal(outcome.error.retryable, true, "执行器内失败必须标记 retryable（可重试）");
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W1-b · 家族①：close() 必须在执行器退出后迅速落定（显式 flush 语义）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-closeflush-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const executor = createUsageExecutor(options);
  await executor.sync({ options: { ...options, force: true } });
  const started = performance.now();
  await executor.close();
  const ms = performance.now() - started;
  fixture.close();
  // close() 之后**不再重试**地删目录：这就是"连接已释放"的可执行判据。
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, "close() 之后必须能立即删除库目录");
  assert.ok(ms < 2000, `close() 必须在执行器退出后立即落定，实测 ${ms.toFixed(1)} ms（不得等满 CLOSE_TIMEOUT）`);
});

test("W1-b · 家族②：读侧快照要么为空、要么完整 —— 绝不发布半成品", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-publish-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const executor = createUsageExecutor(options);
  try {
    await executor.sync({ options: { ...options, force: true } });
    const published = executor.metadata();
    assert.ok(published?.harnessModels, "首次 sync 后必须发布完整快照");
    // 完整态的形状契约（= `store.metadata()` 的形状）：模型表存在且 `homes` 是数组。
    const isComplete = (state) =>
      state !== null && state !== undefined && Boolean(state.harnessModels) && Array.isArray(state.homes);
    const samples = [];
    // 多轮发布各自采样，避免单次同步太快而把正确实现误判为空转。
    for (let round = 0; round < 5; round += 1) {
      let settled = false;
      const inFlight = executor.sync({ options: { ...options, force: true } }).then((status) => {
        settled = true;
        return status;
      });
      // **必须让出事件环**：执行器发布的消息只有让出后才到得了主线程。原先的紧循环
      // 一次都不让出 ⇒ 半发布消息到不了主线程 ⇒ 这条不变量实际上没被钉住（突变 MISSED）。
      while (!settled && samples.length < 5000) {
        samples.push(executor.metadata());
        await new Promise((resolve) => setImmediate(resolve));
      }
      await inFlight;
    }
    const half = samples.filter((item) => item !== null && !isComplete(item));
    assert.equal(
      half.length,
      0,
      `发布必须原子：已发布的快照不得在中途退化成半成品（在飞期间采样 ${samples.length} 次，观测到 ${half.length} 次半成品，首个样例 ${JSON.stringify(half[0])?.slice(0, 200)}）`,
    );
    assert.ok(samples.length >= 5, `必须真的在同步在飞期间采到样本（实测 ${samples.length} 次）—— 否则这条断言是空转`);
    assert.ok(executor.metadata()?.harnessModels, "sync 结束后快照必须仍是完整的");
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W1-b · 家族②：/api/status 只读已发布快照，不与执行器的重活竞争", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-status-snapshot-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const server = createUsageServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 先做一次冷同步（重活），再由执行器持续承担重请求；期间 `/api/status` 必须每个都很轻。
    const heavy = [fetch(`${base}/api/usage?preset=all`).then((r) => r.json())];
    const latencies = [];
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      const status = await fetch(`${base}/api/status`).then((r) => r.json());
      latencies.push(performance.now() - started);
      assert.ok(status.fingerprint, "/api/status 必须由主线程算指纹（不依赖执行器）");
    }
    await Promise.all(heavy);
    const worst = Math.max(...latencies);
    assert.ok(worst < 250, `/api/status 必须就地应答（最差 ${worst.toFixed(1)} ms）`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W1-b · 家族③：两轮并发 sync 必须合并成一次（syncPromise 去重）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-syncmerge-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  // 直接数"向执行器发出的 sync 消息"：`checkedAt` 相等并不能证明只跑了一次（两次同步
  // 也会得到同一个 checkedAt）⇒ 必须计数。插桩只包住 `Worker.prototype.postMessage`，
  // 不改产品文件、不改 schema。
  const originalPostMessage = Worker.prototype.postMessage;
  const syncMessages = [];
  Worker.prototype.postMessage = function countedPostMessage(message, ...rest) {
    if (message && message.type === "sync") syncMessages.push({ id: message.id, at: Date.now() });
    return originalPostMessage.call(this, message, ...rest);
  };
  const server = createUsageServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 先热一轮（把启动期可能存在的同步清干净），再把计数归零。
    await fetch(`${base}/api/usage?preset=all`).then((r) => r.json());
    syncMessages.length = 0;
    // 两个**同时**发出的重请求 ⇒ 只允许跑一次 sync（同一 checkedAt + 只有一条 sync 消息）。
    const [left, right] = await Promise.all([
      fetch(`${base}/api/usage?preset=all`).then((r) => r.json()),
      fetch(`${base}/api/usage?preset=all`).then((r) => r.json()),
    ]);
    assert.ok(left.checkedAt, "响应必须带 checkedAt");
    assert.equal(left.checkedAt, right.checkedAt, "两轮并发 sync 必须合并成一次（checkedAt 必须相同）");
    assert.equal(
      syncMessages.length,
      1,
      `两轮并发 sync 只允许向执行器发出一次 sync 消息（实测 ${syncMessages.length} 次：${JSON.stringify(syncMessages)}）`,
    );
  } finally {
    Worker.prototype.postMessage = originalPostMessage;
    await new Promise((resolve) => server.close(resolve));
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W1-b · 收口：server.close() 无回调时返回 Promise，且只有执行器释放后才 settle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w1-server-close-promise-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  await seedRequestTiming(fixture, options);
  const server = createUsageServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await fetch(`http://127.0.0.1:${server.address().port}/api/usage?preset=all`).then((r) => r.json());
  const closed = server.close();
  assert.ok(closed instanceof Promise, "server.close() 无回调时必须返回 Promise（显式 flush 语义）");
  await closed;
  fixture.close();
  // 不重试：Promise settle 之后目录必须已经可删。
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, "await server.close() 之后必须能立即删除库目录");
});
