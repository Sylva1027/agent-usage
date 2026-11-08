import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createHistoryArchiveCandidate,
  prepareHistoryArchiveCommit,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { compactHistoryArchivePackage } from "../src/history-archive-compaction.js";
import { createHistoryBackup } from "../src/history-backup.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { readHistoryProjectionStamp, recordHistoryProjectionBatch } from "../src/usage-history-projection-store.js";
import { UsageStore } from "../src/usage-store.js";

export const DAY = 86_400_000;
export const START = Date.parse("2026-01-01T00:00:00Z");
export const filters = { preset: "all", calendarZone: "utc", bucket: "day", now: new Date("2026-01-08T12:00:00Z") };
export const clean = (value) =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === "generatedAt" ? undefined : item)));

/** Two authorized old packages, missing raw sources, hot facts, and optional ready-to-switch mapping. */
export async function makeCompactionFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-compaction-"));
  const file = path.join(root, "source.sqlite");
  const sourcePath = path.join(root, "missing.jsonl");
  const directory = path.join(root, "compacted");
  const stores = new Set();
  const evidence = serviceTierEvidenceFromSnapshot({
    formatVersion: 1,
    threads: [{ threadId: "shared-session", turns: [{ time: START - 1, tier: "standard" }] }],
  });
  t.after(() => {
    for (const current of stores) current.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const open = async (anonymous = false) => {
    const current = new UsageStore({
      databaseFile: file,
      homeDir: root,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
    });
    stores.add(current);
    await current.open();
    current.homes = [{ id: "home", label: "Home", path: root, kind: "codex" }];
    current.serviceTierEvidence = evidence;
    current.serviceTierEvidenceInput = "compaction-fixture";
    if (anonymous) current.usageProjectionDatabaseIdentity = () => null;
    return current;
  };
  let store = await open();
  store.database
    .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
    .run(sourcePath, "codex", "home", "Home", root, 1, 1, "fixture");
  store.database.exec("CREATE TABLE unrelated(value TEXT NOT NULL)");
  const insert = (database, time, output = 1, session = "shared-session") => {
    const date = new Date(time),
      day = date.toISOString().slice(0, 10);
    return database
      .prepare(`INSERT INTO events(
      source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning,detail_mask,cache_write_known)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,31,1)`)
      .run(
        sourcePath,
        time,
        session,
        "home",
        "Home",
        "CLI",
        "fixture",
        "gpt-6-sol",
        `${day} ${date.toISOString().slice(11, 13)}`,
        day,
        "2025-12-29",
        day.slice(0, 7),
        output,
        0,
        0,
        output,
        0,
      );
  };
  insert(store.database, START + 1000, 8_000_000_000_000_000);
  insert(store.database, START + 1000, 1, "other-session");
  insert(store.database, START + 1000);
  insert(store.database, START + DAY + 1000, 3);
  insert(store.database, START + DAY + 1000);
  insert(store.database, START + 2 * DAY + 1000);
  const quota = store.database.prepare(`INSERT INTO quota_usage_sources
    (rowid,source_path,home_id,session_id,timestamp_ms,quota_source,until_ms) VALUES(?,?,?,?,?,?,?)`);
  quota.run(-7, sourcePath, "home", "quota-a", START, "plan", START + 10 * DAY);
  quota.run(91, sourcePath, "home", "quota-b", START, "credits", START + 10 * DAY);
  await store.rebuildHistoryRollups();
  const packages = [];
  for (let day = 0; day < 2; day++) {
    const candidate = path.join(root, `candidate-${day}.sqlite`);
    const original = await createHistoryArchiveCandidate(store.database, candidate, {
      startMs: START + day * DAY,
      endMs: START + (day + 1) * DAY,
      serviceTierEvidence: evidence,
    });
    const scratch = path.join(root, `ballast-${day}.sqlite`);
    copyFileSync(candidate, scratch);
    const database = new DatabaseSync(scratch);
    const old = path.join(root, `old-${day}.sqlite`);
    try {
      // Future candidate creation is compact; publish a separately hashed legacy fixture with real free pages.
      database.exec(
        "CREATE TABLE ballast(bytes BLOB); INSERT INTO ballast VALUES(zeroblob(1048576)); DROP TABLE ballast;",
      );
      assert.ok(database.prepare("PRAGMA freelist_count").get().freelist_count > 0);
      await createHistoryBackup(database, old, {
        pricingCatalog: original.pricing.catalog,
        serviceTierEvidence: serviceTierEvidenceFromSnapshot(original.serviceTierEvidence.snapshot),
      });
    } finally {
      database.close();
    }
    await verifyHistoryArchiveCandidate(old);
    packages.push(old);
  }
  for (const candidate of packages)
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
  await store.ensureHistoryProjectionTracking();
  assert.equal(existsSync(sourcePath), false);

  const f = {
    root,
    file,
    sourcePath,
    directory,
    packages,
    filters,
    open,
    insert,
    mapping: null,
    get store() {
      return store;
    },
    async reopen() {
      store.close();
      store = await open();
      return store;
    },
    read() {
      return store.dashboardHistory(filters, { includeDetails: false });
    },
    async oracle() {
      const other = await open(true);
      try {
        return await other.dashboardHistory(filters, { includeDetails: false });
      } finally {
        other.close();
      }
    },
    append(time = START + 3 * DAY + 1000, output = 7, database = store.database) {
      const before = readHistoryProjectionStamp(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        insert(database, time, output);
        recordHistoryProjectionBatch(database, before, { sources: [sourcePath], mode: "append" });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    reviseCold(extraOutput = 7) {
      const segment = store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms LIMIT 1").get();
      const cold = new DatabaseSync(segment.database_path, { readOnly: true });
      let payload;
      try {
        payload = { ...cold.prepare("SELECT * FROM events WHERE output=1 ORDER BY id LIMIT 1").get() };
      } finally {
        cold.close();
      }
      delete payload.id;
      const sourceIdentity = {
        ...store.database
          .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
          .get(sourcePath),
      };
      const before = readHistoryProjectionStamp(store.database);
      store.database.exec("BEGIN IMMEDIATE");
      try {
        store.writeMeta(
          "history_archive_event_revisions",
          JSON.stringify({
            formatVersion: 1,
            revisions: [
              {
                segmentId: segment.segment_id,
                databaseSha256: segment.database_sha256,
                sourceIdentity,
                removed: [{ payload, count: 1 }],
                added: [
                  {
                    payload: { ...payload, total: payload.total + extraOutput, output: payload.output + extraOutput },
                    count: 1,
                  },
                ],
              },
            ],
          }),
        );
        // Match ingestion's invalidation of rollups covering a revised cold timestamp.
        store.database
          .prepare("INSERT OR IGNORE INTO usage_rollup_dirty_days(day_key) VALUES(?)")
          .run(new Date(payload.timestamp_ms).toISOString().slice(0, 10));
        store.database
          .prepare("DELETE FROM usage_rollup_days WHERE ?>=start_ms AND ?<end_ms")
          .run(payload.timestamp_ms, payload.timestamp_ms);
        recordHistoryProjectionBatch(store.database, before, { sources: [sourcePath], mode: "replace" });
        store.database.exec("COMMIT");
      } catch (error) {
        store.database.exec("ROLLBACK");
        throw error;
      }
    },
    async prepareMapping() {
      if (f.mapping) return f.mapping;
      mkdirSync(directory);
      const entries = [];
      for (const [index, previous] of store.database
        .prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id")
        .all()
        .entries()) {
        const built = await compactHistoryArchivePackage(
          previous.database_path,
          path.join(directory, `segment-${index}.sqlite`),
        );
        assert.notEqual(built.sha256, previous.segment_id);
        entries.push({
          previous,
          next: {
            ...previous,
            segment_id: built.sha256,
            database_sha256: built.sha256,
            database_path: built.databaseFile,
          },
        });
      }
      f.mapping = { format: 1, databaseFile: path.resolve(file), packages: entries };
      writeFileSync(path.join(directory, "compaction.json"), `${JSON.stringify(f.mapping, null, 2)}\n`);
      return f.mapping;
    },
  };
  return f;
}
