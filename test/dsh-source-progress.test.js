import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import zlib, { zstdCompressSync } from "node:zlib";

import { readZstdFrames } from "../src/dsh-frame-progress.js";
import { streamDshSessionEvents } from "../src/dsh-usage.js";

const T = Date.parse("2026-11-03T12:00:00.000Z");
const SOURCE = Object.freeze({ id: "dsh-progress", label: "Progress fixture", path: tmpdir() });
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function sessionRow({ id = "session-progress", modelCwd = "E:\\work\\progress" } = {}) {
  return {
    type: "session",
    version: 4,
    id,
    cwd: modelCwd,
    delegationDepth: 0,
    createdAt: T,
    agentPreset: "standard",
  };
}

function requestRow(seq, model, provider) {
  return {
    type: "request/header",
    seq,
    time: T + seq,
    data: { header: { config: { model, provider } } },
  };
}

function titleRow(seq, title) {
  return { type: "session/title", seq, time: T + seq, data: { title } };
}

function assistantRow(seq, outputTokens = seq) {
  return {
    type: "assistant/message",
    seq,
    time: T + seq,
    data: {
      turn: 1,
      step: seq,
      usage: {
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        outputTokens,
        totalTokens: 12 + outputTokens,
      },
      message: { content: [{ text: "not projected" }] },
    },
  };
}

function rowsText(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function frame(rowsOrBytes, options) {
  const input = Buffer.isBuffer(rowsOrBytes) ? rowsOrBytes : Buffer.from(rowsText(rowsOrBytes), "utf8");
  return zstdCompressSync(input, options);
}

function rawFrame(payload) {
  assert.ok(payload.length <= 255, "fixture raw frame must use one-byte content size");
  const blockHeader = Buffer.alloc(3);
  blockHeader.writeUIntLE((payload.length << 3) | 1, 0, 3);
  return Buffer.concat([ZSTD_MAGIC, Buffer.from([0x20, payload.length]), blockHeader, payload]);
}

async function fixtureFile(t, frames = []) {
  const root = await fsPromises.mkdtemp(path.join(tmpdir(), "dsh-source-progress-"));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "fixture", "session-progress");
  await fsPromises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "session.v4.jsonl.zstd");
  await fsPromises.writeFile(filePath, Buffer.concat(frames));
  return filePath;
}

async function collectSession(filePath, options = {}) {
  const events = [];
  const warnings = [];
  await streamDshSessionEvents(filePath, SOURCE, (event) => events.push(event), {
    repositoryResolver: async (cwd) => ({ key: `fixture:${cwd}`, path: cwd, kind: "fixture" }),
    onWarning: (warning) => warnings.push(warning),
    ...options,
  });
  return { events, warnings };
}

async function collectWithProgress(filePath, options = {}) {
  const events = [];
  const warnings = [];
  const checkpoints = [];
  const checkpointEventCounts = [];
  await streamDshSessionEvents(filePath, SOURCE, (event) => events.push(event), {
    repositoryResolver: async (cwd) => ({ key: `fixture:${cwd}`, path: cwd, kind: "fixture" }),
    onWarning: (warning) => warnings.push(warning),
    ...options,
    onProgress: (checkpoint) => {
      checkpoints.push(checkpoint);
      checkpointEventCounts.push(events.length);
    },
  });
  return { events, warnings, checkpoints, checkpointEventCounts };
}

test("initial plus resume events match the full parse across changing request context", async (t) => {
  const frames = [
    frame([sessionRow()]),
    frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 20)]),
    frame([titleRow(3, "Renamed session"), assistantRow(3, 25)]),
    frame([
      sessionRow({ id: "duplicate-header-ignored", modelCwd: "E:\\wrong" }),
      requestRow(4, "deepseek-v4-pro", "provider-b"),
      assistantRow(5, 30),
    ]),
    frame([assistantRow(6, 40)]),
  ];
  const filePath = await fixtureFile(t, frames.slice(0, 3));
  const initial = await collectWithProgress(filePath);
  const firstCheckpoint = initial.checkpoints.at(-1);

  assert.deepEqual(Object.keys(firstCheckpoint), ["format", "adapter", "offset", "lineNumber", "state"]);
  assert.equal(firstCheckpoint.format, 1);
  assert.equal(firstCheckpoint.adapter, "dsh-v4-zstd");
  assert.equal(firstCheckpoint.offset, (await fsPromises.stat(filePath)).size);
  assert.equal(firstCheckpoint.lineNumber, 5);
  assert.equal(firstCheckpoint.state.header.id, "session-progress");
  assert.equal(firstCheckpoint.state.model, "deepseek-flash");
  assert.equal(firstCheckpoint.state.modelProvider, "provider-a");
  assert.equal(firstCheckpoint.state.conversationName, "Renamed session");
  assert.deepEqual(initial.checkpointEventCounts, [0, 1, 2]);
  assert.deepEqual(
    initial.events.map(({ eventId, model, modelProvider, conversationName }) => ({
      eventId,
      model,
      modelProvider,
      conversationName,
    })),
    [
      {
        eventId: "session-progress:2",
        model: "deepseek-flash",
        modelProvider: "provider-a",
        conversationName: "",
      },
      {
        eventId: "session-progress:3",
        model: "deepseek-flash",
        modelProvider: "provider-a",
        conversationName: "Renamed session",
      },
    ],
  );

  await fsPromises.appendFile(filePath, Buffer.concat(frames.slice(3)));
  const resumed = await collectWithProgress(filePath, { resume: firstCheckpoint });
  assert.deepEqual(resumed.checkpointEventCounts, [1, 2]);
  assert.deepEqual(
    resumed.events.map(({ eventId, sessionId, model, modelProvider, conversationName }) => ({
      eventId,
      sessionId,
      model,
      modelProvider,
      conversationName,
    })),
    [
      {
        eventId: "session-progress:5",
        sessionId: "session-progress",
        model: "deepseek-v4-pro",
        modelProvider: "provider-b",
        conversationName: "Renamed session",
      },
      {
        eventId: "session-progress:6",
        sessionId: "session-progress",
        model: "deepseek-v4-pro",
        modelProvider: "provider-b",
        conversationName: "Renamed session",
      },
    ],
  );

  const full = await collectSession(filePath);
  assert.deepEqual([...initial.events, ...resumed.events], full.events);
  assert.deepEqual(initial.warnings, []);
  assert.deepEqual(resumed.warnings, []);
});

test("an empty valid resume suffix is idempotent and returns the same checkpoint", async (t) => {
  const filePath = await fixtureFile(t, [
    frame([sessionRow()]),
    frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 6)]),
  ]);
  const initial = await collectWithProgress(filePath);
  const checkpoint = initial.checkpoints.at(-1);

  const emptyResume = await collectWithProgress(filePath, {
    resume: checkpoint,
    endOffset: checkpoint.offset,
  });
  assert.deepEqual(emptyResume.events, []);
  assert.deepEqual(emptyResume.warnings, []);
  assert.deepEqual(emptyResume.checkpoints, [checkpoint]);
  assert.deepEqual(emptyResume.checkpointEventCounts, [0]);
});

test("resume preserves JSON across frames and legacy per-frame UTF-8 replacement semantics", async (t) => {
  const title = titleRow(2, "中文标题");
  const titleBytes = Buffer.from(`${JSON.stringify(title)}\n`, "utf8");
  const chineseAt = titleBytes.indexOf(Buffer.from("中", "utf8"));
  assert.notEqual(chineseAt, -1);

  const filePath = await fixtureFile(t, [frame([sessionRow()])]);
  const initial = await collectWithProgress(filePath);
  const checkpoint = initial.checkpoints.at(-1);
  await fsPromises.appendFile(
    filePath,
    Buffer.concat([
      frame(titleBytes.subarray(0, chineseAt + 1)),
      frame(
        Buffer.concat([titleBytes.subarray(chineseAt + 1), Buffer.from(`${JSON.stringify(assistantRow(3, 17))}\n`)]),
      ),
    ]),
  );

  const resumed = await collectWithProgress(filePath, { resume: checkpoint });
  const full = await collectSession(filePath);
  assert.deepEqual(resumed.events, full.events);
  assert.equal(resumed.events.length, 1);
  assert.match(resumed.events[0].conversationName, /\uFFFD/);
  assert.notEqual(resumed.events[0].conversationName, "中文标题");
  assert.equal(resumed.events[0].usage.output, 17);
  assert.equal(resumed.checkpoints.at(-1).offset, (await fsPromises.stat(filePath)).size);
});

test("a late first header is applied retroactively without an earlier checkpoint", async (t) => {
  const firstFrame = frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 19)]);
  const headerFrame = frame([sessionRow()]);
  const futureFrame = frame([requestRow(3, "deepseek-v4-pro", "provider-b"), assistantRow(4, 23)]);
  const filePath = await fixtureFile(t, [firstFrame, headerFrame, futureFrame]);

  const progress = await collectWithProgress(filePath);
  const full = await collectSession(filePath);
  assert.deepEqual(progress.events, full.events);
  assert.deepEqual(
    progress.events.map(({ eventId, sessionId, model, modelProvider }) => ({
      eventId,
      sessionId,
      model,
      modelProvider,
    })),
    [
      {
        eventId: "session-progress:2",
        sessionId: "session-progress",
        model: "deepseek-flash",
        modelProvider: "provider-a",
      },
      {
        eventId: "session-progress:4",
        sessionId: "session-progress",
        model: "deepseek-v4-pro",
        modelProvider: "provider-b",
      },
    ],
  );
  assert.equal(progress.checkpoints.length, 2);
  assert.equal(progress.checkpoints[0].offset, firstFrame.length + headerFrame.length);
  assert.equal(progress.checkpoints[0].state.model, "deepseek-flash");
  assert.equal(progress.checkpoints[1].state.model, "deepseek-v4-pro");
});

test("a partial compressed append never advances the checkpoint and can resume after completion", async (t) => {
  const firstFrames = [
    frame([sessionRow()]),
    frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 7)]),
  ];
  const filePath = await fixtureFile(t, firstFrames);
  const initial = await collectWithProgress(filePath);
  const checkpoint = initial.checkpoints.at(-1);
  const nextFrame = frame([assistantRow(3, 11)]);
  const splitAt = Math.floor(nextFrame.length / 2);
  await fsPromises.appendFile(filePath, nextFrame.subarray(0, splitAt));

  const partialEvents = [];
  await assert.rejects(
    streamDshSessionEvents(filePath, SOURCE, (event) => partialEvents.push(event), {
      resume: checkpoint,
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    }),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED",
  );
  assert.deepEqual(partialEvents, []);

  await fsPromises.appendFile(filePath, nextFrame.subarray(splitAt));
  const resumed = await collectWithProgress(filePath, { resume: checkpoint });
  assert.equal(resumed.events[0].eventId, "session-progress:3");

  const secondCheckpoint = resumed.checkpoints.at(-1);
  await fsPromises.appendFile(filePath, frame([assistantRow(4, 15)]));
  const secondResume = await collectWithProgress(filePath, { resume: secondCheckpoint });
  const full = await collectSession(filePath);
  assert.deepEqual([...initial.events, ...resumed.events, ...secondResume.events], full.events);
  assert.equal(secondResume.events[0].eventId, "session-progress:4");
});

test("malformed frames, dictionaries, and unsupported session versions explicitly require full fallback", async (t) => {
  const validPrefix = frame([sessionRow(), requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 9)]);
  const malformedPath = await fixtureFile(t, [validPrefix, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3])]);
  const progressEvents = [];
  await assert.rejects(
    streamDshSessionEvents(malformedPath, SOURCE, (event) => progressEvents.push(event), {
      onProgress: () => {},
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    }),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED",
  );
  assert.deepEqual(progressEvents, []);
  const fallback = await collectSession(malformedPath);
  assert.equal(fallback.events.length, 1);
  assert.match(fallback.warnings[0], /损坏帧或空帧/);

  const dictionaryPayload = Buffer.from(rowsText([sessionRow()]));
  const dictionaryBlockHeader = Buffer.alloc(3);
  dictionaryBlockHeader.writeUIntLE((dictionaryPayload.length << 3) | 1, 0, 3);
  const dictionaryFrame = Buffer.concat([
    ZSTD_MAGIC,
    Buffer.from([0x21, 0x01, dictionaryPayload.length]),
    dictionaryBlockHeader,
    dictionaryPayload,
  ]);
  const dictionaryPath = await fixtureFile(t, [dictionaryFrame]);
  await assert.rejects(
    collectWithProgress(dictionaryPath),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED" && /dictionary/.test(error.message),
  );

  const versionPath = await fixtureFile(t, [
    frame([{ ...sessionRow(), version: 3 }]),
    frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 9)]),
  ]);
  await assert.rejects(
    collectWithProgress(versionPath),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED" && /v3/.test(error.message),
  );
  const versionFallback = await collectSession(versionPath);
  assert.equal(versionFallback.events.length, 0);
  assert.match(versionFallback.warnings[0], /格式版本/);
});

test("structural frame parsing ignores Zstandard magic bytes inside a raw payload", async (t) => {
  const header = Buffer.from(`${JSON.stringify({ ...sessionRow(), agentPreset: "__MAGIC__" })}\n`, "utf8");
  const markerAt = header.indexOf(Buffer.from("__MAGIC__", "utf8"));
  const embeddedMagicHeader = Buffer.concat([
    header.subarray(0, markerAt),
    ZSTD_MAGIC,
    header.subarray(markerAt + Buffer.byteLength("__MAGIC__")),
  ]);
  const checksumFrame = frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 13)], {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
  const filePath = await fixtureFile(t, [rawFrame(embeddedMagicHeader), checksumFrame]);

  const progress = await collectWithProgress(filePath);
  const checkpoint = progress.checkpoints.at(-1);
  assert.equal(progress.events.length, 1);
  assert.deepEqual(progress.warnings, []);
  assert.equal(checkpoint.offset, (await fsPromises.stat(filePath)).size);
  assert.equal(checkpoint.lineNumber, 3);
});

test("resume reads only the certified compressed suffix and honors a fixed endOffset", async (t) => {
  const filePath = await fixtureFile(t, [
    frame([sessionRow()]),
    frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 5)]),
  ]);
  const initial = await collectWithProgress(filePath);
  const checkpoint = initial.checkpoints.at(-1);
  const appended = frame([assistantRow(3, 8)]);
  await fsPromises.appendFile(filePath, appended);
  const fixedEnd = (await fsPromises.stat(filePath)).size;
  await fsPromises.appendFile(filePath, frame([assistantRow(4, 12)]));

  const originalOpen = fsPromises.open;
  const originalReadFile = fsPromises.readFile;
  const readPositions = [];
  let readFileCalls = 0;
  try {
    fsPromises.open = async function (...args) {
      const handle = await Reflect.apply(originalOpen, this, args);
      const originalRead = handle.read;
      handle.read = function (...readArgs) {
        readPositions.push(readArgs[3]);
        return Reflect.apply(originalRead, this, readArgs);
      };
      return handle;
    };
    fsPromises.readFile = function (...args) {
      readFileCalls += 1;
      return Reflect.apply(originalReadFile, this, args);
    };
    syncBuiltinESMExports();

    const resumed = await collectWithProgress(filePath, { resume: checkpoint, endOffset: fixedEnd });
    assert.deepEqual(
      resumed.events.map((event) => event.eventId),
      ["session-progress:3"],
    );
    assert.ok(readPositions.length > 0);
    assert.ok(readPositions.every((position) => position >= checkpoint.offset));
    assert.equal(readFileCalls, 0);
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
});

test("a many-frame backlog is consumed one bounded frame at a time", async (t) => {
  const frames = [frame([sessionRow()]), frame([requestRow(1, "deepseek-flash", "provider-a"), assistantRow(2, 2)])];
  for (let seq = 3; frames.length < 180; seq += 1) {
    frames.push(frame([assistantRow(seq, seq)]));
  }
  const backlog = Buffer.concat(frames);
  const filePath = await fixtureFile(t, frames);

  let readsInFlight = 0;
  let maxReadsInFlight = 0;
  let yieldedFrames = 0;
  let bufferedFrames = 0;
  let maxBufferedFrames = 0;
  let maxRequestedBytes = 0;
  const readAt = async (offset, length) => {
    readsInFlight += 1;
    maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
    maxRequestedBytes = Math.max(maxRequestedBytes, length);
    await Promise.resolve();
    try {
      return Buffer.from(backlog.subarray(offset, offset + length));
    } finally {
      readsInFlight -= 1;
    }
  };
  for await (const _frame of readZstdFrames(readAt, 0, backlog.length, { maxFrameBytes: 4096 })) {
    yieldedFrames += 1;
    bufferedFrames += 1;
    maxBufferedFrames = Math.max(maxBufferedFrames, bufferedFrames);
    bufferedFrames -= 1;
  }

  assert.equal(yieldedFrames, frames.length);
  assert.equal(maxBufferedFrames, 1);
  assert.equal(maxReadsInFlight, 1);
  assert.ok(maxRequestedBytes < backlog.length / 4);

  const originalOpen = fsPromises.open;
  const originalReadFile = fsPromises.readFile;
  const originalDecompress = zlib.zstdDecompressSync;
  let readFileCalls = 0;
  let decompressCalls = 0;
  let totalRequestedBytes = 0;
  let maxFileReadBytes = 0;
  let maxDecompressBytes = 0;
  try {
    fsPromises.open = async function (...args) {
      const handle = await Reflect.apply(originalOpen, this, args);
      const originalRead = handle.read;
      handle.read = function (...readArgs) {
        const length = readArgs[2];
        totalRequestedBytes += length;
        maxFileReadBytes = Math.max(maxFileReadBytes, length);
        return Reflect.apply(originalRead, this, readArgs);
      };
      return handle;
    };
    fsPromises.readFile = function (...args) {
      readFileCalls += 1;
      return Reflect.apply(originalReadFile, this, args);
    };
    zlib.zstdDecompressSync = function (...args) {
      decompressCalls += 1;
      maxDecompressBytes = Math.max(maxDecompressBytes, args[0].length);
      return Reflect.apply(originalDecompress, this, args);
    };
    syncBuiltinESMExports();

    const parsed = await collectWithProgress(filePath);
    assert.equal(parsed.events.length, frames.length - 1);
    assert.equal(parsed.checkpoints.length, frames.length);
    assert.equal(parsed.checkpoints.at(-1).offset, backlog.length);
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.readFile = originalReadFile;
    zlib.zstdDecompressSync = originalDecompress;
    syncBuiltinESMExports();
  }

  assert.equal(readFileCalls, 0);
  assert.equal(decompressCalls, frames.length);
  assert.ok(maxFileReadBytes < backlog.length / 4);
  assert.ok(maxDecompressBytes < backlog.length / 4);
  assert.ok(totalRequestedBytes < backlog.length + frames.length * 64);
});

test("oversized pending JSON triggers explicit full-parser fallback without losing the record", async (t) => {
  const oversized = assistantRow(3, 21);
  oversized.data.message.content[0].text = "x".repeat(1024 * 1024 + 4096);
  const line = Buffer.from(`${JSON.stringify(oversized)}\n`, "utf8");
  const splitAt = Math.floor(line.length / 2);
  const filePath = await fixtureFile(t, [
    frame([sessionRow()]),
    frame([requestRow(1, "deepseek-flash", "provider-a")]),
    frame(line.subarray(0, splitAt)),
  ]);
  await fsPromises.appendFile(filePath, frame(line.subarray(splitAt)));

  const progressEvents = [];
  await assert.rejects(
    streamDshSessionEvents(filePath, SOURCE, (event) => progressEvents.push(event), {
      onProgress: () => {},
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    }),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED" && /pending JSON/.test(error.message),
  );
  assert.deepEqual(progressEvents, []);

  const fallback = await collectSession(filePath);
  assert.deepEqual(
    fallback.events.map(({ eventId, usage }) => ({ eventId, output: usage.output })),
    [{ eventId: "session-progress:3", output: 21 }],
  );
});
