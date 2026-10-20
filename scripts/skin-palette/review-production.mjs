import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { SKIN_PALETTES } from "../../public/skin-palettes.js";
import { enumerateSourceAssets, PALETTE_TOKEN_KEYS } from "../../public/skins.js";
import {
  captureStateMatrix,
  readCapturedBaselineEvidence,
  readCapturedUnitEvidence,
  SOURCE_FILES,
  STATE_MATRIX_GROUPS,
} from "./capture.mjs";
import {
  canonicalJson,
  collectSourceHashes,
  sha256Canonical,
  SKIN_IDS,
  validateCandidate,
  validateCandidateSet,
  validatePolicy,
  validateSelections,
} from "./contracts.mjs";
import { hexToSrgb } from "./color-math.mjs";
import { loadPreviewCandidate } from "./review-cli.mjs";
import {
  classifyProductionCapture,
  readProductionCaptureChecks,
  runReviewCapture,
  summarizeProductionCapture,
} from "./review-capture.mjs";
import { REPO_ROOT } from "./review-evidence.mjs";
import { STATE_CATALOG } from "./roles.mjs";
import { createSelectionExport } from "./review-selection.mjs";
import {
  createPaletteFixture,
  createTimelineWarningFixture,
  getPaletteFixtureHash,
} from "../../test-support/skin-palette-fixture.mjs";

const MODES = ["light", "dark"];
const PRODUCTION_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_PREIMAGE_FILES = Object.freeze([
  "public/skin-palettes.js",
  "public/skin-picker.js",
  "public/skin-bootstrap.js",
]);
export const GENERATED_ASSET_TOOL_FILES = Object.freeze([
  "package.json",
  "biome.json",
  "scripts/prepare-skin-assets.mjs",
  "scripts/skin-palette/bootstrap-source.mjs",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOwn(record, key) {
  if (!isRecord(record) || !Object.hasOwn(record, key)) return { found: false, value: null };
  return { found: true, value: record[key] };
}

function decodeProductionColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!PRODUCTION_HEX.test(trimmed)) return null;
  try {
    return hexToSrgb(trimmed);
  } catch {
    return null;
  }
}

function sameColor(left, right) {
  return left.every((channel, index) => channel === right[index]);
}

function assertCandidate(candidate) {
  const result = validateCandidate(candidate);
  if (result.valid) return;
  const first = result.errors[0];
  throw new TypeError(`candidate 无效：${first?.path ?? "$"} ${first?.message ?? "M0 契约校验失败"}`);
}

function assertProductionPalettes(value) {
  if (!isRecord(value)) throw new TypeError("productionPalettes 必须是普通对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("productionPalettes 必须是普通对象");
  }
}

function assertSelectionRecord(value) {
  const fields = ["schemaVersion", "candidateSetHash", "assessmentHash", "choices", "decisionSource", "recordedAt"];
  if (!isRecord(value)) throw new TypeError("selections 必须是普通对象或 null-prototype 对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("selections 必须是普通对象或 null-prototype 对象");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError(
      "selections 必须恰好包含 schemaVersion、candidateSetHash、assessmentHash、choices、decisionSource、recordedAt",
    );
  }
}

function assertValid(result, name) {
  if (result.valid) return;
  const first = result.errors[0];
  throw new TypeError(`${name} 无效：${first?.path ?? "$"} ${first?.message ?? "契约校验失败"}`);
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCandidateMatches(actual, expected, stage) {
  if (
    !isPlainRecord(actual) ||
    actual.id !== expected.id ||
    actual.candidateHash !== expected.candidateHash ||
    !isDeepStrictEqual(actual, expected)
  ) {
    throw new TypeError(`${stage} candidate id/hash/content does not match the verified selection`);
  }
}

function assertProductionMatrixResult(result, { skinId, outDir }) {
  if (!isPlainRecord(result)) throw new TypeError("captureResult must be a matrix result object");
  if (result.skinId !== skinId) throw new TypeError("captureResult.skinId does not match the selected production skin");
  if (typeof result.outDir !== "string" || path.resolve(result.outDir) !== path.resolve(REPO_ROOT, outDir)) {
    throw new TypeError("captureResult.outDir does not match the requested output directory");
  }
  if (
    !isPlainRecord(result.progress) ||
    !isPlainRecord(result.progress.units) ||
    !Array.isArray(result.progress.attempts)
  ) {
    throw new TypeError("captureResult.progress does not match the capture matrix shape");
  }

  const modes = result.modes;
  if (!isPlainRecord(modes) || Object.keys(modes).sort().join(",") !== "dark,light") {
    throw new TypeError("captureResult.modes must contain exactly light and dark");
  }
  if (!isPlainRecord(modes.light) || !isPlainRecord(modes.dark)) {
    throw new TypeError("captureResult.modes entries must be objects");
  }

  const meta = result.capture;
  if (
    !isPlainRecord(meta) ||
    meta.schemaVersion !== 1 ||
    meta.kind !== "skin-palette-capture-matrix" ||
    !isDeepStrictEqual(meta.modes, modes)
  ) {
    throw new TypeError("captureResult.capture must be a matching skin-palette-capture-matrix record");
  }
  const capturedCandidate = meta.candidate;
  if (
    !isPlainRecord(capturedCandidate) ||
    capturedCandidate.production !== true ||
    capturedCandidate.skinId !== skinId ||
    Object.hasOwn(capturedCandidate, "id") ||
    Object.hasOwn(capturedCandidate, "candidateHash")
  ) {
    throw new TypeError("captureResult.capture.candidate must identify production mode and the selected skin only");
  }
}

const isUrlLikePath = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(file|https?|ftp|data|blob|ws|wss|url):/i.test(value);
const hasNonDriveUrlScheme = (value) => /^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(value);

function isStrictPathChild(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readProductionBindingJson({ parentReal, filePath, label }) {
  const bytes = await readProductionBindingBytes({ parentReal, filePath, label });
  return { value: parseProductionBindingJson(bytes, label), bytes };
}

async function readProductionBindingBytes({ parentReal, filePath, label }) {
  return (await readProductionBindingFile({ parentReal, filePath, label })).bytes;
}

async function readProductionBindingFile({ parentReal, filePath, label }) {
  if (!isStrictPathChild(parentReal, filePath)) throw new TypeError(`${label} path escapes its verified directory`);
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink or junction`);
  if (!info.isFile()) throw new TypeError(`${label} must be a regular file`);
  const fileReal = await realpath(filePath);
  if (!isStrictPathChild(parentReal, fileReal)) throw new TypeError(`${label} realpath escapes its verified directory`);
  return { bytes: await readFile(fileReal), fileReal };
}

function parseProductionBindingJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`${label} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
  return value;
}

async function resolveProductionBindingDirectories(runDir, outDir) {
  for (const [label, value] of [
    ["runDir", runDir],
    ["captureResult.outDir", outDir],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${label} must be a non-empty filesystem path`);
    }
    if (isUrlLikePath(value)) throw new TypeError(`${label} must be a filesystem path, not a URL`);
  }

  const repoReal = await realpath(REPO_ROOT);
  const validationRoot = path.resolve(REPO_ROOT, "docs", "validation");
  const validationRootReal = await realpath(validationRoot);
  if (!isStrictPathChild(repoReal, validationRootReal)) {
    throw new TypeError("docs/validation realpath must be a strict child of REPO_ROOT");
  }

  const resolvedRunDir = path.resolve(REPO_ROOT, runDir);
  const resolvedOutDir = path.resolve(REPO_ROOT, outDir);
  if (!isStrictPathChild(validationRoot, resolvedRunDir)) {
    throw new TypeError("runDir must be a strict child of docs/validation");
  }
  if (!isStrictPathChild(validationRoot, resolvedOutDir)) {
    throw new TypeError("captureResult.outDir must be a strict child of docs/validation");
  }

  const [runReal, outReal] = await Promise.all([realpath(resolvedRunDir), realpath(resolvedOutDir)]);
  if (!isStrictPathChild(validationRootReal, runReal)) {
    throw new TypeError("runDir realpath must be a strict child of docs/validation");
  }
  if (!isStrictPathChild(validationRootReal, outReal)) {
    throw new TypeError("captureResult.outDir realpath must be a strict child of docs/validation");
  }
  if (runReal === outReal) throw new TypeError("runDir and captureResult.outDir must be different directories");

  const [runInfo, outInfo] = await Promise.all([stat(runReal), stat(outReal)]);
  if (!runInfo.isDirectory()) throw new TypeError("runDir must be an existing directory");
  if (!outInfo.isDirectory()) throw new TypeError("captureResult.outDir must be an existing directory");

  const originRun = path.relative(repoReal, runReal).split(path.sep).join("/");
  if (!originRun.startsWith("docs/validation/") || path.posix.isAbsolute(originRun) || isUrlLikePath(originRun)) {
    throw new TypeError("originRun must be a repository-relative docs/validation path");
  }
  return { originRun, runReal, outReal };
}

async function resolveProductionRunDirectory(runDir) {
  if (typeof runDir !== "string" || runDir.trim() === "") {
    throw new TypeError("runDir must be a non-empty filesystem path");
  }
  if (isUrlLikePath(runDir) || hasNonDriveUrlScheme(runDir)) {
    throw new TypeError("runDir must be a filesystem path, not a URL");
  }

  const repoReal = await realpath(REPO_ROOT);
  const validationRoot = path.resolve(REPO_ROOT, "docs", "validation");
  const validationRootReal = await realpath(validationRoot);
  if (!isStrictPathChild(repoReal, validationRootReal)) {
    throw new TypeError("docs/validation realpath must be a strict child of REPO_ROOT");
  }

  const resolvedRunDir = path.resolve(REPO_ROOT, runDir);
  if (!isStrictPathChild(validationRoot, resolvedRunDir)) {
    throw new TypeError("runDir must be a strict child of docs/validation");
  }
  const runReal = await realpath(resolvedRunDir);
  if (!isStrictPathChild(validationRootReal, runReal)) {
    throw new TypeError("runDir realpath must be a strict child of docs/validation");
  }
  if (!(await stat(runReal)).isDirectory()) throw new TypeError("runDir must be an existing directory");

  const originRun = path.relative(repoReal, runReal).split(path.sep).join("/");
  if (!originRun.startsWith("docs/validation/") || path.posix.isAbsolute(originRun) || isUrlLikePath(originRun)) {
    throw new TypeError("originRun must be a repository-relative docs/validation path");
  }
  return { validationRootReal, resolvedRunDir, runReal, originRun };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveProductionReadRoot(options, functionName) {
  if (!isPlainRecord(options)) throw new TypeError("options must be a plain or null-prototype object");
  for (const key of Reflect.ownKeys(options)) {
    if (key !== "rootDir") throw new TypeError(`unknown ${functionName} option ${String(key)}`);
  }
  const rootDescriptor = Object.getOwnPropertyDescriptor(options, "rootDir");
  if (rootDescriptor && !Object.hasOwn(rootDescriptor, "value")) {
    throw new TypeError("rootDir must be an own data property");
  }
  const rootDir = rootDescriptor ? rootDescriptor.value : REPO_ROOT;
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new TypeError("rootDir must be a non-empty filesystem path");
  }
  if (isUrlLikePath(rootDir) || hasNonDriveUrlScheme(rootDir)) {
    throw new TypeError("rootDir must be a filesystem path, not a URL");
  }

  if (rootDir === REPO_ROOT) {
    const rootReal = await realpath(REPO_ROOT);
    if (!(await stat(rootReal)).isDirectory()) throw new TypeError("REPO_ROOT must be an existing directory");
    return rootReal;
  }
  const { runReal } = await resolveProductionRunDirectory(rootDir);
  return runReal;
}

function assertExactOwnKeys(value, expectedKeys, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(expectedKeys);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} must contain exactly the registered keys`);
  }
}

/** Read the raw-byte-bound M6 precheck and its three fixed, non-executable source preimages. */
export async function readProductionSourceSnapshot(options = {}) {
  const { runDir, precheckFileSha256 } = options ?? {};
  if (
    !isPlainRecord(options) ||
    !Object.hasOwn(options, "precheckFileSha256") ||
    typeof precheckFileSha256 !== "string" ||
    !SHA256_HEX.test(precheckFileSha256)
  ) {
    throw new TypeError("precheckFileSha256 must be an explicit 64-character lowercase SHA-256");
  }

  const { runReal, originRun } = await resolveProductionRunDirectory(runDir);
  const precheckLabel = "integration-precheck.json";
  const precheckBytes = await readProductionBindingBytes({
    parentReal: runReal,
    filePath: path.join(runReal, precheckLabel),
    label: precheckLabel,
  });
  if (sha256Bytes(precheckBytes) !== precheckFileSha256) {
    throw new TypeError("integration-precheck.json raw byte SHA-256 does not match precheckFileSha256");
  }

  const precheck = parseProductionBindingJson(precheckBytes, precheckLabel);
  if (!isPlainRecord(precheck)) throw new TypeError("integration-precheck.json must contain an object");
  assertExactOwnKeys(precheck.sourceHashes, SOURCE_FILES, "integration-precheck.json sourceHashes");
  assertExactOwnKeys(precheck.sourcePreimages, SOURCE_PREIMAGE_FILES, "integration-precheck.json sourcePreimages");

  const sourceHashes = {};
  for (const file of SOURCE_FILES) {
    const digest = precheck.sourceHashes[file];
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new TypeError(`integration-precheck.json sourceHashes[${file}] must be a lowercase SHA-256`);
    }
    sourceHashes[file] = digest;
  }

  const sourceSnapshot = {};
  for (const file of SOURCE_PREIMAGE_FILES) {
    const entry = precheck.sourcePreimages[file];
    assertExactOwnKeys(entry, ["path", "sha256"], `integration-precheck.json sourcePreimages[${file}]`);
    const expectedPath = `source-before/${file}`;
    if (entry.path !== expectedPath) {
      throw new TypeError(`integration-precheck.json sourcePreimages[${file}].path must equal ${expectedPath}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
      throw new TypeError(`integration-precheck.json sourcePreimages[${file}].sha256 must be a lowercase SHA-256`);
    }
    if (entry.sha256 !== sourceHashes[file]) {
      throw new TypeError(`integration-precheck.json sourcePreimages[${file}].sha256 must match sourceHashes`);
    }

    const label = expectedPath;
    const bytes = await readProductionBindingBytes({
      parentReal: runReal,
      filePath: path.join(runReal, "source-before", ...file.split("/")),
      label,
    });
    if (sha256Bytes(bytes) !== entry.sha256) {
      throw new TypeError(`${label} raw byte SHA-256 does not match integration-precheck.json`);
    }
    sourceSnapshot[file] = Buffer.from(bytes);
  }

  return {
    precheckPath: path.posix.join(originRun, precheckLabel),
    precheckFileSha256,
    sourceHashes,
    sourceSnapshot,
  };
}

/** Read only the fixed production source manifest and bind its parsed form to the supplied CandidateSet. */
export async function readProductionSourceManifest(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["runDir", "candidateSet"], "options");
  const runDir = optionFields.get("runDir");
  const candidateSet = optionFields.get("candidateSet");
  const { runReal, originRun } = await resolveProductionRunDirectory(runDir);
  const manifestName = "production-source-manifest.json";
  const manifestBytes = await readProductionBindingBytes({
    parentReal: runReal,
    filePath: path.join(runReal, manifestName),
    label: manifestName,
  });
  const manifestText = manifestBytes.toString("utf8");
  if (!Buffer.from(manifestText, "utf8").equals(manifestBytes)) {
    throw new TypeError(`${manifestName} must contain valid UTF-8`);
  }
  const manifest = parseProductionBindingJson(manifestBytes, manifestName);
  const { assertProductionSourceManifest } = await import("./production-source-manifest.mjs");
  assertProductionSourceManifest({ manifest, candidateSet });

  return {
    manifestPath: path.posix.join(originRun, manifestName),
    manifestFileSha256: sha256Bytes(manifestBytes),
    manifest,
  };
}

function readProductionManifestRecord(value) {
  const fields = readExactOwnDataFields(value, ["manifestPath", "manifestFileSha256", "manifest"], "manifestRecord");
  const manifestPath = fields.get("manifestPath");
  const manifestSegments = typeof manifestPath === "string" ? manifestPath.split("/") : [];
  if (
    typeof manifestPath !== "string" ||
    manifestPath.includes("\\") ||
    manifestPath.includes("\0") ||
    path.posix.isAbsolute(manifestPath) ||
    /^[a-z][a-z0-9+.-]*:/i.test(manifestPath) ||
    manifestSegments.length < 4 ||
    manifestSegments[0] !== "docs" ||
    manifestSegments[1] !== "validation" ||
    manifestSegments.at(-1) !== "production-source-manifest.json" ||
    manifestSegments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(
      "manifestRecord.manifestPath must be a strict docs/validation POSIX path ending in production-source-manifest.json",
    );
  }
  const manifestFileSha256 = fields.get("manifestFileSha256");
  if (typeof manifestFileSha256 !== "string" || !SHA256_HEX.test(manifestFileSha256)) {
    throw new TypeError("manifestRecord.manifestFileSha256 must be a lowercase 64-character SHA-256");
  }
  return fields;
}

/** Bind the four declared origin metadata files to the parsed objects returned by the evidence loader. */
export async function verifyProductionOriginMetadata(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifestRecord", "evidence"], "options");
  const manifestRecordFields = readProductionManifestRecord(optionFields.get("manifestRecord"));

  const evidenceFields = readOwnDataFields(optionFields.get("evidence"), "evidence");
  const runFields = readOwnDataFields(evidenceFields.get("run"), "evidence.run");
  const loaderRunDir = runFields.get("dir");
  const loaderCandidatesPath = runFields.get("candidatesPath");
  const loaderIndexFields = readOwnDataFields(runFields.get("index"), "evidence.run.index");
  const loaderIndexPath = loaderIndexFields.get("path");
  if (
    typeof loaderRunDir !== "string" ||
    loaderRunDir.trim() === "" ||
    loaderRunDir.includes("\0") ||
    !path.isAbsolute(loaderRunDir) ||
    typeof loaderCandidatesPath !== "string" ||
    loaderCandidatesPath.length === 0 ||
    loaderCandidatesPath.includes("\0") ||
    typeof loaderIndexPath !== "string" ||
    loaderIndexPath.trim() === "" ||
    loaderIndexPath.includes("\0") ||
    !path.isAbsolute(loaderIndexPath)
  ) {
    throw new TypeError("evidence.run must contain absolute dir/index.path and a non-empty candidatesPath");
  }
  const candidateSetFields = readOwnDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet");
  const candidateSet = candidateSetFields.get("data");
  const reviewFields = readOwnDataFields(evidenceFields.get("review"), "evidence.review");
  const reviewPresent = reviewFields.get("present");
  if (typeof reviewPresent !== "boolean") throw new TypeError("evidence.review.present must be boolean");
  const reviewPath = reviewFields.get("path");
  const reviewContainer = reviewFields.get("container");
  if (reviewPresent && (typeof reviewPath !== "string" || reviewPath.length === 0 || !isPlainRecord(reviewContainer))) {
    throw new TypeError("present evidence.review must contain a path and object container");
  }
  if (reviewPresent) assertOwnDataTree(reviewContainer, "evidence.review.container");
  const selectionFields = readOwnDataFields(evidenceFields.get("selections"), "evidence.selections");
  const selectionsPresent = selectionFields.get("present");
  if (typeof selectionsPresent !== "boolean") throw new TypeError("evidence.selections.present must be boolean");
  const selectionsPath = selectionFields.get("path");
  const selectionRecord = selectionFields.get("record");
  if (
    selectionsPresent &&
    (typeof selectionsPath !== "string" || selectionsPath.length === 0 || !isPlainRecord(selectionRecord))
  ) {
    throw new TypeError("present evidence.selections must contain a path and object record");
  }
  if (selectionsPresent) assertOwnDataTree(selectionRecord, "evidence.selections.record");

  const manifest = manifestRecordFields.get("manifest");
  const { assertProductionSourceManifest } = await import("./production-source-manifest.mjs");
  assertProductionSourceManifest({ manifest, candidateSet });

  const origin = manifest.origin;
  const { validationRootReal, runReal } = await resolveProductionRunDirectory(origin.runDir);
  const indexSegments = origin.candidateCapturesIndex.path.split("/").slice(2);
  const samePath = (left, right) => path.relative(left, right) === "" && path.relative(right, left) === "";
  const errors = [];
  const gaps = [];
  if (!samePath(path.resolve(loaderRunDir), runReal)) {
    errors.push({
      code: "origin-metadata-path-mismatch",
      path: origin.runDir,
      detail: "loader run directory does not match the manifest origin run",
    });
  }
  const files = [
    {
      kind: "candidateSet",
      path: path.posix.join(origin.runDir, "candidates.json"),
      filePath: path.join(runReal, "candidates.json"),
      fileSha256: origin.candidateSet.fileSha256,
      loaderPath: loaderCandidatesPath,
      expectedLoaderPath: "candidates.json",
      loaderValue: candidateSet,
      logicalHash: origin.candidateSet.candidateSetHash,
    },
    {
      kind: "assessment",
      path: path.posix.join(origin.runDir, "assessments.json"),
      filePath: path.join(runReal, "assessments.json"),
      fileSha256: origin.assessment.fileSha256,
      loaderPath: reviewPresent ? reviewPath : null,
      expectedLoaderPath: "assessments.json",
      loaderValue: reviewContainer,
      logicalHash: origin.assessment.assessmentHash,
    },
    {
      kind: "selection",
      path: path.posix.join(origin.runDir, "selections.json"),
      filePath: path.join(runReal, "selections.json"),
      fileSha256: origin.selections.fileSha256,
      loaderPath: selectionsPresent ? selectionsPath : null,
      expectedLoaderPath: "selections.json",
      loaderValue: selectionRecord,
      logicalHash: origin.selections.recordHash,
    },
    {
      kind: "index",
      path: origin.candidateCapturesIndex.path,
      filePath: path.join(validationRootReal, ...indexSegments),
      fileSha256: origin.candidateCapturesIndex.fileSha256,
      loaderPath: loaderIndexPath,
    },
  ];
  for (const file of files) {
    if (file.kind !== "index" && file.loaderPath !== null && file.loaderPath !== file.expectedLoaderPath) {
      errors.push({
        code: "origin-metadata-path-mismatch",
        path: file.path,
        detail: `loader ${file.kind} path does not match the fixed origin metadata file`,
      });
    }
    if (file.kind === "assessment" && !reviewPresent) {
      gaps.push({
        code: "origin-loaded-assessment-missing",
        path: file.path,
        detail: "evidence loader reports no assessment container",
      });
    }
    if (file.kind === "selection" && !selectionsPresent) {
      gaps.push({
        code: "origin-loaded-selections-missing",
        path: file.path,
        detail: "evidence loader reports no selection record",
      });
    }
    let bytes;
    try {
      bytes = await readProductionBindingBytes({
        parentReal: validationRootReal,
        filePath: file.filePath,
        label: file.path,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        gaps.push({
          code: "origin-metadata-file-missing",
          path: file.path,
          detail: "declared origin metadata file is missing",
        });
        continue;
      }
      throw error;
    }
    if (file.kind === "index") {
      const indexReal = await realpath(file.filePath);
      if (!isStrictPathChild(validationRootReal, indexReal)) {
        throw new TypeError(`${file.path} realpath escapes its verified directory`);
      }
      if (!samePath(loaderIndexPath, indexReal)) {
        errors.push({
          code: "origin-metadata-path-mismatch",
          path: file.path,
          detail: "loader index path does not match the manifest index file realpath",
        });
      }
    }
    if (sha256Bytes(bytes) !== file.fileSha256) {
      errors.push({
        code: "origin-metadata-file-hash-mismatch",
        path: file.path,
        detail: "raw file SHA-256 does not match the manifest",
      });
    }
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
      throw new TypeError(`${file.path} must contain valid UTF-8`);
    }
    const value = parseProductionBindingJson(bytes, file.path);
    if (!isPlainRecord(value)) throw new TypeError(`${file.path} must contain a JSON object`);
    if (file.kind !== "index" && file.loaderPath !== null && !isDeepStrictEqual(value, file.loaderValue)) {
      errors.push({
        code: "origin-metadata-content-mismatch",
        path: file.path,
        detail: `parsed ${file.kind} metadata does not match the evidence loader record`,
      });
    }
    const logicalHashMatches =
      file.kind === "candidateSet"
        ? value.candidateSetHash === file.logicalHash
        : file.kind === "assessment"
          ? value.assessmentHash === file.logicalHash
          : file.kind === "selection"
            ? sha256Canonical(value) === file.logicalHash
            : true;
    if (file.kind !== "index" && !logicalHashMatches) {
      errors.push({
        code: "origin-metadata-record-hash-mismatch",
        path: file.path,
        detail: `parsed ${file.kind} logical hash does not match the manifest`,
      });
    }
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Bind every manifest capture declaration to the safely-read capture.json and evidence loader record. */
export async function verifyProductionOriginCaptures(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifestRecord", "evidence"], "options");
  const manifestRecordFields = readProductionManifestRecord(optionFields.get("manifestRecord"));
  const evidenceFields = readOwnDataFields(optionFields.get("evidence"), "evidence");
  const candidateSetFields = readOwnDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet");
  const candidateSet = candidateSetFields.get("data");
  assertOwnDataTree(candidateSet, "evidence.candidateSet.data");

  const manifest = manifestRecordFields.get("manifest");
  const { assertProductionSourceManifest } = await import("./production-source-manifest.mjs");
  assertProductionSourceManifest({ manifest, candidateSet });

  const candidateFields = readOwnDataFields(candidateSet, "evidence.candidateSet.data");
  const candidates = candidateFields.get("candidates");
  const candidateIds = candidates.map((candidate, index) =>
    readOwnDataFields(candidate, `evidence.candidateSet.data.candidates[${index}]`).get("id"),
  );
  const capturesFields = readOwnDataFields(evidenceFields.get("captures"), "evidence.captures");
  const manifestFields = readOwnDataFields(manifest, "manifest");
  const originFields = readOwnDataFields(manifestFields.get("origin"), "manifest.origin");
  const captureRecordsFields = readOwnDataFields(originFields.get("captureRecords"), "manifest.origin.captureRecords");
  const { validationRootReal } = await resolveProductionRunDirectory(originFields.get("runDir"));
  const errors = [];
  const gaps = [];
  const realPathOwners = new Map();
  const samePath = (left, right) => path.relative(left, right) === "" && path.relative(right, left) === "";

  for (const candidateId of candidateIds) {
    const label = `evidence.captures[${candidateId}]`;
    const captureRecordFields = readExactOwnDataFields(
      captureRecordsFields.get(candidateId),
      ["capturePath", "fileSha256", "sourceHashesHash"],
      `manifest.origin.captureRecords[${candidateId}]`,
    );
    const capturePath = captureRecordFields.get("capturePath");
    const add = (list, code, detail) => list.push({ code, candidateId, path: capturePath, detail });
    const loaderExists = capturesFields.has(candidateId);
    let loaderDir = null;
    let loaderCapture = null;
    if (!loaderExists) {
      add(gaps, "origin-loaded-capture-missing", "evidence loader has no capture record for this candidate");
    } else {
      const loaderFields = readOwnDataFields(capturesFields.get(candidateId), label);
      loaderDir = loaderFields.get("dir");
      loaderCapture = loaderFields.get("capture");
      if (
        typeof loaderDir !== "string" ||
        loaderDir.trim() === "" ||
        loaderDir.includes("\0") ||
        !path.isAbsolute(loaderDir)
      ) {
        throw new TypeError(`${label}.dir must be an absolute filesystem path`);
      }
      if (!isPlainRecord(loaderCapture)) throw new TypeError(`${label}.capture must be a JSON object`);
      assertOwnDataTree(loaderCapture, `${label}.capture`);
    }

    const captureSegments = capturePath.split("/").slice(2);
    const filePath = path.join(validationRootReal, ...captureSegments);
    let boundFile;
    try {
      boundFile = await readProductionBindingFile({ parentReal: validationRootReal, filePath, label: capturePath });
    } catch (error) {
      if (error?.code === "ENOENT") {
        add(gaps, "origin-capture-file-missing", "manifest-declared capture.json is missing");
        continue;
      }
      throw error;
    }

    const expectedLoaderDir = path.dirname(boundFile.fileReal);
    if (loaderExists && !samePath(path.resolve(loaderDir), expectedLoaderDir)) {
      add(errors, "origin-capture-path-mismatch", "loader capture directory does not match the declared file realpath");
    }
    const priorCandidate = realPathOwners.get(boundFile.fileReal);
    if (priorCandidate !== undefined && priorCandidate !== candidateId) {
      add(
        errors,
        "origin-capture-path-duplicate",
        `capture.json realpath is already bound to candidate ${priorCandidate}`,
      );
    } else {
      realPathOwners.set(boundFile.fileReal, candidateId);
    }
    if (sha256Bytes(boundFile.bytes) !== captureRecordFields.get("fileSha256")) {
      add(errors, "origin-capture-file-hash-mismatch", "raw capture.json SHA-256 does not match the manifest");
    }
    if (!Buffer.from(boundFile.bytes.toString("utf8"), "utf8").equals(boundFile.bytes)) {
      throw new TypeError(`${capturePath} must contain valid UTF-8`);
    }
    const capture = parseProductionBindingJson(boundFile.bytes, capturePath);
    if (!isPlainRecord(capture)) throw new TypeError(`${capturePath} must contain a JSON object`);
    if (loaderExists && !isDeepStrictEqual(capture, loaderCapture)) {
      add(errors, "origin-capture-content-mismatch", "parsed capture.json does not match the evidence loader record");
    }

    const captureFields = readOwnDataFields(capture, capturePath);
    const sourceHashesField = captureFields.get("sourceHashes");
    if (sourceHashesField === undefined || sourceHashesField === null) {
      add(gaps, "origin-capture-source-hashes-missing", "capture.json sourceHashes is missing or null");
    } else {
      if (!isPlainRecord(sourceHashesField)) throw new TypeError(`${capturePath}.sourceHashes must be a JSON object`);
      assertOwnDataTree(sourceHashesField, `${capturePath}.sourceHashes`);
      if (sha256Canonical(sourceHashesField) !== captureRecordFields.get("sourceHashesHash")) {
        add(
          errors,
          "origin-capture-source-hashes-hash-mismatch",
          "canonical sourceHashes digest does not match the manifest",
        );
      }
    }
  }

  const candidateIdSet = new Set(candidateIds);
  for (const candidateId of [...capturesFields.keys()].filter((key) => !candidateIdSet.has(key)).sort()) {
    errors.push({
      code: "origin-loaded-capture-unexpected",
      candidateId,
      path: null,
      detail: "evidence loader contains a capture record absent from CandidateSet",
    });
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Read and preserve the separately scoped production source and historical review evidence. */
export async function readProductionHistoricalContext(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifestRunDir", "evidence"], "options");
  const manifestRunDir = optionFields.get("manifestRunDir");
  const evidence = optionFields.get("evidence");
  assertOwnDataTree(evidence, "evidence");
  const evidenceFields = readOwnDataFields(evidence, "evidence");
  const candidateSetFields = readOwnDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet");
  const candidateSet = candidateSetFields.get("data");

  const manifestRecord = await readProductionSourceManifest({ runDir: manifestRunDir, candidateSet });
  const precheckFileSha256 = manifestRecord.manifest.preMigration.precheck.fileSha256;
  const preMigrationSources = await readProductionSourceSnapshot({ runDir: manifestRunDir, precheckFileSha256 });
  const preMigrationAssets = await readProductionPreMigrationAssets({ runDir: manifestRunDir, precheckFileSha256 });
  const metadataResult = await verifyProductionOriginMetadata({ manifestRecord, evidence });
  const capturesResult = await verifyProductionOriginCaptures({ manifestRecord, evidence });
  const { verifyProductionHistoricalEvidence } = await import("./production-source-origins.mjs");
  const historicalEvidence = await verifyProductionHistoricalEvidence({
    evidence,
    beforeSourceHashes: preMigrationSources.sourceHashes,
    sourceSnapshot: preMigrationSources.sourceSnapshot,
  });

  return {
    manifestRecord,
    preMigrationSources,
    preMigrationAssets,
    metadataResult,
    capturesResult,
    historicalEvidence,
  };
}

/** Join a clean historical selection to independently measured current sources and generated assets. */
export async function readProductionCurrentContext(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["historicalContext", "evidence"], "options");
  const evidenceInput = optionFields.get("evidence");
  assertOwnDataTree(evidenceInput, "evidence");
  const evidence = structuredClone(evidenceInput);

  const contextFields = readExactOwnDataFields(
    optionFields.get("historicalContext"),
    [
      "manifestRecord",
      "preMigrationSources",
      "preMigrationAssets",
      "metadataResult",
      "capturesResult",
      "historicalEvidence",
    ],
    "historicalContext",
  );
  const copyJson = (value, label) => {
    assertOwnDataTree(value, label);
    return structuredClone(value);
  };
  const manifestRecord = copyJson(contextFields.get("manifestRecord"), "historicalContext.manifestRecord");
  const sourceFields = readExactOwnDataFields(
    contextFields.get("preMigrationSources"),
    ["precheckPath", "precheckFileSha256", "sourceHashes", "sourceSnapshot"],
    "historicalContext.preMigrationSources",
  );
  const precheckPath = copyJson(sourceFields.get("precheckPath"), "historicalContext.preMigrationSources.precheckPath");
  const precheckFileSha256 = copyJson(
    sourceFields.get("precheckFileSha256"),
    "historicalContext.preMigrationSources.precheckFileSha256",
  );
  const sourceHashesInput = sourceFields.get("sourceHashes");
  assertOwnDataTree(sourceHashesInput, "historicalContext.preMigrationSources.sourceHashes");
  const sourceHashFields = readExactOwnDataFields(
    sourceHashesInput,
    SOURCE_FILES,
    "historicalContext.preMigrationSources.sourceHashes",
  );
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, sourceHashFields.get(file)]));
  const sourceSnapshotFields = readExactOwnDataFields(
    sourceFields.get("sourceSnapshot"),
    SOURCE_PREIMAGE_FILES,
    "historicalContext.preMigrationSources.sourceSnapshot",
  );
  const sourceSnapshot = Object.fromEntries(
    SOURCE_PREIMAGE_FILES.map((file) => {
      const bytes = sourceSnapshotFields.get(file);
      if (!Buffer.isBuffer(bytes)) {
        throw new TypeError(`historicalContext.preMigrationSources.sourceSnapshot[${file}] must be a Buffer`);
      }
      return [file, Buffer.from(bytes)];
    }),
  );
  const copyCleanResult = (name) => {
    const value = contextFields.get(name);
    const fields = readExactOwnDataFields(value, ["status", "errors", "gaps"], `historicalContext.${name}`);
    if (fields.get("status") !== "pass" || !Array.isArray(fields.get("errors")) || fields.get("errors").length) {
      throw new TypeError(`historicalContext.${name} must be a clean pass`);
    }
    if (!Array.isArray(fields.get("gaps")) || fields.get("gaps").length) {
      throw new TypeError(`historicalContext.${name} must be a clean pass`);
    }
    return copyJson(value, `historicalContext.${name}`);
  };
  const historicalContext = {
    manifestRecord,
    preMigrationSources: { precheckPath, precheckFileSha256, sourceHashes, sourceSnapshot },
    preMigrationAssets: copyJson(contextFields.get("preMigrationAssets"), "historicalContext.preMigrationAssets"),
    metadataResult: copyCleanResult("metadataResult"),
    capturesResult: copyCleanResult("capturesResult"),
    historicalEvidence: copyJson(contextFields.get("historicalEvidence"), "historicalContext.historicalEvidence"),
  };

  const { resolveProductionHistoricalSelection } = await import("./production-source-origins.mjs");
  const evidenceFields = readOwnDataFields(evidence, "evidence");
  const selectionFields = readOwnDataFields(evidenceFields.get("selections"), "evidence.selections");
  const recordFields = readOwnDataFields(selectionFields.get("record"), "evidence.selections.record");
  const choicesFields = readOwnDataFields(recordFields.get("choices"), "evidence.selections.record.choices");
  const selectedCandidates = SKIN_IDS.map((skinId) => {
    const choice = choicesFields.get(skinId);
    const choiceFields =
      choice === undefined ? new Map() : readOwnDataFields(choice, `evidence.selections.record.choices.${skinId}`);
    const selection = resolveProductionHistoricalSelection({
      evidence,
      historicalEvidence: historicalContext.historicalEvidence,
      candidateId: choiceFields.get("candidateId"),
    });
    return { candidate: selection.candidate, selectionBinding: selection.selectionBinding };
  });

  const currentSources = await readProductionCurrentSources();
  const currentAssets = await readProductionGeneratedAssets();
  const { verifyProductionAssetTransition, verifyProductionDeclaredSourceTransition } = await import(
    "./production-source-manifest.mjs"
  );
  const historicalFields = readOwnDataFields(
    historicalContext.historicalEvidence,
    "historicalContext.historicalEvidence",
  );
  const historicalResultFields = readOwnDataFields(
    historicalFields.get("historicalResult"),
    "historicalContext.historicalEvidence.historicalResult",
  );
  const verifiedModel = historicalResultFields.get("verifiedModel");
  const selectionRecord = selectionFields.get("record");
  const candidateSetFields = readOwnDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet");
  const candidateSet = candidateSetFields.get("data");
  const sourceTransition = verifyProductionDeclaredSourceTransition({
    manifestRecord: historicalContext.manifestRecord,
    preMigrationSources: historicalContext.preMigrationSources,
    currentSources,
    verifiedModel,
    selections: selectionRecord,
  });
  const assetTransition = verifyProductionAssetTransition({
    manifestRecord: historicalContext.manifestRecord,
    preMigrationAssets: historicalContext.preMigrationAssets,
    currentAssets,
    candidateSet,
  });

  return { selectedCandidates, currentSources, currentAssets, sourceTransition, assetTransition };
}

/** Re-read the saved origin and before evidence without using a new manifest to authorize old captures. */
export async function verifyProductionOriginStability(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifestRunDir", "evidence", "historicalContext"], "options");
  const copyJson = (value, label) => {
    assertOwnDataTree(value, label);
    return structuredClone(value);
  };
  const manifestRunDir = copyJson(optionFields.get("manifestRunDir"), "options.manifestRunDir");
  const evidence = copyJson(optionFields.get("evidence"), "evidence");
  const contextFields = readExactOwnDataFields(
    optionFields.get("historicalContext"),
    [
      "manifestRecord",
      "preMigrationSources",
      "preMigrationAssets",
      "metadataResult",
      "capturesResult",
      "historicalEvidence",
    ],
    "historicalContext",
  );
  const manifestRecord = copyJson(contextFields.get("manifestRecord"), "historicalContext.manifestRecord");
  const manifestRecordFields = readExactOwnDataFields(
    manifestRecord,
    ["manifestPath", "manifestFileSha256", "manifest"],
    "historicalContext.manifestRecord",
  );
  const preMigrationSourceFields = readExactOwnDataFields(
    contextFields.get("preMigrationSources"),
    ["precheckPath", "precheckFileSha256", "sourceHashes", "sourceSnapshot"],
    "historicalContext.preMigrationSources",
  );
  const sourceHashesInput = preMigrationSourceFields.get("sourceHashes");
  assertOwnDataTree(sourceHashesInput, "historicalContext.preMigrationSources.sourceHashes");
  const sourceHashFields = readExactOwnDataFields(
    sourceHashesInput,
    SOURCE_FILES,
    "historicalContext.preMigrationSources.sourceHashes",
  );
  const sourceSnapshotFields = readExactOwnDataFields(
    preMigrationSourceFields.get("sourceSnapshot"),
    SOURCE_PREIMAGE_FILES,
    "historicalContext.preMigrationSources.sourceSnapshot",
  );
  const preMigrationSources = {
    precheckPath: copyJson(
      preMigrationSourceFields.get("precheckPath"),
      "historicalContext.preMigrationSources.precheckPath",
    ),
    precheckFileSha256: copyJson(
      preMigrationSourceFields.get("precheckFileSha256"),
      "historicalContext.preMigrationSources.precheckFileSha256",
    ),
    sourceHashes: Object.fromEntries(SOURCE_FILES.map((file) => [file, sourceHashFields.get(file)])),
    sourceSnapshot: Object.fromEntries(
      SOURCE_PREIMAGE_FILES.map((file) => {
        const bytes = sourceSnapshotFields.get(file);
        if (!Buffer.isBuffer(bytes)) {
          throw new TypeError(`historicalContext.preMigrationSources.sourceSnapshot[${file}] must be a Buffer`);
        }
        return [file, Buffer.from(bytes)];
      }),
    ),
  };
  const preMigrationAssets = copyJson(contextFields.get("preMigrationAssets"), "historicalContext.preMigrationAssets");
  const evidenceFields = readOwnDataFields(evidence, "evidence");
  const candidateSet = readOwnDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet").get("data");
  const manifestFields = readOwnDataFields(
    manifestRecordFields.get("manifest"),
    "historicalContext.manifestRecord.manifest",
  );
  const manifestPrecheck = readOwnDataFields(
    readOwnDataFields(manifestFields.get("preMigration"), "historicalContext.manifestRecord.manifest.preMigration").get(
      "precheck",
    ),
    "historicalContext.manifestRecord.manifest.preMigration.precheck",
  );
  const precheckFileSha256 = manifestPrecheck.get("fileSha256");
  const manifestPath = manifestRecordFields.get("manifestPath");
  const manifestFileSha256 = manifestRecordFields.get("manifestFileSha256");
  const sourcePrecheckPath = preMigrationSources.precheckPath;
  const rereadManifest = await readProductionSourceManifest({ runDir: manifestRunDir, candidateSet });
  const errors = [];
  const gaps = [];
  if (rereadManifest.manifestPath !== manifestPath) {
    errors.push({
      code: "origin-manifest-path-changed",
      path: manifestPath,
      detail: "re-read manifest path does not match the saved D9b manifest record",
    });
  }
  if (rereadManifest.manifestFileSha256 !== manifestFileSha256) {
    errors.push({
      code: "origin-manifest-file-changed",
      path: manifestPath,
      detail: "re-read manifest raw byte SHA-256 does not match the saved D9b manifest record",
    });
  }

  const currentPreMigrationSources = await readProductionSourceSnapshot({
    runDir: manifestRunDir,
    precheckFileSha256,
  });
  if (!isDeepStrictEqual(currentPreMigrationSources, preMigrationSources)) {
    errors.push({
      code: "origin-pre-migration-sources-changed",
      path: sourcePrecheckPath,
      detail: "re-read source precheck and preimages do not match the saved D9b source record",
    });
  }
  const currentPreMigrationAssets = await readProductionPreMigrationAssets({
    runDir: manifestRunDir,
    precheckFileSha256,
  });
  if (!isDeepStrictEqual(currentPreMigrationAssets, preMigrationAssets)) {
    errors.push({
      code: "origin-pre-migration-assets-changed",
      path: sourcePrecheckPath,
      detail: "re-read asset precheck does not match the saved D9b asset record",
    });
  }

  const metadataResult = await verifyProductionOriginMetadata({ manifestRecord, evidence });
  const capturesResult = await verifyProductionOriginCaptures({ manifestRecord, evidence });
  errors.push(...metadataResult.errors, ...capturesResult.errors);
  gaps.push(...metadataResult.gaps, ...capturesResult.gaps);

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Compare D9c's current-file sample with a fresh read from the default repository root. */
export async function verifyProductionCurrentStability(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["currentSources", "currentAssets"], "options");
  const sourceFields = readExactOwnDataFields(
    optionFields.get("currentSources"),
    ["rootDir", "sourceBytes", "sourceHashes"],
    "currentSources",
  );
  const assetFields = readExactOwnDataFields(
    optionFields.get("currentAssets"),
    ["rootDir", "assetManifestBytes", "assetManifestSha256", "sourceAssetHashes", "publicAssetHashes", "toolHashes"],
    "currentAssets",
  );
  const assertReadRoot = (value, label) => {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.includes("\0") ||
      isUrlLikePath(value) ||
      hasNonDriveUrlScheme(value) ||
      !path.isAbsolute(value)
    ) {
      throw new TypeError(`${label} must be a non-empty absolute filesystem path, not a URL`);
    }
    return value;
  };
  const sourceRoot = assertReadRoot(sourceFields.get("rootDir"), "currentSources.rootDir");
  const assetRoot = assertReadRoot(assetFields.get("rootDir"), "currentAssets.rootDir");
  const sourceBytesFields = readExactOwnDataFields(
    sourceFields.get("sourceBytes"),
    SOURCE_FILES,
    "currentSources.sourceBytes",
  );
  const declaredSourceHashes = copyProductionAssetHashMap(
    sourceFields.get("sourceHashes"),
    SOURCE_FILES,
    "currentSources.sourceHashes",
  );
  const startSourceHashes = {};
  const errors = [];
  for (const file of SOURCE_FILES) {
    const bytes = sourceBytesFields.get(file);
    if (!Buffer.isBuffer(bytes)) throw new TypeError(`currentSources.sourceBytes[${file}] must be a Buffer`);
    const digest = sha256Bytes(bytes);
    startSourceHashes[file] = digest;
    if (digest !== declaredSourceHashes[file]) {
      errors.push({
        code: "current-start-source-hash-mismatch",
        path: file,
        detail: "sourceBytes SHA-256 does not match the supplied sourceHashes entry",
      });
    }
  }

  const assetManifestBytes = assetFields.get("assetManifestBytes");
  if (!Buffer.isBuffer(assetManifestBytes)) throw new TypeError("currentAssets.assetManifestBytes must be a Buffer");
  const startAssetManifestHash = sha256Bytes(assetManifestBytes);
  const declaredAssetManifestHash = assetFields.get("assetManifestSha256");
  if (typeof declaredAssetManifestHash !== "string" || !SHA256_HEX.test(declaredAssetManifestHash)) {
    throw new TypeError("currentAssets.assetManifestSha256 must be a lowercase 64-character SHA-256");
  }
  if (startAssetManifestHash !== declaredAssetManifestHash) {
    errors.push({
      code: "current-start-asset-manifest-hash-mismatch",
      path: "public/skin-assets.json",
      detail: "assetManifestBytes SHA-256 does not match the supplied assetManifestSha256",
    });
  }

  const assets = enumerateSourceAssets();
  if (
    !Array.isArray(assets) ||
    assets.length !== 40 ||
    assets.some(
      (asset) => !isPlainRecord(asset) || typeof asset.sourcePath !== "string" || typeof asset.publicPath !== "string",
    )
  ) {
    throw new TypeError("enumerateSourceAssets must return exactly 40 sourcePath/publicPath records");
  }
  const sourcePaths = assets.map(({ sourcePath }) => sourcePath);
  const publicPaths = assets.map(({ publicPath }) => publicPath);
  if (new Set(sourcePaths).size !== 40 || new Set(publicPaths).size !== 40) {
    throw new TypeError("enumerateSourceAssets must return exactly 40 unique sourcePath/publicPath pairs");
  }
  const startSourceAssetHashes = copyProductionAssetHashMap(
    assetFields.get("sourceAssetHashes"),
    sourcePaths,
    "currentAssets.sourceAssetHashes",
  );
  const startPublicAssetHashes = copyProductionAssetHashMap(
    assetFields.get("publicAssetHashes"),
    publicPaths,
    "currentAssets.publicAssetHashes",
  );
  const startToolHashes = copyProductionAssetHashMap(
    assetFields.get("toolHashes"),
    GENERATED_ASSET_TOOL_FILES,
    "currentAssets.toolHashes",
  );

  const currentSources = await readProductionCurrentSources();
  const currentAssets = await readProductionGeneratedAssets();
  const gaps = [];
  if (currentSources.rootDir !== sourceRoot) {
    errors.push({
      code: "current-source-root-changed",
      path: sourceRoot,
      detail: "default end-read source root differs from the D9c start sample",
    });
  }
  if (currentAssets.rootDir !== assetRoot) {
    errors.push({
      code: "current-asset-root-changed",
      path: assetRoot,
      detail: "default end-read asset root differs from the D9c start sample",
    });
  }
  for (const file of SOURCE_FILES) {
    if (startSourceHashes[file] !== currentSources.sourceHashes[file]) {
      errors.push({
        code: "current-source-file-changed",
        path: file,
        detail: "source bytes differ between the D9c start sample and the default end read",
      });
    }
  }
  if (startAssetManifestHash !== currentAssets.assetManifestSha256) {
    errors.push({
      code: "current-asset-manifest-file-changed",
      path: "public/skin-assets.json",
      detail: "asset manifest bytes differ between the D9c start sample and the default end read",
    });
  }
  for (const asset of assets) {
    if (startSourceAssetHashes[asset.sourcePath] !== currentAssets.sourceAssetHashes[asset.sourcePath]) {
      errors.push({
        code: "current-source-asset-file-changed",
        path: asset.sourcePath,
        detail: "source asset digest differs between the D9c start sample and the default end read",
      });
    }
    if (startPublicAssetHashes[asset.publicPath] !== currentAssets.publicAssetHashes[asset.publicPath]) {
      errors.push({
        code: "current-public-asset-file-changed",
        path: asset.publicPath,
        detail: "public asset digest differs between the D9c start sample and the default end read",
      });
    }
  }
  for (const file of GENERATED_ASSET_TOOL_FILES) {
    if (startToolHashes[file] !== currentAssets.toolHashes[file]) {
      errors.push({
        code: "current-production-tool-file-changed",
        path: file,
        detail: "production tool digest differs between the D9c start sample and the default end read",
      });
    }
  }

  return { status: errors.length > 0 ? "rejected" : "pass", errors, gaps };
}

/** Build the historical source context, gate current selection, then recheck both sides. */
export async function verifyProductionSourceContext(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifestRunDir", "evidence"], "options");
  const copyJson = (value, label) => {
    assertOwnDataTree(value, label);
    return structuredClone(value);
  };
  const manifestRunDir = copyJson(optionFields.get("manifestRunDir"), "options.manifestRunDir");
  const evidence = copyJson(optionFields.get("evidence"), "evidence");
  const historicalContext = await readProductionHistoricalContext({ manifestRunDir, evidence });
  const errors = [];
  const gaps = [];

  const diagnostics = (value, label) => {
    const fields = readOwnDataFields(value, label);
    if (!["status", "errors", "gaps"].every((key) => fields.has(key))) {
      throw new TypeError(`${label} must contain status, errors, and gaps`);
    }
    const status = fields.get("status");
    const resultErrors = fields.get("errors");
    const resultGaps = fields.get("gaps");
    if (!Array.isArray(resultErrors) || !Array.isArray(resultGaps)) {
      throw new TypeError(`${label} must contain error and gap arrays`);
    }
    if (
      (status === "pass" && (resultErrors.length > 0 || resultGaps.length > 0)) ||
      (status === "incomplete" && (resultErrors.length > 0 || resultGaps.length === 0)) ||
      (status === "rejected" && resultErrors.length === 0) ||
      !["pass", "incomplete", "rejected"].includes(status)
    ) {
      throw new TypeError(`${label} status does not match its diagnostics`);
    }
    return { status, errors: resultErrors, gaps: resultGaps };
  };
  const append = (result) => {
    errors.push(...result.errors);
    gaps.push(...result.gaps);
  };

  const historicalFields = readExactOwnDataFields(
    historicalContext,
    [
      "manifestRecord",
      "preMigrationSources",
      "preMigrationAssets",
      "metadataResult",
      "capturesResult",
      "historicalEvidence",
    ],
    "historicalContext",
  );
  const manifestRecordFields = readExactOwnDataFields(
    historicalFields.get("manifestRecord"),
    ["manifestPath", "manifestFileSha256", "manifest"],
    "historicalContext.manifestRecord",
  );
  const manifestFields = readOwnDataFields(
    manifestRecordFields.get("manifest"),
    "historicalContext.manifestRecord.manifest",
  );
  const originFields = readOwnDataFields(
    manifestFields.get("origin"),
    "historicalContext.manifestRecord.manifest.origin",
  );
  const originRun = originFields.get("runDir");
  if (typeof originRun !== "string") throw new TypeError("historical manifest origin.runDir must be a string");
  const assessmentPath = path.posix.join(originRun, "assessments.json");

  const metadataResult = diagnostics(historicalFields.get("metadataResult"), "historicalContext.metadataResult");
  append(metadataResult);
  const capturesResult = diagnostics(historicalFields.get("capturesResult"), "historicalContext.capturesResult");
  append(capturesResult);

  const historicalEvidenceFields = readExactOwnDataFields(
    historicalFields.get("historicalEvidence"),
    ["originResult", "historicalResult", "assessmentBinding"],
    "historicalContext.historicalEvidence",
  );
  const originResult = diagnostics(historicalEvidenceFields.get("originResult"), "historicalEvidence.originResult");
  append(originResult);

  const historicalResultFields = readOwnDataFields(
    historicalEvidenceFields.get("historicalResult"),
    "historicalEvidence.historicalResult",
  );
  const historicalStatus = historicalResultFields.get("status");
  const historicalErrors = historicalResultFields.get("errors");
  const historicalGaps = historicalResultFields.get("gaps");
  if (
    !["pass", "incomplete", "rejected", "invalid"].includes(historicalStatus) ||
    !Array.isArray(historicalErrors) ||
    !Array.isArray(historicalGaps)
  ) {
    throw new TypeError("historicalEvidence.historicalResult has an invalid status or diagnostics");
  }
  // Historical readiness/gaps may concern unselected candidates; D5c/B1 alone decides the selected ten.
  errors.push(...historicalErrors);

  const assessmentBindingFields = readExactOwnDataFields(
    historicalEvidenceFields.get("assessmentBinding"),
    ["status", "recordedHash", "reconstructedHash"],
    "historicalEvidence.assessmentBinding",
  );
  const assessmentBindingStatus = assessmentBindingFields.get("status");
  if (assessmentBindingStatus === "rejected") {
    errors.push({
      code: "production-original-assessment-binding-mismatch",
      path: assessmentPath,
      detail: "recorded and reconstructed original assessment hashes do not match",
    });
  } else if (assessmentBindingStatus === "incomplete") {
    gaps.push({
      code: "production-original-assessment-binding-missing",
      path: assessmentPath,
      detail: "the original assessment hash could not be bound to the reconstructed historical result",
    });
  } else if (assessmentBindingStatus !== "pass") {
    throw new TypeError("historicalEvidence.assessmentBinding has an invalid status");
  }

  const verifiedModel = historicalResultFields.get("verifiedModel");
  if (verifiedModel === null || verifiedModel === undefined) {
    gaps.push({
      code: "production-historical-model-missing",
      path: assessmentPath,
      detail: "no verified historical model was produced from the original assessment",
    });
  }
  if (historicalResultFields.get("sourceContext") !== "historical" || historicalStatus === "invalid") {
    errors.push({
      code: "production-historical-context-invalid",
      path: assessmentPath,
      detail: "the historical verifier did not produce a valid historical-context result",
    });
  }

  let currentContext = null;
  let currentContextFields = null;
  let currentStability = null;
  let sourceTransitionResult = null;
  let assetTransitionResult = null;
  if (errors.length === 0 && gaps.length === 0) {
    currentContext = await readProductionCurrentContext({ historicalContext, evidence });
    currentContextFields = readExactOwnDataFields(
      currentContext,
      ["selectedCandidates", "currentSources", "currentAssets", "sourceTransition", "assetTransition"],
      "currentContext",
    );
    sourceTransitionResult = diagnostics(
      currentContextFields.get("sourceTransition"),
      "currentContext.sourceTransition",
    );
    append(sourceTransitionResult);
    assetTransitionResult = diagnostics(currentContextFields.get("assetTransition"), "currentContext.assetTransition");
    append(assetTransitionResult);
  }

  const originStability = await verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
  const originStabilityResult = diagnostics(originStability, "originStability");
  append(originStabilityResult);
  let currentStabilityResult = null;
  if (currentContext !== null) {
    currentStability = await verifyProductionCurrentStability({
      currentSources: currentContextFields.get("currentSources"),
      currentAssets: currentContextFields.get("currentAssets"),
    });
    currentStabilityResult = diagnostics(currentStability, "currentStability");
    append(currentStabilityResult);
  }

  const status = errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass";
  if (
    status === "pass" &&
    (currentContext === null ||
      currentStability === null ||
      [sourceTransitionResult, assetTransitionResult, originStabilityResult, currentStabilityResult].some(
        (result) => result?.status !== "pass",
      ))
  ) {
    throw new TypeError("source context cannot pass without clean current transitions and both end checks");
  }

  return { status, errors, gaps, historicalContext, currentContext, originStability, currentStability };
}

/** Gate formal production captures on clean historical/current source evidence, then recheck both ends. */
export async function verifyProductionReviewEvidence(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifestRunDir", "evidence", "capturesIndexPath"], "options");
  const copyJson = (value, label) => {
    assertOwnDataTree(value, label);
    return structuredClone(value);
  };
  const manifestRunDir = copyJson(optionFields.get("manifestRunDir"), "options.manifestRunDir");
  const evidence = copyJson(optionFields.get("evidence"), "evidence");
  const capturesIndexPath = optionFields.get("capturesIndexPath");
  if (
    typeof capturesIndexPath !== "string" ||
    capturesIndexPath.trim() === "" ||
    capturesIndexPath.includes("\0") ||
    isUrlLikePath(capturesIndexPath) ||
    hasNonDriveUrlScheme(capturesIndexPath)
  ) {
    throw new TypeError("capturesIndexPath must be a non-empty filesystem path, not a URL");
  }
  const resolvedIndexPath = path.resolve(REPO_ROOT, capturesIndexPath);
  const validationRoot = path.resolve(REPO_ROOT, "docs", "validation");
  if (!isStrictPathChild(validationRoot, resolvedIndexPath)) {
    throw new TypeError("capturesIndexPath must be a strict child of docs/validation");
  }

  const diagnostics = (value, label) => {
    const fields = readOwnDataFields(value, label);
    if (!["status", "errors", "gaps"].every((key) => fields.has(key))) {
      throw new TypeError(`${label} must contain status, errors, and gaps`);
    }
    const status = fields.get("status");
    const errors = fields.get("errors");
    const gaps = fields.get("gaps");
    if (!Array.isArray(errors) || !Array.isArray(gaps)) {
      throw new TypeError(`${label} must contain error and gap arrays`);
    }
    if (
      !["pass", "incomplete", "rejected"].includes(status) ||
      (status === "pass" && (errors.length > 0 || gaps.length > 0)) ||
      (status === "incomplete" && (errors.length > 0 || gaps.length === 0)) ||
      (status === "rejected" && errors.length === 0)
    ) {
      throw new TypeError(`${label} status does not match its diagnostics`);
    }
    return { status, errors, gaps };
  };

  const sourceResult = await verifyProductionSourceContext({ manifestRunDir, evidence });
  const sourceDiagnostics = diagnostics(sourceResult, "sourceResult");
  if (sourceDiagnostics.status !== "pass") {
    return {
      status: sourceDiagnostics.status,
      exitCode: 2,
      errors: [...sourceDiagnostics.errors],
      gaps: [...sourceDiagnostics.gaps],
      sourceResult,
      productionResult: null,
      postOriginStability: null,
      postCurrentStability: null,
    };
  }

  const sourceFields = readExactOwnDataFields(
    sourceResult,
    ["status", "errors", "gaps", "historicalContext", "currentContext", "originStability", "currentStability"],
    "sourceResult",
  );
  const historicalFields = readExactOwnDataFields(
    sourceFields.get("historicalContext"),
    [
      "manifestRecord",
      "preMigrationSources",
      "preMigrationAssets",
      "metadataResult",
      "capturesResult",
      "historicalEvidence",
    ],
    "sourceResult.historicalContext",
  );
  const manifestRecordFields = readOwnDataFields(
    historicalFields.get("manifestRecord"),
    "historicalContext.manifestRecord",
  );
  const manifestFields = readOwnDataFields(
    manifestRecordFields.get("manifest"),
    "historicalContext.manifestRecord.manifest",
  );
  const originFields = readOwnDataFields(
    manifestFields.get("origin"),
    "historicalContext.manifestRecord.manifest.origin",
  );
  const runDir = originFields.get("runDir");
  const historicalEvidenceFields = readExactOwnDataFields(
    historicalFields.get("historicalEvidence"),
    ["originResult", "historicalResult", "assessmentBinding"],
    "sourceResult.historicalContext.historicalEvidence",
  );
  const historicalResultFields = readOwnDataFields(
    historicalEvidenceFields.get("historicalResult"),
    "sourceResult.historicalContext.historicalEvidence.historicalResult",
  );
  const verifiedModel = historicalResultFields.get("verifiedModel");
  const modelFields = readOwnDataFields(verifiedModel, "historicalResult.verifiedModel");
  if (
    typeof runDir !== "string" ||
    historicalResultFields.get("sourceContext") !== "historical" ||
    !isPlainRecord(verifiedModel) ||
    modelFields.get("production") !== false
  ) {
    throw new TypeError("sourceResult must contain a verified historical model and origin runDir");
  }
  const currentFields = readExactOwnDataFields(
    sourceFields.get("currentContext"),
    ["selectedCandidates", "currentSources", "currentAssets", "sourceTransition", "assetTransition"],
    "sourceResult.currentContext",
  );
  readExactOwnDataFields(
    currentFields.get("currentSources"),
    ["rootDir", "sourceBytes", "sourceHashes"],
    "sourceResult.currentContext.currentSources",
  );
  readExactOwnDataFields(
    currentFields.get("currentAssets"),
    ["rootDir", "assetManifestBytes", "assetManifestSha256", "sourceAssetHashes", "publicAssetHashes", "toolHashes"],
    "sourceResult.currentContext.currentAssets",
  );
  for (const [key, label] of [
    ["originStability", "sourceResult.originStability"],
    ["currentStability", "sourceResult.currentStability"],
  ]) {
    const result = diagnostics(sourceFields.get(key), label);
    if (result.status !== "pass") throw new TypeError(`${label} must be a clean pass after sourceResult passes`);
  }
  const evidenceFields = readOwnDataFields(evidence, "evidence");
  const selectionFields = readOwnDataFields(evidenceFields.get("selections"), "evidence.selections");
  const selections = selectionFields.get("record");

  const productionResult = await verifyProductionCaptureIndex({
    runDir,
    capturesIndexPath,
    verifiedModel,
    selections,
  });
  const productionDiagnostics = diagnostics(productionResult, "productionResult");
  const productionFields = readOwnDataFields(productionResult, "productionResult");
  if (productionFields.get("exitCode") !== (productionDiagnostics.status === "pass" ? 0 : 2)) {
    throw new TypeError("productionResult.exitCode does not match its status");
  }

  const postOriginStability = await verifyProductionOriginStability({
    manifestRunDir,
    evidence,
    historicalContext: sourceFields.get("historicalContext"),
  });
  const postOriginDiagnostics = diagnostics(postOriginStability, "postOriginStability");
  const postCurrentStability = await verifyProductionCurrentStability({
    currentSources: currentFields.get("currentSources"),
    currentAssets: currentFields.get("currentAssets"),
  });
  const postCurrentDiagnostics = diagnostics(postCurrentStability, "postCurrentStability");

  const errors = [
    ...sourceDiagnostics.errors,
    ...productionDiagnostics.errors,
    ...postOriginDiagnostics.errors,
    ...postCurrentDiagnostics.errors,
  ];
  const gaps = [
    ...sourceDiagnostics.gaps,
    ...productionDiagnostics.gaps,
    ...postOriginDiagnostics.gaps,
    ...postCurrentDiagnostics.gaps,
  ];
  const status = errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass";
  return {
    status,
    exitCode: status === "pass" ? 0 : 2,
    errors,
    gaps,
    sourceResult,
    productionResult,
    postOriginStability,
    postCurrentStability,
  };
}

function copyProductionAssetHashMap(value, expectedPaths, label) {
  const fields = readExactOwnDataFields(value, expectedPaths, label);
  const copy = {};
  for (const file of expectedPaths) {
    const digest = fields.get(file);
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new TypeError(`${label}[${file}] must be a lowercase 64-character SHA-256`);
    }
    copy[file] = digest;
  }
  return copy;
}

/** Read the raw-hash-bound precheck's fixed old asset declarations without reading any referenced asset. */
export async function readProductionPreMigrationAssets(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["runDir", "precheckFileSha256"], "options");
  const runDir = optionFields.get("runDir");
  const precheckFileSha256 = optionFields.get("precheckFileSha256");
  if (typeof precheckFileSha256 !== "string" || !SHA256_HEX.test(precheckFileSha256)) {
    throw new TypeError("precheckFileSha256 must be an explicit 64-character lowercase SHA-256");
  }

  const { runReal, originRun } = await resolveProductionRunDirectory(runDir);
  const precheckLabel = "integration-precheck.json";
  const precheckBytes = await readProductionBindingBytes({
    parentReal: runReal,
    filePath: path.join(runReal, precheckLabel),
    label: precheckLabel,
  });
  if (sha256Bytes(precheckBytes) !== precheckFileSha256) {
    throw new TypeError("integration-precheck.json raw byte SHA-256 does not match precheckFileSha256");
  }

  const precheck = parseProductionBindingJson(precheckBytes, precheckLabel);
  if (!isPlainRecord(precheck)) throw new TypeError("integration-precheck.json must contain an object");
  const precheckFields = readOwnDataFields(precheck, precheckLabel);
  const generatedAssetFields = readExactOwnDataFields(
    precheckFields.get("generatedAssets"),
    ["assetManifestSha256", "sourceAssetHashes", "publicAssetHashes"],
    `${precheckLabel}.generatedAssets`,
  );
  const assetManifestSha256 = generatedAssetFields.get("assetManifestSha256");
  if (typeof assetManifestSha256 !== "string" || !SHA256_HEX.test(assetManifestSha256)) {
    throw new TypeError(
      `${precheckLabel}.generatedAssets.assetManifestSha256 must be a lowercase 64-character SHA-256`,
    );
  }

  const assets = enumerateSourceAssets();
  if (
    !Array.isArray(assets) ||
    assets.length !== 40 ||
    assets.some(
      (asset) => !isPlainRecord(asset) || typeof asset.sourcePath !== "string" || typeof asset.publicPath !== "string",
    )
  ) {
    throw new TypeError("enumerateSourceAssets must return exactly 40 sourcePath/publicPath records");
  }
  const sourcePaths = assets.map(({ sourcePath }) => sourcePath);
  const publicPaths = assets.map(({ publicPath }) => publicPath);
  if (new Set(sourcePaths).size !== 40 || new Set(publicPaths).size !== 40) {
    throw new TypeError("enumerateSourceAssets sourcePath and publicPath values must each be unique");
  }
  const generatedAssets = {
    assetManifestSha256,
    sourceAssetHashes: copyProductionAssetHashMap(
      generatedAssetFields.get("sourceAssetHashes"),
      sourcePaths,
      `${precheckLabel}.generatedAssets.sourceAssetHashes`,
    ),
    publicAssetHashes: copyProductionAssetHashMap(
      generatedAssetFields.get("publicAssetHashes"),
      publicPaths,
      `${precheckLabel}.generatedAssets.publicAssetHashes`,
    ),
  };

  return {
    precheckPath: path.posix.join(originRun, precheckLabel),
    precheckFileSha256,
    generatedAssets,
  };
}

/** Read every fixed current source once and hash the same returned bytes. */
export async function readProductionCurrentSources(options = {}) {
  const rootReal = await resolveProductionReadRoot(options, "readProductionCurrentSources");

  const sourceBytes = {};
  const sourceHashes = {};
  for (const file of SOURCE_FILES) {
    const bytes = await readProductionBindingBytes({
      parentReal: rootReal,
      filePath: path.join(rootReal, ...file.split("/")),
      label: file,
    });
    sourceBytes[file] = bytes;
    sourceHashes[file] = sha256Bytes(bytes);
  }
  return { rootDir: rootReal, sourceBytes, sourceHashes };
}

/** Read fixed generated image/tool bytes and the raw asset manifest without interpreting them. */
export async function readProductionGeneratedAssets(options = {}) {
  const rootReal = await resolveProductionReadRoot(options, "readProductionGeneratedAssets");
  const assets = enumerateSourceAssets();
  if (
    !Array.isArray(assets) ||
    assets.length !== 40 ||
    assets.some(
      (asset) => !isPlainRecord(asset) || typeof asset.sourcePath !== "string" || typeof asset.publicPath !== "string",
    ) ||
    new Set(assets.map((asset) => asset.sourcePath)).size !== 40 ||
    new Set(assets.map((asset) => asset.publicPath)).size !== 40
  ) {
    throw new TypeError("enumerateSourceAssets must return exactly 40 unique sourcePath/publicPath pairs");
  }

  const readHash = async (file) =>
    sha256Bytes(
      await readProductionBindingBytes({
        parentReal: rootReal,
        filePath: path.join(rootReal, ...file.split("/")),
        label: file,
      }),
    );
  const sourceAssetHashes = {};
  const publicAssetHashes = {};
  for (const asset of assets) {
    sourceAssetHashes[asset.sourcePath] = await readHash(asset.sourcePath);
    publicAssetHashes[asset.publicPath] = await readHash(asset.publicPath);
  }

  const toolHashes = {};
  for (const file of GENERATED_ASSET_TOOL_FILES) toolHashes[file] = await readHash(file);
  const assetManifestPath = "public/skin-assets.json";
  const assetManifestBytes = await readProductionBindingBytes({
    parentReal: rootReal,
    filePath: path.join(rootReal, ...assetManifestPath.split("/")),
    label: assetManifestPath,
  });

  return {
    rootDir: rootReal,
    assetManifestBytes,
    assetManifestSha256: sha256Bytes(assetManifestBytes),
    sourceAssetHashes,
    publicAssetHashes,
    toolHashes,
  };
}

function readOwnDataFields(value, label) {
  try {
    if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain or null-prototype object`);
    const fields = new Map();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label}.${key} must be an own data property`);
      }
      fields.set(key, descriptor.value);
    }
    return fields;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} must be a plain object with own data properties`);
  }
}

function readExactOwnDataFields(value, expectedKeys, label) {
  const fields = readOwnDataFields(value, label);
  const expected = new Set(expectedKeys);
  if (fields.size !== expectedKeys.length || [...fields.keys()].some((key) => !expected.has(key))) {
    throw new TypeError(`${label} must contain exactly the registered keys`);
  }
  return fields;
}

function assertOwnDataTree(value, label, onPath = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must contain only JSON values`);
  if (onPath.has(value)) throw new TypeError(`${label} must not contain cycles`);
  onPath.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        !keys.includes("length") ||
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
        )
      ) {
        throw new TypeError(`${label} must be a dense JSON array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError(`${label}[${index}] must be an own data property`);
        }
        assertOwnDataTree(descriptor.value, `${label}[${index}]`, onPath);
      }
      return;
    }
    for (const [key, child] of readOwnDataFields(value, label)) {
      assertOwnDataTree(child, `${label}.${key}`, onPath);
    }
  } finally {
    onPath.delete(value);
  }
}

/** Compare a D6a fixed-asset snapshot with the manifest's registered declarations. */
export function verifyProductionGeneratedAssets(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["snapshot"], "options");
  const snapshotFields = readExactOwnDataFields(
    optionFields.get("snapshot"),
    ["rootDir", "assetManifestBytes", "assetManifestSha256", "sourceAssetHashes", "publicAssetHashes", "toolHashes"],
    "snapshot",
  );
  const rootDir = snapshotFields.get("rootDir");
  const assetManifestBytes = snapshotFields.get("assetManifestBytes");
  const assetManifestSha256 = snapshotFields.get("assetManifestSha256");
  if (typeof rootDir !== "string" || rootDir.trim() === "")
    throw new TypeError("snapshot.rootDir must be a non-empty string");
  if (!Buffer.isBuffer(assetManifestBytes)) throw new TypeError("snapshot.assetManifestBytes must be a Buffer");
  if (typeof assetManifestSha256 !== "string" || !SHA256_HEX.test(assetManifestSha256)) {
    throw new TypeError("snapshot.assetManifestSha256 must be a lowercase 64-character SHA-256");
  }

  const registeredAssets = enumerateSourceAssets();
  if (!Array.isArray(registeredAssets) || registeredAssets.length !== 40) {
    throw new TypeError("enumerateSourceAssets must return exactly 40 registered assets");
  }
  if (
    registeredAssets.some(
      (asset) =>
        !isPlainRecord(asset) ||
        typeof asset.skinId !== "string" ||
        typeof asset.mode !== "string" ||
        typeof asset.view !== "string" ||
        typeof asset.sourcePath !== "string" ||
        typeof asset.publicPath !== "string" ||
        typeof asset.expectedName !== "string" ||
        typeof asset.publicUrl !== "string",
    )
  ) {
    throw new TypeError("enumerateSourceAssets returned a malformed registered asset");
  }
  const sourcePaths = registeredAssets.map((asset) => asset.sourcePath);
  const publicPaths = registeredAssets.map((asset) => asset.publicPath);
  const publicUrls = registeredAssets.map((asset) => asset.publicUrl);
  if (new Set(sourcePaths).size !== 40 || new Set(publicPaths).size !== 40 || new Set(publicUrls).size !== 40) {
    throw new TypeError("enumerateSourceAssets must return exactly 40 unique registered asset paths and URLs");
  }

  const sourceHashFields = readExactOwnDataFields(
    snapshotFields.get("sourceAssetHashes"),
    sourcePaths,
    "snapshot.sourceAssetHashes",
  );
  const publicHashFields = readExactOwnDataFields(
    snapshotFields.get("publicAssetHashes"),
    publicPaths,
    "snapshot.publicAssetHashes",
  );
  const toolHashFields = readExactOwnDataFields(
    snapshotFields.get("toolHashes"),
    GENERATED_ASSET_TOOL_FILES,
    "snapshot.toolHashes",
  );
  for (const [label, fields] of [
    ["snapshot.sourceAssetHashes", sourceHashFields],
    ["snapshot.publicAssetHashes", publicHashFields],
    ["snapshot.toolHashes", toolHashFields],
  ]) {
    for (const [file, digest] of fields) {
      if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
        throw new TypeError(`${label}.${file} must be a lowercase 64-character SHA-256`);
      }
    }
  }

  const errors = [];
  const gaps = [];
  const addError = (code, path, detail) => errors.push({ code, path, detail });
  if (sha256Bytes(assetManifestBytes) !== assetManifestSha256) {
    addError(
      "asset-manifest-hash-mismatch",
      "public/skin-assets.json",
      "assetManifestSha256 must match the supplied manifest bytes",
    );
  }

  const manifestText = assetManifestBytes.toString("utf8");
  if (!Buffer.from(manifestText, "utf8").equals(assetManifestBytes)) {
    throw new TypeError("public/skin-assets.json must contain losslessly decodable UTF-8 bytes");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new TypeError(`public/skin-assets.json contains invalid JSON: ${error.message}`);
  }
  const manifestFields = readOwnDataFields(manifest, "public/skin-assets.json");
  if (!manifestFields.has("assets")) throw new TypeError("public/skin-assets.json.assets must be an object");
  const manifestAssetFields = readOwnDataFields(manifestFields.get("assets"), "public/skin-assets.json.assets");

  for (const [field, expected] of [
    ["generatedBy", "scripts/prepare-skin-assets.mjs"],
    ["encodingGeneratedBy", "docs/validation/2026-10-02-model-character-skins/generate-skin-webp.py"],
  ]) {
    if (!manifestFields.has(field) || manifestFields.get(field) !== expected) {
      addError("asset-generator-reference-mismatch", "public/skin-assets.json", `${field} must equal ${expected}`);
    }
  }

  const expectedUrls = new Set(publicUrls);
  for (const asset of registeredAssets) {
    const publicUrl = asset.publicUrl;
    if (!manifestAssetFields.has(publicUrl)) {
      gaps.push({
        code: "asset-record-missing",
        path: publicUrl,
        detail: "skin-assets.json has no record for this registered publicUrl",
      });
      continue;
    }
    const record = readOwnDataFields(manifestAssetFields.get(publicUrl), `skin-assets.json.assets[${publicUrl}]`);
    for (const field of ["skinId", "mode", "view", "sourcePath", "publicPath", "expectedName"]) {
      if (!record.has(field) || record.get(field) !== asset[field]) {
        addError("asset-record-field-mismatch", publicUrl, `${field} must match the registered asset`);
      }
    }
    for (const [field, expectedHash] of [
      ["sourceSha256", sourceHashFields.get(asset.sourcePath)],
      ["publicSha256", publicHashFields.get(asset.publicPath)],
    ]) {
      const actualHash = record.get(field);
      if (
        !record.has(field) ||
        typeof actualHash !== "string" ||
        !SHA256_HEX.test(actualHash) ||
        actualHash !== expectedHash
      ) {
        addError(
          "asset-record-hash-mismatch",
          publicUrl,
          `${field} must be a lowercase SHA-256 matching the fixed asset snapshot`,
        );
      }
    }
    for (const field of ["alphaMaxDelta", "rgbMaxDeltaVisible"]) {
      if (!record.has(field) || record.get(field) !== 0) {
        addError("asset-lossless-declaration-invalid", publicUrl, `${field} must be the number 0`);
      }
    }
  }
  for (const publicUrl of [...manifestAssetFields.keys()].filter((key) => !expectedUrls.has(key)).sort()) {
    addError("unknown-asset-record", publicUrl, "publicUrl is not present in enumerateSourceAssets");
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

function expectedProductionCaptureBinding({
  originRun,
  selectionBinding,
  selections,
  candidateFile,
  captureFile,
  progressFile,
}) {
  return {
    schemaVersion: 1,
    kind: "skin-palette-production-capture-binding",
    originRun,
    selectionBinding: structuredClone(selectionBinding),
    selectionHash: sha256Canonical(selections),
    candidateFileSha256: sha256Bytes(candidateFile.bytes),
    captureFileSha256: sha256Bytes(captureFile.bytes),
    progressFileSha256: sha256Bytes(progressFile.bytes),
  };
}

/** Compare all registered candidate tokens with the current production palette. */
export function compareProductionTokens({ candidate, productionPalettes = SKIN_PALETTES } = {}) {
  assertCandidate(candidate);
  assertProductionPalettes(productionPalettes);

  const differences = [];
  const skin = readOwn(productionPalettes, candidate.skinId);

  for (const mode of MODES) {
    const palette = readOwn(skin.value, mode);
    for (const token of PALETTE_TOKEN_KEYS) {
      const expected = candidate.modes[mode][token];
      const entry = palette.found ? readOwn(palette.value, token) : { found: false, value: null };
      const actual = entry.found && typeof entry.value === "string" ? entry.value : null;
      let code = null;

      if (!entry.found || entry.value === null || entry.value === undefined) {
        code = "missing-production-token";
      } else if (typeof entry.value === "string") {
        if (!entry.value.trim()) {
          code = "missing-production-token";
        } else {
          const expectedSrgb = decodeProductionColor(expected);
          const actualSrgb = decodeProductionColor(entry.value);
          if (!actualSrgb) code = "unsupported-production-color";
          else if (!sameColor(expectedSrgb, actualSrgb)) code = "production-token-mismatch";
        }
      } else {
        code = "unsupported-production-color";
      }

      if (code) differences.push({ mode, token, code, expected, actual });
    }
  }

  return { matches: differences.length === 0, differences };
}

/** Bind one requested, reviewed candidate to a complete and current production selection record. */
export function resolveProductionSelection({ verifiedModel, selections, candidateId } = {}) {
  if (typeof candidateId !== "string" || !candidateId) {
    throw new TypeError("candidateId 必须是非空字符串");
  }

  assertSelectionRecord(selections);
  assertValid(validateSelections(selections), "selections");
  if (!selections.decisionSource.trim()) {
    throw new TypeError("selections.decisionSource 去除空白后不能为空");
  }

  const candidateSet = verifiedModel?.candidateSet;
  // Final selections may retain one candidate per skin; createSelectionExport below enforces all ten choices.
  assertValid(validateCandidateSet(candidateSet, { expectedSkinIds: [] }), "verifiedModel.candidateSet");
  const container = verifiedModel?.container;
  if (selections.candidateSetHash !== candidateSet.candidateSetHash) {
    throw new TypeError("selections.candidateSetHash 与 verifiedModel.candidateSet 不一致");
  }
  if (selections.assessmentHash !== container?.assessmentHash) {
    throw new TypeError("selections.assessmentHash 与 verifiedModel.container 不一致");
  }

  const exported = createSelectionExport({
    verifiedModel,
    choices: selections.choices,
    decisionSource: selections.decisionSource,
    recordedAt: selections.recordedAt,
  });
  if (exported.fileName !== "selections.json") {
    throw new TypeError("selections 必须是完整十套正式记录，不能是 selection-draft.json");
  }

  const candidates = candidateSet.candidates.filter((candidate) => candidate.id === candidateId);
  if (candidates.length !== 1) {
    throw new TypeError(`candidateId ${candidateId} 在已核 candidateSet 中不存在或不唯一`);
  }
  const candidate = candidates[0];
  const choice = selections.choices[candidate.skinId];
  if (
    !Object.hasOwn(selections.choices, candidate.skinId) ||
    choice.candidateId !== candidate.id ||
    choice.candidateHash !== candidate.candidateHash
  ) {
    throw new TypeError(`candidateId ${candidateId} 未被 selections.choices.${candidate.skinId} 选中`);
  }

  return {
    candidate: structuredClone(candidate),
    selectionBinding: {
      skinId: candidate.skinId,
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      candidateSetHash: selections.candidateSetHash,
      assessmentHash: selections.assessmentHash,
      decisionSource: selections.decisionSource,
      recordedAt: selections.recordedAt,
    },
  };
}

/** Run a production-color matrix capture through the existing single-owner review-capture lifecycle. */
export async function runProductionCapture({
  runDir,
  verifiedModel,
  selections,
  candidateId,
  outDir,
  captureFn = captureStateMatrix,
  fixtureFactory = createPaletteFixture,
  timelineWarningFixtureFactory = createTimelineWarningFixture,
  resume = false,
  productionPalettes = SKIN_PALETTES,
} = {}) {
  for (const [label, value] of [
    ["runDir", runDir],
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
  if (productionPalettes !== SKIN_PALETTES && captureFn === captureStateMatrix) {
    throw new TypeError("custom productionPalettes requires an injected captureFn");
  }

  const { candidate, selectionBinding } = resolveProductionSelection({ verifiedModel, selections, candidateId });
  const comparison = compareProductionTokens({ candidate, productionPalettes });
  if (!comparison.matches) {
    const first = comparison.differences[0];
    throw new TypeError(
      `production token mismatch at ${first.mode}.${first.token}: ${first.code} (expected ${first.expected}, actual ${first.actual})`,
    );
  }

  const runCandidate = await loadPreviewCandidate({ runDir, candidateId });
  assertCandidateMatches(runCandidate, candidate, "runDir candidates.json");

  const result = await runReviewCapture({
    runDir,
    candidateId,
    outDir,
    fixtureFactory,
    timelineWarningFixtureFactory,
    resume,
    captureFn: async ({
      candidate: loadedCandidate,
      fixture,
      timelineWarningFixture,
      outDir: resolvedOutDir,
      modes,
      resume: resolvedResume,
    }) => {
      assertCandidateMatches(loadedCandidate, candidate, "capture lifecycle reload");
      return captureFn({
        candidate: null,
        skinId: selectionBinding.skinId,
        fixture,
        timelineWarningFixture,
        outDir: resolvedOutDir,
        modes,
        resume: resolvedResume,
      });
    },
  });

  if (result.candidateId !== candidate.id || result.candidateHash !== candidate.candidateHash) {
    throw new TypeError("capture lifecycle candidate id/hash does not match the verified selection");
  }
  assertProductionMatrixResult(result.captureResult, { skinId: selectionBinding.skinId, outDir });

  return {
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    selectionBinding: structuredClone(selectionBinding),
    captureResult: result.captureResult,
  };
}

/** Write the exclusive evidence binding for one completed production capture. */
export async function writeProductionCaptureBinding({
  runDir,
  verifiedModel,
  selections,
  candidateId,
  captureResult,
} = {}) {
  if (typeof runDir !== "string" || runDir.trim() === "" || isUrlLikePath(runDir)) {
    throw new TypeError("runDir must be a non-empty filesystem path, not a URL");
  }
  if (
    !isPlainRecord(captureResult) ||
    typeof captureResult.outDir !== "string" ||
    captureResult.outDir.trim() === "" ||
    isUrlLikePath(captureResult.outDir)
  ) {
    throw new TypeError("captureResult.outDir must be a non-empty filesystem path, not a URL");
  }

  const { candidate, selectionBinding } = resolveProductionSelection({ verifiedModel, selections, candidateId });
  assertProductionMatrixResult(captureResult, {
    skinId: selectionBinding.skinId,
    outDir: captureResult.outDir,
  });
  const { originRun, runReal, outReal } = await resolveProductionBindingDirectories(runDir, captureResult.outDir);

  const candidateFile = await readProductionBindingJson({
    parentReal: runReal,
    filePath: path.join(runReal, "candidates.json"),
    label: "candidates.json",
  });
  assertValid(
    validateCandidateSet(candidateFile.value, { expectedSkinIds: [] }),
    "runDir candidates.json candidate set",
  );
  if (candidateFile.value.candidateSetHash !== selectionBinding.candidateSetHash) {
    throw new TypeError("runDir candidates.json candidateSetHash does not match the original selection");
  }
  const candidates = candidateFile.value.candidates.filter((entry) => entry.id === candidateId);
  if (candidates.length !== 1) {
    throw new TypeError("runDir candidates.json requested candidate is missing or ambiguous");
  }
  assertCandidateMatches(candidates[0], candidate, "runDir candidates.json");

  const captureFile = await readProductionBindingJson({
    parentReal: outReal,
    filePath: path.join(outReal, "capture.json"),
    label: "capture.json",
  });
  const progressFile = await readProductionBindingJson({
    parentReal: outReal,
    filePath: path.join(outReal, "progress.json"),
    label: "progress.json",
  });
  if (!isDeepStrictEqual(captureFile.value, captureResult.capture)) {
    throw new TypeError("capture.json does not match captureResult.capture");
  }
  if (!isDeepStrictEqual(progressFile.value, captureResult.progress)) {
    throw new TypeError("progress.json does not match captureResult.progress");
  }

  const binding = expectedProductionCaptureBinding({
    originRun,
    selectionBinding,
    selections,
    candidateFile,
    captureFile,
    progressFile,
  });
  const bindingPath = path.join(outReal, "production-selection.json");
  const contents = `${JSON.stringify(binding, null, 2)}\n`;
  try {
    await writeFile(bindingPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readProductionBindingJson({
      parentReal: outReal,
      filePath: bindingPath,
      label: "production-selection.json",
    });
    if (!isDeepStrictEqual(existing.value, binding)) {
      throw new TypeError("existing production-selection.json has a different or unsupported binding");
    }
  }
  return { bindingPath, binding };
}

/** Read and verify an existing production capture binding without changing its evidence. */
export async function readProductionCaptureBinding({ runDir, outDir, verifiedModel, selections, candidateId } = {}) {
  const { candidate, selectionBinding } = resolveProductionSelection({ verifiedModel, selections, candidateId });
  const { originRun, runReal, outReal } = await resolveProductionBindingDirectories(runDir, outDir);

  const candidateFile = await readProductionBindingJson({
    parentReal: runReal,
    filePath: path.join(runReal, "candidates.json"),
    label: "candidates.json",
  });
  assertValid(
    validateCandidateSet(candidateFile.value, { expectedSkinIds: [] }),
    "runDir candidates.json candidate set",
  );
  if (candidateFile.value.candidateSetHash !== selectionBinding.candidateSetHash) {
    throw new TypeError("runDir candidates.json candidateSetHash does not match the original selection");
  }
  const candidates = candidateFile.value.candidates.filter((entry) => entry.id === candidateId);
  if (candidates.length !== 1) {
    throw new TypeError("runDir candidates.json requested candidate is missing or ambiguous");
  }
  assertCandidateMatches(candidates[0], candidate, "runDir candidates.json");

  const captureFile = await readProductionBindingJson({
    parentReal: outReal,
    filePath: path.join(outReal, "capture.json"),
    label: "capture.json",
  });
  const progressFile = await readProductionBindingJson({
    parentReal: outReal,
    filePath: path.join(outReal, "progress.json"),
    label: "progress.json",
  });
  const captureResult = {
    outDir: outReal,
    skinId: selectionBinding.skinId,
    modes: captureFile.value?.modes,
    capture: captureFile.value,
    progress: progressFile.value,
  };
  assertProductionMatrixResult(captureResult, { skinId: selectionBinding.skinId, outDir: outReal });

  const expectedBinding = expectedProductionCaptureBinding({
    originRun,
    selectionBinding,
    selections,
    candidateFile,
    captureFile,
    progressFile,
  });
  const bindingPath = path.join(outReal, "production-selection.json");
  const bindingFile = await readProductionBindingJson({
    parentReal: outReal,
    filePath: bindingPath,
    label: "production-selection.json",
  });
  if (!isDeepStrictEqual(bindingFile.value, expectedBinding)) {
    throw new TypeError("production-selection.json does not match the current selection and capture evidence");
  }

  return {
    bindingPath,
    binding: structuredClone(expectedBinding),
    captureResult: structuredClone(captureResult),
  };
}

/** Register one verified formal production capture under its selected skin ID. */
export async function writeProductionCaptureIndexShard({
  runDir,
  outDir,
  verifiedModel,
  selections,
  candidateId,
} = {}) {
  const input = { runDir, outDir, verifiedModel, selections, candidateId };
  const verified = await readProductionCaptureBinding(input);
  const { skinId } = verified.binding.selectionBinding;
  summarizeProductionCapture({ skinId, captureResult: verified.captureResult });

  const { runReal, outReal } = await resolveProductionBindingDirectories(runDir, outDir);
  if (path.resolve(verified.captureResult.outDir) !== path.resolve(outReal)) {
    throw new TypeError("verified capture output directory changed during index registration");
  }
  const relativePath = path.relative(runReal, outReal).split(path.sep).join("/");
  if (relativePath === "" || path.posix.isAbsolute(relativePath) || isUrlLikePath(relativePath)) {
    throw new TypeError("production capture index path must be a non-empty repository-relative path");
  }

  const index = { schemaVersion: 1, captures: { [skinId]: relativePath } };
  const shardPath = path.join(outReal, "production-index-shard.json");
  const contents = `${JSON.stringify(index, null, 2)}\n`;
  try {
    await writeFile(shardPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readProductionBindingJson({
      parentReal: outReal,
      filePath: shardPath,
      label: "production-index-shard.json",
    });
    if (!isDeepStrictEqual(existing.value, index)) {
      throw new TypeError("existing production-index-shard.json has a different or unsupported binding");
    }
  }
  return { shardPath, index };
}

function assertProductionCaptureIndex(index) {
  if (!isPlainRecord(index)) throw new TypeError("production captures index must be a plain object");
  const indexKeys = Reflect.ownKeys(index);
  if (
    indexKeys.length !== 2 ||
    indexKeys.some((key) => typeof key !== "string" || !["schemaVersion", "captures"].includes(key))
  ) {
    throw new TypeError("production captures index must contain exactly schemaVersion and captures");
  }
  if (index.schemaVersion !== 1) throw new TypeError("production captures index schemaVersion must be 1");
  if (!isPlainRecord(index.captures)) throw new TypeError("production captures index captures must be a plain object");

  for (const skinId of Reflect.ownKeys(index.captures)) {
    if (typeof skinId !== "string" || !SKIN_IDS.includes(skinId)) {
      throw new TypeError(`production captures index contains an unknown skin key: ${String(skinId)}`);
    }
    const relativePath = index.captures[skinId];
    const parts = typeof relativePath === "string" ? relativePath.split("/") : [];
    if (
      typeof relativePath !== "string" ||
      relativePath.trim() === "" ||
      relativePath.includes("\\") ||
      isUrlLikePath(relativePath) ||
      hasNonDriveUrlScheme(relativePath) ||
      /^[a-z]:/i.test(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      path.posix.isAbsolute(relativePath) ||
      parts.some((part) => part === "" || part === ".")
    ) {
      throw new TypeError(`production captures index path for ${skinId} must be a POSIX relative directory path`);
    }
  }
}

/** Read and bind one explicit formal production index without writing or judging capture status. */
export async function readProductionCaptureIndex({ runDir, capturesIndexPath, verifiedModel, selections } = {}) {
  const run = await resolveProductionRunDirectory(runDir);
  if (typeof capturesIndexPath !== "string" || capturesIndexPath.trim() === "") {
    throw new TypeError("capturesIndexPath must be a non-empty filesystem path");
  }
  if (isUrlLikePath(capturesIndexPath) || hasNonDriveUrlScheme(capturesIndexPath)) {
    throw new TypeError("capturesIndexPath must be a filesystem path, not a URL");
  }

  const resolvedIndexPath = path.resolve(REPO_ROOT, capturesIndexPath);
  if (!isStrictPathChild(run.resolvedRunDir, resolvedIndexPath)) {
    throw new TypeError("capturesIndexPath must be a strict child of runDir");
  }
  const indexRelativePath = path.relative(run.resolvedRunDir, resolvedIndexPath);
  const indexFilePath = path.resolve(run.runReal, indexRelativePath);
  const { value: index } = await readProductionBindingJson({
    parentReal: run.runReal,
    filePath: indexFilePath,
    label: "captures-index.json",
  });
  const indexPath = await realpath(indexFilePath);
  if (!isStrictPathChild(run.runReal, indexPath)) {
    throw new TypeError("capturesIndexPath realpath must be a strict child of runDir");
  }
  assertProductionCaptureIndex(index);

  const choices = readOwn(selections, "choices");
  const firstChoice = readOwn(choices.value, SKIN_IDS[0]);
  const firstCandidateId = readOwn(firstChoice.value, "candidateId");
  if (!firstCandidateId.found || typeof firstCandidateId.value !== "string" || !firstCandidateId.value) {
    throw new TypeError(`selections.choices.${SKIN_IDS[0]}.candidateId must be a non-empty string`);
  }
  const { selectionBinding } = resolveProductionSelection({
    verifiedModel,
    selections,
    candidateId: firstCandidateId.value,
  });

  const candidateFile = await readProductionBindingJson({
    parentReal: run.runReal,
    filePath: path.join(run.runReal, "candidates.json"),
    label: "candidates.json",
  });
  assertValid(
    validateCandidateSet(candidateFile.value, { expectedSkinIds: [] }),
    "runDir candidates.json candidate set",
  );
  if (candidateFile.value.candidateSetHash !== selectionBinding.candidateSetHash) {
    throw new TypeError("runDir candidates.json candidateSetHash does not match the original selection");
  }
  if (!isDeepStrictEqual(candidateFile.value, verifiedModel.candidateSet)) {
    throw new TypeError("runDir candidates.json content does not match verifiedModel.candidateSet");
  }

  const captures = {};
  const gaps = [];
  const seenCaptureDirectories = new Set();
  for (const skinId of SKIN_IDS) {
    if (!Object.hasOwn(index.captures, skinId)) {
      gaps.push({
        code: "missing-production-capture",
        skinId,
        detail: `production captures index has no capture directory for ${skinId}`,
      });
      continue;
    }

    const relativePath = index.captures[skinId];
    const capturePath = path.resolve(run.runReal, relativePath);
    if (!isStrictPathChild(run.validationRootReal, capturePath)) {
      throw new TypeError(`production capture path for ${skinId} must remain under docs/validation`);
    }
    const outReal = await realpath(capturePath);
    if (!isStrictPathChild(run.validationRootReal, outReal)) {
      throw new TypeError(`production capture realpath for ${skinId} must remain under docs/validation`);
    }
    if (!(await stat(outReal)).isDirectory()) {
      throw new TypeError(`production capture path for ${skinId} must be an existing directory`);
    }
    if (outReal === run.runReal) throw new TypeError(`production capture path for ${skinId} cannot equal runDir`);
    if (seenCaptureDirectories.has(outReal)) {
      throw new TypeError(`multiple production skins point to the same capture directory: ${skinId}`);
    }
    seenCaptureDirectories.add(outReal);

    const choice = readOwn(choices.value, skinId);
    const candidateId = readOwn(choice.value, "candidateId").value;
    const verified = await readProductionCaptureBinding({
      runDir: run.runReal,
      outDir: outReal,
      verifiedModel,
      selections,
      candidateId,
    });
    const binding = verified.binding;
    if (binding.selectionBinding.skinId !== skinId) {
      throw new TypeError(`production capture binding skinId does not match index key ${skinId}`);
    }
    summarizeProductionCapture({ skinId, captureResult: verified.captureResult });
    captures[skinId] = {
      outDir: verified.captureResult.outDir,
      candidateId: binding.selectionBinding.candidateId,
      candidateHash: binding.selectionBinding.candidateHash,
      binding,
    };
  }

  return { indexPath, index, captures, gaps };
}

function validateCurrentSourceHashes(currentSourceHashes) {
  if (!isPlainRecord(currentSourceHashes)) {
    throw new TypeError("currentSourceHashes must be a plain or null-prototype object");
  }
  for (const key of Reflect.ownKeys(currentSourceHashes)) {
    if (typeof key !== "string") throw new TypeError("currentSourceHashes must not contain symbol keys");
    if (typeof currentSourceHashes[key] !== "string" || !SHA256_HEX.test(currentSourceHashes[key])) {
      throw new TypeError(`currentSourceHashes.${key} must be a 64-character lowercase SHA-256`);
    }
  }
  for (const file of SOURCE_FILES) {
    if (!Object.hasOwn(currentSourceHashes, file)) {
      throw new TypeError(`currentSourceHashes is missing registered source ${file}`);
    }
  }
  return currentSourceHashes;
}

/** Compare captured source hashes with the fixed current SOURCE_FILES list. */
export function verifyProductionSourceHashes({ skinId, captureResult, currentSourceHashes } = {}) {
  summarizeProductionCapture({ skinId, captureResult });

  const recordedSourceHashes = Object.hasOwn(captureResult.capture, "sourceHashes")
    ? captureResult.capture.sourceHashes
    : undefined;
  if (recordedSourceHashes !== undefined && recordedSourceHashes !== null && !isPlainRecord(recordedSourceHashes)) {
    throw new TypeError("captureResult.capture.sourceHashes must be a plain or null-prototype object or null");
  }
  if (recordedSourceHashes !== undefined && recordedSourceHashes !== null) {
    for (const key of Reflect.ownKeys(recordedSourceHashes)) {
      if (typeof key !== "string")
        throw new TypeError("captureResult.capture.sourceHashes must not contain symbol keys");
    }
  }

  const currentHashes =
    currentSourceHashes === undefined
      ? collectSourceHashes(SOURCE_FILES, (relativePath) => readFileSync(path.join(REPO_ROOT, relativePath)))
      : validateCurrentSourceHashes(currentSourceHashes);

  const errors = [];
  const gaps = [];
  for (const file of SOURCE_FILES) {
    if (
      recordedSourceHashes === undefined ||
      recordedSourceHashes === null ||
      !Object.hasOwn(recordedSourceHashes, file)
    ) {
      gaps.push({
        code: "missing-source-hash",
        file,
        detail: `capture.json sourceHashes is missing ${file}`,
      });
      continue;
    }
    const recordedHash = recordedSourceHashes[file];
    if (typeof recordedHash !== "string" || !SHA256_HEX.test(recordedHash)) {
      errors.push({
        code: "invalid-source-hash",
        file,
        detail: `capture.json sourceHashes.${file} must be a 64-character lowercase SHA-256`,
      });
    } else if (recordedHash !== currentHashes[file]) {
      errors.push({
        code: "source-changed",
        file,
        detail: `captured source hash differs from the current file: ${file}`,
      });
    }
  }

  const registeredFiles = new Set(SOURCE_FILES);
  if (recordedSourceHashes !== undefined && recordedSourceHashes !== null) {
    const unknownFiles = Reflect.ownKeys(recordedSourceHashes)
      .filter((key) => !registeredFiles.has(key))
      .sort();
    for (const file of unknownFiles) {
      errors.push({
        code: "unknown-source-file",
        file,
        detail: `capture.json sourceHashes contains an unregistered path: ${file}`,
      });
    }
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Read fixed, captured non-baseline evidence from a bound formal production capture. */
export async function readProductionStateEvidence({ runDir, outDir, verifiedModel, selections, candidateId } = {}) {
  const { captureResult } = await readProductionCaptureBinding({
    runDir,
    outDir,
    verifiedModel,
    selections,
    candidateId,
  });
  const checksResult = await readProductionCaptureChecks({ skinId: captureResult.skinId, captureResult });
  const mainChecksByUnit = new Map();
  for (const entry of checksResult.entries) {
    if (entry.viewMode !== null) continue;
    const key = `${entry.mode}/${entry.unitId}`;
    if (mainChecksByUnit.has(key)) throw new TypeError(`formal checks contain duplicate main entry ${key}`);
    mainChecksByUnit.set(key, entry);
  }

  const statesById = new Map(STATE_CATALOG.map((state) => [state.id, state]));
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const entries = [];
  for (const mode of MODES) {
    const modeResult = captureResult.modes[mode];
    const states = modeResult.states;
    for (const unit of units) {
      if (unit.kind === "baseline") continue;
      const stateResult = isPlainRecord(states) && Object.hasOwn(states, unit.id) ? states[unit.id] : null;
      const progressKey = `${mode}/${unit.id}`;
      const progressUnit = Object.hasOwn(captureResult.progress.units, progressKey)
        ? captureResult.progress.units[progressKey]
        : null;
      if (stateResult?.status !== "captured" || progressUnit?.status !== "captured") continue;

      const stateId = unit.stateId ?? null;
      const catalogState = stateId === null ? null : statesById.get(stateId);
      if (stateId !== null && !catalogState) {
        throw new TypeError(`capture unit ${unit.id} references an unknown state: ${stateId}`);
      }
      const expectedRoleIds = catalogState?.expectedRoleIds ?? [];
      if (!Array.isArray(expectedRoleIds)) {
        throw new TypeError(`state ${stateId} expectedRoleIds must be an array`);
      }

      const relativePath = `${mode}/states/${unit.id}`;
      const unitDir = path.resolve(captureResult.outDir, mode, "states", unit.id);
      if (!isStrictPathChild(captureResult.outDir, unitDir)) {
        throw new TypeError(`state evidence path escapes capture output: ${relativePath}`);
      }
      const unitReal = await realpath(unitDir);
      if (!isStrictPathChild(captureResult.outDir, unitReal)) {
        throw new TypeError(`state evidence realpath escapes capture output: ${relativePath}`);
      }
      if (!(await stat(unitReal)).isDirectory()) {
        throw new TypeError(`state evidence path must be an existing directory: ${relativePath}`);
      }

      const evidence = await readCapturedUnitEvidence({
        unitDir: unitReal,
        unit,
        mode,
        skinId: captureResult.skinId,
        expectedRoleIds,
        expectedEvidenceHash: progressUnit.evidenceHash,
      });
      const checksEntry = mainChecksByUnit.get(progressKey);
      if (!checksEntry || !isDeepStrictEqual(checksEntry.checks, evidence.checks)) {
        throw new TypeError(`state evidence checks do not match formal checks for ${progressKey}`);
      }
      entries.push({ mode, unitId: unit.id, relativePath, evidence });
    }
  }
  return { entries, gaps: checksResult.gaps };
}

/** Read fixed S0 attachments from a bound formal production capture. */
export async function readProductionBaselineEvidence({ runDir, outDir, verifiedModel, selections, candidateId } = {}) {
  const { captureResult } = await readProductionCaptureBinding({
    runDir,
    outDir,
    verifiedModel,
    selections,
    candidateId,
  });
  const checksResult = await readProductionCaptureChecks({ skinId: captureResult.skinId, captureResult });
  const baselineUnits = STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter((unit) => unit.kind === "baseline");
  if (baselineUnits.length !== 1) throw new TypeError("capture matrix must contain exactly one baseline unit");

  const [unit] = baselineUnits;
  const entries = [];
  for (const mode of MODES) {
    const modeResult = captureResult.modes[mode];
    const progressKey = `${mode}/${unit.id}`;
    const progressUnit = Object.hasOwn(captureResult.progress.units, progressKey)
      ? captureResult.progress.units[progressKey]
      : null;
    if (modeResult.baseline?.status !== "captured" || progressUnit?.status !== "captured") continue;

    const modeDir = path.resolve(captureResult.outDir, mode);
    if (!isStrictPathChild(captureResult.outDir, modeDir)) {
      throw new TypeError(`baseline evidence path escapes capture output: ${mode}`);
    }
    const modeReal = await realpath(modeDir);
    if (!isStrictPathChild(captureResult.outDir, modeReal)) {
      throw new TypeError(`baseline evidence realpath escapes capture output: ${mode}`);
    }
    if (!(await stat(modeReal)).isDirectory()) {
      throw new TypeError(`baseline evidence path must be an existing directory: ${mode}`);
    }

    const evidence = await readCapturedBaselineEvidence({
      modeDir: modeReal,
      progressUnit,
      mode,
      skinId: captureResult.skinId,
      requireMeasurements: true,
    });
    entries.push({ mode, unitId: unit.id, relativePath: mode, evidence });
  }
  return { entries, gaps: checksResult.gaps };
}

function uniqueDiagnostics(groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const diagnostic of group) {
      const key = canonicalJson(diagnostic);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

/** Check the selected candidate and capture metadata against the current production context. */
export function verifyProductionContext({ skinId, captureResult, candidate } = {}) {
  const captureSummary = summarizeProductionCapture({ skinId, captureResult });
  assertCandidate(candidate);
  if (candidate.skinId !== skinId) throw new TypeError("candidate.skinId does not match the requested production skin");

  const policy = JSON.parse(readFileSync(path.join(REPO_ROOT, "scripts", "skin-palette", "policy.json"), "utf8"));
  assertValid(validatePolicy(policy), "current policy");
  const policyHash = sha256Canonical(policy);
  const errors = [];
  const gaps = captureSummary.gaps
    .filter((gap) => gap.code === "fixture-bindings-missing")
    .map(({ code, detail }) => ({ code, detail }));
  const capture = captureResult.capture;

  const fixtureField = readOwn(capture, "fixtureHash");
  if (!fixtureField.found || fixtureField.value === null) {
    gaps.push({ code: "missing-fixture-hash", detail: "capture.json fixtureHash is missing or null" });
  } else if (typeof fixtureField.value !== "string" || !SHA256_HEX.test(fixtureField.value)) {
    errors.push({
      code: "invalid-fixture-hash",
      detail: "capture.json fixtureHash must be a 64-character lowercase SHA-256",
    });
  } else if (fixtureField.value !== getPaletteFixtureHash()) {
    errors.push({
      code: "fixture-changed",
      detail: "capture.json fixtureHash differs from the current logical fixture",
    });
  }

  const policyField = readOwn(capture, "policyHash");
  if (!policyField.found || policyField.value === null) {
    gaps.push({ code: "missing-policy-hash", detail: "capture.json policyHash is missing or null" });
  } else if (typeof policyField.value !== "string" || !SHA256_HEX.test(policyField.value)) {
    errors.push({
      code: "invalid-policy-hash",
      detail: "capture.json policyHash must be a 64-character lowercase SHA-256",
    });
  } else if (policyField.value !== policyHash) {
    errors.push({ code: "policy-changed", detail: "capture.json policyHash differs from the current policy" });
  }

  if (candidate.policyHash !== policyHash) {
    errors.push({
      code: "selected-policy-drift",
      detail: "selected candidate policyHash differs from the current policy",
    });
  }

  const measureField = readOwn(capture, "measureBaseline");
  if (!measureField.found || measureField.value === null) {
    gaps.push({
      code: "missing-baseline-measurement-setting",
      detail: "capture.json measureBaseline is missing or null",
    });
  } else if (measureField.value === false) {
    gaps.push({ code: "baseline-measurements-disabled", detail: "capture.json measureBaseline is false" });
  } else if (measureField.value !== true) {
    throw new TypeError("capture.json measureBaseline must be true, false, or null/missing");
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Combine the bound technical subchecks for one selected production skin. */
export async function verifyProductionCapture({ runDir, outDir, verifiedModel, selections, candidateId } = {}) {
  const input = { runDir, outDir, verifiedModel, selections, candidateId };
  const start = await readProductionCaptureBinding(input);
  const { skinId, candidateId: boundCandidateId, candidateHash } = start.binding.selectionBinding;
  const { candidate } = resolveProductionSelection({ verifiedModel, selections, candidateId });
  const tokenComparison = compareProductionTokens({ candidate });
  const tokenErrors = tokenComparison.differences.map((difference) => ({
    code: "production-token-mismatch",
    mode: difference.mode,
    token: difference.token,
    detail: { code: difference.code, expected: difference.expected, actual: difference.actual },
  }));

  const classification = await classifyProductionCapture({ skinId, captureResult: start.captureResult });
  const source = verifyProductionSourceHashes({ skinId, captureResult: start.captureResult });
  const context = verifyProductionContext({ skinId, captureResult: start.captureResult, candidate });
  const stateEvidence = await readProductionStateEvidence(input);
  const baselineEvidence = await readProductionBaselineEvidence(input);
  const end = await readProductionCaptureBinding(input);
  if (!isDeepStrictEqual(start.binding, end.binding)) {
    throw new TypeError("production capture binding changed during verification");
  }

  const errors = uniqueDiagnostics([tokenErrors, classification.errors, source.errors, context.errors]);
  const gaps = uniqueDiagnostics([
    classification.gaps,
    source.gaps,
    context.gaps,
    stateEvidence.gaps,
    baselineEvidence.gaps,
  ]);
  const status = errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass";
  return {
    skinId,
    candidateId: boundCandidateId,
    candidateHash,
    status,
    exitCode: status === "pass" ? 0 : 2,
    errors,
    gaps,
  };
}

/** Verify every capture registered by one explicit production index, in skin order. */
export async function verifyProductionCaptureIndex({ runDir, capturesIndexPath, verifiedModel, selections } = {}) {
  const input = { runDir, capturesIndexPath, verifiedModel, selections };
  const start = await readProductionCaptureIndex(input);
  const results = [];
  const errors = [];
  const gaps = [...start.gaps];

  for (const skinId of SKIN_IDS) {
    const entry = start.captures[skinId];
    if (!entry) continue;

    const result = await verifyProductionCapture({
      runDir,
      outDir: entry.outDir,
      verifiedModel,
      selections,
      candidateId: entry.candidateId,
    });
    if (
      !isPlainRecord(result) ||
      result.skinId !== skinId ||
      result.candidateId !== entry.candidateId ||
      result.candidateHash !== entry.candidateHash
    ) {
      throw new TypeError(`production capture result identity does not match the index binding for ${skinId}`);
    }

    results.push(result);
    errors.push(...result.errors.map((error) => ({ ...error, skinId })));
    gaps.push(...result.gaps.map((gap) => ({ ...gap, skinId })));
  }

  const end = await readProductionCaptureIndex(input);
  if (
    !isDeepStrictEqual(start.index, end.index) ||
    SKIN_IDS.some((skinId) => !isDeepStrictEqual(start.captures[skinId] ?? null, end.captures[skinId] ?? null))
  ) {
    throw new TypeError("production captures index or binding changed during verification");
  }

  const rejected = results.some((result) => result.status === "rejected") || errors.length > 0;
  const incomplete = results.some((result) => result.status !== "pass") || gaps.length > 0;
  const status = rejected ? "rejected" : incomplete || results.length !== SKIN_IDS.length ? "incomplete" : "pass";
  return { status, exitCode: status === "pass" ? 0 : 2, results, errors, gaps };
}
