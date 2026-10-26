import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const FILTERS = { preset: "all", calendarZone: "utc", now: new Date("2026-07-12T12:00:00Z") };
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("cold repository facts share the timeline scan and preserve SQL totals, Unicode ties and session order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fused-summary-repositories-"));
  const store = new UsageStore({ databaseFile: path.join(root, "usage.sqlite"), homeDir: root });
  const segment = path.join(root, "segment.sqlite");
  try {
    await store.open();
    for (const id of ["a", "b"]) {
      store.database
        .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
        .run(`/fixture/${id}`, "codex", id, "Same Home", `/fixture/home-${id}`, 1, 1, "now");
    }
    const insert = store.database.prepare(`INSERT INTO events(
      source_path,timestamp_ms,session_id,home_id,home_label,channel,project,cwd,
      repository_key,repository_path,repository_kind,model,hour_key,day_key,week_key,month_key,
      total,input,cached,output,reasoning,detail_mask
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [day, home, session, key, name, kind, cwd, total] of [
      ["2026-01-02", "b", "tie-b", "repo-main", "/work/\u{10000}", "git", "/work/a", 100],
      ["2026-01-02", "a", "tie-a", "repo-main", "/work/\ue000", "unknown", "", 50],
      ["2026-01-01", "a", "shared", "repo-main", "/work/\u{10000}", "git", "/work/a", -5],
      ["2026-07-01", "b", "shared", "repo-main", "/work/\ue000", "git", "/work/b", 30],
      ["2026-07-02", "a", "last", "repo-main", "/work/\u{10000}", "git", "/work/b", 25],
      ["2026-01-03", "a", "u1", "unicode-1", "\u{10000}", "git", "/u1", 10],
      ["2026-07-03", "b", "u2", "unicode-2", "\ue000", "git", "/u2", 10],
      ["2026-01-04", "a", "duplicate-name-a", "duplicate-1", "/same", "git", "", 7],
      ["2026-07-04", "b", "duplicate-name-b", "duplicate-2", "/same", "git", "", 7],
    ]) {
      insert.run(
        `/fixture/${home}`,
        Date.parse(`${day}T02:00:00Z`),
        session,
        home,
        "Same Home",
        "CLI",
        "stored project",
        cwd,
        key,
        name,
        kind,
        "gpt-6-sol",
        `${day} 02`,
        day,
        "2025-12-29",
        day.slice(0, 7),
        total,
        total,
        0,
        0,
        0,
        31,
      );
    }
    store.homes = ["a", "b"].map((id) => ({ id, label: "Same Home", path: `/fixture/home-${id}`, kind: "codex" }));
    store.generatedAt = "2026-07-12T00:00:00Z";
    await createHistoryArchiveCandidate(store.database, segment, {
      startMs: Date.parse("2026-01-01T00:00:00Z"),
      endMs: Date.parse("2026-02-01T00:00:00Z"),
    });
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, segment));
    const before = store.database.prepare("SELECT * FROM events ORDER BY id").all();
    const sha = digest(segment);
    for (const scope of [FILTERS, { ...FILTERS, calendarZone: "local" }, { ...FILTERS, excludeHomes: ["b"] }]) {
      const expected = await store.dashboardHistory(scope);
      const reader = store.historySqlDashboardCache.store;
      const sqlRepositories = reader.repositoriesRange.bind(reader);
      if (!scope.excludeHomes) {
        assert.deepEqual(expected.summary.repositories[0].sessionIds, ["shared", "tie-a", "tie-b", "last"]);
        assert.equal(expected.summary.repositories[0].pathCount, 2);
        assert.equal(expected.summary.repositories[0].kind, "unknown");
        assert.equal(expected.periodComparison.repositories.find((row) => row.key === "repo-main").kind, "git");
        assert.equal(expected.summary.repositories[0].name, "/work/\ue000");
        assert.equal(expected.summary.repositories[0].total.total, 200);
        assert.deepEqual(
          expected.summary.repositories.slice(-2).map((row) => row.key),
          ["duplicate-1", "duplicate-2"],
        );
      }
      reader.summaryProjectionCache = null;
      const summarize = reader.summarizeInReadTransaction;
      reader.summarizeInReadTransaction = function (...args) {
        const summary = summarize.apply(this, args);
        const range = { ...summary.range, start: new Date(summary.range.start), end: new Date(summary.range.end) };
        assert.deepEqual(summary.repositories, sqlRepositories(range, scope.excludeHomes));
        return summary;
      };
      let duplicateQueries = 0;
      reader.repositoriesRange = (...args) => {
        duplicateQueries += 1;
        return sqlRepositories(...args);
      };
      try {
        assert.deepEqual(await store.dashboardHistory(scope), expected);
        assert.equal(duplicateQueries, 0, "the verified cold summary must not rescan repository aggregates");
      } finally {
        reader.repositoriesRange = sqlRepositories;
        reader.summarizeInReadTransaction = summarize;
      }
      const shallow = await store.dashboardHistory(scope, { includeDetails: false });
      assert.equal(Object.hasOwn(shallow.summary, "repositories"), false);
    }
    assert.deepEqual(store.database.prepare("SELECT * FROM events ORDER BY id").all(), before);
    assert.equal(digest(segment), sha);
    store.database.exec(`UPDATE events SET repository_key='repo-main',
      total=CASE WHEN session_id='u2' THEN -4503599627370496 ELSE 4503599627370496 END
      WHERE session_id IN ('shared','last','u2') AND timestamp_ms >= ${Date.parse("2026-07-01T00:00:00Z")}`);
    store.commitStoreRevision("large-integer-fixture");
    const repositoriesRange = UsageStore.prototype.repositoriesRange;
    let integerFallbacks = 0;
    UsageStore.prototype.repositoriesRange = function (...args) {
      if (this.verifiedHistorySqlRead) integerFallbacks += 1;
      return repositoriesRange.apply(this, args);
    };
    try {
      const large = await store.dashboardHistory(FILTERS);
      assert.equal(integerFallbacks, 1, "unsafe intermediate integer sums must use the exact SQL aggregate");
      assert.equal(large.summary.repositories[0].total.total, 4503599627370496 + 145);
    } finally {
      UsageStore.prototype.repositoriesRange = repositoriesRange;
    }
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
