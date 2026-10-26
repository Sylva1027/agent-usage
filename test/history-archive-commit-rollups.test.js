import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const tables = [
  "usage_rollup_days",
  "usage_rollup_daily",
  "usage_rollup_models",
  "usage_rollup_sessions",
  "usage_rollup_dirty_days",
];
const evidence = (db) =>
  Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...row }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]),
  );

test("moving unchanged events to a verified archive preserves valid rollups and preexisting dirty work", async () => {
  for (const alreadyDirty of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), "ret-commit-rollup-"));
    const options = { homeDir: root, databaseFile: path.join(root, "usage.sqlite"), env: {}, importDirs: [] };
    const store = new UsageStore(options);
    const segment = path.join(root, "cold.sqlite");
    const start = Date.parse("2026-01-02T00:00:00Z"),
      end = Date.parse("2026-01-03T00:00:00Z");
    try {
      await store.open();
      store.database
        .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
        .run(path.join(root, "missing.jsonl"), "codex", "home", "Home", root, 1, 1, "now");
      const insert = store.database.prepare(`INSERT INTO events(
        source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
        hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const [time, total] of [
        [start + 1000, 100],
        [end + 1000, 30],
      ]) {
        const day = new Date(time).toISOString().slice(0, 10);
        insert.run(
          path.join(root, "missing.jsonl"),
          time,
          `s-${day}`,
          "home",
          "Home",
          "CLI",
          "fixture",
          "gpt-6-sol",
          `${day} 00`,
          day,
          "2025-12-29",
          "2026-01",
          total,
          total,
          0,
          0,
          0,
        );
      }
      await store.rebuildHistoryRollups();
      if (alreadyDirty) store.database.exec("UPDATE events SET total=90,input=90 WHERE id=1");
      const before = evidence(store.database);
      assert.equal(before.usage_rollup_dirty_days.length, alreadyDirty ? 1 : 0);
      await createHistoryArchiveCandidate(store.database, segment, { startMs: start, endMs: end });
      const plan = await prepareHistoryArchiveCommit(store.database, segment);
      if (!alreadyDirty) {
        store.database.exec(`CREATE TRIGGER fail_archive_rollup_restore BEFORE INSERT ON usage_rollup_days
          BEGIN SELECT RAISE(ABORT,'INJECTED_ARCHIVE_ROLLUP_RESTORE_FAILURE'); END`);
        await assert.rejects(store.commitHistoryArchiveEvents(plan), /INJECTED_ARCHIVE_ROLLUP_RESTORE_FAILURE/);
        store.database.exec("DROP TRIGGER fail_archive_rollup_restore");
        assert.deepEqual(evidence(store.database), before);
        assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
        assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM archive_segments").get().n, 0);
        assert.equal(store.readMetaRaw("history_archive_event_authority"), undefined);
      }
      await store.commitHistoryArchiveEvents(plan);
      assert.deepEqual(
        evidence(store.database),
        before,
        "physical movement changes no logical fact or existing rollup validity",
      );
      assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
      let unions = 0;
      const original = store.historyArchiveEventUnionForRange;
      store.historyArchiveEventUnionForRange = function (...args) {
        unions++;
        return original.apply(this, args);
      };
      await store.sync({ options });
      assert.equal(unions > 0, alreadyDirty, "only already-dirty facts require a complete-history rebuild on sync");
      const result = await store.dashboardHistory({
        preset: "all",
        calendarZone: "utc",
        now: new Date("2026-01-04T12:00:00Z"),
      });
      assert.equal(result.summary.totals.total, alreadyDirty ? 120 : 130);
      assert.deepEqual(store.database.prepare("SELECT day_key FROM usage_rollup_dirty_days").all(), []);
      const total = store.database
        .prepare("SELECT SUM(total) AS n FROM usage_rollup_daily WHERE calendar_zone='utc'")
        .get().n;
      assert.equal(total, alreadyDirty ? 120 : 130);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
