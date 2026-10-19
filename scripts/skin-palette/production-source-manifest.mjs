import path from "node:path";
import { enumerateSourceAssets } from "../../public/skins.js";
import { SOURCE_FILES } from "./capture.mjs";
import { sha256Canonical, validateCandidateSet } from "./contracts.mjs";
import { verifyProductionSourceTransition } from "./production-source-transition.mjs";
import { GENERATED_ASSET_TOOL_FILES, verifyProductionGeneratedAssets } from "./review-production.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/;
const URL_LIKE_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:file|https?|ftp|data|blob|ws|wss|url):)/i;
const VALIDATION_PREFIX = ["docs", "validation"];
const SOURCE_ASSET_COUNT = 40;
const PRODUCTION_MANIFEST_KIND = "skin-palette-production-source-manifest";
const FIXED_ORIGIN_FILES = Object.freeze({
  candidateSet: "candidates.json",
  assessment: "assessments.json",
  selections: "selections.json",
});

function readOwnDataFields(value, label) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label} must be a plain or null-prototype object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be a plain or null-prototype object`);
    }
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
    throw new TypeError(`${label} must contain exactly the registered fields`);
  }
  return fields;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new TypeError(`${label} must be a lowercase 64-character SHA-256`);
  }
}

function assertValidationRepoPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    throw new TypeError(`${label} must be a repository-relative POSIX path`);
  }
  const segments = value.split("/");
  if (
    segments.length < VALIDATION_PREFIX.length + 1 ||
    VALIDATION_PREFIX.some((segment, index) => segments[index] !== segment) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a strict child path of docs/validation`);
  }
  return segments;
}

function assertFixedReference(fields, label, path, hashField) {
  if (fields.get("path") !== path) throw new TypeError(`${label}.path must be ${path}`);
  assertSha256(fields.get("fileSha256"), `${label}.fileSha256`);
  if (hashField) assertSha256(fields.get(hashField), `${label}.${hashField}`);
}

function assertHashMap(value, expectedKeys, label) {
  const fields = readExactOwnDataFields(value, expectedKeys, label);
  for (const key of expectedKeys) assertSha256(fields.get(key), `${label}.${key}`);
  return fields;
}

function assertOwnJsonDataTree(value, label, onPath = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite JSON numbers`);
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
        assertOwnJsonDataTree(descriptor.value, `${label}[${index}]`, onPath);
      }
      return;
    }
    for (const [key, child] of readOwnDataFields(value, label)) {
      assertOwnJsonDataTree(child, `${label}.${key}`, onPath);
    }
  } finally {
    onPath.delete(value);
  }
}

function registeredAssetPaths() {
  const assets = enumerateSourceAssets();
  const sourcePaths = assets.map(({ sourcePath }) => sourcePath);
  const publicPaths = assets.map(({ publicPath }) => publicPath);
  if (
    assets.length !== SOURCE_ASSET_COUNT ||
    new Set(sourcePaths).size !== SOURCE_ASSET_COUNT ||
    new Set(publicPaths).size !== SOURCE_ASSET_COUNT
  ) {
    throw new TypeError("registered source assets must contain exactly 40 unique sourcePath and publicPath entries");
  }
  return { sourcePaths, publicPaths };
}

/** Validate only the fixed origin sub-object; this does not read or authorize any source file. */
export function assertProductionManifestOrigin(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["origin", "candidateSet"], "options");
  const candidateSet = optionFields.get("candidateSet");
  let candidateSetResult;
  try {
    candidateSetResult = validateCandidateSet(candidateSet, { expectedSkinIds: [] });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`candidateSet failed M0 validation: ${error.message}`);
  }
  if (!candidateSetResult.valid) {
    const first = candidateSetResult.errors[0];
    throw new TypeError(`candidateSet failed M0 validation: ${first?.path ?? "$"} ${first?.message ?? "invalid"}`);
  }

  const candidateSetFields = readOwnDataFields(candidateSet, "candidateSet");
  const candidateSetHash = candidateSetFields.get("candidateSetHash");
  const candidates = candidateSetFields.get("candidates");
  assertSha256(candidateSetHash, "candidateSet.candidateSetHash");
  const candidateIds = candidates.map((candidate, index) => {
    const candidateFields = readOwnDataFields(candidate, `candidateSet.candidates[${index}]`);
    const candidateId = candidateFields.get("id");
    if (typeof candidateId !== "string") throw new TypeError(`candidateSet.candidates[${index}].id must be a string`);
    return candidateId;
  });

  const originFields = readExactOwnDataFields(
    optionFields.get("origin"),
    ["runDir", "candidateCapturesIndex", "candidateSet", "assessment", "selections", "captureRecords"],
    "origin",
  );
  assertValidationRepoPath(originFields.get("runDir"), "origin.runDir");
  const indexFields = readExactOwnDataFields(
    originFields.get("candidateCapturesIndex"),
    ["path", "fileSha256"],
    "origin.candidateCapturesIndex",
  );
  const indexPath = indexFields.get("path");
  const indexSegments = assertValidationRepoPath(indexPath, "origin.candidateCapturesIndex.path");
  const indexName = indexSegments.at(-1);
  if (indexName.length <= ".json".length || !indexName.endsWith(".json")) {
    throw new TypeError("origin.candidateCapturesIndex.path must end in a non-empty .json filename");
  }
  assertSha256(indexFields.get("fileSha256"), "origin.candidateCapturesIndex.fileSha256");

  for (const [name, expectedPath, hashField] of [
    ["candidateSet", FIXED_ORIGIN_FILES.candidateSet, "candidateSetHash"],
    ["assessment", FIXED_ORIGIN_FILES.assessment, "assessmentHash"],
    ["selections", FIXED_ORIGIN_FILES.selections, "recordHash"],
  ]) {
    const fields = readExactOwnDataFields(originFields.get(name), ["path", "fileSha256", hashField], `origin.${name}`);
    assertFixedReference(fields, `origin.${name}`, expectedPath, hashField);
    if (name === "candidateSet" && fields.get("candidateSetHash") !== candidateSetHash) {
      throw new TypeError("origin.candidateSet.candidateSetHash must match the validated candidateSet");
    }
  }

  const captureFields = readOwnDataFields(originFields.get("captureRecords"), "origin.captureRecords");
  const candidateIdSet = new Set(candidateIds);
  if (
    captureFields.size !== candidateIds.length ||
    [...captureFields.keys()].some((candidateId) => !candidateIdSet.has(candidateId))
  ) {
    throw new TypeError("origin.captureRecords must cover exactly every CandidateSet candidate id");
  }
  const seenCapturePaths = new Set();
  for (const candidateId of candidateIds) {
    const fields = readExactOwnDataFields(
      captureFields.get(candidateId),
      ["capturePath", "fileSha256", "sourceHashesHash"],
      `origin.captureRecords[${candidateId}]`,
    );
    const capturePath = fields.get("capturePath");
    const captureSegments = assertValidationRepoPath(capturePath, `origin.captureRecords[${candidateId}].capturePath`);
    if (captureSegments.at(-1) !== "capture.json") {
      throw new TypeError(`origin.captureRecords[${candidateId}].capturePath must end in capture.json`);
    }
    if (seenCapturePaths.has(capturePath)) {
      throw new TypeError("different candidate ids must not share a capturePath");
    }
    seenCapturePaths.add(capturePath);
    assertSha256(fields.get("fileSha256"), `origin.captureRecords[${candidateId}].fileSha256`);
    assertSha256(fields.get("sourceHashesHash"), `origin.captureRecords[${candidateId}].sourceHashesHash`);
  }

  return undefined;
}

/** Validate only the fixed manifest structure; this does not read or authorize source bytes. */
export function assertProductionSourceManifest(options = {}) {
  const optionFields = readExactOwnDataFields(options, ["manifest", "candidateSet"], "options");
  const candidateSet = optionFields.get("candidateSet");
  const manifestFields = readExactOwnDataFields(
    optionFields.get("manifest"),
    ["schemaVersion", "kind", "origin", "preMigration", "after"],
    "manifest",
  );
  if (manifestFields.get("schemaVersion") !== 1) throw new TypeError("manifest.schemaVersion must be 1");
  if (manifestFields.get("kind") !== PRODUCTION_MANIFEST_KIND) {
    throw new TypeError(`manifest.kind must be ${PRODUCTION_MANIFEST_KIND}`);
  }
  assertProductionManifestOrigin({ origin: manifestFields.get("origin"), candidateSet });

  const preMigrationFields = readExactOwnDataFields(
    manifestFields.get("preMigration"),
    ["precheck"],
    "manifest.preMigration",
  );
  const precheckFields = readExactOwnDataFields(
    preMigrationFields.get("precheck"),
    ["path", "fileSha256"],
    "manifest.preMigration.precheck",
  );
  if (precheckFields.get("path") !== "integration-precheck.json") {
    throw new TypeError("manifest.preMigration.precheck.path must be integration-precheck.json");
  }
  assertSha256(precheckFields.get("fileSha256"), "manifest.preMigration.precheck.fileSha256");

  const afterFields = readExactOwnDataFields(
    manifestFields.get("after"),
    ["sourceHashes", "generatedAssets", "toolHashes"],
    "manifest.after",
  );
  assertHashMap(afterFields.get("sourceHashes"), SOURCE_FILES, "manifest.after.sourceHashes");

  const generatedAssetFields = readExactOwnDataFields(
    afterFields.get("generatedAssets"),
    ["assetManifestSha256", "sourceAssetHashes", "publicAssetHashes"],
    "manifest.after.generatedAssets",
  );
  assertSha256(generatedAssetFields.get("assetManifestSha256"), "manifest.after.generatedAssets.assetManifestSha256");
  const { sourcePaths, publicPaths } = registeredAssetPaths();
  assertHashMap(
    generatedAssetFields.get("sourceAssetHashes"),
    sourcePaths,
    "manifest.after.generatedAssets.sourceAssetHashes",
  );
  assertHashMap(
    generatedAssetFields.get("publicAssetHashes"),
    publicPaths,
    "manifest.after.generatedAssets.publicAssetHashes",
  );
  assertHashMap(afterFields.get("toolHashes"), GENERATED_ASSET_TOOL_FILES, "manifest.after.toolHashes");

  return undefined;
}

function readProductionManifestRecord(value, candidateSet) {
  const fields = readExactOwnDataFields(value, ["manifestPath", "manifestFileSha256", "manifest"], "manifestRecord");
  const manifestPath = fields.get("manifestPath");
  const manifestPathSegments = assertValidationRepoPath(manifestPath, "manifestRecord.manifestPath");
  if (manifestPathSegments.at(-1) !== "production-source-manifest.json") {
    throw new TypeError("manifestRecord.manifestPath must end in production-source-manifest.json");
  }
  assertSha256(fields.get("manifestFileSha256"), "manifestRecord.manifestFileSha256");
  const manifest = fields.get("manifest");
  assertOwnJsonDataTree(candidateSet, "candidateSet");
  assertOwnJsonDataTree(manifest, "manifestRecord.manifest");
  assertProductionSourceManifest({ manifest, candidateSet });
  return { manifest, manifestPathSegments };
}

/** Compare D7d pre-migration asset hashes and a D7c manifest with one D6a snapshot. */
export function verifyProductionAssetTransition(options = {}) {
  const optionFields = readExactOwnDataFields(
    options,
    ["manifestRecord", "preMigrationAssets", "currentAssets", "candidateSet"],
    "options",
  );
  const candidateSet = optionFields.get("candidateSet");
  const { manifest, manifestPathSegments } = readProductionManifestRecord(
    optionFields.get("manifestRecord"),
    candidateSet,
  );

  const manifestFields = readExactOwnDataFields(
    manifest,
    ["schemaVersion", "kind", "origin", "preMigration", "after"],
    "manifest",
  );
  const precheckFields = readExactOwnDataFields(
    readExactOwnDataFields(manifestFields.get("preMigration"), ["precheck"], "manifest.preMigration").get("precheck"),
    ["path", "fileSha256"],
    "manifest.preMigration.precheck",
  );
  const afterFields = readExactOwnDataFields(
    manifestFields.get("after"),
    ["sourceHashes", "generatedAssets", "toolHashes"],
    "manifest.after",
  );
  const afterAssetsFields = readExactOwnDataFields(
    afterFields.get("generatedAssets"),
    ["assetManifestSha256", "sourceAssetHashes", "publicAssetHashes"],
    "manifest.after.generatedAssets",
  );

  const preMigrationFields = readExactOwnDataFields(
    optionFields.get("preMigrationAssets"),
    ["precheckPath", "precheckFileSha256", "generatedAssets"],
    "preMigrationAssets",
  );
  const precheckPath = preMigrationFields.get("precheckPath");
  const precheckPathSegments = assertValidationRepoPath(precheckPath, "preMigrationAssets.precheckPath");
  if (precheckPathSegments.at(-1) !== "integration-precheck.json") {
    throw new TypeError("preMigrationAssets.precheckPath must end in integration-precheck.json");
  }
  assertSha256(preMigrationFields.get("precheckFileSha256"), "preMigrationAssets.precheckFileSha256");
  const oldAssetsFields = readExactOwnDataFields(
    preMigrationFields.get("generatedAssets"),
    ["assetManifestSha256", "sourceAssetHashes", "publicAssetHashes"],
    "preMigrationAssets.generatedAssets",
  );
  assertSha256(oldAssetsFields.get("assetManifestSha256"), "preMigrationAssets.generatedAssets.assetManifestSha256");

  const { sourcePaths, publicPaths } = registeredAssetPaths();
  const oldSourceHashes = assertHashMap(
    oldAssetsFields.get("sourceAssetHashes"),
    sourcePaths,
    "preMigrationAssets.generatedAssets.sourceAssetHashes",
  );
  const oldPublicHashes = assertHashMap(
    oldAssetsFields.get("publicAssetHashes"),
    publicPaths,
    "preMigrationAssets.generatedAssets.publicAssetHashes",
  );
  const afterSourceHashes = assertHashMap(
    afterAssetsFields.get("sourceAssetHashes"),
    sourcePaths,
    "manifest.after.generatedAssets.sourceAssetHashes",
  );
  const afterPublicHashes = assertHashMap(
    afterAssetsFields.get("publicAssetHashes"),
    publicPaths,
    "manifest.after.generatedAssets.publicAssetHashes",
  );
  assertHashMap(afterFields.get("sourceHashes"), SOURCE_FILES, "manifest.after.sourceHashes");
  assertSha256(afterAssetsFields.get("assetManifestSha256"), "manifest.after.generatedAssets.assetManifestSha256");
  const afterToolHashes = assertHashMap(
    afterFields.get("toolHashes"),
    GENERATED_ASSET_TOOL_FILES,
    "manifest.after.toolHashes",
  );

  const currentAssets = optionFields.get("currentAssets");
  const assetValidation = verifyProductionGeneratedAssets({ snapshot: currentAssets });
  const currentFields = readExactOwnDataFields(
    currentAssets,
    ["rootDir", "assetManifestBytes", "assetManifestSha256", "sourceAssetHashes", "publicAssetHashes", "toolHashes"],
    "currentAssets",
  );
  const currentSourceHashes = assertHashMap(
    currentFields.get("sourceAssetHashes"),
    sourcePaths,
    "currentAssets.sourceAssetHashes",
  );
  const currentPublicHashes = assertHashMap(
    currentFields.get("publicAssetHashes"),
    publicPaths,
    "currentAssets.publicAssetHashes",
  );
  const currentToolHashes = assertHashMap(
    currentFields.get("toolHashes"),
    GENERATED_ASSET_TOOL_FILES,
    "currentAssets.toolHashes",
  );

  const errors = [...assetValidation.errors];
  const gaps = [...assetValidation.gaps];
  const compareHash = (actual, expected, code, file, description) => {
    if (actual !== expected) errors.push({ code, path: file, detail: description });
  };

  if (precheckPathSegments.slice(0, -1).join("/") !== manifestPathSegments.slice(0, -1).join("/")) {
    errors.push({
      code: "precheck-manifest-path-mismatch",
      path: precheckPath,
      detail: "integration-precheck.json and production-source-manifest.json must be in the same run directory",
    });
  }
  compareHash(
    preMigrationFields.get("precheckFileSha256"),
    precheckFields.get("fileSha256"),
    "precheck-manifest-binding-mismatch",
    precheckPath,
    "precheckFileSha256 must match manifest.preMigration.precheck.fileSha256",
  );
  compareHash(
    oldAssetsFields.get("assetManifestSha256"),
    currentFields.get("assetManifestSha256"),
    "asset-manifest-changed",
    "public/skin-assets.json",
    "pre-migration and current asset manifest hashes differ",
  );
  compareHash(
    afterAssetsFields.get("assetManifestSha256"),
    currentFields.get("assetManifestSha256"),
    "asset-manifest-after-mismatch",
    "public/skin-assets.json",
    "manifest.after asset manifest hash must match the current snapshot",
  );

  for (let index = 0; index < sourcePaths.length; index += 1) {
    const sourcePath = sourcePaths[index];
    const publicPath = publicPaths[index];
    compareHash(
      oldSourceHashes.get(sourcePath),
      currentSourceHashes.get(sourcePath),
      "source-asset-changed",
      sourcePath,
      "pre-migration and current source asset hashes differ",
    );
    compareHash(
      afterSourceHashes.get(sourcePath),
      currentSourceHashes.get(sourcePath),
      "source-asset-after-mismatch",
      sourcePath,
      "manifest.after source asset hash must match the current snapshot",
    );
    compareHash(
      oldPublicHashes.get(publicPath),
      currentPublicHashes.get(publicPath),
      "public-asset-changed",
      publicPath,
      "pre-migration and current public asset hashes differ",
    );
    compareHash(
      afterPublicHashes.get(publicPath),
      currentPublicHashes.get(publicPath),
      "public-asset-after-mismatch",
      publicPath,
      "manifest.after public asset hash must match the current snapshot",
    );
  }
  for (const file of GENERATED_ASSET_TOOL_FILES) {
    compareHash(
      afterToolHashes.get(file),
      currentToolHashes.get(file),
      "production-tool-after-mismatch",
      file,
      "manifest.after tool hash must match the current snapshot",
    );
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Combine the D4a source transition with its precheck, current-byte, and manifest declarations. */
export function verifyProductionDeclaredSourceTransition(options = {}) {
  const optionFields = readExactOwnDataFields(
    options,
    ["manifestRecord", "preMigrationSources", "currentSources", "verifiedModel", "selections"],
    "options",
  );
  const verifiedModel = optionFields.get("verifiedModel");
  assertOwnJsonDataTree(verifiedModel, "verifiedModel");
  const verifiedModelFields = readOwnDataFields(verifiedModel, "verifiedModel");
  const candidateSet = verifiedModelFields.get("candidateSet");
  const { manifest, manifestPathSegments } = readProductionManifestRecord(
    optionFields.get("manifestRecord"),
    candidateSet,
  );

  const preMigrationFields = readExactOwnDataFields(
    optionFields.get("preMigrationSources"),
    ["precheckPath", "precheckFileSha256", "sourceHashes", "sourceSnapshot"],
    "preMigrationSources",
  );
  const currentFields = readExactOwnDataFields(
    optionFields.get("currentSources"),
    ["rootDir", "sourceBytes", "sourceHashes"],
    "currentSources",
  );
  const precheckPath = preMigrationFields.get("precheckPath");
  const precheckPathSegments = assertValidationRepoPath(precheckPath, "preMigrationSources.precheckPath");
  if (precheckPathSegments.at(-1) !== "integration-precheck.json") {
    throw new TypeError("preMigrationSources.precheckPath must end in integration-precheck.json");
  }
  const precheckFileSha256 = preMigrationFields.get("precheckFileSha256");
  assertSha256(precheckFileSha256, "preMigrationSources.precheckFileSha256");

  const rootDir = currentFields.get("rootDir");
  if (
    typeof rootDir !== "string" ||
    rootDir.trim() === "" ||
    rootDir.includes("\0") ||
    URL_LIKE_PATH.test(rootDir) ||
    !path.isAbsolute(rootDir)
  ) {
    throw new TypeError("currentSources.rootDir must be an absolute filesystem path, not a URL");
  }
  const currentSourceHashFields = assertHashMap(
    currentFields.get("sourceHashes"),
    SOURCE_FILES,
    "currentSources.sourceHashes",
  );

  const manifestFields = readExactOwnDataFields(
    manifest,
    ["schemaVersion", "kind", "origin", "preMigration", "after"],
    "manifest",
  );
  const originFields = readExactOwnDataFields(
    manifestFields.get("origin"),
    ["runDir", "candidateCapturesIndex", "candidateSet", "assessment", "selections", "captureRecords"],
    "manifest.origin",
  );
  const manifestPrecheckFields = readExactOwnDataFields(
    readExactOwnDataFields(manifestFields.get("preMigration"), ["precheck"], "manifest.preMigration").get("precheck"),
    ["path", "fileSha256"],
    "manifest.preMigration.precheck",
  );
  const selectionOriginFields = readExactOwnDataFields(
    originFields.get("selections"),
    ["path", "fileSha256", "recordHash"],
    "manifest.origin.selections",
  );
  const assessmentOriginFields = readExactOwnDataFields(
    originFields.get("assessment"),
    ["path", "fileSha256", "assessmentHash"],
    "manifest.origin.assessment",
  );
  const afterFields = readExactOwnDataFields(
    manifestFields.get("after"),
    ["sourceHashes", "generatedAssets", "toolHashes"],
    "manifest.after",
  );
  const afterSourceHashFields = assertHashMap(
    afterFields.get("sourceHashes"),
    SOURCE_FILES,
    "manifest.after.sourceHashes",
  );

  const selections = optionFields.get("selections");
  assertOwnJsonDataTree(selections, "selections");
  const selectionFields = readOwnDataFields(selections, "selections");
  const errors = [];
  const gaps = [];
  if (precheckPathSegments.slice(0, -1).join("/") !== manifestPathSegments.slice(0, -1).join("/")) {
    errors.push({
      code: "precheck-manifest-path-mismatch",
      path: precheckPath,
      detail: "integration-precheck.json and production-source-manifest.json must be in the same run directory",
    });
  }
  if (precheckFileSha256 !== manifestPrecheckFields.get("fileSha256")) {
    errors.push({
      code: "precheck-manifest-binding-mismatch",
      path: precheckPath,
      detail: "precheckFileSha256 must match manifest.preMigration.precheck.fileSha256",
    });
  }

  const transition = verifyProductionSourceTransition({
    beforeSourceHashes: preMigrationFields.get("sourceHashes"),
    sourceSnapshot: preMigrationFields.get("sourceSnapshot"),
    afterSourceBytes: currentFields.get("sourceBytes"),
    verifiedModel,
    selections,
  });
  errors.push(...transition.errors);
  gaps.push(...transition.gaps);

  const selectionPath = selectionOriginFields.get("path");
  if (selectionFields.get("assessmentHash") !== assessmentOriginFields.get("assessmentHash")) {
    errors.push({
      code: "source-selection-assessment-mismatch",
      path: selectionPath,
      detail: "selections.assessmentHash must match manifest.origin.assessment.assessmentHash",
    });
  }
  if (sha256Canonical(selections) !== selectionOriginFields.get("recordHash")) {
    errors.push({
      code: "source-selection-record-mismatch",
      path: selectionPath,
      detail: "canonical selections digest must match manifest.origin.selections.recordHash",
    });
  }

  const transitionHashFields = assertHashMap(transition.sourceHashes, SOURCE_FILES, "sourceTransition.sourceHashes");
  for (const file of SOURCE_FILES) {
    const actual = transitionHashFields.get(file);
    if (actual !== currentSourceHashFields.get(file)) {
      errors.push({
        code: "current-source-hash-mismatch",
        path: file,
        detail: "currentSources.sourceHashes must match the digest computed from current sourceBytes",
      });
    }
    if (actual !== afterSourceHashFields.get(file)) {
      errors.push({
        code: "source-after-manifest-mismatch",
        path: file,
        detail: "manifest.after.sourceHashes must match the digest computed from current sourceBytes",
      });
    }
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}
