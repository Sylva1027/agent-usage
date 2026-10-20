import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

import { enumerateSourceAssets } from "../public/skins.js";
import {
  GENERATED_ASSET_TOOL_FILES,
  readProductionCurrentSources,
  readProductionGeneratedAssets,
} from "../scripts/skin-palette/review-production.mjs";
import { SOURCE_FILES, STATE_MATRIX_GROUPS } from "../scripts/skin-palette/capture.mjs";
import { buildProductionPaletteSource } from "../scripts/skin-palette/production-palette-source.mjs";
import { buildProductionPickerSource } from "../scripts/skin-palette/production-picker-source.mjs";
import { buildProductionBootstrapSource } from "../scripts/skin-palette/production-bootstrap-source.mjs";
import { assertProductionSourceManifest } from "../scripts/skin-palette/production-source-manifest.mjs";
import { createSelectionExport } from "../scripts/skin-palette/review-selection.mjs";
import { REPO_ROOT } from "../scripts/skin-palette/review-evidence.mjs";
import { verifyReviewEvidence } from "../scripts/skin-palette/review-verify.mjs";
import { SKIN_IDS, sha256Canonical } from "../scripts/skin-palette/contracts.mjs";
import {
  HISTORICAL_SOURCE_FILES,
  REAL_SOURCE_HASHES,
  buildRun,
  load,
  makeCandidate,
  makeCandidateSet,
  realAssessment,
  sha256,
  writeJson,
} from "../test-support/skin-palette-review-evidence-fixture.mjs";

const execFile = promisify(execFileCallback);
const FIXTURE_PREFIX = "m4-4-7-e1-i1-";
const ORIGINAL_PUBLIC_THREE = ["public/skin-palettes.js", "public/skin-picker.js", "public/skin-bootstrap.js"];

function execFileWithExitCode(file, args, options) {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function repoRelative(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function assertStrictChild(parent, child, label) {
  const relative = path.relative(parent, child);
  assert.notEqual(relative, "", `${label} must be a strict child`);
  assert.ok(!path.isAbsolute(relative), `${label} must remain under its parent`);
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`), `${label} must remain under its parent`);
}

async function copyExactFile(sandboxRoot, relativePath, copiedHashes) {
  const sourcePath = path.resolve(REPO_ROOT, relativePath);
  const targetPath = path.resolve(sandboxRoot, relativePath);
  assertStrictChild(sandboxRoot, targetPath, `copy target ${relativePath}`);
  const bytes = await readFile(sourcePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (copiedHashes.has(relativePath)) {
    assert.equal(copiedHashes.get(relativePath), sha256(bytes), `${relativePath} has one original byte source`);
  }
  await writeFile(targetPath, bytes);
  copiedHashes.set(relativePath, sha256(bytes));
  return bytes;
}

async function copyDirectoryBytes(sourceDir, sandboxRoot, relativeDir, copiedHashes) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    const sourcePath = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryBytes(sourcePath, sandboxRoot, relativePath, copiedHashes);
    } else if (entry.isFile()) {
      await copyExactFile(sandboxRoot, relativePath, copiedHashes);
    } else {
      throw new TypeError(`refusing to copy non-regular source entry: ${relativePath}`);
    }
  }
}

async function copyStaticModuleGraph(sandboxRoot, entry, copiedHashes, seen = new Set()) {
  const absolutePath = path.resolve(REPO_ROOT, entry);
  const relativePath = repoRelative(REPO_ROOT, absolutePath);
  if (seen.has(relativePath)) return;
  seen.add(relativePath);
  const bytes = await copyExactFile(sandboxRoot, relativePath, copiedHashes);
  const source = ts.createSourceFile(
    relativePath,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const dependencyPath = path.resolve(path.dirname(absolutePath), specifier);
    const dependencyRelative = repoRelative(REPO_ROOT, dependencyPath);
    await copyStaticModuleGraph(sandboxRoot, dependencyRelative, copiedHashes, seen);
  }
}

async function hashFiles(rootDir, paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (relativePath) => [
        relativePath,
        sha256(await readFile(path.join(rootDir, ...relativePath.split("/")))),
      ]),
    ),
  );
}

function assertAssetSnapshotEqual(before, after) {
  assert.equal(after.assetManifestSha256, before.assetManifestSha256);
  assert.deepEqual(after.sourceAssetHashes, before.sourceAssetHashes);
  assert.deepEqual(after.publicAssetHashes, before.publicAssetHashes);
  assert.deepEqual(after.toolHashes, before.toolHashes);
}

test("E1 clean-source branch runs C5c and both post checks in a copied validation sandbox", async (t) => {
  const startedAt = Date.now();
  const repoReal = await realpath(REPO_ROOT);
  const validationRoot = await realpath(path.join(repoReal, "docs", "validation"));
  const frozenPaths = [
    "scripts/skin-palette/production-index.mjs",
    "scripts/skin-palette/review-production.mjs",
    "scripts/skin-palette/review-cli.mjs",
    "scripts/skin-palette/production-palette-source.mjs",
    "scripts/skin-palette/production-picker-source.mjs",
    "scripts/skin-palette/production-bootstrap-source.mjs",
    "scripts/skin-palette/production-source-transition.mjs",
    "scripts/skin-palette/production-source-manifest.mjs",
    "test/skin-palette-review-production.test.js",
    "test/skin-palette-review-production-context.integration.test.js",
    "test-support/skin-palette-fixture.mjs",
    "test-support/skin-palette-review-evidence-fixture.mjs",
    ...ORIGINAL_PUBLIC_THREE,
  ];
  const projectBeforeHashes = await hashFiles(repoReal, frozenPaths);

  let fixtureRootPath = null;
  let fixtureRootReal = null;
  let summary = { phase: "sandbox preparation" };
  let assembledIndexConsumer = null;
  try {
    fixtureRootPath = await mkdtemp(path.join(validationRoot, FIXTURE_PREFIX));
    fixtureRootReal = await realpath(fixtureRootPath);
    assertStrictChild(validationRoot, fixtureRootReal, "fixtureRoot");
    assert.equal(path.dirname(fixtureRootReal), validationRoot, "fixtureRoot must be a direct validation child");

    const sandboxRoot = path.join(fixtureRootReal, "sandbox-repo");
    await mkdir(sandboxRoot);
    const copiedHashes = new Map();
    await copyDirectoryBytes(
      path.join(repoReal, "scripts", "skin-palette"),
      sandboxRoot,
      "scripts/skin-palette",
      copiedHashes,
    );
    await copyStaticModuleGraph(sandboxRoot, "src/server.js", copiedHashes);

    const assetRecords = enumerateSourceAssets();
    assert.equal(assetRecords.length, 40);
    const explicitFiles = new Set([
      ...SOURCE_FILES,
      ...GENERATED_ASSET_TOOL_FILES,
      "package.json",
      "biome.json",
      "scripts/prepare-skin-assets.mjs",
      "public/skin-assets.json",
      "test-support/skin-palette-fixture.mjs",
      ...assetRecords.flatMap(({ sourcePath, publicPath }) => [sourcePath, publicPath]),
    ]);
    for (const relativePath of [...explicitFiles].sort()) {
      await copyExactFile(sandboxRoot, relativePath, copiedHashes);
    }
    assert.equal(
      (await readFile(path.join(sandboxRoot, "package.json"))).equals(
        await readFile(path.join(repoReal, "package.json")),
      ),
      true,
    );
    await assert.rejects(access(path.join(sandboxRoot, ".git")));
    await assert.rejects(access(path.join(sandboxRoot, "node_modules")));
    // Exercise the migration against its actual pre-migration picker, not the already migrated product.
    const oldPicker = await readFile(path.join(repoReal, "test-support", "skin-picker-before-migration.txt"));
    await writeFile(path.join(sandboxRoot, "public", "skin-picker.js"), oldPicker);
    copiedHashes.set("public/skin-picker.js", sha256(oldPicker));
    const preSources = await readProductionCurrentSources({ rootDir: sandboxRoot });
    const preAssets = await readProductionGeneratedAssets({ rootDir: sandboxRoot });
    assert.equal(Object.keys(preSources.sourceHashes).length, SOURCE_FILES.length);
    assert.ok(Object.hasOwn(preSources.sourceHashes, "public/timeline-utils.js"));
    assert.deepEqual(
      preSources.sourceHashes,
      { ...REAL_SOURCE_HASHES, "public/skin-picker.js": sha256(oldPicker) },
      "sandbox source bytes match the ready fixture source inputs",
    );
    assert.equal(Object.keys(preAssets.sourceAssetHashes).length, 40);
    assert.equal(Object.keys(preAssets.publicAssetHashes).length, 40);

    const allowedRuns = new Set(["origin-run", "manifest-run"]);
    const box = {
      sandbox: sandboxRoot,
      async makeRun(name) {
        if (!allowedRuns.has(name)) throw new TypeError(`unexpected fixture run name: ${name}`);
        const runDir = path.join(sandboxRoot, "docs", "validation", name);
        assertStrictChild(sandboxRoot, runDir, `${name} run`);
        await mkdir(runDir, { recursive: true });
        return realpath(runDir);
      },
    };
    const candidates = SKIN_IDS.flatMap((skinId) =>
      ["a", "b", "c"].map((variant) => makeCandidate({ skinId, variant })),
    );
    const unselectedGapCandidate = candidates.find(
      (candidate) => candidate.skinId === SKIN_IDS[0] && candidate.variant === "b",
    );
    const missingCaptureUnit = STATE_MATRIX_GROUPS.flatMap(({ units }) => units).find(
      ({ kind }) => kind !== "baseline",
    );
    assert.ok(unselectedGapCandidate);
    assert.ok(missingCaptureUnit);
    const built = await buildRun(box, "origin-run", candidates, {
      origins: { currentProfiles: true },
      assessments: candidates.map((candidate) =>
        realAssessment(candidate, makeCandidateSet(candidates), null, preSources.sourceHashes),
      ),
      captureOptions: (candidate) => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...preSources.sourceHashes };
        },
        ...(candidate.id === unselectedGapCandidate.id ? { skipUnits: [`light/${missingCaptureUnit.id}`] } : {}),
      }),
    });
    const initialReview = await verifyReviewEvidence({
      evidence: built.evidence,
      sourceSnapshot: Object.fromEntries(HISTORICAL_SOURCE_FILES.map((file) => [file, preSources.sourceBytes[file]])),
    });
    assert.equal(initialReview.status, "incomplete", "one unselected b candidate has a real missing capture unit");
    assert.deepEqual(initialReview.errors, []);
    assert.ok(
      initialReview.gaps.some(
        (gap) => gap.code === "capture-unit-missing" && gap.candidateId === unselectedGapCandidate.id,
      ),
      "the historical review records the unselected b capture gap",
    );
    const verifiedModel = initialReview.verifiedModel;
    assert.ok(verifiedModel);
    assert.equal(verifiedModel.selectableCandidateIds.includes(unselectedGapCandidate.id), false);
    const choices = Object.fromEntries(
      SKIN_IDS.map((skinId) => {
        const candidate = verifiedModel.candidateSet.candidates.find(
          (item) => item.skinId === skinId && item.variant === "a",
        );
        assert.ok(candidate, `ready candidate exists for ${skinId}`);
        assert.ok(verifiedModel.selectableCandidateIds.includes(candidate.id));
        return [skinId, { candidateId: candidate.id, candidateHash: candidate.candidateHash }];
      }),
    );
    const exportedSelection = createSelectionExport({
      verifiedModel,
      choices,
      decisionSource: "E1-I1 isolated synthetic integration; not a visual decision",
      recordedAt: "2026-10-10T00:00:00.000Z",
    });
    const originRunDir = built.runDir;
    await writeJson(path.join(originRunDir, "assessments.json"), verifiedModel.container);
    await writeJson(path.join(originRunDir, "selections.json"), exportedSelection.record);
    const evidence = await load(box, originRunDir, path.join(originRunDir, "captures-index.json"));
    assert.equal(evidence.selections.present, true);
    assert.deepEqual(evidence.selections.record, exportedSelection.record);

    const manifestRunDir = await box.makeRun("manifest-run");
    const sourcePreimages = Object.fromEntries(
      HISTORICAL_SOURCE_FILES.map((file) => [
        file,
        { path: `source-before/${file}`, sha256: preSources.sourceHashes[file] },
      ]),
    );
    for (const file of HISTORICAL_SOURCE_FILES) {
      const bytes = preSources.sourceBytes[file];
      assert.ok(Buffer.isBuffer(bytes));
      assert.equal(sha256(bytes), preSources.sourceHashes[file]);
      const preimagePath = path.join(manifestRunDir, "source-before", ...file.split("/"));
      assertStrictChild(fixtureRootReal, preimagePath, `preimage ${file}`);
      await mkdir(path.dirname(preimagePath), { recursive: true });
      await writeFile(preimagePath, bytes);
    }
    const precheck = {
      schemaVersion: 1,
      sourceHashes: { ...preSources.sourceHashes },
      sourcePreimages,
      selectionRollback: { reservedForM6: true },
      generatedAssets: {
        assetManifestSha256: preAssets.assetManifestSha256,
        sourceAssetHashes: { ...preAssets.sourceAssetHashes },
        publicAssetHashes: { ...preAssets.publicAssetHashes },
      },
    };
    const precheckBytes = Buffer.from(`${JSON.stringify(precheck)}\n`, "utf8");
    await writeFile(path.join(manifestRunDir, "integration-precheck.json"), precheckBytes);
    const precheckFileSha256 = sha256(precheckBytes);

    const candidateSetBytes = await readFile(path.join(originRunDir, "candidates.json"));
    const assessmentBytes = await readFile(path.join(originRunDir, "assessments.json"));
    const selectionBytes = await readFile(path.join(originRunDir, "selections.json"));
    const indexBytes = await readFile(path.join(originRunDir, "captures-index.json"));
    const candidateSet = JSON.parse(candidateSetBytes.toString("utf8"));
    const assessmentContainer = JSON.parse(assessmentBytes.toString("utf8"));
    const selectionRecord = JSON.parse(selectionBytes.toString("utf8"));
    assert.equal(candidateSet.candidateSetHash, verifiedModel.candidateSet.candidateSetHash);
    assert.equal(assessmentContainer.assessmentHash, verifiedModel.container.assessmentHash);
    assert.deepEqual(selectionRecord, exportedSelection.record);

    const captureRecords = {};
    for (const candidate of candidateSet.candidates) {
      const capturePath = path.join(originRunDir, "captures", candidate.id, "capture.json");
      const captureBytes = await readFile(capturePath);
      const capture = JSON.parse(captureBytes.toString("utf8"));
      assert.deepEqual(Object.keys(capture.sourceHashes), Object.keys(preSources.sourceHashes));
      captureRecords[candidate.id] = {
        capturePath: path.posix.join(repoRelative(sandboxRoot, originRunDir), "captures", candidate.id, "capture.json"),
        fileSha256: sha256(captureBytes),
        sourceHashesHash: sha256Canonical(capture.sourceHashes),
      };
    }
    const originRunRelative = repoRelative(sandboxRoot, originRunDir);

    const selectedBytes = {
      "public/skin-palettes.js": buildProductionPaletteSource({
        beforeSource: preSources.sourceBytes["public/skin-palettes.js"],
        verifiedModel,
        selections: selectionRecord,
      }),
      "public/skin-picker.js": buildProductionPickerSource({
        beforeSource: preSources.sourceBytes["public/skin-picker.js"],
      }),
      "public/skin-bootstrap.js": buildProductionBootstrapSource({ verifiedModel, selections: selectionRecord }),
    };
    for (const [relativePath, bytes] of Object.entries(selectedBytes)) {
      assert.ok(Buffer.isBuffer(bytes), `${relativePath} constructor returns complete bytes`);
      await writeFile(path.join(sandboxRoot, ...relativePath.split("/")), bytes);
    }

    const afterSources = await readProductionCurrentSources({ rootDir: sandboxRoot });
    const afterAssets = await readProductionGeneratedAssets({ rootDir: sandboxRoot });
    for (const file of SOURCE_FILES.filter((entry) => !Object.hasOwn(selectedBytes, entry))) {
      assert.deepEqual(afterSources.sourceBytes[file], preSources.sourceBytes[file], `${file} remains byte-identical`);
    }
    assertAssetSnapshotEqual(preAssets, afterAssets);
    for (const file of Object.keys(selectedBytes)) {
      assert.deepEqual(
        afterSources.sourceBytes[file],
        selectedBytes[file],
        `${file} contains exact constructor output`,
      );
    }

    const manifest = {
      schemaVersion: 1,
      kind: "skin-palette-production-source-manifest",
      origin: {
        runDir: originRunRelative,
        candidateCapturesIndex: {
          path: path.posix.join(originRunRelative, "captures-index.json"),
          fileSha256: sha256(indexBytes),
        },
        candidateSet: {
          path: "candidates.json",
          fileSha256: sha256(candidateSetBytes),
          candidateSetHash: candidateSet.candidateSetHash,
        },
        assessment: {
          path: "assessments.json",
          fileSha256: sha256(assessmentBytes),
          assessmentHash: assessmentContainer.assessmentHash,
        },
        selections: {
          path: "selections.json",
          fileSha256: sha256(selectionBytes),
          recordHash: sha256Canonical(selectionRecord),
        },
        captureRecords,
      },
      preMigration: {
        precheck: { path: "integration-precheck.json", fileSha256: precheckFileSha256 },
      },
      after: {
        sourceHashes: { ...afterSources.sourceHashes },
        generatedAssets: {
          assetManifestSha256: afterAssets.assetManifestSha256,
          sourceAssetHashes: { ...afterAssets.sourceAssetHashes },
          publicAssetHashes: { ...afterAssets.publicAssetHashes },
        },
        toolHashes: { ...afterAssets.toolHashes },
      },
    };
    assert.equal(assertProductionSourceManifest({ manifest, candidateSet }), undefined);
    await writeJson(path.join(manifestRunDir, "production-source-manifest.json"), manifest);

    const formalIndexPath = path.join(originRunDir, "production-captures-index.json");
    const formalIndexPlaceholderBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, captures: {} })}\n`);
    await writeJson(formalIndexPath, { schemaVersion: 1, captures: {} });
    const childSource = `
      import assert from "node:assert/strict";
      import { createHash } from "node:crypto";
      import { access, readFile, realpath, readdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const [root, originRun, manifestRun, formalIndex] = process.argv.slice(1);
      const evidenceModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/review-evidence.mjs")));
      const productionModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/review-production.mjs")));
      const captureModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/review-capture.mjs")));
      const { buildFixedMatrixFixtureBindings } = await import(pathToFileURL(path.join(root, "scripts/skin-palette/capture.mjs")));
      const contractsModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/contracts.mjs")));
      const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const evidence = await evidenceModule.loadReviewEvidence({ runDir: originRun, capturesIndexPath: path.join(originRun, "captures-index.json") });
      const result = await productionModule.verifyProductionReviewEvidence({ manifestRunDir: manifestRun, evidence, capturesIndexPath: formalIndex });
      const source = result.sourceResult;
      const production = result.productionResult;
      assert.equal(source.status, "pass");
      assert.deepEqual(source.errors, []);
      assert.deepEqual(source.gaps, []);
      const verifiedModel = source.historicalContext.historicalEvidence.historicalResult.verifiedModel;
      const selections = evidence.selections.record;
      const skinId = contractsModule.SKIN_IDS[0];
      const historicalResult = source.historicalContext.historicalEvidence.historicalResult;
      const unselectedGapCandidate = evidence.candidateSet.data.candidates.find(
        (candidate) => candidate.skinId === skinId && candidate.variant === "b",
      );
      assert.equal(historicalResult.status, "incomplete");
      assert.deepEqual(historicalResult.errors, []);
      assert.ok(unselectedGapCandidate);
      assert.ok(historicalResult.gaps.some(
        (gap) => gap.code === "capture-unit-missing" && gap.candidateId === unselectedGapCandidate.id,
      ));
      assert.equal(verifiedModel.selectableCandidateIds.includes(unselectedGapCandidate.id), false);
      assert.equal(source.currentContext.selectedCandidates.length, contractsModule.SKIN_IDS.length);
      assert.ok(source.currentContext.selectedCandidates.every(
        ({ candidate }) => verifiedModel.selectableCandidateIds.includes(candidate.id),
      ));
      const candidateId = selections.choices[skinId].candidateId;
      const formalOutDir = path.join(originRun, "formal-single");
      const candidateIndexPath = path.join(originRun, "captures-index.json");
      const candidateIndexBefore = await readFile(candidateIndexPath);
      const formalIndexBefore = await readFile(formalIndex);
      let fixtureRoot = null;
      const syntheticMatrixCapture = async ({ candidate, skinId: captureSkinId, fixture, timelineWarningFixture, outDir, modes }) => {
        assert.equal(candidate, null, "formal capture must not pass candidate colors into the matrix executor");
        assert.equal(captureSkinId, skinId);
        assert.equal(outDir, formalOutDir);
        assert.deepEqual(modes, ["light", "dark"]);
        assert.ok(fixture && typeof fixture.close === "function", "default real fixture is owned by the lifecycle");
        const fixtureHome = await realpath(fixture.homeDir);
        fixtureRoot = path.dirname(fixtureHome);
        assert.equal(await realpath(fixtureRoot), fixtureRoot);
        await Promise.all([access(fixtureHome), access(fixture.importStoreFile), access(fixture.pickedPath)]);
        assert.deepEqual(await readdir(outDir), [], "formal-single starts as a new empty output directory");
        const modeResults = {
          light: { status: "incomplete", reason: "isolated synthetic no-browser capture" },
          dark: { status: "incomplete", reason: "isolated synthetic no-browser capture" },
        };
        const groups = ["S0"];
        const fixtureHash = fixture.fixtureHash;
        const fixtureBindings = buildFixedMatrixFixtureBindings({
          groups,
          fixtureHash,
          warningFixtureHash: timelineWarningFixture.fixtureHash,
        });
        const captureRecord = {
          schemaVersion: 1,
          kind: "skin-palette-capture-matrix",
          candidate: { production: true, skinId },
          groups,
          fixtureHash,
          fixtureBindings,
          modes: structuredClone(modeResults),
        };
        const progressRecord = {
          groups: [...groups],
          modes: Object.keys(modeResults),
          digests: { fixtureHash, fixtureBindings: structuredClone(fixtureBindings) },
          units: {},
          attempts: [],
        };
        await writeFile(path.join(outDir, "capture.json"), JSON.stringify(captureRecord) + "\\n", "utf8");
        await writeFile(path.join(outDir, "progress.json"), JSON.stringify(progressRecord) + "\\n", "utf8");
        return { outDir, skinId, modes: modeResults, capture: captureRecord, progress: progressRecord };
      };
      const captured = await productionModule.runProductionCapture({
        runDir: originRun,
        verifiedModel,
        selections,
        candidateId,
        outDir: formalOutDir,
        captureFn: syntheticMatrixCapture,
      });
      assert.equal(captured.candidateId, candidateId);
      assert.equal(captured.selectionBinding.skinId, skinId);
      assert.equal(captured.captureResult.modes.light.status, "incomplete");
      assert.equal(captured.captureResult.modes.dark.status, "incomplete");
      assert.ok(fixtureRoot, "capture executor recorded the real fixture path");
      await assert.rejects(access(fixtureRoot), { code: "ENOENT" }, "default fixture closes in the capture finally");

      const classification = await captureModule.classifyProductionCapture({ skinId, captureResult: captured.captureResult });
      assert.equal(classification.status, "incomplete");
      assert.equal(classification.exitCode, 2);
      assert.deepEqual(classification.errors, []);
      assert.ok(classification.gaps.length > 0);
      const originPost = await productionModule.verifyProductionOriginStability({
        manifestRunDir: manifestRun,
        evidence,
        historicalContext: source.historicalContext,
      });
      const currentPost = await productionModule.verifyProductionCurrentStability({
        currentSources: source.currentContext.currentSources,
        currentAssets: source.currentContext.currentAssets,
      });
      assert.equal(originPost.status, "pass");
      assert.deepEqual(originPost.errors, []);
      assert.deepEqual(originPost.gaps, []);
      assert.equal(currentPost.status, "pass");
      assert.deepEqual(currentPost.errors, []);
      assert.deepEqual(currentPost.gaps, []);

      const bindingResult = await productionModule.writeProductionCaptureBinding({
        runDir: originRun,
        verifiedModel,
        selections,
        candidateId,
        captureResult: captured.captureResult,
      });
      const shardResult = await productionModule.writeProductionCaptureIndexShard({
        runDir: originRun,
        outDir: formalOutDir,
        verifiedModel,
        selections,
        candidateId,
      });
      const captureBytes = await readFile(path.join(formalOutDir, "capture.json"));
      const progressBytes = await readFile(path.join(formalOutDir, "progress.json"));
      const bindingBytes = await readFile(bindingResult.bindingPath);
      const shardBytes = await readFile(shardResult.shardPath);
      const candidateBytes = await readFile(path.join(originRun, "candidates.json"));
      const relativeCapturePath = path.relative(originRun, formalOutDir).split(path.sep).join("/");
      assert.equal(bindingResult.binding.captureFileSha256, sha256(captureBytes));
      assert.equal(bindingResult.binding.progressFileSha256, sha256(progressBytes));
      assert.equal(bindingResult.binding.candidateFileSha256, sha256(candidateBytes));
      assert.equal(bindingResult.binding.selectionHash, contractsModule.sha256Canonical(selections));
      assert.deepEqual(bindingResult.binding.selectionBinding, captured.selectionBinding);
      assert.deepEqual(JSON.parse(bindingBytes.toString("utf8")), bindingResult.binding);
      assert.deepEqual(shardResult.index, { schemaVersion: 1, captures: { [skinId]: relativeCapturePath } });
      assert.deepEqual(JSON.parse(shardBytes.toString("utf8")), shardResult.index);
      const readBack = await productionModule.readProductionCaptureBinding({
        runDir: originRun,
        outDir: formalOutDir,
        verifiedModel,
        selections,
        candidateId,
      });
      assert.deepEqual(readBack.binding, bindingResult.binding);
      assert.deepEqual(readBack.captureResult.capture, captured.captureResult.capture);
      assert.deepEqual(readBack.captureResult.progress, captured.captureResult.progress);
      assert.deepEqual(await readFile(candidateIndexPath), candidateIndexBefore);
      assert.deepEqual(await readFile(formalIndex), formalIndexBefore);
      const formalCapture = {
        skinId,
        candidateId,
        status: classification.status,
        exitCode: classification.exitCode,
        errorCount: classification.errors.length,
        gapCount: classification.gaps.length,
        originPostStatus: originPost.status,
        currentPostStatus: currentPost.status,
        executorCandidateWasNull: true,
        modes: ["light", "dark"],
        outDir: path.relative(root, formalOutDir).split(path.sep).join("/"),
        bindingPath: path.relative(root, bindingResult.bindingPath).split(path.sep).join("/"),
        bindingSha256: sha256(bindingBytes),
        captureFileSha256: bindingResult.binding.captureFileSha256,
        progressFileSha256: bindingResult.binding.progressFileSha256,
        shardPath: path.relative(root, shardResult.shardPath).split(path.sep).join("/"),
        shardSha256: sha256(shardBytes),
        shardRelativePath: shardResult.index.captures[skinId],
        fixtureRoot,
        fixtureRemoved: true,
        candidateIndexUnchanged: true,
        formalIndexUnchanged: true,
        readBackMatches: true,
      };
      console.log(JSON.stringify({
        repoRoot: evidenceModule.REPO_ROOT,
        status: result.status,
        exitCode: result.exitCode,
        errors: result.errors,
        gaps: result.gaps,
        sourceResult: {
          status: source?.status,
          errors: source?.errors,
          gaps: source?.gaps,
          historicalStatus: historicalResult.status,
          historicalErrorCount: historicalResult.errors.length,
          historicalGapCount: historicalResult.gaps.length,
          unselectedGapCandidateId: unselectedGapCandidate.id,
          unselectedGapRecorded: historicalResult.gaps.some(
            (gap) => gap.code === "capture-unit-missing" && gap.candidateId === unselectedGapCandidate.id,
          ),
          sourceTransition: source?.currentContext?.sourceTransition?.status ?? null,
          assetTransition: source?.currentContext?.assetTransition?.status ?? null,
          originStability: source?.originStability,
          currentStability: source?.currentStability,
        },
        productionResult: production && {
          status: production.status,
          exitCode: production.exitCode,
          results: production.results.length,
          errors: production.errors,
          gaps: production.gaps,
        },
        postOriginStability: result.postOriginStability,
        postCurrentStability: result.postCurrentStability,
        formalCapture,
      }));
    `;
    const child = await execFile(
      process.execPath,
      ["--input-type=module", "-e", childSource, sandboxRoot, originRunDir, manifestRunDir, formalIndexPath],
      { cwd: sandboxRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    const result = JSON.parse(child.stdout.trim());
    const assembleFormalIndex = async () => {
      assert.deepEqual(await readFile(formalIndexPath), formalIndexPlaceholderBytes);
      await unlink(formalIndexPath);
      const formalShardPath = path.join(originRunDir, "formal-single", "production-index-shard.json");
      const assemblyChildSource = `
      import { createHash } from "node:crypto";
      import { readFile } from "node:fs/promises";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const [root, runDir, shardPath] = process.argv.slice(1);
      const evidenceModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/review-evidence.mjs")));
      const indexModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/production-index.mjs")));
      const contractsModule = await import(pathToFileURL(path.join(root, "scripts/skin-palette/contracts.mjs")));
      const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const startedAt = Date.now();
      const result = await indexModule.assembleProductionCaptureIndex({ runDir, shardPaths: [shardPath] });
      const historicalResult = result.sourceResult.historicalContext.historicalEvidence.historicalResult;
      const skinId = Object.keys(result.indexResult.index.captures)[0];
      const unselectedGapCandidate = historicalResult.verifiedModel.candidateSet.candidates.find(
        (candidate) => candidate.skinId === skinId && candidate.variant === "b",
      );
      const unselectedBGapRecorded = unselectedGapCandidate !== undefined && historicalResult.gaps.some(
        (gap) => gap.code === "capture-unit-missing" && gap.candidateId === unselectedGapCandidate.id,
      );
      const selectedCandidates = result.sourceResult.currentContext.selectedCandidates;
      const selectedCandidatesValid = selectedCandidates.length === contractsModule.SKIN_IDS.length &&
        selectedCandidates.every(({ candidate }) =>
          historicalResult.verifiedModel.selectableCandidateIds.includes(candidate.id),
        );
      assert.equal(historicalResult.status, "incomplete");
      assert.deepEqual(historicalResult.errors, []);
      assert.ok(unselectedBGapRecorded);
      assert.ok(selectedCandidatesValid);
      const indexBytes = await readFile(path.join(runDir, "production-captures-index.json"));
      const shardBytes = await readFile(shardPath);
      console.log(JSON.stringify({
        repoRoot: evidenceModule.REPO_ROOT,
        status: result.status,
        exitCode: result.exitCode,
        errorCount: result.errors.length,
        gapCount: result.gaps.length,
        sourceStatus: result.sourceResult.status,
        historicalStatus: historicalResult.status,
        historicalGapCount: historicalResult.gaps.length,
        unselectedBGapRecorded,
        selectedCandidatesValid,
        indexCreated: result.indexResult?.created ?? false,
        indexCaptures: result.indexResult?.index?.captures ?? null,
        indexFileSha256: result.indexResult?.fileSha256 ?? null,
        indexBytesSha256: sha256(indexBytes),
        shardSha256: sha256(shardBytes),
        postOriginStatus: result.postOriginStability?.status ?? null,
        postCurrentStatus: result.postCurrentStability?.status ?? null,
        elapsedMs: Date.now() - startedAt,
      }));
    `;
      const assemblyChild = await execFile(
        process.execPath,
        ["--input-type=module", "-e", assemblyChildSource, sandboxRoot, originRunDir, formalShardPath],
        { cwd: sandboxRoot, maxBuffer: 1024 * 1024 },
      );
      assert.equal(assemblyChild.stderr, "");
      const assemblyLine = /^([^\r\n]+)\r?\n$/.exec(assemblyChild.stdout);
      assert.ok(assemblyLine, "assembler subprocess writes one bounded JSON summary line");
      const assembledIndex = JSON.parse(assemblyLine[1]);
      assert.deepEqual(Object.keys(assembledIndex), [
        "repoRoot",
        "status",
        "exitCode",
        "errorCount",
        "gapCount",
        "sourceStatus",
        "historicalStatus",
        "historicalGapCount",
        "unselectedBGapRecorded",
        "selectedCandidatesValid",
        "indexCreated",
        "indexCaptures",
        "indexFileSha256",
        "indexBytesSha256",
        "shardSha256",
        "postOriginStatus",
        "postCurrentStatus",
        "elapsedMs",
      ]);
      assert.equal(assembledIndex.repoRoot, sandboxRoot);
      assert.equal(assembledIndex.status, "assembled");
      assert.equal(assembledIndex.exitCode, 0);
      assert.equal(assembledIndex.errorCount, 0);
      assert.equal(assembledIndex.gapCount, 0);
      assert.equal(assembledIndex.sourceStatus, "pass");
      assert.equal(assembledIndex.historicalStatus, "incomplete");
      assert.ok(assembledIndex.historicalGapCount > 0);
      assert.equal(assembledIndex.unselectedBGapRecorded, true);
      assert.equal(assembledIndex.selectedCandidatesValid, true);
      assert.equal(assembledIndex.indexCreated, true);
      assert.deepEqual(assembledIndex.indexCaptures, { [SKIN_IDS[0]]: "formal-single" });
      assert.equal(assembledIndex.indexFileSha256, assembledIndex.indexBytesSha256);
      assert.equal(assembledIndex.shardSha256, result.formalCapture.shardSha256);
      assert.equal(assembledIndex.postOriginStatus, "pass");
      assert.equal(assembledIndex.postCurrentStatus, "pass");
      const assembledIndexBytes = await readFile(formalIndexPath);
      assert.deepEqual(JSON.parse(assembledIndexBytes.toString("utf8")), {
        schemaVersion: 1,
        captures: { [SKIN_IDS[0]]: "formal-single" },
      });
      return assembledIndex;
    };
    assert.equal(result.repoRoot, sandboxRoot);
    assert.equal(result.sourceResult.status, "pass", JSON.stringify(result.sourceResult, null, 2));
    assert.deepEqual(result.sourceResult.errors, []);
    assert.deepEqual(result.sourceResult.gaps, []);
    assert.equal(result.sourceResult.historicalStatus, "incomplete");
    assert.equal(result.sourceResult.historicalErrorCount, 0);
    assert.ok(result.sourceResult.historicalGapCount > 0);
    assert.equal(result.sourceResult.unselectedGapCandidateId, unselectedGapCandidate.id);
    assert.equal(result.sourceResult.unselectedGapRecorded, true);
    assert.equal(result.sourceResult.sourceTransition, "pass");
    assert.equal(result.sourceResult.assetTransition, "pass");
    assert.equal(result.sourceResult.originStability.status, "pass");
    assert.equal(result.sourceResult.currentStability.status, "pass");
    assert.equal(result.productionResult.status, "incomplete");
    assert.equal(result.productionResult.exitCode, 2);
    assert.equal(result.productionResult.results, 0);
    assert.deepEqual(result.productionResult.errors, []);
    assert.equal(result.productionResult.gaps.length, SKIN_IDS.length);
    assert.deepEqual(
      result.productionResult.gaps.map(({ skinId }) => skinId),
      SKIN_IDS,
    );
    assert.equal(result.postOriginStability.status, "pass");
    assert.deepEqual(result.postOriginStability.errors, []);
    assert.deepEqual(result.postOriginStability.gaps, []);
    assert.equal(result.postCurrentStability.status, "pass");
    assert.deepEqual(result.postCurrentStability.errors, []);
    assert.deepEqual(result.postCurrentStability.gaps, []);
    assert.equal(result.status, "incomplete");
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(result.gaps.length, SKIN_IDS.length);

    const formalCapture = result.formalCapture;
    const formalOutDir = path.join(originRunDir, "formal-single");
    assertStrictChild(fixtureRootReal, formalOutDir, "formal-single capture");
    assert.equal(formalCapture.skinId, SKIN_IDS[0]);
    assert.equal(formalCapture.candidateId, exportedSelection.record.choices[formalCapture.skinId].candidateId);
    assert.equal(formalCapture.status, "incomplete");
    assert.equal(formalCapture.exitCode, 2);
    assert.equal(formalCapture.errorCount, 0);
    assert.ok(formalCapture.gapCount > 0);
    assert.equal(formalCapture.originPostStatus, "pass");
    assert.equal(formalCapture.currentPostStatus, "pass");
    assert.equal(formalCapture.executorCandidateWasNull, true);
    assert.deepEqual(formalCapture.modes, ["light", "dark"]);
    assert.equal(formalCapture.outDir, repoRelative(sandboxRoot, formalOutDir));
    assert.equal(
      formalCapture.bindingPath,
      repoRelative(sandboxRoot, path.join(formalOutDir, "production-selection.json")),
    );
    assert.equal(
      formalCapture.shardPath,
      repoRelative(sandboxRoot, path.join(formalOutDir, "production-index-shard.json")),
    );
    assert.equal(formalCapture.shardRelativePath, path.relative(originRunDir, formalOutDir).split(path.sep).join("/"));
    assert.equal(formalCapture.candidateIndexUnchanged, true);
    assert.equal(formalCapture.formalIndexUnchanged, true);
    assert.equal(formalCapture.readBackMatches, true);
    assert.equal(formalCapture.fixtureRemoved, true);
    await assert.rejects(access(formalCapture.fixtureRoot), { code: "ENOENT" });
    const formalFiles = (await readdir(formalOutDir)).sort();
    assert.deepEqual(formalFiles, [
      "capture.json",
      "production-index-shard.json",
      "production-selection.json",
      "progress.json",
    ]);
    const formalCaptureBytes = await readFile(path.join(formalOutDir, "capture.json"));
    const formalProgressBytes = await readFile(path.join(formalOutDir, "progress.json"));
    const formalBindingBytes = await readFile(path.join(formalOutDir, "production-selection.json"));
    const formalShardBytes = await readFile(path.join(formalOutDir, "production-index-shard.json"));
    const formalBinding = JSON.parse(formalBindingBytes.toString("utf8"));
    const formalShard = JSON.parse(formalShardBytes.toString("utf8"));
    assert.equal(formalBinding.captureFileSha256, sha256(formalCaptureBytes));
    assert.equal(formalBinding.progressFileSha256, sha256(formalProgressBytes));
    assert.equal(formalBinding.candidateFileSha256, sha256(await readFile(path.join(originRunDir, "candidates.json"))));
    assert.equal(formalBinding.selectionHash, sha256Canonical(exportedSelection.record));
    assert.equal(formalBinding.selectionBinding.candidateId, formalCapture.candidateId);
    assert.equal(
      formalBinding.selectionBinding.candidateHash,
      exportedSelection.record.choices[formalCapture.skinId].candidateHash,
    );
    assert.equal(formalBinding.selectionBinding.skinId, formalCapture.skinId);
    assert.deepEqual(formalShard, {
      schemaVersion: 1,
      captures: { [formalCapture.skinId]: formalCapture.shardRelativePath },
    });

    for (const file of HISTORICAL_SOURCE_FILES) {
      const bytes = preSources.sourceBytes[file];
      const originPreimagePath = path.join(originRunDir, "source-before", ...file.split("/"));
      assertStrictChild(fixtureRootReal, originPreimagePath, `origin preimage ${file}`);
      await mkdir(path.dirname(originPreimagePath), { recursive: true });
      await writeFile(originPreimagePath, bytes);
      assert.deepEqual(await readFile(originPreimagePath), bytes, `${file} copied from the same raw preimage`);
    }
    const originPrecheckPath = path.join(originRunDir, "integration-precheck.json");
    await writeFile(originPrecheckPath, precheckBytes);
    assert.deepEqual(await readFile(originPrecheckPath), precheckBytes, "origin run uses the original precheck bytes");
    const manifestBytes = await readFile(path.join(manifestRunDir, "production-source-manifest.json"));
    const originManifestPath = path.join(originRunDir, "production-source-manifest.json");
    await writeFile(originManifestPath, manifestBytes);
    assert.deepEqual(
      await readFile(originManifestPath),
      manifestBytes,
      "origin run uses the complete original manifest bytes",
    );

    const foreignCwd = path.join(fixtureRootReal, "foreign cwd with spaces");
    assertStrictChild(fixtureRootReal, foreignCwd, "foreign cwd");
    await mkdir(foreignCwd);
    const cliPath = path.join(sandboxRoot, "scripts", "skin-palette", "review-cli.mjs");
    const cliStartedAt = Date.now();
    const cli = await execFileWithExitCode(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        cliPath,
        "verify",
        "--production",
        "--run",
        "docs/validation/origin-run",
        "--require-selections",
      ],
      { cwd: foreignCwd, maxBuffer: 32 * 1024 * 1024 },
    );
    const cliElapsedMs = Date.now() - cliStartedAt;
    assert.equal(cli.code, 2, `real CLI exit code; stderr=${cli.stderr}`);
    assert.equal(cli.stderr, "");
    const cliOutputLine = /^([^\r\n]+)\r?\n$/.exec(cli.stdout);
    assert.ok(cliOutputLine, "CLI stdout must contain exactly one JSON line");
    const cliResult = JSON.parse(cliOutputLine[1]);
    assert.deepEqual(Object.keys(cliResult), ["status", "errors", "gaps"]);
    assert.equal(cliResult.status, "incomplete");
    assert.deepEqual(cliResult.errors, []);
    assert.equal(cliResult.gaps.length, SKIN_IDS.length);
    assert.deepEqual(
      cliResult.gaps.map(({ skinId }) => skinId),
      SKIN_IDS,
    );
    assert.deepEqual(cliResult.gaps, result.gaps, "real CLI gaps match the direct E1 result exactly");
    const assembledIndex = await assembleFormalIndex();

    const consumerEvidencePaths = [
      path.join(formalOutDir, "capture.json"),
      path.join(formalOutDir, "progress.json"),
      path.join(formalOutDir, "production-selection.json"),
      path.join(formalOutDir, "production-index-shard.json"),
      formalIndexPath,
    ];
    const consumerEvidenceBefore = await Promise.all(consumerEvidencePaths.map((filePath) => readFile(filePath)));
    const consumerStartedAt = Date.now();
    const assembledIndexCli = await execFileWithExitCode(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        cliPath,
        "verify",
        "--production",
        "--run",
        "docs/validation/origin-run",
        "--require-selections",
      ],
      { cwd: foreignCwd, maxBuffer: 32 * 1024 * 1024 },
    );
    const consumerElapsedMs = Date.now() - consumerStartedAt;
    const consumerEvidenceAfter = await Promise.all(consumerEvidencePaths.map((filePath) => readFile(filePath)));
    const changedEvidencePaths = consumerEvidenceBefore.flatMap((bytes, index) =>
      consumerEvidenceAfter[index].equals(bytes) ? [] : [consumerEvidencePaths[index]],
    );
    assembledIndexConsumer = {
      exitCode: assembledIndexCli.code,
      status: null,
      errorCount: null,
      gapCount: null,
      missingCaptureSkins: [],
      chatgptGapCount: null,
      chatgptGapModes: [],
      evidenceUnchanged: changedEvidencePaths.length === 0,
      changedEvidencePaths,
      elapsedMs: consumerElapsedMs,
    };
    consumerEvidenceBefore.forEach((bytes, index) => {
      assert.deepEqual(
        consumerEvidenceAfter[index],
        bytes,
        `formal evidence remains byte-identical: ${consumerEvidencePaths[index]}`,
      );
    });
    const assembledIndexCliLine = /^([^\r\n]+)\r?\n$/.exec(assembledIndexCli.stdout);
    assert.ok(
      assembledIndexCliLine,
      `post-assembly CLI stdout must contain exactly one JSON line; exit=${assembledIndexCli.code}; stderr=${assembledIndexCli.stderr}; stdout=${assembledIndexCli.stdout}`,
    );
    const assembledIndexCliResult = JSON.parse(assembledIndexCliLine[1]);
    const consumerDiagnostics = JSON.stringify({
      status: assembledIndexCliResult.status,
      errors: assembledIndexCliResult.errors,
      gaps: assembledIndexCliResult.gaps,
    });
    const consumerErrors = Array.isArray(assembledIndexCliResult.errors) ? assembledIndexCliResult.errors : [];
    const consumerGaps = Array.isArray(assembledIndexCliResult.gaps) ? assembledIndexCliResult.gaps : [];
    const missingCaptureSkins = consumerGaps
      .filter(({ code }) => code === "missing-production-capture")
      .map(({ skinId }) => skinId);
    const chatgptGaps = consumerGaps.filter(({ skinId }) => skinId === SKIN_IDS[0]);
    assembledIndexConsumer = {
      ...assembledIndexConsumer,
      status: assembledIndexCliResult.status ?? null,
      errorCount: consumerErrors.length,
      gapCount: consumerGaps.length,
      missingCaptureSkins,
      chatgptGapCount: chatgptGaps.length,
      chatgptGapModes: [...new Set(chatgptGaps.map(({ mode }) => mode).filter(Boolean))].sort(),
    };
    assert.equal(assembledIndexCli.stderr, "", `post-assembly CLI stderr; ${consumerDiagnostics}`);
    assert.deepEqual(Object.keys(assembledIndexCliResult), ["status", "errors", "gaps"]);
    assert.equal(assembledIndexCli.code, 2, `post-assembly CLI exit code; ${consumerDiagnostics}`);
    assert.equal(assembledIndexCliResult.status, "incomplete", `post-assembly CLI status; ${consumerDiagnostics}`);
    assert.deepEqual(assembledIndexCliResult.errors, [], `post-assembly CLI errors; ${consumerDiagnostics}`);
    assert.deepEqual(missingCaptureSkins, SKIN_IDS.slice(1), "the assembled index supplies only ChatGPT");
    assert.ok(
      chatgptGaps.length > 0,
      `ChatGPT's indexed capture must be measured as incomplete; ${consumerDiagnostics}`,
    );
    assert.ok(
      chatgptGaps.some(({ code, mode }) => code === "status-incomplete" && (mode === "light" || mode === "dark")),
      `ChatGPT gaps must include the captured matrix's incomplete mode; ${consumerDiagnostics}`,
    );
    const assetSummary = (assets) => ({
      assetManifestSha256: assets.assetManifestSha256,
      sourceAssetHashes: assets.sourceAssetHashes,
      publicAssetHashes: assets.publicAssetHashes,
      toolHashes: assets.toolHashes,
    });
    summary = {
      fixture: fixtureRootReal,
      source: result.sourceResult.status,
      sourceTransition: result.sourceResult.sourceTransition,
      assetTransition: result.sourceResult.assetTransition,
      production: result.productionResult.status,
      formalGaps: result.productionResult.gaps.length,
      postOrigin: result.postOriginStability.status,
      postCurrent: result.postCurrentStability.status,
      status: result.status,
      exitCode: result.exitCode,
      formalCapture,
      assembledIndex,
      cli: {
        exitCode: cli.code,
        status: cliResult.status,
        errors: cliResult.errors,
        gaps: cliResult.gaps,
        stderr: cli.stderr,
        elapsedMs: cliElapsedMs,
      },
      copiedFileCount: copiedHashes.size,
      copiedScope: [
        "scripts/skin-palette/",
        "src/server.js static local import graph",
        `${SOURCE_FILES.length} registry source files`,
        "4 generated-asset tools",
        "public/skin-assets.json",
        "40 registered source assets + 40 published assets",
        "test-support/skin-palette-fixture.mjs",
      ],
      sourceHashDigestBefore: sha256Canonical(preSources.sourceHashes),
      sourceHashDigestAfter: sha256Canonical(afterSources.sourceHashes),
      assetSummaryHashBefore: sha256Canonical(assetSummary(preAssets)),
      assetSummaryHashAfter: sha256Canonical(assetSummary(afterAssets)),
      frozenProjectHashes: projectBeforeHashes,
    };
  } finally {
    try {
      assert.deepEqual(
        await hashFiles(repoReal, frozenPaths),
        projectBeforeHashes,
        "frozen project source files stay unchanged",
      );
    } finally {
      if (fixtureRootPath !== null) {
        const cleanupRoot = await realpath(fixtureRootPath);
        if (fixtureRootReal !== null) {
          assert.equal(cleanupRoot, fixtureRootReal, "fixture root identity must remain stable before cleanup");
        }
        assertStrictChild(validationRoot, cleanupRoot, "cleanup root");
        assert.equal(path.dirname(cleanupRoot), validationRoot, "cleanup is limited to this direct fixture child");
        assert.ok(path.basename(cleanupRoot).startsWith(FIXTURE_PREFIX));
        await rm(cleanupRoot, { recursive: true, force: true });
      }
      t.diagnostic(
        JSON.stringify({
          ...summary,
          assembledIndexConsumer,
          fixture: fixtureRootReal,
          cleaned: fixtureRootPath !== null,
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }
  }
});
