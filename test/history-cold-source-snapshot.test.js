import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const DAY_MS = 86_400_000;
const START_MS = Date.parse("2026-07-12T00:00:00.000Z");
const DUPLICATE_MS = START_MS + 2 * 60 * 60 * 1000;
const UNRELATED_EARLY_MS = START_MS + 3 * 60 * 60 * 1000;
const OTHER_MS = START_MS + DAY_MS + 2 * 60 * 60 * 1000;
const HOT_MS = START_MS + 2 * DAY_MS + 2 * 60 * 60 * 1000;
const REVISION_META = "history_archive_event_revisions";
const UNBOUNDED_EVENT_SCAN = /^\s*SELECT\s+\*\s+FROM\s+events\s+ORDER\s+BY\s+id\s*;?\s*$/i;

function codexTokenLine(timestamp, cumulativeTotal, lastTotal) {
  return JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: cumulativeTotal,
          input_tokens: cumulativeTotal - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
        last_token_usage: {
          total_tokens: lastTotal,
          input_tokens: lastTotal - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
}

function codexRows(sessionId, cwd, model, rows) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, source: "cli", cwd },
    }),
    JSON.stringify({ type: "turn_context", payload: { model } }),
    ...rows,
  ].join("\n");
}

function sourceIdentity(store, sourcePath) {
  return {
    ...store.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
      .get(sourcePath),
  };
}

function sourceFor(identity) {
  return {
    id: identity.home_id,
    label: identity.home_label,
    path: identity.home_path,
    kind: identity.kind,
  };
}

function writeRevisionMeta(store, revision) {
  store.database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(REVISION_META, JSON.stringify({ formatVersion: 1, revisions: [revision] }));
}

function eventPayload(row) {
  const { id: _id, ...payload } = row;
  return Object.fromEntries(
    Object.entries(payload).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const leftKey = JSON.stringify(eventPayload(left));
    const rightKey = JSON.stringify(eventPayload(right));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

async function withScopedScanGuard(action) {
  const prototype = DatabaseSync.prototype;
  const originalPrepare = prototype.prepare;
  let active = true;
  let blocked = 0;
  prototype.prepare = function guardedPrepare(sql, ...args) {
    if (active && UNBOUNDED_EVENT_SCAN.test(String(sql))) {
      blocked += 1;
      throw Object.assign(new Error("unscoped archive event scan was attempted"), {
        code: "UNSCOPED_ARCHIVE_EVENT_SCAN",
      });
    }
    return originalPrepare.call(this, sql, ...args);
  };
  try {
    const value = await action();
    return { value, blocked };
  } finally {
    active = false;
    prototype.prepare = originalPrepare;
  }
}

async function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-source-snapshot-"));
  const codexHome = path.join(root, "codex-home");
  const targetPath = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-target.jsonl");
  const unrelatedPath = path.join(codexHome, "sessions", "2026", "07", "13", "rollout-unrelated.jsonl");
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    mkdirSync(path.dirname(unrelatedPath), { recursive: true });
    writeFileSync(
      targetPath,
      `${codexRows("duplicate-session", root, "gpt-6-sol", [
        codexTokenLine(DUPLICATE_MS, 40, 40),
        codexTokenLine(DUPLICATE_MS, 82, 42),
      ])}\n`,
    );
    writeFileSync(
      unrelatedPath,
      `${codexRows("unrelated-session", root, "replacement-\uFFFD", [codexTokenLine(UNRELATED_EARLY_MS, 25, 25), codexTokenLine(OTHER_MS, 50, 25)])}\n`,
    );
    await store.sync({ options });
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 4);

    const candidateFiles = [path.join(root, "archive-first.sqlite"), path.join(root, "archive-second.sqlite")];
    await createHistoryArchiveCandidate(store.database, candidateFiles[0], {
      startMs: START_MS,
      endMs: START_MS + DAY_MS,
    });
    await createHistoryArchiveCandidate(store.database, candidateFiles[1], {
      startMs: START_MS + DAY_MS,
      endMs: START_MS + 2 * DAY_MS,
    });
    for (const candidateFile of candidateFiles) {
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidateFile));
    }

    const archives = store.database
      .prepare("SELECT * FROM archive_segments ORDER BY start_ms, segment_id")
      .all()
      .map((row) => ({ ...row }));
    assert.equal(archives.length, 2);
    const targetArchive = archives.find((record) => record.start_ms <= DUPLICATE_MS && DUPLICATE_MS < record.end_ms);
    assert.ok(targetArchive);

    return {
      root,
      options,
      store,
      targetPath,
      unrelatedPath,
      archives,
      targetArchive,
      close() {
        store.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("source-scoped snapshots keep every target row and revision without materializing unrelated packages", async () => {
  const fixture = await createFixture();
  const { store, targetArchive, targetPath } = fixture;
  try {
    const targetRows = await store.readHistoryArchiveEvents(targetArchive.segment_id);
    const duplicateRows = targetRows.filter((row) => Number(row.timestamp_ms) === DUPLICATE_MS);
    assert.equal(duplicateRows.length, 2);
    const removed = eventPayload(duplicateRows[0]);
    const added = {
      ...removed,
      total: Number(removed.total) + 19,
      output: Number(removed.output) + 19,
    };
    const identity = sourceIdentity(store, targetPath);
    const revision = {
      segmentId: targetArchive.segment_id,
      databaseSha256: targetArchive.database_sha256,
      sourceIdentity: identity,
      removed: [{ payload: removed, count: 1 }],
      added: [{ payload: added, count: 1 }],
    };
    writeRevisionMeta(store, revision);

    const fullSnapshot = await store.readHistoryArchiveSnapshot(targetArchive);
    const scoped = await withScopedScanGuard(() =>
      store.readHistoryArchiveSnapshot(targetArchive, null, {
        path: targetPath,
        revisions: [revision],
      }),
    );
    assert.equal(scoped.blocked, 0);
    assert.deepEqual(
      scoped.value.rows,
      fullSnapshot.rows.filter((row) => row.source_path === targetPath),
    );
    assert.deepEqual(scoped.value.sourceIdentities, fullSnapshot.sourceIdentities);

    const fullEffectiveRows = await store.mergeHistoryArchiveEventsForRange({
      startMs: targetArchive.start_ms,
      endMs: targetArchive.end_ms,
    });
    const reparsed = await withScopedScanGuard(() =>
      store.historyArchiveReparsePrefixes(targetPath, sourceFor(identity)),
    );
    assert.equal(reparsed.blocked, 0);
    assert.equal(reparsed.value.prefixes.length, 1);
    assert.deepEqual(reparsed.value.prefixes[0].originalRows, scoped.value.rows);
    assert.deepEqual(
      sortRows(reparsed.value.prefixes[0].effectiveRows),
      sortRows(fullEffectiveRows.filter((row) => row.source_path === targetPath)),
    );
  } finally {
    fixture.close();
  }
});

test("unchanged duplicate cold rows survive a newer hot append through the scoped reader", async () => {
  const fixture = await createFixture();
  const { store, options, targetArchive, targetPath } = fixture;
  try {
    const before = await store.readHistoryArchiveEvents(targetArchive.segment_id);
    const beforeBytes = readFileSync(targetArchive.database_path);
    appendFileSync(targetPath, `${codexTokenLine(HOT_MS, 132, 50)}\n`);
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(targetPath);

    const originalReparse = store.historyArchiveReparsePrefixes;
    let blocked = 0;
    store.historyArchiveReparsePrefixes = async function guardedReparse(filePath, source) {
      const guarded = await withScopedScanGuard(() => originalReparse.call(this, filePath, source));
      blocked += guarded.blocked;
      return guarded.value;
    };
    let synced;
    try {
      synced = await store.sync({ options });
    } finally {
      store.historyArchiveReparsePrefixes = originalReparse;
    }
    assert.equal(blocked, 0);
    assert.equal(synced.updatedFileCount, 1);
    assert.deepEqual(store.warnings, []);
    assert.deepEqual(await store.readHistoryArchiveEvents(targetArchive.segment_id), before);
    assert.equal(readFileSync(targetArchive.database_path).equals(beforeBytes), true);

    const hotRows = store.database.prepare("SELECT timestamp_ms, session_id, total FROM events").all();
    assert.deepEqual(
      hotRows.map((row) => ({ ...row })),
      [{ timestamp_ms: HOT_MS, session_id: "duplicate-session", total: 50 }],
    );
    assert.deepEqual(
      (await store.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [40, 42, 25, 25, 50],
    );
  } finally {
    fixture.close();
  }
});

test("unrelated revisions still fail exact removal, surrogate equality, and source binding checks", async () => {
  const fixture = await createFixture();
  const { store, targetArchive, targetPath, unrelatedPath } = fixture;
  try {
    const unrelatedArchive = fixture.archives.find((record) => record.segment_id !== targetArchive.segment_id);
    assert.ok(unrelatedArchive);
    const unrelatedRows = await store.readHistoryArchiveEvents(unrelatedArchive.segment_id);
    const unrelatedRow = unrelatedRows.find((row) => row.source_path === unrelatedPath);
    assert.ok(unrelatedRow);
    assert.equal(unrelatedRow.model, "replacement-\uFFFD");
    const removed = eventPayload(unrelatedRow);
    const unrelatedIdentity = sourceIdentity(store, unrelatedPath);
    const targetSource = sourceFor(sourceIdentity(store, targetPath));

    writeRevisionMeta(store, {
      segmentId: unrelatedArchive.segment_id,
      databaseSha256: unrelatedArchive.database_sha256,
      sourceIdentity: unrelatedIdentity,
      removed: [{ payload: removed, count: 2 }],
      added: [],
    });
    await assert.rejects(
      store.historyArchiveReparsePrefixes(targetPath, targetSource),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID" && /removes more payloads/.test(error.message),
    );

    writeRevisionMeta(store, {
      segmentId: unrelatedArchive.segment_id,
      databaseSha256: unrelatedArchive.database_sha256,
      sourceIdentity: unrelatedIdentity,
      removed: [{ payload: { ...removed, model: "replacement-\uD800" }, count: 1 }],
      added: [],
    });
    await assert.rejects(
      store.historyArchiveReparsePrefixes(targetPath, targetSource),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID" && /removes more payloads/.test(error.message),
    );

    writeRevisionMeta(store, {
      segmentId: unrelatedArchive.segment_id,
      databaseSha256: unrelatedArchive.database_sha256,
      sourceIdentity: { ...unrelatedIdentity, home_path: `${unrelatedIdentity.home_path}-wrong` },
      removed: [{ payload: removed, count: 1 }],
      added: [],
    });
    await assert.rejects(
      store.historyArchiveReparsePrefixes(targetPath, targetSource),
      (error) =>
        error.code === "HISTORY_ARCHIVE_REVISION_INVALID" &&
        /source binding does not match segment/.test(error.message),
    );
  } finally {
    fixture.close();
  }
});
