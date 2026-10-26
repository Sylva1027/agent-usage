import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryBackup,
  loadHistoryBackupContext,
  restoreHistoryBackup,
  verifyHistoryBackup,
} from "../src/history-backup.js";
import {
  assertHistoryArchiveSourceMatches,
  createHistoryArchiveCandidate,
  inventoryHistoryArchiveSegments,
  loadHistoryArchiveImport,
  materializePublishedHistoryArchiveRuntime,
  planHistoryArchive,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  stageHistoryArchiveBundle,
  stageHistoryArchiveSegments,
  stagePublishedHistoryArchiveBundle,
  verifyHistoryArchiveBundle,
  verifyHistoryArchiveCandidate,
  verifyPublishedHistoryArchiveBundle,
} from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { UsageStore } from "../src/usage-store.js";

function archiveDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE events (timestamp_ms INTEGER NOT NULL)");
  return database;
}

async function createPublishedBundle(root, { authority = false, beforePublish = null } = {}) {
  const databaseFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "candidate", "candidate.sqlite");
  const directory = path.join(root, "published");
  const startMs = new Date("2026-02-02T03:04:05.000Z").getTime();
  const endMs = startMs + 60_000;
  const threadId = "portable-bundle-thread";
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  let registered;
  try {
    await store.open();
    const sourcePath = path.join(root, "source.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-02-02T03:05:00.000Z");
    store.database
      .prepare(
        `INSERT INTO events (
          source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
          hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourcePath,
        startMs,
        threadId,
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-sol",
        "hour",
        "day",
        "week",
        "month",
        20,
        18,
        0,
        2,
        0,
      );
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
    registered = await store.registerHistoryArchiveCandidate(candidateFile);
    if (authority) {
      store.database
        .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        .run(
          "history_archive_event_authority",
          JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
        );
    }
    beforePublish?.(store.database, registered);
    await publishHistoryArchiveBundle(store.database, directory, {
      serviceTierEvidence: serviceTierEvidenceFromSnapshot({
        formatVersion: 1,
        threads: [{ threadId, turns: [{ time: startMs, tier: "priority" }] }],
      }),
    });
  } finally {
    store.close();
  }
  return {
    directory,
    verified: await verifyPublishedHistoryArchiveBundle(directory),
    registered,
    startMs,
    threadId,
  };
}

function publishedBundleBytes(verified) {
  const files = [
    verified.manifestFile,
    verified.markerFile,
    path.join(verified.directory, verified.manifest.main.databaseFile),
    path.join(verified.directory, verified.manifest.main.manifestFile),
    ...verified.manifest.segments.flatMap((segment) => [
      path.join(verified.directory, segment.databaseFile),
      path.join(verified.directory, segment.manifestFile),
    ]),
  ];
  return files.map((file) => [file, readFileSync(file)]);
}

test("dry-run requires the event threshold and at least one complete cold day", () => {
  const database = archiveDatabase();
  try {
    const asOf = new Date(2026, 9, 22, 12, 0, 0, 0).getTime();
    const cutoffMs = new Date(2026, 3, 25, 0, 0, 0, 0).getTime();
    database
      .prepare(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO events SELECT ? FROM n",
      )
      .run(399_999, cutoffMs);
    database
      .prepare("UPDATE events SET timestamp_ms = ? WHERE rowid = (SELECT MIN(rowid) FROM events)")
      .run(cutoffMs - 1);

    assert.deepEqual(planHistoryArchive(database, { asOf }), {
      eligible: false,
      reason: "below-event-threshold",
      eventCount: 399_999,
      coldEventCount: 1,
      cutoffMs,
    });

    database.prepare("INSERT INTO events VALUES (?)").run(cutoffMs);
    assert.deepEqual(planHistoryArchive(database, { asOf }), {
      eligible: true,
      reason: "eligible",
      eventCount: 400_000,
      coldEventCount: 1,
      cutoffMs,
    });

    database.prepare("UPDATE events SET timestamp_ms = ? WHERE rowid = (SELECT MIN(rowid) FROM events)").run(cutoffMs);
    assert.deepEqual(planHistoryArchive(database, { asOf }), {
      eligible: false,
      reason: "no-complete-cold-day",
      eventCount: 400_000,
      coldEventCount: 0,
      cutoffMs,
    });
  } finally {
    database.close();
  }
});

test("dry-run rejects a missing or invalid asOf without writing", () => {
  const database = archiveDatabase();
  try {
    assert.throws(() => planHistoryArchive(database, {}), /asOf must be a valid epoch millisecond timestamp/);
    assert.throws(
      () => planHistoryArchive(database, { asOf: Number.NaN }),
      /asOf must be a valid epoch millisecond timestamp/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
  } finally {
    database.close();
  }
});

test("candidate keeps only the event range and preserves source context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-candidate-"));
  const databaseFile = path.join(root, "source.sqlite");
  const candidateDirectory = path.join(root, "candidate-package");
  const destination = path.join(candidateDirectory, "archive-candidate.sqlite");
  const candidateManifest = path.join(candidateDirectory, "archive-candidate.manifest.json");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    const insertEvent = store.database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(
      sourcePath,
      startMs,
      "in-range",
      "home",
      "Home",
      "main",
      "project",
      "gpt-6-luna",
      "hour",
      "day",
      "week",
      "month",
      20,
      18,
      0,
      2,
      0,
    );
    insertEvent.run(
      sourcePath,
      endMs,
      "outside-range",
      "home",
      "Home",
      "main",
      "project",
      "gpt-6-luna",
      "hour",
      "day",
      "week",
      "month",
      10,
      9,
      0,
      1,
      0,
    );
    store.database
      .prepare(
        `INSERT INTO history_replaced_facts (
          fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
          source_home_label, source_home_path, method_version, revision_reason, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "events",
        "codex",
        "home",
        sourcePath,
        "digest",
        1,
        '{"sample":"old-event"}',
        "Home",
        root,
        "events.v1",
        "reparse",
        "2026-01-02T03:05:00.000Z",
      );
    assert.ok(readFileSync(`${databaseFile}-wal`).byteLength > 0);
    const sourceBytes = readFileSync(databaseFile);
    const sourceWalBytes = readFileSync(`${databaseFile}-wal`);
    const tierSnapshot = {
      formatVersion: 1,
      threads: [{ threadId: "thread-1", turns: [{ time: startMs, tier: "priority" }] }],
    };

    await createHistoryArchiveCandidate(store.database, destination, {
      startMs,
      endMs,
      serviceTierEvidence: serviceTierEvidenceFromSnapshot(tierSnapshot),
    });

    const verified = await verifyHistoryBackup(destination);
    assert.deepEqual(verified.manifest.serviceTierEvidence.snapshot, tierSnapshot);
    const verifiedCandidate = await verifyHistoryArchiveCandidate(destination);
    assert.deepEqual(verifiedCandidate.candidate, {
      formatVersion: 1,
      startMs,
      endMs,
      state: "unregistered",
      events: {
        rows: 1,
        sha256: verifiedCandidate.candidate.events.sha256,
      },
      sources: {
        rows: 1,
        sha256: verifiedCandidate.candidate.sources.sha256,
      },
    });
    assert.match(verifiedCandidate.candidate.events.sha256, /^[a-f0-9]{64}$/);
    assert.match(verifiedCandidate.candidate.sources.sha256, /^[a-f0-9]{64}$/);
    const candidate = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.deepEqual(
        candidate
          .prepare("SELECT timestamp_ms, session_id FROM events")
          .all()
          .map((row) => ({ ...row })),
        [{ timestamp_ms: startMs, session_id: "in-range" }],
      );
      assert.deepEqual(
        candidate
          .prepare("SELECT path, kind, home_id, home_path FROM source_files")
          .all()
          .map((row) => ({ ...row })),
        [{ path: sourcePath, kind: "codex", home_id: "home", home_path: root }],
      );
      assert.deepEqual(
        candidate
          .prepare("SELECT payload FROM history_replaced_facts")
          .all()
          .map((row) => ({ ...row })),
        [{ payload: '{"sample":"old-event"}' }],
      );
      assert.deepEqual(
        JSON.parse(
          candidate.prepare("SELECT value FROM store_meta WHERE key = 'history_archive_candidate'").get().value,
        ),
        verifiedCandidate.candidate,
      );
    } finally {
      candidate.close();
    }

    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 2);
    assert.deepEqual(readFileSync(databaseFile), sourceBytes);
    assert.deepEqual(readFileSync(`${databaseFile}-wal`), sourceWalBytes);

    const databaseBytes = readFileSync(destination);
    const manifestBytes = readFileSync(candidateManifest);
    await assert.rejects(
      createHistoryArchiveCandidate(store.database, destination, { startMs, endMs }),
      (error) => error.code === "HISTORY_BACKUP_DESTINATION_EXISTS",
    );
    assert.deepEqual(readFileSync(destination), databaseBytes);
    assert.deepEqual(readFileSync(candidateManifest), manifestBytes);
    assert.deepEqual(readFileSync(databaseFile), sourceBytes);
    assert.deepEqual(readFileSync(`${databaseFile}-wal`), sourceWalBytes);

    assert.throws(
      () => assertHistoryArchiveSourceMatches(store.database, { ok: true }),
      /verifiedCandidate must be the result of verifyHistoryArchiveCandidate/,
    );
    assertHistoryArchiveSourceMatches(store.database, verifiedCandidate);
    store.database.prepare("UPDATE source_files SET kind = 'claude' WHERE path = ?").run(sourcePath);
    assert.throws(
      () => assertHistoryArchiveSourceMatches(store.database, verifiedCandidate),
      (error) => error.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
    );
    store.database.prepare("UPDATE source_files SET kind = 'codex' WHERE path = ?").run(sourcePath);
    assertHistoryArchiveSourceMatches(store.database, verifiedCandidate);
    store.database.prepare("UPDATE events SET session_id = 'changed' WHERE session_id = 'in-range'").run();
    assert.throws(
      () => assertHistoryArchiveSourceMatches(store.database, verifiedCandidate),
      (error) => error.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
    );
    store.database.prepare("UPDATE events SET session_id = 'in-range' WHERE session_id = 'changed'").run();
    const unrelatedPath = path.join(root, "unrelated.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unrelatedPath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    store.database.prepare("UPDATE source_files SET kind = 'claude' WHERE path = ?").run(unrelatedPath);
    assertHistoryArchiveSourceMatches(store.database, verifiedCandidate);
    insertEvent.run(
      sourcePath,
      endMs + 60_000,
      "hot-appended",
      "home",
      "Home",
      "main",
      "project",
      "gpt-6-luna",
      "hour",
      "day",
      "week",
      "month",
      5,
      5,
      0,
      0,
      0,
    );
    const matchingSourceBytes = readFileSync(databaseFile);
    const matchingSourceWalBytes = readFileSync(`${databaseFile}-wal`);
    assertHistoryArchiveSourceMatches(store.database, verifiedCandidate);
    assert.deepEqual(readFileSync(databaseFile), matchingSourceBytes);
    assert.deepEqual(readFileSync(`${databaseFile}-wal`), matchingSourceWalBytes);

    const sourceState = () => ({
      databaseBytes: readFileSync(databaseFile),
      walBytes: readFileSync(`${databaseFile}-wal`),
      eventCount: store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count,
      events: store.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      sources: store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
        .all()
        .map((row) => ({ ...row })),
      recovered: store.database
        .prepare("SELECT payload FROM history_replaced_facts ORDER BY payload_digest")
        .all()
        .map((row) => ({ ...row })),
    });
    const sourceBeforePortable = sourceState();
    const portableFile = path.join(root, "portable", "restored.sqlite");
    await restoreHistoryBackup(destination, portableFile);

    const rewriteCandidateMetadata = async (changes, rewritten) => {
      const writable = new DatabaseSync(destination);
      try {
        const metadata = JSON.parse(
          writable.prepare("SELECT value FROM store_meta WHERE key = 'history_archive_candidate'").get().value,
        );
        writable
          .prepare("UPDATE store_meta SET value = ? WHERE key = 'history_archive_candidate'")
          .run(JSON.stringify({ ...metadata, ...changes }));
      } finally {
        writable.close();
      }
      const rewrittenDatabase = new DatabaseSync(destination, { readOnly: true });
      try {
        await createHistoryBackup(rewrittenDatabase, rewritten);
      } finally {
        rewrittenDatabase.close();
      }
      await verifyHistoryBackup(rewritten);
    };

    const boundaryRewrite = path.join(root, "tampered-boundary.sqlite");
    await rewriteCandidateMetadata({ startMs: startMs + 1 }, boundaryRewrite);
    await assert.rejects(
      verifyHistoryArchiveCandidate(boundaryRewrite),
      (error) => error.code === "HISTORY_ARCHIVE_CANDIDATE_RANGE_MISMATCH",
    );

    const fingerprintRewrite = path.join(root, "tampered-fingerprint.sqlite");
    await rewriteCandidateMetadata(
      {
        startMs,
        events: { ...verifiedCandidate.candidate.events, sha256: "0".repeat(64) },
      },
      fingerprintRewrite,
    );
    await assert.rejects(
      verifyHistoryArchiveCandidate(fingerprintRewrite),
      (error) => error.code === "HISTORY_ARCHIVE_CANDIDATE_FINGERPRINT_MISMATCH",
    );

    const sourceRewrite = path.join(root, "tampered-sources.sqlite");
    await rewriteCandidateMetadata(
      {
        startMs,
        events: verifiedCandidate.candidate.events,
        sources: { ...verifiedCandidate.candidate.sources, sha256: "0".repeat(64) },
      },
      sourceRewrite,
    );
    await assert.rejects(
      verifyHistoryArchiveCandidate(sourceRewrite),
      (error) => error.code === "HISTORY_ARCHIVE_CANDIDATE_SOURCE_MISMATCH",
    );
    assert.deepEqual(readFileSync(databaseFile), matchingSourceBytes);
    assert.deepEqual(readFileSync(`${databaseFile}-wal`), matchingSourceWalBytes);

    await rm(candidateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    const script = `
      import { DatabaseSync } from "node:sqlite";
      import { verifyHistoryArchiveCandidate } from ${JSON.stringify(new URL("../src/history-archive.js", import.meta.url).href)};
      import { loadHistoryBackupContext } from ${JSON.stringify(new URL("../src/history-backup.js", import.meta.url).href)};
      const databaseFile = process.argv[1];
      const startMs = Number(process.argv[2]);
      const sourcePath = process.argv[3];
      const verified = await verifyHistoryArchiveCandidate(databaseFile);
      const context = await loadHistoryBackupContext(databaseFile);
      const database = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        const events = database
          .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
          .all()
          .map((row) => ({ ...row }));
        const sources = database
          .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
          .all(sourcePath)
          .map((row) => ({ ...row }));
        process.stdout.write(JSON.stringify({
          candidate: verified.candidate,
          pricingCatalog: context.pricingCatalog,
          tier: context.serviceTierEvidence?.resolve("thread-1", startMs) ?? null,
          events,
          sources,
        }));
      } finally {
        database.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, portableFile, String(startMs), sourcePath],
      { encoding: "utf8" },
    );
    const portable = JSON.parse(output);
    assert.deepEqual(portable.candidate, verifiedCandidate.candidate);
    assert.deepEqual(
      {
        pricingCatalog: portable.pricingCatalog,
        tier: portable.tier,
        events: portable.events,
        sources: portable.sources,
        originalPackageExists: existsSync(candidateDirectory),
      },
      {
        pricingCatalog: verified.manifest.pricing.catalog,
        tier: "priority",
        events: [{ timestamp_ms: startMs, session_id: "in-range", total: 20 }],
        sources: [{ path: sourcePath, kind: "codex", home_id: "home", home_label: "Home", home_path: root }],
        originalPackageExists: false,
      },
    );
    assert.deepEqual(sourceState(), sourceBeforePortable);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("candidate creation rejects a non-empty archive registry before creating output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-registry-"));
  const databaseFile = path.join(root, "source.sqlite");
  const registeredCandidate = path.join(root, "registered-candidate.sqlite");
  const rejectedDirectory = path.join(root, "rejected-package");
  const rejectedCandidate = path.join(rejectedDirectory, "candidate.sqlite");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  const originalTempEnvironment = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  try {
    await store.open();
    const productTemp = path.join(root, "product-temp");
    await mkdir(productTemp);
    process.env.TMPDIR = productTemp;
    process.env.TMP = productTemp;
    process.env.TEMP = productTemp;
    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    const insertEvent = store.database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(
      sourcePath,
      startMs,
      "in-range",
      "home",
      "Home",
      "main",
      "project",
      "gpt-6-luna",
      "hour",
      "day",
      "week",
      "month",
      20,
      18,
      0,
      2,
      0,
    );
    insertEvent.run(
      sourcePath,
      endMs,
      "outside-range",
      "home",
      "Home",
      "main",
      "project",
      "gpt-6-luna",
      "hour",
      "day",
      "week",
      "month",
      10,
      9,
      0,
      1,
      0,
    );
    store.database
      .prepare(
        `INSERT INTO history_replaced_facts (
          fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
          source_home_label, source_home_path, method_version, revision_reason, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "events",
        "codex",
        "home",
        sourcePath,
        "digest",
        1,
        '{"sample":"registered"}',
        "Home",
        root,
        "events.v1",
        "reparse",
        "2026-01-02T03:05:00.000Z",
      );

    await createHistoryArchiveCandidate(store.database, registeredCandidate, { startMs, endMs });
    await store.registerHistoryArchiveCandidate(registeredCandidate);
    const sourceState = () => ({
      databaseBytes: readFileSync(databaseFile),
      walBytes: readFileSync(`${databaseFile}-wal`),
      registry: store.database
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row })),
      events: store.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      sources: store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
        .all()
        .map((row) => ({ ...row })),
      recovered: store.database
        .prepare("SELECT payload FROM history_replaced_facts ORDER BY payload_digest")
        .all()
        .map((row) => ({ ...row })),
    });
    const before = sourceState();
    const workDirectoriesBefore = new Set(readdirSync(productTemp));

    await assert.rejects(
      createHistoryArchiveCandidate(store.database, rejectedCandidate, { startMs, endMs }),
      (error) => error.code === "HISTORY_BACKUP_ARCHIVES_UNSUPPORTED",
    );

    assert.deepEqual(sourceState(), before);
    assert.deepEqual(
      {
        newWorkDirectories: readdirSync(productTemp).filter(
          (name) => name.startsWith("codex-usage-archive-") && !workDirectoriesBefore.has(name),
        ),
        destinationExists: existsSync(rejectedCandidate),
        manifestExists: existsSync(path.join(rejectedDirectory, "candidate.manifest.json")),
      },
      { newWorkDirectories: [], destinationExists: false, manifestExists: false },
    );
  } finally {
    for (const [key, value] of Object.entries(originalTempEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("registered archive inventory verifies packages and fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-inventory-"));
  const databaseFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "segments", "candidate.sqlite");
  const manifestFile = path.join(root, "segments", "candidate.manifest.json");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    store.database
      .prepare(
        `INSERT INTO events (
          source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
          hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourcePath,
        startMs,
        "in-range",
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-luna",
        "hour",
        "day",
        "week",
        "month",
        20,
        18,
        0,
        2,
        0,
      );

    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const candidateBytes = readFileSync(candidateFile);
    const sourceState = () => ({
      databaseBytes: readFileSync(databaseFile),
      walBytes: readFileSync(`${databaseFile}-wal`),
      registry: store.database
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row })),
      events: store.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      sources: store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
        .all()
        .map((row) => ({ ...row })),
      anchor:
        store.database.prepare("SELECT value FROM store_meta WHERE key = 'history_archive_bundle_segments_v1'").get()
          ?.value ?? null,
    });
    const before = sourceState();

    assert.deepEqual(await inventoryHistoryArchiveSegments(store.database), {
      segments: [
        {
          segmentId: registered.segmentId,
          databaseFile: path.resolve(candidateFile),
          manifestFile: path.resolve(manifestFile),
          databaseSha256: registered.databaseSha256,
          startMs,
          endMs,
          eventCount: 1,
        },
      ],
    });

    writeFileSync(candidateFile, Buffer.concat([candidateBytes, Buffer.from([0])]));
    await assert.rejects(inventoryHistoryArchiveSegments(store.database), {
      code: "HISTORY_BACKUP_SIZE_MISMATCH",
    });
    writeFileSync(candidateFile, candidateBytes);

    const mismatched = new DatabaseSync(":memory:");
    try {
      mismatched.exec(`
        CREATE TABLE archive_segments (
          segment_id TEXT PRIMARY KEY,
          database_path TEXT NOT NULL,
          database_sha256 TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          event_count INTEGER NOT NULL
        );
      `);
      mismatched
        .prepare("INSERT INTO archive_segments VALUES (?, ?, ?, ?, ?, ?)")
        .run(registered.segmentId, candidateFile, registered.databaseSha256, startMs, endMs, 2);
      await assert.rejects(inventoryHistoryArchiveSegments(mismatched), {
        code: "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
      });
    } finally {
      mismatched.close();
    }

    await rm(candidateFile);
    await assert.rejects(inventoryHistoryArchiveSegments(store.database), {
      code: "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    });
    assert.deepEqual(sourceState(), before);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("registered segments stage into a portable bundle without changing source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-staging-"));
  const databaseFile = path.join(root, "source.sqlite");
  const candidateDirectory = path.join(root, "candidate-package");
  const candidateFile = path.join(candidateDirectory, "candidate.sqlite");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    store.database
      .prepare(
        `INSERT INTO events (
          source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
          hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourcePath,
        startMs,
        "in-range",
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-luna",
        "hour",
        "day",
        "week",
        "month",
        20,
        18,
        0,
        2,
        0,
      );

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs,
      endMs,
      serviceTierEvidence: serviceTierEvidenceFromSnapshot({
        formatVersion: 1,
        threads: [{ threadId: "thread-1", turns: [{ time: startMs, tier: "priority" }] }],
      }),
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const sourceState = () => ({
      databaseBytes: readFileSync(databaseFile),
      walBytes: readFileSync(`${databaseFile}-wal`),
      registry: store.database
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row })),
      events: store.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      sources: store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
        .all()
        .map((row) => ({ ...row })),
    });
    const before = sourceState();

    const existingStaging = path.join(root, "existing-staging");
    await mkdir(existingStaging);
    writeFileSync(path.join(existingStaging, "keep.txt"), "keep");
    await assert.rejects(stageHistoryArchiveSegments(store.database, existingStaging), {
      code: "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
    });
    assert.deepEqual(
      {
        entries: readdirSync(existingStaging),
        sentinel: readFileSync(path.join(existingStaging, "keep.txt"), "utf8"),
      },
      { entries: ["keep.txt"], sentinel: "keep" },
    );

    const stagingDirectory = path.join(root, "bundle-staging");
    assert.deepEqual(await stageHistoryArchiveSegments(store.database, stagingDirectory), {
      segments: [
        {
          segmentId: registered.segmentId,
          databaseFile: `segments/${registered.segmentId}.sqlite`,
          manifestFile: `segments/${registered.segmentId}.manifest.json`,
          databaseSha256: registered.databaseSha256,
          startMs,
          endMs,
          eventCount: 1,
        },
      ],
    });

    await rm(candidateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const stagedDatabase = path.join(stagingDirectory, "segments", `${registered.segmentId}.sqlite`);
    const verified = await verifyHistoryArchiveCandidate(stagedDatabase);
    const context = await loadHistoryBackupContext(stagedDatabase);
    const staged = new DatabaseSync(stagedDatabase, { readOnly: true });
    try {
      assert.deepEqual(
        {
          startMs: verified.candidate.startMs,
          endMs: verified.candidate.endMs,
          eventCount: verified.candidate.events.rows,
          tier: context.serviceTierEvidence?.resolve("thread-1", startMs) ?? null,
          event: { ...staged.prepare("SELECT timestamp_ms, session_id, total FROM events").get() },
        },
        {
          startMs,
          endMs,
          eventCount: 1,
          tier: "priority",
          event: { timestamp_ms: startMs, session_id: "in-range", total: 20 },
        },
      );
    } finally {
      staged.close();
    }

    const failedStaging = path.join(root, "failed-staging");
    await assert.rejects(stageHistoryArchiveSegments(store.database, failedStaging), {
      code: "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    });
    assert.equal(existsSync(failedStaging), false);
    assert.deepEqual(sourceState(), before);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("complete archive bundle stages hot facts and segments from one snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-bundle-"));
  const databaseFile = path.join(root, "source.sqlite");
  const candidateDirectory = path.join(root, "candidate-package");
  const candidateFile = path.join(candidateDirectory, "candidate.sqlite");
  const originalPricingCatalog = getPricingCatalog();
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  const originalTempEnvironment = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  try {
    await store.open();
    const productTemp = path.join(root, "product-temp");
    await mkdir(productTemp);
    process.env.TMPDIR = productTemp;
    process.env.TMP = productTemp;
    process.env.TEMP = productTemp;
    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    store.database
      .prepare(
        `INSERT INTO events (
          source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
          hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourcePath,
        startMs,
        "in-range",
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-luna",
        "hour",
        "day",
        "week",
        "month",
        20,
        18,
        0,
        2,
        0,
      );

    const serviceTierEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [{ threadId: "thread-1", turns: [{ time: startMs, tier: "priority" }] }],
    });
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs,
      endMs,
      serviceTierEvidence,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const catalogAInput = getPricingCatalog();
    catalogAInput.checkedAt = "2026-10-22";
    catalogAInput.usdToCnyRate = 7.31;
    catalogAInput.models["gpt-6-sol"].short.input += 1.25;
    const catalogA = setPricingCatalog(catalogAInput);
    const catalogBInput = getPricingCatalog();
    catalogBInput.checkedAt = "2026-10-23";
    catalogBInput.models["gpt-6-sol"].short.input += 3.5;
    const catalogB = setPricingCatalog(catalogBInput);
    setPricingCatalog(catalogA);
    assert.notEqual(catalogA.version, catalogB.version);

    const sourceState = () => ({
      databaseBytes: readFileSync(databaseFile),
      walBytes: readFileSync(`${databaseFile}-wal`),
      registry: store.database
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row })),
      events: store.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      sources: store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
        .all()
        .map((row) => ({ ...row })),
      anchor:
        store.database.prepare("SELECT value FROM store_meta WHERE key = 'history_archive_bundle_segments_v1'").get()
          ?.value ?? null,
    });
    const before = sourceState();
    const workDirectoriesBefore = new Set(readdirSync(productTemp));

    const existingStaging = path.join(root, "existing-bundle");
    await mkdir(existingStaging);
    writeFileSync(path.join(existingStaging, "keep.txt"), "keep");
    await assert.rejects(stageHistoryArchiveBundle(store.database, existingStaging, { serviceTierEvidence }), {
      code: "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
    });
    assert.deepEqual(
      {
        entries: readdirSync(existingStaging),
        sentinel: readFileSync(path.join(existingStaging, "keep.txt"), "utf8"),
      },
      { entries: ["keep.txt"], sentinel: "keep" },
    );

    const emptyPublishTarget = path.join(root, "publish-empty");
    await mkdir(emptyPublishTarget);
    await assert.rejects(publishHistoryArchiveBundle(store.database, emptyPublishTarget, { serviceTierEvidence }), {
      code: "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
    });
    assert.deepEqual(readdirSync(emptyPublishTarget), []);
    assert.equal(existsSync(path.join(emptyPublishTarget, "bundle.complete.json")), false);

    const nonEmptyPublishTarget = path.join(root, "publish-nonempty");
    await mkdir(nonEmptyPublishTarget);
    writeFileSync(path.join(nonEmptyPublishTarget, "keep.txt"), "keep");
    await assert.rejects(publishHistoryArchiveBundle(store.database, nonEmptyPublishTarget, { serviceTierEvidence }), {
      code: "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
    });
    assert.deepEqual(
      {
        entries: readdirSync(nonEmptyPublishTarget),
        sentinel: readFileSync(path.join(nonEmptyPublishTarget, "keep.txt"), "utf8"),
      },
      { entries: ["keep.txt"], sentinel: "keep" },
    );
    assert.equal(existsSync(path.join(nonEmptyPublishTarget, "bundle.complete.json")), false);

    const stagingDirectory = path.join(root, "bundle");
    const bundlePromise = stageHistoryArchiveBundle(store.database, stagingDirectory, { serviceTierEvidence });
    setPricingCatalog(catalogB);
    const manifest = await bundlePromise;
    assert.deepEqual(getPricingCatalog(), catalogB);
    assert.deepEqual(manifest, {
      formatVersion: 1,
      main: {
        databaseFile: "main.sqlite",
        manifestFile: "main.manifest.json",
      },
      segments: [
        {
          segmentId: registered.segmentId,
          databaseFile: `segments/${registered.segmentId}.sqlite`,
          manifestFile: `segments/${registered.segmentId}.manifest.json`,
          databaseSha256: registered.databaseSha256,
          startMs,
          endMs,
          eventCount: 1,
          registeredAtMs: registered.registeredAtMs,
        },
      ],
    });
    const bundleManifestFile = path.join(stagingDirectory, "bundle.manifest.json");
    const originalBundleManifestText = readFileSync(bundleManifestFile, "utf8");
    const bundleManifest = JSON.parse(originalBundleManifestText);
    assert.deepEqual(bundleManifest, manifest);
    assert.equal(JSON.stringify(bundleManifest).includes(root), false);
    const verifiedBundle = await verifyHistoryArchiveBundle(stagingDirectory);
    assert.deepEqual(
      { ok: verifiedBundle.ok, manifest: verifiedBundle.manifest },
      { ok: true, manifest: bundleManifest },
    );
    await assert.rejects(verifyPublishedHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND",
    });

    const publishedDirectory = path.join(root, "published-bundle");
    const published = await publishHistoryArchiveBundle(store.database, publishedDirectory, { serviceTierEvidence });
    assert.equal(published.directory, publishedDirectory);
    assert.equal(published.markerFile, path.join(publishedDirectory, "bundle.complete.json"));
    assert.deepEqual(published.manifest, bundleManifest);
    assert.equal((await verifyHistoryArchiveBundle(publishedDirectory)).ok, true);
    const marker = JSON.parse(readFileSync(published.markerFile, "utf8"));
    assert.deepEqual(
      {
        formatVersion: marker.formatVersion,
        bundleFormatVersion: marker.bundleFormatVersion,
        bundleManifestSha256: marker.bundleManifestSha256,
        completedAtValid: !Number.isNaN(Date.parse(marker.completedAt)),
      },
      {
        formatVersion: 1,
        bundleFormatVersion: 1,
        bundleManifestSha256: createHash("sha256").update(readFileSync(published.manifestFile)).digest("hex"),
        completedAtValid: true,
      },
    );
    const verifiedPublished = await verifyPublishedHistoryArchiveBundle(publishedDirectory);
    assert.deepEqual(
      {
        ok: verifiedPublished.ok,
        directory: verifiedPublished.directory,
        markerFile: verifiedPublished.markerFile,
        marker: verifiedPublished.marker,
        manifest: verifiedPublished.manifest,
      },
      {
        ok: true,
        directory: publishedDirectory,
        markerFile: published.markerFile,
        marker,
        manifest: bundleManifest,
      },
    );

    const originalPublishedManifestText = readFileSync(published.manifestFile, "utf8");
    const originalPublishedMarkerText = readFileSync(published.markerFile, "utf8");
    writeFileSync(published.manifestFile, `${originalPublishedManifestText}\n`, "utf8");
    await assert.rejects(verifyPublishedHistoryArchiveBundle(publishedDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_MARKER_MISMATCH",
    });
    writeFileSync(published.manifestFile, originalPublishedManifestText, "utf8");

    const wrongMarkerDigest = structuredClone(marker);
    wrongMarkerDigest.bundleManifestSha256 = "0".repeat(64);
    writeFileSync(published.markerFile, `${JSON.stringify(wrongMarkerDigest, null, 2)}\n`, "utf8");
    await assert.rejects(verifyPublishedHistoryArchiveBundle(publishedDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_MARKER_MISMATCH",
    });

    writeFileSync(published.markerFile, originalPublishedMarkerText.slice(0, -3), "utf8");
    await assert.rejects(verifyPublishedHistoryArchiveBundle(publishedDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_BAD_MARKER",
    });

    const wrongMarkerFormat = structuredClone(marker);
    wrongMarkerFormat.formatVersion = 2;
    writeFileSync(published.markerFile, `${JSON.stringify(wrongMarkerFormat, null, 2)}\n`, "utf8");
    await assert.rejects(verifyPublishedHistoryArchiveBundle(publishedDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_BAD_MARKER",
    });

    const wrongCompletedAt = structuredClone(marker);
    wrongCompletedAt.completedAt = "2026-10-23T00:00:00+08:00";
    writeFileSync(published.markerFile, `${JSON.stringify(wrongCompletedAt, null, 2)}\n`, "utf8");
    await assert.rejects(verifyPublishedHistoryArchiveBundle(publishedDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_BAD_MARKER",
    });

    writeFileSync(published.markerFile, originalPublishedMarkerText, "utf8");
    assert.equal((await verifyPublishedHistoryArchiveBundle(publishedDirectory)).ok, true);

    const writeBundleManifest = (value) =>
      writeFileSync(bundleManifestFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const restoreBundleManifest = () => writeFileSync(bundleManifestFile, originalBundleManifestText, "utf8");

    const extraField = structuredClone(bundleManifest);
    extraField.extra = true;
    writeBundleManifest(extraField);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_BAD_MANIFEST",
    });
    restoreBundleManifest();

    const missingSegment = structuredClone(bundleManifest);
    missingSegment.segments = [];
    writeBundleManifest(missingSegment);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_MISMATCH",
    });
    restoreBundleManifest();

    const wrongRegisteredAt = structuredClone(bundleManifest);
    wrongRegisteredAt.segments[0].registeredAtMs += 1;
    writeBundleManifest(wrongRegisteredAt);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_MISMATCH",
    });
    restoreBundleManifest();

    const extraSegment = structuredClone(bundleManifest);
    extraSegment.segments.push({
      ...structuredClone(extraSegment.segments[0]),
      segmentId: "f".repeat(64),
      startMs: endMs,
      endMs: endMs + 60_000,
    });
    writeBundleManifest(extraSegment);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_MISMATCH",
    });
    restoreBundleManifest();

    const wrongCount = structuredClone(bundleManifest);
    wrongCount.segments[0].eventCount += 1;
    writeBundleManifest(wrongCount);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_MISMATCH",
    });
    restoreBundleManifest();

    const duplicateSegment = structuredClone(bundleManifest);
    duplicateSegment.segments.push(structuredClone(duplicateSegment.segments[0]));
    writeBundleManifest(duplicateSegment);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_SEGMENT_CONFLICT",
    });
    restoreBundleManifest();

    const overlappingSegment = structuredClone(bundleManifest);
    overlappingSegment.segments.push({
      ...structuredClone(overlappingSegment.segments[0]),
      segmentId: "f".repeat(64),
      databaseSha256: "f".repeat(64),
    });
    writeBundleManifest(overlappingSegment);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_SEGMENT_CONFLICT",
    });
    restoreBundleManifest();

    for (const escapedPath of [path.resolve(stagingDirectory, "main.sqlite"), "../outside-package/main.sqlite"]) {
      const escaped = structuredClone(bundleManifest);
      escaped.main.databaseFile = escapedPath;
      writeBundleManifest(escaped);
      await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
        code: "HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE",
      });
      restoreBundleManifest();
    }

    const outsidePackage = path.join(root, "outside-package");
    await mkdir(outsidePackage);
    writeFileSync(path.join(outsidePackage, "main.sqlite"), "outside bundle");
    await symlink(
      outsidePackage,
      path.join(stagingDirectory, "escape-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const symlinkEscape = structuredClone(bundleManifest);
    symlinkEscape.main.databaseFile = "escape-link/main.sqlite";
    writeBundleManifest(symlinkEscape);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE",
    });
    restoreBundleManifest();

    const stagedDatabase = path.join(stagingDirectory, "segments", `${registered.segmentId}.sqlite`);
    const stagedDatabaseBytes = readFileSync(stagedDatabase);
    await rm(stagedDatabase);
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND",
    });
    writeFileSync(stagedDatabase, stagedDatabaseBytes);
    writeFileSync(stagedDatabase, Buffer.concat([stagedDatabaseBytes, Buffer.from([0])]));
    await assert.rejects(verifyHistoryArchiveBundle(stagingDirectory), {
      code: "HISTORY_BACKUP_SIZE_MISMATCH",
    });
    writeFileSync(stagedDatabase, stagedDatabaseBytes);
    assert.equal((await verifyHistoryArchiveBundle(stagingDirectory)).ok, true);

    const mainDatabase = path.join(stagingDirectory, "main.sqlite");
    assert.equal((await verifyHistoryBackup(mainDatabase)).ok, true);
    const mainContext = await loadHistoryBackupContext(mainDatabase);
    const main = new DatabaseSync(mainDatabase, { readOnly: true });
    try {
      assert.deepEqual(
        {
          archived: Number(main.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count),
          anchor: JSON.parse(
            main.prepare("SELECT value FROM store_meta WHERE key = 'history_archive_bundle_segments_v1'").get().value,
          ),
          event: { ...main.prepare("SELECT timestamp_ms, session_id, total FROM events").get() },
          pricing: mainContext.pricingCatalog,
          tier: mainContext.serviceTierEvidence?.resolve("thread-1", startMs) ?? null,
        },
        {
          archived: 0,
          anchor: { formatVersion: 1, segments: manifest.segments },
          event: { timestamp_ms: startMs, session_id: "in-range", total: 20 },
          pricing: catalogA,
          tier: "priority",
        },
      );
    } finally {
      main.close();
    }

    const legacyBundle = path.join(root, "legacy-bundle");
    const legacySourceFile = path.join(root, "legacy-main.sqlite");
    await mkdir(legacyBundle);
    writeFileSync(legacySourceFile, readFileSync(mainDatabase));
    const legacySource = new DatabaseSync(legacySourceFile);
    try {
      legacySource.prepare("DELETE FROM store_meta WHERE key = 'history_archive_bundle_segments_v1'").run();
    } finally {
      legacySource.close();
    }
    const legacySourceReadOnly = new DatabaseSync(legacySourceFile, { readOnly: true });
    try {
      await createHistoryBackup(legacySourceReadOnly, path.join(legacyBundle, "main.sqlite"));
    } finally {
      legacySourceReadOnly.close();
    }
    writeFileSync(
      path.join(legacyBundle, "bundle.manifest.json"),
      `${JSON.stringify(
        {
          formatVersion: 1,
          main: { databaseFile: "main.sqlite", manifestFile: "main.manifest.json" },
          segments: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await assert.rejects(verifyHistoryArchiveBundle(legacyBundle), {
      code: "HISTORY_ARCHIVE_BUNDLE_MISMATCH",
    });

    const noEvidenceStaging = path.join(root, "bundle-no-evidence");
    await stageHistoryArchiveBundle(store.database, noEvidenceStaging);
    const noEvidenceContext = await loadHistoryBackupContext(path.join(noEvidenceStaging, "main.sqlite"));
    assert.deepEqual(
      {
        pricing: noEvidenceContext.pricingCatalog,
        tier: noEvidenceContext.serviceTierEvidence,
      },
      {
        pricing: catalogB,
        tier: null,
      },
    );

    await rm(candidateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const staged = await verifyHistoryArchiveCandidate(stagedDatabase);
    const stagedContext = await loadHistoryBackupContext(stagedDatabase);
    const segment = new DatabaseSync(stagedDatabase, { readOnly: true });
    try {
      assert.deepEqual(
        {
          startMs: staged.candidate.startMs,
          endMs: staged.candidate.endMs,
          event: { ...segment.prepare("SELECT timestamp_ms, session_id, total FROM events").get() },
          tier: stagedContext.serviceTierEvidence?.resolve("thread-1", startMs) ?? null,
        },
        {
          startMs,
          endMs,
          event: { timestamp_ms: startMs, session_id: "in-range", total: 20 },
          tier: "priority",
        },
      );
    } finally {
      segment.close();
    }

    const failedStaging = path.join(root, "failed-bundle");
    await assert.rejects(stageHistoryArchiveBundle(store.database, failedStaging, { serviceTierEvidence }), {
      code: "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    });
    assert.equal(existsSync(failedStaging), false);
    assert.deepEqual(getPricingCatalog(), catalogB);
    assert.deepEqual(sourceState(), before);
    assert.deepEqual(
      readdirSync(productTemp).filter(
        (name) => name.startsWith("codex-usage-archive-") && !workDirectoriesBefore.has(name),
      ),
      [],
    );
  } finally {
    setPricingCatalog(originalPricingCatalog);
    for (const [key, value] of Object.entries(originalTempEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("published bundle staging copies only declared files and remains usable after source removal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-portable-"));
  try {
    const source = await createPublishedBundle(root);
    writeFileSync(path.join(source.directory, "unknown-extra.txt"), "do not copy");
    const originalContext = await loadHistoryBackupContext(
      path.join(source.directory, source.verified.manifest.main.databaseFile),
      path.join(source.directory, source.verified.manifest.main.manifestFile),
    );
    const stagedDirectory = path.join(root, "staged");

    const staged = await stagePublishedHistoryArchiveBundle(source.directory, stagedDirectory);
    assert.equal(staged.directory, path.resolve(stagedDirectory));
    assert.equal(existsSync(path.join(stagedDirectory, "unknown-extra.txt")), false);
    assert.deepEqual(staged.manifest, source.verified.manifest);

    await rm(source.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const verified = await verifyPublishedHistoryArchiveBundle(stagedDirectory);
    const stagedContext = await loadHistoryBackupContext(
      path.join(stagedDirectory, verified.manifest.main.databaseFile),
      path.join(stagedDirectory, verified.manifest.main.manifestFile),
    );
    assert.deepEqual(stagedContext.pricingCatalog, originalContext.pricingCatalog);
    assert.equal(stagedContext.serviceTierEvidence.resolve(source.threadId, source.startMs), "priority");
    const main = new DatabaseSync(stagedContext.databaseFile, { readOnly: true });
    try {
      assert.deepEqual(
        main
          .prepare("SELECT session_id, total FROM events")
          .all()
          .map((row) => ({ ...row })),
        [{ session_id: source.threadId, total: 20 }],
      );
    } finally {
      main.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("published bundle staging rejects existing directories and missing or bad markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-portable-gate-"));
  try {
    const source = await createPublishedBundle(root);
    const existing = path.join(root, "existing");
    await mkdir(existing);
    await assert.rejects(stagePublishedHistoryArchiveBundle(source.directory, existing), {
      code: "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
    });
    assert.deepEqual(readdirSync(existing), []);

    const markerBytes = readFileSync(source.verified.markerFile);
    await rm(source.verified.markerFile);
    const missingTarget = path.join(root, "missing-marker-target");
    await assert.rejects(stagePublishedHistoryArchiveBundle(source.directory, missingTarget), {
      code: "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND",
    });
    assert.equal(existsSync(missingTarget), false);

    writeFileSync(source.verified.markerFile, markerBytes);
    writeFileSync(source.verified.markerFile, "not-json");
    const badTarget = path.join(root, "bad-marker-target");
    await assert.rejects(stagePublishedHistoryArchiveBundle(source.directory, badTarget), {
      code: "HISTORY_ARCHIVE_BUNDLE_BAD_MARKER",
    });
    assert.equal(existsSync(badTarget), false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("published bundle staging removes its own target after a copy I/O failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-portable-failure-"));
  const fsPromises = process.getBuiltinModule("fs/promises");
  const originalCopyFile = fsPromises.copyFile;
  try {
    const source = await createPublishedBundle(root);
    const sourceBytes = publishedBundleBytes(source.verified);
    const existing = path.join(root, "existing");
    const sentinel = path.join(existing, "keep.txt");
    await mkdir(existing);
    writeFileSync(sentinel, "keep");
    const failedTarget = path.join(root, "failed-copy");

    fsPromises.copyFile = async (sourceFile, destinationFile, ...args) => {
      if (
        path.resolve(String(destinationFile)).startsWith(`${failedTarget}${path.sep}`) &&
        path.basename(String(destinationFile)) === "main.sqlite"
      ) {
        throw Object.assign(new Error("simulated copy I/O failure"), { code: "EIO" });
      }
      return originalCopyFile(sourceFile, destinationFile, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(stagePublishedHistoryArchiveBundle(source.directory, failedTarget), {
      code: "EIO",
    });
    assert.equal(existsSync(failedTarget), false);
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
    assert.deepEqual(publishedBundleBytes(source.verified), sourceBytes);
    assert.equal((await verifyPublishedHistoryArchiveBundle(source.directory)).ok, true);
  } finally {
    fsPromises.copyFile = originalCopyFile;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("import runtime relocates the registry into the frozen bundle after source removal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-import-runtime-"));
  try {
    const source = await createPublishedBundle(root, {
      authority: true,
      beforePublish(database, registered) {
        database.prepare("DELETE FROM events WHERE timestamp_ms = ?").run(registered.startMs);
        database
          .prepare(
            `INSERT INTO events (
              source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
              hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            path.join(root, "source.jsonl"),
            registered.endMs + 60_000,
            "live-bundle-thread",
            "home",
            "Home",
            "main",
            "project",
            "gpt-6-sol",
            "hour",
            "day",
            "week",
            "month",
            7,
            6,
            0,
            1,
            0,
          );
      },
    });
    const bundleMainFile = path.join(source.directory, source.verified.manifest.main.databaseFile);
    const bundleMain = new DatabaseSync(bundleMainFile, { readOnly: true });
    let authorityValue;
    let expectedLiveRows;
    try {
      authorityValue = bundleMain
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get("history_archive_event_authority").value;
      expectedLiveRows = bundleMain
        .prepare("SELECT * FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
    } finally {
      bundleMain.close();
    }
    const sourceSegment = new DatabaseSync(
      path.join(source.directory, source.verified.manifest.segments[0].databaseFile),
      { readOnly: true },
    );
    let expectedColdRows;
    try {
      expectedColdRows = sourceSegment
        .prepare("SELECT * FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
    } finally {
      sourceSegment.close();
    }

    const importDirectory = path.join(root, "imported");
    const materialized = await materializePublishedHistoryArchiveRuntime(source.directory, importDirectory);
    assert.equal(materialized.runtimeFile, path.join(path.resolve(importDirectory), "runtime.sqlite"));
    assert.equal(typeof materialized.loadBundleContext, "function");
    const frozenBytes = publishedBundleBytes(await verifyPublishedHistoryArchiveBundle(materialized.bundleDirectory));

    await rm(source.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(path.join(root, "candidate"), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    const runtimeStore = new UsageStore({
      homeDir: root,
      env: {},
      importDirs: [],
      databaseFile: materialized.runtimeFile,
    });
    await runtimeStore.open();
    try {
      const registry = runtimeStore.database
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row }));
      assert.equal(registry.length, source.verified.manifest.segments.length);
      assert.equal(
        path.relative(path.resolve(materialized.bundleDirectory), String(registry[0].database_path)).startsWith(".."),
        false,
      );
      assert.deepEqual(
        {
          segment_id: registry[0].segment_id,
          database_sha256: registry[0].database_sha256,
          start_ms: registry[0].start_ms,
          end_ms: registry[0].end_ms,
          event_count: registry[0].event_count,
          registered_at_ms: registry[0].registered_at_ms,
        },
        {
          segment_id: source.registered.segmentId,
          database_sha256: source.registered.databaseSha256,
          start_ms: source.registered.startMs,
          end_ms: source.registered.endMs,
          event_count: source.registered.eventCount,
          registered_at_ms: source.registered.registeredAtMs,
        },
      );
      assert.equal(
        runtimeStore.database
          .prepare("SELECT value FROM store_meta WHERE key = ?")
          .get("history_archive_event_authority").value,
        authorityValue,
      );
      assert.deepEqual(
        (await runtimeStore.readHistoryArchiveEvents(source.registered.segmentId)).map((row) => ({ ...row })),
        expectedColdRows,
      );
      assert.deepEqual(
        (
          await runtimeStore.mergeHistoryArchiveEventsForRange({
            startMs: source.registered.startMs,
            endMs: source.registered.endMs + 120_000,
          })
        ).map((row) => ({ ...row })),
        [...expectedColdRows, ...expectedLiveRows],
      );

      const context = await materialized.loadBundleContext();
      assert.equal(context.serviceTierEvidence.resolve(source.threadId, source.startMs), "priority");
    } finally {
      runtimeStore.close();
    }
    assert.deepEqual(
      publishedBundleBytes(await verifyPublishedHistoryArchiveBundle(materialized.bundleDirectory)),
      frozenBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("import runtime removes its new directory after a genuine registry write failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-import-runtime-failure-"));
  try {
    const source = await createPublishedBundle(root, {
      beforePublish(database) {
        database.exec(`
          CREATE TRIGGER fail_import_registry
          BEFORE INSERT ON archive_segments
          BEGIN
            SELECT RAISE(ABORT, 'simulated import registry failure');
          END;
        `);
      },
    });
    const sourceBytes = publishedBundleBytes(source.verified);
    const importDirectory = path.join(root, "failed-import");

    await assert.rejects(
      materializePublishedHistoryArchiveRuntime(source.directory, importDirectory),
      /simulated import registry failure/,
    );
    assert.equal(existsSync(importDirectory), false);
    assert.deepEqual(publishedBundleBytes(source.verified), sourceBytes);
    assert.equal((await verifyPublishedHistoryArchiveBundle(source.directory)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("import runtime never overwrites an existing empty or nonempty directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-import-runtime-gate-"));
  try {
    const source = await createPublishedBundle(root);
    const sourceBytes = publishedBundleBytes(source.verified);
    const empty = path.join(root, "existing-empty");
    const nonempty = path.join(root, "existing-nonempty");
    await mkdir(empty);
    await mkdir(nonempty);
    writeFileSync(path.join(nonempty, "keep.txt"), "keep");

    for (const target of [empty, nonempty]) {
      await assert.rejects(materializePublishedHistoryArchiveRuntime(source.directory, target), {
        code: "HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS",
      });
    }
    assert.deepEqual(readdirSync(empty), []);
    assert.equal(readFileSync(path.join(nonempty, "keep.txt"), "utf8"), "keep");
    assert.deepEqual(publishedBundleBytes(source.verified), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("completed import opens read-only after source removal with bundle context and registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-open-import-"));
  try {
    const source = await createPublishedBundle(root, {
      authority: true,
      beforePublish(database, registered) {
        database.prepare("DELETE FROM events WHERE timestamp_ms = ?").run(registered.startMs);
      },
    });
    const originalContext = await loadHistoryBackupContext(
      path.join(source.directory, source.verified.manifest.main.databaseFile),
      path.join(source.directory, source.verified.manifest.main.manifestFile),
    );
    const importDirectory = path.join(root, "imported");
    const imported = await publishHistoryArchiveImport(source.directory, importDirectory);
    const runtimeBytes = readFileSync(imported.runtimeFile);
    const bundleBytes = publishedBundleBytes(await verifyPublishedHistoryArchiveBundle(imported.bundleDirectory));
    const markerBytes = readFileSync(imported.markerFile);

    await rm(source.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const loaded = await loadHistoryArchiveImport(importDirectory);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.runtimeFile, path.join(path.resolve(importDirectory), "runtime.sqlite"));
    assert.equal(loaded.bundleDirectory, path.join(path.resolve(importDirectory), "bundle"));
    assert.deepEqual(loaded.manifest, source.verified.manifest);
    assert.deepEqual(loaded.context.pricingCatalog, originalContext.pricingCatalog);
    assert.equal(loaded.context.serviceTierEvidence.resolve(source.threadId, source.startMs), "priority");

    const runtime = new DatabaseSync(loaded.runtimeFile, { readOnly: true });
    try {
      const registry = runtime
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row }));
      assert.equal(registry.length, source.verified.manifest.segments.length);
      for (const segment of source.verified.manifest.segments) {
        const row = registry.find((record) => record.segment_id === segment.segmentId);
        assert.ok(row);
        assert.equal(path.relative(loaded.bundleDirectory, String(row.database_path)).startsWith(".."), false);
        assert.equal(row.database_sha256, segment.databaseSha256);
        assert.equal(row.start_ms, segment.startMs);
        assert.equal(row.end_ms, segment.endMs);
        assert.equal(row.event_count, segment.eventCount);
        assert.equal(row.registered_at_ms, segment.registeredAtMs);
      }
    } finally {
      runtime.close();
    }
    assert.deepEqual(readFileSync(imported.runtimeFile), runtimeBytes);
    assert.deepEqual(readFileSync(imported.markerFile), markerBytes);
    assert.deepEqual(
      publishedBundleBytes(await verifyPublishedHistoryArchiveBundle(imported.bundleDirectory)),
      bundleBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("completed import rejects missing, malformed, mismatched, and escaping markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-open-marker-"));
  try {
    const source = await createPublishedBundle(root);
    const importDirectory = path.join(root, "imported");
    const imported = await publishHistoryArchiveImport(source.directory, importDirectory);
    const markerBytes = readFileSync(imported.markerFile);
    const marker = JSON.parse(markerBytes.toString("utf8"));
    const runtimeBytes = readFileSync(imported.runtimeFile);

    await rm(imported.markerFile);
    await assert.rejects(loadHistoryArchiveImport(importDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND",
    });

    const rejectedMarkers = [
      [{ ...marker, extra: true }, "HISTORY_ARCHIVE_IMPORT_BAD_MARKER"],
      [{ ...marker, completedAt: "not-a-time" }, "HISTORY_ARCHIVE_IMPORT_BAD_MARKER"],
      [{ ...marker, bundleManifestSha256: "0".repeat(64) }, "HISTORY_ARCHIVE_IMPORT_MARKER_MISMATCH"],
      [{ ...marker, runtimeFile: "../runtime.sqlite" }, "HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE"],
      [{ ...marker, runtimeFile: path.join(root, "runtime.sqlite") }, "HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE"],
    ];
    for (const [badMarker, code] of rejectedMarkers) {
      writeFileSync(imported.markerFile, `${JSON.stringify(badMarker)}\n`);
      await assert.rejects(loadHistoryArchiveImport(importDirectory), { code });
    }

    writeFileSync(imported.markerFile, markerBytes);
    assert.equal((await loadHistoryArchiveImport(importDirectory)).ok, true);
    assert.deepEqual(readFileSync(imported.runtimeFile), runtimeBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("completed import rejects a bundle junction escaping the import root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-open-bundle-escape-"));
  try {
    const source = await createPublishedBundle(root);
    const sourceBytes = publishedBundleBytes(source.verified);
    const importDirectory = path.join(root, "imported");
    const imported = await publishHistoryArchiveImport(source.directory, importDirectory);
    const markerBytes = readFileSync(imported.markerFile);
    const outsideRoot = path.join(root, "outside");
    const outsideBundle = path.join(outsideRoot, "bundle");
    await mkdir(outsideRoot);
    await rename(imported.bundleDirectory, outsideBundle);
    await symlink(outsideBundle, imported.bundleDirectory, process.platform === "win32" ? "junction" : "dir");

    const runtime = new DatabaseSync(imported.runtimeFile);
    try {
      const update = runtime.prepare("UPDATE archive_segments SET database_path = ? WHERE segment_id = ?");
      for (const segment of source.verified.manifest.segments) {
        update.run(path.join(outsideBundle, segment.databaseFile), segment.segmentId);
      }
    } finally {
      runtime.close();
    }
    const runtimeBytes = readFileSync(imported.runtimeFile);

    await assert.rejects(loadHistoryArchiveImport(importDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE",
    });
    assert.deepEqual(readFileSync(imported.runtimeFile), runtimeBytes);
    assert.deepEqual(readFileSync(imported.markerFile), markerBytes);
    assert.deepEqual(publishedBundleBytes(source.verified), sourceBytes);
    assert.equal((await verifyPublishedHistoryArchiveBundle(outsideBundle)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("completed import rejects a runtimeFile junction escaping the import root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-open-runtime-escape-"));
  try {
    const source = await createPublishedBundle(root);
    const sourceBytes = publishedBundleBytes(source.verified);
    const importDirectory = path.join(root, "imported");
    const imported = await publishHistoryArchiveImport(source.directory, importDirectory);
    const markerBytes = readFileSync(imported.markerFile);
    const bundleBytes = publishedBundleBytes(await verifyPublishedHistoryArchiveBundle(imported.bundleDirectory));
    const outsideRoot = path.join(root, "outside-runtime");
    const outsideRuntime = path.join(outsideRoot, "runtime.sqlite");
    await mkdir(outsideRoot);
    await rename(imported.runtimeFile, outsideRuntime);
    await symlink(outsideRoot, imported.runtimeFile, process.platform === "win32" ? "junction" : "dir");
    const runtimeBytes = readFileSync(outsideRuntime);

    await assert.rejects(loadHistoryArchiveImport(importDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE",
    });
    assert.deepEqual(readFileSync(outsideRuntime), runtimeBytes);
    assert.deepEqual(readFileSync(imported.markerFile), markerBytes);
    assert.deepEqual(
      publishedBundleBytes(await verifyPublishedHistoryArchiveBundle(imported.bundleDirectory)),
      bundleBytes,
    );
    assert.deepEqual(publishedBundleBytes(source.verified), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("completed import rejects missing segments or changed registry without writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-open-invalid-"));
  try {
    const source = await createPublishedBundle(root);
    const importDirectory = path.join(root, "imported");
    const imported = await publishHistoryArchiveImport(source.directory, importDirectory);
    const segment = source.verified.manifest.segments[0];
    const segmentFile = path.join(imported.bundleDirectory, segment.databaseFile);
    const segmentBytes = readFileSync(segmentFile);
    const runtimeBytes = readFileSync(imported.runtimeFile);
    const markerBytes = readFileSync(imported.markerFile);
    const bundleMainFile = path.join(imported.bundleDirectory, source.verified.manifest.main.databaseFile);
    const bundleMainBytes = readFileSync(bundleMainFile);

    await rm(segmentFile);
    await assert.rejects(loadHistoryArchiveImport(importDirectory), {
      code: "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND",
    });
    assert.deepEqual(readFileSync(imported.runtimeFile), runtimeBytes);
    assert.deepEqual(readFileSync(imported.markerFile), markerBytes);
    assert.deepEqual(readFileSync(bundleMainFile), bundleMainBytes);

    writeFileSync(segmentFile, segmentBytes);
    const runtime = new DatabaseSync(imported.runtimeFile);
    try {
      runtime.prepare("UPDATE archive_segments SET database_sha256 = ?").run("0".repeat(64));
    } finally {
      runtime.close();
    }
    const changedRuntimeBytes = readFileSync(imported.runtimeFile);
    await assert.rejects(loadHistoryArchiveImport(importDirectory), {
      code: "HISTORY_ARCHIVE_IMPORT_RUNTIME_MISMATCH",
    });
    assert.deepEqual(readFileSync(imported.runtimeFile), changedRuntimeBytes);
    assert.deepEqual(readFileSync(imported.markerFile), markerBytes);
    assert.deepEqual(readFileSync(bundleMainFile), bundleMainBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("bundle publish removes verifier and marker failure output without changing source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-publish-failure-"));
  const databaseFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const destination = path.join(root, "failed-publish");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    const startMs = new Date("2026-02-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-02-02T03:05:00.000Z");
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
    await store.registerHistoryArchiveCandidate(candidateFile);
    const registeredAtMs = Number(
      store.database.prepare("SELECT registered_at_ms FROM archive_segments").get().registered_at_ms,
    );
    store.database.prepare("UPDATE archive_segments SET registered_at_ms = -1").run();

    const sourceState = () => ({
      databaseBytes: readFileSync(databaseFile),
      walBytes: existsSync(`${databaseFile}-wal`) ? readFileSync(`${databaseFile}-wal`) : null,
      registry: store.database
        .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row })),
      events: store.database
        .prepare("SELECT timestamp_ms, session_id, total FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
    });
    const before = sourceState();

    await assert.rejects(publishHistoryArchiveBundle(store.database, destination), {
      code: "HISTORY_ARCHIVE_BUNDLE_BAD_MANIFEST",
    });
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(path.join(destination, "bundle.complete.json")), false);
    assert.deepEqual(sourceState(), before);

    store.database.prepare("UPDATE archive_segments SET registered_at_ms = ?").run(registeredAtMs);
    const beforeMarkerFailure = sourceState();
    const markerFailureDestination = path.join(root, "marker-failure-publish");
    const markerFailureFile = path.join(markerFailureDestination, "bundle.complete.json");
    const fsPromises = process.getBuiltinModule("fs/promises");
    const originalWriteFile = fsPromises.writeFile;
    fsPromises.writeFile = async (file, ...args) => {
      if (path.resolve(String(file)) === markerFailureFile) {
        throw Object.assign(new Error("simulated completion marker write failure"), { code: "EACCES" });
      }
      return originalWriteFile(file, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(publishHistoryArchiveBundle(store.database, markerFailureDestination), {
        code: "EACCES",
      });
    } finally {
      fsPromises.writeFile = originalWriteFile;
      syncBuiltinESMExports();
    }
    assert.equal(existsSync(markerFailureDestination), false);
    assert.equal(existsSync(markerFailureFile), false);
    assert.deepEqual(sourceState(), beforeMarkerFailure);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("candidate rejects invalid ranges", async () => {
  const database = archiveDatabase();
  try {
    for (const [startMs, endMs] of [
      [1, 1],
      [2, 1],
      [1.5, 2],
      [8_640_000_000_000_001, 8_640_000_000_000_002],
    ]) {
      await assert.rejects(
        createHistoryArchiveCandidate(database, path.join(os.tmpdir(), "unused-archive.sqlite"), { startMs, endMs }),
        /startMs and endMs must be valid epoch millisecond integers with startMs < endMs/,
      );
    }
  } finally {
    database.close();
  }
});

test("candidate deletion failure preserves source and removes private artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-failure-"));
  const databaseFile = path.join(root, "source.sqlite");
  const destination = path.join(root, "archive-failure.sqlite");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    store.database.exec("PRAGMA wal_autocheckpoint = 0");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    const insertEvent = store.database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [timestampMs, sessionId] of [
      [startMs, "in-range"],
      [endMs, "outside-range"],
    ]) {
      insertEvent.run(
        sourcePath,
        timestampMs,
        sessionId,
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-luna",
        "hour",
        "day",
        "week",
        "month",
        10,
        9,
        0,
        1,
        0,
      );
    }
    store.database
      .prepare(
        `INSERT INTO history_replaced_facts (
          fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
          source_home_label, source_home_path, method_version, revision_reason, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "events",
        "codex",
        "home",
        sourcePath,
        "failure-digest",
        1,
        '{"sample":"preserved"}',
        "Home",
        root,
        "events.v1",
        "reparse",
        "2026-01-02T03:05:00.000Z",
      );
    store.database.exec(`
      CREATE TRIGGER archive_delete_abort
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'archive candidate deletion blocked');
      END;
    `);

    const sourceBytes = readFileSync(databaseFile);
    const sourceWalBytes = readFileSync(`${databaseFile}-wal`);
    const facts = {
      events: store.database
        .prepare("SELECT timestamp_ms, session_id FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      recovered: store.database
        .prepare("SELECT payload FROM history_replaced_facts")
        .all()
        .map((row) => ({ ...row })),
    };
    const workDirectoriesBefore = new Set(
      readdirSync(os.tmpdir()).filter((name) => name.startsWith("codex-usage-archive-")),
    );

    await assert.rejects(
      createHistoryArchiveCandidate(store.database, destination, { startMs, endMs }),
      /archive candidate deletion blocked/,
    );

    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(path.join(root, "archive-failure.manifest.json")), false);
    assert.deepEqual(
      readdirSync(os.tmpdir()).filter(
        (name) => name.startsWith("codex-usage-archive-") && !workDirectoriesBefore.has(name),
      ),
      [],
    );
    assert.deepEqual(readFileSync(databaseFile), sourceBytes);
    assert.deepEqual(readFileSync(`${databaseFile}-wal`), sourceWalBytes);
    assert.deepEqual(
      store.database
        .prepare("SELECT timestamp_ms, session_id FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      facts.events,
    );
    assert.deepEqual(
      store.database
        .prepare("SELECT payload FROM history_replaced_facts")
        .all()
        .map((row) => ({ ...row })),
      facts.recovered,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
