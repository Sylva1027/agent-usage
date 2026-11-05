import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";
import {
  FIXTURE_TIME,
  REMAINING_HARNESSES,
  createRemainingHarnessFixture,
  insertDatabaseEvent,
  transcriptRows,
} from "../test-support/remaining-harness-fixture.mjs";

const FILTERS = { preset: "all", calendarZone: "utc", bucket: "day", now: new Date(FIXTURE_TIME + 86_400_000) };

function sql(filePath, callback) {
  const database = new DatabaseSync(filePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function appendEvent(file, index, { late = false } = {}) {
  const { filePath, source } = file;
  if (filePath.endsWith(".jsonl")) {
    for (const record of transcriptRows(source.kind, index)) {
      if (late) record.timestamp = new Date(FIXTURE_TIME - 1000).toISOString();
      appendFileSync(filePath, `${JSON.stringify(record)}\n`);
    }
  } else {
    sql(filePath, (database) => {
      insertDatabaseEvent(database, source.kind, index);
      if (!late) return;
      if (source.kind === "zcode") {
        database
          .prepare("UPDATE model_usage SET started_at=?,completed_at=? WHERE id=?")
          .run(FIXTURE_TIME - 1001, FIXTURE_TIME - 1000, `event-${index}`);
      } else {
        const row = database.prepare("SELECT data FROM session_message WHERE id=?").get(`event-${index}`);
        const data = JSON.parse(row.data);
        data.time.completed = FIXTURE_TIME - 1000;
        database
          .prepare("UPDATE session_message SET time_created=?,data=? WHERE id=?")
          .run(FIXTURE_TIME - 1001, JSON.stringify(data), `event-${index}`);
      }
    });
  }
}

function reviseEvent(file, mutation) {
  if (mutation === "reorder") return appendEvent(file, 3, { late: true });
  const { filePath, source } = file;
  if (filePath.endsWith(".jsonl")) {
    // Only the three-event fixtures use this rewrite; scale fixtures append without materializing their history.
    const rows = readFileSync(filePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const changed = [];
    for (const row of rows) {
      const selected = (row.message?.id || row.providerData?.messageId) === "message-1";
      if (selected && mutation === "delete") continue;
      if (selected) {
        if (source.kind === "claude") row.message.usage.output_tokens += 11;
        else {
          row.providerData.usage.outputTokens += 11;
          row.providerData.usage.totalTokens += 11;
        }
      }
      changed.push(JSON.stringify(row));
    }
    writeFileSync(filePath, `${changed.join("\n")}\n`);
  } else {
    sql(filePath, (database) => {
      const table = source.kind === "zcode" ? "model_usage" : "session_message";
      if (mutation === "delete") database.prepare(`DELETE FROM ${table} WHERE id=?`).run("event-1");
      else if (source.kind === "zcode") {
        database
          .prepare(
            "UPDATE model_usage SET output_tokens=output_tokens+?,computed_total_tokens=computed_total_tokens+? WHERE id=?",
          )
          .run(11, 11, "event-1");
      } else {
        const data = JSON.parse(database.prepare("SELECT data FROM session_message WHERE id=?").get("event-1").data);
        data.tokens.output += 11;
        database.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify(data), "event-1");
      }
    });
  }
}

function installAudit(store) {
  store.database.exec(`CREATE TEMP TABLE prefix_event_audit(operation TEXT NOT NULL);
    CREATE TEMP TRIGGER prefix_insert AFTER INSERT ON main.events
      BEGIN INSERT INTO prefix_event_audit VALUES ('insert'); END;
    CREATE TEMP TRIGGER prefix_update AFTER UPDATE ON main.events
      BEGIN INSERT INTO prefix_event_audit VALUES ('update'); END;
    CREATE TEMP TRIGGER prefix_delete AFTER DELETE ON main.events
      BEGIN INSERT INTO prefix_event_audit VALUES ('delete'); END;`);
}

function assertWrites(store, inserted, deleted = 0, updated = 0) {
  assert.deepEqual(
    {
      ...store.database
        .prepare(`SELECT
    COUNT(CASE WHEN operation='insert' THEN 1 END) AS inserted,
    COUNT(CASE WHEN operation='delete' THEN 1 END) AS deleted,
    COUNT(CASE WHEN operation='update' THEN 1 END) AS updated FROM prefix_event_audit`)
        .get(),
    },
    { inserted, deleted, updated },
  );
}

function assertSameRows(actual, legacy, query, parameters = []) {
  const expected = legacy.database.prepare(query).iterate(...parameters);
  let count = 0;
  for (const row of actual.database.prepare(query).iterate(...parameters)) {
    const next = expected.next();
    assert.equal(next.done, false, `unexpected row ${count}: ${query}`);
    assert.deepEqual(row, next.value, `row ${count}: ${query}`);
    count++;
  }
  assert.equal(expected.next().done, true, `missing rows: ${query}`);
  return count;
}

function assertParity(pair, count) {
  assert.equal(assertSameRows(pair.actual, pair.legacy, "SELECT * FROM events ORDER BY id"), count);
  assertSameRows(
    pair.actual,
    pair.legacy,
    "SELECT path,kind,home_id,home_label,home_path,size,mtime_ms FROM source_files ORDER BY path",
  );
  assertSameRows(
    pair.actual,
    pair.legacy,
    `SELECT fact_table,source_kind,home_id,source_path,payload_digest,
    occurrence_count,payload,source_home_label,source_home_path,method_version,revision_reason
    FROM history_replaced_facts ORDER BY fact_table,source_path,payload_digest`,
  );
  // Fixed time makes every business and monetary field comparable, including exact floating-point sums.
  assert.deepEqual(pair.actual.summarize(FILTERS), pair.legacy.summarize(FILTERS));
}

async function publish(store, file, options) {
  return store.replaceFile({ ...file, info: statSync(file.filePath) }, options);
}

async function fixture(t, kind, count = 3) {
  const root = mkdtempSync(path.join(tmpdir(), "usage-prefix-publication-"));
  const file = createRemainingHarnessFixture(path.join(root, "source"), kind, count);
  const stores = [];
  const pair = { root, file, actual: null, legacy: null, attempts: [], parsed: 0 };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  pair.open = async (legacy = false) => {
    const store = new UsageStore({
      homeDir: root,
      env: {},
      importDirs: [],
      databaseFile: path.join(root, legacy ? "legacy.sqlite" : "actual.sqlite"),
    });
    stores.push(store);
    if (legacy) store.reuseSourcePrefix = async () => null;
    store.repositoryResolver = (cwd) => {
      if (!legacy) pair.parsed++;
      return { key: `directory:${cwd}`, path: cwd, kind: "directory" };
    };
    await store.open();
    return store;
  };
  pair.actual = await pair.open();
  pair.legacy = await pair.open(true);
  await publish(pair.actual, file);
  await publish(pair.legacy, file);
  assertParity(pair, count);
  assert.equal(STORE_SCHEMA_VERSION, 24);
  assert.equal(pair.actual.database.prepare("PRAGMA user_version").get().user_version, 24);
  assert.match(
    pair.actual.database.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get().sql,
    /id INTEGER PRIMARY KEY,/,
  );
  assert.doesNotMatch(
    pair.actual.database.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get().sql,
    /AUTOINCREMENT/i,
  );
  assert.equal(typeof pair.actual.reuseSourcePrefix, "function", "UsageStore must expose the prefix publication API");
  const reuse = pair.actual.reuseSourcePrefix.bind(pair.actual);
  pair.actual.reuseSourcePrefix = async (...args) => {
    const result = await reuse(...args);
    pair.attempts.push(result);
    return result;
  };
  installAudit(pair.actual);
  pair.reset = () => {
    pair.attempts.length = 0;
    pair.parsed = 0;
    pair.actual.database.exec("DELETE FROM prefix_event_audit");
  };
  pair.reset();
  return pair;
}

function assertReused(pair, result, prefix, delta) {
  assert.equal(pair.attempts.length, 1, "replaceFile must try prefix reuse once");
  assert.equal(result, pair.attempts[0]);
  assert.equal(result.committed, true);
  assert.equal(result.appended, false, "the source parser still scans the complete source");
  assert.equal(result.reusedPrefix, true);
  assert.equal(result.reusedEvents, prefix);
  assert.equal(result.insertedEvents, delta);
  assert.equal(result.checkedEvents, prefix + delta);
  assert.equal(result.parsedBytes, statSync(pair.file.filePath).size);
  assert.equal(pair.parsed, prefix + delta, "all normalized source events must be parsed, including the old prefix");
  assertWrites(pair.actual, delta);
}

function assertFallback(pair, result, inserted, deleted) {
  assert.deepEqual(pair.attempts, [null]);
  assert.equal(result.committed, true);
  assert.notEqual(result.reusedPrefix, true);
  assertWrites(pair.actual, inserted, deleted);
}

for (const kind of REMAINING_HARNESSES) {
  test(`${kind}: suffix append writes one event; unchanged usage writes none`, async (t) => {
    const pair = await fixture(t, kind);
    const prefix = pair.actual.database.prepare("SELECT * FROM events ORDER BY id").all();
    appendEvent(pair.file, 3);
    const result = await publish(pair.actual, pair.file);
    await publish(pair.legacy, pair.file);
    assertReused(pair, result, 3, 1);
    assert.deepEqual(pair.actual.database.prepare("SELECT * FROM events WHERE id<=3 ORDER BY id").all(), prefix);
    assertParity(pair, 4);
    assert.equal(pair.actual.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts").get().n, 0);

    pair.reset();
    // Change bytes/metadata without changing any selected usage fact.
    if (pair.file.filePath.endsWith(".jsonl"))
      appendFileSync(pair.file.filePath, '{"type":"metadata","note":"changed"}\n');
    else
      sql(pair.file.filePath, (database) =>
        database.exec(`UPDATE ${kind === "zcode" ? "session" : "session_v2"} SET notes='changed metadata'`),
      );
    const unchanged = await publish(pair.actual, pair.file);
    await publish(pair.legacy, pair.file);
    assertReused(pair, unchanged, 4, 0);
    assertParity(pair, 4);
  });

  for (const mutation of ["correction", "delete", "reorder"]) {
    test(`${kind}: ${mutation} falls back with exact legacy ids and missing-history facts`, async (t) => {
      const pair = await fixture(t, kind);
      reviseEvent(pair.file, mutation);
      const count = mutation === "delete" ? 2 : mutation === "reorder" ? 4 : 3;
      const result = await publish(pair.actual, pair.file);
      await publish(pair.legacy, pair.file);
      assertFallback(pair, result, count, 3);
      assert.equal(
        pair.parsed,
        count + (mutation === "reorder" ? 1 : 2),
        "stop at the first differing fact, then parse once through the legacy replacement path",
      );
      assertParity(pair, count);
      assert.equal(
        pair.actual.database.prepare("SELECT SUM(occurrence_count) n FROM history_replaced_facts").get().n,
        mutation === "reorder" ? null : 1,
      );
    });
  }
}

test("a non-tail source falls back to preserve monetary addition order, then becomes reusable at the tail", async (t) => {
  const pair = await fixture(t, "zcode");
  const other = createRemainingHarnessFixture(path.join(pair.root, "other"), "opencode", 2);
  await publish(pair.actual, other);
  await publish(pair.legacy, other);
  pair.reset();
  appendEvent(pair.file, 3);
  const fallback = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertFallback(pair, fallback, 4, 3);
  assertParity(pair, 6);
  assert.deepEqual(
    pair.actual.database
      .prepare("SELECT id FROM events WHERE source_path=? ORDER BY id")
      .all(pair.file.filePath)
      .map(({ id }) => id),
    [6, 7, 8, 9],
  );

  pair.reset();
  appendEvent(pair.file, 4);
  const reused = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertReused(pair, reused, 4, 1);
  assertParity(pair, 7);
});

for (const gap of ["inside", "before"]) {
  test(`a gap ${gap} the final source ids forces a full replacement`, async (t) => {
    const pair = await fixture(t, "zcode");
    for (const store of [pair.actual, pair.legacy])
      store.database.exec(
        gap === "inside" ? "UPDATE events SET id=5 WHERE id=3" : "UPDATE events SET id=-id; UPDATE events SET id=1-id",
      );
    pair.reset();
    appendEvent(pair.file, 3);
    const result = await publish(pair.actual, pair.file);
    await publish(pair.legacy, pair.file);
    assertFallback(pair, result, 4, 3);
    assertParity(pair, 4);
  });
}

test("an external write to an old normalized field prevents trusting the previous prefix", async (t) => {
  const pair = await fixture(t, "zcode");
  for (const store of [pair.actual, pair.legacy]) {
    sql(store.databaseFile, (database) => database.exec("UPDATE events SET service_tier='priority' WHERE id=2"));
  }
  appendEvent(pair.file, 3);
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertFallback(pair, result, 4, 3);
  assertParity(pair, 4);
  assert.equal(pair.actual.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts").get().n, 1);
});

test("a changed semantic home binding falls back even for an otherwise identical prefix", async (t) => {
  const pair = await fixture(t, "claude");
  pair.file.source = {
    ...pair.file.source,
    id: "moved-home",
    label: "Moved home",
    path: path.join(pair.root, "moved"),
  };
  appendEvent(pair.file, 3);
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertFallback(pair, result, 4, 3);
  assertParity(pair, 4);
  assert.equal(pair.actual.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts").get().n, 3);
});

test("a registered source with zero events can publish its first event by prefix reuse", async (t) => {
  const pair = await fixture(t, "zcode", 0);
  appendEvent(pair.file, 0);
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertReused(pair, result, 0, 1);
  assertParity(pair, 1);
});

for (const extra of ["reparse", "quota", "rate", "progress"]) {
  test(`existing ${extra} state requires the legacy replacement path`, async (t) => {
    const pair = await fixture(t, "zcode");
    for (const store of [pair.actual, pair.legacy]) {
      const database = store.database;
      if (extra === "reparse") database.prepare("INSERT INTO usage_source_reparse VALUES (?)").run(pair.file.filePath);
      else if (extra === "quota")
        database
          .prepare("INSERT INTO quota_usage_sources VALUES (?,?,?,?,?,?)")
          .run(pair.file.filePath, pair.file.source.id, "session-0", FIXTURE_TIME, "api", 0);
      else if (extra === "rate")
        database
          .prepare(`INSERT INTO rate_limit_observations
        (source_path,line_number,role,observed_at_ms,limit_id,window_minutes,resets_at_ms,used_percent)
        VALUES (?,1,'primary',?,'fixture',300,?,10)`)
          .run(pair.file.filePath, FIXTURE_TIME, FIXTURE_TIME + 1000);
      else
        database
          .prepare("INSERT INTO usage_source_progress VALUES (?,?,?,?)")
          .run(pair.file.filePath, "untrusted binding", "{}", "{}");
    }
    appendEvent(pair.file, 3);
    const result = await publish(pair.actual, pair.file);
    await publish(pair.legacy, pair.file);
    assertFallback(pair, result, 4, 3);
    assertParity(pair, 4);
    for (const table of [
      "usage_source_reparse",
      "quota_usage_sources",
      "rate_limit_observations",
      "usage_source_progress",
    ])
      assertSameRows(pair.actual, pair.legacy, `SELECT * FROM ${table} ORDER BY source_path`);
  });
}

function retainedFacts(store) {
  return Object.fromEntries(
    ["events", "source_files", "history_replaced_facts"].map((table) => [
      table,
      store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

test("a source_files trigger that deletes usage retains legacy replacement results", async (t) => {
  const pair = await fixture(t, "zcode");
  for (const store of [pair.actual, pair.legacy]) {
    store.database.exec(`CREATE TRIGGER prefix_source_delete AFTER UPDATE ON source_files
      BEGIN DELETE FROM events WHERE source_path=NEW.path; END`);
  }
  appendEvent(pair.file, 3);
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertFallback(pair, result, 4, 3);
  assertParity(pair, 4);
});

test("a source_files trigger sees the old usage once through the legacy update columns", async (t) => {
  const pair = await fixture(t, "zcode");
  const before = pair.actual.database.prepare("SELECT COUNT(*) event_count,SUM(total) total FROM events").get();
  for (const store of [pair.actual, pair.legacy]) {
    store.database.exec(`CREATE TABLE prefix_source_audit(event_count INTEGER,total INTEGER);
      CREATE TRIGGER prefix_source_observe AFTER UPDATE OF home_id ON source_files
      BEGIN INSERT INTO prefix_source_audit
        SELECT COUNT(*),SUM(total) FROM events WHERE source_path=OLD.path; END`);
  }
  appendEvent(pair.file, 3);
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertFallback(pair, result, 4, 3);
  assertSameRows(pair.actual, pair.legacy, "SELECT * FROM prefix_source_audit ORDER BY rowid");
  assert.deepEqual(pair.actual.database.prepare("SELECT * FROM prefix_source_audit ORDER BY rowid").all(), [before]);
  assertParity(pair, 4);
});

test("an extra events column falls back and resets its old values exactly like legacy replacement", async (t) => {
  const pair = await fixture(t, "zcode");
  for (const store of [pair.actual, pair.legacy]) {
    store.database.exec(
      "ALTER TABLE events ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0; UPDATE events SET reviewed=1",
    );
  }
  pair.reset();
  appendEvent(pair.file, 3);
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assertFallback(pair, result, 4, 3);
  assertParity(pair, 4);
  assert.equal(pair.actual.database.prepare("SELECT COUNT(*) n FROM events WHERE reviewed<>0").get().n, 0);
});

test("WorkBuddy preserves a malformed-JSON warning before a fatal timestamp and rolls back", async (t) => {
  const pair = await fixture(t, "workbuddy");
  const beforeActual = retainedFacts(pair.actual),
    beforeLegacy = retainedFacts(pair.legacy);
  appendFileSync(pair.file.filePath, "{malformed JSON\n");
  const invalid = transcriptRows("workbuddy", 3)[2];
  invalid.timestamp = 8_640_000_000_000_001;
  appendFileSync(pair.file.filePath, `${JSON.stringify(invalid)}\n`);
  const actualWarnings = [],
    legacyWarnings = [];
  await assert.rejects(publish(pair.actual, pair.file, { onWarning: (warning) => actualWarnings.push(warning) }), {
    name: "RangeError",
    message: "Invalid time value",
  });
  await assert.rejects(publish(pair.legacy, pair.file, { onWarning: (warning) => legacyWarnings.push(warning) }), {
    name: "RangeError",
    message: "Invalid time value",
  });
  assert.equal(legacyWarnings.length, 1);
  assert.match(legacyWarnings[0], /WORKBUDDY_MALFORMED_JSON:1/);
  assert.deepEqual(actualWarnings, legacyWarnings);
  assert.deepEqual(retainedFacts(pair.actual), beforeActual);
  assert.deepEqual(retainedFacts(pair.legacy), beforeLegacy);
  assertWrites(pair.actual, 0);
  assert.equal(pair.actual.database.isTransaction, false);
  assert.equal(pair.actual.writeTransactionDepth, 0);
});

test("a new-event INSERT failure rolls back every write and reopening can finish", async (t) => {
  const pair = await fixture(t, "zcode");
  const before = retainedFacts(pair.actual);
  appendEvent(pair.file, 3);
  appendEvent(pair.file, 4);
  pair.actual.database.exec(`CREATE TRIGGER prefix_fail_insert BEFORE INSERT ON events
    WHEN NEW.session_id='session-4' BEGIN SELECT RAISE(ABORT,'prefix injected insert failure'); END`);
  await assert.rejects(publish(pair.actual, pair.file), /prefix injected insert failure/);
  assert.deepEqual(retainedFacts(pair.actual), before);
  assertWrites(pair.actual, 0);
  assert.equal(pair.actual.database.isTransaction, false);
  assert.equal(pair.actual.writeTransactionDepth, 0);
  pair.actual.close();
  sql(pair.actual.databaseFile, (database) => database.exec("DROP TRIGGER prefix_fail_insert"));
  pair.actual = await pair.open();
  const result = await publish(pair.actual, pair.file);
  await publish(pair.legacy, pair.file);
  assert.equal(result.reusedPrefix, true);
  assert.equal(result.reusedEvents, 3);
  assert.equal(result.insertedEvents, 2);
  assertParity(pair, 5);
});

test("a throwing malformed-JSON warning callback restores facts and source metadata before reopen", async (t) => {
  const pair = await fixture(t, "claude");
  const before = retainedFacts(pair.actual);
  appendEvent(pair.file, 3);
  appendFileSync(pair.file.filePath, "{malformed JSON\n");
  const failure = new Error("prefix injected warning failure");
  let warnings = 0;
  await assert.rejects(
    publish(pair.actual, pair.file, {
      onWarning: (warning) => {
        assert.match(warning, /CLAUDE_MALFORMED_JSON:1/);
        warnings++;
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(warnings, 1);
  assert.deepEqual(retainedFacts(pair.actual), before);
  assertWrites(pair.actual, 0);
  assert.equal(pair.actual.database.isTransaction, false);
  assert.equal(pair.actual.writeTransactionDepth, 0);
  pair.actual.close();
  pair.actual = await pair.open();
  const actualWarnings = [],
    legacyWarnings = [];
  const result = await publish(pair.actual, pair.file, { onWarning: (warning) => actualWarnings.push(warning) });
  await publish(pair.legacy, pair.file, { onWarning: (warning) => legacyWarnings.push(warning) });
  assert.equal(result.reusedPrefix, true);
  assert.deepEqual(actualWarnings, legacyWarnings);
  assert.equal(actualWarnings.length, 1);
  assertParity(pair, 4);
});

for (const count of [1000, 10_000]) {
  test(`ZCode ${count}-event history: one row write while explicitly scanning all ${count + 1} events`, async (t) => {
    const pair = await fixture(t, "zcode", count);
    appendEvent(pair.file, count);
    const result = await publish(pair.actual, pair.file);
    await publish(pair.legacy, pair.file);
    assertReused(pair, result, count, 1);
    assertParity(pair, count + 1);
    assert.equal(pair.actual.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts").get().n, 0);
  });
}
