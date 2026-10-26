import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const OLD_TIME_ZONE = "Asia/Shanghai";
const NEW_TIME_ZONE = "America/Los_Angeles";

function runPhase(phase, timeZone, root) {
  const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { createHistoryArchiveCandidate } from "./src/history-archive.js";
    import { queryUsageRollups, rebuildUsageRollups } from "./src/usage-rollups.js";
    import { UsageStore } from "./src/usage-store.js";

    const AUTHORITY_META = "history_archive_event_authority";
    const ROLLUP_TABLES = [
      ["usage_rollup_daily", "day_key, home_id"],
      ["usage_rollup_models", "day_key, home_id, model"],
      ["usage_rollup_sessions", "day_key, home_id, session_id"],
      ["usage_rollup_days", "day_key"],
    ];
    const AGGREGATE_TABLES = ROLLUP_TABLES.filter(([table]) => table !== "usage_rollup_days");
    const coldTimestamp = "2026-07-12T23:30:00.000Z";
    const hotTimestamp = "2026-07-12T23:50:00.000Z";
    const root = process.env.TEST_ROOT;
    const codexHome = path.join(root, "codex-home");
    const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-zone-change.jsonl");
    const candidateFile = path.join(root, "cold-prefix.sqlite");
    const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };

    function tokenLine(timestamp, total, lastTotal) {
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

    function sourcePrefix() {
      return [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "cold-rollup-zone-session", source: "cli", cwd: codexHome },
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
        tokenLine(coldTimestamp, 100, 100),
      ].join("\\n");
    }

    function snapshot(database, zone, tables = ROLLUP_TABLES) {
      return Object.fromEntries(
        tables.map(([table, orderBy]) => [
          table,
          database
            .prepare(\`SELECT * FROM \${table} WHERE calendar_zone = ? ORDER BY \${orderBy}\`)
            .all(zone)
            .map((row) => ({ ...row })),
        ]),
      );
    }

    function localMarkers(database) {
      return database
        .prepare(
          \`SELECT day_key, start_ms, end_ms FROM usage_rollup_days
           WHERE calendar_zone = 'local' ORDER BY day_key\`,
        )
        .all()
        .map((row) => ({
          day_key: String(row.day_key),
          start_ms: Number(row.start_ms),
          end_ms: Number(row.end_ms),
        }));
    }

    if (process.env.PHASE === "old-zone") {
      const databaseFile = path.join(root, "archived.sqlite");
      const store = new UsageStore({ ...options, databaseFile });
      try {
        mkdirSync(path.dirname(usageFile), { recursive: true });
        writeFileSync(usageFile, \`\${sourcePrefix()}\\n\`);
        await store.sync({ options });

        await createHistoryArchiveCandidate(store.database, candidateFile, {
          startMs: Date.parse(coldTimestamp),
          endMs: Date.parse(hotTimestamp),
        });
        const registered = await store.registerHistoryArchiveCandidate(candidateFile);
        store.database.exec("BEGIN IMMEDIATE");
        try {
          store.database
            .prepare(
              \`INSERT INTO store_meta (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value\`,
            )
            .run(AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
          store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
          store.database.exec("COMMIT");
        } catch (error) {
          store.database.exec("ROLLBACK");
          throw error;
        }

        writeFileSync(usageFile, \`\${sourcePrefix()}\\n\${tokenLine(hotTimestamp, 130, 30)}\\n\`);
        store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
        const synced = await store.sync({ options });
        assert.equal(synced.updatedFileCount, 1);
        assert.deepEqual(
          store.database.prepare("SELECT total FROM events ORDER BY timestamp_ms").all().map((row) => Number(row.total)),
          [30],
        );
        assert.deepEqual(
          store.database
            .prepare(
              \`SELECT day_key, event_count, total FROM usage_rollup_daily
               WHERE calendar_zone = 'local' ORDER BY day_key\`,
            )
            .all()
            .map((row) => ({ dayKey: String(row.day_key), events: Number(row.event_count), total: Number(row.total) })),
          [{ dayKey: "2026-07-13", events: 2, total: 130 }],
        );
        process.stdout.write(JSON.stringify({ utc: snapshot(store.database, "utc") }));
      } finally {
        store.close();
      }
    } else {
      const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
      const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
      try {
        const synced = await store.sync({ options });
        assert.equal(synced.updatedFileCount, 0);
        assert.equal(
          store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get("usage_rollup_local_zone_identity")?.value,
          process.env.TZ,
        );
        await oracle.sync({ options });
        const localAggregates = snapshot(store.database, "local", AGGREGATE_TABLES);
        const oracleLocalAggregates = snapshot(oracle.database, "local", AGGREGATE_TABLES);
        const targetMarkers = localMarkers(store.database);
        const oracleMarkers = localMarkers(oracle.database);
        const oracleMarkerDays = new Set(oracleMarkers.map((row) => row.day_key));
        const commonMarkers = targetMarkers.filter((row) => oracleMarkerDays.has(row.day_key));
        const extraMarkers = targetMarkers.filter((row) => !oracleMarkerDays.has(row.day_key));
        assert.equal(extraMarkers.length, 1);
        for (const marker of extraMarkers) {
          rebuildUsageRollups(oracle.database, { days: [marker.day_key], calendarZone: "local" });
        }
        const extraMarkerChecks = extraMarkers.map((marker) => {
          const [year, month, date] = marker.day_key.split("-").map(Number);
          return {
            dayKey: marker.day_key,
            marker,
            oracleMarker: localMarkers(oracle.database).find((row) => row.day_key === marker.day_key),
            expectedBounds: {
              start_ms: new Date(year, month - 1, date).getTime(),
              end_ms: new Date(year, month - 1, date + 1).getTime(),
            },
            targetRead: queryUsageRollups(store.database, { day: marker.day_key, calendarZone: "local" }),
            oracleRead: queryUsageRollups(oracle.database, { day: marker.day_key, calendarZone: "local" }),
          };
        });
        const staleLocalAggregates = ["usage_rollup_daily", "usage_rollup_models", "usage_rollup_sessions"].map(
          (table) =>
            Number(
              store.database
                .prepare(\`SELECT COUNT(*) AS count FROM \${table} WHERE calendar_zone = 'local' AND day_key = ?\`)
                .get("2026-07-13").count,
            ),
        );
        const newLocalDaily = store.database
          .prepare(
            \`SELECT day_key, event_count, total FROM usage_rollup_daily
             WHERE calendar_zone = 'local' AND day_key = ?\`,
          )
          .all("2026-07-12")
          .map((row) => ({ dayKey: String(row.day_key), events: Number(row.event_count), total: Number(row.total) }));
        process.stdout.write(
          JSON.stringify({
            utc: snapshot(store.database, "utc"),
            localAggregates,
            oracle: { localAggregates: oracleLocalAggregates, markers: oracleMarkers },
            commonMarkers,
            extraMarkers: extraMarkerChecks,
            staleLocalAggregates,
            newLocalDaily,
          }),
        );
      } finally {
        store.close();
        oracle.close();
      }
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone, PHASE: phase, TEST_ROOT: root },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("ordinary sync rebuilds local rollups after a TZ-only change", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-rollup-zone-"));
  try {
    const before = runPhase("old-zone", OLD_TIME_ZONE, root);
    const after = runPhase("new-zone", NEW_TIME_ZONE, root);

    assert.deepEqual(after.utc, before.utc, "UTC rollups changed on a local-zone-only sync");
    assert.deepEqual(
      {
        localAggregates: after.localAggregates,
        oracleLocalAggregates: after.oracle.localAggregates,
        commonMarkers: after.commonMarkers,
        oracleMarkers: after.oracle.markers,
        newLocalDaily: after.newLocalDaily,
        staleLocalAggregates: after.staleLocalAggregates,
      },
      {
        localAggregates: after.oracle.localAggregates,
        oracleLocalAggregates: after.oracle.localAggregates,
        commonMarkers: after.oracle.markers,
        oracleMarkers: after.oracle.markers,
        newLocalDaily: [{ dayKey: "2026-07-12", events: 2, total: 130 }],
        staleLocalAggregates: [0, 0, 0],
      },
      "local aggregate tables, existing day markers, or cold contribution diverged from the new-TZ oracle",
    );
    const [extra] = after.extraMarkers;
    const expectedBounds = {
      start_ms: Date.UTC(2026, 6, 13, 7),
      end_ms: Date.UTC(2026, 6, 14, 7),
    };
    const zeroKeys = [
      "eventCount",
      "sessionCount",
      "homeCount",
      "total",
      "input",
      "cached",
      "output",
      "reasoning",
      "inputKnownTokens",
      "inputUnavailableTokens",
      "outputKnownTokens",
      "outputUnavailableTokens",
      "cachedKnownTokens",
      "cachedUnavailableTokens",
      "reasoningKnownTokens",
      "reasoningUnavailableTokens",
      "uncachedInput",
      "uncachedInputUnavailableTokens",
      "cacheRateInput",
      "cacheRateCached",
      "unattributedDetailTokens",
      "inconsistentTokens",
      "reconciliationGap",
      "inputKnownCount",
      "cachedKnownCount",
      "outputKnownCount",
      "reasoningKnownCount",
      "reconciliationGapCount",
    ];
    assert.deepEqual(
      {
        dayKey: extra.dayKey,
        marker: extra.marker,
        oracleMarker: extra.oracleMarker,
        expectedBounds: extra.expectedBounds,
        targetRead: extra.targetRead,
        oracleRead: extra.oracleRead,
        zeroCounts: Object.fromEntries(zeroKeys.map((key) => [key, extra.targetRead?.[key]])),
      },
      {
        dayKey: "2026-07-13",
        marker: { day_key: "2026-07-13", ...expectedBounds },
        oracleMarker: { day_key: "2026-07-13", ...expectedBounds },
        expectedBounds,
        targetRead: extra.oracleRead,
        oracleRead: extra.oracleRead,
        zeroCounts: Object.fromEntries(zeroKeys.map((key) => [key, 0])),
      },
      "extra local marker is not a correctly bounded, built-empty new-TZ day",
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
