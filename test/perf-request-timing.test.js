import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeRequestTimingEvidence, normalizeRequestTimingEvidence } from "../src/perf-request-timing.js";

const FIXTURE_URL = new URL(
  "../docs/validation/2026-10-21-tps-measurement-correction/A/review/six-turn-request-fixture.json",
  import.meta.url,
);

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceOrigin: "producer-v1",
    responseId: "response-a",
    requestedModel: "model-a",
    reportedOutputTokens: 100,
    durationMs: 1_000,
    status: "completed",
    completedAtMs: null,
    ...overrides,
  };
}

function assertInvalidInput(fn) {
  assert.throws(fn, (error) => error?.code === "REQUEST_TIMING_INVALID_INPUT");
}

test("empty evidence is missing", () => {
  assert.deepEqual(mergeRequestTimingEvidence([]), { state: "missing", evidence: null });
});

test("exact duplicates are available and idempotent", () => {
  const canonical = normalizeRequestTimingEvidence(evidence());

  assert.deepEqual(canonical, evidence());
  assert.deepEqual(mergeRequestTimingEvidence([evidence()]), { state: "available", evidence: canonical });
  assert.deepEqual(mergeRequestTimingEvidence([evidence(), evidence()]), {
    state: "available",
    evidence: canonical,
  });
});

test("strings are validated without trimming the returned value", () => {
  const canonical = normalizeRequestTimingEvidence(
    evidence({ evidenceOrigin: " producer-v1 ", responseId: " response-a ", requestedModel: " model-a " }),
  );

  assert.equal(canonical.evidenceOrigin, " producer-v1 ");
  assert.equal(canonical.responseId, " response-a ");
  assert.equal(canonical.requestedModel, " model-a ");
});

test("an unknown origin is shape-valid but remains unauthenticated", () => {
  const raw = evidence({ evidenceOrigin: "unknown-producer" });

  assert.deepEqual(mergeRequestTimingEvidence([raw]), {
    state: "available",
    evidence: raw,
  });
});

test("any differing normative field is a conflict", () => {
  const variants = [
    { evidenceOrigin: "producer-v2" },
    { responseId: "response-b" },
    { requestedModel: "model-b" },
    { reportedOutputTokens: 101 },
    { durationMs: 1_001 },
    { completedAtMs: 1_800_000_000_000 },
  ];

  for (const variant of variants) {
    assert.deepEqual(mergeRequestTimingEvidence([evidence(), evidence(variant)]), {
      state: "conflict",
      evidence: null,
    });
  }
  assert.deepEqual(mergeRequestTimingEvidence([evidence({ completedAtMs: 1_800_000_000_000 }), evidence()]), {
    state: "conflict",
    evidence: null,
  });
});

test("identical fields from different origins are a conflict", () => {
  assert.deepEqual(
    mergeRequestTimingEvidence([
      evidence({ evidenceOrigin: "producer-a" }),
      evidence({ evidenceOrigin: "producer-b" }),
    ]),
    { state: "conflict", evidence: null },
  );
});

test("merge order does not affect the result", () => {
  const first = evidence();
  const second = evidence({ durationMs: 2_000 });

  assert.deepEqual(mergeRequestTimingEvidence([first, second]), mergeRequestTimingEvidence([second, first]));
  assert.deepEqual(
    mergeRequestTimingEvidence([first, first, second]),
    mergeRequestTimingEvidence([second, first, first]),
  );
});

test("normalization rejects malformed evidence with one stable code", () => {
  const invalidRecords = [
    null,
    [],
    evidence({ schemaVersion: 2 }),
    evidence({ evidenceOrigin: "" }),
    evidence({ evidenceOrigin: "   " }),
    evidence({ evidenceOrigin: 1 }),
    evidence({ responseId: "" }),
    evidence({ responseId: null }),
    evidence({ requestedModel: " " }),
    evidence({ requestedModel: 1 }),
    evidence({ reportedOutputTokens: -1 }),
    evidence({ reportedOutputTokens: 1.5 }),
    evidence({ reportedOutputTokens: Number.MAX_SAFE_INTEGER + 1 }),
    evidence({ durationMs: 0 }),
    evidence({ durationMs: -1 }),
    evidence({ durationMs: 1.5 }),
    evidence({ durationMs: Number.MAX_SAFE_INTEGER + 1 }),
    evidence({ status: "failed" }),
    evidence({ completedAtMs: undefined }),
    evidence({ completedAtMs: -1 }),
    evidence({ completedAtMs: 1.5 }),
    evidence({ completedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
  ];

  for (const record of invalidRecords) assertInvalidInput(() => normalizeRequestTimingEvidence(record));
  assertInvalidInput(() => mergeRequestTimingEvidence(null));
  assertInvalidInput(() => mergeRequestTimingEvidence([evidence(), evidence({ durationMs: 0 })]));
});

test("the six-turn fixture normalizes to all 326 idempotent evidence records", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const evidenceOrigin = `magpie@${fixture.evidenceOrigin.version}:${fixture.evidenceOrigin.sourceCommit}`;
  const records = fixture.turns.flatMap((turn) =>
    turn.requests.map((request) =>
      normalizeRequestTimingEvidence({
        schemaVersion: 1,
        evidenceOrigin,
        responseId: request.id,
        requestedModel: fixture.requestedModel,
        reportedOutputTokens: request.outputTokens,
        durationMs: request.durationMs,
        status: request.status,
        completedAtMs: null,
      }),
    ),
  );
  const outputTokens = records.reduce((sum, record) => sum + record.reportedOutputTokens, 0);
  const durationMs = records.reduce((sum, record) => sum + record.durationMs, 0);

  assert.equal(records.length, 326);
  assert.equal(outputTokens, 233_379);
  assert.equal(durationMs, 1_742_789);
  for (const record of records) {
    assert.deepEqual(mergeRequestTimingEvidence([record, record]), {
      state: "available",
      evidence: record,
    });
  }
});
