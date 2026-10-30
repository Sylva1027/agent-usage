import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HISTORICAL_METHOD_VERSION = "tps-v5";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function decodedSampleAsSourceColumns(sample) {
  return Object.fromEntries(
    PERF_SAMPLE_FIELDS.map((entry) => [
      entry.column,
      entry.kind === "reasonChain" && sample[entry.field] !== null
        ? JSON.stringify(sample[entry.field])
        : sample[entry.field],
    ]),
  );
}

test("cold perf candidate is column-for-column faithful to real ZCode source rows", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-source-candidate.sqlite"),
  };
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-source-candidate-archive.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const sourceRows = store.database
      .prepare(
        `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples
         WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
      )
      .all(coldStartMs, HOT_START_MS)
      .map((row) => ({ ...row }));

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    assert.ok(sourceRows.length > 0, "source SQL must find cold perf samples");
    assert.ok(
      sourceRows.some((row) => row.item_count === null),
      "cold source must include a NULL metric",
    );
    assert.ok(
      sourceRows.some(
        (row) =>
          row.status === "completed" &&
          row.output_tokens === null &&
          row.duration_ms === null &&
          row.timing_kind === "generation" &&
          row.token_scope === "non_reasoning_output" &&
          row.timing_source === "unknown" &&
          row.request_count === 1,
      ),
      "cold source must retain missing-generation candidates without inventing TPS",
    );
    assert.ok(
      sourceRows.some((row) => row.method_version === HISTORICAL_METHOD_VERSION && row.sample_flags !== 0),
      "cold source must include method and non-zero flag evidence",
    );

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateHotCount;
    try {
      candidateHotCount = Number(
        candidate.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ?").get(HOT_START_MS).count,
      );
    } finally {
      candidate.close();
    }
    assert.ok(candidateHotCount > 0, "candidate must contain hot perf rows that the reader has to exclude");

    const digestBefore = fileSha256(candidateFile);
    const actual = await store.readHistoryArchivePerfSamples(registered.segmentId);
    const actualRows = actual.map(decodedSampleAsSourceColumns);

    assert.deepEqual(actualRows, sourceRows, "every cold perf column must match the independent source SQL oracle");
    assert.ok(actual.every((sample) => sample.tsMs >= coldStartMs && sample.tsMs < HOT_START_MS));
    assert.ok(actual.some((sample) => sample.itemCount === null));
    assert.ok(
      actual.some(
        (sample) =>
          sample.outputTokens === null &&
          sample.durationMs === null &&
          sample.timingKind === "generation" &&
          sample.timingSource === "unknown",
      ),
    );
    assert.equal(fileSha256(candidateFile), digestBefore, "cold perf reads must not modify the candidate");
  } finally {
    store.close();
    fixture.close();
  }
});
