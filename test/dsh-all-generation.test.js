/**
 * D4 DSH full-generation reader contract.
 *
 * These fixtures deliberately keep message content out of the projection. They exercise
 * only the successful message's usage and its own compact assistant stream, plus the
 * request header's model/provider/effort scope.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { inspectDshAssistantGeneration, streamDshPerfSamples } from "../src/perf-sources/dsh.js";
import { PERF_METHOD_VERSION, perfFlagNamesOf } from "../src/perf-stats.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const READER_FILE = path.join(REPO_ROOT, "src", "perf-sources", "dsh.js");
const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const SESSION_ID = "dsh-full-generation-session";
const HOME_ID = "dsh-full-generation-home";

function frame(rows) {
  return zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8"));
}

function sessionRow(overrides = {}) {
  return {
    type: "session",
    version: 4,
    id: SESSION_ID,
    cwd: "E:\\fixture\\full-generation",
    createdAt: T0,
    delegationDepth: 0,
    agentPreset: "standard",
    ...overrides,
  };
}

function requestRow({
  seq = 1,
  time = T0,
  model = "deepseek-flash",
  provider = "deepseek-account",
  effort = "max",
} = {}) {
  return {
    type: "request/header",
    seq,
    time,
    data: {
      header: {
        config: {
          provider,
          model,
          reasoningEffort: effort,
          maxTokens: 64_000,
        },
      },
      reason: "turn-start",
    },
  };
}

function stepStartRow({ seq = 2, time = T0 + 100, turn = 1, step = 1 } = {}) {
  return { type: "step/start", seq, time, data: { turn, step } };
}

function stepEndRow({ seq = 5, time = T0 + 2_000, turn = 1, step = 1 } = {}) {
  return { type: "step/end", seq, time, data: { turn, step } };
}

function messageRow({
  seq = 4,
  time = T0 + 1_000,
  turn = 1,
  step = 1,
  outputTokens = 12,
  reasoningTokens,
  stream,
  includeUsage = true,
  source,
} = {}) {
  const usage = {
    inputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    totalTokens: 20 + outputTokens,
  };
  if (reasoningTokens !== undefined) {
    usage.reasoningTokens = reasoningTokens;
  }
  return {
    type: "assistant/message",
    seq,
    time,
    surfaceOp: "append",
    data: {
      turn,
      step,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DO-NOT-PROJECT" }],
        ...(source === undefined ? {} : { source }),
      },
      ...(includeUsage ? { usage } : {}),
      stream,
    },
  };
}

function textChunks(time0, texts, dt = [], index = 0) {
  return { type: "text-chunks", time0, index, dt, texts };
}

function reasoningChunks(time0, texts, dt = [], index = 0) {
  return { type: "reasoning-chunks", time0, index, dt, texts };
}

function toolChunks(time0, args, dt = [], { index = 0, id = "tool-id", name = "tool-name" } = {}) {
  return {
    type: "tool-call-chunks",
    time0,
    index,
    dt,
    id,
    ...(name === undefined ? {} : { name }),
    args,
  };
}

function usageChunk(time, outputTokens) {
  return {
    type: "chunk",
    time,
    chunk: { type: "usage", usage: { outputTokens } },
  };
}

function finishChunk(time, kind = "stop") {
  return {
    type: "chunk",
    time,
    chunk: {
      type: "finish",
      reason: { kind },
      replayState: { response: { kind, model: "deepseek-flash", version: 1 } },
    },
  };
}

function successfulStream(records, outputTokens, { finishKind = "stop", usageAt, finishAt } = {}) {
  const lastRecordTime =
    records.at(-1)?.time ??
    (records.at(-1)?.time0 === undefined
      ? T0
      : records.at(-1).time0 + records.at(-1).dt.reduce((sum, gap) => sum + gap, 0));
  const usageTime = usageAt ?? lastRecordTime + 10;
  const finishTime = finishAt ?? usageTime + 10;
  return [...records, usageChunk(usageTime, outputTokens), finishChunk(finishTime, finishKind)];
}

function writeLog(frames) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-all-generation-"));
  const file = path.join(dir, "session.v4.jsonl.zstd");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat(frames.map((rows) => (Buffer.isBuffer(rows) ? rows : frame(rows)))));
  return { dir, file };
}

async function readLog(file) {
  const samples = [];
  const warnings = [];
  const result = await streamDshPerfSamples(
    file,
    { id: HOME_ID, label: "DSH", path: "/fixture/.dsh" },
    (sample) => samples.push(sample),
    { onWarning: (warning) => warnings.push(warning) },
  );
  return { samples, warnings, result };
}

async function readLogWithRaw(file) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-all-generation-raw-"));
  try {
    const original = readFileSync(READER_FILE, "utf8");
    const callPattern = /normalizePerfSample\((\w+)\)/g;
    assert.ok(callPattern.test(original), "reader must retain a capturable normalizePerfSample call");
    const spySource = [
      `import { normalizePerfSample as __real } from ${JSON.stringify(
        pathToFileURL(path.join(REPO_ROOT, "src", "perf-stats.js")).href,
      )};`,
      "export const __captured = [];",
      "function __spyNormalize(raw) { __captured.push(raw); return __real(raw); }",
      "",
    ].join("\n");
    const readerDirUrl = pathToFileURL(path.join(REPO_ROOT, "src", "perf-sources") + path.sep).href;
    const absolutized = original.replace(
      /from\s+"(\.[^"]*)"/g,
      (_match, relative) => `from ${JSON.stringify(new URL(relative, readerDirUrl).href)}`,
    );
    const patched = absolutized.replace(callPattern, "__spyNormalize($1)");
    const readerCopy = path.join(dir, "dsh-spy.mjs");
    writeFileSync(readerCopy, spySource + patched, "utf8");
    const mod = await import(pathToFileURL(readerCopy).href);
    const samples = [];
    const warnings = [];
    const result = await mod.streamDshPerfSamples(
      file,
      { id: HOME_ID, label: "DSH", path: "/fixture/.dsh" },
      (sample) => samples.push(sample),
      { onWarning: (warning) => warnings.push(warning) },
    );
    return { samples, warnings, result, rawSamples: mod.__captured };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sampleKeyOf(turn, step) {
  return JSON.stringify(["dsh", HOME_ID, SESSION_ID, turn, step]);
}

function byKey(samples) {
  return new Map(samples.map((sample) => [sample.sampleKey, sample]));
}

function flagsOf(sample) {
  return perfFlagNamesOf(sample.sampleFlags);
}

test("official providers use all_generated_output with N-1 and one full reasoning/text/tool window", async () => {
  const accountStream = successfulStream(
    [
      reasoningChunks(T0 + 1_100, ["reason"], []),
      textChunks(T0 + 1_150, ["", "answer"], [0]),
      toolChunks(T0 + 1_200, ["", "{}"], [0], { index: 2 }),
    ],
    12,
  );
  const officialStream = successfulStream(
    [reasoningChunks(T0 + 2_100, ["reason"], []), toolChunks(T0 + 2_160, ["{", "}"], [0], { index: 1 })],
    8,
    { finishKind: "tool-calls" },
  );
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 1, time: T0 + 100, provider: "deepseek-account" }),
      stepStartRow({ seq: 2, time: T0 + 500, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 1_300, turn: 1, step: 1, outputTokens: 12, stream: accountStream }),
      stepEndRow({ seq: 4, time: T0 + 1_400, turn: 1, step: 1 }),
    ],
    [
      requestRow({ seq: 5, time: T0 + 1_500, provider: "deepseek-official" }),
      stepStartRow({ seq: 6, time: T0 + 1_600, turn: 2, step: 1 }),
      messageRow({ seq: 7, time: T0 + 2_300, turn: 2, step: 1, outputTokens: 8, stream: officialStream }),
      stepEndRow({ seq: 8, time: T0 + 2_400, turn: 2, step: 1 }),
    ],
  ]);
  try {
    const { samples, warnings } = await readLog(file);
    assert.deepEqual(warnings, []);
    assert.equal(samples.length, 2);
    const samplesByKey = byKey(samples);

    const account = samplesByKey.get(sampleKeyOf(1, 1));
    assert.equal(account.modelProvider, "deepseek-account");
    assert.equal(account.reasoningEffort, "max");
    assert.equal(account.methodVersion, PERF_METHOD_VERSION);
    assert.equal(account.tokenScope, "all_generated_output");
    assert.equal(account.outputTokens, 11);
    assert.equal(account.durationMs, 100);
    assert.equal(account.windowStartMs, T0 + 1_100);
    assert.equal(account.windowEndMs, T0 + 1_200);
    assert.equal(account.timingSource, "explicit");

    const official = samplesByKey.get(sampleKeyOf(2, 1));
    assert.equal(official.modelProvider, "deepseek-official");
    assert.equal(official.tokenScope, "all_generated_output");
    assert.equal(official.outputTokens, 7);
    assert.equal(official.durationMs, 60);
    assert.equal(official.windowStartMs, T0 + 2_100);
    assert.equal(official.windowEndMs, T0 + 2_160);
    assert.equal(official.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a completed message stream samples without step/end or tool completion", async () => {
  const records = [reasoningChunks(T0 + 1_100, ["reason"], []), textChunks(T0 + 1_150, ["answer"], [])];
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 1, time: T0 + 100, provider: "deepseek-account" }),
      stepStartRow({ seq: 2, time: T0 + 500, turn: 1, step: 1 }),
      messageRow({
        seq: 3,
        time: T0 + 1_300,
        turn: 1,
        step: 1,
        outputTokens: 10,
        stream: successfulStream(records, 10, { finishKind: "tool-calls" }),
        source: { provider: "deepseek-account", model: "deepseek-flash" },
      }),
      { type: "tool/call", seq: 4, time: T0 + 1_350, data: { turn: 1, step: 1 } },
      stepStartRow({ seq: 5, time: T0 + 1_500, turn: 2, step: 1 }),
      messageRow({
        seq: 6,
        time: T0 + 2_300,
        turn: 2,
        step: 1,
        outputTokens: 8,
        stream: successfulStream(records, 8),
        source: { provider: "deepseek-official", model: "deepseek-flash" },
      }),
      { type: "tool/result", seq: 7, time: T0 + 2_350, data: { turn: 2, step: 1 } },
    ],
  ]);
  try {
    const { samples, warnings } = await readLog(file);
    assert.deepEqual(warnings, []);
    assert.equal(samples.length, 2, "two completed model responses remain independently sampleable");
    const samplesByKey = byKey(samples);
    const account = samplesByKey.get(sampleKeyOf(1, 1));
    assert.equal(account.status, "completed", "stream finish completes the model response without step/end");
    assert.equal(account.outputTokens, 9);
    assert.equal(account.durationMs, 50);
    assert.equal(account.modelEvidence, "message_source");

    const official = samplesByKey.get(sampleKeyOf(2, 1));
    assert.equal(official.status, "completed");
    assert.equal(official.modelProvider, "deepseek-official");
    assert.equal(
      official.reasoningEffort,
      "max",
      "latest header effort remains the fixed scope across a headerless turn",
    );
    assert.equal(official.outputTokens, 7);
    assert.equal(official.durationMs, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("future explicit reasoning detail cannot switch an official provider to another scope or duplicate it", async () => {
  const stream = successfulStream(
    [reasoningChunks(T0 + 1_100, ["reason"], []), textChunks(T0 + 1_150, ["answer"], [])],
    10,
  );
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ provider: "deepseek-account" }),
      stepStartRow({ seq: 2, time: T0 + 500 }),
      messageRow({ outputTokens: 10, reasoningTokens: 4, stream }),
      stepEndRow({ seq: 5, time: T0 + 1_300 }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    assert.equal(samples.length, 1, "one response must produce one sample");
    assert.equal(samples[0].tokenScope, "all_generated_output");
    assert.equal(samples[0].outputTokens, 9, "official N stays total output minus B=1");
    assert.equal(samples[0].durationMs, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-official providers keep the explicit non-reasoning path and never guess total output", async () => {
  const knownStream = successfulStream(
    [
      reasoningChunks(T0 + 1_100, ["reason"], []),
      textChunks(T0 + 1_150, ["answer"], []),
      toolChunks(T0 + 1_200, ["{}"], []),
    ],
    12,
  );
  const missingStream = successfulStream(
    [reasoningChunks(T0 + 2_100, ["reason"], []), textChunks(T0 + 2_200, ["answer", "more"], [100])],
    9,
  );
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ provider: "third-party" }),
      stepStartRow({ seq: 2, time: T0 + 500, turn: 1, step: 1 }),
      messageRow({
        seq: 3,
        time: T0 + 1_300,
        turn: 1,
        step: 1,
        outputTokens: 12,
        reasoningTokens: 4,
        stream: knownStream,
      }),
      stepEndRow({ seq: 4, time: T0 + 1_400, turn: 1, step: 1 }),
    ],
    [
      stepStartRow({ seq: 5, time: T0 + 1_500, turn: 1, step: 2 }),
      messageRow({
        seq: 6,
        time: T0 + 2_300,
        turn: 1,
        step: 2,
        outputTokens: 9,
        stream: missingStream,
      }),
      stepEndRow({ seq: 7, time: T0 + 2_400, turn: 1, step: 2 }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    const samplesByKey = byKey(samples);
    const known = samplesByKey.get(sampleKeyOf(1, 1));
    assert.equal(known.tokenScope, "non_reasoning_output");
    assert.equal(known.outputTokens, 7, "known split: 12-4-1");
    assert.equal(known.durationMs, 50, "known split uses the text/tool non-reasoning window");

    const missing = samplesByKey.get(sampleKeyOf(1, 2));
    assert.equal(missing.tokenScope, "non_reasoning_output");
    assert.equal(missing.outputTokens, null, "missing reasoning detail is not replaced by total output");
    assert.equal(missing.durationMs, 100);
    assert.ok(flagsOf(missing).includes("MISSING_OUTPUT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("official success requires one parity usage and a successful final finish", () => {
  const records = [reasoningChunks(T0 + 1_100, ["reason"], []), textChunks(T0 + 1_150, ["answer"], [])];
  const success = inspectDshAssistantGeneration({
    usage: { outputTokens: 10 },
    stream: successfulStream(records, 10),
  });
  assert.equal(success.streamValid, true);
  assert.equal(success.successful, true);
  assert.equal(success.usageParity, true);
  assert.equal(success.allGenerationSampleOutputTokens, 9);
  assert.equal(success.allGenerationDurationMs, 50);

  const mismatch = inspectDshAssistantGeneration({
    usage: { outputTokens: 10 },
    stream: successfulStream(records, 11),
  });
  assert.equal(mismatch.reportedOutputTokens, 10, "final usage remains available as a diagnostic");
  assert.equal(mismatch.streamOutputTokens, 11);
  assert.equal(mismatch.usageParity, false);
  assert.equal(mismatch.successful, false);
  assert.equal(mismatch.allGenerationSampleOutputTokens, null);

  const failedFinish = inspectDshAssistantGeneration({
    usage: { outputTokens: 10 },
    stream: successfulStream(records, 10, { finishKind: "error" }),
  });
  assert.equal(failedFinish.finishKind, "error");
  assert.equal(failedFinish.successful, false);
  assert.equal(failedFinish.allGenerationDurationMs, null);

  const duplicateUsage = inspectDshAssistantGeneration({
    usage: { outputTokens: 10 },
    stream: [...records, usageChunk(T0 + 1_200, 10), usageChunk(T0 + 1_210, 10), finishChunk(T0 + 1_220)],
  });
  assert.equal(duplicateUsage.usageChunks, 2);
  assert.equal(duplicateUsage.successful, false);
});

test("normalized official candidates preserve usage diagnostics but omit N/D on mismatch or missing usage", async () => {
  const records = [reasoningChunks(T0 + 1_100, ["reason"], []), textChunks(T0 + 1_150, ["answer"], [])];
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 1, time: T0 + 100, provider: "deepseek-account" }),
      stepStartRow({ seq: 2, time: T0 + 500, turn: 1, step: 1 }),
      messageRow({
        seq: 3,
        time: T0 + 1_300,
        turn: 1,
        step: 1,
        outputTokens: 10,
        stream: successfulStream(records, 11),
      }),
      stepEndRow({ seq: 4, time: T0 + 1_400, turn: 1, step: 1 }),
      stepStartRow({ seq: 5, time: T0 + 1_500, turn: 1, step: 2 }),
      messageRow({
        seq: 6,
        time: T0 + 2_300,
        turn: 1,
        step: 2,
        stream: successfulStream(records, 10),
        includeUsage: false,
      }),
      stepEndRow({ seq: 7, time: T0 + 2_400, turn: 1, step: 2 }),
      stepStartRow({ seq: 8, time: T0 + 2_500, turn: 1, step: 3 }),
      messageRow({
        seq: 9,
        time: T0 + 3_300,
        turn: 1,
        step: 3,
        outputTokens: 6,
        stream: successfulStream(records, 6, { finishKind: "max-tokens" }),
      }),
      stepEndRow({ seq: 10, time: T0 + 3_400, turn: 1, step: 3 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    assert.equal(samples.length, 3);
    const samplesByKey = byKey(samples);
    const rawByKey = new Map(rawSamples.map((raw) => [JSON.stringify(raw.identity), raw]));

    const mismatch = samplesByKey.get(sampleKeyOf(1, 1));
    assert.equal(mismatch.tokenScope, "all_generated_output");
    assert.equal(mismatch.outputTokens, null);
    assert.equal(mismatch.durationMs, null);
    assert.equal(mismatch.status, "completed");
    assert.ok(flagsOf(mismatch).includes("MISSING_OUTPUT"));
    assert.ok(flagsOf(mismatch).includes("MISSING_DURATION"));
    const mismatchRaw = rawByKey.get(JSON.stringify([SESSION_ID, 1, 1]));
    assert.equal(mismatchRaw.reportedOutputTokens, 10);
    assert.equal(mismatchRaw.reportedStreamOutputTokens, 11);
    assert.equal(mismatchRaw.usageParity, false);
    assert.equal(mismatchRaw.generationState, "incomplete_success");

    const missing = samplesByKey.get(sampleKeyOf(1, 2));
    assert.equal(missing.outputTokens, null);
    assert.equal(missing.durationMs, null);
    assert.equal(missing.status, "completed");
    const missingRaw = rawByKey.get(JSON.stringify([SESSION_ID, 1, 2]));
    assert.equal(missingRaw.reportedOutputTokens, undefined);
    assert.equal(missingRaw.reportedStreamOutputTokens, 10);
    assert.equal(missingRaw.usageParity, false);

    const maxTokens = samplesByKey.get(sampleKeyOf(1, 3));
    assert.equal(maxTokens.outputTokens, 5);
    assert.equal(maxTokens.durationMs, 50);
    assert.equal(maxTokens.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown chunks and server-tool block kinds invalidate the whole stream", () => {
  for (const stream of [
    [
      textChunks(T0 + 1_100, ["a", "b"], [10]),
      { type: "chunk", time: T0 + 1_120, chunk: { type: "future-output-delta", text: "?" } },
      usageChunk(T0 + 1_130, 4),
      finishChunk(T0 + 1_140),
    ],
    [
      {
        type: "chunk",
        time: T0 + 1_100,
        chunk: { type: "block-start", index: 0, blockType: "server-tool-use" },
      },
      textChunks(T0 + 1_110, ["a", "b"], [10]),
      usageChunk(T0 + 1_130, 4),
      finishChunk(T0 + 1_140),
    ],
    [
      {
        type: "chunk",
        time: T0 + 1_100,
        chunk: { type: "block-end", block: { type: "server-tool-use" } },
      },
      textChunks(T0 + 1_110, ["a", "b"], [10]),
      usageChunk(T0 + 1_130, 4),
      finishChunk(T0 + 1_140),
    ],
  ]) {
    const generation = inspectDshAssistantGeneration({
      usage: { outputTokens: 4 },
      stream,
    });
    assert.equal(generation.streamValid, false);
    assert.equal(generation.successful, false);
    assert.equal(generation.allGenerationDurationMs, null);
    assert.equal(generation.reportedOutputTokens, 4);
  }
});

test("every packed member and ordinary chunk participates in monotonic safe-integer time", () => {
  const cases = [
    [textChunks(T0 + 1_100, ["a", "b", "c"], [-10, 20]), usageChunk(T0 + 1_130, 4), finishChunk(T0 + 1_140)],
    [
      textChunks(T0 + 1_100, ["a", "b"], [10]),
      textChunks(T0 + 1_090, ["c", "d"], [20], 1),
      usageChunk(T0 + 1_130, 4),
      finishChunk(T0 + 1_140),
    ],
    [
      textChunks(T0 + 1_100, ["a"], []),
      textChunks(T0 + 1_090, [""], [], 1),
      usageChunk(T0 + 1_130, 4),
      finishChunk(T0 + 1_140),
    ],
    [textChunks(T0 + 1_100, ["a", "b"], [10]), usageChunk(T0 + 1_090, 4), finishChunk(T0 + 1_140)],
    [textChunks(T0 + 1_100, ["a", "b"], [10]), usageChunk(T0 + 1_130, 4), finishChunk(T0 + 1_120)],
    [textChunks(Number.MAX_SAFE_INTEGER, ["a", "b"], [1]), usageChunk(T0 + 1_130, 4), finishChunk(T0 + 1_140)],
  ];
  for (const stream of cases) {
    const generation = inspectDshAssistantGeneration({
      usage: { outputTokens: 4 },
      stream,
    });
    assert.equal(generation.streamValid, false);
    assert.equal(generation.successful, false);
    assert.equal(generation.allGenerationDurationMs, null);
    assert.equal(generation.reportedOutputTokens, 4);
  }
});

test("tool metadata is not a boundary, whitespace is real output, and one delta cannot form D", () => {
  const metadata = inspectDshAssistantGeneration({
    usage: { outputTokens: 6 },
    stream: successfulStream(
      [
        {
          type: "chunk",
          time: T0 + 1_090,
          chunk: { type: "block-start", index: 0, blockType: "tool-call" },
        },
        toolChunks(T0 + 1_100, ["", "{}", " "], [50, 20], {
          id: "metadata-id",
          name: "metadata-name",
        }),
      ],
      6,
    ),
  });
  assert.equal(metadata.allGenerationWindowStartMs, T0 + 1_150);
  assert.equal(metadata.allGenerationWindowEndMs, T0 + 1_170);
  assert.equal(metadata.allGenerationDurationMs, 20);

  const oneDelta = inspectDshAssistantGeneration({
    usage: { outputTokens: 4 },
    stream: successfulStream([textChunks(T0 + 1_100, ["a"], [])], 4),
  });
  assert.equal(oneDelta.successful, true);
  assert.equal(oneDelta.allGenerationTimingState, "window_nonpositive");
  assert.equal(oneDelta.allGenerationDurationMs, null);
});

test("conflicting messages or effort scopes retain usage diagnostics but disable N and D", async () => {
  const firstStream = successfulStream(
    [reasoningChunks(T0 + 1_100, ["one"], []), textChunks(T0 + 1_150, ["a"], [])],
    10,
  );
  const secondStream = successfulStream(
    [reasoningChunks(T0 + 1_200, ["two"], []), textChunks(T0 + 1_260, ["b"], [])],
    11,
  );
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 1, time: T0 + 100, provider: "deepseek-account", effort: "max" }),
      stepStartRow({ seq: 2, time: T0 + 500, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 1_300, turn: 1, step: 1, outputTokens: 10, stream: firstStream }),
      messageRow({ seq: 4, time: T0 + 1_400, turn: 1, step: 1, outputTokens: 11, stream: secondStream }),
      stepEndRow({ seq: 5, time: T0 + 1_500, turn: 1, step: 1 }),
    ],
    [
      requestRow({ seq: 6, time: T0 + 1_600, provider: "deepseek-official", effort: "max" }),
      stepStartRow({ seq: 7, time: T0 + 1_700, turn: 2, step: 1 }),
      requestRow({ seq: 8, time: T0 + 1_800, provider: "deepseek-official", effort: "high" }),
      messageRow({
        seq: 9,
        time: T0 + 2_300,
        turn: 2,
        step: 1,
        outputTokens: 8,
        stream: successfulStream([reasoningChunks(T0 + 2_100, ["r"], []), textChunks(T0 + 2_150, ["a"], [])], 8),
      }),
      stepEndRow({ seq: 10, time: T0 + 2_400, turn: 2, step: 1 }),
    ],
    [
      requestRow({ seq: 11, time: T0 + 2_500, provider: "deepseek-account", effort: "max" }),
      stepStartRow({ seq: 12, time: T0 + 2_600, turn: 3, step: 1 }),
      messageRow({
        seq: 13,
        time: T0 + 3_300,
        turn: 3,
        step: 1,
        outputTokens: 8,
        stream: successfulStream([reasoningChunks(T0 + 3_100, ["r"], []), textChunks(T0 + 3_150, ["a"], [])], 8),
        source: { provider: "deepseek-official", model: "deepseek-flash" },
      }),
      stepEndRow({ seq: 14, time: T0 + 3_400, turn: 3, step: 1 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    const samplesByKey = byKey(samples);
    const duplicate = samplesByKey.get(sampleKeyOf(1, 1));
    assert.equal(duplicate.outputTokens, null);
    assert.equal(duplicate.durationMs, null);
    assert.ok(flagsOf(duplicate).includes("RECORD_CONFLICT"));

    const effortConflict = samplesByKey.get(sampleKeyOf(2, 1));
    assert.equal(effortConflict.outputTokens, null);
    assert.equal(effortConflict.durationMs, null);
    assert.ok(flagsOf(effortConflict).includes("RECORD_CONFLICT"));

    const sourceConflict = samplesByKey.get(sampleKeyOf(3, 1));
    assert.equal(sourceConflict.outputTokens, null);
    assert.equal(sourceConflict.durationMs, null);
    assert.ok(flagsOf(sourceConflict).includes("MODEL_AMBIGUOUS"));

    assert.equal(
      rawSamples.some((raw) => raw.reportedOutputTokens === 10),
      true,
    );
    assert.equal(
      rawSamples.some((raw) => raw.reportedOutputTokens === 8),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
