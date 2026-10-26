import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";
const ARCHIVE_REVISIONS_META = "history_archive_event_revisions";

function codexTokenLine(timestamp, total, lastTotal) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 20,
          cached_input_tokens: 0,
          output_tokens: 20,
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

function codexCumulativePrefix(codexHome, timestamp, total) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cold-revision-overlay-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
    codexTokenLine(timestamp, total, total),
  ].join("\n");
}

function eventPayload(row) {
  return Object.fromEntries(
    Object.keys(row)
      .filter((key) => key !== "id")
      .sort()
      .map((key) => [key, row[key]]),
  );
}

function fileDigest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeRevisionOverlay(store, revision) {
  store.database.exec("BEGIN IMMEDIATE");
  try {
    store.database
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(ARCHIVE_REVISIONS_META, JSON.stringify({ formatVersion: 1, revisions: [revision] }));
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
}

async function createColdHotFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-revision-overlay-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-revision-overlay.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = codexCumulativePrefix(codexHome, firstTimestamp, 100);
    writeFileSync(usageFile, `${prefix}\n`);
    await store.sync({ options });
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp),
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const coldDigest = fileDigest(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(usageFile, `${prefix}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`);
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await store.sync({ options });
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );

    const coldRows = await store.readHistoryArchiveEvents(registered.segmentId);
    const [coldRow] = coldRows;
    const sourceIdentity = {
      ...store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(usageFile),
    };
    return {
      root,
      store,
      candidateFile,
      coldDigest,
      registered,
      sourceIdentity,
      firstTimestamp,
      secondTimestamp,
      coldPayload: eventPayload(coldRow),
    };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

function revisionFor(fixture, addedPayload = fixture.coldPayload) {
  return {
    segmentId: fixture.registered.segmentId,
    databaseSha256: fixture.registered.databaseSha256,
    sourceIdentity: fixture.sourceIdentity,
    removed: [{ payload: fixture.coldPayload, count: 1 }],
    added: [{ payload: addedPayload, count: 1 }],
  };
}

test("authorized revision overlay rewrites the cold prefix without touching hot facts", async () => {
  const fixture = await createColdHotFixture();
  const { store, candidateFile, coldDigest, firstTimestamp, secondTimestamp, coldPayload } = fixture;
  try {
    const revisedPayload = { ...coldPayload, input: 70, total: 90 };
    writeRevisionOverlay(store, revisionFor(fixture, revisedPayload));

    const full = await store.publishedHistoryUsageEvents();
    const range = await store.mergeHistoryArchiveEventsForRange({
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp) + 1,
    });
    assert.deepEqual(
      full.map((event) => event.total.total),
      [90, 30],
    );
    assert.deepEqual(
      range.map((row) => Number(row.total)),
      [90, 30],
    );
    assert.equal(
      full.reduce((sum, event) => sum + event.total.total, 0),
      120,
    );
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );
    assert.equal(fileDigest(candidateFile), coldDigest);
  } finally {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("authorized revision overlay rejects impossible removals and mismatched source bindings", async () => {
  const fixture = await createColdHotFixture();
  const { store, coldPayload } = fixture;
  try {
    writeRevisionOverlay(store, {
      ...revisionFor(fixture, { ...coldPayload, input: 70, total: 90 }),
      removed: [{ payload: coldPayload, count: 2 }],
    });
    await assert.rejects(
      store.publishedHistoryUsageEvents(),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
    );

    writeRevisionOverlay(store, {
      ...revisionFor(fixture, { ...coldPayload, input: 70, total: 90 }),
      sourceIdentity: { ...fixture.sourceIdentity, home_label: "Wrong Home" },
    });
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({
        startMs: Date.parse(fixture.firstTimestamp),
        endMs: Date.parse(fixture.secondTimestamp) + 1,
      }),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
    );
  } finally {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("authorized revision overlay validates added payloads and compares source identities by field", async () => {
  const fixture = await createColdHotFixture();
  const { store, coldPayload } = fixture;
  try {
    writeRevisionOverlay(store, revisionFor(fixture, { ...coldPayload, input: 70, total: null }));
    await assert.rejects(
      store.publishedHistoryUsageEvents(),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
    );

    writeRevisionOverlay(store, revisionFor(fixture, { ...coldPayload, input: 70, total: 90, home_id: "other-home" }));
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({
        startMs: Date.parse(fixture.firstTimestamp),
        endMs: Date.parse(fixture.secondTimestamp) + 1,
      }),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
    );

    const reorderedRevision = revisionFor(fixture, { ...coldPayload, input: 70, total: 90 });
    reorderedRevision.sourceIdentity = {
      home_path: fixture.sourceIdentity.home_path,
      home_label: fixture.sourceIdentity.home_label,
      kind: fixture.sourceIdentity.kind,
      path: fixture.sourceIdentity.path,
      home_id: fixture.sourceIdentity.home_id,
    };
    writeRevisionOverlay(store, reorderedRevision);
    assert.deepEqual(
      (await store.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [90, 30],
    );
  } finally {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
