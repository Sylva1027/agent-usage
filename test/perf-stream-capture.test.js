import assert from "node:assert/strict";
import test from "node:test";

import { createOutputStreamCapture } from "../src/perf-stream-capture.js";

const encoder = new TextEncoder();

function sseEvent(payload, eventName = null, lineEnding = "\n") {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  const eventLine = eventName === null ? "" : `event: ${eventName}${lineEnding}`;
  return `${eventLine}data: ${data}${lineEnding}${lineEnding}`;
}

function responseMetadata(responseId = "resp-1", model = "model-1") {
  return {
    type: "response.created",
    response: { id: responseId, model },
  };
}

function responseCompleted(responseId = "resp-1", model = "model-1") {
  return {
    type: "response.completed",
    response: { id: responseId, model },
  };
}

function responseTextDelta(delta, itemId = "msg-1", outputIndex = 0, contentIndex = 0) {
  return {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    delta,
  };
}

test("a single raw batch with 1100 deltas establishes a boundary but produces no measurement", () => {
  const capture = createOutputStreamCapture();
  const events = [responseMetadata()];
  for (let index = 0; index < 1100; index += 1) events.push(responseTextDelta("中"));
  events.push(responseCompleted());

  capture.push(encoder.encode(events.map((event) => sseEvent(event)).join("")), {
    elapsedMs: 1_000,
    readId: 1,
  });

  const result = capture.finish();
  assert.deepEqual(result, {
    responseId: "resp-1",
    model: "model-1",
    measurement: null,
  });
  assert.equal(JSON.stringify(result).includes("中"), false);
});

test("the 100ms baseline excludes the first 900 tokens and measures the tail at actual arrival time", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(responseMetadata()) + Array.from({ length: 382 }, () => sseEvent(responseTextDelta("中"))).join(""),
    ),
    { elapsedMs: 0, readId: 1 },
  );
  capture.push(encoder.encode(Array.from({ length: 518 }, () => sseEvent(responseTextDelta("中"))).join("")), {
    elapsedMs: 9,
    readId: 2,
  });
  capture.push(
    encoder.encode(
      Array.from({ length: 200 }, () => sseEvent(responseTextDelta("中"))).join("") + sseEvent(responseCompleted()),
    ),
    { elapsedMs: 158, readId: 3 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 200,
      durationMs: 149,
      windows: [{ startMs: 9, endMs: 158, outputTokens: 200 }],
      samplingWindowMs: 100,
    },
  });
});

test("output confined to the first 100ms boundary produces no measurement", () => {
  const buffered = createOutputStreamCapture();
  buffered.push(
    encoder.encode(
      sseEvent(responseMetadata()) + Array.from({ length: 382 }, () => sseEvent(responseTextDelta("中"))).join(""),
    ),
    { elapsedMs: 0, readId: 1 },
  );
  buffered.push(
    encoder.encode(
      Array.from({ length: 718 }, () => sseEvent(responseTextDelta("中"))).join("") + sseEvent(responseCompleted()),
    ),
    { elapsedMs: 1, readId: 2 },
  );
  assert.deepEqual(buffered.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: null,
  });

  const boundary = createOutputStreamCapture();
  boundary.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 0,
    readId: 1,
  });
  boundary.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 99, readId: 2 });
  boundary.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 100, readId: 3 });
  boundary.push(encoder.encode(sseEvent(responseCompleted())), { elapsedMs: 100, readId: 3 });
  assert.deepEqual(boundary.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: null,
  });
});

test("an exact 100ms visible arrival belongs to the measured side", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 0,
    readId: 1,
  });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 99, readId: 2 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 100, readId: 3 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中")) + sseEvent(responseCompleted())), {
    elapsedMs: 200,
    readId: 4,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 101,
      windows: [{ startMs: 99, endMs: 200, outputTokens: 2 }],
      samplingWindowMs: 100,
    },
  });
});

test("a same-read extension remains in the baseline without synthesizing its start time", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 0,
    readId: 1,
  });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 95, readId: 2 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 105, readId: 2 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中"))), { elapsedMs: 210, readId: 3 });
  capture.push(encoder.encode(sseEvent(responseCompleted())), { elapsedMs: 220, readId: 3 });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 105,
      windows: [{ startMs: 105, endMs: 210, outputTokens: 1 }],
      samplingWindowMs: 100,
    },
  });
});

test("terminal-only bytes reusing the baseline or final visible read do not change the sample", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(responseMetadata()) + Array.from({ length: 900 }, () => sseEvent(responseTextDelta("中"))).join(""),
    ),
    { elapsedMs: 0, readId: 1 },
  );
  capture.push(encoder.encode(Array.from({ length: 200 }, () => sseEvent(responseTextDelta("中"))).join("")), {
    elapsedMs: 150,
    readId: 2,
  });
  capture.push(
    encoder.encode(
      sseEvent({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg-1", type: "message", status: "completed", role: "assistant", content: [] },
      }),
    ),
    { elapsedMs: 900, readId: 1 },
  );
  capture.push(encoder.encode(sseEvent(responseCompleted())), { elapsedMs: 900, readId: 2 });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 200,
      durationMs: 150,
      windows: [{ startMs: 0, endMs: 150, outputTokens: 200 }],
      samplingWindowMs: 100,
    },
  });
});

test("steady post-baseline output rates are unchanged at 10, 50, 100, 200, and 600 tokens per second", () => {
  const cases = [
    { rate: 10, intervalMs: 100, tokensPerTick: 1, startMs: 0, postTokens: 10 },
    { rate: 50, intervalMs: 20, tokensPerTick: 1, startMs: 80, postTokens: 46 },
    { rate: 100, intervalMs: 10, tokensPerTick: 1, startMs: 90, postTokens: 91 },
    { rate: 200, intervalMs: 5, tokensPerTick: 1, startMs: 95, postTokens: 181 },
    { rate: 600, intervalMs: 5, tokensPerTick: 3, startMs: 95, postTokens: 543 },
  ];

  for (const { rate, intervalMs, tokensPerTick, startMs, postTokens } of cases) {
    const capture = createOutputStreamCapture();
    let readId = 0;
    for (let elapsedMs = 0; elapsedMs <= 1_000; elapsedMs += intervalMs) {
      readId += 1;
      const delta = Array.from({ length: tokensPerTick }, () => sseEvent(responseTextDelta("中"))).join("");
      const prefix = elapsedMs === 0 ? sseEvent(responseMetadata()) : "";
      const suffix = elapsedMs === 1_000 ? sseEvent(responseCompleted()) : "";
      capture.push(encoder.encode(prefix + delta + suffix), { elapsedMs, readId });
    }

    assert.deepEqual(
      capture.finish()?.measurement,
      {
        tokenizer: "o200k_base",
        outputTokens: postTokens,
        durationMs: 1_000 - startMs,
        windows: [{ startMs, endMs: 1_000, outputTokens: postTokens }],
        samplingWindowMs: 100,
      },
      `${rate} tokens/s`,
    );
  }
});

test("streaming UTF-8, CRLF, named events, and multiline data count only post-boundary tokens", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 1_000,
    readId: 1,
  });

  const data = JSON.stringify(
    {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      delta: "😀",
    },
    null,
    2,
  );
  const multiline = `event: response.output_text.delta\r\n${data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\r\n")}\r\n\r\n`;
  const bytes = encoder.encode(multiline + sseEvent(responseCompleted(), null, "\r\n"));
  const emojiBytes = encoder.encode("😀");
  const emojiOffset = bytes.findIndex((_value, index) =>
    emojiBytes.every((byte, emojiIndex) => bytes[index + emojiIndex] === byte),
  );
  assert.ok(emojiOffset > 0);

  capture.push(bytes.slice(0, emojiOffset + 2), { elapsedMs: 1_110, readId: 2 });
  capture.push(bytes.slice(emojiOffset + 2), { elapsedMs: 1_110, readId: 2 });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 110,
      windows: [{ startMs: 1_000, endMs: 1_110, outputTokens: 1 }],
      samplingWindowMs: 100,
    },
  });
});

test("reasoning and server-tool markers start new phases without mixing visible lanes", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 1_000,
    readId: 1,
  });
  capture.push(
    encoder.encode(
      sseEvent(responseTextDelta("中")) + sseEvent({ type: "response.reasoning_text.delta", delta: "think" }),
    ),
    { elapsedMs: 1_110, readId: 2 },
  );
  capture.push(
    encoder.encode(
      sseEvent({
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "search-1", type: "web_search_call" },
      }) + sseEvent(responseTextDelta("中")),
    ),
    { elapsedMs: 1_120, readId: 3 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("中")) + sseEvent(responseCompleted())), {
    elapsedMs: 1_230,
    readId: 4,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 220,
      windows: [
        { startMs: 1_000, endMs: 1_110, outputTokens: 1 },
        { startMs: 1_120, endMs: 1_230, outputTokens: 1 },
      ],
      samplingWindowMs: 100,
    },
  });
});

test("phase windows share one final lane tokenization across a merged word", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("a"))), {
    elapsedMs: 1_000,
    readId: 1,
  });
  capture.push(
    encoder.encode(
      sseEvent(responseTextDelta("b")) + sseEvent({ type: "response.reasoning_text.delta", delta: "split" }),
    ),
    { elapsedMs: 1_110, readId: 2 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("c"))), { elapsedMs: 1_120, readId: 3 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("d")) + sseEvent(responseCompleted())), {
    elapsedMs: 1_230,
    readId: 4,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 110,
      windows: [{ startMs: 1_120, endMs: 1_230, outputTokens: 1 }],
      samplingWindowMs: 100,
    },
  });
});

test("hidden Responses reasoning markers split phases without reasoning text", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("a"))), {
    elapsedMs: 1_000,
    readId: 1,
  });
  capture.push(
    encoder.encode(
      sseEvent(responseTextDelta("b")) +
        sseEvent({
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "reasoning-1", type: "reasoning" },
        }),
    ),
    { elapsedMs: 1_110, readId: 2 },
  );
  capture.push(
    encoder.encode(
      sseEvent({
        type: "response.reasoning_summary.delta",
        output_index: 1,
        summary: {},
      }) +
        sseEvent({
          type: "response.output_item.done",
          output_index: 1,
          item: { id: "reasoning-1", type: "reasoning" },
        }),
    ),
    { elapsedMs: 1_200, readId: 3 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("c"))), { elapsedMs: 1_200, readId: 4 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("d")) + sseEvent(responseCompleted())), {
    elapsedMs: 1_310,
    readId: 5,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 110,
      windows: [{ startMs: 1_200, endMs: 1_310, outputTokens: 1 }],
      samplingWindowMs: 100,
    },
  });
});

test("a UTF-16 boundary inside a surrogate pair maps before the completed character", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(responseMetadata()) + sseEvent({ type: "response.reasoning_text.delta", delta: "phase-break" }),
    ),
    { elapsedMs: 2_000, readId: 1 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("\ud83d"))), { elapsedMs: 2_010, readId: 2 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("\udc69")) + sseEvent(responseCompleted())), {
    elapsedMs: 2_111,
    readId: 3,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 101,
      windows: [{ startMs: 2_010, endMs: 2_111, outputTokens: 2 }],
      samplingWindowMs: 100,
    },
  });
});

test("parallel item lanes remain separate and union overlapping time", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(responseMetadata()) +
        sseEvent(responseTextDelta("a", "item-a", 0)) +
        sseEvent(responseTextDelta("b", "item-b", 1)),
    ),
    { elapsedMs: 1_000, readId: 1 },
  );
  capture.push(
    encoder.encode(
      sseEvent(responseTextDelta("a", "item-a", 0)) +
        sseEvent(responseTextDelta("b", "item-b", 1)) +
        sseEvent(responseCompleted()),
    ),
    { elapsedMs: 1_110, readId: 2 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 110,
      windows: [
        { startMs: 1_000, endMs: 1_110, outputTokens: 1 },
        { startMs: 1_000, endMs: 1_110, outputTokens: 1 },
      ],
      samplingWindowMs: 100,
    },
  });
});

test("lane baselines retain independent first-visible anchors", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中", "item-a", 0))), {
    elapsedMs: 0,
    readId: 1,
  });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中", "item-b", 1))), {
    elapsedMs: 50,
    readId: 2,
  });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中", "item-a", 0))), {
    elapsedMs: 110,
    readId: 3,
  });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中", "item-b", 1)) + sseEvent(responseCompleted())), {
    elapsedMs: 160,
    readId: 4,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 160,
      windows: [
        { startMs: 0, endMs: 110, outputTokens: 1 },
        { startMs: 50, endMs: 160, outputTokens: 1 },
      ],
      samplingWindowMs: 100,
    },
  });
});

test("a visible batch timestamp is shared across lanes and ignores terminal-only bytes", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(responseMetadata()) +
        sseEvent(responseTextDelta("中", "item-a", 0)) +
        sseEvent(responseTextDelta("中", "item-b", 1)),
    ),
    { elapsedMs: 0, readId: 1 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("中", "item-a", 0))), {
    elapsedMs: 150,
    readId: 2,
  });
  capture.push(encoder.encode(sseEvent(responseTextDelta("中", "item-b", 1))), {
    elapsedMs: 160,
    readId: 2,
  });
  capture.push(encoder.encode(sseEvent(responseCompleted())), { elapsedMs: 170, readId: 2 });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 160,
      windows: [
        { startMs: 0, endMs: 160, outputTokens: 1 },
        { startMs: 0, endMs: 160, outputTokens: 1 },
      ],
      samplingWindowMs: 100,
    },
  });
});

test("later phase output reusing a read id does not stretch the previous phase", () => {
  const capture = createOutputStreamCapture();
  capture.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 0,
    readId: 1,
  });
  capture.push(
    encoder.encode(
      sseEvent(responseTextDelta("中")) + sseEvent({ type: "response.reasoning_text.delta", delta: "think" }),
    ),
    { elapsedMs: 110, readId: 2 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("中")) + sseEvent(responseCompleted())), {
    elapsedMs: 900,
    readId: 2,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 110,
      windows: [{ startMs: 0, endMs: 110, outputTokens: 1 }],
      samplingWindowMs: 100,
    },
  });
});

test("Anthropic text and tool input count while thinking and tool names do not", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(
        {
          type: "message_start",
          message: { id: "msg-anthropic", model: "claude-test" },
        },
        "message_start",
      ) +
        sseEvent(
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          "content_block_start",
        ) +
        sseEvent(
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中" } },
          "content_block_delta",
        ),
    ),
    { elapsedMs: 2_000, readId: 1 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中" } },
        "content_block_delta",
      ),
    ),
    { elapsedMs: 2_110, readId: 2 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
        "content_block_start",
      ) +
        sseEvent(
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "thinking_delta", thinking: "reasoning" },
          },
          "content_block_delta",
        ) +
        sseEvent(
          {
            type: "content_block_start",
            index: 2,
            content_block: { type: "tool_use", id: "tool-1", name: "ignored_name", input: {} },
          },
          "content_block_start",
        ) +
        sseEvent(
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: "中" },
          },
          "content_block_delta",
        ),
    ),
    { elapsedMs: 2_120, readId: 3 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "中" },
        },
        "content_block_delta",
      ) + sseEvent({ type: "message_stop" }, "message_stop"),
    ),
    { elapsedMs: 2_230, readId: 4 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "msg-anthropic",
    model: "claude-test",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 220,
      windows: [
        { startMs: 2_000, endMs: 2_110, outputTokens: 1 },
        { startMs: 2_120, endMs: 2_230, outputTokens: 1 },
      ],
      samplingWindowMs: 100,
    },
  });
});

test("hidden Anthropic thinking and signature markers split phases without reasoning text", () => {
  const capture = createOutputStreamCapture();
  capture.push(
    encoder.encode(
      sseEvent(
        {
          type: "message_start",
          message: { id: "msg-anthropic-hidden", model: "claude-test" },
        },
        "message_start",
      ) +
        sseEvent(
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          "content_block_start",
        ) +
        sseEvent(
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
          "content_block_delta",
        ),
    ),
    { elapsedMs: 2_000, readId: 1 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } },
        "content_block_delta",
      ) +
        sseEvent(
          { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
          "content_block_start",
        ),
    ),
    { elapsedMs: 2_110, readId: 2 },
  );
  capture.push(
    encoder.encode(
      sseEvent({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta" } }, "content_block_delta") +
        sseEvent(
          { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "" } },
          "content_block_delta",
        ) +
        sseEvent({ type: "content_block_stop", index: 1 }, "content_block_stop") +
        sseEvent(
          { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "" } },
          "content_block_start",
        ),
    ),
    { elapsedMs: 2_200, readId: 3 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "c" } },
        "content_block_delta",
      ),
    ),
    { elapsedMs: 2_200, readId: 4 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "d" } },
        "content_block_delta",
      ) + sseEvent({ type: "message_stop" }, "message_stop"),
    ),
    { elapsedMs: 2_310, readId: 5 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "msg-anthropic-hidden",
    model: "claude-test",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 110,
      windows: [{ startMs: 2_200, endMs: 2_310, outputTokens: 1 }],
      samplingWindowMs: 100,
    },
  });
});

test("Chat Completions counts content and tool arguments but not reasoning or tool names", () => {
  const capture = createOutputStreamCapture();
  const chunk = (delta, id = "chat-1", model = "chat-model") => ({
    id,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta }],
  });
  capture.push(encoder.encode(sseEvent(chunk({ content: "中" }))), { elapsedMs: 3_000, readId: 1 });
  capture.push(
    encoder.encode(
      sseEvent(chunk({ content: "中" })) +
        sseEvent(chunk({ reasoning_content: "reasoning" })) +
        sseEvent(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "ignored_name", arguments: "中" },
              },
            ],
          }),
        ),
    ),
    { elapsedMs: 3_110, readId: 2 },
  );
  capture.push(
    encoder.encode(
      sseEvent(
        chunk({
          tool_calls: [{ index: 0, function: { arguments: "中" } }],
        }),
      ) +
        sseEvent({
          id: "chat-1",
          object: "chat.completion.chunk",
          model: "chat-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }) +
        sseEvent("[DONE]"),
    ),
    { elapsedMs: 3_220, readId: 3 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "chat-1",
    model: "chat-model",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 220,
      windows: [
        { startMs: 3_000, endMs: 3_110, outputTokens: 1 },
        { startMs: 3_110, endMs: 3_220, outputTokens: 1 },
      ],
      samplingWindowMs: 100,
    },
  });
});

test("Chat reasoning fields split phases when explicitly non-null and ignore null", () => {
  const chunk = (delta, id = "chat-hidden", model = "chat-model") => ({
    id,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta }],
  });

  const nullOnly = createOutputStreamCapture();
  nullOnly.push(encoder.encode(sseEvent(chunk({ content: "中" }))), { elapsedMs: 1_000, readId: 1 });
  nullOnly.push(encoder.encode(sseEvent(chunk({ reasoning: null }))), { elapsedMs: 1_100, readId: 2 });
  nullOnly.push(encoder.encode(sseEvent(chunk({ content: "中" }))), { elapsedMs: 1_200, readId: 3 });
  nullOnly.push(encoder.encode(sseEvent(chunk({ content: "中" })) + sseEvent("[DONE]")), {
    elapsedMs: 1_210,
    readId: 4,
  });
  assert.deepEqual(nullOnly.finish(), {
    responseId: "chat-hidden",
    model: "chat-model",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 210,
      windows: [{ startMs: 1_000, endMs: 1_210, outputTokens: 2 }],
      samplingWindowMs: 100,
    },
  });

  const explicitMarkers = [{ reasoning_content: "" }, { reasoning: {} }];
  for (let index = 0; index < explicitMarkers.length; index += 1) {
    const capture = createOutputStreamCapture();
    const start = 2_000 + index * 1_000;
    capture.push(encoder.encode(sseEvent(chunk({ content: "中" }))), { elapsedMs: start, readId: 1 });
    capture.push(encoder.encode(sseEvent(chunk(explicitMarkers[index]))), {
      elapsedMs: start + 10,
      readId: 2,
    });
    capture.push(encoder.encode(sseEvent(chunk({ content: "中" }))), {
      elapsedMs: start + 20,
      readId: 3,
    });
    capture.push(encoder.encode(sseEvent(chunk({ content: "中" })) + sseEvent("[DONE]")), {
      elapsedMs: start + 121,
      readId: 4,
    });
    assert.deepEqual(capture.finish(), {
      responseId: "chat-hidden",
      model: "chat-model",
      measurement: {
        tokenizer: "o200k_base",
        outputTokens: 1,
        durationMs: 101,
        windows: [{ startMs: start + 20, endMs: start + 121, outputTokens: 1 }],
        samplingWindowMs: 100,
      },
    });
  }
});

test("metadata-only success has no measurement and protocol failure returns null", () => {
  const metadataOnly = createOutputStreamCapture();
  metadataOnly.push(encoder.encode(sseEvent(responseMetadata())), { elapsedMs: 10, readId: 1 });
  metadataOnly.push(encoder.encode(sseEvent(responseCompleted())), { elapsedMs: 20, readId: 2 });
  assert.deepEqual(metadataOnly.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: null,
  });

  const failed = createOutputStreamCapture();
  failed.push(encoder.encode(sseEvent(responseMetadata()) + sseEvent(responseTextDelta("中"))), {
    elapsedMs: 10,
    readId: 1,
  });
  failed.push(
    encoder.encode(
      sseEvent({
        type: "response.failed",
        response: { id: "resp-1", model: "model-1", status: "failed" },
      }),
    ),
    { elapsedMs: 20, readId: 2 },
  );
  assert.equal(failed.finish(), null);
});
