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

  capture.push(bytes.slice(0, emojiOffset + 2), { elapsedMs: 1_010, readId: 2 });
  capture.push(bytes.slice(emojiOffset + 2), { elapsedMs: 1_010, readId: 2 });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 10,
      windows: [{ startMs: 1_000, endMs: 1_010, outputTokens: 1 }],
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
    { elapsedMs: 1_010, readId: 2 },
  );
  capture.push(
    encoder.encode(
      sseEvent({
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "search-1", type: "web_search_call" },
      }) + sseEvent(responseTextDelta("中")),
    ),
    { elapsedMs: 1_020, readId: 3 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("中")) + sseEvent(responseCompleted())), {
    elapsedMs: 1_030,
    readId: 4,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 20,
      windows: [
        { startMs: 1_000, endMs: 1_010, outputTokens: 1 },
        { startMs: 1_020, endMs: 1_030, outputTokens: 1 },
      ],
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
    { elapsedMs: 1_010, readId: 2 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("c"))), { elapsedMs: 1_020, readId: 3 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("d")) + sseEvent(responseCompleted())), {
    elapsedMs: 1_030,
    readId: 4,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 10,
      windows: [{ startMs: 1_020, endMs: 1_030, outputTokens: 1 }],
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
    { elapsedMs: 1_010, readId: 2 },
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
    { elapsedMs: 1_100, readId: 3 },
  );
  capture.push(encoder.encode(sseEvent(responseTextDelta("c"))), { elapsedMs: 1_200, readId: 4 });
  capture.push(encoder.encode(sseEvent(responseTextDelta("d")) + sseEvent(responseCompleted())), {
    elapsedMs: 1_210,
    readId: 5,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 10,
      windows: [{ startMs: 1_200, endMs: 1_210, outputTokens: 1 }],
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
    elapsedMs: 2_020,
    readId: 3,
  });

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 10,
      windows: [{ startMs: 2_010, endMs: 2_020, outputTokens: 2 }],
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
    { elapsedMs: 1_020, readId: 2 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "resp-1",
    model: "model-1",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 20,
      windows: [
        { startMs: 1_000, endMs: 1_020, outputTokens: 1 },
        { startMs: 1_000, endMs: 1_020, outputTokens: 1 },
      ],
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
    { elapsedMs: 2_010, readId: 2 },
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
    { elapsedMs: 2_020, readId: 3 },
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
    { elapsedMs: 2_030, readId: 4 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "msg-anthropic",
    model: "claude-test",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 20,
      windows: [
        { startMs: 2_000, endMs: 2_010, outputTokens: 1 },
        { startMs: 2_020, endMs: 2_030, outputTokens: 1 },
      ],
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
    { elapsedMs: 2_010, readId: 2 },
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
    { elapsedMs: 2_100, readId: 3 },
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
    { elapsedMs: 2_210, readId: 5 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "msg-anthropic-hidden",
    model: "claude-test",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 10,
      windows: [{ startMs: 2_200, endMs: 2_210, outputTokens: 1 }],
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
    { elapsedMs: 3_010, readId: 2 },
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
    { elapsedMs: 3_020, readId: 3 },
  );

  assert.deepEqual(capture.finish(), {
    responseId: "chat-1",
    model: "chat-model",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 2,
      durationMs: 20,
      windows: [
        { startMs: 3_000, endMs: 3_010, outputTokens: 1 },
        { startMs: 3_010, endMs: 3_020, outputTokens: 1 },
      ],
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
  nullOnly.push(encoder.encode(sseEvent(chunk({ content: "a" }))), { elapsedMs: 1_000, readId: 1 });
  nullOnly.push(encoder.encode(sseEvent(chunk({ reasoning: null }))), { elapsedMs: 1_100, readId: 2 });
  nullOnly.push(encoder.encode(sseEvent(chunk({ content: "b" }))), { elapsedMs: 1_200, readId: 3 });
  nullOnly.push(encoder.encode(sseEvent(chunk({ content: "c" })) + sseEvent("[DONE]")), {
    elapsedMs: 1_210,
    readId: 4,
  });
  assert.deepEqual(nullOnly.finish(), {
    responseId: "chat-hidden",
    model: "chat-model",
    measurement: {
      tokenizer: "o200k_base",
      outputTokens: 1,
      durationMs: 210,
      windows: [{ startMs: 1_000, endMs: 1_210, outputTokens: 1 }],
    },
  });

  const explicitMarkers = [{ reasoning_content: "" }, { reasoning: {} }];
  for (let index = 0; index < explicitMarkers.length; index += 1) {
    const capture = createOutputStreamCapture();
    const start = 2_000 + index * 1_000;
    capture.push(encoder.encode(sseEvent(chunk({ content: "a" }))), { elapsedMs: start, readId: 1 });
    capture.push(encoder.encode(sseEvent(chunk(explicitMarkers[index]))), {
      elapsedMs: start + 10,
      readId: 2,
    });
    capture.push(encoder.encode(sseEvent(chunk({ content: "b" }))), {
      elapsedMs: start + 20,
      readId: 3,
    });
    capture.push(encoder.encode(sseEvent(chunk({ content: "c" })) + sseEvent("[DONE]")), {
      elapsedMs: start + 30,
      readId: 4,
    });
    assert.deepEqual(capture.finish(), {
      responseId: "chat-hidden",
      model: "chat-model",
      measurement: {
        tokenizer: "o200k_base",
        outputTokens: 1,
        durationMs: 10,
        windows: [{ startMs: start + 20, endMs: start + 30, outputTokens: 1 }],
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
