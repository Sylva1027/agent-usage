import assert from "node:assert/strict";
import test from "node:test";
import { nativeAppendEvidence } from "./q6-performance-run.mjs";
import { directionGate, stats } from "./q6-performance-analyze.mjs";

test("native complete reparsing is recorded separately from a native append", () => {
  const kind = "fixture-native";
  const capture = { label: "proof.capture", proofKind: kind, readBytes: 0 };
  const verify = { label: "proof.verify", proofKind: kind, readBytes: 0 };
  const append = { proofKind: kind, proofs: [verify, capture], syncs: [] };
  assert.deepEqual(nativeAppendEvidence(append, kind), { nativeAppend: true, nativeReparse: false });
  assert.deepEqual(nativeAppendEvidence({ ...append, proofs: [capture], syncs: [{ sourceWork: { replacedFiles: 1 } }] }, kind),
    { nativeAppend: false, nativeReparse: true });
  assert.deepEqual(nativeAppendEvidence({ ...append, proofKind: "sha256-prefix-v2" }, kind),
    { nativeAppend: false, nativeReparse: false });
});

test("direction gate excludes incorrect values and stops without expanding a fallback-dominated matrix", () => {
  const valid = { responseStatus: 200, responseTotal: 10, expectedTotal: 10, automaticSseObserved: true, actualPaintMs: 1500, fullFallback: true };
  assert.equal(directionGate([valid, valid, { ...valid, responseTotal: 9, fullFallback: false }]).stop, true);
  assert.equal(directionGate([{ ...valid, fullFallback: false }, valid]).stop, false);
  assert.equal(directionGate([]).stop, false);
  assert.deepEqual(stats([2, 4]), { n: 2, min: 2, median: 3, max: 4 });
});
