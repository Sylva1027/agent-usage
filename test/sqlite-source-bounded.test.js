import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseOpencodeDb, streamOpencodeDbEvents } from "../src/opencode-usage.js";
import { UsageSourceRows } from "../src/usage-source-rows.js";
import { parseZcodeDb, streamZcodeDbEvents } from "../src/zcode-usage.js";

const TIME = Date.parse("2026-10-20T12:00:00Z");
const adapters = {
  zcode: { stream: streamZcodeDbEvents, parse: parseZcodeDb, sessions: "session", usage: "model_usage" },
  opencode: {
    stream: streamOpencodeDbEvents,
    parse: parseOpencodeDb,
    sessions: "session_v2",
    usage: "session_message",
  },
};
const frozenRoot = new URL("../output/remaining-harnesses-20261105/baseline/src/", import.meta.url);
const frozenAvailable = Object.keys(adapters).every((kind) => existsSync(new URL(`${kind}-usage.js`, frozenRoot)));
const repositoryResolver = async (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });

function data(overrides = {}) {
  return JSON.stringify({
    time: { completed: TIME + 1000 },
    model: { id: "mimo-v2.6-flash", providerID: "fixture" },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
    ...overrides,
  });
}

function usage(kind, overrides = {}) {
  return kind === "zcode"
    ? {
        id: "event-1",
        session_id: "one",
        completed_at: TIME + 1000,
        started_at: TIME,
        input_tokens: 140,
        output_tokens: 25,
        reasoning_tokens: 5,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
        computed_total_tokens: 165,
        provider_total_tokens: 165,
        model_id: "mimo-v2.6-flash",
        provider_id: "fixture",
        query_source: "main_turn",
        task_type: "interactive",
        ...overrides,
      }
    : { id: "event-1", session_id: "one", type: "assistant", seq: 1, time_created: TIME, data: data(), ...overrides };
}

function insert(database, table, row) {
  const columns = Object.keys(row);
  database
    .prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

function fixture(
  t,
  kind,
  {
    sessions = [{ id: "one", directory: "/old", title: "old", version: "2.0.19" }],
    rows = [usage(kind)],
    metadata = "present",
    indexed = false,
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), `sqlite-source-${kind}-`));
  const file = path.join(root, "source.sqlite");
  const database = new DatabaseSync(file);
  t.after(() => {
    if (database.isOpen) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const adapter = adapters[kind];
  database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE ${adapter.usage} (${Object.keys(usage(kind)).join(",")});`);
  if (metadata !== "missing") {
    // No affinity or unique constraint: exercise the old String(id || "") Map keys.
    database.exec(
      `CREATE TABLE ${adapter.sessions} (id${indexed ? " TEXT PRIMARY KEY" : ""}, parent_id, directory, path, title, version, notes)`,
    );
    for (const session of sessions) insert(database, adapter.sessions, session);
    if (metadata === "missing-column") database.exec(`ALTER TABLE ${adapter.sessions} DROP COLUMN version`);
  }
  for (const row of rows) insert(database, adapter.usage, row);
  return { file, database, source: { id: kind, label: kind, path: root, kind } };
}

async function collect(stream, input, consumer) {
  const events = [],
    warnings = [];
  await stream(
    input.file,
    input.source,
    async (event) => {
      events.push(event);
      await consumer?.(event, events.length);
    },
    { repositoryResolver, onWarning: (warning) => warnings.push(warning) },
  );
  return { events, warnings };
}

async function frozen(kind) {
  const module = await import(new URL(`${kind}-usage.js`, frozenRoot).href);
  return kind === "zcode"
    ? { stream: module.streamZcodeDbEvents, parse: module.parseZcodeDb }
    : { stream: module.streamOpencodeDbEvents, parse: module.parseOpencodeDb };
}

async function assertParity(kind, input) {
  const actual = await collect(adapters[kind].stream, input);
  const actualWarnings = [];
  const parsed = await adapters[kind].parse(input.file, input.source, {
    repositoryResolver,
    onWarning: (warning) => actualWarnings.push(warning),
  });
  assert.deepEqual(actualWarnings, actual.warnings);
  assert.equal(parsed.events.length, actual.events.length);
  if (frozenAvailable) {
    const old = await frozen(kind);
    assert.deepEqual(actual, await collect(old.stream, input));
    const oldWarnings = [];
    assert.deepEqual(
      parsed,
      await old.parse(input.file, input.source, {
        repositoryResolver,
        onWarning: (warning) => oldWarnings.push(warning),
      }),
    );
    assert.deepEqual(actualWarnings, oldWarnings);
  }
  return actual;
}

function observe(t, input, iterationFailure) {
  // Exercise spill/recovery independently of the production working-set budget.
  const set = UsageSourceRows.prototype.set;
  t.mock.method(UsageSourceRows.prototype, "set", function (key, value) {
    this.maxBytes = Math.min(this.maxBytes, 1024 * 1024);
    return Reflect.apply(set, this, [key, value]);
  });
  const opened = new Set(),
    sourceReads = [];
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql, ...args) {
    opened.add(this);
    const source = this !== input.database && this.location() === input.database.location();
    if (source) {
      assert.equal(this.isTransaction, true, `read outside the source snapshot: ${sql}`);
      assert.equal(Reflect.apply(prepare, this, ["PRAGMA cache_size"]).get().cache_size, -2048);
      assert.equal(Reflect.apply(prepare, this, ["PRAGMA temp_store"]).get().temp_store, 1);
      sourceReads.push(sql);
    }
    const statement = Reflect.apply(prepare, this, [sql, ...args]);
    if (source && /FROM session(?:_v2)?$/.test(sql)) {
      statement.all = () => assert.fail("session metadata must stream");
      if (iterationFailure) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* () {
          for (const row of iterate()) {
            yield row;
            throw iterationFailure;
          }
        };
      }
    }
    return statement;
  });
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, "close", function (...args) {
    if (this !== input.database && this.location() === input.database.location()) {
      assert.equal(this.isTransaction, false, "source snapshot must roll back before close");
    }
    return Reflect.apply(close, this, args);
  });
  return { opened, sourceReads };
}

for (const kind of Object.keys(adapters)) {
  test(`${kind}: duplicate keys, BLOB metadata, knownness and spill`, async (t) => {
    for (const spill of [false, true]) {
      const sessions = [
        { id: 7, directory: "/loser", title: "loser", version: "1.0", notes: new Uint8Array(2 * 1024 * 1024) },
        { id: "one", directory: "/unused", title: "unused", version: "2" },
        ...(spill
          ? Array.from({ length: 18 }, (_, index) => ({ id: `padding-${index}`, title: "长".repeat(70000) }))
          : []),
        {
          id: "7",
          directory: new Uint8Array([47, 98]),
          path: "/ignored",
          title: new Uint8Array([65, 66]),
          version: "2.0",
        },
        { id: "empty-blob", directory: new Uint8Array(), path: "/must-not-fall-back", title: 0, version: 0 },
        { id: " spaced ", directory: "/must-not-trim-key", version: "2" },
        { id: 0, directory: "/zero-loser" },
        { id: null, directory: "/empty-key-winner" },
      ];
      const rows =
        kind === "zcode"
          ? [
              usage(kind, { id: "b", session_id: " 7 ", input_tokens: null, computed_total_tokens: null }),
              usage(kind, { id: "a", session_id: "empty-blob", query_source: "subagent", reasoning_tokens: -1 }),
              usage(kind, {
                id: "c",
                session_id: " spaced ",
                completed_at: 0,
                started_at: TIME + 3000,
                input_tokens: 300000,
                cache_read_input_tokens: "",
                cache_creation_input_tokens: null,
                computed_total_tokens: 300025,
              }),
              usage(kind, {
                id: "zero",
                input_tokens: 0,
                output_tokens: 0,
                reasoning_tokens: 0,
                cache_read_input_tokens: 0,
                computed_total_tokens: 0,
              }),
              usage(kind, { id: "invalid-time", completed_at: 0, started_at: 0 }),
            ]
          : [
              usage(kind, {
                id: "b",
                session_id: " 7 ",
                seq: 2,
                data: data({ tokens: { input: null, output: "20", reasoning: -1, cache: { read: 5 } } }),
              }),
              usage(kind, { id: "a", session_id: "empty-blob", seq: 1 }),
              usage(kind, {
                id: "c",
                session_id: " spaced ",
                seq: 3,
                data: data({
                  time: { completed: 0, created: TIME + 3000 },
                  model: {},
                  tokens: { input: 300000, output: 2, cache: { read: 0, write: null } },
                }),
              }),
              usage(kind, { id: "broken", data: "{" }),
              usage(kind, { id: "user", type: "user" }),
              usage(kind, { id: "missing-tokens", data: "{}" }),
              usage(kind, { id: "zero", data: data({ tokens: {} }) }),
              usage(kind, { id: "invalid-time", time_created: 0, data: data({ time: {} }) }),
            ];
      const input = fixture(t, kind, { sessions, rows });
      const watched = observe(t, input);
      const actual = await collect(adapters[kind].stream, input);
      t.mock.restoreAll();
      assert.equal(watched.sourceReads.filter((sql) => /FROM session(?:_v2)?$/.test(sql)).length, 1);
      assert.equal(watched.sourceReads.filter((sql) => sql.includes(`FROM ${adapters[kind].usage} `)).length, 1);
      assert.ok([...watched.opened].every((database) => !database.isOpen));
      assert.equal([...watched.opened].length > 1, spill);
      assert.deepEqual(actual, await assertParity(kind, input));
      const duplicate = actual.events.find((event) => event.sessionId === "7");
      assert.equal(duplicate.project, "47,98");
      assert.equal(duplicate.conversationName, "65,66");
      assert.deepEqual(
        duplicate.usage,
        kind === "zcode"
          ? { total: 165, input: 0, cached: 30, output: 25, reasoning: 5 }
          : { total: 25, input: 5, cached: 5, output: 20, reasoning: 0 },
      );
      assert.deepEqual(
        [duplicate.detailMask, duplicate.reconciliationGap, duplicate.requestInputTokens, duplicate.contextLevel],
        [kind === "zcode" ? 14 : 6, 0, 0, "unknown"],
      );
      assert.deepEqual(
        [duplicate.cacheWriteTokens, duplicate.cacheWriteKnown],
        kind === "zcode" ? [10, true] : [0, false],
      );
      assert.deepEqual(
        actual.events.map((event) => [event.eventId, event.sessionId, event.timestampMs]),
        kind === "zcode"
          ? [
              ["c", "spaced", TIME + 3000],
              ["a", "empty-blob", TIME + 1000],
              ["b", "7", TIME + 1000],
            ]
          : [
              ["7:2", "7", TIME + 1000],
              ["spaced:3", "spaced", TIME + 3000],
            ],
      );
      const long = actual.events.find((event) => event.sessionId === "spaced");
      assert.deepEqual(
        [long.project, long.conversationName, long.contextLevel, long.requestInputTokens],
        ["", "", "long", 300000],
      );
      assert.deepEqual(
        [long.cacheWriteTokens, long.cacheWriteKnown, long.detailMask],
        [0, false, kind === "zcode" ? 13 : 7],
      );
      assert.deepEqual(
        long.usage,
        kind === "zcode"
          ? { total: 300025, input: 300000, cached: 0, output: 25, reasoning: 5 }
          : { total: 300002, input: 300000, cached: 0, output: 2, reasoning: 0 },
      );
      if (kind === "zcode") {
        const subagent = actual.events.find((event) => event.sessionId === "empty-blob");
        assert.deepEqual(
          [subagent.project, subagent.conversationName, subagent.channel, subagent.detailMask],
          ["/empty-key-winner", "", "ZCode Subagent", 7],
        );
        assert.deepEqual(actual.warnings, []);
      } else {
        assert.deepEqual([long.model, long.modelProvider], ["Unknown model", ""]);
        assert.deepEqual(actual.warnings, [
          "OpenCode 会话 empty-blob 的版本为 v0，本版本只支持 v2，已跳过",
          "OpenCode 会话 spaced 缺少可解析的版本号，已按 v2 解析",
        ]);
      }
    }
  });

  for (const metadata of ["missing", "empty", ...(kind === "opencode" ? ["missing-column"] : [])]) {
    test(`${kind}: ${metadata} optional metadata still emits usage`, async (t) => {
      const input = fixture(t, kind, { metadata, sessions: [] });
      const actual = await assertParity(kind, input);
      assert.equal(actual.events.length, 1);
      assert.equal(actual.events[0].project, "");
      assert.equal(actual.events[0].conversationName, "");
      assert.deepEqual(actual.events[0].usage, { total: 165, input: 140, cached: 30, output: 25, reasoning: 5 });
      assert.deepEqual(
        [actual.events[0].eventId, actual.events[0].sessionId, actual.events[0].detailMask],
        [kind === "zcode" ? "event-1" : "one:1", "one", kind === "zcode" ? 15 : 47],
      );
      assert.deepEqual(
        actual.warnings,
        kind === "zcode"
          ? []
          : [
              `OpenCode 数据库 ${input.file} 没有会话表或会话为空，工作目录与标题将缺失`,
              "OpenCode 会话 one 缺少可解析的版本号，已按 v2 解析",
            ],
      );
    });
  }

  for (const { phase, indexed } of [false, true].flatMap((indexed) =>
    ["between metadata and usage", "in the first async consumer"].map((phase) => ({ phase, indexed })),
  )) {
    test(`${kind}: ${indexed ? "indexed" : "fallback"} WAL snapshot ${phase}, then revision/delete and lower IDs on re-read`, async (t) => {
      const rows = [1, 2, 3].map((index) =>
        usage(kind, {
          id: `event-${index}`,
          ...(kind === "zcode"
            ? { completed_at: TIME + index * 1000 }
            : { seq: index, data: data({ time: { completed: TIME + index * 1000 } }) }),
        }),
      );
      const input = fixture(t, kind, { rows, indexed });
      const before = await collect(adapters[kind].stream, input);
      assert.deepEqual(
        before.events.map((event) => [
          event.eventId,
          event.timestampMs,
          event.project,
          event.conversationName,
          event.usage.output,
        ]),
        [
          [kind === "zcode" ? "event-1" : "one:1", TIME + 1000, "/old", "old", 25],
          [kind === "zcode" ? "event-2" : "one:2", TIME + 2000, "/old", "old", 25],
          [kind === "zcode" ? "event-3" : "one:3", TIME + 3000, "/old", "old", 25],
        ],
      );
      assert.deepEqual(before.warnings, []);
      const revise = () => {
        const { database } = input;
        database.exec("BEGIN");
        database.prepare(`UPDATE ${adapters[kind].sessions} SET title='new', directory='/new'`).run();
        if (kind === "zcode") {
          database
            .prepare("UPDATE model_usage SET output_tokens=75, computed_total_tokens=215 WHERE id='event-2'")
            .run();
        } else {
          database.prepare("UPDATE session_message SET data=? WHERE id='event-2'").run(
            data({
              time: { completed: TIME + 2000 },
              tokens: { input: 100, output: 70, reasoning: 5, cache: { read: 30, write: 10 } },
            }),
          );
        }
        database.prepare(`DELETE FROM ${adapters[kind].usage} WHERE id='event-3'`).run();
        insert(
          database,
          adapters[kind].usage,
          usage(kind, { id: "event-0", ...(kind === "opencode" ? { seq: 0 } : {}) }),
        );
        database.exec("COMMIT");
      };
      if (phase === "between metadata and usage") {
        const prepare = DatabaseSync.prototype.prepare;
        let revised = false;
        t.mock.method(DatabaseSync.prototype, "prepare", function (sql, ...args) {
          if (this !== input.database && sql.includes(`FROM ${adapters[kind].usage} `) && !revised) {
            revised = true;
            revise();
          }
          return Reflect.apply(prepare, this, [sql, ...args]);
        });
      }
      const during = await collect(adapters[kind].stream, input, async (_event, count) => {
        if (phase === "in the first async consumer" && count === 1) {
          await new Promise((resolve) => setImmediate(resolve));
          revise();
        }
      });
      t.mock.restoreAll();
      assert.deepEqual(during, before);
      const after = await collect(adapters[kind].stream, input);
      assert.equal(after.events.length, 3);
      assert.deepEqual(
        after.events.map((event) => event.eventId),
        kind === "zcode" ? ["event-0", "event-1", "event-2"] : ["one:0", "one:1", "one:2"],
      );
      assert.ok(after.events.every((event) => event.project === "/new" && event.conversationName === "new"));
      assert.equal(after.events.find((event) => event.timestampMs === TIME + 2000).usage.output, 75);
      assert.ok(after.events.every((event) => event.timestampMs !== TIME + 3000));
      assert.deepEqual(
        after.events.map((event) => event.usage.total),
        [165, 165, 215],
      );
      assert.deepEqual(after.warnings, []);
      if (frozenAvailable) assert.deepEqual(after, await collect((await frozen(kind)).stream, input));
      const checkpoint = input.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      assert.equal(checkpoint.busy, 0, "snapshot must release its WAL reader");
    });
  }

  for (const failureStage of ["consumer", "metadata iterator", "scratch write"]) {
    test(`${kind}: ${failureStage} failure closes source transaction and partial spilled collections`, async (t) => {
      const input = fixture(t, kind, {
        sessions: [
          { id: "one", directory: "/old", title: "x".repeat(2 * 1024 * 1024), version: "2" },
          { id: "two", directory: "/other", title: "other", version: "2" },
        ],
      });
      const failure = new Error(`test ${failureStage} failure`);
      const watched = observe(t, input, failureStage === "metadata iterator" ? failure : undefined);
      if (failureStage === "scratch write") {
        const set = UsageSourceRows.prototype.set;
        t.mock.method(UsageSourceRows.prototype, "set", function (key, value) {
          if (key === "two") throw failure;
          return Reflect.apply(set, this, [key, value]);
        });
      }
      await assert.rejects(
        collect(adapters[kind].stream, input, async () => {
          if (failureStage === "consumer") throw failure;
        }),
        (error) => error === failure,
      );
      assert.ok(watched.opened.size >= 2, "the metadata collection must have spilled");
      assert.ok([...watched.opened].every((database) => !database.isOpen));
      t.mock.restoreAll();
      assert.equal(input.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
      const reopened = await collect(adapters[kind].stream, input);
      assert.equal(reopened.events.length, 1);
      assert.deepEqual(
        [reopened.events[0].sessionId, reopened.events[0].project, reopened.events[0].conversationName],
        ["one", "/old", `${"x".repeat(120)}…`],
      );
      assert.deepEqual(reopened.events[0].usage, { total: 165, input: 140, cached: 30, output: 25, reasoning: 5 });
      assert.deepEqual(reopened.warnings, []);
    });
  }
}

test("ZCode: parent recursion at depth five, depth six and cycles", async (t) => {
  const sessions = [
    ...Array.from({ length: 7 }, (_, depth) => ({
      id: `p${depth}`,
      parent_id: `p${depth + 1}`,
      directory: depth === 6 ? "/root" : "",
      title: `title-${depth}`,
    })),
    { id: "cycle-a", parent_id: "cycle-b" },
    { id: "cycle-b", parent_id: "cycle-a" },
    { id: "blob-parent", parent_id: new Uint8Array([55]) },
    { id: "55", path: "/blob-parent-root" },
  ];
  const input = fixture(t, "zcode", {
    sessions,
    rows: ["p0", "p1", "cycle-a", "blob-parent"].map((session_id, index) =>
      usage("zcode", { id: `e${index}`, session_id }),
    ),
  });
  const actual = await assertParity("zcode", input);
  assert.deepEqual(
    actual.events.map((event) => event.sessionId),
    ["p0", "p1", "cycle-a", "blob-parent"],
  );
  assert.deepEqual(actual.warnings, []);
  assert.deepEqual(
    actual.events.map((event) => event.project),
    ["", "/root", "", "/blob-parent-root"],
  );
  assert.deepEqual(
    actual.events.map((event) => event.conversationName),
    ["title-0", "title-1", "", ""],
  );
});

test("OpenCode: version/missing warning dedup stays exact after both collections spill", async (t) => {
  const ids = Array.from({ length: 20 }, (_, index) => `session-${index}-`.padEnd(70000, "x"));
  const sessions = ids.map((id, index) => ({ id, title: "title", version: index % 2 ? null : "1.9.0" }));
  sessions.push({ id: "bad-version", version: "abc" }, { id: "future-version", version: "3.1" });
  const keys = [...ids, "bad-version", "future-version", "orphan"];
  const rows = [0, 1].flatMap((pass) =>
    keys.map((id, index) =>
      usage("opencode", {
        id: `message-${pass}-${index}`,
        session_id: pass ? ` ${id} ` : id,
        seq: pass * keys.length + index,
      }),
    ),
  );
  const input = fixture(t, "opencode", { sessions, rows });
  const watched = observe(t, input);
  const actual = await collect(streamOpencodeDbEvents, input);
  t.mock.restoreAll();
  assert.ok(watched.opened.size >= 3, "source, metadata spill and warning spill must all be exercised");
  assert.ok([...watched.opened].every((database) => !database.isOpen));
  assert.deepEqual(actual, await assertParity("opencode", input));
  assert.equal(actual.warnings.length, 22);
  assert.equal(actual.events.length, 26);
  assert.deepEqual(actual.warnings, [
    ...ids.map((id, index) =>
      index % 2
        ? `OpenCode 会话 ${id} 缺少可解析的版本号，已按 v2 解析`
        : `OpenCode 会话 ${id} 的版本为 v1.9.0，本版本只支持 v2，已跳过`,
    ),
    "OpenCode 会话 bad-version 缺少可解析的版本号，已按 v2 解析",
    "OpenCode 会话 orphan 缺少可解析的版本号，已按 v2 解析",
  ]);
  const allowed = [...ids.filter((_id, index) => index % 2), "bad-version", "future-version", "orphan"];
  assert.deepEqual(
    actual.events.map((event) => event.sessionId),
    [...allowed, ...allowed],
  );
  assert.deepEqual(
    actual.events.map((event) => event.conversationName),
    [0, 1].flatMap(() => [...Array(10).fill("title"), "", "", ""]),
  );
});
