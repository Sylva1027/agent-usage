import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { loadReviewEvidence, REPO_ROOT } from "./review-evidence.mjs";
import { canonicalJson, SKIN_IDS } from "./contracts.mjs";
import {
  readProductionCaptureBinding,
  verifyProductionCurrentStability,
  verifyProductionOriginStability,
  verifyProductionSourceContext,
} from "./review-production.mjs";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readExactDataFields(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new TypeError(`${label} must contain exactly ${expectedKeys.join(" and ")}`);
  }
  return new Map(
    expectedKeys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label}.${key} must be an own data property`);
      }
      return [key, descriptor.value];
    }),
  );
}

function readOwnDataField(value, key, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`${label}.${key} must be an own data property`);
  }
  return descriptor.value;
}

function readAssemblyDiagnostics(value, label) {
  const status = readOwnDataField(value, "status", label);
  const errors = readOwnDataField(value, "errors", label);
  const gaps = readOwnDataField(value, "gaps", label);
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
}

function readDenseShardArray(shards, label = "shards") {
  if (!Array.isArray(shards) || Object.getPrototypeOf(shards) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(shards, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")) {
    throw new TypeError(`${label} must have a data length`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isInteger(length) || length < 1 || length > SKIN_IDS.length) {
    throw new TypeError(`${label} must contain between 1 and ${SKIN_IDS.length} entries`);
  }
  const keys = Reflect.ownKeys(shards);
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length),
    )
  ) {
    throw new TypeError(`${label} must not contain holes or extra keys`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(shards, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be an own data property`);
    }
    return descriptor.value;
  });
}

function validateRelativeCaptureDir(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === ".") ||
    path.posix.normalize(value) !== value
  ) {
    throw new TypeError("capture path must be a canonical POSIX relative directory path");
  }
  return value;
}

function validateFilesystemPath(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty filesystem path without NUL`);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new TypeError(`${label} must be a filesystem path, not a URL`);
  }
}

function isStrictPathChild(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

function assertOwnJsonDataTree(value, label) {
  const onPath = new WeakSet();
  const visit = (node, nodeLabel) => {
    if (node === null || typeof node !== "object") return;
    if (onPath.has(node)) throw new TypeError(`${label} must not contain cycles (${nodeLabel})`);
    onPath.add(node);
    const keys = Reflect.ownKeys(node);
    if (Array.isArray(node)) {
      if (Object.getPrototypeOf(node) !== Array.prototype || keys.length !== node.length + 1) {
        throw new TypeError(`${label} arrays must be dense plain arrays (${nodeLabel})`);
      }
      for (let index = 0; index < node.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          throw new TypeError(`${label} arrays must contain own data entries (${nodeLabel}[${index}])`);
        }
        visit(descriptor.value, `${nodeLabel}[${index}]`);
      }
    } else {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} must contain only plain JSON objects (${nodeLabel})`);
      }
      for (const key of keys) {
        if (typeof key !== "string" || key === "__proto__") {
          throw new TypeError(`${label} must not contain symbol or unsafe keys (${nodeLabel})`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(node, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          throw new TypeError(`${label} must contain own enumerable data properties (${nodeLabel}.${key})`);
        }
        visit(descriptor.value, `${nodeLabel}.${key}`);
      }
    }
    onPath.delete(node);
  };
  visit(value, label);
}

function snapshotJsonData(value, label) {
  assertOwnJsonDataTree(value, label);
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be JSON data: ${error.message}`);
  }
}

function assertSameShardRead(start, end) {
  if (
    !samePath(start.runDir, end.runDir) ||
    !isDeepStrictEqual(start.index, end.index) ||
    start.shards.length !== end.shards.length
  ) {
    throw new TypeError("production capture shard set changed during binding verification");
  }
  for (let index = 0; index < start.shards.length; index += 1) {
    const before = start.shards[index];
    const after = end.shards[index];
    if (
      before.skinId !== after.skinId ||
      !samePath(before.shardPath, after.shardPath) ||
      !samePath(before.outDir, after.outDir) ||
      !isDeepStrictEqual(before.index, after.index) ||
      before.fileSha256 !== after.fileSha256
    ) {
      throw new TypeError(`production capture shard changed during binding verification: ${before.skinId}`);
    }
  }
}

function selectionCandidateId(selections, skinId) {
  const choice = selections?.choices?.[skinId];
  if (!isPlainObject(choice) || typeof choice.candidateId !== "string" || choice.candidateId === "") {
    throw new TypeError(`selections.choices.${skinId}.candidateId must be a non-empty string`);
  }
  return choice.candidateId;
}

function snapshotBoundInput(options) {
  const optionFields = readExactDataFields(options, ["runDir", "shardPaths", "verifiedModel", "selections"], "options");
  const runDir = optionFields.get("runDir");
  const shardPaths = readDenseShardArray(optionFields.get("shardPaths"), "shardPaths");
  validateFilesystemPath(runDir, "runDir");
  for (const [index, shardPath] of shardPaths.entries()) validateFilesystemPath(shardPath, `shardPaths[${index}]`);
  return {
    runDir,
    shardPaths,
    verifiedModel: snapshotJsonData(optionFields.get("verifiedModel"), "verifiedModel"),
    selections: snapshotJsonData(optionFields.get("selections"), "selections"),
  };
}

async function readShardBindings(runDir, shards, verifiedModel, selections) {
  const bindings = new Map();
  for (const shard of shards) {
    const candidateId = selectionCandidateId(selections, shard.skinId);
    const result = await readProductionCaptureBinding({
      runDir,
      outDir: shard.outDir,
      verifiedModel,
      selections,
      candidateId,
    });
    if (
      result.binding?.selectionBinding?.skinId !== shard.skinId ||
      result.binding.selectionBinding.candidateId !== candidateId ||
      !samePath(result.captureResult?.outDir, shard.outDir) ||
      !samePath(path.dirname(result.bindingPath), shard.outDir)
    ) {
      throw new TypeError(`production capture binding does not match the selected shard: ${shard.skinId}`);
    }
    bindings.set(shard.skinId, result);
  }
  return bindings;
}

/** Merge explicitly supplied single-skin production shards without reading or writing files. */
export function mergeProductionCaptureShards(options) {
  const optionFields = readExactDataFields(options, ["shards"], "options");
  const shards = readDenseShardArray(optionFields.get("shards"));
  const bySkin = new Map();
  const paths = new Set();

  for (const [index, shardValue] of shards.entries()) {
    const shardFields = readExactDataFields(shardValue, ["schemaVersion", "captures"], `shards[${index}]`);
    if (shardFields.get("schemaVersion") !== 1) {
      throw new TypeError(`shards[${index}].schemaVersion must be 1`);
    }
    const captures = shardFields.get("captures");
    if (!isPlainObject(captures)) throw new TypeError(`shards[${index}].captures must be a plain object`);
    const skinKeys = Reflect.ownKeys(captures);
    if (skinKeys.length !== 1 || typeof skinKeys[0] !== "string" || !SKIN_IDS.includes(skinKeys[0])) {
      throw new TypeError(`shards[${index}].captures must contain exactly one registered skin ID`);
    }
    const skinId = skinKeys[0];
    const captureFields = readExactDataFields(captures, [skinId], `shards[${index}].captures`);
    const relativeCaptureDir = validateRelativeCaptureDir(captureFields.get(skinId));
    if (bySkin.has(skinId)) throw new TypeError(`duplicate production capture shard for ${skinId}`);
    if (paths.has(relativeCaptureDir)) throw new TypeError(`duplicate production capture path: ${relativeCaptureDir}`);
    bySkin.set(skinId, relativeCaptureDir);
    paths.add(relativeCaptureDir);
  }

  const captures = {};
  for (const skinId of SKIN_IDS) {
    if (bySkin.has(skinId)) captures[skinId] = bySkin.get(skinId);
  }
  return { schemaVersion: 1, captures };
}

/** Read and bind an explicitly supplied set of formal index shards without writing files. */
export async function readProductionCaptureShards(options) {
  const optionFields = readExactDataFields(options, ["runDir", "shardPaths"], "options");
  const runDir = optionFields.get("runDir");
  const shardPaths = readDenseShardArray(optionFields.get("shardPaths"), "shardPaths");
  validateFilesystemPath(runDir, "runDir");
  for (const [index, shardPath] of shardPaths.entries()) validateFilesystemPath(shardPath, `shardPaths[${index}]`);

  const repoReal = await realpath(REPO_ROOT);
  if (!(await stat(repoReal)).isDirectory()) throw new TypeError("REPO_ROOT must be an existing directory");
  const validationLexical = path.resolve(repoReal, "docs", "validation");
  const validationReal = await realpath(validationLexical);
  if (!isStrictPathChild(repoReal, validationReal)) {
    throw new TypeError("docs/validation realpath must be a strict child of REPO_ROOT");
  }
  if (!(await stat(validationReal)).isDirectory()) throw new TypeError("docs/validation must be an existing directory");

  const runLexical = path.resolve(repoReal, runDir);
  if (!isStrictPathChild(validationLexical, runLexical)) {
    throw new TypeError("runDir lexical path must be a strict child of docs/validation");
  }
  const runReal = await realpath(runLexical);
  if (!isStrictPathChild(validationReal, runReal)) {
    throw new TypeError("runDir realpath must be a strict child of docs/validation");
  }
  if (!(await stat(runReal)).isDirectory()) throw new TypeError("runDir must be an existing directory");

  const parsedShards = [];
  const shardRealPaths = [];
  const outRealPaths = [];
  for (const [index, shardPath] of shardPaths.entries()) {
    const shardLexical = path.resolve(repoReal, shardPath);
    if (!isStrictPathChild(validationLexical, shardLexical)) {
      throw new TypeError(`shardPaths[${index}] lexical path must be a strict child of docs/validation`);
    }
    if (path.basename(shardLexical) !== "production-index-shard.json") {
      throw new TypeError(`shardPaths[${index}] basename must be production-index-shard.json`);
    }
    const shardInfo = await lstat(shardLexical);
    if (shardInfo.isSymbolicLink() || !shardInfo.isFile()) {
      throw new TypeError(`shardPaths[${index}] must be a regular non-symlink file`);
    }
    const shardReal = await realpath(shardLexical);
    if (!isStrictPathChild(validationReal, shardReal)) {
      throw new TypeError(`shardPaths[${index}] realpath must be a strict child of docs/validation`);
    }
    if (path.basename(shardReal) !== "production-index-shard.json") {
      throw new TypeError(`shardPaths[${index}] real basename must be production-index-shard.json`);
    }

    const outLexical = path.dirname(shardLexical);
    const outReal = await realpath(outLexical);
    if (
      !isStrictPathChild(validationReal, outReal) ||
      samePath(outReal, runReal) ||
      samePath(outReal, validationReal) ||
      !samePath(path.dirname(shardReal), outReal)
    ) {
      throw new TypeError(`shardPaths[${index}] parent directory must be a distinct directory inside docs/validation`);
    }
    if (!(await stat(outReal)).isDirectory()) {
      throw new TypeError(`shardPaths[${index}] parent must be an existing directory`);
    }
    if (shardRealPaths.some((seen) => samePath(seen, shardReal))) {
      throw new TypeError(`shardPaths[${index}] duplicates an existing shard realpath`);
    }
    if (outRealPaths.some((seen) => samePath(seen, outReal))) {
      throw new TypeError(`shardPaths[${index}] duplicates an existing output directory realpath`);
    }

    const bytes = await readFile(shardReal);
    let singleSkinIndex;
    try {
      singleSkinIndex = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw new TypeError(`shardPaths[${index}] must contain strict UTF-8 JSON: ${error.message}`);
    }
    const oneSkinIndex = mergeProductionCaptureShards({ shards: [singleSkinIndex] });
    const [skinId] = Object.keys(oneSkinIndex.captures);
    const relativeOutDir = oneSkinIndex.captures[skinId];
    const expectedRelativeOutDir = path.relative(runReal, outReal).split(path.sep).join("/");
    if (relativeOutDir !== expectedRelativeOutDir) {
      throw new TypeError(`shardPaths[${index}] capture path must exactly match its actual output directory`);
    }
    const mappedOutReal = await realpath(path.resolve(runReal, relativeOutDir));
    if (!samePath(mappedOutReal, outReal)) {
      throw new TypeError(`shardPaths[${index}] capture path does not resolve to its shard parent directory`);
    }

    shardRealPaths.push(shardReal);
    outRealPaths.push(outReal);
    parsedShards.push({ skinId, shardReal, outReal, oneSkinIndex, bytes });
  }

  const index = mergeProductionCaptureShards({ shards: parsedShards.map(({ oneSkinIndex }) => oneSkinIndex) });
  const bySkin = new Map(parsedShards.map((entry) => [entry.skinId, entry]));
  const shards = SKIN_IDS.filter((skinId) => bySkin.has(skinId)).map((skinId) => {
    const { shardReal, outReal, oneSkinIndex, bytes } = bySkin.get(skinId);
    return {
      skinId,
      shardPath: shardReal,
      outDir: outReal,
      index: oneSkinIndex,
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return { runDir: runReal, index, shards };
}

/** Bind explicit shards to the full caller-supplied selection and recheck for drift. */
export async function readBoundProductionCaptureShards(options) {
  const input = snapshotBoundInput(options);
  const { runDir, shardPaths, verifiedModel, selections } = input;

  const start = await readProductionCaptureShards({ runDir, shardPaths });
  const startBindings = await readShardBindings(start.runDir, start.shards, verifiedModel, selections);
  const end = await readProductionCaptureShards({ runDir, shardPaths });
  assertSameShardRead(start, end);
  const endBindings = await readShardBindings(end.runDir, end.shards, verifiedModel, selections);

  const shards = start.shards.map((shard) => {
    const before = startBindings.get(shard.skinId);
    const after = endBindings.get(shard.skinId);
    if (
      !before ||
      !after ||
      !samePath(before.bindingPath, after.bindingPath) ||
      !isDeepStrictEqual(before.binding, after.binding) ||
      !isDeepStrictEqual(before.captureResult, after.captureResult)
    ) {
      throw new TypeError(`production capture binding changed during verification: ${shard.skinId}`);
    }
    return { ...shard, binding: structuredClone(before.binding) };
  });
  return { runDir: start.runDir, index: start.index, shards };
}

async function resolveProductionIndexTarget(runReal) {
  const repoReal = await realpath(REPO_ROOT);
  const validationReal = await realpath(path.resolve(repoReal, "docs", "validation"));
  if (!isStrictPathChild(repoReal, validationReal) || !isStrictPathChild(validationReal, runReal)) {
    throw new TypeError("production index parent must remain inside a strict docs/validation child");
  }
  if (!samePath(await realpath(runReal), runReal) || !(await stat(runReal)).isDirectory()) {
    throw new TypeError("production index runDir must remain the same real directory");
  }
  const indexPath = path.join(runReal, "production-captures-index.json");
  const parentReal = await realpath(path.dirname(indexPath));
  if (!samePath(parentReal, runReal) || !isStrictPathChild(validationReal, parentReal)) {
    throw new TypeError("production index parent realpath must remain the supplied runDir inside docs/validation");
  }
  return { indexPath, validationReal };
}

async function readProductionIndexFile(indexPath, runReal, validationReal, { allowMissing = false } = {}) {
  let info;
  try {
    info = await lstat(indexPath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new TypeError(`${indexPath} must be a regular non-symlink file`);
  }
  const indexReal = await realpath(indexPath);
  if (
    path.basename(indexReal) !== "production-captures-index.json" ||
    !isStrictPathChild(validationReal, indexReal) ||
    !samePath(path.dirname(indexReal), runReal)
  ) {
    throw new TypeError(`${indexPath} realpath must remain a direct child of its runDir inside docs/validation`);
  }
  return readFile(indexReal);
}

/** Write the one-shot production index, accepting only byte-identical reuse. */
export async function writeProductionCaptureIndex(options) {
  const input = snapshotBoundInput(options);
  const start = await readBoundProductionCaptureShards(input);
  const { indexPath, validationReal } = await resolveProductionIndexTarget(start.runDir);
  const contents = Buffer.from(`${JSON.stringify(start.index, null, 2)}\n`, "utf8");
  let created = false;
  const existing = await readProductionIndexFile(indexPath, start.runDir, validationReal, { allowMissing: true });
  if (existing) {
    if (!existing.equals(contents)) {
      throw new TypeError(`${indexPath} already exists with different bytes; the production index is write-once`);
    }
  } else {
    try {
      await writeFile(indexPath, contents, { flag: "wx" });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = await readProductionIndexFile(indexPath, start.runDir, validationReal);
      if (!raced.equals(contents)) {
        throw new TypeError(`${indexPath} already exists with different bytes; the production index is write-once`);
      }
    }
  }

  let finalBytes;
  try {
    const end = await readBoundProductionCaptureShards(input);
    if (!isDeepStrictEqual(start, end)) {
      throw new TypeError("bound shard or production capture evidence changed after index write");
    }
    const finalTarget = await resolveProductionIndexTarget(start.runDir);
    if (!samePath(finalTarget.indexPath, indexPath)) {
      throw new TypeError("fixed production index path changed after write");
    }
    finalBytes = await readProductionIndexFile(indexPath, start.runDir, finalTarget.validationReal);
    if (!finalBytes.equals(contents)) {
      throw new TypeError("production index bytes changed after write");
    }
  } catch (error) {
    throw new TypeError(`${indexPath} remains on disk but is not verified: ${error.message}`, { cause: error });
  }

  return {
    indexPath,
    index: start.index,
    fileSha256: createHash("sha256").update(finalBytes).digest("hex"),
    created,
  };
}

/** Assemble the write-once index only from the real historical source gate. */
export async function assembleProductionCaptureIndex(options) {
  const optionFields = readExactDataFields(options, ["runDir", "shardPaths"], "options");
  const runDirInput = optionFields.get("runDir");
  const shardPaths = readDenseShardArray(optionFields.get("shardPaths"), "shardPaths");
  validateFilesystemPath(runDirInput, "runDir");
  for (const [index, shardPath] of shardPaths.entries()) {
    validateFilesystemPath(shardPath, `shardPaths[${index}]`);
  }
  const runDir = path.resolve(REPO_ROOT, runDirInput);

  const evidence = await loadReviewEvidence({
    runDir,
    capturesIndexPath: path.join(runDir, "captures-index.json"),
  });
  const sourceResult = await verifyProductionSourceContext({ manifestRunDir: runDir, evidence });
  const sourceDiagnostics = readAssemblyDiagnostics(sourceResult, "sourceResult");
  if (sourceDiagnostics.status !== "pass") {
    return {
      status: sourceDiagnostics.status,
      exitCode: 2,
      errors: sourceDiagnostics.errors,
      gaps: sourceDiagnostics.gaps,
      indexResult: null,
      sourceResult,
      postOriginStability: null,
      postCurrentStability: null,
    };
  }

  const historicalContext = readOwnDataField(sourceResult, "historicalContext", "sourceResult");
  const historicalEvidence = readOwnDataField(historicalContext, "historicalEvidence", "historicalContext");
  const historicalResult = readOwnDataField(historicalEvidence, "historicalResult", "historicalEvidence");
  const historicalStatus = readOwnDataField(historicalResult, "status", "historicalResult");
  const historicalErrors = readOwnDataField(historicalResult, "errors", "historicalResult");
  const historicalGaps = readOwnDataField(historicalResult, "gaps", "historicalResult");
  const verifiedModel = readOwnDataField(historicalResult, "verifiedModel", "historicalResult");
  if (
    !["pass", "incomplete", "rejected"].includes(historicalStatus) ||
    readOwnDataField(historicalResult, "sourceContext", "historicalResult") !== "historical" ||
    !Array.isArray(historicalErrors) ||
    historicalErrors.length > 0 ||
    !Array.isArray(historicalGaps) ||
    !isPlainObject(verifiedModel) ||
    readOwnDataField(verifiedModel, "kind", "verifiedModel") !== "skin-palette-review-verified-model" ||
    readOwnDataField(verifiedModel, "production", "verifiedModel") !== false ||
    !isPlainObject(readOwnDataField(verifiedModel, "candidateSet", "verifiedModel")) ||
    !isPlainObject(readOwnDataField(verifiedModel, "container", "verifiedModel")) ||
    !Array.isArray(readOwnDataField(verifiedModel, "selectableCandidateIds", "verifiedModel"))
  ) {
    throw new TypeError("clean sourceResult must contain a complete verified historical model");
  }

  const currentContext = readOwnDataField(sourceResult, "currentContext", "sourceResult");
  const currentFields = readExactDataFields(
    currentContext,
    ["selectedCandidates", "currentSources", "currentAssets", "sourceTransition", "assetTransition"],
    "currentContext",
  );
  if (
    !Array.isArray(currentFields.get("selectedCandidates")) ||
    currentFields.get("selectedCandidates").length !== SKIN_IDS.length
  ) {
    throw new TypeError("clean sourceResult must contain all selected current candidates");
  }
  for (const key of ["sourceTransition", "assetTransition"]) {
    if (readAssemblyDiagnostics(currentFields.get(key), `currentContext.${key}`).status !== "pass") {
      throw new TypeError(`clean sourceResult requires a passing currentContext.${key}`);
    }
  }
  for (const key of ["originStability", "currentStability"]) {
    if (
      readAssemblyDiagnostics(readOwnDataField(sourceResult, key, "sourceResult"), `sourceResult.${key}`).status !==
      "pass"
    ) {
      throw new TypeError(`clean sourceResult requires a passing ${key}`);
    }
  }

  const selectionEvidence = readOwnDataField(evidence, "selections", "evidence");
  if (readOwnDataField(selectionEvidence, "present", "evidence.selections") !== true) {
    throw new TypeError("clean sourceResult requires a recorded selection");
  }
  const selections = readOwnDataField(selectionEvidence, "record", "evidence.selections");
  if (!isPlainObject(selections)) throw new TypeError("evidence.selections.record must be a plain object");

  const indexResult = await writeProductionCaptureIndex({ runDir, shardPaths, verifiedModel, selections });
  const postOriginStability = await verifyProductionOriginStability({
    manifestRunDir: runDir,
    evidence,
    historicalContext,
  });
  const postOriginDiagnostics = readAssemblyDiagnostics(postOriginStability, "postOriginStability");
  const postCurrentStability = await verifyProductionCurrentStability({
    currentSources: currentFields.get("currentSources"),
    currentAssets: currentFields.get("currentAssets"),
  });
  const postCurrentDiagnostics = readAssemblyDiagnostics(postCurrentStability, "postCurrentStability");
  const errors = [...postOriginDiagnostics.errors, ...postCurrentDiagnostics.errors];
  const gaps = [...postOriginDiagnostics.gaps, ...postCurrentDiagnostics.gaps];
  const status = errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "assembled";

  return {
    status,
    exitCode: status === "assembled" ? 0 : 2,
    errors,
    gaps,
    indexResult,
    sourceResult,
    postOriginStability,
    postCurrentStability,
  };
}
