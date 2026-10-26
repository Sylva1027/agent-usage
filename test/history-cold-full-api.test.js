import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageServer } from "../src/server.js";
import { buildUsageReport } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-12T02:01:00.000Z";
const COLD_MS = Date.parse(COLD_TIME);
const HOT_MS = Date.parse(HOT_TIME);
const RESETS_AT = Date.parse("2026-07-12T05:00:05.000Z") / 1000;
const SESSION_ID = "cold-full-session";

function tokenLine(timestamp, total, lastTotal, usedPercent) {
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
      rate_limits: {
        limit_id: "codex",
        primary: { window_minutes: 300, resets_at: RESETS_AT, used_percent: usedPercent },
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

function projectSession(session) {
  return {
    id: session.id,
    homeId: session.homeId,
    homeLabel: session.homeLabel,
    homePath: session.homePath,
    firstAt: session.firstAt,
    lastAt: session.lastAt,
    eventCount: session.eventCount,
    total: session.total,
    channel: session.channel,
    cwd: session.cwd,
    model: session.model,
  };
}

async function createArchivedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-full-api-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-full.jsonl");
  const source = sourceOptions(root, codexHome);
  const prefix = sessionPrefix(codexHome);
  const coldLine = tokenLine(COLD_TIME, 100, 100, 31);
  const hotLine = tokenLine(HOT_TIME, 130, 30, 37);
  const fullContents = `${prefix}\n${coldLine}\n${hotLine}\n`;
  const hotOnlyContents = `${prefix}\n${hotLine}\n`;
  const segmentFile = path.join(root, "cold-segment.sqlite");

  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, fullContents);

    const oracleStore = new UsageStore({ ...source, databaseFile: path.join(root, "oracle.sqlite") });
    let oracleReport;
    try {
      await oracleStore.sync({ options: source });
      oracleReport = oracleStore.publishedUsageReport();
    } finally {
      oracleStore.close();
    }

    const databaseFile = path.join(root, "usage-index.sqlite");
    const store = new UsageStore({ ...source, databaseFile, importDirs: [] });
    let registered;
    try {
      await store.sync({ options: source });
      await createHistoryArchiveCandidate(store.database, segmentFile, { startMs: COLD_MS, endMs: HOT_MS });
      registered = await store.registerHistoryArchiveCandidate(segmentFile);
      store.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
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
          .prepare("SELECT total FROM events ORDER BY timestamp_ms")
          .all()
          .map((row) => Number(row.total)),
        [30],
      );
    } finally {
      store.close();
    }

    return {
      root,
      codexHome,
      usageFile,
      segmentFile,
      source,
      hotOnlyContents,
      oracleReport,
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

test("full detail uses authorized cold carrier when a live source is only the hot tail", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    const primed = await fetch(`${baseUrl}/api/summary?preset=all`);
    assert.equal(primed.status, 200);

    writeFileSync(fixture.usageFile, fixture.hotOnlyContents);
    const live = await buildUsageReport(fixture.source);
    assert.deepEqual(
      live.events.map((event) => event.total.total),
      [30],
      "the source-only report must be incomplete before the HTTP carrier is considered",
    );

    const response = await fetch(`${baseUrl}/api/usage?preset=all&detail=full&skipCheck=1`);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);

    assert.equal(existsSync(fixture.usageFile), true);
    assert.deepEqual(body.summary.perf.missingSources, []);
    assert.deepEqual(
      {
        total: body.summary.totals.total,
        eventCount: body.summary.eventCount,
        sessionCount: body.summary.sessionCount,
        homeCount: body.summary.homeCount,
        metadataEvents: body.metadata.eventCount,
      },
      { total: 130, eventCount: 2, sessionCount: 1, homeCount: 1, metadataEvents: 2 },
    );
    assert.deepEqual(body.report.events, fixture.oracleReport.events);
    assert.deepEqual(body.report.sessions.map(projectSession), fixture.oracleReport.sessions.map(projectSession));
    assert.deepEqual(body.report.homes, fixture.oracleReport.homes);
    assert.deepEqual(body.report.rateLimitObservations, fixture.oracleReport.rateLimitObservations);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("full detail fails closed when an authorized cold segment is missing", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    assert.equal((await fetch(`${baseUrl}/api/summary?preset=all`)).status, 200);

    unlinkSync(fixture.segmentFile);
    const response = await fetch(`${baseUrl}/api/usage?preset=all&detail=full&skipCheck=1`);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.code, "ENOENT");
    assert.equal(typeof body.error, "string");
    assert.equal(body.summary, undefined);
    assert.equal(body.report, undefined);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("full detail keeps the published carrier for missing sources without cold authority", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-full-missing-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-missing.jsonl");
  const source = sourceOptions(root, codexHome);
  let server;
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${sessionPrefix(codexHome)}\n${tokenLine(COLD_TIME, 100, 100, 31)}\n`);
    const store = new UsageStore({ ...source, databaseFile: path.join(root, "usage-index.sqlite") });
    try {
      await store.sync({ options: source });
    } finally {
      store.close();
    }
    unlinkSync(usageFile);

    server = createUsageServer({
      ...source,
      databaseFile: path.join(root, "usage-index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/usage?preset=all&detail=full`);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);

    assert.equal(body.summary.totals.total, 100);
    assert.deepEqual(
      body.report.events.map((event) => event.total.total),
      [100],
    );
    assert.deepEqual(
      body.summary.perf.missingSources.map(({ path: missingPath, kind }) => ({ path: missingPath, kind })),
      [{ path: usageFile, kind: "extra" }],
    );
  } finally {
    if (server) await server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
