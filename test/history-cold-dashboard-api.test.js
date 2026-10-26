import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";

const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-12T02:01:00.000Z";
const COLD_MS = Date.parse(COLD_TIME);
const HOT_MS = Date.parse(HOT_TIME);
const SESSION_ID = "cold-dashboard-api-session";

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

function sessionPrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: SESSION_ID, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
  ].join("\n");
}

function sourceOptions(root, codexHome) {
  return {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function keyFields(summary, metadata, periodComparison) {
  return {
    summary: {
      total: summary.totals.total,
      eventCount: summary.eventCount,
      sessionCount: summary.sessionCount,
      homeCount: summary.homeCount,
    },
    metadata: {
      eventCount: metadata.eventCount,
      sessionCount: metadata.sessionCount,
      homeCount: metadata.homeCount,
      modelLastSeen: metadata.modelLastSeen,
    },
    period: {
      all: periodComparison.totals.all.total,
    },
  };
}

async function createArchivedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cold-dashboard-api-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-dashboard.jsonl");
  const source = sourceOptions(root, codexHome);
  const segmentFile = path.join(root, "cold-segment.sqlite");
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${sessionPrefix(codexHome)}\n${tokenLine(COLD_TIME, 100, 100)}\n${tokenLine(HOT_TIME, 130, 30)}\n`,
    );

    const oracle = new UsageStore({ ...source, databaseFile: path.join(root, "oracle.sqlite") });
    let oracleKeys;
    try {
      await oracle.sync({ options: source });
      const now = new Date();
      oracleKeys = keyFields(
        oracle.summarize({ preset: "all", bucket: "day", calendarZone: "utc", now }),
        oracle.metadata(now),
        oracle.periodComparison({ now, calendarZone: "utc" }),
      );
    } finally {
      oracle.close();
    }

    const databaseFile = path.join(root, "usage-index.sqlite");
    const store = new UsageStore({ ...source, databaseFile });
    try {
      await store.sync({ options: source });
      await createHistoryArchiveCandidate(store.database, segmentFile, {
        startMs: COLD_MS,
        endMs: HOT_MS,
      });
      const registered = await store.registerHistoryArchiveCandidate(segmentFile);
      store.database
        .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        .run(
          "history_archive_event_authority",
          JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
        );
      store.database.exec("BEGIN IMMEDIATE");
      try {
        store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
        store.database.exec("COMMIT");
      } catch (error) {
        store.database.exec("ROLLBACK");
        throw error;
      }
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options: source });
      assert.deepEqual(
        store.database
          .prepare("SELECT total FROM events")
          .all()
          .map((row) => Number(row.total)),
        [30],
      );
    } finally {
      store.close();
    }

    return {
      root,
      usageFile,
      segmentFile,
      oracleKeys,
      serverOptions: {
        ...source,
        databaseFile,
        importStoreFile: path.join(root, "imports.json"),
        heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
        pricingRefreshSchedulerEnabled: false,
      },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("summary and default usage APIs include cold history while the source remains", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    assert.equal(existsSync(fixture.usageFile), true);

    for (const route of ["/api/summary?preset=all&calendarZone=utc", "/api/usage?preset=all&calendarZone=utc"]) {
      const response = await fetch(`${baseUrl}${route}`);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.deepEqual(keyFields(body.summary, body.metadata, body.periodComparison), fixture.oracleKeys, route);
    }
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("cold-aware dashboard APIs fail closed when the authorized segment is missing", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    unlinkSync(fixture.segmentFile);

    for (const route of ["/api/summary?preset=all&calendarZone=utc", "/api/usage?preset=all&calendarZone=utc"]) {
      const response = await fetch(`${baseUrl}${route}`);
      const body = await response.json();
      assert.equal(response.status, 500, route);
      assert.equal(body.code, "ENOENT", route);
      assert.equal(body.summary, undefined, route);
      assert.equal(body.metadata, undefined, route);
      assert.equal(body.periodComparison, undefined, route);
    }
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});
