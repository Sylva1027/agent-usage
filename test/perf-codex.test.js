import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computePerfCoverage,
  normalizePerfSample,
  perfFlagNamesOf,
  selectPerfSamples,
  summarizePerf,
} from "../src/perf-stats.js";
import { buildCodexResponseCandidates, buildCodexTurnCandidates } from "../src/perf-sources/codex-candidates.js";
import { readCodexRolloutMetadata } from "../src/perf-sources/codex-jsonl.js";
import {
  CODEX_PROJECTION_METHOD_VERSION,
  buildCodexThreadPerfSamples,
  codexSampleThreadId,
  planCodexHomeThreads,
  readCodexRollout,
} from "../src/perf-sources/codex-thread.js";
import { foldCodexRolloutMetadata } from "../src/perf-sources/codex-fold.js";
import { resolveCodexRequestTiming, resolveCodexTurnRequestTiming } from "../src/perf-sources/codex-request-timing.js";

const BODY_SENTINEL = "M61_BODY_SENTINEL_MUST_NOT_ESCAPE";
const SIX_TURN_FIXTURE_URL = new URL(
  "../docs/validation/2026-10-21-tps-measurement-correction/A/review/six-turn-request-fixture.json",
  import.meta.url,
);

async function createRollout(root, relativePath, lines) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function json(value) {
  return JSON.stringify(value);
}

function sessionMeta(threadId, overrides = {}) {
  return {
    type: "session_meta",
    payload: {
      id: threadId,
      session_id: threadId,
      source: "cli",
      thread_source: "user",
      model_provider: "openai",
      ...overrides,
    },
  };
}

function projected(kind, fields, sourcePath = "sessions/a.jsonl", lineNumber = 1) {
  return { kind, sourcePath, lineNumber, ...fields };
}

function folded(homeId, ...records) {
  return foldCodexRolloutMetadata(
    homeId,
    records.map((record) => ({ records: [record] })),
  );
}

function requestRecord(turnId, responseId, outputTokens, timestampMs, turnOutputTokens = outputTokens) {
  return projected("token_usage_record", {
    threadId: "Thread-A",
    turnId,
    responseId,
    outputTokens,
    turnOutputTokens,
    timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
  });
}

function responseRecord(
  turnId,
  responseId,
  outputTokens,
  timestampMs,
  { reasoningOutputTokens = null, turnOutputTokens = outputTokens } = {},
) {
  return projected("token_usage_record", {
    threadId: "Thread-A",
    turnId,
    responseId,
    outputTokens,
    reasoningOutputTokens,
    reasoningOutputTokensKnown: reasoningOutputTokens !== null,
    turnOutputTokens,
    timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
  });
}

function responseItemRecord({ turnId, itemId, responseItemType, role = null, callId = null, timestampMs }) {
  return projected("response_item", {
    threadId: "Thread-A",
    turnId,
    itemId,
    responseItemType,
    role,
    status: "completed",
    callId,
    timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
  });
}

function itemRecord(turnId, itemId, startedAtMs, completedAtMs, itemType = "AgentMessage") {
  return projected("item_completed", { threadId: "Thread-A", turnId, itemId, itemType, startedAtMs, completedAtMs });
}

function taskCompleteRecord(turnId) {
  return projected("task_complete", {
    threadId: "Thread-A",
    turnId,
    startedAtSec: 1_800_000_000,
    completedAtSec: 1_800_000_010,
    durationMs: 10_000,
  });
}

function normalized(candidate) {
  const result = normalizePerfSample(candidate);
  assert.ok(result.sample, `candidate should normalize: ${result.warningCode}`);
  return result.sample;
}

function coverage(samples) {
  return computePerfCoverage(selectPerfSamples(samples));
}

function buildCandidates(homeId, foldedResult, rolloutFiles = [], options = {}) {
  return buildCodexTurnCandidates(homeId, foldedResult, rolloutFiles, options);
}

function buildResponseCandidates(homeId, foldedResult, rolloutFiles = [], options = {}) {
  return buildCodexResponseCandidates(homeId, foldedResult, rolloutFiles, options);
}

function generationTiming(outputTokens, durationMs = 100, startOutputTokens = 1) {
  return { outputTokens, durationMs, startOutputTokens, timingKind: "first_last_output" };
}

function lookupDurations(durations) {
  const byResponse = new Map(Object.entries(durations));
  return ({ responseId, model, outputTokens }) => {
    const durationMs = byResponse.get(responseId);
    if (durationMs === undefined) {
      return { state: "missing", durationMs: null, reportedOutputTokens: null, requestedModel: null };
    }
    return { state: "available", durationMs, reportedOutputTokens: outputTokens, requestedModel: model };
  };
}

function sixTurnGenerationDuration(fixtureRequest) {
  return Math.max(1, Math.floor(fixtureRequest.durationMs / 2));
}

function sixTurnProjection(fixture, { missingResponseId = null } = {}) {
  const homeId = "home-six-turn";
  const threadId = "thread-six-turn";
  const sourcePath = "sessions/six-turn-fixture.jsonl";
  const records = [];
  const requestById = new Map();
  let lineNumber = 1;
  const append = (kind, fields) => records.push(projected(kind, fields, sourcePath, lineNumber++));

  append("session_meta", { threadId, explicitSubagent: false });
  for (const fixtureTurn of fixture.turns) {
    const endedAtMs = Date.parse(fixtureTurn.endedAt);
    append("turn_context", {
      threadId,
      turnId: fixtureTurn.id,
      model: fixture.requestedModel,
      effort: fixture.reasoningEffort,
    });
    let turnOutputTokens = 0;
    for (const fixtureRequest of fixtureTurn.requests) {
      turnOutputTokens += fixtureRequest.outputTokens;
      requestById.set(fixtureRequest.id, fixtureRequest);
      append("token_usage_record", {
        threadId,
        turnId: fixtureTurn.id,
        responseId: fixtureRequest.id,
        outputTokens: fixtureRequest.outputTokens,
        reasoningOutputTokens: null,
        reasoningOutputTokensKnown: false,
        turnOutputTokens,
        timestamp: new Date(endedAtMs).toISOString(),
      });
    }
  }

  const lookupRequestTiming = ({ responseId, model, outputTokens }) => {
    const fixtureRequest = requestById.get(responseId);
    assert.ok(fixtureRequest, `unknown fixture request ${responseId}`);
    assert.equal(model, fixture.requestedModel);
    assert.equal(outputTokens, fixtureRequest.outputTokens);
    if (responseId === missingResponseId) {
      return { state: "missing", durationMs: null, reportedOutputTokens: null, requestedModel: null };
    }
    return {
      state: "available",
      durationMs: fixtureRequest.durationMs,
      reportedOutputTokens: fixtureRequest.outputTokens,
      requestedModel: fixture.requestedModel,
      generation: generationTiming(fixtureRequest.outputTokens, sixTurnGenerationDuration(fixtureRequest), 1),
    };
  };

  return {
    homeId,
    threadId,
    rollouts: [{ filePath: sourcePath, threadId, projection: { records } }],
    lookupRequestTiming,
  };
}

test("M6.1 streams a metadata-only projection, counts malformed/unknown rows, and accepts only PascalCase target items", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m61-codex-jsonl-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = await createRollout(root, "sessions/2026/10/rollout-a.jsonl", [
    json(
      sessionMeta("Thread-A", {
        source: {
          subagent: { thread_spawn: { id: "private-agent-payload" }, other: BODY_SENTINEL },
          raw_content: BODY_SENTINEL,
        },
        extra: { args: BODY_SENTINEL },
      }),
    ),
    json({
      type: "turn_context",
      payload: { turn_id: "Turn-A", model: "Model-A", effort: "High", raw_content: BODY_SENTINEL },
    }),
    json({
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:03.000Z",
      payload: {
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        response_id: "Response-A",
        usage: { output_tokens: 31, reasoning_output_tokens: 8, raw_content: BODY_SENTINEL },
        turn_token_usage: { output_tokens: 31, item_json: BODY_SENTINEL },
        args: BODY_SENTINEL,
      },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        item: {
          id: "Item-A",
          type: "AgentMessage",
          content: BODY_SENTINEL,
          summary_text: BODY_SENTINEL,
          raw_content: BODY_SENTINEL,
        },
        started_at_ms: 1_800_000_000_100,
        completed_at_ms: 1_800_000_001_100,
        item_json: BODY_SENTINEL,
      },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        item: { id: "Item-R", type: "Reasoning", content: BODY_SENTINEL },
        started_at_ms: 1_800_000_001_200,
        completed_at_ms: 1_800_000_001_600,
      },
    }),
    json({
      type: "event_msg",
      payload: { type: "item_completed", thread_id: "Thread-A", turn_id: "Turn-A", item: { type: "Reasoning" } },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "Turn-A",
        started_at: 1_800_000_000,
        completed_at: 1_800_000_002,
        duration_ms: 2000,
        time_to_first_token_ms: BODY_SENTINEL,
        last_agent_message: BODY_SENTINEL,
      },
    }),
    json({ type: "event_msg", payload: { type: "task_started", turn_id: "Turn-A", body: BODY_SENTINEL } }),
    json({ type: "event_msg", payload: { type: "future_event", body: BODY_SENTINEL } }),
    json({ type: "response_item", payload: { content: BODY_SENTINEL } }),
    json({ type: "future_top_level", payload: { raw_content: BODY_SENTINEL } }),
    json({ type: "event_msg", payload: { type: "item_completed", item: { id: "Item-lower", type: "agentMessage" } } }),
    "{broken-json",
    "[]",
  ]);

  const { records, stats } = await readCodexRolloutMetadata(filePath);
  const sourcePath = path.resolve(filePath);
  assert.deepEqual(
    records.map((record) => record.kind),
    [
      "session_meta",
      "turn_context",
      "token_usage_record",
      "item_completed",
      "item_completed",
      "item_completed",
      "task_complete",
    ],
  );
  assert.deepEqual(records[0], {
    kind: "session_meta",
    sourcePath,
    lineNumber: 1,
    ordinal: null,
    threadId: "Thread-A",
    threadEvidenceConflict: false,
    sessionId: "Thread-A",
    parentThreadId: null,
    forkedFromId: null,
    sourceKind: "structured",
    explicitSubagent: true,
    explicitThreadSpawn: true,
    historyModePresent: false,
    historyModeType: "absent",
    historyMode: null,
    subagentHistoryStartOrdinalPresent: false,
    subagentHistoryStartOrdinalType: "absent",
    subagentHistoryStartOrdinal: null,
    historyBasePresent: false,
    historyBaseIsObject: false,
    historyBaseThreadIdPresent: false,
    historyBaseThreadIdType: "absent",
    historyBaseThreadId: null,
    historyBaseEndOrdinalPresent: false,
    historyBaseEndOrdinalType: "absent",
    historyBaseEndOrdinalExclusive: null,
    historyBaseEndByteOffsetPresent: false,
    historyBaseEndByteOffsetType: "absent",
    historyBaseEndByteOffset: null,
    forkedFromOrdinalExclusive: null,
    forkedFromOrdinalExclusivePresent: false,
    forkedFromOrdinalExclusiveType: "absent",
    threadSource: "user",
    modelProvider: "openai",
  });
  assert.equal(
    records[1].threadId,
    "Thread-A",
    "turn_context gets the unique session_meta thread only after the file scan",
  );
  assert.equal(records[1].turnId, "Turn-A");
  assert.equal(records[1].model, "Model-A");
  assert.equal(records[1].effort, "High");
  assert.deepEqual(records[2], {
    kind: "token_usage_record",
    sourcePath,
    lineNumber: 3,
    ordinal: null,
    threadId: "Thread-A",
    turnId: "Turn-A",
    responseId: "Response-A",
    outputTokens: 31,
    reasoningOutputTokens: 8,
    reasoningOutputTokensKnown: true,
    turnOutputTokens: 31,
    timestamp: "2026-10-01T00:00:03.000Z",
  });
  assert.equal(records[3].itemType, "AgentMessage");
  assert.equal(records[3].itemId, "Item-A");
  assert.equal(records[3].startedAtMs, 1_800_000_000_100);
  assert.equal(records[4].itemType, "Reasoning");
  assert.equal(records[5].itemId, null, "a target item without stable ID remains visible for M6.2 diagnostics");
  assert.equal(records[6].startedAtSec, 1_800_000_000, "task_complete timestamps remain seconds for terminal checks");
  assert.equal(records[6].completedAtSec, 1_800_000_002);
  assert.equal(records[6].durationMs, 2000);
  assert.equal(stats.malformedJsonLines, 1);
  assert.equal(stats.nonObjectRows, 1);
  assert.equal(stats.unknownTopLevelTypes, 1);
  assert.equal(stats.unknownEventTypes, 1);
  assert.equal(stats.unknownItemTypes, 1, "SQLite camelCase item types are not accepted as JSONL types");
  assert.equal(stats.recordsWithoutThreadId, 0);
  assert.equal(stats.recordsWithoutTurnId, 0);
  assert.equal(stats.invalidPayloadRows, 0);
  assert.equal(stats.invalidItemRows, 0);

  const projectionText = JSON.stringify(records);
  assert.equal(
    projectionText.includes(BODY_SENTINEL),
    false,
    "no body, args, TTFT, or item_json sentinel survives projection",
  );
  for (const forbiddenKey of [
    "payload",
    "content",
    "summary_text",
    "raw_content",
    "args",
    "item_json",
    "last_agent_message",
    "time_to_first_token_ms",
  ]) {
    assert.equal(
      records.some((record) => Object.hasOwn(record, forbiddenKey)),
      false,
      `${forbiddenKey} must not be projected`,
    );
  }
});

test("T2 projects response identity and reasoning counts without retaining stream bodies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "t2-codex-response-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = await createRollout(root, "sessions/response-projection.jsonl", [
    json(sessionMeta("Thread-A")),
    json({ type: "turn_context", payload: { turn_id: "Turn-A", model: "Model-A", effort: "high" } }),
    json({
      type: "response_item",
      timestamp: "2026-10-01T00:00:01.000Z",
      payload: { id: "Reasoning-1", type: "reasoning", summary: [{ text: BODY_SENTINEL }] },
    }),
    json({
      type: "response_item",
      timestamp: "2026-10-01T00:00:02.000Z",
      payload: { id: "Text-1", type: "message", role: "assistant", content: [{ text: BODY_SENTINEL }] },
    }),
    json({
      type: "response_item",
      timestamp: "2026-10-01T00:00:03.000Z",
      payload: {
        id: "Tool-1",
        type: "function_call",
        call_id: "Call-1",
        arguments: BODY_SENTINEL,
      },
    }),
    json({
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:04.000Z",
      payload: {
        turn_id: "Turn-A",
        response_id: "Response-1",
        usage: { output_tokens: 20, reasoning_output_tokens: 5 },
      },
    }),
    json({
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:05.000Z",
      payload: {
        turn_id: "Turn-A",
        response_id: "Response-2",
        usage: { output_tokens: 7 },
      },
    }),
  ]);

  const { records, stats } = await readCodexRolloutMetadata(filePath);
  const responseItems = records.filter((record) => record.kind === "response_item");
  assert.equal(responseItems.length, 3);
  assert.ok(responseItems.every((record) => record.threadId === "Thread-A" && record.turnId === "Turn-A"));
  assert.deepEqual(
    responseItems.map(({ itemId, responseItemType, role, callId, timestamp }) => ({
      itemId,
      responseItemType,
      role,
      callId,
      timestamp,
    })),
    [
      {
        itemId: "Reasoning-1",
        responseItemType: "reasoning",
        role: null,
        callId: null,
        timestamp: "2026-10-01T00:00:01.000Z",
      },
      {
        itemId: "Text-1",
        responseItemType: "message",
        role: "assistant",
        callId: null,
        timestamp: "2026-10-01T00:00:02.000Z",
      },
      {
        itemId: "Tool-1",
        responseItemType: "function_call",
        role: null,
        callId: "Call-1",
        timestamp: "2026-10-01T00:00:03.000Z",
      },
    ],
  );
  const usage = records.filter((record) => record.kind === "token_usage_record");
  assert.equal(usage[0].reasoningOutputTokens, 5);
  assert.equal(usage[0].reasoningOutputTokensKnown, true);
  assert.equal(usage[1].reasoningOutputTokens, null);
  assert.equal(usage[1].reasoningOutputTokensKnown, false);
  assert.equal(stats.recordsWithoutThreadId, 0);
  assert.equal(stats.recordsWithoutTurnId, 0);
  assert.equal(JSON.stringify(records).includes(BODY_SENTINEL), false);
});

test("T2 folds response items onto the following usage row and enriches replay counts", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Reasoning-1",
      responseItemType: "reasoning",
      timestampMs: baseMs,
    }),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Text-1",
      responseItemType: "message",
      role: "assistant",
      timestampMs: baseMs + 100,
    }),
    itemRecord("Turn-A", "Text-1", baseMs + 50, baseMs + 150),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Tool-1",
      responseItemType: "function_call",
      callId: "Call-1",
      timestampMs: baseMs + 200,
    }),
    responseRecord("Turn-A", "Response-A", 20, baseMs + 300, { reasoningOutputTokens: 5 }),
    projected("token_usage_record", {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "Response-A",
      outputTokens: null,
      reasoningOutputTokens: null,
      reasoningOutputTokensKnown: false,
      turnOutputTokens: null,
      timestamp: null,
    }),
  );
  const [turn] = result.turns;
  assert.equal(turn.responseCount, 1);
  assert.equal(result.stats.responseCount, 1);
  assert.equal(turn.responses[0].outputTokens, 20);
  assert.equal(turn.responses[0].reasoningOutputTokens, 5);
  assert.equal(turn.responses[0].reasoningOutputTokensKnown, true);
  assert.deepEqual(
    turn.responses[0].events.map(({ itemId, outputKind }) => [itemId, outputKind]),
    [
      ["Reasoning-1", "reasoning"],
      ["Text-1", "text"],
      ["Tool-1", "tool"],
    ],
  );
});

test("T2 emits one v3 candidate per response and only samples exact gateway generation", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    responseRecord("Turn-A", "Response-A", 20, baseMs + 1_000, { reasoningOutputTokens: 5 }),
    responseRecord("Turn-A", "Response-B", 25, baseMs + 2_000, { reasoningOutputTokens: 0 }),
  );
  const queries = [];
  const built = buildResponseCandidates("home-A", result, [], {
    lookupRequestTiming: (query) => {
      queries.push(query);
      if (query.responseId === "Response-B") {
        return { state: "missing", durationMs: null, reportedOutputTokens: null, requestedModel: null };
      }
      return {
        state: "available",
        durationMs: 900,
        reportedOutputTokens: 20,
        requestedModel: "Model-A",
        generation: generationTiming(15, 200, 1),
      };
    },
  });

  assert.deepEqual(
    queries.map(({ responseId, outputTokens }) => [responseId, outputTokens]),
    [
      ["Response-A", 20],
      ["Response-B", 25],
    ],
    "gateway lookup reconciles the raw total before subtracting reasoning or the start token",
  );
  assert.equal(queries[0].reasoningOutputTokens, 5);
  assert.equal(queries[1].reasoningOutputTokens, 0);
  assert.equal(built.candidates.length, 2);
  const [sampled, missing] = built.candidates;
  assert.equal(sampled.outputTokens, 14);
  assert.equal(sampled.durationMs, 200);
  assert.equal(sampled.requestCount, 1);
  assert.equal(sampled.reportedOutputTokens, 20);
  assert.equal(sampled.window, "request");
  assert.equal(sampled.timingKind, "generation");
  assert.equal(sampled.tokenScope, "non_reasoning_output");
  assert.equal(sampled.methodVersion, "tps-v5");
  assert.equal(missing.outputTokens, null);
  assert.equal(missing.durationMs, null);
  assert.equal(missing.requestCount, 1);
  assert.equal(missing.model, "Model-A");
  assert.ok(missing.sampleFlags.includes("MISSING_DURATION"));

  const samples = built.candidates.map(normalized);
  assert.deepEqual(
    samples.map((sample) => sample.sampleKey),
    ['["codex","home-A","Thread-A","Turn-A","Response-A"]', '["codex","home-A","Thread-A","Turn-A","Response-B"]'],
  );
  assert.equal(samples[0].tsMs, baseMs + 1_000, "usage completion places the response without task_complete");
  assert.equal(samples[1].tsMs, baseMs + 2_000);
});

test("T2 isolates response, cumulative-turn, and native item conflicts from request generation samples", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    responseRecord("Turn-A", "Response-Raw-Conflict", 20, baseMs + 1_000, { reasoningOutputTokens: 0 }),
    responseRecord("Turn-A", "Response-Raw-Conflict", 21, baseMs + 1_000, { reasoningOutputTokens: 0 }),
    responseRecord("Turn-A", "Response-Timing-Conflict", 30, baseMs + 2_000, {
      reasoningOutputTokens: 0,
    }),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Item-Conflict",
      responseItemType: "message",
      role: "assistant",
      timestampMs: baseMs + 2_900,
    }),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Item-Conflict",
      responseItemType: "function_call",
      callId: "Call-Conflict",
      timestampMs: baseMs + 2_900,
    }),
    responseRecord("Turn-A", "Response-Cumulative-Conflict", 35, baseMs + 2_500, {
      reasoningOutputTokens: 0,
      turnOutputTokens: 35,
    }),
    responseRecord("Turn-A", "Response-Cumulative-Conflict", 35, baseMs + 2_500, {
      reasoningOutputTokens: 0,
      turnOutputTokens: 70,
    }),
    responseRecord("Turn-A", "Response-Valid", 40, baseMs + 3_000, { reasoningOutputTokens: 0 }),
  );
  const built = buildResponseCandidates("home-A", result, [], {
    lookupRequestTiming: ({ responseId, model, outputTokens }) => {
      if (responseId === "Response-Timing-Conflict") {
        return {
          state: "conflict",
          durationMs: null,
          reportedOutputTokens: null,
          requestedModel: null,
          generation: null,
        };
      }
      return {
        state: "available",
        durationMs: 500,
        reportedOutputTokens: outputTokens,
        requestedModel: model,
        generation: generationTiming(outputTokens, 200, 1),
      };
    },
  });

  assert.equal(built.candidates.length, 4);
  const byResponse = new Map(built.candidates.map((candidate) => [candidate.responseId, candidate]));
  assert.equal(byResponse.get("Response-Raw-Conflict").outputTokens, null);
  assert.ok(byResponse.get("Response-Raw-Conflict").sampleFlags.includes("RECORD_CONFLICT"));
  assert.equal(byResponse.get("Response-Timing-Conflict").outputTokens, null);
  assert.ok(byResponse.get("Response-Timing-Conflict").sampleFlags.includes("RECORD_CONFLICT"));

  const cumulative = byResponse.get("Response-Cumulative-Conflict");
  assert.equal(
    result.turns[0].responses.find((response) => response.responseId === "Response-Cumulative-Conflict").conflict,
    false,
    "the cumulative snapshot does not become a per-response conflict",
  );
  assert.equal(cumulative.outputTokens, 34);
  assert.equal(cumulative.durationMs, 200);
  assert.equal(cumulative.timingSource, "explicit");
  assert.equal(cumulative.sampleFlags.includes("RECORD_CONFLICT"), false);
  assert.equal(cumulative.sampleFlags.includes("MISSING_DURATION"), false);
  assert.equal(cumulative.generation.outputTokens, 35);
  assert.ok(
    result.turns[0].flags.includes("RECORD_CONFLICT"),
    "the conflicting cumulative snapshot remains visible in turn diagnostics",
  );

  const valid = byResponse.get("Response-Valid");
  assert.equal(valid.outputTokens, 39);
  assert.equal(valid.durationMs, 200);
  assert.equal(valid.timingSource, "explicit");
  assert.equal(valid.sampleFlags.includes("RECORD_CONFLICT"), false);
  assert.equal(valid.sampleFlags.includes("MISSING_DURATION"), false);
  assert.equal(
    result.turns[0].recordConflictCount,
    4,
    "raw request, native item, cumulative snapshot, and turn-total conflicts remain visible as diagnostics",
  );
  assert.equal(valid.generation.outputTokens, 40);

  const ambiguous = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-Ambiguous", model: "Model-A", effort: "high" }),
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-Ambiguous", model: "Model-B", effort: "high" }),
    responseRecord("Turn-Ambiguous", "Response-Ambiguous", 20, baseMs + 4_000, {
      reasoningOutputTokens: 0,
    }),
  );
  const ambiguousBuilt = buildResponseCandidates("home-A", ambiguous, [], {
    lookupRequestTiming: ({ outputTokens }) => ({
      state: "available",
      durationMs: 500,
      reportedOutputTokens: outputTokens,
      requestedModel: "Model-A",
      generation: generationTiming(outputTokens, 200, 1),
    }),
  });
  assert.equal(ambiguousBuilt.candidates.length, 1);
  assert.equal(ambiguousBuilt.candidates[0].outputTokens, null);
  assert.ok(ambiguousBuilt.candidates[0].sampleFlags.includes("MODEL_AMBIGUOUS"));
});

test("T2 never derives generation from native item lifecycle timestamps", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Text-1",
      responseItemType: "message",
      role: "assistant",
      timestampMs: baseMs + 150,
    }),
    itemRecord("Turn-A", "Text-1", baseMs, baseMs + 150),
    responseRecord("Turn-A", "Response-Text", 20, baseMs + 200, { reasoningOutputTokens: 0 }),
    responseItemRecord({
      turnId: "Turn-A",
      itemId: "Tool-1",
      responseItemType: "function_call",
      callId: "Call-1",
      timestampMs: baseMs + 1_100,
    }),
    responseRecord("Turn-A", "Response-Tool", 10, baseMs + 1_200, { reasoningOutputTokens: 0 }),
  );
  const built = buildResponseCandidates("home-A", result, []);

  assert.equal(built.candidates.length, 2);
  assert.ok(
    built.candidates.every(
      (candidate) =>
        candidate.durationMs === null &&
        candidate.outputTokens === null &&
        candidate.sampleFlags.includes("MISSING_DURATION"),
    ),
    "item spans and response_item timestamps are lifecycle metadata, not stream output deltas",
  );
});

test("T2 keeps legacy turn timing readable while request resolution uses raw totals", () => {
  const turn = {
    threadId: "Thread-A",
    turnId: "Turn-A",
    model: "Model-A",
    requestSetComplete: true,
    requests: [
      { responseId: "Response-A", outputTokens: 20 },
      { responseId: "Response-B", outputTokens: 30 },
    ],
  };
  const e2eDurations = new Map([
    ["Response-A", 100],
    ["Response-B", 200],
  ]);
  let legacyQuery;
  const legacy = resolveCodexTurnRequestTiming("home-A", turn, (query) => {
    legacyQuery = query;
    return {
      state: "available",
      durationMs: e2eDurations.get(query.responseId),
      reportedOutputTokens: query.outputTokens,
      requestedModel: query.model,
    };
  });
  assert.deepEqual(legacy, {
    state: "complete",
    durationMs: 300,
    timedRequestCount: 2,
    requestCount: 2,
  });
  assert.equal(Object.hasOwn(legacyQuery, "reasoningOutputTokens"), false);

  const request = { responseId: "Response-A", outputTokens: 20 };
  const resolved = resolveCodexRequestTiming("home-A", turn, request, ({ model, outputTokens }) => ({
    state: "available",
    durationMs: 100,
    reportedOutputTokens: outputTokens,
    requestedModel: model,
    generation: generationTiming(15, 60, 1),
  }));
  assert.equal(resolved.state, "available");
  assert.equal(resolved.reportedOutputTokens, 20);
  assert.deepEqual(resolved.generation, generationTiming(15, 60, 1));

  const mismatch = resolveCodexRequestTiming("home-A", turn, request, ({ model }) => ({
    state: "available",
    durationMs: 100,
    reportedOutputTokens: 21,
    requestedModel: model,
    generation: generationTiming(15, 60, 1),
  }));
  assert.equal(mismatch.state, "conflict");
});

test("T2 keeps global response ownership conflicts and reads both legacy and v3 sample keys", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    responseRecord("Turn-A", "Shared", 20, baseMs + 1_000, { reasoningOutputTokens: 0 }),
    responseRecord("Turn-B", "Shared", 20, baseMs + 1_000, { reasoningOutputTokens: 0 }),
  );
  const built = buildResponseCandidates("home-A", result, []);
  assert.equal(built.candidates.length, 2);
  assert.ok(
    built.candidates.every(
      (candidate) =>
        candidate.outputTokens === null &&
        candidate.durationMs === null &&
        candidate.sampleFlags.includes("RECORD_CONFLICT"),
    ),
  );
  assert.equal(
    codexSampleThreadId({
      sourceKind: "codex",
      homeId: "home-A",
      sampleKey: '["codex","home-A","Thread-A","Turn-A"]',
    }),
    "Thread-A",
  );
  assert.equal(
    codexSampleThreadId({
      sourceKind: "codex",
      homeId: "home-A",
      sampleKey: '["codex","home-A","Thread-A","Turn-A","Response-A"]',
    }),
    "Thread-A",
  );
  assert.equal(CODEX_PROJECTION_METHOD_VERSION, "codex-projection-v6");
});

test("M6.1 resolves no-thread records only from one file's unique session_meta and keeps same turn IDs in separate threads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m61-codex-rollouts-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const activeFile = await createRollout(root, "sessions/2026/10/rollout-active.jsonl", [
    json(sessionMeta("Thread-Active")),
    json({ type: "turn_context", payload: { turn_id: "Shared-Turn", model: "Model-A", effort: "low" } }),
    json({ type: "event_msg", payload: { type: "task_complete", turn_id: "Shared-Turn" } }),
  ]);
  const activeContinuationFile = await createRollout(root, "sessions/2026/10/rollout-active-continuation.jsonl", [
    json(sessionMeta("Thread-Active")),
    json({ type: "turn_context", payload: { turn_id: "Next-Turn", model: "Model-A", effort: "low" } }),
  ]);
  const archivedFile = await createRollout(root, "archived_sessions/2026/09/rollout-archived.jsonl", [
    json(sessionMeta("Thread-Archived")),
    json({ type: "turn_context", payload: { turn_id: "Shared-Turn", model: "Model-B", effort: "high" } }),
    json({
      type: "token_usage_record",
      timestamp: "2026-09-30T00:00:00.000Z",
      payload: {
        thread_id: "Thread-Archived",
        turn_id: "Shared-Turn",
        response_id: "Archived-Response",
        usage: { output_tokens: 3 },
      },
    }),
  ]);

  const active = await readCodexRolloutMetadata(activeFile);
  const activeContinuation = await readCodexRolloutMetadata(activeContinuationFile);
  const archived = await readCodexRolloutMetadata(archivedFile);
  const activeContext = active.records.find((record) => record.kind === "turn_context");
  const continuationContext = activeContinuation.records.find((record) => record.kind === "turn_context");
  const archivedContext = archived.records.find((record) => record.kind === "turn_context");
  assert.equal(activeContext.threadId, "Thread-Active");
  assert.equal(
    continuationContext.threadId,
    activeContext.threadId,
    "two rollout files from one thread preserve the same thread identity",
  );
  assert.notEqual(continuationContext.turnId, activeContext.turnId);
  assert.equal(archivedContext.threadId, "Thread-Archived");
  assert.equal(
    activeContext.turnId,
    archivedContext.turnId,
    "identical turn_id values remain distinct when grouped by thread later",
  );
  assert.ok(activeContext.sourcePath.includes(`${path.sep}sessions${path.sep}`));
  assert.ok(archivedContext.sourcePath.includes(`${path.sep}archived_sessions${path.sep}`));
  assert.equal(active.stats.recordsWithoutThreadId, 0);
  assert.equal(archived.stats.recordsWithoutThreadId, 0);
});

test("M6.1 warns on missing or ambiguous file thread evidence instead of guessing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m61-codex-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const ambiguousFile = await createRollout(root, "sessions/ambiguous.jsonl", [
    json(sessionMeta("Thread-One")),
    json(sessionMeta("Thread-Two")),
    json({ type: "turn_context", payload: { turn_id: "Turn-A", model: "Model-A" } }),
  ]);
  // M8.2 §2 field ruling: `id` is the CURRENT thread (ThreadId) and
  // `session_id` is the ROOT thread (SessionId). They are different identity
  // levels, so a sub-thread whose root session differs must be accepted with
  // canonical = id — this deliberately revises the former "must be equal" rule.
  const subagentRootSessionFile = await createRollout(root, "sessions/subagent-root-session.jsonl", [
    json(sessionMeta("Thread-Id", { session_id: "Thread-Session" })),
    json({ type: "event_msg", payload: { type: "task_complete", turn_id: "Turn-B" } }),
  ]);
  const orphanFile = await createRollout(root, "archived_sessions/orphan.jsonl", [
    json({ type: "turn_context", payload: { model: "Model-Orphan" } }),
    json({ type: "token_usage_record", payload: { thread_id: "Thread-Orphan", usage: { output_tokens: 1 } } }),
  ]);

  const ambiguous = await readCodexRolloutMetadata(ambiguousFile);
  const subagentRootSession = await readCodexRolloutMetadata(subagentRootSessionFile);
  const orphan = await readCodexRolloutMetadata(orphanFile);
  assert.equal(ambiguous.records.find((record) => record.kind === "turn_context").threadId, null);
  assert.equal(ambiguous.stats.ambiguousSessionMetaThreadId, 1);
  assert.equal(ambiguous.stats.recordsWithoutThreadId, 1);
  // Different id/session_id is not a conflict; the current thread id wins.
  assert.equal(subagentRootSession.records[0].threadId, "Thread-Id");
  assert.equal(subagentRootSession.records[0].threadEvidenceConflict, false);
  assert.equal(subagentRootSession.stats.ambiguousSessionMetaThreadId, 0);
  assert.equal(subagentRootSession.stats.recordsWithoutThreadId, 0);
  assert.equal(subagentRootSession.records.find((record) => record.kind === "task_complete").threadId, "Thread-Id");
  assert.equal(orphan.records[0].threadId, null);
  assert.equal(orphan.stats.recordsWithoutThreadId, 1);
  assert.equal(orphan.stats.recordsWithoutTurnId, 2);
});

test("M6.1 propagates rollout read failures so callers cannot publish a readable subset", async () => {
  await assert.rejects(
    readCodexRolloutMetadata(path.join(os.tmpdir(), "m61-codex-file-does-not-exist.jsonl")),
    (error) => error?.code === "ENOENT",
  );
});

test("M6.2 keys turns by home and thread, keeps exact-turn model evidence, and marks same-turn ambiguity", () => {
  const { turns } = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-1", model: "Model-A", effort: "low" }),
    projected(
      "turn_context",
      { threadId: "Thread-A", turnId: "Turn-2", model: "Model-B", effort: "high" },
      "sessions/b.jsonl",
    ),
    projected(
      "turn_context",
      { threadId: "thread-a", turnId: "Turn-1", model: "Model-C", effort: "low" },
      "sessions/c.jsonl",
    ),
    projected(
      "turn_context",
      { threadId: "Thread-C", turnId: "Turn-1", model: "Model-X", effort: "low" },
      "sessions/d.jsonl",
    ),
    projected(
      "turn_context",
      { threadId: "Thread-C", turnId: "Turn-1", model: "Model-Y", effort: "high" },
      "sessions/e.jsonl",
    ),
    projected("session_meta", { threadId: "Thread-A", explicitSubagent: true }, "sessions/a.jsonl"),
    projected("session_meta", { threadId: "thread-a", explicitSubagent: false }, "sessions/c.jsonl"),
  );
  const byIdentity = new Map(turns.map((turn) => [`${turn.threadId}/${turn.turnId}`, turn]));
  assert.equal(turns.length, 4);
  assert.equal(byIdentity.get("Thread-A/Turn-1").model, "Model-A");
  assert.equal(
    byIdentity.get("Thread-A/Turn-2").model,
    "Model-B",
    "a later turn model never backfills an earlier turn",
  );
  assert.equal(
    byIdentity.get("thread-a/Turn-1").model,
    "Model-C",
    "thread identity preserves case as well as turn IDs",
  );
  assert.deepEqual(byIdentity.get("Thread-C/Turn-1").flags, ["MODEL_AMBIGUOUS"]);
  assert.equal(byIdentity.get("Thread-C/Turn-1").model, null);
  assert.equal(byIdentity.get("Thread-C/Turn-1").effort, null);
  assert.equal(byIdentity.get("Thread-A/Turn-1").agentKind, "subagent");
  assert.equal(byIdentity.get("thread-a/Turn-1").agentKind, "unknown", "a non-subagent entrypoint does not prove main");
});

test("M6.2 folds replayed request/item records, enriches missing fields, and checks the final cumulative snapshot", () => {
  const request1 = projected(
    "token_usage_record",
    {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "Response-A",
      outputTokens: 10,
      turnOutputTokens: 10,
      timestamp: "2026-10-01T00:00:01.000Z",
    },
    "sessions/z.jsonl",
    2,
  );
  const request1Replay = projected(
    "token_usage_record",
    {
      threadId: "Thread-A",
      turnId: null,
      responseId: "Response-A",
      outputTokens: null,
      turnOutputTokens: null,
      timestamp: null,
    },
    "sessions/a.jsonl",
    1,
  );
  const request2 = projected(
    "token_usage_record",
    {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "response-a",
      outputTokens: 7,
      turnOutputTokens: 17,
      timestamp: "2026-10-01T00:00:02.000Z",
    },
    "sessions/z.jsonl",
    3,
  );
  const item = projected(
    "item_completed",
    {
      threadId: "Thread-A",
      turnId: "Turn-A",
      itemId: "Item-A",
      itemType: "AgentMessage",
      startedAtMs: 100,
      completedAtMs: 200,
    },
    "sessions/z.jsonl",
    4,
  );
  const itemReplay = projected(
    "item_completed",
    {
      threadId: "Thread-A",
      turnId: "Turn-A",
      itemId: "Item-A",
      itemType: "AgentMessage",
      startedAtMs: null,
      completedAtMs: 200,
    },
    "sessions/a.jsonl",
    2,
  );
  const result = foldCodexRolloutMetadata("home-A", [
    { records: [request1, request2, item] },
    { records: [request1Replay, itemReplay] },
  ]);
  const [turn] = result.turns;
  assert.equal(turn.requestCount, 2);
  assert.deepEqual(
    turn.requests.map(({ responseId }) => responseId),
    ["Response-A", "response-a"],
    "request identity preserves case",
  );
  assert.equal(turn.itemCount, 1);
  assert.equal(
    turn.items[0].startedAtMs,
    100,
    "a replay with a missing start is enriched from the same stable item identity",
  );
  assert.equal(turn.requestOutputSum, 17, "only unique usage.output_tokens are summed");
  assert.equal(turn.lastTurnOutputTokens, 17);
  assert.equal(turn.crossCheckState, "matched");
  assert.equal(turn.requestOrderBasis, "timestamp");
  assert.deepEqual(turn.flags, []);
  assert.equal(result.stats.requestCount, 2);
  assert.equal(result.stats.itemCount, 1);
});

test("M6.2 rejects conflicting duplicate values and preserves sum-mismatch diagnostics", () => {
  const { turns, stats } = folded(
    "home-A",
    projected("token_usage_record", {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "Response-A",
      outputTokens: 4,
      turnOutputTokens: 9,
      timestamp: "2026-10-01T00:00:01.000Z",
    }),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Response-A",
        outputTokens: 5,
        turnOutputTokens: 9,
        timestamp: "2026-10-01T00:00:02.000Z",
      },
      "sessions/b.jsonl",
    ),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Response-B",
        outputTokens: 4,
        turnOutputTokens: 9,
        timestamp: "2026-10-01T00:00:03.000Z",
      },
      "sessions/c.jsonl",
    ),
    projected(
      "item_completed",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        itemId: "Item-A",
        itemType: "AgentMessage",
        startedAtMs: 100,
        completedAtMs: 200,
      },
      "sessions/a.jsonl",
      4,
    ),
    projected(
      "item_completed",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        itemId: "Item-A",
        itemType: "AgentMessage",
        startedAtMs: 101,
        completedAtMs: 200,
      },
      "sessions/b.jsonl",
      4,
    ),
  );
  const [turn] = turns;
  assert.equal(turn.requestCount, 2);
  assert.equal(turn.requests[0].outputTokens, null, "conflicting request output is not last-wins");
  assert.equal(turn.requestOutputSum, null, "a conflicting request is not silently omitted from a partial sum");
  assert.equal(turn.items[0].startedAtMs, null, "conflicting item time is not last-wins");
  assert.equal(turn.requestSumMismatchCount, 0, "unavailable sums are not misreported as mismatches");
  assert.equal(turn.crossCheckState, "unavailable");
  assert.deepEqual(turn.flags, ["RECORD_CONFLICT"]);
  assert.equal(turn.recordConflictCount, 2, "the request and item identities are separately counted");
  assert.equal(stats.recordConflictCount, 2);
});

test("M6.2 reports unkeyable rows per turn and marks a real cumulative mismatch", () => {
  const { turns, stats } = folded(
    "home-A",
    projected("token_usage_record", {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "Response-A",
      outputTokens: 4,
      turnOutputTokens: 9,
      timestamp: "2026-10-01T00:00:01.000Z",
    }),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Response-B",
        outputTokens: 4,
        turnOutputTokens: 9,
        timestamp: "2026-10-01T00:00:02.000Z",
      },
      "sessions/b.jsonl",
    ),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: null,
        outputTokens: 100,
        turnOutputTokens: 100,
        timestamp: "2026-10-01T00:00:03.000Z",
      },
      "sessions/c.jsonl",
    ),
    projected(
      "item_completed",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        itemId: null,
        itemType: "Reasoning",
        startedAtMs: 100,
        completedAtMs: 200,
      },
      "sessions/d.jsonl",
    ),
  );
  const [turn] = turns;
  assert.equal(turn.requestCount, 2, "an unkeyable row never becomes a synthetic request");
  assert.equal(turn.itemCount, 0, "an item without id never becomes a synthetic item");
  assert.equal(turn.diagnostics.unkeyableRequestCount, 1);
  assert.equal(turn.diagnostics.unkeyableItemCount, 1);
  assert.equal(turn.diagnostics.unkeyableRequests.length, 1);
  assert.equal(turn.diagnostics.unkeyableRequests[0].turnOutputTokens, 100);
  assert.equal(turn.requestSetComplete, false);
  assert.deepEqual(
    turn.flags,
    ["RECORD_CONFLICT"],
    "unkeyable rows stay in source-warning diagnostics, outside the sample flag bitset",
  );
  assert.equal(turn.crossCheckState, "conflict");
  assert.equal(turn.requestSumMismatchCount, 1);
  assert.equal(stats.requestSumMismatchCount, 1);
  assert.equal(stats.unkeyableRequestRecords, 1);
  assert.equal(stats.unkeyableItemRecords, 1);
});

test("M6.2 uses path/line fallback when any request timestamp is unavailable", () => {
  const { turns } = folded(
    "home-A",
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Response-A",
        outputTokens: 5,
        turnOutputTokens: 5,
        timestamp: "2026-10-01T00:00:20.000Z",
      },
      "sessions/a.jsonl",
      2,
    ),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Response-B",
        outputTokens: 3,
        turnOutputTokens: 8,
        timestamp: null,
      },
      "sessions/b.jsonl",
      1,
    ),
  );
  assert.equal(turns[0].requestOrderBasis, "source_path_line_fallback");
  assert.equal(turns[0].requests.at(-1).responseId, "Response-B");
  assert.equal(turns[0].lastTurnOutputTokens, 8, "the final cumulative field does not fall back to an earlier request");
  assert.equal(turns[0].crossCheckState, "matched");
});

test("M6.2 marks a response ID assigned to multiple turns as an ownership conflict", () => {
  const { turns, stats } = folded(
    "home-A",
    projected("token_usage_record", {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "Response-A",
      outputTokens: 4,
      turnOutputTokens: 4,
      timestamp: "2026-10-01T00:00:01.000Z",
    }),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-B",
        responseId: "Response-A",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:01.000Z",
      },
      "sessions/b.jsonl",
    ),
  );
  assert.equal(turns.length, 2);
  assert.ok(turns.every((turn) => turn.requestCount === 0 && turn.flags.includes("RECORD_CONFLICT")));
  assert.equal(stats.conflictingRequests, 1);
  assert.equal(stats.unassignedRequests, 1);
});

test("M6.2 compares the latest missing-ID cumulative snapshot instead of falling back to an earlier keyed request", () => {
  const { turns, stats } = folded(
    "home-A",
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Known",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:01.000Z",
      },
      "sessions/a.jsonl",
      1,
    ),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: null,
        outputTokens: 100,
        turnOutputTokens: 104,
        timestamp: "2026-10-01T00:00:02.000Z",
      },
      "sessions/b.jsonl",
      1,
    ),
  );
  const [turn] = turns;
  assert.equal(turn.requestCount, 1, "the missing responseId never becomes a synthetic request");
  assert.equal(turn.requestOutputSum, 4, "unkeyable output is not added to the deduplicated request sum");
  assert.equal(turn.lastTurnOutputTokens, 104);
  assert.equal(turn.lastTurnOutputSource, "unkeyable_request");
  assert.equal(turn.crossCheckState, "conflict");
  assert.equal(turn.requestSumMismatchCount, 1);
  assert.equal(turn.requestSetComplete, false);
  assert.deepEqual(turn.flags, ["RECORD_CONFLICT"]);
  assert.equal(stats.requestSumMismatchCount, 1);
});

test("M6.2 keeps earlier unkeyable evidence but uses the later keyed snapshot and never claims a complete check", () => {
  const { turns } = folded(
    "home-A",
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: null,
        outputTokens: 100,
        turnOutputTokens: 100,
        timestamp: "2026-10-01T00:00:01.000Z",
      },
      "sessions/a.jsonl",
      1,
    ),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Known",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:02.000Z",
      },
      "sessions/b.jsonl",
      1,
    ),
  );
  const [turn] = turns;
  assert.equal(turn.lastTurnOutputTokens, 4);
  assert.equal(turn.lastTurnOutputSource, "keyed_request");
  assert.equal(
    turn.crossCheckState,
    "unavailable",
    "unknown request identity keeps the full set from being marked matched",
  );
  assert.equal(turn.requestSetComplete, false);
  assert.equal(turn.requestSumMismatchCount, 0);
  assert.equal(
    turn.diagnostics.unkeyableRequests[0].turnOutputTokens,
    100,
    "the earlier cumulative evidence remains inspectable",
  );
});

test("M6.2 leaves the latest missing cumulative snapshot unavailable instead of falling back", () => {
  const { turns } = folded(
    "home-A",
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "First",
        outputTokens: 4,
        turnOutputTokens: 4,
        timestamp: "2026-10-01T00:00:01.000Z",
      },
      "sessions/a.jsonl",
      1,
    ),
    projected(
      "token_usage_record",
      {
        threadId: "Thread-A",
        turnId: "Turn-A",
        responseId: "Last",
        outputTokens: 6,
        turnOutputTokens: null,
        timestamp: "2026-10-01T00:00:02.000Z",
      },
      "sessions/b.jsonl",
      1,
    ),
  );
  assert.equal(turns[0].requestOutputSum, 10);
  assert.equal(turns[0].lastTurnOutputTokens, null);
  assert.equal(turns[0].crossCheckState, "unavailable");
});

test("B1 builds a completed candidate from full request timing, without TTFT or provider inference", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m63-codex-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseMs = 1_800_000_000_000;
  const filePath = await createRollout(root, "sessions/2026/10/rollout-a.jsonl", [
    json(sessionMeta("Thread-A", { model_provider: "openai" })),
    json({
      type: "turn_context",
      payload: { thread_id: "Thread-A", turn_id: "Turn-A", model: "Model-A", effort: "high" },
    }),
    json({
      type: "token_usage_record",
      timestamp: new Date(baseMs + 2_000).toISOString(),
      payload: { thread_id: "Thread-A", turn_id: "Turn-A", response_id: "Response-A", usage: { output_tokens: 80 } },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        item: { id: "Item-A", type: "AgentMessage" },
        started_at_ms: baseMs,
        completed_at_ms: baseMs + 300,
      },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        item: { id: "Item-R", type: "Reasoning" },
        started_at_ms: baseMs + 500,
        completed_at_ms: baseMs + 700,
      },
    }),
    json({
      type: "event_msg",
      payload: { type: "task_complete", thread_id: "Thread-A", turn_id: "Turn-A", time_to_first_token_ms: 5_000 },
    }),
  ]);
  const emptyRolloutPath = await createRollout(root, "archived_sessions/empty-rollout.jsonl", []);

  const rollouts = await Promise.all([readCodexRolloutMetadata(filePath), readCodexRolloutMetadata(emptyRolloutPath)]);
  const result = foldCodexRolloutMetadata("home-A", rollouts);
  const { candidates, warnings, rolloutFiles } = buildCandidates("home-A", result, [filePath, emptyRolloutPath], {
    lookupRequestTiming: lookupDurations({ "Response-A": 500 }),
  });
  assert.equal(candidates.length, 1);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    rolloutFiles,
    [filePath, emptyRolloutPath],
    "the full file set survives even when one rollout has no rows",
  );
  const [raw] = candidates;
  assert.deepEqual(raw.identity, ["Thread-A", "Turn-A"]);
  assert.equal(raw.outputTokens, 80, "usage.output_tokens is counted once and reasoning is not added again");
  assert.equal(raw.durationMs, 500, "duration comes from the matched request, not item spans");
  assert.equal(raw.windowStartMs, null);
  assert.equal(raw.windowEndMs, null);
  assert.equal(raw.tsMs, baseMs + 2_000, "placement uses the completed turn's last deduplicated request timestamp");
  assert.equal(raw.timingSource, "explicit");
  assert.equal(raw.requestCount, 1);
  assert.equal(raw.itemCount, 2);
  assert.equal(raw.timedItemCount, 2);
  assert.equal(raw.model, "Model-A");
  assert.equal(raw.reasoningEffort, "high");
  assert.equal(raw.modelEvidence, "turn_context");
  assert.equal(raw.modelProvider, "", "session_meta provider has unknown scope and is not copied onto every turn");
  assert.equal(raw.terminalVerified, true);
  assert.equal(Object.hasOwn(raw, "time_to_first_token_ms"), false);

  const sample = normalized(raw);
  assert.equal(sample.sampleKey, '["codex","home-A","Thread-A","Turn-A"]');
  assert.equal(sample.window, "turn");
  assert.equal(sample.timingKind, "request_e2e");
  assert.equal(sample.tokenScope, "reported_output_includes_reasoning");
  assert.equal(sample.methodVersion, "tps-v2");
  assert.deepEqual(perfFlagNamesOf(sample.sampleFlags), []);
  const resultCoverage = coverage([sample]);
  assert.equal(resultCoverage.eligible, 1);
  assert.equal(resultCoverage.sampled, 0, "legacy tps-v2 request E2E is readable but is not a current v3 speed sample");
  assert.equal(resultCoverage.dropped, 1);
  assert.equal(resultCoverage.droppedByReason.historical_method, 1);
});

test("B1 keeps a JSONL-only turn visible but missing when no request timing lookup is supplied", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m64-codex-jsonl-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseMs = 1_800_000_000_000;
  const filePath = await createRollout(root, "sessions/rollout.jsonl", [
    json(sessionMeta("Thread-A")),
    json({
      type: "turn_context",
      payload: { thread_id: "Thread-A", turn_id: "Turn-A", model: "Model-A", effort: "high" },
    }),
    json({
      type: "token_usage_record",
      timestamp: new Date(baseMs + 200).toISOString(),
      payload: { thread_id: "Thread-A", turn_id: "Turn-A", response_id: "Response-A", usage: { output_tokens: 20 } },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        item: { id: "Item-A", type: "AgentMessage" },
        started_at_ms: baseMs,
        completed_at_ms: baseMs + 100,
      },
    }),
    json({ type: "event_msg", payload: { type: "task_complete", thread_id: "Thread-A", turn_id: "Turn-A" } }),
  ]);

  const projection = await readCodexRolloutMetadata(filePath);
  const foldedResult = foldCodexRolloutMetadata("home-A", [projection]);
  const built = buildCandidates("home-A", foldedResult, [filePath]);
  assert.deepEqual(built.rolloutFiles, [filePath], "the source dependency is the JSONL rollout only");
  assert.deepEqual(built.warnings, []);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].outputTokens, 20);
  assert.equal(built.candidates[0].durationMs, null);
  assert.ok(built.candidates[0].sampleFlags.includes("MISSING_DURATION"));
  assert.equal(coverage([normalized(built.candidates[0])]).sampled, 0);
});

test("B1 keeps complete multi-request long turns sampled using summed request timing", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    requestRecord("Turn-A", "Response-A", 70, baseMs + 1_000, 70),
    requestRecord("Turn-A", "Response-B", 70, baseMs + 2_000, 140),
    itemRecord("Turn-A", "Item-A", baseMs, baseMs + 150_001),
    itemRecord("Turn-A", "Item-B", baseMs + 200_000, baseMs + 350_000, "Reasoning"),
    taskCompleteRecord("Turn-A"),
  );
  const [raw] = buildCandidates("home-A", result, [], {
    lookupRequestTiming: lookupDurations({ "Response-A": 150_001, "Response-B": 150_000 }),
  }).candidates;
  assert.equal(raw.outputTokens, 140);
  assert.equal(raw.durationMs, 300_001);
  assert.equal(raw.requestCount, 2);
  assert.equal(raw.itemCount, 2);
  const sample = normalized(raw);
  assert.deepEqual(perfFlagNamesOf(sample.sampleFlags), ["LONG_WINDOW", "MULTI_REQUEST_TURN"]);
  const resultCoverage = coverage([sample]);
  assert.equal(resultCoverage.sampled, 0, "legacy tps-v2 request E2E remains historical despite complete timing");
  assert.equal(resultCoverage.dropped, 1);
  assert.equal(resultCoverage.droppedByReason.historical_method, 1);
});

test("B1 ignores incomplete item spans when every request has complete timing", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    requestRecord("Turn-A", "Response-A", 20, baseMs + 1_000),
    itemRecord("Turn-A", "Timed", baseMs, baseMs + 200),
    itemRecord("Turn-A", "Untimed", null, baseMs + 500, "Reasoning"),
    taskCompleteRecord("Turn-A"),
  );
  const [raw] = buildCandidates("home-A", result, [], {
    lookupRequestTiming: lookupDurations({ "Response-A": 200 }),
  }).candidates;
  assert.equal(raw.durationMs, 200);
  assert.equal(raw.windowStartMs, null);
  assert.equal(raw.windowEndMs, null);
  assert.equal(raw.itemCount, 2);
  assert.equal(raw.timedItemCount, 1);
  const sample = normalized(raw);
  assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("PARTIAL_ITEM_SPAN"), false);
  const resultCoverage = coverage([sample]);
  assert.equal(resultCoverage.completeTimedPositiveOutput, 1);
  assert.equal(resultCoverage.sampled, 0, "legacy tps-v2 request E2E remains outside current v3 speed stats");
  assert.equal(resultCoverage.droppedByReason.partial_item_span, 0);
});

test("B1 ignores unkeyable target items when request timing is complete without inventing items", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m63-codex-unkeyable-item-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseMs = 1_800_000_000_000;
  const makeTurn = (turnId, responseId, offsetMs, items) => [
    json({
      type: "turn_context",
      payload: { thread_id: "Thread-A", turn_id: turnId, model: "Model-A", effort: "high" },
    }),
    json({
      type: "token_usage_record",
      timestamp: new Date(baseMs + offsetMs + 2_000).toISOString(),
      payload: { thread_id: "Thread-A", turn_id: turnId, response_id: responseId, usage: { output_tokens: 20 } },
    }),
    ...items.map(({ id, type, startMs, endMs }) =>
      json({
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: "Thread-A",
          turn_id: turnId,
          item: { ...(id === null ? {} : { id }), type },
          started_at_ms: startMs,
          completed_at_ms: endMs,
        },
      }),
    ),
    json({ type: "event_msg", payload: { type: "task_complete", thread_id: "Thread-A", turn_id: turnId } }),
  ];
  const fixture = await createRollout(root, "sessions/rollout.jsonl", [
    json(sessionMeta("Thread-A")),
    ...makeTurn("Turn-Different", "Response-Different", 0, [
      { id: "Known-Different", type: "AgentMessage", startMs: baseMs, endMs: baseMs + 100 },
      { id: null, type: "Reasoning", startMs: baseMs + 200, endMs: baseMs + 500 },
    ]),
    ...makeTurn("Turn-Replay", "Response-Replay", 10_000, [
      { id: "Known-Replay", type: "AgentMessage", startMs: baseMs + 10_000, endMs: baseMs + 10_100 },
      { id: null, type: "Reasoning", startMs: baseMs + 10_000, endMs: baseMs + 10_100 },
    ]),
    ...makeTurn("Turn-Unkeyable-Only", "Response-Unkeyable-Only", 20_000, [
      { id: null, type: "Reasoning", startMs: baseMs + 20_000, endMs: baseMs + 20_100 },
    ]),
    ...makeTurn("Turn-Normal", "Response-Normal", 30_000, [
      { id: "Known-Normal", type: "AgentMessage", startMs: baseMs + 30_000, endMs: baseMs + 30_100 },
    ]),
  ]);

  const foldedResult = foldCodexRolloutMetadata("home-A", [await readCodexRolloutMetadata(fixture)]);
  const built = buildCandidates("home-A", foldedResult, [fixture], {
    lookupRequestTiming: lookupDurations({
      "Response-Different": 100,
      "Response-Replay": 100,
      "Response-Unkeyable-Only": 100,
      "Response-Normal": 100,
    }),
  });
  const samples = built.candidates.map(normalized);
  const byTurn = new Map(
    built.candidates.map((candidate, index) => [candidate.turnId, { candidate, sample: samples[index] }]),
  );

  assert.equal(built.candidates.length, 4);
  assert.equal(foldedResult.stats.unkeyableItemRecords, 3);
  assert.deepEqual(built.warnings, [{ sourceKind: "codex", homeId: "home-A", code: "UNKEYABLE_RECORD", count: 3 }]);
  for (const turnId of ["Turn-Different", "Turn-Replay"]) {
    const { candidate, sample } = byTurn.get(turnId);
    assert.equal(candidate.itemCount, 1, "the missing-ID item never becomes a synthetic count");
    assert.equal(candidate.timedItemCount, 1);
    assert.equal(candidate.durationMs, 100, "complete request timing does not depend on the item ledger");
    assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("PARTIAL_ITEM_SPAN"), false);
    assert.equal(coverage([sample]).sampled, 0, "legacy tps-v2 request E2E remains outside current v3 speed stats");
    assert.equal(coverage([sample]).completeTimedPositiveOutput, 1);
  }

  const unkeyableOnly = byTurn.get("Turn-Unkeyable-Only");
  assert.equal(unkeyableOnly.candidate.itemCount, 0);
  assert.equal(unkeyableOnly.candidate.timedItemCount, 0);
  assert.equal(unkeyableOnly.candidate.durationMs, 100);
  assert.equal(perfFlagNamesOf(unkeyableOnly.sample.sampleFlags).includes("MISSING_DURATION"), false);
  assert.equal(perfFlagNamesOf(unkeyableOnly.sample.sampleFlags).includes("PARTIAL_ITEM_SPAN"), false);

  const normal = byTurn.get("Turn-Normal");
  assert.equal(normal.candidate.itemCount, 1);
  assert.equal(normal.candidate.durationMs, 100);
  assert.equal(perfFlagNamesOf(normal.sample.sampleFlags).includes("PARTIAL_ITEM_SPAN"), false);
  assert.equal(coverage(samples).sampled, 0, "legacy tps-v2 request E2E remains outside current v3 speed stats");
  assert.equal(coverage(samples).droppedByReason.partial_item_span, 0);
  assert.equal(coverage(samples).droppedByReason.duration_missing_nonpositive_invalid, 0);
});

test("B1 ignores overlapping item windows when request timing is complete", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    requestRecord("Turn-A", "Response-A", 20, baseMs + 1_000),
    itemRecord("Turn-A", "Item-A", baseMs, baseMs + 300),
    itemRecord("Turn-A", "Item-B", baseMs + 200, baseMs + 400, "Reasoning"),
    taskCompleteRecord("Turn-A"),
  );
  const [raw] = buildCandidates("home-A", result, [], {
    lookupRequestTiming: lookupDurations({ "Response-A": 500 }),
  }).candidates;
  assert.equal(raw.durationMs, 500, "duration comes from the request timing");
  assert.equal(raw.windowStartMs, null);
  assert.equal(raw.windowEndMs, null);
  const sample = normalized(raw);
  assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("OVERLAPPING_ITEM_SPAN"), false);
  assert.equal(coverage([sample]).droppedByReason.overlapping_item_span, 0);
});

test("M6.3 emits a positive-output candidate without items as missing duration", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    requestRecord("Turn-A", "Response-A", 9, baseMs + 1_000),
    taskCompleteRecord("Turn-A"),
  );
  const [raw] = buildCandidates("home-A", result).candidates;
  assert.equal(raw.outputTokens, 9);
  assert.equal(raw.durationMs, null);
  assert.equal(raw.itemCount, 0);
  assert.equal(raw.timedItemCount, 0);
  const sample = normalized(raw);
  assert.ok(perfFlagNamesOf(sample.sampleFlags).includes("MISSING_DURATION"));
  assert.equal(coverage([sample]).droppedByReason.duration_missing_nonpositive_invalid, 1);
});

test("B1 sums complete request timing for one turn regardless of request order or tool-only items", () => {
  const baseMs = 1_800_000_000_000;
  const requests = [
    requestRecord("Turn-A", "Response-A", 100, baseMs + 1_000, 100),
    requestRecord("Turn-A", "Response-B", 900, baseMs + 9_000, 1_000),
  ];
  const build = (records) => {
    const result = folded(
      "home-A",
      ...records,
      projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
      itemRecord("Turn-A", "Text-A", baseMs, baseMs + 10_000),
      itemRecord("Turn-A", "Tool-B", baseMs, baseMs + 9_000, "CommandExecution"),
      taskCompleteRecord("Turn-A"),
    );
    return buildCandidates("home-A", result, [], {
      lookupRequestTiming: lookupDurations({ "Response-A": 1_000, "Response-B": 9_000 }),
    }).candidates[0];
  };

  for (const records of [requests, [...requests].reverse()]) {
    const raw = build(records);
    assert.deepEqual(raw.identity, ["Thread-A", "Turn-A"]);
    assert.equal(raw.outputTokens, 1_000);
    assert.equal(raw.requestCount, 2);
    assert.equal(raw.itemCount, 1, "tool-only items remain outside the target item count");
    assert.equal(raw.durationMs, 10_000);
    assert.equal(raw.timingSource, "explicit");
    assert.equal(raw.windowStartMs, null);
    assert.equal(raw.windowEndMs, null);
    assert.equal(normalized(raw).sampleKey, '["codex","home-A","Thread-A","Turn-A"]');
  }
});

test("B1 treats a turn without lookup timing as missing even when its item spans are complete", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    requestRecord("Turn-A", "Response-A", 100, baseMs + 1_000),
    itemRecord("Turn-A", "Item-A", baseMs, baseMs + 1_000),
    taskCompleteRecord("Turn-A"),
  );
  const [raw] = buildCandidates("home-A", result).candidates;
  const sample = normalized(raw);
  assert.equal(raw.durationMs, null);
  assert.ok(perfFlagNamesOf(sample.sampleFlags).includes("MISSING_DURATION"));
  assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("PARTIAL_ITEM_SPAN"), false);
  assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("OVERLAPPING_ITEM_SPAN"), false);
});

test("B1 maps output and model mismatches to RECORD_CONFLICT", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    requestRecord("Turn-A", "Response-A", 20, baseMs + 1_000),
    taskCompleteRecord("Turn-A"),
  );
  for (const lookupRequestTiming of [
    ({ model, outputTokens }) => ({
      state: "available",
      durationMs: 200,
      reportedOutputTokens: outputTokens + 1,
      requestedModel: model,
    }),
    ({ outputTokens }) => ({
      state: "available",
      durationMs: 200,
      reportedOutputTokens: outputTokens,
      requestedModel: "Other-Model",
    }),
  ]) {
    const [raw] = buildCandidates("home-A", result, [], { lookupRequestTiming }).candidates;
    assert.equal(raw.durationMs, null);
    assert.ok(raw.sampleFlags.includes("RECORD_CONFLICT"));
  }
});

test("B1 maps non-positive and non-integer request durations to TIME_INVALID", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    requestRecord("Turn-A", "Response-A", 20, baseMs + 1_000),
    taskCompleteRecord("Turn-A"),
  );
  for (const durationMs of [0, -1, 1.5]) {
    const [raw] = buildCandidates("home-A", result, [], {
      lookupRequestTiming: lookupDurations({ "Response-A": durationMs }),
    }).candidates;
    assert.equal(raw.durationMs, null);
    assert.ok(raw.sampleFlags.includes("TIME_INVALID"));
  }
});

test("B1 propagates request timing lookup failures unchanged", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    requestRecord("Turn-A", "Response-A", 20, baseMs + 1_000),
    taskCompleteRecord("Turn-A"),
  );
  const failure = new Error("timing store unavailable");
  assert.throws(
    () =>
      buildCandidates("home-A", result, [], {
        lookupRequestTiming: () => {
          throw failure;
        },
      }),
    (error) => error === failure,
  );
});

test("M6.3 does not infer completed, in-progress, failed, or cancelled from task_started/turn_aborted", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m63-codex-no-terminal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseMs = 1_800_000_000_000;
  const filePath = await createRollout(root, "sessions/ongoing.jsonl", [
    json(sessionMeta("Thread-A")),
    json({
      type: "turn_context",
      payload: { thread_id: "Thread-A", turn_id: "Turn-A", model: "Model-A", effort: "high" },
    }),
    json({
      type: "token_usage_record",
      timestamp: new Date(baseMs + 1_000).toISOString(),
      payload: { thread_id: "Thread-A", turn_id: "Turn-A", response_id: "Response-A", usage: { output_tokens: 9 } },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Thread-A",
        turn_id: "Turn-A",
        item: { id: "Item-A", type: "AgentMessage" },
        started_at_ms: baseMs,
        completed_at_ms: baseMs + 100,
      },
    }),
    json({ type: "event_msg", payload: { type: "task_started", thread_id: "Thread-A", turn_id: "Turn-A" } }),
    json({
      type: "event_msg",
      payload: { type: "turn_aborted", thread_id: "Thread-A", turn_id: "Turn-A", reason: "cancelled" },
    }),
  ]);
  const result = foldCodexRolloutMetadata("home-A", [await readCodexRolloutMetadata(filePath)]);
  const built = buildCandidates("home-A", result, [], {
    lookupRequestTiming: lookupDurations({ "Response-A": 100 }),
  });
  assert.equal(built.candidates.length, 1);
  const raw = built.candidates[0];
  assert.equal(raw.terminalVerified, false);
  assert.equal(raw.tsMs, null, "an unended turn is unplaced even when a request timestamp exists");
  assert.equal(
    raw.durationMs,
    100,
    "request timing and output can be complete while terminal evidence is still missing",
  );
  const sample = normalized(raw);
  assert.equal(sample.status, "unverified");
  assert.ok(perfFlagNamesOf(sample.sampleFlags).includes("TERMINAL_UNVERIFIED"));
  assert.ok(perfFlagNamesOf(sample.sampleFlags).includes("TIME_UNPLACED"));
  assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("MISSING_DURATION"), false);
  assert.equal(perfFlagNamesOf(sample.sampleFlags).includes("SOURCE_FILTERED"), false);
  assert.equal(coverage([sample]).unplaced, 1);
});

test("M6.3 preserves incomplete request-set candidates but never uses their partial output sum", () => {
  const baseMs = 1_800_000_000_000;
  const result = folded(
    "home-A",
    requestRecord("Turn-A", "Known", 4, baseMs + 1_000, 4),
    requestRecord("Turn-A", null, 100, baseMs + 2_000, 104),
    itemRecord("Turn-A", "Item-A", baseMs, baseMs + 100),
    taskCompleteRecord("Turn-A"),
  );
  assert.equal(result.turns[0].requestOutputSum, 4);
  assert.equal(result.turns[0].requestSetComplete, false);
  const built = buildCandidates("home-A", result);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].outputTokens, null);
  assert.equal(
    built.candidates[0].tsMs,
    null,
    "an incomplete identity set cannot establish the final request timestamp",
  );
  assert.deepEqual(built.warnings, [{ sourceKind: "codex", homeId: "home-A", code: "UNKEYABLE_RECORD", count: 1 }]);
  const sample = normalized(built.candidates[0]);
  const names = perfFlagNamesOf(sample.sampleFlags);
  assert.ok(names.includes("MISSING_OUTPUT"));
  assert.ok(names.includes("RECORD_CONFLICT"));
  assert.equal(names.includes("UNKEYABLE_RECORD"), false, "source warnings do not enter the sample flag bitset");
});

test("B1 creates no candidates from context alone and retains zero-output stable turns", () => {
  const contextOnly = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Context-Only", model: "Model-A", effort: "low" }),
  );
  assert.deepEqual(buildCandidates("home-A", contextOnly).candidates, []);

  const baseMs = 1_800_000_000_000;
  const zeroOutput = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-Zero", model: "Model-A", effort: "low" }),
    requestRecord("Turn-Zero", "Response-Zero", 0, baseMs + 1_000),
    itemRecord("Turn-Zero", "Item-Zero", baseMs, baseMs + 100),
    taskCompleteRecord("Turn-Zero"),
  );
  const [raw] = buildCandidates("home-A", zeroOutput, [], {
    lookupRequestTiming: lookupDurations({ "Response-Zero": 100 }),
  }).candidates;
  const sample = normalized(raw);
  assert.equal(sample.outputTokens, 0);
  assert.ok(perfFlagNamesOf(sample.sampleFlags).includes("OUTPUT_ZERO"));
  assert.equal(coverage([sample]).droppedByReason.output_missing_zero_invalid, 1);

  const ownershipConflict = folded(
    "home-A",
    requestRecord("Turn-One", "Shared-Response", 5, baseMs + 1_000),
    requestRecord("Turn-Two", "Shared-Response", 5, baseMs + 1_000),
  );
  const conflictCandidates = buildCandidates("home-A", ownershipConflict).candidates;
  assert.equal(conflictCandidates.length, 2, "ownership-conflict turns remain visible for coverage diagnostics");
  assert.ok(conflictCandidates.every((candidate) => candidate.outputTokens === null && candidate.requestCount === 0));
  assert.ok(conflictCandidates.every((candidate) => candidate.sampleFlags.includes("RECORD_CONFLICT")));

  const typeConflict = folded(
    "home-A",
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-Type", model: "Model-A", effort: "low" }),
    requestRecord("Turn-Type", "Response-Type", 8, baseMs + 1_000),
    itemRecord("Turn-Type", "Shared-Item", baseMs, baseMs + 100, "AgentMessage"),
    itemRecord("Turn-Type", "Shared-Item", baseMs, baseMs + 100, "Reasoning"),
    taskCompleteRecord("Turn-Type"),
  );
  const [conflictedItem] = buildCandidates("home-A", typeConflict, [], {
    lookupRequestTiming: lookupDurations({ "Response-Type": 100 }),
  }).candidates;
  assert.equal(conflictedItem.itemCount, 1, "a type conflict between two allowed target types remains a unique item");
  assert.equal(conflictedItem.timedItemCount, 1);
  assert.equal(conflictedItem.durationMs, 100);
  assert.ok(conflictedItem.sampleFlags.includes("RECORD_CONFLICT"));
});

// ---------------------------------------------------------------------------
// M8.2 Block A: §2 field ruling and §3 registered-structure acceptance.
// These run the real reader / strict reader, not a copied classifier.
// ---------------------------------------------------------------------------

test("M8.2 §2 field ruling: current thread id is canonical; id and session_id need not match", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-field-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cases = [
    { name: "both present and equal", header: sessionMeta("T"), thread: "T", ambiguous: 0 },
    {
      name: "both present and different (sub-thread of a root session)",
      header: sessionMeta("T", { session_id: "ROOT" }),
      thread: "T",
      ambiguous: 0,
    },
    {
      name: "only id (legacy header)",
      header: { type: "session_meta", payload: { id: "T", source: "cli" } },
      thread: "T",
      ambiguous: 0,
    },
    {
      name: "only session_id (root thread must not stand in)",
      header: { type: "session_meta", payload: { session_id: "ROOT", source: "cli" } },
      thread: null,
      ambiguous: 0,
    },
    { name: "both missing", header: { type: "session_meta", payload: { source: "cli" } }, thread: null, ambiguous: 0 },
  ];

  for (const [index, item] of cases.entries()) {
    const file = await createRollout(root, `sessions/field-${index}.jsonl`, [json(item.header)]);
    const projection = await readCodexRolloutMetadata(file);
    assert.equal(projection.records[0].threadId, item.thread, item.name);
    assert.equal(projection.records[0].threadEvidenceConflict, false, `${item.name}: inequality is not a conflict`);
    assert.equal(projection.stats.ambiguousSessionMetaThreadId, item.ambiguous, item.name);
  }

  // Multiple headers: same id stays one current thread even if session_id differs.
  const sameId = await createRollout(root, "sessions/same-id.jsonl", [
    json(sessionMeta("T", { session_id: "ROOT-A" })),
    json(sessionMeta("T", { session_id: "ROOT-B" })),
  ]);
  const sameIdProjection = await readCodexRolloutMetadata(sameId);
  assert.equal(sameIdProjection.stats.ambiguousSessionMetaThreadId, 0, "same id twice is still one current thread");
  assert.equal((await readCodexRollout(sameId)).threadId, "T");

  // Multiple headers with different ids is a real conflict.
  const multiId = await createRollout(root, "sessions/multi-id.jsonl", [
    json(sessionMeta("T1")),
    json(sessionMeta("T2")),
  ]);
  await assert.rejects(readCodexRollout(multiId), (error) => error.code === "UNKEYABLE_RECORD");
});

test("M8.2 §2: two sub-threads sharing one root session_id stay two thread ledgers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-root-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await createRollout(root, "sessions/sub-a.jsonl", [
    json(sessionMeta("Sub-A", { session_id: "ROOT" })),
    json({ type: "turn_context", payload: { thread_id: "Sub-A", turn_id: "Turn-1", model: "Model-A" } }),
  ]);
  const second = await createRollout(root, "sessions/sub-b.jsonl", [
    json(sessionMeta("Sub-B", { session_id: "ROOT" })),
    json({ type: "turn_context", payload: { thread_id: "Sub-B", turn_id: "Turn-1", model: "Model-A" } }),
  ]);

  assert.equal((await readCodexRollout(first)).threadId, "Sub-A");
  assert.equal((await readCodexRollout(second)).threadId, "Sub-B");
});

test("M8.2 §2: a header id contradicting a record's explicit thread_id is still rejected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-explicit-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const file = await createRollout(root, "sessions/contradiction.jsonl", [
    json(sessionMeta("Header-Id")),
    json({ type: "turn_context", payload: { thread_id: "Other-Id", turn_id: "Turn-1", model: "Model-A" } }),
  ]);
  await assert.rejects(readCodexRollout(file), (error) => error.code === "UNKEYABLE_RECORD");
});

test("M8.2 §2: a header without a current-thread id is rejected by the strict reader", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-missing-id-header-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A complete, otherwise-valid target turn that carries a consistent explicit
  // thread_id on every record. This is the shape that previously slipped
  // through: `recordsWithoutThreadId` stayed 0 and the trailing threadIds set
  // collapsed to the target thread, so the file was accepted even though its
  // header had no current-thread id.
  const completeTurn = (threadId) => [
    json({ type: "turn_context", payload: { thread_id: threadId, turn_id: "Turn-1", model: "Model-A" } }),
    json({
      type: "token_usage_record",
      payload: { thread_id: threadId, turn_id: "Turn-1", response_id: "R1", usage: { output_tokens: 40 } },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: "Turn-1",
        item: { id: "I1", type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: "Turn-1",
        item: { id: "I2", type: "Reasoning" },
        started_at_ms: 1100,
        completed_at_ms: 1200,
      },
    }),
    json({
      type: "event_msg",
      payload: { type: "task_complete", thread_id: threadId, turn_id: "Turn-1", duration_ms: 400 },
    }),
  ];

  const badHeaders = [
    {
      name: "session_id-only header",
      lines: [{ type: "session_meta", payload: { session_id: "ROOT", source: "cli" } }],
    },
    { name: "empty payload header", lines: [{ type: "session_meta", payload: {} }] },
    {
      name: "valid id header plus an extra session_id-only header",
      lines: [sessionMeta("T"), { type: "session_meta", payload: { session_id: "ROOT", source: "cli" } }],
    },
  ];

  for (const [index, item] of badHeaders.entries()) {
    const file = await createRollout(root, `sessions/missing-id-${index}.jsonl`, [
      ...item.lines.map(json),
      ...completeTurn("T"),
    ]);

    const projection = await readCodexRolloutMetadata(file);
    assert.equal(projection.stats.sessionMetaWithoutThreadId, 1, `${item.name}: metadata records the missing id`);
    assert.equal(projection.stats.recordsWithoutThreadId, 0, `${item.name}: every record has an explicit id`);
    assert.equal(projection.stats.ambiguousSessionMetaThreadId, 0, `${item.name}: at most one header id`);

    await assert.rejects(
      readCodexRollout(file),
      (error) => error.code === "UNKEYABLE_RECORD",
      `${item.name}: the strict reader must reject a header without a current-thread id`,
    );
  }

  // Positive controls must keep working.
  const legalSubThread = await createRollout(root, "sessions/legal-sub-thread.jsonl", [
    json(sessionMeta("T", { session_id: "ROOT" })),
    ...completeTurn("T"),
  ]);
  assert.equal((await readCodexRollout(legalSubThread)).threadId, "T");

  const sameIdHeaders = await createRollout(root, "sessions/same-id-headers.jsonl", [
    json(sessionMeta("T", { session_id: "ROOT-A" })),
    json(sessionMeta("T", { session_id: "ROOT-B" })),
    ...completeTurn("T"),
  ]);
  assert.equal((await readCodexRollout(sameIdHeaders)).threadId, "T");
});

test("M8.2 C: the four observed paginated child shapes prove one child owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-child-shapes-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const makeRows = ({ boundary, lastOrdinal, firstOrdinal = 0, currentHistoryBase, recordsByOrdinal = new Map() }) => {
    const childPayload = {
      session_id: "Parent",
      parent_thread_id: "Parent",
      forked_from_id: "Parent",
      source: { subagent: { thread_spawn: { id: "Agent" } } },
      history_mode: "paginated",
      subagent_history_start_ordinal: boundary,
    };
    if (currentHistoryBase !== undefined) childPayload.history_base = currentHistoryBase;
    const childHeader = sessionMeta("Child", childPayload);
    const parentHeader = sessionMeta("Parent", {
      source: "cli",
      history_mode: "paginated",
      forked_from_id: "Ancestor-rollout",
      forked_from_ordinal_exclusive: 5000,
      history_base: { thread_id: "Ancestor-rollout", end_ordinal_exclusive: 5000, end_byte_offset: 65536 },
    });
    const rows = [
      { ...childHeader, ordinal: firstOrdinal },
      { ...parentHeader, ordinal: firstOrdinal + 1 },
    ];
    for (let ordinal = firstOrdinal + 2; ordinal <= lastOrdinal; ordinal += 1) {
      rows.push({ ...(recordsByOrdinal.get(ordinal) ?? { type: "response_item", payload: {} }), ordinal });
    }
    return rows;
  };

  const observed = [
    { name: "F1", boundary: 59, rowCount: 139, parentCheckpoint: 3939 },
    { name: "F2", boundary: 60, rowCount: 146, parentCheckpoint: 3939 },
    { name: "F3", boundary: 61, rowCount: 119, parentCheckpoint: 3939 },
    { name: "F4", boundary: 20, rowCount: 1431, parentCheckpoint: 9927 },
  ];

  for (const item of observed) {
    const rows = makeRows({
      boundary: item.boundary,
      lastOrdinal: item.rowCount - 1,
      recordsByOrdinal: new Map([
        [
          item.boundary,
          { type: "turn_context", payload: { thread_id: "Child", turn_id: "Child-turn", model: "Child-model" } },
        ],
      ]),
    });
    rows[1].payload.forked_from_ordinal_exclusive = item.parentCheckpoint;
    rows[1].payload.history_base.end_ordinal_exclusive = item.parentCheckpoint;
    const file = await createRollout(root, `sessions/${item.name}.jsonl`, rows.map(json));

    const strict = await readCodexRollout(file);
    assert.equal(strict.threadId, "Child", item.name);
    assert.equal(strict.projection.ownershipProof.kind, "paginated-child", item.name);
    assert.equal(strict.projection.ownershipProof.boundaryOrdinal, item.boundary, item.name);
    assert.equal(strict.projection.ordinalSequence.rowCount, item.rowCount, item.name);
    assert.equal(strict.projection.ordinalSequence.firstOrdinal, 0, "child's missing current base means ordinal zero");
    assert.equal(strict.projection.ordinalSequence.lastOrdinal, item.rowCount - 1, item.name);
    assert.deepEqual(
      strict.projection.records.map((record) => record.ordinal),
      [0, item.boundary],
      "the copied parent header and all inherited rows are removed before the builder",
    );
    assert.equal(strict.projection.stats.ambiguousSessionMetaThreadId, 1, "the original header stat remains intact");

    const plan = await planCodexHomeThreads(`home-${item.name}`, [file]);
    assert.equal(plan.ok, true, item.name);
    assert.deepEqual(
      plan.threads.map((thread) => thread.threadId),
      ["Child"],
      "the physical file has one child owner",
    );
    const built = buildCodexThreadPerfSamples(`home-${item.name}`, plan.threads[0].threadId, plan.threads[0].rollouts);
    assert.deepEqual(built.rolloutFiles, [file], "the dependency remains the complete physical file");
  }

  const nonzeroBase = makeRows({
    boundary: 42,
    firstOrdinal: 40,
    lastOrdinal: 42,
    currentHistoryBase: { thread_id: "Child-current-rollout", end_ordinal_exclusive: 40, end_byte_offset: 2048 },
    recordsByOrdinal: new Map([
      [42, { type: "turn_context", payload: { thread_id: "Child", turn_id: "Child-turn", model: "Child-model" } }],
    ]),
  });
  const nonzeroFile = await createRollout(root, "sessions/nonzero-current-base.jsonl", nonzeroBase.map(json));
  const nonzeroRead = await readCodexRollout(nonzeroFile);
  assert.equal(nonzeroRead.projection.ordinalSequence.firstOrdinal, 40);
  assert.equal(nonzeroRead.projection.ownershipProof.boundaryOrdinal, 42);
});

test("T2 forwards exact request generation through the thread builder", () => {
  const placedAt = Date.parse("2026-10-01T00:00:03.000Z");
  const records = [
    projected("turn_context", { threadId: "Thread-A", turnId: "Turn-A", model: "Model-A", effort: "high" }),
    projected("token_usage_record", {
      threadId: "Thread-A",
      turnId: "Turn-A",
      responseId: "Response-A",
      outputTokens: 40,
      turnOutputTokens: 40,
      timestamp: new Date(placedAt).toISOString(),
    }),
    projected("task_complete", {
      threadId: "Thread-A",
      turnId: "Turn-A",
      startedAtSec: 1_800_000_000,
      completedAtSec: 1_800_000_001,
      durationMs: 1_000,
    }),
  ];
  let lookupQuery;
  const built = buildCodexThreadPerfSamples(
    "home-A",
    "Thread-A",
    [{ filePath: "sessions/a.jsonl", threadId: "Thread-A", projection: { records } }],
    {
      lookupRequestTiming: (query) => {
        lookupQuery = query;
        return {
          state: "available",
          durationMs: 400,
          reportedOutputTokens: 40,
          requestedModel: "Model-A",
          generation: generationTiming(40, 200, 1),
        };
      },
    },
  );

  assert.deepEqual(lookupQuery, {
    homeId: "home-A",
    threadId: "Thread-A",
    turnId: "Turn-A",
    responseId: "Response-A",
    model: "Model-A",
    outputTokens: 40,
    reasoningOutputTokens: null,
  });
  assert.equal(built.samples.length, 1);
  const [sample] = built.samples;
  assert.equal(sample.sampleKey, '["codex","home-A","Thread-A","Turn-A","Response-A"]');
  assert.equal(sample.tsMs, placedAt);
  assert.equal(sample.durationMs, 200);
  assert.equal(sample.outputTokens, 39);
  assert.equal(sample.requestCount, 1);
  assert.equal(sample.timingSource, "explicit");
  assert.equal(sample.methodVersion, "tps-v5");
});

test("T2 full chain builds one v3 generation sample per fixture response", async () => {
  const fixture = JSON.parse(await readFile(SIX_TURN_FIXTURE_URL, "utf8"));
  const projection = sixTurnProjection(fixture);
  const built = buildCodexThreadPerfSamples(projection.homeId, projection.threadId, projection.rollouts, {
    lookupRequestTiming: projection.lookupRequestTiming,
  });
  const fixtureRequests = fixture.turns.flatMap((fixtureTurn) =>
    fixtureTurn.requests.map((fixtureRequest) => ({
      ...fixtureRequest,
      turnId: fixtureTurn.id,
      endedAtMs: Date.parse(fixtureTurn.endedAt),
    })),
  );

  assert.deepEqual(built.warnings, []);
  assert.deepEqual(
    built.samples.map((sample) => sample.sampleKey),
    fixtureRequests.map((fixtureRequest) =>
      JSON.stringify(["codex", projection.homeId, projection.threadId, fixtureRequest.turnId, fixtureRequest.id]),
    ),
  );
  assert.deepEqual(
    built.samples.map((sample) => sample.tsMs),
    fixtureRequests.map((fixtureRequest) => fixtureRequest.endedAtMs),
  );
  assert.deepEqual(
    built.samples.map((sample) => sample.durationMs),
    fixtureRequests.map(sixTurnGenerationDuration),
  );
  assert.ok(built.samples.every((sample) => sample.requestCount === 1));
  assert.deepEqual(
    built.samples.map((sample) => sample.outputTokens),
    fixtureRequests.map((fixtureRequest) => fixtureRequest.outputTokens - 1),
  );
  assert.ok(
    built.samples.every(
      (sample) =>
        sample.windowStartMs === null &&
        sample.windowEndMs === null &&
        sample.window === "request" &&
        sample.timingKind === "generation" &&
        sample.tokenScope === "non_reasoning_output" &&
        sample.methodVersion === "tps-v5" &&
        sample.timingSource === "explicit" &&
        !perfFlagNamesOf(sample.sampleFlags).includes("MISSING_DURATION") &&
        !perfFlagNamesOf(sample.sampleFlags).includes("METHOD_ESTIMATE"),
    ),
  );

  assert.equal(
    built.samples.reduce((sum, sample) => sum + sample.requestCount, 0),
    fixtureRequests.length,
  );
  const expectedDurationMs = fixtureRequests.reduce((sum, request) => sum + sixTurnGenerationDuration(request), 0);
  const expectedOutputTokens = fixtureRequests.reduce((sum, request) => sum + request.outputTokens - 1, 0);
  assert.equal(
    built.samples.reduce((sum, sample) => sum + sample.durationMs, 0),
    expectedDurationMs,
  );
  assert.equal(
    built.samples.reduce((sum, sample) => sum + sample.outputTokens, 0),
    expectedOutputTokens,
  );

  const summary = summarizePerf(built.samples, { meta: { minSamples: 1 } });
  assert.equal(summary.coverage.sampled, fixtureRequests.length);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].n, fixtureRequests.length);
  assert.equal(summary.groups[0].sums.durationMs, expectedDurationMs);
  assert.equal(summary.groups[0].sums.outputTokens, expectedOutputTokens);
  assert.equal(summary.groups[0].tps.pooled, (expectedOutputTokens * 1_000) / expectedDurationMs);
  assert.equal(summary.groups[0].rank, 1);
  assert.equal(summary.models[0].rank, 1);
});

test("T2 full chain keeps only the response with missing generation unsampled", async () => {
  const fixture = JSON.parse(await readFile(SIX_TURN_FIXTURE_URL, "utf8"));
  const affectedTurn = fixture.turns[3];
  const missingResponseId = affectedTurn.requests[0].id;
  const projection = sixTurnProjection(fixture, { missingResponseId });
  const built = buildCodexThreadPerfSamples(projection.homeId, projection.threadId, projection.rollouts, {
    lookupRequestTiming: projection.lookupRequestTiming,
  });
  const fixtureRequests = fixture.turns.flatMap((fixtureTurn) =>
    fixtureTurn.requests.map((fixtureRequest) => ({
      ...fixtureRequest,
      turnId: fixtureTurn.id,
    })),
  );

  assert.equal(built.samples.length, fixtureRequests.length);
  const affectedKey = JSON.stringify([
    "codex",
    projection.homeId,
    projection.threadId,
    affectedTurn.id,
    missingResponseId,
  ]);
  const affected = built.samples.find((sample) => sample.sampleKey === affectedKey);
  assert.ok(affected);
  assert.equal(affected.durationMs, null);
  assert.equal(affected.outputTokens, null);
  assert.ok(perfFlagNamesOf(affected.sampleFlags).includes("MISSING_DURATION"));
  assert.equal(affected.requestCount, 1);
  assert.equal(affected.model, fixture.requestedModel);
  assert.equal(affected.itemCount, 0);
  assert.equal(affected.timedItemCount, 0);
  assert.equal(affected.windowStartMs, null);
  assert.equal(affected.windowEndMs, null);
  assert.equal(perfFlagNamesOf(affected.sampleFlags).includes("PARTIAL_ITEM_SPAN"), false);
  assert.equal(perfFlagNamesOf(affected.sampleFlags).includes("OVERLAPPING_ITEM_SPAN"), false);

  const complete = built.samples.filter((sample) => sample.sampleKey !== affectedKey);
  assert.equal(complete.length, fixtureRequests.length - 1);
  const completeRequests = fixtureRequests.filter((request) => request.id !== missingResponseId);
  assert.deepEqual(
    complete.map((sample) => sample.durationMs),
    completeRequests.map(sixTurnGenerationDuration),
  );
  assert.ok(
    complete.every(
      (sample) =>
        !perfFlagNamesOf(sample.sampleFlags).includes("MISSING_DURATION") &&
        sample.windowStartMs === null &&
        sample.windowEndMs === null,
    ),
  );
  const summary = summarizePerf(built.samples, { meta: { minSamples: 1 } });
  const missingRequest = affectedTurn.requests[0];
  const expectedDurationMs =
    fixtureRequests.reduce((sum, request) => sum + sixTurnGenerationDuration(request), 0) -
    sixTurnGenerationDuration(missingRequest);
  const expectedOutputTokens =
    fixtureRequests.reduce((sum, request) => sum + request.outputTokens - 1, 0) - (missingRequest.outputTokens - 1);
  assert.equal(summary.coverage.sampled, fixtureRequests.length - 1);
  assert.equal(summary.groups[0].n, fixtureRequests.length - 1);
  assert.equal(summary.groups[0].sums.durationMs, expectedDurationMs);
  assert.equal(summary.groups[0].tps.pooled, (expectedOutputTokens * 1_000) / expectedDurationMs);
});

test("M8.2 C: proven child segmentation preserves stats and excludes parent request/item/terminal evidence before fold", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-child-prefix-fold-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boundary = 7;
  const rows = [
    {
      ...sessionMeta("Child", {
        session_id: "Parent",
        parent_thread_id: "Parent",
        forked_from_id: "Parent",
        source: { subagent: { thread_spawn: { id: "Agent" } } },
        history_mode: "paginated",
        subagent_history_start_ordinal: boundary,
      }),
      ordinal: 0,
    },
    {
      ...sessionMeta("Parent", {
        source: "cli",
        history_mode: "paginated",
        history_base: { thread_id: "Ancestor", end_ordinal_exclusive: 5000, end_byte_offset: 65536 },
        forked_from_id: "Ancestor",
        forked_from_ordinal_exclusive: 5000,
      }),
      ordinal: 1,
    },
    { type: "turn_context", payload: { turn_id: "Turn-Shared", model: "Parent-model", effort: "low" }, ordinal: 2 },
    {
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:01.000Z",
      payload: {
        turn_id: "Turn-Shared",
        response_id: "Response-Shared",
        usage: { output_tokens: 900 },
        turn_token_usage: { output_tokens: 900 },
      },
      ordinal: 3,
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "Turn-Shared",
        item: { id: "Item-Shared", type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 9000,
      },
      ordinal: 4,
    },
    {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "Turn-Shared", started_at: 1, completed_at: 9, duration_ms: 8000 },
      ordinal: 5,
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Parent",
        turn_id: "Turn-Shared",
        item: { id: "Ignored-parent-tool", type: "CommandExecution", duration: 8000 },
      },
      ordinal: 6,
    },
    {
      type: "turn_context",
      payload: { thread_id: "Child", turn_id: "Turn-Shared", model: "Child-model", effort: "high" },
      ordinal: 7,
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "Child",
        turn_id: "Turn-Shared",
        item: { id: "Item-Shared", type: "AgentMessage" },
        started_at_ms: 1_800_000_000_000,
        completed_at_ms: 1_800_000_000_400,
      },
      ordinal: 8,
    },
    {
      type: "token_usage_record",
      timestamp: "2026-10-01T00:00:02.000Z",
      payload: {
        thread_id: "Child",
        turn_id: "Turn-Shared",
        response_id: "Response-Shared",
        usage: { output_tokens: 40 },
        turn_token_usage: { output_tokens: 40 },
      },
      ordinal: 9,
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        thread_id: "Child",
        turn_id: "Turn-Shared",
        started_at: 1_800_000_000,
        completed_at: 1_800_000_001,
        duration_ms: 1000,
      },
      ordinal: 10,
    },
  ];
  const file = await createRollout(root, "sessions/child-with-inherited-evidence.jsonl", rows.map(json));

  const raw = await readCodexRolloutMetadata(file);
  assert.equal(
    raw.stats.recordsWithoutThreadId,
    4,
    "missing-ID parent prefix evidence remains visible in raw diagnostics",
  );
  const strict = await readCodexRollout(file);
  assert.equal(strict.projection.stats.recordsWithoutThreadId, 4, "accepted projection does not clear reader counters");
  assert.deepEqual(
    strict.projection.records.map((record) => record.ordinal),
    [0, 7, 8, 9, 10],
    "only the child header and child suffix are exposed to folding",
  );
  assert.ok(strict.projection.records.slice(1).every((record) => record.threadId === "Child"));

  const plan = await planCodexHomeThreads("home-child-prefix", [file]);
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.threads.map((thread) => thread.threadId),
    ["Child"],
  );
  const built = buildCodexThreadPerfSamples("home-child-prefix", "Child", plan.threads[0].rollouts, {
    lookupRequestTiming: ({ model, outputTokens }) => ({
      state: "available",
      durationMs: 400,
      reportedOutputTokens: outputTokens,
      requestedModel: model,
      generation: generationTiming(40, 200, 1),
    }),
  });
  assert.deepEqual(built.warnings, []);
  assert.deepEqual(built.rolloutFiles, [file]);
  assert.equal(built.samples.length, 1, "the parent prefix must not produce a second candidate");
  const [sample] = built.samples;
  assert.equal(sample.sampleKey, '["codex","home-child-prefix","Child","Turn-Shared","Response-Shared"]');
  assert.equal(sample.model, "Child-model");
  assert.equal(sample.reasoningEffort, "high");
  assert.equal(sample.outputTokens, 39);
  assert.equal(sample.requestCount, 1);
  assert.equal(sample.itemCount, 1);
  assert.equal(sample.durationMs, 200);
  const summary = summarizePerf(built.samples);
  assert.equal(summary.groups.length, 1, JSON.stringify({ sample, summary }));
  assert.equal(summary.groups[0].tps.pooled, 195);
});

test("M8.2 C: paginated child proof rejects incomplete ordinals, invalid bounds, malformed rows and identity conflicts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-child-rejections-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const makeRows = ({ boundary = 4, lastOrdinal = 5, currentHistoryBase } = {}) => {
    const childPayload = {
      session_id: "Parent",
      parent_thread_id: "Parent",
      forked_from_id: "Parent",
      source: { subagent: { thread_spawn: { id: "Agent" } } },
      history_mode: "paginated",
      subagent_history_start_ordinal: boundary,
    };
    if (currentHistoryBase !== undefined) childPayload.history_base = currentHistoryBase;
    const rows = [
      { ...sessionMeta("Child", childPayload), ordinal: 0 },
      {
        ...sessionMeta("Parent", {
          source: "cli",
          history_mode: "paginated",
          history_base: { thread_id: "Ancestor", end_ordinal_exclusive: 5000, end_byte_offset: 65536 },
          forked_from_id: "Ancestor",
          forked_from_ordinal_exclusive: 5000,
        }),
        ordinal: 1,
      },
    ];
    for (let ordinal = 2; ordinal <= lastOrdinal; ordinal += 1) {
      const row =
        ordinal === 2
          ? { type: "turn_context", payload: { turn_id: "Parent-turn", model: "Parent-model" } }
          : ordinal === boundary
            ? { type: "turn_context", payload: { thread_id: "Child", turn_id: "Child-turn", model: "Child-model" } }
            : { type: "response_item", payload: {} };
      rows.push({ ...row, ordinal });
    }
    return rows;
  };

  const invalidCases = [
    [
      "missing boundary",
      (rows) => {
        delete rows[0].payload.subagent_history_start_ordinal;
      },
    ],
    [
      "string boundary",
      (rows) => {
        rows[0].payload.subagent_history_start_ordinal = "4";
      },
    ],
    [
      "negative boundary",
      (rows) => {
        rows[0].payload.subagent_history_start_ordinal = -1;
      },
    ],
    [
      "fractional boundary",
      (rows) => {
        rows[0].payload.subagent_history_start_ordinal = 4.5;
      },
    ],
    [
      "unsafe boundary",
      (rows) => {
        rows[0].payload.subagent_history_start_ordinal = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "boundary in parent header",
      (rows) => {
        rows[0].payload.subagent_history_start_ordinal = 1;
      },
    ],
    [
      "session relation mismatch",
      (rows) => {
        rows[0].payload.session_id = "Other";
      },
    ],
    [
      "parent relation mismatch",
      (rows) => {
        rows[0].payload.parent_thread_id = "Other";
      },
    ],
    [
      "fork relation mismatch",
      (rows) => {
        rows[0].payload.forked_from_id = "Other";
      },
    ],
    [
      "parent session mismatch",
      (rows) => {
        rows[1].payload.session_id = "Other";
      },
    ],
    [
      "child source lacks thread_spawn",
      (rows) => {
        rows[0].payload.source = { subagent: {} };
      },
    ],
    [
      "child is not paginated",
      (rows) => {
        rows[0].payload.history_mode = "legacy";
      },
    ],
    [
      "parent is not paginated",
      (rows) => {
        rows[1].payload.history_mode = "legacy";
      },
    ],
    [
      "extra header",
      (rows) => {
        rows.push({ ...sessionMeta("Extra"), ordinal: rows.at(-1).ordinal + 1 });
      },
    ],
    [
      "current base is not an object",
      (rows) => {
        rows[0].payload.history_base = null;
      },
    ],
    [
      "current base lacks byte offset",
      (rows) => {
        rows[0].payload.history_base = { thread_id: "Current", end_ordinal_exclusive: 0 };
      },
    ],
    [
      "parent base has invalid offset",
      (rows) => {
        rows[1].payload.history_base.end_byte_offset = 1.5;
      },
    ],
    [
      "missing row ordinal",
      (rows) => {
        delete rows[2].ordinal;
      },
    ],
    [
      "string row ordinal",
      (rows) => {
        rows[2].ordinal = "2";
      },
    ],
    [
      "negative row ordinal",
      (rows) => {
        rows[2].ordinal = -2;
      },
    ],
    [
      "fractional row ordinal",
      (rows) => {
        rows[2].ordinal = 2.5;
      },
    ],
    [
      "unsafe row ordinal",
      (rows) => {
        rows[2].ordinal = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "wrong first ordinal",
      (rows) => {
        rows[0].ordinal = 1;
      },
    ],
    [
      "ordinal gap",
      (rows) => {
        for (const row of rows.slice(2)) row.ordinal += 1;
      },
    ],
    [
      "duplicate ordinal",
      (rows) => {
        rows[2].ordinal = rows[1].ordinal;
      },
    ],
    [
      "physical ordinal regression",
      (rows) => {
        [rows[2].ordinal, rows[3].ordinal] = [rows[3].ordinal, rows[2].ordinal];
      },
    ],
    [
      "boundary beyond last plus one",
      (rows) => {
        rows[0].payload.subagent_history_start_ordinal = 7;
      },
    ],
    [
      "prefix ID conflict",
      (rows) => {
        rows[2].payload.thread_id = "Child";
      },
    ],
    [
      "child suffix ID conflict",
      (rows) => {
        rows[4].payload.thread_id = "Parent";
      },
    ],
    [
      "ignored item envelope ID conflict",
      (rows) => {
        rows[3] = {
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: "Child",
            turn_id: "Parent-turn",
            item: { id: "Ignored", type: "CommandExecution" },
          },
          ordinal: rows[3].ordinal,
        };
      },
    ],
    [
      "unknown top-level type",
      (rows) => {
        rows.push({ type: "future_top", payload: {}, ordinal: rows.at(-1).ordinal + 1 });
      },
      "UNSUPPORTED_SCHEMA",
    ],
    [
      "unknown event type",
      (rows) => {
        rows.push({ type: "event_msg", payload: { type: "future_event" }, ordinal: rows.at(-1).ordinal + 1 });
      },
      "UNSUPPORTED_SCHEMA",
    ],
    [
      "unknown item type",
      (rows) => {
        rows.push({
          type: "event_msg",
          payload: { type: "item_completed", item: { id: "Future", type: "FutureItem" } },
          ordinal: rows.at(-1).ordinal + 1,
        });
      },
      "UNSUPPORTED_SCHEMA",
    ],
  ];

  for (const [index, [name, mutate, expectedCode = "UNKEYABLE_RECORD"]] of invalidCases.entries()) {
    const rows = makeRows();
    mutate(rows);
    const file = await createRollout(root, `sessions/rejected-${index}.jsonl`, rows.map(json));
    await assert.rejects(readCodexRollout(file), (error) => error.code === expectedCode, name);
    const plan = await planCodexHomeThreads(`home-rejected-${index}`, [file]);
    assert.equal(plan.ok, false, name);
    const failures = [...plan.unownedFiles, ...plan.homeBlocking];
    assert.equal(failures.length, 1, name);
    assert.equal(failures[0].code, expectedCode, `planner agrees with strict reader: ${name}`);
  }

  const malformedRows = makeRows();
  const malformedFile = await createRollout(root, "sessions/rejected-malformed.jsonl", [
    ...malformedRows.map(json),
    "{not-json",
  ]);
  await assert.rejects(readCodexRollout(malformedFile), (error) => error.code === "MALFORMED_JSON");
  const malformedPlan = await planCodexHomeThreads("home-rejected-malformed", [malformedFile]);
  assert.equal(malformedPlan.ok, false, "a boundary cannot hide malformed rows");
  assert.equal(malformedPlan.unownedFiles[0].code, "MALFORMED_JSON");

  const beyondEofRows = makeRows({ boundary: 238, lastOrdinal: 138 });
  const beyondEofFile = await createRollout(
    root,
    "sessions/rejected-boundary-beyond-eof.jsonl",
    beyondEofRows.map(json),
  );
  await assert.rejects(readCodexRollout(beyondEofFile), (error) => error.code === "UNKEYABLE_RECORD");
  const beyondEofPlan = await planCodexHomeThreads("home-rejected-beyond-eof", [beyondEofFile]);
  assert.equal(beyondEofPlan.ok, false, "boundary 238 cannot claim a file whose last ordinal is 138");
  assert.equal(beyondEofPlan.unownedFiles[0].code, "UNKEYABLE_RECORD");

  const emptySuffixRows = makeRows({ boundary: 3, lastOrdinal: 2 });
  const emptySuffixFile = await createRollout(root, "sessions/accepted-empty-suffix.jsonl", emptySuffixRows.map(json));
  const emptySuffix = await readCodexRollout(emptySuffixFile);
  assert.equal(
    emptySuffix.projection.ordinalSequence.lastOrdinal + 1,
    emptySuffix.projection.ownershipProof.boundaryOrdinal,
  );
  assert.deepEqual(
    emptySuffix.projection.records.map((record) => record.ordinal),
    [0],
  );
  const emptySuffixPlan = await planCodexHomeThreads("home-empty-suffix", [emptySuffixFile]);
  assert.equal(emptySuffixPlan.ok, true, "a fork with no child-owned suffix is a valid zero-sample rollout");
  assert.equal(
    buildCodexThreadPerfSamples("home-empty-suffix", "Child", emptySuffixPlan.threads[0].rollouts).samples.length,
    0,
  );
});

test("M8.2 §3: registered structures are accepted without changing TPS inputs or reading bodies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-structures-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const targetTurn = [
    json(sessionMeta("T")),
    json({ type: "turn_context", payload: { thread_id: "T", turn_id: "Turn-1", model: "Model-A" } }),
    json({
      type: "token_usage_record",
      payload: { thread_id: "T", turn_id: "Turn-1", response_id: "R1", usage: { output_tokens: 40 } },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "T",
        turn_id: "Turn-1",
        item: { id: "I1", type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "T",
        turn_id: "Turn-1",
        item: { id: "I2", type: "Reasoning" },
        started_at_ms: 1100,
        completed_at_ms: 1200,
      },
    }),
    json({
      type: "event_msg",
      payload: { type: "task_complete", thread_id: "T", turn_id: "Turn-1", duration_ms: 400 },
    }),
  ];

  const ignoredItem = (type, body) =>
    json({
      type: "event_msg",
      payload: { type: "item_completed", thread_id: "T", turn_id: "Turn-1", item: { id: `X-${type}`, type, ...body } },
    });

  const registeredStructures = [
    json({
      type: "compacted",
      payload: {
        window_id: "W1",
        window_number: 1,
        latest_token_usage_record: { thread_id: "T", usage: { output_tokens: 999 } },
        compaction_response_id: "CR1",
        replacement_history: BODY_SENTINEL,
        message: BODY_SENTINEL,
        guardian_history: BODY_SENTINEL,
      },
    }),
    json({ type: "inter_agent_communication_metadata", payload: { trigger_turn: "Turn-1" } }),
    json({ type: "retained_context", payload: { turn_id: "Turn-1", questions: BODY_SENTINEL } }),
    ignoredItem("CommandExecution", { command: BODY_SENTINEL, stdout: BODY_SENTINEL, duration: 9999, status: "ok" }),
    ignoredItem("UserMessage", { content: BODY_SENTINEL }),
    ignoredItem("FileChange", { changes: BODY_SENTINEL, stdout: BODY_SENTINEL, status: "ok" }),
    ignoredItem("McpToolCall", { arguments: BODY_SENTINEL, result: BODY_SENTINEL, duration: 9999, status: "ok" }),
    ignoredItem("Extension", { query: BODY_SENTINEL, results: BODY_SENTINEL, durationMs: 9999 }),
    ignoredItem("ImageView", { path: BODY_SENTINEL }),
    ignoredItem("ContextCompaction", {}),
    ignoredItem("SubAgentActivity", { agent_path: BODY_SENTINEL, agent_thread_id: "Other-Thread" }),
    ignoredItem("CollabAgentToolCall", {
      sender_thread_id: "Other-Thread",
      receiver_thread_ids: ["Other-Thread"],
      status: "ok",
    }),
    ignoredItem("DynamicToolCall", { arguments: BODY_SENTINEL, content_items: BODY_SENTINEL, duration: 9999 }),
    ignoredItem("Plan", { text: BODY_SENTINEL }),
    ignoredItem("FunctionCallOutput", { name: "tool", output: BODY_SENTINEL }),
    ignoredItem("WebSearch", { query: BODY_SENTINEL, action: { type: "search", query: BODY_SENTINEL } }),
  ];

  const baselineFile = await createRollout(root, "sessions/baseline.jsonl", targetTurn);
  const mixedFile = await createRollout(root, "sessions/mixed.jsonl", [...registeredStructures, ...targetTurn]);

  const baseline = await readCodexRolloutMetadata(baselineFile);
  const mixed = await readCodexRolloutMetadata(mixedFile);

  // Accepted: no unknown types, no structural damage, no ownership gap.
  assert.equal(mixed.stats.unknownTopLevelTypes, 0);
  assert.equal(mixed.stats.unknownEventTypes, 0);
  assert.equal(mixed.stats.unknownItemTypes, 0);
  assert.equal(mixed.stats.invalidPayloadRows, 0);
  assert.equal(mixed.stats.invalidItemRows, 0);
  assert.equal(mixed.stats.malformedJsonLines, 0);
  assert.equal(mixed.stats.recordsWithoutThreadId, 0);
  assert.equal(mixed.stats.recordsWithoutTurnId, baseline.stats.recordsWithoutTurnId);
  assert.equal(mixed.stats.ambiguousSessionMetaThreadId, 0);

  // TPS inputs are byte-identical to the baseline (positions excluded).
  const consumed = (projection) =>
    projection.records
      .filter((record) => record.kind !== "session_meta" && record.kind !== "ignored_item_envelope")
      .map(({ sourcePath, lineNumber, ordinal, ...rest }) => rest);
  assert.deepEqual(consumed(mixed), consumed(baseline), "registered structures must not change TPS inputs");

  // Ignored envelopes carry only identity, never item/span/terminal fields.
  for (const envelope of mixed.records.filter((record) => record.kind === "ignored_item_envelope")) {
    assert.deepEqual(Object.keys(envelope).sort(), [
      "kind",
      "lineNumber",
      "ordinal",
      "sourcePath",
      "threadId",
      "turnId",
    ]);
    assert.equal(envelope.ordinal, null);
  }
  // Bodies and tool durations are never read or projected.
  const serialized = JSON.stringify(mixed.records);
  assert.ok(!serialized.includes(BODY_SENTINEL), "ignored bodies must not be projected");
  assert.ok(!serialized.includes("9999"), "tool durations must not be projected");
  assert.ok(!serialized.includes("Other-Thread"), "ignored item thread fields must not become this file's identity");
});

test("M8.2 §3: unregistered top-level, event, and item labels still reject the file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const unknownTop = await createRollout(root, "sessions/unknown-top.jsonl", [
    json(sessionMeta("T")),
    json({ type: "totally_new_top", payload: {} }),
  ]);
  const unknownEvent = await createRollout(root, "sessions/unknown-event.jsonl", [
    json(sessionMeta("T")),
    json({ type: "event_msg", payload: { type: "totally_new_event" } }),
  ]);
  const unknownItem = await createRollout(root, "sessions/unknown-item.jsonl", [
    json(sessionMeta("T")),
    json({
      type: "event_msg",
      payload: { type: "item_completed", thread_id: "T", item: { id: "I1", type: "TotallyNewItem" } },
    }),
  ]);

  for (const file of [unknownTop, unknownEvent, unknownItem]) {
    await assert.rejects(readCodexRollout(file), (error) => error.code === "UNSUPPORTED_SCHEMA");
  }
});

test("M8.2 §3: a registered label must not mask a broken container", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-broken-container-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const badTopPayload = await createRollout(root, "sessions/bad-top.jsonl", [
    json(sessionMeta("T")),
    json({ type: "compacted", payload: "not-an-object" }),
  ]);
  const badItem = await createRollout(root, "sessions/bad-item.jsonl", [
    json(sessionMeta("T")),
    json({ type: "event_msg", payload: { type: "item_completed", thread_id: "T", item: "not-an-object" } }),
  ]);

  assert.equal((await readCodexRolloutMetadata(badTopPayload)).stats.invalidPayloadRows, 1);
  assert.equal((await readCodexRolloutMetadata(badItem)).stats.invalidItemRows, 1);
  await assert.rejects(readCodexRollout(badTopPayload), (error) => error.code === "MALFORMED_JSON");
  await assert.rejects(readCodexRollout(badItem), (error) => error.code === "MALFORMED_JSON");
});

test("M8.2 §3: a compaction checkpoint alone cannot produce a valid TPS request", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m82-checkpoint-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const file = await createRollout(root, "sessions/checkpoint-only.jsonl", [
    json(sessionMeta("T")),
    json({
      type: "compacted",
      payload: {
        window_id: "W1",
        latest_token_usage_record: { thread_id: "T", turn_id: "Turn-1", usage: { output_tokens: 500 } },
      },
    }),
  ]);
  const projection = await readCodexRolloutMetadata(file);
  assert.equal(projection.stats.unknownTopLevelTypes, 0, "checkpoints are registered, not unknown");
  assert.equal(
    projection.records.filter((record) => record.kind === "token_usage_record").length,
    0,
    "a nested checkpoint snapshot must not become a new request",
  );
});
