import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodexResponseCandidates } from "../src/perf-sources/codex-candidates.js";
import { foldCodexRolloutMetadata } from "../src/perf-sources/codex-fold.js";
import { readCodexRolloutMetadata } from "../src/perf-sources/codex-jsonl.js";
import { CODEX_PROJECTION_METHOD_VERSION } from "../src/perf-sources/codex-thread.js";
import { OUTPUT_TIME_RESOLUTION_MS } from "../src/perf-output-tokens.js";
import { PERF_METHOD_VERSION, PERF_TOKEN_SCOPE, normalizePerfSample, summarizePerf } from "../src/perf-stats.js";

const DATE = "2026-10-30T02:00:00.000Z";
const TOKENIZER = "o200k_base";
const headers = [
  { type: "session_meta", payload: { id: "thread", source: "cli" } },
  { type: "turn_context", payload: { thread_id: "thread", turn_id: "turn", model: "model-a", effort: "high" } },
];

const schema5 = {
  schema_version: 5,
  tokenizer: TOKENIZER,
  clock: "transport_receive",
  output_tokens: 200,
  observed_duration_ms: 200,
  windows: [
    { start_ms: 1_000, end_ms: 1_100, output_tokens: 50 },
    { start_ms: 1_050, end_ms: 1_200, output_tokens: 150 },
  ],
};

function row(responseId, generation, usage = {}) {
  return {
    type: "token_usage_record",
    timestamp: DATE,
    payload: {
      thread_id: "thread",
      turn_id: "turn",
      response_id: responseId,
      usage: { output_tokens: 3, ...usage },
      ...(generation === undefined ? {} : { generation_timing: generation }),
    },
  };
}

const lines = (rows) => `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`;

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-output-timing-"));
  const file = path.join(root, "sessions", "rollout.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await run(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readCandidates(file, options = {}) {
  const projection = await readCodexRolloutMetadata(file);
  const folded = foldCodexRolloutMetadata("home", [projection]);
  const built = buildCodexResponseCandidates("home", folded, [file], options);
  return { projection, candidates: built.candidates };
}

test("schema5 maps 100ms transport windows while schema4 cannot become a current measurement", async () => {
  await fixture(async (file) => {
    await writeFile(
      file,
      lines([
        ...headers,
        row("native", { ...schema5, body: "BODY_MUST_NOT_LEAK" }),
        row("missing", undefined),
        row("schema1", { ...schema5, schema_version: 1 }),
        row("schema2", { ...schema5, schema_version: 2 }),
        row("schema3", { ...schema5, schema_version: 3 }),
        row("schema4", { ...schema5, schema_version: 4 }),
      ]),
    );

    const { projection, candidates } = await readCandidates(file);
    assert.equal(CODEX_PROJECTION_METHOD_VERSION, "codex-projection-v9");
    assert.equal(JSON.stringify(projection).includes("BODY_MUST_NOT_LEAK"), false);
    assert.equal(JSON.stringify(candidates).includes("BODY_MUST_NOT_LEAK"), false);

    const native = candidates.find((candidate) => candidate.responseId === "native");
    assert.equal(native.methodVersion, PERF_METHOD_VERSION);
    assert.equal(native.tokenScope, PERF_TOKEN_SCOPE);
    assert.equal(native.outputTokens, 200);
    assert.equal(native.durationMs, 200);
    assert.equal(native.reportedOutputTokens, 3);
    assert.equal(native.reasoningOutputTokens, null);
    assert.equal(native.reasoningOutputTokensKnown, false);
    assert.equal(OUTPUT_TIME_RESOLUTION_MS, 100);
    assert.equal(native.generation.samplingWindowMs, OUTPUT_TIME_RESOLUTION_MS);
    assert.deepEqual(native.generation.windows, [
      { startMs: 1_000, endMs: 1_100, outputTokens: 50 },
      { startMs: 1_050, endMs: 1_200, outputTokens: 150 },
    ]);

    const normalized = normalizePerfSample({ ...native, sourcePath: file }).sample;
    assert.notEqual(normalized, null);
    assert.equal(normalized.outputTokens, 200);
    assert.equal(normalized.durationMs, 200);
    const summary = summarizePerf([normalized]);
    assert.equal(summary.groups.length, 1);
    assert.equal(summary.groups[0].sums.outputTokens, 200);
    assert.equal(summary.groups[0].sums.durationMs, 200);

    for (const responseId of ["missing", "schema1", "schema2", "schema3", "schema4"]) {
      const candidate = candidates.find((value) => value.responseId === responseId);
      assert.equal(candidate.outputTokens, null, responseId);
      assert.equal(candidate.durationMs, null, responseId);
      assert.equal(candidate.generation, null, responseId);
      assert.equal(candidate.methodVersion, PERF_METHOD_VERSION, responseId);
    }
  });
});

test("legacy explicit timing remains readable but is not promoted to the current measurement", async () => {
  await fixture(async (file) => {
    await writeFile(file, lines([...headers, row("explicit", undefined)]));
    const legacy = {
      outputTokens: 2,
      durationMs: 1_000,
      startOutputTokens: 0,
      timingKind: "explicit",
    };
    const { candidates } = await readCandidates(file, {
      lookupRequestTiming: () => ({
        state: "available",
        requestedModel: "model-a",
        reportedOutputTokens: 3,
        durationMs: 2_000,
        generation: legacy,
      }),
    });
    const candidate = candidates[0];

    assert.deepEqual(candidate.legacyGeneration, legacy);
    assert.equal(candidate.generation, null);
    assert.equal(candidate.outputTokens, null);
    assert.equal(candidate.durationMs, null);
    assert.equal(candidate.reportedOutputTokens, 3);
    assert.equal(candidate.reportedDurationMs, 2_000);
    assert.equal(candidate.methodVersion, PERF_METHOD_VERSION);

    const normalized = normalizePerfSample({ ...candidate, sourcePath: file }).sample;
    assert.notEqual(normalized, null);
    assert.equal(normalized.outputTokens, null);
    assert.equal(normalized.durationMs, null);
    assert.equal(summarizePerf([normalized]).groups.length, 0);
  });
});

test("conflicting historical billing timing cannot invalidate a native reference-token measurement", async () => {
  await fixture(async (file) => {
    await writeFile(file, lines([...headers, row("native", schema5)]));
    for (const state of ["conflict", "invalid"]) {
      const { candidates } = await readCandidates(file, {
        lookupRequestTiming: () => ({ state, durationMs: null, reportedOutputTokens: null, requestedModel: "" }),
      });
      const normalized = normalizePerfSample({ ...candidates[0], sourcePath: file }).sample;
      const summary = summarizePerf([normalized]);
      assert.equal(summary.models[0].n, 1);
      assert.equal(summary.models[0].averageTps, 1000);
    }
  });
});
