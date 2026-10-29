import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { readDshSessionRows, streamDshSessionEvents, streamDshSessionRows } from "../src/dsh-usage.js";
import { streamDshPerfSamples } from "../src/perf-sources/dsh.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const T = Date.parse("2026-10-04T12:00:00.000Z");
const SESSION_ID = "session-stream-0001";
const SOURCE = Object.freeze({ id: "home-stream", label: "Stream fixture", path: path.join(tmpdir(), "dsh") });

function sessionRow(overrides = {}) {
  return {
    type: "session",
    version: 4,
    id: SESSION_ID,
    cwd: path.join(tmpdir(), "dsh-project"),
    createdAt: T,
    delegationDepth: 0,
    agentPreset: "standard",
    ...overrides,
  };
}

function requestRow({ seq = 1, model = "deepseek-chat", provider = "deepseek-account" } = {}) {
  return {
    type: "request/header",
    seq,
    time: T + seq,
    data: { header: { config: { model, provider, reasoningEffort: "max" } } },
  };
}

function titleRow(seq, title) {
  return { type: "session/title", seq, time: T + seq, data: { title } };
}

function assistantRow(seq, outputTokens = 20) {
  return {
    type: "assistant/message",
    seq,
    time: T + seq,
    data: {
      turn: 1,
      step: 1,
      usage: {
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        outputTokens,
        totalTokens: 12 + outputTokens,
      },
      message: { content: [] },
    },
  };
}

function stepStartRow(seq) {
  return { type: "step/start", seq, time: T + seq, data: { turn: 1, step: 1 } };
}

function stepEndRow(seq) {
  return { type: "step/end", seq, data: { turn: 1, step: 1 } };
}

function frame(value) {
  return zstdCompressSync(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
}

function rowsFrame(rows) {
  return frame(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function damagedFrame() {
  return Buffer.concat([ZSTD_MAGIC, Buffer.from("not-a-valid-zstd-frame")]);
}

async function fixtureFile(t, frames) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-streaming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "fixture", SESSION_ID);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "session.v4.jsonl.zstd");
  await writeFile(filePath, Buffer.concat(frames));
  return filePath;
}

async function collectRows(filePath) {
  const rows = [];
  const warnings = [];
  for await (const row of streamDshSessionRows(filePath, {
    onWarning: (warning) => warnings.push(warning),
  })) {
    rows.push(row);
  }
  return { rows, warnings };
}

async function collectEvents(filePath) {
  const events = [];
  const warnings = [];
  await streamDshSessionEvents(filePath, SOURCE, (event) => events.push(event), {
    onWarning: (warning) => warnings.push(warning),
    repositoryResolver: async (cwd) => ({ key: `fixture:${cwd}`, path: cwd, kind: "fixture" }),
  });
  return { events, warnings };
}

async function collectPerf(filePath) {
  const samples = [];
  const warnings = [];
  const result = await streamDshPerfSamples(filePath, SOURCE, (sample) => samples.push(sample), {
    onWarning: (warning) => warnings.push(warning),
  });
  return { samples, warnings, result };
}

test("stream and array readers agree across frames, a damaged frame and bad JSON", async (t) => {
  const title = JSON.stringify(titleRow(2, "line continues across frames"));
  const splitAt = Math.floor(title.length / 2);
  const filePath = await fixtureFile(t, [
    frame(`${JSON.stringify(sessionRow())}\n${JSON.stringify(requestRow())}\n${title.slice(0, splitAt)}`),
    damagedFrame(),
    frame(`${title.slice(splitAt)}\n${JSON.stringify(assistantRow(3))}\n{"type":"broken"\n`),
  ]);
  const streamed = await collectRows(filePath);
  const arrayWarnings = [];
  const arrayRows = await readDshSessionRows(filePath, {
    onWarning: (warning) => arrayWarnings.push(warning),
  });

  assert.deepEqual(streamed.rows, arrayRows);
  assert.deepEqual(streamed.warnings, arrayWarnings);
  assert.deepEqual(
    streamed.rows.map((row) => row.type),
    ["session", "request/header", "session/title", "assistant/message"],
  );
  assert.equal(streamed.warnings.length, 2);
  assert.match(streamed.warnings[0], /损坏帧或空帧/);
  assert.match(streamed.warnings[1], /^MALFORMED_JSON:1 /);
});

test("a late session header preserves pre-header events and frame order", async (t) => {
  const filePath = await fixtureFile(t, [
    rowsFrame([requestRow(), titleRow(2, "late header"), assistantRow(3, 37)]),
    rowsFrame([sessionRow()]),
    rowsFrame([assistantRow(4, 53)]),
  ]);
  const { events, warnings } = await collectEvents(filePath);

  assert.deepEqual(warnings, []);
  assert.deepEqual(
    events.map((event) => ({
      id: event.eventId,
      output: event.usage.output,
      model: event.model,
      provider: event.modelProvider,
      title: event.conversationName,
    })),
    [
      {
        id: `${SESSION_ID}:3`,
        output: 37,
        model: "deepseek-chat",
        provider: "deepseek-account",
        title: "late header",
      },
      {
        id: `${SESSION_ID}:4`,
        output: 53,
        model: "deepseek-chat",
        provider: "deepseek-account",
        title: "late header",
      },
    ],
  );
});

test("parser warnings are delivered before events and survive an event callback failure", async (t) => {
  const filePath = await fixtureFile(t, [
    rowsFrame([sessionRow(), requestRow(), assistantRow(2, 43)]),
    frame('{"type":"broken-one"\n{"type":"broken-two"\n'),
    damagedFrame(),
  ]);
  const trace = [];
  await streamDshSessionEvents(filePath, SOURCE, (event) => trace.push(`event:${event.eventId.split(":")[1]}`), {
    onWarning: (warning) => trace.push(warning.startsWith("MALFORMED_JSON:") ? "warning:json" : "warning:frame"),
    repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
  });
  assert.deepEqual(trace, ["warning:frame", "warning:json", "event:2"]);

  const warnings = [];
  await assert.rejects(
    streamDshSessionEvents(
      filePath,
      SOURCE,
      () => {
        throw new Error("fixture event failure");
      },
      {
        onWarning: (warning) => warnings.push(warning),
        repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
      },
    ),
    /fixture event failure/,
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /有 1 个损坏帧/);
  assert.match(warnings[1], /^MALFORMED_JSON:2 /);
});

test("cross-frame UTF-8 keeps the per-frame replacement-character semantics", async (t) => {
  const rowBytes = Buffer.from(`${JSON.stringify(sessionRow({ agentPreset: "中文预设" }))}\n`, "utf8");
  const marker = Buffer.from("中文预设", "utf8");
  const markerAt = rowBytes.indexOf(marker);
  assert.notEqual(markerAt, -1);
  const filePath = await fixtureFile(t, [
    frame(rowBytes.subarray(0, markerAt + 1)),
    frame(rowBytes.subarray(markerAt + 1)),
  ]);
  const { rows } = await collectRows(filePath);

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].agentPreset, "中文预设");
  assert.match(rows[0].agentPreset, /\uFFFD/);
});

test("perf projection keeps the sample and parser warning counts", async (t) => {
  const filePath = await fixtureFile(t, [
    rowsFrame([sessionRow(), requestRow(), stepStartRow(3), assistantRow(4, 3), stepEndRow(5)]),
    frame('{"type":"broken"\n'),
    damagedFrame(),
  ]);
  const { samples, warnings, result } = await collectPerf(filePath);

  assert.equal(samples.length, 1);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.stepEndFrames, 1);
  assert.equal(samples[0].homeId, SOURCE.id);
  assert.deepEqual(JSON.parse(samples[0].sampleKey), ["dsh", SOURCE.id, SESSION_ID, 1, 1]);
  assert.deepEqual(
    warnings.map((warning) => [warning.code, warning.count]),
    [
      ["MALFORMED_FRAME", 1],
      ["MALFORMED_JSON", 1],
    ],
  );
  assert.deepEqual(result.warnings, warnings);
});
