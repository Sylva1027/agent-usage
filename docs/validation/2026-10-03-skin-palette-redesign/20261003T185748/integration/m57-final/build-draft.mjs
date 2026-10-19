import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../../../../../..");
const VALIDATION_ROOT = path.join(
  REPO_ROOT,
  "docs",
  "validation",
  "2026-10-03-skin-palette-redesign",
  "20261003T185748",
);
const FINAL_DIR = path.join(VALIDATION_ROOT, "integration", "m57-final");
const AGGREGATE_DIR = path.join(
  VALIDATION_ROOT,
  "batches",
  "m57-aggregate-selected-20261018T205439Z-10707200",
);
const CANDIDATES_FILE = path.join(AGGREGATE_DIR, "candidates.json");
const SELECTED_INPUTS_FILE = path.join(AGGREGATE_DIR, "selected-inputs.json");
const PROFILES_FILE = path.join(REPO_ROOT, "scripts", "skin-palette", "profiles.json");
const POLICY_FILE = path.join(REPO_ROOT, "scripts", "skin-palette", "policy.json");
const VISUAL_MAP_FILE = path.join(FINAL_DIR, "visual-evidence-map.json");

const EXPECTED_CANDIDATE_SET_HASH = "107072009ac767cc90c04d91bea5f1c5e4c66ac0b19fe447b7ad8190376b0ea6";
const EXPECTED_CANDIDATES_SHA256 = "a9bc343c8543cfb27560c527a8a04d9d5ed2ac81549f980f581124d165f83f3f";
const EXPECTED_INPUT_HASHES = Object.freeze({
  derivation: "f00f5d7d8710aab42e55b565e385871e144a01c8e76b34a3d949272b84da2b37",
  policy: "f0d43f775c2783a400d584773e1c9f1dd249089c3f0787258396faa83aa7e222",
  profiles: "e1ea7ad05af545b66dd7f13de4290de90bb739f7cafa3dfb46fcbb141e59239b",
  roles: "288270ecbc69db2ff473411783c90ae965d84c27226c6436e0ffcdb558890b28",
});

const EXPECTED = Object.freeze([
  { skinId: "chatgpt", id: "chatgpt-b-98b485e3808b", fullCaptureRun: "m55-full-selected-20261018T165932Z-2e635d34" },
  { skinId: "claude", id: "claude-b-cced5b3fef6b", fullCaptureRun: "m53-full-selected-20261018T145857Z-54115e27" },
  { skinId: "glm", id: "glm-a-90839e4535a2", fullCaptureRun: "m54-full-selected-20261018T160449Z-dab21865" },
  { skinId: "gemini", id: "gemini-b-d3f98cd46f19", fullCaptureRun: "m56-gemini-full-selected-20261018T173817Z-55e5c485" },
  { skinId: "deepseek", id: "deepseek-a-462c5bb15734", fullCaptureRun: "m55-full-selected-20261018T165932Z-2e635d34" },
  { skinId: "kimi", id: "kimi-b-32c91fbbc0c5", fullCaptureRun: "m57-selected-full-20261018T203916Z-23d60159" },
  { skinId: "qwen", id: "qwen-b-66a9e1d238c9", fullCaptureRun: "m56-qwen-full-selected-20261018T193822Z-e1c50ef3" },
  { skinId: "grok", id: "grok-a-caaed7d73f6d", fullCaptureRun: "selected-a-full-20261018T110532Z-47bd5687" },
  { skinId: "muse", id: "muse-a-1ae8bfc080aa", fullCaptureRun: "m57-selected-full-20261018T203916Z-23d60159" },
  { skinId: "mimo", id: "mimo-a-c3e643906b54", fullCaptureRun: "m53-full-selected-20261018T145857Z-54115e27" },
]);

const VISUAL_EVIDENCE_FILES = Object.freeze([
  "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m57-reading-visual/reading-visual-A.json",
  "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m57-reading-visual/reading-visual-B.json",
  "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m57-reading-visual/reading-visual-C.json",
  "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m57-scaling/supervisor-review.md",
]);

const PENDING_NOTE =
  "默认保留 pending：本脚本只建立可执行草稿，不把未决视觉项填成 accept；待主管按 visual-evidence-map.json 与原始截图处理。";

const importRepo = (relativePath) => import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href);
const [{ assessCandidate, REQUIRED_SOURCE_FILES, VISUAL_REVIEW_ITEMS }, contracts, captureModule, evidenceModule, verifyModule, fixtureModule] =
  await Promise.all([
    importRepo("scripts/skin-palette/assess.mjs"),
    importRepo("scripts/skin-palette/contracts.mjs"),
    importRepo("scripts/skin-palette/capture.mjs"),
    importRepo("scripts/skin-palette/review-evidence.mjs"),
    importRepo("scripts/skin-palette/review-verify.mjs"),
    importRepo("test-support/skin-palette-fixture.mjs"),
  ]);

const {
  canonicalFileContent,
  canonicalJson,
  collectSourceHashes,
  hashRoleInputs,
  sha256Canonical,
  validateCandidateSet,
} = contracts;
const { SOURCE_FILES } = captureModule;
const { buildReviewContainer, loadReviewEvidence } = evidenceModule;
const { verifyReviewEvidence } = verifyModule;
const { FIXTURE_VERSION, getPaletteFixtureHash, getTimelineWarningFixtureHash } = fixtureModule;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toPosix = (value) => value.split(path.sep).join("/");
const relRepo = (value) => toPosix(path.relative(REPO_ROOT, value));

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function collectCheckFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`capture tree contains a symlink: ${full}`);
    if (entry.isDirectory()) files.push(...(await collectCheckFiles(full)));
    else if (entry.isFile() && (entry.name === "checks.json" || /^checks\..+\.json$/.test(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

async function readBrowserRecords(captureDir, candidateId) {
  const files = await collectCheckFiles(captureDir);
  const rawRecords = [];
  for (const file of files) {
    const document = await readJson(file);
    if (!Array.isArray(document.records)) throw new Error(`checks file has no records array: ${file}`);
    if (document.candidateId !== undefined && document.candidateId !== candidateId) {
      throw new Error(`checks file belongs to another candidate: ${file}`);
    }
    for (const record of document.records) {
      if (record.candidateId !== candidateId) throw new Error(`record belongs to another candidate: ${file}`);
      rawRecords.push(record);
    }
  }
  const seen = new Set();
  const records = [];
  for (const record of rawRecords) {
    const key = canonicalJson(record);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return { files, rawRecords, records, duplicateCount: rawRecords.length - records.length };
}

function defaultVisualReview(candidateSet) {
  return {
    schemaVersion: 1,
    reviews: Object.fromEntries(
      candidateSet.candidates.map((candidate) => [
        candidate.id,
        {
          reviewer: "Codex M5.7 draft builder / default pending",
          by: "proxy",
          verdict: "pending",
          items: VISUAL_REVIEW_ITEMS.map((item) => ({
            id: item.id,
            verdict: "pending",
            notes: PENDING_NOTE,
            screenshots: [],
          })),
          notes: `候选 ${candidate.id} 的八项视觉结论均保留 pending；引用 ${relRepo(VISUAL_MAP_FILE)} 供主管后续映射，不在此代填。`,
        },
      ]),
    ),
  };
}

async function loadVisualEvidence() {
  const documents = [];
  for (const relative of VISUAL_EVIDENCE_FILES) {
    const file = path.join(REPO_ROOT, relative);
    if (relative.endsWith(".json")) {
      const document = await readJson(file);
      if (!Array.isArray(document.results)) throw new Error(`visual evidence has no results: ${relative}`);
      for (const result of document.results) {
        const image = path.join(VALIDATION_ROOT, result.file);
        const imageStat = await stat(image).catch(() => null);
        if (!imageStat?.isFile()) throw new Error(`visual evidence image missing: ${result.file}`);
      }
      documents.push({ relative, imageCount: document.results.length });
    } else {
      const fileStat = await stat(file);
      if (!fileStat.isFile()) throw new Error(`visual evidence file missing: ${relative}`);
      documents.push({ relative, imageCount: null });
    }
  }
  return documents;
}

async function prepareDraftData() {
  const candidateBytes = await readFile(CANDIDATES_FILE);
  const candidateSet = JSON.parse(candidateBytes.toString("utf8"));
  assert.equal(sha256(candidateBytes), EXPECTED_CANDIDATES_SHA256, "aggregate candidates.json bytes changed");
  assert.equal(candidateSet.candidateSetHash, EXPECTED_CANDIDATE_SET_HASH, "candidateSetHash changed");
  assert.deepEqual(candidateSet.inputHashes, EXPECTED_INPUT_HASHES, "aggregate inputHashes changed");
  assert.deepEqual(candidateSet.rejected, [], "aggregate contains rejected candidates");
  assert.equal(candidateSet.candidates.length, EXPECTED.length, "aggregate candidate count changed");
  assert.deepEqual(
    candidateSet.candidates.map((candidate) => candidate.id),
    EXPECTED.map((entry) => entry.id),
    "aggregate candidate order/identity changed",
  );
  assert.deepEqual(
    candidateSet.candidates.map((candidate) => candidate.skinId),
    EXPECTED.map((entry) => entry.skinId),
    "aggregate skin order changed",
  );

  const selectedInputsBytes = await readFile(SELECTED_INPUTS_FILE);
  const selectedInputs = JSON.parse(selectedInputsBytes.toString("utf8"));
  assert.equal(selectedInputs.kind, "skin-palette-m57-selected-inputs", "selected-inputs kind changed");
  assert.equal(selectedInputs.schemaVersion, 1, "selected-inputs schema changed");
  assert.equal(
    selectedInputs.candidateSetHash,
    candidateSet.candidateSetHash,
    "selected-inputs candidateSetHash changed",
  );
  assert.deepEqual(
    selectedInputs.items.map((item) => item.candidateId),
    EXPECTED.map((entry) => entry.id),
    "selected-inputs candidate order changed",
  );
  const selectedById = new Map(selectedInputs.items.map((item) => [item.candidateId, item]));
  for (const expected of EXPECTED) {
    const selected = selectedById.get(expected.id);
    assert.ok(selected, `selected input missing: ${expected.id}`);
    assert.equal(selected.skinId, expected.skinId, `selected skin mismatch: ${expected.id}`);
    assert.equal(selected.fullCaptureRun, expected.fullCaptureRun, `selected full capture mismatch: ${expected.id}`);
    assert.match(selected.sourceRun, /^[A-Za-z0-9][A-Za-z0-9./_-]*$/, `invalid sourceRun: ${expected.id}`);
  }

  const policyBytes = await readFile(POLICY_FILE);
  const policy = JSON.parse(policyBytes.toString("utf8"));
  assert.equal(sha256Canonical(policy), EXPECTED_INPUT_HASHES.policy, "current policy hash changed");
  assert.equal(hashRoleInputs(), EXPECTED_INPUT_HASHES.roles, "current role inputs changed");

  const profilesBytes = await readFile(PROFILES_FILE);
  const profiles = JSON.parse(profilesBytes.toString("utf8"));
  assert.equal(sha256Canonical(profiles), EXPECTED_INPUT_HASHES.profiles, "current profiles hash changed");

  const sourceHashes = collectSourceHashes(SOURCE_FILES, (relativePath) =>
    readFileSync(path.join(REPO_ROOT, relativePath)),
  );
  assert.equal(sourceHashes["public/skins.js"], EXPECTED_INPUT_HASHES.derivation, "current derivation hash changed");
  for (const required of REQUIRED_SOURCE_FILES) {
    assert.ok(sourceHashes[required], `current source hash missing: ${required}`);
  }

  const currentBaseFixtureHash = getPaletteFixtureHash();
  const currentWarningFixtureHash = getTimelineWarningFixtureHash();
  assert.equal(FIXTURE_VERSION, policy.versions.fixture, "fixture version does not match policy");

  const visualReview = defaultVisualReview(candidateSet);
  const visualReviewBytes = Buffer.from(canonicalFileContent(visualReview), "utf8");
  const candidateById = new Map(candidateSet.candidates.map((candidate) => [candidate.id, candidate]));
  const results = [];

  for (const expected of EXPECTED) {
    const candidate = candidateById.get(expected.id);
    const selected = selectedById.get(expected.id);
    assert.ok(candidate, `candidate missing: ${expected.id}`);
    assert.equal(candidate.skinId, expected.skinId, `candidate skin mismatch: ${expected.id}`);
    assert.equal(candidate.candidateHash, selected.candidateHash, `selected candidateHash mismatch: ${expected.id}`);
    assert.equal(candidate.policyHash, EXPECTED_INPUT_HASHES.policy, `candidate policy mismatch: ${expected.id}`);
    assert.equal(candidate.derivationHash, EXPECTED_INPUT_HASHES.derivation, `candidate derivation mismatch: ${expected.id}`);
    assert.equal(sha256Canonical(profiles[candidate.skinId]), candidate.profileHash, `profile drift: ${expected.id}`);

    const sourceRunDir = path.join(VALIDATION_ROOT, "batches", selected.sourceRun);
    const sourceCandidatesBytes = await readFile(path.join(sourceRunDir, "candidates.json"));
    const sourceSet = JSON.parse(sourceCandidatesBytes.toString("utf8"));
    const sourceSetCheck = validateCandidateSet(sourceSet, { expectedSkinIds: [] });
    assert.ok(
      sourceSetCheck.valid,
      `source candidate set invalid: ${selected.sourceRun}: ${sourceSetCheck.errors[0]?.path ?? "$"}`,
    );
    const sourceCandidate = sourceSet.candidates.find((entry) => entry.id === candidate.id);
    assert.ok(sourceCandidate, `source candidate missing: ${expected.id}`);
    assert.equal(canonicalJson(sourceCandidate), canonicalJson(candidate), `source candidate drift: ${expected.id}`);
    assert.equal(sourceSet.inputHashes.policy, EXPECTED_INPUT_HASHES.policy, `source policy mismatch: ${expected.id}`);
    assert.equal(sourceSet.inputHashes.roles, EXPECTED_INPUT_HASHES.roles, `source roles mismatch: ${expected.id}`);
    assert.equal(
      sourceSet.inputHashes.derivation,
      EXPECTED_INPUT_HASHES.derivation,
      `source derivation mismatch: ${expected.id}`,
    );

    const captureDir = path.join(VALIDATION_ROOT, "batches", expected.fullCaptureRun, "captures", expected.id);
    const capture = await readJson(path.join(captureDir, "capture.json"));
    const progress = await readJson(path.join(captureDir, "progress.json"));
    assert.equal(capture.kind, "skin-palette-capture-matrix", `capture kind mismatch: ${expected.id}`);
    for (const field of ["id", "candidateHash", "skinId", "variant", "profileHash", "policyHash", "derivationHash"]) {
      assert.equal(capture.candidate[field], candidate[field], `capture ${field} mismatch: ${expected.id}`);
    }
    assert.equal(progress.digests.candidate.candidateHash, candidate.candidateHash, `progress candidate mismatch: ${expected.id}`);
    assert.equal(progress.digests.fixtureHash, capture.fixtureHash, `progress fixture mismatch: ${expected.id}`);
    for (const group of Object.keys(capture.fixtureBindings)) {
      assert.equal(
        progress.digests.fixtureBindings[group].fixtureHash,
        capture.fixtureBindings[group].fixtureHash,
        `fixture binding mismatch: ${expected.id} ${group}`,
      );
    }

    const { files, rawRecords, records, duplicateCount } = await readBrowserRecords(captureDir, candidate.id);
    const fixtureBindingMismatches = Object.entries(capture.fixtureBindings)
      .filter(([, binding]) => {
        const expectedHash =
          binding.fixtureKind === "timeline-range-warning" ? currentWarningFixtureHash : currentBaseFixtureHash;
        return binding.fixtureHash !== expectedHash;
      })
      .map(([group, binding]) => ({ group, fixtureHash: binding.fixtureHash }));
    const sourceHashMismatches = Object.entries(capture.sourceHashes)
      .filter(([file, digest]) => sourceHashes[file] !== digest)
      .map(([file, digest]) => ({ file, capture: digest, current: sourceHashes[file] ?? null }));

    const run = {
      policy,
      inputHashes: sourceSet.inputHashes,
      recordedInputHashes: sourceSet.inputHashes,
      sourceHashes,
      recordedSourceHashes: capture.sourceHashes,
      fixture: {
        version: FIXTURE_VERSION,
        note: `paletteFixtureHash=${currentBaseFixtureHash}; timelineWarningFixtureHash=${currentWarningFixtureHash}`,
      },
      recordedFixture: {
        version: policy.versions.fixture,
        note: `capture.fixtureHash=${capture.fixtureHash}; currentBaseFixtureHash=${currentBaseFixtureHash}; currentWarningFixtureHash=${currentWarningFixtureHash}`,
      },
      candidateSet: sourceSet,
      candidateSetHash: sourceSet.candidateSetHash,
    };
    const assessment = assessCandidate({
      candidate,
      fastChecks: [],
      browserChecks: records,
      visualReview: visualReview.reviews[candidate.id],
      run,
    });

    results.push({
      expected,
      candidate,
      captureDir,
      capture,
      progress,
      checkFiles: files,
      rawRecords,
      records,
      duplicateCount,
      sourceRunDir,
      sourceCandidatesBytes,
      sourceSet,
      assessment,
      fixtureBindingMismatches,
      sourceHashMismatches,
    });
  }

  const container = buildReviewContainer({
    candidateSetHash: candidateSet.candidateSetHash,
    assessments: results.map((result) => result.assessment),
  });

  return {
    candidateBytes,
    candidateSet,
    selectedInputs,
    selectedInputsBytes,
    policy,
    profilesBytes,
    sourceHashes,
    currentBaseFixtureHash,
    currentWarningFixtureHash,
    visualReview,
    visualReviewBytes,
    results,
    container,
  };
}

function isFocusUnmeasured(record) {
  return (
    record.mode === "light" &&
    record.stateId === "keyboard-focus" &&
    record.roleId === "focus.outline" &&
    record.result === "unmeasured"
  );
}

async function selfCheck() {
  const data = await prepareDraftData();
  const uniqueIds = new Set(data.candidateSet.candidates.map((candidate) => candidate.id));
  assert.equal(uniqueIds.size, EXPECTED.length, "candidate IDs are not unique");
  assert.equal(data.container.assessments.length, EXPECTED.length, "container assessment count mismatch");

  const visualDocuments = await loadVisualEvidence();
  const hypotheticalOutDir = path.join(FINAL_DIR, "draft-A-self-check");
  const origins = buildOrigins(hypotheticalOutDir, data);
  const readingDocuments = [];
  for (const relative of VISUAL_EVIDENCE_FILES.filter((file) => file.endsWith(".json"))) {
    readingDocuments.push(await readJson(path.join(REPO_ROOT, relative)));
  }
  for (const expected of EXPECTED) {
    const matchingResults = readingDocuments.flatMap((document) =>
      document.results.filter((result) => result.candidateId === expected.id),
    );
    assert.equal(matchingResults.length, 14, `reading evidence coverage changed: ${expected.id}`);
  }

  let rawRecordCount = 0;
  let recordCount = 0;
  let failCount = 0;
  const focusRecords = [];
  for (const result of data.results) {
    assert.ok(result.checkFiles.length > 0, `checks files missing: ${result.candidate.id}`);
    assert.deepEqual(result.assessment.browser, result.records, `browser records changed: ${result.candidate.id}`);
    assert.equal(result.assessment.fast.length, 0, `fast records unexpectedly added: ${result.candidate.id}`);
    assert.equal(result.fixtureBindingMismatches.length, 0, `fixture binding drift: ${result.candidate.id}`);
    assert.equal(result.sourceHashMismatches.length, 0, `source hash drift: ${result.candidate.id}`);
    assert.equal(result.assessment.readiness, "incomplete", `draft readiness must stay incomplete: ${result.candidate.id}`);
    assert.equal(result.assessment.visual.reviewed, false, `draft visual review must stay pending: ${result.candidate.id}`);
    assert.equal(result.assessment.diagnostics.visualReview.items.length, VISUAL_REVIEW_ITEMS.length);
    assert.ok(
      result.assessment.diagnostics.visualReview.items.every((item) => item.outcome === "pending"),
      `visual item was auto-filled: ${result.candidate.id}`,
    );
    assert.equal(
      result.assessment.diagnostics.evidence.candidateSetHash,
      result.sourceSet.candidateSetHash,
      `assessment lost source-set binding: ${result.candidate.id}`,
    );
    assert.deepEqual(
      result.assessment.diagnostics.evidence.inputHashes,
      result.sourceSet.inputHashes,
      `assessment input hashes lost source-set binding: ${result.candidate.id}`,
    );
    const origin = origins.origins[result.candidate.id];
    assert.ok(origin, `origin missing: ${result.candidate.id}`);
    assert.equal(
      path.resolve(hypotheticalOutDir, origin.batchRun),
      path.resolve(result.sourceRunDir),
      `origin source run mismatch: ${result.candidate.id}`,
    );
    assert.equal(
      origin.hashes.candidates,
      sha256(result.sourceCandidatesBytes),
      `origin candidates digest mismatch: ${result.candidate.id}`,
    );
    assert.equal(
      origin.capture,
      toPosix(path.relative(hypotheticalOutDir, result.captureDir)),
      `origin capture path mismatch: ${result.candidate.id}`,
    );

    const recordKeys = result.records.map(canonicalJson);
    assert.equal(new Set(recordKeys).size, recordKeys.length, `records are not deduplicated: ${result.candidate.id}`);
    for (const outcome of ["fail", "unmeasured"]) {
      const sourceKeys = new Set(
        result.rawRecords.filter((record) => record.result === outcome).map(canonicalJson),
      );
      const retainedKeys = new Set(
        result.records.filter((record) => record.result === outcome).map(canonicalJson),
      );
      assert.deepEqual(retainedKeys, sourceKeys, `${outcome} records were not preserved: ${result.candidate.id}`);
    }
    assert.equal(
      result.assessment.failures.length,
      new Set(result.records.filter((record) => record.result === "fail").map(canonicalJson)).size,
      `failure records changed: ${result.candidate.id}`,
    );
    assert.equal(
      result.assessment.unmeasured.length,
      new Set(result.records.filter((record) => record.result === "unmeasured").map(canonicalJson)).size,
      `unmeasured records changed: ${result.candidate.id}`,
    );

    rawRecordCount += result.rawRecords.length;
    recordCount += result.records.length;
    failCount += result.assessment.failures.length;
    focusRecords.push(...result.assessment.browser.filter(isFocusUnmeasured));
  }

  assert.equal(focusRecords.length, 2, "expected exactly two light/keyboard-focus/focus.outline unmeasured records");
  assert.deepEqual(
    new Set(focusRecords.map((record) => record.candidateId)),
    new Set(["kimi-b-32c91fbbc0c5", "qwen-b-66a9e1d238c9"]),
    "focus unmeasured candidate binding changed",
  );
  for (const record of focusRecords) {
    assert.equal(record.ratio, null, `focus unmeasured ratio changed: ${record.candidateId}`);
    assert.equal(record.threshold, 3, `focus unmeasured threshold changed: ${record.candidateId}`);
    assert.equal(record.reason, "spotlight-active", `focus unmeasured reason changed: ${record.candidateId}`);
    assert.equal(record.method, "browser-focus-outline-adjacent-pixels");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      writes: 0,
      candidates: uniqueIds.size,
      candidateSetHash: data.candidateSet.candidateSetHash,
      candidatesSha256: sha256(data.candidateBytes),
      rawBrowserRecords: rawRecordCount,
      browserRecords: recordCount,
      duplicateRecords: rawRecordCount - recordCount,
      failures: failCount,
      unmeasured: focusRecords.length,
      focusUnmeasured: focusRecords.map((record) => record.candidateId),
      visualPendingItems: EXPECTED.length * VISUAL_REVIEW_ITEMS.length,
      assessmentHash: data.container.assessmentHash,
      visualDocuments,
      visualEvidenceMapPresent: await lstat(VISUAL_MAP_FILE).then(
        () => true,
        () => false,
      ),
    })}\n`,
  );
}

async function resolveDraftOut(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--out requires a path");
  const out = path.resolve(REPO_ROOT, value);
  const finalReal = await realpath(FINAL_DIR);
  if (path.dirname(out) !== finalReal) throw new Error(`--out must be directly inside ${FINAL_DIR}`);
  if (!/^draft-A-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path.basename(out))) {
    throw new Error("--out basename must match draft-A-<suffix>");
  }
  const existing = await lstat(out).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error(`refusing to overwrite existing output: ${out}`);
  return out;
}

function buildSummary(data, outDir, verification) {
  return {
    schemaVersion: 1,
    kind: "skin-palette-m57-draft-a-build",
    status: verification.status,
    out: relRepo(outDir),
    aggregate: {
      path: relRepo(AGGREGATE_DIR),
      candidateSetHash: data.candidateSet.candidateSetHash,
      candidatesSha256: sha256(data.candidateBytes),
      inputHashes: data.candidateSet.inputHashes,
    },
    selectionsCreated: false,
    productionChanged: false,
    visualEvidenceMap: {
      path: relRepo(VISUAL_MAP_FILE),
      used: false,
      note: "八项默认 pending，等待主管依据该映射和原始截图填写；脚本不代填 accept。",
    },
    pendingVisualItems: VISUAL_REVIEW_ITEMS.map((item) => item.id),
    candidates: data.results.map((result) => ({
      candidateId: result.candidate.id,
      skinId: result.candidate.skinId,
      sourceRun: relRepo(result.sourceRunDir),
      fullCaptureRun: result.expected.fullCaptureRun,
      capture: relRepo(result.captureDir),
      checksFiles: result.checkFiles.length,
      rawBrowserRecords: result.rawRecords.length,
      browserRecords: result.records.length,
      duplicateRecords: result.duplicateCount,
      failures: result.assessment.failures.length,
      unmeasured: result.assessment.unmeasured.length,
      readiness: result.assessment.readiness,
      blockers: result.assessment.diagnostics.gate.blockers,
      fixtureBindingMismatches: result.fixtureBindingMismatches,
      sourceHashMismatches: result.sourceHashMismatches,
    })),
    verify: verification,
  };
}

function buildOrigins(outDir, data) {
  return {
    schemaVersion: 1,
    origins: Object.fromEntries(
      data.results.map((result) => {
        const captureBytes = readFileSync(path.join(result.captureDir, "capture.json"));
        const progressBytes = readFileSync(path.join(result.captureDir, "progress.json"));
        return [
          result.candidate.id,
          {
            batchRun: toPosix(path.relative(outDir, result.sourceRunDir)),
            capture: toPosix(path.relative(outDir, result.captureDir)),
            visualReview: "visual-review.json",
            hashes: {
              candidates: sha256(result.sourceCandidatesBytes),
              capture: sha256(captureBytes),
              progress: sha256(progressBytes),
              visualReview: sha256(data.visualReviewBytes),
            },
            currentProfiles: {
              path: "inputs/current-profiles.json",
              sha256: sha256(data.profilesBytes),
            },
          },
        ];
      }),
    ),
  };
}

async function buildDraft(outValue) {
  const outDir = await resolveDraftOut(outValue);
  const data = await prepareDraftData();
  const capturesIndex = {
    schemaVersion: 1,
    captures: Object.fromEntries(
      data.results.map((result) => [result.candidate.id, toPosix(path.relative(outDir, result.captureDir))]),
    ),
  };
  const origins = buildOrigins(outDir, data);

  await mkdir(outDir, { recursive: false });
  await mkdir(path.join(outDir, "inputs"), { recursive: false });
  await writeFile(path.join(outDir, "candidates.json"), data.candidateBytes);
  await writeFile(path.join(outDir, "visual-review.json"), data.visualReviewBytes);
  await writeFile(path.join(outDir, "assessments.json"), canonicalFileContent(data.container));
  await writeFile(path.join(outDir, "captures-index.json"), canonicalFileContent(capturesIndex));
  await writeFile(path.join(outDir, "assessment-origins.json"), canonicalFileContent(origins));
  await writeFile(path.join(outDir, "inputs", "current-profiles.json"), data.profilesBytes);

  let verification;
  try {
    const evidence = await loadReviewEvidence({
      runDir: outDir,
      capturesIndexPath: path.join(outDir, "captures-index.json"),
    });
    const verified = await verifyReviewEvidence({ evidence, requireSelections: false });
    verification = {
      status: verified.status,
      errors: verified.errors,
      gaps: verified.gaps,
      errorCount: verified.errors.length,
      gapCount: verified.gaps.length,
      blockingGapCount: verified.gaps.filter((gap) => gap.blocking).length,
    };
  } catch (error) {
    verification = {
      status: "invalid",
      errors: [{ code: error?.code ?? "BUILD_VERIFY_FAILED", detail: error?.message ?? String(error) }],
      gaps: [],
      errorCount: 1,
      gapCount: 0,
      blockingGapCount: 0,
    };
  }

  const summary = buildSummary(data, outDir, verification);
  await writeFile(path.join(outDir, "draft-summary.json"), canonicalFileContent(summary));
  process.stdout.write(
    `${JSON.stringify({
      out: outDir,
      status: verification.status,
      errors: verification.errorCount,
      gaps: verification.gapCount,
      blockingGaps: verification.blockingGapCount,
      assessments: data.container.assessments.length,
    })}\n`,
  );
  if (verification.status === "invalid") process.exitCode = 1;
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--self-check") {
  await selfCheck();
} else if (argv.length === 2 && argv[0] === "--out") {
  await buildDraft(argv[1]);
} else {
  throw new Error(
    "usage: node build-draft.mjs --self-check | node build-draft.mjs --out <.../m57-final/draft-A-<suffix>>",
  );
}
