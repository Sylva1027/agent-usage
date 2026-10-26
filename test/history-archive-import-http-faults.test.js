import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate, publishHistoryArchiveBundle } from "../src/history-archive.js";
import { createUsageServer as createUsageServerBase } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";

const START_MS = Date.parse("2026-10-02T03:04:05.000Z");
const END_MS = START_MS + 60_000;

function createUsageServer(options = {}) {
  return createUsageServerBase({ pricingRefreshSchedulerEnabled: false, ...options });
}

async function createPublishedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-import-http-faults-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const bundleDirectory = path.join(root, "bundle");
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
        "archive-import-http-faults-thread",
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
    await createHistoryArchiveCandidate(store.database, path.join(root, "candidate.sqlite"), {
      startMs: START_MS,
      endMs: END_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(path.join(root, "candidate.sqlite"));
    store.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
      .run("history_archive_event_authority", JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
    const published = await publishHistoryArchiveBundle(store.database, bundleDirectory);
    store.database.exec("DELETE FROM events");
    return { root, databaseFile, bundleDirectory, published };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  } finally {
    store.close();
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function postImport(baseUrl, sourceDirectory, importDirectory) {
  const response = await fetch(`${baseUrl}/api/history/imports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceDirectory, importDirectory }),
  });
  return { response, body: await response.json() };
}

async function activeSummary(baseUrl) {
  const response = await fetch(`${baseUrl}/api/summary?preset=all&skipCheck=1`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).summary.totals.total;
}

test("HTTP import faults keep the destination incomplete and the active store readable", async () => {
  const fixture = await createPublishedFixture();
  const badManifestImport = path.join(fixture.root, "bad-manifest-import");
  const missingSegmentImport = path.join(fixture.root, "missing-segment-import");
  const server = createUsageServer({
    homeDir: fixture.root,
    databaseFile: fixture.databaseFile,
    importStoreFile: path.join(fixture.root, "imports.json"),
    automaticDiscoveryEnabled: false,
  });
  try {
    const baseUrl = await listen(server);
    const oracle = await activeSummary(baseUrl);
    assert.equal(oracle, 20);
    const manifestFile = path.join(fixture.bundleDirectory, "bundle.manifest.json");

    const badManifestBytes = readFileSync(manifestFile);
    writeFileSync(manifestFile, "{");
    const badManifest = await postImport(baseUrl, fixture.bundleDirectory, badManifestImport);
    assert.equal(badManifest.response.status, 500);
    assert.equal(badManifest.body.code, "HISTORY_ARCHIVE_BUNDLE_MARKER_MISMATCH");
    assert.equal(existsSync(badManifestImport), false);
    assert.equal(await activeSummary(baseUrl), oracle);
    writeFileSync(manifestFile, badManifestBytes);

    unlinkSync(path.join(fixture.bundleDirectory, fixture.published.manifest.segments[0].databaseFile));
    const missingSegment = await postImport(baseUrl, fixture.bundleDirectory, missingSegmentImport);
    assert.equal(missingSegment.response.status, 500);
    assert.equal(missingSegment.body.code, "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND");
    assert.equal(existsSync(missingSegmentImport), false);
    assert.equal(await activeSummary(baseUrl), oracle);
  } finally {
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
