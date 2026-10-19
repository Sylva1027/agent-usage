import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { SOURCE_FILES } from "../scripts/skin-palette/capture.mjs";
import { hashCandidate, sha256Canonical } from "../scripts/skin-palette/contracts.mjs";
import { createReviewFocusSupplement } from "../scripts/skin-palette/review-focus-supplement.mjs";

const METHOD = "browser-focus-outline-adjacent-pixels";
const SELECTOR = "#addImportButton";
const MANIFEST_PATH = "supplements/kimi/manifest.json";
const RAW_FILE = "measurement/raw/adjacent-focused.png";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function clone(value) {
  return structuredClone(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function zeroSpotlight() {
  return {
    scroll: { x: 0, y: 0 },
    documentCount: 0,
    shellCount: 0,
    hosts: [],
  };
}

function probe() {
  return {
    identity: { count: 1, sameNode: true, connected: true },
    active: true,
    focusVisible: true,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    spotlightCount: 0,
  };
}

function makeFixture() {
  const policyHash = "b".repeat(64);
  const fixtureHash = "c".repeat(64);
  const candidateSetHash = "d".repeat(64);
  const candidate = {
    id: "kimi-b-review-focus",
    policyHash,
    profileHash: "e".repeat(64),
    profileSnapshot: { version: 2, name: "review-focus" },
    profileVersion: 2,
    skinId: "kimi",
    variant: "b",
    modes: { light: {} },
  };
  candidate.candidateHash = hashCandidate(candidate);

  const sourceHashes = Object.fromEntries(
    SOURCE_FILES.map((sourcePath, index) => [sourcePath, index.toString(16).padStart(64, "0")]),
  );
  const sourceHashSet = sha256Canonical(sourceHashes);
  const sourceRun = "docs/validation/source-run";
  const clip = { x: 0, y: 0, width: 1, height: 1 };
  const analysis = {
    result: "pass",
    ratio: 4.5,
    threshold: 3,
    reason: "adjacent-background-pass",
    corePixelCount: 1,
    backgroundPixelCount: 1,
    diagnostics: {
      clip: {
        complete: true,
        requiredBounds: { left: 0, top: 0, right: 1, bottom: 1 },
      },
      backgroundAlpha: { nonOpaquePixels: 0 },
      coreOutlineColor: { mismatchPixels: 0 },
      missingCoreRegions: [],
      missingBackgroundRegions: [],
      reasons: [],
    },
  };
  const captures = {
    clip,
    rawFrameCount: 1,
    rawFrames: [
      {
        key: "focused",
        kind: "focus-outline-adjacent-focused",
        file: RAW_FILE,
        bytes: PNG.length,
        sha256: sha256(PNG),
        clip,
      },
    ],
    returnedBufferKeys: ["focused"],
    threeFrameSetProduced: false,
  };
  const diagnostics = {
    selector: SELECTOR,
    mutated: false,
    probes: {
      before: probe(),
      afterFocused: probe(),
      afterDecode: probe(),
    },
    decoded: { width: 1, height: 1 },
  };
  const measurement = { method: METHOD, selector: SELECTOR, analysis, captures, diagnostics };
  const bindingContent = {
    sourceRun,
    candidateSetHash,
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    policyHash,
    fixtureHash,
    sourceHashCount: SOURCE_FILES.length,
    sourceHashes,
    sourceHashSet,
  };
  const manifest = {
    schemaVersion: 1,
    kind: "skin-palette-m57-kimi-focus-targeted-validation",
    status: "complete",
    complete: true,
    matrixComplete: false,
    ready: false,
    scope: {
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      skinId: candidate.skinId,
      variant: candidate.variant,
      mode: "light",
      group: "S1",
      stateId: "keyboard-focus",
      roleId: "focus.outline",
      selector: SELECTOR,
      roleCount: 1,
    },
    source: {
      runDir: sourceRun,
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      candidateSetHash,
      candidateProfileSnapshotVersion: 2,
    },
    binding: {
      ...bindingContent,
      bindingHash: sha256Canonical(bindingContent),
    },
    fixture: {
      expectedHash: fixtureHash,
      actualHash: fixtureHash,
      verified: true,
    },
    preparation: {
      pointer: { spotlightAfterPointerLeave: zeroSpotlight() },
      focus: {
        step: {
          action: "focus",
          selector: SELECTOR,
          focusStrategy: "tab",
          tabbableCount: 88,
          focusPresses: 77,
          ok: true,
        },
        spotlightAfterFocus: zeroSpotlight(),
      },
      scroll: { spotlightAfterScroll: zeroSpotlight() },
    },
    measurement,
    outcome: {
      result: analysis.result,
      ratio: analysis.ratio,
      threshold: analysis.threshold,
      reason: analysis.reason,
      rawFrameCount: 1,
    },
    errors: {
      pageErrors: [],
      consoleErrors: [],
      requestFailed: [],
      resourceFailures: [],
      blockedExternal: [],
    },
    fatalError: null,
  };
  const originalEvidence = JSON.stringify({
    kind: METHOD,
    selector: SELECTOR,
    captures: { focused: null },
    analysis: {
      result: "unmeasured",
      ratio: null,
      threshold: 3,
      reason: "spotlight-active",
    },
  });
  const originalRecord = {
    candidateId: candidate.id,
    mode: "light",
    roleId: "focus.outline",
    stateId: "keyboard-focus",
    result: "unmeasured",
    ratio: null,
    threshold: 3,
    method: METHOD,
    evidence: originalEvidence,
    reason: "spotlight-active",
  };
  const files = new Map();
  const registration = {
    manifestPath: MANIFEST_PATH,
    manifestSha256: "",
    originalRecord,
  };
  const args = {
    registration,
    readContainedBytes: async (relativePath) => files.get(relativePath) ?? null,
    candidate,
    candidateSetHash,
    sourceHashes,
    policyHash,
    fixtureHash,
    browserRecords: [clone(originalRecord)],
  };
  const fixture = {
    args,
    files,
    manifest,
    measurement,
    originalRecord,
    rawPath: "supplements/kimi/measurement/raw/adjacent-focused.png",
  };
  persistFixture(fixture);
  return fixture;
}

function persistFixture(fixture, { png = PNG } = {}) {
  const captures = fixture.manifest.measurement.captures;
  const frame = captures.rawFrames[0];
  frame.bytes = png.length;
  frame.sha256 = sha256(png);
  const manifestBytes = jsonBytes(fixture.manifest);
  fixture.files.set(MANIFEST_PATH, manifestBytes);
  fixture.files.set("supplements/kimi/measurement/measurement.json", jsonBytes(fixture.manifest.measurement));
  fixture.files.set("supplements/kimi/measurement/analysis.json", jsonBytes(fixture.manifest.measurement.analysis));
  fixture.files.set("supplements/kimi/measurement/captures.json", jsonBytes(fixture.manifest.measurement.captures));
  fixture.files.set(
    "supplements/kimi/measurement/diagnostics.json",
    jsonBytes(fixture.manifest.measurement.diagnostics),
  );
  fixture.files.set(fixture.rawPath, png);
  fixture.args.registration.manifestSha256 = sha256(manifestBytes);
}

test("trusted focus supplement returns an effective PASS and is idempotent", async () => {
  const fixture = makeFixture();
  const first = await createReviewFocusSupplement(fixture.args);

  assert.equal(first.originalRecord.result, "unmeasured");
  assert.equal(first.effectiveRecord.result, "pass");
  assert.equal(first.effectiveRecord.ratio, 4.5);
  assert.deepEqual(JSON.parse(first.effectiveRecord.evidence), {
    kind: "verified-focus-supplement",
    manifestPath: MANIFEST_PATH,
    manifestSha256: fixture.args.registration.manifestSha256,
    originalEvidence: fixture.originalRecord.evidence,
  });
  assert.equal(first.originalRecord.evidence, fixture.originalRecord.evidence);
  assert.deepEqual(first.diagnostic.originalRecord, fixture.originalRecord);
  assert.deepEqual(first.diagnostic.effectiveRecord, first.effectiveRecord);
  assert.equal(first.diagnostic.manifestPath, MANIFEST_PATH);
  assert.equal(first.diagnostic.manifestSha256, fixture.args.registration.manifestSha256);

  const second = await createReviewFocusSupplement({
    ...fixture.args,
    browserRecords: [clone(first.effectiveRecord)],
  });
  assert.deepEqual(second, first);
});

test("original fail records are rejected", async () => {
  const fixture = makeFixture();
  fixture.args.registration.originalRecord = {
    ...fixture.originalRecord,
    result: "fail",
    ratio: 1,
  };
  await assert.rejects(
    createReviewFocusSupplement(fixture.args),
    /originalRecord must be the expected spotlight-active unmeasured record/,
  );

  const evidenceFixture = makeFixture();
  const evidence = JSON.parse(evidenceFixture.originalRecord.evidence);
  evidence.selector = "#pricingSearch";
  evidenceFixture.args.registration.originalRecord = {
    ...evidenceFixture.originalRecord,
    evidence: JSON.stringify(evidence),
  };
  await assert.rejects(createReviewFocusSupplement(evidenceFixture.args), /originalRecord.evidence/);
});

test("candidate, source, policy, and candidate-set mismatches are rejected", async () => {
  const candidateFixture = makeFixture();
  candidateFixture.args.candidate = {
    ...candidateFixture.args.candidate,
    id: "kimi-b-other",
  };
  await assert.rejects(createReviewFocusSupplement(candidateFixture.args), /candidate/);

  const sourceFixture = makeFixture();
  const firstSource = Object.keys(sourceFixture.args.sourceHashes)[0];
  sourceFixture.args.sourceHashes[firstSource] = "f".repeat(64);
  await assert.rejects(createReviewFocusSupplement(sourceFixture.args), /manifest binding/);

  const policyFixture = makeFixture();
  policyFixture.args.policyHash = "a".repeat(64);
  await assert.rejects(createReviewFocusSupplement(policyFixture.args), /policy hash/);

  const setFixture = makeFixture();
  setFixture.args.candidateSetHash = "a".repeat(64);
  await assert.rejects(createReviewFocusSupplement(setFixture.args), /manifest source/);
});

test("missing and tampered raw frames are rejected", async () => {
  const missingFixture = makeFixture();
  missingFixture.args.readContainedBytes = async (relativePath) =>
    relativePath === missingFixture.rawPath ? null : (missingFixture.files.get(relativePath) ?? null);
  await assert.rejects(createReviewFocusSupplement(missingFixture.args), /raw frame.*missing/);

  const tamperedFixture = makeFixture();
  const tampered = Buffer.from("not a png");
  persistFixture(tamperedFixture, { png: tampered });
  await assert.rejects(createReviewFocusSupplement(tamperedFixture.args), /PNG signature/);
});

test("path escape attempts and containment-reader rejection are rejected", async () => {
  const pathFixture = makeFixture();
  pathFixture.args.registration.manifestPath = "../manifest.json";
  await assert.rejects(createReviewFocusSupplement(pathFixture.args), /manifestPath/);

  const frameFixture = makeFixture();
  frameFixture.manifest.measurement.captures.rawFrames[0].file = "../escape.png";
  persistFixture(frameFixture);
  await assert.rejects(createReviewFocusSupplement(frameFixture.args), /raw frame file/);

  const readerFixture = makeFixture();
  readerFixture.args.readContainedBytes = async () => {
    throw new Error("containment denied");
  };
  await assert.rejects(createReviewFocusSupplement(readerFixture.args), /containment denied/);
});

test("duplicate targets and records other than the original or effective record are rejected", async () => {
  const duplicateFixture = makeFixture();
  duplicateFixture.args.browserRecords = [
    clone(duplicateFixture.originalRecord),
    clone(duplicateFixture.originalRecord),
  ];
  await assert.rejects(createReviewFocusSupplement(duplicateFixture.args), /exactly one target record/);

  const differentFixture = makeFixture();
  differentFixture.args.browserRecords = [
    {
      ...differentFixture.originalRecord,
      result: "pass",
      ratio: 5,
      reason: "adjacent-background-pass",
    },
  ];
  await assert.rejects(
    createReviewFocusSupplement(differentFixture.args),
    /original U or its identical effective PASS/,
  );
});
