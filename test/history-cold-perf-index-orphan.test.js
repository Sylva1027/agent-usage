import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const MISSING_DEPENDENCY_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISSING";

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

test("candidate rejects a dependency-only cold perf source with missing identity", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-perf-index-orphan-source.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-index-orphan-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const selected = store.database
      .prepare(
        `SELECT dependencies.source_path,
                COUNT(*) AS dependency_rows,
                (SELECT COUNT(*) FROM events
                 WHERE events.source_path = dependencies.source_path) AS event_rows,
                (SELECT COUNT(*) FROM perf_samples AS primary_samples
                 WHERE primary_samples.source_path = dependencies.source_path
                   AND primary_samples.ts_ms >= ? AND primary_samples.ts_ms < ?) AS bounded_primary_rows,
                (SELECT COUNT(*) FROM perf_rollout_threads AS owners
                 WHERE owners.source_path = dependencies.source_path) AS rollout_rows
         FROM perf_samples AS samples
         JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
           AND dependencies.role = 'dependency'
         GROUP BY dependencies.source_path
         HAVING event_rows = 0 AND bounded_primary_rows = 0
         ORDER BY dependencies.source_path
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS, coldStartMs, COLD_END_MS);
    assert.ok(selected, "fixture must expose a cold dependency-only source with no events or bounded primary sample");
    assert.ok(Number(selected.dependency_rows) > 0);

    const sourceIdentity = store.database
      .prepare(
        `SELECT path, kind, home_id, home_label, home_path
         FROM source_files WHERE path = ?`,
      )
      .get(selected.source_path);
    assert.ok(sourceIdentity, "the selected dependency source must initially retain its identity");
    const originalIdentity = { ...sourceIdentity };
    const originalRelationCount = Number(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path = ?")
        .get(selected.source_path).count,
    );

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    try {
      isolated.exec("PRAGMA foreign_keys = OFF");
      assert.equal(Number(isolated.prepare("PRAGMA foreign_keys").get().foreign_keys), 0);
      const deleted = isolated.prepare("DELETE FROM source_files WHERE path = ?").run(selected.source_path);
      assert.equal(Number(deleted.changes), 1);
      assert.equal(
        Number(
          isolated
            .prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path = ?")
            .get(selected.source_path).count,
        ),
        originalRelationCount,
        "deleting the isolated source identity must retain every dependency relation",
      );
      assert.equal(
        Number(
          isolated.prepare("SELECT COUNT(*) AS count FROM source_files WHERE path = ?").get(selected.source_path).count,
        ),
        0,
      );
    } finally {
      isolated.close();
    }

    const isolatedReadOnly = new DatabaseSync(isolatedFile, { readOnly: true });
    try {
      await assert.rejects(
        () =>
          createHistoryArchiveCandidate(isolatedReadOnly, candidateFile, {
            startMs: coldStartMs,
            endMs: COLD_END_MS,
          }),
        (error) => {
          assert.equal(error?.code, MISSING_DEPENDENCY_CODE);
          return true;
        },
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), false, "candidate creation must not publish a destination database");
    assert.equal(existsSync(candidateManifest), false, "candidate creation must not publish a destination manifest");
    assert.deepEqual(
      {
        ...store.database
          .prepare(
            `SELECT path, kind, home_id, home_label, home_path
             FROM source_files WHERE path = ?`,
          )
          .get(selected.source_path),
      },
      originalIdentity,
      "the original source identity must remain unchanged",
    );
    assert.equal(
      Number(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path = ?")
          .get(selected.source_path).count,
      ),
      originalRelationCount,
      "the original source dependency relations must remain unchanged",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
