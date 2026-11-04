import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_KEY = "history_archive_event_authority";
const AS_OF = new Date("2026-07-13T12:00:00.000Z");

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function tokenRow(timestamp, total) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: Math.max(0, total - 10),
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  };
}

async function writeRollout(file, { session, model, timestamp, total }) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    jsonl([
      {
        timestamp,
        type: "session_meta",
        payload: { id: session, source: "cli", originator: "codex-tui", cwd: "/work/metadata" },
      },
      { type: "turn_context", payload: { model } },
      tokenRow(timestamp, total),
    ]),
  );
}

async function appendUsage(file, { model, timestamp, total }) {
  await appendFile(file, jsonl([{ type: "turn_context", payload: { model } }, tokenRow(timestamp, total)]));
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-metadata-integration-"));
  const homeA = path.join(root, "codex-a");
  const homeB = path.join(root, "codex-b");
  const fileA = path.join(homeA, "sessions", "2026", "07", "12", "rollout-a.jsonl");
  const fileB = path.join(homeB, "sessions", "2026", "07", "12", "rollout-b.jsonl");
  await writeRollout(fileA, {
    session: "session-a",
    model: "gpt-6-sol",
    timestamp: "2026-07-12T01:00:00.000Z",
    total: 123,
  });
  await writeRollout(fileB, {
    session: "session-b",
    model: "gpt-6-mini",
    timestamp: "2026-07-12T02:00:00.000Z",
    total: 100,
  });
  const options = {
    homeDir: root,
    env: {},
    extraHomes: [homeA, homeB].join(path.delimiter),
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  return {
    root,
    homeA,
    homeB,
    fileA,
    fileB,
    options,
    databaseFile: path.join(root, "usage.sqlite"),
  };
}

function eventTemplate(database, sourcePath) {
  const row = database.prepare("SELECT * FROM events WHERE source_path = ? ORDER BY id LIMIT 1").get(sourcePath);
  if (!row) throw new Error(`Missing event fixture for ${sourcePath}`);
  return { ...row };
}

function eventValues(template, overrides = {}) {
  const value = { ...template, ...overrides };
  delete value.id;
  if (overrides.timestamp_ms !== undefined) {
    const iso = new Date(Number(overrides.timestamp_ms)).toISOString();
    value.hour_key = `${iso.slice(0, 13).replace("T", " ")}:00`;
    value.day_key = iso.slice(0, 10);
    value.week_key = iso.slice(0, 10);
    value.month_key = iso.slice(0, 7);
  }
  return value;
}

function insertEventCopy(database, template, overrides = {}) {
  const value = eventValues(template, overrides);
  const columns = Object.keys(value);
  const result = database
    .prepare(`INSERT INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((column) => value[column]));
  return Number(result.lastInsertRowid);
}

function replaceEventCopy(database, template, overrides = {}) {
  const value = { ...eventValues(template, overrides), id: template.id };
  const columns = Object.keys(value);
  database
    .prepare(`INSERT OR REPLACE INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((column) => value[column]));
}

function replaceEventCopyWithNewId(database, template, overrides = {}) {
  const value = eventValues(template, overrides);
  const columns = Object.keys(value);
  database
    .prepare(`INSERT OR REPLACE INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((column) => value[column]));
}

async function legacyMetadata(store, fixture, asOf, databaseFile = fixture.databaseFile) {
  const oracle = new UsageStore({ ...fixture.options, databaseFile });
  await oracle.open();
  try {
    oracle.prepareMetadataProjection = () => {};
    oracle.storedMetadata = () => null;
    oracle.homes = structuredClone(store.homes);
    oracle.warnings = [...store.warnings];
    oracle.generatedAt = store.generatedAt;
    oracle.serviceTierEvidence = store.serviceTierEvidence;
    oracle.quotaSourceEvidence = store.quotaSourceEvidence;
    oracle.metadataCache = null;
    oracle.metadataObservationCache = null;
    return oracle.metadata(asOf);
  } finally {
    oracle.close();
  }
}

function writeAuthority(database, segmentId) {
  database
    .prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)")
    .run(AUTHORITY_KEY, JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
}

test("initial build, reopen no-op, one-row appends, cross-home/channel counts, and future asOf", async () => {
  const fixture = await createFixture();
  let store;
  try {
    store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
    await store.sync({ options: fixture.options });
    const initial = store.metadata(AS_OF);
    assert.deepEqual(store.lastMetadataWork, { readEvents: 2, rebuilt: true, reused: false });
    assert.equal(initial.eventCount, 2);
    assert.equal(initial.sessionCount, 2);
    assert.equal(initial.homes.find((home) => home.path === fixture.homeA).sessionCount, 1);
    assert.equal(initial.homes.find((home) => home.path === fixture.homeB).sessionCount, 1);
    assert.deepEqual(initial, await legacyMetadata(store, fixture, AS_OF));

    store.close();
    store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
    await store.open();
    store.prepareMetadataProjection();
    assert.deepEqual(store.lastMetadataWork, { readEvents: 0, rebuilt: false, reused: true });

    await appendUsage(fixture.fileA, {
      model: "gpt-6-sol",
      timestamp: "2026-07-12T03:00:00.000Z",
      total: 250,
    });
    await store.sync({ options: fixture.options });
    const appended = store.metadata(AS_OF);
    assert.deepEqual(store.lastMetadataWork, { readEvents: 1, rebuilt: false, reused: false });
    assert.equal(appended.eventCount, 3);
    assert.deepEqual(appended, await legacyMetadata(store, fixture, AS_OF));

    const templateA = eventTemplate(store.database, fixture.fileA);
    insertEventCopy(store.database, templateA, {
      timestamp_ms: Date.parse("2026-07-12T04:00:00.000Z"),
      channel: "Codex Exec",
      model: "gpt-6-sol",
      session_id: "session-a",
    });
    const crossChannel = store.metadata(AS_OF);
    assert.equal(store.lastMetadataWork.readEvents, 1);
    assert.equal(crossChannel.eventCount, 4);
    assert.equal(crossChannel.sessionCount, 2);
    assert.deepEqual(crossChannel, await legacyMetadata(store, fixture, AS_OF));

    insertEventCopy(store.database, templateA, {
      timestamp_ms: Date.parse("2026-09-15T12:00:00.000Z"),
      channel: "future-channel",
      model: "future-model",
    });
    const beforeFuture = new Date("2026-07-20T00:00:00.000Z");
    const futureExcluded = store.metadata(beforeFuture);
    assert.equal(store.lastMetadataWork.readEvents, 1);
    assert.equal(store.metadataObservationCache.maxTimestampMs, Date.parse("2026-09-15T12:00:00.000Z"));
    assert.equal(Object.hasOwn(futureExcluded.modelLastSeen.Codex, "future-model"), false);
    assert.ok(futureExcluded.harnessModels.Codex.includes("future-model"));
    assert.deepEqual(futureExcluded, await legacyMetadata(store, fixture, beforeFuture));

    const futureVisible = new Date("2026-09-16T00:00:00.000Z");
    const visible = store.metadata(futureVisible);
    assert.equal(visible.modelLastSeen.Codex["future-model"], Date.parse("2026-09-15T12:00:00.000Z"));
    assert.deepEqual(visible.activeHarnessModels.Codex, ["future-model"]);
    assert.deepEqual(visible, await legacyMetadata(store, fixture, futureVisible));

    const expiredAsOf = new Date("2026-10-20T00:00:00.000Z");
    const expired = store.metadata(expiredAsOf);
    assert.deepEqual(expired.activeHarnessModels.Codex, []);
    assert.ok(expired.harnessModels.Codex.includes("future-model"));
    assert.deepEqual(expired, await legacyMetadata(store, fixture, expiredAsOf));
  } finally {
    store?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("old-event update, implicit REPLACE, and delete rebuild the persisted projection", async () => {
  const fixture = await createFixture();
  const store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
  try {
    await store.sync({ options: fixture.options });
    store.metadata(AS_OF);
    const row = eventTemplate(store.database, fixture.fileA);

    store.database
      .prepare("UPDATE events SET channel = 'revised-channel', model = 'revised-model' WHERE id = ?")
      .run(row.id);
    const revised = store.metadata(AS_OF);
    assert.deepEqual(store.lastMetadataWork, { readEvents: 2, rebuilt: true, reused: false });
    assert.deepEqual(revised, await legacyMetadata(store, fixture, AS_OF));
    assert.ok(revised.harnessModels.Codex.includes("revised-model"));

    replaceEventCopy(store.database, row, {
      channel: "Replacement",
      model: "replacement-model",
      session_id: "replacement-session",
    });
    const replaced = store.metadata(AS_OF);
    assert.deepEqual(store.lastMetadataWork, { readEvents: 2, rebuilt: true, reused: false });
    assert.deepEqual(replaced, await legacyMetadata(store, fixture, AS_OF));

    const deleteId = Number(
      store.database.prepare("SELECT id FROM events WHERE source_path = ?").get(fixture.fileB).id,
    );
    store.database.prepare("DELETE FROM events WHERE id = ?").run(deleteId);
    const deleted = store.metadata(AS_OF);
    assert.deepEqual(store.lastMetadataWork, { readEvents: 1, rebuilt: true, reused: false });
    assert.equal(deleted.eventCount, 1);
    assert.deepEqual(deleted, await legacyMetadata(store, fixture, AS_OF));
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source warnings, home shape changes, and removed unique-index guards stay fresh", async () => {
  const fixture = await createFixture();
  const store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
  try {
    await store.sync({ options: fixture.options });
    store.metadata(AS_OF);
    const realUsageFiles = store.usageFiles;
    store.usageFiles = async (homes) => ({
      files: [],
      warnings: ["metadata integration warning"],
      failedHomes: homes.map(({ id, path: homePath }) => ({ id, path: homePath })),
    });
    await store.sync({ options: fixture.options });
    const warned = store.metadata(AS_OF);
    assert.ok(warned.warnings.includes("metadata integration warning"));
    assert.deepEqual(warned, await legacyMetadata(store, fixture, AS_OF));

    store.usageFiles = realUsageFiles;
    const oneHomeOptions = { ...fixture.options, extraHomes: fixture.homeA };
    await store.sync({ options: oneHomeOptions });
    const oneHome = store.metadata(AS_OF);
    assert.equal(oneHome.homeCount, 1);
    assert.equal(oneHome.homes.length, 1);
    assert.deepEqual(oneHome, await legacyMetadata(store, fixture, AS_OF));

    store.database.exec(
      "CREATE UNIQUE INDEX metadata_integration_unique_idx ON events(source_path, session_id, timestamp_ms)",
    );
    assert.equal(store.storedMetadata(AS_OF), null);
    const guarded = store.metadata(AS_OF);
    assert.deepEqual(guarded, await legacyMetadata(store, fixture, AS_OF));

    const template = eventTemplate(store.database, fixture.fileA);
    replaceEventCopyWithNewId(store.database, template, {
      channel: "Unique replacement",
      model: "unique-replacement-model",
    });
    store.database.exec("DROP INDEX metadata_integration_unique_idx");
    assert.equal(
      store.storedMetadata(AS_OF),
      null,
      "the projection built before the guarded REPLACE must not become publishable when the index disappears",
    );
    const afterRemoval = store.metadata(AS_OF);
    assert.equal(store.lastMetadataWork.rebuilt, true);
    assert.equal(afterRemoval.eventCount, guarded.eventCount);
    assert.ok(afterRemoval.harnessModels.Codex.includes("unique-replacement-model"));
    assert.deepEqual(afterRemoval, await legacyMetadata(store, fixture, AS_OF));
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a write transaction never publishes its uncommitted metadata state", async () => {
  const fixture = await createFixture();
  const store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
  try {
    await store.sync({ options: fixture.options });
    store.metadata(AS_OF);
    const before = store.database.prepare("SELECT last_event_id, event_count FROM usage_metadata_state").get();
    const template = eventTemplate(store.database, fixture.fileA);

    store.database.exec("BEGIN IMMEDIATE");
    store.writeTransactionDepth = 1;
    try {
      insertEventCopy(store.database, template, {
        timestamp_ms: Date.parse("2026-07-12T05:00:00.000Z"),
      });
      store.prepareMetadataProjection();
      assert.equal(store.storedMetadata(AS_OF), null);
      assert.deepEqual(
        store.database.prepare("SELECT last_event_id, event_count FROM usage_metadata_state").get(),
        before,
      );
    } finally {
      store.database.exec("ROLLBACK");
      store.writeTransactionDepth = 0;
    }

    store.prepareMetadataProjection();
    assert.deepEqual(store.lastMetadataWork, { readEvents: 0, rebuilt: false, reused: true });
    assert.equal(store.storedMetadata(AS_OF).eventCount, 2);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("metadataHistory keeps its WAL snapshot when another connection commits", async () => {
  const fixture = await createFixture();
  const store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
  try {
    await store.sync({ options: fixture.options });
    store.metadata(AS_OF);
    const template = eventTemplate(store.database, fixture.fileA);
    const externalValue = eventValues(template, {
      timestamp_ms: Date.parse("2026-07-12T06:00:00.000Z"),
    });
    const columns = Object.keys(externalValue);
    const originalMetadata = store.metadata.bind(store);
    let injected = false;
    store.metadataCache = null;
    store.metadataObservationCache = null;
    store.metadata = (asOf) => {
      if (!injected) {
        injected = true;
        const writer = new DatabaseSync(fixture.databaseFile);
        try {
          writer
            .prepare(`INSERT INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
            .run(...columns.map((column) => externalValue[column]));
        } finally {
          writer.close();
        }
      }
      return originalMetadata(asOf);
    };

    const pinned = await store.metadataHistory(AS_OF);
    assert.equal(injected, true);
    assert.equal(pinned.eventCount, 2);
    store.metadata = originalMetadata;

    const live = store.metadata(AS_OF);
    assert.equal(live.eventCount, 3);
    assert.equal(store.lastMetadataWork.readEvents, 1);
    assert.deepEqual(live, await legacyMetadata(store, fixture, AS_OF));
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cold authority falls back to the complete archive carrier", async () => {
  const fixture = await createFixture();
  const oracleFile = path.join(fixture.root, "oracle.sqlite");
  const store = new UsageStore({ ...fixture.options, databaseFile: fixture.databaseFile });
  const oracle = new UsageStore({ ...fixture.options, databaseFile: oracleFile });
  try {
    await store.sync({ options: fixture.options });
    await oracle.sync({ options: fixture.options });
    store.metadata(AS_OF);
    const coldRows = store.database
      .prepare("SELECT * FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    const sourceKinds = new Map(
      store.database
        .prepare("SELECT path, kind FROM source_files")
        .all()
        .map((row) => [String(row.path), String(row.kind)]),
    );
    const metadataCarrier = {
      generatedAt: store.generatedAt,
      homes: structuredClone(store.homes),
      warnings: structuredClone(store.warnings),
    };
    store.historyArchiveEventUnionForRange = async () => ({
      rows: coldRows,
      sourceKinds,
      metadataCarrier,
    });
    const segmentId = "1".repeat(64);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare(
          `INSERT INTO archive_segments
           (segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(segmentId, path.join(fixture.root, "cold.sqlite"), segmentId, 0, 1, coldRows.length, Date.now());
      writeAuthority(store.database, segmentId);
      store.database.exec("DELETE FROM events");
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const actual = await store.metadataHistory(AS_OF);
    const expected = await legacyMetadata(oracle, fixture, AS_OF, oracleFile);
    assert.deepEqual({ ...actual, generatedAt: "" }, { ...expected, generatedAt: "" });
    assert.equal(actual.eventCount, 2);
    assert.equal(actual.sessionCount, 2);
  } finally {
    oracle.close();
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
