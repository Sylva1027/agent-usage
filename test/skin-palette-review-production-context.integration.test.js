import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertProductionSourceManifest } from "../scripts/skin-palette/production-source-manifest.mjs";
import {
  readProductionCurrentSources,
  readProductionGeneratedAssets,
  verifyProductionSourceContext,
} from "../scripts/skin-palette/review-production.mjs";
import { SKIN_IDS, sha256Canonical } from "../scripts/skin-palette/contracts.mjs";
import { SOURCE_FILES } from "../scripts/skin-palette/capture.mjs";
import { createSelectionExport } from "../scripts/skin-palette/review-selection.mjs";
import { REPO_ROOT } from "../scripts/skin-palette/review-evidence.mjs";
import { verifyReviewEvidence } from "../scripts/skin-palette/review-verify.mjs";
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

const FIXTURE_PREFIX = "m4-4-7-d9f2-";

function assertFixtureRootIsDirectChild(validationRoot, fixtureRoot) {
  assert.ok(path.isAbsolute(fixtureRoot));
  const relative = path.relative(validationRoot, fixtureRoot);
  assert.notEqual(relative, "");
  assert.ok(!path.isAbsolute(relative));
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`));
  assert.equal(path.dirname(relative), ".");
  assert.ok(path.basename(relative).startsWith(FIXTURE_PREFIX));
}

function repoRelative(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function assertCleanPass(result, label) {
  assert.equal(result.status, "pass", `${label}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.errors, [], `${label} errors`);
  assert.deepEqual(result.gaps, [], `${label} gaps`);
}

test("D9f-2 runs the real ten-skin source-context branch and records expected synthetic source drift", async (t) => {
  const startedAt = Date.now();
  const repoRoot = await realpath(REPO_ROOT);
  const validationRoot = await realpath(path.join(repoRoot, "docs", "validation"));
  let fixtureRootPath = null;
  let fixtureRootReal = null;
  let sourceTransitionSummary = "not reached";
  let assetTransitionStatus = "not reached";

  try {
    fixtureRootPath = await mkdtemp(path.join(validationRoot, FIXTURE_PREFIX));
    fixtureRootReal = await realpath(fixtureRootPath);
    assertFixtureRootIsDirectChild(validationRoot, fixtureRootReal);

    const allowedRuns = new Set(["origin-run", "manifest-run"]);
    const box = {
      sandbox: repoRoot,
      async makeRun(name) {
        if (!allowedRuns.has(name)) throw new TypeError(`unexpected fixture run name: ${name}`);
        const runDir = path.join(fixtureRootReal, name);
        assert.equal(path.dirname(runDir), fixtureRootReal);
        await mkdir(runDir);
        const runReal = await realpath(runDir);
        assert.equal(runReal, runDir);
        return runReal;
      },
    };

    const candidates = SKIN_IDS.flatMap((skinId) =>
      ["a", "b", "c"].map((variant) => makeCandidate({ skinId, variant })),
    );
    const historicalSnapshot = Object.fromEntries(
      await Promise.all(HISTORICAL_SOURCE_FILES.map(async (file) => [file, await readFile(path.join(repoRoot, file))])),
    );
    historicalSnapshot["public/skin-picker.js"] = await readFile(
      path.join(repoRoot, "test-support/skin-picker-before-migration.txt"),
    );
    const historicalHashes = {
      ...REAL_SOURCE_HASHES,
      "public/skin-picker.js": sha256(historicalSnapshot["public/skin-picker.js"]),
    };
    const built = await buildRun(box, "origin-run", candidates, {
      origins: { currentProfiles: true },
      assessments: candidates.map((candidate) =>
        realAssessment(candidate, makeCandidateSet(candidates), null, historicalHashes),
      ),
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...historicalHashes };
        },
      }),
    });
    const initialReview = await verifyReviewEvidence({ evidence: built.evidence, sourceSnapshot: historicalSnapshot });
    const readinessDetails = {
      status: initialReview.status,
      errors: initialReview.errors,
      gaps: initialReview.gaps.map((gap) => ({
        ...gap,
        skinId: candidates.find((candidate) => candidate.id === gap.candidateId)?.skinId ?? null,
      })),
    };
    assert.equal(initialReview.status, "pass", JSON.stringify(readinessDetails, null, 2));
    assert.deepEqual(initialReview.errors, []);
    assert.deepEqual(initialReview.gaps, []);
    const verifiedModel = initialReview.verifiedModel;
    assert.ok(verifiedModel, "real verifier returns a complete verified model");
    assert.deepEqual(
      verifiedModel.candidateSet.candidates.map((candidate) => [candidate.skinId, candidate.variant]),
      SKIN_IDS.flatMap((skinId) => ["a", "b", "c"].map((variant) => [skinId, variant])),
    );
    assert.deepEqual(
      verifiedModel.selectableCandidateIds,
      verifiedModel.candidateSet.candidates.map((candidate) => candidate.id),
    );

    const choices = Object.fromEntries(
      SKIN_IDS.map((skinId) => {
        const candidate = verifiedModel.candidateSet.candidates.find(
          (item) => item.skinId === skinId && item.variant === "a",
        );
        assert.ok(candidate, `ready candidate exists for ${skinId}`);
        return [skinId, { candidateId: candidate.id, candidateHash: candidate.candidateHash }];
      }),
    );
    const exportedSelection = createSelectionExport({
      verifiedModel,
      choices,
      decisionSource: "D9f-2 synthetic integration fixture; not a visual decision",
      recordedAt: "2026-10-10T00:00:00.000Z",
    });
    assert.equal(exportedSelection.fileName, "selections.json");
    const originRunDir = built.runDir;
    await writeJson(path.join(originRunDir, "assessments.json"), verifiedModel.container);
    await writeJson(path.join(originRunDir, "selections.json"), exportedSelection.record);
    const evidence = await load(box, originRunDir, path.join(originRunDir, "captures-index.json"));
    assert.equal(evidence.selections.present, true);
    assert.deepEqual(evidence.selections.record, exportedSelection.record);

    const manifestRunDir = await box.makeRun("manifest-run");
    const [currentSources, currentAssets] = await Promise.all([
      readProductionCurrentSources(),
      readProductionGeneratedAssets(),
    ]);
    assert.equal(SOURCE_FILES.length, 31);
    for (const file of [
      "scripts/skin-palette/focus-outline-pixels.mjs",
      "scripts/skin-palette/focus-outline-browser.mjs",
      "scripts/skin-palette/detail-bar-capture.mjs",
      "scripts/skin-palette/detail-bar-frame-analysis.mjs",
      "scripts/skin-palette/detail-bar-pixels.mjs",
      "scripts/skin-palette/detail-bar-browser.mjs",
      "scripts/skin-palette/detail-bar-hit-browser.mjs",
      "scripts/skin-palette/detail-bar-paint-browser.mjs",
    ]) {
      assert.equal(SOURCE_FILES.filter((entry) => entry === file).length, 1);
      assert.deepEqual(currentSources.sourceBytes[file], await readFile(path.join(repoRoot, ...file.split("/"))));
      assert.equal(currentSources.sourceHashes[file], sha256(currentSources.sourceBytes[file]));
    }
    assert.ok(SOURCE_FILES.includes("public/timeline-utils.js"));
    assert.equal(Object.keys(currentSources.sourceBytes).length, SOURCE_FILES.length);
    assert.equal(Object.keys(currentSources.sourceHashes).length, SOURCE_FILES.length);
    assert.deepEqual(Object.keys(currentSources.sourceHashes), SOURCE_FILES);
    assert.equal(Object.keys(currentAssets.sourceAssetHashes).length, 40);
    assert.equal(Object.keys(currentAssets.publicAssetHashes).length, 40);

    const sourcePreimages = Object.fromEntries(
      HISTORICAL_SOURCE_FILES.map((file) => [file, { path: `source-before/${file}`, sha256: historicalHashes[file] }]),
    );
    for (const file of HISTORICAL_SOURCE_FILES) {
      const bytes = historicalSnapshot[file];
      assert.ok(Buffer.isBuffer(bytes), `${file} is an actual source Buffer`);
      assert.equal(sha256(bytes), historicalHashes[file], `${file} historical hash matches its bytes`);
      const preimagePath = path.join(manifestRunDir, "source-before", ...file.split("/"));
      await mkdir(path.dirname(preimagePath), { recursive: true });
      await writeFile(preimagePath, Buffer.from(bytes));
    }

    const precheck = {
      schemaVersion: 1,
      sourceHashes: { ...historicalHashes },
      sourcePreimages,
      selectionRollback: { reservedForM6: true },
      generatedAssets: {
        assetManifestSha256: currentAssets.assetManifestSha256,
        sourceAssetHashes: { ...currentAssets.sourceAssetHashes },
        publicAssetHashes: { ...currentAssets.publicAssetHashes },
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
      assert.deepEqual(Object.keys(capture.sourceHashes), Object.keys(currentSources.sourceHashes));
      captureRecords[candidate.id] = {
        capturePath: path.posix.join(repoRelative(repoRoot, originRunDir), "captures", candidate.id, "capture.json"),
        fileSha256: sha256(captureBytes),
        sourceHashesHash: sha256Canonical(capture.sourceHashes),
      };
    }

    const originRunRelative = repoRelative(repoRoot, originRunDir);
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
        sourceHashes: { ...currentSources.sourceHashes },
        generatedAssets: {
          assetManifestSha256: currentAssets.assetManifestSha256,
          sourceAssetHashes: { ...currentAssets.sourceAssetHashes },
          publicAssetHashes: { ...currentAssets.publicAssetHashes },
        },
        toolHashes: { ...currentAssets.toolHashes },
      },
    };
    assert.equal(assertProductionSourceManifest({ manifest, candidateSet }), undefined);
    await writeJson(path.join(manifestRunDir, "production-source-manifest.json"), manifest);

    const result = await verifyProductionSourceContext({ manifestRunDir, evidence });
    assert.equal(result.historicalContext.metadataResult.status, "pass");
    assert.deepEqual(result.historicalContext.metadataResult.errors, []);
    assert.deepEqual(result.historicalContext.metadataResult.gaps, []);
    assert.equal(result.historicalContext.capturesResult.status, "pass");
    assert.deepEqual(result.historicalContext.capturesResult.errors, []);
    assert.deepEqual(result.historicalContext.capturesResult.gaps, []);
    assert.equal(result.historicalContext.historicalEvidence.originResult.status, "pass");
    assert.equal(result.historicalContext.historicalEvidence.assessmentBinding.status, "pass");
    assert.equal(result.historicalContext.historicalEvidence.historicalResult.sourceContext, "historical");

    assert.ok(result.currentContext, "D9e entered the real current-side branch");
    assert.equal(result.currentContext.selectedCandidates.length, SKIN_IDS.length);
    assert.deepEqual(
      result.currentContext.selectedCandidates.map(({ candidate }) => candidate.skinId),
      SKIN_IDS,
    );
    assert.deepEqual(
      result.currentContext.selectedCandidates.map(({ candidate }) => candidate.id),
      SKIN_IDS.map((skinId) => choices[skinId].candidateId),
    );
    assert.equal(result.currentContext.sourceTransition.status, "rejected");
    assert.ok(
      result.currentContext.sourceTransition.errors.some(
        ({ code }) => code === "production-source-transition-mismatch",
      ),
      JSON.stringify(result.currentContext.sourceTransition, null, 2),
    );
    assertCleanPass(result.currentContext.assetTransition, "actual unchanged asset snapshot");
    assertCleanPass(result.originStability, "origin end check");
    assert.ok(result.currentStability, "D9e ran the current-side end check");
    assertCleanPass(result.currentStability, "current end check");
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.gaps, []);
    assert.deepEqual(result.errors, result.currentContext.sourceTransition.errors);

    sourceTransitionSummary = JSON.stringify(
      result.currentContext.sourceTransition.errors.map(({ code, path: file }) => ({ code, path: file })),
    );
    assetTransitionStatus = result.currentContext.assetTransition.status;
  } finally {
    if (fixtureRootPath !== null && fixtureRootReal !== null) {
      const cleanupRoot = await realpath(fixtureRootPath);
      assert.equal(cleanupRoot, fixtureRootReal, "fixture root identity did not change before cleanup");
      assertFixtureRootIsDirectChild(validationRoot, cleanupRoot);
      await rm(cleanupRoot, { recursive: true, force: true });
    }
    t.diagnostic(
      `fixture=${fixtureRootReal === null ? "not created" : path.basename(fixtureRootReal)} cleaned=${fixtureRootReal !== null} ` +
        `elapsedMs=${Date.now() - startedAt} sourceTransition=${sourceTransitionSummary} assetTransition=${assetTransitionStatus}`,
    );
  }
});
