import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { decodePerfSample, PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

test("readHistoryArchivePerfSamples returns only the verified cold segment's perf rows", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-reader.sqlite"),
  };
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-reader-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let expected;
    let hotSampleCount;
    try {
      expected = candidate
        .prepare(
          `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples
           WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
        )
        .all(coldStartMs, HOT_START_MS)
        .map(decodePerfSample);
      hotSampleCount = Number(
        candidate.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ?").get(HOT_START_MS).count,
      );
    } finally {
      candidate.close();
    }
    assert.ok(expected.length > 0, "fixture must put perf samples in the cold segment");
    assert.ok(hotSampleCount > 0, "candidate must contain hot perf rows that the reader has to exclude");

    const digestBefore = fileSha256(candidateFile);
    const actual = await store.readHistoryArchivePerfSamples(registered.segmentId);
    assert.deepEqual(actual, expected);
    assert.ok(actual.every((sample) => sample.tsMs >= coldStartMs && sample.tsMs < HOT_START_MS));
    assert.equal(fileSha256(candidateFile), digestBefore, "cold perf reads must not modify the candidate");

    const missingFile = `${candidateFile}.missing`;
    renameSync(candidateFile, missingFile);
    try {
      await assert.rejects(
        store.readHistoryArchivePerfSamples(registered.segmentId),
        (error) => error.code === "ENOENT",
        "registered cold perf segment must reject when its database file is missing",
      );
    } finally {
      renameSync(missingFile, candidateFile);
    }
    assert.deepEqual(
      await store.readHistoryArchivePerfSamples(registered.segmentId),
      expected,
      "restoring the same candidate must restore the same decoded perf rows",
    );
    assert.equal(fileSha256(candidateFile), digestBefore, "missing/recovery checks must not modify the candidate");

    await assert.rejects(
      store.readHistoryArchivePerfSamples("0".repeat(64)),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
