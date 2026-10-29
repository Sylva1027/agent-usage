import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

const output = process.argv[2];
if (!output) throw new Error("output path is required");

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const t0 = Date.parse("2026-10-29T00:00:00.000Z");
const frame = (rows) =>
  zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8"));

const session = {
  type: "session",
  version: 4,
  id: "session-edge-0001",
  cwd: "E:\\fixture\\rust-parsing",
  delegationDepth: 1,
  createdAt: t0,
  agentPreset: "edge-fixture",
};
const request = {
  type: "request/header",
  seq: 2,
  time: t0 + 1,
  data: {
    header: {
      config: {
        provider: "fixture-provider",
        model: "fixture-model",
        reasoningEffort: "max",
        maxTokens: 256000,
      },
    },
    reason: "turn-start",
  },
};
const title = {
  type: "session/title",
  seq: 3,
  time: t0 + 2,
  data: { title: "UTF8 boundary fixture", source: "fixture", messageSeqs: [2] },
};
const splitMessage = {
  type: "assistant/message",
  seq: 4,
  time: t0 + 3,
  surfaceOp: "append",
  data: {
    turn: 1,
    step: 1,
    usage: {
      inputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 3,
      outputTokens: 7,
      totalTokens: 40,
    },
    stream: [{ type: "text-chunks", time0: t0 + 3, index: 0, dt: [1, 1], texts: ["A中B"] }],
    message: { content: [{ type: "text", text: "fixture-body-not-hashed" }] },
  },
};

const splitLine = Buffer.from(`${JSON.stringify(splitMessage)}\n`, "utf8");
const codepoint = Buffer.from("中", "utf8");
const codepointAt = splitLine.indexOf(codepoint);
if (codepointAt < 0) throw new Error("UTF-8 split marker missing");
const firstHalf = zstdCompressSync(splitLine.subarray(0, codepointAt + 1));
const secondHalf = zstdCompressSync(splitLine.subarray(codepointAt + 1));
const badFrame = Buffer.concat([magic, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])]);
const emptyFrame = zstdCompressSync(Buffer.alloc(0));
const malformedAndGood = zstdCompressSync(
  Buffer.from(
    `${JSON.stringify({
      type: "assistant/message",
      seq: 5,
      time: t0 + 4,
      data: {
        turn: 1,
        step: 2,
        usage: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        stream: [],
      },
    })}\n{broken json}\n${JSON.stringify({
      type: "assistant/message",
      seq: 6,
      time: t0 + 5,
      data: {
        turn: 1,
        step: 3,
        usage: {
          inputTokens: 1,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          outputTokens: 3,
          totalTokens: 6,
        },
        stream: [{ type: "reasoning-chunks", time0: t0 + 5, index: 0, dt: [], texts: [] }],
      },
    })}\n`,
    "utf8",
  ),
);

await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  Buffer.concat([
    frame([session]),
    frame([request, title]),
    firstHalf,
    secondHalf,
    badFrame,
    emptyFrame,
    malformedAndGood,
  ]),
);
