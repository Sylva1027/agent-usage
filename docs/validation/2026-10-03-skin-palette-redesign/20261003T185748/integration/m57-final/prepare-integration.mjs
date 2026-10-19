import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalFileContent, sha256Canonical } from "../../../../../../scripts/skin-palette/contracts.mjs";
import { loadReviewEvidence } from "../../../../../../scripts/skin-palette/review-evidence.mjs";
import { verifyReviewEvidence } from "../../../../../../scripts/skin-palette/review-verify.mjs";
import { readProductionCurrentSources, readProductionGeneratedAssets, readProductionSourceSnapshot, readProductionPreMigrationAssets } from "../../../../../../scripts/skin-palette/review-production.mjs";
import { SKIN_PALETTES } from "../../../../../../public/skin-palettes.js";
import { paletteTokens, derivePaletteDeclarationsFromTokens } from "../../../../../../public/skins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../../..");
assert.equal(process.argv.length, 3);
assert.match(process.argv[2], /^draft-A-[A-Za-z0-9._-]+$/);
const runDir = path.join(here, process.argv[2]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (file, value) => writeFile(file, canonicalFileContent(value), { flag: "wx" });
const evidence = await loadReviewEvidence({ runDir, capturesIndexPath: path.join(runDir, "captures-index.json") });
const verified = await verifyReviewEvidence({ evidence, requireSelections: true });
assert.equal(verified.status, "pass");
assert.equal(verified.verifiedModel.selectableCandidateIds.length, 10);
const sources = await readProductionCurrentSources();
for (const capture of Object.values(evidence.captures)) assert.deepEqual(capture.capture.sourceHashes, sources.sourceHashes);
const assets = await readProductionGeneratedAssets();
assert.equal(Object.keys(assets.sourceAssetHashes).length, 40);
assert.equal(Object.keys(assets.publicAssetHashes).length, 40);

const sourcePreimages = {};
for (const file of ["public/skin-palettes.js", "public/skin-picker.js", "public/skin-bootstrap.js"]) {
  const relative = `source-before/${file}`;
  await mkdir(path.dirname(path.join(runDir, relative)), { recursive: true });
  await writeFile(path.join(runDir, relative), sources.sourceBytes[file], { flag: "wx" });
  sourcePreimages[file] = { path: relative, sha256: sources.sourceHashes[file] };
}
const selectionsBytes = await readFile(path.join(runDir, "selections.json"));
const rollback = {};
for (const candidate of evidence.candidateSet.data.candidates) {
  rollback[candidate.skinId] = {};
  for (const mode of ["light", "dark"]) {
    const tokens = paletteTokens(candidate.skinId, mode);
    const declarations = derivePaletteDeclarationsFromTokens(tokens, mode);
    rollback[candidate.skinId][mode] = { raw: SKIN_PALETTES[candidate.skinId]?.[mode] ?? null, tokens,
      declarations, declarationsHash: sha256Canonical(declarations) };
  }
}
await save(path.join(runDir, "rollback-palettes.json"), { schemaVersion: 1, palettes: rollback });
const precheck = {
  schemaVersion: 1, createdAt: new Date().toISOString(), status: "pre-integration-snapshot-only",
  candidateSetHash: evidence.candidateSet.data.candidateSetHash,
  assessmentHash: verified.verifiedModel.container.assessmentHash,
  selectionsFileSha256: hash(selectionsBytes), sourceHashes: sources.sourceHashes, sourcePreimages,
  generatedAssets: { assetManifestSha256: assets.assetManifestSha256, sourceAssetHashes: assets.sourceAssetHashes, publicAssetHashes: assets.publicAssetHashes },
  toolHashes: assets.toolHashes, sourceFileCount: Object.keys(sources.sourceHashes).length,
  productionChanged: false, postponedSkinsEnabled: false,
  limitation: "Sequential filesystem reads, not a cross-file transaction. Recheck this snapshot against current sources before any M6 write.",
};
await save(path.join(runDir, "integration-precheck.json"), precheck);
const precheckFileSha256 = hash(await readFile(path.join(runDir, "integration-precheck.json")));
const loaded = await readProductionSourceSnapshot({ runDir, precheckFileSha256 });
assert.deepEqual(loaded.sourceHashes, sources.sourceHashes);
for (const [file, bytes] of Object.entries(loaded.sourceSnapshot)) {
  assert.deepEqual(bytes, sources.sourceBytes[file]);
  assert.deepEqual(await readFile(path.join(repo, file)), bytes);
}
const loadedAssets = await readProductionPreMigrationAssets({ runDir, precheckFileSha256 });
assert.deepEqual(loadedAssets.generatedAssets, precheck.generatedAssets);
await save(path.join(runDir, "integration-precheck-validation.json"), { status: "pass", precheckFileSha256,
  sourceFiles: precheck.sourceFileCount, completePreimages: 3, sourceAssets: 40, publicAssets: 40, productionChanged: false });
console.log(JSON.stringify({ status: "pass", precheckFileSha256, sourceFiles: precheck.sourceFileCount, preimages: 3, assets: "40 source + 40 public", productionChanged: false }));
