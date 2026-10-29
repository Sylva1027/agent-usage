import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MAGPIE_TIMING_ORIGIN, MagpieRequestTimings } from "../scripts/perf-reference-magpie.mjs";

function row(overrides = {}) {
  return {
    agent: "codex",
    provider: "codex",
    req: "codex/model-a",
    model: "model-a",
    response_id: "response-a",
    status: 200,
    ms: 2000,
    out: 100,
    stop: "completed",
    ep: "/backend-api/codex/responses",
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".magpie-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { file: path.join(root, "usage.jsonl"), reader: new MagpieRequestTimings() };
}

test("read append-only timing without retaining gateway credentials or bodies", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    `${JSON.stringify(row({ host: "private-host", body: "secret", providerKeyId: "secret-key" }))}\n`,
  );
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.recordsForRequest("response-a", "model-a", 100), [
    {
      schemaVersion: 2,
      evidenceOrigin: MAGPIE_TIMING_ORIGIN,
      responseId: "response-a",
      requestedModel: "model-a",
      reportedOutputTokens: 100,
      durationMs: 2000,
      status: "completed",
      completedAtMs: null,
      generation: null,
    },
  ]);
  assert.equal(JSON.stringify([...reader.requests]).includes("secret"), false);
  const offset = reader.offset;
  const first = reader.pendingChanges();
  assert.deepEqual(first.responseIds, new Set(["response-a"]));
  assert.equal(first.reset, true);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), first);
  assert.equal(reader.offset, offset);
  assert.equal(reader.acknowledge(first.revision), true);
  const acknowledged = reader.pendingChanges();
  const next = Buffer.from(
    `${JSON.stringify(row({ response_id: "response-b", ms: 3000, req: "codex/模型", model: "模型" }))}\n`,
  );
  const split = next.indexOf(Buffer.from("模")) + 1;
  await appendFile(file, next.subarray(0, split));
  assert.equal(await reader.read(file), true);
  assert.equal(reader.offset, offset);
  assert.deepEqual(reader.pendingChanges(), acknowledged);
  await appendFile(file, next.subarray(split));
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-b", "模型", 100)[0].durationMs, 3000);
  assert.equal(reader.requests.size, 2);
  assert.deepEqual(reader.pendingChanges().responseIds, new Set(["response-b"]));
  assert.equal(reader.pendingChanges().reset, false);
});

test("canonicalize only explicit Codex provider aliases; preserve mismatches for the timing kernel", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 101)[0].reportedOutputTokens, 100);
  assert.equal(reader.recordsForRequest("response-a", "other/model-a", 100)[0].requestedModel, "codex/model-a");
  assert.equal(reader.recordsForRequest("response-a", "codex/model-a", 100).length, 1);
  await appendFile(file, `${JSON.stringify(row({ response_id: "response-b", provider: "other" }))}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100)[0].requestedModel, "codex/model-a");
});

test("in-memory lookup exactly matches original model and output before returning generation", async (t) => {
  const { file, reader } = await fixture(t);
  const rows = [
    row({
      reasoning: 0,
      first_output_ms: 100,
      last_output_ms: 600,
    }),
    row({
      response_id: "response-ledger-reasoning",
      reasoning: 20,
      first_output_ms: 100,
      last_output_ms: 600,
    }),
  ];
  await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`);
  await reader.read(file);

  assert.deepEqual(
    reader.lookupRequestTiming({
      responseId: "response-a",
      model: "model-a",
      outputTokens: 100,
      reasoningOutputTokens: 0,
    }),
    {
      state: "available",
      durationMs: 2_000,
      reportedOutputTokens: 100,
      requestedModel: "model-a",
      generation: {
        outputTokens: 100,
        durationMs: 500,
        startOutputTokens: 1,
        timingKind: "first_last_output",
      },
    },
  );
  assert.deepEqual(
    reader.lookupRequestTiming({
      responseId: "response-ledger-reasoning",
      model: "model-a",
      outputTokens: 100,
    }).generation,
    {
      outputTokens: 80,
      durationMs: 500,
      startOutputTokens: 1,
      timingKind: "first_last_output",
    },
  );
  assert.deepEqual(reader.lookupRequestTiming({ responseId: "response-a", model: "other-model", outputTokens: 100 }), {
    state: "conflict",
    durationMs: null,
    reportedOutputTokens: null,
    requestedModel: "",
    generation: null,
  });
  assert.equal(
    reader.lookupRequestTiming({ responseId: "response-a", model: "model-a", outputTokens: 101 }).state,
    "conflict",
  );
  assert.deepEqual(
    reader.lookupRequestTiming({ responseId: "response-missing", model: "model-a", outputTokens: 100 }),
    {
      state: "missing",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    },
  );
});

test("explicit first/last or generation durations measure pure-tool responses without speed thresholds", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    [
      row({
        response_id: "response-tool",
        stop: "tool_use",
        out: 2,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 120,
      }),
      row({
        response_id: "response-fast",
        out: 1_000,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 110,
      }),
      row({
        response_id: "response-tool-approximate",
        stop: "tool_calls",
        out: 10,
        reasoning: 0,
        first_output_ms: 100,
        generation_ms: 500,
      }),
      row({
        response_id: "response-tool-text-boundary",
        stop: "tool_use",
        out: 10,
        reasoning: 0,
        first_text_ms: 100,
        ttft_ms: 100,
      }),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await reader.read(file);

  assert.deepEqual(reader.recordsForRequest("response-tool", "model-a", 2)[0].generation, {
    outputTokens: 2,
    durationMs: 20,
    startOutputTokens: 1,
    timingKind: "first_last_output",
  });
  assert.deepEqual(reader.recordsForRequest("response-fast", "model-a", 1_000)[0].generation, {
    outputTokens: 1_000,
    durationMs: 10,
    startOutputTokens: 1,
    timingKind: "first_last_output",
  });
  assert.deepEqual(reader.recordsForRequest("response-tool-approximate", "model-a", 10)[0].generation, {
    outputTokens: 10,
    durationMs: 500,
    startOutputTokens: 0,
    timingKind: "explicit",
  });
  assert.equal(reader.recordsForRequest("response-tool-text-boundary", "model-a", 10)[0].generation, null);
});

test("explicit generation duration outranks a response-end approximation", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    `${JSON.stringify(
      row({
        response_id: "response-explicit",
        reasoning: 0,
        first_output_ms: 100,
        generation_ms: 500,
      }),
    )}\n`,
  );
  await reader.read(file);

  assert.deepEqual(reader.recordsForRequest("response-explicit", "model-a", 100)[0].generation, {
    outputTokens: 100,
    durationMs: 500,
    startOutputTokens: 0,
    timingKind: "explicit",
  });
});

test("known reasoning reconciles explicit generation output in memory lookups", async (t) => {
  const { file, reader } = await fixture(t);
  const explicit = (outputTokens) => ({
    outputTokens,
    durationMs: 500,
    startOutputTokens: 0,
    timingKind: "explicit",
  });
  await writeFile(
    file,
    [
      row({ response_id: "response-native-valid", generation: explicit(80) }),
      row({ response_id: "response-native-conflict", generation: explicit(100) }),
      row({ response_id: "response-ledger-valid", reasoning: 20, generation: explicit(80) }),
      row({ response_id: "response-ledger-conflict", reasoning: 20, generation: explicit(100) }),
      row({ response_id: "response-unknown", generation: explicit(100) }),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await reader.read(file);

  assert.deepEqual(
    reader.lookupRequestTiming({
      responseId: "response-native-valid",
      model: "model-a",
      outputTokens: 100,
      reasoningOutputTokens: 20,
    }).generation,
    explicit(80),
  );
  assert.equal(
    reader.lookupRequestTiming({
      responseId: "response-native-conflict",
      model: "model-a",
      outputTokens: 100,
      reasoningOutputTokens: 20,
    }).state,
    "conflict",
  );
  assert.equal(
    reader.lookupRequestTiming({
      responseId: "response-native-valid",
      model: "model-a",
      outputTokens: 100,
      reasoningOutputTokens: 0,
    }).state,
    "conflict",
  );
  assert.equal(
    reader.lookupRequestTiming({
      responseId: "response-ledger-valid",
      model: "model-a",
      outputTokens: 100,
    }).state,
    "available",
  );
  assert.equal(
    reader.lookupRequestTiming({
      responseId: "response-ledger-conflict",
      model: "model-a",
      outputTokens: 100,
    }).state,
    "conflict",
  );
  assert.deepEqual(
    reader.lookupRequestTiming({
      responseId: "response-unknown",
      model: "model-a",
      outputTokens: 100,
      reasoningOutputTokens: null,
    }).generation,
    explicit(100),
  );

  const [preserved] = reader.recordsForRequest("response-native-conflict", "model-a", 100, 20);
  assert.equal(preserved.reportedOutputTokens, 100);
  assert.deepEqual(preserved.generation, explicit(100));
});

test("text completion is only used when first-text and TTFT agree", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    [
      row({
        response_id: "response-text",
        out: 10,
        reasoning: 0,
        first_text_ms: 100,
        ttft_ms: 100,
      }),
      row({
        response_id: "response-tool-first",
        out: 10,
        reasoning: 0,
        first_text_ms: 500,
        ttft_ms: 100,
      }),
      row({
        response_id: "response-ttft-only",
        out: 10,
        reasoning: 0,
        ttft_ms: 100,
      }),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await reader.read(file);

  assert.deepEqual(reader.recordsForRequest("response-text", "model-a", 10)[0].generation, {
    outputTokens: 10,
    durationMs: 1_900,
    startOutputTokens: 1,
    timingKind: "first_output_response_end",
  });
  assert.equal(reader.recordsForRequest("response-tool-first", "model-a", 10)[0].generation, null);
  assert.equal(reader.recordsForRequest("response-ttft-only", "model-a", 10)[0].generation, null);
});

test("only explicit stream shape proves a one-shot response; flow_ms cannot override real boundaries", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    [
      row({
        response_id: "response-flow",
        out: 100,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 1_100,
        first_text_ms: 300,
        ttft_ms: 300,
        flow_ms: 1,
      }),
      row({
        response_id: "response-flow-zero",
        out: 100,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 1_100,
        flow_ms: 0,
      }),
      row({
        response_id: "response-confirmed-single-chunk",
        out: 100,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 1_100,
        single_chunk: true,
      }),
      row({
        response_id: "response-confirmed-one-shot",
        out: 100,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 1_100,
        one_shot: true,
      }),
      row({
        response_id: "response-confirmed-non-streamed",
        out: 100,
        reasoning: 0,
        first_output_ms: 100,
        last_output_ms: 1_100,
        streamed: false,
      }),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await reader.read(file);

  assert.deepEqual(reader.recordsForRequest("response-flow", "model-a", 100)[0].generation, {
    outputTokens: 100,
    durationMs: 1_000,
    startOutputTokens: 1,
    timingKind: "first_last_output",
  });
  assert.deepEqual(reader.recordsForRequest("response-flow-zero", "model-a", 100)[0].generation, {
    outputTokens: 100,
    durationMs: 1_000,
    startOutputTokens: 1,
    timingKind: "first_last_output",
  });
  assert.equal(reader.recordsForRequest("response-confirmed-single-chunk", "model-a", 100)[0].generation, null);
  assert.equal(reader.recordsForRequest("response-confirmed-one-shot", "model-a", 100)[0].generation, null);
  assert.equal(reader.recordsForRequest("response-confirmed-non-streamed", "model-a", 100)[0].generation, null);
});

test("Claude ledger rows use their endpoint, agent, exact ID, and native reasoning count", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    `${JSON.stringify(
      row({
        agent: "claude-desktop",
        provider: "anthropic",
        req: "anthropic/model-a",
        ep: "/v1/messages → /v1/responses",
        response_id: "message-a",
        out: 100,
        reasoning: 20,
        reasoning_hidden: true,
        first_output_ms: 100,
        last_output_ms: 200,
      }),
    )}\n`,
  );
  await reader.read(file);

  const [record] = reader.recordsForRequest("message-a", "model-a", 100, 20);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.requestedModel, "anthropic/model-a");
  assert.deepEqual(record.generation, {
    outputTokens: 80,
    durationMs: 100,
    startOutputTokens: 1,
    timingKind: "first_last_output",
  });

  const withoutReasoning = new MagpieRequestTimings();
  withoutReasoning.addLine(
    JSON.stringify(
      row({
        agent: "claude",
        req: "",
        ep: "/v1/messages",
        response_id: "message-b",
        first_output_ms: 100,
        last_output_ms: 200,
      }),
    ),
  );
  assert.equal(withoutReasoning.recordsForRequest("message-b", "model-a", 100)[0].generation, null);
  assert.deepEqual(withoutReasoning.recordsForRequest("message-b", "model-a", 100, 0)[0].generation, {
    outputTokens: 100,
    durationMs: 100,
    startOutputTokens: 1,
    timingKind: "first_last_output",
  });
  assert.deepEqual(
    withoutReasoning.lookupRequestTiming({
      responseId: "message-b",
      model: "model-a",
      outputTokens: 100,
      reasoningOutputTokens: 0,
    }).generation,
    {
      outputTokens: 100,
      durationMs: 100,
      startOutputTokens: 1,
      timingKind: "first_last_output",
    },
  );
});

test("failed, interrupted and invalid requests cannot supply a denominator", async (t) => {
  const { file, reader } = await fixture(t);
  const invalid = [
    null,
    { agent: "claude" },
    { status: 500 },
    { ms: 0 },
    { out: -1 },
    { out: 1.5 },
    { tries: 0 },
    { retried_ms: -1 },
    { stop: "incomplete" },
    { handed_on: true },
    { rejected: true },
    { ep: "/v1/chat/completions" },
    { response_id: "" },
  ];
  await writeFile(file, `broken-json\n${invalid.map((r) => JSON.stringify(r === null ? r : row(r))).join("\n")}\n`);
  await reader.read(file);
  assert.equal(reader.requests.size, 0);
  assert.equal(reader.pendingChanges().responseIds.size, 0);
  reader.acknowledge(reader.pendingChanges().revision);
  const acknowledged = reader.pendingChanges();
  await appendFile(file, `broken-json\n${JSON.stringify(row({ status: 500 }))}\n`);
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.pendingChanges(), acknowledged);
});

test("valid retry fields retain the producer's request duration", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    [
      row({ provider: "opendesign", req: "opendesign/model-a", tries: 2, retried_ms: 500 }),
      row({ response_id: "response-b", tries: 3, retried_ms: 30 }),
      row({ response_id: "response-c", tries: 2, retried_ms: 0, sent_ms: 1500, own_ms: 900 }),
      row({ response_id: "response-d", tries: 2 }),
    ]
      .map((r) => `${JSON.stringify(r)}\n`)
      .join(""),
  );
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100)[0].durationMs, 2000);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100)[0].durationMs, 2000);
  assert.equal(reader.recordsForRequest("response-c", "model-a", 100)[0].durationMs, 2000);
  assert.equal(reader.recordsForRequest("response-d", "model-a", 100)[0].durationMs, 2000);
});

test("rotation rereads the new ledger; absent ledger is optional", async (t) => {
  const { file, reader } = await fixture(t);
  assert.equal(await reader.read(file), false);
  reader.acknowledge(reader.pendingChanges().revision);
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  const opened = reader.pendingChanges();
  assert.equal(opened.reset, true);
  reader.acknowledge(opened.revision);
  await rename(file, `${file}.old`);
  await writeFile(file, `${JSON.stringify(row({ response_id: "response-b" }))}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100).length, 0);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100).length, 1);
  const rotated = reader.pendingChanges();
  assert.equal(rotated.reset, true);
  assert.deepEqual(rotated.responseIds, new Set(["response-b"]));
  assert.equal(reader.acknowledge(opened.revision), false);
  reader.acknowledge(rotated.revision);
  await writeFile(file, "");
  assert.equal(await reader.read(file), false);
  assert.equal(reader.requests.size, 0);
  const truncated = reader.pendingChanges();
  assert.equal(truncated.reset, true);
  assert.deepEqual(truncated.responseIds, new Set());
  assert.equal(reader.acknowledge(rotated.revision), false);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), truncated);
  await rm(file);
  assert.equal(await reader.read(file), false);
  const missing = reader.pendingChanges();
  assert.equal(missing.reset, true);
  assert.ok(missing.revision > truncated.revision);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), missing);
  reader.acknowledge(missing.revision);
  assert.equal(await reader.read(file), false);
  assert.equal(reader.pendingChanges().reset, false);
  await writeFile(file, "");
  assert.equal(await reader.read(file), false);
  const returned = reader.pendingChanges();
  assert.equal(returned.reset, true);
  assert.ok(returned.revision > missing.revision);
  assert.equal(reader.acknowledge(missing.revision), false);
  assert.equal(reader.acknowledge(returned.revision), true);
});

test("duplicate observations deduplicate; conflicting durations remain separate", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, [row(), row(), row({ ms: 4000 })].map((r) => `${JSON.stringify(r)}\n`).join(""));
  await reader.read(file);
  assert.deepEqual(
    reader.recordsForRequest("response-a", "model-a", 100).map((r) => r.durationMs),
    [2000, 4000],
  );
  const first = reader.pendingChanges();
  assert.deepEqual(first.responseIds, new Set(["response-a"]));
  reader.acknowledge(first.revision);
  const acknowledged = reader.pendingChanges();
  await appendFile(file, `${JSON.stringify(row({ host: "ignored-host" }))}\n`);
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.pendingChanges(), acknowledged);
  await appendFile(file, `${JSON.stringify(row({ ms: 6000 }))}\n`);
  await reader.read(file);
  const conflict = reader.pendingChanges();
  assert.deepEqual(conflict.responseIds, new Set(["response-a"]));
  assert.equal(conflict.reset, false);
  assert.ok(conflict.revision > first.revision);
  assert.equal(reader.acknowledge(first.revision), false);
});

test("pending snapshots are independent and clear invalidates old acknowledgements", () => {
  const reader = new MagpieRequestTimings();
  reader.addLine(JSON.stringify(row()));
  const first = reader.pendingChanges();
  first.responseIds.clear();
  first.responseIds.add("consumer-only");
  assert.deepEqual(reader.pendingChanges().responseIds, new Set(["response-a"]));
  reader.addLine(JSON.stringify(row({ ms: 4000 })));
  assert.equal(reader.acknowledge(first.revision), false);
  const conflict = reader.pendingChanges();
  reader.clear();
  assert.equal(reader.requests.size, 0);
  const cleared = reader.pendingChanges();
  assert.equal(cleared.reset, true);
  assert.deepEqual(cleared.responseIds, new Set(["response-a"]));
  assert.ok(cleared.revision > conflict.revision);
  assert.equal(reader.acknowledge(conflict.revision), false);
  assert.equal(reader.acknowledge(cleared.revision), true);
  assert.deepEqual(reader.pendingChanges(), {
    revision: cleared.revision,
    responseIds: new Set(),
    reset: false,
  });
  assert.deepEqual(cleared.responseIds, new Set(["response-a"]));
});

test("a failed read and retries without new bytes retain unpublished changes", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, "");
  assert.equal(await reader.read(file), false);
  reader.acknowledge(reader.pendingChanges().revision);
  await appendFile(file, `${JSON.stringify(row())}\n`);
  const addLine = reader.addLine;
  reader.addLine = (line) => {
    addLine.call(reader, line);
    throw new Error("injected read failure");
  };
  await assert.rejects(reader.read(file), /injected read failure/);
  reader.addLine = addLine;
  const pending = reader.pendingChanges();
  assert.deepEqual(pending.responseIds, new Set(["response-a"]));
  assert.equal(pending.reset, false);
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.pendingChanges(), pending);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), pending);
  assert.equal(reader.acknowledge(pending.revision), true);
});

test("same-size ledger rewrites reset associations when mtime changes", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  const first = reader.pendingChanges();
  reader.acknowledge(first.revision);
  await writeFile(file, `${JSON.stringify(row({ response_id: "response-b" }))}\n`);
  const rewrittenAt = new Date(reader.mtimeMs + 2000);
  await utimes(file, rewrittenAt, rewrittenAt);
  assert.equal(await reader.read(file), true);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100).length, 0);
  assert.equal(reader.pendingChanges().reset, true);
  assert.deepEqual(reader.pendingChanges().responseIds, new Set(["response-b"]));
  assert.equal(reader.acknowledge(first.revision), false);
});
