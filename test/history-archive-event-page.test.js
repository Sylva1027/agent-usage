import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const START_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const END_MS = START_MS + 60_000;
const EVENT_MS = START_MS + 100;

function insertEvent(database, sourcePath, { id, timestampMs = EVENT_MS, sessionId, total }) {
  database
    .prepare(
      `INSERT INTO events (
        id, source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sourcePath,
      timestampMs,
      sessionId,
      "home",
      "Home",
      "main",
      "project",
      "gpt-test",
      "hour",
      "day",
      "week",
      "month",
      total,
      total - 1,
      0,
      1,
      0,
    );
}

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-event-page-"));
  const store = new UsageStore({
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    importDirs: [],
  });
  const sourcePath = path.join(root, "source.jsonl");
  const candidateFile = path.join(root, "candidate.sqlite");
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:04:05.000Z");
    for (const [id, total] of [
      [11, 10],
      [12, 20],
      [13, 30],
    ]) {
      insertEvent(store.database, sourcePath, { id, sessionId: `sealed-${id}`, total });
    }
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: START_MS, endMs: END_MS });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    return { root, store, sourcePath, candidateFile, registered };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

async function cleanup({ root, store }) {
  store.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function eventPayload(row) {
  const payload = { ...row };
  delete payload.id;
  return payload;
}

test("keyset pages preserve sealed rows across equal timestamps and ignore hot or overlay changes", async () => {
  const data = await fixture();
  try {
    const { store, sourcePath, registered } = data;
    const first = await store.readHistoryArchiveEventPage(registered.segmentId, {
      startMs: START_MS,
      endMs: END_MS,
      limit: 2,
    });
    assert.deepEqual(
      first.events.map((row) => Number(row.id)),
      [11, 12],
    );
    assert.equal(first.nextAfterId, 12);
    assert.equal(first.view, "sealed");
    assert.deepEqual(first.range, { startMs: START_MS, endMs: END_MS });

    const second = await store.readHistoryArchiveEventPage(registered.segmentId, {
      startMs: START_MS,
      endMs: END_MS,
      afterId: first.nextAfterId,
      limit: 2,
    });
    assert.deepEqual(
      second.events.map((row) => Number(row.id)),
      [13],
    );
    assert.equal(second.nextAfterId, null);

    const sourceIdentity = {
      ...store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(sourcePath),
    };
    const sealedRow = await store.readHistoryArchiveEventPage(registered.segmentId, {
      startMs: START_MS,
      endMs: END_MS,
      afterId: 11,
      limit: 1,
    });
    const coldPayload = eventPayload(sealedRow.events[0]);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      const writeMeta = store.database.prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      writeMeta.run(
        "history_archive_event_authority",
        JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
      );
      writeMeta.run(
        "history_archive_event_revisions",
        JSON.stringify({
          formatVersion: 1,
          revisions: [
            {
              segmentId: registered.segmentId,
              databaseSha256: registered.databaseSha256,
              sourceIdentity,
              removed: [{ payload: coldPayload, count: 1 }],
              added: [{ payload: { ...coldPayload, total: 999 }, count: 1 }],
            },
          ],
        }),
      );
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(sourcePath);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    insertEvent(store.database, sourcePath, {
      id: 14,
      timestampMs: END_MS + 1,
      sessionId: "hot-only",
      total: 40,
    });

    assert.deepEqual(
      (await store.publishedHistoryUsageEvents()).map((event) => [event.sessionId, event.total.total]),
      [
        ["sealed-12", 999],
        ["sealed-13", 30],
        ["sealed-11", 10],
        ["hot-only", 40],
      ],
    );

    const sealed = await store.readHistoryArchiveEventPage(registered.segmentId, {
      startMs: START_MS,
      endMs: END_MS,
      limit: 10,
    });
    assert.deepEqual(
      sealed.events.map((row) => [Number(row.id), Number(row.total)]),
      [
        [11, 10],
        [12, 20],
        [13, 30],
      ],
    );
    assert.equal(
      sealed.events.some((row) => row.session_id === "hot-only"),
      false,
    );
  } finally {
    await cleanup(data);
  }
});

test("event page rejects unsafe ranges, cursors, and limits", async () => {
  const data = await fixture();
  try {
    const { store, registered } = data;
    const invalid = [
      {},
      { startMs: START_MS, endMs: START_MS },
      { startMs: END_MS, endMs: START_MS },
      { startMs: START_MS + 0.5, endMs: END_MS },
      { startMs: START_MS, endMs: END_MS, afterId: -1 },
      { startMs: START_MS, endMs: END_MS, afterId: 0.5 },
      { startMs: START_MS, endMs: END_MS, limit: 0 },
      { startMs: START_MS, endMs: END_MS, limit: 501 },
      { startMs: START_MS, endMs: END_MS, limit: 1.5 },
    ];
    for (const request of invalid) {
      await assert.rejects(
        store.readHistoryArchiveEventPage(registered.segmentId, request),
        (error) => error.code === "HISTORY_ARCHIVE_EVENT_PAGE_INVALID",
      );
    }
  } finally {
    await cleanup(data);
  }
});

test("event page fails on a missing segment and recovers after restoring it", async () => {
  const data = await fixture();
  const backupFile = `${data.candidateFile}.backup`;
  try {
    const { store, candidateFile, registered } = data;
    copyFileSync(candidateFile, backupFile);
    rmSync(candidateFile);
    await assert.rejects(
      store.readHistoryArchiveEventPage(registered.segmentId, {
        startMs: START_MS,
        endMs: END_MS,
      }),
      (error) => error.code === "ENOENT",
    );

    copyFileSync(backupFile, candidateFile);
    const recovered = await store.readHistoryArchiveEventPage(registered.segmentId, {
      startMs: START_MS,
      endMs: END_MS,
    });
    assert.deepEqual(
      recovered.events.map((row) => Number(row.id)),
      [11, 12, 13],
    );
  } finally {
    await cleanup(data);
  }
});
