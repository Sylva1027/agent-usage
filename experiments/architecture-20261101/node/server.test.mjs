import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import test from "node:test";

import { makeFixture, writeRawFixture } from "../fixture.mjs";
import { collectAndCommit } from "./collector.mjs";
import { AggregateOverflowError, aggregateEvents } from "./query.mjs";
import { startServer } from "./server.mjs";
import { SqliteStore } from "./store.mjs";

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function jsonRequest(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test("HTTP report preserves context and original event fields across restart and freeze", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-http-"));
  const database = path.join(directory, "usage.sqlite");
  const web = path.join(directory, "web.html");
  await writeFile(web, "<!doctype html><title>prototype</title>");
  let runtime = await startServer({ database, port: 0, web });

  try {
    const fixture = makeFixture(18);
    const health = await jsonRequest(runtime.baseUrl, "/api/health");
    assert.deepEqual(health.payload, { ok: true, backend: "node-sqlite" });

    const committed = await jsonRequest(runtime.baseUrl, "/api/commit", fixture);
    assert.deepEqual(committed.payload, { revision: 1, eventCount: fixture.events.length });
    const report = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;
    assert.equal(report.revision, 1);
    assert.deepEqual(report.context, fixture.context);
    assert.deepEqual(report.cursors, { [fixture.sourceId]: fixture.cursor });
    const cursorState = (await jsonRequest(runtime.baseUrl, "/api/cursors")).payload;
    assert.deepEqual(cursorState, {
      revision: 1,
      cursors: { [fixture.sourceId]: fixture.cursor },
    });
    assert.deepEqual(Object.keys(cursorState).sort(), ["cursors", "revision"]);
    assert.deepEqual(
      report.events.find((event) => event.eventId === fixture.events[0].eventId),
      fixture.events[0],
    );
    assert.deepEqual(
      report.events.map((event) => [event.timestamp, event.eventId]),
      [...fixture.events]
        .sort((left, right) =>
          left.timestamp < right.timestamp
            ? -1
            : left.timestamp > right.timestamp
              ? 1
              : left.sourceId < right.sourceId
                ? -1
                : left.sourceId > right.sourceId
                  ? 1
                  : left.eventId < right.eventId
                    ? -1
                    : left.eventId > right.eventId
                      ? 1
                      : 0,
        )
        .map((event) => [event.timestamp, event.eventId]),
    );

    const query = (
      await jsonRequest(
        runtime.baseUrl,
        `/api/query?start=${encodeURIComponent(fixture.events[17].timestamp)}&end=${encodeURIComponent(fixture.events[0].timestamp)}`,
      )
    ).payload;
    assert.equal(query.revision, 1);
    assert.equal(query.eventCount, fixture.events.length);
    assert.equal(query.sessionCount, new Set(fixture.events.map((event) => event.sessionId)).size);
    assert.equal(query.homeCount, 6);

    const frozen = await jsonRequest(runtime.baseUrl, "/api/freeze", {});
    assert.deepEqual(frozen.payload, { snapshot: 1 });

    const later = {
      sourceId: "later-source",
      events: [
        {
          eventId: "later-1",
          timestamp: "2026-11-02T00:00:00.000Z",
          sessionId: "later-session",
          homeId: "later-home",
          total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
        },
      ],
      cursor: { later: true },
      context: { generatedAt: "2026-11-02T00:00:00.000Z", homes: [] },
    };
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/commit", later)).payload, {
      revision: 2,
      eventCount: 1,
    });

    const frozenReport = (await jsonRequest(runtime.baseUrl, "/api/report?snapshot=1")).payload;
    assert.equal(frozenReport.revision, 1);
    assert.deepEqual(frozenReport.context, fixture.context);
    assert.equal(frozenReport.events.length, fixture.events.length);

    const duplicate = structuredClone(fixture);
    duplicate.events.push(structuredClone(duplicate.events[0]));
    const invalid = await jsonRequest(runtime.baseUrl, "/api/commit", duplicate);
    assert.equal(invalid.response.status, 400);
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/status")).payload.revision, 2);
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/report?snapshot=999")).response.status, 404);

    await runtime.close();
    runtime = await startServer({ database, port: 0, web });
    const restored = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;
    assert.equal(restored.revision, 2);
    assert.deepEqual(restored.context, later.context);
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/report?snapshot=1")).payload.events.length, 18);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite commit rolls back source replacement when serialization fails", async () => {
  const directory = path.resolve(tmpdir());
  const databasePath = path.join(
    directory,
    `architecture-atomic-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  const store = new SqliteStore(databasePath);
  try {
    const event = {
      eventId: "event-1",
      timestamp: "2026-11-01T12:00:00.000Z",
      sessionId: "session",
      homeId: "home",
      total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
    };
    store.commit("source", [event], { version: 1 }, { homes: [] });
    const before = store.report();

    const circular = { ...event, eventId: "event-2", extra: {} };
    circular.extra.self = circular.extra;
    assert.throws(() => store.commit("source", [circular], { version: 2 }), /circular/i);
    assert.deepEqual(store.report(), before);
    assert.equal(store.status().revision, 1);
  } finally {
    store.close();
    await rm(databasePath, { force: true });
  }
});

test("expectedCursor makes source replacement atomic and returns 409 on conflict", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-cursor-cas-"));
  const runtime = await startServer({ database: path.join(directory, "usage.sqlite"), port: 0 });
  try {
    const firstEvent = {
      eventId: "first",
      timestamp: "2026-11-01T01:00:00.000Z",
      sessionId: "session",
      homeId: "home",
      total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
    };
    const secondEvent = { ...firstEvent, eventId: "second", timestamp: "2026-11-01T02:00:00.000Z" };
    const firstCursor = { version: 1 };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source",
      events: [firstEvent],
      cursor: firstCursor,
      context: { marker: "old" },
      expectedCursor: null,
    });
    const before = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;

    const stale = await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source",
      events: [secondEvent],
      cursor: { version: 2 },
      context: { marker: "stale" },
      expectedCursor: { version: 0 },
    });
    assert.equal(stale.response.status, 409);
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/report")).payload, before);

    const existingAsAbsent = await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source",
      events: [secondEvent],
      cursor: { version: 2 },
      expectedCursor: null,
    });
    assert.equal(existingAsAbsent.response.status, 409);

    const accepted = await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source",
      events: [secondEvent],
      cursor: { version: 2 },
      context: { marker: "new" },
      expectedCursor: firstCursor,
    });
    assert.deepEqual(accepted.payload, { revision: 2, eventCount: 1 });
    const after = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;
    assert.deepEqual(after.events.map((event) => event.eventId), ["second"]);
    assert.deepEqual(after.context, { marker: "new" });
    assert.deepEqual(after.cursors, { source: { version: 2 } });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query counts one session across homes in totals, groups, and timeline", () => {
  const totals = { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 };
  const aggregate = aggregateEvents([
    {
      eventId: "a",
      timestamp: "2026-11-01T01:00:00.000Z",
      sessionId: "shared-session",
      homeId: "home-a",
      model: "gpt-5",
      channel: "Codex",
      cwd: "/project",
      repositoryKey: "repo",
      total: totals,
    },
    {
      eventId: "b",
      timestamp: "2026-11-01T02:00:00.000Z",
      sessionId: "shared-session",
      homeId: "home-b",
      model: "gpt-5",
      channel: "Codex",
      cwd: "/project",
      repositoryKey: "repo",
      total: totals,
    },
  ]);

  assert.equal(aggregate.sessionCount, 1);
  assert.equal(aggregate.homeCount, 2);
  for (const rows of [aggregate.models, aggregate.channels, aggregate.projects, aggregate.repositories]) {
    assert.equal(rows[0].sessions, 1);
  }
  assert.equal(aggregate.timeline[0].sessions, 1);
});

test("query rejects aggregate sums beyond the JSON safe-integer limit", () => {
  const event = {
    eventId: "a",
    timestamp: "2026-11-01T01:00:00.000Z",
    sessionId: "session",
    homeId: "home",
    total: {
      input: Number.MAX_SAFE_INTEGER,
      cached: 0,
      output: 0,
      reasoning: 0,
      total: Number.MAX_SAFE_INTEGER,
    },
  };
  assert.throws(
    () => aggregateEvents([event, { ...event, eventId: "b" }]),
    (error) => error instanceof AggregateOverflowError && /safe-integer/.test(error.message),
  );
});

test("HTTP query reports aggregate overflow as an internal failure without changing state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-query-overflow-"));
  const runtime = await startServer({ database: path.join(directory, "usage.sqlite"), port: 0 });
  const originalError = console.error;
  console.error = () => {};
  try {
    const maximum = Number.MAX_SAFE_INTEGER;
    const event = {
      timestamp: "2026-11-01T01:00:00.000Z",
      sessionId: "session",
      homeId: "home",
      total: { input: maximum, cached: 0, output: 0, reasoning: 0, total: maximum },
    };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source",
      events: [
        { ...event, eventId: "a" },
        { ...event, eventId: "b" },
      ],
      cursor: {},
    });
    const response = await fetch(`${runtime.baseUrl}/api/query`);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /safe-integer/);
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/status")).payload, {
      revision: 1,
      eventCount: 2,
    });
  } finally {
    console.error = originalError;
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("collectAndCommit is directly reusable by another backend runner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-collect-api-"));
  const database = path.join(directory, "usage.sqlite");
  const raw = await writeRawFixture(directory);
  const runtime = await startServer({ database, port: 0 });
  try {
    const requestedPaths = [];
    const codex = await collectAndCommit(runtime.baseUrl, raw.sources[0], {
      fetch(input, init) {
        const pathname = new URL(input).pathname;
        requestedPaths.push(pathname);
        if (pathname === "/api/commit") {
          assert.equal(JSON.parse(init.body).expectedCursor, null);
        }
        return fetch(input, init);
      },
    });
    assert.equal(codex.revision, 1);
    assert.equal(codex.eventCount, 1);
    assert.match(codex.cursor.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(requestedPaths, ["/api/cursors", "/api/cursors", "/api/commit"]);

    const unchanged = await collectAndCommit(runtime.baseUrl, raw.sources[0], { previousCursor: null });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.revision, 1);
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/status")).payload.revision, 1);

    const dsh = await collectAndCommit(runtime.baseUrl, raw.sources[1]);
    assert.equal(dsh.revision, 2);
    assert.equal(dsh.eventCount, 1);
    const report = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;
    assert.deepEqual(report.events.map((event) => event.eventId).sort(), ["raw-codex:1", "raw-dsh:1"]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent collectAndCommit calls for one source commit once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-collect-race-"));
  const database = path.join(directory, "usage.sqlite");
  const raw = await writeRawFixture(directory);
  const runtime = await startServer({ database, port: 0 });
  try {
    const [left, right] = await Promise.all([
      collectAndCommit(runtime.baseUrl, raw.sources[0]),
      collectAndCommit(runtime.baseUrl, raw.sources[0]),
    ]);
    assert.deepEqual(
      [left.unchanged || false, right.unchanged || false].sort(),
      [false, true],
    );
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/status")).payload, {
      revision: 1,
      eventCount: 1,
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("collectAndCommit refuses to publish after repeated backend cursor changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-collect-cursor-race-"));
  const database = path.join(directory, "usage.sqlite");
  const raw = await writeRawFixture(directory);
  const runtime = await startServer({ database, port: 0 });
  let cursorReads = 0;
  try {
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/api/cursors") {
        cursorReads += 1;
        if (cursorReads >= 2) {
          const externalEvent = {
            eventId: `external-${cursorReads}`,
            timestamp: "2026-11-01T12:00:00.000Z",
            sessionId: "external-session",
            homeId: "external-home",
            total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
          };
          await jsonRequest(runtime.baseUrl, "/api/commit", {
            sourceId: raw.sources[0].sourceId,
            events: [externalEvent],
            cursor: { external: cursorReads },
          });
        }
      }
      return fetch(input, init);
    };

    await assert.rejects(
      collectAndCommit(runtime.baseUrl, raw.sources[0], {
        fetch: fetchImpl,
        concurrencyAttempts: 2,
      }),
      /kept changing during collection.*retry limit exhausted/,
    );
    assert.equal(cursorReads, 3);
    const report = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;
    assert.equal(report.revision, 2);
    assert.deepEqual(report.events.map((event) => event.eventId), ["external-3"]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector handles a 409 by rereading cursors without overwriting a peer commit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-collect-409-"));
  const database = path.join(directory, "usage.sqlite");
  const raw = await writeRawFixture(directory);
  const source = raw.sources[0];
  const runtime = await startServer({ database, port: 0 });
  try {
    const initialEvent = {
      eventId: "initial",
      timestamp: "2026-10-31T00:00:00.000Z",
      sessionId: "initial-session",
      homeId: source.home.id,
      total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
    };
    const initialCursor = { peer: "initial" };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: source.sourceId,
      events: [initialEvent],
      cursor: initialCursor,
      expectedCursor: null,
    });

    let injected = false;
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/api/commit" && !injected) {
        injected = true;
        const staleBody = JSON.parse(init.body);
        const peer = await fetch(`${runtime.baseUrl}/api/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(staleBody),
        });
        assert.equal(peer.status, 200);
      }
      return fetch(input, init);
    };

    const result = await collectAndCommit(runtime.baseUrl, source, {
      fetch: fetchImpl,
      concurrencyAttempts: 3,
    });
    assert.equal(injected, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.revision, 2);

    const report = (await jsonRequest(runtime.baseUrl, "/api/report")).payload;
    assert.equal(report.revision, 2);
    assert.deepEqual(report.events.map((event) => event.eventId), ["raw-codex:1"]);
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/status")).payload.revision, 2);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutating routes reject unsupported methods and non-empty freeze bodies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-method-validation-"));
  const runtime = await startServer({ database: path.join(directory, "usage.sqlite"), port: 0 });
  try {
    const fixture = makeFixture(3);
    const put = await fetch(`${runtime.baseUrl}/api/commit`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture),
    });
    assert.equal(put.status, 404);

    const freeze = await jsonRequest(runtime.baseUrl, "/api/freeze", { unexpected: true });
    assert.equal(freeze.response.status, 400);
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/status")).payload, {
      revision: 0,
      eventCount: 0,
    });
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/report?snapshot=0")).response.status, 404);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cross-source groups merge names while preserving session identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-cross-source-"));
  const runtime = await startServer({ database: path.join(directory, "usage.sqlite"), port: 0 });
  try {
    const baseEvent = {
      timestamp: "2026-11-01T01:00:00.000Z",
      sessionId: "shared-session",
      model: "gpt-5",
      channel: "Codex",
      cwd: "/project",
      repositoryKey: "repo",
      total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
    };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-a",
      events: [{ ...baseEvent, eventId: "a", homeId: "home-a" }],
      cursor: { source: "a" },
    });
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-b",
      events: [{ ...baseEvent, eventId: "b", homeId: "home-b" }],
      cursor: { source: "b" },
    });

    const query = (await jsonRequest(runtime.baseUrl, "/api/query")).payload;
    assert.equal(query.eventCount, 2);
    assert.equal(query.sessionCount, 1);
    assert.equal(query.homeCount, 2);
    for (const rows of [query.models, query.channels, query.projects, query.repositories, query.timeline]) {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].count, 2);
      assert.equal(rows[0].sessions, 1);
      assert.equal(rows[0].total.total, 4);
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("typed SQLite query matches aggregateEvents across filters and snapshots", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-typed-parity-"));
  const store = new SqliteStore(path.join(directory, "usage.sqlite"));
  try {
    const fixture = makeFixture(180);
    store.commit(fixture.sourceId, fixture.events, fixture.cursor, fixture.context);
    const filters = [
      {},
      {
        startMs: Date.parse("2026-10-30T00:00:00.000Z"),
        endMs: Date.parse("2026-11-01T00:00:00.000Z"),
      },
      { excludeHomes: ["fixture-codex", "fixture-dsh"] },
      {
        startMs: Date.parse("2026-10-30T00:00:00.000Z"),
        excludeHomes: ["fixture-opencode"],
      },
    ];
    for (const filter of filters) {
      const expected = aggregateEvents(store.report(filter).events);
      const actual = store.query(filter);
      assert.deepEqual(
        { ...actual, revision: undefined },
        { revision: undefined, ...expected },
      );
    }

    const snapshot = store.freeze();
    store.commit(
      fixture.sourceId,
      fixture.events.slice(0, 6),
      { fixture: "replacement" },
      fixture.context,
    );
    const snapshotFilter = {
      snapshot,
      startMs: Date.parse("2026-10-31T00:00:00.000Z"),
      excludeHomes: ["fixture-dsh"],
    };
    assert.deepEqual(store.query(snapshotFilter), {
      revision: snapshot,
      ...aggregateEvents(store.report(snapshotFilter).events),
    });
    assert.equal(store.query().eventCount, 6);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live typed query does not parse event_json payloads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-typed-no-json-"));
  const store = new SqliteStore(path.join(directory, "usage.sqlite"));
  try {
    const fixture = makeFixture(1);
    store.commit(fixture.sourceId, fixture.events, fixture.cursor, fixture.context);
    store.database.prepare("UPDATE events SET event_json = 'not json'").run();
    const query = store.query();
    assert.equal(query.eventCount, 1);
    assert.deepEqual(query.totals, fixture.events[0].total);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy projection backfill survives source replacement and restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-typed-migration-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const fixture = makeFixture(1);
  const event = fixture.events[0];
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE sources (
      source_id TEXT PRIMARY KEY,
      cursor_json TEXT NOT NULL,
      updated_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE events (
      source_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      home_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (source_id, event_id)
    ) STRICT;
    CREATE TABLE snapshots (
      revision INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO meta(key, value) VALUES ('revision', '1'), ('context', '{}');
  `);
  legacy
    .prepare(
      "INSERT INTO sources(source_id, cursor_json, updated_revision) VALUES (?, ?, 1)",
    )
    .run(fixture.sourceId, JSON.stringify(fixture.cursor));
  legacy
    .prepare(
      `INSERT INTO events(
        source_id, event_id, timestamp, timestamp_ms, session_id, home_id, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.sourceId,
      event.eventId,
      event.timestamp,
      Date.parse(event.timestamp),
      event.sessionId,
      event.homeId,
      JSON.stringify(event),
    );
  legacy.close();

  let store = new SqliteStore(databasePath);
  try {
    assert.equal(store.query().eventCount, 1);
    assert.deepEqual(store.report().events, [event]);
    assert.equal(
      store.database.prepare("SELECT value FROM meta WHERE key = 'query_projection_version'").get().value,
      "1",
    );

    const replacement = makeFixture(2);
    const replacementEvents = [...replacement.events].sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp < right.timestamp ? -1 : 1;
      }
      return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
    });
    store.commit(replacement.sourceId, replacement.events, replacement.cursor, replacement.context);
    assert.deepEqual(store.report().events, replacementEvents);
    assert.equal(store.query().eventCount, replacement.events.length);

    store.close();
    store = null;
    store = new SqliteStore(databasePath);
    assert.deepEqual(store.report().events, replacementEvents);
    assert.equal(store.query().eventCount, replacement.events.length);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP changes returns full and incremental source views without advancing on failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-changes-"));
  const runtime = await startServer({ database: path.join(directory, "usage.sqlite"), port: 0 });
  const makeEvent = (eventId, timestamp) => ({
    eventId,
    timestamp,
    sessionId: `session-${eventId}`,
    homeId: `home-${eventId}`,
    total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
  });
  try {
    const firstEvent = makeEvent("a-1", "2026-11-01T01:00:00.000Z");
    const firstCursor = { source: "a", version: 1 };
    const firstContext = { generatedAt: "2026-11-01T01:00:00.000Z", marker: "a-1" };
    assert.deepEqual(
      (
        await jsonRequest(runtime.baseUrl, "/api/commit", {
          sourceId: "source-a",
          events: [firstEvent],
          cursor: firstCursor,
          context: firstContext,
        })
      ).payload,
      { revision: 1, eventCount: 1 },
    );

    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes")).payload, {
      revision: 1,
      reset: true,
      sources: [{ sourceId: "source-a", events: [firstEvent], cursor: firstCursor }],
      context: firstContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=1")).payload, {
      revision: 1,
      reset: false,
      sources: [],
      context: firstContext,
    });

    const secondEvent = makeEvent("b-1", "2026-11-01T02:00:00.000Z");
    const secondCursor = { source: "b", version: 1 };
    const secondContext = { generatedAt: "2026-11-01T02:00:00.000Z", marker: "b-1" };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-b",
      events: [secondEvent],
      cursor: secondCursor,
      context: secondContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=1")).payload, {
      revision: 2,
      reset: false,
      sources: [{ sourceId: "source-b", events: [secondEvent], cursor: secondCursor }],
      context: secondContext,
    });

    const emptyCursor = { source: "a", version: 2, empty: true };
    const emptyContext = { generatedAt: "2026-11-01T03:00:00.000Z", marker: "a-empty" };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-a",
      events: [],
      cursor: emptyCursor,
      context: emptyContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=2")).payload, {
      revision: 3,
      reset: false,
      sources: [{ sourceId: "source-a", events: [], cursor: emptyCursor }],
      context: emptyContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=3")).payload, {
      revision: 3,
      reset: false,
      sources: [],
      context: emptyContext,
    });

    const duplicate = await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-b",
      events: [secondEvent, structuredClone(secondEvent)],
      cursor: { source: "b", version: 2 },
    });
    assert.equal(duplicate.response.status, 400);
    const conflict = await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-b",
      events: [secondEvent],
      cursor: { source: "b", version: 3 },
      expectedCursor: null,
    });
    assert.equal(conflict.response.status, 409);
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=3")).payload, {
      revision: 3,
      reset: false,
      sources: [],
      context: emptyContext,
    });

    for (const route of [
      "/api/changes?since=4",
      "/api/changes?since=-1",
      "/api/changes?since=1.5",
      "/api/changes?since=not-a-number",
      "/api/changes?since=9007199254740992",
      "/api/changes?since=3&snapshot=3",
    ]) {
      assert.equal((await jsonRequest(runtime.baseUrl, route)).response.status, 400, route);
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP contextSince omits only live incremental context with no newer update", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-context-since-"));
  const database = path.join(directory, "usage.sqlite");
  const runtime = await startServer({ database, port: 0 });
  const makeEvent = (eventId) => ({
    eventId,
    timestamp: "2026-11-01T01:00:00.000Z",
    sessionId: `session-${eventId}`,
    homeId: `home-${eventId}`,
    total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
  });
  try {
    const context = { generatedAt: "2026-11-01T01:00:00.000Z", marker: "base" };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-a",
      events: [makeEvent("a-1")],
      cursor: { source: "a", version: 1 },
      context,
    });
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-b",
      events: [makeEvent("b-1")],
      cursor: { source: "b", version: 1 },
    });
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-c",
      events: [makeEvent("c-1")],
      cursor: { source: "c", version: 1 },
    });

    const multipleDeltas = (await jsonRequest(
      runtime.baseUrl,
      "/api/changes?since=1&contextSince=1",
    )).payload;
    assert.equal(multipleDeltas.revision, 3);
    assert.deepEqual(
      multipleDeltas.sources.map((source) => source.sourceId),
      ["source-b", "source-c"],
    );
    assert.equal(Object.hasOwn(multipleDeltas, "context"), false);
    assert.equal(
      Object.hasOwn(
        (await jsonRequest(runtime.baseUrl, "/api/changes?since=2&contextSince=1")).payload,
        "context",
      ),
      false,
    );

    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-a",
      events: [makeEvent("a-2")],
      cursor: { source: "a", version: 2 },
      context,
    });
    const updated = (await jsonRequest(
      runtime.baseUrl,
      "/api/changes?since=3&contextSince=1",
    )).payload;
    assert.equal(updated.revision, 4);
    assert.deepEqual(updated.context, context);
    assert.equal(
      Object.hasOwn(
        (await jsonRequest(runtime.baseUrl, "/api/changes?since=3&contextSince=4")).payload,
        "context",
      ),
      false,
    );

    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?contextSince=4")).payload.context, context);
    await jsonRequest(runtime.baseUrl, "/api/freeze", {});
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?snapshot=4")).payload.context, context);
    for (const route of [
      "/api/changes?since=4&contextSince=5",
      "/api/changes?contextSince=5",
      "/api/changes?contextSince=-1",
      "/api/changes?contextSince=1.5",
      "/api/changes?contextSince=9007199254740992",
      "/api/changes?snapshot=4&contextSince=4",
    ]) {
      assert.equal((await jsonRequest(runtime.baseUrl, route)).response.status, 400, route);
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("context revision backfills conservatively and advances only with committed context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-context-revision-"));
  const database = path.join(directory, "usage.sqlite");
  const makeEvent = (eventId) => ({
    eventId,
    timestamp: "2026-11-01T01:00:00.000Z",
    sessionId: `session-${eventId}`,
    homeId: `home-${eventId}`,
    total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
  });
  let store = new SqliteStore(database);
  try {
    const context = { marker: "base" };
    store.commit("source-a", [makeEvent("a-1")], { version: 1 }, context);
    store.close();
    store = null;

    const legacy = new DatabaseSync(database);
    legacy.prepare("DELETE FROM meta WHERE key = 'context_revision'").run();
    legacy.close();

    store = new SqliteStore(database);
    const contextRevision = () =>
      store.database
        .prepare("SELECT value FROM meta WHERE key = 'context_revision'")
        .get().value;
    assert.equal(contextRevision(), "1");
    assert.equal(
      Object.hasOwn(store.changes({ since: 1, contextSince: 1 }), "context"),
      false,
    );

    store.commit("source-b", [makeEvent("b-1")], { version: 1 });
    assert.equal(store.status().revision, 2);
    assert.equal(contextRevision(), "1");
    assert.deepEqual(store.report().context, context);

    assert.throws(
      () =>
        store.commit(
          "source-a",
          [makeEvent("a-2")],
          { version: 2 },
          { marker: "stale" },
          { expectedCursor: null },
        ),
      /conflict/i,
    );
    assert.equal(contextRevision(), "1");

    const circular = { ...makeEvent("a-circular"), extra: {} };
    circular.extra.self = circular.extra;
    assert.throws(
      () => store.commit("source-a", [circular], { version: 3 }, { marker: "failed" }),
      /circular/i,
    );
    assert.equal(store.status().revision, 2);
    assert.equal(contextRevision(), "1");
    assert.deepEqual(store.report().context, context);

    store.commit("source-a", [makeEvent("a-2")], { version: 3 }, context);
    assert.equal(contextRevision(), "3");
    assert.equal(
      Object.hasOwn(store.changes({ since: 2, contextSince: 3 }), "context"),
      false,
    );
    assert.deepEqual(store.changes({ since: 2, contextSince: 2 }).context, context);

    store.close();
    store = null;
    store = new SqliteStore(database);
    assert.equal(contextRevision(), "3");
    assert.equal(
      Object.hasOwn(store.changes({ since: 3, contextSince: 3 }), "context"),
      false,
    );
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("context-free commits and omitted context reads do not access the context blob", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-context-bypass-"));
  const database = path.join(directory, "usage.sqlite");
  const store = new SqliteStore(database);
  const makeEvent = (eventId) => ({
    eventId,
    timestamp: "2026-11-01T01:00:00.000Z",
    sessionId: `session-${eventId}`,
    homeId: `home-${eventId}`,
    total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
  });
  const metaValue = (key) =>
    store.database.prepare("SELECT value FROM meta WHERE key = ?").get(key).value;
  try {
    store.commit("source-a", [makeEvent("a-1")], { version: 1 }, { marker: "keep-me" });
    store.database.exec(`
      CREATE TABLE context_update_audit (updated_at TEXT NOT NULL) STRICT;
      CREATE TRIGGER audit_context_update
        AFTER UPDATE OF value ON meta
        WHEN OLD.key = 'context' OR NEW.key = 'context'
      BEGIN
        INSERT INTO context_update_audit VALUES (datetime('now'));
      END;
    `);
    const contextBefore = metaValue("context");
    const contextRevisionBefore = metaValue("context_revision");
    const totalChangesBefore = store.database
      .prepare("SELECT total_changes() AS value")
      .get().value;
    const commitAccesses = [];
    store.database.setAuthorizer((action, table, column) => {
      if (table === "meta") {
        commitAccesses.push({ action, column });
      }
      return constants.SQLITE_OK;
    });
    try {
      store.commit("source-b", [makeEvent("b-1")], { version: 1 });
    } finally {
      store.database.setAuthorizer(null);
    }

    assert.deepEqual(
      commitAccesses.filter(
        ({ action, column }) =>
          action === constants.SQLITE_READ && column === "value",
      ),
      [{ action: constants.SQLITE_READ, column: "value" }],
    );
    assert.equal(
      commitAccesses.filter(({ action }) => action === constants.SQLITE_UPDATE).length,
      1,
    );
    assert.equal(metaValue("context"), contextBefore);
    assert.equal(metaValue("context_revision"), contextRevisionBefore);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS value FROM context_update_audit").get().value,
      0,
    );
    assert.equal(
      store.database.prepare("SELECT total_changes() AS value").get().value - totalChangesBefore,
      4,
    );

    const changesAccesses = [];
    store.database.setAuthorizer((action, table, column) => {
      if (table === "meta") {
        changesAccesses.push({ action, column });
      }
      return constants.SQLITE_OK;
    });
    let changes;
    try {
      changes = store.changes({ since: 1, contextSince: 1 });
    } finally {
      store.database.setAuthorizer(null);
    }
    assert.equal(Object.hasOwn(changes, "context"), false);
    assert.equal(
      changesAccesses.filter(
        ({ action, column }) =>
          action === constants.SQLITE_READ && column === "value",
      ).length,
      2,
    );
    assert.equal(
      changesAccesses.some(({ action }) => action === constants.SQLITE_UPDATE),
      false,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP changes survives restart and returns frozen source views", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-changes-snapshot-"));
  const database = path.join(directory, "usage.sqlite");
  const makeEvent = (eventId, timestamp) => ({
    eventId,
    timestamp,
    sessionId: `session-${eventId}`,
    homeId: `home-${eventId}`,
    total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
  });
  const firstEvent = makeEvent("a-1", "2026-11-01T01:00:00.000Z");
  const secondEvent = makeEvent("b-1", "2026-11-01T02:00:00.000Z");
  const firstCursor = { source: "a", version: 1 };
  const secondCursor = { source: "b", version: 1 };
  const secondContext = { generatedAt: "2026-11-01T02:00:00.000Z", marker: "frozen" };
  let runtime = await startServer({ database, port: 0 });
  try {
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-a",
      events: [firstEvent],
      cursor: firstCursor,
      context: { marker: "first" },
    });
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-b",
      events: [secondEvent],
      cursor: secondCursor,
      context: secondContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/freeze", {})).payload, {
      snapshot: 2,
    });

    await runtime.close();
    runtime = await startServer({ database, port: 0 });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=1")).payload, {
      revision: 2,
      reset: false,
      sources: [{ sourceId: "source-b", events: [secondEvent], cursor: secondCursor }],
      context: secondContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?snapshot=2")).payload, {
      revision: 2,
      reset: true,
      sources: [
        { sourceId: "source-a", events: [firstEvent], cursor: firstCursor },
        { sourceId: "source-b", events: [secondEvent], cursor: secondCursor },
      ],
      context: secondContext,
    });

    const replacementEvent = makeEvent("a-2", "2026-11-01T03:00:00.000Z");
    const replacementCursor = { source: "a", version: 2 };
    const replacementContext = { generatedAt: "2026-11-01T03:00:00.000Z", marker: "live" };
    await jsonRequest(runtime.baseUrl, "/api/commit", {
      sourceId: "source-a",
      events: [replacementEvent],
      cursor: replacementCursor,
      context: replacementContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?since=2")).payload, {
      revision: 3,
      reset: false,
      sources: [{ sourceId: "source-a", events: [replacementEvent], cursor: replacementCursor }],
      context: replacementContext,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?snapshot=2")).payload, {
      revision: 2,
      reset: true,
      sources: [
        { sourceId: "source-a", events: [firstEvent], cursor: firstCursor },
        { sourceId: "source-b", events: [secondEvent], cursor: secondCursor },
      ],
      context: secondContext,
    });
    assert.equal((await jsonRequest(runtime.baseUrl, "/api/changes?snapshot=999")).response.status, 404);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy snapshots reject unreliable changes while report compatibility remains intact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-legacy-changes-"));
  const database = path.join(directory, "usage.sqlite");
  const makeEvent = (eventId, timestamp) => ({
    eventId,
    timestamp,
    sessionId: `session-${eventId}`,
    homeId: `home-${eventId}`,
    total: { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
  });
  const firstEvents = [
    makeEvent("a-2", "2026-11-01T02:00:00.000Z"),
    makeEvent("a-1", "2026-11-01T01:00:00.000Z"),
  ];
  const firstCursor = { source: "a", version: 1 };
  const firstContext = { generatedAt: "2026-11-01T02:00:00.000Z", marker: "first" };
  const secondEvent = makeEvent("b-1", "2026-11-01T03:00:00.000Z");
  const secondCursor = { source: "b", version: 1 };
  const secondContext = { generatedAt: "2026-11-01T03:00:00.000Z", marker: "second" };
  let runtime;

  const store = new SqliteStore(database);
  let firstReport;
  let combinedReport;
  try {
    store.commit("source-a", firstEvents, firstCursor, firstContext);
    firstReport = store.report();
    store.commit("source-b", [secondEvent], secondCursor, secondContext);
    combinedReport = store.report();
  } finally {
    store.close();
  }

  const legacy = new DatabaseSync(database);
  try {
    const insert = legacy.prepare(
      "INSERT INTO snapshots(revision, state_json, created_at) VALUES (?, ?, ?)",
    );
    const stateJson = (report) =>
      JSON.stringify({
        events: report.events,
        context: report.context,
        cursors: report.cursors,
      });
    insert.run(0, stateJson({ events: [], context: {}, cursors: {} }), "2026-11-01T00:00:00.000Z");
    insert.run(1, stateJson(firstReport), "2026-11-01T02:00:00.000Z");
    insert.run(2, stateJson(combinedReport), "2026-11-01T03:00:00.000Z");
  } finally {
    legacy.close();
  }

  runtime = await startServer({ database, port: 0 });
  try {
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/changes?snapshot=1")).payload, {
      revision: 1,
      reset: true,
      sources: [
        {
          sourceId: "source-a",
          events: firstReport.events,
          cursor: firstCursor,
        },
      ],
      context: firstContext,
    });

    for (const snapshot of [0, 2]) {
      const legacyChanges = await jsonRequest(
        runtime.baseUrl,
        `/api/changes?snapshot=${snapshot}`,
      );
      assert.equal(legacyChanges.response.status, 409);
      assert.equal(legacyChanges.payload.code, "reset-required");
      assert.match(legacyChanges.payload.error, /legacy snapshot has no source grouping/);
    }

    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/report?snapshot=0")).payload, {
      revision: 0,
      events: [],
      context: {},
      cursors: {},
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/report?snapshot=1")).payload, {
      revision: 1,
      ...firstReport,
    });
    assert.deepEqual((await jsonRequest(runtime.baseUrl, "/api/report?snapshot=2")).payload, {
      revision: 2,
      ...combinedReport,
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI --sources starts the polling collector and reports the shared startup line", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-node-sources-cli-"));
  await writeRawFixture(directory);
  const serverPath = path.join(import.meta.dirname, "server.mjs");
  const child = spawn(
    process.execPath,
    [
      serverPath,
      "--database",
      path.join(directory, "usage.sqlite"),
      "--port",
      "0",
      "--sources",
      path.join(directory, "sources.json"),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const startup = await new Promise((resolve, reject) => {
      let pending = "";
      const timer = setTimeout(() => reject(new Error(`startup timeout: ${stderr}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        pending += chunk.toString();
        const newline = pending.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(pending.slice(0, newline)));
        }
      });
      child.once("error", reject);
    });
    assert.deepEqual(Object.keys(startup).sort(), ["backend", "port"]);
    assert.equal(startup.backend, "node-sqlite");

    const status = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${startup.port}/api/status`);
      const value = await response.json();
      return value.revision === 2 ? value : null;
    });
    assert.equal(status.eventCount, 2);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
