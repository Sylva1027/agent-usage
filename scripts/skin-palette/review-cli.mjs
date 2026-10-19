import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SKIN_IDS, validateCandidateSet } from "./contracts.mjs";
import { startCandidatePreview } from "./preview-server.mjs";
import { REPO_ROOT, loadReviewEvidence } from "./review-evidence.mjs";
import { renderReviewReport } from "./report.mjs";
import { buildSelectionScript } from "./review-selection.mjs";
import { verifyReviewEvidence } from "./review-verify.mjs";
import { createPaletteFixture } from "../../test-support/skin-palette-fixture.mjs";

const COMMANDS = {
  serve: { options: { run: "runDir", candidate: "candidateId" }, required: ["run", "candidate"] },
  capture: {
    options: { run: "runDir", candidate: "candidateId", out: "outDir", production: true },
    required: ["run", "candidate", "out"],
  },
  report: { options: { run: "runDir", "captures-index": "capturesIndexPath" }, required: ["run", "captures-index"] },
  verify: { options: { run: "runDir", "require-selections": true, production: true }, required: ["run"] },
};
const KNOWN_OPTIONS = new Set(Object.values(COMMANDS).flatMap((command) => Object.keys(command.options)));
const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Parse the fixed review CLI grammar without reading paths or running a command. */
export function parseReviewArgs(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    throw new TypeError("argv must be an array of strings");
  }
  const [command, ...arguments_] = argv;
  const specification = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!specification) {
    throw new TypeError(`Unknown command ${command ?? "<missing>"}; expected serve, capture, report, or verify`);
  }

  const result = {
    command,
    runDir: null,
    candidateId: null,
    outDir: null,
    capturesIndexPath: null,
    requireSelections: false,
    production: false,
  };
  const seen = new Set();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      if (argument === "true" || argument === "false") {
        throw new TypeError(`Unexpected boolean value "${argument}"; --require-selections takes no value`);
      }
      throw new TypeError(`Unexpected positional argument "${argument}"`);
    }
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) {
      throw new TypeError(`Unsupported --name=value syntax for "${argument.slice(0, equalsIndex)}"`);
    }

    const option = argument.slice(2);
    if (!Object.hasOwn(specification.options, option)) {
      if (KNOWN_OPTIONS.has(option)) throw new TypeError(`Option "--${option}" is not valid for ${command}`);
      throw new TypeError(`Unknown option "${argument}" for ${command}`);
    }
    const target = specification.options[option];
    if (seen.has(option)) throw new TypeError(`Duplicate option "${argument}"`);
    seen.add(option);

    if (target === true) {
      if (arguments_[index + 1] === "true" || arguments_[index + 1] === "false") {
        throw new TypeError(`Boolean option "${argument}" does not take a value`);
      }
      if (option === "require-selections") result.requireSelections = true;
      else if (option === "production") result.production = true;
      continue;
    }

    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`Missing value for "${argument}"`);
    if (value.trim() === "") throw new TypeError(`Value for "${argument}" must not be blank`);
    result[target] = value;
    index += 1;
  }

  for (const option of specification.required) {
    const resultKey = specification.options[option];
    if (result[resultKey] === null) throw new TypeError(`Missing required option "--${option}" for ${command}`);
  }
  return result;
}

const VERIFY_EXIT_CODES = Object.freeze({ pass: 0, incomplete: 2, rejected: 2, invalid: 1 });

function assertProductionDiagnostics(result, label) {
  if (!isPlainObject(result)) throw new TypeError(`${label} returned a malformed result`);
  for (const key of ["status", "errors", "gaps"]) {
    if (!Object.hasOwn(result, key)) throw new TypeError(`${label} result is missing ${key}`);
  }
  if (!Array.isArray(result.errors) || !Array.isArray(result.gaps)) {
    throw new TypeError(`${label} errors and gaps must be arrays`);
  }
  if (
    !["pass", "incomplete", "rejected"].includes(result.status) ||
    (result.status === "pass" && (result.errors.length > 0 || result.gaps.length > 0)) ||
    (result.status === "incomplete" && (result.errors.length > 0 || result.gaps.length === 0)) ||
    (result.status === "rejected" && result.errors.length === 0)
  ) {
    throw new TypeError(`${label} status is inconsistent with its diagnostics`);
  }
  return result;
}

function describeProductionError(error) {
  if (error instanceof AggregateError) {
    const nested = [...error.errors].map(describeProductionError);
    return `${error.name}: ${error.message}${nested.length > 0 ? ` (${nested.join("; ")})` : ""}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function getProductionCaptureAdapter(injected) {
  const names = [
    "verifyProductionSourceContext",
    "runProductionCapture",
    "classifyProductionCapture",
    "verifyProductionOriginStability",
    "verifyProductionCurrentStability",
    "writeProductionCaptureBinding",
    "writeProductionCaptureIndexShard",
  ];
  if (injected !== undefined) {
    if (!isPlainObject(injected)) throw new TypeError("productionCaptureAdapter must be a plain object");
    const keys = Reflect.ownKeys(injected);
    if (
      keys.length !== names.length ||
      keys.some((key) => typeof key !== "string" || !names.includes(key)) ||
      names.some((name) => typeof injected[name] !== "function")
    ) {
      throw new TypeError("productionCaptureAdapter must contain exactly the production capture functions");
    }
    return injected;
  }

  const [production, capture] = await Promise.all([import("./review-production.mjs"), import("./review-capture.mjs")]);
  return {
    verifyProductionSourceContext: production.verifyProductionSourceContext,
    runProductionCapture: production.runProductionCapture,
    classifyProductionCapture: capture.classifyProductionCapture,
    verifyProductionOriginStability: production.verifyProductionOriginStability,
    verifyProductionCurrentStability: production.verifyProductionCurrentStability,
    writeProductionCaptureBinding: production.writeProductionCaptureBinding,
    writeProductionCaptureIndexShard: production.writeProductionCaptureIndexShard,
  };
}

async function runProductionCaptureCommand({ parsed, dependencies, stdout, writeError }) {
  const runDir = path.resolve(REPO_ROOT, parsed.runDir);
  const outDir = path.resolve(REPO_ROOT, parsed.outDir);
  let step = "candidate evidence load";
  try {
    const loadEvidence = dependencies?.loadEvidence ?? loadReviewEvidence;
    const evidence = await loadEvidence({ runDir, capturesIndexPath: path.join(runDir, "captures-index.json") });

    step = "load production capture functions";
    const adapter = await getProductionCaptureAdapter(dependencies?.productionCaptureAdapter);

    step = "production source verification";
    const sourceResult = assertProductionDiagnostics(
      await adapter.verifyProductionSourceContext({ manifestRunDir: runDir, evidence }),
      "verifyProductionSourceContext",
    );
    if (sourceResult.status !== "pass") {
      step = "write source gate result";
      stdout.write(
        `${JSON.stringify({
          command: "capture",
          production: true,
          candidateId: parsed.candidateId,
          skinId: null,
          outDir,
          status: sourceResult.status,
          errors: sourceResult.errors,
          gaps: sourceResult.gaps,
        })}\n`,
      );
      return 2;
    }

    const historicalContext = sourceResult.historicalContext;
    const historicalEvidence = historicalContext?.historicalEvidence;
    const historicalResult = historicalEvidence?.historicalResult;
    const verifiedModel = historicalResult?.verifiedModel;
    const currentContext = sourceResult.currentContext;
    const selectionsContainer = evidence?.selections;
    const selections = selectionsContainer?.record;
    if (
      !isPlainObject(historicalContext) ||
      !isPlainObject(historicalEvidence) ||
      !isPlainObject(historicalResult) ||
      !Object.hasOwn(historicalResult, "verifiedModel") ||
      !isPlainObject(verifiedModel)
    ) {
      throw new TypeError("source gate pass is missing the original historical verifiedModel");
    }
    if (!isPlainObject(currentContext?.currentSources)) {
      throw new TypeError("source gate pass is missing currentContext.currentSources");
    }
    if (!isPlainObject(currentContext?.currentAssets)) {
      throw new TypeError("source gate pass is missing currentContext.currentAssets");
    }
    if (
      !isPlainObject(selectionsContainer) ||
      !Object.hasOwn(selectionsContainer, "record") ||
      !isPlainObject(selections)
    ) {
      throw new TypeError("candidate evidence is missing selections.record");
    }

    step = "production capture";
    const capture = await adapter.runProductionCapture({
      runDir,
      verifiedModel,
      selections,
      candidateId: parsed.candidateId,
      outDir,
    });
    if (!isPlainObject(capture)) throw new TypeError("runProductionCapture returned a malformed result");
    if (capture.candidateId !== parsed.candidateId) {
      throw new TypeError("runProductionCapture returned a different candidate ID");
    }
    if (!isPlainObject(capture.selectionBinding)) {
      throw new TypeError("runProductionCapture returned a malformed selectionBinding");
    }
    if (capture.selectionBinding.candidateId !== parsed.candidateId) {
      throw new TypeError("runProductionCapture selectionBinding returned a different candidate ID");
    }
    if (!SKIN_IDS.includes(capture.selectionBinding.skinId)) {
      throw new TypeError("runProductionCapture returned a missing or unknown selectionBinding.skinId");
    }
    const { skinId } = capture.selectionBinding;
    const captureResult = capture.captureResult;
    if (
      !isPlainObject(captureResult) ||
      captureResult.skinId !== skinId ||
      typeof captureResult.outDir !== "string" ||
      path.resolve(captureResult.outDir) !== outDir
    ) {
      throw new TypeError("runProductionCapture returned a malformed or mismatched captureResult");
    }

    step = "production capture classification";
    const classification = await adapter.classifyProductionCapture({ skinId, captureResult });
    if (!isPlainObject(classification)) throw new TypeError("classifyProductionCapture returned a malformed result");
    for (const key of ["status", "exitCode", "errors", "gaps"]) {
      if (!Object.hasOwn(classification, key))
        throw new TypeError(`classifyProductionCapture result is missing ${key}`);
    }
    const expectedExitCode = { captured: 0, incomplete: 2, failed: 2 };
    if (!Object.hasOwn(expectedExitCode, classification.status)) {
      throw new TypeError(`classifyProductionCapture returned unknown status: ${String(classification.status)}`);
    }
    if (!Array.isArray(classification.errors) || !Array.isArray(classification.gaps)) {
      throw new TypeError("classifyProductionCapture errors and gaps must be arrays");
    }
    if (
      classification.exitCode !== expectedExitCode[classification.status] ||
      (classification.status === "captured" && (classification.errors.length > 0 || classification.gaps.length > 0)) ||
      (classification.status === "failed" && classification.errors.length === 0) ||
      (classification.status === "incomplete" && (classification.errors.length > 0 || classification.gaps.length === 0))
    ) {
      throw new TypeError("classifyProductionCapture status is inconsistent with its diagnostics");
    }

    step = "production origin stability recheck";
    const originResult = await adapter.verifyProductionOriginStability({
      manifestRunDir: runDir,
      evidence,
      historicalContext,
    });
    step = "production current stability recheck";
    const currentResult = await adapter.verifyProductionCurrentStability({
      currentSources: currentContext.currentSources,
      currentAssets: currentContext.currentAssets,
    });
    assertProductionDiagnostics(originResult, "verifyProductionOriginStability");
    assertProductionDiagnostics(currentResult, "verifyProductionCurrentStability");

    if (originResult.status !== "pass" || currentResult.status !== "pass") {
      const errors = [...classification.errors, ...originResult.errors, ...currentResult.errors];
      const gaps = [...classification.gaps, ...originResult.gaps, ...currentResult.gaps];
      const status = errors.length > 0 ? "rejected" : "incomplete";
      step = "write stability result";
      stdout.write(
        `${JSON.stringify({
          command: "capture",
          production: true,
          candidateId: parsed.candidateId,
          skinId,
          outDir,
          status,
          errors,
          gaps,
        })}\n`,
      );
      return 2;
    }

    step = "write production capture binding";
    const bindingResult = await adapter.writeProductionCaptureBinding({
      runDir,
      verifiedModel,
      selections,
      candidateId: parsed.candidateId,
      captureResult,
    });
    if (
      !isPlainObject(bindingResult) ||
      typeof bindingResult.bindingPath !== "string" ||
      path.resolve(bindingResult.bindingPath) !== path.join(outDir, "production-selection.json") ||
      !isPlainObject(bindingResult.binding)
    ) {
      throw new TypeError("writeProductionCaptureBinding returned a malformed result");
    }

    step = "write production capture index shard";
    const shardResult = await adapter.writeProductionCaptureIndexShard({
      runDir,
      outDir,
      verifiedModel,
      selections,
      candidateId: parsed.candidateId,
    });
    const shardIndex = shardResult?.index;
    const shardIndexKeys = isPlainObject(shardIndex) ? Reflect.ownKeys(shardIndex) : [];
    const shardCaptures = shardIndex?.captures;
    const shardKeys = isPlainObject(shardCaptures) ? Reflect.ownKeys(shardCaptures) : [];
    const expectedShardCapturePath = path.relative(runDir, outDir).split(path.sep).join("/");
    if (
      !isPlainObject(shardResult) ||
      typeof shardResult.shardPath !== "string" ||
      path.resolve(shardResult.shardPath) !== path.join(outDir, "production-index-shard.json") ||
      !isPlainObject(shardIndex) ||
      shardIndexKeys.length !== 2 ||
      shardIndexKeys.some((key) => typeof key !== "string" || !["schemaVersion", "captures"].includes(key)) ||
      !Object.hasOwn(shardIndex, "schemaVersion") ||
      !Object.hasOwn(shardIndex, "captures") ||
      shardIndex.schemaVersion !== 1 ||
      !isPlainObject(shardCaptures) ||
      shardKeys.length !== 1 ||
      shardKeys[0] !== skinId ||
      shardCaptures[skinId] !== expectedShardCapturePath
    ) {
      throw new TypeError("writeProductionCaptureIndexShard returned a malformed single-skin shard");
    }

    step = "write production capture result";
    stdout.write(
      `${JSON.stringify({
        command: "capture",
        production: true,
        candidateId: parsed.candidateId,
        skinId,
        outDir,
        status: classification.status,
        errors: classification.errors,
        gaps: classification.gaps,
        bindingPath: bindingResult.bindingPath,
        shardPath: shardResult.shardPath,
      })}\n`,
    );
    return classification.exitCode;
  } catch (error) {
    writeError(`production capture ${step} failed for ${outDir}: ${describeProductionError(error)}`);
    return 1;
  }
}

const isUrlLikePath = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(file|https?|ftp|data|blob|ws|wss|url):/i.test(value);

const isStrictDescendant = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Read one valid, exactly-identified candidate without requiring capture or assessment evidence. */
export async function loadPreviewCandidate({ runDir, candidateId, rootDir = REPO_ROOT } = {}) {
  for (const [label, value] of [
    ["runDir", runDir],
    ["candidateId", candidateId],
    ["rootDir", rootDir],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${label} must be a non-empty string`);
    }
  }
  if (isUrlLikePath(runDir)) throw new TypeError("runDir must be a filesystem path, not a URL");
  if (isUrlLikePath(rootDir)) throw new TypeError("rootDir must be a filesystem path, not a URL");

  const rootPath = path.resolve(rootDir);
  const validationRootPath = path.resolve(rootPath, "docs", "validation");
  const runPath = path.resolve(rootPath, runDir);
  if (!isStrictDescendant(validationRootPath, runPath)) {
    throw new TypeError("runDir must be a strict child of rootDir/docs/validation");
  }

  const rootReal = await realpath(rootPath);
  if (!(await stat(rootReal)).isDirectory()) throw new TypeError("rootDir must be an existing directory");
  const validationRootReal = await realpath(path.join(rootReal, "docs", "validation"));
  if (!(await stat(validationRootReal)).isDirectory()) {
    throw new TypeError("rootDir/docs/validation must be an existing directory");
  }
  const runReal = await realpath(runPath);
  if (!isStrictDescendant(validationRootReal, runReal)) {
    throw new TypeError("runDir resolves outside rootDir/docs/validation");
  }
  if (!(await stat(runReal)).isDirectory()) throw new TypeError("runDir must be an existing directory");

  const candidatePath = path.join(runReal, "candidates.json");
  const candidateEntry = await lstat(candidatePath);
  if (candidateEntry.isSymbolicLink()) throw new TypeError("candidates.json must not be a symlink or junction");
  if (!candidateEntry.isFile()) throw new TypeError("candidates.json must be a regular file");
  const candidateReal = await realpath(candidatePath);
  if (!isStrictDescendant(runReal, candidateReal)) {
    throw new TypeError("candidates.json resolves outside the verified run directory");
  }

  let candidateSet;
  try {
    candidateSet = JSON.parse(await readFile(candidateReal, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`candidates.json is invalid JSON: ${error.message}`);
    throw error;
  }

  const validation = validateCandidateSet(candidateSet, { expectedSkinIds: [] });
  if (!validation.valid) {
    const details = validation.errors.map(({ path: field, message }) => `${field}: ${message}`).join("; ");
    throw new TypeError(`candidates.json failed candidate-set validation: ${details}`);
  }
  const candidate = candidateSet.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) throw new TypeError(`unknown candidate ID "${candidateId}"`);
  return candidate;
}

async function writeReviewReport({ runDir, html } = {}) {
  if (typeof runDir !== "string" || runDir.trim() === "") throw new TypeError("runDir must be a non-empty path");
  if (typeof html !== "string" || html.trim() === "") throw new TypeError("rendered report must be non-empty HTML");

  const validationRootReal = await realpath(path.join(REPO_ROOT, "docs", "validation"));
  const runDirReal = await realpath(path.resolve(REPO_ROOT, runDir));
  const relativeRunDir = path.relative(validationRootReal, runDirReal);
  if (
    relativeRunDir === "" ||
    relativeRunDir === ".." ||
    relativeRunDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRunDir)
  ) {
    throw new TypeError("verified run directory must be inside docs/validation and cannot be its root");
  }
  if (!(await stat(runDirReal)).isDirectory()) throw new TypeError("verified run directory must be a directory");

  const reportPath = path.join(runDirReal, "report.html");
  await writeFile(reportPath, html, { encoding: "utf8", flag: "wx" });
  return reportPath;
}

/** Run the review CLI commands with capture isolated behind its adapter. */
export async function runReviewCommand(argv, dependencies = {}) {
  const stdout = dependencies?.stdout ?? process.stdout;
  const stderr = dependencies?.stderr ?? process.stderr;
  const writeError = (message) => {
    try {
      stderr.write(`${message}\n`);
    } catch {
      // There is no fallback output channel if the supplied stderr itself fails.
    }
  };

  let parsed;
  try {
    parsed = parseReviewArgs(argv);
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (parsed.command === "report") {
    try {
      const loadEvidence = dependencies?.loadEvidence ?? loadReviewEvidence;
      const verifyEvidence = dependencies?.verifyEvidence ?? verifyReviewEvidence;
      const buildSelection = dependencies?.buildSelection ?? buildSelectionScript;
      const renderReport = dependencies?.renderReport ?? renderReviewReport;
      const writeReport = dependencies?.writeReport ?? writeReviewReport;
      const runDir = path.resolve(REPO_ROOT, parsed.runDir);
      const capturesIndexPath = path.resolve(REPO_ROOT, parsed.capturesIndexPath);
      const evidence = await loadEvidence({ runDir, capturesIndexPath });
      const result = await verifyEvidence({ evidence, requireSelections: false, production: false });

      if (!Object.hasOwn(VERIFY_EXIT_CODES, result?.status)) {
        writeError(`report verification returned unknown status: ${String(result?.status)}`);
        return 1;
      }
      if (!Array.isArray(result.errors) || !Array.isArray(result.gaps)) {
        writeError("report verification returned malformed result: errors and gaps must be arrays");
        return 1;
      }
      if (result.status === "invalid") {
        writeError(`report verification is invalid: ${result.errors.length} error(s), ${result.gaps.length} gap(s)`);
        return 1;
      }

      const verifiedModel = result.verifiedModel;
      if (verifiedModel === null || verifiedModel === undefined) {
        writeError(`report verification ${result.status} did not provide verifiedModel`);
        return 1;
      }
      if (typeof evidence?.run?.dir !== "string" || evidence.run.dir.trim() === "") {
        writeError("loaded evidence is missing its verified run directory");
        return 1;
      }

      const selectionScript = await buildSelection(verifiedModel);
      const html = await renderReport({ verifiedModel, selectionScript });
      if (typeof html !== "string" || html.trim() === "")
        throw new TypeError("renderReport must return non-empty HTML");
      const reportPath = await writeReport({ runDir: evidence.run.dir, html });
      if (typeof reportPath !== "string" || !path.isAbsolute(reportPath)) {
        throw new TypeError("writeReport must return an absolute report path");
      }

      if (result.status !== "pass" || result.errors.length > 0 || result.gaps.length > 0) {
        writeError(
          `warning: report generated with status=${result.status}, errors=${result.errors.length}, gaps=${result.gaps.length}; see report diagnostics`,
        );
      }
      stdout.write(`${JSON.stringify({ status: result.status, reportPath })}\n`);
      return 0;
    } catch (error) {
      writeError(`report failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (parsed.command === "serve") {
    const loadCandidate = dependencies?.loadCandidate ?? loadPreviewCandidate;
    const fixtureFactory = dependencies?.fixtureFactory ?? createPaletteFixture;
    const startPreview = dependencies?.startPreview ?? startCandidatePreview;
    const signalSource = dependencies?.signalSource ?? process;
    const listeners = [];
    let fixture = null;
    let preview = null;
    let previewCloseFailed = false;
    let failed = false;
    let stopCode = null;
    let resolveStop;
    const stopRequested = new Promise((resolve) => {
      resolveStop = resolve;
    });
    const handleSignal = (code) => () => {
      if (stopCode === null) {
        stopCode = code;
        resolveStop(code);
      }
    };

    try {
      if (!signalSource || typeof signalSource.on !== "function" || typeof signalSource.removeListener !== "function") {
        throw new TypeError("signalSource must provide on() and removeListener()");
      }
      for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ]) {
        const listener = handleSignal(code);
        signalSource.on(signal, listener);
        listeners.push([signal, listener]);
      }

      if (stopCode === null) {
        const candidate = await loadCandidate({
          runDir: path.resolve(REPO_ROOT, parsed.runDir),
          candidateId: parsed.candidateId,
        });
        if (stopCode === null) {
          fixture = await fixtureFactory();
          if (stopCode === null) {
            preview = await startPreview({ candidate, fixture, port: 0, maxConcurrent: 1 });
            if (!preview || typeof preview.close !== "function") {
              throw new TypeError("startPreview must return an instance with close()");
            }
            if (stopCode === null) {
              if (typeof preview.url !== "string" || preview.url.trim() === "") {
                throw new TypeError("startPreview must return a non-empty URL");
              }
              stdout.write(
                `${JSON.stringify({ command: "serve", candidateId: parsed.candidateId, url: preview.url })}\n`,
              );
              await stopRequested;
            }
          }
        }
      }
    } catch (error) {
      failed = true;
      writeError(`serve failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (preview) {
        if (typeof preview.close !== "function") {
          failed = true;
          previewCloseFailed = true;
          writeError(
            "serve preview close failed; fixture was retained because the preview may still be using it, and the caller must clean it up after stopping the preview: preview.close() is unavailable",
          );
        } else {
          try {
            await preview.close();
          } catch (error) {
            failed = true;
            previewCloseFailed = true;
            writeError(
              `serve preview close failed; fixture was retained because the preview may still be using it, and the caller must clean it up after stopping the preview: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      if (fixture && !previewCloseFailed) {
        if (typeof fixture.close !== "function") {
          failed = true;
          writeError(
            "serve fixture close failed; fixture cleanup remains the caller's responsibility: fixture.close() is unavailable",
          );
        } else {
          try {
            await fixture.close();
          } catch (error) {
            failed = true;
            writeError(
              `serve fixture close failed; fixture cleanup remains the caller's responsibility: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      for (const [signal, listener] of listeners) {
        try {
          signalSource.removeListener(signal, listener);
        } catch (error) {
          failed = true;
          writeError(
            `serve could not remove ${signal} listener: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return failed ? 1 : (stopCode ?? 1);
  }

  if (parsed.command === "capture") {
    if (parsed.production) {
      return runProductionCaptureCommand({ parsed, dependencies, stdout, writeError });
    }
    try {
      const adapter = dependencies?.captureAdapter ?? (await import("./review-capture.mjs"));
      const runDir = path.resolve(REPO_ROOT, parsed.runDir);
      const outDir = path.resolve(REPO_ROOT, parsed.outDir);
      const capture = await adapter.runReviewCapture({ runDir, candidateId: parsed.candidateId, outDir });
      if (!isPlainObject(capture)) {
        throw new TypeError("runReviewCapture returned a malformed result");
      }
      for (const key of ["candidateId", "candidateHash", "captureResult"]) {
        if (!Object.hasOwn(capture, key)) throw new TypeError(`runReviewCapture result is missing ${key}`);
      }
      if (capture.candidateId !== parsed.candidateId) {
        throw new TypeError("runReviewCapture returned a different candidate ID");
      }
      if (typeof capture.candidateHash !== "string" || capture.candidateHash.trim() === "") {
        throw new TypeError("runReviewCapture returned a missing candidate hash");
      }
      if (!isPlainObject(capture.captureResult)) {
        throw new TypeError("runReviewCapture returned a malformed captureResult");
      }
      const candidateHash = capture.candidateHash;
      const captureResult = capture.captureResult;
      const classification = await adapter.classifyReviewCapture({
        candidateId: parsed.candidateId,
        candidateHash,
        captureResult,
      });
      if (!isPlainObject(classification)) {
        throw new TypeError("classifyReviewCapture returned a malformed result");
      }
      for (const key of ["status", "exitCode", "errors", "gaps"]) {
        if (!Object.hasOwn(classification, key)) throw new TypeError(`classifyReviewCapture result is missing ${key}`);
      }
      const expectedExitCode = { captured: 0, failed: 2, incomplete: 2 };
      if (!Object.hasOwn(expectedExitCode, classification.status)) {
        throw new TypeError(`classifyReviewCapture returned unknown status: ${String(classification.status)}`);
      }
      if (!Array.isArray(classification.errors) || !Array.isArray(classification.gaps)) {
        throw new TypeError("classifyReviewCapture errors and gaps must be arrays");
      }
      if (classification.exitCode !== expectedExitCode[classification.status]) {
        throw new TypeError("classifyReviewCapture returned an exit code inconsistent with its status");
      }
      if (
        (classification.status === "captured" &&
          (classification.errors.length > 0 || classification.gaps.length > 0)) ||
        (classification.status === "failed" && classification.errors.length === 0) ||
        (classification.status === "incomplete" &&
          (classification.errors.length > 0 || classification.gaps.length === 0))
      ) {
        throw new TypeError("classifyReviewCapture status is inconsistent with its diagnostics");
      }

      const shard = await adapter.writeReviewCaptureIndexShard({
        runDir,
        candidateId: parsed.candidateId,
        candidateHash,
        captureResult,
      });
      if (!isPlainObject(shard)) {
        throw new TypeError("writeReviewCaptureIndexShard returned a malformed result");
      }
      if (!Object.hasOwn(shard, "shardPath") || typeof shard.shardPath !== "string" || shard.shardPath.trim() === "") {
        throw new TypeError("writeReviewCaptureIndexShard must return a non-empty shardPath");
      }

      stdout.write(
        `${JSON.stringify({
          command: "capture",
          candidateId: parsed.candidateId,
          candidateHash,
          status: classification.status,
          errors: classification.errors,
          gaps: classification.gaps,
          indexShardPath: shard.shardPath,
        })}\n`,
      );
      return expectedExitCode[classification.status];
    } catch (error) {
      writeError(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (parsed.command !== "verify") {
    writeError(`${parsed.command} is not wired yet`);
    return 1;
  }

  try {
    const loadEvidence = dependencies?.loadEvidence ?? loadReviewEvidence;
    const runDir = path.resolve(REPO_ROOT, parsed.runDir);
    const capturesIndexPath = path.join(runDir, "captures-index.json");
    const evidence = await loadEvidence({ runDir, capturesIndexPath });

    if (parsed.production) {
      const verifyProductionEvidence =
        dependencies?.verifyProductionEvidence ??
        (await import("./review-production.mjs")).verifyProductionReviewEvidence;
      const result = await verifyProductionEvidence({
        manifestRunDir: runDir,
        evidence,
        capturesIndexPath: path.join(runDir, "production-captures-index.json"),
      });
      const productionExitCodes = { pass: 0, incomplete: 2, rejected: 2 };

      if (!isPlainObject(result)) {
        writeError("production verify returned a malformed result: expected an object");
        return 1;
      }
      if (!Object.hasOwn(result, "status") || !Object.hasOwn(productionExitCodes, result.status)) {
        writeError(`production verify returned an invalid status: ${String(result.status)}`);
        return 1;
      }
      if (!Object.hasOwn(result, "exitCode") || result.exitCode !== productionExitCodes[result.status]) {
        writeError(`production verify returned an exit code inconsistent with status ${result.status}`);
        return 1;
      }
      if (
        !Object.hasOwn(result, "errors") ||
        !Object.hasOwn(result, "gaps") ||
        !Array.isArray(result.errors) ||
        !Array.isArray(result.gaps)
      ) {
        writeError("production verify returned malformed result: errors and gaps must be arrays");
        return 1;
      }
      if (result.status === "pass" && (result.errors.length > 0 || result.gaps.length > 0)) {
        writeError("production verify returned pass with diagnostics");
        return 1;
      }

      stdout.write(`${JSON.stringify({ status: result.status, errors: result.errors, gaps: result.gaps })}\n`);
      return productionExitCodes[result.status];
    }

    const verifyEvidence = dependencies?.verifyEvidence ?? verifyReviewEvidence;
    const result = await verifyEvidence({
      evidence,
      requireSelections: parsed.requireSelections,
      production: false,
    });

    if (!Object.hasOwn(VERIFY_EXIT_CODES, result?.status)) {
      writeError(`verify returned unknown status: ${String(result?.status)}`);
      return 1;
    }
    if (!Array.isArray(result.errors) || !Array.isArray(result.gaps)) {
      writeError("verify returned malformed result: errors and gaps must be arrays");
      return 1;
    }

    stdout.write(`${JSON.stringify({ status: result.status, errors: result.errors, gaps: result.gaps })}\n`);
    return VERIFY_EXIT_CODES[result.status];
  } catch (error) {
    writeError(`verify failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runReviewCommand(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      try {
        process.stderr.write(
          `skin-palette review CLI failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } catch {
        // Preserve the failure exit code even if stderr itself is unavailable.
      }
      process.exitCode = 1;
    },
  );
}
