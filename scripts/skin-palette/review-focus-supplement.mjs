import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { SOURCE_FILES } from "./capture.mjs";
import { hashCandidate, sha256Canonical } from "./contracts.mjs";

const METHOD = "browser-focus-outline-adjacent-pixels";
const SELECTOR = "#addImportButton";
const MODE = "light";
const STATE_ID = "keyboard-focus";
const ROLE_ID = "focus.outline";
const THRESHOLD = 3;
const HEX_64 = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MANIFEST_KINDS = new Set([
  "skin-palette-m57-kimi-focus-targeted-validation",
  "skin-palette-m57-qwen-focus-targeted-validation",
]);
const BINDING_KEYS = [
  "bindingHash",
  "candidateHash",
  "candidateId",
  "candidateSetHash",
  "fixtureHash",
  "policyHash",
  "sourceHashCount",
  "sourceHashSet",
  "sourceHashes",
  "sourceRun",
];
const ERROR_BUCKETS = ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"];

function fail(message) {
  throw new Error(`review focus supplement: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) fail(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be a safe integer >= ${minimum}`);
  return value;
}

function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
}

function requireExactKeys(value, expected, label) {
  const record = requireRecord(value, label);
  if (!isDeepStrictEqual(Object.keys(record).sort(), [...expected].sort())) {
    fail(`${label} has unexpected fields`);
  }
  return record;
}

function cloneJson(value, label) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    fail(`${label} must be JSON data (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof text !== "string") fail(`${label} must be JSON data`);
  return JSON.parse(text);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return requireRecord(value, label);
}

function requireSafeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`${label} must be a relative POSIX path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`${label} must not contain empty, dot, or parent segments`);
  }
  return value;
}

function joinRelative(base, relative) {
  return base === "." ? relative : `${base}/${relative}`;
}

async function readBytes(readContainedBytes, relativePath, label) {
  let bytes;
  try {
    bytes = await readContainedBytes(relativePath);
  } catch (error) {
    fail(`${label} read was rejected (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail(`${label} is missing or was rejected by the containment reader`);
  }
  return Buffer.from(bytes);
}

function zeroSpotlight(value, label) {
  const record = requireRecord(value, label);
  if (record.documentCount !== 0 || record.shellCount !== 0) {
    fail(`${label} must report zero spotlight hosts`);
  }
  if (!isDeepStrictEqual(requireArray(record.hosts, `${label}.hosts`), [])) {
    fail(`${label}.hosts must be empty`);
  }
}

function validateExpectedContext({ candidate, candidateSetHash, sourceHashes, policyHash, fixtureHash }) {
  const candidateRecord = requireRecord(candidate, "candidate");
  requireString(candidateRecord.id, "candidate.id");
  requireHash(candidateRecord.candidateHash, "candidate.candidateHash");
  requireHash(candidateRecord.profileHash, "candidate.profileHash");
  requireHash(candidateRecord.policyHash, "candidate.policyHash");
  requireHash(candidateSetHash, "candidateSetHash");
  requireHash(policyHash, "policyHash");
  requireHash(fixtureHash, "fixtureHash");
  requireString(candidateRecord.skinId, "candidate.skinId");
  requireString(candidateRecord.variant, "candidate.variant");
  if (hashCandidate(candidateRecord) !== candidateRecord.candidateHash) {
    fail("candidate hash is not self-consistent");
  }
  if (candidateRecord.policyHash !== policyHash) fail("candidate policy hash does not match expected policy");

  const profileSnapshot = requireRecord(candidateRecord.profileSnapshot, "candidate.profileSnapshot");
  const profileVersion = requireInteger(profileSnapshot.version, "candidate.profileSnapshot.version", 1);

  const sourceHashRecord = requireRecord(sourceHashes, "sourceHashes");
  const sourcePaths = Object.keys(sourceHashRecord);
  const expectedSourcePaths = new Set(SOURCE_FILES);
  if (
    sourcePaths.length !== SOURCE_FILES.length ||
    sourcePaths.some((sourcePath) => !expectedSourcePaths.has(sourcePath))
  ) {
    fail("sourceHashes keys must match capture.mjs SOURCE_FILES");
  }
  for (const sourcePath of sourcePaths) {
    requireSafeRelativePath(sourcePath, "sourceHashes path");
    requireHash(sourceHashRecord[sourcePath], `sourceHashes[${sourcePath}]`);
  }

  return {
    candidate: candidateRecord,
    candidateSetHash,
    policyHash,
    fixtureHash,
    profileVersion,
    sourceHashCount: SOURCE_FILES.length,
    sourceHashes: sourceHashRecord,
    sourceHashSet: sha256Canonical(sourceHashRecord),
  };
}

function validateOriginalRecord(record) {
  requireRecord(record, "originalRecord");
  requireString(record.candidateId, "originalRecord.candidateId");
  if (record.mode !== MODE || record.stateId !== STATE_ID || record.roleId !== ROLE_ID) {
    fail("originalRecord is outside the supported light/keyboard-focus/focus.outline target");
  }
  if (
    record.result !== "unmeasured" ||
    record.ratio !== null ||
    record.threshold !== THRESHOLD ||
    record.method !== METHOD ||
    record.reason !== "spotlight-active"
  ) {
    fail("originalRecord must be the expected spotlight-active unmeasured record");
  }
  requireString(record.evidence, "originalRecord.evidence");
  let evidence;
  try {
    evidence = JSON.parse(record.evidence);
  } catch {
    fail("originalRecord.evidence is not valid JSON");
  }
  const evidenceRecord = requireRecord(evidence, "originalRecord.evidence");
  const captures = requireRecord(evidenceRecord.captures, "originalRecord.evidence.captures");
  const analysis = requireRecord(evidenceRecord.analysis, "originalRecord.evidence.analysis");
  if (
    evidenceRecord.kind !== METHOD ||
    evidenceRecord.selector !== SELECTOR ||
    captures.focused !== null ||
    analysis.result !== "unmeasured" ||
    analysis.ratio !== null ||
    analysis.threshold !== THRESHOLD ||
    analysis.reason !== "spotlight-active"
  ) {
    fail("originalRecord.evidence is not the expected spotlight-active capture evidence");
  }
}

function isTargetRecord(record, candidateId) {
  return (
    isRecord(record) &&
    record.candidateId === candidateId &&
    record.mode === MODE &&
    record.stateId === STATE_ID &&
    record.roleId === ROLE_ID
  );
}

function validateManifestBinding(manifest, expected) {
  if (!MANIFEST_KINDS.has(manifest.kind)) fail("manifest kind is not a supported focus supplement");
  if (manifest.status !== "complete" || manifest.complete !== true) fail("manifest is not complete");
  if (manifest.fatalError !== null) fail("manifest contains a fatal error");
  if (manifest.kind !== `skin-palette-m57-${expected.candidate.skinId}-focus-targeted-validation`) {
    fail("manifest kind does not match the candidate skin");
  }

  const errors = requireRecord(manifest.errors, "manifest.errors");
  for (const key of ERROR_BUCKETS) {
    const bucket = requireArray(errors[key], `manifest.errors.${key}`);
    if (bucket.length !== 0) fail(`manifest.errors.${key} must be empty`);
  }

  const scope = requireRecord(manifest.scope, "manifest.scope");
  requireString(scope.candidateId, "manifest.scope.candidateId");
  requireHash(scope.candidateHash, "manifest.scope.candidateHash");
  requireString(scope.skinId, "manifest.scope.skinId");
  requireString(scope.variant, "manifest.scope.variant");
  requireString(scope.mode, "manifest.scope.mode");
  requireString(scope.stateId, "manifest.scope.stateId");
  requireString(scope.roleId, "manifest.scope.roleId");
  requireString(scope.selector, "manifest.scope.selector");
  if (
    scope.candidateId !== expected.candidate.id ||
    scope.candidateHash !== expected.candidate.candidateHash ||
    scope.skinId !== expected.candidate.skinId ||
    scope.variant !== expected.candidate.variant ||
    scope.mode !== MODE ||
    scope.stateId !== STATE_ID ||
    scope.roleId !== ROLE_ID ||
    scope.selector !== SELECTOR ||
    scope.roleCount !== 1
  ) {
    fail("manifest scope does not match the registered target");
  }

  const source = requireRecord(manifest.source, "manifest.source");
  const runDir = requireSafeRelativePath(source.runDir, "manifest.source.runDir");
  if (
    source.candidateId !== expected.candidate.id ||
    source.candidateHash !== expected.candidate.candidateHash ||
    source.candidateSetHash !== expected.candidateSetHash ||
    source.candidateProfileSnapshotVersion !== expected.profileVersion
  ) {
    fail("manifest source does not match the expected candidate");
  }

  const binding = requireExactKeys(manifest.binding, BINDING_KEYS, "manifest.binding");
  const { bindingHash, ...bindingContent } = binding;
  requireHash(bindingHash, "manifest.binding.bindingHash");
  if (sha256Canonical(bindingContent) !== bindingHash) fail("manifest binding hash is not self-consistent");
  requireSafeRelativePath(binding.sourceRun, "manifest.binding.sourceRun");
  if (
    binding.sourceRun !== runDir ||
    binding.candidateId !== expected.candidate.id ||
    binding.candidateHash !== expected.candidate.candidateHash ||
    binding.candidateSetHash !== expected.candidateSetHash ||
    binding.policyHash !== expected.policyHash ||
    binding.fixtureHash !== expected.fixtureHash ||
    binding.sourceHashCount !== expected.sourceHashCount ||
    !isDeepStrictEqual(binding.sourceHashes, expected.sourceHashes) ||
    binding.sourceHashSet !== expected.sourceHashSet
  ) {
    fail("manifest binding does not match the original capture context");
  }

  const fixture = requireRecord(manifest.fixture, "manifest.fixture");
  if (
    fixture.expectedHash !== expected.fixtureHash ||
    fixture.actualHash !== expected.fixtureHash ||
    fixture.verified !== true
  ) {
    fail("manifest fixture does not match the original capture");
  }

  const measurement = requireRecord(manifest.measurement, "manifest.measurement");
  if (measurement.method !== METHOD || measurement.selector !== SELECTOR) {
    fail("manifest measurement method or selector is unsupported");
  }
  return measurement;
}

function validateAnalysis(analysis, originalRecord) {
  const record = requireRecord(analysis, "measurement.analysis");
  if (record.result !== "pass") fail("measurement analysis did not pass");
  const ratio = requireFinite(record.ratio, "measurement.analysis.ratio");
  const threshold = requireFinite(record.threshold, "measurement.analysis.threshold");
  if (threshold !== THRESHOLD || threshold !== originalRecord.threshold) {
    fail("measurement threshold does not match the original record");
  }
  if (ratio < threshold) fail("measurement ratio is below threshold");
  requireString(record.reason, "measurement.analysis.reason");
  requireInteger(record.corePixelCount, "measurement.analysis.corePixelCount", 1);
  requireInteger(record.backgroundPixelCount, "measurement.analysis.backgroundPixelCount", 1);

  const diagnostics = requireRecord(record.diagnostics, "measurement.analysis.diagnostics");
  const clip = requireRecord(diagnostics.clip, "measurement.analysis.diagnostics.clip");
  if (clip.complete !== true) fail("measurement analysis clip is incomplete");
  const requiredBounds = requireRecord(clip.requiredBounds, "measurement.analysis.diagnostics.clip.requiredBounds");
  for (const key of ["left", "top", "right", "bottom"]) {
    requireFinite(requiredBounds[key], `measurement.analysis.diagnostics.clip.requiredBounds.${key}`);
  }
  const backgroundAlpha = requireRecord(
    diagnostics.backgroundAlpha,
    "measurement.analysis.diagnostics.backgroundAlpha",
  );
  const outlineColor = requireRecord(diagnostics.coreOutlineColor, "measurement.analysis.diagnostics.coreOutlineColor");
  if (backgroundAlpha.nonOpaquePixels !== 0 || outlineColor.mismatchPixels !== 0) {
    fail("measurement analysis reports pixel diagnostics failures");
  }
  if (
    !isDeepStrictEqual(diagnostics.missingCoreRegions, []) ||
    !isDeepStrictEqual(diagnostics.missingBackgroundRegions, []) ||
    !isDeepStrictEqual(diagnostics.reasons, [])
  ) {
    fail("measurement analysis reports missing regions or reasons");
  }
  return { analysis: record, requiredBounds };
}

function validateClip(value, label) {
  const clip = requireRecord(value, label);
  return {
    x: requireInteger(clip.x, `${label}.x`),
    y: requireInteger(clip.y, `${label}.y`),
    width: requireInteger(clip.width, `${label}.width`, 1),
    height: requireInteger(clip.height, `${label}.height`, 1),
  };
}

function validateProbe(value, label) {
  const probe = requireRecord(value, label);
  const identity = requireRecord(probe.identity, `${label}.identity`);
  if (identity.count !== 1 || identity.sameNode !== true || identity.connected !== true) {
    fail(`${label} did not observe one connected target node`);
  }
  if (probe.active !== true || probe.focusVisible !== true || probe.spotlightCount !== 0) {
    fail(`${label} is not a naturally focused, zero-spotlight probe`);
  }
  const rect = requireRecord(probe.rect, `${label}.rect`);
  return {
    x: requireFinite(rect.x, `${label}.rect.x`),
    y: requireFinite(rect.y, `${label}.rect.y`),
    width: requireFinite(rect.width, `${label}.rect.width`),
    height: requireFinite(rect.height, `${label}.rect.height`),
  };
}

function validatePreparationAndDiagnostics(manifest, diagnostics, clip) {
  const preparation = requireRecord(manifest.preparation, "manifest.preparation");
  const focus = requireRecord(preparation.focus, "manifest.preparation.focus");
  const step = requireRecord(focus.step, "manifest.preparation.focus.step");
  if (
    step.action !== "focus" ||
    step.selector !== SELECTOR ||
    step.focusStrategy !== "tab" ||
    step.ok !== true ||
    requireInteger(step.tabbableCount, "manifest.preparation.focus.step.tabbableCount", 1) < 1 ||
    requireInteger(step.focusPresses, "manifest.preparation.focus.step.focusPresses", 1) < 1
  ) {
    fail("manifest does not prove natural Tab focus");
  }
  zeroSpotlight(
    requireRecord(preparation.pointer, "manifest.preparation.pointer").spotlightAfterPointerLeave,
    "manifest.preparation.pointer.spotlightAfterPointerLeave",
  );
  zeroSpotlight(focus.spotlightAfterFocus, "manifest.preparation.focus.spotlightAfterFocus");
  zeroSpotlight(
    requireRecord(preparation.scroll, "manifest.preparation.scroll").spotlightAfterScroll,
    "manifest.preparation.scroll.spotlightAfterScroll",
  );

  const diagnosticRecord = requireRecord(diagnostics, "measurement.diagnostics");
  if (diagnosticRecord.selector !== SELECTOR || diagnosticRecord.mutated !== false) {
    fail("measurement diagnostics selector or mutation state is invalid");
  }
  const probes = requireRecord(diagnosticRecord.probes, "measurement.diagnostics.probes");
  const before = validateProbe(probes.before, "measurement.diagnostics.probes.before");
  const afterFocused = validateProbe(probes.afterFocused, "measurement.diagnostics.probes.afterFocused");
  const afterDecode = validateProbe(probes.afterDecode, "measurement.diagnostics.probes.afterDecode");
  if (!isDeepStrictEqual(before, afterFocused) || !isDeepStrictEqual(before, afterDecode)) {
    fail("measurement probes observed different target rectangles");
  }
  if (
    clip.x > before.x ||
    clip.y > before.y ||
    clip.x + clip.width < before.x + before.width ||
    clip.y + clip.height < before.y + before.height
  ) {
    fail("measurement clip does not contain the focused target");
  }

  const decoded = requireRecord(diagnosticRecord.decoded, "measurement.diagnostics.decoded");
  if (decoded.width !== clip.width || decoded.height !== clip.height) {
    fail("measurement decoded dimensions do not match the clip");
  }
}

function validateAnalysisBounds(requiredBounds, clip) {
  if (
    requiredBounds.left < 0 ||
    requiredBounds.top < 0 ||
    requiredBounds.right > clip.width ||
    requiredBounds.bottom > clip.height
  ) {
    fail("measurement analysis required bounds are outside the clip");
  }
}

function pngDimensions(bytes, label) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${label} does not have a PNG signature`);
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") fail(`${label} does not start with an IHDR chunk`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function validateRawFrame({ measurement, manifestDir, readContainedBytes, clip }) {
  const captures = requireRecord(measurement.captures, "measurement.captures");
  if (captures.rawFrameCount !== 1) fail("measurement.captures must contain exactly one raw frame");
  const rawFrames = requireArray(captures.rawFrames, "measurement.captures.rawFrames");
  if (rawFrames.length !== 1) fail("measurement.captures.rawFrames must contain exactly one frame");
  const frame = requireRecord(rawFrames[0], "measurement.captures.rawFrames[0]");
  if (frame.key !== "focused" || frame.kind !== "focus-outline-adjacent-focused") {
    fail("measurement raw frame identity is unsupported");
  }
  const relativeFile = requireSafeRelativePath(frame.file, "measurement raw frame file");
  const frameClip = validateClip(frame.clip, "measurement raw frame clip");
  if (!isDeepStrictEqual(frameClip, clip)) fail("measurement raw frame clip does not match captures clip");
  const expectedBytes = requireInteger(frame.bytes, "measurement raw frame bytes", 1);
  const expectedHash = requireHash(frame.sha256, "measurement raw frame sha256");
  const rawPath = joinRelative(manifestDir, relativeFile);
  const bytes = await readBytes(readContainedBytes, rawPath, "measurement raw frame");
  if (bytes.length !== expectedBytes) fail("measurement raw frame byte count does not match");
  if (sha256Bytes(bytes) !== expectedHash) fail("measurement raw frame hash does not match");
  const dimensions = pngDimensions(bytes, "measurement raw frame");
  if (dimensions.width !== clip.width || dimensions.height !== clip.height) {
    fail("measurement raw frame PNG dimensions do not match the clip");
  }
}

function validateOutcome(manifest, analysis) {
  const outcome = requireRecord(manifest.outcome, "manifest.outcome");
  if (
    outcome.result !== analysis.result ||
    outcome.ratio !== analysis.ratio ||
    outcome.threshold !== analysis.threshold ||
    outcome.reason !== analysis.reason
  ) {
    fail("manifest outcome does not match measurement analysis");
  }
}

export async function createReviewFocusSupplement(options) {
  const input = requireRecord(options, "options");
  if (typeof input.readContainedBytes !== "function") {
    fail("readContainedBytes must be a function");
  }
  const registration = requireExactKeys(
    cloneJson(input.registration, "registration"),
    ["manifestPath", "manifestSha256", "originalRecord"],
    "registration",
  );
  const manifestPath = requireSafeRelativePath(registration.manifestPath, "registration.manifestPath");
  const manifestSha256 = requireHash(registration.manifestSha256, "registration.manifestSha256");
  const originalRecord = cloneJson(registration.originalRecord, "registration.originalRecord");
  validateOriginalRecord(originalRecord);

  const expected = validateExpectedContext({
    candidate: cloneJson(input.candidate, "candidate"),
    candidateSetHash: input.candidateSetHash,
    sourceHashes: cloneJson(input.sourceHashes, "sourceHashes"),
    policyHash: input.policyHash,
    fixtureHash: input.fixtureHash,
  });
  if (expected.candidate.id !== originalRecord.candidateId) {
    fail("originalRecord candidate does not match the expected candidate");
  }

  const browserRecords = cloneJson(input.browserRecords, "browserRecords");
  if (!Array.isArray(browserRecords)) fail("browserRecords must be an array");
  const targets = browserRecords.filter((record) => isTargetRecord(record, expected.candidate.id));
  if (targets.length !== 1) fail("browserRecords must contain exactly one target record");

  const manifestBytes = await readBytes(input.readContainedBytes, manifestPath, "manifest");
  if (sha256Bytes(manifestBytes) !== manifestSha256) fail("manifest hash does not match registration");
  const manifest = parseJsonObject(manifestBytes, "manifest");
  const manifestMeasurement = validateManifestBinding(manifest, expected);

  const manifestDir = path.posix.dirname(manifestPath);
  const measurementPaths = {
    measurement: joinRelative(manifestDir, "measurement/measurement.json"),
    analysis: joinRelative(manifestDir, "measurement/analysis.json"),
    captures: joinRelative(manifestDir, "measurement/captures.json"),
    diagnostics: joinRelative(manifestDir, "measurement/diagnostics.json"),
  };
  const [measurementBytes, analysisBytes, capturesBytes, diagnosticsBytes] = await Promise.all([
    readBytes(input.readContainedBytes, measurementPaths.measurement, "measurement.json"),
    readBytes(input.readContainedBytes, measurementPaths.analysis, "analysis.json"),
    readBytes(input.readContainedBytes, measurementPaths.captures, "captures.json"),
    readBytes(input.readContainedBytes, measurementPaths.diagnostics, "diagnostics.json"),
  ]);
  const measurement = parseJsonObject(measurementBytes, "measurement.json");
  const diskAnalysis = parseJsonObject(analysisBytes, "analysis.json");
  const diskCaptures = parseJsonObject(capturesBytes, "captures.json");
  const diskDiagnostics = parseJsonObject(diagnosticsBytes, "diagnostics.json");
  if (!isDeepStrictEqual(manifestMeasurement, measurement)) {
    fail("manifest measurement does not match measurement.json");
  }
  if (!isDeepStrictEqual(measurement.analysis, diskAnalysis)) {
    fail("measurement analysis does not match analysis.json");
  }
  if (!isDeepStrictEqual(measurement.captures, diskCaptures)) {
    fail("measurement captures does not match captures.json");
  }
  if (!isDeepStrictEqual(measurement.diagnostics, diskDiagnostics)) {
    fail("measurement diagnostics does not match diagnostics.json");
  }

  const { analysis, requiredBounds } = validateAnalysis(measurement.analysis, originalRecord);
  const clip = validateClip(
    requireRecord(measurement.captures, "measurement.captures").clip,
    "measurement.captures.clip",
  );
  validateAnalysisBounds(requiredBounds, clip);
  validatePreparationAndDiagnostics(manifest, measurement.diagnostics, clip);
  validateOutcome(manifest, analysis);
  await validateRawFrame({
    measurement,
    manifestDir,
    readContainedBytes: input.readContainedBytes,
    clip,
  });

  const effectiveRecord = cloneJson(originalRecord, "originalRecord");
  effectiveRecord.result = "pass";
  effectiveRecord.ratio = analysis.ratio;
  effectiveRecord.threshold = analysis.threshold;
  effectiveRecord.reason = analysis.reason;
  effectiveRecord.method = METHOD;
  effectiveRecord.evidence = JSON.stringify({
    kind: "verified-focus-supplement",
    manifestPath,
    manifestSha256,
    originalEvidence: originalRecord.evidence,
  });

  const browserRecord = targets[0];
  if (!isDeepStrictEqual(browserRecord, originalRecord) && !isDeepStrictEqual(browserRecord, effectiveRecord)) {
    fail("browser target must be the original U or its identical effective PASS");
  }

  const diagnostic = {
    schemaVersion: 1,
    kind: "skin-palette-review-focus-supplement",
    manifestPath,
    manifestSha256,
    candidate: {
      id: expected.candidate.id,
      candidateHash: expected.candidate.candidateHash,
      candidateSetHash: expected.candidateSetHash,
      profileHash: expected.candidate.profileHash,
      profileSnapshotVersion: expected.profileVersion,
      policyHash: expected.policyHash,
      fixtureHash: expected.fixtureHash,
      sourceHashCount: expected.sourceHashCount,
      sourceHashSet: expected.sourceHashSet,
    },
    originalRecord: cloneJson(originalRecord, "originalRecord"),
    effectiveRecord: cloneJson(effectiveRecord, "effectiveRecord"),
    manifest: cloneJson(manifest, "manifest"),
  };

  return {
    effectiveRecord,
    originalRecord,
    diagnostic,
  };
}
