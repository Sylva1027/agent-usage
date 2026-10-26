import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  publishHistoryArchiveBundle,
  loadHistoryArchiveImport,
} from "../src/history-archive.js";
import { createUsageServer as createUsageServerBase } from "../src/server.js";
import { readHistoryArchiveStatus } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const START_MS = Date.parse("2026-10-02T03:04:05.000Z");
const END_MS = START_MS + 60_000;

function createUsageServer(options = {}) {
  return createUsageServerBase({ pricingRefreshSchedulerEnabled: false, ...options });
}

async function createArchiveFixture(eventCount = 1) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-archive-api-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const segmentFile = path.join(root, "segment.sqlite");
  const store = new UsageStore({ homeDir: root, databaseFile, importDirs: [] });
  try {
    await store.open();
    const sourcePath = path.join(root, "source.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-10-02T03:05:00.000Z");
    store.database
      .prepare(
        `INSERT INTO events (
          source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
          hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourcePath,
        START_MS,
        "archive-api-thread",
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
    const eventColumns = store.database
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((row) => String(row.name))
      .filter((name) => name !== "id");
    for (let index = 1; index < eventCount; index++) {
      store.database.exec(
        `INSERT INTO events (${eventColumns.join(",")}) SELECT ${eventColumns.join(",")} FROM events WHERE id = 1`,
      );
    }
    await createHistoryArchiveCandidate(store.database, segmentFile, { startMs: START_MS, endMs: END_MS });
    const registered = await store.registerHistoryArchiveCandidate(segmentFile);
    const authority = { formatVersion: 1, segmentIds: [registered.segmentId] };
    store.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
      .run("history_archive_event_authority", JSON.stringify(authority));
    return { root, databaseFile, segmentFile, registered, authority };
  } finally {
    store.close();
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getArchives(baseUrl) {
  const response = await fetch(`${baseUrl}/api/history/archives`);
  if (response.status !== 200) assert.fail(`${response.status} ${await response.text()}`);
  return response.json();
}

function expectedArchive(fixture, status) {
  return {
    authority: fixture.authority,
    segments: [
      {
        segmentId: fixture.registered.segmentId,
        startMs: fixture.registered.startMs,
        endMs: fixture.registered.endMs,
        eventCount: fixture.registered.eventCount,
        status,
      },
    ],
    counts: { segments: 1, events: fixture.registered.eventCount },
  };
}

function fakeArchiveStore({ records, authorityValue }) {
  const queries = [];
  const database = {
    prepare(sql) {
      queries.push(sql);
      if (/\bevents\b/i.test(sql)) throw new Error("archive status must not query events");
      if (sql.includes("FROM archive_segments")) {
        return { all: () => records };
      }
      if (sql.includes("FROM store_meta")) {
        return {
          get: () => (authorityValue === undefined ? undefined : { value: authorityValue }),
        };
      }
      throw new Error(`unexpected archive-status query: ${sql}`);
    },
  };
  let syncCalls = 0;
  return {
    queries,
    store: {
      open: async () => {},
      database,
      sync: async () => {
        syncCalls += 1;
        throw new Error("archive status must not sync");
      },
    },
    syncCalls: () => syncCalls,
  };
}

test("archive status lists registered metadata and point-in-time file state", async () => {
  const fixture = await createArchiveFixture();
  const server = createUsageServer({
    homeDir: fixture.root,
    databaseFile: fixture.databaseFile,
    importStoreFile: path.join(fixture.root, "imports.json"),
    automaticDiscoveryEnabled: false,
  });
  try {
    const baseUrl = await listen(server);
    const present = await getArchives(baseUrl);
    assert.deepEqual(present, expectedArchive(fixture, "present"));
    assert.equal(JSON.stringify(present).includes(fixture.root), false);

    const methodResponse = await fetch(`${baseUrl}/api/history/archives`, { method: "POST" });
    assert.equal(methodResponse.status, 405);
    assert.deepEqual(await methodResponse.json(), {
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed",
    });

    unlinkSync(fixture.segmentFile);
    assert.deepEqual(await getArchives(baseUrl), expectedArchive(fixture, "missing"));

    mkdirSync(fixture.segmentFile);
    assert.deepEqual(await getArchives(baseUrl), expectedArchive(fixture, "unreadable"));
  } finally {
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("archive status queries only registry and authority and never syncs", async () => {
  const segmentId = "a".repeat(64);
  const fake = fakeArchiveStore({
    records: [
      {
        segment_id: segmentId,
        database_path: path.join(os.tmpdir(), `missing-archive-${segmentId}.sqlite`),
        start_ms: START_MS,
        end_ms: END_MS,
        event_count: 3,
      },
    ],
    authorityValue: JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }),
  });

  assert.deepEqual(await readHistoryArchiveStatus(fake.store), {
    authority: { formatVersion: 1, segmentIds: [segmentId] },
    segments: [
      {
        segmentId,
        startMs: START_MS,
        endMs: END_MS,
        eventCount: 3,
        status: "missing",
      },
    ],
    counts: { segments: 1, events: 3 },
  });
  assert.equal(fake.queries.length, 2);
  assert.equal(
    fake.queries.some((sql) => /\bevents\b/i.test(sql)),
    false,
  );
  assert.equal(fake.syncCalls(), 0);

  const empty = fakeArchiveStore({ records: [] });
  assert.deepEqual(await readHistoryArchiveStatus(empty.store), {
    authority: null,
    segments: [],
    counts: { segments: 0, events: 0 },
  });
});

test("archive status uses the requested usage snapshot after the live segment disappears", async () => {
  const fixture = await createArchiveFixture();
  const seed = new UsageStore({ homeDir: fixture.root, databaseFile: fixture.databaseFile });
  await seed.open();
  seed.database.exec("DELETE FROM events");
  seed.close();
  const server = createUsageServer({
    homeDir: fixture.root,
    databaseFile: fixture.databaseFile,
    importStoreFile: path.join(fixture.root, "imports.json"),
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
  });
  try {
    const baseUrl = await listen(server);
    const freeze = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`);
    assert.equal(freeze.status, 200, await freeze.clone().text());
    const { snapshotId } = await freeze.json();
    assert.ok(snapshotId);
    unlinkSync(fixture.segmentFile);
    assert.deepEqual(await getArchives(baseUrl), expectedArchive(fixture, "missing"));
    const frozen = await fetch(`${baseUrl}/api/history/archives?snapshot=${encodeURIComponent(snapshotId)}`);
    assert.equal(frozen.status, 200);
    assert.deepEqual(await frozen.json(), expectedArchive(fixture, "present"));
    const expired = await fetch(`${baseUrl}/api/history/archives?snapshot=unknown`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, "SNAPSHOT_EXPIRED");
  } finally {
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("archive status exposes stable authority and registry failure codes", async () => {
  const segmentId = "b".repeat(64);
  const invalidAuthority = fakeArchiveStore({
    records: [
      {
        segment_id: segmentId,
        database_path: path.join(os.tmpdir(), "unused-archive.sqlite"),
        start_ms: START_MS,
        end_ms: END_MS,
        event_count: 1,
      },
    ],
    authorityValue: JSON.stringify({ formatVersion: 2, segmentIds: [segmentId] }),
  });
  await assert.rejects(
    readHistoryArchiveStatus(invalidAuthority.store),
    (error) => error.code === "HISTORY_ARCHIVE_AUTHORITY_INVALID",
  );

  const unavailable = fakeArchiveStore({ records: [] });
  unavailable.store.database.prepare = () => {
    throw new Error("archive_segments is missing");
  };
  await assert.rejects(
    readHistoryArchiveStatus(unavailable.store),
    (error) => error.code === "HISTORY_ARCHIVES_UNAVAILABLE",
  );
});

test("sealed archive days use the requested snapshot and fail on a missing live segment", async () => {
  const fixture = await createArchiveFixture();
  const seed = new UsageStore({ homeDir: fixture.root, databaseFile: fixture.databaseFile });
  await seed.open();
  seed.database.exec("DELETE FROM events");
  seed.close();
  const server = createUsageServer({
    homeDir: fixture.root,
    databaseFile: fixture.databaseFile,
    importStoreFile: path.join(fixture.root, "imports.json"),
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
  });
  try {
    const baseUrl = await listen(server);
    const endpoint = `${baseUrl}/api/history/archives/${encodeURIComponent(fixture.registered.segmentId)}/days`;
    const expected = {
      segmentId: fixture.registered.segmentId,
      calendarZone: "utc",
      view: "sealed",
      days: [
        { day: "2026-10-02", eventCount: 1, totals: { total: 20, input: 18, cached: 0, output: 2, reasoning: 0 } },
      ],
    };
    const live = await fetch(endpoint);
    assert.equal(live.status, 200, await live.clone().text());
    assert.deepEqual(await live.json(), expected);
    const freeze = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`);
    assert.equal(freeze.status, 200, await freeze.clone().text());
    const { snapshotId } = await freeze.json();
    assert.ok(snapshotId);
    unlinkSync(fixture.segmentFile);
    const missing = await fetch(endpoint);
    assert.equal(missing.status, 500);
    assert.equal((await missing.json()).code, "ENOENT");
    const frozen = await fetch(`${endpoint}?snapshot=${encodeURIComponent(snapshotId)}`);
    assert.equal(frozen.status, 200, await frozen.clone().text());
    assert.deepEqual(await frozen.json(), expected);
    const unknown = await fetch(`${baseUrl}/api/history/archives/unknown/days`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND");
    const expired = await fetch(`${endpoint}?snapshot=unknown`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, "SNAPSHOT_EXPIRED");
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 405);
  } finally {
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("complete bundle HTTP import creates an independent runtime without replacing the active store", async () => {
  const fixture = await createArchiveFixture();
  const bundleDirectory = path.join(fixture.root, "bundle");
  const importDirectory = path.join(fixture.root, "imported");
  const source = new UsageStore({ homeDir: fixture.root, databaseFile: fixture.databaseFile, importDirs: [] });
  await source.open();
  try {
    source.database.exec("DELETE FROM events");
    await publishHistoryArchiveBundle(source.database, bundleDirectory);
  } finally {
    source.close();
  }
  const server = createUsageServer({
    homeDir: fixture.root,
    databaseFile: fixture.databaseFile,
    importStoreFile: path.join(fixture.root, "imports.json"),
    automaticDiscoveryEnabled: false,
  });
  let runtime;
  let importedServer;
  try {
    const baseUrl = await listen(server);
    const endpoint = `${baseUrl}/api/history/imports`;
    const post = (body) =>
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await fetch(endpoint)).status, 405);
    assert.equal((await post({ sourceDirectory: bundleDirectory, importDirectory: "" })).status, 400);
    const before = await getArchives(baseUrl);
    const response = await post({ sourceDirectory: bundleDirectory, importDirectory });
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json();
    const loaded = await loadHistoryArchiveImport(importDirectory);
    assert.equal(result.runtimeFile, loaded.runtimeFile);
    assert.deepEqual(await getArchives(baseUrl), before, "import must not adopt or overwrite the active store");
    const conflict = await post({ sourceDirectory: bundleDirectory, importDirectory });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS");
    unlinkSync(fixture.segmentFile);
    runtime = new UsageStore({
      homeDir: fixture.root,
      databaseFile: loaded.runtimeFile,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
    });
    await runtime.open();
    const events = await runtime.publishedHistoryUsageEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].total.total, 20, "imported runtime must read cold facts with the original segment gone");
    assert.equal((await loadHistoryArchiveImport(importDirectory)).runtimeFile, loaded.runtimeFile);
    runtime.close();
    runtime = undefined;
    importedServer = createUsageServer({
      homeDir: fixture.root,
      databaseFile: loaded.runtimeFile,
      env: {},
      importStoreFile: path.join(fixture.root, "independent-imports.json"),
      automaticDiscoveryEnabled: false,
    });
    const importedUrl = await listen(importedServer);
    const importedResponse = await fetch(`${importedUrl}/api/summary?preset=all&skipCheck=1`);
    assert.equal(importedResponse.status, 200, await importedResponse.clone().text());
    const importedBody = await importedResponse.json();
    assert.equal(importedBody.summary.totals.total, 20);
  } finally {
    runtime?.close();
    await importedServer?.close();
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("sealed event HTTP pages keep stable IDs and a frozen reader after live segment removal", async () => {
  const fixture = await createArchiveFixture(3);
  const seed = new UsageStore({ homeDir: fixture.root, databaseFile: fixture.databaseFile, importDirs: [] });
  await seed.open();
  seed.database.exec("DELETE FROM events");
  seed.close();
  const server = createUsageServer({
    homeDir: fixture.root,
    databaseFile: fixture.databaseFile,
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
    importStoreFile: path.join(fixture.root, "imports.json"),
  });
  try {
    const base = await listen(server);
    const endpoint = `${base}/api/history/archives/${encodeURIComponent(fixture.registered.segmentId)}/events`;
    const query = `?startMs=${START_MS}&endMs=${END_MS}&limit=2`;
    const first = await fetch(endpoint + query);
    assert.equal(first.status, 200, await first.clone().text());
    const page = await first.json();
    assert.equal(page.view, "sealed");
    assert.deepEqual(
      page.events.map((row) => row.id),
      [1, 2],
    );
    assert.equal(page.nextAfterId, 2);
    const second = await fetch(`${endpoint + query}&afterId=${page.nextAfterId}`);
    assert.equal(second.status, 200);
    const last = await second.json();
    assert.deepEqual(
      last.events.map((row) => row.id),
      [3],
    );
    assert.equal(last.nextAfterId, null);
    assert.equal((await fetch(`${endpoint + query}&limit=0`)).status, 400);
    assert.equal((await fetch(`${endpoint}?startMs=oops&endMs=1`)).status, 400);
    assert.equal((await fetch(`${base}/api/history/archives/unknown/events${query}`)).status, 404);
    assert.equal((await fetch(`${endpoint + query}&snapshot=unknown`)).status, 410);
    const freeze = await fetch(`${base}/api/usage?preset=all&freeze=1`);
    assert.equal(freeze.status, 200, await freeze.clone().text());
    const { snapshotId } = await freeze.json();
    assert.ok(snapshotId);
    unlinkSync(fixture.segmentFile);
    assert.equal((await fetch(endpoint + query)).status, 500);
    const frozen = await fetch(`${endpoint + query}&snapshot=${encodeURIComponent(snapshotId)}`);
    assert.equal(frozen.status, 200, await frozen.clone().text());
    assert.deepEqual(await frozen.json(), page);
  } finally {
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
