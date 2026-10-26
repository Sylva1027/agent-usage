import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { REPO_ROOT } from "../scripts/skin-palette/review-evidence.mjs";
import * as contracts from "../scripts/skin-palette/contracts.mjs";
import {
  assertFixedMatrixFixtureBindings,
  buildFixedMatrixFixtureBindings,
  STATE_MATRIX_GROUPS,
} from "../scripts/skin-palette/capture.mjs";
import {
  classifyProductionCapture,
  classifyReviewCapture,
  inspectReviewCaptureFixtureHeaders,
  readProductionCaptureChecks,
  readReviewCaptureChecks,
  summarizeProductionCapture,
  summarizeReviewCapture,
  writeReviewCaptureIndexShard,
  runReviewCapture as runReviewCaptureImplementation,
} from "../scripts/skin-palette/review-capture.mjs";
import { APPROXIMATE_METHOD_SUFFIX } from "../scripts/skin-palette/assess.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import { OFFICIAL_CANDIDATE_ID } from "../scripts/skin-palette/browser-measure.mjs";
import { PALETTE_TOKEN_KEYS } from "../public/skins.js";
import { getPaletteFixtureHash, getTimelineWarningFixtureHash } from "../test-support/skin-palette-fixture.mjs";
import { writeFixtureStateUnit } from "../test-support/skin-palette-review-evidence-fixture.mjs";

const validationRoot = path.join(REPO_ROOT, "docs", "validation");
const offlineBaseFixtureHash = getPaletteFixtureHash();
const offlineWarningFixtureHash = getTimelineWarningFixtureHash();
const PREVIOUS_BASE_FIXTURE_HASH = "106965710be7d8ac2d76477db2462bddba1d342a44e171055ad21fb4583ec1de";
const FROZEN_WARNING_FIXTURE_HASH = "9fb0760dd7d4301fd158e4f22d5420786f6228fd83684a6bec17cca0990e557f";

function extractCaptureFunction(source, signature) {
  const start = source.indexOf(signature);
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `capture.mjs contains ${signature}`);
  return source.slice(start, end + 2);
}

function loadActualCaptureWriters(measureBrowserRoles) {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "skin-palette", "capture.mjs"), "utf8");
  const functions = [
    "function jsonText(",
    "async function writeJson(",
    "function sha256Of(",
    "async function hashEvidenceTree(",
    "async function saveScreenshotBuffer(",
    "function normalizeMeasurementIdentity(",
    "async function runBaselineCapture(",
    "async function writeUnitEvidence(",
  ].map((signature) => extractCaptureFunction(source, signature));
  const dependencies = {
    OFFICIAL_CANDIDATE_ID,
    BASELINE_STATE_ID: "dashboard-default",
    POLICY: {},
    ROLE_CATALOG,
    path,
    mkdir: (...args) => fs.promises.mkdir(...args),
    writeFile: (...args) => fs.promises.writeFile(...args),
    readFile: (...args) => fs.promises.readFile(...args),
    readdir: (...args) => fs.promises.readdir(...args),
    realpath: (...args) => fs.promises.realpath(...args),
    createHash,
    sha256Canonical: contracts.sha256Canonical,
    measureBrowserRoles,
    waitOk: async ({ durations }, name) => {
      durations[name] = 0;
      return true;
    },
    buildBootstrapReadySource: () => "bootstrap-ready",
    awaitRuntimeReady: async () => undefined,
    buildResourceBlockers: () => [],
    buildDeclarationsProbeSource: () => "declarations",
    buildLayoutProbeSource: () => "layout",
    diffPaletteDeclarations: () => [],
    captureStableFullPage: async () => Buffer.from("baseline"),
    applySpotlight: async (_page, _value, _timeout, record) => {
      record.spotlight = { applied: true };
    },
    PAINT_SETTLE_SOURCE: "paint-settle",
  };
  const names = Object.keys(dependencies).join(", ");
  const factory = vm.runInThisContext(
    `(dependencies) => { const { ${names} } = dependencies;\n${functions.join("\n\n")}\nreturn { runBaselineCapture, writeUnitEvidence, hashEvidenceTree }; }`,
  );
  return factory(dependencies);
}

const loadActualEvidenceHasher = () => loadActualCaptureWriters(() => []).hashEvidenceTree;

function withFixtureHash(factory, fixtureHash) {
  if (typeof factory !== "function") return factory;
  return async (...args) => {
    const fixture = await factory(...args);
    if (fixture && typeof fixture === "object" && !Object.hasOwn(fixture, "fixtureHash")) {
      fixture.fixtureHash = fixtureHash;
    }
    return fixture;
  };
}

function withOfflineFixtureFactories(options = {}) {
  const fixtureFactory =
    options.fixtureFactory === undefined
      ? async () => ({ fixtureHash: offlineBaseFixtureHash, close: async () => undefined })
      : options.fixtureFactory;
  const timelineWarningFixtureFactory =
    options.timelineWarningFixtureFactory === undefined
      ? async () => ({ fixtureHash: offlineWarningFixtureHash, close: async () => undefined })
      : options.timelineWarningFixtureFactory;
  return {
    ...options,
    fixtureFactory: withFixtureHash(fixtureFactory, offlineBaseFixtureHash),
    timelineWarningFixtureFactory: withFixtureHash(timelineWarningFixtureFactory, offlineWarningFixtureHash),
  };
}

function runReviewCapture(options) {
  return runReviewCaptureImplementation(withOfflineFixtureFactories(options));
}

function makeCandidateSet() {
  const skinId = contracts.SKIN_IDS[0];
  const profileSnapshot = { purpose: "M4.4.6-A adapter test" };
  const tokens = Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, "#334455"]));
  const candidate = {
    schemaVersion: 1,
    skinId,
    variant: "a",
    profileVersion: 1,
    profileSnapshot,
    profileHash: contracts.sha256Canonical(profileSnapshot),
    policyHash: "a".repeat(64),
    derivationHash: "b".repeat(64),
    seed: "palette-redesign-v1",
    style: { title: "Adapter fixture", rationale: "Lifecycle-only test sample", identitySource: "test" },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: tokens, dark: tokens },
  };
  candidate.candidateHash = contracts.hashCandidate(candidate);
  candidate.id = `${skinId}-a-${candidate.candidateHash.slice(0, 12)}`;
  const candidateSet = {
    schemaVersion: 1,
    inputHashes: {
      profiles: "1".repeat(64),
      policy: "2".repeat(64),
      roles: contracts.hashRoleInputs(),
      derivation: "3".repeat(64),
    },
    candidates: [candidate],
    rejected: [],
  };
  candidateSet.candidateSetHash = contracts.hashCandidateSet(candidateSet);
  assert.equal(contracts.validateCandidateSet(candidateSet, { expectedSkinIds: [] }).valid, true);
  return candidateSet;
}

async function withRun(callback) {
  const testRoot = await fs.promises.mkdtemp(path.join(validationRoot, "m4-4-6-a-"));
  const runDir = path.join(testRoot, "source-run");
  const candidateSet = makeCandidateSet();
  try {
    await fs.promises.mkdir(runDir, { recursive: true });
    await writeCandidateSet(runDir, candidateSet);
    await callback({
      candidateSet,
      candidateId: candidateSet.candidates[0].id,
      outDir: path.join(testRoot, "new-output"),
      runDir,
      runArg: path.relative(REPO_ROOT, runDir),
      testRoot,
    });
  } finally {
    await fs.promises.rm(testRoot, { recursive: true, force: true });
  }
}

async function writeCandidateSet(runDir, candidateSet) {
  await fs.promises.writeFile(path.join(runDir, "candidates.json"), `${JSON.stringify(candidateSet)}\n`, "utf8");
}

async function writeCaptureMetadata(outDir, captureResult) {
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(path.join(outDir, "capture.json"), `${JSON.stringify(captureResult.capture)}\n`, "utf8");
  await fs.promises.writeFile(
    path.join(outDir, "progress.json"),
    `${JSON.stringify(captureResult.progress)}\n`,
    "utf8",
  );
}

function makeCompleteCaptureResult(candidate, outDir = path.join(validationRoot, "summary-fixture-output")) {
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const modes = {};
  const progressUnits = {};
  for (const mode of ["light", "dark"]) {
    const baseline = { status: "captured", blockers: [] };
    const states = Object.fromEntries(
      units.filter((unit) => unit.kind !== "baseline").map((unit) => [unit.id, { status: "captured", blockers: [] }]),
    );
    modes[mode] = { status: "captured", blockers: [], gaps: [], baseline, states };
    for (const unit of units) progressUnits[`${mode}/${unit.id}`] = { status: "captured" };
  }
  const skinId = candidate.skinId;
  const groups = STATE_MATRIX_GROUPS.map((group) => group.id);
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  return {
    outDir,
    skinId,
    modes,
    capture: {
      schemaVersion: 1,
      kind: "skin-palette-capture-matrix",
      candidate: { id: candidate.id, candidateHash: candidate.candidateHash, skinId, variant: candidate.variant },
      groups,
      fixtureHash,
      fixtureBindings,
      modes,
    },
    progress: {
      groups: [...groups],
      modes: ["light", "dark"],
      digests: { fixtureHash, fixtureBindings: structuredClone(fixtureBindings) },
      units: progressUnits,
    },
  };
}

function setCaptureMatrixGroups(captureResult, groups) {
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  captureResult.capture.groups = [...groups];
  captureResult.capture.fixtureHash = fixtureHash;
  captureResult.capture.fixtureBindings = fixtureBindings;
  captureResult.progress.groups = [...groups];
  captureResult.progress.digests.fixtureHash = fixtureHash;
  captureResult.progress.digests.fixtureBindings = structuredClone(fixtureBindings);
}

function makePartialCaptureResult(candidate, outDir, capturedKeys) {
  const captureResult = makeCompleteCaptureResult(candidate, outDir);
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  for (const mode of ["light", "dark"]) {
    let allCaptured = true;
    for (const unit of units) {
      if (capturedKeys.has(`${mode}/${unit.id}`)) continue;
      allCaptured = false;
      const record =
        unit.kind === "baseline" ? captureResult.modes[mode].baseline : captureResult.modes[mode].states[unit.id];
      record.status = "incomplete";
      record.reason = "intentionally not captured by reader fixture";
      captureResult.progress.units[`${mode}/${unit.id}`] = {
        status: "incomplete",
        reason: "intentionally not captured by reader fixture",
      };
    }
    captureResult.modes[mode].status = allCaptured ? "captured" : "incomplete";
  }
  return captureResult;
}

function makeChecks({ candidateId, mode, unit, baseline = false, viewMode = null, records = null, overrides = {} }) {
  const actualRecords = records ?? [
    { candidateId, mode, roleId: "role.example", result: "unmeasured", ratio: null, threshold: 4.5 },
  ];
  return {
    ...(baseline ? {} : { schemaVersion: 1, kind: "skin-palette-capture-checks", unitId: unit.id }),
    stateId: baseline ? "dashboard-default" : (unit.stateId ?? null),
    mode,
    ...(baseline ? {} : { status: "captured" }),
    ...(viewMode === null ? {} : { viewMode }),
    candidateId,
    records: actualRecords,
    counts: { pass: 0, fail: 0, unmeasured: actualRecords.length },
    diagnostics: { source: "unchanged-reader-fixture", viewMode },
    ...overrides,
  };
}

async function writeChecks(outDir, relativePath, checks) {
  const filePath = path.join(outDir, ...relativePath.split("/"));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, typeof checks === "string" ? checks : `${JSON.stringify(checks)}\n`, "utf8");
  return filePath;
}

function checkRelativePath(mode, unit, viewMode = null) {
  const prefix = unit.kind === "baseline" ? [mode] : [mode, "states", unit.id];
  return [...prefix, viewMode === null ? "checks.json" : `checks.timeline-${viewMode}.json`].join("/");
}

function requiredRolesForTestUnit(unit) {
  const stateId = unit.kind === "baseline" ? "dashboard-default" : (unit.stateId ?? null);
  if (stateId === null) return [];
  const state = STATE_CATALOG.find((item) => item.id === stateId);
  assert.ok(state, `catalog state exists: ${stateId}`);
  return state.expectedRoleIds
    .map((roleId) => {
      const role = ROLE_CATALOG.find((item) => item.id === roleId);
      assert.ok(role, `catalog role exists: ${roleId}`);
      return role;
    })
    .filter((role) => role.required === true && typeof role.threshold === "number" && Number.isFinite(role.threshold));
}

function makePassingChecks({ candidate, mode, unit, baseline = false, viewMode = null, records }) {
  const stateId = baseline ? "dashboard-default" : (unit.stateId ?? null);
  const passingRecords =
    records ??
    requiredRolesForTestUnit(unit).map((role) => ({
      candidateId: candidate.id,
      mode,
      roleId: role.id,
      stateId,
      result: "pass",
      ratio: role.threshold,
      threshold: role.threshold,
      method: "reader-fixture:exact",
    }));
  const counts = Object.fromEntries(
    ["pass", "fail", "unmeasured", "not-applicable"].map((result) => [
      result,
      passingRecords.filter((record) => record.result === result).length,
    ]),
  );
  return makeChecks({
    candidateId: candidate.id,
    mode,
    unit,
    baseline,
    viewMode,
    records: passingRecords,
    overrides: { counts },
  });
}

async function makeFullyMeasuredCapture(candidate, outDir) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const captureResult = makeCompleteCaptureResult(candidate, outDir);
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  for (const mode of ["light", "dark"]) {
    for (const unit of units) {
      const baseline = unit.kind === "baseline";
      await writeChecks(outDir, checkRelativePath(mode, unit), makePassingChecks({ candidate, mode, unit, baseline }));
      for (const viewMode of unit.timelineModeSequence ?? []) {
        await writeChecks(
          outDir,
          checkRelativePath(mode, unit, viewMode),
          makePassingChecks({ candidate, mode, unit, viewMode }),
        );
      }
    }
  }
  await addFixtureStateEvidenceAndMetadata(captureResult, candidate, outDir);
  return captureResult;
}

async function makeFullyMeasuredProductionCapture(candidate, outDir) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const captureResult = asProductionCaptureResult(makeCompleteCaptureResult(candidate, outDir));
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  for (const mode of ["light", "dark"]) {
    for (const unit of units) {
      const baseline = unit.kind === "baseline";
      for (const viewMode of [null, ...(unit.timelineModeSequence ?? [])]) {
        const checks = makePassingChecks({ candidate, mode, unit, baseline, viewMode });
        checks.candidateId = null;
        checks.records = checks.records.map((record) => ({ ...record, candidateId: null }));
        await writeChecks(outDir, checkRelativePath(mode, unit, viewMode), checks);
      }
    }
  }
  await addFixtureStateEvidenceAndMetadata(captureResult, candidate, outDir, { production: true });
  return captureResult;
}

async function addFixtureStateEvidenceAndMetadata(captureResult, candidate, outDir, { production = false } = {}) {
  const fixtureUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.fixtureRequirement);
  assert.ok(fixtureUnit, "the matrix registers its fixture-required S8 unit");
  for (const mode of ["light", "dark"]) {
    const checks = makePassingChecks({ candidate, mode, unit: fixtureUnit });
    const evidenceHash = await writeFixtureStateUnit({
      captureDir: outDir,
      mode,
      unit: fixtureUnit,
      candidate,
      records: checks.records,
      production,
    });
    captureResult.progress.units[`${mode}/${fixtureUnit.id}`].evidenceHash = evidenceHash;
  }
  await writeCaptureMetadata(outDir, captureResult);
}

async function updateChecks(outDir, relativePath, update) {
  const filePath = path.join(outDir, ...relativePath.split("/"));
  const checks = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  const updated = update(checks);
  await fs.promises.writeFile(filePath, `${JSON.stringify(updated)}\n`, "utf8");
  return updated;
}

function summarizeCompleteSample() {
  const candidate = makeCandidateSet().candidates[0];
  return {
    candidate,
    captureResult: makeCompleteCaptureResult(candidate),
    summarize() {
      return summarizeReviewCapture({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult: this.captureResult,
      });
    },
  };
}

function asProductionCaptureResult(captureResult) {
  const productionResult = structuredClone(captureResult);
  productionResult.capture.candidate = { production: true, skinId: productionResult.skinId };
  return productionResult;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

test("D8u2B: the actual owner creates, forwards, and closes both fixtures in fixed order", async () => {
  await withRun(async ({ candidateId, outDir, runArg }) => {
    const calls = [];
    const baseFixture = {
      fixtureHash: offlineBaseFixtureHash,
      async close() {
        calls.push("base.close");
      },
    };
    const warningFixture = {
      fixtureHash: offlineWarningFixtureHash,
      async close() {
        calls.push("warning.close");
      },
    };
    const captureResult = { marker: "both fixtures forwarded" };
    let captureInput;

    const result = await runReviewCaptureImplementation({
      runDir: runArg,
      candidateId,
      outDir,
      fixtureFactory: async () => {
        calls.push("base.create");
        return baseFixture;
      },
      timelineWarningFixtureFactory: async () => {
        calls.push("warning.create");
        return warningFixture;
      },
      captureFn: async (input) => {
        calls.push("capture");
        captureInput = input;
        return captureResult;
      },
    });

    assert.deepEqual(calls, ["base.create", "warning.create", "capture", "warning.close", "base.close"]);
    assert.strictEqual(captureInput.fixture, baseFixture);
    assert.strictEqual(captureInput.timelineWarningFixture, warningFixture);
    assert.deepEqual(Object.keys(captureInput).sort(), [
      "candidate",
      "fixture",
      "modes",
      "outDir",
      "resume",
      "timelineWarningFixture",
    ]);
    assert.strictEqual(result.captureResult, captureResult);
  });
});

test("D8u2B: second factory failure, bad fixture, and identity collision close owned resources", async () => {
  await withRun(async ({ candidateId, outDir, runArg, testRoot }) => {
    const calls = [];
    const baseFactoryError = new Error("base factory failed");
    let warningCallsAfterBaseFailure = 0;
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir,
        fixtureFactory: async () => {
          calls.push("base.create");
          throw baseFactoryError;
        },
        timelineWarningFixtureFactory: async () => {
          warningCallsAfterBaseFailure += 1;
          return { fixtureHash: offlineWarningFixtureHash, close: async () => undefined };
        },
        captureFn: async () => assert.fail("capture must not run after base factory failure"),
      }),
      (error) => error === baseFactoryError,
    );
    assert.deepEqual(calls, ["base.create"]);
    assert.equal(warningCallsAfterBaseFailure, 0);

    calls.length = 0;
    const baseFixture = {
      fixtureHash: offlineBaseFixtureHash,
      async close() {
        calls.push("base.close");
      },
    };
    const factoryError = new Error("warning factory failed");
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir,
        fixtureFactory: async () => {
          calls.push("base.create");
          return baseFixture;
        },
        timelineWarningFixtureFactory: async () => {
          calls.push("warning.create");
          throw factoryError;
        },
        captureFn: async () => assert.fail("capture must not run after second factory failure"),
      }),
      (error) => error === factoryError,
    );
    assert.deepEqual(calls, ["base.create", "warning.create", "base.close"]);

    calls.length = 0;
    const wrongBaseFixture = {
      fixtureHash: "0".repeat(64),
      async close() {
        calls.push("base.close");
      },
    };
    const validWarningFixture = {
      fixtureHash: offlineWarningFixtureHash,
      async close() {
        calls.push("warning.close");
      },
    };
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "wrong-base-fixture"),
        fixtureFactory: async () => {
          calls.push("base.create");
          return wrongBaseFixture;
        },
        timelineWarningFixtureFactory: async () => {
          calls.push("warning.create");
          return validWarningFixture;
        },
        captureFn: async () => assert.fail("capture must not run for an unrecognized base fixture"),
      }),
      /fixtureHash must match the base fixture/,
    );
    assert.deepEqual(calls, ["base.create", "warning.create", "warning.close", "base.close"]);

    calls.length = 0;
    const wrongWarningFixture = {
      fixtureHash: "0".repeat(64),
      async close() {
        calls.push("warning.close");
      },
    };
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "wrong-warning-fixture"),
        fixtureFactory: async () => {
          calls.push("base.create");
          return baseFixture;
        },
        timelineWarningFixtureFactory: async () => {
          calls.push("warning.create");
          return wrongWarningFixture;
        },
        captureFn: async () => assert.fail("capture must not run for an unrecognized warning fixture"),
      }),
      /warningFixtureHash/,
    );
    assert.deepEqual(calls, ["base.create", "warning.create", "warning.close", "base.close"]);

    calls.length = 0;
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "same-fixture"),
        fixtureFactory: async () => {
          calls.push("base.create");
          return baseFixture;
        },
        timelineWarningFixtureFactory: async () => {
          calls.push("warning.create");
          return baseFixture;
        },
        captureFn: async () => assert.fail("capture must not run for aliased fixtures"),
      }),
      /different fixture objects/,
    );
    assert.deepEqual(calls, ["base.create", "warning.create", "base.close"], "same object closes once");
  });
});

test("D8u2B: cleanup waits for warning then base, aggregates all errors, and holds/releases the slot", async () => {
  await withRun(async ({ candidateId, outDir, runArg, testRoot }) => {
    const calls = [];
    const closeEntered = deferred();
    const finishWarningClose = deferred();
    const baseFixture = {
      fixtureHash: offlineBaseFixtureHash,
      async close() {
        calls.push("base.close");
      },
    };
    const warningFixture = {
      fixtureHash: offlineWarningFixtureHash,
      async close() {
        calls.push("warning.close.started");
        closeEntered.resolve();
        await finishWarningClose.promise;
        calls.push("warning.close.finished");
      },
    };
    const first = runReviewCaptureImplementation({
      runDir: runArg,
      candidateId,
      outDir,
      fixtureFactory: async () => baseFixture,
      timelineWarningFixtureFactory: async () => warningFixture,
      captureFn: async () => ({ marker: "capture completed" }),
    });
    await closeEntered.promise;
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "during-warning-cleanup"),
        fixtureFactory: async () => assert.fail("slot must remain held during fixture cleanup"),
        timelineWarningFixtureFactory: async () => assert.fail("slot must remain held during fixture cleanup"),
        captureFn: async () => ({}),
      }),
      /another capture is already in progress/,
    );
    assert.deepEqual(calls, ["warning.close.started"]);
    finishWarningClose.resolve();
    await first;
    assert.deepEqual(calls, ["warning.close.started", "warning.close.finished", "base.close"]);

    const captureError = new Error("capture failed");
    const warningCloseError = new Error("warning close failed");
    const baseCloseError = new Error("base close failed");
    await assert.rejects(
      runReviewCaptureImplementation({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "all-cleanup-errors"),
        fixtureFactory: async () => ({
          fixtureHash: offlineBaseFixtureHash,
          close: async () => {
            throw baseCloseError;
          },
        }),
        timelineWarningFixtureFactory: async () => ({
          fixtureHash: offlineWarningFixtureHash,
          close: async () => {
            throw warningCloseError;
          },
        }),
        captureFn: async () => {
          throw captureError;
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [captureError, warningCloseError, baseCloseError]);
        return true;
      },
    );
    const afterCleanupFailure = await runReviewCaptureImplementation({
      runDir: runArg,
      candidateId,
      outDir: path.join(testRoot, "after-cleanup-errors"),
      fixtureFactory: async () => ({ fixtureHash: offlineBaseFixtureHash, close: async () => undefined }),
      timelineWarningFixtureFactory: async () => ({
        fixtureHash: offlineWarningFixtureHash,
        close: async () => undefined,
      }),
      captureFn: async () => ({ marker: "slot released after cleanup failures" }),
    });
    assert.equal(afterCleanupFailure.captureResult.marker, "slot released after cleanup failures");
  });
});

test("loads the registered candidate, calls one complete light/dark matrix, forwards resume, and awaits fixture close", async () => {
  await withRun(async ({ candidateSet, candidateId, outDir, runArg, testRoot }) => {
    const captureResult = { marker: "unclassified capture result" };
    const calls = [];
    const fixture = {
      async close() {
        calls.push("fixture.close");
      },
    };
    const closeEntered = deferred();
    const finishClose = deferred();
    fixture.close = async () => {
      calls.push("fixture.close.started");
      closeEntered.resolve();
      await finishClose.promise;
      calls.push("fixture.close.finished");
    };
    let received = null;
    let settled = false;
    const pending = runReviewCapture({
      runDir: runArg,
      candidateId,
      outDir,
      fixtureFactory: async () => {
        assert.equal(fs.existsSync(outDir), true, "output directory is validated before fixture creation");
        calls.push("fixture.create");
        return fixture;
      },
      captureFn: async (input) => {
        calls.push("capture");
        received = input;
        return captureResult;
      },
    });
    pending.then(() => {
      settled = true;
    });

    await closeEntered.promise;
    assert.equal(settled, false, "result cannot return before fixture.close() completes");
    assert.deepEqual(calls, ["fixture.create", "capture", "fixture.close.started"]);
    assert.ok(received.candidate);
    assert.notEqual(received.candidate, null);
    assert.deepEqual(received.candidate, candidateSet.candidates[0]);
    assert.deepEqual(Object.keys(received).sort(), [
      "candidate",
      "fixture",
      "modes",
      "outDir",
      "resume",
      "timelineWarningFixture",
    ]);
    assert.strictEqual(received.fixture, fixture);
    assert.equal(received.outDir, outDir);
    assert.deepEqual(received.modes, ["light", "dark"]);
    assert.equal(received.resume, false);
    assert.deepEqual(received.candidate.modes.light, candidateSet.candidates[0].modes.light);
    assert.deepEqual(received.candidate.modes.dark, candidateSet.candidates[0].modes.dark);
    assert.equal(fs.existsSync(path.join(outDir, "progress.json")), false);

    finishClose.resolve();
    const result = await pending;
    assert.deepEqual(calls, ["fixture.create", "capture", "fixture.close.started", "fixture.close.finished"]);
    assert.equal(result.candidateId, candidateId);
    assert.equal(result.candidateHash, candidateSet.candidates[0].candidateHash);
    assert.strictEqual(result.captureResult, captureResult);

    const resumeOutDir = path.join(testRoot, "resume-output");
    await fs.promises.mkdir(resumeOutDir);
    const sentinel = Buffer.from("resume evidence is downstream-owned");
    await fs.promises.writeFile(path.join(resumeOutDir, "existing-evidence.json"), sentinel);
    let resumeArgument;
    await runReviewCapture({
      runDir: runArg,
      candidateId,
      outDir: resumeOutDir,
      resume: true,
      fixtureFactory: async () => ({ close: async () => undefined }),
      captureFn: async (input) => {
        resumeArgument = input.resume;
        assert.equal(input.outDir, resumeOutDir);
        return captureResult;
      },
    });
    assert.equal(resumeArgument, true);
    assert.deepEqual(await fs.promises.readFile(path.join(resumeOutDir, "existing-evidence.json")), sentinel);
  });
});

test("rejects invalid identities and output paths before fixture creation without deleting failed output", async () => {
  await withRun(async ({ candidateSet, candidateId, outDir, runArg, runDir, testRoot }) => {
    let fixtureCalls = 0;
    let warningFixtureCalls = 0;
    const fixtureFactory = async () => {
      fixtureCalls += 1;
      return { close: async () => undefined };
    };
    const timelineWarningFixtureFactory = async () => {
      warningFixtureCalls += 1;
      return { close: async () => undefined };
    };
    const invalidInputs = [
      { runDir: " ", candidateId, outDir },
      { runDir: null, candidateId, outDir },
      { runDir: runArg, candidateId: " ", outDir },
      { runDir: runArg, candidateId: null, outDir },
      { runDir: runArg, candidateId, outDir: "" },
      { runDir: runArg, candidateId, outDir: null },
      { runDir: runArg, candidateId, outDir, resume: 1 },
      { runDir: runArg, candidateId, outDir, captureFn: null },
      { runDir: runArg, candidateId, outDir: "https://example.test/output" },
    ];
    for (const input of invalidInputs) {
      await assert.rejects(runReviewCapture({ ...input, fixtureFactory, timelineWarningFixtureFactory }));
    }
    await assert.rejects(runReviewCapture({ runDir: runArg, candidateId, outDir, fixtureFactory: null }));
    await assert.rejects(
      runReviewCapture({ runDir: runArg, candidateId, outDir, timelineWarningFixtureFactory: null }),
      TypeError,
    );
    assert.equal(fs.existsSync(outDir), false, "invalid injected functions are rejected before output creation");

    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId: "unknown-candidate",
        outDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
      }),
      /unknown candidate ID/,
    );
    assert.equal(fs.existsSync(outDir), false, "candidate identity is checked before output creation");

    const invalidCandidateSet = structuredClone(candidateSet);
    invalidCandidateSet.candidates[0].style.title += " changed";
    await writeCandidateSet(runDir, invalidCandidateSet);
    await assert.rejects(
      runReviewCapture({ runDir: runArg, candidateId, outDir, fixtureFactory, timelineWarningFixtureFactory }),
      /candidateHash.*摘要不一致/,
    );
    assert.equal(fs.existsSync(outDir), false, "bad candidate is rejected before output or fixture creation");
    await writeCandidateSet(runDir, candidateSet);

    const escapedOutDir = path.resolve(REPO_ROOT, "not-validation", "m4-4-6-a-output");
    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId,
        outDir: escapedOutDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
      }),
      /assertCaptureOutputDir/,
    );
    assert.equal(fixtureCalls, 0);
    assert.equal(warningFixtureCalls, 0);

    const nonEmptyOutDir = path.join(testRoot, "non-empty-output");
    await fs.promises.mkdir(nonEmptyOutDir);
    const sentinel = Buffer.from("do not remove failed output");
    await fs.promises.writeFile(path.join(nonEmptyOutDir, "existing.json"), sentinel);
    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId,
        outDir: nonEmptyOutDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
      }),
      /必须是空的新目录/,
    );
    assert.equal(fixtureCalls, 0);
    assert.equal(warningFixtureCalls, 0);
    assert.deepEqual(await fs.promises.readFile(path.join(nonEmptyOutDir, "existing.json")), sentinel);
  });
});

test("preserves capture and fixture failures, handles fixture creation failure, and releases the slot", async () => {
  await withRun(async ({ candidateId, outDir, runArg, testRoot }) => {
    const captureError = new Error("capture failed for test");
    const closeError = new Error("fixture cleanup failed for test");
    let closeCalls = 0;
    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId,
        outDir,
        fixtureFactory: async () => ({
          close: async () => {
            closeCalls += 1;
            throw closeError;
          },
        }),
        captureFn: async () => {
          throw captureError;
        },
      }),
      (error) => error instanceof AggregateError && error.errors[0] === captureError && error.errors[1] === closeError,
    );
    assert.equal(closeCalls, 1);
    assert.equal(fs.existsSync(outDir), true, "failed output is retained");

    const closeOnlyError = new Error("fixture close failed without capture error");
    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "close-only-failure"),
        fixtureFactory: async () => ({
          close: async () => {
            throw closeOnlyError;
          },
        }),
        captureFn: async () => ({ marker: "capture completed before close failure" }),
      }),
      (error) => error === closeOnlyError,
    );

    const fixtureCreateError = new Error("fixture creation failed for test");
    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "fixture-create-failure"),
        fixtureFactory: async () => {
          throw fixtureCreateError;
        },
        captureFn: async () => assert.fail("capture must not run when fixture creation fails"),
      }),
      (error) => error === fixtureCreateError,
    );

    const retryResult = { marker: "slot released after errors" };
    const retried = await runReviewCapture({
      runDir: runArg,
      candidateId,
      outDir: path.join(testRoot, "after-failure"),
      fixtureFactory: async () => ({ close: async () => undefined }),
      captureFn: async () => retryResult,
    });
    assert.strictEqual(retried.captureResult, retryResult);
  });
});

test("rejects an overlapping call and allows a new call after the first completes", async () => {
  await withRun(async ({ candidateId, outDir, runArg, testRoot }) => {
    const captureEntered = deferred();
    const finishCapture = deferred();
    let fixtureCalls = 0;
    const first = runReviewCapture({
      runDir: runArg,
      candidateId,
      outDir,
      fixtureFactory: async () => {
        fixtureCalls += 1;
        return { close: async () => undefined };
      },
      captureFn: async () => {
        captureEntered.resolve();
        return finishCapture.promise;
      },
    });

    await captureEntered.promise;
    await assert.rejects(
      runReviewCapture({
        runDir: runArg,
        candidateId,
        outDir: path.join(testRoot, "overlapping-output"),
        fixtureFactory: async () => {
          fixtureCalls += 1;
          return { close: async () => undefined };
        },
        captureFn: async () => ({}),
      }),
      /another capture is already in progress/,
    );
    assert.equal(fixtureCalls, 1);
    assert.equal(fs.existsSync(path.join(testRoot, "overlapping-output")), false);

    const rawResult = { marker: "first capture" };
    finishCapture.resolve(rawResult);
    assert.strictEqual((await first).captureResult, rawResult);

    const next = await runReviewCapture({
      runDir: runArg,
      candidateId,
      outDir: path.join(testRoot, "after-overlap"),
      fixtureFactory: async () => {
        fixtureCalls += 1;
        return { close: async () => undefined };
      },
      captureFn: async () => ({ marker: "next capture" }),
    });
    assert.equal(next.candidateId, candidateId);
    assert.equal(fixtureCalls, 2);
  });
});

test("summarizes complete registered light/dark capture coverage without changing the input", () => {
  const sample = summarizeCompleteSample();
  const before = structuredClone(sample.captureResult);
  assert.deepEqual(sample.summarize(), { status: "captured", errors: [], gaps: [] });
  assert.deepEqual(sample.captureResult, before);
});

test("summarizes a complete formal production matrix without reading or changing evidence", () => {
  const sample = summarizeCompleteSample();
  const captureResult = asProductionCaptureResult(sample.captureResult);
  captureResult.outDir = path.join(validationRoot, "production-summary-no-disk-read");
  const before = structuredClone(captureResult);
  assert.equal(fs.existsSync(captureResult.outDir), false);

  assert.deepEqual(summarizeProductionCapture({ skinId: sample.candidate.skinId, captureResult }), {
    status: "captured",
    errors: [],
    gaps: [],
  });
  assert.deepEqual(captureResult, before);
  assert.equal(Object.isFrozen(captureResult), false);
  assert.equal(Object.isFrozen(captureResult.capture), false);
  assert.equal(fs.existsSync(captureResult.outDir), false);
  assert.throws(
    () =>
      summarizeReviewCapture({
        candidateId: sample.candidate.id,
        candidateHash: sample.candidate.candidateHash,
        captureResult,
      }),
    TypeError,
    "the ordinary entry continues to reject a formal production identity",
  );
});

test("production and candidate summaries share matrix gaps and failure precedence", () => {
  const sample = summarizeCompleteSample();
  const stateUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind !== "baseline");
  const summaryCases = [
    [
      "missing group",
      (captureResult) => setCaptureMatrixGroups(captureResult, captureResult.capture.groups.slice(0, -1)),
      "incomplete",
    ],
    [
      "missing light mode",
      (captureResult) => {
        delete captureResult.modes.light;
        delete captureResult.capture.modes.light;
        captureResult.progress.modes = ["dark"];
      },
      "incomplete",
    ],
    [
      "missing dark mode",
      (captureResult) => {
        delete captureResult.modes.dark;
        delete captureResult.capture.modes.dark;
        captureResult.progress.modes = ["light"];
      },
      "incomplete",
    ],
    [
      "missing dark state and progress",
      (captureResult) => {
        delete captureResult.modes.dark.states[stateUnit.id];
        delete captureResult.capture.modes.dark.states[stateUnit.id];
        delete captureResult.progress.units[`dark/${stateUnit.id}`];
      },
      "incomplete",
    ],
    [
      "unreachable and aborted units",
      (captureResult) => {
        const [unreachable, aborted] = STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter(
          (unit) => unit.kind !== "baseline",
        );
        for (const [unit, status] of [
          [unreachable, "unreachable"],
          [aborted, "aborted"],
        ]) {
          captureResult.modes.dark.states[unit.id] = { status, reason: `${status} test state` };
          captureResult.progress.units[`dark/${unit.id}`] = { status, reason: `${status} test state` };
        }
        captureResult.modes.dark.status = "incomplete";
        captureResult.capture.modes.dark.status = "incomplete";
      },
      "incomplete",
    ],
    [
      "failed status and blocker outrank missing evidence",
      (captureResult) => {
        captureResult.modes.light.status = "failed";
        captureResult.capture.modes.light.status = "failed";
        captureResult.modes.light.blockers = ["matrix-level blocker"];
        captureResult.capture.modes.light.blockers = ["matrix-level blocker"];
        delete captureResult.modes.dark.states[stateUnit.id];
        delete captureResult.capture.modes.dark.states[stateUnit.id];
      },
      "failed",
    ],
  ];

  for (const [label, mutate, expectedStatus] of summaryCases) {
    const candidateResult = structuredClone(sample.captureResult);
    mutate(candidateResult);
    const productionResult = asProductionCaptureResult(candidateResult);
    const candidateSummary = summarizeReviewCapture({
      candidateId: sample.candidate.id,
      candidateHash: sample.candidate.candidateHash,
      captureResult: candidateResult,
    });
    const productionSummary = summarizeProductionCapture({
      skinId: sample.candidate.skinId,
      captureResult: productionResult,
    });
    assert.equal(candidateSummary.status, expectedStatus, label);
    assert.deepEqual(productionSummary, candidateSummary, label);
  }
});

test("D8u3A: both summary identities validate fixture, group, and mode headers before status", () => {
  const sample = summarizeCompleteSample();
  const summarizeBoth = (captureResult) => {
    const candidate = summarizeReviewCapture({
      candidateId: sample.candidate.id,
      candidateHash: sample.candidate.candidateHash,
      captureResult,
    });
    const production = summarizeProductionCapture({
      skinId: sample.candidate.skinId,
      captureResult: asProductionCaptureResult(captureResult),
    });
    return { candidate, production };
  };
  const assertBothThrow = (captureResult, pattern, label) => {
    assert.throws(
      () =>
        summarizeReviewCapture({
          candidateId: sample.candidate.id,
          candidateHash: sample.candidate.candidateHash,
          captureResult,
        }),
      pattern ?? TypeError,
      `candidate: ${label}`,
    );
    assert.throws(
      () =>
        summarizeProductionCapture({
          skinId: sample.candidate.skinId,
          captureResult: asProductionCaptureResult(captureResult),
        }),
      pattern ?? TypeError,
      `production: ${label}`,
    );
  };

  const reorderedObjectKeys = structuredClone(sample.captureResult);
  reorderedObjectKeys.modes = { dark: reorderedObjectKeys.modes.dark, light: reorderedObjectKeys.modes.light };
  reorderedObjectKeys.capture.modes = structuredClone(reorderedObjectKeys.modes);
  reorderedObjectKeys.progress.modes = ["dark", "light"];
  assert.deepEqual(
    summarizeBoth(reorderedObjectKeys),
    {
      candidate: { status: "captured", errors: [], gaps: [] },
      production: { status: "captured", errors: [], gaps: [] },
    },
    "mode object key order and progress array order do not change the actual mode set",
  );

  const bothMapsMissing = structuredClone(sample.captureResult);
  delete bothMapsMissing.capture.fixtureBindings;
  delete bothMapsMissing.progress.digests.fixtureBindings;
  for (const summary of Object.values(summarizeBoth(bothMapsMissing))) {
    assert.equal(summary.status, "incomplete");
    assert.deepEqual(
      summary.gaps
        .filter((gap) => gap.code === "fixture-bindings-missing")
        .map((gap) => gap.detail)
        .sort(),
      ["capture.fixtureBindings is missing", "progress.digests.fixtureBindings is missing"],
    );
  }

  for (const [label, remove] of [
    ["capture map missing", (result) => delete result.capture.fixtureBindings],
    ["progress map missing", (result) => delete result.progress.digests.fixtureBindings],
  ]) {
    const oneMapMissing = structuredClone(sample.captureResult);
    remove(oneMapMissing);
    for (const summary of Object.values(summarizeBoth(oneMapMissing))) {
      assert.equal(summary.status, "incomplete", label);
      assert.equal(summary.gaps.filter((gap) => gap.code === "fixture-bindings-missing").length, 1, label);
    }
  }

  const missingProgress = structuredClone(sample.captureResult);
  delete missingProgress.progress;
  for (const summary of Object.values(summarizeBoth(missingProgress))) {
    assert.equal(summary.status, "incomplete");
    assert.ok(summary.gaps.some((gap) => gap.code === "fixture-bindings-missing"));
    assert.ok(summary.gaps.some((gap) => gap.code === "missing-progress-unit"));
  }

  const badMap = (map) => {
    map.S8 = { fixtureKind: "base", fixtureHash: getPaletteFixtureHash() };
  };
  const invalidHeaders = [
    [
      "capture wrong root hash",
      (result) => (result.capture.fixtureHash = "0".repeat(64)),
      /capture fixture binding header is invalid/,
    ],
    [
      "progress wrong root hash",
      (result) => (result.progress.digests.fixtureHash = "0".repeat(64)),
      /progress fixture binding header is invalid/,
    ],
    [
      "capture wrong binding",
      (result) => badMap(result.capture.fixtureBindings),
      /capture fixture binding header is invalid/,
    ],
    [
      "progress wrong binding",
      (result) => badMap(result.progress.digests.fixtureBindings),
      /progress fixture binding header is invalid/,
    ],
    [
      "capture groups repeated",
      (result) => (result.capture.groups = ["S0", "S0"]),
      /capture fixture binding header is invalid/,
    ],
    [
      "progress groups unknown",
      (result) => (result.progress.groups[0] = "unknown"),
      /progress fixture binding header is invalid/,
    ],
    ["progress modes absent", (result) => delete result.progress.modes, /progress\.modes/],
    ["progress modes non-array", (result) => (result.progress.modes = "light"), /progress\.modes/],
    ["progress modes duplicate", (result) => (result.progress.modes = ["light", "light"]), /progress\.modes/],
    ["progress modes unknown", (result) => (result.progress.modes = ["light", "sepia"]), /progress\.modes/],
    ["progress mode set mismatch", (result) => (result.progress.modes = ["light"]), /progress\.modes does not match/],
    [
      "groups conflict despite valid individual maps",
      (result) => {
        result.progress.groups.reverse();
        result.progress.digests.fixtureBindings = buildFixedMatrixFixtureBindings({
          groups: result.progress.groups,
          fixtureHash: result.progress.digests.fixtureHash,
          warningFixtureHash: getTimelineWarningFixtureHash(),
        });
      },
      /capture\.groups does not match progress\.groups/,
    ],
  ];
  for (const [label, mutate, pattern] of invalidHeaders) {
    const captureResult = structuredClone(sample.captureResult);
    mutate(captureResult);
    assertBothThrow(captureResult, pattern, label);
  }

  const captureMapMissingWithBadProgressMap = structuredClone(sample.captureResult);
  delete captureMapMissingWithBadProgressMap.capture.fixtureBindings;
  badMap(captureMapMissingWithBadProgressMap.progress.digests.fixtureBindings);
  assertBothThrow(
    captureMapMissingWithBadProgressMap,
    /progress fixture binding header is invalid/,
    "missing capture map must not hide bad progress map",
  );

  const progressMapMissingWithBadCaptureMap = structuredClone(sample.captureResult);
  delete progressMapMissingWithBadCaptureMap.progress.digests.fixtureBindings;
  badMap(progressMapMissingWithBadCaptureMap.capture.fixtureBindings);
  assertBothThrow(
    progressMapMissingWithBadCaptureMap,
    /capture fixture binding header is invalid/,
    "missing progress map must not hide bad capture map",
  );

  const failedWithBadHeader = structuredClone(sample.captureResult);
  failedWithBadHeader.modes.light.status = "failed";
  failedWithBadHeader.capture.modes.light.status = "failed";
  badMap(failedWithBadHeader.capture.fixtureBindings);
  assertBothThrow(
    failedWithBadHeader,
    /capture fixture binding header is invalid/,
    "failed status cannot bypass header validation",
  );
});

test("D8u3B2: the exported disk-header inspector reuses the summary rules", () => {
  const { captureResult } = summarizeCompleteSample();
  const args = {
    capture: captureResult.capture,
    progress: captureResult.progress,
    modes: captureResult.capture.modes,
  };
  assert.deepEqual(inspectReviewCaptureFixtureHeaders(args), []);

  const missing = structuredClone(args);
  delete missing.capture.fixtureBindings;
  delete missing.progress.digests.fixtureBindings;
  const gaps = inspectReviewCaptureFixtureHeaders(missing);
  assert.deepEqual(
    gaps.map(({ code, mode, unitId }) => [code, mode, unitId]),
    [
      ["fixture-bindings-missing", null, null],
      ["fixture-bindings-missing", null, null],
    ],
  );

  const badBinding = structuredClone(args);
  badBinding.capture.fixtureBindings = {
    ...badBinding.capture.fixtureBindings,
    S8: { fixtureKind: "base", fixtureHash: getPaletteFixtureHash() },
  };
  assert.throws(() => inspectReviewCaptureFixtureHeaders(badBinding), /capture fixture binding header is invalid/);

  const modeMismatch = structuredClone(args);
  modeMismatch.progress.modes = ["light"];
  assert.throws(() => inspectReviewCaptureFixtureHeaders(modeMismatch), /progress\.modes does not match/);
});

test("D8u3A: missing fixture bindings keep candidate and production classification incomplete", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const removeFixtureBindings = (captureResult) => {
      delete captureResult.capture.fixtureBindings;
      delete captureResult.progress.digests.fixtureBindings;
    };

    const ordinaryCapture = await makeFullyMeasuredCapture(
      candidate,
      path.join(testRoot, "ordinary-missing-fixture-bindings"),
    );
    removeFixtureBindings(ordinaryCapture);
    await writeCaptureMetadata(ordinaryCapture.outDir, ordinaryCapture);
    const ordinary = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult: ordinaryCapture,
    });

    const productionCapture = await makeFullyMeasuredProductionCapture(
      candidate,
      path.join(testRoot, "production-missing-fixture-bindings"),
    );
    removeFixtureBindings(productionCapture);
    await writeCaptureMetadata(productionCapture.outDir, productionCapture);
    const production = await classifyProductionCapture({
      skinId: candidate.skinId,
      captureResult: productionCapture,
    });

    for (const classification of [ordinary, production]) {
      assert.equal(classification.status, "incomplete");
      assert.equal(classification.exitCode, 2);
      assert.equal(classification.errors.length, 0);
      assert.equal(classification.gaps.filter((gap) => gap.code === "fixture-bindings-missing").length, 2);
    }
  });
});

test("D6: previous base fixture hash is rejected by the current fixed binding verifier", () => {
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups: ["S0"],
    fixtureHash: offlineBaseFixtureHash,
    warningFixtureHash: offlineWarningFixtureHash,
  });

  assert.notEqual(offlineBaseFixtureHash, PREVIOUS_BASE_FIXTURE_HASH);
  assert.throws(
    () =>
      assertFixedMatrixFixtureBindings({
        groups: ["S0"],
        fixtureHash: PREVIOUS_BASE_FIXTURE_HASH,
        fixtureBindings,
      }),
    /fixtureHash must match the base fixture/,
  );
});

test("D6: frozen S8 v1 evidence keeps its historical hash and is rejected by current binders", async (t) => {
  const warningRunDir = path.join(
    validationRoot,
    "2026-10-03-skin-palette-redesign",
    "20261003T185748",
    "integration",
    "m52-c-d8s9-warning-paired",
  );
  if (!fs.existsSync(warningRunDir)) {
    t.skip("dated frozen evidence is not in this tree (release archive); it stays in the authoring repository");
    return;
  }
  const outDir = path.join(warningRunDir, "capture-output");
  const capturePath = path.join(outDir, "capture.json");
  const progressPath = path.join(outDir, "progress.json");
  const captureBytes = await fs.promises.readFile(capturePath);
  const progressBytes = await fs.promises.readFile(progressPath);
  const capture = JSON.parse(captureBytes.toString("utf8"));
  const progress = JSON.parse(progressBytes.toString("utf8"));
  const captureResult = {
    outDir,
    skinId: capture.candidate.skinId,
    modes: capture.modes,
    capture,
    progress,
  };

  assert.equal(capture.candidate.production, true);
  assert.deepEqual(capture.groups, ["S8"]);
  assert.deepEqual(progress.groups, ["S8"]);
  assert.equal(capture.fixtureHash, FROZEN_WARNING_FIXTURE_HASH);
  assert.notEqual(capture.fixtureHash, getTimelineWarningFixtureHash());
  assert.equal(progress.digests.fixtureHash, capture.fixtureHash);
  assert.equal(Object.hasOwn(capture, "fixtureBindings"), false);
  assert.equal(Object.hasOwn(progress.digests, "fixtureBindings"), false);
  assert.throws(
    () => summarizeProductionCapture({ skinId: captureResult.skinId, captureResult }),
    /fixtureHash must match the base fixture/,
  );
  await assert.rejects(
    classifyProductionCapture({ skinId: captureResult.skinId, captureResult }),
    /fixtureHash must match the base fixture/,
  );

  assert.deepEqual(await fs.promises.readFile(capturePath), captureBytes);
  assert.deepEqual(await fs.promises.readFile(progressPath), progressBytes);
});
test("production summary rejects identity spoofing, unknown skins, and mode metadata drift", () => {
  const sample = summarizeCompleteSample();
  const skinId = sample.candidate.skinId;
  const otherSkin = contracts.SKIN_IDS.find((id) => id !== skinId);
  assert.ok(otherSkin);

  for (const invalidSkinId of [null, "", "unknown-skin", otherSkin]) {
    const captureResult = asProductionCaptureResult(sample.captureResult);
    assert.throws(() => summarizeProductionCapture({ skinId: invalidSkinId, captureResult }), TypeError);
  }

  const resultSkinMismatch = asProductionCaptureResult(sample.captureResult);
  resultSkinMismatch.skinId = otherSkin;
  assert.throws(() => summarizeProductionCapture({ skinId, captureResult: resultSkinMismatch }), TypeError);

  const metadataSkinMismatch = asProductionCaptureResult(sample.captureResult);
  metadataSkinMismatch.capture.candidate.skinId = otherSkin;
  assert.throws(() => summarizeProductionCapture({ skinId, captureResult: metadataSkinMismatch }), TypeError);

  const candidateShapes = [
    { production: false, skinId },
    { skinId },
    { production: true, skinId, id: null },
    { production: true, skinId, candidateHash: null },
    { production: true, skinId, id: "ordinary-candidate", candidateHash: "a".repeat(64) },
    { production: true, skinId, variant: "a" },
  ];
  for (const candidate of candidateShapes) {
    const captureResult = asProductionCaptureResult(sample.captureResult);
    captureResult.capture.candidate = candidate;
    assert.throws(() => summarizeProductionCapture({ skinId, captureResult }), TypeError);
  }

  const symbolExtra = asProductionCaptureResult(sample.captureResult);
  symbolExtra.capture.candidate[Symbol("extra")] = true;
  assert.throws(() => summarizeProductionCapture({ skinId, captureResult: symbolExtra }), TypeError);

  const ordinaryCandidate = structuredClone(sample.captureResult);
  assert.throws(() => summarizeProductionCapture({ skinId, captureResult: ordinaryCandidate }), TypeError);

  const modeMismatch = asProductionCaptureResult(sample.captureResult);
  modeMismatch.capture.modes = structuredClone(modeMismatch.capture.modes);
  modeMismatch.capture.modes.dark.status = "incomplete";
  assert.throws(
    () => summarizeProductionCapture({ skinId, captureResult: modeMismatch }),
    /capture\.modes does not match/,
  );

  const emptyOutput = asProductionCaptureResult(sample.captureResult);
  emptyOutput.outDir = "  ";
  assert.throws(() => summarizeProductionCapture({ skinId, captureResult: emptyOutput }), /outDir/);
});

test("production summary rejects unknown matrix groups, units, and executor statuses", () => {
  const sample = summarizeCompleteSample();
  const skinId = sample.candidate.skinId;
  const stateUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind !== "baseline");

  const unknownGroup = asProductionCaptureResult(sample.captureResult);
  unknownGroup.capture.groups.push("unknown-group");
  assert.throws(
    () => summarizeProductionCapture({ skinId, captureResult: unknownGroup }),
    /invalid or duplicate group unknown-group/,
  );

  const unknownUnit = asProductionCaptureResult(sample.captureResult);
  unknownUnit.modes.light.states["unknown-unit"] = { status: "captured" };
  unknownUnit.capture.modes.light.states["unknown-unit"] = { status: "captured" };
  assert.throws(() => summarizeProductionCapture({ skinId, captureResult: unknownUnit }), /unknown unit/);

  const unknownStatus = asProductionCaptureResult(sample.captureResult);
  unknownStatus.modes.light.states[stateUnit.id].status = "skipped";
  assert.throws(
    () => summarizeProductionCapture({ skinId, captureResult: unknownStatus }),
    /recognized capture status/,
  );
});

test("reports missing modes, groups, baseline, states, and progress as incomplete gaps", () => {
  const sample = summarizeCompleteSample();
  delete sample.captureResult.modes.dark;
  sample.captureResult.progress.modes = ["light"];
  assert.equal(
    sample.summarize().gaps.some((gap) => gap.code === "missing-mode" && gap.mode === "dark"),
    true,
  );

  const missingGroup = summarizeCompleteSample();
  setCaptureMatrixGroups(
    missingGroup.captureResult,
    missingGroup.captureResult.capture.groups.filter((id) => id !== "S5"),
  );
  assert.equal(
    missingGroup.summarize().gaps.some((gap) => gap.code === "missing-group" && gap.detail.includes("S5")),
    true,
  );

  const baseline = summarizeCompleteSample();
  baseline.captureResult.modes.light.baseline = null;
  assert.equal(
    baseline.summarize().gaps.some((gap) => gap.code === "missing-baseline" && gap.mode === "light"),
    true,
  );

  const firstState = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind !== "baseline");
  const missingState = summarizeCompleteSample();
  delete missingState.captureResult.modes.dark.states[firstState.id];
  assert.equal(
    missingState.summarize().gaps.some((gap) => gap.code === "missing-state" && gap.unitId === firstState.id),
    true,
  );

  const emptyStates = summarizeCompleteSample();
  emptyStates.captureResult.modes.light.states = {};
  assert.equal(
    emptyStates.summarize().gaps.filter((gap) => gap.code === "missing-state" && gap.mode === "light").length,
    STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter((unit) => unit.kind !== "baseline").length,
  );

  const missingProgress = summarizeCompleteSample();
  delete missingProgress.captureResult.progress;
  assert.equal(
    missingProgress.summarize().gaps.some((gap) => gap.code === "missing-progress-unit" && gap.mode === "dark"),
    true,
  );
  assert.equal(
    missingProgress.summarize().gaps.some((gap) => gap.code === "fixture-bindings-missing"),
    true,
    "missing progress must report unavailable fixture binding verification",
  );
});

test("rejects candidate or skin identity drift, mismatched mode views, and unknown statuses", () => {
  const identity = summarizeCompleteSample();
  assert.throws(
    () =>
      summarizeReviewCapture({
        candidateId: `${identity.candidate.id}-other`,
        candidateHash: identity.candidate.candidateHash,
        captureResult: identity.captureResult,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      summarizeReviewCapture({
        candidateId: identity.candidate.id,
        candidateHash: `${identity.candidate.candidateHash.slice(0, -1)}0`,
        captureResult: identity.captureResult,
      }),
    TypeError,
  );

  const skinMismatch = summarizeCompleteSample();
  skinMismatch.captureResult.capture.candidate.skinId = "other-skin";
  assert.throws(() => skinMismatch.summarize(), TypeError);

  const productionCandidate = summarizeCompleteSample();
  productionCandidate.captureResult.capture.candidate.production = true;
  assert.throws(() => productionCandidate.summarize(), TypeError);

  const modeMismatch = summarizeCompleteSample();
  modeMismatch.captureResult.capture.modes = structuredClone(modeMismatch.captureResult.modes);
  modeMismatch.captureResult.capture.modes.light.status = "incomplete";
  assert.throws(() => modeMismatch.summarize(), /modes does not match/);

  const unknownModeStatus = summarizeCompleteSample();
  unknownModeStatus.captureResult.modes.light.status = "passed";
  assert.throws(() => unknownModeStatus.summarize(), /recognized capture status/);

  const unknownUnitStatus = summarizeCompleteSample();
  const firstState = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind !== "baseline");
  unknownUnitStatus.captureResult.modes.light.states[firstState.id].status = "skipped";
  assert.throws(() => unknownUnitStatus.summarize(), /recognized capture status/);

  const unknownShape = summarizeCompleteSample();
  unknownShape.captureResult.progress = new Date();
  assert.throws(() => unknownShape.summarize(), TypeError);
});

test("does not let captured parents hide baseline, state, or progress failures; failed wins over gaps", () => {
  const sample = summarizeCompleteSample();
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const baselineUnit = units.find((unit) => unit.kind === "baseline");
  const stateUnits = units.filter((unit) => unit.kind !== "baseline");
  const failedState = stateUnits[0];
  const unreachableState = stateUnits[1];

  sample.captureResult.modes.light.states[failedState.id] = {
    status: "failed",
    blockers: ["state diagnostic must survive"],
  };
  sample.captureResult.progress.units[`light/${failedState.id}`] = { status: "failed" };
  sample.captureResult.modes.light.states[unreachableState.id] = {
    status: "unreachable",
    reason: "fixture could not reach this state",
  };
  sample.captureResult.progress.units[`light/${unreachableState.id}`] = {
    status: "unreachable",
    reason: "fixture could not reach this state",
  };
  sample.captureResult.modes.light.gaps.push({
    unitId: unreachableState.id,
    stateId: unreachableState.stateId,
    reason: "original capture gap text",
  });
  const stateSummary = sample.summarize();
  assert.equal(stateSummary.status, "failed");
  assert.equal(
    stateSummary.errors.some((error) => error.detail === "state diagnostic must survive"),
    true,
  );
  assert.equal(
    stateSummary.gaps.some((gap) => gap.detail.includes("original capture gap text")),
    true,
  );
  assert.equal(
    stateSummary.gaps.some((gap) => gap.detail.includes("fixture could not reach this state")),
    true,
  );

  const failedBaseline = summarizeCompleteSample();
  failedBaseline.captureResult.modes.dark.baseline = { status: "failed", blockers: ["baseline failed"] };
  assert.equal(failedBaseline.summarize().status, "failed");

  const failedProgress = summarizeCompleteSample();
  failedProgress.captureResult.progress.units[`dark/${baselineUnit.id}`] = {
    status: "failed",
    blockers: ["progress failed"],
  };
  assert.equal(failedProgress.summarize().status, "failed");

  const failedMode = summarizeCompleteSample();
  failedMode.captureResult.modes.dark.status = "failed";
  assert.equal(failedMode.summarize().status, "failed");
});

test("keeps non-captured statuses and executor gaps incomplete with their diagnostic text", () => {
  const sample = summarizeCompleteSample();
  const stateUnits = STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter((unit) => unit.kind !== "baseline");
  const [unreachable, aborted, incomplete] = stateUnits;
  for (const [unit, status, reason] of [
    [unreachable, "unreachable", "unreachable diagnostic"],
    [aborted, "aborted", "aborted diagnostic"],
    [incomplete, "incomplete", "incomplete diagnostic"],
  ]) {
    sample.captureResult.modes.dark.states[unit.id] = { status, reason };
    sample.captureResult.progress.units[`dark/${unit.id}`] = { status, reason };
  }
  sample.captureResult.modes.dark.status = "incomplete";
  sample.captureResult.modes.dark.gaps.push({
    unitId: unreachable.id,
    stateId: unreachable.stateId,
    reason: "executor gap diagnostic",
  });

  const summary = sample.summarize();
  assert.equal(summary.status, "incomplete");
  assert.deepEqual(summary.errors, []);
  for (const detail of [
    "unreachable diagnostic",
    "aborted diagnostic",
    "incomplete diagnostic",
    "executor gap diagnostic",
  ]) {
    assert.equal(
      summary.gaps.some((gap) => gap.detail.includes(detail)),
      true,
      detail,
    );
  }
});

test("reads S0, ordinary checks, and actual model/cost timeline variants in registry order", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const outDir = path.join(testRoot, "checks-output");
    await fs.promises.mkdir(outDir);
    const capturedKeys = new Set([
      `light/${baseline.id}`,
      `light/${ordinary.id}`,
      `light/${timeline.id}`,
      `dark/${baseline.id}`,
    ]);
    const captureResult = makePartialCaptureResult(candidate, outDir, capturedKeys);
    const s0Light = makeChecks({ candidateId: candidate.id, mode: "light", unit: baseline, baseline: true });
    const ordinaryChecks = makeChecks({ candidateId: candidate.id, mode: "light", unit: ordinary });
    const timelineMain = makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline });
    const timelineModel = makeChecks({
      candidateId: candidate.id,
      mode: "light",
      unit: timeline,
      viewMode: "model",
      overrides: { diagnostics: { unchanged: ["model", "raw"] } },
    });
    const timelineCost = makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline, viewMode: "cost" });
    const s0Dark = makeChecks({ candidateId: candidate.id, mode: "dark", unit: baseline, baseline: true });
    await writeChecks(outDir, "light/checks.json", s0Light);
    await writeChecks(outDir, `light/states/${ordinary.id}/checks.json`, ordinaryChecks);
    await writeChecks(outDir, `light/states/${timeline.id}/checks.json`, timelineMain);
    await writeChecks(outDir, `light/states/${timeline.id}/checks.timeline-model.json`, timelineModel);
    await writeChecks(outDir, `light/states/${timeline.id}/checks.timeline-cost.json`, timelineCost);
    await writeChecks(outDir, "dark/checks.json", s0Dark);

    const before = structuredClone(captureResult);
    const result = await readReviewCaptureChecks({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.deepEqual(
      result.entries.map(({ mode, unitId, viewMode, relativePath }) => ({ mode, unitId, viewMode, relativePath })),
      [
        { mode: "light", unitId: baseline.id, viewMode: null, relativePath: "light/checks.json" },
        { mode: "light", unitId: ordinary.id, viewMode: null, relativePath: `light/states/${ordinary.id}/checks.json` },
        { mode: "light", unitId: timeline.id, viewMode: null, relativePath: `light/states/${timeline.id}/checks.json` },
        {
          mode: "light",
          unitId: timeline.id,
          viewMode: "model",
          relativePath: `light/states/${timeline.id}/checks.timeline-model.json`,
        },
        {
          mode: "light",
          unitId: timeline.id,
          viewMode: "cost",
          relativePath: `light/states/${timeline.id}/checks.timeline-cost.json`,
        },
        { mode: "dark", unitId: baseline.id, viewMode: null, relativePath: "dark/checks.json" },
      ],
    );
    assert.deepEqual(result.entries[0].checks, s0Light);
    assert.deepEqual(result.entries[1].checks, ordinaryChecks);
    assert.deepEqual(result.entries[3].checks, timelineModel);
    assert.deepEqual(result.entries[4].checks, timelineCost);
    assert.equal(
      result.gaps.some((gap) => gap.code === "status-incomplete"),
      true,
    );
    assert.deepEqual(captureResult, before);
  });
});

test("reads formal S0, state, and timeline checks in registry order with null candidate records", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const outDir = path.join(testRoot, "production-checks-output");
    await fs.promises.mkdir(outDir);
    const capturedKeys = new Set([
      `light/${baseline.id}`,
      `light/${ordinary.id}`,
      `light/${timeline.id}`,
      `dark/${baseline.id}`,
    ]);
    const captureResult = asProductionCaptureResult(makePartialCaptureResult(candidate, outDir, capturedKeys));
    const files = [
      ["light/checks.json", makeChecks({ candidateId: null, mode: "light", unit: baseline, baseline: true })],
      [`light/states/${ordinary.id}/checks.json`, makeChecks({ candidateId: null, mode: "light", unit: ordinary })],
      [`light/states/${timeline.id}/checks.json`, makeChecks({ candidateId: null, mode: "light", unit: timeline })],
      [
        `light/states/${timeline.id}/checks.timeline-model.json`,
        makeChecks({ candidateId: null, mode: "light", unit: timeline, viewMode: "model" }),
      ],
      [
        `light/states/${timeline.id}/checks.timeline-cost.json`,
        makeChecks({ candidateId: null, mode: "light", unit: timeline, viewMode: "cost" }),
      ],
      ["dark/checks.json", makeChecks({ candidateId: null, mode: "dark", unit: baseline, baseline: true })],
    ];
    const filePaths = [];
    for (const [relativePath, checks] of files) filePaths.push(await writeChecks(outDir, relativePath, checks));
    const fileBytesBefore = await Promise.all(filePaths.map((filePath) => fs.promises.readFile(filePath)));
    const captureBefore = structuredClone(captureResult);
    const s0Checks = files[0][1];
    assert.equal(Object.hasOwn(s0Checks, "schemaVersion"), false);
    assert.equal(Object.hasOwn(s0Checks, "kind"), false);
    assert.equal(Object.hasOwn(s0Checks, "unitId"), false);
    await assert.rejects(
      readReviewCaptureChecks({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      }),
      TypeError,
      "the ordinary checks reader does not accept a formal production matrix",
    );

    const result = await readProductionCaptureChecks({ skinId: candidate.skinId, captureResult });
    assert.deepEqual(Object.keys(result).sort(), ["entries", "gaps"]);
    assert.deepEqual(
      result.entries.map(({ mode, unitId, viewMode, relativePath }) => ({ mode, unitId, viewMode, relativePath })),
      [
        { mode: "light", unitId: baseline.id, viewMode: null, relativePath: "light/checks.json" },
        { mode: "light", unitId: ordinary.id, viewMode: null, relativePath: `light/states/${ordinary.id}/checks.json` },
        { mode: "light", unitId: timeline.id, viewMode: null, relativePath: `light/states/${timeline.id}/checks.json` },
        {
          mode: "light",
          unitId: timeline.id,
          viewMode: "model",
          relativePath: `light/states/${timeline.id}/checks.timeline-model.json`,
        },
        {
          mode: "light",
          unitId: timeline.id,
          viewMode: "cost",
          relativePath: `light/states/${timeline.id}/checks.timeline-cost.json`,
        },
        { mode: "dark", unitId: baseline.id, viewMode: null, relativePath: "dark/checks.json" },
      ],
    );
    assert.deepEqual(result.entries[0].checks, s0Checks);
    assert.equal(Object.hasOwn(result.entries[0].checks, "schemaVersion"), false);
    assert.ok(result.entries.every(({ checks }) => checks.candidateId === null));
    assert.ok(result.entries.every(({ checks }) => checks.records.every((record) => record.candidateId === null)));
    assert.equal(
      result.gaps.some((gap) => gap.code === "status-incomplete"),
      true,
    );
    assert.equal(
      result.gaps.some((gap) => gap.code === "missing-checks"),
      false,
    );
    assert.deepEqual(captureResult, captureBefore);
    for (const [index, filePath] of filePaths.entries()) {
      assert.deepEqual(await fs.promises.readFile(filePath), fileBytesBefore[index]);
    }
  });
});

test("formal checks require explicit null candidate identity on headers and every record", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const outDir = path.join(testRoot, "production-null-identity-output");
    await fs.promises.mkdir(outDir);
    const captureResult = asProductionCaptureResult(
      makePartialCaptureResult(candidate, outDir, new Set([`light/${baseline.id}`])),
    );
    const relativePath = "light/checks.json";
    const validRecord = {
      candidateId: null,
      mode: "light",
      roleId: "role.example",
      result: "unmeasured",
      ratio: null,
      threshold: 4.5,
    };
    const valid = makeChecks({
      candidateId: null,
      mode: "light",
      unit: baseline,
      baseline: true,
      records: [validRecord],
    });
    await writeChecks(outDir, relativePath, valid);
    const args = { skinId: candidate.skinId, captureResult };
    const accepted = await readProductionCaptureChecks(args);
    assert.equal(accepted.entries[0].checks.candidateId, null);
    assert.deepEqual(accepted.entries[0].checks.records, [validRecord]);

    const emptyRecords = makeChecks({ candidateId: null, mode: "light", unit: baseline, baseline: true, records: [] });
    await writeChecks(outDir, relativePath, emptyRecords);
    assert.equal((await readProductionCaptureChecks(args)).entries[0].checks.records.length, 0);

    const invalidCases = [
      ["empty records with missing header identity", { ...emptyRecords, candidateId: undefined }],
      ["empty records with empty header identity", { ...emptyRecords, candidateId: "" }],
      ["empty records with candidate header identity", { ...emptyRecords, candidateId: candidate.id }],
      ["missing record identity", { ...valid, records: [{ ...validRecord, candidateId: undefined }] }],
      ["empty record identity", { ...valid, records: [{ ...validRecord, candidateId: "" }] }],
      ["candidate record identity", { ...valid, records: [{ ...validRecord, candidateId: candidate.id }] }],
      ["other candidate record identity", { ...valid, records: [{ ...validRecord, candidateId: "other-candidate" }] }],
    ];
    const captureBefore = structuredClone(captureResult);
    for (const [label, checks] of invalidCases) {
      const filePath = await writeChecks(outDir, relativePath, checks);
      const bytesBefore = await fs.promises.readFile(filePath);
      await assert.rejects(readProductionCaptureChecks(args), TypeError, label);
      assert.deepEqual(await fs.promises.readFile(filePath), bytesBefore, `${label}: input file is not rewritten`);
    }
    assert.deepEqual(captureResult, captureBefore);
  });
});

test("formal checks enforce S0, state, and timeline file shapes", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const capturedKeys = new Set([`light/${baseline.id}`, `light/${ordinary.id}`, `light/${timeline.id}`]);
    const validChecks = new Map([
      ["light/checks.json", makeChecks({ candidateId: null, mode: "light", unit: baseline, baseline: true })],
      [`light/states/${ordinary.id}/checks.json`, makeChecks({ candidateId: null, mode: "light", unit: ordinary })],
      [`light/states/${timeline.id}/checks.json`, makeChecks({ candidateId: null, mode: "light", unit: timeline })],
      [
        `light/states/${timeline.id}/checks.timeline-model.json`,
        makeChecks({ candidateId: null, mode: "light", unit: timeline, viewMode: "model" }),
      ],
      [
        `light/states/${timeline.id}/checks.timeline-cost.json`,
        makeChecks({ candidateId: null, mode: "light", unit: timeline, viewMode: "cost" }),
      ],
    ]);
    const cases = [
      ["S0 mode", "light/checks.json", { mode: "dark" }],
      ["S0 stateId", "light/checks.json", { stateId: "other-state" }],
      [`state schemaVersion`, `light/states/${ordinary.id}/checks.json`, { schemaVersion: 2 }],
      [`state kind`, `light/states/${ordinary.id}/checks.json`, { kind: "other-checks" }],
      [`state unitId`, `light/states/${ordinary.id}/checks.json`, { unitId: "other-unit" }],
      [`state stateId`, `light/states/${ordinary.id}/checks.json`, { stateId: "other-state" }],
      ["timeline viewMode", `light/states/${timeline.id}/checks.timeline-model.json`, { viewMode: "cost" }],
    ];

    for (const [index, [label, relativePath, overrides]] of cases.entries()) {
      const outDir = path.join(testRoot, `production-shape-${index}`);
      await fs.promises.mkdir(outDir);
      const captureResult = asProductionCaptureResult(makePartialCaptureResult(candidate, outDir, capturedKeys));
      for (const [file, checks] of validChecks) await writeChecks(outDir, file, checks);
      const changed = { ...validChecks.get(relativePath), ...overrides };
      await writeChecks(outDir, relativePath, changed);
      await assert.rejects(readProductionCaptureChecks({ skinId: candidate.skinId, captureResult }), TypeError, label);
    }
  });
});

test("missing captured checks become gaps while non-captured units are not probed", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const outDir = path.join(testRoot, "missing-checks-output");
    await fs.promises.mkdir(outDir);
    const captureResult = makePartialCaptureResult(
      candidate,
      outDir,
      new Set([`light/${baseline.id}`, `dark/${baseline.id}`, `light/${ordinary.id}`, `light/${timeline.id}`]),
    );
    await writeChecks(
      outDir,
      "light/checks.json",
      makeChecks({ candidateId: candidate.id, mode: "light", unit: baseline, baseline: true }),
    );
    await writeChecks(
      outDir,
      "dark/checks.json",
      makeChecks({ candidateId: candidate.id, mode: "dark", unit: baseline, baseline: true }),
    );
    await writeChecks(
      outDir,
      `light/states/${timeline.id}/checks.json`,
      makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline }),
    );
    await writeChecks(
      outDir,
      `light/states/${timeline.id}/checks.timeline-model.json`,
      makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline, viewMode: "model" }),
    );

    const result = await readReviewCaptureChecks({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(
      result.gaps.some(
        (gap) => gap.code === "missing-checks" && gap.detail.endsWith(`light/states/${ordinary.id}/checks.json`),
      ),
      true,
    );
    assert.equal(
      result.gaps.some(
        (gap) =>
          gap.code === "missing-checks" && gap.detail.endsWith(`light/states/${timeline.id}/checks.timeline-cost.json`),
      ),
      true,
    );
    assert.equal(
      result.entries.some((entry) => entry.relativePath === `light/states/${timeline.id}/checks.timeline-model.json`),
      true,
    );

    const noCapturedOutDir = path.join(testRoot, "non-captured-output");
    await fs.promises.mkdir(noCapturedOutDir);
    const noCaptured = makePartialCaptureResult(candidate, noCapturedOutDir, new Set());
    const skipped = await readReviewCaptureChecks({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult: noCaptured,
    });
    assert.deepEqual(skipped.entries, []);
    assert.equal(
      skipped.gaps.some((gap) => gap.code === "missing-checks"),
      false,
    );
  });
});

test("formal missing checks remain gaps and malformed files for non-captured units are not read", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const otherState = units.find(
      (unit) => unit.kind !== "baseline" && unit.id !== ordinary.id && unit.id !== timeline.id,
    );
    const outDir = path.join(testRoot, "production-missing-checks-output");
    await fs.promises.mkdir(outDir);
    const captureResult = asProductionCaptureResult(
      makePartialCaptureResult(
        candidate,
        outDir,
        new Set([`light/${baseline.id}`, `light/${ordinary.id}`, `light/${timeline.id}`]),
      ),
    );
    const s0Path = await writeChecks(
      outDir,
      "light/checks.json",
      makeChecks({ candidateId: null, mode: "light", unit: baseline, baseline: true }),
    );
    const timelinePath = await writeChecks(
      outDir,
      `light/states/${timeline.id}/checks.json`,
      makeChecks({ candidateId: null, mode: "light", unit: timeline }),
    );
    const unvisitedRelativePath = `light/states/${otherState.id}/checks.json`;
    const unvisitedPath = await writeChecks(outDir, unvisitedRelativePath, "not valid JSON");
    const captureBefore = structuredClone(captureResult);
    const [s0Bytes, timelineBytes, unvisitedBytes] = await Promise.all(
      [s0Path, timelinePath, unvisitedPath].map((filePath) => fs.promises.readFile(filePath)),
    );

    const result = await readProductionCaptureChecks({ skinId: candidate.skinId, captureResult });
    for (const relativePath of [
      `light/states/${ordinary.id}/checks.json`,
      `light/states/${timeline.id}/checks.timeline-model.json`,
      `light/states/${timeline.id}/checks.timeline-cost.json`,
    ]) {
      assert.equal(
        result.gaps.some((gap) => gap.code === "missing-checks" && gap.detail.endsWith(relativePath)),
        true,
        relativePath,
      );
    }
    assert.equal(
      result.gaps.some((gap) => gap.code === "missing-checks" && gap.detail.endsWith(unvisitedRelativePath)),
      false,
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.relativePath),
      ["light/checks.json", `light/states/${timeline.id}/checks.json`],
    );
    assert.deepEqual(captureResult, captureBefore);
    assert.deepEqual(await fs.promises.readFile(s0Path), s0Bytes);
    assert.deepEqual(await fs.promises.readFile(timelinePath), timelineBytes);
    assert.deepEqual(await fs.promises.readFile(unvisitedPath), unvisitedBytes);
    assert.equal(fs.existsSync(path.join(outDir, `light/states/${ordinary.id}/checks.json`)), false);
  });
});

test("formal reader rejects invalid roots, bad JSON, and directory-valued check files", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const capturedKeys = new Set([`light/${baseline.id}`]);
    const missingOutDir = path.join(testRoot, "production-missing-output");
    const missingCapture = asProductionCaptureResult(makePartialCaptureResult(candidate, missingOutDir, capturedKeys));
    await assert.rejects(readProductionCaptureChecks({ skinId: candidate.skinId, captureResult: missingCapture }));
    assert.equal(fs.existsSync(missingOutDir), false, "the read path does not create output directories");

    const rootCapture = asProductionCaptureResult(makePartialCaptureResult(candidate, validationRoot, capturedKeys));
    await assert.rejects(
      readProductionCaptureChecks({ skinId: candidate.skinId, captureResult: rootCapture }),
      /strict child of docs\/validation/,
    );

    const outDir = path.join(testRoot, "production-invalid-check-output");
    await fs.promises.mkdir(outDir);
    const captureResult = asProductionCaptureResult(makePartialCaptureResult(candidate, outDir, capturedKeys));
    const args = { skinId: candidate.skinId, captureResult };
    const s0Path = await writeChecks(
      outDir,
      "light/checks.json",
      makeChecks({ candidateId: null, mode: "light", unit: baseline, baseline: true }),
    );
    await fs.promises.writeFile(s0Path, "{ broken JSON\n", "utf8");
    await assert.rejects(readProductionCaptureChecks(args), /invalid JSON/);

    await fs.promises.unlink(s0Path);
    await fs.promises.mkdir(s0Path);
    await assert.rejects(readProductionCaptureChecks(args), /checks path must be a regular file/);
  });
});

test("rejects a formal checks-file symlink when file symlinks are available", async (t) => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const outDir = path.join(testRoot, "production-symlink-output");
    await fs.promises.mkdir(outDir);
    const captureResult = asProductionCaptureResult(
      makePartialCaptureResult(candidate, outDir, new Set([`light/${baseline.id}`])),
    );
    const checksPath = await writeChecks(
      outDir,
      "light/checks.json",
      makeChecks({ candidateId: null, mode: "light", unit: baseline, baseline: true }),
    );
    const targetPath = path.join(testRoot, "production-symlink-target.json");
    await fs.promises.copyFile(checksPath, targetPath);
    await fs.promises.unlink(checksPath);
    try {
      await fs.promises.symlink(targetPath, checksPath, "file");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionCaptureChecks({ skinId: candidate.skinId, captureResult }),
      /checks file must not be a symlink/,
    );
  });
});

test("rejects a formal checks output directory junction that escapes docs/validation", async (t) => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const outDir = path.join(testRoot, "junction-source-output");
    await fs.promises.mkdir(outDir);
    const captureResult = asProductionCaptureResult(
      makePartialCaptureResult(candidate, outDir, new Set([`light/${baseline.id}`])),
    );
    const junction = path.join(testRoot, "production-output-junction");
    try {
      await fs.promises.symlink(REPO_ROOT, junction, "junction");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionCaptureChecks({
        skinId: candidate.skinId,
        captureResult: { ...captureResult, outDir: junction },
      }),
      /realpath must be a strict child of docs\/validation/,
    );
  });
});

test("allows explicit null candidate only for empty records and requires every record identity", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const unit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((entry) => entry.kind === "baseline");
    const outDir = path.join(testRoot, "empty-records-output");
    await fs.promises.mkdir(outDir);
    const captureResult = makePartialCaptureResult(candidate, outDir, new Set([`light/${unit.id}`]));
    const relativePath = "light/checks.json";
    const empty = makeChecks({ candidateId: null, mode: "light", unit, baseline: true, records: [] });
    await writeChecks(outDir, relativePath, empty);

    const readArgs = { candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult };
    const accepted = await readReviewCaptureChecks(readArgs);
    assert.equal(
      accepted.entries.some((entry) => entry.relativePath === relativePath && entry.checks.candidateId === null),
      true,
    );

    await writeChecks(outDir, relativePath, {
      ...empty,
      records: [{ candidateId: candidate.id, mode: "light", result: "pass" }],
    });
    await assert.rejects(readReviewCaptureChecks(readArgs), TypeError);

    await writeChecks(outDir, relativePath, { ...empty, candidateId: undefined });
    await assert.rejects(readReviewCaptureChecks(readArgs), TypeError);

    await writeChecks(outDir, relativePath, {
      ...empty,
      candidateId: candidate.id,
      records: [{ mode: "light", result: "pass" }],
    });
    await assert.rejects(readReviewCaptureChecks(readArgs), TypeError);
  });
});

test("rejects malformed JSON and capture/check identity drift", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const capturedKeys = new Set([`light/${baseline.id}`, `light/${ordinary.id}`, `light/${timeline.id}`]);
    const validFiles = async (outDir, altered = null) => {
      const sample = makePartialCaptureResult(candidate, outDir, capturedKeys);
      await fs.promises.mkdir(outDir);
      const baselineChecks = makeChecks({ candidateId: candidate.id, mode: "light", unit: baseline, baseline: true });
      const ordinaryChecks = makeChecks({ candidateId: candidate.id, mode: "light", unit: ordinary });
      const timelineChecks = makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline });
      const timelineModel = makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline, viewMode: "model" });
      const timelineCost = makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline, viewMode: "cost" });
      const files = new Map([
        ["light/checks.json", baselineChecks],
        [`light/states/${ordinary.id}/checks.json`, ordinaryChecks],
        [`light/states/${timeline.id}/checks.json`, timelineChecks],
        [`light/states/${timeline.id}/checks.timeline-model.json`, timelineModel],
        [`light/states/${timeline.id}/checks.timeline-cost.json`, timelineCost],
      ]);
      if (altered) files.set(altered.path, altered.value);
      for (const [relativePath, checks] of files) await writeChecks(outDir, relativePath, checks);
      return sample;
    };
    const argsFor = (captureResult) => ({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    const cases = [
      { name: "invalid JSON", path: "light/checks.json", value: "{broken", isRaw: true },
      {
        name: "S0 mode mismatch",
        path: "light/checks.json",
        value: makeChecks({ candidateId: candidate.id, mode: "dark", unit: baseline, baseline: true }),
      },
      {
        name: "S0 candidate mismatch",
        path: "light/checks.json",
        value: makeChecks({ candidateId: "other-candidate", mode: "light", unit: baseline, baseline: true }),
      },
      {
        name: "S0 state mismatch",
        path: "light/checks.json",
        value: makeChecks({
          candidateId: candidate.id,
          mode: "light",
          unit: baseline,
          baseline: true,
          overrides: { stateId: "wrong-state" },
        }),
      },
      {
        name: "main checks mode mismatch",
        path: `light/states/${ordinary.id}/checks.json`,
        value: makeChecks({ candidateId: candidate.id, mode: "dark", unit: ordinary }),
      },
      {
        name: "main candidate mismatch",
        path: `light/states/${ordinary.id}/checks.json`,
        value: makeChecks({
          candidateId: "other-candidate",
          mode: "light",
          unit: ordinary,
          records: [{ candidateId: "other-candidate", mode: "light", result: "pass" }],
        }),
      },
      {
        name: "main unit mismatch",
        path: `light/states/${ordinary.id}/checks.json`,
        value: makeChecks({
          candidateId: candidate.id,
          mode: "light",
          unit: ordinary,
          overrides: { unitId: "other-unit" },
        }),
      },
      {
        name: "main state mismatch",
        path: `light/states/${ordinary.id}/checks.json`,
        value: makeChecks({
          candidateId: candidate.id,
          mode: "light",
          unit: ordinary,
          overrides: { stateId: "other-state" },
        }),
      },
      {
        name: "record candidate mismatch",
        path: `light/states/${ordinary.id}/checks.json`,
        value: makeChecks({
          candidateId: candidate.id,
          mode: "light",
          unit: ordinary,
          records: [{ candidateId: "other-candidate", mode: "light", result: "pass" }],
        }),
      },
      {
        name: "record mode mismatch",
        path: `light/states/${ordinary.id}/checks.json`,
        value: makeChecks({
          candidateId: candidate.id,
          mode: "light",
          unit: ordinary,
          records: [{ candidateId: candidate.id, mode: "dark", result: "pass" }],
        }),
      },
      {
        name: "timeline view mismatch",
        path: `light/states/${timeline.id}/checks.timeline-model.json`,
        value: makeChecks({ candidateId: candidate.id, mode: "light", unit: timeline, viewMode: "cost" }),
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const invalid = cases[index];
      const outDir = path.join(testRoot, `identity-case-${index}`);
      const captureResult = await validFiles(outDir, { path: invalid.path, value: invalid.value });
      if (invalid.isRaw) await writeChecks(outDir, invalid.path, invalid.value);
      await assert.rejects(readReviewCaptureChecks(argsFor(captureResult)), TypeError, invalid.name);
    }
  });
});

test("rejects unsafe or missing capture directories without creating them", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const outDir = path.join(testRoot, "path-check-output");
    await fs.promises.mkdir(outDir);
    const captureResult = makePartialCaptureResult(candidate, outDir, new Set());
    const args = { candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult };

    captureResult.outDir = "https://example.invalid/matrix";
    await assert.rejects(readReviewCaptureChecks(args), TypeError);
    captureResult.outDir = path.resolve(REPO_ROOT, "docs", "validation-escape");
    await assert.rejects(readReviewCaptureChecks(args), TypeError);

    const missingOutDir = path.join(testRoot, "not-created-output");
    captureResult.outDir = missingOutDir;
    await assert.rejects(readReviewCaptureChecks(args), (error) => error?.code === "ENOENT");
    assert.equal(fs.existsSync(missingOutDir), false);
  });
});

test("rejects an output directory whose realpath leaves docs/validation when junctions are available", async (t) => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const link = path.join(testRoot, "outdir-junction");
    try {
      await fs.promises.symlink(REPO_ROOT, link, "junction");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const captureResult = makePartialCaptureResult(candidate, link, new Set());
    await assert.rejects(
      readReviewCaptureChecks({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
      /realpath must be a strict child/,
    );
  });
});

test("rejects checks file symlinks when the platform permits creating them", async (t) => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const outDir = path.join(testRoot, "file-link-output");
    await fs.promises.mkdir(path.join(outDir, "light"), { recursive: true });
    const target = path.join(testRoot, "checks-target.json");
    await writeChecks(
      testRoot,
      "checks-target.json",
      makeChecks({ candidateId: candidate.id, mode: "light", unit: baseline, baseline: true }),
    );
    try {
      await fs.promises.symlink(target, path.join(outDir, "light", "checks.json"), "file");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const captureResult = makePartialCaptureResult(candidate, outDir, new Set([`light/${baseline.id}`]));
    await assert.rejects(
      readReviewCaptureChecks({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
      /must not be a symlink or junction/,
    );
  });
});

test("rejects checks reached through a parent junction escaping the verified output", async (t) => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const outDir = path.join(testRoot, "parent-link-output");
    await fs.promises.mkdir(outDir);
    const outsideModeDir = path.join(testRoot, "outside-mode");
    await fs.promises.mkdir(outsideModeDir);
    await writeChecks(
      outsideModeDir,
      "checks.json",
      makeChecks({ candidateId: candidate.id, mode: "light", unit: baseline, baseline: true }),
    );
    try {
      await fs.promises.symlink(outsideModeDir, path.join(outDir, "light"), "junction");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const captureResult = makePartialCaptureResult(candidate, outDir, new Set([`light/${baseline.id}`]));
    await assert.rejects(
      readReviewCaptureChecks({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
      /checks realpath escapes capture output/,
    );
  });
});

test("classifies a fully measured registered matrix as structural capture only", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const outDir = path.join(testRoot, "fully-measured-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    const beforeCapture = structuredClone(captureResult);
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const relativePaths = ["light", "dark"].flatMap((mode) =>
      units.flatMap((unit) => [
        checkRelativePath(mode, unit),
        ...(unit.kind === "baseline"
          ? []
          : (unit.timelineModeSequence ?? []).map((viewMode) => checkRelativePath(mode, unit, viewMode))),
      ]),
    );
    const fileBytesBefore = await Promise.all(
      relativePaths.map((relativePath) => fs.promises.readFile(path.join(outDir, ...relativePath.split("/")))),
    );
    const reader = await readReviewCaptureChecks({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    const classification = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });

    assert.equal(
      reader.entries.length,
      2 * (units.length + units.reduce((count, unit) => count + (unit.timelineModeSequence?.length ?? 0), 0)),
    );
    const noRoleProcedure = units.find((unit) => unit.kind !== "baseline" && unit.stateId == null);
    assert.ok(noRoleProcedure);
    assert.equal(
      reader.entries.some(
        (entry) => entry.unitId === noRoleProcedure.id && entry.mode === "light" && entry.checks.records.length === 0,
      ),
      true,
    );
    assert.deepEqual(classification, { status: "captured", exitCode: 0, errors: [], gaps: [] });
    assert.deepEqual(captureResult, beforeCapture);
    const fileBytesAfter = await Promise.all(
      relativePaths.map((relativePath) => fs.promises.readFile(path.join(outDir, ...relativePath.split("/")))),
    );
    for (let index = 0; index < fileBytesBefore.length; index += 1) {
      assert.deepEqual(fileBytesAfter[index], fileBytesBefore[index], relativePaths[index]);
    }
  });
});

test("classifies formal null-identity checks with the same captured result as an ordinary matrix", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const paths = ["light", "dark"].flatMap((mode) =>
      units.flatMap((unit) => [
        checkRelativePath(mode, unit),
        ...(unit.kind === "baseline"
          ? []
          : (unit.timelineModeSequence ?? []).map((view) => checkRelativePath(mode, unit, view))),
      ]),
    );
    const productionOut = path.join(testRoot, "production-classification-complete");
    const productionCapture = await makeFullyMeasuredProductionCapture(candidate, productionOut);
    const productionBefore = structuredClone(productionCapture);
    const productionBytesBefore = await Promise.all(
      paths.map((relativePath) => fs.promises.readFile(path.join(productionOut, ...relativePath.split("/")))),
    );
    const productionResult = await classifyProductionCapture({
      skinId: candidate.skinId,
      captureResult: productionCapture,
    });

    const ordinaryOut = path.join(testRoot, "ordinary-classification-complete");
    const ordinaryCapture = await makeFullyMeasuredCapture(candidate, ordinaryOut);
    const ordinaryResult = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult: ordinaryCapture,
    });

    assert.deepEqual(productionResult, { status: "captured", exitCode: 0, errors: [], gaps: [] });
    assert.deepEqual(productionResult, ordinaryResult, "both identity paths classify the same matrix identically");
    assert.deepEqual(productionCapture, productionBefore);
    assert.deepEqual(
      await Promise.all(
        paths.map((relativePath) => fs.promises.readFile(path.join(productionOut, ...relativePath.split("/")))),
      ),
      productionBytesBefore,
    );
  });
});

test("D8u3B4 offline classification requires both persisted headers and never trusts only one", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const fixtureUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.fixtureRequirement);

    for (const missing of ["capture", "progress"]) {
      const outDir = path.join(testRoot, `missing-${missing}-metadata`);
      const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
      await fs.promises.unlink(path.join(outDir, `${missing}.json`));

      const reader = await readReviewCaptureChecks({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      });
      const classification = await classifyReviewCapture({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      });
      assert.equal(reader.gaps.filter((gap) => gap.code === `missing-${missing}-metadata`).length, 1);
      assert.equal(classification.status, "incomplete");
      assert.ok(classification.gaps.some((gap) => gap.code === `missing-${missing}-metadata`));
      assert.ok(reader.entries.some((entry) => entry.relativePath === "light/checks.json"));
      assert.equal(
        reader.entries.some((entry) => entry.mode === "light" && entry.unitId === fixtureUnit.id),
        missing === "capture",
        "missing progress cannot authorize S8, while checks remain readable",
      );
    }

    for (const missing of ["capture", "progress"]) {
      const outDir = path.join(testRoot, `missing-${missing}-other-header-invalid`);
      const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
      const other = missing === "capture" ? "progress" : "capture";
      await fs.promises.unlink(path.join(outDir, `${missing}.json`));
      const otherPath = path.join(outDir, `${other}.json`);
      const header = JSON.parse(await fs.promises.readFile(otherPath, "utf8"));
      header.groups = ["S8"];
      await fs.promises.writeFile(otherPath, `${JSON.stringify(header)}\n`, "utf8");

      await assert.rejects(
        readReviewCaptureChecks({
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          captureResult,
        }),
        new RegExp(`${other}\\.json does not match`),
        `a missing ${missing}.json must not hide the invalid ${other}.json`,
      );
    }
  });
});

test("D8u3B4 offline classification rejects disk header drift and S8 proof forgery for both identities", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const fixtureUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.fixtureRequirement);
    const hashEvidenceTree = loadActualEvidenceHasher();

    const headerOut = path.join(testRoot, "header-drift-output");
    const headerCapture = await makeFullyMeasuredCapture(candidate, headerOut);
    const capturePath = path.join(headerOut, "capture.json");
    const progressPath = path.join(headerOut, "progress.json");
    const captureOriginal = await fs.promises.readFile(capturePath);
    const progressOriginal = await fs.promises.readFile(progressPath);
    const headerDrifts = [
      ["capture", (header) => (header.groups = ["S8"])],
      ["capture", (header) => (header.fixtureBindings.S8.fixtureHash = "0".repeat(64))],
      ["progress", (header) => (header.groups = ["S8"])],
      ["progress", (header) => (header.modes = ["light"])],
      ["progress", (header) => (header.digests.fixtureHash = "0".repeat(64))],
      ["progress", (header) => (header.digests.fixtureBindings.S8.fixtureHash = "0".repeat(64))],
    ];
    for (const [name, mutate] of headerDrifts) {
      await fs.promises.writeFile(capturePath, captureOriginal);
      await fs.promises.writeFile(progressPath, progressOriginal);
      const filePath = name === "capture" ? capturePath : progressPath;
      const header = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
      mutate(header);
      await fs.promises.writeFile(filePath, `${JSON.stringify(header)}\n`, "utf8");
      await assert.rejects(
        classifyReviewCapture({
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          captureResult: headerCapture,
        }),
        new RegExp(`${name}\\.json does not match`),
      );
    }

    for (const production of [false, true]) {
      for (const rehash of [false, true]) {
        const label = `${production ? "production" : "candidate"}-${rehash ? "rehash" : "stale-hash"}`;
        const outDir = path.join(testRoot, `fixture-proof-${label}`);
        const captureResult = production
          ? await makeFullyMeasuredProductionCapture(candidate, outDir)
          : await makeFullyMeasuredCapture(candidate, outDir);
        const unitDir = path.join(outDir, "light", "states", fixtureUnit.id);
        const statePath = path.join(unitDir, "state.json");
        const state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
        state.trace.fixtureRequirement.actualHash =
          state.trace.fixtureRequirement.expectedHash === "0".repeat(64) ? "f".repeat(64) : "0".repeat(64);
        await fs.promises.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
        if (rehash) {
          captureResult.progress.units[`light/${fixtureUnit.id}`].evidenceHash = await hashEvidenceTree(unitDir);
          await writeCaptureMetadata(outDir, captureResult);
        }

        const reader = production
          ? await readProductionCaptureChecks({ skinId: candidate.skinId, captureResult })
          : await readReviewCaptureChecks({
              candidateId: candidate.id,
              candidateHash: candidate.candidateHash,
              captureResult,
            });
        const classification = production
          ? await classifyProductionCapture({ skinId: candidate.skinId, captureResult })
          : await classifyReviewCapture({
              candidateId: candidate.id,
              candidateHash: candidate.candidateHash,
              captureResult,
            });
        assert.equal(
          reader.entries.some((entry) => entry.mode === "light" && entry.unitId === fixtureUnit.id),
          false,
          label,
        );
        assert.ok(
          reader.gaps.some((gap) => gap.code === "invalid-fixture-state-evidence" && gap.mode === "light"),
          label,
        );
        assert.equal(classification.status, "incomplete", label);
        assert.ok(
          classification.gaps.some((gap) => gap.code === "invalid-fixture-state-evidence"),
          label,
        );
      }
    }
  });
});

test("D8u3B4 offline classification keeps malformed S8 JSON, escaped attachments, and linked unit roots as hard errors", async (t) => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const fixtureUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.fixtureRequirement);
    const hashEvidenceTree = loadActualEvidenceHasher();

    const metadataOut = path.join(testRoot, "malformed-metadata-output");
    const metadataCapture = await makeFullyMeasuredCapture(candidate, metadataOut);
    const progressPath = path.join(metadataOut, "progress.json");
    await fs.promises.writeFile(progressPath, "{broken\n", "utf8");
    await assert.rejects(
      readReviewCaptureChecks({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult: metadataCapture,
      }),
      /invalid JSON in progress\.json/,
    );

    for (const kind of ["bad-json", "escaped-attachment"]) {
      const outDir = path.join(testRoot, `${kind}-output`);
      const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
      const unitDir = path.join(outDir, "light", "states", fixtureUnit.id);
      const statePath = path.join(unitDir, "state.json");
      if (kind === "bad-json") {
        await fs.promises.writeFile(statePath, "{broken\n", "utf8");
      } else {
        const state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
        state.files.outside = "../outside/state.json";
        await fs.promises.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
      }
      captureResult.progress.units[`light/${fixtureUnit.id}`].evidenceHash = await hashEvidenceTree(unitDir);
      await writeCaptureMetadata(outDir, captureResult);
      await assert.rejects(
        classifyReviewCapture({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
        kind === "bad-json" ? /JSON\s*损坏/ : /路径越界/,
        kind,
      );
    }

    const outDir = path.join(testRoot, "linked-unit-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    const unitDir = path.join(outDir, "light", "states", fixtureUnit.id);
    const redirectUnitDir = path.join(outDir, "light", "states", "redirect-target");
    await fs.promises.cp(unitDir, redirectUnitDir, { recursive: true });
    await fs.promises.rm(unitDir, { recursive: true, force: true });
    try {
      await fs.promises.symlink(redirectUnitDir, unitDir, "junction");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      classifyReviewCapture({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
      /symlink|junction/i,
    );
  });
});

test("formal exact failures in either mode outrank same-role passes and match ordinary diagnostics", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = requiredRolesForTestUnit(baseline)[0];

    for (const mode of ["light", "dark"]) {
      const productionOut = path.join(testRoot, `production-${mode}-failure`);
      const ordinaryOut = path.join(testRoot, `ordinary-${mode}-failure`);
      const productionCapture = await makeFullyMeasuredProductionCapture(candidate, productionOut);
      const ordinaryCapture = await makeFullyMeasuredCapture(candidate, ordinaryOut);
      const relativePath = checkRelativePath(mode, baseline);

      const addFailure = async (outDir) =>
        updateChecks(outDir, relativePath, (checks) => ({
          ...checks,
          records: checks.records.flatMap((record) => {
            if (record.roleId !== role.id) return [record];
            const failedRecord = {
              ...record,
              result: "fail",
              ratio: role.threshold - 0.001,
              reason: `${mode} formal failure`,
            };
            return mode === "light" ? [record, failedRecord] : [failedRecord];
          }),
        }));
      await addFailure(productionOut);
      await addFailure(ordinaryOut);

      const productionResult = await classifyProductionCapture({
        skinId: candidate.skinId,
        captureResult: productionCapture,
      });
      const ordinaryResult = await classifyReviewCapture({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult: ordinaryCapture,
      });
      assert.equal(productionResult.status, "failed", mode);
      assert.equal(productionResult.exitCode, 2, mode);
      assert.deepEqual(productionResult, ordinaryResult, `${mode} formal failure diagnostics`);
      assert.equal(
        productionResult.errors.some(
          (error) =>
            error.code === "required-role-fail" &&
            error.mode === mode &&
            error.unitId === baseline.id &&
            error.roleId === role.id &&
            error.viewMode === null &&
            error.detail.includes(`${mode} formal failure`),
        ),
        true,
        mode,
      );
    }
  });
});

test("formal approximate, unmeasured, not-applicable, absent roles, and missing files stay incomplete", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = requiredRolesForTestUnit(baseline)[0];
    const outDir = path.join(testRoot, "production-required-role-gaps");
    const captureResult = await makeFullyMeasuredProductionCapture(candidate, outDir);
    const relativePath = checkRelativePath("light", baseline);
    const filePath = path.join(outDir, ...relativePath.split("/"));
    const originalBytes = await fs.promises.readFile(filePath);
    const original = JSON.parse(originalBytes.toString("utf8"));
    const roleGaps = [
      [
        "missing role",
        (checks) => ({ ...checks, records: checks.records.filter((record) => record.roleId !== role.id) }),
      ],
      [
        "empty records",
        (checks) => ({ ...checks, records: [], counts: { pass: 0, fail: 0, unmeasured: 0, "not-applicable": 0 } }),
      ],
      [
        "unmeasured role",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id
              ? { ...record, result: "unmeasured", ratio: null, threshold: null, reason: "not measured" }
              : record,
          ),
        }),
      ],
      [
        "not-applicable role",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id
              ? { ...record, result: "not-applicable", ratio: null, threshold: null, reason: "not applicable" }
              : record,
          ),
        }),
      ],
      [
        "approximate-only role",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id ? { ...record, method: `${record.method}${APPROXIMATE_METHOD_SUFFIX}` } : record,
          ),
        }),
      ],
    ];

    for (const [label, mutate] of roleGaps) {
      await writeChecks(outDir, relativePath, mutate(structuredClone(original)));
      const result = await classifyProductionCapture({ skinId: candidate.skinId, captureResult });
      assert.equal(result.status, "incomplete", label);
      assert.equal(result.exitCode, 2, label);
      assert.equal(
        result.gaps.some(
          (gap) => gap.code === "required-role-missing" && gap.roleId === role.id && gap.mode === "light",
        ),
        true,
        label,
      );
    }

    await fs.promises.unlink(filePath);
    const missingFile = await classifyProductionCapture({ skinId: candidate.skinId, captureResult });
    assert.equal(missingFile.status, "incomplete");
    assert.equal(missingFile.exitCode, 2);
    assert.equal(
      missingFile.gaps.some((gap) => gap.code === "missing-checks" && gap.detail.endsWith(relativePath)),
      true,
    );
    assert.equal(missingFile.errors.length, 0);
    assert.equal(fs.existsSync(filePath), false);
    await fs.promises.writeFile(filePath, originalBytes);
    assert.deepEqual(await fs.promises.readFile(filePath), originalBytes);
  });
});

test("formal matrix gaps remain visible with passing checks and summary failures remain errors", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const outDir = path.join(testRoot, "production-summary-gaps");
    const complete = await makeFullyMeasuredProductionCapture(candidate, outDir);
    const firstState = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind !== "baseline");

    const missingGroup = structuredClone(complete);
    setCaptureMatrixGroups(missingGroup, missingGroup.capture.groups.slice(0, -1));
    await writeCaptureMetadata(outDir, missingGroup);
    const missingGroupResult = await classifyProductionCapture({
      skinId: candidate.skinId,
      captureResult: missingGroup,
    });
    assert.equal(missingGroupResult.status, "incomplete");
    assert.equal(missingGroupResult.exitCode, 2);
    assert.equal(missingGroupResult.gaps.filter((gap) => gap.code === "missing-group").length, 1);

    const missingState = structuredClone(complete);
    delete missingState.modes.dark.states[firstState.id];
    delete missingState.capture.modes.dark.states[firstState.id];
    await writeCaptureMetadata(outDir, missingState);
    const missingStateResult = await classifyProductionCapture({
      skinId: candidate.skinId,
      captureResult: missingState,
    });
    assert.equal(missingStateResult.status, "incomplete");
    assert.equal(
      missingStateResult.gaps.filter(
        (gap) => gap.code === "missing-state" && gap.mode === "dark" && gap.unitId === firstState.id,
      ).length,
      1,
    );

    const missingProgress = structuredClone(complete);
    delete missingProgress.progress.units[`light/${firstState.id}`];
    await writeCaptureMetadata(outDir, missingProgress);
    const missingProgressResult = await classifyProductionCapture({
      skinId: candidate.skinId,
      captureResult: missingProgress,
    });
    assert.equal(missingProgressResult.status, "incomplete");
    assert.equal(
      missingProgressResult.gaps.filter(
        (gap) => gap.code === "missing-progress-unit" && gap.mode === "light" && gap.unitId === firstState.id,
      ).length,
      1,
    );

    const summaryFailed = structuredClone(complete);
    summaryFailed.modes.dark.status = "failed";
    summaryFailed.capture.modes.dark.status = "failed";
    summaryFailed.modes.dark.blockers = ["formal matrix summary blocker"];
    summaryFailed.capture.modes.dark.blockers = ["formal matrix summary blocker"];
    await writeCaptureMetadata(outDir, summaryFailed);
    const summaryFailedResult = await classifyProductionCapture({
      skinId: candidate.skinId,
      captureResult: summaryFailed,
    });
    assert.equal(summaryFailedResult.status, "failed");
    assert.equal(summaryFailedResult.exitCode, 2);
    assert.equal(
      summaryFailedResult.errors.filter((error) => error.code === "failed-status" && error.mode === "dark").length,
      1,
    );
    assert.equal(
      summaryFailedResult.errors.filter((error) => error.detail === "formal matrix summary blocker").length,
      1,
    );
  });
});

test("classifies the main, model, and cost timeline entries independently", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const timeline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.timelineModeSequence);
    const role = requiredRolesForTestUnit(timeline)[0];
    const outDir = path.join(testRoot, "production-timeline-classification");
    const captureResult = await makeFullyMeasuredProductionCapture(candidate, outDir);
    const views = [null, "model", "cost"];

    for (const viewMode of views) {
      const relativePath = checkRelativePath("light", timeline, viewMode);
      const filePath = path.join(outDir, ...relativePath.split("/"));
      const originalBytes = await fs.promises.readFile(filePath);
      const original = JSON.parse(originalBytes.toString("utf8"));
      await writeChecks(outDir, relativePath, {
        ...original,
        records: original.records.map((record) =>
          record.roleId === role.id
            ? { ...record, result: "fail", ratio: role.threshold - 0.001, reason: `${viewMode ?? "main"} view failed` }
            : record,
        ),
      });
      const failedView = await classifyProductionCapture({ skinId: candidate.skinId, captureResult });
      assert.equal(failedView.status, "failed", `${viewMode ?? "main"} failure`);
      assert.equal(
        failedView.errors.some(
          (error) =>
            error.code === "required-role-fail" &&
            error.unitId === timeline.id &&
            error.roleId === role.id &&
            error.viewMode === viewMode,
        ),
        true,
        `${viewMode ?? "main"} failure is classified`,
      );

      await fs.promises.writeFile(filePath, originalBytes);
      await fs.promises.unlink(filePath);
      const missingView = await classifyProductionCapture({ skinId: candidate.skinId, captureResult });
      assert.equal(missingView.status, "incomplete", `${viewMode ?? "main"} missing file`);
      assert.equal(
        missingView.gaps.some((gap) => gap.code === "missing-checks" && gap.detail.endsWith(relativePath)),
        true,
        `${viewMode ?? "main"} missing gap`,
      );
      await fs.promises.writeFile(filePath, originalBytes);
    }
  });
});

test("formal classification validates every record and rejects ordinary or mixed identity spoofing", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = requiredRolesForTestUnit(baseline)[0];
    const outDir = path.join(testRoot, "production-invalid-records");
    const captureResult = await makeFullyMeasuredProductionCapture(candidate, outDir);
    const relativePath = checkRelativePath("light", baseline);
    const filePath = path.join(outDir, ...relativePath.split("/"));
    const originalBytes = await fs.promises.readFile(filePath);
    const original = JSON.parse(originalBytes.toString("utf8"));
    const invalidRecords = [
      ["unknown role", (record) => ({ ...record, roleId: "unknown.role" })],
      ["unknown result", (record) => ({ ...record, result: "almost-pass" })],
      ["wrong state", (record) => ({ ...record, stateId: "other-state" })],
      ["non-finite ratio", (record) => ({ ...record, ratio: Number.NaN })],
      ["non-finite threshold", (record) => ({ ...record, threshold: Number.POSITIVE_INFINITY })],
      ["threshold mismatch", (record) => ({ ...record, threshold: role.threshold + 1 })],
      ["result contradicts full precision", (record) => ({ ...record, result: "pass", ratio: role.threshold - 0.001 })],
    ];
    for (const [label, mutate] of invalidRecords) {
      await writeChecks(outDir, relativePath, {
        ...original,
        records: original.records.map((record) => (record.roleId === role.id ? mutate(record) : record)),
      });
      await assert.rejects(classifyProductionCapture({ skinId: candidate.skinId, captureResult }), TypeError, label);
    }
    await fs.promises.writeFile(filePath, originalBytes);

    const ordinaryCapture = structuredClone(captureResult);
    ordinaryCapture.capture.candidate = {
      id: candidate.id,
      candidateHash: candidate.candidateHash,
      skinId: candidate.skinId,
      variant: candidate.variant,
    };
    await assert.rejects(
      classifyProductionCapture({ skinId: candidate.skinId, captureResult: ordinaryCapture }),
      TypeError,
    );
    const mixedIdentity = structuredClone(captureResult);
    mixedIdentity.capture.candidate.id = null;
    mixedIdentity.capture.candidate.candidateHash = null;
    await assert.rejects(
      classifyProductionCapture({ skinId: candidate.skinId, captureResult: mixedIdentity }),
      TypeError,
    );
    assert.deepEqual(await fs.promises.readFile(filePath), originalBytes);
  });
});

test("a required role fail defeats its pass and captured screenshot statuses", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = requiredRolesForTestUnit(baseline)[0];
    const outDir = path.join(testRoot, "required-fail-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    const relativePath = checkRelativePath("light", baseline);
    await updateChecks(outDir, relativePath, (checks) => ({
      ...checks,
      records: checks.records.flatMap((record) =>
        record.roleId === role.id
          ? [record, { ...record, result: "fail", ratio: role.threshold - 0.001, reason: "retained failure reason" }]
          : [record],
      ),
    }));

    const result = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 2);
    assert.equal(
      result.errors.some(
        (error) =>
          error.code === "required-role-fail" &&
          error.roleId === role.id &&
          error.mode === "light" &&
          error.unitId === baseline.id &&
          error.viewMode === null &&
          error.detail.includes("retained failure reason"),
      ),
      true,
    );
  });
});

test("missing, unmeasured, not-applicable, and approximate-only necessary roles remain incomplete", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = requiredRolesForTestUnit(baseline)[0];
    const outDir = path.join(testRoot, "required-gaps-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    const relativePath = checkRelativePath("light", baseline);
    const original = JSON.parse(await fs.promises.readFile(path.join(outDir, ...relativePath.split("/")), "utf8"));
    const incompleteEvidence = [
      ["missing", (checks) => ({ ...checks, records: checks.records.filter((record) => record.roleId !== role.id) })],
      [
        "unmeasured",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id
              ? { ...record, result: "unmeasured", ratio: null, threshold: null, reason: "not measured" }
              : record,
          ),
        }),
      ],
      [
        "not-applicable",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id
              ? {
                  ...record,
                  result: "not-applicable",
                  ratio: null,
                  threshold: null,
                  reason: "cannot waive required role",
                }
              : record,
          ),
        }),
      ],
      [
        "approximate pass",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id ? { ...record, method: `fast${APPROXIMATE_METHOD_SUFFIX}` } : record,
          ),
        }),
      ],
      [
        "approximate fail",
        (checks) => ({
          ...checks,
          records: checks.records.map((record) =>
            record.roleId === role.id
              ? {
                  ...record,
                  result: "fail",
                  ratio: role.threshold - 0.01,
                  method: `fast${APPROXIMATE_METHOD_SUFFIX}`,
                }
              : record,
          ),
        }),
      ],
    ];

    for (const [label, update] of incompleteEvidence) {
      await writeChecks(outDir, relativePath, update(structuredClone(original)));
      const result = await classifyReviewCapture({
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      });
      assert.equal(result.status, "incomplete", label);
      assert.equal(result.exitCode, 2, label);
      const gap = result.gaps.find((entry) => entry.code === "required-role-missing" && entry.roleId === role.id);
      assert.ok(gap, label);
      assert.equal(gap.viewMode, null, label);
      if (label === "missing") assert.equal(gap.detail.includes("no record"), true, label);
      else if (label.startsWith("approximate")) assert.equal(gap.detail.includes("approximate"), true, label);
      else if (label === "unmeasured") assert.equal(gap.detail.includes("not measured"), true, label);
      else assert.equal(gap.detail.includes("cannot waive required role"), true, label);
    }
    await writeChecks(outDir, relativePath, original);

    const decorativeRoleId = "logotype.agent-usage";
    const decorativeRole = ROLE_CATALOG.find((entry) => entry.id === decorativeRoleId);
    assert.ok(decorativeRole && (decorativeRole.required !== true || !Number.isFinite(decorativeRole.threshold)));
    const stateId = "dashboard-default";
    await writeChecks(
      outDir,
      relativePath,
      makeChecks({
        candidateId: candidate.id,
        mode: "light",
        unit: baseline,
        baseline: true,
        records: [
          {
            candidateId: candidate.id,
            mode: "light",
            roleId: decorativeRoleId,
            stateId,
            result: "not-applicable",
            ratio: null,
            threshold: null,
            reason: "decorative record does not satisfy body readability",
          },
        ],
      }),
    );
    const decorativeOnly = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(decorativeOnly.status, "incomplete");
    assert.equal(
      decorativeOnly.gaps.some((gap) => gap.roleId === role.id && gap.code === "required-role-missing"),
      true,
    );
  });
});

test("evaluates model and cost timeline entries independently", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const timeline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.timelineModeSequence);
    const role = requiredRolesForTestUnit(timeline)[0];
    assert.ok(role, "timeline state has a required role");
    const outDir = path.join(testRoot, "timeline-classification-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    const modelPath = checkRelativePath("light", timeline, "model");
    const costPath = checkRelativePath("light", timeline, "cost");
    const modelOriginal = JSON.parse(await fs.promises.readFile(path.join(outDir, ...modelPath.split("/")), "utf8"));
    const costOriginal = JSON.parse(await fs.promises.readFile(path.join(outDir, ...costPath.split("/")), "utf8"));

    await writeChecks(outDir, modelPath, {
      ...modelOriginal,
      records: modelOriginal.records.map((record) =>
        record.roleId === role.id
          ? { ...record, result: "fail", ratio: role.threshold - 0.01, reason: "model-only failure" }
          : record,
      ),
    });
    const modelFailure = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(modelFailure.status, "failed");
    assert.equal(
      modelFailure.errors.some((error) => error.roleId === role.id && error.viewMode === "model"),
      true,
    );
    assert.equal(
      modelFailure.errors.some((error) => error.roleId === role.id && error.viewMode === "cost"),
      false,
    );

    await writeChecks(outDir, modelPath, modelOriginal);
    await writeChecks(outDir, costPath, {
      ...costOriginal,
      records: costOriginal.records.filter((record) => record.roleId !== role.id),
    });
    const costGap = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(costGap.status, "incomplete");
    assert.equal(
      costGap.gaps.some((gap) => gap.roleId === role.id && gap.viewMode === "cost"),
      true,
    );
  });
});

test("keeps summary failures and gaps, with failures taking precedence over missing roles", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = requiredRolesForTestUnit(baseline)[0];
    const outDir = path.join(testRoot, "summary-precedence-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    captureResult.modes.light.gaps.push({
      unitId: baseline.id,
      stateId: "dashboard-default",
      reason: "preserve original capture gap",
    });
    await writeCaptureMetadata(outDir, captureResult);
    await updateChecks(outDir, checkRelativePath("light", baseline), (checks) => ({
      ...checks,
      records: checks.records.map((record) =>
        record.roleId === role.id
          ? { ...record, result: "fail", ratio: role.threshold - 0.01, reason: "required role failed" }
          : record,
      ),
    }));
    const failedWithGap = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(failedWithGap.status, "failed");
    assert.equal(
      failedWithGap.gaps.filter(
        (gap) => gap.code === "capture-gap" && gap.detail.includes("preserve original capture gap"),
      ).length,
      1,
    );

    const summaryFailedCapture = await makeFullyMeasuredCapture(
      candidate,
      path.join(testRoot, "summary-failed-output"),
    );
    summaryFailedCapture.modes.dark.status = "failed";
    summaryFailedCapture.modes.dark.blockers = ["matrix mode failed"];
    await writeCaptureMetadata(path.join(testRoot, "summary-failed-output"), summaryFailedCapture);
    const summaryFailed = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult: summaryFailedCapture,
    });
    assert.equal(summaryFailed.status, "failed");
    assert.equal(summaryFailed.exitCode, 2);
    assert.equal(
      summaryFailed.errors.some((error) => error.code === "failed-status"),
      true,
    );
    assert.equal(
      summaryFailed.errors.some((error) => error.detail === "matrix mode failed"),
      true,
    );
  });
});

test("rejects unknown roles/results, wrong states, non-finite values, threshold drift, and rounded passes", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind === "baseline");
    const role = ROLE_CATALOG.find((entry) => entry.id === "page.body-text");
    assert.equal(role.threshold, 4.5);
    const outDir = path.join(testRoot, "malformed-classification-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);
    const relativePath = checkRelativePath("light", baseline);
    const original = JSON.parse(await fs.promises.readFile(path.join(outDir, ...relativePath.split("/")), "utf8"));
    const cases = [
      ["unknown role", (record) => ({ ...record, roleId: "unknown.role" })],
      ["unknown result", (record) => ({ ...record, result: "almost-pass" })],
      ["wrong state", (record) => ({ ...record, stateId: "other-state" })],
      ["NaN ratio", (record) => ({ ...record, ratio: Number.NaN })],
      ["infinite ratio", (record) => ({ ...record, ratio: Number.POSITIVE_INFINITY })],
      ["NaN threshold", (record) => ({ ...record, threshold: Number.NaN })],
      ["infinite threshold", (record) => ({ ...record, threshold: Number.POSITIVE_INFINITY })],
      ["wrong directory threshold", (record) => ({ ...record, threshold: 3 })],
      ["rounded false pass", (record) => ({ ...record, result: "pass", ratio: 4.499, threshold: 4.5 })],
    ];
    for (const [label, mutate] of cases) {
      const record = original.records.find((entry) => entry.roleId === role.id);
      await writeChecks(outDir, relativePath, {
        ...original,
        records: original.records.map((entry) => (entry.roleId === role.id ? mutate(record) : entry)),
      });
      await assert.rejects(
        classifyReviewCapture({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
        TypeError,
        label,
      );
    }

    await writeChecks(outDir, relativePath, original);
    const captureResultBefore = structuredClone(captureResult);
    const checksBytesBefore = await fs.promises.readFile(path.join(outDir, ...relativePath.split("/")));
    const success = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(success.status, "captured");
    assert.deepEqual(captureResult, captureResultBefore);
    assert.deepEqual(await fs.promises.readFile(path.join(outDir, ...relativePath.split("/"))), checksBytesBefore);
  });
});

test("D5：autorefresh-on 只接受独立状态证据，缺测不借用基线 PASS", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const role = ROLE_CATALOG.find((entry) => entry.id === "toggle.autorefresh-on");
    const unit = STATE_MATRIX_GROUPS.find((group) => group.id === "S1").units.find(
      (entry) => entry.id === "autorefresh-on",
    );
    const baseline = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((entry) => entry.kind === "baseline");
    const outDir = path.join(testRoot, "autorefresh-on-identity-output");
    const captureResult = await makeFullyMeasuredCapture(candidate, outDir);

    assert.equal(unit.kind, "catalog");
    assert.equal(unit.stateId, "autorefresh-on");
    assert.equal("preSteps" in unit, false);
    assert.equal(STATE_MATRIX_GROUPS.flatMap((group) => group.units).length, 46);

    const onPath = checkRelativePath("light", unit);
    const onFile = path.join(outDir, ...onPath.split("/"));
    const checks = JSON.parse(await fs.promises.readFile(onFile, "utf8"));
    assert.equal(checks.stateId, "autorefresh-on");
    assert.equal(checks.unitId, unit.id);
    assert.deepEqual(
      checks.records.map((record) => [record.roleId, record.stateId]),
      [[role.id, "autorefresh-on"]],
    );

    const baselinePath = path.join(outDir, ...checkRelativePath("light", baseline).split("/"));
    const baselineChecks = JSON.parse(await fs.promises.readFile(baselinePath, "utf8"));
    assert.equal(
      baselineChecks.records.some((record) => record.roleId === role.id),
      false,
    );

    const missingOnRecord = {
      ...checks,
      records: checks.records.map((record) => ({
        ...record,
        result: "unmeasured",
        ratio: null,
        reason: "not measured",
      })),
      counts: { pass: 0, fail: 0, unmeasured: checks.records.length, "not-applicable": 0 },
    };
    await writeChecks(outDir, onPath, missingOnRecord);
    const incomplete = await classifyReviewCapture({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.equal(incomplete.status, "incomplete");
    assert.ok(incomplete.gaps.some((gap) => gap.unitId === unit.id && gap.roleId === role.id));

    for (const [label, wrongChecks] of [
      [
        "old checks state",
        {
          ...checks,
          stateId: "dashboard-default",
          records: checks.records.map((record) => ({ ...record, stateId: "dashboard-default" })),
        },
      ],
      [
        "old role record state",
        { ...checks, records: checks.records.map((record) => ({ ...record, stateId: "dashboard-default" })) },
      ],
    ]) {
      await writeChecks(outDir, onPath, wrongChecks);
      await assert.rejects(
        classifyReviewCapture({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult }),
        TypeError,
        label,
      );
    }
  });
});

test("writes a one-candidate shard bound to verified disk metadata without changing its inputs", async () => {
  await withRun(async ({ candidateSet, outDir, runDir, runArg }) => {
    const candidate = candidateSet.candidates[0];
    const captureResult = makeCompleteCaptureResult(candidate, outDir);
    await writeCaptureMetadata(outDir, captureResult);
    const totalIndexPath = path.join(runDir, "captures-index.json");
    const totalIndexBytes = Buffer.from('{"schemaVersion":1,"captures":{"old":"../old-output"}}\n');
    await fs.promises.writeFile(totalIndexPath, totalIndexBytes);
    const candidateBytes = await fs.promises.readFile(path.join(runDir, "candidates.json"));
    const captureBytes = await fs.promises.readFile(path.join(outDir, "capture.json"));
    const progressBytes = await fs.promises.readFile(path.join(outDir, "progress.json"));
    const captureBefore = structuredClone(captureResult);
    const relativePath = path.relative(runDir, outDir).split(path.sep).join("/");

    const result = await writeReviewCaptureIndexShard({
      runDir: runArg,
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });

    const expectedIndex = { schemaVersion: 1, captures: { [candidate.id]: relativePath } };
    assert.match(relativePath, /^\.\.\//);
    assert.deepEqual(result.index, expectedIndex);
    assert.deepEqual(Object.keys(result.index).sort(), ["captures", "schemaVersion"]);
    assert.deepEqual(Object.keys(result.index.captures), [candidate.id]);
    assert.equal(result.shardPath, path.join(outDir, "capture-index-shard.json"));
    assert.deepEqual(JSON.parse(await fs.promises.readFile(result.shardPath, "utf8")), expectedIndex);
    assert.deepEqual(captureResult, captureBefore);
    assert.deepEqual(await fs.promises.readFile(path.join(runDir, "candidates.json")), candidateBytes);
    assert.deepEqual(await fs.promises.readFile(path.join(outDir, "capture.json")), captureBytes);
    assert.deepEqual(await fs.promises.readFile(path.join(outDir, "progress.json")), progressBytes);
    assert.deepEqual(await fs.promises.readFile(totalIndexPath), totalIndexBytes);
  });
});

test("reuses an equivalent existing shard without reserializing its original bytes", async () => {
  await withRun(async ({ candidateSet, outDir, runDir, runArg }) => {
    const candidate = candidateSet.candidates[0];
    const captureResult = makeCompleteCaptureResult(candidate, outDir);
    await writeCaptureMetadata(outDir, captureResult);
    const relativePath = path.relative(runDir, outDir).split(path.sep).join("/");
    const expectedIndex = { schemaVersion: 1, captures: { [candidate.id]: relativePath } };
    const shardPath = path.join(outDir, "capture-index-shard.json");
    const originalShard = Buffer.from(`${JSON.stringify(expectedIndex, null, 4)}\r\n`);
    await fs.promises.writeFile(shardPath, originalShard);

    const result = await writeReviewCaptureIndexShard({
      runDir: runArg,
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult,
    });
    assert.deepEqual(result.index, expectedIndex);
    assert.deepEqual(await fs.promises.readFile(shardPath), originalShard);
  });
});

test("allows idempotent reuse only when the stored shard binding is identical", async () => {
  await withRun(async ({ candidateSet, outDir, runArg }) => {
    const candidate = candidateSet.candidates[0];
    const captureResult = makeCompleteCaptureResult(candidate, outDir);
    await writeCaptureMetadata(outDir, captureResult);
    const args = { runDir: runArg, candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult };
    const first = await writeReviewCaptureIndexShard(args);
    const bytesBefore = await fs.promises.readFile(first.shardPath);

    const second = await writeReviewCaptureIndexShard(args);

    assert.deepEqual(second, first);
    assert.deepEqual(await fs.promises.readFile(first.shardPath), bytesBefore);
  });
});

test("registers valid failed and incomplete captures without changing their classification", async () => {
  await withRun(async ({ candidateSet, runArg, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    for (const status of ["failed", "incomplete"]) {
      const outDir = path.join(testRoot, `${status}-capture`);
      const captureResult = makeCompleteCaptureResult(candidate, outDir);
      captureResult.modes.light.status = status;
      if (status === "incomplete") captureResult.modes.light.reason = "fixture intentionally incomplete";
      const summarize = () =>
        summarizeReviewCapture({ candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult });
      const statusBefore = summarize().status;
      await writeCaptureMetadata(outDir, captureResult);

      const result = await writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      });

      assert.equal(statusBefore, status);
      assert.equal(summarize().status, status);
      assert.equal(
        result.index.captures[candidate.id],
        path.relative(path.join(testRoot, "source-run"), outDir).split(path.sep).join("/"),
      );
    }
  });
});

test("rejects candidate, capture.json, and progress.json identity drift before writing a shard", async () => {
  await withRun(async ({ candidateSet, candidateId, outDir, runArg }) => {
    const candidate = candidateSet.candidates[0];
    const captureResult = makeCompleteCaptureResult(candidate, outDir);
    await writeCaptureMetadata(outDir, captureResult);
    const args = { runDir: runArg, candidateId, candidateHash: candidate.candidateHash, captureResult };

    await assert.rejects(writeReviewCaptureIndexShard({ ...args, candidateId: "unknown-candidate" }), TypeError);
    await assert.rejects(writeReviewCaptureIndexShard({ ...args, candidateHash: "f".repeat(64) }), TypeError);

    captureResult.capture.unpersistedMarker = true;
    await assert.rejects(writeReviewCaptureIndexShard(args), /capture\.json does not match/);
    delete captureResult.capture.unpersistedMarker;

    captureResult.progress.unpersistedMarker = true;
    await assert.rejects(writeReviewCaptureIndexShard(args), /progress\.json does not match/);
    delete captureResult.progress.unpersistedMarker;
    assert.equal(fs.existsSync(path.join(outDir, "capture-index-shard.json")), false);
  });
});

test("rejects missing metadata, missing directories, validation roots, and run/output aliasing", async () => {
  await withRun(async ({ candidateSet, candidateId, outDir, runDir, runArg, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    for (const missingName of ["capture.json", "progress.json"]) {
      const missingOut = path.join(testRoot, `missing-${missingName}`);
      const captureResult = makeCompleteCaptureResult(candidate, missingOut);
      await writeCaptureMetadata(missingOut, captureResult);
      await fs.promises.rm(path.join(missingOut, missingName));
      await assert.rejects(
        writeReviewCaptureIndexShard({
          runDir: runArg,
          candidateId,
          candidateHash: candidate.candidateHash,
          captureResult,
        }),
        TypeError,
        missingName,
      );
    }

    const missingOutput = makeCompleteCaptureResult(candidate, path.join(testRoot, "does-not-exist"));
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId,
        candidateHash: candidate.candidateHash,
        captureResult: missingOutput,
      }),
    );
    const validFiles = makeCompleteCaptureResult(candidate, outDir);
    await writeCaptureMetadata(outDir, validFiles);
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: path.join(testRoot, "missing-run"),
        candidateId,
        candidateHash: candidate.candidateHash,
        captureResult: validFiles,
      }),
    );
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: validationRoot,
        candidateId,
        candidateHash: candidate.candidateHash,
        captureResult: validFiles,
      }),
      TypeError,
    );

    const outputAtValidationRoot = { ...validFiles, outDir: validationRoot };
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId,
        candidateHash: candidate.candidateHash,
        captureResult: outputAtValidationRoot,
      }),
      TypeError,
    );
    const outputOutsideValidation = { ...validFiles, outDir: REPO_ROOT };
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId,
        candidateHash: candidate.candidateHash,
        captureResult: outputOutsideValidation,
      }),
      TypeError,
    );
    const runAsOutput = { ...validFiles, outDir: runDir };
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId,
        candidateHash: candidate.candidateHash,
        captureResult: runAsOutput,
      }),
      /cannot be the run directory/,
    );
    assert.equal(fs.existsSync(path.join(runDir, "capture-index-shard.json")), false);
  });
});

test("rejects a different existing binding, malformed JSON, and unsupported shard shapes without overwriting", async () => {
  await withRun(async ({ candidateSet, runArg, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    for (const [label, original] of [
      ["different-binding", JSON.stringify({ schemaVersion: 1, captures: { [candidate.id]: "../another-output" } })],
      ["malformed-json", "{"],
      ["unsupported-shape", JSON.stringify({ schemaVersion: 1, captures: {}, extra: true })],
    ]) {
      const outDir = path.join(testRoot, `shard-${label}`);
      const captureResult = makeCompleteCaptureResult(candidate, outDir);
      await writeCaptureMetadata(outDir, captureResult);
      const shardPath = path.join(outDir, "capture-index-shard.json");
      const originalBytes = Buffer.from(`${original}\n`);
      await fs.promises.writeFile(shardPath, originalBytes);

      await assert.rejects(
        writeReviewCaptureIndexShard({
          runDir: runArg,
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          captureResult,
        }),
        TypeError,
        label,
      );
      assert.deepEqual(await fs.promises.readFile(shardPath), originalBytes, label);
    }
  });
});

test("rejects a symlink shard when file symlinks are supported", async (t) => {
  await withRun(async ({ candidateSet, outDir, runArg, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const captureResult = makeCompleteCaptureResult(candidate, outDir);
    await writeCaptureMetadata(outDir, captureResult);
    const shardPath = path.join(outDir, "capture-index-shard.json");
    const targetPath = path.join(testRoot, "shard-target.json");
    await fs.promises.writeFile(targetPath, "{}\n");
    try {
      await fs.promises.symlink(targetPath, shardPath, "file");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      }),
      /must not be a symlink/,
    );
  });
});

test("rejects run and output directory junctions that escape docs/validation", async (t) => {
  await withRun(async ({ candidateSet, outDir, runArg, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const captureResult = makeCompleteCaptureResult(candidate, outDir);
    const runJunction = path.join(testRoot, "escaped-run-junction");
    const outputParentJunction = path.join(testRoot, "escaped-output-junction");
    try {
      await fs.promises.symlink(REPO_ROOT, runJunction, "junction");
      await fs.promises.symlink(REPO_ROOT, outputParentJunction, "junction");
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runJunction,
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult,
      }),
      /resolves outside rootDir\/docs\/validation/,
    );
    const escapedOutput = { ...captureResult, outDir: path.join(outputParentJunction, "public") };
    await assert.rejects(
      writeReviewCaptureIndexShard({
        runDir: runArg,
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        captureResult: escapedOutput,
      }),
      /realpath must be a strict child/,
    );
  });
});

test("D8u3B3: actual S0 and state/timeline writers normalize only new production identities", async () => {
  await withRun(async ({ candidateSet, testRoot }) => {
    const candidate = candidateSet.candidates[0];
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
    const baseline = units.find((unit) => unit.kind === "baseline");
    const ordinary = units.find((unit) => unit.kind !== "baseline" && !unit.timelineModeSequence);
    const timeline = units.find((unit) => Array.isArray(unit.timelineModeSequence));
    const empty = units.find((unit) => unit.kind !== "baseline" && unit.stateId == null);
    assert.ok(baseline && ordinary && timeline && empty);

    const makeMeasurement = (ids, diagnosticCandidateId = OFFICIAL_CANDIDATE_ID) => ({
      records: ids.map((id) => ({
        candidateId: id,
        mode: "light",
        roleId: "role.example",
        result: "unmeasured",
        ratio: null,
        threshold: 4.5,
        color: "#123456",
      })),
      diagnostics: {
        ...(diagnosticCandidateId === undefined ? {} : { candidateId: diagnosticCandidateId }),
        source: "synthetic-offline-writer-regression",
        counts: { pass: 0, fail: 0, unmeasured: ids.length },
      },
      captures: [],
    });
    const s0Measurement = makeMeasurement([OFFICIAL_CANDIDATE_ID, null]);
    const s0MeasurementBefore = structuredClone(s0Measurement);
    const candidateS0Measurement = makeMeasurement([candidate.id], candidate.id);
    const candidateS0MeasurementBefore = structuredClone(candidateS0Measurement);
    const { runBaselineCapture, writeUnitEvidence } = loadActualCaptureWriters(
      async ({ candidate: captureCandidate }) => (captureCandidate === null ? s0Measurement : candidateS0Measurement),
    );
    const outDir = path.join(testRoot, "d8u3b3-production-writer-output");
    const capturedKeys = new Set([
      `light/${baseline.id}`,
      `light/${ordinary.id}`,
      `light/${timeline.id}`,
      `light/${empty.id}`,
    ]);
    const captureResult = asProductionCaptureResult(makePartialCaptureResult(candidate, outDir, capturedKeys));

    const probe = {
      unrenderedMetrics: 1,
      declarations: {},
      dataset: {},
      backgrounds: {},
      stylesheets: [],
    };
    const runBaseline = ({ candidate: captureCandidate, outModeDir }) =>
      runBaselineCapture({
        ctx: {
          page: {
            async goto() {},
            async evaluate(source) {
              return source === "layout" ? { height: 900 } : { ...probe };
            },
            async screenshot() {
              return Buffer.from("first-screen");
            },
          },
          errors: [],
          counters: { moduleRequestCount: 1, pricingRefreshInterceptions: 0 },
          heldRoutes: [{}],
          firstModuleRequestHeld: Promise.resolve(),
          previewUrl: "http://preview.invalid/",
          releaseHeldRoutes: async () => undefined,
        },
        mode: "light",
        skinId: candidate.skinId,
        candidate: captureCandidate,
        expectedPairs: [],
        outModeDir,
        stateTimeoutMs: 50,
        policy: {},
        measureRoles: true,
        captureEvidence: true,
        restingPointer: true,
      });
    const baselineCapture = await runBaseline({ candidate: null, outModeDir: path.join(outDir, "light") });
    assert.equal(baselineCapture.status, "captured");

    const ordinaryMeasurement = makeMeasurement([OFFICIAL_CANDIDATE_ID]);
    const timelineMainMeasurement = makeMeasurement([OFFICIAL_CANDIDATE_ID]);
    const timelineModelMeasurement = makeMeasurement([OFFICIAL_CANDIDATE_ID]);
    const timelineCostMeasurement = makeMeasurement([OFFICIAL_CANDIDATE_ID], null);
    const emptyMeasurement = {
      records: [],
      diagnostics: { source: "empty-role-unit", counts: { pass: 0, fail: 0, unmeasured: 0 } },
      captures: [],
    };
    const unitMeasurementInputs = [
      ordinaryMeasurement,
      timelineMainMeasurement,
      timelineModelMeasurement,
      timelineCostMeasurement,
      emptyMeasurement,
    ];
    const unitMeasurementInputsBefore = structuredClone(unitMeasurementInputs);
    await writeUnitEvidence({
      unitDir: path.join(outDir, "light", "states", ordinary.id),
      unit: ordinary,
      mode: "light",
      skinId: candidate.skinId,
      payload: { status: "captured", stateId: ordinary.stateId ?? null, measurement: ordinaryMeasurement },
      candidateId: null,
    });
    await writeUnitEvidence({
      unitDir: path.join(outDir, "light", "states", timeline.id),
      unit: timeline,
      mode: "light",
      skinId: candidate.skinId,
      payload: {
        status: "captured",
        stateId: timeline.stateId ?? null,
        measurement: timelineMainMeasurement,
        timelineModeMeasurements: { model: timelineModelMeasurement, cost: timelineCostMeasurement },
      },
      candidateId: null,
    });
    await writeUnitEvidence({
      unitDir: path.join(outDir, "light", "states", empty.id),
      unit: empty,
      mode: "light",
      skinId: candidate.skinId,
      payload: { status: "captured", stateId: null, measurement: emptyMeasurement },
      candidateId: null,
    });

    const productionChecks = await readProductionCaptureChecks({ skinId: candidate.skinId, captureResult });
    assert.deepEqual(
      productionChecks.entries.map((entry) => entry.relativePath),
      [
        "light/checks.json",
        `light/states/${ordinary.id}/checks.json`,
        `light/states/${timeline.id}/checks.json`,
        `light/states/${timeline.id}/checks.timeline-model.json`,
        `light/states/${timeline.id}/checks.timeline-cost.json`,
        `light/states/${empty.id}/checks.json`,
      ],
    );
    assert.ok(productionChecks.entries.every(({ checks }) => checks.candidateId === null));
    assert.ok(
      productionChecks.entries.every(({ checks }) => checks.records.every((record) => record.candidateId === null)),
    );
    assert.equal(productionChecks.entries[0].checks.diagnostics.candidateId, null);
    assert.equal(productionChecks.entries[0].checks.diagnostics.source, "synthetic-offline-writer-regression");
    assert.deepEqual(productionChecks.entries[0].checks.diagnostics.counts, s0Measurement.diagnostics.counts);
    assert.equal(productionChecks.entries[0].checks.records[0].color, "#123456");
    const emptyChecks = productionChecks.entries.at(-1).checks;
    assert.deepEqual(emptyChecks.records, []);
    assert.equal(emptyChecks.diagnostics.source, "empty-role-unit");
    assert.equal(Object.hasOwn(emptyChecks.diagnostics, "candidateId"), false);
    assert.ok(productionChecks.gaps.some((gap) => gap.code === "status-incomplete"));
    assert.deepEqual(s0Measurement, s0MeasurementBefore, "writer leaves low-level measurement input unchanged");
    assert.deepEqual(
      unitMeasurementInputs,
      unitMeasurementInputsBefore,
      "state/timeline writers leave inputs unchanged",
    );
    assert.equal(timelineCostMeasurement.diagnostics.candidateId, null);

    const candidateOutDir = path.join(testRoot, "d8u3b3-candidate-writer-output");
    const candidateCapture = makePartialCaptureResult(candidate, candidateOutDir, new Set([`light/${ordinary.id}`]));
    const candidateMeasurement = makeMeasurement([candidate.id], candidate.id);
    const candidateMeasurementBefore = structuredClone(candidateMeasurement);
    await writeUnitEvidence({
      unitDir: path.join(candidateOutDir, "light", "states", ordinary.id),
      unit: ordinary,
      mode: "light",
      skinId: candidate.skinId,
      payload: { status: "captured", stateId: ordinary.stateId ?? null, measurement: candidateMeasurement },
      candidateId: candidate.id,
    });
    const candidateChecks = await readReviewCaptureChecks({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult: candidateCapture,
    });
    assert.equal(candidateChecks.entries.length, 1);
    assert.equal(candidateChecks.entries[0].checks.candidateId, candidate.id);
    assert.ok(candidateChecks.entries[0].checks.records.every((record) => record.candidateId === candidate.id));
    assert.deepEqual(
      candidateMeasurement,
      candidateMeasurementBefore,
      "candidate writer leaves measurement input unchanged",
    );

    const candidateS0OutDir = path.join(testRoot, "d8u3b3-candidate-s0-output");
    const candidateS0Capture = makePartialCaptureResult(
      candidate,
      candidateS0OutDir,
      new Set([`light/${baseline.id}`]),
    );
    const candidateS0Result = await runBaseline({
      candidate,
      outModeDir: path.join(candidateS0OutDir, "light"),
    });
    assert.equal(candidateS0Result.status, "captured");
    assert.deepEqual(candidateS0Measurement, candidateS0MeasurementBefore);
    const candidateS0Checks = await readReviewCaptureChecks({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      captureResult: candidateS0Capture,
    });
    assert.equal(candidateS0Checks.entries[0].checks.candidateId, candidate.id);
    assert.ok(candidateS0Checks.entries[0].checks.records.every((record) => record.candidateId === candidate.id));

    const sparseMeasurement = makeMeasurement([]);
    sparseMeasurement.records.length = 1;
    const invalidMeasurements = [
      ["foreign production identity", makeMeasurement(["another-candidate"]), null],
      ["mixed production identities", makeMeasurement([OFFICIAL_CANDIDATE_ID, "another-candidate"]), null],
      ["missing production record identity", { ...makeMeasurement([]), records: [{ mode: "light" }] }, null],
      ["sparse production record identity", sparseMeasurement, null],
      ["foreign candidate identity", makeMeasurement(["another-candidate"], candidate.id), candidate.id],
      ["mixed candidate identities", makeMeasurement([candidate.id, "another-candidate"], candidate.id), candidate.id],
      ["missing candidate record identity", { ...makeMeasurement([]), records: [{ mode: "light" }] }, candidate.id],
      ["foreign diagnostics identity", makeMeasurement([OFFICIAL_CANDIDATE_ID], "another-candidate"), null],
    ];
    for (const [index, [label, measurement, id]] of invalidMeasurements.entries()) {
      const invalidDir = path.join(testRoot, `d8u3b3-invalid-${index}`);
      await assert.rejects(
        writeUnitEvidence({
          unitDir: invalidDir,
          unit: ordinary,
          mode: "light",
          skinId: candidate.skinId,
          payload: { status: "captured", stateId: ordinary.stateId ?? null, measurement },
          candidateId: id,
        }),
        TypeError,
        label,
      );
      assert.equal(fs.existsSync(invalidDir), false, `${label}: reject before writing evidence`);
    }
  });
});
