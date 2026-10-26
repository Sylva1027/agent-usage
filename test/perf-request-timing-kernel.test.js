import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizePerfSample, summarizePerf } from "../src/perf-stats.js";
import { resolveCodexTurnRequestTiming } from "../src/perf-sources/codex-request-timing.js";

const HOME = "home-synthetic";
const THREAD = "thread-synthetic";
const TURN = "turn-synthetic";
const MODEL = "model-synthetic";
const SIX_TURN_FIXTURE_URL = new URL(
  "../docs/validation/2026-10-21-tps-measurement-correction/A/review/six-turn-request-fixture.json",
  import.meta.url,
);

function request(responseId, outputTokens) {
  return {
    responseId,
    outputTokens,
    turnOutputTokens: outputTokens,
    timestampMs: 1_800_000_000_000,
    sourcePath: "synthetic.jsonl",
    lineNumber: 1,
  };
}

function turn(requests, overrides = {}) {
  return {
    threadId: THREAD,
    turnId: TURN,
    model: MODEL,
    requests,
    items: [],
    taskComplete: null,
    hasTaskComplete: false,
    requestSetComplete: true,
    ...overrides,
  };
}

function available(durationMs, outputTokens, requestedModel = MODEL) {
  return {
    state: "available",
    durationMs,
    reportedOutputTokens: outputTokens,
    requestedModel,
  };
}

function missing() {
  return { state: "missing", durationMs: null, reportedOutputTokens: null, requestedModel: "" };
}

function conflict() {
  return { state: "conflict", durationMs: null, reportedOutputTokens: null, requestedModel: "" };
}

function lookupFor(entries) {
  const calls = [];
  const lookup = (query) => {
    calls.push(query);
    return entries.get(query.responseId) ?? missing();
  };
  lookup.calls = calls;
  return lookup;
}

const requestA = request("response-a", 100);
const requestB = request("response-b", 900);
const completeLookup = () =>
  lookupFor(
    new Map([
      [requestA.responseId, available(1_000, requestA.outputTokens)],
      [requestB.responseId, available(9_000, requestB.outputTokens)],
    ]),
  );

test("100 + 900 tokens over 1 + 9 seconds is one complete turn at 100 tok/s", () => {
  const lookup = completeLookup();
  const timing = resolveCodexTurnRequestTiming(HOME, turn([requestA, requestB]), lookup);

  assert.deepEqual(timing, {
    state: "complete",
    durationMs: 10_000,
    timedRequestCount: 2,
    requestCount: 2,
  });
  assert.equal((1_000 / timing.durationMs) * 1_000, 100);
  assert.deepEqual(lookup.calls, [
    {
      homeId: HOME,
      threadId: THREAD,
      turnId: TURN,
      responseId: requestA.responseId,
      model: MODEL,
      outputTokens: 100,
    },
    {
      homeId: HOME,
      threadId: THREAD,
      turnId: TURN,
      responseId: requestB.responseId,
      model: MODEL,
      outputTokens: 900,
    },
  ]);
});

test("a missing request timing leaves the whole turn without a denominator", () => {
  const lookup = lookupFor(new Map([[requestA.responseId, available(1_000, requestA.outputTokens)]]));
  const timing = resolveCodexTurnRequestTiming(HOME, turn([requestA, requestB]), lookup);

  assert.deepEqual(timing, {
    state: "missing",
    durationMs: null,
    timedRequestCount: 1,
    requestCount: 2,
  });
  assert.notEqual(timing.durationMs, 1_000);
});

test("tool-only requests use the same request timing as text and reasoning requests", () => {
  const text = resolveCodexTurnRequestTiming(
    HOME,
    turn([requestA, requestB], {
      items: [
        { itemType: "AgentMessage", startedAtMs: 1, completedAtMs: 101 },
        { itemType: "Reasoning", startedAtMs: 101, completedAtMs: 201 },
      ],
    }),
    completeLookup(),
  );
  const toolOnly = resolveCodexTurnRequestTiming(
    HOME,
    turn([requestA, requestB], {
      items: [
        { itemType: "AgentMessage", startedAtMs: 1, completedAtMs: 101 },
        { itemType: "ToolCall", startedAtMs: 101, completedAtMs: 100_101 },
      ],
    }),
    completeLookup(),
  );

  assert.deepEqual(toolOnly, text);
});

test("item and task durations do not affect the request timing kernel", () => {
  const base = turn([requestA, requestB], {
    items: [{ itemType: "AgentMessage", startedAtMs: 1, completedAtMs: 101 }],
    taskComplete: { durationMs: 10 },
  });
  const changed = turn([requestA, requestB], {
    items: [{ itemType: "ToolCall", startedAtMs: 1, completedAtMs: 100_001 }],
    taskComplete: { durationMs: 100_000 },
  });

  assert.deepEqual(
    resolveCodexTurnRequestTiming(HOME, changed, completeLookup()),
    resolveCodexTurnRequestTiming(HOME, base, completeLookup()),
  );
});

test("output-count mismatch is a conflict", () => {
  const lookup = lookupFor(
    new Map([
      [requestA.responseId, available(1_000, requestA.outputTokens)],
      [requestB.responseId, available(9_000, 901)],
    ]),
  );

  assert.deepEqual(resolveCodexTurnRequestTiming(HOME, turn([requestA, requestB]), lookup), {
    state: "conflict",
    durationMs: null,
    timedRequestCount: 1,
    requestCount: 2,
  });
});

test("model mismatch is a conflict", () => {
  const lookup = lookupFor(new Map([[requestA.responseId, available(1_000, requestA.outputTokens, "other-model")]]));

  assert.equal(resolveCodexTurnRequestTiming(HOME, turn([requestA]), lookup).state, "conflict");
});

test("an explicit lookup conflict is a conflict", () => {
  const lookup = lookupFor(new Map([[requestA.responseId, conflict()]]));

  assert.equal(resolveCodexTurnRequestTiming(HOME, turn([requestA]), lookup).state, "conflict");
});

test("available lookups with malformed counts or models are not trusted", () => {
  const malformed = [
    { ...available(1_000, requestA.outputTokens), reportedOutputTokens: "100" },
    { ...available(1_000, requestA.outputTokens), reportedOutputTokens: null },
    { ...available(1_000, requestA.outputTokens), requestedModel: null },
    { ...available(1_000, requestA.outputTokens), requestedModel: 7 },
  ];

  for (const timing of malformed) {
    const lookup = lookupFor(new Map([[requestA.responseId, timing]]));
    const resolved = resolveCodexTurnRequestTiming(HOME, turn([requestA]), lookup);
    assert.equal(resolved.state, "conflict");
    assert.equal(resolved.durationMs, null);
  }
});

test("non-positive, fractional, non-finite, and unsafe durations are invalid", () => {
  const durations = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];

  for (const durationMs of durations) {
    const lookup = lookupFor(new Map([[requestA.responseId, available(durationMs, requestA.outputTokens)]]));
    assert.deepEqual(resolveCodexTurnRequestTiming(HOME, turn([requestA]), lookup), {
      state: "invalid",
      durationMs: null,
      timedRequestCount: 0,
      requestCount: 1,
    });
  }
});

test("safe-integer sum overflow is invalid", () => {
  const first = request("response-overflow-a", 1);
  const second = request("response-overflow-b", 1);
  const lookup = lookupFor(
    new Map([
      [first.responseId, available(Number.MAX_SAFE_INTEGER, first.outputTokens)],
      [second.responseId, available(1, second.outputTokens)],
    ]),
  );

  assert.deepEqual(resolveCodexTurnRequestTiming(HOME, turn([first, second]), lookup), {
    state: "invalid",
    durationMs: null,
    timedRequestCount: 2,
    requestCount: 2,
  });
});

test("duplicate request identity is a conflict even when lookups otherwise match", () => {
  const duplicate = request(requestA.responseId, 100);
  const lookup = lookupFor(new Map([[requestA.responseId, available(1_000, requestA.outputTokens)]]));

  assert.equal(resolveCodexTurnRequestTiming(HOME, turn([requestA, duplicate]), lookup).state, "conflict");
});

test("reversing request order does not change timing", () => {
  const forward = resolveCodexTurnRequestTiming(HOME, turn([requestA, requestB]), completeLookup());
  const reversed = resolveCodexTurnRequestTiming(HOME, turn([requestB, requestA]), completeLookup());

  assert.deepEqual(reversed, forward);
});

test("state precedence is conflict over invalid over missing over complete", () => {
  const conflictRequest = request("response-conflict", 100);
  const invalidRequest = request("response-invalid", 100);
  const missingRequest = request("response-missing", 100);
  const lookup = lookupFor(
    new Map([
      [conflictRequest.responseId, conflict()],
      [invalidRequest.responseId, available(0, invalidRequest.outputTokens)],
      [missingRequest.responseId, missing()],
    ]),
  );
  const orders = [
    [conflictRequest, invalidRequest, missingRequest],
    [conflictRequest, missingRequest, invalidRequest],
    [invalidRequest, conflictRequest, missingRequest],
    [invalidRequest, missingRequest, conflictRequest],
    [missingRequest, conflictRequest, invalidRequest],
    [missingRequest, invalidRequest, conflictRequest],
  ];

  for (const requests of orders) {
    assert.equal(resolveCodexTurnRequestTiming(HOME, turn(requests), lookup).state, "conflict");
  }

  const invalidOrMissing = lookupFor(
    new Map([
      [invalidRequest.responseId, available(0, invalidRequest.outputTokens)],
      [missingRequest.responseId, missing()],
    ]),
  );
  assert.equal(
    resolveCodexTurnRequestTiming(HOME, turn([invalidRequest, missingRequest]), invalidOrMissing).state,
    "invalid",
  );
  assert.equal(
    resolveCodexTurnRequestTiming(HOME, turn([missingRequest, invalidRequest]), invalidOrMissing).state,
    "invalid",
  );
});

test("lookup exceptions propagate unchanged", () => {
  const sentinel = new Error("timing lookup failed");
  const lookup = () => {
    throw sentinel;
  };

  assert.throws(
    () => resolveCodexTurnRequestTiming(HOME, turn([requestA]), lookup),
    (error) => error === sentinel,
  );
});

test("an empty request ledger is not complete", () => {
  assert.deepEqual(resolveCodexTurnRequestTiming(HOME, turn([]), completeLookup()), {
    state: "missing",
    durationMs: null,
    timedRequestCount: 0,
    requestCount: 0,
  });
});

test("a missing lookup callback or incomplete request set is missing", () => {
  assert.equal(resolveCodexTurnRequestTiming(HOME, turn([requestA]), undefined).state, "missing");
  assert.equal(
    resolveCodexTurnRequestTiming(HOME, turn([requestA], { requestSetComplete: false }), completeLookup()).state,
    "missing",
  );
});

test("the six-turn A fixture resolves to one complete sample per turn and the frozen statistics", async () => {
  const fixture = JSON.parse(await readFile(SIX_TURN_FIXTURE_URL, "utf8"));
  const requestsById = new Map(
    fixture.turns.flatMap((fixtureTurn) =>
      fixtureTurn.requests.map((fixtureRequest) => [fixtureRequest.id, fixtureRequest]),
    ),
  );
  const lookup = (query) => {
    const fixtureRequest = requestsById.get(query.responseId);
    assert.ok(fixtureRequest, `unknown fixture request ${query.responseId}`);
    assert.equal(query.model, fixture.requestedModel);
    assert.equal(query.outputTokens, fixtureRequest.outputTokens);
    return available(fixtureRequest.durationMs, fixtureRequest.outputTokens, fixture.requestedModel);
  };
  const samples = [];
  let requestCount = 0;
  let outputTokens = 0;
  let durationMs = 0;

  for (const fixtureTurn of fixture.turns) {
    const turnOutputTokens = fixtureTurn.requests.reduce((sum, fixtureRequest) => sum + fixtureRequest.outputTokens, 0);
    const turnDurationMs = fixtureTurn.requests.reduce((sum, fixtureRequest) => sum + fixtureRequest.durationMs, 0);
    assert.equal(turnOutputTokens, fixtureTurn.outputTokens);
    assert.equal(turnDurationMs, fixtureTurn.durationMs);

    const ledgerTurn = turn(
      fixtureTurn.requests.map((fixtureRequest) => request(fixtureRequest.id, fixtureRequest.outputTokens)),
      {
        threadId: "fixture-thread",
        turnId: fixtureTurn.id,
        model: fixture.requestedModel,
      },
    );
    const timing = resolveCodexTurnRequestTiming("fixture-home", ledgerTurn, lookup);
    assert.deepEqual(timing, {
      state: "complete",
      durationMs: fixtureTurn.durationMs,
      timedRequestCount: fixtureTurn.requestCount,
      requestCount: fixtureTurn.requestCount,
    });

    const normalized = normalizePerfSample({
      sourceKind: "codex",
      homeId: "fixture-home",
      threadId: "fixture-thread",
      turnId: fixtureTurn.id,
      model: fixture.requestedModel,
      reasoningEffort: fixture.reasoningEffort,
      status: "completed",
      terminalVerified: true,
      timingSource: "explicit",
      tsMs: Date.parse(fixtureTurn.endedAt),
      outputTokens: fixtureTurn.outputTokens,
      durationMs: timing.durationMs,
      requestCount: timing.requestCount,
    });
    assert.ok(normalized.sample, normalized.warningCode);
    samples.push(normalized.sample);
    requestCount += timing.requestCount;
    outputTokens += turnOutputTokens;
    durationMs += timing.durationMs;
  }

  assert.equal(requestCount, fixture.totals.requests);
  assert.equal(requestCount, 326);
  assert.equal(outputTokens, fixture.totals.outputTokens);
  assert.equal(outputTokens, 233_379);
  assert.equal(durationMs, fixture.totals.durationMs);

  const summary = summarizePerf(samples, { meta: { minSamples: 1 } });
  assert.equal(summary.coverage.sampled, 6);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.models.length, 1);
  const group = summary.groups[0];
  const model = summary.models[0];
  assert.equal(group.n, 6);
  assert.equal(group.sums.outputTokens, 233_379);
  assert.equal(group.sums.durationMs, 1_742_789);
  assert.equal(group.tps.pooled, 133.91121931570603);
  assert.equal(group.tps.p10, 62.28098120420516);
  assert.equal(group.tps.p90, 148.15868290876423);
  assert.equal(model.n, 6);
  assert.equal(model.averageTps, 133.91121931570603);
  assert.equal(model.p10, 62.28098120420516);
  assert.equal(model.p90, 148.15868290876423);
});

test("fixture request failures never publish a partial denominator or fall back to item spans", async () => {
  const fixture = JSON.parse(await readFile(SIX_TURN_FIXTURE_URL, "utf8"));
  const [first, second] = fixture.turns[0].requests;
  const firstTiming = available(first.durationMs, first.outputTokens, fixture.requestedModel);
  const cases = [
    { kind: "text", failure: "missing", timing: missing(), state: "missing" },
    { kind: "tool", failure: "missing", timing: missing(), state: "missing" },
    {
      kind: "text",
      failure: "output mismatch",
      timing: available(second.durationMs, second.outputTokens + 1, fixture.requestedModel),
      state: "conflict",
    },
    {
      kind: "tool",
      failure: "output mismatch",
      timing: available(second.durationMs, second.outputTokens + 1, fixture.requestedModel),
      state: "conflict",
    },
    {
      kind: "text",
      failure: "model mismatch",
      timing: available(second.durationMs, second.outputTokens, "other-model"),
      state: "conflict",
    },
    {
      kind: "tool",
      failure: "model mismatch",
      timing: available(second.durationMs, second.outputTokens, "other-model"),
      state: "conflict",
    },
  ];

  for (const testCase of cases) {
    const items =
      testCase.kind === "tool"
        ? [
            { itemType: "AgentMessage", startedAtMs: 1, completedAtMs: 1_001 },
            { itemType: "ToolCall", startedAtMs: 1_001, completedAtMs: 101_001 },
          ]
        : [
            { itemType: "AgentMessage", startedAtMs: 1, completedAtMs: 1_001 },
            { itemType: "Reasoning", startedAtMs: 1_001, completedAtMs: 2_001 },
          ];
    const ledgerTurn = turn([request(first.id, first.outputTokens), request(second.id, second.outputTokens)], {
      threadId: "fixture-thread",
      turnId: fixture.turns[0].id,
      model: fixture.requestedModel,
      items,
      taskComplete: { durationMs: 100_000 },
    });
    const timing = resolveCodexTurnRequestTiming(
      "fixture-home",
      ledgerTurn,
      lookupFor(
        new Map([
          [first.id, firstTiming],
          [second.id, testCase.timing],
        ]),
      ),
    );

    assert.equal(timing.state, testCase.state, `${testCase.kind} ${testCase.failure}`);
    assert.equal(timing.durationMs, null, `${testCase.kind} ${testCase.failure} must not publish a partial duration`);
    assert.equal(timing.requestCount, 2);
    assert.equal(timing.timedRequestCount, 1);
  }
});
