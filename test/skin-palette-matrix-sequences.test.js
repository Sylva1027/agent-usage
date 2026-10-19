import assert from "node:assert/strict";
import test from "node:test";

import { buildMatrixCaptureSequences } from "../scripts/skin-palette/capture.mjs";

const baseline = { id: "baseline", kind: "baseline" };
const defaults = { fixtureHash: "base-hash", previewUrl: "http://base.test" };

test("S0-only without fixture bindings builds one default base sequence", () => {
  assert.deepEqual(buildMatrixCaptureSequences({ units: [baseline], wantBaseline: true, ...defaults }), [
    { viewport: undefined, units: [], fixtureKind: "base", fixtureHash: "base-hash", previewUrl: "http://base.test" },
  ]);
});

test("S0 with an ordinary default group reuses its base sequence", () => {
  const unit = { id: "preset-selected", kind: "catalog", group: "S1" };
  const sequences = buildMatrixCaptureSequences({ units: [baseline, unit], wantBaseline: true, ...defaults });
  assert.equal(sequences.length, 1);
  assert.equal(sequences[0].fixtureKind, "base");
  assert.equal(sequences[0].viewport, undefined);
  assert.deepEqual(sequences[0].units, [unit]);
});

test("S0 with only a custom viewport prepends the default base sequence", () => {
  const viewport = { width: 1440, height: 900 };
  const unit = { id: "desktop-wide", kind: "catalog", group: "D", viewport };
  const sequences = buildMatrixCaptureSequences({ units: [baseline, unit], wantBaseline: true, ...defaults });
  assert.equal(sequences.length, 2);
  assert.deepEqual(sequences[0], {
    viewport: undefined,
    units: [],
    fixtureKind: "base",
    fixtureHash: "base-hash",
    previewUrl: "http://base.test",
  });
  assert.deepEqual(sequences[1], {
    viewport,
    units: [unit],
    fixtureKind: "base",
    fixtureHash: "base-hash",
    previewUrl: "http://base.test",
  });
});

test("without S0, no empty default sequence is added", () => {
  assert.deepEqual(buildMatrixCaptureSequences({ units: [], wantBaseline: false, ...defaults }), []);
  const unit = { id: "preset-selected", kind: "catalog", group: "S1" };
  const sequences = buildMatrixCaptureSequences({ units: [unit], wantBaseline: false, ...defaults });
  assert.equal(sequences.length, 1);
  assert.deepEqual(sequences[0].units, [unit]);
});

test("dual-fixture groups remain split between base and warning previews", () => {
  const baseUnit = { id: "base-state", kind: "catalog", group: "S1" };
  const warningUnit = { id: "warning-state", kind: "catalog", group: "S9" };
  const sequences = buildMatrixCaptureSequences({
    units: [baseline, baseUnit, warningUnit],
    wantBaseline: true,
    fixtureBindings: {
      S1: { fixtureKind: "base", fixtureHash: "base-hash" },
      S9: { fixtureKind: "timeline-range-warning", fixtureHash: "warning-hash" },
    },
    fixtureHash: "base-hash",
    previewUrl: "http://base.test",
    warningPreviewUrl: "http://warning.test",
  });
  assert.equal(sequences.length, 2);
  assert.equal(sequences[0].fixtureKind, "base");
  assert.equal(sequences[0].previewUrl, "http://base.test");
  assert.deepEqual(sequences[0].units, [baseUnit]);
  assert.equal(sequences[1].fixtureKind, "timeline-range-warning");
  assert.equal(sequences[1].previewUrl, "http://warning.test");
  assert.deepEqual(sequences[1].units, [warningUnit]);
});
