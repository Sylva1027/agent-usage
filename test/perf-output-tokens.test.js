import assert from "node:assert/strict";
import test from "node:test";

import { get_encoding } from "tiktoken";

import { measureOutputWindows, normalizeMeasuredOutput, OUTPUT_TIME_RESOLUTION_MS } from "../src/perf-output-tokens.js";

const TOKENIZER = "o200k_base";

function encodedTokenCount(text) {
  const encoder = get_encoding(TOKENIZER);
  try {
    return encoder.encode_ordinary(text).length;
  } finally {
    encoder.free();
  }
}

test("real encoder counts 200 completed tokens after the 900-token first batch", () => {
  const text = "中".repeat(1100);
  const encoder = get_encoding(TOKENIZER);
  try {
    assert.equal(encoder.encode_ordinary(text).length, 1100);
  } finally {
    encoder.free();
  }

  const firstBatchEndBytes = Buffer.byteLength("中".repeat(900));
  const measured = measureOutputWindows([
    {
      text,
      windows: [
        {
          startBytes: firstBatchEndBytes,
          endBytes: Buffer.byteLength(text),
          startMs: 1_000,
          endMs: 1_200,
        },
      ],
    },
  ]);

  assert.deepEqual(measured, {
    tokenizer: TOKENIZER,
    outputTokens: 200,
    durationMs: 200,
    windows: [{ startMs: 1_000, endMs: 1_200, outputTokens: 200 }],
  });
});

test("UTF-8 token ends are counted across transport chunk and window boundaries", () => {
  const measured = measureOutputWindows([
    {
      text: "中😀尾",
      windows: [
        { startBytes: 0, endBytes: 2, startMs: 10, endMs: 20 },
        { startBytes: 2, endBytes: 6, startMs: 20, endMs: 30 },
        { startBytes: 6, endBytes: 7, startMs: 30, endMs: 40 },
      ],
    },
  ]);

  assert.deepEqual(measured, {
    tokenizer: TOKENIZER,
    outputTokens: 2,
    durationMs: 20,
    windows: [
      { startMs: 20, endMs: 30, outputTokens: 1 },
      { startMs: 30, endMs: 40, outputTokens: 1 },
    ],
  });
});

test("lanes stay separate while overlapping windows contribute their time union", () => {
  const lanes = ["a", "b", "c"].map((text, index) => ({
    text,
    windows: [
      {
        startBytes: 0,
        endBytes: 1,
        startMs: [100, 300, 1_000][index],
        endMs: [500, 800, 1_100][index],
      },
    ],
  }));

  assert.equal(encodedTokenCount("ab"), 1, "concatenating these lanes would change the token count");
  assert.deepEqual(measureOutputWindows(lanes), {
    tokenizer: TOKENIZER,
    outputTokens: 3,
    durationMs: 800,
    windows: [
      { startMs: 100, endMs: 500, outputTokens: 1 },
      { startMs: 300, endMs: 800, outputTokens: 1 },
      { startMs: 1_000, endMs: 1_100, outputTokens: 1 },
    ],
  });
});

test("tool names outside lane text are not counted", () => {
  const text = '{"query":"synthetic"}';
  assert.deepEqual(
    measureOutputWindows([
      {
        name: "lookup_weather",
        text,
        windows: [{ startBytes: 0, endBytes: Buffer.byteLength(text), startMs: 10, endMs: 20 }],
      },
    ]),
    {
      tokenizer: TOKENIZER,
      outputTokens: encodedTokenCount(text),
      durationMs: 10,
      windows: [{ startMs: 10, endMs: 20, outputTokens: encodedTokenCount(text) }],
    },
  );
});

test("invalid byte contracts return null", () => {
  const base = { text: "abcd", windows: [{ startBytes: 0, endBytes: 4, startMs: 10, endMs: 20 }] };
  const invalidWindows = [
    [
      { startBytes: 0, endBytes: 2, startMs: 10, endMs: 20 },
      { startBytes: 0, endBytes: 2, startMs: 20, endMs: 30 },
    ],
    [
      { startBytes: 2, endBytes: 4, startMs: 10, endMs: 20 },
      { startBytes: 0, endBytes: 2, startMs: 20, endMs: 30 },
    ],
    [{ startBytes: 3, endBytes: 2, startMs: 10, endMs: 20 }],
    [{ startBytes: -1, endBytes: 2, startMs: 10, endMs: 20 }],
    [{ startBytes: 0, endBytes: 5, startMs: 10, endMs: 20 }],
    [{ startBytes: 0, endBytes: 4, startMs: 20, endMs: 10 }],
    [{ startBytes: 0, endBytes: 4, startMs: Number.MAX_SAFE_INTEGER + 1, endMs: 20 }],
  ];

  for (const windows of invalidWindows) {
    assert.equal(measureOutputWindows([{ ...base, windows }]), null);
  }
  assert.equal(measureOutputWindows(null), null);
  assert.equal(measureOutputWindows([{ text: "abcd", windows: null }]), null);
});

test("lane windows reject time regression or overlap after ordered byte windows", () => {
  const text = "abcd";
  assert.equal(
    measureOutputWindows([
      {
        text,
        windows: [
          { startBytes: 0, endBytes: 2, startMs: 10, endMs: 20 },
          { startBytes: 2, endBytes: 4, startMs: 10, endMs: 30 },
        ],
      },
    ]),
    null,
  );
});

test("empty content, single-batch timing, and zero-token windows produce no measurement", () => {
  assert.equal(measureOutputWindows([]), null);
  assert.equal(measureOutputWindows([{ text: "", windows: [] }]), null);
  assert.equal(
    measureOutputWindows([{ text: "", windows: [{ startBytes: 0, endBytes: 0, startMs: 10, endMs: 20 }] }]),
    null,
  );
  assert.equal(
    measureOutputWindows([{ text: "a", windows: [{ startBytes: 0, endBytes: 1, startMs: 10, endMs: 10 }] }]),
    null,
  );
  assert.equal(
    measureOutputWindows([{ text: "a", windows: [{ startBytes: 0, endBytes: 0, startMs: 10, endMs: 20 }] }]),
    null,
  );
});

test("normalizeMeasuredOutput validates scalar totals and recomputes the duration union", () => {
  const raw = {
    tokenizer: TOKENIZER,
    outputTokens: 3,
    durationMs: 700,
    windows: [
      { startMs: 100, endMs: 500, outputTokens: 1, text: "must be stripped" },
      { startMs: 300, endMs: 800, outputTokens: 2 },
    ],
  };

  assert.deepEqual(normalizeMeasuredOutput(raw), {
    tokenizer: TOKENIZER,
    outputTokens: 3,
    durationMs: 700,
    windows: [
      { startMs: 100, endMs: 500, outputTokens: 1 },
      { startMs: 300, endMs: 800, outputTokens: 2 },
    ],
  });
  assert.equal(normalizeMeasuredOutput({ ...raw, outputTokens: 2 }), null);
  assert.equal(normalizeMeasuredOutput({ ...raw, durationMs: 800 }), null);
  assert.equal(normalizeMeasuredOutput({ ...raw, tokenizer: "other" }), null);
  assert.equal(
    normalizeMeasuredOutput({
      ...raw,
      windows: [{ startMs: 100, endMs: 100, outputTokens: 3 }],
      durationMs: 0,
    }),
    null,
  );
});

test("normalizeMeasuredOutput preserves the optional 100ms sampling contract", () => {
  const raw = {
    tokenizer: TOKENIZER,
    outputTokens: 2,
    durationMs: 200,
    samplingWindowMs: OUTPUT_TIME_RESOLUTION_MS,
    windows: [
      { startMs: 0, endMs: 100, outputTokens: 1 },
      { startMs: 100, endMs: 200, outputTokens: 1 },
    ],
  };

  assert.equal(OUTPUT_TIME_RESOLUTION_MS, 100);
  assert.deepEqual(normalizeMeasuredOutput(raw), {
    tokenizer: TOKENIZER,
    outputTokens: 2,
    durationMs: 200,
    windows: [
      { startMs: 0, endMs: 100, outputTokens: 1 },
      { startMs: 100, endMs: 200, outputTokens: 1 },
    ],
    samplingWindowMs: 100,
  });
  assert.equal(normalizeMeasuredOutput({ ...raw, samplingWindowMs: 99 }), null);
  assert.equal(normalizeMeasuredOutput({ ...raw, samplingWindowMs: 101 }), null);
  assert.equal(
    normalizeMeasuredOutput({
      ...raw,
      durationMs: 199,
      windows: [
        { startMs: 0, endMs: 99, outputTokens: 1 },
        { startMs: 99, endMs: 200, outputTokens: 1 },
      ],
    }),
    null,
  );
});
