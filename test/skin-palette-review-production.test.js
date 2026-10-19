import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import {
  enumerateSourceAssets,
  PALETTE_TOKEN_KEYS,
  SKINS,
  derivePaletteDeclarationsFromTokens,
} from "../public/skins.js";
import { SKIN_PALETTES } from "../public/skin-palettes.js";
import { buildSkinBootstrapSource } from "../scripts/skin-palette/bootstrap-source.mjs";
import { buildProductionBootstrapSource } from "../scripts/skin-palette/production-bootstrap-source.mjs";
import { verifyProductionSourceTransition } from "../scripts/skin-palette/production-source-transition.mjs";
import {
  GENERATED_ASSET_TOOL_FILES,
  compareProductionTokens,
  readProductionBaselineEvidence,
  readProductionCaptureIndex,
  readProductionCaptureBinding,
  readProductionCurrentSources,
  readProductionGeneratedAssets,
  verifyProductionCurrentStability,
  readProductionSourceSnapshot,
  readProductionSourceManifest,
  readProductionPreMigrationAssets,
  readProductionHistoricalContext,
  readProductionCurrentContext,
  verifyProductionOriginStability,
  verifyProductionSourceContext,
  verifyProductionReviewEvidence,
  readProductionStateEvidence,
  resolveProductionSelection,
  runProductionCapture as runProductionCaptureImplementation,
  verifyProductionCapture,
  verifyProductionCaptureIndex,
  verifyProductionContext,
  verifyProductionGeneratedAssets,
  verifyProductionOriginMetadata,
  verifyProductionOriginCaptures,
  verifyProductionSourceHashes,
  writeProductionCaptureIndexShard,
  writeProductionCaptureBinding,
} from "../scripts/skin-palette/review-production.mjs";
import { buildProductionPaletteSource } from "../scripts/skin-palette/production-palette-source.mjs";
import {
  buildProductionPickerSource,
  productionPickerPreviewTokens,
} from "../scripts/skin-palette/production-picker-source.mjs";
import {
  resolveProductionHistoricalSelection,
  verifyProductionSourceOrigins,
} from "../scripts/skin-palette/production-source-origins.mjs";
import {
  assertProductionManifestOrigin,
  assertProductionSourceManifest,
  verifyProductionAssetTransition,
  verifyProductionDeclaredSourceTransition,
} from "../scripts/skin-palette/production-source-manifest.mjs";
import {
  canonicalJson,
  collectSourceHashes,
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  SKIN_IDS,
  validateCandidate,
  validateCandidateSet,
} from "../scripts/skin-palette/contracts.mjs";
import {
  buildFixedMatrixFixtureBindings,
  SOURCE_FILES,
  STATE_MATRIX_GROUPS,
} from "../scripts/skin-palette/capture.mjs";
import { createSelectionExport } from "../scripts/skin-palette/review-selection.mjs";
import {
  classifyProductionCapture,
  readProductionCaptureChecks,
  runReviewCapture as runReviewCaptureImplementation,
  summarizeProductionCapture,
} from "../scripts/skin-palette/review-capture.mjs";
import { loadReviewEvidence, REPO_ROOT } from "../scripts/skin-palette/review-evidence.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import { getPaletteFixtureHash, getTimelineWarningFixtureHash } from "../test-support/skin-palette-fixture.mjs";

const tokens = (color) => Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, color]));
const validationRoot = path.join(REPO_ROOT, "docs", "validation");
const ROLE_BY_ID = new Map(ROLE_CATALOG.map((role) => [role.id, role]));
const offlineBaseFixtureHash = getPaletteFixtureHash();
const offlineWarningFixtureHash = getTimelineWarningFixtureHash();

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

function runProductionCapture(options) {
  return runProductionCaptureImplementation(withOfflineFixtureFactories(options));
}

function runReviewCapture(options) {
  return runReviewCaptureImplementation(withOfflineFixtureFactories(options));
}

function makeFixtureRoleRecords(roleIds, stateId, mode) {
  return roleIds.map((roleId) => {
    const role = ROLE_BY_ID.get(roleId);
    const record = { roleId, stateId, candidateId: null, mode, result: "unmeasured" };
    if (role.required === true && Number.isFinite(role.threshold)) {
      record.result = "pass";
      record.ratio = role.threshold;
      record.threshold = role.threshold;
    }
    return record;
  });
}

function makeCandidate({
  skinId = "chatgpt",
  light = tokens("#112233"),
  dark = tokens("#445566"),
  policyHash = "a".repeat(64),
} = {}) {
  const profileSnapshot = { fixtureSkin: skinId };
  const candidate = {
    schemaVersion: 1,
    skinId,
    variant: "a",
    profileVersion: 1,
    profileSnapshot,
    profileHash: sha256Canonical(profileSnapshot),
    policyHash,
    derivationHash: "b".repeat(64),
    seed: "palette-redesign-v1",
    style: { title: "Production comparison test", rationale: "Contract-valid test candidate", identitySource: "test" },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light, dark },
  };
  candidate.candidateHash = hashCandidate(candidate);
  candidate.id = `${skinId}-a-${candidate.candidateHash.slice(0, 12)}`;
  return candidate;
}

function candidateWithPolicyHash(candidate, policyHash) {
  const result = structuredClone(candidate);
  result.policyHash = policyHash;
  result.candidateHash = hashCandidate(result);
  result.id = `${result.skinId}-${result.variant}-${result.candidateHash.slice(0, 12)}`;
  return result;
}

function productionModesFor(skinId) {
  return Object.fromEntries(
    ["light", "dark"].map((mode) => [
      mode,
      Object.fromEntries(
        PALETTE_TOKEN_KEYS.map((token) => [token, SKIN_PALETTES[skinId][mode][token].trim().toUpperCase()]),
      ),
    ]),
  );
}

function makeSelectionCandidate(skinId, variant, modes = null, policyHash) {
  const candidate = makeCandidate({
    skinId,
    policyHash,
    ...(modes ? { light: modes.light, dark: modes.dark } : {}),
  });
  candidate.variant = variant;
  candidate.candidateHash = hashCandidate(candidate);
  candidate.id = `${skinId}-${variant}-${candidate.candidateHash.slice(0, 12)}`;
  return candidate;
}

function makeVerifiedModel({ productionSkinId = null, productionSkinIds = [] } = {}) {
  const policyHash = currentPolicyHash();
  const candidates = SKIN_IDS.flatMap((skinId) =>
    ["a", "b", "c"].map((variant) =>
      makeSelectionCandidate(
        skinId,
        variant,
        (productionSkinId === skinId || productionSkinIds.includes(skinId)) && variant === "a"
          ? productionModesFor(skinId)
          : null,
        policyHash,
      ),
    ),
  );
  const candidateSet = {
    schemaVersion: 1,
    inputHashes: {
      profiles: "1".repeat(64),
      policy: policyHash,
      roles: hashRoleInputs(),
      derivation: "3".repeat(64),
    },
    candidates,
    rejected: [],
  };
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const assessments = candidates.map(({ id: candidateId, candidateHash }) => ({
    candidateId,
    candidateHash,
    readiness: "ready",
  }));
  const container = { schemaVersion: 1, candidateSetHash: candidateSet.candidateSetHash, assessments };
  container.assessmentHash = sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
  return {
    schemaVersion: 1,
    kind: "skin-palette-review-verified-model",
    candidateSet,
    container,
    selectableCandidateIds: candidates.map(({ id }) => id),
    gaps: [],
    images: {
      baseline: [],
      units: candidates.flatMap(({ id: candidateId }) => [
        { candidateId, mode: "light" },
        { candidateId, mode: "dark" },
      ]),
    },
  };
}

function makeSelections(verifiedModel) {
  const choices = Object.fromEntries(
    SKIN_IDS.map((skinId) => {
      const candidate = verifiedModel.candidateSet.candidates.find(
        (item) => item.skinId === skinId && item.variant === "a",
      );
      return [skinId, { candidateId: candidate.id, candidateHash: candidate.candidateHash }];
    }),
  );
  const exported = createSelectionExport({
    verifiedModel,
    choices,
    decisionSource: "TEST ONLY: synthetic in-memory selection",
    recordedAt: "2026-10-07T08:30:00.000Z",
  });
  assert.equal(exported.fileName, "selections.json");
  return exported.record;
}

function testPaletteAst(sourceText) {
  const sourceFile = ts.createSourceFile(
    "test-skin-palettes.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const statement = sourceFile.statements.find(
    (item) =>
      ts.isVariableStatement(item) &&
      item.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "SKIN_PALETTES",
      ),
  );
  assert.ok(statement, "test fixture contains SKIN_PALETTES");
  const declaration = statement.declarationList.declarations.find(
    (item) => ts.isIdentifier(item.name) && item.name.text === "SKIN_PALETTES",
  );
  assert.ok(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  return { sourceFile, statement, declaration, palette: declaration.initializer };
}

function testPaletteDeclaration(sourceText) {
  return testPaletteAst(sourceText).declaration;
}

function testStaticProperties(objectLiteral) {
  return new Map(
    objectLiteral.properties
      .filter(ts.isPropertyAssignment)
      .filter((property) => ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      .map((property) => [property.name.text, property]),
  );
}

function testTokenSpans(sourceText) {
  const { sourceFile, palette } = testPaletteAst(sourceText);
  const skins = testStaticProperties(palette);
  return SKIN_IDS.flatMap((skinId) => {
    const modes = testStaticProperties(skins.get(skinId).initializer);
    return ["light", "dark"].flatMap((mode) => {
      const tokens = testStaticProperties(modes.get(mode).initializer);
      return PALETTE_TOKEN_KEYS.map((token) => {
        const property = tokens.get(token);
        return {
          skinId,
          mode,
          token,
          start: property.initializer.getStart(sourceFile),
          end: property.initializer.getEnd(),
          value: property.initializer.text,
        };
      });
    });
  });
}

function replaceTestNode(sourceText, node, replacement) {
  return `${sourceText.slice(0, node.getStart())}${replacement}${sourceText.slice(node.getEnd())}`;
}

function editTestPalette(sourceText, selectNode, replacement) {
  const ast = testPaletteAst(sourceText);
  return replaceTestNode(sourceText, selectNode(ast), replacement);
}

function insertIntoTestObject(sourceText, selectObject, addition) {
  const ast = testPaletteAst(sourceText);
  const object = selectObject(ast);
  const closingBrace = object.getEnd() - 1;
  return `${sourceText.slice(0, closingBrace)}${addition}${sourceText.slice(closingBrace)}`;
}

function testPalettePropertyFromAst({ palette }, skinId, mode, token = null) {
  const skin = testStaticProperties(palette).get(skinId);
  const modeObject = testStaticProperties(skin.initializer).get(mode).initializer;
  return token === null ? modeObject : testStaticProperties(modeObject).get(token);
}

function makeProductionSourceInputs({ useCurrentPalette = false } = {}) {
  const verifiedModel = makeVerifiedModel({ productionSkinIds: SKIN_IDS });
  const changedIds = new Map();
  let colorNumber = 0x010000;

  for (const skinId of SKIN_IDS) {
    const candidate = verifiedModel.candidateSet.candidates.find(
      (item) => item.skinId === skinId && item.variant === "a",
    );
    const oldId = candidate.id;
    for (const mode of ["light", "dark"]) {
      for (const token of PALETTE_TOKEN_KEYS) {
        let value;
        if (useCurrentPalette) {
          value = SKIN_PALETTES[skinId][mode][token].trim().toUpperCase();
        } else {
          do {
            value = `#${(colorNumber++).toString(16).padStart(6, "0")}`.toUpperCase();
          } while (value === SKIN_PALETTES[skinId][mode][token].trim().toUpperCase());
        }
        candidate.modes[mode][token] = value;
      }
    }
    candidate.candidateHash = hashCandidate(candidate);
    candidate.id = `${candidate.skinId}-${candidate.variant}-${candidate.candidateHash.slice(0, 12)}`;
    changedIds.set(oldId, candidate.id);
  }

  const candidates = verifiedModel.candidateSet.candidates;
  verifiedModel.candidateSet.candidateSetHash = hashCandidateSet(verifiedModel.candidateSet);
  verifiedModel.container.candidateSetHash = verifiedModel.candidateSet.candidateSetHash;
  verifiedModel.container.assessments = candidates.map(({ id: candidateId, candidateHash }) => ({
    candidateId,
    candidateHash,
    readiness: "ready",
  }));
  verifiedModel.container.assessmentHash = sha256Canonical({
    schemaVersion: verifiedModel.container.schemaVersion,
    candidateSetHash: verifiedModel.container.candidateSetHash,
    assessments: verifiedModel.container.assessments,
  });
  verifiedModel.selectableCandidateIds = verifiedModel.selectableCandidateIds.map((id) => changedIds.get(id) ?? id);
  verifiedModel.images.units = verifiedModel.images.units.map((unit) => ({
    ...unit,
    candidateId: changedIds.get(unit.candidateId) ?? unit.candidateId,
  }));

  return { verifiedModel, selections: makeSelections(verifiedModel) };
}

function selectedBootstrapOverrides(verifiedModel, selections) {
  return Object.fromEntries(
    SKIN_IDS.map((skinId) => {
      const candidate = verifiedModel.candidateSet.candidates.find(
        (item) => item.id === selections.choices[skinId].candidateId,
      );
      return [
        skinId,
        Object.fromEntries(
          ["light", "dark"].map((mode) => [
            mode,
            Object.fromEntries(PALETTE_TOKEN_KEYS.map((token) => [token, candidate.modes[mode][token]])),
          ]),
        ),
      ];
    }),
  );
}

function parseBootstrapConfig(source) {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  const match = text.match(/const CONFIG = (\{[^\n]*\});/);
  assert.ok(match, "bootstrap contains a static JSON CONFIG literal");
  return JSON.parse(match[1]);
}

function assertExactPaletteReplacement(beforeSource, afterSource, verifiedModel, selections) {
  assert.ok(Buffer.isBuffer(afterSource));
  const beforeText = beforeSource.toString("utf8");
  const spans = testTokenSpans(beforeText);
  assert.equal(spans.length, SKIN_IDS.length * 2 * PALETTE_TOKEN_KEYS.length);
  const selectedBySkin = new Map(
    SKIN_IDS.map((skinId) => [
      skinId,
      verifiedModel.candidateSet.candidates.find(
        (candidate) => candidate.id === selections.choices[skinId].candidateId,
      ),
    ]),
  );
  let expected = "";
  let cursor = 0;
  for (const span of spans) {
    const value = selectedBySkin.get(span.skinId).modes[span.mode][span.token];
    assert.notEqual(
      value,
      span.value,
      `${span.skinId}.${span.mode}.${span.token} is changed by the synthetic selection`,
    );
    expected += beforeText.slice(cursor, span.start) + JSON.stringify(value);
    cursor = span.end;
  }
  expected += beforeText.slice(cursor);
  assert.deepEqual(afterSource, Buffer.from(expected, "utf8"));
  assert.deepEqual(
    testTokenSpans(afterSource.toString("utf8")).map(({ skinId, mode, token, value }) => ({
      skinId,
      mode,
      token,
      value,
    })),
    spans.map(({ skinId, mode, token }) => ({
      skinId,
      mode,
      token,
      value: selectedBySkin.get(skinId).modes[mode][token],
    })),
  );
}

const EXPECTED_PICKER_PREVIEW_CSS_VARS = Object.freeze({
  pageBackground: "--bg",
  panelBackground: "--neo-surface",
  controlBackground: "--control",
  text: "--ink",
  mutedText: "--muted",
  border: "--line",
  accent: "--blue",
  chartText: "--chart-text",
  chartLine: "--chart-line",
});

function testPickerAst(sourceText) {
  const sourceFile = ts.createSourceFile(
    "test-skin-picker.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const colourTokensStatement = sourceFile.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "COLOUR_TOKENS",
      ),
  );
  const previewFunction = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "previewTokens",
  );
  assert.ok(colourTokensStatement, "test fixture contains COLOUR_TOKENS");
  assert.ok(previewFunction, "test fixture contains previewTokens");
  return { sourceFile, firstStatement: sourceFile.statements[0], colourTokensStatement, previewFunction };
}

function editPickerTestNode(sourceText, selectNode, replacement) {
  const ast = testPickerAst(sourceText);
  const node = selectNode(ast);
  return `${sourceText.slice(0, node.getStart(ast.sourceFile))}${replacement}${sourceText.slice(node.getEnd())}`;
}

function expectedPickerSource(sourceText) {
  const { sourceFile, firstStatement, colourTokensStatement, previewFunction } = testPickerAst(sourceText);
  const lineEnding = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const replacements = [
    {
      start: firstStatement.getStart(sourceFile),
      end: firstStatement.getStart(sourceFile),
      text: `import { derivePaletteDeclarationsFromTokens } from "./skins.js";${lineEnding}`,
    },
    {
      start: colourTokensStatement.getStart(sourceFile),
      end: colourTokensStatement.getEnd(),
      text: `const COLOUR_TOKENS = ${JSON.stringify(EXPECTED_PICKER_PREVIEW_CSS_VARS, null, 2).replace(/\n/g, lineEnding)};`,
    },
    {
      start: previewFunction.getStart(sourceFile),
      end: previewFunction.getEnd(),
      text: productionPickerPreviewTokens
        .toString()
        .replace(/^function productionPickerPreviewTokens/, "function previewTokens")
        .replace(/\n/g, lineEnding),
    },
  ].sort((left, right) => right.start - left.start);

  let expected = sourceText;
  for (const replacement of replacements) {
    expected = `${expected.slice(0, replacement.start)}${replacement.text}${expected.slice(replacement.end)}`;
  }
  return Buffer.from(expected, "utf8");
}

function testPickerNamedStatement(sourceText, name) {
  const sourceFile = ts.createSourceFile(
    "test-skin-picker.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return sourceFile.statements.find(
    (statement) =>
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        )) ||
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name),
  );
}

function assertRejectedWithoutMutation({ verifiedModel, selections, candidateId }) {
  const modelBefore = JSON.stringify(verifiedModel);
  const selectionsBefore = JSON.stringify(selections);
  assert.throws(() => resolveProductionSelection({ verifiedModel, selections, candidateId }), TypeError);
  assert.equal(JSON.stringify(verifiedModel), modelBefore);
  assert.equal(JSON.stringify(selections), selectionsBefore);
}

function makeProductionMatrixResult({
  skinId,
  outDir,
  modes = null,
  candidate = { production: true, skinId },
  groups = ["S0"],
}) {
  const modeResults = modes ?? {
    light: { status: "incomplete", reason: "test-only matrix shape" },
    dark: { status: "incomplete", reason: "test-only matrix shape" },
  };
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  return {
    outDir,
    skinId,
    modes: modeResults,
    capture: {
      schemaVersion: 1,
      kind: "skin-palette-capture-matrix",
      candidate,
      groups: [...groups],
      fixtureHash,
      fixtureBindings,
      modes: structuredClone(modeResults),
    },
    progress: {
      groups: [...groups],
      modes: Object.keys(modeResults),
      digests: { fixtureHash, fixtureBindings: structuredClone(fixtureBindings) },
      units: {},
      attempts: [],
    },
  };
}

function makeSourceHashes(value = "a".repeat(64)) {
  return Object.fromEntries(SOURCE_FILES.map((file) => [file, value]));
}

function currentSourceHashes() {
  return collectSourceHashes(SOURCE_FILES, (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath)));
}

function currentPolicyHash() {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "skin-palette", "policy.json"), "utf8"));
  return sha256Canonical(policy);
}

function applyCaptureMetadata(capture, overrides = {}) {
  Object.assign(capture, {
    fixtureHash: getPaletteFixtureHash(),
    policyHash: currentPolicyHash(),
    measureBaseline: true,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete capture[key];
    else capture[key] = value;
  }
}

function makeContextCaptureResult(candidate, metadata = {}) {
  const captureResult = makeProductionMatrixResult({
    skinId: candidate.skinId,
    outDir: path.join(validationRoot, "synthetic-production-context"),
  });
  const groups = STATE_MATRIX_GROUPS.map((group) => group.id);
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  captureResult.capture.groups = groups;
  captureResult.capture.fixtureHash = fixtureHash;
  captureResult.capture.fixtureBindings = fixtureBindings;
  captureResult.progress.groups = [...groups];
  captureResult.progress.modes = Object.keys(captureResult.modes);
  captureResult.progress.digests = { fixtureHash, fixtureBindings: structuredClone(fixtureBindings) };
  applyCaptureMetadata(captureResult.capture, metadata);
  return captureResult;
}

function makeSourceHashCapture({ candidate, outDir, sourceHashes, modes = null } = {}) {
  const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir, modes });
  captureResult.capture.sourceHashes = sourceHashes;
  return captureResult;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const SOURCE_PREIMAGE_FILES = ["public/skin-palettes.js", "public/skin-picker.js", "public/skin-bootstrap.js"];

function makeProductionSourceTransitionInputs({ useCurrentPalette = false } = {}) {
  const beforeSourceBytes = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, ...file.split("/")))]),
  );
  const beforeSourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, hashBytes(beforeSourceBytes[file])]));
  const sourceSnapshot = Object.fromEntries(
    SOURCE_PREIMAGE_FILES.map((file) => [file, Buffer.from(beforeSourceBytes[file])]),
  );
  const { verifiedModel, selections } = makeProductionSourceInputs({ useCurrentPalette });
  const afterSourceBytes = Object.fromEntries(SOURCE_FILES.map((file) => [file, Buffer.from(beforeSourceBytes[file])]));
  afterSourceBytes["public/skin-palettes.js"] = buildProductionPaletteSource({
    beforeSource: sourceSnapshot["public/skin-palettes.js"],
    verifiedModel,
    selections,
  });
  afterSourceBytes["public/skin-picker.js"] = buildProductionPickerSource({
    beforeSource: sourceSnapshot["public/skin-picker.js"],
  });
  afterSourceBytes["public/skin-bootstrap.js"] = buildProductionBootstrapSource({ verifiedModel, selections });
  return { beforeSourceBytes, beforeSourceHashes, sourceSnapshot, afterSourceBytes, verifiedModel, selections };
}

function cloneRecordWithBuffers(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Buffer.isBuffer(value) ? Buffer.from(value) : value]),
  );
}

function makeDeclaredSourceTransitionInputs() {
  const transition = makeProductionSourceTransitionInputs();
  const manifest = makeProductionSourceManifest(transition.verifiedModel.candidateSet);
  const runPath = "docs/validation/d9a/manifest-run";
  const sourceHashes = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, hashBytes(transition.afterSourceBytes[file])]),
  );
  manifest.preMigration.precheck.fileSha256 = "a".repeat(64);
  manifest.after.sourceHashes = { ...sourceHashes };
  manifest.origin.assessment.assessmentHash = transition.verifiedModel.container.assessmentHash;
  manifest.origin.selections.recordHash = sha256Canonical(transition.selections);

  return {
    manifestRecord: {
      manifestPath: `${runPath}/production-source-manifest.json`,
      manifestFileSha256: "b".repeat(64),
      manifest,
    },
    preMigrationSources: {
      precheckPath: `${runPath}/integration-precheck.json`,
      precheckFileSha256: manifest.preMigration.precheck.fileSha256,
      sourceHashes: { ...transition.beforeSourceHashes },
      sourceSnapshot: cloneRecordWithBuffers(transition.sourceSnapshot),
    },
    currentSources: {
      rootDir: path.resolve(REPO_ROOT, "d9a-current-root-that-is-not-read"),
      sourceBytes: cloneRecordWithBuffers(transition.afterSourceBytes),
      sourceHashes: { ...sourceHashes },
    },
    verifiedModel: transition.verifiedModel,
    selections: transition.selections,
  };
}

function copyDeclaredSourceTransitionInputs(inputs) {
  return {
    manifestRecord: {
      ...inputs.manifestRecord,
      manifest: structuredClone(inputs.manifestRecord.manifest),
    },
    preMigrationSources: {
      ...inputs.preMigrationSources,
      sourceHashes: { ...inputs.preMigrationSources.sourceHashes },
      sourceSnapshot: cloneRecordWithBuffers(inputs.preMigrationSources.sourceSnapshot),
    },
    currentSources: {
      ...inputs.currentSources,
      sourceBytes: cloneRecordWithBuffers(inputs.currentSources.sourceBytes),
      sourceHashes: { ...inputs.currentSources.sourceHashes },
    },
    verifiedModel: structuredClone(inputs.verifiedModel),
    selections: structuredClone(inputs.selections),
  };
}

function makeIntegrationPrecheck() {
  const sourceSnapshot = Object.fromEntries(
    SOURCE_PREIMAGE_FILES.map((file) => [file, Buffer.from(`D2b text-only preimage: ${file}`)]),
  );
  const sourceHashes = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, hashBytes(Buffer.from(`D2b registered source digest: ${file}`))]),
  );
  for (const file of SOURCE_PREIMAGE_FILES) sourceHashes[file] = hashBytes(sourceSnapshot[file]);
  const sourcePreimages = Object.fromEntries(
    SOURCE_PREIMAGE_FILES.map((file) => [file, { path: `source-before/${file}`, sha256: sourceHashes[file] }]),
  );
  return {
    precheck: { schemaVersion: 1, sourceHashes, sourcePreimages, selectionRollback: { reservedForM6: true } },
    sourceSnapshot,
  };
}

function makePreMigrationGeneratedAssets() {
  const assets = enumerateSourceAssets();
  return {
    assetManifestSha256: "a".repeat(64),
    sourceAssetHashes: Object.fromEntries(assets.map(({ sourcePath }, index) => [sourcePath, manifestHash(index + 4)])),
    publicAssetHashes: Object.fromEntries(assets.map(({ publicPath }, index) => [publicPath, manifestHash(index + 5)])),
  };
}

function makePreMigrationPrecheck() {
  return { ...makeIntegrationPrecheck().precheck, generatedAssets: makePreMigrationGeneratedAssets() };
}

function makeSourceOriginsFixture() {
  const candidateSet = structuredClone(makeVerifiedModel().candidateSet);
  candidateSet.candidates = candidateSet.candidates.slice(0, 2);
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  assert.equal(validateCandidateSet(candidateSet, { expectedSkinIds: [] }).valid, true);

  const sourceHashes = makeSourceHashes();
  const captures = Object.fromEntries(
    candidateSet.candidates.map((candidate) => [
      candidate.id,
      {
        candidateId: candidate.id,
        skinId: candidate.skinId,
        variant: candidate.variant,
        dir: `C:/synthetic-captures/${candidate.id}`,
        relativePath: `captures/${candidate.id}`,
        capture: {
          schemaVersion: 1,
          kind: "skin-palette-capture-matrix",
          candidate: {
            id: candidate.id,
            candidateHash: candidate.candidateHash,
            skinId: candidate.skinId,
          },
          sourceHashes: { ...sourceHashes },
        },
        progress: null,
        images: [],
      },
    ]),
  );
  return {
    evidence: {
      schemaVersion: 1,
      run: { relativePath: "synthetic-run" },
      candidateSet: { data: candidateSet, coverage: { candidateCount: candidateSet.candidates.length } },
      review: { present: false },
      visualReview: { present: false },
      selections: { present: false },
      captures,
      capturesMissing: [],
      origins: { source: "internal", origins: {}, missingCandidateIds: [] },
      gaps: [],
    },
    beforeSourceHashes: makeSourceHashes(),
  };
}

function makeProductionManifestOrigin(candidateSet) {
  return {
    runDir: "docs/validation/d7a-origin/current-run",
    candidateCapturesIndex: {
      path: "docs/validation/d7a-origin/current-run/captures-index.custom.json",
      fileSha256: "a".repeat(64),
    },
    candidateSet: {
      path: "candidates.json",
      fileSha256: "b".repeat(64),
      candidateSetHash: candidateSet.candidateSetHash,
    },
    assessment: { path: "assessments.json", fileSha256: "c".repeat(64), assessmentHash: "d".repeat(64) },
    selections: { path: "selections.json", fileSha256: "e".repeat(64), recordHash: "f".repeat(64) },
    captureRecords: Object.fromEntries(
      candidateSet.candidates.map((candidate, index) => [
        candidate.id,
        {
          capturePath: `docs/validation/d7a-origin/${index === 0 ? "older-run-a" : "older-run-b"}/${candidate.id}/capture.json`,
          fileSha256: "1".repeat(64),
          sourceHashesHash: "2".repeat(64),
        },
      ]),
    ),
  };
}

function makeManifestCandidateSet() {
  return makeSourceOriginsFixture().evidence.candidateSet.data;
}

function manifestHash(index) {
  return (index % 16).toString(16).repeat(64);
}

function makeProductionSourceManifest(candidateSet) {
  const assets = enumerateSourceAssets();
  return {
    schemaVersion: 1,
    kind: "skin-palette-production-source-manifest",
    origin: makeProductionManifestOrigin(candidateSet),
    preMigration: { precheck: { path: "integration-precheck.json", fileSha256: "a".repeat(64) } },
    after: {
      sourceHashes: Object.fromEntries(SOURCE_FILES.map((file, index) => [file, manifestHash(index)])),
      generatedAssets: {
        assetManifestSha256: "b".repeat(64),
        sourceAssetHashes: Object.fromEntries(
          assets.map(({ sourcePath }, index) => [sourcePath, manifestHash(index + 1)]),
        ),
        publicAssetHashes: Object.fromEntries(
          assets.map(({ publicPath }, index) => [publicPath, manifestHash(index + 2)]),
        ),
      },
      toolHashes: Object.fromEntries(GENERATED_ASSET_TOOL_FILES.map((file, index) => [file, manifestHash(index + 3)])),
    },
  };
}

function makeManifestForReaderRun(candidateSet, runDir) {
  const manifest = makeProductionSourceManifest(candidateSet);
  const runPath = path.relative(REPO_ROOT, runDir).split(path.sep).join("/");
  const originRun = `${runPath}/unread-origin-run`;
  manifest.origin.runDir = originRun;
  manifest.origin.candidateCapturesIndex.path = `${originRun}/captures-index.v1.json`;
  for (const [index, candidate] of candidateSet.candidates.entries()) {
    manifest.origin.captureRecords[candidate.id].capturePath =
      `${originRun}/capture-${index}/${candidate.id}/capture.json`;
  }
  return manifest;
}

async function withProductionOriginMetadataFixture(callback) {
  await withProductionRun(async ({ testRoot, runDir }) => {
    const candidateSet = makeManifestCandidateSet();
    const manifest = makeProductionSourceManifest(candidateSet);
    const runPath = path.relative(REPO_ROOT, runDir).split(path.sep).join("/");
    const indexDir = path.join(testRoot, "separate-index-run");
    await fs.promises.mkdir(indexDir);
    const indexPath = path.join(indexDir, "captures-index.fixture.json");
    const indexRelativePath = path.relative(REPO_ROOT, indexPath).split(path.sep).join("/");
    manifest.origin.runDir = runPath;
    manifest.origin.candidateCapturesIndex.path = indexRelativePath;

    const assessmentCore = {
      schemaVersion: 1,
      candidateSetHash: candidateSet.candidateSetHash,
      assessments: candidateSet.candidates.map(({ id: candidateId, candidateHash }) => ({
        candidateId,
        candidateHash,
        readiness: "ready",
      })),
    };
    const assessment = { ...assessmentCore, assessmentHash: sha256Canonical(assessmentCore) };
    const choices = {
      [candidateSet.candidates[0].skinId]: {
        candidateId: candidateSet.candidates[0].id,
        candidateHash: candidateSet.candidates[0].candidateHash,
      },
    };
    const selection = {
      schemaVersion: 1,
      kind: "skin-palette-selection-draft",
      candidateSetHash: candidateSet.candidateSetHash,
      assessmentHash: assessment.assessmentHash,
      choices,
      decisionSource: "D8a-1 synthetic fixture",
      recordedAt: "2026-10-10T00:00:00.000Z",
      missingSkinIds: SKIN_IDS.filter((skinId) => !Object.hasOwn(choices, skinId)),
    };
    const index = { schemaVersion: 1, captures: [] };
    const filePaths = {
      candidateSet: path.join(runDir, "candidates.json"),
      assessment: path.join(runDir, "assessments.json"),
      selection: path.join(runDir, "selections.json"),
      index: indexPath,
    };
    const values = { candidateSet, assessment, selection, index };
    const fileBytes = {};
    for (const key of Object.keys(filePaths)) {
      const bytes = Buffer.from(`${JSON.stringify(values[key])}\n`, "utf8");
      await fs.promises.writeFile(filePaths[key], bytes);
      fileBytes[key] = bytes;
    }
    manifest.origin.candidateSet.fileSha256 = hashBytes(fileBytes.candidateSet);
    manifest.origin.assessment.fileSha256 = hashBytes(fileBytes.assessment);
    manifest.origin.assessment.assessmentHash = assessment.assessmentHash;
    manifest.origin.selections.fileSha256 = hashBytes(fileBytes.selection);
    manifest.origin.selections.recordHash = sha256Canonical(selection);
    manifest.origin.candidateCapturesIndex.fileSha256 = hashBytes(fileBytes.index);

    const sourceHashes = makeSourceHashes();
    const capturePaths = {};
    const captureBytes = {};
    const captureValues = {};
    const captures = {};
    for (const [index, candidate] of candidateSet.candidates.entries()) {
      const captureDir = path.join(testRoot, `capture-run-${index}`, candidate.id);
      await fs.promises.mkdir(captureDir, { recursive: true });
      const capture = {
        schemaVersion: 1,
        kind: "skin-palette-capture-matrix",
        candidate: { id: candidate.id, candidateHash: candidate.candidateHash, skinId: candidate.skinId },
        sourceHashes: { ...sourceHashes },
      };
      const capturePath = path.join(captureDir, "capture.json");
      const capturePathRelative = path.relative(REPO_ROOT, capturePath).split(path.sep).join("/");
      const bytes = Buffer.from(`${JSON.stringify(capture)}\n`, "utf8");
      await fs.promises.writeFile(capturePath, bytes);
      manifest.origin.captureRecords[candidate.id].capturePath = capturePathRelative;
      manifest.origin.captureRecords[candidate.id].fileSha256 = hashBytes(bytes);
      manifest.origin.captureRecords[candidate.id].sourceHashesHash = sha256Canonical(capture.sourceHashes);
      capturePaths[candidate.id] = capturePath;
      captureBytes[candidate.id] = bytes;
      captureValues[candidate.id] = capture;
      captures[candidate.id] = {
        candidateId: candidate.id,
        skinId: candidate.skinId,
        variant: candidate.variant,
        dir: captureDir,
        relativePath: path.relative(runDir, captureDir).split(path.sep).join("/"),
        capture: structuredClone(capture),
        progress: null,
        images: [],
      };
    }

    const manifestRecord = {
      manifestPath: `${runPath}/production-source-manifest.json`,
      manifestFileSha256: "9".repeat(64),
      manifest,
    };
    const evidence = {
      schemaVersion: 1,
      run: {
        id: "d8a-1-synthetic-run",
        dir: runDir,
        relativePath: runPath,
        candidatesPath: "candidates.json",
        index: { path: indexPath, relativePath: indexRelativePath },
      },
      candidateSet: {
        data: structuredClone(candidateSet),
        coverage: { candidateCount: candidateSet.candidates.length },
      },
      review: {
        present: true,
        path: "assessments.json",
        container: structuredClone(assessment),
        missingCandidateIds: [],
      },
      selections: { present: true, path: "selections.json", record: structuredClone(selection), binding: null },
      captures,
    };
    await callback({
      testRoot,
      runDir,
      indexDir,
      indexPath,
      candidateSet,
      manifestRecord,
      evidence,
      filePaths,
      fileBytes,
      capturePaths,
      captureBytes,
      captureValues,
      sourceHashes,
      assessment,
    });
  });
}

async function withProductionHistoricalContextFixture(callback) {
  await withProductionOriginMetadataFixture(async (fixture) => {
    const { testRoot, runDir, candidateSet, manifestRecord, capturePaths, captureValues, filePaths } = fixture;
    const manifestRunDir = path.join(testRoot, "manifest-run");
    await fs.promises.mkdir(manifestRunDir);

    const assessmentCore = {
      schemaVersion: 1,
      candidateSetHash: candidateSet.candidateSetHash,
      assessments: candidateSet.candidates.map(({ id: candidateId, candidateHash }) => ({
        schemaVersion: 1,
        candidateId,
        candidateHash,
        fast: [],
        browser: [],
        visual: { reviewed: true, verdict: "pass", notes: "two-candidate reader fixture" },
        readiness: "ready",
        failures: [],
        unmeasured: [],
        diagnostics: {},
      })),
    };
    const assessment = { ...assessmentCore, assessmentHash: sha256Canonical(assessmentCore) };
    const assessmentBytes = Buffer.from(`${JSON.stringify(assessment)}\n`, "utf8");
    await fs.promises.writeFile(filePaths.assessment, assessmentBytes);
    manifestRecord.manifest.origin.assessment.fileSha256 = hashBytes(assessmentBytes);
    manifestRecord.manifest.origin.assessment.assessmentHash = assessment.assessmentHash;

    const integration = makeIntegrationPrecheck();
    const precheckContent = { ...integration.precheck, generatedAssets: makePreMigrationGeneratedAssets() };
    for (const candidate of candidateSet.candidates) {
      const capture = { ...captureValues[candidate.id], sourceHashes: { ...precheckContent.sourceHashes } };
      const bytes = Buffer.from(`${JSON.stringify(capture)}\n`, "utf8");
      await fs.promises.writeFile(capturePaths[candidate.id], bytes);
      const record = manifestRecord.manifest.origin.captureRecords[candidate.id];
      record.fileSha256 = hashBytes(bytes);
      record.sourceHashesHash = sha256Canonical(capture.sourceHashes);
    }

    const capturesIndexPath = path.join(runDir, "captures-index-d9b.json");
    const capturesIndex = {
      schemaVersion: 1,
      captures: Object.fromEntries(
        candidateSet.candidates.map((candidate) => [
          candidate.id,
          path.relative(runDir, path.dirname(capturePaths[candidate.id])).split(path.sep).join("/"),
        ]),
      ),
    };
    const capturesIndexBytes = Buffer.from(`${JSON.stringify(capturesIndex)}\n`, "utf8");
    await fs.promises.writeFile(capturesIndexPath, capturesIndexBytes);
    manifestRecord.manifest.origin.candidateCapturesIndex.path = path
      .relative(REPO_ROOT, capturesIndexPath)
      .split(path.sep)
      .join("/");
    manifestRecord.manifest.origin.candidateCapturesIndex.fileSha256 = hashBytes(capturesIndexBytes);
    await fs.promises.rm(filePaths.selection, { force: true });

    const precheck = await writeIntegrationPrecheck(manifestRunDir, precheckContent);
    await writeSourcePreimages(manifestRunDir, integration.sourceSnapshot);
    manifestRecord.manifest.preMigration.precheck.fileSha256 = precheck.sha256;
    const manifestFilePath = path.join(manifestRunDir, "production-source-manifest.json");
    await fs.promises.writeFile(manifestFilePath, `${JSON.stringify(manifestRecord.manifest)}\n`, "utf8");

    const evidence = await loadReviewEvidence({
      runDir: path.relative(REPO_ROOT, runDir).split(path.sep).join("/"),
      capturesIndexPath: path.relative(REPO_ROOT, capturesIndexPath).split(path.sep).join("/"),
    });
    await callback({
      ...fixture,
      manifestRunDir,
      manifestFilePath,
      capturesIndexPath,
      capturePaths,
      evidence,
      precheckPath: precheck.filePath,
      precheckBytes: precheck.bytes,
      sourceSnapshot: integration.sourceSnapshot,
      sourceHashes: integration.precheck.sourceHashes,
    });
  });
}

function nullPrototypeRecords(value) {
  if (Array.isArray(value)) return value.map(nullPrototypeRecords);
  if (value && typeof value === "object") {
    return Object.assign(
      Object.create(null),
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullPrototypeRecords(item)])),
    );
  }
  return value;
}

async function writeIntegrationPrecheck(runDir, precheck) {
  const filePath = path.join(runDir, "integration-precheck.json");
  const bytes = Buffer.from(`${JSON.stringify(precheck)}\n`);
  await fs.promises.writeFile(filePath, bytes);
  return { filePath, bytes, sha256: hashBytes(bytes) };
}

async function writeSourcePreimages(runDir, sourceSnapshot) {
  for (const file of SOURCE_PREIMAGE_FILES) {
    const filePath = path.join(runDir, "source-before", ...file.split("/"));
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, sourceSnapshot[file]);
  }
}

async function writeCurrentSourceFixture(rootDir, prefix = "offline source fixture") {
  const sourceBytes = {};
  for (const file of SOURCE_FILES) {
    const filePath = path.join(rootDir, ...file.split("/"));
    const bytes = Buffer.from(`${prefix}: ${file}\n`, "utf8");
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, bytes);
    sourceBytes[file] = bytes;
  }
  return sourceBytes;
}

async function writeGeneratedAssetFixture(rootDir, manifestBytes = Buffer.from("missing/manifest-derived/path\n")) {
  const assets = enumerateSourceAssets();
  const sourceBytes = {};
  const publicBytes = {};
  for (const [index, asset] of assets.entries()) {
    for (const [file, bytesMap, prefix] of [
      [asset.sourcePath, sourceBytes, "source"],
      [asset.publicPath, publicBytes, "public"],
    ]) {
      const bytes = Buffer.from(`${prefix}:${index}:${file}\n`, "utf8");
      const filePath = path.join(rootDir, ...file.split("/"));
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, bytes);
      bytesMap[file] = bytes;
    }
  }
  const toolBytes = {};
  for (const [index, file] of GENERATED_ASSET_TOOL_FILES.entries()) {
    const bytes = Buffer.from(`tool:${index}:${file}\n`, "utf8");
    const filePath = path.join(rootDir, ...file.split("/"));
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, bytes);
    toolBytes[file] = bytes;
  }
  const manifestPath = path.join(rootDir, "public", "skin-assets.json");
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.promises.writeFile(manifestPath, manifestBytes);
  return { assets, sourceBytes, publicBytes, toolBytes, manifestBytes };
}

function makeGeneratedAssetManifest(snapshot, assets = enumerateSourceAssets()) {
  return {
    generatedBy: "scripts/prepare-skin-assets.mjs",
    encodingGeneratedBy: "docs/validation/2026-10-02-model-character-skins/generate-skin-webp.py",
    transform: "descriptive text is not proof",
    note: "../../arbitrary/path/is-not-read",
    assets: Object.fromEntries(
      assets.map((asset) => [
        asset.publicUrl,
        {
          skinId: asset.skinId,
          mode: asset.mode,
          view: asset.view,
          sourcePath: asset.sourcePath,
          publicPath: asset.publicPath,
          expectedName: asset.expectedName,
          sourceBytes: "not checked in D6b",
          sourceSha256: snapshot.sourceAssetHashes[asset.sourcePath],
          publicBytes: -1,
          publicSha256: snapshot.publicAssetHashes[asset.publicPath],
          alphaMaxDelta: 0,
          rgbMaxDeltaVisible: 0,
          transparentRgbReduced: "not checked in D6b",
        },
      ]),
    ),
  };
}

function snapshotWithGeneratedManifest(snapshot, manifest) {
  const assetManifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return {
    ...snapshot,
    assetManifestBytes,
    assetManifestSha256: hashBytes(assetManifestBytes),
  };
}

function copyGeneratedAssetSnapshot(snapshot) {
  return {
    ...snapshot,
    assetManifestBytes: Buffer.from(snapshot.assetManifestBytes),
    sourceAssetHashes: { ...snapshot.sourceAssetHashes },
    publicAssetHashes: { ...snapshot.publicAssetHashes },
    toolHashes: { ...snapshot.toolHashes },
  };
}

function makeAssetTransitionInputs() {
  const preMigration = makePreMigrationGeneratedAssets();
  const currentAssets = {
    rootDir: "opaque synthetic root",
    assetManifestBytes: Buffer.alloc(0),
    assetManifestSha256: "0".repeat(64),
    sourceAssetHashes: { ...preMigration.sourceAssetHashes },
    publicAssetHashes: { ...preMigration.publicAssetHashes },
    toolHashes: Object.fromEntries(GENERATED_ASSET_TOOL_FILES.map((file, index) => [file, manifestHash(index + 8)])),
  };
  const assetManifestBytes = Buffer.from(JSON.stringify(makeGeneratedAssetManifest(currentAssets)), "utf8");
  currentAssets.assetManifestBytes = assetManifestBytes;
  currentAssets.assetManifestSha256 = hashBytes(assetManifestBytes);

  const candidateSet = makeManifestCandidateSet();
  const precheckFileSha256 = "e".repeat(64);
  const runPath = "docs/validation/d7e/synthetic-run";
  const generatedAssets = {
    assetManifestSha256: currentAssets.assetManifestSha256,
    sourceAssetHashes: { ...currentAssets.sourceAssetHashes },
    publicAssetHashes: { ...currentAssets.publicAssetHashes },
  };
  const manifest = makeProductionSourceManifest(candidateSet);
  manifest.preMigration.precheck.fileSha256 = precheckFileSha256;
  manifest.after.generatedAssets = structuredClone(generatedAssets);
  manifest.after.toolHashes = { ...currentAssets.toolHashes };
  return {
    manifestRecord: {
      manifestPath: `${runPath}/production-source-manifest.json`,
      manifestFileSha256: "f".repeat(64),
      manifest,
    },
    preMigrationAssets: {
      precheckPath: `${runPath}/integration-precheck.json`,
      precheckFileSha256,
      generatedAssets,
    },
    currentAssets,
    candidateSet,
  };
}

function copyAssetTransitionInputs(inputs) {
  return {
    manifestRecord: {
      ...inputs.manifestRecord,
      manifest: structuredClone(inputs.manifestRecord.manifest),
    },
    preMigrationAssets: structuredClone(inputs.preMigrationAssets),
    currentAssets: copyGeneratedAssetSnapshot(inputs.currentAssets),
    candidateSet: structuredClone(inputs.candidateSet),
  };
}

function refreshAssetTransitionManifest(snapshot) {
  const bytes = Buffer.from(JSON.stringify(makeGeneratedAssetManifest(snapshot)), "utf8");
  snapshot.assetManifestBytes = bytes;
  snapshot.assetManifestSha256 = hashBytes(bytes);
}

const EVIDENCE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const STATE_BY_ID = new Map(STATE_CATALOG.map((state) => [state.id, state]));

async function hashStateEvidenceTreeLike(rootDir) {
  const entries = [];
  const walk = async (directory) => {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`fixture evidence contains a symlink: ${absolutePath}`);
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!child.isFile()) throw new Error(`fixture evidence contains a non-file: ${absolutePath}`);
      const bytes = await fs.promises.readFile(absolutePath);
      entries.push({
        file: path.relative(rootDir, absolutePath).split(path.sep).join("/"),
        sha256: hashBytes(bytes),
        bytes: bytes.length,
      });
    }
  };
  await walk(rootDir);
  return sha256Canonical(entries);
}

async function writeFixtureJson(filePath, value) {
  await fs.promises.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeProductionStateUnit({ outDir, mode, unit, skinId, patches = {} }) {
  const unitDir = path.join(outDir, mode, "states", unit.id);
  await fs.promises.mkdir(unitDir, { recursive: true });
  const stateId = unit.stateId ?? null;
  const catalogState = stateId === null ? null : STATE_BY_ID.get(stateId);
  if (stateId !== null && !catalogState) throw new TypeError(`unknown test state: ${stateId}`);
  const expectedRoleIds = catalogState?.expectedRoleIds ?? [];
  const records = makeFixtureRoleRecords(expectedRoleIds, stateId, mode);
  const files = {
    state: "state.json",
    checks: "checks.json",
    geometry: "geometry.json",
    stateScreenshot: "state.png",
  };
  const trace = { roleScopeGaps: [] };
  if (unit.fixtureRequirement) {
    const { name, expectedHash } = unit.fixtureRequirement;
    // 合成测试证明只维持状态读取样本完整，不代表真实 fixture 采样。
    trace.fixtureRequirement = { name, expectedHash, actualHash: expectedHash, match: true };
  }
  const state = {
    kind: "skin-palette-capture-state",
    status: "captured",
    unitId: unit.id,
    mode,
    skinId,
    stateId,
    files,
    screenshots: { state: "state.png" },
    captures: [],
    trace,
  };
  const checks = {
    schemaVersion: 1,
    kind: "skin-palette-capture-checks",
    status: "captured",
    unitId: unit.id,
    stateId,
    mode,
    candidateId: null,
    records,
    captureIndex: [],
  };
  const geometry = { unitId: unit.id, stateId, mode, skinId };
  const timelineFiles = [];
  const timelineModes = unit.timelineModeSequence ?? [];
  if (timelineModes.length > 0) {
    state.measurementVariants = {};
    state.trace.timelineModes = { checks: [] };
    for (const viewMode of timelineModes) {
      const checksFile = `checks.timeline-${viewMode}.json`;
      const captureFile = `timeline-${viewMode}-1.png`;
      const captureIndex = [{ index: 1, roleId: null, kind: "timeline", file: captureFile }];
      const timelineChecks = {
        schemaVersion: 1,
        kind: "skin-palette-capture-checks",
        status: "captured",
        unitId: unit.id,
        stateId,
        mode,
        viewMode,
        candidateId: null,
        records,
        captureIndex,
      };
      const prefix = `timeline${viewMode[0].toUpperCase()}${viewMode.slice(1)}`;
      files[`${prefix}Checks`] = checksFile;
      state.measurementVariants[viewMode] = { checks: checksFile, captureIndex };
      state.trace.timelineModes.checks.push({
        mode: viewMode,
        measurementEvidence: { checks: checksFile, recordCount: records.length, captureCount: 1 },
      });
      timelineFiles.push({ viewMode, checksFile, captureFile, checks: timelineChecks, captureIndex });
    }
  }

  patches.state?.(state);
  patches.checks?.(checks);
  patches.geometry?.(geometry);
  for (const timeline of timelineFiles) patches.timeline?.(timeline, state);

  await writeFixtureJson(path.join(unitDir, "state.json"), state);
  await writeFixtureJson(path.join(unitDir, "checks.json"), checks);
  await writeFixtureJson(path.join(unitDir, "geometry.json"), geometry);
  await fs.promises.writeFile(path.join(unitDir, "state.png"), EVIDENCE_PNG);
  for (const { checksFile, captureFile, checks: timelineChecks } of timelineFiles) {
    await writeFixtureJson(path.join(unitDir, checksFile), timelineChecks);
    await fs.promises.writeFile(path.join(unitDir, captureFile), EVIDENCE_PNG);
  }
  return hashStateEvidenceTreeLike(unitDir);
}

async function createBoundStateCapture({
  candidate,
  outDir,
  runDir,
  selections,
  verifiedModel,
  capturedUnits,
  statePatches = {},
  progressHashOverrides = {},
  capturedBaselineModes = [],
  baselineOptions = {},
  baselineEvidencePatches = {},
  sourceHashes,
  captureMetadata = {},
  modeStatusOverrides = {},
} = {}) {
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const [baselineUnit] = units.filter((unit) => unit.kind === "baseline");
  const modes = {};
  const progressUnits = {};
  for (const mode of ["light", "dark"]) {
    const states = {};
    let baseline = null;
    for (const unit of units) {
      progressUnits[`${mode}/${unit.id}`] = { status: "incomplete", reason: "fixture unit not materialized" };
      if (unit.kind === "baseline") {
        baseline = { status: "incomplete", reason: "baseline evidence is outside this fixture" };
      } else {
        states[unit.id] = { status: "incomplete", reason: "fixture unit not materialized" };
      }
    }
    modes[mode] = { status: "incomplete", baseline, states };
  }

  for (const { mode, unitId } of capturedUnits) {
    const unit = units.find((entry) => entry.id === unitId && entry.kind !== "baseline");
    if (!unit) throw new TypeError(`unknown captured fixture unit: ${unitId}`);
    const key = `${mode}/${unitId}`;
    const evidenceHash = await writeProductionStateUnit({
      outDir,
      mode,
      unit,
      skinId: candidate.skinId,
      patches: statePatches[key] ?? {},
    });
    modes[mode].states[unitId] = { status: "captured" };
    const progressUnit = { status: "captured" };
    if (Object.hasOwn(progressHashOverrides, key)) {
      if (progressHashOverrides[key] !== undefined) progressUnit.evidenceHash = progressHashOverrides[key];
    } else {
      progressUnit.evidenceHash = evidenceHash;
    }
    progressUnits[key] = progressUnit;
  }

  for (const mode of capturedBaselineModes) {
    const key = `${mode}/${baselineUnit.id}`;
    const manifest = await writeProductionBaselineMode({
      modeDir: path.join(outDir, mode),
      mode,
      skinId: candidate.skinId,
      ...(baselineOptions[mode] ?? {}),
    });
    const progressUnit = { status: "captured" };
    const manifestPatch = baselineEvidencePatches[mode];
    if (manifestPatch !== "missing") {
      if (typeof manifestPatch === "function") manifestPatch(manifest);
      progressUnit.baselineEvidence = manifest;
    }
    progressUnits[key] = progressUnit;
    modes[mode].baseline = { status: "captured" };
  }

  for (const mode of ["light", "dark"]) {
    if (
      modes[mode].baseline.status === "captured" &&
      Object.values(modes[mode].states).every((state) => state.status === "captured")
    ) {
      modes[mode].status = "captured";
    }
  }
  for (const [mode, status] of Object.entries(modeStatusOverrides)) {
    if (!Object.hasOwn(modes, mode)) throw new TypeError(`unknown mode status override: ${mode}`);
    modes[mode].status = status;
  }

  const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir, modes });
  const groups = STATE_MATRIX_GROUPS.map((group) => group.id);
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  captureResult.capture.groups = groups;
  captureResult.capture.fixtureHash = fixtureHash;
  captureResult.capture.fixtureBindings = fixtureBindings;
  applyCaptureMetadata(captureResult.capture, captureMetadata);
  if (sourceHashes !== undefined) captureResult.capture.sourceHashes = sourceHashes;
  captureResult.progress.groups = [...groups];
  captureResult.progress.modes = ["light", "dark"];
  captureResult.progress.digests = { fixtureHash, fixtureBindings: structuredClone(fixtureBindings) };
  captureResult.progress.units = progressUnits;
  await writeMatrixFiles(outDir, captureResult);
  await writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult });
  return captureResult;
}

async function createSmallBoundProductionCapture({
  candidate,
  outDir,
  runDir,
  selections,
  verifiedModel,
  modeStatusOverrides = {},
} = {}) {
  return createBoundStateCapture({
    candidate,
    outDir,
    runDir,
    selections,
    verifiedModel,
    capturedUnits: [],
    sourceHashes: currentSourceHashes(),
    modeStatusOverrides,
  });
}

async function createBoundProductionSkinCaptures({
  runDir,
  defaultOutDir,
  selections,
  verifiedModel,
  skinIds,
  modeStatusBySkin = {},
} = {}) {
  const captures = {};
  for (const skinId of skinIds) {
    const candidateId = selections.choices[skinId].candidateId;
    const candidate = verifiedModel.candidateSet.candidates.find((entry) => entry.id === candidateId);
    const outDir = path.join(path.dirname(defaultOutDir), `capture-${skinId}`);
    await createSmallBoundProductionCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      modeStatusOverrides: modeStatusBySkin[skinId] ?? {},
    });
    captures[skinId] = path.relative(runDir, outDir).split(path.sep).join("/");
  }
  return captures;
}

async function writeProductionIndexValue(runDir, captures, relativeFile = "captures-index.json") {
  const filePath = path.join(runDir, relativeFile);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const index = { schemaVersion: 1, captures };
  await writeFixtureJson(filePath, index);
  return { filePath, index };
}

async function snapshotFixtureTree(rootDir) {
  const snapshot = {};
  const walk = async (directory) => {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
      if (child.isDirectory()) await walk(absolutePath);
      else if (child.isSymbolicLink()) snapshot[relativePath] = "symlink";
      else snapshot[relativePath] = hashBytes(await fs.promises.readFile(absolutePath));
    }
  };
  await walk(rootDir);
  return snapshot;
}

async function writeProductionBaselineMode({ modeDir, mode, skinId, measureRoles = true, jsonPatches = {} }) {
  await fs.promises.mkdir(modeDir, { recursive: true });
  const jsonBody = (extra) => Buffer.from(`${JSON.stringify({ mode, skinId, ...extra })}\n`, "utf8");
  const roleIds = STATE_BY_ID.get("dashboard-default").expectedRoleIds;
  const records = makeFixtureRoleRecords(roleIds, "dashboard-default", mode);
  const checks = {
    stateId: "dashboard-default",
    mode,
    candidateId: null,
    records,
    counts: { records: records.length },
    diagnostics: { source: "c3c-production-fixture" },
    captureIndex: [{ index: 1, roleId: records[0]?.roleId ?? null, kind: "baseline", file: "captures/measure-1.png" }],
  };
  const fileDefs = [
    ["baseline.png", EVIDENCE_PNG],
    [
      "colors.json",
      jsonBody({ runtimeMatchesExpected: true, firstScreenMatchesRuntime: true, spotlight: { off: true } }),
    ],
    ["first-screen.json", jsonBody({ matches: true })],
    ["first-screen.png", EVIDENCE_PNG],
    ["layout.json", jsonBody({})],
  ];
  if (measureRoles) {
    fileDefs.push(["checks.json", Buffer.from(`${JSON.stringify(checks)}\n`, "utf8")]);
    fileDefs.push(["captures/measure-1.png", EVIDENCE_PNG]);
  }
  const entries = [];
  for (const [file, originalBytes] of fileDefs) {
    let bytes = originalBytes;
    if (jsonPatches[file]) {
      const patched = jsonPatches[file](JSON.parse(bytes.toString("utf8")));
      bytes = Buffer.from(`${JSON.stringify(patched)}\n`, "utf8");
    }
    const filePath = path.join(modeDir, ...file.split("/"));
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, bytes);
    entries.push({ file, sha256: hashBytes(bytes), bytes: bytes.length });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file));
  return { schemaVersion: 1, measureRoles, files: entries, sha256: sha256Canonical(entries) };
}

async function createBoundBaselineCapture({
  candidate,
  outDir,
  runDir,
  selections,
  verifiedModel,
  capturedModes = ["light", "dark"],
  baselineOptions = {},
  baselineEvidencePatches = {},
} = {}) {
  const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const baseline = units.find((unit) => unit.kind === "baseline");
  const modes = {};
  const progressUnits = {};
  for (const mode of ["light", "dark"]) {
    const states = {};
    for (const unit of units) {
      progressUnits[`${mode}/${unit.id}`] = { status: "incomplete", reason: "S0 fixture state not captured" };
      if (unit.kind !== "baseline") states[unit.id] = { status: "incomplete", reason: "S0 fixture state not captured" };
    }
    modes[mode] = {
      status: "incomplete",
      baseline: { status: "incomplete", reason: "S0 fixture mode not captured" },
      states,
    };
  }
  for (const mode of capturedModes) {
    const progressKey = `${mode}/${baseline.id}`;
    const manifest = await writeProductionBaselineMode({
      modeDir: path.join(outDir, mode),
      mode,
      skinId: candidate.skinId,
      ...(baselineOptions[mode] ?? {}),
    });
    const progressUnit = { status: "captured" };
    const manifestPatch = baselineEvidencePatches[mode];
    if (manifestPatch !== "missing") {
      if (typeof manifestPatch === "function") manifestPatch(manifest);
      progressUnit.baselineEvidence = manifest;
    }
    modes[mode].baseline = { status: "captured" };
    progressUnits[progressKey] = progressUnit;
  }
  const captureResult = makeProductionMatrixResult({
    skinId: candidate.skinId,
    outDir,
    modes,
    groups: STATE_MATRIX_GROUPS.map((group) => group.id),
  });
  captureResult.progress.units = progressUnits;
  await writeMatrixFiles(outDir, captureResult);
  await writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult });
  return captureResult;
}

async function writeMatrixFiles(outDir, captureResult) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const captureBytes = Buffer.from(`${JSON.stringify(captureResult.capture)}\n`);
  const progressBytes = Buffer.from(`${JSON.stringify(captureResult.progress)}\n`);
  await fs.promises.writeFile(path.join(outDir, "capture.json"), captureBytes);
  await fs.promises.writeFile(path.join(outDir, "progress.json"), progressBytes);
  return { captureBytes, progressBytes };
}

async function withProductionRun(callback, { productionSkinIds = [SKIN_IDS[0]] } = {}) {
  const testRoot = await fs.promises.mkdtemp(path.join(validationRoot, "m4-4-7-b2a-"));
  const runDir = path.join(testRoot, "source-run");
  const outDir = path.join(testRoot, "capture-output");
  const verifiedModel = makeVerifiedModel({ productionSkinIds });
  const selections = makeSelections(verifiedModel);
  const candidate = verifiedModel.candidateSet.candidates.find(
    (item) => item.skinId === SKIN_IDS[0] && item.variant === "a",
  );
  try {
    await fs.promises.mkdir(runDir);
    await fs.promises.writeFile(
      path.join(runDir, "candidates.json"),
      `${JSON.stringify(verifiedModel.candidateSet)}\n`,
      "utf8",
    );
    await callback({ candidate, outDir, runDir, selections, testRoot, verifiedModel });
  } finally {
    const relative = path.relative(validationRoot, testRoot);
    assert.ok(
      relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "test cleanup target must be inside docs/validation",
    );
    await fs.promises.rm(testRoot, { recursive: true, force: true });
  }
}

function palettesFor(candidate) {
  return {
    [candidate.skinId]: {
      light: { ...candidate.modes.light },
      dark: { ...candidate.modes.dark },
    },
  };
}

function defaultCandidate() {
  const modes = Object.fromEntries(
    ["light", "dark"].map((mode) => [
      mode,
      Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, SKIN_PALETTES.chatgpt[mode][key].trim().toUpperCase()])),
    ]),
  );
  return makeCandidate(modes);
}

test("default SKIN_PALETTES path matches all 24 registered chatgpt values", () => {
  const candidate = defaultCandidate();
  assert.equal(validateCandidate(candidate).valid, true);
  assert.deepEqual(compareProductionTokens({ candidate }), { matches: true, differences: [] });
});

test("fixture hash getter is stable, valid, and does not create a temporary fixture", () => {
  const first = getPaletteFixtureHash();
  const second = getPaletteFixtureHash();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first);
  // Other test processes own their fixtures; only observe this child's isolated temp directory.
  const isolatedTemp = fs.mkdtempSync(path.join(tmpdir(), "skin-palette-hash-getter-"));
  try {
    const fixtureUrl = new URL("../test-support/skin-palette-fixture.mjs", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { getPaletteFixtureHash } from ${JSON.stringify(fixtureUrl)};
         console.log(JSON.stringify([getPaletteFixtureHash(), getPaletteFixtureHash()]));`,
      ],
      {
        env: { ...process.env, TMP: isolatedTemp, TEMP: isolatedTemp, TMPDIR: isolatedTemp },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    assert.deepEqual(JSON.parse(child.stdout), [first, first]);
    assert.deepEqual(fs.readdirSync(isolatedTemp), []);
  } finally {
    fs.rmSync(isolatedTemp, { recursive: true, force: true });
  }
});

test("production context checks actual fixture and policy hashes with fixed diagnostics", () => {
  const candidate = makeCandidate({ policyHash: currentPolicyHash() });
  const validCapture = makeContextCaptureResult(candidate);
  assert.equal(validCapture.capture.fixtureHash, getPaletteFixtureHash());
  assert.equal(validCapture.capture.policyHash, currentPolicyHash());
  assert.deepEqual(verifyProductionContext({ skinId: candidate.skinId, captureResult: validCapture, candidate }), {
    status: "pass",
    errors: [],
    gaps: [],
  });

  const missingBindings = makeContextCaptureResult(candidate);
  delete missingBindings.capture.fixtureBindings;
  delete missingBindings.progress.digests.fixtureBindings;
  const incompleteBindings = verifyProductionContext({
    skinId: candidate.skinId,
    captureResult: missingBindings,
    candidate,
  });
  assert.equal(incompleteBindings.status, "incomplete");
  assert.deepEqual(incompleteBindings.errors, []);
  assert.deepEqual(
    incompleteBindings.gaps.map(({ code }) => code),
    ["fixture-bindings-missing", "fixture-bindings-missing"],
    "context propagates only missing header bindings, not other capture summary statuses",
  );

  for (const metadata of [
    { fixtureHash: undefined },
    { fixtureHash: null },
    { fixtureHash: "x".repeat(64) },
    { fixtureHash: "e".repeat(64) },
  ]) {
    assert.throws(
      () =>
        verifyProductionContext({
          skinId: candidate.skinId,
          captureResult: makeContextCaptureResult(candidate, metadata),
          candidate,
        }),
      /capture fixture binding header is invalid/,
    );
  }

  const legacyWarningOnly = makeContextCaptureResult(candidate);
  legacyWarningOnly.capture.groups = ["S8"];
  legacyWarningOnly.capture.fixtureHash = getTimelineWarningFixtureHash();
  delete legacyWarningOnly.capture.fixtureBindings;
  legacyWarningOnly.progress.groups = ["S8"];
  legacyWarningOnly.progress.digests.fixtureHash = getTimelineWarningFixtureHash();
  delete legacyWarningOnly.progress.digests.fixtureBindings;
  const legacyContext = verifyProductionContext({
    skinId: candidate.skinId,
    captureResult: legacyWarningOnly,
    candidate,
  });
  assert.equal(legacyContext.status, "rejected", "warning-only legacy root cannot pass formal production context");
  assert.deepEqual(
    legacyContext.errors.map(({ code }) => code),
    ["fixture-changed"],
  );
  assert.deepEqual(
    legacyContext.gaps.map(({ code }) => code),
    ["fixture-bindings-missing", "fixture-bindings-missing"],
  );

  const cases = [
    {
      name: "missing policy",
      metadata: { policyHash: undefined },
      status: "incomplete",
      gaps: ["missing-policy-hash"],
    },
    { name: "null policy", metadata: { policyHash: null }, status: "incomplete", gaps: ["missing-policy-hash"] },
    {
      name: "invalid policy",
      metadata: { policyHash: "X".repeat(64) },
      status: "rejected",
      errors: ["invalid-policy-hash"],
    },
    {
      name: "changed policy",
      metadata: { policyHash: "f".repeat(64) },
      status: "rejected",
      errors: ["policy-changed"],
    },
    {
      name: "disabled baseline measurements",
      metadata: { measureBaseline: false },
      status: "incomplete",
      gaps: ["baseline-measurements-disabled"],
    },
    {
      name: "missing baseline declaration",
      metadata: { measureBaseline: undefined },
      status: "incomplete",
      gaps: ["missing-baseline-measurement-setting"],
    },
    {
      name: "null baseline declaration",
      metadata: { measureBaseline: null },
      status: "incomplete",
      gaps: ["missing-baseline-measurement-setting"],
    },
  ];
  for (const { name, metadata, status, errors = [], gaps = [] } of cases) {
    const captureResult = makeContextCaptureResult(candidate, metadata);
    const result = verifyProductionContext({ skinId: candidate.skinId, captureResult, candidate });
    assert.equal(result.status, status, name);
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      errors,
      name,
    );
    assert.deepEqual(
      result.gaps.map(({ code }) => code),
      gaps,
      name,
    );
  }

  const staleCandidate = candidateWithPolicyHash(candidate, "d".repeat(64));
  assert.equal(validateCandidate(staleCandidate).valid, true);
  const selectedPolicyDrift = verifyProductionContext({
    skinId: candidate.skinId,
    candidate: staleCandidate,
    captureResult: validCapture,
  });
  assert.equal(selectedPolicyDrift.status, "rejected");
  assert.deepEqual(
    selectedPolicyDrift.errors.map(({ code }) => code),
    ["selected-policy-drift"],
  );
  assert.deepEqual(selectedPolicyDrift.gaps, []);

  const combined = verifyProductionContext({
    skinId: candidate.skinId,
    candidate: staleCandidate,
    captureResult: makeContextCaptureResult(candidate, {
      policyHash: "f".repeat(64),
      measureBaseline: false,
    }),
  });
  assert.equal(combined.status, "rejected");
  assert.deepEqual(
    combined.errors.map(({ code }) => code),
    ["policy-changed", "selected-policy-drift"],
  );
  assert.deepEqual(
    combined.gaps.map(({ code }) => code),
    ["baseline-measurements-disabled"],
  );
});

test("production context rejects wrong candidate or capture identity and invalid measurement declarations", () => {
  const candidate = makeCandidate({ policyHash: currentPolicyHash() });
  const captureResult = makeContextCaptureResult(candidate);
  assert.throws(
    () =>
      verifyProductionContext({
        skinId: candidate.skinId,
        captureResult,
        candidate: makeCandidate({ skinId: "claude" }),
      }),
    /candidate\.skinId does not match/,
  );
  assert.throws(
    () =>
      verifyProductionContext({
        skinId: candidate.skinId,
        candidate,
        captureResult: { ...captureResult, skinId: "claude" },
      }),
    /captureResult skinId does not match capture\.candidate\.skinId/,
  );
  assert.throws(
    () =>
      verifyProductionContext({
        skinId: candidate.skinId,
        candidate,
        captureResult: makeContextCaptureResult(candidate, { measureBaseline: "true" }),
      }),
    /measureBaseline must be true/,
  );
});

test("trimmed, case-insensitive and equivalent short hex values compare by exact sRGB channels", () => {
  const candidate = makeCandidate({ light: tokens("#AABBCC"), dark: tokens("#AABBCC") });
  const source = palettesFor(candidate);
  source.chatgpt.light.pageBackground = "  #abc  ";
  source.chatgpt.dark.panelBackground = "#aAbBcC";

  assert.deepEqual(compareProductionTokens({ candidate, productionPalettes: source }), {
    matches: true,
    differences: [],
  });
});

test("all differences are returned in light/dark and registered-token order", () => {
  const candidate = makeCandidate();
  const source = palettesFor(candidate);
  source.chatgpt.light.pageBackground = "#FFFFFF";
  source.chatgpt.light.accent = "#000000";
  source.chatgpt.dark.chartText = "#010203";

  const result = compareProductionTokens({ candidate, productionPalettes: source });
  assert.equal(result.matches, false);
  assert.deepEqual(
    result.differences.map(({ mode, token }) => [mode, token]),
    [
      ["light", "pageBackground"],
      ["light", "accent"],
      ["dark", "chartText"],
    ],
  );
  assert.deepEqual(result.differences[0], {
    mode: "light",
    token: "pageBackground",
    code: "production-token-mismatch",
    expected: "#112233",
    actual: "#FFFFFF",
  });
});

test("one mismatch in either mode fails, and swapping light/dark cannot pass", () => {
  const candidate = makeCandidate();
  const source = palettesFor(candidate);
  source.chatgpt.dark.controlText = "#FFFFFF";
  const oneDarkMismatch = compareProductionTokens({ candidate, productionPalettes: source });
  assert.deepEqual(
    oneDarkMismatch.differences.map(({ mode, token }) => [mode, token]),
    [["dark", "controlText"]],
  );

  const swapped = {
    chatgpt: {
      light: { ...candidate.modes.dark },
      dark: { ...candidate.modes.light },
    },
  };
  const swappedResult = compareProductionTokens({ candidate, productionPalettes: swapped });
  assert.equal(swappedResult.matches, false);
  assert.equal(swappedResult.differences.length, 24);
  assert.deepEqual(
    swappedResult.differences.slice(0, 12).map((item) => item.mode),
    Array(12).fill("light"),
  );
  assert.deepEqual(
    swappedResult.differences.slice(12).map((item) => item.mode),
    Array(12).fill("dark"),
  );
});

test("missing skin, mode, null source and partial token set produce ordered missing-token diagnostics", () => {
  const candidate = makeCandidate();
  const missingSkin = compareProductionTokens({ candidate, productionPalettes: {} });
  assert.equal(missingSkin.differences.length, 24);
  assert.ok(missingSkin.differences.every((item) => item.code === "missing-production-token" && item.actual === null));

  const missingLight = compareProductionTokens({
    candidate,
    productionPalettes: { chatgpt: { dark: candidate.modes.dark } },
  });
  assert.equal(missingLight.differences.length, 12);
  assert.ok(
    missingLight.differences.every((item) => item.mode === "light" && item.code === "missing-production-token"),
  );

  const nullSkin = compareProductionTokens({ candidate, productionPalettes: { chatgpt: null } });
  assert.equal(nullSkin.differences.length, 24);

  const source = palettesFor(candidate);
  source.chatgpt.light.panelBorder = null;
  source.chatgpt.dark.chartText = " ";
  const partial = compareProductionTokens({ candidate, productionPalettes: source });
  assert.deepEqual(
    partial.differences.map(({ mode, token, code, actual }) => [mode, token, code, actual]),
    [
      ["light", "panelBorder", "missing-production-token", null],
      ["dark", "chartText", "missing-production-token", " "],
    ],
  );
});

test("CSS expressions and invalid hex are unsupported; non-string diagnostics do not expose values", () => {
  const candidate = makeCandidate();
  for (const [value, reported] of [
    ["rgba(1, 2, 3, 1)", "rgba(1, 2, 3, 1)"],
    ["#12GG00", "#12GG00"],
    [42, null],
    [{ secret: "not serialized" }, null],
  ]) {
    const source = palettesFor(candidate);
    source.chatgpt.light.pageBackground = value;
    const result = compareProductionTokens({ candidate, productionPalettes: source });
    assert.equal(result.matches, false);
    assert.deepEqual(result.differences[0], {
      mode: "light",
      token: "pageBackground",
      code: "unsupported-production-color",
      expected: "#112233",
      actual: reported,
    });
  }
});

test("inherited skin, mode and token values are not treated as production colors", () => {
  const candidate = makeCandidate();
  const source = palettesFor(candidate);
  const inheritedTokenPalette = Object.assign(Object.create({ pageBackground: "#112233" }), source.chatgpt.light);
  delete inheritedTokenPalette.pageBackground;
  source.chatgpt.light = inheritedTokenPalette;
  const inheritedToken = compareProductionTokens({ candidate, productionPalettes: source });
  assert.deepEqual(
    inheritedToken.differences.map(({ mode, token, code }) => [mode, token, code]),
    [["light", "pageBackground", "missing-production-token"]],
  );

  const inheritedModeSkin = Object.assign(Object.create({ light: candidate.modes.light }), {
    dark: candidate.modes.dark,
  });
  const inheritedMode = compareProductionTokens({ candidate, productionPalettes: { chatgpt: inheritedModeSkin } });
  assert.equal(inheritedMode.differences.length, 12);
  assert.ok(inheritedMode.differences.every((item) => item.mode === "light"));

  const inheritedSkin = Object.assign(Object.create({ chatgpt: source.chatgpt }), {});
  assert.throws(() => compareProductionTokens({ candidate, productionPalettes: inheritedSkin }), TypeError);
});

test("top-level source accepts null-prototype records and rejects arrays, classes and other prototypes", () => {
  const candidate = makeCandidate();
  const nullPrototype = Object.assign(Object.create(null), { chatgpt: palettesFor(candidate).chatgpt });
  assert.equal(compareProductionTokens({ candidate, productionPalettes: nullPrototype }).matches, true);

  class Source {}
  for (const productionPalettes of [[], new Source(), new Date(), null]) {
    assert.throws(() => compareProductionTokens({ candidate, productionPalettes }), TypeError);
  }
});

test("extra chartSeries is ignored and neither input is modified or frozen", () => {
  const candidate = makeCandidate();
  const source = palettesFor(candidate);
  source.chatgpt.light.chartSeries = ["not-a-palette-token"];
  const candidateBefore = JSON.stringify(candidate);
  const sourceBefore = JSON.stringify(source);

  assert.equal(compareProductionTokens({ candidate, productionPalettes: source }).matches, true);
  assert.equal(JSON.stringify(candidate), candidateBefore);
  assert.equal(JSON.stringify(source), sourceBefore);
  assert.equal(Object.isFrozen(candidate), false);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.chatgpt.light), false);
});

test("builds the selected palette by replacing exactly 240 source literal spans and is idempotent", () => {
  const sourcePath = path.join(REPO_ROOT, "public", "skin-palettes.js");
  const beforeSource = fs.readFileSync(sourcePath);
  const fileBefore = Buffer.from(beforeSource);
  const { verifiedModel, selections } = makeProductionSourceInputs();
  const modelBefore = JSON.stringify(verifiedModel);
  const selectionsBefore = JSON.stringify(selections);

  const output = buildProductionPaletteSource({ beforeSource, verifiedModel, selections });
  assertExactPaletteReplacement(beforeSource, output, verifiedModel, selections);
  assert.deepEqual(
    buildProductionPaletteSource({ beforeSource: output, verifiedModel, selections }),
    output,
    "applying the same complete selection twice is byte-idempotent",
  );
  assert.deepEqual(beforeSource, fileBefore);
  assert.deepEqual(fs.readFileSync(sourcePath), fileBefore, "the actual public palette file remains unchanged");
  assert.equal(JSON.stringify(verifiedModel), modelBefore);
  assert.equal(JSON.stringify(selections), selectionsBefore);
});

test("preserves original skin/mode order, CRLF, comments, and optional chartSeries bytes", () => {
  const sourcePath = path.join(REPO_ROOT, "public", "skin-palettes.js");
  const actualSource = fs.readFileSync(sourcePath, "utf8");
  const crlfSource = actualSource.replace(/\r?\n/g, "\r\n");
  const ast = testPaletteAst(crlfSource);
  const lightObject = testPalettePropertyFromAst(ast, SKIN_IDS[0], "light");
  const insertionPoint = lightObject.getStart(ast.sourceFile) + 1;
  const withChartSeries =
    crlfSource.slice(0, insertionPoint) +
    '\r\n      chartSeries: ["#010203", /* preserved chart series */ "#040506"],\r\n      ' +
    crlfSource.slice(insertionPoint);
  const beforeSource = Buffer.from(withChartSeries, "utf8");
  const { verifiedModel, selections } = makeProductionSourceInputs();

  const output = buildProductionPaletteSource({ beforeSource, verifiedModel, selections });

  assertExactPaletteReplacement(beforeSource, output, verifiedModel, selections);
  const outputText = output.toString("utf8");
  assert.equal(outputText.replaceAll("\r\n", "").includes("\n"), false, "CRLF style is preserved");
  assert.ok(outputText.includes("/* preserved chart series */"));
  assert.ok(outputText.includes("颜色写法"), "non-token documentation text is unchanged");
  assert.deepEqual(
    testTokenSpans(outputText).map(({ skinId, mode }) => `${skinId}.${mode}`),
    SKIN_IDS.flatMap((skinId) => [`${skinId}.light`, `${skinId}.dark`]).flatMap((mode) =>
      PALETTE_TOKEN_KEYS.map(() => mode),
    ),
    "the registration order remains skin, then light/dark mode, then registered token",
  );
});

test("rejects malformed, dynamic, duplicate, or incomplete palette source structures", () => {
  const sourceText = fs.readFileSync(path.join(REPO_ROOT, "public", "skin-palettes.js"), "utf8");
  const { verifiedModel, selections } = makeProductionSourceInputs();
  const modeObject = (ast) => testPalettePropertyFromAst(ast, SKIN_IDS[0], "light");
  const tokenProperty = (ast) => testPalettePropertyFromAst(ast, SKIN_IDS[0], "light", PALETTE_TOKEN_KEYS[0]);
  const skinProperty = (ast) => testStaticProperties(ast.palette).get(SKIN_IDS[0]);
  const modeProperty = (ast) => testStaticProperties(skinProperty(ast).initializer).get("dark");
  const modeAddition = (addition) => (source) => insertIntoTestObject(source, modeObject, `\n      ${addition}\n    `);
  const cases = [
    ["syntax error", (source) => `${source}\nconst = ;`],
    ["duplicate target declaration", (source) => `${source}\nexport const SKIN_PALETTES = {};\n`],
    [
      "multiple declarations in target statement",
      (source) => {
        const target = testPaletteDeclaration(source);
        const end = target.getEnd();
        return `${source.slice(0, end)}, EXTRA = 1${source.slice(end)}`;
      },
    ],
    ["target must be exported", (source) => editTestPalette(source, (ast) => ast.statement.modifiers[0], "")],
    [
      "target must be const",
      (source) => {
        const ast = testPaletteAst(source);
        const statement = ast.statement;
        const text = statement.declarationList.getText(ast.sourceFile).replace(/^const\b/, "let");
        return replaceTestNode(source, statement.declarationList, text);
      },
    ],
    ["dynamic target initializer", (source) => editTestPalette(source, (ast) => ast.palette, "loadPalette()")],
    [
      "dynamic skin initializer",
      (source) => editTestPalette(source, (ast) => skinProperty(ast).initializer, "loadSkin()"),
    ],
    [
      "dynamic mode initializer",
      (source) => editTestPalette(source, (ast) => modeProperty(ast).initializer, "loadMode()"),
    ],
    ["missing skin", (source) => editTestPalette(source, (ast) => skinProperty(ast).name, "missingSkin")],
    ["missing mode", (source) => editTestPalette(source, (ast) => modeProperty(ast).name, "night")],
    ["duplicate mode key", (source) => editTestPalette(source, (ast) => modeProperty(ast).name, "light")],
    ["missing token", (source) => editTestPalette(source, (ast) => tokenProperty(ast).name, "missingToken")],
    ["duplicate token key", modeAddition(`${PALETTE_TOKEN_KEYS[0]}: "#010203",`)],
    [
      "computed token key",
      (source) => editTestPalette(source, (ast) => tokenProperty(ast).name, `["${PALETTE_TOKEN_KEYS[0]}"]`),
    ],
    [
      "non-literal token expression",
      (source) => editTestPalette(source, (ast) => tokenProperty(ast).initializer, "readColor()"),
    ],
    [
      "invalid original token color",
      (source) => editTestPalette(source, (ast) => tokenProperty(ast).initializer, '"var(--bad)"'),
    ],
    ["spread property", modeAddition("...paletteExtension,")],
    ["getter property", modeAddition('get unsupported() { return "#123456"; },')],
    ["method property", modeAddition("unsupported() {},")],
    ["unknown mode property", modeAddition('unsupported: "#123456",')],
  ];

  for (const [name, mutate] of cases) {
    const beforeSource = Buffer.from(mutate(sourceText), "utf8");
    assert.throws(() => buildProductionPaletteSource({ beforeSource, verifiedModel, selections }), TypeError, name);
  }
});

test("rejects invalid source buffers and incomplete selections without mutation", () => {
  const sourceBytes = fs.readFileSync(path.join(REPO_ROOT, "public", "skin-palettes.js"));
  const { verifiedModel, selections } = makeProductionSourceInputs();
  const modelBefore = JSON.stringify(verifiedModel);
  const selectionsBefore = JSON.stringify(selections);
  const bytesBefore = Buffer.from(sourceBytes);

  for (const beforeSource of [null, new Uint8Array(sourceBytes), Buffer.from([0xff, 0x61])]) {
    assert.throws(() => buildProductionPaletteSource({ beforeSource, verifiedModel, selections }), TypeError);
  }
  assert.throws(
    () => buildProductionPaletteSource({ beforeSource: sourceBytes, verifiedModel, selections: {} }),
    TypeError,
  );
  assert.deepEqual(sourceBytes, bytesBefore);
  assert.equal(JSON.stringify(verifiedModel), modelBefore);
  assert.equal(JSON.stringify(selections), selectionsBefore);
});

test("picker preview values come from the shared palette derivation for the requested skin and mode", () => {
  const modes = {
    light: {
      pageBackground: "#F6F1E8",
      panelBackground: "#E3D8C8",
      panelBorder: "#9C8067",
      panelHighlight: "#FFF9F0",
      panelShadow: "#5E4938",
      textPrimary: "#211A15",
      textSecondary: "#65564A",
      accent: "#2868B2",
      controlBackground: "#D6C7B5",
      controlBorder: "#826D59",
      controlText: "#251B14",
      chartText: "#37434D",
    },
    dark: {
      pageBackground: "#171C24",
      panelBackground: "#2B3441",
      panelBorder: "#53677D",
      panelHighlight: "#465668",
      panelShadow: "#080B10",
      textPrimary: "#F1E8DA",
      textSecondary: "#B0B9C4",
      accent: "#83B9F0",
      controlBackground: "#202B39",
      controlBorder: "#60758C",
      controlText: "#EAF2FA",
      chartText: "#D7E0EA",
    },
  };
  const calls = [];
  const runtime = {
    paletteFor(skinId, mode) {
      calls.push([skinId, mode]);
      return { tokens: modes[mode] };
    },
  };
  const modesBefore = JSON.stringify(modes);
  const expected = (mode) => {
    const declarations = new Map(derivePaletteDeclarationsFromTokens(modes[mode], mode));
    return Object.fromEntries(
      Object.entries(EXPECTED_PICKER_PREVIEW_CSS_VARS)
        .map(([key, cssVariable]) => [key, declarations.get(cssVariable)])
        .filter(([, value]) => typeof value === "string" && value.length > 0),
    );
  };

  const light = productionPickerPreviewTokens(runtime, "mimo", "light");
  const dark = productionPickerPreviewTokens(runtime, "mimo", "dark");

  assert.deepEqual(light, expected("light"));
  assert.deepEqual(dark, expected("dark"));
  assert.notDeepEqual(light, dark, "light and dark previews use only their own mode tokens");
  assert.deepEqual(calls, [
    ["mimo", "light"],
    ["mimo", "dark"],
  ]);
  assert.deepEqual(Object.keys(light), Object.keys(EXPECTED_PICKER_PREVIEW_CSS_VARS));
  assert.ok(light.chartLine, "chartLine is the official derived value, not a guessed raw token");
  assert.equal("textPrimary" in light, false);
  assert.equal("series1" in light, false);
  assert.equal("chartSeries" in light, false);
  assert.equal(JSON.stringify(modes), modesBefore);
});

test("picker preview preserves pending, classic, and partial-palette semantics", () => {
  for (const runtime of [
    {},
    { paletteFor: () => null },
    { paletteFor: () => ({ tokens: null }) },
    { paletteFor: () => ({ tokens: {} }) },
    { paletteFor: () => ({ tokens: { chartSeries: ["#123456"] } }) },
  ]) {
    assert.equal(productionPickerPreviewTokens(runtime, "chatgpt", "light"), null);
  }

  const classic = SKINS.find((skin) => skin.id === "classic");
  assert.equal(classic.variants.light.palette, null);
  const registryRuntime = {
    paletteFor: (skinId, mode) => SKINS.find((skin) => skin.id === skinId)?.variants?.[mode]?.palette ?? null,
  };
  assert.equal(productionPickerPreviewTokens(registryRuntime, "classic", "light"), null);

  const partial = productionPickerPreviewTokens(
    { paletteFor: () => ({ tokens: { accent: "#336699", chartSeries: ["#778899"], series1: "#AABBCC" } }) },
    "chatgpt",
    "light",
  );
  assert.deepEqual(partial, { accent: "#336699" });
});

test("builds picker source by inserting one import and replacing only two AST spans", () => {
  const pickerPath = path.join(REPO_ROOT, "public", "skin-picker.js");
  const beforeSource = fs.readFileSync(pickerPath);
  const beforeBytes = Buffer.from(beforeSource);
  const beforeText = beforeSource.toString("utf8");

  const output = buildProductionPickerSource({ beforeSource });
  const outputText = output.toString("utf8");
  const outputAst = testPickerAst(outputText);
  const expectedFunction = productionPickerPreviewTokens
    .toString()
    .replace(/^function productionPickerPreviewTokens/, "function previewTokens");
  const colourInitializer = outputAst.colourTokensStatement.declarationList.declarations[0].initializer;
  assert.ok(ts.isObjectLiteralExpression(colourInitializer));
  assert.deepEqual(
    Object.fromEntries(colourInitializer.properties.map((property) => [property.name.text, property.initializer.text])),
    EXPECTED_PICKER_PREVIEW_CSS_VARS,
  );
  assert.equal(outputAst.previewFunction.getText(outputAst.sourceFile), expectedFunction);
  assert.deepEqual(output, expectedPickerSource(beforeText), "all source outside the AST spans is byte-identical");
  for (const name of [
    "PICKER_SKIN_IDS",
    "previewComposition",
    "TOKEN_TO_CSS",
    "tokenStyle",
    "miniTemplate",
    "createSkinPicker",
  ]) {
    assert.equal(
      testPickerNamedStatement(outputText, name).getText(
        ts.createSourceFile("out.js", outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
      ),
      testPickerNamedStatement(beforeText, name).getText(
        ts.createSourceFile("before.js", beforeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
      ),
      `${name} stays unchanged`,
    );
  }
  assert.deepEqual(buildProductionPickerSource({ beforeSource }), output, "same input produces identical bytes");
  assert.deepEqual(beforeSource, beforeBytes);
  assert.deepEqual(fs.readFileSync(pickerPath), beforeBytes, "the actual public picker remains unchanged");
});

test("picker source construction preserves CRLF and emits the same function source", () => {
  const pickerPath = path.join(REPO_ROOT, "public", "skin-picker.js");
  const sourceText = fs.readFileSync(pickerPath, "utf8").replace(/\r?\n/g, "\r\n");
  const beforeSource = Buffer.from(sourceText, "utf8");
  const output = buildProductionPickerSource({ beforeSource });

  assert.deepEqual(output, expectedPickerSource(sourceText));
  assert.equal(output.toString("utf8").replaceAll("\r\n", "").includes("\n"), false);
  const outputAst = testPickerAst(output.toString("utf8"));
  assert.equal(
    outputAst.previewFunction.getText(outputAst.sourceFile),
    productionPickerPreviewTokens
      .toString()
      .replace(/^function productionPickerPreviewTokens/, "function previewTokens")
      .replace(/\n/g, "\r\n"),
  );
});

test("bootstrap builder emits ten explicit selected palettes through the canonical emitter", () => {
  const { verifiedModel, selections } = makeProductionSourceInputs();
  const overrides = selectedBootstrapOverrides(verifiedModel, selections);
  const modelBefore = JSON.stringify(verifiedModel);
  const selectionsBefore = JSON.stringify(selections);
  const output = buildProductionBootstrapSource({ verifiedModel, selections });
  const expected = Buffer.from(buildSkinBootstrapSource(overrides), "utf8");
  const outputConfig = parseBootstrapConfig(output);
  const baselineConfig = parseBootstrapConfig(buildSkinBootstrapSource());

  assert.deepEqual(Object.keys(overrides), SKIN_IDS);
  for (const skinId of SKIN_IDS) {
    assert.deepEqual(Object.keys(overrides[skinId]), ["light", "dark"]);
    for (const mode of ["light", "dark"]) {
      assert.deepEqual(Object.keys(overrides[skinId][mode]), PALETTE_TOKEN_KEYS);
    }
  }
  assert.deepEqual(output, expected, "the whole result is exactly the canonical emitter buffer");
  assert.deepEqual(output, buildProductionBootstrapSource({ verifiedModel, selections }));
  assert.deepEqual(outputConfig.defaultPreference, baselineConfig.defaultPreference);
  assert.deepEqual(outputConfig.paletteVarNames, baselineConfig.paletteVarNames);
  assert.deepEqual(outputConfig.modes, baselineConfig.modes);
  assert.equal(outputConfig.registry.length, SKIN_IDS.length + 1);

  for (const skinId of SKIN_IDS) {
    const candidate = verifiedModel.candidateSet.candidates.find(
      (item) => item.id === selections.choices[skinId].candidateId,
    );
    const emitted = outputConfig.registry.find((entry) => entry.id === skinId);
    const baseline = baselineConfig.registry.find((entry) => entry.id === skinId);
    assert.deepEqual(emitted.palette.light, derivePaletteDeclarationsFromTokens(candidate.modes.light, "light"));
    assert.deepEqual(emitted.palette.dark, derivePaletteDeclarationsFromTokens(candidate.modes.dark, "dark"));
    assert.deepEqual(
      { id: emitted.id, name: emitted.name, isClassic: emitted.isClassic, light: emitted.light, dark: emitted.dark },
      {
        id: baseline.id,
        name: baseline.name,
        isClassic: baseline.isClassic,
        light: baseline.light,
        dark: baseline.dark,
      },
      `${skinId}: assets and registry metadata stay emitter-owned`,
    );
  }
  assert.equal(outputConfig.registry.find((entry) => entry.id === "classic").palette, null);
  assert.equal(JSON.stringify(verifiedModel), modelBefore);
  assert.equal(JSON.stringify(selections), selectionsBefore);
});

test("selected bootstrap bytes use actual palette values and the canonical explicit override emitter", () => {
  const bootstrapPath = path.join(REPO_ROOT, "public", "skin-bootstrap.js");
  const beforeBootstrap = fs.readFileSync(bootstrapPath);
  const { verifiedModel, selections } = makeProductionSourceInputs({ useCurrentPalette: true });
  const overrides = selectedBootstrapOverrides(verifiedModel, selections);
  const actualOutput = buildProductionBootstrapSource({ verifiedModel, selections });
  const noOverrideOutput = Buffer.from(buildSkinBootstrapSource(), "utf8");
  const selectedConfig = parseBootstrapConfig(actualOutput);

  assert.deepEqual(noOverrideOutput, beforeBootstrap);
  assert.deepEqual(actualOutput, Buffer.from(buildSkinBootstrapSource(overrides), "utf8"));
  assert.equal(
    !actualOutput.equals(beforeBootstrap),
    !actualOutput.equals(noOverrideOutput),
    "whether selected output differs from the baseline is determined by the actual source bytes",
  );
  for (const skinId of SKIN_IDS) {
    const candidate = verifiedModel.candidateSet.candidates.find(
      (item) => item.id === selections.choices[skinId].candidateId,
    );
    const emitted = selectedConfig.registry.find((entry) => entry.id === skinId);
    for (const mode of ["light", "dark"]) {
      for (const token of PALETTE_TOKEN_KEYS) {
        assert.equal(
          candidate.modes[mode][token],
          SKIN_PALETTES[skinId][mode][token].trim().toUpperCase(),
          `${skinId}.${mode}.${token} is the current palette token in the candidate contract's canonical form`,
        );
      }
      assert.deepEqual(
        emitted.palette[mode],
        derivePaletteDeclarationsFromTokens(candidate.modes[mode], mode),
        `${skinId}.${mode} declarations come from every selected candidate token`,
      );
    }
  }
  assert.deepEqual(fs.readFileSync(bootstrapPath), beforeBootstrap);
});

test("production source transition accepts only complete constructor bytes and returns independent hashes", () => {
  const inputs = makeProductionSourceTransitionInputs();
  assert.equal(SOURCE_FILES.length, 31, "the authoritative capture source registry includes timeline-utils.js");
  assert.ok(SOURCE_FILES.includes("public/timeline-utils.js"));
  const originalHashes = { ...inputs.beforeSourceHashes };
  const originalSnapshot = cloneRecordWithBuffers(inputs.sourceSnapshot);
  const originalAfter = cloneRecordWithBuffers(inputs.afterSourceBytes);
  const modelBefore = JSON.stringify(inputs.verifiedModel);
  const selectionsBefore = JSON.stringify(inputs.selections);
  const args = {
    beforeSourceHashes: Object.assign(Object.create(null), inputs.beforeSourceHashes),
    sourceSnapshot: Object.assign(Object.create(null), cloneRecordWithBuffers(inputs.sourceSnapshot)),
    afterSourceBytes: Object.assign(Object.create(null), cloneRecordWithBuffers(inputs.afterSourceBytes)),
    verifiedModel: inputs.verifiedModel,
    selections: inputs.selections,
  };

  const result = verifyProductionSourceTransition(args);
  const expectedHashes = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, hashBytes(inputs.afterSourceBytes[file])]),
  );
  assert.deepEqual(result, { status: "pass", errors: [], gaps: [], sourceHashes: expectedHashes });
  assert.deepEqual(Object.keys(result.sourceHashes), SOURCE_FILES, "hash result follows the fixed source order");
  assert.notEqual(result.sourceHashes, args.afterSourceBytes, "hash result is an independent object");
  result.sourceHashes[SOURCE_FILES[0]] = "0".repeat(64);

  const repeated = verifyProductionSourceTransition({ ...args });
  assert.deepEqual(repeated.sourceHashes, expectedHashes, "same byte inputs produce the same source hashes");
  assert.deepEqual(inputs.beforeSourceHashes, originalHashes);
  assert.deepEqual(inputs.sourceSnapshot, originalSnapshot);
  assert.deepEqual(inputs.afterSourceBytes, originalAfter);
  assert.equal(JSON.stringify(inputs.verifiedModel), modelBefore);
  assert.equal(JSON.stringify(inputs.selections), selectionsBefore);
  for (const inputMap of [inputs.beforeSourceHashes, inputs.sourceSnapshot, inputs.afterSourceBytes]) {
    assert.equal(Object.isFrozen(inputMap), false);
  }
  for (const file of SOURCE_FILES) {
    assert.deepEqual(
      fs.readFileSync(path.join(REPO_ROOT, ...file.split("/"))),
      inputs.beforeSourceBytes[file],
      `${file} remains unchanged by the pure transition check`,
    );
  }
});

test("production transitions reject semantically equivalent edits to all three generated sources", () => {
  const inputs = makeProductionSourceTransitionInputs();
  const cases = [
    [
      "public/skin-palettes.js",
      (bytes) => {
        const text = bytes.toString("utf8");
        const literal = [...text.matchAll(/"#[0-9A-F]{6}"/g)].find((match) => /[A-F]/.test(match[0]));
        assert.ok(literal, "fixture output contains a hex token with alphabetic digits");
        return Buffer.from(text.replace(literal[0], literal[0].toLowerCase()), "utf8");
      },
    ],
    ["public/skin-picker.js", (bytes) => Buffer.concat([bytes, Buffer.from("\n", "utf8")])],
    ["public/skin-bootstrap.js", (bytes) => Buffer.concat([bytes, Buffer.from("\n// byte change\n", "utf8")])],
  ];

  for (const [file, mutate] of cases) {
    const afterSourceBytes = cloneRecordWithBuffers(inputs.afterSourceBytes);
    afterSourceBytes[file] = mutate(afterSourceBytes[file]);
    const result = verifyProductionSourceTransition({ ...inputs, afterSourceBytes });
    assert.equal(result.status, "rejected", file);
    assert.deepEqual(
      result.errors.map(({ code, path: sourcePath }) => [code, sourcePath]),
      [["production-source-transition-mismatch", file]],
      `${file} is compared as complete bytes, including spelling and formatting`,
    );
  }
});

test("any of the other 28 registered sources must remain byte-identical", () => {
  const inputs = makeProductionSourceTransitionInputs();
  const unchangedSources = SOURCE_FILES.filter((file) => !SOURCE_PREIMAGE_FILES.includes(file));
  assert.equal(unchangedSources.length, 28);
  for (const file of [
    "scripts/skin-palette/focus-outline-pixels.mjs",
    "scripts/skin-palette/focus-outline-browser.mjs",
  ]) {
    assert.equal(
      unchangedSources.filter((entry) => entry === file).length,
      1,
      `${file} must be immutable in transition`,
    );
  }
  assert.ok(
    unchangedSources.includes("public/timeline-utils.js"),
    "timeline-utils.js is immutable during production transition",
  );

  for (const file of unchangedSources) {
    const afterSourceBytes = cloneRecordWithBuffers(inputs.afterSourceBytes);
    afterSourceBytes[file] = Buffer.concat([afterSourceBytes[file], Buffer.from("\n", "utf8")]);
    const result = verifyProductionSourceTransition({ ...inputs, afterSourceBytes });
    assert.equal(result.status, "rejected", file);
    assert.deepEqual(
      result.errors.map(({ code, path: sourcePath }) => [code, sourcePath]),
      [["unexpected-source-transition", file]],
      `${file} is outside the three permitted source constructors`,
    );
  }
});

test("transition diagnostics retain every difference in registered order", () => {
  const inputs = makeProductionSourceTransitionInputs();
  const afterSourceBytes = cloneRecordWithBuffers(inputs.afterSourceBytes);
  afterSourceBytes["public/skin-palettes.js"] = Buffer.concat([
    afterSourceBytes["public/skin-palettes.js"],
    Buffer.from("\n// extra comment\n", "utf8"),
  ]);
  afterSourceBytes["public/skin-picker.js"] = Buffer.concat([
    afterSourceBytes["public/skin-picker.js"],
    Buffer.from("\n", "utf8"),
  ]);
  afterSourceBytes["public/skin-bootstrap.js"] = Buffer.concat([
    afterSourceBytes["public/skin-bootstrap.js"],
    Buffer.from("\n// extra comment\n", "utf8"),
  ]);
  afterSourceBytes["public/styles.css"] = Buffer.concat([
    afterSourceBytes["public/styles.css"],
    Buffer.from("\n", "utf8"),
  ]);

  const result = verifyProductionSourceTransition({ ...inputs, afterSourceBytes });
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, path: sourcePath }) => [code, sourcePath]),
    [
      ["production-source-transition-mismatch", "public/skin-palettes.js"],
      ["production-source-transition-mismatch", "public/skin-bootstrap.js"],
      ["unexpected-source-transition", "public/styles.css"],
      ["production-source-transition-mismatch", "public/skin-picker.js"],
    ],
  );
});

test("a mismatched preimage is not parsed and still reports all unchanged-source drift", () => {
  const inputs = makeProductionSourceTransitionInputs();
  const sourceSnapshot = cloneRecordWithBuffers(inputs.sourceSnapshot);
  const afterSourceBytes = cloneRecordWithBuffers(inputs.afterSourceBytes);
  sourceSnapshot["public/skin-palettes.js"] = Buffer.from("export const SKIN_PALETTES = ;", "utf8");
  const unchangedSources = SOURCE_FILES.filter((file) => !SOURCE_PREIMAGE_FILES.includes(file));
  for (const file of unchangedSources) {
    afterSourceBytes[file] = Buffer.concat([afterSourceBytes[file], Buffer.from("\n", "utf8")]);
  }

  const result = verifyProductionSourceTransition({ ...inputs, sourceSnapshot, afterSourceBytes });
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, path: sourcePath }) => [code, sourcePath]),
    SOURCE_FILES.flatMap((file) =>
      file === "public/skin-palettes.js"
        ? [["source-preimage-mismatch", file]]
        : unchangedSources.includes(file)
          ? [["unexpected-source-transition", file]]
          : [],
    ),
  );
  assert.deepEqual(result.gaps, []);
});

test("selection validation still runs when an unchanged source has drifted", () => {
  const inputs = makeProductionSourceTransitionInputs();
  const afterSourceBytes = cloneRecordWithBuffers(inputs.afterSourceBytes);
  afterSourceBytes["public/styles.css"] = Buffer.concat([
    afterSourceBytes["public/styles.css"],
    Buffer.from("\n", "utf8"),
  ]);
  const invalidSelections = structuredClone(inputs.selections);
  delete invalidSelections.choices[SKIN_IDS[0]];

  assert.throws(
    () => verifyProductionSourceTransition({ ...inputs, afterSourceBytes, selections: invalidSelections }),
    TypeError,
    "B1 rejects an incomplete full selection instead of returning only source drift",
  );
});

test("transition input maps require exact own data records and copied Buffers", () => {
  const inputs = makeProductionSourceTransitionInputs();
  const args = () => ({
    beforeSourceHashes: { ...inputs.beforeSourceHashes },
    sourceSnapshot: cloneRecordWithBuffers(inputs.sourceSnapshot),
    afterSourceBytes: cloneRecordWithBuffers(inputs.afterSourceBytes),
    verifiedModel: inputs.verifiedModel,
    selections: inputs.selections,
  });
  const cases = [
    ["missing hash key", (value) => delete value.beforeSourceHashes[SOURCE_FILES[0]]],
    ["extra hash key", (value) => (value.beforeSourceHashes.extra = "a".repeat(64))],
    ["invalid hash value", (value) => (value.beforeSourceHashes[SOURCE_FILES[0]] = "A".repeat(64))],
    [
      "hash accessor",
      (value) => Object.defineProperty(value.beforeSourceHashes, SOURCE_FILES[0], { get: () => "a".repeat(64) }),
    ],
    ["hash symbol key", (value) => (value.beforeSourceHashes[Symbol("extra")] = "a".repeat(64))],
    ["hash inherited key", (value) => Object.setPrototypeOf(value.beforeSourceHashes, { inherited: "a".repeat(64) })],
    ["missing snapshot key", (value) => delete value.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]]],
    ["extra snapshot key", (value) => (value.sourceSnapshot.extra = Buffer.from("x"))],
    ["snapshot non-Buffer", (value) => (value.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]] = new Uint8Array([1]))],
    [
      "snapshot accessor",
      (value) => Object.defineProperty(value.sourceSnapshot, SOURCE_PREIMAGE_FILES[0], { get: () => Buffer.from("x") }),
    ],
    ["snapshot symbol key", (value) => (value.sourceSnapshot[Symbol("extra")] = Buffer.from("x"))],
    ["missing after key", (value) => delete value.afterSourceBytes[SOURCE_FILES[0]]],
    ["missing timeline source", (value) => delete value.afterSourceBytes["public/timeline-utils.js"]],
    ["extra after key", (value) => (value.afterSourceBytes.extra = Buffer.from("x"))],
    ["after non-Buffer", (value) => (value.afterSourceBytes[SOURCE_FILES[0]] = new Uint8Array([1]))],
    [
      "after accessor",
      (value) => Object.defineProperty(value.afterSourceBytes, SOURCE_FILES[0], { get: () => Buffer.from("x") }),
    ],
    ["after symbol key", (value) => (value.afterSourceBytes[Symbol("extra")] = Buffer.from("x"))],
    ["array map", (value) => (value.sourceSnapshot = [])],
    ["class map", (value) => (value.afterSourceBytes = new Date())],
    ["custom prototype map", (value) => Object.setPrototypeOf(value.sourceSnapshot, { inherited: true })],
  ];

  for (const [label, mutate] of cases) {
    const invalid = args();
    mutate(invalid);
    assert.throws(() => verifyProductionSourceTransition(invalid), TypeError, label);
  }
});

test("bootstrap builder rejects incomplete or stale reviewed selections without mutation", () => {
  const base = makeProductionSourceInputs();
  const modelBefore = JSON.stringify(base.verifiedModel);
  const selectionsBefore = JSON.stringify(base.selections);

  assert.throws(() => buildProductionBootstrapSource({ verifiedModel: base.verifiedModel, selections: {} }), TypeError);

  const wrongHash = structuredClone(base.selections);
  wrongHash.choices[SKIN_IDS[0]].candidateHash = "f".repeat(64);
  assert.throws(
    () => buildProductionBootstrapSource({ verifiedModel: base.verifiedModel, selections: wrongHash }),
    TypeError,
  );

  const draft = { ...base.selections, kind: "skin-palette-selection-draft" };
  assert.throws(
    () => buildProductionBootstrapSource({ verifiedModel: base.verifiedModel, selections: draft }),
    TypeError,
  );

  const notReady = structuredClone(base.verifiedModel);
  notReady.container.assessments[0].readiness = "incomplete";
  notReady.container.assessmentHash = sha256Canonical({
    schemaVersion: notReady.container.schemaVersion,
    candidateSetHash: notReady.container.candidateSetHash,
    assessments: notReady.container.assessments,
  });
  const matchingNotReadySelection = { ...base.selections, assessmentHash: notReady.container.assessmentHash };
  assert.throws(
    () =>
      buildProductionBootstrapSource({
        verifiedModel: notReady,
        selections: matchingNotReadySelection,
      }),
    TypeError,
  );

  const missingDarkEvidence = structuredClone(base.verifiedModel);
  const selectedId = base.selections.choices[SKIN_IDS[0]].candidateId;
  missingDarkEvidence.images.units = missingDarkEvidence.images.units.filter(
    (unit) => !(unit.candidateId === selectedId && unit.mode === "dark"),
  );
  assert.throws(
    () =>
      buildProductionBootstrapSource({
        verifiedModel: missingDarkEvidence,
        selections: base.selections,
      }),
    TypeError,
  );

  assert.equal(JSON.stringify(base.verifiedModel), modelBefore);
  assert.equal(JSON.stringify(base.selections), selectionsBefore);
});

test("rejects invalid picker buffers, source targets, signatures, and derive import conflicts", () => {
  const pickerPath = path.join(REPO_ROOT, "public", "skin-picker.js");
  const sourceText = fs.readFileSync(pickerPath, "utf8");
  const colourDeclaration = (ast) => ast.colourTokensStatement.declarationList.declarations[0];
  const cases = [
    ["syntax error", (source) => `${source}\nconst = ;`],
    [
      "missing COLOUR_TOKENS",
      (source) => editPickerTestNode(source, (ast) => colourDeclaration(ast).name, "OLD_TOKENS"),
    ],
    ["duplicate COLOUR_TOKENS", (source) => `${source}\nconst COLOUR_TOKENS = [];\n`],
    [
      "multiple COLOUR_TOKENS declarations",
      (source) => {
        const ast = testPickerAst(source);
        const declaration = colourDeclaration(ast);
        const end = declaration.getEnd();
        return `${source.slice(0, end)}, EXTRA = []${source.slice(end)}`;
      },
    ],
    [
      "COLOUR_TOKENS must be const",
      (source) => {
        const ast = testPickerAst(source);
        const node = ast.colourTokensStatement.declarationList;
        return editPickerTestNode(source, () => node, node.getText(ast.sourceFile).replace(/^const\b/, "let"));
      },
    ],
    [
      "dynamic COLOUR_TOKENS initializer",
      (source) => editPickerTestNode(source, (ast) => colourDeclaration(ast).initializer, "getColourTokens()"),
    ],
    [
      "altered original COLOUR_TOKENS array",
      (source) => editPickerTestNode(source, (ast) => colourDeclaration(ast).initializer.elements[0], '"unknown"'),
    ],
    [
      "missing previewTokens",
      (source) => editPickerTestNode(source, (ast) => ast.previewFunction.name, "oldPreviewTokens"),
    ],
    [
      "duplicate previewTokens",
      (source) => `${source}\nfunction previewTokens(runtime, skinId, mode) { return null; }\n`,
    ],
    [
      "non-ordinary previewTokens signature",
      (source) => editPickerTestNode(source, (ast) => ast.previewFunction.parameters[0], "runtime = {}"),
    ],
    [
      "async previewTokens",
      (source) => {
        const ast = testPickerAst(source);
        return editPickerTestNode(
          source,
          (target) => target.previewFunction,
          `async ${ast.previewFunction.getText(ast.sourceFile)}`,
        );
      },
    ],
    [
      "generator previewTokens",
      (source) => {
        const ast = testPickerAst(source);
        return editPickerTestNode(
          source,
          (target) => target.previewFunction,
          ast.previewFunction.getText(ast.sourceFile).replace(/^function previewTokens/, "function* previewTokens"),
        );
      },
    ],
    [
      "existing derive import",
      (source) => `${source}\nimport { derivePaletteDeclarationsFromTokens } from "./skins.js";\n`,
    ],
    [
      "existing aliased derive import",
      (source) => `${source}\nimport { derivePaletteDeclarationsFromTokens as derive } from "./skins.js";\n`,
    ],
    ["existing derive binding", (source) => `${source}\nconst derivePaletteDeclarationsFromTokens = () => [];\n`],
  ];

  for (const [name, mutate] of cases) {
    assert.throws(
      () => buildProductionPickerSource({ beforeSource: Buffer.from(mutate(sourceText), "utf8") }),
      TypeError,
      name,
    );
  }

  for (const beforeSource of [null, new Uint8Array(Buffer.from(sourceText)), Buffer.from([0xff, 0x61])]) {
    assert.throws(() => buildProductionPickerSource({ beforeSource }), TypeError);
  }
});

test("invalid candidate shape, hash, id and skin fail with the first M0 contract reason", () => {
  assert.throws(() => compareProductionTokens({ candidate: null }), /candidate.*candidate 必须是对象/);

  const badHash = makeCandidate();
  badHash.candidateHash = "f".repeat(64);
  assert.throws(() => compareProductionTokens({ candidate: badHash }), /candidateHash/);

  const badId = makeCandidate();
  badId.id = "chatgpt-a-000000000000";
  assert.throws(() => compareProductionTokens({ candidate: badId }), /id 应为/);

  const unknownSkin = makeCandidate({ skinId: "unknown" });
  assert.throws(() => compareProductionTokens({ candidate: unknownSkin }), /未知皮肤/);
});

test("a complete synthetic selection returns the selected candidate and exact independent binding", () => {
  const verifiedModel = makeVerifiedModel();
  const selections = makeSelections(verifiedModel);
  const selected = verifiedModel.candidateSet.candidates.find((candidate) => candidate.skinId === SKIN_IDS[0]);
  const modelBefore = JSON.stringify(verifiedModel);
  const selectionsBefore = JSON.stringify(selections);

  const result = resolveProductionSelection({ verifiedModel, selections, candidateId: selected.id });

  assert.deepEqual(result.candidate, selected);
  assert.notStrictEqual(result.candidate, selected);
  assert.deepEqual(result.selectionBinding, {
    skinId: selected.skinId,
    candidateId: selected.id,
    candidateHash: selected.candidateHash,
    candidateSetHash: selections.candidateSetHash,
    assessmentHash: selections.assessmentHash,
    decisionSource: selections.decisionSource,
    recordedAt: selections.recordedAt,
  });
  result.candidate.modes.light.pageBackground = "#FFFFFF";
  assert.notEqual(selected.modes.light.pageBackground, "#FFFFFF");
  assert.equal(JSON.stringify(verifiedModel), modelBefore);
  assert.equal(JSON.stringify(selections), selectionsBefore);

  const nullPrototypeSelections = Object.assign(Object.create(null), selections);
  assert.deepEqual(
    resolveProductionSelection({ verifiedModel, selections: nullPrototypeSelections, candidateId: selected.id })
      .selectionBinding,
    result.selectionBinding,
  );
});

test("a valid candidate in the set is rejected unless the record selected its exact id and hash", () => {
  const verifiedModel = makeVerifiedModel();
  const selections = makeSelections(verifiedModel);
  const selectedA = verifiedModel.candidateSet.candidates.find((candidate) => candidate.skinId === SKIN_IDS[0]);
  const unselectedB = verifiedModel.candidateSet.candidates.find(
    (candidate) => candidate.skinId === SKIN_IDS[0] && candidate.variant === "b",
  );
  assertRejectedWithoutMutation({ verifiedModel, selections, candidateId: unselectedB.id });
  assertRejectedWithoutMutation({ verifiedModel, selections, candidateId: "chatgpt-a-000000000000" });
  assertRejectedWithoutMutation({ verifiedModel, selections, candidateId: "" });

  const wrongSkin = structuredClone(selections);
  wrongSkin.choices[SKIN_IDS[1]] = {
    candidateId: selectedA.id,
    candidateHash: selectedA.candidateHash,
  };
  assertRejectedWithoutMutation({ verifiedModel, selections: wrongSkin, candidateId: selectedA.id });

  const wrongHash = structuredClone(selections);
  wrongHash.choices[SKIN_IDS[0]].candidateHash = "f".repeat(64);
  assertRejectedWithoutMutation({ verifiedModel, selections: wrongHash, candidateId: selectedA.id });
});

test("stale summaries and malformed or draft selection records are rejected without mutation", () => {
  const verifiedModel = makeVerifiedModel();
  const goodSelections = makeSelections(verifiedModel);
  const selected = verifiedModel.candidateSet.candidates[0];

  for (const field of ["candidateSetHash", "assessmentHash"]) {
    const stale = structuredClone(goodSelections);
    stale[field] = "f".repeat(64);
    assertRejectedWithoutMutation({ verifiedModel, selections: stale, candidateId: selected.id });
  }

  const missingSkin = structuredClone(goodSelections);
  delete missingSkin.choices[SKIN_IDS[9]];
  assertRejectedWithoutMutation({ verifiedModel, selections: missingSkin, candidateId: selected.id });

  for (const malformed of [
    { ...goodSelections, kind: "skin-palette-selection-draft", missingSkinIds: [] },
    { ...goodSelections, unexpected: true },
    { ...goodSelections, decisionSource: " \t " },
  ]) {
    assertRejectedWithoutMutation({ verifiedModel, selections: malformed, candidateId: selected.id });
  }
});

test("the model must have a complete candidate set and container summary bound to its content", () => {
  const baseModel = makeVerifiedModel();
  const baseSelections = makeSelections(baseModel);
  const candidateId = baseModel.candidateSet.candidates[0].id;

  const incompleteSet = structuredClone(baseModel);
  incompleteSet.candidateSet.candidates.pop();
  incompleteSet.candidateSet.candidateSetHash = hashCandidateSet(incompleteSet.candidateSet);
  incompleteSet.container.candidateSetHash = incompleteSet.candidateSet.candidateSetHash;
  incompleteSet.container.assessmentHash = sha256Canonical({
    schemaVersion: incompleteSet.container.schemaVersion,
    candidateSetHash: incompleteSet.container.candidateSetHash,
    assessments: incompleteSet.container.assessments,
  });
  const incompleteSelections = makeSelections(incompleteSet);
  assertRejectedWithoutMutation({ verifiedModel: incompleteSet, selections: incompleteSelections, candidateId });

  const setHashDrift = structuredClone(baseModel);
  setHashDrift.candidateSet.candidateSetHash = "f".repeat(64);
  const selectionMatchingBadSetHash = { ...baseSelections, candidateSetHash: "f".repeat(64) };
  assertRejectedWithoutMutation({ verifiedModel: setHashDrift, selections: selectionMatchingBadSetHash, candidateId });

  const assessmentHashDrift = structuredClone(baseModel);
  assessmentHashDrift.container.assessmentHash = "f".repeat(64);
  const selectionMatchingBadAssessmentHash = { ...baseSelections, assessmentHash: "f".repeat(64) };
  assertRejectedWithoutMutation({
    verifiedModel: assessmentHashDrift,
    selections: selectionMatchingBadAssessmentHash,
    candidateId,
  });
});

test("all selected skins must be ready, selectable, backed by both modes, and free of blocking gaps", () => {
  const baseModel = makeVerifiedModel();
  const baseSelections = makeSelections(baseModel);
  const candidateId = baseModel.candidateSet.candidates[0].id;

  const notReady = structuredClone(baseModel);
  notReady.container.assessments[0].readiness = "incomplete";
  notReady.container.assessmentHash = sha256Canonical({
    schemaVersion: notReady.container.schemaVersion,
    candidateSetHash: notReady.container.candidateSetHash,
    assessments: notReady.container.assessments,
  });
  const notReadySelections = { ...baseSelections, assessmentHash: notReady.container.assessmentHash };
  assertRejectedWithoutMutation({ verifiedModel: notReady, selections: notReadySelections, candidateId });

  const notSelectable = structuredClone(baseModel);
  notSelectable.selectableCandidateIds = notSelectable.selectableCandidateIds.filter((id) => id !== candidateId);
  assertRejectedWithoutMutation({ verifiedModel: notSelectable, selections: baseSelections, candidateId });

  const missingDark = structuredClone(baseModel);
  missingDark.images.units = missingDark.images.units.filter(
    (item) => !(item.candidateId === candidateId && item.mode === "dark"),
  );
  assertRejectedWithoutMutation({ verifiedModel: missingDark, selections: baseSelections, candidateId });

  const blockingGap = structuredClone(baseModel);
  blockingGap.gaps.push({ candidateId, blocking: true });
  assertRejectedWithoutMutation({ verifiedModel: blockingGap, selections: baseSelections, candidateId });
});

test("D8u2B: production wrapper forwards both fixtures while preserving null candidate and selection skin", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const calls = [];
    const fixture = {
      async close() {
        calls.push("base.close");
      },
    };
    const timelineWarningFixture = {
      async close() {
        calls.push("warning.close");
      },
    };
    let captureResult;
    const result = await runProductionCapture({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      outDir,
      fixtureFactory: async () => {
        calls.push("base.create");
        return fixture;
      },
      timelineWarningFixtureFactory: async () => {
        calls.push("warning.create");
        return timelineWarningFixture;
      },
      captureFn: async (input) => {
        calls.push("capture");
        assert.deepEqual(Object.keys(input).sort(), [
          "candidate",
          "fixture",
          "modes",
          "outDir",
          "resume",
          "skinId",
          "timelineWarningFixture",
        ]);
        assert.equal(input.candidate, null);
        assert.equal(input.skinId, candidate.skinId);
        assert.strictEqual(input.fixture, fixture);
        assert.strictEqual(input.timelineWarningFixture, timelineWarningFixture);
        assert.deepEqual(input.modes, ["light", "dark"]);
        assert.equal(input.resume, false);
        captureResult = makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir });
        return captureResult;
      },
    });

    assert.deepEqual(calls, ["base.create", "warning.create", "capture", "warning.close", "base.close"]);
    assert.equal(result.candidateId, candidate.id);
    assert.equal(result.candidateHash, candidate.candidateHash);
    assert.deepEqual(result.selectionBinding, {
      skinId: candidate.skinId,
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      candidateSetHash: selections.candidateSetHash,
      assessmentHash: selections.assessmentHash,
      decisionSource: selections.decisionSource,
      recordedAt: selections.recordedAt,
    });
    assert.strictEqual(result.captureResult, captureResult);
    assert.equal(result.captureResult.modes.light.status, "incomplete");

    const resumeOutDir = path.join(testRoot, "resume-output");
    await fs.promises.mkdir(resumeOutDir);
    const sentinel = Buffer.from("resume evidence stays in place");
    await fs.promises.writeFile(path.join(resumeOutDir, "existing-evidence.json"), sentinel);
    let resumeValue;
    await runProductionCapture({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      outDir: resumeOutDir,
      resume: true,
      fixtureFactory: async () => ({ close: async () => undefined }),
      captureFn: async (input) => {
        resumeValue = input.resume;
        return makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir });
      },
    });
    assert.equal(resumeValue, true);
    assert.deepEqual(await fs.promises.readFile(path.join(resumeOutDir, "existing-evidence.json")), sentinel);
  });
});

test("invalid inputs, unselected candidates, stale selection, and token mismatch stop before output or fixture", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    let fixtureCalls = 0;
    let warningFixtureCalls = 0;
    let captureCalls = 0;
    const fixtureFactory = async () => {
      fixtureCalls += 1;
      return { close: async () => undefined };
    };
    const timelineWarningFixtureFactory = async () => {
      warningFixtureCalls += 1;
      return { close: async () => undefined };
    };
    const captureFn = async () => {
      captureCalls += 1;
      return {};
    };
    const unselected = verifiedModel.candidateSet.candidates.find(
      (item) => item.skinId === candidate.skinId && item.variant === "b",
    );
    const stale = { ...selections, assessmentHash: "f".repeat(64) };
    for (const input of [
      {
        runDir: " ",
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
        captureFn,
      },
      {
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir: " ",
        fixtureFactory,
        timelineWarningFixtureFactory,
        captureFn,
      },
      {
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        resume: 1,
        fixtureFactory,
        timelineWarningFixtureFactory,
        captureFn,
      },
      {
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        captureFn: null,
        fixtureFactory,
        timelineWarningFixtureFactory,
      },
      {
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        fixtureFactory: null,
        timelineWarningFixtureFactory,
        captureFn,
      },
      {
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        fixtureFactory,
        timelineWarningFixtureFactory: null,
        captureFn,
      },
      {
        runDir,
        verifiedModel,
        selections,
        candidateId: unselected.id,
        outDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
        captureFn,
      },
      {
        runDir,
        verifiedModel,
        selections: stale,
        candidateId: candidate.id,
        outDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
        captureFn,
      },
    ]) {
      await assert.rejects(runProductionCapture(input), TypeError);
      assert.equal(fs.existsSync(outDir), false);
    }

    const wrongColors = structuredClone(SKIN_PALETTES);
    const expected = candidate.modes.light.pageBackground;
    wrongColors[candidate.skinId].light.pageBackground = expected === "#010203" ? "#040506" : "#010203";
    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        captureFn,
        fixtureFactory,
        timelineWarningFixtureFactory,
        productionPalettes: wrongColors,
      }),
      /light\.pageBackground.*production-token-mismatch/,
    );
    assert.equal(fs.existsSync(outDir), false);

    const missingToken = structuredClone(SKIN_PALETTES);
    delete missingToken[candidate.skinId].light.pageBackground;
    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        captureFn,
        fixtureFactory,
        timelineWarningFixtureFactory,
        productionPalettes: missingToken,
      }),
      /light\.pageBackground.*missing-production-token/,
    );
    assert.equal(fs.existsSync(outDir), false);

    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        fixtureFactory,
        timelineWarningFixtureFactory,
        productionPalettes: wrongColors,
      }),
      /custom productionPalettes requires an injected captureFn/,
    );
    assert.equal(fs.existsSync(outDir), false);
    assert.equal(fixtureCalls, 0);
    assert.equal(warningFixtureCalls, 0);
    assert.equal(captureCalls, 0);
    assert.equal(fs.readdirSync(testRoot).filter((entry) => entry === path.basename(outDir)).length, 0);
  });
});

test("a changed actual run candidate set is rejected before output and fixture acquisition", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const changedSet = structuredClone(verifiedModel.candidateSet);
    const changedCandidate = changedSet.candidates.find((item) => item.id === candidate.id);
    changedCandidate.style.rationale += " changed in the actual run";
    changedCandidate.candidateHash = hashCandidate(changedCandidate);
    changedCandidate.id = `${changedCandidate.skinId}-${changedCandidate.variant}-${changedCandidate.candidateHash.slice(0, 12)}`;
    changedSet.candidateSetHash = hashCandidateSet(changedSet);
    await fs.promises.writeFile(path.join(runDir, "candidates.json"), `${JSON.stringify(changedSet)}\n`, "utf8");

    let fixtureCalls = 0;
    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        fixtureFactory: async () => {
          fixtureCalls += 1;
          return { close: async () => undefined };
        },
        captureFn: async () => assert.fail("matrix must not run for a changed run candidate"),
      }),
      /unknown candidate ID/,
    );
    assert.equal(fs.existsSync(outDir), false);
    assert.equal(fixtureCalls, 0);
  });
});

test("the lifecycle reload bridge rejects candidate content drift and still closes its fixture", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const originalFind = Array.prototype.find;
    let candidateLookups = 0;
    let fixtureCloses = 0;
    let captureCalls = 0;
    try {
      Array.prototype.find = function (predicate, thisArg) {
        const result = originalFind.call(this, predicate, thisArg);
        if (this.length === SKIN_IDS.length * 3 && this[0]?.candidateHash && result?.id === candidate.id) {
          candidateLookups += 1;
          if (candidateLookups === 2) result.style.rationale += " drift after second validation";
        }
        return result;
      };
      await assert.rejects(
        runProductionCapture({
          runDir,
          verifiedModel,
          selections,
          candidateId: candidate.id,
          outDir,
          fixtureFactory: async () => ({
            close: async () => {
              fixtureCloses += 1;
            },
          }),
          captureFn: async () => {
            captureCalls += 1;
            return assert.fail("production matrix must not start after candidate reload drift");
          },
        }),
        /capture lifecycle reload candidate id\/hash\/content/,
      );
    } finally {
      Array.prototype.find = originalFind;
    }
    assert.equal(candidateLookups, 2);
    assert.equal(fixtureCloses, 1);
    assert.equal(captureCalls, 0);
    assert.equal(fs.existsSync(outDir), true, "failed output is retained for diagnosis");
  });
});

test("production and ordinary review captures share one global capture slot", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    let resolveCapture;
    let markCaptureEntered;
    const entered = new Promise((resolve) => {
      markCaptureEntered = resolve;
    });
    const waiting = new Promise((resolve) => {
      resolveCapture = resolve;
    });
    const productionOutDir = outDir;
    const production = runProductionCapture({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      outDir: productionOutDir,
      fixtureFactory: async () => ({ close: async () => undefined }),
      captureFn: async (input) => {
        markCaptureEntered();
        await waiting;
        return makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir });
      },
    });

    await entered;
    let ordinaryFixtureCalls = 0;
    await assert.rejects(
      runReviewCapture({
        runDir,
        candidateId: candidate.id,
        outDir: path.join(testRoot, "ordinary-overlap"),
        fixtureFactory: async () => {
          ordinaryFixtureCalls += 1;
          return { close: async () => undefined };
        },
        captureFn: async () => ({}),
      }),
      /another capture is already in progress/,
    );
    assert.equal(ordinaryFixtureCalls, 0);
    assert.equal(fs.existsSync(path.join(testRoot, "ordinary-overlap")), false);

    resolveCapture();
    const result = await production;
    assert.equal(result.captureResult.capture.candidate.production, true);

    const ordinary = await runReviewCapture({
      runDir,
      candidateId: candidate.id,
      outDir: path.join(testRoot, "ordinary-after-production"),
      fixtureFactory: async () => ({ close: async () => undefined }),
      captureFn: async () => ({ marker: "shared slot released" }),
    });
    assert.deepEqual(ordinary.captureResult, { marker: "shared slot released" });
  });
});

test("fixture, capture, close, and dual failures are preserved and release the shared slot", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const fixtureError = new Error("test fixture acquisition failure");
    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir,
        fixtureFactory: async () => {
          throw fixtureError;
        },
        captureFn: async () => assert.fail("capture cannot run when fixture creation fails"),
      }),
      (error) => error === fixtureError,
    );
    assert.equal(fs.existsSync(outDir), true, "failed fixture acquisition retains the allocated output directory");

    const captureError = new Error("test capture failure");
    const closeError = new Error("test fixture close failure");
    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir: path.join(testRoot, "dual-failure"),
        fixtureFactory: async () => ({
          close: async () => {
            throw closeError;
          },
        }),
        captureFn: async () => {
          throw captureError;
        },
      }),
      (error) => error instanceof AggregateError && error.errors[0] === captureError && error.errors[1] === closeError,
    );
    assert.equal(fs.existsSync(path.join(testRoot, "dual-failure")), true, "dual failure retains its output directory");

    const closeOnlyError = new Error("test close-only failure");
    await assert.rejects(
      runProductionCapture({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        outDir: path.join(testRoot, "close-only-failure"),
        fixtureFactory: async () => ({
          close: async () => {
            throw closeOnlyError;
          },
        }),
        captureFn: async (input) => makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir }),
      }),
      (error) => error === closeOnlyError,
    );
    assert.equal(
      fs.existsSync(path.join(testRoot, "close-only-failure")),
      true,
      "close-only failure retains its output directory",
    );

    const retry = await runProductionCapture({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      outDir: path.join(testRoot, "after-failures"),
      fixtureFactory: async () => ({ close: async () => undefined }),
      captureFn: async (input) => makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir }),
    });
    assert.equal(retry.candidateId, candidate.id);
  });
});

test("formal result identity, output path, matrix modes, and metadata shape are enforced after close", async () => {
  await withProductionRun(async ({ candidate, runDir, selections, testRoot, verifiedModel }) => {
    const invalidResults = [
      (input) =>
        makeProductionMatrixResult({
          skinId: input.skinId,
          outDir: input.outDir,
          candidate: {
            production: true,
            skinId: input.skinId,
            id: candidate.id,
            candidateHash: candidate.candidateHash,
          },
        }),
      (input) =>
        makeProductionMatrixResult({
          skinId: input.skinId,
          outDir: input.outDir,
          candidate: { production: false, skinId: input.skinId },
        }),
      (input) =>
        makeProductionMatrixResult({
          skinId: input.skinId,
          outDir: input.outDir,
          candidate: { production: true, skinId: "wrong-skin" },
        }),
      (input) => makeProductionMatrixResult({ skinId: "wrong-skin", outDir: input.outDir }),
      (input) => makeProductionMatrixResult({ skinId: input.skinId, outDir: path.join(testRoot, "wrong-output") }),
      (input) => {
        const result = makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir });
        result.capture.modes.dark.status = "captured";
        return result;
      },
      (input) => {
        const result = makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir });
        result.capture.kind = "not-a-capture-matrix";
        return result;
      },
      (input) => {
        const result = makeProductionMatrixResult({ skinId: input.skinId, outDir: input.outDir });
        result.capture.schemaVersion = 2;
        return result;
      },
    ];

    for (const [index, makeResult] of invalidResults.entries()) {
      let closeCalls = 0;
      await assert.rejects(
        runProductionCapture({
          runDir,
          verifiedModel,
          selections,
          candidateId: candidate.id,
          outDir: path.join(testRoot, `invalid-result-${index}`),
          fixtureFactory: async () => ({
            close: async () => {
              closeCalls += 1;
            },
          }),
          captureFn: async (input) => makeResult(input),
        }),
        TypeError,
      );
      assert.equal(closeCalls, 1, "result validation occurs after fixture cleanup");
    }
  });
});

test("writes an exact production binding with raw file hashes and idempotently preserves its bytes", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    const { captureBytes, progressBytes } = await writeMatrixFiles(outDir, captureResult);
    const candidateBytes = await fs.promises.readFile(path.join(runDir, "candidates.json"));
    const inputsBefore = JSON.stringify({ verifiedModel, selections, captureResult });

    const result = await writeProductionCaptureBinding({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      captureResult,
    });

    const expectedPath = path.join(outDir, "production-selection.json");
    const bindingBytes = await fs.promises.readFile(expectedPath);
    assert.equal(result.bindingPath, expectedPath);
    assert.deepEqual(Object.keys(result.binding).sort(), [
      "candidateFileSha256",
      "captureFileSha256",
      "kind",
      "originRun",
      "progressFileSha256",
      "schemaVersion",
      "selectionBinding",
      "selectionHash",
    ]);
    assert.deepEqual(Object.keys(result.binding.selectionBinding).sort(), [
      "assessmentHash",
      "candidateHash",
      "candidateId",
      "candidateSetHash",
      "decisionSource",
      "recordedAt",
      "skinId",
    ]);
    assert.equal(result.binding.kind, "skin-palette-production-capture-binding");
    const repoReal = await fs.promises.realpath(REPO_ROOT);
    const runReal = await fs.promises.realpath(runDir);
    assert.equal(result.binding.originRun, path.relative(repoReal, runReal).split(path.sep).join("/"));
    assert.equal(path.posix.isAbsolute(result.binding.originRun), false);
    assert.equal(result.binding.originRun.startsWith("docs/validation/"), true);
    assert.equal(result.binding.selectionHash, sha256Canonical(selections));
    assert.equal(result.binding.candidateFileSha256, hashBytes(candidateBytes));
    assert.equal(result.binding.captureFileSha256, hashBytes(captureBytes));
    assert.equal(result.binding.progressFileSha256, hashBytes(progressBytes));
    assert.equal(result.binding.selectionBinding.candidateId, candidate.id);
    assert.equal(result.binding.selectionBinding.candidateHash, candidate.candidateHash);
    assert.equal(result.binding.selectionBinding.skinId, candidate.skinId);
    assert.equal(captureResult.modes.light.status, "incomplete", "incomplete evidence is recorded, not promoted");
    assert.deepEqual(JSON.parse(bindingBytes.toString("utf8")), result.binding);
    assert.equal(JSON.stringify({ verifiedModel, selections, captureResult }), inputsBefore);
    assert.deepEqual(await fs.promises.readFile(path.join(runDir, "candidates.json")), candidateBytes);
    assert.deepEqual(await fs.promises.readFile(path.join(outDir, "capture.json")), captureBytes);
    assert.deepEqual(await fs.promises.readFile(path.join(outDir, "progress.json")), progressBytes);

    const originalBindingBytes = Buffer.from(`${JSON.stringify(result.binding)}\n`);
    assert.notDeepEqual(originalBindingBytes, bindingBytes);
    await fs.promises.writeFile(expectedPath, originalBindingBytes);
    const repeated = await writeProductionCaptureBinding({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      captureResult,
    });
    assert.deepEqual(repeated, result);
    assert.deepEqual(
      await fs.promises.readFile(expectedPath),
      originalBindingBytes,
      "idempotent reuse retains original bytes",
    );
    assert.equal(JSON.stringify({ verifiedModel, selections, captureResult }), inputsBefore);
  });
});

test("rejects stale selection, local or drifted candidate set, and non-production capture identity", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    await writeMatrixFiles(outDir, captureResult);
    const bindingPath = path.join(outDir, "production-selection.json");
    const staleSelections = { ...selections, candidateSetHash: "f".repeat(64) };
    await assert.rejects(
      writeProductionCaptureBinding({
        runDir,
        verifiedModel,
        selections: staleSelections,
        candidateId: candidate.id,
        captureResult,
      }),
      TypeError,
    );
    assert.equal(fs.existsSync(bindingPath), false);

    const localSet = structuredClone(verifiedModel.candidateSet);
    localSet.candidates.pop();
    localSet.candidateSetHash = hashCandidateSet(localSet);
    await fs.promises.writeFile(path.join(runDir, "candidates.json"), `${JSON.stringify(localSet)}\n`, "utf8");
    await assert.rejects(
      writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult }),
      /缺少 .*（半套候选不接受）/,
    );
    assert.equal(fs.existsSync(bindingPath), false);

    const changedSet = structuredClone(verifiedModel.candidateSet);
    const changed = changedSet.candidates.find((item) => item.id === candidate.id);
    changed.style.rationale += " changed in actual run";
    changed.candidateHash = hashCandidate(changed);
    changed.id = `${changed.skinId}-${changed.variant}-${changed.candidateHash.slice(0, 12)}`;
    changedSet.candidateSetHash = hashCandidateSet(changedSet);
    await fs.promises.writeFile(path.join(runDir, "candidates.json"), `${JSON.stringify(changedSet)}\n`, "utf8");
    await assert.rejects(
      writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult }),
      /candidateSetHash does not match/,
    );
    assert.equal(fs.existsSync(bindingPath), false);

    await fs.promises.writeFile(
      path.join(runDir, "candidates.json"),
      `${JSON.stringify(verifiedModel.candidateSet)}\n`,
      "utf8",
    );
    captureResult.capture.candidate.id = candidate.id;
    await assert.rejects(
      writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult }),
      /must identify production mode/,
    );
    assert.equal(fs.existsSync(bindingPath), false);
  });
});

test("capture and progress files must parse and exactly match the supplied matrix result", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    await writeMatrixFiles(outDir, captureResult);
    captureResult.capture.extra = "in-memory drift";
    await assert.rejects(
      writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult }),
      /capture.json does not match/,
    );
    assert.equal(fs.existsSync(path.join(outDir, "production-selection.json")), false);

    delete captureResult.capture.extra;
    captureResult.progress.extra = "in-memory drift";
    await assert.rejects(
      writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult }),
      /progress.json does not match/,
    );
    assert.equal(fs.existsSync(path.join(outDir, "production-selection.json")), false);

    delete captureResult.progress.extra;
    await fs.promises.writeFile(path.join(outDir, "capture.json"), "{ broken json\n", "utf8");
    await assert.rejects(
      writeProductionCaptureBinding({ runDir, verifiedModel, selections, candidateId: candidate.id, captureResult }),
      /capture.json contains invalid JSON/,
    );
    assert.equal(fs.existsSync(path.join(outDir, "production-selection.json")), false);
  });
});

test("requires existing distinct validation directories and all three fixed source files", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    await writeMatrixFiles(outDir, captureResult);
    const args = { runDir, verifiedModel, selections, candidateId: candidate.id, captureResult };

    await assert.rejects(writeProductionCaptureBinding({ ...args, runDir: " " }), TypeError);
    await assert.rejects(
      writeProductionCaptureBinding({ ...args, runDir: "https://example.test/run" }),
      /not a URL|filesystem path/,
    );
    await assert.rejects(
      writeProductionCaptureBinding({
        ...args,
        captureResult: makeProductionMatrixResult({
          skinId: candidate.skinId,
          outDir: "https://example.test/output",
        }),
      }),
      /not a URL|filesystem path/,
    );
    await assert.rejects(
      writeProductionCaptureBinding({ ...args, runDir: validationRoot }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(
      writeProductionCaptureBinding({
        ...args,
        captureResult: makeProductionMatrixResult({ skinId: candidate.skinId, outDir: validationRoot }),
      }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(
      writeProductionCaptureBinding({
        ...args,
        captureResult: makeProductionMatrixResult({ skinId: candidate.skinId, outDir: runDir }),
      }),
      /different directories/,
    );

    const missingOut = path.join(testRoot, "missing-output");
    await assert.rejects(
      writeProductionCaptureBinding({
        ...args,
        captureResult: makeProductionMatrixResult({ skinId: candidate.skinId, outDir: missingOut }),
      }),
    );
    assert.equal(fs.existsSync(missingOut), false, "the writer does not create missing directories");

    const candidatesPath = path.join(runDir, "candidates.json");
    const candidatesBytes = await fs.promises.readFile(candidatesPath);
    await fs.promises.rm(candidatesPath);
    await assert.rejects(writeProductionCaptureBinding(args));
    await fs.promises.writeFile(candidatesPath, candidatesBytes);

    const capturePath = path.join(outDir, "capture.json");
    const captureBytes = await fs.promises.readFile(capturePath);
    await fs.promises.rm(capturePath);
    await assert.rejects(writeProductionCaptureBinding(args));
    await fs.promises.writeFile(capturePath, captureBytes);

    await fs.promises.rm(path.join(outDir, "progress.json"));
    await assert.rejects(writeProductionCaptureBinding(args));
    assert.equal(fs.existsSync(path.join(outDir, "production-selection.json")), false);

    await fs.promises.unlink(path.join(outDir, "capture.json"));
    await fs.promises.mkdir(path.join(outDir, "capture.json"));
    await assert.rejects(writeProductionCaptureBinding(args), /capture.json must be a regular file/);
    assert.equal(fs.existsSync(path.join(outDir, "production-selection.json")), false);
  });
});

test("rejects symlinked candidate and binding files when file symlinks are available", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const candidatesPath = path.join(runDir, "candidates.json");
    const candidatesBytes = await fs.promises.readFile(candidatesPath);
    const targetPath = path.join(runDir, "candidate-copy.json");
    await fs.promises.writeFile(targetPath, candidatesBytes);
    await fs.promises.unlink(candidatesPath);
    try {
      await fs.promises.symlink(targetPath, candidatesPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    await writeMatrixFiles(outDir, captureResult);
    const args = { runDir, verifiedModel, selections, candidateId: candidate.id, captureResult };
    await assert.rejects(writeProductionCaptureBinding(args), /candidates.json must not be a symlink/);

    await fs.promises.unlink(candidatesPath);
    await fs.promises.writeFile(candidatesPath, candidatesBytes);
    const bindingPath = path.join(outDir, "production-selection.json");
    await fs.promises.symlink(candidatesPath, bindingPath, "file");
    await assert.rejects(writeProductionCaptureBinding(args), /production-selection.json must not be a symlink/);
    assert.equal((await fs.promises.lstat(bindingPath)).isSymbolicLink(), true);
  });
});

test("refuses to overwrite different, unknown-shape, or malformed existing bindings", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    const { progressBytes } = await writeMatrixFiles(outDir, captureResult);
    const args = { runDir, verifiedModel, selections, candidateId: candidate.id, captureResult };
    const first = await writeProductionCaptureBinding(args);
    const bindingPath = first.bindingPath;
    const original = await fs.promises.readFile(bindingPath);

    const resumedResult = structuredClone(captureResult);
    resumedResult.progress.resumedAt = "2026-10-08T12:00:00.000Z";
    await fs.promises.writeFile(
      path.join(outDir, "progress.json"),
      `${JSON.stringify(resumedResult.progress)}\n`,
      "utf8",
    );
    await assert.rejects(
      writeProductionCaptureBinding({ ...args, captureResult: resumedResult }),
      /different or unsupported binding/,
    );
    assert.deepEqual(
      await fs.promises.readFile(bindingPath),
      original,
      "resume metadata drift cannot overwrite binding",
    );
    await fs.promises.writeFile(path.join(outDir, "progress.json"), progressBytes);

    const changedSource = { ...selections, decisionSource: "TEST ONLY: different valid source text" };
    await assert.rejects(
      writeProductionCaptureBinding({ ...args, selections: changedSource }),
      /different or unsupported binding/,
    );
    assert.deepEqual(await fs.promises.readFile(bindingPath), original);

    const unsupported = Buffer.from(`${JSON.stringify({ ...first.binding, unexpected: true })}\n`);
    await fs.promises.writeFile(bindingPath, unsupported);
    await assert.rejects(writeProductionCaptureBinding(args), /different or unsupported binding/);
    assert.deepEqual(await fs.promises.readFile(bindingPath), unsupported);

    const malformed = Buffer.from("not json\n");
    await fs.promises.writeFile(bindingPath, malformed);
    await assert.rejects(writeProductionCaptureBinding(args), /production-selection.json contains invalid JSON/);
    assert.deepEqual(await fs.promises.readFile(bindingPath), malformed);

    assert.equal(fs.existsSync(path.join(testRoot, "source-run", "candidates.json")), true);
  });
});

test("rejects realpath escapes through dynamically tested directory junctions", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const captureResult = makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
    await writeMatrixFiles(outDir, captureResult);
    const runJunction = path.join(testRoot, "run-junction");
    const outJunction = path.join(testRoot, "out-junction");
    try {
      await fs.promises.symlink(REPO_ROOT, runJunction, "junction");
      await fs.promises.symlink(REPO_ROOT, outJunction, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const args = { runDir, verifiedModel, selections, candidateId: candidate.id, captureResult };
    await assert.rejects(writeProductionCaptureBinding({ ...args, runDir: runJunction }), /realpath.*strict child/);
    await assert.rejects(
      writeProductionCaptureBinding({
        ...args,
        captureResult: makeProductionMatrixResult({ skinId: candidate.skinId, outDir: outJunction }),
      }),
      /realpath.*strict child/,
    );
    assert.equal(fs.existsSync(path.join(outDir, "production-selection.json")), false);
  });
});

async function createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel, captureResult } = {}) {
  const result = captureResult ?? makeProductionMatrixResult({ skinId: candidate.skinId, outDir });
  await writeMatrixFiles(outDir, result);
  const written = await writeProductionCaptureBinding({
    runDir,
    verifiedModel,
    selections,
    candidateId: candidate.id,
    captureResult: result,
  });
  return { captureResult: result, written };
}

function readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }) {
  return { runDir, outDir, verifiedModel, selections, candidateId: candidate.id };
}

test("reads an exact existing binding as independent five-field evidence without mutation", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const { captureResult, written } = await createBoundCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
    });
    const paths = [
      path.join(runDir, "candidates.json"),
      path.join(outDir, "capture.json"),
      path.join(outDir, "progress.json"),
      written.bindingPath,
    ];
    const fileBytesBefore = await Promise.all(paths.map((filePath) => fs.promises.readFile(filePath)));
    const inputsBefore = JSON.stringify({ verifiedModel, selections });

    const result = await readProductionCaptureBinding(
      readBindingArgs({
        candidate,
        outDir,
        runDir,
        selections,
        verifiedModel,
      }),
    );
    assert.deepEqual(Object.keys(result).sort(), ["binding", "bindingPath", "captureResult"]);
    assert.deepEqual(Object.keys(result.captureResult).sort(), ["capture", "modes", "outDir", "progress", "skinId"]);
    assert.equal(result.bindingPath, written.bindingPath);
    assert.deepEqual(result.binding, written.binding);
    assert.deepEqual(result.captureResult, {
      outDir: await fs.promises.realpath(outDir),
      skinId: candidate.skinId,
      modes: captureResult.modes,
      capture: captureResult.capture,
      progress: captureResult.progress,
    });
    assert.notStrictEqual(result.binding, written.binding);
    assert.notStrictEqual(result.captureResult.capture, captureResult.capture);
    assert.equal(JSON.stringify({ verifiedModel, selections }), inputsBefore);

    result.binding.selectionBinding.decisionSource = "mutated returned copy";
    result.captureResult.capture.candidate.skinId = "mutated returned copy";
    assert.equal(written.binding.selectionBinding.decisionSource, selections.decisionSource);
    assert.equal(captureResult.capture.candidate.skinId, candidate.skinId);
    for (const [index, filePath] of paths.entries()) {
      assert.deepEqual(await fs.promises.readFile(filePath), fileBytesBefore[index]);
    }

    const failedModes = {
      light: { status: "failed", reason: "synthetic failed state" },
      dark: { status: "incomplete", reason: "synthetic incomplete state" },
    };
    const failedOutDir = path.join(testRoot, "failed-capture-output");
    const failed = await createBoundCapture({
      candidate,
      outDir: failedOutDir,
      runDir,
      selections,
      verifiedModel,
      captureResult: makeProductionMatrixResult({
        skinId: candidate.skinId,
        outDir: failedOutDir,
        modes: failedModes,
      }),
    });
    const failedRead = await readProductionCaptureBinding(
      readBindingArgs({ candidate, outDir: failedOutDir, runDir, selections, verifiedModel }),
    );
    assert.deepEqual(failedRead.captureResult.modes, failedModes, "failed/incomplete states are preserved verbatim");
    assert.deepEqual(failedRead.binding, failed.written.binding);
  });
});

test("a missing sidecar is rejected and the read path never creates it", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    await writeMatrixFiles(outDir, makeProductionMatrixResult({ skinId: candidate.skinId, outDir }));
    const bindingPath = path.join(outDir, "production-selection.json");
    assert.equal(fs.existsSync(bindingPath), false);
    await assert.rejects(
      readProductionCaptureBinding(readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel })),
    );
    assert.equal(fs.existsSync(bindingPath), false);
  });
});

test("rejects every unknown, missing, or tampered production binding identity field", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const { written } = await createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const pristineBytes = await fs.promises.readFile(written.bindingPath);
    const pristine = JSON.parse(pristineBytes.toString("utf8"));
    const tamperCases = [
      ["schemaVersion", (binding) => (binding.schemaVersion = 2)],
      ["kind", (binding) => (binding.kind = "other")],
      ["unknown field", (binding) => (binding.extra = true)],
      ["selectionBinding.skinId", (binding) => (binding.selectionBinding.skinId = "wrong-skin")],
      ["selectionBinding.candidateId", (binding) => (binding.selectionBinding.candidateId = "other")],
      ["selectionBinding.candidateHash", (binding) => (binding.selectionBinding.candidateHash = "f".repeat(64))],
      ["selectionBinding.candidateSetHash", (binding) => (binding.selectionBinding.candidateSetHash = "e".repeat(64))],
      ["selectionBinding.assessmentHash", (binding) => (binding.selectionBinding.assessmentHash = "d".repeat(64))],
      ["selectionBinding.decisionSource", (binding) => (binding.selectionBinding.decisionSource = "other")],
      ["selectionBinding.recordedAt", (binding) => (binding.selectionBinding.recordedAt = "2026-10-07T08:31:00.000Z")],
      ["selectionHash", (binding) => (binding.selectionHash = "c".repeat(64))],
      ["originRun", (binding) => (binding.originRun = "docs/validation/other-run")],
      ["candidateFileSha256", (binding) => (binding.candidateFileSha256 = "b".repeat(64))],
      ["captureFileSha256", (binding) => (binding.captureFileSha256 = "a".repeat(64))],
      ["progressFileSha256", (binding) => (binding.progressFileSha256 = "9".repeat(64))],
      ["missing selectionBinding identity field", (binding) => delete binding.selectionBinding.assessmentHash],
      ["missing root identity field", (binding) => delete binding.progressFileSha256],
    ];

    for (const [label, tamper] of tamperCases) {
      const changed = structuredClone(pristine);
      tamper(changed);
      const changedBytes = Buffer.from(`${JSON.stringify(changed)}\n`);
      await fs.promises.writeFile(written.bindingPath, changedBytes);
      await assert.rejects(
        readProductionCaptureBinding(readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel })),
        TypeError,
        label,
      );
      assert.deepEqual(await fs.promises.readFile(written.bindingPath), changedBytes, `${label} is not rewritten`);
    }
    await fs.promises.writeFile(written.bindingPath, pristineBytes);
  });
});

test("selection and on-disk CandidateSet drift invalidate a previously valid binding", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const { written } = await createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const originalBindingBytes = await fs.promises.readFile(written.bindingPath);
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const changedSelections = {
      ...selections,
      decisionSource: "TEST ONLY: changed but valid selection source",
    };
    await assert.rejects(
      readProductionCaptureBinding({ ...args, selections: changedSelections }),
      /does not match the current selection and capture evidence/,
    );

    const candidatePath = path.join(runDir, "candidates.json");
    const originalCandidateBytes = await fs.promises.readFile(candidatePath);
    const changedSet = structuredClone(verifiedModel.candidateSet);
    const other = changedSet.candidates.find((entry) => entry.skinId === candidate.skinId && entry.variant === "b");
    other.style.rationale += " changed on disk";
    other.candidateHash = hashCandidate(other);
    other.id = `${other.skinId}-${other.variant}-${other.candidateHash.slice(0, 12)}`;
    changedSet.candidateSetHash = hashCandidateSet(changedSet);
    await fs.promises.writeFile(candidatePath, `${JSON.stringify(changedSet)}\n`, "utf8");
    await assert.rejects(readProductionCaptureBinding(args), /candidateSetHash does not match the original selection/);
    await fs.promises.writeFile(candidatePath, originalCandidateBytes);
    assert.deepEqual(await fs.promises.readFile(written.bindingPath), originalBindingBytes);
  });
});

test("raw capture/progress byte changes and non-production or wrong-skin captures are rejected", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    await createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const capturePath = path.join(outDir, "capture.json");
    const progressPath = path.join(outDir, "progress.json");
    const originalCapture = await fs.promises.readFile(capturePath);
    const originalProgress = await fs.promises.readFile(progressPath);
    const bindingPath = path.join(outDir, "production-selection.json");
    const originalBinding = await fs.promises.readFile(bindingPath);

    for (const [label, filePath, original] of [
      ["capture", capturePath, originalCapture],
      ["progress", progressPath, originalProgress],
    ]) {
      const parsed = JSON.parse(original.toString("utf8"));
      const reformatted = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
      assert.notDeepEqual(reformatted, original);
      await fs.promises.writeFile(filePath, reformatted);
      await assert.rejects(
        readProductionCaptureBinding(args),
        /does not match the current selection and capture evidence/,
      );
      assert.deepEqual(await fs.promises.readFile(filePath), reformatted, `${label} bytes are not rewritten`);
      await fs.promises.writeFile(filePath, original);
    }

    for (const [label, mutate] of [
      [
        "ordinary candidate",
        (capture) => (capture.candidate = { id: candidate.id, candidateHash: candidate.candidateHash }),
      ],
      ["wrong skin", (capture) => (capture.candidate.skinId = "wrong-skin")],
    ]) {
      const capture = JSON.parse(originalCapture.toString("utf8"));
      mutate(capture);
      const changedBytes = Buffer.from(`${JSON.stringify(capture)}\n`);
      await fs.promises.writeFile(capturePath, changedBytes);
      await assert.rejects(readProductionCaptureBinding(args), TypeError, label);
      assert.deepEqual(await fs.promises.readFile(capturePath), changedBytes);
      await fs.promises.writeFile(capturePath, originalCapture);
    }
    assert.deepEqual(await fs.promises.readFile(progressPath), originalProgress);
    assert.deepEqual(await fs.promises.readFile(bindingPath), originalBinding);
  });
});

test("rejects invalid directories, missing fixed evidence, bad JSON, and directory-valued evidence", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    await createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    await assert.rejects(readProductionCaptureBinding({ ...args, runDir: " " }), /non-empty filesystem path/);
    await assert.rejects(
      readProductionCaptureBinding({ ...args, runDir: "https://example.test/run" }),
      /filesystem path/,
    );
    await assert.rejects(
      readProductionCaptureBinding({ ...args, runDir: validationRoot }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(
      readProductionCaptureBinding({ ...args, outDir: validationRoot }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(
      readProductionCaptureBinding({ ...args, outDir: path.join(validationRoot, "..", "outside") }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(readProductionCaptureBinding({ ...args, outDir: runDir }), /different directories/);
    await assert.rejects(
      readProductionCaptureBinding({ ...args, runDir: path.join(runDir, "candidates.json") }),
      /existing directory/,
    );

    const missingOut = path.join(testRoot, "missing-output");
    await assert.rejects(readProductionCaptureBinding({ ...args, outDir: missingOut }));
    assert.equal(fs.existsSync(missingOut), false, "read path does not create output directories");

    for (const [fileName, parent] of [
      ["candidates.json", runDir],
      ["capture.json", outDir],
      ["progress.json", outDir],
    ]) {
      const filePath = path.join(parent, fileName);
      const original = await fs.promises.readFile(filePath);
      await fs.promises.rm(filePath);
      await assert.rejects(readProductionCaptureBinding(args));
      assert.equal(fs.existsSync(filePath), false, `${fileName} remains missing`);
      await fs.promises.writeFile(filePath, original);
    }

    const capturePath = path.join(outDir, "capture.json");
    const originalCapture = await fs.promises.readFile(capturePath);
    await fs.promises.writeFile(capturePath, "{ broken json\n", "utf8");
    await assert.rejects(readProductionCaptureBinding(args), /capture.json contains invalid JSON/);
    await fs.promises.writeFile(capturePath, originalCapture);

    await fs.promises.unlink(capturePath);
    await fs.promises.mkdir(capturePath);
    await assert.rejects(readProductionCaptureBinding(args), /capture.json must be a regular file/);

    await fs.promises.rm(capturePath, { recursive: true });
    await fs.promises.writeFile(capturePath, originalCapture);
    const bindingPath = path.join(outDir, "production-selection.json");
    const originalBinding = await fs.promises.readFile(bindingPath);
    await fs.promises.writeFile(bindingPath, "{ broken binding\n", "utf8");
    await assert.rejects(readProductionCaptureBinding(args), /production-selection.json contains invalid JSON/);
    await fs.promises.writeFile(bindingPath, originalBinding);
  });
});

test("rejects source and binding file symlinks when file symlinks are available", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    await createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const candidatePath = path.join(runDir, "candidates.json");
    const candidateBytes = await fs.promises.readFile(candidatePath);
    const targetPath = path.join(runDir, "candidate-copy.json");
    await fs.promises.writeFile(targetPath, candidateBytes);
    await fs.promises.unlink(candidatePath);
    try {
      await fs.promises.symlink(targetPath, candidatePath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(readProductionCaptureBinding(args), /candidates.json must not be a symlink/);

    await fs.promises.unlink(candidatePath);
    await fs.promises.writeFile(candidatePath, candidateBytes);
    const bindingPath = path.join(outDir, "production-selection.json");
    await fs.promises.unlink(bindingPath);
    await fs.promises.symlink(targetPath, bindingPath, "file");
    await assert.rejects(readProductionCaptureBinding(args), /production-selection.json must not be a symlink/);
  });
});

test("rejects run and output directory junctions before reading outside validation", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    await createBoundCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const runJunction = path.join(testRoot, "run-junction");
    const outJunction = path.join(testRoot, "out-junction");
    try {
      await fs.promises.symlink(REPO_ROOT, runJunction, "junction");
      await fs.promises.symlink(REPO_ROOT, outJunction, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(readProductionCaptureBinding({ ...args, runDir: runJunction }), /realpath.*strict child/);
    await assert.rejects(readProductionCaptureBinding({ ...args, outDir: outJunction }), /realpath.*strict child/);
  });
});

test("verifies the default fixed source list and rejects post-capture palette drift", async () => {
  await withProductionRun(async ({ candidate, outDir }) => {
    assert.equal(SOURCE_FILES.length, 31);
    const timelineFile = "public/timeline-utils.js";
    assert.ok(SOURCE_FILES.includes(timelineFile));
    const current = collectSourceHashes(SOURCE_FILES, (relativePath) =>
      fs.readFileSync(path.join(REPO_ROOT, relativePath)),
    );
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
      assert.equal(current[file], hashBytes(fs.readFileSync(path.join(REPO_ROOT, file))));
      const missing = makeSourceHashCapture({ candidate, outDir, sourceHashes: { ...current } });
      delete missing.capture.sourceHashes[file];
      const missingResult = verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult: missing });
      assert.equal(missingResult.status, "incomplete");
      assert.ok(missingResult.gaps.some((gap) => gap.file === file));
      const changed = makeSourceHashCapture({
        candidate,
        outDir,
        sourceHashes: { ...current, [file]: "0".repeat(64) },
      });
      const changedResult = verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult: changed });
      assert.equal(changedResult.status, "rejected");
      assert.ok(changedResult.errors.some((error) => error.code === "source-changed" && error.file === file));
    }
    assert.equal(current[timelineFile], hashBytes(fs.readFileSync(path.join(REPO_ROOT, timelineFile))));
    const captureResult = makeSourceHashCapture({ candidate, outDir, sourceHashes: current });
    const captureBefore = JSON.stringify(captureResult);

    assert.deepEqual(verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult }), {
      status: "pass",
      errors: [],
      gaps: [],
    });
    assert.equal(JSON.stringify(captureResult), captureBefore);

    const changedPalette = structuredClone(captureResult);
    const paletteFile = "public/skin-palettes.js";
    const originalHash = changedPalette.capture.sourceHashes[paletteFile];
    changedPalette.capture.sourceHashes[paletteFile] = `${originalHash[0] === "0" ? "1" : "0"}${originalHash.slice(1)}`;
    const drift = verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult: changedPalette });
    assert.equal(drift.status, "rejected");
    assert.deepEqual(
      drift.errors.map(({ code, file }) => [code, file]),
      [["source-changed", paletteFile]],
    );

    const changedTimeline = structuredClone(captureResult);
    const originalTimelineHash = changedTimeline.capture.sourceHashes[timelineFile];
    changedTimeline.capture.sourceHashes[timelineFile] =
      `${originalTimelineHash[0] === "0" ? "1" : "0"}${originalTimelineHash.slice(1)}`;
    const timelineDrift = verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult: changedTimeline });
    assert.deepEqual(
      timelineDrift.errors.map(({ code, file }) => [code, file]),
      [["source-changed", timelineFile]],
      "post-capture timeline source changes must be stale evidence",
    );

    const oldCaptureHash = structuredClone(captureResult);
    const captureFile = "scripts/skin-palette/capture.mjs";
    oldCaptureHash.capture.sourceHashes[captureFile] =
      "9ee883f00db2ec8a167fddbf0bde3491e4cf6f507888a258b5f13ac09c217f45";
    const captureDrift = verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult: oldCaptureHash });
    assert.deepEqual(
      captureDrift.errors.map(({ code, file }) => [code, file]),
      [["source-changed", captureFile]],
      "previous captures keep their old digest and discover the export-only capture tool change",
    );

    const unknownPath = structuredClone(captureResult);
    unknownPath.capture.sourceHashes["public/definitely-not-registered-c3a.js"] = "not-a-hash";
    const unknown = verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult: unknownPath });
    assert.equal(unknown.status, "rejected");
    assert.deepEqual(
      unknown.errors.map(({ code, file }) => [code, file]),
      [["unknown-source-file", "public/definitely-not-registered-c3a.js"]],
    );
  });
});

test("distinguishes missing, invalid, changed, and sorted unknown source diagnostics", async () => {
  await withProductionRun(async ({ candidate, outDir }) => {
    const current = makeSourceHashes();
    const absent = makeSourceHashCapture({ candidate, outDir, sourceHashes: undefined });
    const missingAll = verifyProductionSourceHashes({
      skinId: candidate.skinId,
      captureResult: absent,
      currentSourceHashes: current,
    });
    assert.equal(missingAll.status, "incomplete");
    assert.equal(missingAll.errors.length, 0);
    assert.deepEqual(
      missingAll.gaps.map(({ code, file }) => [code, file]),
      SOURCE_FILES.map((file) => ["missing-source-hash", file]),
    );

    const nullHashes = makeSourceHashCapture({ candidate, outDir, sourceHashes: null });
    const nullMissing = verifyProductionSourceHashes({
      skinId: candidate.skinId,
      captureResult: nullHashes,
      currentSourceHashes: current,
    });
    assert.equal(nullMissing.status, "incomplete");
    assert.equal(nullMissing.gaps.length, SOURCE_FILES.length);

    const recorded = makeSourceHashes();
    const missingFiles = [...SOURCE_FILES.slice(0, 2), "public/timeline-utils.js"];
    for (const file of missingFiles) delete recorded[file];
    recorded[SOURCE_FILES[2]] = "A".repeat(64);
    recorded[SOURCE_FILES[3]] = "b".repeat(64);
    recorded["z-unregistered-source"] = null;
    recorded["a-unregistered-source"] = "bad";
    const captureResult = makeSourceHashCapture({ candidate, outDir, sourceHashes: recorded });
    const captureBefore = JSON.stringify(captureResult);
    const currentBefore = JSON.stringify(current);
    const diagnostics = verifyProductionSourceHashes({
      skinId: candidate.skinId,
      captureResult,
      currentSourceHashes: current,
    });

    assert.equal(diagnostics.status, "rejected");
    assert.deepEqual(
      diagnostics.gaps.map(({ code, file }) => [code, file]),
      missingFiles.map((file) => ["missing-source-hash", file]),
    );
    assert.deepEqual(
      diagnostics.errors.map(({ code, file }) => [code, file]),
      [
        ["invalid-source-hash", SOURCE_FILES[2]],
        ["source-changed", SOURCE_FILES[3]],
        ["unknown-source-file", "a-unregistered-source"],
        ["unknown-source-file", "z-unregistered-source"],
      ],
    );
    assert.ok(
      [...diagnostics.errors, ...diagnostics.gaps].every(
        (item) => Object.keys(item).sort().join(",") === "code,detail,file",
      ),
    );
    assert.equal(JSON.stringify(captureResult), captureBefore);
    assert.equal(JSON.stringify(current), currentBefore);
  });
});

test("uses own source-hash keys and rejects invalid recorded hash values", async () => {
  await withProductionRun(async ({ candidate, outDir }) => {
    const current = makeSourceHashes();
    const inheritedFile = SOURCE_FILES[0];
    const recorded = makeSourceHashes();
    delete recorded[inheritedFile];
    const captureResult = makeSourceHashCapture({ candidate, outDir, sourceHashes: recorded });
    const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, inheritedFile);
    assert.equal(priorDescriptor, undefined, "test source path must not already be on Object.prototype");
    Object.defineProperty(Object.prototype, inheritedFile, { configurable: true, value: current[inheritedFile] });
    try {
      assert.equal(recorded[inheritedFile], current[inheritedFile], "the synthetic hash is inherited");
      const result = verifyProductionSourceHashes({
        skinId: candidate.skinId,
        captureResult,
        currentSourceHashes: current,
      });
      assert.equal(result.status, "incomplete");
      assert.deepEqual(
        result.gaps.map(({ code, file }) => [code, file]),
        [["missing-source-hash", inheritedFile]],
      );
    } finally {
      delete Object.prototype[inheritedFile];
    }

    for (const invalid of [undefined, null, "", "a".repeat(63), "A".repeat(64), 42, {}]) {
      const sourceHashes = makeSourceHashes();
      sourceHashes[inheritedFile] = invalid;
      const result = verifyProductionSourceHashes({
        skinId: candidate.skinId,
        captureResult: makeSourceHashCapture({ candidate, outDir, sourceHashes }),
        currentSourceHashes: current,
      });
      assert.equal(result.status, "rejected", String(invalid));
      assert.deepEqual(
        result.errors.map(({ code, file }) => [code, file]),
        [["invalid-source-hash", inheritedFile]],
      );
    }

    for (const invalidSourceHashes of [[], new Date(), new Map(), "hashes", 42, Object.create({})]) {
      assert.throws(
        () =>
          verifyProductionSourceHashes({
            skinId: candidate.skinId,
            captureResult: makeSourceHashCapture({ candidate, outDir, sourceHashes: invalidSourceHashes }),
            currentSourceHashes: current,
          }),
        TypeError,
      );
    }

    const symbolKeyed = makeSourceHashes();
    symbolKeyed[Symbol("unregistered")] = "a".repeat(64);
    assert.throws(
      () =>
        verifyProductionSourceHashes({
          skinId: candidate.skinId,
          captureResult: makeSourceHashCapture({ candidate, outDir, sourceHashes: symbolKeyed }),
          currentSourceHashes: current,
        }),
      TypeError,
    );
  });
});

test("validates injected current hashes, explicit null, and formal identity without mixing matrix status", async () => {
  await withProductionRun(async ({ candidate, outDir }) => {
    const validCurrent = makeSourceHashes();
    const sourceHashes = makeSourceHashes();
    const captureResult = makeSourceHashCapture({ candidate, outDir, sourceHashes });
    assert.deepEqual(
      verifyProductionSourceHashes({
        skinId: candidate.skinId,
        captureResult,
        currentSourceHashes: Object.assign(Object.create(null), validCurrent),
      }),
      { status: "pass", errors: [], gaps: [] },
    );

    assert.throws(
      () => verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult, currentSourceHashes: null }),
      /currentSourceHashes must be/,
      "explicit null is invalid and does not select the default disk reader",
    );
    for (const invalidCurrent of [[], new Date(), new Map(), Object.create({}), {}]) {
      assert.throws(
        () =>
          verifyProductionSourceHashes({
            skinId: candidate.skinId,
            captureResult,
            currentSourceHashes: invalidCurrent,
          }),
        TypeError,
      );
    }
    const incompleteCurrent = { ...validCurrent };
    delete incompleteCurrent[SOURCE_FILES[0]];
    assert.throws(
      () =>
        verifyProductionSourceHashes({
          skinId: candidate.skinId,
          captureResult,
          currentSourceHashes: incompleteCurrent,
        }),
      /missing registered source/,
    );
    const invalidCurrentValue = { ...validCurrent, extra: "invalid" };
    assert.throws(
      () =>
        verifyProductionSourceHashes({
          skinId: candidate.skinId,
          captureResult,
          currentSourceHashes: invalidCurrentValue,
        }),
      /64-character lowercase SHA-256/,
    );

    for (const status of ["incomplete", "failed"]) {
      const modes = {
        light: { status, reason: "matrix status is outside source sub-check" },
        dark: { status: "captured" },
      };
      const statusCapture = makeSourceHashCapture({ candidate, outDir, sourceHashes, modes });
      assert.deepEqual(
        verifyProductionSourceHashes({
          skinId: candidate.skinId,
          captureResult: statusCapture,
          currentSourceHashes: validCurrent,
        }),
        { status: "pass", errors: [], gaps: [] },
        `${status} matrix status does not contaminate the source-only result`,
      );
    }

    const wrongIdentity = makeSourceHashCapture({
      candidate,
      outDir,
      sourceHashes,
    });
    wrongIdentity.capture.candidate = { production: false, skinId: candidate.skinId };
    assert.throws(
      () =>
        verifyProductionSourceHashes({
          skinId: candidate.skinId,
          captureResult: wrongIdentity,
          currentSourceHashes: validCurrent,
        }),
      TypeError,
    );
  });
});

test("source-origin check passes all loader-shaped candidate records without mutation", () => {
  const { evidence, beforeSourceHashes: ordinaryHashes } = makeSourceOriginsFixture();
  const beforeSourceHashes = Object.assign(Object.create(null), ordinaryHashes);
  const second = evidence.candidateSet.data.candidates[1];
  evidence.captures[second.id].capture.sourceHashes = Object.assign(
    Object.create(null),
    evidence.captures[second.id].capture.sourceHashes,
  );
  assert.equal(evidence.candidateSet.data.candidates.length, 2);
  const evidenceBefore = JSON.stringify(evidence);
  const hashesBefore = JSON.stringify(beforeSourceHashes);

  const result = verifyProductionSourceOrigins({ evidence, beforeSourceHashes });
  assert.deepEqual(result, { status: "pass", errors: [], gaps: [] });
  assert.deepEqual(
    verifyProductionSourceOrigins({ evidence, beforeSourceHashes }),
    result,
    "repeated calls are stable",
  );
  assert.equal(JSON.stringify(evidence), evidenceBefore);
  assert.equal(JSON.stringify(beforeSourceHashes), hashesBefore);
  assert.equal(Object.isFrozen(evidence), false);
  assert.equal(Object.isFrozen(beforeSourceHashes), false);
});

test("source-origin check compares every candidate and keeps candidate/source registration order", () => {
  const { evidence, beforeSourceHashes } = makeSourceOriginsFixture();
  const [first, second] = evidence.candidateSet.data.candidates;
  evidence.captures[first.id].capture.sourceHashes["public/app.js"] = "b".repeat(64);
  evidence.captures[second.id].capture.sourceHashes["public/skin-palettes.js"] = "b".repeat(64);
  evidence.captures[second.id].capture.sourceHashes["public/skin-picker.js"] = "c".repeat(64);
  evidence.captures[second.id].capture.sourceHashes["scripts/skin-palette/roles.mjs"] = "d".repeat(64);

  const result = verifyProductionSourceOrigins({ evidence, beforeSourceHashes });
  assert.equal(result.status, "rejected", "the first matching candidate cannot mask stale origins later in the set");
  assert.deepEqual(
    result.errors.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [
      ["origin-source-hash-mismatch", first.id, "public/app.js"],
      ["origin-source-hash-mismatch", second.id, "public/skin-palettes.js"],
      ["origin-source-hash-mismatch", second.id, "public/skin-picker.js"],
      ["origin-source-hash-mismatch", second.id, "scripts/skin-palette/roles.mjs"],
    ],
  );
});

test("source-origin gaps distinguish absent captures, maps, and individual source hashes", () => {
  const { evidence, beforeSourceHashes } = makeSourceOriginsFixture();
  const [first, second] = evidence.candidateSet.data.candidates;
  delete evidence.captures[first.id];
  evidence.captures[second.id].capture.sourceHashes = null;

  const result = verifyProductionSourceOrigins({ evidence, beforeSourceHashes });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.gaps.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [
      ["origin-capture-missing", first.id, null],
      ["origin-source-hashes-missing", second.id, null],
    ],
  );

  const absentMap = makeSourceOriginsFixture();
  const [candidateWithoutMap] = absentMap.evidence.candidateSet.data.candidates;
  delete absentMap.evidence.captures[candidateWithoutMap.id].capture.sourceHashes;
  assert.deepEqual(verifyProductionSourceOrigins(absentMap), {
    status: "incomplete",
    errors: [],
    gaps: [
      {
        code: "origin-source-hashes-missing",
        candidateId: candidateWithoutMap.id,
        path: null,
        detail: "capture.json has no sourceHashes map",
      },
    ],
  });

  const partial = makeSourceOriginsFixture();
  const [candidate] = partial.evidence.candidateSet.data.candidates;
  const sourceHashes = partial.evidence.captures[candidate.id].capture.sourceHashes;
  delete sourceHashes[SOURCE_FILES[0]];
  delete sourceHashes["public/timeline-utils.js"];
  sourceHashes[SOURCE_FILES[1]] = null;
  sourceHashes[SOURCE_FILES[2]] = undefined;
  sourceHashes[SOURCE_FILES[3]] = "A".repeat(64);
  sourceHashes["z-unregistered.js"] = "f".repeat(64);
  sourceHashes["a-unregistered.js"] = "e".repeat(64);

  const partialResult = verifyProductionSourceOrigins(partial);
  assert.equal(partialResult.status, "rejected");
  assert.deepEqual(
    partialResult.gaps.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [
      ["origin-source-hash-missing", candidate.id, SOURCE_FILES[0]],
      ["origin-source-hash-missing", candidate.id, SOURCE_FILES[1]],
      ["origin-source-hash-missing", candidate.id, "public/timeline-utils.js"],
    ],
  );
  assert.deepEqual(
    partialResult.errors.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [
      ["origin-source-hash-invalid", candidate.id, SOURCE_FILES[2]],
      ["origin-source-hash-invalid", candidate.id, SOURCE_FILES[3]],
      ["unknown-origin-source-file", candidate.id, "a-unregistered.js"],
      ["unknown-origin-source-file", candidate.id, "z-unregistered.js"],
    ],
  );
});

test("source-origin check rejects capture identity drift and unregistered capture IDs", () => {
  const identityMutations = [
    ["outer candidateId", (record) => (record.candidateId = "wrong-id")],
    ["outer skinId", (record) => (record.skinId = "wrong-skin")],
    ["inner candidate id", (record) => (record.capture.candidate.id = "wrong-id")],
    ["inner candidate hash", (record) => (record.capture.candidate.candidateHash = "f".repeat(64))],
    ["inner skinId", (record) => (record.capture.candidate.skinId = "wrong-skin")],
    ["formal production capture", (record) => (record.capture.candidate.production = true)],
  ];
  for (const [label, mutate] of identityMutations) {
    const fixture = makeSourceOriginsFixture();
    const candidate = fixture.evidence.candidateSet.data.candidates[0];
    mutate(fixture.evidence.captures[candidate.id]);
    const result = verifyProductionSourceOrigins(fixture);
    assert.equal(result.status, "rejected", label);
    assert.deepEqual(
      result.errors.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
      [["origin-capture-identity-mismatch", candidate.id, null]],
      label,
    );
    assert.deepEqual(result.gaps, [], label);
  }

  const { evidence, beforeSourceHashes } = makeSourceOriginsFixture();
  const [first, second] = evidence.candidateSet.data.candidates;
  evidence.captures[first.id].candidateId = "mis-keyed-candidate";
  evidence.captures[second.id].capture.candidate.production = true;
  const unknownCapture = structuredClone(evidence.captures[first.id]);
  unknownCapture.relativePath = "captures/unregistered-id";
  evidence.captures["unregistered-id"] = unknownCapture;
  const unknownZ = structuredClone(unknownCapture);
  unknownZ.relativePath = "captures/z-unregistered";
  const unknownA = structuredClone(unknownCapture);
  unknownA.relativePath = "captures/a-unregistered";
  evidence.captures.zUnregistered = unknownZ;
  evidence.captures.aUnregistered = unknownA;

  const result = verifyProductionSourceOrigins({ evidence, beforeSourceHashes });
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [
      ["origin-capture-identity-mismatch", first.id, null],
      ["origin-capture-identity-mismatch", second.id, null],
      ["unknown-origin-capture", "aUnregistered", "captures/a-unregistered"],
      ["unknown-origin-capture", "unregistered-id", "captures/unregistered-id"],
      ["unknown-origin-capture", "zUnregistered", "captures/z-unregistered"],
    ],
  );

  const alias = makeSourceOriginsFixture();
  const [aliasedCandidate] = alias.evidence.candidateSet.data.candidates;
  const aliasedRecord = alias.evidence.captures[aliasedCandidate.id];
  delete alias.evidence.captures[aliasedCandidate.id];
  alias.evidence.captures["renamed-candidate"] = aliasedRecord;
  const aliasResult = verifyProductionSourceOrigins(alias);
  assert.deepEqual(
    aliasResult.errors.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [["unknown-origin-capture", "renamed-candidate", `captures/${aliasedCandidate.id}`]],
  );
  assert.deepEqual(
    aliasResult.gaps.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
    [["origin-capture-missing", aliasedCandidate.id, null]],
  );
});

test("source-origin contracts reject malformed source maps, loader records, and CandidateSets", () => {
  const base = makeSourceOriginsFixture();
  const missingBeforeHash = { ...base.beforeSourceHashes };
  delete missingBeforeHash[SOURCE_FILES[0]];
  const accessorBeforeHash = { ...base.beforeSourceHashes };
  Object.defineProperty(accessorBeforeHash, SOURCE_FILES[0], { get: () => "a".repeat(64) });
  const invalidBefore = [
    missingBeforeHash,
    accessorBeforeHash,
    { ...base.beforeSourceHashes, extra: "a".repeat(64) },
    { ...base.beforeSourceHashes, [SOURCE_FILES[0]]: "A".repeat(64) },
    Object.setPrototypeOf({ ...base.beforeSourceHashes }, { inherited: "a".repeat(64) }),
    Object.assign(Object.create(null), base.beforeSourceHashes, { [Symbol("extra")]: "a".repeat(64) }),
  ];
  for (const beforeSourceHashes of invalidBefore) {
    assert.throws(() => verifyProductionSourceOrigins({ evidence: base.evidence, beforeSourceHashes }), TypeError);
  }

  const malformedSourceMaps = [
    [],
    new Date(),
    Object.setPrototypeOf({}, { inherited: "a".repeat(64) }),
    Object.defineProperty({}, SOURCE_FILES[0], { get: () => "a".repeat(64) }),
    Object.assign(Object.create(null), { [Symbol("extra")]: "a".repeat(64) }),
  ];
  for (const sourceHashes of malformedSourceMaps) {
    const fixture = makeSourceOriginsFixture();
    const candidate = fixture.evidence.candidateSet.data.candidates[0];
    fixture.evidence.captures[candidate.id].capture.sourceHashes = sourceHashes;
    assert.throws(() => verifyProductionSourceOrigins(fixture), TypeError);
  }

  for (const malformedCapture of [null, [], new Date()]) {
    const fixture = makeSourceOriginsFixture();
    const candidate = fixture.evidence.candidateSet.data.candidates[0];
    fixture.evidence.captures[candidate.id].capture = malformedCapture;
    assert.throws(() => verifyProductionSourceOrigins(fixture), TypeError);
  }

  const malformedUnknown = makeSourceOriginsFixture();
  malformedUnknown.evidence.captures["unknown-candidate"] = { relativePath: "captures/unknown-candidate" };
  assert.throws(() => verifyProductionSourceOrigins(malformedUnknown), TypeError);

  const invalidSet = makeSourceOriginsFixture();
  invalidSet.evidence.candidateSet.data.candidates[0].candidateHash = "f".repeat(64);
  assert.throws(() => verifyProductionSourceOrigins(invalidSet), TypeError);
});

test("reads every registered current source and hashes the exact returned bytes from the default repository root", async () => {
  assert.equal(SOURCE_FILES.length, 31);
  const result = await readProductionCurrentSources();
  assert.deepEqual(Object.keys(result).sort(), ["rootDir", "sourceBytes", "sourceHashes"]);
  assert.equal(result.rootDir, await fs.promises.realpath(REPO_ROOT));
  assert.deepEqual(Object.keys(result.sourceBytes), SOURCE_FILES);
  assert.deepEqual(Object.keys(result.sourceHashes), SOURCE_FILES);

  for (const file of SOURCE_FILES) {
    const diskBytes = await fs.promises.readFile(path.join(REPO_ROOT, ...file.split("/")));
    assert.ok(Buffer.isBuffer(result.sourceBytes[file]), `${file} returns a Buffer`);
    assert.deepEqual(result.sourceBytes[file], diskBytes, `${file} matches an ordinary filesystem read`);
    assert.equal(result.sourceHashes[file], hashBytes(result.sourceBytes[file]), `${file} hashes its returned bytes`);
  }

  const firstFile = SOURCE_FILES[0];
  const diskBefore = await fs.promises.readFile(path.join(REPO_ROOT, ...firstFile.split("/")));
  result.sourceBytes[firstFile].fill(0);
  result.sourceHashes[firstFile] = "0".repeat(64);
  assert.deepEqual(
    await fs.promises.readFile(path.join(REPO_ROOT, ...firstFile.split("/"))),
    diskBefore,
    "mutating returned bytes does not change the source file",
  );
});

test("reads a temporary source root and rejects roots or entries outside the fixed source contract", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "source-root");
    const expectedBytes = await writeCurrentSourceFixture(sourceRoot);
    const result = await readProductionCurrentSources({ rootDir: sourceRoot });
    assert.equal(result.rootDir, await fs.promises.realpath(sourceRoot));
    assert.deepEqual(Object.keys(result.sourceBytes), SOURCE_FILES);
    assert.deepEqual(Object.keys(result.sourceHashes), SOURCE_FILES);
    for (const file of SOURCE_FILES) {
      assert.deepEqual(result.sourceBytes[file], expectedBytes[file]);
      assert.equal(result.sourceHashes[file], hashBytes(result.sourceBytes[file]));
    }
    for (const file of [
      "scripts/skin-palette/focus-outline-pixels.mjs",
      "scripts/skin-palette/focus-outline-browser.mjs",
    ]) {
      const missingFocusFile = path.join(sourceRoot, ...file.split("/"));
      await fs.promises.rm(missingFocusFile);
      await assert.rejects(readProductionCurrentSources({ rootDir: sourceRoot }), { code: "ENOENT" });
      await fs.promises.writeFile(missingFocusFile, expectedBytes[file]);
    }

    for (const invalidOptions of [
      { rootDir: null },
      { rootDir: "" },
      { rootDir: "file:///outside" },
      { rootDir: "https://example.invalid/source" },
      { rootDir: validationRoot },
      { rootDir: path.join(REPO_ROOT, "outside-validation-root") },
      { rootDir: sourceRoot, reader: () => Buffer.from("untrusted") },
      { rootDir: sourceRoot, sourceFiles: ["public/index.html"] },
    ]) {
      await assert.rejects(readProductionCurrentSources(invalidOptions), TypeError, JSON.stringify(invalidOptions));
    }
    await assert.rejects(readProductionCurrentSources({ rootDir: path.join(testRoot, "missing-root") }), {
      code: "ENOENT",
    });

    const missingFile = path.join(sourceRoot, ...SOURCE_FILES[0].split("/"));
    await fs.promises.rm(missingFile);
    await assert.rejects(readProductionCurrentSources({ rootDir: sourceRoot }), { code: "ENOENT" });
    await fs.promises.mkdir(missingFile);
    await assert.rejects(
      readProductionCurrentSources({ rootDir: sourceRoot }),
      /public\/index.html must be a regular file/,
    );
  });
});

test("rejects current source-file symlinks when Windows permits creating them", async (t) => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "source-root");
    const expectedBytes = await writeCurrentSourceFixture(sourceRoot);
    const sourceFile = path.join(sourceRoot, ...SOURCE_FILES[0].split("/"));
    const targetFile = path.join(testRoot, "outside-current-source.bin");
    await fs.promises.writeFile(targetFile, expectedBytes[SOURCE_FILES[0]]);
    await fs.promises.rm(sourceFile);
    try {
      await fs.promises.symlink(targetFile, sourceFile, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      readProductionCurrentSources({ rootDir: sourceRoot }),
      /public\/index.html must not be a symlink or junction/,
    );
  });
});

test("rejects public and scripts directory junctions escaping the temporary source root", async (t) => {
  await withProductionRun(async ({ testRoot }) => {
    for (const parent of ["public", "scripts"]) {
      await t.test(`${parent} junction`, async (subtest) => {
        const sourceRoot = path.join(testRoot, `source-root-${parent}`);
        const siblingRoot = path.join(testRoot, `sibling-root-${parent}`);
        await writeCurrentSourceFixture(sourceRoot, "inside source root");
        await writeCurrentSourceFixture(siblingRoot, "outside source root substitute");

        const sourceParent = path.join(sourceRoot, parent);
        const siblingParent = path.join(siblingRoot, parent);
        const savedParent = path.join(testRoot, `saved-${parent}`);
        await fs.promises.rename(sourceParent, savedParent);
        try {
          await fs.promises.symlink(siblingParent, sourceParent, "junction");
        } catch (error) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
            subtest.skip(`directory junctions unavailable: ${error.code}`);
            return;
          }
          throw error;
        }

        await assert.rejects(
          readProductionCurrentSources({ rootDir: sourceRoot }),
          new RegExp(`${parent}.*realpath escapes its verified directory`),
          "the sibling fixture's replacement bytes are rejected before being returned",
        );
      });
    }
  });
});

test("reads the fixed generated asset, tool, and raw manifest bytes from a validation root", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "generated-assets-root");
    const manifestBytes = Buffer.from("../../manifest-path-must-not-be-read.bin\n", "utf8");
    const fixture = await writeGeneratedAssetFixture(sourceRoot, manifestBytes);
    assert.equal(fixture.assets.length, 40);

    const first = await readProductionGeneratedAssets({ rootDir: sourceRoot });
    assert.deepEqual(Object.keys(first).sort(), [
      "assetManifestBytes",
      "assetManifestSha256",
      "publicAssetHashes",
      "rootDir",
      "sourceAssetHashes",
      "toolHashes",
    ]);
    assert.equal(first.rootDir, await fs.promises.realpath(sourceRoot));
    assert.deepEqual(
      Object.keys(first.sourceAssetHashes),
      fixture.assets.map((asset) => asset.sourcePath),
    );
    assert.deepEqual(
      Object.keys(first.publicAssetHashes),
      fixture.assets.map((asset) => asset.publicPath),
    );
    assert.deepEqual(Object.keys(first.toolHashes), GENERATED_ASSET_TOOL_FILES);
    assert.deepEqual(
      first.sourceAssetHashes,
      Object.fromEntries(Object.entries(fixture.sourceBytes).map(([file, bytes]) => [file, hashBytes(bytes)])),
    );
    assert.deepEqual(
      first.publicAssetHashes,
      Object.fromEntries(Object.entries(fixture.publicBytes).map(([file, bytes]) => [file, hashBytes(bytes)])),
    );
    assert.deepEqual(
      first.toolHashes,
      Object.fromEntries(Object.entries(fixture.toolBytes).map(([file, bytes]) => [file, hashBytes(bytes)])),
    );
    assert.ok(Buffer.isBuffer(first.assetManifestBytes));
    assert.notStrictEqual(first.assetManifestBytes, fixture.manifestBytes);
    assert.deepEqual(first.assetManifestBytes, manifestBytes);
    assert.equal(first.assetManifestSha256, hashBytes(first.assetManifestBytes));

    const changedFile = fixture.assets[0].sourcePath;
    const changedBytes = Buffer.from("one source image changed\n", "utf8");
    await fs.promises.writeFile(path.join(sourceRoot, ...changedFile.split("/")), changedBytes);
    const second = await readProductionGeneratedAssets({ rootDir: sourceRoot });
    const expectedSourceHashes = { ...first.sourceAssetHashes, [changedFile]: hashBytes(changedBytes) };
    assert.deepEqual(second.sourceAssetHashes, expectedSourceHashes);
    assert.deepEqual(second.publicAssetHashes, first.publicAssetHashes);
    assert.deepEqual(second.toolHashes, first.toolHashes);
    assert.deepEqual(second.assetManifestBytes, first.assetManifestBytes);
    assert.equal(second.assetManifestSha256, first.assetManifestSha256);
  });
});

test("reads all registered generated assets and fixed tool hashes from the default repository root", async () => {
  const assets = enumerateSourceAssets();
  const result = await readProductionGeneratedAssets();
  assert.deepEqual(verifyProductionGeneratedAssets({ snapshot: result }), { status: "pass", errors: [], gaps: [] });
  assert.equal(assets.length, 40);
  assert.equal(result.rootDir, await fs.promises.realpath(REPO_ROOT));
  assert.deepEqual(
    Object.keys(result.sourceAssetHashes),
    assets.map((asset) => asset.sourcePath),
  );
  assert.deepEqual(
    Object.keys(result.publicAssetHashes),
    assets.map((asset) => asset.publicPath),
  );
  assert.deepEqual(Object.keys(result.toolHashes), GENERATED_ASSET_TOOL_FILES);

  for (const asset of assets) {
    const sourceBytes = await fs.promises.readFile(path.join(REPO_ROOT, ...asset.sourcePath.split("/")));
    const publicBytes = await fs.promises.readFile(path.join(REPO_ROOT, ...asset.publicPath.split("/")));
    assert.equal(result.sourceAssetHashes[asset.sourcePath], hashBytes(sourceBytes), asset.sourcePath);
    assert.equal(result.publicAssetHashes[asset.publicPath], hashBytes(publicBytes), asset.publicPath);
  }
  for (const file of GENERATED_ASSET_TOOL_FILES) {
    const bytes = await fs.promises.readFile(path.join(REPO_ROOT, ...file.split("/")));
    assert.equal(result.toolHashes[file], hashBytes(bytes), file);
  }
  const manifestBytes = await fs.promises.readFile(path.join(REPO_ROOT, "public", "skin-assets.json"));
  assert.ok(Buffer.isBuffer(result.assetManifestBytes));
  assert.deepEqual(result.assetManifestBytes, manifestBytes);
  assert.equal(result.assetManifestSha256, hashBytes(result.assetManifestBytes));
});

test("rejects invalid generated-asset roots, missing files, and directories in place of files", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "generated-assets-root");
    const fixture = await writeGeneratedAssetFixture(sourceRoot);
    for (const invalidOptions of [
      null,
      { rootDir: null },
      { rootDir: "" },
      { rootDir: "file:///outside" },
      { rootDir: "https://example.invalid/source" },
      { rootDir: validationRoot },
      { rootDir: sourceRoot, reader: () => Buffer.from("untrusted") },
    ]) {
      await assert.rejects(readProductionGeneratedAssets(invalidOptions), TypeError);
    }
    const symbolOptions = { rootDir: sourceRoot, [Symbol("extra")]: true };
    await assert.rejects(readProductionGeneratedAssets(symbolOptions), TypeError);
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "rootDir", {
      get() {
        throw new Error("rootDir accessor must not run");
      },
    });
    await assert.rejects(readProductionGeneratedAssets(accessorOptions), TypeError);
    await assert.rejects(readProductionGeneratedAssets({ rootDir: path.join(testRoot, "missing-root") }), {
      code: "ENOENT",
    });

    const missingFile = path.join(sourceRoot, ...fixture.assets[0].sourcePath.split("/"));
    await fs.promises.rm(missingFile);
    await assert.rejects(readProductionGeneratedAssets({ rootDir: sourceRoot }), { code: "ENOENT" });
    await fs.promises.mkdir(missingFile);
    await assert.rejects(readProductionGeneratedAssets({ rootDir: sourceRoot }), /must be a regular file/);
  });
});

test("rejects source, public, and tool directory junctions escaping the generated-asset root", async (t) => {
  await withProductionRun(async ({ testRoot }) => {
    for (const parent of ["lineart assets", "public", "scripts"]) {
      await t.test(`${parent} junction`, async (subtest) => {
        const sourceRoot = path.join(testRoot, `generated-root-${parent.replaceAll(" ", "-")}`);
        const siblingRoot = path.join(testRoot, `generated-sibling-${parent.replaceAll(" ", "-")}`);
        await writeGeneratedAssetFixture(sourceRoot);
        await writeGeneratedAssetFixture(siblingRoot);
        const sourceParent = path.join(sourceRoot, parent);
        const siblingParent = path.join(siblingRoot, parent);
        const savedParent = path.join(testRoot, `saved-generated-${parent.replaceAll(" ", "-")}`);
        await fs.promises.rename(sourceParent, savedParent);
        try {
          await fs.promises.symlink(siblingParent, sourceParent, "junction");
        } catch (error) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
            subtest.skip(`directory junctions unavailable: ${error.code}`);
            return;
          }
          throw error;
        }
        await assert.rejects(
          readProductionGeneratedAssets({ rootDir: sourceRoot }),
          /realpath escapes its verified directory/,
          "a sibling root cannot supply assets or tools",
        );
      });
    }
  });
});

test("rejects tool and manifest file symlinks when Windows permits creating them", async (t) => {
  await withProductionRun(async ({ testRoot }) => {
    for (const [label, relativePath] of [
      ["tool", "package.json"],
      ["manifest", "public/skin-assets.json"],
    ]) {
      await t.test(`${label} symlink`, async (subtest) => {
        const sourceRoot = path.join(testRoot, `generated-symlink-${label}`);
        await writeGeneratedAssetFixture(sourceRoot);
        const filePath = path.join(sourceRoot, ...relativePath.split("/"));
        const targetPath = path.join(testRoot, `outside-generated-${label}.bin`);
        await fs.promises.writeFile(targetPath, "outside bytes must not be read\n");
        await fs.promises.rm(filePath);
        try {
          await fs.promises.symlink(targetPath, filePath, "file");
        } catch (error) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
            subtest.skip(`file symlinks unavailable: ${error.code}`);
            return;
          }
          throw error;
        }
        await assert.rejects(
          readProductionGeneratedAssets({ rootDir: sourceRoot }),
          /must not be a symlink or junction/,
        );
      });
    }
  });
});

test("D6b: validates 40 registered records and lossless declarations without mutating the snapshot", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "generated-verify-root");
    await writeGeneratedAssetFixture(sourceRoot);
    const rawSnapshot = await readProductionGeneratedAssets({ rootDir: sourceRoot });
    const manifest = makeGeneratedAssetManifest(rawSnapshot);
    const snapshot = snapshotWithGeneratedManifest(rawSnapshot, manifest);
    snapshot.rootDir = "opaque root value; verifier must not resolve it";
    snapshot.toolHashes[GENERATED_ASSET_TOOL_FILES[0]] = "f".repeat(64);
    const before = copyGeneratedAssetSnapshot(snapshot);

    const result = verifyProductionGeneratedAssets({ snapshot });
    assert.deepEqual(result, { status: "pass", errors: [], gaps: [] });
    assert.deepEqual(Object.keys(result), ["status", "errors", "gaps"]);
    assert.deepEqual(snapshot, before);

    const nullPrototypeSnapshot = Object.assign(Object.create(null), snapshot);
    for (const field of ["sourceAssetHashes", "publicAssetHashes", "toolHashes"]) {
      nullPrototypeSnapshot[field] = Object.assign(Object.create(null), snapshot[field]);
    }
    assert.deepEqual(verifyProductionGeneratedAssets({ snapshot: nullPrototypeSnapshot }), result);

    const missingManifest = makeGeneratedAssetManifest(rawSnapshot);
    const missingUrl = enumerateSourceAssets()[17].publicUrl;
    delete missingManifest.assets[missingUrl];
    const missingResult = verifyProductionGeneratedAssets({
      snapshot: snapshotWithGeneratedManifest(rawSnapshot, missingManifest),
    });
    assert.equal(missingResult.status, "incomplete");
    assert.deepEqual(missingResult.errors, []);
    assert.deepEqual(missingResult.gaps, [
      {
        code: "asset-record-missing",
        path: missingUrl,
        detail: "skin-assets.json has no record for this registered publicUrl",
      },
    ]);

    const invalidDeclarations = makeGeneratedAssetManifest(rawSnapshot);
    const declarationCases = [
      ["alphaMaxDelta", undefined],
      ["alphaMaxDelta", null],
      ["rgbMaxDeltaVisible", "0"],
      ["rgbMaxDeltaVisible", 0.01],
    ];
    for (const [index, [field, value]] of declarationCases.entries()) {
      const record = invalidDeclarations.assets[enumerateSourceAssets()[index].publicUrl];
      if (value === undefined) delete record[field];
      else record[field] = value;
    }
    const declarationResult = verifyProductionGeneratedAssets({
      snapshot: snapshotWithGeneratedManifest(rawSnapshot, invalidDeclarations),
    });
    assert.equal(declarationResult.status, "rejected");
    assert.deepEqual(
      declarationResult.errors.map(({ code, path }) => [code, path]),
      declarationCases.map((_, index) => [
        "asset-lossless-declaration-invalid",
        enumerateSourceAssets()[index].publicUrl,
      ]),
    );
  });
});

test("D6b: rejects malformed snapshot shapes, accessors, symbols, and digests with TypeError", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "generated-shape-root");
    await writeGeneratedAssetFixture(sourceRoot);
    const rawSnapshot = await readProductionGeneratedAssets({ rootDir: sourceRoot });
    const snapshot = snapshotWithGeneratedManifest(rawSnapshot, makeGeneratedAssetManifest(rawSnapshot));
    const first = enumerateSourceAssets()[0];
    const invalidSnapshots = [
      ["extra field", (value) => (value.unexpected = true)],
      ["empty root", (value) => (value.rootDir = "   ")],
      ["non-Buffer manifest", (value) => (value.assetManifestBytes = new Uint8Array(value.assetManifestBytes))],
      ["invalid manifest digest", (value) => (value.assetManifestSha256 = "A".repeat(64))],
      ["missing source path", (value) => delete value.sourceAssetHashes[first.sourcePath]],
      ["extra source path", (value) => (value.sourceAssetHashes["public/unregistered.bin"] = "a".repeat(64))],
      ["invalid source digest", (value) => (value.sourceAssetHashes[first.sourcePath] = "A".repeat(64))],
      ["missing public path", (value) => delete value.publicAssetHashes[first.publicPath]],
      ["invalid tool digest", (value) => (value.toolHashes[GENERATED_ASSET_TOOL_FILES[0]] = "bad")],
      ["extra tool path", (value) => (value.toolHashes["scripts/unregistered.mjs"] = "a".repeat(64))],
    ];
    for (const [label, mutate] of invalidSnapshots) {
      const invalid = copyGeneratedAssetSnapshot(snapshot);
      mutate(invalid);
      assert.throws(() => verifyProductionGeneratedAssets({ snapshot: invalid }), TypeError, label);
    }

    const snapshotAccessor = copyGeneratedAssetSnapshot(snapshot);
    delete snapshotAccessor.rootDir;
    Object.defineProperty(snapshotAccessor, "rootDir", {
      get() {
        throw new Error("snapshot accessor must not run");
      },
    });
    assert.throws(() => verifyProductionGeneratedAssets({ snapshot: snapshotAccessor }), TypeError);
    const snapshotSymbol = copyGeneratedAssetSnapshot(snapshot);
    snapshotSymbol[Symbol("extra")] = true;
    assert.throws(() => verifyProductionGeneratedAssets({ snapshot: snapshotSymbol }), TypeError);
    const hashAccessor = copyGeneratedAssetSnapshot(snapshot);
    Object.defineProperty(hashAccessor.sourceAssetHashes, first.sourcePath, {
      enumerable: true,
      get() {
        throw new Error("hash accessor must not run");
      },
    });
    assert.throws(() => verifyProductionGeneratedAssets({ snapshot: hashAccessor }), TypeError);
    const hashSymbol = copyGeneratedAssetSnapshot(snapshot);
    hashSymbol.toolHashes[Symbol("extra")] = "a".repeat(64);
    assert.throws(() => verifyProductionGeneratedAssets({ snapshot: hashSymbol }), TypeError);

    assert.throws(() => verifyProductionGeneratedAssets(), TypeError);
    assert.throws(() => verifyProductionGeneratedAssets({ snapshot, extra: true }), TypeError);
    const optionsAccessor = {};
    Object.defineProperty(optionsAccessor, "snapshot", {
      get() {
        throw new Error("options accessor must not run");
      },
    });
    assert.throws(() => verifyProductionGeneratedAssets(optionsAccessor), TypeError);
  });
});

test("D6b: rejects malformed UTF-8, JSON, manifest objects, and asset record shapes", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "generated-json-root");
    await writeGeneratedAssetFixture(sourceRoot);
    const rawSnapshot = await readProductionGeneratedAssets({ rootDir: sourceRoot });
    const registered = enumerateSourceAssets()[0];
    const malformedManifests = [
      ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
      ["invalid JSON", Buffer.from("{", "utf8")],
      ["non-object top level", Buffer.from("[]", "utf8")],
      ["missing assets", Buffer.from("{}", "utf8")],
      ["non-object assets", Buffer.from('{"assets":[]}', "utf8")],
      ["non-object asset record", Buffer.from(JSON.stringify({ assets: { [registered.publicUrl]: null } }), "utf8")],
    ];
    for (const [label, bytes] of malformedManifests) {
      const snapshot = copyGeneratedAssetSnapshot(rawSnapshot);
      snapshot.assetManifestBytes = bytes;
      snapshot.assetManifestSha256 = hashBytes(bytes);
      assert.throws(() => verifyProductionGeneratedAssets({ snapshot }), TypeError, label);
    }
  });
});

test("D6b: keeps all diagnostics in stable order and distinguishes missing records from errors", async () => {
  await withProductionRun(async ({ testRoot }) => {
    const sourceRoot = path.join(testRoot, "generated-diagnostic-root");
    await writeGeneratedAssetFixture(sourceRoot);
    const rawSnapshot = await readProductionGeneratedAssets({ rootDir: sourceRoot });
    const registered = enumerateSourceAssets();
    const manifest = makeGeneratedAssetManifest(rawSnapshot);
    manifest.generatedBy = "wrong-generator";
    delete manifest.encodingGeneratedBy;
    const firstAsset = registered[0];
    const missingAsset = registered[1];
    const firstRecord = manifest.assets[firstAsset.publicUrl];
    for (const field of ["skinId", "mode", "view", "sourcePath", "publicPath", "expectedName"]) {
      firstRecord[field] = `wrong-${field}`;
    }
    firstRecord.sourceSha256 = "not-a-digest";
    firstRecord.publicSha256 = "f".repeat(64);
    firstRecord.alphaMaxDelta = null;
    firstRecord.rgbMaxDeltaVisible = "0";
    delete manifest.assets[missingAsset.publicUrl];
    manifest.assets["/unknown/z.webp"] = {};
    manifest.assets["/unknown/a.webp"] = {};
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const correctHash = hashBytes(bytes);
    const wrongHash = `${correctHash[0] === "0" ? "1" : "0"}${correctHash.slice(1)}`;
    const snapshot = { ...rawSnapshot, assetManifestBytes: bytes, assetManifestSha256: wrongHash };

    const result = verifyProductionGeneratedAssets({ snapshot });
    assert.equal(result.status, "rejected");
    assert.deepEqual(
      result.errors.map(({ code, path }) => [code, path]),
      [
        ["asset-manifest-hash-mismatch", "public/skin-assets.json"],
        ["asset-generator-reference-mismatch", "public/skin-assets.json"],
        ["asset-generator-reference-mismatch", "public/skin-assets.json"],
        ...Array(6).fill(["asset-record-field-mismatch", firstAsset.publicUrl]),
        ["asset-record-hash-mismatch", firstAsset.publicUrl],
        ["asset-record-hash-mismatch", firstAsset.publicUrl],
        ["asset-lossless-declaration-invalid", firstAsset.publicUrl],
        ["asset-lossless-declaration-invalid", firstAsset.publicUrl],
        ["unknown-asset-record", "/unknown/a.webp"],
        ["unknown-asset-record", "/unknown/z.webp"],
      ],
    );
    assert.deepEqual(
      result.errors.slice(0, 13).map((entry) => entry.detail.split(" ")[0]),
      [
        "assetManifestSha256",
        "generatedBy",
        "encodingGeneratedBy",
        "skinId",
        "mode",
        "view",
        "sourcePath",
        "publicPath",
        "expectedName",
        "sourceSha256",
        "publicSha256",
        "alphaMaxDelta",
        "rgbMaxDeltaVisible",
      ],
    );
    assert.deepEqual(result.gaps, [
      {
        code: "asset-record-missing",
        path: missingAsset.publicUrl,
        detail: "skin-assets.json has no record for this registered publicUrl",
      },
    ]);
  });
});

test("reads the raw-hash-bound integration precheck and three fixed source preimages without mutation", async () => {
  await withProductionRun(async ({ runDir }) => {
    const { precheck, sourceSnapshot } = makeIntegrationPrecheck();
    const before = JSON.stringify(precheck);
    const written = await writeIntegrationPrecheck(runDir, precheck);
    await writeSourcePreimages(runDir, sourceSnapshot);

    const result = await readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 });
    assert.deepEqual(Object.keys(result).sort(), [
      "precheckFileSha256",
      "precheckPath",
      "sourceHashes",
      "sourceSnapshot",
    ]);
    assert.equal(result.precheckPath, path.relative(REPO_ROOT, written.filePath).split(path.sep).join("/"));
    assert.equal(result.precheckFileSha256, written.sha256);
    assert.deepEqual(result.sourceHashes, precheck.sourceHashes);
    assert.notEqual(result.sourceHashes, precheck.sourceHashes, "sourceHashes is an independent output copy");
    assert.deepEqual(Object.keys(result.sourceSnapshot), SOURCE_PREIMAGE_FILES);
    for (const file of SOURCE_PREIMAGE_FILES) {
      assert.ok(Buffer.isBuffer(result.sourceSnapshot[file]));
      assert.deepEqual(result.sourceSnapshot[file], sourceSnapshot[file]);
      assert.equal(hashBytes(result.sourceSnapshot[file]), result.sourceHashes[file]);
    }

    const originalPrecheckBytes = await fs.promises.readFile(written.filePath);
    result.sourceHashes[SOURCE_PREIMAGE_FILES[0]] = "0".repeat(64);
    result.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]].fill(0);
    assert.deepEqual(await fs.promises.readFile(written.filePath), originalPrecheckBytes);
    assert.deepEqual(
      await fs.promises.readFile(path.join(runDir, "source-before", ...SOURCE_PREIMAGE_FILES[0].split("/"))),
      sourceSnapshot[SOURCE_PREIMAGE_FILES[0]],
    );
    assert.equal(JSON.stringify(precheck), before, "reader does not mutate the parsed precheck input");

    const wrongHash = `${written.sha256[0] === "0" ? "1" : "0"}${written.sha256.slice(1)}`;
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: wrongHash }),
      /raw byte SHA-256 does not match/,
    );
  });
});

test("requires an explicit raw precheck hash and rejects malformed fixed source maps", async () => {
  await withProductionRun(async ({ runDir }) => {
    const { precheck, sourceSnapshot } = makeIntegrationPrecheck();
    await writeSourcePreimages(runDir, sourceSnapshot);
    const validFile = await writeIntegrationPrecheck(runDir, precheck);

    for (const invalid of [undefined, null, "a".repeat(63), "A".repeat(64), 42, () => "a".repeat(64)]) {
      const options = { runDir };
      if (invalid !== undefined) options.precheckFileSha256 = invalid;
      await assert.rejects(readProductionSourceSnapshot(options), /explicit 64-character lowercase SHA-256/);
    }

    const wrongDigest = hashBytes(Buffer.from("not the source preimage"));
    assert.notEqual(wrongDigest, precheck.sourceHashes[SOURCE_PREIMAGE_FILES[0]]);
    const cases = [
      ["missing source hash", (value) => delete value.sourceHashes[SOURCE_FILES[0]]],
      ["extra source hash", (value) => (value.sourceHashes["public/unregistered.js"] = "a".repeat(64))],
      ["invalid source hash", (value) => (value.sourceHashes[SOURCE_FILES[0]] = "A".repeat(64))],
      ["missing source preimage", (value) => delete value.sourcePreimages[SOURCE_PREIMAGE_FILES[0]]],
      [
        "extra source preimage",
        (value) => (value.sourcePreimages["public/other.js"] = { path: "x", sha256: "a".repeat(64) }),
      ],
      ["missing preimage field", (value) => delete value.sourcePreimages[SOURCE_PREIMAGE_FILES[0]].sha256],
      ["extra preimage field", (value) => (value.sourcePreimages[SOURCE_PREIMAGE_FILES[0]].extra = true)],
      [
        "preimage hash differs from sourceHashes",
        (value) => (value.sourcePreimages[SOURCE_PREIMAGE_FILES[0]].sha256 = wrongDigest),
      ],
      ...[
        "file:///source-before/public/skin-palettes.js",
        "../source-before/public/skin-palettes.js",
        "source-before/../source-before/public/skin-palettes.js",
        "C:/outside/skin-palettes.js",
      ].map((sourcePath) => [
        sourcePath,
        (value) => (value.sourcePreimages[SOURCE_PREIMAGE_FILES[0]].path = sourcePath),
      ]),
      [
        "matching declared hash with wrong bytes",
        (value) => {
          value.sourceHashes[SOURCE_PREIMAGE_FILES[0]] = wrongDigest;
          value.sourcePreimages[SOURCE_PREIMAGE_FILES[0]].sha256 = wrongDigest;
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const malformed = structuredClone(precheck);
      mutate(malformed);
      const file = await writeIntegrationPrecheck(runDir, malformed);
      await assert.rejects(readProductionSourceSnapshot({ runDir, precheckFileSha256: file.sha256 }), TypeError, label);
    }

    assert.ok(validFile.sha256, "synthetic precheck was bound by its raw bytes");
  });
});

test("rejects malformed, missing, and directory-valued precheck or source files and out-of-root runs", async () => {
  await withProductionRun(async ({ runDir, testRoot }) => {
    const { precheck, sourceSnapshot } = makeIntegrationPrecheck();
    await writeSourcePreimages(runDir, sourceSnapshot);
    const written = await writeIntegrationPrecheck(runDir, precheck);
    const sourceFile = path.join(runDir, "source-before", ...SOURCE_PREIMAGE_FILES[0].split("/"));

    const reformattedBytes = Buffer.concat([written.bytes, Buffer.from(" ")]);
    assert.deepEqual(
      JSON.parse(reformattedBytes.toString("utf8")),
      precheck,
      "format-only changes preserve JSON content",
    );
    await fs.promises.writeFile(written.filePath, reformattedBytes);
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }),
      /raw byte SHA-256 does not match/,
      "the binding hashes raw bytes rather than canonical JSON",
    );

    await fs.promises.writeFile(written.filePath, "{ broken json\n", "utf8");
    const brokenBytes = await fs.promises.readFile(written.filePath);
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }),
      /raw byte SHA-256 does not match/,
      "reject a changed raw hash before parsing malformed content",
    );
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: hashBytes(brokenBytes) }),
      /integration-precheck.json contains invalid JSON/,
    );

    await fs.promises.writeFile(written.filePath, written.bytes);
    await fs.promises.rm(written.filePath);
    await assert.rejects(readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }), {
      code: "ENOENT",
    });
    await fs.promises.mkdir(written.filePath);
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }),
      /integration-precheck.json must be a regular file/,
    );

    await fs.promises.rm(written.filePath, { recursive: true });
    await fs.promises.writeFile(written.filePath, written.bytes);
    await fs.promises.rm(sourceFile);
    await assert.rejects(readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }), {
      code: "ENOENT",
    });
    await fs.promises.mkdir(sourceFile);
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }),
      /source-before\/public\/skin-palettes.js must be a regular file/,
    );

    await assert.rejects(
      readProductionSourceSnapshot({ runDir: validationRoot, precheckFileSha256: written.sha256 }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(
      readProductionSourceSnapshot({
        runDir: path.join(REPO_ROOT, "outside-validation-run"),
        precheckFileSha256: written.sha256,
      }),
      /strict child of docs\/validation/,
    );
    await assert.rejects(
      readProductionSourceSnapshot({ runDir: path.join(testRoot, "missing-run"), precheckFileSha256: written.sha256 }),
    );
  });
});

test("rejects source-before file symlinks when Windows permits creating them", async (t) => {
  await withProductionRun(async ({ runDir, testRoot }) => {
    const { precheck, sourceSnapshot } = makeIntegrationPrecheck();
    const written = await writeIntegrationPrecheck(runDir, precheck);
    await writeSourcePreimages(runDir, sourceSnapshot);
    const sourceFile = path.join(runDir, "source-before", ...SOURCE_PREIMAGE_FILES[0].split("/"));
    const targetFile = path.join(testRoot, "source-before-link-target.bin");
    await fs.promises.writeFile(targetFile, sourceSnapshot[SOURCE_PREIMAGE_FILES[0]]);
    await fs.promises.rm(sourceFile);
    try {
      await fs.promises.symlink(targetFile, sourceFile, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }),
      /source-before\/public\/skin-palettes.js must not be a symlink or junction/,
    );
  });
});

test("rejects a source-before parent junction to another run inside the same validation root", async (t) => {
  await withProductionRun(async ({ runDir, testRoot }) => {
    const { precheck, sourceSnapshot } = makeIntegrationPrecheck();
    const written = await writeIntegrationPrecheck(runDir, precheck);
    await writeSourcePreimages(runDir, sourceSnapshot);

    const sourceBefore = path.join(runDir, "source-before");
    const movedSourceBefore = path.join(runDir, "source-before-original");
    const siblingRun = path.join(testRoot, "sibling-run");
    const siblingSourceBefore = path.join(siblingRun, "source-before");
    await fs.promises.rename(sourceBefore, movedSourceBefore);
    await writeSourcePreimages(siblingRun, sourceSnapshot);
    assert.ok(
      !path.isAbsolute(path.relative(validationRoot, siblingRun)) &&
        !path.relative(validationRoot, siblingRun).startsWith(`..${path.sep}`),
      "junction target is a sibling run under the same docs/validation test root",
    );
    try {
      await fs.promises.symlink(siblingSourceBefore, sourceBefore, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      readProductionSourceSnapshot({ runDir, precheckFileSha256: written.sha256 }),
      /source-before\/public\/skin-palettes.js realpath escapes its verified directory/,
    );
  });
});

test("reads bound light state and dark timeline evidence in registry order without mutation", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel, testRoot }) => {
    const capturedUnits = [
      { mode: "light", unitId: "keyboard-focus" },
      { mode: "dark", unitId: "dense-data" },
      { mode: "light", unitId: "timeline-range-warning" },
    ];
    const captureResult = await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits,
    });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const inputsBefore = JSON.stringify({ verifiedModel, selections });
    const filesBefore = await snapshotFixtureTree(testRoot);
    const result = await readProductionStateEvidence(args);
    const bound = await readProductionCaptureBinding(args);
    const checks = await readProductionCaptureChecks({
      skinId: candidate.skinId,
      captureResult: bound.captureResult,
    });

    assert.deepEqual(
      result.entries.map(({ mode, unitId, relativePath }) => [mode, unitId, relativePath]),
      [
        ["light", "keyboard-focus", "light/states/keyboard-focus"],
        ["light", "timeline-range-warning", "light/states/timeline-range-warning"],
        ["dark", "dense-data", "dark/states/dense-data"],
      ],
    );
    assert.deepEqual(result.gaps, checks.gaps);
    assert.equal(result.entries[0].evidence.checks.candidateId, null);
    assert.equal(
      result.entries[0].evidence.evidenceHash,
      captureResult.progress.units["light/keyboard-focus"].evidenceHash,
    );
    assert.equal(
      result.entries[1].evidence.evidenceHash,
      captureResult.progress.units["light/timeline-range-warning"].evidenceHash,
    );
    assert.deepEqual(result.entries[1].evidence.state.trace.fixtureRequirement, {
      name: "timeline-range-warning",
      expectedHash: getTimelineWarningFixtureHash(),
      actualHash: getTimelineWarningFixtureHash(),
      match: true,
    });
    assert.equal(result.entries[2].evidence.evidenceHash, captureResult.progress.units["dark/dense-data"].evidenceHash);
    assert.deepEqual(
      result.entries[2].evidence.state.measurementVariants &&
        Object.keys(result.entries[2].evidence.state.measurementVariants),
      ["model", "cost"],
    );
    assert.equal(JSON.stringify({ verifiedModel, selections }), inputsBefore);
    assert.deepEqual(await snapshotFixtureTree(testRoot), filesBefore);
  });
});

test("rejects missing or changed state attachments against the bound progress evidenceHash", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "missing-state-image",
        mutate: (unitDir) => fs.promises.rm(path.join(unitDir, "state.png")),
      },
      {
        name: "changed-state-image",
        mutate: (unitDir) =>
          fs.promises.writeFile(path.join(unitDir, "state.png"), Buffer.concat([EVIDENCE_PNG, Buffer.from([1])])),
      },
      {
        name: "changed-checks-bytes",
        mutate: (unitDir) => fs.promises.appendFile(path.join(unitDir, "checks.json"), " "),
      },
    ];
    for (const { name, mutate } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-${name}`);
      await createBoundStateCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedUnits: [{ mode: "light", unitId: "keyboard-focus" }],
      });
      await mutate(path.join(caseOutDir, "light", "states", "keyboard-focus"));
      await assert.rejects(
        readProductionStateEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        /证据文件摘要与 progress\.json 不一致/,
        name,
      );
    }
  });
});

test("rejects missing or malformed progress evidenceHash for captured state attachments", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    for (const [name, value] of [
      ["missing", undefined],
      ["invalid", "not-a-sha256"],
    ]) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-hash-${name}`);
      await createBoundStateCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedUnits: [{ mode: "light", unitId: "keyboard-focus" }],
        progressHashOverrides: { "light/keyboard-focus": value },
      });
      await assert.rejects(
        readProductionStateEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        /progress\.json 缺少有效的 evidenceHash/,
        name,
      );
    }
  });
});

test("rejects self-hashed state, geometry, attachment-registration, and timeline inconsistencies", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "wrong-state-identity",
        captured: { mode: "light", unitId: "keyboard-focus" },
        patch: { state: (state) => (state.stateId = "wrong-state") },
        error: /state\.json 的 kind、状态或单元\/模式\/皮肤身份不匹配/,
      },
      {
        name: "wrong-geometry-identity",
        captured: { mode: "light", unitId: "keyboard-focus" },
        patch: { geometry: (geometry) => (geometry.skinId = "wrong-skin") },
        error: /geometry\.json 的身份不匹配/,
      },
      {
        name: "missing-geometry-registration",
        captured: { mode: "light", unitId: "keyboard-focus" },
        patch: { state: (state) => delete state.files.geometry },
        error: /geometry\.json 未登记/,
      },
      {
        name: "broken-timeline-registration",
        captured: { mode: "dark", unitId: "dense-data" },
        patch: {
          state: (state) => (state.measurementVariants.model.checks = "checks.json"),
        },
        error: /按model视图测量证据未登记/,
      },
    ];
    for (const { name, captured, patch, error } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-self-hash-${name}`);
      await createBoundStateCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedUnits: [captured],
        statePatches: { [`${captured.mode}/${captured.unitId}`]: patch },
      });
      await assert.rejects(
        readProductionStateEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        error,
        name,
      );
    }
  });
});

test("requires formal capture and explicit null identity in checks evidence", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel, testRoot }) => {
    const checksOutDir = path.join(path.dirname(outDir), "capture-non-null-checks");
    await createBoundStateCapture({
      candidate,
      outDir: checksOutDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [{ mode: "light", unitId: "keyboard-focus" }],
      statePatches: { "light/keyboard-focus": { checks: (checks) => (checks.candidateId = candidate.id) } },
    });
    await assert.rejects(
      readProductionStateEvidence(
        readBindingArgs({ candidate, outDir: checksOutDir, runDir, selections, verifiedModel }),
      ),
      /checks\.candidateId does not match the candidate/,
    );

    const captureOutDir = path.join(path.dirname(outDir), "capture-candidate-impostor");
    await createBoundStateCapture({
      candidate,
      outDir: captureOutDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [],
    });
    const capturePath = path.join(captureOutDir, "capture.json");
    const metadata = JSON.parse(await fs.promises.readFile(capturePath, "utf8"));
    metadata.candidate = { production: false, skinId: candidate.skinId };
    await writeFixtureJson(capturePath, metadata);
    await assert.rejects(
      readProductionStateEvidence(
        readBindingArgs({ candidate, outDir: captureOutDir, runDir, selections, verifiedModel }),
      ),
      /captureResult\.capture\.candidate must identify production mode/,
    );

    const byteSnapshot = await snapshotFixtureTree(testRoot);
    assert.ok(Object.keys(byteSnapshot).some((file) => file.endsWith("production-selection.json")));
  });
});

test("does not probe bad paths for non-captured units", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [{ mode: "light", unitId: "keyboard-focus" }],
    });
    const nonCapturedPath = path.join(outDir, "light", "states", "autorefresh-on");
    await fs.promises.mkdir(path.dirname(nonCapturedPath), { recursive: true });
    await fs.promises.writeFile(nonCapturedPath, "intentionally not a directory");
    const result = await readProductionStateEvidence(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );
    assert.deepEqual(
      result.entries.map(({ mode, unitId }) => [mode, unitId]),
      [["light", "keyboard-focus"]],
    );
  });
});

test("rejects unit and parent directory junction escapes before reading state evidence", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel, testRoot }) => {
    for (const target of ["unit", "parent"]) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-junction-${target}`);
      await createBoundStateCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedUnits: [{ mode: "light", unitId: "keyboard-focus" }],
      });
      const statesDir = path.join(caseOutDir, "light", "states");
      const linkPath = target === "unit" ? path.join(statesDir, "keyboard-focus") : statesDir;
      const outsidePath = path.join(testRoot, `junction-target-${target}`);
      await fs.promises.rename(linkPath, outsidePath);
      try {
        await fs.promises.symlink(outsidePath, linkPath, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          t.skip(`directory junctions unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      await assert.rejects(
        readProductionStateEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        /realpath escapes capture output/,
        target,
      );
    }
  });
});

test("rejects state-file symlinks when Windows permits creating them", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel, testRoot }) => {
    await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [{ mode: "light", unitId: "keyboard-focus" }],
    });
    const imagePath = path.join(outDir, "light", "states", "keyboard-focus", "state.png");
    await fs.promises.rm(imagePath);
    const targetPath = path.join(testRoot, "symlink-target.png");
    await fs.promises.writeFile(targetPath, EVIDENCE_PNG);
    try {
      await fs.promises.symlink(targetPath, imagePath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionStateEvidence(readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel })),
      /证据目录包含符号链接/,
    );
  });
});

test("reads both bound S0 manifests with measurements and preserves files, inputs, and reader gaps", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel, testRoot }) => {
    const captureResult = await createBoundBaselineCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const inputsBefore = JSON.stringify({ verifiedModel, selections });
    const filesBefore = await snapshotFixtureTree(testRoot);
    const result = await readProductionBaselineEvidence(args);
    const bound = await readProductionCaptureBinding(args);
    const checks = await readProductionCaptureChecks({ skinId: candidate.skinId, captureResult: bound.captureResult });

    assert.deepEqual(
      result.entries.map(({ mode, unitId, relativePath }) => [mode, unitId, relativePath]),
      [
        ["light", "baseline", "light"],
        ["dark", "baseline", "dark"],
      ],
    );
    assert.deepEqual(result.gaps, checks.gaps);
    for (const entry of result.entries) {
      assert.equal(entry.evidence.measureRoles, true);
      assert.equal(entry.evidence.files.length, 7);
      assert.deepEqual(entry.evidence, captureResult.progress.units[`${entry.mode}/baseline`].baselineEvidence);
    }
    assert.equal(JSON.stringify({ verifiedModel, selections }), inputsBefore);
    assert.deepEqual(await snapshotFixtureTree(testRoot), filesBefore);
  });
});

test("does not probe a non-captured S0 mode and keeps the formal checks reader gaps", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const captureResult = await createBoundBaselineCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedModes: ["light"],
    });
    await fs.promises.writeFile(path.join(outDir, "dark"), "not a directory");
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const result = await readProductionBaselineEvidence(args);
    const bound = await readProductionCaptureBinding(args);
    const checks = await readProductionCaptureChecks({ skinId: candidate.skinId, captureResult: bound.captureResult });
    assert.deepEqual(
      result.entries.map(({ mode }) => mode),
      ["light"],
    );
    assert.deepEqual(result.gaps, checks.gaps);
    assert.equal(captureResult.modes.dark.baseline.status, "incomplete");
  });
});

test("rejects missing, malformed, incomplete, and unmeasured S0 manifests", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "missing-manifest",
        baselineEvidencePatches: { light: "missing" },
        error: /progress\.json 缺少有效的固定附件摘要/,
      },
      {
        name: "invalid-manifest-digest",
        baselineEvidencePatches: { light: (manifest) => (manifest.sha256 = "bad") },
        error: /progress\.json 缺少有效的固定附件摘要/,
      },
      {
        name: "self-consistent-incomplete-manifest",
        baselineEvidencePatches: {
          light: (manifest) => {
            manifest.files.pop();
            manifest.sha256 = sha256Canonical(manifest.files);
          },
        },
        error: /固定附件缺失或 SHA-256 已变化/,
      },
      {
        name: "previously-unmeasured-baseline",
        baselineOptions: { light: { measureRoles: false } },
        error: /本次要求测量 S0 角色，但原基准未包含测量附件/,
      },
    ];
    for (const { name, baselineOptions, baselineEvidencePatches, error } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-s0-manifest-${name}`);
      await createBoundBaselineCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedModes: ["light"],
        baselineOptions,
        baselineEvidencePatches,
      });
      await assert.rejects(
        readProductionBaselineEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        error,
        name,
      );
    }
  });
});

test("rejects missing, changed, and size-mismatched captured S0 attachments", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "missing-fixed-image",
        file: "baseline.png",
        mutate: (filePath) => fs.promises.rm(filePath),
      },
      {
        name: "same-size-image-drift",
        file: "first-screen.png",
        mutate: (filePath) => fs.promises.writeFile(filePath, Buffer.alloc(EVIDENCE_PNG.length, 1)),
      },
      {
        name: "changed-json-byte-count",
        file: "layout.json",
        mutate: (filePath) => fs.promises.appendFile(filePath, " "),
      },
    ];
    for (const { name, file, mutate } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-s0-attachment-${name}`);
      await createBoundBaselineCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedModes: ["light"],
      });
      await mutate(path.join(caseOutDir, "light", ...file.split("/")));
      await assert.rejects(
        readProductionBaselineEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        /S0 基准附件证据不完整/,
        name,
      );
    }
  });
});

test("recomputed S0 manifests cannot hide wrong JSON identity or failed consistency results", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "wrong-mode",
        jsonPatches: { "first-screen.json": (value) => ({ ...value, mode: "dark" }) },
        error: /first-screen\.json 的模式或皮肤身份与 S0 不一致/,
      },
      {
        name: "wrong-skin",
        jsonPatches: { "layout.json": (value) => ({ ...value, skinId: "not-selected" }) },
        error: /layout\.json 的模式或皮肤身份与 S0 不一致/,
      },
      {
        name: "first-screen-failed",
        jsonPatches: { "first-screen.json": (value) => ({ ...value, matches: false }) },
        error: /first-screen\.json 未记录成功的一致性判定/,
      },
      {
        name: "color-consistency-failed",
        jsonPatches: { "colors.json": (value) => ({ ...value, firstScreenMatchesRuntime: false }) },
        error: /colors\.json 未记录成功的一致性判定或聚光关闭状态/,
      },
      {
        name: "spotlight-not-off",
        jsonPatches: { "colors.json": (value) => ({ ...value, spotlight: { off: false } }) },
        error: /colors\.json 未记录成功的一致性判定或聚光关闭状态/,
      },
    ];
    for (const { name, jsonPatches, error } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-s0-semantics-${name}`);
      await createBoundBaselineCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedModes: ["light"],
        baselineOptions: { light: { jsonPatches } },
      });
      await assert.rejects(
        readProductionBaselineEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        error,
        name,
      );
    }
  });
});

test("rejects wrong S0 checks identity and missing or duplicate measurement screenshots", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "wrong-null-candidate",
        patch: (checks) => ({ ...checks, candidateId: candidate.id }),
        error: /checks\.json checks\.candidateId does not match the candidate/,
      },
      {
        name: "missing-capture-index",
        patch: (checks) => ({ ...checks, captureIndex: [] }),
        error: /checks\.json 缺少 S0 角色判据或测量截图索引/,
      },
      {
        name: "duplicate-capture-index",
        patch: (checks) => ({ ...checks, captureIndex: [...checks.captureIndex, ...checks.captureIndex] }),
        error: /checks\.json 测量截图索引与 S0 附件集合不一致/,
      },
    ];
    for (const { name, patch, error } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-s0-checks-${name}`);
      await createBoundBaselineCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedModes: ["light"],
        baselineOptions: { light: { jsonPatches: { "checks.json": patch } } },
      });
      await assert.rejects(
        readProductionBaselineEvidence(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        error,
        name,
      );
    }
  });
});

test("rejects S0 mode-directory junction escapes before helper reads and rejects file symlinks", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel, testRoot }) => {
    const junctionOutDir = path.join(path.dirname(outDir), "capture-s0-mode-junction");
    await createBoundBaselineCapture({
      candidate,
      outDir: junctionOutDir,
      runDir,
      selections,
      verifiedModel,
      capturedModes: ["light"],
    });
    const modeDir = path.join(junctionOutDir, "light");
    const outsideMode = path.join(testRoot, "empty-outside-mode");
    await fs.promises.mkdir(outsideMode);
    await fs.promises.rm(modeDir, { recursive: true });
    try {
      await fs.promises.symlink(outsideMode, modeDir, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionBaselineEvidence(
        readBindingArgs({ candidate, outDir: junctionOutDir, runDir, selections, verifiedModel }),
      ),
      /baseline evidence realpath escapes capture output: light/,
    );

    const symlinkOutDir = path.join(path.dirname(outDir), "capture-s0-file-symlink");
    await createBoundBaselineCapture({
      candidate,
      outDir: symlinkOutDir,
      runDir,
      selections,
      verifiedModel,
      capturedModes: ["light"],
    });
    const targetPath = path.join(testRoot, "s0-symlink-target.png");
    const imagePath = path.join(symlinkOutDir, "light", "baseline.png");
    await fs.promises.writeFile(targetPath, EVIDENCE_PNG);
    await fs.promises.rm(imagePath);
    try {
      await fs.promises.symlink(targetPath, imagePath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionBaselineEvidence(
        readBindingArgs({ candidate, outDir: symlinkOutDir, runDir, selections, verifiedModel }),
      ),
      /S0 基准附件证据不完整.*S0 附件不能是符号链接/,
    );
  });
});

test("combines a complete synthetic production capture without mutating its evidence", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter((unit) => unit.kind !== "baseline");
    await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: ["light", "dark"].flatMap((mode) => units.map((unit) => ({ mode, unitId: unit.id }))),
      capturedBaselineModes: ["light", "dark"],
      sourceHashes: currentSourceHashes(),
    });
    const before = await snapshotFixtureTree(testRoot);
    const inputsBefore = JSON.stringify({ verifiedModel, selections });

    const result = await verifyProductionCapture(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );

    assert.deepEqual(result, {
      skinId: candidate.skinId,
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      status: "pass",
      exitCode: 0,
      errors: [],
      gaps: [],
    });
    assert.equal(JSON.stringify({ verifiedModel, selections }), inputsBefore);
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

function makeD5cHistoricalFixture(historicalStatus = "pass") {
  const verifiedModel = makeVerifiedModel();
  verifiedModel.production = false;
  if (historicalStatus === "rejected" || historicalStatus === "incomplete") {
    const unavailable = verifiedModel.candidateSet.candidates.find(
      (candidate) => candidate.skinId === SKIN_IDS[1] && candidate.variant === "b",
    );
    verifiedModel.selectableCandidateIds = verifiedModel.selectableCandidateIds.filter((id) => id !== unavailable.id);
    if (historicalStatus === "rejected") {
      verifiedModel.container.assessments.find((assessment) => assessment.candidateId === unavailable.id).readiness =
        "rejected";
    } else {
      verifiedModel.gaps.push({ code: "synthetic-unselected-gap", candidateId: unavailable.id, blocking: true });
    }
  }

  const container = verifiedModel.container;
  container.assessmentHash = sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
  const record = makeSelections(verifiedModel);
  const candidateSet = structuredClone(verifiedModel.candidateSet);
  const evidence = {
    candidateSet: { data: candidateSet, candidates: structuredClone(candidateSet.candidates) },
    review: { present: true, path: "review.json", container: structuredClone(container), missingCandidateIds: [] },
    selections: { present: true, path: "selections.json", record: structuredClone(record), binding: null },
  };
  const historicalEvidence = {
    originResult: { status: "pass", errors: [], gaps: [] },
    historicalResult: {
      status: historicalStatus,
      errors: [],
      gaps: structuredClone(verifiedModel.gaps),
      verifiedModel,
      sourceContext: "historical",
    },
    assessmentBinding: {
      status: "pass",
      recordedHash: container.assessmentHash,
      reconstructedHash: container.assessmentHash,
    },
  };
  return {
    evidence,
    historicalEvidence,
    candidateId: verifiedModel.candidateSet.candidates.find((candidate) => candidate.skinId === SKIN_IDS[0]).id,
    verifiedModel,
  };
}

function rebindD5cAssessmentHashes(fixture) {
  const container = fixture.verifiedModel.container;
  const assessmentHash = sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
  container.assessmentHash = assessmentHash;
  fixture.evidence.review.container = structuredClone(container);
  fixture.evidence.selections.record.assessmentHash = assessmentHash;
  fixture.historicalEvidence.assessmentBinding.recordedHash = assessmentHash;
  fixture.historicalEvidence.assessmentBinding.reconstructedHash = assessmentHash;
}

test("D5c：纯接头返回 B1 结果副本，不把合成历史模型说成真实 verifier 证据", () => {
  const fixture = makeD5cHistoricalFixture();
  const inputBefore = JSON.stringify({ evidence: fixture.evidence, historicalEvidence: fixture.historicalEvidence });
  const expected = resolveProductionSelection({
    verifiedModel: fixture.verifiedModel,
    selections: fixture.evidence.selections.record,
    candidateId: fixture.candidateId,
  });

  const result = resolveProductionHistoricalSelection({
    evidence: fixture.evidence,
    historicalEvidence: fixture.historicalEvidence,
    candidateId: fixture.candidateId,
  });

  assert.deepEqual(Object.keys(result).sort(), ["candidate", "selectionBinding"]);
  assert.deepEqual(result, expected);
  assert.notStrictEqual(result.candidate, fixture.verifiedModel.candidateSet.candidates[0]);
  assert.equal(
    JSON.stringify({ evidence: fixture.evidence, historicalEvidence: fixture.historicalEvidence }),
    inputBefore,
  );
  result.candidate.style.title = "mutated result copy";
  assert.notEqual(
    fixture.verifiedModel.candidateSet.candidates[0].style.title,
    "mutated result copy",
    "B1 must return an independent candidate copy",
  );

  for (const extra of [
    { selections: fixture.evidence.selections.record },
    { verifiedModel: fixture.verifiedModel },
    { htmlModel: fixture.verifiedModel },
  ]) {
    assert.throws(
      () =>
        resolveProductionHistoricalSelection({
          evidence: fixture.evidence,
          historicalEvidence: fixture.historicalEvidence,
          candidateId: fixture.candidateId,
          ...extra,
        }),
      TypeError,
    );
  }
});

test("D5c：来源、原评审上下文与绑定必须满足 D5b 契约", () => {
  const invalidCases = [
    ["origin rejected", (fixture) => (fixture.historicalEvidence.originResult.status = "rejected")],
    ["origin incomplete", (fixture) => (fixture.historicalEvidence.originResult.status = "incomplete")],
    [
      "origin fake pass with errors",
      (fixture) => fixture.historicalEvidence.originResult.errors.push({ code: "fake" }),
    ],
    ["origin fake pass with gaps", (fixture) => fixture.historicalEvidence.originResult.gaps.push({ code: "fake" })],
    ["assessment binding not pass", (fixture) => (fixture.historicalEvidence.assessmentBinding.status = "incomplete")],
    ["historical marker missing", (fixture) => (fixture.historicalEvidence.historicalResult.sourceContext = "current")],
    ["historical status invalid", (fixture) => (fixture.historicalEvidence.historicalResult.status = "invalid")],
    [
      "historical verifier error",
      (fixture) => fixture.historicalEvidence.historicalResult.errors.push({ code: "invalid" }),
    ],
    ["historical model missing", (fixture) => delete fixture.historicalEvidence.historicalResult.verifiedModel],
    ["production model", (fixture) => (fixture.verifiedModel.production = true)],
    ["actual review missing", (fixture) => (fixture.evidence.review.present = false)],
    ["actual container missing", (fixture) => delete fixture.evidence.review.container],
    ["actual selection missing", (fixture) => (fixture.evidence.selections.present = false)],
    ["actual selection record missing", (fixture) => delete fixture.evidence.selections.record],
  ];

  for (const [label, mutate] of invalidCases) {
    const fixture = makeD5cHistoricalFixture();
    mutate(fixture);
    const before = JSON.stringify({ evidence: fixture.evidence, historicalEvidence: fixture.historicalEvidence });
    assert.throws(
      () =>
        resolveProductionHistoricalSelection({
          evidence: fixture.evidence,
          historicalEvidence: fixture.historicalEvidence,
          candidateId: fixture.candidateId,
        }),
      TypeError,
      label,
    );
    assert.equal(
      JSON.stringify({ evidence: fixture.evidence, historicalEvidence: fixture.historicalEvidence }),
      before,
    );
  }

  for (const field of [
    ["evidence.review.container", (fixture) => (fixture.evidence.review.container.assessmentHash = "c".repeat(64))],
    ["historical model container", (fixture) => (fixture.verifiedModel.container.assessmentHash = "c".repeat(64))],
    ["D5b recorded hash", (fixture) => (fixture.historicalEvidence.assessmentBinding.recordedHash = "c".repeat(64))],
    [
      "D5b reconstructed hash",
      (fixture) => (fixture.historicalEvidence.assessmentBinding.reconstructedHash = "c".repeat(64)),
    ],
  ]) {
    const fixture = makeD5cHistoricalFixture();
    field[1](fixture);
    assert.throws(
      () =>
        resolveProductionHistoricalSelection({
          evidence: fixture.evidence,
          historicalEvidence: fixture.historicalEvidence,
          candidateId: fixture.candidateId,
        }),
      TypeError,
      `${field[0]} drift must be rejected even when D5b said pass`,
    );
  }

  const malformedHash = makeD5cHistoricalFixture();
  malformedHash.historicalEvidence.assessmentBinding.recordedHash = "A".repeat(64);
  assert.throws(
    () =>
      resolveProductionHistoricalSelection({
        evidence: malformedHash.evidence,
        historicalEvidence: malformedHash.historicalEvidence,
        candidateId: malformedHash.candidateId,
      }),
    TypeError,
    "assessment hashes must be lowercase SHA-256, not merely equal strings",
  );
});

test("D5c：完整候选集和实际 selections.record 交由 B1 绑定", () => {
  const changedSet = makeD5cHistoricalFixture();
  changedSet.evidence.candidateSet.data.inputHashes.profiles = "f".repeat(64);
  assert.equal(
    changedSet.evidence.candidateSet.data.candidateSetHash,
    changedSet.verifiedModel.candidateSet.candidateSetHash,
    "fixture deliberately keeps the old total hash while changing set content",
  );
  assert.throws(
    () =>
      resolveProductionHistoricalSelection({
        evidence: changedSet.evidence,
        historicalEvidence: changedSet.historicalEvidence,
        candidateId: changedSet.candidateId,
      }),
    TypeError,
  );

  const driftedSelection = makeD5cHistoricalFixture();
  driftedSelection.evidence.selections.record.choices[SKIN_IDS[0]].candidateHash = "f".repeat(64);
  assert.throws(
    () =>
      resolveProductionHistoricalSelection({
        evidence: driftedSelection.evidence,
        historicalEvidence: driftedSelection.historicalEvidence,
        candidateId: driftedSelection.candidateId,
      }),
    TypeError,
    "B1 rejects the drifted actual loader record",
  );

  const unselectedRequest = makeD5cHistoricalFixture();
  const unselected = unselectedRequest.verifiedModel.candidateSet.candidates.find(
    (candidate) => candidate.skinId === SKIN_IDS[0] && candidate.variant === "b",
  );
  assert.throws(
    () =>
      resolveProductionHistoricalSelection({
        evidence: unselectedRequest.evidence,
        historicalEvidence: unselectedRequest.historicalEvidence,
        candidateId: unselected.id,
      }),
    TypeError,
    "B1 rejects a request for a candidate not selected by the actual record",
  );
});

test("D5c：历史 rejected/incomplete 不抹掉其它 ready 候选的资格，但阻断或未 ready 的选择仍拒绝", () => {
  for (const status of ["rejected", "incomplete"]) {
    const fixture = makeD5cHistoricalFixture(status);
    const result = resolveProductionHistoricalSelection({
      evidence: fixture.evidence,
      historicalEvidence: fixture.historicalEvidence,
      candidateId: fixture.candidateId,
    });
    assert.equal(
      result.candidate.id,
      fixture.candidateId,
      `${status} history keeps the requested ready candidate usable`,
    );
  }

  const blocked = makeD5cHistoricalFixture();
  const blocker = { code: "synthetic-requested-blocker", candidateId: blocked.candidateId, blocking: true };
  blocked.verifiedModel.gaps.push(blocker);
  blocked.verifiedModel.selectableCandidateIds = blocked.verifiedModel.selectableCandidateIds.filter(
    (id) => id !== blocked.candidateId,
  );
  blocked.historicalEvidence.historicalResult.status = "incomplete";
  blocked.historicalEvidence.historicalResult.gaps.push(blocker);
  assert.throws(
    () =>
      resolveProductionHistoricalSelection({
        evidence: blocked.evidence,
        historicalEvidence: blocked.historicalEvidence,
        candidateId: blocked.candidateId,
      }),
    TypeError,
    "B1 must reject the requested candidate when its historical model carries a blocker",
  );

  const notReady = makeD5cHistoricalFixture();
  notReady.verifiedModel.container.assessments.find(
    (assessment) => assessment.candidateId === notReady.candidateId,
  ).readiness = "rejected";
  notReady.historicalEvidence.historicalResult.status = "rejected";
  rebindD5cAssessmentHashes(notReady);
  assert.throws(
    () =>
      resolveProductionHistoricalSelection({
        evidence: notReady.evidence,
        historicalEvidence: notReady.historicalEvidence,
        candidateId: notReady.candidateId,
      }),
    TypeError,
    "B1 must reject a selected candidate whose assessment is no longer ready",
  );
});

test("complete S0 evidence cannot waive invalid fixture headers or missing/disabled context declarations", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter((unit) => unit.kind !== "baseline");
    const cases = [
      {
        name: "invalid-fixture-header-with-complete-S0",
        metadata: { fixtureHash: null },
        expectedError: /capture fixture binding header is invalid:.*fixtureHash must match the base fixture/,
      },
      {
        name: "baseline-disabled",
        metadata: { measureBaseline: false },
        expected: { code: "baseline-measurements-disabled", detail: "capture.json measureBaseline is false" },
      },
      {
        name: "baseline-setting-missing",
        metadata: { measureBaseline: undefined },
        expected: {
          code: "missing-baseline-measurement-setting",
          detail: "capture.json measureBaseline is missing or null",
        },
      },
    ];
    for (const { name, metadata, expected, expectedError } of cases) {
      const caseOutDir = path.join(path.dirname(outDir), name);
      await createBoundStateCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
        capturedUnits: ["light", "dark"].flatMap((mode) => units.map((unit) => ({ mode, unitId: unit.id }))),
        capturedBaselineModes: ["light", "dark"],
        sourceHashes: currentSourceHashes(),
        captureMetadata: metadata,
      });

      const args = readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel });
      if (expectedError) {
        await assert.rejects(
          () => verifyProductionCapture(args),
          (error) => error instanceof TypeError && expectedError.test(error.message),
          name,
        );
        continue;
      }
      const result = await verifyProductionCapture(args);

      assert.equal(result.status, "incomplete", name);
      assert.equal(result.exitCode, 2, name);
      assert.deepEqual(result.errors, [], name);
      assert.deepEqual(result.gaps, [expected], name);
    }
  });
});

test("rejects a selected candidate that differs from the actual production palette", async () => {
  await withProductionRun(async ({ runDir, outDir, testRoot }) => {
    const verifiedModel = makeVerifiedModel();
    const selections = makeSelections(verifiedModel);
    const candidate = verifiedModel.candidateSet.candidates.find(
      (item) => item.skinId === SKIN_IDS[0] && item.variant === "a",
    );
    const unit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find(
      (entry) => entry.kind !== "baseline" && entry.stateId === "keyboard-focus",
    );
    const roleId = STATE_BY_ID.get("keyboard-focus").expectedRoleIds.find((id) => {
      const role = ROLE_BY_ID.get(id);
      return role.required === true && Number.isFinite(role.threshold) && role.threshold > 0;
    });
    const role = ROLE_BY_ID.get(roleId);
    await fs.promises.writeFile(
      path.join(runDir, "candidates.json"),
      `${JSON.stringify(verifiedModel.candidateSet)}\n`,
    );
    await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [{ mode: "light", unitId: unit.id }],
      statePatches: {
        [`light/${unit.id}`]: {
          checks(checks) {
            const record = checks.records.find((entry) => entry.roleId === roleId);
            record.result = "fail";
            record.ratio = role.threshold - 0.01;
            record.threshold = role.threshold;
          },
        },
      },
      sourceHashes: {
        ...currentSourceHashes(),
        "scripts/skin-palette/capture.mjs": "9ee883f00db2ec8a167fddbf0bde3491e4cf6f507888a258b5f13ac09c217f45",
      },
    });
    const before = await snapshotFixtureTree(testRoot);

    const result = await verifyProductionCapture({
      ...readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
      productionPalettes: { [candidate.skinId]: candidate.modes },
      currentSourceHashes: makeSourceHashes(),
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.exitCode, 2);
    const tokenErrorIndices = result.errors.flatMap((error, index) =>
      error.code === "production-token-mismatch" ? [index] : [],
    );
    const roleErrorIndex = result.errors.findIndex((error) => error.code === "required-role-fail");
    const sourceErrorIndex = result.errors.findIndex((error) => error.code === "source-changed");
    assert.ok(tokenErrorIndices.length > 0);
    assert.ok(tokenErrorIndices.at(-1) < roleErrorIndex);
    assert.ok(roleErrorIndex < sourceErrorIndex);
    assert.equal(result.errors[roleErrorIndex].roleId, roleId);
    assert.equal(result.errors[sourceErrorIndex].file, "scripts/skin-palette/capture.mjs");
    assert.deepEqual(Object.keys(result.errors[tokenErrorIndices[0]].detail).sort(), ["actual", "code", "expected"]);
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("a required-role failure rejects even when other capture units are missing", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const unit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find(
      (entry) => entry.kind !== "baseline" && entry.stateId === "keyboard-focus",
    );
    const roleId = STATE_BY_ID.get("keyboard-focus").expectedRoleIds.find((id) => {
      const role = ROLE_BY_ID.get(id);
      return role.required === true && Number.isFinite(role.threshold) && role.threshold > 0;
    });
    assert.ok(unit);
    assert.ok(roleId);
    const role = ROLE_BY_ID.get(roleId);
    const key = `light/${unit.id}`;
    const statePatches = {
      [key]: {
        checks(checks) {
          const record = checks.records.find((entry) => entry.roleId === roleId);
          record.result = "fail";
          record.ratio = role.threshold - 0.01;
          record.threshold = role.threshold;
        },
      },
    };
    await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [{ mode: "light", unitId: unit.id }],
      statePatches,
      sourceHashes: currentSourceHashes(),
    });
    const before = await snapshotFixtureTree(testRoot);

    const result = await verifyProductionCapture(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );

    assert.equal(result.status, "rejected");
    assert.equal(result.exitCode, 2);
    assert.ok(result.errors.some((error) => error.code === "required-role-fail" && error.roleId === roleId));
    assert.ok(result.gaps.length > 0);
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("reports only missing evidence as incomplete and rejects source drift including the historical capture hash", async () => {
  await withProductionRun(async ({ candidate, runDir, outDir, selections, verifiedModel }) => {
    const argsFor = (name) => ({
      candidate,
      outDir: path.join(path.dirname(outDir), name),
      runDir,
      selections,
      verifiedModel,
    });
    const actualHashes = currentSourceHashes();
    const cases = [
      {
        name: "only-required-gaps",
        hashes: actualHashes,
        status: "incomplete",
        check(result) {
          assert.deepEqual(result.errors, []);
          assert.ok(result.gaps.length > 0);
        },
      },
      {
        name: "missing-source-hash",
        hashes: Object.fromEntries(Object.entries(actualHashes).filter(([file]) => file !== SOURCE_FILES[0])),
        status: "incomplete",
        check(result) {
          assert.ok(result.errors.length === 0);
          assert.ok(result.gaps.some((gap) => gap.code === "missing-source-hash" && gap.file === SOURCE_FILES[0]));
        },
      },
      {
        name: "historical-capture-hash",
        hashes: {
          ...actualHashes,
          "scripts/skin-palette/capture.mjs": "9ee883f00db2ec8a167fddbf0bde3491e4cf6f507888a258b5f13ac09c217f45",
        },
        captureMetadata: { policyHash: "f".repeat(64) },
        status: "rejected",
        check(result) {
          assert.ok(
            result.errors.some(
              (error) => error.code === "source-changed" && error.file === "scripts/skin-palette/capture.mjs",
            ),
          );
          assert.ok(result.errors.some((error) => error.code === "policy-changed"));
          assert.ok(result.gaps.length > 0);
        },
      },
    ];

    for (const { name, hashes, captureMetadata, status, check } of cases) {
      const args = argsFor(name);
      await createBoundStateCapture({
        candidate,
        outDir: args.outDir,
        runDir,
        selections,
        verifiedModel,
        capturedUnits: [],
        sourceHashes: hashes,
        captureMetadata,
      });
      const before = await snapshotFixtureTree(args.outDir);
      const result = await verifyProductionCapture(readBindingArgs({ ...args, candidate }));
      assert.equal(result.status, status, name);
      assert.equal(result.exitCode, 2, name);
      check(result);
      assert.deepEqual(await snapshotFixtureTree(args.outDir), before, name);
    }
  });
});

test("deduplicates identical gaps from classification, source, state, and S0 readers", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const captureResult = await createBoundStateCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [],
      sourceHashes: currentSourceHashes(),
    });
    const [classification, source, context, states, baseline] = await Promise.all([
      classifyProductionCapture({ skinId: candidate.skinId, captureResult }),
      Promise.resolve(verifyProductionSourceHashes({ skinId: candidate.skinId, captureResult })),
      Promise.resolve(verifyProductionContext({ skinId: candidate.skinId, captureResult, candidate })),
      readProductionStateEvidence(args),
      readProductionBaselineEvidence(args),
    ]);
    const expected = [];
    const seen = new Set();
    for (const group of [classification.gaps, source.gaps, context.gaps, states.gaps, baseline.gaps]) {
      for (const diagnostic of group) {
        const key = canonicalJson(diagnostic);
        if (seen.has(key)) continue;
        seen.add(key);
        expected.push(diagnostic);
      }
    }

    const result = await verifyProductionCapture(args);

    assert.deepEqual(result.gaps, expected);
    assert.equal(new Set(result.gaps.map(canonicalJson)).size, result.gaps.length);
    assert.ok(result.gaps.some((gap) => typeof gap.mode === "string" && typeof gap.unitId === "string"));
  });
});

test("throws for tampered S0 attachments, a missing sidecar, and an incorrect formal skin identity", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const argsFor = (name) => ({
      candidate,
      outDir: path.join(path.dirname(outDir), name),
      runDir,
      selections,
      verifiedModel,
    });
    const hashes = currentSourceHashes();

    const tampered = argsFor("tampered-baseline");
    await createBoundStateCapture({
      candidate,
      outDir: tampered.outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [],
      capturedBaselineModes: ["light"],
      sourceHashes: hashes,
    });
    await fs.promises.writeFile(path.join(tampered.outDir, "light", "baseline.png"), Buffer.from("replaced"));
    await assert.rejects(
      verifyProductionCapture(readBindingArgs(tampered)),
      /S0 基准附件证据不完整/,
      "changed baseline attachment",
    );

    const missingSidecar = argsFor("missing-sidecar");
    await createBoundStateCapture({
      candidate,
      outDir: missingSidecar.outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [],
      sourceHashes: hashes,
    });
    await fs.promises.rm(path.join(missingSidecar.outDir, "production-selection.json"));
    await assert.rejects(
      verifyProductionCapture(readBindingArgs(missingSidecar)),
      /production-selection\.json/,
      "missing selection binding",
    );

    const wrongIdentity = argsFor("wrong-formal-identity");
    await createBoundStateCapture({
      candidate,
      outDir: wrongIdentity.outDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [],
      sourceHashes: hashes,
    });
    const capturePath = path.join(wrongIdentity.outDir, "capture.json");
    const capture = JSON.parse(await fs.promises.readFile(capturePath, "utf8"));
    capture.candidate.skinId = SKIN_IDS[1];
    await writeFixtureJson(capturePath, capture);
    await assert.rejects(
      verifyProductionCapture(readBindingArgs(wrongIdentity)),
      /captureResult\.capture\.candidate must identify production mode and the selected skin only/,
      "capture metadata names a different formal skin",
    );
  });
});

test("writes one skin-keyed production index shard with a POSIX sibling path and no other index", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const captureResult = await createSmallBoundProductionCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
    });
    const captureSummary = summarizeProductionCapture({ skinId: candidate.skinId, captureResult });
    assert.equal(captureSummary.errors.length, 0);
    assert.ok(captureSummary.gaps.length > 0);

    const candidateShardPath = path.join(outDir, "capture-index-shard.json");
    const candidateShardBytes = Buffer.from("candidate shard stays unchanged\n");
    await fs.promises.writeFile(candidateShardPath, candidateShardBytes);
    const beforeOut = await snapshotFixtureTree(outDir);
    const beforeRun = await snapshotFixtureTree(runDir);
    const beforeSourceHashes = currentSourceHashes();
    const inputsBefore = JSON.stringify({ candidate, selections, verifiedModel, captureResult });
    const expectedIndex = {
      schemaVersion: 1,
      captures: { [candidate.skinId]: "../capture-output" },
    };
    const shardPath = path.join(outDir, "production-index-shard.json");

    const first = await writeProductionCaptureIndexShard(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );
    assert.deepEqual(first, { shardPath, index: expectedIndex });
    assert.deepEqual(Object.keys(first), ["shardPath", "index"]);
    assert.deepEqual(Object.keys(first.index).sort(), ["captures", "schemaVersion"]);
    assert.equal(first.index.captures[candidate.id], undefined);
    assert.equal((await fs.promises.readFile(shardPath, "utf8")).endsWith("\n"), true);

    const equivalentBytes = Buffer.from(` \n${JSON.stringify(expectedIndex)} \n`);
    await fs.promises.writeFile(shardPath, equivalentBytes);
    const second = await writeProductionCaptureIndexShard(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );
    const third = await writeProductionCaptureIndexShard(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.deepEqual(await fs.promises.readFile(shardPath), equivalentBytes);
    assert.deepEqual(await fs.promises.readFile(candidateShardPath), candidateShardBytes);

    const afterOut = await snapshotFixtureTree(outDir);
    assert.deepEqual(afterOut, {
      ...beforeOut,
      "production-index-shard.json": hashBytes(equivalentBytes),
    });
    assert.deepEqual(await snapshotFixtureTree(runDir), beforeRun);
    assert.deepEqual(currentSourceHashes(), beforeSourceHashes);
    assert.equal(JSON.stringify({ candidate, selections, verifiedModel, captureResult }), inputsBefore);
    const outputNames = await fs.promises.readdir(outDir);
    for (const forbidden of ["captures-index.json", "production-captures-index.json"]) {
      assert.equal(outputNames.includes(forbidden), false, forbidden);
    }
  });
});

test("registers a failed formal capture without upgrading its result", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const captureResult = await createSmallBoundProductionCapture({
      candidate,
      outDir,
      runDir,
      selections,
      verifiedModel,
      modeStatusOverrides: { light: "failed" },
    });
    const summary = summarizeProductionCapture({ skinId: candidate.skinId, captureResult });
    assert.ok(summary.errors.some((error) => error.code === "failed-status"));

    const result = await writeProductionCaptureIndexShard(
      readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel }),
    );

    assert.deepEqual(result.index, {
      schemaVersion: 1,
      captures: { [candidate.skinId]: "../capture-output" },
    });
    assert.deepEqual(Object.keys(result), ["shardPath", "index"]);
    assert.equal(
      JSON.parse(await fs.promises.readFile(path.join(outDir, "capture.json"), "utf8")).modes.light.status,
      "failed",
    );
  });
});

test("preserves existing mismatched, malformed, extra-field, and directory shards", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      {
        name: "wrong-skin-key",
        index(relativePath) {
          return { schemaVersion: 1, captures: { [SKIN_IDS[1]]: relativePath } };
        },
        error: /different or unsupported binding/,
      },
      {
        name: "candidate-id-key",
        index(relativePath) {
          return { schemaVersion: 1, captures: { [candidate.id]: relativePath } };
        },
        error: /different or unsupported binding/,
      },
      {
        name: "wrong-relative-path",
        index() {
          return { schemaVersion: 1, captures: { [candidate.skinId]: "../another-capture" } };
        },
        error: /different or unsupported binding/,
      },
      {
        name: "absolute-path",
        index() {
          return { schemaVersion: 1, captures: { [candidate.skinId]: path.resolve(outDir) } };
        },
        error: /different or unsupported binding/,
      },
      {
        name: "url-path",
        index() {
          return { schemaVersion: 1, captures: { [candidate.skinId]: "https://example.test/capture" } };
        },
        error: /different or unsupported binding/,
      },
      {
        name: "extra-field",
        index(relativePath) {
          return { schemaVersion: 1, captures: { [candidate.skinId]: relativePath }, status: "pass" };
        },
        error: /different or unsupported binding/,
      },
      { name: "bad-json", bytes: Buffer.from("{ broken shard\n"), error: /contains invalid JSON/ },
      { name: "directory", directory: true },
    ];

    for (const item of cases) {
      const caseOutDir = path.join(path.dirname(outDir), item.name);
      await createSmallBoundProductionCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
      });
      const relativePath = path.relative(runDir, caseOutDir).split(path.sep).join("/");
      const shardPath = path.join(caseOutDir, "production-index-shard.json");
      if (item.directory) {
        await fs.promises.mkdir(shardPath);
        await fs.promises.writeFile(path.join(shardPath, "keep.txt"), "keep\n");
      } else {
        const bytes = item.bytes ?? Buffer.from(`${JSON.stringify(item.index(relativePath))}\n`);
        await fs.promises.writeFile(shardPath, bytes);
      }
      const before = await snapshotFixtureTree(caseOutDir);

      await assert.rejects(
        writeProductionCaptureIndexShard(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        item.error,
        item.name,
      );
      assert.deepEqual(await snapshotFixtureTree(caseOutDir), before, item.name);
    }
  });
});

test("refuses a production shard symlink when Windows permits creating one", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    await createSmallBoundProductionCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const shardPath = path.join(outDir, "production-index-shard.json");
    const targetPath = path.join(outDir, "shard-target.json");
    const targetBytes = Buffer.from("symlink target stays unchanged\n");
    await fs.promises.writeFile(targetPath, targetBytes);
    try {
      await fs.promises.symlink(targetPath, shardPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      writeProductionCaptureIndexShard(readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel })),
      /production-index-shard\.json must not be a symlink/,
    );
    assert.equal((await fs.promises.lstat(shardPath)).isSymbolicLink(), true);
    assert.deepEqual(await fs.promises.readFile(targetPath), targetBytes);
  });
});

test("requires present consistent binding evidence before creating a production shard", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    const cases = [
      { name: "missing-selection-binding", edit: (dir) => fs.promises.rm(path.join(dir, "production-selection.json")) },
      {
        name: "capture-byte-drift",
        edit: (dir) => fs.promises.appendFile(path.join(dir, "capture.json"), " "),
      },
      {
        name: "progress-byte-drift",
        edit: (dir) => fs.promises.appendFile(path.join(dir, "progress.json"), " "),
      },
      {
        name: "wrong-formal-skin",
        async edit(dir) {
          const filePath = path.join(dir, "capture.json");
          const capture = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
          capture.candidate.skinId = SKIN_IDS[1];
          await writeFixtureJson(filePath, capture);
        },
      },
    ];

    for (const item of cases) {
      const caseOutDir = path.join(path.dirname(outDir), item.name);
      await createSmallBoundProductionCapture({
        candidate,
        outDir: caseOutDir,
        runDir,
        selections,
        verifiedModel,
      });
      await item.edit(caseOutDir);
      const before = await snapshotFixtureTree(caseOutDir);
      const shardPath = path.join(caseOutDir, "production-index-shard.json");

      await assert.rejects(
        writeProductionCaptureIndexShard(
          readBindingArgs({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel }),
        ),
        undefined,
        item.name,
      );
      assert.equal(fs.existsSync(shardPath), false, item.name);
      assert.deepEqual(await snapshotFixtureTree(caseOutDir), before, item.name);
    }
  });
});

test("rejects validation roots and equal run/output directories without writing", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, verifiedModel }) => {
    await createSmallBoundProductionCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const args = readBindingArgs({ candidate, outDir, runDir, selections, verifiedModel });
    const outputShard = path.join(outDir, "production-index-shard.json");
    const runShard = path.join(runDir, "production-index-shard.json");

    await assert.rejects(writeProductionCaptureIndexShard({ ...args, runDir: validationRoot }), /strict child/);
    await assert.rejects(writeProductionCaptureIndexShard({ ...args, outDir: validationRoot }), /strict child/);
    await assert.rejects(writeProductionCaptureIndexShard({ ...args, outDir: runDir }), /different directories/);
    assert.equal(fs.existsSync(outputShard), false);
    assert.equal(fs.existsSync(runShard), false);
  });
});

test("rejects a directory-junction escape before writing a production shard", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    await createSmallBoundProductionCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const junctionPath = path.join(testRoot, "out-junction");
    const outsideTarget = await fs.promises.mkdtemp(path.join(tmpdir(), "skin-palette-c5a-outside-"));
    const outsideShard = path.join(outsideTarget, "production-index-shard.json");
    try {
      await fs.promises.symlink(outsideTarget, junctionPath, "junction");
    } catch (error) {
      await fs.promises.rm(outsideTarget, { recursive: true, force: true });
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    try {
      await assert.rejects(
        writeProductionCaptureIndexShard(
          readBindingArgs({ candidate, outDir: junctionPath, runDir, selections, verifiedModel }),
        ),
        /realpath.*strict child/,
      );
      assert.equal(fs.existsSync(outsideShard), false);
    } finally {
      await fs.promises.rm(outsideTarget, { recursive: true, force: true });
    }
  });
});

test("reads partial, complete, and empty explicit indexes in skin order without mutating evidence", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const entries = await createBoundProductionSkinCaptures({
      runDir,
      defaultOutDir: outDir,
      selections,
      verifiedModel,
      skinIds: SKIN_IDS,
      modeStatusBySkin: { [SKIN_IDS[1]]: { light: "failed" } },
    });
    const capturesDir = path.join(path.dirname(outDir), "capture-chatgpt");
    const failedDir = path.join(path.dirname(outDir), `capture-${SKIN_IDS[1]}`);
    assert.equal(
      JSON.parse(await fs.promises.readFile(path.join(capturesDir, "capture.json"), "utf8")).modes.light.status,
      "incomplete",
    );
    assert.equal(
      JSON.parse(await fs.promises.readFile(path.join(failedDir, "capture.json"), "utf8")).modes.light.status,
      "failed",
    );

    const partialCaptures = Object.fromEntries(SKIN_IDS.slice(0, 2).map((skinId) => [skinId, entries[skinId]]));
    const partial = await writeProductionIndexValue(runDir, partialCaptures, "indexes/partial-index.json");
    const complete = await writeProductionIndexValue(runDir, entries, "complete-index.json");
    const empty = await writeProductionIndexValue(runDir, {}, "empty-index.json");
    const before = await snapshotFixtureTree(testRoot);
    const inputsBefore = JSON.stringify({ candidate, selections, verifiedModel });

    const partialResult = await readProductionCaptureIndex({
      runDir,
      capturesIndexPath: path.relative(REPO_ROOT, partial.filePath),
      verifiedModel,
      selections,
    });
    assert.equal(partialResult.indexPath, await fs.promises.realpath(partial.filePath));
    assert.deepEqual(partialResult.index, partial.index);
    assert.deepEqual(Object.keys(partialResult.captures), SKIN_IDS.slice(0, 2));
    assert.deepEqual(
      partialResult.gaps.map(({ skinId }) => skinId),
      SKIN_IDS.slice(2),
    );
    assert.deepEqual(Object.keys(partialResult), ["indexPath", "index", "captures", "gaps"]);
    for (const skinId of SKIN_IDS.slice(0, 2)) {
      const entry = partialResult.captures[skinId];
      const selection = selections.choices[skinId];
      assert.equal(entry.outDir, await fs.promises.realpath(path.join(path.dirname(outDir), `capture-${skinId}`)));
      assert.equal(entry.candidateId, selection.candidateId);
      assert.equal(entry.candidateHash, selection.candidateHash);
      assert.equal(entry.binding.selectionBinding.skinId, skinId);
      assert.deepEqual(Object.keys(entry).sort(), ["binding", "candidateHash", "candidateId", "outDir"]);
    }
    assert.deepEqual(
      partialResult.captures[SKIN_IDS[1]].binding.selectionBinding.candidateId,
      selections.choices[SKIN_IDS[1]].candidateId,
    );

    const completeResult = await readProductionCaptureIndex({
      runDir,
      capturesIndexPath: complete.filePath,
      verifiedModel,
      selections,
    });
    assert.deepEqual(Object.keys(completeResult.captures), SKIN_IDS);
    assert.deepEqual(completeResult.gaps, []);
    assert.equal(
      completeResult.captures[SKIN_IDS[1]].binding.selectionBinding.candidateId,
      selections.choices[SKIN_IDS[1]].candidateId,
    );

    const absoluteRunResult = await readProductionCaptureIndex({
      runDir: path.resolve(runDir),
      capturesIndexPath: complete.filePath,
      verifiedModel,
      selections,
    });
    assert.equal(absoluteRunResult.indexPath, completeResult.indexPath);

    const emptyResult = await readProductionCaptureIndex({
      runDir,
      capturesIndexPath: empty.filePath,
      verifiedModel,
      selections,
    });
    assert.deepEqual(emptyResult.captures, {});
    assert.deepEqual(
      emptyResult.gaps.map(({ skinId }) => skinId),
      SKIN_IDS,
    );
    assert.ok(emptyResult.gaps.every((gap) => gap.code === "missing-production-capture"));
    assert.equal(JSON.stringify({ candidate, selections, verifiedModel }), inputsBefore);
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("validates complete selections and actual run candidates even for an empty index", async () => {
  await withProductionRun(async ({ outDir, runDir, selections, testRoot, verifiedModel }) => {
    const { filePath } = await writeProductionIndexValue(runDir, {});
    const args = { runDir, capturesIndexPath: filePath, verifiedModel, selections };
    const valid = await readProductionCaptureIndex(args);
    assert.deepEqual(
      valid.gaps.map(({ skinId }) => skinId),
      SKIN_IDS,
    );

    const missingChoice = structuredClone(selections);
    delete missingChoice.choices[SKIN_IDS.at(-1)];
    await assert.rejects(readProductionCaptureIndex({ ...args, selections: missingChoice }), TypeError);

    const candidatePath = path.join(runDir, "candidates.json");
    const changedSet = JSON.parse(await fs.promises.readFile(candidatePath, "utf8"));
    const changedCandidate = changedSet.candidates[0];
    changedCandidate.style.rationale += " run-only content drift";
    changedCandidate.candidateHash = hashCandidate(changedCandidate);
    changedCandidate.id = `${changedCandidate.skinId}-${changedCandidate.variant}-${changedCandidate.candidateHash.slice(0, 12)}`;
    changedSet.candidateSetHash = hashCandidateSet(changedSet);
    assert.equal(validateCandidateSet(changedSet, { expectedSkinIds: SKIN_IDS }).valid, true);
    await writeFixtureJson(candidatePath, changedSet);
    const before = await snapshotFixtureTree(testRoot);
    await assert.rejects(readProductionCaptureIndex(args), /candidateSetHash does not match the original selection/);
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
    assert.equal(fs.existsSync(outDir), false);
  });
});

test("rejects malformed production indexes and non-POSIX capture paths", async () => {
  await withProductionRun(async ({ candidate, runDir, selections, testRoot, verifiedModel }) => {
    const { filePath } = await writeProductionIndexValue(runDir, {}, "indexes/captures-index.json");
    const cases = [
      { name: "array-index", value: [] },
      { name: "null-index", value: null },
      { name: "extra-index-field", value: { schemaVersion: 1, captures: {}, status: "pass" } },
      { name: "wrong-schema", value: { schemaVersion: 2, captures: {} } },
      { name: "array-captures", value: { schemaVersion: 1, captures: [] } },
      { name: "candidate-id-key", value: { schemaVersion: 1, captures: { [candidate.id]: "../capture-chatgpt" } } },
      { name: "unknown-skin-key", value: { schemaVersion: 1, captures: { "not-a-skin": "../capture-chatgpt" } } },
      { name: "url-path", capturePath: "https://example.test/capture" },
      { name: "custom-url-scheme-path", capturePath: "javascript:alert(1)" },
      { name: "drive-path", capturePath: "C:/captures/chatgpt" },
      { name: "drive-relative-path", capturePath: "C:captures" },
      { name: "unc-path", capturePath: "//server/share/capture" },
      { name: "posix-absolute-path", capturePath: "/captures/chatgpt" },
      { name: "backslash-path", capturePath: "captures\\chatgpt" },
      { name: "empty-path", capturePath: "" },
      { name: "empty-segment-path", capturePath: "capture//chatgpt" },
      { name: "dot-segment-path", capturePath: "capture/./chatgpt" },
    ];
    for (const item of cases) {
      const value = Object.hasOwn(item, "value")
        ? item.value
        : {
            schemaVersion: 1,
            captures: { [candidate.skinId]: item.capturePath ?? "../capture-chatgpt" },
          };
      await writeFixtureJson(filePath, value);
      const before = await snapshotFixtureTree(testRoot);
      await assert.rejects(
        readProductionCaptureIndex({
          runDir,
          capturesIndexPath: path.relative(REPO_ROOT, filePath),
          verifiedModel,
          selections,
        }),
        TypeError,
        item.name,
      );
      assert.deepEqual(await snapshotFixtureTree(testRoot), before, item.name);
    }
  });
});

test("rejects mismatched skin, candidate, formal identity, and capture/progress bindings", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const cases = [
      {
        name: "index-key-does-not-match-capture",
        indexSkinId: SKIN_IDS[1],
      },
      {
        name: "sidecar-candidate-drift",
        edit(outDirForCase) {
          const sidecarPath = path.join(outDirForCase, "production-selection.json");
          const binding = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
          const wrongCandidate = verifiedModel.candidateSet.candidates.find(
            (entry) => entry.skinId === candidate.skinId && entry.variant === "b",
          );
          binding.selectionBinding.candidateId = wrongCandidate.id;
          binding.selectionBinding.candidateHash = wrongCandidate.candidateHash;
          fs.writeFileSync(sidecarPath, `${JSON.stringify(binding)}\n`);
        },
      },
      {
        name: "capture-candidate-id-impostor",
        async edit(outDirForCase) {
          const filePath = path.join(outDirForCase, "capture.json");
          const capture = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
          capture.candidate.id = candidate.id;
          capture.candidate.variant = candidate.variant;
          await writeFixtureJson(filePath, capture);
        },
      },
      {
        name: "wrong-formal-skin",
        async edit(outDirForCase) {
          const filePath = path.join(outDirForCase, "capture.json");
          const capture = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
          capture.candidate.skinId = SKIN_IDS[1];
          await writeFixtureJson(filePath, capture);
        },
      },
      {
        name: "missing-formal-identity",
        async edit(outDirForCase) {
          const filePath = path.join(outDirForCase, "capture.json");
          const capture = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
          capture.candidate = { production: true, skinId: candidate.skinId, id: null };
          await writeFixtureJson(filePath, capture);
        },
      },
      {
        name: "missing-sidecar",
        edit: (outDirForCase) => fs.promises.rm(path.join(outDirForCase, "production-selection.json")),
      },
      {
        name: "capture-byte-drift",
        edit: (outDirForCase) => fs.promises.appendFile(path.join(outDirForCase, "capture.json"), " "),
      },
      {
        name: "progress-byte-drift",
        edit: (outDirForCase) => fs.promises.appendFile(path.join(outDirForCase, "progress.json"), " "),
      },
    ];

    for (const item of cases) {
      const caseOutDir = path.join(path.dirname(outDir), `capture-${item.name}`);
      await createSmallBoundProductionCapture({ candidate, outDir: caseOutDir, runDir, selections, verifiedModel });
      if (item.edit) await item.edit(caseOutDir);
      const indexSkinId = item.indexSkinId ?? candidate.skinId;
      const relativePath = path.relative(runDir, caseOutDir).split(path.sep).join("/");
      const { filePath } = await writeProductionIndexValue(runDir, { [indexSkinId]: relativePath });
      const before = await snapshotFixtureTree(testRoot);

      await assert.rejects(
        readProductionCaptureIndex({ runDir, capturesIndexPath: filePath, verifiedModel, selections }),
        undefined,
        item.name,
      );
      assert.deepEqual(await snapshotFixtureTree(testRoot), before, item.name);
    }
  });
});

test("rejects two skin keys that resolve to the same real capture directory", async (t) => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const captureOutDir = path.join(path.dirname(outDir), "capture-chatgpt");
    await createSmallBoundProductionCapture({
      candidate,
      outDir: captureOutDir,
      runDir,
      selections,
      verifiedModel,
    });
    const aliasPath = path.join(runDir, "capture-alias");
    try {
      await fs.promises.symlink(captureOutDir, aliasPath, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const captures = {
      [SKIN_IDS[0]]: path.relative(runDir, captureOutDir).split(path.sep).join("/"),
      [SKIN_IDS[1]]: "capture-alias",
    };
    const { filePath } = await writeProductionIndexValue(runDir, captures);
    const before = await snapshotFixtureTree(testRoot);

    await assert.rejects(
      readProductionCaptureIndex({ runDir, capturesIndexPath: filePath, verifiedModel, selections }),
      /same capture directory/,
    );
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("rejects invalid run and explicit index paths, non-files, and malformed JSON", async () => {
  await withProductionRun(async ({ runDir, selections, testRoot, verifiedModel }) => {
    const { filePath } = await writeProductionIndexValue(runDir, {});
    const outsideIndexPath = path.join(testRoot, "outside-index.json");
    await writeFixtureJson(outsideIndexPath, { schemaVersion: 1, captures: {} });
    const directoryPath = path.join(runDir, "index-directory");
    await fs.promises.mkdir(directoryPath);
    const malformedPath = path.join(runDir, "malformed-index.json");
    await fs.promises.writeFile(malformedPath, "{not-json\n", "utf8");
    const args = { runDir, capturesIndexPath: filePath, verifiedModel, selections };
    const rejects = [
      { name: "empty run directory", args: { ...args, runDir: "" }, error: TypeError },
      { name: "URL run directory", args: { ...args, runDir: "file:///tmp/skin-run" }, error: TypeError },
      {
        name: "custom URL scheme run directory",
        args: { ...args, runDir: "mailto:captures@example.test" },
        error: TypeError,
      },
      { name: "validation root is not a run", args: { ...args, runDir: validationRoot }, error: /strict child/ },
      { name: "empty index path", args: { ...args, capturesIndexPath: " " }, error: TypeError },
      {
        name: "URL index path",
        args: { ...args, capturesIndexPath: "https://example.test/captures-index.json" },
        error: TypeError,
      },
      {
        name: "custom URL scheme index path",
        args: { ...args, capturesIndexPath: "javascript:alert(1)" },
        error: TypeError,
      },
      {
        name: "index outside run",
        args: { ...args, capturesIndexPath: outsideIndexPath },
        error: /strict child of runDir/,
      },
      { name: "missing index file", args: { ...args, capturesIndexPath: path.join(runDir, "missing-index.json") } },
      {
        name: "index directory instead of file",
        args: { ...args, capturesIndexPath: directoryPath },
        error: /regular file/,
      },
      { name: "invalid index JSON", args: { ...args, capturesIndexPath: malformedPath }, error: /invalid JSON/ },
    ];
    for (const item of rejects) {
      const before = await snapshotFixtureTree(testRoot);
      await assert.rejects(readProductionCaptureIndex(item.args), item.error, item.name);
      assert.deepEqual(await snapshotFixtureTree(testRoot), before, item.name);
    }
  });
});

test("rejects an explicit captures index file symlink", async (t) => {
  await withProductionRun(async ({ runDir, selections, testRoot, verifiedModel }) => {
    const targetPath = path.join(runDir, "captures-index-target.json");
    const linkPath = path.join(runDir, "captures-index-link.json");
    await writeFixtureJson(targetPath, { schemaVersion: 1, captures: {} });
    try {
      await fs.promises.symlink(targetPath, linkPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = await snapshotFixtureTree(testRoot);

    await assert.rejects(
      readProductionCaptureIndex({ runDir, capturesIndexPath: linkPath, verifiedModel, selections }),
      /captures-index\.json must not be a symlink or junction/,
    );
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("rejects run, index-parent, and capture directory junction escapes", async (t) => {
  await withProductionRun(async ({ runDir, selections, testRoot, verifiedModel }) => {
    const outsideTarget = await fs.promises.mkdtemp(path.join(tmpdir(), "skin-palette-c5b-outside-"));
    const runAlias = path.join(testRoot, "run-alias");
    const indexParentAlias = path.join(runDir, "external-index-dir");
    const captureAlias = path.join(runDir, "external-capture-dir");
    const aliases = [runAlias, indexParentAlias, captureAlias];
    try {
      for (const alias of aliases) await fs.promises.symlink(outsideTarget, alias, "junction");
    } catch (error) {
      for (const alias of aliases) await fs.promises.rm(alias, { recursive: true, force: true });
      await fs.promises.rm(outsideTarget, { recursive: true, force: true });
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    try {
      const outsideIndexPath = path.join(outsideTarget, "captures-index.json");
      await writeFixtureJson(outsideIndexPath, { schemaVersion: 1, captures: {} });
      const indexPath = path.join(runDir, "captures-index.json");
      await writeProductionIndexValue(runDir, { [SKIN_IDS[0]]: "external-capture-dir" });
      const before = await snapshotFixtureTree(testRoot);

      await assert.rejects(
        readProductionCaptureIndex({
          runDir: runAlias,
          capturesIndexPath: path.join(runAlias, "captures-index.json"),
          verifiedModel,
          selections,
        }),
        /runDir realpath.*strict child/,
        "run directory junction cannot redirect the named run",
      );
      await assert.rejects(
        readProductionCaptureIndex({
          runDir,
          capturesIndexPath: path.join(indexParentAlias, "captures-index.json"),
          verifiedModel,
          selections,
        }),
        /captures-index\.json realpath escapes its verified directory/,
        "index parent junction cannot read another directory",
      );
      await assert.rejects(
        readProductionCaptureIndex({ runDir, capturesIndexPath: indexPath, verifiedModel, selections }),
        /production capture realpath.*docs\/validation/,
        "capture directory junction cannot escape the validation root",
      );
      assert.deepEqual(await snapshotFixtureTree(testRoot), before);
    } finally {
      for (const alias of aliases) await fs.promises.rm(alias, { recursive: true, force: true });
      await fs.promises.rm(outsideTarget, { recursive: true, force: true });
    }
  });
});

test("summarizes empty and partial production indexes as incomplete without changing evidence", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    await createSmallBoundProductionCapture({ candidate, outDir, runDir, selections, verifiedModel });
    const partialIndex = await writeProductionIndexValue(runDir, {
      [candidate.skinId]: path.relative(runDir, outDir).split(path.sep).join("/"),
    });
    const emptyIndex = await writeProductionIndexValue(runDir, {}, "empty-index.json");
    const before = await snapshotFixtureTree(testRoot);
    const inputsBefore = JSON.stringify({ verifiedModel, selections });

    const partial = await verifyProductionCaptureIndex({
      runDir,
      capturesIndexPath: partialIndex.filePath,
      verifiedModel,
      selections,
    });
    assert.equal(partial.status, "incomplete");
    assert.equal(partial.exitCode, 2);
    assert.equal(partial.results.length, 1);
    assert.equal(partial.results[0].skinId, SKIN_IDS[0]);
    assert.equal(partial.results[0].status, "incomplete");
    assert.deepEqual(
      partial.gaps.filter(({ code }) => code === "missing-production-capture").map(({ skinId }) => skinId),
      SKIN_IDS.slice(1),
    );
    assert.ok(partial.gaps.every((gap) => typeof gap.skinId === "string"));

    const empty = await verifyProductionCaptureIndex({
      runDir,
      capturesIndexPath: emptyIndex.filePath,
      verifiedModel,
      selections,
    });
    assert.equal(empty.status, "incomplete");
    assert.equal(empty.exitCode, 2);
    assert.deepEqual(empty.results, []);
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(
      empty.gaps.map(({ code, skinId }) => ({ code, skinId })),
      SKIN_IDS.map((skinId) => ({ code: "missing-production-capture", skinId })),
    );
    assert.equal(JSON.stringify({ verifiedModel, selections }), inputsBefore);
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("continues in skin order after failures and preserves duplicate diagnostics with skin identity", async () => {
  await withProductionRun(
    async ({ outDir, runDir, selections, testRoot, verifiedModel }) => {
      const captures = {};
      for (const skinId of SKIN_IDS.slice(0, 3)) {
        const candidate = verifiedModel.candidateSet.candidates.find(
          (entry) => entry.id === selections.choices[skinId].candidateId,
        );
        const skinOutDir = path.join(path.dirname(outDir), `capture-${skinId}`);
        await createSmallBoundProductionCapture({
          candidate,
          outDir: skinOutDir,
          runDir,
          selections,
          verifiedModel,
          modeStatusOverrides: skinId === SKIN_IDS[2] ? {} : { light: "failed" },
        });
        captures[skinId] = path.relative(runDir, skinOutDir).split(path.sep).join("/");
      }
      const index = await writeProductionIndexValue(runDir, captures);
      const before = await snapshotFixtureTree(testRoot);

      const result = await verifyProductionCaptureIndex({
        runDir,
        capturesIndexPath: index.filePath,
        verifiedModel,
        selections,
      });

      assert.equal(result.status, "rejected");
      assert.equal(result.exitCode, 2);
      assert.deepEqual(
        result.results.map(({ skinId }) => skinId),
        SKIN_IDS.slice(0, 3),
      );
      assert.deepEqual(
        result.results.map(({ status }) => status),
        ["rejected", "rejected", "incomplete"],
      );
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.every(({ skinId }) => SKIN_IDS.slice(0, 3).includes(skinId)));
      const repeatedError = result.errors.find((item) =>
        result.errors.some((other) => other !== item && other.code === item.code && other.skinId !== item.skinId),
      );
      assert.ok(repeatedError, "same-code errors from different skins must remain separate");
      assert.ok(result.gaps.every((gap) => typeof gap.skinId === "string"));
      assert.deepEqual(await snapshotFixtureTree(testRoot), before);
    },
    { productionSkinIds: SKIN_IDS },
  );
});

test("verifies ten current-palette captures in registration order without writing", async () => {
  await withProductionRun(
    async ({ outDir, runDir, selections, testRoot, verifiedModel }) => {
      const units = STATE_MATRIX_GROUPS.flatMap((group) => group.units).filter((unit) => unit.kind !== "baseline");
      const captures = {};
      for (const skinId of SKIN_IDS) {
        const candidate = verifiedModel.candidateSet.candidates.find(
          (entry) => entry.id === selections.choices[skinId].candidateId,
        );
        const skinOutDir = path.join(path.dirname(outDir), `capture-${skinId}`);
        await createBoundStateCapture({
          candidate,
          outDir: skinOutDir,
          runDir,
          selections,
          verifiedModel,
          capturedUnits: ["light", "dark"].flatMap((mode) => units.map((unit) => ({ mode, unitId: unit.id }))),
          capturedBaselineModes: ["light", "dark"],
          sourceHashes: currentSourceHashes(),
        });
        captures[skinId] = path.relative(runDir, skinOutDir).split(path.sep).join("/");
      }
      const index = await writeProductionIndexValue(runDir, captures);
      const before = await snapshotFixtureTree(testRoot);
      const inputsBefore = JSON.stringify({ verifiedModel, selections });

      const result = await verifyProductionCaptureIndex({
        runDir,
        capturesIndexPath: index.filePath,
        verifiedModel,
        selections,
      });

      assert.deepEqual(result, {
        status: "pass",
        exitCode: 0,
        results: SKIN_IDS.map((skinId) => {
          const choice = selections.choices[skinId];
          const candidate = verifiedModel.candidateSet.candidates.find((entry) => entry.id === choice.candidateId);
          return {
            skinId,
            candidateId: candidate.id,
            candidateHash: candidate.candidateHash,
            status: "pass",
            exitCode: 0,
            errors: [],
            gaps: [],
          };
        }),
        errors: [],
        gaps: [],
      });
      assert.equal(JSON.stringify({ verifiedModel, selections }), inputsBefore);
      assert.deepEqual(await snapshotFixtureTree(testRoot), before);
    },
    { productionSkinIds: SKIN_IDS },
  );
});

test("index verification still throws for wrong identity, missing attachments, and sidecar evidence", async () => {
  await withProductionRun(async ({ candidate, outDir, runDir, selections, testRoot, verifiedModel }) => {
    const stateUnit = STATE_MATRIX_GROUPS.flatMap((group) => group.units).find((unit) => unit.kind !== "baseline");
    const stateOutDir = path.join(path.dirname(outDir), "capture-with-state");
    await createBoundStateCapture({
      candidate,
      outDir: stateOutDir,
      runDir,
      selections,
      verifiedModel,
      capturedUnits: [{ mode: "light", unitId: stateUnit.id }],
      capturedBaselineModes: [],
      sourceHashes: currentSourceHashes(),
    });
    const index = await writeProductionIndexValue(runDir, {
      [candidate.skinId]: path.relative(runDir, stateOutDir).split(path.sep).join("/"),
    });
    const stateImage = path.join(stateOutDir, "light", "states", stateUnit.id, "state.png");
    await fs.promises.rm(stateImage);
    await assert.rejects(
      verifyProductionCaptureIndex({ runDir, capturesIndexPath: index.filePath, verifiedModel, selections }),
      /证据文件摘要与 progress\.json 不一致/,
      "missing captured-state attachment remains a hard error",
    );

    const identityOutDir = path.join(path.dirname(outDir), "capture-wrong-identity");
    await createSmallBoundProductionCapture({
      candidate,
      outDir: identityOutDir,
      runDir,
      selections,
      verifiedModel,
    });
    const capturePath = path.join(identityOutDir, "capture.json");
    const capture = JSON.parse(await fs.promises.readFile(capturePath, "utf8"));
    capture.candidate.skinId = SKIN_IDS[1];
    await writeFixtureJson(capturePath, capture);
    const identityIndex = await writeProductionIndexValue(
      runDir,
      { [candidate.skinId]: path.relative(runDir, identityOutDir).split(path.sep).join("/") },
      "identity-index.json",
    );
    await assert.rejects(
      verifyProductionCaptureIndex({
        runDir,
        capturesIndexPath: identityIndex.filePath,
        verifiedModel,
        selections,
      }),
      TypeError,
      "capture identity drift remains a hard error",
    );

    const sidecarOutDir = path.join(path.dirname(outDir), "capture-missing-sidecar");
    await createSmallBoundProductionCapture({
      candidate,
      outDir: sidecarOutDir,
      runDir,
      selections,
      verifiedModel,
    });
    await fs.promises.rm(path.join(sidecarOutDir, "production-selection.json"));
    const sidecarIndex = await writeProductionIndexValue(
      runDir,
      { [candidate.skinId]: path.relative(runDir, sidecarOutDir).split(path.sep).join("/") },
      "sidecar-index.json",
    );
    const before = await snapshotFixtureTree(testRoot);
    await assert.rejects(
      verifyProductionCaptureIndex({
        runDir,
        capturesIndexPath: sidecarIndex.filePath,
        verifiedModel,
        selections,
      }),
      { code: "ENOENT" },
      "missing formal binding sidecar remains a hard error",
    );
    assert.deepEqual(await snapshotFixtureTree(testRoot), before);
  });
});

test("D7a origin accepts a two-candidate set, returns undefined, preserves inputs, and reads no paths", () => {
  const candidateSet = makeManifestCandidateSet();
  const origin = makeProductionManifestOrigin(candidateSet);
  const before = structuredClone({ origin, candidateSet });

  assert.equal(assertProductionManifestOrigin({ origin, candidateSet }), undefined);
  assert.deepEqual({ origin, candidateSet }, before);
  assert.ok(Object.values(origin.captureRecords).every((record) => record.capturePath.startsWith("docs/validation/")));
  assert.notEqual(
    origin.captureRecords[candidateSet.candidates[0].id].capturePath.split("/")[3],
    origin.captureRecords[candidateSet.candidates[1].id].capturePath.split("/")[3],
    "historical captures may live in different validation runs",
  );
});

test("D7a origin accepts null-prototype records and a null-prototype options object", () => {
  const candidateSet = makeManifestCandidateSet();
  const plain = makeProductionManifestOrigin(candidateSet);
  const origin = Object.assign(Object.create(null), plain);
  for (const key of ["candidateCapturesIndex", "candidateSet", "assessment", "selections"]) {
    origin[key] = Object.assign(Object.create(null), plain[key]);
  }
  origin.captureRecords = Object.create(null);
  for (const [candidateId, record] of Object.entries(plain.captureRecords)) {
    origin.captureRecords[candidateId] = Object.assign(Object.create(null), record);
  }
  const options = Object.assign(Object.create(null), { origin, candidateSet });

  assert.equal(assertProductionManifestOrigin(options), undefined);
});

test("D7a origin rejects non-records, unknown fields, symbols, and accessors without invoking them", () => {
  const candidateSet = makeManifestCandidateSet();
  const makeOrigin = () => makeProductionManifestOrigin(candidateSet);
  const extra = makeOrigin();
  extra.extra = true;
  const missing = makeOrigin();
  delete missing.runDir;
  const withSymbol = makeOrigin();
  withSymbol[Symbol("extra")] = true;
  const array = [];
  const instance = new (class OriginRecord {
    constructor() {
      Object.assign(this, makeOrigin());
    }
  })();
  let getterCalls = 0;
  const accessor = makeOrigin();
  Object.defineProperty(accessor, "runDir", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("origin getter must not execute");
    },
  });
  const nestedAccessor = makeOrigin();
  Object.defineProperty(nestedAccessor.assessment, "assessmentHash", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("nested getter must not execute");
    },
  });

  for (const origin of [extra, missing, withSymbol, array, instance, accessor, nestedAccessor]) {
    assert.throws(() => assertProductionManifestOrigin({ origin, candidateSet }), TypeError);
  }
  assert.equal(getterCalls, 0);
  assert.throws(() => assertProductionManifestOrigin({ origin: makeOrigin(), candidateSet, ignored: true }), TypeError);
});

test("D7a origin requires exact nested fields and lowercase SHA-256 values", () => {
  const candidateSet = makeManifestCandidateSet();
  const origin = makeProductionManifestOrigin(candidateSet);
  const hashTargets = [
    [["candidateCapturesIndex"], "fileSha256"],
    [["candidateSet"], "fileSha256"],
    [["candidateSet"], "candidateSetHash"],
    [["assessment"], "fileSha256"],
    [["assessment"], "assessmentHash"],
    [["selections"], "fileSha256"],
    [["selections"], "recordHash"],
    ...Object.keys(origin.captureRecords).flatMap((candidateId) => [
      [["captureRecords", candidateId], "fileSha256"],
      [["captureRecords", candidateId], "sourceHashesHash"],
    ]),
  ];
  for (const [sectionPath, field] of hashTargets) {
    const getRecord = (target) => sectionPath.reduce((value, key) => value[key], target);
    const uppercase = structuredClone(origin);
    getRecord(uppercase)[field] = "A".repeat(64);
    assert.throws(() => assertProductionManifestOrigin({ origin: uppercase, candidateSet }), TypeError);
    for (const invalidDigest of ["a".repeat(63), "g".repeat(64)]) {
      const malformed = structuredClone(origin);
      getRecord(malformed)[field] = invalidDigest;
      assert.throws(() => assertProductionManifestOrigin({ origin: malformed, candidateSet }), TypeError);
    }
    const missing = structuredClone(origin);
    delete getRecord(missing)[field];
    assert.throws(() => assertProductionManifestOrigin({ origin: missing, candidateSet }), TypeError);
  }

  for (const section of ["candidateCapturesIndex", "candidateSet", "assessment", "selections"]) {
    const extra = structuredClone(origin);
    extra[section].unexpected = true;
    assert.throws(() => assertProductionManifestOrigin({ origin: extra, candidateSet }), TypeError);
  }
  for (const candidateId of Object.keys(origin.captureRecords)) {
    const extra = structuredClone(origin);
    extra.captureRecords[candidateId].unexpected = true;
    assert.throws(() => assertProductionManifestOrigin({ origin: extra, candidateSet }), TypeError);
  }
  const symbolRecord = structuredClone(origin);
  symbolRecord.selections[Symbol("extra")] = true;
  assert.throws(() => assertProductionManifestOrigin({ origin: symbolRecord, candidateSet }), TypeError);

  const mismatchedSetHash = structuredClone(origin);
  mismatchedSetHash.candidateSet.candidateSetHash = "9".repeat(64);
  assert.throws(() => assertProductionManifestOrigin({ origin: mismatchedSetHash, candidateSet }), TypeError);
  const invalidSet = structuredClone(candidateSet);
  invalidSet.candidateSetHash = "0".repeat(64);
  assert.throws(() => assertProductionManifestOrigin({ origin, candidateSet: invalidSet }), TypeError);
});

test("D7a captureRecords cover every CandidateSet candidate exactly once and exclude rejected records", () => {
  const candidateSet = makeManifestCandidateSet();
  const origin = makeProductionManifestOrigin(candidateSet);
  const [first, second] = candidateSet.candidates;

  const missing = structuredClone(origin);
  delete missing.captureRecords[second.id];
  assert.throws(() => assertProductionManifestOrigin({ origin: missing, candidateSet }), TypeError);
  const extra = structuredClone(origin);
  extra.captureRecords["rejected-candidate"] = { ...extra.captureRecords[first.id] };
  assert.throws(() => assertProductionManifestOrigin({ origin: extra, candidateSet }), TypeError);
  const repeatedPath = structuredClone(origin);
  repeatedPath.captureRecords[second.id].capturePath = repeatedPath.captureRecords[first.id].capturePath;
  assert.throws(() => assertProductionManifestOrigin({ origin: repeatedPath, candidateSet }), TypeError);

  candidateSet.rejected.push({
    code: "INVALID_INPUT",
    skinId: null,
    mode: "light",
    variant: null,
    roleIds: [],
    attemptedRanges: [],
    worstRatio: null,
    threshold: null,
    message: "candidate rejected before output",
  });
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  origin.candidateSet.candidateSetHash = candidateSet.candidateSetHash;
  assert.equal(assertProductionManifestOrigin({ origin, candidateSet }), undefined);
  assert.deepEqual(
    Object.keys(origin.captureRecords),
    candidateSet.candidates.map(({ id }) => id),
  );
});

test("D7a origin paths are strict validation-root POSIX children with fixed reference names", () => {
  const candidateSet = makeManifestCandidateSet();
  const origin = makeProductionManifestOrigin(candidateSet);
  const invalidBases = [
    "C:/outside/docs/validation/run",
    "\\\\server\\share\\docs\\validation\\run",
    "/docs/validation/run",
    "https://example.test/docs/validation/run",
    "docs\\validation\\run",
    "",
    "docs/validation//run",
    "docs/validation/./run",
    "docs/validation/../run",
    "docs/validation-old/run",
    "docs/validation/run/",
  ];
  for (const invalidPath of invalidBases) {
    const invalidRun = structuredClone(origin);
    invalidRun.runDir = invalidPath;
    assert.throws(() => assertProductionManifestOrigin({ origin: invalidRun, candidateSet }), TypeError, invalidPath);

    const invalidIndex = structuredClone(origin);
    invalidIndex.candidateCapturesIndex.path = `${invalidPath}/captures-index.json`;
    assert.throws(
      () => assertProductionManifestOrigin({ origin: invalidIndex, candidateSet }),
      TypeError,
      `${invalidPath} index path`,
    );

    const invalidCapture = structuredClone(origin);
    invalidCapture.captureRecords[candidateSet.candidates[0].id].capturePath = `${invalidPath}/capture.json`;
    assert.throws(
      () => assertProductionManifestOrigin({ origin: invalidCapture, candidateSet }),
      TypeError,
      `${invalidPath} capture path`,
    );
  }
  const prefixOnly = structuredClone(origin);
  prefixOnly.runDir = "docs/validation";
  assert.throws(() => assertProductionManifestOrigin({ origin: prefixOnly, candidateSet }), TypeError);

  for (const indexPath of [
    "docs/validation/run/.json",
    "docs/validation/run/captures-index",
    "docs/validation/run/captures-index.JSON",
  ]) {
    const invalidIndex = structuredClone(origin);
    invalidIndex.candidateCapturesIndex.path = indexPath;
    assert.throws(() => assertProductionManifestOrigin({ origin: invalidIndex, candidateSet }), TypeError);
  }
  for (const capturePath of ["docs/validation/run/not-capture.json", "docs/validation/run/CAPTURE.JSON"]) {
    const invalidCapture = structuredClone(origin);
    invalidCapture.captureRecords[candidateSet.candidates[0].id].capturePath = capturePath;
    assert.throws(() => assertProductionManifestOrigin({ origin: invalidCapture, candidateSet }), TypeError);
  }
  for (const [section, expectedPath] of [
    ["candidateSet", "candidates.json"],
    ["assessment", "assessments.json"],
    ["selections", "selections.json"],
  ]) {
    const invalidReference = structuredClone(origin);
    invalidReference[section].path = `docs/validation/run/${expectedPath}`;
    assert.throws(() => assertProductionManifestOrigin({ origin: invalidReference, candidateSet }), TypeError);
  }
});

test("D7b accepts the fixed two-candidate manifest shape without mutation or file access", () => {
  const candidateSet = makeManifestCandidateSet();
  const manifest = makeProductionSourceManifest(candidateSet);
  const assets = enumerateSourceAssets();
  const before = structuredClone({ manifest, candidateSet });

  assert.equal(SOURCE_FILES.length, 31);
  assert.equal(assets.length, 40);
  assert.equal(GENERATED_ASSET_TOOL_FILES.length, 4);
  assert.equal(Object.keys(manifest.after.sourceHashes).length, SOURCE_FILES.length);
  assert.ok(Object.hasOwn(manifest.after.sourceHashes, "public/timeline-utils.js"));
  const missingTimeline = structuredClone(manifest);
  delete missingTimeline.after.sourceHashes["public/timeline-utils.js"];
  assert.throws(() => assertProductionSourceManifest({ manifest: missingTimeline, candidateSet }), TypeError);
  for (const file of [
    "scripts/skin-palette/focus-outline-pixels.mjs",
    "scripts/skin-palette/focus-outline-browser.mjs",
  ]) {
    assert.equal(SOURCE_FILES.filter((entry) => entry === file).length, 1);
    const missingFocus = structuredClone(manifest);
    delete missingFocus.after.sourceHashes[file];
    assert.throws(() => assertProductionSourceManifest({ manifest: missingFocus, candidateSet }), TypeError);
  }
  assert.equal(Object.keys(manifest.after.generatedAssets.sourceAssetHashes).length, 40);
  assert.equal(Object.keys(manifest.after.generatedAssets.publicAssetHashes).length, 40);
  assert.equal(Object.keys(manifest.after.toolHashes).length, 4);
  assert.equal(assertProductionSourceManifest({ manifest, candidateSet }), undefined);
  assert.deepEqual({ manifest, candidateSet }, before);
});

test("D7b accepts null-prototype manifest objects and rejects bad top-level/nested records", () => {
  const candidateSet = makeManifestCandidateSet();
  const manifest = makeProductionSourceManifest(candidateSet);
  const nullManifest = nullPrototypeRecords(manifest);
  const options = Object.assign(Object.create(null), { manifest: nullManifest, candidateSet });
  assert.equal(assertProductionSourceManifest(options), undefined);

  const invalidCases = [
    ["wrong schema version", (value) => (value.schemaVersion = "1")],
    ["wrong kind", (value) => (value.kind = "other-manifest")],
    ["missing top-level field", (value) => delete value.after],
    ["extra top-level field", (value) => (value.allowedTransition = {})],
    ["missing preMigration field", (value) => delete value.preMigration.precheck],
    ["extra preMigration field", (value) => (value.preMigration.note = "not part of the contract")],
    ["missing precheck field", (value) => delete value.preMigration.precheck.fileSha256],
    ["extra precheck field", (value) => (value.preMigration.precheck.index = "old-snapshot")],
    ["wrong precheck path", (value) => (value.preMigration.precheck.path = "precheck.json")],
    ["missing after field", (value) => delete value.after.toolHashes],
    ["extra after field", (value) => (value.after.version = 1)],
    ["missing generated asset field", (value) => delete value.after.generatedAssets.publicAssetHashes],
    ["extra generated asset field", (value) => (value.after.generatedAssets.source = {})],
    ["origin rejected by D7a", (value) => (value.origin.candidateSet.candidateSetHash = "9".repeat(64))],
  ];
  for (const [label, mutate] of invalidCases) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => assertProductionSourceManifest({ manifest: invalid, candidateSet }), TypeError, label);
  }
  assert.throws(() => assertProductionSourceManifest({ manifest: [], candidateSet }), TypeError);
  assert.throws(() => assertProductionSourceManifest({ manifest: new (class {})(), candidateSet }), TypeError);

  let getterCalls = 0;
  const accessorManifest = structuredClone(manifest);
  Object.defineProperty(accessorManifest, "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "skin-palette-production-source-manifest";
    },
  });
  assert.throws(() => assertProductionSourceManifest({ manifest: accessorManifest, candidateSet }), TypeError);
  assert.equal(getterCalls, 0);
  const symbolManifest = structuredClone(manifest);
  symbolManifest[Symbol("extra")] = true;
  assert.throws(() => assertProductionSourceManifest({ manifest: symbolManifest, candidateSet }), TypeError);
});

test("D7b hash maps have exact registry keys and lowercase SHA-256 values", () => {
  const candidateSet = makeManifestCandidateSet();
  const manifest = makeProductionSourceManifest(candidateSet);
  const maps = [
    ["sourceHashes", ["after", "sourceHashes"]],
    ["sourceAssetHashes", ["after", "generatedAssets", "sourceAssetHashes"]],
    ["publicAssetHashes", ["after", "generatedAssets", "publicAssetHashes"]],
    ["toolHashes", ["after", "toolHashes"]],
  ];
  const getMap = (value, parts) => parts.reduce((record, key) => record[key], value);
  for (const [label, parts] of maps) {
    const validMap = getMap(manifest, parts);
    const firstKey = Object.keys(validMap)[0];
    for (const [reason, digest] of [
      ["uppercase", "A".repeat(64)],
      ["short", "a".repeat(63)],
      ["non-hex", "g".repeat(64)],
    ]) {
      const invalid = structuredClone(manifest);
      getMap(invalid, parts)[firstKey] = digest;
      assert.throws(
        () => assertProductionSourceManifest({ manifest: invalid, candidateSet }),
        TypeError,
        `${label} ${reason}`,
      );
    }
    const missing = structuredClone(manifest);
    delete getMap(missing, parts)[firstKey];
    assert.throws(
      () => assertProductionSourceManifest({ manifest: missing, candidateSet }),
      TypeError,
      `${label} missing key`,
    );
    const extra = structuredClone(manifest);
    getMap(extra, parts)["docs/validation/unknown.json"] = "a".repeat(64);
    assert.throws(
      () => assertProductionSourceManifest({ manifest: extra, candidateSet }),
      TypeError,
      `${label} extra key`,
    );
  }

  for (const invalid of [
    { ...manifest, preMigration: { precheck: { path: "integration-precheck.json", fileSha256: "A".repeat(64) } } },
    {
      ...manifest,
      after: {
        ...manifest.after,
        generatedAssets: { ...manifest.after.generatedAssets, assetManifestSha256: "not-a-sha" },
      },
    },
  ]) {
    assert.throws(() => assertProductionSourceManifest({ manifest: invalid, candidateSet }), TypeError);
  }
});

test("D7b hash-map accessors and mixed source/public asset keys are rejected without invoking getters", () => {
  const candidateSet = makeManifestCandidateSet();
  const manifest = makeProductionSourceManifest(candidateSet);
  const mapPaths = [
    ["after", "sourceHashes"],
    ["after", "generatedAssets", "sourceAssetHashes"],
    ["after", "generatedAssets", "publicAssetHashes"],
    ["after", "toolHashes"],
  ];
  const getMap = (value, parts) => parts.reduce((record, key) => record[key], value);
  let getterCalls = 0;
  for (const parts of mapPaths) {
    const invalid = structuredClone(manifest);
    const map = getMap(invalid, parts);
    const key = Object.keys(map)[0];
    Object.defineProperty(map, key, {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "a".repeat(64);
      },
    });
    assert.throws(() => assertProductionSourceManifest({ manifest: invalid, candidateSet }), TypeError);
  }
  assert.equal(getterCalls, 0);

  const assets = enumerateSourceAssets();
  const sourcePaths = assets.map(({ sourcePath }) => sourcePath);
  const publicPaths = assets.map(({ publicPath }) => publicPath);
  assert.equal(new Set(sourcePaths).size, 40);
  assert.equal(new Set(publicPaths).size, 40);
  assert.ok(sourcePaths.every((file) => !publicPaths.includes(file)));

  const sourcePublicSwap = structuredClone(manifest);
  delete sourcePublicSwap.after.generatedAssets.sourceAssetHashes[sourcePaths[0]];
  sourcePublicSwap.after.generatedAssets.sourceAssetHashes[publicPaths[0]] = "a".repeat(64);
  assert.throws(() => assertProductionSourceManifest({ manifest: sourcePublicSwap, candidateSet }), TypeError);
  const publicSourceSwap = structuredClone(manifest);
  delete publicSourceSwap.after.generatedAssets.publicAssetHashes[publicPaths[0]];
  publicSourceSwap.after.generatedAssets.publicAssetHashes[sourcePaths[0]] = "a".repeat(64);
  assert.throws(() => assertProductionSourceManifest({ manifest: publicSourceSwap, candidateSet }), TypeError);
});

test("D7c reads the fixed manifest once, returns its raw-byte hash and does not follow references", async () => {
  await withProductionRun(async ({ runDir }) => {
    const candidateSet = makeManifestCandidateSet();
    const manifest = makeManifestForReaderRun(candidateSet, runDir);
    const manifestFile = path.join(runDir, "production-source-manifest.json");
    const runPath = path.relative(REPO_ROOT, runDir).split(path.sep).join("/");
    const prettyBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await fs.promises.writeFile(path.join(runDir, "candidates.json"), "not JSON: this reader must not open it\n");
    await fs.promises.writeFile(manifestFile, prettyBytes);
    assert.equal(fs.existsSync(path.join(runDir, "integration-precheck.json")), false);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ...manifest.origin.runDir.split("/"))), false);
    for (const record of Object.values(manifest.origin.captureRecords)) {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, ...record.capturePath.split("/"))), false);
    }

    const before = structuredClone(candidateSet);
    const first = await readProductionSourceManifest({ runDir, candidateSet });
    assert.deepEqual(Object.keys(first).sort(), ["manifest", "manifestFileSha256", "manifestPath"]);
    assert.equal(first.manifestPath, `${runPath}/production-source-manifest.json`);
    assert.equal(first.manifestFileSha256, hashBytes(prettyBytes));
    assert.deepEqual(first.manifest, manifest);
    assert.deepEqual(candidateSet, before);

    const compactBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    await fs.promises.writeFile(manifestFile, compactBytes);
    const second = await readProductionSourceManifest({ runDir, candidateSet });
    assert.deepEqual(second.manifest, first.manifest);
    assert.equal(second.manifestFileSha256, hashBytes(compactBytes));
    assert.notEqual(second.manifestFileSha256, first.manifestFileSha256);
  });
});

test("D7c rejects missing, directory-valued, malformed UTF-8/JSON, invalid schema and stale CandidateSet", async () => {
  await withProductionRun(async ({ runDir }) => {
    const candidateSet = makeManifestCandidateSet();
    const manifestFile = path.join(runDir, "production-source-manifest.json");
    const read = () => readProductionSourceManifest({ runDir, candidateSet });

    await assert.rejects(read(), { code: "ENOENT" });
    await fs.promises.mkdir(manifestFile);
    await assert.rejects(read(), /production-source-manifest\.json must be a regular file/);
    await fs.promises.rmdir(manifestFile);

    await fs.promises.writeFile(manifestFile, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
    await assert.rejects(read(), /must contain valid UTF-8/);
    await fs.promises.writeFile(manifestFile, "{bad json\n", "utf8");
    await assert.rejects(read(), /contains invalid JSON/);

    const manifest = makeManifestForReaderRun(candidateSet, runDir);
    manifest.schemaVersion = 2;
    await fs.promises.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`, "utf8");
    await assert.rejects(read(), TypeError);

    manifest.schemaVersion = 1;
    manifest.origin.candidateSet.candidateSetHash = "9".repeat(64);
    await fs.promises.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`, "utf8");
    await assert.rejects(read(), TypeError);
  });
});

test("D7c accepts only exact own-data options and a validation run directory", async () => {
  await withProductionRun(async ({ runDir }) => {
    const candidateSet = makeManifestCandidateSet();
    const validOptions = { runDir, candidateSet };
    for (const options of [
      null,
      [],
      { ...validOptions, rootDir: REPO_ROOT },
      { ...validOptions, reader: () => Buffer.from("untrusted") },
      { ...validOptions, manifestPath: "another.json" },
      { ...validOptions, [Symbol("extra")]: true },
    ]) {
      await assert.rejects(readProductionSourceManifest(options), TypeError);
    }

    let getterCalls = 0;
    const accessorOptions = { candidateSet };
    Object.defineProperty(accessorOptions, "runDir", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return runDir;
      },
    });
    await assert.rejects(readProductionSourceManifest(accessorOptions), TypeError);
    assert.equal(getterCalls, 0);

    for (const invalidRunDir of ["https://example.invalid/validation/run", REPO_ROOT, validationRoot]) {
      await assert.rejects(readProductionSourceManifest({ runDir: invalidRunDir, candidateSet }), TypeError);
    }
  });
});

test("D7c rejects a manifest file symlink when Windows permits creating one", async (t) => {
  await withProductionRun(async ({ testRoot, runDir }) => {
    const candidateSet = makeManifestCandidateSet();
    const manifestFile = path.join(runDir, "production-source-manifest.json");
    const target = path.join(testRoot, "outside-manifest-target.json");
    await fs.promises.writeFile(target, "{}\n", "utf8");
    try {
      await fs.promises.symlink(target, manifestFile, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(readProductionSourceManifest({ runDir, candidateSet }), /must not be a symlink or junction/);
  });
});

test("D7c rejects a run-directory junction that resolves outside docs/validation", async (t) => {
  await withProductionRun(async ({ testRoot }) => {
    const candidateSet = makeManifestCandidateSet();
    const outside = await fs.promises.mkdtemp(path.join(tmpdir(), "skin-palette-d7c-outside-"));
    const junction = path.join(testRoot, "outside-run-junction");
    try {
      try {
        await fs.promises.symlink(outside, junction, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          t.skip(`directory junctions unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      await assert.rejects(
        readProductionSourceManifest({ runDir: junction, candidateSet }),
        /runDir realpath must be a strict child of docs\/validation/,
      );
    } finally {
      await fs.promises.rm(junction, { force: true });
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

test("D7d reads only the raw-hash-bound fixed precheck and returns independent asset summaries", async () => {
  await withProductionRun(async ({ runDir }) => {
    const precheck = makePreMigrationPrecheck();
    precheck.approvalText = "must not be echoed or treated as authorization";
    const before = structuredClone(precheck);
    const written = await writeIntegrationPrecheck(runDir, precheck);
    const runPath = path.relative(REPO_ROOT, runDir).split(path.sep).join("/");
    const result = await readProductionPreMigrationAssets({ runDir, precheckFileSha256: written.sha256 });

    assert.deepEqual(Object.keys(result).sort(), ["generatedAssets", "precheckFileSha256", "precheckPath"]);
    assert.equal(result.precheckPath, `${runPath}/integration-precheck.json`);
    assert.equal(result.precheckFileSha256, written.sha256);
    assert.deepEqual(result.generatedAssets, before.generatedAssets);
    assert.notEqual(result.generatedAssets, precheck.generatedAssets);
    assert.notEqual(result.generatedAssets.sourceAssetHashes, precheck.generatedAssets.sourceAssetHashes);
    assert.notEqual(result.generatedAssets.publicAssetHashes, precheck.generatedAssets.publicAssetHashes);
    assert.equal(Object.hasOwn(result, "approvalText"), false);
    assert.deepEqual(precheck, before);
    assert.equal(fs.existsSync(path.join(runDir, "source-before")), false);

    const firstSourcePath = enumerateSourceAssets()[0].sourcePath;
    result.generatedAssets.sourceAssetHashes[firstSourcePath] = "f".repeat(64);
    assert.equal(
      precheck.generatedAssets.sourceAssetHashes[firstSourcePath],
      before.generatedAssets.sourceAssetHashes[firstSourcePath],
    );
  });
});

test("D7d hashes raw precheck bytes before parsing and rejects whitespace-only replacement", async () => {
  await withProductionRun(async ({ runDir }) => {
    const precheck = makePreMigrationPrecheck();
    const precheckFile = path.join(runDir, "integration-precheck.json");
    const prettyBytes = Buffer.from(`${JSON.stringify(precheck, null, 2)}\n`, "utf8");
    await fs.promises.writeFile(precheckFile, prettyBytes);
    const prettyHash = hashBytes(prettyBytes);
    assert.equal(
      (await readProductionPreMigrationAssets({ runDir, precheckFileSha256: prettyHash })).precheckFileSha256,
      prettyHash,
    );

    const compactBytes = Buffer.from(`${JSON.stringify(precheck)}\n`, "utf8");
    await fs.promises.writeFile(precheckFile, compactBytes);
    await assert.rejects(
      readProductionPreMigrationAssets({ runDir, precheckFileSha256: prettyHash }),
      /raw byte SHA-256 does not match/,
    );
    const compactHash = hashBytes(compactBytes);
    assert.equal(
      (await readProductionPreMigrationAssets({ runDir, precheckFileSha256: compactHash })).precheckFileSha256,
      compactHash,
    );

    const malformedBytes = Buffer.from("{broken json\n", "utf8");
    await fs.promises.writeFile(precheckFile, malformedBytes);
    await assert.rejects(
      readProductionPreMigrationAssets({ runDir, precheckFileSha256: "0".repeat(64) }),
      /raw byte SHA-256 does not match/,
    );
    await assert.rejects(
      readProductionPreMigrationAssets({ runDir, precheckFileSha256: hashBytes(malformedBytes) }),
      /contains invalid JSON/,
    );
    const nonObjectBytes = Buffer.from("[]\n", "utf8");
    await fs.promises.writeFile(precheckFile, nonObjectBytes);
    await assert.rejects(
      readProductionPreMigrationAssets({ runDir, precheckFileSha256: hashBytes(nonObjectBytes) }),
      /must contain an object/,
    );
  });
});

test("D7d rejects incomplete, extra, mixed-key, and malformed generated asset summaries", async () => {
  await withProductionRun(async ({ runDir }) => {
    const readMutated = async (label, mutate) => {
      const precheck = makePreMigrationPrecheck();
      mutate(precheck);
      const written = await writeIntegrationPrecheck(runDir, precheck);
      await assert.rejects(
        readProductionPreMigrationAssets({ runDir, precheckFileSha256: written.sha256 }),
        TypeError,
        label,
      );
    };
    const sourcePaths = enumerateSourceAssets().map(({ sourcePath }) => sourcePath);
    const publicPaths = enumerateSourceAssets().map(({ publicPath }) => publicPath);

    for (const [label, mutate] of [
      ["missing generatedAssets", (value) => delete value.generatedAssets],
      ["non-object generatedAssets", (value) => (value.generatedAssets = [])],
      ["missing asset manifest digest", (value) => delete value.generatedAssets.assetManifestSha256],
      ["extra generatedAssets field", (value) => (value.generatedAssets.extra = true)],
      ["uppercase asset manifest digest", (value) => (value.generatedAssets.assetManifestSha256 = "A".repeat(64))],
      ["short asset manifest digest", (value) => (value.generatedAssets.assetManifestSha256 = "a".repeat(63))],
      ["non-hex asset manifest digest", (value) => (value.generatedAssets.assetManifestSha256 = "g".repeat(64))],
    ]) {
      await readMutated(label, mutate);
    }

    for (const [label, mapName, paths, otherPaths] of [
      ["sourceAssetHashes", "sourceAssetHashes", sourcePaths, publicPaths],
      ["publicAssetHashes", "publicAssetHashes", publicPaths, sourcePaths],
    ]) {
      await readMutated(`${label} non-object`, (value) => (value.generatedAssets[mapName] = []));
      for (const [reason, mutate] of [
        ["missing key", (map) => delete map[paths[0]]],
        ["extra key", (map) => (map["docs/validation/unregistered-asset.svg"] = "a".repeat(64))],
        [
          "mixed source/public key",
          (map) => {
            delete map[paths[0]];
            map[otherPaths[0]] = "a".repeat(64);
          },
        ],
        ["uppercase digest", (map) => (map[paths[0]] = "A".repeat(64))],
        ["short digest", (map) => (map[paths[0]] = "a".repeat(63))],
        ["non-hex digest", (map) => (map[paths[0]] = "g".repeat(64))],
      ]) {
        await readMutated(`${label} ${reason}`, (value) => mutate(value.generatedAssets[mapName]));
      }
    }
  });
});

test("D7d rejects invalid options, missing or directory-valued precheck, and unsafe run paths", async () => {
  await withProductionRun(async ({ runDir }) => {
    const digest = "a".repeat(64);
    const precheckFile = path.join(runDir, "integration-precheck.json");
    await assert.rejects(readProductionPreMigrationAssets({ runDir, precheckFileSha256: digest }), { code: "ENOENT" });

    for (const options of [
      null,
      [],
      { runDir, precheckFileSha256: digest, rootDir: REPO_ROOT },
      { runDir, precheckFileSha256: digest, reader: () => Buffer.from("untrusted") },
      { runDir, precheckFileSha256: digest, path: "another.json" },
      { runDir, precheckFileSha256: "A".repeat(64) },
      { runDir, precheckFileSha256: "a".repeat(63) },
      { runDir, precheckFileSha256: "g".repeat(64) },
      { runDir, precheckFileSha256: digest, [Symbol("extra")]: true },
    ]) {
      await assert.rejects(readProductionPreMigrationAssets(options), TypeError);
    }

    let getterCalls = 0;
    const accessorOptions = { precheckFileSha256: digest };
    Object.defineProperty(accessorOptions, "runDir", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return runDir;
      },
    });
    await assert.rejects(readProductionPreMigrationAssets(accessorOptions), TypeError);
    assert.equal(getterCalls, 0);

    for (const invalidRunDir of ["https://example.invalid/docs/validation/run", REPO_ROOT, validationRoot]) {
      await assert.rejects(
        readProductionPreMigrationAssets({ runDir: invalidRunDir, precheckFileSha256: digest }),
        TypeError,
      );
    }

    await fs.promises.mkdir(precheckFile);
    await assert.rejects(
      readProductionPreMigrationAssets({ runDir, precheckFileSha256: digest }),
      /integration-precheck\.json must be a regular file/,
    );
    await fs.promises.rmdir(precheckFile);
  });
});

test("D7d rejects a fixed precheck file symlink when Windows permits creating one", async (t) => {
  await withProductionRun(async ({ testRoot, runDir }) => {
    const target = path.join(testRoot, "outside-precheck-target.json");
    const precheckFile = path.join(runDir, "integration-precheck.json");
    await fs.promises.writeFile(target, "{}\n", "utf8");
    try {
      await fs.promises.symlink(target, precheckFile, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readProductionPreMigrationAssets({ runDir, precheckFileSha256: hashBytes(Buffer.from("{}\n")) }),
      /integration-precheck\.json must not be a symlink or junction/,
    );
  });
});

test("D7d rejects a run-directory junction that resolves outside docs/validation", async (t) => {
  await withProductionRun(async ({ testRoot }) => {
    const outside = await fs.promises.mkdtemp(path.join(tmpdir(), "skin-palette-d7d-outside-"));
    const junction = path.join(testRoot, "outside-run-junction");
    try {
      try {
        await fs.promises.symlink(outside, junction, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          t.skip(`directory junctions unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      await assert.rejects(
        readProductionPreMigrationAssets({ runDir: junction, precheckFileSha256: "a".repeat(64) }),
        /runDir realpath must be a strict child of docs\/validation/,
      );
    } finally {
      await fs.promises.rm(junction, { force: true });
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

test("D7e accepts matching pre-migration assets, manifest declarations, and D6b current snapshot", () => {
  const inputs = makeAssetTransitionInputs();
  const before = copyAssetTransitionInputs(inputs);

  assert.notEqual(
    inputs.manifestRecord.manifest.origin.runDir,
    inputs.manifestRecord.manifestPath.slice(0, inputs.manifestRecord.manifestPath.lastIndexOf("/")),
    "origin.runDir may reference a prior source run, separate from the manifest run",
  );
  const result = verifyProductionAssetTransition(inputs);

  assert.deepEqual(result, { status: "pass", errors: [], gaps: [] });
  assert.deepEqual(Object.keys(result), ["status", "errors", "gaps"]);
  assert.deepEqual(inputs, before);
});

test("D7e binds precheck path and raw hash to the same manifest run without requiring origin.runDir equality", () => {
  const pathMismatch = copyAssetTransitionInputs(makeAssetTransitionInputs());
  pathMismatch.preMigrationAssets.precheckPath = "docs/validation/d7e/other-run/integration-precheck.json";
  const pathResult = verifyProductionAssetTransition(pathMismatch);
  assert.equal(pathResult.status, "rejected");
  assert.deepEqual(pathResult.errors, [
    {
      code: "precheck-manifest-path-mismatch",
      path: pathMismatch.preMigrationAssets.precheckPath,
      detail: "integration-precheck.json and production-source-manifest.json must be in the same run directory",
    },
  ]);

  const hashMismatch = copyAssetTransitionInputs(makeAssetTransitionInputs());
  hashMismatch.preMigrationAssets.precheckFileSha256 = "0".repeat(64);
  const hashResult = verifyProductionAssetTransition(hashMismatch);
  assert.equal(hashResult.status, "rejected");
  assert.deepEqual(hashResult.errors, [
    {
      code: "precheck-manifest-binding-mismatch",
      path: hashMismatch.preMigrationAssets.precheckPath,
      detail: "precheckFileSha256 must match manifest.preMigration.precheck.fileSha256",
    },
  ]);
});

test("D7e rejects changed old assets even when manifest after-declarations match the new D6a snapshot", () => {
  const inputs = copyAssetTransitionInputs(makeAssetTransitionInputs());
  const first = enumerateSourceAssets()[0];
  inputs.currentAssets.sourceAssetHashes[first.sourcePath] = "e".repeat(64);
  inputs.currentAssets.publicAssetHashes[first.publicPath] = "d".repeat(64);
  refreshAssetTransitionManifest(inputs.currentAssets);
  inputs.manifestRecord.manifest.after.generatedAssets = {
    assetManifestSha256: inputs.currentAssets.assetManifestSha256,
    sourceAssetHashes: { ...inputs.currentAssets.sourceAssetHashes },
    publicAssetHashes: { ...inputs.currentAssets.publicAssetHashes },
  };

  const result = verifyProductionAssetTransition(inputs);
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, path }) => [code, path]),
    [
      ["asset-manifest-changed", "public/skin-assets.json"],
      ["source-asset-changed", first.sourcePath],
      ["public-asset-changed", first.publicPath],
    ],
  );
});

test("D7e reports old-manifest, after-map, and tool drift in registration order", () => {
  const inputs = copyAssetTransitionInputs(makeAssetTransitionInputs());
  const first = enumerateSourceAssets()[0];
  const tool = GENERATED_ASSET_TOOL_FILES[0];
  inputs.preMigrationAssets.generatedAssets.assetManifestSha256 = "8".repeat(64);
  inputs.manifestRecord.manifest.after.generatedAssets.assetManifestSha256 = "9".repeat(64);
  inputs.manifestRecord.manifest.after.generatedAssets.sourceAssetHashes[first.sourcePath] = "a".repeat(64);
  inputs.manifestRecord.manifest.after.generatedAssets.publicAssetHashes[first.publicPath] = "b".repeat(64);
  inputs.manifestRecord.manifest.after.toolHashes[tool] = "c".repeat(64);

  const result = verifyProductionAssetTransition(inputs);
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, path }) => [code, path]),
    [
      ["asset-manifest-changed", "public/skin-assets.json"],
      ["asset-manifest-after-mismatch", "public/skin-assets.json"],
      ["source-asset-after-mismatch", first.sourcePath],
      ["public-asset-after-mismatch", first.publicPath],
      ["production-tool-after-mismatch", tool],
    ],
  );
});

test("D7e preserves every D6b diagnostic before deterministic transition differences", () => {
  const inputs = copyAssetTransitionInputs(makeAssetTransitionInputs());
  const assets = enumerateSourceAssets();
  const first = assets[0];
  const missingUrl = assets[1].publicUrl;
  const tool = GENERATED_ASSET_TOOL_FILES[0];
  const currentManifest = JSON.parse(inputs.currentAssets.assetManifestBytes.toString("utf8"));
  currentManifest.generatedBy = "unregistered-generator";
  delete currentManifest.assets[missingUrl];
  inputs.currentAssets.assetManifestBytes = Buffer.from(JSON.stringify(currentManifest), "utf8");
  inputs.currentAssets.assetManifestSha256 = hashBytes(inputs.currentAssets.assetManifestBytes);
  inputs.preMigrationAssets.precheckPath = "docs/validation/d7e/another-run/integration-precheck.json";
  inputs.preMigrationAssets.precheckFileSha256 = "0".repeat(64);
  inputs.preMigrationAssets.generatedAssets.assetManifestSha256 = "1".repeat(64);
  inputs.preMigrationAssets.generatedAssets.sourceAssetHashes[first.sourcePath] = "2".repeat(64);
  inputs.preMigrationAssets.generatedAssets.publicAssetHashes[first.publicPath] = "3".repeat(64);
  inputs.manifestRecord.manifest.after.generatedAssets.assetManifestSha256 = "4".repeat(64);
  inputs.manifestRecord.manifest.after.generatedAssets.sourceAssetHashes[first.sourcePath] = "5".repeat(64);
  inputs.manifestRecord.manifest.after.generatedAssets.publicAssetHashes[first.publicPath] = "6".repeat(64);
  inputs.manifestRecord.manifest.after.toolHashes[tool] = "7".repeat(64);

  const result = verifyProductionAssetTransition(inputs);
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, path }) => [code, path]),
    [
      ["asset-generator-reference-mismatch", "public/skin-assets.json"],
      ["precheck-manifest-path-mismatch", inputs.preMigrationAssets.precheckPath],
      ["precheck-manifest-binding-mismatch", inputs.preMigrationAssets.precheckPath],
      ["asset-manifest-changed", "public/skin-assets.json"],
      ["asset-manifest-after-mismatch", "public/skin-assets.json"],
      ["source-asset-changed", first.sourcePath],
      ["source-asset-after-mismatch", first.sourcePath],
      ["public-asset-changed", first.publicPath],
      ["public-asset-after-mismatch", first.publicPath],
      ["production-tool-after-mismatch", tool],
    ],
  );
  assert.deepEqual(result.gaps, [
    {
      code: "asset-record-missing",
      path: missingUrl,
      detail: "skin-assets.json has no record for this registered publicUrl",
    },
  ]);
});

test("D7e keeps D6b incomplete and lossless-declaration rejection from becoming PASS", () => {
  const missingRecord = copyAssetTransitionInputs(makeAssetTransitionInputs());
  const missingUrl = enumerateSourceAssets()[3].publicUrl;
  const missingManifest = JSON.parse(missingRecord.currentAssets.assetManifestBytes.toString("utf8"));
  delete missingManifest.assets[missingUrl];
  missingRecord.currentAssets.assetManifestBytes = Buffer.from(JSON.stringify(missingManifest), "utf8");
  missingRecord.currentAssets.assetManifestSha256 = hashBytes(missingRecord.currentAssets.assetManifestBytes);
  missingRecord.preMigrationAssets.generatedAssets.assetManifestSha256 =
    missingRecord.currentAssets.assetManifestSha256;
  missingRecord.manifestRecord.manifest.after.generatedAssets.assetManifestSha256 =
    missingRecord.currentAssets.assetManifestSha256;
  const missingResult = verifyProductionAssetTransition(missingRecord);
  assert.equal(missingResult.status, "incomplete");
  assert.deepEqual(missingResult.errors, []);
  assert.deepEqual(missingResult.gaps, [
    {
      code: "asset-record-missing",
      path: missingUrl,
      detail: "skin-assets.json has no record for this registered publicUrl",
    },
  ]);

  const lossy = copyAssetTransitionInputs(makeAssetTransitionInputs());
  const lossyManifest = JSON.parse(lossy.currentAssets.assetManifestBytes.toString("utf8"));
  lossyManifest.assets[enumerateSourceAssets()[0].publicUrl].alphaMaxDelta = 1;
  lossy.currentAssets.assetManifestBytes = Buffer.from(JSON.stringify(lossyManifest), "utf8");
  lossy.currentAssets.assetManifestSha256 = hashBytes(lossy.currentAssets.assetManifestBytes);
  lossy.preMigrationAssets.generatedAssets.assetManifestSha256 = lossy.currentAssets.assetManifestSha256;
  lossy.manifestRecord.manifest.after.generatedAssets.assetManifestSha256 = lossy.currentAssets.assetManifestSha256;
  const lossyResult = verifyProductionAssetTransition(lossy);
  assert.equal(lossyResult.status, "rejected");
  assert.deepEqual(lossyResult.errors, [
    {
      code: "asset-lossless-declaration-invalid",
      path: enumerateSourceAssets()[0].publicUrl,
      detail: "alphaMaxDelta must be the number 0",
    },
  ]);
});

test("D7e rejects malformed inputs, unknown fields, bad maps, and accessors without invoking them", () => {
  const valid = makeAssetTransitionInputs();
  const invalid = [];
  invalid.push(null, [], { ...copyAssetTransitionInputs(valid), extra: true });

  const badManifestRecord = copyAssetTransitionInputs(valid);
  badManifestRecord.manifestRecord.extra = true;
  invalid.push(badManifestRecord);
  const badManifestPath = copyAssetTransitionInputs(valid);
  badManifestPath.manifestRecord.manifestPath = "docs/validation/d7e/run/wrong.json";
  invalid.push(badManifestPath);
  const badManifestHash = copyAssetTransitionInputs(valid);
  badManifestHash.manifestRecord.manifestFileSha256 = "A".repeat(64);
  invalid.push(badManifestHash);

  const badPrecheckPath = copyAssetTransitionInputs(valid);
  badPrecheckPath.preMigrationAssets.precheckPath = "docs/validation/d7e/run/wrong.json";
  invalid.push(badPrecheckPath);
  const badOldMap = copyAssetTransitionInputs(valid);
  delete badOldMap.preMigrationAssets.generatedAssets.sourceAssetHashes[enumerateSourceAssets()[0].sourcePath];
  invalid.push(badOldMap);
  const badOldHash = copyAssetTransitionInputs(valid);
  badOldHash.preMigrationAssets.generatedAssets.publicAssetHashes[enumerateSourceAssets()[0].publicPath] = "A".repeat(
    64,
  );
  invalid.push(badOldHash);
  const badCurrent = copyAssetTransitionInputs(valid);
  delete badCurrent.currentAssets.toolHashes[GENERATED_ASSET_TOOL_FILES[0]];
  invalid.push(badCurrent);
  const badCandidateSet = copyAssetTransitionInputs(valid);
  badCandidateSet.candidateSet.candidates[0].candidateHash = "0".repeat(64);
  invalid.push(badCandidateSet);

  for (const input of invalid) assert.throws(() => verifyProductionAssetTransition(input), TypeError);

  let getterCalls = 0;
  const accessorMap = copyAssetTransitionInputs(valid);
  const sourcePath = enumerateSourceAssets()[0].sourcePath;
  Object.defineProperty(accessorMap.preMigrationAssets.generatedAssets.sourceAssetHashes, sourcePath, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "a".repeat(64);
    },
  });
  assert.throws(() => verifyProductionAssetTransition(accessorMap), TypeError);

  const accessorOptions = {
    manifestRecord: valid.manifestRecord,
    preMigrationAssets: valid.preMigrationAssets,
    candidateSet: valid.candidateSet,
  };
  Object.defineProperty(accessorOptions, "currentAssets", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return valid.currentAssets;
    },
  });
  assert.throws(() => verifyProductionAssetTransition(accessorOptions), TypeError);
  assert.equal(getterCalls, 0);
});

test("D8a-2 binds real loader paths and all four origin metadata files without mutation", async () => {
  await withProductionOriginMetadataFixture(async ({ testRoot, runDir, indexDir, manifestRecord, evidence }) => {
    assert.notEqual(indexDir, runDir);
    const before = structuredClone({ manifestRecord, evidence });
    const result = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    assert.deepEqual(result, { status: "pass", errors: [], gaps: [] });
    assert.deepEqual({ manifestRecord, evidence }, before);

    const untrustedCandidatePath = path.join(testRoot, "untrusted-candidates.json");
    const untrustedIndexPath = path.join(testRoot, "untrusted-index.json");
    await fs.promises.writeFile(untrustedCandidatePath, "not json\n");
    await fs.promises.writeFile(untrustedIndexPath, "not json\n");
    const untrustedPaths = structuredClone(evidence);
    untrustedPaths.run.dir = path.join(testRoot, "other-run");
    untrustedPaths.run.candidatesPath = untrustedCandidatePath;
    untrustedPaths.run.index.path = untrustedIndexPath;
    const mismatched = await verifyProductionOriginMetadata({ manifestRecord, evidence: untrustedPaths });
    assert.equal(mismatched.status, "rejected");
    assert.deepEqual(
      mismatched.errors.map(({ code, path: filePath }) => [code, filePath]),
      [
        ["origin-metadata-path-mismatch", manifestRecord.manifest.origin.runDir],
        ["origin-metadata-path-mismatch", `${manifestRecord.manifest.origin.runDir}/candidates.json`],
        ["origin-metadata-path-mismatch", manifestRecord.manifest.origin.candidateCapturesIndex.path],
      ],
    );
    assert.deepEqual(mismatched.gaps, [], "invalid canary files at loader paths are never read");
  });
});

test("D8a-1 rejects whitespace-only raw drift even when the JSON object is unchanged", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence, filePaths, fileBytes }) => {
    const bytes = Buffer.concat([fileBytes.assessment, Buffer.from(" \n", "utf8")]);
    await fs.promises.writeFile(filePaths.assessment, bytes);
    const result = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.errors, [
      {
        code: "origin-metadata-file-hash-mismatch",
        path: `${manifestRecord.manifest.origin.runDir}/assessments.json`,
        detail: "raw file SHA-256 does not match the manifest",
      },
    ]);
    assert.deepEqual(result.gaps, []);
  });
});

test("D8a-1 retains a missing-file gap and continues to report later raw hash drift", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence, filePaths, fileBytes }) => {
    await fs.promises.rm(filePaths.candidateSet);
    await fs.promises.writeFile(filePaths.assessment, Buffer.concat([fileBytes.assessment, Buffer.from(" ")]));
    const result = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.errors, [
      {
        code: "origin-metadata-file-hash-mismatch",
        path: `${manifestRecord.manifest.origin.runDir}/assessments.json`,
        detail: "raw file SHA-256 does not match the manifest",
      },
    ]);
    assert.deepEqual(result.gaps, [
      {
        code: "origin-metadata-file-missing",
        path: `${manifestRecord.manifest.origin.runDir}/candidates.json`,
        detail: "declared origin metadata file is missing",
      },
    ]);
  });
});

test("D8a-2 preserves a missing index gap without resolving its path again", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence, filePaths }) => {
    await fs.promises.rm(filePaths.index);
    const result = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.gaps, [
      {
        code: "origin-metadata-file-missing",
        path: manifestRecord.manifest.origin.candidateCapturesIndex.path,
        detail: "declared origin metadata file is missing",
      },
    ]);
  });
});

test("D8a-2 reports loader object drift and all three logical hash mismatches in file order", async () => {
  await withProductionOriginMetadataFixture(
    async ({ manifestRecord, evidence, filePaths, candidateSet, assessment }) => {
      const changedCandidateSet = structuredClone(candidateSet);
      changedCandidateSet.candidateSetHash = "a".repeat(64);
      const candidateBytes = Buffer.from(`${JSON.stringify(changedCandidateSet)}\n`, "utf8");
      await fs.promises.writeFile(filePaths.candidateSet, candidateBytes);
      manifestRecord.manifest.origin.candidateSet.fileSha256 = hashBytes(candidateBytes);

      const changedAssessment = { ...assessment, assessmentHash: "b".repeat(64) };
      const assessmentBytes = Buffer.from(`${JSON.stringify(changedAssessment)}\n`, "utf8");
      await fs.promises.writeFile(filePaths.assessment, assessmentBytes);
      manifestRecord.manifest.origin.assessment.fileSha256 = hashBytes(assessmentBytes);

      const selectionBytes = await fs.promises.readFile(filePaths.selection);
      const changedSelection = JSON.parse(selectionBytes.toString("utf8"));
      changedSelection.decisionSource += " drift";
      const changedSelectionBytes = Buffer.from(`${JSON.stringify(changedSelection)}\n`, "utf8");
      await fs.promises.writeFile(filePaths.selection, changedSelectionBytes);
      manifestRecord.manifest.origin.selections.fileSha256 = hashBytes(changedSelectionBytes);

      const result = await verifyProductionOriginMetadata({ manifestRecord, evidence });
      assert.equal(result.status, "rejected");
      assert.deepEqual(
        result.errors.map(({ code, path: filePath }) => [code, filePath]),
        [
          ["origin-metadata-content-mismatch", `${manifestRecord.manifest.origin.runDir}/candidates.json`],
          ["origin-metadata-record-hash-mismatch", `${manifestRecord.manifest.origin.runDir}/candidates.json`],
          ["origin-metadata-content-mismatch", `${manifestRecord.manifest.origin.runDir}/assessments.json`],
          ["origin-metadata-record-hash-mismatch", `${manifestRecord.manifest.origin.runDir}/assessments.json`],
          ["origin-metadata-content-mismatch", `${manifestRecord.manifest.origin.runDir}/selections.json`],
          ["origin-metadata-record-hash-mismatch", `${manifestRecord.manifest.origin.runDir}/selections.json`],
        ],
      );
      assert.deepEqual(result.gaps, []);
    },
  );
});

test("D8a-2 marks loader-reported missing review and selection as gaps without inspecting absent records", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence }) => {
    evidence.review = { present: false, path: { ignored: true }, container: new Date() };
    evidence.selections = { present: false, path: [], record: 42 };
    const result = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.gaps.map(({ code, path: filePath }) => [code, filePath]),
      [
        ["origin-loaded-assessment-missing", `${manifestRecord.manifest.origin.runDir}/assessments.json`],
        ["origin-loaded-selections-missing", `${manifestRecord.manifest.origin.runDir}/selections.json`],
      ],
    );
  });
});

test("D8a-2 rejects malformed or accessor-backed present loader records", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence }) => {
    for (const mutate of [
      (copy) => {
        copy.review.container = [];
      },
      (copy) => {
        copy.selections.record = [];
      },
      (copy) => {
        copy.review.path = null;
      },
      (copy) => {
        copy.selections.path = undefined;
      },
      (copy) => {
        Object.defineProperty(copy.review.container, "accessor", { enumerable: true, get: () => true });
      },
      (copy) => {
        Object.defineProperty(copy.selections.record, "accessor", { enumerable: true, get: () => true });
      },
    ]) {
      const invalidEvidence = structuredClone(evidence);
      mutate(invalidEvidence);
      await assert.rejects(verifyProductionOriginMetadata({ manifestRecord, evidence: invalidEvidence }), TypeError);
    }
    for (const mutate of [
      (copy) => {
        copy.review.present = undefined;
      },
      (copy) => {
        copy.selections.present = 1;
      },
      (copy) => {
        copy.run.dir = "relative/run";
      },
      (copy) => {
        copy.run.index.path = "relative/index.json";
      },
    ]) {
      const invalidEvidence = structuredClone(evidence);
      mutate(invalidEvidence);
      await assert.rejects(verifyProductionOriginMetadata({ manifestRecord, evidence: invalidEvidence }), TypeError);
    }
  });
});

test("D8a-2 aggregates path, raw, content, and index diagnostics in stable order", async () => {
  await withProductionOriginMetadataFixture(async ({ testRoot, manifestRecord, evidence, fileBytes, filePaths }) => {
    const wrongIndexPath = path.join(testRoot, "wrong-index.json");
    evidence.run.dir = path.join(testRoot, "wrong-run");
    evidence.run.candidatesPath = "other-candidates.json";
    evidence.review.path = "other-assessments.json";
    evidence.selections.path = "other-selections.json";
    evidence.run.index.path = wrongIndexPath;
    evidence.review.container.assessments[0].readiness = "loader drift";
    evidence.selections.record.decisionSource += " loader drift";
    await fs.promises.writeFile(filePaths.candidateSet, Buffer.concat([fileBytes.candidateSet, Buffer.from(" ")]));
    await fs.promises.writeFile(filePaths.assessment, Buffer.concat([fileBytes.assessment, Buffer.from(" ")]));
    await fs.promises.writeFile(filePaths.index, Buffer.concat([fileBytes.index, Buffer.from(" ")]));

    const first = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    const second = await verifyProductionOriginMetadata({ manifestRecord, evidence });
    assert.deepEqual(second, first);
    assert.deepEqual(
      first.errors.map(({ code }) => code),
      [
        "origin-metadata-path-mismatch",
        "origin-metadata-path-mismatch",
        "origin-metadata-file-hash-mismatch",
        "origin-metadata-path-mismatch",
        "origin-metadata-file-hash-mismatch",
        "origin-metadata-content-mismatch",
        "origin-metadata-path-mismatch",
        "origin-metadata-content-mismatch",
        "origin-metadata-path-mismatch",
        "origin-metadata-file-hash-mismatch",
      ],
    );
    assert.deepEqual(first.gaps, []);
  });
});

test("D8a-1 rejects invalid UTF-8, invalid JSON, non-objects, and directory-valued metadata", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence, filePaths }) => {
    for (const bytes of [
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
      Buffer.from("{bad json\n", "utf8"),
      Buffer.from("[]\n", "utf8"),
      Buffer.from("null\n", "utf8"),
    ]) {
      await fs.promises.writeFile(filePaths.assessment, bytes);
      await assert.rejects(verifyProductionOriginMetadata({ manifestRecord, evidence }), TypeError);
    }

    await fs.promises.rm(filePaths.assessment);
    await fs.promises.mkdir(filePaths.assessment);
    await assert.rejects(
      verifyProductionOriginMetadata({ manifestRecord, evidence }),
      /assessments\.json must be a regular file/,
    );
  });
});

test("D8a-1 rejects injected parameters and malformed manifest record paths or hashes", async () => {
  await withProductionOriginMetadataFixture(async ({ manifestRecord, evidence }) => {
    for (const options of [
      null,
      { manifestRecord, evidence, rootDir: REPO_ROOT },
      { manifestRecord, evidence, reader: () => Buffer.from("{}") },
      { manifestRecord, evidence, [Symbol("injected")]: true },
    ]) {
      await assert.rejects(verifyProductionOriginMetadata(options), TypeError);
    }

    let getterCalls = 0;
    const accessorOptions = { evidence };
    Object.defineProperty(accessorOptions, "manifestRecord", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return manifestRecord;
      },
    });
    await assert.rejects(verifyProductionOriginMetadata(accessorOptions), TypeError);
    assert.equal(getterCalls, 0);

    for (const invalidRecord of [
      { ...manifestRecord, reader: () => Buffer.from("{}") },
      { ...manifestRecord, manifestPath: "../production-source-manifest.json" },
      { ...manifestRecord, manifestPath: "docs/validation/run\\production-source-manifest.json" },
      { ...manifestRecord, manifestPath: "docs/validation/run/other.json" },
      { ...manifestRecord, manifestFileSha256: "A".repeat(64) },
    ]) {
      await assert.rejects(verifyProductionOriginMetadata({ manifestRecord: invalidRecord, evidence }), TypeError);
    }
  });
});

test("D8a-1 rejects file symlinks when Windows permits creating them", async (t) => {
  await withProductionOriginMetadataFixture(async ({ testRoot, manifestRecord, evidence, filePaths, fileBytes }) => {
    const target = path.join(testRoot, "candidate-set-target.json");
    await fs.promises.writeFile(target, fileBytes.candidateSet);
    await fs.promises.rm(filePaths.candidateSet);
    try {
      await fs.promises.symlink(target, filePaths.candidateSet, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      verifyProductionOriginMetadata({ manifestRecord, evidence }),
      /candidates\.json must not be a symlink or junction/,
    );
  });
});

test("D8a-1 rejects an explicit capture-index junction that escapes docs/validation", async (t) => {
  await withProductionOriginMetadataFixture(async ({ testRoot, manifestRecord, evidence, fileBytes }) => {
    const outside = await fs.promises.mkdtemp(path.join(tmpdir(), "skin-palette-d8a1-outside-"));
    const junction = path.join(testRoot, "escaped-index-run");
    try {
      await fs.promises.writeFile(path.join(outside, "captures-index.fixture.json"), fileBytes.index);
      try {
        await fs.promises.symlink(outside, junction, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          t.skip(`directory junctions unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const escapedPath = path.join(junction, "captures-index.fixture.json");
      manifestRecord.manifest.origin.candidateCapturesIndex.path = path
        .relative(REPO_ROOT, escapedPath)
        .split(path.sep)
        .join("/");
      await assert.rejects(
        verifyProductionOriginMetadata({ manifestRecord, evidence }),
        /realpath escapes its verified directory/,
      );
    } finally {
      await fs.promises.rm(junction, { force: true });
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

test("D8b binds every candidate capture across runs to its manifest file and loader record", async () => {
  await withProductionOriginMetadataFixture(
    async ({ runDir, candidateSet, manifestRecord, evidence, capturePaths }) => {
      const ids = candidateSet.candidates.map(({ id }) => id);
      assert.equal(ids.length, 2);
      assert.equal(Object.keys(evidence.selections.record.choices).length, 1, "second capture is not selected");
      assert.notEqual(path.dirname(capturePaths[ids[0]]), runDir, "captures are allowed from another run");
      assert.notEqual(path.dirname(capturePaths[ids[0]]), path.dirname(capturePaths[ids[1]]));

      const before = structuredClone({ manifestRecord, evidence });
      assert.deepEqual(await verifyProductionOriginCaptures({ manifestRecord, evidence }), {
        status: "pass",
        errors: [],
        gaps: [],
      });
      assert.deepEqual({ manifestRecord, evidence }, before, "verification must not mutate its inputs");
    },
  );
});

test("D8b reports whitespace-only capture changes as raw-hash drift", async () => {
  await withProductionOriginMetadataFixture(
    async ({ candidateSet, manifestRecord, evidence, capturePaths, captureBytes }) => {
      const candidateId = candidateSet.candidates[0].id;
      await fs.promises.writeFile(
        capturePaths[candidateId],
        Buffer.concat([captureBytes[candidateId], Buffer.from(" ")]),
      );

      const result = await verifyProductionOriginCaptures({ manifestRecord, evidence });
      assert.equal(result.status, "rejected");
      assert.deepEqual(
        result.errors.map(({ code, candidateId: id }) => [code, id]),
        [["origin-capture-file-hash-mismatch", candidateId]],
      );
      assert.deepEqual(result.gaps, []);
    },
  );
});

test("D8b continues after a missing capture and reports errors from later candidates", async () => {
  await withProductionOriginMetadataFixture(
    async ({ candidateSet, manifestRecord, evidence, capturePaths, captureBytes }) => {
      const [missingId, changedId] = candidateSet.candidates.map(({ id }) => id);
      await fs.promises.rm(capturePaths[missingId]);
      await fs.promises.writeFile(capturePaths[changedId], Buffer.concat([captureBytes[changedId], Buffer.from("\n")]));

      const result = await verifyProductionOriginCaptures({ manifestRecord, evidence });
      assert.equal(result.status, "rejected");
      assert.deepEqual(
        result.gaps.map(({ code, candidateId }) => [code, candidateId]),
        [["origin-capture-file-missing", missingId]],
      );
      assert.deepEqual(
        result.errors.map(({ code, candidateId }) => [code, candidateId]),
        [["origin-capture-file-hash-mismatch", changedId]],
      );
    },
  );
});

test("D8b records missing loader, loader path drift, and parsed content drift without reading loader paths", async () => {
  await withProductionOriginMetadataFixture(async ({ testRoot, candidateSet, manifestRecord, evidence }) => {
    const [missingLoaderId, changedLoaderId] = candidateSet.candidates.map(({ id }) => id);
    delete evidence.captures[missingLoaderId];
    const untrustedDir = path.join(testRoot, "untrusted-loader-path");
    await fs.promises.mkdir(untrustedDir);
    await fs.promises.writeFile(path.join(untrustedDir, "capture.json"), "not JSON; must never be read\n");
    evidence.captures[changedLoaderId].dir = untrustedDir;
    evidence.captures[changedLoaderId].capture.loaderOnlyChange = true;

    const result = await verifyProductionOriginCaptures({ manifestRecord, evidence });
    assert.equal(result.status, "rejected");
    assert.deepEqual(
      result.errors.map(({ code, candidateId }) => [code, candidateId]),
      [
        ["origin-capture-path-mismatch", changedLoaderId],
        ["origin-capture-content-mismatch", changedLoaderId],
      ],
    );
    assert.deepEqual(
      result.gaps.map(({ code, candidateId }) => [code, candidateId]),
      [["origin-loaded-capture-missing", missingLoaderId]],
    );
  });
});

test("D8b checks sourceHashes canonical digests and preserves missing-source gaps", async () => {
  await withProductionOriginMetadataFixture(async ({ candidateSet, manifestRecord, evidence, capturePaths }) => {
    const [changedHashId, missingHashesId] = candidateSet.candidates.map(({ id }) => id);
    const changedCapture = {
      ...evidence.captures[changedHashId].capture,
      sourceHashes: { ...evidence.captures[changedHashId].capture.sourceHashes, "public/index.html": "f".repeat(64) },
    };
    const changedBytes = Buffer.from(`${JSON.stringify(changedCapture)}\n`, "utf8");
    await fs.promises.writeFile(capturePaths[changedHashId], changedBytes);
    manifestRecord.manifest.origin.captureRecords[changedHashId].fileSha256 = hashBytes(changedBytes);
    evidence.captures[changedHashId].capture = structuredClone(changedCapture);
    const withNullSourceHashes = { ...evidence.captures[missingHashesId].capture, sourceHashes: null };
    const nullBytes = Buffer.from(`${JSON.stringify(withNullSourceHashes)}\n`, "utf8");
    await fs.promises.writeFile(capturePaths[missingHashesId], nullBytes);
    manifestRecord.manifest.origin.captureRecords[missingHashesId].fileSha256 = hashBytes(nullBytes);
    evidence.captures[missingHashesId].capture = structuredClone(withNullSourceHashes);

    const result = await verifyProductionOriginCaptures({ manifestRecord, evidence });
    assert.equal(result.status, "rejected");
    assert.deepEqual(
      result.errors.map(({ code, candidateId }) => [code, candidateId]),
      [["origin-capture-source-hashes-hash-mismatch", changedHashId]],
    );
    assert.deepEqual(
      result.gaps.map(({ code, candidateId }) => [code, candidateId]),
      [["origin-capture-source-hashes-missing", missingHashesId]],
    );

    const withoutSourceHashes = { ...withNullSourceHashes };
    delete withoutSourceHashes.sourceHashes;
    const missingBytes = Buffer.from(`${JSON.stringify(withoutSourceHashes)}\n`, "utf8");
    await fs.promises.writeFile(capturePaths[missingHashesId], missingBytes);
    manifestRecord.manifest.origin.captureRecords[missingHashesId].fileSha256 = hashBytes(missingBytes);
    evidence.captures[missingHashesId].capture = structuredClone(withoutSourceHashes);
    const absentResult = await verifyProductionOriginCaptures({ manifestRecord, evidence });
    assert.equal(absentResult.status, "rejected");
    assert.deepEqual(
      absentResult.errors.map(({ code, candidateId }) => [code, candidateId]),
      [["origin-capture-source-hashes-hash-mismatch", changedHashId]],
    );
    assert.deepEqual(
      absentResult.gaps.map(({ code, candidateId }) => [code, candidateId]),
      [["origin-capture-source-hashes-missing", missingHashesId]],
    );
  });
});

test("D8b sorts unknown loader keys and preserves per-candidate diagnostic order", async () => {
  await withProductionOriginMetadataFixture(
    async ({ candidateSet, manifestRecord, evidence, capturePaths, captureBytes }) => {
      const [missingLoaderId, driftedId] = candidateSet.candidates.map(({ id }) => id);
      delete evidence.captures[missingLoaderId];
      evidence.captures["z-unknown"] = null;
      evidence.captures["a-unknown"] = null;
      evidence.captures[driftedId].dir = path.join(path.dirname(capturePaths[driftedId]), "wrong-dir");
      evidence.captures[driftedId].capture.loaderDrift = true;
      manifestRecord.manifest.origin.captureRecords[driftedId].sourceHashesHash = "e".repeat(64);
      await fs.promises.writeFile(capturePaths[driftedId], Buffer.concat([captureBytes[driftedId], Buffer.from(" ")]));

      const first = await verifyProductionOriginCaptures({ manifestRecord, evidence });
      assert.deepEqual(await verifyProductionOriginCaptures({ manifestRecord, evidence }), first);
      assert.deepEqual(
        first.errors.map(({ code, candidateId, path: capturePath }) => [code, candidateId, capturePath]),
        [
          [
            "origin-capture-path-mismatch",
            driftedId,
            manifestRecord.manifest.origin.captureRecords[driftedId].capturePath,
          ],
          [
            "origin-capture-file-hash-mismatch",
            driftedId,
            manifestRecord.manifest.origin.captureRecords[driftedId].capturePath,
          ],
          [
            "origin-capture-content-mismatch",
            driftedId,
            manifestRecord.manifest.origin.captureRecords[driftedId].capturePath,
          ],
          [
            "origin-capture-source-hashes-hash-mismatch",
            driftedId,
            manifestRecord.manifest.origin.captureRecords[driftedId].capturePath,
          ],
          ["origin-loaded-capture-unexpected", "a-unknown", null],
          ["origin-loaded-capture-unexpected", "z-unknown", null],
        ],
      );
      assert.deepEqual(
        first.gaps.map(({ code, candidateId }) => [code, candidateId]),
        [["origin-loaded-capture-missing", missingLoaderId]],
      );
      for (const diagnostic of [...first.errors, ...first.gaps]) {
        assert.deepEqual(Object.keys(diagnostic).sort(), ["candidateId", "code", "detail", "path"]);
      }
    },
  );
});

test("D8b rejects real-path aliases that bind two candidates to one capture file", async () => {
  await withProductionOriginMetadataFixture(
    async ({ candidateSet, manifestRecord, evidence, capturePaths, captureBytes, captureValues }) => {
      const [firstId, secondId] = candidateSet.candidates.map(({ id }) => id);
      const firstDir = path.dirname(capturePaths[firstId]);
      const secondDir = path.dirname(capturePaths[secondId]);
      await fs.promises.rm(secondDir, { recursive: true, force: true });
      try {
        await fs.promises.symlink(firstDir, secondDir, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          throw new Error(`D8b real-path alias junction could not be exercised: ${error.code}`, { cause: error });
        }
        throw error;
      }
      manifestRecord.manifest.origin.captureRecords[secondId].fileSha256 = hashBytes(captureBytes[firstId]);
      manifestRecord.manifest.origin.captureRecords[secondId].sourceHashesHash = sha256Canonical(
        captureValues[firstId].sourceHashes,
      );
      evidence.captures[secondId].dir = firstDir;
      evidence.captures[secondId].capture = structuredClone(captureValues[firstId]);

      try {
        const result = await verifyProductionOriginCaptures({ manifestRecord, evidence });
        assert.equal(result.status, "rejected");
        assert.deepEqual(
          result.errors.map(({ code, candidateId }) => [code, candidateId]),
          [["origin-capture-path-duplicate", secondId]],
        );
        assert.deepEqual(result.gaps, []);
      } finally {
        await fs.promises.rm(secondDir, { recursive: true, force: true });
      }
    },
  );
});

test("D8b rejects capture paths that escape through a real directory junction", async () => {
  await withProductionOriginMetadataFixture(
    async ({ testRoot, candidateSet, manifestRecord, evidence, captureValues }) => {
      const candidateId = candidateSet.candidates[0].id;
      const outside = await fs.promises.mkdtemp(path.join(tmpdir(), "skin-palette-d8b-outside-"));
      const junction = path.join(testRoot, "capture-escape");
      try {
        const bytes = Buffer.from(`${JSON.stringify(captureValues[candidateId])}\n`, "utf8");
        await fs.promises.writeFile(path.join(outside, "capture.json"), bytes);
        await fs.promises.symlink(outside, junction, "junction");
        const escapedFile = path.join(junction, "capture.json");
        manifestRecord.manifest.origin.captureRecords[candidateId].capturePath = path
          .relative(REPO_ROOT, escapedFile)
          .split(path.sep)
          .join("/");
        manifestRecord.manifest.origin.captureRecords[candidateId].fileSha256 = hashBytes(bytes);
        manifestRecord.manifest.origin.captureRecords[candidateId].sourceHashesHash = sha256Canonical(
          captureValues[candidateId].sourceHashes,
        );
        await assert.rejects(
          verifyProductionOriginCaptures({ manifestRecord, evidence }),
          /realpath escapes its verified directory/,
        );
      } finally {
        await fs.promises.rm(junction, { recursive: true, force: true });
        await fs.promises.rm(outside, { recursive: true, force: true });
      }
    },
  );
});

test("D8b rejects malformed capture bytes, non-object JSON, non-files, and invalid loader records", async () => {
  await withProductionOriginMetadataFixture(async ({ candidateSet, manifestRecord, evidence, capturePaths }) => {
    const candidateId = candidateSet.candidates[0].id;
    await assert.rejects(verifyProductionOriginCaptures({ manifestRecord, evidence, rootDir: REPO_ROOT }), TypeError);
    let manifestGetterCalls = 0;
    const accessorManifestRecord = { ...manifestRecord };
    Object.defineProperty(accessorManifestRecord, "manifest", {
      enumerable: true,
      get() {
        manifestGetterCalls += 1;
        return manifestRecord.manifest;
      },
    });
    await assert.rejects(
      verifyProductionOriginCaptures({ manifestRecord: accessorManifestRecord, evidence }),
      TypeError,
    );
    assert.equal(manifestGetterCalls, 0);

    for (const bytes of [
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
      Buffer.from("{broken JSON\n", "utf8"),
      Buffer.from("[]\n", "utf8"),
      Buffer.from("null\n", "utf8"),
    ]) {
      await fs.promises.writeFile(capturePaths[candidateId], bytes);
      await assert.rejects(verifyProductionOriginCaptures({ manifestRecord, evidence }), TypeError);
    }
    await fs.promises.rm(capturePaths[candidateId]);
    await fs.promises.mkdir(capturePaths[candidateId]);
    await assert.rejects(
      verifyProductionOriginCaptures({ manifestRecord, evidence }),
      /capture\.json must be a regular file/,
    );

    const originalLoader = evidence.captures[candidateId];
    let getterCalls = 0;
    const accessorLoader = { ...originalLoader };
    Object.defineProperty(accessorLoader, "dir", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return originalLoader.dir;
      },
    });
    const accessorEvidence = { ...evidence, captures: { ...evidence.captures, [candidateId]: accessorLoader } };
    await assert.rejects(verifyProductionOriginCaptures({ manifestRecord, evidence: accessorEvidence }), TypeError);
    assert.equal(getterCalls, 0);

    const badDirEvidence = structuredClone(evidence);
    badDirEvidence.captures[candidateId].dir = "relative/captures";
    await assert.rejects(verifyProductionOriginCaptures({ manifestRecord, evidence: badDirEvidence }), TypeError);

    await fs.promises.rm(capturePaths[candidateId], { recursive: true, force: true });
    const malformedSourceHashes = { ...evidence.captures[candidateId].capture, sourceHashes: [] };
    const malformedBytes = Buffer.from(`${JSON.stringify(malformedSourceHashes)}\n`, "utf8");
    await fs.promises.writeFile(capturePaths[candidateId], malformedBytes);
    manifestRecord.manifest.origin.captureRecords[candidateId].fileSha256 = hashBytes(malformedBytes);
    evidence.captures[candidateId].capture = structuredClone(malformedSourceHashes);
    await assert.rejects(
      verifyProductionOriginCaptures({ manifestRecord, evidence }),
      /capture\.json\.sourceHashes must be a JSON object/,
    );
  });
});

test("D8b rejects capture-file symlinks when Windows permits creating them", async (t) => {
  await withProductionOriginMetadataFixture(
    async ({ testRoot, candidateSet, manifestRecord, evidence, capturePaths }) => {
      const candidateId = candidateSet.candidates[0].id;
      const target = path.join(testRoot, "capture-symlink-target.json");
      await fs.promises.writeFile(target, await fs.promises.readFile(capturePaths[candidateId]));
      await fs.promises.rm(capturePaths[candidateId]);
      try {
        await fs.promises.symlink(target, capturePaths[candidateId], "file");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          t.skip(`file symlinks unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      await assert.rejects(
        verifyProductionOriginCaptures({ manifestRecord, evidence }),
        /capture\.json must not be a symlink or junction/,
      );
    },
  );
});

test("D9a combines D4a source construction with manifest and reader-shaped declarations", () => {
  const inputs = makeDeclaredSourceTransitionInputs();
  const before = copyDeclaredSourceTransitionInputs(inputs);

  const result = verifyProductionDeclaredSourceTransition(inputs);
  assert.deepEqual(result, { status: "pass", errors: [], gaps: [] });
  assert.deepEqual(inputs, before, "verification must preserve all input records and Buffers");
});

test("D9a reports precheck path and raw-summary mismatches before source diagnostics", () => {
  const inputs = makeDeclaredSourceTransitionInputs();
  inputs.preMigrationSources.precheckPath = "docs/validation/d9a/other-run/integration-precheck.json";
  inputs.preMigrationSources.precheckFileSha256 = "c".repeat(64);

  const result = verifyProductionDeclaredSourceTransition(inputs);
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.errors, [
    {
      code: "precheck-manifest-path-mismatch",
      path: inputs.preMigrationSources.precheckPath,
      detail: "integration-precheck.json and production-source-manifest.json must be in the same run directory",
    },
    {
      code: "precheck-manifest-binding-mismatch",
      path: inputs.preMigrationSources.precheckPath,
      detail: "precheckFileSha256 must match manifest.preMigration.precheck.fileSha256",
    },
  ]);
  assert.deepEqual(result.gaps, []);
});

test("D9a preserves D4a constructor errors for all three generated sources", () => {
  for (const file of SOURCE_PREIMAGE_FILES) {
    const inputs = makeDeclaredSourceTransitionInputs();
    const changed = Buffer.concat([inputs.currentSources.sourceBytes[file], Buffer.from("\n")]);
    inputs.currentSources.sourceBytes[file] = changed;
    const digest = hashBytes(changed);
    inputs.currentSources.sourceHashes[file] = digest;
    inputs.manifestRecord.manifest.after.sourceHashes[file] = digest;

    const result = verifyProductionDeclaredSourceTransition(inputs);
    assert.equal(result.status, "rejected", file);
    assert.deepEqual(
      result.errors.map(({ code, path }) => [code, path]),
      [["production-source-transition-mismatch", file]],
    );
    assert.deepEqual(result.gaps, []);
  }
});

test("D9a never permits changes to the other 28 sources even when both summaries follow them", () => {
  const inputs = makeDeclaredSourceTransitionInputs();
  const unchangedSources = SOURCE_FILES.filter((file) => !SOURCE_PREIMAGE_FILES.includes(file));
  assert.equal(unchangedSources.length, 28);
  assert.ok(unchangedSources.includes("public/timeline-utils.js"));

  for (const file of unchangedSources) {
    const candidate = copyDeclaredSourceTransitionInputs(inputs);
    const changed = Buffer.concat([candidate.currentSources.sourceBytes[file], Buffer.from("\n")]);
    candidate.currentSources.sourceBytes[file] = changed;
    const digest = hashBytes(changed);
    candidate.currentSources.sourceHashes[file] = digest;
    candidate.manifestRecord.manifest.after.sourceHashes[file] = digest;

    const result = verifyProductionDeclaredSourceTransition(candidate);
    assert.equal(result.status, "rejected", file);
    assert.deepEqual(
      result.errors.map(({ code, path }) => [code, path]),
      [["unexpected-source-transition", file]],
    );
    assert.deepEqual(result.gaps, []);
  }
});

test("D9a recomputes caller current hashes and binds selected assessment and record digests", () => {
  const inputs = makeDeclaredSourceTransitionInputs();
  const [currentHashFile, afterHashFile] = SOURCE_FILES;
  inputs.currentSources.sourceHashes[currentHashFile] = "c".repeat(64);
  inputs.manifestRecord.manifest.after.sourceHashes[afterHashFile] = "d".repeat(64);
  inputs.manifestRecord.manifest.origin.assessment.assessmentHash = "e".repeat(64);
  inputs.manifestRecord.manifest.origin.selections.recordHash = "f".repeat(64);

  const result = verifyProductionDeclaredSourceTransition(inputs);
  assert.equal(result.status, "rejected");
  assert.deepEqual(
    result.errors.map(({ code, path }) => [code, path]),
    [
      ["source-selection-assessment-mismatch", "selections.json"],
      ["source-selection-record-mismatch", "selections.json"],
      ["current-source-hash-mismatch", currentHashFile],
      ["source-after-manifest-mismatch", afterHashFile],
    ],
  );
  assert.deepEqual(result.gaps, []);
});

test("D9a aggregates precheck, D4a, selection, and source-summary diagnostics in fixed order", () => {
  const inputs = makeDeclaredSourceTransitionInputs();
  const d4aPath = "public/styles.css";
  const afterFile = SOURCE_FILES[0];
  const currentFile = SOURCE_FILES[1];
  inputs.preMigrationSources.precheckPath = "docs/validation/d9a/other-run/integration-precheck.json";
  inputs.preMigrationSources.precheckFileSha256 = "9".repeat(64);
  const changed = Buffer.concat([inputs.currentSources.sourceBytes[d4aPath], Buffer.from("\n")]);
  inputs.currentSources.sourceBytes[d4aPath] = changed;
  inputs.currentSources.sourceHashes[d4aPath] = hashBytes(changed);
  inputs.manifestRecord.manifest.after.sourceHashes[d4aPath] = hashBytes(changed);
  inputs.manifestRecord.manifest.origin.assessment.assessmentHash = "8".repeat(64);
  inputs.manifestRecord.manifest.origin.selections.recordHash = "7".repeat(64);
  inputs.currentSources.sourceHashes[currentFile] = "6".repeat(64);
  inputs.manifestRecord.manifest.after.sourceHashes[afterFile] = "5".repeat(64);

  const first = verifyProductionDeclaredSourceTransition(inputs);
  assert.deepEqual(verifyProductionDeclaredSourceTransition(inputs), first);
  assert.deepEqual(
    first.errors.map(({ code, path }) => [code, path]),
    [
      ["precheck-manifest-path-mismatch", inputs.preMigrationSources.precheckPath],
      ["precheck-manifest-binding-mismatch", inputs.preMigrationSources.precheckPath],
      ["unexpected-source-transition", d4aPath],
      ["source-selection-assessment-mismatch", "selections.json"],
      ["source-selection-record-mismatch", "selections.json"],
      ["source-after-manifest-mismatch", afterFile],
      ["current-source-hash-mismatch", currentFile],
    ],
  );
  assert.deepEqual(first.gaps, []);
  for (const diagnostic of first.errors) assert.deepEqual(Object.keys(diagnostic).sort(), ["code", "detail", "path"]);
});

test("D9a rejects malformed records, summaries, paths, and accessors without invoking them", () => {
  const valid = makeDeclaredSourceTransitionInputs();
  const invalid = [];
  invalid.push(null, [], { ...copyDeclaredSourceTransitionInputs(valid), extra: true });

  const extraPreMigration = copyDeclaredSourceTransitionInputs(valid);
  extraPreMigration.preMigrationSources.extra = true;
  invalid.push(extraPreMigration);
  const extraCurrent = copyDeclaredSourceTransitionInputs(valid);
  extraCurrent.currentSources.extra = true;
  invalid.push(extraCurrent);
  const extraManifestRecord = copyDeclaredSourceTransitionInputs(valid);
  extraManifestRecord.manifestRecord.extra = true;
  invalid.push(extraManifestRecord);
  const invalidManifestDigest = copyDeclaredSourceTransitionInputs(valid);
  invalidManifestDigest.manifestRecord.manifestFileSha256 = "A".repeat(64);
  invalid.push(invalidManifestDigest);
  const missingBeforeHash = copyDeclaredSourceTransitionInputs(valid);
  delete missingBeforeHash.preMigrationSources.sourceHashes["public/timeline-utils.js"];
  invalid.push(missingBeforeHash);
  const missingTimelineBytes = copyDeclaredSourceTransitionInputs(valid);
  delete missingTimelineBytes.currentSources.sourceBytes["public/timeline-utils.js"];
  invalid.push(missingTimelineBytes);
  const extraCurrentHash = copyDeclaredSourceTransitionInputs(valid);
  extraCurrentHash.currentSources.sourceHashes.extra = "a".repeat(64);
  invalid.push(extraCurrentHash);
  const invalidCurrentHash = copyDeclaredSourceTransitionInputs(valid);
  invalidCurrentHash.currentSources.sourceHashes[SOURCE_FILES[0]] = "A".repeat(64);
  invalid.push(invalidCurrentHash);
  const badRoot = copyDeclaredSourceTransitionInputs(valid);
  badRoot.currentSources.rootDir = "relative/root";
  invalid.push(badRoot);
  const urlRoot = copyDeclaredSourceTransitionInputs(valid);
  urlRoot.currentSources.rootDir = "https://example.invalid/root";
  invalid.push(urlRoot);
  const nulRoot = copyDeclaredSourceTransitionInputs(valid);
  nulRoot.currentSources.rootDir = `${path.parse(REPO_ROOT).root}\0bad`;
  invalid.push(nulRoot);
  const badPrecheckName = copyDeclaredSourceTransitionInputs(valid);
  badPrecheckName.preMigrationSources.precheckPath = "docs/validation/d9a/run/other.json";
  invalid.push(badPrecheckName);
  const badManifestPath = copyDeclaredSourceTransitionInputs(valid);
  badManifestPath.manifestRecord.manifestPath = "docs/validation/d9a/run/other.json";
  invalid.push(badManifestPath);
  const badModel = copyDeclaredSourceTransitionInputs(valid);
  badModel.verifiedModel.candidateSet.candidates[0].candidateHash = "0".repeat(64);
  invalid.push(badModel);

  for (const input of invalid) assert.throws(() => verifyProductionDeclaredSourceTransition(input), TypeError);

  let getterCalls = 0;
  const accessorOptions = { ...copyDeclaredSourceTransitionInputs(valid) };
  Object.defineProperty(accessorOptions, "selections", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return valid.selections;
    },
  });
  assert.throws(() => verifyProductionDeclaredSourceTransition(accessorOptions), TypeError);

  const accessorBeforeHashes = copyDeclaredSourceTransitionInputs(valid);
  Object.defineProperty(accessorBeforeHashes.preMigrationSources.sourceHashes, SOURCE_FILES[0], {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "a".repeat(64);
    },
  });
  assert.throws(() => verifyProductionDeclaredSourceTransition(accessorBeforeHashes), TypeError);

  const accessorManifest = copyDeclaredSourceTransitionInputs(valid);
  Object.defineProperty(accessorManifest.manifestRecord.manifest.origin, "runDir", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return valid.manifestRecord.manifest.origin.runDir;
    },
  });
  assert.throws(() => verifyProductionDeclaredSourceTransition(accessorManifest), TypeError);

  const accessorSelections = copyDeclaredSourceTransitionInputs(valid);
  Object.defineProperty(accessorSelections.selections.choices[SKIN_IDS[0]], "candidateId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return valid.selections.choices[SKIN_IDS[0]].candidateId;
    },
  });
  assert.throws(() => verifyProductionDeclaredSourceTransition(accessorSelections), TypeError);

  const accessorModel = copyDeclaredSourceTransitionInputs(valid);
  Object.defineProperty(accessorModel.verifiedModel, "candidateSet", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return valid.verifiedModel.candidateSet;
    },
  });
  assert.throws(() => verifyProductionDeclaredSourceTransition(accessorModel), TypeError);
  assert.equal(getterCalls, 0);
});

test("D9b reads actual manifest and before evidence, then preserves D5b as separate historical results", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence, sourceSnapshot, sourceHashes }) => {
    const evidenceBefore = JSON.stringify(evidence);
    const result = await readProductionHistoricalContext({ manifestRunDir, evidence });

    assert.deepEqual(Object.keys(result), [
      "manifestRecord",
      "preMigrationSources",
      "preMigrationAssets",
      "metadataResult",
      "capturesResult",
      "historicalEvidence",
    ]);
    const manifestRun = path.relative(REPO_ROOT, manifestRunDir).split(path.sep).join("/");
    assert.equal(result.manifestRecord.manifestPath, `${manifestRun}/production-source-manifest.json`);
    assert.notEqual(result.manifestRecord.manifest.origin.runDir, manifestRun);
    assert.equal(path.resolve(REPO_ROOT, ...result.manifestRecord.manifest.origin.runDir.split("/")), evidence.run.dir);
    assert.deepEqual(result.preMigrationSources.sourceHashes, sourceHashes);
    assert.deepEqual(result.preMigrationSources.sourceSnapshot, sourceSnapshot);
    assert.equal(result.preMigrationAssets.precheckFileSha256, result.preMigrationSources.precheckFileSha256);
    assert.equal(result.capturesResult.status, "pass");
    assert.equal(result.historicalEvidence.originResult.status, "pass");
    assert.equal(result.historicalEvidence.historicalResult.sourceContext, "historical");
    assert.notEqual(result.historicalEvidence.historicalResult.status, "invalid");
    assert.equal(result.historicalEvidence.assessmentBinding.status, "pass");
    assert.ok(result.metadataResult.gaps.some(({ code }) => code === "origin-metadata-file-missing"));
    assert.equal(Object.hasOwn(result, "status"), false, "D9b must not combine the six results into a PASS");
    assert.equal(JSON.stringify(evidence), evidenceBefore, "the loaded evidence must remain unchanged");
  });
});

test("D9b rejects a raw precheck hash mismatch", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, precheckPath, precheckBytes, evidence }) => {
    await fs.promises.writeFile(precheckPath, Buffer.concat([precheckBytes, Buffer.from(" ")]));
    await assert.rejects(
      readProductionHistoricalContext({ manifestRunDir, evidence }),
      /raw byte SHA-256 does not match/,
    );
  });
});

test("D9b rejects each absent fixed source preimage", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence }) => {
    for (const file of SOURCE_PREIMAGE_FILES) {
      const filePath = path.join(manifestRunDir, "source-before", ...file.split("/"));
      const bytes = await fs.promises.readFile(filePath);
      await fs.promises.rm(filePath);
      try {
        await assert.rejects(readProductionHistoricalContext({ manifestRunDir, evidence }), { code: "ENOENT" }, file);
      } finally {
        await fs.promises.writeFile(filePath, bytes);
      }
    }
  });
});

test("D9b preserves metadata/capture drift diagnostics and still returns historical results", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence, capturePaths, candidateSet }) => {
    const metadataPath = path.join(evidence.run.dir, "candidates.json");
    await fs.promises.appendFile(metadataPath, " ", "utf8");
    await fs.promises.appendFile(capturePaths[candidateSet.candidates[0].id], " ", "utf8");

    const result = await readProductionHistoricalContext({ manifestRunDir, evidence });
    assert.ok(result.metadataResult.errors.some((entry) => entry.code === "origin-metadata-file-hash-mismatch"));
    assert.ok(result.capturesResult.errors.some((entry) => entry.code === "origin-capture-file-hash-mismatch"));
    assert.equal(result.historicalEvidence.historicalResult.sourceContext, "historical");
    assert.notEqual(result.historicalEvidence.historicalResult.status, "invalid");
    assert.equal(result.historicalEvidence.originResult.status, "pass");
  });
});

test("D9b rejects injected options and evidence accessors without mutating the loader record", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence }) => {
    const before = JSON.stringify(evidence);
    for (const options of [
      null,
      [],
      { manifestRunDir, evidence, rootDir: REPO_ROOT },
      { manifestRunDir, evidence, reader: () => evidence },
    ]) {
      await assert.rejects(readProductionHistoricalContext(options), TypeError);
    }

    let getterCalls = 0;
    const accessorOptions = { evidence };
    Object.defineProperty(accessorOptions, "manifestRunDir", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return manifestRunDir;
      },
    });
    await assert.rejects(readProductionHistoricalContext(accessorOptions), TypeError);

    const accessorEvidence = { ...evidence };
    Object.defineProperty(accessorEvidence, "candidateSet", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return evidence.candidateSet;
      },
    });
    await assert.rejects(readProductionHistoricalContext({ manifestRunDir, evidence: accessorEvidence }), TypeError);

    const accessorCandidateSet = { ...evidence.candidateSet };
    Object.defineProperty(accessorCandidateSet, "data", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return evidence.candidateSet.data;
      },
    });
    await assert.rejects(
      readProductionHistoricalContext({
        manifestRunDir,
        evidence: { ...evidence, candidateSet: accessorCandidateSet },
      }),
      TypeError,
    );
    assert.equal(getterCalls, 0);
    assert.equal(JSON.stringify(evidence), before);
  });
});

function makeD9cFixture(historicalStatus = "pass") {
  const { evidence, historicalEvidence } = makeD5cHistoricalFixture(historicalStatus);
  const sourceBytes = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, ...file.split("/")))]),
  );
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, hashBytes(sourceBytes[file])]));
  const sourceSnapshot = Object.fromEntries(
    SOURCE_PREIMAGE_FILES.map((file) => [file, Buffer.from(sourceBytes[file])]),
  );
  const runPath = "docs/validation/m4-4-7-d9c/manifest-run";
  const manifest = makeProductionSourceManifest(evidence.candidateSet.data);
  manifest.after.sourceHashes = { ...sourceHashes };
  manifest.origin.assessment.assessmentHash = evidence.selections.record.assessmentHash;
  manifest.origin.selections.recordHash = sha256Canonical(evidence.selections.record);
  const precheckFileSha256 = manifest.preMigration.precheck.fileSha256;
  const oldAssets = makePreMigrationGeneratedAssets();

  return {
    evidence,
    historicalContext: {
      manifestRecord: {
        manifestPath: `${runPath}/production-source-manifest.json`,
        manifestFileSha256: "b".repeat(64),
        manifest,
      },
      preMigrationSources: {
        precheckPath: `${runPath}/integration-precheck.json`,
        precheckFileSha256,
        sourceHashes,
        sourceSnapshot,
      },
      preMigrationAssets: {
        precheckPath: `${runPath}/integration-precheck.json`,
        precheckFileSha256,
        generatedAssets: oldAssets,
      },
      metadataResult: { status: "pass", errors: [], gaps: [] },
      capturesResult: { status: "pass", errors: [], gaps: [] },
      historicalEvidence,
    },
  };
}

test("D9c gates the full historical selection, reads the default current root, and retains both transition results", async () => {
  const fixture = makeD9cFixture();
  const before = JSON.stringify(fixture);
  const result = await readProductionCurrentContext(fixture);

  assert.deepEqual(Object.keys(result), [
    "selectedCandidates",
    "currentSources",
    "currentAssets",
    "sourceTransition",
    "assetTransition",
  ]);
  assert.equal(result.selectedCandidates.length, SKIN_IDS.length);
  assert.deepEqual(
    result.selectedCandidates.map(({ selectionBinding }) => selectionBinding.skinId),
    SKIN_IDS,
  );
  assert.equal(path.resolve(result.currentSources.rootDir), path.resolve(REPO_ROOT));
  assert.deepEqual(Object.keys(result.currentSources.sourceBytes).sort(), [...SOURCE_FILES].sort());
  for (const file of SOURCE_FILES) {
    const bytes = result.currentSources.sourceBytes[file];
    assert.ok(Buffer.isBuffer(bytes), file);
    assert.equal(result.currentSources.sourceHashes[file], hashBytes(bytes), file);
    assert.deepEqual(bytes, await fs.promises.readFile(path.join(REPO_ROOT, ...file.split("/"))), file);
  }

  const assets = enumerateSourceAssets();
  assert.equal(assets.length, 40);
  assert.equal(Object.keys(result.currentAssets.sourceAssetHashes).length, 40);
  assert.equal(Object.keys(result.currentAssets.publicAssetHashes).length, 40);
  for (const asset of assets) {
    assert.equal(
      result.currentAssets.sourceAssetHashes[asset.sourcePath],
      hashBytes(await fs.promises.readFile(path.join(REPO_ROOT, ...asset.sourcePath.split("/")))),
      asset.sourcePath,
    );
    assert.equal(
      result.currentAssets.publicAssetHashes[asset.publicPath],
      hashBytes(await fs.promises.readFile(path.join(REPO_ROOT, ...asset.publicPath.split("/")))),
      asset.publicPath,
    );
  }
  assert.equal(result.sourceTransition.status, "rejected", "synthetic candidate history must not be declared applied");
  assert.ok(result.sourceTransition.errors.length > 0);
  assert.equal(result.assetTransition.status, "rejected", "synthetic old asset hashes must remain diagnostics");
  assert.ok(result.assetTransition.errors.length > 0);
  assert.equal(Object.hasOwn(result, "status"), false, "D9c must not combine transitions into an overall PASS");
  assert.equal(JSON.stringify(fixture), before, "the supplied evidence and historical context must remain unchanged");
});

test("D9c allows an unselected readiness failure while the selected ten remain eligible", async () => {
  const fixture = makeD9cFixture("rejected");
  const result = await readProductionCurrentContext(fixture);
  assert.equal(result.selectedCandidates.length, SKIN_IDS.length);
  assert.deepEqual(
    result.selectedCandidates.map(({ selectionBinding }) => selectionBinding.candidateId),
    SKIN_IDS.map((skinId) => fixture.evidence.selections.record.choices[skinId].candidateId),
  );
});

test("D9c rejects dirty source gates, incomplete/invalid selections, and failed historical summaries", async () => {
  const cases = [
    ["metadata incomplete", (fixture) => (fixture.historicalContext.metadataResult.status = "incomplete")],
    ["capture error", (fixture) => fixture.historicalContext.capturesResult.errors.push({ code: "drift" })],
    ["capture gap", (fixture) => fixture.historicalContext.capturesResult.gaps.push({ code: "missing" })],
    ["selection missing", (fixture) => delete fixture.evidence.selections.record.choices[SKIN_IDS[0]]],
    [
      "selection hash mismatch",
      (fixture) => (fixture.evidence.selections.record.choices[SKIN_IDS[0]].candidateHash = "f".repeat(64)),
    ],
    [
      "historical origin rejected",
      (fixture) => (fixture.historicalContext.historicalEvidence.originResult.status = "rejected"),
    ],
    [
      "historical summary error",
      (fixture) => fixture.historicalContext.historicalEvidence.historicalResult.errors.push({ code: "drift" }),
    ],
  ];

  for (const [label, mutate] of cases) {
    const fixture = makeD9cFixture();
    mutate(fixture);
    await assert.rejects(readProductionCurrentContext(fixture), TypeError, label);
  }
});

test("D9c snapshots JSON and Buffer inputs before its first asynchronous read", async () => {
  const fixture = makeD9cFixture();
  const candidateId = fixture.evidence.selections.record.choices[SKIN_IDS[0]].candidateId;
  const preimage = fixture.historicalContext.preMigrationSources.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]];
  const pending = readProductionCurrentContext(fixture);

  fixture.evidence.selections.record.choices[SKIN_IDS[0]].candidateHash = "f".repeat(64);
  fixture.historicalContext.historicalEvidence.historicalResult.verifiedModel.candidateSet.candidateSetHash =
    "e".repeat(64);
  fixture.historicalContext.manifestRecord.manifest.after.sourceHashes[SOURCE_FILES[0]] = "d".repeat(64);
  preimage.fill(0);

  const result = await pending;
  assert.equal(result.selectedCandidates[0].candidate.id, candidateId);
  assert.equal(
    result.sourceTransition.errors.some(({ code }) => code === "source-preimage-mismatch"),
    false,
    "the pre-await Buffer copy must remain intact",
  );
});

test("D9c rejects injected fields and accessors without invoking getters or mutating inputs", async () => {
  const fixture = makeD9cFixture();
  const before = JSON.stringify(fixture);
  for (const options of [null, [], { ...fixture, rootDir: REPO_ROOT }, { ...fixture, reader: () => ({}) }]) {
    await assert.rejects(readProductionCurrentContext(options), TypeError);
  }

  let getterCalls = 0;
  const accessorOptions = { evidence: fixture.evidence };
  Object.defineProperty(accessorOptions, "historicalContext", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.historicalContext;
    },
  });
  await assert.rejects(readProductionCurrentContext(accessorOptions), TypeError);

  const accessorEvidence = { ...fixture.evidence };
  Object.defineProperty(accessorEvidence, "candidateSet", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.evidence.candidateSet;
    },
  });
  await assert.rejects(
    readProductionCurrentContext({ historicalContext: fixture.historicalContext, evidence: accessorEvidence }),
    TypeError,
  );

  const accessorSnapshot = { ...fixture.historicalContext.preMigrationSources.sourceSnapshot };
  Object.defineProperty(accessorSnapshot, SOURCE_PREIMAGE_FILES[0], {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.historicalContext.preMigrationSources.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]];
    },
  });
  const accessorSources = { ...fixture.historicalContext.preMigrationSources, sourceSnapshot: accessorSnapshot };
  await assert.rejects(
    readProductionCurrentContext({
      evidence: fixture.evidence,
      historicalContext: { ...fixture.historicalContext, preMigrationSources: accessorSources },
    }),
    TypeError,
  );

  await assert.rejects(
    readProductionCurrentContext({
      evidence: fixture.evidence,
      historicalContext: { ...fixture.historicalContext, extra: true },
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(fixture), before);
});

async function withD9dFixture(callback) {
  await withProductionHistoricalContextFixture(async (fixture) => {
    const historicalContext = await readProductionHistoricalContext({
      manifestRunDir: fixture.manifestRunDir,
      evidence: fixture.evidence,
    });
    await callback({ ...fixture, historicalContext });
  });
}

test("D9d-1 re-reads saved origin evidence and preserves the original missing-selection gap", async () => {
  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext }) => {
    const before = JSON.stringify({ evidence, historicalContext });
    const result = await verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
    assert.deepEqual(Object.keys(result), ["status", "errors", "gaps"]);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.errors, []);
    assert.ok(result.gaps.some(({ code }) => code === "origin-loaded-selections-missing"));
    assert.equal(JSON.stringify({ evidence, historicalContext }), before);
  });
});

test("D9d-1 compares the manifest raw digest and reports a moved manifest run", async () => {
  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext, manifestFilePath }) => {
    await fs.promises.appendFile(manifestFilePath, " ", "utf8");
    const changed = await verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
    assert.equal(changed.status, "rejected");
    assert.deepEqual(
      changed.errors.map(({ code }) => code),
      ["origin-manifest-file-changed"],
    );
  });

  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext, testRoot }) => {
    const movedManifestRunDir = path.join(testRoot, "copied-manifest-run");
    await fs.promises.cp(manifestRunDir, movedManifestRunDir, { recursive: true });
    const moved = await verifyProductionOriginStability({
      manifestRunDir: movedManifestRunDir,
      evidence,
      historicalContext,
    });
    assert.equal(moved.status, "rejected");
    assert.ok(moved.errors.some(({ code }) => code === "origin-manifest-path-changed"));
    assert.ok(moved.errors.some(({ code }) => code === "origin-pre-migration-sources-changed"));
    assert.ok(moved.errors.some(({ code }) => code === "origin-pre-migration-assets-changed"));
  });
});

test("D9d-1 lets the original readers reject changed precheck bytes or any fixed preimage", async () => {
  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext, precheckPath, precheckBytes }) => {
    await fs.promises.writeFile(precheckPath, Buffer.concat([precheckBytes, Buffer.from(" ")]));
    await assert.rejects(
      verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext }),
      /raw byte SHA-256 does not match/,
    );
  });

  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext }) => {
    for (const file of SOURCE_PREIMAGE_FILES) {
      const filePath = path.join(manifestRunDir, "source-before", ...file.split("/"));
      const bytes = await fs.promises.readFile(filePath);
      await fs.promises.writeFile(filePath, Buffer.concat([bytes, Buffer.from(" ")]));
      try {
        await assert.rejects(
          verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext }),
          /raw byte SHA-256 does not match integration-precheck\.json/,
          file,
        );
      } finally {
        await fs.promises.writeFile(filePath, bytes);
      }
    }
  });
});

test("D9d-1 never lets a new valid manifest authorize changed precheck or capture bytes", async () => {
  await withD9dFixture(
    async ({ manifestRunDir, evidence, historicalContext, manifestFilePath, precheckPath, precheckBytes }) => {
      const changedPrecheck = Buffer.concat([precheckBytes, Buffer.from(" ")]);
      await fs.promises.writeFile(precheckPath, changedPrecheck);
      const manifest = JSON.parse(await fs.promises.readFile(manifestFilePath, "utf8"));
      manifest.preMigration.precheck.fileSha256 = hashBytes(changedPrecheck);
      await fs.promises.writeFile(manifestFilePath, `${JSON.stringify(manifest)}\n`, "utf8");
      await assert.rejects(
        verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext }),
        /raw byte SHA-256 does not match/,
        "D2b must use the saved D9b digest rather than a new manifest declaration",
      );
    },
  );

  await withD9dFixture(
    async ({
      manifestRunDir,
      evidence,
      historicalContext,
      manifestFilePath,
      filePaths,
      capturePaths,
      candidateSet,
    }) => {
      const candidateId = candidateSet.candidates[0].id;
      const candidateBytes = Buffer.concat([await fs.promises.readFile(filePaths.candidateSet), Buffer.from(" ")]);
      const captureBytes = Buffer.concat([await fs.promises.readFile(capturePaths[candidateId]), Buffer.from(" ")]);
      await Promise.all([
        fs.promises.writeFile(filePaths.candidateSet, candidateBytes),
        fs.promises.writeFile(capturePaths[candidateId], captureBytes),
      ]);
      const manifest = JSON.parse(await fs.promises.readFile(manifestFilePath, "utf8"));
      manifest.origin.candidateSet.fileSha256 = hashBytes(candidateBytes);
      manifest.origin.captureRecords[candidateId].fileSha256 = hashBytes(captureBytes);
      await fs.promises.writeFile(manifestFilePath, `${JSON.stringify(manifest)}\n`, "utf8");

      const result = await verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
      assert.equal(result.status, "rejected");
      assert.ok(result.errors.some(({ code }) => code === "origin-manifest-file-changed"));
      assert.ok(
        result.errors.some(
          ({ code, path: itemPath }) =>
            code === "origin-metadata-file-hash-mismatch" && itemPath.endsWith("/candidates.json"),
        ),
      );
      assert.ok(
        result.errors.some(
          ({ code, candidateId: id }) => code === "origin-capture-file-hash-mismatch" && id === candidateId,
        ),
      );
    },
  );
});

test("D9d-1 records saved before-record drift without using changed values to authorize it", async () => {
  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext }) => {
    historicalContext.preMigrationSources.sourceHashes[SOURCE_FILES[0]] = "f".repeat(64);
    historicalContext.preMigrationSources.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]].fill(0);
    historicalContext.preMigrationAssets.generatedAssets.sourceAssetHashes[enumerateSourceAssets()[0].sourcePath] =
      "e".repeat(64);

    const result = await verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
    assert.equal(result.status, "rejected");
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      ["origin-pre-migration-sources-changed", "origin-pre-migration-assets-changed"],
    );
    assert.ok(result.errors.every(({ path }) => path === historicalContext.preMigrationSources.precheckPath));
  });
});

test("D9d-1 rechecks metadata and captures independently and preserves both raw-drift diagnostics", async () => {
  await withD9dFixture(
    async ({
      manifestRunDir,
      evidence,
      historicalContext,
      filePaths,
      capturesIndexPath,
      capturePaths,
      candidateSet,
    }) => {
      const candidateId = candidateSet.candidates[0].id;
      await Promise.all([
        fs.promises.appendFile(filePaths.candidateSet, " "),
        fs.promises.appendFile(filePaths.assessment, " "),
        fs.promises.appendFile(capturesIndexPath, " "),
        fs.promises.appendFile(capturePaths[candidateId], " "),
      ]);

      const result = await verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
      assert.equal(result.status, "rejected");
      const metadataPaths = new Set([
        `${historicalContext.manifestRecord.manifest.origin.runDir}/candidates.json`,
        `${historicalContext.manifestRecord.manifest.origin.runDir}/assessments.json`,
        historicalContext.manifestRecord.manifest.origin.candidateCapturesIndex.path,
      ]);
      assert.equal(
        result.errors.filter(
          ({ code, path: itemPath }) => code === "origin-metadata-file-hash-mismatch" && metadataPaths.has(itemPath),
        ).length,
        3,
      );
      assert.ok(
        result.errors.some(
          ({ code, candidateId: id }) => code === "origin-capture-file-hash-mismatch" && id === candidateId,
        ),
      );
      assert.ok(result.gaps.some(({ code }) => code === "origin-loaded-selections-missing"));
    },
  );
});

test("D9d-1 snapshots only used inputs before the first read and rejects injected fields or accessors", async () => {
  await withD9dFixture(async ({ manifestRunDir, evidence: loadedEvidence, historicalContext }) => {
    const evidence = structuredClone(loadedEvidence);
    const originalCandidateSetHash = evidence.candidateSet.data.candidateSetHash;
    const sourceBuffer = historicalContext.preMigrationSources.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]];
    const pending = verifyProductionOriginStability({ manifestRunDir, evidence, historicalContext });
    evidence.candidateSet.data.candidateSetHash = "f".repeat(64);
    historicalContext.preMigrationSources.sourceHashes[SOURCE_FILES[0]] = "e".repeat(64);
    sourceBuffer.fill(0);

    const result = await pending;
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.errors, []);
    assert.equal(evidence.candidateSet.data.candidateSetHash, "f".repeat(64));
    assert.equal(originalCandidateSetHash, loadedEvidence.candidateSet.data.candidateSetHash);
  });

  await withD9dFixture(async ({ manifestRunDir, evidence, historicalContext }) => {
    let getterCalls = 0;
    for (const options of [
      null,
      [],
      { manifestRunDir, evidence, historicalContext, rootDir: REPO_ROOT },
      { manifestRunDir, evidence, historicalContext, reader: () => ({}) },
    ]) {
      await assert.rejects(verifyProductionOriginStability(options), TypeError);
    }

    const accessorOptions = { evidence, historicalContext };
    Object.defineProperty(accessorOptions, "manifestRunDir", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return manifestRunDir;
      },
    });
    await assert.rejects(verifyProductionOriginStability(accessorOptions), TypeError);

    const accessorEvidence = { ...evidence };
    Object.defineProperty(accessorEvidence, "candidateSet", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return evidence.candidateSet;
      },
    });
    await assert.rejects(
      verifyProductionOriginStability({ manifestRunDir, evidence: accessorEvidence, historicalContext }),
      TypeError,
    );

    const accessorSourceSnapshot = { ...historicalContext.preMigrationSources.sourceSnapshot };
    Object.defineProperty(accessorSourceSnapshot, SOURCE_PREIMAGE_FILES[0], {
      enumerable: true,
      get() {
        getterCalls += 1;
        return historicalContext.preMigrationSources.sourceSnapshot[SOURCE_PREIMAGE_FILES[0]];
      },
    });
    await assert.rejects(
      verifyProductionOriginStability({
        manifestRunDir,
        evidence,
        historicalContext: {
          ...historicalContext,
          preMigrationSources: { ...historicalContext.preMigrationSources, sourceSnapshot: accessorSourceSnapshot },
        },
      }),
      TypeError,
    );
    await assert.rejects(
      verifyProductionOriginStability({
        manifestRunDir,
        evidence,
        historicalContext: { ...historicalContext, extra: true },
      }),
      TypeError,
    );
    assert.equal(getterCalls, 0);
  });
});

async function readCurrentStabilitySample() {
  return {
    currentSources: await readProductionCurrentSources(),
    currentAssets: await readProductionGeneratedAssets(),
  };
}

function cloneCurrentStabilitySample(sample) {
  return {
    currentSources: {
      rootDir: sample.currentSources.rootDir,
      sourceBytes: Object.fromEntries(
        SOURCE_FILES.map((file) => [file, Buffer.from(sample.currentSources.sourceBytes[file])]),
      ),
      sourceHashes: { ...sample.currentSources.sourceHashes },
    },
    currentAssets: {
      rootDir: sample.currentAssets.rootDir,
      assetManifestBytes: Buffer.from(sample.currentAssets.assetManifestBytes),
      assetManifestSha256: sample.currentAssets.assetManifestSha256,
      sourceAssetHashes: { ...sample.currentAssets.sourceAssetHashes },
      publicAssetHashes: { ...sample.currentAssets.publicAssetHashes },
      toolHashes: { ...sample.currentAssets.toolHashes },
    },
  };
}

test("D9d-2 passes unchanged samples from the actual default readers", async () => {
  const sample = await readCurrentStabilitySample();
  const before = JSON.stringify(sample);

  assert.deepEqual(await verifyProductionCurrentStability(sample), { status: "pass", errors: [], gaps: [] });
  assert.equal(JSON.stringify(sample), before);
});

test("D9d-2 aggregates start inconsistencies and all current-file drift in fixed order", async () => {
  const sample = cloneCurrentStabilitySample(await readCurrentStabilitySample());
  const wrongRoot = path.join(REPO_ROOT, "docs");
  const assets = enumerateSourceAssets();
  const sourceFile = SOURCE_FILES[0];
  const consistentChangedSourceFile = SOURCE_FILES[1];
  const firstAsset = assets[0];

  sample.currentSources.rootDir = wrongRoot;
  sample.currentAssets.rootDir = wrongRoot;
  sample.currentSources.sourceBytes[sourceFile].fill(0);
  sample.currentSources.sourceBytes[consistentChangedSourceFile].fill(1);
  sample.currentSources.sourceHashes[consistentChangedSourceFile] = hashBytes(
    sample.currentSources.sourceBytes[consistentChangedSourceFile],
  );
  sample.currentAssets.assetManifestBytes = Buffer.concat([sample.currentAssets.assetManifestBytes, Buffer.from(" ")]);
  sample.currentAssets.sourceAssetHashes[firstAsset.sourcePath] = "f".repeat(64);
  sample.currentAssets.publicAssetHashes[firstAsset.publicPath] = "e".repeat(64);
  sample.currentAssets.toolHashes[GENERATED_ASSET_TOOL_FILES[0]] = "d".repeat(64);
  const before = JSON.stringify(sample);

  const result = await verifyProductionCurrentStability(sample);
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(
    result.errors.map(({ code, path: itemPath }) => [code, itemPath]),
    [
      ["current-start-source-hash-mismatch", sourceFile],
      ["current-start-asset-manifest-hash-mismatch", "public/skin-assets.json"],
      ["current-source-root-changed", wrongRoot],
      ["current-asset-root-changed", wrongRoot],
      ["current-source-file-changed", sourceFile],
      ["current-source-file-changed", consistentChangedSourceFile],
      ["current-asset-manifest-file-changed", "public/skin-assets.json"],
      ["current-source-asset-file-changed", firstAsset.sourcePath],
      ["current-public-asset-file-changed", firstAsset.publicPath],
      ["current-production-tool-file-changed", GENERATED_ASSET_TOOL_FILES[0]],
    ],
  );
  assert.equal(JSON.stringify(sample), before);
});

test("D9d-2 snapshots caller data before awaiting default end readers", async () => {
  const sample = cloneCurrentStabilitySample(await readCurrentStabilitySample());
  const pending = verifyProductionCurrentStability(sample);

  sample.currentSources.rootDir = path.join(REPO_ROOT, "docs");
  sample.currentSources.sourceBytes[SOURCE_FILES[0]].fill(0);
  sample.currentSources.sourceHashes[SOURCE_FILES[0]] = "f".repeat(64);
  sample.currentAssets.rootDir = path.join(REPO_ROOT, "docs");
  sample.currentAssets.assetManifestBytes.fill(0);
  sample.currentAssets.assetManifestSha256 = "e".repeat(64);
  sample.currentAssets.sourceAssetHashes[enumerateSourceAssets()[0].sourcePath] = "d".repeat(64);
  sample.currentAssets.publicAssetHashes[enumerateSourceAssets()[0].publicPath] = "c".repeat(64);
  sample.currentAssets.toolHashes[GENERATED_ASSET_TOOL_FILES[0]] = "b".repeat(64);

  assert.deepEqual(await pending, { status: "pass", errors: [], gaps: [] });
});

test("D9d-2 rejects malformed fields, sparse maps, accessors, and non-Buffer byte inputs", async () => {
  const sample = await readCurrentStabilitySample();
  const invalid = [
    ["non-object options", () => null],
    ["extra option", () => ({ ...cloneCurrentStabilitySample(sample), rootDir: REPO_ROOT })],
    [
      "relative source root",
      () => ({ ...cloneCurrentStabilitySample(sample), currentSources: { ...sample.currentSources, rootDir: "docs" } }),
    ],
    [
      "URL asset root",
      () => ({
        ...cloneCurrentStabilitySample(sample),
        currentAssets: { ...sample.currentAssets, rootDir: "file:///repo" },
      }),
    ],
    [
      "missing source hash",
      () => {
        const value = cloneCurrentStabilitySample(sample);
        delete value.currentSources.sourceHashes[SOURCE_FILES[0]];
        return value;
      },
    ],
    [
      "missing asset hash",
      () => {
        const value = cloneCurrentStabilitySample(sample);
        delete value.currentAssets.publicAssetHashes[enumerateSourceAssets()[0].publicPath];
        return value;
      },
    ],
    [
      "source byte is not Buffer",
      () => {
        const value = cloneCurrentStabilitySample(sample);
        value.currentSources.sourceBytes[SOURCE_FILES[0]] = new Uint8Array([1]);
        return value;
      },
    ],
    [
      "manifest byte is not Buffer",
      () => {
        const value = cloneCurrentStabilitySample(sample);
        value.currentAssets.assetManifestBytes = new Uint8Array([1]);
        return value;
      },
    ],
  ];

  for (const [label, makeInput] of invalid) {
    const input = makeInput();
    const before = JSON.stringify(input);
    await assert.rejects(verifyProductionCurrentStability(input), TypeError, label);
    assert.equal(JSON.stringify(input), before, label);
  }

  let getterCalls = 0;
  const accessorSourceBytes = { ...sample.currentSources.sourceBytes };
  Object.defineProperty(accessorSourceBytes, SOURCE_FILES[0], {
    enumerable: true,
    get() {
      getterCalls += 1;
      return sample.currentSources.sourceBytes[SOURCE_FILES[0]];
    },
  });
  await assert.rejects(
    verifyProductionCurrentStability({
      currentSources: { ...sample.currentSources, sourceBytes: accessorSourceBytes },
      currentAssets: sample.currentAssets,
    }),
    TypeError,
  );

  const accessorOptions = { currentSources: sample.currentSources, currentAssets: sample.currentAssets };
  Object.defineProperty(accessorOptions, "currentAssets", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return sample.currentAssets;
    },
  });
  await assert.rejects(verifyProductionCurrentStability(accessorOptions), TypeError);
  assert.equal(getterCalls, 0);
});

test("D9e builds history internally, skips current selection on source gaps, and still runs origin stability", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence }) => {
    const before = JSON.stringify(evidence);
    const result = await verifyProductionSourceContext({ manifestRunDir, evidence });

    assert.deepEqual(Object.keys(result), [
      "status",
      "errors",
      "gaps",
      "historicalContext",
      "currentContext",
      "originStability",
      "currentStability",
    ]);
    assert.equal(result.status, "incomplete");
    assert.equal(result.currentContext, null);
    assert.equal(result.currentStability, null);
    assert.deepEqual(Object.keys(result.historicalContext), [
      "manifestRecord",
      "preMigrationSources",
      "preMigrationAssets",
      "metadataResult",
      "capturesResult",
      "historicalEvidence",
    ]);
    assert.ok(result.gaps.some(({ code }) => code === "origin-metadata-file-missing"));
    assert.ok(result.originStability.gaps.some(({ code }) => code === "origin-loaded-selections-missing"));
    assert.equal(JSON.stringify(evidence), before);
  });
});

test("D9e preserves initial and ending metadata/capture drift without dropping duplicate diagnostics", async () => {
  await withProductionHistoricalContextFixture(
    async ({ manifestRunDir, evidence, filePaths, capturePaths, candidateSet }) => {
      const candidateId = candidateSet.candidates[0].id;
      await Promise.all([
        fs.promises.appendFile(filePaths.candidateSet, " "),
        fs.promises.appendFile(capturePaths[candidateId], " "),
      ]);

      const result = await verifyProductionSourceContext({ manifestRunDir, evidence });
      assert.equal(result.status, "rejected");
      assert.equal(result.currentContext, null);
      assert.equal(result.currentStability, null);
      assert.deepEqual(
        result.errors
          .filter(({ code }) =>
            ["origin-metadata-file-hash-mismatch", "origin-capture-file-hash-mismatch"].includes(code),
          )
          .map(({ code }) => code),
        [
          "origin-metadata-file-hash-mismatch",
          "origin-capture-file-hash-mismatch",
          "origin-metadata-file-hash-mismatch",
          "origin-capture-file-hash-mismatch",
        ],
      );
      assert.equal(result.errors.filter(({ code }) => code === "origin-metadata-file-hash-mismatch").length, 2);
      assert.equal(
        result.errors.filter(
          ({ code, candidateId: id }) => code === "origin-capture-file-hash-mismatch" && id === candidateId,
        ).length,
        2,
      );
      assert.ok(result.originStability.errors.some(({ code }) => code === "origin-metadata-file-hash-mismatch"));
      assert.ok(
        result.originStability.errors.some(
          ({ code, candidateId: id }) => code === "origin-capture-file-hash-mismatch" && id === candidateId,
        ),
      );
    },
  );
});

test("D9e propagates raw precheck and fixed-preimage failures from the original readers", async () => {
  await withProductionHistoricalContextFixture(
    async ({ manifestRunDir, evidence, precheckPath, precheckBytes, sourceSnapshot }) => {
      const files = [
        [precheckPath, precheckBytes],
        ...SOURCE_PREIMAGE_FILES.map((file) => [
          path.join(manifestRunDir, "source-before", ...file.split("/")),
          sourceSnapshot[file],
        ]),
      ];
      for (const [filePath, bytes] of files) {
        await fs.promises.writeFile(filePath, Buffer.concat([bytes, Buffer.from(" ")]));
        try {
          await assert.rejects(
            verifyProductionSourceContext({ manifestRunDir, evidence }),
            /raw byte SHA-256 does not match/,
            filePath,
          );
        } finally {
          await fs.promises.writeFile(filePath, bytes);
        }
      }
    },
  );
});

test("D9e snapshots options/evidence before the first read and rejects injected fields or accessors", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence: loadedEvidence }) => {
    const evidence = structuredClone(loadedEvidence);
    const originalCandidateSetHash = evidence.candidateSet.data.candidateSetHash;
    const pending = verifyProductionSourceContext({ manifestRunDir, evidence });
    evidence.candidateSet.data.candidateSetHash = "f".repeat(64);

    const result = await pending;
    assert.equal(
      result.historicalContext.manifestRecord.manifest.origin.candidateSet.candidateSetHash,
      originalCandidateSetHash,
    );
    assert.notEqual(evidence.candidateSet.data.candidateSetHash, originalCandidateSetHash);
  });

  await withProductionHistoricalContextFixture(async ({ manifestRunDir, evidence }) => {
    let getterCalls = 0;
    for (const options of [
      null,
      [],
      { manifestRunDir, evidence, rootDir: REPO_ROOT },
      { manifestRunDir, evidence, historicalContext: {} },
      { manifestRunDir, evidence, reader: () => ({}) },
    ]) {
      await assert.rejects(verifyProductionSourceContext(options), TypeError);
    }

    const accessorOptions = { evidence };
    Object.defineProperty(accessorOptions, "manifestRunDir", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return manifestRunDir;
      },
    });
    await assert.rejects(verifyProductionSourceContext(accessorOptions), TypeError);

    const accessorEvidence = { ...evidence };
    Object.defineProperty(accessorEvidence, "candidateSet", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return evidence.candidateSet;
      },
    });
    await assert.rejects(verifyProductionSourceContext({ manifestRunDir, evidence: accessorEvidence }), TypeError);
    assert.equal(getterCalls, 0);
  });
});

test("E1 returns the full source gate and never reads the formal index on an incomplete source result", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, runDir, evidence }) => {
    const capturesIndexFile = path.join(runDir, "captures-index-e1-malformed.json");
    const capturesIndexPath = path.relative(REPO_ROOT, capturesIndexFile);
    const malformedBytes = Buffer.from("{invalid json\n", "utf8");
    await fs.promises.writeFile(capturesIndexFile, malformedBytes);
    const before = JSON.stringify(evidence);

    const result = await verifyProductionReviewEvidence({ manifestRunDir, evidence, capturesIndexPath });

    assert.deepEqual(Object.keys(result), [
      "status",
      "exitCode",
      "errors",
      "gaps",
      "sourceResult",
      "productionResult",
      "postOriginStability",
      "postCurrentStability",
    ]);
    assert.equal(result.status, "incomplete");
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.errors, result.sourceResult.errors);
    assert.deepEqual(result.gaps, result.sourceResult.gaps);
    assert.ok(result.gaps.some(({ code }) => code === "origin-metadata-file-missing"));
    assert.equal(result.productionResult, null);
    assert.equal(result.postOriginStability, null);
    assert.equal(result.postCurrentStability, null);
    assert.deepEqual(await fs.promises.readFile(capturesIndexFile), malformedBytes);
    assert.equal(JSON.stringify(evidence), before);
  });
});

test("E1 returns rejected source diagnostics before touching the formal index", async () => {
  await withProductionHistoricalContextFixture(async ({ manifestRunDir, runDir, evidence, filePaths }) => {
    const capturesIndexPath = path.join(runDir, "captures-index-e1-malformed.json");
    const malformedBytes = Buffer.from("{invalid json\n", "utf8");
    await fs.promises.writeFile(capturesIndexPath, malformedBytes);
    await fs.promises.appendFile(filePaths.candidateSet, " ");

    const result = await verifyProductionReviewEvidence({ manifestRunDir, evidence, capturesIndexPath });

    assert.equal(result.status, "rejected");
    assert.equal(result.exitCode, 2);
    assert.ok(result.errors.some(({ code }) => code === "origin-metadata-file-hash-mismatch"));
    assert.deepEqual(result.errors, result.sourceResult.errors);
    assert.deepEqual(result.gaps, result.sourceResult.gaps);
    assert.equal(result.productionResult, null);
    assert.equal(result.postOriginStability, null);
    assert.equal(result.postCurrentStability, null);
    assert.deepEqual(await fs.promises.readFile(capturesIndexPath), malformedBytes);
  });
});

test("E1 validates paths and own-data inputs before I/O, then snapshots evidence before its first await", async () => {
  const capturesIndexPath = path.join(REPO_ROOT, "docs", "validation", "not-read.json");
  for (const invalidPath of ["", "   ", "bad\0path", "https://example.test/index.json", "../../package.json"]) {
    await assert.rejects(
      verifyProductionReviewEvidence({
        manifestRunDir: "docs/validation/unused",
        evidence: {},
        capturesIndexPath: invalidPath,
      }),
      TypeError,
    );
  }
  for (const options of [
    null,
    [],
    { manifestRunDir: "docs/validation/unused", evidence: {}, capturesIndexPath, reader: () => ({}) },
  ]) {
    await assert.rejects(verifyProductionReviewEvidence(options), TypeError);
  }

  let getterCalls = 0;
  const accessorOptions = { evidence: {}, capturesIndexPath };
  Object.defineProperty(accessorOptions, "manifestRunDir", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "docs/validation/unused";
    },
  });
  await assert.rejects(verifyProductionReviewEvidence(accessorOptions), TypeError);

  const accessorEvidence = {};
  Object.defineProperty(accessorEvidence, "candidateSet", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });
  await assert.rejects(
    verifyProductionReviewEvidence({
      manifestRunDir: "docs/validation/unused",
      evidence: accessorEvidence,
      capturesIndexPath,
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);

  await withProductionHistoricalContextFixture(async ({ manifestRunDir, runDir, evidence }) => {
    const capturesIndexPath = path.join(runDir, "captures-index-e1-malformed.json");
    await fs.promises.writeFile(capturesIndexPath, "{invalid json\n", "utf8");
    const mutableEvidence = structuredClone(evidence);
    const originalHash = mutableEvidence.candidateSet.data.candidateSetHash;
    const pending = verifyProductionReviewEvidence({ manifestRunDir, evidence: mutableEvidence, capturesIndexPath });
    mutableEvidence.candidateSet.data.candidateSetHash = "f".repeat(64);
    const result = await pending;

    assert.equal(result.status, "incomplete");
    assert.equal(
      result.sourceResult.historicalContext.manifestRecord.manifest.origin.candidateSet.candidateSetHash,
      originalHash,
    );
    assert.notEqual(mutableEvidence.candidateSet.data.candidateSetHash, originalHash);
  });
});
