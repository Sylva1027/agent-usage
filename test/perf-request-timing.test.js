import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generationMatchesKnownReasoning,
  generationPerfValues,
  mergeRequestTimingEvidence,
  normalizeGenerationTiming,
  normalizeRequestTimingEvidence,
} from "../src/perf-request-timing.js";

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

function generation(overrides = {}) {
  return {
    outputTokens: 100,
    durationMs: 500,
    startOutputTokens: 1,
    timingKind: "first_last_output",
    ...overrides,
  };
}

function generatedEvidence(overrides = {}) {
  return evidence({ schemaVersion: 2, generation: generation(), ...overrides });
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

test("generation timing normalizes and exposes only its net output and duration", () => {
  const timing = generation();

  assert.deepEqual(normalizeGenerationTiming(timing), timing);
  assert.deepEqual(generationPerfValues(timing), { outputTokens: 99, durationMs: 500 });
  assert.equal(generationPerfValues(null), null);
  assert.equal(generationPerfValues(generation({ outputTokens: 1, startOutputTokens: 1 })), null);
  assert.deepEqual(
    normalizeGenerationTiming(generation({ timingKind: "first_output_response_end" })),
    generation({ timingKind: "first_output_response_end" }),
  );
  assert.deepEqual(
    normalizeGenerationTiming(generation({ timingKind: "explicit", startOutputTokens: 0 })),
    generation({ timingKind: "explicit", startOutputTokens: 0 }),
  );
});

test("known reasoning reconciles generation output without narrowing unknown evidence", () => {
  assert.equal(generationMatchesKnownReasoning(generation({ outputTokens: 80 }), 100, 20), true);
  assert.equal(generationMatchesKnownReasoning(generation({ outputTokens: 100 }), 100, 20), false);
  assert.equal(generationMatchesKnownReasoning(generation({ outputTokens: 100 }), 100, null), true);
  assert.equal(generationMatchesKnownReasoning(generation({ outputTokens: 100 }), 100, undefined), true);
  assert.equal(generationMatchesKnownReasoning(null, 100, 20), true);
});

test("schema v1 remains unchanged while v2 carries a nullable generation object", () => {
  const v1 = normalizeRequestTimingEvidence(evidence());
  const v2Null = normalizeRequestTimingEvidence(evidence({ schemaVersion: 2, generation: null }));
  const v2 = normalizeRequestTimingEvidence(generatedEvidence());

  assert.equal(Object.hasOwn(v1, "generation"), false);
  assert.deepEqual(v2Null, evidence({ schemaVersion: 2, generation: null }));
  assert.deepEqual(v2, generatedEvidence());
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

test("true identity and count differences remain conflicts", () => {
  const variants = [
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

test("different origins and newly filled generation fields are compatible", () => {
  const older = evidence({ evidenceOrigin: "producer-a" });
  const completed = generatedEvidence({ evidenceOrigin: "producer-b" });

  assert.deepEqual(mergeRequestTimingEvidence([older, completed]), { state: "available", evidence: completed });
});

test("a complete first-last window replaces a response-end approximation", () => {
  const approximate = generatedEvidence({
    generation: generation({ durationMs: 900, timingKind: "first_output_response_end" }),
  });
  const explicit = generatedEvidence({
    generation: generation({ durationMs: 700, timingKind: "explicit" }),
  });
  const complete = generatedEvidence({
    evidenceOrigin: "producer-b",
    generation: generation({ durationMs: 500, timingKind: "first_last_output" }),
  });

  assert.deepEqual(mergeRequestTimingEvidence([approximate, complete]), {
    state: "available",
    evidence: complete,
  });
  assert.deepEqual(mergeRequestTimingEvidence([complete, approximate]), {
    state: "available",
    evidence: complete,
  });
  assert.deepEqual(mergeRequestTimingEvidence([approximate, explicit]), {
    state: "available",
    evidence: explicit,
  });
  assert.deepEqual(mergeRequestTimingEvidence([explicit, approximate]), {
    state: "available",
    evidence: explicit,
  });
});

test("progressive v1 and v2 records compare every same-origin window type", () => {
  const older = evidence();
  const approximate = generatedEvidence({
    generation: generation({ durationMs: 900, timingKind: "first_output_response_end" }),
  });
  const complete = generatedEvidence();

  assert.deepEqual(mergeRequestTimingEvidence([older, approximate, complete]), {
    state: "available",
    evidence: complete,
  });
  assert.deepEqual(
    mergeRequestTimingEvidence([
      older,
      generatedEvidence({ generation: generation({ durationMs: 500 }) }),
      generatedEvidence({ generation: generation({ durationMs: 600 }) }),
    ]),
    { state: "conflict", evidence: null },
  );
});

test("conflicting non-reasoning generation counts are a real conflict", () => {
  assert.deepEqual(
    mergeRequestTimingEvidence([
      generatedEvidence(),
      generatedEvidence({
        evidenceOrigin: "producer-b",
        generation: generation({ outputTokens: 99 }),
      }),
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
    evidence({ schemaVersion: 3 }),
    evidence({ generation: null }),
    evidence({ schemaVersion: 2, generation: generation({ outputTokens: 101 }) }),
    evidence({ schemaVersion: 2, generation: generation({ durationMs: 1_001 }) }),
    evidence({ schemaVersion: 2, generation: generation({ startOutputTokens: 101 }) }),
    evidence({ schemaVersion: 2, generation: generation({ durationMs: 0 }) }),
    evidence({ schemaVersion: 2, generation: generation({ timingKind: "unknown" }) }),
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
