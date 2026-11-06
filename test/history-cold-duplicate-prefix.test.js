import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const SESSION_ID = "cold-duplicate-prefix-session";
const OLD_MS = Date.parse("2026-07-12T02:00:00.000Z");
const NEW_MS = Date.parse("2026-07-12T02:01:00.000Z");
const COLD_START_MS = OLD_MS - 1;
const COLD_END_MS = OLD_MS + 1;
const ROLLUP_TABLES = [
  ["usage_rollup_daily", "calendar_zone, day_key, home_id"],
  ["usage_rollup_models", "calendar_zone, day_key, home_id, model"],
  ["usage_rollup_sessions", "calendar_zone, day_key, home_id, session_id"],
];

function sessionHeader(projectPath) {
  return {
    type: "session",
    version: 4,
    id: SESSION_ID,
    createdAt: OLD_MS - 5_000,
    cwd: projectPath,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
}

function requestHeader() {
  return {
    type: "request/header",
    seq: 2,
    time: OLD_MS - 1_000,
    data: {
      header: {
        config: {
          provider: "deepseek-account",
          model: "deepseek-flash",
          reasoningEffort: "max",
          maxTokens: 256000,
        },
      },
      reason: "turn-start",
    },
  };
}

function assistantMessage({
  seq,
  time,
  step,
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  outputTokens,
  totalTokens,
}) {
  return {
    type: "assistant/message",
    seq,
    time,
    surfaceOp: "append",
    data: {
      turn: 1,
      step,
      message: { content: [{ text: `assistant-step-${step}` }] },
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens },
      stream: [{ type: "delta", time, chunk: { text: `stream-step-${step}` } }],
    },
  };
}

function dshFrame(rows) {
  return zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8"));
}

function coldMessages(changed = false) {
  return [
    assistantMessage({
      seq: 3,
      time: OLD_MS,
      step: 1,
      inputTokens: changed ? 41 : 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      outputTokens: 5,
      totalTokens: changed ? 61 : 60,
    }),
    assistantMessage({
      seq: 4,
      time: OLD_MS,
      step: 2,
      inputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 10,
      totalTokens: 35,
    }),
  ];
}

function hotMessage() {
  return assistantMessage({
    seq: 5,
    time: NEW_MS,
    step: 3,
    inputTokens: 100,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 20,
    totalTokens: 160,
  });
}

function writeDshFixture(filePath, projectPath, { changedCold = false, includeHot = false } = {}) {
  const frames = [dshFrame([sessionHeader(projectPath)]), dshFrame([requestHeader(), ...coldMessages(changedCold)])];
  if (includeHot) frames.push(dshFrame([hotMessage()]));
  writeFileSync(filePath, Buffer.concat(frames));
}

function appendHotMessage(filePath) {
  appendFileSync(filePath, dshFrame([hotMessage()]));
}

function invalidateSource(store, sourcePath) {
  store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(sourcePath);
}

function fileDigest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sourceFingerprint(store, sourcePath) {
  return { ...store.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(sourcePath) };
}

function eventPayload(row) {
  return Object.fromEntries(
    Object.keys(row)
      .filter((key) => key !== "id")
      .sort()
      .map((key) => [key, row[key]]),
  );
}

function tableRows(database, table, orderBy) {
  return database
    .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

function normalizedSummary(summary) {
  const normalized = structuredClone(summary);
  normalized.generatedAt = "";
  return normalized;
}

function canonicalEvents(events) {
  return [...events].sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

async function rollbackEvidence(store, sourcePath, candidateFile, segmentId) {
  const summaryOptions = {
    preset: "all",
    now: "2026-07-15T12:00:00.000Z",
    calendarZone: "utc",
  };
  return {
    candidateDigest: fileDigest(candidateFile),
    archivedEvents: (await store.readHistoryArchiveEvents(segmentId)).map(eventPayload),
    hotEvents: tableRows(store.database, "events", "id"),
    archiveSegments: tableRows(store.database, "archive_segments", "segment_id"),
    revisionMeta: store.readMetaRaw("history_archive_event_revisions"),
    replacedFacts: store.database
      .prepare("SELECT * FROM history_replaced_facts WHERE source_path = ? ORDER BY rowid")
      .all(sourcePath)
      .map((row) => ({ ...row })),
    rollups: Object.fromEntries(
      ROLLUP_TABLES.map(([table, orderBy]) => [table, tableRows(store.database, table, orderBy)]),
    ),
    dirtyDays: store.database
      .prepare("SELECT day_key FROM usage_rollup_dirty_days ORDER BY day_key")
      .all()
      .map((row) => String(row.day_key)),
    publishedEvents: await store.publishedHistoryUsageEvents(),
    summary: normalizedSummary(await store.summarizeHistory(summaryOptions)),
  };
}

async function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-duplicate-prefix-"));
  const dshHome = path.join(root, ".dsh");
  const projectPath = path.join(root, "project");
  const sourcePath = path.join(dshHome, "sessions", "--project--", SESSION_ID, "session.v4.jsonl.zstd");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const databaseFile = path.join(root, "archived.sqlite");
  const options = { homeDir: root, env: {}, importDirs: [] };
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeDshFixture(sourcePath, projectPath);

  const archived = new UsageStore({ ...options, databaseFile });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    await archived.sync({ options });
    assert.deepEqual(
      archived.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { timestamp_ms: OLD_MS, session_id: SESSION_ID, total: 60 },
        { timestamp_ms: OLD_MS, session_id: SESSION_ID, total: 35 },
      ],
    );

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: COLD_START_MS,
      endMs: COLD_END_MS,
    });
    const committed = await archived.commitHistoryArchiveEvents(
      await prepareHistoryArchiveCommit(archived.database, candidateFile),
    );
    assert.equal(committed.inserted, true);
    assert.equal(committed.replay, false);
    assert.equal(committed.eventCount, 2);
    assert.equal(archived.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);

    const coldRows = await archived.readHistoryArchiveEvents(committed.segmentId);
    assert.equal(coldRows.length, 2);
    assert.equal(coldRows[0].timestamp_ms, coldRows[1].timestamp_ms);
    assert.equal(coldRows[0].session_id, coldRows[1].session_id);
    assert.notDeepEqual(eventPayload(coldRows[0]), eventPayload(coldRows[1]));

    return {
      root,
      sourcePath,
      candidateFile,
      databaseFile,
      options,
      archived,
      oracle,
      segmentId: committed.segmentId,
      coldRows: coldRows.map(eventPayload),
      candidateDigest: fileDigest(candidateFile),
    };
  } catch (error) {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

function closeFixture(fixture, reopened = null) {
  reopened?.close();
  fixture.archived?.close();
  fixture.oracle.close();
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

test("unchanged duplicate cold identities preserve the prefix and publish one hot tail event", async () => {
  const fixture = await createFixture();
  let reopened;
  try {
    appendHotMessage(fixture.sourcePath);
    invalidateSource(fixture.archived, fixture.sourcePath);
    const synced = await fixture.archived.sync({ options: fixture.options });
    assert.equal(synced.updatedFileCount, 1, fixture.archived.warnings.join("\n"));
    await fixture.oracle.sync({ options: fixture.options });

    assert.deepEqual(
      (await fixture.archived.readHistoryArchiveEvents(fixture.segmentId)).map(eventPayload),
      fixture.coldRows,
    );
    assert.equal(fileDigest(fixture.candidateFile), fixture.candidateDigest);

    const hotRows = fixture.archived.database
      .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(hotRows, [{ timestamp_ms: NEW_MS, session_id: SESSION_ID, total: 160 }]);

    const actualEvents = await fixture.archived.publishedHistoryUsageEvents();
    const oracleEvents = fixture.oracle.publishedUsageEvents();
    assert.deepEqual(canonicalEvents(actualEvents), canonicalEvents(oracleEvents));
    assert.deepEqual(
      actualEvents.map((event) => event.total.total).sort((left, right) => left - right),
      [35, 60, 160],
    );
    assert.equal(
      actualEvents.reduce((sum, event) => sum + event.total.total, 0),
      255,
    );

    const summaryOptions = {
      preset: "all",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    const summary = await fixture.archived.summarizeHistory(summaryOptions);
    const oracleSummary = fixture.oracle.summarize(summaryOptions);
    assert.equal(summary.totals.total, 255);
    assert.deepEqual(normalizedSummary(summary), normalizedSummary(oracleSummary));

    fixture.archived.close();
    fixture.archived = null;
    reopened = new UsageStore({
      ...fixture.options,
      databaseFile: fixture.databaseFile,
    });
    const reopenedSync = await reopened.sync({ options: fixture.options });
    assert.equal(reopenedSync.updatedFileCount, 0);
    assert.equal(
      reopened.database.prepare("SELECT COUNT(*) AS count FROM events").get().count,
      1,
      "reopening must not replay the already-published hot event",
    );
    assert.equal(
      reopened.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count,
      1,
      "reopening must not register the cold segment again",
    );
    assert.deepEqual(canonicalEvents(await reopened.publishedHistoryUsageEvents()), canonicalEvents(oracleEvents));
    assert.deepEqual(
      normalizedSummary(await reopened.summarizeHistory(summaryOptions)),
      normalizedSummary(oracleSummary),
    );
  } finally {
    closeFixture(fixture, reopened);
  }
});

test("changing one value under a duplicated cold identity rejects and rolls back every derived fact", async () => {
  const fixture = await createFixture();
  try {
    appendHotMessage(fixture.sourcePath);
    invalidateSource(fixture.archived, fixture.sourcePath);
    await fixture.archived.sync({ options: fixture.options });
    const baseline = await rollbackEvidence(
      fixture.archived,
      fixture.sourcePath,
      fixture.candidateFile,
      fixture.segmentId,
    );

    writeDshFixture(fixture.sourcePath, path.join(fixture.root, "project"), {
      changedCold: true,
      includeHot: true,
    });
    invalidateSource(fixture.archived, fixture.sourcePath);
    const invalidatedFingerprint = sourceFingerprint(fixture.archived, fixture.sourcePath);

    let syncFailure;
    try {
      await fixture.archived.sync({ options: fixture.options });
    } catch (error) {
      syncFailure = error;
    }
    const failureMessages = [syncFailure?.message, ...fixture.archived.warnings].filter((message) =>
      message?.includes("requires one row per timestamp/session for a cold value revision"),
    );
    assert.equal(failureMessages.length, 1, "the ambiguous cold revision must fail exactly once");
    if (syncFailure) {
      assert.equal(syncFailure.code, "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED");
    }

    assert.deepEqual(
      await rollbackEvidence(fixture.archived, fixture.sourcePath, fixture.candidateFile, fixture.segmentId),
      baseline,
    );
    assert.deepEqual(sourceFingerprint(fixture.archived, fixture.sourcePath), invalidatedFingerprint);
    assert.equal(fileDigest(fixture.candidateFile), fixture.candidateDigest);
    assert.equal(fixture.archived.readMetaRaw("history_archive_event_revisions"), undefined);
  } finally {
    closeFixture(fixture);
  }
});
