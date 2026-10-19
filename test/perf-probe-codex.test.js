// M0.5 Codex 探测回归：合成 fixture + 冻结外壳的端到端投影。
//
// fixture 覆盖任务卡点名的八类场景：跨线程相同 turn_id、同线程多 rollout、重复 item、
// partial、长轮、多请求、未结束、模型切换。
//
// 注意：本文件里的所有 ID（thread/turn/item/response）都是**合成**短标识，
// 仅用于本进程内的结构与断言；它们绝不进入探测产物（见「产物不含原始 ID」用例）。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROBE_SHELL = fileURLToPath(new URL("../scripts/perf-probe.mjs", import.meta.url));
const SOURCE_MODULE_ROOT = new URL("../scripts/perf-probe-sources/", import.meta.url);

for (const name of [
  "probe",
  "readRolloutRecords",
  "buildTurnLedger",
  "classifyTurn",
  "createProbeFacts",
  "JSONL_ITEM_TYPES",
  "SQLITE_ITEM_TYPES",
  "ERA_CUTOFF_MS",
  "LONG_WINDOW_MS",
]) {
  void name;
}

const codexModule = await import(
  pathToFileURL(fileURLToPath(new URL("../scripts/perf-probe-sources/codex.mjs", import.meta.url))).href
);

// ---------------------------------------------------------------------------
// fixture 构造
// ---------------------------------------------------------------------------

/** 合成 fixture 里固定使用的短标识（非真实 ID，不含 UUID/摘要形状）。 */
const T = {
  sharedTurn: "turn-shared",
  alpha: "thread-alpha",
  beta: "thread-beta",
  alphaTurn2: "turn-alpha-2",
  alphaTurn3: "turn-alpha-3",
  alphaTurn4: "turn-alpha-4",
  alphaTurn5: "turn-alpha-5",
  betaTurn2: "turn-beta-2",
  itemA: "item-a",
  itemB: "item-b",
  itemC: "item-c",
  responseAlpha: "resp-alpha",
  responseAlpha2: "resp-alpha-2",
  responseBeta: "resp-beta",
};

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function sessionMeta(threadId, source = "cli") {
  return {
    timestamp: "2026-10-01T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      session_id: threadId,
      source,
      thread_source: "user",
      model_provider: "openai",
    },
  };
}

function turnContext(turnId, model, effort) {
  return {
    timestamp: "2026-10-01T00:00:01.000Z",
    type: "turn_context",
    payload: { turn_id: turnId, model, effort, cwd: "C:\\work" },
  };
}

function itemCompleted({
  threadId,
  turnId,
  itemType,
  itemId,
  startedAtMs,
  completedAtMs,
  content = "SENTINEL-CONTENT",
}) {
  const item = { type: itemType, id: itemId };
  if (itemType === "AgentMessage") item.content = [{ type: "output_text", text: content }];
  else item.summary_text = content;
  return {
    timestamp: "2026-10-01T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: threadId,
      turn_id: turnId,
      item,
      started_at_ms: startedAtMs,
      completed_at_ms: completedAtMs,
    },
  };
}

/**
 * 构造 token_usage_record。
 * - `timestamp`：显式指定来源时序（返工2 的乱序用例需要）。
 * - `omitTurnLevel`：连 `turn_token_usage` 一起省略（返工2 的「末条缺值」用例需要）。
 */
function tokenUsageRecord({
  threadId,
  turnId,
  responseId,
  outputTokens,
  turnOutputTokens,
  timestamp = "2026-10-01T00:00:03.000Z",
  omitTurnLevel = false,
}) {
  return {
    timestamp,
    type: "token_usage_record",
    payload: {
      thread_id: threadId,
      turn_id: turnId,
      response_id: responseId,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: outputTokens,
        reasoning_output_tokens: 0,
        total_tokens: 100 + outputTokens,
      },
      ...(omitTurnLevel ? {} : { turn_token_usage: { output_tokens: turnOutputTokens ?? outputTokens } }),
      thread_token_usage: { output_tokens: turnOutputTokens ?? outputTokens },
    },
  };
}

function taskComplete({ turnId, startedAt, completedAt, durationMs, lastAgentMessage = "SENTINEL-LAST-MESSAGE" }) {
  return {
    timestamp: "2026-10-01T00:00:04.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: lastAgentMessage,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      time_to_first_token_ms: 123,
    },
  };
}

/**
 * 合成 fixture：
 * - thread-alpha 有两个 rollout 文件（同一线程多 rollout），第二阶段用了不同模型（模型切换）。
 * - 跨线程相同 turn_id：thread-beta 复用 `turn-shared`。
 * - 重复 item（同 id 同跨度重放）、span 冲突重复（同 id 不同跨度）。
 * - partial（目标 item 缺 completed_at_ms）。
 * - 长轮（item 跨度 > 300000ms）。
 * - 多请求（同轮多个 token_usage_record）。
 * - 未结束（有 item + 请求但无 task_complete）。
 */
function buildFixtureHome(root) {
  const sessionsDir = path.join(root, "sessions", "2026", "10", "01");
  const archivedDir = path.join(root, "archived_sessions", "2026", "09", "20");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(archivedDir, { recursive: true });

  // rollout 1：thread-alpha / turn-shared —— 多请求 + 重复 item + 模型切换证据
  const rollout1 = [
    sessionMeta(T.alpha),
    turnContext(T.sharedTurn, "model-one", "low"),
    itemCompleted({
      threadId: T.alpha,
      turnId: T.sharedTurn,
      itemType: "Reasoning",
      itemId: T.itemA,
      startedAtMs: 1_000,
      completedAtMs: 2_100,
    }),
    itemCompleted({
      threadId: T.alpha,
      turnId: T.sharedTurn,
      itemType: "AgentMessage",
      itemId: T.itemB,
      startedAtMs: 2_200,
      completedAtMs: 3_300,
    }),
    // 重放：同 id、同跨度 —— 应折叠且不计冲突
    itemCompleted({
      threadId: T.alpha,
      turnId: T.sharedTurn,
      itemType: "AgentMessage",
      itemId: T.itemB,
      startedAtMs: 2_200,
      completedAtMs: 3_300,
    }),
    tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: T.responseAlpha, outputTokens: 120 }),
    tokenUsageRecord({
      threadId: T.alpha,
      turnId: T.sharedTurn,
      responseId: T.responseAlpha2,
      outputTokens: 80,
      turnOutputTokens: 200,
    }),
    taskComplete({ turnId: T.sharedTurn, startedAt: 1_000, completedAt: 3_300, durationMs: 2_300 }),
  ];
  writeFileSync(path.join(sessionsDir, "rollout-a1.jsonl"), jsonl(rollout1), "utf8");

  // rollout 2：thread-alpha 第二段 —— 同线程多 rollout、模型切换、长轮、未结束
  const rollout2 = [
    sessionMeta(T.alpha),
    turnContext(T.alphaTurn2, "model-two", "high"),
    itemCompleted({
      threadId: T.alpha,
      turnId: T.alphaTurn2,
      itemType: "AgentMessage",
      itemId: T.itemC,
      startedAtMs: 10_000,
      completedAtMs: 400_000, // 长轮：跨度 390000 > LONG_WINDOW_MS
    }),
    tokenUsageRecord({ threadId: T.alpha, turnId: T.alphaTurn2, responseId: "resp-a2", outputTokens: 500 }),
    taskComplete({ turnId: T.alphaTurn2, startedAt: 10_000, completedAt: 400_000, durationMs: 390_000 }),
  ];
  writeFileSync(path.join(sessionsDir, "rollout-a2.jsonl"), jsonl(rollout2), "utf8");

  // rollout 3：thread-beta 复用相同 turn_id（跨线程相同 turn_id）
  const rollout3 = [
    sessionMeta(T.beta, JSON.stringify({ subagent: { thread_spawn: { depth: 1 } } })),
    turnContext(T.sharedTurn, "model-three", "medium"),
    itemCompleted({
      threadId: T.beta,
      turnId: T.sharedTurn,
      itemType: "AgentMessage",
      itemId: "item-beta",
      startedAtMs: 5_000,
      completedAtMs: 6_000,
    }),
    tokenUsageRecord({ threadId: T.beta, turnId: T.sharedTurn, responseId: T.responseBeta, outputTokens: 60 }),
    taskComplete({ turnId: T.sharedTurn, startedAt: 5_000, completedAt: 6_000, durationMs: 1_000 }),
  ];
  writeFileSync(path.join(sessionsDir, "rollout-b1.jsonl"), jsonl(rollout3), "utf8");

  // rollout 4（archived_sessions）：partial（缺 completed_at_ms）+ span 冲突重复 + 未结束
  const rollout4 = [
    sessionMeta(T.alpha),
    turnContext(T.alphaTurn3, "model-one", "low"),
    {
      timestamp: "2026-09-20T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: T.alpha,
        turn_id: T.alphaTurn3,
        item: { type: "Reasoning", id: "item-partial", summary_text: "SENTINEL-CONTENT" },
        started_at_ms: 1_000,
        // completed_at_ms 缺失
      },
    },
    // 同 id 不同跨度 —— 冲突
    itemCompleted({
      threadId: T.alpha,
      turnId: T.alphaTurn4,
      itemType: "AgentMessage",
      itemId: "item-clash",
      startedAtMs: 1_000,
      completedAtMs: 2_000,
    }),
    itemCompleted({
      threadId: T.alpha,
      turnId: T.alphaTurn4,
      itemType: "AgentMessage",
      itemId: "item-clash",
      startedAtMs: 1_500,
      completedAtMs: 2_500,
    }),
    tokenUsageRecord({ threadId: T.alpha, turnId: T.alphaTurn4, responseId: "resp-clash-1", outputTokens: 10 }),
    tokenUsageRecord({ threadId: T.alpha, turnId: T.alphaTurn4, responseId: "resp-clash-2", outputTokens: 20 }),
    // 未结束：有 item 与请求，但没有 task_complete
    turnContext(T.alphaTurn5, "model-one", "low"),
    itemCompleted({
      threadId: T.alpha,
      turnId: T.alphaTurn5,
      itemType: "AgentMessage",
      itemId: "item-only",
      startedAtMs: 7_000,
      completedAtMs: 8_000,
    }),
    tokenUsageRecord({ threadId: T.alpha, turnId: T.alphaTurn5, responseId: "resp-only", outputTokens: 30 }),
  ];
  writeFileSync(path.join(archivedDir, "rollout-old.jsonl"), jsonl(rollout4), "utf8");

  return root;
}

/**
 * 建临时 fixture 并执行回调；回调可以是同步或异步。
 * 必须等待异步回调结束后再删目录——否则断言会在 fixture 已被删除后才抛出，
 * 失败会以 unhandledRejection 的形式出现而不是正常的测试失败。
 */
async function withFixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "codex-probe-"));
  try {
    buildFixtureHome(root);
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function probeFixture(root, { maxFiles = 10, maxRows = 5000, full = false } = {}) {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    return await codexModule.probe({ maxFiles, maxRows, full });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

/** 建只含 sessions/ 的自定义 home（用于返工回归的精确场景）。 */
function customHome(files) {
  const root = mkdtempSync(path.join(tmpdir(), "codex-probe-custom-"));
  const dir = path.join(root, "sessions");
  mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(files)) writeFileSync(path.join(dir, name), jsonl(rows), "utf8");
  return root;
}

/** 只跑台账层：把若干文件的行读成记录再建轮台账（不经过文件系统预算逻辑）。 */
function ledgerOf(root, names) {
  const facts = codexModule.createProbeFacts();
  const records = [];
  for (const name of names) {
    const detail = codexModule.readRolloutRecords(path.join(root, "sessions", name), codexModule.createProbeFacts());
    records.push(...detail.records);
  }
  return { ...codexModule.buildTurnLedger(records, facts), facts };
}

// ---------------------------------------------------------------------------
// 单测：解析层
// ---------------------------------------------------------------------------

test("JSONL 判别式用 PascalCase，SQLite item_type 用 camelCase，两处映射不混用", () => {
  assert.deepEqual(codexModule.JSONL_ITEM_TYPES, { AgentMessage: "agentMessage", Reasoning: "reasoning" });
  assert.deepEqual(codexModule.SQLITE_ITEM_TYPES, { agentMessage: "agentMessage", reasoning: "reasoning" });
  // 交叉反例：camelCase 的 agentMessage 不是 JSONL 判别式
  assert.equal(codexModule.JSONL_ITEM_TYPES.agentMessage, undefined);
  assert.equal(codexModule.JSONL_ITEM_TYPES.reasoning, undefined);
  assert.equal(codexModule.SQLITE_ITEM_TYPES.AgentMessage, undefined);
  assert.equal(codexModule.SQLITE_ITEM_TYPES.Reasoning, undefined);
});

test("只读解析：逐类型精确计数，且不读 item content / last_agent_message / TTFT", () => {
  withFixture((root) => {
    const facts = codexModule.createProbeFacts();
    const filePath = path.join(root, "sessions", "2026", "10", "01", "rollout-a1.jsonl");
    const detail = codexModule.readRolloutRecords(filePath, facts);
    assert.equal(detail.readFailed, false);
    assert.equal(detail.facts.topLevelCounts.session_meta, 1);
    assert.equal(detail.facts.topLevelCounts.turn_context, 1);
    assert.equal(detail.facts.topLevelCounts.token_usage_record, 2);
    assert.equal(detail.facts.topLevelCounts.event_msg, 4);
    assert.equal(detail.facts.eventPayloadCounts.item_completed, 3);
    assert.equal(detail.facts.eventPayloadCounts.task_complete, 1);
    assert.equal(detail.facts.itemCompletedRows, 3);
    assert.equal(detail.facts.itemWithSpan, 3);
    assert.equal(detail.facts.withResponseId, 2);
    assert.equal(detail.facts.withThreadId, 2);
    assert.equal(detail.facts.withTurnId, 2);
    assert.equal(detail.facts.turnContextWithModel, 1);
    assert.equal(detail.facts.turnContextWithEffort, 1);
    assert.equal(detail.facts.taskCompleteSpanMatchesDuration, 1);

    // 产出的记录里只有结构字段，且不含任何正文哨兵。
    const serialized = JSON.stringify(detail.records);
    assert.equal(serialized.includes("SENTINEL-CONTENT"), false);
    assert.equal(serialized.includes("SENTINEL-LAST-MESSAGE"), false);
    const allowedKeys = new Set([
      "kind",
      "fileKey", // rollout 上下文键：仅内存态，用于把无 thread_id 的顶层记录归位
      "lineOrdinal", // 记录在**本文件**内的行序：仅内存态，用于按来源时序选末条累计值
      "threadId",
      "turnId",
      "responseId",
      "outputTokens",
      "turnOutputTokens",
      "atMs",
      "itemType",
      "itemTypeCase",
      "itemId",
      "startedAtMs",
      "completedAtMs",
      "model",
      "effort",
      "startedAt",
      "completedAt",
      "durationMs",
    ]);
    for (const record of detail.records) {
      for (const key of Object.keys(record)) assert.ok(allowedKeys.has(key), `越界字段：${key}`);
    }
  });
});

test("跨线程相同 turn_id 不合并：轮身份含 thread", () => {
  withFixture((root) => {
    const records = [];
    for (const file of ["rollout-a1.jsonl", "rollout-b1.jsonl"]) {
      const filePath = path.join(root, "sessions", "2026", "10", "01", file);
      records.push(...codexModule.readRolloutRecords(filePath, codexModule.createProbeFacts()).records);
    }
    const facts = codexModule.createProbeFacts();
    const { turns } = codexModule.buildTurnLedger(records, facts);
    const shared = [...turns.values()].filter((turn) => turn.turnId === T.sharedTurn);
    assert.equal(shared.length, 2, "同 turn_id 在两条线程上必须各成一轮");
    assert.deepEqual(shared.map((turn) => turn.threadId).sort(), [T.alpha, T.beta], "两轮必须分属不同线程");
    for (const turn of shared) {
      // 模型证据按精确 turn_id + rollout 上下文建表：α=model-one、β=model-three，不得互相串味
      assert.equal(turn.modelKeys.size, 1, "跨线程同 turn_id 不得把两边的模型混成一个集合");
      assert.deepEqual([...turn.modelKeys], [turn.threadId === T.alpha ? "model-one|low" : "model-three|medium"]);
      assert.equal(turn.terminals.length, 1, "终态必须归到本 rollout 对应的那一轮");
    }
    assert.equal(facts.conflicts.modelAmbiguous, 0, "跨线程同 turn_id 不是模型冲突");
  });
});

test("重复 item：同跨度折叠、不同跨度置 RECORD_CONFLICT", () => {
  withFixture((root) => {
    const records = [];
    records.push(
      ...codexModule.readRolloutRecords(
        path.join(root, "sessions", "2026", "10", "01", "rollout-a1.jsonl"),
        codexModule.createProbeFacts(),
      ).records,
    );
    records.push(
      ...codexModule.readRolloutRecords(
        path.join(root, "archived_sessions", "2026", "09", "20", "rollout-old.jsonl"),
        codexModule.createProbeFacts(),
      ).records,
    );
    const facts = codexModule.createProbeFacts();
    const { turns } = codexModule.buildTurnLedger(records, facts);

    const shared = [...turns.values()].find((turn) => turn.threadId === T.alpha && turn.turnId === T.sharedTurn);
    const replay = shared.items.get(T.itemB);
    assert.equal(replay.duplicates, 1, "同跨度重放必须折叠并记为 1 次重复");
    assert.equal(replay.spanConflict, false);

    const clash = [...turns.values()].find((turn) => turn.turnId === T.alphaTurn4);
    assert.equal(clash.items.get("item-clash").spanConflict, true, "跨度不一致必须标冲突");
    assert.ok(facts.conflicts.spanConflict >= 1);
    assert.ok(facts.conflicts.recordConflict >= 1);
  });
});

test("partial / 长轮 / 多请求 / 未结束 / 模型切换 在台账上可判", () => {
  withFixture(async (root) => {
    const result = await probeFixture(root);
    assert.equal(result.fields.timingKind, "item_span_estimate");
    assert.equal(result.fields.tokenScope, "reported_output_includes_reasoning");
    assert.equal(result.fields.modelEvidence, "turn_context");

    // partial：thread-alpha/alphaTurn3 的 Reasoning 缺 completed_at_ms
    assert.ok(result.scanned.missingItemSpanCount >= 1, "必须记录缺跨度的目标 item");
    assert.ok(result.decisions.flagCounts.PARTIAL_ITEM_SPAN >= 1);

    // 长轮：alphaTurn2 跨度 390000ms
    assert.ok(result.decisions.flagCounts.LONG_WINDOW >= 1);

    // 多请求：alphaTurn4 有两个请求
    assert.ok(result.decisions.flagCounts.MULTI_REQUEST_TURN >= 1);

    // 未结束：alphaTurn3/alphaTurn5 无 task_complete
    assert.ok(result.decisions.flagCounts.TERMINAL_UNVERIFIED >= 1);

    // 模型切换：同线程 model-one -> model-two（诊断信号，不做跨轮继承）
    assert.equal(result.fields.modelChangedMidSession, true, "同线程跨轮模型标签不同必须如实报告");
    assert.equal(result.scanned.effortConflictCount, 0, "精确 turn_context.turn_id 下不得报冲突");
  });
});

// ---------------------------------------------------------------------------
// 端到端：分层、恒等式与脱敏
// ---------------------------------------------------------------------------

test("四层计数：raw / positive / full-span / finalized，且缺终态不可当完成", async () => {
  withFixture(async (root) => {
    const result = await probeFixture(root);
    const { scanned } = result;

    assert.equal(scanned.rawCount, scanned.eligible, "raw 层与 eligible 同分母");
    assert.ok(scanned.eligible > 0);
    // 单调性契约
    assert.ok(scanned.sampled <= scanned.completeTimedPositiveOutput);
    assert.ok(scanned.completeTimedPositiveOutput <= scanned.timedPositiveOutput);
    assert.ok(scanned.timedPositiveOutput <= scanned.positiveOutput);
    assert.ok(scanned.positiveOutput <= scanned.eligible);
    // 计数恒等式
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);

    // 未结束的轮不得进入 finalized：fixture 里有 4 个 task_complete、却有更多轮
    assert.ok(scanned.eligible > scanned.completeTimedPositiveOutput);
    assert.ok(scanned.terminalUnverifiedCount >= 1);
    assert.equal(scanned.positiveCount, scanned.positiveOutput);
    assert.equal(scanned.afterFilterCount, scanned.completeTimedPositiveOutput);
    assert.equal(scanned.positiveDurationCount, scanned.timedPositiveOutput);
  });
});

test("byEra：旧时段缺跨度单列；四层各有 recent/legacy 分桶", async () => {
  withFixture(async (root) => {
    const result = await probeFixture(root);
    // archived fixture 用 2026-09-20 的记录时间，早于切点 2026-09-28T01:00:57Z；
    // sessions fixture 的原始 item 跨度落在 1970 epoch 附近（< 切点），同样归 legacy。
    assert.ok(result.scanned.legacyRecords >= 1);
    assert.ok(result.scanned.missingItemSpanCount >= 1);
    // recent 桶可以为 0（有界 fixture），但字段必须存在。
    assert.equal(typeof result.scanned.recentRecords, "number");
  });
});

test("恒等式与分母：scanned 计数自洽，跨 rollout 重复可计数", async () => {
  withFixture(async (root) => {
    const result = await probeFixture(root, { full: true });
    const { scanned } = result;
    assert.equal(scanned.filesScanned, scanned.filesDiscovered);
    assert.equal(scanned.files, scanned.filesDiscovered);
    assert.ok(scanned.rowsScanned > 0);
    assert.ok(scanned.dedupedRequests >= scanned.requestCount);
    assert.ok(scanned.dedupedItems >= scanned.targetItemCount);
    // 必须同时抽 sessions 与 archived_sessions（布尔在 fields 上）
    assert.equal(result.fields.archivedSessionsPresent, true);
    assert.equal(scanned.sessionHeaderCount >= 2, true, "两个目录都要有 session_meta");
    // 精确类型计数
    assert.ok(scanned.turnContextCount >= 1);
    assert.ok(scanned.tokenUsageRecordCount >= 1);
    assert.ok(scanned.itemCompletedCount >= 1);
    assert.ok(scanned.taskCompleteCount >= 1);
    // 单位证据：item 跨度是毫秒，task_complete 的秒级 start/end
    assert.equal(scanned.secondUnitCount, 0, "记录时间戳是 ISO 毫秒单位");
    assert.ok(scanned.milliSecondUnitCount > 0);
    assert.ok(scanned.timeUnitCheckedCount >= 1);
  });
});

test("产物不含原始 ID：thread / turn / item / response 短标识一个都不出现", async () => {
  withFixture(async (root) => {
    const result = await probeFixture(root);
    const serialized = JSON.stringify(result);
    for (const identifier of Object.values(T)) {
      assert.equal(serialized.includes(identifier), false, `产物泄漏原始 ID：${identifier}`);
    }
    assert.equal(serialized.includes("SENTINEL-CONTENT"), false, "产物不得含 item 正文");
    assert.equal(serialized.includes("SENTINEL-LAST-MESSAGE"), false, "产物不得含 last_agent_message");
  });
});

test("只读纪律：itemContentAccessed / lastAgentMessageAccessed / ttftAccessed 全为 false", async () => {
  withFixture(async (root) => {
    const result = await probeFixture(root);
    assert.equal(result.fields.itemContentAccessed, false);
    assert.equal(result.fields.lastAgentMessageAccessed, false);
    assert.equal(result.fields.ttftAccessed, false);
    assert.equal(result.fields.ttftRead, false);
    assert.equal(result.fields.contentAccessed, false);
    assert.equal(result.decisions.readOnly, true);
    assert.equal(result.fields.readOnlyStrategy, "database_sync_readonly");
  });
});

test("来源决议三选一：空 home 为 UNSUPPORTED，有数据但无可选库为 JSONL_ONLY", async () => {
  const emptyRoot = mkdtempSync(path.join(tmpdir(), "codex-probe-empty-"));
  try {
    const empty = await probeFixture(emptyRoot);
    assert.equal(empty.fields.sourceVerdict, "UNSUPPORTED");
    assert.equal(empty.decisions.sourceVerdict, "UNSUPPORTED");
    assert.equal(empty.scanned.files, 0);
    assert.ok(empty.warnings.some((entry) => entry.code === "NO_SOURCE_FILES"));
    assert.equal(empty.fields.coverageState, "degraded");
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  withFixture(async (root) => {
    const result = await probeFixture(root);
    // 合成 fixture 里没有 SQLite：可选源缺席，决议必须落在 JSONL_ONLY。
    assert.equal(result.fields.sourceVerdict, "JSONL_ONLY");
    assert.equal(result.decisions.sourceVerdict, "JSONL_ONLY");
    assert.equal(result.fields.itemAlignmentDecision, "cannot_prove");
    assert.equal(result.fields.timingKind, "item_span_estimate");
    assert.equal(result.decisions.optionalSourceUsed, false);
  });
});

// ---------------------------------------------------------------------------
// 端到端：冻结外壳（runPerfProbe + 真实 CLI 子进程）
// ---------------------------------------------------------------------------

async function runShell({ root, args }) {
  const shell = await import(pathToFileURL(PROBE_SHELL).href);
  const logLines = [];
  const exitCode = await shell.runPerfProbe(args, {
    log: (line) => logLines.push(line),
    outputRoot: root,
    sourceModuleRoot: SOURCE_MODULE_ROOT,
  });
  return { exitCode, logLines };
}

test("M0.6-A：交叉校验三态必须有专用计数键，且不得再借用 requestHeaderCount / identityDuplicateCount", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-probe-codex-m06a-"));
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "rollout-m06a.jsonl"),
    jsonl([
      sessionMeta(T.alpha),
      turnContext(T.alphaTurn2, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.alphaTurn2,
        itemType: "AgentMessage",
        itemId: "item-m06a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.alphaTurn2,
        responseId: "resp-1",
        outputTokens: 4,
        turnOutputTokens: 4,
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.alphaTurn2,
        responseId: "resp-2",
        outputTokens: 6,
        turnOutputTokens: 10,
      }),
      taskComplete({ turnId: T.alphaTurn2, startedAt: 1_000, completedAt: 2_000, durationMs: 1_000 }),
    ]),
    "utf8",
  );

  const outputRoot = path.join(root, "validation");
  const runDir = path.join(outputRoot, "2026-10-04-perf-metrics", "run-m06a");
  mkdirSync(runDir, { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const { exitCode, logLines } = await runShell({
      root: outputRoot,
      args: ["--source", "codex", "--output", runDir, "--max-files", "1", "--max-rows", "50"],
    });
    assert.equal(exitCode, 0, logLines.join("\n"));
    const envelope = JSON.parse(readFileSync(path.join(runDir, "codex-probe.json"), "utf8"));
    assert.deepEqual(envelope.fieldRejections, [], "新键必须全部在外壳白名单内");
    const scanned = envelope.scanned;
    // 专用键承载三态
    assert.equal(scanned.crossCheckAvailableCount, 1);
    assert.equal(scanned.crossCheckMatchedCount, 1);
    assert.equal(scanned.crossCheckConflictCount, 0);
    assert.equal(scanned.crossCheckUnavailableCount, 0);
    assert.equal(
      scanned.crossCheckAvailableCount,
      scanned.crossCheckMatchedCount + scanned.crossCheckConflictCount,
      "可校验 = matched + conflict",
    );
    assert.equal(
      scanned.crossCheckAvailableCount + scanned.crossCheckUnavailableCount,
      scanned.eligible,
      "三态是 eligible 的完整划分",
    );
    // 借用的两个键必须回到字面含义（本来源不再写入交叉校验语义）
    assert.equal(scanned.requestHeaderCount, 0, "Codex JSONL 没有 request/header 帧");
    assert.equal(scanned.identityDuplicateCount, 0, "本来源没有身份重复折叠行");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("端到端：runPerfProbe 注入临时根，产物为白名单投影且无字段拒绝", async () => {
  withFixture(async (root) => {
    const outputRoot = path.join(root, "validation");
    const runDir = path.join(outputRoot, "2026-10-04-perf-metrics", "run-fixture");
    mkdirSync(runDir, { recursive: true });

    const previous = process.env.CODEX_HOME;
    // withFixture 已把 sessions/ 与 archived_sessions/ 建在 root 下，直接指向 root。
    process.env.CODEX_HOME = root;

    let shellResult;
    try {
      shellResult = await runShell({
        root: outputRoot,
        args: ["--source", "codex", "--output", runDir, "--max-files", "10", "--max-rows", "5000"],
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }

    assert.equal(shellResult.exitCode, 0, shellResult.logLines.join("\n"));
    const envelope = JSON.parse(readFileSync(path.join(runDir, "codex-probe.json"), "utf8"));
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.source, "codex");
    assert.deepEqual(envelope.fieldRejections, [], "不允许任何白名单拒绝");
    assert.equal(
      envelope.scanned.eligible,
      envelope.scanned.sampled + envelope.scanned.dropped + envelope.scanned.pending,
    );
    assert.equal(envelope.fields.timingKind, "item_span_estimate");
    assert.equal(envelope.fields.tokenScope, "reported_output_includes_reasoning");
    assert.equal(envelope.fields.sourceVerdict, "JSONL_ONLY");
    // 外壳独占键不得被来源改写
    assert.equal(envelope.decisions.maxFiles, 10);
    assert.equal(envelope.decisions.full, false);
    // 脱敏：产物里没有 fixture 的短标识与哨兵
    const raw = readFileSync(path.join(runDir, "codex-probe.json"), "utf8");
    for (const identifier of Object.values(T)) assert.equal(raw.includes(identifier), false, identifier);
    assert.equal(raw.includes("SENTINEL-CONTENT"), false);
    // 日志纪律：只有编码与计数
    for (const line of shellResult.logLines) {
      for (const identifier of Object.values(T)) assert.equal(line.includes(identifier), false, identifier);
    }
  });
});

test("端到端：缺源目录时外壳仍写结果文件，且不伪造 0 样本", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-probe-shell-"));
  try {
    const emptySources = path.join(root, "empty-sources");
    const outputRoot = path.join(root, "validation");
    const runDir = path.join(outputRoot, "2026-10-04-perf-metrics", "run-missing");
    mkdirSync(emptySources, { recursive: true });
    mkdirSync(runDir, { recursive: true });

    const driver = path.join(root, "driver.mjs");
    writeFileSync(
      driver,
      [
        `import { runPerfProbe } from ${JSON.stringify(pathToFileURL(PROBE_SHELL).href)};`,
        `import { pathToFileURL } from "node:url";`,
        `const exitCode = await runPerfProbe(${JSON.stringify([
          "--source",
          "codex",
          "--output",
          runDir,
        ])}, { log: () => {}, outputRoot: ${JSON.stringify(outputRoot)}, sourceModuleRoot: pathToFileURL(${JSON.stringify(
          `${emptySources}${path.sep}`,
        )}) });`,
        `process.exitCode = exitCode;`,
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [driver], { encoding: "utf8" });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    const envelope = JSON.parse(readFileSync(path.join(runDir, "codex-probe.json"), "utf8"));
    assert.equal(envelope.status, "failed");
    assert.equal(envelope.errorCode, "SOURCE_MODULE_MISSING");
    // 不伪造 0 样本：scanned 必须为空
    assert.deepEqual(envelope.scanned, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 返工回归（task-6）：四项审核复现缺陷的锁定用例
// ---------------------------------------------------------------------------

test("返工1：同线程同轮跨两个 rollout 文件时，两边的模型与终态证据都必须计入", () => {
  const root = customHome({
    // 文件 A：turn-shared 用 model-one，有 item，无终态
    "rollout-a1.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: "resp-a", outputTokens: 10 }),
    ],
    // 文件 B：**同一线程、同一轮**，模型不同（冲突）且带终态
    "rollout-a2.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-two", "high"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "Reasoning",
        itemId: "item-b",
        startedAtMs: 1_200,
        completedAtMs: 2_200,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: "resp-b", outputTokens: 20 }),
      taskComplete({ turnId: T.sharedTurn, startedAt: 1_000, completedAt: 2_200, durationMs: 1_200 }),
    ],
  });
  try {
    const { turns, facts } = ledgerOf(root, ["rollout-a1.jsonl", "rollout-a2.jsonl"]);
    const turn = [...turns.values()].find((entry) => entry.turnId === T.sharedTurn);
    assert.ok(turn, "同轮必须只建一条轮台账");

    // 缺陷复现点 1：第二个文件的模型证据不得被丢弃
    assert.deepEqual([...turn.modelKeys].sort(), ["model-one|low", "model-two|high"], "两个文件的模型证据都要计入");
    // 合并后 > 1 才是 MODEL_AMBIGUOUS
    assert.equal(facts.conflicts.modelAmbiguous, 1, "合并后的模型冲突必须被识别");
    // 缺陷复现点 2：第二个文件的终态不得被丢弃
    assert.equal(turn.terminals.length, 1, "第二个文件的 task_complete 必须计入");
    assert.equal(turn.fileKeys.size, 2, "该轮的两个 rollout 上下文都要登记");
    assert.equal(facts.crossFileMergedEvidence, 1, "跨文件合并量必须可观测");

    const info = codexModule.classifyTurn(turn);
    assert.equal(info.finalized, true, "已有终态不得被判为未结束");
    assert.equal(info.modelAmbiguous, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工1守门：跨线程同名 turn_id 仍不合并（防止本轮修回上次的正确行为）", () => {
  const root = customHome({
    "rollout-alpha.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-alpha",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: "resp-alpha", outputTokens: 10 }),
      taskComplete({ turnId: T.sharedTurn, startedAt: 1_000, completedAt: 2_000, durationMs: 1_000 }),
    ],
    "rollout-beta.jsonl": [
      sessionMeta(T.beta),
      turnContext(T.sharedTurn, "model-three", "medium"),
      itemCompleted({
        threadId: T.beta,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-beta",
        startedAtMs: 5_000,
        completedAtMs: 6_000,
      }),
      tokenUsageRecord({ threadId: T.beta, turnId: T.sharedTurn, responseId: "resp-beta", outputTokens: 60 }),
      taskComplete({ turnId: T.sharedTurn, startedAt: 5_000, completedAt: 6_000, durationMs: 1_000 }),
    ],
  });
  try {
    const { turns, facts } = ledgerOf(root, ["rollout-alpha.jsonl", "rollout-beta.jsonl"]);
    const shared = [...turns.values()].filter((entry) => entry.turnId === T.sharedTurn);
    assert.equal(shared.length, 2, "跨线程同名 turn_id 必须各成一轮");

    const byThread = new Map(shared.map((entry) => [entry.threadId, entry]));
    assert.deepEqual([...byThread.get(T.alpha).modelKeys], ["model-one|low"], "α 不得拿到 β 的模型");
    assert.deepEqual([...byThread.get(T.beta).modelKeys], ["model-three|medium"], "β 不得拿到 α 的模型");
    for (const turn of shared) {
      assert.equal(turn.terminals.length, 1, "各自的终态不得串味");
      assert.equal(turn.fileKeys.size, 1, "各自只应有一个 rollout 上下文");
    }
    assert.equal(facts.conflicts.modelAmbiguous, 0, "跨线程同名 turn_id 不是模型冲突");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工2：递增累计值 4,11 与请求之和 10 不一致时必须产生冲突（审核原始复现）", () => {
  const root = customHome({
    "rollout-ascending.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      // 请求输出 4、6 -> 去重之和 10；累计 4、11 -> 末条 11，不一致
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-1",
        outputTokens: 4,
        turnOutputTokens: 4,
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-2",
        outputTokens: 6,
        turnOutputTokens: 11,
      }),
      taskComplete({ turnId: T.sharedTurn, startedAt: 1_000, completedAt: 2_000, durationMs: 1_000 }),
    ],
  });
  try {
    const { turns } = ledgerOf(root, ["rollout-ascending.jsonl"]);
    const info = codexModule.classifyTurn([...turns.values()][0]);
    assert.equal(info.requestOutputSum, 10, "去重请求之和是分子主路径");
    assert.equal(info.lastTurnLevel, 11, "取的是**末条**累计输出，不是最大值");
    assert.equal(info.crossCheckAvailable, true, "递增序列必须可校验");
    assert.equal(info.crossCheckMatched, false, "末条累计与请求之和不等");
    assert.equal(info.crossCheckState, "conflict", "必须判为冲突，不得静默跳过");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工2：递增且末条累计正确时 matched；缺末条累计时才 unavailable（三态）", () => {
  const root = customHome({
    "rollout-good.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.alphaTurn2, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.alphaTurn2,
        itemType: "AgentMessage",
        itemId: "item-good",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.alphaTurn2,
        responseId: "resp-1",
        outputTokens: 4,
        turnOutputTokens: 4,
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.alphaTurn2,
        responseId: "resp-2",
        outputTokens: 6,
        turnOutputTokens: 10,
      }),
    ],
    // 末条累计缺失 -> unavailable
    "rollout-nolevel.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.alphaTurn3, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.alphaTurn3,
        itemType: "AgentMessage",
        itemId: "item-nolevel",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      {
        timestamp: "2026-10-01T00:00:03.000Z",
        type: "token_usage_record",
        payload: {
          thread_id: T.alpha,
          turn_id: T.alphaTurn3,
          response_id: "resp-nolevel",
          usage: { output_tokens: 7 },
          // turn_token_usage 缺失
        },
      },
    ],
  });
  try {
    const { turns } = ledgerOf(root, ["rollout-good.jsonl", "rollout-nolevel.jsonl"]);
    const byTurn = new Map([...turns.values()].map((entry) => [entry.turnId, codexModule.classifyTurn(entry)]));

    const good = byTurn.get(T.alphaTurn2);
    assert.equal(good.crossCheckState, "matched");
    assert.equal(good.crossCheckAvailable, true);
    assert.equal(good.crossCheckMatched, true);

    const noLevel = byTurn.get(T.alphaTurn3);
    assert.equal(noLevel.crossCheckState, "unavailable", "缺末条累计值属确实不可校验");
    assert.equal(noLevel.crossCheckAvailable, false);
    assert.equal(noLevel.crossCheckMatched, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工3：交集为 0 时不得因 jsonlComparable===0 提前短路，且只表述为「未观察到增益」", () => {
  // 无 SQLite 的可选源缺席场景
  const emptySqlite = { present: false, openedCount: 0, readOnlyFailedCount: 0, itemTypeCase: "unknown", files: {} };
  const selected = [{ filePath: "synthetic-file" }];

  assert.equal(codexModule.sourceVerdictOf(emptySqlite, selected), "JSONL_ONLY");
  assert.equal(codexModule.verdictEvidenceStrength(emptySqlite, selected), "optional_source_absent");

  // 有空 home -> UNSUPPORTED
  assert.equal(codexModule.sourceVerdictOf(emptySqlite, []), "UNSUPPORTED");
  assert.equal(codexModule.verdictEvidenceStrength(emptySqlite, []), "source_absent");

  // 库存在但身份交集为 0：只能给「未观察到增益」的证据强度，不能宣称已排除
  const zeroIntersection = {
    present: true,
    openedCount: 1,
    readOnlyFailedCount: 0,
    itemTypeCase: "camel_case",
    files: {
      "thread_history_1.sqlite": {
        targetItems: 100,
        withSpan: 50,
        spanEquivalence: { jsonlComparable: 0, sqliteWithSameItem: 0, sqliteWithSpan: 0, gapFillCount: 0 },
      },
    },
  };
  assert.equal(codexModule.sourceVerdictOf(zeroIntersection, selected), "JSONL_ONLY");
  assert.equal(
    codexModule.verdictEvidenceStrength(zeroIntersection, selected),
    "not_observed_insufficient_evidence",
    "交集为 0 属证据不足，不是反证",
  );

  // 确有补缺量 -> OPTIONAL_SQLITE_WORTHWHILE
  const gapFill = {
    present: true,
    openedCount: 1,
    readOnlyFailedCount: 0,
    itemTypeCase: "camel_case",
    files: {
      "thread_history_1.sqlite": {
        targetItems: 100,
        withSpan: 50,
        spanEquivalence: { jsonlComparable: 10, sqliteWithSameItem: 10, sqliteWithSpan: 6, gapFillCount: 4 },
      },
    },
  };
  assert.equal(codexModule.sourceVerdictOf(gapFill, selected), "OPTIONAL_SQLITE_WORTHWHILE");
  assert.equal(codexModule.verdictEvidenceStrength(gapFill, selected), "observed_over_comparable_identities");
  assert.equal(codexModule.optionalRoleOf(gapFill, selected), "gap_fill");
  assert.equal(codexModule.optionalRoleOf(zeroIntersection, selected), "none");
});

test("返工3：合成 SQLite fixture 下，JSONL 缺跨度而 SQLite 有跨度必须判为 gap_fill", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  for (const scenario of [
    { jsonlSpan: false, sqliteSpan: true, expected: "OPTIONAL_SQLITE_WORTHWHILE" },
    { jsonlSpan: true, sqliteSpan: true, expected: "JSONL_ONLY" },
    { jsonlSpan: true, sqliteSpan: false, expected: "JSONL_ONLY" },
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), "codex-probe-sqlite-"));
    try {
      const dir = path.join(root, "sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "rollout-x.jsonl"),
        jsonl([
          sessionMeta(T.alpha),
          turnContext(T.sharedTurn, "model-one", "low"),
          {
            timestamp: "2026-10-01T00:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "item_completed",
              thread_id: T.alpha,
              turn_id: T.sharedTurn,
              item: { type: "AgentMessage", id: T.itemA },
              started_at_ms: 1_000,
              ...(scenario.jsonlSpan ? { completed_at_ms: 2_000 } : {}),
            },
          },
          tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: "resp-a", outputTokens: 5 }),
          taskComplete({ turnId: T.sharedTurn, startedAt: 1, completedAt: 2, durationMs: 1 }),
        ]),
        "utf8",
      );
      const db = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
      db.exec(
        "CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, started_at_ms INTEGER, completed_at_ms INTEGER)",
      );
      db.prepare("INSERT INTO thread_items VALUES (?,?,?,?,?,?)").run(
        T.alpha,
        T.sharedTurn,
        T.itemA,
        "agentMessage",
        1_000,
        scenario.sqliteSpan ? 2_000 : null,
      );
      db.close();

      const result = await probeFixture(root, { maxFiles: 5, maxRows: 500 });
      assert.equal(
        result.fields.sourceVerdict,
        scenario.expected,
        `jsonlSpan=${scenario.jsonlSpan} sqliteSpan=${scenario.sqliteSpan}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("返工4：预算耗尽提前退出时 filesScanned 必须是实际读取数，不是选中数", async () => {
  const files = {};
  for (let index = 0; index < 5; index += 1) {
    files[`rollout-${index}.jsonl`] = [
      sessionMeta(T.alpha),
      turnContext(`turn-${index}`, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: `turn-${index}`,
        itemType: "AgentMessage",
        itemId: `item-${index}`,
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: `turn-${index}`, responseId: `resp-${index}`, outputTokens: 5 }),
    ];
  }
  const root = customHome(files);
  try {
    // 选中 5 个文件（maxFiles 足够），但行预算只够读完不足全部文件的记录。
    const result = await probeFixture(root, { maxFiles: 5, maxRows: 4 });
    assert.equal(result.scanned.filesDiscovered, 5, "5 个文件都被发现");
    // 缺陷复现点：旧实现上报 selected.length === 5（选中数），而非实际读取数。
    assert.ok(result.scanned.filesScanned < 5, "不得把选中数 5 当实际扫描数上报");
    assert.ok(result.scanned.filesScanned >= 1, "至少要读过首个文件");
    assert.equal(result.scanned.filesScanned, 1, "行预算只覆盖首个文件的一部分");
    assert.ok(result.scanned.filesScanned < result.scanned.filesDiscovered, "必须反映提前退出");
    // 不变式
    assert.ok(result.scanned.filesScanned <= result.scanned.filesDiscovered);
    assert.equal(result.scanned.files, result.scanned.filesDiscovered);
    assert.equal(result.scanned.sessionsScanned, result.scanned.filesScanned, "sessionsScanned 同等口径");
    assert.ok(result.scanned.sessionsScanned < result.scanned.filesDiscovered, "sessionsScanned 也不得多报");
    // 「实际读取」与「进入统计」分开表达。
    // 注意这两个量可以相等（首个文件刚好读满预算时 rowsRead === rowsScanned）；
    // 关键是它们各自如实反映，且 unparsedLines 恒等于两者之差。
    assert.ok(result.scanned.rowsRead >= result.scanned.rowsScanned, "读取行数不得少于进入台账的行数");
    assert.equal(result.scanned.unparsedLines, result.scanned.rowsRead - result.scanned.rowsScanned);
    // 预算耗尽：还有文件被发现但从未读取
    assert.ok(result.scanned.skipped > 0, "必须反映有文件未读取");
    assert.equal(result.scanned.skipped, result.scanned.filesDiscovered - result.scanned.filesScanned);
    assert.equal(result.scanned.truncated, true);
    assert.equal(result.scanned.complete, false, "未读全部文件不得算 complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工4：全部读完时 filesScanned === filesDiscovered 且 complete 为 true", async () => {
  const files = {};
  for (let index = 0; index < 3; index += 1) {
    files[`rollout-${index}.jsonl`] = [
      sessionMeta(T.alpha),
      turnContext(`turn-${index}`, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: `turn-${index}`,
        itemType: "AgentMessage",
        itemId: `item-${index}`,
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: `turn-${index}`, responseId: `resp-${index}`, outputTokens: 5 }),
    ];
  }
  const root = customHome(files);
  try {
    const result = await probeFixture(root, { maxFiles: 10, maxRows: 10_000 });
    assert.equal(result.scanned.filesScanned, result.scanned.filesDiscovered);
    assert.equal(result.scanned.filesScanned, 3);
    assert.equal(result.scanned.complete, true);
    assert.equal(result.scanned.truncated, false);
    assert.equal(result.scanned.skipped, 0);
    assert.ok(result.scanned.filesScanned <= result.scanned.filesDiscovered);
    assert.equal(result.scanned.files, result.scanned.filesDiscovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 返工2 回归（task-7）：文件计数一致 + 末条时序 + 会话元数据归属
// ---------------------------------------------------------------------------

test("返工2-1：decisions.filesScanned 与 scanned.filesScanned 必须同源同值（实际读取数）", async () => {
  const files = {};
  for (let index = 0; index < 5; index += 1) {
    files[`rollout-${index}.jsonl`] = [
      sessionMeta(T.alpha),
      turnContext(`turn-${index}`, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: `turn-${index}`,
        itemType: "AgentMessage",
        itemId: `item-${index}`,
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: `turn-${index}`, responseId: `resp-${index}`, outputTokens: 5 }),
    ];
  }
  const root = customHome(files);
  try {
    const result = await probeFixture(root, { maxFiles: 5, maxRows: 4 });
    // 缺陷复现点：旧实现 decisions.filesScanned = selected.length = 5，而 scanned.filesScanned = 2
    assert.equal(result.decisions.filesScanned, result.scanned.filesScanned, "同一物理量在产物里必须只有一个值");
    assert.equal(result.scanned.filesScanned, 1, "行预算只够读完第一个文件（含其 session_meta 行）");
    assert.ok(result.decisions.filesScanned < result.scanned.filesDiscovered, "都不得多报成选中数");
    assert.ok(result.scanned.filesScanned < result.scanned.filesDiscovered);
    // 发现数的三个同义键必须一致
    assert.equal(result.decisions.filesDiscovered, result.scanned.filesDiscovered);
    assert.equal(result.scanned.files, result.scanned.filesDiscovered);
    // fullScanRequested 语义不同：本次请求了全量（selected 5 === found 5），故为 true，
    // 尽管实际只读了 2 个 —— 这正是它**不应**被改成实际值的原因。
    assert.equal(result.decisions.fullScanRequested, true, "全量请求意图与实际扫描数是两件事");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工2-2：末条累计值按来源时序选，读入顺序相反时仍须 matched", () => {
  const root = customHome({
    // 文件 a 被先读，但里面的请求在**来源时序**上更晚（timestamp 更大）
    "rollout-a.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      // 来源时序上更晚：累计 10（末条）
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-later",
        outputTokens: 6,
        turnOutputTokens: 10,
        timestamp: "2026-10-01T00:00:09.000Z",
      }),
    ],
    "rollout-b.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      // 来源时序上更早：累计 4
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-earlier",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:05.000Z",
      }),
    ],
  });
  try {
    const { turns } = ledgerOf(root, ["rollout-a.jsonl", "rollout-b.jsonl"]);
    const info = codexModule.classifyTurn([...turns.values()].find((entry) => entry.turnId === T.sharedTurn));
    assert.equal(info.requestOutputSum, 10, "去重请求之和与顺序无关");
    assert.equal(info.lastTurnLevel, 10, "必须按来源时序选中真正的末条（而非最后读入的那条）");
    assert.equal(info.crossCheckState, "matched", "乱序读入不得把正确累计值判成冲突");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工2-2：末条请求缺累计值时判 unavailable，不得回退用较早的值", () => {
  const root = customHome({
    "rollout-a.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      // 较早那条**有**累计值 4 —— 若回退就会得到 matched，是错误行为
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-earlier",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:05.000Z",
      }),
      // 末条**缺**累计值
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-last",
        outputTokens: 6,
        omitTurnLevel: true,
        timestamp: "2026-10-01T00:00:09.000Z",
      }),
    ],
  });
  try {
    const { turns } = ledgerOf(root, ["rollout-a.jsonl"]);
    const info = codexModule.classifyTurn([...turns.values()][0]);
    assert.equal(info.requestOutputSum, 10);
    assert.equal(info.lastTurnLevel, null, "末条缺值就是缺值，不得回退到较早的 4");
    assert.equal(info.crossCheckAvailable, false);
    assert.equal(info.crossCheckState, "unavailable", "三态里的正确归属是不可校验");
    assert.notEqual(info.crossCheckState, "matched", "绝不能拿旧值得出 matched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工2-2：求和与顺序无关（同一组值，颠倒来源顺序结果相同）", () => {
  const forward = customHome({
    "rollout-a.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-1",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:05.000Z",
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-2",
        outputTokens: 6,
        turnOutputTokens: 10,
        timestamp: "2026-10-01T00:00:09.000Z",
      }),
    ],
  });
  const reversed = customHome({
    "rollout-a.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-2",
        outputTokens: 6,
        turnOutputTokens: 10,
        timestamp: "2026-10-01T00:00:09.000Z",
      }),
      tokenUsageRecord({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        responseId: "resp-1",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:05.000Z",
      }),
    ],
  });
  try {
    const a = codexModule.classifyTurn(ledgerOf(forward, ["rollout-a.jsonl"]).turns.values().next().value);
    const b = codexModule.classifyTurn(ledgerOf(reversed, ["rollout-a.jsonl"]).turns.values().next().value);
    assert.equal(a.requestOutputSum, b.requestOutputSum, "求和与顺序无关");
    assert.equal(a.requestOutputSum, 10);
    assert.equal(a.crossCheckState, "matched");
    assert.equal(b.crossCheckState, "matched");
    assert.equal(a.lastTurnLevel, b.lastTurnLevel, "末条按来源时序选，与记录排布无关");
  } finally {
    rmSync(forward, { recursive: true, force: true });
    rmSync(reversed, { recursive: true, force: true });
  }
});

test("返工2-3：仅含 turn_context + task_complete 的 rollout 用 session_meta.id 归属，证据必须计入", () => {
  const root = customHome({
    // 文件 A：本轮的请求与 item 都在这里
    "rollout-0001.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: "resp-a", outputTokens: 10 }),
    ],
    // 文件 B：**只含** turn_context 与 task_complete（两者都不带 thread_id），
    // 且 session_meta.id 与文件 A 相同 —— 缺陷 3 的盲区就在这里。
    "rollout-0002.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-two", "high"),
      taskComplete({ turnId: T.sharedTurn, startedAt: 1_000, completedAt: 2_200, durationMs: 1_200 }),
    ],
  });
  try {
    const { turns, orphanTerminals, facts } = ledgerOf(root, ["rollout-0001.jsonl", "rollout-0002.jsonl"]);
    const turn = [...turns.values()].find((entry) => entry.turnId === T.sharedTurn);
    const info = codexModule.classifyTurn(turn);
    assert.equal(turn.modelKeys.size, 2, "第二个文件的模型证据必须计入（靠 session_meta 兜底归属）");
    assert.equal(info.finalized, true, "第二个文件的终态必须让本轮成为 finalized");
    assert.equal(orphanTerminals.length, 0, "终态不得再成为 orphan");
    assert.equal(info.modelAmbiguous, true, "合并后的模型冲突必须被识别");
    assert.equal(facts.crossFileMergedEvidence, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工2-3：缺 session_meta 的异常文件保持 orphan，不猜归属", () => {
  const root = customHome({
    "rollout-a.jsonl": [
      sessionMeta(T.alpha),
      turnContext(T.sharedTurn, "model-one", "low"),
      itemCompleted({
        threadId: T.alpha,
        turnId: T.sharedTurn,
        itemType: "AgentMessage",
        itemId: "item-a",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
      }),
      tokenUsageRecord({ threadId: T.alpha, turnId: T.sharedTurn, responseId: "resp-a", outputTokens: 10 }),
    ],
    // 没有 session_meta：归属无法推导，**不得猜测**
    "rollout-b.jsonl": [turnContext(T.sharedTurn, "model-two", "high"), taskComplete({ turnId: T.sharedTurn })],
  });
  try {
    const { turns, orphanTerminals } = ledgerOf(root, ["rollout-a.jsonl", "rollout-b.jsonl"]);
    const turn = [...turns.values()].find((entry) => entry.turnId === T.sharedTurn);
    assert.deepEqual([...turn.modelKeys], ["model-one|low"], "不得把无法归属的模型证据挂上去");
    assert.equal(orphanTerminals.length, 1, "无法归属的终态必须保持 orphan");
    assert.equal(codexModule.classifyTurn(turn).finalized, false, "不得凭猜测认定已结束");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("返工4：未统计的键必须省略，已实测为 0 的键必须保留（不得同形）", async () => {
  await withFixture(async (root) => {
    const outputRoot = path.join(root, "validation");
    const runDir = path.join(outputRoot, "2026-10-04-perf-metrics", "run-omit");
    mkdirSync(runDir, { recursive: true });

    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    let shellResult;
    try {
      shellResult = await runShell({
        root: outputRoot,
        args: ["--source", "codex", "--output", runDir, "--max-files", "10", "--max-rows", "5000"],
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }

    assert.equal(shellResult.exitCode, 0, shellResult.logLines.join("\n"));
    const envelope = JSON.parse(readFileSync(path.join(runDir, "codex-probe.json"), "utf8"));
    const scanned = envelope.scanned;

    // ---- 省略集：本来源**从不统计**，写死 0 会被读成"实测为 0"。
    // 依据 codex.mjs：轮级终态只看 task_complete（turn_aborted 仅作事件计数）；
    // 无事件级版本分类；不解析 item_json 正文故无"坏 JSON 行"；无溢出跨度判据。
    for (const key of [
      "errorRows",
      "cancelledRows",
      "retryRows",
      "unsupportedVersionCount",
      "badJsonRows",
      "overflowingSpanCount",
      "missingTimestampCount",
    ]) {
      assert.equal(
        Object.hasOwn(scanned, key),
        false,
        `${key} 属"未统计"，必须省略而不是上报 0 —— 否则机器消费者无法区分`,
      );
    }

    // ---- 保留集：这些键**确实被计算**，不能被当成"未统计"一起省略。
    // crossCheck* 三态：保留的键必须满足恒等式，且三态之和等于可校验 + 不可校验。
    assert.equal(
      scanned.crossCheckAvailableCount,
      scanned.crossCheckMatchedCount + scanned.crossCheckConflictCount,
      "保留的 crossCheck 计数必须满足恒等式",
    );
    assert.equal(
      scanned.crossCheckAvailableCount + scanned.crossCheckUnavailableCount,
      scanned.eligible,
      "三态必须完整覆盖 eligible",
    );
    // 关键证据：本 fixture 的 conflict 是**真实算出**的（非 0），证明该键确有计算逻辑，
    // 属于"已实测"而不是"未统计"。
    assert.ok(
      scanned.crossCheckConflictCount > 0,
      "本 fixture 末条累计与请求之和不一致，conflict 必须被真实算出（证明该键有计算，不是写死）",
    );
    // requestHeaderCount / identityDuplicateCount：0 是**结构事实**（无 request/header 帧；
    // 重复按跨度折叠而非按行折叠）→ 保留。
    assert.equal(scanned.requestHeaderCount, 0, "结构事实为 0 → 保留");
    assert.equal(scanned.identityDuplicateCount, 0, "结构事实为 0 → 保留");

    // ---- 省略不得触发字段拒绝（外壳是「上限」不是「填表」）。
    assert.deepEqual(envelope.fieldRejections, [], "省略在册键不是越界字段");
  });
});
