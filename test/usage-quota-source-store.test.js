import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { quotaSourceResolver } from "../src/quota-usage-source.js";
import { createStoredQuotaSourceResolver } from "../src/usage-quota-source-store.js";

function createDatabase(t, rows = []) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE quota_usage_sources (
      source_path TEXT NOT NULL,
      home_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      quota_source TEXT NOT NULL,
      until_ms INTEGER NOT NULL,
      PRIMARY KEY (source_path, session_id, timestamp_ms)
    ) STRICT
  `);
  const insert = database.prepare(`
    INSERT INTO quota_usage_sources
      (source_path, home_id, session_id, timestamp_ms, quota_source, until_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(row.path, row.home, row.session, row.time, row.source, row.until ?? 0);
  }
  t.after(() => database.close());
  return database;
}

function countedDatabase(database) {
  let gets = 0;
  return {
    database: {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          get(...parameters) {
            gets += 1;
            return statement.get(...parameters);
          },
        };
      },
    },
    get gets() {
      return gets;
    },
  };
}

function legacyResolver(rows, evidence) {
  return quotaSourceResolver(
    rows.map((row) => ({
      homeId: row.home,
      sessionId: row.session,
      timestampMs: row.time,
      quotaSource: row.source,
      quotaSourceUntil: row.until ?? 0,
    })),
    evidence,
  );
}

function mapIterationGuard(t) {
  const methods = ["entries", "keys", "values"];
  const originals = Object.fromEntries(methods.map((name) => [name, Map.prototype[name]]));
  const originalIterator = Map.prototype[Symbol.iterator];
  let forbidden = false;
  for (const name of methods) {
    Map.prototype[name] = function (...arguments_) {
      if (forbidden) throw new Error(`cache hit iterated Map.${name}()`);
      return originals[name].apply(this, arguments_);
    };
  }
  Map.prototype[Symbol.iterator] = function (...arguments_) {
    if (forbidden) throw new Error("cache hit iterated the Map");
    return originalIterator.apply(this, arguments_);
  };
  t.after(() => {
    for (const name of methods) Map.prototype[name] = originals[name];
    Map.prototype[Symbol.iterator] = originalIterator;
  });
  return {
    forbid() {
      forbidden = true;
    },
    allow() {
      forbidden = false;
    },
  };
}

test("stored resolver preserves latest, expiry, recorded source, evidence, and account precedence", (t) => {
  const rows = [
    { path: "p1", home: "h", session: "a", time: 10, source: "credits", until: 20 },
    { path: "p2", home: "h", session: "a", time: 30, source: "plan", until: 0 },
  ];
  const calls = [];
  const evidence = {
    resolve(...parameters) {
      calls.push(parameters);
      if (parameters[2] === 15) return "plan";
      if (parameters[2] === 20) return "external";
      return null;
    },
  };
  const resolve = createStoredQuotaSourceResolver(createDatabase(t, rows), evidence);

  assert.equal(resolve("h", "a", 15), "credits");
  assert.equal(resolve("h", "a", 20), "external");
  assert.equal(resolve("h", "a", 30), "plan");
  assert.equal(resolve("h", "a", 10, "api"), "api");
  assert.equal(resolve("h", "a", 10, "custom"), "credits");
  assert.equal(resolve("h", "a", 25, "custom"), "custom");
  assert.deepEqual(calls, [
    ["h", "a", 15, "credits"],
    ["h", "a", 20, "unknown"],
    ["h", "a", 30, "plan"],
    ["h", "a", 10, "api"],
    ["h", "a", 10, "custom"],
    ["h", "a", 25, "custom"],
  ]);
});

test("explicit credits survives without a thread entry, including before the future first row", (t) => {
  const empty = createStoredQuotaSourceResolver(createDatabase(t), null);
  assert.equal(empty("h", "a", 50, "credits"), "credits");

  const future = createStoredQuotaSourceResolver(
    createDatabase(t, [{ path: "p1", home: "h", session: "a", time: 100, source: "plan", until: 0 }]),
    null,
  );
  assert.equal(future("h", "a", 99, "credits"), "credits");
  assert.equal(future("h", "a", 100, "credits"), "unknown");
});

test("same-timestamp ties follow later rowid across source files", (t) => {
  const database = createDatabase(t, [
    { path: "first", home: "h", session: "a", time: 10, source: "plan", until: 0 },
    { path: "last", home: "h", session: "a", time: 10, source: "credits", until: 50 },
  ]);
  const resolve = createStoredQuotaSourceResolver(database, null);
  assert.equal(resolve("h", "a", 10), "credits");
});

test("credits remain account-wide while thread state and homes stay isolated", (t) => {
  const database = createDatabase(t, [
    { path: "p1", home: "h", session: "a", time: 10, source: "credits", until: 50 },
    { path: "p2", home: "h", session: "a", time: 60, source: "plan", until: 0 },
  ]);
  const resolve = createStoredQuotaSourceResolver(database, null);

  assert.equal(resolve("h", "a", 40), "credits");
  assert.equal(resolve("h", "b", 40), "credits");
  assert.equal(resolve("other", "b", 40), "unknown");
  assert.equal(resolve("h", "b", 50), "unknown");
  assert.equal(resolve("h", "a", 70), "plan");
  assert.equal(resolve("h", "b", 40, "external"), "external");
});

test("out-of-order queries reuse state segments without changing results", (t) => {
  const database = createDatabase(t, [
    { path: "p1", home: "h", session: "a", time: 20, source: "plan", until: 0 },
    { path: "p2", home: "h", session: "a", time: 80, source: "credits", until: 90 },
    { path: "p3", home: "h", session: "a", time: 120, source: "api", until: 0 },
  ]);
  const resolve = createStoredQuotaSourceResolver(database, null);

  assert.equal(resolve("h", "a", 110), "unknown");
  assert.equal(resolve("h", "a", 5), "unknown");
  assert.equal(resolve("h", "a", 60), "plan");
  assert.equal(resolve("h", "a", 90), "unknown");
  assert.equal(resolve("h", "a", 1), "unknown");
  assert.equal(resolve("h", "a", 130), "api");
  assert.equal(resolve("h", "a", 100), "unknown");
});

test("long same-state runs reuse thread and account segments", (t) => {
  const counted = countedDatabase(
    createDatabase(t, [
      { path: "p1", home: "h", session: "a", time: 10, source: "plan", until: 0 },
      { path: "p2", home: "h", session: "a", time: 10_000, source: "api", until: 0 },
    ]),
  );
  const resolve = createStoredQuotaSourceResolver(counted.database, null);

  for (let time = 10; time < 1_000; time += 1) assert.equal(resolve("h", "a", time), "plan");
  assert.equal(counted.gets, 4);

  assert.equal(resolve("h", "a", 10_000), "api");
  assert.equal(counted.gets, 6, "the unchanged account segment remains reusable");
  for (let time = 10_000; time < 20_000; time += 1) assert.equal(resolve("h", "a", time), "api");
  assert.equal(counted.gets, 6);
});

test("cache budget is bounded and oversized keys are not retained or truncated", (t) => {
  const counted = countedDatabase(
    createDatabase(t, [{ path: "p1", home: "h", session: "short", time: 1, source: "plan", until: 0 }]),
  );
  const resolve = createStoredQuotaSourceResolver(counted.database, null, { maxBytes: 512 });
  const oversizedSession = "s".repeat(10_000);

  assert.equal(resolve("h", oversizedSession, 2), "unknown");
  assert.equal(counted.gets, 4);
  assert.equal(resolve("h", oversizedSession, 2), "unknown");
  assert.equal(counted.gets, 6, "only the oversized thread lookup should miss");

  const uncached = countedDatabase(createDatabase(t));
  const zeroBudget = createStoredQuotaSourceResolver(uncached.database, null, { maxBytes: 0 });
  assert.equal(zeroBudget("h", "a", 2, "credits"), "credits");
  assert.equal(zeroBudget("h", "a", 2, "credits"), "credits");
  assert.equal(uncached.gets, 8);
});

test("many identities hit through O(1) keyed lookup without Map iteration", (t) => {
  const rows = Array.from({ length: 2_500 }, (_, index) => ({
    path: `p${index}`,
    home: `h${index % 20}`,
    session: `s${index}`,
    time: 0,
    source: "plan",
    until: 0,
  }));
  const counted = countedDatabase(createDatabase(t, rows));
  const resolve = createStoredQuotaSourceResolver(counted.database, null);
  for (const row of rows) assert.equal(resolve(row.home, row.session, 0), "plan");
  const getsAfterPrime = counted.gets;

  const guard = mapIterationGuard(t);
  guard.forbid();
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const row of rows) assert.equal(resolve(row.home, row.session, 1), "plan");
    }
  } finally {
    guard.allow();
  }
  assert.equal(counted.gets, getsAfterPrime);
});

test("clearCache exposes revisions made after the cached read snapshot", (t) => {
  const database = createDatabase(t, [
    { path: "p1", home: "h", session: "a", time: 10, source: "credits", until: 100 },
  ]);
  const resolve = createStoredQuotaSourceResolver(database, null);
  assert.equal(resolve("h", "a", 50), "credits");

  database
    .prepare(`
      INSERT INTO quota_usage_sources
        (source_path, home_id, session_id, timestamp_ms, quota_source, until_ms)
      VALUES ('p2', 'h', 'a', 40, 'plan', 0)
    `)
    .run();
  assert.equal(resolve("h", "a", 50), "credits");

  resolve.clearCache();
  assert.equal(resolve("h", "a", 50), "plan");
});

test("deterministic randomized queries match the in-memory resolver", (t) => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
  const homes = ["h1", "h2", "h3"];
  const sessions = ["a", "b", "c", "d"];
  const times = [-5, 0, 10, 10, 20, 25, 40, 60];
  const sources = ["unknown", "", "credits", "plan", "api", "external"];
  const rows = Array.from({ length: 120 }, (_, index) => ({
    path: `p${index}`,
    home: homes[Math.floor(random() * homes.length)],
    session: sessions[Math.floor(random() * sessions.length)],
    time: times[Math.floor(random() * times.length)],
    source: sources[Math.floor(random() * sources.length)],
    until: [0, 15, 30, 50, 80][Math.floor(random() * 5)],
  }));
  const evidence = {
    resolve(homeId, sessionId, time) {
      if ((homeId.length + sessionId.charCodeAt(0) + time) % 7 === 0) return "api";
      if ((homeId.length + sessionId.charCodeAt(0) + time) % 11 === 0) return "plan";
      return null;
    },
  };
  const expected = legacyResolver(rows, evidence);
  const actual = createStoredQuotaSourceResolver(createDatabase(t, rows), evidence);

  const queryTimes = Array.from({ length: 600 }, () => Math.floor(random() * 90) - 10);
  const recordedSources = ["unknown", "credits", "api", "external", "custom"];
  for (let index = 0; index < queryTimes.length; index += 1) {
    const homeId = homes[Math.floor(random() * homes.length)];
    const sessionId = sessions[Math.floor(random() * sessions.length)];
    const time = queryTimes[index];
    const recordedSource = recordedSources[Math.floor(random() * recordedSources.length)];
    assert.equal(
      actual(homeId, sessionId, time, recordedSource),
      expected(homeId, sessionId, time, recordedSource),
      `${homeId}/${sessionId}/${time}/${recordedSource}`,
    );
  }
});
