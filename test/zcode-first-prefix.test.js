import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { UsageStore } from "../src/usage-store.js";
import {
  FIXTURE_TIME,
  createRemainingHarnessFixture,
  insertDatabaseEvent,
} from "../test-support/remaining-harness-fixture.mjs";

const FILTERS = {
  preset: "all",
  calendarZone: "utc",
  bucket: "day",
  now: new Date(FIXTURE_TIME + 86_400_000),
};
const DASHBOARD_OPTIONS = { includeDetails: false };

function sourceSql(file, callback) {
  const database = new DatabaseSync(file.filePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function appendEvent(file, index) {
  sourceSql(file, (database) => insertDatabaseEvent(database, "zcode", index));
}

function eventRows(store) {
  return store.database.prepare("SELECT * FROM events ORDER BY id").all();
}

function replacedFacts(store) {
  return store.database
    .prepare(`SELECT fact_table,source_kind,home_id,source_path,payload_digest,occurrence_count,payload,
      source_home_label,source_home_path,method_version,revision_reason
      FROM history_replaced_facts ORDER BY fact_table,source_path,payload_digest`)
    .all();
}

function installEventAudit(store) {
  store.database.exec(`CREATE TEMP TABLE zcode_prefix_audit(operation TEXT NOT NULL);
    CREATE TEMP TRIGGER zcode_prefix_insert AFTER INSERT ON main.events
      BEGIN INSERT INTO zcode_prefix_audit VALUES ('insert'); END;
    CREATE TEMP TRIGGER zcode_prefix_update AFTER UPDATE ON main.events
      BEGIN INSERT INTO zcode_prefix_audit VALUES ('update'); END;
    CREATE TEMP TRIGGER zcode_prefix_delete AFTER DELETE ON main.events
      BEGIN INSERT INTO zcode_prefix_audit VALUES ('delete'); END;`);
}

function eventWrites(store) {
  return {
    ...store.database
      .prepare(`SELECT
      COUNT(CASE WHEN operation='insert' THEN 1 END) AS inserted,
      COUNT(CASE WHEN operation='update' THEN 1 END) AS updated,
      COUNT(CASE WHEN operation='delete' THEN 1 END) AS deleted
      FROM zcode_prefix_audit`)
      .get(),
  };
}

function publish(store, file) {
  return store.replaceFile({ ...file, info: statSync(file.filePath) });
}

async function assertDashboardParity(actual, legacy) {
  assert.deepEqual(eventRows(actual), eventRows(legacy));
  assert.deepEqual(replacedFacts(actual), replacedFacts(legacy));
  assert.deepEqual(
    await actual.dashboardHistory(FILTERS, DASHBOARD_OPTIONS),
    await legacy.dashboardHistory(FILTERS, DASHBOARD_OPTIONS),
  );
}

async function fixture(t, count = 3) {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-first-prefix-"));
  const file = createRemainingHarnessFixture(path.join(root, "source"), "zcode", count);
  const actualFile = path.join(root, "actual.sqlite");
  const legacyFile = path.join(root, "legacy.sqlite");
  const stores = [];
  const open = async ({ databaseFile = actualFile, legacy = false } = {}) => {
    const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
    if (legacy) store.reuseSourcePrefix = async () => null;
    stores.push(store);
    await store.open();
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const actual = await open();
  const legacy = await open({ databaseFile: legacyFile, legacy: true });
  await publish(actual, file);
  await publish(legacy, file);
  return { actual, legacy, file, open };
}

function captureReuseAttempts(store) {
  const attempts = [];
  const reuse = store.reuseSourcePrefix.bind(store);
  store.reuseSourcePrefix = async (...args) => {
    const result = await reuse(...args);
    attempts.push(result);
    return result;
  };
  return attempts;
}

function assertPrefixReuse(store, result, prefix) {
  assert.equal(result.committed, true);
  assert.equal(result.reusedPrefix, true);
  assert.equal(result.reusedEvents, prefix);
  assert.equal(result.insertedEvents, 1);
  assert.equal(result.checkedEvents, prefix + 1);
  assert.deepEqual(eventWrites(store), { inserted: 1, updated: 0, deleted: 0 });
}

test("ZCode dashboard-warmed and reopened stores preserve the prefix for a one-row append", async (t) => {
  const { actual, legacy, file, open } = await fixture(t);
  await actual.dashboardHistory(FILTERS, DASHBOARD_OPTIONS);

  let prefix = eventRows(actual);
  appendEvent(file, 3);
  installEventAudit(actual);
  const warm = await publish(actual, file);
  assertPrefixReuse(actual, warm, 3);
  assert.deepEqual(eventRows(actual).slice(0, 3), prefix);
  assert.deepEqual(
    eventRows(actual).map(({ id, session_id, total }) => ({ id, session_id, total })),
    [
      { id: 1, session_id: "session-0", total: 160 },
      { id: 2, session_id: "session-1", total: 161 },
      { id: 3, session_id: "session-2", total: 162 },
      { id: 4, session_id: "session-3", total: 163 },
    ],
  );
  await publish(legacy, file);
  await assertDashboardParity(actual, legacy);

  actual.close();
  const reopened = await open();
  await reopened.dashboardHistory(FILTERS, DASHBOARD_OPTIONS);
  prefix = eventRows(reopened);
  appendEvent(file, 4);
  installEventAudit(reopened);
  const afterReopen = await publish(reopened, file);
  assertPrefixReuse(reopened, afterReopen, 4);
  assert.deepEqual(eventRows(reopened).slice(0, 4), prefix);
  assert.deepEqual(
    eventRows(reopened).map(({ id, session_id, total }) => ({ id, session_id, total })),
    [
      { id: 1, session_id: "session-0", total: 160 },
      { id: 2, session_id: "session-1", total: 161 },
      { id: 3, session_id: "session-2", total: 162 },
      { id: 4, session_id: "session-3", total: 163 },
      { id: 5, session_id: "session-4", total: 164 },
    ],
  );
  await publish(legacy, file);
  await assertDashboardParity(reopened, legacy);
  assert.deepEqual((await reopened.dashboardHistory(FILTERS, DASHBOARD_OPTIONS)).summary.totals, {
    total: 810,
    input: 700,
    cached: 150,
    output: 110,
    reasoning: 25,
  });
});

test("a read transaction held by the warming connection prevents reuse and protects published facts", async (t) => {
  const { actual, file } = await fixture(t);
  appendEvent(file, 3);
  installEventAudit(actual);
  const before = eventRows(actual);

  actual.database.exec("BEGIN");
  actual.database.prepare("SELECT COUNT(*) AS count FROM events").get();
  assert.equal(
    await actual.reuseSourcePrefix({ ...file, info: statSync(file.filePath) }),
    null,
    "prefix reuse must not begin a write while the same connection holds a read transaction",
  );
  await assert.rejects(publish(actual, file), /cannot start a transaction within a transaction/);
  assert.equal(actual.database.isTransaction, true);
  assert.equal(actual.writeTransactionDepth, 0);
  assert.deepEqual(eventRows(actual), before);
  assert.deepEqual(eventWrites(actual), { inserted: 0, updated: 0, deleted: 0 });

  actual.database.exec("ROLLBACK");
  const retry = await publish(actual, file);
  assertPrefixReuse(actual, retry, 3);
});

function reviseOldRow(file) {
  sourceSql(file, (database) => {
    database.prepare("UPDATE model_usage SET output_tokens=31,computed_total_tokens=171 WHERE id='event-1'").run();
  });
}

function insertBeforePrefix(file) {
  sourceSql(file, (database) => {
    insertDatabaseEvent(database, "zcode", 9);
    database
      .prepare("UPDATE model_usage SET started_at=?,completed_at=? WHERE id='event-9'")
      .run(FIXTURE_TIME - 2000, FIXTURE_TIME - 1000);
  });
}

function catalogFor(checkedAt, multiplier) {
  const catalog = getPricingCatalog();
  const entry = catalog.models["gpt-6-sol"];
  for (const context of ["short", "long"]) {
    entry[context] = Object.fromEntries(
      Object.entries(entry[context]).map(([field, value]) => [field, value * multiplier]),
    );
  }
  return { ...catalog, checkedAt };
}

for (const [label, mutate, count] of [
  ["old-row revision", reviseOldRow, 3],
  ["non-tail insert", insertBeforePrefix, 4],
]) {
  test(`ZCode ${label} falls back and matches the independent disabled-prefix path`, async (t) => {
    const { actual, legacy, file } = await fixture(t);
    const attempts = captureReuseAttempts(actual);
    mutate(file);
    installEventAudit(actual);

    const result = await publish(actual, file);
    assert.deepEqual(attempts, [null]);
    assert.notEqual(result.reusedPrefix, true);
    await publish(legacy, file);

    assert.deepEqual(eventWrites(actual), { inserted: count, updated: 0, deleted: 3 });
    assert.deepEqual(
      eventRows(actual).map(({ id }) => id),
      Array.from({ length: count }, (_, index) => index + 1),
    );
    await assertDashboardParity(actual, legacy);
  });
}

test("ZCode append falls back when the active pricing catalog changes the stored price version", async (t) => {
  const original = getPricingCatalog();
  t.after(() => setPricingCatalog(original));
  const catalogA = setPricingCatalog(catalogFor("2026-10-19", 1));
  const { actual, legacy, file } = await fixture(t);
  assert.deepEqual([...new Set(eventRows(actual).map(({ price_version }) => price_version))], [catalogA.version]);

  const attempts = captureReuseAttempts(actual);
  const catalogB = setPricingCatalog(catalogFor("2026-10-20", 1.5));
  assert.notEqual(catalogB.version, catalogA.version);
  appendEvent(file, 3);
  installEventAudit(actual);
  const result = await publish(actual, file);
  assert.deepEqual(attempts, [null]);
  assert.notEqual(result.reusedPrefix, true);
  assert.deepEqual([...new Set(eventRows(actual).map(({ price_version }) => price_version))], [catalogB.version]);
  assert.deepEqual(eventWrites(actual), { inserted: 4, updated: 0, deleted: 3 });

  await publish(legacy, file);
  await assertDashboardParity(actual, legacy);
});
