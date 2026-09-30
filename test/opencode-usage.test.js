import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { estimateEventCost } from "../src/pricing.js";
import { USAGE_DETAIL_INCONSISTENT, validateUsageDetails } from "../public/usage-fields.js";
import {
  opencodeDatabaseFiles,
  opencodeHomeLooksUsable,
  opencodeSourceStat,
  opencodeUsageFromTokens,
  parseOpencodeDb,
  streamOpencodeDbEvents,
} from "../src/opencode-usage.js";

const BASE_TIME = Date.parse("2026-09-20T10:00:00.000Z");

// 三组语义样本：病态（真库形状，reasoning >> output）、三陷阱齐全（含 cache.write）、常规。
const PATHOLOGICAL = { input: 9648, output: 45, reasoning: 420, cacheRead: 0, cacheWrite: 0 };
const ALL_TRAPS = { input: 1000, output: 10, reasoning: 300, cacheRead: 5000, cacheWrite: 2000 };
const ORDINARY = { input: 5870, output: 81, reasoning: 29, cacheRead: 3825, cacheWrite: 0 };

function assistantData(
  sample,
  { model = "mimo-v2.6-flash", provider = "opencode", created = BASE_TIME, content = "ok" } = {},
) {
  return JSON.stringify({
    time: { created, completed: created + 1000 },
    agent: "build",
    model: { id: model, providerID: provider },
    tokens: {
      input: sample.input,
      output: sample.output,
      reasoning: sample.reasoning,
      cache: { read: sample.cacheRead, write: sample.cacheWrite },
    },
    cost: 0,
    content: [{ type: "text", text: content }],
  });
}

async function makeOpencodeHome({
  sessions = [{ id: "sess-1", directory: "/work/demo", title: "demo", version: "2.0.19" }],
  messages = [],
} = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-opencode-"));
  const dbFile = path.join(homeDir, "opencode.db");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    for (const session of sessions) {
      db.prepare("INSERT INTO session_v2 (id, directory, title, version, agent, model) VALUES (?, ?, ?, ?, ?, ?)").run(
        session.id,
        session.directory ?? null,
        session.title ?? null,
        session.version ?? null,
        session.agent ?? "build",
        session.model ?? null,
      );
    }
    messages.forEach((message, index) => {
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        message.id || `msg-${index}`,
        message.sessionId,
        message.type || "assistant",
        message.seq ?? index,
        message.timeCreated ?? BASE_TIME + index * 1000,
        message.timeCreated ?? BASE_TIME + index * 1000,
        message.data,
      );
    });
  } finally {
    db.close();
  }
  return { homeDir, dbFile };
}

function sourceFor(homeDir) {
  return { id: "opencode-test", label: "OpenCode Test", path: homeDir };
}

async function collectEvents(dbFile, homeDir, options = {}) {
  const events = [];
  const warnings = [];
  await streamOpencodeDbEvents(dbFile, sourceFor(homeDir), (event) => events.push(event), {
    ...options,
    onWarning: (warning) => warnings.push(warning),
  });
  return { events, warnings };
}

// 三组样本 × 同一组断言：无缺口、无不一致、子集关系、总量恒等、计价正常分档。
function assertHealthyEvent(event) {
  assert.equal(event.reconciliationGap, 0);
  assert.ok(!(event.detailMask & USAGE_DETAIL_INCONSISTENT), "不应置 inconsistent 位");
  assert.ok(event.usage.reasoning <= event.usage.output, "reasoning ⊆ output");
  assert.ok(event.usage.cached + event.cacheWriteTokens <= event.usage.input, "cached + cacheWrite ⊆ input");
  assert.equal(event.usage.total, event.usage.input + event.usage.output);
  const estimate = estimateEventCost(event);
  for (const reason of ["usage-detail-inconsistent-minimum-scenario", "input-detail-inconsistent-minimum-scenario"]) {
    assert.ok(!estimate.unpricedReasons.includes(reason), `计价不应退化：${reason}`);
  }
  return estimate;
}

test("opencodeUsageFromTokens 把互不重叠的拆分重构成超集", () => {
  const pathological = opencodeUsageFromTokens({
    input: PATHOLOGICAL.input,
    output: PATHOLOGICAL.output,
    reasoning: PATHOLOGICAL.reasoning,
    cache: { read: PATHOLOGICAL.cacheRead, write: PATHOLOGICAL.cacheWrite },
  });
  assert.deepEqual(pathological.usage, { total: 10113, input: 9648, cached: 0, output: 465, reasoning: 420 });
  assert.equal(pathological.detailMask, 47);
  assert.deepEqual(pathological.cacheWrite, { tokens: 0, known: true });

  const traps = opencodeUsageFromTokens({
    input: ALL_TRAPS.input,
    output: ALL_TRAPS.output,
    reasoning: ALL_TRAPS.reasoning,
    cache: { read: ALL_TRAPS.cacheRead, write: ALL_TRAPS.cacheWrite },
  });
  assert.deepEqual(traps.usage, { total: 8310, input: 8000, cached: 5000, output: 310, reasoning: 300 });
  assert.equal(traps.detailMask, 47);
  assert.deepEqual(traps.cacheWrite, { tokens: 2000, known: true });

  const ordinary = opencodeUsageFromTokens({
    input: ORDINARY.input,
    output: ORDINARY.output,
    reasoning: ORDINARY.reasoning,
    cache: { read: ORDINARY.cacheRead, write: ORDINARY.cacheWrite },
  });
  assert.deepEqual(ordinary.usage, { total: 9805, input: 9695, cached: 3825, output: 110, reasoning: 29 });
  assert.equal(ordinary.detailMask, 47);

  for (const mapped of [pathological, traps, ordinary]) {
    const validation = validateUsageDetails(mapped.usage, mapped.detailMask);
    assert.equal(validation.reconciliationGap, 0);
    assert.ok(!(validation.detailMask & USAGE_DETAIL_INCONSISTENT));
  }
});

test("三组样本端到端产出健康事件", async () => {
  const samples = [PATHOLOGICAL, ALL_TRAPS, ORDINARY];
  const { homeDir, dbFile } = await makeOpencodeHome({
    messages: samples.map((sample, index) => ({
      sessionId: "sess-1",
      data: assistantData(sample, { created: BASE_TIME + index * 1000 }),
    })),
  });
  const { events, warnings } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 3);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    events.map((event) => event.usage.total),
    [10113, 8310, 9805],
  );
  for (const event of events) {
    const estimate = assertHealthyEvent(event);
    assert.equal(estimate.pricingStatus, "estimated");
  }
  assert.deepEqual(
    events.map((event) => event.model),
    ["mimo-v2.6-flash", "mimo-v2.6-flash", "mimo-v2.6-flash"],
  );
});

test("天真映射之一：output 不折叠会触发 reasoning 不一致", () => {
  // output ← tokens.output（45），reasoning 另计（420）：reasoning > output。
  const usage = { total: 9693, input: 9648, cached: 0, output: 45, reasoning: 420 };
  const validation = validateUsageDetails(usage, 47);
  assert.ok(validation.detailMask & USAGE_DETAIL_INCONSISTENT);
  assert.ok(validation.reconciliationGap > 0);
  const estimate = estimateEventCost({
    model: "mimo-v2.6-flash",
    channel: "OpenCode",
    detailMask: validation.detailMask,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: usage,
  });
  assert.ok(estimate.unpricedReasons.includes("usage-detail-inconsistent-minimum-scenario"));
});

test("天真映射之二：input 漏加 cache.write 会触发计价退化（校验抓不到）", () => {
  // input ← input + cache.read（6000），漏了 cache.write（2000）：
  // cached + cacheWrite = 7000 > input = 6000。
  const usage = { total: 6310, input: 6000, cached: 5000, output: 310, reasoning: 300 };
  const validation = validateUsageDetails(usage, 47);
  assert.equal(validation.reconciliationGap, 0, "validateUsageDetails 抓不到这一条");
  const estimate = estimateEventCost({
    model: "mimo-v2.6-flash",
    channel: "OpenCode",
    detailMask: validation.detailMask,
    cacheWriteTokens: 2000,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: usage,
  });
  assert.ok(estimate.unpricedReasons.includes("input-detail-inconsistent-minimum-scenario"));
});

test("只有 assistant 行产出事件，无 tokens 与全零行跳过", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    messages: [
      { sessionId: "sess-1", data: assistantData(PATHOLOGICAL) },
      { sessionId: "sess-1", data: assistantData(ORDINARY) },
      { sessionId: "sess-1", type: "user", data: JSON.stringify({ content: "hi" }) },
      { sessionId: "sess-1", type: "idle", data: JSON.stringify({}) },
      { sessionId: "sess-1", type: "system", data: JSON.stringify({}) },
      { sessionId: "sess-1", type: "model-switched", data: JSON.stringify({}) },
      // 无 tokens（中断消息形状）：有 content/snapshot，无 tokens/finish/cost。
      {
        sessionId: "sess-1",
        data: JSON.stringify({ time: { created: BASE_TIME }, agent: "build", content: [], snapshot: {} }),
      },
      // 全零用量。
      {
        sessionId: "sess-1",
        data: assistantData({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
      },
      // 坏 JSON。
      { sessionId: "sess-1", data: "{not-json" },
    ],
  });
  const { events } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.eventId),
    ["sess-1:0", "sess-1:1"],
  );
  assert.ok(events.every((event) => event.channel === "OpenCode" && event.source === "opencode"));
});

test("事件带模型、仓库、上下文分级与会话标题", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    sessions: [{ id: "sess-1", directory: "/work/demo", title: "demo title", version: "2.0.19" }],
    messages: [{ sessionId: "sess-1", data: assistantData(ORDINARY) }],
  });
  const { events } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.model, "mimo-v2.6-flash");
  assert.equal(event.modelProvider, "opencode");
  assert.equal(event.conversationName, "demo title");
  assert.equal(event.requestInputTokens, 9695);
  assert.equal(event.contextLevel, "short");
  assert.equal(event.serviceTier, "unknown");
  assert.ok(event.priceVersion, "priceVersion 应有值");
});

test("高缓存事件仍判 short（聚合比高不等于事件分布高）", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    messages: [{ sessionId: "sess-1", data: assistantData(ORDINARY) }],
  });
  const { events } = await collectEvents(dbFile, homeDir);
  assert.equal(events[0].requestInputTokens, 9695);
  assert.ok(9695 < 272_000);
  assert.equal(events[0].contextLevel, "short");
});

test("模型缺失回落 Unknown model，标题截断到 120 字符", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    sessions: [{ id: "sess-1", directory: "", title: `t${"i".repeat(200)}`, version: "2.0.19" }],
    messages: [
      {
        sessionId: "sess-1",
        data: JSON.stringify({
          time: { created: BASE_TIME, completed: BASE_TIME + 1 },
          tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
        }),
      },
    ],
  });
  const { events } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "Unknown model");
  assert.equal(events[0].modelProvider, "");
  assert.equal(events[0].conversationName.length, 121);
});

test("版本守护：v1 会话跳过并告警，缺失版本放行并告警", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    sessions: [
      { id: "sess-old", directory: "/work/old", title: "old", version: "1.9.0" },
      { id: "sess-new", directory: "/work/new", title: "new", version: "2.0.19" },
      { id: "sess-noversion", directory: "/work/nv", title: "nv", version: null },
      { id: "sess-badversion", directory: "/work/bv", title: "bv", version: "abc" },
    ],
    messages: [
      { sessionId: "sess-old", data: assistantData(PATHOLOGICAL) },
      { sessionId: "sess-new", data: assistantData(PATHOLOGICAL) },
      { sessionId: "sess-noversion", data: assistantData(PATHOLOGICAL) },
      { sessionId: "sess-badversion", data: assistantData(PATHOLOGICAL) },
    ],
  });
  const { events, warnings } = await collectEvents(dbFile, homeDir);
  assert.deepEqual(
    events.map((event) => event.sessionId),
    ["sess-new", "sess-noversion", "sess-badversion"],
  );
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => warning.includes("sess-old") && warning.includes("已跳过")));
});

test("缺 session_v2 时事件仍产出、cwd 为空并告警", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    sessions: [],
    messages: [{ sessionId: "sess-1", data: assistantData(PATHOLOGICAL) }],
  });
  const { events, warnings } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].project, "");
  assert.ok(warnings.length > 0);
});

test("缺 session_message 表时整来源抛错", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-opencode-"));
  const dbFile = path.join(homeDir, "opencode.db");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT);",
    );
  } finally {
    db.close();
  }
  await assert.rejects(collectEvents(dbFile, homeDir), /缺少列|无法读取/);
});

test("非法时间戳的行跳过", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    messages: [
      {
        sessionId: "sess-1",
        timeCreated: 0,
        data: JSON.stringify({ tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }),
      },
      { sessionId: "sess-1", data: assistantData(PATHOLOGICAL) },
    ],
  });
  const { events } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 1);
});

test("正文哨兵字符串不会进入任何产出事件", async () => {
  const sentinel = "SENTINEL-DO-NOT-LEAK-opencode-字典";
  const { homeDir, dbFile } = await makeOpencodeHome({
    messages: [{ sessionId: "sess-1", data: assistantData(PATHOLOGICAL, { content: sentinel }) }],
  });
  const { events } = await collectEvents(dbFile, homeDir);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(sentinel));
});

test("parseOpencodeDb 汇总会话与事件", async () => {
  const { homeDir, dbFile } = await makeOpencodeHome({
    messages: [
      { sessionId: "sess-1", data: assistantData(PATHOLOGICAL, { created: BASE_TIME }) },
      { sessionId: "sess-1", data: assistantData(ORDINARY, { created: BASE_TIME + 5000 }) },
    ],
  });
  const warnings = [];
  const { sessions, events } = await parseOpencodeDb(dbFile, sourceFor(homeDir), {
    onWarning: (warning) => warnings.push(warning),
  });
  assert.equal(events.length, 2);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].eventCount, 2);
  assert.deepEqual(sessions[0].total, { total: 19918, input: 19343, cached: 3825, output: 575, reasoning: 449 });
  assert.equal(sessions[0].channel, "OpenCode");
  assert.equal(sessions[0].originator, "");
});

test("opencodeDatabaseFiles 只收 opencode*.db", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-opencode-"));
  await mkdir(path.join(homeDir, "sub"), { recursive: true });
  for (const name of ["opencode.db", "opencode-dev.db", "opencode.db-wal", "notes.txt"]) {
    await writeFile(path.join(homeDir, name), "x");
  }
  assert.deepEqual(await opencodeDatabaseFiles(homeDir), [
    path.join(homeDir, "opencode-dev.db"),
    path.join(homeDir, "opencode.db"),
  ]);
  assert.equal(await opencodeHomeLooksUsable(homeDir), true);
  assert.equal(await opencodeHomeLooksUsable(path.join(homeDir, "sub")), false);
  assert.equal(await opencodeHomeLooksUsable(path.join(homeDir, "missing")), false);
});

test("opencodeSourceStat 把 WAL 计入增量检测", async () => {
  const { dbFile } = await makeOpencodeHome();
  await writeFile(`${dbFile}-wal`, "x".repeat(100));
  const info = await opencodeSourceStat(dbFile);
  assert.ok(info.size >= 100);
  assert.ok(Number.isFinite(info.mtimeMs));
});
