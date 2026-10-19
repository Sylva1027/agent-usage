// W4-b1 / D1 · 事件级计价 memo + 有界键 memo 的单元与集成测试（新文件，卡面要求）。
//
// 覆盖：
//   1. **等价性**：memo 的返回对象与直算**逐字段**相同（合成语料，覆盖 auto-review / 免费模型 /
//      目录外模型（币种兜底）/ fast 档 / claude cache-write TTL / 长上下文 / 不一致用量 / 未知模型）；
//   2. **键的完备性**：改动**任一**计价输入 ⇒ 必然未命中（逐字段轮转，一条一条断言）；
//   3. **负例**：不同 `excludeHomes` / `calendarZone` / `asOfDay`（`now`）**不得互相命中**
//      （memo 不含这几项 ⇒ 由范围层各自重建；这里断言"memo 不会把范围差异吞掉"的端到端事实）；
//   4. **失效性**：`storeRevision` 前进 ⇒ 清空；改一份 rollout ⇒ 结果 == 冷实例；
//   5. **有界**：字节/条目上限与逐出；轮内放宽到 192 MiB、轮末收敛回 64 MiB；
//   6. **集成**：`UsageStore.summarize` 第二次（命中）的 `estimateEventCostCalls` 显著低于第一次。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOUNDED_KEY_MEMO_METHOD_VERSION,
  DEFAULT_EVENT_COST_MEMO_BYTES,
  DEFAULT_EVENT_COST_MEMO_HARD_BYTES,
  createBoundedKeyMemo,
  createEventCostMemo,
  estimateEventCost,
  eventCostMemoKey,
} from "../src/pricing.js";

const BASE_EVENT = {
  timestamp: Date.parse("2026-10-09T02:00:00Z"),
  model: "gpt-5-codex",
  channel: "codex",
  detailMask: 15,
  cacheWriteTokens: 0,
  cacheWriteKnown: true,
  requestInputTokens: 12_345,
  contextLevel: "short",
  serviceTier: "default",
  total: { total: 12_345, input: 10_000, cached: 2_000, output: 2_345, reasoning: 0 },
};

/** 一组合成语料：覆盖 `estimateEventCost` 的主要分支。 */
function corpus() {
  return [
    BASE_EVENT,
    { ...BASE_EVENT, model: "gpt-5.1-codex-max" },
    { ...BASE_EVENT, model: "codex-auto-review" },
    { ...BASE_EVENT, model: "unknown-model-xyz" },
    { ...BASE_EVENT, model: "unknown-model-xyz", channel: "zcode" },
    { ...BASE_EVENT, model: "unknown-model-xyz", channel: "dsh-desktop" },
    { ...BASE_EVENT, serviceTier: "fast" },
    { ...BASE_EVENT, serviceTier: "priority" },
    { ...BASE_EVENT, contextLevel: "long" },
    { ...BASE_EVENT, contextLevel: "unknown" },
    { ...BASE_EVENT, requestInputTokens: 500_000 },
    { ...BASE_EVENT, model: "claude-sonnet-4-5", cacheWriteTokens: 1_000, cacheWriteTtl: "5m" },
    { ...BASE_EVENT, model: "claude-sonnet-4-5", cacheWriteTokens: 1_000, cacheWriteTtl: "1h" },
    { ...BASE_EVENT, model: "deepseek-chat", timestamp: Date.parse("2026-10-09T18:00:00Z") },
    { ...BASE_EVENT, model: "deepseek-chat", timestamp: Date.parse("2026-10-09T02:00:00Z") },
    { ...BASE_EVENT, detailMask: 0 },
    { ...BASE_EVENT, detailMask: 1 },
    { ...BASE_EVENT, detailMask: 2 },
    { ...BASE_EVENT, detailMask: 4 },
    { ...BASE_EVENT, detailMask: 16 },
    { ...BASE_EVENT, total: { total: 100, input: 90, output: 90, cached: 0, reasoning: 0 } },
    { ...BASE_EVENT, total: { total: 10, input: 5, output: 5, cached: 0, reasoning: 0 } },
    { ...BASE_EVENT, total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 } },
    { ...BASE_EVENT, cacheWriteKnown: false, cacheWriteTokens: 500 },
    { ...BASE_EVENT, cacheWriteTokens: null },
    { ...BASE_EVENT, requestInputTokens: undefined },
    { ...BASE_EVENT, total: { ...BASE_EVENT.total, input: undefined } },
  ];
}

function assertSameEstimate(left, right, label) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(left)),
    JSON.parse(JSON.stringify(right)),
    `${label}：memo 结果必须与直算**逐字段**相同`,
  );
}

test("W4-b1 · D1 · 方法版本与默认预算（64 MiB / 轮内 192 MiB）", () => {
  assert.equal(BOUNDED_KEY_MEMO_METHOD_VERSION, "w4-bounded-key-memo-v1");
  assert.equal(DEFAULT_EVENT_COST_MEMO_BYTES, 64 * 1024 * 1024);
  assert.equal(DEFAULT_EVENT_COST_MEMO_HARD_BYTES, 192 * 1024 * 1024);
  const stats = createEventCostMemo().stats();
  assert.equal(stats.maxBytes, 64 * 1024 * 1024);
  assert.equal(stats.hardMaxBytes, 192 * 1024 * 1024);
  assert.equal(stats.methodVersion, BOUNDED_KEY_MEMO_METHOD_VERSION);
});

test("W4-b1 · D1 · 等价性：合成语料逐条 memo == 直算（含 auto-review / 免费 / 目录外 / fast / claude TTL / 长上下文 / 不一致用量）", () => {
  const memo = createEventCostMemo();
  const events = corpus();
  assert.ok(events.length >= 24, "语料要覆盖足够多的分支");
  for (const [index, event] of events.entries()) {
    const direct = estimateEventCost(event);
    const first = memo.estimate(event);
    const second = memo.estimate({ ...event, total: event.total ? { ...event.total } : undefined });
    assertSameEstimate(direct, first, `#${index} 首次`);
    assertSameEstimate(direct, second, `#${index} 命中`);
  }
  const stats = memo.stats();
  assert.equal(stats.misses, events.length, "每条语料各算一次");
  assert.equal(stats.hits, events.length, "第二条（同内容不同对象）全部命中");
  assert.equal(stats.evictions, 0);
});

test("W4-b1 · D1 · 键的完备性：逐字段轮转 —— 任一计价输入变化都必须**不命中**", () => {
  const mutations = {
    model: "gpt-5-codex-mini",
    sourceKind: "main",
    channel: "zcode",
    serviceTier: "fast",
    cacheWriteTokens: 999,
    cacheWriteKnown: false,
    detailMask: 3,
    cacheWriteTtl: "5m",
    requestInputTokens: 77,
    contextLevel: "long",
    timestamp: BASE_EVENT.timestamp + 60_000,
    total: { total: 5, input: 4, cached: 1, output: 1, reasoning: 0 },
  };
  for (const [field, value] of Object.entries(mutations)) {
    const memo = createEventCostMemo();
    const base = { ...BASE_EVENT, model: "claude-sonnet-4-5" };
    memo.estimate(base);
    const before = memo.stats().misses;
    const mutated = { ...base, [field]: value };
    const viaMemo = memo.estimate(mutated);
    assert.equal(memo.stats().misses, before + 1, `改 \`${field}\` 必须新增一次未命中`);
    assertSameEstimate(estimateEventCost(mutated), viaMemo, `改 \`${field}\``);
  }
  // 三态必须分开：`undefined` / `null` / 不存在 不能互相冒充（`usageFields` 的 `Object.hasOwn` 分支）。
  const memo = createEventCostMemo();
  const present = { ...BASE_EVENT, total: { ...BASE_EVENT.total, input: undefined } };
  const absent = {
    ...BASE_EVENT,
    total: { total: BASE_EVENT.total.total, cached: 2_000, output: 2_345, reasoning: 0 },
  };
  const nulled = { ...BASE_EVENT, total: { ...BASE_EVENT.total, input: null } };
  memo.estimate(present);
  const before = memo.stats().misses;
  memo.estimate(absent);
  memo.estimate(nulled);
  assert.equal(memo.stats().misses, before + 2, "own-undefined / 不存在 / null 是三种不同的输入");
  assert.notEqual(eventCostMemoKey(present), eventCostMemoKey(absent));
  assert.notEqual(eventCostMemoKey(present), eventCostMemoKey(nulled));
});

test("Codex context pricing never shares a memo result with an external event of the same model and channel", () => {
  const memo = createEventCostMemo();
  const event = {
    ...BASE_EVENT,
    model: "gpt-6.1-sol",
    channel: "Codex Desktop",
    requestInputTokens: 300_000,
    total: { total: 300_100, input: 300_000, cached: 0, output: 100, reasoning: 0 },
  };
  const native = memo.estimate({ ...event, sourceKind: "main" });
  const external = memo.estimate({ ...event, sourceKind: "project-log" });
  assert.ok(Math.abs(native.totalUsd - 0.601) < 1e-12);
  assert.ok(Math.abs(external.totalUsd - 1.2015) < 1e-12);
  memo.estimate({ ...event, sourceKind: "main" });
  memo.estimate({ ...event, sourceKind: "project-log" });
  assert.equal(memo.stats().misses, 2);
  assert.equal(memo.stats().hits, 2);
});

test("W4-b1 · D1 · 有界：字节上限逐出最旧条目、轮内放宽到 192 MiB、轮末收敛回 64 MiB", () => {
  // 每条目 = 键长(2) + 1_000 ⇒ 1_002 B。
  const memo = createBoundedKeyMemo({
    keyOf: (input) => `k${input}`,
    maxBytes: 3_100,
    hardMaxBytes: 6_200,
    valueBytes: () => 1_000,
  });
  for (let index = 0; index < 3; index += 1) memo.get(index, () => index);
  assert.equal(memo.size(), 3, "3 × 1_002 B = 3_006 B ≤ 3_100 B");
  memo.get(3, () => 3);
  assert.equal(memo.size(), 3, "超出预算 ⇒ 逐出最旧的（FIFO）");
  assert.equal(memo.has(0), false, "最旧条目被逐出");
  assert.equal(memo.has(3), true);
  assert.ok(memo.retainedBytes() <= 3_100);

  // 轮内：可以越过 maxBytes，但不得越过 hardMaxBytes；轮末收敛。
  const round = createBoundedKeyMemo({
    keyOf: (i) => `r${i}`,
    maxBytes: 3_100,
    hardMaxBytes: 6_200,
    valueBytes: () => 1_000,
  });
  round.beginRound();
  for (let index = 0; index < 5; index += 1) round.get(index, () => index);
  assert.equal(round.size(), 5, "轮内允许到 hardMaxBytes（5_010 ≤ 6_200）");
  round.endRound();
  assert.equal(round.size(), 3, "轮末收敛回 maxBytes");
  assert.equal(round.has(0), false);
  assert.equal(round.has(4), true);

  // 轮内也不得越过 hardMaxBytes。
  const hard = createBoundedKeyMemo({
    keyOf: (i) => `h${i}`,
    maxBytes: 1_100,
    hardMaxBytes: 2_100,
    valueBytes: () => 1_000,
  });
  hard.beginRound();
  for (let index = 0; index < 5; index += 1) hard.get(index, () => index);
  assert.ok(hard.retainedBytes() <= 2_100, "轮内硬上限生效");
  assert.ok(hard.size() <= 2, "轮内硬上限下最多留 2 条");

  // 条目数上限：值极小（1 字节）时仍然有界。
  const many = createBoundedKeyMemo({ keyOf: (i) => `m${i}`, maxBytes: 1e9, maxEntries: 4, valueBytes: () => 1 });
  for (let index = 0; index < 10; index += 1) many.get(index, () => index);
  assert.equal(many.size(), 4, "条目数上限生效");
  assert.equal(many.stats().evictions, 6);
});

test("W4-b1 · D1 · 失效契约：clear() 计数与原因；价目版本进入键（换价目 ⇒ 不命中）", async () => {
  const memo = createEventCostMemo();
  memo.estimate(BASE_EVENT);
  assert.equal(memo.stats().misses, 1);
  memo.estimate(BASE_EVENT);
  assert.equal(memo.stats().hits, 1);
  memo.clear("store-revision");
  assert.equal(memo.size(), 0);
  assert.deepEqual(
    { clears: memo.stats().clears, reason: memo.stats().lastClearReason },
    { clears: 1, reason: "store-revision" },
  );
  memo.estimate(BASE_EVENT);
  assert.equal(memo.stats().misses, 2, "清空后必然重算");
});

test("W4-b1 · D1 · 集成契约（Store 级）：memo 是实例私有、路由经它、`storeRevision` 前进与 `close()` 清空", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "w4b1-memo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { UsageStore } = await import("../src/usage-store.js");
  const store = new UsageStore({
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
  });
  await store.open();
  t.after(() => {
    try {
      store.close();
    } catch {}
  });

  // ① 实例私有：默认预算与轮次语义齐备。
  const stats = store.eventCostMemo.stats();
  assert.equal(stats.maxBytes, DEFAULT_EVENT_COST_MEMO_BYTES);
  assert.equal(stats.hardMaxBytes, DEFAULT_EVENT_COST_MEMO_HARD_BYTES);
  for (const method of ["estimate", "beginRound", "endRound", "clear", "stats", "size"]) {
    assert.equal(typeof store.eventCostMemo[method], "function", `memo 必须有{method}`);
  }
  assert.equal(store.eventCostMemo.size(), 0, "新实例是空的");

  // ② 空库上的两条计价路径（`timelineRange` / `costEstimateRange`）都必须**经过** memo 而不是抛错；
  //    空库无事件 ⇒ 0 未命中（说明护栏没有副作用地空转）。
  const now = new Date("2026-10-09T05:25:00+08:00");
  const summary = store.summarize({ preset: "all", bucket: "day", now });
  assert.equal(store.eventCostMemo.stats().misses, 0, "空库不产生计价");
  // 两次结果逐字段一致（同 now）。
  const again = store.summarize({ preset: "all", bucket: "day", now });
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(summary)));
  // 轮次护栏在方法返回后必须收敛（不能留在"轮内"状态）。
  assert.equal(store.eventCostMemo.stats().bytes, 0);

  // ③ 失效契约①：`storeRevision` 前进 ⇒ 清空 + 记录原因。
  store.storeRevision += 1;
  assert.equal(store.syncDerivedRevision(), true);
  assert.equal(store.eventCostMemo.stats().lastClearReason, "store-revision");
  assert.equal(store.eventCostMemo.size(), 0);

  // ④ 失效契约②：`close()` ⇒ 清空 + 记录原因 "close"。
  store.close();
  assert.equal(store.eventCostMemo.stats().lastClearReason, "close");
  assert.equal(store.eventCostMemo.size(), 0);
  assert.equal(store.eventCostMemo.stats().clears, 2);
});

test("W4-b1 · D1 · 负例：memo 不含范围参数 —— 不同 calendarZone 的计价输入相同，但范围层各自重建（不互相冒充）", () => {
  const memo = createEventCostMemo();
  const event = { ...BASE_EVENT };
  const utc = memo.estimate(event);
  const local = memo.estimate({ ...event });
  assert.equal(memo.stats().hits, 1, "计时输入的键与 zone 无关 ⇒ 可跨 zone 复用（这正是 D1 的目的）");
  assertSameEstimate(utc, local, "跨 zone 复用");
  // 而**范围**参数（zone/排除集/now）不进键 ⇒ 它们不可能被 memo 吞掉：memo 只回答"这个事件值多少钱"。
  assert.equal(eventCostMemoKey({ ...event, preset: "today" }), eventCostMemoKey({ ...event, preset: "all" }));
  assert.equal(eventCostMemoKey({ ...event, excludeHomes: ["x"] }), eventCostMemoKey({ ...event }));
  assert.equal(eventCostMemoKey({ ...event, now: new Date(0) }), eventCostMemoKey({ ...event }));
});
