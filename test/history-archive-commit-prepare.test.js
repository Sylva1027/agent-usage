import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

test("prepareHistoryArchiveCommit captures one verified event-only plan without writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-prepare-"));
  const databaseFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "candidate", "candidate.sqlite");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    store.database.exec("PRAGMA wal_autocheckpoint = 0");

    const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const endMs = startMs + 60_000;
    const sourcePath = path.join(root, "source.jsonl");
    const outsidePath = path.join(root, "outside.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(outsidePath, "codex", "outside", "Outside", root, 1, 1, "2026-01-02T03:06:00.000Z");

    const insertEvent = store.database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [offset, sessionId, total] of [
      [0, "in-range-a", 20],
      [1, "in-range-b", 10],
    ]) {
      insertEvent.run(
        sourcePath,
        startMs + offset,
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
        total,
        total,
        0,
        0,
        0,
      );
    }
    insertEvent.run(
      outsidePath,
      endMs,
      "outside-range",
      "outside",
      "Outside",
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

    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
    const sourceState = () => ({
      database: readFileSync(databaseFile),
      wal: readFileSync(`${databaseFile}-wal`),
      events: store.database
        .prepare("SELECT * FROM events ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      sources: store.database
        .prepare("SELECT * FROM source_files ORDER BY path")
        .all()
        .map((row) => ({ ...row })),
    });

    const before = sourceState();
    const plan = await prepareHistoryArchiveCommit(store.database, candidateFile);
    const after = sourceState();
    const manifest = JSON.parse(readFileSync(manifestPathFor(candidateFile), "utf8"));
    const expectedIds = store.database
      .prepare("SELECT id FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id")
      .all(startMs, endMs)
      .map((row) => row.id);

    assert.deepEqual(plan.deletion, { table: "events", ids: expectedIds });
    assert.equal(plan.source.databaseFile, realpathSync.native(databaseFile));
    assert.equal("ids" in plan.source, false, "native ids are represented once, under deletion");
    assert.deepEqual(
      plan.source.sources,
      [
        {
          path: sourcePath,
          kind: "codex",
          home_id: "home",
          home_label: "Home",
          home_path: root,
        },
      ],
      "only source identities referenced by the candidate range belong in the plan",
    );
    assert.equal(plan.candidate.databaseSha256, manifest.database.sha256);
    assert.equal(plan.source.events.rows, 2);
    assert.deepEqual(plan.source.events, plan.candidate.events);
    assert.deepEqual(plan.source.sources.length, plan.candidate.sources.rows);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    assert.deepEqual(after, before, "prepare must not write source database, WAL, events, or identities");

    const inMemory = new DatabaseSync(":memory:");
    try {
      await assert.rejects(
        prepareHistoryArchiveCommit(inMemory, candidateFile),
        (error) => error?.code === "HISTORY_ARCHIVE_COMMIT_DATABASE_UNSUPPORTED",
        "an in-memory source has no persistent database identity",
      );
    } finally {
      inMemory.close();
    }

    const firstEventId = expectedIds[0];
    store.database.prepare("UPDATE events SET session_id = 'changed' WHERE id = ?").run(firstEventId);
    await assert.rejects(
      prepareHistoryArchiveCommit(store.database, candidateFile),
      (error) => error?.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
      "a source change after candidate creation must reject preparation",
    );
    store.database.prepare("UPDATE events SET session_id = 'in-range-a' WHERE id = ?").run(firstEventId);
    store.database.prepare("UPDATE source_files SET kind = 'claude' WHERE path = ?").run(sourcePath);
    await assert.rejects(
      prepareHistoryArchiveCommit(store.database, candidateFile),
      (error) => error?.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
      "a source identity change after candidate creation must reject preparation",
    );
    store.database.prepare("UPDATE source_files SET kind = 'codex' WHERE path = ?").run(sourcePath);
    const unchangedPlan = await prepareHistoryArchiveCommit(store.database, candidateFile);
    assert.deepEqual(unchangedPlan.deletion, plan.deletion);
    assert.equal(unchangedPlan.source.databaseFile, plan.source.databaseFile);

    const corruptFile = path.join(root, "corrupt.sqlite");
    copyFileSync(candidateFile, corruptFile);
    copyFileSync(manifestPathFor(candidateFile), manifestPathFor(corruptFile));
    appendFileSync(corruptFile, Buffer.from([0]));
    const beforeCorrupt = sourceState();
    await assert.rejects(
      prepareHistoryArchiveCommit(store.database, corruptFile),
      (error) => error?.code === "HISTORY_BACKUP_SIZE_MISMATCH",
      "a corrupt candidate must reject before returning a plan",
    );
    assert.deepEqual(sourceState(), beforeCorrupt, "candidate verification failure must leave source facts unchanged");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
