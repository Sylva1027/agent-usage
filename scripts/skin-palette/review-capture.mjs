import path from "node:path";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { APPROXIMATE_METHOD_SUFFIX } from "./assess.mjs";
import {
  assertCaptureOutputDir,
  assertFixedMatrixFixtureBindings,
  buildFixedMatrixFixtureBindings,
  captureStateMatrix,
  readCapturedUnitEvidence,
  STATE_MATRIX_GROUPS,
} from "./capture.mjs";
import { loadPreviewCandidate } from "./review-cli.mjs";
import { REPO_ROOT } from "./review-evidence.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "./roles.mjs";
import { SKIN_IDS } from "./contracts.mjs";
import {
  createPaletteFixture,
  createTimelineWarningFixture,
  getTimelineWarningFixtureHash,
} from "../../test-support/skin-palette-fixture.mjs";

const isUrlLikePath = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(file|https?|ftp|data|blob|ws|wss|url):/i.test(value);

let captureInProgress = false;

/** Capture one full light/dark candidate matrix and own its isolated fixtures. */
export async function runReviewCapture({
  runDir,
  candidateId,
  outDir,
  captureFn = captureStateMatrix,
  fixtureFactory = createPaletteFixture,
  timelineWarningFixtureFactory = createTimelineWarningFixture,
  resume = false,
} = {}) {
  for (const [label, value] of [
    ["runDir", runDir],
    ["candidateId", candidateId],
    ["outDir", outDir],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${label} must be a non-empty string`);
    }
  }
  if (typeof resume !== "boolean") throw new TypeError("resume must be a boolean");
  if (typeof captureFn !== "function") throw new TypeError("captureFn must be a function");
  if (typeof fixtureFactory !== "function") throw new TypeError("fixtureFactory must be a function");
  if (typeof timelineWarningFixtureFactory !== "function")
    throw new TypeError("timelineWarningFixtureFactory must be a function");
  if (isUrlLikePath(outDir)) throw new TypeError("outDir must be a filesystem path, not a URL");
  if (captureInProgress) throw new Error("runReviewCapture: another capture is already in progress");

  captureInProgress = true;
  let fixture = null;
  let timelineWarningFixture = null;
  const ownedFixtures = [];
  let candidate = null;
  let resolvedOutDir = null;
  let captureResult;
  let operationFailed = false;
  let operationError;
  const closeErrors = [];

  const ownFixture = (value, label) => {
    if (!value || typeof value !== "object") {
      throw new TypeError(`${label} must return an owned fixture with close()`);
    }
    const close = value.close;
    if (typeof close !== "function") throw new TypeError(`${label} must return an owned fixture with close()`);
    if (!ownedFixtures.some((entry) => entry.fixture === value)) ownedFixtures.push({ fixture: value, close });
    return value;
  };

  try {
    candidate = await loadPreviewCandidate({ runDir, candidateId });
    resolvedOutDir = await assertCaptureOutputDir(path.resolve(REPO_ROOT, outDir), REPO_ROOT, {
      requireEmpty: !resume,
    });
    fixture = ownFixture(await fixtureFactory(), "fixtureFactory");
    timelineWarningFixture = ownFixture(await timelineWarningFixtureFactory(), "timelineWarningFixtureFactory");
    if (fixture === timelineWarningFixture) {
      throw new TypeError("fixtureFactory and timelineWarningFixtureFactory must return different fixture objects");
    }
    buildFixedMatrixFixtureBindings({
      groups: STATE_MATRIX_GROUPS.map((group) => group.id),
      fixtureHash: fixture.fixtureHash,
      warningFixtureHash: timelineWarningFixture.fixtureHash,
    });
    captureResult = await captureFn({
      candidate,
      fixture,
      timelineWarningFixture,
      outDir: resolvedOutDir,
      modes: ["light", "dark"],
      resume,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    try {
      for (const { fixture: ownedFixture, close } of ownedFixtures.reverse()) {
        try {
          await close.call(ownedFixture);
        } catch (error) {
          closeErrors.push(error);
        }
      }
    } finally {
      captureInProgress = false;
    }
  }

  const errors = [...(operationFailed ? [operationError] : []), ...closeErrors];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "capture and fixture cleanup failed");
  return { candidateId: candidate.id, candidateHash: candidate.candidateHash, captureResult };
}

const REVIEW_CAPTURE_MODES = ["light", "dark"];
const REVIEW_CAPTURE_STATUSES = new Set(["captured", "failed", "incomplete", "unreachable", "aborted"]);
const REVIEW_CAPTURE_GROUPS = new Set(STATE_MATRIX_GROUPS.map((group) => group.id));
const REVIEW_CAPTURE_UNITS = STATE_MATRIX_GROUPS.flatMap((group) => group.units);

const isRecord = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const hasText = (value) => typeof value === "string" && value.trim() !== "";

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isLegacyWarningOnlyHeader({ groups, fixtureHash, hasFixtureBindings }) {
  return (
    !hasFixtureBindings &&
    Array.isArray(groups) &&
    groups.length === 1 &&
    groups[0] === "S8" &&
    fixtureHash === getTimelineWarningFixtureHash()
  );
}

function assertSummaryFixtureHeader(
  label,
  { groups, fixtureHash, fixtureBindings, hasFixtureBindings },
  allowLegacyWarningOnly = false,
) {
  if (allowLegacyWarningOnly && isLegacyWarningOnlyHeader({ groups, fixtureHash, hasFixtureBindings })) return;
  try {
    if (hasFixtureBindings) {
      assertFixedMatrixFixtureBindings({ groups, fixtureHash, fixtureBindings });
    } else {
      buildFixedMatrixFixtureBindings({
        groups,
        fixtureHash,
        warningFixtureHash: getTimelineWarningFixtureHash(),
      });
    }
  } catch (error) {
    throw new TypeError(`${label} fixture binding header is invalid: ${error?.message ?? diagnosticText(error)}`, {
      cause: error,
    });
  }
}

function assertSummaryModesHeader(modes, label) {
  if (!Array.isArray(modes) || modes.length === 0 || new Set(modes).size !== modes.length) {
    throw new TypeError(`${label} must be a non-empty array of distinct known modes`);
  }
  for (const mode of modes) {
    if (!REVIEW_CAPTURE_MODES.includes(mode)) throw new TypeError(`${label} contains an unknown mode: ${String(mode)}`);
  }
  return new Set(modes);
}

function validateCaptureMatrixHeaders(result, capture, addGap) {
  const captureHasFixtureBindings = Object.hasOwn(capture, "fixtureBindings");
  const captureHeader = {
    groups: capture.groups,
    fixtureHash: capture.fixtureHash,
    fixtureBindings: capture.fixtureBindings,
    hasFixtureBindings: captureHasFixtureBindings,
  };

  const progress = result.progress;
  if (progress === undefined || progress === null) {
    assertSummaryFixtureHeader("capture", captureHeader, isLegacyWarningOnlyHeader(captureHeader));
    if (!captureHasFixtureBindings) {
      addGap("fixture-bindings-missing", null, null, "capture.fixtureBindings is missing");
    }
    addGap(
      "fixture-bindings-missing",
      null,
      null,
      "progress is missing, so progress.digests.fixtureBindings cannot be verified",
    );
    return;
  }

  requireRecord(progress, "captureResult.progress");
  const digests = requireRecord(progress.digests, "captureResult.progress.digests");
  const progressHasFixtureBindings = Object.hasOwn(digests, "fixtureBindings");
  const progressHeader = {
    groups: progress.groups,
    fixtureHash: digests.fixtureHash,
    fixtureBindings: digests.fixtureBindings,
    hasFixtureBindings: progressHasFixtureBindings,
  };
  const allowLegacyWarningOnly = isLegacyWarningOnlyHeader(captureHeader) && isLegacyWarningOnlyHeader(progressHeader);
  assertSummaryFixtureHeader("capture", captureHeader, allowLegacyWarningOnly);
  assertSummaryFixtureHeader("progress", progressHeader, allowLegacyWarningOnly);
  if (!isDeepStrictEqual(capture.groups, progress.groups)) {
    throw new TypeError("capture.groups does not match progress.groups");
  }

  const progressModes = assertSummaryModesHeader(progress.modes, "progress.modes");
  const resultModes = requireRecord(result.modes, "captureResult.modes");
  const resultModeIds = Object.keys(resultModes);
  const resultModeSet = new Set(resultModeIds);
  for (const mode of resultModeIds) {
    if (!REVIEW_CAPTURE_MODES.includes(mode)) throw new TypeError(`captureResult.modes contains unknown mode ${mode}`);
  }
  if (progressModes.size !== resultModeSet.size || [...progressModes].some((mode) => !resultModeSet.has(mode))) {
    throw new TypeError("progress.modes does not match captureResult.modes");
  }

  if (
    captureHasFixtureBindings &&
    progressHasFixtureBindings &&
    !isDeepStrictEqual(capture.fixtureBindings, digests.fixtureBindings)
  ) {
    throw new TypeError("capture.fixtureBindings does not match progress.digests.fixtureBindings");
  }
  if (!captureHasFixtureBindings) {
    addGap("fixture-bindings-missing", null, null, "capture.fixtureBindings is missing");
  }
  if (!progressHasFixtureBindings) {
    addGap("fixture-bindings-missing", null, null, "progress.digests.fixtureBindings is missing");
  }
}

export function inspectReviewCaptureFixtureHeaders({ capture, progress, modes } = {}) {
  const gaps = [];
  validateCaptureMatrixHeaders({ progress, modes }, capture, (code, mode, unitId, detail) =>
    gaps.push({ code, mode, unitId, detail }),
  );
  return gaps;
}

function diagnosticText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function requireCaptureMatrixEnvelope(captureResult) {
  const result = requireRecord(captureResult, "captureResult");
  const capture = requireRecord(result.capture, "captureResult.capture");
  const capturedCandidate = requireRecord(capture.candidate, "captureResult.capture.candidate");
  if (capture.schemaVersion !== 1 || capture.kind !== "skin-palette-capture-matrix") {
    throw new TypeError("captureResult.capture has an unsupported matrix schema");
  }
  if (!hasText(result.outDir)) throw new TypeError("captureResult.outDir must be a non-empty string");
  if (!hasText(result.skinId) || capturedCandidate.skinId !== result.skinId) {
    throw new TypeError("captureResult skinId does not match capture.candidate.skinId");
  }
  return { result, capture, capturedCandidate };
}

function assertCaptureMatrixModesMatch(result, capture) {
  if (!isDeepStrictEqual(capture.modes, result.modes)) {
    throw new TypeError("captureResult.capture.modes does not match captureResult.modes");
  }
}

/** Summarize matrix identity, coverage, and executor statuses without reading evidence files. */
export function summarizeReviewCapture({ candidateId, candidateHash, captureResult } = {}) {
  for (const [label, value] of [
    ["candidateId", candidateId],
    ["candidateHash", candidateHash],
  ]) {
    if (!hasText(value)) throw new TypeError(`${label} must be a non-empty string`);
  }

  const { result, capture, capturedCandidate } = requireCaptureMatrixEnvelope(captureResult);
  if (
    capturedCandidate.production === true ||
    capturedCandidate.id !== candidateId ||
    capturedCandidate.candidateHash !== candidateHash
  ) {
    throw new TypeError("captureResult candidate identity does not match the requested candidate");
  }
  assertCaptureMatrixModesMatch(result, capture);
  return summarizeCaptureMatrix(result, capture);
}

/** Summarize a formal production matrix identity without reading evidence files. */
export function summarizeProductionCapture({ skinId, captureResult } = {}) {
  if (typeof skinId !== "string" || !SKIN_IDS.includes(skinId)) {
    throw new TypeError("skinId must be a registered production skin ID");
  }

  const { result, capture, capturedCandidate } = requireCaptureMatrixEnvelope(captureResult);
  const candidateKeys = Reflect.ownKeys(capturedCandidate);
  if (
    result.skinId !== skinId ||
    capturedCandidate.skinId !== skinId ||
    capturedCandidate.production !== true ||
    candidateKeys.length !== 2 ||
    candidateKeys.some((key) => key !== "production" && key !== "skinId")
  ) {
    throw new TypeError("captureResult candidate identity does not match the requested production skin");
  }
  assertCaptureMatrixModesMatch(result, capture);
  return summarizeCaptureMatrix(result, capture);
}

function summarizeCaptureMatrix(result, capture) {
  const errors = [];
  const gaps = [];
  let failed = false;
  const addGap = (code, mode, unitId, detail) => gaps.push({ code, mode, unitId, detail });
  const addError = (code, mode, unitId, detail) => {
    failed = true;
    errors.push({ code, mode, unitId, detail });
  };
  gaps.push(...inspectReviewCaptureFixtureHeaders({ capture, progress: result.progress, modes: result.modes }));
  const inspectStatus = (record, label, mode, unitId) => {
    requireRecord(record, label);
    if (!REVIEW_CAPTURE_STATUSES.has(record.status)) {
      throw new TypeError(`${label}.status is not a recognized capture status`);
    }
    if (record.status === "failed") addError("failed-status", mode, unitId, `${label} status=failed`);
    else if (record.status !== "captured") {
      const reason = record.reason === undefined || record.reason === null ? "" : `: ${diagnosticText(record.reason)}`;
      addGap(`status-${record.status}`, mode, unitId, `${label} status=${record.status}${reason}`);
    }
    if (record.blockers !== undefined && record.blockers !== null) {
      if (!Array.isArray(record.blockers)) throw new TypeError(`${label}.blockers must be an array`);
      for (const blocker of record.blockers) addError("blocker", mode, unitId, diagnosticText(blocker));
    }
  };

  const declaredGroups = capture.groups;
  const presentGroups = new Set();
  if (declaredGroups !== undefined && declaredGroups !== null) {
    if (!Array.isArray(declaredGroups)) throw new TypeError("captureResult.capture.groups must be an array");
    for (const groupId of declaredGroups) {
      if (typeof groupId !== "string" || !REVIEW_CAPTURE_GROUPS.has(groupId)) {
        throw new TypeError(`captureResult.capture.groups contains an unknown group: ${String(groupId)}`);
      }
      if (presentGroups.has(groupId)) throw new TypeError(`captureResult.capture.groups repeats ${groupId}`);
      presentGroups.add(groupId);
    }
  }
  for (const group of STATE_MATRIX_GROUPS) {
    if (!presentGroups.has(group.id)) {
      addGap("missing-group", null, null, `capture.groups is missing required group ${group.id}`);
    }
  }

  const modes = result.modes;
  if (modes !== undefined && modes !== null) {
    requireRecord(modes, "captureResult.modes");
    for (const mode of Object.keys(modes)) {
      if (!REVIEW_CAPTURE_MODES.includes(mode))
        throw new TypeError(`captureResult.modes contains unknown mode ${mode}`);
    }
  }
  const progress = result.progress;
  if (progress !== undefined && progress !== null) requireRecord(progress, "captureResult.progress");
  const progressUnits = progress?.units;
  if (progressUnits !== undefined && progressUnits !== null) {
    requireRecord(progressUnits, "captureResult.progress.units");
  }

  for (const mode of REVIEW_CAPTURE_MODES) {
    const modeResult = modes && Object.hasOwn(modes, mode) ? modes[mode] : null;
    if (modeResult === null || modeResult === undefined) {
      addGap("missing-mode", mode, null, `captureResult.modes.${mode} is missing`);
    } else {
      requireRecord(modeResult, `captureResult.modes.${mode}`);
      inspectStatus(modeResult, `modes.${mode}`, mode, null);
      if (modeResult.gaps !== undefined && modeResult.gaps !== null) {
        if (!Array.isArray(modeResult.gaps)) throw new TypeError(`modes.${mode}.gaps must be an array`);
        for (const captureGap of modeResult.gaps) {
          requireRecord(captureGap, `modes.${mode}.gaps entry`);
          const unitId = hasText(captureGap.unitId) ? captureGap.unitId : null;
          const details = [];
          if (hasText(captureGap.stateId)) details.push(`state=${captureGap.stateId}`);
          if (captureGap.reason !== undefined && captureGap.reason !== null) {
            details.push(diagnosticText(captureGap.reason));
          }
          addGap("capture-gap", mode, unitId, details.length > 0 ? details.join(": ") : diagnosticText(captureGap));
        }
      }
    }

    const baselineUnits = REVIEW_CAPTURE_UNITS.filter((unit) => unit.kind === "baseline");
    const stateUnits = REVIEW_CAPTURE_UNITS.filter((unit) => unit.kind !== "baseline");
    for (const unit of baselineUnits) {
      const unitId = unit.id;
      const baseline = modeResult?.baseline;
      if (baseline === undefined || baseline === null) {
        addGap("missing-baseline", mode, unitId, `modes.${mode}.baseline is missing`);
      } else {
        inspectStatus(baseline, `modes.${mode}.baseline`, mode, unitId);
      }
    }

    const states = modeResult?.states;
    if (states !== undefined && states !== null) requireRecord(states, `modes.${mode}.states`);
    const expectedStateIds = new Set(stateUnits.map((unit) => unit.id));
    if (states) {
      for (const unitId of Object.keys(states)) {
        if (!expectedStateIds.has(unitId)) throw new TypeError(`modes.${mode}.states contains unknown unit ${unitId}`);
      }
    }
    for (const unit of stateUnits) {
      const state = states && Object.hasOwn(states, unit.id) ? states[unit.id] : null;
      if (state === null || state === undefined) {
        addGap("missing-state", mode, unit.id, `modes.${mode}.states.${unit.id} is missing`);
      } else {
        inspectStatus(state, `modes.${mode}.states.${unit.id}`, mode, unit.id);
      }
    }

    for (const unit of REVIEW_CAPTURE_UNITS) {
      const unitId = unit.id;
      const progressKey = `${mode}/${unitId}`;
      const progressUnit =
        progressUnits && Object.hasOwn(progressUnits, progressKey) ? progressUnits[progressKey] : null;
      if (progressUnit === null || progressUnit === undefined) {
        addGap("missing-progress-unit", mode, unitId, `progress.units.${progressKey} is missing`);
      } else {
        inspectStatus(progressUnit, `progress.units.${progressKey}`, mode, unitId);
      }
    }
  }

  return { status: failed ? "failed" : gaps.length > 0 ? "incomplete" : "captured", errors, gaps };
}

function isStrictPathChild(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveReviewCaptureDirectory(outDir) {
  if (!hasText(outDir) || isUrlLikePath(outDir)) {
    throw new TypeError("captureResult.outDir must be a filesystem path");
  }
  const validationRoot = path.resolve(REPO_ROOT, "docs", "validation");
  const resolvedOutDir = path.resolve(REPO_ROOT, outDir);
  if (!isStrictPathChild(validationRoot, resolvedOutDir)) {
    throw new TypeError("captureResult.outDir must be a strict child of docs/validation");
  }

  const [validationRootReal, outDirReal] = await Promise.all([realpath(validationRoot), realpath(resolvedOutDir)]);
  if (!isStrictPathChild(validationRootReal, outDirReal)) {
    throw new TypeError("captureResult.outDir realpath must be a strict child of docs/validation");
  }
  if (!(await stat(outDirReal)).isDirectory()) {
    throw new TypeError("captureResult.outDir must be an existing directory");
  }
  return { resolvedOutDir, outDirReal };
}

async function readReviewChecksFile({ resolvedOutDir, outDirReal, relativePath, mode, candidateId }) {
  const filePath = path.resolve(resolvedOutDir, ...relativePath.split("/"));
  if (!isStrictPathChild(resolvedOutDir, filePath)) {
    throw new TypeError(`checks path escapes capture output: ${relativePath}`);
  }

  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new TypeError(`checks file must not be a symlink or junction: ${relativePath}`);
  if (!info.isFile()) throw new TypeError(`checks path must be a regular file: ${relativePath}`);

  let fileReal;
  try {
    fileReal = await realpath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!isStrictPathChild(outDirReal, fileReal)) {
    throw new TypeError(`checks realpath escapes capture output: ${relativePath}`);
  }

  let source;
  try {
    source = await readFile(fileReal, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let checks;
  try {
    checks = JSON.parse(source);
  } catch (error) {
    throw new TypeError(`invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  checks = requireRecord(checks, `${relativePath} checks`);
  if (!Array.isArray(checks.records)) throw new TypeError(`${relativePath} checks.records must be an array`);
  if (checks.mode !== mode) throw new TypeError(`${relativePath} checks.mode does not match ${mode}`);
  if (checks.candidateId !== candidateId && !(checks.records.length === 0 && checks.candidateId === null)) {
    throw new TypeError(`${relativePath} checks.candidateId does not match the candidate`);
  }
  for (const [index, recordValue] of checks.records.entries()) {
    const record = requireRecord(recordValue, `${relativePath} checks.records[${index}]`);
    if (record.candidateId !== candidateId || record.mode !== mode) {
      throw new TypeError(`${relativePath} checks.records[${index}] identity does not match`);
    }
  }
  return checks;
}

function validateReviewChecksShape(checks, { unit, baseline, viewMode, relativePath }) {
  const expectedStateId = baseline ? "dashboard-default" : (unit.stateId ?? null);
  if (checks.stateId !== expectedStateId) {
    throw new TypeError(`${relativePath} checks.stateId does not match ${String(expectedStateId)}`);
  }
  if (!baseline) {
    if (checks.schemaVersion !== 1 || checks.kind !== "skin-palette-capture-checks" || checks.unitId !== unit.id) {
      throw new TypeError(`${relativePath} checks schema or unitId does not match`);
    }
  }
  if (viewMode !== null && checks.viewMode !== viewMode) {
    throw new TypeError(`${relativePath} checks.viewMode does not match ${viewMode}`);
  }
}

function jsonView(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError(`${label} has no JSON representation`);
    return JSON.parse(serialized);
  } catch (error) {
    throw new TypeError(
      `${label} cannot be viewed as its persisted JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function addUniqueGaps(gaps, additions) {
  for (const gap of additions) {
    if (!gaps.some((existing) => isDeepStrictEqual(existing, gap))) gaps.push(gap);
  }
}

async function readCaptureMetadataHeaders({ result, resolvedOutDir, outDirReal, gaps }) {
  const [captureOnDisk, progressOnDisk] = await Promise.all([
    readReviewCaptureJsonFile({ resolvedOutDir, outDirReal, relativePath: "capture.json", missingOk: true }),
    readReviewCaptureJsonFile({ resolvedOutDir, outDirReal, relativePath: "progress.json", missingOk: true }),
  ]);
  if (captureOnDisk === undefined) {
    gaps.push({
      code: "missing-capture-metadata",
      mode: null,
      unitId: null,
      detail: "capture.json is missing from the resolved capture output",
    });
  } else {
    requireRecord(captureOnDisk, "capture.json");
  }
  if (progressOnDisk === undefined) {
    gaps.push({
      code: "missing-progress-metadata",
      mode: null,
      unitId: null,
      detail: "progress.json is missing from the resolved capture output",
    });
  } else {
    requireRecord(progressOnDisk, "progress.json");
  }

  const captureInMemory = jsonView(result.capture, "captureResult.capture");
  const progressInMemory =
    result.progress == null ? result.progress : jsonView(result.progress, "captureResult.progress");
  if (captureOnDisk !== undefined && !isDeepStrictEqual(captureOnDisk, captureInMemory)) {
    throw new TypeError("capture.json does not match the persisted JSON view of captureResult.capture");
  }
  if (progressOnDisk !== undefined && !isDeepStrictEqual(progressOnDisk, progressInMemory)) {
    throw new TypeError("progress.json does not match the persisted JSON view of captureResult.progress");
  }

  if (captureOnDisk !== undefined || progressOnDisk !== undefined) {
    const captureHeader = captureOnDisk ?? captureInMemory;
    addUniqueGaps(
      gaps,
      inspectReviewCaptureFixtureHeaders({
        capture: captureHeader,
        progress: progressOnDisk ?? progressInMemory,
        modes: captureHeader.modes ?? result.modes,
      }),
    );
  }
  return { progressOnDisk };
}

async function resolveReviewCaptureUnitDirectory({ resolvedOutDir, outDirReal, mode, unitId }) {
  let currentPath = resolvedOutDir;
  let currentRealPath = outDirReal;
  for (const segment of [mode, "states", unitId]) {
    currentPath = path.join(currentPath, segment);
    if (!isStrictPathChild(resolvedOutDir, currentPath)) {
      throw new TypeError(`fixture state path escapes capture output: ${mode}/states/${unitId}`);
    }
    let info;
    try {
      info = await lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new TypeError(`fixture state directory must not be a symlink or junction: ${mode}/states/${unitId}`);
    }
    if (!info.isDirectory()) {
      throw new TypeError(`fixture state path must be a directory: ${mode}/states/${unitId}`);
    }
    const nextRealPath = await realpath(currentPath);
    const expectedRealPath = path.resolve(currentRealPath, segment);
    const normalize = (value) =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(nextRealPath) !== normalize(expectedRealPath) || !isStrictPathChild(outDirReal, nextRealPath)) {
      throw new TypeError(
        `fixture state directory realpath escapes or redirects within capture output: ${mode}/states/${unitId}`,
      );
    }
    currentRealPath = nextRealPath;
  }
  return currentRealPath;
}

async function verifyFixtureUnitEvidence({
  result,
  progressOnDisk,
  resolvedOutDir,
  outDirReal,
  unit,
  mode,
  checks,
  gaps,
}) {
  if (progressOnDisk === undefined) return false;
  const progressKey = `${mode}/${unit.id}`;
  const progressUnit =
    progressOnDisk.units && Object.hasOwn(progressOnDisk.units, progressKey) ? progressOnDisk.units[progressKey] : null;
  if (progressUnit?.status !== "captured" || typeof progressUnit.evidenceHash !== "string") {
    gaps.push({
      code: "invalid-fixture-state-evidence",
      mode,
      unitId: unit.id,
      detail: `progress.json units.${progressKey}.evidenceHash is missing or not captured`,
    });
    return false;
  }

  const unitDir = await resolveReviewCaptureUnitDirectory({ resolvedOutDir, outDirReal, mode, unitId: unit.id });
  if (unitDir === undefined) {
    gaps.push({
      code: "invalid-fixture-state-evidence",
      mode,
      unitId: unit.id,
      detail: `fixture state directory is missing: ${mode}/states/${unit.id}`,
    });
    return false;
  }

  const state = REVIEW_STATE_BY_ID.get(unit.stateId);
  if (!state || !Array.isArray(state.expectedRoleIds)) {
    throw new TypeError(`fixture unit ${unit.id} references an unknown state scope: ${String(unit.stateId)}`);
  }
  try {
    const evidence = await readCapturedUnitEvidence({
      unitDir,
      unit,
      mode,
      skinId: result.skinId,
      expectedRoleIds: state.expectedRoleIds,
      expectedEvidenceHash: progressUnit.evidenceHash,
    });
    if (!isDeepStrictEqual(evidence.checks, checks)) {
      gaps.push({
        code: "invalid-fixture-state-evidence",
        mode,
        unitId: unit.id,
        detail: "readCapturedUnitEvidence checks do not match the primary checks.json read",
      });
      return false;
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/(JSON\s*损坏|路径越界|指向证据目录之外|符号链接|symlink|junction)/i.test(detail)) throw error;
    gaps.push({ code: "invalid-fixture-state-evidence", mode, unitId: unit.id, detail });
    return false;
  }
}

async function readCaptureChecks({ summary, candidateId, captureResult }) {
  const result = requireRecord(captureResult, "captureResult");
  const { resolvedOutDir, outDirReal } = await resolveReviewCaptureDirectory(result.outDir);
  const entries = [];
  const gaps = [...summary.gaps];
  const { progressOnDisk } = await readCaptureMetadataHeaders({ result, resolvedOutDir, outDirReal, gaps });
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const progressUnits = result.progress?.units;

  for (const mode of ["light", "dark"]) {
    const modeResult = result.modes && Object.hasOwn(result.modes, mode) ? result.modes[mode] : null;
    if (!modeResult) continue;
    for (const unit of units) {
      const baseline = unit.kind === "baseline";
      const states = modeResult.states;
      const unitResult = baseline
        ? modeResult.baseline
        : states && Object.hasOwn(states, unit.id)
          ? states[unit.id]
          : null;
      const progressKey = `${mode}/${unit.id}`;
      const progressUnit =
        progressUnits && Object.hasOwn(progressUnits, progressKey) ? progressUnits[progressKey] : null;
      if (unitResult?.status !== "captured" || progressUnit?.status !== "captured") continue;

      const unitId = unit.id;
      const prefix = baseline ? [mode] : [mode, "states", unitId];
      const relativeMainPath = [...prefix, "checks.json"].join("/");
      const checks = await readReviewChecksFile({
        resolvedOutDir,
        outDirReal,
        relativePath: relativeMainPath,
        mode,
        candidateId,
      });
      if (checks === null) {
        gaps.push({
          code: "missing-checks",
          mode,
          unitId,
          detail: `captured unit checks are missing: ${relativeMainPath}`,
        });
      } else {
        validateReviewChecksShape(checks, { unit, baseline, viewMode: null, relativePath: relativeMainPath });
        if (
          unit.fixtureRequirement &&
          !(await verifyFixtureUnitEvidence({
            result,
            progressOnDisk,
            resolvedOutDir,
            outDirReal,
            unit,
            mode,
            checks,
            gaps,
          }))
        ) {
          continue;
        }
        entries.push({ mode, unitId, viewMode: null, relativePath: relativeMainPath, checks });
      }

      if (baseline) continue;
      for (const viewMode of unit.timelineModeSequence ?? []) {
        const relativePath = [...prefix, `checks.timeline-${viewMode}.json`].join("/");
        const timelineChecks = await readReviewChecksFile({
          resolvedOutDir,
          outDirReal,
          relativePath,
          mode,
          candidateId,
        });
        if (timelineChecks === null) {
          gaps.push({
            code: "missing-checks",
            mode,
            unitId,
            detail: `captured timeline view checks are missing: ${relativePath}`,
          });
        } else {
          validateReviewChecksShape(timelineChecks, {
            unit,
            baseline: false,
            viewMode,
            relativePath,
          });
          entries.push({ mode, unitId, viewMode, relativePath, checks: timelineChecks });
        }
      }
    }
  }

  return { entries, gaps };
}

/** Read only the fixed checks files belonging to matrix units recorded as captured. */
export async function readReviewCaptureChecks({ candidateId, candidateHash, captureResult } = {}) {
  const summary = summarizeReviewCapture({ candidateId, candidateHash, captureResult });
  return readCaptureChecks({ summary, candidateId, captureResult });
}

/** Read fixed formal checks whose header and records carry the explicit production null identity. */
export async function readProductionCaptureChecks({ skinId, captureResult } = {}) {
  const summary = summarizeProductionCapture({ skinId, captureResult });
  return readCaptureChecks({ summary, candidateId: null, captureResult });
}

const REVIEW_CHECK_RESULTS = new Set(["pass", "fail", "unmeasured", "not-applicable"]);
const REVIEW_ROLE_BY_ID = new Map(ROLE_CATALOG.map((role) => [role.id, role]));
const REVIEW_STATE_BY_ID = new Map(STATE_CATALOG.map((state) => [state.id, state]));
const REVIEW_UNIT_BY_ID = new Map(STATE_MATRIX_GROUPS.flatMap((group) => group.units).map((unit) => [unit.id, unit]));

function requiredReviewRolesForUnit(unitId) {
  const unit = REVIEW_UNIT_BY_ID.get(unitId);
  if (!unit) throw new TypeError(`capture unit is not registered: ${unitId}`);
  const stateId = unit.kind === "baseline" ? "dashboard-default" : (unit.stateId ?? null);
  if (stateId === null) return [];
  const state = REVIEW_STATE_BY_ID.get(stateId);
  if (!state || !Array.isArray(state.expectedRoleIds)) {
    throw new TypeError(`capture unit ${unitId} references an unknown or malformed state scope: ${stateId}`);
  }
  const roles = [];
  for (const roleId of state.expectedRoleIds) {
    const role = REVIEW_ROLE_BY_ID.get(roleId);
    if (!role) throw new TypeError(`state ${stateId} references an unknown role: ${String(roleId)}`);
    if (role.required === true && typeof role.threshold === "number" && Number.isFinite(role.threshold)) {
      roles.push(role);
    }
  }
  return roles;
}

function validateReviewRecord(record, entry, index) {
  const label = `${entry.relativePath} records[${index}]`;
  requireRecord(record, label);
  if (typeof record.roleId !== "string" || !REVIEW_ROLE_BY_ID.has(record.roleId)) {
    throw new TypeError(`${label} references an unknown role: ${String(record.roleId)}`);
  }
  if (record.stateId !== entry.checks.stateId) {
    throw new TypeError(`${label}.stateId does not match checks.stateId`);
  }
  if (!REVIEW_CHECK_RESULTS.has(record.result)) {
    throw new TypeError(`${label}.result is not a supported measurement result`);
  }
  if (record.result === "pass" || record.result === "fail") {
    const role = REVIEW_ROLE_BY_ID.get(record.roleId);
    if (!Number.isFinite(role.threshold)) {
      throw new TypeError(`${label} cannot pass or fail a role without a numeric catalog threshold`);
    }
    if (!Number.isFinite(record.ratio) || !Number.isFinite(record.threshold)) {
      throw new TypeError(`${label} pass/fail ratio and threshold must be finite numbers`);
    }
    if (record.threshold !== role.threshold) {
      throw new TypeError(`${label}.threshold does not match the role catalog`);
    }
    if (record.ratio >= record.threshold !== (record.result === "pass")) {
      throw new TypeError(`${label}.result is inconsistent with its full-precision ratio and threshold`);
    }
  }
  return REVIEW_ROLE_BY_ID.get(record.roleId);
}

function reviewRecordDescription(record) {
  const approximate =
    typeof record.method === "string" && record.method.endsWith(APPROXIMATE_METHOD_SUFFIX) ? " approximate" : "";
  const reason = record.reason === undefined || record.reason === null ? "" : ` (${diagnosticText(record.reason)})`;
  return `${record.result}${approximate}${reason}`;
}

function classifyReviewEntry(entry) {
  const requiredRoles = requiredReviewRolesForUnit(entry.unitId);
  const recordsByRole = new Map();
  for (const [index, record] of entry.checks.records.entries()) {
    validateReviewRecord(record, entry, index);
    if (!recordsByRole.has(record.roleId)) recordsByRole.set(record.roleId, []);
    recordsByRole.get(record.roleId).push(record);
  }

  const errors = [];
  const gaps = [];
  for (const role of requiredRoles) {
    const records = recordsByRole.get(role.id) ?? [];
    const exactRecords = records.filter(
      (record) => !(typeof record.method === "string" && record.method.endsWith(APPROXIMATE_METHOD_SUFFIX)),
    );
    const failedRecords = exactRecords.filter((record) => record.result === "fail");
    if (failedRecords.length > 0) {
      errors.push({
        code: "required-role-fail",
        mode: entry.mode,
        unitId: entry.unitId,
        roleId: role.id,
        viewMode: entry.viewMode,
        detail: `required role failed at state ${String(entry.checks.stateId)}: ${failedRecords.map(reviewRecordDescription).join("; ")}`,
      });
      continue;
    }
    if (exactRecords.some((record) => record.result === "pass")) continue;
    gaps.push({
      code: "required-role-missing",
      mode: entry.mode,
      unitId: entry.unitId,
      roleId: role.id,
      viewMode: entry.viewMode,
      detail: `required role has no non-approximate pass at state ${String(entry.checks.stateId)}: ${records.length > 0 ? records.map(reviewRecordDescription).join("; ") : "no record"}`,
    });
  }
  return { errors, gaps };
}

function aggregateCaptureClassification(summary, readResult) {
  const errors = [...summary.errors];
  const gaps = [...readResult.gaps];
  for (const entry of readResult.entries) {
    const classified = classifyReviewEntry(entry);
    errors.push(...classified.errors);
    gaps.push(...classified.gaps);
  }

  const failed = summary.status === "failed" || errors.length > 0;
  const incomplete = summary.status === "incomplete" || gaps.length > 0;
  const status = failed ? "failed" : incomplete ? "incomplete" : "captured";
  return { status, exitCode: status === "captured" ? 0 : 2, errors, gaps };
}

/** Classify required readability records; this does not assess candidate readiness or visual acceptance. */
export async function classifyReviewCapture({ candidateId, candidateHash, captureResult } = {}) {
  const summary = summarizeReviewCapture({ candidateId, candidateHash, captureResult });
  const readResult = await readReviewCaptureChecks({ candidateId, candidateHash, captureResult });
  return aggregateCaptureClassification(summary, readResult);
}

/** Classify required readability records for a formal skin without declaring visual acceptance. */
export async function classifyProductionCapture({ skinId, captureResult } = {}) {
  const summary = summarizeProductionCapture({ skinId, captureResult });
  const readResult = await readProductionCaptureChecks({ skinId, captureResult });
  return aggregateCaptureClassification(summary, readResult);
}

async function readReviewCaptureJsonFile({ resolvedOutDir, outDirReal, relativePath, missingOk = false }) {
  const filePath = path.resolve(resolvedOutDir, ...relativePath.split("/"));
  if (!isStrictPathChild(resolvedOutDir, filePath)) {
    throw new TypeError(`capture metadata path escapes output: ${relativePath}`);
  }

  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (missingOk) return undefined;
      throw new TypeError(`capture metadata file is missing: ${relativePath}`);
    }
    throw error;
  }
  if (info.isSymbolicLink())
    throw new TypeError(`capture metadata file must not be a symlink or junction: ${relativePath}`);
  if (!info.isFile()) throw new TypeError(`capture metadata path must be a regular file: ${relativePath}`);

  const fileReal = await realpath(filePath);
  if (!isStrictPathChild(outDirReal, fileReal)) {
    throw new TypeError(`capture metadata realpath escapes output: ${relativePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(fileReal, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`invalid JSON in ${relativePath}: ${error.message}`);
    }
    throw error;
  }
  return parsed;
}

/** Register one verified capture directory in its own exclusive, idempotent shard. */
export async function writeReviewCaptureIndexShard({ runDir, candidateId, candidateHash, captureResult } = {}) {
  const candidate = await loadPreviewCandidate({ runDir, candidateId });
  if (candidate.candidateHash !== candidateHash) {
    throw new TypeError("candidateHash does not match the registered candidate");
  }
  summarizeReviewCapture({ candidateId, candidateHash, captureResult });

  const result = requireRecord(captureResult, "captureResult");
  const [{ resolvedOutDir, outDirReal }, validationRootReal] = await Promise.all([
    resolveReviewCaptureDirectory(result.outDir),
    realpath(path.join(REPO_ROOT, "docs", "validation")),
  ]);
  const resolvedRunDir = path.resolve(REPO_ROOT, runDir);
  const runDirReal = await realpath(resolvedRunDir);
  if (!isStrictPathChild(validationRootReal, runDirReal) || !(await stat(runDirReal)).isDirectory()) {
    throw new TypeError("runDir realpath must be an existing strict child of docs/validation");
  }

  const relativePath = path.relative(runDirReal, outDirReal).split(path.sep).join("/");
  if (relativePath === "") throw new TypeError("capture output directory cannot be the run directory");

  const captureOnDisk = await readReviewCaptureJsonFile({
    resolvedOutDir,
    outDirReal,
    relativePath: "capture.json",
  });
  const progressOnDisk = await readReviewCaptureJsonFile({
    resolvedOutDir,
    outDirReal,
    relativePath: "progress.json",
  });
  if (!isDeepStrictEqual(captureOnDisk, result.capture)) {
    throw new TypeError("capture.json does not match captureResult.capture");
  }
  if (!isDeepStrictEqual(progressOnDisk, result.progress)) {
    throw new TypeError("progress.json does not match captureResult.progress");
  }

  const index = { schemaVersion: 1, captures: { [candidateId]: relativePath } };
  const shardPath = path.join(outDirReal, "capture-index-shard.json");
  const contents = `${JSON.stringify(index, null, 2)}\n`;
  try {
    await writeFile(shardPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readReviewCaptureJsonFile({
      resolvedOutDir: outDirReal,
      outDirReal,
      relativePath: "capture-index-shard.json",
    });
    if (!isDeepStrictEqual(existing, index)) {
      throw new TypeError("existing capture-index-shard.json has a different or unsupported binding");
    }
  }
  return { shardPath, index };
}
