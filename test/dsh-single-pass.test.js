import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import zlib from "node:zlib";

import { streamDshSessionEvents } from "../src/dsh-usage.js";

const T = Date.parse("2026-11-03T08:00:00.000Z");
const SOURCE = Object.freeze({ id: "home-single-pass", label: "Single pass", path: tmpdir() });
const NEGATIVE_ZERO = "__DSH_NEGATIVE_ZERO__";

function sessionRow({ id = "session-single-pass", version = 4, cwd = "E:\\work\\project" } = {}) {
  return {
    type: "session",
    version,
    id,
    cwd,
    createdAt: T,
    delegationDepth: 0,
    agentPreset: "standard",
  };
}

function requestRow({ seq = 1, model = "deepseek-chat" } = {}) {
  return {
    type: "request/header",
    seq,
    time: T + seq,
    data: { header: { config: { model, provider: "deepseek-account" } } },
  };
}

function titleRow(seq, title) {
  return { type: "session/title", seq, time: T + seq, data: { title } };
}

function assistantRow(seq, usage) {
  return {
    type: "assistant/message",
    seq,
    time: T + seq,
    data: { turn: 1, step: seq, usage },
  };
}

function rowText(row) {
  return JSON.stringify(row).replaceAll(`"${NEGATIVE_ZERO}"`, "-0");
}

function rowsText(rows) {
  return `${rows.map(rowText).join("\n")}\n`;
}

function frame(value) {
  return zlib.zstdCompressSync(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
}

function damagedFrame() {
  return Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]);
}

async function fixtureRoot(t) {
  const root = await fsPromises.mkdtemp(path.join(tmpdir(), "dsh-single-pass-"));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSession(root, name, frames) {
  const directory = path.join(root, "sessions", "fixture", name);
  await fsPromises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "session.v4.jsonl.zstd");
  await fsPromises.writeFile(filePath, Buffer.concat(frames));
  return filePath;
}

async function withBuiltinReadSpies(run) {
  const originalReadFile = fsPromises.readFile;
  const originalDecompress = zlib.zstdDecompressSync;
  const counts = { readFile: 0, decompress: 0 };
  try {
    fsPromises.readFile = function (...args) {
      counts.readFile += 1;
      return Reflect.apply(originalReadFile, this, args);
    };
    zlib.zstdDecompressSync = function (...args) {
      counts.decompress += 1;
      return Reflect.apply(originalDecompress, this, args);
    };
    syncBuiltinESMExports();
    return await run(counts);
  } finally {
    fsPromises.readFile = originalReadFile;
    zlib.zstdDecompressSync = originalDecompress;
    syncBuiltinESMExports();
  }
}

function withDatabaseSyncSpy(run, { failTemporaryInsert = false } = {}) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalClose = DatabaseSync.prototype.close;
  const observations = [];
  const byDatabase = new Map();

  const observe = (database) => {
    let record = byDatabase.get(database);
    if (!record) {
      record = {
        database,
        filename: database.filename,
        location: database.location(),
        temporary: database.location() === null,
        inserts: 0,
        selects: 0,
        closeCalls: 0,
        isOpenAfterClose: null,
      };
      byDatabase.set(database, record);
      observations.push(record);
    }
    return record;
  };

  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const record = observe(this);
    const statementType = String(sql).trim().split(/\s+/, 1)[0].toUpperCase();
    if (statementType === "INSERT") record.inserts += 1;
    if (statementType === "SELECT") record.selects += 1;
    const statement = Reflect.apply(originalPrepare, this, [sql, ...args]);
    if (failTemporaryInsert && record.temporary && statementType === "INSERT") {
      throw new Error("temporary insert failure");
    }
    return statement;
  };
  DatabaseSync.prototype.close = function (...args) {
    const record = observe(this);
    record.closeCalls += 1;
    try {
      return Reflect.apply(originalClose, this, args);
    } finally {
      record.isOpenAfterClose = this.isOpen;
    }
  };

  return Promise.resolve()
    .then(() => run(observations))
    .finally(() => {
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.close = originalClose;
    });
}

test("session events scan once while preserving row order across damaged input", { concurrency: false }, async (t) => {
  const root = await fixtureRoot(t);
  const title = rowText(titleRow(2, "line crosses a zstd frame"));
  const splitAt = Math.floor(title.length / 2);
  const ordinaryPath = await writeSession(root, "ordinary", [
    frame(`${rowText(sessionRow())}\n${rowText(requestRow())}\n${title.slice(0, splitAt)}`),
    frame(
      `${title.slice(splitAt)}\n${rowText(assistantRow(3, { inputTokens: 7, outputTokens: 11 }))}\n{"type":"broken"\n`,
    ),
    damagedFrame(),
    frame(
      `${rowText(sessionRow({ id: "duplicate-ignored", cwd: "E:\\wrong" }))}\n` +
        `${rowText(assistantRow(4, { inputTokens: 5, outputTokens: 13 }))}\n`,
    ),
  ]);
  const latePath = await writeSession(root, "late", [
    frame(
      `${rowText(requestRow({ model: "late-model" }))}\n${rowText(assistantRow(1, { inputTokens: 2, outputTokens: 3 }))}\n`,
    ),
    frame(`${rowText(sessionRow({ id: "late-session" }))}\n`),
    frame(
      `${rowText(sessionRow({ id: "duplicate-ignored", cwd: "E:\\wrong" }))}\n` +
        `${rowText(assistantRow(2, { inputTokens: 4, outputTokens: 6 }))}\n`,
    ),
  ]);

  await withBuiltinReadSpies(async (counts) => {
    const ordinary = [];
    const ordinaryWarnings = [];
    await streamDshSessionEvents(ordinaryPath, SOURCE, (event) => ordinary.push(event), {
      onWarning: (warning) => ordinaryWarnings.push(warning),
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    });
    const ordinaryCounts = { ...counts };

    const late = [];
    await streamDshSessionEvents(latePath, SOURCE, (event) => late.push(event), {
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    });

    assert.deepEqual(
      ordinary.map(({ eventId, conversationName, usage }) => ({
        eventId,
        conversationName,
        output: usage.output,
      })),
      [
        { eventId: "session-single-pass:3", conversationName: "line crosses a zstd frame", output: 11 },
        { eventId: "session-single-pass:4", conversationName: "line crosses a zstd frame", output: 13 },
      ],
    );
    assert.deepEqual(
      ordinaryWarnings.map((warning) => (warning.startsWith("MALFORMED_JSON:") ? "json" : "frame")),
      ["frame", "json"],
    );
    assert.deepEqual(
      late.map(({ eventId, sessionId, model }) => ({ eventId, sessionId, model })),
      [
        { eventId: "late-session:1", sessionId: "late-session", model: "late-model" },
        { eventId: "late-session:2", sessionId: "late-session", model: "late-model" },
      ],
    );
    assert.deepEqual(
      {
        ordinary: ordinaryCounts,
        late: {
          readFile: counts.readFile - ordinaryCounts.readFile,
          decompress: counts.decompress - ordinaryCounts.decompress,
        },
      },
      { ordinary: { readFile: 1, decompress: 4 }, late: { readFile: 1, decompress: 3 } },
    );
  });
});

test("a single projection over 1 MiB spills without losing amounts or order", { concurrency: false }, async (t) => {
  const root = await fixtureRoot(t);
  const oversizedPadding = "x".repeat(1024 * 1024 + 64 * 1024);
  const filePath = await writeSession(root, "oversized", [
    frame(
      rowsText([
        assistantRow(1, { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, totalTokens: 10 }),
        assistantRow(2, {
          inputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: NEGATIVE_ZERO,
          totalTokens: 8,
        }),
        requestRow({ seq: 3, model: oversizedPadding }),
        assistantRow(3, {
          inputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          outputTokens: 4,
          totalTokens: 10,
        }),
        requestRow({ seq: 4, model: "deepseek-chat" }),
        titleRow(5, "spilled title"),
        assistantRow(4, {
          inputTokens: 9,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
          outputTokens: 2,
          totalTokens: 17.9,
        }),
      ]),
    ),
    frame(rowsText([sessionRow(), sessionRow({ id: "duplicate-ignored", cwd: "E:\\wrong" })])),
  ]);

  await withDatabaseSyncSpy(async (observations) => {
    const events = [];
    await streamDshSessionEvents(filePath, SOURCE, (event) => events.push(event), {
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    });

    assert.deepEqual(
      events.map(({ eventId, model, conversationName }) => ({ eventId, model, conversationName })),
      [
        { eventId: "session-single-pass:1", model: "Unknown model", conversationName: "" },
        { eventId: "session-single-pass:2", model: "Unknown model", conversationName: "" },
        { eventId: "session-single-pass:3", model: oversizedPadding, conversationName: "" },
        { eventId: "session-single-pass:4", model: "deepseek-chat", conversationName: "spilled title" },
      ],
    );
    assert.deepEqual(
      events.map(({ usage }) => usage),
      [
        { total: 10, input: 6, cached: 2, output: 4, reasoning: 0 },
        { total: 8, input: 8, cached: 0, output: -0, reasoning: 0 },
        { total: 10, input: 6, cached: 2, output: 4, reasoning: 0 },
        { total: 17, input: 13, cached: 4, output: 2, reasoning: 0 },
      ],
    );
    assert.equal(Object.is(events[1].usage.output, -0), true);
    assert.equal(events[3].reconciliationGap, 2);
    assert.deepEqual(Object.keys(events[2].usage), ["total", "input", "cached", "output", "reasoning"]);

    const spilled = observations.filter((record) => record.temporary && record.inserts > 0);
    assert.equal(spilled.length, 1);
    assert.ok(spilled[0].inserts >= 1);
    assert.equal(spilled[0].selects, 1);
    assert.equal(spilled[0].closeCalls, 1);
  });
});

test("spilled staging is closed after callbacks fail or the header is rejected", { concurrency: false }, async (t) => {
  const root = await fixtureRoot(t);
  const oversizedUsage = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  };
  const oversizedRequest = requestRow({ model: "x".repeat(1024 * 1024 + 32 * 1024) });
  const validPath = await writeSession(root, "cleanup-valid", [
    frame(rowsText([sessionRow(), oversizedRequest, assistantRow(1, oversizedUsage)])),
    damagedFrame(),
  ]);
  const unsupportedPath = await writeSession(root, "cleanup-unsupported", [
    frame(rowsText([sessionRow({ version: 3 }), oversizedRequest, assistantRow(1, oversizedUsage)])),
  ]);
  const missingHeaderPath = await writeSession(root, "cleanup-missing", [
    frame(rowsText([oversizedRequest, assistantRow(1, oversizedUsage)])),
  ]);

  await withDatabaseSyncSpy(async (observations) => {
    const expectCleanup = async (label, run) => {
      const start = observations.length;
      await run();
      const created = observations.slice(start).filter((record) => record.temporary && record.inserts > 0);
      assert.equal(created.length, 1, `${label}: expected one spill database`);
      const record = created[0];
      assert.equal(record.filename ?? "", "", `${label}: staging must use the empty SQLite filename`);
      assert.equal(record.location, null, `${label}: staging must be a private temporary database`);
      assert.equal(record.closeCalls, 1, `${label}: temporary database must close exactly once`);
      assert.equal(record.isOpenAfterClose, false, `${label}: temporary database must be closed`);
    };

    await expectCleanup("warning callback", () =>
      assert.rejects(
        streamDshSessionEvents(validPath, SOURCE, () => {}, {
          onWarning: () => {
            throw new Error("warning failure");
          },
          repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
        }),
        /warning failure/,
      ),
    );
    await expectCleanup("repository resolver", () =>
      assert.rejects(
        streamDshSessionEvents(validPath, SOURCE, () => {}, {
          repositoryResolver: () => Promise.reject(new Error("repository failure")),
        }),
        /repository failure/,
      ),
    );
    await expectCleanup("synchronous event callback", () =>
      assert.rejects(
        streamDshSessionEvents(
          validPath,
          SOURCE,
          () => {
            throw new Error("event throw");
          },
          { repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }) },
        ),
        /event throw/,
      ),
    );
    await expectCleanup("rejected event callback", () =>
      assert.rejects(
        streamDshSessionEvents(validPath, SOURCE, () => Promise.reject(new Error("event rejection")), {
          repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
        }),
        /event rejection/,
      ),
    );
    await expectCleanup("unsupported header", () =>
      streamDshSessionEvents(unsupportedPath, SOURCE, () => {}, {
        repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
      }),
    );
    await expectCleanup("missing header", () =>
      streamDshSessionEvents(missingHeaderPath, SOURCE, () => {}, {
        repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
      }),
    );
  });
});

test("a failed temporary insert skips events, closes staging, and leaves file databases writable", {
  concurrency: false,
}, async (t) => {
  const root = await fixtureRoot(t);
  const filePath = await writeSession(root, "insert-failure", [
    frame(rowsText([sessionRow(), requestRow({ model: "x".repeat(1024 * 1024 + 32 * 1024) })])),
    frame(
      rowsText([
        assistantRow(1, {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        }),
      ]),
    ),
  ]);

  await withDatabaseSyncSpy(
    async (observations) => {
      let eventCalls = 0;
      await assert.rejects(
        streamDshSessionEvents(
          filePath,
          SOURCE,
          () => {
            eventCalls += 1;
          },
          { repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }) },
        ),
        /temporary insert failure/,
      );

      const mainDatabase = new DatabaseSync(path.join(root, "unaffected-main.sqlite"));
      try {
        mainDatabase.exec("CREATE TABLE fixtures (value INTEGER NOT NULL)");
        mainDatabase.prepare("INSERT INTO fixtures VALUES (?)").run(17);
        assert.equal(mainDatabase.prepare("SELECT value FROM fixtures").get().value, 17);
      } finally {
        mainDatabase.close();
      }

      const spilled = observations.filter((record) => record.temporary && record.inserts > 0);
      assert.equal(eventCalls, 0);
      assert.equal(spilled.length, 1);
      assert.equal(spilled[0].closeCalls, 1);
      assert.equal(spilled[0].isOpenAfterClose, false);
    },
    { failTemporaryInsert: true },
  );
});

test("unused deep usage metadata is not retained or serialized", { concurrency: false }, async (t) => {
  const root = await fixtureRoot(t);
  const nested = `${"[".repeat(10000)}0${"]".repeat(10000)}`;
  const row = `{"type":"assistant/message","seq":1,"time":${T},"data":{"usage":{"inputTokens":1,"outputTokens":2,"unused":${nested}}}}`;
  const filePath = await writeSession(root, "ignored-metadata", [frame(`${rowText(sessionRow())}\n${row}\n`)]);
  await withDatabaseSyncSpy(async (observations) => {
    const events = [];
    await streamDshSessionEvents(filePath, SOURCE, (event) => events.push(event), {
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "fixture" }),
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].usage, { total: 3, input: 1, cached: 0, output: 2, reasoning: 0 });
    assert.equal(observations.length, 0);
  });
});
