import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { completedQuotaWindows } from "../public/timeline-utils.js";
import { selectQuotaWindows } from "../src/usage-core.js";
import {
  ensureUsageQuotaSchema,
  iterateStoredQuotaWindows,
  selectStoredQuotaWindows,
  USAGE_QUOTA_TABLE_NAMES,
} from "../src/usage-quota-store.js";
import { USAGE_QUOTA_PROJECTION_TABLE_NAMES } from "../src/usage-quota-projection.js";

const MINUTE = 60_000;
const AS_OF = Date.parse("2026-10-20T12:00:00.000Z");

function createDatabase(file = ":memory:") {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE rate_limit_observations (
      source_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      limit_id TEXT NOT NULL,
      limit_name TEXT,
      plan_type TEXT,
      window_minutes REAL NOT NULL,
      resets_at_ms INTEGER NOT NULL,
      used_percent REAL,
      PRIMARY KEY (source_path, line_number, role)
    ) STRICT;
  `);
  return database;
}

function countedDatabase(database) {
  const counts = { baseScans: 0, prepares: 0 };
  const isBaseScan = (sql) => /\bSELECT\b[\s\S]*\bFROM\s+rate_limit_observations\b/i.test(sql);
  return {
    counts,
    database: {
      get isTransaction() {
        return database.isTransaction;
      },
      exec(sql) {
        if (isBaseScan(sql)) counts.baseScans += 1;
        return database.exec(sql);
      },
      prepare(sql) {
        counts.prepares += 1;
        if (isBaseScan(sql)) counts.baseScans += 1;
        return database.prepare(sql);
      },
    },
  };
}

function quotaRevision(database) {
  return Number(database.prepare("SELECT revision FROM quota_revision WHERE singleton = 1").get().revision);
}

function insertRows(database, rows) {
  const insert = database.prepare(`
    INSERT INTO rate_limit_observations (
      source_path, line_number, role, observed_at_ms, limit_id, limit_name,
      plan_type, window_minutes, resets_at_ms, used_percent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.sourcePath,
      row.lineNumber,
      row.role,
      row.observedAtMs,
      row.limitId,
      row.limitName ?? null,
      row.planType ?? null,
      row.windowMinutes,
      row.resetsAtMs,
      row.usedPercent ?? null,
    );
  }
}

function storedRows(database) {
  return database
    .prepare(`
      SELECT source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      FROM rate_limit_observations
      ORDER BY limit_id, window_minutes, observed_at_ms DESC
    `)
    .all()
    .map((row) => ({
      sourcePath: row.source_path,
      lineNumber: Number(row.line_number),
      role: row.role,
      observedAtMs: Number(row.observed_at_ms),
      limitId: row.limit_id,
      limitName: row.limit_name,
      planType: row.plan_type,
      windowMinutes: Number(row.window_minutes),
      resetsAtMs: Number(row.resets_at_ms),
      usedPercent: row.used_percent === null ? null : Number(row.used_percent),
    }));
}

function row(sourcePath, lineNumber, overrides = {}) {
  return {
    sourcePath,
    lineNumber,
    role: "primary",
    observedAtMs: AS_OF - 30 * MINUTE,
    limitId: "codex",
    limitName: null,
    planType: null,
    windowMinutes: 300,
    resetsAtMs: AS_OF + 270 * MINUTE,
    usedPercent: 20,
    ...overrides,
  };
}

function collect(iterable) {
  return iterable === null ? null : [...iterable];
}

function deduplicateObservations(observations) {
  const unique = new Map();
  observations.forEach((observation, index) => {
    const sourcePath = observation.sourcePath ?? observation.source_path;
    const lineNumber = observation.lineNumber ?? observation.line_number;
    const role = observation.role;
    const key =
      sourcePath !== undefined && lineNumber !== undefined && role
        ? `${sourcePath}\u0000${lineNumber}\u0000${role}`
        : `unkeyed\u0000${index}`;
    if (!unique.has(key)) unique.set(key, observation);
  });
  return [...unique.values()];
}

function assertSelectParity(database, asOf, officialObservations) {
  const expected = selectQuotaWindows(
    deduplicateObservations([...storedRows(database), ...officialObservations]),
    asOf,
  );
  const actual = selectStoredQuotaWindows(database, asOf, officialObservations);
  assert.deepEqual(actual, expected);
}

function assertIterableParity(database, officialObservations, limitId, asOfMs, minutes) {
  const expected = completedQuotaWindows(
    deduplicateObservations([...storedRows(database), ...officialObservations]),
    limitId,
    asOfMs,
    minutes,
  );
  const actual = iterateStoredQuotaWindows(database, limitId, asOfMs, minutes, officialObservations);
  assert.deepEqual(collect(actual), expected);
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

test("stored selection matches usage-core across current, expired, future, and unknown windows", () => {
  const database = createDatabase();
  insertRows(database, [
    row("db", 1, {
      observedAtMs: AS_OF - 20 * MINUTE,
      resetsAtMs: AS_OF + 280 * MINUTE,
      usedPercent: 37,
    }),
    row("db", 2, {
      role: "secondary",
      observedAtMs: AS_OF - 5 * 24 * 60 * MINUTE,
      windowMinutes: 10_080,
      resetsAtMs: AS_OF - 2 * 24 * 60 * MINUTE,
      usedPercent: 80,
    }),
    row("db", 3, {
      role: "secondary",
      observedAtMs: AS_OF + 10 * MINUTE,
      windowMinutes: 10_080,
      resetsAtMs: AS_OF + 9 * 24 * 60 * MINUTE,
      usedPercent: 91,
    }),
    row("db", 4, {
      windowMinutes: 42,
      resetsAtMs: AS_OF + 42 * MINUTE,
    }),
    row("db", 5, {
      limitId: "orphan",
      observedAtMs: AS_OF - 2 * MINUTE,
    }),
  ]);
  const official = [
    row("official", 1, {
      limitId: "quiet",
      observedAtMs: AS_OF - 4 * MINUTE,
      windowMinutes: 10_080,
      resetsAtMs: AS_OF + 6 * 24 * 60 * MINUTE,
    }),
  ];

  assertSelectParity(database, AS_OF, official);
  assert.equal(selectStoredQuotaWindows(database, AS_OF, official).limitId, "codex");
  assert.equal(selectStoredQuotaWindows(database, AS_OF, official).ignoredBucketCount, 2);
  assertIterableParity(database, official, "codex", AS_OF, 300);
  assertIterableParity(database, official, "codex", AS_OF, 10_080);
});

test("database identities win before official duplicates, then official first-write wins", () => {
  const database = createDatabase();
  insertRows(database, [
    row("shared", 1, {
      resetsAtMs: AS_OF + 100 * MINUTE,
      usedPercent: 15,
    }),
  ]);
  const official = [
    row("shared", 1, {
      resetsAtMs: AS_OF + 200 * MINUTE,
      usedPercent: 99,
    }),
    {
      source_path: "first",
      line_number: 1,
      role: "primary",
      observed_at_ms: AS_OF - 10 * MINUTE,
      limit_id: "codex",
      window_minutes: 300,
      resets_at_ms: AS_OF + 290 * MINUTE,
      used_percent: 44,
    },
    row("first", 1, {
      resetsAtMs: AS_OF + 100 * MINUTE,
      usedPercent: 1,
    }),
  ];

  const quota = selectStoredQuotaWindows(database, AS_OF, official);
  assert.equal(quota.windows.quota_5h.usedPercent, 44);
  assertSelectParity(database, AS_OF, official);
  assertIterableParity(database, official, "codex", AS_OF, 300);
});

test("invalid persisted and official identities still block later official duplicates", () => {
  const database = createDatabase();
  insertRows(database, [
    row("blocked-by-database", 1, {
      limitId: " ",
    }),
  ]);
  const official = [
    row("blocked-by-database", 1, {
      resetsAtMs: AS_OF + 200 * MINUTE,
    }),
    {
      source_path: "blocked-by-official",
      line_number: 1,
      role: "primary",
      observed_at_ms: Number.NaN,
      limit_id: "codex",
      window_minutes: 300,
      resets_at_ms: AS_OF + 100 * MINUTE,
    },
    row("blocked-by-official", 1),
    row("valid-official", 1, {
      observedAtMs: AS_OF - 3 * MINUTE,
      resetsAtMs: AS_OF + 297 * MINUTE,
      usedPercent: 64,
    }),
  ];
  const result = selectStoredQuotaWindows(database, AS_OF, official);
  assert.equal(result.limitId, "codex");
  assert.equal(result.windows.quota_5h.usedPercent, 64);
  assertSelectParity(database, AS_OF, official);
});

test("numeric official percentages use JS numeric equality when mixed with persisted values", () => {
  const database = createDatabase();
  insertRows(database, [
    row("database", 1, {
      observedAtMs: AS_OF - 5 * MINUTE,
      resetsAtMs: AS_OF + 295 * MINUTE,
      usedPercent: 0.1,
    }),
  ]);
  const official = [
    {
      source_path: "official",
      line_number: 1,
      role: "secondary",
      observed_at_ms: AS_OF - 5 * MINUTE,
      limit_id: "codex",
      window_minutes: 300,
      resets_at_ms: AS_OF + 295 * MINUTE,
      used_percent: "0.1",
    },
  ];
  assert.equal(selectStoredQuotaWindows(database, AS_OF, official).windows.quota_5h.usedPercent, 0.1);
  assertSelectParity(database, AS_OF, official);
});

test("completed iterator detects all endpoint and order conflicts before returning", () => {
  const database = createDatabase();
  insertRows(database, [
    row("endpoint", 1, {
      observedAtMs: AS_OF - 9 * MINUTE,
      resetsAtMs: AS_OF + 290 * MINUTE,
    }),
    row("endpoint", 2, {
      role: "secondary",
      observedAtMs: AS_OF - 9 * MINUTE,
      resetsAtMs: AS_OF + 293 * MINUTE,
    }),
  ]);
  const result = iterateStoredQuotaWindows(database, "codex", AS_OF, 300);
  assert.equal(result, null);
  assertSelectParity(database, AS_OF, []);
  assert.equal(selectStoredQuotaWindows(database, AS_OF).previousWindows.quota_5h.state, "ambiguous");

  const delayed = createDatabase();
  insertRows(delayed, [
    row("late", 1, {
      observedAtMs: AS_OF - MINUTE,
      resetsAtMs: AS_OF,
    }),
    row("late", 2, {
      role: "secondary",
      observedAtMs: AS_OF - 4 * MINUTE,
      resetsAtMs: AS_OF + 5 * MINUTE,
    }),
  ]);
  assert.equal(iterateStoredQuotaWindows(delayed, "codex", AS_OF + 6 * MINUTE, 300), null);
});

test("jittered endpoints keep support counts and delayed observations out of windows", () => {
  const database = createDatabase();
  const firstEnd = AS_OF - 500 * MINUTE;
  const secondEnd = firstEnd + 300 * MINUTE;
  insertRows(database, [
    row("jitter", 1, {
      observedAtMs: firstEnd - 200 * MINUTE,
      resetsAtMs: firstEnd,
    }),
    row("jitter", 2, {
      role: "secondary",
      observedAtMs: firstEnd - 100 * MINUTE,
      resetsAtMs: firstEnd + MINUTE,
    }),
    row("jitter", 3, {
      observedAtMs: secondEnd - 190 * MINUTE,
      resetsAtMs: secondEnd,
    }),
    row("jitter", 4, {
      role: "secondary",
      observedAtMs: secondEnd - 90 * MINUTE,
      resetsAtMs: secondEnd + MINUTE,
    }),
    row("jitter", 5, {
      observedAtMs: AS_OF + MINUTE,
      resetsAtMs: AS_OF + 301 * MINUTE,
    }),
  ]);

  assertIterableParity(database, [], "codex", AS_OF, 300);
  assertSelectParity(database, AS_OF, []);
});

test("endpoint clustering compares against the cluster anchor instead of the previous point", () => {
  const database = createDatabase();
  const baseEnd = AS_OF - 500 * MINUTE;
  insertRows(
    database,
    [0, 60_000, 120_000, 180_000].map((offset, index) =>
      row("anchor-chain", index + 1, {
        observedAtMs: baseEnd + offset - 300 * MINUTE,
        resetsAtMs: baseEnd + offset,
      }),
    ),
  );
  const completed = collect(iterateStoredQuotaWindows(database, "codex", AS_OF, 300));
  assert.equal(completed.length, 2);
  assert.equal(Date.parse(completed[0].plannedResetAt), baseEnd + 120_000);
  assert.equal(Date.parse(completed[1].plannedResetAt), baseEnd + 180_000);
  assertIterableParity(database, [], "codex", AS_OF, 300);
});

test("invalid and non-finite official fields match the reference without poisoning valid rows", () => {
  const database = createDatabase();
  const official = [
    {
      source_path: "official",
      line_number: 1,
      role: "primary",
      observed_at_ms: AS_OF - 5 * MINUTE,
      limit_id: "codex",
      window_minutes: 300,
      resets_at_ms: AS_OF + 295 * MINUTE,
      used_percent: Number.NaN,
    },
    {
      source_path: "official",
      line_number: 2,
      role: "secondary",
      observed_at_ms: AS_OF - 5 * MINUTE,
      limit_id: "codex",
      window_minutes: 300,
      resets_at_ms: AS_OF + 295 * MINUTE,
      used_percent: Number.NaN,
    },
    row("invalid", 1, { limitId: null }),
    row("invalid", 2, { observedAtMs: Number.NaN }),
    row("invalid", 3, { resetsAtMs: Number.POSITIVE_INFINITY }),
    row("", 4, { limitId: " " }),
    row("invalid", 5, { windowMinutes: 0 }),
  ];

  assertSelectParity(database, AS_OF, official);
  assert.equal(selectStoredQuotaWindows(database, AS_OF, official).windows.quota_5h.usedPercent, null);
  assertIterableParity(database, official, "codex", AS_OF, 300);
  assert.deepEqual(collect(iterateStoredQuotaWindows(database, "codex", AS_OF, 300)), []);
});

test("empty input, old asOf, and non-finite iterator time retain reference behavior", () => {
  const database = createDatabase();
  assertSelectParity(database, AS_OF, []);
  assert.deepEqual(collect(iterateStoredQuotaWindows(database, "codex", AS_OF, 300)), []);
  assert.throws(() => selectStoredQuotaWindows(database, Number.NaN), /valid date/);

  insertRows(database, [
    row("history", 1, {
      observedAtMs: AS_OF - 200 * MINUTE,
      resetsAtMs: AS_OF + 100 * MINUTE,
    }),
  ]);
  assertIterableParity(database, [], "codex", AS_OF - 600 * MINUTE, 300);
  assertIterableParity(database, [], "codex", Number.NaN, 300);
});

test("randomized persisted and official inputs match both reference algorithms", () => {
  const random = seededRandom(0xb1_2026);
  for (let repetition = 0; repetition < 24; repetition += 1) {
    const database = createDatabase();
    const dbRows = [];
    const rowCount = 12 + Math.floor(random() * 35);
    for (let index = 0; index < rowCount; index += 1) {
      const windowMinutes = random() < 0.62 ? 300 : 10_080;
      const duration = windowMinutes * MINUTE;
      const cycle = Math.floor(random() * 12) - 2;
      const reset = AS_OF + cycle * duration + Math.floor((random() - 0.5) * 100_000);
      const observedAtMs = reset - Math.floor(random() * duration);
      const limitId = random() < 0.86 ? "codex" : random() < 0.5 ? "alpha" : "beta";
      dbRows.push(
        row(`random-${repetition}`, index + 1, {
          role: random() < 0.5 ? "primary" : "secondary",
          observedAtMs,
          limitId,
          windowMinutes,
          resetsAtMs: reset,
          usedPercent: random() < 0.18 ? null : Math.round(random() * 1000) / 10,
        }),
      );
    }
    insertRows(database, dbRows);

    const official = [];
    const officialCount = Math.floor(random() * 8);
    for (let index = 0; index < officialCount; index += 1) {
      if (random() < 0.35 && dbRows.length) {
        const duplicate = dbRows[Math.floor(random() * dbRows.length)];
        official.push({ ...duplicate, resetsAtMs: duplicate.resetsAtMs + Math.floor((random() - 0.5) * 400_000) });
        continue;
      }
      const windowMinutes = random() < 0.5 ? 300 : 10_080;
      official.push(
        row(`official-${repetition}`, index + 1, {
          observedAtMs: AS_OF - Math.floor(random() * 4 * 24 * 60 * MINUTE),
          limitId: random() < 0.8 ? "codex" : "alpha",
          windowMinutes,
          resetsAtMs: AS_OF + Math.floor((random() - 0.2) * 14 * 24 * 60 * MINUTE),
          usedPercent: random() < 0.2 ? Number.NaN : Math.round(random() * 1000) / 10,
        }),
      );
    }

    assertSelectParity(database, AS_OF, official);
    for (const minutes of [300, 10_080]) {
      assertIterableParity(database, official, "codex", AS_OF, minutes);
    }
  }
});

test("quota schema exports its owned tables and revisions only on quota mutations", () => {
  const database = createDatabase();
  assert.deepEqual(USAGE_QUOTA_TABLE_NAMES, ["quota_revision", "usage_quota_window_cache", ...USAGE_QUOTA_PROJECTION_TABLE_NAMES]);
  assert.equal(ensureUsageQuotaSchema(database), true);
  assert.equal(ensureUsageQuotaSchema(database), true);
  assert.equal(quotaRevision(database), 0);

  insertRows(database, [row("revision", 1)]);
  assert.equal(quotaRevision(database), 1);
  database.prepare("UPDATE rate_limit_observations SET used_percent = 21").run();
  assert.equal(quotaRevision(database), 2);
  database.prepare("DELETE FROM rate_limit_observations").run();
  assert.equal(quotaRevision(database), 3);
});

test("matching intervals reuse the durable selection and usage-only changes do not scan quota", () => {
  const database = createDatabase();
  ensureUsageQuotaSchema(database);
  insertRows(database, [
    row("cached", 1, {
      observedAtMs: AS_OF - 5 * MINUTE,
      resetsAtMs: AS_OF + 295 * MINUTE,
      usedPercent: 20,
    }),
  ]);
  const coldRevision = quotaRevision(database);
  const { database: counted, counts } = countedDatabase(database);
  const first = selectStoredQuotaWindows(counted, AS_OF);
  assert.deepEqual(first, selectQuotaWindows(storedRows(database), AS_OF));
  assert.ok(counts.baseScans > 0);
  const scansAfterCold = counts.baseScans;

  const later = selectStoredQuotaWindows(counted, AS_OF + 11 * MINUTE);
  assert.deepEqual(later, selectQuotaWindows(storedRows(database), AS_OF + 11 * MINUTE));
  assert.equal(later.windows.quota_5h.percentStale, true);
  assert.equal(counts.baseScans, scansAfterCold);

  database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT");
  database.prepare("INSERT INTO events (value) VALUES (?)").run("usage-only");
  assert.equal(quotaRevision(database), coldRevision);
  selectStoredQuotaWindows(counted, AS_OF + 12 * MINUTE);
  assert.equal(counts.baseScans, scansAfterCold);

  database.prepare("UPDATE rate_limit_observations SET used_percent = 55").run();
  assert.equal(quotaRevision(database), coldRevision + 1);
  const changed = selectStoredQuotaWindows(counted, AS_OF + 12 * MINUTE);
  assert.equal(changed.windows.quota_5h.usedPercent, 55);
  assert.equal(counts.baseScans, scansAfterCold, "a tracked revision updates contributions without rescanning facts");
});

test("official observation signatures invalidate and reuse their own durable cache slot", () => {
  const database = createDatabase();
  ensureUsageQuotaSchema(database);
  insertRows(database, [
    row("signature", 1, {
      observedAtMs: AS_OF - 30 * MINUTE,
      resetsAtMs: AS_OF + 300 * MINUTE,
    }),
  ]);
  const { database: counted, counts } = countedDatabase(database);
  selectStoredQuotaWindows(counted, AS_OF);
  const emptySignatureScans = counts.baseScans;
  const official = [
    {
      source_path: "official-signature",
      line_number: 1,
      role: "secondary",
      observed_at_ms: AS_OF - 5 * MINUTE,
      limit_id: "codex",
      window_minutes: 300,
      resets_at_ms: AS_OF + 295 * MINUTE,
      used_percent: 42,
    },
  ];
  const changed = selectStoredQuotaWindows(counted, AS_OF, official);
  assert.equal(changed.windows.quota_5h.usedPercent, 42);
  assert.ok(counts.baseScans > emptySignatureScans);
  const changedSignatureScans = counts.baseScans;
  const reused = selectStoredQuotaWindows(counted, AS_OF + MINUTE, [
    {
      sourcePath: "official-signature",
      lineNumber: 1,
      role: "secondary",
      observedAtMs: AS_OF - 5 * MINUTE,
      limitId: "codex",
      windowMinutes: 300,
      resetsAtMs: AS_OF + 295 * MINUTE,
      usedPercent: 42,
    },
  ]);
  assert.equal(reused.windows.quota_5h.usedPercent, 42);
  assert.equal(counts.baseScans, changedSignatureScans);
});

test("durable cache survives reopen, advances by asOf interval, and leaves old-asOf fallback uncached", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-quota-cache-"));
  const file = path.join(directory, "usage.sqlite");
  let database;
  try {
    database = createDatabase(file);
    database.exec("PRAGMA journal_mode = WAL");
    ensureUsageQuotaSchema(database);
    insertRows(database, [
      row("cache-file", 1, {
        observedAtMs: AS_OF - 5 * MINUTE,
        resetsAtMs: AS_OF + 295 * MINUTE,
        usedPercent: 20,
      }),
    ]);
    selectStoredQuotaWindows(database, AS_OF);
    const initialCache = database
      .prepare("SELECT valid_from_ms, valid_to_ms FROM usage_quota_window_cache WHERE singleton = 1")
      .get();
    assert.equal(Number(initialCache.valid_from_ms), AS_OF - 5 * MINUTE);
    assert.equal(Number(initialCache.valid_to_ms), AS_OF + 295 * MINUTE);
    database.close();

    database = new DatabaseSync(file);
    const reopened = countedDatabase(database);
    const reused = selectStoredQuotaWindows(reopened.database, AS_OF + MINUTE);
    assert.equal(reopened.counts.baseScans, 0);
    assert.deepEqual(reused, selectQuotaWindows(storedRows(database), AS_OF + MINUTE));

    const advanced = selectStoredQuotaWindows(reopened.database, AS_OF + 296 * MINUTE);
    assert.deepEqual(advanced, selectQuotaWindows(storedRows(database), AS_OF + 296 * MINUTE));
    assert.equal(reopened.counts.baseScans, 0, "clock changes use persisted endpoints and time boundaries");
    const advancedCache = database
      .prepare("SELECT valid_from_ms FROM usage_quota_window_cache WHERE singleton = 1")
      .get();
    assert.equal(Number(advancedCache.valid_from_ms), AS_OF + 295 * MINUTE);

    const oldFallback = selectStoredQuotaWindows(reopened.database, AS_OF - 10 * MINUTE);
    assert.deepEqual(oldFallback, selectQuotaWindows(storedRows(database), AS_OF - 10 * MINUTE));
    const unchangedCache = database
      .prepare("SELECT valid_from_ms FROM usage_quota_window_cache WHERE singleton = 1")
      .get();
    assert.equal(Number(unchangedCache.valid_from_ms), AS_OF + 295 * MINUTE);
  } finally {
    if (database) database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache validity follows observed, reset, and reset-start boundaries", () => {
  const database = createDatabase();
  ensureUsageQuotaSchema(database);
  insertRows(database, [
    row("boundary", 1, {
      observedAtMs: AS_OF - 30 * MINUTE,
      resetsAtMs: AS_OF + 300 * MINUTE,
    }),
    row("boundary", 2, {
      role: "secondary",
      observedAtMs: AS_OF + 10 * MINUTE,
      resetsAtMs: AS_OF + 400 * MINUTE,
    }),
  ]);

  const beforeStart = selectStoredQuotaWindows(database, AS_OF - MINUTE);
  assert.equal(beforeStart.windows.quota_5h.state, "missing");
  const firstBounds = database.prepare("SELECT valid_to_ms FROM usage_quota_window_cache WHERE singleton = 1").get();
  assert.equal(Number(firstBounds.valid_to_ms), AS_OF);

  const atStart = selectStoredQuotaWindows(database, AS_OF);
  assert.equal(atStart.windows.quota_5h.state, "available");
  const nextObserved = database
    .prepare("SELECT valid_from_ms, valid_to_ms FROM usage_quota_window_cache WHERE singleton = 1")
    .get();
  assert.equal(Number(nextObserved.valid_from_ms), AS_OF);
  assert.equal(Number(nextObserved.valid_to_ms), AS_OF + 10 * MINUTE);

  selectStoredQuotaWindows(database, AS_OF + 11 * MINUTE);
  const afterObserved = database
    .prepare("SELECT valid_from_ms FROM usage_quota_window_cache WHERE singleton = 1")
    .get();
  assert.equal(Number(afterObserved.valid_from_ms), AS_OF + 10 * MINUTE);
});

test("read transactions reuse matching cache, miss into bounded SQL, and let writers commit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-quota-snapshot-"));
  const file = path.join(directory, "usage.sqlite");
  let reader;
  let writer;
  try {
    writer = createDatabase(file);
    writer.exec("PRAGMA journal_mode = WAL");
    ensureUsageQuotaSchema(writer);
    insertRows(writer, [
      row("snapshot", 1, {
        observedAtMs: AS_OF - 5 * MINUTE,
        resetsAtMs: AS_OF + 295 * MINUTE,
        usedPercent: 20,
      }),
    ]);
    selectStoredQuotaWindows(writer, AS_OF);
    const expectedOld = selectQuotaWindows(storedRows(writer), AS_OF + 296 * MINUTE);
    const cacheBefore = writer
      .prepare("SELECT quota_revision, valid_from_ms FROM usage_quota_window_cache WHERE singleton = 1")
      .get();

    reader = new DatabaseSync(file);
    const countedReader = countedDatabase(reader);
    ensureUsageQuotaSchema(countedReader.database);
    reader.exec("PRAGMA busy_timeout = 5000; BEGIN; SELECT COUNT(*) FROM rate_limit_observations;");
    assert.deepEqual(
      selectStoredQuotaWindows(countedReader.database, AS_OF + MINUTE),
      selectQuotaWindows(storedRows(writer), AS_OF + MINUTE),
    );
    assert.equal(countedReader.counts.baseScans, 0);
    writer.prepare("UPDATE rate_limit_observations SET resets_at_ms = ?").run(AS_OF + 400 * MINUTE);

    const snapshot = selectStoredQuotaWindows(countedReader.database, AS_OF + 296 * MINUTE);
    assert.deepEqual(snapshot, expectedOld);
    assert.equal(countedReader.counts.baseScans, 0, "the pinned snapshot can reuse its persisted quota inputs");
    const cacheDuringRead = reader
      .prepare("SELECT quota_revision, valid_from_ms FROM usage_quota_window_cache WHERE singleton = 1")
      .get();
    assert.deepEqual(cacheDuringRead, cacheBefore);
    reader.exec("ROLLBACK");

    const fresh = selectStoredQuotaWindows(reader, AS_OF + 296 * MINUTE);
    assert.equal(
      fresh.windows.quota_5h.state,
      selectQuotaWindows(storedRows(writer), AS_OF + 296 * MINUTE).windows.quota_5h.state,
    );
  } finally {
    if (reader) reader.close();
    if (writer) writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("quota rollback reverts revision without leaving a transaction-local cache result", () => {
  const database = createDatabase();
  ensureUsageQuotaSchema(database);
  insertRows(database, [
    row("rollback", 1, {
      observedAtMs: AS_OF - 5 * MINUTE,
      resetsAtMs: AS_OF + 295 * MINUTE,
    }),
  ]);
  selectStoredQuotaWindows(database, AS_OF);
  const cacheBefore = database
    .prepare("SELECT quota_revision, valid_from_ms, valid_to_ms, result_json FROM usage_quota_window_cache")
    .get();
  const revisionBefore = quotaRevision(database);

  database.exec("BEGIN");
  insertRows(database, [
    row("rollback", 2, {
      role: "secondary",
      observedAtMs: AS_OF + MINUTE,
      resetsAtMs: AS_OF + 301 * MINUTE,
    }),
  ]);
  assert.equal(quotaRevision(database), revisionBefore + 1);
  selectStoredQuotaWindows(database, AS_OF + 2 * MINUTE);
  const cacheDuring = database
    .prepare("SELECT quota_revision, valid_from_ms, valid_to_ms, result_json FROM usage_quota_window_cache")
    .get();
  assert.deepEqual(cacheDuring, cacheBefore);
  database.exec("ROLLBACK");

  assert.equal(quotaRevision(database), revisionBefore);
  const cacheAfter = database
    .prepare("SELECT quota_revision, valid_from_ms, valid_to_ms, result_json FROM usage_quota_window_cache")
    .get();
  assert.deepEqual(cacheAfter, cacheBefore);
  assert.deepEqual(
    selectStoredQuotaWindows(database, AS_OF + 2 * MINUTE),
    selectQuotaWindows(storedRows(database), AS_OF + 2 * MINUTE),
  );
});

test("read-only databases fall back to TEMP SQL without requiring durable writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-usage-quota-readonly-"));
  const file = path.join(directory, "usage.sqlite");
  let database;
  let readOnly;
  try {
    database = createDatabase(file);
    ensureUsageQuotaSchema(database);
    insertRows(database, [row("readonly", 1)]);
    database.close();
    database = null;

    readOnly = new DatabaseSync(file, { readOnly: true });
    assert.equal(ensureUsageQuotaSchema(readOnly), true, "an initialized schema needs no write lock");
    const counted = countedDatabase(readOnly);
    const result = selectStoredQuotaWindows(counted.database, AS_OF);
    assert.deepEqual(result, selectQuotaWindows(storedRows(readOnly), AS_OF));
    assert.ok(counted.counts.baseScans > 0);
    assert.equal(readOnly.prepare("SELECT COUNT(*) AS count FROM usage_quota_window_cache").get().count, 0);
  } finally {
    if (database) database.close();
    if (readOnly) readOnly.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("consumed iterables release every TEMP table", () => {
  const database = createDatabase();
  insertRows(database, [
    row("one", 1, {
      role: "primary",
      observedAtMs: AS_OF - 400 * MINUTE,
      resetsAtMs: AS_OF - 100 * MINUTE,
    }),
    row("two", 2, {
      role: "secondary",
      observedAtMs: AS_OF - 200 * MINUTE,
      resetsAtMs: AS_OF + 100 * MINUTE,
    }),
  ]);
  const tempObjects = () =>
    database
      .prepare("SELECT name, type FROM sqlite_temp_master WHERE type IN ('table', 'view') ORDER BY type, name")
      .all()
      .map((entry) => `${entry.type}:${entry.name}`);
  assert.deepEqual(tempObjects(), []);
  const windows = iterateStoredQuotaWindows(database, "codex", AS_OF, 300);
  assert.notEqual(windows, null);
  [...windows];
  assert.deepEqual(tempObjects(), []);
  selectStoredQuotaWindows(database, AS_OF);
  assert.deepEqual(tempObjects(), []);
});
